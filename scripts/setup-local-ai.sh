#!/usr/bin/env bash
# Set up a local vision-language model for Draft Creature Lab on a Mac.
#
#   1. detect the chip and memory (sysctl)
#   2. install Ollama if missing (Homebrew when present, otherwise print the
#      official install instructions) and start it if it is not running
#   3. pick a vision model that fits this Mac's RAM (override with --model)
#   4. ollama pull it, then smoke-test one image through /v1/chat/completions
#   5. write ai-service/config.json so Tinker (brain) and AI Explore (eyes)
#      both use it
#
# Safe to re-run: an installed Ollama, a downloaded model and an unchanged
# config are detected and left alone. Nothing leaves this computer except the
# Ollama/Homebrew downloads themselves. Bash 3.2 compatible (macOS default).
set -euo pipefail

LAB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$LAB_ROOT/ai-service/config.json"
MODEL=""
MODEL_FROM_USER=0
DRY_RUN=0
SKIP_SMOKE=0
UPDATE=0
ROLES="brain,eyes"
SMOKE_TIMEOUT=300
# 64x64 solid red PNG: the smoke test asks the model which colour it sees.
RED_PNG="iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsMvk0/4lbGME38JgBZbpei0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFWR9RLdC20y0AAAAASUVORK5CYII="

usage() {
  cat <<'EOF'
Usage: scripts/setup-local-ai.sh [options]

Installs/starts Ollama, downloads a vision model sized for this Mac and points
the lab's ai-service at it.

Options:
  --model TAG       use this Ollama model instead of the RAM-based choice
                    (e.g. qwen3.5:4b, qwen3-vl:8b-instruct, gemma4:e4b)
  --roles LIST      which ai-service roles to configure: brain,eyes (default),
                    brain or eyes - e.g. keep a cloud brain and run eyes locally
  --dry-run         show what would happen; install, start, pull and write nothing
  --skip-smoke      do not send the test image to the model
  --update          re-pull the model even if it is already downloaded
  --config PATH     write this config file instead of ai-service/config.json
  -h, --help        show this help

Default models (Ollama library tags, October 2026):
  less than 12 GB RAM  qwen3-vl:2b-instruct  (~1.9 GB download)
  12-23 GB RAM         qwen3.5:4b            (~3.3-4.0 GB)
  24 GB RAM or more    qwen3.5:9b            (~6.6-7.6 GB)
  Intel Macs (CPU only) always get qwen3-vl:2b-instruct.
EOF
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { local code="$1"; shift; printf 'error: %s\n' "$*" >&2; exit "$code"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --model) [ $# -ge 2 ] || die 2 "--model needs a tag"; MODEL="$2"; MODEL_FROM_USER=1; shift 2 ;;
    --model=*) MODEL="${1#--model=}"; MODEL_FROM_USER=1; shift ;;
    --roles) [ $# -ge 2 ] || die 2 "--roles needs brain,eyes"; ROLES="$2"; shift 2 ;;
    --roles=*) ROLES="${1#--roles=}"; shift ;;
    --config) [ $# -ge 2 ] || die 2 "--config needs a path"; CONFIG="$2"; shift 2 ;;
    --config=*) CONFIG="${1#--config=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --update) UPDATE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 2 "unknown option: $1" ;;
  esac
done

case "$ROLES" in
  brain,eyes|eyes,brain) ROLES="brain,eyes" ;;
  brain|eyes) ;;
  *) die 2 "--roles must be brain,eyes, brain or eyes" ;;
esac
if [ -n "$MODEL" ] && ! printf '%s' "$MODEL" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$'; then
  die 2 "--model must be an Ollama tag such as qwen3.5:4b"
fi

run() {
  # Print and run a command, or only print it in --dry-run mode.
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] $*"
  else
    "$@"
  fi
}

