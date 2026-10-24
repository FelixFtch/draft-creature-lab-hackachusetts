# Appearance module API

Owner: **look** (finalise and keep accurate). Consumers: workshop engine
(`draft-lab.js`, main agent) and playground engine (world agent).

The appearance module owns *how a creature looks* — it builds the whole visual
representation of a robot from a compiled MuJoCo model, so both engines render
creatures identically. It never mutates the MuJoCo model.

```js
import { createCreatureView, normalizeLook, LOOK_PRESETS, createStudio, exportPrintKit } from './appearance/index.js';

const view = createCreatureView({
  THREE, mujoco, model,
  look,            // creature-look/1 (normalised internally)
  body,            // optional creature-body/1 contract (roles, legs); infer from names when absent
  rootBody,        // name of the robot root body; geoms outside its subtree (world/props) are ignored
});
root.add(view.group);     // root = Group with rotation.x = -PI/2 (MuJoCo frame)
view.sync(data);          // each frame after physics: geom + body transforms from data
view.setLook(look);       // restyle in place (no rebuild of physics)
view.setMode('normal' | 'blueprint' | 'xray');   // blueprint: technical drawing style for the workshop
view.playPrintReveal(seconds);  // layer-by-layer 3D-printer reveal animation (workshop)
view.update(dt);          // animations (eyes blink, accessory wobble, reveal)
view.dispose();

const studio = createStudio({ THREE, scene, renderer });   // workshop backdrop, lights, printer bed, turntable
studio.update(dt); studio.dispose();

const blob = await exportPrintKit({ THREE, mujoco, model, data, look, body });   // decorative shells as STL (zip or single STL)
```

Legacy color behaviour (`_sphere` feet dark, `_motor` darker, `_detail`
darkest, `_link` lighter) becomes the `classic` look so old recipes with a
single hex color still render as before (`normalizeLook('#1f8c80')` works).
