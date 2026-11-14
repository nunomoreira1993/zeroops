import {
  siApache,
  siGit,
  siGrafana,
  siLinux,
  siMariadb,
  siMysql,
  siNginx,
  siPhp,
  siPrometheus,
  siRedis,
  siSubversion,
  type SimpleIcon,
} from 'simple-icons';
import {
  Cpu,
  Database,
  Globe,
  HardDrive,
  Mail,
  MemoryStick,
  Network,
  Server,
  ShieldCheck,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { FlowNode } from '@zeroops/contracts';

/** Marcas locais (simple-icons, sem pedidos externos). */
const brands: Record<string, SimpleIcon> = {
  mysql: siMysql,
  mariadb: siMariadb,
  nginx: siNginx,
  apache: siApache,
  php: siPhp,
  redis: siRedis,
  linux: siLinux,
  prometheus: siPrometheus,
  grafana: siGrafana,
  loki: siGrafana,
  git: siGit,
  svn: siSubversion,
  subversion: siSubversion,
};

/** Recursos genéricos sem marca. */
const glyphs: Record<string, { icon: LucideIcon; title: string }> = {
  disk: { icon: HardDrive, title: 'Disco' },
  memory: { icon: MemoryStick, title: 'Memória' },
  cpu: { icon: Cpu, title: 'CPU' },
  network: { icon: Network, title: 'Rede' },
  database: { icon: Database, title: 'Base de dados' },
  server: { icon: Server, title: 'Servidor' },
  http: { icon: Globe, title: 'HTTP' },
  mail: { icon: Mail, title: 'E-mail' },
  policy: { icon: ShieldCheck, title: 'Política' },
  team: { icon: Users, title: 'Equipa' },
  service: { icon: Wrench, title: 'Serviço' },
};

export const techTitles: Record<string, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  db2: 'IBM DB2',
  nginx: 'Nginx',
  apache: 'Apache',
  php: 'PHP-FPM',
  redis: 'Redis',
  linux: 'Linux / systemd',
  prometheus: 'Prometheus',
  grafana: 'Grafana',
  loki: 'Loki',
  git: 'Git',
  svn: 'Subversion',
};

const criterionTechs: Record<string, string[]> = {
  disk_free: ['disk', 'prometheus'],
  memory_pressure: ['memory', 'prometheus'],
  cpu_load: ['cpu', 'prometheus'],
  database_query: ['mysql', 'db2'],
  service_active: ['linux'],
  http_check: ['http'],
  alerts_resolved: ['prometheus'],
  auto: ['prometheus', 'mysql', 'db2', 'http'],
};

const actionTechs: Record<string, string[]> = {
  incident_intake: ['prometheus', 'grafana'],
  authorize_intervention: ['policy'],
  remediate: ['linux'],
  email_notify: ['mail'],
  assign_team: ['team'],
  deploy: ['svn', 'git'],
  health_remediation: ['git', 'svn'],
  verify_health_recovery: ['prometheus'],
};

/** Tecnologias mostradas numa etapa: `config.engines` ou a omissão da ação. */
export function nodeTechs(node: Pick<FlowNode, 'op' | 'config'>): string[] {
  const configured = node.config.engines;
  if (Array.isArray(configured))
    return configured.filter((item): item is string => typeof item === 'string').slice(0, 6);
  if (node.op !== 'action') return [];
  const action = typeof node.config.action === 'string' ? node.config.action : '';
  if (action === 'validate_recovery') {
    const criterion = typeof node.config.criterion === 'string' ? node.config.criterion : 'auto';
    return criterionTechs[criterion] ?? criterionTechs.auto!;
  }
  return actionTechs[action] ?? [];
}

/** Logótipo de uma tecnologia ou recurso; desconhecidos caem num glifo genérico. */
export function TechLogo({ id, size = 16 }: { id: string; size?: number }) {
  const brand = brands[id];
  const title = techTitles[id] ?? glyphs[id]?.title ?? id;
  if (brand)
    return (
      <svg
        className="tech-logo"
        role="img"
        aria-label={title}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={`#${brand.hex}`}
      >
        <title>{title}</title>
        <path d={brand.path} />
      </svg>
    );
  if (id === 'db2')
    return (
      <span className="tech-logo tech-logo-text" role="img" aria-label={title} title={title}>
        DB2
      </span>
    );
  const Glyph = glyphs[id]?.icon ?? Server;
  return (
    <span className="tech-logo" role="img" aria-label={title} title={title}>
      <Glyph size={size} aria-hidden="true" />
    </span>
  );
}

export function TechLogos({ ids, size }: { ids: string[]; size?: number }) {
  if (ids.length === 0) return null;
  return (
    <span className="tech-logos">
      {ids.map((id) => (
        <TechLogo key={id} id={id} size={size} />
      ))}
    </span>
  );
}
