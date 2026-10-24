// Realistic mock data for the UI harness (ui-dev.html). Shapes follow the
// shared contracts: creature-design/1, creature-look/1, creature-body/1,
// creature-policy/1 eval rows, ai-service /health and /chat, playground
// snapshot(). Deterministic so screenshots are stable.

// ---------- looks (stand-ins for appearance LOOK_PRESETS) ----------
const look = (theme, palette, extra = {}) => ({ schema: "creature-look/1", theme, palette, finish: "satin", face: { eyes: "round", eyeColor: "#1c2440" }, ...extra });

export const LOOK_PRESETS = [
  { id: "classic", name: "Workshop teal", look: look("classic", { body: "#1f8c80", limbs: "#d9e8e2", joints: "#2a3354", accent: "#ffc63a", feet: "#2a3354" }) },
  { id: "frog", name: "Pond frog", look: look("frog", { body: "#43b05c", limbs: "#a6dc78", joints: "#1f5e2e", accent: "#ffd84d", feet: "#2f7a3a" }, { finish: "gloss", pattern: { kind: "spots", color: "#2a7d38", scale: 1 }, face: { eyes: "cute", eyeColor: "#1c2440" } }) },
  { id: "ladybug", name: "Ladybug", look: look("ladybug", { body: "#e23b2e", limbs: "#2b2d3a", joints: "#1c2440", accent: "#1c2440", feet: "#1c2440" }, { finish: "gloss", shell: { kind: "beetle", color: "#e23b2e", size: 1.05 }, pattern: { kind: "spots", color: "#1c2440", scale: 1.2 }, accessories: [{ kind: "antennae", color: "#1c2440", size: 1 }] }) },
  { id: "tank", name: "Toy tank", look: look("toy tank", { body: "#6f8240", limbs: "#3c4524", joints: "#2a3354", accent: "#c9a36a", feet: "#2b2b2b" }, { finish: "matte", pattern: { kind: "camo", color: "#4b5a26", scale: 1 }, shell: { kind: "armor", color: "#7d8f45", size: 1 }, face: { eyes: "visor" } }) },
  { id: "jade", name: "Jade dragon", look: look("jade dragon", { body: "#2fa38a", limbs: "#bfe8d8", joints: "#c99a2e", accent: "#ffd166", feet: "#c99a2e" }, { finish: "metal", accessories: [{ kind: "horns", color: "#ffd166", size: 1 }, { kind: "spikes", color: "#ffd166", size: 1 }, { kind: "tail", color: "#2fa38a", size: 1.2 }], face: { eyes: "cute", eyeColor: "#c3301c" } }) },
  { id: "bee", name: "Bumblebee", look: look("bumblebee", { body: "#ffc63a", limbs: "#2b2d3a", joints: "#1c2440", accent: "#1c2440", feet: "#1c2440" }, { pattern: { kind: "bands", color: "#1c2440", scale: 1.1 }, accessories: [{ kind: "wings", color: "#dff3ff", size: 1 }, { kind: "antennae", color: "#1c2440", size: 1 }], face: { eyes: "compound", eyeColor: "#1c2440" } }) },
  { id: "candy", name: "Candy", look: look("candy", { body: "#ff8fb3", limbs: "#fff3cf", joints: "#7b5cf5", accent: "#49b6f0", feet: "#7b5cf5" }, { finish: "toon", pattern: { kind: "stripes", color: "#fffcf5", scale: 1 }, accessories: [{ kind: "bow", color: "#49b6f0", size: 1.1 }], face: { eyes: "cute" } }) },
  { id: "midnight", name: "Midnight glow", look: look("midnight", { body: "#232a4d", limbs: "#3a4473", joints: "#49b6f0", accent: "#8cf0ff", feet: "#49b6f0" }, { finish: "glow", pattern: { kind: "panels", color: "#8cf0ff", scale: 1 }, face: { eyes: "visor", eyeColor: "#8cf0ff" } }) },
];
export const lookById = id => LOOK_PRESETS.find(p => p.id === id)?.look;

