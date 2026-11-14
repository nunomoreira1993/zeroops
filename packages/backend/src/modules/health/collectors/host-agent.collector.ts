import type {
  HealthAgentSample,
  HealthCronSample,
  HealthStatus,
} from '../../../../../contracts/src/index.js';
import {
  above,
  below,
  round,
  unknown,
  worst,
  type CheckResult,
  type CollectorContext,
  type HealthCollector,
} from './collector.js';
import { nextCronOccurrenceAfter } from './cron-schedule.js';

export interface StoredAgentSample {
  receivedAt: Date;
  sample: HealthAgentSample;
}

export interface AgentSampleSource {
  /** Amostra mais recente de cada host (hosts com envio nas ultimas 24h). */
  latest(projectId: string): Promise<StoredAgentSample[]>;
  /** Amostra mais recente do host recebida ate `before` (base de comparacao para crescimentos). */
  latestBefore(projectId: string, host: string, before: Date): Promise<StoredAgentSample | null>;
}

/** Amostras dentro do prazo de heartbeat, da mais recente para a mais antiga. */
export function freshSamples(samples: StoredAgentSample[], now: Date, staleMinutes: number) {
  return samples
    .filter((item) => now.getTime() - item.receivedAt.getTime() <= staleMinutes * 60000)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
}

/** Junta resultados de varios hosts: pior estado entre os que tem dados; resumo por host. */
function mergeHosts(
  checkIds: readonly string[],
  hosts: { host: string; results: CheckResult[] }[],
) {
  return checkIds.map((checkId) => {
    const found = hosts.flatMap(({ host, results }) =>
      results.filter((item) => item.checkId === checkId).map((result) => ({ host, result })),
    );
    const known = found.filter((item) => item.result.status !== 'unknown');
    const relevant = known.length ? known : found;
    const status = worst(relevant.map((item) => item.result.status));
    const primary = relevant.find((item) => item.result.status === status) ?? relevant[0]!;
    return {
      ...primary.result,
      status,
      summary: relevant.map((item) => `[${item.host}] ${item.result.summary}`).join(' '),
      details: Object.fromEntries(relevant.map((item) => [item.host, item.result.details ?? {}])),
    } satisfies CheckResult;
  });
}

const HOST_CHECKS = [
  'server-service',
  'disk-space',
  'inodes',
  'cpu-memory',
  'log-growth',
  'session-growth',
  'temp-files',
  'redis',
  'support-storage',
  'scheduled-jobs',
] as const;

/** Verificacoes do servidor a partir das amostras enviadas pelo agente instalado no host. */
export class HostAgentCollector implements HealthCollector {
  readonly name = 'host-agent';
  readonly checks = HOST_CHECKS;

  constructor(private readonly samples: AgentSampleSource) {}

  /** Converte amostras recentes do agente em verificações por host e assinala heartbeats vencidos. */
  async collect(context: CollectorContext): Promise<CheckResult[]> {
    const samples = await this.samples.latest(context.projectId);
    if (!samples.length)
      return this.checks.map((id) =>
        unknown(id, 'Agente do servidor ainda não enviou dados (instalar deploy/health-agent).'),
      );
    const hosts = await Promise.all(
      samples.map(async (latest) => ({
        host: latest.sample.host,
        results: await this.collectHost(context, latest),
      })),
    );
    return hosts.length === 1 ? hosts[0]!.results : mergeHosts(this.checks, hosts);
  }

  private async collectHost(
    context: CollectorContext,
    latest: StoredAgentSample,
  ): Promise<CheckResult[]> {
    const t = context.settings.thresholds;
    const ageMinutes = (context.now.getTime() - latest.receivedAt.getTime()) / 60000;
    const host = latest.sample.host;
    if (ageMinutes > t.agentStaleMinutes) {
      const summary = `Sem heartbeat de ${host} há ${Math.round(ageMinutes)} min.`;
      return [
        {
          checkId: 'server-service',
          status: 'critical',
          value: round(ageMinutes),
          unit: 'min',
          summary,
          details: { host, lastSampleAt: latest.receivedAt.toISOString() },
        },
        ...this.checks
          .filter((id) => id !== 'server-service')
          .map((id) => unknown(id, `Dados desatualizados: ${summary}`)),
      ];
    }
    const baseline = await this.samples.latestBefore(
      context.projectId,
      host,
      new Date(context.now.getTime() - 55 * 60000),
    );
    const s = latest.sample;
    return [
      this.services(s),
      this.disks(s, t.diskFreePercent),
      this.inodes(s, t.inodeFreePercent),
      this.cpuMemory(s, t.cpuLoadPerCore, t.memoryUsedPercent),
      this.logGrowth(latest, baseline, t.logGrowthMbPerHour),
      this.sessions(latest, baseline, t.sessionFiles),
      this.count('temp-files', s.tempFiles, t.tempFiles, 'ficheiros temporários'),
      this.redis(s),
      this.mounts(s),
      this.crons(s, t.cronStaleMinutes, context.now),
    ];
  }

