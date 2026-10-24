# Playground engine API

Owner: **world** (finalise and keep this file accurate). Consumer: main agent
(App.jsx integration), UI (HUD reads `snapshot()` / events).

The playground is its own engine, separate from the workshop engine
(`draft-lab.js`). It shares the MuJoCo WASM module and the appearance module.

```js
import { createPlayground } from './world/playground.js';

const game = await createPlayground(container, {
  mujoco,                 // loaded @mujoco/mujoco module (shared)
  pilot,                  // see below: which robot + which controller
  look,                   // creature-look/1, rendered via appearance/createCreatureView
  layout: 'park',         // world layout id
  onEvent: e => {},       // { type: 'spark' | 'goal' | 'challenge' | 'fall' | 'sticker' | …, … }
  quality: 'high' | 'low',
});
game.setCommand({ vx, wz });     // from UI touch joystick (keyboard/gamepad handled inside)
game.trigger('jump');            // one-shot skills when available
game.setCameraMode('chase' | 'orbit');
game.setChallenge(id); game.reset(); game.pause(bool); game.setMuted(bool);
game.startExplore(instruction); game.stopExplore();   // VLM landmark navigation
game.snapshot();                 // { robot:{pos,heading,speed,fall}, sparks:{got,total}, challenge, skills, explore, … }
game.dispose();
```

## Pilot

A pilot adapts one policy family to the playground. The engine injects the
world into the pilot's scene XML (after the pilot verified its hashes), then
compiles one MjModel containing robot + world, then attaches the pilot.

```js
pilot = {
  kind: 'legacy-cheetah' | 'legacy-flower' | 'creature',
  async prepare() -> { xml: string, assets: Map<name, Uint8Array>, meta: { rootBody, footSites, jointNames, commandBounds, skills } },
  async attach({ mujoco, model, data }) -> {
    reset(spawn: { x, y, yaw }),            // robot only; world/props state preserved by the engine
    async step(command: [vx, vy, wz], opts?: { jump?: boolean }),   // one 50 Hz control step incl. substeps
    snapshot() -> { position, heading, fall, error, … },
    dispose(),
  },
}
```

World XML rules: see `docs/v2/PLAN.md` §3 (collision bits, `world_`/`prop_`
names). Legacy controllers check `nq` strictly today; the world agent relaxes
those checks to "robot joints resolve by name and come first", then re-runs the
legacy QA so their readiness reports match the edited files.
