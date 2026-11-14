# Inventário e qualidade arquitetural

## Âmbito e método

Este inventário cobre o checkout local do ZeroOps em 2026-11-10. Não inclui dependências instaladas, build output, migrações SQL nem código do site/app Pizza Hut.

As contagens são reproduzíveis com `npm run architecture:metrics`. O comando percorre os workspaces `apps` e `packages`, e usa a API AST do TypeScript para contar funções exportadas, classes exportadas e métodos públicos documentáveis nos domínios backend e no módulo de segurança. A verificação de documentação e dependências também é executada por `tests/architecture.boundaries.test.ts`.

## Dimensão do workspace

Foram encontrados 138 ficheiros de produção TypeScript/TSX, sem contar testes ou declarações `.d.ts`.

| Workspace            | Ficheiros |
| -------------------- | --------: |
| `apps/api`           |        13 |
| `apps/connectors`    |         2 |
| `apps/executor`      |         7 |
| `apps/web`           |        45 |
| `apps/worker`        |         1 |
| `packages/backend`   |        65 |
| `packages/contracts` |         5 |

O backend contém 12 domínios, distribuídos por 59 ficheiros e 9 305 linhas de produção. A contagem de linhas usa o número de linhas físicas, sem contar uma linha vazia artificial depois de um newline final.

## Inventário dos domínios backend

| Domínio         | Ficheiros |    Linhas | Operações públicas documentadas | Testes unitários junto ao domínio |
| --------------- | --------: | --------: | ------------------------------: | --------------------------------: |
| `agents`        |         1 |       381 |                           10/10 |                                 1 |
| `connectors`    |         7 |       538 |                           19/19 |                                 1 |
| `executions`    |         2 |        98 |                             2/2 |                                 0 |
| `health`        |        14 |     2 736 |                           69/69 |                                 4 |
| `identity`      |        13 |     2 205 |                           87/87 |                                 3 |
| `integrations`  |         2 |       544 |                           12/12 |                                 1 |
| `metrics`       |         2 |       176 |                             3/3 |                                 2 |
| `notifications` |         6 |       832 |                           21/21 |                                 3 |
| `operations`    |         1 |        80 |                             4/4 |                                 1 |
| `smtp`          |         1 |        31 |                             1/1 |                                 0 |
| `tickets`       |         7 |     1 240 |                           31/31 |                                 1 |
| `workflow`      |         3 |       444 |                             8/8 |                                 2 |
| **Total**       |    **59** | **9 305** |                     **267/267** |                            **19** |

O domínio `security` não faz parte da tabela de domínios de negócio: a função partilhada de hash de token acrescenta uma operação documentada ao total AST abaixo.

## Documentação e guardas arquiteturais

| Medida                                                                                              |  Resultado |
| --------------------------------------------------------------------------------------------------- | ---------: |
| Funções exportadas, classes exportadas e métodos públicos avaliados, incluindo segurança partilhada |        268 |
| Operações com TSDoc                                                                                 | 268 (100%) |
| Lacunas de TSDoc encontradas                                                                        |          0 |
| Classes exportadas com descrição TSDoc                                                              |      32/32 |
| Ciclos entre domínios                                                                               |          0 |
| Dependências diretas entre domínios permitidas e testadas                                           |         18 |

A verificação não exige comentários em toda função privada, callback, getter trivial ou teste. Documenta contratos públicos, serviços de aplicação e regras de domínio; comentários locais são necessários quando explicam uma decisão ou restrição não óbvia. Isto evita comentários redundantes que se tornam inconsistentes com o código.

As dependências de cada domínio estão explicitadas em [arquitetura.md](./arquitetura.md) e validadas pelo teste arquitetural. O manifesto de candidato pertence a `executions`; o hashing de tokens é um utilitário de segurança partilhado, evitando dependências de domínio introduzidas apenas para reutilizar esses detalhes.

## Decomposição dos módulos prioritários

As medições atuais de linhas, também incluídas na saída de `npm run architecture:metrics`, mostram os principais serviços e colaboradores:

| Serviço ou política                  | Linhas |
| ------------------------------------ | -----: |
| `AccountService`                     |    556 |
| `AccountMfaService`                  |    110 |
| `AccountInvitationService`           |    223 |
| `TicketsService`                     |    475 |
| `TicketsReadService`                 |    101 |
| `WorkflowService`                    |    350 |
| Política pura de transição de ticket |     51 |

As extrações preservam as APIs usadas pelos controllers: leituras de tickets, MFA e convites estão em colaboradores coesos; a decisão de transição de workflow é uma política pura testada isoladamente. Serviços com estado/dependências continuam classes injetáveis; não se introduzem classes apenas para envolver funções.

## Lacunas e prioridades seguintes

1. **Reduzir o tamanho dos serviços de aplicação.** `AccountService`, `TicketsService` e `WorkflowService` ainda coordenam vários casos de uso. Separar novas responsabilidades apenas quando houver uma fronteira de negócio e transação claras, mantendo autorização e compatibilidade da API.
2. **Consolidar persistência por domínio.** Há SQL junto da coordenação de casos de uso. Extrair repositórios/ports seletivamente onde isso reduzir acoplamento, duplicação ou dificuldade de teste; não criar uma abstração genérica para todos os módulos.
3. **Aprofundar testes de persistência e autorização.** Os 19 ficheiros são apenas a contagem de testes unitários colocados junto aos domínios, não uma medida de cobertura. `executions` e `smtp` não têm testes unitários colocados nas respetivas pastas segundo este inventário; confirmar cobertura por testes de integração antes de concluir que faltam cenários.
4. **Manter o inventário atualizado.** Reexecutar `npm run architecture:metrics` após refatorações e preservar o teste arquitetural no conjunto de validação.

As contagens são indicadores para orientar revisão, não metas de tamanho ou prova automática de qualidade. O inventário não mede cobertura de código, complexidade cognitiva, acoplamento em runtime nem completude semântica de cada comentário.
