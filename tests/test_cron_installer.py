import importlib.util
import shlex
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "deploy" / "health-agent" / "install-cron-heartbeats.py"
SPEC = importlib.util.spec_from_file_location("cron_installer", MODULE_PATH)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class CronInstallerTests(unittest.TestCase):
    def test_selects_only_allowed_pizzahut_http_jobs_and_keeps_duplicates(self):
        source = (
            "0 8 * * * curl -fsS 'https://backend.pizzahut.pt/cron/cron.php?w=sendCartMail' >/dev/null 2>&1\n"
            "0 8 * * * curl -fsS 'https://backend.pizzahut.pt/cron/cron.php?w=sendCartMail' >/dev/null 2>&1\n"
            "*/2 * * * * curl -fsS 'https://backend.pizzahut.pt/pt/cron/payment_cron.php' >/dev/null 2>&1\n"
            "*/5 * * * * curl -fsS 'https://other.example.test/cron.php' >/dev/null 2>&1\n"
            "# leave comments intact\n"
        ).encode()

        candidates = installer.collect_candidates(source)

        self.assertEqual(len(candidates), 3)
        self.assertEqual([task["id"] for task in candidates], [
            "ph-root-http-001",
            "ph-root-http-002",
            "ph-root-http-003",
        ])
        self.assertEqual(candidates[1]["name"], "Pizza Hut sendCartMail #2")
        self.assertEqual(candidates[0]["schedule"], "0 8 * * *")
        self.assertEqual(candidates[2]["name"], "Pizza Hut Shift4 payment cron")

    def test_wrapper_keeps_original_command_and_redirections(self):
        line = (
            "*/10 0-5,11-23 * * * curl -sS 'https://backend.pizzahut.pt/cron/cron.php?w=sendCartMail' "
            ">/dev/null 2>&1\n"
        )
        task = installer.identify(line, 1)

        transformed = installer.wrapped_line(task)
        command = installer.cron_fields(transformed)[1]
        tokens = shlex.split(command)

        self.assertEqual(tokens[:3], [str(installer.WRAPPER_FILE), "--id", "ph-root-http-001"])
        self.assertEqual(tokens[3], "--")
        self.assertEqual(tokens[4], task["command"])
        self.assertIn(">/dev/null 2>&1", tokens[4])

    def test_rejects_http_options_that_conflict_with_status_capture(self):
        line = (
            "*/2 * * * * curl --write-out '%{http_code}' "
            "'https://backend.pizzahut.pt/pt/cron/payment_cron.php'\n"
        )
        with self.assertRaises(installer.SafeError):
            installer.identify(line, 1)

    def test_rejects_invalid_or_unescaped_cron_percent(self):
        line = (
            "*/2 * * * * curl 'https://backend.pizzahut.pt/cron/cron.php?w=sendCartMail%20x'\n"
        )
        with self.assertRaises(installer.SafeError):
            installer.identify(line, 1)

    def test_rejects_unsafe_time_zone_paths(self):
        for value in ("../etc/passwd", "/etc/localtime", "Europe/Lisbon\n"):
            with self.subTest(value=value), self.assertRaises(installer.SafeError):
                installer.validate_time_zone(value)


if __name__ == "__main__":
    unittest.main()
