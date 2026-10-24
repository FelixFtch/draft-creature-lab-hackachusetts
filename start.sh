#!/usr/bin/env bash
set -euo pipefail
LAB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${DRAFT_PYTHON:-$LAB_ROOT/.venv/bin/python}"
[[ -x "$PYTHON_BIN" ]] || { echo 'Run ./setup.sh first, or set DRAFT_PYTHON to an installed generator environment.' >&2; exit 1; }
exec "$PYTHON_BIN" "$LAB_ROOT/scripts/run.py" "$@"
