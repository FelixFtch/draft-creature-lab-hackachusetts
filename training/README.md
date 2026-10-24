# creature_gym — train Draft creatures on a CPU (Mac or Linux)

`training/creature_gym/` turns a Draft body (`creature-body/1`, see
`contracts/body-contract.md`) into validated, exported skills that the browser
plays: **walk** (perpetual velocity tracking) and **jump** (an episodic
one-shot that hands back to walk). No CUDA, mjlab or MuJoCo Warp: physics runs
in MuJoCo 3.11.0's C threads (`mujoco.rollout`), learning is PPO on CPU torch.

```
body dir ──sim_model──▶ scene.xml (Draft body + PD position servos + sensors + floor)
          ──envs──────▶ many envs per mujoco.rollout call (4 substeps / 50 Hz step)
          ──ppo───────▶ actor-critic (ELU MLPs), GAE, clipped PPO, adaptive LR
          ──export────▶ policy.onnx (+ normaliser) manifest.json fixtures.json
          ──evaluate──▶ eval.json (deterministic Python MuJoCo rollouts)
          ──browser───▶ play/src/creature-controller.js (refuses anything unvalidated)
```

## Setup (Apple-silicon Mac or Linux)

```bash
training/setup-train-env.sh          # creates <repo>/.venv-train (Python 3.10-3.13)
```

On an Apple-silicon Mac: install Python 3.12 (python.org or `brew install
python@3.12`), run the script above, then train with `--threads` set to the
number of cores you want to give it (performance cores first; e.g. `--threads
8 --torch-threads 4` on a 10-core M-series machine) and keep the Mac awake for
long budgets. Nothing needs Metal/MPS or CUDA.

Pinned in `requirements-train.txt`: `mujoco==3.11.0` (the same version as the
browser's `@mujoco/mujoco` WASM build, so training, evaluation and play
simulate the same physics), `torch==2.11.0` (CPU; on Linux taken from the
PyTorch CPU wheel index), `numpy==2.2.6`, `onnx==1.22.0`, `onnxruntime==1.27.0`
(the version of `onnxruntime-web` in `play/`; 1.23.2 on Python 3.10). Also
verified: the full test suite passes with torch 2.14.1+cpu, onnx 1.23.2 and
onnxruntime 1.23.2, and bundles exported with either stack evaluate
identically under the other.

## Train

```bash
cd training
PY=../.venv-train/bin/python
$PY -m creature_gym.train --body <bodyDir> --skill walk --budget quick --out <bodyDir>/policies/walk
$PY -m creature_gym.train --body <bodyDir> --skill jump --budget quick --out <bodyDir>/policies/jump
```

Options: `--threads N` (physics threads; default all cores up to 8),
`--torch-threads N` (PPO update; default min(threads, 4); use 1 on a busy
machine), `--envs 256`, `--seed S`, `--resume`, `--max-wall-seconds N`,
`--chunk-iterations N`, `--steps N` (override the budget), `--no-export`,
`--reexport`, `--walk-bundle DIR` (jump only; default `<out>/../walk`).

When the budget is reached the same command exports the bundle and evaluates
it. Output, per `contracts/policy-bundle.md`:

```
<bodyDir>/policies/<skill>/  manifest.json policy.onnx scene.xml <meshes> eval.json fixtures.json progress.json
<bodyDir>/policies/<skill>/.work/  checkpoint.pt log.jsonl run.json train.log caches (never served)
```

A bundle whose `eval.json` does not pass is still written (so you can see
why) but the browser and draft-service treat it as **not ready**.

### Chunked runs (e.g. a VM that kills processes every few minutes)

`--max-wall-seconds N` stops cleanly before N seconds (checkpoint + progress
written) and `--resume` continues exactly: policy, optimiser, observation
normalisers, adaptive learning rate, iteration/env-step counters, curriculum,
the complete env state (simulation states, commands, gait clocks, episode
counters, push timers, the domain-randomisation pool) and all RNG states are in
the checkpoint, so a run split into chunks is bit-identical to one continuous
run (tested: `ResumeEquivalenceTest`). If the env count changes between chunks
the envs are re-initialised (stated in stderr). `--resume` with no checkpoint
starts fresh, so a driver can always pass it:

```bash
while true; do
  line=$($PY -m creature_gym.train --body B --skill walk --budget standard --out B/policies/walk \
         --resume --max-wall-seconds 150 | tail -n 1)
  echo "$line"
  echo "$line" | grep -q '"done": true' && break
done
```

Each chunk prints one JSON line: `iteration`, `env_steps`, `steps_per_s`,
`mean_reward`, `done`, `phase`, `eval_pass`, `chunk_wall_s`. Startup is small
(torch import, scene compile, checkpoint restore: 5.2 s measured on the busy
2-vCPU box including the final checkpoint save); bump terrain and the jump's
slow-walk start states are cached in `.work/`. `--chunk-iterations N` gives
deterministic chunk sizes instead of a wall-clock limit.
Export + evaluation needs ~15-45 s and is resumable too (phase
`exporting`/`evaluating`). A chunk keeps 45 s free for it.

