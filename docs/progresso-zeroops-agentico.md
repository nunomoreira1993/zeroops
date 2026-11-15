# Progresso ZeroOps agêntico — P00 a P11

## Âmbito e baseline

Esta entrega implementa apenas P00/P01 do plano acordado e do complemento técnico aprovado.
P02 e seguintes não estão autorizados nesta entrega. A implementação inicial não
alterou o QA; a passagem posteriormente autorizada está registada abaixo.

- Base local: `e0db48d63194c44b1bb0ffecd00f8ffec76fe7ac`, branch de trabalho `feat/p00-p01-project-permissions`.
- A referência GitHub `8ac0acd80432f7026ba8a764714e3067c897a969` tem os mesmos 473 ficheiros de fonte versionados, fora da cache. `git merge-base` confirmou ausência de ancestral comum com a base local. Não foi feita integração/recriação do histórico. Cache local preexistente preservada.
- Baseline: typecheck/build passaram; lint falhou por `portKey` não usado em `StepConfigPanel.tsx`.
- Testes raiz: 318 passaram, 3 falharam no teste arquitetural (allowlist, TSDoc e ciclos preexistentes).
- Testes web: 116 passaram; 11 testes Node passaram.
- Formatação global: 25 ficheiros preexistentes fora do formato; métricas arquiteturais executadas.

## P00

- SDK instalado `1.0.30`; arranque real confirmou runtime `1.0.108`, protocolo 3 e autenticação existente.
- Inferência real isolada passou (`ZEROOPS_SMOKE_OK`), sem ferramentas, descoberta de configuração ou código do projeto.
- CLI global Windows incompleta; não foi reinstalada. Docker não está disponível localmente.
- Modo SDK `empty` requer persistência explícita e não reutilizou a autenticação ambiente no ensaio; não é necessário ao adapter atual. O smoke passou no percurso SDK normal, com descoberta/instruções/skills desativadas.
- Smoke real opt-in de [compatibilidade SDK](../apps/executor/src/copilot-compatibility.smoke.test.ts) passou: agente nativo nomeado, skill com recurso relativo, delegação, hooks pre/post/prompt/subagent, eventos e correlação de chamadas, disconnect/resume com inferência e abort seguido de nova inferência. Só foram usadas fixtures sintéticas descartáveis; nenhum executor operacional foi iniciado.
- [Inventário e matriz de compatibilidade](compatibilidade-zeroops-agentico-p00.md) e [três ADRs](adrs-agentico-p00.md) concluídos. Foram identificadas as autoridades paralelas V1, bootstrap, incidentes, runs e propostas, sem implementar V2.
- Na validação local inicial, Docker/wrapper/UID, autenticação operacional por projeto e MySQL 5.7 não foram certificados. A BD de teste foi MariaDB 10.3.39 descartável. A validação Docker posteriormente feita em QA está abaixo; MySQL 5.7 continua sem execução. Nenhuma dependência foi atualizada.

## P01

- Migration aditiva [034](../sql/034_project_permission_grants.sql), contratos tipados, autorização central e gestão de grants concluídos. Nenhuma migration anterior foi alterada e não existe backfill automático.
- API: `GET /api/projects/:projectId/access`, `GET/POST /api/projects/:projectId/permissions`; contexto mínimo sem contas, integrações ou segredos. Sessão/CSRF e endpoints administrativos existentes mantêm os controlos próprios.
- Regras vinculativas: gestão de permissões só atribuída/revogada por administradores; delegado gere apenas diferenças delegáveis que possui, nunca si próprio ou administradores.
- Alterações de grants serializadas por projeto, revisão otimista e auditoria estruturada. Revogações sem cascata e sem cache de autorização na sessão.
- Gates por operação: leitura, edição/autoria/aplicação, simulação, ativação e gestão de perfis. Encaminhamento realmente alterado e associações de alertas exigem ativação; criação composta de fluxo de alerta exige também edição.
- Leitura delegada não faz seed/publicação. Criação edit-only num projeto sem fluxos devolve `FLOW_INITIALIZATION_REQUIRED` antes de escrever. Administração conserva a inicialização legada; autoridades automáticas do motor estão inventariadas, não foram abertas aos delegados.
- Autoria assíncrona revalida o requerente no claim e entrega da proposta, com ordem de locks projeto → request. Aceitar/descartar exige edição atual. Revisores, `canDecide`, quórum e execuções publicadas não foram alterados.
- UI dedicada de permissões e navegação delegada, sem acesso administrativo artificial; controlos distintos de edição/publicação/simulação/perfis. Gestor de perfis sem edição não altera configuração da etapa.

## Validação final local

| Check                                                | Resultado                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck e build                                    | Passaram; Vite gerou JS/CSS finais minificados. Mantém aviso preexistente de chunk >500 kB.                                                                                                     |
| Autorização/migration/HTTP + regressão fluxos/perfis | 20 testes passaram em 3 ficheiros; 10 novos cenários de permissões.                                                                                                                             |
| UI P01 focada                                        | 5 testes passaram.                                                                                                                                                                              |
| Suite raiz                                           | 328 passaram, 3 falharam e 1 skipped (smoke opt-in); mesmas três falhas arquiteturais da baseline.                                                                                              |
| Suite web completa                                   | 121 Vitest passaram com `--no-file-parallelism`; 11 Node passaram.                                                                                                                              |
| Smoke Copilot real                                   | 1 teste opt-in passou com autenticação existente, runtime 1.0.108/protocolo 3.                                                                                                                  |
| Lint                                                 | Mantém apenas o erro preexistente `portKey` não usado.                                                                                                                                          |
| Formatação global                                    | 24 ficheiros preexistentes fora do formato, contra 25 na baseline; ficheiros da entrega formatados.                                                                                             |
| Métricas arquiteturais                               | Executadas; mesmas sete lacunas TSDoc, nenhuma nova.                                                                                                                                            |
| Browser real                                         | Build/compilação passaram; Edge não arrancou: políticas administrativas proíbem headless e remote debugging. Validação visual desktop/mobile não executada; não foram contornadas as políticas. |

Uma execução web concorrente com build/testes raiz teve dois testes antigos
instáveis (`health-alerting` timeout e `integrations` ainda em loading). A repetição
integral sem paralelismo entre ficheiros passou, sem alterar testes/timeouts.
O comando raiz `npm test` termina nas falhas arquiteturais e não chega ao workspace
web; este foi executado separadamente. A validação global não está toda verde,
mas não foram identificadas novas falhas relativamente à baseline.

Os testes novos cobrem privilégios forjados, não promoção de papéis, gestão sem
capacidade, diferenças delegáveis, bloqueio self/admin, isolamento entre projetos,
revogação na mesma sessão e sem cascata, auditoria/no-op, concorrência de revisão,
projeto/membership inativos, replay/journal/checksum/FKs da migration, sessão/CSRF
HTTP e gates de publicação indireta/autoria/perfis.

## Versionamento e QA

- Remoto local `qa` publica através de hook; não será usado para push nesta entrega.
- Destino GitHub identificado: `https://github.com/nunomoreira1993/zeroops.git`. Fetch de leitura funcionou; APIs de metadata/workflows devolveram 404, sem permitir verificar hooks/apps externos. Não existem workflows versionados na referência obtida, mas isso não certifica ausência de deploy.
- Push/PR bloqueados pela impossibilidade de confirmar destino sem deploy automático. O remoto `qa` não é alternativa segura e não foi usado. A ausência de ancestral comum também exige decisão explícita antes de preparar uma futura integração/PR; não foi feito merge/rebase/reset.
- A entrega fica em commit local na branch própria. Um bundle Git verificado acompanha a entrega local como transporte alternativo, não como confirmação de push. O SHA exato e o caminho do bundle são comunicados na entrega final.
- Na entrega inicial não foi executado deploy ou migration operacional. A passagem
  QA posteriormente autorizada está abaixo; não foi feito reset/clean ou force push.

## Passagem autorizada para QA — 2026-11-14

Após o pedido explícito para passar a versão para esse ambiente:

- Host confirmado por SSH: `uqphorders24-dev` (`pizzahut-qa`); aplicação
  `/opt/zeroops/src`, Git bare `/opt/zeroops/repo.git`.
- Anterior: `e0db48d63194c44b1bb0ffecd00f8ffec76fe7ac`. O export sem `.git`
  foi comparado com a árvore Git: 473 ficheiros, zero diferenças ou extras,
  excluindo apenas `deploy/qa/VERSION` gerado.
- Publicado: **`1886643b9887a7288af03d16b2dad07584149450`**. O bundle foi
  validado por SHA-256 e carregado por fetch em `refs/heads/staging/p00-p01`.
  `main` do bare permaneceu na referência anterior; não foi usado push/hook.
- Executado o `deploy/qa/deploy-from-git.sh` existente, sem alterações.
  Build api/executor, migration, arranque e health terminaram com exit 0.
  As imagens publicadas são `g1886643b9887`/`latest`.
- Backup prévio independente:
  `/var/backups/zeroops/pre-p00-p01-20261114T095051-e0db48d.sql.gz`
  (`e7f9a32caa900ade210fb7df892300af08c924f9585e17a4a05b59488db6e3cf`).
  Backup do deploy:
  `/var/backups/zeroops/zeroops-20261114T095515-g1886643b9887.sql.gz`
  (`91b52b68a48990126780000dd90fad2a1d131bf723d3b3ee399f75f0d7100526`).
  Ambos passaram `gzip -t`; o primeiro também teve presença de DDL verificada.
- Migration 034 presente no journal, checksum
  `b963772574d67733211beada888d928fe2e1b9967084681913425de4e75fa909`,
  tabela e FKs confirmadas. Nenhum grant real foi criado automaticamente.
- API/conectores `ready`, SHA igual ao `VERSION`, quatro serviços em execução
  e zero reinícios. JS/CSS finais servidos por HTTP, não vazios e com o marcador
  P01 no JS.
- Smoke funcional no código instalado e BD QA: **33 verificações passaram**,
  incluindo limites de delegação, self/admin, projeto distinto, revogação,
  revisão obsoleta, auditoria, bootstrap e publicação indireta. Todas as fixtures
  ficaram numa transação revertida; zero projetos/utilizadores/auditoria sintéticos
  persistiram. Não substitui o ensaio concorrente e HTTP/UI completo local.
- SDK no Docker: wrapper com UID baixado, handshake runtime 1.0.108/protocolo 3,
  autenticação com integração de projeto já verificada, inferência sintética e
  disconnect/resume com nova inferência passaram. Sem ferramentas, leitura de
  código de negócio, fila ou arranque de outro executor operacional; sessão e
  diretório temporários removidos. Segredos permaneceram no servidor.
- HTTPS `https://tickets.pizzahut.pt/api/health` confirmou o SHA através do proxy,
  com CA instalada e resolução explícita para o endereço local do proxy.
  O `curl` Windows não conseguiu verificar revogação do certificado
  (`CRYPT_E_NO_REVOCATION_CHECK`); não foi desativada essa validação.
- Recuperação de código/imagens disponível pelo processo existente;
  `/opt/zeroops/src.prev/deploy/qa/VERSION` conserva o SHA anterior. A BD não é
  restaurada automaticamente; a migration aditiva pode permanecer num rollback.

**QA publicado e verificado nos smokes acima.** Validação visual/manual autenticada
desktop/mobile e a matriz completa de agentes/skills/hooks no Docker continuam
pendentes. Produção não foi alterada. O [procedimento QA](qa-p00-p01.md) continua
a documentar publicação e recuperação. Push/PR GitHub continuam bloqueados pelos
motivos anteriores; não foi feita integração de histórias. P02 permanece fora do âmbito.

## P02 — Fluxos V2, manifestos e ativação explícita

Branch `feat/p02-flow-activation`, criada a partir de `79df3fa` (P00/P01).

### Alterações

- **Rascunho vs. ativo.** `flows.priority/is_default/flow_match` passam a ser o
  encaminhamento do rascunho; o que está em serviço fica em `flows.active_*`.
  `published_version_id` continua a ser a versão ativa para tickets novos.
  Editar etapas, condições ou regras só altera o rascunho (`draft_version`).
- **Versões imutáveis com manifesto.** Cada ativação cria uma `flow_versions`
  com `schema_version`, `runtime_contract_version`, `routing`, `manifest` e
  `manifest_hash` (SHA-256 de JSON canónico). O manifesto fixa definição/hash
  lógico, encaminhamento normalizado, perfis de agente (versão + hash),
  recursos do repositório e instruções globais (hash), ações com contrato e
  resultados, tarefas Copilot (modo/modelo/contrato) e `requires`. Sem
  credenciais nem estado de integrações: revogações continuam a produzir efeito.
- **Ativação atómica** (`POST /flows/:id/activate`, alias `/publish`): exige
  `flows.activate` (P01), lock do fluxo, revisão-base esperada
  (`FLOW_DRAFT_CHANGED` 409), validação de grafo/contratos/responsáveis
  (`FLOW_INVALID` 422), referências móveis (`FLOW_DEPENDENCY_MUTABLE` 422),
  ações sem executor (`FLOW_DEPENDENCY_MISSING` 422), runtime não suportado
  (`FLOW_RUNTIME_UNSUPPORTED` 422), sem alterações (`FLOW_UNCHANGED` 409) e
  substituto obrigatório do «por omissão» (`FLOW_DEFAULT_REQUIRED` 409).
  Repetições/concorrência da mesma revisão devolvem a ativação existente
  (índice único `flow_activations_once`). Regista ator, versão, hash e data
  em `flow_activations`.
- **Transferência do «por omissão».** Só ocorre na ativação do novo fluxo; o
  anterior sai de serviço (sem regra ativa, para não passar a apanhar todos os
  tickets) e fica registado `default_transfer`. Volta ao serviço quando for
  ativado com as suas regras.
- **Sem ativações implícitas.** `ensureDefaultFlows` cria apenas rascunhos;
  `upgradeTemplates`/migração binária alteram só o rascunho; `createAlertFlow`
  cria um rascunho que reclama os alertas em `pending_alert_keys`, associados
  apenas na ativação; `linkAlertFlow` exige `flows.activate` e um fluxo ativo.
- **V2 e compatibilidade V1.** `schemaVersion` 1|2; operação `condition`
  (V2) com condições declarativas allowlisted sobre factos do ticket e porta
  `otherwise`, sem `eval`. O motor recusa carregar runtimes não suportados;
  execuções existentes mantêm a versão fixada. V1 sucesso/erro inalterado.
- **UI.** Editor com estado Ativa/Fora de serviço/Nunca ativado, revisão do
  rascunho V1/V2, aviso de alterações por ativar, «Ativar esta versão»,
  versões imutáveis com hash, histórico de ativações e regra «Em serviço»;
  lista com versão ativa e chip de alterações por ativar; Saúde mostra
  rascunhos de alerta por ativar; editor de condições.

### Migration

[`035_flow_explicit_activation.sql`](../sql/035_flow_explicit_activation.sql) —
aditiva e idempotente: colunas novas em `flow_versions`/`flows`, coluna gerada
`active_default_project` com índice único (um «por omissão» ativo por projeto),
backfill do encaminhamento ativo a partir do estado atual dos fluxos publicados,
tabela `flow_activations` e entrada `migration` para cada versão já em serviço.
Nota: o runner só aceita nomes `^\d+_[a-z_]+\.sql$`; um nome com dígitos depois
do prefixo seria ignorado em silêncio.

### Testes

- Novo `flow-activation.test.ts` (8): templates sem ativação implícita;
  rascunho/regras sem efeito no ativo e ativação só para tickets novos;
  revisão desatualizada, replay idempotente, `FLOW_UNCHANGED`, perfil inválido,
  modelo `latest`, ação sem executor; 3 ativações concorrentes → 1 versão e 1
  ativação; transferência do «por omissão», permissões e isolamento; condições
  V2 (motor, simulação, injeção de campo); manifesto determinístico sem
  credenciais; replay da migration 035 com journal/checksum e preservação.
- Adaptados à semântica P02: `flow-engine`, `project-permissions.service`,
  `project-ticket-purge`, `incident-flow` (ativação explícita dos modelos) e
  teste web de permissões.
- Resultados: `typecheck` OK; `build` OK; `npm test` 336 pass, 1 skipped, 3
  falhas arquiteturais **pré-existentes** (mesmas contagens do baseline: 9/7/5);
  web 121/121; node tests 11/11; lint só com o erro pré-existente `portKey`.

### Limitações e decisões

- Projetos novos ficam sem fluxo ativo (incluindo o da Saúde) até à primeira
  ativação; tickets criados entretanto não entram em fluxo. Intencional:
  nenhum modelo entra em serviço sem ação explícita.
- Prioridades ativas iguais desempatam pelo nome (comportamento anterior).
- Etapa Copilot sem modelo usa o modelo por omissão da integração; esse valor
  não é fixado no manifesto (é configuração/credencial do projeto).
- Mudar só o encaminhamento gera nova versão com a mesma definição.
- O clamp pré-existente de prioridade a 998 em `insertFlow` não foi alterado.
- Fork/join, scheduler, classificação semântica e catálogo de skills ficam para
  P03+.

### Publicação em QA (`main`) — 2026-11-14

Por pedido explícito («no final coloca sempre no servidor de qa no main»):

- Host `uqphorders24-dev` (`pizzahut-qa`); antes `1886643`; sem `agent_runs`
  em `queued`/`running`; nenhum projeto com mais de um «por omissão» publicado.
- Backup independente:
  `/var/backups/zeroops/pre-p02-20261114T111006-1886643.sql.gz`
  (`4d67c375544b030215ee212f984306a0e28e2b5c9274d8510227d259815c92e2`,
  `gzip -t` OK, 71 tabelas, dados de `flows`/`tickets` presentes). Backup do
  deploy: `zeroops-20261114T111215-g11e87f93dbbd.sql.gz`.
- Push sem force da branch `feat/p02-flow-activation` (sem deploy) e
  fast-forward `e0db48d..11e87f9` de `main` no remoto `qa`; o `post-receive`
  executou `deploy/qa/deploy-from-git.sh`: build, migration, arranque e health OK.
