# Implementation plan

- [ ] 1. Add forward speed to jump training
  - In `training/creature_gym`, start jump episodes from trot speeds 0–0.8 m/s, add the commanded speed to the observation, and add the horizontal-distance reward
  - Unit-test the new reward terms on a scripted trajectory
  - _Requirements: 1.1, 1.2_

- [ ] 2. Add the `jump_from_trot` evaluation row
  - Extend `creature_gym.evaluate` with the row and criteria from requirements 2.1; keep `jump_from_stand`
  - _Requirements: 2.1, 2.2_

- [ ] 3. Train and export the new jump bundle for the Dog
  - `cd training && ../.venv-train/bin/python -m creature_gym.train --body ../creatures/quadruped-329a735927fa8b37 --skill jump --budget quick --out ../creatures/quadruped-329a735927fa8b37/policies/jump --max-wall-seconds 1800`, then repeat with `--resume` until done
  - Run `creature_gym.evaluate`; all required rows pass
  - _Requirements: 2.1, 2.2, 2.3_

- [ ] 4. Check the browser handoff
  - Drive the Dog in the playground, press Space while running and while standing; no falls at handoff
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 5. Re-run the terrain trials and update the README
  - `node qa/terrain-trials.mjs --bundle /creatures/quadruped-329a735927fa8b37 --map /creatures=creatures` (merge with the other pilots' results)
  - The terrain-readme-sync hook updates the README table and the Dog explanation
  - _Requirements: 3.1, 3.2_
