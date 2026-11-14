import { z } from 'zod';
import { alertRuleOverridesSchema, type AlertRulesSyncStatus } from './alert-rules.js';
import type { HealthSuspensionState } from './incidents.js';

/** Criticidade de um alerta: define canais de envio e frequencia de re-notificacao. */
export const healthCriticalities = ['informativa', 'preventiva', 'critica', 'urgente'] as const;
export type HealthCriticality = (typeof healthCriticalities)[number];

export const healthChannels = ['painel', 'relatorio', 'email', 'sms', 'chamada'] as const;
export type HealthChannel = (typeof healthChannels)[number];

export const healthStatuses = ['ok', 'warning', 'critical', 'unknown'] as const;
export type HealthStatus = (typeof healthStatuses)[number];

/** De onde vem o dado: agente no host, sonda HTTP externa, BD do site, logs (Loki) ou agregado. */
export const healthSources = ['host_agent', 'http', 'site_database', 'logs', 'report'] as const;
export type HealthSource = (typeof healthSources)[number];

export const healthCheckGroups = [
  'Servidores',
  'Serviços (MySQL, Redis)',
  'Disponibilidade do site',
  'IBM i (DB2 e filas DTQ)',
  'Verificações internas',
  'Pagamentos',
  'Logs/Aplicação',
  'Relatórios',
] as const;
export type HealthCheckGroup = (typeof healthCheckGroups)[number];

export interface HealthCheckDefinition {
  id: string;
  group: HealthCheckGroup;
  title: string;
  description: string;
  criticality: HealthCriticality;
  channels: HealthChannel[];
  source: HealthSource;
  /** Estado da alarmistica equivalente no proprio site (lista de alarmistica). */
  siteStatus: 'done' | 'analysis';
}

export interface HealthCheckView extends HealthCheckDefinition {
  status: HealthStatus;
  value: number | null;
  unit: string | null;
  summary: string;
  checkedAt: string | null;
  statusSince: string | null;
}

export type HealthAlertState = 'open' | 'acknowledged' | 'resolved';

export interface HealthAlertView {
  id: string;
  checkId: string;
  title: string;
  criticality: HealthCriticality;
  severity: Exclude<HealthStatus, 'ok'>;
  state: HealthAlertState;
  summary: string;
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  resolvedAt: string | null;
  notifyCount: number;
  emailState: 'pending' | 'sent' | 'failed' | 'blocked' | null;
  emailErrorCode: string | null;
}

export type HealthAlertSource = 'internal' | 'prometheus';
export type HealthAlertEventKind =
  | 'opened'
  | 'escalated'
  | 'reminder'
  | 'acknowledged'
  | 'assigned'
  | 'unassigned'
  | 'resolved'
  | 'refired'
  | 'ticket';

export interface HealthAlertEventView {
  kind: HealthAlertEventKind;
  at: string;
  actorName: string | null;
  detail: string | null;
}

export interface HealthNotificationView {
  id: string;
  alertId: string | null;
  kind: 'alert' | 'resolved' | 'report';
  channel: 'email' | 'sms' | 'chamada';
  recipients: string[];
  subject: string;
  state: 'pending' | 'sent' | 'failed' | 'blocked';
  errorCode: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

/** Alarme (interno ou do Prometheus) com a cronologia de eventos e notificações enviadas. */
export interface HealthAlertHistoryEntry {
  id: string;
  source: HealthAlertSource;
  checkId: string | null;
  title: string;
  criticality: HealthCriticality;
  state: HealthAlertState;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedName: string | null;
  assignedName: string | null;
  ticketId: string | null;
  events: HealthAlertEventView[];
  notifications: HealthNotificationView[];
}

export const healthHistoryQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(30),
  check: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
});
export type HealthHistoryQuery = z.infer<typeof healthHistoryQuerySchema>;

export interface HealthHistory {
  since: string;
  days: number;
  alerts: HealthAlertHistoryEntry[];
  /** Registo de envios do período (alertas, resoluções e relatórios), mais recentes primeiro. */
  notifications: HealthNotificationView[];
}

