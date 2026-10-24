"""Near-miss words models use for schema enum values.

Keys are lowercase alphanumerics (what schemas._enum_match compares); values
are the canonical enum strings. Only applied when a value is not already
valid, and only if the mapped value is allowed by the live schema.
"""

SYNONYMS = {
    "fourlegged": "quadruped", "quadrupedal": "quadruped", "quad": "quadruped",
    "hexapod": "multileg", "octopod": "multileg", "multilegged": "multileg", "multilegs": "multileg",
    "sixlegged": "multileg", "eightlegged": "multileg", "radialmultileg": "multileg",
    "quasidirectdrive": "qdd", "directdrive": "qdd", "proprioceptive": "qdd",
    "servo": "micro", "servos": "micro", "hobbyservo": "micro", "microservo": "micro",
    "planetary": "geared", "gearbox": "geared", "gear": "geared", "highgear": "geared",
    "harmonicdrive": "harmonic", "strainwave": "harmonic",
    "circular": "radial", "round": "radial", "paired": "bilateral", "pairs": "bilateral",
    "walking": "walk", "jumping": "jump", "hop": "jump", "hopping": "jump",
    "glossy": "gloss", "shiny": "gloss", "metallic": "metal", "glowing": "glow", "cartoon": "toon",
    "spotted": "spots", "dots": "spots", "polkadots": "spots", "striped": "stripes", "stripe": "stripes",
    "camouflage": "camo", "checkered": "checker", "checkerboard": "checker", "plain": "none",
    "antenna": "antennae", "antennas": "antennae", "horn": "horns", "wing": "wings", "fins": "fin",
    "spike": "spikes", "ear": "ears", "tails": "tail", "jetpack": "backpack", "hooves": "hoof",
    "paws": "paw", "pads": "pad", "balls": "ball", "furry": "fluffy", "fur": "fluffy", "armour": "armor",
    "shell": "dome", "petal": "petals", "kawaii": "cute", "bugeyes": "compound",
}
