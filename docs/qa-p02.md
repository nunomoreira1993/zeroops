# P02 — publicação e teste em QA

Fluxos V2, manifestos e ativação explícita. Pressupõe P00/P01 já em QA
(ver [qa-p00-p01.md](qa-p00-p01.md)). Não confundir o QA ZeroOps com o webroot
PHP Pizza Hut. Resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação `/opt/zeroops/src`, repo
   bare `/opt/zeroops/repo.git`. Confirmar SHA atual em `deploy/qa/VERSION` e
   `/api/health`.
2. Sem execuções de fluxo/runs Copilot em curso que não possam ser
   interrompidas (`agent_runs` em `queued`/`running`).
3. Backup independente da BD em `/var/backups/zeroops/` (gzip + SHA-256,
   `gzip -t`), além do backup feito pelo próprio script de deploy.
4. Por pedido explícito do utilizador, o QA é atualizado através de `main` no
   remoto `qa`: o `post-receive` só publica `refs/heads/main` e chama
   `deploy/qa/deploy-from-git.sh`. Fazer push apenas em fast-forward (nunca
   force). Alternativa sem mover `main`: bundle + ref de staging + script, como
   em P00/P01.

## Configuração e migration

- Sem novas variáveis de ambiente.
- Migration nova: [035](../sql/035_flow_explicit_activation.sql), aditiva e
  idempotente, aplicada pelo serviço `migrate` existente. Preserva o
  encaminhamento em serviço (copia `priority/is_default/flow_match` para
  `active_*` dos fluxos publicados) e regista uma ativação `migration` por
  versão ativa.
- Verificar no journal `zeroops_migrations` a entrada
  `035_flow_explicit_activation.sql` e, por projeto, que os fluxos publicados
  têm `active_priority` preenchido e no máximo um `active_is_default=1`.

## Efeitos esperados

- Fluxos já publicados continuam ativos com o mesmo encaminhamento.
- Projetos sem fluxos passam a receber os modelos apenas como rascunho; é
  necessário «Ativar esta versão» (incluindo o modelo da Saúde) antes de os
  tickets novos entrarem em fluxo.
- Tickets em curso mantêm a versão a que estão presos.

## Smoke funcional

1. Abrir um fluxo ativo: badge «Ativa vN», rascunho rev. N (V1/V2), lista de
   versões imutáveis com hash e histórico com a entrada «migration».
2. Editar uma etapa/regra: aparece «alterações por ativar»; um ticket novo
   continua a seguir a versão ativa.
3. «Ativar esta versão»: nova versão com hash, entrada no histórico; tickets
   novos seguem a nova versão e os anteriores mantêm a sua.
4. Editor sem `flows.activate`: edita rascunho/regras, mas não ativa nem associa
   alertas (botão ausente e API 403).
5. Duas abas: ativar com revisão desatualizada → 409 e pedido de recarregar.
6. Saúde: criar fluxo próprio para um alerta → fica «Rascunho por ativar» até à
   ativação; a associação anterior mantém-se até lá.
7. Fluxo V2 com etapa «Condição»: validação, simulação com prioridade e
   ativação; uma etapa Copilot com modelo `…latest` é recusada.

## Recuperação

- O script repõe código/imagens em falha de build/migration/health.
- A BD **não** é restaurada automaticamente; a 035 é aditiva e pode permanecer
  com o código anterior (que ignora as colunas novas). Não fazer `DROP`.
- Restaurar a BD só com autorização específica e backup verificado.