pick_python() {
  # Prefer the lab's own venv; avoid /usr/bin/python3 on a Mac without the
  # command line tools (it opens an install dialog instead of running).
  if [ -n "${DRAFT_PYTHON:-}" ] && [ -x "$DRAFT_PYTHON" ]; then printf '%s' "$DRAFT_PYTHON"; return 0; fi
  if [ -x "$LAB_ROOT/.venv/bin/python" ]; then printf '%s' "$LAB_ROOT/.venv/bin/python"; return 0; fi
  local candidate
  candidate="$(command -v python3 2>/dev/null || true)"
  if [ -z "$candidate" ]; then return 1; fi
  if [ "$candidate" = "/usr/bin/python3" ] && [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
    return 1
  fi
  printf '%s' "$candidate"
}
PYTHON="$(pick_python || true)"

# ---------------------------------------------------------------------------
step "Checking this computer"
OS="$(uname -s)"
ARCH="$(uname -m)"
RAM_BYTES=0
CHIP="unknown"
if [ "$OS" = "Darwin" ]; then
  RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
elif [ "$OS" = "Linux" ] && [ -r /proc/meminfo ]; then
  RAM_BYTES="$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)"
  CHIP="$(awk -F: '/model name/ {gsub(/^ +/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null || echo unknown)"
  warn "this script is written for macOS; on Linux it only configures an Ollama you installed yourself"
else
  die 2 "unsupported system: $OS"
fi
case "$RAM_BYTES" in ''|*[!0-9]*) RAM_BYTES=0 ;; esac
RAM_GB=$(( RAM_BYTES / 1073741824 ))
say "System: $OS $ARCH, chip: $CHIP, memory: ${RAM_GB} GB"

if [ -z "$MODEL" ]; then
  if [ "$OS" = "Darwin" ] && [ "$ARCH" != "arm64" ]; then
    MODEL="qwen3-vl:2b-instruct"
    REASON="Intel Mac: Ollama runs on the CPU only, so the smallest capable vision model keeps answers usable"
  elif [ "$RAM_GB" -eq 0 ]; then
    MODEL="qwen3-vl:2b-instruct"
    REASON="memory size unknown, so the smallest capable vision model is the safe choice"
  elif [ "$RAM_GB" -lt 12 ]; then
    MODEL="qwen3-vl:2b-instruct"
    REASON="${RAM_GB} GB is shared with macOS, the browser physics and training; a ~1.9 GB model leaves room for them"
  elif [ "$RAM_GB" -lt 24 ]; then
    MODEL="qwen3.5:4b"
    REASON="${RAM_GB} GB fits Qwen3.5 4B (~4 GB, natively multimodal) with room for the lab and training"
  else
    MODEL="qwen3.5:9b"
    REASON="${RAM_GB} GB comfortably fits Qwen3.5 9B (~7 GB), noticeably better at designing and seeing"
  fi
  say "Model: $MODEL ($REASON)"
else
  say "Model: $MODEL (chosen with --model)"
fi

# ---------------------------------------------------------------------------
step "Looking for Ollama"
OLLAMA_PORT=11434
OLLAMA_HOSTNAME=127.0.0.1
if [ -n "${OLLAMA_HOST:-}" ]; then
  hostport="${OLLAMA_HOST#http://}"
  hostport="${hostport#https://}"
  hostport="${hostport%%/*}"
  host="${hostport%:*}"
  port="${hostport##*:}"
  [ "$host" = "$hostport" ] && port=11434
  case "$host" in
    127.0.0.1|localhost|0.0.0.0|'') OLLAMA_HOSTNAME=127.0.0.1 ;;
    *) die 2 "OLLAMA_HOST=$OLLAMA_HOST is not on this computer; the lab only talks to a local Ollama" ;;
  esac
  case "$port" in ''|*[!0-9]*) die 2 "OLLAMA_HOST has an invalid port" ;; esac
  OLLAMA_PORT="$port"
fi
OLLAMA_URL="http://$OLLAMA_HOSTNAME:$OLLAMA_PORT"

