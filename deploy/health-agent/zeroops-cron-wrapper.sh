#!/usr/bin/env bash
set -u

TASK_ID=''
STATE_DIR="${ZEROOPS_CRON_STATE_DIR:-/var/lib/zeroops-health/cron-tasks}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id) TASK_ID="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) printf 'zeroops-cron-heartbeat: argumento inválido\n' >&2; exit 64 ;;
  esac
done

if [[ ! "$TASK_ID" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || [ "$#" -ne 1 ]; then
  printf 'zeroops-cron-heartbeat: identificador/comando inválido\n' >&2
  exit 64
fi

COMMAND_TEXT=$1
STATE_FILE="$STATE_DIR/$TASK_ID.state"
LOCK_FILE="$STATE_DIR/$TASK_ID.lock"
HTTP_RESULT_FILE="$STATE_DIR/.http.$TASK_ID.$$"
CURL_STDERR_FILE="$STATE_DIR/.curl-stderr.$TASK_ID.$$"
umask 077

log_state_failure() {
  local phase=$1 code=$2 message="heartbeat_write_failed id=$TASK_ID phase=$1 code=$2"
  printf "zeroops-cron-heartbeat: %s\n" "$message" >&2
  if command -v logger >/dev/null 2>&1; then
    logger -p cron.err -t zeroops-cron-heartbeat -- "$message" 2>/dev/null || true
  fi
}

read_state() {
  latest_attempt=''
  latest_exit=''
  latest_http=''
  latest_curl_exit=''
  last_http_completed=''
  last_http_completed_status=''
  last_failure=''
  last_failure_code=''
  in_progress=0
  if [ -e "$STATE_FILE" ]; then
    IFS='|' read -r latest_attempt latest_exit latest_http latest_curl_exit \
      last_http_completed last_http_completed_status last_failure last_failure_code in_progress \
      < "$STATE_FILE" || return 1
  fi
}

write_state() {
  local phase=$1 run_at=${2:-} finished_at=${3:-} run_exit=${4:-} run_http=${5:-} run_curl_exit=${6:-}
  local next_attempt next_exit next_http next_curl_exit next_success next_success_status
  local next_failure next_failure_code next_in_progress temp_file

  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR" || return 1
  exec 9>"$LOCK_FILE" || return 1
  flock -x 9 || { exec 9>&-; return 1; }
  read_state || { flock -u 9; exec 9>&-; return 1; }

  next_attempt=$latest_attempt
  next_exit=$latest_exit
  next_http=$latest_http
  next_curl_exit=$latest_curl_exit
  next_success=$last_http_completed
  next_success_status=$last_http_completed_status
  next_failure=$last_failure
  next_failure_code=$last_failure_code
  next_in_progress=$in_progress

  if [ "$phase" = "start" ]; then
    if [ -z "$next_attempt" ] || [ "$run_at" -ge "$next_attempt" ]; then
      next_attempt=$run_at
      next_exit=''
      next_http=''
      next_curl_exit=''
      next_in_progress=1
    fi
  elif [ "$phase" = "finish" ]; then
    if [ -n "$run_http" ] && [ -n "$run_curl_exit" ]; then
      if [ "$run_curl_exit" -eq 0 ] && [ "$run_http" -ge 200 ] && [ "$run_http" -lt 300 ]; then
        if [ -z "$next_success" ] || [ "$finished_at" -ge "$next_success" ]; then
          next_success=$finished_at
          next_success_status=$run_http
        fi
      fi
    fi

    local failed_code=''
    if [ -n "$run_curl_exit" ] && [ "$run_curl_exit" -ne 0 ]; then
      failed_code="curl_exit:$run_curl_exit"
    elif [ "$run_exit" -ne 0 ]; then
      failed_code="exit:$run_exit"
    elif [ -n "$run_http" ] && { [ "$run_http" -lt 200 ] || [ "$run_http" -ge 300 ]; }; then
      failed_code="http:$run_http"
    elif [ -n "$run_curl_exit" ] && [ "$run_http" -eq 0 ]; then
      failed_code='http_unconfirmed'
    fi
    if [ -n "$failed_code" ] && { [ -z "$next_failure" ] || [ "$finished_at" -ge "$next_failure" ]; }; then
      next_failure=$finished_at
      next_failure_code=$failed_code
    fi

    if [ "$run_at" -ge "${next_attempt:-0}" ]; then
      next_attempt=$run_at
      next_exit=$run_exit
      next_http=$run_http
      next_curl_exit=$run_curl_exit
      next_in_progress=0
    fi
  fi

  temp_file="$STATE_FILE.tmp.$$"
  if ! printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$next_attempt" "$next_exit" "$next_http" "$next_curl_exit" \
    "$next_success" "$next_success_status" "$next_failure" "$next_failure_code" \
    "$next_in_progress" > "$temp_file" ||
    ! chmod 600 "$temp_file" ||
    ! mv -f "$temp_file" "$STATE_FILE"; then
    rm -f "$temp_file"
    flock -u 9
    exec 9>&-
    return 1
  fi

  flock -u 9
  exec 9>&-
}

started_at=$(date +%s)
if ! write_state start "$started_at"; then
  log_state_failure start write_failed
fi

rm -f "$HTTP_RESULT_FILE" "$CURL_STDERR_FILE"
HTTP_MARKER="__ZEROOPS_HTTP_${TASK_ID}_$$:"
CRON_SHELL="${SHELL:-/bin/sh}"
if [ ! -x "$CRON_SHELL" ]; then CRON_SHELL=/bin/sh; fi

"$CRON_SHELL" -c '
run_original() {
  local __zeroops_task_id="$1"
  local __zeroops_http_result_file="$2"
  local __zeroops_curl_stderr_file="$3"
  local __zeroops_marker="$4"
  local __zeroops_command_text="$5"
  local curl_rc http_code message
  shift 5

  curl() {
    touch "$__zeroops_curl_stderr_file" 2>/dev/null || {
      message="heartbeat_write_failed id=$__zeroops_task_id phase=http_status code=write_failed"
      printf "zeroops-cron-heartbeat: %s\n" "$message" >&2
      if command -v logger >/dev/null 2>&1; then
        logger -p cron.err -t zeroops-cron-wrapper -- "$message" 2>/dev/null || true
      fi
      command curl "$@"
      return $?
    }
    command curl "$@" --write-out "%{stderr}${__zeroops_marker}%{http_code}\n" \
      2>"$__zeroops_curl_stderr_file"
    curl_rc=$?
    http_code=$(sed -n "s/^${__zeroops_marker}\([0-9][0-9][0-9]\)$/\1/p" \
      "$__zeroops_curl_stderr_file" | tail -n 1)
    if [ -n "$http_code" ]; then
      if ! printf "%s|%s\n" "$http_code" "$curl_rc" > "$__zeroops_http_result_file"; then
        message="heartbeat_write_failed id=$__zeroops_task_id phase=http_status code=write_failed"
        printf "zeroops-cron-heartbeat: %s\n" "$message" >&2
        if command -v logger >/dev/null 2>&1; then
          logger -p cron.err -t zeroops-cron-wrapper -- "$message" 2>/dev/null || true
        fi
      fi
    else
      if ! printf "0|%s\n" "$curl_rc" > "$__zeroops_http_result_file"; then
        message="heartbeat_write_failed id=$__zeroops_task_id phase=http_status code=write_failed"
        printf "zeroops-cron-heartbeat: %s\n" "$message" >&2
        if command -v logger >/dev/null 2>&1; then
          logger -p cron.err -t zeroops-cron-wrapper -- "$message" 2>/dev/null || true
        fi
      fi
    fi
    grep -vF "$__zeroops_marker" "$__zeroops_curl_stderr_file" >&2 || true
    rm -f "$__zeroops_curl_stderr_file"
    return "$curl_rc"
  }

  eval "$__zeroops_command_text"
}
run_original "$@"
' "$CRON_SHELL" "$TASK_ID" "$HTTP_RESULT_FILE" "$CURL_STDERR_FILE" "$HTTP_MARKER" "$COMMAND_TEXT"
command_exit=$?
finished_at=$(date +%s)

http_status=''
curl_exit=''
if [ -r "$HTTP_RESULT_FILE" ]; then
  IFS='|' read -r http_status curl_exit < "$HTTP_RESULT_FILE" || true
fi
rm -f "$HTTP_RESULT_FILE" "$CURL_STDERR_FILE"

if ! write_state finish "$started_at" "$finished_at" "$command_exit" "$http_status" "$curl_exit"; then
  log_state_failure finish write_failed
fi
exit "$command_exit"
