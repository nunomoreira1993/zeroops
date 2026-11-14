import { z } from 'zod';
// Só tipos de health.ts: health.ts importa este ficheiro (evita o ciclo na avaliação).
import type { HealthCriticality } from './health.js';

const criticalities = [
  'informativa',
  'preventiva',
  'critica',
  'urgente',
] as const satisfies readonly HealthCriticality[];

/**
 * Catálogo das regras de alerta do Prometheus. O ZeroOps gera os ficheiros de regras a partir
 * deste catálogo e das alterações de cada projeto (Saúde → Configuração → Regras de alerta).
 *
 * Marcadores nas expressões e resumos:
 * - `%T%`: limiar configurado; `%FOR%`: duração configurada em minutos;
 * - `%SEL%`: seletor do projeto nas regras de site (`project=""` ou `project="pizzamovil"`).
 */
export const alertRuleGroups = {
  servidor: 'Servidores',
  servicos: 'Serviços (MySQL, Redis)',
  disponibilidade: 'Disponibilidade do site',
  ibm_i: 'IBM i (DB2 e filas DTQ)',
} as const;
export type AlertRuleGroup = keyof typeof alertRuleGroups;

export interface AlertRuleThreshold {
  default: number;
  min: number;
  max: number;
  step: number;
  /** Unidade mostrada na interface (ex.: `%`, `s`, `dias`). */
  unit: string;
  /** Texto do campo (ex.: «Espaço livre abaixo de»). */
  label: string;
}

export interface AlertRuleDefinition {
  id: string;
  /** Check whose flow should handle this rule when the check has a flow association. */
  checkId?: string;
  group: AlertRuleGroup;
  title: string;
  description: string;
  /** `infra`: infraestrutura partilhada (só no site sem label); `site`: um conjunto por site. */
  scope: 'infra' | 'site';
  expr: string;
  summary: string;
  threshold?: AlertRuleThreshold;
  forMinutes: number;
  criticality: HealthCriticality;
}

const FS = 'fstype!~"tmpfs|overlay|squashfs|nfs|nfs4|cifs|smbfs|fuse.sshfs"';
const NETWORK_FS = 'fstype=~"nfs|nfs4|cifs|smbfs|fuse.sshfs"';
const DTQ = 'dtq="ULTPEDTQR2_31720"';
const dtqFailures = `(
  sum by (instance, env) (increase(zeroops_dtq_requests_total{${DTQ}}[10m]))
  - sum by (instance, env) (increase(zeroops_dtq_responses_total{${DTQ}}[10m]))
)`;
const percent = (label: string, value: number, min = 1, max = 100): AlertRuleThreshold => ({
  default: value,
  min,
  max,
  step: 1,
  unit: '%',
  label,
});
const seconds = (label: string, value: number, max = 120): AlertRuleThreshold => ({
  default: value,
  min: 0.5,
  max,
  step: 0.5,
  unit: 's',
  label,
});

