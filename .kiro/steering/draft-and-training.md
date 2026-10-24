---
inclusion: fileMatch
fileMatchPattern: ["draft-service/**", "training/**", "creatures/**", "contracts/**", "robots/**", "ai-service/**"]
---
# Draft bodies, policies and the AI designer

## Draft generation

- `RobotGenerator` runs in strict mode. The feasibility gate (`feasibility_report.yaml`) is final. If a design fails, return the gate's hints so Tinker can revise it. Never relax the gate.
- `/api/design` takes the `DesignSpec` itself as the JSON body. It returns `{ body, urls, specSheet, cached }`, or 400 (invalid) / 422 (infeasible, with hints).
- Body files are cached by content hash under `creatures/<bodyId>/`. Generation uses `.venv` (mujoco 3.8.0), so re-generating a known spec reproduces the same hash.

## Policies

- Bundles follow `contracts/policy-bundle.md`. A bundle is valid only for the body hash it was trained on. If the body changes, retrain; never copy a policy across.
- Evaluation rows for `walk`: stand, forward, forward_max, backward, turn_left, turn_right, arc, start_stop, push_recovery, drop_recovery, bumpy. `jump` checks apex gain, airborne time and tilt. All required rows must pass.
- Training uses `.venv-train` (mujoco 3.11.0, CPU torch). On Apple silicon, give `--threads` the performance-core count. Use `--max-wall-seconds` and `--resume` for chunked runs.
- After adding or retraining a bundle, re-run `qa/terrain-trials.mjs` for that robot, then update the README's Terrain Lab table (the `terrain-readme-sync` hook reminds you).

## Structure and terrain reasoning

Explain terrain results from the body's own numbers in `body.json` → `trainability.metrics` and `dimensions`:
- stance legs and gait (`gaitHint`), static and gait stability margins
- centre-of-mass height and belly clearance
- leg length, joint torque per kilogram, and vertical force ratio
- for jumps, measured apex gain and airborne time from `eval.json`

Say "probably" when an explanation is not measured.

## Tinker (ai-service)

- Prompts are built from the live schemas (`ai-service/schemas.py`). Keep them within the token budgets the tests check.
- Every model output is validated and clamped to the schema. Out-of-range values are reported back to the user, never silently accepted.
- Offline mode (`offline_designer.py`) must keep working with no network.
