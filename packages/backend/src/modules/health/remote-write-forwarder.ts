import { DomainError } from '../../errors.js';

/** Corpo máximo aceite por pedido (protobuf comprimido com snappy). */
export const REMOTE_WRITE_MAX_BYTES = 4 * 1024 * 1024;

export interface RemoteWriteRequest {
  body: Buffer;
  contentType?: string;
  contentEncoding?: string;
  version?: string;
}

export interface RemoteWriteResult {
  status: number;
  message: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Encaminha o `remote_write` do Prometheus de Produção (modo agente) para o Prometheus local
 * do ZeroOps. O corpo segue intacto; só valida o formato e devolve o estado do destino para o
 * agente decidir se repete o envio (5xx/429) ou descarta o lote (4xx).
 */
export class RemoteWriteForwarder {
  constructor(
    private readonly writeUrl: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 15000,
  ) {}

  /** Reencaminha o lote de remote write recebido para o Prometheus do ZeroOps. */
  async forward(request: RemoteWriteRequest): Promise<RemoteWriteResult> {
    if (!request.contentType?.toLowerCase().startsWith('application/x-protobuf'))
      throw new DomainError('VALIDATION', 'Formato de remote write inválido.', 415);
    if ((request.contentEncoding ?? '').toLowerCase() !== 'snappy')
      throw new DomainError('VALIDATION', 'Remote write tem de vir comprimido com snappy.', 415);
    if (!request.body.length) throw new DomainError('VALIDATION', 'Remote write vazio.', 400);
    if (request.body.length > REMOTE_WRITE_MAX_BYTES)
      throw new DomainError('VALIDATION', 'Remote write demasiado grande.', 413);
    let response: Response;
    try {
      response = await this.fetchImpl(this.writeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': request.contentType,
          'Content-Encoding': 'snappy',
          'X-Prometheus-Remote-Write-Version': request.version || '0.1.0',
        },
        body: new Uint8Array(request.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { status: 503, message: 'Prometheus do ZeroOps indisponível.' };
    }
    const text = (await response.text().catch(() => '')).slice(0, 300);
    return {
      status: response.status,
      message: response.ok ? 'accepted' : text || `Prometheus respondeu ${response.status}.`,
    };
  }
}
