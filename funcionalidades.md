# ZeroOps — Módulos e funcionalidades

Documento de trabalho para definir o produto e evoluir as funcionalidades módulo a módulo.

Limpeza administrativa de tickets: CLI com dry-run, guard de projeto/BD/administrador,
verificação de dependências reais e rejeição de trabalho ativo/incerto; preserva Saúde,
gráficos e emails. Aplicação exige lease temporária com expiração automática, versão/digest dos
runtimes implantados e atestação administrativa recente de processos/artefactos;
runtimes antigos continuam a bloquear a operação real. Procedimento:
[`docs/ticket-purge.md`](docs/ticket-purge.md); SQL manual fora das migrações automáticas.

**Estado atual:** o código local cobre o portal, workflow, integrações, investigação Copilot e Saúde. Em 2026-11-10, foi publicada em QA apenas a atualização P1 do contrato/coletor de cron; no Production `.110`, foram instrumentadas 23 entradas HTTP Pizza Hut da crontab root, sem alteração do código do site. Uma amostra natural com as 23 tarefas chegou a QA. A execução natural de tarefas diárias ainda aguarda o respetivo horário; HTTP 2xx não prova sucesso de negócio. O ciclo global de implementação/release continua incompleto; os restantes dados remotos abaixo são históricos e não foram revalidados.

## Como ler este documento

- **Implementado:** existe na aplicação local.
- **Parcial:** existe parte do código ou das regras, mas falta completar a funcionalidade.
- **Por implementar/integrar:** não está disponível para utilização.
- **A definir:** requisito ou decisão a discutir; não descreve comportamento atual.

Os itens marcados **Decidido; falta implementar** são requisitos aprovados, mas ainda não funcionalidades entregues. A instalação e as integrações remotas continuam dependentes de validação/autorização próprias.

## Mapa dos módulos

| Módulo                                      | Estado atual                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Autenticação e recuperação de acesso     | Implementada; entrega SMTP em QA ainda não configurada                                        |
| 2. Utilizadores, perfis e acessos           | Identidade global e pertenças por projeto implementadas localmente                            |
| 3. Projetos e ambientes                     | Pertenças e seleção de projeto implementadas; só Pizza Hut configurado                        |
| 4. Pedidos e incidentes                     | Implementado em QA; anexos privados por fazer                                                 |
| 5. Conversa do pedido                       | Implementada; rascunho do Copilot reutilizável como resposta (revisão humana)                 |
| 6. Propostas e aprovações                   | Regras e interface implementadas; execução real por integrar                                  |
| 7. Investigação e implementação com Copilot | Investigação operacional em Qualidade; escrita governada em QA por fazer                      |
| 8. QA, releases e publicação                | Parcial: gates locais, sem preview/deploy operacional                                         |
| 9. Dashboard e métricas                     | Dashboard básico implementado; filtros/SLA e métricas avançadas por fazer                     |
| 10. Notificações                            | Outbox e worker implementados; entrega SMTP real ainda não configurada                        |
| 11. Histórico e rastreabilidade             | Implementado para eventos e decisões locais; incompleto para execução remota                  |
| 12. Integrações e operação                  | BD do site, Loki e Copilot geridos em Integrações; SVN/deploy desativados                     |
| 13. Saúde e alarmística                     | Implementada localmente; P1 de heartbeats cron instalado e em validação natural               |
| 14. Fluxos de resolução                     | Editor, assistente, execução, simulação e perfis ZeroOps com referências técnicas versionadas |

## General

### Decidido; falta implementar

- Interface e mensagens operacionais dos módulos 1–12 em PT-PT e EN, com preferência por utilizador e PT-PT como valor por omissão; não traduzir automaticamente o conteúdo escrito nos tickets.

## 1. Autenticação e recuperação de acesso

### O que já temos

- Formulário de login com **email e palavra-passe**; não existe um username separado.
- Validação das credenciais e mensagem de erro quando são inválidas.
- Palavras-passe guardadas com hash, não em texto simples.
- Sessões persistentes na base de dados, com validade limitada.
- Cookie de sessão HttpOnly; Secure quando configurado em HTTPS.
- Proteção de pedidos autenticados contra CSRF e validação da origem.
- Logout e tratamento de sessão terminada.
- Sessões de 8 horas, apenas emitidas depois dos fatores exigidos.
- Três palavras-passe erradas consecutivas bloqueiam a conta por **15 minutos**. Novas tentativas durante o bloqueio não prolongam o prazo.
- Desbloqueio automático ou por administrador após confirmação recente de identidade. O email de bloqueio é apenas um aviso, não permite desbloquear.
- Limites persistentes de pedidos de autenticação por IP e de operações sensíveis por conta; respostas públicas uniformes para credenciais inválidas/contas indisponíveis.
- TOTP por aplicação, incluindo Microsoft Authenticator: obrigatório para equipa técnica, QA, release e admin; opcional para cliente.
- MFA é exigida se a identidade tiver qualquer pertença privilegiada ativa ou for administradora da instância.
- Inscrição com QR/chave manual e confirmação de código; códigos de recuperação de uso único.
- Gestão da própria palavra-passe, nome, idioma, MFA e revogação de sessões.
- Interface e emails destes módulos em PT-PT/EN; restantes módulos ainda não foram traduzidos.

### Recuperar palavra-passe

- Formulário de pedido e reposição por ligação de uso único, válida 30 minutos.
- Novo pedido revoga as ligações anteriores. Alterar a palavra-passe limpa o bloqueio e revoga sessões/desafios, **sem remover MFA**.
- Adaptador SMTP e fila privada cifrada para entrega pelo worker. A configuração do relay local no servidor alvo ainda precisa de ser verificada.
- Sem transporte/chave configurados, apresenta indisponibilidade explícita, não um envio fictício.
- SMTP aceitar uma mensagem não prova a chegada à caixa de entrada; falhas e resultados incertos ficam registados.

### Regras confirmadas e condições de operação

- A decisão final foi **15 minutos**, substituindo a nota anterior de 10 minutos; sem MFA alternativo por email.
- Ações sensíveis exigem palavra-passe e MFA recentes quando configurado, com confirmação limitada à ação/alvo e validade de 5 minutos.
- Contas privilegiadas antigas exigem inscrição MFA no próximo login; sessões legadas sem prova MFA não permitem continuar.
- Configurar chaves privadas e SMTP por canal seguro e validar no destino antes de anunciar entrega operacional.
- Recuperação do único administrador sem MFA/códigos requer procedimento operacional privado, sem bypass público.

## 2. Utilizadores, perfis e acessos

### O que já temos

- Primeiro administrador criado por bootstrap explícito; não existe uma conta predefinida no produto.
- Administrador pode convidar pessoas indicando nome, email, perfil, organização e idioma.
- Ativação através de ligação individual, com definição da palavra-passe.
- Convites com expiração e uso único; sem registo público.
- Convites são colocados na fila privada de email; validade de 48 horas, com reenvio/revogação e consulta do estado de entrega.
- O email de convite é um guia completo: dados da conta (projeto, perfil, quem convidou, endereço de entrada), pré-requisitos (VPN, permissões, app autenticadora), entrada `hosts` (`ZEROOPS_ACCESS_HOSTS_IP`), confiança no certificado da CA privada (anexado a partir de `ZEROOPS_ACCESS_CA_FILE`, pasta `/etc/zeroops/access` montada só leitura), primeiro acesso com MFA e escolha da palavra-passe, utilização diária, tarefas do perfil e problemas frequentes. Perfis Cliente não recebem passos de MFA. Os detalhes são lidos no momento do envio, pelo que reenvios também os incluem.
- Pessoas novas recebem no convite uma **palavra-passe temporária gerada automaticamente** (`Xxxx-Xxxx-Xxxx-Xxxx`, guardada só como hash). Entram em `/login` com o email e essa palavra-passe; depois do MFA (se aplicável) são obrigadas a definir a sua palavra-passe antes de usar o portal (a API recusa outras alterações com `PASSWORD_CHANGE_REQUIRED`) e a temporária deixa de funcionar. Contas já existentes entram com a palavra-passe atual e recebem o projeto automaticamente no login.
- Convidar, editar utilizadores e reenviar entregas não pedem reconfirmação de identidade; desativar e revogar convites pedem apenas confirmação. Alterar email, revogar sessões, repor MFA, a própria palavra-passe/MFA e criar/editar projetos continuam a exigir palavra-passe + MFA.
- Autorização por projeto e perfil.
- A identidade global (email, password, MFA e nome) não duplica quando a pessoa é convidada para outro projeto; a ativação exige a password existente.
- Pertenças guardam papel, organização e estado por projeto. A seleção de projeto troca a sessão e a prova CSRF; sessões antigas e pertenças desativadas deixam de autorizar.
- As contas existentes são migradas para pertenças sem promoção automática à administração da instância; o bootstrap inicial é explícito.
- A administração da instância pode consultar utilizadores/projetos e criar projetos com reautenticação; o administrador inicial é convidado sem receber acesso automaticamente.
- Contas de cliente e administrador foram criadas para a preview de teste; não são contas permanentes nem credenciais do produto.
- Lista/pesquisa de utilizadores e edição de dados/perfil/organização.
- Administradores de projeto gerem pertenças/desativação e convites apenas no seu projeto. Gestão global de email, bloqueio, sessões e MFA está reservada à administração da instância.
- Proteção contra remoção do último administrador ativo, incluindo alterações concorrentes.
- Alteração global de email pelo administrador da instância com verificação do novo endereço; o anterior continua ativo até confirmação e recebe aviso.
- Reposição de MFA de outra conta pelo administrador da instância, com identidade verificada por procedimento humano, motivo, auditoria e email. Não pode repor o próprio MFA nem definir a palavra-passe de outra pessoa.
- Organização Cliente/Deloitte separada do papel de autorização. Contas antigas ficam com organização por confirmar, sem classificação automática pelo perfil.

