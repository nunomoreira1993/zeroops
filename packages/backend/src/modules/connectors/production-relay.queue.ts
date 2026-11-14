import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RelayQueueOptions {
  /** Tempo máximo à espera do resultado do relay. */
  timeoutMs: number;
  pollMs: number;
  /** Janela em que o relay é considerado ligado desde o último contacto. */
  onlineWindowSeconds: number;
}

/**
 * Fila de chamadas a executar pelo relay de Produção. A rede só permite Produção -> ZeroOps, por
 * isso o relay vem buscar os pedidos (long-poll) e devolve o resultado na mesma linha.
 */
export class ProductionRelayQueue {
  private readonly options: RelayQueueOptions;

  constructor(
    private readonly db: Database,
    options: Partial<RelayQueueOptions> = {},
  ) {
    this.options = { timeoutMs: 45000, pollMs: 250, onlineWindowSeconds: 120, ...options };
  }

  /** O relay do projeto contactou o ZeroOps dentro da janela de atividade. */
  async isOnline(projectId: string) {
    const result = await this.db.query<{ online: number }>(
      `SELECT COUNT(*) AS online FROM connector_relays
       WHERE project_id=$1 AND last_seen_at > NOW(3) - INTERVAL ${this.options.onlineWindowSeconds} SECOND`,
      [projectId],
    );
    return Number(result.rows[0]?.online ?? 0) > 0;
  }

  /** Ferramentas anunciadas pelo relay (null em relays antigos, que só têm sql e log). */
  async tools(projectId: string): Promise<string[] | null> {
    const row = (
      await this.db.query<{ tools: string | null }>(
        'SELECT tools FROM connector_relays WHERE project_id=$1',
        [projectId],
      )
    ).rows[0];
    return row?.tools ? row.tools.split(',') : null;
  }

  /** Enfileira a chamada e espera pelo resultado; expira a linha se o relay não responder. */
  async execute(projectId: string, runId: string | null, tool: string, payload: object) {
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO connector_relay_requests(id,project_id,run_id,tool,payload) VALUES($1,$2,$3,$4,$5)',
      [id, projectId, runId, tool, JSON.stringify(payload)],
    );
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.options.pollMs);
      const row = (
        await this.db.query<{
          status: string;
          result: string | null;
          error_code: string | null;
          error_message: string | null;
        }>(
          'SELECT status,result,error_code,error_message FROM connector_relay_requests WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!row) break;
      if (row.status === 'done')
        return typeof row.result === 'string' ? (JSON.parse(row.result) as unknown) : row.result;
      if (row.status === 'failed')
        throw new DomainError(
          row.error_code ?? 'RELAY_FAILED',
          row.error_message || 'O relay de Produção recusou o pedido.',
          400,
        );
    }
    await this.db.query(
      "UPDATE connector_relay_requests SET status='expired', finished_at=NOW(3) WHERE id=$1 AND status IN ('pending','claimed')",
      [id],
    );
    throw new DomainError('RELAY_TIMEOUT', 'O relay de Produção não respondeu a tempo.', 504);
  }
}
