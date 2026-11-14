#!/usr/bin/env python3
"""Coletor textfile do ZeroOps para o node_exporter.

Le, so em localhost e so em leitura, o estado do Apache (server-status), dos pools
PHP-FPM (status por FastCGI), do nginx (stub_status), do MySQL e do DB2/IBM i, e escreve
metricas no formato Prometheus em TEXTFILE_DIR. Cada fonte e independente: se uma falhar,
publica `zeroops_collector_up{source=...} 0` e as restantes continuam.
DTQ: sonda do login (GET /api/v1/dtq/users/ local, conta de testes em dtq-probe.env, a cada
5 min) e contagem incremental de pedidos/respostas/erros no dtq.log do site.

Configuracao (opcional) em /etc/zeroops-metrics/collect.env:
  ROLE=db|backend|frontend|static   APACHE_STATUS_URL=...   NGINX_STATUS_URL=...
  MYSQL=1   DB2_DSN=PROD   FPM_VERSIONS=^8[.]5   (regex; so pools PHP dessas versoes)
  DTQ_LOG=/var/www/vhosts/pizzahut.pt/httpdocs/log/dtq/dtq.log
  ZEROOPS_URL=https://...   (papel db; le ao ZeroOps as paragens planeadas das sondas)
  DTQ_PROBE_PAUSE=00:30-07:30   (hora local; so usado se o ZeroOps nunca tiver respondido)
So entram os pools PHP-FPM cujo socket e usado pelos vhosts ativos do Apache/nginx.
Nunca imprime segredos: as credenciais do DB2 sao lidas pelo PHP a partir do DSN.
"""

from __future__ import annotations

import glob
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9: usa a hora local do servidor
    ZoneInfo = None  # type: ignore[assignment,misc]

CONF_FILE = Path(os.environ.get("ZEROOPS_COLLECT_CONF", "/etc/zeroops-metrics/collect.env"))
TEXTFILE_DIR = Path(os.environ.get("ZEROOPS_TEXTFILE_DIR", "/var/lib/zeroops-metrics/textfile"))
CACHE_DIR = Path(os.environ.get("ZEROOPS_CACHE_DIR", "/var/lib/zeroops-metrics/cache"))
LIB_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
HTTP_TIMEOUT = 5
SCHEMA_SIZES_EVERY = 900
DB2_EVERY = 60
DTQ_PROBE_EVERY = 300
DTQ_PROBE_FILE = CONF_FILE.parent / "dtq-probe.env"
DTQ_LOG_MAX_BYTES = 32 * 1024 * 1024
DTQ_MAX_NAMES = 30
DTQ_NAME = re.compile(r"[A-Z0-9_$]{1,40}")
AGENT_CONFIG_EVERY = 300
AGENT_TOKEN_FILE = CONF_FILE.parent / "token"
AGENT_CA_FILE = CONF_FILE.parent / "zeroops-ca.pem"


@dataclass
class Metrics:
    """Acumula series no formato de exposicao do Prometheus."""

    lines: list[str] = field(default_factory=list)
    declared: set[str] = field(default_factory=set)

    def add(self, name: str, value: float, labels: dict[str, str] | None = None,
            help_text: str = "", kind: str = "gauge") -> None:
        if name not in self.declared:
            self.declared.add(name)
            if help_text:
                self.lines.append(f"# HELP {name} {help_text}")
            self.lines.append(f"# TYPE {name} {kind}")
        label_text = ""
        if labels:
            parts = [f'{key}="{_escape(str(val))}"' for key, val in sorted(labels.items())]
            label_text = "{" + ",".join(parts) + "}"
        self.lines.append(f"{name}{label_text} {float(value):.6g}")

    def render(self) -> str:
        return "\n".join(self.lines) + "\n"


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def load_config() -> dict[str, str]:
    config: dict[str, str] = {}
    if CONF_FILE.is_file():
        for raw in CONF_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                config[key.strip()] = value.strip().strip("'\"")
    return config


def http_get(url: str) -> str:
    with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as response:  # noqa: S310 (so localhost)
        return response.read().decode("utf-8", "replace")


# --- Apache -----------------------------------------------------------------------------

