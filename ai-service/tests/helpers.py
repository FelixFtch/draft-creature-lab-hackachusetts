"""Shared test fixtures: PNG builder, fake transport, HTTP mock provider."""
from __future__ import annotations

import base64
import binascii
import copy
import json
from pathlib import Path
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zlib

from providers import OpenAICompatibleProvider, ProviderError, build_role
from settings import Settings

SERVICE_DIR = Path(__file__).resolve().parents[1]
CONTRACTS = SERVICE_DIR.parent / "contracts"
SECRET = "sk-test-SECRET-do-not-leak-1234567890"


def png(width=1, height=1):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\0\x10\x20\x30\xff")) + chunk(b"IEND", b""))


def png_url(image=None):
    return "data:image/png;base64," + base64.b64encode(png() if image is None else image).decode()


def completion(content, model="your-local-vision-model", finish="stop"):
    return {"model": model, "choices": [{"finish_reason": finish, "message": {"role": "assistant", "content": content}}]}


class FakeTransport:
    """Records every request; replies from a queue (dict, ProviderError or callable)."""

    def __init__(self, replies=None):
        self.replies = list(replies or [])
        self.calls = []
        self.default = None

    def request(self, url, payload, headers, timeout, limit, local):
        self.calls.append({"url": url, "payload": copy.deepcopy(payload), "headers": dict(headers),
                           "timeout": timeout, "limit": limit, "local": local})
        reply = self.replies.pop(0) if self.replies else self.default
        if callable(reply):
            reply = reply(url, payload)
        if isinstance(reply, Exception):
            raise reply
        if reply is None:
            raise ProviderError("provider_offline", "Provider is unavailable", 503)
        return copy.deepcopy(reply)

    @property
    def posts(self):
        return [c for c in self.calls if c["payload"] is not None]


def role(role_name, raw, env=None, dotenv=None):
    return build_role(role_name, raw, env or {}, dotenv or {})


def provider(raw, transport=None, env=None, role_name="eyes"):
    return OpenAICompatibleProvider(role(role_name, raw, env), transport or FakeTransport())


def settings(roles=None, problems=None, port=18383, origins=None):
    return Settings(port, origins or ["http://127.0.0.1:18381", "http://localhost:18381"], roles or {"brain": None, "eyes": None},
                    problems or [], SERVICE_DIR / "config.json", CONTRACTS, "test")


LEGACY_EYES = {"provider": "custom", "base_url": "http://127.0.0.1:8770/v1", "model": "your-local-vision-model"}


class MockProvider:
    """A real HTTP server speaking enough of the OpenAI and Ollama APIs."""

    def __init__(self, models=("mock-model",)):
        self.models = list(models)
        self.requests = []
        self.replies = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, status, body, headers=None):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client stopped reading on purpose (size-limit tests)

            def _record(self, body=None):
                with owner.lock:
                    owner.requests.append({"method": self.command, "path": self.path, "headers": dict(self.headers),
                                           "body": body})

            def do_GET(self):
                self._record()
                if self.path.endswith("/api/tags"):
                    self._send(200, {"models": [{"name": m, "model": m} for m in owner.models]})
                elif self.path.endswith("/api/version"):
                    self._send(200, {"version": "0.40.10"})
                elif self.path.endswith("/models"):
                    self._send(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in owner.models]})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"null")
                self._record(body)
                with owner.lock:
                    reply = owner.replies.pop(0) if owner.replies else None
                if callable(reply):
                    reply = reply(body)
                if reply is None:
                    reply = (200, completion('{"reply": "Hello!"}', model=body.get("model", "mock-model")))
                status, payload = reply[0], reply[1]
                headers = reply[2] if len(reply) > 2 else None
                self._send(status, payload, headers)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    @property
    def posts(self):
        return [r for r in self.requests if r["method"] == "POST"]
