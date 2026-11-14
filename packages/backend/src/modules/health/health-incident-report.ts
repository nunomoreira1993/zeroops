import { formatLisbonTime } from '../smtp/mail-layout.js';

/** Alerta do Prometheus associado a um incidente. */
export interface IncidentAlert {
  id: string;
  name: string;
  /** Título legível da regra (anotação `title`); `null` em alertas antigos. */
  title: string | null;
  summary: string;
  labels: Record<string, string>;
  criticality: string;
  startsAt: Date;
  resolvedAt: Date | null;
  fireCount: number;
  /** Valor legível da métrica no disparo e na recuperação (lido do Prometheus); `null` sem leitura. */
  metricBefore?: string | null;
  metricAfter?: string | null;
}

/** E-mail da Saúde enviado (ou bloqueado) por causa de um alerta do incidente. */
export interface IncidentNotification {
  alertId: string | null;
  kind: string;
  recipients: string[];
  subject: string;
  state: string;
  createdAt: Date;
  sentAt: Date | null;
}

export interface IncidentReportInput {
  environment: 'quality' | 'production';
  openedAt: Date;
  recoveredAt: Date;
  rootAlertId: string;
  alerts: IncidentAlert[];
  notifications: IncidentNotification[];
}

const ENVIRONMENT = { quality: 'Qualidade (QA)', production: 'Produção' } as const;
const NOTIFICATION_STATE: Record<string, string> = {
  sent: 'enviado',
  pending: 'em fila',
  failed: 'falhou',
  blocked: 'sem destinatários',
};

/**
 * Peso da causa provável: um servidor em baixo explica tudo o resto, a base de dados explica os
 * sites, e a falta de recursos explica lentidão. Um site a falhar é quase sempre consequência.
 */
export function incidentRank(name: string, labels: Record<string, string>) {
  const text = `${name} ${labels.service ?? ''} ${labels.job ?? ''}`.toLowerCase();
  if (/instancedown|hostdown|nodedown|\bnode\b.*down|servidor/.test(text)) return 4;
  if (/mysql|mariadb|database|\bdb2?\b/.test(text)) return 3;
  if (/disk|disco|memory|memoria|memória|cpu|load|inode|fpm|apache|worker/.test(text)) return 2;
  return 1;
}

