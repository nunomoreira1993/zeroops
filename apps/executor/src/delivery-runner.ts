import { z } from 'zod';
import {
  PIPELINE_SIGNATURE_HEADER,
  PIPELINE_TIMESTAMP_HEADER,
  pipelineCallbackSchema,
  type DeliveryState,
} from '../../../packages/contracts/src/index.js';
import type {
  DeliveryJob,
  DeliveryLease,
  DeliveryStore,
  DeliveryWrite,
} from '../../../packages/backend/src/modules/delivery/delivery.store.js';
import { signPipelinePayload } from '../../../packages/backend/src/modules/delivery/pipeline-signature.js';
import {
  pipelineCallbackUrl,
  pipelineEndpointAllowed,
} from '../../../packages/backend/src/modules/delivery/pipelines.service.js';
import { jsonValue } from '../../../packages/backend/src/modules/development/git-repositories.service.js';
import {
  GitCommandError,
  remoteBranchSha,
  runGit,
} from '../../../packages/backend/src/modules/development/git.js';
import type { AttemptCheckout, WorkspaceManager } from './workspace-manager.js';
import { ownerOf, type JobIdentitySource } from './job-sandbox.js';

/** Resposta HTTP do fornecedor (corpo já lido). `null` = sem resposta (rede/timeout). */
export interface PipelineResponse {
  status: number;
  body: unknown;
}

/** Transporte HTTP (injetável nos testes). */
export type PipelineTransport = (input: {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}) => Promise<PipelineResponse>;

/** Transporte real (fetch com timeout; corpo JSON quando existir). */
export const fetchTransport: PipelineTransport = async ({
  method,
  url,
  headers,
  body,
  timeoutMs,
}) => {
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
};

export interface DeliveryRunnerOptions {
  workerId: string;
  allowedOrigins: readonly string[];
  publicUrl: string;
  transport?: PipelineTransport;
  leaseSeconds?: number;
  requestTimeoutMs?: number;
  /** Intervalo entre consultas ao fornecedor (s). */
  reconcileSeconds?: number;
  /** Consultas sem conclusão antes de terminar como `uncertain` (escalada humana). */
  maxReconcileAttempts?: number;
  integrationLockSeconds?: number;
  environmentLockSeconds?: number;
  /** F04: intervalo de renovação do lease/locks durante operações longas (omissão: lease/4). */
  heartbeatMs?: number;
  /** F02: uid exclusivo para os comandos do repositório na revalidação da combinação. */
  identities?: JobIdentitySource;
  log?: (event: Record<string, unknown>) => void;
}

/** A posse da entrega foi perdida: a tentativa pára sem mais escritas nem I/O externo. */
class DeliveryStale extends Error {
  constructor() {
    super('Posse da entrega perdida.');
  }
}

const accepted = (write: DeliveryWrite | unknown) => {
  if (write === 'stale') throw new DeliveryStale();
};
const short = (sha: string | null | undefined) => (sha ?? '').slice(0, 12);
const message = (error: unknown) => (error instanceof Error ? error.message : 'Erro desconhecido.');
const tail = (log: string) => (log.length > 4000 ? log.slice(-4000) : log);

/**
 * P09 — executor das entregas. Para cada entrega reclamada (lease com época):
 * 1. revalida os gates (review válido sobre o head, permissões, posse da etapa, ticket ativo);
 * 2. com o lock durável da branch de destino integra o head sobre o topo atual (fast-forward ou
 *    merge), compara a alteração aplicada com a revista e volta a correr os testes configurados
 *    sobre a combinação; grava a intenção antes do push e reconcilia pushes incertos;
 * 3. com o lock do ambiente pede ao fornecedor a publicação do SHA/digest exatos (pedido
 *    assinado e idempotente) e acompanha-a por callbacks e consultas; uma resposta perdida
 *    nunca é repetida às cegas: primeiro consulta o estado externo.
 */