SCOREBOARD_STATES = {
    "_": "waiting", "S": "starting", "R": "reading", "W": "sending", "K": "keepalive",
    "D": "dns", "C": "closing", "L": "logging", "G": "finishing", "I": "idle_cleanup",
    ".": "open_slot",
}


def collect_apache(metrics: Metrics, url: str) -> None:
    status: dict[str, str] = {}
    for line in http_get(url).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            status[key.strip()] = value.strip()
    if "BusyWorkers" not in status:
        raise RuntimeError("resposta sem BusyWorkers")
    busy = float(status["BusyWorkers"])
    idle = float(status.get("IdleWorkers", 0))
    scoreboard = status.get("Scoreboard", "")
    metrics.add("zeroops_apache_workers", busy, {"state": "busy"}, "Workers Apache por estado")
    metrics.add("zeroops_apache_workers", idle, {"state": "idle"})
    metrics.add("zeroops_apache_workers_capacity", len(scoreboard) or busy + idle,
                help_text="Slots totais de workers (ServerLimit x ThreadsPerChild)")
    counts = {state: 0 for state in SCOREBOARD_STATES.values()}
    for char in scoreboard:
        state = SCOREBOARD_STATES.get(char)
        if state:
            counts[state] += 1
    for state, count in counts.items():
        metrics.add("zeroops_apache_scoreboard", count, {"state": state}, "Scoreboard do Apache")
    if "Total Accesses" in status:
        metrics.add("zeroops_apache_accesses_total", float(status["Total Accesses"]),
                    help_text="Pedidos servidos desde o arranque", kind="counter")
    if "Total kBytes" in status:
        metrics.add("zeroops_apache_sent_kilobytes_total", float(status["Total kBytes"]),
                    kind="counter")
    if "ServerUptimeSeconds" in status:
        metrics.add("zeroops_apache_uptime_seconds", float(status["ServerUptimeSeconds"]))


# --- PHP-FPM (FastCGI minimo, so leitura do status) -------------------------------------

def fastcgi_get(sock_path: str, script: str, query: str) -> str:
    params = {
        "SCRIPT_NAME": script, "SCRIPT_FILENAME": script, "REQUEST_URI": f"{script}?{query}",
        "QUERY_STRING": query, "REQUEST_METHOD": "GET", "SERVER_SOFTWARE": "zeroops-collect",
        "REMOTE_ADDR": "127.0.0.1", "GATEWAY_INTERFACE": "CGI/1.1",
    }

    def record(kind: int, content: bytes) -> bytes:
        return struct.pack("!BBHHBx", 1, kind, 1, len(content), 0) + content

    def pair(key: str, value: str) -> bytes:
        k, v = key.encode(), value.encode()
        out = b""
        for item in (k, v):
            out += bytes([len(item)]) if len(item) < 128 else struct.pack("!I", len(item) | 0x80000000)
        return out + k + v

    body = b"".join(pair(key, value) for key, value in params.items())
    payload = (record(1, struct.pack("!HB5x", 1, 0)) + record(4, body) + record(4, b"")
               + record(5, b""))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(HTTP_TIMEOUT)
        client.connect(sock_path)
        client.sendall(payload)
        data = b""
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            data += chunk
    out = b""
    offset = 0
    while offset + 8 <= len(data):
        _, kind, _, length, padding = struct.unpack("!BBHHB", data[offset:offset + 7])
        content = data[offset + 8:offset + 8 + length]
        if kind == 6:
            out += content
        offset += 8 + length + padding
    text = out.decode("utf-8", "replace")
    headers, _, response = text.partition("\r\n\r\n")
    if re.search(r"^Status:\s*[45]", headers, re.M):
        raise RuntimeError(headers.splitlines()[0] if headers else "erro FastCGI")
    return response


@dataclass(frozen=True)
class FpmPool:
    version: str
    name: str
    socket: str
    status_path: str
    max_children: int
    master_pid: int = 0


# Workers livres ficam bloqueados em accept()/accept4() (x86_64) a espera de pedido.
ACCEPT_SYSCALLS = {"43", "288"}
WEB_CONF_GLOBS = ("/etc/apache2/sites-enabled/*", "/etc/apache2/conf-enabled/*",
                  "/etc/httpd/conf.d/*", "/etc/nginx/sites-enabled/*", "/etc/nginx/conf.d/*")


