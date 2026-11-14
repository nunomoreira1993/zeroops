#!/bin/sh
# Metricas de Producao para o ZeroOps, por papel do servidor:
#   db        (por omissao) exporters node/mysqld/redis + coletor + Prometheus em modo agente que
#             recolhe tambem os outros servidores e envia por remote write para o ZeroOps.
#   frontend | backend | static
#             so node_exporter (no IP privado, aceita apenas o servidor do agente) + coletor.
# O coletor (zeroops-collect.py) le em localhost o estado do Apache, PHP-FPM, nginx, MySQL e DB2.
# Tudo corre com prioridade minima e limites de recursos (ver *.service). Nunca imprime segredos.
#   sh install.sh [--role db]                          instala ou atualiza (idempotente)
#   sh install.sh --role frontend --agent-ip 10.0.0.1  servidor recolhido pelo agente em 10.0.0.1
#   sh install.sh --role backend --fpm-versions '^8\.5'  so pools PHP-FPM 8.5 (regex)
#   sh install.sh [--role X] --remove                  remove o que este papel instalou
set -eu

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=/opt/zeroops-metrics
BIN_DIR=$APP_DIR/bin
LIB_DIR=$APP_DIR/lib
CONF_DIR=/etc/zeroops-metrics
DATA_DIR=/var/lib/zeroops-metrics
HEALTH_DIR=/etc/zeroops-health
DB_USER=zeroops_exporter
HOSTS_MARK='# zeroops-metrics'
STATUS_PORT=8088
APACHE_STATUS_CONF=/etc/apache2/conf-available/zeroops-status.conf
NGINX_STATUS_CONF=/etc/nginx/conf.d/zeroops-status.conf
NODE_DROPIN=/etc/systemd/system/zeroops-node-exporter.service.d

# Releases oficiais (GitHub) com sha256 fixado a partir dos sha256sums.txt publicados.
RELEASES="
node_exporter|https://github.com/prometheus/node_exporter/releases/download/v1.8.2/node_exporter-1.8.2.linux-amd64.tar.gz|6809dd0b3ec45fd6e992c19071d6b5253aed3ead7bf0686885a51d85c6643c66|node_exporter
mysqld_exporter|https://github.com/prometheus/mysqld_exporter/releases/download/v0.15.1/mysqld_exporter-0.15.1.linux-amd64.tar.gz|85ea5bc68e1b9f466c1df10ff016652dd210371d42245e012b876265e89ae29d|mysqld_exporter
redis_exporter|https://github.com/oliver006/redis_exporter/releases/download/v1.62.0/redis_exporter-v1.62.0.linux-amd64.tar.gz|a09f92a6b366e37c654e50522c7b80e4a625396b2499fd42cf17e1aa91e56d5e|redis_exporter
prometheus|https://github.com/prometheus/prometheus/releases/download/v2.55.1/prometheus-2.55.1.linux-amd64.tar.gz|19700bdd42ec31ee162e4079ebda4cd0a44432df4daa637141bdbea4b1cd8927|prometheus promtool
"

fail() {
  echo "ERRO: $*" >&2
  exit 1
}
warn() { echo "AVISO: $*" >&2; }
env_value() { sed -n "s/^$1=//p" "$2" | tail -n1 | sed "s/^[\"']//; s/[\"']\$//"; }
port_in_use() { ss -ltnH "sport = :$1" | grep -q .; }

ROLE=db
AGENT_IP=
FPM_VERSIONS=
REMOVE=no
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE=${2:-}; shift 2 ;;
    --role=*) ROLE=${1#*=}; shift ;;
    --agent-ip) AGENT_IP=${2:-}; shift 2 ;;
    --agent-ip=*) AGENT_IP=${1#*=}; shift ;;
    --fpm-versions) FPM_VERSIONS=${2:-}; shift 2 ;;
    --fpm-versions=*) FPM_VERSIONS=${1#*=}; shift ;;
    --remove) REMOVE=yes; shift ;;
    *) fail "Opcao desconhecida: $1" ;;
  esac
