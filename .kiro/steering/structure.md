---
inclusion: always
---
# Repository structure and conventions

```
play/                    web app
  src/App.jsx            integration: Tinker chat → Draft → workshop → training → playground
  src/app/               api.js (fetch helpers), mujoco.js (WASM singleton), whitebox.js (scene style), recipes.js
  src/ui/                UI kit (AppShell, ChatPanel, SpecSheet, LookPanel, TrainingPanel, PlayHUD, TerrainLab, …)
  src/draft-lab.js       workshop engine: loadBody(), setLook(), setPose(), printKit(), camera framing
  src/world/             playground engine: playground.js, sim.js, camera.js, input.js, pilots.js,
                         layout-park.js (park layout + Terrain Lab lanes), view.js, explore.js, terrain-lab.js
  src/appearance/        looks: palettes, finishes, faces, accessories, print-kit export
  src/creature-controller.js   browser runtime for creature policy bundles (ONNX + MuJoCo)
draft-service/           Draft generation API (/api/design), bodies, training jobs, static /creatures files
ai-service/              Tinker chat (/chat), critique (/critique), vision decisions (/decide), providers
training/creature_gym/   PPO trainer, ONNX export, evaluation gates, benchmarks
creatures/<bodyId>/      body.json, body.xml, meshes, feasibility report, policies/<skill>/ bundles
contracts/               the shared contracts (read these before changing an interface)
docs/v2/                 PLAN.md (architecture), ROSTER-AND-TERRAIN.md (roster + Terrain Lab protocol)
qa/                      headless checks (terrain-trials.mjs writes qa/terrain-trials.json)
robots/flower/, vlm-service/   the original lab's Flower body and legacy vision adapter
```

## Contracts (source of truth for every interface)

- `contracts/design.schema.json`: `DesignSpec` that Tinker produces and `/api/design` accepts.
- `contracts/body-contract.md`: `creature-body/1` (`body.json`): joints, legs, foot geoms, dimensions, trainability, gait hint.
- `contracts/policy-bundle.md`: `creature-policy/1` bundles. Each bundle is `manifest.json`, `policy.onnx`, `scene.xml`, `eval.json`, `fixtures.json` and `progress.json`.
- `contracts/look.schema.json` and `contracts/appearance-api.md`: `creature-look/1`.
- `contracts/ai-api.md` and `contracts/world-api.md`: ai-service endpoints, and the playground/pilot/explore API.

If you change an interface, update its contract file in the same change.

## Conventions

- JavaScript: ES modules, React function components and hooks, two-space indentation, no TypeScript, and no new UI frameworks. Reuse `play/src/ui` components and the CSS tokens in `play/src/styles`.
- Python: standard library first. Services use `http.server` with JSON bodies of at most 256 KiB and strict validation. Tests use `unittest` (`test_*.py`).
- Body ids are `<bodyPlan>-<16 hex>` and come from Draft output hashes. Skill ids are `walk`, `drive` and `jump`.
- Generated or trained artefacts in `creatures/` are only produced by `draft-service` and `creature_gym`, never written by hand.
