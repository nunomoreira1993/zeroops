#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.parse
from pathlib import Path

CRONTAB = Path("/var/lib/zeroops-health/installer/cron-plan.json")
ZONEINFO_ROOT = Path("/usr/share/zoneinfo")
STATE_ROOT = Path("/var/lib/zeroops-health")
TASKS_FILE = Path("/etc/zeroops-health/cron-tasks.tsv")
WRAPPER_FILE = Path("/opt/zeroops-health/zeroops-cron-wrapper.sh")
AGENT_FILE = Path("/opt/zeroops-health/zeroops-health-agent.sh")
ALLOWED_HOST = "backend.pizzahut.pt"
ALLOWED_PATHS = {
    "/cron/cron.php",
    "/pt/cron/payment_cron.php",
    "/pt/cron/fraud_detector/detector.php",
}
CRON_ACTIONS = {
    "archiveLogs",
    "archiveOrders",
    "captureOrdersShift4",
    "catOrdersReport",
    "chargeBackShift4",
    "cleanOldData",
    "cleanupSessions",
    "databaseHealthcheck",
    "db2SlowQueryReport",
    "deleteOldSequences",
    "deleteOldSlots",
    "deleteRestLog",
    "encryptSensitiveData",
    "generate3dsecure",
    "gestaoPeriodicidades",
    "instagram",
    "purgeTemporary",
    "scheduledOrders",
    "sendCartMail",
    "sendCuponCampaign",
    "sendQuestionnaire",
    "syncCampanhasRelatorios",
    "verifyApplePayCerts",
    "walletPayments",
}
MARKER = "/opt/zeroops-health/zeroops-cron-wrapper.sh"
PLAN_BACKUP_DIR = STATE_ROOT / "backups"
INSTALL_STATE = STATE_ROOT / "installer" / "latest-install.json"


class SafeError(Exception):
    pass


