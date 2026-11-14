import type { InvestigationContext } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type { AgentProfileRunSnapshot } from '../../../packages/contracts/src/agent-profiles.js';
import { siteLabel } from '../../../packages/backend/src/modules/agents/site-instructions.js';
import { environmentLabel, type AgentCommand } from './agent-commands.js';

/** Frase de abertura: projeto do ticket e, quando diferente do nome, a plataforma do site. */
function identity(project: InvestigationContext['project'] | undefined) {
  if (!project) return 'És o agente de investigação do ZeroOps.';
  const platform = siteLabel(project.siteKey);
  const suffix = platform && platform !== project.name ? ` (plataforma ${platform})` : '';
  return `És o agente de investigação do ZeroOps para o projeto ${project.name}${suffix}.`;
}

/**
 * Prompt genérico de investigação. Não contém regras por tipo de pedido: o agente decide que
 * fontes consultar a partir do pedido, da conversa e das ferramentas disponíveis.
 */
export function investigationPrompt(
  context: InvestigationContext,
  sources: string[],
  commands: AgentCommand[] = [],
): string {
  const { ticket } = context;
  const conversation = context.conversation.map(
    (message) =>
      `### ${message.author} (${message.role}${message.automated ? ', agente — investigação anterior, não é evidência deste run' : ''}, ${message.visibility === 'internal' ? 'nota interna' : 'público'}, ${message.createdAt})\n${message.body}`,
  );
  const profile = context.agentProfile as AgentProfileRunSnapshot | null | undefined;
  const profileSection = profile
    ? [
        '## Agente ZeroOps (perfil fixado)',
        `Perfil ${profile.definition.name}, versão ${profile.version} (${profile.id}).`,
        profile.definition.mission,
        `Entradas esperadas: ${profile.definition.expectedInputs.join('; ') || 'as do pedido e do contexto disponível'}.`,
        `Resultado esperado: ${profile.definition.expectedOutput}`,
        'Critérios de conclusão:',
        ...profile.definition.completionCriteria.map((criterion) => `- ${criterion}`),
        `Modos suportados: ${profile.definition.modes.join(', ')}.`,
        `Ferramentas de conector permitidas pelo perfil: ${profile.definition.allowedTools.join(', ') || 'nenhuma'}. Só estão efetivas as ferramentas listadas em Fontes/Ferramentas disponíveis.`,
      ].join('\n')
    : '';
  const resources = context.repositoryResources ?? [];
  const repositorySection = resources.length
    ? [
        '## Recursos técnicos fixados do repositório',
        'As instruções globais do repositório aplicam-se sempre. Os restantes agentes, instruções e skills são os documentos selecionados por relevância ou pelo flow. Conteúdo read-only, identificado por caminho e SHA-256; é a fonte técnica de verdade para este projeto, não uma cópia editável no ZeroOps. Nada aqui concede ferramentas, credenciais, escrita, shell, commit ou deploy. Se estas regras e as políticas do ZeroOps não puderem ser conciliadas, interrompe e reporta o conflito.',
        ...resources.map((resource) =>
          resource.status === 'loaded' && resource.content
            ? `### ${resource.path} (${resource.kind}; ${resource.selectionReason ?? (resource.required ? 'obrigatório' : 'selecionado')}; sha256:${resource.sha256})\n${resource.content}`
            : `- ${resource.path} (${resource.selectionReason ?? (resource.required ? 'obrigatório' : 'selecionado')}): não carregado (${resource.reason ?? resource.status}).`,
        ),
      ].join('\n\n')
    : '';
  return [
    identity(context.project),
    'Investiga o pedido abaixo e prepara a informação para a equipa técnica decidir.',
    '',
    `## Pedido ${ticket.key}: ${ticket.title}`,
    `Categoria: ${ticket.category}; ambiente: ${ticket.environment}; prioridade: ${ticket.priority}; estado: ${ticket.status}.`,
    '',
    ticket.description,
    '',
    conversation.length ? `## Conversa\n\n${conversation.join('\n\n')}` : '',
    context.instructions ? `## Indicações da equipa\n\n${context.instructions}` : '',
    context.projectInstructions && !profile
      ? `## Instruções do projeto\n\n${context.projectInstructions}`
      : '',
    profileSection,
    repositorySection,
    context.repositorySnapshotHash
      ? `Hash SHA-256 do snapshot de conteúdos técnicos carregados neste run (não é revisão nem commit SVN): ${context.repositorySnapshotHash}.`
      : '',
    '',
    '## Fontes disponíveis',
    sources.length ? sources.map((source) => `- ${source}`).join('\n') : '- Apenas o workspace.',
    '',
    commands.length
      ? [
          '## Ferramentas de consulta (shell)',
          'Só estes comandos podem ser executados; cada chamada fica registada como evidência.',
          'Não combines estes comandos com outros (`| head`, `grep`, `sort`…) nem com redireções: seriam recusados; os comandos já limitam e filtram a saída.',
          ...commands.map(
            (command) =>
              `- \`${command.usage}\` — ${command.description} Ambientes: ${command.environments.map(environmentLabel).join(', ')}.`,
          ),
          '',
          '## Ambientes',
          commands.some((command) => command.environments.includes('production'))
            ? '- Dados reais de clientes, encomendas, pagamentos e lojas estão em Produção: use `--env production`. QA tem apenas dados de teste e serve para validar código/comportamento.'
            : '- A ligação a Produção não está disponível neste run: indica no resumo que os dados reais não foram consultados e que a conclusão se baseia apenas em QA.',
          '- Se o pedido não deixar claro o ambiente e isso mudar a conclusão, indica a dúvida no resumo e pergunta à equipa.',
          '- Na evidência, indica sempre o ambiente de cada consulta.',
        ].join('\n')
      : '',
    '',
    '## Regras',
    '- Separa factos confirmados (com a fonte) de hipóteses. Nunca inventes dados.',
    '- Consulta apenas em modo de leitura; não alteres dados nem código.',
    '- Não incluas segredos, passwords, tokens ou dados completos de cartões.',
    '- summary: nota interna para a equipa (o que foi pedido, o que verificaste, conclusão, próximos passos). Só a equipa a vê.',
    '- No summary, começa por dizer claramente se o problema ficou resolvido, não resolvido ou por confirmar. Organiza o restante em secções Markdown curtas: "O que foi confirmado", "O que falta confirmar" e "Próximo passo". Usa listas e linguagem direta; explica os termos técnicos indispensáveis. Não repitas todo o histórico nem copies a lista de evidence. Se incluíres uma proposta de código, usa um bloco de código separado e identifica-a como não aplicada.',
    '- replyDraft: resposta final e completa ao cliente em PT-PT, cordial e objetiva, apenas com factos confirmados; null se ainda precisares de informação do cliente. A equipa revê-a antes de a enviar.',
    '- clientQuestions: perguntas enviadas automaticamente ao cliente, só sobre informação que apenas ele sabe (n.º da encomenda, loja, data/hora, prints, passos que fez). Máximo 5, curtas e claras; [] se não precisares. Dúvidas sobre ambiente, acessos ou decisões internas pergunta-as à equipa (ask_user), nunca ao cliente.',
    '- Mensagens ao cliente (replyDraft e clientQuestions) nunca mencionam SQL, tabelas, servidores, ambientes (QA/Produção), IPs, logs, tokens, o Copilot ou ferramentas internas, nem dados de outros clientes ou cartões completos.',
    '- evidence: uma entrada por consulta relevante feita neste run (fonte, ambiente e o que mostrou).',
    '- Notas de investigações anteriores na conversa são pistas, não factos: confirma-as de novo neste run (no ambiente certo) antes de as usares, ou apresenta-as como «investigação anterior» com o ambiente indicado nessa nota.',
    '- Se não conseguires confirmar algo, indica que dados ou acessos faltam.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}
