#!/usr/bin/env bash
# Publica um commit do repositorio bare em Qualidade. Chamado pelo hook post-receive:
#   deploy-from-git.sh <sha>
# Passos: exporta o commit, constroi imagens, backup da BD ZeroOps, migracoes, arranque e health check.
# Se a build falhar nada muda; se migracao/arranque/health falharem, repoe codigo e imagens anteriores.
# A BD nao e restaurada automaticamente: o backup fica em $BACKUP_DIR para restauro manual.
set -euo pipefail

SHA="${1:?commit em falta}"
EXPECTED_HOST="${ZEROOPS_EXPECTED_HOST:-uqphorders24-dev}"
REPO="${ZEROOPS_REPO:-/opt/zeroops/repo.git}"
BASE="${ZEROOPS_BASE:-/opt/zeroops}"
LOG_FILE="${ZEROOPS_DEPLOY_LOG:-/var/log/zeroops/deploy.log}"
BACKUP_DIR="${ZEROOPS_BACKUP_DIR:-/var/backups/zeroops}"
DB_CNF="${ZEROOPS_DB_CNF:-/root/.zeroops/zeroops-mysql.cnf}"
KEEP_BACKUPS=10
KEEP_IMAGES=3

install -d -m 750 "$(dirname "$LOG_FILE")" "$BACKUP_DIR"
log() { printf '[%s] %s\n' "$(date -Is)" "$*" | tee -a "$LOG_FILE"; }
fail() {
  log "ERRO: $*"
  exit 1
}

[ "$(hostname)" = "$EXPECTED_HOST" ] || fail "host inesperado $(hostname)"
exec 9>/run/lock/zeroops-deploy.lock
flock -n 9 || fail "outro deploy em curso"

TAG="g${SHA:0:12}"
log "Deploy $SHA (imagem $TAG)"

rm -rf "$BASE/src.new" && mkdir -p "$BASE/src.new"
git --git-dir="$REPO" archive "$SHA" | tar -x -C "$BASE/src.new"
echo "$SHA" >"$BASE/src.new/deploy/qa/VERSION"

cd "$BASE/src.new/deploy/docker"
log "Build api/executor"
ZEROOPS_IMAGE_TAG="$TAG" docker compose build --quiet api executor 2>&1 | tee -a "$LOG_FILE" ||
  fail "build falhou; nada foi alterado"

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
  if [ -d "$BASE/src.prev" ]; then
    rm -rf "$BASE/src.failed" && mv "$BASE/src" "$BASE/src.failed" && mv "$BASE/src.prev" "$BASE/src"
  fi
  for image in zeroops zeroops-executor; do
    if docker image inspect "$image:rollback" >/dev/null 2>&1; then docker tag "$image:rollback" "$image:latest"; fi
  done
  previous_version=$(cat "$BASE/src/deploy/qa/VERSION" 2>/dev/null || echo local)
  (cd "$BASE/src/deploy/docker" && ZEROOPS_VERSION="$previous_version" ZEROOPS_IMAGE_TAG=latest \
    docker compose up -d api worker connectors executor) 2>&1 |
    tee -a "$LOG_FILE" || true
  fail "$1 (codigo e imagens repostos; BD com backup em $backup)"
}

rm -rf "$BASE/src.prev"
if [ -d "$BASE/src" ]; then mv "$BASE/src" "$BASE/src.prev"; fi
mv "$BASE/src.new" "$BASE/src"
cd "$BASE/src/deploy/docker"

docker tag "zeroops:$TAG" zeroops:latest
docker tag "zeroops-executor:$TAG" zeroops-executor:latest

log "Migracoes"
ZEROOPS_IMAGE_TAG=latest docker compose run --rm -T migrate </dev/null 2>&1 | tee -a "$LOG_FILE" ||
  rollback "migracao falhou"

log "Arranque"
ZEROOPS_VERSION="$SHA" ZEROOPS_IMAGE_TAG=latest docker compose up -d api worker connectors executor 2>&1 |
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

# Observabilidade: falhas aqui nao revertem a aplicacao. O Alertmanager so arranca com o token presente
# (senao o Docker criaria um diretorio no lugar do ficheiro).
observability="prometheus node-exporter redis-exporter mysqld-exporter blackbox-exporter"
if [ -f /etc/zeroops/observability/alertmanager-token ]; then observability="$observability alertmanager"; fi
# Tokens de outros projetos (alertmanager.yml); a pasta tem de existir para o bind do Alertmanager.
install -d -m 0755 /etc/zeroops/observability/projects
log "Observabilidade: $observability"
# Recriados sempre: os ficheiros de configuracao montados vivem em $BASE/src, que e trocado em cada deploy.
# shellcheck disable=SC2086
docker compose up -d --force-recreate $observability 2>&1 | tee -a "$LOG_FILE" ||
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