// ---------- designs ----------
export const DESIGN_HOPPER = {
  schema: "creature-design/1",
  name: "Hopper",
  concept: "A frog-like hopper that jumps onto platforms.",
  bodyPlan: "quadruped",
  basePreset: "cheetah",
  quadruped: { torsoLength: 0.42, torsoWidth: 0.26, torsoHeight: 0.13, shoulderWidth: 0.22, upperLeg: 0.22, lowerLeg: 0.25, actuator: "qdd", strength: 1.15 },
  skills: ["walk", "jump"],
  look: lookById("frog"),
};

export const DESIGN_PETAL = {
  schema: "creature-design/1",
  name: "Petal",
  concept: "A six-legged flower that tiptoes around the garden.",
  bodyPlan: "multileg",
  basePreset: "flower",
  multileg: { legCount: 6, arrangement: "radial", bodyRadius: 0.14, coxa: 0.07, upperLeg: 0.16, lowerLeg: 0.2, actuator: "micro", strength: 1 },
  skills: ["walk"],
  look: lookById("candy"),
};

export const DESIGN_MOOSE = {
  schema: "creature-design/1",
  name: "Moose",
  concept: "A giant moose with tiny servos.",
  bodyPlan: "quadruped",
  basePreset: "giraffe",
  quadruped: { torsoLength: 0.8, torsoHeight: 0.33, upperLeg: 0.68, lowerLeg: 0.62, actuator: "micro", strength: 0.6 },
  skills: ["walk"],
  look: lookById("tank"),
};

export const DESIGN_SIDESTEP = {
  schema: "creature-design/1",
  name: "Sidestep",
  concept: "A crab with eight legs that scuttles sideways.",
  bodyPlan: "multileg",
  multileg: { legCount: 8, arrangement: "bilateral", bodyRadius: 0.13, bodyAspect: 1.7, coxa: 0.06, upperLeg: 0.15, lowerLeg: 0.18, actuator: "qdd" },
  skills: ["walk"],
  look: lookById("ladybug"),
};

// ---------- body contracts ----------
const HASH = seed => {
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < 64; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += (x >>> 28).toString(16);
  }
  return out;
};

function quadBody({ id, design, massKg, dims, hip, knee }) {
  const legs = [
    { name: "fl", side: "left", end: "front", mountAngle: 0.52 },
    { name: "fr", side: "right", end: "front", mountAngle: -0.52 },
    { name: "rl", side: "left", end: "rear", mountAngle: 2.62 },
    { name: "rr", side: "right", end: "rear", mountAngle: -2.62 },
  ].map(l => ({ ...l, joints: [`${l.name}_hip_roll`, `${l.name}_hip_pitch`, `${l.name}_knee`], footSite: `${l.name}_foot`, footRadius: 0.025, bodies: [`${l.name}_upper`, `${l.name}_lower`] }));
  const joints = legs.flatMap(l => [
    { name: `${l.name}_hip_roll`, role: "hip_roll", range: [-0.6, 0.6], effort: hip.effort, velocity: hip.velocity, gear: hip.gear },
    { name: `${l.name}_hip_pitch`, role: "hip_pitch", range: [-1.7, 1.3], effort: hip.effort, velocity: hip.velocity, gear: hip.gear },
    { name: `${l.name}_knee`, role: "knee", range: [-2.7, -0.35], effort: knee.effort, velocity: knee.velocity, gear: knee.gear },
  ]);
  return {
    schema: "creature-body/1",
    id,
    name: design.name,
    bodyPlan: "quadruped",
    design,
    xmlFile: "body.xml",
    meshFiles: ["torso_mesh.stl"],
    rootBody: "torso_link",
    imuSite: "imu",
    forwardAxis: [1, 0, 0],
    legs,
    jointNames: joints.map(j => j.name),
    joints,
    massKg,
    dimensions: dims,
    nominalRootHeight: dims.heightM * 0.78,
    gaitHint: { pattern: "trot", groups: [[0, 3], [1, 2]] },
    motors: [
      { class: "M", family: design.quadruped.actuator, effortNm: hip.effort, velocityRadS: hip.velocity, gear: hip.gear, massKg: 0.42, catalogAnchor: "MIT Mini Cheetah hip" },
      { class: "L", family: design.quadruped.actuator, effortNm: knee.effort, velocityRadS: knee.velocity, gear: knee.gear, massKg: 0.55, catalogAnchor: "MIT Mini Cheetah knee" },
    ],
    feasibility: { passed: true, warnings: ["Knee torque margin is 22% at a full crouch."], overridden: [] },
    provenance: {
      generator: "Draft RobotGenerator strict=True",
      draftRevision: "3b03e14c9d2a7f51e08b",
      template: "quadruped",
      sourcesSha256: { "designs.py": HASH(11), "templates/quadruped.yaml": HASH(12) },
      assetSha256: { "body.xml": HASH(13), "torso_mesh.stl": HASH(14) },
    },
  };
}

