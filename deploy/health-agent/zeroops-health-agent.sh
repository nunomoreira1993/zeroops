#!/usr/bin/env bash
# Agente de saude ZeroOps: recolhe metricas do servidor e envia-as para /api/monitoring/ingest.
# Corre pelo cron (root) a cada 2 minutos, com prioridade minima (ver README.md).
# So leitura: nao altera ficheiros do site, servicos nem dados. Escreve apenas o seu estado em
# $STATE_DIR (offsets dos logs e janela de eventos).
#   --print  mostra o JSON e nao envia (nao avanca os offsets dos logs).
set -u

CONFIG_FILE="${ZEROOPS_HEALTH_CONFIG:-/etc/zeroops-health/health-agent.env}"
[ -r "$CONFIG_FILE" ] || { echo "Configuracao em falta: $CONFIG_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONFIG_FILE"
TOKEN_FILE="${TOKEN_FILE:-/etc/zeroops-health/token.env}"
# shellcheck disable=SC1090
[ -r "$TOKEN_FILE" ] && . "$TOKEN_FILE"

PRINT_ONLY=0
[ "${1:-}" = "--print" ] && PRINT_ONLY=1

DISK_MOUNTS="${DISK_MOUNTS:-/}"
LOG_FILES="${LOG_FILES:-}"
TEMP_DIRS="${TEMP_DIRS:-/tmp}"
SESSION_DIRS="${SESSION_DIRS:-}"
SERVICES="${SERVICES:-apache2}"
REDIS_CHECK="${REDIS_CHECK:-0}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
MOUNT_PATHS="${MOUNT_PATHS:-}"
# Formato: "nome=/caminho/heartbeat;nome2=/outro/ficheiro" (idade do ficheiro = ultima execucao).
CRON_HEARTBEATS="${CRON_HEARTBEATS:-}"
CRON_TASKS_FILE="${CRON_TASKS_FILE:-/etc/zeroops-health/cron-tasks.tsv}"
# BD do site: ficheiro .cnf (modo 600) do utilizador so de leitura; vazio desativa o bloco "site".
SITE_MYSQL_DEFAULTS="${SITE_MYSQL_DEFAULTS:-}"
SITE_DATABASE="${SITE_DATABASE:-}"
PAID_NOT_INTEGRATED_MINUTES="${PAID_NOT_INTEGRATED_MINUTES:-15}"
# Logs da aplicacao onde se contam erros e falhas de autenticacao (so os bytes novos).
LOG_EVENT_FILES="${LOG_EVENT_FILES:-}"
LOG_EVENT_MAX_BYTES="${LOG_EVENT_MAX_BYTES:-33554432}"
# Slow log do MariaDB: conta so entradas com Query_time >= SLOW_QUERY_SECONDS (o contador
# Slow_queries inclui queries rapidas quando log_queries_not_using_indexes=ON). Vazio usa Slow_queries.
SLOW_QUERY_LOG="${SLOW_QUERY_LOG:-}"
SLOW_QUERY_SECONDS="${SLOW_QUERY_SECONDS:-5}"
STATE_DIR="${STATE_DIR:-/var/lib/zeroops-health}"
CRON_STATE_DIR="${CRON_STATE_DIR:-$STATE_DIR/cron-tasks}"

# Equivalentes ERE dos padroes do LogsCollector (packages/backend/.../logs.collector.ts).
# Nao usar a palavra "error" solta: os logs JSON do site trazem "error":null nas respostas com sucesso.
APP_ERROR_PATTERN='php (fatal|parse) error|uncaught|fatal error|"level" *: *"(error|critical|alert|emergency)"|\[(error|crit|alert|emerg)\]'
AUTH_FAILURE_PATTERN='(login|auth[[:alnum:]_]*|password|senha).{0,60}(fail[[:alnum:]_]*|inv(a|á)lid[[:alnum:]_]*|incorrect[[:alnum:]_]*|errad[[:alnum:]_]*)|bloque[[:alnum:]_]*|blocked|locked out|too many attempts'

json_string() {
  local value
  value=$(printf '%s' "$1" | tr -d '\000-\037')
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

join_items() {
  local IFS=,
  printf '[%s]' "$*"
}

count_files() {
  local total=0 dir
  for dir in "$@"; do
    [ -d "$dir" ] || continue
    total=$((total + $(find "$dir" -xdev -type f 2>/dev/null | wc -l)))
  done
  printf '%s' "$total"
}

# --- BD do site --------------------------------------------------------------------------------
# Mesmas consultas que SITE_QUERIES em site-database.collector.ts (o teste do agente compara-as).
SQL_SHIFT4="SELECT COUNT(*) AS total,
      SUM(TRIM(result_code) NOT REGEXP '^(0+)?$' AND result_message NOT LIKE '%pending%') AS failed,
      SUM((TRIM(result_code) = '' OR result_message LIKE '%pending%') AND action_date < NOW() - INTERVAL 10 MINUTE) AS pending
    FROM encomendas_shift4 WHERE action = 'auth' AND action_date >= NOW() - INTERVAL 60 MINUTE"
SQL_WALLET="SELECT COUNT(*) AS total,
      SUM(status = 'FAIL') AS failed,
      SUM(status IN ('NEW','PENDING','REVIEW') AND created_at < NOW() - INTERVAL 10 MINUTE) AS pending,
      SUM(method = 'MBWAY') AS mbway,
      SUM(method = 'MBWAY' AND status = 'FAIL') AS mbway_failed
    FROM encomendas_wallet WHERE created_at >= NOW() - INTERVAL 60 MINUTE"
SQL_DIVERGENCE="SELECT COUNT(*) AS n, MIN(e.id) AS first_id FROM encomendas e
    WHERE e.data >= NOW() - INTERVAL 1 DAY AND e.data < NOW() - INTERVAL 15 MINUTE
      AND e.satisfeita <> 6 AND e.anulada = 0
      AND (EXISTS (SELECT 1 FROM encomendas_wallet w WHERE w.encomenda_id = e.id AND w.status = 'COMPLETED')
        OR EXISTS (SELECT 1 FROM encomendas_shift4 s WHERE s.encomenda_id = e.id AND TRIM(s.result_code) REGEXP '^0+$'))"
DUE_AT="IF(e.data_agendar > '2000-01-01', e.data_agendar, e.data)"
SQL_PAID_NOT_INTEGRATED="SELECT COUNT(*) AS n, MIN(e.id) AS first_id,
      TIMESTAMPDIFF(MINUTE, MIN(${DUE_AT}), NOW()) AS oldest_minutes,
      SUM(e.integracao_falhada = 1) AS failed
    FROM encomendas e
    WHERE e.satisfeita = 6 AND e.anulada = 0 AND e.integrada = 0 AND e.flag_nao_integrar = 0
      AND e.data >= NOW() - INTERVAL 1 DAY AND ${DUE_AT} <= NOW() - INTERVAL ${PAID_NOT_INTEGRATED_MINUTES} MINUTE"

site_errors=()
# Resultado separado por tabs (corre num subshell: quem chama regista a falha com site_failed).
site_query() {
  timeout 20 mysql --defaults-extra-file="$SITE_MYSQL_DEFAULTS" -N -B "$SITE_DATABASE" -e "$1" 2>/dev/null
}
site_failed() { site_errors+=("\"$1:QUERY_FAILED\""); }
num() { case "$1" in '' | NULL) printf 0 ;; *) printf '%s' "$1" ;; esac; }
order_id() { case "$1" in '' | NULL) printf null ;; *) printf '%s' "$1" ;; esac; }