def file_hash(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def cron_fields(line: str):
    tokens = list(re.finditer(r"\S+", line))
    if len(tokens) < 6:
        return None
    return line[: tokens[5].start()], line[tokens[5].start() :].rstrip("\r\n")


def validate_cron_field(field: str, minimum: int, maximum: int):
    for part in field.split(","):
        if not part:
            return False
        range_part, slash, step = part.partition("/")
        if slash and (not step.isdigit() or int(step) < 1):
            return False
        if range_part == "*":
            continue
        bounds = range_part.split("-")
        if len(bounds) > 2 or not all(item.isdigit() for item in bounds):
            return False
        start = int(bounds[0])
        end = int(bounds[-1])
        if start < minimum or end > maximum or start > end:
            return False
    return True


def validate_schedule(schedule: str):
    fields = schedule.split()
    if len(fields) != 5:
        return False
    ranges = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
    return all(validate_cron_field(field, *bounds) for field, bounds in zip(fields, ranges))


def validate_time_zone(time_zone: str):
    if not re.fullmatch(r"[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*", time_zone):
        raise SafeError()
    root = ZONEINFO_ROOT.resolve()
    try:
        zone_file = (root / time_zone).resolve()
        zone_file.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        raise SafeError()
    if not zone_file.is_file():
        raise SafeError()


def task_name(url: urllib.parse.SplitResult):
    if url.path == "/pt/cron/payment_cron.php":
        return "Pizza Hut Shift4 payment cron"
    if url.path == "/pt/cron/fraud_detector/detector.php":
        return "Pizza Hut fraud detector"
    query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
    action = query.get("w", [""])[0]
    if action not in CRON_ACTIONS:
        raise SafeError()
    return f"Pizza Hut {action}"


def grace_for(schedule: str):
    minute, hour, _, _, _ = schedule.split()
    if minute == "*" or minute == "*/1":
        return 10
    match = re.fullmatch(r"\*/([0-9]+)", minute)
    if match:
        return 15 if int(match.group(1)) <= 5 else 30
    return 45


def identify(line: str, ordinal: int):
    fields = cron_fields(line)
    if not fields:
        return None
    prefix, command = fields
    if MARKER in command:
        return None
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        raise SafeError()
    urls = []
    for token in tokens:
        if token.startswith(("http://", "https://")):
            urls.append(urllib.parse.urlsplit(token))
    matched = [
        url
        for url in urls
        if url.scheme == "https"
        and url.hostname == ALLOWED_HOST
        and url.path in ALLOWED_PATHS
        and url.port in (None, 443)
    ]
    if not matched:
        return None
    if not tokens or tokens[0] != "curl":
        raise SafeError()
    if any(
        token == "-w"
        or token.startswith("-w")
        or token == "--stderr"
        or token.startswith("--stderr=")
        or token == "--next"
        or token == "--"
        or token == "--write-out"
        or token.startswith("--write-out=")
        for token in tokens
    ):
        raise SafeError()
    if len(matched) != 1 or len(urls) != 1 or matched[0].username or matched[0].password:
        raise SafeError()
    schedule = " ".join(re.findall(r"\S+", prefix)[-5:])
    if not validate_schedule(schedule):
        raise SafeError()
    name = task_name(matched[0])
    command_text = command
    for index, character in enumerate(command):
        if character == "%":
            slash_count = 0
            cursor = index - 1
            while cursor >= 0 and command[cursor] == "\\":
                slash_count += 1
                cursor -= 1
            if slash_count == 0:
                raise SafeError()
            if slash_count != 1:
                raise SafeError()
            command_text = command_text.replace(r"\%", "%")
    task_id = f"ph-root-http-{ordinal:03d}"
    return {
        "id": task_id,
        "name": name,
        "schedule": schedule,
        "graceMinutes": grace_for(schedule),
        "prefix": prefix,
        "command": command_text,
        "commandHash": file_hash(command.encode()),
    }


def collect_candidates(content: bytes):
    text = content.decode("utf-8")
    candidates = []
    name_counts = {}
    for line in text.splitlines(keepends=True):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        candidate = identify(line, len(candidates) + 1)
        if not candidate:
            continue
        name_counts[candidate["name"]] = name_counts.get(candidate["name"], 0) + 1
        if name_counts[candidate["name"]] > 1:
            candidate["name"] += f" #{name_counts[candidate['name']]}"
        candidates.append(candidate)
    return candidates


def escape_cron_percent(value: str):
    return value.replace("%", r"\%")


def wrapped_line(candidate: dict):
    wrapper = f"{shlex.quote(str(WRAPPER_FILE))} --id {candidate['id']} -- {shlex.quote(candidate['command'])}"
    return escape_cron_percent(candidate["prefix"] + wrapper) + "\n"


def current_crontab():
    result = subprocess.run(
        ["crontab", "-l"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False
    )
    if result.returncode not in (0, 1):
        raise SafeError()
    return result.stdout


def safe_write(path: Path, content: bytes, mode: int):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temp = path.with_name(path.name + f".tmp.{os.getpid()}")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def backup_file(path: Path, backup: Path):
    if path.exists():
        safe_write(backup, path.read_bytes(), 0o600)
        return True
    return False


def plan():
    content = current_crontab()
    candidates = collect_candidates(content)
    if not candidates:
        raise SafeError()
    plan_data = {
        "crontabSha256": file_hash(content),
        "entries": [
            {
                "id": item["id"],
                "name": item["name"],
                "schedule": item["schedule"],
                "graceMinutes": item["graceMinutes"],
                "commandHash": item["commandHash"],
            }
            for item in candidates
        ],
    }
    safe_write(CRONTAB, json.dumps(plan_data, separators=(",", ":")).encode(), 0o600)
    print(
        json.dumps(
            {
                "planned": len(candidates),
                "tasks": [
                    {key: item[key] for key in ("id", "name", "schedule", "graceMinutes")}
                    for item in candidates
                ],
            },
            ensure_ascii=False,
        )
    )


def check_curl_support():
    result = subprocess.run(
        ["curl", "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False
    )
    if result.returncode != 0:
        raise SafeError()
    match = re.search(rb"curl\s+([0-9]+)\.([0-9]+)\.([0-9]+)", result.stdout)
    if not match:
        raise SafeError()
    version = tuple(map(int, match.groups()))
    if version < (7, 63, 0):
        raise SafeError()
    if subprocess.run(
        ["flock", "--help"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
    ).returncode != 0:
        raise SafeError()


def apply(wrapper_source: Path, agent_source: Path, time_zone: str):
    check_curl_support()
    if not wrapper_source.is_file() or not agent_source.is_file():
        raise SafeError()
    validate_time_zone(time_zone)
    plan_data = json.loads(CRONTAB.read_text(encoding="utf-8"))
    content = current_crontab()
    if file_hash(content) != plan_data.get("crontabSha256"):
        raise SafeError()
    candidates = collect_candidates(content)
    current_entries = [
        {
            "id": item["id"],
            "name": item["name"],
            "schedule": item["schedule"],
            "graceMinutes": item["graceMinutes"],
            "commandHash": item["commandHash"],
        }
        for item in candidates
    ]
    if current_entries != plan_data.get("entries"):
        raise SafeError()

    activation = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    old_crontab = content
    old_tasks = TASKS_FILE.read_bytes() if TASKS_FILE.exists() else None
    old_wrapper = WRAPPER_FILE.read_bytes() if WRAPPER_FILE.exists() else None
    old_agent = AGENT_FILE.read_bytes() if AGENT_FILE.exists() else None
    backup_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}"
    PLAN_BACKUP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(PLAN_BACKUP_DIR, 0o700)
    cron_backup = PLAN_BACKUP_DIR / f"root-crontab.{backup_id}"
    config_backup = PLAN_BACKUP_DIR / f"cron-tasks.{backup_id}"
    wrapper_backup = PLAN_BACKUP_DIR / f"cron-wrapper.{backup_id}"
    agent_backup = PLAN_BACKUP_DIR / f"health-agent.{backup_id}"
    safe_write(cron_backup, old_crontab, 0o600)
    had_tasks = backup_file(TASKS_FILE, config_backup)
    had_wrapper = backup_file(WRAPPER_FILE, wrapper_backup)
    had_agent = backup_file(AGENT_FILE, agent_backup)
    prior_install = INSTALL_STATE.read_bytes() if INSTALL_STATE.exists() else None

    existing_ids = set()
    if old_tasks:
        for line in old_tasks.decode("utf-8").splitlines():
            if line and not line.startswith("#"):
                existing_ids.add(line.split("|", 1)[0])
    if existing_ids.intersection(item["id"] for item in candidates):
        raise SafeError()

    task_lines = [
        "|".join(
            (
                item["id"],
                item["name"],
                item["schedule"],
                time_zone,
                str(item["graceMinutes"]),
                activation,
            )
        )
        for item in candidates
    ]
    if old_tasks:
        task_lines = old_tasks.decode("utf-8").splitlines() + task_lines
    new_tasks = ("\n".join(task_lines) + "\n").encode()
    new_crontab = bytearray()
    target_index = 0
    for line in content.decode("utf-8").splitlines(keepends=True):
        candidate = identify(line, target_index + 1)
        if candidate:
            expected = candidates[target_index]
            if candidate["commandHash"] != expected["commandHash"]:
                raise SafeError()
            new_crontab.extend(wrapped_line(candidate).encode())
            target_index += 1
        else:
            new_crontab.extend(line.encode())
    if target_index != len(candidates):
        raise SafeError()

    try:
        safe_write(WRAPPER_FILE, wrapper_source.read_bytes().replace(b"\r\n", b"\n"), 0o750)
        safe_write(AGENT_FILE, agent_source.read_bytes().replace(b"\r\n", b"\n"), 0o750)
        safe_write(TASKS_FILE, new_tasks, 0o600)
        os.chmod(WRAPPER_FILE, 0o750)
        os.chmod(AGENT_FILE, 0o750)
        os.chmod(TASKS_FILE, 0o600)
        result = subprocess.run(
            ["crontab", "-"],
            input=bytes(new_crontab),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            raise SafeError()
        applied = current_crontab()
        ids = re.findall(rb"zeroops-cron-wrapper\.sh --id (ph-root-http-[0-9]{3}) --", applied)
        if len(ids) != len(candidates):
            raise SafeError()
        install_data = {
            "backupId": backup_id,
            "cronBackup": str(cron_backup),
            "tasksBackup": str(config_backup) if had_tasks else None,
            "wrapperBackup": str(wrapper_backup) if had_wrapper else None,
            "agentBackup": str(agent_backup) if had_agent else None,
            "hadTasks": had_tasks,
            "hadWrapper": had_wrapper,
            "hadAgent": had_agent,
            "appliedCrontabSha256": file_hash(applied),
        }
        safe_write(INSTALL_STATE, json.dumps(install_data).encode(), 0o600)
    except Exception:
        restore_crontab(old_crontab)
        restore_file(TASKS_FILE, old_tasks)
        restore_file(WRAPPER_FILE, old_wrapper)
        restore_file(AGENT_FILE, old_agent)
        restore_file(INSTALL_STATE, prior_install)
        raise SafeError()
    print(json.dumps({"installed": len(candidates), "backupId": backup_id}))


def restore_crontab(content: bytes):
    subprocess.run(
        ["crontab", "-"], input=content, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


def restore_file(path: Path, content):
    if content is None:
        path.unlink(missing_ok=True)
    else:
        executable = path in (WRAPPER_FILE, AGENT_FILE)
        safe_write(path, content, 0o750 if executable else 0o600)


def rollback(backup_id: str):
    install_data = json.loads(INSTALL_STATE.read_text(encoding="utf-8"))
    if install_data.get("backupId") != backup_id:
        raise SafeError()
    current = current_crontab()
    if file_hash(current) != install_data.get("appliedCrontabSha256"):
        raise SafeError()
    cron_backup = Path(install_data["cronBackup"])
    restore_crontab(cron_backup.read_bytes())
    if install_data.get("hadTasks"):
        restore_file(TASKS_FILE, Path(install_data["tasksBackup"]).read_bytes())
    else:
        TASKS_FILE.unlink(missing_ok=True)
    if install_data.get("hadWrapper"):
        restore_file(WRAPPER_FILE, Path(install_data["wrapperBackup"]).read_bytes())
    else:
        WRAPPER_FILE.unlink(missing_ok=True)
    if install_data.get("hadAgent"):
        restore_file(AGENT_FILE, Path(install_data["agentBackup"]).read_bytes())
    else:
        AGENT_FILE.unlink(missing_ok=True)
    INSTALL_STATE.unlink(missing_ok=True)
    print(json.dumps({"rolledBack": True, "backupId": backup_id}))


def main():
    parser = argparse.ArgumentParser(description="Instrumenta apenas crons HTTP Pizza Hut do root.")
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--plan", action="store_true")
    actions.add_argument("--apply", action="store_true")
    actions.add_argument("--rollback")
    parser.add_argument("--wrapper-source", type=Path)
    parser.add_argument("--agent-source", type=Path)
    parser.add_argument("--time-zone", default="Europe/Lisbon")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SafeError()
    if args.plan:
        plan()
    elif args.apply:
        if not args.wrapper_source or not args.agent_source:
            raise SafeError()
        apply(args.wrapper_source, args.agent_source, args.time_zone)
    else:
        rollback(args.rollback)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Cron heartbeat operation failed; no command or credential data was displayed.", file=sys.stderr)
        sys.exit(1)
