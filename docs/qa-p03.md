# P03 — publicação e teste em QA

Jobs, leases e política efetiva de ferramentas. Pressupõe P00/P01/P02 em QA
(ver [qa-p02.md](qa-p02.md)). Resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação `/opt/zeroops/src`, repo
   bare `/opt/zeroops/repo.git`; confirmar o SHA em `deploy/qa/VERSION` e
   `/api/health`.
2. Drenagem: nenhuma linha `agent_runs` ou `flow_assistant_requests` em
   `running`. Os jobs `queued` são preservados e passam a ser reclamados pelo
   novo executor. Um executor antigo que seja parado a meio deixa `running` sem
   lease: a 036 deixa `lease_until` a `NULL`, e a recuperação do novo executor
   trata-os como expirados (requeue até `maxAttempts`).
3. Backup independente em `/var/backups/zeroops/pre-p03-*.sql.gz` (gzip,
   SHA-256, `gzip -t`), além do backup do próprio script de deploy.
4. Publicar por fast-forward de `main` no remoto `qa`; o `post-receive` chama
   `deploy/qa/deploy-from-git.sh` uma vez. Não lançar o script manualmente em
   seguida (deploy duplicado).

## Configuração e migration

- [036](../sql/036_agent_job_leases.sql), aditiva e idempotente: colunas
  `worker_id`, `lease_epoch`, `lease_until`, `heartbeat_at` e `attempt` em
  `agent_runs`/`flow_assistant_requests`; `tool_calls_used` em `agent_runs`;
  `lease_epoch` em `agent_run_tool_calls`; tabela `agent_job_events`.
- Variáveis opcionais do executor (`deploy/docker/compose.yml`, valores por
  omissão conservadores): `ZEROOPS_WORKER_ID` (por omissão
  `hostname:pid:uuid`), `ZEROOPS_JOB_LEASE_SECONDS=90`,
  `ZEROOPS_EXECUTOR_RUN_CONCURRENCY=1`,
  `ZEROOPS_EXECUTOR_ASSISTANT_CONCURRENCY=1`,
  `ZEROOPS_JOB_PROJECT_RUN_LIMIT=2`, `ZEROOPS_EXECUTOR_DRAIN_MS=20000`;
  `stop_grace_period: 45s`.

## Verificação técnica

```sql
SELECT name, checksum FROM zeroops_migrations WHERE name LIKE '036%';
SELECT status, worker_id, lease_epoch, lease_until, heartbeat_at, attempt FROM agent_runs
 ORDER BY created_at DESC LIMIT 5;
SELECT event_type, job_kind, worker_id, attempt, lease_epoch, created_at FROM agent_job_events
 ORDER BY id DESC LIMIT 20;
```

Nos logs do executor tem de aparecer `executor.started`, com `workerId`, as
concorrências e o lease.

## Smoke funcional

Usar um projeto e um ticket de teste.

1. Pedir uma investigação Copilot: o run passa a `running` com `worker_id` e
   `lease_until` no futuro, e `heartbeat_at` avança periodicamente (os
   heartbeats não geram eventos, para não encher a tabela). Aparecem os eventos
   `claimed` e depois `completed`. O ticket recebe uma única nota.
2. Enquanto o run decorre, usar o assistente de fluxos no mesmo projeto. Tem de
   responder (pool `assistant` separado do pool `runs`).
3. Cancelar um run em curso: passa a `cancelled`, sem nota de resultado, e fica
   registado o evento `cancel_requested`.
4. Reiniciar o executor (`docker compose restart executor`) com um run ativo:
   o executor drena, liberta o job (`released`, sem consumir tentativa) e o novo
   processo volta a reclamá-lo. Os jobs vivos de outro worker não são falhados.

Não fazer ensaios de falha (kill -9, leases forçados) sobre trabalho real do QA.

## Recuperação

- O script repõe o código e as imagens anteriores se o build, a migration ou o
  health falharem.
- A 036 é aditiva: o código anterior ignora as colunas novas. Ao voltar ao
  código anterior, o arranque antigo volta a chamar `failInterrupted`. Antes do
  rollback, drenar os runs em curso.
- A BD não é restaurada automaticamente. Não fazer `DROP`. Restaurar só com
  autorização específica e o backup verificado.
