import type { HealthNotificationChartContext } from '../../../../../contracts/src/index.js';

const RULE_CHARTS: Readonly<Record<string, string>> = {
  EspacoDiscoBaixo: 'disk',
  EspacoDiscoCritico: 'disk',
  PartilhaRedeIndisponivel: 'mount_errors',
  PartilhaRedeQuaseCheia: 'network_fs',
  InodesBaixos: 'inodes',
  // Carga por nucleo nao e percentagem de utilizacao de CPU.
  CargaCpuElevada: 'load',
  MemoriaElevada: 'memory',
  RedisIndisponivel: 'redis_up',
  MysqlIndisponivel: 'mysql_up',
  MysqlLigacoesElevadas: 'mysql_connections',
  SiteIndisponivel: 'site_availability',
  RespostaLenta: 'site_latency',
  CertificadoAExpirar: 'site_certificate',
  Db2Indisponivel: 'db2_up',
  Db2Lento: 'db2_latency',
  Db2JobsElevados: 'db2_jobs_pct',
  Db2ArmazenamentoElevado: 'db2_asp',
  DtqClientesIndisponivel: 'dtq_users_up',
  DtqClientesLento: 'dtq_users_latency',
  DtqClientesTaxaFalhas: 'dtq_users_failures',
  DtqErrosNoLog: 'dtq_errors',
};

/**
 * Associa um alerta Prometheus ao gráfico e à instância afetados, para que o email
 * apareça como linha amarela apenas nesse gráfico. Regras sem gráfico devolvem `targets` vazio.
 */
export function alertmanagerChartContext(
  key: string,
  labels: Readonly<Record<string, string>>,
): HealthNotificationChartContext {
  const chartId = Object.hasOwn(RULE_CHARTS, key) ? RULE_CHARTS[key] : undefined;
  const instance = labels.instance;
  const resourceLabels: Record<string, string> = {};
  for (const label of ['mountpoint', 'dsn', 'dtq', 'fstype'])
    if (labels[label]) resourceLabels[label] = labels[label];
  return {
    source: 'prometheus',
    key,
    targets: chartId && instance ? [{ chartId, instance, labels: resourceLabels }] : [],
  };
}
