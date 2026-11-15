#!/usr/bin/env python3
"""Operador independente de rollout do ZeroOps (P10), so para Qualidade.

Servico systemd fora dos contentores do ZeroOps: sobrevive a substituicao da API/executor que pediu
o rollout e confirma o resultado por verificacao externa (versao ativa e health), nunca pela palavra
do processo substituido.

Implementa o contrato `webhook` das pipelines do ZeroOps (P09):
  POST /deliveries               pede o rollout de um commit (202; 409 se a chave ja existir)
  GET  /deliveries/<chave>       estado atual (mesmo formato das callbacks)
  POST /deliveries/<chave>/cancel cancela se ainda nao comecou a troca
Pedidos e callbacks assinados com HMAC-SHA256 sobre `timestamp.corpo` (cabecalhos x-zeroops-*).

Passos de cada rollout (em serie, com lock por alvo e estado JSON duravel):
  1. verificacao: obtem a ref do repositorio de origem, confirma o SHA, a ascendencia (so avanco
     rapido sobre o `main` publicado) e o digest `git archive` do artefacto revisto;
  2. troca: executa o `deploy-from-git.sh` do proprio commit (drenagem, backup, migracoes, arranque,
     health e reposicao automatica em falha);
  3. confirmacao independente: versao da API igual ao SHA e executor saudavel durante a janela de
     observacao; so entao atualiza `main` do repositorio de deploy (sem hook: nao ha deploy duplicado).
Falha antes da publicacao, falha durante a troca (versao anterior reposta) e resultado incerto sao
distinguidos; o incerto fica em reconciliacao (nunca e declarado concluido sem confirmacao).
No arranque retoma os rollouts pendentes: verificacoes repetem-se; trocas interrompidas sao
reconciliadas pelo estado externo, sem repetir o deploy.

Configuracao por ambiente (ficheiro /etc/zeroops/rollout-operator.env); ver install-rollout-operator.sh.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple

try:  # so existe em Linux (alvo real); os testes em Windows usam um Host falso sem locks de ficheiro
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

SIGNATURE_HEADER = "x-zeroops-signature"
TIMESTAMP_HEADER = "x-zeroops-timestamp"
SIGNATURE_TOLERANCE_SECONDS = 300
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
TERMINAL = ("succeeded", "failed", "cancelled")
EXTERNAL_STATUS = {
    "accepted": "accepted",
    "verifying": "running",
    "deploying": "running",
    "confirming": "running",
    "reconciling": "running",
    "succeeded": "succeeded",
    "failed": "failed",
    "cancelled": "cancelled",
}
CHECKS = ("artefacto", "deploy", "versao-ativa")


def sign(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), digestmod=hashlib.sha256)
    mac.update(timestamp.encode() + b".")
    mac.update(body)
    return "sha256=" + mac.hexdigest()


def verify_signature(secret: str, timestamp: Optional[str], signature: Optional[str], body: bytes,
                     now: Optional[float] = None) -> bool:
    if not timestamp or not signature or not re.match(r"^\d{9,12}$", timestamp):
        return False
    if abs((now if now is not None else time.time()) - int(timestamp)) > SIGNATURE_TOLERANCE_SECONDS:
        return False
    return hmac.compare_digest(sign(secret, timestamp, body), signature.strip())


class Config:
    def __init__(self, env: Dict[str, str]):
        self.secret = env.get("ZEROOPS_ROLLOUT_SECRET", "")
        if len(self.secret) < 32:
            raise ValueError("ZEROOPS_ROLLOUT_SECRET em falta (minimo 32 caracteres)")
        self.bind = env.get("ZEROOPS_ROLLOUT_BIND", "127.0.0.1")
        self.port = int(env.get("ZEROOPS_ROLLOUT_PORT", "4320"))
        self.state_dir = env.get("ZEROOPS_ROLLOUT_STATE_DIR", "/var/lib/zeroops-rollout")
        self.lock_dir = env.get("ZEROOPS_ROLLOUT_LOCK_DIR", "/run/lock")
        self.source_repo = env.get("ZEROOPS_ROLLOUT_SOURCE_REPO", "/opt/zeroops/test-repos/zeroops-capabilities.git")
        self.target_repo = env.get("ZEROOPS_ROLLOUT_TARGET_REPO", "/opt/zeroops/repo.git")
        self.target_branch = env.get("ZEROOPS_ROLLOUT_TARGET_BRANCH", "main")
        self.allowed_refs = [r for r in env.get("ZEROOPS_ROLLOUT_ALLOWED_REFS", "main").split(",") if r]
        self.allowed_environments = [
            e for e in env.get("ZEROOPS_ROLLOUT_ALLOWED_ENVIRONMENTS", "quality").split(",") if e
        ]
        self.api_health_url = env.get("ZEROOPS_ROLLOUT_API_HEALTH_URL", "http://127.0.0.1:4311/api/health")
        self.executor_health_url = env.get(
            "ZEROOPS_ROLLOUT_EXECUTOR_HEALTH_URL", "http://127.0.0.1:4312/v1/health")
        # O callbackUrl publico passa pelo proxy; no host chega-se diretamente a API.
        self.callback_origin = env.get("ZEROOPS_ROLLOUT_CALLBACK_ORIGIN", "http://127.0.0.1:4311")
        self.deploy_timeout = int(env.get("ZEROOPS_ROLLOUT_DEPLOY_TIMEOUT_SECONDS", "3600"))
        self.confirm_timeout = int(env.get("ZEROOPS_ROLLOUT_CONFIRM_TIMEOUT_SECONDS", "180"))
        self.observe_seconds = int(env.get("ZEROOPS_ROLLOUT_OBSERVE_SECONDS", "30"))
        self.poll_seconds = float(env.get("ZEROOPS_ROLLOUT_POLL_SECONDS", "5"))
        self.reconcile_limit = int(env.get("ZEROOPS_ROLLOUT_RECONCILE_LIMIT_SECONDS", "1800"))


class Host:
    """Operacoes externas (git, deploy, health, callbacks); substituivel nos testes."""

    def __init__(self, config: Config):
        self.config = config

    def git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)

    def archive_digest(self, git_dir: str, sha: str) -> str:
        proc = subprocess.Popen(["git", "--git-dir", git_dir, "archive", "--format=tar", sha],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        digest = hashlib.sha256()
        assert proc.stdout is not None
        for chunk in iter(lambda: proc.stdout.read(1 << 16), b""):
            digest.update(chunk)
        _, err = proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError("git archive falhou: " + err.decode(errors="replace")[:300])
        return "sha256:" + digest.hexdigest()

    def deploy(self, sha: str, key: str, log_path: str) -> int:
        script = self.git("--git-dir", self.config.target_repo, "show",
                          sha + ":deploy/qa/deploy-from-git.sh").stdout
        with tempfile.NamedTemporaryFile("wb", suffix=".sh", delete=False) as handle:
            handle.write(script)
            script_path = handle.name
        os.chmod(script_path, 0o700)
        env = dict(os.environ, ZEROOPS_REPO=self.config.target_repo, ZEROOPS_DEPLOY_CORRELATION="rollout:" + key)
        try:
            with open(log_path, "ab") as log:
                return subprocess.run(["bash", script_path, sha], stdout=log, stderr=subprocess.STDOUT,
                                      env=env, timeout=self.config.deploy_timeout).returncode
        finally:
            os.unlink(script_path)

    def runtime(self) -> Tuple[Optional[str], bool]:
        """(versao da API ou None se indisponivel, executor saudavel)."""
        version = None
        try:
            with urllib.request.urlopen(self.config.api_health_url, timeout=5) as response:
                version = json.loads(response.read().decode()).get("version")
        except (OSError, ValueError):
            version = None
        try:
            with urllib.request.urlopen(self.config.executor_health_url, timeout=5) as response:
                executor = 200 <= response.status < 300
        except OSError:
            executor = False
        return version, executor

    def deploy_running(self) -> bool:
        """Outro deploy (push direto ou rollout anterior) ainda segura o lock do script."""
        path = os.path.join(self.config.lock_dir, "zeroops-deploy.lock")
        if fcntl is None:
            return False
        try:
            handle = open(path, "a")
        except OSError:
            return False
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle, fcntl.LOCK_UN)
            return False
        except OSError:
            return True
        finally:
            handle.close()

    def post_callback(self, url: str, body: bytes) -> Optional[int]:
        timestamp = str(int(time.time()))
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "content-type": "application/json",
            TIMESTAMP_HEADER: timestamp,
            SIGNATURE_HEADER: sign(self.config.secret, timestamp, body),
        })
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except OSError:
            return None

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


class Operator:
    def __init__(self, config: Config, host: Host, log: Callable[[Dict[str, Any]], None] = None):
        self.config = config
        self.host = host
        self.lock = threading.RLock()
        self.queue: "queue.Queue[str]" = queue.Queue()
        self.dir = os.path.join(config.state_dir, "deliveries")
        os.makedirs(self.dir, exist_ok=True)
        self.log = log or (lambda event: print(json.dumps(event, ensure_ascii=False), flush=True))

    # --- estado duravel ---
    def _path(self, key: str) -> str:
        return os.path.join(self.dir, key + ".json")

    def load(self, key: str) -> Optional[Dict[str, Any]]:
        try:
            with open(self._path(key), encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return None

    def save(self, record: Dict[str, Any]) -> None:
        record["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=1)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self._path(record["key"]))

    def all(self) -> List[Dict[str, Any]]:
        records = []
        for name in sorted(os.listdir(self.dir)):
            if name.endswith(".json"):
                record = self.load(name[:-5])
                if record:
                    records.append(record)
        return records

    # --- contrato ---
    def event(self, record: Dict[str, Any]) -> Dict[str, Any]:
        status = EXTERNAL_STATUS[record["state"]]
        payload = {
            "eventId": "%s:%d:%s" % (record["externalId"], record["sequence"], status),
            "idempotencyKey": record["key"],
            "externalId": record["externalId"],
            "sequence": record["sequence"],
            "status": status,
            "sha": record["sha"],
            "artifactDigest": record["artifactDigest"],
            "checks": [{"name": name, "status": record["checks"][name]} for name in CHECKS],
        }
        if record.get("message"):
            payload["message"] = record["message"][:1000]
        return payload

    def transition(self, record: Dict[str, Any], state: str, message: Optional[str] = None,
                   checks: Optional[Dict[str, str]] = None, **extra: Any) -> bool:
        """Grava a transicao; devolve False se entretanto ficou terminal (ex.: cancelada noutro pedido)."""
        with self.lock:
            stored = self.load(record["key"])
            if stored and stored["state"] in TERMINAL:
                record.clear()
                record.update(stored)
            if record["state"] in TERMINAL:
                return False
            record["state"] = state
            record["sequence"] += 1
            if message is not None:
                record["message"] = message
            if checks:
                record["checks"].update(checks)
            record.update(extra)
            record.setdefault("history", []).append(
                {"at": time.time(), "state": state, "message": message})
            self.save(record)
        self.log({"event": "rollout." + state, "key": record["key"], "sha": record["sha"], "message": message})
        self.callback(record)
        return True

    def callback(self, record: Dict[str, Any]) -> None:
        url = record.get("callbackUrl")
        if not url:
            return
        if self.config.callback_origin:
            url = self.config.callback_origin.rstrip("/") + urllib.parse.urlsplit(url).path
        body = json.dumps(self.event(record)).encode()
        # Melhor esforco: o ZeroOps tambem reconcilia por GET /deliveries/<chave>.
        for attempt in range(3):
            status = self.host.post_callback(url, body)
            if status is not None and status < 500:
                return
            self.host.sleep(2 * (attempt + 1))

    def submit(self, payload: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        key = str(payload.get("idempotencyKey", ""))
        sha = str(payload.get("sha", ""))
        digest = str(payload.get("artifactDigest", ""))
        ref = str(payload.get("ref", ""))
        environment = str(payload.get("environment", ""))
        if not UUID_RE.match(key) or not SHA_RE.match(sha) or not DIGEST_RE.match(digest) or not REF_RE.match(ref):
            return 400, {"error": "pedido invalido"}
        if ref not in self.config.allowed_refs:
            return 403, {"error": "ref nao autorizada para rollout"}
        if environment not in self.config.allowed_environments:
            return 403, {"error": "ambiente nao autorizado para rollout"}
        with self.lock:
            existing = self.load(key)
            if existing:
                if existing["sha"] != sha or existing["artifactDigest"] != digest:
                    return 409, {"error": "chave ja usada com outro artefacto", "externalId": existing["externalId"]}
                return 409, {"externalId": existing["externalId"]}
            record = {
                "key": key,
                "externalId": "rollout-" + key,
                "deliveryId": payload.get("deliveryId"),
                "ticket": payload.get("ticket"),
                "ref": ref,
                "sha": sha,
                "artifactDigest": digest,
                "environment": environment,
                "callbackUrl": payload.get("callbackUrl"),
                "state": "accepted",
                "sequence": 0,
                "checks": {name: "pending" for name in CHECKS},
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            self.save(record)
        self.log({"event": "rollout.accepted", "key": key, "sha": sha, "ticket": record["ticket"]})
        self.queue.put(key)
        return 202, {"externalId": record["externalId"]}

    def cancel(self, key: str) -> Tuple[int, Dict[str, Any]]:
        with self.lock:
            record = self.load(key)
            if not record:
                return 404, {"error": "entrega desconhecida"}
            if record["state"] in ("accepted", "verifying"):
                self.transition(record, "cancelled", "Cancelado antes da troca de versao.",
                                {name: "skipped" for name in CHECKS if record["checks"][name] != "passed"})
                return 202, {"externalId": record["externalId"]}
            if record["state"] in TERMINAL:
                return 202, {"externalId": record["externalId"]}
        return 409, {"error": "troca em curso: o cancelamento nao e suportado nesta fase",
                     "externalId": record["externalId"]}

    # --- execucao ---
    def run(self, key: str) -> None:
        record = self.load(key)
        if not record or record["state"] in TERMINAL:
            return
        target = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(self.config.target_repo))
        lock_path = os.path.join(self.config.lock_dir, "zeroops-rollout-%s.lock" % target)
        with open(lock_path, "a") as lock:
            if fcntl is not None:
                fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                record = self.load(key)
                if not record or record["state"] in TERMINAL:
                    return
                if record["state"] in ("accepted", "verifying"):
                    if not self.verify(record):
                        return
                    self.swap(record)
                elif record["state"] == "deploying":
                    # Operador reiniciado a meio da troca: nao repete o deploy, reconcilia pelo estado externo.
                    self.reconcile(record, interrupted=True)
                elif record["state"] in ("confirming", "reconciling"):
                    self.reconcile(record, interrupted=False)
            finally:
                if fcntl is not None:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def verify(self, record: Dict[str, Any]) -> bool:
        cfg = self.config
        sha = record["sha"]
        if not self.transition(record, "verifying", "A verificar commit, ascendencia e artefacto.",
                               {"artefacto": "running"}):
            return False
        try:
            tracking = "refs/zeroops-rollout/" + record["key"]
            self.host.git("--git-dir", cfg.target_repo, "fetch", "--no-tags", "--quiet", cfg.source_repo,
                          "+refs/heads/%s:%s" % (record["ref"], tracking))
            if self.host.git("--git-dir", cfg.target_repo, "cat-file", "-e", sha + "^{commit}",
                             check=False).returncode != 0:
                return self.fail(record, "before_publication", "O commit %s nao existe na ref %s do repositorio de origem."
                                 % (sha, record["ref"]), {"artefacto": "failed"})
            if self.host.git("--git-dir", cfg.target_repo, "merge-base", "--is-ancestor", sha, tracking,
                             check=False).returncode != 0:
                return self.fail(record, "before_publication", "O commit nao foi integrado na ref %s." % record["ref"],
                                 {"artefacto": "failed"})
            current = self.host.git("--git-dir", cfg.target_repo, "rev-parse", "--verify", "--quiet",
                                    "refs/heads/" + cfg.target_branch, check=False).stdout.decode().strip()
            if current and self.host.git("--git-dir", cfg.target_repo, "merge-base", "--is-ancestor", current, sha,
                                         check=False).returncode != 0:
                return self.fail(record, "before_publication",
                                 "O commit nao descende da versao publicada (%s): sem avanco rapido, sem publicacao." % current[:12],
                                 {"artefacto": "failed"})
            digest = self.host.archive_digest(cfg.target_repo, sha)
            if digest != record["artifactDigest"]:
                return self.fail(record, "before_publication",
                                 "Digest do artefacto diferente do revisto (%s != %s)." % (digest, record["artifactDigest"]),
                                 {"artefacto": "failed"})
            record["previousMain"] = current or None
            return True
        except Exception as error:  # noqa: BLE001 - qualquer erro aqui ocorre antes da troca
            return self.fail(record, "before_publication", "Verificacao falhou: %s" % str(error)[:300],
                             {"artefacto": "failed"})

    def swap(self, record: Dict[str, Any]) -> None:
        previous, _ = self.host.runtime()
        if previous == record["sha"]:
            # Ja ativo (pedido repetido ou outra via): so confirma, nao volta a publicar.
            if self.transition(record, "confirming", "Versao ja ativa; a confirmar.",
                               {"artefacto": "passed", "deploy": "skipped"}, previousVersion=previous):
                self.confirm(record)
            return
        log_path = self.deployment_log(record["key"])
        # Estado gravado antes de iniciar: um reinicio a meio nao repete o deploy.
        if not self.transition(record, "deploying", "Troca de versao em curso (drenagem, backup, migracoes, arranque).",
                               {"artefacto": "passed", "deploy": "running"}, previousVersion=previous,
                               logPath=log_path):
            return
        try:
            code = self.host.deploy(record["sha"], record["key"], log_path)
        except subprocess.TimeoutExpired:
            code = None
        except Exception as error:  # noqa: BLE001
            self.log({"event": "rollout.deploy_error", "key": record["key"], "error": str(error)[:300]})
            code = None
        if code == 0:
            self.transition(record, "confirming", "Deploy terminado; a confirmar a versao ativa de forma independente.",
                            {"deploy": "passed", "versao-ativa": "running"})
            self.confirm(record)
            return
        self.after_failed_deploy(record, code, log_path)

    def deployment_log(self, key: str) -> str:
        """Destino do processo de publicacao; operadores especializados podem usar um ficheiro fixo."""
        return os.path.join(self.config.state_dir, key + ".log")

    def after_failed_deploy(self, record: Dict[str, Any], code: Optional[int], log_path: str) -> None:
        version, executor = self.host.runtime()
        if version == record["sha"]:
            self.transition(record, "confirming", "Deploy devolveu erro mas a versao nova esta ativa; a confirmar.",
                            {"deploy": "failed", "versao-ativa": "running"})
            self.confirm(record)
        elif code is not None and version == record.get("previousVersion") and executor:
            if self.swap_started(record):
                self.fail(record, "during_swap",
                          "Falha durante a troca (codigo %s): versao anterior %s reposta e saudavel. Migracoes aplicadas "
                          "nao sao desfeitas; backup indicado no log do deploy." % (code, (version or "?")[:12]),
                          {"deploy": "failed", "versao-ativa": "skipped"})
            else:
                self.fail(record, "before_publication",
                          "Deploy falhou antes da troca (codigo %s); versao %s mantida." % (code, (version or "?")[:12]),
                          {"deploy": "failed", "versao-ativa": "skipped"})
        else:
            self.transition(record, "reconciling",
                            "Resultado incerto (codigo %s, versao ativa %s): em reconciliacao pelo estado externo."
                            % (code, version), {"deploy": "failed", "versao-ativa": "running"},
                            outcome="uncertain", reconcileSince=time.time())
            self.reconcile(record, interrupted=False)

    def swap_started(self, record: Dict[str, Any]) -> bool:
        """O script so troca o codigo depois do backup e antes das migracoes ("Migracoes" no log)."""
        try:
            with open(record.get("logPath") or "", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError:
            return False
        return "Migracoes" in text or "A repor versao anterior" in text

    def confirm(self, record: Dict[str, Any]) -> None:
        cfg = self.config
        deadline = time.time() + cfg.confirm_timeout
        observed_since = None
        last: Tuple[Optional[str], bool] = (None, False)
        while time.time() < deadline:
            last = self.host.runtime()
            if last[0] == record["sha"] and last[1]:
                observed_since = observed_since or time.time()
                if time.time() - observed_since >= cfg.observe_seconds:
                    self.succeed(record)
                    return
            else:
                observed_since = None
            self.host.sleep(cfg.poll_seconds)
        self.transition(record, "reconciling",
                        "Sem confirmacao da versao ativa (ultima leitura: versao %s, executor %s)." % last,
                        {"versao-ativa": "running"}, outcome="uncertain", reconcileSince=time.time())
        self.reconcile(record, interrupted=False)

    def reconcile(self, record: Dict[str, Any], interrupted: bool) -> None:
        cfg = self.config
        since = record.get("reconcileSince") or time.time()
        if "reconcileSince" not in record:
            record["reconcileSince"] = since
            self.save(record)
        while True:
            if self.host.deploy_running():
                self.host.sleep(cfg.poll_seconds)
                continue
            version, executor = self.host.runtime()
            if version == record["sha"] and executor:
                self.transition(record, "confirming", "Versao nova ativa; a observar.", {"versao-ativa": "running"})
                self.confirm(record)
                return
            if version is not None and version == record.get("previousVersion") and executor:
                phase = "during_swap" if self.swap_started(record) else "before_publication"
                self.fail(record, phase,
                          "A versao anterior %s continua ativa e saudavel: rollout nao publicado. Migracoes ja aplicadas "
                          "nao sao desfeitas." % version[:12], {"deploy": "failed", "versao-ativa": "failed"})
                return
            if time.time() - since > cfg.reconcile_limit:
                # Nunca declara sucesso ou falha sem prova: fica para verificacao manual.
                with self.lock:
                    record["message"] = ("Resultado incerto apos %ds (versao %s, executor %s): requer reconciliacao "
                                         "manual (ver %s)." % (cfg.reconcile_limit, version, executor,
                                                               record.get("logPath", "log do operador")))
                    record["outcome"] = "uncertain"
                    self.save(record)
                self.log({"event": "rollout.reconciliation_required", "key": record["key"]})
                return
            self.host.sleep(cfg.poll_seconds)

    def succeed(self, record: Dict[str, Any]) -> None:
        cfg = self.config
        note = ""
        previous = record.get("previousMain") or ""
        args = ["--git-dir", cfg.target_repo, "update-ref", "-m", "zeroops-rollout " + record["key"],
                "refs/heads/" + cfg.target_branch, record["sha"]]
        if previous:
            args.append(previous)
        # update-ref nao dispara o post-receive: o rollout ja publicou, nao ha deploy duplicado.
        if self.host.git(*args, check=False).returncode != 0:
            note = " O ramo %s do repositorio de deploy mudou entretanto e nao foi atualizado." % cfg.target_branch
        self.transition(record, "succeeded", "Versao %s ativa e saudavel durante %ds.%s"
                        % (record["sha"][:12], cfg.observe_seconds, note),
                        {"versao-ativa": "passed"}, outcome="published")

    def fail(self, record: Dict[str, Any], phase: str, message: str, checks: Dict[str, str]) -> bool:
        pending = {name: "skipped" for name in CHECKS if record["checks"].get(name) in ("pending", "running")}
        pending.update(checks)
        self.transition(record, "failed", message, pending, outcome=phase)
        return False

    def recover(self) -> None:
        for record in self.all():
            if record["state"] not in TERMINAL:
                self.log({"event": "rollout.recovering", "key": record["key"], "state": record["state"]})
                self.queue.put(record["key"])

    def worker(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                key = self.queue.get(timeout=1)
            except queue.Empty:
                continue
            try:
                self.run(key)
            except Exception:  # noqa: BLE001 - o servico continua; o estado gravado permite retomar
                self.log({"event": "rollout.worker_error", "key": key, "error": traceback.format_exc()[-800:]})


def handler_for(operator: Operator):
    class Handler(BaseHTTPRequestHandler):
        server_version = "zeroops-rollout"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401 - silencia o log padrao
            return

        def _send(self, status: int, body: Dict[str, Any]) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> Optional[bytes]:
            length = int(self.headers.get("content-length") or 0)
            if length > 65536:
                return None
            body = self.rfile.read(length) if length else b""
            if not verify_signature(operator.config.secret, self.headers.get(TIMESTAMP_HEADER),
                                    self.headers.get(SIGNATURE_HEADER), body):
                return None
            return body

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            if path == "/health":
                return self._send(200, {"ok": True, "queued": operator.queue.qsize()})
            if self._body() is None:
                return self._send(401, {"error": "assinatura invalida"})
            match = re.match(r"^/deliveries/([0-9a-f-]{36})$", path)
            record = operator.load(match.group(1)) if match else None
            if not record:
                return self._send(404, {"error": "entrega desconhecida"})
            return self._send(200, operator.event(record))

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            body = self._body()
            if body is None:
                return self._send(401, {"error": "assinatura invalida"})
            if path == "/deliveries":
                try:
                    payload = json.loads(body.decode() or "{}")
                except ValueError:
                    return self._send(400, {"error": "json invalido"})
                status, response = operator.submit(payload if isinstance(payload, dict) else {})
                return self._send(status, response)
            match = re.match(r"^/deliveries/([0-9a-f-]{36})/cancel$", path)
            if match:
                status, response = operator.cancel(match.group(1))
                return self._send(status, response)
            return self._send(404, {"error": "rota desconhecida"})

    return Handler


def main() -> int:
    config = Config(dict(os.environ))
    operator = Operator(config, Host(config))
    stop = threading.Event()
    thread = threading.Thread(target=operator.worker, args=(stop,), daemon=True)
    thread.start()
    operator.recover()
    server = ThreadingHTTPServer((config.bind, config.port), handler_for(operator))
    operator.log({"event": "rollout.started", "bind": config.bind, "port": config.port,
                  "target": config.target_repo, "source": config.source_repo})
    try:
        server.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