find_ollama() {
  local candidate
  candidate="$(command -v ollama 2>/dev/null || true)"
  if [ -n "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  for candidate in "/Applications/Ollama.app/Contents/Resources/ollama" "$HOME/Applications/Ollama.app/Contents/Resources/ollama"; do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

OLLAMA_BIN="$(find_ollama || true)"
if [ -z "$OLLAMA_BIN" ]; then
  if command -v brew >/dev/null 2>&1; then
    say "Ollama is not installed; installing it with Homebrew (formula 'ollama')."
    run brew install ollama
    OLLAMA_BIN="$(find_ollama || true)"
    if [ -z "$OLLAMA_BIN" ] && [ "$DRY_RUN" -eq 1 ]; then OLLAMA_BIN="ollama"; fi
    [ -n "$OLLAMA_BIN" ] || die 3 "Homebrew finished but the ollama command was not found"
  else
    say "Ollama is not installed and Homebrew is not available."
    say ""
    say "Install Ollama with the official installer, then run this script again:"
    say "  curl -fsSL https://ollama.com/install.sh | sh"
    say "or download https://ollama.com/download/Ollama.dmg, drag Ollama into Applications and open it once."
    say "(Ollama needs macOS 14 Sonoma or newer.)"
    exit 3
  fi
fi
say "Ollama command: $OLLAMA_BIN"

api_get() {
  # Loopback only, never through a proxy.
  curl -fsS --noproxy '*' --max-time "${2:-5}" "$OLLAMA_URL$1"
}

if VERSION_JSON="$(api_get /api/version 3 2>/dev/null)"; then
  say "Ollama is running at $OLLAMA_URL ($VERSION_JSON)"
else
  say "Ollama is not running yet; starting it."
  if [ "$OS" = "Darwin" ] && [ -d "/Applications/Ollama.app" ] && [ "$OLLAMA_PORT" = "11434" ]; then
    run open -a Ollama
  elif command -v brew >/dev/null 2>&1 && brew list --formula ollama >/dev/null 2>&1; then
    run brew services start ollama
  else
    mkdir -p "$HOME/.ollama/logs" 2>/dev/null || true
    if [ "$DRY_RUN" -eq 1 ]; then
      say "[dry-run] OLLAMA_HOST=$OLLAMA_HOSTNAME:$OLLAMA_PORT nohup $OLLAMA_BIN serve &"
    else
      OLLAMA_HOST="$OLLAMA_HOSTNAME:$OLLAMA_PORT" nohup "$OLLAMA_BIN" serve >>"$HOME/.ollama/logs/draft-lab-serve.log" 2>&1 &
    fi
  fi
  if [ "$DRY_RUN" -eq 0 ]; then
    tries=0
    until api_get /api/version 2 >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -le 60 ] || die 5 "Ollama did not start within 60 s. Open the Ollama app (or run: ollama serve) and try again."
      sleep 1
    done
    say "Ollama is up."
  fi
fi

# ---------------------------------------------------------------------------
step "Downloading $MODEL"
model_present() {
  local tags
  tags="$(api_get /api/tags 5 2>/dev/null)" || return 1
  if [ -n "$PYTHON" ]; then
    printf '%s' "$tags" | "$PYTHON" -c '
import json, sys
want = sys.argv[1]
strip = lambda n: n[:-7] if n.endswith(":latest") else n
names = set()
for item in json.load(sys.stdin).get("models") or []:
    for key in ("name", "model"):
        if isinstance(item.get(key), str):
            names.add(strip(item[key]))
sys.exit(0 if strip(want) in names else 1)' "$MODEL"
  else
    printf '%s' "$tags" | grep -q "\"$MODEL\""
  fi
}

if [ "$DRY_RUN" -eq 1 ] && ! api_get /api/version 2 >/dev/null 2>&1; then
  say "[dry-run] $OLLAMA_BIN pull $MODEL"
elif model_present && [ "$UPDATE" -eq 0 ]; then
  say "$MODEL is already downloaded (use --update to refresh it)."
else
  run "$OLLAMA_BIN" pull "$MODEL" || die 6 "ollama pull $MODEL failed. Check the tag on https://ollama.com/library and your internet connection; a newer model may need: brew upgrade ollama (or the latest Ollama app)."
fi

# ---------------------------------------------------------------------------
THINKING=0
VISION=1
if [ "$DRY_RUN" -eq 0 ]; then
  SHOW_JSON="$(curl -fsS --noproxy '*' --max-time 15 -H 'Content-Type: application/json' \
    -d "{\"model\": \"$MODEL\"}" "$OLLAMA_URL/api/show" 2>/dev/null || true)"
  if [ -n "$SHOW_JSON" ] && [ -n "$PYTHON" ]; then
    CAPS="$(printf '%s' "$SHOW_JSON" | "$PYTHON" -c '
import json, sys
try:
    info = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
caps = info.get("capabilities") or []
print(" ".join(c for c in caps if isinstance(c, str)))' || true)"
  else
    CAPS="$(printf '%s' "$SHOW_JSON" | tr -d ' \n' | grep -o '"capabilities":\[[^]]*\]' || true)"
  fi
  case " $CAPS " in *thinking*) THINKING=1 ;; esac
  if [ -n "$CAPS" ]; then
    case " $CAPS " in *vision*) VISION=1 ;; *) VISION=0 ;; esac
  fi
  [ -n "$CAPS" ] && say "Model capabilities: $CAPS"
  if [ "$VISION" -eq 0 ]; then
    warn "$MODEL does not list the vision capability; Tinker's eyes (AI Explore, critiques) need a vision model."
  fi
