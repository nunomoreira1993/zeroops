"""Drenagem do deploy-from-git.sh com o host simulado (comandos falsos no PATH; bash real)."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "deploy" / "qa" / "deploy-from-git.sh"
SHA = "0123456789abcdef0123456789abcdef01234567"


def find_bash():
    if os.name != "nt":
        return shutil.which("bash"), None
    # No Windows o bash.exe do PATH e o do WSL; usa o do Git for Windows sem o wrapper de bin/ (que poe
    # /usr/bin a frente dos comandos falsos).
    try:
        exec_path = subprocess.run(["git", "--exec-path"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None, None
    usr_bin = Path(exec_path.strip()).parents[2] / "usr" / "bin"
    candidate = usr_bin / "bash.exe"
    return (str(candidate), str(usr_bin)) if candidate.exists() else (None, None)


BASH, BASH_UTILS = find_bash()


def bash_path(path):
    path = str(Path(path).resolve())
    if os.name == "nt":
        drive, rest = os.path.splitdrive(path)
        return "/" + drive.rstrip(":").lower() + rest.replace("\\", "/")
    return path


FAKES = {
    "hostname": "echo qa-test-host\n",
    "flock": "exit 0\n",
    "sleep": "exit 0\n",
    "git": 'tar -c -C "$FAKE_SRC" .\n',
    "mysql": r"""
query="${!#}"
case "$query" in
  *information_schema.views*) echo "${FAKE_VIEW:-0}" ;;
  *information_schema.tables*) printf '%s\n' agent_runs flow_assistant_requests ticket_routing_jobs flow_simulation_runs delivery_runs ;;
  *"INSERT INTO zeroops_runtime_drains"*)
    [ "${FAKE_DRAIN_TABLE:-0}" = 1 ] || exit 1
    echo "drain-insert" >>"$FAKE_STATE/events" ;;
  *"UPDATE zeroops_runtime_drains"*) echo "drain-release" >>"$FAKE_STATE/events" ;;
  SELECT*)
    printf '%s\n' "$query" >>"$FAKE_STATE/count-queries"
    file="$FAKE_STATE/counts"
    [ -f "$FAKE_STATE/executor-stopped" ] && file="$FAKE_STATE/counts-after-stop"
    value=$(head -n 1 "$file")
    [ "$(wc -l <"$file")" -gt 1 ] && sed -i 1d "$file"
    echo "count $value" >>"$FAKE_STATE/events"
    echo "$value" ;;
esac
""",
    "mysqldump": 'echo backup >>"$FAKE_STATE/events"\n[ "${FAKE_DUMP_FAIL:-0}" = 1 ] && exit 1\necho "-- dump"\n',
    "docker": r"""
echo "docker $*" >>"$FAKE_STATE/docker.log"
case "$*" in
  "compose ps -q executor") [ -f "$FAKE_STATE/executor-stopped" ] || echo executor-container ;;
  "compose stop executor") touch "$FAKE_STATE/executor-stopped"; echo "executor-stop" >>"$FAKE_STATE/events" ;;
  "compose start executor") rm -f "$FAKE_STATE/executor-stopped"; echo "executor-start" >>"$FAKE_STATE/events" ;;
  "compose run"*) echo migrate >>"$FAKE_STATE/events" ;;
  "compose up -d api worker connectors executor") rm -f "$FAKE_STATE/executor-stopped"; echo "up" >>"$FAKE_STATE/events" ;;
  "image inspect"*) exit 1 ;;
