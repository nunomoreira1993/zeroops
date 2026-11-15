# ZeroOps — revisão do código e plano de fecho

**Data:** 15 de novembro de 2026  
**Repositório:** https://github.com/nunomoreira1993/zeroops  
**Commit revisto:** `b6b8bfc9f00c67cef5ecf1c62611f84e7918f915` (`main`).

## 1. Conclusão

O ZeroOps tem uma implementação substancial das fases P00–P11. Não é necessário recomeçar o desenvolvimento. Porém, ainda não há evidência do ciclo completo sobre a aplicação alvo e foram identificados problemas de código que devem ser corrigidos antes de declarar a ferramenta concluída.

Há três trabalhos distintos:

1. Corrigir invariantes de execução/publicação, isolamento e concorrência.
2. Completar a configuração Git e um operador de publicação específico para a aplicação alvo.
3. Fazer aceitação real no QA, incluindo browser, GitHub, pipeline e Health num recurso descartável.

O site Pizza Hut e o próprio ZeroOps são destinos diferentes. O operador que publica `tickets.pizzahut.pt` não publica o webroot do site Pizza Hut. Uma branch numa sandbox ou um PR interno não prova uma alteração ao site.

## 2. Âmbito e limites desta revisão

Obtive o repositório pelo GitHub e fiz checkout local do commit acima. Inspecionei estrutura, composição API/executor, permissões, desenvolvimento Git, workspaces, reviews, entregas/pipelines, locks, gateway, configuração de deployment, relay, operador de rollout, testes e documentação de progresso/QA.

Executei checks locais com Node 24.22.1 e dependências do lockfile. Não alterei fontes, não fiz commits/push, não usei tokens do cliente e não acedi ao QA/Produção. Os resultados do ambiente remoto citados são os registos do repositório e do relato fornecido, não uma nova observação minha.

A revisão é alargada, mas não constitui prova de ausência de todos os defeitos. A suite integrada com BD, os E2E de GitHub/Copilot e o browser autenticado do cliente não foram executados aqui.

## 3. O que está efetivamente implementado

- Motor de fluxos, rascunhos/versões, encaminhamento e associação de tickets.
- Permissões por projeto e review de desenvolvimento ligado ao candidato.
- Workspaces Git persistentes e worktrees por tentativa.
- Testes executados pelo supervisor, diffs, commits e publicações de branches.
- Provider de PR GitHub via REST; existe código real, não apenas um campo na UI.
- Entregas com fila, integração, revalidação da combinação, HMAC, callbacks e reconciliação.
- Catálogo de capacidades, desenvolvimento associado à autoria e operador de rollout do ZeroOps.
- Relay com contrato de intervenção e journal; a fonte declara a versão 1.2.0.
- Métricas, retenção, migração auditada de tickets antigos e documentação de operação.

Importante: a integração genérica «Publicação» permanece sem conector, mas existe um módulo `delivery` separado com provider `webhook`. A conclusão correta é que falta ligar/concretizar o fornecedor para o site, não que todo o mecanismo de entrega esteja ausente.

## 4. Achados prioritários de código

### F01 — Alta: publicação não revalida todos os gates imediatamente antes do efeito

**Fontes:** [DeliveryRunner.start][C01], [DeliveryStore.publishGate/revalidate][C02].

`integrate()` chama a revalidação completa. Mais tarde, `start()` chama apenas `publishGate()`, que verifica a autorização adicional de desenvolvimento de capacidades. Para tickets normais, esse gate retorna sucesso sem verificar novamente reviewers, estado do fluxo e candidato.

Além disso, quando `start()` é chamado para repetir uma publicação após `uncertain`/404, o bloco de `publishGate` é saltado, porque só corre em `starting`.

**Reprodução local controlada:** instanciei o `DeliveryRunner` compilado com store/transport falsos, uma entrega em `starting` e uma função `revalidate()` que devolveria «review revogado». O resultado foi `fullGateChecks=0` e `publicationRequests=1`. Não ocorreu rede nem deploy real. A reprodução demonstra a ausência da chamada; a alteração real da elegibilidade deve ser coberta adicionalmente por teste de BD.

