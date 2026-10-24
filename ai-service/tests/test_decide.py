"""POST /decide: the vlm-service test suite, ported case by case, plus the
v2 provenance contract (local_vlm vs cloud_vlm, provider name)."""
import copy
import hashlib
import http.client
import json
import threading
import unittest
import urllib.error
from unittest.mock import patch

from providers import HttpTransport, OpenAICompatibleProvider, ProviderError
from server import AdapterError, MAX_BODY_BYTES, MAX_IMAGE_BYTES, create_server, model_action, strict_json
from vision import Decider, validate_action, validate_image, validate_request
from tests.helpers import LEGACY_EYES, FakeTransport, completion, png, png_url, provider, role, settings

MODEL = LEGACY_EYES["model"]


def request(image=None):
    return {"instruction": "Approach the orange marker, then stand.", "observationId": "frame-1",
            "imageDataUrl": png_url(image)}


def response(action=None, model=MODEL):
    return completion(json.dumps(action or {"operation": "forward", "durationSeconds": 1}), model=model)


def eyes(transport=None, raw=None):
    transport = transport or FakeTransport()
    transport.default = transport.default or response()
    return provider(raw or LEGACY_EYES, transport), transport


class ValidationTests(unittest.TestCase):
    def test_strict_json(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                strict_json(raw)

    def test_operation_mappings_and_bounds(self):
        expected = {"forward": (.35, 0), "backward": (-.2, 0), "turn_left": (0, .5), "turn_right": (0, -.5), "stand": (0, 0)}
        for operation, (vx, wz) in expected.items():
            for duration in ([0] if operation == "stand" else [.1, 1, 2]):
                action = validate_action({"operation": operation, "durationSeconds": duration})
                self.assertEqual((action["vx"], action["vy"], action["wz"]), (vx, 0, wz))

    def test_reject_unsafe_or_ambiguous_actions(self):
        invalid = [{"operation": "jump", "durationSeconds": 1}, {"operation": "forward", "durationSeconds": 1, "vx": 999},
                   {"operation": "forward"}, {"operation": "stand", "durationSeconds": .1},
                   {"operation": ["forward"], "durationSeconds": 1}]
        invalid += [{"operation": "forward", "durationSeconds": value} for value in [-1, 0, .099, 2.001, True, "1", float("nan"), 10**1000]]
        for value in invalid:
            with self.subTest(value=str(value)[:80]), self.assertRaises(ValueError):
                validate_action(value)

    def test_png_container_and_dimensions(self):
        data, width, height = validate_image(request()["imageDataUrl"])
        self.assertEqual((data, width, height), (png(), 1, 1))
        for data in [b"bad", png()[:-5], png() + b"trailing", png(4096), png(0), png()[:35] + b"bad" + png()[38:]]:
            with self.subTest(size=len(data)), self.assertRaises(AdapterError):
                validate_request(request(data))

    def test_image_size_and_external_urls(self):
        with self.assertRaises(AdapterError) as caught:
            validate_request(request(b"x" * (MAX_IMAGE_BYTES + 1)))
        self.assertEqual(caught.exception.status, 413)
        for value in ["http://example.test/frame.png", "/tmp/frame.png", "data:image/jpeg;base64,AAAA", "data:image/png;base64,!not-base64!"]:
            with self.subTest(value=value), self.assertRaises(AdapterError):
                validate_image(value)

    def test_request_fields(self):
        for changed in [{"instruction": ""}, {"instruction": "x" * 2001}, {"instruction": 123},
                        {"endpoint": "http://example.test"}, {"observationId": "x" * 97}]:
            with self.subTest(changed=list(changed)), self.assertRaises(AdapterError):
                validate_request({**request(), **changed})

    def test_response_rejections(self):
        invalid = [{}, {"choices": []}, {"model": "wrong", "choices": response()["choices"]}]
        for content in ['```json\n{"operation":"stand","durationSeconds":0}\n```',
                        '{"operation":"forward","durationSeconds":1,"operation":"stand"}',
                        '{"operation":"stand","durationSeconds":NaN}', "not JSON"]:
            value = response(); value["choices"][0]["message"]["content"] = content; invalid.append(value)
        for field in ("tool_calls", "function_call", "refusal"):
            value = response(); value["choices"][0]["message"][field] = "not allowed"; invalid.append(value)
        value = response(); value["choices"][0]["finish_reason"] = "length"; invalid.append(value)
        value = response(); value["choices"][0]["message"] = []; invalid.append(value)
        for value in invalid:
            with self.subTest(value=str(value)[:90]), self.assertRaises(AdapterError) as caught:
                model_action(value, MODEL)
            self.assertEqual(caught.exception.code, "invalid_model_response")

    def test_cloud_model_alias_is_not_echo_checked(self):
        # Cloud APIs report dated snapshots ("gpt-6-luna-2026-...") instead of the alias.
        value = response(model="qwen3.8-flash-2026-09-01")
        self.assertEqual(model_action(value, "qwen3.8-flash", strict_model=False)["operation"], "forward")
        self.assertEqual(model_action(response(model="m:latest"), "m")["operation"], "forward")

    def test_proposal_and_payload_provenance(self):
        eyes_provider, transport = eyes()
        result = Decider(eyes_provider).decide(request())
        self.assertTrue(result["ok"])
        self.assertFalse(result["executesMotion"])
        self.assertEqual(result["observationId"], "frame-1")
        self.assertEqual(result["provenance"]["imageSha256"], hashlib.sha256(png()).hexdigest())
        payload = transport.posts[0]["payload"]
        self.assertEqual(payload["model"], MODEL)
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["messages"][1]["content"][1]["image_url"]["url"], request()["imageDataUrl"])
        self.assertTrue(transport.posts[0]["url"].endswith("/v1/chat/completions"))

    def test_provenance_marks_local_and_cloud(self):
        local, _ = eyes()
        result = Decider(local).decide(request())
        self.assertEqual(result["provenance"]["source"], "local_vlm")
        self.assertEqual(result["provenance"]["provider"], "custom")
        self.assertEqual(result["provenance"]["model"], MODEL)
        cloud_transport = FakeTransport()
        cloud_transport.default = response(model="qwen3.8-flash-0901")
        cloud = provider({"provider": "dashscope", "model": "qwen3.8-flash"}, cloud_transport,
                         env={"DASHSCOPE_API_KEY": "sk-dashscope-test-key"})
        result = Decider(cloud).decide(request())
        self.assertEqual(result["provenance"]["source"], "cloud_vlm")
        self.assertEqual(result["provenance"]["provider"], "dashscope")
        self.assertEqual(result["provenance"]["model"], "qwen3.8-flash")
        self.assertEqual(set(result["provenance"]), {"source", "provider", "model", "imageSha256", "elapsedMilliseconds"})
        self.assertEqual(set(result), {"ok", "decisionId", "observationId", "action", "executesMotion", "provenance"})

    def test_no_eyes_provider_means_no_action(self):
        with self.assertRaises(AdapterError) as caught:
            Decider(None).decide(request())
        self.assertEqual((caught.exception.code, caught.exception.status), ("provider_not_configured", 503))

    def test_health_does_not_infer(self):
        eyes_provider, transport = eyes()
        server, service = create_server(settings(), providers={"eyes": eyes_provider, "brain": None}, port=0)
        server.server_close()
        result = service.health()
        self.assertEqual(result["successfulDecisions"], 0)
        self.assertEqual(transport.posts, [])

    def test_single_inflight_and_recovery_after_error(self):
        entered, finish = threading.Event(), threading.Event()
        transport = FakeTransport()

        def blocked(url, payload):
            entered.set(); finish.wait(2)
            return ProviderError("provider_timeout", "Test timeout", 504)
        transport.replies = [blocked]
        transport.default = response()
        decider = Decider(provider(LEGACY_EYES, transport))
        errors = []

        def first():
            try: decider.decide(request())
            except AdapterError as exc: errors.append(exc.code)
        thread = threading.Thread(target=first); thread.start()
        try:
            self.assertTrue(entered.wait(1))
            with self.assertRaises(AdapterError) as caught: decider.decide(request())
            self.assertEqual(caught.exception.status, 429)
        finally:
            finish.set(); thread.join(2)
        self.assertEqual(errors, ["provider_timeout"])
        self.assertFalse(decider.busy)
        self.assertTrue(decider.decide(request())["ok"])

    def test_transport_offline_and_timeout_are_explicit(self):
        transport = HttpTransport()
        eyes_provider = OpenAICompatibleProvider(role("eyes", LEGACY_EYES), transport)
        for error, expected in [(urllib.error.URLError(ConnectionRefusedError()), "provider_offline"),
                                (TimeoutError(), "provider_timeout")]:
            with patch.object(transport.local_opener, "open", side_effect=error), self.assertRaises(ProviderError) as caught:
                eyes_provider.complete([{"role": "user", "content": "hi"}])
            self.assertEqual(caught.exception.code, expected)
        with patch.object(transport.local_opener, "open", side_effect=urllib.error.URLError(ConnectionRefusedError())):
            self.assertFalse(eyes_provider.health()["reachable"])


