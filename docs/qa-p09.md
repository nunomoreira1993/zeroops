# P09 — publicação e teste em QA

Pipeline, integração e Health pelo fluxo. Pressupõe P00 a P08 em QA (ver
[qa-p08.md](qa-p08.md)). Os resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

Distinguir sempre dois níveis:

- **deploy do ZeroOps**: código desta entrega no host QA;
- **publicação de candidatos**: entregas de tickets de teste, feitas pelo fluxo através de
  uma pipeline do projeto. Em QA usam só o repositório sandbox e o fornecedor falso
  [`deploy/qa/p09-fake-pipeline.mjs`](../deploy/qa/p09-fake-pipeline.mjs), que não publica nada.

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação em `/opt/zeroops/src`. Confirmar o SHA
   em `deploy/qa/VERSION` e em `/api/health`.
2. **Drenagem.** Sem `agent_runs`, `flow_assistant_requests`, `ticket_routing_jobs`,
   `flow_simulation_runs` em `queued`/`running` nem `delivery_runs` por concluir (a tabela só
   existe depois da 042).
3. **Backup.** `/var/backups/zeroops/pre-p09-*.sql.gz`, validado com `gzip -t`.
4. **Configuração.** Em `/etc/zeroops/zeroops.env` (partilhado por API e executor):

   | Variável                           | Valor em QA                                     |
   | ---------------------------------- | ----------------------------------------------- |
   | `ZEROOPS_PUBLIC_URL`               | já existente (base do `callbackUrl`)            |
   | `ZEROOPS_PIPELINE_ALLOWED_ORIGINS` | `http://127.0.0.1:8787` (só o fornecedor falso) |

   Sem origens autorizadas nenhuma pipeline é aceite nem chamada.

5. **Publicação.** `git push qa <branch>:main`. O `post-receive` faz backup, migrate, build,
   compose, health e, se necessário, rollback. Não correr o script manualmente a seguir.

## Migration

[042](../sql/042_delivery_pipelines_health.sql), aditiva e idempotente: `project_pipelines`,
`delivery_runs`, `delivery_events`, `resource_locks`, e em `incident_interventions` as colunas
`resource_key`/`contract_version` e o estado `uncertain`.

```sql
SELECT name FROM zeroops_migrations WHERE name LIKE '042%';
SHOW TABLES LIKE 'delivery_%';
SHOW TABLES LIKE 'resource_locks';
SHOW COLUMNS FROM incident_interventions LIKE 'resource_key';
```

## Fornecedor de pipeline falso

Contentor descartável com a rede do host (como a stack), a escutar só em `127.0.0.1:8787`; as
callbacks vão diretamente à API local. O segredo vem de um ficheiro `0600` fora do
repositório, nunca da linha de comandos:

```bash
docker run -d --rm --name zeroops-p09-fake-ci --network host --read-only \
  --env-file /root/.zeroops/p09-fake-ci.env -e CALLBACK_ORIGIN=http://127.0.0.1:4311 \
  -v /opt/zeroops/src/deploy/qa/p09-fake-pipeline.mjs:/app/fake.mjs:ro \
  zeroops:latest node /app/fake.mjs
```

`/root/.zeroops/p09-fake-ci.env` contém `SECRET=<o mesmo segredo da pipeline>`. Controlo do
ensaio (só na rede interna): `POST /_mode {"mode":"drop"|"fail"}` para o pedido seguinte e
`GET /_stats` (pedidos, consultas e callbacks recebidas).

## Smoke funcional

Usar só o projeto de teste, `p08-sandbox.git` e fluxos novos «Teste P09 …». Não alterar
fluxos reais do cliente.

1. **Pipeline.** Em «Pipelines de entrega», criar «QA sandbox» (repositório «Sandbox P08»,
   branch `main`, ambiente `quality`, endpoint `http://127.0.0.1:8787`, integração
   autorizada). Um endpoint fora das origens é recusado; o segredo não volta a ser mostrado.
2. **Fluxo.** Desenvolvimento (PR) → review (revisor de teste) → «Entrega por pipeline»
   (pipeline e review escolhidos nos seletores) → fim; falha da entrega volta ao
   desenvolvimento. Validar e ativar.
3. **Gate de review.** Ticket A: sem aprovação a entrega não começa; aprovar o head atual.
4. **Integração.** A integra em `main` do sandbox e publica; o painel mostra candidato,
   SHA integrado, digest, pipeline e checks, e os eventos `duplicate`/`out_of_order` das
   callbacks repetidas.
5. **Revalidação.** Ticket B com a mesma base, aprovado depois de A: é integrado sobre o
   novo topo (merge) e os testes correm sobre a combinação («revalidado sobre a base atual»).
6. **Timeout.** `POST /_mode {"mode":"drop"}` antes de uma entrega: fica `uncertain`, é
   reconciliada por `GET` e o fornecedor regista **um** `POST` (`/_stats`).
7. **Health.** Só contra alvos descartáveis (ver abaixo). Nunca interromper MySQL nem outros
   serviços partilhados do QA.
8. **Rotas legadas.** Transições/decisões manuais num ticket gerido por fluxo → `FLOW_MANAGED`.

## Health em QA

As intervenções reais passam pelo relay, que só atua em unidades listadas em `ALLOWED_UNITS`.
Sem relay de QA configurado com uma unidade descartável, o ensaio Health limita-se ao fluxo em
modo de demonstração e aos testes automatizados (`incident-flow.test.ts`). Um ensaio real exige
uma unidade própria (por exemplo `zeroops-p09-dummy.service`) e autorização explícita.

## Recuperação

- Se o health falhar, o hook repõe o commit anterior. Confirmar com `/api/health` e
  `deploy/qa/VERSION`.
- O rollback de código não desfaz a 042; o código anterior ignora as tabelas novas e o estado
  `uncertain`.
- Entregas pendentes: cancelar pelo fluxo (o executor envia `cancel` ao fornecedor) ou deixar
  o lease expirar. Locks expiram sozinhos (`resource_locks.expires_at`).
- Parar o fornecedor falso: `docker stop zeroops-p09-fake-ci`.
- Para repor dados, usar o backup `pre-p09-*` (operação destrutiva: pedir aprovação explícita).
