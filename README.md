# ZeroOps

Plataforma modular de manutencao Pizza Hut: portal proprio, triagem, propostas versionadas e aprovacoes humanas. TypeScript, NestJS, React e MySQL/MariaDB.

## Estado e limites

O código cobre o portal, workflow, integração do Copilot para investigação e o módulo Saúde. O deployment de Qualidade em `https://tickets.pizzahut.pt` foi verificado anteriormente com os serviços API, worker, connectors e executor ativos; não foi revalidado nesta revisão. Esta informação refere-se a Qualidade e não autoriza nem descreve uma instalação em Produção.

- Contas por convite, sessoes persistentes e autorizacao por projeto.
- Tickets, conversas publicas/internas, triagem e historico.
- Propostas e aprovacoes vinculadas a versao/hash, com papeis distintos.
- Metricas de resposta, espera e resolucao, sem SLA contratual presumido.
- Investigação Copilot por ticket em Qualidade, iniciada pela equipa e sujeita a revisão humana; o caso só é executável depois de configurar e verificar as integrações.
- Outbox durável em MySQL, processado pelo worker. A entrega real depende de configuração SMTP verificada.
- Módulo Saúde com 21 verificações, alertas, relatório diário e suporte para agente no host. A configuração e entrega remotas atuais não foram verificadas nesta revisão; a documentação operacional contém registos históricos que não devem ser tratados como estado atual.
- Fluxos de resolução por projeto: editor visual, assistente Copilot para alterar o fluxo por conversa, simulação com tickets antigos, versões publicadas e acompanhamento por ticket. Ver [funcionalidades](funcionalidades.md#14-fluxos-de-resolução).
- Plano agêntico P00–P11 (permissões delegáveis, versões, jobs duráveis, agentes/skills, pipeline, Health pelo fluxo, capacidades e rollout, operação): estado real e limitações em [progresso](docs/progresso-zeroops-agentico.md); procedimentos de operação, com indicação do que foi ensaiado em QA, em [operação](docs/operacao-zeroops-agentico.md).

Continuam por implementar: anexos privados, execução governada de alterações em QA, testes independentes do candidato, preview/QA automatizados e operador SVN/release. Produção fica limitada a monitorização read-only aprovada; não existe escrita nem deployment de ZeroOps em Produção neste âmbito. **Estado de runtime, configuração e acesso devem ser verificados no ambiente antes de cada operação.**

Nao ha dados de demonstracao em runtime, utilizadores predefinidos, acesso remoto implicito ou botao que finja ter publicado producao. A API recusa autorizar implementacao/deploy quando os conectores nao estao disponiveis; nao consome a aprovacao.

## Arranque local

Requisitos: Node.js 24+, npm e uma base MySQL/MariaDB (10.3+) dedicada ao ZeroOps. `ZEROOPS_DATABASE_URL` usa o formato `mysql://utilizador:password@host:3306/zeroops`.

```powershell
Set-Location C:\devtools\httpdocs\ai-tools\ZeroOps
npm ci
npm run build
# Fornecer ZEROOPS_DATABASE_URL por canal privado, fora do repositorio.
npm run migrate
node dist\apps\api\src\bootstrap.js
npm start
```

O bootstrap pede a password num terminal privado sem a apresentar. Nao passar passwords por argumentos, chat ou ficheiros no webroot. Apenas cria o primeiro administrador; as restantes contas usam convites.

O primeiro administrador configura TOTP no primeiro login antes de entrar no portal. Sessao/password isolada nao permite ultrapassar MFA. Correr `npm run migrate` antes de arrancar uma nova versao; preservar contas/tickets. A organizacao de contas antigas fica por confirmar ate atribuicao explicita.

A identidade global e a pertença a projetos são separadas. Triggers do baseline criam pertenças para as contas sem promover automaticamente nenhum administrador à administração da instância. Numa instalação existente, designar explicitamente o administrador inicial através de `npm run identity:designate-instance-admin`; o comando requer terminal privado e invalida as sessões desse utilizador. A administração da instância lista/cria projetos e envia convite ao administrador inicial escolhido; só a aceitação desse convite cria a pertença. Sessões autenticadas ficam vinculadas a um projeto, e a seleção de outro projeto exige pertença ativa e cria uma sessão nova.

Os modulos de identidade incluem bloqueio de 15 minutos apos tres passwords erradas, recuperacao de 30 minutos, convites de 48 horas, gestao de contas e confirmacoes recentes de acoes sensiveis. PT-PT/EN aplica-se aos modulos 1/2 e emails, nao ao restante portal. Consultar [funcionalidades](funcionalidades.md) e [operacao](deploy/README.md).

Por defeito, abrir `http://127.0.0.1:4311`. A aplicacao so escuta em loopback. `ZEROOPS_PUBLIC_URL` define a origem autorizada e exige HTTPS fora de loopback; `ZEROOPS_PORT` controla a porta interna.

O programa nao carrega automaticamente ficheiros `.env`. Configuracao privada deve ser injetada pelo operador. A base tem de estar criada; as migracoes sao uma operacao explicita, nao um efeito lateral de um pedido HTTP.

O portal apresenta os bloqueios das integracoes. Pode ser utilizado para tickets e propostas humanas sem ligar o executor.

O formulario e o contrato de novos pedidos aceitam apenas Qualidade e Producao; um trigger em `sql/001_baseline.sql` protege tambem a base de dados. O baseline MySQL inclui revisoes de tickets, responsaveis por etapa e historico de correcao das mensagens.

Descricoes e respostas usam um editor Markdown com ferramentas e pre-visualizacao. O incidente abre na conversa: o pedido original e a primeira mensagem, seguido das respostas por autor. A conversa atualiza a cada 10 segundos enquanto a pagina esta visivel, preservando o rascunho. Notas internas continuam reservadas a equipa; o pedido original e apresentado sem criar um comentario duplicado na base.

O mesmo renderer trata Markdown na pre-visualizacao e nas mensagens, sem executar HTML nem carregar imagens externas. A mensagem original apresenta o nome atual do autor tambem aos outros membros autorizados do projeto. O autor humano pode corrigir a sua mensagem, sem apagar o historico; notas internas e respetivas revisoes permanecem ocultas para clientes. O estado Copilot e apresentado separadamente: nao existem respostas geradas enquanto a integracao real estiver por configurar.

O autor pode rever o pedido enquanto este está em estado novo; a equipa técnica pode fazê-lo nas etapas permitidas antes da execução. Cada revisão guarda antes/depois, ator e versão. Uma alteração invalida a versão corrente e devolve aprovações pendentes à análise; execução ativa/QA/deploy não pode ser editada por este percurso. A administração atribui quatro responsáveis distintos e ativos; propostas exigem os quatro perfis, apenas a pessoa atribuída decide cada gate e o responsável técnico não pode publicar a proposta que depois aprovaria.

Participantes adicionais são geridos no pedido; o autor e os responsáveis são obrigatórios. A equipa pode propor uma resolução sem código, confirmada pelo cliente atribuído sobre o hash exato. Alterações materiais preservam e invalidam decisões/trabalho anteriores; operações incertas exigem reconciliação. Projetos podem ser editados, arquivados e restaurados sem apagar dados.

A administração pode guardar configurações de integrações cifradas, rodar/revogar credenciais e testar SMTP autorizado. A configuração verificada é consultada pela API/worker, sem fallback para um segredo revogado. Os restantes adaptadores GenOps mantêm-se bloqueados até validação operacional.

Para login interativo de Qualidade, consultar [a shell SSH e o procedimento](./deploy/README.md#login-interativo-em-qualidade). Não guardar passwords em ficheiros nem no chat.

Para limites de módulos, dependências, uso de classes/funções e documentação, consultar [Arquitetura e convenções](docs/arquitetura.md).
O inventário mensurável, a cobertura TSDoc e as prioridades de decomposição estão em [Qualidade arquitetural](docs/qualidade-arquitetural.md).

Para desenvolvimento do frontend, executar o script `dev` do workspace web e configurar `ZEROOPS_PUBLIC_URL` para a origem exata apresentada pelo Vite; o proxy `/api` aponta para a API local.

## Validacao

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

Os testes de integracao arrancam uma MariaDB 10.3 temporaria em loopback (binarios portateis em `ZEROOPS_TEST_MARIADB_HOME`, por defeito `%LOCALAPPDATA%\zeroops-test\mariadb-10.3.39-winx64`), com porta e dados exclusivos, e encerram-na no fim. Em alternativa, `ZEROOPS_TEST_DATABASE_URL` aponta para um servidor de testes descartavel. Cada suite recebe uma base `zeroops_test_*` isolada e migrada. Nao usam bases pessoais, de qualidade ou producao.

`npm run test:browser` prepara fixtures e valida login, criacao, conversa e layout com Playwright/Edge. Nesta maquina, a politica empresarial bloqueou headless e DevTools: a verificacao visual nao passou e nao foi tentado qualquer contorno. Executar apenas num ambiente autorizado. O build e testes de API nao substituem essa verificacao.

O editor Markdown e a conversa foram verificados separadamente no browser integrado autorizado do VS Code, incluindo o seletor de ambientes, a pre-visualizacao por teclado e layouts desktop/mobile. Isto nao constitui um passe do ensaio standalone nem do ciclo de automacao completo.

`npm run format` aplica a formatacao. O build gera os bundles frontend finais; nao editar os ficheiros compilados.

## Onde alterar o codigo

| Local                                                         | Responsabilidade                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| [apps/web](apps/web)                                          | Portal React por funcionalidade, componentes e estilos.               |
| [apps/api](apps/api)                                          | Arranque NestJS, HTTP, cookies, CSRF e traducao de erros.             |
| [packages/contracts](packages/contracts)                      | Schemas publicos e tipos partilhados.                                 |
| [modules/identity](packages/backend/src/modules/identity)     | Utilizadores, convites, passwords e sessoes.                          |
| [modules/tickets](packages/backend/src/modules/tickets)       | Acesso aos tickets e conversas.                                       |
| [modules/workflow](packages/backend/src/modules/workflow)     | Propostas, transicoes e autoridade das aprovacoes.                    |
| [modules/flows](packages/backend/src/modules/flows)           | Fluxos de resolucao: definicoes, versoes, motor, assistente e acoes.  |
| [modules/metrics](packages/backend/src/modules/metrics)       | Calculos de tempos e agregacoes.                                      |
| [modules/executions](packages/backend/src/modules/executions) | Registo transacional de candidatos verificados.                       |
| [apps/executor](apps/executor)                                | Contrato Copilot CLI; nao instala uma sandbox nem concede permissoes. |
| [apps/worker](apps/worker)                                    | Processa o outbox MySQL e bloqueia entregas sem integracao.           |
| [sql](sql)                                                    | Migracoes SQL desta plataforma, com checksum e journal.               |
| [tests](tests)                                                | Integracao e fixtures isoladas; testes unitarios junto dos modulos.   |

As regras de negocio nao dependem dos controllers. O frontend nao importa os modelos do armazenamento. Nao criar um Store global, um controlador gigante ou um repositorio generico para todos os modulos.

Nesta base, os repositorios usam SQL parametrizado (`mysql2`) atraves do adaptador em `packages/backend/src/database`, que aceita placeholders `$n`. O ORM previsto no desenho inicial nao foi mantido como dependencia sem utilizacao; as migracoes SQL continuam explicitas e verificadas por checksum.

## Versionamento e dados

Nao foi criado/alterado qualquer remoto ou feito commit. O destino de versionamento do ZeroOps deve ser confirmado; a ferramenta antiga ja referencia um repositorio com nome semelhante.

O codigo Pizza Hut continua em SVN. Futuros fixes com alteracoes de BD devem incluir SQL em `sql` do projeto alvo. A pasta SQL deste repositorio e para a base MySQL do ZeroOps, nao para executar queries na Pizza Hut.

Nao copiar `.env`, dumps, bases, credenciais, anexos ou arquivos da Factory antiga. Os ficheiros de protecao na raiz recusam servir o checkout diretamente por IIS/Apache; o proxy de producao deve publicar apenas API e frontend compilado.

Consultar [operacao e gates](deploy/README.md).
