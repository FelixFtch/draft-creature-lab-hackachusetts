"""HTTP contract for /health, /chat, /critique; origin/size checks; no key leaks."""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from schemas import LOOK_ID
from server import MAX_CHAT_BODY_BYTES, create_server
from vision import MAX_CRITIQUE_BODY_BYTES, apply_look_patch
from tests.helpers import (SECRET, SERVICE_DIR, FakeTransport, MockProvider, completion, png_url, provider, settings)

CRITIQUE = {"text": "Love the spots! A beetle shell would make it read as a ladybug from far away.",
            "suggestions": ["Add a beetle shell", "Glossier finish"],
            "lookPatch": {"shell": {"kind": "beetle", "color": "red", "size": 3}, "finish": "Glossy", "sparkles": True}}


class ServerHarness(unittest.TestCase):
    providers = None

    def setUp(self):
        self.server, self.service = create_server(settings(), providers=self.providers or {"brain": None, "eyes": None}, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def call(self, method, path, body=None, headers=None, raw=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        payload = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        try:
            connection.request(method, path, body=payload, headers={"Content-Type": "application/json", **(headers or {})})
            reply = connection.getresponse()
            data = reply.read()
            return reply.status, dict(reply.getheaders()), (json.loads(data) if data else None)
        finally:
            connection.close()


class OfflineServerTests(ServerHarness):
    def test_health_without_providers(self):
        status, headers, result = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(result["offline"])
        self.assertEqual(result["roles"]["brain"]["configured"], False)
        self.assertEqual(result["provider"], {"reachable": False, "ready": False})
        self.assertIsNone(result["model"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, _, _ = self.call("GET", "/health?refresh=1")
        self.assertEqual(status, 200)

    def test_chat_offline_over_http(self):
        status, headers, result = self.call("POST", "/chat", {"messages": [{"role": "user", "content": "a frog that jumps"}]},
                                            {"Origin": "http://localhost:18381"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:18381")
        self.assertTrue(result["provider"]["offline"])
        self.assertEqual({a["type"] for a in result["actions"]}, {"design", "look"})

    def test_vision_routes_need_eyes(self):
        status, _, result = self.call("POST", "/critique", {"imageDataUrl": png_url()})
        self.assertEqual((status, result["error"]["code"]), (503, "provider_not_configured"))
        status, _, result = self.call("POST", "/decide", {"instruction": "go", "imageDataUrl": png_url()})
        self.assertEqual((status, result["error"]["code"]), (503, "provider_not_configured"))
        self.assertNotIn("action", result)

    def test_request_hygiene(self):
        status, _, result = self.call("POST", "/chat", {"messages": []}, {"Origin": "https://evil.example"})
        self.assertEqual((status, result["error"]["code"]), (403, "origin_denied"))
        status, _, result = self.call("POST", "/chat", raw=b'{"messages": [], "messages": []}')
        self.assertEqual((status, result["error"]["code"]), (400, "invalid_request"))
        status, _, _ = self.call("POST", "/chat", raw=b"[]", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _, _ = self.call("POST", "/nope", {})
        self.assertEqual(status, 404)
        status, headers, _ = self.call("OPTIONS", "/chat", headers={"Origin": "http://127.0.0.1:18381"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "POST")
        status, _, _ = self.call("OPTIONS", "/chat", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)

    def test_route_specific_body_limits(self):
        for path, limit in (("/chat", MAX_CHAT_BODY_BYTES), ("/critique", MAX_CRITIQUE_BODY_BYTES)):
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            try:
                connection.request("POST", path, headers={"Content-Type": "application/json", "Content-Length": str(limit + 1)})
                reply = connection.getresponse()
                self.assertEqual(reply.status, 413, path)
                reply.read()
            finally:
                connection.close()


class CritiqueTests(ServerHarness):
    def setUp(self):
        self.transport = FakeTransport()
        self.transport.default = completion(json.dumps(CRITIQUE), model="qwen3.5:4b")
        self.providers = {"brain": None, "eyes": provider({"provider": "ollama", "model": "qwen3.5:4b"}, self.transport)}
        super().setUp()

    def test_critique_with_validated_look_patch(self):
        look = {"schema": LOOK_ID, "theme": "ladybug", "palette": {"body": "#d93a32"}, "pattern": {"kind": "spots"}}
        status, _, result = self.call("POST", "/critique", {"imageDataUrl": png_url(), "prompt": "Does it look like a ladybug?",
                                                            "design": {"name": "Dot", "bodyPlan": "multileg"}, "look": look})
        self.assertEqual(status, 200)
        self.assertEqual(result["text"], CRITIQUE["text"])
        self.assertEqual(result["lookPatch"]["shell"]["kind"], "beetle")
        self.assertRegex(result["lookPatch"]["shell"]["color"], r"^#[0-9a-f]{6}$")
        self.assertEqual(result["lookPatch"]["shell"]["size"], 1.3)
        self.assertEqual(result["lookPatch"]["finish"], "gloss")
        self.assertNotIn("sparkles", result["lookPatch"])
        self.assertEqual(result["look"]["theme"], "ladybug")  # merged onto the current look
        self.assertEqual(result["provenance"]["source"], "local_vlm")
        self.assertEqual(result["provenance"]["provider"], "ollama")
        sent = self.transport.posts[0]["payload"]
        self.assertEqual(sent["messages"][1]["content"][1]["image_url"]["url"], png_url())
        self.assertIn("Does it look like a ladybug?", sent["messages"][1]["content"][0]["text"])

    def test_critique_retries_once_then_fails_cleanly(self):
        self.transport.replies = [completion("Looks great!", model="qwen3.5:4b")]
        status, _, result = self.call("POST", "/critique", {"imageDataUrl": png_url()})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.transport.posts), 2)
        self.transport.replies = [completion("nope", model="qwen3.5:4b"), completion("still nope", model="qwen3.5:4b")]
        status, _, result = self.call("POST", "/critique", {"imageDataUrl": png_url()})
        self.assertEqual((status, result["error"]["code"]), (502, "invalid_model_response"))

    def test_critique_input_validation(self):
        for body in ({"imageDataUrl": "https://example.com/x.png"}, {"imageDataUrl": png_url(), "prompt": "x" * 601},
                     {"imageDataUrl": png_url(), "look": "pink"}, {"imageDataUrl": png_url(), "extra": 1}):
            with self.subTest(body=str(body)[:50]):
                status, _, _ = self.call("POST", "/critique", body)
                self.assertEqual(status, 400)
        self.assertEqual(self.transport.posts, [])

    def test_patch_helper(self):
        from schemas import SchemaStore
        from tests.helpers import CONTRACTS
        store = SchemaStore(CONTRACTS)
        self.assertEqual(apply_look_patch(store, None, None)[:2], (None, None))
        patch, look, _ = apply_look_patch(store, None, {"palette": {"body": "#000000"}, "schema": "evil"})
        self.assertEqual(patch, {"palette": {"body": "#000000"}})
        self.assertEqual(look["schema"], LOOK_ID)


def free_port(candidates=range(18420, 18430)):
    for port in candidates:
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise unittest.SkipTest("no free port in the ai band 18420-18429")


class EndToEndNoLeakTests(unittest.TestCase):
    """Run server.py as a real process against an HTTP mock provider."""

    def test_keys_never_leave_through_responses_or_logs(self):
        port = free_port()
        with MockProvider(models=["mock-vlm"]) as mock, tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            role = {"provider": "custom", "base_url": mock.base_url, "model": "mock-vlm", "api_key_env": "TEST_AI_KEY"}
            config.write_text(json.dumps({"port": port, "roles": {"brain": role, "eyes": role}}))
            design_reply = {"reply": "Meet Zip! Your key is safe.", "design": {"name": "Zip", "bodyPlan": "quadruped"},
                            "suggestions": ["Longer legs"]}
            mock.replies += [(200, completion(json.dumps(design_reply), model="mock-vlm")),
                             (200, completion('{"operation":"turn_left","durationSeconds":0.5}', model="mock-vlm")),
                             (200, completion(json.dumps(CRITIQUE), model="mock-vlm")),
                             (401, {"error": "invalid key " + SECRET})]
            env = dict(os.environ, TEST_AI_KEY=SECRET, PYTHONDONTWRITEBYTECODE="1")
            process = subprocess.Popen([sys.executable, str(SERVICE_DIR / "server.py"), "--config", str(config)],
                                       env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            bodies = []
            try:
                deadline = time.time() + 15
                while True:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                            break
                    except OSError:
                        if time.time() > deadline or process.poll() is not None:
                            self.fail("server did not start")
                        time.sleep(0.1)

                def call(method, path, body=None):
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
                    try:
                        connection.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                                           headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:18381"})
                        reply = connection.getresponse()
                        text = reply.read().decode()
                        bodies.append(text)
                        return reply.status, json.loads(text)
                    finally:
                        connection.close()

                status, health = call("GET", "/health?refresh=1")
                self.assertEqual(status, 200)
                self.assertTrue(health["roles"]["brain"]["ready"])
                self.assertFalse(health["offline"])
                status, chat = call("POST", "/chat", {"messages": [{"role": "user", "content": "a zippy runner"}]})
                self.assertEqual((status, chat["provider"]["name"]), (200, "custom"))
                status, decision = call("POST", "/decide", {"instruction": "look left", "imageDataUrl": png_url(), "observationId": "o1"})
                self.assertEqual((status, decision["action"]["operation"]), (200, "turn_left"))
                self.assertEqual(decision["provenance"]["source"], "local_vlm")
                status, critique = call("POST", "/critique", {"imageDataUrl": png_url()})
                self.assertEqual(status, 200)
                status, fallback = call("POST", "/chat", {"messages": [{"role": "user", "content": "a frog"}]})
                self.assertEqual(fallback["provider"]["fallbackReason"], "provider_auth_error")
            finally:
                process.terminate()
                stdout, stderr = process.communicate(timeout=10)
            for text in bodies + [stdout, stderr]:
                self.assertNotIn(SECRET, text)
            self.assertIn('"service": "draft_ai_service"', stdout)
            auth = [r["headers"].get("Authorization") for r in mock.requests]
            self.assertTrue(auth and all(value == "Bearer " + SECRET for value in auth))


if __name__ == "__main__":
    unittest.main()