**Impacto:** um review ou uma autorização pode deixar de ser válido entre integração e publicação, mantendo-se possível enviar o pedido externo.

**Correção:** centralizar um gate de efeito externo que verifique todas as condições aplicáveis e chamá-lo antes do push de integração e de cada pedido inicial/repetido de publicação. Reconciliação de uma operação já enviada deve continuar, mesmo que não seja autorizado iniciar uma nova. Não confundir observar um efeito existente com voltar a executá-lo.

**Aceitação:** revogar review, arquivar pipeline, suspender/cancelar fluxo ou alterar candidato entre fases impede novo efeito; retry de resultado incerto não contorna essa regra.

### F02 — Alta: diretórios diferentes não isolam a execução de código entre jobs

**Fontes:** [WorkspaceManager/runCommand][C03], [composição do executor][C04], [compose][C05].

Os worktrees são diferentes, mas os comandos de setup/teste são executados por shell com `cwd` e um UID comum. O compose usa um executor partilhado e volume comum. O `cwd` não restringe acesso ao resto do sistema de ficheiros; limpar variáveis de ambiente não cria essa restrição.

**Reprodução local controlada:** preparei duas pastas temporárias A/B, ambas propriedade do UID 1000, e executei `runCommand` com esse UID e `cwd=A`. Um comando escreveu um ficheiro de prova em B, com exit code 0. As pastas foram removidas. A prova incide na fronteira do executor de comandos; não usa nem demonstra fuga de um contentor externo.

**Impacto:** scripts de um repositório, dependências ou testes alterados pelo agente podem alcançar outro worktree acessível ao mesmo UID, apesar da organização por projeto/job. Não se deve declarar isolamento de código entre projetos só com worktrees.

**Correção:** executar setup/testes e código das skills num ambiente por job, com mounts limitados e recursos/redes próprios, ou outra barreira de SO efetiva. O supervisor conserva Git/credenciais fora desse ambiente. Aplicar o mesmo princípio a revalidação da combinação e execução de scripts por agentes/skills. Não montar o socket Docker no ambiente do agente.

**Aceitação:** um teste em A não consegue ler/escrever B nem os recursos operacionais; cancelamento e perda de posse terminam o runtime correspondente. Limitar a concorrência é uma mitigação temporária, não substitui a barreira.

### F03 — Alta em alvos partilhados: locks identificam configuração e não o recurso físico

**Fontes:** [resource-locks.ts][C06], [uso em DeliveryRunner][C01], [schema de pipelines][C07].

O lock de ambiente é `env:<pipelineId>:<environment>`. Duas pipelines diferentes para o mesmo QA obtêm locks diferentes. O schema permite várias pipelines com nomes diferentes para o mesmo repositório/ambiente.

O lock de integração usa `repositoryId`; duplicar a configuração do mesmo remoto em projetos diferentes também produz identidades de lock diferentes.

**Impacto:** cada pipeline pode funcionar isoladamente e, ainda assim, duas configurações publicarem no mesmo alvo em simultâneo. O nome genérico `quality` também não identifica qual o QA.

**Correção:** introduzir identidade canónica do alvo de publicação e do repositório/remoto+branch, compartilhável entre bindings. A autorização continua por projeto, mas o lock protege o recurso real. Manter exclusão adicional no operador como segunda barreira.

**Aceitação:** pipelines distintas apontando ao mesmo webroot serializam; alvos diferentes continuam paralelizáveis; configurações duplicadas do mesmo remoto não contornam a fila.

### F04 — Média: operações longas de entrega podem perder o lease durante os testes

**Fontes:** [DeliveryRunner][C01], [limites dos comandos][C08].

O lease de entrega é por omissão 300 segundos. A revalidação chama heartbeat antes de cada comando, mas não periodicamente enquanto `runConfigured()` está a executar. Comandos podem durar até 1800 segundos. Fetch/push também admitem operações longas.