# --- Bytes novos de um ficheiro desde a ultima execucao -------------------------------------------
# Define NEW_START/NEW_LENGTH e grava o offset (exceto em --print). Primeira vez: comeca no fim (nao
# conta historico). Ficheiro rodado (inode novo) ou truncado: recomeca do inicio.
NEW_START=1
NEW_LENGTH=0
new_bytes() {
  local file=$1 state inode size offset prev_inode prev_offset
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  state="$STATE_DIR/offset.$(printf '%s' "$file" | tr -c 'A-Za-z0-9' '_')"
  inode=$(stat -c %i "$file")
  size=$(stat -c %s "$file")
  offset=$size
  if [ -r "$state" ]; then
    read -r prev_inode prev_offset < "$state"
    if [ "$prev_inode" = "$inode" ] && [ "$prev_offset" -le "$size" ]; then offset=$prev_offset; else offset=0; fi
  fi
  NEW_LENGTH=$((size - offset))
  [ "$NEW_LENGTH" -gt "$LOG_EVENT_MAX_BYTES" ] && NEW_LENGTH=$LOG_EVENT_MAX_BYTES
  NEW_START=$((offset + 1))
  [ "$PRINT_ONLY" = "1" ] || printf '%s %s\n' "$inode" "$((offset + NEW_LENGTH))" > "$state"
}
read_new() { tail -c +"$NEW_START" "$1" | head -c "$NEW_LENGTH"; }

