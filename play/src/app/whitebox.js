import * as THREE from 'three';

// White-box look: everything is matte white "plaster" like an architectural
// topo model or a fresh Unreal Engine 5 blockout level. Terrain reads through
// sun shading (hillshade) and thin contour lines. Only the robot and the
// things it can interact with carry colour. Purely visual: no physics here.

export const HIGHLIGHT = '#cf9273'; // muted terracotta: interactive things
const SKY = { zenith: '#c9d1da', horizon: '#f1f2f3', below: '#e9eaec' };

// Plaster with world-height contour lines (fine every 2 cm, bold every 10 cm
// near the robot; 1 m / 5 m on the far relief) and a faint 1 m floor grid.
export function createTopoMaterial({ base = '#f3f3f1', line = '#b4b6b9', fine = 0.02, bold = 0.1, grid = 0.06, roughness = 0.95 } = {}) {
  const material = new THREE.MeshStandardMaterial({ color: base, roughness, metalness: 0 });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, { uLine: { value: new THREE.Color(line) }, uFine: { value: fine }, uBold: { value: bold }, uGrid: { value: grid } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTopoPos;\nvarying vec3 vTopoN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTopoPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTopoN = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uLine; uniform float uFine, uBold, uGrid;
        varying vec3 vTopoPos; varying vec3 vTopoN;
        float contour(float h, float spacing, float width) {
          float q = h / spacing; float d = fwidth(q);
          float g = abs(fract(q - 0.5) - 0.5) / max(d, 1e-5);
          return (1.0 - clamp(g - width, 0.0, 1.0)) * clamp(1.0 - d * 2.5, 0.0, 1.0);
        }
        float gridLines(vec2 p) { vec2 q = p; vec2 d = fwidth(q); vec2 g = abs(fract(q - 0.5) - 0.5) / max(d, vec2(1e-5));
          return (1.0 - clamp(min(g.x, g.y) - 0.5, 0.0, 1.0)) * clamp(1.0 - max(d.x, d.y) * 3.0, 0.0, 1.0); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float h = vTopoPos.y;
          float lines = max(contour(h, uFine, 0.3) * 0.45, contour(h, uBold, 0.55) * 0.8);
          lines = max(lines, contour(h, 1.0, 0.4) * 0.5);
          lines = max(lines, contour(h, 5.0, 0.7) * 0.75);
          float flatness = smoothstep(0.96, 0.995, abs(normalize(vTopoN).y));
          lines *= 1.0 - flatness * step(abs(h), 0.004);   // the flat floor stays clean
          float g = gridLines(vTopoPos.xz) * uGrid * flatness;
          diffuseColor.rgb = mix(diffuseColor.rgb, uLine, clamp(max(lines, g), 0.0, 1.0));
        }`);
  };
  material.customProgramCacheKey = () => `topo-${base}-${line}-${fine}-${bold}-${grid}`;
  return material;
}

function skyMesh() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uZenith: { value: new THREE.Color(SKY.zenith) }, uHorizon: { value: new THREE.Color(SKY.horizon) }, uBelow: { value: new THREE.Color(SKY.below) } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; gl_Position.z *= 0.9999; }',
    fragmentShader: `uniform vec3 uZenith, uHorizon, uBelow; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.75));
        col = mix(col, uBelow, smoothstep(0.0, -0.2, h));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(480, 32, 16), material);
  mesh.frustumCulled = false; mesh.renderOrder = -10; mesh.name = 'whitebox_sky';
  return mesh;
}

// Seeded value-noise fBm for the far relief.
function noise2(seed = 11) {
  const perm = new Uint8Array(512); let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const p = Array.from({ length: 256 }, (_, i) => i).sort(() => rand() - 0.5);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = (x, y) => perm[(perm[x & 255] + y) & 255] / 255;
  const smooth = t => t * t * (3 - 2 * t);
  const n = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
    const a = val(xi, yi), b = val(xi + 1, yi), c = val(xi, yi + 1), d = val(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf; };
  return (x, y) => { let sum = 0, amp = 1, f = 1, norm = 0; for (let o = 0; o < 5; o++) { sum += amp * n(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.03; } return sum / norm; };
}

// A white relief landscape around the play area: flat near the middle,
// rising into ridged massifs toward the horizon (reads like a hillshade).
export function createRelief({ inner = 16, outer = 70, size = 520, segments = 260, base = -0.3, height = 34, seed = 11 } = {}) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2);
  const fbm = noise2(seed), pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z);
    const ramp = THREE.MathUtils.smoothstep(r, inner, outer);
    const ridge = 1 - Math.abs(fbm(x * 0.012 + 3, z * 0.012 - 7) * 2 - 1);
    const h = (0.55 * fbm(x * 0.02, z * 0.02) + 0.45 * ridge * ridge) * height * ramp * ramp;
    pos.setY(i, base + h - (r < inner ? 0.02 : 0));
  }
  geometry.computeVertexNormals();
  const material = createTopoMaterial({ fine: 0.25, bold: 1.0, grid: 0, base: '#f1f1ef', line: '#bfc1c4' });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true; mesh.name = 'whitebox_relief';
  return { mesh, dispose() { geometry.dispose(); material.dispose(); } };
}