**Impacto:** um comando legítimo que ultrapasse o lease deixa a tentativa sem posse e permite reclamação por outro worker. Fencing protege várias escritas posteriores, mas não evita trabalho externo/execução duplicados nem garante progresso para um teste sempre mais longo que o lease.

**Correção:** heartbeat periódico durante operações demoradas, cancelamento cooperativo/terminação do processo ao perder posse e renovação dos locks pertinentes. Não resolver apenas aumentando indefinidamente o TTL.

**Aceitação:** teste com duração superior ao lease inicial termina com posse válida; perda efetiva termina o processo antes de novos efeitos; outro worker não duplica a tentativa viva.

### F05 — Média antes de instalar outro relay: instâncias partilham executável e identidade

**Fontes:** [instalador relay][C09], [unidade systemd][C10].

`--instance` separa configurações e nomes de serviços, mas `APP_DIR` continua `/opt/zeroops-relay`. A instalação sobrescreve o mesmo PHP utilizado pelas restantes instâncias. Todas usam também o utilizador/grupo `zeroops-relay`; as regras polkit são por esse utilizador, pelo que os privilégios do SO não são separados por instância.

**Correção:** versões/caminhos independentes ou gestão explícita e atómica da versão partilhada, com compatibilidade e recuperação; se o objetivo é isolamento entre instâncias, separar também identidade, acesso às credenciais/configurações e âmbito dos privilégios.

**Aceitação:** atualizar/remover a instância de teste não altera binário, serviço, credenciais ou permissões da instância existente. Só depois ensaiar intervenção numa unidade descartável.

## 5. Disponibilidade e interface: corrigir o significado dos gates

**Fontes:** [capabilities.ts][C11], [application.ts][C12], [catálogo de integrações][C13].

O endpoint `/api/capabilities` retorna sempre três valores falsos e é usado na Shell/Integrações. O `WorkflowService` legado recebe esse mesmo objeto. Contudo, os novos runners/serviços de desenvolvimento e entrega são compostos separadamente e não dependem desse objeto para todas as operações.

Portanto, corrigindo a interpretação do relatório anterior: **não é rigoroso dizer que os três falsos bloqueiam toda a automação nova**. Eles mantêm bloqueios legados e uma apresentação global que não representa o estado real de cada projeto.

**Fecho:** escolher uma fonte de disponibilidade por projeto/recurso/ambiente, distinguir disponibilidade de autorização do utilizador e apresentar motivos acionáveis. Ou retirar o painel global legado se já não tiver significado. Não abrir todos os gates com constantes `true` nem duplicar uma política de aprovação fora do fluxo.

Também clarificar na UI a diferença entre Integrações → Publicação, Repositórios Git e pipelines do módulo de entregas. Um campo que permite guardar uma referência mas não publica nada não deve ser o único percurso apresentado ao utilizador.

## 6. Configuração que falta no projeto alvo

**Fonte do estado registado:** [progresso, auditoria do percurso real][C14].

A documentação atual confirma que Pizza Hut só tinha Sandbox P08 e ZeroOps capacidades; não havia binding de desenvolvimento para `Deloitte-Portugal/pizzahut`. Os tickets ZO-25–29/37 foram executados nas sandboxes e ZO-30 alterou o ZeroOps.

Para fechar a integração real:

1. Configurar a raiz/remoto Git permitido no executor/API e o recurso do projeto.
2. Configurar a identidade Git cifrada com acesso ao remoto/branch e PR. Não assumir que a integração Copilot autoriza estas operações.
3. Confirmar branch base, versão realmente servida no QA e ficheiros locais persistentes.
4. Configurar testes de PHP/aplicação no runtime apropriado. A imagem atual do executor tem Node/Git; não fornece automaticamente o runtime PHP e serviços do projeto.
5. Confirmar clone, push e PR reais. O botão de verificação atual do repositório faz `ls-remote`; isso só prova leitura da ref, não escrita ou permissões de PR.
6. Ligar pipeline/operador do QA do site.

O código do PR GitHub existe em [pr-providers.ts][C15]. Isso é desenvolvimento implementado com validação externa pendente, não motivo para criar novamente o provider.

