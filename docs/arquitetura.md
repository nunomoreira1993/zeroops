# Arquitetura e convenções de desenvolvimento

## Objetivo

Este documento define como manter o ZeroOps modular, testável e compreensível. A arquitetura é pragmática: classes são usadas para serviços com dependências/ciclo de vida ou responsabilidades coesas; regras puras permanecem funções quando isso torna o comportamento mais simples.

## Estrutura do workspace

| Diretório                       | Responsabilidade                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/api`                      | Composição NestJS e fronteira HTTP: autenticação da sessão, validação de rotas e tradução de erros.      |
| `apps/web`                      | Interface React organizada por funcionalidades; comunica com a API por contratos HTTP.                   |
| `apps/worker`                   | Processamento assíncrono de outbox, notificações e ciclos de Health.                                     |
| `apps/connectors`               | Serviço interno de ferramentas autorizadas por run; não publica credenciais ao agente.                   |
| `apps/executor`                 | Fila e processo do agente; deve permanecer separado da API e dos conectores.                             |
| `packages/contracts`            | Schemas de entrada/saída e tipos partilhados; não depende do backend nem da BD.                          |
| `packages/backend/src/modules`  | Casos de uso e regras organizados por domínio (identity, tickets, workflow, integrations, health, etc.). |
| `packages/backend/src/database` | Adaptador MySQL/MariaDB, transações e migrações.                                                         |
| `sql`                           | Migrações versionadas da base de dados do próprio ZeroOps.                                               |

## Direção das dependências

Direção desejada:

```text
React ──> contratos <── API/worker/executor/connectors
API HTTP ──> serviços de aplicação ──> políticas de domínio
                    │                         │
                    └──> portas <── adapters / infraestrutura
```

- A API valida/normaliza a fronteira HTTP e delega; não contém regras de negócio nem SQL.
- Serviços de aplicação coordenam casos de uso, autorização, transações e efeitos externos.
- Domínio contém políticas e invariantes sem depender de NestJS, React ou MySQL.
- Persistência e serviços externos são adapters. Em módulos mais simples, o serviço pode usar diretamente o adaptador de BD já injetado; extrair um repository/port quando isso reduzir acoplamento, duplicação ou dificuldade de teste, não por regra mecânica.
- `contracts` não importa `packages/backend`, componentes React nem detalhes de armazenamento.
- Um domínio não deve importar ficheiros internos de outro domínio para contornar a API desse domínio. Partilhar apenas contratos/utilitários realmente comuns.
- Composição de dependências acontece em entrypoints/factories (`application.ts`, `health.module.ts`, bootstrap dos workers), não dentro do domínio.

### Dependências diretas entre domínios backend

As dependências diretas observadas e autorizadas são explícitas. Uma nova ligação entre domínios exige rever a direção, o motivo e os testes antes de entrar nesta lista.

| Domínio         | Pode depender diretamente de                                          |
| --------------- | --------------------------------------------------------------------- |
| `agents`        | `identity`, `tickets`                                                 |
| `connectors`    | `identity`                                                            |
| `executions`    | nenhum domínio                                                        |
| `flows`         | `agents`, `health`, `identity`, `tickets`                             |
| `health`        | `agents`, `connectors`, `identity`, `integrations`, `smtp`, `tickets` |
| `identity`      | nenhum domínio                                                        |
| `integrations`  | `connectors`, `identity`, `smtp`                                      |
| `metrics`       | `identity`, `tickets`                                                 |
| `notifications` | `identity`, `integrations`, `smtp`                                    |
| `operations`    | `identity`                                                            |
| `smtp`          | nenhum domínio                                                        |
| `tickets`       | `identity`                                                            |
| `workflow`      | `identity`, `tickets`                                                 |

O mapa é protegido por `tests/architecture.boundaries.test.ts`, que também rejeita ciclos. Contratos partilhados e utilitários criptográficos de baixo nível ficam fora dos domínios; por isso o gateway não importa o serviço de runs apenas para calcular hashes e o manifesto do candidato pertence a `executions`, não a `workflow`.

Esta tabela descreve a allowlist do teste, não certifica o grafo atual. A baseline
P00 já falha por dependências fora dessa lista, ciclos e TSDoc preexistentes.
O [inventário P00](compatibilidade-zeroops-agentico-p00.md) distingue essas dívidas
das alterações da entrega; não foram abertas exceções para esconder as falhas.

As dependências da tabela incluem adapters/factories locais que ainda fazem composição com integrações externas (por exemplo, o factory de Health). Essa composição deve migrar para entrypoints quando aumentar; não é autorização para um caso de uso importar detalhes internos arbitrários do domínio dependente.

## Orientação a objetos e funções

- Criar uma classe quando existe uma responsabilidade estável, dependências injetadas, estado/ciclo de vida ou uma implementação substituível por teste.
- Usar interfaces/ports para dependências externas que variam, por exemplo transportes de mail, coletores ou leitores.
- Manter funções puras para políticas de domínio e transformações sem estado (por exemplo, uma decisão de transição). Evitar classes com um único método estático ou objetos que apenas reencaminham chamadas.
- Serviços de aplicação devem ter responsabilidades delimitadas. Se uma classe acumula áreas de negócio distintas, separar por casos de uso coesos preservando a fronteira transacional e os controlos de autorização.
- Não usar herança para partilhar implementação sem uma relação de substituição clara; preferir composição.

## Documentação de código

- Escrever TSDoc em exports públicos, métodos de aplicação/use case e funções de domínio com regras de negócio.
- Documentar o propósito e o contrato, não a sintaxe: parâmetros relevantes, resultado, efeitos secundários, erros/autorizações e invariantes quando não forem óbvios.
- Em tipos e schemas públicos, explicar restrições ou semântica que não esteja clara pelos nomes/validações.
- Comentários locais em privados, helpers e callbacks apenas para decisões, limitações, compatibilidade ou regras não óbvias.
- Não adicionar comentários redundantes a funções triviais, getters, testes ou linhas autoexplicativas. Os testes devem descrever comportamento pelos nomes dos cenários.
- Atualizar comentários e documentação na mesma alteração funcional; comentários contraditórios são piores que ausência de comentário.

Exemplo de documentação de uma decisão de domínio:

```ts
/**
 * Determina o próximo estado de uma aprovação sem alterar o ticket.
 * A decisão exige a versão e o hash atuais; rejeições precisam de motivo.
 *
 * @throws DomainError se o papel, versão, artefacto ou motivo forem inválidos.
 */