### Perfis existentes

| Perfil            | Responsabilidade atual                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| Cliente           | Criar e acompanhar pedidos, responder publicamente e aprovar/rejeitar propostas.       |
| Equipa técnica    | Preparar propostas, fazer triagem e autorizar implementação.                           |
| Qualidade / QA    | Registar a decisão de validação na etapa de QA.                                        |
| Gestor de release | Autorizar a publicação na etapa de release.                                            |
| Administrador     | Criar convites e gerir o fluxo dos pedidos, sem substituir os aprovadores específicos. |

As permissões são verificadas pelo serviço, não apenas pela visibilidade dos botões.

### Parcial; falta implementar

- Gestão de projetos: criação, listagem, edição e arquivo/restauro versionados estão implementados; políticas e gestão completa da identidade global ainda faltam. Arquivar preserva dados, revoga convites e sessões do projeto e exige reconciliação de execuções/releases pendentes.
- Administrador de projeto continua limitado a pertenças/convites do próprio projeto; o convite do administrador inicial de um projeto novo exige SMTP configurado e aceite da pessoa.
- Manter organizações e autorização como conceitos separados; permissões por ambiente não substituem o papel nem os gates do ticket.

## 3. Projetos e ambientes

### O que já temos

- Workspace inicial Pizza Hut.
- Site (plataforma) por projeto (`pizzahut`, `pizzamovil`; `sql/016_project_site.sql`), escolhido em Administração → Projetos: define o código-fonte que o agente lê, as instruções por omissão do agente e o nome no prompt. Pizza Movil (www.pizzamovil.es / dev.pizzamovil.es, BD `pizzamovil`, código em `/var/www/vhosts/pizzamovil.es/httpdocs`, logs diários `log/<tipo>/AAAA_MM_DD.txt`) partilha os servidores da Pizza Hut; a sonda de QA resolve `dev.pizzamovil.es` para o servidor de QA (`extra_hosts` do blackbox, sem DNS público); cada projeto tem as suas integrações, Saúde, token do relay (instância própria, `install.sh --instance`) e token de alertas (rota `project="pizzamovil"` no Alertmanager).
- Pertenças de utilizadores a projetos, convites de um utilizador existente para outro projeto e seleção de workspace com sessão/CSRF próprios.
- **Criar projeto em popup:** a lista da instância apresenta o botão «Criar projeto», sem formulário permanente. O diálogo reúne nome, site, administrador inicial e logo opcional (PNG/JPEG/WebP/SVG até 256 KB, com pré-visualização). A confirmação de identidade é uma etapa sequencial; cancelar volta ao formulário sem perder os dados. Logo, projeto e convite inicial são gravados na mesma transação. O administrador inicial recebe um convite, não acesso automático.
- **Administrar projeto** (`#projects/<id>/geral`): cabeçalho com nome e logo e tabs **Geral**, **Utilizadores e acessos**, **Parâmetros e integrações**, **Saúde e notificações**. Geral reúne nome, cliente/organização, site e logo. Arquivo/reativação continuam reservados à administração da instância, com motivo e confirmação. O cliente é apenas um nome em `identity_organizations`, não uma entidade partilhada entre projetos; a migração `sql/022_project_client_organization.sql` preenche organizações em falta sem substituir nomes existentes.
- **Vários administradores por projeto:** gestão de pertenças, perfis e convites na tab Utilizadores e acessos. Administradores ativos e convites pendentes são apresentados separadamente; convites não contam como administradores ativos. Não é possível remover, desativar ou despromover o último administrador ativo. Dados globais da conta e ações de email/MFA/sessões não são alterados através da gestão de pertenças.
- **Configuração explícita por projeto:** a administração da instância pode gerir todos os projetos sem precisar de pertença; administradores de projeto gerem apenas os seus. As tabs reutilizam integrações por ambiente, agente e configurações de Saúde existentes, com endpoints administrativos validados para o projeto indicado. Abrir o detalhe não troca o projeto ativo da sessão nem concede acesso automaticamente. A mudança entre projetos elimina dados/formulários anteriores para evitar cruzar destinatários, versões ou configurações.
- Proteção contra acesso a recursos de outro projeto.
- No formulário de novos pedidos, ambientes **Qualidade e Produção**.
- O contrato/API rejeitam novos pedidos em Desenvolvimento; os triggers do baseline `sql/001_baseline.sql` também bloqueiam inserts e alterações para esse ambiente diretamente na base.
- Pedidos históricos em Desenvolvimento continuam legíveis e podem ter outros campos atualizados sem mudar o ambiente.
- A migração precisa de ser aplicada em cada base persistente antes de considerar a regra operacional nesse destino.

### Decidido; falta implementar

- Completar administração da instância e políticas por projeto.
- Clientes veem todos os pedidos públicos do projeto; notas internas continuam exclusivas da equipa.
- Separar configurações/destinos de Qualidade e Produção e impedir que credenciais fiquem disponíveis ao Copilot.
- Preservar dados históricos e garantir que múltiplos projetos não partilham tickets nem autorizações.

## 4. Pedidos e incidentes

### O que já temos

- Criar pedido com assunto, descrição, tipo, ambiente e prioridade.
- Tipos: incidente, erro, melhoria e esclarecimento.
- Prioridades: baixa, normal, alta e crítica.
- Referência automática do pedido, datas e versão.
- Descrição com editor Markdown, ferramentas de formatação e pré-visualização.
- Lista de pedidos, pesquisa por referência/assunto/descrição e filtros de estado/prioridade.
- Cada linha apresenta data e hora de criação e nome do criador, separados da última atualização; inclui a atividade recente da página inicial.
- Página de detalhe com conversa, contexto/proposta, histórico e metadados.
- Autor pode rever todos os campos antes da análise; a equipa técnica pode rever conteúdo nas etapas permitidas, com histórico de versões/autor/data e auditoria. As alterações incrementam a versão e devolvem aprovações pendentes à análise.
- Administração do projeto pode atribuir cliente, técnico, QA e release a quatro membros ativos, distintos e com o perfil correspondente. O criador cliente fica pré-atribuído; proposta não avança sem os quatro responsáveis e só a pessoa atribuída decide o respetivo gate.
- Ações de iniciar análise, pedir informação, retomar, cancelar e reabrir, conforme o perfil e o estado.
- O autor humano pode corrigir a própria mensagem, mantendo versões anteriores, autor/data e controlo de concorrência; correções são bloqueadas durante execução, QA, release e deploy.
- O histórico de correções de notas internas não é exposto a clientes.
- Gestão de participantes adicionais ativos do projeto, com organização/perfil visíveis e alterações auditadas; autor e responsáveis são participantes obrigatórios.
- Resolução sem alteração de código: a equipa publica uma resposta e o cliente atribuído confirma/rejeita a versão/hash exatos; não cria execução, QA nem release.
- Alterações materiais invalidam propostas, aprovações, resoluções e trabalho local dependente sem apagar o histórico. Operações ativas/incertas exigem reconciliação antes da alteração.

### Decidido; falta implementar

- Estender a invalidação ao supervisor e conectores quando existirem execuções reais dessas capacidades.
- Anexos privados: PNG/JPG/WebP/PDF/TXT/LOG/MD/CSV, até 10 MB por ficheiro, 20 ficheiros e 100 MB por ticket. Rejeitar ZIP, executáveis, HTML e SVG.
- Validar tamanho, extensão e conteúdo real; guardar fora do webroot; antivírus/quarentena é obrigatório. Se o scanner estiver indisponível ou falhar, bloquear download e processamento.
- Não acrescentar campos de impacto nem redefinir a escala de prioridade sem caso de uso aprovado.

## 5. Conversa do pedido

### O que já temos

- Conversa como vista principal do incidente.
- Primeira mensagem com o conteúdo original do pedido e a data de criação, sem duplicar esse conteúdo como comentário na base.
- Respostas identificadas por autor e data.
- Editor Markdown e pré-visualização também nas respostas.
- Mensagens públicas e notas internas para a equipa.
- Cliente não pode criar notas internas nem consultar as notas internas existentes.
- Atualização automática a cada 10 segundos enquanto a página está visível, sem apagar o rascunho.
- Renderização sem executar HTML ou carregar imagens externas.
- Estado explícito da integração Copilot; sem respostas automáticas simuladas.

O detalhe inclui o nome do autor, participantes e organização/perfil da pertença atual ao projeto. A conversa distingue estruturalmente pessoas, sistema e agente; o contrato de publicação humana não permite indicar uma origem de agente.

### Decidido; falta implementar

- Uma pessoa autorizada inicia/retoma a investigação explicitamente. Criar pedido ou enviar comentário não inicia Copilot automaticamente.
- Copilot só pode publicar resposta baseada em contexto público sanitizado. Evidências, contexto técnico e análise ficam internos até revisão/publicação humana.
- Exibir execução, progresso, perguntas, falhas e cancelamento; preservar o histórico e o rascunho do utilizador.
- Menções e notificações respeitam pertenças atuais do projeto e participantes autorizados.

## 6. Propostas e aprovações

### O que já temos

- Proposta estruturada: resumo, passos, critérios de aceitação e riscos.
- Versões e hash da proposta.
- Publicação/revisão de proposta pela equipa técnica ou administrador nos estados permitidos.
- Aprovação ou rejeição da versão concreta, com notas.
- Separação dos papéis de cliente, técnico, QA e gestor de release.
- Responsáveis nomeados por etapa, quatro pessoas distintas, ativos e com o perfil certo; proposta bloqueada se a atribuição estiver incompleta, decisões restritas ao responsável e responsável técnico impedido de aprovar a proposta que publicou.
- Validação da versão/hash para impedir aprovações obsoletas.
- Regras de rejeição, revisão e transição de estado.
- Quando implementação/deploy estão indisponíveis, a autorização é recusada sem consumir a aprovação.

