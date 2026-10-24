"""config.json, environment overrides, .env.local and legacy configs."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from settings import load_settings, parse_dotenv
from tests.helpers import SECRET


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.config = self.dir / "config.json"

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write(self, value):
        self.config.write_text(json.dumps(value) if not isinstance(value, str) else value)

    def test_nothing_configured_means_offline(self):
        settings = load_settings(self.config, env={})
        self.assertEqual(settings.roles, {"brain": None, "eyes": None})
        self.assertEqual(settings.port, 18383)
        self.assertEqual(settings.allowed_origins, ["http://127.0.0.1:18381", "http://localhost:18381"])
        self.assertEqual(settings.source, "none")

    def test_roles_from_file_and_env_keys(self):
        self.write({"port": 18421, "roles": {"brain": {"provider": "dashscope", "model": "qwen3.8-flash"},
                                             "eyes": {"provider": "ollama", "model": "qwen3.5:4b", "reasoning_effort": "none"}}})
        settings = load_settings(self.config, env={"DASHSCOPE_API_KEY": SECRET})
        self.assertEqual(settings.port, 18421)
        self.assertEqual(settings.roles["brain"].provider, "dashscope")
        self.assertEqual(settings.roles["brain"].key.reveal(), SECRET)
        self.assertTrue(settings.roles["eyes"].local)
        self.assertEqual(settings.roles["eyes"].reasoning_effort, "none")
        self.assertNotIn(SECRET, repr(settings))

    def test_dotenv_is_read_and_never_overrides_environment(self):
        dotenv = self.dir / ".env.local"
        dotenv.write_text("# keys\nexport ZHIPUAI_API_KEY='from-file-key.123'\nOPENAI_API_KEY=sk-file # comment\n")
        os.chmod(dotenv, 0o600)
        self.write({"roles": {"brain": {"provider": "zhipu"}, "eyes": {"provider": "openai"}}})
        settings = load_settings(self.config, env={"OPENAI_API_KEY": "sk-from-environment"})
        self.assertEqual(settings.roles["brain"].key.reveal(), "from-file-key.123")
        self.assertEqual(settings.roles["eyes"].key.reveal(), "sk-from-environment")
        self.assertEqual(settings.problems, [])
        os.chmod(dotenv, 0o644)
        settings = load_settings(self.config, env={})
        self.assertTrue(any("chmod 600" in p for p in settings.problems))
        self.assertFalse(any("from-file-key" in p for p in settings.problems))

    def test_parse_dotenv_edge_cases(self):
        values = parse_dotenv('A=1\n B = "two words" \nbad line\n1X=nope\nC=\'q\'\n#D=4\nE=val # note\n')
        self.assertEqual(values, {"A": "1", "B": "two words", "C": "q", "E": "val"})

    def test_env_overrides(self):
        self.write({"roles": {"brain": {"provider": "ollama", "model": "qwen3.5:4b"}}})
        settings = load_settings(self.config, env={"AI_BRAIN": "gemini:gemini-3.8-flash", "AI_EYES": "ollama:qwen3-vl:2b-instruct",
                                                  "GEMINI_API_KEY": "AIzaTestKey1"})
        self.assertEqual((settings.roles["brain"].provider, settings.roles["brain"].model), ("gemini", "gemini-3.8-flash"))
        self.assertEqual(settings.roles["eyes"].model, "qwen3-vl:2b-instruct")
        settings = load_settings(self.config, env={"AI_BRAIN": "nonsense"})
        self.assertTrue(any("AI_BRAIN" in p for p in settings.problems))

    def test_broken_config_degrades_instead_of_crashing(self):
        self.write("{not json")
        settings = load_settings(self.config, env={})
        self.assertEqual(settings.roles, {"brain": None, "eyes": None})
        self.assertTrue(settings.problems)
        self.write({"roles": {"brain": {"provider": "custom", "base_url": "http://evil.example/v1", "model": "m"},
                              "eyes": {"provider": "ollama", "model": "qwen3.5:4b"}, "hands": {}},
                    "allowed_origins": ["https://evil.example"], "port": 80, "surprise": 1})
        settings = load_settings(self.config, env={})
        self.assertIsNone(settings.roles["brain"])
        self.assertIsNotNone(settings.roles["eyes"])
        self.assertEqual(settings.port, 18383)
        self.assertNotIn("https://evil.example", settings.allowed_origins)
        self.assertGreaterEqual(len(settings.problems), 4)

    def test_key_in_config_is_refused(self):
        self.write({"roles": {"brain": {"provider": "openai", "model": "gpt-6-luna", "api_key": SECRET}}})
        settings = load_settings(self.config, env={})
        self.assertIsNone(settings.roles["brain"])
        self.assertFalse(any(SECRET in p for p in settings.problems))

    def test_legacy_vlm_service_config(self):
        self.write({"endpoint": "http://127.0.0.1:8770/v1/chat/completions", "model": "your-local-vision-model",
                    "port": 18383, "request_timeout_seconds": 45, "allowed_origins": ["http://127.0.0.1:18381"]})
        settings = load_settings(self.config, env={})
        eyes = settings.roles["eyes"]
        self.assertEqual((eyes.provider, eyes.base_url, eyes.model), ("custom", "http://127.0.0.1:8770/v1", "your-local-vision-model"))
        self.assertEqual(eyes.timeout, 45.0)
        self.assertIsNone(settings.roles["brain"])
        self.assertEqual(settings.source, "legacy-file")

    def test_lab_port_adds_origins_and_eyes_brain_alias(self):
        self.write({"roles": {"brain": {"provider": "ollama", "model": "qwen3.5:9b"}, "eyes": "brain"}})
        settings = load_settings(self.config, env={"LAB_PORT": "18581"})
        self.assertIn("http://127.0.0.1:18581", settings.allowed_origins)
        self.assertEqual(settings.roles["eyes"].model, "qwen3.5:9b")
        self.assertEqual(settings.roles["eyes"].role, "eyes")

    def test_example_config_is_valid(self):
        example = Path(__file__).resolve().parents[1] / "config.example.json"
        settings = load_settings(example, env={"DASHSCOPE_API_KEY": "sk-abcdefgh"})
        self.assertEqual(settings.problems, [])
        self.assertIsNotNone(settings.roles["brain"])
        self.assertIsNotNone(settings.roles["eyes"])


if __name__ == "__main__":
    unittest.main()
