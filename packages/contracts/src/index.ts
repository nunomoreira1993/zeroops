import { z } from 'zod';
import type {
  DependencyInvalidation,
  TicketParticipant,
  TicketResolution,
} from './ticket-governance.js';
import { siteKeys, type SiteKey } from './sites.js';
export * from './ticket-governance.js';
export * from './integrations.js';
export * from './agent-runs.js';
export * from './agent-config.js';
export * from './agent-profiles.js';
export * from './health.js';
export * from './alert-rules.js';
export * from './health-charts.js';
export * from './sites.js';
export * from './avatars.js';

export const roles = ['client', 'technical', 'qa', 'release', 'admin'] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;
export const statuses = [
  'new',
  'investigating',
  'awaiting_information',
  'awaiting_client',
  'awaiting_technical',
  'awaiting_confirmation',
  'implementing',
  'awaiting_qa',
  'awaiting_release',
  'deploying',
  'resolved',
  'blocked',
  'cancelled',
] as const;
export const statusSchema = z.enum(statuses);
export type TicketStatus = z.infer<typeof statusSchema>;
export interface User {
  id: string;
  projectId: string;
  email: string;
  displayName: string;
  role: Role;
  organization?: 'client' | 'deloitte' | null;
  locale?: 'pt-PT' | 'en';
  instanceAdmin?: boolean;
  /** A conta entrou com a palavra-passe temporária do convite e tem de definir uma nova. */
  passwordChangeRequired?: boolean;
  /** Versão da fotografia de perfil; `null`/ausente sem fotografia (mostra as iniciais). */
  avatarVersion?: number | null;
}
export interface Project {
  id: string;
  name: string;
  archived: boolean;
  /** Versão do logotipo do cliente; `null` quando o projeto não tem logotipo. */
  logoVersion: number | null;
}
export const projectLogoMimeTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;
export const PROJECT_LOGO_MAX_BYTES = 256 * 1024;
export const projectLogoSchema = z.strictObject({
  mime: z.enum(projectLogoMimeTypes),
  /** Conteúdo em base64 (sem prefixo `data:`). */
  data: z
    .string()
    .max(Math.ceil(PROJECT_LOGO_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type ProjectLogoInput = z.infer<typeof projectLogoSchema>;
/** URL autenticado do logotipo, versionado para a cache do browser. */
export const projectLogoUrl = (project: Pick<Project, 'id' | 'logoVersion'>) =>
  project.logoVersion === null
    ? null
    : `/api/projects/${encodeURIComponent(project.id)}/logo?v=${project.logoVersion}`;
export interface ProjectAccess extends Project {
  role: Role;
  organization: 'client' | 'deloitte' | null;
}
export interface InstanceProject extends Project {
  memberCount: number;
  clientName?: string;
  adminCount?: number;
  pendingAdminCount?: number;
  version: number;
  /** Site ligado ao projeto (código, instruções por omissão e relay); `null` sem site. */
  siteKey: SiteKey | null;
}
export interface InstanceUser {
  id: string;
  email: string;
  displayName: string;
  locale: IdentityLocale;
}
export const projectInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(50),
  initialAdminUserId: z.uuid(),
  siteKey: z.enum(siteKeys).nullable().optional(),
  confirmationToken: z.string().min(32).max(256),
  logo: projectLogoSchema.optional(),
});
export const projectUpdateSchema = z.strictObject({
  name: z.string().trim().min(2).max(50),
  archived: z.boolean(),
  siteKey: z.enum(siteKeys).nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(10).max(1000),
  confirmationToken: z.string().min(32).max(256),
});
export const projectAdminUpdateSchema = projectUpdateSchema.extend({
  archived: z.boolean().optional(),
  clientName: z.string().trim().min(2).max(200),
});
export interface AdministeredProject extends InstanceProject {
  clientName: string;
  adminCount: number;
  pendingAdminCount: number;
}
export type IdentityLocale = 'pt-PT' | 'en';
export interface AuthChallengeResponse {
  status: 'mfa_required' | 'enrollment_required';
  csrfToken: string;
}
export type AuthenticationResponse =
  (SessionResponse & { status: 'authenticated' }) | AuthChallengeResponse;
export interface MfaEnrollment {
  uri: string;
  secret: string;
}
export interface ManagedUser extends User {
  disabled: boolean;
  lockedUntil: string | null;
  mfaEnabled: boolean;
}
export interface ManagedInvitation {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  organization: 'client' | 'deloitte';
  locale: IdentityLocale;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  deliveryState?:
    'pending' | 'processing' | 'delivered' | 'failed' | 'blocked' | 'uncertain' | null;
}
export interface SessionResponse {
  user: User;
  csrfToken: string;
}
export const ticketEnvironmentSchema = z.enum(['development', 'quality', 'production']);
export type TicketEnvironment = z.infer<typeof ticketEnvironmentSchema>;
export const newTicketEnvironmentSchema = z.enum(['quality', 'production']);
export const createTicketSchema = z.strictObject({
  title: z.string().trim().min(5).max(180),
  description: z.string().trim().min(10).max(20000),
  category: z.enum(['incident', 'bug', 'improvement', 'question']),
  environment: newTicketEnvironmentSchema,
  priority: z.enum(['low', 'medium', 'high', 'critical']),
});
export type CreateTicket = z.infer<typeof createTicketSchema>;
export const updateTicketSchema = createTicketSchema
  .extend({
    environment: ticketEnvironmentSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export type UpdateTicket = z.infer<typeof updateTicketSchema>;
export interface Ticket extends Omit<CreateTicket, 'environment'> {
  environment: TicketEnvironment;
  id: string;
  key: string;
  projectId: string;
  createdBy: string;
  /** Nome do criador, incluído nas listagens de pedidos. */
  creatorName?: string;
  status: TicketStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface Comment {
  id: string;
  authorId: string;
  authorName: string;
  visibility: 'public' | 'internal';
  body: string;
  automated: boolean;
  authorKind: 'human' | 'agent' | 'system';
  authorRole: Role | null;
  authorOrganization: 'client' | 'deloitte' | null;
  /** Versão da fotografia do autor (ausente/`null` sem fotografia). */
  authorAvatarVersion?: number | null;
  /** Investigação do Copilot que gerou esta nota (só em notas do agente). */
  agentRunId?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface TicketCommentRevision {
  id: string;
  commentId: string;
  version: number;
  editorName: string;
  before: string | null;
  after: string;
  createdAt: string;
}
export const commentRevisionInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  body: z.string().trim().min(1).max(20000),
});
export interface TicketEvent {
  id: string;
  fromStatus: TicketStatus | null;
  toStatus: TicketStatus;
  createdAt: string;
}
export interface TicketRevisionSnapshot {
  title: string;
  description: string;
  category: Ticket['category'];
  environment: Ticket['environment'];
  priority: Ticket['priority'];
}
export interface TicketRevision {
  id: string;
  ticketVersion: number;
  actorName: string;
  before: TicketRevisionSnapshot | null;
  after: TicketRevisionSnapshot;
  createdAt: string;
}
export interface TicketAssignee {
  userId: string;
  displayName: string;
}
export interface TicketAssignments {
  client: TicketAssignee | null;
  technical: TicketAssignee | null;
  qa: TicketAssignee | null;
  release: TicketAssignee | null;
}
export const ticketAssignmentsInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  clientUserId: z.uuid().nullable(),
  technicalUserId: z.uuid().nullable(),
  qaUserId: z.uuid().nullable(),
  releaseUserId: z.uuid().nullable(),
});
export type TicketAssignmentsInput = z.infer<typeof ticketAssignmentsInputSchema>;
export const proposalInputSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  summary: z.string().trim().min(10).max(5000),
  steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
  risks: z.array(z.string().trim().min(1).max(2000)).max(30),
});
export interface Proposal {
  id: string;
  hash: string;
  version: number;
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
  risks: string[];
  createdAt: string;
}
export const decisionSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'reject']),
  notes: z.string().trim().max(5000),
});
/** Contrato versionado de uma transição manual do ticket, com nota obrigatória. */
export const transitionSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  action: z.enum(['investigate', 'request_information', 'resume', 'cancel', 'reopen']),
  notes: z.string().trim().min(3).max(5000),
});
export type TicketTransitionAction = z.infer<typeof transitionSchema>['action'];
export interface TicketDetail {
  ticket: Ticket;
  creatorName: string;
  comments: Comment[];
  commentRevisions: TicketCommentRevision[];
  events: TicketEvent[];
  revisions: TicketRevision[];
  assignments: TicketAssignments;
  participants: TicketParticipant[];
  resolution: TicketResolution | null;
  invalidations: DependencyInvalidation[];
  proposal: Proposal | null;
  approvalHash: string | null;
  blockers: string[];
}
export interface Metrics {
  total: number;
  open: number;
  resolved: number;
  firstResponseMeanMs: number | null;
  firstResponseCount: number;
  resolutionMeanMs: number | null;
  resolutionCount: number;
  tickets: {
    id: string;
    key: string;
    elapsedMs: number;
    waitingMs: number;
    activeStateMs: number;
    firstResponseMs: number | null;
  }[];
}
export interface Capabilities {
  investigation: boolean;
  implementation: boolean;
  deployment: boolean;
  blockers: string[];
}
export * from './flows.js';
export * from './incidents.js';