### Fluxo pretendido

Pedido → análise → proposta → aprovação do cliente → autorização técnica → implementação → testes → QA humano → aprovação da release → publicação → verificação → resolução.

**Este fluxo está modelado, mas não está operacional de ponta a ponta.**

### Decidido; falta implementar

- Cliente e técnico aprovam a versão/hash exatos antes de iniciar implementação; testes independentes e QA humano aprovam o candidato exato.
- Após QA, operador faz o commit SVN do candidato. O responsável de release aprova a revisão resultante e o destino exatos antes do deploy.
- Ligar os futuros executores/conectores aos controlos de invalidação já implementados no portal.
- Associar notificação, prazo/escalamento configuráveis e registo de decisão a cada aprovador, sem substituir a decisão humana.

## 7. Investigação e implementação com Copilot

### O que já temos — parcial

- Contrato de adaptador Copilot CLI e de processo isolado.
- Validação de relatórios, caminhos, hashes e resultados incompletos/interrompidos.
- Contrato de manifesto de candidato: revisão SVN, ficheiros, SQL e evidências.
- Registo interno transacional de candidato verificado para passagem a QA.
- Distinção entre testes sugeridos pelo modelo e testes verificados independentemente.
- Investigação genérica por ticket: botão **Investigar** (com instruções opcionais) para equipa técnica/admin, fila `agent_runs`, progresso, cancelamento, conclusão, evidências, consultas a conectores auditadas e resposta final proposta. **Rever e enviar ao cliente** preenche o editor do separador Cliente; o envio da resposta final é sempre humano. Não existe lógica por tipo de pedido: o Copilot decide o que consultar a partir do ticket.
- Canal do cliente separado do trabalho da equipa: no ticket, a equipa tem os separadores **Cliente** (mensagens públicas, resposta proposta pelo Copilot por rever e editor público) e **Equipa · Copilot** (investigação, passos, custo e notas internas); o cliente só vê a conversa pública, e as mensagens do agente aparecem-lhe como «Equipa de suporte». As perguntas que o agente precisa de fazer ao cliente (`clientQuestions`, até 5) são enviadas automaticamente como mensagem pública e o ticket passa a `awaiting_information` (opção «Enviar perguntas ao cliente automaticamente» em Integrações, por projeto: `projects.agent_auto_client_questions`). Quando o cliente responde, é criado um novo run (`run_trigger='client_reply'`) e o ticket volta a `investigating`; após 3 retomas seguidas sem intervenção da equipa fica uma nota interna «Revisão necessária». Migração `sql/015_agent_client_messages.sql`.
- Executor em contentor (`executor`): Copilot CLI lançado com uid 1000, workspace em tmpfs, código de cada site montado só de leitura em `/sources/<site>` (`pizzahut`, `pizzamovil`) com os ficheiros de credenciais substituídos por ficheiros vazios; cada run usa o código do site do projeto do ticket. O token Copilot vem da integração `copilot` do projeto (cifrada na BD); sem integração verificada o run falha com `copilot_not_configured`.
- Serviço de conectores (`connectors`, 127.0.0.1:4312): comandos `zo-sql` e `zo-loki` disponíveis ao agente apenas com o token do run ativo. As credenciais da BD do site e do Loki vêm da página Integrações (tipos `database` e `telemetry`) e só são usadas depois de **Testar ligação**.
- SQL só de leitura (validação da query, `START TRANSACTION READ ONLY`, `ROLLBACK`, limites de linhas/tempo, redação de colunas sensíveis) e auditoria de todas as chamadas no run.
- Conversa interativa no ticket (via `@github/copilot-sdk`): texto do Copilot em streaming (SSE com polling de recurso), ferramentas e servidores MCP usados, permissões recusadas, perguntas do agente (`ask_user`) e aprovação de plano respondidas na interface, e mensagens de seguimento na mesma sessão. O tempo à espera da equipa não conta no timeout; sem resposta (10 min por omissão) o agente continua com a melhor suposição. Eventos em `agent_run_events`, entradas em `agent_run_inputs` e auditoria `agent.run_answer`/`agent.run_message`. `ZEROOPS_COPILOT_TRANSPORT=cli` repõe o modo não interativo.
- Investigação automática: cada ticket novo (criado na interface, por cliente ou pela Saúde) é posto na fila do Copilot com `run_trigger='auto'` se o projeto tiver a integração Copilot verificada. Se o criador for cliente, o run fica em nome de um administrador/técnico do projeto. Desliga-se em Integrações → **Automatismos** («Investigar automaticamente cada pedido novo com o Copilot», `projects.agent_auto_investigate`, migração 017).
- **Chat da equipa** (separador Equipa · Copilot): conversa em bolhas com fotografia (ou iniciais) e robot para o Copilot; abre na última mensagem e carrega anteriores em grupos de 20. **Ver interações (N)** expande ferramentas, evidências e perguntas ao cliente. Compositor único para perguntar ao agente ou adicionar uma nota interna. Fotografia em **A minha conta** (PNG/JPEG/WebP até 512 KB; migração 023).
- Notas automáticas do sistema aparecem em mensagens identificadas, alinhadas à esquerda, preservando as quebras de linha dos relatórios antigos. Os novos resumos do agente devem destacar o resultado, os factos confirmados, o que falta confirmar e o próximo passo, sem repetir todo o histórico.
- **Seleção Copilot / Local:** ambos executam no servidor ZeroOps, com as mesmas permissões e modelos da conta Copilot. Copilot oferece **Fusion Standard/High/Max**, quando autorizados, e modelos individuais; Local oferece a seleção tradicional Auto/modelos individuais. Local não significa LLM offline, gratuitidade ou execução no computador do utilizador. Fusion Standard é a escolha inicial na ausência de uma preferência explícita. A seleção fica guardada por investigação e bloqueada durante o run; recusa de Fusion exige outra escolha, sem fallback silencioso. Catálogo via `models.list` do runtime, incluindo tiers, disponibilidade e promoções; no SDK, Fusion usa o modelo virtual `auto` e o `autoTier` opaco anunciado pelo serviço, equivalente a `copilot --model fusion --fusion-tier <nível>` no CLI. Migração `sql/025_agent_run_fusion_modes_and_usage.sql`.
- **Consumo reportado:** separar encaminhamento pedido e modelos realmente usados. Créditos de IA vêm do valor `copilotUsage.totalNanoAiu` reportado pelo serviço, dividido por mil milhões; premium requests só aparecem quando essa unidade é aplicável e reportada. Tokens de entrada, saída e cache ficam separados no detalhe. Dados ausentes ou históricos sem prova de faturação não aparecem como zero ou gratuitos; subtotais incompletos são identificados. Não calcular custos pelos tokens nem aplicar novamente descontos sobre valores faturados pelo Copilot. Promoções no seletor só aparecem quando anunciadas pelo runtime e dentro da sua validade.

### O que ainda não temos

- Aplicação real de fixes e execução independente dos testes.
- Ciclo completo de proposta e implementação automática.
- Leitura de anexos (PDF/imagens) pelo agente.
- Diagnóstico de Produção a partir da instância de Qualidade (as integrações usadas são sempre as do ambiente da instância).

### Risco aceite

- Em Qualidade, o conector de BD usa o utilizador do site (`pizzahut`, com escrita). A proteção de leitura depende do conector (validação + transação read-only + rollback + auditoria), não de permissões da BD. Para Produção usar um utilizador MySQL só de leitura.

### Decidido; falta implementar

- Antes de enviar contexto, confirmar identidade corporativa, licença e política de dados/modelo. Até essa confirmação, a aplicação funciona sem IA.
- Guardar credenciais de integração introduzidas pela app cifradas na BD, com escopos por projeto/ambiente, teste, auditoria, rotação e revogação. Chave-mestra e bootstrap DB ficam fora da BD.
- Autenticar Copilot por mecanismo oficial e compatível. OAuth/device-code dentro da app só após provar suporte e persistência segura; não partilhar conta pessoal.
- Limitar a uma execução ativa por pedido, duas investigações simultâneas por projeto e uma implementação por projeto; definir quotas e timeout com base na capacidade QA validada.
- Sandbox Linux isolada sem root, credenciais, sockets ou acesso livre à rede; ferramentas e egress por allowlist. Separar investigação de escrita, testes independentes e operador.
- Diagnóstico de Produção só por autorização técnica por execução/fonte, escopo e expiração; conectores fazem consultas read-only e minimizam dados antes de compor contexto.
- Falhas incertas ficam bloqueadas para reconciliação; nunca repetir automaticamente efeitos potencialmente duplicados.

## 8. QA, releases e publicação

### O que já temos — parcial

- Estados e decisões separados de QA e release.
- Aprovações ligadas a hash/versão do artefacto.
- Validação interna do manifesto de candidato.
- Bloqueio explícito da publicação quando a integração não existe.

### O que ainda não temos

- Preview real do artefacto em qualidade.
- Percurso completo de QA sobre alterações produzidas pelo executor.
- Operador de publicação SVN e deploy automático.
- Verificação pós-publicação e recuperação operacional ensaiada.

### Decidido; falta implementar

- QA humano independente aprova o hash exato após testes executados fora do modelo e preview em Qualidade.
- Operador SVN separado commita só o candidato e paths aprovados após QA; pessoa de release aprova a revisão SVN resultante, alvo e provas antes do deploy.
- Migrações SQL versionadas com o artefacto, backup/restauro e compatibilidade verificados; alterações destrutivas exigem autorização explícita.
- Prechecks e health checks pós-publicação; resultado incerto/falhado interrompe o fluxo e exige reconciliação humana.
- Rollback só pode automatizar-se depois de autorização e ensaio seguro; na ausência deles, parar/escalar.

## 9. Dashboard e métricas

### O que já temos

