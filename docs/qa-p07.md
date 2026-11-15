# P07 — publicação e teste em QA

Simulador partilhado com o runtime. Pressupõe P00 a P06 em QA
(ver [qa-p06.md](qa-p06.md)). Os resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação em `/opt/zeroops/src`.
   Confirmar o SHA em `deploy/qa/VERSION` e em `/api/health`.
2. **Drenagem.** Não pode haver `agent_runs`, `flow_assistant_requests` nem
   `ticket_routing_jobs` em `queued`/`running`.
3. **Backup.** Backup independente em `/var/backups/zeroops/pre-p07-*.sql.gz`,
   validado com `gzip -t`.
4. **Publicação.** Fast-forward de `main` no remoto `qa`
   (`git push qa feat/p07-shared-simulator:main`). O `post-receive` faz backup,
   migrate, compose, health e, se necessário, rollback. Não correr o script
   manualmente a seguir.

## Migration

[040](../sql/040_flow_simulations.sql), aditiva e idempotente:

- tabelas `flow_simulation_scenarios`, `flow_simulation_runs`,
  `flow_trial_targets` e `flow_trial_deliveries`;
- `agent_job_events.job_kind` passa a aceitar `flow_simulation` (a constraint
  é recriada com os valores anteriores mais o novo).

Não há configuração nova. A avaliação com Copilot real usa o executor e o
adaptador já configurados; sem integração Copilot pronta, o pedido é recusado
com `COPILOT_NOT_READY`.

## Verificação técnica

```sql
SELECT name, checksum FROM zeroops_migrations WHERE name LIKE '040%';
SHOW TABLES LIKE 'flow_simulation%';
SHOW TABLES LIKE 'flow_trial%';
SELECT status, COUNT(*) FROM flow_simulation_runs GROUP BY status;
```

## Smoke funcional (browser)

Usar só o projeto de teste e um fluxo novo «Teste P07 …». Não alterar fluxos
reais do cliente e não ativar fluxos de teste com tickets reais.

1. **Estrutural.** No separador do simulador, nível «Validação estrutural»:
   mostra problemas e dependências, sem percorrer o fluxo.
2. **Exemplos.** Executar os exemplos (sucesso, ambiguidade, falta de
   informação, rejeição, falha de ferramenta, timeout, retry limitado,
   capacidade indisponível). O percurso aparece no canvas e a tabela
   «Esperado vs observado» mostra o veredicto.
3. **Cenário guardado.** Criar, editar e executar um cenário com resultados,
   respostas e passagem do tempo; criar outro a partir de um ticket histórico
   e confirmar que o ticket não mudou.
4. **Desatualização.** Alterar e gravar o rascunho: as execuções anteriores
   ficam marcadas como desatualizadas; a evidência de ativação só mostra
   testes para o hash atual.
5. **Copilot real.** Nível «Avaliação Copilot real»: o job fica em fila,
   corre no executor e o resultado observado é comparado com a expectativa,
   identificado como avaliação real (não fixture).
6. **Ensaio isolado.** Criar um destino de ensaio (outbox) e executar: as
   mensagens ficam nas entregas do destino; capacidades não portáveis e
   Copilot aparecem como indisponíveis.
7. **Sem efeitos.** Confirmar na BD que não surgiram comentários,
   notificações, `agent_runs`, execuções de fluxo, remediações nem deploys.
8. **Recarregar e cancelar.** Recarregar durante uma avaliação Copilot (o
   resultado não se perde nem duplica) e cancelar outra.

## Recuperação

- Se o health falhar, o hook repõe o commit anterior. Confirmar com
  `/api/health` e `deploy/qa/VERSION`.
- O rollback de código não desfaz a 040. O código anterior ignora as tabelas
  novas; a constraint de `agent_job_events` continua compatível.
- Para repor dados, usar o backup `pre-p07-*` (operação destrutiva: pedir
  aprovação explícita).