export const alertRuleCatalog: readonly AlertRuleDefinition[] = [
  {
    id: 'ServicoIndisponivel',
    checkId: 'server-service',
    group: 'servidor',
    title: 'Serviço indisponível',
    description: 'Um exporter (servidor, MySQL, Redis) deixou de responder ao Prometheus.',
    scope: 'infra',
    expr: 'up{job!="http"} == 0',
    summary:
      'O exporter {{ $labels.service }} ({{ $labels.instance }}) não responde há %FOR% minutos.',
    forMinutes: 2,
    criticality: 'critica',
  },
  {
    id: 'EspacoDiscoBaixo',
    checkId: 'disk-space',
    group: 'servidor',
    title: 'Espaço em disco baixo',
    description: 'Espaço livre num disco abaixo do limiar.',
    scope: 'infra',
    expr: `node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}} * 100 < %T%`,
    summary:
      'Espaço livre em {{ $labels.mountpoint }} abaixo de %T%% ({{ printf "%.1f" $value }}%).',
    threshold: percent('Espaço livre abaixo de', 15, 1, 90),
    forMinutes: 10,
    criticality: 'preventiva',
  },
  {
    id: 'EspacoDiscoCritico',
    checkId: 'disk-space',
    group: 'servidor',
    title: 'Espaço em disco crítico',
    description: 'Espaço livre num disco quase esgotado.',
    scope: 'infra',
    expr: `node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}} * 100 < %T%`,
    summary:
      'Espaço livre em {{ $labels.mountpoint }} abaixo de %T%% ({{ printf "%.1f" $value }}%).',
    threshold: percent('Espaço livre abaixo de', 5, 1, 50),
    forMinutes: 5,
    criticality: 'critica',
  },
  {
    id: 'PartilhaRedeIndisponivel',
    checkId: 'support-storage',
    group: 'servidor',
    title: 'Partilha de rede indisponível',
    description: 'O exporter não consegue consultar uma partilha de rede montada.',
    scope: 'infra',
    expr: `node_filesystem_device_error{${NETWORK_FS}} == 1`,
    summary: 'Não é possível consultar {{ $labels.mountpoint }} há %FOR% minutos.',
    forMinutes: 5,
    criticality: 'critica',
  },
  {
    id: 'PartilhaRedeQuaseCheia',
    checkId: 'disk-space',
    group: 'servidor',
    title: 'Partilha de rede quase cheia',
    description: 'Espaço livre numa partilha externa abaixo do limiar; exclui o NFS interno.',
    scope: 'infra',
    expr: `node_filesystem_avail_bytes{${NETWORK_FS},device!~"172[.]16[.]1[.].*"} / node_filesystem_size_bytes{${NETWORK_FS},device!~"172[.]16[.]1[.].*"} * 100 < %T%`,
    summary:
      'Espaço livre na partilha {{ $labels.mountpoint }} abaixo de %T%% ({{ printf "%.1f" $value }}%).',
    threshold: percent('Espaço livre abaixo de', 15, 1, 90),
    forMinutes: 10,
    criticality: 'preventiva',
  },
  {
    id: 'InodesBaixos',
    checkId: 'inodes',
    group: 'servidor',
    title: 'Inodes livres baixos',
    description: 'Poucos inodes livres (muitos ficheiros pequenos, ex.: sessões ou cache).',
    scope: 'infra',
    expr: `node_filesystem_files_free{${FS}} / node_filesystem_files{${FS}} * 100 < %T%`,
    summary: 'Inodes livres em {{ $labels.mountpoint }} abaixo de %T%%.',
    threshold: percent('Inodes livres abaixo de', 10, 1, 90),
    forMinutes: 10,
    criticality: 'preventiva',
  },
  {
    id: 'CargaCpuElevada',
    checkId: 'cpu-memory',
    group: 'servidor',
    title: 'Carga de CPU elevada',
    description: 'Carga média (5 minutos) por core acima do limiar.',
    scope: 'infra',
    expr: 'node_load5 / on(instance) count by(instance)(node_cpu_seconds_total{mode="idle"}) > %T%',
    summary: 'Carga média (5m) por core em {{ printf "%.2f" $value }} há %FOR% minutos.',
    threshold: {
      default: 2,
      min: 0.1,
      max: 20,
      step: 0.1,
      unit: 'por core',
      label: 'Carga acima de',
    },
    forMinutes: 15,
    criticality: 'critica',
  },
  {
    id: 'MemoriaElevada',
    checkId: 'cpu-memory',
    group: 'servidor',
    title: 'Memória elevada',
    description: 'Memória em uso acima do limiar.',
    scope: 'infra',
    expr: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 > %T%',
    summary: 'Memória em uso a {{ printf "%.0f" $value }}% há %FOR% minutos.',
    threshold: percent('Memória em uso acima de', 92, 10, 100),
    forMinutes: 15,
    criticality: 'critica',
  },
  {
    id: 'MetricasProducaoAusentes',
    checkId: 'server-service',
    group: 'servidor',
    title: 'Métricas de Produção ausentes',
    description: 'O Prometheus de Produção deixou de enviar métricas (remote write).',
    scope: 'infra',
    expr: 'absent_over_time(up{env="production",job="node"}[5m])',
    summary: 'Não chegam métricas do servidor de Produção há mais de 10 minutos (remote write).',
    forMinutes: 5,
    criticality: 'preventiva',
  },
  {
    id: 'RedisIndisponivel',
    checkId: 'redis',
    group: 'servicos',
    title: 'Redis indisponível',
    description: 'O Redis não responde ao exporter.',
    scope: 'infra',
    expr: 'redis_up == 0',
    summary: 'O Redis não responde ao exporter há %FOR% minutos.',
    forMinutes: 2,
    criticality: 'critica',
  },
  {
    id: 'MysqlIndisponivel',
    checkId: 'server-service',
    group: 'servicos',
    title: 'MySQL indisponível',
    description: 'O MySQL/MariaDB não responde ao exporter.',
    scope: 'infra',
    expr: 'mysql_up == 0',
    summary: 'O MySQL/MariaDB não responde ao exporter há %FOR% minutos.',
    forMinutes: 2,
    criticality: 'critica',
  },
  {
    id: 'MysqlLigacoesElevadas',
    checkId: 'database-saturation',
    group: 'servicos',
    title: 'Ligações MySQL elevadas',
    description: 'Ligações abertas perto do máximo configurado.',
    scope: 'infra',
    expr: 'mysql_global_status_threads_connected / mysql_global_variables_max_connections * 100 > %T%',
    summary: 'Ligações MySQL a {{ printf "%.0f" $value }}% do máximo.',
    threshold: percent('Ligações acima de', 80, 10, 100),
    forMinutes: 10,
    criticality: 'preventiva',
  },
  {
    id: 'SiteIndisponivel',
    checkId: 'site-availability',
    group: 'disponibilidade',
    title: 'Site indisponível',
    description: 'O pedido HTTP externo ao site falha.',
    scope: 'site',
    expr: 'probe_success{%SEL%} == 0',
    summary: '{{ $labels.instance }} falha o pedido HTTP há %FOR% minutos.',
    forMinutes: 3,
    criticality: 'critica',
  },
  {
    id: 'RespostaLenta',
    checkId: 'response-time',
    group: 'disponibilidade',
    title: 'Resposta lenta',
    description: 'Tempo médio de resposta do site (15 minutos) acima do limiar.',
    scope: 'site',
    expr: 'avg_over_time(probe_duration_seconds{%SEL%}[15m]) > %T%',
    summary: '{{ $labels.instance }} com tempo médio de resposta de {{ printf "%.1f" $value }}s.',
    threshold: seconds('Tempo médio acima de', 3, 60),
    forMinutes: 15,
    criticality: 'preventiva',
  },
  {
    id: 'CertificadoAExpirar',
    checkId: 'site-availability',
    group: 'disponibilidade',
    title: 'Certificado a expirar',
    description: 'O certificado TLS do site expira em breve.',
    scope: 'site',
    expr: '(probe_ssl_earliest_cert_expiry{%SEL%} - time()) / 86400 < %T%',
    summary: 'O certificado de {{ $labels.instance }} expira em {{ printf "%.0f" $value }} dias.',
    threshold: { default: 14, min: 1, max: 90, step: 1, unit: 'dias', label: 'Expira em menos de' },
    forMinutes: 60,
    criticality: 'preventiva',
  },
  {
    id: 'Db2Indisponivel',
    group: 'ibm_i',
    title: 'DB2 indisponível',
    description: 'A ligação ODBC ao DB2/IBM i falha.',
    scope: 'infra',
    expr: 'zeroops_db2_up == 0',
    summary: 'A ligação ODBC ao DB2/IBM i ({{ $labels.dsn }}) falha há %FOR% minutos.',
    forMinutes: 3,
    criticality: 'critica',
  },
  {
    id: 'Db2Lento',
    group: 'ibm_i',
    title: 'DB2 lento',
    description: 'Ligação e consulta de teste ao DB2 acima do limiar.',
    scope: 'infra',
    expr: 'zeroops_db2_connect_seconds + zeroops_db2_query_seconds > %T%',
    summary: 'Ligação e consulta ao DB2 demoram {{ printf "%.1f" $value }}s há %FOR% minutos.',
    threshold: seconds('Ligação e consulta acima de', 2),
    forMinutes: 10,
    criticality: 'preventiva',
  },
  {
    id: 'Db2JobsElevados',
    group: 'ibm_i',
    title: 'Jobs do IBM i perto do máximo',
    description: 'Jobs no sistema perto do máximo permitido.',
    scope: 'infra',
    expr: 'zeroops_db2_total_jobs / zeroops_db2_maximum_jobs * 100 > %T%',
    summary: 'Jobs no sistema a {{ printf "%.0f" $value }}% do máximo permitido.',
    threshold: percent('Jobs acima de', 90, 10, 100),
    forMinutes: 15,
    criticality: 'preventiva',
  },
  {
    id: 'Db2ArmazenamentoElevado',
    group: 'ibm_i',
    title: 'Armazenamento do IBM i elevado',
    description: 'Utilização do ASP de sistema acima do limiar.',
    scope: 'infra',
    expr: 'zeroops_db2_asp_used_percent > %T%',
    summary: 'ASP de sistema a {{ printf "%.0f" $value }}% de utilização.',
    threshold: percent('Utilização acima de', 90, 10, 100),
    forMinutes: 15,
    criticality: 'preventiva',
  },
  {
    id: 'Db2MetricasAusentes',
    group: 'ibm_i',
    title: 'Métricas do DB2 ausentes',
    description: 'Produção envia métricas, mas o coletor do DB2 deixou de as publicar.',
    scope: 'infra',
    expr: 'absent_over_time(zeroops_db2_up[10m]) and on() count(up{env="production",job="node"}) > 0',
    summary:
      'O servidor de Produção envia métricas, mas não há dados do DB2 há mais de 10 minutos.',
    forMinutes: 5,
    criticality: 'preventiva',
  },
  {
    id: 'DtqClientesIndisponivel',
    checkId: 'app-api-availability',
    group: 'ibm_i',
    title: 'DTQ de clientes (login) indisponível',
    description: 'A sonda com a conta de testes falha o DTQ users (login dos clientes).',
    scope: 'infra',
    expr: 'zeroops_dtq_users_up == 0',
    summary:
      'A sonda com a conta de testes falha o DTQ users (/api/v1/dtq/users/) há %FOR% minutos.',
    forMinutes: 10,
    criticality: 'critica',
  },
  {
    id: 'DtqClientesLento',
    checkId: 'response-time',
    group: 'ibm_i',
    title: 'DTQ de clientes (login) lento',
    description: 'A sonda do DTQ users demora mais do que o limiar.',
    scope: 'infra',
    expr: 'zeroops_dtq_users_seconds > %T%',
    summary: 'A sonda do DTQ users demora {{ printf "%.1f" $value }}s.',
    threshold: seconds('Sonda acima de', 5, 60),
    forMinutes: 15,
    criticality: 'preventiva',
  },
  {
    id: 'DtqClientesTaxaFalhas',
    checkId: 'app-api-availability',
    group: 'ibm_i',
    title: 'Falhas no login dos clientes (DTQ users)',
    description:
      'Leituras do DTQ users pedidas pelo site sem resposta (normal ~0,1%), com pelo menos 10 falhas em 10 minutos.',
    scope: 'infra',
    expr: `${dtqFailures} / sum by (instance, env) (increase(zeroops_dtq_requests_total{${DTQ}}[10m])) * 100 > %T%
and
${dtqFailures} >= 10`,
    summary:
      '{{ printf "%.1f" $value }}% das leituras do DTQ users ficaram sem resposta nos últimos 10 minutos.',
    threshold: percent('Falhas acima de', 5, 1, 100),
    forMinutes: 5,
    criticality: 'critica',
  },
  {
    id: 'DtqErrosNoLog',
    checkId: 'application-errors',
    group: 'ibm_i',
    title: 'Erros no log das filas DTQ',
    description: 'Linhas [ERROR] no dtq.log do site em 10 minutos.',
    scope: 'infra',
    expr: 'increase(zeroops_dtq_log_errors_total[10m]) >= %T%',
    summary: '{{ printf "%.0f" $value }} linhas [ERROR] no dtq.log nos últimos 10 minutos.',
    threshold: {
      default: 5,
      min: 1,
      max: 10000,
      step: 1,
      unit: 'linhas',
      label: 'Erros em 10 min a partir de',
    },
    forMinutes: 5,
    criticality: 'preventiva',
  },
];