- `/api/health` e `deploy/qa/VERSION`: `11e87f93dbbd5bdf4b553e05e75079178885e55d`.
  Migration 035 no journal com checksum
  `a2f65ac23786e57efb9761d11ffd285c04a933cb8d3a3ebc32e1878742b19d56` (igual ao
  local); índice `flows_one_active_default` criado.
- Preservação: os 4 fluxos publicados mantêm `active_*` iguais ao encaminhamento
  anterior (Geral por omissão v2, Incidente (Health) 10 v4, alertas 30/40 v1) e
  têm uma ativação `migration`; «Manutenção de cliente» (nunca publicado)
  continua sem versão ativa.
- UI autenticada (browser) em `#flows/36f80129-…`: «Ativa v2», «Rascunho rev. 2 ·
  V1», «por omissão», «Ativar esta versão» desativado com «O rascunho gravado é
  igual à versão ativa», «Versões imutáveis» (v2 ativa, v1), «Histórico de
  ativações» («Em serviço antes do P02») e opção «Condição (V2)». Lista com
  coluna «Versão ativa» e chip «alterações por ativar».
- Não executado em QA: ativação real de uma nova versão, smoke de editor sem
  `flows.activate` e fluxo V2 com condição (ver [qa-p02.md](qa-p02.md)).
  Produção não foi alterada. P03 fora do âmbito.

## P03 — Jobs, leases e política efetiva de ferramentas

Branch `feat/p03-job-leases`, criada a partir de `401f58d` (P02).

### Ponto de partida confirmado

- QA usa MariaDB 10.3.39: sem `SKIP LOCKED`. O claim usa `SELECT … FOR UPDATE`
  com `UPDATE` condicionado ao estado e ao epoch, dentro da mesma transação.
  Não houve upgrade.
- `failInterrupted` (`agent_runs` e `flow_assistant_requests`) era chamado no
  arranque de qualquer executor e falhava todos os jobs `running`, incluindo
  os de outro executor vivo. Foi removido.
- Antes de P03 o gateway confiava em `X-ZeroOps-Run` + estado `running`, sem
  posse. O contador de chamadas era lido e depois escrito, o que permitia
  ultrapassar o limite com chamadas concorrentes. O plano do SDK era aprovado
  automaticamente no timeout.

### Alterações

- **Tentativas com dono.** `agent_runs` e `flow_assistant_requests` passam a
  ter `worker_id`, `lease_epoch` (token de posse crescente), `lease_until`,
  `heartbeat_at` e `attempt`. `claimNext(worker)` é atómico, respeita o limite
  por projeto e a quiescência do projeto (purga), e devolve um `JobLease`.
  Todas as escritas (progresso, eventos de conversa, consumo de inputs,
  ferramentas efetivas, conclusão, falha e libertação) exigem o
  `workerId`+`epoch` atuais. Uma tentativa antiga recebe `stale` e fica
  registada como `stale_attempt_rejected`, sem efeitos. Uma conclusão repetida
  pelo dono atual devolve `duplicate`, sem duplicar a nota nem os efeitos.
- **Recuperação por lease.** `recoverExpired(maxAttempts)` só toca em jobs
  `running` com `lease_until` expirado (ou `NULL`, legado). Volta a pôr em
  fila (epoch+1, `attempt`+1) até ao limite e depois falha com
  `lease_expired`. Um cancelamento pedido durante a execução fica `cancelled`.
  Corre no arranque e a cada 30 s. Jobs vivos de outros executores ficam
  intactos.
- **Sem repetição cega.** Os runs só produzem efeitos de negócio na conclusão
  transacional e fenced, por isso a nova tentativa depois de um lease perdido
  é segura. Um timeout do Copilot continua a ser uma falha e não é repetido.
  As chamadas a conectores ficam correlacionadas por `run_id`+`lease_epoch`
  em `agent_run_tool_calls`.
- **Executor.** Dois `JobPool` independentes, `assistant` e `runs`, com
  concorrência configurável (1/1 por omissão). Heartbeat a 1/3 do lease. Ao
  perder o lease, ou se o run for cancelado, o executor aborta a sessão
  Copilot e não escreve mais nada. No SIGTERM drena: aborta os jobs ainda em
  curso e liberta-os com `release('shutdown')`, sem consumir tentativa, e
  depois fecha a BD. Compose: `stop_grace_period: 45s` e variáveis
  `ZEROOPS_JOB_*`/`ZEROOPS_EXECUTOR_*`.
- **Política efetiva.** `ConnectorGateway.call` revalida, em cada chamada
  (incluindo chamadas diretas ao gateway):
  - projeto, run `running`, posse (`LEASE_LOST` 401) e cancelamento
    (`RUN_CANCELLED` 409);
  - ferramenta e recurso na versão **atual** do perfil (se o perfil mudar de
    versão ou for arquivado, a autorização é revogada);
  - limite reservado de forma atómica (`tool_calls_used`).
    As recusas ficam auditadas com `lease_epoch`. `PermissionPolicy` resolve
    `realpath` (recusa symlinks/junctions para fora do workspace) e consulta
    `isActive()` antes de cada ferramenta.
- **Aprovação de plano.** `planApproval: 'auto'` aprova sem perguntar quando a
  política já autoriza (runs automáticos). Com `'human'`, o timeout ou a falta
  de resposta dão `approved:false`: o silêncio nunca vale como aprovação.
- **Observabilidade.** `agent_job_events` regista `claimed`, `lease_lost`,
  `lease_expired_requeued|failed|cancelled`, `released`, `cancel_requested`,
  `stale_attempt_rejected`, `completed` e `failed`, com projeto, ticket,
  tentativa, epoch e worker. Os heartbeats ficam em `heartbeat_at`, não como
  eventos. A purga de tickets remove `agent_job_events` por `ticket_id`
  (serviço e `sql/manual/purge_project_tickets.sql` alinhados).
- **UI.** Novo erro `lease_expired` explicado ao utilizador; o badge do run
  mostra «tentativa N» quando N > 1.

### Migration

[`036_agent_job_leases.sql`](../sql/036_agent_job_leases.sql) — aditiva e
idempotente (`ADD COLUMN IF NOT EXISTS`, `CREATE … IF NOT EXISTS`). Faz
backfill de `attempt=1` nos jobs já iniciados e cria índices de lease. Os jobs
antigos `running` ficam com `lease_until NULL` e são reconciliados pela
recuperação (drenar antes da troca).

### Testes

BD real (MariaDB 10.3 local, via `tests/helpers/test-database.ts`):

- `agent-job-leases.test.ts`:
  - claims concorrentes sem duplicação;
  - limite por projeto;
  - outro executor a arrancar não falha jobs vivos;
  - heartbeat mantém a posse;
  - lease expirado: requeue, todas as escritas do worker antigo `stale`, nota
    única, `duplicate` na repetição, `attempt` 2, `lease_expired` quando as
    tentativas se esgotam;
  - `release` e cancelamento a meio;
  - gateway: chamada direta fora da política dá 403 auditado; revogação por
    versão do perfil ou por arquivo; limite atómico concorrente (3×200 e
    3×429); `RUN_CANCELLED`; `LEASE_LOST`.
- `flow-engine.test.ts`: o mesmo cenário de lease expirado para o assistente de
  fluxos.
- `project-ticket-purge.test.ts`: purga inclui `agent_job_events`; a
  quiescência continua a bloquear claims.

Fakes:

- `investigation-runner.test.ts`: lease perdido → nenhuma escrita; heartbeat;
  shutdown → `release`; `planApproval:'auto'`.
- `copilot-sdk.adapter.test.ts`: plano `auto` sem pergunta; timeout `human` dá
  `approved:false`; junction recusada na leitura e na escrita; `isActive=false`
  nega tudo.
- `job-pools.test.ts`: o assistente responde com o pool de runs bloqueado;
  drenagem aborta e liberta; limites da configuração.

Resultados locais:

- `typecheck` e `build` OK.
- `npm test`: 353 pass, 1 skipped. As 3 falhas de arquitetura são as mesmas do
  baseline e são pré-existentes (`incidents`, métodos sem JSDoc fora de P03,
  ciclos); nenhuma vem dos ficheiros P03.
- Web: 121 testes. `project-permissions.test.tsx` falhou uma vez por timing na
  corrida completa e passa isolado (5/5, duas vezes): flaky pré-existente.
- Testes node: 0 falhas.
- Lint: só o erro pré-existente `portKey`.
- Prettier: limpo nos ficheiros alterados.

Não executado:

- matriz multi-host real (dois contentores de executor contra a mesma BD em
  QA);
- kill -9 em QA, por não se poderem interromper trabalhos reais.

### Limitações

- Os conectores atuais (SQL, Loki, Prometheus, relay DB2) são só de leitura
  (`assertReadOnlySql`). Uma nova tentativa recomeça a investigação e pode
  repetir consultas, mas nunca efeitos de negócio. A reconciliação por
  correlação/idempotência de operações externas com efeitos só será
  necessária quando existirem ferramentas de escrita (P04+); as chamadas já
  ficam correlacionadas por `run_id`+`lease_epoch`.
- Ao fazer rollback para código anterior a P03, o arranque antigo volta a
  falhar os `running`. Drenar antes.
- Catálogo de agentes/skills/hooks e reviewers ficam para P04+.

### Publicação e validação em QA (`main`) — 2026-11-14

Antes do primeiro deploy:

- QA em `401f58d`, sem `agent_runs` nem pedidos do assistente em
  `queued`/`running`.
- Backup manual
  `/var/backups/zeroops/pre-p03-20261114T120105-401f58d.sql.gz`
  (`gzip -t` OK, 71 tabelas).

Deploys via `git push qa feat/p03-job-leases:main` (só fast-forward; o hook
faz backup, migrate, compose up, health e rollback):

| SHA       | Backup do hook                                 | Resultado                                  |
| --------- | ---------------------------------------------- | ------------------------------------------ |
| `abe495c` | `zeroops-20261114T120256-gabe495c8edd0.sql.gz` | OK; 036 aplicada (checksum igual ao local) |
| `a01ef24` | `zeroops-20261114T121202-ga01ef24b2a1a.sql.gz` | OK                                         |
| `e6ea371` | `zeroops-20261114T123329-ge6ea371bf774.sql.gz` | OK; inclui `cb1bb3b` e `3d43eb6`           |

Antes de cada troca de executor confirmou-se que não havia jobs ativos.

Defeitos encontrados em QA e corrigidos:

1. **`[FIX] a01ef24`.** O primeiro run (`b0533918`) falhou com erro SQL em
   `recordEffectiveTools`. O cliente SQL expande arrays em listas (`IN`), por
   isso `effective_tools` e, em `queueAgentRun`, `allowed_tools` e
   `repository_resources` têm de ir em `JSON.stringify`. Defeito latente
   anterior a P03, exposto pela nova escrita. Tem testes de regressão em BD
   real.
2. **`[FIX] cb1bb3b`.** Os pedidos do assistente não registavam
   `completed`/`failed` em `agent_job_events`.
3. **`[FIX] 3d43eb6`.** O Fusion encaminhou a investigação para
   `gpt-6-luna`. Nos modelos GPT o runtime cria ficheiros com `apply_patch`
   (confirmado no `runtime.node` 1.0.30), que não estava em
   `availableTools`. O agente pediu à equipa autorização para gravar o
   relatório. Passados 10 min sem resposta, o timeout foi tratado como **não
   aprovação** (`Sem resposta da equipa; o agente continua sozinho.`) e o run
   `c1b663a9` falhou com «Relatorio ausente». Agora `apply_patch` está
   disponível e a política valida **todos** os caminhos de `fileEdits`.

Evidência observada em QA (`a01ef24`, executor `uqphorders24-dev:1:fa965343`,
`leaseSeconds` 90, concorrência 1 + 1):

- Run automático do fluxo de incidentes `c1b663a9` (ZO-19): `claimed`
  (attempt 1, epoch 1), `effective_tools` gravado como JSON
  (`["view","grep","glob","sql","prom","log"]`).
  - Heartbeat renovado de 12:12:24 a 12:26:10 (`lease_until` = heartbeat +
    90 s), incluindo os 10 min à espera da pergunta.
  - Conclusão `failed` + evento `failed` (defeito 3).
- Segundo run automático `fd0668bc` (outro incidente): ficou `queued` enquanto
  o pool de runs estava ocupado e foi reclamado logo a seguir (12:26:15).
- Assistente de fluxos (`52e1f26b`, pedido do editor
  `#flows/36f80129-…`): reclamado 2 s depois do envio e `succeeded` com o
  run longo em curso. Prova que o pool do assistente não fica bloqueado.
- Comandos de conectores (`zo-prom`, `zo-log`) aprovados pela política sem
  perguntas humanas.

Smoke final em `e6ea371` (executor `uqphorders24-dev:1:c9833fb6`):

- O ZO-19 foi reaberto para teste com
  `POST /api/tickets/:id/transitions` (`action: reopen`, nota
  `[Teste P03 QA]`). A UI de incidentes não mostra «Reabrir».
- Investigação manual `0791c6ce` (Fusion → `gpt-6-luna`): `claimed`
  (attempt 1, epoch 1) às 12:35:48.
  - 6 comandos `zo-prom` aprovados automaticamente.
  - O relatório foi gravado com `apply_patch` (`.zeroops-result.json`), sem
    perguntas à equipa.
  - Terminou `succeeded` às 12:38:49, com o evento `completed`.
- O editor `#flows/36f80129-…` mantém a ativa v2, o rascunho igual à ativa,
  as versões imutáveis, o histórico de ativações e o assistente.

Não executado em QA: kill -9 de executores, multi-host e expiração forçada de
lease. Para não interromper trabalho real, estes cenários ficam cobertos só
pelos testes locais em BD real.

## P04 — Catálogo de agentes/skills e compilação para Copilot

Branch `feat/p04-capability-catalog`, criada a partir de `44c6621` (P03).

### Ponto de partida confirmado

- Já existia um catálogo de perfis versionados (`zeroops_agent_profiles`,
  migration 030), a descoberta de recursos do repositório
  (`.github/agents`, `.github/skills`) e o snapshot do perfil no run. P04
  evolui esse catálogo; não há um segundo catálogo concorrente.
- SDK `@github/copilot-sdk` 1.0.30, com o runtime 1.0.108 fixado. Não houve
  upgrade. Capacidades confirmadas numa sonda real e no smoke:
  - `customAgents` (`tools`, `infer`) e `agent` para o agente principal;
  - `skillDirectories` e `enableSkills`, com a ferramenta nativa `skill`;
  - a ferramenta `task` para delegar (`agent_type`);
  - os eventos `skill.invoked`, `subagent.started`/`completed`/`failed` e
    `session.skills_loaded`;
  - `hooks.onPreToolUse`, que dispara também nas chamadas dos subagentes e
    traz `toolCallId` no runtime 1.0.108.
- O campo `allowed-tools` do `SKILL.md` é auto-aprovado pelo runtime.
  Por isso a importação rejeita-o: uma skill não pode conceder permissões.

### Alterações

- **Skills versionadas.** Novas tabelas `zeroops_skills`,
  `zeroops_skill_versions` (só INSERT) e `zeroops_skill_version_files`.
  - Cada versão é um bundle de texto: `SKILL.md`, scripts, referências e
    exemplos, com caminhos relativos validados.
  - O `bundle_hash` é o sha256 canónico dos metadados e de cada par
    (caminho, sha256). O mesmo conteúdo gera sempre o mesmo hash.
  - Importar o mesmo conteúdo é idempotente. Um conteúdo diferente cria
    uma nova versão. As versões existentes e a fonte importada nunca são
    alteradas.
- **Importação com proveniência.** Pode importar-se `SKILL.md` e
  `.agent.md` do repositório do projeto ou por upload de pasta/ficheiro.
  - A origem (repositório e caminho, ou upload) e o hash da fonte ficam
    registados.
  - São rejeitados: front-matter inválido, nomes diferentes da pasta,
    `allowed-tools`, caminhos absolutos ou com `..`, links relativos para
    ficheiros inexistentes, binários, limites de tamanho e declarações de
    dependências inválidas. A existência das dependências é verificada na
    ativação.
  - No `.agent.md`, as ferramentas desconhecidas e o modelo são ignorados,
    sem elevar permissões.
- **Bindings por projeto.** `zeroops_skill_bindings` liga as ferramentas
  requeridas por uma skill às ferramentas autorizadas do projeto.
  - Sem binding, a ativação de um fluxo que usa a skill é bloqueada com
    `SKILL_TOOL_NOT_BOUND`.
  - Revogar um binding também bloqueia os runs já fixados no claim
    seguinte (`skill_tool_not_bound`).
- **Partilha explícita.** `zeroops_capability_shares` partilha uma versão
  concreta de uma skill ou de um agente com outro projeto.
  - Partilhar exige gestão na origem e acesso ao destino. Adotar exige
    gestão no destino.
  - A adoção cria uma cópia local com proveniência. Não transporta
    bindings, credenciais, conversas nem acesso aos recursos da origem.
  - Uma partilha revogada não pode ser adotada
    (`CAPABILITY_SHARE_REVOKED`).
- **Permissões (P01).** Nova permissão delegável `skills.manage` para gerir
  skills, bindings e partilhas.
  - Consultar o catálogo exige `flows.view`.
  - Importar e partilhar agentes exige `agents.manage`.
  - Todas as operações são auditadas.
- **Etapas e manifesto (P02).** A configuração da etapa aceita
  `skills: [{skillId, version}]`, `delegates: [{profileId, version}]` e
  `delegation.maxConcurrency` (1 a 3).
  - Na ativação, o manifesto fixa as versões e os hashes, e
    `delegationByNode` fica com `maxDepth` 1.
  - A ativação é bloqueada com erro claro em vários casos: skill
    arquivada ou inexistente, dependência de skill em falta
    (`SKILL_DEPENDENCY_MISSING`), ferramenta sem binding, e especialista
    com ferramentas fora das da etapa (`DELEGATE_PERMISSION_ESCALATION`).
