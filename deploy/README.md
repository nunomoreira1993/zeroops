# Operacao ZeroOps

Consultar tambem a [arquitetura na infraestrutura Pizza Hut](./arquitetura-pizzahut.md). O deployment em Qualidade foi verificado anteriormente no host `uqphorders24-dev`, mas nao foi revalidado nesta revisao; esta nota nao autoriza nem confirma acesso a Produção.

## Login interativo em Qualidade

Em PowerShell, num terminal controlado pelo operador:

```powershell
& 'C:\devtools\httpdocs\ai-tools\ZeroOps\deploy\quality-login.ps1'
```

O script pede o utilizador individual autorizado e abre SSH para o IP QA indicado, `192.168.90.79`. Reutiliza chave/agent quando disponivel; se o servidor pedir password, introduzi-la apenas no prompt SSH. Nao aparece texto enquanto se escreve. Nao criar ficheiros com passwords, nao usar a conta root partilhada e nao colocar credenciais em argumentos ou no chat.

O hostname QA verificado e `uqphorders24-dev`; confirmar sempre `hostname`, `pwd` e `id` antes de uma operacao remota. O alias SSH local `pizzahut-analise` aponta para Producao, nao para este alvo QA. Os procedimentos nesta pasta sao exclusivos de Qualidade.

Para inspecionar o comando sem iniciar qualquer ligacao:

```powershell
& 'C:\devtools\httpdocs\ai-tools\ZeroOps\deploy\quality-login.ps1' -UserName 'utilizador_individual' -PrintCommand
```

Se a politica PowerShell impedir a execucao, nao a contornar; executar o comando `ssh.exe` apresentado pelo script/operador diretamente num terminal autorizado. Falta de conta individual ou rejeicao de autenticacao exige intervencao da infraestrutura, nao guardar a password na aplicacao.

## Identidade e SMTP

A implementacao local inclui TOTP, bloqueio de contas, recuperacao, convites e administracao de acessos. Configuracao/entrega no destino ainda exigem validacao privada; nenhum SMTP real de qualidade/producao foi contactado durante os testes.

- Aplicar `npm run migrate` antes de iniciar a nova API/worker, apenas num destino identificado e autorizado. Neste checkout existem `001_baseline.sql` a `006_notification_delivery_state.sql`; referências antigas a migrações `007`–`013` não correspondem a ficheiros presentes e não devem ser usadas como instruções de deployment. O baseline `001` contém o schema-base; antes de atualizar uma base persistente, reconciliar o seu diário/checksums e schema com estes ficheiros. Não criar ou aplicar migrações em PH com base apenas nesta documentação.
- Em instalações existentes, designar o administrador da instância explicitamente por terminal privado com `npm run identity:designate-instance-admin`; não atribuir esse privilégio durante a migração.
- Versionar os scripts SQL e o codigo ZeroOps em Git. O repositorio local foi inicializado, mas remote privado e CI ainda nao estao configurados; nao foi feito commit nem push.
- `ZEROOPS_IDENTITY_KEY`: chave privada de 32 bytes em base64 para AES-256-GCM; configurar igual na API e worker. Nao guardar no checkout, BD, chat ou argumentos. A perda da chave impede decifrar TOTP e emails pendentes. A rotacao requer re-encriptacao controlada dos segredos TOTP e tratamento da fila; nao trocar a chave nem apagar os fatores por conveniencia.
- `ZEROOPS_PUBLIC_URL`: origem publica verificada e usada nas ligacoes, HTTPS fora de loopback.
- SMTP: `ZEROOPS_SMTP_HOST`, `ZEROOPS_SMTP_PORT`, `ZEROOPS_SMTP_FROM`, `ZEROOPS_SMTP_SECURE`, `ZEROOPS_SMTP_REQUIRE_TLS`, `ZEROOPS_SMTP_ALLOW_INSECURE_LOOPBACK`, `ZEROOPS_SMTP_USER`, `ZEROOPS_SMTP_PASSWORD`.
- `ZEROOPS_ENVIRONMENT`: `quality` ou `production`, obrigatório fora de loopback. `ZEROOPS_SMTP_ALLOWED_ENDPOINTS`: allowlist operacional externa, separada por vírgulas, no formato `host:porta`; não contém passwords.
- A configuração SMTP da instância pode ser guardada pela interface, cifrada com a chave externa. Testar só contactos SMTP allowlisted, sem enviar email de teste; o resultado comprova ligação/autenticação, não entrega à inbox. API e worker consultam a versão verificada na BD. Alterar/rodar regressa a rascunho; revogar remove o ciphertext e bloqueia a utilização.
- As variáveis SMTP existentes são apenas bootstrap quando ainda não existe configuração SMTP na BD para o ambiente. Uma configuração em rascunho/revogada não usa o bootstrap como fallback. Guardar uma configuração não ativa GenOps; os probes dos restantes conectores continuam indisponíveis até validação própria.
- Host/remetente obrigatorios; porta por defeito 25, secure=false e requireTLS=true. Verificacao de certificados permanece ativa. Transporte sem TLS so e permitido por configuracao explicita de loopback e requireTLS=false, apos verificar que esse relay e autorizado.
- Localhost refere-se ao host do worker, nao a maquina do browser. Nao assumir que o relay local de desenvolvimento existe em qualidade.
- API/worker precisam dos acessos privados adequados. Nao inventar configuracao SMTP, destinatarios nem credenciais. Validar um destinatario autorizado apos parametrizacao privada.

