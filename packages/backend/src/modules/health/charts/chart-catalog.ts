import type {
  HealthChartPanel,
  HealthChartUnit,
  HealthRollupMetric,
} from '../../../../../contracts/src/index.js';

/**
 * Uma série do gráfico. `$w` é substituído pela janela de cálculo (pelo menos 2 minutos, ou o
 * step do intervalo); `legend` usa `{{label}}` das labels devolvidas. Os matchers do ambiente
 * (`env="production"`) e o filtro de servidor são acrescentados pelo conector a cada seletor.
 */
export interface ChartQuery {
  expr: string;
  legend: string;
  /** Legenda em inglês, quando `legend` tem termos fixos em português. */
  legendEn?: string;
  /** Agregado horário guardado (intervalo de 13 meses e mapa de calor). */
  rollup?: HealthRollupMetric;
}

export interface ChartDefinition {
  id: string;
  title: string;
  titleEn: string;
  /** Categoria dentro do separador (secção com cabeçalho na página). */
  group: string;
  groupEn: string;
  description: string;
  descriptionEn: string;
  unit: HealthChartUnit;
  gauge?: boolean;
  warn?: number;
  crit?: number;
  /** Limites só do mapa de calor, quando diferem de `warn`/`crit` (ou estes não se aplicam). */
  heatmap?: { warn: number; crit: number; higherIsBetter?: boolean };
  queries: ChartQuery[];
}

export interface PanelDefinition {
  /** O filtro de servidor não se aplica (ex.: sondas HTTP, em que `instance` é o URL). */
  ignoresInstance?: boolean;
  charts: ChartDefinition[];
}

/**
 * Discos locais. As partilhas de rede ficam de fora: no 21-web o NFS da pasta `log` mostra o
 * disco do backend e tapava a partição local; têm gráfico próprio.
 */
const FS = 'fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs|devtmpfs|nfs|nfs4|cifs|smbfs|fuse.sshfs"';
const NETWORK_FS = 'fstype=~"nfs|nfs4|cifs|smbfs|fuse.sshfs"';
/** Montagens reais (locais e de rede), para erros e modo só de leitura. */
const MOUNTED_FS = 'fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs|devtmpfs|iso9660"';

