# Operação do ZeroOps agêntico (fluxos, Copilot, jobs)

Procedimentos para operar o ZeroOps depois de P00–P11. O estado de cada fase e as evidências
estão no [registo de progresso](progresso-zeroops-agentico.md). Os procedimentos de publicação
por fase estão em `qa-p01.md` … `qa-p11.md`.

Cada procedimento indica o nível de verificação:

- **Ensaiado em QA**: executado no servidor de QA na versão publicada, com recursos de teste.
- **Ensaiado localmente**: coberto por testes automatizados ou por um ensaio local, mas não em QA.
- **Não verificado**: instrução derivada do código, ainda sem ensaio.

Nada aqui foi ensaiado em Produção. Antes de usar um procedimento em Produção, repetir o ensaio
com aprovação e backup verificado.

## Princípios

- Um ticket gerido por fluxo tem uma única autoridade: o motor de fluxos. As rotas antigas de
  workflow/governança devolvem `409 FLOW_MANAGED` em vez de mudar o estado.
- Cada ticket fica associado à versão do fluxo com que começou. Ativar uma versão nova só afeta
  tickets novos.
- Jobs (`agent_runs`, assistente, encaminhamento, simulações e entregas) usam lease, tentativa e
  epoch. Uma tentativa sem posse não produz efeitos.
- Operações externas sem confirmação ficam `uncertain` ou `reconciliation_required`. Não são
  repetidas sem consultar primeiro o estado externo.
- Segredos não aparecem em vistas, logs, eventos nem argumentos de linha de comandos.

## Ligação ao servidor

```bash
ssh pizzahut-qa                       # alias QA; Produção tem procedimento próprio
cd /opt/zeroops/src/deploy/docker
docker compose ps
curl -fsS http://127.0.0.1:4311/api/health   # status ready + version (SHA ativo)
ops() { docker compose exec -T api node dist/apps/api/src/ops.js "$@"; }
```

BD: `mysql --defaults-file=/root/.zeroops/zeroops-mysql.cnf zeroops`. A tabela das migrations é
`zeroops_migrations`.

## 1. Configurar um projeto e os seus recursos

1. **Projeto** (admin da instância): «Projetos» → criar; depois «Administrar projeto» →
   «Geral». — _Ensaiado em QA_ (projeto «Teste P11 Operação», criado por script com as mesmas
   tabelas).
2. **Utilizadores**: «Administrar projeto» → «Utilizadores e acessos». Cada utilizador tem um
   papel por projeto (`admin`, `technical`, `qa`, `release`, `client`). — _Ensaiado em QA_.
3. **Integrações** («Integrações» ou «Administrar projeto» → «Parâmetros e integrações»): Copilot
   por projeto e ambiente, BD só de leitura, telemetria, SMTP. Gravar e depois «Testar»: só uma
   credencial `verified` é usada. — _Ensaiado em QA_ (Copilot).
4. **Repositórios Git** (`repositories.manage`): URL dentro de `ZEROOPS_DEV_ALLOWED_REPO_ROOTS`,
   branch base, refs autorizadas, comandos de teste e «Verificar». Um URL fora das raízes devolve
   `INVALID_INPUT`. — _Ensaiado em QA_ (sandbox).
5. **Pipelines de entrega** (`repositories.manage`): endpoint dentro de
   `ZEROOPS_PIPELINE_ALLOWED_ORIGINS`, repositório, branch, ambiente e segredo de assinatura. O
   segredo não volta a ser mostrado. — _Ensaiado em QA_ com o fornecedor falso e o operador de
   rollout. Um fornecedor real não foi verificado.
6. **Saúde** («Saúde» → «Configuração» e «Administrar projeto» → «Saúde e notificações»): sondas,
   destinatários, política de intervenções (`auto`/`approval`/`deny` por ação e serviço) e janela
   de validação. — _Ensaiado em QA_ com alertas pelo recetor real. As intervenções no alvo foram
   simuladas.

## 2. Atribuir permissões