/** Nome legível: `MysqlDown` → «Mysql down». */
export function readableAlertName(name: string) {
  const words = name
    .replace(/([a-zà-ÿ0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Duração legível em PT: «4 min», «1 h 05 min», «menos de 1 min». */
export function formatDuration(ms: number) {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const label = (alert: IncidentAlert) => alert.title ?? readableAlertName(alert.name);
const where = (alert: IncidentAlert) =>
  alert.labels.instance ? ` (${alert.labels.instance})` : '';
const time = (value: Date | null) => (value ? formatLisbonTime(value) : '—');
const hasMetric = (alert: IncidentAlert | undefined): alert is IncidentAlert =>
  Boolean(alert && (alert.metricBefore || alert.metricAfter));
/** «Indisponível (0) → Disponível (1)»; `—` nos lados sem leitura. */
const metricChange = (alert: IncidentAlert) =>
  `${alert.metricBefore ?? '—'} → ${alert.metricAfter ?? '—'}`;

function rootOf(input: IncidentReportInput) {
  return input.alerts.find((alert) => alert.id === input.rootAlertId) ?? input.alerts[0];
}

/** Relatório completo para a equipa: causa provável, cronologia, alertas e avisos enviados. */
export function internalIncidentReport(input: IncidentReportInput) {
  const root = rootOf(input);
  const duration = formatDuration(input.recoveredAt.getTime() - input.openedAt.getTime());
  const others = input.alerts.filter((alert) => alert.id !== root?.id);
  const timeline = input.alerts
    .flatMap((alert) => [
      { at: alert.startsAt, text: `Disparou: ${label(alert)}${where(alert)}` },
      ...(alert.resolvedAt
        ? [
            {
              at: alert.resolvedAt,
              text: `Recuperou: ${label(alert)}${where(alert)}`,
            },
          ]
        : []),
    ])
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((entry) => `- ${formatLisbonTime(entry.at)} — ${entry.text}`);
  const names = new Map(input.alerts.map((alert) => [alert.id, label(alert)]));
  const notices = input.notifications
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((notice) => {
      const who = notice.recipients.length ? notice.recipients.join(', ') : 'ninguém';
      const kind = notice.kind === 'resolved' ? 'Recuperação' : 'Alerta';
      const alert = notice.alertId ? (names.get(notice.alertId) ?? 'alerta') : 'alerta';
      return `- ${formatLisbonTime(notice.sentAt ?? notice.createdAt)} — ${kind} «${alert}» para ${who} (${NOTIFICATION_STATE[notice.state] ?? notice.state})`;
    });
  return [
    '## Relatório do incidente',
    '',
    `**Ambiente:** ${ENVIRONMENT[input.environment]}`,
    `**Início:** ${formatLisbonTime(input.openedAt)}`,
    `**Fim (recuperação):** ${formatLisbonTime(input.recoveredAt)}`,
    `**Duração:** ${duration}`,
    hasMetric(root)
      ? `**Valor medido (${label(root)}):** antes ${root.metricBefore ?? '—'} · depois ${root.metricAfter ?? '—'}`
      : '',
    '',
    '### Causa provável',
    root ? `${label(root)}${where(root)}: ${root.summary}` : 'Sem alerta associado.',
    others.length
      ? `\nOutros alertas no mesmo incidente (provável consequência):\n${others.map((alert) => `- ${label(alert)}${where(alert)}: ${alert.summary}`).join('\n')}`
      : '',
    '',
    '### Cronologia',
    ...timeline,
    '',
    '### Avisos enviados',
    ...(notices.length ? notices : ['- Nenhum aviso registado.']),
    '',
    '### Alertas',
    '| Alerta | Servidor | Criticidade | Início | Fim | Valor (antes → depois) | Disparos |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...input.alerts.map(
      (alert) =>
        `| ${label(alert)} | ${alert.labels.instance ?? '—'} | ${alert.criticality} | ${time(alert.startsAt)} | ${time(alert.resolvedAt)} | ${hasMetric(alert) ? metricChange(alert) : '—'} | ${alert.fireCount} |`,
    ),
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

/** Cabeçalho da mensagem final ao cliente: o quê, quando e quanto tempo, sem detalhes internos. */
export function clientIncidentHeader(input: IncidentReportInput) {
  const root = rootOf(input);
  const what = root ? label(root) : 'falha de serviço';
  return [
    `Detetámos e acompanhámos um incidente no ambiente de ${ENVIRONMENT[input.environment]} (${what}).`,
    '',
    `- **Início:** ${formatLisbonTime(input.openedAt)}`,
    `- **Serviço reposto:** ${formatLisbonTime(input.recoveredAt)}`,
    `- **Duração:** ${formatDuration(input.recoveredAt.getTime() - input.openedAt.getTime())}`,
    ...(hasMetric(root)
      ? [
          `- **Valor medido:** no início ${root.metricBefore ?? '—'}; depois da recuperação ${root.metricAfter ?? '—'}`,
        ]
      : []),
  ].join('\n');
}

/** Mensagem final ao cliente: cabeçalho e análise do Copilot (ou um texto padrão sem ela). */
export function clientIncidentMessage(input: IncidentReportInput, analysis: string | null) {
  const body =
    analysis?.trim() ||
    'O serviço voltou a funcionar normalmente e continuamos a acompanhar. Se notar alguma anomalia, responda a esta mensagem.';
  return `Olá,\n\n${clientIncidentHeader(input)}\n\n${body}\n\nA equipa de suporte.`;
}
