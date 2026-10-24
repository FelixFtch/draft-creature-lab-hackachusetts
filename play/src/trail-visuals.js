import * as THREE from 'three';
import { TRAIL_TARGETS, TRAIL_RADIUS } from './trail-game.js';

// Display-only landmarks; never passed to MuJoCo or the policy's terrain rays.
export function createTrailVisuals(scene) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const textures = [];
  function badge(text, color) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.beginPath(); ctx.arc(64, 64, 56, 0, Math.PI * 2); ctx.fillStyle = '#fffaf0'; ctx.fill();
    ctx.lineWidth = 8; ctx.strokeStyle = color; ctx.stroke();
    ctx.font = 'bold 64px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = color; ctx.fillText(text, 64, 67);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    textures.push(texture); return texture;
  }
  const markers = TRAIL_TARGETS.map(([x, y], i) => {
    const node = new THREE.Group(); node.position.set(x, 0, -y); group.add(node);
    const ring = new THREE.Mesh(new THREE.RingGeometry(TRAIL_RADIUS-.035, TRAIL_RADIUS, 64),
      new THREE.MeshBasicMaterial({color: '#c58a42', side: THREE.DoubleSide, transparent: true, opacity: .9}));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .012; node.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(TRAIL_RADIUS-.04, 48),
      new THREE.MeshBasicMaterial({color: '#efcb7e', transparent: true, opacity: .15, depthWrite: false}));
    disc.rotation.x = -Math.PI / 2; disc.position.y = .009; node.add(disc);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .28, 8),
      new THREE.MeshStandardMaterial({color: '#9b956e', roughness: .9}));
    stem.position.y = .15; node.add(stem);
    const numbered = badge(String(i + 1), '#926031');
    const sign = new THREE.Sprite(new THREE.SpriteMaterial({map: numbered, transparent: true, depthWrite: false}));
    sign.position.y = .49; sign.scale.set(.15, .15, 1); node.add(sign);
    return {node, ring, disc, stem, sign, numbered};
  });
  const route = new THREE.Line(new THREE.BufferGeometry().setFromPoints([[0,0], ...TRAIL_TARGETS].map(([x,y])=>new THREE.Vector3(x,.005,-y))),
    new THREE.LineDashedMaterial({color:'#b1bca6', dashSize:.09, gapSize:.07}));
  route.computeLineDistances(); group.add(route);
  return {
    update(trail) {
      group.visible = !!trail;
      if (!trail) return;
      markers.forEach((m, i) => {
        const done = i < trail.collected, next = i === trail.collected && trail.phase === 'active';
        const color = done ? '#397966' : next ? '#c48432' : '#a8b49c';
        m.ring.material.color.set(color); m.disc.material.color.set(color);
        m.disc.material.opacity = next ? .23 : done ? .12 : .05;
        // A nearby billboard can fill the robot's forward camera after reaching
        // its circle. Retire its sign in every view, retaining the green floor
        // stamp as the completion cue. This changes presentation only.
        m.sign.visible = !done; m.stem.visible = !done;
        m.sign.material.map = m.numbered;
        m.sign.material.opacity = next ? 1 : .55;
        // The forward camera sits ahead of the torso. At the collection edge
        // a large sign would fill its view before the body enters the circle.
        // Keep the digit readable without changing the physical goal radius.
        m.sign.scale.setScalar(next ? .18 : .15);
      });
    },
    dispose() {
      scene.remove(group);
      group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
      textures.forEach(t => t.dispose());
    },
  };
}