## Budgets, throughput and how long it takes

An *env step* is one 50 Hz control step of one env (4 physics substeps).

| budget | walk | jump |
| --- | --- | --- |
| `quick` | 6 M env steps | 3 M |
| `standard` | 30 M | 12 M |
| `long` | 100 M | 40 M |

The trainer prints an ETA from the measured rate and writes it to
`progress.json`. `python -m creature_gym.bench --body <dir> --threads 1,2,4`
measures a machine (physics-only rate per thread count, full-loop rate and a
per-phase breakdown).

**Measured.** Cheetah dev body, 256 envs, env steps per second:

| machine | physics only (rollout) | full training loop |
| --- | --- | --- |
| dev box: Intel Xeon (Sapphire Rapids) 2.1 GHz, 2 vCPU, shared with five other agents | idle box: 10.8 k (1 thread), 20.1 k (2 threads); under load 8: 2.8 k / 6.6 k | 5.6 k average over the 6 M-step Cheetah walk run (2 physics + 1 torch thread, moderate load); 2.1-2.8 k under heavy load |
| Apple silicon, Linux VM with 4 cores (measured by the coordinating agent with mujoco 3.11.0) | 13 k (1 thread), 24 k (2), 42.5 k (4); single `mj_step` ≈ 10 µs | not yet measured: run `creature_gym.bench` there |

Full-loop breakdown per PPO iteration (6 144 env steps) on the loaded dev box:
physics 1.85 s, env Python (observations, rewards, resets) 0.09 s, policy
inference 0.12 s, PPO update 0.90 s (1 torch thread). Uncontended, the update
took 0.31 s and the env Python ≈ 2.5 ms per control step.

