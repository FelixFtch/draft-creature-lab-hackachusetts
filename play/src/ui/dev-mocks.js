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

// ---------- showcase roster (docs/v2/ROSTER-AND-TERRAIN.md) ----------
// Mock numbers, physically plausible and internally consistent: every
// predicted limit below follows from the profile's own formulas. The real
// values come from body.json terrainProfile and qa/terrain-trials.json.
const ROSTER_FORMULAS = {
  groundClearanceM: "Lowest torso point above the ground at the nominal stance.",
  legSpanM: "Distance between the front-most and rear-most ground contacts at the nominal stance.",
  strideM: "Longest foot travel per step inside the joint limits.",
  comHeightM: "Whole-body center of mass height at the nominal stance.",
  supportPolygon: "Convex hull of the ground contacts. Margin = shortest distance from the center of mass (projected down) to the hull edge.",
  torqueToWeight: "Peak torque of each joint class ÷ total mass.",
  maxStepUpM: "Highest foot lift inside the joint limits with the other feet planted, capped at 0.8 × ground clearance.",
  jumpApexM: "v_z² ÷ 2g, from the jump policy's take-off speed in validation.",
  maxGapWalkM: "Longest gap the contacts can straddle while the rest of the support polygon stays on solid ground.",
  maxGapJumpM: "Take-off speed × flight time − body length.",
  maxSlopeDeg: "min(grip limit atan μ, tipping limit atan(margin ÷ COM height)).",
  maxRubbleM: "Tallest block the contacts can cross without the torso touching it.",
};