def web_server_sockets() -> set[str] | None:
    """Sockets PHP-FPM referidos (linhas nao comentadas) pelos vhosts ativos do Apache/nginx.

    None quando nao ha configuracao web (nao se sabe que pools estao em uso)."""
    sockets: set[str] = set()
    found = False
    for pattern in WEB_CONF_GLOBS:
        for path in glob.glob(pattern):
            try:
                lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            found = True
            for line in lines:
                if not line.lstrip().startswith("#"):
                    sockets.update(re.findall(r"(/[\w./-]+\.sock)", line))
    return sockets if found else None


def select_fpm_pools(pools: list[FpmPool], used: set[str] | None, versions: str) -> list[FpmPool]:
    """Pools usados pelo servidor web (todos, sem configuracao web) e da versao pedida."""
    if used is not None:
        pools = [pool for pool in pools if pool.socket in used]
    if versions:
        pools = [pool for pool in pools if re.search(versions, pool.version)]
    return pools


def discover_fpm_pools() -> list[FpmPool]:
    """Pools com socket unix dos masters PHP-FPM em execucao (inclui instalacoes em /opt)."""
    try:
        output = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True,
                                timeout=5, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    masters = {conf: int(pid) for pid, conf in
               re.findall(r"^\s*(\d+)\s+php-fpm: master process \((.+?)\)", output, re.M)}
    pools: list[FpmPool] = []
    for conf in sorted(masters):
        version = _fpm_version(conf)
        files = [conf]
        try:
            content = Path(conf).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for include in re.findall(r"^\s*include\s*=\s*(\S+)", content, re.M):
            files.extend(sorted(glob.glob(include)))
        for pool_file in files:
            pools.extend(FpmPool(**{**pool.__dict__, "master_pid": masters[conf]})
                         for pool in _parse_pools(pool_file, version))
    return pools


def proc_fpm_status(pool: FpmPool) -> dict[str, float]:
    """Estado sem `pm.status_path`: workers do pool por /proc e fila do socket por `ss`."""
    active = idle = 0
    for child in Path("/proc").glob("[0-9]*"):
        try:
            stat = (child / "stat").read_text()
            if int(stat.rsplit(")", 1)[1].split()[1]) != pool.master_pid:
                continue
            if (child / "cmdline").read_bytes().split(b"\0")[0].decode().strip() != \
                    f"php-fpm: pool {pool.name}":
                continue
            syscall = (child / "syscall").read_text().split(" ", 1)[0].strip()
        except (OSError, ValueError, IndexError):
            continue
        if syscall in ACCEPT_SYSCALLS:
            idle += 1
        else:
            active += 1
    if not active + idle:
        raise RuntimeError("sem workers do pool")
    queue = 0.0
    try:
        listing = subprocess.run(["ss", "-xlH"], capture_output=True, text=True, timeout=5,
                                 check=True).stdout
        for line in listing.splitlines():
            fields = line.split()
            if pool.socket in fields:
                queue = float(fields[2])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        pass
    return {"active processes": active, "idle processes": idle, "listen queue": queue}


def _fpm_version(conf: str) -> str:
    match = re.search(r"php/?(\d+\.\d+(?:\.\d+)?(?:-[a-z0-9]+)?)", conf)
    return match.group(1) if match else Path(conf).parent.name


def _parse_pools(path: str, version: str) -> list[FpmPool]:
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    pools: list[FpmPool] = []
    current: dict[str, str] = {}
    for raw in lines + ["[__end__]"]:
        line = raw.split(";", 1)[0].strip()
        section = re.match(r"^\[(.+)\]$", line)
        if section:
            if current.get("name", "global") != "global" and current.get("listen", "").startswith("/"):
                pools.append(FpmPool(version, current["name"], current["listen"],
                                     current.get("pm.status_path", ""),
                                     int(current.get("pm.max_children", "0") or 0)))
            current = {"name": section.group(1)}
        elif "=" in line:
            key, value = line.split("=", 1)
            current[key.strip()] = value.strip()
    return pools


