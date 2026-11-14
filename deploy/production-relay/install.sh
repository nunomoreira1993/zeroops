#!/bin/sh
# Instala/atualiza o relay de Producao do ZeroOps. Idempotente; nao altera o site nem os seus dados.
#   sh install.sh                      instala ou atualiza a instancia principal (Pizza Hut)
#   sh install.sh --remove             desativa o servico e remove o utilizador MySQL (ver README)
#   DB_NAME=pizzamovil LOG_ROOT=/var/www/vhosts/pizzamovil.es/httpdocs/log \
#     sh install.sh --instance pizzamovil   instancia adicional (outro site/projeto no mesmo servidor)
# Cada instancia tem pasta, token, utilizador MySQL e servico proprios.
# O token e gravado a parte em <pasta>/token.env (nunca passa por argumentos).
set -eu

REMOVE=
INSTANCE=
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) REMOVE=1 ;;
    --instance) INSTANCE=${2:-}; shift ;;
    *) echo "Argumento desconhecido: $1" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "$INSTANCE" ] && ! printf '%s' "$INSTANCE" | grep -Eq '^[a-z0-9][a-z0-9-]{0,30}$'; then
  echo "Nome de instancia invalido (minusculas, digitos e hifen)." >&2
  exit 1
fi

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=/opt/zeroops-relay
if [ -n "$INSTANCE" ]; then
  CONF_DIR=/etc/zeroops-relay-$INSTANCE
  SERVICE=zeroops-relay-$INSTANCE
  DB_NAME=${DB_NAME:-$INSTANCE}
  DB_USER=zeroops_agent_$(printf '%s' "$INSTANCE" | tr '-' '_')
else
  CONF_DIR=/etc/zeroops-relay
  SERVICE=zeroops-relay
  DB_NAME=${DB_NAME:-pizzahut}
  DB_USER=zeroops_agent
fi
LOG_ROOT=${LOG_ROOT:-/var/www/vhosts/pizzahut.pt/httpdocs/log}

if [ "$(id -u)" -ne 0 ]; then
  echo "Executar como root." >&2
  exit 1
fi

if [ -n "$REMOVE" ]; then
  systemctl disable --now "$SERVICE.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service" "/etc/polkit-1/rules.d/60-${SERVICE}.rules"
  systemctl daemon-reload
  mysql -e "DROP USER IF EXISTS '${DB_USER}'@'localhost'"
  echo "Relay removido. Configuracao mantida em ${CONF_DIR} (apagar manualmente se pretendido)."
  exit 0
fi

php -m | grep -qi '^pdo_mysql$' || { echo "Falta a extensao pdo_mysql." >&2; exit 1; }
php -m | grep -qi '^curl$' || { echo "Falta a extensao curl." >&2; exit 1; }

id zeroops-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin zeroops-relay

install -d -m 0755 "$APP_DIR"
install -m 0644 "$SRC_DIR/zeroops-relay.php" "$APP_DIR/zeroops-relay.php"
php -l "$APP_DIR/zeroops-relay.php" >/dev/null

install -d -m 0750 -o root -g zeroops-relay "$CONF_DIR"

if [ ! -f "$CONF_DIR/relay.env" ]; then
  # Reaproveita o destino ja validado pelo agente de Saude (URL, resolucao e CA do ZeroOps).
  HEALTH_ENV=/etc/zeroops-health/health-agent.env
  URL=https://tickets.pizzahut.pt
  RESOLVE=
  if [ -f "$HEALTH_ENV" ]; then
    URL=$(sed -n 's/^ZEROOPS_URL=//p' "$HEALTH_ENV" | tr -d '"' | head -n1)
    RESOLVE=$(sed -n 's/^ZEROOPS_RESOLVE=//p' "$HEALTH_ENV" | tr -d '"' | head -n1)
  fi
  if [ -f /etc/zeroops-health/qa-ca.pem ]; then
    install -m 0640 -o root -g zeroops-relay /etc/zeroops-health/qa-ca.pem "$CONF_DIR/qa-ca.pem"
  fi
  {
    echo "ZEROOPS_URL=${URL}"
    echo "ZEROOPS_RESOLVE=${RESOLVE}"
    [ -f "$CONF_DIR/qa-ca.pem" ] && echo "ZEROOPS_CACERT=${CONF_DIR}/qa-ca.pem"
    echo "LOG_ROOT=${LOG_ROOT}"
    echo "ZEROOPS_ENVIRONMENT=${ENVIRONMENT:-production}"
    echo "ALLOWED_UNITS=${ALLOWED_UNITS:-}"
    echo "ALLOW_REBOOT=${ALLOW_REBOOT:-0}"
  } > "$CONF_DIR/relay.env"
  chown root:zeroops-relay "$CONF_DIR/relay.env"
  chmod 0640 "$CONF_DIR/relay.env"
fi

