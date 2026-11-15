# Relay de Produção

Permite ao agente de investigação do ZeroOps consultar **dados reais** de Produção sem abrir
portas: a rede só deixa Produção → ZeroOps (HTTPS), por isso o relay corre no servidor de
Produção, vai buscar as consultas ao ZeroOps (long-poll) e devolve os resultados.

| Ferramenta | Comando do agente                                             | O que faz no servidor                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sql`      | `zo-sql --env production "SELECT …"`                          | Uma instrução de leitura com o utilizador `zeroops_agent` (só `SELECT`), transação `READ ONLY`, 15 s por consulta, máximo 200 linhas.                                                                                                                                            |
| `log`      | `zo-log --env production <tipo> ["texto"] [linhas] [dias]`    | Lê `httpdocs/log/<tipo>/<tipo>.log` e, com dias > 0, os rodados (`.gz`) até 14 dias. Em sites com logs diários (`<tipo>/AAAA_MM_DD.txt`, ex.: Pizza Movil) lê o dia mais recente ou, com dias > 0, os dias desse período. Lista fechada de tipos, sem shell.                     |
| `db2`      | `zo-db2 --env production "SELECT … FETCH FIRST 50 ROWS ONLY"` | Opcional (relay 1.1.0). Consulta só de leitura ao DB2 por ODBC, como o site, com credenciais em `<pasta de configuração>/agent-db2.ini` (`[db2] dsn, user, password`; utilizador DB2 só com `SELECT`). Sem esse ficheiro ou sem a extensão `odbc`, a ferramenta não é anunciada. |

Redação de cartões e colunas sensíveis, limites e registo de cada chamada (com o ambiente)
são aplicados do lado do ZeroOps antes de o resultado chegar ao Copilot.

## Intervenções do fluxo «Incidente (Health)» (relay 1.1.0)

O relay também executa as intervenções que a política do projeto autorizou (Saúde →
Configuração → Política de intervenção): reiniciar um serviço, ajustar uma propriedade
systemd em runtime ou reiniciar o servidor. Tudo está desligado por omissão e é limitado
duas vezes, no ZeroOps (política) e no servidor (`relay.env` + regra polkit):

- `ZEROOPS_ENVIRONMENT` — ambiente deste relay (`production` ou `quality`); pedidos de outro
  ambiente são recusados.
- `ALLOWED_UNITS` — unidades systemd que se podem reiniciar/ajustar (lista por vírgulas, ex.:
  `mariadb.service,php-fpm.service`). Vazio = nenhuma.
- `ALLOWED_PROPERTIES` — propriedades ajustáveis em runtime (por omissão
  `MemoryHigh,MemoryMax,CPUQuota,TasksMax`). O valor anterior é lido e devolvido para a reposição.
- `ALLOW_REBOOT=1` — permite reiniciar o servidor (por omissão `0`).

`install.sh` acrescenta estas chaves a um `relay.env` antigo (desligadas) e gera
`/etc/polkit-1/rules.d/60-<serviço>.rules`, que só deixa o utilizador `zeroops-relay` fazer
`restart`/`set-property` nessas unidades (e `reboot` se autorizado). Sem unidades nem reboot,
a regra não existe e qualquer intervenção é recusada. Com a Saúde do ambiente suspensa no
ZeroOps, o relay recusa intervenções. Não há ferramenta para apagar ficheiros nem para escrever
em bases de dados.

### Idempotência das intervenções (relay 1.2.0, P09)

- Os pedidos seguem o contrato `zeroops.intervention/2`: trazem prazo (`deadline`) e chave de
  idempotência. Um pedido recebido fora do prazo não é executado.
- Cada intervenção fica registada num journal local em `/var/lib/<serviço>/` (`StateDirectory`
  do systemd, `0700`, a única pasta gravável do serviço). O mesmo pedido corre no máximo uma
  vez neste servidor: uma repetição devolve o resultado guardado.
- Se o relay for interrompido a meio de uma intervenção, esta **não é repetida**: o resultado é
  reportado como desconhecido (`UNCERTAIN`) e o ZeroOps reconcilia-o pelo fluxo (sondas
  recentes, escalada). Um restart nunca é repetido só porque a resposta expirou.
- Resultados que o ZeroOps ainda não confirmou são reenviados no ciclo seguinte. O ZeroOps
  aceita o mesmo resultado repetido (`duplicate`) e recusa com 409 um resultado contraditório.
- As entradas do journal são apagadas ao fim de 7 dias.

## Segurança e impacto no site

- Utilizador MySQL próprio `zeroops_agent@localhost`: `SELECT` em `pizzahut.*`,
  `MAX_USER_CONNECTIONS 3`, `MAX_STATEMENT_TIME 20`.
- O relay rejeita `;`, instruções que não sejam de leitura, `INTO OUTFILE`, `LOAD_FILE`,
  `FOR UPDATE`, `SLEEP`, `BENCHMARK` e `GET_LOCK`.
- O serviço `systemd` corre como `zeroops-relay` (sem shell), com `Nice=19`,
  `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=256M` e o sistema de ficheiros só de leitura.
- O token do relay (`zor_…`) só fica guardado como hash no ZeroOps e pode ser rodado em
  **Integrações → Agente de investigação**.

## Instalação

1. Copiar esta pasta para o servidor de Produção (ex.: `/root/zeroops-relay-src`) e executar
   como root: `sh install.sh`. Cria o utilizador de sistema, o utilizador MySQL (password gerada
   no servidor), `/etc/zeroops-relay/` e o serviço, reaproveitando o URL/CA do agente de Saúde.
2. Em **Integrações → Agente de investigação**, carregar em **Gerar token**.
3. No servidor: `install -m 0640 -g zeroops-relay /dev/null /etc/zeroops-relay/token.env` e
   gravar `ZEROOPS_RELAY_TOKEN=zor_…` nesse ficheiro com um editor (não na linha de comandos).
4. `sh install.sh` de novo: ativa e arranca o serviço. Na página deve aparecer **Ligado**.

Diagnóstico: `systemctl status zeroops-relay` e `journalctl -u zeroops-relay -n 50`.

## Vários sites no mesmo servidor (ex.: Pizza Movil)

Cada projeto do ZeroOps tem o seu token de relay e só vê as consultas dos seus tickets. Para um
segundo site no mesmo servidor instala-se uma instância adicional, com pasta, token, utilizador
MySQL (só `SELECT` na BD desse site) e serviço próprios:

```sh
DB_NAME=pizzamovil LOG_ROOT=/var/www/vhosts/pizzamovil.es/httpdocs/log \
  sh install.sh --instance pizzamovil
