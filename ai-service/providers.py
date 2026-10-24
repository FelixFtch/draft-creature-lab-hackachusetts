"""OpenAI-compatible chat-completion providers for Tinker's brain and eyes.

Two roles share one client type:
  brain - the chat/design LLM behind POST /chat
  eyes  - the vision model behind POST /decide and POST /critique

Safety posture (kept from vlm-service): no redirects, bounded response size,
timeouts, strict JSON envelopes, keys only in an Authorization header, and no
provider body, request data or key ever copied into an error, response or log.
Remote providers must use HTTPS on a host that belongs to their preset; plain
HTTP is only accepted for loopback servers (Ollama, LM Studio, custom local).

Endpoints and model ids were checked against the providers' official docs in
October 2026; see README.md ("Sources") for the links.
"""
from __future__ import annotations

import ipaddress
import json
import math
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
DEFAULT_RESPONSE_LIMIT = 1024 * 1024
KEY_PATTERN = re.compile(r"[\x21-\x7e]{8,512}")
ENV_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,159}")
WORKSPACE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-]{0,63}")
REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high"}
PROTECTED_BODY_KEYS = {"model", "messages", "stream", "n", "tools", "tool_choice", "functions", "function_call",
                       "response_format", "stream_options", "logprobs", "top_logprobs"}

# Every preset is an OpenAI-compatible chat-completions endpoint. "hosts" is
# the allow-list for a base_url override (suffix match); None = loopback only
# (local presets) or any HTTPS host (custom, which the user typed explicitly).
PRESETS = {
    "ollama": {
        "label": "Ollama on this computer",
        "base_url": "http://127.0.0.1:11434/v1",
        "local_only": True,
        "key_env": (),
        "key_required": False,
        "health": "ollama",
        "json_mode": True,
        "params": {},
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 512,
        "strict_model_echo": True,
        "defaults": {},  # chosen by scripts/setup-local-ai.sh from the Mac's RAM
    },
    "lmstudio": {
        "label": "LM Studio on this computer",
        "base_url": "http://127.0.0.1:1234/v1",
        "local_only": True,
        "key_env": ("LM_API_TOKEN",),
        "key_required": False,
        "health": "models",
        "json_mode": False,  # LM Studio accepts json_schema, not json_object
        "params": {},
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 512,
        "strict_model_echo": False,
        "defaults": {},
    },
    "dashscope": {
        "label": "Qwen on Alibaba Cloud Model Studio (international, Singapore)",
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "workspace_url": "https://{workspace}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        "hosts": ("aliyuncs.com",),
        "key_env": ("DASHSCOPE_API_KEY",),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        # Qwen3.5+ models think by default; a design chat wants direct answers.
        "params": {"enable_thinking": False},
        # Model Studio recommends no system message for vision requests.
        "merge_system_with_image": True,
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 0,
        "strict_model_echo": False,
        "defaults": {"brain": "qwen3.8-flash", "eyes": "qwen3.8-flash"},
    },
    "dashscope-cn": {
        "label": "Qwen on Alibaba Cloud Bailian (mainland China, Beijing)",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "workspace_url": "https://{workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        "hosts": ("aliyuncs.com",),
        "key_env": ("DASHSCOPE_API_KEY",),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        "params": {"enable_thinking": False},
        "merge_system_with_image": True,
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 0,
        "strict_model_echo": False,
        "defaults": {"brain": "qwen3.8-flash", "eyes": "qwen3.8-flash"},
    },
    "dashscope-us": {
        "label": "Qwen on Alibaba Cloud Model Studio (US, Virginia)",
        "base_url": None,  # workspace-specific domain only
        "workspace_url": "https://{workspace}.us-east-1.maas.aliyuncs.com/compatible-mode/v1",
        "hosts": ("aliyuncs.com",),
        "key_env": ("DASHSCOPE_API_KEY",),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        "params": {"enable_thinking": False},
        "merge_system_with_image": True,
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 0,
        "strict_model_echo": False,
        "defaults": {"brain": "qwen3.8-flash", "eyes": "qwen3.8-flash"},
    },
    "zhipu": {
        "label": "Zhipu GLM on Z.ai (international)",
        "base_url": "https://api.z.ai/api/paas/v4",
        "hosts": ("z.ai",),
        "key_env": ("ZHIPUAI_API_KEY", "ZAI_API_KEY"),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        # GLM-4.6V / GLM-4.7 accept disabling thinking; GLM-5.3 ignores or
        # rejects it, which the one-time safe-payload retry absorbs.
        "params": {"thinking": {"type": "disabled"}},
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 1024,
        "strict_model_echo": False,
        "defaults": {"brain": "glm-4.7-flash", "eyes": "glm-4.6v-flash"},
    },
    "zhipu-cn": {
        "label": "Zhipu GLM on BigModel (mainland China)",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "hosts": ("bigmodel.cn",),
        "key_env": ("ZHIPUAI_API_KEY", "ZAI_API_KEY"),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        "params": {"thinking": {"type": "disabled"}},
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 1024,
        "strict_model_echo": False,
        "defaults": {"brain": "glm-4.7-flash", "eyes": "glm-4.6v-flash"},
    },
    "gemini": {
        "label": "Google Gemini (OpenAI-compatible endpoint)",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "hosts": ("googleapis.com",),
        "key_env": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        "params": {},
        # Gemini 3 models cannot switch reasoning off; keep it short and leave
        # room in the output budget for the thoughts.
        "reasoning_effort": "low",
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 2048,
        "strict_model_echo": False,
        "defaults": {"brain": "gemini-3.8-flash", "eyes": "gemini-3.8-flash"},
    },
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "hosts": ("openai.com",),
        "key_env": ("OPENAI_API_KEY",),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        "params": {},
        "reasoning_effort": "none",
        "token_param": "max_completion_tokens",
        "temperature": False,
        "min_output_tokens": 0,
        "strict_model_echo": False,
        "defaults": {"brain": "gpt-6-luna", "eyes": "gpt-6-luna"},
    },
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "hosts": ("openrouter.ai",),
        "key_env": ("OPENROUTER_API_KEY",),
        "key_required": True,
        "health": "models",
        "json_mode": True,
        "params": {},
        "headers": {"X-Title": "Draft Creature Lab"},
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 1024,
        "strict_model_echo": False,
        "defaults": {"brain": "qwen/qwen3.8-flash", "eyes": "qwen/qwen3.8-flash"},
    },
    "custom": {
        "label": "Custom OpenAI-compatible endpoint",
        "base_url": None,
        "hosts": None,
        "key_env": (),
        "key_required": False,
        "health": "models",
        "json_mode": True,
        "params": {},
        "token_param": "max_tokens",
        "temperature": True,
        "min_output_tokens": 512,
        "strict_model_echo": None,  # strict for loopback servers, relaxed for remote
        "defaults": {},
    },
}