// Workshop: a white plinth on an endless plaster floor, distant relief, soft sun.
export function createWhiteboxStudio({ scene, renderer }) {
  const objects = [];
  const add = o => { scene.add(o); objects.push(o); return o; };
  scene.background = new THREE.Color(SKY.horizon);
  scene.fog = new THREE.Fog(SKY.horizon, 18, 110);
  if (renderer) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0; }
  add(skyMesh());
  add(new THREE.HemisphereLight('#ffffff', '#c9ccd1', 1.7));
  const sun = add(new THREE.DirectionalLight('#ffffff', 2.4));
  sun.position.set(-3, 7, 4); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
  sun.shadow.normalBias = 0.02; sun.shadow.bias = -0.0002; sun.shadow.radius = 5;
  add(new THREE.DirectionalLight('#e6ecf3', 0.5)).position.set(4, 3, -3);
  const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(60, 60), createTopoMaterial({ grid: 0.05 })));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  const relief = createRelief({ inner: 12, outer: 55, size: 360, segments: 200, base: -0.02, height: 22 });
  add(relief.mesh);
  return {
    update() {},
    setMode(mode) { scene.background = new THREE.Color(mode === 'blueprint' ? '#1d222b' : SKY.horizon); },
    dispose() {
      relief.dispose();
      for (const o of objects) { scene.remove(o); if (o !== relief.mesh) { o.geometry?.dispose(); o.material?.dispose?.(); } }
      scene.fog = null;
    },
  };
}

const isProp = object => { for (let o = object; o; o = o.parent) if (typeof o.name === 'string' && o.name.startsWith('prop')) return true; return false; };

// Playground: the authored park becomes a plaster model. Static geometry gets
// the topo material, decals and signage disappear, interactive props take the
// highlight colour, the sea becomes a white relief rising to the horizon.
export function applyWhiteboxWorld({ scene, view }) {
  const plaster = createTopoMaterial();
  const highlight = new THREE.MeshStandardMaterial({ color: HIGHLIGHT, roughness: 0.42, metalness: 0.05 });
  const replaced = [], hidden = [];
  const world = view?.group;
  if (!world) return { dispose() {} };
  world.traverse(object => {
    if (!object.isMesh) return;
    if (object.name === 'whitebox_relief') return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const first = materials[0];
    if (!first) return;
    const emissive = !!first.emissive && first.emissiveIntensity > 0 && first.emissive.getHex() !== 0;
    if (isProp(object)) { replaced.push([object, object.material]); object.material = highlight; return; }
    if (first.userData?.whitebox) return;                        // muted obstacles keep their tint
    if (emissive) return;                                         // collectibles and hoops keep their glow
    // Signage, banners, decks with lettering and painted strips: a blockout
    // level has none. Hidden meshes keep their own materials (signs update them).
    if (first.map && (object.geometry?.type === 'PlaneGeometry' || first.transparent)) { hidden.push(object); object.visible = false; return; }
    if (first.transparent && first.opacity < 0.95) return;
    if (object.isInstancedMesh && object.instanceColor) object.instanceColor = null;
    replaced.push([object, object.material]);
    object.material = plaster;
  });
  if (view.water) { hidden.push(view.water); view.water.visible = false; }
  const relief = createRelief();
  scene.add(relief.mesh);
  const sky = skyMesh(); scene.add(sky);
  scene.background = new THREE.Color(SKY.horizon);
  if (scene.fog) { scene.fog.color = new THREE.Color(SKY.horizon); scene.fog.near = 45; scene.fog.far = 260; }
  scene.traverse(object => {
    if (object.isHemisphereLight) { object.color.set('#ffffff'); object.groundColor.set('#c9ccd1'); object.intensity = 1.55; }
    if (object.isDirectionalLight) object.color.set('#ffffff');
    if (object.isMesh && object.material?.isShaderMaterial && object.geometry?.type === 'SphereGeometry' && object !== sky) object.visible = false;
  });
  return {
    dispose() {
      for (const [object, material] of replaced) object.material = material;
      for (const object of hidden) object.visible = true;
      scene.remove(relief.mesh); relief.dispose();
      scene.remove(sky); sky.geometry.dispose(); sky.material.dispose();
      plaster.dispose(); highlight.dispose();
    },
  };
}
