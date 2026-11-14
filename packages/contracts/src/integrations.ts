import { z } from 'zod';

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.:[\]-]+$/);
const port = z.number().int().min(1).max(65535);
const reference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:/-]+$/);
const httpsUrl = z
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
  });
const password = z.string().min(1).max(8192).optional();

/** Loopback ou rede privada (RFC 1918 / ULA), onde se aceita HTTP sem TLS. */
export function isInternalHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1' || /^f[cd][0-9a-f]{2}:/.test(name)) return true;
  const octets = name.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const internalOrHttpsUrl = z
  .url()
  .max(1000)
  .refine(
    (value) => {
      const url = new URL(value);
      const allowed =
        url.protocol === 'https:' || (url.protocol === 'http:' && isInternalHost(url.hostname));
      return allowed && !url.username && !url.password && !url.hash && !url.search;
    },
    { message: 'Use HTTPS; HTTP só é aceite para loopback ou rede privada.' },
  );

export const integrationKinds = [
  'smtp',
  'svn',
  'documentation',
  'telemetry',
  'metrics',
  'database',
  'copilot',
  'deployment',
] as const;
export type IntegrationKind = (typeof integrationKinds)[number];
export type IntegrationEnvironment = 'quality' | 'production';

/**
 * Integrações cujos dados dependem do ambiente do site: Qualidade serve o agente e Produção serve
 * a Saúde. As restantes existem uma única vez na instalação e ficam guardadas em
 * `SHARED_INTEGRATION_ENVIRONMENT`.
 */
export const environmentScopedIntegrations: readonly IntegrationKind[] = [
  'database',
  'telemetry',
  'metrics',
];

/** Matchers PromQL aplicados a todas as consultas (ex.: `env="production"`), sem chavetas. */
export const PROMETHEUS_MATCHERS =
  /^[a-zA-Z_][a-zA-Z0-9_]*(=|!=|=~|!~)"[^"\\{}]*"(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*(=|!=|=~|!~)"[^"\\{}]*")*$/;
export const SHARED_INTEGRATION_ENVIRONMENT: IntegrationEnvironment = 'quality';

export function isEnvironmentScopedIntegration(kind: IntegrationKind) {
  return environmentScopedIntegrations.includes(kind);
}

/** Ambiente onde a integração fica guardada e é lida em runtime. */
export function storedIntegrationEnvironment(
  kind: IntegrationKind,
  environment: IntegrationEnvironment,
): IntegrationEnvironment {
  return isEnvironmentScopedIntegration(kind) ? environment : SHARED_INTEGRATION_ENVIRONMENT;
}
export const integrationValuesSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('smtp'),
      host,
      port,
      from: z.email().max(254),
      secure: z.boolean(),
      requireTLS: z.boolean(),
      allowInsecureLoopback: z.boolean(),
      username: z.string().max(320),
      password,
    })
    .refine(
      (input) =>
        input.secure ||
        input.requireTLS ||
        (input.allowInsecureLoopback &&
          ['localhost', '127.0.0.1', '::1'].includes(input.host.toLowerCase())),
      { message: 'TLS é obrigatório fora de loopback.' },
    ),
  z.strictObject({
    kind: z.literal('svn'),
    url: httpsUrl,
    username: z.string().max(320),
    password,
  }),
  z.strictObject({ kind: z.literal('documentation'), rootReference: reference }),
  z.strictObject({
    kind: z.literal('telemetry'),
    url: internalOrHttpsUrl,
    selector: z
      .string()
      .trim()
      .max(200)
      .regex(/^(\{.*\})?$/, 'O seletor LogQL começa por { e termina em }.')
      .optional(),
    token: password,
  }),
  z.strictObject({
    kind: z.literal('metrics'),
    url: internalOrHttpsUrl,
    matchers: z
      .string()
      .trim()
      .max(200)
      .refine((value) => value === '' || PROMETHEUS_MATCHERS.test(value), {
        message: 'Use matchers PromQL sem chavetas, por exemplo env="production".',
      })
      .optional(),
    token: password,
  }),
  z.strictObject({
    kind: z.literal('database'),
    host,
    port,
    database: z.string().trim().min(1).max(100),
    username: z.string().trim().min(1).max(100),
    password,
  }),
  z.strictObject({
    kind: z.literal('copilot'),
    model: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]*$/)
      .optional(),
    token: password,
  }),
  z.strictObject({ kind: z.literal('deployment'), destinationReference: reference }),
]);
export type IntegrationValues = z.infer<typeof integrationValuesSchema>;
export const integrationSaveSchema = z
  .strictObject({
    environment: z.enum(['quality', 'production']),
    scope: z.enum(['instance', 'project']),
    expectedVersion: z.number().int().nonnegative(),
    values: integrationValuesSchema,
  })
  .refine((input) => (input.scope === 'instance') === (input.values.kind === 'smtp'), {
    message: 'SMTP é configurado na instância; as restantes integrações pertencem ao projeto.',
  });