class ProviderError(Exception):
    """A provider failure with a fixed, non-sensitive message."""

    def __init__(self, code, message, status=502, http_status=None):
        super().__init__(message)
        self.code, self.status, self.http_status = code, status, http_status


class Secret:
    """Holds an API key; its repr/str never show the value."""

    __slots__ = ("_value",)

    def __init__(self, value):
        self._value = value

    def reveal(self):
        return self._value

    def __repr__(self):
        return "Secret(****)"

    __str__ = __repr__

    def __bool__(self):
        return bool(self._value)


def is_loopback_host(host):
    if not host:
        return False
    host = host.strip("[]").lower()
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _host_matches(host, suffixes):
    host = (host or "").lower().rstrip(".")
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def normalise_base_url(value, preset_name):
    """Validate a base URL for a preset; return it without a trailing slash."""
    if not isinstance(value, str) or not 8 <= len(value) <= 300:
        raise ValueError("base_url must be a URL string")
    url = value.strip()
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    url = url.rstrip("/")
    parts = urllib.parse.urlsplit(url)
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("base_url must not contain credentials, a query or a fragment")
    try:
        parts.port  # noqa: B018 - raises ValueError for an invalid port
    except ValueError:
        raise ValueError("base_url has an invalid port") from None
    host = parts.hostname or ""
    preset = PRESETS[preset_name]
    loopback = is_loopback_host(host)
    if parts.scheme == "http":
        if not loopback:
            raise ValueError("Plain http is only allowed for servers on this computer (127.0.0.1/localhost)")
    elif parts.scheme != "https":
        raise ValueError("base_url must use https (or http on loopback)")
    if preset.get("local_only") and not loopback:
        raise ValueError(f"The {preset_name} preset only talks to a server on this computer")
    hosts = preset.get("hosts")
    if hosts and not _host_matches(host, hosts):
        raise ValueError(f"The {preset_name} preset only accepts hosts under {', '.join(hosts)}; use provider 'custom' for other gateways")
    if not host or any(c.isspace() for c in url):
        raise ValueError("base_url is not a valid URL")
    return url