export const ROSTER = [
  {
    id: "rollo",
    name: "Rollo",
    kind: "Wheel-leg",
    tagline: "Balances on two wheels like a segway, then springs into the air.",
    design: { schema: "creature-design/1", name: "Rollo", bodyPlan: "wheeled", basePreset: "wheel_biped", wheeled: { bodyLength: 0.3, bodyHeight: 0.12, thigh: 0.15, shin: 0.15, wheelRadius: 0.08 }, skills: ["drive", "jump"] },
    look: look("tangerine", { body: "#f07c2a", limbs: "#ffe2c2", joints: "#2a3354", accent: "#49b6f0", feet: "#2b2d3a" }, { finish: "gloss", face: { eyes: "visor", eyeColor: "#8cf0ff" } }),
    skills: { drive: "ready", jump: "ready" },
    massKg: 6.2,
    dimensions: { lengthM: 0.34, widthM: 0.36, heightM: 0.42 },
    terrainProfile: {
      contactType: "wheels",
      stability: "dynamic",
      groundClearanceM: 0.17,
      legSpanM: 0,
      trackWidthM: 0.34,
      strideM: null,
      comHeightM: 0.29,
      wheelRadiusM: 0.08,
      supportPolygon: { areaM2: 0, marginM: 0 },
      torqueToWeight: { hip: 2.6, knee: 3.4, wheel: 0.32 },
      predicted: { maxStepUpM: 0.03, jumpApexM: 0.14, maxGapWalkM: 0.06, maxGapJumpM: 0.42, maxSlopeDeg: 24, maxRubbleM: 0.04, frictionMu: 0.8 },
      formulas: {
        ...ROSTER_FORMULAS,
        legSpanM: "Both wheels touch the ground side by side, so there is no front-to-rear span.",
        supportPolygon: "Two wheel contacts make a line, not an area: Rollo has to balance actively.",
        maxSlopeDeg: "Balancers can't lean on a footprint: asin(wheel torque ÷ (mass × g × wheel radius)).",
        maxStepUpM: "A driven wheel climbs about 0.4 × its radius without a hop.",
        maxGapWalkM: "A rolling wheel bridges about 0.75 × its diameter.",
        maxRubbleM: "Half the wheel radius.",
      },
    },
  },
  {
    id: "dog",
    name: "Dog",
    kind: "Robot dog",
    tagline: "The all-rounder: trots over rough ground and jumps small gaps.",
    design: { schema: "creature-design/1", name: "Dog", bodyPlan: "quadruped", basePreset: "cheetah", quadruped: { torsoLength: 0.56, torsoHeight: 0.12, upperLeg: 0.24, lowerLeg: 0.26, actuator: "qdd" }, skills: ["walk", "jump"] },
    look: lookById("classic"),
    skills: { walk: "ready", jump: "ready" },
    massKg: 9.0,
    dimensions: { lengthM: 0.62, widthM: 0.31, heightM: 0.38 },
    terrainProfile: {
      contactType: "point-feet",
      stability: "dynamic",
      groundClearanceM: 0.19,
      legSpanM: 0.42,
      stanceWidthM: 0.24,
      strideM: 0.21,
      comHeightM: 0.27,
      wheelRadiusM: null,
      supportPolygon: { areaM2: 0.1, marginM: 0.115 },
      torqueToWeight: { hip: 2.0, knee: 3.1 },
      predicted: { maxStepUpM: 0.13, jumpApexM: 0.16, maxGapWalkM: 0.15, maxGapJumpM: 0.45, maxSlopeDeg: 23, maxRubbleM: 0.09, frictionMu: 0.8 },
      formulas: ROSTER_FORMULAS,
    },
  },
  {
    id: "octo",
    name: "Octo",
    kind: "Spider",
    tagline: "Eight long legs, always four on the ground. Slow, but very hard to tip.",
    design: { schema: "creature-design/1", name: "Octo", bodyPlan: "multileg", basePreset: "spider", multileg: { legCount: 8, arrangement: "radial", bodyRadius: 0.13, coxa: 0.06, upperLeg: 0.18, lowerLeg: 0.22, actuator: "micro" }, skills: ["walk", "jump"] },
    look: look("grape", { body: "#7b5cf5", limbs: "#e9e2ff", joints: "#2a3354", accent: "#ffc63a", feet: "#2a3354" }, { pattern: { kind: "spots", color: "#b9a6ff", scale: 0.9 } }),
    skills: { walk: "ready", jump: "failed" },
    skillNotes: { jump: "Trained, but it didn't pass its checks: the micro servos can't swing its long legs fast enough." },
    massKg: 5.1,
    dimensions: { lengthM: 0.7, widthM: 0.7, heightM: 0.18 },
    terrainProfile: {
      contactType: "point-feet",
      stability: "static",
      groundClearanceM: 0.08,
      legSpanM: 0.62,
      strideM: 0.12,
      comHeightM: 0.12,
      wheelRadiusM: null,
      supportPolygon: { areaM2: 0.21, marginM: 0.17 },
      torqueToWeight: { hip: 1.5, knee: 1.9 },
      predicted: { maxStepUpM: 0.07, jumpApexM: null, maxGapWalkM: 0.4, maxGapJumpM: null, maxSlopeDeg: 31, maxRubbleM: 0.07, frictionMu: 0.6 },
      formulas: ROSTER_FORMULAS,
    },
  },
  {
    id: "bipo",
    name: "Bipo",
    kind: "Humanoid",
    tagline: "Walks on two flat feet with its arms locked. Steps over small things.",
    design: { schema: "creature-design/1", name: "Bipo", bodyPlan: "humanoid", basePreset: "humanoid", humanoid: { torsoHeight: 0.19, torsoWidth: 0.17, hipWidth: 0.11, upperLeg: 0.15, lowerLeg: 0.15, footLength: 0.1, headSize: 0.085 }, skills: ["walk"] },
    look: look("sky", { body: "#49b6f0", limbs: "#e4f4ff", joints: "#1c2440", accent: "#e2513b", feet: "#1c2440" }, { face: { eyes: "cute", eyeColor: "#1c2440" } }),
    skills: { walk: "ready", jump: "untrained" },
    skillNotes: { jump: "Not trained. A hop is only added if it passes validation." },
    massKg: 7.4,
    dimensions: { lengthM: 0.2, widthM: 0.24, heightM: 0.56 },
    terrainProfile: {
      contactType: "flat-feet",
      stability: "dynamic",
      groundClearanceM: 0.05,
      legSpanM: 0.11,
      stanceWidthM: 0.11,
      footLengthM: 0.1,
      strideM: 0.22,
      comHeightM: 0.33,
      wheelRadiusM: null,
      supportPolygon: { areaM2: 0.018, marginM: 0.03 },
      torqueToWeight: { hip: 2.4, knee: 3.0, ankle: 0.8 },
      predicted: { maxStepUpM: 0.08, jumpApexM: null, maxGapWalkM: 0.18, maxGapJumpM: null, maxSlopeDeg: 14, maxRubbleM: 0.03, frictionMu: 0.8 },
      formulas: {
        ...ROSTER_FORMULAS,
        groundClearanceM: "Swing-foot lift at the nominal gait (a biped's body clears whatever its feet clear).",
        legSpanM: "Heel to toe of the planted foot: both feet stand side by side.",
        maxSlopeDeg: "Dynamic walker: atan(ankle torque ÷ (mass × g × COM height)).",
      },
    },
  },
];