- Dashboard com indicadores e pedidos.
- Total, abertos e resolvidos.
- Tempo até à primeira resposta pública humana da equipa; mensagens automáticas e notas internas não contam como primeira resposta.
- Tempos corridos, de espera e nos restantes estados.
- Indicadores de resolução e tratamento de reaberturas nos cálculos.
- Sem metas contratuais de SLA presumidas.

Tempo nos estados de trabalho não significa horas efetivamente trabalhadas por uma pessoa.

### Decidido; falta implementar

- Filtrar/segmentar por período, prioridade, ambiente e responsável; apresentar medianas e tendências com exportação autorizada.
- Editor de SLA com horário/calendário Europe/Lisbon, feriados, metas por prioridade/ambiente e regras de pausa. Políticas novas ficam em rascunho até aprovação; não inventar metas contratuais.
- Registar esforço humano em lançamentos auditados, separado do tempo de estado e do tempo de execução IA.

## 10. Notificações

### O que já temos — parcial

- Eventos de tickets e outbox transacional, com estado de entrega separado, reclamação com lease e resultado incerto não repetido automaticamente.
- Worker e fila durável; emails para criação/alteração de ticket, respostas e participantes usam apenas SMTP verificado.
- Mensagens de email não incluem descrição, conteúdo de comentários ou notas internas; notificações sem SMTP ficam bloqueadas, não marcadas como enviadas.
- Os emails de pedidos, Saúde e convites mostram no cabeçalho o **projeto em destaque com o logotipo do cliente** («Notificação via ZeroOps»). O logo é convertido em PNG (40 px de altura, proporção mantida; SVG rasterizado com `@resvg/resvg-js`) e segue como anexo inline (CID), porque o Outlook não mostra SVG nem imagens remotas e o portal não é público. Sem logo (ou WebP) aparecem as iniciais do projeto; emails sem projeto (recuperação de acesso) mantêm a marca ZeroOps.

### O que ainda não temos

- Validação de entrega operacional de email em ambiente real, incluindo convites e recuperação de acesso.
- Centro de notificações no portal.

### Decidido; falta implementar

- Centro de notificações e emails mínimos com link para atribuições, menções, respostas, aprovações pendentes, QA/release, falhas e escalamentos.
- Resolver destinatários pela pertença/acesso atual ao projeto e ticket; preferências aplicam-se a eventos não obrigatórios.
- Nunca incluir notas internas ou segredos no conteúdo de email. Falhas, estados incertos, limites de repetição e reenvio ficam explícitos e auditados.

## 11. Histórico e rastreabilidade

### O que já temos

- Histórico de estados do pedido.
- Datas/autores nas conversas.
- Propostas versionadas e decisões ligadas a versão/hash.
- Identificadores de pedido HTTP para acompanhar erros.
- Eventos/outbox gravados nas transações de negócio relevantes.

### Decidido; falta implementar

- Guardar versões/auditoria de pedidos, mensagens, pertenças, configurações e decisões sem permitir apagar conteúdo histórico pela interface.
- Rastrear ticket → execução → fontes/evidências → diff/SQL → testes → QA → revisão SVN → release → verificação.
- Auditoria append-only na aplicação, pesquisa/exportação restritas e auditadas; não afirmar imutabilidade externa.
- Configurar retenção e legal hold, com simulação de limpeza; sem apagar automaticamente tickets, histórico ou anexos enquanto não houver política e âmbito aprovados.
- Evidências privadas têm controlo de acesso por projeto/ticket e nunca são expostas a cliente automaticamente.

O histórico atual não equivale a uma auditoria externa imutável.

## 12. Integrações e operação

### O que já temos

- Página com estado das capacidades e explicação dos bloqueios.
- Base MySQL/MariaDB própria do ZeroOps e migrações explícitas.
- API, frontend, worker, executor e serviço de conectores separados por responsabilidade (Docker Compose em Qualidade).
- Comandos de tipos, lint, testes, formatação e builds.
- Preview local sem ligação implícita aos servidores Pizza Hut.
- Interface administrativa de integrações por projeto/ambiente e SMTP da instância; valores sensíveis cifrados com AEAD e chave externa, respostas sem credenciais, reautenticação, teste, rotação e revogação auditados.
- SMTP guardado na BD só é utilizado após teste real de ligação/autenticação e validação da allowlist externa; alterar configurações exige novo teste. Revogar impede recair na configuração de bootstrap.
- Os testes de BD do site (`SELECT 1`), telemetria/Loki (`/loki/api/v1/labels`), Prometheus e Copilot (`GET api.github.com/user` com o token) são reais; endpoints de BD/Loki/Prometheus têm de ser internos ou constar de `ZEROOPS_CONNECTOR_ALLOWED_ENDPOINTS`. SVN/documentação/sandbox/deploy continuam a recusar ativação enquanto não houver adaptador validado. Um teste GitHub bem-sucedido comprova autenticação, não disponibilidade Fusion nem publicação automática.
- A verificação só ativa a versão exata testada; uma alteração concorrente descarta o resultado. Copilot é uma integração partilhada do projeto, guardada no âmbito técnico `quality`; uma linha legada `production` não é uma segunda credencial runtime a ativar por omissão.
- Shell de login SSH QA em `deploy/quality-login.ps1`, sem guardar passwords e sem executar instalação.
- Portal instalado em Qualidade em `https://tickets.pizzahut.pt` (vhost Apache com TLS de CA de QA, entrada `hosts` na máquina de teste).

### Decidido; falta implementar

- Primeiro instalar portal persistente em Qualidade, após inventário e acesso autorizado; depois instalar instância ZeroOps de Produção só após piloto e aprovação específica.
- URL QA escolhida: `https://tickets.pizzahut.pt`, resolvida por entrada `hosts` apenas na máquina de teste para o alvo QA. Validar vhost/TLS; não alterar DNS de Produção.
- Configurações operacionais são geridas pela aplicação, com valores sensíveis cifrados na BD. A chave-mestra, bootstrap DB e identidade mínima de serviço permanecem fora da BD, webroot e Git.
- ZeroOps é versionado em Git; código Pizza Hut continua em SVN. Definir remote privado/CI antes de publicar, sem assumir fornecedor nem acionar deploy não relacionado.
- Confirmar identidades técnicas individuais e separadas para API/worker, conectores, sandbox e operador; não usar conta root partilhada nem executar processos como root.
- Configurar SMTP, Copilot, fontes read-only, execução e publicação por capacidades verificadas; guardar segredo nunca significa ativar integração automaticamente.
- Provisionar backups/restauro, observabilidade e tratamento de falhas/resultado incerto antes de aceitar dados reais.

## 13. Saúde e alarmística

### O que já temos