- **Runs fixados.** `agent_runs.capability_manifest` e
  `capability_manifest_hash` guardam o agente principal, os especialistas,
  as skills (versão, hash e ficheiros) e os limites.
  - Uma nova versão publicada não altera os runs já criados.
  - O claim entrega os ficheiros da versão fixada.
  - Os perfis e runs anteriores, sem capacidades, mantêm o comportamento
    (sem as chaves `skills`/`delegates`).
- **Compilação para o SDK (executor).**
  - `materializeCapabilities` reproduz cada bundle num diretório próprio
    do job, só de leitura, e verifica o hash de cada ficheiro. Ficheiros a
    mais, conteúdo adulterado ou caminhos inseguros falham o run
    (fail-closed). O diretório é removido no fim.
  - `compileSessionCapabilities` gera os `customAgents` (o principal com
    `infer:false`; os especialistas só de leitura, sem `task`, ou seja,
    profundidade 1) e as `skillDirectories` nativas.
  - As skills são carregadas por relevância pela ferramenta `skill`; não
    são concatenadas no prompt.
  - O diretório das skills entra nas pastas só de leitura da
    `PermissionPolicy`.
- **Guarda de ferramentas.** `CapabilityToolGuard`, em `onPreToolUse`,
  recusa:
  - qualquer chamada sem posse ou com o run cancelado (`isActive`);
  - skills e especialistas fora do manifesto;
  - especialistas acima do limite de concorrência;
  - delegação sem `toolCallId`, porque a vaga não poderia ser libertada.

  A guarda nunca aprova: a decisão final continua na `PermissionPolicy` e no
  `ConnectorGateway` de P03, que também se aplicam às chamadas dos
  especialistas. O CLI antigo recusa runs com capacidades.

- **Eventos.** O mapper converte `skill.invoked` e `subagent.*` num novo
  evento `capability`, correlacionado com o `toolCallId`. A timeline do
  ticket mostra «Skill X carregada» e «Especialista Y iniciado, concluído ou
  falhou». O detalhe da falha é redigido, e não há conteúdo interno das
  skills nos eventos públicos.
- **API.** Rotas em `/api/project-admin/:projectId`:
  - `GET skills`;
  - `POST skills/import`, `skills/:id/versions`, `skills/:id/archive` e
    `skills/:id/bindings`;
  - `POST capability-shares`, `…/:id/revoke` e `…/:id/adopt`;
  - `POST agent-profiles/import`.
- **UI.** Nova página `#capabilities` («Agentes e skills»):
  - **skills:** versões, origem, hash, ficheiros, requisitos, bindings,
    nova versão, arquivo e partilha;
  - **agentes:** importação de `.agent.md` e partilha;
  - **partilhas:** recebidas (adotar) e emitidas (revogar).

  Na etapa de agente passou a ser possível escolher as skills, os
  especialistas e a concorrência, com versão, hash e avisos de
  disponibilidade.

### Migration

