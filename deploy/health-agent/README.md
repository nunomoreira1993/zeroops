# Agente de saúde ZeroOps

Script bash que recolhe métricas do servidor do site e as envia para `POST /api/monitoring/ingest`. Só lê: não altera ficheiros do site, serviços nem dados. Só escreve o seu próprio estado em `STATE_DIR`.

Alimenta as verificações seguintes da página **Saúde**:

- disco, inodes, CPU e memória;
- serviços, Redis, montagens e tarefas agendadas;
- logs, ficheiros temporários e sessões;
- BD do site: saturação, Shift4, MEO Wallet/MB WAY, divergência pagamento/encomenda e encomendas pagas não integradas;
- erros aplicacionais e falhas de autenticação, contados só nos bytes novos dos logs.

As queries SQL do agente são as mesmas de `SITE_QUERIES` (`site-database.collector.ts`). O teste `health-agent-script.test.ts` falha se divergirem.

## Paths

| Path | Conteúdo |
|---|---|
| `/opt/zeroops-health/zeroops-health-agent.sh` | Script (modo 750). |
| `/opt/zeroops-health/zeroops-cron-wrapper.sh` | Wrapper das tarefas HTTP instrumentadas (modo 750). |
| `/etc/zeroops-health/health-agent.env` | Configuração (modo 600). |
| `/etc/zeroops-health/token.env` | `ZEROOPS_TOKEN=...` (modo 600; nunca versionar). |
| `/etc/zeroops-health/site-mysql.cnf` | Credenciais do utilizador MySQL só de leitura (modo 600). |
| `/etc/zeroops-health/cron-tasks.tsv` | Agenda, fuso, prazo e ativação por tarefa (modo 600). |
| `/var/lib/zeroops-health/` | Estado dos heartbeats, offsets dos logs e janelas de eventos (modo 700). |
| `/etc/cron.d/zeroops-health` | Cron a cada 2 minutos. |

## Requisitos

- bash, coreutils, `flock`, `curl` 7.63 ou superior, `systemctl`, `mysql`; `redis-cli` se `REDIS_CHECK=1`. O instalador de heartbeats requer Python 3.8 ou superior.
- Saída HTTPS do servidor para o URL do ZeroOps.
- Token gerado em **Saúde → Configuração → Gerar token do agente**, ou com `ops agent-token` (ver `deploy/README.md`). O token é mostrado uma única vez; o ZeroOps guarda apenas o hash.

## Instalação (requer aprovação para o ambiente de destino)

Confirmar primeiro o servidor com `hostname`.

```bash
install -d -m 700 /etc/zeroops-health /var/lib/zeroops-health
install -d -m 755 /opt/zeroops-health
install -m 750 zeroops-health-agent.sh /opt/zeroops-health/zeroops-health-agent.sh
install -m 600 /dev/null /etc/zeroops-health/health-agent.env   # editar (ver exemplo)
```

### Utilizador MySQL só de leitura

A password é gerada no servidor e escrita apenas no `.cnf`.

```bash
PW=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)
mysql -e "CREATE USER IF NOT EXISTS 'zeroops_monitor'@'localhost' IDENTIFIED BY '$PW' WITH MAX_USER_CONNECTIONS 2 MAX_STATEMENT_TIME 10"
for t in encomendas encomendas_shift4 encomendas_wallet; do
  mysql -e "GRANT SELECT ON pizzahut.$t TO 'zeroops_monitor'@'localhost'"
done
(umask 077; printf '[client]\nuser=zeroops_monitor\npassword=%s\nhost=localhost\n' "$PW" > /etc/zeroops-health/site-mysql.cnf)
unset PW
```

`SHOW GLOBAL STATUS` e `SHOW GLOBAL VARIABLES` não precisam de privilégios adicionais.

### Validação e cron

```bash
/opt/zeroops-health/zeroops-health-agent.sh --print   # mostra o JSON, não envia e não avança offsets
cat > /etc/cron.d/zeroops-health <<'EOF'
*/2 * * * * root nice -n 19 ionice -c3 flock -n /var/lib/zeroops-health/run.lock timeout 50 /opt/zeroops-health/zeroops-health-agent.sh >/dev/null 2>&1
EOF
```

### Heartbeats dos crons Pizza Hut

O instalador identifica apenas comandos `curl` do root para os endpoints HTTP Pizza Hut permitidos. Não altera o horário, as flags, o comando original, o utilizador nem os redirecionamentos; cada entrada duplicada recebe um identificador independente. Outras entradas da crontab são copiadas sem alteração e nunca são impressas pelo instalador.

Como root, a partir de uma cópia privada dos três ficheiros da pasta `deploy/health-agent`:

```bash
python3 install-cron-heartbeats.py --plan
python3 install-cron-heartbeats.py --apply \
  --wrapper-source ./zeroops-cron-wrapper.sh \
  --agent-source ./zeroops-health-agent.sh \
  --time-zone Europe/Lisbon
```