# Total cumulativo de queries realmente lentas (o ZeroOps calcula a diferenca entre amostras).
slow_queries_total() {
  local file=$SLOW_QUERY_LOG state="$STATE_DIR/slow.total" total=0 added=0
  if [ -z "$file" ] || [ ! -r "$file" ]; then printf '%s' "$1"; return; fi
  [ -r "$state" ] && total=$(cat "$state")
  new_bytes "$file"
  if [ "$NEW_LENGTH" -gt 0 ]; then
    added=$(read_new "$file" | awk -v min="$SLOW_QUERY_SECONDS" '/^# Query_time:/ && $3 + 0 >= min {n++} END {print n + 0}')
  fi
  total=$((total + added))
  [ "$PRINT_ONLY" = "1" ] || echo "$total" > "$state"
  printf '%s' "$total"
}

collect_site() {
  local parts=() row a b c d e connected=0 max=0 running=0 slow=0 name value
  if row=$(site_query "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Slow_queries'); SHOW GLOBAL VARIABLES WHERE Variable_name='max_connections'"); then
    while IFS=$'\t' read -r name value; do
      case "${name,,}" in
        threads_connected) connected=$value ;;
        threads_running) running=$value ;;
        slow_queries) slow=$value ;;
        max_connections) max=$value ;;
      esac
    done <<< "$row"
    parts+=("\"saturation\":{\"connected\":$connected,\"max\":$max,\"running\":$running,\"slowQueriesTotal\":$(slow_queries_total "$slow")}")
  else site_failed saturation; fi
  if row=$(site_query "$SQL_SHIFT4"); then
    IFS=$'\t' read -r a b c <<< "$row"
    parts+=("\"shift4\":{\"total\":$(num "$a"),\"failed\":$(num "$b"),\"pending\":$(num "$c")}")
  else site_failed shift4; fi
  if row=$(site_query "$SQL_WALLET"); then
    IFS=$'\t' read -r a b c d e <<< "$row"
    parts+=("\"wallet\":{\"total\":$(num "$a"),\"failed\":$(num "$b"),\"pending\":$(num "$c"),\"mbway\":$(num "$d"),\"mbwayFailed\":$(num "$e")}")
  else site_failed wallet; fi
  if row=$(site_query "$SQL_DIVERGENCE"); then
    IFS=$'\t' read -r a b <<< "$row"
    parts+=("\"divergence\":{\"count\":$(num "$a"),\"firstOrderId\":$(order_id "$b")}")
  else site_failed divergence; fi
  if row=$(site_query "$SQL_PAID_NOT_INTEGRATED"); then
    IFS=$'\t' read -r a b c d <<< "$row"
    parts+=("\"paidNotIntegrated\":{\"count\":$(num "$a"),\"firstOrderId\":$(order_id "$b"),\"oldestMinutes\":$(num "$c"),\"failed\":$(num "$d"),\"thresholdMinutes\":$PAID_NOT_INTEGRATED_MINUTES}")
  else site_failed paidNotIntegrated; fi
  [ ${#site_errors[@]} -gt 0 ] && parts+=("\"errors\":$(join_items "${site_errors[@]}")")
  local IFS=,
  printf '{%s}' "${parts[*]}"
}

# --- Eventos nos logs da aplicacao (janela deslizante de 60 min) --------------------------------
collect_log_events() {
  local now app=0 auth=0 file samples=() line
  now=$(date +%s)
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  for file in $LOG_EVENT_FILES; do
    [ -f "$file" ] || continue
    new_bytes "$file"
    if [ "$NEW_LENGTH" -gt 0 ]; then
      app=$((app + $(read_new "$file" | grep -Eaic "$APP_ERROR_PATTERN")))
      auth=$((auth + $(read_new "$file" | grep -Eaic "$AUTH_FAILURE_PATTERN")))
      while IFS= read -r line; do
        [ ${#samples[@]} -lt 5 ] && samples+=("$(json_string "${line:0:300}")")
      done < <(read_new "$file" | grep -Eai "$APP_ERROR_PATTERN" | tail -n 5)
    fi
  done

  local window="$STATE_DIR/events.window" since_file="$STATE_DIR/events.since" since total_app total_auth minutes
  [ -r "$since_file" ] || echo "$now" > "$since_file"
  since=$(cat "$since_file")
  if [ "$PRINT_ONLY" = "1" ]; then
    totals=$( { [ -r "$window" ] && cat "$window"; echo "$now $app $auth"; } | awk -v min=$((now - 3600)) '$1 >= min {a += $2; b += $3} END {print a + 0, b + 0}')
  else
    { [ -r "$window" ] && awk -v min=$((now - 3600)) '$1 >= min' "$window"; echo "$now $app $auth"; } > "$window.tmp" && mv "$window.tmp" "$window"
    totals=$(awk '{a += $2; b += $3} END {print a + 0, b + 0}' "$window")
  fi
  read -r total_app total_auth <<< "$totals"
  minutes=$(( (now - since) / 60 ))
  [ "$minutes" -lt 1 ] && minutes=1
  [ "$minutes" -gt 60 ] && minutes=60
  printf '{"windowMinutes":%s,"applicationErrors":%s,"authFailures":%s,"sample":%s}' \
    "$minutes" "$total_app" "$total_auth" "$(join_items "${samples[@]}")"
}

# --- Servidor ----------------------------------------------------------------------------------
disks=()
for mount in $DISK_MOUNTS; do
  used=$(df -P "$mount" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
  [ -n "$used" ] || continue
  inodes=$(df -iP "$mount" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print ($5 ~ /^[0-9]+$/) ? $5 : "null"}')
  disks+=("{\"mount\":$(json_string "$mount"),\"usedPercent\":$used,\"inodesUsedPercent\":${inodes:-null}}")
done

read -r load1 load5 _ < /proc/loadavg
cores=$(nproc 2>/dev/null || echo 1)
mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)

logs=()
for file in $LOG_FILES; do
  [ -f "$file" ] || continue
  logs+=("{\"path\":$(json_string "$file"),\"sizeBytes\":$(stat -c %s "$file" 2>/dev/null || echo 0)}")
done

services=()
for name in $SERVICES; do
  if systemctl is-active --quiet "$name" 2>/dev/null; then active=true; else active=false; fi
  services+=("{\"name\":$(json_string "$name"),\"active\":$active}")
done

redis=""
if [ "$REDIS_CHECK" = "1" ]; then
  # Com requirepass o servidor responde NOAUTH: prova que esta vivo sem o agente precisar da password.
  pong=""
  command -v redis-cli >/dev/null 2>&1 && pong=$(timeout 5 redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>&1)
  if [ "$pong" = "PONG" ] || [ "${pong#NOAUTH}" != "$pong" ]; then
    redis=',"redis":{"ok":true}'
  else
    redis=',"redis":{"ok":false}'
  fi
fi

mounts=()
for path in $MOUNT_PATHS; do
  if timeout 10 stat -t "$path" >/dev/null 2>&1 && timeout 10 ls "$path" >/dev/null 2>&1; then ok=true; else ok=false; fi
  mounts+=("{\"path\":$(json_string "$path"),\"ok\":$ok}")
done

crons=()
IFS=';' read -r -a heartbeat_items <<< "$CRON_HEARTBEATS"
now=$(date +%s)
for item in "${heartbeat_items[@]}"; do
  [ -n "$item" ] || continue
  name=${item%%=*}
  file=${item#*=}
  if [ -e "$file" ]; then age=$(( (now - $(stat -c %Y "$file")) / 60 )); else age=100000; fi
  crons+=("{\"name\":$(json_string "$name"),\"lastRunAgeMinutes\":$age}")
done

epoch_iso_or_null() {
  case "$1" in
    '' | *[!0-9]*) printf null ;;
    *) date -u -d "@$1" +'"%Y-%m-%dT%H:%M:%SZ"' 2>/dev/null || printf null ;;
  esac
}

number_or_null() {
  case "$1" in
    '' | *[!0-9]*) printf null ;;
    *) printf '%s' "$1" ;;
  esac
}

