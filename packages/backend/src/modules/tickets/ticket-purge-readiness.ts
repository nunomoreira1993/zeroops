import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TicketPurgeTarget } from './project-ticket-purge.js';

export const ticketPurgeProtocol = 'zeroops.ticket-purge.v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime();
const targetSchema = z.strictObject({
  projectId: z.uuid(),
  projectName: z.string().min(1),
  databaseName: z.string().min(1),
  databaseHost: z.string().min(1),
  actorId: z.uuid(),
});

/** Operator evidence, not a feature flag: every deployed instance and external boundary is covered. */
export const ticketPurgeReadinessSchema = z.strictObject({
  protocol: z.literal(ticketPurgeProtocol),
  target: targetSchema,
  scopeDigest: hash,
  runtimeFingerprint: hash,
  approvedRevision: revision,
  checkedAt: timestamp,
  validUntil: timestamp,
  deploymentAuthorized: z.literal(true),
  processInventoryEvidenceSha256: hash,
  allRuntimeInstancesCovered: z.literal(true),
  legacyRuntimeInstances: z.literal(0),
  runtimes: z
    .array(
      z.strictObject({
        role: z.enum(['api', 'worker', 'executor']),
        instances: z
          .array(
            z.strictObject({
              instanceId: z.string().min(1).max(200),
              revision,
              runtimeFingerprint: hash,
              deployedAt: timestamp,
              startedAt: timestamp,
            }),
          )
          .min(1),
      }),
    )
    .length(3),
  quiescence: z.strictObject({
    leaseId: z.uuid(),
    heldUntil: timestamp,
    ticketWritesBlocked: z.literal(true),
    ticketExecutorsPaused: z.literal(true),
    activeTicketProcesses: z.literal(0),
    healthCollectionContinuing: z.literal(true),
    healthEmailDeliveryContinuing: z.literal(true),
    evidenceSha256: hash,
  }),
  artifacts: z.strictObject({
    inventoryComplete: z.literal(true),
    exclusiveTicketArtifactsRemaining: z.literal(0),
    orphanTicketWorkspaces: z.literal(0),
    externalTicketQueueItemsRemaining: z.literal(0),
    evidenceSha256: hash,
  }),
});
export type TicketPurgeReadiness = z.infer<typeof ticketPurgeReadinessSchema>;

/** Fingerprint the actual deployed files, not a claimed source version or CLI version label. */
export async function ticketPurgeRuntimeFingerprint() {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const modules = [
    './ticket-purge-health',
    '../../database/ticket-maintenance',
    './tickets.service',
    '../identity/membership',
    '../health/health-tickets',
    '../health/health-incidents',
    '../health/health-monitor',
    '../health/health.repository',
    '../agents/agent-runs.service',
    '../agents/agent-auto-runs',
    '../flows/flow-assistant',
    '../flows/flow-engine',
    '../notifications/outbox',
    './ticket-purge-readiness',
    './project-ticket-purge',
  ];
  const digest = createHash('sha256');
  for (const module of modules) {
    digest.update(module);
    digest.update(
      (await readFile(new URL(module + extension, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    );
  }
  return digest.digest('hex');
}

/** Validates the operator's complete deployment/process/artifact evidence, target and short-lived digests. */
export function verifyTicketPurgeReadiness(
  input: unknown,
  target: TicketPurgeTarget,
  scopeDigest: string,
  runtimeFingerprint: string,
  now = Date.now(),
) {
  const parsed = ticketPurgeReadinessSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      'Verified runtime/quiescence/artifact attestation required (invalid or missing evidence).',
    );
  const proof = parsed.data;
  for (const field of Object.keys(target) as Array<keyof TicketPurgeTarget>)
    if (proof.target[field] !== target[field])
      throw new Error(`Readiness target mismatch: ${field}.`);
  if (proof.scopeDigest !== scopeDigest || proof.runtimeFingerprint !== runtimeFingerprint)
    throw new Error(
      'Readiness scope/runtime digest mismatch; verify deployment and repeat dry-run.',
    );
  const checked = Date.parse(proof.checkedAt);
  const until = Date.parse(proof.validUntil);
  if (checked > now + 30000 || checked < now - 300000 || until <= now || until > checked + 300000)
    throw new Error('Readiness evidence expired/not current (maximum five-minute validity).');
  if (Date.parse(proof.quiescence.heldUntil) < until)
    throw new Error('Quiescence lease must cover the complete evidence validity window.');
  if (new Set(proof.runtimes.map((runtime) => runtime.role)).size !== 3)
    throw new Error('API, worker and executor must all be independently verified.');
  const instanceIds = new Set<string>();
  for (const runtime of proof.runtimes)
    for (const instance of runtime.instances) {
      if (instanceIds.has(instance.instanceId))
        throw new Error('Duplicate runtime instance evidence.');
      instanceIds.add(instance.instanceId);
      if (
        instance.revision !== proof.approvedRevision ||
        instance.runtimeFingerprint !== runtimeFingerprint
      )
        throw new Error('Deployed runtime revision/fingerprint differs from the reviewed build.');
      const deployed = Date.parse(instance.deployedAt);
      const started = Date.parse(instance.startedAt);
      if (deployed > started || started > checked)
        throw new Error(
          'Runtime must have restarted after verified deployment and before verification.',
        );
    }
  return {
    proof,
    attestationDigest: createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
  };
}