done
case "$ROLE" in
  db) UNITS="zeroops-prometheus-agent zeroops-node-exporter zeroops-mysqld-exporter zeroops-redis-exporter" ;;
  frontend | backend | static) UNITS="zeroops-node-exporter" ;;
  *) fail "Papel invalido: $ROLE (db, frontend, backend ou static)." ;;
esac

[ "$(id -u)" -eq 0 ] || fail "Executar como root."

# --- Estado do Apache/nginx so em 127.0.0.1:$STATUS_PORT (configtest antes de reload graceful) ---
enable_apache_status() {
  systemctl is-active --quiet apache2 2>/dev/null || return 0
  if ! apache2ctl -M 2>/dev/null | grep -q status_module; then
    warn "mod_status inativo: Apache sem metricas de workers."
    return 0
  fi
  if [ ! -f "$APACHE_STATUS_CONF" ]; then
    if port_in_use "$STATUS_PORT"; then
      warn "Porta $STATUS_PORT ocupada: Apache sem metricas de workers."
      return 0
    fi
    cat > "$APACHE_STATUS_CONF" <<EOF
# ZeroOps: estado do Apache so em 127.0.0.1 (gerido por zeroops-metrics/install.sh)
Listen 127.0.0.1:$STATUS_PORT
<VirtualHost 127.0.0.1:$STATUS_PORT>
  ServerName zeroops-status.localhost
  <Location /server-status>
    SetHandler server-status
    Require ip 127.0.0.1
  </Location>
</VirtualHost>
EOF
    a2enconf -q zeroops-status
    if ! apache2ctl configtest >/dev/null 2>&1; then
      a2disconf -q zeroops-status
      rm -f "$APACHE_STATUS_CONF"
      warn "apache2ctl configtest falhou: configuracao revertida, Apache sem metricas de workers."
      return 0
    fi
    systemctl reload apache2
    echo "Apache: server-status ativo em 127.0.0.1:$STATUS_PORT (reload graceful)."
  fi
  echo "APACHE_STATUS_URL=http://127.0.0.1:$STATUS_PORT/server-status?auto" >> "$CONF_DIR/collect.env"
}

enable_nginx_status() {
  systemctl is-active --quiet nginx 2>/dev/null || return 0
  if ! nginx -V 2>&1 | grep -q http_stub_status_module; then
    warn "nginx sem stub_status: sem metricas de ligacoes."
    return 0
  fi
  if [ ! -f "$NGINX_STATUS_CONF" ]; then
    grep -qs 'conf\.d/\*\.conf' /etc/nginx/nginx.conf || {
      warn "nginx.conf nao inclui conf.d: sem metricas de ligacoes."
      return 0
    }
    if port_in_use "$STATUS_PORT"; then
      warn "Porta $STATUS_PORT ocupada: nginx sem metricas de ligacoes."
      return 0
    fi
    cat > "$NGINX_STATUS_CONF" <<EOF
# ZeroOps: estado do nginx so em 127.0.0.1 (gerido por zeroops-metrics/install.sh)
server {
  listen 127.0.0.1:$STATUS_PORT;
  server_name zeroops-status.localhost;
  access_log off;
  location = /nginx_status {
    stub_status;
    allow 127.0.0.1;
    deny all;
  }
}
EOF
    if ! nginx -t >/dev/null 2>&1; then
      rm -f "$NGINX_STATUS_CONF"
      warn "nginx -t falhou: configuracao revertida, sem metricas de ligacoes."
      return 0
    fi
    systemctl reload nginx
    echo "nginx: stub_status ativo em 127.0.0.1:$STATUS_PORT (reload)."
  fi
  echo "NGINX_STATUS_URL=http://127.0.0.1:$STATUS_PORT/nginx_status" >> "$CONF_DIR/collect.env"
}

remove_web_status() {
  if [ -f "$APACHE_STATUS_CONF" ]; then
    a2disconf -q zeroops-status 2>/dev/null || true
    rm -f "$APACHE_STATUS_CONF"
    apache2ctl configtest >/dev/null 2>&1 && systemctl reload apache2 || true
  fi
  if [ -f "$NGINX_STATUS_CONF" ]; then
    rm -f "$NGINX_STATUS_CONF"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
  fi
}

