# P11 — publicação e validação em QA

Migração final e operação. Pressupõe P00–P10 em QA (ver [qa-p10.md](qa-p10.md)). As evidências
estão no [registo de progresso](progresso-zeroops-agentico.md) e os procedimentos de operação em
[operacao-zeroops-agentico.md](operacao-zeroops-agentico.md).

Usar só o projeto de teste «Teste P11 Operação» e os utilizadores `p11-*@zeroops.invalid`. Não
alterar fluxos, políticas nem integrações reais do cliente.

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`). `curl -fsS http://127.0.0.1:4311/api/health` →
   versão atual.
2. Inventário antes do deploy (só leitura), para comparar depois:

   ```sql
   SELECT p.name, COUNT(DISTINCT t.id) tickets, COUNT(DISTINCT e.id) execucoes
     FROM projects p LEFT JOIN tickets t ON t.project_id=p.id
     LEFT JOIN flow_executions e ON e.ticket_id=t.id GROUP BY p.name;
   SELECT COUNT(*) FROM flow_versions;
   SELECT COUNT(*) FROM zeroops_active_jobs;
   ```

3. A publicação faz drenagem e backup (`deploy-from-git.sh`). Não correr o script à mão a seguir.

## Publicação

```bash
git push qa feat/p11-migration-operation          # não publica
git push qa feat/p11-migration-operation:main     # drenagem → backup → migrations → health
```

Confirmar no output `OK: <sha> ativo` (o `git push` pode terminar com código 1 por causa do
stderr remoto). Depois:

```sql
SELECT name FROM zeroops_migrations WHERE name LIKE '045%';
SHOW TABLES LIKE 'ticket_flow_adoptions';
```

Repetir o inventário: contagens iguais (mais os tickets de teste criados no ensaio).

## Migration

[045](../sql/045_ticket_flow_adoptions.sql), aditiva e idempotente. Regista a adoção ou a exclusão
explícita de tickets antigos sem execução. Não altera tickets, versões nem execuções existentes.
Repor o código anterior não a desfaz e não é necessário: o código anterior não a lê.

## Smoke

Comandos `ops` dentro de `/opt/zeroops/src/deploy/docker` (ver o runbook):

1. `ops migration-inventory --as <admin>`: contagens por projeto; `ticketsWithoutExecution`.
2. `ops flow-adoption --as <admin>`: dry-run com candidatos e hash. Sem `--apply` nada muda.
3. `ops retention --all-projects --as <admin>`: seleção e hash. Aplicar só a recursos de teste.
4. Rotas legadas num ticket gerido por fluxo (`workflow.transition`/`decide`, governança) →
   `409 FLOW_MANAGED`.
5. Página «Operação» do projeto de teste: filas, etapas, leases, perguntas, Copilot, pipelines,
   operações incertas e Health (validação confirmada / não confirmada / telemetria
   desconhecida).

## Ensaios no projeto de teste

- **Health (cenário D)**: alertas pelo recetor real correlacionados num incidente; sem telemetria
  → `unknown` → escalada. Fluxos demo com intervenção simulada e recuperação confirmada.
- **Desenvolvimento (cenário B)**: repositório «Sandbox P11» (`p08-sandbox.git`), fluxo «Teste
  P11 Desenvolvimento» (dev PR → review do técnico → fim). Copilot real, review pelo técnico;
  admin fora dos revisores → `FORBIDDEN`; SHA errado → `REVIEW_ARTIFACT_CHANGED`.
- **Isolamento e permissões**: utilizadores de T sem acesso ao projeto Pizza Hut e vice-versa;
  revogação de permissão com efeito na operação seguinte.
- **Credenciais**: revogar a credencial Copilot de T, testar (sem reativação), gravar nova versão,
  testar (`verified`) e correr um run real.
- **Recuperação**: matar o executor durante um run → lease expira → tentativa 2 → `succeeded`;
  segundo executor não falha jobs vivos.
- **Concorrência**: medir CPU/RAM/duração com limites diferentes num executor temporário,
  repondo no fim os valores de `/etc/zeroops/zeroops.env`.

## Recuperação

Igual a [qa-p10.md](qa-p10.md#recuperação). Em particular:

- falha de rollout → código e imagens anteriores repostos pelo hook; a 045 fica (aditiva);
- dados criados no ensaio ficam no projeto de teste; não restaurar o backup para os apagar;
- concorrência alterada no ensaio: repor `ZEROOPS_EXECUTOR_*_CONCURRENCY` e recriar o executor
  com o mesmo `ZEROOPS_VERSION`.
