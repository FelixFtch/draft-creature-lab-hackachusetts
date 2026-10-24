// Pilots adapt one policy family to the playground (contracts/world-api.md).
//
// prepare() fetches and hash-verifies the policy's own scene; the engine then
// injects the world and compiles ONE model; attach() binds the controller to
// that model. Pilots never move props: the engine preserves world state around
// pilot.reset(). Dependencies (fetch, controller factory, ORT) are injectable
// so headless Node QA runs exactly this code with real MuJoCo + ONNX.
import { quatMul, yawQuat } from './layout-park.js';

const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
async function sha256(bytes) { return toHex(await crypto.subtle.digest('SHA-256', bytes)); }
async function verified(bytes, expected, name) {
  if (!expected) throw Error(`Missing controller asset hash: ${name}`);
  if (await sha256(bytes) !== expected) throw Error(`Controller asset does not match training export: ${name}`);
  return bytes;
}

// Collision modes for legacy bodies, which were trained with only their foot
// spheres colliding. 'torso' lets the torso shell (contype 4 / conaffinity 8)
// bump into world geoms and props, so creatures cannot ghost through walls,
// crates or the ball. It never collides with the base floor or the robot's
// own feet (both 1/1), so the trained gait on open ground is unchanged.
// See qa/world-park-validation.json for the measured comparison.
export const LEGACY_COLLISION_MODES = ['feet', 'torso'];
const TORSO_BITS = { contype: '4', conaffinity: '8' };

const LEGACY = {
  'legacy-cheetah': {
    base: '/controller/cheetah/', label: 'Draft Cheetah', short: 'Cheetah',
    // The UI range validated in qa/cheetah-controller-validation.json.
    commandBounds: { vx: [-.5, .7], vy: [0, 0], wz: [-.7, .7] },
    torsoGeoms: ['robot/torso_link_mesh'],
    readinessUrl: null,
    honesty: 'Locally trained PPO walking policy for this exact Draft Cheetah body. It was trained and validated on flat ground; the zone map shows what we measured in this park.',
    importController: async () => (await import('../cheetah-controller.js')).createCheetahController,
  },
  'legacy-flower': {
    base: '/controller/flower/', label: 'Flower crawler', short: 'Flower',
    commandBounds: null, // from the manifest (trained range)
    torsoGeoms: ['robot/torso_link_mesh'],
    readinessUrl: '/api/flower-status',
    honesty: 'Independently trained six-leg PPO policy for this exact nominal Flower body, validated on flat ground only; the zone map shows what we measured in this park.',
    importController: async () => (await import('../flower-controller.js')).createFlowerController,
  },
};