Emails de identidade ficam numa fila privada cifrada, separados da outbox funcional. Estado `delivered` significa aceite pelo relay, nao chegada a inbox. Expiracao/revogacao sao verificadas antes do envio. Falhas/blocked podem ser revistas e repetidas quando elegiveis; `uncertain` exige reconciliacao e nao e repetido automaticamente.

Contas privilegiadas existentes sem MFA precisam de inscricao no proximo login; sessoes legadas sem prova MFA nao sao aceites. Organizacoes antigas ficam por confirmar, sem inferencia pelo perfil. O primeiro administrador deve concluir a inscricao e guardar codigos de recuperacao em canal privado.

Perda de MFA: administrador autenticado recentemente pode iniciar reposicao de OUTRA conta apos verificar identidade por procedimento humano e registar motivo. Nao pode repor o proprio fator. Se apenas existir um administrador e nao houver fator/codigos utilizaveis, usar procedimento operacional privado com aprovacao, auditoria, revogacao e nova inscricao; nunca ativar um bypass publico ou editar uma password pela UI.

Nao reiniciar ou eliminar a base temporaria de uma preview existente para atualizar esta entrega. Validar migracoes numa base isolada; atualizar uma instancia persistente somente apos identificar o destino e preservar os dados.

Registo histórico de validação local: `npm run validate` passou numa execução anterior; os contadores e a configuração remota abaixo não foram reproduzidos nesta revisão. Nenhum teste desta revisão enviou emails, acedeu a PH ou aplicou migrações remotas. A shell QA foi validada anteriormente sem iniciar ligação SSH. Estes registos não validam um servidor remoto nem a aplicação das migrações num destino persistente.

A verificacao Prettier passou para os ficheiros alterados, incluindo funcionalidades, arquitetura e documentacao operacional.

## Deploy em Qualidade por git push (implementado)

```powershell
cd C:\devtools\httpdocs\ai-tools\ZeroOps
git push qa main   # remote qa = pizzahut-qa:/opt/zeroops/repo.git
```

O hook `deploy/qa/post-receive` (instalado com `deploy/qa/install-git-deploy.ps1`) corre `deploy/qa/deploy-from-git.sh`: exporta o commit, constroi as imagens, faz backup da BD do ZeroOps (`/var/backups/zeroops`), aplica as migracoes de `sql/`, arranca os servicos e verifica o health; no fim limpa imagens antigas e limita a cache de build do Docker a 3 GB (sem limite chegou a 23 GB e encheu o disco de QA). Se a build falhar nada muda; se migracao, arranque ou health falharem, repoe o codigo e as imagens anteriores (a BD restaura-se manualmente a partir do backup). O resultado fica em `/var/log/zeroops/deploy.log` e a versao publicada aparece no health da API. Uma falha do hook nao rejeita o push: confirmar sempre o log. `deploy/docker/qa-deploy.ps1` continua disponivel como alternativa manual.

## Investigacao com Copilot em Qualidade (implementado)