## 7. Operador de publicação do site: trabalho ainda necessário

O mecanismo `webhook` da entrega existe e o operador fornecido publica o próprio ZeroOps. A documentação reconhece que não existe operador do webroot do site.

Implementar ou ligar um operador real que cumpra o contrato de P09, com:

- alvo QA e webroot explicitamente identificados;
- SHA de destino e digest/artefacto verificados;
- backup e lock por alvo real;
- preservação de configurações, uploads e ficheiros não versionados;
- migrations e serviços específicos da aplicação, quando aplicáveis;
- estado durável/idempotência e consulta por chave da entrega;
- resposta compatível com o callback assinado esperado pelo ZeroOps;
- verificação funcional e versão ativa;
- recuperação ensaiada, sem prometer rollback de dados por simples reposição de código.

GitHub Actions é uma possibilidade, não um requisito. Se for usado, é necessária uma ponte para o contrato `webhook` ou um adapter nativo devidamente implementado. Não basta criar um YAML e assumir que o protocolo atual passa a funcionar. A árvore revista não contém workflows GitHub Actions em `.github/workflows`.

O registo do repositório menciona uma mudança de teste previamente acordada, `zeroops-check.txt`, branch `qa` e QA `dev.pizzahut.pt`, além de commits pendentes. Estes são dados documentados, não uma confirmação atual do servidor. Reconciliar a base e o impacto antes de publicar; não juntar automaticamente alterações alheias ao teste.

O HTTP 503/TLS relatado deve ser diagnosticado antes do ensaio. A falha local pode depender de host header, URL, CA ou aplicação; não concluo daqui que o site esteja atualmente indisponível. Um diagnóstico com validação TLS desativada não certifica a configuração final.

## 8. Checks executados nesta revisão

| Check | Resultado local |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | Dependências instaladas a partir do lockfile; scripts de instalação não executados. |
| `npm run typecheck` | Passou. |
| `npm run build` | Passou; aviso de bundle frontend superior a 500 kB, sem bloquear build. |
| Testes web do workspace | 136/136 Vitest e 13/13 Node passaram. |
| Subconjunto unitário de contratos/executor + arquitetura | 76 passaram; 3 falharam, todos de arquitetura. Configuração temporária sem globalSetup de BD; E2E e smoke Copilot excluídos. |
| Python: operador de rollout | 10/10 passaram. |
| Python: script de deployment | 6/6 passaram. |
| `npm run lint` | Falhou: `portKey` não usado em `StepConfigPanel.tsx:23`. |
| `npm run format:check` | Falhou em 9 ficheiros. |
| Ensaios locais específicos | Publicação sem revalidação completa e escrita entre pastas de jobs confirmadas, sem rede/deploy e com limpeza das pastas temporárias. |
| Suite integrada com BD | Não executada: não existe MySQL/MariaDB/Docker de testes instalado neste ambiente; não usei bases do cliente. |
| Browser QA, GitHub PR real e Copilot real | Não executados nesta revisão. |

As três falhas de arquitetura são dependências fora da allowlist, lacunas de documentação e ciclos entre domínios. A documentação do projeto já as identifica no baseline. Mesmo sendo anteriores, a suite não está verde; não basta alterar a allowlist/desligar testes para fechar.

Ficheiros com formatação pendente: `apps/executor/src/agent-report.ts`, `apps/executor/src/development-runner.ts`, `apps/web/index.html`, `deploy/health-agent/README.md`, `docs/progresso-zeroops-agentico.md`, `packages/backend/src/modules/health/collectors/cron-schedule.ts`, `packages/backend/src/modules/health/collectors/host-agent-cron.test.ts`, `packages/backend/src/modules/health/health-recipients.ts`, `tests/helpers/cluster.ts`.

## 9. Ordem recomendada para fechar

### Entrega A — Integridade da execução

Corrigir F01–F04 com testes de regressão; rever fronteiras para evitar bypass por rotas antigas, callbacks e retries. Resolver lint e formatação e corrigir as falhas arquiteturais de forma justificada. Criar CI reproduzível, com BD descartável para a suite integrada.