export const alertRuleById = new Map(alertRuleCatalog.map((rule) => [rule.id, rule]));

/** Sondas executadas nos servidores que podem ser suspensas por uma paragem planeada. */
export const healthProbes = [
  {
    id: 'dtq',
    title: 'Sonda do DTQ users (Produção)',
    description: 'Login com a conta de testes a cada 5 minutos; suspensa não chama o site.',
  },
] as const;

/** Alteração de uma regra no projeto; campos omitidos usam o valor do catálogo. */
export const alertRuleOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  threshold: z.number().finite().optional(),
  forMinutes: z.number().int().min(0).max(1440).optional(),
  criticality: z.enum(criticalities).optional(),
});
export type AlertRuleOverride = z.infer<typeof alertRuleOverrideSchema>;

export const alertRuleOverridesSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), alertRuleOverrideSchema)
  .superRefine((overrides, context) => {
    for (const [id, override] of Object.entries(overrides)) {
      const rule = alertRuleById.get(id);
      if (!rule) {
        context.addIssue({ code: 'custom', path: [id], message: `Regra desconhecida: ${id}.` });
        continue;
      }
      if (override.threshold === undefined) continue;
      const limits = rule.threshold;
      if (!limits)
        context.addIssue({
          code: 'custom',
          path: [id, 'threshold'],
          message: 'Esta regra não tem limiar.',
        });
      else if (override.threshold < limits.min || override.threshold > limits.max)
        context.addIssue({
          code: 'custom',
          path: [id, 'threshold'],
          message: `Use um valor entre ${limits.min} e ${limits.max}.`,
        });
    }
  });

/** Regra efetiva no projeto (catálogo + alterações). */
export interface EffectiveAlertRule extends AlertRuleDefinition {
  enabled: boolean;
  thresholdValue: number | null;
}

export function effectiveAlertRules(
  overrides: Record<string, AlertRuleOverride>,
): EffectiveAlertRule[] {
  return alertRuleCatalog.map((rule) => {
    const override = overrides[rule.id] ?? {};
    return {
      ...rule,
      enabled: override.enabled ?? true,
      thresholdValue: rule.threshold ? (override.threshold ?? rule.threshold.default) : null,
      forMinutes: override.forMinutes ?? rule.forMinutes,
      criticality: override.criticality ?? rule.criticality,
    };
  });
}

/** Estado da última geração das regras do Prometheus para o projeto. */
export interface AlertRulesSyncStatus {
  state: 'ok' | 'error' | 'disabled';
  syncedAt: string | null;
  message: string | null;
}