def collect_fpm(metrics: Metrics, versions: str = "") -> None:
    """Pools usados pelos vhosts ativos; `FPM_VERSIONS` (regex) limita as versoes de PHP."""
    for pool in select_fpm_pools(discover_fpm_pools(), web_server_sockets(), versions):
        labels = {"version": pool.version, "pool": pool.name}
        metrics.add("zeroops_phpfpm_max_children", pool.max_children, labels, "pm.max_children configurado")
        try:
            if pool.status_path:
                data = json.loads(fastcgi_get(pool.socket, pool.status_path, "json"))
            else:
                data = proc_fpm_status(pool)
        except (OSError, ValueError, RuntimeError):
            metrics.add("zeroops_phpfpm_up", 0, labels, "Status do pool PHP-FPM acessivel")
            continue
        metrics.add("zeroops_phpfpm_up", 1, labels, "Status do pool PHP-FPM acessivel")
        metrics.add("zeroops_phpfpm_processes", data.get("active processes", 0),
                    {**labels, "state": "active"}, "Processos PHP-FPM por estado")
        metrics.add("zeroops_phpfpm_processes", data.get("idle processes", 0), {**labels, "state": "idle"})
        metrics.add("zeroops_phpfpm_listen_queue", data.get("listen queue", 0), labels,
                    "Pedidos em fila a espera de processo")
        if "max children reached" not in data:
            continue
        metrics.add("zeroops_phpfpm_max_children_reached_total", data.get("max children reached", 0),
                    labels, "Vezes que se atingiu pm.max_children", "counter")
        metrics.add("zeroops_phpfpm_slow_requests_total", data.get("slow requests", 0), labels,
                    kind="counter")
        metrics.add("zeroops_phpfpm_accepted_connections_total", data.get("accepted conn", 0), labels,
                    kind="counter")

# --- nginx ------------------------------------------------------------------------------

def collect_nginx(metrics: Metrics, url: str) -> None:
    text = http_get(url)
    active = re.search(r"Active connections:\s*(\d+)", text)
    totals = re.search(r"\n\s*(\d+)\s+(\d+)\s+(\d+)", text)
    states = re.search(r"Reading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)", text)
    if not active or not totals or not states:
        raise RuntimeError("stub_status inesperado")
    metrics.add("zeroops_nginx_connections_active", int(active.group(1)),
                help_text="Ligacoes ativas no nginx")
    for state, value in zip(("reading", "writing", "waiting"), states.groups()):
        metrics.add("zeroops_nginx_connections", int(value), {"state": state},
                    "Ligacoes nginx por estado")
    metrics.add("zeroops_nginx_requests_total", int(totals.group(3)), kind="counter")


# --- MySQL ------------------------------------------------------------------------------

def mysql_query(sql: str, timeout: int = 20) -> tuple[str, float]:
    started = time.monotonic()
    result = subprocess.run(["mysql", "--connect-timeout=5", "-NBe", sql], capture_output=True,
                            text=True, timeout=timeout, check=True)
    return result.stdout, time.monotonic() - started


def collect_mysql(metrics: Metrics) -> None:
    _, elapsed = mysql_query("SELECT 1", timeout=10)
    metrics.add("zeroops_mysql_ping_seconds", elapsed, help_text="Tempo de resposta de SELECT 1")
    sizes = cached(CACHE_DIR / "mysql-schemas.json", SCHEMA_SIZES_EVERY, _mysql_schema_sizes)
    for schema, (data_bytes, index_bytes, tables) in sizes.items():
        labels = {"schema": schema}
        metrics.add("zeroops_mysql_schema_data_bytes", data_bytes, labels, "Tamanho dos dados por schema")
        metrics.add("zeroops_mysql_schema_index_bytes", index_bytes, labels, "Tamanho dos indices por schema")
        metrics.add("zeroops_mysql_schema_tables", tables, labels)


def _mysql_schema_sizes() -> dict[str, list[float]]:
    output, _ = mysql_query(
        "SET SESSION max_statement_time=60; SELECT table_schema, COALESCE(SUM(data_length),0), "
        "COALESCE(SUM(index_length),0), COUNT(*) FROM information_schema.tables "
        "WHERE table_schema NOT IN ('information_schema','performance_schema','mysql','sys') "
        "GROUP BY table_schema", timeout=90)
    sizes = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) == 4:
            sizes[parts[0]] = [float(parts[1]), float(parts[2]), float(parts[3])]
    return sizes