class RoleConfig:
    """Resolved configuration of one role. The key is held in a Secret."""

    FIELDS = {"provider", "model", "base_url", "api_key_env", "workspace_id", "timeout_seconds",
              "max_tokens", "temperature", "reasoning_effort", "json_mode", "extra_body"}

    def __init__(self, role, provider, model, base_url, key_names, key, key_error=None, *, workspace_id=None,
                 timeout=None, max_tokens=None, temperature=None, reasoning_effort=None, json_mode=None,
                 extra_body=None):
        self.role, self.provider, self.model = role, provider, model
        self.base_url, self.key_names, self.key, self.key_error = base_url, tuple(key_names), key, key_error
        self.workspace_id = workspace_id
        self.preset = PRESETS[provider]
        host = urllib.parse.urlsplit(base_url).hostname
        self.local = is_loopback_host(host)
        self.timeout = timeout if timeout is not None else (90.0 if self.local else 45.0)
        self.max_tokens, self.temperature = max_tokens, temperature
        self.reasoning_effort = reasoning_effort if reasoning_effort is not None else self.preset.get("reasoning_effort")
        self.json_mode = self.preset.get("json_mode", True) if json_mode is None else json_mode
        self.extra_body = extra_body or {}

    def __repr__(self):
        return f"RoleConfig(role={self.role!r}, provider={self.provider!r}, model={self.model!r}, local={self.local})"

    @property
    def label(self):
        return self.preset["label"]

    @property
    def strict_model_echo(self):
        strict = self.preset.get("strict_model_echo")
        return self.local if strict is None else bool(strict)

    def public(self):
        return {"provider": self.provider, "label": self.label, "model": self.model, "local": self.local}


def read_key(names, env, dotenv):
    """Return (Secret|None, error_code|None, found_name|None) without exposing values."""
    saw_invalid = False
    for name in names:
        value = env.get(name)
        if value is None:
            value = dotenv.get(name)
        if value is None or value == "":
            continue
        value = value.strip()
        if KEY_PATTERN.fullmatch(value):
            return Secret(value), None, name
        saw_invalid = True
    return None, ("invalid_api_key_format" if saw_invalid else None), None