fi

# ---------------------------------------------------------------------------
if [ "$SKIP_SMOKE" -eq 1 ]; then
  say ""
  say "Skipping the image smoke test (--skip-smoke)."
elif [ "$DRY_RUN" -eq 1 ]; then
  step "Smoke test"
  say "[dry-run] would send a 64x64 red test image to $OLLAMA_URL/v1/chat/completions and ask for its colour"
else
  step "Smoke test: can $MODEL see?"
  REASONING_FIELD=""
  [ "$THINKING" -eq 1 ] && REASONING_FIELD='"reasoning_effort": "none",'
  PAYLOAD="{\"model\": \"$MODEL\", \"stream\": false, \"temperature\": 0, \"max_tokens\": 300, $REASONING_FIELD
    \"messages\": [{\"role\": \"user\", \"content\": [
      {\"type\": \"text\", \"text\": \"What is the main colour of this image? Answer with one word.\"},
      {\"type\": \"image_url\", \"image_url\": {\"url\": \"data:image/png;base64,$RED_PNG\"}}]}]}"
  say "Sending one small test image (the first answer also loads the model into memory; this can take a minute)..."
  STARTED="$(date +%s)"
  if ! ANSWER_JSON="$(printf '%s' "$PAYLOAD" | curl -fsS --noproxy '*' --max-time "$SMOKE_TIMEOUT" \
      -H 'Content-Type: application/json' --data-binary @- "$OLLAMA_URL/v1/chat/completions")"; then
    die 4 "the image request failed. Is $MODEL a vision model? Try: ollama run $MODEL, or pick another with --model. Re-run with --skip-smoke to write the config anyway."
  fi
  ELAPSED=$(( $(date +%s) - STARTED ))
  if [ -n "$PYTHON" ]; then
    ANSWER="$(printf '%s' "$ANSWER_JSON" | "$PYTHON" -c '
import json, sys
try:
    content = json.load(sys.stdin)["choices"][0]["message"]["content"]
except (ValueError, KeyError, IndexError, TypeError):
    sys.exit(1)
print(" ".join(str(content).split())[:120])')" || die 4 "the model replied, but not with a chat completion"
  else
    ANSWER="$(printf '%s' "$ANSWER_JSON" | tr -d '\n' | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | cut -c1-120)"
  fi
  say "Model answered in ${ELAPSED}s: \"$ANSWER\""
  case "$(printf '%s' "$ANSWER" | tr '[:upper:]' '[:lower:]')" in
    *red*|*crimson*|*scarlet*) say "It sees the red test image." ;;
    *) warn "expected the answer 'red'; the model replied but its vision may be weak. AI Explore may struggle." ;;
  esac