  private services(s: HealthAgentSample): CheckResult {
    const services = s.services ?? [];
    const down = services.filter((item) => !item.active).map((item) => item.name);
    return {
      checkId: 'server-service',
      status: down.length ? 'critical' : 'ok',
      value: down.length,
      unit: 'serviços',
      summary: down.length
        ? `Serviços parados em ${s.host}: ${down.join(', ')}.`
        : `${s.host} responde; ${services.length} serviços ativos.`,
      details: { host: s.host, services },
    };
  }

  private disks(s: HealthAgentSample, limit: number): CheckResult {
    if (!s.disks?.length) return unknown('disk-space', 'O agente não reportou partições.');
    const free = s.disks.map((disk) => ({
      mount: disk.mount,
      free: round(100 - disk.usedPercent),
    }));
    const min = free.reduce((acc, item) => (item.free < acc.free ? item : acc));
    return {
      checkId: 'disk-space',
      status: below(min.free, limit),
      value: min.free,
      unit: '% livre',
      summary: `Menor espaço livre: ${min.mount} com ${min.free}% (limite ${limit}%).`,
      details: { disks: free },
    };
  }

  private inodes(s: HealthAgentSample, limit: number): CheckResult {
    const disks = (s.disks ?? []).filter((disk) => typeof disk.inodesUsedPercent === 'number');
    if (!disks.length) return unknown('inodes', 'O agente não reportou inodes.');
    const free = disks.map((disk) => ({
      mount: disk.mount,
      free: round(100 - (disk.inodesUsedPercent ?? 0)),
    }));
    const min = free.reduce((acc, item) => (item.free < acc.free ? item : acc));
    return {
      checkId: 'inodes',
      status: below(min.free, limit),
      value: min.free,
      unit: '% livre',
      summary: `Menos inodes livres: ${min.mount} com ${min.free}% (limite ${limit}%).`,
      details: { disks: free },
    };
  }

  private cpuMemory(s: HealthAgentSample, loadLimit: number, memoryLimit: number): CheckResult {
    if (!s.cpu && !s.memory) return unknown('cpu-memory', 'O agente não reportou CPU/memória.');
    const loadPerCore = s.cpu ? round(s.cpu.load5 / s.cpu.cores, 2) : null;
    const memoryUsed =
      s.memory && s.memory.totalKb > 0
        ? round(100 - (s.memory.availableKb / s.memory.totalKb) * 100)
        : null;
    const status = worst([
      loadPerCore === null ? 'ok' : above(loadPerCore, loadLimit),
      memoryUsed === null
        ? 'ok'
        : above(memoryUsed, memoryLimit, Math.min(100 / memoryLimit, 1.06)),
    ]);
    return {
      checkId: 'cpu-memory',
      status,
      value: memoryUsed,
      unit: '% memória',
      summary: `Carga/core (5 min): ${loadPerCore ?? '-'} (limite ${loadLimit}); memória usada: ${memoryUsed ?? '-'}% (limite ${memoryLimit}%).`,
      details: { loadPerCore, memoryUsed, cpu: s.cpu, memory: s.memory },
    };
  }

  private logGrowth(
    latest: StoredAgentSample,
    baseline: StoredAgentSample | null,
    limit: number,
  ): CheckResult {
    const logs = latest.sample.logs;
    if (!logs?.length) return unknown('log-growth', 'O agente não reportou ficheiros de log.');
    if (!baseline?.sample.logs?.length)
      return unknown('log-growth', 'A aguardar uma hora de amostras para calcular o crescimento.');
    const hours = (latest.receivedAt.getTime() - baseline.receivedAt.getTime()) / 3600000;
    const before = new Map(baseline.sample.logs.map((item) => [item.path, item.sizeBytes]));
    const growth = logs.map((item) => {
      const previous = before.get(item.path);
      // Ficheiro rodado (logrotate) ou novo: conta o tamanho atual como crescimento.
      const delta =
        previous === undefined || item.sizeBytes < previous
          ? item.sizeBytes
          : item.sizeBytes - previous;
      return { path: item.path, mbPerHour: round(delta / 1048576 / hours) };
    });
    const top = growth.reduce((acc, item) => (item.mbPerHour > acc.mbPerHour ? item : acc));
    return {
      checkId: 'log-growth',
      status: above(top.mbPerHour, limit, 3),
      value: top.mbPerHour,
      unit: 'MB/h',
      summary: `Maior crescimento: ${top.path} com ${top.mbPerHour} MB/h (limite ${limit}).`,
      details: { growth },
    };
  }