def build_role(role, raw, env, dotenv):
    """Validate one role entry from config.json (or an AI_BRAIN/AI_EYES override)."""
    if not isinstance(raw, dict):
        raise ValueError(f"roles.{role} must be an object")
    unknown = set(raw) - RoleConfig.FIELDS
    if unknown:
        raise ValueError(f"roles.{role} has unsupported fields: {', '.join(sorted(unknown))}")
    provider = raw.get("provider")
    if provider not in PRESETS:
        raise ValueError(f"roles.{role}.provider must be one of {', '.join(PRESETS)}")
    preset = PRESETS[provider]
    model = raw.get("model") or preset["defaults"].get(role)
    if not isinstance(model, str) or not MODEL_PATTERN.fullmatch(model):
        raise ValueError(f"roles.{role}.model is required (1-160 characters, no spaces)")
    workspace = None
    if preset.get("workspace_url"):
        workspace = raw.get("workspace_id") or env.get("DASHSCOPE_WORKSPACE_ID") or dotenv.get("DASHSCOPE_WORKSPACE_ID")
    if raw.get("workspace_id") is not None and not preset.get("workspace_url"):
        raise ValueError(f"roles.{role}.workspace_id only applies to dashscope presets")
    if workspace is not None and (not isinstance(workspace, str) or not WORKSPACE_PATTERN.fullmatch(workspace)):
        raise ValueError(f"roles.{role}.workspace_id must be a Model Studio workspace id (letters, digits, -)")
    if raw.get("base_url") is not None:
        base_url = normalise_base_url(raw["base_url"], provider)
    elif workspace:
        base_url = normalise_base_url(preset["workspace_url"].format(workspace=workspace), provider)
    elif preset.get("base_url"):
        base_url = preset["base_url"]
    elif provider == "dashscope-us":
        raise ValueError(f"roles.{role}: dashscope-us needs workspace_id (or DASHSCOPE_WORKSPACE_ID)")
    else:
        raise ValueError(f"roles.{role}.base_url is required for provider {provider}")
    names = raw.get("api_key_env")
    if names is None:
        names = list(preset["key_env"])
    elif isinstance(names, str):
        names = [names]
    if not isinstance(names, list) or len(names) > 4 or not all(isinstance(n, str) and ENV_NAME_PATTERN.fullmatch(n) for n in names):
        raise ValueError(f"roles.{role}.api_key_env must name environment variables, never contain a key")
    timeout = raw.get("timeout_seconds")
    if timeout is not None and (not _finite(timeout) or not 1 <= timeout <= 300):
        raise ValueError(f"roles.{role}.timeout_seconds must be 1..300")
    max_tokens = raw.get("max_tokens")
    if max_tokens is not None and (type(max_tokens) is not int or not 64 <= max_tokens <= 16384):
        raise ValueError(f"roles.{role}.max_tokens must be an integer 64..16384")
    temperature = raw.get("temperature")
    if temperature is not None and (not _finite(temperature) or not 0 <= temperature <= 2):
        raise ValueError(f"roles.{role}.temperature must be 0..2")
    effort = raw.get("reasoning_effort")
    if effort is not None and effort not in REASONING_EFFORTS and effort != "default":
        raise ValueError(f"roles.{role}.reasoning_effort must be one of {', '.join(sorted(REASONING_EFFORTS))} or default")
    json_mode = raw.get("json_mode")
    if json_mode is not None and not isinstance(json_mode, bool):
        raise ValueError(f"roles.{role}.json_mode must be true or false")
    extra = raw.get("extra_body")
    if extra is not None:
        if not isinstance(extra, dict) or len(extra) > 8 or len(json.dumps(extra)) > 1024:
            raise ValueError(f"roles.{role}.extra_body must be a small object")
        bad = [k for k in extra if not isinstance(k, str) or k in PROTECTED_BODY_KEYS or not ENV_NAME_PATTERN.fullmatch(k)]
        if bad:
            raise ValueError(f"roles.{role}.extra_body may not set {', '.join(map(str, bad))}")
    key, key_error, _ = read_key(names, env, dotenv)
    return RoleConfig(role, provider, model, base_url, names, key, key_error, workspace_id=workspace,
                      timeout=float(timeout) if timeout is not None else None, max_tokens=max_tokens,
                      temperature=temperature, reasoning_effort=None if effort == "default" else effort,
                      json_mode=json_mode, extra_body=extra)


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # a redirect becomes an HTTPError; keys never follow it


def _strict_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _no_constants(_):
    raise ValueError("Non-finite JSON constant")


def strict_json(value):
    return json.loads(value, object_pairs_hook=_strict_pairs, parse_constant=_no_constants)


class HttpTransport:
    """urllib transport. Loopback traffic never goes through a proxy; remote
    HTTPS honours the system proxy settings (some users need one to reach a
    cloud provider) and verifies certificates."""

    def __init__(self):
        self.local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        context = ssl.create_default_context()
        self.remote_opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))

    @property
    def opener(self):  # legacy name used by the ported vlm-service tests
        return self.local_opener

    def request(self, url, payload, headers, timeout, limit, local):
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode() if payload is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
        opener = self.local_opener if local else self.remote_opener
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(limit + 1)
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                exc.close()  # never read or echo the provider's error body
            except Exception:
                pass
            raise http_error(status) from None
        except (TimeoutError, socket.timeout):
            raise ProviderError("provider_timeout", "Provider request timed out", 504) from None
        except ssl.SSLError:
            raise ProviderError("provider_tls_error", "Could not verify the provider's TLS certificate", 502) from None
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise ProviderError("provider_timeout", "Provider request timed out", 504) from None
            if isinstance(exc.reason, ssl.SSLError):
                raise ProviderError("provider_tls_error", "Could not verify the provider's TLS certificate", 502) from None
            raise ProviderError("provider_offline", "Provider is unavailable", 503) from None
        except (ConnectionError, OSError):
            raise ProviderError("provider_offline", "Provider is unavailable", 503) from None
        if len(raw) > limit:
            raise ProviderError("invalid_model_response", "Provider response exceeded the size limit", 502)
        try:
            return strict_json(raw)
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ProviderError("invalid_model_response", "Provider response was not valid JSON", 502) from None