«Permissões do projeto» (ou «Administrar projeto» → «Permissões do projeto»). Permissões:
`flows.view`, `flows.edit`, `flows.simulate`, `flows.activate`, `agents.manage`, `skills.manage`,
`repositories.manage`, `capabilities.develop`, `capabilities.publish` e
`project.permissions.manage`.

- Só administradores atribuem ou revogam `project.permissions.manage`.
- Um delegado só gere permissões que tem e que são delegáveis. Não altera as próprias
  permissões nem as de administradores.
- A revogação aplica-se à operação seguinte. Os grants que o delegado atribuiu não são
  removidos em cascata; revê-los na lista de grants.
- Cada alteração exige a versão atual (`STALE_VERSION` se outro utilizador mudou entretanto) e
  fica auditada.

_Ensaiado em QA_ (P01 e P11): isolamento entre projetos (`FORBIDDEN`/`NOT_FOUND` noutro projeto)
e revogação com efeito imediato.

## 3. Criar, simular e ativar fluxos

1. «Fluxos» → criar a partir de um modelo ou em branco (`flows.edit`). O rascunho grava-se com
   controlo de versão. O assistente de autoria constrói o fluxo pelo chat. — _Ensaiado em QA_
   (P06).
2. Validar: o editor mostra erros por nó (responsável em falta, ligações, capacidades
   indisponíveis).
3. Simular (`flows.simulate`): cenários com respostas simuladas de agentes, decisões e alertas. A
   simulação não chama integrações reais. — _Ensaiado em QA_ por API (P07). A UI do simulador não
   foi validada no browser de QA.
4. Ativar (`flows.activate`): «Ativar esta versão» cria uma versão imutável. Uma capacidade
   obrigatória por publicar devolve `FLOW_CAPABILITY_PENDING`. Um rascunho igual à versão ativa
   devolve `FLOW_UNCHANGED`. — _Ensaiado em QA_ por serviço (P02, P10 e P11). A ativação pelo botão
   no browser não foi repetida.
5. Tickets em curso mantêm a versão com que começaram. Tickets antigos sem execução **não**
   entram automaticamente num fluxo (ver §5).

## 4. Gerir agentes e skills

«Agentes e skills» (`agents.manage` / `skills.manage`): cada agente e skill é versionado. As
versões usadas por fluxos ativos ou tickets existentes não são substituídas. Um fluxo referencia
uma versão. Para mudar a versão usada, editar o rascunho e ativar uma nova versão do fluxo.
Capacidades em falta pedidas no chat de autoria seguem o processo de P10 (§7). — _Ensaiado em
QA_ (P06/P10).

## 5. Tickets antigos e adoção explícita

O worker já não faz backfill. Inventário e adoção:

```bash
ops migration-inventory --as admin@exemplo.pt            # contagens e tickets sem execução
ops flow-adoption --as admin@exemplo.pt                  # dry-run: candidatos + hash
ops flow-adoption --disposition start   --tickets ID1,ID2 --reason "..." --apply --expect HASH --as admin@exemplo.pt
ops flow-adoption --disposition exclude --tickets ID1     --reason "..." --apply --expect HASH --as admin@exemplo.pt
```

- `start` cria a execução na versão ativa atual. `exclude` regista o ticket como fora dos fluxos.
  As duas decisões ficam auditadas (`ticket_flow_adoptions` e `audit_events`).
- O `--expect` tem de ser o hash do dry-run anterior. Se a seleção mudou, nada é aplicado.
- Usar só em tickets cujo trabalho externo (remediação, publicação) já está fechado. A adoção não
  repete operações anteriores, mas o fluxo novo pode iniciar etapas novas.

_Ensaiado em QA_: dry-run com 0 candidatos. Sem adoções reais, porque não havia tickets elegíveis.
O apply está coberto por testes automatizados.

## 6. Acompanhar e recuperar jobs

- **Página «Operação»** (equipa, não clientes): filas e espera, duração e falhas por etapa,
  retries e leases expirados, perguntas e decisões humanas, consumo Copilot reportado, pipelines,
  operações incertas e Health. Health mostra «com alertas recuperados» e a validação da
  recuperação: confirmada, não confirmada e telemetria desconhecida. Valores que o fornecedor não
  reporta aparecem como «não reportado». API:
  `GET /api/projects/:projectId/operations/metrics?days=7`. — _Ensaiado em QA_.
