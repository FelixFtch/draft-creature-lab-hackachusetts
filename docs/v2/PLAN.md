# Draft Creature Lab v2 — "Creature Park"

Shared plan for the multi-agent build. Every agent reads this file first, then
the contract files it touches under `contracts/`. Contracts beat this prose
when they disagree; the owner of a contract may extend it (never break it) and
must say so in their final report.

## 1. The experience

One continuous loop, playful like a game, honest like the original lab:

1. **Imagine** — chat with *Tinker*, the AI robot designer. "I want a frog that
   jumps onto platforms." Tinker asks at most one or two questions, then
   proposes a design card (body plan, size, actuator family, skills, look).
   Works offline with a rule-based designer; better with an LLM (local Ollama on
   the Mac, or a cloud key: Qwen/DashScope, Zhipu GLM, Gemini, OpenAI-compatible).
2. **Draft** — the design compiles through the real Draft generator (MIT,
   Nguyen/Coelho/Kim 2026): joints, bodies, actuators sized from Draft's fitted
   trends, feasibility gate. The workshop shows a blueprint-style spec sheet:
   mass, size, motor torque/speed, warnings. Infeasible designs come back to
   Tinker with the gate's reason so it can revise.
3. **Dress up** — cosmetic look: palette, finish, pattern, shell, eyes,
   accessories (Microduck-community style printed shells). Tinker can restyle
   ("make it a ladybug"). Looks never change physics. Export a print kit (STL)
   of the decorative shell.
4. **Train** — bodies without a policy are trained locally on CPU (works on an
   Apple-silicon Mac; no CUDA). Live progress, then an honest validation report
   unlocks play. Skills: `walk` (velocity tracking) and `jump` (one-shot).
5. **Play** — a full-screen playground world (Microduck-sandbox energy, our own
   world): zones with bumps, ramps, steps, a ball court with a goal, crates and
   dominoes, collectible sparks, jump pads/platforms, hoops. Keyboard, gamepad
   and touch controls, chase camera, sound, particles, challenges and stickers.
   *AI Explore*: the VLM looks through the robot's camera and steers it to a
   named landmark ("go to the red ball").

Existing value to keep: the four Draft presets (Cheetah, Bear, Giraffe, Flower),
the two validated legacy walking policies (Cheetah, Flower) and their hash /
readiness gates, recipes (share/export/import), the local remix family, the
pose and gravity experiments, honest provenance notes, loopback-only services.

## 2. Architecture

```
play/ (Vite + React 19 + Three 0.164 + MuJoCo WASM 3.11 + ORT-web 1.27)
  src/App.jsx, src/main.jsx            integration (main agent)
  src/draft-lab.js                     workshop engine (pose/drop/blueprint/print reveal) (main)
  src/ui/**, src/styles/**             React UI kit + design system (agent: ui)
  src/appearance/**                    creature view + looks + studio + print kit (agent: look)
  src/world/**                         playground engine, world, game, camera, input, audio, fx (agent: world)
  src/creature-controller.js           generic policy controller for creature-gym bundles (agent: trainer)
  src/cheetah-controller.js, src/flower-controller.js   legacy; world agent may relax nq checks + re-validate
draft-service/ (Python stdlib HTTP on 127.0.0.1:18382, generator venv .venv)
  server.py                            routing (main agent wires module ROUTES)
  designs.py, templates/**             DesignSpec -> Draft body + body contract (agent: morphology)
  training_jobs.py                     train job manager + policy listing (agent: trainer)
robots/multileg/                       new Draft template: 3-8 legs radial/bilateral (agent: morphology)
training/creature_gym/                 CPU PPO trainer, export, evaluation (agent: trainer; venv .venv-train)
ai-service/ (Python stdlib HTTP on 127.0.0.1:18383; replaces vlm-service, keeps /decide)
  server.py, providers.py, designer.py, ...   (agent: ai)
scripts/setup-local-ai.sh              macOS: Ollama + VLM by RAM (agent: ai)
contracts/                             shared schemas (see owners below)
creatures/                             bundled showcase creatures (body + trained policies)
qa/                                    validation scripts and reports
```

Vite proxy (play/vite.config.js, main agent): `/api`, `/draft`, `/creatures`,
`/training-media` → draft-service; `/vlm/*` and `/ai/*` → ai-service (prefix
stripped). Production is `vite preview` of a build made at start time, so files
generated at runtime are served by draft-service, never from `play/public`.

## 3. Conventions (all agents)

- **Frames.** MuJoCo is Z-up, robot forward is +X, left is +Y. Three.js is
  Y-up; robot/world MuJoCo content lives under a `root` Group with
  `rotation.x = -Math.PI/2`, so MuJoCo (x, y, z) renders at three (x, z, -y).