fi

# ---------------------------------------------------------------------------
step "Writing $(basename "$CONFIG")"
EFFORT=""
[ "$THINKING" -eq 1 ] && EFFORT="none"
BASE_URL=""
# The ai-service preset assumes 127.0.0.1:11434; record anything else.
[ "$OLLAMA_PORT" = "11434" ] || BASE_URL="$OLLAMA_URL/v1"
if [ -n "$PYTHON" ]; then
  RESULT="$("$PYTHON" -c '
import json, os, sys, time
path, model, roles, effort, dry, base_url = (sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4],
                                             sys.argv[5] == "1", sys.argv[6])
config = {}
if os.path.isfile(path):
    try:
        with open(path, encoding="utf-8") as handle:
            config = json.load(handle)
        if not isinstance(config, dict) or "endpoint" in config:
            config = {}
    except (OSError, ValueError):
        config = {}
before = json.dumps(config, sort_keys=True)
config.setdefault("port", 18383)
config.setdefault("allowed_origins", ["http://127.0.0.1:18381", "http://localhost:18381"])
role_value = {"provider": "ollama", "model": model}
if base_url:
    role_value["base_url"] = base_url
if effort:
    role_value["reasoning_effort"] = effort
config["roles"] = dict(config.get("roles") or {}) if isinstance(config.get("roles"), dict) else {}
for role in roles:
    config["roles"][role] = dict(role_value)
text = json.dumps(config, indent=2) + "\n"
if json.dumps(config, sort_keys=True) == before:
    print("unchanged")
elif dry:
    print("would write:\n" + text)
else:
    if os.path.isfile(path):
        backup = "%s.%s.bak" % (path, time.strftime("%Y%m%d-%H%M%S"))
        os.replace(path, backup)
        print("previous config saved as " + os.path.basename(backup))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(path + ".tmp", path)
    print("written")' "$CONFIG" "$MODEL" "$ROLES" "$EFFORT" "$DRY_RUN" "$BASE_URL")"
  say "$RESULT"
else
  # No Python found: write a fresh file for both roles.
  EFFORT_JSON=""
  [ -n "$EFFORT" ] && EFFORT_JSON=", \"reasoning_effort\": \"$EFFORT\""
  [ -n "$BASE_URL" ] && EFFORT_JSON=", \"base_url\": \"$BASE_URL\"$EFFORT_JSON"
  CONTENT="{
  \"port\": 18383,
  \"allowed_origins\": [\"http://127.0.0.1:18381\", \"http://localhost:18381\"],
  \"roles\": {
    \"brain\": {\"provider\": \"ollama\", \"model\": \"$MODEL\"$EFFORT_JSON},
    \"eyes\": {\"provider\": \"ollama\", \"model\": \"$MODEL\"$EFFORT_JSON}
  }
}"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would write:"; say "$CONTENT"
  else
    [ -f "$CONFIG" ] && cp "$CONFIG" "$CONFIG.$(date +%Y%m%d-%H%M%S).bak"
    printf '%s\n' "$CONTENT" > "$CONFIG"
    say "written"
  fi
fi

# ---------------------------------------------------------------------------
step "Done"
if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run only: nothing was installed, started, downloaded or written. Without --dry-run, Tinker roles ($ROLES) would use $MODEL."
else
  say "Tinker roles ($ROLES) now use $MODEL through Ollama on this Mac."
fi
say "Privacy: chats and camera images go only to Ollama at $OLLAMA_URL; nothing is sent to the cloud."
say "Start the lab with ./start.sh and open Tinker. Check the AI service any time with:"
say "  curl -s http://127.0.0.1:18383/health"
if [ "$RAM_GB" -gt 0 ] && [ "$RAM_GB" -lt 12 ]; then
  say "Tip: on ${RAM_GB} GB close other big apps while training; Ollama unloads the model after 5 idle minutes."
fi
