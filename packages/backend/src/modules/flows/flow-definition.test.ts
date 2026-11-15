import { describe, expect, it } from 'vitest';
import {
  applyFlowOperations,
  flowChangeKind,
  selectFlow,
  toBinaryFlow,
  validateFlowDefinition,
  type FlowCandidate,
  type FlowDefinition,
  type FlowMatch,
} from '../../../../contracts/src/flows.js';
import { simulateFlow } from '../../../../contracts/src/flow-transitions.js';
import { healthFlowTemplate, maintenanceFlowTemplate } from './flow-templates.js';

const anyMatch: FlowMatch = { origins: [], categories: [], environments: [], priorities: [] };

describe('definição de fluxos', () => {
  it('os modelos iniciais são publicáveis', () => {
    expect(validateFlowDefinition(healthFlowTemplate().definition)).toEqual([]);
    expect(validateFlowDefinition(maintenanceFlowTemplate().definition)).toEqual([]);
  });

  it('simula o QA a reprovar duas vezes sem efeitos e mostra onde o pedido fica', () => {
    const definition = maintenanceFlowTemplate().definition;
    const result = simulateFlow(definition, {
      qa: ['failure', 'failure', 'wait'],
    });
    expect(result.outcome).toBe('waiting');
    expect(result.stoppedAt).toMatchObject({
      nodeId: 'qa',
      assignee: { kind: 'role', role: 'qa' },
    });
    const development = result.steps.filter((step) => step.nodeId === 'desenvolvimento');
    expect(development.map((step) => step.attempt)).toEqual([1, 2, 3]);
    expect(result.steps.find((step) => step.nodeId === 'agradecimento')?.effect.pt).toMatch(
      /não executada/,
    );
  });

  it('simula o responsável a pedir mais informação e a publicação manual', () => {
    const definition = maintenanceFlowTemplate().definition;
    const asked = simulateFlow(definition, { aprovacao: ['failure', 'wait'] });
    expect(asked.stoppedAt?.nodeId).toBe('aprovacao');
    expect(asked.steps.filter((step) => step.nodeId === 'analise')).toHaveLength(2);
    const done = simulateFlow(definition, {});
    expect(done.steps.map((step) => step.nodeId)).toContain('confirmar_publicacao');
    expect(done).toMatchObject({ outcome: 'ended', endOutcome: 'resolved' });
  });

  it('a proposta altera só a parte relevante e distingue disposição de ordem de execução', () => {
    const base = maintenanceFlowTemplate().definition;
    const patch = applyFlowOperations(base, [
      {
        type: 'add_node',
        node: {
          id: 'aprovacao_lider',
          op: 'human_decision',
          label: 'Aprovação do líder técnico',
          assignee: { kind: 'role', role: 'technical' },
          config: {
            options: [
              { port: 'success', label: 'Aprovar' },
              { port: 'failure', label: 'Recusar', requiresComment: true },
            ],
          },
        },
      },
      { type: 'connect', source: 'aprovacao', port: 'success', target: 'aprovacao_lider' },
      { type: 'connect', source: 'aprovacao_lider', port: 'success', target: 'desenvolvimento' },
      { type: 'connect', source: 'aprovacao_lider', port: 'failure', target: 'analise' },
    ]);
    expect(patch.added).toEqual(['aprovacao_lider']);
    expect(patch.changed).toEqual(['aprovacao']);
    expect(patch.removedEdges).toEqual(['aprovacao-success']);
    expect(validateFlowDefinition(patch.definition)).toEqual([]);
    // Os restantes nós ficam iguais.
    expect(patch.definition.nodes.filter((node) => node.id !== 'aprovacao_lider')).toEqual(
      base.nodes,
    );
    expect(flowChangeKind(base, patch.definition)).toBe('logic');
    const moved = structuredClone(base);
    moved.layout.qa = { x: 999, y: 999 };
    expect(flowChangeKind(base, moved)).toBe('layout');
  });

  it('rejeita operações sobre etapas inexistentes', () => {
    expect(() =>
      applyFlowOperations(maintenanceFlowTemplate().definition, [
        { type: 'connect', source: 'qa', port: 'failure', target: 'nao_existe' },
      ]),
    ).toThrow();
  });

  it('valida destinos, responsáveis e ações antes de publicar', () => {
    const definition = structuredClone(maintenanceFlowTemplate().definition);
    definition.edges = definition.edges.filter((edge) => edge.id !== 'qa-failure');
    const qa = definition.nodes.find((node) => node.id === 'qa')!;
    delete qa.assignee;
    const codes = validateFlowDefinition(definition).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['unconnected_port', 'missing_assignee']));
    const user = structuredClone(maintenanceFlowTemplate().definition);
    user.nodes.find((node) => node.id === 'qa')!.assignee = {
      kind: 'user',
      userId: '00000000-0000-4000-8000-000000000001',
    };
    expect(
      validateFlowDefinition(user, { members: new Set() }).map((issue) => issue.code),
    ).toContain('inactive_assignee');
  });

  it('converte um fluxo antigo em sucesso/erro e a decisão de aprovação passa a condicional', () => {
    const legacy: FlowDefinition = {
      start: 'autorizar',
      nodes: [
        {
          id: 'autorizar',
          op: 'action',
          label: 'Autorizar',
          config: { action: 'authorize_intervention' },
        },
        {
          id: 'aprovacao',
          op: 'human_decision',
          label: 'Aprovação',
          assignee: { kind: 'role', role: 'technical' },
          config: {
            options: [
              { port: 'approve', label: 'Aprovar' },
              { port: 'reject', label: 'Recusar', requiresComment: true },
              { port: 'changes', label: 'Pedir informação' },
            ],
          },
        },
        {
          id: 'aguarda',
          op: 'human_decision',
          label: 'Aguarda cliente',
          assignee: { kind: 'ticket_author' },
          config: { options: [{ port: 'replied', label: 'Respondeu' }] },
        },
        { id: 'intervir', op: 'action', label: 'Intervir', config: { action: 'remediate' } },
        { id: 'fim', op: 'end', label: 'Resolvido', config: { outcome: 'resolved' } },
        { id: 'escala', op: 'end', label: 'Escalado', config: { outcome: 'escalated' } },
      ],
      edges: [
        ['autorizar', 'auto', 'intervir'],
        ['autorizar', 'needs_approval', 'aprovacao'],
        ['autorizar', 'no_action', 'intervir'],
        ['autorizar', 'forbidden', 'escala'],
        ['aprovacao', 'approve', 'intervir'],
        ['aprovacao', 'reject', 'escala'],
        ['aprovacao', 'changes', 'aguarda'],
        ['aguarda', 'replied', 'aprovacao'],
        ['intervir', 'done', 'fim'],
        ['intervir', 'no_action', 'fim'],
        ['intervir', 'failed', 'escala'],
        ['intervir', 'forbidden', 'escala'],
      ].map(([source, port, target]) => ({
        id: `${source}-${port}`,
        source: source!,
        port: port!,
        target: target!,
      })),
      layout: { aguarda: { x: 0, y: 0 } },
    };
    const { definition, changed } = toBinaryFlow(legacy);
    expect(changed).toBe(true);
    expect(definition.edges.map((edge) => [edge.source, edge.port, edge.target])).toEqual([
      ['autorizar', 'success', 'aprovacao'],
      ['autorizar', 'failure', 'escala'],
      ['aprovacao', 'success', 'intervir'],
      ['aprovacao', 'failure', 'escala'],
      ['intervir', 'success', 'fim'],
      ['intervir', 'failure', 'escala'],
    ]);
    const gate = definition.nodes.find((node) => node.id === 'aprovacao')!;
    expect(gate.config).toMatchObject({
      onlyWhen: ['needs_approval'],
      options: [
        { port: 'success', label: 'Aprovar' },
        { port: 'failure', label: 'Recusar', requiresComment: true },
      ],
    });
    // A espera pelo cliente passa a ser interna do motor: a etapa sem caminho desaparece.
    expect(definition.nodes.map((node) => node.id)).not.toContain('aguarda');
    expect(definition.layout.aguarda).toBeUndefined();
    expect(validateFlowDefinition(definition)).toEqual([]);
    expect(toBinaryFlow(definition).changed).toBe(false);
  });

  it('escolhe o fluxo de forma previsível quando duas regras coincidem', () => {
    const ticket = {
      origin: 'portal_client' as const,
      category: 'bug',
      environment: 'production',
      priority: 'high',
    };
    const flows: FlowCandidate[] = [
      { id: 'default', name: 'Geral', priority: 999, isDefault: true, match: anyMatch },
      {
        id: 'b',
        name: 'Bugs',
        priority: 30,
        isDefault: false,
        match: { ...anyMatch, categories: ['bug'] },
      },
      {
        id: 'a',
        name: 'Cliente',
        priority: 20,
        isDefault: false,
        match: { ...anyMatch, origins: ['portal_client'] },
      },
    ];
    expect(selectFlow(flows, ticket)?.id).toBe('a');
    expect(selectFlow(flows, { ...ticket, origin: 'health', category: 'question' })?.id).toBe(
      'default',
    );
  });
});