export const BODY_HOPPER = quadBody({
  id: "quadruped-3f9a1c2e7b4d5a60",
  design: DESIGN_HOPPER,
  massKg: 6.4,
  dims: { lengthM: 0.52, widthM: 0.31, heightM: 0.36, legLengthM: 0.47 },
  hip: { effort: 18, velocity: 30, gear: 6 },
  knee: { effort: 28, velocity: 22, gear: 9.33 },
});

export const BODY_PETAL = (() => {
  const n = 6;
  const legs = Array.from({ length: n }, (_, i) => {
    const angle = Math.PI / n + (i * 2 * Math.PI) / n;
    const deg = (angle * 180) / Math.PI;
    const end = deg < 75 || deg > 285 ? "front" : deg > 105 && deg < 255 ? "rear" : "middle";
    const side = Math.sin(angle) > 0.05 ? "left" : Math.sin(angle) < -0.05 ? "right" : "center";
    return { name: `l${i}`, side, end, mountAngle: Math.atan2(Math.sin(angle), Math.cos(angle)), joints: [`l${i}_hip_yaw`, `l${i}_hip_pitch`, `l${i}_knee`], footSite: `l${i}_foot`, footRadius: 0.018 };
  });
  const joints = legs.flatMap(l => [
    { name: `${l.name}_hip_yaw`, role: "hip_yaw", range: [-0.5, 0.5], effort: 2.1, velocity: 6.5, gear: 1 },
    { name: `${l.name}_hip_pitch`, role: "hip_pitch", range: [-1.2, 1.2], effort: 2.1, velocity: 6.5, gear: 1 },
    { name: `${l.name}_knee`, role: "knee", range: [-2.2, 0.2], effort: 2.6, velocity: 6, gear: 1 },
  ]);
  return {
    schema: "creature-body/1",
    id: "multileg-9ad41b77c0e2f381",
    name: "Petal",
    bodyPlan: "multileg",
    design: DESIGN_PETAL,
    legs,
    jointNames: joints.map(j => j.name),
    joints,
    massKg: 1.9,
    dimensions: { lengthM: 0.29, widthM: 0.74, heightM: 0.19, legLengthM: 0.36 },
    gaitHint: { pattern: "tripod", groups: [[0, 2, 4], [1, 3, 5]] },
    motors: [{ class: "S", family: "micro", effortNm: 2.6, velocityRadS: 6.5, gear: 1, massKg: 0.06, catalogAnchor: "hobby servo" }],
    feasibility: { passed: true, warnings: [], overridden: [] },
    provenance: { generator: "Draft RobotGenerator strict=True", draftRevision: "3b03e14c9d2a7f51e08b", template: "multileg", assetSha256: { "body.xml": HASH(21), "hub_mesh.stl": HASH(22) } },
  };
})();