  private sessions(
    latest: StoredAgentSample,
    baseline: StoredAgentSample | null,
    limit: number,
  ): CheckResult {
    const current = latest.sample.sessionFiles;
    if (current === undefined) return unknown('session-growth', 'O agente não reportou sessões.');
    const previous = baseline?.sample.sessionFiles;
    const growthPercent = previous ? round(((current - previous) / previous) * 100) : null;
    const status = worst([
      above(current, limit, 2),
      growthPercent !== null && growthPercent >= 100 && current >= limit / 4 ? 'warning' : 'ok',
    ]);
    return {
      checkId: 'session-growth',
      status,
      value: current,
      unit: 'sessões',
      summary: `${current} sessões (limite ${limit})${growthPercent === null ? '' : `; variação 1h: ${growthPercent}%`}.`,
      details: { current, previous, growthPercent },
    };
  }

  private count(
    checkId: string,
    value: number | undefined,
    limit: number,
    label: string,
  ): CheckResult {
    if (value === undefined) return unknown(checkId, `O agente não reportou ${label}.`);
    return {
      checkId,
      status: above(value, limit, 2),
      value,
      unit: 'ficheiros',
      summary: `${value} ${label} (limite ${limit}).`,
    };
  }

  private redis(s: HealthAgentSample): CheckResult {
    if (!s.redis) return unknown('redis', 'O agente não reportou o Redis.');
    return {
      checkId: 'redis',
      status: s.redis.ok ? 'ok' : 'critical',
      value: s.redis.ok ? 1 : 0,
      unit: null,
      summary: s.redis.ok ? 'Redis responde a PING.' : 'Redis não responde a PING.',
    };
  }

  private mounts(s: HealthAgentSample): CheckResult {
    if (!s.mounts?.length) return unknown('support-storage', 'O agente não reportou montagens.');
    const failed = s.mounts.filter((item) => !item.ok).map((item) => item.path);
    return {
      checkId: 'support-storage',
      status: failed.length ? 'critical' : 'ok',
      value: failed.length,
      unit: 'falhas',
      summary: failed.length
        ? `Sem acesso a: ${failed.join(', ')}.`
        : `${s.mounts.length} pontos de armazenamento acessíveis.`,
      details: { mounts: s.mounts },
    };
  }

  private crons(s: HealthAgentSample, limit: number, now: Date): CheckResult {
    if (!s.crons?.length)
      return unknown('scheduled-jobs', 'O agente não reportou tarefas agendadas.');
    const tasks = s.crons.map((item) =>
      'id' in item ? this.scheduledCron(item, now) : this.legacyCron(item, limit),
    );
    const overdue = tasks.filter((item) => item.overdue);
    const failures = tasks.filter((item) => item.failed);
    const taskStatuses = tasks.map((item) => item.status);
    const status = worst(taskStatuses);
    const detailLimit = 6;
    const descriptions = tasks
      .filter((item) => item.status !== 'ok')
      .slice(0, detailLimit)
      .map((item) => item.summary);
    if (!descriptions.length)
      descriptions.push(...tasks.slice(0, detailLimit).map((item) => item.summary));
    const omitted = Math.max(0, tasks.length - descriptions.length);
    return {
      checkId: 'scheduled-jobs',
      status,
      value: overdue.length + failures.filter((item) => !item.overdue).length,
      unit: 'atrasadas',
      summary: `${tasks.length} tarefas; ${overdue.length} fora do prazo, ${failures.length} com falha${omitted ? `; mais ${omitted} no detalhe` : ''}. ${descriptions.join(' ')}`,
      details: { crons: tasks },
    };
  }

