import { z } from 'zod';
import type { DeliveryRunView } from './delivery.js';

/**
 * P08 — Workspace Git, desenvolvimento e review dinâmico.
 *
 * Recursos Git por projeto, configuração das etapas `copilot_task` em modo `develop` e das
 * decisões humanas com review, e as vistas internas do desenvolvimento de um ticket.
 */

/** Prefixo obrigatório das branches de trabalho: nunca coincide com uma branch protegida. */
export const DEVELOPMENT_BRANCH_PREFIX = 'zeroops/';

const refName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._/-]+$/, 'Referência inválida.')
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.lock') &&
      !value.includes('..') &&
      !value.includes('//') &&
      !value.startsWith('-'),
    'Referência inválida.',
  );

export const gitRefNameSchema = refName;

const commandSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9 ._:-]+$/),
  command: z.string().trim().min(1).max(500),
  timeoutSeconds: z.number().int().min(5).max(1800).default(300),
});
export type DevelopmentCommand = z.infer<typeof commandSchema>;

/** URL do repositório sem credenciais embutidas (`file://` ou `https://`). */
export const gitRepositoryUrlSchema = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'file:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'URL inválido: use https:// ou file:// sem credenciais.');

export const gitRepositoryInputSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[\p{L}\p{N} ._-]+$/u),
    url: gitRepositoryUrlSchema,
    baseBranch: refName,
    allowedRefs: z.array(refName).min(1).max(20),
    setupCommands: z.array(commandSchema).max(10).default([]),
    testCommands: z.array(commandSchema).min(1).max(10),
    prProvider: z.enum(['zeroops', 'github']).default('zeroops'),
    /** Token de acesso (só escrita; nunca é devolvido). `null` remove; ausente mantém. */
    credential: z.string().min(8).max(500).nullable().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .refine((input) => input.allowedRefs.includes(input.baseBranch), {
    message: 'A branch base tem de estar nas referências autorizadas.',
    path: ['baseBranch'],
  })
  .refine((input) => !input.allowedRefs.some((ref) => ref.startsWith(DEVELOPMENT_BRANCH_PREFIX)), {
    message: 'As branches de trabalho do ZeroOps não podem ser referências base.',
    path: ['allowedRefs'],
  });
export type GitRepositoryInput = z.infer<typeof gitRepositoryInputSchema>;

export const gitRepositoryArchiveSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
});

export const gitRepositoryCredentialRevokeSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
});

export interface GitRepositoryView {
  id: string;
  projectId: string;
  name: string;
  url: string;
  baseBranch: string;
  allowedRefs: string[];
  setupCommands: DevelopmentCommand[];
  testCommands: DevelopmentCommand[];
  prProvider: 'zeroops' | 'github';
  hasCredential: boolean;
  credentialProvider: 'token' | 'github_cli';
  credentialIdentity: string | null;
  version: number;
  archived: boolean;
  verifiedAt: string | null;
  verifiedBaseSha: string | null;
  verificationError: string | null;
  updatedAt: string;
}

export const developmentPublishModes = ['none', 'branch', 'pull_request'] as const;
export type DevelopmentPublishMode = (typeof developmentPublishModes)[number];

export interface NodeLike {
  op: string;
  label?: string;
  config: Record<string, unknown>;
}

/** Repositório e publicação de uma etapa `develop` (sem repositório = comportamento anterior). */
export function developmentNodeConfig(node: NodeLike): {
  repositoryId: string | null;
  publish: DevelopmentPublishMode;
} {
  const repositoryId =
    typeof node.config.repositoryId === 'string' && node.config.repositoryId
      ? node.config.repositoryId
      : null;
  const publish = developmentPublishModes.includes(node.config.publish as DevelopmentPublishMode)
    ? (node.config.publish as DevelopmentPublishMode)
    : 'none';
  return { repositoryId, publish };
}

export const reviewRules = ['any', 'all', 'quorum'] as const;
export type ReviewRule = (typeof reviewRules)[number];

export const flowReviewConfigSchema = z
  .strictObject({
    /** Etapa `develop` cujo artefacto (commit) é revisto. */
    sourceNode: z.string().trim().min(1).max(64),
    reviewers: z.strictObject({
      userIds: z.array(z.uuid()).max(20).default([]),
      roles: z
        .array(z.enum(['technical', 'qa', 'release', 'admin']))
        .max(4)
        .default([]),
    }),
    rule: z.enum(reviewRules).default('any'),
    quorum: z.number().int().min(1).max(20).optional(),
    /** O autor do pedido não pode rever a alteração (separação de responsabilidades). */
    separationOfDuties: z.boolean().default(true),
    /** Override explícito: um administrador pode decidir fora da lista (fica auditado). */
    adminOverride: z.boolean().default(false),
  })
  .refine((value) => value.reviewers.userIds.length + value.reviewers.roles.length > 0, {
    message: 'Indique pelo menos um revisor ou grupo.',
    path: ['reviewers'],
  })
  .refine((value) => (value.rule === 'quorum') === (value.quorum !== undefined), {
    message: 'O quórum só se indica (e é obrigatório) na regra quorum.',
    path: ['quorum'],
  });
export type FlowReviewConfig = z.infer<typeof flowReviewConfigSchema>;

/** Review configurado numa decisão humana (`null` = decisão normal, comportamento anterior). */
export function flowReviewConfig(node: NodeLike): FlowReviewConfig | null {
  if (node.op !== 'human_decision' || node.config.review === undefined) return null;
  const parsed = flowReviewConfigSchema.safeParse(node.config.review);
  return parsed.success ? parsed.data : null;
}

