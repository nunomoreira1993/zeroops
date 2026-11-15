import { describe, expect, it } from 'vitest';
import type { InvestigationContext } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type { AgentProfileRunSnapshot } from '../../../packages/contracts/src/agent-profiles.js';
import { investigationPrompt } from './investigation-prompt.js';

const profile: AgentProfileRunSnapshot = {
  id: '00000000-0000-4000-8000-000000000001',
  version: 3,
  definition: {
    name: 'Investigar incidente',
    description: 'Perfil versionado.',
    mission: 'Investigar com evidência e identificar o próximo passo.',
    expectedInputs: ['Pedido', 'Ambiente'],
    expectedOutput: 'Conclusão com fonte e pontos em falta.',
    completionCriteria: ['Distinguir factos de hipóteses.'],
    modes: ['analysis'],
    allowedTools: ['log'],
    model: null,
    fusionTier: null,
    reasoningEffort: null,
  },
};

const context = {
  runId: 'run-1',
  lease: { jobId: 'run-1', workerId: 'w-test', epoch: 1, leaseSeconds: 90 },
  attempt: 1,
  mode: 'investigate',
  projectId: 'project-1',
  project: { name: 'Projeto teste', siteKey: null },
  connectorToken: 'not-for-prompt',
  ticket: {
    key: 'ZO-10',
    title: 'Falha de teste',
    description: 'Investigar a falha.',
    category: 'incident',
    environment: 'quality',
    priority: 'high',
    status: 'investigating',
  },
  instructions: 'Verificar os logs.',
  model: null,
  reasoningEffort: null,
  projectInstructions: 'Contexto operacional do projeto.',
  conversation: [],
  agentProfile: profile,
  repositorySnapshotHash: 'a'.repeat(64),
  allowedTools: ['log'],
  repositoryResources: [
    {
      path: '.github/agents/Logs.agent.md',
      kind: 'agent',
      required: true,
      sha256: 'b'.repeat(64),
      content: 'Consulta somente os logs autorizados.',
      status: 'loaded',
      selectionReason: 'relevance',
    },
  ],
} satisfies InvestigationContext;

describe('investigation prompt composition', () => {
  it('composes the pinned ZeroOps mission and technical repository snapshot without leaking tokens', () => {
    const prompt = investigationPrompt(context, ['Workspace read-only'], []);
    expect(prompt).toContain('Investigar incidente, versão 3');
    expect(prompt).toContain(profile.definition.mission);
    expect(prompt).toContain('Ferramentas de conector permitidas pelo perfil: log');
    expect(prompt).toContain('.github/agents/Logs.agent.md');
    expect(prompt).toContain('sha256:');
    expect(prompt).toContain('Consulta somente os logs autorizados.');
    expect(prompt).toContain('não é revisão nem commit SVN');
    expect(prompt).not.toContain('Contexto operacional do projeto.');
    expect(prompt).not.toContain('not-for-prompt');
  });

  it('keeps legacy project instructions when no versioned profile is selected', () => {
    const prompt = investigationPrompt(
      { ...context, agentProfile: null },
      ['Workspace read-only'],
      [],
    );
    expect(prompt).toContain('Contexto operacional do projeto.');
  });
});
