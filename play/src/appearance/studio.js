import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

// The workshop backdrop: "toybox workshop meets blueprint".
//  - an infinity cove (floor sweeping up into a wall, so any orbit angle
//    looks seamless) with a warm gradient, or blueprint paper with a grid;
//  - a printer-bed turntable: textured build plate, coral rim, clips;
//  - three-point lighting plus a soft room environment for reflections;
//  - contact shadows rendered from below the bed (soft, grounded feet).
// Scene is Y-up (three.js); the bed top sits at y = 0 (MuJoCo z = 0).

const MOODS = {
  normal: { floor: '#efe4d2', wall: '#f7efe3', top: '#fbf6ee', spot: 0.22, grid: 0.0, gridColor: '#d9c7ad', bed: '#e2dbcd', bedLine: '#c9bfae', bedMajor: '#b9ad99', rim: '#ff8a5c', base: '#4a4440', fog: '#f4ebdd' },
  blueprint: { floor: '#1d4f8f', wall: '#1d4f8f', top: '#225aa0', spot: 0.12, grid: 1.0, gridColor: '#5f8fd0', bed: '#1a477f', bedLine: '#4d7fc2', bedMajor: '#8db4e8', rim: '#cfe3ff', base: '#123660', fog: '#1d4f8f' },
  xray: { floor: '#0c1a2b', wall: '#0e1f33', top: '#13283f', spot: 0.18, grid: 0.55, gridColor: '#1f3d5e', bed: '#10233a', bedLine: '#1f4266', bedMajor: '#2f5f8f', rim: '#5fd0ff', base: '#0a1522', fog: '#0c1a2b' },
};

function coveGeometry(R0, Rc, H, segments = 96) {
  const pts = [new THREE.Vector2(0.001, 0), new THREE.Vector2(R0, 0)];
  for (let i = 1; i <= 12; i++) { const a = (i / 12) * (Math.PI / 2); pts.push(new THREE.Vector2(R0 + Math.sin(a) * Rc, Rc - Math.cos(a) * Rc)); }
  pts.push(new THREE.Vector2(R0 + Rc, H));
  return new THREE.LatheGeometry(pts, segments);
}

function coveMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide, depthWrite: true, fog: false,
    uniforms: {
      uFloor: { value: new THREE.Color() }, uWall: { value: new THREE.Color() }, uTop: { value: new THREE.Color() },
      uSpot: { value: 0.2 }, uGrid: { value: 0 }, uGridColor: { value: new THREE.Color() }, uHeight: { value: 6 },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4( position, 1.0 ); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uFloor, uWall, uTop, uGridColor; uniform float uSpot, uGrid, uHeight;
      varying vec3 vW;
      float gridLine( float v, float s ) { float f = abs( fract( v / s - 0.5 ) - 0.5 ) * s; return 1.0 - smoothstep( 0.0, fwidth( v ) * 1.2, f ); }
      void main() {
        float h = clamp( vW.y / uHeight, 0.0, 1.0 );
        vec3 c = mix( uFloor, uWall, smoothstep( 0.0, 0.25, h ) );
        c = mix( c, uTop, smoothstep( 0.25, 1.0, h ) );
        float r = length( vW.xz );
        c += uSpot * exp( - r * r / 9.0 ) * vec3( 1.0, 0.97, 0.92 ) * ( 1.0 - h );
        float g = max( max( gridLine( vW.x, 0.5 ), gridLine( vW.z, 0.5 ) ), gridLine( vW.y, 0.5 ) * step( 0.02, vW.y ) );
        float g2 = max( gridLine( vW.x, 0.1 ), gridLine( vW.z, 0.1 ) ) * 0.35 * ( 1.0 - step( 0.02, vW.y ) );
        c = mix( c, uGridColor, uGrid * max( g, g2 ) * ( 1.0 - smoothstep( 6.0, 14.0, r ) ) );
        gl_FragColor = vec4( c, 1.0 );
        #include <colorspace_fragment>
      }`,
  });
}

// Build plate: lit (shadows land on it), with a procedural grid in its own
// plane so lines stay crisp at any zoom and cost no texture memory.
function bedMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: '#e2dbcd', roughness: 0.82, metalness: 0.0 });
  material.userData.bed = { uLine: { value: new THREE.Color() }, uMajor: { value: new THREE.Color() }, uRadius: { value: 1 } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, material.userData.bed);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBed = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vBed; uniform vec3 uLine; uniform vec3 uMajor; uniform float uRadius;
        float bedLine( vec2 p, float s, float w ) { vec2 f = abs( fract( p / s - 0.5 ) - 0.5 ) * s; vec2 aa = fwidth( p ) * 1.2; vec2 l = 1.0 - smoothstep( vec2( w ), vec2( w ) + aa, f ); return max( l.x, l.y ); }
        float bedHash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float minor = bedLine( vBed, 0.02, 0.0004 ), major = bedLine( vBed, 0.1, 0.0009 );
          float r = length( vBed );
          float ring = 1.0 - smoothstep( 0.0015, 0.0015 + fwidth( r ) * 1.5, abs( r - uRadius * 0.93 ) );
          float cross = ( 1.0 - smoothstep( 0.001, 0.001 + fwidth( vBed.x ), abs( vBed.x ) ) ) * step( abs( vBed.y ), 0.035 )
                      + ( 1.0 - smoothstep( 0.001, 0.001 + fwidth( vBed.y ), abs( vBed.y ) ) ) * step( abs( vBed.x ), 0.035 );
          float fade = 1.0 - smoothstep( uRadius * 0.86, uRadius * 0.92, r );
          diffuseColor.rgb = mix( diffuseColor.rgb, uLine, minor * 0.55 * fade );
          diffuseColor.rgb = mix( diffuseColor.rgb, uMajor, max( major * fade, max( ring, min( cross, 1.0 ) ) ) * 0.8 );
          // PEI-like speckle: a whisper of texture in the plate.
          diffuseColor.rgb *= 0.985 + 0.03 * bedHash( floor( vBed * 900.0 ) );
        }`);
  };
  return material;
}

