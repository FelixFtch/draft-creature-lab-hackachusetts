"""Configuration for ai-service.

Sources, in order of precedence:
  1. AI_BRAIN / AI_EYES environment variables ("<preset>:<model>", optional)
  2. ai-service/config.json (git-ignored; see config.example.json)
  3. nothing configured -> Tinker runs its offline designer, vision routes 503

API keys are read only from environment variables or the git-ignored
ai-service/.env.local. They are never accepted in config.json, never sent to
the browser and never printed. A broken AI configuration must not take the
whole lab down, so problems disable the affected role and are reported in
GET /health instead of crashing the service.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.parse

from providers import PRESETS, build_role, is_loopback_host, normalise_base_url, strict_json

DEFAULT_PORT = 18383
DEFAULT_LAB_PORT = 18381
SERVICE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SERVICE_DIR / "config.json"
DEFAULT_DOTENV = SERVICE_DIR / ".env.local"
DEFAULT_CONTRACTS = SERVICE_DIR.parent / "contracts"
MAX_CONFIG_BYTES = 64 * 1024
TOP_LEVEL_FIELDS = {"port", "allowed_origins", "roles", "comment"}
LEGACY_FIELDS = {"endpoint", "model", "port", "request_timeout_seconds", "allowed_origins", "api_key_env"}
ROLES = ("brain", "eyes")


class Settings:
    def __init__(self, port, allowed_origins, roles, problems, config_path, contracts_dir, source):
        self.port = port
        self.allowed_origins = allowed_origins
        self.roles = roles            # role -> RoleConfig | None
        self.problems = problems      # list of non-sensitive strings
        self.config_path = config_path
        self.contracts_dir = contracts_dir
        self.source = source

    def __repr__(self):
        return f"Settings(port={self.port}, roles={self.roles!r}, source={self.source!r})"


def parse_dotenv(text):
    """Minimal KEY=VALUE parser (export prefix, quotes, comments)."""
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def load_dotenv(path, problems):
    path = Path(path)
    try:
        info = path.stat()
    except OSError:
        return {}
    if info.st_size > MAX_CONFIG_BYTES:
        problems.append(f"{path.name} is too large; ignored")
        return {}
    if os.name == "posix" and info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        # Only a hint; the file content is never printed.
        problems.append(f"{path.name} is readable by other users; consider: chmod 600 {path}")
    try:
        return parse_dotenv(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        problems.append(f"{path.name} could not be read; ignored")
        return {}


def validate_origin(value):
    if not isinstance(value, str):
        raise ValueError("Allowed browser origins must be strings")
    origin = urllib.parse.urlsplit(value)
    if (origin.scheme not in {"http", "https"} or not is_loopback_host(origin.hostname)
            or origin.path or origin.query or origin.fragment or origin.username or origin.password):
        raise ValueError("Allowed browser origins must be exact loopback origins such as http://127.0.0.1:18381")
    return value


def origins_for_port(port):
    return [f"http://127.0.0.1:{port}", f"http://localhost:{port}"]


def _port(value):
    return type(value) is int and 1024 <= value <= 65535


def parse_override(value):
    """AI_BRAIN / AI_EYES = '<preset>:<model>' (model may itself contain ':' or '/')."""
    preset, sep, model = value.strip().partition(":")
    if not sep or preset not in PRESETS or not model:
        raise ValueError("expected <preset>:<model>, e.g. ollama:qwen3.5:4b or dashscope:qwen3.8-flash")
    return {"provider": preset, "model": model}


def _legacy_to_roles(config):
    """Accept an old vlm-service/config.json: its endpoint becomes the eyes role."""
    endpoint = config.get("endpoint")
    if not isinstance(endpoint, str):
        raise ValueError("Legacy config needs an endpoint")
    eyes = {"provider": "custom", "base_url": endpoint, "model": config.get("model")}
    if config.get("api_key_env") is not None:
        eyes["api_key_env"] = config["api_key_env"]
    if config.get("request_timeout_seconds") is not None:
        eyes["timeout_seconds"] = config["request_timeout_seconds"]
    normalise_base_url(endpoint, "custom")  # fail early with a clear message
    return {"eyes": eyes}


def load_settings(config_path=None, *, env=None, dotenv_path=None, contracts_dir=None, port=None):
    env = os.environ if env is None else env
    problems = []
    config_path = Path(config_path) if config_path else DEFAULT_CONFIG
    dotenv = load_dotenv(dotenv_path or config_path.with_name(".env.local"), problems)
    config, source = {}, "none"
    if config_path.is_file():
        try:
            if config_path.stat().st_size > MAX_CONFIG_BYTES:
                raise ValueError("config file is too large")
            config = strict_json(config_path.read_text(encoding="utf-8"))
            if not isinstance(config, dict):
                raise ValueError("config must be a JSON object")
            source = "file"
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            problems.append(f"{config_path.name} ignored: {exc}")
            config = {}
    raw_roles = {}
    if config:
        if "endpoint" in config and set(config) <= LEGACY_FIELDS:
            try:
                raw_roles = _legacy_to_roles(config)
                source = "legacy-file"
            except ValueError as exc:
                problems.append(f"legacy config ignored: {exc}")
        else:
            unknown = set(config) - TOP_LEVEL_FIELDS
            if unknown:
                problems.append(f"{config_path.name}: unsupported fields ignored: {', '.join(sorted(unknown))}")
            roles_value = config.get("roles", {})
            if not isinstance(roles_value, dict):
                problems.append("roles must be an object; ignored")
                roles_value = {}
            for role, value in roles_value.items():
                if role not in ROLES:
                    problems.append(f"roles.{role}: unknown role ignored (use brain or eyes)")
                    continue
                raw_roles[role] = value
            if raw_roles.get("eyes") == "brain":
                raw_roles["eyes"] = raw_roles.get("brain")
    for role in ROLES:
        override = env.get("AI_" + role.upper())
        if override:
            try:
                raw_roles[role] = parse_override(override)
                source = source + "+env" if source != "none" else "env"
            except ValueError as exc:
                problems.append(f"AI_{role.upper()} ignored: {exc}")
    roles = {}
    for role in ROLES:
        raw = raw_roles.get(role)
        if raw is None:
            roles[role] = None
            continue
        try:
            roles[role] = build_role(role, raw, env, dotenv)
        except ValueError as exc:
            problems.append(str(exc))
            roles[role] = None
    chosen_port = port if port is not None else config.get("port", DEFAULT_PORT)
    if not _port(chosen_port):
        problems.append("port must be 1024..65535; using 18383")
        chosen_port = DEFAULT_PORT
    origins = []
    configured = config.get("allowed_origins")
    if configured is not None:
        if not isinstance(configured, list) or len(configured) > 8:
            problems.append("allowed_origins must be a list of at most 8 loopback origins; ignored")
        else:
            for value in configured:
                try:
                    origins.append(validate_origin(value))
                except ValueError as exc:
                    problems.append(str(exc))
    lab_port = env.get("LAB_PORT")
    if lab_port and lab_port.isdecimal() and _port(int(lab_port)):
        origins += origins_for_port(int(lab_port))
    if not origins:
        origins = origins_for_port(DEFAULT_LAB_PORT)
    origins = list(dict.fromkeys(origins))
    contracts = Path(contracts_dir or env.get("AI_CONTRACTS_DIR") or DEFAULT_CONTRACTS)
    return Settings(chosen_port, origins, roles, problems, config_path, contracts, source)


def warn(problems):
    for problem in problems:
        print(f"ai-service: {problem}", file=sys.stderr, flush=True)


def describe(settings):
    """Startup line: provider names and models only, never keys."""
    roles = {role: (cfg.public() if cfg else None) for role, cfg in settings.roles.items()}
    return json.dumps({"service": "draft_ai_service", "url": f"http://127.0.0.1:{settings.port}", "roles": roles,
                       "configSource": settings.source, "offlineDesigner": True, "executesMotion": False})
