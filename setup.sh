#!/usr/bin/env bash
# One-time setup for Draft Creature Lab on macOS (Apple silicon or Intel) or Linux.
#   ./setup.sh                 generator + frontend + CPU training environment
#   ./setup.sh --no-training   skip the training environment (no torch download)
# Optional afterwards:
#   ./scripts/setup-local-ai.sh   install a local vision/chat model with Ollama (macOS)
set -euo pipefail
LAB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DRAFT_REVISION=3b03e144735098ef94b938e85756806f45628f83
export DRAFT_ROOT="${DRAFT_ROOT:-$LAB_ROOT/.deps/draft}"
WITH_TRAINING=1
for arg in "$@"; do
  case "$arg" in
    --no-training) WITH_TRAINING=0 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
OS="$(uname -s)"
hint() {
  if [[ "$OS" == "Darwin" ]]; then echo "  On macOS: brew install $1" >&2; else echo "  Install $1 with your package manager." >&2; fi
}
command -v git >/dev/null || { echo 'git is required.' >&2; hint git; exit 1; }
command -v node >/dev/null && command -v npm >/dev/null || { echo 'Node.js 22.12+ (or 20.19+) with npm is required.' >&2; hint node; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if (!(a===20&&b>=19||a===22&&b>=12||a>22))process.exit(1)' \
  || { echo "Node $(node --version) is too old: use Node 22.12+ or 20.19+." >&2; hint node; exit 1; }

# macOS ships an older python3; prefer the newest supported interpreter on PATH.
supported_python() { "$1" -c 'import sys; raise SystemExit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; }
if [[ -z "${PYTHON_BIN:-}" ]]; then
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null && supported_python "$candidate"; then PYTHON_BIN="$candidate"; break; fi
  done
fi
if [[ -z "${PYTHON_BIN:-}" ]] || ! supported_python "$PYTHON_BIN"; then
  echo 'Python 3.10–3.13 is required (set PYTHON_BIN to choose one).' >&2; hint python@3.12; exit 1
fi
echo "Using $("$PYTHON_BIN" --version) at $(command -v "$PYTHON_BIN")"

if [[ ! -e "$DRAFT_ROOT" ]]; then
  mkdir -p "$(dirname -- "$DRAFT_ROOT")"
  git clone --filter=blob:none --no-checkout https://github.com/davidhnguyen2000/draft.git "$DRAFT_ROOT"
  git -C "$DRAFT_ROOT" checkout --detach "$DRAFT_REVISION"
fi
[[ "$(git -C "$DRAFT_ROOT" rev-parse HEAD)" == "$DRAFT_REVISION" ]] || { echo 'DRAFT_ROOT must point to the pinned Draft revision.' >&2; exit 1; }
[[ -z "$(git -C "$DRAFT_ROOT" status --porcelain --untracked-files=no)" ]] || { echo 'The pinned Draft checkout has tracked modifications; use a clean checkout.' >&2; exit 1; }
if [[ ! -x "$LAB_ROOT/.venv/bin/python" ]]; then "$PYTHON_BIN" -m venv "$LAB_ROOT/.venv"; fi
"$LAB_ROOT/.venv/bin/python" -m pip install --upgrade pip >/dev/null
"$LAB_ROOT/.venv/bin/python" -m pip install -r "$LAB_ROOT/requirements-generator.txt"
"$LAB_ROOT/.venv/bin/python" -m pip install --no-deps -e "$DRAFT_ROOT"
(cd -- "$LAB_ROOT/play" && npm ci --no-audit --no-fund)
"$LAB_ROOT/.venv/bin/python" "$LAB_ROOT/draft-service/server.py" --prepare >/dev/null

if [[ "$WITH_TRAINING" == 1 && -x "$LAB_ROOT/training/setup-train-env.sh" ]]; then
  PYTHON_BIN="$PYTHON_BIN" "$LAB_ROOT/training/setup-train-env.sh"
elif [[ "$WITH_TRAINING" == 1 ]]; then
  echo 'Training environment script not found; skipping (training/setup-train-env.sh).'
fi

echo
echo 'Setup complete. Run ./start.sh and open http://127.0.0.1:18381/'
echo 'Tinker works offline out of the box. For a local AI model run ./scripts/setup-local-ai.sh,'
echo 'or add a cloud key (Qwen/DashScope, GLM, Gemini, OpenAI) as described in ai-service/README.md.'