  private legacyCron(
    item: Extract<HealthCronSample, { lastRunAgeMinutes: number }>,
    limit: number,
  ) {
    const late = item.lastRunAgeMinutes > limit;
    const status: HealthStatus = late
      ? item.lastRunAgeMinutes > limit * 4
        ? 'critical'
        : 'warning'
      : 'ok';
    return {
      id: null,
      name: item.name,
      status,
      overdue: late,
      failed: false,
      summary: late
        ? `${item.name}: sem execução há ${Math.round(item.lastRunAgeMinutes)} min (limite legado ${limit}).`
        : `${item.name}: executado há ${Math.round(item.lastRunAgeMinutes)} min.`,
      lastRunAgeMinutes: item.lastRunAgeMinutes,
    } as const;
  }

  private scheduledCron(item: Extract<HealthCronSample, { id: string }>, now: Date) {
    const activatedAt = new Date(item.activatedAt);
    const lastSuccessAt = item.lastHttpCompletedAt ? new Date(item.lastHttpCompletedAt) : null;
    const anchor = lastSuccessAt && lastSuccessAt > activatedAt ? lastSuccessAt : activatedAt;
    let due: Date | null;
    try {
      due = nextCronOccurrenceAfter(item.schedule, item.timeZone, anchor);
    } catch {
      due = null;
    }

    const failureAt = item.lastFailureAt ? new Date(item.lastFailureAt) : null;
    const failed =
      Boolean(failureAt && (!lastSuccessAt || failureAt > lastSuccessAt)) ||
      (item.lastExitCode !== null && item.lastExitCode !== 0) ||
      (item.lastHttpCurlExitCode !== null && item.lastHttpCurlExitCode !== 0) ||
      (item.lastHttpStatus !== null && (item.lastHttpStatus < 200 || item.lastHttpStatus >= 300));
    const base = {
      id: item.id,
      name: item.name,
      schedule: item.schedule,
      timeZone: item.timeZone,
      graceMinutes: item.graceMinutes,
      activatedAt: item.activatedAt,
      lastAttemptAt: item.lastAttemptAt,
      lastExitCode: item.lastExitCode,
      lastHttpStatus: item.lastHttpStatus,
      lastHttpCurlExitCode: item.lastHttpCurlExitCode,
      lastHttpCompletedAt: item.lastHttpCompletedAt,
      lastHttpCompletedStatus: item.lastHttpCompletedStatus,
      lastFailureAt: item.lastFailureAt,
      lastFailureCode: item.lastFailureCode,
      inProgress: item.inProgress,
      dueAt: due?.toISOString() ?? null,
      deadlineAt: due ? new Date(due.getTime() + item.graceMinutes * 60000).toISOString() : null,
      overdue: false,
      failed,
    };

    if (!due)
      return {
        ...base,
        status: 'unknown' as const,
        summary: `${item.name}: não foi possível calcular o próximo prazo da agenda.`,
      };

    const deadline = due.getTime() + item.graceMinutes * 60000;
    const overdue = now.getTime() > deadline;
    const completion =
      lastSuccessAt && item.lastHttpCompletedStatus !== null
        ? `última conclusão HTTP ${item.lastHttpCompletedStatus} em ${lastSuccessAt.toISOString()} (sucesso funcional não verificado)`
        : 'sem conclusão HTTP registada';

    if (failed) {
      return {
        ...base,
        status:
          overdue && now.getTime() > deadline + item.graceMinutes * 3 * 60000
            ? ('critical' as const)
            : ('warning' as const),
        overdue,
        summary: `${item.name}: última tentativa falhou (${item.lastFailureCode ?? `exit=${item.lastExitCode ?? '—'}, HTTP=${item.lastHttpStatus ?? '—'}`}); ${completion}.`,
      };
    }
    if (overdue) {
      const status: HealthStatus =
        now.getTime() > deadline + item.graceMinutes * 3 * 60000 ? 'critical' : 'warning';
      return {
        ...base,
        status,
        overdue: true,
        summary: `${item.name}: prazo ${due.toISOString()} + ${item.graceMinutes} min expirou; ${completion}.`,
      };
    }
    if (!lastSuccessAt) {
      return {
        ...base,
        status: 'unknown' as const,
        summary: `${item.name}: primeira execução pendente até ${new Date(deadline).toISOString()}.`,
      };
    }
    return {
      ...base,
      status: 'ok' as const,
      summary: `${item.name}: ${completion}; próximo prazo ${due.toISOString()} (+${item.graceMinutes} min).`,
    };
  }
}
