#!/usr/bin/env bash
# Publica um commit do repositorio bare em Qualidade. Chamado pelo hook post-receive:
#   deploy-from-git.sh <sha>
# Passos: exporta o commit, constroi imagens, drena e para o executor, backup da BD ZeroOps, migracoes,
# arranque e health check.
# Se a build, a drenagem ou o backup falharem nada muda (o executor anterior volta a arrancar); se
# migracao/arranque/health falharem, repoe codigo e imagens anteriores.
# A BD nao e restaurada automaticamente: o backup fica em $BACKUP_DIR para restauro manual.
set -euo pipefail

SHA="${1:?commit em falta}"
EXPECTED_HOST="${ZEROOPS_EXPECTED_HOST:-uqphorders24-dev}"
REPO="${ZEROOPS_REPO:-/opt/zeroops/repo.git}"
BASE="${ZEROOPS_BASE:-/opt/zeroops}"
LOG_FILE="${ZEROOPS_DEPLOY_LOG:-/var/log/zeroops/deploy.log}"
BACKUP_DIR="${ZEROOPS_BACKUP_DIR:-/var/backups/zeroops}"
DB_CNF="${ZEROOPS_DB_CNF:-/root/.zeroops/zeroops-mysql.cnf}"
ENV_FILE="${ZEROOPS_ENV_FILE:-/etc/zeroops/zeroops.env}"
KEEP_BACKUPS=10
KEEP_IMAGES=3
# P10: drenagem antes da troca (os executores deixam de reclamar jobs; espera pelos jobs com lease).
DRAIN_WAIT_SECONDS="${ZEROOPS_DRAIN_WAIT_SECONDS:-300}"
DRAIN_TTL_SECONDS="${ZEROOPS_DRAIN_TTL_SECONDS:-1800}"
DRAIN_FORCE="${ZEROOPS_DRAIN_FORCE:-0}"

install -d -m 750 "$(dirname "$LOG_FILE")" "$BACKUP_DIR"
log() { printf '[%s] %s\n' "$(date -Is)" "$*" | tee -a "$LOG_FILE"; }
fail() {
  log "ERRO: $*"
  exit 1
}

[ "$(hostname)" = "$EXPECTED_HOST" ] || fail "host inesperado $(hostname)"
[ -r "$ENV_FILE" ] || fail "ficheiro de ambiente inacessivel; nada foi alterado"
exec 9>"${ZEROOPS_DEPLOY_LOCK:-/run/lock/zeroops-deploy.lock}"
flock -n 9 || fail "outro deploy em curso"

TAG="g${SHA:0:12}"
log "Deploy $SHA (imagem $TAG)"

rm -rf "$BASE/src.new" && mkdir -p "$BASE/src.new"
git --git-dir="$REPO" archive "$SHA" | tar -x -C "$BASE/src.new"
echo "$SHA" >"$BASE/src.new/deploy/qa/VERSION"

cd "$BASE/src.new/deploy/docker"
log "Build api/executor"
ZEROOPS_IMAGE_TAG="$TAG" docker compose --env-file "$ENV_FILE" build --quiet api executor 2>&1 | tee -a "$LOG_FILE" ||
  fail "build falhou; nada foi alterado"

# Drenagem (sempre, antes de qualquer alteracao): pede aos executores que deixem de reclamar jobs, espera
# que os jobs com lease terminem e para o executor em execucao. Sem a tabela de drenagem (BD anterior a
# migracao 044) os jobs contam-se diretamente nas tabelas e a paragem do executor impede novos claims.
# Esgotado o prazo nada e alterado (salvo ZEROOPS_DRAIN_FORCE=1): perguntas pendentes e runs longos ficam
# intactos e o executor anterior volta a arrancar se o deploy parar antes da troca.
sql() { mysql --defaults-file="$DB_CNF" -N -B -e "$1"; }
compose() { docker compose --env-file "$ENV_FILE" "$@"; }
compose_current() { (cd "$BASE/src/deploy/docker" && compose "$@"); }
drain_id=""
executor_stopped=0
swapped=0
release_drain() {
  if [ -n "$drain_id" ]; then
    sql "UPDATE zeroops_runtime_drains SET released_at=NOW(3) WHERE id='$drain_id'" >/dev/null 2>&1 ||
      log "AVISO: nao foi possivel libertar a drenagem $drain_id (expira sozinha)"
    drain_id=""
  fi
}
on_exit() {
  if [ "$executor_stopped" = 1 ] && [ "$swapped" = 0 ]; then
    log "Deploy interrompido antes da troca: a reativar o executor anterior"
    compose_current start executor 2>&1 | tee -a "$LOG_FILE" ||
      log "AVISO: executor anterior nao arrancou; iniciar com 'docker compose --env-file $ENV_FILE start executor'"
  fi
  release_drain
}
trap on_exit EXIT