class HttpContractTests(unittest.TestCase):
    def setUp(self):
        self.provider, self.transport = eyes()
        self.server, self.service = create_server(settings(), providers={"eyes": self.provider, "brain": None}, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def call(self, method="POST", path="/decide", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        payload = json.dumps(request() if body is None else body).encode() if method == "POST" else None
        try:
            connection.request(method, path, body=payload, headers={"Content-Type": "application/json", **(headers or {})})
            reply = connection.getresponse()
            return reply.status, dict(reply.getheaders()), json.loads(reply.read())
        finally:
            connection.close()

    def test_loopback_health_and_decide(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, _, result = self.call("GET", "/health")
        self.assertEqual(status, 200); self.assertFalse(result["executesMotion"]); self.assertEqual(self.transport.posts, [])
        status, headers, result = self.call(headers={"Origin": "http://127.0.0.1:18381"})
        self.assertEqual(status, 200); self.assertEqual(result["action"]["vx"], .35)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:18381")

    def test_offline_response_contains_no_fallback_action(self):
        self.transport.default = ProviderError("provider_offline", "Local provider unavailable", 503)
        status, _, result = self.call()
        self.assertEqual(status, 503); self.assertFalse(result["ok"]); self.assertNotIn("action", result)
        self.assertEqual(result["error"]["code"], "provider_offline")

    def test_bad_model_response_has_no_action(self):
        self.transport.default = response({"operation": "forward", "durationSeconds": 999})
        status, _, result = self.call()
        self.assertEqual(status, 502); self.assertNotIn("action", result)

    def test_untrusted_browser_origin_and_endpoint_override_rejected(self):
        status, headers, _ = self.call(headers={"Origin": "https://untrusted.example"})
        self.assertEqual(status, 403); self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, _, _ = self.call(body={**request(), "endpoint": "http://untrusted.example"})
        self.assertEqual(status, 400); self.assertEqual(self.transport.posts, [])

    def test_dns_rebinding_host_rejected(self):
        status, _, result = self.call(headers={"Host": "evil.example:18383"})
        self.assertEqual((status, result["error"]["code"]), (403, "host_denied"))
        status, _, _ = self.call("GET", "/health", headers={"Host": "attacker.test"})
        self.assertEqual(status, 403)
        self.assertEqual(self.transport.posts, [])

    def test_body_limits_before_reading(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            connection.request("POST", "/decide", headers={"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)})
            reply = connection.getresponse(); self.assertEqual(reply.status, 413); reply.read()
        finally: connection.close()
        self.assertEqual(self.transport.posts, [])

    def test_unknown_endpoint(self):
        status, _, result = self.call("GET", "/execute")
        self.assertEqual(status, 404); self.assertNotIn("action", result)

    def test_legacy_health_fields_for_vision_card(self):
        status, _, result = self.call("GET", "/health")
        self.assertEqual(status, 200)
        for key in ("provider", "model", "busy", "successfulDecisions", "executesMotion"):
            self.assertIn(key, result)
        self.assertIsInstance(result["provider"], dict)
        self.assertEqual(result["model"], MODEL)
        self.assertIn("ready", result["provider"])


if __name__ == "__main__":
    unittest.main()
