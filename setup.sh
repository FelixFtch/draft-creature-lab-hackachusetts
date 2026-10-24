#!/usr/bin/env bash
set -euo pipefail
LAB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DRAFT_REVISION=3b03e144735098ef94b938e85756806f45628f83
export DRAFT_ROOT="${DRAFT_ROOT:-$LAB_ROOT/.deps/draft}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v git >/dev/null
command -v npm >/dev/null
"$PYTHON_BIN" -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10 or newer is required"'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if (!(a===20&&b>=19||a===22&&b>=12||a>22))throw Error("Use Node 22.12+ or Node 20.19+")'
if [[ ! -e "$DRAFT_ROOT" ]]; then
  mkdir -p "$(dirname -- "$DRAFT_ROOT")"
  git clone --filter=blob:none --no-checkout https://github.com/davidhnguyen2000/draft.git "$DRAFT_ROOT"
  git -C "$DRAFT_ROOT" checkout --detach "$DRAFT_REVISION"
fi
[[ "$(git -C "$DRAFT_ROOT" rev-parse HEAD)" == "$DRAFT_REVISION" ]] || { echo 'DRAFT_ROOT must point to the pinned Draft revision.' >&2; exit 1; }
[[ -z "$(git -C "$DRAFT_ROOT" status --porcelain --untracked-files=no)" ]] || { echo 'The pinned Draft checkout has tracked modifications; use a clean checkout.' >&2; exit 1; }
if [[ ! -x "$LAB_ROOT/.venv/bin/python" ]]; then "$PYTHON_BIN" -m venv "$LAB_ROOT/.venv"; fi
"$LAB_ROOT/.venv/bin/python" -m pip install -r "$LAB_ROOT/requirements-generator.txt"
"$LAB_ROOT/.venv/bin/python" -m pip install --no-deps -e "$DRAFT_ROOT"
(cd -- "$LAB_ROOT/play" && npm ci --no-audit --no-fund)
"$LAB_ROOT/.venv/bin/python" "$LAB_ROOT/draft-service/server.py" --prepare >/dev/null
echo 'Setup complete. Run ./start.sh and open http://127.0.0.1:18381/'
