import type { FlowDefinition, FlowMatch, FlowNode } from '../../../../contracts/src/index.js';

export interface FlowTemplate {
  template: 'general' | 'health' | 'maintenance';
  name: string;
  description: string;
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
  /** Os modelos publicados à criação reproduzem o comportamento anterior aos fluxos. */
  publish: boolean;
  definition: FlowDefinition;
}

const emptyMatch: FlowMatch = { origins: [], categories: [], environments: [], priorities: [] };

function layout(rows: Record<string, [number, number]>) {
  return Object.fromEntries(
    Object.entries(rows).map(([id, [column, row]]) => [id, { x: column * 280, y: row * 150 }]),
  );
}

function edges(list: [string, string, string][]): FlowDefinition['edges'] {
  return list.map(([source, port, target]) => ({ id: `${source}-${port}`, source, port, target }));
}

const node = (value: FlowNode): FlowNode => value;

/**
 * Fluxo geral (por omissão): análise do Copilot, perguntas ao cliente quando falta informação e
 * decisão da equipa. Reproduz o percurso anterior dos pedidos sem fluxo configurado.
 */
export function generalFlowTemplate(): FlowTemplate {
  return {
    template: 'general',
    name: 'Geral',
    description: 'Análise do Copilot e decisão da equipa (fluxo por omissão).',
    priority: 999,
    isDefault: true,
    match: emptyMatch,
    publish: true,
    definition: {
      start: 'analise',
      nodes: [
        node({
          id: 'analise',
          op: 'copilot_task',
          label: 'Análise do Copilot',
          config: { mode: 'analysis', skipWhenAutoDisabled: true },
        }),
        node({
          id: 'equipa',
          op: 'human_decision',
          label: 'Decisão da equipa',
          assignee: { kind: 'team' },
          config: {
            options: [
              {
                port: 'success',
                label: 'Resolver',
                requiresComment: true,
                commentVisibility: 'public',
              },
              { port: 'failure', label: 'Pedir nova análise ao Copilot', requiresComment: true },
            ],
          },
        }),
        node({ id: 'resolvido', op: 'end', label: 'Resolvido', config: { outcome: 'resolved' } }),
      ],
      edges: edges([
        ['analise', 'success', 'equipa'],
        ['analise', 'failure', 'equipa'],
        ['equipa', 'success', 'resolvido'],
        ['equipa', 'failure', 'analise'],
      ]),
      layout: layout({
        analise: [0, 0],
        equipa: [0, 1],
        resolvido: [0, 2],
      }),
    },
  };
}

/**
 * Incidente (Health): fluxo genérico para qualquer recurso monitorizado (servidor, disco, memória,
 * CPU, rede, base de dados, serviço ou aplicação). Recebe o alerta, investiga com o Copilot Fusion
 * (high), decide pela política do projeto, intervém pelo canal auditado, valida a recuperação e
 * fecha com e-mail ou escala para a equipa com e-mail.
 */