- Cada gráfico permite substituir o período global (e voltar a segui-lo), comparar individualmente e **Ampliar** num diálogo nativo, mantendo zoom e séries ocultas. Os controlos por cartão usam opções curtas («Global», «Tudo», «24 h», «7 d»…) e ícones para comparar/ampliar/fechar, com tooltips, nomes acessíveis e estado ativo da comparação. O tooltip do seletor identifica o período global efetivo. A alteração individual consulta apenas o identificador desse gráfico; não altera os restantes nem o mapa de calor. `all` e `395d` não comparam com períodos anteriores.
- Os gráficos têm marcadores amarelos para emails de alerta realmente aceites pelo SMTP (`sent_at`), vermelhos para falhas confirmadas de sondas HTTP ou DB2 funcional e azuis para janelas/paragens planeadas. Uma falha do exporter ou a ausência de métricas não cria indisponibilidade. As durações de confirmação reutilizam as regras administráveis do projeto; o silêncio, os fins de semana e Europe/Lisbon são respeitados, sem estes marcadores enviarem notificações.
- O worker guarda ocorrências em histórico independente de tickets, incluindo início observado, confirmação, recuperação e lacunas de observação. As janelas são registadas quando o worker as observa, mesmo sem sonda; **não comprovam falha**. Não se fabricam indisponibilidades anteriores à instalação desta versão. Emails antigos sem ambiente histórico conhecido são identificados como contexto geral do projeto, não atribuídos retroativamente a um ambiente.
- Eventos próximos são agrupados visualmente com contagem; o detalhe conserva timestamps originais, recursos, confirmação e recuperação, com paginação explícita. Eventos do ambiente que não correspondam ao servidor filtrado são identificados como contexto. SMTP não garante chegada à caixa de correio e a hora observada pela sonda não equivale à hora exata de falha entre recolhas.
- Estas alterações requerem a migração aditiva `sql/029_health_chart_events.sql` e o rollout conjunto de API/worker/frontend; um push para o remoto QA executa esse procedimento automaticamente.
- Página **Saúde** (`#health`, equipa; configuração só para administradores) organizada em tabs com endereço próprio (`#health/<tab>`): **Resumo** (criticidade e alertas ativos), **Alarmística** (as verificações e respetivo histórico; administradores podem ativar **Editar alarmística**, alterar regras e associar um flow publicado a cada alerta), **Histórico**, **Notificações** e **Configuração** (sub-tabs Geral e URLs, Paragens planeadas, Destinatários, Limites e Agente do servidor; só administradores). Sem flow associado, o ticket segue o flow de incidente predefinido; a associação de flow é gravada ao escolher, e as alterações às regras ao carregar em **Gravar regras**. Os alertas têm **Confirmar receção** e **Atribuir**. A configuração inclui URLs, listas de destinatários com nome e encaminhamento por criticidade/relatório/alarme, limites, ambiente das fontes/SMTP e hora do relatório.
- **Histórico por alarme** (`#health/historico/<verificação>`, `GET /api/monitoring/history?days=1..90&check=`): cada ocorrência (interna ou do Prometheus) mostra quando abriu, a duração, quem confirmou a receção, o responsável e a cronologia de eventos (aberto, agravado, lembrete, receção, atribuição, ticket, resolvido) junto com os avisos enviados (canal, destinatários, estado e erro). A tab **Notificações** lista todos os envios do período. Os eventos ficam em `health_alert_events` (migração 012, com backfill dos alertas existentes) e são guardados durante 1 ano.
- Worker executa um ciclo por minuto por projeto ativo: recolhe, grava estado/amostras, abre/atualiza/resolve alertas e envia e-mails pela fila `health_notifications` (até 3 tentativas). Relatório diário de disponibilidade e desempenho por e-mail.
- Fontes, todas só de leitura: agente bash no servidor (`deploy/health-agent`, token `zoh_` gerado na página, só o hash fica guardado), sondas HTTP externas, BD do site (integração `database` do ambiente de origem) e logs Loki (integração `telemetry`). Sem dados, a verificação fica "Sem dados" e não abre nem fecha alertas.
- Regras de alerta: confirmação mínima por verificação, notificação ao abrir, ao agravar e ao resolver; lembretes enquanto sem receção (urgente 15 min, crítica 30 min, preventiva 4 h).
- **Prometheus/Alertmanager** (`deploy/observability/`, serviços no Docker Compose, só em `127.0.0.1`): Prometheus (retenção 95 dias/6 GB), Alertmanager e exporters node, Redis, MySQL (utilizador `zeroops_exporter` só com `PROCESS`, `REPLICATION CLIENT`, `SELECT`) e blackbox (sondas HTTP a `encomendar.pizzahut.pt`, QA e ZeroOps). A label `env` separa ambientes. Segredos fora do Git: `/etc/zeroops/observability.env` e `/etc/zeroops/observability/alertmanager-token`. O deploy recria estes serviços após o health check, sem afetar o rollback da aplicação.
- Integração **Métricas** (`metrics`: URL do Prometheus, matchers, token opcional) por ambiente. O coletor de saúde usa primeiro o Prometheus para servidor/serviços, disco, inodes, CPU/memória e Redis e cai para o agente bash quando o Prometheus não tem dados (`details.source`). O agente de investigação consulta métricas com `zo-prom` (instantâneas e intervalos, filtradas pelos matchers do ambiente).
- Webhook `POST /api/monitoring/alertmanager` (token `zoh_` do agente de saúde): grava em `health_external_alerts` com deduplicação por fingerprint, envia e-mail pelas listas configuradas e abre um **incidente** (ticket automático) para alertas `critical`/`page` (prioridade alta/crítica). `warning` → preventiva e `info` → informativa (só e-mail/painel).
- **Incidentes de Saúde** (`health_incidents`, migração 017): um ticket por incidente. Um alerta do mesmo ambiente (QA/Produção) junta-se ao incidente ainda não fechado desse ambiente se tiver começado até 10 min depois do primeiro alerta do incidente (cascata, ex.: MySQL em baixo + site indisponível); uma falha que começa mais tarde (ex.: disco cheio a meio de uma queda do MySQL) abre outro incidente; a causa provável é o alerta mais «de base» (BD/serviço antes do site) e o título fica `[Saúde][QA|Produção] <causa> (+N alertas)`. Ambientes diferentes dão incidentes separados. O ticket é investigado automaticamente pelo Copilot (ver secção 7). Quando todos os alertas recuperam, o incidente passa a `recovered` e é pedida ao Copilot uma **análise pós-incidente** (`run_trigger='incident_review'`): o que aconteceu, causa, impacto e prevenção. No fecho ficam no ticket: nota interna «Relatório do incidente» (resumo com início, fim, duração e **valor da métrica antes e depois** da causa provável, causa provável, cronologia, avisos enviados e tabela de alertas com o valor antes → depois de cada um), a análise do Copilot e uma **mensagem pública ao cliente** (início, serviço reposto, duração, valor medido e texto proposto pelo Copilot, ou mensagem padrão se não houver Copilot ou a análise falhar). Os valores (migração 020, `metric_before`/`metric_after`) são lidos do Prometheus do ambiente (integração Métricas) quando o incidente recupera: a expressão da regra sem o limite (ex.: `mysql_up == 0` → `mysql_up`) é avaliada no disparo e na recuperação e mostrada de forma legível («Indisponível (0)», «4,2 %», «12 dias», «1,5 s»); regras sem limite simples (`absent_over_time`, `and`) ou falhas na leitura mostram «—». O ticket passa a `resolved` e o incidente a `closed`. Se o run da análise terminar sem passar pelo fecho (ex.: executor reiniciado), o worker retoma-o no ciclo seguinte. Com o ticket já em trabalho pela equipa (implementação, QA, etc.), só é acrescentada a nota, sem mudar o estado. Um alerta que volta a disparar antes do fecho reabre o incidente; depois de fechado, abre-se um incidente novo.
- O assunto do e-mail e o título do ticket usam o nome legível da anotação `title` de cada regra do catálogo (`packages/contracts/src/alert-rules.ts`) (ex.: «MySQL indisponível»); sem `title`, o `alertname` em CamelCase é separado em palavras. O nome técnico fica no campo «Alerta».
- Resiliência à queda da BD do ZeroOps (que em QA partilha o MariaDB monitorizado): o token do agente já validado fica em memória até 24 h e só é usado se a BD falhar (o remote write de Produção continua a chegar); os webhooks do Alertmanager que não puderam ser gravados vão para a fila em disco `ZEROOPS_ALERT_SPOOL_DIR` (volume `alert-spool`, máx. 500 ficheiros), guardados com o hash do token, que só é validado ao reprocessar (descartados se inválido). Nos endpoints com token (webhook, ingest, remote write, relay), se a BD do rate limit falhar, a contagem passa a ser feita em memória, para o pedido chegar à fila. A fila é reprocessada por ordem a cada 30 s e antes de cada novo webhook. Na mesma tarefa de 30 s, a API reconcilia com o Alertmanager local (`ZEROOPS_ALERTMANAGER_URL`, por omissão `http://127.0.0.1:9093`; vazio desliga): um alerta que o ZeroOps ainda tem como ativo e que falta em `/api/v2/alerts` há mais de 5 minutos é resolvido como se tivesse chegado o «resolved» (fecha o ticket, com nota), o que cobre resoluções perdidas em reinícios. No sentido inverso, um alerta ativo (não silenciado nem inibido) no Alertmanager há mais de 90 s que o ZeroOps não tem como ativo é registado como se tivesse chegado o webhook (abre o ticket, com nota): cobre notificações perdidas e a deduplicação do Alertmanager, que não volta a notificar um grupo cuja resolução nunca enviou até ao `repeat_interval` (30 min; o ZeroOps ignora as repetições de um alerta já ativo, por isso a repetição só serve de nova tentativa). O projeto é o do registo anterior do alerta ou o do último alerta recebido com a mesma label `project`. Se o Alertmanager não responder, nada é alterado. Se só chegar a resolução de um alerta, o ZeroOps regista-o, abre o ticket e fecha-o logo, com a nota «disparo não recebido em tempo real». Durante a queda não há e-mail (a fila SMTP está na BD): os avisos saem quando a BD volta.
- **Métricas de Produção por push** (`deploy/production-metrics/`): exporters node, MySQL e Redis e um Prometheus em modo agente, tudo em `127.0.0.1`, com utilizador sem privilégios, `Nice=19` e limites de CPU e memória. Enviam por `remote_write` para `POST /api/monitoring/remote-write` (token `zoh_`), que encaminha para o Prometheus do ZeroOps com `env="production"`. Só seguem as séries usadas pela Saúde e pelas regras. A regra `MetricasProducaoAusentes` avisa quando deixam de chegar.
- **Tab Gráficos** (`#health/graficos`, `GET /api/monitoring/charts?panel=&range=&env=&compare=` e `/api/monitoring/charts/heatmap`): sub-tabs Servidores, Apache e PHP, MySQL, Redis, DB2 (IBM i) e DTQ e Sites e APIs; ambiente QA ou Produção; períodos de 1 h a 13 meses, com comparação opcional com o período anterior. Indicadores em percentagem (disco, RAM, CPU, inodes, disponibilidade) e séries temporais em SVG por servidor/papel (`db`/backend `.110`, `frontend` `.112`, `static` `.109`, `qa`), organizados por categoria numa grelha que preserva a largura dos cartões mesmo quando sobra um gráfico. Tooltips limitadas à largura do gráfico. Mapa de calor dia × hora e média por dia do mês: quando a métrica tem limites, a escala é absoluta (verde até ao aviso, laranja entre aviso e crítico, vermelho a partir do crítico), invertida na disponibilidade; a legenda mostra aviso, crítico e o pior valor do período. Sem limites definidos, a escala é relativa ao período. O Prometheus do QA guarda 95 dias/6 GB; o worker agrega médias horárias em `health_metric_hourly` (migração 013), que servem os períodos mais longos até 13 meses.
- **Armazenamento e métricas adicionais:** disco local separado de NFS/CIFS/SSHFS, evitando contar o disco remoto como ocupação local. Há gráficos de swap, débito de disco, partilhas de rede, erros de montagem/read-only, ligações TCP, erros/descartes de rede e retransmissões, pedidos nginx, tabelas temporárias em disco, tráfego, bloqueios e ligações abortadas MySQL, fases dos pedidos HTTP e validade dos certificados. O agente de Produção envia as séries necessárias. As regras locais de disco/inodes excluem partilhas; `PartilhaRedeIndisponivel` vigia erros de leitura das partilhas e `PartilhaRedeQuaseCheia` vigia espaço livre nas externas (exclui dispositivos `172.16.1.*`).
- **Linhas amarelas por gráfico:** apenas emails de alerta realmente enviados (`sent_at`, aceitação SMTP), associados pela regra/verificação e pelo recurso medido, nunca pelo assunto ou corpo. A associação é capturada ao enfileirar a notificação em `chart_context` ([migração 032](sql/032_health_notification_chart_context.sql)); repetições não reescrevem o passado. `CargaCpuElevada` pertence a **Carga por núcleo**, não a **CPU** nem a **CPU IBM i**; verificações compostas só marcam a medida que ultrapassou o limite. Ambiente, servidor, discos e ocorrência não se misturam na agregação. Emails anteriores ou sem origem/recurso/ambiente comprovado continuam no histórico de notificações, sem linha; não se faz backfill a partir de labels ou estados mutáveis. Os coletores legados sem identificação do ambiente/recurso, como as amostras do agente de host, não ganham associações por suposição. As linhas de falha/paragem planeada não são alteradas.
- **Idioma PT/EN:** seletor com bandeiras SVG na barra do topo, disponível sem abrir o menu da conta. A escolha é guardada no perfil, com reversão e mensagem de erro se a gravação falhar. Saúde, gráficos (57 títulos, categorias e descrições com versão EN na API), dashboard e tickets adaptam textos e formatos ao idioma; conteúdos dos tickets, respostas do agente e dados dos exporters não são traduzidos.
- **Coletor por papéis em Produção** (`deploy/production-metrics/install.sh --role db|frontend|static`): workers Apache (`mod_status`) e nginx em `127.0.0.1:8088`, pools PHP-FPM, tamanho/ping/buffer do MySQL, hit ratio do Redis, I/O de disco, rede e DB2 IBM i (`zeroops-db2.php`, só leitura), tudo exposto pelo node exporter como `zeroops_*`.
- **DB2 e DTQ de clientes (login)**: sonda ativa a cada 5 min ao endpoint real `/api/v1/dtq/users/` com a conta de testes (`zeroops-dtq.php`, via Apache/PHP-FPM local, só consulta) e contagem incremental de pedidos, respostas e erros no `dtq.log` do site (falhas reais do login = pedidos `ULTPEDTQR2` sem resposta). Gráficos no grupo «Filas DTQ (login dos clientes)» da sub-tab DB2 e alertas do grupo `ibm_i` (DB2 indisponível/lento, jobs e ASP acima de 90%, métricas do DB2 ausentes, DTQ indisponível/lento, taxa de falhas acima de 5% e erros no log). O agente de investigação conhece estas métricas (`zo-prom`) nas instruções da Pizza Hut. Paragem noturna do IBM i (01:00–07:00, todos os dias): em **Saúde → Configuração → Paragens planeadas** define-se, por projeto, o horário, o fuso, os dias da semana e os alvos — verificações do worker, regras do Prometheus (`rule:`) e sondas dos coletores (`probe:dtq`, lida pelo coletor ao ZeroOps). Na Pizza Hut a janela vai das 00:30 às 07:30 e abrange as sondas do site, da app e da `api-public`, o tempo de resposta, os erros da aplicação, as falhas de login, as tarefas agendadas, as regras do DB2, do DTQ e do site e a sonda do DTQ. Os alertas do Prometheus abrangidos ficam silenciados no ZeroOps e, se continuarem ativos no fim da janela, são notificados nessa altura. Dentro da janela não se abrem alertas nem se enviam lembretes, e o painel continua a mostrar o estado real.

