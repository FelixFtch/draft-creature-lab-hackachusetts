// Deterministic, non-physical decoration placement for a layout: trees,
// pines, bushes, rocks, flowers, grass tufts and clouds. Pure JS, seeded, so
// the baked ground shadows and the instanced meshes always agree. Nothing
// here may sit on gameplay space (zones, paths, landmarks, sparks, hub).
function rng(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

export function planDecor(layout, { density = 1 } = {}) {
  const R = layout.islandRadius, rand = rng(424242);
  const zones = layout.zones.map(z => ({ ...z, a: z.angle * Math.PI / 180 }));
  function blocked(x, y, margin) {
    const r = Math.hypot(x, y);
    if (r < layout.hubRadius + .9 + margin) return true;
    for (const z of zones) {
      const u = x * Math.cos(z.a) + y * Math.sin(z.a), v = -x * Math.sin(z.a) + y * Math.cos(z.a);
      if (u > z.u[0] - margin && u < z.u[1] + margin && v > z.v[0] - margin && v < z.v[1] + margin) return true;
    }
    for (const p of layout.paths) {
      const a = p.angle * Math.PI / 180, u = x * Math.cos(a) + y * Math.sin(a), v = -x * Math.sin(a) + y * Math.cos(a);
      if (u > p.r0 - margin && u < p.r1 + .6 + margin && Math.abs(v) < p.width / 2 + .35 + margin) return true;
    }
    for (const l of layout.landmarks) if (Math.hypot(x - l.x, y - l.y) < 2.1 + margin) return true;
    for (const s of layout.sparks) if (Math.hypot(x - s.x, y - s.y) < .7 + margin) return true;
    for (const s of layout.signs) if (Math.hypot(x - s.x, y - s.y) < .8 + margin) return true;
    return false;
  }
  function scatter(count, { rMin = 0, rMax = R - .7, margin = .3, minGap = 0, into = [] } = {}) {
    const out = [];
    for (let tries = 0; out.length < count && tries < count * 60; tries++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rMin * rMin + rand() * (rMax * rMax - rMin * rMin));
      const x = r * Math.cos(a), y = r * Math.sin(a);
      if (blocked(x, y, margin)) continue;
      if (minGap && [...into, ...out].some(p => Math.hypot(p.x - x, p.y - y) < minGap)) continue;
      out.push({ x, y, rot: rand() * Math.PI * 2, s: .8 + rand() * .5, t: rand() });
    }
    return out;
  }
  const n = x => Math.round(x * density);
  const trees = scatter(n(44), { rMin: 9.6, rMax: R - .75, margin: .35, minGap: 1.5 });
  trees.push(...scatter(n(10), { rMin: 2.6, rMax: 9.4, margin: .55, minGap: 1.6, into: trees }));
  const pines = scatter(n(18), { rMin: 9.8, rMax: R - .8, margin: .35, minGap: 1.3, into: trees });
  const bushes = scatter(n(70), { rMin: 2.2, rMax: R - .7, margin: .2, minGap: .7, into: [...trees, ...pines] });
  const rocks = scatter(n(36), { rMin: 2.4, rMax: R - .7, margin: .15, minGap: .5 });
  const flowers = scatter(n(560), { rMin: 1.9, rMax: R - .9, margin: .05 });
  const tufts = scatter(n(950), { rMin: 1.9, rMax: R - .8, margin: 0 });
  // Rocks around the shoreline, partly in the water.
  const shore = [];
  for (let i = 0; i < n(84); i++) {
    const a = i / n(84) * Math.PI * 2 + rand() * .05, r = R + .05 + rand() * .45, x = r * Math.cos(a), y = r * Math.sin(a);
    if (layout.isLand && layout.lab) { const [u, v] = layout.labLocal(x, y); if (u > layout.lab.pier.u[0] - .8 && Math.abs(v) < layout.lab.pier.v[1] + .6) continue; }
    shore.push({ x, y, rot: rand() * 6.28, s: .55 + rand() * .9, t: rand() });
  }
  const clouds = [];
  // Clouds frame the island from outside; none hang over the play area.
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2 + rand() * .3, r = 16 + rand() * 24;
    clouds.push({ x: r * Math.cos(a), y: r * Math.sin(a), z: 8 + rand() * 7, rot: rand() * 6.28, s: 1.4 + rand() * 1.8, t: rand() });
  }
  // Contact shadows to bake into the ground texture.
  const shadows = [
    ...trees.map(p => ({ x: p.x + .15, y: p.y - .1, r: 1.1 * p.s, strength: .34 })),
    ...pines.map(p => ({ x: p.x + .1, y: p.y - .08, r: .75 * p.s, strength: .3 })),
    ...bushes.map(p => ({ x: p.x + .05, y: p.y - .04, r: .42 * p.s, strength: .22 })),
  ];
  return { trees, pines, bushes, rocks, flowers, tufts, shore, clouds, shadows };
}
