import type { Queryable } from '../../../packages/backend/src/modules/identity/membership.js';

/**
 * Drenagem de rollout (P10): enquanto existir um pedido ativo em `zeroops_runtime_drains`, os
 * pools deixam de reclamar jobs novos (os jobs em curso terminam normalmente). O estado é lido
 * periodicamente e guardado em cache; sem a tabela (antes da migração 044) nunca drena. Um erro
 * de leitura mantém o último estado conhecido para não alternar com falhas transitórias.
 */
export class RuntimeDrainWatcher {
  private draining = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Queryable,
    private readonly options: { intervalMs: number; onChange?: (draining: boolean) => void },
  ) {}

  get active() {
    return this.draining;
  }

  /** Lê o estado uma vez (usado no arranque e pelo temporizador). */
  async refresh() {
    let next = this.draining;
    try {
      const row = (
        await this.db.query<{ total: number | string }>(
          'SELECT COUNT(*) AS total FROM zeroops_runtime_drains WHERE released_at IS NULL AND expires_at>NOW(3)',
        )
      ).rows[0];
      next = Number(row?.total ?? 0) > 0;
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_NO_SUCH_TABLE') next = false;
    }
    if (next !== this.draining) {
      this.draining = next;
      this.options.onChange?.(next);
    }
    return this.draining;
  }

  start() {
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }
}