| Criticidade | Canais                                     | Verificações                                                                                                                                                                                                    |
| ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Urgente     | Painel, e-mail, SMS, chamada (com receção) | Servidor/serviço indisponível, site indisponível, app/APIs indisponíveis, encomenda paga não integrada                                                                                                          |
| Crítica     | Painel, e-mail, SMS                        | CPU/memória, tempos de resposta, BD lenta/saturada, Redis, armazenamento de suporte, pagamentos Shift4, pagamentos MEO Wallet/MB WAY, divergência pagamentos/encomendas, tarefas agendadas, erros aplicacionais |
| Preventiva  | Painel, e-mail                             | Crescimento de logs, crescimento de sessões, temporários, inodes, falhas de autenticação                                                                                                                        |
| Informativa | Painel, relatório periódico                | Espaço em disco, relatório periódico de disponibilidade e desempenho                                                                                                                                            |

### Falta para operar em Produção

- Integração `database`/Loki de Produção por ligação direta (opcional): as métricas da BD do site já chegam pelo agente.
- Fornecedor de SMS/chamada: até lá estes canais ficam registados como `blocked` (`channel_not_configured`).
- `MOUNT_PATHS` dos sistemas de suporte/armazenamento; sem eles "Armazenamento de suporte" fica "Sem dados".
- Agente no servidor web `.112` (`uqphorders21-web`): falta instalar a chave SSH.
- Listas reais de destinatários (por agora, "Equipa técnica" = `numoreira@deloitte.pt`).
- Dashboards Grafana (já existe em QA, em `/opt/logging`) ligados ao Prometheus, para incorporar nos tickets.
- Os coletores por papéis já enviam métricas dos três servidores de Produção (`.110`, `.112`, `.109`). Em 11/11/2026 foi atualizado o agente no `.110`, preservando o filtro PHP 8.5; TCP, erros de rede e erros de montagem foram confirmados no Prometheus de QA para os três servidores. Não foi necessário reinstalar os exporters remotos.

### Entrega P1: heartbeats cron Pizza Hut (2026-11-10)

- Em QA (`uqphorders24-dev`), API e worker receberam uma imagem overlay apenas com o contrato de heartbeat, o coletor e o cálculo de prazos. Não foram aplicadas migrações nem publicados outros módulos; payloads legados e novos foram aceites.
- Em Production (`uqphorders22-db`), foram instrumentadas 23 entradas HTTP Pizza Hut da crontab root. Um backup privado da crontab e do agente anterior foi criado; horários, comandos, redirecionamentos e duplicados foram preservados, assim como as restantes entradas.
- As amostras naturais recebidas em QA às 09:14, 09:16 e 09:22 UTC continham as 23 tarefas no novo contrato. Às 09:22 UTC, nove tarefas tinham tentativa natural e conclusão HTTP 2xx, sem falhas registadas. A verificação agregada permaneceu `unknown` enquanto as primeiras execuções continuam pendentes, sem alertas abertos; não há conclusão de sucesso funcional.
- Tarefas diárias e as restantes cadências só ficam comprovadas depois das respetivas execuções naturais. Nenhum URL de cron de negócio foi chamado manualmente.

### Registo histórico de verificações remotas (não revalidado nesta revisão)

Os pontos seguintes documentam observações anteriores. Não confirmam que configurações, serviços, destinatários ou dados continuem ativos, e não foram verificados nem alterados nesta revisão.

- Migrações até `005_health_agent_hosts.sql` aplicadas em QA; configuração de Saúde ativa, com URLs `https://encomendar.pizzahut.pt/pt/`, `/app/` e `/api-public/v1/`.
- SMTP igual ao do site (Postfix `localhost:25`, `noreply@pizzahut.pt`) verificado; relatório periódico enviado com estado `sent`.
- Agente instalado na Produção `.110` (`uqphorders22-db`): cron a cada 2 min, `nice`/`ionice`, cerca de 0,4 s por execução. Utilizador MySQL `zeroops_monitor` só com SELECT em 3 tabelas, no máximo 2 ligações e 10 s por statement.
- 18 das 21 verificações estão com dados reais. Ficam "Sem dados": crescimento de logs (precisa de 1 h de amostras), tarefas agendadas e armazenamento de suporte.
- Calibração com dados reais:
  - **Shift4:** sucesso é `result_code` só com zeros (`0`/`000`); `099`/`06` são 3DS pendente; contam-se só as tentativas `auth`.
  - **Erros aplicacionais:** não se usa a palavra "error" solta, porque o `rest_log` regista `"error":null`.
  - **Queries lentas:** contam-se pelo slow log com `Query_time` de 5 s ou mais, porque `log_queries_not_using_indexes=ON` polui o contador `Slow_queries`.
- O executor de investigação mantém SQL read-only. Alterações à BD de QA por tickets requerem uma fronteira de escrita separada, aprovações, auditoria, testes independentes e recuperação; não se deve remover a proteção read-only do conector de investigação.

## 14. Fluxos de resolução

### O que já temos