/** Problemas da configuração de desenvolvimento/review (validação estrutural do P02). */
export function developmentConfigIssues(
  node: NodeLike,
  nodes: ReadonlyMap<string, NodeLike>,
  options: { members?: ReadonlySet<string>; repositories?: ReadonlySet<string> } = {},
): string[] {
  const issues: string[] = [];
  if (node.op === 'copilot_task') {
    const raw = node.config;
    if (raw.repositoryId !== undefined) {
      if (raw.mode !== 'develop') issues.push('só as etapas de desenvolvimento usam repositório.');
      if (!z.uuid().safeParse(raw.repositoryId).success) issues.push('repositório inválido.');
      else if (options.repositories && !options.repositories.has(String(raw.repositoryId)))
        issues.push('o repositório não existe neste projeto ou está arquivado.');
    }
    if (raw.publish !== undefined) {
      if (!developmentPublishModes.includes(raw.publish as DevelopmentPublishMode))
        issues.push('modo de publicação inválido.');
      else if (raw.publish !== 'none' && raw.repositoryId === undefined)
        issues.push('publicar exige um repositório Git.');
    }
  }
  if (node.config.review !== undefined) {
    if (node.op !== 'human_decision') {
      issues.push('o review só se configura numa decisão humana.');
      return issues;
    }
    const parsed = flowReviewConfigSchema.safeParse(node.config.review);
    if (!parsed.success) {
      issues.push(
        `review inválido: ${parsed.error.issues
          .slice(0, 2)
          .map((issue) => issue.message)
          .join('; ')}`,
      );
      return issues;
    }
    const source = nodes.get(parsed.data.sourceNode);
    if (
      !source ||
      source.op !== 'copilot_task' ||
      source.config.mode !== 'develop' ||
      typeof source.config.repositoryId !== 'string'
    )
      issues.push('o review tem de apontar para uma etapa de desenvolvimento com repositório.');
    if (
      parsed.data.rule === 'quorum' &&
      parsed.data.reviewers.roles.length === 0 &&
      (parsed.data.quorum ?? 0) > parsed.data.reviewers.userIds.length
    )
      issues.push('o quórum excede o número de revisores.');
    if (options.members)
      for (const userId of parsed.data.reviewers.userIds)
        if (!options.members.has(userId)) issues.push('um revisor não é membro ativo do projeto.');
  }
  return issues;
}

/** Ficheiro alterado no diff completo (A/M/D/R obtidos do Git, não do relatório do modelo). */
export interface DevelopmentFileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  path: string;
  previousPath?: string | null;
}

export interface DevelopmentTestRunView {
  id: string;
  agentRunId: string | null;
  phase: 'agent' | 'final';
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  testedSha: string | null;
  workingTreeHash: string | null;
  logSha256: string;
  log: string;
  durationMs: number;
  createdAt: string;
}

export interface DevelopmentRevisionView {
  id: string;
  agentRunId: string | null;
  baseSha: string;
  headSha: string;
  diffSha256: string;
  scopeHash: string;
  files: DevelopmentFileChange[];
  testsPassed: boolean;
  candidateHash: string | null;
  createdAt: string;
}

export interface DevelopmentPublicationView {
  id: string;
  kind: 'branch' | 'pull_request';
  provider: 'git' | 'zeroops' | 'github';
  state: 'pending' | 'published' | 'uncertain' | 'conflict' | 'failed';
  headSha: string | null;
  remoteRef: string | null;
  number: number | null;
  url: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface DevelopmentReviewDecisionView {
  id: string;
  stepId: string;
  actor: { id: string; displayName: string };
  port: string;
  headSha: string;
  scopeHash: string;
  comment: string | null;
  override: boolean;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  createdAt: string;
}

export interface DevelopmentWorkspaceView {
  id: string;
  nodeId: string;
  repository: { id: string; name: string; url: string; prProvider: 'zeroops' | 'github' };
  branch: string;
  baseBranch: string;
  baseSha: string | null;
  headSha: string | null;
  state: 'pending' | 'active' | 'idle' | 'failed' | 'cleaned';
  publish: DevelopmentPublishMode;
  currentRunId: string | null;
  ownerEpoch: number | null;
  retentionUntil: string | null;
  diff: string | null;
  diffTruncated: boolean;
  revisions: DevelopmentRevisionView[];
  tests: DevelopmentTestRunView[];
  publications: DevelopmentPublicationView[];
  reviews: DevelopmentReviewDecisionView[];
  /** Revisores e regra da etapa de review atual (quando existe). */
  review: {
    stepId: string;
    nodeId: string;
    rule: ReviewRule;
    required: number;
    approvals: number;
    reviewers: { id: string; displayName: string }[];
    canDecide: boolean;
  } | null;
  /** Entregas por pipeline (P09) deste workspace; `available=false` sem etapa de entrega. */
  pipeline: { available: boolean; reason: string | null; deliveries: DeliveryRunView[] };
}

export interface TicketDevelopmentView {
  ticketId: string;
  workspaces: DevelopmentWorkspaceView[];
}

/** Hash do âmbito revisto: repositório, base, head e conteúdo exato do diff. */
export function developmentScopeInput(input: {
  repositoryId: string;
  baseSha: string;
  headSha: string;
  diffSha256: string;
}) {
  return JSON.stringify([input.repositoryId, input.baseSha, input.headSha, input.diffSha256]);
}