export function approveStage(/* ... */) {
  // ...
}
```

## Convenções de implementação

- TypeScript estrito e tipos explícitos nas fronteiras públicas; validar dados externos com os schemas Zod de `contracts`.
- Usar SQL parametrizado. Transações abrangem todas as alterações que precisam de consistência; não esconder efeitos externos dentro de callbacks transacionais sem política para retries.
- Representar falhas com erros de domínio tipados/códigos estáveis e traduzir para HTTP na fronteira da API. Não devolver sucesso vazio quando uma operação falha.
- Autorização deve ser verificada no backend para cada caso de uso. A UI não é uma fronteira de segurança.
- Permissões delegáveis por projeto são resolvidas em `identity/project-permissions`.
  Grants não promovem papéis nem conferem revisão de tickets. Mutações funcionais
  e de grants obtêm o lock de projeto antes de locks funcionais, revalidam a BD e
  usam auditoria/revisão transacional. Revogações não removem grants de terceiros.
  Ver [ADRs P00](adrs-agentico-p00.md) e [progresso P00/P01](progresso-zeroops-agentico.md).
- Agentes e skills (P04) são capacidades versionadas em `agents`, com o bundle e o hash
  imutáveis. O executor só materializa bundles verificados por hash e compila-os para o SDK.
  Hooks, skills e especialistas nunca concedem permissões: a autorização fica na política
  efetiva e no `ConnectorGateway`.
- Autoridade única (P11): enquanto um ticket tem execução de fluxo viva, só o motor muda o
  seu estado. `tickets/flow-authority.ts` é a única verificação, usada por `TicketsService`,
  `TicketGovernanceService` e `WorkflowService`; caminhos legados rejeitam (`FLOW_MANAGED`) ou
  delegam no motor. Tickets antigos sem execução não são adotados implicitamente
  (`flows/flow-adoption.ts`, decisão auditada única por ticket).
- Manutenção que remove dados (`operations/retention.service.ts`) nunca corre sozinha:
  dry-run com hash, aplicação com `expect` igual e predicados reavaliados com lock no momento
  da remoção. Métricas operacionais (`metrics/operations-metrics.service.ts`) só agregam
  valores registados; ausência de dados aparece como `null`, nunca como zero inventado.
- Não misturar políticas de Qualidade e Produção. Acesso a Produção é somente leitura neste produto e requer configuração/autorizações próprias.
- Separar investigação read-only de execução de alterações. Escrita em QA exige autorização ligada ao ticket, artefacto e ambiente; nunca reutilizar a credencial do conector de investigação.
- Evitar funções/classe gigantes; extrair uma unidade quando tiver nome, contrato e teste próprios e quando isso tornar o fluxo principal mais fácil de compreender.

## Testes e qualidade

- Testes unitários para políticas puras e casos de borda; testes de integração para transações, persistência e autorização; testes de UI focados nos fluxos visíveis.
- Testes devem cobrir resultados, invariantes e falhas significativas, não repetir literalmente a implementação.
- Alterações devem passar os testes direcionados, `tsc`, ESLint e Prettier para os ficheiros afetados.
- `tests/architecture.boundaries.test.ts` protege a independência de `contracts`, impede dependências de `backend` para `apps` e verifica ciclos entre domínios backend.
- O mesmo teste protege o isolamento web/backend, a allowlist acima e TSDoc em classes de serviço, funções exportadas e métodos públicos de classes exportadas nos módulos backend.
- `npm run architecture:metrics` gera o inventário reproduzível de ficheiros, linhas, testes colocados junto aos domínios e cobertura TSDoc; estes números não representam cobertura de código.
- Não executar testes E2E ou suites completas fora da autorização acordada para a tarefa.
- Medidas de tamanho/complexidade são sinais para revisão, não metas numéricas que incentivem abstrações artificiais.
- Migrações devem preservar dados, ser verificadas contra os schemas e nunca executar alterações destrutivas sem aprovação explícita.

## Prioridades identificadas na leitura inicial

1. Reduzir responsabilidades concentradas em `AccountService`, `TicketsService` e `WorkflowService`, com separação guiada pelos casos de uso.
2. Tornar consistente a fronteira de persistência onde o SQL e a regra de negócio se encontram excessivamente misturados.
3. Documentar contratos públicos e invariantes de domínio em falta, começando pelos módulos identity, tickets e workflow.
4. Manter README, funcionalidades e documentação operacional coerentes com a implementação e o ambiente efetivamente verificado.

Estas prioridades são hipóteses para o inventário completo; não justificam uma reescrita integral sem confirmar dependências, testes e riscos por domínio.
