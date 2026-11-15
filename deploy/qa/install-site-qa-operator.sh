#!/usr/bin/env bash
# Instala o endpoint do ensaio; nao integra nem publica o site.
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
ENV_FILE=/etc/zeroops/site-qa-operator.env
STATE=/var/lib/zeroops-site-qa
WEBROOT=/var/www/vhosts/pizzahut.pt/httpdocs
GIT_DIR=/var/www/vhosts/pizzahut.pt/.pizzahut-git
SOURCE=https://github.com/numoreira/pizzahut.git
CA_FILE=/etc/zeroops/site-qa-ca.pem
FINGERPRINT=B9455909783F44D46E3F4A44832043FE92BEC2AF2B7E7638A5977F146EAF4CC5

[ "$(id -u)" = 0 ] && [ "$(hostname)" = uqphorders24-dev ] || {
  echo "Host QA/root obrigatorios." >&2; exit 1;
}
[ "$(runuser -u pizzahut -- git --git-dir="$GIT_DIR" --work-tree="$WEBROOT" config --get remote.origin.url)" = "$SOURCE" ]
[ "$(runuser -u pizzahut -- git --git-dir="$GIT_DIR" --work-tree="$WEBROOT" symbolic-ref --short HEAD)" = qa ]
python3 -c 'import sys; assert sys.version_info >= (3, 8)'
command -v setpriv >/dev/null
umask 077
install -d -m 0700 "$STATE" /var/backups/zeroops-site-qa
install -d -m 0755 /usr/local/lib/zeroops
install -d -m 0750 /etc/zeroops /var/log/zeroops

certificate=$(mktemp)
trap 'rm -f "$certificate"' EXIT
openssl s_client -connect 127.0.0.1:443 -servername dev.pizzahut.pt </dev/null 2>/dev/null |
  openssl x509 -out "$certificate"
actual=$(openssl x509 -in "$certificate" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)
[ "$actual" = "$FINGERPRINT" ] || { echo "Certificado diferente do validado por SSH." >&2; exit 1; }
install -m 0600 "$certificate" "$CA_FILE"
curl --cacert "$CA_FILE" -fsSL https://dev.pizzahut.pt/adm/ >/dev/null

for file in zeroops-rollout-operator.py site-qa-operator.py site-qa-credential.mjs; do
  install -m 0644 "$SRC_DIR/$file" "/usr/local/lib/zeroops/$file"
done
install -m 0644 "$SRC_DIR/site-qa-operator.service" /etc/systemd/system/site-qa-operator.service
if [ ! -f "$STATE/repo.git/HEAD" ]; then
  git init --bare --quiet "$STATE/repo.git"
  git --git-dir="$STATE/repo.git" fetch --no-tags --quiet "$GIT_DIR" refs/heads/qa:refs/heads/qa
fi
if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
ZEROOPS_ROLLOUT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
ZEROOPS_ROLLOUT_BIND=127.0.0.1
ZEROOPS_ROLLOUT_PORT=4321
ZEROOPS_ROLLOUT_STATE_DIR=$STATE
ZEROOPS_ROLLOUT_SOURCE_REPO=$SOURCE
ZEROOPS_ROLLOUT_TARGET_REPO=$STATE/repo.git
ZEROOPS_ROLLOUT_TARGET_BRANCH=qa
ZEROOPS_ROLLOUT_ALLOWED_REFS=qa
ZEROOPS_ROLLOUT_ALLOWED_ENVIRONMENTS=quality
ZEROOPS_ROLLOUT_CALLBACK_ORIGIN=http://127.0.0.1:4311
ZEROOPS_ROLLOUT_OBSERVE_SECONDS=15
ZEROOPS_SITE_WEBROOT=$WEBROOT
ZEROOPS_SITE_GIT_DIR=$GIT_DIR
ZEROOPS_SITE_USER=pizzahut
ZEROOPS_SITE_PROJECT_ID=00000000-0000-4000-8000-000000000001
ZEROOPS_SITE_REPOSITORY_ID=7bbf20fa-8f92-4f16-a2f6-d0989ebb38b2
ZEROOPS_SITE_EXPECTED_HOST=uqphorders24-dev
ZEROOPS_SITE_HEALTH_URL=https://dev.pizzahut.pt/adm/
ZEROOPS_SITE_CA_FILE=$CA_FILE
ZEROOPS_SITE_BACKUP_DIR=/var/backups/zeroops-site-qa
ZEROOPS_SITE_PUBLICATION_LOG=/var/log/zeroops/site-qa-publication.log
EOF
fi
chmod 0600 "$ENV_FILE"
cat >/etc/logrotate.d/zeroops-site-qa <<'EOF'
/var/log/zeroops/site-qa-publication.log {
  weekly
  rotate 8
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
EOF
systemctl daemon-reload
systemctl enable site-qa-operator.service >/dev/null
systemctl restart site-qa-operator.service
for _ in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:4321/health >/dev/null; then
    echo "Endpoint QA ativo; o site nao foi alterado. O segredo ficou apenas no ficheiro root-only."
    exit 0
  fi
  sleep 1
done
echo "O operador QA nao respondeu." >&2
exit 1
