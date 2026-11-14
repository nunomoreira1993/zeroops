import {
  healthThresholdsSchema,
  type HealthAlertEventKind,
  type HealthAlertState,
  type HealthCriticality,
  type HealthNotificationView,
  type HealthStatus,
  type HealthThresholds,
} from '@zeroops/contracts';
import type { Locale } from '../../lib/identity';

export const criticalityLabels: Record<HealthCriticality, string> = {
  informativa: 'Informativa',
  preventiva: 'Preventiva',
  critica: 'Crítica',
  urgente: 'Urgente',
};

export const criticalityOrder: HealthCriticality[] = [
  'urgente',
  'critica',
  'preventiva',
  'informativa',
];

export const statusLabels: Record<HealthStatus, string> = {
  ok: 'OK',
  warning: 'Aviso',
  critical: 'Crítico',
  unknown: 'Sem dados',
};

export const channelLabels: Record<string, string> = {
  painel: 'Painel',
  relatorio: 'Relatório',
  email: 'E-mail',
  sms: 'SMS',
  chamada: 'Chamada',
};

export const sourceLabels: Record<string, string> = {
  host_agent: 'Agente no servidor',
  http: 'Monitorização externa',
  site_database: 'BD do site',
  logs: 'Logs (Loki)',
  report: 'Agregado',
};

export const thresholdFields: { key: keyof HealthThresholds; label: string; step?: number }[] = [
  { key: 'diskFreePercent', label: 'Disco livre mínimo (%)' },
  { key: 'inodeFreePercent', label: 'Inodes livres mínimos (%)' },
  { key: 'cpuLoadPerCore', label: 'Carga máxima por core', step: 0.1 },
  { key: 'memoryUsedPercent', label: 'Memória usada máxima (%)' },
  { key: 'logGrowthMbPerHour', label: 'Crescimento de logs (MB/h)' },
  { key: 'tempFiles', label: 'Ficheiros temporários' },
  { key: 'sessionFiles', label: 'Ficheiros de sessão' },
  { key: 'responseMs', label: 'Tempo de resposta (ms)' },
  { key: 'slowQueries', label: 'Queries lentas por ciclo' },
  { key: 'dbConnectionsPercent', label: 'Ligações BD usadas (%)' },
  { key: 'paymentFailurePercent', label: 'Falhas/recusas de pagamento (%)' },
  { key: 'paymentPendingPercent', label: 'Pagamentos pendentes (%)' },
  { key: 'paymentMinAttempts', label: 'Mínimo de tentativas por hora' },
  { key: 'paidNotIntegratedMinutes', label: 'Pago sem integração após (min)' },
  { key: 'divergenceCount', label: 'Divergências pagas/finalizadas' },
  { key: 'appErrorsPerHour', label: 'Erros aplicacionais por hora' },
  { key: 'authFailuresPerHour', label: 'Falhas de autenticação por hora' },
  { key: 'cronStaleMinutes', label: 'Tarefa agendada atrasada (min)' },
  { key: 'agentStaleMinutes', label: 'Agente sem resposta (min)' },
];

/** Limites aceites pelo contrato, usados como min/max nativos para a validação KTUI. */
export function thresholdBounds(key: keyof HealthThresholds) {
  const schema = healthThresholdsSchema.shape[key].unwrap();
  return {
    min: schema.minValue ?? undefined,
    max: schema.maxValue ?? undefined,
  };
}

/** Campo numérico vazio fica como NaN no rascunho; o input mostra-o vazio. */
export function numberValue(value: number) {
  return Number.isNaN(value) ? '' : value;
}

