# P05 — publicação e teste em QA

Encaminhamento semântico com esclarecimentos. Pressupõe P00 a P04 em QA
(ver [qa-p04.md](qa-p04.md)). Os resultados de cada publicação ficam no
[registo de progresso](progresso-zeroops-agentico.md).

## Pré-condições

1. Host `uqphorders24-dev` (`pizzahut-qa`), aplicação em `/opt/zeroops/src`.
   Confirmar o SHA em `deploy/qa/VERSION` e em `/api/health`.
2. **Drenagem.** Não pode haver `agent_runs` nem `flow_assistant_requests` em
   `queued`/`running`. Os tickets existentes não são reencaminhados: não têm
   linha em `ticket_routing` e mantêm o fluxo e a versão que já tinham.
3. **Backup.** Fazer um backup independente em
   `/var/backups/zeroops/pre-p05-*.sql.gz` e validá-lo com `gzip -t`.
4. **Publicação.** Publicar por fast-forward de `main` no remoto `qa`
   (`git push qa feat/p05-semantic-routing:main`). O `post-receive` faz
   backup, migrate, compose, health e, se necessário, rollback. Não correr o
   script manualmente a seguir, para evitar um deploy duplicado.

## Migration

[038](../sql/038_ticket_semantic_routing.sql), aditiva e idempotente:

- coluna `flows.routing_policy` (política do rascunho);
- tabelas `ticket_routing`, `ticket_routing_jobs`, `ticket_routing_replies` e
  `ticket_routing_events`;
- `agent_job_events.job_kind` passa a aceitar `ticket_routing`.

A política em serviço fica em `flow_versions.routing.policy`. Só muda com
«Ativar esta versão».

**Configuração opcional:** `ZEROOPS_EXECUTOR_ROUTING_CONCURRENCY` (por
omissão 1, de 1 a 8) define a capacidade reservada às classificações no
executor.

## Verificação técnica

```sql
SELECT name, checksum FROM zeroops_migrations WHERE name LIKE '038%';
SHOW TABLES LIKE 'ticket_routing%';
SHOW COLUMNS FROM flows LIKE 'routing_policy';
SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
 WHERE CONSTRAINT_NAME='agent_job_events_kind_check';
```

Nos logs do executor deve aparecer a pool `routing`.

## Smoke funcional

Usar só o projeto de teste e fluxos de teste. Não alterar as políticas dos
fluxos reais do cliente.

1. **Fluxos de teste.** Criar três fluxos com uma regra restrita a uma
   combinação sem tickets reais. Por exemplo, origem `portal_team`,
   categoria `question`, ambiente `quality` e prioridade `low`. O ambiente
   `development` não é aceite em tickets novos e serve apenas para retirar
   os fluxos.
   - «Teste P05 Consulta», prioridade baixa, com instruções de consulta;
   - «Teste P05 Desenvolvimento», com instruções de desenvolvimento;
   - «Teste P05 Fallback», sem instruções e com
     `fallbackOnUnresolved` ativo.

   Ativar os três. Editar uma regra sem ativar não muda o encaminhamento
   (o editor mostra «alterações pendentes»).

   O template «em branco» contém a etapa «Análise do Copilot». Por isso cada
   ticket encaminhado gera um run de análise. Cancelá-lo depois de verificar
   o encaminhamento, para drenar os jobs antes do deploy seguinte.

2. **Conjunto rotulado**, com o Copilot real e tickets da combinação de teste:

   | Pedido                                              | Esperado                                                    |
   | --------------------------------------------------- | ----------------------------------------------------------- |
   | «Qual é o estado do pagamento da encomenda X?»      | Consulta                                                    |
   | «Precisamos de adicionar outro método de pagamento» | Desenvolvimento                                             |
   | «Problema com os pagamentos»                        | pergunta pública ao autor; ticket em `awaiting_information` |

3. **Resposta.** No pedido ambíguo, e antes de responder, ativar uma nova
   versão de um dos fluxos de teste. Depois responder como autor. A
   classificação retoma com os candidatos fixados: a versão dos candidatos
   no painel não muda. O fluxo e a versão ficam associados uma única vez.
   Uma nova mensagem não altera a associação.
4. **Painel.** No detalhe do ticket, a equipa vê o estado, a pergunta, a
   decisão e os candidatos fixados. O cliente vê apenas a pergunta pública.
5. **Limpeza.** Cancelar os runs de análise dos tickets de teste e retirar os
   fluxos de teste: passar a regra para o ambiente `development` e ativar
   essa versão.

## Recuperação

- Se o health falhar, o hook repõe o commit anterior. Confirmar com
  `/api/health` e `deploy/qa/VERSION`.
- O rollback de código não desfaz a 038. O código anterior ignora as tabelas
  novas e volta à seleção por regra.
- Os tickets que estavam em `classifying`, `awaiting_reply` ou
  `pending_manual` ficam sem fluxo. Depois do rollback, tratá-los
  manualmente.
- Para repor os dados, usar o backup `pre-p05-*` (operação destrutiva:
  pedir aprovação explícita).