if [ -r "$CRON_TASKS_FILE" ]; then
  while IFS='|' read -r task_id task_name schedule timezone grace activated || [ -n "${task_id:-}" ]; do
    [[ "$task_id" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || continue
    [[ "$grace" =~ ^[0-9]+$ ]] || continue
    state_file="$CRON_STATE_DIR/$task_id.state"
    attempt='' exit_code='' http_status='' curl_exit='' completed='' completed_status=''
    failure='' failure_code='' in_progress=0
    if [ -r "$state_file" ]; then
      IFS='|' read -r attempt exit_code http_status curl_exit completed completed_status \
        failure failure_code in_progress < "$state_file" || true
    fi
    if [ "$in_progress" = "1" ]; then progress_json=true; else progress_json=false; fi
    if [ -n "$failure_code" ]; then failure_code_json=$(json_string "$failure_code"); else failure_code_json=null; fi
    crons+=("{\"id\":$(json_string "$task_id"),\"name\":$(json_string "$task_name"),\"schedule\":$(json_string "$schedule"),\"timeZone\":$(json_string "$timezone"),\"graceMinutes\":$grace,\"activatedAt\":$(json_string "$activated"),\"lastAttemptAt\":$(epoch_iso_or_null "$attempt"),\"lastExitCode\":$(number_or_null "$exit_code"),\"lastHttpStatus\":$(number_or_null "$http_status"),\"lastHttpCurlExitCode\":$(number_or_null "$curl_exit"),\"lastHttpCompletedAt\":$(epoch_iso_or_null "$completed"),\"lastHttpCompletedStatus\":$(number_or_null "$completed_status"),\"lastFailureAt\":$(epoch_iso_or_null "$failure"),\"lastFailureCode\":$failure_code_json,\"inProgress\":$progress_json}")
  done < "$CRON_TASKS_FILE"
fi

payload="{\"host\":$(json_string "$(hostname)"),\"collectedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
payload+=",\"cpu\":{\"load1\":$load1,\"load5\":$load5,\"cores\":$cores}"
payload+=",\"memory\":{\"totalKb\":${mem_total:-0},\"availableKb\":${mem_available:-0}}"
payload+=",\"disks\":$(join_items "${disks[@]}")"
payload+=",\"logs\":$(join_items "${logs[@]}")"
# shellcheck disable=SC2086
payload+=",\"tempFiles\":$(count_files $TEMP_DIRS)"
# shellcheck disable=SC2086
[ -n "$SESSION_DIRS" ] && payload+=",\"sessionFiles\":$(count_files $SESSION_DIRS)"
payload+=",\"services\":$(join_items "${services[@]}")$redis"
payload+=",\"mounts\":$(join_items "${mounts[@]}")"
payload+=",\"crons\":$(join_items "${crons[@]}")"
[ -n "$SITE_MYSQL_DEFAULTS" ] && [ -n "$SITE_DATABASE" ] && payload+=",\"site\":$(collect_site)"
[ -n "$LOG_EVENT_FILES" ] && payload+=",\"logEvents\":$(collect_log_events)"
payload+="}"

if [ "$PRINT_ONLY" = "1" ]; then
  printf '%s\n' "$payload"
  exit 0
fi

: "${ZEROOPS_URL:?ZEROOPS_URL em falta}"
: "${ZEROOPS_TOKEN:?ZEROOPS_TOKEN em falta}"
curl_args=(-sS -f --max-time 20)
# Rede interna sem DNS publico do QA: "host:443:IP" e a CA que assinou o certificado.
[ -n "${ZEROOPS_RESOLVE:-}" ] && curl_args+=(--resolve "$ZEROOPS_RESOLVE")
[ -n "${ZEROOPS_CACERT:-}" ] && curl_args+=(--cacert "$ZEROOPS_CACERT")
# O token vai por stdin (-H @-) para nao aparecer na lista de processos.
printf 'Authorization: Bearer %s\n' "$ZEROOPS_TOKEN" | curl "${curl_args[@]}" \
  -H @- -H 'Content-Type: application/json' \
  --data-binary "$payload" "${ZEROOPS_URL%/}/api/monitoring/ingest" -o /dev/null