const emails = z.array(z.email().max(200)).max(20);
const httpsUrl = z
  .url()
  .max(300)
  .refine((value) => /^https?:\/\//.test(value), 'Use http:// ou https://');

export const healthThresholdsSchema = z.strictObject({
  diskFreePercent: z.number().min(1).max(90).default(15),
  inodeFreePercent: z.number().min(1).max(90).default(10),
  cpuLoadPerCore: z.number().min(0.1).max(20).default(1.5),
  memoryUsedPercent: z.number().min(10).max(100).default(90),
  logGrowthMbPerHour: z.number().min(1).max(100000).default(200),
  tempFiles: z.number().int().min(10).max(10000000).default(5000),
  sessionFiles: z.number().int().min(10).max(10000000).default(50000),
  responseMs: z.number().int().min(100).max(60000).default(3000),
  slowQueries: z.number().int().min(1).max(100000).default(10),
  dbConnectionsPercent: z.number().min(10).max(100).default(80),
  paymentFailurePercent: z.number().min(1).max(100).default(20),
  paymentPendingPercent: z.number().min(1).max(100).default(15),
  paymentMinAttempts: z.number().int().min(1).max(10000).default(20),
  paidNotIntegratedMinutes: z.number().int().min(1).max(1440).default(15),
  divergenceCount: z.number().int().min(1).max(10000).default(1),
  appErrorsPerHour: z.number().int().min(1).max(1000000).default(200),
  authFailuresPerHour: z.number().int().min(1).max(1000000).default(100),
  cronStaleMinutes: z.number().int().min(5).max(1440).default(30),
  agentStaleMinutes: z.number().int().min(2).max(120).default(5),
});
export type HealthThresholds = z.infer<typeof healthThresholdsSchema>;

const listId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use minúsculas, números e hífens (máx. 40).');
const listIds = z.array(listId).max(10);

/** Lista de distribuicao com nome, reutilizavel por varios alarmes. */
export const healthRecipientListSchema = z.strictObject({
  id: listId,
  name: z.string().trim().min(1).max(80),
  emails,
});
export type HealthRecipientList = z.infer<typeof healthRecipientListSchema>;

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM.');
const timeZone = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Fuso horário desconhecido (ex.: Europe/Lisbon).');

/** Dias da semana (0 = domingo … 6 = sábado), como `Date.getDay()`. */
export const healthWeekdays = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * Alvo de uma paragem planeada:
 * - `<id>`: verificação do worker de Saúde (ex.: `site-availability`);
 * - `rule:<Alerta>`: regra de alerta do Prometheus (ex.: `rule:DtqErrosNoLog`);
 * - `probe:<id>`: sonda executada no servidor (ex.: `probe:dtq`, a sonda do DTQ users).
 */
export const healthQuietTarget = z
  .string()
  .regex(
    /^([a-z0-9-]{1,60}|rule:[A-Za-z][A-Za-z0-9_]{0,79}|probe:[a-z0-9-]{1,40})$/,
    'Alvo inválido.',
  );

/**
 * Paragem planeada (ex.: IBM i desligado de noite): dentro da janela os alvos indicados não
 * abrem alertas nem enviam lembretes. Se `start` > `end`, atravessa a meia-noite; `days` são os
 * dias em que a janela começa (por omissão, todos, incluindo o fim de semana).
 */
export const healthQuietWindowSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    start: clockTime,
    end: clockTime,
    timezone: timeZone.default('Europe/Lisbon'),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Escolha pelo menos um dia.')
      .max(7)
      .default([0, 1, 2, 3, 4, 5, 6]),
    checks: z.array(healthQuietTarget).min(1, 'Escolha pelo menos um alvo.').max(80),
  })
  .refine((window) => window.start !== window.end, {
    path: ['end'],
    message: 'O fim tem de ser diferente do início.',
  });
export type HealthQuietWindow = z.infer<typeof healthQuietWindowSchema>;

/** Destino do relatorio periodico, alem das criticidades. */
export const healthRecipientTargets = [...healthCriticalities, 'report'] as const;
export type HealthRecipientTarget = (typeof healthRecipientTargets)[number];