- **Simulation.** `timestep = 0.005`, `integrator = implicitfast`, control at
  50 Hz (`decimation = 4`). Gravity -9.81.
- **Collision bits** (contype / conaffinity):
  static world incl. floor `1 / 15`; dynamic props `8 / 15`;
  new-pipeline creature feet `2 / 9`; creature body+limbs `4 / 9`;
  visual-only geoms `0 / 0`. No robot self-collision. Legacy Cheetah/Flower
  scenes keep their own bits (Draft default 1/1); the values above still
  collide with them.
- **Naming.** World geoms/bodies start with `world_`, props with `prop_`,
  collectibles are not physical (pure JS proximity checks). Creature joints
  keep Draft names; legs ordered as in the body contract.
- **MuJoCo WASM objects** must be deleted exactly once; borrowed vectors
  (e.g. `data.warning`) are never deleted. Follow the patterns in
  `play/src/draft-lab.js` and the controllers.
- **Honesty.** Never imply a body can walk/jump without a validated policy for
  that exact body (hash-matched). Keep labels like "scripted", "untrained",
  "flat-ground policy" where true. No fake progress bars.
- **Local only.** Services bind 127.0.0.1. API keys only from environment or a
  git-ignored local file read by ai-service; never sent to the browser, never
  logged, never committed.
- **Style.** Match the repo: small, explicit, defensive code; comments explain
  why. No new runtime dependency without a reason stated in your report.
  Fonts/assets are bundled locally (no CDN at runtime).

## 4. Ownership (who may edit what)

| Agent | Owns (may create/edit) | Must not edit |
| --- | --- | --- |
| trainer | `training/**`, `draft-service/training_jobs.py`, `play/src/creature-controller.js`, `qa/creature-*`, `requirements-train.txt`, `contracts/policy-bundle.md` | everything else |
| morphology | `draft-service/designs.py`, `draft-service/templates/**`, `draft-service/test_designs.py`, `robots/multileg/**`, `creatures/**` (bodies only), `contracts/design.schema.json`, `contracts/body-contract.md` | everything else |
| ai | `ai-service/**`, `scripts/setup-local-ai.sh`, `contracts/ai-api.md` | everything else (leave `vlm-service/` in place; main agent removes it) |
| world | `play/src/world/**`, `play/world-dev.html`, `play/public/world/**`, `qa/world-*`, `contracts/world-api.md`; minimal relaxations in `play/src/cheetah-controller.js` / `flower-controller.js` + re-running their QA | `App.jsx`, `draft-lab.js` |
| look | `play/src/appearance/**`, `play/look-dev.html`, `play/public/appearance/**`, `qa/look-*`, `contracts/look.schema.json` | everything else |
| ui | `play/src/ui/**`, `play/src/styles/**`, `play/ui-dev.html`, `play/public/ui/**`, font deps in `play/package.json` | everything else |
| main | `App.jsx`, `draft-lab.js`, `main.jsx`, `vite.config.js`, `draft-service/server.py`, setup/start scripts, README, docs | — |

Need a change outside your area? Don't make it — describe it precisely in your
final report ("integration notes") and the main agent applies it.

## 5. Environment & etiquette (shared 2-core / 7 GB container)

- You work in your own git worktree. Heavy shared deps live in the main checkout
  (the repo root, written `<repo>` below):
  - Draft checkout: `export DRAFT_ROOT=<repo>/.deps/draft`
  - Generator python: `<repo>/.venv/bin/python` (mujoco 3.8.0, Draft installed)
  - Frontend deps: `ln -s <repo>/play/node_modules play/node_modules`
    (ui agent: if you add font packages, `npm install` into your own worktree instead of symlinking).
- Ports: use only your band. trainer 18400-18409, morphology 18410-18419,
  ai 18420-18429, world 18430-18439, look 18440-18449, ui 18450-18459.
- Resources: at most one headless Chromium at a time per agent, closed after
  each check; prefix long CPU jobs with `nice -n 10`; do not run more than one
  `vite build` concurrently; keep training smoke runs short (the trainer agent
  is the only one allowed long CPU jobs, and still with `nice`).
- Screenshots for visual checks: Playwright is preinstalled
  (`NODE_PATH=$(npm root -g) node script.cjs`, chromium with
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`).
- Git: commit your work in your worktree branch with clear messages. Never
  rebase/reset/force anything outside your worktree. Do not push.
- Do not read or print secrets. There are none in this repo; keep it so.

## 6. Done means

Each agent finishes with: working code committed in its worktree, its own
tests/QA passing (state commands and results), screenshots for visual work,
the contract docs it owns up to date, and a short report: what was built,
how to use it, verified results, known limits, integration notes for main.