if [ "$REMOVE" = yes ]; then
  systemctl disable --now zeroops-collect.timer 2>/dev/null || true
  rm -f /etc/systemd/system/zeroops-collect.service /etc/systemd/system/zeroops-collect.timer
  for unit in $UNITS; do
    systemctl disable --now "$unit.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/$unit.service"
  done
  rm -rf "$NODE_DROPIN"
  systemctl daemon-reload
  remove_web_status
  if [ "$ROLE" = db ]; then
    mysql -e "DROP USER IF EXISTS '${DB_USER}'@'localhost'" || true
    sed -i "/${HOSTS_MARK}\$/d" /etc/hosts
  fi
  rm -rf "$APP_DIR" "$DATA_DIR"
  echo "Metricas removidas. Configuracao mantida em ${CONF_DIR} (apagar manualmente se pretendido)."
  exit 0
fi

# --- Verificacoes previas: nada e alterado se alguma falhar ---
[ "$(uname -m)" = x86_64 ] || fail "Arquitetura nao suportada: $(uname -m)."
command -v python3 >/dev/null || fail "Falta python3 (coletor)."
available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
if [ "$ROLE" = db ]; then
  min_kb=1048576
  ports="9090 9100 9104 9121"
  for f in "$HEALTH_DIR/health-agent.env" "$HEALTH_DIR/token.env"; do
    [ -f "$f" ] || fail "Falta $f (instalar primeiro o agente de Saude)."
  done
else
  min_kb=262144
  ports=9100
  case "$AGENT_IP" in
    *.*.*.*) ;;
    *) fail "Indicar --agent-ip com o IP privado do servidor do agente (papel db)." ;;
  esac
  LISTEN_IP=$(ip -4 route get "$AGENT_IP" | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)
  [ -n "$LISTEN_IP" ] || fail "Sem rota para $AGENT_IP."
fi
[ "$available_kb" -ge "$min_kb" ] || fail "Memoria disponivel insuficiente; instalacao adiada."
for port in $ports; do
  if port_in_use "$port"; then
    ours=no
    for unit in $UNITS; do systemctl is-active --quiet "$unit.service" && ours=yes; done
    [ "$ours" = yes ] || fail "Porta $port ja em uso por outro servico."
  fi
done

if [ "$ROLE" = db ]; then
  REDIS_CONF=/etc/redis/redis.conf
  REDIS_PASSWORD=$(sed -n 's/^[[:space:]]*requirepass[[:space:]]\{1,\}//p' "$REDIS_CONF" | tail -n1 | sed 's/^"//; s/"$//')
  case "$REDIS_PASSWORD" in *\'* | *\\* | *'"'*) fail "Password do Redis com caracteres nao suportados." ;; esac
  URL=$(env_value ZEROOPS_URL "$HEALTH_DIR/health-agent.env")
  RESOLVE=$(env_value ZEROOPS_RESOLVE "$HEALTH_DIR/health-agent.env")
  CACERT=$(env_value ZEROOPS_CACERT "$HEALTH_DIR/health-agent.env")
  TOKEN=$(env_value ZEROOPS_TOKEN "$HEALTH_DIR/token.env")
  case "$URL" in https://*) ;; *) fail "ZEROOPS_URL tem de ser https." ;; esac
  case "$TOKEN" in zoh_*) ;; *) fail "Token do agente de Saude invalido." ;; esac
fi

# --- Binarios (download verificado por sha256) ---
id zeroops-metrics >/dev/null 2>&1 ||
  useradd --system --no-create-home --shell /usr/sbin/nologin zeroops-metrics
install -d -m 0755 "$APP_DIR" "$BIN_DIR" "$LIB_DIR"
install -d -m 0750 -o zeroops-metrics -g zeroops-metrics "$DATA_DIR"
install -d -m 0755 "$DATA_DIR/textfile"
install -d -m 0700 "$DATA_DIR/cache"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "$RELEASES" | while IFS='|' read -r name url sha binaries; do
  [ -n "$name" ] || continue
  [ "$ROLE" = db ] || [ "$name" = node_exporter ] || continue
  stamp="$BIN_DIR/.$name.sha256"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$sha" ]; then continue; fi
  archive="$WORK/$name.tar.gz"
  curl -fsSL --proto '=https' --max-time 300 -o "$archive" "$url"
  echo "$sha  $archive" | sha256sum -c --quiet - || fail "sha256 invalido para $name."
  tar -xzf "$archive" -C "$WORK"
  for binary in $binaries; do
    install -m 0755 "$WORK"/"$name"*/"$binary" "$BIN_DIR/$binary"
  done
  echo "$sha" > "$stamp"
  echo "Instalado $name."
