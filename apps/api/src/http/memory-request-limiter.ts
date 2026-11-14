/**
 * Contador em memória por janela fixa, usado só quando a BD do rate limit falha
 * (ex.: queda do MariaDB), para os webhooks/agentes continuarem a ser aceites com limite.
 */
export class MemoryRequestLimiter {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly windowMs = 10 * 60_000,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string) {
    const now = this.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) return ++entry.count;
    if (!entry && this.entries.size >= this.maxKeys) this.prune(now);
    this.entries.set(key, { count: 1, expiresAt: now + this.windowMs });
    return 1;
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) this.entries.clear();
  }
}
