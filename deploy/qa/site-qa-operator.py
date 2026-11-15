#!/usr/bin/env python3
"""Pipeline QA restrita aos dois ficheiros do ensaio Pizza Hut e a sua remocao.

Reutiliza HMAC, idempotencia, callbacks e recuperacao do operador P10. Nunca executa
scripts do repositorio. O processo de publicacao sobrevive ao reinicio do servidor
HTTP e mantem um lock do webroot tambem nos subprocessos Git que o podem alterar.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.request

SPEC = importlib.util.spec_from_file_location(
    "zeroops_rollout", Path(__file__).with_name("zeroops-rollout-operator.py"))
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)

APPROVED_FILES = {
    "adm/zeroops-server-check.php": "a40980e147102402877abb5d8bdd5d25a198040c32566d9729062f54edf96170",
    "zeroops-check.txt": "8208ab3838ba2f0f5a8f937ef8472d953d90b1679230fe74e35bb9ae0a15e6e3",
}
SAFE_ENV = ("PATH", "SystemRoot", "SYSTEMROOT", "PATHEXT", "TEMP", "TMP", "LANG", "TZ")


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


class SiteConfig(rollout.Config):
    def __init__(self, env):
        mapped = dict(env)
        mapped.setdefault("ZEROOPS_ROLLOUT_PORT", "4321")
        super().__init__(mapped)
        self.environment = mapped
        self.webroot_path = env["ZEROOPS_SITE_WEBROOT"]
        self.webroot = os.path.realpath(self.webroot_path)
        self.git_dir_path = env["ZEROOPS_SITE_GIT_DIR"]
        self.git_dir = os.path.realpath(self.git_dir_path)
        self.site_user = env["ZEROOPS_SITE_USER"]
        self.project_id = env["ZEROOPS_SITE_PROJECT_ID"]
        self.repository_id = env["ZEROOPS_SITE_REPOSITORY_ID"]
        self.expected_host = env["ZEROOPS_SITE_EXPECTED_HOST"]
        self.health_url = env["ZEROOPS_SITE_HEALTH_URL"]
        self.ca_file = env["ZEROOPS_SITE_CA_FILE"]
        self.backup_dir = env["ZEROOPS_SITE_BACKUP_DIR"]
        self.publication_log = env["ZEROOPS_SITE_PUBLICATION_LOG"]
        if self.allowed_refs != ["qa"] or self.target_branch != "qa" or self.allowed_environments != ["quality"]:
            raise ValueError("Este operador so permite qa / quality.")
        if self.bind != "127.0.0.1" or not self.health_url.startswith("https://"):
            raise ValueError("Exige listener loopback e verificacao HTTPS.")
        identity = os.stat(self.webroot)
        self.target_identity = [identity.st_dev, identity.st_ino]
        self.lock_name = "zeroops-site-%s-%s" % tuple(self.target_identity)
        self.binding = fingerprint([
            self.webroot, self.git_dir, self.target_identity, self.source_repo,
            self.project_id, self.repository_id, self.target_branch, self.health_url,
        ])

    def lock_path(self, purpose):
        return os.path.join(self.lock_dir, self.lock_name + "-" + purpose + ".lock")


class SiteHost(rollout.Host):
    def __init__(self, config):
        super().__init__(config)
        self.lock_fd = None
        self.uid = self.gid = None
        if os.name != "nt":
            import pwd
            account = pwd.getpwnam(config.site_user)
            self.uid, self.gid = account.pw_uid, account.pw_gid

    def git_env(self, token=None):
        env = {key: os.environ[key] for key in SAFE_ENV if key in os.environ}
        env.update(GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1",
                   GIT_CONFIG_GLOBAL=os.devnull)
        config = [("core.hooksPath", os.devnull), ("core.fsmonitor", "false"),
                  ("http.followRedirects", "false")]
        if token:
            encoded = base64.b64encode(("x-access-token:" + token).encode()).decode()
            config.append(("http.%s.extraHeader" % self.config.source_repo,
                           "Authorization: Basic " + encoded))
        env["GIT_CONFIG_COUNT"] = str(len(config))
        for index, (key, value) in enumerate(config):
            env["GIT_CONFIG_KEY_%d" % index] = key
            env["GIT_CONFIG_VALUE_%d" % index] = value
        return env

    def command(self, args, check=True, token=None):
        options = {"pass_fds": (self.lock_fd,)} if self.lock_fd is not None else {}
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=self.git_env(token), timeout=120, **options)
        if token:
            encoded = base64.b64encode(("x-access-token:" + token).encode())
            result.stderr = result.stderr.replace(token.encode(), b"***").replace(encoded, b"***")
        if check and result.returncode:
            raise RuntimeError("Comando falhou (%s): %s" %
                               (result.returncode, result.stderr.decode(errors="replace")[:400]))
        return result

    def credential(self):
        cfg = self.config
        script = Path(__file__).with_name("site-qa-credential.mjs").read_bytes()
        command = ["docker", "exec", "-i"]
        for name, value in (("PROJECT_ID", cfg.project_id), ("REPOSITORY_ID", cfg.repository_id),
                            ("SOURCE_REPO", cfg.source_repo)):
            command.extend(["-e", "ZEROOPS_SITE_" + name + "=" + value])
        command.extend(["zeroops-api-1", "node", "--input-type=module"])
        result = subprocess.run(command, input=script, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, env=self.git_env())
        if result.returncode:
            raise RuntimeError("Fornecedor Git QA recusou o pedido: " +
                               result.stderr.decode(errors="replace")[:300])
        token = result.stdout.decode().strip()
        if not token or len(token) > 500 or any(ord(char) < 33 or ord(char) > 126 for char in token):
            raise RuntimeError("Fornecedor Git QA devolveu uma credencial invalida.")
        return token

    def git(self, *args, check=True):
        token = self.credential() if "fetch" in args and self.config.source_repo in args and \
            self.config.source_repo.startswith("https://") else None
        return self.command(["git", *args], check=check, token=token)

    def site_git(self, *args, check=True):
        command = ["git", "--git-dir", self.config.git_dir, "--work-tree", self.config.webroot, *args]
        if self.uid is not None and os.geteuid() != self.uid:
            command = ["setpriv", "--reuid=" + str(self.uid), "--regid=" + str(self.gid),
                       "--clear-groups", "--", *command]
        return self.command(command, check=check)

    def archive_digest(self, git_dir, sha):
        with tempfile.TemporaryFile() as output:
            subprocess.run(["git", "--git-dir", git_dir, "archive", "--format=tar", sha],
                           stdout=output, check=True, env=self.git_env(), timeout=120)
            output.seek(0)
            digest = hashlib.sha256()
            for chunk in iter(lambda: output.read(65536), b""):
                digest.update(chunk)
            return "sha256:" + digest.hexdigest()

    def identity(self):
        cfg = self.config
        current = os.stat(cfg.webroot)
        if os.path.realpath(cfg.webroot_path) != cfg.webroot or \
                os.path.realpath(cfg.git_dir_path) != cfg.git_dir or \
                [current.st_dev, current.st_ino] != cfg.target_identity:
            raise RuntimeError("A identidade fisica do destino mudou.")
        if os.path.realpath(self.site_git("rev-parse", "--show-toplevel").stdout.decode().strip()) != cfg.webroot or \
                os.path.realpath(self.site_git("rev-parse", "--absolute-git-dir").stdout.decode().strip()) != cfg.git_dir:
            raise RuntimeError("Git dir ou webroot diferente do binding.")
        if self.site_git("symbolic-ref", "--short", "HEAD").stdout.decode().strip() != "qa" or \
                self.site_git("config", "--get", "remote.origin.url").stdout.decode().strip() != cfg.source_repo:
            raise RuntimeError("Branch ou origem do site diferente do binding.")
        return self.site_git("rev-parse", "HEAD").stdout.decode().strip()

    def untracked(self):
        entries = self.site_git("status", "--porcelain", "--untracked-files=all", "-z").stdout.split(b"\0")
        if any(entry and not entry.startswith(b"?? ") for entry in entries):
            raise RuntimeError("O site tem alteracoes locais tracked/staged; publicacao recusada.")
        return sorted(base64.b64encode(entry[3:]).decode() for entry in entries if entry)

    def blob(self, sha, path):
        cfg = self.config
        entry = self.git("--git-dir", cfg.target_repo, "ls-tree", sha, "--", path).stdout
        if not entry:
            return None
        if not entry.startswith(b"100644 blob "):
            raise RuntimeError("Tipo de ficheiro nao permitido no ensaio.")
        body = self.git("--git-dir", cfg.target_repo, "show", sha + ":" + path).stdout
        if hashlib.sha256(body).hexdigest() != APPROVED_FILES[path]:
            raise RuntimeError("Conteudo diferente do diagnostico filtrado e autenticado revisto no PR 1.")
        return body

    def preflight(self, sha):
        cfg = self.config
        previous = self.identity()
        untracked = self.untracked()
        self.git("--git-dir", cfg.target_repo, "merge-base", "--is-ancestor", previous, sha)
        changed = self.git("--git-dir", cfg.target_repo, "diff", "--name-only", "--no-renames",
                           "-z", previous, sha).stdout.split(b"\0")
        if any(path.decode() not in APPROVED_FILES for path in changed if path):
            raise RuntimeError("O ensaio so autoriza o diagnostico filtrado, o marcador e a sua remocao.")
        for path in APPROVED_FILES:
            body = self.blob(sha, path)
            destination = os.path.join(cfg.webroot, path)
            tracked = self.git("--git-dir", cfg.target_repo, "ls-tree", previous, "--", path).stdout
            if not tracked and os.path.lexists(destination) and body is not None:
                raise RuntimeError("Um ficheiro nao versionado ocupa o destino; nao sera sobrescrito.")
            if os.path.commonpath([cfg.webroot, os.path.realpath(os.path.dirname(destination))]) != cfg.webroot or \
                    os.path.islink(destination):
                raise RuntimeError("Caminho do ensaio redirecionado por symlink.")
            if body is not None and path.endswith(".php"):
                self.lint_php(body)
        return previous, untracked

    def lint_php(self, body):
        with tempfile.TemporaryDirectory(prefix="zeroops-site-") as directory:
            file = os.path.join(directory, "check.php")
            Path(file).write_bytes(body)
            if self.uid is not None:
                os.chown(directory, self.uid, self.gid)
                os.chown(file, self.uid, self.gid)
            command = ["php", "-n", "-l", file]
            if self.uid is not None and os.geteuid() != self.uid:
                command = ["setpriv", "--reuid=" + str(self.uid), "--regid=" + str(self.gid),
                           "--clear-groups", "--", *command]
            self.command(command)

    def journal_path(self, key):
        return os.path.join(self.config.state_dir, "publications", key + ".json")

    def journal(self, key):
        try:
            return json.loads(Path(self.journal_path(key)).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def save_journal(self, key, record):
        directory = os.path.dirname(self.journal_path(key))
        os.makedirs(directory, mode=0o700, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=directory)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(record, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, self.journal_path(key))

    def publish(self, sha, key):
        cfg = self.config
        previous, untracked = self.preflight(sha)
        if previous == sha:
            raise RuntimeError("SHA ja ativo fora desta publicacao; nao e prova de entrega automatica.")
        os.makedirs(cfg.backup_dir, mode=0o700, exist_ok=True)
        backup = os.path.join(cfg.backup_dir, key + ".tar")
        with open(backup, "xb") as file:
            subprocess.run(["git", "--git-dir", cfg.target_repo, "archive", previous],
                           stdout=file, check=True, env=self.git_env(), timeout=120)
        backup_digest = file_digest(backup)
        record = {"sha": sha, "previous": previous, "binding": cfg.binding,
                  "untracked": fingerprint(untracked), "untrackedCount": len(untracked),
                  "backup": backup, "backupSha256": backup_digest, "phase": "prepared"}
        self.save_journal(key, record)
        ref = "refs/zeroops-site/" + key
        self.git("--git-dir", cfg.target_repo, "update-ref", ref, sha)
        with tempfile.TemporaryDirectory(prefix="zeroops-site-") as directory:
            bundle = os.path.join(directory, "publication.bundle")
            self.git("--git-dir", cfg.target_repo, "bundle", "create", bundle, ref, "^" + previous)
            if self.uid is not None:
                os.chown(directory, self.uid, self.gid)
                os.chown(bundle, self.uid, self.gid)
            self.site_git("fetch", "--no-tags", "--quiet", bundle, ref + ":" + ref)
        if self.identity() != previous or self.untracked() != untracked:
            raise RuntimeError("O site mudou durante a preparacao; nada foi publicado.")
        record["phase"] = "swapping"
        self.save_journal(key, record)
        self.site_git("merge", "--ff-only", "--no-edit", sha)
        if self.identity() != sha or self.untracked() != untracked or not self.files_match(sha):
            raise RuntimeError("A publicacao nao preservou o estado esperado; requer reconciliacao.")
        record["phase"] = "complete"
        self.save_journal(key, record)

    def deploy(self, sha, key, log_path):
        env = {name: os.environ[name] for name in SAFE_ENV if name in os.environ}
        env.update({name: value for name, value in self.config.environment.items()
                    if name.startswith(("ZEROOPS_ROLLOUT_", "ZEROOPS_SITE_"))})
        with open(log_path, "ab") as log:
            process = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--publish", sha, key],
                                       stdout=log, stderr=subprocess.STDOUT, env=env)
        # A timeout never kills a publisher halfway through a Git operation.
        return process.wait(timeout=self.config.deploy_timeout)

    def deploy_running(self):
        with open(self.config.lock_path("publish"), "a") as lock:
            try:
                rollout.fcntl.flock(lock, rollout.fcntl.LOCK_EX | rollout.fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            rollout.fcntl.flock(lock, rollout.fcntl.LOCK_UN)
            return False

    def files_match(self, sha):
        for path in APPROVED_FILES:
            expected = self.blob(sha, path)
            actual = os.path.join(self.config.webroot, path)
            if os.path.commonpath([self.config.webroot, os.path.realpath(os.path.dirname(actual))]) != self.config.webroot:
                return False
            if expected is None:
                if os.path.lexists(actual):
                    return False
            elif os.path.islink(actual) or not os.path.isfile(actual) or Path(actual).read_bytes() != expected:
                return False
        return True

    def healthy(self):
        context = ssl.create_default_context(cafile=self.config.ca_file)
        with urllib.request.urlopen(self.config.health_url, context=context, timeout=10) as response:
            return 200 <= response.status < 300

    def runtime(self):
        sha = self.identity()
        if not self.files_match(sha):
            return sha, False
        try:
            return sha, self.healthy()
        except (OSError, ValueError) as error:
            print(json.dumps({"event": "site.health_failed", "reason": str(error)[:200]}), flush=True)
            return sha, False

    def evidence(self, key, sha):
        record = self.journal(key)
        return record is not None and record["phase"] == "complete" and \
            record["sha"] == sha and record["binding"] == self.config.binding and \
            fingerprint(self.untracked()) == record["untracked"] and \
            file_digest(record["backup"]) == record["backupSha256"]


class SiteOperator(rollout.Operator):
    def submit(self, payload):
        with self.lock:
            existing = self.load(str(payload.get("idempotencyKey", ""))) if \
                rollout.UUID_RE.fullmatch(str(payload.get("idempotencyKey", ""))) else None
            if existing and existing.get("binding") != self.config.binding:
                return 409, {"error": "binding alterado; requer reconciliacao explicita"}
            status, response = super().submit(payload)
            if status == 202:
                record = self.load(payload["idempotencyKey"])
                record["binding"] = self.config.binding
                self.save(record)
            return status, response

    def run(self, key):
        with self.lock:
            record = self.load(key)
        if not record or record["state"] in rollout.TERMINAL:
            return
        if record.get("binding") != self.config.binding:
            self.fail(record, "before_publication", "O binding mudou; a entrega nao sera redirecionada.",
                      {"deploy": "failed"})
            return
        with open(self.config.lock_path("queue"), "a") as lock:
            if rollout.fcntl is not None:
                rollout.fcntl.flock(lock, rollout.fcntl.LOCK_EX)
            super().run(key)

    def verify(self, record):
        if not super().verify(record):
            return False
        try:
            self.host.preflight(record["sha"])
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            return self.fail(record, "before_publication", str(error)[:400], {"artefacto": "failed"})
        return True

    def deployment_log(self, key):
        return self.config.publication_log

    def swap_started(self, record):
        journal = self.host.journal(record["key"])
        return journal is not None and journal["phase"] in ("swapping", "complete")

    def succeed(self, record):
        if not self.host.evidence(record["key"], record["sha"]):
            self.fail(record, "verification", "Falta prova da publicacao e da preservacao dos ficheiros locais.",
                      {"deploy": "failed", "versao-ativa": "failed"})
            return
        record["checks"]["deploy"] = "passed"
        super().succeed(record)


def main():
    os.umask(0o077)
    config = SiteConfig(dict(os.environ))
    if rollout.fcntl is None or os.geteuid() != 0 or socket.gethostname() != config.expected_host:
        raise RuntimeError("Operador reservado ao host QA autorizado e a root.")
    host = SiteHost(config)
    if host.uid == 0:
        raise RuntimeError("A publicacao Git do site nao pode correr como root.")
    if len(sys.argv) > 1:
        if len(sys.argv) != 4 or sys.argv[1] != "--publish" or not rollout.SHA_RE.fullmatch(sys.argv[2]) or \
                not rollout.UUID_RE.fullmatch(sys.argv[3]):
            raise ValueError("Pedido de publicacao invalido.")
        with open(config.lock_path("publish"), "a") as lock:
            rollout.fcntl.flock(lock, rollout.fcntl.LOCK_EX)
            host.lock_fd = lock.fileno()
            host.publish(sys.argv[2], sys.argv[3])
        return 0
    operator = SiteOperator(config, host)
    stop = threading.Event()
    threading.Thread(target=operator.worker, args=(stop,), daemon=True).start()
    operator.recover()
    server = rollout.ThreadingHTTPServer((config.bind, config.port), rollout.handler_for(operator))
    operator.log({"event": "site.started", "binding": config.binding, "port": config.port})
    try:
        server.serve_forever()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
