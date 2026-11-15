# P06 — publicação e teste em QA

Chat de construção com diagrama em tempo real. Pressupõe P00 a P05 em QA
(ver [qa-p05.md](qa-p05.md)). Os resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação em `/opt/zeroops/src`.
   Confirmar o SHA em `deploy/qa/VERSION` e em `/api/health`.
2. **Drenagem.** Não pode haver `agent_runs`, `flow_assistant_requests` nem
   `ticket_routing_jobs` em `queued`/`running`.
3. **Backup.** Backup independente em `/var/backups/zeroops/pre-p06-*.sql.gz`,
   validado com `gzip -t`.
4. **Publicação.** Fast-forward de `main` no remoto `qa`
   (`git push qa feat/p06-authoring-chat:main`). O `post-receive` faz backup,
   migrate, compose, health e, se necessário, rollback. Não correr o script
   manualmente a seguir.

## Migration

[039](../sql/039_flow_authoring_sessions.sql), aditiva e idempotente:

- tabelas `flow_authoring_sessions`, `flow_authoring_operations`,
  `flow_authoring_events` e `flow_capability_requests`;
- colunas `session_id`, `authoring_mode` e `known_revision` em
  `flow_assistant_requests`.

Não há configuração nova. As ferramentas de autoria exigem o adaptador SDK
(já em uso no QA).

## Verificação técnica

```sql
SELECT name, checksum FROM zeroops_migrations WHERE name LIKE '039%';
SHOW TABLES LIKE 'flow_authoring%';
SHOW TABLES LIKE 'flow_capability_requests';
SHOW COLUMNS FROM flow_assistant_requests LIKE 'session_id';
```

## Smoke funcional (browser)

Usar só o projeto de teste e um fluxo novo «Teste P06 …» (template em
branco). Não alterar fluxos reais do cliente e não ativar o fluxo de teste.

1. **Automático.** No editor, assistente em modo «Automático», pedir um fluxo
   com várias etapas e ligações. As etapas e ligações aparecem no canvas
   enquanto o agente trabalha (marcadas como novas) e as operações surgem em
   «Alterações aplicadas».
2. **Reconexão.** Recarregar a página a meio da geração. O histórico,
   operações e eventos em falta são recuperados sem duplicar nós.
3. **Assistido.** Mudar para «Assistido», pedir uma alteração, rever a
   pré-visualização e aceitar (ou descartar).
4. **Edição manual e conflito.** Com alterações manuais por guardar, deixar o
   agente aplicar uma operação: o editor mostra o conflito e preserva o
   trabalho local até «Recarregar».
5. **Desfazer.** Desfazer a última operação aplicada: nova revisão, histórico
   preservado.
6. **Capacidade em falta.** Pedir algo que exija uma ferramenta inexistente:
   aparece um bloqueio «capacidade em falta», sem ferramenta inventada.
7. **Sem ativação implícita.** A versão ativa do fluxo não muda; só «Ativar
   esta versão» o faria.
8. **Cancelar** um pedido em curso: o job termina e não aplica mais
   operações.
9. **Limpeza.** Apagar ou retirar o fluxo de teste e confirmar que os fluxos
   reais ficaram inalterados.

## Recuperação

- Se o health falhar, o hook repõe o commit anterior. Confirmar com
  `/api/health` e `deploy/qa/VERSION`.
- O rollback de código não desfaz a 039. O código anterior ignora as tabelas
  e colunas novas; os pedidos com `session_id` passam a ser tratados como
  pedidos antigos (proposta final).
- Para repor dados, usar o backup `pre-p06-*` (operação destrutiva: pedir
  aprovação explícita).