Servicos Compose (`deploy/docker/compose.yml`): `api`, `worker`, `connectors` (127.0.0.1:4312) e `executor`. O deploy (`deploy/docker/qa-deploy.ps1`) constroi as imagens, aplica migracoes e arranca os quatro.

Configuracao, toda na pagina **Integracoes** (projeto Pizza Hut, ambiente Qualidade), seguida de **Testar ligacao** em cada uma:

| Integracao  | Valores em QA                                                           |
| ----------- | ----------------------------------------------------------------------- |
| `DATABASE`  | host `127.0.0.1`, porta `3306`, base e utilizador do site (`db.config`) |
| `TELEMETRY` | `http://127.0.0.1:3100` (Loki); seletor opcional, ex. `{job="php"}`     |
| `COPILOT`   | token GitHub com licenca Copilot; modelo opcional                       |

So integracoes no estado verificado chegam ao executor/conectores. Executor: Copilot CLI com uid 1000, `/work` e `/home/node` em tmpfs, pacote do Copilot pre-extraido em `/opt/copilot-cache`, codigo de cada site em `/sources/<site>` (`pizzahut`, `pizzamovil`; so leitura) com `lib/db.config.credentials*.php` e `api*/api.parceiros.class.php` vazios; cada run usa o site do projeto do ticket (`ZEROOPS_AGENT_SITES_ROOT`). O agente so consegue consultar dados via `zo-sql`/`zo-loki`, com o token do run.

A API recebe a raiz `/sources` em read-only (`ZEROOPS_AGENT_SITES_ROOT`) e os binds `ZEROOPS_SITE_SOURCES`/`ZEROOPS_PIZZAMOVIL_SOURCES` montam, respetivamente, em `/sources/pizzahut` e `/sources/pizzamovil`. Cada origem tem de ser a arvore do projeto que contem `AGENTS.md`, `.github/agents`, instrucoes e skills; se o webroot nao contiver estes ficheiros, configure o bind para a arvore correta. Credenciais mantem-se mascaradas e apenas os caminhos tecnicos allowlisted aparecem no catalogo. As instrucoes globais sao sempre fixadas; ate tres recursos adicionais sao carregados por relevancia por etapa, alem dos selecionados no flow. Hashes SHA-256 identificam conteudos, nao revisoes SVN. Recursos obrigatorios ou instrucoes globais nao legiveis bloqueiam a execucao com perfil. Aplicar `sql/030_zeroops_agent_profiles.sql` antes de usar o catalogo.

Conversa interativa: por omissao o executor usa o `@github/copilot-sdk` (1.0.30, emparelhado com o CLI 1.0.108 da imagem) e lanca o runtime atraves de `/usr/local/bin/zo-copilot-agent` (`setpriv` para o uid do agente). O ticket mostra o streaming, as ferramentas/MCP e as perguntas do agente; a equipa responde e envia mensagens na propria pagina. Variaveis no `compose.yml`: `ZEROOPS_COPILOT_TRANSPORT` (`sdk`/`cli`), `ZEROOPS_AGENT_QUESTION_TIMEOUT_MS` (600000) e `ZEROOPS_AGENT_FOLLOWUP_MS` (120000, espera por mensagens de seguimento antes de fechar o run).

Validacao focada do canal interativo, sem token nem fontes externas:

```powershell
npx vitest run tests\integration\http.test.ts apps\executor\src\copilot-sdk.adapter.test.ts packages\backend\src\modules\agents\agent-run-events.service.test.ts
npx vitest run --root apps\web --config vitest.config.ts tests\agent-run-live.test.tsx tests\agent-run-timeline.test.tsx
```

O teste HTTP usa API, SSE e MariaDB reais e uma sessao SDK **simulada**: verifica streaming antes da resposta, eventos MCP, perguntas, aprovacao do plano, seguimento, CSRF e retoma por `Last-Event-ID`. Os testes da interface verificam os formularios e o fallback a polling. Nao comprovam autenticacao Copilot, ligacoes a MCP externos nem uma investigacao real em QA; essa validacao exige a integracao Copilot verificada e uma sessao da equipa com MFA.

Verificacao rapida no servidor:

```bash
cd /opt/zeroops/src/deploy/docker
docker compose ps
curl -fsS http://127.0.0.1:4312/v1/health
docker compose logs --tail 50 executor connectors
```

## Fluxos de resolucao (implementado)

