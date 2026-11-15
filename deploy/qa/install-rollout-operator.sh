#!/usr/bin/env bash
# Instala/atualiza o operador independente de rollout do ZeroOps (P10) em Qualidade.
#   sudo bash install-rollout-operator.sh [pasta-com-os-ficheiros]
# Copia o operador para um caminho estavel (nao muda quando o deploy troca /opt/zeroops/src), cria o
# ficheiro de ambiente com um segredo novo se ainda nao existir (nunca o imprime) e ativa o servico.
# O segredo e o mesmo a configurar na pipeline do projeto no ZeroOps (copiar do ficheiro, no host).
set -euo pipefail

SRC_DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
EXPECTED_HOST="${ZEROOPS_EXPECTED_HOST:-uqphorders24-dev}"
ENV_FILE=/etc/zeroops/rollout-operator.env
[ "$(id -u)" = 0 ] || { echo "Requer root." >&2; exit 1; }
[ "$(hostname)" = "$EXPECTED_HOST" ] || { echo "Host inesperado $(hostname)." >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3, 8)'

install -d -m 0755 /usr/local/lib/zeroops
install -d -m 0750 /var/lib/zeroops-rollout /var/log/zeroops /etc/zeroops
install -m 0755 "$SRC_DIR/zeroops-rollout-operator.py" /usr/local/lib/zeroops/zeroops-rollout-operator.py
install -m 0644 "$SRC_DIR/zeroops-rollout-operator.service" /etc/systemd/system/zeroops-rollout-operator.service

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat >"$ENV_FILE" <<EOF
ZEROOPS_ROLLOUT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
ZEROOPS_ROLLOUT_BIND=127.0.0.1
ZEROOPS_ROLLOUT_PORT=4320
ZEROOPS_ROLLOUT_STATE_DIR=/var/lib/zeroops-rollout
ZEROOPS_ROLLOUT_SOURCE_REPO=/opt/zeroops/test-repos/zeroops-capabilities.git
ZEROOPS_ROLLOUT_TARGET_REPO=/opt/zeroops/repo.git
ZEROOPS_ROLLOUT_TARGET_BRANCH=main
ZEROOPS_ROLLOUT_ALLOWED_REFS=main
ZEROOPS_ROLLOUT_ALLOWED_ENVIRONMENTS=quality
ZEROOPS_ROLLOUT_CALLBACK_ORIGIN=http://127.0.0.1:4311
ZEROOPS_ROLLOUT_OBSERVE_SECONDS=30
EOF
  echo "Criado $ENV_FILE (segredo novo; nao impresso)."
fi
chmod 600 "$ENV_FILE"

systemctl daemon-reload
systemctl enable zeroops-rollout-operator.service >/dev/null
systemctl restart zeroops-rollout-operator.service
for _ in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:4320/health >/dev/null 2>&1; then
    echo "OK: operador de rollout ativo em 127.0.0.1:4320"
    exit 0
  fi
  sleep 1
done
echo "ERRO: operador nao respondeu; ver /var/log/zeroops/rollout-operator.log" >&2
exit 1