# Relays anteriores a 1.1.0: acrescenta as chaves das intervencoes (desligadas ate serem preenchidas).
grep -q '^ZEROOPS_ENVIRONMENT=' "$CONF_DIR/relay.env" || echo "ZEROOPS_ENVIRONMENT=${ENVIRONMENT:-production}" >> "$CONF_DIR/relay.env"
grep -q '^ALLOWED_UNITS=' "$CONF_DIR/relay.env" || echo "ALLOWED_UNITS=${ALLOWED_UNITS:-}" >> "$CONF_DIR/relay.env"
grep -q '^ALLOW_REBOOT=' "$CONF_DIR/relay.env" || echo "ALLOW_REBOOT=${ALLOW_REBOOT:-0}" >> "$CONF_DIR/relay.env"

# Regra polkit: o utilizador do relay so pode reiniciar/ajustar as unidades autorizadas desta instancia
# (e reiniciar o servidor se ALLOW_REBOOT=1). Sem unidades nem reboot, nao ha regra e tudo e recusado.
POLKIT_RULE=/etc/polkit-1/rules.d/60-${SERVICE}.rules
UNITS=$(sed -n 's/^ALLOWED_UNITS=//p' "$CONF_DIR/relay.env" | tr -d '"' | head -n1)
REBOOT=$(sed -n 's/^ALLOW_REBOOT=//p' "$CONF_DIR/relay.env" | tr -d '"' | head -n1)
UNIT_LIST=
for unit in $(printf '%s' "$UNITS" | tr ',' ' '); do
  printf '%s' "$unit" | grep -Eq '^[A-Za-z0-9@_.:-]+$' || { echo "Unidade invalida em ALLOWED_UNITS: $unit" >&2; exit 1; }
  case "$unit" in *.*) ;; *) unit="$unit.service" ;; esac
  UNIT_LIST="${UNIT_LIST}${UNIT_LIST:+, }\"$unit\""
done
if [ -n "$UNIT_LIST" ] || [ "$REBOOT" = "1" ]; then
  install -d -m 0755 /etc/polkit-1/rules.d
  {
    echo "// Gerado por install.sh do relay ZeroOps (${SERVICE}). Nao editar: alterar relay.env e reinstalar."
    echo "polkit.addRule(function (action, subject) {"
    echo "  if (subject.user !== \"zeroops-relay\") return polkit.Result.NOT_HANDLED;"
    echo "  var units = [${UNIT_LIST}];"
    echo "  if (action.id === \"org.freedesktop.systemd1.manage-units\""
    echo "      && units.indexOf(action.lookup(\"unit\")) >= 0"
    echo "      && [\"restart\", \"set-property\"].indexOf(action.lookup(\"verb\")) >= 0) {"
    echo "    return polkit.Result.YES;"
    echo "  }"
    if [ "$REBOOT" = "1" ]; then
      echo "  if (action.id.indexOf(\"org.freedesktop.login1.reboot\") === 0) return polkit.Result.YES;"
    fi
    echo "  return polkit.Result.NOT_HANDLED;"
    echo "});"
  } > "$POLKIT_RULE"
  chmod 0644 "$POLKIT_RULE"
else
  rm -f "$POLKIT_RULE"
fi

if [ ! -f "$CONF_DIR/agent-mysql.cnf" ]; then
  PASSWORD=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  SOCKET=$(mysql -Nse "SELECT @@socket")
  mysql <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${PASSWORD}' WITH MAX_USER_CONNECTIONS 3 MAX_STATEMENT_TIME 20;
GRANT SELECT ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
SQL
  umask 077
  {
    echo "[client]"
    echo "user=${DB_USER}"
    echo "password=${PASSWORD}"
    echo "socket=${SOCKET}"
    echo "database=${DB_NAME}"
  } > "$CONF_DIR/agent-mysql.cnf"
  chown root:zeroops-relay "$CONF_DIR/agent-mysql.cnf"
  chmod 0640 "$CONF_DIR/agent-mysql.cnf"
fi

# A unidade passa a pasta de configuracao da instancia ao relay.
sed -e 's/\r$//' \
  -e "s|^ExecStart=.*zeroops-relay.php.*|& $CONF_DIR|" \
  -e "s|^Description=.*|& [${INSTANCE:-principal}]|" \
  "$SRC_DIR/zeroops-relay.service" > "/etc/systemd/system/$SERVICE.service"
chmod 0644 "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload

if [ -s "$CONF_DIR/token.env" ]; then
  chown root:zeroops-relay "$CONF_DIR/token.env"
  chmod 0640 "$CONF_DIR/token.env"
  systemctl enable "$SERVICE.service" >/dev/null 2>&1
  systemctl restart "$SERVICE.service"
  echo "Relay ativo: systemctl status $SERVICE"
else
  echo "Instalado. Falta o token: gerar em Integracoes > Agente de investigacao e gravar em"
  echo "  ${CONF_DIR}/token.env  (ZEROOPS_RELAY_TOKEN=zor_...), depois: sh install.sh${INSTANCE:+ --instance $INSTANCE}"
fi
