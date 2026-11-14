import { isInternalHost, type IntegrationValues } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import { LokiConnector } from '../connectors/loki.connector.js';
import { PrometheusConnector } from '../connectors/prometheus.connector.js';
import { SiteDatabaseConnector, siteDatabaseUrl } from '../connectors/site-database.connector.js';
import { createMailTransport } from '../smtp/smtp-transport.js';
import { toSmtpConfig, type IntegrationProbe } from './integration-settings.service.js';

type DatabaseValues = Extract<IntegrationValues, { kind: 'database' }>;

/** Endpoint `host:porta` usado na allowlist de conectores. */
function endpointOf(values: IntegrationValues): string | null {
  if (values.kind === 'database') return `${values.host.toLowerCase()}:${values.port}`;
  if (values.kind === 'telemetry' || values.kind === 'metrics') {
    const url = new URL(values.url);
    return `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
  }
  return null;
}

const COPILOT_CHECK_URL = 'https://api.github.com/user';

export interface IntegrationProbeOptions {
  /** Destinos fora da rede interna autorizados para BD/Loki (`host:porta`). */
  connectorEndpoints?: ReadonlySet<string>;
  fetch?: typeof fetch;
}

/**
 * Testes reais de cada integração. BD e Loki só para rede interna ou destinos na allowlist; o
 * Copilot só fala com a API do GitHub. As restantes integrações continuam bloqueadas.
 */
export class AuthorizedIntegrationProbe implements IntegrationProbe {
  private readonly connectorEndpoints: ReadonlySet<string>;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly smtpEndpoints: ReadonlySet<string>,
    options: IntegrationProbeOptions = {},
  ) {
    this.connectorEndpoints = options.connectorEndpoints ?? new Set();
    this.fetcher = options.fetch ?? fetch;
  }

  /** Rejeita destinos fora das allowlists antes de abrir qualquer ligação externa. */
  assertAllowed(values: IntegrationValues) {
    if (values.kind === 'smtp') {
      if (!this.smtpEndpoints.has(`${values.host.toLowerCase()}:${values.port}`))
        throw new DomainError(
          'ENDPOINT_NOT_AUTHORIZED',
          'O endpoint SMTP não consta da allowlist operacional externa.',
          503,
        );
      return;
    }
    if (values.kind === 'copilot') return;
    const endpoint = endpointOf(values);
    if (!endpoint)
      throw new DomainError(
        'CONNECTOR_NOT_VALIDATED',
        'O adaptador e a política desta integração ainda não foram validados no destino.',
        503,
      );
    const host = endpoint.slice(0, endpoint.lastIndexOf(':'));
    if (!isInternalHost(host) && !this.connectorEndpoints.has(endpoint))
      throw new DomainError(
        'ENDPOINT_NOT_AUTHORIZED',
        'O destino não é interno nem consta de ZEROOPS_CONNECTOR_ALLOWED_ENDPOINTS.',
        503,
      );
  }

  /** Verifica o transporte real permitido sem enviar email nem executar escrita na BD do site. */
  async verify(values: IntegrationValues) {
    this.assertAllowed(values);
    switch (values.kind) {
      case 'smtp':
        return this.verifySmtp(values);
      case 'database':
        return this.verifyDatabase(values);
      case 'telemetry':
        return new LokiConnector(
          values.url,
          { maxLines: 1, maxWindowMs: 3600000, timeoutMs: 5000 },
          values.token,
        ).ping();
      case 'metrics':
        return new PrometheusConnector(values.url, { timeoutMs: 5000 }, values.token).ping();
      case 'copilot':
        return this.verifyCopilot(values.token ?? '');
      default:
        throw new DomainError('CONNECTOR_NOT_VALIDATED', 'Adaptador indisponível.', 503);
    }
  }

  private async verifySmtp(values: Extract<IntegrationValues, { kind: 'smtp' }>) {
    const transport = createMailTransport(toSmtpConfig(values));
    try {
      await transport.verify();
    } catch {
      throw new DomainError(
        'SMTP_TEST_FAILED',
        'O relay não confirmou a ligação e autenticação SMTP. Nenhum email de teste foi enviado.',
        503,
      );
    } finally {
      transport.close();
    }
  }

  private async verifyDatabase(values: DatabaseValues) {
    const site = new SiteDatabaseConnector(siteDatabaseUrl(values), {
      maxRows: 1,
      timeoutSeconds: 5,
    });
    try {
      await site.query('SELECT 1');
    } catch (error) {
      const detail = error instanceof DomainError ? error.message : 'Ligação recusada.';
      throw new DomainError('DATABASE_TEST_FAILED', `A BD não aceitou a ligação: ${detail}`, 503);
    } finally {
      await site.close();
    }
  }

  private async verifyCopilot(token: string) {
    let status: number;
    try {
      const response = await this.fetcher(COPILOT_CHECK_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'ZeroOps',
        },
        signal: AbortSignal.timeout(10000),
      });
      status = response.status;
    } catch {
      throw new DomainError('COPILOT_TEST_FAILED', 'Sem ligação à API do GitHub.', 503);
    }
    if (status === 401 || status === 403)
      throw new DomainError('COPILOT_TOKEN_INVALID', 'O GitHub rejeitou o token.', 503);
    if (status !== 200)
      throw new DomainError('COPILOT_TEST_FAILED', `O GitHub respondeu ${status}.`, 503);
  }
}

function endpointList(raw: string | undefined, name: string) {
  const endpoints = new Set(
    (raw ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const endpoint of endpoints) {
    if (!/^[a-z0-9.:[\]-]+:\d{1,5}$/.test(endpoint)) throw new Error(`${name} inválido.`);
  }
  return endpoints;
}

/** Valida o ambiente operacional e constrói allowlists SMTP/conectores a partir da configuração. */
export function integrationRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv,
  publicUrl: string,
): {
  environment: 'quality' | 'production';
  smtpEndpoints: ReadonlySet<string>;
  connectorEndpoints: ReadonlySet<string>;
} {
  const url = publicUrl ? new URL(publicUrl) : null;
  const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const environment = env.ZEROOPS_ENVIRONMENT ?? (local ? 'quality' : undefined);
  if (environment !== 'quality' && environment !== 'production')
    throw new Error('Configure ZEROOPS_ENVIRONMENT como quality ou production.');
  return {
    environment,
    smtpEndpoints: endpointList(
      env.ZEROOPS_SMTP_ALLOWED_ENDPOINTS,
      'ZEROOPS_SMTP_ALLOWED_ENDPOINTS',
    ),
    connectorEndpoints: endpointList(
      env.ZEROOPS_CONNECTOR_ALLOWED_ENDPOINTS,
      'ZEROOPS_CONNECTOR_ALLOWED_ENDPOINTS',
    ),
  };
}
