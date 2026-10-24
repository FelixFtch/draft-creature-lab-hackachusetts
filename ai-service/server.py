#!/usr/bin/env python3
"""Draft Creature Lab ai-service: Tinker (design chat) + vision on 127.0.0.1.

Routes (see contracts/ai-api.md):
  GET  /health    roles, providers, reachability, offline mode (never keys)
  POST /chat      Tinker design conversation -> reply + validated actions
  POST /decide    legacy bounded drive proposal from one PNG (never executes motion)
  POST /critique  the VLM looks at a creature render -> critique + lookPatch

Replaces vlm-service and keeps its /decide and /health contract. Python
standard library only. Nothing here logs request bodies, images, provider
responses or keys.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from designer import Tinker
from providers import OpenAICompatibleProvider, ProviderError, is_loopback_host, strict_json
from schemas import SchemaStore, SchemaUnavailable
from settings import describe, load_settings, warn
from vision import (MAX_BODY_BYTES, MAX_CRITIQUE_BODY_BYTES, MAX_IMAGE_BYTES, Critic, Decider, ServiceError,
                    model_action, validate_action, validate_image, validate_request)

AdapterError = ServiceError  # legacy name used by the ported vlm-service tests
MAX_CHAT_BODY_BYTES = 256 * 1024
BODY_LIMITS = {"/decide": MAX_BODY_BYTES, "/critique": MAX_CRITIQUE_BODY_BYTES, "/chat": MAX_CHAT_BODY_BYTES}
HEALTH_TTL_LOCAL = 4.0
HEALTH_TTL_REMOTE = 60.0

__all__ = ["AIService", "AdapterError", "MAX_BODY_BYTES", "MAX_IMAGE_BYTES", "create_server", "model_action",
           "strict_json", "validate_action", "validate_image", "validate_request"]


class AIService:
    def __init__(self, settings, store=None, providers=None, transport=None):
        self.settings = settings
        self.store = store or SchemaStore(settings.contracts_dir)
        providers = providers or {}
        self.providers = {}
        for role in ("brain", "eyes"):
            if role in providers:
                self.providers[role] = providers[role]
            elif settings.roles.get(role) is not None:
                self.providers[role] = OpenAICompatibleProvider(settings.roles[role], transport)
            else:
                self.providers[role] = None
        self.tinker = Tinker(self.store, self.providers["brain"])
        self.decider = Decider(self.providers["eyes"])
        self.critic = Critic(self.providers["eyes"], self.store)
        self._health_cache = {}
        self._health_lock = threading.Lock()

    # Legacy attribute names (vlm-service Adapter) ------------------------
    @property
    def busy(self):
        return self.decider.busy

    @property
    def successful_decisions(self):
        return self.decider.successful_decisions

    def decide(self, value):
        return self.decider.decide(value)

    # Health ----------------------------------------------------------------
    def role_health(self, role, refresh=False):
        provider = self.providers[role]
        if provider is None:
            status = {"configured": False, "reachable": False, "ready": False}
            if role == "brain":
                status["note"] = "Tinker uses the offline designer"
            return status
        now = time.monotonic()
        with self._health_lock:
            cached = self._health_cache.get(role)
            ttl = HEALTH_TTL_LOCAL if provider.local else HEALTH_TTL_REMOTE
            if cached and not refresh and now - cached[0] < ttl:
                return dict(cached[1])
        try:
            status = provider.health()
        except ProviderError as exc:
            status = {"configured": True, **provider.info(), "reachable": False, "ready": False, "error": exc.code}
        except Exception:
            status = {"configured": True, **provider.info(), "reachable": False, "ready": False, "error": "health_failed"}
        with self._health_lock:
            self._health_cache[role] = (time.monotonic(), status)
        return dict(status)

    def health(self, refresh=False):
        brain = self.role_health("brain", refresh)
        eyes = self.role_health("eyes", refresh)
        eyes_provider = self.providers["eyes"]
        # The legacy "provider"/"model"/"busy" fields keep the VisionCard working.
        legacy_provider = {"reachable": bool(eyes.get("reachable")), "ready": bool(eyes.get("ready"))}
        if eyes_provider is not None:
            legacy_provider.update({"name": eyes_provider.name, "local": eyes_provider.local})
        if eyes.get("error"):
            legacy_provider["error"] = eyes["error"]
        result = {
            "ok": True, "service": "draft_ai_service", "version": 2,
            "offline": not (brain.get("configured") and brain.get("ready")),
            "roles": {"brain": brain, "eyes": eyes},
            "model": eyes_provider.model if eyes_provider is not None else None,
            "provider": legacy_provider,
            "busy": self.decider.busy,
            "successfulDecisions": self.decider.successful_decisions,
            "executesMotion": False,
            "schemas": {"design": "creature-design/1", "look": "creature-look/1"},
        }
        if self.settings.problems:
            result["configProblems"] = list(self.settings.problems)[:10]
        return result


def handler_for(service):
    allowed = set(service.settings.allowed_origins)

    class Handler(BaseHTTPRequestHandler):
        server_version = "DraftAIService/2"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass  # No screenshot, instruction, chat text, key, or provider response logging.

        def route(self):
            return urllib.parse.urlsplit(self.path).path

        def origin_allowed(self):
            origin = self.headers.get("Origin")
            return origin is None or origin in allowed

        def host_allowed(self):
            # DNS-rebinding guard: only loopback Host names (any port; the Vite
            # proxy forwards the browser's Host header unchanged).
            host = self.headers.get("Host")
            if host is None:
                return True
            name = urllib.parse.urlsplit("//" + host).hostname
            return is_loopback_host(name)

        def send_json(self, value, status=200):
            body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if self.headers.get("Origin") in allowed:
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def fail(self, error):
            self.send_json({"ok": False, "error": {"code": error.code, "message": str(error)}, "executesMotion": False},
                           error.status)

        def do_GET(self):
            if not self.host_allowed():
                self.fail(ServiceError("host_denied", "Only loopback host names are served", 403))
                return
            route = self.route()
            if route != "/health":
                self.fail(ServiceError("not_found", "Unknown endpoint", 404))
                return
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            try:
                self.send_json(service.health(refresh=query.get("refresh") == ["1"]))
            except Exception:
                self.fail(ServiceError("internal_error", "Health check failed", 500))

        def do_OPTIONS(self):
            if self.route() not in BODY_LIMITS or not self.origin_allowed() or not self.host_allowed():
                self.fail(ServiceError("origin_denied", "Browser origin is not allowed", 403))
                return
            self.send_response(204)
            if self.headers.get("Origin"):
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            try:
                route = self.route()
                if route not in BODY_LIMITS:
                    raise ServiceError("not_found", "Unknown endpoint", 404)
                if not self.host_allowed():
                    raise ServiceError("host_denied", "Only loopback host names are served", 403)
                if not self.origin_allowed():
                    raise ServiceError("origin_denied", "Browser origin is not allowed", 403)
                if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                    raise ServiceError("invalid_request", "Use length-delimited application/json", 415)
                length_text = self.headers.get("Content-Length", "")
                if not length_text.isascii() or not length_text.isdecimal():
                    raise ServiceError("invalid_request", "Content-Length is required", 411)
                length = int(length_text)
                if not 1 <= length <= BODY_LIMITS[route]:
                    raise ServiceError("request_too_large", "Request exceeds the size limit", 413)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ServiceError("invalid_request", "Incomplete request body")
                try:
                    value = strict_json(raw)
                except (ValueError, UnicodeDecodeError, RecursionError):
                    raise ServiceError("invalid_request", "Request must be strict JSON") from None
                if route == "/decide":
                    self.send_json(service.decider.decide(value))
                elif route == "/critique":
                    self.send_json(service.critic.critique(value))
                else:
                    self.send_json(service.tinker.chat(value))
            except ServiceError as exc:
                self.fail(exc)
            except ProviderError as exc:
                self.fail(ServiceError(exc.code, str(exc), exc.status))
            except (TimeoutError, socket.timeout):
                self.fail(ServiceError("request_timeout", "Request body timed out", 408))
            except Exception:
                self.fail(ServiceError("internal_error", "ai-service failed; no action issued", 500))

    return Handler


def create_server(settings, providers=None, port=None, store=None, transport=None):
    service = AIService(settings, store=store, providers=providers, transport=transport)
    server = ThreadingHTTPServer(("127.0.0.1", settings.port if port is None else port), handler_for(service))
    server.daemon_threads = True
    return server, service


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, default=None, help="config.json (default: ai-service/config.json; optional)")
    parser.add_argument("--port", type=int, help="override the port (default 18383 or config port)")
    parser.add_argument("--contracts", type=Path, default=None, help="directory with design/look schemas")
    parser.add_argument("--check", action="store_true", help="print health once and exit (no inference)")
    args = parser.parse_args()
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("--port must be 1024..65535")
    settings = load_settings(args.config, contracts_dir=args.contracts, port=args.port)
    warn(settings.problems)
    try:
        store = SchemaStore(settings.contracts_dir)
    except SchemaUnavailable as exc:
        print(f"ai-service: {exc} (looked in {settings.contracts_dir})", file=sys.stderr)
        raise SystemExit(2)
    if args.check:
        print(json.dumps(AIService(settings, store=store).health(refresh=True), indent=2))
        return
    server, _ = create_server(settings, store=store)
    print(describe(settings), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