// qa/terrain-trials.json shape (mock).
const trial = (result, seconds, extra = {}) => ({ result, seconds, ...extra });
export const TERRAIN_TRIALS = {
  schema: "terrain-trials/1",
  generatedAt: "2026-10-24T21:40:00Z",
  source: "qa/terrain-trials.json",
  method: "Headless MuJoCo WASM + ONNX Runtime with each robot's own validated policies. Fixed command at 60% of its top speed; an approach-and-jump trigger at edges only when it has a validated jump. One run per lane, same start and finish lines.",
  lanes: [
    { id: "flat", kind: "flat", lengthM: 5 },
    { id: "rubble", kind: "rubble", minHeightM: 0.02, maxHeightM: 0.06 },
    { id: "step-6", kind: "step", heightM: 0.06 },
    { id: "step-12", kind: "step", heightM: 0.12 },
    { id: "step-18", kind: "step", heightM: 0.18 },
    { id: "gap-20", kind: "gap", widthM: 0.2, pitDepthM: 0.6 },
    { id: "gap-35", kind: "gap", widthM: 0.35, pitDepthM: 0.6 },
    { id: "gap-50", kind: "gap", widthM: 0.5, pitDepthM: 0.6 },
    { id: "slope-12", kind: "slope", deg: 12 },
    { id: "slope-20", kind: "slope", deg: 20 },
  ],
  robots: {
    rollo: {
      trials: {
        flat: trial("pass", 3.2),
        rubble: trial("fall", 2.1, { progress: 0.34, failedAt: "6 cm block", note: "A wheel hit a 6 cm block at speed and the body pitched over." }),
        "step-6": trial("pass", 3.9, { usedJump: true }),
        "step-12": trial("pass", 4.6, { usedJump: true }),
        "step-18": trial("fail", 12, { progress: 0.48, failedAt: "18 cm step edge", usedJump: true, why: "Rollo: blocked at 18 cm — wheel radius 0.08 m, jump apex 0.14 m" }),
        "gap-20": trial("pass", 3.6, { usedJump: true }),
        "gap-35": trial("pass", 3.8, { usedJump: true }),
        "gap-50": trial("fall", 2.9, { progress: 0.5, failedAt: "gap", usedJump: true, note: "Landed 7 cm short of the far edge." }),
        "slope-12": trial("pass", 3.4),
        "slope-20": trial("pass", 4.1),
      },
    },
    dog: {
      trials: {
        flat: trial("pass", 9.9),
        rubble: trial("pass", 12.6),
        "step-6": trial("pass", 10.4),
        "step-12": trial("pass", 11.2, { usedJump: true }),
        "step-18": trial("fail", 15, { progress: 0.46, failedAt: "18 cm step edge", usedJump: true }),
        "gap-20": trial("pass", 9.6, { usedJump: true }),
        "gap-35": trial("pass", 10.1, { usedJump: true }),
        "gap-50": trial("fall", 6.8, { progress: 0.49, failedAt: "gap", usedJump: true, note: "Front feet reached; the rear feet dropped in." }),
        "slope-12": trial("pass", 10.8),
        "slope-20": trial("fail", 15, { progress: 0.62, failedAt: "upper half of the 20° ramp", note: "Point feet slipped. The walk policy never saw a ramp this steep in training." }),
      },
    },
    octo: {
      trials: {
        flat: trial("pass", 15.4),
        rubble: trial("pass", 17.9),
        "step-6": trial("pass", 16.8),
        "step-12": trial("fail", 20, { progress: 0.47, failedAt: "12 cm step edge" }),
        "step-18": trial("fail", 20, { progress: 0.46, failedAt: "18 cm step edge" }),
        "gap-20": trial("pass", 15.9),
        "gap-35": trial("pass", 17.2, { why: "Octo: walked across — leg span 0.62 m > gap 0.35 m" }),
        "gap-50": trial("fall", 9.4, { progress: 0.5, failedAt: "gap", note: "Front legs dropped in before the rear legs crossed." }),
        "slope-12": trial("pass", 16.1),
        "slope-20": trial("pass", 19.4),
      },
    },
    bipo: {
      trials: {
        flat: trial("pass", 13.6),
        rubble: trial("fall", 4.3, { progress: 0.22, failedAt: "4 cm block", note: "A flat foot landed half on a block and it tipped sideways." }),
        "step-6": trial("pass", 14.9),
        "step-12": trial("fail", 20, { progress: 0.48, failedAt: "12 cm step edge" }),
        "step-18": trial("fail", 20, { progress: 0.47, failedAt: "18 cm step edge" }),
        "gap-20": trial("pass", 15.2, { note: "A long final stride landed 3 cm past the far edge." }),
        "gap-35": trial("fall", 7.1, { progress: 0.5, failedAt: "gap" }),
        "gap-50": trial("fall", 7.0, { progress: 0.5, failedAt: "gap" }),
        "slope-12": trial("pass", 15.8),
        "slope-20": trial("fall", 9.2, { progress: 0.41, failedAt: "20° ramp", note: "Toes lifted and it tipped backward." }),
      },
    },
  },
};

// ---------- AI Explore goals and decisions ----------
export const EXPLORE_GOALS = [
  { id: "flag-gap", label: "Reach the flag beyond the gap", icon: "flag", instruction: "Reach the yellow flag beyond the gap" },
  { id: "ball-goal", label: "Push the ball into the goal", icon: "ball", instruction: "Push the ball into the goal" },
  { id: "platform", label: "Climb onto the platform", icon: "terrain-step", instruction: "Climb onto the platform" },
  { id: "tower", label: "Visit the blue tower", icon: "tower", instruction: "Visit the blue tower" },
];

export const EXPLORE_HISTORY = [
  { step: 1, operation: "turn_left", durationSeconds: 0.6 },
  { step: 2, operation: "forward", durationSeconds: 1.5 },
  { step: 3, operation: "forward", durationSeconds: 1.2 },
  { step: 4, operation: "jump", durationSeconds: 0 },
];

export const EXPLORE_HISTORY_REFUSED = [
  { step: 1, operation: "forward", durationSeconds: 1.5 },
  { step: 2, operation: "jump", durationSeconds: 0, refused: true, note: "Octo has no verified jump" },
  { step: 3, operation: "turn_right", durationSeconds: 0.8 },
];

export const GAMEPAD_ID = "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)";