- **Fluxos por projeto** (Projeto → **Fluxos de resolução**). Cada projeto tem vários fluxos com uma regra de seleção (origem, categoria, ambiente, prioridade). Quando várias regras coincidem, ganha o fluxo com menor número de prioridade (desempate pelo nome); se nenhuma coincidir, aplica-se o fluxo por omissão. O editor mostra a ordem efetiva.
- **Operações reutilizáveis:** `action` (ação do catálogo), `copilot_task` (análise, desenvolvimento ou relatório), `human_decision` (responsável e opções, com comentário obrigatório se configurado) e `end` (resultado). Acrescentar uma ação é registar o executor em `flow-actions.ts` e a descrição no catálogo de `contracts/src/flows.ts`; as definições existentes não mudam.
- **Duas saídas por etapa:** cada etapa tem só **sucesso** e **erro**. O resultado detalhado (ex.: `needs_approval`, `forbidden`, `not_recovered`) fica registado na etapa e aparece no ticket, mas não cria caminhos novos. Uma decisão humana pode ser uma _gate_ (`onlyWhen`): só pede decisão quando o resultado anterior o exige; caso contrário, segue por sucesso. Esperar pelo cliente e voltar a tentar são internos ao motor. Os fluxos antigos são migrados automaticamente (`toBinaryFlow`), sem alterar os tickets em curso.
- **Fluxo por tipo de alerta** (Saúde → Configuração → Regras de alerta → «Fluxo de cada alerta»; migração `033_health_alert_flows.sql`): cada regra do Prometheus (`prometheus:<regra>`) e cada verificação interna que abre tickets (`check:scheduled-jobs`) pode ter um fluxo próprio, igual em Produção e Qualidade. O ticket guarda o tipo de alerta (`tickets.alert_key`) e entra no fluxo associado. Sem associação, segue a regra geral, normalmente o fluxo de incidentes. Um fluxo associado a alertas só trata esses alertas, salvo se for o fluxo por omissão. «Criar fluxo próprio» copia o modelo de incidentes, publica-o e associa-o logo. A lista de fluxos indica «Usado por N alertas».
- **Editor visual** (React Flow, `@xyflow/react`): criar, configurar, arrastar e ligar etapas. Mover só altera a disposição; a ordem de execução é dada pelas ligações (o gravar indica «disposição» ou «lógica»). Rascunhos com controlo de versão; **Publicar** valida destinos, portas ligadas, responsáveis (membros ativos) e configuração das ações.
- **Legibilidade do desenho:** layouts antigos horizontais ou sobrepostos são reorganizados verticalmente apenas na vista, sem gravar ou publicar. As junções ficam abaixo de todos os seus antecedentes; os retornos usam corredores curtos, sem margens enormes. A abertura enquadra as primeiras etapas com zoom legível, em vez de reduzir todo o fluxo. As saídas identificam os caminhos com cor; selecionar uma ligação destaca o percurso e mostra a legenda, evitando legendas sobrepostas. Versões antigas de tickets mantêm as portas detalhadas no desenho; versões migradas usam sucesso/erro, sem converter a lógica ao abrir a vista. «Organizar verticalmente» permite gravar explicitamente a disposição.
- **Assistente do fluxo** (Copilot, sem ferramentas de escrita): recebe pedidos em português e devolve operações parciais (`add_node`, `update_node`, `remove_node`, `connect`, `disconnect`, `set_start`). A proposta aparece destacada no desenho e só altera o rascunho quando é aceite; pode ser descartada. Quando falta informação que altera a execução, devolve uma pergunta concreta.
- **Duas camadas de agentes:** o perfil ZeroOps versionado fixa missão, entradas, saída esperada, critérios, modos, modelo/esforço e allowlist de ferramentas de leitura. Em runs com perfil, as instruções globais do repositório aplicam-se sempre; até três instruções/agentes/skills adicionais são escolhidos por relevância determinística para cada etapa Copilot, além dos recursos explicitamente selecionados no flow. Conteúdo read-only, SHA-256 e motivo de seleção ficam fixos no contexto do flow e nos runs; o hash identifica o snapshot de conteúdos, não uma revisão/commit SVN. Não há cópia editável das regras técnicas na BD; as antigas instruções de Integrações continuam apenas nos flows legados. A migração `030_zeroops_agent_profiles.sql` cria catálogo e versões imutáveis. Recursos obrigatórios em falta, modelo indisponível e referências fora do projeto bloqueiam a execução. Ferramentas efetivas são a interseção do perfil com conectores verificados; conteúdo técnico não concede permissões.
- **Experimentar com um ticket:** escolhe um ticket antigo e um cenário (ex.: «o QA reprova duas vezes», «o responsável pede mais informação») e mostra o percurso, onde o ticket fica e quem recebe a próxima tarefa, sem enviar mensagens nem executar ações.
- **Execução:** o ticket fica associado à versão publicada no momento em que entra no fluxo; publicar uma nova versão não altera tickets em curso. Etapas, tentativas, decisões, resultados e eventos ficam na base (sobrevivem a reinícios). As decisões usam chave de idempotência (duplo clique ou reenvio = um avanço). Comentários de quem reprova/pede alterações seguem para a etapa seguinte e entram nas instruções do Copilot, com o resumo da tentativa anterior.
- **Página do ticket:** separador **Fluxo** com o percurso feito, a etapa atual, os caminhos possíveis e, por etapa, as tentativas (quem atuou, resultado, análise, diff, testes, comentários e relatório), distinguindo conteúdo interno de mensagens ao cliente. A barra lateral mostra **Próxima ação** (responsável e botões, apenas para quem tem permissão). O cliente vê só as mensagens públicas.
- **Assistente do ticket** (só equipa): responde com base no histórico da execução («Porque está parado?») e pode propor uma transição disponível, aplicada só se quem confirma tiver permissão nessa etapa. Afeta apenas essa execução.
- **Modelos iniciais editáveis:** _Geral_ (por omissão, reproduz o percurso anterior), _Saúde_ (publicado; origem `health`) e _Manutenção de cliente_ (criado em rascunho; origem portal do cliente, categorias bug/melhoria). Tickets em curso de antes dos fluxos entram no fluxo por omissão na decisão da equipa.
- **Incidente (Health)** (modelo para a origem `health`, migração 027, módulo `packages/backend/src/modules/incidents/`): um ciclo genérico para qualquer recurso monitorizado (servidor, disco, memória, CPU, rede, MySQL/MariaDB, DB2, serviços, aplicação). O recurso deduz-se das labels do alerta (`resource_kind`, `engine`, `unit`, `instance`…) ou do nome do alerta; um recurso novo só precisa de labels ou de um padrão novo, sem alterar o fluxo.
  1. **Receber alerta** (`incident_intake`): o ticket guarda projeto, ambiente, recurso, hora, descrição e evidência. Um alerta da mesma ocorrência junta-se ao incidente aberto; cada incidente tem um único lock de intervenção.
  2. **Investigar** (Copilot Fusion high, configurável por etapa): métricas (`zo-prom`), logs, estado, dependências e queries de leitura (`zo-sql`, `zo-db2`). Devolve sintoma, impacto, componente do alerta, componente da causa, hipóteses e a intervenção proposta.
  3. **Decidir intervenção** (`authorize_intervention`): avalia a **política de intervenção** do projeto (Saúde → Configuração): por ambiente, tipo de recurso e ação (`service_restart`, `server_reboot`, `set_parameter`), a decisão é automática, aprovação humana ou proibida. Sem regra aplicável, pede aprovação; recursos não geridos, serviços fora da lista e valores fora dos permitidos são sempre recusados. Não há ação de apagar ficheiros nem de alterar código ou dados. Cada intervenção regista o valor anterior, o novo e como repor.
  4. **Intervir** (`remediate`) através do relay de Produção/QA.
  5. **Validar recuperação** (`validate_recovery`): o critério deriva da falha (disco: espaço livre e consumo estável; memória: pressão baixa e serviço ativo; MySQL/DB2: query segura volta a funcionar; aplicação: resposta HTTP), com janela de observação, tempo máximo e tentativas configuráveis por projeto.
  6. **Fechar e comunicar** (e-mail de fecho com impacto, o que aconteceu, intervenção, evidência e causa ou «causa por apurar»/«recuperou espontaneamente») ou **encaminhar** (ticket fica aberto, atribuído à equipa, e-mail de escalada com impacto, evidências, tentativas, resultados e próximo passo).
     O fluxo é editável no editor (texto ou arrastar etapas) e os logos das tecnologias (MySQL, DB2, Git, SVN, Linux…) aparecem nas etapas. No ticket, o separador **Fluxo** mostra o percurso real do incidente, os componentes do alerta e da causa, as intervenções e a evidência de cada decisão (o cliente não vê esta informação). O relatório do Copilot segue regras de formatação Markdown para ficar legível no chat. No arranque, o `worker` substitui o modelo Saúde antigo (ainda sem alterações) pelo novo; os tickets em curso mantêm a sua versão.
- **Demonstração de incidentes** (Saúde → Configuração, só administradores; `POST /api/monitoring/incident-demo`): cria um alerta sintético de disco cheio, pressão de memória, MySQL sem ligações (causa num componente diferente do que alertou) ou DB2, que passa pelo recetor real do Alertmanager no ambiente QA. O incidente fica marcado (`demo_scenario`), não se junta a alertas reais, as intervenções ficam `simulated` e a validação é simulada; o e-mail de fecho resolve o alerta sintético. Com a Saúde suspensa, a demonstração é recusada (409).
- **Suspender/Retomar a Saúde** (botão na página Saúde, por ambiente): com a Saúde suspensa não se abrem incidentes nem se executam intervenções ou verificações ativas; os alertas recebidos ficam registados como silenciados e a faixa de suspensão indica quem suspendeu e quando. Retomar volta a ativar o ciclo e acorda as execuções que estavam suspensas.

### Depende de integração externa ainda por configurar

- **Aplicar a correção da Saúde no ambiente** (`health_remediation`): a tentativa do Copilot e o diff funcionam sem integração; sem ela, a aplicação em QA/Produção fica registada como por fazer e segue pela saída «indisponível».
- **Deploy** (`deploy`): sem integração, segue por «manual» e aguarda a confirmação do responsável de release.
- O desenvolvimento pelo Copilot entrega um diff para revisão; não aplica alterações nem corre testes independentes.
- O assistente e as etapas Copilot exigem a integração Copilot verificada no projeto.

## Avaliação de cobertura e roadmap para capacidades tipo OpsGenius

Esta comparação usa como referência o documento comercial **“OpsGenius — Agentic Operations 2.pdf”**. O objetivo é aproximar funcionalmente o ZeroOps às capacidades relevantes para Pizza Hut, não reproduzir o produto OpsGenius nem assumir como garantidos os resultados ou prazos promocionais apresentados.

### Comparação de capacidades

