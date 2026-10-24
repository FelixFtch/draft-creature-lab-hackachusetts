# Design: a running jump for the Dog

## Overview
Keep the skill id `jump`, so the contracts and the UI stay unchanged. Retrain it with a forward-velocity command, so the same policy hops when standing and leaps when running.

## Training (training/creature_gym)
- Jump episodes start from a range of trot speeds (0 to 0.8 m/s): run the walk policy for a random 1–2 s before the jump trigger, using the existing handoff.
- The observation includes the commanded forward speed at take-off.
- Reward: horizontal take-off-to-landing distance (scaled by commanded speed), apex gain, upright landing, and a smooth return to the walk policy. Keep the current penalties on torque and joint limits.
- Train the `quick` budget first. Use `--max-wall-seconds` and `--resume` for chunks on a Mac.

## Evaluation
- Add a `jump_from_trot` row to `creature_gym.evaluate` with the criteria in requirements 2.1. Keep `jump_from_stand`.

## Browser and trials
- `play/src/creature-controller.js` already hands off walk → jump → walk. Check that it passes the current forward speed into the jump observation.
- The trial driver (`qa/terrain-trials.mjs`, `play/src/world/terrain-lab.js`) already triggers the jump at gap edges for pilots that list a validated jump. Tune `jumpLeadM` only if the trials show early or late take-offs.

## Risks
- The trot gait is dynamic (gait stability margin ≈ 0). If take-offs from a trot tip the Dog, add a short deceleration-and-crouch phase before the leap.