done
install -m 0755 "$SRC_DIR/zeroops-collect.py" "$LIB_DIR/zeroops-collect.py"
install -m 0644 "$SRC_DIR/zeroops-db2.php" "$LIB_DIR/zeroops-db2.php"
install -m 0644 "$SRC_DIR/zeroops-dtq.php" "$LIB_DIR/zeroops-dtq.php"

# --- Configuracao (segredos 0640 root:zeroops-metrics) ---
install -d -m 0750 -o root -g zeroops-metrics "$CONF_DIR"
umask 027
echo "ROLE=$ROLE" > "$CONF_DIR/collect.env"
[ -n "$FPM_VERSIONS" ] && echo "FPM_VERSIONS=$FPM_VERSIONS" >> "$CONF_DIR/collect.env"
if [ "$ROLE" = db ]; then
  echo "MYSQL=1" >> "$CONF_DIR/collect.env"
  if grep -qs '^\[PROD\]' /etc/odbc.ini && php -m 2>/dev/null | grep -qx odbc; then
    echo "DB2_DSN=PROD" >> "$CONF_DIR/collect.env"
  fi
  # Log das filas DTQ do site; a conta de testes da sonda fica em dtq-probe.env (nao e reescrito).
  DTQ_LOG=/var/www/vhosts/pizzahut.pt/httpdocs/log/dtq/dtq.log
  [ -f "$DTQ_LOG" ] && echo "DTQ_LOG=$DTQ_LOG" >> "$CONF_DIR/collect.env"
  # O IBM i desliga de madrugada. As paragens vêm do projeto no ZeroOps (Saude > Paragens
  # planeadas, alvo «Sonda DTQ»); DTQ_PROBE_PAUSE so vale se o ZeroOps nunca tiver respondido.
  echo "ZEROOPS_URL=${URL%/}" >> "$CONF_DIR/collect.env"
  echo "DTQ_PROBE_PAUSE=00:30-07:30" >> "$CONF_DIR/collect.env"
fi
enable_apache_status
enable_nginx_status

if [ "$ROLE" = db ]; then
  printf '%s' "$TOKEN" > "$CONF_DIR/token"
  [ -n "$CACERT" ] && [ -f "$CACERT" ] && install -m 0644 "$CACERT" "$CONF_DIR/zeroops-ca.pem"
  [ -f "$CONF_DIR/zeroops-ca.pem" ] || fail "Falta a CA do ZeroOps (ZEROOPS_CACERT)."
  printf "REDIS_PASSWORD='%s'\n" "$REDIS_PASSWORD" > "$CONF_DIR/redis-exporter.env"
  [ -f "$CONF_DIR/remote-nodes.yml" ] || echo "[]" > "$CONF_DIR/remote-nodes.yml"

  if [ ! -f "$CONF_DIR/mysqld-exporter.cnf" ]; then
    PASSWORD=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
    SOCKET=$(mysql -Nse "SELECT @@socket")
    mysql <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${PASSWORD}' WITH MAX_USER_CONNECTIONS 3;