esac
exit 0
""",
    "curl": 'case "$*" in *4311*) printf \'{"version":"%s"}\' "$FAKE_SHA" ;; esac\nexit 0\n',
}
if os.name == "nt":
    # NTFS (Git Bash) nao aceita os modos do install -d -m; no Linux usa-se o install real.
    FAKES["install"] = 'while [ $# -gt 0 ]; do case "$1" in -d) ;; -m) shift ;; *) mkdir -p "$1" ;; esac; shift; done\n'


@unittest.skipUnless(BASH, "bash indisponivel")
class DeployDrainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="zo-deploy-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = self.tmp / "state"
        self.state.mkdir()
        fakebin = self.tmp / "bin"
        fakebin.mkdir()
        for name, body in FAKES.items():
            target = fakebin / name
            target.write_bytes(("#!/usr/bin/env bash\n" + body).encode())
            target.chmod(0o755)
        source = self.tmp / "commit"
        (source / "deploy" / "docker").mkdir(parents=True)
        (source / "deploy" / "qa").mkdir(parents=True)
        (source / "deploy" / "docker" / "compose.yml").write_text("name: zeroops\n")
        self.base = self.tmp / "base"
        (self.base / "src" / "deploy" / "docker").mkdir(parents=True)
        (self.base / "src" / "deploy" / "qa").mkdir(parents=True)
        (self.base / "src" / "deploy" / "qa" / "VERSION").write_text("old\n")
        cnf = self.tmp / "db.cnf"
        cnf.write_text("[client]\nuser=zeroops\ndatabase=zeroops\n")
        self.env = dict(os.environ)
        self.env.update({
            "PATH": os.pathsep.join(filter(None, [str(fakebin), BASH_UTILS, self.env.get("PATH", "")])),
            "FAKE_STATE": bash_path(self.state),
            "FAKE_SRC": bash_path(source),
            "FAKE_SHA": SHA,
            "ZEROOPS_EXPECTED_HOST": "qa-test-host",
            "ZEROOPS_REPO": bash_path(self.tmp / "repo.git"),
            "ZEROOPS_BASE": bash_path(self.base),
            "ZEROOPS_DEPLOY_LOG": bash_path(self.tmp / "log" / "deploy.log"),
            "ZEROOPS_BACKUP_DIR": bash_path(self.tmp / "backups"),
            "ZEROOPS_DB_CNF": bash_path(cnf),
            "ZEROOPS_DEPLOY_LOCK": bash_path(self.tmp / "deploy.lock"),
            "ZEROOPS_OBSERVABILITY_ETC": bash_path(self.tmp / "observability"),
            "ZEROOPS_DRAIN_WAIT_SECONDS": "10",
        })

    def deploy(self, counts, counts_after_stop=("0",), **fake):
        (self.state / "counts").write_bytes(("\n".join(counts) + "\n").encode())
        (self.state / "counts-after-stop").write_bytes(("\n".join(counts_after_stop) + "\n").encode())
        env = dict(self.env, **{"FAKE_" + key.upper(): value for key, value in fake.items()})
        result = subprocess.run([BASH, bash_path(SCRIPT), SHA], env=env, capture_output=True, text=True,
                                timeout=120)
        events = (self.state / "events").read_text().split() if (self.state / "events").exists() else []
        return result, events

    def log(self):
        return (self.tmp / "log" / "deploy.log").read_text()

    def deployed_version(self):
        return (self.base / "src" / "deploy" / "qa" / "VERSION").read_text().strip()

    def test_bootstrap_without_drain_table_waits_and_stops_executor_before_changes(self):
        result, events = self.deploy(["2", "1", "0"])

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Drenagem de arranque", self.log())
        self.assertNotIn("segue sem drenagem", self.log())
        stop = events.index("executor-stop")
        self.assertEqual(events[:stop], ["count", "2", "count", "1", "count", "0"])
        self.assertLess(stop, events.index("backup"))
        self.assertLess(events.index("backup"), events.index("migrate"))
        self.assertNotIn("executor-start", events)
        self.assertEqual(events[-1], "up")
        queries = (self.state / "count-queries").read_text()
        self.assertIn("FROM delivery_runs WHERE worker_id IS NOT NULL AND lease_until > NOW(3)", queries)
        self.assertIn("FROM agent_runs WHERE status='running' AND lease_until > NOW(3)", queries)
        self.assertEqual(self.deployed_version(), SHA)

    def test_drain_table_uses_view_and_releases_after_health(self):
        result, events = self.deploy(["1", "0"], view="1", drain_table="1")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("SELECT COUNT(*) FROM zeroops_active_jobs", (self.state / "count-queries").read_text())
        self.assertLess(events.index("drain-insert"), events.index("executor-stop"))
        self.assertLess(events.index("up"), events.index("drain-release"))
        self.assertEqual(events.count("drain-release"), 1)

    def test_drain_timeout_changes_nothing_and_keeps_executor_running(self):
        result, events = self.deploy(["1"], view="1", drain_table="1")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("drenagem expirou com 1 job(s) ativos; nada foi alterado", self.log())
        self.assertNotIn("executor-stop", events)
        self.assertNotIn("backup", events)
        self.assertIn("drain-release", events)
        self.assertEqual(self.deployed_version(), "old")

    def test_failure_before_swap_restarts_previous_executor(self):
        result, events = self.deploy(["0"], dump_fail="1")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backup falhou", self.log())
        self.assertLess(events.index("executor-stop"), events.index("executor-start"))
        self.assertNotIn("migrate", events)
        self.assertEqual(self.deployed_version(), "old")

    def test_jobs_still_leased_after_stop_abort_and_restart_executor(self):
        result, events = self.deploy(["0"], counts_after_stop=("1",))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("apos a paragem do executor: drenagem expirou", self.log())
        self.assertIn("executor-start", events)
        self.assertNotIn("backup", events)
        self.assertEqual(self.deployed_version(), "old")

    def test_migration_failure_rolls_back_and_starts_previous_version(self):
        (self.base / "src" / "marker").write_text("old")
        # O executor arranca pelo rollback (compose up), nao pelo trap.
        fake_docker = self.tmp / "bin" / "docker"
        fake_docker.write_bytes(fake_docker.read_bytes().replace(
            b'"compose run"*) echo migrate >>"$FAKE_STATE/events" ;;',
            b'"compose run"*) echo migrate >>"$FAKE_STATE/events"; exit 1 ;;'))

        result, events = self.deploy(["0"])

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("migracao falhou (codigo e imagens repostos", self.log())
        self.assertEqual(events[-1], "up")
        self.assertNotIn("executor-start", events)
        self.assertEqual(self.deployed_version(), "old")
        self.assertTrue((self.base / "src" / "marker").exists())


if __name__ == "__main__":
    unittest.main()
