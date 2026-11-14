import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../../errors.js';

interface SpooledAlert {
  /** Hash sha256 do token do agente; o projeto é resolvido (e o token validado) ao reprocessar. */
  tokenHash: string;
  body: unknown;
  receivedAt: string;
}

export type SpoolHandler = (tokenHash: string, body: unknown) => Promise<unknown>;

/**
 * Fila em disco dos webhooks do Alertmanager que não puderam ser gravados (ex.: BD do ZeroOps
 * indisponível). Os ficheiros são reprocessados por ordem de chegada quando a BD volta, para
 * que o disparo de um alerta não se perca se só a resolução chegar depois.
 */
export class AlertSpool {
  private draining: Promise<number> | null = null;

  constructor(
    private readonly directory: string,
    private readonly maxFiles = 500,
  ) {}

  /** Guarda o webhook; devolve false se a fila estiver cheia ou o disco indisponível. */
  async save(tokenHash: string, body: unknown, now = new Date()) {
    try {
      await mkdir(this.directory, { recursive: true });
      if ((await this.files()).length >= this.maxFiles) return false;
      const name = `${String(now.getTime()).padStart(15, '0')}-${randomUUID()}.json`;
      const entry: SpooledAlert = { tokenHash, body, receivedAt: now.toISOString() };
      // Escrita atómica: o reprocessamento nunca lê um ficheiro incompleto.
      await writeFile(join(this.directory, `${name}.tmp`), JSON.stringify(entry), { mode: 0o600 });
      await rename(join(this.directory, `${name}.tmp`), join(this.directory, name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reprocessa a fila por ordem; pára no primeiro erro de infraestrutura para manter a ordem.
   * Payloads rejeitados pelo domínio (token inválido, payload inválido) são descartados.
   * Devolve quantos foram tratados.
   */
  drain(handler: SpoolHandler) {
    this.draining ??= this.run(handler).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async run(handler: SpoolHandler) {
    let handled = 0;
    for (const name of await this.files()) {
      const path = join(this.directory, name);
      let entry: SpooledAlert;
      try {
        entry = JSON.parse(await readFile(path, 'utf8')) as SpooledAlert;
      } catch {
        await unlink(path).catch(() => undefined);
        continue;
      }
      try {
        await handler(entry.tokenHash, entry.body);
      } catch (error) {
        if (!(error instanceof DomainError)) break;
      }
      await unlink(path).catch(() => undefined);
      handled += 1;
    }
    return handled;
  }

  /** Número de webhooks ainda em fila. */
  async pending() {
    return (await this.files()).length;
  }

  private async files() {
    try {
      return (await readdir(this.directory)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }
}