**Pronto quando:** gates revalidados junto dos efeitos; jobs sem acesso cruzado; mesmo alvo serializado entre pipelines; testes longos conservam posse ou são interrompidos corretamente; checks definidos passam.

### Entrega B — Projeto real e publicação do site

Configurar Git e runtime/testes reais do projeto. Completar disponibilidade/UI e ligar o operador do site ao módulo de entregas.

**Pronto quando:** o ZeroOps consegue criar uma alteração no repositório correto, PR GitHub real e publicação no QA do site, com SHA/artefacto verificáveis.

### Entrega C — Health real isolado

Corrigir F05 e preparar relay/unidade descartáveis. Validar restart, recuperação, suspensão, duplicação e resultado incerto. Não usar MySQL ou serviços partilhados do cliente como alvo de ensaio.

**Pronto quando:** intervenção real comprovada sem afetar recursos de outro projeto/instância.

### Entrega D — Aceitação final pela interface

Repetir A–E no commit final, com browser autenticado e dados de teste:

| Cenário | Evidência final exigida |
| --- | --- |
| A — Consulta | Encaminhamento, pergunta/resposta se necessária, fonte autorizada e resposta correta ao cliente. |
| B — Desenvolvimento cliente | Repo alvo, testes reais, rejeição/correção, nova aprovação e publicação no site QA. |
| C — Interno | Sem aprovação inicial, com review configurado e entrega real. |
| D — Health | Incidente correlacionado e intervenção/recuperação reais num recurso descartável. |
| E — Capacidade | Alteração ao ZeroOps quando apropriada, rollout independente e associação ao rascunho sem ativação automática. |

Testar também simulador e ativação pelo browser, reconexão e acesso delegado. Uma sessão novamente autenticada não comprova esses percursos.

Conservar a versão e estado dos tickets anteriores; comparar inventário antes/depois. Distinguir as falhas realmente resolvidas das pendências de ambiente.

## 10. Critério de conclusão

Considerar desenvolvimento funcional fechado para o âmbito acordado em QA quando:

- F01–F05 estiverem corrigidos ou explicitamente fora do âmbito com uma restrição operacional efetiva e aceite; os requisitos de isolamento/autonomia acordados não podem ser certificados só com worktrees.
- Git, PR e publicação da aplicação alvo tiverem sido exercitados realmente.
- Relay e Health tiverem ensaio real num alvo apropriado.
- Interface de autoria/simulação/ativação tiver sido validada.
- Suite final e checks obrigatórios tiverem resultado reproduzível.
- A–E tiverem evidência no commit final, sem substituir operações obrigatórias por mocks.
- Runbooks e recuperação estiverem ensaiados, e o inventário dos dados preservado.

Certificar MySQL 5.7 apenas se fizer parte dos motores suportados no âmbito real. Não confundir BD do ZeroOps com a BD da aplicação mantida. A conclusão em QA não autoriza nem certifica automaticamente Produção.

## Referências ao código no commit revisto

[C01]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/apps/executor/src/delivery-runner.ts#L505
[C02]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/packages/backend/src/modules/delivery/delivery.store.ts#L350
[C03]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/apps/executor/src/workspace-manager.ts#L44
[C04]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/apps/executor/src/main.ts#L66
[C05]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/deploy/docker/compose.yml
[C06]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/packages/backend/src/database/resource-locks.ts#L22
[C07]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/sql/042_delivery_pipelines_health.sql
[C08]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/packages/contracts/src/development.ts#L41
[C09]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/deploy/production-relay/install.sh#L26
[C10]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/deploy/production-relay/zeroops-relay.service
[C11]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/packages/backend/src/capabilities.ts
[C12]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/apps/api/src/application.ts#L102
[C13]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/apps/web/src/features/integrations/integration-catalog.ts#L109
[C14]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/docs/progresso-zeroops-agentico.md#L2330
[C15]: https://github.com/nunomoreira1993/zeroops/blob/b6b8bfc9f00c67cef5ecf1c62611f84e7918f915/apps/executor/src/pr-providers.ts