export const healthSettingsSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** Ambiente cujas integracoes (BD do site, Loki) sao lidas: normalmente producao. */
    sourceEnvironment: z.enum(['quality', 'production']).default('production'),
    /** Ambiente cujo SMTP de instancia envia os e-mails. */
    mailEnvironment: z.enum(['quality', 'production']).default('quality'),
    siteUrl: httpsUrl.optional(),
    appUrl: httpsUrl.optional(),
    apiUrls: z.array(httpsUrl).max(10).default([]),
    logSelector: z
      .string()
      .trim()
      .max(200)
      .regex(/^\{.*\}$/, 'O seletor LogQL comeca por { e termina em }.')
      .default('{job="php"}'),
    /** E-mails diretos por criticidade (formato anterior as listas); somados as listas. */
    recipients: z
      .strictObject({
        informativa: emails.default([]),
        preventiva: emails.default([]),
        critica: emails.default([]),
        urgente: emails.default([]),
        report: emails.default([]),
      })
      .default({ informativa: [], preventiva: [], critica: [], urgente: [], report: [] }),
    /** Listas de distribuicao com nome. */
    lists: z.array(healthRecipientListSchema).max(20).default([]),
    /** Listas usadas por defeito em cada criticidade e no relatorio. */
    defaults: z
      .strictObject({
        informativa: listIds.default([]),
        preventiva: listIds.default([]),
        critica: listIds.default([]),
        urgente: listIds.default([]),
        report: listIds.default([]),
      })
      .default({ informativa: [], preventiva: [], critica: [], urgente: [], report: [] }),
    /** Encaminhamento por alarme (id da verificacao -> listas); substitui o defeito da criticidade. */
    routes: z.record(z.string().regex(/^[a-z0-9-]{1,60}$/), listIds).default({}),
    reportHourUtc: z.number().int().min(0).max(23).default(7),
    /** Paragens planeadas em que certas verificações, regras e sondas não notificam. */
    quietWindows: z.array(healthQuietWindowSchema).max(10).default([]),
    /** Alterações às regras de alerta do Prometheus (Regras de alerta); vazio = catálogo. */
    alertRules: alertRuleOverridesSchema.default({}),
    thresholds: healthThresholdsSchema.default(healthThresholdsSchema.parse({})),
  })
  .superRefine((settings, context) => {
    const ids = new Set<string>();
    settings.lists.forEach((list, index) => {
      if (ids.has(list.id))
        context.addIssue({
          code: 'custom',
          path: ['lists', index, 'id'],
          message: 'Lista repetida.',
        });
      ids.add(list.id);
    });
    const check = (path: (string | number)[], values: string[]) =>
      values.forEach((value, index) => {
        if (!ids.has(value))
          context.addIssue({
            code: 'custom',
            path: [...path, index],
            message: `Lista inexistente: ${value}.`,
          });
      });
    for (const [target, values] of Object.entries(settings.defaults))
      check(['defaults', target], values);
    for (const [checkId, values] of Object.entries(settings.routes))
      check(['routes', checkId], values);
  });
export type HealthSettings = z.infer<typeof healthSettingsSchema>;

export const healthAssignSchema = z.strictObject({ userId: z.uuid().nullable() });

export interface HealthMember {
  id: string;
  displayName: string;
}

export interface HealthOverview {
  settings: HealthSettings;
  configured: boolean;
  canManage: boolean;
  agentTokenConfigured: boolean;
  lastCycleAt: string | null;
  lastReportAt: string | null;
  lastAgentSampleAt: string | null;
  checks: HealthCheckView[];
  alerts: HealthAlertView[];
  members: HealthMember[];
  /** Estado da geração das regras do Prometheus a partir das Regras de alerta. */
  alertRulesSync: AlertRulesSyncStatus;
  /** Suspensão manual da Saúde por ambiente (botão Suspender/Retomar). */
  suspension: HealthSuspensionState;
}

/** Amostra enviada pelo agente instalado no servidor (cron). Campos opcionais: o que existir. */
const count = z.number().int().min(0);
const orderId = z.number().int().nullable();
const paymentRates = { total: count, failed: count, pending: count };

