import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

MODULE = Path(__file__).parents[1] / "deploy" / "qa" / "site-qa-operator.py"
SPEC = importlib.util.spec_from_file_location("site_operator", MODULE)
site = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(site)
KEY = "11111111-2222-4333-8444-555555555555"
PHP = (
    '<?php\n'
    'require_once("control.obj.php");\n'
    'require_once ($dir_admin . "/include/topo.inc.php");\n'
    '\n'
    '$lista->title = "ZeroOps - verifica\u00e7\u00e3o do servidor";\n'
    '$lista->breadcrumbs = $lista->title;\n'
    '$lista->modulo = "informacoes_sistema";\n'
    '$lista->voltar = false;\n'
    '$lista->titulo();\n'
    '\n'
    'if ($lista->Autenticacao($lista->modulo)) {\n'
    '\n'
    '\t$chaves_permitidas = array("SERVER_NAME", "HTTP_HOST", "REQUEST_URI", "REMOTE_ADDR", "SERVER_SOFTWARE", "REQUEST_TIME");\n'
    '\t$server_filtrado = array_intersect_key($_SERVER, array_flip($chaves_permitidas));\n'
    '\n'
    '\tpr($server_filtrado);\n'
    '}\n'
    '\n'
    'require_once ($dir_admin . "/include/rodape.inc.php");\n'
).encode("utf-8")
MARKER = b"ZeroOps E2E check\n"
APPROVED_FILES = {
    "adm/zeroops-server-check.php": "a40980e147102402877abb5d8bdd5d25a198040c32566d9729062f54edf96170",
    "zeroops-check.txt": "8208ab3838ba2f0f5a8f937ef8472d953d90b1679230fe74e35bb9ae0a15e6e3",
}


def git(*args, cwd=None):
    result = subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", *args], cwd=cwd,
                            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.decode().strip()


class FixtureHost(site.SiteHost):
    """Git/filesystem reais; PHP, HTTPS, processo independente e callbacks simulados."""

    def __init__(self, config):
        super().__init__(config)
        self.deploys = []
        self.callbacks = []
        self.php_checks = []

    def lint_php(self, body):
        self.php_checks.append(body)

    def healthy(self):
        return True

    def deploy(self, sha, key, log_path):
        self.deploys.append(sha)
        self.publish(sha, key)
        return 0

    def deploy_running(self):
        return False

    def post_callback(self, url, body):
        self.callbacks.append(json.loads(body))
        return 200


class SiteQaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="zeroops-site-test-")
        self.addCleanup(self.cleanup)
        root = Path(self.tmp)
        self.seed, self.webroot = root / "seed", root / "site"
        self.source, self.target = root / "source.git", root / "target.git"
        self.git_dir = root / "site-git"
        git("init", "--bare", "-q", str(self.source))
        git("init", "--bare", "-q", str(self.target))
        git("init", "-q", str(self.seed))
        git("symbolic-ref", "HEAD", "refs/heads/qa", cwd=self.seed)
        git("config", "user.name", "Fixture", cwd=self.seed)
        git("config", "user.email", "fixture@example.invalid", cwd=self.seed)
        (self.seed / "adm").mkdir()
        (self.seed / "adm" / "index.php").write_bytes(b"fixture base\n")
        git("add", ".", cwd=self.seed)
        git("commit", "-qm", "base", cwd=self.seed)
        self.base = git("rev-parse", "HEAD", cwd=self.seed)
        git("push", "-q", str(self.source), "qa", cwd=self.seed)
        git("push", "-q", str(self.target), "qa", cwd=self.seed)
        git("clone", "-q", "--branch", "qa", str(self.source), str(self.webroot))
        shutil.move(str(self.webroot / ".git"), str(self.git_dir))
        (self.webroot / "local-private.txt").write_bytes(b"preserve this untracked file\n")
        (self.seed / "adm" / "zeroops-server-check.php").write_bytes(PHP)
        (self.seed / "zeroops-check.txt").write_bytes(MARKER)
        git("add", ".", cwd=self.seed)
        git("commit", "-qm", "diagnostic", cwd=self.seed)
        self.sha = git("rev-parse", "HEAD", cwd=self.seed)
        git("push", "-q", str(self.source), "qa", cwd=self.seed)
        user = os.environ.get("USERNAME", "fixture")
        if os.name != "nt":
            import pwd
            user = pwd.getpwuid(os.geteuid()).pw_name
        self.env = {
            "ZEROOPS_ROLLOUT_SECRET": "s" * 40,
            "ZEROOPS_ROLLOUT_STATE_DIR": str(root / "state"),
            "ZEROOPS_ROLLOUT_LOCK_DIR": str(root),
            "ZEROOPS_ROLLOUT_SOURCE_REPO": str(self.source),
            "ZEROOPS_ROLLOUT_TARGET_REPO": str(self.target),
            "ZEROOPS_ROLLOUT_TARGET_BRANCH": "qa",
            "ZEROOPS_ROLLOUT_ALLOWED_REFS": "qa",
            "ZEROOPS_ROLLOUT_OBSERVE_SECONDS": "0",
            "ZEROOPS_ROLLOUT_CONFIRM_TIMEOUT_SECONDS": "1",
            "ZEROOPS_ROLLOUT_RECONCILE_LIMIT_SECONDS": "0",
            "ZEROOPS_SITE_WEBROOT": str(self.webroot),
            "ZEROOPS_SITE_GIT_DIR": str(self.git_dir),
            "ZEROOPS_SITE_USER": user,
            "ZEROOPS_SITE_PROJECT_ID": "00000000-0000-4000-8000-000000000001",
            "ZEROOPS_SITE_REPOSITORY_ID": KEY,
            "ZEROOPS_SITE_EXPECTED_HOST": socket.gethostname(),
            "ZEROOPS_SITE_HEALTH_URL": "https://site.example.invalid/adm/",
            "ZEROOPS_SITE_CA_FILE": str(root / "test-ca"),
            "ZEROOPS_SITE_BACKUP_DIR": str(root / "backups"),
            "ZEROOPS_SITE_PUBLICATION_LOG": str(root / "publication.log"),
        }
        self.config = site.SiteConfig(self.env)
        self.host = FixtureHost(self.config)
        self.assertEqual(len(self.host.untracked()), 1)
        self.operator = site.SiteOperator(self.config, self.host, log=lambda event: None)
        self.digest = self.host.archive_digest(str(self.source), self.sha)

    def cleanup(self):
        def unlock(function, path, _):
            os.chmod(path, 0o700)
            function(path)
        shutil.rmtree(self.tmp, onerror=unlock)

    def payload(self, **changes):
        payload = {"idempotencyKey": KEY, "sha": self.sha, "artifactDigest": self.digest,
                   "ref": "qa", "environment": "quality", "ticket": "fixture",
                   "callbackUrl": "https://tickets.example.invalid/api/pipelines/fixture/callbacks"}
        payload.update(changes)
        return payload

    def run_delivery(self, **changes):
        payload = self.payload(**changes)
        self.assertEqual(self.operator.submit(payload)[0], 202)
        self.operator.run(payload["idempotencyKey"])
        return self.operator.load(payload["idempotencyKey"])

    def test_publishes_exact_sha_preserves_untracked_and_returns_checked_callback(self):
        record = self.run_delivery()
        self.assertEqual(record["state"], "succeeded")
        self.assertEqual(self.host.identity(), self.sha)
        self.assertEqual((self.webroot / "local-private.txt").read_bytes(),
                         b"preserve this untracked file\n")
        self.assertEqual(self.host.php_checks, [PHP, PHP])
        for path, digest in APPROVED_FILES.items():
            self.assertEqual(hashlib.sha256((self.webroot / path).read_bytes()).hexdigest(), digest)
        journal = self.host.journal(KEY)
        self.assertEqual((journal["previous"], journal["sha"], journal["untrackedCount"]),
                         (self.base, self.sha, 1))
        self.assertTrue(self.host.evidence(KEY, self.sha))
        event = self.host.callbacks[-1]
        self.assertEqual((event["status"], event["sha"], event["artifactDigest"]),
                         ("succeeded", self.sha, self.digest))
        self.assertTrue(all(check["status"] == "passed" for check in event["checks"]))
        self.assertEqual(self.operator.submit(self.payload())[0], 409)
        self.operator.run(KEY)
        self.assertEqual(self.host.deploys, [self.sha])

    def test_dirty_site_is_not_overwritten(self):
        (self.webroot / "adm" / "index.php").write_bytes(b"local edit\n")
        record = self.run_delivery()
        self.assertEqual(record["state"], "failed")
        self.assertEqual(self.host.deploys, [])
        self.assertEqual(self.host.identity(), self.base)
        self.assertEqual((self.webroot / "adm" / "index.php").read_bytes(), b"local edit\n")

    def test_untracked_collision_is_rejected_before_publication(self):
        destination = self.webroot / "zeroops-check.txt"
        destination.write_bytes(b"customer local file\n")
        record = self.run_delivery()
        self.assertEqual(record["state"], "failed")
        self.assertEqual(self.host.deploys, [])
        self.assertEqual(destination.read_bytes(), b"customer local file\n")

    def test_wrong_digest_never_starts_publication(self):
        record = self.run_delivery(artifactDigest="sha256:" + "0" * 64)
        self.assertEqual(record["state"], "failed")
        self.assertEqual(self.host.deploys, [])
        self.assertEqual(self.host.identity(), self.base)

    def test_other_approved_artifact_can_modify_rename_delete_and_add_binary_files(self):
        self.run_delivery()
        binary = b"\x00\x01\xffapproved asset\n"
        (self.seed / "assets").mkdir()
        (self.seed / "assets" / "image.bin").write_bytes(binary)
        (self.seed / "adm" / "index.php").write_bytes(b"<?php echo 'approved update';\n")
        git("mv", "zeroops-check.txt", "service-status.txt", cwd=self.seed)
        git("rm", "adm/zeroops-server-check.php", cwd=self.seed)
        git("add", ".", cwd=self.seed)
        git("commit", "-qm", "another approved artifact", cwd=self.seed)
        sha = git("rev-parse", "HEAD", cwd=self.seed)
        git("push", "-q", str(self.source), "qa", cwd=self.seed)
        record = self.run_delivery(idempotencyKey="aaaaaaaa-2222-4333-8444-555555555555",
                                   ticket="different-ticket", sha=sha,
                                   artifactDigest=self.host.archive_digest(str(self.source), sha))
        self.assertEqual(record["state"], "succeeded")
        self.assertEqual(self.host.identity(), sha)
        self.assertEqual((self.webroot / "assets" / "image.bin").read_bytes(), binary)
        self.assertEqual((self.webroot / "service-status.txt").read_bytes(), MARKER)
        self.assertFalse((self.webroot / "zeroops-check.txt").exists())
        self.assertFalse((self.webroot / "adm" / "zeroops-server-check.php").exists())
        self.assertEqual((self.webroot / "local-private.txt").read_bytes(), b"preserve this untracked file\n")

    def test_php_validation_failure_blocks_publication(self):
        def invalid(body):
            raise RuntimeError("PHP syntax rejected")
        self.host.lint_php = invalid
        record = self.run_delivery()
        self.assertEqual(record["state"], "failed")
        self.assertEqual(self.host.deploys, [])
        self.assertIn("PHP syntax", record["message"])

    def test_changed_diagnostic_without_the_approved_digest_is_rejected(self):
        (self.seed / "adm" / "zeroops-server-check.php").write_bytes(b"<?php print_r($_SERVER);\n")
        git("add", ".", cwd=self.seed)
        git("commit", "-qm", "unsafe", cwd=self.seed)
        sha = git("rev-parse", "HEAD", cwd=self.seed)
        git("push", "-q", str(self.source), "qa", cwd=self.seed)
        record = self.run_delivery(sha=sha)
        self.assertEqual(record["state"], "failed")
        self.assertEqual(self.host.deploys, [])
        self.assertIn("Digest", record["message"])

    def test_new_symlink_is_rejected_before_touching_the_site(self):
        file = self.seed / "redirect"
        file.write_bytes(b"../outside")
        digest = git("hash-object", "-w", str(file), cwd=self.seed)
        git("update-index", "--add", "--cacheinfo", "120000," + digest + ",redirect", cwd=self.seed)
        git("commit", "-qm", "unsafe symlink", cwd=self.seed)
        sha = git("rev-parse", "HEAD", cwd=self.seed)
        git("push", "-q", str(self.source), "qa", cwd=self.seed)
        record = self.run_delivery(sha=sha, artifactDigest=self.host.archive_digest(str(self.source), sha))
        self.assertEqual(record["state"], "failed")
        self.assertIn("symlinks", record["message"])
        self.assertEqual(self.host.deploys, [])
        self.assertFalse(os.path.lexists(self.webroot / "redirect"))

    def test_configured_project_and_branch_are_used_for_the_entire_publication(self):
        branch = "quality-validation"
        git("branch", "-m", branch, cwd=self.seed)
        git("push", "-q", str(self.source), branch, cwd=self.seed)
        git("--git-dir", str(self.target), "branch", branch, self.base)
        self.host.site_git("branch", "-m", branch)
        config = site.SiteConfig(dict(self.env, ZEROOPS_ROLLOUT_TARGET_BRANCH=branch,
                                      ZEROOPS_ROLLOUT_ALLOWED_REFS=branch,
                                      ZEROOPS_SITE_PROJECT_ID="another-project",
                                      ZEROOPS_SITE_REPOSITORY_ID="another-repository"))
        self.host = FixtureHost(config)
        self.operator = site.SiteOperator(config, self.host, log=lambda event: None)
        record = self.run_delivery(ref=branch, ticket="unrelated-ticket")
        self.assertEqual(record["state"], "succeeded")
        self.assertEqual(self.host.identity(), self.sha)
        self.assertEqual(self.host.callbacks[-1]["sha"], self.sha)

    def http_host(self, checks):
        config = site.SiteConfig(dict(self.env, ZEROOPS_SITE_HTTP_CHECKS=json.dumps(checks)))
        return site.SiteHost(config)

    def response(self, status, body):
        response = io.BytesIO(body)
        response.status = status
        return response

    def test_http_verification_rejects_stale_served_bytes_even_with_the_right_git_sha(self):
        self.run_delivery()
        host = self.http_host([{"url": "https://site.example.invalid/zeroops-check.txt",
                                "artifactPath": "zeroops-check.txt"}])
        for body, healthy in ((MARKER, True), (b"previous cached content", False)):
            opener = Mock()
            opener.open.side_effect = [self.response(200, b"healthy"), self.response(200, body)]
            with patch.object(site.ssl, "create_default_context"), \
                    patch.object(site.urllib.request, "build_opener", return_value=opener):
                self.assertEqual(host.runtime(), (self.sha, healthy))
            self.assertEqual(opener.open.call_args[0][0].full_url,
                             "https://site.example.invalid/zeroops-check.txt")

    def test_protected_probe_rejects_exposed_server_keys_without_printing_the_response(self):
        self.run_delivery()
        host = self.http_host([{"url": "https://site.example.invalid/adm/zeroops-server-check.php",
                                "statuses": [200, 302], "forbiddenText": ["SERVER_NAME"]}])
        opener = Mock()
        opener.open.side_effect = [self.response(200, b"healthy"),
                                   self.response(200, b"SERVER_NAME: private-value")]
        output = io.StringIO()
        with patch.object(site.ssl, "create_default_context"), \
                patch.object(site.urllib.request, "build_opener", return_value=opener), \
                patch.object(sys, "stdout", output):
            self.assertEqual(host.runtime(), (self.sha, False))
        self.assertIn("site.health_failed", output.getvalue())
        self.assertNotIn("private-value", output.getvalue())

    def test_probe_rejects_redirects_and_urls_outside_the_configured_origin(self):
        self.run_delivery()
        host = self.http_host([{"url": "https://site.example.invalid/zeroops-check.txt",
                                "artifactPath": "zeroops-check.txt"}])
        opener = Mock()
        opener.open.side_effect = [self.response(200, b"healthy"), self.response(302, b"")]
        with patch.object(site.ssl, "create_default_context"), \
                patch.object(site.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(host.runtime(), (self.sha, False))
        self.assertIsNone(site.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid/"))
        with self.assertRaisesRegex(ValueError, "origem"):
            self.http_host([{"url": "https://other.invalid/marker", "artifactPath": "marker"}])

    def test_restart_reconciles_completed_publisher_without_repeating_git_merge(self):
        self.operator.submit(self.payload())
        record = self.operator.load(KEY)
        self.assertTrue(self.operator.verify(record))
        self.operator.transition(record, "deploying", previousVersion=self.base)
        self.host.publish(self.sha, KEY)
        restarted = site.SiteOperator(self.config, self.host, log=lambda event: None)
        restarted.recover()
        restarted.run(restarted.queue.get_nowait())
        self.assertEqual(restarted.load(KEY)["state"], "succeeded")
        self.assertEqual(self.host.deploys, [])

    def test_changed_binding_blocks_recovery_instead_of_redirecting_the_delivery(self):
        self.operator.submit(self.payload())
        config = site.SiteConfig(dict(self.env, ZEROOPS_SITE_REPOSITORY_ID="different-resource"))
        restarted = site.SiteOperator(config, FixtureHost(config), log=lambda event: None)
        restarted.run(KEY)
        self.assertEqual(restarted.load(KEY)["state"], "failed")
        self.assertEqual(self.host.identity(), self.base)
        self.assertEqual(restarted.submit(self.payload())[0], 409)

    def test_publisher_rechecks_the_accepted_binding_in_its_own_process(self):
        self.operator.submit(self.payload())
        record = self.operator.load(KEY)
        self.assertTrue(self.operator.verify(record))
        self.operator.transition(record, "deploying", previousVersion=self.base)
        config = site.SiteConfig(dict(self.env, ZEROOPS_SITE_REPOSITORY_ID="different-resource"))
        with self.assertRaisesRegex(RuntimeError, "binding"):
            FixtureHost(config).publish(self.sha, KEY)
        self.assertEqual(self.host.identity(), self.base)
        self.assertIsNone(self.host.journal(KEY))

    def test_aliases_of_the_same_webroot_share_the_canonical_lock(self):
        alias = os.path.join(self.tmp, "site", "..", "site")
        config = site.SiteConfig(dict(self.env, ZEROOPS_SITE_WEBROOT=alias))
        self.assertEqual(config.lock_path("queue"), self.config.lock_path("queue"))
        self.assertEqual(config.lock_path("publish"), self.config.lock_path("publish"))
        self.assertEqual(config.binding, self.config.binding)

    def test_cancellation_before_publication_and_restricted_environment(self):
        self.assertEqual(self.operator.submit(self.payload(environment="production"))[0], 403)
        self.operator.submit(self.payload())
        self.assertEqual(self.operator.cancel(KEY)[0], 202)
        self.operator.run(KEY)
        self.assertEqual(self.operator.load(KEY)["state"], "cancelled")
        self.assertEqual(self.host.deploys, [])

    def test_publication_requires_its_own_completed_journal_and_unchanged_backup(self):
        self.run_delivery()
        journal = self.host.journal(KEY)
        journal["phase"] = "prepared"
        self.host.save_journal(KEY, journal)
        self.assertFalse(self.host.evidence(KEY, self.sha))
        journal["phase"] = "complete"
        self.host.save_journal(KEY, journal)
        Path(journal["backup"]).write_bytes(b"damaged")
        self.assertFalse(self.host.evidence(KEY, self.sha))

    def test_head_alone_does_not_confirm_the_files_actually_served(self):
        self.run_delivery()
        (self.webroot / "adm" / "zeroops-server-check.php").write_bytes(b"tampered\n")
        self.assertEqual(self.host.identity(), self.sha)
        self.assertEqual(self.host.runtime(), (self.sha, False))


class GitCredentialTests(unittest.TestCase):
    def test_only_answers_for_the_exact_git_url_and_never_stores_credentials(self):
        env = {"ZEROOPS_SITE_GIT_URL": "https://github.com/example/site.git",
               "ZEROOPS_SITE_GIT_TOKEN": "fixture-only-token"}
        request = "protocol=https\nhost=github.com\npath=example/site.git\n\n"
        with patch.dict(os.environ, env), patch.object(sys, "argv", ["operator", "--git-credential", "get"]):
            output = io.StringIO()
            with patch.object(sys, "stdin", io.StringIO(request)), patch.object(sys, "stdout", output):
                self.assertEqual(site.git_credential(), 0)
            self.assertEqual(output.getvalue(), "username=x-access-token\npassword=fixture-only-token\n\n")
            for other in (request.replace("site.git", "other.git"), request.replace("https", "http")):
                output = io.StringIO()
                with patch.object(sys, "stdin", io.StringIO(other)), patch.object(sys, "stdout", output):
                    with self.assertRaisesRegex(ValueError, "binding"):
                        site.git_credential()
                self.assertEqual(output.getvalue(), "")
        for action in ("store", "erase"):
            output = io.StringIO()
            with patch.object(sys, "argv", ["operator", "--git-credential", action]), \
                    patch.object(sys, "stdout", output):
                self.assertEqual(site.git_credential(), 0)
            self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
