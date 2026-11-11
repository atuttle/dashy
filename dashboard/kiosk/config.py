#!/usr/bin/env python3
"""Create and stream Dashy's private JSON configuration over USB; never print values."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

DASHBOARD = Path(__file__).resolve().parents[1]
REPO = DASHBOARD.parent
DEFAULT_CONFIG = DASHBOARD / "config.local.json"
AUTHORITY = "content://com.wesbos.homehq.config"
MAX_BYTES = 65536
FEEDS = (
    ("dad-personal", "dad", "Dad personal", "ICAL_DAD_PERSONAL_URL"),
    ("dad-work", "dad", "Dad work", "ICAL_DAD_WORK_URL"),
    ("mom", "mom", "Mom", "ICAL_MOM_URL"),
    ("kiddo", "kiddo", "Kiddo", "ICAL_KIDDO_URL"),
    ("family", "family", "Family", "ICAL_FAMILY_URL"),
)


class ConfigError(Exception):
    pass


def validate(payload):
    try:
        if not 0 < len(payload) <= MAX_BYTES:
            raise ValueError()
        config = json.loads(payload.decode("utf-8"))
        if type(config["version"]) is not int or config["version"] != 1 or not isinstance(config["calendars"], list):
            raise ValueError()
        if len(config["calendars"]) > 32:
            raise ValueError()
        ids = set()
        for feed in config["calendars"]:
            if not isinstance(feed["id"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", feed["id"]):
                raise ValueError()
            if feed["id"] in ids or feed["calendar"] not in {"dad", "mom", "kiddo", "family"}:
                raise ValueError()
            ids.add(feed["id"])
            value = feed["url"]
            if not isinstance(value, str) or not value or len(value) > 4096 or any(c.isspace() for c in value):
                raise ValueError()
            url = urlsplit(value)
            if url.scheme != "https" or not url.hostname or url.username is not None or url.fragment:
                raise ValueError()
        if "weather" in config:
            weather = config["weather"]
            if not isinstance(weather["apiKey"], str) or not weather["apiKey"].strip() or len(weather["apiKey"]) > 4096:
                raise ValueError()
            for name, limit in (("latitude", 90), ("longitude", 180)):
                value = weather[name]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > limit:
                    raise ValueError()
            if weather["units"] != "us":
                raise ValueError()
        if "travel" in config:
            travel = config["travel"]
            if travel["provider"] != "tomtom":
                raise ValueError()
            for field, limit in (("homeAddress", 1024), ("apiKey", 4096)):
                value = travel[field]
                if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 for c in value):
                    raise ValueError()
        if "photos" in config:
            value = config["photos"]["albumUrl"]
            if not isinstance(value, str) or len(value) > 4096 or any(c.isspace() for c in value):
                raise ValueError()
            url = urlsplit(value)
            if url.scheme != "https" or url.port not in (None, 443) or url.username is not None or url.fragment:
                raise ValueError()
            if url.hostname == "photos.app.goo.gl":
                if not re.fullmatch(r"/[A-Za-z0-9_-]+/?", url.path):
                    raise ValueError()
            elif url.hostname == "photos.google.com":
                from urllib.parse import parse_qs
                if not re.fullmatch(r"/share/[A-Za-z0-9_-]+/?", url.path) or not re.fullmatch(r"[A-Za-z0-9_-]+", parse_qs(url.query).get("key", [""])[0]):
                    raise ValueError()
            else:
                raise ValueError()
        if "countdowns" in config:
            value = config["countdowns"]["url"]
            if not isinstance(value, str) or not value or len(value) > 4096 or any(c.isspace() for c in value):
                raise ValueError()
            url = urlsplit(value)
            if url.scheme != "https" or not url.hostname or url.username is not None or url.fragment:
                raise ValueError()
        return config
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ConfigError("Invalid configuration. Check the format against config.example.json.") from None


def read_env(path):
    result = {}
    try:
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            value = value.strip()
            if value.startswith('"'):
                value = json.loads(value)
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1]
            result[name.strip()] = value
        return result
    except (ValueError, OSError):
        raise ConfigError("Could not read the local environment file.") from None


def create_config(env_path, output, force=False):
    if output.exists() and not force:
        raise ConfigError("Config already exists. Use --force to replace it.")
    env = read_env(env_path)
    missing = [name for name in ["PIRATE_WEATHER_API_KEY", *(feed[3] for feed in FEEDS)] if not env.get(name)]
    if missing:
        raise ConfigError("Missing local settings: " + ", ".join(missing))
    config = {
        "version": 1,
        "weather": {"apiKey": env["PIRATE_WEATHER_API_KEY"], "latitude": 40.7128, "longitude": -74.006, "units": "us"},
        "calendars": [{"id": id_, "calendar": owner, "name": name, "url": env[key]} for id_, owner, name, key in FEEDS],
    }
    if env.get("GOOGLE_PHOTOS_ALBUM_URL"):
        config["photos"] = {"albumUrl": env["GOOGLE_PHOTOS_ALBUM_URL"]}
    if env.get("DASHY_HOME_ADDRESS") or env.get("TOMTOM_API_KEY"):
        config["travel"] = {"provider": "tomtom", "homeAddress": env.get("DASHY_HOME_ADDRESS", ""), "apiKey": env.get("TOMTOM_API_KEY", "")}
    if env.get("ICAL_COUNTDOWNS_URL"):
        config["countdowns"] = {"url": env["ICAL_COUNTDOWNS_URL"]}
    payload = (json.dumps(config, indent=2) + "\n").encode("utf-8")
    validate(payload)
    # The temporary name is ignored by Git and denied by Vite too, even if interrupted.
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".env.config-", delete=False) as file:
            temp = Path(file.name)
            os.chmod(temp, 0o600)
            file.write(payload)
        os.replace(temp, output)
    finally:
        if temp is not None and temp.exists():
            temp.unlink()
    print(f"Created {output} (5 calendar feeds, weather key, photo album {'configured' if 'photos' in config else 'not configured'}, travel {'configured' if 'travel' in config else 'not configured'}; owner-only permissions).")
    print("Countdown calendar: " + ("configured" if "countdowns" in config else "not configured"))


def adb_command(args):
    binary = args.adb or shutil.which("adb") or str(REPO / "diagnostics/tools/platform-tools/adb")
    if not Path(binary).is_file():
        raise ConfigError("ADB was not found. Supply --adb /path/to/adb.")
    return [binary, "-s", args.serial] if args.serial else [binary, "-d"]


def device_status(adb):
    result = subprocess.run(adb + ["shell", "content", "query", "--uri", AUTHORITY + "/status"],
                            capture_output=True, timeout=8, check=False)
    # Provider fields are deliberately limited to counts, booleans, and a verification digest.
    values = dict(re.findall(r"\b([a-z_0-9]+)=([^,\r\n]*)", result.stdout.decode("utf-8", "replace")))
    if result.returncode or "configured" not in values:
        raise ConfigError("Could not read status. Check USB authorization and that the updated Home HQ is installed.")
    return {key: value.strip() for key, value in values.items()}


def import_config(adb, path):
    try:
        payload = path.read_bytes()
    except OSError:
        raise ConfigError("Could not read the config file.") from None
    config = validate(payload)
    expected = hashlib.sha256(payload).hexdigest()
    result = subprocess.run(adb + ["shell", "content", "write", "--uri", AUTHORITY + "/import"],
                            input=payload, capture_output=True, timeout=20, check=False)
    if result.returncode:
        raise ConfigError("USB import failed. Check that the updated Home HQ is installed.")
    deadline = time.monotonic() + 15
    while True:
        status = device_status(adb)
        if status.get("last_import") == "error":
            raise ConfigError("The frame rejected the import; the previous configuration was preserved.")
        if status.get("last_import") == "ok" and status.get("sha256") == expected:
            if status.get("calendar_count") != str(len(config["calendars"])):
                raise ConfigError("The imported calendar count did not match.")
            print(f"Imported and verified {len(config['calendars'])} calendar feeds in app-private storage.")
            print("Photo album: " + ("configured" if "photos" in config else "not configured"))
            print("Travel estimates: " + ("configured" if "travel" in config else "not configured"))
            print("Countdown calendar: " + ("configured" if "countdowns" in config else "not configured"))
            print("No temporary secrets file was created on the frame.")
            return
        if time.monotonic() >= deadline:
            raise ConfigError("Import verification timed out. Run the status command before retrying.")
        time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["create", "import", "status"])
    parser.add_argument("--file", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--env", type=Path, default=DASHBOARD / ".env.local")
    parser.add_argument("--force", action="store_true", help="Allow create to replace an existing local JSON file")
    parser.add_argument("--adb")
    parser.add_argument("--serial", help="Choose a device; default selects the single USB-connected device")
    args = parser.parse_args()
    try:
        if args.command == "create":
            create_config(args.env, args.file, args.force)
        elif args.command == "import":
            import_config(adb_command(args), args.file)
        else:
            status = device_status(adb_command(args))
            print("Configuration: " + ("saved" if status["configured"] == "1" else "not imported"))
            print("Calendar feeds: " + status.get("calendar_count", "0"))
            print("Weather key: " + ("configured" if status.get("weather_configured") == "1" else "not configured"))
            print("Photo album: " + ({"1": "configured", "0": "not configured"}.get(status.get("photos_configured"), "status unavailable on this app version")))
            print("Travel estimates: " + ({"1": "configured", "0": "not configured"}.get(status.get("travel_configured"), "status unavailable on this app version")))
            print("Countdown calendar: " + ({"1": "configured", "0": "not configured"}.get(status.get("countdowns_configured"), "status unavailable on this app version")))
            print("Last import: " + status.get("last_import", "unknown"))
            print("Loaded by dashboard at startup: " + ("yes" if status.get("loaded_at_startup") == "1" else "not yet"))
    except ConfigError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError):
        print("USB/config command failed; no secret values are included in this error.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
