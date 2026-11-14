import {
  incidentEngines,
  incidentResourceKinds,
  type IncidentEnvironmentKey,
  type IncidentPolicy,
  type IncidentResource,
} from '../../../../contracts/src/index.js';

/** Tipo de recurso pelo nome e serviço do alerta (as labels `resource_kind`/`engine` têm prioridade). */
const KIND_PATTERNS: [RegExp, string][] = [
  [/instancedown|hostdown|nodedown|reboot|uptime/, 'server'],
  [/disk|filesystem|inode|storage|volume/, 'disk'],
  [/memory|memoria|oom|swap/, 'memory'],
  [/cpu|load/, 'cpu'],
  [/mysql|mariadb|db2|database|\bdb\b|sql/, 'database'],
  [/network|latency|packet|dns|tcp|probe_success|blackbox/, 'network'],
  [/http|site|endpoint|ssl|certificate|frontend|checkout/, 'application'],
  [/systemd|service|fpm|nginx|apache|redis|worker|exporter/, 'service'],
];

const ENGINE_PATTERNS: [RegExp, string][] = [
  [/db2/, 'db2'],
  [/mariadb/, 'mariadb'],
  [/mysql/, 'mysql'],
  [/nginx/, 'nginx'],
  [/apache|httpd/, 'apache'],
  [/php|fpm/, 'php'],
  [/redis/, 'redis'],
  [/prometheus/, 'prometheus'],
  [/loki/, 'loki'],
  [/\bsvn\b|subversion/, 'svn'],
  [/\bgit\b/, 'git'],
];

const UNIT_PATTERN = /^[A-Za-z0-9@_.-]{1,100}\.service$/;

/** Host sem esquema nem porta (`db1:9100` → `db1`). */
function hostOf(labels: Record<string, string>) {
  const raw = labels.host ?? labels.hostname ?? labels.nodename ?? labels.instance ?? '';
  const host = raw.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  return host ? host.slice(0, 160) : null;
}

function unitOf(labels: Record<string, string>) {
  const unit = labels.unit ?? labels.systemd_unit ?? labels.name ?? '';
  return UNIT_PATTERN.test(unit) ? unit : null;
}

/**
 * Recurso afetado a partir do alerta. Regras novas podem declarar `resource_kind`, `engine`,
 * `unit` e `managed` nas labels; sem elas, deduz-se pelo nome do alerta e pelo serviço.
 */
export function resourceFromAlert(
  name: string,
  labels: Record<string, string>,
  environment: IncidentEnvironmentKey,
  policy: Pick<IncidentPolicy, 'unmanagedEngines'>,
): IncidentResource {
  const text =
    `${name} ${labels.service ?? ''} ${labels.job ?? ''} ${labels.component ?? ''}`.toLowerCase();
  const declaredKind = labels.resource_kind?.toLowerCase();
  const declaredEngine = labels.engine?.toLowerCase();
  const engine =
    declaredEngine && /^[a-z][a-z0-9_-]{0,30}$/.test(declaredEngine)
      ? declaredEngine
      : (ENGINE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? null);
  const kind =
    declaredKind && /^[a-z][a-z0-9_]{0,30}$/.test(declaredKind)
      ? declaredKind
      : (KIND_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ??
        (engine ? incidentEngines[engine]?.kind : undefined) ??
        'other');
  const managed =
    labels.managed === 'false' ? false : !(engine && policy.unmanagedEngines.includes(engine));
  return {
    kind: incidentResourceKinds[kind] ? kind : 'other',
    engine,
    host: hostOf(labels),
    unit: unitOf(labels),
    environment,
    managed,
  };
}

/** Linha legível: «Base de dados MySQL em db1 (mysql.service)». */
export function describeResource(resource: IncidentResource) {
  const kind = incidentResourceKinds[resource.kind]?.label.pt ?? resource.kind;
  const engine = resource.engine
    ? ` ${incidentEngines[resource.engine]?.label ?? resource.engine}`
    : '';
  const host = resource.host ? ` em ${resource.host}` : '';
  const unit = resource.unit ? ` (${resource.unit})` : '';
  const managed = resource.managed ? '' : ' — não gerido por nós (só diagnóstico)';
  return `${kind}${engine}${host}${unit}${managed}`;
}