GRANT PROCESS, REPLICATION CLIENT ON *.* TO '${DB_USER}'@'localhost';
SQL
    {
      echo "[client]"
      echo "user=${DB_USER}"
      echo "password=${PASSWORD}"
      echo "socket=${SOCKET}"
    } > "$CONF_DIR/mysqld-exporter.cnf"
  fi

  sed -e "s|__HOST__|$(hostname)|" -e "s|__URL__|${URL%/}|" \
    "$SRC_DIR/prometheus-agent.yml" > "$CONF_DIR/prometheus-agent.yml"
  chown root:zeroops-metrics "$CONF_DIR"/*
  chmod 0640 "$CONF_DIR"/token "$CONF_DIR"/*.env "$CONF_DIR"/*.cnf "$CONF_DIR"/*.yml
  umask 022
  "$BIN_DIR/promtool" check config --agent "$CONF_DIR/prometheus-agent.yml" >/dev/null ||
    fail "Configuracao do agente Prometheus invalida."

  # O Prometheus nao tem equivalente ao `curl --resolve` do agente de Saude: usa o /etc/hosts.
  if [ -n "$RESOLVE" ]; then
    host=$(echo "$RESOLVE" | cut -d: -f1)
    address=$(echo "$RESOLVE" | cut -d: -f3)
    if ! getent hosts "$host" | grep -q "^${address}[[:space:]]"; then
      sed -i "/${HOSTS_MARK}\$/d" /etc/hosts
      echo "${address} ${host} ${HOSTS_MARK}" >> /etc/hosts
    fi
  fi
else
  chown root:zeroops-metrics "$CONF_DIR"/*
  chmod 0640 "$CONF_DIR"/*.env
  umask 022
  # node_exporter no IP privado, so acessivel ao servidor do agente (filtro IP do systemd).
  install -d -m 0755 "$NODE_DROPIN"
  cat > "$NODE_DROPIN/remote.conf" <<EOF
[Service]
ExecStart=
ExecStart=$BIN_DIR/node_exporter \\
  --web.listen-address=$LISTEN_IP:9100 \\
  --collector.textfile.directory=$DATA_DIR/textfile \\
  --collector.filesystem.mount-points-exclude=^/(dev|proc|run|sys|snap|var/lib/docker/.+)(\$\$|/)
IPAddressDeny=any
IPAddressAllow=localhost $LISTEN_IP $AGENT_IP
EOF
fi

# --- Servicos: exporters e coletor primeiro, agente no fim ---
for unit in $UNITS; do
  install -m 0644 "$SRC_DIR/$unit.service" "/etc/systemd/system/$unit.service"
done
install -m 0644 "$SRC_DIR/zeroops-collect.service" /etc/systemd/system/zeroops-collect.service
install -m 0644 "$SRC_DIR/zeroops-collect.timer" /etc/systemd/system/zeroops-collect.timer
systemctl daemon-reload
systemctl start zeroops-collect.service || warn "Primeira recolha falhou (ver journalctl -u zeroops-collect)."
systemctl enable --now zeroops-collect.timer >/dev/null 2>&1
for unit in zeroops-node-exporter zeroops-mysqld-exporter zeroops-redis-exporter zeroops-prometheus-agent; do
  case " $UNITS " in *" $unit "*) ;; *) continue ;; esac
  systemctl enable "$unit.service" >/dev/null 2>&1
  systemctl restart "$unit.service"
done

sleep 5
if [ "$ROLE" = db ]; then
  checks="127.0.0.1:9100|node_load5 127.0.0.1:9100|zeroops_collector_up 127.0.0.1:9104|mysql_up_1 127.0.0.1:9121|redis_up_1"
else
  checks="$LISTEN_IP:9100|node_load5 $LISTEN_IP:9100|zeroops_collector_up"
fi
for check in $checks; do
  target=${check%%|*}
  metric=${check#*|}
  case "$metric" in *_1) metric="${metric%_1} 1" ;; esac
  # grep sem -q: le tudo, para o curl nao falhar com "Failed writing body".
  if curl -fsS --max-time 10 "http://$target/metrics" | grep "^$metric" >/dev/null; then
    echo "OK $target ($metric)"
  else
    warn "$target sem $metric (ver journalctl -u zeroops-*)"
  fi
done
if [ "$ROLE" = db ]; then
  echo "Agente ativo. Confirmar o envio: curl -s 127.0.0.1:9090/metrics | grep prometheus_remote_storage_samples"
  echo "Outros servidores: acrescentar a $CONF_DIR/remote-nodes.yml (ver README)."
else
  echo "Acrescentar no servidor do agente ($AGENT_IP), em $CONF_DIR/remote-nodes.yml:"
  echo "- targets: ['$LISTEN_IP:9100']"
  echo "  labels: { instance: $(hostname), role: $ROLE }"
fi