- **Ticket**: separador «Fluxo» com etapa atual, responsáveis, runs, eventos, entregas, fila,
  intervenções Health e reconciliações.
- **Jobs ativos**: `SELECT * FROM zeroops_active_jobs;`.
- **Executor reiniciado ou morto**: os runs `running` cujo lease expira (90 s) voltam à fila e são
  retomados com uma nova tentativa e um novo epoch (`maxAttempts` 2). Um segundo executor não
  marca como falhados os jobs vivos de outro. — _Ensaiado em QA_ (P11: kill durante ZO-32, retoma
  na tentativa 2, `succeeded`).
- **Run falhado depois das tentativas**: o fluxo segue a saída `failure` definida (por exemplo,
  voltar ao desenvolvimento ou escalar para uma decisão humana). Não existe um botão genérico
  de repetir. A repetição tem de estar prevista no fluxo. Não alterar estados por SQL.
- **Operação incerta** (`uncertain`, `reconciliation_required`): consultar o estado externo
  (pipeline, operador, relay). Com resposta, a reconciliação aplica-a. Sem resposta, decidir
  manualmente e registar a decisão. Não repetir um restart só porque a resposta expirou.
- **Cancelar ou suspender** um ticket impede novos efeitos. Tentativas em curso perdem a posse.

Limites iniciais propostos (medidos em QA, 1 vCPU e 2 GB):

| Variável                                 | Atual | Proposta   | Notas                                          |
| ---------------------------------------- | ----- | ---------- | ---------------------------------------------- |
| `ZEROOPS_EXECUTOR_RUN_CONCURRENCY`       | 1     | 1 (máx. 2) | 2 runs: executor até 492/640 MiB, host 1447 MB |
| `ZEROOPS_EXECUTOR_ASSISTANT_CONCURRENCY` | 1     | 2          | chat c=3: espera até 8 s; c=1: até 24 s        |
| `ZEROOPS_EXECUTOR_ROUTING_CONCURRENCY`   | 1     | 1          | não exposta no `compose.yml`; fica no valor 1  |

As duas primeiras definem-se em `/etc/zeroops/zeroops.env` e aplicam-se ao recriar o executor.
Não aumentar sem aumentar a memória do host e repetir a medição (ver P11 no progresso). A
proposta de 2 para o assistente ainda não foi aplicada em QA.

## 7. Publicar e recuperar versões do ZeroOps

- **Deploy de código**: `git push qa <branch>:main`. O hook `deploy-from-git.sh` faz drenagem,
  backup (`/var/backups/zeroops/*.sql.gz`), migrations, build, arranque, health e rollback
  automático em falha. O push da branch com o próprio nome não publica. Confirmar
  `OK: <sha> ativo` e `/api/health`. — _Ensaiado em QA_ (P08–P11).
- **Rollout de uma capacidade** (P10): o fluxo de capacidade, depois do review e de
  `capabilities.publish`, pede o rollout ao operador `zeroops-rollout-operator`
  (`127.0.0.1:4320`). O operador drena, publica, confirma externamente a versão e a capacidade fica
  `available`. A associação ao rascunho é uma alteração auditada. O fluxo **não** é ativado. —
  _Ensaiado em QA_ (P10).
- **Recuperação**:
  - falha antes da troca: nada muda, o executor anterior volta a arrancar;
  - falha durante a troca: código e imagens anteriores repostos. As migrations não são desfeitas
    (todas aditivas). O restauro do backup é destrutivo e exige aprovação;
  - resultado incerto: `reconciliation_required`. Verificar `/api/health`,
    `/var/log/zeroops/deploy.log` e o estado em `/var/lib/zeroops-rollout`;
  - drenagem presa: expira sozinha ou
    `UPDATE zeroops_runtime_drains SET released_at=NOW(3) WHERE released_at IS NULL`;
  - executor parado: `docker compose start executor`.

  Detalhe em [qa-p10.md](qa-p10.md). — _Ensaiado em QA_: falha de publicação recuperada (P10).
  O caminho «durante a troca» só foi ensaiado localmente.

