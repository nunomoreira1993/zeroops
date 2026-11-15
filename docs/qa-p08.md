# P08 — publicação e teste em QA

Workspace Git, desenvolvimento e review dinâmico. Pressupõe P00 a P07 em QA
(ver [qa-p07.md](qa-p07.md)). Os resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação em `/opt/zeroops/src`.
   Confirmar o SHA em `deploy/qa/VERSION` e em `/api/health`.
2. **Drenagem.** Não pode haver `agent_runs`, `flow_assistant_requests`,
   `ticket_routing_jobs` nem `flow_simulation_runs` em `queued`/`running`.
3. **Backup.** Backup independente em `/var/backups/zeroops/pre-p08-*.sql.gz`,
   validado com `gzip -t`.
4. **Repositório de teste.** Os repositórios aceites ficam em
   `/opt/zeroops/test-repos` (montado em `/srv/zeroops-git`; só leitura na
   API). Criar um repositório bare isolado, nunca uma cópia do código do
   cliente:

   ```bash
   install -d -m 0755 /opt/zeroops/test-repos
   git init --bare -b main /opt/zeroops/test-repos/p08-sandbox.git
   # semear com app.js + test.js (node test.js) a partir de um clone temporário
   ```

5. **Publicação.** Fast-forward de `main` no remoto `qa`
   (`git push qa feat/p08-git-workspace-review:main`). O `post-receive` faz
   backup, migrate, build (a imagem passa a incluir `git`), compose, health e,
   se necessário, rollback. Não correr o script manualmente a seguir.

## Configuração

Valores por omissão no `compose.yml` (só alterar no `.env` se necessário):

| Variável                               | Omissão                       |
| -------------------------------------- | ----------------------------- |
| `ZEROOPS_DEV_ALLOWED_REPO_ROOTS`       | `file:///srv/zeroops-git/`    |
| `ZEROOPS_DEV_TEST_REPOS` (host)        | `/opt/zeroops/test-repos`     |
| `ZEROOPS_DEV_WORKSPACES` (executor)    | `/var/lib/zeroops/workspaces` |
| `ZEROOPS_DEV_WORKSPACE_RETENTION_DAYS` | `14`                          |

Sem raízes autorizadas nenhum repositório é aceite. A instância QA permite
explicitamente `https://github.com/Deloitte-Portugal/` para esta validação;
isto autoriza URLs, mas não concede credenciais nem acesso GitHub. Cada recurso
continua a exigir a credencial e as permissões adequadas. O hook de deploy lê
`/etc/zeroops/zeroops.env` também para a interpolação do Compose, preservando
esta allowlist nas publicações seguintes.

## Migration

[041](../sql/041_development_workspaces.sql), aditiva e idempotente: seis
tabelas novas e `agent_runs.development_workspace_id`.

```sql
SELECT name, checksum FROM zeroops_migrations WHERE name LIKE '041%';
SHOW TABLES LIKE 'development_%';
SHOW TABLES LIKE 'project_git_repositories';
SHOW COLUMNS FROM agent_runs LIKE 'development_workspace_id';
```

```bash
docker exec zeroops-executor-1 git --version
docker exec zeroops-executor-1 ls -ld /var/lib/zeroops/workspaces /srv/zeroops-git
```

## Smoke funcional (browser)

Usar só o projeto de teste, o repositório `p08-sandbox.git` e um fluxo novo
«Teste P08 …». Não alterar fluxos reais do cliente.

1. **Repositório.** Em «Repositórios», criar
   `file:///srv/zeroops-git/p08-sandbox.git` (base `main`, teste
   `node test.js`) e «Verificar»: mostra o SHA base. Uma URL fora das raízes
   é recusada.
2. **Fluxo.** Etapa Copilot com desenvolvimento (repositório, publicação
   «Pull request») → etapa de review (revisores, regra, `sourceNode`) →
   fim; falha do review volta ao desenvolvimento. Validar e ativar.
3. **Desenvolvimento.** Criar um ticket de teste: o run do Copilot trabalha
   no worktree isolado; o painel «Desenvolvimento» mostra workspace/job,
   base/head, diff completo, testes executados com SHA e o PR interno.
4. **Rejeição.** Um revisor configurado rejeita com feedback: o fluxo
   regressa ao desenvolvimento no mesmo workspace e PR; o novo head invalida
   a decisão anterior («head alterado»).
5. **Aprovação.** Um utilizador fora dos revisores (incluindo admin sem
   override) não pode decidir; o revisor aprova o head atual e o fluxo
   avança. A ausência de pipeline P09 aparece como indisponível.
6. **Rotas legadas.** Com o fluxo ativo, transições/decisões manuais do
   workflow antigo são recusadas (`FLOW_MANAGED`).
7. **Git.** No bare de teste: `git -C /opt/zeroops/test-repos/p08-sandbox.git
log --oneline --all` mostra a branch `zeroops/…` com os commits do
   ticket; `main` inalterada.
8. **Cliente.** A vista pública do ticket não mostra detalhes técnicos.

## Notas operacionais

- O Git do host QA (2.25) não suporta `git init -b`; criar o bare com
  `git init --bare` e `git symbolic-ref HEAD refs/heads/main`.
- A API corre como `node` e o bare pertence a root: o `runGit` usa uma
  config global própria com `safe.directory = *` (a config de sistema é
  ignorada por `GIT_CONFIG_NOSYSTEM=1`).
- Tickets novos só aceitam os ambientes `quality`/`production`; para retirar
  um fluxo de teste, mudar a regra para `development` e republicar.

## Recuperação

- Se o health falhar, o hook repõe o commit anterior. Confirmar com
  `/api/health` e `deploy/qa/VERSION`.
- O rollback de código não desfaz a 041. O código anterior ignora as tabelas
  e a coluna novas.
- Os workspaces ficam no volume `dev-workspaces`; podem ser removidos com o
  executor parado sem afetar a BD (as revisões, diffs e testes estão na BD).
- Para repor dados, usar o backup `pre-p08-*` (operação destrutiva: pedir
  aprovação explícita).
