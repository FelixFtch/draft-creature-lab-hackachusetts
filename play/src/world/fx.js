import * as THREE from 'three';
import { glowTexture } from './textures.js';

// Visual effects in the MuJoCo frame (add `group` under the root): dust puffs
// on foot strikes, spark bursts, confetti on goals, landing/respawn rings and
// water splashes. Fixed-size pools: no allocation per frame or per effect.
const DUST = { grass: '#d9ead0', sand: '#efdcb2', gravel: '#e5dccb', stone: '#efe9dd', court: '#d2efe9', wood: '#ecd5ae', plastic: '#fff1f6', rubber: '#f2e6e0', paint: '#ffffff', metal: '#ffffff', floor: '#e3edd6' };

function particlePool(count, blending, map) {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(count * 3), color = new Float32Array(count * 3), size = new Float32Array(count), alpha = new Float32Array(count);
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uScale: { value: 600 } },
    vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uScale;
      varying vec3 vColor; varying float vAlpha;
      void main(){ vColor = aColor; vAlpha = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.05, -mv.z) : 0.0; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uMap; varying vec3 vColor; varying float vAlpha;
      void main(){ float a = texture2D(uMap, gl_PointCoord).a * vAlpha; if (a < 0.01) discard; gl_FragColor = vec4(vColor, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  const live = Array.from({ length: count }, () => ({ life: 0, max: 1, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, s0: .05, s1: .1, a0: 1 }));
  let cursor = 0;
  const c = new THREE.Color();
  return {
    points, material,
    spawn(x, y, z, o) {
      const i = cursor; cursor = (cursor + 1) % count;
      const p = live[i];
      Object.assign(p, { life: o.life, max: o.life, vx: o.vx, vy: o.vy, vz: o.vz, g: o.g ?? 0, drag: o.drag ?? 1.5, s0: o.s0, s1: o.s1, a0: o.a0 ?? 1 });
      position[i * 3] = x; position[i * 3 + 1] = y; position[i * 3 + 2] = z;
      c.set(o.color); color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b;
      size[i] = o.s0; alpha[i] = p.a0;
    },
    update(dt) {
      let any = false;
      for (let i = 0; i < count; i++) {
        const p = live[i];
        if (p.life <= 0) { if (alpha[i] !== 0) { alpha[i] = 0; any = true; } continue; }
        any = true;
        p.life -= dt;
        const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vy *= k; p.vz = p.vz * k - p.g * dt;
        position[i * 3] += p.vx * dt; position[i * 3 + 1] += p.vy * dt; position[i * 3 + 2] += p.vz * dt;
        const t = 1 - Math.max(0, p.life) / p.max;
        size[i] = p.s0 + (p.s1 - p.s0) * t;
        alpha[i] = p.life > 0 ? p.a0 * (t < .15 ? t / .15 : 1 - (t - .15) / .85) : 0;
      }
      if (any) for (const name of ['position', 'aSize', 'aAlpha', 'aColor']) geometry.attributes[name].needsUpdate = true;
    },
    dispose() { geometry.dispose(); material.dispose(); },
  };
}

export function createFx({ quality = 'high' } = {}) {
  const high = quality !== 'low';
  const group = new THREE.Group(); group.name = 'fx';
  const map = glowTexture();
  const soft = particlePool(high ? 600 : 300, THREE.NormalBlending, map);
  const glow = particlePool(high ? 500 : 250, THREE.AdditiveBlending, map);
  group.add(soft.points, glow.points);

  // Confetti: tiny double-sided quads with spin.
  const confettiCount = high ? 220 : 110;
  const confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(.045, .028), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), confettiCount);
  confetti.frustumCulled = false; group.add(confetti);
  const bits = Array.from({ length: confettiCount }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), angle: 0, spin: 0 }));
  const palette = ['#ff6b5b', '#ffd23f', '#4cc3d9', '#7bd389', '#9b6bff', '#ff9ec4', '#ffffff', '#ff9f43'];
  const tmp = new THREE.Object3D(), col = new THREE.Color();
  for (let i = 0; i < confettiCount; i++) { tmp.scale.setScalar(0); tmp.updateMatrix(); confetti.setMatrixAt(i, tmp.matrix); confetti.setColorAt(i, col.set(palette[i % palette.length])); }
  let confettiCursor = 0, confettiLive = false;

  // Expanding rings on the ground.
  const ringGeo = new THREE.RingGeometry(.86, 1, 64);
  const rings = Array.from({ length: 8 }, () => {
    const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
    mesh.visible = false; group.add(mesh); return { mesh, life: 0, max: 1, r0: .1, r1: 1, a0: .8 };
  });
  let ringCursor = 0;
  const rand = (a, b) => a + Math.random() * (b - a);

  return {
    group,
    setViewport(heightPx, fovDeg) { const s = heightPx / (2 * Math.tan(fovDeg * Math.PI / 360)); soft.material.uniforms.uScale.value = s; glow.material.uniforms.uScale.value = s; },
    dust(pos, { surface = 'grass', scale = 1, strength = 1 } = {}) {
      const n = Math.round((high ? 6 : 3) * Math.min(1.6, strength));
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(.08, .32) * scale;
        soft.spawn(pos[0], pos[1], pos[2] + .01, { life: rand(.45, .85), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(.08, .28) * scale, g: .12,
          drag: 3, s0: .03 * scale, s1: rand(.09, .16) * scale, a0: .55, color: DUST[surface] ?? DUST.grass });
      }
    },
    sparkBurst(pos, { scale = 1 } = {}) {
      for (let i = 0; i < (high ? 26 : 14); i++) {
        const a = rand(0, Math.PI * 2), e = rand(-.4, 1.2), sp = rand(.6, 1.6) * scale;
        glow.spawn(pos[0], pos[1], pos[2], { life: rand(.35, .8), vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(a) * Math.cos(e) * sp, vz: Math.sin(e) * sp, g: 1.2,
          drag: 2.2, s0: rand(.05, .09) * scale, s1: .01, a0: 1, color: i % 3 ? '#ffd76a' : '#fff6c9' });
      }
      glow.spawn(pos[0], pos[1], pos[2], { life: .35, vx: 0, vy: 0, vz: 0, s0: .2 * scale, s1: .65 * scale, a0: .9, color: '#ffe9a8' });
      this.ring([pos[0], pos[1], pos[2] - .25 * scale], { color: '#ffd76a', radius: .55 * scale, duration: .55, alpha: .7 });
    },
    confetti(pos, count = 120) {
      for (let i = 0; i < Math.min(count, confettiCount); i++) {
        const b = bits[confettiCursor]; confettiCursor = (confettiCursor + 1) % confettiCount;
        const a = rand(0, Math.PI * 2), sp = rand(.8, 2.6);
        b.life = rand(2.2, 3.6); b.p.set(pos[0] + rand(-.3, .3), pos[1] + rand(-.3, .3), pos[2] + rand(0, .3));
        b.v.set(Math.cos(a) * sp * .55, Math.sin(a) * sp * .55, rand(2.2, 4.2)); b.axis.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(); b.angle = rand(0, 6); b.spin = rand(5, 14);
      }
      confettiLive = true;
    },
    ring(pos, { color = '#ffffff', radius = .6, duration = .7, alpha = .75 } = {}) {
      const r = rings[ringCursor]; ringCursor = (ringCursor + 1) % rings.length;
      Object.assign(r, { life: duration, max: duration, r0: radius * .15, r1: radius, a0: alpha });
      r.mesh.material.color.set(color); r.mesh.position.set(pos[0], pos[1], pos[2] + .008); r.mesh.visible = true;
    },
    splash(pos, { scale = 1 } = {}) {
      for (let i = 0; i < (high ? 46 : 24); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(.3, 1.4) * scale;
        soft.spawn(pos[0], pos[1], pos[2], { life: rand(.6, 1.1), vx: Math.cos(a) * sp * .6, vy: Math.sin(a) * sp * .6, vz: rand(1.2, 2.8) * scale, g: 7,
          drag: .6, s0: rand(.04, .08) * scale, s1: .02, a0: .95, color: i % 2 ? '#ffffff' : '#bdf0ee' });
      }
      this.ring(pos, { color: '#ffffff', radius: 1.1 * scale, duration: 1, alpha: .85 });
    },
    poof(pos, { scale = 1 } = {}) {
      for (let i = 0; i < (high ? 18 : 9); i++) {
        const a = rand(0, Math.PI * 2), sp = rand(.3, .9) * scale;
        soft.spawn(pos[0] + Math.cos(a) * .1, pos[1] + Math.sin(a) * .1, pos[2] + rand(0, .2) * scale, { life: rand(.5, .9), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(.1, .5), g: -.2,
          drag: 2.5, s0: .06 * scale, s1: rand(.2, .32) * scale, a0: .8, color: '#ffffff' });
      }
      this.ring(pos, { color: '#ffffff', radius: .9 * scale, duration: .6, alpha: .8 });
    },
    update(dt) {
      soft.update(dt); glow.update(dt);
      for (const r of rings) {
        if (!r.mesh.visible) continue;
        r.life -= dt;
        if (r.life <= 0) { r.mesh.visible = false; continue; }
        const t = 1 - r.life / r.max, e = 1 - (1 - t) ** 3;
        r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * e); r.mesh.material.opacity = r.a0 * (1 - t);
      }
      if (confettiLive) {
        let any = false;
        for (let i = 0; i < confettiCount; i++) {
          const b = bits[i];
          if (b.life <= 0) continue;
          any = true; b.life -= dt;
          b.v.z -= 3.2 * dt; b.v.multiplyScalar(Math.exp(-1.6 * dt)); b.v.z = Math.max(b.v.z, -.75);
          b.p.addScaledVector(b.v, dt); b.angle += b.spin * dt;
          if (b.p.z < .01) { b.p.z = .01; b.v.set(0, 0, 0); b.spin = 0; }
          tmp.position.copy(b.p); tmp.quaternion.setFromAxisAngle(b.axis, b.angle); tmp.scale.setScalar(b.life > 0 ? Math.min(1, b.life * 1.5) : 0);
          tmp.updateMatrix(); confetti.setMatrixAt(i, tmp.matrix);
        }
        confetti.instanceMatrix.needsUpdate = true;
        confettiLive = any;
      }
    },
    dispose() {
      soft.dispose(); glow.dispose(); map.dispose();
      confetti.geometry.dispose(); confetti.material.dispose(); confetti.dispose();
      ringGeo.dispose(); for (const r of rings) r.mesh.material.dispose();
      group.removeFromParent();
    },
  };
}