## 8. Rodar e revogar credenciais

- **Rodar** (Copilot, BD, telemetria, SMTP, segredos de pipeline): em «Integrações», gravar os
  novos valores com a versão atual e «Testar». Só uma credencial `verified` é usada. Uma credencial
  revogada pode ser substituída por uma gravação nova (nova versão), seguida de teste.
- **Revogar**: «Revogar» na integração. O estado passa a `revoked`, o segredo cifrado é apagado e
  o executor deixa de a obter no pedido seguinte (resolve a credencial em cada job). Testar uma
  credencial revogada não a reativa.
- **Segredos do host** (`/etc/zeroops/*.env`, `/root/.zeroops/*`, modo 0600): editar no servidor
  e recriar os serviços com o mesmo `ZEROOPS_VERSION`. Nunca os passar por argumentos nem por
  chat.
- **Chave de cifra** (`ZEROOPS_IDENTITY_KEY`): a mudança invalida os segredos
  cifrados. Não há procedimento de recifragem automático. — _Não verificado_.

_Ensaiado em QA_ (P11, projeto de teste): revogação com versão antiga → `STALE_VERSION`;
revogação → `revoked` v2; teste posterior sem reativação; nova gravação → v3 `verified` e run
Copilot real a seguir (ZO-36). Credenciais de outros projetos intactas.

## 9. Retenção e limpeza

```bash
ops retention --all-projects --as admin@exemplo.pt                      # dry-run: seleção + hash
ops retention --all-projects --apply --expect HASH --as admin@exemplo.pt
```

| Variável (API)                       | Por omissão | Remove                                                                        |
| ------------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| `ZEROOPS_RETENTION_JOB_EVENTS_DAYS`  | 180         | eventos de jobs que já não estão `queued`/`running`                           |
| `ZEROOPS_RETENTION_SIMULATIONS_DAYS` | 90          | simulações terminadas, exceto evidência de versões/ativações e a mais recente |
| `ZEROOPS_RETENTION_OUTBOX_DAYS`      | 180         | notificações já enviadas                                                      |
| `ZEROOPS_RETENTION_RUN_DELTAS_DAYS`  | 30          | deltas de streaming de runs terminados cuja mensagem final está gravada       |

`0` desativa. A seleção é sempre por projeto (ou por todos, explicitamente) e é revalidada linha a
linha no apply. O dry-run também conta os workspaces que seriam elegíveis (sem execução viva, run
ativo ou entrega por terminar), mas não os remove. Fora deste comando:

- workspaces de desenvolvimento: `ZEROOPS_DEV_WORKSPACE_RETENTION_DAYS` no executor;
- dados Health: purga própria do worker;
- backups do deploy: os 10 mais recentes;
- logs de ficheiro: logrotate.

_Ensaiado em QA_: dry-run (0 candidatos) e apply sobre 3 eventos sintéticos. Um `--expect` errado
→ rc=1, nada removido; o hash correto removeu os 3. Antes de aplicar a dados existentes, rever
sempre a seleção do dry-run.

## 10. Investigar falhas

1. `/api/health` (versão e `ready`) e `docker compose ps` (reinícios).
2. Página «Operação» do projeto: etapa, falhas, leases expirados, operações incertas.
3. Ticket → «Fluxo»: etapa, run, tentativa e evento de erro (`error_code`).
4. Logs: `docker compose logs --tail 200 api worker executor`;
   `/var/log/zeroops/deploy.log`; `/var/log/zeroops/rollout-operator.log`.
5. BD (só leitura): `agent_runs` (`status`, `attempt`, `lease_expires_at`, `error_code`),
   `flow_execution_steps`, `flow_execution_events`, `delivery_runs`/`delivery_events`,
   `incident_interventions`, `audit_events`.
6. Copilot: credencial `verified` no projeto e ambiente; `effective_model` e consumo no run.
7. Não alterar estados por SQL para «desbloquear» tickets. Usar as ações do fluxo, a reconciliação
   ou a adoção auditada.