export class DeliveryRunner {
  private readonly transport: PipelineTransport;
  private readonly leaseSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly reconcileSeconds: number;
  private readonly maxReconcileAttempts: number;
  private readonly integrationLockSeconds: number;
  private readonly environmentLockSeconds: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly store: DeliveryStore,
    private readonly manager: WorkspaceManager,
    private readonly options: DeliveryRunnerOptions,
  ) {
    this.transport = options.transport ?? fetchTransport;
    this.leaseSeconds = options.leaseSeconds ?? 300;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.reconcileSeconds = options.reconcileSeconds ?? 30;
    this.maxReconcileAttempts = options.maxReconcileAttempts ?? 120;
    this.integrationLockSeconds = options.integrationLockSeconds ?? 1800;
    this.environmentLockSeconds = options.environmentLockSeconds ?? 6 * 3600;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1000, (this.leaseSeconds * 1000) / 4);
  }

  /** Processa uma entrega elegível; devolve `false` quando a fila está vazia. */
  async runOnce(shutdown?: AbortSignal): Promise<boolean> {
    if (shutdown?.aborted) return false;
    const job = await this.store.claimNext(this.options.workerId, this.leaseSeconds);
    if (!job) return false;
    let next: number | null = this.reconcileSeconds;
    try {
      next = await this.process(job);
    } catch (error) {
      if (!(error instanceof DeliveryStale))
        this.options.log?.({
          event: 'delivery.failed_step',
          deliveryId: job.delivery.id,
          type: error instanceof Error ? error.name : 'UnknownError',
          message: message(error).slice(0, 300),
        });
      next = error instanceof DeliveryStale ? null : 60;
    } finally {
      await this.store.release(job.lease, next);
    }
    return true;
  }

  private async process(job: DeliveryJob): Promise<number | null> {
    const { delivery, lease } = job;
    if (delivery.cancel_requested && ['queued', 'integrating'].includes(delivery.state)) {
      accepted(
        await this.store.finish(
          lease,
          ['queued', 'integrating'],
          'cancelled',
          'A etapa de entrega terminou no fluxo antes da integração.',
        ),
      );
      return null;
    }
    switch (delivery.state) {
      case 'queued':
      case 'integrating':
        return this.integrate(job);
      case 'starting':
        return this.start(job);
      case 'publishing':
      case 'uncertain':
        return this.reconcile(job);
      default:
        return null;
    }
  }

  private async block(
    job: DeliveryJob,
    from: DeliveryState[],
    state: DeliveryState,
    reason: string,
  ) {
    accepted(await this.store.finish(job.lease, from, state, reason));
    this.options.log?.({ event: 'delivery.finished', deliveryId: job.delivery.id, state });
    return null;
  }

  /**
   * F01: todos os gates (etapa ativa, ticket, review, aprovações, candidato, testes, autorização
   * de publicação de capacidade) são reavaliados imediatamente antes de cada efeito externo.
   * Devolve `undefined` quando o efeito pode prosseguir; caso contrário termina a entrega.
   */
  private async effectGate(
    job: DeliveryJob,
    from: DeliveryState[],
    effect: string,
  ): Promise<null | undefined> {
    const gates = await this.store.revalidate(job.lease);
    accepted(gates);
    if (gates === 'stale') return null;
    if (gates.ok) return undefined;
    await this.store.recordRunnerEvent(job.lease, 'effect_blocked', {
      effect,
      reason: gates.reason,
    });
    return this.block(
      job,
      from,
      'cancelled' in gates ? 'cancelled' : gates.rework ? 'rework' : 'blocked',
      gates.reason,
    );
  }

  private async integrate(job: DeliveryJob): Promise<number | null> {
    const { delivery, lease } = job;
    const from: DeliveryState[] = ['queued', 'integrating'];
    if (!job.repository || job.pipeline.archived)
      return this.block(job, from, 'blocked', 'O repositório ou a pipeline foram arquivados.');
    const initial = await this.effectGate(job, from, 'integrate');
    if (initial !== undefined) return initial;
    const integrationKey = job.locks.integration!;
    // F03: a configuração do repositório passou a apontar para outro recurso real.
    if (delivery.integration_key && delivery.integration_key !== integrationKey)
      return this.block(
        job,
        from,
        'blocked',
        'O repositório de destino da entrega mudou depois de a entrega ser criada.',
      );
    const lock = await this.store.acquireLock(lease, integrationKey, this.integrationLockSeconds);
    accepted(lock);
    if (lock === 'stale') return null;
    if (!lock.acquired) return 15;
    return this.guarded(
      job,
      [{ key: integrationKey, epoch: lock.epoch, ttl: this.integrationLockSeconds }],
      (signal) => this.integrateLocked(job, integrationKey, signal),
    );
  }

  /**
   * F04: mantém o lease e os locks vivos durante operações longas. Se a posse ou um lock forem
   * perdidos, aborta os processos em curso e a tentativa termina sem novos efeitos.
   */
  private async guarded<T>(
    job: DeliveryJob,
    locks: { key: string; epoch: number; ttl: number }[],
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let beating: Promise<void> | null = null;
    const beat = async () => {
      try {
        if ((await this.store.heartbeat(job.lease, this.leaseSeconds)) === 'stale')
          return controller.abort();
        for (const lock of locks)
          if ((await this.store.renewLock(job.lease, lock.key, lock.epoch, lock.ttl)) !== true)
            return controller.abort();
      } catch (error) {
        this.options.log?.({
          event: 'delivery.heartbeat_failed',
          deliveryId: job.delivery.id,
          message: message(error).slice(0, 300),
        });
        controller.abort();
      }
    };
    const timer = setInterval(() => {
      beating ??= beat().finally(() => {
        beating = null;
      });
    }, this.heartbeatMs);
    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted) throw new DeliveryStale();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new DeliveryStale();
      throw error;
    } finally {
      clearInterval(timer);
      await beating;
    }
  }

  private async integrateLocked(
    job: DeliveryJob,
    integrationKey: string,
    signal: AbortSignal,
  ): Promise<number | null> {
    const { delivery, lease } = job;
    const from: DeliveryState[] = ['queued', 'integrating'];
    accepted(await this.store.update(lease, from, { state: 'integrating', state_reason: null }));
    const { url, credential } = job.repository!;
    const options = { credential, signal };

    // Intenção anterior (push com resultado incerto): o remoto decide se já foi integrado.
    if (delivery.integrated_sha) {
      const remote = await remoteBranchSha(url, delivery.target_branch, options);
      if (remote === delivery.integrated_sha) {
        const { gitDir } = await this.manager.fetchBase({
          projectId: delivery.project_id,
          workspaceId: delivery.workspace_id,
          url,
          baseBranch: delivery.target_branch,
          credential,
          signal,
        });
        return this.integrated(job, gitDir, delivery.integrated_sha, integrationKey);
      }
      accepted(
        await this.store.update(lease, ['integrating'], {
          target_sha: null,
          integrated_sha: null,
          revalidated: false,
        }),
      );
      await this.store.recordRunnerEvent(lease, 'push_absent', {
        integratedSha: delivery.integrated_sha,
        remoteSha: remote,
      });
    }

    let gitDir: string;
    let top: string;
    try {
      const fetched = await this.manager.fetchBase({
        projectId: delivery.project_id,
        workspaceId: delivery.workspace_id,
        url,
        baseBranch: delivery.target_branch,
        credential,
        signal,
      });
      gitDir = fetched.gitDir;
      top = fetched.remoteBaseSha;
      if (!(await this.manager.hasCommit(gitDir, delivery.candidate_head_sha)))
        await this.manager.fetchBase({
          projectId: delivery.project_id,
          workspaceId: delivery.workspace_id,
          url,
          baseBranch: job.workspace.branch,
          credential,
          signal,
        });
    } catch (error) {
      if (error instanceof GitCommandError && error.uncertain) return 60;
      return this.block(
        job,
        ['integrating'],
        'blocked',
        `Não foi possível obter o repositório: ${message(error)}`,
      );
    }
    const head = delivery.candidate_head_sha;
    if (!(await this.manager.hasCommit(gitDir, head)))
      return this.block(
        job,
        ['integrating'],
        'blocked',
        `O commit revisto ${short(head)} não está disponível no workspace nem no remoto.`,
      );
    const fastForward = await this.manager.isAncestor(gitDir, top, head);
    const alreadyIn = !fastForward && (await this.manager.isAncestor(gitDir, head, top));
    if (!alreadyIn && !job.pipeline.allowIntegration)
      return this.block(
        job,
        ['integrating'],
        'blocked',
        `A pipeline não autoriza o ZeroOps a integrar em ${delivery.target_branch}: integração manual necessária.`,
      );

    let integrated = head;
    let evidence: Record<string, unknown> = { targetSha: top, mode: 'fast-forward' };
    if (!fastForward) {
      // F02: os comandos do repositório correm com um uid exclusivo desta entrega.
      const identity = (await this.options.identities?.acquire()) ?? null;
      const owner = ownerOf(identity);
      let checkout: AttemptCheckout;
      try {
        checkout = await this.manager.checkout(
          gitDir,
          `deliver-${delivery.id.slice(0, 8)}-${lease.epoch}`,
          top,
          ...(owner ? [owner] : []),
        );
      } catch (error) {
        await identity?.release();
        throw error;
      }
      try {
        if (alreadyIn) {
          integrated = top;
          evidence = { targetSha: top, mode: 'already-integrated' };
        } else {
          const merged = await this.manager.mergeCheckout(
            checkout,
            head,
            `Integra ${job.ticketKey} (${job.workspace.branch}) em ${delivery.target_branch}`,
          );
          if (!merged.ok)
            return this.block(
              job,
              ['integrating'],
              'conflict',
              `Conflito ao integrar sobre ${delivery.target_branch}@${short(top)}${
                merged.conflicts.length ? ` em ${merged.conflicts.slice(0, 10).join(', ')}` : ''
              }.`,
            );
          const reviewed = await this.manager.stableDiffHash(
            gitDir,
            delivery.candidate_base_sha,
            head,
          );
          const applied = await this.manager.stableDiffHash(gitDir, top, merged.sha);
          if (reviewed !== applied)
            return this.block(
              job,
              ['integrating'],
              'rework',
              `A integração sobre ${delivery.target_branch}@${short(top)} altera o conteúdo revisto: é necessária nova revisão.`,
            );
          integrated = merged.sha;
          evidence = { targetSha: top, mode: 'merge', mergeSha: merged.sha };
        }
        // Checks isolados não comprovam a combinação: os testes voltam a correr sobre ela.
        const revalidation = await this.revalidateCombination(job, checkout, integrated, signal);
        if (!revalidation.ok)
          return this.block(job, ['integrating'], revalidation.state, revalidation.reason);
        evidence = { ...evidence, revalidation: revalidation.evidence };
      } finally {
        await this.manager.removeCheckout(checkout);
        await identity?.release();
      }
    }

    // Intenção registada antes do push: um reinício reconcilia em vez de repetir às cegas.
    accepted(
      await this.store.update(lease, ['integrating'], {
        target_sha: top,
        integrated_sha: integrated,
        revalidated: !fastForward,
        evidence,
      }),
    );
    if (integrated !== top) {
      accepted(await this.store.heartbeat(lease, this.leaseSeconds));
      const beforePush = await this.effectGate(job, ['integrating'], 'push');
      if (beforePush !== undefined) return beforePush;
      const pushed = await this.push(job, gitDir, top, integrated, signal);
      if (pushed === 'moved') {
        accepted(
          await this.store.update(lease, ['integrating'], {
            state: 'queued',
            state_reason: `A branch ${delivery.target_branch} avançou durante a integração: nova integração sobre o topo atual.`,
            target_sha: null,
            integrated_sha: null,
            revalidated: false,
          }),
        );
        await this.store.releaseLock(delivery.id, integrationKey);
        return 0;
      }
      if (pushed === 'uncertain') return 60;
    }
    return this.integrated(job, gitDir, integrated, integrationKey);
  }

  private async integrated(
    job: DeliveryJob,
    gitDir: string,
    integrated: string,
    integrationKey: string,
  ) {
    const { delivery, lease } = job;
    const digest = await this.manager.archiveDigest(gitDir, integrated);
    accepted(
      await this.store.update(lease, ['integrating'], {
        state: 'starting',
        state_reason: null,
        integrated_sha: integrated,
        artifact_digest: digest,
      }),
    );
    await this.store.releaseLock(delivery.id, integrationKey);
    this.options.log?.({ event: 'delivery.integrated', deliveryId: delivery.id, sha: integrated });
    return 0;
  }

  private async revalidateCombination(
    job: DeliveryJob,
    checkout: AttemptCheckout,
    sha: string,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; evidence: Record<string, unknown> }
    | { ok: false; state: DeliveryState; reason: string }
  > {
    const repository = job.repository!;
    if (!repository.testCommands.length)
      return {
        ok: false,
        state: 'blocked',
        reason: 'O repositório não tem comandos de teste: a combinação não pode ser revalidada.',
      };
    if (sha !== checkout.startSha) await this.manager.detach(checkout, sha);
    const commands: Record<string, unknown>[] = [];
    for (const [kind, list] of [
      ['setup', repository.setupCommands],
      ['test', repository.testCommands],
    ] as const) {
      for (const command of list) {
        accepted(await this.store.heartbeat(job.lease, this.leaseSeconds));
        const result = await this.manager.runConfigured(checkout, command, signal);
        if (result.aborted || signal.aborted) throw new DeliveryStale();
        commands.push({
          kind,
          name: command.name,
          command: command.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          logTail: tail(result.log),
        });
        if (result.exitCode !== 0)
          return {
            ok: false,
            state: 'rework',
            reason: `A combinação com ${job.delivery.target_branch} falhou em «${command.name}» (${
              result.timedOut ? 'tempo esgotado' : `código ${result.exitCode}`
            }): ${tail(result.log).slice(-600)}`,
          };
      }
    }
    return { ok: true, evidence: { sha, commands } };
  }

  /** Push sem force; resultado incerto é confirmado no remoto antes de decidir. */
  private async push(
    job: DeliveryJob,
    gitDir: string,
    top: string,
    integrated: string,
    signal: AbortSignal,
  ): Promise<'pushed' | 'moved' | 'uncertain'> {
    const { url, credential } = job.repository!;
    const branch = job.delivery.target_branch;
    if (signal.aborted) throw new DeliveryStale();
    try {
      await runGit(
        ['--git-dir', gitDir, 'push', '--quiet', url, `${integrated}:refs/heads/${branch}`],
        {
          credential,
          timeoutMs: 300_000,
          signal,
        },
      );
      await this.store.recordRunnerEvent(job.lease, 'pushed', { sha: integrated, branch });
      return 'pushed';
    } catch (error) {
      const after = await remoteBranchSha(url, branch, { credential }).catch(() => undefined);
      await this.store.recordRunnerEvent(job.lease, 'push_error', {
        sha: integrated,
        remoteSha: after ?? null,
        uncertain: error instanceof GitCommandError && error.uncertain,
      });
      if (after === integrated) return 'pushed';
      if (after === undefined) return 'uncertain';
      if (after !== top) return 'moved';
      throw error;
    }
  }

  private headers(secret: string, body: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'content-type': 'application/json',
      [PIPELINE_TIMESTAMP_HEADER]: timestamp,
      [PIPELINE_SIGNATURE_HEADER]: signPipelinePayload(secret, timestamp, body),
    };
  }

  private async call(job: DeliveryJob, method: 'GET' | 'POST', path: string, payload?: unknown) {
    const base = job.pipeline.endpointUrl.replace(/\/+$/, '');
    // A lista de origens é verificada antes de cada pedido (pode ter mudado desde a configuração).
    if (!pipelineEndpointAllowed(base, this.options.allowedOrigins))
      throw new Error('O endpoint da pipeline não pertence a uma origem autorizada.');
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return this.transport({
      method,
      url: `${base}${path}`,
      headers: this.headers(job.pipeline.secret, body),
      ...(payload === undefined ? {} : { body }),
      timeoutMs: this.requestTimeoutMs,
    }).catch(() => null);
  }

  private async start(job: DeliveryJob): Promise<number | null> {
    const { delivery, lease } = job;
    const from: DeliveryState[] = ['starting', 'uncertain'];
    if (!pipelineEndpointAllowed(job.pipeline.endpointUrl, this.options.allowedOrigins))
      return this.block(
        job,
        from,
        'blocked',
        'O endpoint da pipeline não pertence a uma origem autorizada.',
      );
    if (!delivery.integrated_sha || !delivery.artifact_digest)
      return this.block(job, from, 'failed', 'Entrega sem SHA/artefacto integrado.');
    const lock = await this.store.acquireLock(
      lease,
      job.locks.environment,
      this.environmentLockSeconds,
    );
    accepted(lock);
    if (lock === 'stale') return null;
    if (!lock.acquired) {
      accepted(
        await this.store.update(lease, from, {
          state_reason: `À espera do ambiente ${delivery.environment}, ocupado por outra entrega.`,
        }),
      );
      return 30;
    }
    accepted(await this.store.heartbeat(lease, this.leaseSeconds));
    // F01: também no retry após 404 (estado `uncertain`) — cada POST é um novo efeito externo.
    const beforeStart = await this.effectGate(job, from, 'start');
    if (beforeStart !== undefined) return beforeStart;
    const response = await this.call(job, 'POST', '/deliveries', {
      deliveryId: delivery.id,
      idempotencyKey: delivery.idempotency_key,
      ticket: job.ticketKey,
      ref: delivery.target_branch,
      sha: delivery.integrated_sha,
      artifactDigest: delivery.artifact_digest,
      environment: delivery.environment,
      callbackUrl: pipelineCallbackUrl(this.options.publicUrl, delivery.pipeline_id),
    });
    await this.store.recordRunnerEvent(lease, 'start_sent', {
      status: response?.status ?? null,
      sha: delivery.integrated_sha,
    });
    if (
      response &&
      ((response.status >= 200 && response.status < 300) || response.status === 409)
    ) {
      const body = z
        .object({ externalId: z.string().max(200).optional(), url: z.string().max(500).optional() })
        .safeParse(response.body);
      accepted(
        await this.store.update(lease, from, {
          state: 'publishing',
          state_reason: null,
          pipeline_status: delivery.pipeline_status ?? 'accepted',
          ...(body.success && body.data.externalId ? { external_id: body.data.externalId } : {}),
          ...(body.success && body.data.url ? { external_url: body.data.url } : {}),
        }),
      );
      return this.reconcileSeconds;
    }
    if (response && response.status >= 400 && response.status < 500)
      return this.block(
        job,
        from,
        'failed',
        `O fornecedor recusou o pedido (HTTP ${response.status}).`,
      );
    accepted(
      await this.store.update(lease, from, {
        state: 'uncertain',
        state_reason:
          'Sem resposta conclusiva do fornecedor: o estado externo será consultado antes de qualquer repetição.',
      }),
    );
    return this.reconcileSeconds;
  }

  private async reconcile(job: DeliveryJob): Promise<number | null> {
    const { delivery, lease } = job;
    const from: DeliveryState[] = ['publishing', 'uncertain'];
    const evidence = jsonValue<Record<string, unknown>>(delivery.evidence, {});
    if (delivery.cancel_requested && !evidence.cancelSent) {
      const cancel = await this.call(
        job,
        'POST',
        `/deliveries/${delivery.idempotency_key}/cancel`,
        {
          idempotencyKey: delivery.idempotency_key,
        },
      );
      await this.store.recordRunnerEvent(lease, 'cancel_sent', { status: cancel?.status ?? null });
      accepted(
        await this.store.update(lease, from, { evidence: { ...evidence, cancelSent: true } }),
      );
    }
    const response = await this.call(job, 'GET', `/deliveries/${delivery.idempotency_key}`);
    const attempts = Number(delivery.attempts) + 1;
    if (response?.status === 200) {
      const event = pipelineCallbackSchema.safeParse(response.body);
      if (event.success && event.data.idempotencyKey === delivery.idempotency_key) {
        const applied = await this.store.applyEvent(delivery.pipeline_id, event.data, 'reconcile');
        if (
          applied?.outcome === 'applied' &&
          ['succeeded', 'failed', 'cancelled'].includes(event.data.status)
        )
          return null;
      }
    } else if (response?.status === 404) {
      // O fornecedor não conhece a entrega: o pedido inicial não chegou.
      if (delivery.cancel_requested)
        return this.block(
          job,
          from,
          'cancelled',
          'Cancelada antes de o fornecedor iniciar a publicação.',
        );
      if (delivery.state === 'uncertain') {
        await this.store.recordRunnerEvent(lease, 'start_retry', { reason: 'not_found' });
        return this.start(job);
      }
    }
    if (attempts >= this.maxReconcileAttempts)
      return this.block(
        job,
        from,
        'uncertain',
        `Sem confirmação do fornecedor após ${attempts} consultas: o resultado da publicação é incerto e precisa de verificação manual.`,
      );
    accepted(await this.store.update(lease, from, { attempts }));
    return this.reconcileSeconds;
  }

  /** Para testes: lease atual de uma entrega reclamada (não usado em produção). */
  static leaseOf(job: DeliveryJob): DeliveryLease {
    return job.lease;
  }
}
