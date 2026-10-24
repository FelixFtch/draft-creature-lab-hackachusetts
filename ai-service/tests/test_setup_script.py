"""scripts/setup-local-ai.sh against fake macOS tools and a mock Ollama API."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "setup-local-ai.sh"

FAKES = {
    "uname": """#!/bin/sh
case "$1" in -s) echo "${FAKE_OS:-Darwin}" ;; -m) echo "${FAKE_ARCH:-arm64}" ;; *) echo "${FAKE_OS:-Darwin}" ;; esac
""",
    "sysctl": """#!/bin/sh
case "$2" in hw.memsize) echo "${FAKE_MEM:-17179869184}" ;; machdep.cpu.brand_string) echo "Apple M4" ;; *) exit 1 ;; esac
""",
    "xcode-select": "#!/bin/sh\nexit 0\n",
    "open": "#!/bin/sh\necho \"open $*\" >> \"$FAKE_LOG\"\n",
    "brew": """#!/bin/sh
echo "brew $*" >> "$FAKE_LOG"
if [ "$1" = "list" ]; then exit 1; fi
exit 0
""",
    "ollama": """#!/bin/sh
echo "ollama $*" >> "$FAKE_LOG"
if [ "$1" = "pull" ]; then echo "$2" >> "$FAKE_MODELS"; echo "pulling $2... success"; fi
""",
}


class MockOllama:
    def __init__(self, models_file):
        self.models_file = Path(models_file)
        self.chat_status = 200
        self.answer = "Red."
        self.capabilities = ["completion", "vision", "thinking"]
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, status, value):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                owner.requests.append(("GET", self.path, None))
                if self.path == "/api/version":
                    self.send(200, {"version": "0.40.10"})
                elif self.path == "/api/tags":
                    names = owner.models_file.read_text().split() if owner.models_file.exists() else []
                    self.send(200, {"models": [{"name": n, "model": n} for n in names]})
                else:
                    self.send(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append(("POST", self.path, body))
                if self.path == "/api/show":
                    self.send(200, {"capabilities": owner.capabilities})
                elif self.path == "/v1/chat/completions":
                    if owner.chat_status != 200:
                        self.send(owner.chat_status, {"error": "boom"})
                    else:
                        self.send(200, {"model": body["model"], "choices": [{"finish_reason": "stop",
                                        "message": {"role": "assistant", "content": owner.answer}}]})
                else:
                    self.send(404, {})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self):
        return self.server.server_port

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@unittest.skipUnless(shutil.which("bash") and shutil.which("curl"), "needs bash and curl")
class SetupScriptTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        (self.dir / "home").mkdir()
        self.log = self.dir / "calls.log"
        self.models = self.dir / "models.txt"
        self.config = self.dir / "ai-service" / "config.json"
        self.mock = MockOllama(self.models)

    def tearDown(self):
        self.mock.close()
        shutil.rmtree(self.dir)

    def install_fakes(self, without=()):
        for name, body in FAKES.items():
            if name in without:
                continue
            path = self.bin / name
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run_script(self, *args, mem=16, arch="arm64", without=(), ollama_host=None):
        self.install_fakes(without)
        # Only our fakes plus the basic system tools; never a real ollama/brew.
        system = os.pathsep.join(p for p in ("/usr/bin", "/bin") if Path(p).is_dir())
        env = {"PATH": f"{self.bin}{os.pathsep}{system}", "HOME": str(self.dir / "home"), "FAKE_LOG": str(self.log),
               "FAKE_MODELS": str(self.models), "FAKE_MEM": str(mem * 1024 ** 3), "FAKE_ARCH": arch,
               "OLLAMA_HOST": ollama_host or f"127.0.0.1:{self.mock.port}", "DRAFT_PYTHON": sys.executable,
               "LANG": "C"}
        result = subprocess.run(["bash", str(SCRIPT), "--config", str(self.config), *args], env=env,
                                capture_output=True, text=True, timeout=60)
        return result

    def calls(self):
        return self.log.read_text() if self.log.exists() else ""

    def test_16gb_mac_pulls_smoke_tests_and_writes_config(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("Model: qwen3.5:4b", result.stdout)
        self.assertIn("ollama pull qwen3.5:4b", self.calls())
        self.assertIn("It sees the red test image", result.stdout)
        config = json.loads(self.config.read_text())
        for role in ("brain", "eyes"):
            self.assertEqual(config["roles"][role], {"provider": "ollama", "model": "qwen3.5:4b", "reasoning_effort": "none",
                                                     "base_url": f"http://127.0.0.1:{self.mock.port}/v1"})
        chat = [r for r in self.mock.requests if r[1] == "/v1/chat/completions"][0][2]
        self.assertEqual(chat["reasoning_effort"], "none")
        self.assertTrue(chat["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        # The written config is accepted by the service.
        sys.path.insert(0, str(SCRIPT.parents[1] / "ai-service"))
        from settings import load_settings
        settings = load_settings(self.config, env={})
        self.assertEqual(settings.problems, [])
        self.assertEqual(settings.roles["eyes"].model, "qwen3.5:4b")
        # Second run: nothing to download, nothing to change.
        self.log.write_text("")
        again = self.run_script()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("already downloaded", again.stdout)
        self.assertIn("unchanged", again.stdout)
        self.assertNotIn("pull", self.calls())

    def test_model_choice_by_ram_and_chip(self):
        for mem, arch, expected in ((8, "arm64", "qwen3-vl:2b-instruct"), (24, "arm64", "qwen3.5:9b"),
                                    (64, "arm64", "qwen3.5:9b"), (32, "x86_64", "qwen3-vl:2b-instruct")):
            with self.subTest(mem=mem, arch=arch):
                result = self.run_script("--dry-run", mem=mem, arch=arch)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"Model: {expected}", result.stdout)

    def test_override_one_role_keeps_the_other(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text(json.dumps({"port": 18383, "roles": {"brain": {"provider": "dashscope", "model": "qwen3.8-flash"}}}))
        self.mock.capabilities = ["completion", "vision"]
        result = self.run_script("--model", "qwen3-vl:8b-instruct", "--roles", "eyes")
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(self.config.read_text())
        self.assertEqual(config["roles"]["brain"]["provider"], "dashscope")
        self.assertEqual(config["roles"]["eyes"], {"provider": "ollama", "model": "qwen3-vl:8b-instruct",
                                                   "base_url": f"http://127.0.0.1:{self.mock.port}/v1"})
        self.assertTrue(list(self.config.parent.glob("config.json.*.bak")))

    def test_dry_run_changes_nothing(self):
        result = self.run_script("--dry-run", without=("ollama",), ollama_host="127.0.0.1:9")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("[dry-run] brew install ollama", result.stdout)
        self.assertIn("would write", result.stdout)
        self.assertFalse(self.config.exists())
        self.assertNotIn("brew install", self.calls())
        self.assertNotIn("pull", self.calls())
        self.assertIn("Dry run only", result.stdout)
        default = self.run_script("--dry-run", ollama_host="127.0.0.1:11434")
        self.assertEqual(default.returncode, 0, default.stderr)
        self.assertNotIn("base_url", default.stdout)  # the preset already points at 127.0.0.1:11434

    def test_missing_ollama_without_homebrew_prints_official_instructions(self):
        result = self.run_script(without=("ollama", "brew"), ollama_host="127.0.0.1:9")
        self.assertEqual(result.returncode, 3)
        self.assertIn("curl -fsSL https://ollama.com/install.sh | sh", result.stdout)
        self.assertIn("https://ollama.com/download/Ollama.dmg", result.stdout)
        self.assertFalse(self.config.exists())

    def test_failed_smoke_test_does_not_write_config(self):
        self.mock.chat_status = 500
        result = self.run_script()
        self.assertEqual(result.returncode, 4)
        self.assertIn("--skip-smoke", result.stderr)
        self.assertFalse(self.config.exists())
        result = self.run_script("--skip-smoke")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.config.exists())

    def test_bad_input_is_rejected(self):
        self.assertEqual(self.run_script("--model", "bad tag;rm -rf").returncode, 2)
        self.assertEqual(self.run_script("--roles", "hands").returncode, 2)
        self.assertEqual(self.run_script("--frobnicate").returncode, 2)
        self.assertEqual(self.run_script(ollama_host="10.0.0.5:11434").returncode, 2)

    def test_help(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("qwen3-vl:2b-instruct", result.stdout)


if __name__ == "__main__":
    unittest.main()
