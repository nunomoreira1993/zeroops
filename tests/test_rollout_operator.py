import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "deploy" / "qa" / "zeroops-rollout-operator.py"
SPEC = importlib.util.spec_from_file_location("rollout_operator", MODULE_PATH)
op = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(op)

SECRET = "s" * 40
KEY = "11111111-2222-4333-8444-555555555555"


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE).stdout.decode().strip()


class FakeHost(op.Host):
    """Git real (repositorios temporarios); deploy, health e callbacks simulados."""

    def __init__(self, config, previous_version):
        super().__init__(config)
        self.version = previous_version
        self.executor = True
        self.deploys = []
        self.callbacks = []
        self.on_deploy = None

    def deploy(self, sha, key, log_path):
        self.deploys.append(sha)
        return self.on_deploy(sha, log_path) if self.on_deploy else self._ok(sha, log_path)

    def _ok(self, sha, log_path):
        Path(log_path).write_text("Backup\nMigracoes\nArranque\nOK\n", encoding="utf-8")
        self.version = sha
        return 0

    def runtime(self):
        return self.version, self.executor

    def deploy_running(self):
        return False

    def post_callback(self, url, body):
        self.callbacks.append((url, json.loads(body)))
        return 200

    def sleep(self, seconds):
        return None


class RolloutOperatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="rollout-")
        root = Path(self.tmp)
        self.source = str(root / "source.git")
        self.target = str(root / "target.git")
        work = str(root / "work")
        git("init", "--bare", "-q", self.source)
        git("init", "--bare", "-q", self.target)
        git("init", "-q", work)
        git("config", "user.email", "t@example.invalid", cwd=work)
        git("config", "user.name", "t", cwd=work)
        Path(work, "a.txt").write_text("base\n")
        git("add", "a.txt", cwd=work)
        git("commit", "-qm", "base", cwd=work)
        self.base = git("rev-parse", "HEAD", cwd=work)
        git("push", "-q", self.target, "HEAD:refs/heads/main", cwd=work)
        Path(work, "b.txt").write_text("capacidade\n")
        git("add", "b.txt", cwd=work)
        git("commit", "-qm", "capacidade", cwd=work)
        self.sha = git("rev-parse", "HEAD", cwd=work)
        git("push", "-q", self.source, "HEAD:refs/heads/main", cwd=work)
        self.work = work
        archive = subprocess.run(["git", "--git-dir", self.source, "archive", "--format=tar", self.sha],
                                 check=True, stdout=subprocess.PIPE).stdout
        self.digest = "sha256:" + hashlib.sha256(archive).hexdigest()
        self.config = op.Config({
            "ZEROOPS_ROLLOUT_SECRET": SECRET,
            "ZEROOPS_ROLLOUT_STATE_DIR": str(root / "state"),
            "ZEROOPS_ROLLOUT_LOCK_DIR": self.tmp,
            "ZEROOPS_ROLLOUT_SOURCE_REPO": self.source,
            "ZEROOPS_ROLLOUT_TARGET_REPO": self.target,
            "ZEROOPS_ROLLOUT_OBSERVE_SECONDS": "0",
            "ZEROOPS_ROLLOUT_CONFIRM_TIMEOUT_SECONDS": "1",
            "ZEROOPS_ROLLOUT_POLL_SECONDS": "0",
            "ZEROOPS_ROLLOUT_RECONCILE_LIMIT_SECONDS": "0",
        })
        self.host = FakeHost(self.config, self.base)
        self.operator = op.Operator(self.config, self.host, log=lambda event: None)

    def tearDown(self):
        def unlock(func, path, _):
            os.chmod(path, 0o700)
            func(path)
        shutil.rmtree(self.tmp, onerror=unlock)

    def payload(self, **extra):
        body = {"idempotencyKey": KEY, "deliveryId": "d1", "ticket": "ZO-1", "ref": "main", "sha": self.sha,
                "artifactDigest": self.digest, "environment": "quality",
                "callbackUrl": "https://tickets.example.invalid/api/pipelines/p1/callbacks"}
        body.update(extra)
        return body

    def target_main(self):
        return git("--git-dir", self.target, "rev-parse", "refs/heads/main")

    def run_rollout(self, **extra):
        status, _ = self.operator.submit(self.payload(**extra))
        self.assertEqual(status, 202)
        self.operator.run(KEY)
        return self.operator.load(KEY)

    def test_signature_is_hmac_over_timestamp_and_body_with_tolerance(self):
        now = time.time()
        timestamp = str(int(now))
        body = b'{"a":1}'
        signature = op.sign(SECRET, timestamp, body)
        self.assertTrue(op.verify_signature(SECRET, timestamp, signature, body, now))
        self.assertFalse(op.verify_signature(SECRET, timestamp, signature, b'{"a":2}', now))
        self.assertFalse(op.verify_signature(SECRET, timestamp, signature, body, now + 301))
        self.assertFalse(op.verify_signature(SECRET, None, signature, body, now))

    def test_repeated_request_is_idempotent_and_key_cannot_change_artifact(self):
        self.assertEqual(self.operator.submit(self.payload())[0], 202)
        status, body = self.operator.submit(self.payload())
        self.assertEqual((status, body["externalId"]), (409, "rollout-" + KEY))
        self.assertEqual(self.operator.submit(self.payload(sha="f" * 40))[0], 409)
        self.assertEqual(self.operator.load(KEY)["sha"], self.sha)
        self.assertEqual(self.operator.submit(dict(self.payload(), idempotencyKey="22222222-2222-4333-8444-555555555555",
                                                   environment="production"))[0], 403)

    def test_verified_rollout_is_confirmed_externally_and_advances_main_once(self):
        record = self.run_rollout()
        self.assertEqual(record["state"], "succeeded")
        self.assertEqual(record["outcome"], "published")
        self.assertEqual(self.host.deploys, [self.sha])
        self.assertEqual(self.target_main(), self.sha)
        events = [event for _, event in self.host.callbacks]
        self.assertEqual([event["sequence"] for event in events], sorted({event["sequence"] for event in events}))
        self.assertEqual(events[-1]["status"], "succeeded")
        self.assertEqual({check["status"] for check in events[-1]["checks"]}, {"passed"})
        self.assertTrue(all(url.startswith("http://127.0.0.1:4311/api/pipelines/p1/") for url, _ in self.host.callbacks))
        # Repetir a execucao (ex.: novo pedido apos reinicio) nao volta a publicar.
        self.operator.run(KEY)
        self.assertEqual(self.host.deploys, [self.sha])

    def test_digest_mismatch_fails_before_publication_without_deploy(self):
        record = self.run_rollout(artifactDigest="sha256:" + "0" * 64)
        self.assertEqual((record["state"], record["outcome"]), ("failed", "before_publication"))
        self.assertEqual(self.host.deploys, [])
        self.assertEqual(self.target_main(), self.base)

    def test_rejects_commit_that_does_not_fast_forward_published_main(self):
        git("checkout", "-q", "--detach", self.base, cwd=self.work)
        Path(self.work, "c.txt").write_text("outro\n")
        git("add", "c.txt", cwd=self.work)
        git("commit", "-qm", "divergente", cwd=self.work)
        git("push", "-q", self.target, "HEAD:refs/heads/main", cwd=self.work)
        record = self.run_rollout()
        self.assertEqual(record["state"], "failed")
        self.assertIn("descende", record["message"])
        self.assertEqual(self.host.deploys, [])

    def test_failure_before_swap_keeps_previous_version(self):
        def fail_build(sha, log_path):
            Path(log_path).write_text("Build api/executor\nERRO: build falhou; nada foi alterado\n", encoding="utf-8")
            return 1
        self.host.on_deploy = fail_build
        record = self.run_rollout()
        self.assertEqual((record["state"], record["outcome"]), ("failed", "before_publication"))
        self.assertEqual(self.target_main(), self.base)

    def test_failure_during_swap_with_rollback_is_reported_as_such(self):
        def fail_health(sha, log_path):
            Path(log_path).write_text("Migracoes\nArranque\nA repor versao anterior\n", encoding="utf-8")
            return 1
        self.host.on_deploy = fail_health
        record = self.run_rollout()
        self.assertEqual((record["state"], record["outcome"]), ("failed", "during_swap"))
        self.assertIn("Migracoes aplicadas nao sao desfeitas", record["message"])
        self.assertEqual(self.target_main(), self.base)

    def test_uncertain_result_is_never_declared_success_or_failure(self):
        def lost(sha, log_path):
            Path(log_path).write_text("Migracoes\n", encoding="utf-8")
            self.host.version = None
            self.host.executor = False
            return None
        self.host.on_deploy = lost
        record = self.run_rollout()
        self.assertEqual(record["state"], "reconciling")
        self.assertEqual(record["outcome"], "uncertain")
        self.assertIn("reconciliacao manual", record["message"])
        self.assertEqual(self.operator.event(record)["status"], "running")
        self.assertEqual(self.target_main(), self.base)

    def test_restart_during_swap_reconciles_without_redeploying(self):
        self.host.on_deploy = lambda sha, log_path: (_ for _ in ()).throw(KeyboardInterrupt())
        self.operator.submit(self.payload())
        with self.assertRaises(KeyboardInterrupt):
            self.operator.run(KEY)
        self.assertEqual(self.operator.load(KEY)["state"], "deploying")
        # O deploy (filho) terminou enquanto o operador estava em baixo; a versao nova esta ativa.
        self.host.version = self.sha
        self.host.on_deploy = None
        self.host.deploys.clear()
        restarted = op.Operator(self.config, self.host, log=lambda event: None)
        restarted.recover()
        restarted.run(restarted.queue.get_nowait())
        record = restarted.load(KEY)
        self.assertEqual(record["state"], "succeeded")
        self.assertEqual(self.host.deploys, [])
        self.assertEqual(self.target_main(), self.sha)

    def test_cancel_before_swap_stops_rollout_and_is_refused_during_swap(self):
        self.operator.submit(self.payload())
        self.assertEqual(self.operator.cancel(KEY)[0], 202)
        self.operator.run(KEY)
        self.assertEqual(self.operator.load(KEY)["state"], "cancelled")
        self.assertEqual(self.host.deploys, [])
        other = "33333333-2222-4333-8444-555555555555"
        statuses = []
        self.host.on_deploy = lambda sha, log_path: statuses.append(self.operator.cancel(other)[0]) or self.host._ok(sha, log_path)
        self.operator.submit(self.payload(idempotencyKey=other))
        self.operator.run(other)
        self.assertEqual(statuses, [409])
        self.assertEqual(self.operator.load(other)["state"], "succeeded")


if __name__ == "__main__":
    unittest.main()
