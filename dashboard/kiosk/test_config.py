import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("dashy_config", Path(__file__).with_name("config.py"))
config_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config_tool)
EXAMPLE = Path(__file__).resolve().parents[1] / "config.example.json"


class ConfigTests(unittest.TestCase):
    def test_example_and_owner_mapping(self):
        config = config_tool.validate(EXAMPLE.read_bytes())
        self.assertEqual([feed["calendar"] for feed in config["calendars"]], ["dad", "dad", "mom", "kiddo", "family"])

    def test_invalid_inputs_have_redacted_errors(self):
        config = json.loads(EXAMPLE.read_text())
        bad = []
        bad.append(b'{"secret":"do-not-print-this"')
        bad.append(b"x" * (config_tool.MAX_BYTES + 1))
        for change in (
            lambda c: c.update(version=99),
            lambda c: c["calendars"][0].update(url="http://example.com/do-not-print-this"),
            lambda c: c["calendars"][0].update(url="https://user:do-not-print-this@example.com/feed"),
            lambda c: c["calendars"][1].update(id="dad-personal"),
            lambda c: c["calendars"][0].update(calendar="unknown"),
            lambda c: c["weather"].update(latitude=91),
            lambda c: c["weather"].update(apiKey=""),
        ):
            altered = json.loads(json.dumps(config))
            change(altered)
            bad.append(json.dumps(altered).encode())
        for payload in bad:
            with self.subTest(size=len(payload)):
                with self.assertRaises(config_tool.ConfigError) as error:
                    config_tool.validate(payload)
                self.assertNotIn("do-not-print-this", str(error.exception))

    def test_generation_is_private_and_never_prints_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env, output = root / ".env.local", root / "config.json"
            values = {key: json.dumps("https://example.com/secret-" + id_ + ".ics") for id_, _, _, key in config_tool.FEEDS}
            values["PIRATE_WEATHER_API_KEY"] = "secret-weather-key"
            values.update({"DASHY_WEATHER_LATITUDE": "40.7128", "DASHY_WEATHER_LONGITUDE": "-74.0060"})
            values["TOMTOM_API_KEY"] = "secret-tomtom-key"
            values["DASHY_HOME_ADDRESS"] = "123 Example Street, New York, NY 10001"
            values["ICAL_COUNTDOWNS_URL"] = "https://example.com/secret-countdowns.ics"
            env.write_text("\n".join(key + "=" + value for key, value in values.items()))
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                config_tool.create_config(env, output)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            generated = config_tool.validate(output.read_bytes())
            self.assertEqual(len(generated["calendars"]), 5)
            self.assertEqual(generated["weather"]["apiKey"], "secret-weather-key")
            self.assertEqual(generated["travel"]["apiKey"], "secret-tomtom-key")
            self.assertEqual(generated["travel"]["homeAddress"], values["DASHY_HOME_ADDRESS"])
            self.assertEqual(generated["countdowns"]["url"], values["ICAL_COUNTDOWNS_URL"])
            self.assertNotIn("secret-", captured.getvalue())
            self.assertEqual(list(root.glob(".env.config-*")), [])
            original = output.read_bytes()
            with self.assertRaises(config_tool.ConfigError):
                config_tool.create_config(env, output)
            self.assertEqual(output.read_bytes(), original)

    def test_invalid_replacement_preserves_local_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env, output = root / ".env.local", root / "config.json"
            output.write_bytes(EXAMPLE.read_bytes())
            values = {key: "https://example.com/" + id_ + ".ics" for id_, _, _, key in config_tool.FEEDS}
            values["PIRATE_WEATHER_API_KEY"] = "secret-weather-key"
            values.update({"DASHY_WEATHER_LATITUDE": "40.7128", "DASHY_WEATHER_LONGITUDE": "-74.0060"})
            values["ICAL_FAMILY_URL"] = "not-a-url"
            env.write_text("\n".join(key + "=" + value for key, value in values.items()))
            original = output.read_bytes()
            with self.assertRaises(config_tool.ConfigError):
                config_tool.create_config(env, output, force=True)
            self.assertEqual(output.read_bytes(), original)

    def test_photo_album_links_are_optional_and_restricted_to_google_shares(self):
        config = json.loads(EXAMPLE.read_text())
        for url in ("https://photos.app.goo.gl/example", "https://photos.google.com/share/album?key=secret"):
            config["photos"] = {"albumUrl": url}
            self.assertIn("photos", config_tool.validate(json.dumps(config).encode()))
        for url in ("https://evil.example/secret", "https://photos.google.com/album/private", "http://photos.app.goo.gl/secret"):
            config["photos"] = {"albumUrl": url}
            with self.assertRaises(config_tool.ConfigError):
                config_tool.validate(json.dumps(config).encode())

    def test_travel_is_optional_and_requires_a_provider_address_and_key(self):
        config = json.loads(EXAMPLE.read_text())
        self.assertIn('travel', config_tool.validate(json.dumps(config).encode()))
        for field, value in [('provider', 'unknown'), ('homeAddress', ''), ('apiKey', ''), ('homeAddress', 'secret\naddress')]:
            altered = json.loads(json.dumps(config))
            altered['travel'][field] = value
            with self.assertRaises(config_tool.ConfigError) as error:
                config_tool.validate(json.dumps(altered).encode())
            self.assertNotIn('secret', str(error.exception))
        del config['travel']
        self.assertNotIn('travel', config_tool.validate(json.dumps(config).encode()))

    def test_countdown_feed_is_optional_and_requires_private_https_format(self):
        config = json.loads(EXAMPLE.read_text())
        for url in ['', 'http://example.com/private', 'https://user:secret@example.com/feed', 'https://example.com/feed#secret']:
            config['countdowns'] = {'url': url}
            with self.assertRaises(config_tool.ConfigError):
                config_tool.validate(json.dumps(config).encode())
        del config['countdowns']
        self.assertNotIn('countdowns', config_tool.validate(json.dumps(config).encode()))


if __name__ == "__main__":
    unittest.main()