export function formatDate(value: string | null, locale: Locale = 'pt-PT') {
  return value
    ? new Date(value).toLocaleString(locale === 'en' ? 'en-GB' : 'pt-PT', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '—';
}

export const deliveryStateLabels: Record<HealthNotificationView['state'], string> = {
  pending: 'Em fila',
  sent: 'Enviado',
  failed: 'Falhou',
  blocked: 'Bloqueado',
};

export const notificationKindLabels: Record<HealthNotificationView['kind'], string> = {
  alert: 'Alerta',
  resolved: 'Resolução',
  report: 'Relatório',
};

export const alertStateLabels: Record<HealthAlertState, string> = {
  open: 'Aberto',
  acknowledged: 'Receção confirmada',
  resolved: 'Resolvido',
};

export const alertEventLabels: Record<HealthAlertEventKind, string> = {
  opened: 'Alarme aberto',
  escalated: 'Agravado',
  reminder: 'Lembrete',
  acknowledged: 'Receção confirmada',
  assigned: 'Atribuído',
  unassigned: 'Responsável removido',
  resolved: 'Resolvido',
  refired: 'Voltou a disparar',
  ticket: 'Ticket aberto',
};

/** Códigos de erro das entregas traduzidos para a equipa; os restantes aparecem tal como vêm. */
export const deliveryErrorLabels: Record<string, string> = {
  no_recipients: 'sem destinatários configurados',
  channel_not_configured: 'canal sem fornecedor configurado',
  smtp_not_configured: 'SMTP não configurado',
};

export function formatDuration(from: string, to: string | null, locale: Locale = 'pt-PT') {
  const minutes = Math.max(
    0,
    Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 60000),
  );
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} ${locale === 'en' ? 'days' : 'dias'}`;
}

const thresholdLabelsEn: Record<keyof HealthThresholds, string> = {
  diskFreePercent: 'Minimum free disk (%)',
  inodeFreePercent: 'Minimum free inodes (%)',
  cpuLoadPerCore: 'Maximum load per core',
  memoryUsedPercent: 'Maximum memory used (%)',
  logGrowthMbPerHour: 'Log growth (MB/h)',
  tempFiles: 'Temporary files',
  sessionFiles: 'Session files',
  responseMs: 'Response time (ms)',
  slowQueries: 'Slow queries per cycle',
  dbConnectionsPercent: 'DB connections used (%)',
  paymentFailurePercent: 'Payment failures/declines (%)',
  paymentPendingPercent: 'Pending payments (%)',
  paymentMinAttempts: 'Minimum attempts per hour',
  paidNotIntegratedMinutes: 'Paid but not integrated after (min)',
  divergenceCount: 'Paid/completed mismatches',
  appErrorsPerHour: 'Application errors per hour',
  authFailuresPerHour: 'Authentication failures per hour',
  cronStaleMinutes: 'Scheduled task overdue (min)',
  agentStaleMinutes: 'Agent not responding (min)',
};

interface HealthLabelSet {
  criticality: Record<HealthCriticality, string>;
  status: Record<HealthStatus, string>;
  channel: Record<string, string>;
  source: Record<string, string>;
  thresholdFields: typeof thresholdFields;
  deliveryState: Record<HealthNotificationView['state'], string>;
  notificationKind: Record<HealthNotificationView['kind'], string>;
  alertState: Record<HealthAlertState, string>;
  alertEvent: Record<HealthAlertEventKind, string>;
  deliveryError: Record<string, string>;
}

const englishLabels: HealthLabelSet = {
  criticality: {
    informativa: 'Informational',
    preventiva: 'Preventive',
    critica: 'Critical',
    urgente: 'Urgent',
  },
  status: {
    ok: 'OK',
    warning: 'Warning',
    critical: 'Critical',
    unknown: 'No data',
  },
  channel: {
    painel: 'Dashboard',
    relatorio: 'Report',
    email: 'Email',
    sms: 'SMS',
    chamada: 'Phone call',
  },
  source: {
    host_agent: 'Server agent',
    http: 'External monitoring',
    site_database: 'Site database',
    logs: 'Logs (Loki)',
    report: 'Aggregate',
  },
  thresholdFields: thresholdFields.map((field) => ({
    ...field,
    label: thresholdLabelsEn[field.key],
  })),
  deliveryState: {
    pending: 'Queued',
    sent: 'Sent',
    failed: 'Failed',
    blocked: 'Blocked',
  },
  notificationKind: {
    alert: 'Alert',
    resolved: 'Resolution',
    report: 'Report',
  },
  alertState: {
    open: 'Open',
    acknowledged: 'Acknowledged',
    resolved: 'Resolved',
  },
  alertEvent: {
    opened: 'Alarm opened',
    escalated: 'Escalated',
    reminder: 'Reminder',
    acknowledged: 'Acknowledged',
    assigned: 'Assigned',
    unassigned: 'Assignee removed',
    resolved: 'Resolved',
    refired: 'Fired again',
    ticket: 'Ticket opened',
  },
  deliveryError: {
    no_recipients: 'no recipients configured',
    channel_not_configured: 'channel has no provider configured',
    smtp_not_configured: 'SMTP not configured',
  },
};

const portugueseLabels: HealthLabelSet = {
  criticality: criticalityLabels,
  status: statusLabels,
  channel: channelLabels,
  source: sourceLabels,
  thresholdFields,
  deliveryState: deliveryStateLabels,
  notificationKind: notificationKindLabels,
  alertState: alertStateLabels,
  alertEvent: alertEventLabels,
  deliveryError: deliveryErrorLabels,
};

/** Etiquetas da Saúde no idioma pedido; as exportações individuais acima mantêm o pt-PT. */
export function healthLabels(locale: Locale = 'pt-PT'): HealthLabelSet {
  return locale === 'en' ? englishLabels : portugueseLabels;
}