// ---------- training ----------
function rng(seed) {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

export function rewardCurve(points = 64, upToSteps = 2.6e6, seed = 7) {
  const r = rng(seed);
  return Array.from({ length: points }, (_, i) => {
    const step = (upToSteps * (i + 1)) / points;
    const base = 26 * (1 - Math.exp(-step / 1.1e6)) - 2.5;
    return { step, reward: +(base + (r() - 0.5) * 2.6 * (1 - i / points / 1.5)).toFixed(2) };
  });
}

export const WALK_EVAL_ROWS = [
  { id: "stand", name: "Stand still 10 s", command: { vx: 0, wz: 0 }, measured: { vx: 0.01, wz: 0.0 }, fall: false, pass: true },
  { id: "forward", name: "Walk forward", command: { vx: 0.4 }, measured: { vx: 0.36 }, fall: false, pass: true },
  { id: "backward", name: "Walk backward", command: { vx: -0.2 }, measured: { vx: -0.17 }, fall: false, pass: true },
  { id: "left", name: "Turn left", command: { wz: 0.8 }, measured: { wz: 0.66 }, fall: false, pass: true },
  { id: "right", name: "Turn right", command: { wz: -0.8 }, measured: { wz: -0.62 }, fall: false, pass: true },
  { id: "push", name: "Recover from a push", command: { vx: 0.2 }, measured: { vx: 0.18 }, fall: false, pass: true },
];

export const WALK_EVAL_FAILED = WALK_EVAL_ROWS.map(row =>
  row.id === "backward" ? { ...row, measured: { vx: -0.03 }, pass: false } : row.id === "push" ? { ...row, measured: { vx: 0.02 }, fall: true, pass: false } : row,
);

export const JUMP_EVAL_ROWS = [
  { id: "apex", name: "Jump height", command: { jump: 1 }, measured: { apexGainM: 0.11 }, target: "≥ 0.08 m", fall: false, pass: true },
  { id: "land", name: "Lands upright", command: { jump: 1 }, measured: { upright: true }, fall: false, pass: true },
  { id: "recover", name: "Walks again after landing", command: { vx: 0.3 }, measured: { vx: 0.27 }, fall: false, pass: true },
];

export const TRAINING_STATES = {
  untrained: {
    walk: { state: "untrained", estimateMinutes: 12 },
    jump: { state: "untrained", estimateMinutes: 18, available: false, reason: "Learn to walk first" },
  },
  training: {
    walk: {
      state: "training",
      progress: { envSteps: 2.6e6, targetSteps: 5e6, iteration: 312, targetIterations: 600, stepsPerSecond: 4280, elapsedSeconds: 607, etaSeconds: 561, curve: rewardCurve() },
    },
    jump: { state: "queued", estimateMinutes: 18 },
  },
  validating: {
    walk: { state: "validating", progress: { envSteps: 5e6, targetSteps: 5e6, iteration: 600, targetIterations: 600, stepsPerSecond: 4310, elapsedSeconds: 1162, curve: rewardCurve(80, 5e6) }, eval: { rows: WALK_EVAL_ROWS.map((row, i) => (i < 3 ? row : { ...row, pending: true, measured: null, pass: null })) } },
    jump: { state: "queued", estimateMinutes: 18 },
  },
  ready: {
    walk: { state: "ready", hashMatched: true, progress: { envSteps: 5e6, targetSteps: 5e6, iteration: 600, targetIterations: 600, stepsPerSecond: 4310, elapsedSeconds: 1162, curve: rewardCurve(80, 5e6) }, eval: { pass: true, rows: WALK_EVAL_ROWS }, honesty: "Flat-ground PPO policy for this exact body. Not tested on stairs or real hardware." },
    jump: { state: "ready", hashMatched: true, eval: { pass: true, rows: JUMP_EVAL_ROWS }, honesty: "One-shot jump from standing on flat ground." },
  },
  failed: {
    walk: { state: "failed", progress: { envSteps: 5e6, targetSteps: 5e6, iteration: 600, targetIterations: 600, stepsPerSecond: 4310, elapsedSeconds: 1170, curve: rewardCurve(80, 5e6, 3).map(p => ({ ...p, reward: +(p.reward * 0.55).toFixed(2) })) }, eval: { pass: false, rows: WALK_EVAL_FAILED }, honesty: "Validation failed, so this policy stays locked." },
    jump: { state: "untrained", available: false, reason: "Learn to walk first" },
  },
};

// ---------- chat ----------
export const CHAT_IMAGINE = [
  { id: "m1", role: "tinker", kind: "text", text: "Hi, I'm Tinker! Tell me about a creature and I'll draft a real robot body for it: joints, motors and all." },
  { id: "m2", role: "user", kind: "text", text: "I want a frog that jumps onto platforms" },
  { id: "m3", role: "tinker", kind: "text", text: "A jumper needs strong back legs and springy motors. Should it be cat-sized or dog-sized?" },
  { id: "m4", role: "user", kind: "text", text: "Cat-sized, and green please" },
  { id: "m5", role: "tinker", kind: "design", text: "Here's Hopper. Springy QDD motors give it the snap for jumping, and a short torso keeps it light.", design: DESIGN_HOPPER, designStatus: "proposed" },
];

export const CHAT_BUILT = [
  ...CHAT_IMAGINE.slice(0, 4),
  { ...CHAT_IMAGINE[4], designStatus: "built", body: BODY_HOPPER },
  { id: "n1", role: "system", kind: "note", text: "Draft built Hopper in 3.4 s and it passed the feasibility check" },
  {
    id: "m6",
    role: "tinker",
    kind: "training",
    text: "Hopper has a body now. It doesn't know how to move yet.",
    creatureName: "Hopper",
    training: { skills: [{ skill: "walk", minutes: 12 }, { skill: "jump", minutes: 18, available: false, reason: "After walk" }] },
  },
];

export const CHAT_PROBLEM = [
  { id: "p1", role: "user", kind: "text", text: "Make a giant moose with tiny servos" },
  { id: "p2", role: "tinker", kind: "design", text: "Here's Moose: long legs, big body, micro servos like you asked.", design: DESIGN_MOOSE, designStatus: "infeasible" },
  {
    id: "p3",
    role: "tinker",
    kind: "problem",
    text: "Draft's check stopped this one. Tiny servos can't hold up a body that big.",
    problem: {
      title: "The knees can't hold the body",
      reason: "At standing height each knee needs much more torque than a micro servo can give.",
      numbers: [
        { label: "Knee torque", need: 38.5, have: 2.6, unit: "N·m" },
        { label: "Hip torque", need: 21, have: 2.1, unit: "N·m" },
      ],
      warnings: ["Body mass 31 kg is above the micro family's limit of 4 kg."],
    },
  },
];

export const CHAT_STREAMING = [
  ...CHAT_BUILT.slice(0, 2),
  { id: "s1", role: "user", kind: "text", text: "Can you make it look like a ladybug?" },
  { id: "s2", role: "tinker", kind: "text", text: "Ooh, red shell, black spots and little antennae. Painting it", status: "streaming" },
];

export const CHAT_LOOK = [
  ...CHAT_BUILT,
  { id: "l1", role: "user", kind: "text", text: "Can you make it look like a ladybug?" },
  { id: "l2", role: "tinker", kind: "look", text: "Red shell, black spots and little antennae. Paint only, so its skills stay valid.", look: lookById("ladybug"), lookName: "Ladybug", design: DESIGN_HOPPER },
];

export const SUGGESTIONS = {
  imagine: ["Build it", "Longer legs", "Make it six-legged", "Surprise me"],
  built: ["Teach it to walk", "Make it a ladybug", "Show its motors", "Make it lighter"],
  problem: ["Use stronger motors", "Make it smaller", "Ask Tinker to fix it"],
  first: ["A frog that hops onto platforms", "A six-legged flower crawler", "A sturdy little bear bot", "Surprise me"],
};

// ---------- ai-service /health ----------
export const HEALTH_LOCAL = {
  ok: true,
  offline: false,
  roles: {
    brain: { configured: true, reachable: true, kind: "local", provider: "ollama", model: "qwen2.5:7b-instruct" },
    eyes: { configured: true, reachable: true, kind: "local", provider: "ollama", model: "qwen2.5vl:7b" },
  },
};

export const HEALTH_MIXED = {
  ok: true,
  offline: false,
  roles: {
    brain: { configured: true, reachable: true, kind: "cloud", provider: "dashscope", model: "qwen-plus" },
    eyes: { configured: false, reachable: false, kind: "none", provider: null, model: null },
  },
};

export const HEALTH_OFFLINE = { ok: true, offline: true, roles: { brain: { configured: false, reachable: false, kind: "offline" }, eyes: { configured: false, reachable: false, kind: "none" } } };

export const PROVIDER_LOCAL = { kind: "local", name: "ollama", model: "qwen2.5:7b-instruct", offline: false };
export const PROVIDER_OFFLINE = { kind: "offline", name: "rules", offline: true };

// ---------- shelf ----------
export const SHELF = {
  starters: [
    { id: "preset-cheetah", name: "Cheetah", design: "cheetah", look: "#1f8c80", skills: { walk: "ready" }, note: "Original Draft preset" },
    { id: "preset-bear", name: "Bear", design: "bear", look: "#c47f3d", skills: { walk: "untrained" }, note: "Original Draft preset" },
    { id: "preset-giraffe", name: "Giraffe", design: "giraffe", look: "#e2b43f", skills: { walk: "untrained" }, note: "Original Draft preset" },
    { id: "preset-flower", name: "Flower", design: "flower", look: lookById("candy"), skills: { walk: "ready" }, note: "Six-leg crawler" },
  ],
  mine: [
    { id: "hopper", name: "Hopper", design: DESIGN_HOPPER, look: lookById("frog"), skills: { walk: "ready", jump: "ready" }, current: true },
    { id: "hopper-lady", name: "Ladybot", design: DESIGN_HOPPER, look: lookById("ladybug"), skills: { walk: "ready", jump: "ready" }, parent: { id: "hopper", name: "Hopper" } },
    { id: "petal", name: "Petal", design: DESIGN_PETAL, look: lookById("candy"), skills: { walk: "untrained" }, parent: { id: "preset-flower", name: "Flower" } },
    { id: "sidestep", name: "Sidestep", design: DESIGN_SIDESTEP, look: lookById("ladybug"), skills: { walk: "training" } },
  ],
};

// ---------- playground ----------
export const LANDMARKS = ["red ball", "goal", "big ramp", "hoop", "crates", "jump pad", "dominoes"];

export const CHALLENGES = [
  { id: "first-steps", title: "First steps", text: "Walk 5 meters", status: "done", reward: { sticker: "first-steps", sparks: 5 } },
  { id: "spark-hunt", title: "Spark hunt", text: "Collect 10 sparks", status: "done", progress: { value: 10, total: 10 }, reward: { sticker: "spark-hunt" } },
  { id: "ramp-run", title: "Ramp run", text: "Climb all three ramps", status: "active", progress: { value: 2, total: 3 }, reward: { sticker: "ramp-run" } },
  { id: "goal", title: "Goal!", text: "Push the ball into the goal", status: "open", reward: { sticker: "goal" } },
  { id: "domino", title: "Domino day", text: "Knock over every domino", status: "open", progress: { value: 0, total: 12 }, reward: { sticker: "domino" } },
  { id: "hoop", title: "Hoop hop", text: "Jump through the hoop", status: "locked", needs: "jump", reward: { sticker: "hoop" } },
  { id: "lily", title: "Lily pads", text: "Jump across four platforms", status: "locked", needs: "jump", reward: { sticker: "lily" } },
  { id: "explorer", title: "Explorer", text: "Let AI Explore find the red ball", status: "open", needs: "eyes", reward: { sticker: "explorer" } },
];

export const STICKERS = [
  { id: "first-steps", title: "First steps", art: "paw", tone: "leaf", earned: true },
  { id: "spark-hunt", title: "Spark hunter", art: "spark", tone: "sun", earned: true },
  { id: "designer", title: "Designer", art: "pencil", tone: "bp", earned: true },
  { id: "teacher", title: "Good teacher", art: "cap", tone: "grape", earned: true },
  { id: "ramp-run", title: "Ramp champ", art: "ramp", tone: "sky", earned: false, hint: "Climb all three ramps" },
  { id: "goal", title: "Goal!", art: "ball", tone: "tomato", earned: false, hint: "Score a goal" },
  { id: "domino", title: "Topple", art: "domino", tone: "grape", earned: false, hint: "Knock over every domino" },
  { id: "hoop", title: "Hoop hop", art: "hoop", tone: "bubble", earned: false, hint: "Jump through the hoop" },
  { id: "lily", title: "Lily pads", art: "lily", tone: "leaf", earned: false, hint: "Jump across four platforms" },
  { id: "explorer", title: "Explorer", art: "eye", tone: "bp", earned: false, hint: "Let AI Explore find the red ball" },
  { id: "speedy", title: "Zoom", art: "bolt", tone: "sun", earned: false, hint: "Run 20 meters without stopping" },
  { id: "remix", title: "Remixer", art: "remix", tone: "bubble", earned: false, hint: "Save a remix of a creature" },
];

export const PLAY_SNAPSHOT = {
  robot: { pos: [1.2, 0.4, 0.3], heading: 0.4, speed: 0.32, fall: false },
  sparks: { got: 12, total: 40 },
  challenge: { id: "ramp-run", title: "Ramp run", text: "Climb all three ramps", progress: { value: 2, total: 3 } },
  skills: { walk: "ready", jump: "ready" },
  explore: { state: "idle" },
};
