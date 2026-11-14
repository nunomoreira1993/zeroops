#!/usr/bin/env bash
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WRAPPER="$ROOT/deploy/health-agent/zeroops-cron-wrapper.sh"
WORK="$ROOT/.cron-wrapper-test-$$"
mkdir -p "$WORK/bin" "$WORK/state"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/bin/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$WORK/bin/curl" <<'EOF'
#!/bin/sh
write_out=''
read_write_out=0
for arg in "$@"; do
  if [ "$read_write_out" = 1 ]; then
    write_out=$arg
    read_write_out=0
  elif [ "$arg" = '--write-out' ]; then
    read_write_out=1
  fi
done
marker=$(printf '%s\n' "$write_out" | sed -n 's/.*\(__ZEROOPS_HTTP_[a-z0-9-]*_[0-9][0-9]*:\).*/\1/p')
[ -z "$marker" ] || printf '%s%s\n' "$marker" "${MOCK_HTTP_STATUS:-200}" >&2
exit "${MOCK_CURL_EXIT:-0}"
EOF
chmod +x "$WORK/bin/flock" "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"
export SHELL=/bin/sh

"$BASH" "$WRAPPER" --state-dir "$WORK/state" --id test-success -- \
  'curl https://not-called.invalid/ >/dev/null 2>&1'
IFS='|' read -r attempt exit_code http_status curl_exit completed completed_status failure failure_code progress \
  < "$WORK/state/test-success.state"
[ "$exit_code" = 0 ] && [ "$http_status" = 200 ] && [ "$curl_exit" = 0 ]
[ -n "$completed" ] && [ "$completed_status" = 200 ] && [ -z "$failure" ] && [ "$progress" = 0 ]

env -u ZEROOPS_CRON_COMMAND -u ZEROOPS_CRON_TASK_ID -u ZEROOPS_CRON_HTTP_RESULT_FILE \
  -u ZEROOPS_CRON_CURL_STDERR_FILE -u ZEROOPS_CRON_HTTP_MARKER \
  "$BASH" "$WRAPPER" --state-dir "$WORK/state" --id test-arguments -- \
  "if env | grep -q '^ZEROOPS_CRON_'; then exit 91; fi; if [ \"\$#\" -ne 0 ]; then exit 92; fi; printf '%s|%s' 'space value' 'argument' > '$WORK/arguments'"
[ "$(cat "$WORK/arguments")" = 'space value|argument' ]

MOCK_HTTP_STATUS=500 "$BASH" "$WRAPPER" --state-dir "$WORK/state" --id test-success -- \
  'curl https://not-called.invalid/ >/dev/null 2>&1'
IFS='|' read -r attempt exit_code http_status curl_exit completed completed_status failure failure_code progress \
  < "$WORK/state/test-success.state"
[ "$exit_code" = 0 ] && [ "$http_status" = 500 ] && [ "$completed_status" = 200 ]
[ "$failure_code" = http:500 ] && [ "$progress" = 0 ]

set +e
MOCK_HTTP_STATUS=000 MOCK_CURL_EXIT=7 "$BASH" "$WRAPPER" --state-dir "$WORK/state" --id test-failure -- \
  'curl https://not-called.invalid/ >/dev/null 2>&1'
result=$?
set -e
[ "$result" = 7 ]
IFS='|' read -r attempt exit_code http_status curl_exit completed completed_status failure failure_code progress \
  < "$WORK/state/test-failure.state"
[ "$exit_code" = 7 ] && [ "$curl_exit" = 7 ] && [ "$failure_code" = curl_exit:7 ]

set +e
"$BASH" "$WRAPPER" --state-dir "$WORK/state" --id test-exit -- 'exit 23'
result=$?
set -e
[ "$result" = 23 ]
IFS='|' read -r attempt exit_code http_status curl_exit completed completed_status failure failure_code progress \
  < "$WORK/state/test-exit.state"
[ "$exit_code" = 23 ] && [ "$failure_code" = exit:23 ]

printf 'not a directory\n' > "$WORK/not-a-directory"
"$BASH" "$WRAPPER" --state-dir "$WORK/not-a-directory" --id test-write-failure -- \
  "printf executed > '$WORK/command-ran'"
[ -f "$WORK/command-ran" ]
set +e
"$BASH" "$WRAPPER" --state-dir "$WORK/not-a-directory" --id test-http-write-failure -- \
  'curl https://not-called.invalid/' 2> "$WORK/http-write-failure.log"
result=$?
set -e
if [ "$result" -ne 0 ]; then
  cat "$WORK/http-write-failure.log" >&2
  exit 1
fi
grep -q 'phase=http_status code=write_failed' "$WORK/http-write-failure.log" || {
  cat "$WORK/http-write-failure.log" >&2
  exit 1
}

printf 'Cron wrapper tests passed.\n'