# --- DB2 / IBM i ------------------------------------------------------------------------

def collect_db2(metrics: Metrics, dsn: str) -> None:
    data = cached(CACHE_DIR / "db2.json", DB2_EVERY, lambda: _db2_status(dsn))
    labels = {"dsn": dsn}
    metrics.add("zeroops_db2_up", 1 if data.get("up") else 0, labels, "Ligacao ao DB2/IBM i")
    if not data.get("up"):
        return
    for key, name, help_text in (
        ("connect_seconds", "zeroops_db2_connect_seconds", "Tempo de ligacao ODBC"),
        ("query_seconds", "zeroops_db2_query_seconds", "Tempo de SELECT 1 FROM SYSIBM.SYSDUMMY1"),
        ("cpu_used_percent", "zeroops_db2_cpu_used_percent", "CPU usada no IBM i (%)"),
        ("cpu_capacity", "zeroops_db2_cpu_capacity", "Capacidade de CPU atual"),
        ("configured_cpus", "zeroops_db2_configured_cpus", "CPUs configuradas"),
        ("asp_used_percent", "zeroops_db2_asp_used_percent", "Armazenamento ASP de sistema usado (%)"),
        ("active_jobs", "zeroops_db2_active_jobs", "Jobs ativos"),
        ("total_jobs", "zeroops_db2_total_jobs", "Jobs no sistema"),
        ("maximum_jobs", "zeroops_db2_maximum_jobs", "Maximo de jobs permitido"),
        ("active_threads", "zeroops_db2_active_threads", "Threads ativas"),
        ("temporary_storage_mb", "zeroops_db2_temporary_storage_megabytes", "Armazenamento temporario"),
    ):
        if data.get(key) is not None:
            metrics.add(name, float(data[key]), labels, help_text)


def _db2_status(dsn: str) -> dict:
    """Corre o script PHP; usa a ultima linha JSON valida.

    O script imprime uma linha logo apos o ping e outra no fim com as estatisticas. Se as
    estatisticas excederem o timeout, a primeira linha mantem `up` correto (sem falso alerta).
    """
    try:
        result = subprocess.run(["php", str(LIB_DIR / "zeroops-db2.php"), dsn], capture_output=True,
                                text=True, timeout=40, check=False)
        output = result.stdout
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout
    except (OSError, subprocess.SubprocessError):
        return {"up": False}
    return _last_json_line(output)


def _last_json_line(output: str | bytes | None) -> dict:
    if isinstance(output, bytes):
        output = output.decode("utf-8", "replace")
    for line in reversed((output or "").splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return {"up": False}


# --- DTQ (filas de dados do IBM i usadas pelo site) -------------------------------------

def in_window(window: str, now: time.struct_time | None = None) -> bool:
    """True se a hora local estiver em `HH:MM-HH:MM` (aceita janelas que passam a meia-noite)."""
    match = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*", window or "")
    if not match:
        return False
    h1, m1, h2, m2 = (int(group) for group in match.groups())
    start, end = h1 * 60 + m1, h2 * 60 + m2
    now = now or time.localtime()
    minute = now.tm_hour * 60 + now.tm_min
    return start <= minute < end if start <= end else minute >= start or minute < end


def _minutes(value: str) -> int | None:
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(value or ""))
    return int(match.group(1)) * 60 + int(match.group(2)) if match else None


def in_quiet_window(window: dict, now: datetime | None = None) -> bool:
    """Mesma regra do ZeroOps: dias 0=Dom..6=Sab; depois da meia-noite conta o dia de inicio."""
    start, end = _minutes(window.get("start", "")), _minutes(window.get("end", ""))
    if start is None or end is None or start == end:
        return False
    if now is None:
        zone = None
        if ZoneInfo is not None:
            try:
                zone = ZoneInfo(window.get("timezone") or "Europe/Lisbon")
            except Exception:  # noqa: BLE001 (fuso desconhecido: hora local)
                zone = None
        now = datetime.now(zone) if zone else datetime.now()
    minute = now.hour * 60 + now.minute
    weekday = (now.weekday() + 1) % 7
    days = window.get("days") or list(range(7))
    if start < end:
        return start <= minute < end and weekday in days
    if minute >= start:
        return weekday in days
    return minute < end and (weekday + 6) % 7 in days


