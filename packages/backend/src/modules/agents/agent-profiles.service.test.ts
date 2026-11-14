import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  flowDefinitionSchema,
  type FlowNode,
  type Role,
  type User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { AgentProfilesService } from './agent-profiles.service.js';
import { RepositoryResources } from './repository-resources.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let profiles: AgentProfilesService;
const sites = fileURLToPath(
  new URL('../../../../../tests/fixtures/agent-resource-sites/', import.meta.url),
);

beforeAll(async () => {
  fixture = await startTestDatabase();
  profiles = new AgentProfilesService(fixture.db, new RepositoryResources(sites));
});
afterAll(async () => {
  await fixture?.stop();
});

async function admin() {
  const projectId = randomUUID();
  const id = randomUUID();
  const actor: User = {
    id,
    projectId,
    role: 'admin',
    email: `${id}@example.test`,
    displayName: 'Profile admin',
  };
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Profiles']);
  await fixture.db.query(
    'INSERT INTO users(id,project_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [id, projectId, actor.email, actor.displayName, 'admin' satisfies Role, 'test-hash'],
  );
  return actor;
}

const draft = (name: string) => ({
  name,
  description: 'Perfil de teste',
  mission: 'Investigar apenas o comportamento explicitamente pedido.',
  expectedInputs: ['Pedido do ticket'],
  expectedOutput: 'Conclusão com evidência e lacunas.',
  completionCriteria: ['Distinguir factos de hipóteses.'],
  modes: ['analysis'] as const,
  allowedTools: ['log'] as const,
  model: null,
  fusionTier: null,
  reasoningEffort: null,
});

describe('AgentProfilesService', () => {
  it('seeds reusable defaults and creates immutable project-scoped versions', async () => {
    const actor = await admin();
    const catalog = await profiles.list(actor, actor.projectId);
    expect(catalog).toHaveLength(4);
    expect(catalog.every((item) => item.versions[0]?.version === 1)).toBe(true);

    const created = await profiles.create(actor, actor.projectId, draft('Runbook de teste'));
    expect(created).toMatchObject({ currentVersion: 1, archivedAt: null });
    const next = await profiles.addVersion(actor, actor.projectId, created.id, {
      expectedVersion: 1,
      definition: {
        ...draft('Runbook atualizado'),
        mission: 'Investigar a situação com evidência e apresentar uma conclusão.',
      },
    });
    expect(next.currentVersion).toBe(2);
    expect(next.versions.map((item) => item.version)).toEqual([1, 2]);

    const node: FlowNode = {
      id: 'investigate',
      op: 'copilot_task',
      label: 'Investigar',
      config: { agentProfileId: created.id, agentProfileVersion: 1, mode: 'analysis' },
    };
    const pinned = await profiles.profileForNode(fixture.db, actor.projectId, node, true);
    expect(pinned).toMatchObject({
      id: created.id,
      version: 1,
      definition: { name: 'Runbook de teste' },
    });
  });

  it('prevents archived and cross-project profile references from entering a new flow', async () => {
    const first = await admin();
    const other = await admin();
    const created = await profiles.create(first, first.projectId, draft('Privado'));
    const node: FlowNode = {
      id: 'investigate',
      op: 'copilot_task',
      label: 'Investigar',
      config: { agentProfileId: created.id, agentProfileVersion: 1, mode: 'analysis' },
    };
    await expect(
      profiles.profileForNode(fixture.db, other.projectId, node, false),
    ).rejects.toMatchObject({
      code: 'AGENT_PROFILE_REFERENCE_INVALID',
    });
    await profiles.archive(first, first.projectId, created.id);
    await expect(
      profiles.profileForNode(fixture.db, first.projectId, node, true),
    ).rejects.toMatchObject({
      code: 'AGENT_PROFILE_ARCHIVED',
    });
    expect(await profiles.profileForNode(fixture.db, first.projectId, node, false)).toMatchObject({
      id: created.id,
      version: 1,
    });
  });

  it('fails closed instead of saving a profile with an unavailable explicit model', async () => {
    const actor = await admin();
    await expect(
      profiles.create(actor, actor.projectId, {
        ...draft('Modelo indisponível'),
        model: 'not-in-project-catalog',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_PROFILE_MODEL_UNAVAILABLE' });
  });

  it('pins global instructions and relevance-selected repository resources per Copilot step', async () => {
    const actor = await admin();
    await fixture.db.query("UPDATE projects SET site_key='pizzahut' WHERE id=$1", [
      actor.projectId,
    ]);
    const profile = await profiles.create(actor, actor.projectId, {
      ...draft('Analisar logs'),
      mission: 'Investigar os logs da aplicação e identificar evidência técnica relevante.',
    });
    const definition = flowDefinitionSchema.parse({
      start: 'logs',
      nodes: [
        {
          id: 'logs',
          op: 'copilot_task',
          label: 'Analisar logs',
          config: {
            agentProfileId: profile.id,
            agentProfileVersion: profile.currentVersion,
            executionMode: 'analysis',
          },
        },
        {
          id: 'report',
          op: 'copilot_task',
          label: 'Relatório final',
          config: { executionMode: 'report' },
        },
      ],
      edges: [],
    });

    const snapshot = await profiles.snapshotForExecution(fixture.db, actor.projectId, definition);
    expect(snapshot.error).toBeNull();
    expect(snapshot.repositoryResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'AGENTS.md',
          status: 'loaded',
          required: true,
          selectionReason: 'global_instruction',
        }),
        expect.objectContaining({
          path: '.github/agents/Logs.agent.md',
          status: 'loaded',
          selectionReason: 'relevance',
        }),
      ]),
    );
    expect(snapshot.repositoryResourcePathsByNode.logs).toContain('AGENTS.md');
    expect(snapshot.repositoryResourcePathsByNode.logs).toContain('.github/agents/Logs.agent.md');
    expect(snapshot.repositoryResourcePathsByNode.report).toContain('AGENTS.md');
    expect(snapshot.repositoryResourcePathsByNode.report).not.toContain(
      '.github/agents/Logs.agent.md',
    );
    expect(snapshot.repositorySnapshotHashesByNode.logs).toMatch(/^[a-f0-9]{64}$/);
  });
});
