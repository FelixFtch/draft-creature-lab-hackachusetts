import base64
import binascii
import copy
import hashlib
import http.client
import json
from pathlib import Path
import struct
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
import zlib

from server import (Adapter, AdapterError, HttpProvider, MAX_BODY_BYTES, MAX_IMAGE_BYTES,
                    create_server, load_config, model_action, strict_json,
                    validate_action, validate_image, validate_request)

CONFIG = load_config(Path(__file__).with_name("config.example.json"))


def png(width=1, height=1):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\0\x10\x20\x30\xff")) + chunk(b"IEND", b""))


def request(image=None):
    return {"instruction": "Approach the orange marker, then stand.", "observationId": "frame-1",
            "imageDataUrl": "data:image/png;base64," + base64.b64encode(png() if image is None else image).decode()}


def response(action=None):
    return {"model": CONFIG["model"], "choices": [{"finish_reason": "stop", "message": {"role": "assistant",
            "content": json.dumps(action or {"operation": "forward", "durationSeconds": 1})}}]}


class FakeProvider:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result or response(), error, []

    def health(self):
        return {"reachable": True, "ready": True}

    def complete(self, payload):
        self.calls.append(payload)
        if self.error:
            raise self.error
        return self.result


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
                model_action(value, CONFIG["model"])
            self.assertEqual(caught.exception.code, "invalid_model_response")

    def test_proposal_and_payload_provenance(self):
        provider = FakeProvider()
        result = Adapter(CONFIG, provider).decide(request())
        self.assertTrue(result["ok"])
        self.assertFalse(result["executesMotion"])
        self.assertEqual(result["observationId"], "frame-1")
        self.assertEqual(result["provenance"]["imageSha256"], hashlib.sha256(png()).hexdigest())
        self.assertEqual(provider.calls[0]["model"], CONFIG["model"])
        self.assertFalse(provider.calls[0]["stream"])
        self.assertEqual(provider.calls[0]["messages"][1]["content"][1]["image_url"]["url"], request()["imageDataUrl"])

    def test_health_does_not_infer(self):
        provider = FakeProvider()
        result = Adapter(CONFIG, provider).health()
        self.assertEqual(result["successfulDecisions"], 0)
        self.assertEqual(provider.calls, [])

    def test_single_inflight_and_recovery_after_error(self):
        entered, finish = threading.Event(), threading.Event()
        provider = FakeProvider()
        def blocked(_):
            entered.set(); finish.wait(2)
            raise AdapterError("provider_timeout", "Test timeout", 504)
        provider.complete = blocked
        adapter = Adapter(CONFIG, provider)
        errors = []
        def first():
            try: adapter.decide(request())
            except AdapterError as exc: errors.append(exc.code)
        thread = threading.Thread(target=first); thread.start()
        try:
            self.assertTrue(entered.wait(1))
            with self.assertRaises(AdapterError) as caught: adapter.decide(request())
            self.assertEqual(caught.exception.status, 429)
        finally:
            finish.set(); thread.join(2)
        self.assertEqual(errors, ["provider_timeout"])
        self.assertFalse(adapter.busy)
        provider.complete = lambda _: response()
        self.assertTrue(adapter.decide(request())["ok"])

    def test_transport_offline_and_timeout_are_explicit(self):
        provider = HttpProvider(CONFIG)
        for error, expected in [(urllib.error.URLError(ConnectionRefusedError()), "provider_offline"),
                                (TimeoutError(), "provider_timeout")]:
            with patch.object(provider.opener, "open", side_effect=error), self.assertRaises(AdapterError) as caught:
                provider.complete({})
            self.assertEqual(caught.exception.code, expected)
        with patch.object(provider.opener, "open", side_effect=urllib.error.URLError(ConnectionRefusedError())):
            self.assertFalse(provider.health()["reachable"])


class HttpContractTests(unittest.TestCase):
    def setUp(self):
        self.provider = FakeProvider()
        self.server, self.adapter = create_server(copy.deepcopy(CONFIG), self.provider, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def call(self, method="POST", path="/decide", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        payload = json.dumps(request() if body is None else body).encode() if method == "POST" else None
        try:
            connection.request(method, path, body=payload, headers={"Content-Type": "application/json", **(headers or {})})
            response_ = connection.getresponse()
            return response_.status, dict(response_.getheaders()), json.loads(response_.read())
        finally:
            connection.close()

    def test_loopback_health_and_decide(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, _, result = self.call("GET", "/health")
        self.assertEqual(status, 200); self.assertFalse(result["executesMotion"]); self.assertEqual(self.provider.calls, [])
        status, headers, result = self.call(headers={"Origin": "http://127.0.0.1:18381"})
        self.assertEqual(status, 200); self.assertEqual(result["action"]["vx"], .35)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:18381")

    def test_offline_response_contains_no_fallback_action(self):
        self.provider.error = AdapterError("provider_offline", "Local provider unavailable", 503)
        status, _, result = self.call()
        self.assertEqual(status, 503); self.assertFalse(result["ok"]); self.assertNotIn("action", result)
        self.assertEqual(result["error"]["code"], "provider_offline")

    def test_bad_model_response_has_no_action(self):
        self.provider.result = response({"operation": "forward", "durationSeconds": 999})
        status, _, result = self.call()
        self.assertEqual(status, 502); self.assertNotIn("action", result)

    def test_untrusted_browser_origin_and_endpoint_override_rejected(self):
        status, headers, _ = self.call(headers={"Origin": "https://untrusted.example"})
        self.assertEqual(status, 403); self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, _, _ = self.call(body={**request(), "endpoint": "http://untrusted.example"})
        self.assertEqual(status, 400); self.assertEqual(self.provider.calls, [])

    def test_body_limits_before_reading(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            connection.request("POST", "/decide", headers={"Content-Type": "application/json", "Content-Length": str(MAX_BODY_BYTES + 1)})
            reply = connection.getresponse(); self.assertEqual(reply.status, 413); reply.read()
        finally: connection.close()
        self.assertEqual(self.provider.calls, [])

    def test_unknown_endpoint(self):
        status, _, result = self.call("GET", "/execute")
        self.assertEqual(status, 404); self.assertNotIn("action", result)


if __name__ == "__main__":
    unittest.main()
