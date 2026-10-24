import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintGround, GROUND_EXTENT } from './ground-texture.js';
import { planDecor } from './decor.js';
import * as TX from './textures.js';

// World visuals for the playground. Everything MuJoCo-related is authored in
// the MuJoCo frame under `root` (rotation.x = -PI/2): (x, y, z) here renders
// at three (x, z, -y). Physics never reads anything from this module.
export const PALETTE = {
  zenith: '#5fb2e6', horizon: '#ffe8c6', below: '#cdebea',
  waterDeep: '#2a87ad', waterShallow: '#69d0c8', foam: '#fbfffb',
  sun: '#fff0d2', hemiSky: '#fff1da', hemiGround: '#88ad66', fill: '#cfe6ff',
};
const SUN_DIR = new THREE.Vector3(-.42, .8, .43).normalize(); // three coords
const WATER_Z = -.28;
const nonIndexed = g => (g.index ? g.toNonIndexed() : g);
const quatRotateArr = (q, v) => { const r = new THREE.Vector3(...v).applyQuaternion(new THREE.Quaternion(q[1], q[2], q[3], q[0])); return [r.x, r.y, r.z]; };

export function createWorldView({ scene, root, layout, terrain, hfields = [], props = [], quality = 'high', renderer, creatureSize }) {
  const high = quality !== 'low';
  const owned = new Set(), keep = x => (owned.add(x), x);
  const world = new THREE.Group(); world.name = 'park'; root.add(world);
  const occluders = [];
  const animated = [];
  const height = creatureSize?.height ?? .45;

  // ------------------------------------------------------------- sky + fog
  const horizon = new THREE.Color(PALETTE.horizon);
  scene.background = horizon.clone();
  scene.fog = new THREE.Fog(horizon.clone(), 30, 105);
  const skyMat = keep(new THREE.ShaderMaterial({
    uniforms: { uZenith: { value: new THREE.Color(PALETTE.zenith) }, uHorizon: { value: horizon.clone() }, uBelow: { value: new THREE.Color(PALETTE.below) },
      uSunDir: { value: SUN_DIR.clone() }, uSunColor: { value: new THREE.Color('#fff2d6') } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; gl_Position.z *= 0.9999; }`,
    fragmentShader: `uniform vec3 uZenith, uHorizon, uBelow, uSunDir, uSunColor; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
        col = mix(col, uBelow, smoothstep(0.015, -0.18, h));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        col += uSunColor * (pow(s, 1100.0) * 4.0 + pow(s, 28.0) * 0.18 + pow(s, 5.0) * 0.07);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
  }));
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(400, 32, 16)), skyMat);
  sky.frustumCulled = false; sky.renderOrder = -10; scene.add(sky);

  // ---------------------------------------------------------------- lights
  const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.3); scene.add(hemi);
  const sun = new THREE.DirectionalLight(PALETTE.sun, 2.55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
  const shadowHalf = Math.max(5, Math.min(9, 5 + height * 4));
  Object.assign(sun.shadow.camera, { left: -shadowHalf, right: shadowHalf, top: shadowHalf, bottom: -shadowHalf, near: .5, far: 60 });
  sun.shadow.bias = -.00025; sun.shadow.normalBias = .025; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(PALETTE.fill, .5); fill.position.set(14, 7, -10); scene.add(fill);

  // ----------------------------------------------------------------- water
  const waterMat = keep(new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uR: { value: layout.islandRadius },
      uDeep: { value: new THREE.Color(PALETTE.waterDeep) }, uShallow: { value: new THREE.Color(PALETTE.waterShallow) }, uFoam: { value: new THREE.Color(PALETTE.foam) } }]),
    vertexShader: `#include <fog_pars_vertex>
      varying vec2 vXY; void main(){ vXY = position.xy; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      uniform float uTime, uR; uniform vec3 uDeep, uShallow, uFoam; varying vec2 vXY;
      float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      void main(){ float d = length(vXY);
        float shore = smoothstep(uR + 7.0, uR + 0.2, d);
        vec3 col = mix(uDeep, uShallow, shore * 0.9);
        float n = vn(vXY * 0.8 + vec2(uTime * 0.05, uTime * 0.03)) * 0.55 + vn(vXY * 2.1 - vec2(uTime * 0.07, -uTime * 0.05)) * 0.45;
        col *= 0.93 + 0.14 * n;
        // Glints fade out with screen-space footprint so distant water does
        // not turn into speckle noise.
        float fade = 1.0 - smoothstep(0.03, 0.12, fwidth(vXY.x * 3.0));
        float sp = pow(vn(vXY * 3.2 + vec2(uTime * 0.35, -uTime * 0.25)), 30.0) * 2.2 * fade * (1.0 - shore * 0.5);
        col += vec3(sp);
        float ring = smoothstep(uR + 1.1, uR + 0.08, d) * (0.5 + 0.5 * sin(d * 10.0 - uTime * 1.7 + n * 5.0));
        col = mix(col, uFoam, clamp(ring, 0.0, 1.0) * 0.8);
        col = mix(col, uFoam, smoothstep(uR + 0.28, uR + 0.02, d) * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    fog: true,
  }));
  const water = new THREE.Mesh(keep(new THREE.CircleGeometry(170, 96)), waterMat);
  water.position.z = WATER_Z; world.add(water);

  // ---------------------------------------------------------------- island
  const decor = planDecor(layout, { density: high ? 1 : .55 });
  const staticShadows = [];
  for (const l of layout.landmarks) staticShadows.push({ x: l.x + .2, y: l.y - .15, r: l.shape === 'tree' ? 1.9 : 1.2, strength: .32 });
  for (const s of layout.statics) if (s.role === 'plateau' || s.role === 'platform' || s.role === 'step')
    staticShadows.push({ x: s.pos[0] + .1, y: s.pos[1] - .1, r: Math.max(s.size[0], s.size[1]) * 1.15, strength: .12 });
  const groundCanvas = paintGround(layout, { size: high ? 2048 : 1024, shadows: staticShadows, decor: decor.shadows });
  const groundTex = keep(new THREE.CanvasTexture(groundCanvas));
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
  const S = GROUND_EXTENT;
  const groundMat = keep(new THREE.MeshStandardMaterial({ map: groundTex, roughness: .96, metalness: 0 }));
  groundMat.onBeforeCompile = shader => {
    // Fine world-space grain so the ground stays textured up close.
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGrain;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrain = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec2 vGrain;
      float gh(vec2 p){ p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
      float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', '#include <map_fragment>\nfloat grain = gn(vGrain * 22.0) * 0.6 + gn(vGrain * 70.0) * 0.4;\ndiffuseColor.rgb *= 0.92 + 0.16 * grain;');
  };
  const worldUV = geometry => {
    const p = geometry.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) + S) / (2 * S); uv[i * 2 + 1] = (p.getY(i) + S) / (2 * S); }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geometry;
  };
  const island = new THREE.Mesh(keep(worldUV(new THREE.CircleGeometry(layout.islandRadius, 200))), groundMat);
  island.receiveShadow = true; world.add(island);
  {
    const geometry = keep(new THREE.CylinderGeometry(layout.islandRadius + .01, layout.islandRadius + .45, 1, 200, 5, true).rotateX(Math.PI / 2).translate(0, 0, -.5));
    const pos = geometry.attributes.position, colors = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      c.set(z > -.04 ? '#c9a46c' : z > -.25 ? '#d8b57f' : z > -.55 ? '#b88a5c' : '#946a47');
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    world.add(new THREE.Mesh(geometry, keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }))));
  }
  // Heightfields: the exact physics samples (same grid as hfield_data),
  // tinted by height (lush valleys, sunlit crests) so gentle bumps read.
  const hillMat = keep(new THREE.MeshStandardMaterial({ map: groundTex, roughness: .96, metalness: 0, vertexColors: true }));
  hillMat.onBeforeCompile = groundMat.onBeforeCompile;
  for (const h of hfields) {
    const { nrow, ncol, heights, halfSize: [sx, sy] } = h.grid, c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    const position = new Float32Array(nrow * ncol * 3), color = new Float32Array(nrow * ncol * 3), index = [];
    // Flat border stays exactly untinted (it meets the lawn); crests warm up.
    const top = Math.max(.02, h.max), low = new THREE.Color(1, 1, 1), high = new THREE.Color(1.2, 1.16, .9), tint = new THREE.Color();
    for (let r = 0; r < nrow; r++) for (let q = 0; q < ncol; q++) {
      const lx = -sx + 2 * sx * q / (ncol - 1), ly = -sy + 2 * sy * r / (nrow - 1), i = (r * ncol + q) * 3, z = heights[r * ncol + q];
      position[i] = h.center[0] + lx * c - ly * s; position[i + 1] = h.center[1] + lx * s + ly * c; position[i + 2] = z - .004;
      tint.copy(low).lerp(high, Math.min(1, z / top)); color.set([tint.r, tint.g, tint.b], i);
      if (r < nrow - 1 && q < ncol - 1) { const a = r * ncol + q, b = a + 1, d = a + ncol, e = d + 1; index.push(a, b, e, a, e, d); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3)); geometry.setAttribute('color', new THREE.BufferAttribute(color, 3)); geometry.setIndex(index);
    worldUV(geometry); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(keep(geometry), hillMat); mesh.receiveShadow = true; mesh.castShadow = true; mesh.name = h.name;
    world.add(mesh); occluders.push(mesh);
  }

  // ---------------------------------------------------- static world geoms
  const materials = new Map();
  function material(key, make) { if (!materials.has(key)) materials.set(key, keep(make())); return materials.get(key); }
  const tileTex = keep(TX.tileTexture('#ffffff', 'rgba(110,95,70,0.42)'));
  const plankTex = new Map();
  function matFor(s) {
    const c = s.color;
    if (s.role === 'ramp') { if (!plankTex.has(c)) plankTex.set(c, keep(TX.plankTexture(c))); return material(`ramp${c}`, () => new THREE.MeshStandardMaterial({ map: plankTex.get(c), roughness: .78 })); }
    if (s.role === 'plateau' || s.role === 'step') return material(`tile${c}`, () => new THREE.MeshStandardMaterial({ color: c, map: tileTex, roughness: .9 }));
    if (s.role === 'platform') return material(`candy${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: .32, clearcoat: .8, clearcoatRoughness: .25 }));
    if (s.surface === 'metal') return material(`metal${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: .28, metalness: .35 }));
    if (s.surface === 'wood') return material(`wood${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: .8 }));
    if (s.surface === 'crystal') return material(`crystal${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: .12, clearcoat: 1, emissive: new THREE.Color(c).multiplyScalar(.35), flatShading: true }));
    if (s.surface === 'leaves') return material(`leaves${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: .9, flatShading: true }));
    if (s.surface === 'paint' && s.role === 'landmark') return material(`gloss${c}`, () => new THREE.MeshPhysicalMaterial({ color: c, roughness: .38, clearcoat: .6, clearcoatRoughness: .3 }));
    if (s.surface === 'paint') return material(`paint${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: .6 }));
    return material(`stone${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: .92 }));
  }
  // Tile/plank UVs in each box's own frame (consistent density, edges align).
  function boxUV(geometry, tile) {
    const p = geometry.attributes.position, n = geometry.attributes.normal, uv = geometry.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      const [a, b] = az >= ax && az >= ay ? [p.getX(i), p.getY(i)] : ax >= ay ? [p.getY(i), p.getZ(i)] : [p.getX(i), p.getZ(i)];
      uv.setXY(i, a / tile, b / tile);
    }
    return geometry;
  }
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  function geometryFor(s) {
    let g;
    if (s.type === 'box') {
      const [hx, hy, hz] = s.size, r = Math.min(.035, .45 * Math.min(hx, hy, hz));
      g = r > .002 ? new RoundedBoxGeometry(2 * hx, 2 * hy, 2 * hz, 2, r) : new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz);
      if (s.role === 'ramp') boxUV(g, .18); else if (s.role === 'plateau' || s.role === 'step') boxUV(g, .5);
    } else if (s.type === 'cylinder') g = new THREE.CylinderGeometry(s.size[0], s.size[0], 2 * s.size[1], 32).rotateX(Math.PI / 2);
    else if (s.type === 'sphere') g = new THREE.SphereGeometry(s.size[0], 40, 24);
    else if (s.type === 'capsule') {
      const a = new THREE.Vector3(...s.fromto.slice(0, 3)), b = new THREE.Vector3(...s.fromto.slice(3)), len = a.distanceTo(b);
      g = new THREE.CapsuleGeometry(s.size[0], len, 8, 16);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
      g.translate(...a.clone().add(b).multiplyScalar(.5).toArray());
      return g.index ? g.toNonIndexed() : g;
    }
    if (!g) return null;
    m4.compose(v3.set(...s.pos), q4.set(s.quat[1], s.quat[2], s.quat[3], s.quat[0]), one);
    g.applyMatrix4(m4);
    return g.index ? g.toNonIndexed() : g;
  }
  const buckets = new Map();
  const skipVisual = s => s.name.endsWith('_canopy') || s.name.endsWith('_gem');
  for (const s of layout.statics) {
    if (skipVisual(s)) continue;
    const g = geometryFor(s);
    if (!g) continue;
    const mat = matFor(s);
    (buckets.get(mat) ?? buckets.set(mat, []).get(mat)).push(g);
  }
  // Visual-only trims: coral caps on court walls; bright nosing strips on
  // every stair edge so even 1.4 cm risers read clearly.
  const coral = material('paint#ff8a6b', () => new THREE.MeshStandardMaterial({ color: '#ff8a6b', roughness: .55 }));
  const nosing = material('paint#fffdf4', () => new THREE.MeshStandardMaterial({ color: '#fffdf4', roughness: .5, emissive: '#3a3226', emissiveIntensity: .15 }));
  const addTo = (mat, g) => (buckets.get(mat) ?? buckets.set(mat, []).get(mat)).push(g);
  for (const s of layout.statics) {
    if (s.role === 'wall') addTo(coral, geometryFor({ ...s, size: [s.size[0] + .006, s.size[1] + .006, .025], pos: [s.pos[0], s.pos[1], s.pos[2] + s.size[2]], role: 'trim' }));
    if (s.role === 'step') for (const side of [-1, 1]) {
      const local = quatRotateArr(s.quat, [side * (s.size[0] - .03), 0, s.size[2] + .0015]);
      addTo(nosing, geometryFor({ ...s, type: 'box', size: [.03, s.size[1] - .004, .003], pos: [s.pos[0] + local[0], s.pos[1] + local[1], s.pos[2] + local[2]], role: 'trim' }));
    }
  }
  for (const [mat, list] of buckets) {
    for (const g of list) for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const merged = keep(mergeGeometries(list, false));
    list.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(merged, mat); mesh.castShadow = true; mesh.receiveShadow = true;
    world.add(mesh); occluders.push(mesh);
  }

  // ------------------------------------------------------ landmark extras
  for (const l of layout.landmarks) {
    const g = new THREE.Group(); g.position.set(l.x, l.y, 0); g.rotation.z = l.yaw; world.add(g);
    const gloss = material(`gloss${l.color}`, () => new THREE.MeshPhysicalMaterial({ color: l.color, roughness: .38, clearcoat: .6, clearcoatRoughness: .3 }));
    const white = material('paint#fffaf0', () => new THREE.MeshStandardMaterial({ color: '#fffaf0', roughness: .6 }));
    if (l.shape === 'tree') {
      const canopy = new THREE.Group(); canopy.position.z = 2.25; g.add(canopy);
      const leaf = material(`leaves${l.color}`, () => new THREE.MeshStandardMaterial({ color: l.color, roughness: .85, flatShading: true }));
      const leaf2 = material('leaves#6cc25a', () => new THREE.MeshStandardMaterial({ color: '#6cc25a', roughness: .85, flatShading: true }));
      // A big, round "storybook" tree with fruit: unmistakable next to the
      // small decorative trees (the canopy is above every creature's head).
      canopy.scale.setScalar(1.3); canopy.position.z = 2.45;
      for (const [x, y, z, r, m] of [[0, 0, 0, .95, leaf], [.55, .2, -.15, .62, leaf2], [-.5, -.25, -.1, .66, leaf2], [.1, -.55, .2, .58, leaf], [-.15, .5, .25, .6, leaf], [0, 0, .62, .55, leaf2]]) {
        const puff = new THREE.Mesh(keep(new THREE.IcosahedronGeometry(r, 1)), m); puff.position.set(x, y, z); puff.castShadow = true; canopy.add(puff);
      }
      const apple = material('gloss#ff4d4d', () => new THREE.MeshPhysicalMaterial({ color: '#ff4d4d', roughness: .3, clearcoat: .8 }));
      const appleGeo = keep(new THREE.SphereGeometry(.075, 12, 10));
      for (let i = 0; i < 14; i++) {
        const a = i * 2.39996, e = -.35 + (i % 5) * .22, r = 1.0;
        const fruit = new THREE.Mesh(appleGeo, apple); fruit.position.set(Math.cos(a) * Math.cos(e) * r, Math.sin(a) * Math.cos(e) * r, Math.sin(e) * r + .05); canopy.add(fruit);
      }
      const trunkTop = new THREE.Mesh(keep(new THREE.CylinderGeometry(.2, .26, .9, 10).rotateX(Math.PI / 2)), material('wood#8a5a3b', () => new THREE.MeshStandardMaterial({ color: '#8a5a3b', roughness: .8 })));
      trunkTop.position.z = 1.95; g.add(trunkTop);
      animated.push(t => { canopy.rotation.z = Math.sin(t * .6) * .02; });
    } else if (l.shape === 'tower') {
      const roof = new THREE.Mesh(keep(new THREE.ConeGeometry(.66, .9, 32).rotateX(Math.PI / 2)), material('paint#ffffff', () => new THREE.MeshStandardMaterial({ color: '#fdf7ea', roughness: .55 })));
      roof.position.z = 2.2 + .45; roof.castShadow = true; g.add(roof);
      const band = new THREE.Mesh(keep(new THREE.CylinderGeometry(.53, .53, .1, 32).rotateX(Math.PI / 2)), white); band.position.z = 1.55; g.add(band);
      const win = material('paint#28407a', () => new THREE.MeshStandardMaterial({ color: '#28407a', roughness: .3, emissive: '#1a2a55' }));
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2, w = new THREE.Mesh(keep(new RoundedBoxGeometry(.06, .16, .26, 2, .02)), win);
        w.position.set(Math.cos(a) * .5, Math.sin(a) * .5, 1.85); w.rotation.z = a; g.add(w);
      }
      const flagPole = new THREE.Mesh(keep(new THREE.CylinderGeometry(.015, .015, .6, 8).rotateX(Math.PI / 2)), white); flagPole.position.z = 3.35; g.add(flagPole);
      const pennant = new THREE.Mesh(keep(new THREE.PlaneGeometry(.34, .2).rotateX(Math.PI / 2).translate(.17, 0, 0)), material('flag#ffd23f', () => new THREE.MeshStandardMaterial({ color: '#ffd23f', side: THREE.DoubleSide, roughness: .7 })));
      pennant.position.z = 3.52; g.add(pennant); animated.push(t => { pennant.rotation.z = Math.sin(t * 2.3) * .35 + .4; });
    } else if (l.shape === 'windmill') {
      const cap = new THREE.Mesh(keep(new THREE.ConeGeometry(.55, .55, 24).rotateX(Math.PI / 2)), white); cap.position.z = 1.9 + .27; g.add(cap);
      const hub = new THREE.Group(); hub.position.set(.5, 0, 1.6); g.add(hub);
      const sail = material('paint#fff4dd', () => new THREE.MeshStandardMaterial({ color: '#fff4dd', roughness: .7 }));
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(keep(new RoundedBoxGeometry(.04, .2, 1.05, 2, .015).translate(0, 0, .62)), sail);
        blade.rotation.x = i * Math.PI / 2; blade.castShadow = true; hub.add(blade);
      }
      const knob = new THREE.Mesh(keep(new THREE.SphereGeometry(.09, 16, 12)), gloss); hub.add(knob);
      animated.push((t, dt) => { hub.rotation.x += dt * 1.1; });
      const door = new THREE.Mesh(keep(new RoundedBoxGeometry(.06, .3, .5, 2, .03)), material('wood#8a5a3b', () => new THREE.MeshStandardMaterial({ color: '#8a5a3b', roughness: .8 })));
      door.position.set(.45, 0, .25); g.add(door);
    } else if (l.shape === 'crystal') {
      const gem = material(`crystal${l.color}`, () => new THREE.MeshPhysicalMaterial({ color: l.color, roughness: .1, clearcoat: 1, emissive: new THREE.Color(l.color).multiplyScalar(.4), flatShading: true }));
      const main = new THREE.Mesh(keep(new THREE.OctahedronGeometry(.62, 0).scale(.62, .62, 1.25)), gem);
      main.position.z = 1.05; main.castShadow = true; g.add(main);
      for (const [x, y, s] of [[.42, .2, .42], [-.38, -.26, .36], [.05, -.45, .3]]) {
        const shard = new THREE.Mesh(keep(new THREE.OctahedronGeometry(.3, 0).scale(.6, .6, 1.3)), gem);
        shard.position.set(x, y, .3 + s * .3); shard.rotation.set(x, y, s); shard.scale.setScalar(s / .3 * .5); g.add(shard);
      }
      animated.push(t => { main.rotation.z = t * .25; main.position.z = 1.05 + Math.sin(t * 1.4) * .03; });
    } else if (l.shape === 'arch') {
      const key = new THREE.Mesh(keep(new RoundedBoxGeometry(.4, .4, .3, 2, .05)), white); key.position.z = 1.75; g.add(key);
    } else if (l.shape === 'ball') {
      const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(.56, .025, 8, 48)), white); ring.position.z = .81; ring.rotation.x = Math.PI / 2; g.add(ring);
    }
  }

  // --------------------------------------------------------- court extras
  {
    const c = layout.court, netMat = keep(new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: .55 }));
    const pts = [], u1 = c.u1, gd = c.goalDepth, gw = c.goalHalfWidth, top = 1.0;
    for (let i = 0; i <= 10; i++) { const v = -gw + 2 * gw * i / 10; pts.push(u1 + gd, v, 0, u1 + gd, v, top, u1, v, top, u1 + gd, v, top); }
    for (let z = .1; z <= top; z += .15) pts.push(u1 + gd, -gw, z, u1 + gd, gw, z);
    for (let u = u1; u <= u1 + gd + 1e-6; u += gd / 4) pts.push(u, -gw, top, u, gw, top);
    for (const side of [-1, 1]) for (let z = .1; z <= top; z += .15) pts.push(u1, side * gw, z, u1 + gd, side * gw, z);
    const net = new THREE.LineSegments(keep(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))), netMat);
    world.add(net);
  }

  // ----------------------------------------------------- summit flag (wavy)
  let flagGeo = null, flagBase = null;
  {
    const s = layout.summit, pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(.02, .02, 1.1, 10).rotateX(Math.PI / 2)), material('metal#ffffff', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .3, metalness: .3 })));
    pole.position.set(s.x, s.y, s.z + .55); pole.castShadow = true; world.add(pole);
    flagGeo = keep(new THREE.PlaneGeometry(.55, .34, 12, 6).rotateX(Math.PI / 2).translate(.275, 0, 0));
    flagBase = Float32Array.from(flagGeo.attributes.position.array);
    const flag = new THREE.Mesh(flagGeo, material('flag#ff6b5b', () => new THREE.MeshStandardMaterial({ color: '#ff6b5b', side: THREE.DoubleSide, roughness: .7 })));
    flag.position.set(s.x, s.y, s.z + .92); flag.castShadow = true; world.add(flag);
    const ring = new THREE.Mesh(keep(new THREE.RingGeometry(s.radius - .05, s.radius, 48)), keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .75 })));
    ring.position.set(s.x, s.y, s.z + .004); world.add(ring);
  }

  // ------------------------------------------------------------------ props
  const propViews = [];
  {
    const ballTex = keep(TX.beachBallTexture()), crateTex = keep(TX.crateTexture());
    for (const p of props) {
      let mesh;
      if (p.kind === 'ball') mesh = new THREE.Mesh(keep(new THREE.SphereGeometry(p.size[0], 40, 26).rotateX(Math.PI / 2)), keep(new THREE.MeshPhysicalMaterial({ map: ballTex, roughness: .35, clearcoat: .7 })));
      else if (p.kind === 'domino') {
        const tex = keep(TX.dominoTexture(p.color)), side = keep(new THREE.MeshStandardMaterial({ color: p.color, roughness: .5 })), face = keep(new THREE.MeshStandardMaterial({ map: tex, roughness: .45 }));
        mesh = new THREE.Mesh(keep(new RoundedBoxGeometry(p.size[0] * 2, p.size[1] * 2, p.size[2] * 2, 2, .012)), [face, face, side, side, side, side]);
        // Pips face along the domino's thin axis (local x), readable from the path.
        const uv = mesh.geometry.attributes.uv, n = mesh.geometry.attributes.normal, pos = mesh.geometry.attributes.position;
        for (let i = 0; i < uv.count; i++) if (Math.abs(n.getX(i)) > .5) uv.setXY(i, (pos.getY(i) / (p.size[1] * 2)) + .5, (pos.getZ(i) / (p.size[2] * 2)) + .5);
      } else if (p.kind === 'crate') mesh = new THREE.Mesh(keep(new RoundedBoxGeometry(p.size[0] * 2, p.size[1] * 2, p.size[2] * 2, 2, .015)), material('crate', () => new THREE.MeshStandardMaterial({ map: crateTex, roughness: .78 })));
      else if (p.kind === 'cone') {
        mesh = new THREE.Group();
        const orange = material(`cone${p.color}`, () => new THREE.MeshStandardMaterial({ color: p.color, roughness: .5 }));
        const cone = new THREE.Mesh(keep(new THREE.ConeGeometry(p.size[0], p.size[1] * 2 - .02, 24).rotateX(Math.PI / 2).translate(0, 0, .01)), orange);
        const stripe = new THREE.Mesh(keep(new THREE.CylinderGeometry(p.size[0] * .52, p.size[0] * .66, .05, 24).rotateX(Math.PI / 2)), material('paint#ffffff', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .5 })));
        stripe.position.z = .01;
        const base = new THREE.Mesh(keep(new RoundedBoxGeometry(p.size[0] * 2.1, p.size[0] * 2.1, .025, 2, .008).translate(0, 0, -p.size[1] + .0125)), orange);
        for (const part of [cone, stripe, base]) { part.castShadow = true; mesh.add(part); }
      } else mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(.2, .2, .2)), keep(new THREE.MeshStandardMaterial({ color: p.color })));
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = p.name;
      world.add(mesh); propViews.push({ mesh, spec: p, bodyId: null });
    }
  }

  // ----------------------------------------------------------------- sparks
  const sparkScale = .8 + .5 * Math.min(1.6, height);
  const sparkGeo = keep(new THREE.OctahedronGeometry(.075 * sparkScale, 0).scale(1, 1, 1.35));
  const sparkMat = keep(new THREE.MeshStandardMaterial({ color: '#ffd54a', emissive: '#ffae00', emissiveIntensity: 1.35, roughness: .25, metalness: .1 }));
  const sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, layout.sparks.length);
  sparkMesh.frustumCulled = false; world.add(sparkMesh);
  const glowTex = keep(TX.glowTexture());
  const glowGeo = keep(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(layout.sparks.length * 3), 3)));
  const glow = new THREE.Points(glowGeo, keep(new THREE.PointsMaterial({ map: glowTex, color: '#ffcf5a', size: .62 * sparkScale, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  glow.frustumCulled = false; world.add(glow);
  let sparkState = layout.sparks.map(s => ({ ...s, z: terrain.groundHeight(s.x, s.y) + .3, collected: false }));
  const dummy = new THREE.Object3D();

  // ------------------------------------------------------------------ hoops
  const hoopTex = keep(TX.stripeTexture('#ff7eb6', '#ffe066', 14));
  const hoopMatOn = keep(new THREE.MeshStandardMaterial({ map: hoopTex, roughness: .35, emissive: '#ff6fa8', emissiveIntensity: .25 }));
  const hoopMatOff = keep(new THREE.MeshStandardMaterial({ color: '#d9d2df', roughness: .6, transparent: true, opacity: .45 }));
  const hoopGeo = keep(new THREE.TorusGeometry(1, .05, 12, 64));
  const hoops = layout.hoops.map(h => {
    const mesh = new THREE.Mesh(hoopGeo, hoopMatOff); mesh.castShadow = true;
    const holder = new THREE.Group(); holder.position.set(h.x, h.y, terrain.groundHeight(h.x, h.y)); holder.rotation.z = h.yaw; world.add(holder);
    mesh.rotation.y = Math.PI / 2; holder.add(mesh);
    const posts = [-1, 1].map(side => { const p = new THREE.Mesh(keep(new THREE.CylinderGeometry(.018, .018, 1, 8).rotateX(Math.PI / 2)), material('paint#fffaf0', () => new THREE.MeshStandardMaterial({ color: '#fffaf0', roughness: .6 }))); holder.add(p); return { p, side }; });
    const pad = new THREE.Mesh(keep(new THREE.CircleGeometry(.35, 32)), keep(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .4 })));
    pad.position.set(-.9, 0, .003); holder.add(pad);
    return { mesh, holder, posts, pad };
  });
  function setHoops({ radius, bottom, enabled }) {
    for (const h of hoops) {
      h.mesh.scale.set(radius, radius, radius * .9); h.mesh.position.z = bottom + radius;
      h.mesh.material = enabled ? hoopMatOn : hoopMatOff;
      for (const { p, side } of h.posts) { p.position.set(0, side * radius, (bottom + radius) / 2); p.scale.z = bottom + radius; }
      h.pad.material.opacity = enabled ? .55 : .18;
    }
  }
  setHoops({ radius: .5, bottom: .3, enabled: false });

  // ------------------------------------------------------------------ signs
  const signViews = [];
  const postMat = material('wood#9c6430', () => new THREE.MeshStandardMaterial({ color: '#9c6430', roughness: .85 }));
  const faceToX = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  for (const s of layout.signs) {
    const z = layout.zones.find(q => q.id === s.zone);
    // Posts stand behind the board so they never cover the lettering.
    const g = new THREE.Group(); g.position.set(s.x, s.y, 0); g.rotation.z = s.yaw; world.add(g);
    for (const side of [-.27, .27]) { const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(.025, .03, .9, 10).rotateX(Math.PI / 2)), postMat); post.position.set(-.07, side, .45); post.castShadow = true; g.add(post); }
    const back = new THREE.Mesh(keep(new RoundedBoxGeometry(.04, .76, .46, 2, .018)), postMat); back.position.set(-.025, 0, .72); back.castShadow = true; g.add(back);
    const face = new THREE.Mesh(keep(new THREE.PlaneGeometry(.72, .42).applyMatrix4(faceToX)), new THREE.MeshStandardMaterial({ roughness: .8 }));
    face.position.set(.0, 0, .72); g.add(face);
    signViews.push({ zone: z, face, texture: null });
  }
  function setSignChips(chips = {}) {
    for (const v of signViews) {
      v.texture?.dispose();
      v.texture = TX.signTexture({ name: v.zone.name, blurb: v.zone.blurb, accent: v.zone.accent, chip: chips[v.zone.id] ?? null });
      v.face.material.map = v.texture; v.face.material.needsUpdate = true;
    }
  }
  setSignChips({});
  // Welcome board near the plaza.
  {
    const a = 195 * Math.PI / 180, g = new THREE.Group(); g.position.set(2.6 * Math.cos(a), 2.6 * Math.sin(a), 0); g.rotation.z = a + Math.PI; world.add(g);
    const tex = keep(TX.welcomeTexture('Creature Park', 'drive · explore · play'));
    for (const side of [-.55, .55]) { const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(.035, .04, 1.25, 10).rotateX(Math.PI / 2)), postMat); post.position.set(0, side, .62); post.castShadow = true; g.add(post); }
    const face = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.25, .43).applyMatrix4(faceToX)), keep(new THREE.MeshStandardMaterial({ map: tex, roughness: .7, transparent: true })));
    face.position.set(.02, 0, 1.08); g.add(face);
    const back = new THREE.Mesh(keep(new RoundedBoxGeometry(.04, 1.3, .48, 2, .1)), postMat); back.position.set(-.01, 0, 1.08); g.add(back);
  }

  // ------------------------------------------------------------- decoration
  function instanced(geometry, mat, list, place, { shadow = false, colors = null } = {}) {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(keep(geometry), mat, list.length);
    const color = new THREE.Color();
    list.forEach((p, i) => { place(dummy, p, i); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); if (colors) mesh.setColorAt(i, color.set(colors[Math.floor(p.t * colors.length) % colors.length])); });
    mesh.castShadow = shadow; mesh.receiveShadow = true; world.add(mesh);
    return mesh;
  }
  const flat = c => material(`flat${c}`, () => new THREE.MeshStandardMaterial({ color: c, roughness: .9, flatShading: true }));
  const flatWhite = material('flatwhite', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .88, flatShading: true }));
  const ground = (x, y) => terrain.groundHeight(x, y);
  // Trees: trunk + three-puff canopy, canopy tinted per instance.
  instanced(new THREE.CylinderGeometry(.07, .11, 1, 7).rotateX(Math.PI / 2).translate(0, 0, .5), flat('#8a5a3b'), decor.trees,
    (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.rotation.set(0, 0, p.rot); d.scale.set(p.s, p.s, p.s); }, { shadow: true });
  {
    const puffs = [[0, 0, 0, .55], [.3, .1, -.12, .38], [-.28, -.12, -.08, .4], [0, .05, .3, .36]].map(([x, y, z, r]) => new THREE.IcosahedronGeometry(r, 1).translate(x, y, z));
    const canopy = mergeGeometries(puffs.map(nonIndexed), false); puffs.forEach(g => g.dispose());
    instanced(canopy.translate(0, 0, 1.25), flatWhite, decor.trees, (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.rotation.set(0, 0, p.rot); d.scale.set(p.s, p.s, p.s * (.9 + p.t * .3)); },
      { shadow: true, colors: ['#5fb04f', '#6cbd57', '#4f9f49', '#7cc45f', '#8dc950', '#5aa84f', '#e8a33b', '#6cbd57', '#58ab4c', '#f0c24f'] });
  }
  instanced(mergeGeometries([new THREE.ConeGeometry(.42, .9, 8).rotateX(Math.PI / 2).translate(0, 0, .75), new THREE.ConeGeometry(.32, .7, 8).rotateX(Math.PI / 2).translate(0, 0, 1.25)].map(nonIndexed), false),
    flatWhite, decor.pines, (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.rotation.set(0, 0, p.rot); d.scale.set(p.s, p.s, p.s * 1.1); }, { shadow: true, colors: ['#3f8f55', '#4a9a5c', '#367f4b'] });
  instanced(new THREE.CylinderGeometry(.05, .06, .3, 6).rotateX(Math.PI / 2).translate(0, 0, .15), flat('#7a4f33'), decor.pines,
    (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.scale.setScalar(p.s); });
  instanced(new THREE.IcosahedronGeometry(.32, 1).scale(1, 1, .72).translate(0, 0, .16), flatWhite, decor.bushes,
    (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.rotation.set(0, 0, p.rot); d.scale.setScalar(p.s * .9); }, { shadow: true, colors: ['#6db758', '#5ea94f', '#7cc161', '#8fca62', '#5a9e57'] });
  instanced(new THREE.DodecahedronGeometry(.16, 0).scale(1.2, 1, .7), flatWhite, decor.rocks,
    (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y) + .03); d.rotation.set(p.t, p.rot, p.rot * .5); d.scale.setScalar(p.s); }, { colors: ['#c9c2b4', '#b8b0a2', '#d6cfc0'] });
  instanced(new THREE.DodecahedronGeometry(.3, 0).scale(1.3, 1, .8), flatWhite, decor.shore,
    (d, p) => { d.position.set(p.x, p.y, -.12 + p.t * .1); d.rotation.set(p.t * 3, p.rot, p.rot * .3); d.scale.setScalar(p.s); }, { shadow: false, colors: ['#bdb4a3', '#a99f8e', '#cfc6b4', '#b3aa98'] });
  // Flowers: stems + heads; grass tufts.
  instanced(new THREE.CylinderGeometry(.006, .006, .12, 4).rotateX(Math.PI / 2).translate(0, 0, .06), flat('#4f9a3e'), decor.flowers,
    (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.rotation.set(0, 0, 0); d.scale.setScalar(p.s); });
  instanced(new THREE.IcosahedronGeometry(.032, 0).translate(0, 0, .125), flatWhite, decor.flowers,
    (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.scale.setScalar(p.s); }, { colors: ['#ffffff', '#ffe36e', '#ff9ec4', '#c9a8ff', '#ff8a6b', '#ffffff', '#fff3a6'] });
  {
    const blades = [];
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2, lean = .025, h = .09 + (i % 3) * .025;
      blades.push(-.012 * Math.cos(a + 1.57), -.012 * Math.sin(a + 1.57), 0, .012 * Math.cos(a + 1.57), .012 * Math.sin(a + 1.57), 0, Math.cos(a) * lean, Math.sin(a) * lean, h);
    }
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(blades, 3)); g.computeVertexNormals();
    const tuftMat = material('tuft', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .9, side: THREE.DoubleSide }));
    instanced(g, tuftMat, decor.tufts, (d, p) => { d.position.set(p.x, p.y, ground(p.x, p.y)); d.rotation.set(0, 0, p.rot); d.scale.setScalar(p.s * 1.2); }, { colors: ['#6fae4f', '#7fbd58', '#8ccb63', '#5f9f45'] });
  }
  // Clouds drift slowly around the island.
  const cloudGroup = new THREE.Group(); world.add(cloudGroup);
  {
    const puffs = [[0, 0, 0, 1], [1.1, .2, -.2, .75], [-1.0, -.1, -.25, .8], [.4, -.3, .35, .7], [-.45, .35, .3, .6]].map(([x, y, z, r]) => nonIndexed(new THREE.IcosahedronGeometry(r, 2).translate(x, y, z)));
    const cloudGeo = mergeGeometries(puffs, false); puffs.forEach(g => g.dispose());
    const cloudMat = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6ea', emissiveIntensity: .45, roughness: 1, transparent: true, opacity: .96 }));
    const mesh = instanced(cloudGeo, cloudMat, decor.clouds, (d, p) => { d.position.set(p.x, p.y, p.z); d.rotation.set(0, 0, p.rot); d.scale.set(p.s * 1.3, p.s, p.s * .55); });
    if (mesh) { world.remove(mesh); cloudGroup.add(mesh); mesh.receiveShadow = false; }
  }

  // ------------------------------------------------------------- per frame
  const focus = new THREE.Vector3(), texel = new THREE.Vector3();
  let time = 0;
  function update(dt, camera, focusThree) {
    time += dt;
    waterMat.uniforms.uTime.value = time;
    sky.position.copy(camera.position);
    if (focusThree) {
      // Shadow frustum follows the creature, snapped to texels (no shimmer).
      const unit = 2 * shadowHalf / sun.shadow.mapSize.x;
      focus.set(Math.round(focusThree.x / unit) * unit, Math.round(focusThree.y / unit) * unit, Math.round(focusThree.z / unit) * unit);
      sun.target.position.copy(focus); sun.position.copy(texel.copy(SUN_DIR).multiplyScalar(22).add(focus));
      sun.target.updateMatrixWorld();
    }
    for (const fn of animated) fn(time, dt);
    cloudGroup.rotation.z = time * .004;
    if (flagGeo) {
      const pos = flagGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = flagBase[i * 3], wave = Math.sin(x * 9 - time * 6) * .045 * (x / .55);
        pos.setY(i, flagBase[i * 3 + 1] + wave);
      }
      pos.needsUpdate = true;
    }
    // Sparks bob and spin; collected ones hide.
    const gp = glowGeo.attributes.position;
    sparkState.forEach((s, i) => {
      const bob = Math.sin(time * 2.2 + i * 1.7) * .035 * sparkScale;
      if (s.collected) { dummy.scale.setScalar(0); gp.setXYZ(i, 0, 0, -50); }
      else { dummy.scale.setScalar(1); gp.setXYZ(i, s.x, s.y, s.z + bob); }
      dummy.position.set(s.x, s.y, s.z + bob); dummy.rotation.set(0, 0, time * 1.6 + i);
      dummy.updateMatrix(); sparkMesh.setMatrixAt(i, dummy.matrix);
    });
    sparkMesh.instanceMatrix.needsUpdate = true; gp.needsUpdate = true;
  }
  function setSparks(list) { if (Array.isArray(list)) sparkState = list.map(s => ({ ...s })); }
  const pq = new THREE.Quaternion();
  function syncProps(mujoco, model, data) {
    const xpos = data.xpos, xquat = data.xquat;
    for (const v of propViews) {
      if (v.bodyId === null) v.bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, v.spec.name);
      const b = v.bodyId;
      if (b < 0) continue;
      v.mesh.position.set(xpos[b * 3], xpos[b * 3 + 1], xpos[b * 3 + 2]);
      v.mesh.quaternion.copy(pq.set(xquat[b * 4 + 1], xquat[b * 4 + 2], xquat[b * 4 + 3], xquat[b * 4]));
    }
  }
  function dispose() {
    for (const v of signViews) { v.texture?.dispose(); v.face.material.dispose(); }
    for (const item of owned) item.dispose?.();
    for (const mat of materials.values()) mat.dispose();
    world.traverse(o => { if (o.isInstancedMesh) o.dispose(); });
    world.removeFromParent(); sky.removeFromParent(); hemi.removeFromParent(); sun.removeFromParent(); sun.target.removeFromParent(); fill.removeFromParent();
    sun.shadow.map?.dispose();
    scene.fog = null; scene.background = null;
  }
  return { group: world, sun, occluders, update, setSparks, setHoops, setSignChips, syncProps, dispose, water, palette: PALETTE };
}