export function createStudio({ scene, renderer, radius = 1.1, contactShadows = true, quality = 'high', environment = true } = {}) {
  if (!scene) throw Error('createStudio needs a scene');
  const group = new THREE.Group(); group.name = 'studio';
  scene.add(group);
  const disposables = [];
  const own = x => { disposables.push(x); return x; };
  const previous = { background: scene.background, environment: scene.environment, fog: scene.fog, environmentIntensity: scene.environmentIntensity };

  // Cove.
  const cove = new THREE.Mesh(own(coveGeometry(6, 3.5, 9)), own(coveMaterial()));
  cove.position.y = -0.065; cove.renderOrder = -1; group.add(cove);

  // Turntable + build plate.
  const turntable = new THREE.Group(); turntable.name = 'turntable'; group.add(turntable);
  const bedMat = own(bedMaterial()); bedMat.userData.bed.uRadius.value = radius;
  const bed = new THREE.Mesh(own(new THREE.CylinderGeometry(radius, radius, 0.022, 128, 1)), bedMat);
  bed.position.y = -0.011; bed.receiveShadow = true; turntable.add(bed);
  const rimMat = own(new THREE.MeshStandardMaterial({ color: '#ff8a5c', roughness: 0.45, metalness: 0.05 }));
  const rim = new THREE.Mesh(own(new THREE.TorusGeometry(radius + 0.004, 0.009, 12, 160).rotateX(Math.PI / 2)), rimMat);
  rim.position.y = -0.004; rim.receiveShadow = true; turntable.add(rim);
  const baseMat = own(new THREE.MeshStandardMaterial({ color: '#4a4440', roughness: 0.55, metalness: 0.2 }));
  const base = new THREE.Mesh(own(new THREE.CylinderGeometry(radius * 1.04, radius * 1.08, 0.04, 128)), baseMat);
  base.position.y = -0.042; base.receiveShadow = true; turntable.add(base);
  const clipMat = own(new THREE.MeshStandardMaterial({ color: '#c8ccd2', roughness: 0.35, metalness: 0.8 }));
  const clipGeo = own(new THREE.BoxGeometry(0.07, 0.012, 0.035));
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, clip = new THREE.Mesh(clipGeo, clipMat);
    clip.position.set(Math.cos(a) * (radius - 0.015), 0.001, Math.sin(a) * (radius - 0.015));
    clip.rotation.y = -a; clip.castShadow = true; turntable.add(clip);
  }

  // Lights: warm key with shadows, cool fill, bright rim, soft sky.
  const hemi = new THREE.HemisphereLight('#fff7ec', '#d8c5ab', 0.85);
  const key = new THREE.DirectionalLight('#fff1de', 2.6);
  key.position.set(-2.2, 4.2, 2.8); key.castShadow = true;
  const mapSize = quality === 'low' ? 1024 : 2048;
  key.shadow.mapSize.set(mapSize, mapSize);
  Object.assign(key.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 12 });
  key.shadow.normalBias = 0.02; key.shadow.bias = -0.0002; key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight('#dbe8ff', 0.75); fill.position.set(3, 1.8, 2.4);
  const rimLight = new THREE.DirectionalLight('#ffffff', 2.1); rimLight.position.set(0.6, 3.2, -3.8);
  group.add(hemi, key, key.target, fill, rimLight);
  if (renderer && !renderer.shadowMap.enabled) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }

  // Environment for reflections (metal and gloss finishes need it).
  let envTexture = null;
  if (environment && renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(renderer);
    envTexture = pmrem.fromScene(room, 0.04).texture;
    room.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
    pmrem.dispose();
    scene.environment = envTexture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.55;
  }

  // Contact shadows (three.js "shadow contact" technique).
  let cs = null;
  if (contactShadows && renderer) {
    const size = 2.6, height = 0.55, res = quality === 'low' ? 256 : 512;
    const rt = own(new THREE.WebGLRenderTarget(res, res)), rtBlur = own(new THREE.WebGLRenderTarget(res, res));
    rt.texture.generateMipmaps = false; rtBlur.texture.generateMipmaps = false;
    const planeGeo = own(new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2));
    const planeMat = own(new THREE.MeshBasicMaterial({ map: rt.texture, opacity: 0.85, transparent: true, depthWrite: false, toneMapped: false }));
    const plane = new THREE.Mesh(planeGeo, planeMat); plane.scale.y = -1; plane.position.y = 0.0012; plane.renderOrder = 1;
    const blurPlane = new THREE.Mesh(planeGeo); blurPlane.visible = false;
    const camera = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height); camera.rotation.x = Math.PI / 2;
    const holder = new THREE.Group(); holder.add(plane, blurPlane, camera); group.add(holder);
    const depth = own(new THREE.MeshDepthMaterial());
    depth.userData.darkness = { value: 1.6 };
    depth.onBeforeCompile = shader => {
      shader.uniforms.darkness = depth.userData.darkness;
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );')}`;
    };
    depth.depthTest = false; depth.depthWrite = false;
    const blurMaterial = def => new THREE.ShaderMaterial({ ...def, uniforms: THREE.UniformsUtils.clone(def.uniforms) });
    const hBlur = own(blurMaterial(HorizontalBlurShader)), vBlur = own(blurMaterial(VerticalBlurShader));
    hBlur.depthTest = false; vBlur.depthTest = false;
    cs = { rt, rtBlur, plane, blurPlane, camera, depth, hBlur, vBlur, holder, blur: 2.6, size, strength: 1 };
  }
  function blurShadow(amount) {
    const { rt, rtBlur, blurPlane, camera, hBlur, vBlur } = cs;
    blurPlane.visible = true;
    blurPlane.material = hBlur; hBlur.uniforms.tDiffuse.value = rt.texture; hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(rtBlur); renderer.render(blurPlane, camera);
    blurPlane.material = vBlur; vBlur.uniforms.tDiffuse.value = rtBlur.texture; vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(rt); renderer.render(blurPlane, camera);
    blurPlane.visible = false;
  }
  function renderContactShadow() {
    if (!cs || cs.strength <= 0.001 || mode === 'blueprint') { if (cs) cs.plane.visible = false; return; }
    cs.plane.visible = false;
    const background = scene.background, clearAlpha = renderer.getClearAlpha(), target = renderer.getRenderTarget();
    const studioVisible = [cove.visible, turntable.visible];
    cove.visible = false; turntable.visible = false;
    scene.background = null; scene.overrideMaterial = cs.depth;
    renderer.setClearAlpha(0); renderer.setRenderTarget(cs.rt); renderer.clear();
    renderer.render(scene, cs.camera);
    scene.overrideMaterial = null;
    blurShadow(cs.blur); blurShadow(cs.blur * 0.4);
    renderer.setRenderTarget(target); renderer.setClearAlpha(clearAlpha);
    scene.background = background; [cove.visible, turntable.visible] = studioVisible;
    cs.plane.visible = true;
    cs.plane.material.opacity = 0.85 * cs.strength * (mode === 'xray' ? 0.6 : 1);
  }

  let mode = 'normal', spin = 0;
  function setMode(next) {
    const m = MOODS[next] ?? MOODS.normal;
    mode = MOODS[next] ? next : 'normal';
    const u = cove.material.uniforms;
    u.uFloor.value.set(m.floor); u.uWall.value.set(m.wall); u.uTop.value.set(m.top); u.uSpot.value = m.spot; u.uGrid.value = m.grid; u.uGridColor.value.set(m.gridColor);
    bedMat.color.set(m.bed); bedMat.userData.bed.uLine.value.set(m.bedLine); bedMat.userData.bed.uMajor.value.set(m.bedMajor);
    rimMat.color.set(m.rim); rimMat.emissive.set(mode === 'normal' ? '#000000' : m.rim); rimMat.emissiveIntensity = mode === 'normal' ? 0 : 0.6;
    baseMat.color.set(m.base);
    scene.background = new THREE.Color(m.fog);
    scene.fog = new THREE.Fog(m.fog, 9, 26);
    hemi.intensity = mode === 'normal' ? 0.85 : 1.2;
    key.intensity = mode === 'normal' ? 2.6 : 1.4;
    rimLight.intensity = mode === 'xray' ? 2.6 : 2.1;
    if ('environmentIntensity' in scene) scene.environmentIntensity = mode === 'normal' ? 0.55 : 0.25;
  }
  setMode('normal');

  /** Fit the key light's shadow frustum and the contact shadow to a target box (world). */
  function frame(box) {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(0.4, box.getSize(new THREE.Vector3()).length() * 0.75);
    key.target.position.set(c.x, 0, c.z); key.position.set(c.x - 2.2, 4.2, c.z + 2.8); key.target.updateMatrixWorld();
    Object.assign(key.shadow.camera, { left: -r, right: r, top: r, bottom: -r });
    key.shadow.camera.updateProjectionMatrix();
    if (cs) { cs.holder.position.set(c.x, 0, c.z); const s = Math.max(1.2, r * 2.2) / cs.size; cs.holder.scale.set(s, 1, s); }
  }

  return {
    group, turntable, lights: { hemi, key, fill, rim: rimLight }, bed,
    get mode() { return mode; },
    setMode, frame,
    setSpin(rate = 0) { spin = Number(rate) || 0; },
    setContactShadowStrength(v) { if (cs) cs.strength = Math.max(0, Math.min(1, v)); },
    update(dt = 1 / 60) {
      if (spin) turntable.rotation.y += spin * dt;
      if (renderer) renderContactShadow();
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose?.();
      envTexture?.dispose();
      scene.background = previous.background; scene.environment = previous.environment; scene.fog = previous.fog;
      if ('environmentIntensity' in scene && previous.environmentIntensity !== undefined) scene.environmentIntensity = previous.environmentIntensity;
    },
  };
}
