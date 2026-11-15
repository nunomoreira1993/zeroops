import { createHash } from 'node:crypto';
import type {
  DevelopmentRunContext,
  FencedWrite,
  PublicationInput,
  RevisionInput,
  TestRecordInput,
} from '../../../packages/backend/src/modules/development/development.store.js';
import {
  GIT_SHA,
  GitCommandError,
  remoteBranchSha,
  runGit,
} from '../../../packages/backend/src/modules/development/git.js';
import type { JobLease } from '../../../packages/backend/src/modules/agents/job-leases.js';
import {
  DEVELOPMENT_BRANCH_PREFIX,
  type DevelopmentFileChange,
} from '../../../packages/contracts/src/index.js';
import type { AgentTool } from './copilot.adapter.js';
import { PullRequestError, type PullRequestProvider } from './pr-providers.js';
import type {
  AttemptCheckout,
  CommandResult,
  WorkspaceManager,
  WorkspaceOwner,
} from './workspace-manager.js';

/** Operações persistentes do desenvolvimento usadas pelo executor (fencing no backend). */
export interface DevelopmentPort {
  claimWorkspace(lease: JobLease): Promise<DevelopmentRunContext | 'stale' | 'unavailable'>;
  fixBase(lease: JobLease, workspaceId: string, baseSha: string): Promise<FencedWrite>;
  recordTest(lease: JobLease, workspaceId: string, test: TestRecordInput): Promise<FencedWrite>;
  recordRevision(
    lease: JobLease,
    workspaceId: string,
    input: RevisionInput,
  ): Promise<FencedWrite | 'unchanged'>;
  recordPublication(
    lease: JobLease,
    workspaceId: string,
    input: PublicationInput,
  ): Promise<{ outcome: FencedWrite; number: number | null }>;
  releaseWorkspace(lease: JobLease, workspaceId: string, failed: boolean): Promise<void>;
}

/** Falha funcional do desenvolvimento (código registado no run). */
export class DevelopmentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DevelopmentFailure';
  }
}

/** A tentativa perdeu a posse do run ou do workspace: nenhuma escrita adicional. */
export class DevelopmentStale extends Error {
  constructor() {
    super('Tentativa sem posse do workspace.');
    this.name = 'DevelopmentStale';
  }
}

export interface PreparedDevelopment {
  runId: string;
  context: DevelopmentRunContext;
  checkout: AttemptCheckout;
  baseSha: string;
  /** Head confirmado antes desta tentativa (`null` na primeira). */
  previousHead: string | null;
}

export interface DevelopmentOutcome {
  headSha: string;
  testsPassed: boolean;
  diff: string;
  files: DevelopmentFileChange[];
  publications: { kind: 'branch' | 'pull_request'; state: PublicationInput['state'] }[];
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const accepted = (outcome: FencedWrite | 'unchanged') => {
  if (outcome === 'stale') throw new DevelopmentStale();
};

/**
 * P08: desenvolvimento num checkout Git isolado. Prepara o worktree da tentativa a partir do head
 * confirmado (ou da base fixada), disponibiliza a ferramenta de testes, faz o commit, executa os
 * testes finais sobre o commit, regista diff/revisão com CAS e publica (branch/PR) de forma
 * idempotente. Todas as escritas exigem a posse atual do run e do workspace.
 */
export class DevelopmentRunner {
  constructor(
    private readonly store: DevelopmentPort,
    private readonly manager: WorkspaceManager,
    private readonly options: {
      pullRequests?: Partial<Record<'github', PullRequestProvider>>;
      log?: (event: Record<string, unknown>) => void;
    } = {},
  ) {}