```

- Configuração em `/etc/zeroops-relay-pizzamovil/`, utilizador MySQL `zeroops_agent_pizzamovil`,
  serviço `zeroops-relay-pizzamovil`.
- O token gera-se em **Integrações → Agente de investigação** com o projeto Pizza Movil
  selecionado e grava-se em `/etc/zeroops-relay-pizzamovil/token.env` (passos 3 e 4 acima, com
  `--instance pizzamovil`).
- Caminho e BD confirmados em Produção e QA: `/var/www/vhosts/pizzamovil.es/httpdocs`, BD
  `pizzamovil`, logs diários em `httpdocs/log/<tipo>/AAAA_MM_DD.txt` (tipos `dtq`, `locks`,
  `loyalty`, `moradas`, `oreo`).
- Atualizar/remover: as mesmas opções com `--instance pizzamovil`.

## Atualização

Copiar a nova versão de `zeroops-relay.php` e executar `sh install.sh` (mantém configuração,
utilizador MySQL e token).

## Remoção

`sh install.sh --remove`: desativa o serviço e apaga o utilizador MySQL `zeroops_agent`.
A configuração em `/etc/zeroops-relay/` fica para apagar manualmente. No ZeroOps, sem relay
ligado, o agente deixa de ter ferramentas de Produção e indica que só consultou QA.
