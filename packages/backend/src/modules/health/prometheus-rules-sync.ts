import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  alertRuleGroups,
  effectiveAlertRules,
  siteKeys,
  siteProfiles,
  type AlertRuleOverride,
  type AlertRulesSyncStatus,
  type EffectiveAlertRule,
  type HealthCriticality,
  type SiteKey,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import type { HealthRepository } from './health.repository.js';

const SEVERITY: Record<HealthCriticality, string> = {
  informativa: 'info',
  preventiva: 'warning',
  critica: 'critical',
  urgente: 'page',
};
const FILE = /^zeroops-[a-z0-9-]+\.yml$/;
/** Strings JSON são escalares YAML válidos (entre aspas, com escapes `\"` e `\n`). */
const quoted = (value: string) => JSON.stringify(value);

/**
 * Ficheiro de regras do Prometheus para um site. O site sem label (`''`, Pizza Hut) também leva
 * as regras da infraestrutura partilhada; os outros só as regras do site, filtradas pela label
 * `project`. Regras desativadas no projeto não são geradas.
 */
export function renderAlertRules(
  siteLabel: string,
  overrides: Record<string, AlertRuleOverride>,
): string {
  const selector = `project="${siteLabel}"`;
  const fill = (text: string, rule: EffectiveAlertRule) =>
    text
      .replaceAll('%T%', rule.thresholdValue === null ? '' : String(rule.thresholdValue))
      .replaceAll('%FOR%', String(rule.forMinutes))
      .replaceAll('%SEL%', selector);
  const rules = effectiveAlertRules(overrides).filter(
    (rule) => rule.enabled && (rule.scope === 'site' || siteLabel === ''),
  );
  const lines = [
    '# Gerado pelo ZeroOps (Saúde → Configuração → Regras de alerta). Não editar à mão.',
    `# Site: ${siteLabel || 'pizzahut (inclui a infraestrutura partilhada)'}`,
  ];
  const groups = Object.keys(alertRuleGroups).flatMap((group) => {
    const inGroup = rules.filter((rule) => rule.group === group);
    if (!inGroup.length) return [];
    return [
      `  - name: ${siteLabel ? `${group}-${siteLabel}` : group}`,
      '    rules:',
      ...inGroup.flatMap((rule) => [
        `      - alert: ${rule.id}`,
        `        expr: ${quoted(fill(rule.expr, rule))}`,
        `        for: ${rule.forMinutes}m`,
        `        labels: { severity: ${SEVERITY[rule.criticality]} }`,
        '        annotations:',
        `          title: ${quoted(rule.title)}`,
        `          summary: ${quoted(fill(rule.summary, rule))}`,
      ]),
    ];
  });
  return [...lines, groups.length ? 'groups:' : 'groups: []', ...groups, ''].join('\n');
}

interface FileChange {
  name: string;
  previous: string | null;
  next: string | null;
}

/**
 * Mantém os ficheiros de regras do Prometheus (`zeroops-<site>.yml`) alinhados com as regras de
 * alerta configuradas em cada projeto e pede ao Prometheus que os recarregue. Se o Prometheus
 * recusar as regras, repõe os ficheiros anteriores. Sites sem projeto usam o catálogo.
 */
export class PrometheusRulesSync {
  private last: AlertRulesSyncStatus;
  private running: Promise<AlertRulesSyncStatus> | null = null;

  constructor(
    private readonly db: Database,
    private readonly repository: HealthRepository,
    private readonly directory?: string,
    private readonly prometheusUrl?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.last = directory
      ? { state: 'ok', syncedAt: null, message: null }
      : { state: 'disabled', syncedAt: null, message: 'Geração das regras não configurada.' };
  }

  /** Estado da última sincronização (sem tocar nos ficheiros). */
  status(): AlertRulesSyncStatus {
    return this.last;
  }

  /** Gera e aplica as regras; execuções simultâneas partilham a mesma sincronização. */
  sync(): Promise<AlertRulesSyncStatus> {
    if (!this.directory) return Promise.resolve(this.last);
    this.running ??= this.apply(this.directory).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async apply(directory: string) {
    let changes: FileChange[] = [];
    try {
      await mkdir(directory, { recursive: true });
      changes = await this.changes(directory, await this.render());
      for (const change of changes) await this.write(directory, change.name, change.next);
      if (changes.length) await this.reload();
      this.last = { state: 'ok', syncedAt: new Date().toISOString(), message: null };
    } catch (error) {
      for (const change of changes)
        await this.write(directory, change.name, change.previous).catch(() => undefined);
      this.last = {
        state: 'error',
        syncedAt: this.last.syncedAt,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
    }
    return this.last;
  }

  /** Conteúdo de cada ficheiro: um por site, com as alterações do projeto desse site. */
  private async render() {
    const projects = await this.db.query<{ id: string; site_key: SiteKey }>(
      `SELECT id, site_key FROM projects WHERE archived=0 AND site_key IS NOT NULL ORDER BY id`,
    );
    const files = new Map<string, string>();
    for (const site of siteKeys) {
      const project = projects.rows.find((row) => row.site_key === site);
      const settings = project ? await this.repository.settings(project.id) : null;
      files.set(
        `zeroops-${site}.yml`,
        renderAlertRules(siteProfiles[site].alertProjectLabel, settings?.settings.alertRules ?? {}),
      );
    }
    return files;
  }

  private async changes(directory: string, files: Map<string, string>) {
    const existing = (await readdir(directory)).filter((name) => FILE.test(name));
    const names = new Set([...existing, ...files.keys()]);
    const changes: FileChange[] = [];
    for (const name of names) {
      const previous = existing.includes(name)
        ? await readFile(join(directory, name), 'utf8')
        : null;
      const next = files.get(name) ?? null;
      if (previous !== next) changes.push({ name, previous, next });
    }
    return changes;
  }

  /** Escrita atómica (ficheiro temporário + rename); `null` apaga. */
  private async write(directory: string, name: string, content: string | null) {
    const path = join(directory, name);
    if (content === null) return unlink(path).catch(() => undefined);
    const temporary = `${path}.tmp`;
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, path);
  }

  private async reload() {
    if (!this.prometheusUrl) return;
    const response = await this.fetchImpl(new URL('/-/reload', this.prometheusUrl), {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(
        `O Prometheus recusou as regras (${response.status})${detail ? `: ${detail}` : '.'}`,
      );
    }
  }
}
