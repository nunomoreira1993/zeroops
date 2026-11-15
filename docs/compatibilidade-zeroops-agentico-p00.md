# P00 — baseline, compatibilidade e autoridades

## Reprodução e ambiente

Checkout de implementação: `e0db48d63194c44b1bb0ffecd00f8ffec76fe7ac`.
A árvore de fonte coincide com `8ac0acd` da análise anterior (473 ficheiros fora
de `node-compile-cache`), sem afirmar ancestralidade entre as histórias.

Node `24.18.0`, npm `11.16.0`, SDK fixado `1.0.30`. Não foram atualizados manifests,
lockfiles ou dependências. Os testes usam MariaDB `10.3.39` temporária em loopback,
bases isoladas e cleanup; nunca a BD operacional do cliente.

Na raiz ZeroOps:

```powershell
npm run typecheck
npm run lint
npm test
npm run test --workspace=@zeroops/web
npm run build
npm run format:check
npm run architecture:metrics
```

Baseline anterior às alterações:

| Check                | Resultado                                                                    |
| -------------------- | ---------------------------------------------------------------------------- |
| Typecheck/build      | Passaram; bundle web >500 kB é aviso.                                        |
| Lint                 | Um erro existente: import `portKey` não usado em `StepConfigPanel.tsx`.      |
| Testes raiz          | 318 passaram; 3 falharam no teste de arquitetura: allowlist, TSDoc e ciclos. |
| Testes web           | 116 Vitest e 11 Node passaram, executados separadamente.                     |
| Format check         | 25 ficheiros existentes fora do formato.                                     |
| Architecture metrics | Executado; sete lacunas TSDoc existentes.                                    |

O mapa observado contém dependências fora da allowlist e ciclos envolvendo
flows/agents/health/incidents/integrations/tickets. A documentação não os
transforma em dependências autorizadas nem enfraquece os testes para ficarem verdes.
Resultados finais e limitações: [progresso](progresso-zeroops-agentico.md).

## SDK/runtime: tipos não equivalem a certificação

O SDK instalado emparelha runtime `1.0.108`, protocolo `3`. O handshake e inferência
real isolada passaram. A CLI global Windows falha com “no platform package found”;
isso não impede o runtime nativo embutido que o SDK efetivamente iniciou.

