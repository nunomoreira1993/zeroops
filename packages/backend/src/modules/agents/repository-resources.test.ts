import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { relevantRepositoryResources, RepositoryResources } from './repository-resources.js';

const sites = fileURLToPath(
  new URL('../../../../../tests/fixtures/agent-resource-sites/', import.meta.url),
);

describe('repository technical resources', () => {
  it('discovers only supported repository guidance and pins skill-linked resources by hash', async () => {
    const repository = new RepositoryResources(sites);
    const catalog = await repository.discover('pizzahut');
    expect(catalog.available).toBe(true);
    expect(catalog.resources.map((item) => item.path)).toEqual([
      '.github/agents/Logs.agent.md',
      '.github/skills/diagnose/SKILL.md',
      'AGENTS.md',
    ]);
    expect(catalog.resources.find((item) => item.path === 'AGENTS.md')).toMatchObject({
      globalInstruction: true,
    });
    expect(
      relevantRepositoryResources(catalog.resources, 'Investigar falha nos logs do servidor').map(
        (item) => item.path,
      ),
    ).toContain('.github/agents/Logs.agent.md');

    const snapshot = await repository.snapshot('pizzahut', [
      {
        path: '.github/agents/Logs.agent.md',
        required: true,
        selectionReason: 'relevance',
      },
      {
        path: '.github/skills/diagnose/SKILL.md',
        required: false,
        selectionReason: 'flow_selected',
      },
      { path: 'AGENTS.md', required: true, selectionReason: 'global_instruction' },
    ]);
    expect(snapshot.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.github/agents/Logs.agent.md',
          status: 'loaded',
          required: true,
          selectionReason: 'relevance',
        }),
        expect.objectContaining({
          path: '.github/skills/diagnose/SKILL.md',
          status: 'loaded',
          kind: 'skill',
          selectionReason: 'flow_selected',
        }),
        expect.objectContaining({
          path: 'AGENTS.md',
          status: 'loaded',
          selectionReason: 'global_instruction',
        }),
        expect.objectContaining({
          path: '.github/skills/diagnose/references/howto.md',
          status: 'loaded',
          reason: 'skill_resource:.github/skills/diagnose/SKILL.md',
          selectionReason: 'flow_selected',
        }),
      ]),
    );
    expect(snapshot.resources.every((item) => item.sha256?.length === 64)).toBe(true);
  });

  it('fails closed for unlisted traversal paths and an unavailable project root', async () => {
    const repository = new RepositoryResources(sites);
    const snapshot = await repository.snapshot('pizzahut', [
      { path: '../../outside.md', required: true },
    ]);
    expect(snapshot.resources[0]).toMatchObject({
      required: true,
      status: 'missing',
      content: null,
    });
    expect(await repository.discover('pizzamovil')).toMatchObject({
      available: false,
      reason: 'repository_unavailable',
      resources: [],
    });
    expect(await new RepositoryResources().discover('pizzahut')).toMatchObject({
      available: false,
      reason: 'repository_unavailable',
      resources: [],
    });
  });
});