export const CHART_PANELS: Record<HealthChartPanel, PanelDefinition> = {
  servers: {
    charts: [
      {
        id: 'cpu',
        title: 'CPU',
        titleEn: 'CPU',
        group: 'Utilização',
        groupEn: 'Utilisation',
        description: 'Utilização média de todos os núcleos.',
        descriptionEn: 'Average utilisation across all cores.',
        unit: 'percent',
        gauge: true,
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: '100 * (1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[$w])))',
            legend: '{{instance}}',
            rollup: 'cpu',
          },
        ],
      },
      {
        id: 'memory',
        title: 'Memória (RAM)',
        titleEn: 'Memory (RAM)',
        group: 'Utilização',
        groupEn: 'Utilisation',
        description: 'Memória em uso (exclui cache e buffers recuperáveis).',
        descriptionEn: 'Memory in use (excludes reclaimable cache and buffers).',
        unit: 'percent',
        gauge: true,
        warn: 85,
        crit: 95,
        queries: [
          {
            expr: '100 * (1 - max by(instance)(node_memory_MemAvailable_bytes) / max by(instance)(node_memory_MemTotal_bytes))',
            legend: '{{instance}}',
            rollup: 'memory',
          },
        ],
      },
      {
        id: 'swap',
        title: 'Swap',
        titleEn: 'Swap',
        group: 'Utilização',
        groupEn: 'Utilisation',
        description:
          'Swap em uso. Crescer de forma contínua indica falta de RAM (a máquina fica lenta antes de falhar).',
        descriptionEn:
          'Swap in use. Continuous growth indicates a lack of RAM (the machine slows down before it fails).',
        unit: 'percent',
        warn: 50,
        crit: 80,
        queries: [
          {
            expr: '100 * (1 - max by(instance)(node_memory_SwapFree_bytes) / max by(instance)(node_memory_SwapTotal_bytes > 0))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'disk',
        title: 'Disco',
        titleEn: 'Disk',
        group: 'Armazenamento',
        groupEn: 'Storage',
        description: 'Ocupação da partição local mais cheia de cada servidor (sem partilhas NFS).',
        descriptionEn:
          'Usage of the fullest local partition on each server (excluding NFS shares).',
        unit: 'percent',
        gauge: true,
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: `max by(instance)(100 * (1 - node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}}))`,
            legend: '{{instance}}',
            rollup: 'disk',
          },
        ],
      },
      {
        id: 'inodes',
        title: 'Inodes',
        titleEn: 'Inodes',
        group: 'Armazenamento',
        groupEn: 'Storage',
        description: 'Ocupação de inodes da partição mais cheia.',
        descriptionEn: 'Inode usage of the fullest partition.',
        unit: 'percent',
        gauge: true,
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: `max by(instance)(100 * (1 - node_filesystem_files_free{${FS}} / node_filesystem_files{${FS}}))`,
            legend: '{{instance}}',
            rollup: 'inodes',
          },
        ],
      },
      {
        id: 'load',
        title: 'Carga por núcleo',
        titleEn: 'Load per core',
        group: 'Utilização',
        groupEn: 'Utilisation',
        description: 'Load average a 5 minutos dividido pelo número de núcleos (1 = saturado).',
        descriptionEn: '5-minute load average divided by the number of cores (1 = saturated).',
        unit: 'count',
        warn: 1,
        crit: 2,
        queries: [
          {
            expr: 'max by(instance)(node_load5) / count by(instance)(node_cpu_seconds_total{mode="idle"})',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'disk_io',
        title: 'Disco ocupado (I/O)',
        titleEn: 'Disk busy (I/O)',
        group: 'Armazenamento',
        groupEn: 'Storage',
        description: 'Tempo em que o disco mais ocupado esteve a processar pedidos.',
        descriptionEn: 'Time the busiest disk spent processing requests.',
        unit: 'percent',
        queries: [
          {
            expr: '100 * max by(instance)(rate(node_disk_io_time_seconds_total[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'disk_throughput',
        title: 'Leituras e escritas em disco',
        titleEn: 'Disk reads and writes',
        group: 'Armazenamento',
        groupEn: 'Storage',
        description: 'Débito de leitura e escrita somado de todos os discos.',
        descriptionEn: 'Read and write throughput summed across all disks.',
        unit: 'bytes_per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(node_disk_read_bytes_total[$w]))',
            legend: '{{instance}} · leitura',
            legendEn: '{{instance}} · read',
          },
          {
            expr: 'sum by(instance)(rate(node_disk_written_bytes_total[$w]))',
            legend: '{{instance}} · escrita',
            legendEn: '{{instance}} · write',
          },
        ],
      },
      {
        id: 'network_fs',
        title: 'Partilhas de rede (NFS)',
        titleEn: 'Network shares (NFS)',
        group: 'Armazenamento',
        groupEn: 'Storage',
        description:
          'Ocupação de cada partilha montada. O espaço é o do servidor de origem (ex.: a pasta log do 21-web está no disco do backend).',
        descriptionEn:
          'Usage of each mounted share. The space belongs to the source server (e.g. the 21-web log folder lives on the backend disk).',
        unit: 'percent',
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: `max by(instance, mountpoint)(100 * (1 - node_filesystem_avail_bytes{${NETWORK_FS}} / node_filesystem_size_bytes{${NETWORK_FS}}))`,
            legend: '{{instance}} · {{mountpoint}}',
          },
        ],
      },
      {
        id: 'mount_errors',
        title: 'Erros de montagem',
        titleEn: 'Mount errors',
        group: 'Armazenamento',
        groupEn: 'Storage',
        description:
          'Montagens que o sistema não consegue ler (ex.: NFS pendurado) ou que passaram a só de leitura.',
        descriptionEn: 'Mounts the system cannot read (e.g. a hung NFS) or that became read-only.',
        unit: 'count',
        queries: [
          {
            expr: `sum by(instance)(node_filesystem_device_error{${MOUNTED_FS}})`,
            legend: '{{instance}} · com erro',
            legendEn: '{{instance}} · with error',
          },
          {
            expr: `sum by(instance)(node_filesystem_readonly{${MOUNTED_FS}})`,
            legend: '{{instance}} · só de leitura',
            legendEn: '{{instance}} · read-only',
          },
        ],
      },
      {
        id: 'network',
        title: 'Rede',
        titleEn: 'Network',
        group: 'Rede',
        groupEn: 'Network',
        description: 'Tráfego recebido e enviado.',
        descriptionEn: 'Traffic received and sent.',
        unit: 'bytes_per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(node_network_receive_bytes_total[$w]))',
            legend: '{{instance}} · recebido',
            legendEn: '{{instance}} · received',
          },
          {
            expr: 'sum by(instance)(rate(node_network_transmit_bytes_total[$w]))',
            legend: '{{instance}} · enviado',
            legendEn: '{{instance}} · sent',
          },
        ],
      },
      {
        id: 'tcp_connections',
        title: 'Ligações TCP',
        titleEn: 'TCP connections',
        group: 'Rede',
        groupEn: 'Network',
        description:
          'Ligações estabelecidas e em TIME_WAIT. Muitas em TIME_WAIT indicam ligações curtas em excesso (ex.: sem keep-alive).',
        descriptionEn:
          'Established and TIME_WAIT connections. Many in TIME_WAIT indicate too many short-lived connections (e.g. no keep-alive).',
        unit: 'count',
        queries: [
          {
            expr: 'max by(instance)(node_netstat_Tcp_CurrEstab)',
            legend: '{{instance}} · estabelecidas',
            legendEn: '{{instance}} · established',
          },
          {
            expr: 'max by(instance)(node_sockstat_TCP_tw)',
            legend: '{{instance}} · TIME_WAIT',
          },
        ],
      },
      {
        id: 'network_errors',
        title: 'Erros de rede',
        titleEn: 'Network errors',
        group: 'Rede',
        groupEn: 'Network',
        description:
          'Pacotes com erro ou descartados nas interfaces e retransmissões TCP, por minuto. Devem estar perto de zero.',
        descriptionEn:
          'Packets with errors or dropped on the interfaces and TCP retransmissions, per minute. Should be close to zero.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(node_network_receive_errs_total[$w]) + rate(node_network_transmit_errs_total[$w]))',
            legend: '{{instance}} · erros',
            legendEn: '{{instance}} · errors',
          },
          {
            expr: '60 * sum by(instance)(rate(node_network_receive_drop_total[$w]) + rate(node_network_transmit_drop_total[$w]))',
            legend: '{{instance}} · descartados',
            legendEn: '{{instance}} · dropped',
          },
          {
            expr: '60 * sum by(instance)(rate(node_netstat_Tcp_RetransSegs[$w]))',
            legend: '{{instance}} · retransmissões TCP',
            legendEn: '{{instance}} · TCP retransmissions',
          },
        ],
      },
    ],
  },
  web: {
    charts: [
      {
        id: 'apache_busy',
        title: 'Workers Apache ocupados',
        titleEn: 'Busy Apache workers',
        group: 'Apache',
        groupEn: 'Apache',
        description: 'Workers a responder face à capacidade (MaxRequestWorkers).',
        descriptionEn: 'Workers serving requests relative to capacity (MaxRequestWorkers).',
        unit: 'percent',
        gauge: true,
        warn: 70,
        crit: 90,
        queries: [
          {
            expr: '100 * max by(instance)(zeroops_apache_workers{state="busy"}) / max by(instance)(zeroops_apache_workers_capacity)',
            legend: '{{instance}}',
            rollup: 'apache_busy',
          },
        ],
      },
      {
        id: 'apache_workers',
        title: 'Workers Apache',
        titleEn: 'Apache workers',
        group: 'Apache',
        groupEn: 'Apache',
        description: 'Workers ocupados e livres.',
        descriptionEn: 'Busy and idle workers.',
        unit: 'count',
        queries: [
          {
            expr: 'max by(instance, state)(zeroops_apache_workers)',
            legend: '{{instance}} · {{state}}',
          },
        ],
      },
      {
        id: 'apache_requests',
        title: 'Pedidos Apache',
        titleEn: 'Apache requests',
        group: 'Apache',
        groupEn: 'Apache',
        description: 'Pedidos HTTP servidos por segundo.',
        descriptionEn: 'HTTP requests served per second.',
        unit: 'per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(zeroops_apache_accesses_total[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'fpm_busy',
        title: 'PHP-FPM ocupado',
        titleEn: 'PHP-FPM busy',
        group: 'PHP-FPM',
        groupEn: 'PHP-FPM',
        description:
          'Processos ativos face a pm.max_children, nos pools PHP usados pelo site (8.5).',
        descriptionEn:
          'Active processes relative to pm.max_children, in the PHP pools used by the site (8.5).',
        unit: 'percent',
        gauge: true,
        warn: 70,
        crit: 90,
        queries: [
          {
            expr: '100 * sum by(instance, version)(zeroops_phpfpm_processes{state="active"}) / sum by(instance, version)(zeroops_phpfpm_max_children)',
            legend: '{{instance}} · PHP {{version}}',
            rollup: 'fpm_busy',
          },
        ],
      },
      {
        id: 'fpm_processes',
        title: 'Processos PHP-FPM',
        titleEn: 'PHP-FPM processes',
        group: 'PHP-FPM',
        groupEn: 'PHP-FPM',
        description: 'Processos ativos e livres por versão de PHP.',
        descriptionEn: 'Active and idle processes per PHP version.',
        unit: 'count',
        queries: [
          {
            expr: 'sum by(instance, version, state)(zeroops_phpfpm_processes)',
            legend: '{{instance}} · PHP {{version}} · {{state}}',
          },
        ],
      },
      {
        id: 'fpm_queue',
        title: 'Fila PHP-FPM',
        titleEn: 'PHP-FPM queue',
        group: 'PHP-FPM',
        groupEn: 'PHP-FPM',
        description: 'Pedidos à espera de processo livre e vezes que se atingiu pm.max_children.',
        descriptionEn: 'Requests waiting for a free process and times pm.max_children was reached.',
        unit: 'count',
        warn: 1,
        queries: [
          {
            expr: 'max by(instance, version)(zeroops_phpfpm_listen_queue)',
            legend: '{{instance}} · PHP {{version}} · fila',
            legendEn: '{{instance}} · PHP {{version}} · queue',
          },
          {
            expr: 'sum by(instance, version)(increase(zeroops_phpfpm_max_children_reached_total[$w]))',
            legend: '{{instance}} · PHP {{version}} · limite atingido',
            legendEn: '{{instance}} · PHP {{version}} · limit reached',
          },
        ],
      },
      {
        id: 'nginx',
        title: 'Ligações nginx',
        titleEn: 'nginx connections',
        group: 'nginx',
        groupEn: 'nginx',
        description: 'Ligações ativas no nginx (servidor de estáticos).',
        descriptionEn: 'Active connections in nginx (static file server).',
        unit: 'count',
        queries: [
          {
            expr: 'max by(instance)(zeroops_nginx_connections_active)',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'nginx_requests',
        title: 'Pedidos nginx',
        titleEn: 'nginx requests',
        group: 'nginx',
        groupEn: 'nginx',
        description: 'Pedidos servidos por segundo (ficheiros estáticos e proxy).',
        descriptionEn: 'Requests served per second (static files and proxy).',
        unit: 'per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(zeroops_nginx_requests_total[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
    ],
  },
  mysql: {
    charts: [
      {
        id: 'mysql_up',
        title: 'Disponibilidade MySQL',
        titleEn: 'MySQL availability',
        group: 'Disponibilidade e resposta',
        groupEn: 'Availability and response',
        description: 'Percentagem do tempo em que o MySQL respondeu ao exporter.',
        descriptionEn: 'Percentage of time MySQL responded to the exporter.',
        unit: 'percent',
        gauge: true,
        queries: [
          {
            expr: '100 * avg by(instance)(avg_over_time(mysql_up[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'mysql_connections',
        title: 'Ligações em uso',
        titleEn: 'Connections in use',
        group: 'Ligações e threads',
        groupEn: 'Connections and threads',
        description: 'Ligações abertas face a max_connections.',
        descriptionEn: 'Open connections relative to max_connections.',
        unit: 'percent',
        gauge: true,
        warn: 70,
        crit: 90,
        queries: [
          {
            expr: '100 * max by(instance)(mysql_global_status_threads_connected) / max by(instance)(mysql_global_variables_max_connections)',
            legend: '{{instance}}',
            rollup: 'mysql_connections',
          },
        ],
      },
      {
        id: 'mysql_ping',
        title: 'Tempo de resposta',
        titleEn: 'Response time',
        group: 'Disponibilidade e resposta',
        groupEn: 'Availability and response',
        description: 'Duração de um SELECT 1 (pior valor no período).',
        descriptionEn: 'Duration of a SELECT 1 (worst value in the period).',
        unit: 'seconds',
        warn: 0.5,
        crit: 2,
        queries: [
          {
            expr: 'max by(instance)(max_over_time(zeroops_mysql_ping_seconds[$w]))',
            legend: '{{instance}}',
            rollup: 'mysql_ping',
          },
        ],
      },
      {
        id: 'mysql_threads',
        title: 'Threads',
        titleEn: 'Threads',
        group: 'Ligações e threads',
        groupEn: 'Connections and threads',
        description: 'Ligações abertas e threads a executar queries.',
        descriptionEn: 'Open connections and threads running queries.',
        unit: 'count',
        queries: [
          {
            expr: 'max by(instance)(mysql_global_status_threads_connected)',
            legend: '{{instance}} · ligadas',
            legendEn: '{{instance}} · connected',
          },
          {
            expr: 'max by(instance)(mysql_global_status_threads_running)',
            legend: '{{instance}} · a correr',
            legendEn: '{{instance}} · running',
          },
        ],
      },
      {
        id: 'mysql_slow',
        title: 'Queries lentas',
        titleEn: 'Slow queries',
        group: 'Carga e queries',
        groupEn: 'Load and queries',
        description: 'Queries acima de long_query_time, por minuto.',
        descriptionEn: 'Queries above long_query_time, per minute.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(mysql_global_status_slow_queries[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'mysql_questions',
        title: 'Queries por segundo',
        titleEn: 'Queries per second',
        group: 'Carga e queries',
        groupEn: 'Load and queries',
        description: 'Comandos recebidos pelo servidor.',
        descriptionEn: 'Commands received by the server.',
        unit: 'per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(mysql_global_status_questions[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'mysql_buffer_hit',
        title: 'Hit ratio do buffer pool',
        titleEn: 'Buffer pool hit ratio',
        group: 'Carga e queries',
        groupEn: 'Load and queries',
        description: 'Percentagem de leituras InnoDB servidas da memória, sem ir ao disco.',
        descriptionEn: 'Percentage of InnoDB reads served from memory, without going to disk.',
        unit: 'percent',
        queries: [
          {
            expr: '100 * (1 - sum by(instance)(rate(mysql_global_status_innodb_buffer_pool_reads[$w])) / sum by(instance)(rate(mysql_global_status_innodb_buffer_pool_read_requests[$w])))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'mysql_size',
        title: 'Tamanho por schema',
        titleEn: 'Size per schema',
        group: 'Capacidade',
        groupEn: 'Capacity',
        description: 'Dados e índices de cada schema (atualizado a cada 15 minutos).',
        descriptionEn: 'Data and indexes of each schema (updated every 15 minutes).',
        unit: 'bytes',
        queries: [
          {
            expr: 'max by(instance, schema)(zeroops_mysql_schema_data_bytes + zeroops_mysql_schema_index_bytes)',
            legend: '{{schema}}',
          },
        ],
      },
      {
        id: 'mysql_tmp_disk',
        title: 'Tabelas temporárias em disco',
        titleEn: 'Temporary tables on disk',
        group: 'Capacidade',
        groupEn: 'Capacity',
        description:
          'Tabelas temporárias que não couberam em memória (tmp_table_size), por minuto. Muitas tornam queries lentas.',
        descriptionEn:
          'Temporary tables that did not fit in memory (tmp_table_size), per minute. Many of them slow queries down.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(mysql_global_status_created_tmp_disk_tables[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'mysql_traffic',
        title: 'Tráfego MySQL',
        titleEn: 'MySQL traffic',
        group: 'Capacidade',
        groupEn: 'Capacity',
        description: 'Dados recebidos e enviados pelo servidor MySQL.',
        descriptionEn: 'Data received and sent by the MySQL server.',
        unit: 'bytes_per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(mysql_global_status_bytes_received[$w]))',
            legend: '{{instance}} · recebido',
            legendEn: '{{instance}} · received',
          },
          {
            expr: 'sum by(instance)(rate(mysql_global_status_bytes_sent[$w]))',
            legend: '{{instance}} · enviado',
            legendEn: '{{instance}} · sent',
          },
        ],
      },
      {
        id: 'mysql_locks',
        title: 'Esperas por locks',
        titleEn: 'Lock waits',
        group: 'Carga e queries',
        groupEn: 'Load and queries',
        description: 'Vezes por minuto que uma query InnoDB esperou por um lock de linha.',
        descriptionEn: 'Times per minute an InnoDB query waited for a row lock.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(mysql_global_status_innodb_row_lock_waits[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'mysql_aborted',
        title: 'Ligações falhadas',
        titleEn: 'Failed connections',
        group: 'Ligações e threads',
        groupEn: 'Connections and threads',
        description:
          'Ligações recusadas (ex.: password errada, max_connections) e clientes que caíram sem fechar, por minuto.',
        descriptionEn:
          'Refused connections (e.g. wrong password, max_connections) and clients that dropped without closing, per minute.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(mysql_global_status_aborted_connects[$w]))',
            legend: '{{instance}} · recusadas',
            legendEn: '{{instance}} · refused',
          },
          {
            expr: '60 * sum by(instance)(rate(mysql_global_status_aborted_clients[$w]))',
            legend: '{{instance}} · interrompidas',
            legendEn: '{{instance}} · aborted',
          },
        ],
      },
    ],
  },
  redis: {
    charts: [
      {
        id: 'redis_up',
        title: 'Disponibilidade Redis',
        titleEn: 'Redis availability',
        group: 'Disponibilidade e desempenho',
        groupEn: 'Availability and performance',
        description: 'Percentagem do tempo em que o Redis respondeu.',
        descriptionEn: 'Percentage of time Redis responded.',
        unit: 'percent',
        gauge: true,
        queries: [
          {
            expr: '100 * avg by(instance)(avg_over_time(redis_up[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'redis_memory',
        title: 'Memória Redis',
        titleEn: 'Redis memory',
        group: 'Memória e chaves',
        groupEn: 'Memory and keys',
        description: 'Memória usada pelo Redis.',
        descriptionEn: 'Memory used by Redis.',
        unit: 'bytes',
        queries: [
          {
            expr: 'max by(instance)(redis_memory_used_bytes)',
            legend: '{{instance}}',
            rollup: 'redis_memory',
          },
        ],
      },
      {
        id: 'redis_hit',
        title: 'Hit ratio da cache',
        titleEn: 'Cache hit ratio',
        group: 'Disponibilidade e desempenho',
        groupEn: 'Availability and performance',
        description:
          'Percentagem de leituras em que a chave existia na cache (hits face a misses).',
        descriptionEn:
          'Percentage of reads where the key was in the cache (hits relative to misses).',
        unit: 'percent',
        gauge: true,
        queries: [
          {
            expr: '100 * sum by(instance)(rate(redis_keyspace_hits_total[$w])) / (sum by(instance)(rate(redis_keyspace_hits_total[$w])) + sum by(instance)(rate(redis_keyspace_misses_total[$w])))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'redis_clients',
        title: 'Clientes ligados',
        titleEn: 'Connected clients',
        group: 'Disponibilidade e desempenho',
        groupEn: 'Availability and performance',
        description: 'Ligações abertas e bloqueadas.',
        descriptionEn: 'Open and blocked connections.',
        unit: 'count',
        queries: [
          {
            expr: 'max by(instance)(redis_connected_clients)',
            legend: '{{instance}} · ligados',
            legendEn: '{{instance}} · connected',
          },
          {
            expr: 'max by(instance)(redis_blocked_clients)',
            legend: '{{instance}} · bloqueados',
            legendEn: '{{instance}} · blocked',
          },
        ],
      },
      {
        id: 'redis_commands',
        title: 'Comandos por segundo',
        titleEn: 'Commands per second',
        group: 'Disponibilidade e desempenho',
        groupEn: 'Availability and performance',
        description: 'Comandos processados.',
        descriptionEn: 'Commands processed.',
        unit: 'per_second',
        queries: [
          {
            expr: 'sum by(instance)(rate(redis_commands_processed_total[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'redis_keys',
        title: 'Chaves',
        titleEn: 'Keys',
        group: 'Memória e chaves',
        groupEn: 'Memory and keys',
        description: 'Chaves guardadas no Redis.',
        descriptionEn: 'Keys stored in Redis.',
        unit: 'count',
        queries: [{ expr: 'sum by(instance)(redis_db_keys)', legend: '{{instance}}' }],
      },
      {
        id: 'redis_evicted',
        title: 'Evictions de chaves',
        titleEn: 'Key evictions',
        group: 'Memória e chaves',
        groupEn: 'Memory and keys',
        description: 'Chaves removidas pelo Redis por falta de memória, por minuto.',
        descriptionEn: 'Keys removed by Redis due to lack of memory, per minute.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(redis_evicted_keys_total[$w]))',
            legend: '{{instance}}',
          },
        ],
      },
    ],
  },
  db2: {
    charts: [
      {
        id: 'db2_cpu',
        title: 'CPU IBM i',
        titleEn: 'IBM i CPU',
        group: 'Recursos do IBM i',
        groupEn: 'IBM i resources',
        description: 'CPU usada no sistema IBM i (QSYS2.SYSTEM_STATUS_INFO).',
        descriptionEn: 'CPU used on the IBM i system (QSYS2.SYSTEM_STATUS_INFO).',
        unit: 'percent',
        gauge: true,
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: 'max by(instance)(zeroops_db2_cpu_used_percent)',
            legend: 'IBM i',
            rollup: 'db2_cpu',
          },
        ],
      },
      {
        id: 'db2_asp',
        title: 'Armazenamento (ASP)',
        titleEn: 'Storage (ASP)',
        group: 'Recursos do IBM i',
        groupEn: 'IBM i resources',
        description: 'Ocupação do ASP de sistema.',
        descriptionEn: 'Usage of the system ASP.',
        unit: 'percent',
        gauge: true,
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: 'max by(instance)(zeroops_db2_asp_used_percent)',
            legend: 'IBM i',
            rollup: 'db2_asp',
          },
        ],
      },
      {
        id: 'db2_up',
        title: 'Disponibilidade DB2',
        titleEn: 'DB2 availability',
        group: 'Disponibilidade e resposta',
        groupEn: 'Availability and response',
        description: 'Percentagem do tempo em que a ligação ODBC funcionou.',
        descriptionEn: 'Percentage of time the ODBC connection worked.',
        unit: 'percent',
        gauge: true,
        queries: [
          {
            expr: '100 * max by(instance)(avg_over_time(zeroops_db2_up[$w]))',
            legend: 'IBM i',
          },
        ],
      },
      {
        id: 'db2_latency',
        title: 'Tempo de resposta DB2',
        titleEn: 'DB2 response time',
        group: 'Disponibilidade e resposta',
        groupEn: 'Availability and response',
        description: 'Tempo de ligação ODBC e de uma query simples.',
        descriptionEn: 'ODBC connection time and simple query time.',
        unit: 'seconds',
        warn: 1,
        crit: 5,
        queries: [
          {
            expr: 'max by(instance)(max_over_time(zeroops_db2_connect_seconds[$w]))',
            legend: 'ligação',
            legendEn: 'connection',
          },
          {
            expr: 'max by(instance)(max_over_time(zeroops_db2_query_seconds[$w]))',
            legend: 'query',
          },
        ],
      },
      {
        id: 'db2_jobs',
        title: 'Jobs IBM i',
        titleEn: 'IBM i jobs',
        group: 'Jobs e threads',
        groupEn: 'Jobs and threads',
        description: 'Jobs ativos e total de jobs no sistema.',
        descriptionEn: 'Active jobs and total jobs on the system.',
        unit: 'count',
        queries: [
          {
            expr: 'max by(instance)(zeroops_db2_active_jobs)',
            legend: 'ativos',
            legendEn: 'active',
          },
          { expr: 'max by(instance)(zeroops_db2_total_jobs)', legend: 'total' },
        ],
      },
      {
        id: 'db2_jobs_pct',
        title: 'Jobs face ao máximo',
        titleEn: 'Jobs relative to maximum',
        group: 'Jobs e threads',
        groupEn: 'Jobs and threads',
        description: 'Total de jobs face ao máximo permitido pelo sistema.',
        descriptionEn: 'Total jobs relative to the maximum allowed by the system.',
        unit: 'percent',
        warn: 80,
        crit: 90,
        queries: [
          {
            expr: '100 * max by(instance)(zeroops_db2_total_jobs) / max by(instance)(zeroops_db2_maximum_jobs)',
            legend: 'IBM i',
          },
        ],
      },
      {
        id: 'db2_threads',
        title: 'Threads ativas',
        titleEn: 'Active threads',
        group: 'Jobs e threads',
        groupEn: 'Jobs and threads',
        description: 'Threads ativas no IBM i.',
        descriptionEn: 'Active threads on the IBM i.',
        unit: 'count',
        queries: [{ expr: 'max by(instance)(zeroops_db2_active_threads)', legend: 'IBM i' }],
      },
      {
        id: 'dtq_users_up',
        title: 'Disponibilidade DTQ clientes',
        titleEn: 'Customer DTQ availability',
        group: 'Filas DTQ (login dos clientes)',
        groupEn: 'DTQ queues (customer login)',
        description:
          'Percentagem do tempo em que a sonda com a conta de testes (GET /api/v1/dtq/users/, a cada 5 min) teve resposta.',
        descriptionEn:
          'Percentage of time the probe with the test account (GET /api/v1/dtq/users/, every 5 min) got a response.',
        unit: 'percent',
        gauge: true,
        queries: [
          {
            expr: '100 * max by(instance)(avg_over_time(zeroops_dtq_users_up[$w]))',
            legend: 'sonda',
            legendEn: 'probe',
          },
        ],
      },
      {
        id: 'dtq_users_latency',
        title: 'Tempo da sonda DTQ clientes',
        titleEn: 'Customer DTQ probe time',
        group: 'Filas DTQ (login dos clientes)',
        groupEn: 'DTQ queues (customer login)',
        description: 'Duração do pedido DTQ users da conta de testes (Apache, PHP-FPM e DB2).',
        descriptionEn:
          'Duration of the DTQ users request for the test account (Apache, PHP-FPM and DB2).',
        unit: 'seconds',
        warn: 2,
        crit: 5,
        queries: [
          {
            expr: 'max by(instance)(max_over_time(zeroops_dtq_users_seconds[$w]))',
            legend: 'sonda',
            legendEn: 'probe',
          },
        ],
      },
      {
        id: 'dtq_users_traffic',
        title: 'Leituras DTQ clientes',
        titleEn: 'Customer DTQ reads',
        group: 'Filas DTQ (login dos clientes)',
        groupEn: 'DTQ queues (customer login)',
        description:
          'Leituras ULTPEDTQR2 pedidas pelo site e respondidas com dados, por minuto (dtq.log).',
        descriptionEn:
          'ULTPEDTQR2 reads requested by the site and answered with data, per minute (dtq.log).',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(zeroops_dtq_requests_total{dtq="ULTPEDTQR2_31720"}[$w]))',
            legend: 'pedidas',
            legendEn: 'requested',
          },
          {
            expr: '60 * sum by(instance)(rate(zeroops_dtq_responses_total{dtq="ULTPEDTQR2_31720"}[$w]))',
            legend: 'com resposta',
            legendEn: 'answered',
          },
        ],
      },
      {
        id: 'dtq_users_failures',
        title: 'Falhas DTQ clientes',
        titleEn: 'Customer DTQ failures',
        group: 'Filas DTQ (login dos clientes)',
        groupEn: 'DTQ queues (customer login)',
        description:
          'Percentagem de leituras do DTQ users sem resposta (falhas reais no login). Normal: cerca de 0,1%.',
        descriptionEn:
          'Percentage of DTQ users reads without a response (real login failures). Normal: about 0.1%.',
        unit: 'percent',
        warn: 2,
        crit: 5,
        queries: [
          {
            expr:
              '100 * clamp_min(sum by(instance)(increase(zeroops_dtq_requests_total{dtq="ULTPEDTQR2_31720"}[$w]))' +
              ' - sum by(instance)(increase(zeroops_dtq_responses_total{dtq="ULTPEDTQR2_31720"}[$w])), 0)' +
              ' / sum by(instance)(increase(zeroops_dtq_requests_total{dtq="ULTPEDTQR2_31720"}[$w]))',
            legend: 'falhas',
            legendEn: 'failures',
          },
        ],
      },
      {
        id: 'dtq_errors',
        title: 'Erros no log DTQ',
        titleEn: 'DTQ log errors',
        group: 'Filas DTQ (login dos clientes)',
        groupEn: 'DTQ queues (customer login)',
        description: 'Linhas [ERROR] no dtq.log do site, por minuto.',
        descriptionEn: '[ERROR] lines in the site dtq.log, per minute.',
        unit: 'per_minute',
        queries: [
          {
            expr: '60 * sum by(instance)(rate(zeroops_dtq_log_errors_total[$w]))',
            legend: 'erros',
            legendEn: 'errors',
          },
        ],
      },
    ],
  },
  sites: {
    ignoresInstance: true,
    charts: [
      {
        id: 'site_availability',
        title: 'Disponibilidade',
        titleEn: 'Availability',
        group: 'Disponibilidade',
        groupEn: 'Availability',
        description: 'Percentagem de sondas HTTP com resposta 2xx (monitorização externa).',
        descriptionEn: 'Percentage of HTTP probes with a 2xx response (external monitoring).',
        unit: 'percent',
        gauge: true,
        heatmap: { warn: 99.9, crit: 99, higherIsBetter: true },
        queries: [
          {
            expr: '100 * avg by(instance)(avg_over_time(probe_success[$w]))',
            legend: '{{instance}}',
            rollup: 'site_availability',
          },
        ],
      },
      {
        id: 'site_latency',
        title: 'Tempo de resposta',
        titleEn: 'Response time',
        group: 'Tempo de resposta',
        groupEn: 'Response time',
        description: 'Duração total do pedido HTTP (média no período).',
        descriptionEn: 'Total HTTP request duration (average over the period).',
        unit: 'seconds',
        warn: 2,
        crit: 5,
        queries: [
          {
            expr: 'avg by(instance)(avg_over_time(probe_duration_seconds[$w]))',
            legend: '{{instance}}',
            rollup: 'site_latency',
          },
        ],
      },
      {
        id: 'site_phases',
        title: 'Fases do pedido HTTP',
        titleEn: 'HTTP request phases',
        group: 'Tempo de resposta',
        groupEn: 'Response time',
        description:
          'Tempo de cada fase no site mais lento: DNS (resolve), ligação, TLS, processamento no servidor e transferência.',
        descriptionEn:
          'Time of each phase on the slowest site: DNS (resolve), connection, TLS, server processing and transfer.',
        unit: 'seconds',
        queries: [
          {
            expr: 'max by(phase)(avg_over_time(probe_http_duration_seconds[$w]))',
            legend: '{{phase}}',
          },
        ],
      },
      {
        id: 'site_certificate',
        title: 'Validade do certificado (dias)',
        titleEn: 'Certificate validity (days)',
        group: 'Disponibilidade',
        groupEn: 'Availability',
        description: 'Dias até o certificado TLS expirar. O alerta dispara abaixo de 14 dias.',
        descriptionEn: 'Days until the TLS certificate expires. The alert fires below 14 days.',
        unit: 'count',
        queries: [
          {
            expr: 'min by(instance)(probe_ssl_earliest_cert_expiry - time()) / 86400',
            legend: '{{instance}}',
          },
        ],
      },
      {
        id: 'site_status',
        title: 'Código HTTP',
        titleEn: 'HTTP status code',
        group: 'Disponibilidade',
        groupEn: 'Availability',
        description: 'Último código de estado devolvido.',
        descriptionEn: 'Last status code returned.',
        unit: 'count',
        queries: [{ expr: 'max by(instance)(probe_http_status_code)', legend: '{{instance}}' }],
      },
    ],
  },
};

/** Gráfico e consulta de cada métrica agregada (mapa de calor e intervalo de 13 meses). */
export function rollupDefinitions() {
  const found = new Map<HealthRollupMetric, { chart: ChartDefinition; query: ChartQuery }>();
  for (const panel of Object.values(CHART_PANELS))
    for (const chart of panel.charts)
      for (const query of chart.queries)
        if (query.rollup) found.set(query.rollup, { chart, query });
  return found;
}

/** Substitui `{{label}}` pelas labels da série; sem a label fica vazio. */
export function legendFor(template: string, labels: Record<string, string>) {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => labels[name] ?? '')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .trim();
}