| Capacidade apresentada pelo OpsGenius                                                                          | Cobertura atual do ZeroOps                                                                                                        | Lacuna principal                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Interface conversacional iniciada por uma pessoa                                                               | **Parcial**: investigação Copilot por ticket operacional em QA, iniciada pela equipa; resposta continua sujeita a revisão humana. | Completar a integração com o ciclo de implementação e preservar os gates de publicação humana.                                             |
| Supervisor que coordena especialistas, incluindo trabalho em paralelo                                          | **Por implementar**: há contratos de integração, não um supervisor operacional.                                                   | Orquestrar tarefas e contexto por pedido; consolidar resultados e evitar conclusões sem evidência.                                         |
| Especialistas de incidentes, observabilidade, infraestrutura, dados, conhecimento, código, deployment e testes | **Parcial**: existem pedidos, propostas e alguns contratos de execução/testes; não existem estes agentes operacionais.            | Implementar primeiro os especialistas que resolvam casos Pizza Hut confirmados e integrar os restantes quando houver dados e casos de uso. |
| Investigação baseada em evidência de sistemas empresariais                                                     | **Parcial**: conectores de BD e Loki e fontes de código em QA; SVN/documentação e fontes reais de Produção ainda não integrados.  | Adicionar fontes aprovadas caso a caso, manter Produção read-only e registar referências rastreáveis para cada evidência.                  |
| Recomendações e remediação governadas por pessoas                                                              | **Parcial**: proposta, aprovação do cliente e autorização técnica estão modeladas; a execução real não existe.                    | Ligar recomendação, alterações, testes e aprovações ao mesmo artefacto versionado, sem contornar as aprovações humanas.                    |
| Governação por perfis, escalamento e auditoria ponta a ponta                                                   | **Parcial**: há perfis, decisões e eventos locais.                                                                                | Atribuir aprovadores concretos, definir escalamentos e registar a cadeia completa entre evidência, execução, QA e release.                 |
| Testes, gestão de deployment e verificação do resultado                                                        | **Parcial**: há estados/gates e manifesto de candidato; não há sandbox, preview, publicação ou verificação operacional.           | Executar testes independentemente, publicar apenas o artefacto aprovado e verificar/recuperar o ambiente após a publicação.                |
| Visibilidade operacional e redução de esforço                                                                  | **Parcial**: existem dashboard e tempos básicos, sem observação correlacionada das execuções ou metas acordadas.                  | Medir uma baseline Pizza Hut e acompanhar resultados do piloto antes de definir objetivos ou alegar ganhos.                                |

**Conclusão:** já existe uma base útil de portal, workflow e governação, mas ainda não existe paridade operacional com o modelo descrito pelo OpsGenius. As lacunas centrais são o supervisor multiagente, os conectores com evidência, a execução isolada e o ciclo real de QA, publicação e verificação.

### Roadmap proposto

As fases são ordenadas por dependência. Cada fase deve manter explícitos os ambientes, permissões e evidências utilizados. A execução de agentes não substitui a decisão humana nos pontos críticos.

#### Fase 0 — Fundamentos operacionais e guardrails (bloqueante)

- Preparar uma instalação persistente em Qualidade, com base de dados/armazenamento, backups e restauro testado, observabilidade e procedimentos de falha.
- Definir identidades técnicas, permissões mínimas por projeto/ambiente, gestão de segredos, retenção e classificação dos dados enviados aos modelos.
- Isolar o executor numa sandbox Linux com limites de recursos, ferramentas e acesso de rede; não disponibilizar credenciais de produção ao Copilot.
- Validar MFA já implementado localmente no destino e completar a auditoria operacional de autenticação, alterações de permissões e decisões.
- **Critério de saída:** um exercício demonstra isolamento, recuperação, revogação de acessos e rastreabilidade das ações, sem acesso não autorizado a Produção.

#### Fase 1 — Supervisor conversacional por pedido

- Criar uma execução identificada e associada ao pedido, iniciada por uma pessoa autorizada a partir da conversa.
- Mostrar estado, objetivo, passos, progresso, perguntas, resultado, falhas e cancelamento; permitir retomar sem perder o histórico.
- Separar claramente mensagens do cliente, equipa e agente; controlar o que pode ser publicado na conversa e o que fica como nota interna.
- Registar limites de contexto, tempo, recursos e ferramentas; pedir esclarecimentos em vez de inventar informação em falta.
- **Critério de saída:** uma execução de investigação pode ser iniciada, acompanhada e cancelada no pedido, e todas as mensagens/ações ficam atribuídas ao ator correto.

#### Fase 2 — Conectores autorizados e pacote de evidências

- Começar por leitura controlada do SVN (revisão e ficheiros autorizados), documentação/runbooks e logs/telemetria de Qualidade.
- Adicionar consultas de diagnóstico estritamente necessárias e read-only à base de Qualidade, com limites e redação de dados sensíveis.
- Avaliar fontes de Produção caso a caso: acesso read-only, diagnóstico aprovado, auditado e sem expor segredos; nunca acesso livre do agente.
- Preparar conectores/MCP com identidade, âmbito, timeout, limites, registo e falhas explícitas.
- Cada evidência deve guardar origem, instante/revisão, âmbito consultado e referência verificável, respeitando o controlo de acesso do pedido.
- **Critério de saída:** os casos piloto produzem um pacote de evidências reproduzível e autorizado; sem uma fonte disponível, a lacuna é indicada e não substituída por uma suposição.

#### Fase 3 — Especialistas e coordenação

- Implementar primeiro triagem/gestão de incidentes, pesquisa de conhecimento e análise de código, coordenados pelo supervisor e limitados às evidências disponíveis.
- Introduzir análise de observabilidade e dados para perguntas concretas de diagnóstico Pizza Hut, com fontes e permissões definidas.
- Acrescentar especialistas de testes/validação e deployment quando os respetivos ambientes e operações estiverem preparados.
- Tratar infraestrutura e automação genérica como capacidades condicionais: só avançam com um caso Pizza Hut, acesso autorizado e procedimento de recuperação definidos.
- Permitir trabalho paralelo quando as tarefas forem independentes; consolidar resultados, conflitos, incerteza e evidências antes de recomendar ações.
- **Critério de saída:** num conjunto de incidentes piloto, os especialistas devolvem uma análise coerente, com fontes, incertezas e próximos passos; não executam ações fora do âmbito autorizado.

#### Fase 4 — Recomendação e execução governada

- Produzir uma recomendação com diagnóstico, evidências, impacto, riscos, passos, critérios de aceitação e plano de recuperação.
- Gerar alterações apenas na sandbox e associar diff, ficheiros, SQL, testes e hashes a um candidato imutável.
- Preservar as aprovações do fluxo: aprovação do cliente quando aplicável, autorização técnica antes da implementação e testes independentes antes do QA humano.
- Revalidar a versão aprovada antes de qualquer passo seguinte; falhas ou resultados incertos ficam visíveis e não contam como sucesso.
- **Critério de saída:** a equipa consegue reproduzir a execução e verificar que só os artefactos autorizados passaram os testes; nenhuma aprovação é contornada ou reutilizada para uma versão diferente.

#### Fase 5 — QA, release, deployment e verificação

- Instalar o candidato em preview/Qualidade e apresentar evidências para o QA humano.
- Exigir aprovação do responsável de release para a versão/hash exatos; executar a publicação através de um operador limitado, não por acesso direto do agente.
- Definir e testar prechecks, compatibilidade e backups de SQL, health checks, tratamento de publicação parcial e procedimento de rollback/recuperação.
- Verificar o estado depois da publicação e manter a execução aberta até haver resultado confirmado ou escalamento humano.
- **Critério de saída:** um release aprovado percorre QA, publicação e verificação com rastreabilidade completa; falhas são detetadas e têm um procedimento de recuperação ensaiado.

#### Fase 6 — Operação, escalamento e melhoria contínua

- Ativar notificações, responsáveis, prazos e escalamentos para aprovações, incidentes críticos, execuções bloqueadas e falhas de integração.
- Expandir dashboard e auditoria para tempos de diagnóstico/resolução, intervenções humanas, qualidade das recomendações, testes, falhas e rollbacks.
- Estabelecer baseline num piloto Pizza Hut e só depois definir metas de SLA ou de melhoria; rever falsos positivos e incorporar conhecimento validado.
- **Critério de saída:** o piloto é acompanhado por indicadores acordados, revisões humanas e procedimentos de suporte; a expansão depende dos resultados e da capacidade operacional demonstrada.

### Capacidades condicionais ou fora da prioridade do primeiro piloto

- **Multi-cloud/híbrido e gestão genérica de infraestrutura:** só priorizar se corresponder à infraestrutura e a incidentes concretos de Pizza Hut; não assumir provisionamento amplo de recursos.
- **Agentes generalistas para todos os domínios:** manter a arquitetura extensível, mas criar cada especialista quando existirem fontes, permissões e casos de uso confirmados.
- **Análise ampla de dados empresariais:** restringir inicialmente a dados operacionais necessários ao diagnóstico, com consultas read-only e minimização de dados.
- **Remediação autónoma em Produção:** não faz parte do objetivo seguro; deployment pode ser automatizado, mas fica sujeito aos gates humanos, ao operador limitado e à verificação definidos nas fases anteriores.
- **Claims do PDF** (reduções de downtime/custos, velocidade de resolução ou prazo de ativação): não são requisitos nem previsões para o ZeroOps. Só podem ser avaliados com baseline, piloto e medição local.

Este roadmap complementa os módulos e a ordem de definição já descritos; não altera o estado atual nem significa autorização para ativar integrações ou publicar em Produção.

## Ordem de implementação aprovada

1. Verificar infraestrutura/acesso seguro e criar o portal persistente em Qualidade, mantendo automação desligada.
2. Completar identidade multiprojeto, tickets, revisões, participantes, aprovações e restantes módulos do portal.
3. Implementar configurações cifradas, notificações, anexos/quarentena, métricas/SLA, esforço e auditoria/retenção.
4. Construir supervisor, sandbox e conectores read-only; só ativar Copilot após validação da política/licença.
5. Implementar fix governado, testes independentes, QA humano e operador SVN/deploy verificado.
6. Executar piloto GenOps de ponta a ponta em Qualidade; Produção ZeroOps só após aprovação e inventário próprios.

Cada entrega deve indicar: **objetivo, perfis autorizados, percurso, erros/exceções, evidências, testes e critério de aceitação**.

## Referências da implementação

- [Arranque, arquitetura e limites atuais](README.md).
- [Condições para instalação e operação](deploy/README.md).
- [Portal por funcionalidades](apps/web/src/features).
- [Módulos do backend](packages/backend/src/modules).
- [Contratos públicos](packages/contracts/src/index.ts).
