#!/usr/bin/env bash
set -euo pipefail
SERVICE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${DRAFT_PYTHON:-$SERVICE_DIR/../.venv/bin/python}"
exec "$PYTHON_BIN" "$SERVICE_DIR/server.py" "$@"
