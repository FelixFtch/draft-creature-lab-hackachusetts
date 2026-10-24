# Requirements: a running jump for the Dog

## Introduction

The Terrain Lab shows that the Dog (`creatures/quadruped-329a735927fa8b37`) falls into every gap. Its body is strong enough: the vertical force ratio is 8.2× body weight and torque is 2.2 N·m/kg. The problem is the skill. The current `jump` policy is a hop in place: 0.0975 m apex gain and 0.2 s airborne (`policies/jump/eval.json`). At walking speed that carries the Dog well short of 0.20 m. This feature trains a forward leap, so the Dog can cross the 0.20 m and 0.35 m gaps when the player presses Space while running.

## Requirements

### Requirement 1: leap on command while moving

**User Story:** As a player driving the Dog, I want Space to make it leap forward while it is running, so that it can clear gaps in the park.

#### Acceptance Criteria
1. WHEN the player presses Space while the Dog moves forward at 0.4 m/s or faster THEN the Dog SHALL leap forward and land on its feet.
2. WHEN the player presses Space while standing still THEN the Dog SHALL hop in place, as it does today.
3. The handoff from walk to jump and back SHALL not cause a fall, within the existing handoff window.

### Requirement 2: measured gates before shipping

**User Story:** As a maintainer, I want the leap to pass evaluation gates, so that the UI only offers a jump that really works.

#### Acceptance Criteria
1. The jump bundle's `eval.json` SHALL add a `jump_from_trot` row: 0.6 m/s approach, at least 0.45 m horizontal travel between take-off and landing, tilt under 0.6 rad, and no fall.
2. The existing `jump_from_stand` row SHALL still pass.
3. The bundle SHALL follow `contracts/policy-bundle.md` and be trained on the current Dog body hash.

### Requirement 3: proven on the Terrain Lab

**User Story:** As a judge reading the README, I want the terrain table to show the improvement, so that the structure-versus-skill story is backed by data.

#### Acceptance Criteria
1. WHEN `qa/terrain-trials.mjs` runs for the Dog THEN `gap-20cm` and `gap-35cm` SHALL pass.
2. The README Terrain Lab table and the Dog explanation SHALL be updated from the new `qa/terrain-trials.json`.
