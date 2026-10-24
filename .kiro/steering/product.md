---
inclusion: always
---
# Product: Draft Creature Lab

Draft Creature Lab is a local, browser-based robot-making game for students, makers and robotics newcomers. One session goes through five steps, which the UI shows as a stepper:

1. **Imagine.** The user describes a robot to **Tinker**, the AI designer (`ai-service`). Tinker answers with a `DesignSpec` (`contracts/design.schema.json`) and a look (`contracts/look.schema.json`).
2. **Draft.** `draft-service` sends the spec to **Draft** (MIT; Nguyen, Coelho & Kim), pinned to commit `3b03e144`. Draft generates a real MuJoCo body: links, joints, meshes, masses, and actuators sized from fitted motor trends. Draft's feasibility gate decides what is buildable. Tinker revises rejected designs using the gate's hints.
3. **Dress up.** Looks (`creature-look/1`) change colours, finishes, faces and add-ons. They never change physics.
4. **Train.** `training/creature_gym` runs CPU PPO and exports ONNX `walk` / `jump` policies. A policy only reaches the UI after its `eval.json` passes for that exact body hash.
5. **Play.** The robot is driven like a game character (WASD/arrows, gamepad sticks, touch joystick; Space = jump) in a white-box park with props, a Terrain Lab (rubble, steps, gaps, ramps) and vision-model **Explore** goals.

## Robot roster

| Robot | Body id | Skills | Status |
| --- | --- | --- | --- |
| Dog (quadruped) | `quadruped-329a735927fa8b37` | walk, jump | done |
| Octo (8-leg spider) | `multileg-cfeadbfbef98a249` | walk | done |
| Flower crawler (6 legs) | legacy, `robots/flower` | walk | done (original lab) |
| Cheetah (quadruped) | legacy | walk | done (original lab) |
| Rollo (wheel-leg) | — | drive, jump | not started: plan in `docs/v2/ROSTER-AND-TERRAIN.md` §1 |
| Bipo (humanoid) | — | walk | not started: plan in `docs/v2/ROSTER-AND-TERRAIN.md` §1 |

Measured terrain results for every robot are in `qa/terrain-trials.json`. They are summarised, with structural explanations, in the README section "Terrain Lab".

## Product principles

- **Honest physics.** What the user sees is the MuJoCo simulation. Never fake motion with animation, and never hand-edit generated bodies.
- **Draft is the source of truth for bodies.** Do not edit `creatures/*/body.xml`, meshes or recorded hashes by hand. Regenerate them through `draft-service`.
- **Skills are earned.** The UI offers a skill (walk, jump, drive) only when its bundle passed evaluation for that body.
- **The world judges goals,** not the AI model. Explore succeeds only when the simulation says the landmark was reached.
- **Local first.** Everything works offline. Cloud AI keys are optional, read from the environment or the git-ignored `ai-service/.env.local`, and never committed.
- **The robot is the hero** of every screen. See the `whitebox-style` steering file.

## Backlog (in priority order)

1. `.kiro/specs/fix-ai-service-tests`: bring the three stale ai-service tests up to date and add property-based tests.
2. `.kiro/specs/dog-running-jump`: a forward leap so the Dog can cross the 0.20 m and 0.35 m gaps.
3. Rollo, the wheel-leg robot: create a spec from `docs/v2/ROSTER-AND-TERRAIN.md` §1 (wheel joints, `drive` skill, velocity actuators).
4. Bipo, the humanoid: create a spec from the same section (Draft humanoid with arm/torso joints disabled, 12 leg joints).
5. Terrain curricula (steps, rubble) for walk policies. Then refresh `qa/terrain-trials.json` and the README table.