**Estimate for Apple silicon** (not measured; derived from the numbers above):
physics at 42.5 k/s is 0.145 s per iteration; env Python and inference about
0.05 s (an M-series core runs these small numpy/torch calls 1.5-2× faster than
the dev box's core); the PPO update ~0.08 s with 4 torch threads. That is
≈ 0.28 s per iteration, **≈ 20 k env steps/s on the 4-core VM**, and
**≈ 25-30 k env steps/s natively on a 10-core M-series Mac** with `--threads 8`
(physics scales with cores, the Python/update share does not).

| budget | dev box (≈5 k/s) | Mac VM, 4 cores (≈20 k/s, est.) | 10-core M-series (≈27 k/s, est.) |
| --- | --- | --- | --- |
| walk quick (6 M) | ~20 min (measured: 18 min) | ~5 min | ~4 min |
| walk standard (30 M) | ~1.7 h | ~25 min | ~19 min |
| walk long (100 M) | ~5.5 h | ~85 min | ~62 min |
| jump quick (3 M) | ~10 min (measured: 18 min under heavy load) | ~2.5 min | ~2 min |
| jump standard (12 M) | ~40 min | ~10 min | ~7 min |

Plus ~10-30 s for export + evaluation, and ~2-5 s startup per chunk.

What the dev bodies needed in practice: the Cheetah walk passed all 11
evaluation rows after the *quick* budget (6 M env steps, 18 min on the 2-vCPU
box): forward 99 % of command with 0.006 rad/s yaw drift, top speed 95 %,
a trot at 1.9-2.0 Hz with duty factor 0.53-0.59 and 6-9 cm swing clearance.
The Cheetah jump already passed its rows at ~0.6 M env steps of a quick run
(reference-tracking reward); the shipped full quick run (3 M) jumps 8.1-9.8 cm
(apex gain of the torso) with 0.20 s of flight and ≤ 0.05 rad tilt, from
standing and from walking, and hands back to walk without a fall.

## What the tasks are

**Scene / actuators.** Draft PD rule from `draft/tasks/quadruped/quadruped_entity.py`:
`kp = 100/70 · effort`, `kd = 5/70 · effort`, as MuJoCo `<position kp kv>`
actuators with `forcerange = ±effort`, `ctrlrange = joint range`; 5 ms
`implicitfast` steps, 4 per 50 Hz policy step. Collision bits from PLAN §3 (only
feet and structural geoms collide; no self-collision).

**Walk.** Observation: root linear/angular velocity, projected gravity,
command `[vx, vy, wz]`, joint positions and velocities, last action, and a
per-leg gait clock (sin/cos) with phase offsets from `body.json gaitHint`
(trot / tripod / wave / ripple), switched off for a stand command. Commands are
Froude-scaled: `vmax = 0.5·√(g·legLength)` (Froude 0.25; capped by the knee's
no-load speed), backwards to −vmax/2, turning `wmax = clip(1/√s, 0.6, 1.5)`
rad/s (`s = legLength/0.44`); clock `2·√(0.44/leg)` Hz. Rewards (per second):
velocity tracking (exp kernels), upright, base height, clock-based swing/stance
contact and swing-foot height, stance slip, vertical/roll-pitch velocity,
action rate, normalised torque, joint acceleration, joint limits, thigh contact,
and stand-still pose terms; −2 on termination (tilt > 1 rad, torso contact,
torso closer than half the nominal height to the feet, simulator divergence).
Domain randomisation per model variant: foot friction 0.4-1.2, payload −10…+20 %
of the torso, torso COM ±2 cm·s, servo kp ±10 %, kv ±20 %, effort −15…+10 %,
joint damping/friction ×0.5-1.5; observation noise; random pushes (from 15 % of
training); 40 % of envs on smooth bump patches (protrusion up to 8 % of leg
length, ramped in); 20 % of starts are drops from up to 0.3 leg lengths with
tilt and joint noise so walk can take over after a jump.

**Jump.** Separate policy, fixed window (`1.4·√s` s clipped to 1.2-1.6 s, a
whole number of 20 ms steps) with phase `(p, sin 2πp, cos 2πp)` in the
observation and action scale 0.3 rad. Sparse "be high / be airborne" rewards
did not work (random exploration never produced a coordinated push: after
0.3 M steps the apex gain was still 1.5 cm), so the reward tracks a
body-scaled vertical *reference* (`envs.JumpReference`, no motion capture):
cosine crouch by 15 % of the standing height, constant-acceleration push to a
take-off speed `√(2 g · 0.15 leg)`, ballistic flight, a landing give, then
stand. Terms: broad + tight kernels on root height and vertical-velocity error,
all-feet-airborne bonus in the reference flight band, feet-down outside it,
upright, settle pose/stillness at the end, and small effort/rate/limit
penalties. Starts: half from standing, half from slow-walk states recorded with
the body's ready walk policy. Microduck-style handoff: the controller swaps the
jump policy in for the window (last action re-expressed in jump units), then
hands back to walk. The reference only shapes training; validation uses the
absolute criteria (apex gain, air time, tilt, no fall through the handoff).

**Both skills.** Every env's first episode is cut at a random length (like
rsl_rl's random initial episode length), so each PPO batch mixes all phases of
a task instead of every env being at the same moment of a jump.

## Evaluation (what "ready" means)

`python -m creature_gym.evaluate --bundle <walk dir> [--body <bodyDir>] [--jump <jump dir>]`
re-runs the validation. Walk rows: stand, forward, forward_max, backward,
turn_left/right, arc, start_stop, push_recovery, drop_recovery, bumpy; jump rows:
jump_from_stand, jump_from_walk, jump_repeat. Thresholds are listed in
`contracts/policy-bundle.md` and recorded in every row. They are engineering
acceptance for a game character on this exact body — not a robotics benchmark.

## Browser and QA

`play/src/creature-controller.js`: `loadCreatureBundle(url)` (verifies every
hash and the eval), `createCreatureController({mujoco, model, data, walk, jump})`
and `createCreaturePilot({walkUrl, jumpUrl, bodyUrl})` (the world-api pilot).
`node qa/creature-controller-validation.mjs [--bundle DIR] [--jump DIR]` checks
JS/Python parity on the fixtures (observation bit-identical, action ≤ 5e-7,
state after a step ≤ 1e-6), replays the evaluation scenarios in WASM against
`eval.json`, and tests lifecycle/refusal paths.

## Development bodies

```bash
$PY -m creature_gym.dev_bodies --body cheetah --out /tmp/bodies/cheetah
CREATURE_GENERATOR_PYTHON=../.venv/bin/python $PY -m creature_gym.dev_bodies --body flower --out /tmp/bodies/flower
```

`training/dev-bundles/<name>/` holds committed dev bodies with their bundles in
the same layout as `<bodyDir>/policies/<skill>/`.

## Tests

```bash
cd training && ../.venv-train/bin/python -m unittest discover -s creature_gym/tests -t . -v
```

## What is and isn't modelled (honest limits)

- Servos are torque-limited PD position actuators. No DC-motor torque-speed
  droop, no current/thermal limits, no backlash, no sensor latency, no motor
  dynamics. Draft's own training uses a DC-motor model; this CPU port does not.
- Contacts are MuJoCo soft contacts with randomised foot friction; the robot
  only touches the world with feet and structural links (motors are visual).
- Terrain: flat ground plus smooth bumps of a few centimetres. No stairs, steep
  ramps, gaps, slippery ice or moving platforms in training.
- Policies are validated in simulation only, for the exact body hash they were
  trained on. A changed body needs retraining (the browser refuses stale ones).
- The jump is a separate one-shot skill; its validation covers flat ground and
  the handoff to the exact walk policy recorded in its manifest.
