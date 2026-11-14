import type { Database } from '../../database/database.js';
import type { AlertmanagerReceiver } from './alertmanager-receiver.js';

/** Alerta ainda ativo no Alertmanager, tal como devolvido por `GET /api/v2/alerts`. */
export interface ActiveAlert {
  fingerprint: string;
  /** `active` (notificável), `suppressed` (silenciado/inibido) ou `unprocessed`. */
  state: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
}

/** Alertas ainda ativos no Alertmanager (lança erro se não responder). */
export interface ActiveAlertsSource {
  activeAlerts(): Promise<ActiveAlert[]>;
}

const stringRecord = (value: unknown): Record<string, string> =>
  value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};

/** Lê `GET /api/v2/alerts` do Alertmanager local (inclui silenciados, inibidos e por processar). */
export class AlertmanagerActiveAlerts implements ActiveAlertsSource {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10000,
  ) {}

  /** Lista dos alertas ativos; falha se o Alertmanager não responder com uma lista. */
  async activeAlerts(): Promise<ActiveAlert[]> {
    const url = new URL('/api/v2/alerts', this.baseUrl);
    url.search = 'active=true&silenced=true&inhibited=true&unprocessed=true';
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Alertmanager respondeu ${response.status}.`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('Resposta inesperada do Alertmanager.');
    return body.flatMap((item: Record<string, unknown> | null) =>
      typeof item?.fingerprint === 'string' && typeof item.startsAt === 'string'
        ? [
            {
              fingerprint: item.fingerprint,
              state: String((item.status as { state?: unknown } | undefined)?.state ?? 'active'),
              labels: stringRecord(item.labels),
              annotations: stringRecord(item.annotations),
              startsAt: item.startsAt,
            },
          ]
        : [],
    );
  }
}

interface FiringRow {
  project_id: string;
  fingerprint: string;
  labels: string;
  summary: string;
  starts_at: Date;
}

const RECONCILED_NOTE =
  'Resolução detetada por reconciliação: o alerta deixou de estar ativo no Alertmanager sem que a notificação de resolução chegasse ao ZeroOps.';
const INGESTED_NOTE =
  'Detetado por reconciliação: o alerta está ativo no Alertmanager, mas a notificação não chegou ao ZeroOps (perdida ou deduplicada pelo Alertmanager).';

/**
 * Mantém o ZeroOps alinhado com o Alertmanager nos dois sentidos:
 * - fecha os alertas que o ZeroOps tem como ativos mas que já não existem no Alertmanager (ex.: a
 *   notificação «resolved» perdeu-se num reinício), só depois de faltarem durante `graceMs`;
 * - regista os alertas ativos (não silenciados) no Alertmanager há mais de `ingestGraceMs` que o
 *   ZeroOps não tem como ativos (ex.: o Alertmanager deduplicou a notificação porque a resolução
 *   anterior nunca foi enviada). O projeto é o do registo anterior do mesmo alerta ou, se não
 *   houver, o do último alerta recebido do Alertmanager com a mesma label `project`.
 */
export class AlertReconciler {
  private readonly missingSince = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly receiver: AlertmanagerReceiver,
    private readonly source: ActiveAlertsSource,
    private readonly graceMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly ingestGraceMs = 90_000,
  ) {}

  /** Resolve os alertas em falta, regista os ativos em falta e liberta os silenciados por paragens. */
  async run() {
    const active = await this.source.activeAlerts();
    const firing = await this.db.query<FiringRow>(
      `SELECT project_id, fingerprint, labels, summary, starts_at FROM health_external_alerts
        WHERE source='alertmanager' AND state='firing'`,
    );
    const now = this.now();
    const resolved = await this.resolveMissing(firing.rows, active, now);
    const ingested = await this.ingestActive(firing.rows, active, now);
    return resolved + ingested + (await this.receiver.releaseMuted(new Date(now)));
  }

  private async resolveMissing(firing: FiringRow[], active: ActiveAlert[], now: number) {
    const activeFingerprints = new Set(active.map((alert) => alert.fingerprint));
    const seen = new Set<string>();
    let resolved = 0;
    for (const row of firing) {
      const key = `${row.project_id}:${row.fingerprint}`;
      seen.add(key);
      if (activeFingerprints.has(row.fingerprint)) {
        this.missingSince.delete(key);
        continue;
      }
      const since = this.missingSince.get(key) ?? now;
      this.missingSince.set(key, since);
      if (now - since < this.graceMs) continue;
      await this.receiver.receive(row.project_id, {
        alerts: [
          {
            status: 'resolved',
            labels: JSON.parse(row.labels) as Record<string, string>,
            annotations: { summary: row.summary, description: RECONCILED_NOTE },
            startsAt: new Date(row.starts_at).toISOString(),
            endsAt: new Date(now).toISOString(),
            fingerprint: row.fingerprint,
          },
        ],
      });
      this.missingSince.delete(key);
      resolved += 1;
    }
    for (const key of this.missingSince.keys()) if (!seen.has(key)) this.missingSince.delete(key);
    return resolved;
  }

  private async ingestActive(firing: FiringRow[], active: ActiveAlert[], now: number) {
    const firingFingerprints = new Set(firing.map((row) => row.fingerprint));
    let ingested = 0;
    for (const alert of active) {
      if (alert.state !== 'active' || firingFingerprints.has(alert.fingerprint)) continue;
      if (!(now - Date.parse(alert.startsAt) >= this.ingestGraceMs)) continue;
      const projectId = await this.projectFor(alert.fingerprint, alert.labels.project ?? null);
      if (!projectId) continue;
      const description = [alert.annotations.description, INGESTED_NOTE]
        .filter(Boolean)
        .join('\n\n');
      await this.receiver.receive(projectId, {
        alerts: [
          {
            status: 'firing',
            labels: alert.labels,
            annotations: { ...alert.annotations, description: description.slice(0, 2000) },
            startsAt: alert.startsAt,
            fingerprint: alert.fingerprint,
          },
        ],
      });
      ingested += 1;
    }
    return ingested;
  }

  private async projectFor(fingerprint: string, site: string | null) {
    // Cada projeto tem o seu receiver no Alertmanager, escolhido pela label `project`.
    const found = await this.db.query<{ project_id: string }>(
      `SELECT project_id FROM health_external_alerts
        WHERE source='alertmanager' AND (fingerprint=$1 OR JSON_VALUE(labels, '$.project') <=> $2)
        ORDER BY fingerprint=$1 DESC, last_received_at DESC LIMIT 1`,
      [fingerprint, site],
    );
    return found.rows[0]?.project_id ?? null;
  }
}