  async prepare(
    runId: string,
    lease: JobLease,
    owner?: WorkspaceOwner,
  ): Promise<PreparedDevelopment> {
    const context = await this.store.claimWorkspace(lease);
    if (context === 'stale') throw new DevelopmentStale();
    if (context === 'unavailable')
      throw new DevelopmentFailure('repository_unavailable', 'Repositório indisponível.');
    const { workspace, repository } = context;
    if (!workspace.branch.startsWith(DEVELOPMENT_BRANCH_PREFIX))
      throw new DevelopmentFailure('invalid_branch', 'Branch de trabalho inválida.');
    if (!repository.allowedRefs.includes(workspace.baseBranch))
      throw new DevelopmentFailure('base_not_allowed', 'Branch base não autorizada.');
    const fetched = await this.manager
      .fetchBase({
        projectId: repository.projectId,
        workspaceId: workspace.id,
        url: repository.url,
        baseBranch: workspace.baseBranch,
        credential: context.credential,
      })
      .catch((error: unknown) => {
        throw new DevelopmentFailure(
          'repository_fetch_failed',
          error instanceof Error ? error.message : 'Falha ao obter o repositório.',
        );
      });
    const baseSha = workspace.baseSha ?? fetched.remoteBaseSha;
    if (!workspace.baseSha) accepted(await this.store.fixBase(lease, workspace.id, baseSha));
    if (!(await this.manager.hasCommit(fetched.gitDir, baseSha)))
      throw new DevelopmentFailure('base_unavailable', 'O commit base já não está disponível.');
    const previousHead = workspace.headSha;
    if (previousHead && !(await this.manager.hasCommit(fetched.gitDir, previousHead)))
      throw new DevelopmentFailure('workspace_lost', 'O commit anterior do workspace perdeu-se.');
    const checkout = await this.manager.checkout(
      fetched.gitDir,
      `${runId.slice(0, 8)}-${lease.epoch}`,
      previousHead ?? baseSha,
      ...(owner ? [owner] : []),
    );
    try {
      for (const command of repository.setupCommands) {
        const result = await this.manager.runConfigured(checkout, command);
        if (result.exitCode !== 0)
          throw new DevelopmentFailure(
            'setup_failed',
            `Preparação «${command.name}» falhou: ${result.log.slice(-500)}`,
          );
      }
    } catch (error) {
      // Preparação parcial: o worktree criado não fica para trás (o erro original prevalece).
      await this.manager.removeCheckout(checkout).catch((cleanup: unknown) =>
        this.options.log?.({
          event: 'development.checkout_cleanup_failed',
          runId,
          message: cleanup instanceof Error ? cleanup.message.slice(0, 300) : undefined,
        }),
      );
      throw error;
    }
    this.options.log?.({
      event: 'development.prepared',
      runId,
      workspaceId: workspace.id,
      baseSha,
      startSha: checkout.startSha,
    });
    return { runId, context, checkout, baseSha, previousHead };
  }

  /** Texto de contexto para o prompt (checkout, base e feedback de rejeições anteriores). */
  promptSources(prepared: PreparedDevelopment) {
    const { workspace, repository } = prepared.context;
    return [
      `Checkout Git isolado do repositório (diretório atual), branch de trabalho ${workspace.branch} sobre ${workspace.baseBranch} @ ${prepared.baseSha.slice(0, 12)}${prepared.previousHead ? `, a continuar do commit ${prepared.previousHead.slice(0, 12)}` : ''}.`,
      `Testes configurados (executar com zeroops_run_tests): ${repository.testCommands.map((command) => `«${command.name}»`).join(', ')}.`,
      ...prepared.context.feedback.map((item) => `Feedback do review a corrigir: ${item}`),
    ];
  }

