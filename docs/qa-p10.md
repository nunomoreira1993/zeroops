# P10 — publicação e teste em QA

Desenvolvimento de capacidades e rollout do ZeroOps. Pressupõe P00 a P09 em QA (ver
[qa-p09.md](qa-p09.md)). Os resultados ficam no [registo de progresso](progresso-zeroops-agentico.md).

Distinguir sempre dois níveis:

- **deploy da P10**: código desta entrega, publicado com `git push qa <branch>:main`
  (`post-receive` → `deploy-from-git.sh`);
- **rollout de uma capacidade**: commit produzido por um ticket de capacidade, publicado pelo
  **operador de rollout** (`zeroops-rollout-operator`) a partir do repositório de capacidades,
  depois dos gates do fluxo. O operador avança `main` de `/opt/zeroops/repo.git` por
  `update-ref` (sem hook): não há segundo deploy.

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`). Confirmar o SHA em `/api/health`.
2. **Drenagem (sempre pelo próprio deploy).** Depois da build e antes de qualquer alteração, o
   `deploy-from-git.sh`:
   - pede a drenagem em `zeroops_runtime_drains` (044+); numa BD anterior à 044 faz uma
     «drenagem de arranque», com as mesmas condições da vista `zeroops_active_jobs`;
   - espera por 0 jobs com lease: `agent_runs`, `flow_assistant_requests`,
     `ticket_routing_jobs` e `flow_simulation_runs` em `running`; `delivery_runs` com
     `worker_id`. O prazo é de 300 s; esgotado, aborta sem alterar nada;
   - para o executor em execução (`docker compose stop executor`, paragem ordenada que devolve
     à fila o que tiver sido reclamado) e volta a contar;
   - se falhar antes da troca, volta a arrancar o executor anterior.

   Perguntas pendentes, decisões e esperas do motor não têm lease e não são afetadas. O log
   mostra `Drenagem …`/`Drenagem de arranque …`, `A parar o executor anterior`,
   `Executor parado; jobs ativos: 0` e `Drenagem concluida`.

3. **Backup.** O hook cria `/var/backups/zeroops/*.sql.gz`; validar com `gzip -t`.
4. **Publicação.** `git push qa <branch>:main`. Não correr o script manualmente a seguir.

## Migration

[044](../sql/044_capability_development_rollout.sql), aditiva e idempotente.

```sql
SELECT name FROM zeroops_migrations WHERE name LIKE '044%';
SHOW TABLES LIKE 'capability_%';
SHOW TABLES LIKE 'project_capability_settings';
SELECT COUNT(*) FROM zeroops_active_jobs;
SELECT * FROM zeroops_runtime_drains WHERE released_at IS NULL AND expires_at > NOW(3);
```

## Operador de rollout

```bash
cd /opt/zeroops/src/deploy/qa && bash install-rollout-operator.sh
systemctl status zeroops-rollout-operator --no-pager
curl -fsS http://127.0.0.1:4320/health
```

- Instala em `/usr/local/lib/zeroops` (caminho estável, não muda com o deploy), estado em
  `/var/lib/zeroops-rollout`, log em `/var/log/zeroops/rollout-operator.log`.
- `/etc/zeroops/rollout-operator.env` (0600) é criado com um segredo novo e nunca impresso. O
  mesmo segredo é configurado na pipeline do projeto, lido no host sem o mostrar.
- Origem: `ZEROOPS_ROLLOUT_SOURCE_REPO` (`/opt/zeroops/test-repos/zeroops-capabilities.git`),
  ref `main`, ambiente `quality`. O repositório de capacidades é um clone do ZeroOps no commit
  publicado; o executor vê-o em `/srv/zeroops-git`.
- Acrescentar `http://127.0.0.1:4320` a `ZEROOPS_PIPELINE_ALLOWED_ORIGINS` em
  `/etc/zeroops/zeroops.env` e recriar API/worker/executor com o mesmo
  `ZEROOPS_VERSION` (SHA completo publicado): a confirmação `available` da
  capacidade compara esta versão do runtime com o SHA integrado.

## Configuração do projeto de teste

Usar só o projeto de teste e fluxos novos «Teste P10 …». Não alterar fluxos reais do cliente.

1. Repositório Git «ZeroOps capacidades» → `zeroops-capabilities.git`, branch `main`, comandos de
   teste autorizados.
2. Pipeline «Rollout ZeroOps QA» → `http://127.0.0.1:4320`, repositório acima, ambiente
   `quality`, integração autorizada.
3. Fluxo de desenvolvimento «Teste P10 Capacidades»: desenvolvimento (PR) → review (revisor de
   teste) → entrega pela pipeline acima → fim; falha da entrega volta ao desenvolvimento.
4. Em «Pipelines» → «Capacidades»: repositório, pipeline e fluxo de desenvolvimento.
5. Permissões: um delegado com `capabilities.develop` (e `flows.edit`); `capabilities.publish`
   só para quem autoriza a publicação.

## Smoke funcional

1. No chat de autoria de um fluxo rascunho, pedir uma capacidade em falta pequena
   (`zeroops_change`). No painel «Capacidades», iniciar o desenvolvimento; repetir o pedido →
   mesmo processo e mesmo ticket.
2. Um utilizador sem `capabilities.develop` é recusado (403).
3. A ativação do rascunho devolve `FLOW_CAPABILITY_PENDING`; a edição continua possível.
4. O ticket de capacidade corre P08: workspace, testes executados, PR, review pelo revisor.
   Rejeitar uma vez, corrigir e aprovar o head atual.
5. Autorizar a publicação (`capabilities.publish`). A entrega P09 pede o rollout ao operador:
   `publishing` → drenagem → deploy → confirmação independente → `published`. Depois do
   arranque do novo executor, o processo passa a `available` (versão do runtime = SHA).
6. Associar ao rascunho: nova versão de rascunho, evento auditado, fluxo **não** ativado.
7. Confirmar que tickets anteriores, perguntas pendentes e esperas continuam intactos.
8. Integrar o commit da capacidade no repositório do ZeroOps local com `fetch`/`merge`
   (sem force) para o próximo deploy não o reverter.

## Recuperação

- **Falha antes da publicação** (SHA/ascendência/digest, build, drenagem ou backup): nada muda e
  o executor anterior volta a arrancar se tiver sido parado; a entrega fica `failed` e o processo
  volta ao percurso do fluxo.
- **Falha durante a troca**: o script repõe código e imagens anteriores; o operador confirma a
  versão anterior saudável e reporta `during_swap`. As migrations aplicadas não são desfeitas
  (todas aditivas); o backup indicado no log permite restauro manual (destrutivo: pedir
  aprovação).
- **Resultado incerto**: `reconciling` pela versão ativa e health; esgotado o limite fica com
  `outcome=uncertain` e a entrega/processo em `reconciliation_required`. Verificar
  `/api/health`, `/var/log/zeroops/deploy.log` e o log do rollout em `/var/lib/zeroops-rollout`.
- **Drenagem presa**: expira sozinha (`expires_at`); libertar manualmente com
  `UPDATE zeroops_runtime_drains SET released_at=NOW(3) WHERE released_at IS NULL`.
- **Executor parado depois de uma falha** (aviso `executor anterior nao arrancou`):
  `cd /opt/zeroops/src/deploy/docker && docker compose start executor`. Os jobs devolvidos à
  fila são retomados sem consumir tentativa.
- Parar o operador: `systemctl stop zeroops-rollout-operator` (os rollouts pendentes retomam no
  arranque, sem repetir trocas interrompidas).