[`037_capability_catalog.sql`](../sql/037_capability_catalog.sql) é aditiva e
idempotente (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`):

- cria as tabelas de skills, versões, ficheiros, bindings e partilhas;
- acrescenta `provenance` às versões de perfis;
- acrescenta `capability_manifest`/`capability_manifest_hash` a
  `agent_runs`.

Não altera dados existentes.

### Testes

BD real, em `skills.service.test.ts` (20 testes):

- hash estável e 11 casos de rejeição do bundle;
- importação do repositório, com proveniência e recursos relativos;
- importação idempotente, nova versão, conflito de nome e caminho
  inválido;
- permissões e isolamento entre projetos;
- partilha sem acesso ao destino, adoção sem bindings e com proveniência, e
  partilha revogada;
- partilha e adoção de agentes;
- bloqueios de ativação (ferramenta sem binding, dependência em falta,
  elevação por especialista, skill arquivada) e `delegationByNode`;
- perfis sem capacidades com o comportamento anterior;
- run fixado: o claim entrega os ficheiros, uma v2 não altera o run, e a
  revogação do binding bloqueia o claim seguinte.

Fakes:

- `capability-bundle.test.ts` (9 testes):
  - materialização só de leitura e limpeza;
  - adulteração, ficheiros a mais e travessia de caminhos;
  - compilação nativa;
  - guarda (skill ou agente desconhecido, limite e `release`, perda de
    posse, delegação sem `toolCallId`);
  - mapper de eventos;
  - recusa do CLI.
- `copilot-sdk.adapter.test.ts`: a sessão recebe `agent`, `customAgents`,
  `skillDirectories` e as ferramentas `skill`/`task`. O hook recusa e
  publica as skills e os especialistas não fixados.

Copilot real (opt-in `ZEROOPS_COPILOT_SMOKE=1`, autenticação local do
programador, fixtures sintéticas): no `copilot-compatibility.smoke.test.ts`,
o novo cenário compila uma skill fixada (com `references/token.md`) e um
especialista através de `materializeCapabilities`,
`compileSessionCapabilities` e `CapabilityToolGuard`. O agente principal
delegou com `task` em `smoke-reader`, que carregou a skill
(`skill.invoked`), leu a referência relativa e devolveu o token. Houve
`subagent.started`/`completed`, nenhuma recusa da guarda e nenhuma vaga
pendente. Resultado: passou (27 s).

Resultados locais:

- `typecheck` e `build` OK.
- `npm test`: 385 pass, 2 skipped. As 3 falhas de arquitetura são as do
  baseline (`incidents`, métodos sem JSDoc fora de P04, ciclos). As duas
  lacunas de JSDoc de P04 foram corrigidas.
- Web: 121 testes e testes node, 0 falhas.
- Lint: só o erro pré-existente `portKey`.
- Prettier: limpo nos ficheiros alterados.

Não executado: o E2E de browser (`test:browser`); a UI foi verificada no
QA.

Correções da revisão de código (antes do commit):

- **Alta — `allowed-tools` disfarçado.** O parser próprio do frontmatter
  não reconhecia formas como `allowed-tools : x`, `"allowed-tools": x`,
  mapas em fluxo ou escapes YAML, que o runtime auto-aprovaria. A nova
  regra partilhada `skillFrontmatterViolation` (contratos) recusa qualquer
  menção a allowed-tools e só aceita chaves de topo simples. Aplica-se na
  importação/versão (backend) e de novo na materialização do executor. Os
  testes cobrem 5 variantes no backend e uma no executor.
- **Média — configuração escondida no editor.** Limpar ou arquivar o perfil
  principal passou a remover `skills`, `delegates` e `delegation`. Mudar
  para um perfil que já era especialista remove-o dos delegados.

Repetido após as correções: typecheck OK; 52 testes direcionados OK
(bundle, catálogo e adapter); lint só com `portKey`. Web: 121 testes; uma
execução sob carga teve um timeout em `identity.test.tsx` (fora de P04),
que passou ao repetir (18/18).

### Limitações

- O comando de shell dos especialistas usa a lista de comandos de conectores
  da etapa, não apenas a do especialista. Não há elevação: a ativação
  rejeita especialistas com ferramentas fora das da etapa, e o gateway
  revalida cada chamada. Ainda assim, um especialista pode usar uma
  ferramenta da etapa que não está no seu perfil.
- O modelo do perfil do especialista não é aplicado aos `customAgents`: os
  especialistas usam o modelo da sessão.
- A profundidade de delegação é 1: os especialistas não recebem `task`.
- A delegação nesta fase é só de leitura: os especialistas não recebem
  `edit`, `create` nem `apply_patch`, e não há escrita concorrente no
  checkout.
- As skills são só de texto, e os scripts não são executados pela skill.
  Executar comandos continua a depender das ferramentas e conectores
  autorizados na etapa.
- A timeline mostra os eventos de capacidades só em português.

### Publicação e validação em QA (`main`) — 2026-11-14

- Antes do deploy não havia runs em fila nem em curso. Backup
  `/var/backups/zeroops/pre-p04-20261114T134634.sql.gz`: `gzip -t` OK,
  74 `CREATE TABLE`, «Dump completed».
- Push da branch `feat/p04-capability-catalog` para `qa` (sem deploy),
  seguido de `qa :main`. O hook publicou `02f4059` com estado OK.
  `VERSION=02f405994e47…`, health `ready` nessa versão, migration 037
  aplicada com as 5 tabelas novas, contentores ativos e executor arrancado
  com leases.
- Execução real, no projeto `00000000-0000-4000-8000-000000000001`, com o
  Copilot SDK 1.0.30, runtime 1.0.108 e modelo claude-sonnet-5-5:
  - Skill `zo-p04-qa-token` importada por upload: v1 com hash
    `973fae985fa5`, `SKILL.md` e `references/token.md`. Importar de novo o
    mesmo nome devolveu 409 `SKILL_NAME_EXISTS`. O mesmo conteúdo através
    de `/skills/:id/versions` foi idempotente e manteve a v1. Um
    `"allowed-tools": bash` disfarçado foi recusado com 422 `SKILL_INVALID`.
  - Perfis «ZO P04 QA principal» e «ZO P04 QA leitor» (especialista) v1,
    ambos sem ferramentas.
  - Fluxo de teste V2 «Teste P04 (capacidades)»: `copilot_task` → `end`,
    ativado como v1 com manifesto `6ba49776de8c…`.
  - O ticket ZO-21 (`f4b39188-…`) gerou o run `c75bc3f1-…` com
    `capability_manifest_hash` `043c25824b8e7a2b`. O executor registou
    `agent.capabilities_materialized` com o agente
    `zo-p04-qa-principal-c1dd7c43`, a skill `zo-p04-qa-token@1` e o
    especialista `zo-p04-qa-leitor-7724f2fd@1`.
  - Sequência de eventos:
    1. o principal delegou com `task` e o especialista começou;
    2. o especialista chamou a ferramenta `skill`, que carregou
       `zo-p04-qa-token`;
    3. leu `references/token.md` a partir do bundle materializado;
    4. concluiu e devolveu o token `ZO-P04-QA-5K8N2`.
  - Sem recusas do guard. O run terminou `succeeded`, o fluxo concluiu e o
    ticket ficou «Resolvido». Na UI do ticket aparece «Especialista
    «zo-p04-qa-leitor-7724f2fd» concluído» com as 4 ferramentas.
  - Entre a última mensagem e o fim do run passaram 121 s. O run anterior
    sem capacidades, de 12:35, tem o mesmo intervalo, por isso não é efeito
    da P04.
- Fixação: depois de publicar a v2 da skill (hash `3a2bc05256b7`, token
  diferente), o fluxo manteve a mesma ativação e não ficou com alterações
  pendentes. O manifesto do run continua com a skill v1 (`973fae985fa5`) e
  o especialista v1.
- UI: no separador Etapa do fluxo de teste aparecem o perfil principal v1,
  a skill v1 (com a v2 disponível) e o especialista com concorrência 1. Em
  `#capabilities` aparecem as versões, a origem e os hashes. O fluxo
  «Geral» (`36f80129-…`) ficou sem alterações: ativa v2, rascunho rev. 2,
  sem alterações pendentes.
- Limpeza: a regra do fluxo de teste passou para o ambiente `development`,
  que não é aceite em tickets novos, com prioridade 998, e ficou ativada
  como v2 (manifesto `10a7da2d5d26`). Não ficaram runs em fila nem em
  curso. Os fluxos reais do cliente não foram alterados.

## P05 — Encaminhamento semântico com esclarecimentos

Branch `feat/p05-semantic-routing`, criada a partir de `c8adb9d` (P04).
Guia de publicação: [qa-p05.md](qa-p05.md).

### Ponto de partida confirmado

- A seleção era determinística (`selectFlow`): primeira regra coincidente
  por prioridade, ou o fluxo por omissão. As associações de Health
  (`flow_alert_keys`, P02) escolhiam diretamente.
- Os tickets entravam no fluxo dentro da transação de criação
  (`onTicketCreated`), com a versão ativa fixada no `flow_executions`.
- Para as perguntas ao cliente já existia o chat público do ticket (`ticket_comments`) e o estado
  `awaiting_information`.
- As versões ativas guardam o encaminhamento (`flow_versions.routing`) e o
  manifesto (P02). A classificação pode reutilizar o `FlowAssistantRunner`
  (P03/P04), com os leases e a política de ferramentas.

### Alterações

- **Política versionada.** Cada fluxo tem uma `routingPolicy`:
  - instruções em linguagem natural;
  - até 10 exemplos positivos e 10 negativos;
  - `fallbackOnUnresolved`.

  A política do rascunho fica em `flows.routing_policy`. A política ativa
  é copiada para `flow_versions.routing.policy` e entra no manifesto e no
  hash. Editar a política marca alterações pendentes de encaminhamento; só
  «Ativar esta versão» a põe em serviço.

- **Plano de seleção** (`planFlowSelection`, nos contratos, puro):
  - Associação de Health ou primeira regra coincidente sem instruções →
    escolha direta. É o comportamento anterior, preservado.
  - Caso contrário, os candidatos são os fluxos semânticos coincidentes até
    ao primeiro não semântico. O fallback é esse fluxo, ou o fluxo por
    omissão.
  - Um só candidato sem fallback é escolhido diretamente.
- **Candidatos fixados** (`ticket_routing`). Na criação do ticket guardam-se:
  - as versões ativas de cada candidato (chaves `C1..Cn`) e do fallback
    (`F`);
  - o `policy_hash` (sha256);
  - o contexto de entrada.

  Classificação, perguntas, retries e escolha manual usam sempre este
  conjunto. Uma ativação posterior não troca os candidatos. Enquanto não
  há escolha definitiva, nenhum fluxo candidato é executado.

- **Classificação Copilot** (`ticket-routing-queue.ts`, pool `routing` do
  executor). Cada ronda é um job com lease, época e heartbeat (modelo P03).
  - O prompt contém só os candidatos fixados e trata o pedido e as
    respostas como dados.
  - `parseRoutingDecision` valida o JSON (`choose`/`clarify`/`none`, motivo,
    alternativas, pergunta) e rejeita chaves inventadas. A confiança
    declarada é ignorada.
  - O classificador corre como o assistente dos fluxos: modo `investigate`,
    num workspace temporário vazio, sem conectores nem acesso ao repositório.
    Não toca em efeitos dos candidatos.
- **Esclarecimento.** `clarify` publica a pergunta como comentário público
  do assistente e põe o ticket em `awaiting_information`. O pedido fica em
  `awaiting_reply`, com `question_id` e prazo de 72 h, sem sessão Copilot
  aberta.
  - Só um comentário público do autor do ticket conta como resposta
    (`ticket_routing_replies`, uma por `question_id`). Comentários internos,
    de outros utilizadores ou repetidos não criam outra ronda.
  - A resposta cria a ronda seguinte com o mesmo conjunto fixado.
  - Há no máximo 2 perguntas.
- **Sem escolha arbitrária.** Os casos não resolvidos vão para o fallback
  só se esse fluxo tiver `fallbackOnUnresolved`; caso contrário ficam em
  `pending_manual`. Não resolvidos são: prazo esgotado, perguntas
  esgotadas, `none`, Copilot não configurado ou 3 falhas.
  - Uma resposta inválida do modelo conta como falha, com retry diferido
    de 60 s.
  - Uma dependência obrigatória indisponível no momento da escolha bloqueia
    com motivo explícito.
  - Ticket fechado ou cancelado → `cancelled`.
- **Associação única.** `finalize` inicia o fluxo escolhido com a versão
  fixada (`startWith`), uma única vez, e passa o pedido para `routed`.
  Mensagens ou regras posteriores não mudam o fluxo.
  - A ordem de bloqueio é ticket → routing → job.
  - Só a ronda atual (`job.seq = routing.job_seq` em `classifying`) aplica
    efeitos.
  - Tentativas sem lease são rejeitadas (`stale`), e a repetição da mesma
    tentativa é `duplicate`.
- **Escolha manual.** `POST /api/tickets/:id/flow/routing/manual` exige
  `flows.activate` (P01), só aceita candidatos fixados e regista o motivo.
- **Recuperação.**
  - O executor recupera os jobs de routing com lease expirado (requeue até
    ao limite de tentativas).
  - O worker expira as perguntas sem resposta (`expireOverdue`).
  - A purga do projeto apaga as tabelas novas e recusa jobs de routing em
    curso. O script manual de referência foi atualizado.
- **UI.**
  - Separador «Regras» do editor: secção «Encaminhamento semântico», com
    instruções, exemplos, fallback e a política em serviço.
  - Lista de fluxos: o resumo marca «semântico».
  - Detalhe do ticket: painel interno «Encaminhamento», com estado,
    pergunta pendente (marcada «para o cliente»), decisão, alternativas,
    candidatos fixados com hash, escolha manual e histórico.
  - O cliente não recebe a vista (`GET …/flow/routing` → `null`) e vê
    apenas a pergunta pública.

### Migration

[038](../sql/038_ticket_semantic_routing.sql), aditiva e idempotente:

- `flows.routing_policy`;
- `ticket_routing`, `ticket_routing_jobs`, `ticket_routing_replies` e
  `ticket_routing_events`;
- `agent_job_events.job_kind` passa a aceitar `ticket_routing`.

Não reencaminha os tickets existentes. As versões ativas sem `policy`
continuam a ser interpretadas como regras não semânticas.

### Testes

BD real, `ticket-routing.test.ts` (11 testes). O classificador é um fake
determinístico sobre um conjunto rotulado; os leases, a fila e as
transações são reais.

- Plano de seleção e validação da decisão: chave inventada, texto sem JSON,
  confiança ignorada.
- Conjunto rotulado:
  - «Qual é o estado do pagamento da encomenda…?» → Consulta;
  - «Precisamos de adicionar outro método de pagamento» → Desenvolvimento;
  - «Problema com os pagamentos» → pergunta pública ao autor, com o ticket
    em `awaiting_information`, sem execução e com a vista oculta ao
    cliente.
- Resposta do autor depois de um «reinício» (novos serviços sobre a mesma
  BD). Uma ativação de nova versão e de um novo fluxo durante a espera não
  altera o prompt nem as versões. Comentários internos, de outros
  utilizadores ou repetidos são ignorados. Depois de `routed`, novas
  mensagens não mudam o fluxo.
- A política no rascunho não muda o encaminhamento ativo; a ativação muda
  apenas os tickets novos.
- Falhas do classificador sem execução indevida. Copilot indisponível →
  `pending_manual`, ou fallback só com `fallbackOnUnresolved`.
- Prazo esgotado → `pending_manual`; resposta tardia ignorada.
- Tentativa antiga sem lease → `stale`; a recuperada aplica uma vez; a
  repetição dá `duplicate`.
- Escolha manual:
  - só `flows.edit` → 403;
  - cliente → 403;
  - outro projeto → 404;
  - versão não fixada → recusada;
  - `flows.activate` → `routed`;
  - segunda escolha → 409.
- Associação de Health prevalece sem encaminhamento.
- Ticket cancelado durante a espera → `cancelled`.
- Correção da revisão de código: a pergunta pública que contenha uma chave
  interna (C1…, F), um nome de fluxo com várias palavras ou um nome citado
  é recusada como resposta inválida, contando como falha da ronda. Assim
  nada de interno chega ao cliente.

Web (`project-permissions.test.tsx`):

- o formulário envia a `routingPolicy` normalizada;
- o painel mostra a pergunta, as alternativas e os candidatos, e só
  oferece a escolha manual com `canRoute` e o encaminhamento aberto.

Resultados locais:

- `typecheck` e `build` OK.
- `npm test`: só as 3 falhas de arquitetura do baseline. As contagens
  9/7/5 mantêm-se: as 7 lacunas de JSDoc de P05 foram corrigidas antes da
  contagem final.
- A purga (`project-ticket-purge.test.ts`) passou depois de alinhar o
  script manual.
- Web: 122 de 123 testes. A falha foi o teste instável conhecido
  `identity.test.tsx`, fora de P05. `project-permissions.test.tsx` passou
  3 vezes seguidas (7/7).
- Lint: só o erro pré-existente `portKey`.
- Prettier: limpo nos ficheiros alterados.

Não executado localmente: classificação com o Copilot real. É validada no
QA.

### Limitações

- O pedido do autor e as respostas são enviados ao modelo como dados, com
  instrução explícita para ignorar ordens contidas neles. O backend valida
  sempre a decisão contra o conjunto fixado.
- As perguntas e respostas são texto livre no chat público; não há
  formulários estruturados.
- O prazo de resposta (72 h), o limite de perguntas (2) e o limite de
  falhas (3) são constantes, não configurações por projeto.
- A escolha manual não reabre um encaminhamento terminado.

### Publicação e validação em QA (`main`) — 2026-11-14

- Pré-voo:
  - health `ready` em `c8adb9d`;
  - sem runs nem pedidos do assistente em fila ou em curso;
  - backup manual `/var/backups/zeroops/pre-p05-20261114-145637.sql.gz`
    (`gzip -t` OK, 79 `CREATE TABLE`).
- Push da branch `feat/p05-semantic-routing` para `qa` (sem deploy),
  seguido de `qa :main`. O hook publicou `6c6c224` com estado OK:
  - migration `038_ticket_semantic_routing.sql` registada;
  - tabelas `ticket_routing*` e coluna `flows.routing_policy` criadas;
  - executor arrancado com `routingConcurrency: 1`.
- **Regressão encontrada em QA e corrigida (`5f5bd8f`).** Criar um fluxo
  novo no projeto de teste dava 500. A criação usava `MAX(prioridade)+10`
  limitado a 998, e a 998 estava ocupada pelo fluxo retirado de P04, o que
  violava a chave única.
  - Passou a usar uma prioridade livre; sem nenhuma livre devolve 409.
  - Teste em `flow-activation.test.ts`.
  - Republicado pelo hook, com backup automático
    `zeroops-20261114T151058-g5f5bd8f27671.sql.gz` e estado OK.
- Execução real no projeto `00000000-0000-4000-8000-000000000001`, com o
  Copilot SDK 1.0.30, runtime 1.0.108 e modelo claude-sonnet-5-5.
  - Fluxos de teste «Teste P05 Consulta», «Teste P05 Desenvolvimento» e
    «Teste P05 Fallback» (`fallbackOnUnresolved`), todos com a regra
    `portal_team`/`question`/`quality`/`low` e prioridades 101 a 103.
    Ativados como v1.
  - ZO-22 «Qual é o estado do pagamento da encomenda 784512?» → `routed`
    para Consulta v1. Motivo: «O autor pede apenas o estado do pagamento
    de uma encomenda, sem pedir alterações ao sistema.»
  - ZO-23 «Precisamos de adicionar outro método de pagamento no checkout»
    → `routed` para Desenvolvimento v1. Motivo: «exige alterar código ou
    configuração do sistema».
  - ZO-24 «Problema com os pagamentos.» → `awaiting_reply` e ticket em
    `awaiting_information`, com a pergunta pública: «Pretende saber o
    estado de um pagamento concreto ou pedir uma alteração ao
    funcionamento dos pagamentos? Se possível, descreva o problema.» A
    pergunta não refere nomes nem chaves internas. Alternativas C1 e C2.
  - Durante a espera ativei a Consulta v2. Os candidatos fixados do ZO-24
    continuaram na v1, com `policyHash` `5ed3c2459686…`.
  - A resposta pública do autor retomou a classificação → `routed` para
    Consulta **v1** (`resolution: classified`).
  - Uma nova mensagem do autor a pedir desenvolvimento não alterou a
    associação. Uma escolha manual posterior devolveu 409
    `ROUTING_CLOSED`.
  - BD:
    - uma `flow_executions` por ticket;
    - ZO-24 com 2 jobs de encaminhamento e 1 resposta registada;
    - `agent_job_events` `ticket_routing`: 4 `claimed` e 4 `completed`;
    - executor: 4 `flow_assistant.succeeded` com `scope: routing`.
  - UI (equipa), separador Fluxo do ZO-24:
    - painel «Encaminhamento · interno» com o fluxo escolhido;
    - última decisão e alternativas;
    - candidatos fixados com o hash da política;
    - histórico.
      Na conversa do cliente aparece apenas a pergunta pública.
  - O rótulo da resolução aparecia em bruto («classified»). Passou a
    «classificado pelo Copilot», «fallback» ou «escolha manual».
- Limpeza:
  - os fluxos de teste usam o template «em branco», com a etapa «Análise
    do Copilot», por isso cada ticket gerou um run de análise; os três
    foram cancelados;
  - os fluxos de teste passaram ao ambiente `development` com o sufixo
    «— retirado» e foram ativados (Consulta v3, os outros v2);
  - não ficaram runs, pedidos do assistente nem jobs de encaminhamento
    ativos;
  - os fluxos reais do cliente não foram alterados.

## P06 — Chat de construção com diagrama em tempo real

Branch `feat/p06-authoring-chat`, criada a partir de `651b6b0` (P05).
Guia de publicação: [qa-p06.md](qa-p06.md).

### Ponto de partida confirmado

- O assistente dos fluxos (`flow_assistant_requests`, executado pelo
  `FlowAssistantRunner`) já corria com job, lease, época, cancelamento e
  recuperação (P03). Devolvia **uma única** proposta de definição no fim, que
  o utilizador aplicava com «Aplicar».
- O rascunho tinha `draft_version` (concorrência otimista nos saves
  manuais), `draft_dirty` e a validação de P02. A ativação era já uma ação
  explícita com `flows.activate` (P01).
- Os agentes, skills e ferramentas por etapa (P04) e a política de
  encaminhamento (P05) estavam na definição/rascunho do fluxo, pelo que podem
  ser alterados com as mesmas operações tipadas.
- O SDK 1.0.30 suporta ferramentas próprias (`tools` com `handler`) e pede
  permissão com `kind:'custom-tool'`. O adaptador CLI não as suporta.

### Alterações

- **Sessão de autoria persistente** por fluxo e utilizador
  (`flow_authoring_sessions`), com modo `assisted` (omissão) ou `auto`. Os
  pedidos ao assistente guardam `session_id`, `authoring_mode` e
  `known_revision`. Todo o estado (mensagens, operações, propostas, eventos,
  capacidades em falta) fica na BD; recarregar a página ou reiniciar
  processos não perde nada e não depende da sessão Copilot.
- **Ferramentas tipadas do SDK** (`FlowAuthoringTools`, registadas pelo
  executor apenas em pedidos com sessão):
  - `get_flow_draft` — lê o rascunho e a revisão atuais;
  - `apply_flow_operations` — lote de operações existentes de P02
    (etapas, ligações, responsáveis, condições, instruções, agentes, skills,
    ferramentas), até `FLOW_AUTHORING_BATCH_LIMIT`, com `baseRevision`;
  - `set_flow_routing` — política de encaminhamento suportada (P05);
  - `report_missing_capability` — regista uma capacidade em falta.

  Cada chamada é revalidada no backend: posse do job (lease + época), permissão
  `flows.edit` atual do autor, projeto, schema, integridade do grafo e
  revisão-base. Um lote é **atómico**: aplica-se inteiro numa transação ou é
  rejeitado sem tocar no rascunho. O texto do stream nunca é interpretado como
  alteração; só chamadas estruturadas ou a mensagem final completa e validada
  (compatibilidade com pedidos sem sessão/ferramentas).

- **Modos.**
  - _Assistido_: as operações ficam `proposed`; o utilizador vê a
    pré-visualização e aceita (nova revisão auditada) ou descarta.
  - _Automático_: as operações válidas são aplicadas ao rascunho enquanto o
    agente trabalha.

  Em ambos, o rascunho pode ficar temporariamente incompleto; a ativação
  continua a exigir «Ativar esta versão», `flows.activate` e as validações de
  P02. As ferramentas não ativam fluxos nem alteram permissões.

- **Histórico e desfazer** (`flow_authoring_operations`): ator, sessão,
  pedido, revisão-base, revisão resultante, definição antes/depois e
  resultado (`applied`, `proposed`, `rejected`, `conflict`, `accepted`,
  `discarded`). Desfazer cria uma **nova** revisão (`source: undo`); recusa
  com `FLOW_DRAFT_CHANGED` se a revisão esperada mudou e com
  `FLOW_UNDO_UNAVAILABLE` se já foi desfeita. Não mexe em versões ativas nem
  em tickets.
- **Concorrência.** Uma operação baseada numa revisão desatualizada fica
  `conflict` com a proposta preservada; o agente recebe o estado atual e pode
  reformular. Uma edição manual com `draft_version` antigo continua a ser
  recusada (409) e o editor mostra o aviso «Recarregar».
- **Eventos persistentes** (`flow_authoring_events`, cursor numérico,
  idempotência por chave): `GET …/authoring/events?after=` (polling) e
  `GET …/authoring/events/stream` (SSE com `id:`, replay a partir de
  `Last-Event-ID`/`after`). Cada leitura revalida o acesso ao projeto e a
  permissão atual; os payloads são limitados (48 000 caracteres, com
  `truncated`) e contêm apenas dados do rascunho, sem credenciais nem
  conteúdo dos conectores. Não há raciocínio do modelo nos eventos, apenas
  progresso, operações, resultados e erros.
- **Capacidades em falta** (`flow_capability_requests`): registadas pelo
  agente, idempotentes por fluxo/tipo/nome, ligadas ao rascunho e apresentadas
  como bloqueio. Nenhuma ferramenta é criada nem anunciada como disponível; o
  desenvolvimento e rollout ficam para P10.
- **API**: `GET …/authoring`, `POST …/authoring/mode`,
  `POST …/authoring/operations/:id/undo`, eventos e SSE. Aceitar/descartar
  propostas usa `POST …/assistant/:requestId/resolution`.
- **Executor**: `flow-assistant-runner.ts` regista as ferramentas e
  `permission-policy.ts` aprova apenas as ferramentas de autoria (`custom-tool`
  conhecidas) em pedidos com sessão; o handler devolve `denied` sem posse. O
  adaptador CLI recusa pedidos com `tools`.
- **Web**: `useFlowAuthoringEvents` (SSE + replay + polling de recurso);
  `FlowAssistantPanel` com seletor de modo, propostas, operações aplicadas,
  progresso, erros, capacidades em falta e desfazer; `FlowEditor` atualiza o
  canvas e a configuração com os eventos (nós/ligações novos marcados),
  preservando seleção, posições, zoom e alterações manuais por guardar, e
  mostra o conflito sem descartar o trabalho local.

### Migration

[039](../sql/039_flow_authoring_sessions.sql), aditiva e idempotente:

- tabelas `flow_authoring_sessions`, `flow_authoring_operations`,
  `flow_authoring_events` e `flow_capability_requests`;
- colunas `flow_assistant_requests.session_id`, `authoring_mode` e
  `known_revision` (nulas nos pedidos existentes).

### Testes

Locais, com BD real e Copilot simulado (fakes):

- `flow-authoring.test.ts` (10): modo automático incremental com eventos,
  cursor e idempotência, sem ativação; operações inválidas rejeitadas sem
  alterar o rascunho; modo assistido (aceitar); pedidos antigos sem modo;
  conflito com edição manual e releitura; desfazer; cancelamento e perda de
  posse; revogação e isolamento entre projetos; capacidade em falta
  idempotente; modo por turno.
- `copilot-sdk.adapter.test.ts` (+2): ferramentas registadas, permissão
  `custom-tool` aprovada/recusada, handler sem posse → `denied`; o CLI recusa
  `tools`.
- `flow-assistant-runner.test.ts` (3).
- Web `flow-authoring.test.tsx` (4): nós ao vivo, capacidade em falta e
  desfazer com `expectedDraftVersion`; conflito e «Recarregar»; reconexão SSE
  com replay `after`; posições só locais (reorganização do canvas) não
  bloqueiam novos pedidos nem o desfazer (regressão encontrada em QA).

Resultados: `typecheck` OK; lint só com o erro pré-existente `portKey`;
Prettier limpo nos ficheiros alterados; `npm test` 417 passaram e só as 3
falhas de arquitetura do baseline (as 6 lacunas de JSDoc introduzidas foram
corrigidas antes da contagem final; ciclos e allowlist iguais ao baseline).

### Limitações

- As ferramentas de autoria exigem o adaptador SDK; com o CLI o assistente
  continua a funcionar no modo antigo (proposta final).
- O desfazer atua sobre a última operação aplicada do rascunho; desfazer uma
  operação antiga com alterações posteriores é recusado em vez de fundir.
- A reconciliação de conflitos é feita pelo agente (nova leitura) ou pelo
  utilizador (recarregar); não há fusão automática de três vias.
- O simulador completo (P07) e o desenvolvimento de capacidades (P10) ficam
  fora desta entrega.
- Um pedido cancelado fica com `status: failed` e `error_code: cancelled`. A
  UI mostra «Pedido cancelado».
- Um pedido assistido sem operações (por exemplo, só com capacidade em falta)
  fica com `resolution: accepted`, sem efeito no rascunho.

### Publicação e validação em QA (`main`) — 2026-11-14

- Pré-voo:
  - health `ready` em `651b6b0`;
  - 0 `agent_runs`, pedidos do assistente e jobs de encaminhamento em fila
    ou em curso;
  - backup manual `/var/backups/zeroops/pre-p06-20261114-161622.sql.gz`
    (`gzip -t` OK, 83 tabelas).
- Push de `feat/p06-authoring-chat` para `qa` (sem deploy), seguido de
  `qa :main`.
  - A sessão SSH caiu durante o build, mas o hook terminou no servidor:
    `/var/log/zeroops/deploy.log` → «OK: 126a1ad… ativo».
  - A migration `039_flow_authoring_sessions.sql` foi aplicada; as tabelas
    de sessão, operações e eventos e a coluna `session_id` estão presentes.
- **Regressão encontrada em QA e corrigida (`64c1af7`).**
  - Depois da construção automática, o canvas reorganizava as etapas novas
    e o editor ficava com alterações só de posições.
  - O painel tratava isso como rascunho por gravar e bloqueava novos pedidos
    e o desfazer.
  - Correção: o painel só bloqueia perante alterações lógicas.
  - Teste web acrescentado.
  - Republicação com drenagem prévia (0 jobs); o hook confirmou «OK:
    64c1af7… ativo».
- Validação real no browser do QA (`https://tickets.pizzahut.pt`), com o
  Copilot SDK real (não fakes).
  - Fluxo isolado «Teste P06 Construção» `9b35d5b6-…`, no projeto
    `00000000-0000-4000-8000-000000000001`, template em branco.
  - **Construção automática ao vivo:** rev. 1→2→3→4 entre os 22 e os 27 s.
    Os nós no canvas passaram de 2 para 5 durante o turno, com três
    `operation_applied`.
  - **Recarregar após o redeploy:** o SSE caiu (503) durante o deploy e
    voltou a ligar. Foram recuperados a conversa, o progresso, a resposta,
    as alterações aplicadas e o modo; o indicador mostrou «em direto».
  - **Recarregar a meio de um turno:** o turno continuou no servidor até
    `succeeded` (rev. 7).
    - Os eventos 8–14 foram reproduzidos uma única vez, sem duplicados.
    - O canvas mostrou «Plano técnico» e «Aprovação do plano».
    - Uma operação malformada do modelo foi `operation_rejected` com
      «rascunho intacto»; os lotes seguintes foram aplicados.
  - **Capacidade em falta:** o pedido de uma decisão pelo papel «gestor de
    conta», que não existe, gerou `capability_missing`.
    - O pedido foi registado e apresentado no painel e no editor.
    - Não foi aplicada nenhuma operação nem inventado nenhum papel; o
      Copilot fez uma pergunta concreta.
  - **Modo assistido:** proposta com 4 operações pré-visualizada no canvas
    (8 nós, a verde), com o rascunho a manter-se na rev. 7 e os botões
    Aceitar/Descartar.
  - **Edição manual concorrente:** antes de aceitar, gravei por API uma
    alteração à etiqueta «Plano técnico (manual)» (rev. 8).
    - O aceite aplicou as operações tipadas sobre a rev. 8 → rev. 9
      (`source: accept`, base 8).
    - A edição manual foi preservada.
  - **Conflito:** com uma etapa local por gravar, gravei no servidor
    «Aprovação do plano (servidor)» (rev. 10).
    - Apareceu o aviso «O rascunho mudou no servidor (rev. 10…). As suas
      alterações foram mantidas e nada foi sobrescrito.»
    - «Recarregar» adotou a rev. 10, com as duas edições.
  - **Desfazer:**
    - um desfazer sobre uma revisão desatualizada foi recusado: botão
      desativado e API 409 `FLOW_DRAFT_CHANGED`;
    - um turno automático criou o fim «Cancelado» (rev. 11); o «Desfazer»
      na UI criou a rev. 12 com `source: undo` e `undoOf`;
    - a rev. 11 continua no histórico, marcada como «desfeita».
  - **Progresso incremental:** «Verificação 1…5» foram aplicadas em 5 lotes
    (rev. 13–17, cerca de 2–4 s entre eventos).
  - **Cancelamento:** «Cancelar» na UI durante o turno → `turn_cancelled`.
    Não houve operações nos 30 s seguintes (rascunho mantido na rev. 17).
  - **Sem ativação implícita:** no fim, `active` null e 0 versões; a
    ativação continua a ser uma ação explícita.
- Estado final:
  - health `ready` em `64c1af7`;
  - 0 runs, pedidos do assistente e jobs de encaminhamento ativos;
  - o fluxo real «Geral» está inalterado (rev. 2, última alteração a
    2026-11-11);
  - o fluxo de teste continua como rascunho nunca ativado, pelo que não
    participa no encaminhamento;
  - nada foi escrito em produção.

## P07 — Simulador partilhado com runtime

Branch `feat/p07-shared-simulator`, criada a partir de `75a225b` (P06).
Guia de publicação: [qa-p07.md](qa-p07.md).

### Ponto de partida confirmado

- `simulateFlow` (contratos) era uma segunda implementação das transições:
  percorria o grafo com resultados `success`/`failure` por etapa, sem
  relógio, sem retries com tempo, sem encaminhamento e sem distinguir
  capacidades indisponíveis. `FlowsService.simulate` devolvia esse resultado
  e `FlowSimulator.tsx` era um formulário de resultados por etapa.
- O runtime (`FlowEngine`) decidia as transições internamente (portas,
  condições, limites de passagens, timeouts) e as ações (`flow-actions.ts`)
  escreviam diretamente no ticket, nas notificações, no Health e no deploy.
- P05 já tinha o prompt e a validação estruturada do classificador; P03 os
  jobs com lease/época; P02 os hashes de ativação (`logicHash`, encaminhamento
  normalizado e manifesto); P06 o editor/canvas com marcas.

### Alterações

- **Núcleo de transições partilhado** (`contracts/flow-transitions.ts`,
  `resolveFlowTransition`): porta → ligação, condições, limites de passagens,
  esperas e timeouts. O `FlowEngine` e o simulador chamam a mesma função;
  `simulateFlow` passou para este módulo como invólucro sobre ela
  (compatibilidade com `POST …/simulate`).
- **Efeitos injetáveis** nas ações (`FlowActionEffects`): mensagens ao
  cliente, notas internas, remediações Health, verificação de recuperação e
  deploy recebem adaptadores. O runtime usa os reais; o simulador usa
  adaptadores que só registam o efeito (`simulated`) ou o entregam num
  destino de ensaio (`trial`). O prompt do classificador foi extraído para
  `routing-prompt.ts` e é partilhado com P05.
- **Simulador** (`flow-simulator.ts`, `runFlowBehaviour`): relógio
  controlado (minutos simulados, `afterMinutes`, horizonte), resultados de
  ferramentas/agentes, respostas a perguntas e decisões humanas vindos do
  cenário. Ações sem adaptador portável e sem fixture ficam `unavailable`;
  sem executor no runtime ficam `unavailable` mesmo com fixture. Nunca há
  sucesso fictício.
- **Quatro níveis**, identificados em cada execução:
  1. `structural` — validação de P02 (grafo, contratos, condições,
     referências, responsáveis, dependências/manifesto);
  2. `behavior` — simulação com fixtures, sem efeitos externos;
  3. `routing_copilot` — encaminhamento P05 com o Copilot real, em job
     (`flow_simulation`, lease/época/cancelamento/recuperação de P03); o
     resultado observado é guardado e comparado com a expectativa, sem
     pressupor respostas iguais em novas chamadas;
  4. `isolated_trial` — executa as capacidades portáveis contra um destino
     de ensaio (`outbox`) do próprio projeto, ativo e escolhido
     explicitamente. Copilot e ações não portáveis ficam indisponíveis; não
     há execução real seguida de reversão.
- **Encaminhamento simulado**: candidatos e fallback de P05 com chaves
  `C1..Cn`/`F`; respostas gravadas reutilizáveis para equivalência
  determinística; identificadores inventados → `invalid`.
- **Biblioteca de cenários por projeto/fluxo**
  (`flow_simulation_scenarios`, versão e hash), com criação a partir de um
  snapshot só de leitura de um ticket histórico do mesmo projeto, e 8
  exemplos (sucesso, ambiguidade, falta de informação, rejeição, falha de
  ferramenta, timeout, retry limitado, capacidade indisponível).
- **Execuções** (`flow_simulation_runs`): hashes exatos da definição,
  encaminhamento, manifesto e cenário; definição e candidatos fixados no
  pedido; idempotência por `(flow_id, idempotency_key)`; comparação
  esperado/observado. Uma execução cujos hashes diferem dos atuais fica
  `stale`, com os motivos (`definition`, `routing`, `manifest`, `scenario`).
  A simulação corre sempre sobre o rascunho **gravado**.
- **Ativação**: `activation_details.tests` guarda as execuções (não
  desatualizadas) para os hashes exatos da versão ativada; o diálogo de
  ativação mostra «Testes para esta versão» e avisa que resultados de outras
  versões não a certificam. A política existente mantém-se: a validação
  estrutural é obrigatória; ensaios continuam informativos.
- **Permissões**: `flows.simulate` para simular e gerir cenários;
  `flows.activate` para gerir destinos de ensaio; projeto validado em todas
  as rotas.
- **API**: `GET …/:flowId/simulations`, cenários (`POST …/scenarios`,
  `…/from-ticket`, `…/:scenarioId`, `…/archive`), execuções (`POST …/runs`,
  `GET …/runs/:runId`, `POST …/runs/:runId/cancel`), destinos de ensaio
  (`POST trial-targets`, `…/deactivate`, `GET …/deliveries`) e
  `GET simulation-tickets`. `POST …/simulate` mantém-se.
- **Executor**: uma instância própria do `FlowAssistantRunner` sobre a
  `FlowSimulationQueue` processa as avaliações Copilot (heartbeat, fencing e
  recuperação de leases expiradas no arranque e no ciclo de manutenção).
- **Web**: `FlowSimulator.tsx` reescrito (nível, cenário/exemplo, editor de
  cenário, execuções com veredicto e «desatualizado», detalhe com etapas,
  efeitos, indisponíveis, esperas e verificações não realizadas, polling das
  execuções em curso); o percurso é desenhado no canvas do `FlowEditor`.

### Migration

[040](../sql/040_flow_simulations.sql), aditiva e idempotente: tabelas
`flow_simulation_scenarios`, `flow_simulation_runs`, `flow_trial_targets` e
`flow_trial_deliveries`; `agent_job_events.job_kind` aceita
`flow_simulation`. A coluna de ligação das entregas chama-se
`simulation_run_id` porque o purge de tickets trata qualquer `run_id` como
dependência de tickets (detetado pela suite completa).

### Testes

Determinísticos, com BD real e Copilot simulado (fakes):

- `flow-simulation.test.ts` (9): equivalência das transições runtime ↔
  simulador no fluxo «Geral» com resultados idênticos (pares etapa/porta
  iguais e sem efeitos operacionais); simulação vs. ensaio isolado (destino
  ausente, de outro projeto ou desativado recusado; sem `flows.activate`
  recusado; repetição idempotente sem duplicar entregas); relógio controlado
  (recuperação, timeout, horizonte, limite de passagens); comparação e
  desatualização (cenário alterado → 409, motivos `scenario`/`definition`,
  evidência de ativação só da execução atual); isolamento e ticket histórico
  inalterado; capacidades indisponíveis; encaminhamento (gravado, inventado,
  pendente, Copilot em fila com recuperação, `stale`/`duplicate`, falha,
  cancelamento com perda de posse, `COPILOT_NOT_READY`); compatibilidade com
  `simulateFlow` e exemplos; paridade com o encaminhador real (o fallback
  `F` só é alcançável por `decision: none`, nunca escolhido pelo modelo —
  divergência encontrada na revisão do diff e corrigida).
- `flow-definition.test.ts` ajustado ao invólucro de `simulateFlow`.
- Web `flow-simulator.test.tsx` (2): execução com chave idempotente,
  percurso no canvas, comparação e «desatualizado»; rascunho por gravar
  bloqueia a execução; evidência de ativação separa versões.

Resultados: `typecheck` OK; lint só com o erro pré-existente `portKey`;
Prettier limpo nos ficheiros alterados; suite web 129/129; suite raiz com
as 3 falhas de arquitetura do baseline (allowlist, JSDoc e ciclos com as
mesmas entradas, nenhuma de P07). A primeira execução completa revelou 8
falhas em `project-ticket-purge.test.ts` (coluna `run_id`), corrigidas e
revalidadas (purge + P07: 18/18).

### Limitações

- O ensaio isolado só suporta destinos `outbox`; as ações não portáveis
  (por exemplo `incident_intake`) e o Copilot ficam indisponíveis nesse
  nível até existirem adaptadores de teste (P08/P09).
- A simulação de comportamento não executa agentes; os resultados vêm do
  cenário. A avaliação Copilot real cobre o encaminhamento.
- Os resultados da avaliação Copilot real podem variar entre chamadas; a
  equivalência determinística usa respostas gravadas.

### Publicação e validação em QA (`main`)

- Pré-voo: QA em `64c1af7` (P06); jobs drenados (`agent_runs`,
  `flow_assistant_requests`, `ticket_routing_jobs` a 0); backup
  `/var/backups/zeroops/pre-p07-20261114-190740.sql.gz` (`gzip -t` OK, 87
  tabelas).
- `git push qa feat/p07-shared-simulator` (sem deploy) e
  `git push qa feat/p07-shared-simulator:main`: o hook aplicou a migration
  040 (4 tabelas, `simulation_run_id`), recriou `api`/`executor`/`worker` e
  confirmou «OK: fa39763… ativo». Health público
  `{"status":"ready","version":"fa39763…"}`.
- Validação funcional sobre a versão publicada, com os serviços compilados
  dentro do contentor `zeroops-api-1` (script por stdin) e o executor real,
  no projeto de teste isolado e no fluxo de rascunho «Teste P07 Simulação»
  (`865e8674…`, nunca ativado; política semântica de consulta, prioridade
  171):
  - **Validação estrutural:** `completed`, sem problemas, hash
    `21ee63363eee`.
  - **Simulação com fixtures:** cenário guardado → percurso
    `analise → aviso → nota → fim`, veredicto `passed`; expectativa errada
    (falha da análise) → percurso `analise:failure → escala`, veredicto
    `failed`. Os 5 exemplos incorporados correram (sucesso; ambiguidade com
    resposta gravada → `clarify` com pergunta, `passed`; falta de
    informação → `waiting` em `analise`, `passed`; falha de ferramenta →
    `escala`; capacidade indisponível → `unavailable: analise`, sem
    efeitos). Efeitos sempre `simulated`.
  - **Ticket histórico:** cenário a partir de `a94e16cd…` (encaminhamento
    por regras → «Incidente (Health)»), ticket inalterado.
  - **Avaliação Copilot real** (executor, `scope: simulation`, eventos
    `flow_assistant.succeeded`): «Qual é o estado do pagamento da encomenda
    X?» → `this` (consulta); «Precisamos de adicionar outro método de
    pagamento» → `fallback` («Geral»), ambos `source: copilot` e `passed`.
    Um terceiro pedido cancelado ficou `cancelled`.
  - **Ensaio isolado:** sem destino → `TRIAL_TARGET_NOT_ALLOWED`; com a
    análise Copilot no início → `unavailable` (sem sucesso fictício); com o
    rascunho temporariamente a começar em `aviso` → `aviso → nota → fim`,
    efeitos `trial` e 2 entregas na caixa de ensaio; repetição com a mesma
    chave devolveu a mesma execução. O rascunho foi reposto.
  - **Desatualização:** depois de editar o rascunho, as 15 execuções
    anteriores ficaram `stale` (motivos `definition`/`manifest`).
  - **Sem efeitos operacionais:** contagens de tickets, comentários,
    `agent_runs`, execuções/etapas de fluxos, outbox, notificações Health,
    incidentes, intervenções e deployments iguais antes e depois; nenhuma
    ativação dos fluxos de teste; fluxo real «Geral» inalterado (rev. 2).
- Estado final: 0 jobs ativos, contentores sem reinícios desde o deploy.
- Artefactos de teste: além do fluxo acima ficou um rascunho vazio «Teste
  P07 Simulação QA» (`89aa5af7…`, de uma tentativa interrompida do script),
  também no projeto de teste e nunca ativado.

**Não executado:** a validação visual no browser do QA (criação de
cenários, percurso no diagrama, comparações e «desatualizado» na UI). A
sessão web expirou (401) e o utilizador não estava disponível para iniciar
sessão; não se contornou a autenticação. Falta executar os passos 1–8 de
`docs/qa-p07.md` com sessão iniciada. A interface está coberta apenas pelos
testes web automatizados.

## P08 — Workspace Git, desenvolvimento e review dinâmico

Branch `feat/p08-git-workspace-review`, criada a partir de `1c00e05` (P07).
Guia de publicação: [qa-p08.md](qa-p08.md).

### Ponto de partida confirmado

- O desenvolvimento existente (`implementation`/`CandidateService`) gerava
  um candidato SVN a partir de um workspace temporário (tmpfs) sem branch,
  sem commit base fixo e sem PR; o diff vinha dos ficheiros enumerados pelo
  modelo. O `WorkflowService` (rotas legadas `transition`/`decide`) podia
  mover tickets sem passar pelas etapas do fluxo.
- Os runs do Copilot já tinham lease/época (P03), agentes/skills e política
  efetiva (P04) e o motor de fluxos guardava etapas e decisões (P02).
- As decisões humanas de uma etapa eram do responsável ou de qualquer
  administrador; não havia ligação entre a decisão e o artefacto revisto.

### Alterações

- **Repositórios Git por projeto** (`GitRepositoriesService`, página
  «Repositórios»): URL sem credenciais (`https:` ou `file:`) dentro das
  raízes autorizadas (`ZEROOPS_DEV_ALLOWED_REPO_ROOTS`), branch base,
  referências autorizadas, comandos de preparação/teste e fornecedor de PR
  (`zeroops` interno ou `github`). A credencial é só de escrita, cifrada com
  o `IdentityCipher` e nunca devolvida. «Verificar» faz `ls-remote` e fixa o
  SHA base observado. Gerir exige a nova permissão delegável
  `repositories.manage`; consultar basta `flows.view`.
- **Etapas de desenvolvimento**: uma etapa `copilot_task` com
  `config.development` (repositório, modo de publicação `none`/`branch`/
  `pull_request`) cria um workspace persistente por ticket/etapa/
  repositório com branch própria `zeroops/<chave-do-ticket>-<workspace>`. Investigação
  simples (sem `development`) continua sem workspace, branch ou PR.
- **`WorkspaceManager`/`DevelopmentRunner`** (executor): bare
  `<raiz>/<projeto>/<workspace>/repo.git` + worktree por tentativa
  (`attempts/<run>-<época>`). A primeira tentativa fixa o commit base; as
  seguintes partem do head anterior (correções preservam o trabalho). Cada
  passo verifica a posse (run + época do lease, `DevelopmentStale`): uma
  tentativa antiga não prepara, não grava revisão nem liberta o workspace
  da nova. O diff (A/M/D/R) é calculado pelo Git entre base e head, nunca a
  partir da lista do modelo.
- **Testes reais**: a ferramenta `zeroops_run_tests` (SDK) e a fase final
  executam só os comandos configurados no repositório; cada execução guarda
  comando, exit code, timeout, log (redigido) e o SHA/árvore testados. Uma
  sugestão de testes do modelo não conta. Testes finais falhados registam a
  revisão sem manifesto nem publicação e a etapa sai por `failure`.
- **Manifesto Git/SVN** (`candidate-manifest.ts`): o formato legado
  (`svnRevision`) mantém significado e hash; o novo `vcs.kind = git` regista
  repositório, branch, base, head, hash do diff, ficheiros/removidos, testes
  com `testedSha` e migrations. `candidateProvenance` normaliza ambos.
- **Publicação idempotente**: push sem force da branch de trabalho (nunca da
  branch protegida); consulta o remoto antes e depois (reconciliação de
  resultado incerto → `uncertain` e nova tentativa só após confirmar o
  estado); remoto divergente → `conflict`. PR `zeroops` (número sequencial
  por projeto) ou GitHub (procura PR aberto da branch antes de criar). A
  chave `<workspace>:<tipo>` garante um único registo por publicação, com
  contagem de tentativas. Sem merge nem deploy (P09).
- **Review dinâmico** (`config.review` numa `human_decision` com
  `sourceNode`): revisores por utilizadores e/ou papéis, regra `any`/`all`/
  `quorum`, separação de funções (o autor do ticket não revê) e override de
  administrador só quando a etapa o permite (registado como
  `override_used`). Pertenças e permissões verificadas no momento da
  decisão. Cada decisão fica ligada ao head e ao hash de âmbito exatos;
  aprovar exige testes a passar no head; decisões repetidas são recusadas.
  Um novo head invalida as decisões anteriores (`head_changed`, sem apagar).
  Rejeição volta ao desenvolvimento com o feedback no prompt, no mesmo
  workspace e PR. Uma mensagem no chat ou parecer de agente não decide.
- **Rotas legadas**: com execução de fluxo ativa, `transition`/`decide` do
  `WorkflowService` são recusadas com `FLOW_MANAGED` (409); o fluxo controla
  desenvolvimento e review.
- **API**: `GET/POST /api/projects/:projectId/git-repositories`,
  `POST …/:id`, `…/:id/archive`, `…/:id/verify`;
  `GET /api/tickets/:ticketId/development` (vista técnica interna, nunca
  devolvida a clientes). As decisões de review usam a rota de decisão das
  etapas com `artifactSha`.
- **Web**: página «Repositórios»; configuração de desenvolvimento/review no
  painel da etapa; painel «Desenvolvimento» no ticket (workspace e job,
  base/head, diff completo, testes com SHA, PR, revisores, decisões e
  invalidações) e confirmação do SHA na decisão. A ausência de pipeline P09
  aparece como capacidade indisponível.
- **Validação de fluxos**: uma `human_decision` com `config.review` não
  exige responsável (decidem os revisores configurados); nomes de
  repositório aceitam letras acentuadas.
- **Docker**: `git` na imagem; volume `dev-workspaces` no executor;
  repositórios de teste em `/opt/zeroops/test-repos` (leitura na API).

### Decisões

- Workspace = bare por workspace + worktree por tentativa: isola tickets
  (mesmo ficheiro em branches distintas) e tentativas (época no caminho),
  preservando o histórico para correções.
- A posse do workspace segue o lease do run (P03), não um lock próprio;
  `releaseWorkspace` só atua se o dono e a época coincidirem.
- O provider `zeroops` é o PR interno de referência para QA sem GitHub;
  o provider GitHub só foi exercitado com `fetch` simulado.
- O admin não ultrapassa revisores configurados: só com `adminOverride`
  explícito na etapa.

### Migration

[041](../sql/041_development_workspaces.sql), aditiva e idempotente:
`project_git_repositories`, `development_workspaces`,
`development_revisions`, `development_test_runs`,
`development_publications`, `development_review_decisions` e
`agent_runs.development_workspace_id`. Sem FK para `agent_runs`/etapas
(ordem da purga); o purge de tickets e `sql/manual/purge_project_tickets.sql`
incluem as tabelas novas.

### Testes

- `apps/executor/src/development.e2e.test.ts` (6, BD real, Git real com
  repositório bare local; Copilot substituído pela edição direta do
  checkout — fake): dois tickets alteram o mesmo ficheiro sem sobrescrita;
  base fixa apesar de novos commits na `main`; diff A/M/D; testes finais
  reais com `tested_sha`; PR 1 e 2 sem duplicação; só revisores
  configurados decidem (admin sem override recusado); SHA antigo/ausente →
  `REVIEW_ARTIFACT_CHANGED`; rotas legadas → `FLOW_MANAGED`; rejeição →
  correção no mesmo workspace (`parent = head anterior`, mesmo PR) →
  decisão anterior `head_changed` → aprovação conclui; cliente sem acesso à
  vista técnica. Publicação repetida (mesmo número, `attempts = 2`),
  origem indisponível → `uncertain` → reconciliação → `published`, force
  push alheio → `conflict`. Tentativa antiga sem posse (prepare/finalize
  recusados, release sem efeito). Testes falhados sem publicação. Quórum 2
  com papéis, separação de funções, decisão repetida e override do admin.
  Isolamento entre projetos, origens fora das raízes, sem
  `repositories.manage`, repositório de outro projeto num fluxo e
  investigação sem workspace.
- `development-units.test.ts` (5): `parseNameStatus` (A/M/D/R/C) e provider
  GitHub com `fetch` simulado (reutiliza PR aberto, cria, rede/5xx →
  incerto, 4xx → definitivo, host/credencial recusados sem chamada).
- `candidate-manifest.test.ts` (3): legado SVN inalterado, Git com SHA
  testado, rejeição de testes falhados/sem SHA/mistura de formatos.
- `copilot-sdk.adapter.test.ts`: escrita em `.git` negada em implementação.
- `apps/web/tests/ticket-development.test.tsx` (2): painel técnico com
  base/head, ficheiros A/M/D, testes com SHA, PR, revisores, decisão
  invalidada e P09 indisponível; ticket sem workspace não mostra o painel.

#### Checks

- `typecheck`: OK.
- `lint`: só o erro pré-existente `portKey` em `StepConfigPanel.tsx`
  (já presente antes de P08).
- Prettier: limpo nos ficheiros alterados.
- Suite raiz: tudo a passar exceto as 3 falhas de arquitetura do baseline;
  P08 acrescenta `development` à allowlist e não introduz entradas novas.
- Suite web: 131/131 (falhas esporádicas por timeout de ~5 s em
  `project-permissions`/`conversation` passam isoladamente — instabilidade
  de tempo pré-existente).
- e2e P08: 6/6 (BD e Git reais; Copilot fake).

### Limitações

- `zeroops_run_tests` só existe com o transporte SDK (o CLI não aceita
  ferramentas); com CLI só contam os testes finais.
- O provider GitHub não foi exercitado contra o GitHub real (proibido nos
  ensaios); o QA usa o PR interno `zeroops`.
- Ficheiros gerados por testes da fase do agente e não ignorados pelo
  `.gitignore` do repositório entram no commit (ficam visíveis no diff).
- A limpeza por retenção só marca workspaces sem runs em fila/execução e
  depois remove o checkout. Um run criado exatamente entre a marcação e a
  remoção pode perder o checkout e falhar; a tentativa seguinte volta a
  reclamá-lo. Os artefactos (diff, testes, revisões) estão na BD.
- Merge, integração e deploy dos projetos-alvo pertencem a P09.

### Publicação e validação em QA (`main`)

- Pré-deploy: QA em `fa39763`; jobs drenados (`agent_runs`,
  `flow_assistant_requests`, `ticket_routing_jobs`, `flow_simulation_runs`
  = 0); backup `/var/backups/zeroops/pre-p08-20261114205514.sql.gz`
  (`gzip -t` OK, 89 tabelas).
- Sandbox Git no host: `/opt/zeroops/test-repos/p08-sandbox.git` (seed
  `7c5ab73`; `app.js` com `soma`, `test.js`), montado só de leitura na API
  em `/srv/zeroops-git`. O host tem Git 2.25 (sem `init -b`); usado
  `symbolic-ref HEAD refs/heads/main`. O executor usa Git 2.39.5.
- Deploy por `git push qa feat/p08-git-workspace-review:main` (o push da
  branch não publica): `9907c24` ativo, migration 041 aplicada.
- Regressão encontrada em QA: `repos.verify` na API (uid 1000; repositório
  de root) falhava com «dubious ownership». `d162d5e` (`safe.directory` de
  sistema no Dockerfile) não teve efeito porque `runGit` usa
  `GIT_CONFIG_NOSYSTEM=1`, e o transporte local descarta `-c`. Correção
  `8a41c09`: `GIT_CONFIG_GLOBAL` aponta para um ficheiro próprio (modo 600)
  com `safe.directory = *`; Dockerfile revertido; teste unitário
  acrescentado. Publicado; health `ready` em `8a41c09`; `verify` devolve
  `verifiedBaseSha` `7c5ab73`.
- Ensaio com Copilot real (SDK) no projeto `…0001`, recursos isolados:
  revisor de teste `p08-revisor@zeroops.invalid` (role qa, sem
  palavra-passe utilizável), repositório «Sandbox P08», fluxo «Teste P08
  Desenvolvimento» (prioridade 108; dev `pull_request` → review
  `userIds`/`any` → fim; rejeição volta ao dev). URL fora das raízes →
  `INVALID_INPUT`.
- ZO-25 (`multiplica`): run com head `7768577`, diff M `app.js`/`test.js`,
  teste final `node test.js` exit 0 nesse SHA, branch e PR interno #1.
  Decisão do admin → `FORBIDDEN`; SHA errado/ausente →
  `REVIEW_ARTIFACT_CHANGED`; `workflow.transition`/`workflow.decide`
  legados → `FLOW_MANAGED`. Revisor rejeitou (pedido `subtrai`); correção no
  mesmo workspace (`startSha` = `7768577`, novo head `9f285dc`), PR #1
  atualizado; decisão anterior invalidada (`head_changed`); SHA antigo →
  `REVIEW_ARTIFACT_CHANGED`. Revisor aprovou `9f285dc`; fluxo `completed`;
  P09 apresentada como indisponível.
- ZO-26 (`divide`, mesmo ficheiro): workspace próprio, base `7c5ab73`, head
  `88ace17`, teste final exit 0 nesse SHA, branch `zeroops/zo-26-0301583b`
  e PR #2. A branch do ZO-25 mantém `multiplica`/`subtrai` e a do ZO-26 só
  `divide`; `main` do sandbox continua em `7c5ab73`. ZO-26 ficou em review
  (não decidido).
- Tickets de investigação existentes não criaram workspaces (apenas 2
  workspaces, ambos de desenvolvimento).
- Commits da entrega P08 (repositório ZeroOps): `3782384`, `2c0e9da`,
  `9907c24`, `d162d5e`, `8a41c09` e o commit desta documentação. Commits de
  tickets de teste (só no sandbox): `7768577`, `9f285dc` (PR #1) e
  `88ace17` (PR #2).
- Limpeza: fluxo de teste retirado (regra só para `development`, nome
  «— retirado», republicado); repositório sandbox e revisor de teste
  mantidos para ensaios futuros; 0 runs ativos.
- Não validado no browser: não existe sessão autenticada disponível e a
  autenticação não foi contornada. O painel do ticket está coberto por
  `apps/web/tests/ticket-development.test.tsx` e pelo e2e; a validação em
  QA foi feita pelos serviços no contentor e pelo executor real.
- Vista do cliente: o projeto de QA não tem cliente associado; coberta só
  pelo e2e.

## P09 — Pipeline, integração e Health pelo fluxo

Branch `feat/p09-pipeline-integration-health`, criada a partir de `b151103`
(P08). Guia de publicação e ensaio: [qa-p09.md](qa-p09.md).

### Ponto de partida confirmado

- P08 deixava o candidato Git revisto (head/base/âmbito, testes com SHA,
  PR) e apresentava a pipeline como indisponível; não havia merge,
  integração nem deploy dos projetos-alvo.
- O Health (P02/P03) já tinha ações de fluxo, políticas, suspensão e relay
  de produção, mas um timeout do relay era tratado como falha (permitindo
  nova tentativa de restart), não havia locks pelo recurso real e a
  ausência de telemetria podia contar como recuperação.
- As rotas legadas de proposta/aprovação/transição já eram recusadas com
  `FLOW_MANAGED` nos tickets com fluxo ativo (P08); P09 não reabre esses
  caminhos.

### Alterações

- **Pipelines por projeto** (`PipelinesService`, página «Pipelines»):
  fornecedor `webhook` com contrato próprio (não pressupõe GitHub
  Actions), endpoint limitado a `ZEROOPS_PIPELINE_ALLOWED_ORIGINS` e
  verificado antes de cada pedido, repositório e branch de destino,
  ambiente, integração na branch só com `allowIntegration` explícito e
  segredo HMAC cifrado (nunca devolvido). Gerir exige
  `repositories.manage`; consultar basta `flows.view`.
- **Ação de fluxo `deliver`** (`flow-deliver-action.ts`, configuração
  `pipelineId` + `reviewNode` no painel da etapa): cria uma entrega por
  etapa ligada ao candidato revisto. Portas: publicado → `success`;
  `blocked`, `conflict`, `rework`, `failed`, `uncertain`, `cancelled` →
  `failure`, com feedback para a etapa seguinte (ex.: conflito volta ao
  desenvolvimento).
- **Gates antes da entrega** (revalidados pelo executor imediatamente antes
  de integrar e de publicar): aprovações válidas e suficientes
  (`any` = 1, `all` = todos os revisores elegíveis, `quorum`), aprovações
  ligadas ao head atual (alteração material → `blocked`), permissões e
  pertenças atuais, posse da tentativa (lease/época) e estado do
  ticket/execução. Testes isolados continuam possíveis antes do review; a
  continuação automática definida no fluxo não pede confirmações extra.
- **Integração coordenada** (`DeliveryRunner`, executor): fila FIFO durável
  por repositório/branch de destino e locks em `resource_locks`
  (integração por repo/branch, ambiente por pipeline/ambiente). Se a branch
  de destino avançou desde a base do candidato, o candidato é combinado
  com o topo atual e a combinação volta a ser testada antes de integrar;
  conflito → `conflict` (volta ao desenvolvimento). Push só fast-forward,
  sem force e sem contornar proteções. Com QA partilhado, o lock do
  ambiente mantém o candidato fixo durante a validação.
- **Publicação e reconciliação**: transação curta para intenção/estado; o
  I/O externo corre fora dos locks de negócio. O pedido ao fornecedor leva
  `idempotencyKey`, SHA integrado e digest do artefacto (`sha256:` da
  árvore integrada); «aceite» (2xx/409) significa só `publishing`. Timeout
  ou erro após envio → consulta `GET /deliveries/:key` antes de qualquer
  repetição; sem resposta conclusiva → `uncertain` (registado, nunca
  repetido às cegas). Cancelamento via `POST …/cancel` quando suportado.
- **Callbacks** `POST /api/pipelines/:pipelineId/callbacks`: assinatura
  HMAC-SHA256 de `timestamp.corpo` com tolerância de 300 s, correlação por
  `idempotencyKey`/SHA/digest, evento único por pipeline (duplicados ficam
  registados sem efeito), `sequence` monotónica (mensagens fora de ordem
  não regridem estados) e estados terminais imutáveis. Rate limit próprio.
- **Health pelo fluxo**: locks pelo recurso real (host/serviço, partilhados
  entre projetos) sem remediações concorrentes; contrato versionado das
  ações (`contract_version`); revalidação de autorização e suspensão antes
  de intervir; resultado do relay desconhecido → `uncertain` e
  reconciliação (`incident-reconcile.ts`), nunca novo restart só por
  timeout; recuperação confirmada só com sondas/métricas recentes dentro da
  janela de observação; sem telemetria → `unknown` (encaminhado pela porta
  de falha, não como saudável); retoma após reinício/perda de posse.
- **Relay 1.2.0** (`deploy/production-relay`): journal idempotente por
  `interventionId` (repetição devolve o resultado original sem nova
  execução; resultado contraditório → 409), `StateDirectory` por instância
  no `install.sh`. Não foi instalado nem alterado em produção.
- **Web**: página «Pipelines»; configuração da etapa `deliver`; painel
  «Desenvolvimento» com entregas (candidato, gates pendentes, posição na
  fila, pipeline e checks, SHA integrado/digest, falhas e reconciliações);
  estados `uncertain`/`unknown` nas intervenções Health. A informação
  técnica continua fora da vista do cliente.
- **Responsáveis do ticket** (nota do utilizador): nos tickets geridos por
  fluxo, o painel «Responsáveis» mostra só os papéis usados nos `assignee`
  das etapas do fluxo; as quatro etapas fixas («cada etapa exige uma pessoa
  diferente») só aparecem nos tickets legados.
- **Fornecedor de pipeline falso** `deploy/qa/p09-fake-pipeline.mjs` para
  ensaios em QA (contrato completo, callbacks assinadas, duplicados e fora
  de ordem, modos `drop`/`fail`).

### Decisões

- Contrato de pipeline genérico por webhook assinado; integrações de
  fornecedores concretos ficam como adapters futuros sobre o mesmo
  contrato.
- Execução externa não é «exatamente uma vez»: idempotência por chave no
  fornecedor + reconciliação antes de repetir; o que não se consegue
  confirmar fica `uncertain` com procedimento manual.
- Revalidar a combinação (merge com o topo atual e testes) em vez de
  rebase: preserva os SHAs revistos; uma alteração material de conteúdo
  invalida aprovações pela regra de P08.
- Encoding/«função su…»: o texto «Falta tamb??m a fun????o su…» era o
  comentário de rejeição do ensaio P08 em QA («Falta também a função
  subtrai…»), corrompido porque os scripts de QA de P07/P08 foram enviados
  por pipe do PowerShell para o `ssh`, que converte não-ASCII em `?`. Não é
  uma funcionalidade em falta. Os dados de teste afetados foram reparados
  em QA (ver «Publicação e validação em QA») e os scripts passaram a ser
  enviados em base64.

### Migration

[042](../sql/042_delivery_pipelines_health.sql), aditiva e idempotente:
`project_pipelines`, `delivery_runs`, `delivery_events`, `resource_locks`;
`incident_interventions.resource_key`, `contract_version` e estado
`uncertain`. O purge de tickets e `sql/manual/purge_project_tickets.sql`
incluem `delivery_events`/`delivery_runs`.

[043](../sql/043_delivery_events_per_delivery.sql) (correção detetada em
QA, aditiva e idempotente): a chave única de `delivery_events` passa de
`(pipeline_id, event_id)` para `(delivery_id, event_id)`. Um fornecedor que
reutilize identificadores entre entregas (contador reiniciado) fazia o
evento final de uma entrega nova passar por duplicado de uma antiga e a
reconciliação nunca concluía.

### Testes

- `apps/executor/src/delivery.e2e.test.ts` (3, BD e Git reais, fornecedor
  HTTP local simulado): pipeline bloqueada sem review e após alteração
  material; A integrado antes de B e B revalidado sobre a nova base; locks
  a impedir publicações concorrentes; callbacks duplicadas/fora de ordem;
  publicação do SHA/digest validados; tentativa antiga sem posse não
  publica; timeout reconciliado sem segundo `POST`; rotas legadas →
  `FLOW_MANAGED`; fornecedor que reutiliza o `eventId` de outra entrega
  (falhava antes da 043).
- `pipeline-signature.test.ts` (3): assinatura válida, alterada e fora da
  janela.
- `incident-flow.test.ts` (+4 P09): alertas correlacionados sem
  remediações concorrentes, timeout do relay → `uncertain` e reconciliação
  sem repetição, recuperação confirmada vs. falha encaminhada, telemetria
  ausente → `unknown`.
- `production-relay.test.ts`: `complete` repetido → `duplicate`; resultado
  contraditório → 409. Purge com as tabelas novas.
- Web: `ticket-development.test.tsx` (entregas no painel, configuração da
  etapa `deliver`, teste do diff estabilizado — o seletor apanhava o log
  dos testes), `conversation.test.tsx` (Responsáveis por fluxo).

#### Checks

- `typecheck` e `build`: OK.
- `lint`: só o erro pré-existente `portKey`.
- Prettier: limpo nos ficheiros alterados/novos (30 ficheiros antigos com
  avisos, nenhum de P09).
- Suite raiz: 452 a passar; só as 3 falhas de arquitetura do baseline
  (lista de violações idêntica).
- Suite web: 134/134 (`integrations.test.tsx` falhou uma vez sob carga e
  passa isolado — instabilidade pré-existente).
- `php -l` do relay: OK.

### Limitações

- Não existe fornecedor real de pipeline configurado para os projetos do
  cliente; o adapter foi validado contra o fornecedor falso (local e QA).
- O relay 1.2.0 não está instalado em QA nem foi atualizado em produção; o
  Health P09 foi validado por testes automatizados (relay simulado). Não
  existe em QA um alvo Health descartável, e não foram interrompidos o
  MySQL nem outros serviços partilhados para simular incidentes.
- Resultados `uncertain` exigem reconciliação manual quando o fornecedor
  não responde à consulta.

### Publicação e validação em QA (`main`)

Commits da entrega (branch `feat/p09-pipeline-integration-health`):
`11d2dc3` [FEAT] backend/executor/API/contratos/SQL, `42cf048` [FEAT] UI,
`dbd2c6b` [FEAT] relay e fornecedor falso, `a4d8aec` [TEST], `5adb506`
[DOC], `1a176e8` [FIX] deduplicação por entrega (043) e o [DOC] final.
Push para o remoto `qa`: a branch com o próprio nome não publica; a
publicação foi feita explicitamente com `git push qa <branch>:main`.

Pré-deploy: QA em `8a41c09`, 0 jobs ativos; backup
`/var/backups/zeroops/pre-p09-20261114233301.sql.gz` (`gzip -t` OK, 95
tabelas); `ZEROOPS_PIPELINE_ALLOWED_ORIGINS=http://127.0.0.1:8787` em
`/etc/zeroops/zeroops.env`.

Deploys: `5adb506` (042 aplicada) e, depois da correção, `1a176e8` (043
aplicada; índice `delivery_events_delivery_event` confirmado). `/api/health`
→ `ready`, versão `1a176e8…`. O hook faz backup, migrations, build, health
e rollback automático em falha.

Recursos de teste: fornecedor falso `deploy/qa/p09-fake-pipeline.mjs` num
contentor descartável (`zeroops-p09-fake-ci`, rede do host, segredo gerado
no servidor em `/root/.zeroops/p09-fake-ci.env`, 0600); pipeline «Fake CI
QA P09»; fluxo «Teste P09 Entrega» (dev PR → review do revisor P08, regra
`any` → `deliver` → fim; falha de entrega volta ao dev); repositório
«Sandbox P08». Desenvolvimento por Copilot real (3 runs `succeeded`).

Ensaios:

- Configuração: endpoint fora da allowlist → `PIPELINE_NOT_ALLOWED`; o
  revisor a criar uma pipeline → `FORBIDDEN`; o segredo não aparece na vista.
- Gate de review: antes da aprovação, 0 `delivery_runs`.
  `workflow.transition`/`decide` legados → `FLOW_MANAGED`; o admin a aprovar
  fora dos revisores configurados → `FORBIDDEN`.
- A e B (ZO-27, ZO-28, mesma base `7c5ab73`): fila A=1, B=2. A integrado
  por fast-forward (`306df1f`) e `published` (`fake-1`). B `revalidated`:
  merge `6105094` sobre `306df1f`, `published` (`fake-2`). B só enviou o
  pedido depois de A publicado (lock do ambiente). O `succeeded` duplicado
  de A não criou um segundo registo e o `running` tardio ficou
  `ignored_terminal`. 1 `POST` por entrega.
- C (ZO-29, base `6105094`, head `db435b68`): resposta ao `POST` perdida
  (`drop`) e callbacks inacessíveis → `uncertain`. Com `5adb506`, o `GET`
  devolvia `succeeded`, mas o evento era tratado como duplicado do de A
  (`fake-1:2:succeeded`, fornecedor reiniciado) — defeito real, corrigido
  em `1a176e8`/043. Depois do deploy, a reconciliação aplicou o evento
  (`reconcile:succeeded:applied`) e a entrega ficou `published`, fluxo
  `completed`. Fornecedor: 1 `POST`, 46 `GET` (nenhum segundo pedido de
  publicação).
- Commits dos tickets de teste (sandbox, não confundir com a entrega):
  `306df1f` (A), `0e1cf1e` (B), merge `6105094`, `db435b68` (C).

Reparação de encoding (dados de teste de P07/P08): transação em 13
colunas (tickets ZO-25/26, comentário, revisões, `flow_decisions`,
`development_review_decisions`, nomes «Teste P07 Simulação»,
`flow_simulation_runs`, `agent_runs.instructions`,
`flow_execution_steps`); verificação por HEX: 0 linhas corrompidas e JSON
válido.

Limpeza: contentor do fornecedor removido; fluxo «Teste P09 Entrega —
retirado» (regra restringida ao ambiente `development`, republicado);
pipeline arquivada; 0 `resource_locks`, 0 entregas e 0 runs ativos. A
variável `ZEROOPS_PIPELINE_ALLOWED_ORIGINS` mantém-se (só aceita
`127.0.0.1:8787`, sem serviço a escutar).

Integrações reais verificadas: Git (sandbox, integração e merge), BD,
executor, leases/locks, Copilot real no desenvolvimento e callbacks/consultas
HTTP assinadas. Simuladas: fornecedor de pipeline (falso) e relay Health
(só testes automatizados). Não verificado em QA: fornecedor real e Health
com relay instalado.

Próximo passo: P10 (fora desta entrega).

## P10 — Desenvolvimento de capacidades e rollout do ZeroOps

Branch `feat/p10-capability-development-rollout`, criada a partir de
`e713a1c` (P09 + [DOC]). Guia de publicação e ensaio: [qa-p10.md](qa-p10.md).

### Ponto de partida confirmado

- P06 registava pedidos de capacidade em falta (`flow_capability_requests`)
  na sessão de autoria, sem processo executável associado.
- P08/P09 já davam desenvolvimento isolado (workspace, branch, testes, PR),
  review dinâmico ligado ao head e entrega por pipeline com gates,
  reconciliação e `uncertain`.
- O deploy do ZeroOps em QA era o `post-receive` → `deploy-from-git.sh`
  (backup, migrations, health, rollback automático), sem drenagem dos
  executores nem confirmação independente do processo que pede o deploy.

### Alterações

- **Permissões** `capabilities.develop` (iniciar/cancelar) e
  `capabilities.publish` (autorizar a publicação), delegáveis pelas regras
  de P01. Desenvolver e publicar são verificados separadamente; a
  associação ao rascunho exige `flows.edit`.
- **Recursos por projeto** (`project_capability_settings`, cartão
  «Capacidades» nas definições de pipelines): repositório do ZeroOps,
  pipeline/alvo de publicação e fluxo de desenvolvimento explicitamente
  atribuídos ao projeto (validados como ativos e do próprio projeto). Gerir
  exige `repositories.manage`.
- **Processo de capacidade** (`CapabilityDevelopmentService`, API
  `/api/projects/:pid/flows/:fid/capability-developments`): um processo por
  pedido de P06, com categoria (`configuration`, `agent_skill`,
  `integration`, `zeroops_change`), requisito, critérios de aceitação,
  versão/hash do rascunho de origem, dependência obrigatória ou opcional.
  `start` é idempotente (chave única pelo pedido, `FOR UPDATE`): repetições
  e recuperações de sessão devolvem o mesmo processo e o mesmo ticket.
  - Configuração/agente: sem código; o processo regista-se e fica associável.
  - Integração/alteração ao ZeroOps: cria um ticket no fluxo de
    desenvolvimento atribuído (`flowId` explícito no motor, sem depender do
    encaminhamento), reutilizando P08 (workspace, branch, testes, PR,
    review) e P09 (entrega pela pipeline do projeto).
  - Estado derivado do ticket e da entrega (`developing` → `review` →
    `publishing` → `published` → `available`), nunca regressa de estados
    terminais; `uncertain` da entrega → `reconciliation_required`.
  - `available` só quando a versão em execução no runtime
    (`ZEROOPS_VERSION` do executor) é o SHA publicado.
- **Gates de publicação** (`development/capability-gates.ts`): a entrega de
  um ticket de capacidade só avança com autorização de publicação de um
  utilizador que **ainda** tenha `capabilities.publish`, processo não
  cancelado e nos estados aplicáveis. Revalidado pelo executor antes de
  integrar e de publicar, junto com os gates de P09. A capacidade nova não
  altera os gates nem as permissões do agente.
- **Rascunho e ativação**: durante o desenvolvimento o rascunho continua
  editável; a ativação devolve `FLOW_CAPABILITY_PENDING` enquanto houver
  dependências obrigatórias por associar. `link` (auditado) incrementa a
  versão do rascunho; se o rascunho mudou desde o pedido exige confirmação
  explícita (`CAPABILITY_DRAFT_CHANGED`). Publicar ou associar nunca ativa o
  fluxo; versões já ativadas e tickets existentes não mudam.
- **Cancelamento**: preserva ticket, workspace, eventos e evidências; a
  entrega fica bloqueada pelo gate (ou é reconciliada se já estava em
  publicação).
- **Drenagem** (`zeroops_runtime_drains`, vista `zeroops_active_jobs`): o
  `deploy-from-git.sh` drena sempre depois da build e antes de qualquer
  alteração.
  - Pede a drenagem: os executores deixam de reclamar jobs novos
    (`RuntimeDrainWatcher` + pausa do `JobPool`).
  - Numa BD anterior à 044 faz uma drenagem de arranque, com as mesmas
    condições da vista.
  - Espera pelos jobs com lease (máx. 300 s). Sem `ZEROOPS_DRAIN_FORCE=1`,
    esgotado o prazo, aborta sem alterar nada.
  - Para o executor em execução (paragem ordenada; o que tiver sido
    reclamado volta à fila sem consumir tentativa) e volta a contar.
  - Se o deploy falhar antes da troca, volta a arrancar o executor anterior.
  - A drenagem é libertada após o health da versão nova e expira sozinha.

  Perguntas pendentes, decisões, sessões de autoria e esperas do motor não
  têm lease e ficam intactas.

- **Operador de rollout independente** (`deploy/qa/zeroops-rollout-operator.py`,
  serviço systemd `zeroops-rollout-operator`, só QA): fora dos contentores,
  implementa o contrato `webhook` das pipelines (pedidos e callbacks
  assinados). Estado JSON durável por chave, lock por alvo, pedidos
  idempotentes (409 para chave repetida). Passos: verificação (SHA na ref
  autorizada, avanço rápido sobre o `main` publicado, digest `git archive`
  igual ao revisto) → troca (executa o `deploy-from-git.sh` do próprio
  commit, com drenagem/backup/migrations/rollback) → confirmação
  independente (versão da API = SHA e executor saudável durante a janela de
  observação) → `update-ref` do `main` de deploy (sem hook: não há deploy
  duplicado). Distingue falha antes da publicação, falha durante a troca
  (versão anterior reposta) e resultado incerto (`reconciling`, nunca
  declarado concluído sem prova; esgotado o limite pede reconciliação
  manual). No arranque retoma rollouts pendentes sem repetir trocas
  interrompidas. As credenciais privilegiadas ficam no operador; o
  workspace do agente não tem acesso ao host.
- **Web**: painel «Capacidades» no editor/chat de autoria (pedido e motivo,
  desenvolvimento, ticket/branch/PR, review pendente, autorização,
  publicação/rollout, disponibilidade, associação, falhas e próximos
  passos), reconstruído a partir dos estados e eventos persistidos (retoma
  depois de recarregar); permissões novas na página de permissões.

### Decisões

- O operador reutiliza o `deploy-from-git.sh` (mesmo procedimento de
  backup/migrations/rollback) em vez de um segundo mecanismo de deploy; o
  agente que pede o rollout só vê o resultado através da pipeline e da
  versão do runtime.
- A entrega de capacidades usa o contrato de pipeline de P09: o operador é
  mais uma pipeline do projeto, sujeita à allowlist
  `ZEROOPS_PIPELINE_ALLOWED_ORIGINS`.
- `link` só incrementa a versão do rascunho (a definição não muda); se não
  houver outras alterações a ativação devolve `FLOW_UNCHANGED` e é preciso
  uma alteração real para gerar uma versão publicável.
- O purge de tickets apaga também `capability_development_events` e
  `capability_developments` dos tickets purgados e recusa enquanto houver
  processos em `publishing`/`reconciliation_required` (o SQL manual foi
  espelhado).
- `capability-gates.ts` fica em `development` (usado por `delivery` e
  `flows`); `capabilities` é um domínio de topo na allowlist de
  arquitetura, sem ciclos.

### Migration

[044](../sql/044_capability_development_rollout.sql), aditiva e
idempotente: `project_capability_settings`, `capability_developments`,
`capability_development_events`, `zeroops_runtime_drains` e a vista
`zeroops_active_jobs`. O CHECK de `flow_capability_requests` não muda.
Os deploys a partir de uma BD anterior à 044 usam a drenagem de arranque
(ver «Drenagem»).

### Testes

- `apps/executor/src/capability-development.e2e.test.ts` (4, BD e Git
  reais, pipeline HTTP local simulada): utilizador sem permissão → 403;
  delegado com `capabilities.develop` inicia; `authorizePublish` sem
  `capabilities.publish` → 403; pedidos concorrentes/repetidos → 1 processo
  e 1 ticket; ticket no fluxo atribuído; rascunho editável e ativação
  bloqueada (`FLOW_CAPABILITY_PENDING`); review com head/testes; sem
  autorização não há entrega; autorização revogada → entrega `blocked` sem
  `POST`; rollout `publishing` → `published` → `available` só quando a
  versão do runtime coincide; `link` sem ativação automática, ativação
  explícita e ticket concluído; cancelamento com ticket/eventos
  preservados; configuração sem ticket e `CAPABILITY_DRAFT_CHANGED`;
  `RuntimeDrainWatcher`.
- `tests/test_rollout_operator.py` (10, Python, host simulado): assinatura,
  idempotência, cancelamento, verificação (SHA/ascendência/digest), troca
  com sucesso, falha antes da publicação, falha durante a troca, resultado
  incerto em reconciliação, retoma após reinício sem repetir a troca,
  `update-ref` sem deploy duplicado.
- `tests/test_deploy_from_git.py` (6, Python + bash real, comandos `mysql`,
  `docker`, `git` e `curl` simulados):
  - drenagem de arranque sem tabela: espera até 0 jobs e para o executor
    antes do backup e da troca;
  - com a tabela: usa a vista e liberta a drenagem depois do arranque;
  - prazo esgotado: aborta sem parar o executor nem alterar código;
  - falha do backup depois da paragem: o executor anterior volta a arrancar;
  - jobs ainda com lease depois da paragem: aborta e o executor volta a
    arrancar;
  - falha da migration: o rollback repõe o código e arranca a versão
    anterior.
- `job-pools.test.ts`: pausa da drenagem sem novos claims.
- `project-ticket-purge.test.ts`: purge com as tabelas novas (10/10).

#### Checks

- `typecheck`: OK. `lint`: só o erro pré-existente `portKey`.
- Prettier: limpo nos ficheiros alterados/novos.
- Suite raiz: 457 a passar; só as 3 falhas de arquitetura do baseline
  (violações de `incidents` e lacunas de documentação antigas; nenhuma de
  P10).

### Publicação e validação em QA

#### Deploy da implementação P10

- Branch `feat/p10-capability-development-rollout` → remoto `qa` e
  `qa main` (hook `deploy-from-git.sh`, sem push manual duplicado):
  `45d6699` ativo, migration 044 aplicada, backup prévio, health OK.
- **Primeiro deploy sem drenagem (corrigido).** O deploy de `45d6699` partiu
  de uma BD sem a tabela da 044 e o script de então seguiu sem drenagem.
  - `deploy.log`: aviso «sem tabela de drenagem» às 01:44:10 UTC, troca e
    arranque às 01:44:41, OK às 01:45:13.
  - Antes do push tinha sido confirmado manualmente que não havia jobs
    ativos, mas a janela entre a build e a troca não estava protegida.
  - Verificação dos jobs afetados na BD de QA:
    - entre 01:35 e 01:50 não houve nenhum job criado, iniciado ou terminado
      em `agent_runs`, `flow_assistant_requests`, `ticket_routing_jobs`,
      `flow_simulation_runs` nem `delivery_runs`;
    - 0 `agent_runs`/`flow_assistant_requests` `failed`/`cancelled` desde as
      01:30;
    - as esperas e os tickets anteriores, como a espera de review de ZO-26,
      ficaram intactos.
  - Não houve jobs a recuperar.
  - Correção: o script passou a drenar sempre, como descrito em «Drenagem»
    (drenagem de arranque sem a tabela, paragem do executor e reativação em
    caso de falha antes da troca). O deploy seguinte em QA usa o
    procedimento novo (ver «Deploy com a drenagem corrigida»).
- Operador independente instalado com `deploy/qa/install-rollout-operator.sh`
  (systemd `zeroops-rollout-operator`, `127.0.0.1:4320`, segredo só em
  `/etc/zeroops/rollout-operator.env`, nunca impresso). Allowlist da
  pipeline: `http://127.0.0.1:4320`; API/worker/executor recriados com
  `ZEROOPS_VERSION` completo.
- Repositório de teste `/opt/zeroops/test-repos/zeroops-capabilities.git`
  (bare, `main` = `45d6699`), atribuído apenas ao projeto de teste.

#### Ensaio com uma capacidade real (projeto de teste)

1. Delegado `p10-delegado@zeroops.invalid` (membro técnico) com
   `flows.view`, `flows.edit` e `capabilities.develop`, atribuídas pelo
   administrador. `saveSettings` pelo delegado → `FORBIDDEN`.
2. Rascunho «Teste P10 Rascunho» criado pelo delegado; no chat real com o
   Copilot (`assisted`, 35 s) pediu uma ação de citação (blockquote) no
   editor Markdown dos comentários. O Copilot registou o pedido de
   capacidade `186af1c1…` (nó `responder_cliente`).
3. Início: revisor → `FORBIDDEN`; delegado inicia `0743cfb4…`; repetir
   devolve o mesmo id (1 ticket, ZO-30); ativação do rascunho →
   `FLOW_CAPABILITY_PENDING`, edição continua possível.
4. Desenvolvimento real pelo Copilot no workspace isolado (P08): commit
   `fc4ab23` (3 ficheiros), testes executados `exit=0` ligados ao SHA,
   branch `zeroops/zo-30-30a286ca`, PR #6 (provider interno).
5. Review dinâmico (revisor `p08-revisor`): decisões do admin e do
   delegado → `FORBIDDEN`; SHA antigo → `REVIEW_ARTIFACT_CHANGED`; rota
   legada → `FLOW_MANAGED`. Duas rejeições (rótulo acessível + teste de
   seleção parcial → `e9d43c9`; formatação Prettier → `50fcebf`), com
   invalidação `head_changed` das decisões anteriores. Aprovação em
   `50fcebf`.
6. Gate de publicação: sem `capabilities.publish` a entrega espera sem
   pedido ao operador; `authorizePublish` do delegado → `FORBIDDEN`.
   Corrigido o estado apresentado nesta espera (`review` com motivo, antes
   `developing`) — commit `1eda81f`.
7. Autorização pelo administrador → integração fast-forward de `50fcebf`
   no repositório de capacidades → pedido ao operador (chave
   `3025d9e6…`): `accepted` → `verifying` → `deploying` → `confirming` →
   `succeeded` («Versão 50fcebfaae62 ativa e saudável durante 30s»).
   Drenagem `433c4cdf…` (0 jobs ativos, libertada), backup
   `zeroops-20261115T021206-g50fcebfaae62.sql.gz`.
8. Após a troca de processos, o novo executor reconciliou a entrega
   (`published`) e confirmou a capacidade `available` (runtime
   `50fcebf`); execução de ZO-30 `completed`, ticket `resolved`.
9. Associação ao rascunho: revisor → `FORBIDDEN`; delegado → `linked`,
   `draft_version` 1 → 2, repetição → `CAPABILITY_NOT_AVAILABLE`; o fluxo
   continua sem versão publicada/ativa e sem dependências pendentes.

#### Preservação verificada após o rollout

- Espera de review de ZO-26 (P08) continua `waiting`; ZO-19 `new`
  intacto; o pedido P06 `9b35d5b6…`/«gestor de conta» continua `open`.
- Nenhum `agent_run` falhado após a troca; novo pedido de chat processado
  pelo executor novo (`succeeded`, 20 s).

#### Deploy com a drenagem corrigida

Deploy de `33d76a2` (`git push qa <branch>:main`, só pelo hook, que usa o
script do próprio commit). O `deploy.log` mostra:

```text
02:50:36 Deploy 33d76a23fc58… (imagem g33d76a23fc58)
02:52:16 Drenagem 05c372e7-…: a aguardar jobs ativos (max 300s)
02:52:16 Jobs ativos: 0
02:52:16 A parar o executor anterior (sem novos claims ate ao arranque da versao nova)
02:52:18 Executor parado; jobs ativos: 0
02:52:18 Drenagem concluida
02:52:18 Backup da BD zeroops -> …/zeroops-20261115T025218-g33d76a23fc58.sql.gz
02:52:22 Migracoes
02:52:24 Arranque
02:52:45 OK: 33d76a23fc58… ativo
```

- Drenagem `05c372e7…` libertada às 02:52:40, depois do health; 0
  drenagens abertas. O executor novo registou `executor.drain_started` e
  `executor.drain_released`. Backup validado com `gzip -t`.
- `/api/health` com a versão `33d76a2`; connectors 200; operador
  `zeroops-rollout-operator` ativo (`/health` → `ok`, fila 0).
- Preservação: antes e depois, 0 jobs ativos, 1 execução `waiting`
  (ZO-26 `awaiting_technical`) e 11 `completed`; ZO-19 `new`, ZO-30
  `resolved`. 0 `agent_runs`/`flow_assistant_requests` falhados ou
  cancelados desde o deploy.
- Novo pedido de chat (só consulta) no rascunho de teste processado pelo
  executor novo (`succeeded`, 25 s).
- O caminho sem tabela de drenagem (BD anterior à 044) não pode ser
  repetido em QA sem remover a tabela; está coberto por
  `tests/test_deploy_from_git.py`, executado também no Linux de QA (6/6,
  bash e ferramentas GNU reais, comandos de Docker/MySQL simulados).

#### Distinção de commits

- Implementação P10: `ac5b5da`…`45d6699`, `1eda81f`, `f9bc2b8`
  (documentação), `33d76a2` (drenagem sempre aplicada no deploy) e o commit
  de documentação seguinte.
- Capacidade produzida pelo ticket ZO-30 (rollout pelo operador):
  `fc4ab23`, `e9d43c9`, `50fcebf`, integrados por fast-forward na branch.

#### Limitações

- O Copilot real foi usado no chat e no desenvolvimento; operador,
  drenagem e deploy são reais no host de QA. O repositório de capacidades
  e o provider de PR são locais (sem GitHub).
- O `link` só incrementa `draft_version`; ativar exige outra alteração do
  rascunho (`FLOW_UNCHANGED` caso contrário). O rascunho de teste não foi
  ativado para não captar tickets reais.

## P11 — Migração final e operação

Branch `feat/p11-migration-operation` a partir de `b0cec48` (P10 em QA).
Procedimentos em [operacao-zeroops-agentico.md](operacao-zeroops-agentico.md)
e publicação em [qa-p11.md](qa-p11.md).

### Alterações

- `a9b3563` [FEAT] — autoridade única: `flow-authority.ts` centraliza a
  regra «ticket gerido por fluxo»; `workflow.service`, `tickets.service` e
  `ticket-governance.service` rejeitam transições/decisões/governança
  legadas com `409 FLOW_MANAGED` (sem segundo caminho de aprovação).
  `flow-adoption.ts` + `ops flow-adoption`: inventário e adoção/exclusão
  explícita e auditada de tickets antigos sem execução (dry-run com hash;
  `--apply` exige o hash). Sem backfill automático, sem reassociar tickets
  a versões novas, sem repetir operações externas. `ops
migration-inventory` lista versões, tickets, execuções, perguntas,
  aprovações, jobs e dependências por projeto.
- `61be962` [FEAT] — `operations-metrics.service.ts` e contrato
  `operations-metrics.ts`: filas e espera, duração/falha por etapa,
  retries e leases expirados, perguntas e intervenção humana, consumo e
  quota reportados pelo Copilot (só valores do fornecedor; `null` quando
  ausentes), ferramentas, pipelines, operações incertas e Health
  (recuperação, reincidência). Correlação por projeto, ticket, versão,
  execução, etapa, job/tentativa e operação externa. Página «Operação»
  (`OperationsMetricsPage.tsx`) só para membros com permissão interna; sem
  segredos nem dados internos nas vistas públicas.
- `eef1e2e` [FEAT] — `retention.service.ts` + `ops retention`: políticas
  configuráveis para workspaces, logs, bundles, eventos e artefactos;
  verifica referências, jobs ativos, reviews, publicações e necessidades
  de recuperação antes de selecionar; nunca seleciona recursos de outro
  projeto/job nem capacidades partilhadas em uso; dry-run por omissão,
  aplicação só com o hash da seleção. Integrado na purga existente
  (`project-ticket-purge.ts`, `sql/manual/purge_project_tickets.sql`) e no
  worker.
- `7113185` [FIX] — a métrica de recuperação Health passa a usar a
  validação do fluxo (confirmada / não confirmada / telemetria
  desconhecida), em vez de inferir saúde pela ausência de alertas.
- `7e69bca` [FIX] — executor: no modo `implement`, `readAgentReport`
  descarta `evidence`/`clientQuestions` não pedidos antes do schema
  estrito (defeito encontrado em QA com ZO-36, ver abaixo); continua a
  validá-los no modo `investigate`.
- Documentação: runbook [operacao-zeroops-agentico.md](operacao-zeroops-agentico.md),
  [qa-p11.md](qa-p11.md), `README.md`, `deploy/README.md`,
  `funcionalidades.md`, `docs/arquitetura.md`,
  `docs/compatibilidade-zeroops-agentico-p00.md`.

### Migration

`sql/045_ticket_flow_adoptions.sql` — aditiva e idempotente (tabela
`ticket_flow_adoptions`). Não altera tickets, versões nem execuções. O
código anterior não a lê; repor código não a desfaz e não precisa.

### Testes

- Novos: `flow-authority.test.ts`, `flow-adoption.test.ts`,
  `operations-metrics.service.test.ts`, `retention.service.test.ts`,
  `operations-metrics.test.tsx` (web) e o caso novo de
  `copilot.adapter.test.ts`.
- Suite raiz completa: 465 passados, 2 ignorados, 4 falhados — as 3 falhas
  de arquitetura do baseline P00 e um caso do executor que correu antes de
  a correção `7e69bca` estar gravada (a suite arrancou às 04:28, o commit é
  das 04:38). Reexecutado sobre o código final: `apps/executor` 77
  passados / 2 ignorados.
- `npm run lint`: só o `portKey` pré-existente
  (`StepConfigPanel.tsx`). `npm run typecheck`: OK. Testes web: 21
  ficheiros / 136 passados, mais 13 testes node passados.

### Publicação e validação em QA (`main`)

Cada commit foi publicado com `git push qa <branch>:main` (hook: drenagem →
backup → migrations → health). Último código: `7e69bca`, backup
`zeroops-20261115T044045-g7e69bca7926f.sql.gz`, «OK: 7e69bca… ativo». O
commit de documentação final é publicado da mesma forma.

Projeto de teste «Teste P11 Operação» (`ccbf7062…`) com `p11-admin`,
`p11-tecnico` e `p11-cliente` (`@zeroops.invalid`). Fluxos e políticas do
Pizza Hut não foram alterados.

- **Migração e adoção**: inventário antes/depois
  (`files/p11-qa-pre-inventory.txt` na sessão); `ops flow-adoption`
  dry-run com 0 candidatos no Pizza Hut; a aplicação (`--apply` com hash)
  está coberta por `flow-adoption.test.ts` e não foi executada em QA. Rotas
  legadas em ticket gerido → `FLOW_MANAGED`.
- **Retenção**: dry-run em todos os projetos → 0 recursos selecionados nos
  dados existentes; aplicação ensaiada apenas sobre 3 eventos sintéticos
  do projeto de teste.
- **Isolamento e revogação**: utilizadores de T sem acesso ao Pizza Hut e
  vice-versa; permissão revogada recusada na operação seguinte.
- **Credenciais**: credencial Copilot de T revogada (v2 `revoked`, teste
  falha sem reativar), nova versão v3 `verified` e run real a seguir.
- **Recuperação**: executor morto durante um run → lease expirado →
  tentativa 2 `succeeded`; um segundo executor a arrancar não marcou o
  job vivo como falhado; tentativa antiga sem efeitos; perguntas e
  decisões pendentes preservadas (ZO-26 continua `waiting`).
- **Cenário D (Health)**: ZO-31/33/34/35 (demo, Copilot real) com
  intervenção **simulada** e recuperação confirmada; ZO-32 com alertas
  reais pelo recetor: correlação num incidente, telemetria ausente →
  `unknown` → escalada.
- **Cenário B (desenvolvimento) na versão P11**: repositório «Sandbox
  P11» e fluxo «Teste P11 Desenvolvimento» (dev PR → review do técnico).
  ZO-36 falhou (`agent_failed`, ZodError: o modelo devolveu `evidence` não
  pedida) → saída `failure` do fluxo; corrigido em `7e69bca` e publicado.
  ZO-37: Copilot real, head `741bcb45dfd0`, `node test.js` exit 0 ligado
  ao SHA, branch `zeroops/zo-37-0f0c14a5`, PR interno #1; técnico a criar
  repositório → `FORBIDDEN`; `workflow.transition` → `FLOW_MANAGED`; admin
  fora dos revisores → `FORBIDDEN`; SHA errado → `REVIEW_ARTIFACT_CHANGED`;
  aprovação do técnico → execução `completed`.
- **Preservação**: ZO-19..30 (Pizza Hut) com o mesmo estado e
  `version_id` do pré-inventário; 0 jobs ativos após cada deploy.

#### Métricas medidas no projeto de teste

`agent_run` 7 iniciados / 6 com sucesso / 1 falhado, espera média 24,9 s;
assistente 7/7, espera 8,1 s; leases 15 reclamados / 13 concluídos / 1
falhado / 1 `lease_expired_requeued`; 1 decisão humana (60,6 s); Copilot:
7 runs com usage, 28 chamadas, 397 875 tokens de entrada / 15 799 de saída,
46,63 AI credits, quota 85 200 / 100 000; Health: 5 incidentes, 2
reincidências, validações 4 confirmadas / 1 não confirmada / 1
desconhecida; etapa dev média 156 s.

#### Concorrência (host de QA: 1 vCPU, 1971 MB)

Medido num executor temporário, com os valores de
`/etc/zeroops/zeroops.env` repostos no fim:

| Ensaio   | Resultado                                                                                  |
| -------- | ------------------------------------------------------------------------------------------ |
| Chat c=1 | espera até 24,4 s                                                                          |
| Chat c=3 | espera até 8,1 s; host até 1418 MB                                                         |
| Runs c=2 | ~160 s cada (152 s isolado); executor até 492/640 MiB; host 1447 MB; `/api/health` ≤ 20 ms |

Proposta inicial: `ZEROOPS_EXECUTOR_RUN_CONCURRENCY=1` (máximo 2 neste
host), `ZEROOPS_EXECUTOR_ASSISTANT_CONCURRENCY=2`, routing 1. **Não
aplicada em QA**: decisão de operação.

### Matriz de requisitos P00–P10

Estados: **verificado** (código + teste + evidência real em QA),
**parcial** (implementado, mas com parte só simulada ou não ensaiada),
**bloqueado**, **não implementado**.

| Fase | Requisito                                  | Implementação / evidência                                                                                                    | Estado     |
| ---- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P00  | Baseline, SDK/CLI, ADRs                    | SDK real verificado em QA; ADRs e inventário de mutação em `compatibilidade-…-p00.md`                                        | verificado |
| P00  | MySQL 5.7                                  | Só MariaDB 10.3 (QA) ensaiado                                                                                                | parcial    |
| P00  | Browser local                              | Edge local bloqueado por políticas; browser validado em QA (P06)                                                             | parcial    |
| P01  | Permissões delegáveis e revogação imediata | Testes de autorização; QA em P01 e de novo em P11 (isolamento, revogação)                                                    | verificado |
| P02  | Fluxos V2, versões e ativação explícita    | Testes; ativação em QA por serviço/script, não pelo browser                                                                  | parcial    |
| P03  | Jobs, leases, política de ferramentas      | Kill do executor, lease expirado, segundo executor (P11)                                                                     | verificado |
| P04  | Catálogo agentes/skills → Copilot          | Testes; compilação e uso real em QA                                                                                          | verificado |
| P05  | Encaminhamento semântico e esclarecimentos | Conjunto rotulado; cenário A com ZO-22/23/24                                                                                 | verificado |
| P06  | Chat de construção com diagrama            | Validado no browser em QA                                                                                                    | verificado |
| P07  | Simulador partilhado                       | Runtime e API testados; UI do simulador não validada em QA (sessão 401)                                                      | parcial    |
| P08  | Workspace Git, desenvolvimento, review     | B/C com ZO-25/26 e ZO-37 (Copilot real); provider de PR interno, sem GitHub                                                  | parcial    |
| P09  | Pipeline, integração, Health pelo fluxo    | Fila/locks/review/callbacks testados; fornecedor de pipeline falso; relay 1.2.0 não instalado; intervenções Health simuladas | parcial    |
| P10  | Capacidades e rollout                      | Copilot, operador, drenagem e deploy reais (ZO-30); repositório/PR locais                                                    | verificado |
| P11  | Autoridade única e adoção                  | `FLOW_MANAGED` em QA; adoção: dry-run em QA, apply só em testes automáticos                                                  | verificado |
| P11  | Métricas e correlação                      | Página «Operação» e métricas de T em QA                                                                                      | verificado |
| P11  | Retenção                                   | Dry-run 0 em dados reais; apply sintético                                                                                    | verificado |
| P11  | Recuperação e concorrência                 | Kill/lease/segundo executor; medições c=1..3                                                                                 | verificado |
| P11  | Cenários A–E (§17)                         | A (P05), C (P08) e E (P10) reaproveitados; B repetido em P11; D com intervenção simulada                                     | parcial    |

### Limitações e pendências

- Health: o relay 1.2.0 não está instalado nos alvos; nenhuma intervenção
  real (restart) foi executada; a recuperação foi confirmada em fluxos
  demo.
- Pipeline: só o fornecedor falso/interno; sem GitHub nem CI real (o
  ZeroOps não tem `.github/workflows`).
- B em P11 não repetiu o ciclo de correção nem a pipeline (evidência de
  P08/P09); A, C e E não foram repetidos sobre a versão P11.
- UI do simulador (P07) e ativação pelo browser (P02) não validadas em QA.
- MySQL 5.7 não certificado.
- Dívidas do baseline mantidas: 3 testes de arquitetura, lint `portKey`,
  avisos antigos do Prettier.
- A proposta de concorrência não foi aplicada.
- **O projeto não está integralmente concluído** (critérios parciais
  acima) e os resultados de QA não demonstram prontidão para Produção.