Migracao `sql/024_ticket_flows.sql` (tabelas `flows`, `flow_versions`, `flow_executions`, `flow_execution_steps`, `flow_decisions`, `flow_execution_events`, `flow_assistant_requests`). Nao e preciso configurar nada para manter o comportamento anterior: na primeira visita/ticket de cada projeto sao criados os fluxos _Geral_ (por omissao) e _Saude_ publicados, e _Manutencao de cliente_ em rascunho.

- `worker`: periodicamente chama `tick` (verificacoes com prazo, etapas Copilot orfas); no arranque atualiza os fluxos Saude ainda iguais ao modelo anterior (`flows.templates_upgraded`; nova versao, tickets em curso mantem a sua). Desde P11 ja nao faz `backfill`: tickets antigos sem execucao so entram num fluxo por adocao explicita e auditada (`ops flow-adoption`, abaixo).
- `executor`: alem dos runs do Copilot, consome `flow_assistant_requests` (assistente do fluxo e do ticket) sem ferramentas de escrita nem shell; pedidos interrompidos ficam `failed` e podem ser repetidos. Etapas `develop` devolvem um diff gerado a partir dos ficheiros copiados para o workspace (no modelo Saude, a etapa «Copilot tenta a correcao»).

Acoes que dependem de integracao por configurar: aplicar no ambiente a correcao da Saude (o Copilot ja prepara o diff numa copia temporaria; sem integracao `health_remediation` segue por «indisponivel») e deploy (`deploy` segue por «manual» e espera confirmacao do responsavel de release).

Validacao focada:

```powershell
npx vitest run packages\backend\src\modules\flows apps\executor\src\unified-diff.test.ts
```

## Saude e alarmistica (implementado)

Pagina **Saude** (`https://tickets.pizzahut.pt/#health`). Migracao `sql/004_health_monitoring.sql`. O `worker` corre um ciclo por minuto em cada projeto com a monitorizacao ativa.

1. Em **Integracoes** (ambiente de origem, por omissao Producao): `DATABASE` so de leitura e `TELEMETRY` (Loki) verificados.
2. Em **Saude → Configuracao**: URLs do site/app/APIs, paragens planeadas (janelas diarias em que as verificacoes escolhidas nao abrem alertas nem enviam lembretes; se o problema continuar, o alerta abre quando a janela fecha), listas de destinatarios (nome + e-mails) e encaminhamento (defaults por criticidade, relatorio e override por alarme), limites, ativar.
3. **Gerar token do agente** e instalar `deploy/health-agent` no servidor do site (ver o README dessa pasta; Producao exige aprovacao).
4. **Executar agora** / **Enviar relatorio** para validar; o estado de cada envio fica em `health_notifications`.

Valores Pizza Hut: `siteUrl=https://encomendar.pizzahut.pt/pt/`, `appUrl=https://encomendar.pizzahut.pt/app/`, `apiUrls=[https://encomendar.pizzahut.pt/api-public/v1/]`. Nao usar `/api/v1/`: a raiz responde 500 por desenho e gera falsos alarmes. Paragem planeada «Paragem noturna do IBM i» das 00:30 as 07:30 (Europe/Lisbon), todos os dias, para `site-availability`, `app-api-availability`, `response-time`, `application-errors`, `auth-failures`, `scheduled-jobs`, as regras `Db2*`, `Dtq*`, `SiteIndisponivel` e `RespostaLenta` e a sonda `probe:dtq` (o IBM i desliga das 01:00 as 07:00).

### Heartbeats dos crons Pizza Hut

`deploy/health-agent` inclui um wrapper e instalador root para os crons HTTP Pizza Hut. O plano/aplicação altera apenas as entradas da crontab root que chamam os endpoints permitidos; comandos, horários, utilizador, redirecionamentos e duplicados mantêm-se. Entradas de outros sites, tarefas de sistema e rotação/limpeza não são selecionadas nem impressas.

O wrapper guarda tentativa, exit code, falha e resposta HTTP em estado privado fora do webroot; não guarda corpos nem segredos, não repete o comando e não acrescenta timeout. Sem contrato funcional comum, HTTP 2xx é apresentado apenas como **conclusão HTTP**, nunca sucesso de negócio. Os prazos são por tarefa e incluem fuso `Europe/Lisbon`, pausas, tolerância e primeira execução pendente; o formato legado continua aceite pelo coletor.