export function healthFlowTemplate(): FlowTemplate {
  return {
    template: 'health',
    name: 'Incidente (Health)',
    description:
      'Alertas da monitorização: investigação do Copilot Fusion, intervenção autorizada pela política, validação da recuperação e fecho ou escalada com e-mail.',
    priority: 10,
    isDefault: false,
    match: { ...emptyMatch, origins: ['health'] },
    publish: true,
    definition: {
      start: 'intake',
      nodes: [
        node({
          id: 'intake',
          op: 'action',
          label: 'Receber alerta',
          config: { action: 'incident_intake' },
        }),
        node({
          id: 'analise',
          op: 'copilot_task',
          label: 'Investigar (Copilot Fusion high)',
          instructions:
            'Investiga o incidente descrito no contexto. Confirma primeiro o sintoma e depois escolhe os meios de diagnóstico adequados: métricas (zo-prom), logs (zo-log), estado do sistema e dos serviços, e queries só de leitura (zo-sql para MySQL, zo-db2 para DB2). Se a evidência apontar para uma dependência, investiga também esse componente: a causa pode estar num recurso diferente do que emitiu o alerta. Regista o que observaste, o impacto e as hipóteses por confirmar. Propõe no máximo uma ação disponível (reiniciar serviço, reiniciar servidor ou alterar parâmetro) ou nenhuma. Nunca proponhas apagar ficheiros ou dados.',
          config: {
            mode: 'analysis',
            askClient: false,
            incidentReport: true,
            executionMode: 'copilot',
            model: 'fusion',
            fusionTier: 'high',
            engines: ['prometheus', 'loki', 'linux', 'mysql', 'db2'],
          },
        }),
        node({
          id: 'autorizar',
          op: 'action',
          label: 'Decidir intervenção',
          config: { action: 'authorize_intervention', override: 'policy' },
        }),
        node({
          id: 'aprovacao',
          op: 'human_decision',
          label: 'Aprovação da intervenção',
          assignee: { kind: 'team' },
          config: {
            options: [
              { port: 'success', label: 'Aprovar intervenção' },
              { port: 'failure', label: 'Rejeitar', requiresComment: true },
            ],
            onlyWhen: ['needs_approval'],
          },
        }),
        node({
          id: 'intervir',
          op: 'action',
          label: 'Intervir',
          config: { action: 'remediate' },
        }),
        node({
          id: 'validar',
          op: 'action',
          label: 'Validar recuperação',
          config: { action: 'validate_recovery', criterion: 'auto' },
        }),
        node({
          id: 'email_fecho',
          op: 'action',
          label: 'E-mail de fecho',
          config: { action: 'email_notify', template: 'closure', recipients: '' },
        }),
        node({
          id: 'email_escala',
          op: 'action',
          label: 'E-mail de escalada',
          config: { action: 'email_notify', template: 'escalation', recipients: '' },
        }),
        node({
          id: 'atribuir',
          op: 'action',
          label: 'Atribuir à equipa',
          config: { action: 'assign_team', role: 'policy' },
        }),
        node({ id: 'resolvido', op: 'end', label: 'Resolvido', config: { outcome: 'resolved' } }),
        node({ id: 'escalado', op: 'end', label: 'Escalado', config: { outcome: 'escalated' } }),
      ],
      edges: edges([
        ['intake', 'success', 'analise'],
        ['intake', 'failure', 'analise'],
        ['analise', 'success', 'autorizar'],
        ['analise', 'failure', 'autorizar'],
        ['autorizar', 'success', 'aprovacao'],
        ['autorizar', 'failure', 'email_escala'],
        ['aprovacao', 'success', 'intervir'],
        ['aprovacao', 'failure', 'email_escala'],
        ['intervir', 'success', 'validar'],
        ['intervir', 'failure', 'email_escala'],
        ['validar', 'success', 'email_fecho'],
        ['validar', 'failure', 'email_escala'],
        ['email_fecho', 'success', 'resolvido'],
        ['email_fecho', 'failure', 'resolvido'],
        ['email_escala', 'success', 'atribuir'],
        ['email_escala', 'failure', 'atribuir'],
        ['atribuir', 'success', 'escalado'],
        ['atribuir', 'failure', 'escalado'],
      ]),
      layout: layout({
        intake: [0, 0],
        analise: [0, 1],
        autorizar: [0, 2],
        aprovacao: [0, 3],
        intervir: [0, 4],
        validar: [0, 5],
        email_fecho: [0, 6],
        resolvido: [0, 7],
        email_escala: [1.4, 6],
        atribuir: [1.4, 7],
        escalado: [1.4, 8],
      }),
    },
  };
}

/**
 * Manutenção de cliente: agradecimento, proposta do Copilot, aprovação do responsável,
 * desenvolvimento pelo Copilot, QA humano e publicação. Fica em rascunho até ser publicado.
 */
