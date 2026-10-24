#!/usr/bin/env bash
# Create the CPU-only training virtualenv (.venv-train) for training/creature_gym.
# Works on Apple-silicon macOS (arm64) and Linux x86_64/aarch64; no CUDA needed.
#
#   training/setup-train-env.sh            # create or update <repo>/.venv-train
#   CREATURE_TRAIN_VENV=/path ./setup...   # custom location
#   CREATURE_TRAIN_PYTHON=python3.12 ...   # force an interpreter (3.10-3.13)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${CREATURE_TRAIN_VENV:-$ROOT/.venv-train}"
REQS="$ROOT/requirements-train.txt"

supported() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)
PY
}

PYTHON="${CREATURE_TRAIN_PYTHON:-}"
if [ -n "$PYTHON" ]; then
  supported "$PYTHON" || { echo "error: $PYTHON is not Python 3.10-3.13" >&2; exit 1; }
else
  # 3.12 first: every pinned wheel exists for it on macOS arm64 and Linux.
  for candidate in python3.12 python3.13 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && supported "$candidate"; then
      PYTHON="$candidate"; break
    fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "error: need Python 3.10-3.13 (macOS: 'brew install python@3.12' or python.org installer)" >&2
  exit 1
fi

echo "creature-gym: using $("$PYTHON" -c 'import sys; print(sys.executable, sys.version.split()[0])')"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
fi
PY="$VENV/bin/python"
"$PY" -m pip install --quiet --upgrade pip

TORCH_PIN="$(grep -E '^torch==' "$REQS" | head -n1)"
case "$(uname -s)" in
  Linux)
    # The CPU wheel index keeps the venv ~0.5 GB instead of several GB of CUDA libs.
    "$PY" -m pip install --quiet --index-url https://download.pytorch.org/whl/cpu "$TORCH_PIN"
    ;;
  Darwin)
    # PyPI macOS arm64 wheels are already CPU/MPS-only.
    "$PY" -m pip install --quiet "$TORCH_PIN"
    ;;
  *)
    echo "warning: untested OS $(uname -s); installing torch from PyPI" >&2
    "$PY" -m pip install --quiet "$TORCH_PIN"
    ;;
esac
"$PY" -m pip install --quiet -r "$REQS"

"$PY" - <<'PY'
import mujoco, numpy, onnx, onnxruntime, torch
assert mujoco.__version__ == "3.11.0", f"mujoco {mujoco.__version__} != 3.11.0 (browser WASM)"
from mujoco import rollout  # multithreaded stepping used by the trainer
print(f"creature-gym env ready: mujoco {mujoco.__version__}, torch {torch.__version__}, "
      f"numpy {numpy.__version__}, onnx {onnx.__version__}, onnxruntime {onnxruntime.__version__}")
PY
echo "creature-gym: venv at $VENV"