export const integrationActionSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});
export interface IntegrationSetting {
  id: string;
  scope: 'instance' | 'project';
  environment: 'quality' | 'production';
  kind: IntegrationKind;
  version: number;
  status: 'draft' | 'verified' | 'revoked';
  values: Record<string, string | number | boolean>;
  secretConfigured: boolean;
  testCode: string | null;
  testedAt: string | null;
}
export interface IntegrationField {
  key: string;
  pt: string;
  en: string;
  type: 'text' | 'password' | 'number' | 'checkbox';
  required?: boolean;
  defaultValue?: string | number | boolean;
}
export const integrationFields: Record<IntegrationKind, IntegrationField[]> = {
  smtp: [
    { key: 'host', pt: 'Servidor SMTP', en: 'SMTP server', type: 'text', required: true },
    { key: 'port', pt: 'Porta', en: 'Port', type: 'number', required: true, defaultValue: 587 },
    { key: 'from', pt: 'Remetente', en: 'Sender', type: 'text', required: true },
    { key: 'secure', pt: 'TLS direto', en: 'Direct TLS', type: 'checkbox', defaultValue: false },
    {
      key: 'requireTLS',
      pt: 'Exigir STARTTLS',
      en: 'Require STARTTLS',
      type: 'checkbox',
      defaultValue: true,
    },
    {
      key: 'allowInsecureLoopback',
      pt: 'Permitir relay sem TLS só em loopback',
      en: 'Allow non-TLS relay only on loopback',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      key: 'username',
      pt: 'Utilizador SMTP (opcional)',
      en: 'SMTP username (optional)',
      type: 'text',
    },
    { key: 'password', pt: 'Nova palavra-passe SMTP', en: 'New SMTP password', type: 'password' },
  ],
  svn: [
    {
      key: 'url',
      pt: 'URL HTTPS do repositório',
      en: 'Repository HTTPS URL',
      type: 'text',
      required: true,
    },
    { key: 'username', pt: 'Utilizador de leitura', en: 'Read-only username', type: 'text' },
    { key: 'password', pt: 'Nova palavra-passe', en: 'New password', type: 'password' },
  ],
  documentation: [
    {
      key: 'rootReference',
      pt: 'Referência de documentação autorizada',
      en: 'Authorized documentation reference',
      type: 'text',
      required: true,
    },
  ],
  telemetry: [
    {
      key: 'url',
      pt: 'URL do Loki (HTTPS, ou HTTP só em rede interna)',
      en: 'Loki URL (HTTPS, or HTTP only on an internal network)',
      type: 'text',
      required: true,
    },
    {
      key: 'selector',
      pt: 'Seletor LogQL sugerido ao agente (ex.: {job="pizzahut"})',
      en: 'LogQL selector suggested to the agent (e.g. {job="pizzahut"})',
      type: 'text',
    },
    {
      key: 'token',
      pt: 'Novo token de leitura (opcional)',
      en: 'New read-only token (optional)',
      type: 'password',
    },
  ],
  metrics: [
    {
      key: 'url',
      pt: 'URL do Prometheus (HTTPS, ou HTTP só em rede interna)',
      en: 'Prometheus URL (HTTPS, or HTTP only on an internal network)',
      type: 'text',
      required: true,
    },
    {
      key: 'matchers',
      pt: 'Filtro de labels deste ambiente (ex.: env="production")',
      en: 'Label filter for this environment (e.g. env="production")',
      type: 'text',
    },
    {
      key: 'token',
      pt: 'Novo token de leitura (opcional)',
      en: 'New read-only token (optional)',
      type: 'password',
    },
  ],
  database: [
    { key: 'host', pt: 'Servidor de dados', en: 'Database server', type: 'text', required: true },
    { key: 'port', pt: 'Porta', en: 'Port', type: 'number', required: true, defaultValue: 3306 },
    { key: 'database', pt: 'Base de dados', en: 'Database', type: 'text', required: true },
    {
      key: 'username',
      pt: 'Utilizador (o conector só executa leituras)',
      en: 'Username (the connector only runs reads)',
      type: 'text',
      required: true,
    },
    { key: 'password', pt: 'Nova palavra-passe', en: 'New password', type: 'password' },
  ],
  copilot: [
    {
      key: 'token',
      pt: 'Novo token GitHub com permissão Copilot Requests',
      en: 'New GitHub token with Copilot Requests permission',
      type: 'password',
    },
    {
      key: 'model',
      pt: 'Modelo (opcional, ex.: claude-sonnet-4.5)',
      en: 'Model (optional, e.g. claude-sonnet-4.5)',
      type: 'text',
    },
  ],
  deployment: [
    {
      key: 'destinationReference',
      pt: 'Destino previamente inventariado',
      en: 'Previously verified destination',
      type: 'text',
      required: true,
    },
  ],
};