def http_error(status):
    if status in (401, 403):
        return ProviderError("provider_auth_error",
                             f"Provider rejected the request (HTTP {status}); check the API key, its region and model access",
                             502, status)
    if status == 404:
        return ProviderError("provider_not_found",
                             "Provider endpoint or model was not found (HTTP 404); check the model id (for Ollama: ollama pull <model>)",
                             502, status)
    if status == 429:
        return ProviderError("provider_rate_limited", "Provider rate limit or quota reached (HTTP 429)", 503, status)
    if 300 <= status < 400:
        return ProviderError("provider_http_error", f"Provider tried to redirect (HTTP {status}); redirects are not followed", 502, status)
    return ProviderError("provider_http_error", f"Provider returned HTTP {status}", 502, status)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class OpenAICompatibleProvider:
    def __init__(self, config, transport=None):
        self.config = config
        self.preset = config.preset
        self.transport = transport or HttpTransport()
        self._safe_only = False
        self._lock = threading.Lock()

    # Identity -----------------------------------------------------------
    @property
    def name(self):
        return self.config.provider

    @property
    def model(self):
        return self.config.model

    @property
    def local(self):
        return self.config.local

    @property
    def chat_url(self):
        return self.config.base_url + "/chat/completions"

    def info(self):
        return self.config.public()

    def headers(self):
        headers = {"Content-Type": "application/json", "Accept": "application/json",
                   "User-Agent": "DraftCreatureLab-ai-service/2"}
        if self.config.key:
            headers["Authorization"] = "Bearer " + self.config.key.reveal()
        headers.update(self.preset.get("headers", {}))
        return headers

    def missing_key(self):
        return self.preset.get("key_required") and not self.config.key

    # Requests -----------------------------------------------------------
    def build_payload(self, messages, *, max_tokens=512, temperature=0.0, json_mode=False, safe=False):
        payload = {"model": self.config.model, "messages": messages, "stream": False}
        if safe:
            return payload
        budget = max(int(max_tokens), int(self.preset.get("min_output_tokens") or 0))
        if self.config.max_tokens:
            budget = self.config.max_tokens
        payload[self.preset.get("token_param", "max_tokens")] = budget
        if self.preset.get("temperature", True):
            payload["temperature"] = self.config.temperature if self.config.temperature is not None else temperature
        if json_mode and self.config.json_mode:
            payload["response_format"] = {"type": "json_object"}
        if self.config.reasoning_effort:
            payload["reasoning_effort"] = self.config.reasoning_effort
        for key, value in self.preset.get("params", {}).items():
            payload[key] = value
        for key, value in self.config.extra_body.items():
            payload[key] = value
        return payload

    def prepare_messages(self, messages):
        """Apply preset quirks to an OpenAI-style message list."""
        has_image = any(isinstance(m.get("content"), list) and any(p.get("type") == "image_url" for p in m["content"])
                        for m in messages)
        if not (has_image and self.preset.get("merge_system_with_image")):
            return messages
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system" and isinstance(m["content"], str))
        rest = [dict(m) for m in messages if m["role"] != "system"]
        for message in rest:
            if message["role"] == "user":
                content = message["content"]
                if isinstance(content, list):
                    message["content"] = [{"type": "text", "text": system}] + list(content)
                else:
                    message["content"] = system + "\n\n" + content
                break
        return rest

    def complete(self, messages, *, max_tokens=512, temperature=0.0, json_mode=False, limit=DEFAULT_RESPONSE_LIMIT,
                 timeout=None):
        """Send one chat completion and return the parsed provider envelope.

        If the provider rejects our optional parameters (HTTP 400/422: e.g. no
        JSON mode, unknown reasoning field, different token parameter), retry
        once with only model/messages/stream and remember that for later calls.
        """
        if self.missing_key():
            raise ProviderError("provider_missing_key",
                                f"No API key: set {' or '.join(self.config.key_names)} in the environment or ai-service/.env.local",
                                503)
        messages = self.prepare_messages(messages)
        timeout = timeout or self.config.timeout
        with self._lock:
            safe_only = self._safe_only
        payload = self.build_payload(messages, max_tokens=max_tokens, temperature=temperature, json_mode=json_mode,
                                     safe=safe_only)
        try:
            return self.transport.request(self.chat_url, payload, self.headers(), timeout, limit, self.local)
        except ProviderError as exc:
            if safe_only or exc.http_status not in (400, 422):
                raise
        payload = self.build_payload(messages, safe=True)
        result = self.transport.request(self.chat_url, payload, self.headers(), timeout, limit, self.local)
        with self._lock:
            self._safe_only = True
        return result

    # Health ---------------------------------------------------------------
    def health(self):
        """Cheap reachability check; never runs inference."""
        base = {"configured": True, **self.info(), "reachable": False, "ready": False}
        if self.config.key_error:
            return {**base, "reachable": None, "error": self.config.key_error,
                    "hint": f"{' or '.join(self.config.key_names)} is not a valid API key string"}
        if self.missing_key():
            return {**base, "reachable": None, "error": "provider_missing_key",
                    "hint": f"Set {' or '.join(self.config.key_names)}"}
        timeout = 2.0 if self.local else 5.0
        started = time.monotonic()
        try:
            if self.preset.get("health") == "ollama":
                root = self.config.base_url[:-3] if self.config.base_url.endswith("/v1") else self.config.base_url
                result = self.transport.request(root + "/api/tags", None, self.headers(), timeout, 512 * 1024, self.local)
                names = set()
                for item in (result.get("models") if isinstance(result, dict) else None) or []:
                    if isinstance(item, dict):
                        for field in ("name", "model"):
                            if isinstance(item.get(field), str):
                                names.add(_strip_latest(item[field]))
                available = _strip_latest(self.config.model) in names
                status = {**base, "reachable": True, "ready": available, "modelAvailable": available}
                if not available:
                    status["error"] = "model_not_pulled"
                    status["hint"] = f"Run: ollama pull {self.config.model}"
            else:
                result = self.transport.request(self.config.base_url + "/models", None, self.headers(), timeout,
                                                2 * 1024 * 1024, self.local)
                listed = _model_listed(result, self.config.model)
                status = {**base, "reachable": True, "ready": listed is not False, "modelListed": listed}
                if listed is False:
                    status["error"] = "model_not_listed"
                    status["hint"] = "The provider's model list does not include this model id"
        except ProviderError as exc:
            if exc.http_status == 404 and self.preset.get("health") != "ollama":
                # The server answered but has no model list; assume usable.
                status = {**base, "reachable": True, "ready": True, "modelListed": None}
            else:
                status = {**base, "reachable": exc.http_status is not None, "error": exc.code}
        status["latencyMs"] = round((time.monotonic() - started) * 1000)
        return status