export function maintenanceFlowTemplate(): FlowTemplate {
  return {
    template: 'maintenance',
    name: 'Manutenção de cliente',
    description: 'Pedidos do cliente: proposta, aprovação, desenvolvimento, QA e publicação.',
    priority: 20,
    isDefault: false,
    match: { ...emptyMatch, origins: ['portal_client'], categories: ['bug', 'improvement'] },
    publish: false,
    definition: {
      start: 'agradecimento',
      nodes: [
        node({
          id: 'agradecimento',
          op: 'action',
          label: 'Agradecimento ao cliente',
          config: {
            action: 'client_message',
            source: 'text',
            body: 'Obrigado pelo seu pedido. A equipa vai analisá-lo e daremos notícias em breve.',
          },
        }),
        node({
          id: 'analise',
          op: 'copilot_task',
          label: 'Proposta do Copilot',
          instructions:
            'Analisa o pedido e escreve em summary uma proposta interna para a equipa: causa, solução proposta, ficheiros afetados, riscos e testes. Se faltar informação essencial do cliente, pergunta.',
          config: { mode: 'analysis' },
        }),
        node({
          id: 'aprovacao',
          op: 'human_decision',
          label: 'Aprovação do responsável técnico',
          assignee: { kind: 'role', role: 'technical' },
          ticketStatus: 'awaiting_technical',
          config: {
            options: [
              { port: 'success', label: 'Aprovar' },
              { port: 'failure', label: 'Pedir alterações à análise', requiresComment: true },
            ],
          },
        }),
        node({
          id: 'desenvolvimento',
          op: 'copilot_task',
          label: 'Desenvolvimento pelo Copilot',
          instructions:
            'Implementa a proposta aprovada. Entrega a alteração como ficheiros modificados (diff) e indica os testes a executar pelo QA.',
          config: { mode: 'develop' },
        }),
        node({
          id: 'qa',
          op: 'human_decision',
          label: 'QA',
          assignee: { kind: 'role', role: 'qa' },
          ticketStatus: 'awaiting_qa',
          config: {
            options: [
              { port: 'success', label: 'Aprovar' },
              { port: 'failure', label: 'Reprovar', requiresComment: true },
            ],
          },
        }),
        node({
          id: 'publicacao',
          op: 'action',
          label: 'Publicação em Produção',
          config: { action: 'deploy', environment: 'production' },
        }),
        node({
          id: 'confirmar_publicacao',
          op: 'human_decision',
          label: 'Confirmar publicação manual',
          assignee: { kind: 'role', role: 'release' },
          ticketStatus: 'awaiting_release',
          config: {
            options: [
              { port: 'success', label: 'Publicação confirmada' },
              { port: 'failure', label: 'Publicação falhou', requiresComment: true },
            ],
            onlyWhen: ['manual'],
          },
        }),
        node({
          id: 'mensagem_final',
          op: 'action',
          label: 'Mensagem final ao cliente',
          config: {
            action: 'client_message',
            source: 'text',
            body: 'A alteração pedida já está disponível. Obrigado pela colaboração.',
          },
        }),
        node({ id: 'resolvido', op: 'end', label: 'Resolvido', config: { outcome: 'resolved' } }),
      ],
      edges: edges([
        ['agradecimento', 'success', 'analise'],
        ['agradecimento', 'failure', 'analise'],
        ['analise', 'success', 'aprovacao'],
        ['analise', 'failure', 'aprovacao'],
        ['aprovacao', 'success', 'desenvolvimento'],
        ['aprovacao', 'failure', 'analise'],
        ['desenvolvimento', 'success', 'qa'],
        ['desenvolvimento', 'failure', 'aprovacao'],
        ['qa', 'success', 'publicacao'],
        ['qa', 'failure', 'desenvolvimento'],
        ['publicacao', 'success', 'confirmar_publicacao'],
        ['publicacao', 'failure', 'desenvolvimento'],
        ['confirmar_publicacao', 'success', 'mensagem_final'],
        ['confirmar_publicacao', 'failure', 'desenvolvimento'],
        ['mensagem_final', 'success', 'resolvido'],
        ['mensagem_final', 'failure', 'resolvido'],
      ]),
      layout: layout({
        agradecimento: [0, 0],
        analise: [0, 1],
        aprovacao: [0, 2],
        desenvolvimento: [0, 3],
        qa: [0, 4],
        publicacao: [0, 5],
        confirmar_publicacao: [0, 6],
        mensagem_final: [0, 7],
        resolvido: [0, 8],
      }),
    },
  };
}

/** Modelos criados num projeto sem fluxos (ordem estável). */
export function defaultFlowTemplates(): FlowTemplate[] {
  return [generalFlowTemplate(), healthFlowTemplate(), maintenanceFlowTemplate()];
}