# Mesmas condicoes da vista zeroops_active_jobs (044); antes dela contam-se as tabelas existentes.
views=$(sql "SELECT COUNT(*) FROM information_schema.views
  WHERE table_schema=DATABASE() AND table_name='zeroops_active_jobs'") || fail "BD inacessivel; nada foi alterado"
if [ "$views" = 1 ]; then
  active_jobs_sql="SELECT COUNT(*) FROM zeroops_active_jobs"
else
  job_tables=$(sql "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN
    ('agent_runs','flow_assistant_requests','ticket_routing_jobs','flow_simulation_runs','delivery_runs')") ||
    fail "BD inacessivel; nada foi alterado"
  parts=""
  for table in $job_tables; do
    condition="status='running'"
    [ "$table" = delivery_runs ] && condition="worker_id IS NOT NULL"
    parts="$parts${parts:+ + }(SELECT COUNT(*) FROM $table WHERE $condition AND lease_until > NOW(3))"
  done
  active_jobs_sql="SELECT ${parts:-0}"
fi
wait_for_jobs() {
  local waited=0
  while :; do
    active=$(sql "$active_jobs_sql" 2>/dev/null || echo "?")
    [ "$active" = 0 ] && return 0
    if [ "$waited" -ge "$DRAIN_WAIT_SECONDS" ]; then
      if [ "$DRAIN_FORCE" = 1 ]; then
        log "AVISO: $1: drenagem expirou com $active job(s) ativos; ZEROOPS_DRAIN_FORCE=1 (devolvidos a fila no arranque)"
        return 0
      fi
      fail "$1: drenagem expirou com $active job(s) ativos; nada foi alterado"
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

candidate_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf 'deploy-%s-%s' "$(date +%s)" "$$")
if sql "INSERT INTO zeroops_runtime_drains(id,reason,requested_by,correlation,expires_at)
  VALUES('$candidate_id','deploy $TAG','deploy-from-git','${ZEROOPS_DEPLOY_CORRELATION:-$SHA}',
  NOW(3) + INTERVAL $DRAIN_TTL_SECONDS SECOND)" >/dev/null 2>&1; then
  drain_id="$candidate_id"
  log "Drenagem $drain_id: a aguardar jobs ativos (max ${DRAIN_WAIT_SECONDS}s)"
else
  log "Drenagem de arranque (BD sem tabela de drenagem, anterior a 044): a aguardar jobs ativos (max ${DRAIN_WAIT_SECONDS}s)"
fi
wait_for_jobs "antes da paragem"
log "Jobs ativos: $active"
# A paragem ordenada (SIGTERM, stop_grace_period) devolve a fila, sem consumir tentativa, o que tiver
# sido reclamado entretanto; executores sem suporte de drenagem tambem deixam assim de reclamar.
if [ -d "$BASE/src/deploy/docker" ] && [ -n "$(compose_current ps -q executor 2>/dev/null)" ]; then
  executor_stopped=1
  log "A parar o executor anterior (sem novos claims ate ao arranque da versao nova)"
  compose_current stop executor 2>&1 | tee -a "$LOG_FILE" || fail "paragem do executor falhou"
  wait_for_jobs "apos a paragem do executor"
  log "Executor parado; jobs ativos: $active"
fi
log "Drenagem concluida"

# Imagens em execucao ficam como :rollback para reposicao rapida.
for image in zeroops zeroops-executor; do
  if docker image inspect "$image:latest" >/dev/null 2>&1; then docker tag "$image:latest" "$image:rollback"; fi
done

# mysqldump nao aceita a opcao `database` do [client]; usa uma copia temporaria sem ela.
db_name=$(awk -F= '/^[[:space:]]*database[[:space:]]*=/{gsub(/[[:space:]"'"'"']/,"",$2); print $2}' "$DB_CNF")
dump_cnf=$(mktemp)
chmod 600 "$dump_cnf"
grep -v '^[[:space:]]*database[[:space:]]*=' "$DB_CNF" >"$dump_cnf"
backup="$BACKUP_DIR/zeroops-$(date +%Y%m%dT%H%M%S)-$TAG.sql.gz"
log "Backup da BD $db_name -> $backup"
if ! (umask 077 && mysqldump --defaults-extra-file="$dump_cnf" --single-transaction --routines --no-tablespaces \
  "$db_name" | gzip >"$backup"); then
  rm -f "$dump_cnf" "$backup"
  fail "backup falhou; deploy cancelado"
fi
rm -f "$dump_cnf"
ls -1t "$BACKUP_DIR"/zeroops-*.sql.gz | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

rollback() {
  log "A repor versao anterior"
  cd "$BASE"
  if [ -d "$BASE/src.prev" ]; then
    rm -rf "$BASE/src.failed"
    if [ -d "$BASE/src" ]; then mv "$BASE/src" "$BASE/src.failed"; fi
    mv "$BASE/src.prev" "$BASE/src" || log "AVISO: nao foi possivel repor $BASE/src.prev"
  fi
  for image in zeroops zeroops-executor; do
    if docker image inspect "$image:rollback" >/dev/null 2>&1; then docker tag "$image:rollback" "$image:latest"; fi
  done
  previous_version=$(cat "$BASE/src/deploy/qa/VERSION" 2>/dev/null || echo local)
  (cd "$BASE/src/deploy/docker" && ZEROOPS_VERSION="$previous_version" ZEROOPS_IMAGE_TAG=latest \
    compose up -d api worker connectors executor) 2>&1 |
    tee -a "$LOG_FILE" || true
  fail "$1 (codigo e imagens repostos; BD com backup em $backup)"
}

swapped=1
cd "$BASE"
rm -rf "$BASE/src.prev"
if [ -d "$BASE/src" ]; then mv "$BASE/src" "$BASE/src.prev" || rollback "troca do codigo falhou"; fi
mv "$BASE/src.new" "$BASE/src" || rollback "troca do codigo falhou"
cd "$BASE/src/deploy/docker" || rollback "troca do codigo falhou"

docker tag "zeroops:$TAG" zeroops:latest || rollback "tag da imagem falhou"
docker tag "zeroops-executor:$TAG" zeroops-executor:latest || rollback "tag da imagem falhou"

log "Migracoes"
ZEROOPS_IMAGE_TAG=latest compose run --rm -T migrate </dev/null 2>&1 | tee -a "$LOG_FILE" ||
  rollback "migracao falhou"

log "Arranque"
ZEROOPS_VERSION="$SHA" ZEROOPS_IMAGE_TAG=latest compose up -d api worker connectors executor 2>&1 |
  tee -a "$LOG_FILE" || rollback "arranque falhou"

healthy=0
for _ in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:4311/api/health 2>/dev/null | grep -q "\"version\":\"$SHA\"" &&
    curl -fsS -o /dev/null http://127.0.0.1:4312/v1/health; then
    healthy=1
    break
  fi
  sleep 2
done
[ "$healthy" = 1 ] || rollback "health check falhou"
# Versao nova saudavel: os executores voltam a reclamar jobs.
release_drain

# Observabilidade: falhas aqui nao revertem a aplicacao. O Alertmanager so arranca com o token presente
# (senao o Docker criaria um diretorio no lugar do ficheiro).
observability="prometheus node-exporter redis-exporter mysqld-exporter blackbox-exporter"
OBSERVABILITY_ETC="${ZEROOPS_OBSERVABILITY_ETC:-/etc/zeroops/observability}"
if [ -f "$OBSERVABILITY_ETC/alertmanager-token" ]; then observability="$observability alertmanager"; fi
# Tokens de outros projetos (alertmanager.yml); a pasta tem de existir para o bind do Alertmanager.
install -d -m 0755 "$OBSERVABILITY_ETC/projects"
log "Observabilidade: $observability"
# Recriados sempre: os ficheiros de configuracao montados vivem em $BASE/src, que e trocado em cada deploy.
# shellcheck disable=SC2086
compose up -d --force-recreate $observability 2>&1 | tee -a "$LOG_FILE" ||
  log "AVISO: observabilidade nao arrancou"

# Mantem as imagens das ultimas versoes publicadas e limpa camadas orfas.
for image in zeroops zeroops-executor; do
  docker images "$image" --format '{{.Tag}} {{.CreatedAt}}' | awk '$1 ~ /^g[0-9a-f]{12}$/' | sort -k2 -r |
    tail -n +$((KEEP_IMAGES + 1)) | awk -v i="$image" '{print i":"$1}' | xargs -r docker rmi >/dev/null 2>&1 || true
done
docker image prune -f >/dev/null 2>&1 || true
# A cache de build cresce em cada deploy (chegou a 23 GB e encheu o disco de QA): fica limitada a 3 GB.
docker builder prune -f --keep-storage 3gb >/dev/null 2>&1 || true

log "OK: $SHA ativo em https://tickets.pizzahut.pt"
