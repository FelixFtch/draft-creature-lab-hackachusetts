# Draft Creature Lab

An English-language robot design playground with real MuJoCo physics, Three.js rendering and joystick control. Shape a robot, change its colors, save a family of remixes, and take a learned walker around a three-marker trail.

The **Flower crawler** is a custom six-legged, 18-joint body authored for this lab and generated with [Draft](https://github.com/davidhnguyen2000/draft). The original-size Flower and Cheetah each use their own locally trained ONNX walking policy. This is an independent learning prototype, not an official Draft product or a Microduck simulator.

## Run locally

Requirements: Git, Bash, Python 3.10–3.13 with `venv`, Node.js 22.12+ (or 20.19+), and a modern browser with WebGL2/WebAssembly. Linux is the verified platform; macOS is not yet tested. Installation needs an internet connection.

```bash
git clone https://github.com/FelixFtch/draft-creature-lab.git
cd draft-creature-lab
./setup.sh
./start.sh
```

Open **http://127.0.0.1:18381/**. No account or GPU training is required. `Ctrl+C` stops only services started by this launcher. If those ports are occupied, choose another pair:

```bash
./start.sh --port 18581 --api-port 18582
```

Setup clones Draft at commit `3b03e144735098ef94b938e85756806f45628f83` into `.deps/draft`, creates a project-local `.venv`, installs pinned CPU generator dependencies and runs `npm ci`. It does not install Draft's RL/CUDA extras, train a model, download VLM weights, or start a vision model. The generator and frontend bind only to the local computer.

To use an existing compatible generator environment, set `DRAFT_ROOT` to a clean checkout of that revision and `DRAFT_PYTHON` to its Python executable. `PYTHON_BIN` chooses the interpreter used by `setup.sh` to create the local environment.

## Play

1. Choose **Flower crawler** or **Cheetah** at original 1× proportions.
2. Drag the **Joystick** directly: up/down moves forward/backward, left/right turns. **W/S** and **A/D** work too. Dragging also resumes a paused robot.
3. Release to request zero velocity while the policy balances; **Pause** freezes physics. The Flower may still step in place while balancing.
4. Try **Explore the trail**, visit all three circles, or select **Guide me** for deterministic steering assistance. Manual input takes over.
5. Change body proportions, colors and poses. **Generate my creature** rebuilds real MJCF geometry and mass properties. Resized bodies, Bear and Giraffe support pose/gravity experiments; they need their own validated walking policies.
6. **Save my remix** stores the design in this browser. Open a saved design, change it and save again to create a branch. Export JSON recipes for backup.

Shared links contain the recipe in their URL fragment. Another learner must run this lab and use their own local address. This repository does not deploy a website, public gallery, account system, or multiplayer service. Saving is local to the browser.

## What runs where

| Part | Runtime | GPU requirement |
| --- | --- | --- |
| Robot generation | Python Draft + MuJoCo CPU | None |
| Physics and learned gait | MuJoCo WASM + ONNX Runtime Web WASM in the browser | No CUDA requirement |
| 3D display | Three.js/WebGL2 | Browser graphics support |
| Optional visual decisions | A separately supplied local vision model | Depends on that model; not started by this lab |

Bundled policies total about 1.4 MB. Browser physics/inference runtimes come from npm and are built locally. Training checkpoints and large model weights are not included.

## Optional vision control

Manual play works with vision disabled. To connect an **already running** local image-capable OpenAI-compatible chat-completions server:

```bash
cp vlm-service/config.example.json vlm-service/config.json
# Edit endpoint and model to match your local server.
./start.sh --with-vision
```

The adapter only accepts loopback provider URLs. If you change the frontend port, also update `allowed_origins` in the local config. If your provider requires authentication, set `api_key_env` to an environment-variable name; never put the credential in a tracked file. No VLM server launcher or weights are supplied.

Open **Let it look & explore** in the UI. The virtual robot camera sends a fresh image plus your instruction to the model. It proposes one bounded action; the learned gait executes it. Joystick input, Stop, reset or changing the body cancels visual control. The model does not receive hidden waypoint coordinates. **Guide me** is a separate deterministic helper.

Vision navigation is experimental: a local trial reached 2/3 markers, then stopped outside the last circle. A later smaller-marker trial was interrupted, so full-course VLM success is not established. Grasping, obstacle avoidance and hardware execution are not implemented. Page-level integration methods exist; a network MCP server does not.

## Check the release

```bash
node qa/drive-input-validation.mjs
node qa/trail-visuals-validation.mjs
node qa/flower-controller-validation.mjs
node qa/cheetah-controller-validation.mjs
node qa/flower-trail-validation.mjs
node qa/trail-game-validation.mjs
node qa/vlm-control-validation.mjs
.venv/bin/python -m unittest discover -s vlm-service -p 'test_*.py'
(cd play && npm run build)
```

The controller checks run actual MuJoCo/ONNX WASM on CPU and write detailed JSON reports under `qa/`. The Flower readiness endpoint verifies the passing report against the current controller, policy, XML, raw body and mesh hashes. It does not unlock a changed body just because training finished. Export-time controller manifests are retained unchanged; later QA reports record validation.

These are bounded flat-floor prototype tests, not proof of arbitrary-body locomotion, manufacturing feasibility, polished gait quality, touch/gamepad support or real-robot safety. Changing topology needs its own task, policy and validation. The browser currently offers four predefined body plans, not freeform topology editing.

## Project layout

- `play/`: React interface, Three.js scene, MuJoCo/ONNX controllers and runtime assets.
- `draft-service/`: loopback API for real Draft generation and validated controller readiness.
- `robots/flower/`: locally authored Flower specification and frozen reference body.
- `qa/`: focused input, physics/controller and trail checks.
- `training/`: small historical training summaries for the learning diary; no training runner or checkpoints.
- `vlm-service/`: optional bounded screenshot-to-action adapter; off by default.

Original application code and locally authored assets are MIT licensed. Draft's MIT notice and all third-party attributions are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No Pollen Robotics/Microduck hardware assets or policies are included.