  /** Ferramenta `zeroops_run_tests`: corre os testes configurados e regista cada execução. */
  testTool(prepared: PreparedDevelopment, lease: JobLease, isActive: () => boolean): AgentTool {
    return {
      name: 'zeroops_run_tests',
      description:
        'Executa os comandos de teste configurados para este repositório no checkout atual e devolve os resultados (só estes contam como testes executados).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome de um teste configurado (opcional).' },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!isActive()) return { ok: false, text: 'Tentativa sem posse do run.' };
        const wanted =
          args && typeof (args as { name?: unknown }).name === 'string'
            ? (args as { name: string }).name
            : null;
        const commands = prepared.context.repository.testCommands.filter(
          (command) => !wanted || command.name === wanted,
        );
        if (!commands.length) return { ok: false, text: 'Teste desconhecido.' };
        const tree = await this.manager.workingTree(prepared.checkout);
        const lines: string[] = [];
        let ok = true;
        for (const command of commands) {
          const result = await this.manager.runConfigured(prepared.checkout, command);
          await this.record(lease, prepared, 'agent', command, result, null, tree);
          ok &&= result.exitCode === 0;
          lines.push(
            `### ${command.name}: ${result.timedOut ? 'tempo esgotado' : `exit ${result.exitCode}`}\n${result.log.slice(-2000)}`,
          );
        }
        return { ok, text: lines.join('\n\n') };
      },
    };
  }

  /**
   * Commit do trabalho, testes finais sobre o commit exato, diff completo do Git e revisão (CAS
   * sobre o head anterior). Publica só quando os testes finais passaram.
   */
  async finalize(
    prepared: PreparedDevelopment,
    lease: JobLease,
    isActive: () => boolean,
  ): Promise<DevelopmentOutcome> {
    const { workspace, repository } = prepared.context;
    const { checkout, baseSha } = prepared;
    const headSha = await this.manager.commit(
      checkout,
      checkout.startSha,
      `${workspace.ticketKey}: ${workspace.ticketTitle}\n\nZeroOps run ${prepared.runId} (época ${lease.epoch})`,
    );
    if (headSha === baseSha)
      throw new DevelopmentFailure('development_no_changes', 'O desenvolvimento não alterou nada.');
    if (!isActive()) throw new DevelopmentStale();
    const tree = (
      await runGit(['--git-dir', checkout.gitDir, 'rev-parse', `${headSha}^{tree}`])
    ).stdout.trim();
    const tests: { command: string; exitCode: number; evidenceHash: string; testedSha: string }[] =
      [];
    let testsPassed = true;
    for (const command of repository.testCommands) {
      const result = await this.manager.runConfigured(checkout, command);
      await this.record(lease, prepared, 'final', command, result, headSha, tree);
      if (result.exitCode !== 0 || result.timedOut) testsPassed = false;
      else
        tests.push({
          command: command.command,
          exitCode: 0,
          evidenceHash: sha256(result.log),
          testedSha: headSha,
        });
    }
    const { diff, files } = await this.manager.diff(checkout.gitDir, baseSha, headSha);
    const present = files.filter((file) => file.status !== 'D').map((file) => file.path);
    const removed = files
      .flatMap((file) =>
        file.status === 'D' ? [file.path] : file.status === 'R' ? [file.previousPath ?? ''] : [],
      )
      .filter(Boolean);
    const manifest = testsPassed
      ? {
          vcs: {
            kind: 'git' as const,
            repositoryId: repository.id,
            url: repository.url,
            branch: workspace.branch,
            baseSha,
            headSha,
            diffSha256: sha256(diff),
          },
          files: await this.manager.fileHashes(checkout.gitDir, headSha, present),
          removed,
          tests,
          sqlFiles: present.filter((path) => /^sql\/[a-z0-9_]+\.sql$/.test(path)),
        }
      : null;
    accepted(
      await this.store.recordRevision(lease, workspace.id, {
        expectedHead: prepared.previousHead,
        baseSha,
        headSha,
        diff,
        files,
        testsPassed,
        manifest,
      }),
    );
    await this.manager.updateBranch(checkout.gitDir, workspace.branch, headSha, null);
    const publications =
      testsPassed && workspace.publish !== 'none'
        ? await this.publish(prepared, lease, headSha, isActive)
        : [];
    return { headSha, testsPassed, diff, files, publications };
  }

  /**
   * Publicação idempotente: reconcilia sempre o estado remoto antes de enviar; nunca faz force
   * push. Um resultado de rede incerto fica `uncertain` e é reconciliado na próxima tentativa.
   */
  private async publish(
    prepared: PreparedDevelopment,
    lease: JobLease,
    headSha: string,
    isActive: () => boolean,
  ) {
    const { workspace, repository, credential } = prepared.context;
    const remoteRef = `refs/heads/${workspace.branch}`;
    const results: DevelopmentOutcome['publications'] = [];
    const record = async (input: PublicationInput) => {
      if (!isActive()) throw new DevelopmentStale();
      const outcome = await this.store.recordPublication(lease, workspace.id, input);
      if (outcome.outcome === 'stale') throw new DevelopmentStale();
      results.push({ kind: input.kind, state: input.state });
      return outcome;
    };
    if (!isActive()) throw new DevelopmentStale();
    const branchState = await this.pushBranch(prepared, headSha);
    await record({
      kind: 'branch',
      provider: 'git',
      state: branchState.state,
      remoteRef,
      headSha,
      error: branchState.error ?? null,
    });
    if (workspace.publish !== 'pull_request' || branchState.state !== 'published') return results;
    if (repository.prProvider === 'zeroops') {
      await record({
        kind: 'pull_request',
        provider: 'zeroops',
        state: 'published',
        remoteRef,
        headSha,
      });
      return results;
    }
    const provider = this.options.pullRequests?.github;
    if (!provider) {
      await record({
        kind: 'pull_request',
        provider: 'github',
        state: 'failed',
        remoteRef,
        headSha,
        error: 'Provider GitHub não configurado.',
      });
      return results;
    }
    try {
      const pr = await provider.ensure({
        repositoryUrl: repository.url,
        credential,
        head: workspace.branch,
        base: workspace.baseBranch,
        title: `${workspace.ticketKey}: ${workspace.ticketTitle}`.slice(0, 200),
        body: `Alteração preparada pelo ZeroOps (ticket ${workspace.ticketKey}).`,
      });
      await record({
        kind: 'pull_request',
        provider: 'github',
        state: 'published',
        remoteRef,
        headSha,
        number: pr.number,
        url: pr.url,
      });
    } catch (error) {
      if (error instanceof DevelopmentStale) throw error;
      await record({
        kind: 'pull_request',
        provider: 'github',
        state: error instanceof PullRequestError && error.uncertain ? 'uncertain' : 'failed',
        remoteRef,
        headSha,
        error: error instanceof Error ? error.message : 'Falha ao criar o PR.',
      });
    }
    return results;
  }

  private async pushBranch(
    prepared: PreparedDevelopment,
    headSha: string,
  ): Promise<{ state: PublicationInput['state']; error?: string }> {
    const { workspace, repository, credential } = prepared.context;
    const { gitDir } = prepared.checkout;
    const options = { credential };
    const remote = async () => remoteBranchSha(repository.url, workspace.branch, options);
    let current: string | null;
    try {
      current = await remote();
    } catch (error) {
      return { state: 'uncertain', error: message(error) };
    }
    if (current === headSha) return { state: 'published' };
    if (current) {
      // Só avança a branch remota se o head atual for descendente do que lá está (sem force).
      const known =
        (await this.manager.hasCommit(gitDir, current)) ||
        (await runGit(
          [
            '--git-dir',
            gitDir,
            'fetch',
            '--no-tags',
            '--quiet',
            repository.url,
            `+refs/heads/${workspace.branch}:refs/remotes/published/${workspace.branch}`,
          ],
          options,
        ).then(
          () => true,
          () => false,
        ));
      const ancestor =
        known &&
        (await runGit(['--git-dir', gitDir, 'merge-base', '--is-ancestor', current, headSha]).then(
          () => true,
          () => false,
        ));
      if (!ancestor)
        return { state: 'conflict', error: 'A branch remota divergiu do workspace (sem force).' };
    }
    try {
      await runGit(
        [
          '--git-dir',
          gitDir,
          'push',
          '--quiet',
          repository.url,
          `${headSha}:refs/heads/${workspace.branch}`,
        ],
        { ...options, timeoutMs: 300_000 },
      );
      return { state: 'published' };
    } catch (error) {
      // Resultado incerto: confirmar o estado remoto antes de decidir.
      const after = await remote().catch(() => undefined);
      if (after === headSha) return { state: 'published' };
      if (error instanceof GitCommandError && error.uncertain && after === undefined)
        return { state: 'uncertain', error: message(error) };
      return { state: after && after !== current ? 'conflict' : 'failed', error: message(error) };
    }
  }

  private async record(
    lease: JobLease,
    prepared: PreparedDevelopment,
    phase: 'agent' | 'final',
    command: { name: string; command: string },
    result: CommandResult,
    testedSha: string | null,
    tree: string,
  ) {
    accepted(
      await this.store.recordTest(lease, prepared.context.workspace.id, {
        phase,
        name: command.name,
        command: command.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        testedSha: testedSha && GIT_SHA.test(testedSha) ? testedSha : null,
        workingTreeHash: GIT_SHA.test(tree) ? tree : null,
        log: result.log,
        durationMs: result.durationMs,
      }),
    );
  }

  /**
   * Fim da tentativa: remove o worktree (o bare e a branch ficam) e liberta o workspace. Os dois
   * passos correm sempre; uma falha a remover o worktree é propagada (F02: o chamador não pode
   * tratar a limpeza como confirmada).
   */
  async release(prepared: PreparedDevelopment | null, lease: JobLease, failed: boolean) {
    if (!prepared) return;
    const removal = await this.manager.removeCheckout(prepared.checkout).then(
      () => null,
      (error: unknown) => error,
    );
    await this.store
      .releaseWorkspace(lease, prepared.context.workspace.id, failed)
      .catch((error: unknown) =>
        this.options.log?.({
          event: 'development.workspace_release_failed',
          runId: prepared.runId,
          message: error instanceof Error ? error.message.slice(0, 300) : undefined,
        }),
      );
    if (removal) {
      this.options.log?.({
        event: 'development.checkout_cleanup_failed',
        runId: prepared.runId,
        message: removal instanceof Error ? removal.message.slice(0, 300) : undefined,
      });
      throw removal;
    }
  }

  /** Limpeza por retenção: o diretório do workspace (artefactos ficam na BD). */
  async cleanup(
    candidates: { id: string; project_id: string }[],
    markCleaned: (id: string) => Promise<boolean>,
  ) {
    for (const candidate of candidates) {
      if (!(await markCleaned(candidate.id))) continue;
      await this.manager.destroy(candidate.project_id, candidate.id).catch(() => undefined);
      this.options.log?.({ event: 'development.workspace_cleaned', workspaceId: candidate.id });
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : 'erro desconhecido';
}
