---
inclusion: always
---
# Tech stack and commands

## Stack

- **Web app** (`play/`): React 19, Vite 8, Three.js 0.164.1, MuJoCo WASM 3.11.0 (`@mujoco/mujoco`) and `onnxruntime-web`. It uses plain JavaScript ES modules and JSX, with no TypeScript. Physics and learned controllers run in the browser.
- **draft-service** (`draft-service/server.py`, `designs.py`, `training_jobs.py`): Python 3.10–3.13 standard-library HTTP server on `127.0.0.1:18382`. It uses the generator venv `.venv` with **mujoco==3.8.0**, which is pinned for hash stability of the bundled bodies. Draft is checked out at the pinned commit in `.deps/draft`.
- **ai-service** (`ai-service/server.py`): standard-library HTTP server on `127.0.0.1:18383`. Its providers are `offline` (default, rule-based), `ollama`, `lmstudio`, `dashscope`/`-cn`/`-us` (Qwen), `zhipu`/`-cn` (GLM), `gemini`, `openai`, `openrouter` and `custom`. Keys are read from the environment or `ai-service/.env.local`.
- **Trainer** (`training/creature_gym`): CPU PPO in PyTorch with ONNX export and evaluation gates. It uses the training venv `.venv-train` with **mujoco==3.11.0**, which must stay equal to the browser's WASM version.

## Commands (run from the repo root unless noted)

```bash
./setup.sh --no-training          # .venv, Draft checkout, npm ci (add training later)
./training/setup-train-env.sh     # .venv-train for CPU training
./start.sh                        # builds play/ and serves http://127.0.0.1:18381/
(cd play && npm run build)        # web build check
.venv/bin/python -m unittest discover -s draft-service -p 'test_*.py'
(cd ai-service && ../.venv/bin/python -m unittest discover -s tests)
node qa/terrain-trials.mjs --pilot legacy-cheetah --bundle /creatures/<bodyId> --map /creatures=creatures
(cd training && ../.venv-train/bin/python -m creature_gym.train --body ../creatures/<bodyId> --skill walk --budget quick --out ../creatures/<bodyId>/policies/walk)
```

For long training runs, work in chunks with `--max-wall-seconds N` and continue with `--resume`. The result is bit-identical to an unchunked run. `python -m creature_gym.evaluate --bundle <dir>` re-runs the gates.

## Runtime wiring

`scripts/run.py` builds `play/`, then starts the three services. The web app runs on port 18381 (`vite preview`), draft-service on 18382 and ai-service on 18383. Vite proxies send `/api`, `/draft`, `/creatures` and `/training-media` to 18382, and `/ai` and `/vlm` to 18383 with the prefix stripped. `play/src/app/api.js` holds the fetch helpers (`draftApi`, `aiApi`, `ApiError`).

## Physics constants (keep consistent across browser, trainer and evaluator)

- Timestep 0.005 s, `implicitfast`, policy control at 50 Hz (decimation 4).
- PD through native `<position>` actuators: kp = 100/70·effort, kv = 5/70·effort.
- Collision bits: static 1/15, props 8/15, feet 2/9, body 4/9.

## Rules

- Services bind to `127.0.0.1` only. Never log or commit API keys.
- Keep `npm run build` and both Python test suites green before finishing a task.
- Known issue: three ai-service tests are stale. They predate the extended design schema; see `.kiro/specs/fix-ai-service-tests`.