O backend/worker ZeroOps tem de reconhecer o contrato estendido antes de ativar o agente novo. O instalador exige plano sem alterações na crontab, cria backups privados e só restaura se não houver alterações posteriores. Instalar e validar execuções naturais; nunca chamar URLs de negócio manualmente. Sem alteração de schema, não há migração SQL nesta entrega.

SMTP (o mesmo do site, `smtp_def`): Postfix local `localhost:25`, sem autenticacao, remetente `noreply@pizzahut.pt`. Exige `ZEROOPS_SMTP_ALLOWED_ENDPOINTS=localhost:25` em `/etc/zeroops/zeroops.env` (os contentores usam a rede do host).

### CLI de operacao (`ops.js`)

Para configurar sem browser. Cada comando exige um administrador existente (`--as`), fica auditado (`ops.cli`) e usa uma sessao/confirmacao de 2 minutos apagada no fim.

```bash
cd /opt/zeroops/src/deploy/docker
ops() { docker compose exec -T api node dist/apps/api/src/ops.js "$@"; }
ops smtp --host localhost --port 25 --from noreply@pizzahut.pt --loopback-plain --as admin@exemplo.pt
ops metrics --url http://127.0.0.1:9090 --matchers 'env="quality"' --environment quality --as admin@exemplo.pt
ops health-settings --file /caminho/no/contentor/health.json --as admin@exemplo.pt
ops agent-token --out /tmp/token.env --as admin@exemplo.pt   # ZEROOPS_TOKEN=..., modo 600
ops health-run --as admin@exemplo.pt
ops health-report --as admin@exemplo.pt
# P11 (ver docs/operacao-zeroops-agentico.md): so leitura / dry-run por omissao
ops migration-inventory --as admin@exemplo.pt
ops flow-adoption --as admin@exemplo.pt                          # dry-run: candidatos + hash
ops flow-adoption --disposition exclude --tickets ID --reason "fora do fluxo" --apply --expect HASH --as admin@exemplo.pt
ops retention --all-projects --as admin@exemplo.pt              # dry-run: selecao + hash
ops retention --all-projects --apply --expect HASH --as admin@exemplo.pt
```

`retention` usa `ZEROOPS_RETENTION_JOB_EVENTS_DAYS` (180), `ZEROOPS_RETENTION_SIMULATIONS_DAYS` (90), `ZEROOPS_RETENTION_OUTBOX_DAYS` (180) e `ZEROOPS_RETENTION_RUN_DELTAS_DAYS` (30) do ambiente da API (`0` desativa). O `--expect` tem de ser o hash do dry-run imediatamente anterior; se a selecao mudar, nada e removido.

O primeiro administrador cria-se num terminal interativo (a password nunca passa por argumentos):

```bash
docker compose run --rm -it api node dist/apps/api/src/bootstrap.js
```

Sem SMTP valido os e-mails ficam `blocked` (`smtp_not_configured`); SMS e chamada ficam `blocked` (`channel_not_configured`) ate existir fornecedor.

### Observabilidade (Prometheus/Alertmanager)

Configuracao em `deploy/observability/`; servicos `prometheus`, `alertmanager`, `node-exporter`, `redis-exporter`, `mysqld-exporter` e `blackbox-exporter` no `compose.yml`, todos em `127.0.0.1`. O deploy recria-os apos o health check (falhas nao revertem a aplicacao). Preparacao unica no servidor (root):

- `/etc/zeroops/observability.env` (600): `MYSQLD_EXPORTER_PASSWORD` do utilizador `zeroops_exporter@127.0.0.1` (`PROCESS, REPLICATION CLIENT, SELECT`, `MAX_USER_CONNECTIONS 3`) e `REDIS_PASSWORD`.
- `/etc/zeroops/observability/alertmanager-token` (dono 65534, 400): o token `zoh_` do agente de saude; sem ele o Alertmanager nao arranca.
- `/etc/zeroops/observability/projects/<site>` (ex.: `pizzamovil`; dono 65534, 400): token `zoh_` do agente de saude desse projeto; recebe os alertas com a label `project="<site>"` (ver `observability/alertmanager.yml`). Sem o ficheiro esses alertas falham a entrega (os restantes nao sao afetados).
- Integracao Metricas: `ops metrics --url http://127.0.0.1:9090 --matchers 'env="quality"' ...`.
- Producao envia as metricas por remote write (`deploy/production-metrics/`): Prometheus em modo agente -> `POST /api/monitoring/remote-write` (token `zoh_` do agente de saude, corpo snappy/protobuf ate 4 MB) -> Prometheus local (`--web.enable-remote-write-receiver`, `ZEROOPS_PROMETHEUS_WRITE_URL`, por omissao `http://127.0.0.1:9090/api/v1/write`; vazio desliga). Integracao Metricas de Producao: o mesmo URL com `--matchers 'env="production"' --environment production`.