O Dockerfile fixa a mesma CLI, mas remove os pacotes nativos do SDK e configura
`ZEROOPS_COPILOT_CLI_PATH=/usr/local/bin/zo-copilot-agent`. O wrapper baixa o UID.
Docker não está disponível nesta estação; a entrega inicial não certificou a
imagem/wrapper/UID nem autenticação por projeto. Posteriormente, na passagem QA
autorizada, build, wrapper/UID, handshake, autenticação de projeto, inferência
sintética sem ferramentas e resume passaram no Docker instalado. A matriz nativa
completa de agentes/skills/hooks continua certificada apenas no smoke local.
Ver [registo QA](progresso-zeroops-agentico.md#passagem-autorizada-para-qa--2026-11-14).
MySQL 5.7 também não foi executado; o SQL aditivo usa recursos compatíveis, mas a
verificação operacional desta entrega é MariaDB 10.3.39.

| Capacidade      | Contrato instalado / evidência                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agentes nativos | `customAgents`, `agent`, ferramentas/skills/modelos por agente; delegação real para agente nomeado passou.                                                    |
| Skills          | `skillDirectories`, `disabledSkills`, preload por nome; skill temporária e recurso relativo foram lidos no smoke real.                                        |
| Hooks           | Tipos pre/post/falhas/lifecycle; pre/post-tool, prompt e subagent-start foram exercitados de verdade. O conjunto completo de hooks não está certificado.      |
| Eventos         | `skill.invoked`, `subagent.started/completed`, streaming dos filhos; smoke verifica estes eventos e correlação com a chamada `task`.                          |
| Sessões         | `disconnect`, `resumeSession`, `abort`; smoke desliga, retoma com resposta real e confirma nova inferência após abort. Não prova retomada durável de negócio. |
| Perguntas/plano | Callbacks já usados pelo adapter, cobertos pelos seus testes com fakes; não são aprovações humanas certificadas pelo smoke.                                   |
| Adapter atual   | Ainda não compila o catálogo para agentes/skills/hooks nativos; é P04. A ausência de resposta ao plano ainda pode ser aprovada: risco P03.                    |

Smoke opt-in, com autenticação existente autorizada, sem imprimir credenciais:

```powershell
$env:ZEROOPS_COPILOT_SMOKE='1'
npx vitest run apps\executor\src\copilot-compatibility.smoke.test.ts
```

Opcionalmente definir `ZEROOPS_COPILOT_SMOKE_CLI_PATH` para testar outro executável.
O teste falha quando não há autenticação; não converte falta de acesso em sucesso.
Só cria fixtures sintéticas em pasta temporária, limita ferramentas, nega acesso
fora dessa pasta e remove a sessão e a pasta. Não arranca o executor operacional.
Em modo normal o teste fica explicitamente skipped.

## Inventário das autoridades de mutação

| Autoridade atual                                                            | Entrada e efeitos                                                                                                                                                                                           | Fronteira P00/P01                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TicketsService.create/update/assign/comment/editComment`                   | Portal/API; tickets, atribuições, mensagens, revisões, eventos/outbox; hooks de criação/comentários.                                                                                                        | Membership/papéis e política existentes; grants de fluxos não dão poderes sobre tickets.                                                                                                                                 |
| `TicketGovernanceService`                                                   | Participantes, confirmações e resoluções.                                                                                                                                                                   | Review e quórum não alterados em P01.                                                                                                                                                                                    |
| `FlowEngine.start/decide/tick`                                              | Hooks API/worker; execuções, etapas, status, ações e runs.                                                                                                                                                  | Preservar V1 e decisões; autoridade V2 apenas na fase seguinte.                                                                                                                                                          |
| `FlowEngine.onTicketCreated/onPublicComment/onRunFinished/incidentDelegate` | Encadeia criação, continuação e ações de incidentes.                                                                                                                                                        | Execução automática não depende de grants atuais do autor do fluxo.                                                                                                                                                      |
| `FlowEngine.backfill/upgradeTemplates`                                      | Bootstrap do worker; pode criar execuções, publicar/atualizar modelos e associar tickets antigos.                                                                                                           | Inventariado, não convertido em edição delegada; migração/ativação explícita em P02. P11: `backfill` deixou de correr no arranque; tickets antigos só por adoção explícita auditada (`ops flow-adoption`, migração 045). |
| `ensureDefaultFlows`                                                        | `FlowEngine.start` e percursos legados de administração (antes também `backfill`); cria e publica modelos.                                                                                                  | Listagem delegada não chama; criação edit-only inicial devolve 409; alerta composto exige edição + ativação.                                                                                                             |
| `FlowsService.create/saveDraft/saveSettings/publish`                        | Autoria/metadata/routing/publicação.                                                                                                                                                                        | Gates distintos e DB atual; routing real exige ativação.                                                                                                                                                                 |
| `FlowsService.linkAlertFlow/createAlertFlow`                                | Associa alertas; criação composta publica v1.                                                                                                                                                               | Ativação; criação composta também edição.                                                                                                                                                                                |
| `FlowAssistantQueue` e `resolveFlowAssistant`                               | Reclama autoria, entrega proposta; aceitar muda só o draft.                                                                                                                                                 | Revalida autor na reclamação/entrega e ator na resolução, sem promoção de papel.                                                                                                                                         |
| Assistente de ticket / `WorkflowService.publishProposal/decide/transition`  | Propostas, aprovações legadas, transições e deployment pendente.                                                                                                                                            | Autoridades paralelas preservadas e a migrar em P02/P03; nunca abertas por grants de fluxos.                                                                                                                             |
| `AgentProfilesService`                                                      | Criação, versões, arquivo, seed e snapshots de execução.                                                                                                                                                    | Gestão/seed exige `agents.manage`; leitura funcional não cria perfis.                                                                                                                                                    |
| `AgentRunsService.complete/fail`                                            | Resultados, mensagens/eventos, patch e hook de continuação.                                                                                                                                                 | Execuções automáticas preservadas; leases/fencing são P03.                                                                                                                                                               |
| Arranque do executor                                                        | `failInterrupted` nos runs e pedidos de assistente.                                                                                                                                                         | Interrupção global continua conhecida; não simular multiworker seguro.                                                                                                                                                   |
| `incident-actions` / `CandidateService.recordVerifiedCandidate`             | Ações reais de incidentes e finalização do candidato verificado; `WorkflowService` cria `execution_runs`/`deployment_runs` pendentes. `ticket-dependencies` invalida artefactos após alterações relevantes. | Permissões de autoria não autorizam infraestrutura, produção ou credenciais; o operador genérico de deploy ainda não está implementado.                                                                                  |
| Gateway de conectores                                                       | Token/run ativo e credenciais server-side; ferramentas de leitura.                                                                                                                                          | Inventário identifica a ausência de política efetiva por ferramenta/run; P03/P09, não “resolvida” pelo SDK.                                                                                                              |
| `ProjectPermissionsService.update`                                          | Grants e `projects.version`, audit JSON na mesma transação.                                                                                                                                                 | Nova autoridade P01, restrita ao projeto e aos limites de delegação.                                                                                                                                                     |

Decisões e consequências: [ADRs P00](adrs-agentico-p00.md).