def probe_windows(config: dict[str, str], probe: str) -> list[dict] | None:
    """Paragens da sonda definidas no projeto do ZeroOps (None se nunca foi possivel obter).

    Guarda a ultima resposta em cache; se o ZeroOps falhar, usa-a e so volta a tentar depois
    de AGENT_CONFIG_EVERY segundos.
    """
    url = config.get("ZEROOPS_URL", "").rstrip("/")
    if not url:
        return None
    path = CACHE_DIR / "agent-config.json"
    try:
        data = cached(path, AGENT_CONFIG_EVERY, lambda: _agent_config(url))
    except Exception as error:  # noqa: BLE001 (sem ZeroOps: ultima copia conhecida)
        print(f"zeroops-collect: agent-config: {type(error).__name__}: {error}"[:300],
              file=sys.stderr)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            os.utime(path)
        except (OSError, ValueError):
            return None
    windows = (data.get("probes") or {}).get(probe, {}).get("windows")
    return windows if isinstance(windows, list) else None


def _agent_config(url: str) -> dict:
    token = AGENT_TOKEN_FILE.read_text(encoding="utf-8").strip()
    context = ssl.create_default_context(
        cafile=str(AGENT_CA_FILE) if AGENT_CA_FILE.is_file() else None)
    request = urllib.request.Request(
        f"{url}/api/monitoring/agent-config", data=b"{}", method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10, context=context) as response:
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict) or "probes" not in data:
        raise ValueError("resposta inesperada")
    return data


def collect_dtq_probe(metrics: Metrics, config: dict[str, str]) -> None:
    """Sonda ativa: o login do site (GET /api/v1/dtq/users/) com a conta de testes.

    Nas paragens planeadas do projeto (alvo `probe:dtq`) nao chama o site: sem series de estado
    nao ha alertas, e o site nao envia o seu e-mail de falha do DTQ a cada sonda. Sem resposta
    do ZeroOps, vale DTQ_PROBE_PAUSE.
    """
    windows = probe_windows(config, "dtq")
    if windows is None:
        paused = in_window(config.get("DTQ_PROBE_PAUSE", ""))
    else:
        paused = any(in_quiet_window(window) for window in windows if isinstance(window, dict))
    metrics.add("zeroops_dtq_probe_paused", 1 if paused else 0, None,
                "Sonda do DTQ em pausa (paragem programada do IBM i)")
    if paused:
        return
    data = cached(CACHE_DIR / "dtq-probe.json", DTQ_PROBE_EVERY, _dtq_probe)
    if not data.get("configured"):
        return
    metrics.add("zeroops_dtq_users_up", 1 if data.get("up") else 0, None,
                "Sonda do DTQ de clientes (login) com a conta de testes")
    if data.get("seconds") is not None:
        metrics.add("zeroops_dtq_users_seconds", float(data["seconds"]), None,
                    "Duracao da sonda do DTQ de clientes")


def _dtq_probe() -> dict:
    try:
        result = subprocess.run(["php", str(LIB_DIR / "zeroops-dtq.php"), str(DTQ_PROBE_FILE)],
                                capture_output=True, text=True, timeout=40, check=False)
        return json.loads(result.stdout or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"configured": True, "up": False}


