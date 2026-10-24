import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Terrain Lab visuals (MuJoCo frame, under the world group). Everything here
// is decoration: the lane obstacles themselves are static world geoms drawn
// by view.js like every other physical object.
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Trebuchet MS", system-ui, sans-serif';
function canvas(w, h) { return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); }
function tex(c) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
// Plane (XY, normal +Z) -> vertical board facing +X, text running along +Y.
const FACE_X = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);

export function createLabView({ world, layout, keep }) {
  const lab = layout.lab, angle = Math.PI; // lab frame: u along -X
  const group = new THREE.Group(); group.name = 'terrain-lab'; world.add(group);
  const toWorld = (u, v, z = 0) => { const [x, y] = layout.labWorld(u, v); return new THREE.Vector3(x, y, z); };
  const animated = [];
  const U0 = lab.pier.u[0], U1 = lab.pier.u[1], V = lab.pier.v[1];

  // ---- painted pier deck: planks, lanes, start/finish lines, labels ----
  {
    const ppm = 96, W = Math.round((U1 - U0) * ppm), H = Math.round(2 * V * ppm), c = canvas(W, H), g = c.getContext('2d');
    // lab (u, v) metres -> canvas pixels, +v up.
    g.setTransform(ppm, 0, 0, -ppm, -U0 * ppm, V * ppm);
    g.fillStyle = '#d7b98e'; g.fillRect(U0, -V, U1 - U0, 2 * V);
    let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let u = U0; u < U1; u += .24) {
      g.fillStyle = rnd() < .5 ? 'rgba(120,80,40,0.10)' : 'rgba(255,240,215,0.12)'; g.fillRect(u, -V, .24, 2 * V);
      g.fillStyle = 'rgba(90,60,30,0.35)'; g.fillRect(u, -V, .012, 2 * V);
      for (let k = 0; k < 6; k++) { g.fillStyle = 'rgba(90,60,30,0.10)'; g.fillRect(u + rnd() * .22, -V, .004, 2 * V); }
    }
    for (const lane of lab.lanes) {
      g.fillStyle = lane.accent + '2e'; g.fillRect(lab.runUp, lane.v - lab.laneWidth / 2, lab.end - lab.runUp, lab.laneWidth);
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = .035; g.setLineDash([.18, .12]);
      for (const side of [-1, 1]) { g.beginPath(); g.moveTo(lab.runUp, lane.v + side * lab.laneWidth / 2); g.lineTo(lab.end, lane.v + side * lab.laneWidth / 2); g.stroke(); }
      g.setLineDash([]);
    }
    const checker = (u0, w) => { for (let v = -V + .1, k = 0; v < V - .1; v += .12, k++) for (let j = 0; j < 2; j++) { g.fillStyle = (k + j) % 2 ? '#1f1f1f' : '#ffffff'; g.fillRect(u0 + j * w / 2, v, w / 2, .12); } };
    checker(lab.start - .12, .24); checker(lab.finish - .12, .24);
    const flat = lab.lanes.find(l => l.id === 'flat');
    g.fillStyle = '#ffffff'; g.fillRect(lab.sprint - .02, flat.v - lab.laneWidth / 2, .04, lab.laneWidth);
    const text = (u, v, str, size, color, weight = 800) => {
      g.save(); g.translate(u, v); g.transform(0, -1, -1, 0, 0, 0); g.scale(.01, .01);
      g.font = `${weight} ${Math.round(size * 100)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color; g.fillText(str, 0, 0); g.restore();
    };
    for (const lane of lab.lanes) {
      text(-1.35, lane.v, lane.title.toUpperCase(), .2, '#3d2a17', 900);
      text(-.85, lane.v, lane.grades.map(x => x.label).join(' · '), .1, '#5a3f22', 700);
    }
    text(lab.sprint + .22, flat.v, '5 m', .16, '#ffffff', 900);
    text(lab.start - .32, 0, 'START', .16, '#ffffff', 900);
    text(lab.finish + .34, 0, 'FINISH', .16, '#ffffff', 900);
    const deck = new THREE.Mesh(keep(new THREE.PlaneGeometry(U1 - U0, 2 * V)), keep(new THREE.MeshStandardMaterial({ map: keep(tex(c)), roughness: .85 })));
    deck.position.copy(toWorld((U0 + U1) / 2, 0, .003)); deck.rotation.z = angle; deck.receiveShadow = true; group.add(deck);
    // Beams and pilings down into the sea.
    const beam = keep(new THREE.MeshStandardMaterial({ color: '#8a6440', roughness: .9 }));
    const skirt = new THREE.Mesh(keep(new THREE.BoxGeometry(U1 - U0, 2 * V, .55)), beam);
    skirt.position.copy(toWorld((U0 + U1) / 2, 0, -.28)); skirt.rotation.z = angle; group.add(skirt);
    const pile = keep(new THREE.CylinderGeometry(.11, .13, 1.6, 10).rotateX(Math.PI / 2));
    for (let u = U0 + .4; u < U1; u += 2.4) for (const v of [-V + .15, V - .15]) {
      const p = new THREE.Mesh(pile, beam); p.position.copy(toWorld(u, v, -.55)); group.add(p);
    }
  }

  // ---- gantries over the start and finish lines (above every creature) ----
  {
    const metal = keep(new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: .35, metalness: .3 }));
    const post = keep(new THREE.CylinderGeometry(.05, .06, 2.3, 12).rotateX(Math.PI / 2).translate(0, 0, 1.15));
    for (const [u, label, color] of [[lab.start, 'START', '#2f9e6e'], [lab.finish, 'FINISH', '#e07a5f']]) {
      for (const v of [-V + .05, V - .05]) { const m = new THREE.Mesh(post, metal); m.position.copy(toWorld(u, v)); m.castShadow = true; group.add(m); }
      const bar = new THREE.Mesh(keep(new THREE.BoxGeometry(.08, 2 * V - .1, .1)), metal); bar.position.copy(toWorld(u, 0, 2.3)); bar.rotation.z = angle; group.add(bar);
      const c = canvas(1024, 160), g = c.getContext('2d');
      for (let i = 0; i < 32; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#222' : '#fff'; g.fillRect(i * 32, j * 20, 32, 20); }
      g.fillStyle = color; g.fillRect(0, 40, 1024, 120);
      g.fillStyle = '#ffffff'; g.font = `900 92px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`TERRAIN LAB · ${label}`, 512, 102);
      // Faces back toward the island (+X): the approaching creature and camera.
      const banner = new THREE.Mesh(keep(new THREE.PlaneGeometry(4.2, .66).applyMatrix4(FACE_X)), keep(new THREE.MeshStandardMaterial({ map: keep(tex(c)), side: THREE.DoubleSide, roughness: .7 })));
      banner.position.copy(toWorld(u, 0, 1.95)); group.add(banner);
    }
  }

  // ---- per-grade signs on the lane dividers, facing the start ----
  {
    const wood = keep(new THREE.MeshStandardMaterial({ color: '#9c6430', roughness: .85 }));
    for (const lane of lab.lanes) for (const grade of lane.grades) {
      if (grade.kind === 'sprint') continue;
      const c = canvas(256, 150), g = c.getContext('2d');
      g.fillStyle = '#fffaf0'; g.fillRect(0, 0, 256, 150); g.fillStyle = lane.accent; g.fillRect(0, 0, 256, 34);
      g.fillStyle = '#ffffff'; g.font = `800 24px ${FONT}`; g.textAlign = 'center'; g.fillText(lane.title.toUpperCase(), 128, 25);
      g.fillStyle = '#2f2a22'; g.font = `900 ${grade.label.length > 9 ? 44 : 54}px ${FONT}`; g.fillText(grade.label.replace(' step', '').replace(' gap', ''), 128, 104);
      g.font = `700 20px ${FONT}`; g.fillStyle = '#6f6556'; g.fillText(grade.kind === 'gap' ? 'gap over a 0.6 m pit' : grade.kind === 'step' ? 'step-up' : grade.kind === 'slope' ? 'slope' : 'scattered blocks', 128, 136);
      const base = lane.id === 'gap' ? lane.deck : grade.kind === 'step' ? grade.level - grade.value : grade.kind === 'slope' ? 0 : 0;
      const holder = new THREE.Group(); holder.position.copy(toWorld(grade.at - .1, lane.v - lab.laneWidth / 2 - .1, 0)); holder.rotation.z = angle + Math.PI; group.add(holder);
      const height = base + .55;
      const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(.015, .018, height, 8).rotateX(Math.PI / 2).translate(0, 0, height / 2)), wood); holder.add(post);
      const board = new THREE.Mesh(keep(new THREE.PlaneGeometry(.3, .176).applyMatrix4(FACE_X)), keep(new THREE.MeshStandardMaterial({ map: keep(tex(c)), roughness: .8, side: THREE.DoubleSide })));
      board.position.set(.02, 0, height + .07); holder.add(board);
    }
  }

  // ---- gap lane: hazard stripes at the edges and soft foam in the pit ----
  {
    const gap = lab.lanes.find(l => l.id === 'gap');
    const c = canvas(64, 16), g = c.getContext('2d');
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#222222' : '#ffd23f'; g.beginPath(); g.moveTo(i * 8, 16); g.lineTo(i * 8 + 8, 0); g.lineTo(i * 8 + 16, 0); g.lineTo(i * 8 + 8, 16); g.fill(); }
    const stripeTex = keep(tex(c)); stripeTex.wrapS = THREE.RepeatWrapping; stripeTex.repeat.set(8, 1);
    const stripeMat = keep(new THREE.MeshStandardMaterial({ map: stripeTex, roughness: .6 }));
    for (const [u0, u1] of gap.segments) for (const edge of [u0, u1]) {
      if (edge <= lab.runUp - .1 || edge >= lab.end - .01) continue;
      const strip = new THREE.Mesh(keep(new THREE.PlaneGeometry(.08, lab.laneWidth - .02)), stripeMat);
      strip.position.copy(toWorld(edge + (edge === u0 ? .04 : -.04), gap.v, gap.deck + .002)); strip.rotation.z = angle; group.add(strip);
    }
    const cubes = [];
    let s = 3; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    gap.grades.forEach(gr => {
      for (let i = 0; i < Math.round(60 * gr.value + 10); i++)
        cubes.push({ p: toWorld(gr.at + .03 + rnd() * (gr.value - .06), gap.v + (rnd() * 2 - 1) * (lab.laneWidth / 2 - .06), .05 + rnd() * .16), r: rnd() * 3, c: ['#ff8fb8', '#ffd76a', '#8fd3ff', '#9be3b4', '#c7b6f2'][i % 5] });
    });
    const mesh = new THREE.InstancedMesh(keep(new RoundedBoxGeometry(.12, .12, .12, 2, .025)), keep(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .95 })), cubes.length);
    const d = new THREE.Object3D(), col = new THREE.Color();
    cubes.forEach((q, i) => { d.position.copy(q.p); d.rotation.set(q.r, q.r * .7, q.r * 1.3); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); mesh.setColorAt(i, col.set(q.c)); });
    mesh.receiveShadow = true; group.add(mesh);
  }

  // ---- results board: measured trials for this creature (honest) ----
  const board = { mesh: null, texture: null };
  {
    const [x, y] = layout.fromZoneLocal('steps', 11.35, -2.75);
    const holder = new THREE.Group(); holder.position.set(x, y, 0); holder.rotation.z = 0; group.add(holder);
    const wood = keep(new THREE.MeshStandardMaterial({ color: '#7b5230', roughness: .85 }));
    for (const side of [-.95, .95]) { const p = new THREE.Mesh(keep(new THREE.CylinderGeometry(.04, .05, 1.75, 10).rotateX(Math.PI / 2).translate(0, 0, .875)), wood); p.position.set(-.06, side, 0); p.castShadow = true; holder.add(p); }
    const back = new THREE.Mesh(keep(new RoundedBoxGeometry(.05, 2.08, 1.22, 2, .03)), wood); back.position.set(-.03, 0, 1.12); back.castShadow = true; holder.add(back);
    board.mesh = new THREE.Mesh(keep(new THREE.PlaneGeometry(2.0, 1.15).applyMatrix4(FACE_X)), new THREE.MeshStandardMaterial({ roughness: .8 }));
    board.mesh.position.set(.0, 0, 1.12); holder.add(board.mesh);
  }
  function setResults(measured, pilotLabel) {
    const W = 1024, H = 590, c = canvas(W, H), g = c.getContext('2d');
    g.fillStyle = '#fff8ea'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#2f3b52'; g.fillRect(0, 0, W, 86);
    g.fillStyle = '#ffffff'; g.font = `900 46px ${FONT}`; g.fillText('TERRAIN LAB', 28, 58);
    g.font = `700 26px ${FONT}`; g.textAlign = 'right'; g.fillText(`measured: ${pilotLabel}`, W - 28, 56); g.textAlign = 'left';
    const lanes = lab.lanes;
    if (!measured) {
      g.fillStyle = '#5a5246'; g.font = `700 30px ${FONT}`;
      g.fillText('No measured trials for this creature yet.', 28, 160);
      g.font = `600 24px ${FONT}`; g.fillText('Results come only from qa/terrain-trials.mjs runs.', 28, 205);
    } else {
      lanes.forEach((lane, r) => {
        const y = 110 + r * 92;
        g.fillStyle = lane.accent; g.fillRect(28, y, 10, 74);
        g.fillStyle = '#2f2a22'; g.font = `800 30px ${FONT}`; g.fillText(lane.title, 52, y + 32);
        const run = measured.runs?.[lane.id];
        g.font = `600 20px ${FONT}`; g.fillStyle = '#6f6556';
        g.fillText(run ? (run.outcome === 'pass' ? `full lane ${run.timeS}s` : `full lane: ${run.outcome} at ${run.failure?.grade ?? '?'}`) : '', 52, y + 62);
        lane.grades.forEach((gr, k) => {
          const res = measured.grades?.[gr.id], x = 330 + k * 228, ok = res?.outcome === 'pass', fall = res?.outcome === 'fall';
          g.fillStyle = !res ? '#e7e1d6' : ok ? '#2f9e6e' : fall ? '#cf5a4f' : '#d39b2a';
          g.beginPath(); g.roundRect?.(x, y + 4, 212, 66, 14); if (!g.roundRect) g.rect(x, y + 4, 212, 66); g.fill();
          g.fillStyle = '#ffffff'; g.font = `800 24px ${FONT}`; g.fillText(gr.label, x + 14, y + 33);
          g.font = `700 20px ${FONT}`;
          g.fillText(!res ? 'not measured' : ok ? `pass · ${res.timeS}s` : `${res.outcome}: ${res.failure?.reason ?? ''}`, x + 14, y + 59);
        });
      });
    }
    board.texture?.dispose(); board.texture = tex(c);
    board.mesh.material.map = board.texture; board.mesh.material.needsUpdate = true;
  }
  setResults(null, '—');
  return {
    group, setResults,
    update(t) { for (const fn of animated) fn(t); },
    dispose() { board.texture?.dispose(); board.mesh.material.dispose(); group.removeFromParent(); },
  };
}