def _strip_latest(name):
    return name[:-7] if name.endswith(":latest") else name


def same_model(reported, requested):
    return _strip_latest(reported) == _strip_latest(requested)


def _model_listed(result, model):
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, list):
        data = result.get("models") if isinstance(result, dict) else None
    if not isinstance(data, list):
        return None
    ids = set()
    for item in data:
        if isinstance(item, dict):
            for field in ("id", "name"):
                value = item.get(field)
                if isinstance(value, str):
                    ids.add(value[7:] if value.startswith("models/") else value)
    if not ids:
        return None
    return model in ids or _strip_latest(model) in ids


def message_content(response, *, allow_parts=True):
    """Extract assistant text from a chat-completions envelope (lenient form
    used by /chat and /critique; /decide keeps its own strict parser)."""
    try:
        choices = response["choices"]
        if not isinstance(choices, list) or not choices:
            raise ValueError
        choice = choices[0]
        message = choice["message"]
        if not isinstance(message, dict):
            raise ValueError
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProviderError("invalid_model_response", "Provider did not return a chat completion", 502) from None
    if message.get("tool_calls") or message.get("function_call"):
        raise ProviderError("invalid_model_response", "Provider returned a tool call instead of text", 502)
    if message.get("refusal"):
        raise ProviderError("model_refused", "The model declined this request", 502)
    content = message.get("content")
    if isinstance(content, list) and allow_parts:
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") in ("text", "output_text"))
    if not isinstance(content, str):
        raise ProviderError("invalid_model_response", "Provider returned no text", 502)
    if choice.get("finish_reason") == "length":
        raise ProviderError("model_output_truncated", "The model ran out of output tokens", 502)
    return content