def collect_dtq_log(metrics: Metrics, path: str) -> None:
    """Leitura incremental do dtq.log do site: pedidos (R), respostas (O) e erros (L [ERROR]).

    Guarda inode e offset; na primeira execucao comeca no fim do ficheiro. Se o ficheiro
    encolher (logrotate com copytruncate) ou mudar de inode, recomeca do inicio.
    """
    state_path = CACHE_DIR / "dtq-log.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    info = os.stat(path)
    requests: dict[str, int] = state.get("requests", {})
    responses: dict[str, int] = state.get("responses", {})
    errors = int(state.get("errors", 0))
    offset = int(state.get("offset", info.st_size))
    if state.get("inode") != info.st_ino or info.st_size < offset:
        offset = 0 if state else info.st_size

    with open(path, "rb") as handle:
        handle.seek(offset)
        chunk = handle.read(min(info.st_size - offset, DTQ_LOG_MAX_BYTES))
    end = chunk.rfind(b"\n") + 1
    if end == 0 and len(chunk) == DTQ_LOG_MAX_BYTES:
        end = len(chunk)
    for line in chunk[:end].splitlines():
        kind = line[:3]
        if kind == b"R [":
            _count_dtq(requests, line.rsplit(b"\t", 1)[-1])
        elif kind == b"O [":
            fields = line.split(b"\t", 3)
            if len(fields) >= 3:
                _count_dtq(responses, fields[2])
        elif kind == b"L [" and b"\t[ERROR]\t" in line:
            errors += 1
    offset += end

    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"inode": info.st_ino, "offset": offset, "requests": requests,
                               "responses": responses, "errors": errors}), encoding="utf-8")
    tmp.replace(state_path)

    for name, value in sorted(requests.items()):
        metrics.add("zeroops_dtq_requests_total", value, {"dtq": name},
                    "Leituras/escritas DTQ pedidas pelo site (dtq.log)", "counter")
    for name, value in sorted(responses.items()):
        metrics.add("zeroops_dtq_responses_total", value, {"dtq": name},
                    "Respostas DTQ com dados (dtq.log)", "counter")
    metrics.add("zeroops_dtq_log_errors_total", errors, None,
                "Linhas [ERROR] no dtq.log", "counter")
    metrics.add("zeroops_dtq_log_lag_bytes", info.st_size - offset, None,
                "Bytes do dtq.log ainda por ler")


def _count_dtq(counters: dict[str, int], raw: bytes) -> None:
    name = raw.strip().decode("ascii", "replace")
    if not DTQ_NAME.fullmatch(name):
        return
    if name in counters or len(counters) < DTQ_MAX_NAMES:
        counters[name] = counters.get(name, 0) + 1


# --- Utilitarios ------------------------------------------------------------------------

def cached(path: Path, max_age: int, producer):
    try:
        if time.time() - path.stat().st_mtime < max_age:
            return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    value = producer()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    tmp.replace(path)
    return value


def run_source(metrics: Metrics, source: str, action) -> None:
    started = time.monotonic()
    try:
        action()
        ok = 1
    except Exception as error:  # noqa: BLE001 (cada fonte isolada)
        ok = 0
        print(f"zeroops-collect: {source}: {type(error).__name__}: {error}"[:300], file=sys.stderr)
    metrics.add("zeroops_collector_up", ok, {"source": source}, "Fonte do coletor lida com sucesso")
    metrics.add("zeroops_collector_duration_seconds", time.monotonic() - started, {"source": source})


def main() -> int:
    config = load_config()
    TEXTFILE_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    metrics = Metrics()
    role = config.get("ROLE", "")
    if role:
        metrics.add("zeroops_server_role", 1, {"role": role}, "Papel do servidor")
    if config.get("APACHE_STATUS_URL"):
        run_source(metrics, "apache", lambda: collect_apache(metrics, config["APACHE_STATUS_URL"]))
    if config.get("NGINX_STATUS_URL"):
        run_source(metrics, "nginx", lambda: collect_nginx(metrics, config["NGINX_STATUS_URL"]))
    if config.get("FPM", "1") == "1":
        run_source(metrics, "phpfpm", lambda: collect_fpm(metrics, config.get("FPM_VERSIONS", "")))
    if config.get("MYSQL") == "1":
        run_source(metrics, "mysql", lambda: collect_mysql(metrics))
    if config.get("DB2_DSN"):
        run_source(metrics, "db2", lambda: collect_db2(metrics, config["DB2_DSN"]))
    if DTQ_PROBE_FILE.is_file():
        run_source(metrics, "dtq_probe", lambda: collect_dtq_probe(metrics, config))
    if config.get("DTQ_LOG"):
        run_source(metrics, "dtq_log", lambda: collect_dtq_log(metrics, config["DTQ_LOG"]))
    target = TEXTFILE_DIR / "zeroops.prom"
    tmp = TEXTFILE_DIR / ".zeroops.prom.tmp"
    tmp.write_text(metrics.render(), encoding="utf-8")
    os.chmod(tmp, 0o644)
    tmp.replace(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