/** Valores brutos das consultas a BD do site; a avaliacao contra limites e feita no ZeroOps. */
export const healthSiteMetricsSchema = z.strictObject({
  saturation: z
    .strictObject({ connected: count, max: count, running: count, slowQueriesTotal: count })
    .optional(),
  shift4: z.strictObject(paymentRates).optional(),
  wallet: z.strictObject({ ...paymentRates, mbway: count, mbwayFailed: count }).optional(),
  divergence: z.strictObject({ count, firstOrderId: orderId }).optional(),
  paidNotIntegrated: z
    .strictObject({
      count,
      firstOrderId: orderId,
      oldestMinutes: count,
      failed: count,
      thresholdMinutes: z.number().int().min(1).max(1440),
    })
    .optional(),
  /** Consultas que falharam no agente (nome curto da metrica). */
  errors: z.array(z.string().max(60)).max(10).optional(),
});
export type HealthSiteMetrics = z.infer<typeof healthSiteMetricsSchema>;

const cronInstant = z.string().datetime({ offset: true });
const legacyCronSampleSchema = z.strictObject({
  name: z.string().max(100),
  lastRunAgeMinutes: z.number().min(0),
});

/** Estado de heartbeat de uma tarefa instrumentada; HTTP completion nao significa sucesso funcional. */
const scheduledCronSampleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(100),
  schedule: z.string().trim().min(1).max(100),
  timeZone: z.string().trim().min(1).max(100),
  graceMinutes: z.number().int().min(1).max(1440),
  activatedAt: cronInstant,
  lastAttemptAt: cronInstant.nullable(),
  lastExitCode: z.number().int().nullable(),
  lastHttpStatus: z.number().int().min(0).max(599).nullable(),
  lastHttpCurlExitCode: z.number().int().nullable(),
  lastHttpCompletedAt: cronInstant.nullable(),
  lastHttpCompletedStatus: z.number().int().min(200).max(299).nullable(),
  lastFailureAt: cronInstant.nullable(),
  lastFailureCode: z.string().max(40).nullable(),
  inProgress: z.boolean(),
});
export type HealthCronSample =
  z.infer<typeof legacyCronSampleSchema> | z.infer<typeof scheduledCronSampleSchema>;

export const healthAgentSampleSchema = z.strictObject({
  host: z.string().trim().min(1).max(255),
  collectedAt: z.string().max(40).optional(),
  cpu: z
    .strictObject({
      load1: z.number().min(0),
      load5: z.number().min(0),
      cores: z.number().int().min(1),
    })
    .optional(),
  memory: z.strictObject({ totalKb: z.number().min(0), availableKb: z.number().min(0) }).optional(),
  disks: z
    .array(
      z.strictObject({
        mount: z.string().max(255),
        usedPercent: z.number().min(0).max(100),
        inodesUsedPercent: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .max(50)
    .optional(),
  logs: z
    .array(z.strictObject({ path: z.string().max(255), sizeBytes: z.number().min(0) }))
    .max(50)
    .optional(),
  tempFiles: z.number().int().min(0).optional(),
  sessionFiles: z.number().int().min(0).optional(),
  services: z
    .array(z.strictObject({ name: z.string().max(100), active: z.boolean() }))
    .max(30)
    .optional(),
  redis: z.strictObject({ ok: z.boolean() }).optional(),
  mounts: z
    .array(z.strictObject({ path: z.string().max(255), ok: z.boolean() }))
    .max(30)
    .optional(),
  /** Aceita o payload antigo de idade e o contrato por tarefa com prazo configurado. */
  crons: z
    .array(z.union([scheduledCronSampleSchema, legacyCronSampleSchema]))
    .max(50)
    .optional(),
  /** Metricas agregadas da BD do site, recolhidas pelo agente com utilizador so de leitura. */
  site: healthSiteMetricsSchema.optional(),
  /** Ocorrencias nos logs da aplicacao numa janela deslizante (contadas pelo agente). */
  logEvents: z
    .strictObject({
      windowMinutes: z.number().int().min(1).max(1440),
      applicationErrors: z.number().int().min(0),
      authFailures: z.number().int().min(0),
      sample: z.array(z.string().max(300)).max(5).optional(),
    })
    .optional(),
});
export type HealthAgentSample = z.infer<typeof healthAgentSampleSchema>;
