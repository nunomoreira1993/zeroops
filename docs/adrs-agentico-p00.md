# ADRs P00 — fronteiras para as fases seguintes

Estado: decisões do plano aprovado, registadas nesta entrega. A concretização V2,
jobs/leases e política de execução não faz parte de P00/P01.

## ADR-P00-01 — Autoridade do fluxo e convivência V1/V2

**Contexto.** `FlowEngine` já executa grafos persistidos, mas `WorkflowService`,
autoria assistida, ações de incidentes e finalização de runs também alteram tickets.
Não existe ainda um manifesto V2 que atribua uma única autoridade ao processo.

**Decisão.** Preservar execuções e versões V1. A migração futura introduzirá V2
explicitamente, sem reinterpretar o histórico ou criar outro motor concorrente.
Transições de tickets deverão passar pela autoridade da execução e pela política
efetiva; adaptadores legados serão identificados e migrados, não mantidos como
atalhos universais. Uma resposta do Copilot é proposta, não aprovação nem publicação.

**Consequências P01.** Grants autorizam gestão do projeto, não revisões de tickets.
`canDecide`, aprovadores e poderes administrativos existentes não são alterados.
Operações automáticas de execuções publicadas não dependem de o antigo autor
continuar a poder editar fluxos.

## ADR-P00-02 — Encaminhamento é ativação

**Contexto.** `saveSettings` muda regras ativas; associações de alertas escolhem
diretamente o fluxo executado; o bootstrap legado publica modelos.

**Decisão.** Já em P01, publicar, alterar regras de encaminhamento ou associar um
alerta exige `flows.activate`. Criar um fluxo próprio de alerta exige também
`flows.edit`. Gravar apenas nome/descrição não exige ativação quando os campos de
encaminhamento enviados não mudaram. Listar por delegação não inicializa dados.

**Compatibilidade.** Administração conserva a inicialização legada na listagem.
Criar com edição delegada num projeto ainda sem fluxos devolve conflito explícito
antes de escrever. Bootstrap automático e upgrades do motor/worker continuam
autoridades internas inventariadas, não permissões de autoria concedidas ao membro.

**Fase seguinte.** P02 separará rascunho, revisão e ativação de um pacote coerente
versionado, retirando as ativações implícitas. P01 não finge fornecer esse manifesto.

## ADR-P00-03 — BD de negócio, jobs e política efetiva

**Contexto.** Fila e interrupções globais existem; sessões SDK e hooks não asseguram
leases, fencing, retomada de trabalho nem autorização dos conectores.

**Decisão.** A BD ZeroOps permanece a autoridade de estado, auditoria, perguntas,
aprovações e resultados. A sessão SDK é um recurso de execução, não uma fila nem
histórico de negócio. P03 introduzirá jobs/leases/cancelamento e política efetiva
tipada; P04 ligará agentes/skills/hooks ao catálogo sem promover permissões.

**Consequências P01.** Revalidar grants na BD em cada operação. Serializar mutações e
gestão de grants pelo lock do projeto, antes dos locks funcionais. Autoria em fila
e entrega da resposta revalidam o requerente; aplicação exige edição atual.
Pedidos de tickets e execuções publicadas mantêm os controlos próprios.

**Limite.** Hooks do SDK, listas de ferramentas e o snapshot de um perfil não
substituem autorização no gateway. Aprovação automática de saída de plano sem
resposta humana continua um risco identificado para P03, não uma política de review.

**Atualização P03.**

- Jobs com `worker_id`, `lease_epoch`, `lease_until` e `attempt`.
- Todas as escritas são fenced pelo epoch e a recuperação é feita por lease
  expirado, em vez de falha global no arranque.
- O gateway revalida em cada chamada a posse, o cancelamento, a versão atual do
  perfil e o limite atómico.
- A aprovação de plano é `auto` só quando a política já autoriza; o timeout ou
  o silêncio nunca aprovam. Ver
  [progresso P03](progresso-zeroops-agentico.md#p03--jobs-leases-e-política-efetiva-de-ferramentas).

**Atualização P04.**

- Agentes e skills são capacidades versionadas e imutáveis (hash por
  bundle), importadas com proveniência e partilhadas explicitamente entre
  projetos. Uma partilha nunca transporta bindings, credenciais nem
  conversas.
- A ativação (P02) fixa as versões no manifesto e o run fixa os ficheiros.
  A compilação usa `customAgents` e `skillDirectories` nativos do SDK, e não
  a concatenação no prompt.
- O hook `onPreToolUse` só restringe (posse, conjunto fixado, concorrência).
  `allowed-tools` é rejeitado, e a `PermissionPolicy` e o gateway continuam
  a ser a autoridade. Ver
  [progresso P04](progresso-zeroops-agentico.md#p04--catálogo-de-agentesskills-e-compilação-para-copilot).