`--plan` mostra só identificadores, nomes, horários e tolerâncias. `--apply` confirma que a crontab permanece byte a byte igual ao plano, cria cópias privadas do original e dos ficheiros substituídos, valida `curl`/`flock` e aplica apenas os comandos selecionados. O instalador normaliza finais de linha dos scripts para LF. O wrapper executa cada comando uma vez, sem retry nem timeout adicional; falhas de escrita do heartbeat vão para `logger`/stderr e não substituem o exit code do comando. O rollback é `python3 install-cron-heartbeats.py --rollback BACKUP_ID`; recusa restaurar se a crontab tiver mudado desde a instalação.

Os crons escrevem início, exit code, falha e resposta HTTP separadamente. Só um `curl` com exit code zero e resposta HTTP 2xx atualiza a **conclusão HTTP**; o estado, o corpo e credenciais da resposta nunca são guardados. Não há contrato funcional comum para estes endpoints: HTTP 200 é apenas conclusão HTTP, nunca sucesso de negócio. Não chamar URLs de negócio manualmente; validar apenas as execuções naturais.

## Configuração (`/etc/zeroops-health/health-agent.env`) — Produção Pizza Hut

```bash
ZEROOPS_URL=https://tickets.pizzahut.pt
ZEROOPS_RESOLVE=tickets.pizzahut.pt:443:192.168.90.79   # sem DNS interno para o QA
ZEROOPS_CACERT=/etc/zeroops-health/qa-ca.pem            # CA do certificado de tickets.pizzahut.pt
DISK_MOUNTS="/"
SERVICES="apache2 mariadb php7.4-fpm php8.5-fpm redis-server cron postfix@-"
REDIS_CHECK=1                     # com requirepass, a resposta NOAUTH conta como disponível
SESSION_DIRS=/var/lib/php/sessions
TEMP_DIRS=/tmp
LOG_FILES="<vhost>/log/access_log <vhost>/log/error_log <vhost>/httpdocs/log/*/<nome>.log ..."
LOG_EVENT_FILES="<vhost>/httpdocs/log/php_errors/php_errors.log <vhost>/httpdocs/log/rest_log/rest_log.log <vhost>/httpdocs/log/wallet/wallet.log"
SITE_MYSQL_DEFAULTS=/etc/zeroops-health/site-mysql.cnf
SITE_DATABASE=pizzahut
PAID_NOT_INTEGRATED_MINUTES=15
SLOW_QUERY_LOG=/var/log/mysql/slow-query.log   # conta so Query_time >= SLOW_QUERY_SECONDS
SLOW_QUERY_SECONDS=5
MOUNT_PATHS=""                    # partilhas/armazenamento de suporte
CRON_HEARTBEATS=""                # formato legado nome=/caminho; continua suportado
CRON_TASKS_FILE=/etc/zeroops-health/cron-tasks.tsv
CRON_STATE_DIR=/var/lib/zeroops-health/cron-tasks
```

Notas:

- `<vhost>` é `/var/www/vhosts/pizzahut.pt`.
- Na Produção, `log_queries_not_using_indexes=ON` faz o contador `Slow_queries` subir com queries rápidas sem índice. Com `SLOW_QUERY_LOG`, o agente conta só as entradas do slow log com `Query_time` de pelo menos `SLOW_QUERY_SECONDS`.
- O `api-public.log` (cerca de 600 MB/dia) entra só em `LOG_FILES`, para medir o crescimento. Não entra em `LOG_EVENT_FILES`, porque os pedidos registados em JSON contêm "password" e dariam falsos positivos de autenticação.
- Na primeira execução, cada log de eventos começa no fim do ficheiro. Se o inode mudar (rotação pelo logrotate) ou o ficheiro encolher, a leitura recomeça em 0. Cada execução lê no máximo `LOG_EVENT_MAX_BYTES` (32 MB).
- `CRON_HEARTBEATS` mantém compatibilidade com amostras/configurações antigas e continua a usar a idade do ficheiro.
- `cron-tasks.tsv` guarda, por tarefa, o identificador, nome, expressão cron de cinco campos, fuso horário, tolerância em minutos e instante de ativação. O prazo é calculado por tarefa; pausas da agenda, primeira execução e mudanças DST são respeitadas. Antes do primeiro prazo a tarefa fica pendente, sem heartbeat de sucesso fictício.
- A amostra nova inclui última tentativa, exit code, último estado HTTP, última conclusão HTTP 2xx e última falha. Uma falha não renova a conclusão HTTP; o coletor usa o prazo configurado, não o limite global de 30 minutos. Amostras antigas continuam a usar esse limite global.

## Impacto

O agente demora menos de 1 s por execução e corre com `nice 19` e `ionice` idle. Faz 5 queries curtas com um limite de 10 s por statement e no máximo 2 ligações.

Sem amostras durante `agentStaleMinutes` (5 min por omissão), o ZeroOps abre o alerta urgente **Indisponibilidade do servidor ou serviço aplicacional**.

## Remoção do agente

```bash
rm -f /etc/cron.d/zeroops-health
```

Antes de remover os restantes ficheiros ou o utilizador MySQL, confirmar que não há outros consumidores e obter aprovação própria. Preservar backups e estado até à aprovação explícita da retenção; não apagar `/var/lib/zeroops-health` indiscriminadamente.