Alertas `critical`/`page` abrem ticket automatico; `warning`/`info` so notificam.

## Separacao obrigatoria

1. Base MySQL/MariaDB, utilizador e armazenamento exclusivos do ZeroOps.
2. API em loopback atras de HTTPS; apenas o frontend compilado e as rotas publicas devem ser publicados.
3. Executor sem sudo, sockets do runtime de containers, credenciais de bases reais, mounts de outros sites ou acesso livre a rede.
4. Operador de publicacao distinto do executor, com destinos/path/revisao permitidos e aprovacao humana atual.
5. Conector de leitura distinto, com permissoes de BD reais de leitura, limites de consulta e contexto saneado.

O contrato `SandboxProcess` do executor nao e uma implementacao de isolamento. Uma implementacao real tem de ser validada com quotas, isolamento de filesystem/processos e egress permitido. Nunca substituir esse contrato por um `spawn` irrestrito na conta do site.

O resultado do Copilot e uma proposta de ficheiros/testes. `verifiedTests: false` e intencional: outro componente deve executar os testes autorizados e comparar a baseline antes de chamar o registo interno de candidato. Este registo nao e exposto ao browser.

## Copilot

- Usar CLI oficial, versao fixada e autenticacao permitida pela organizacao.
- Validar termos/licenca e quais os conteudos que podem sair do ambiente. Uma subscricao pessoal nao autoriza partilhar a conta com todos os clientes.
- Nao enviar dados de producao, segredos, ficheiros de configuracao privada ou dumps ao modelo.
- Rever os hooks, plugins, MCP e instrucoes carregados. As ferramentas disponiveis na linha de comando nao substituem a sandbox.
- Provar o contrato JSONL/relatorio e o uso num workspace sem Git antes da ativacao.

## Publicacao Pizza Hut

Ainda nao existe operador de producao ativado nesta entrega. Antes de o implementar/ativar:

- Confirmar host, caminho absoluto e `svn info` no destino remoto.
- Inspecionar `svn status` e `svn diff`; nao limpar alteracoes ou adicionar ficheiros ambiguos.
- Vincular aprovacao ao manifesto, revisao SVN, SQL, destino e provas de QA.
- Comparar a diferenca completa ate a revisao pedida; `svn update -r` pode incluir alteracoes anteriores.
- Nao atualizar toda a working copy ou HEAD por conveniencia.
- Gerar e rever scripts SQL, backup/restauro e estrategia de compatibilidade.
- Publicar so o artefacto aprovado e verificar o resultado no destino.
- Operacoes com resultado incerto ficam bloqueadas para reconciliacao, sem repeticao cega.

Rollback de codigo nao equivale a rollback de BD. Nao automatizar reversoes destrutivas.

## Antes de acesso publico

- MFA para funcoes privilegiadas e recuperacao segura de conta operacional.
- SMTP/entrega de convites e outbox testados; nao marcar email como enviado sem transporte real.
- Armazenamento privado e verificacao/quarentena de anexos.
- DNS, TLS, firewall, politica de cookies e CSRF verificados no hostname definitivo.
- Rate limiting validado no reverse proxy e com o modelo real de IPs.
- Testes de isolamento por recurso/projeto, restore de MySQL/MariaDB e limites de capacidade.
- Retencao de dados/anexos/evidencias aprovada e donos dos papeis identificados.

Logs aplicacionais em stdout/journal ou ficheiros fixos em append. Rotacao e compressao pertencem ao sistema/logrotate, nao a PHP. Nao alterar os paths oficiais de logs Pizza Hut para instalar a plataforma.

Nenhum valor de configuracao ou comando neste documento confirma que qualidade ou producao foram alteradas.
