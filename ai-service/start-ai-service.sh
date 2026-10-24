#!/usr/bin/env bash
# Start the loopback ai-service (Tinker + vision) with the lab's Python.
# It never starts a model: configure Ollama or a cloud key first (README.md).
set -euo pipefail
service_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python_bin="${DRAFT_PYTHON:-$service_dir/../.venv/bin/python}"
[[ -x "$python_bin" ]] || python_bin="$(command -v python3)"
exec "$python_bin" "$service_dir/server.py" "$@"
