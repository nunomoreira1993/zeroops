import { describe, expect, it } from 'vitest';
import { agentProfileDefinitionSchema } from './agent-profiles.js';
import { flowDefinitionSchema } from './flows.js';

const valid = {
  name: 'Investigar incidente',
  description: 'Perfil reutilizável.',
  mission: 'Investigar com evidência e identificar o próximo passo.',
  expectedInputs: ['Pedido do ticket'],
  expectedOutput: 'Conclusão com fonte e pontos em falta.',
  completionCriteria: ['Distinguir factos de hipóteses.'],
  modes: ['analysis'],
  allowedTools: ['log'],
  model: null,
  fusionTier: null,
  reasoningEffort: null,
};

describe('ZeroOps agent profile contract', () => {
  it('accepts a bounded mission with explicit supported modes and read-tool allowlist', () => {
    expect(agentProfileDefinitionSchema.parse(valid)).toMatchObject({
      modes: ['analysis'],
      allowedTools: ['log'],
    });
  });

  it('pins a complete profile version and bounded repository references in a Copilot flow', () => {
    const definition = flowDefinitionSchema.parse({
      start: 'investigate',
      nodes: [
        {
          id: 'investigate',
          op: 'copilot_task',
          label: 'Investigar',
          config: {
            agentProfileId: '00000000-0000-4000-8000-000000000001',
            agentProfileVersion: 2,
            repositoryResources: [{ path: '.github/agents/health.agent.md', required: true }],
          },
        },
      ],
      edges: [],
    });
    expect(definition.nodes[0]?.config).toMatchObject({
      agentProfileVersion: 2,
      repositoryResources: [{ path: '.github/agents/health.agent.md', required: true }],
    });
  });

  it('rejects partial profile pins and malformed resource references while preserving legacy config', () => {
    const base = {
      start: 'investigate',
      nodes: [
        {
          id: 'investigate',
          op: 'copilot_task',
          label: 'Investigar',
          config: { executionMode: 'analysis' },
        },
      ],
      edges: [],
    };
    expect(flowDefinitionSchema.safeParse(base).success).toBe(true);
    expect(
      flowDefinitionSchema.safeParse({
        ...base,
        nodes: [
          {
            ...base.nodes[0],
            config: { agentProfileId: '00000000-0000-4000-8000-000000000001' },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      flowDefinitionSchema.safeParse({
        ...base,
        nodes: [
          {
            ...base.nodes[0],
            config: { repositoryResources: [{ path: '', required: true }] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported modes, write tools and empty completion criteria', () => {
    expect(
      agentProfileDefinitionSchema.safeParse({
        ...valid,
        modes: ['deploy'],
      }).success,
    ).toBe(false);
    expect(
      agentProfileDefinitionSchema.safeParse({
        ...valid,
        allowedTools: ['shell'],
      }).success,
    ).toBe(false);
    expect(
      agentProfileDefinitionSchema.safeParse({
        ...valid,
        completionCriteria: [],
      }).success,
    ).toBe(false);
  });
});