function legacyPilot(kind, {
  baseUrl, fetch: fetchImpl = (...args) => fetch(...args), createController, ort, session,
  readinessUrl, collision = 'torso', worldGeomGroup = 0,
} = {}) {
  const spec = LEGACY[kind];
  if (!LEGACY_COLLISION_MODES.includes(collision)) throw Error(`Unknown collision mode ${collision}`);
  const base = baseUrl ?? spec.base;
  const gate = readinessUrl === undefined ? spec.readinessUrl : readinessUrl;
  let config = null;
  const resolve = url => (/^[a-z]+:/i.test(url) || url.startsWith('/')) ? url : base + url;
  async function getBytes(url, name) {
    const response = await fetchImpl(resolve(url));
    if (!response.ok) throw Error(`Could not load ${name} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return {
    kind,
    async prepare() {
      const response = await fetchImpl(`${base}manifest.json`);
      if (!response.ok) throw Error(`${spec.label} walking assets are unavailable`);
      config = await response.json();
      if (gate) {
        // Same release gate as the workshop: a passing, hash-matched controller
        // report must exist before this policy may drive anything.
        const ready = await fetchImpl(gate, { cache: 'no-store' });
        if (!ready.ok || !(await ready.json()).browserReady) throw Error(`${spec.label} movement validation is still pending`);
      }
      const xmlBytes = await verified(await getBytes(config.xmlUrl, 'scene.xml'), config.xmlSha256, 'scene.xml');
      const assets = new Map();
      for (const asset of config.assets) assets.set(asset.name, await verified(await getBytes(asset.url, asset.name), asset.sha256, asset.name));
      const bounds = spec.commandBounds ?? config.commandBounds;
      if (!bounds?.vx || !bounds?.wz) throw Error(`${spec.label} manifest has no command bounds`);
      return {
        xml: new TextDecoder().decode(xmlBytes), assets,
        meta: {
          kind, label: spec.label, short: spec.short, policyId: config.robotId,
          rootBody: config.torsoBodyName, footSites: [...config.footSiteNames], footGeoms: [...config.footGeomNames],
          jointNames: [...config.jointNames], commandBounds: structuredClone(bounds), skills: ['walk'],
          nominalRootHeight: config.initialQpos[2],
          fallCriteria: { minimumRootHeightAboveGround: config.fallCriteria?.minimumRootHeightAboveGround ?? null,
            orientationLimitRad: config.fallCriteria?.orientationLimitRad ?? 1 },
          collision, worldGeomGroup,
          robotGeomBits: collision === 'torso' ? Object.fromEntries(spec.torsoGeoms.map(n => [n, TORSO_BITS])) : {},
          honesty: spec.honesty, provenance: { xmlSha256: config.xmlSha256, policySha256: config.policySha256 },
          readinessChecked: !!gate,
        },
      };
    },
    async attach({ mujoco, model, data }) {
      if (!config) throw Error('Pilot.prepare() must run before attach()');
      const factory = createController ?? await spec.importController();
      const controller = await factory({ mujoco, model, data, manifest: config, policyUrl: resolve(config.policyUrl), ort, session });
      const rootQpos0 = config.initialQpos.slice(0, 7);
      function placeAt(spawn) {
        // Legacy reset puts the body at the exported initial pose at the
        // origin; move only the root free joint to the requested spawn.
        const q = quatMul(yawQuat(spawn.yaw ?? 0), rootQpos0.slice(3, 7));
        const qpos = data.qpos;
        qpos[0] = spawn.x + rootQpos0[0]; qpos[1] = spawn.y + rootQpos0[1]; qpos[2] = rootQpos0[2] + (spawn.z ?? 0);
        qpos[3] = q[0]; qpos[4] = q[1]; qpos[5] = q[2]; qpos[6] = q[3];
        mujoco.mj_forward(model, data);
      }
      function snapshot() {
        const s = controller.snapshot();
        return { position: s.position, heading: s.heading, fall: !!s.fall, error: s.error ?? null, tilt: s.tilt,
          velocity: s.actualVelocity, command: s.command, controlSteps: s.controlSteps, controller: s.controller,
          heightAboveFeet: s.heightAboveFeet ?? null, heightAboveGround: s.heightAboveGround ?? null };
      }
      return {
        reset(spawn = { x: 0, y: 0, yaw: 0 }) { controller.reset(); placeAt(spawn); return snapshot(); },
        async step(command, opts = {}) {
          if (opts.jump) throw Error(`${spec.label} has no trained jump skill`);
          await controller.step(command);
          return snapshot();
        },
        cancelStep: () => controller.cancelStep(),
        snapshot,
        dispose: () => controller.dispose(),
      };
    },
  };
}

export const createLegacyCheetahPilot = (options = {}) => legacyPilot('legacy-cheetah', options);
export const createLegacyFlowerPilot = (options = {}) => legacyPilot('legacy-flower', options);

// The trainer's play/src/creature-controller.js exposes the pilot interface.
// Vite resolves this glob at build time to {} until that module exists, so the
// playground builds and runs before the trainer's work lands.
function loadCreatureModule() {
  const modules = import.meta.glob('../creature-controller.js');
  const load = modules['../creature-controller.js'];
  if (!load) throw Error('The creature policy controller is not part of this build yet');
  return load();
}

const REQUIRED_META = ['rootBody', 'commandBounds', 'skills'];
export function createCreaturePilot(bundleUrl, options = {}) {
  if (typeof bundleUrl !== 'string' || !bundleUrl) throw Error('createCreaturePilot needs a policy bundle URL');
  let inner = null;
  async function load() {
    if (inner) return inner;
    const mod = await (options.loadModule ?? loadCreatureModule)();
    const factory = mod.createCreaturePilot ?? mod.createPilot;
    if (typeof factory !== 'function') throw Error('creature-controller.js must export createCreaturePilot(bundleUrl)');
    const candidate = await factory(bundleUrl, options);
    if (typeof candidate?.prepare !== 'function' || typeof candidate?.attach !== 'function')
      throw Error('Creature pilot must implement prepare() and attach()');
    return (inner = candidate);
  }
  return {
    kind: 'creature',
    async prepare() {
      const prepared = await (await load()).prepare();
      if (typeof prepared?.xml !== 'string' || !(prepared.assets instanceof Map)) throw Error('Creature pilot returned an invalid scene');
      const meta = { ...prepared.meta };
      for (const key of REQUIRED_META) if (meta[key] == null) throw Error(`Creature pilot meta is missing ${key}`);
      meta.kind = 'creature';
      meta.label ??= 'Your creature';
      meta.short ??= meta.label;
      meta.skills = [...new Set(meta.skills)].filter(s => s === 'walk' || s === 'jump');
      meta.commandBounds = { vx: meta.commandBounds.vx, vy: meta.commandBounds.vy ?? [0, 0], wz: meta.commandBounds.wz };
      meta.worldGeomGroup ??= 0;
      meta.robotGeomBits ??= {}; // new-pipeline bodies already use the shared collision bits
      meta.honesty ??= 'Trained policy for this exact body; see its validation report.';
      return { ...prepared, meta };
    },
    async attach(ctx) {
      const runtime = await inner.attach(ctx);
      for (const key of ['reset', 'step', 'snapshot', 'dispose'])
        if (typeof runtime?.[key] !== 'function') throw Error(`Creature pilot runtime is missing ${key}()`);
      return runtime;
    },
  };
}

export const PILOT_FACTORIES = { 'legacy-cheetah': createLegacyCheetahPilot, 'legacy-flower': createLegacyFlowerPilot };
