"""Tinker's offline designer: rule-based, deterministic per conversation, and
meant to be fun rather than a form.

Used when no brain provider is configured, when it is unreachable, or when
the model's output could not be repaired. It understands creature ideas
("a frog that jumps onto platforms"), restyles ("make it look like a
ladybug"), tweaks ("bigger", "longer legs", "make it jump", "six legs"),
build results (Draft feasibility failures) and train/play requests. It never
claims that anything was built or trained: the client does that.

Every design and look it proposes is validated against the runtime contract
schemas by designer.py before it leaves the service.
"""
from __future__ import annotations

import copy
import functools
import hashlib
import json
import random
import re

import looks as L
from schemas import DESIGN_ID, NAMED_COLORS

DRAFT_LINE = ("Draft sizes the motors from trends fitted to 114 real actuators and checks whether the robot "
              "could be built.")
MODEL = "tinker-rules/1"
Q = "quadruped"
M = "multileg"

# ---------------------------------------------------------------------------
# Body archetypes. Ranges are metres (or a strength multiplier); a value is
# drawn per conversation so two frogs are siblings, not clones. designer.py
# clamps everything to the live schema bounds afterwards. In the pitches,
# {act} is a noun phrase ("springy QDD motors") and {len} a size in metres.
# ---------------------------------------------------------------------------
ARCHETYPES = {
    "hopper": {
        "plan": Q, "preset": "cheetah", "skills": ["walk", "jump"],
        "body": {"torsoLength": (0.32, 0.40), "torsoWidth": (0.20, 0.24), "torsoHeight": (0.11, 0.14),
                 "shoulderWidth": (0.16, 0.20), "hipOffset": (0.07, 0.09), "upperLeg": (0.22, 0.27),
                 "lowerLeg": (0.21, 0.26), "actuator": "qdd", "strength": (1.30, 1.45)},
        "strong": ("frog", "toad", "kangaroo", "rabbit", "bunny", "hare", "grasshopper", "cricket", "flea", "hopper",
                   "wallaby", "jerboa", "locust", "poison dart frog", "dart frog"),
        "weak": ("jump", "jumper", "jumping", "jumps", "hop", "hopping", "hops", "leap", "leaping", "bouncy", "bounce",
                 "bouncing", "spring", "springy", "pogo", "platforms"),
        "look": "frog", "names": ("Hoppy", "Boing", "Sir Leaps-a-Lot", "Ribbit-9", "Springle", "Pogo", "Kicker"),
        "pitch": ("a springy hopper with a light {len} m body and punchy legs on {act}, tuned for walk + jump",
                  "a pocket-rocket jumper: compact torso, coiled legs and {act}",
                  "a launch-ready hopper with short, powerful legs and {act}"),
    },
    "runner": {
        "plan": Q, "preset": "cheetah", "skills": ["walk"],
        "body": {"torsoLength": (0.46, 0.56), "torsoWidth": (0.18, 0.22), "torsoHeight": (0.15, 0.18),
                 "shoulderWidth": (0.15, 0.18), "hipOffset": (0.09, 0.11), "upperLeg": (0.24, 0.30),
                 "lowerLeg": (0.22, 0.28), "actuator": "qdd", "strength": (1.0, 1.15)},
        "strong": ("dog", "puppy", "pup", "doggo", "hound", "greyhound", "whippet", "husky", "corgi", "cat", "kitty",
                   "kitten", "cheetah", "leopard", "jaguar", "panther", "lion", "tiger", "fox", "wolf", "coyote", "lynx",
                   "dalmatian", "robot dog", "robodog"),
        "weak": ("fast", "faster", "speedy", "speed", "quick", "zoom", "zoomy", "race", "racer", "racing", "run",
                 "runner", "running", "sprint", "sprinter", "agile", "nimble"),
        "look": "cheetah", "names": ("Zoomer", "Dash", "Sprocket", "Comet", "Blitz", "Pounce", "Rover"),
        "pitch": ("a sleek sprinter with a {len} m body, quick legs and {act}",
                  "a nimble runner on Draft's Cheetah proportions with {act}",
                  "a zippy four-legger with a light frame and {act}, made for the race track"),
    },
    "tank": {
        "plan": Q, "preset": "bear", "skills": ["walk"],
        "body": {"torsoLength": (0.60, 0.70), "torsoWidth": (0.40, 0.48), "torsoHeight": (0.26, 0.32),
                 "shoulderWidth": (0.34, 0.38), "hipOffset": (0.15, 0.18), "upperLeg": (0.32, 0.40),
                 "lowerLeg": (0.30, 0.37), "actuator": "geared", "strength": (1.05, 1.25)},
        "strong": ("bear", "grizzly", "panda", "teddy", "tank", "mule", "ox", "rhino", "rhinoceros", "elephant", "hippo",
                   "bull", "yak", "buffalo", "bison", "mammoth", "cow", "gorilla", "boar", "badger", "triceratops",
                   "mech", "battle bot", "battlebot", "warbot", "bulldozer"),
        "weak": ("strong", "strength", "heavy", "sturdy", "tough", "carry", "haul", "pack mule", "armored", "armoured",
                 "powerful", "beefy", "huge", "giant"),
        "look": "bear", "names": ("Boulder", "Tonka", "Big Bruno", "Ironhide", "Mossback", "Haulmaster", "Bramble"),
        "pitch": ("a sturdy hauler with a wide {len} m body and {act}",
                  "a heavyweight on Draft's Bear proportions with {act}",
                  "a gentle giant with a broad stance and {act}, built to carry"),
    },
    "stilts": {
        "plan": Q, "preset": "giraffe", "skills": ["walk"],
        "body": {"torsoLength": (0.58, 0.66), "torsoWidth": (0.28, 0.34), "torsoHeight": (0.28, 0.33),
                 "shoulderWidth": (0.22, 0.26), "hipOffset": (0.16, 0.18), "upperLeg": (0.58, 0.69),
                 "lowerLeg": (0.52, 0.61), "actuator": "harmonic", "strength": (0.95, 1.1)},
        "strong": ("giraffe", "llama", "alpaca", "camel", "stilt", "stilts", "ostrich", "moose", "flamingo"),
        "weak": ("tall", "taller", "tallest", "long legs", "long-legged", "leggy", "lanky"),
        "look": "giraffe", "names": ("Stretch", "Skyline", "Lofty", "Longshanks", "Periscope", "Tallulah"),
        "pitch": ("a towering walker with very long legs and {act}",
                  "a tall one on Draft's Giraffe proportions with {act}",
                  "a sky-high stroller with long legs and {act}, slow and stately"),
    },
    "strider": {
        "plan": Q, "preset": "cheetah", "skills": ["walk"],
        "body": {"torsoLength": (0.54, 0.62), "torsoWidth": (0.22, 0.26), "torsoHeight": (0.18, 0.22),
                 "shoulderWidth": (0.18, 0.22), "hipOffset": (0.10, 0.13), "upperLeg": (0.36, 0.44),
                 "lowerLeg": (0.34, 0.42), "actuator": "qdd", "strength": (1.2, 1.35)},
        "strong": ("horse", "pony", "stallion", "mare", "mustang", "deer", "reindeer", "elk", "antelope", "gazelle",
                   "unicorn", "zebra", "donkey", "goat", "fawn", "stag"),
        "weak": ("gallop", "galloping", "trot", "trotting", "elegant", "graceful"),
        "look": "horse", "names": ("Gallop", "Trotter", "Starlight", "Clip-Clop", "Sundance", "Bramblehoof"),
        "pitch": ("a long-striding trotter with a {len} m body, tall legs and {act}",
                  "a graceful strider with longer legs and {act}",
                  "an elegant galloper with a lean frame and {act}"),
    },
    "critter": {
        "plan": Q, "preset": None, "skills": ["walk"],
        "body": {"torsoLength": (0.25, 0.30), "torsoWidth": (0.14, 0.17), "torsoHeight": (0.08, 0.10),
                 "shoulderWidth": (0.10, 0.12), "hipOffset": (0.06, 0.07), "upperLeg": (0.12, 0.15),
                 "lowerLeg": (0.12, 0.15), "actuator": "micro", "strength": (0.9, 1.1)},
        "strong": ("mouse", "mice", "hamster", "rat", "gerbil", "chipmunk", "squirrel", "guinea pig", "hedgehog",
                   "ferret", "shrew"),
        "weak": ("tiny", "mini", "little", "small", "pocket", "cute", "desk", "desktop", "palm-sized", "itty"),
        "look": "mouse", "names": ("Pip", "Nibbles", "Squeak", "Button", "Peanut", "Mochi", "Tiny Tim"),
        "pitch": ("a desk-sized scurrier with a {len} m body and {act}",
                  "a palm-sized critter with {act}",
                  "a tiny explorer with {act} and maximum cute"),
    },
    "lizard": {
        "plan": Q, "preset": "cheetah", "skills": ["walk"],
        "body": {"torsoLength": (0.60, 0.72), "torsoWidth": (0.22, 0.28), "torsoHeight": (0.10, 0.13),
                 "shoulderWidth": (0.22, 0.28), "hipOffset": (0.12, 0.16), "upperLeg": (0.15, 0.20),
                 "lowerLeg": (0.15, 0.19), "actuator": "qdd", "strength": (1.0, 1.2)},
        "strong": ("lizard", "gecko", "salamander", "newt", "iguana", "komodo", "chameleon", "crocodile", "croc",
                   "alligator", "gator", "dino", "dinosaur", "t-rex", "trex", "raptor", "dragon", "jade dragon",
                   "stegosaurus", "axolotl", "skink"),
        "weak": ("crawl", "crawler", "crawling", "slither", "sprawl", "low rider"),
        "look": "gecko", "names": ("Gecko-Go", "Scuttle", "Ziggy", "Sunbask", "Skitter"),
        "pitch": ("a low, long scuttler with a {len} m body slung between short legs and {act}",
                  "a ground-hugging lizard bot with a wide stance and {act}",
                  "a sprawling crawler with a long body, short legs and {act}"),
    },
    "turtle": {
        "plan": Q, "preset": "bear", "skills": ["walk"],
        "body": {"torsoLength": (0.40, 0.46), "torsoWidth": (0.34, 0.40), "torsoHeight": (0.13, 0.16),
                 "shoulderWidth": (0.28, 0.32), "hipOffset": (0.12, 0.14), "upperLeg": (0.15, 0.18),
                 "lowerLeg": (0.14, 0.17), "actuator": "geared", "strength": (1.0, 1.1)},
        "strong": ("turtle", "tortoise", "terrapin", "armadillo", "pangolin"),
        "weak": ("slow", "steady", "slowpoke"),
        "look": "turtle", "names": ("Shellby", "Mossy", "Old Tom", "Pebble", "Tank Turtle"),
        "pitch": ("a slow-and-steady shell walker with stubby legs and {act}",
                  "a wide, low tortoise bot with {act}",
                  "an unstoppable little turtle with a broad body, short legs and {act}"),
    },
    "insect": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 6, "arrangement": "bilateral", "bodyRadius": (0.10, 0.14), "bodyAspect": (1.5, 1.9),
                 "coxa": (0.05, 0.07), "upperLeg": (0.13, 0.17), "lowerLeg": (0.15, 0.20), "actuator": "qdd",
                 "strength": (1.0, 1.2)},
        "strong": ("beetle", "ant", "insect", "bug", "cockroach", "roach", "ladybug", "ladybird", "mantis", "bee",
                   "bumblebee", "wasp", "hornet", "firefly", "weevil", "scarab", "termite", "butterfly", "moth",
                   "hexapod", "stick insect", "stag beetle", "rhino beetle"),
        "weak": ("six legs", "6 legs", "six-legged", "6-legged", "creepy", "crawly", "skitter", "skittering"),
        "look": "beetle", "names": ("Clicker", "Scarab-7", "Buzz", "Hexa", "Beetlebot", "Skitterbug"),
        "pitch": ("a six-legged scuttler with legs in three pairs along a {len} m body and {act}",
                  "a hexapod bug with an elongated body, tripod-gait-ready legs and {act}",
                  "a busy six-legger with {act}"),
    },
    "spider": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 8, "arrangement": "radial", "bodyRadius": (0.12, 0.16), "bodyAspect": (1.0, 1.15),
                 "coxa": (0.06, 0.08), "upperLeg": (0.20, 0.26), "lowerLeg": (0.24, 0.30), "actuator": "qdd",
                 "strength": (1.05, 1.2)},
        "strong": ("spider", "tarantula", "octopus", "octopi", "arachnid", "daddy long legs", "black widow",
                   "octopod", "kraken", "squid"),
        "weak": ("eight legs", "8 legs", "eight-legged", "8-legged", "creepy crawly", "spooky legs"),
        "look": "spider", "names": ("Spindle", "Webster", "Itsy", "Arachne", "Lady Eight", "Octo-Tread"),
        "pitch": ("an eight-legged radial walker with legs all around a {len} m hub and {act}",
                  "a spidery eight-legger with long knees and {act}",
                  "an octo-walker with eight legs fanned around a round body and {act}"),
    },
    "crab": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 8, "arrangement": "bilateral", "bodyRadius": (0.14, 0.18), "bodyAspect": (1.0, 1.2),
                 "coxa": (0.06, 0.08), "upperLeg": (0.14, 0.18), "lowerLeg": (0.16, 0.20), "actuator": "qdd",
                 "strength": (1.2, 1.35)},
        "strong": ("crab", "lobster", "crayfish", "scorpion", "hermit crab", "shrimp", "krill"),
        "weak": ("sideways", "pinchy", "claws"),
        "look": "crab", "names": ("Pinchy", "Sidestep", "Clawdia", "Shelldon", "Crusty"),
        "pitch": ("a wide, armoured eight-legger with legs in four pairs and {act}",
                  "a crab bot with a chunky body, eight paired legs and {act}",
                  "a sideways shuffler with eight paired legs and {act}"),
    },
    "centipede": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 8, "arrangement": "bilateral", "bodyRadius": (0.09, 0.12), "bodyAspect": (2.0, 2.2),
                 "coxa": (0.04, 0.06), "upperLeg": (0.10, 0.13), "lowerLeg": (0.12, 0.15), "actuator": "micro",
                 "strength": (1.0, 1.1)},
        "strong": ("centipede", "millipede", "caterpillar", "inchworm", "worm", "snake", "dachshund"),
        "weak": ("many legs", "lots of legs", "most legs", "all the legs", "long body", "wiggly"),
        "look": "caterpillar", "names": ("Wiggles", "Choo-Choo", "Millie", "Noodle", "Caterpillow"),
        "pitch": ("a long, low eight-legger with a stretched {len} m body and {act}",
                  "a wiggly walker with legs in four pairs along a long body and {act}",
                  "a noodle on legs: long body, eight short legs and {act}"),
    },
    "flower": {
        "plan": M, "preset": "flower", "skills": ["walk"],
        "body": {"legCount": 6, "arrangement": "radial", "bodyRadius": (0.14, 0.15), "bodyAspect": 1.0,
                 "coxa": (0.085, 0.095), "upperLeg": (0.17, 0.19), "lowerLeg": (0.21, 0.23)},
        "strong": ("flower", "daisy", "sunflower", "blossom", "petal", "plant", "tulip", "lotus", "rose", "sakura",
                   "bloom", "succulent", "mushroom", "toadstool"),
        "weak": ("radial", "circular", "symmetric", "symmetrical"),
        "look": "flower", "names": ("Petal", "Bloom", "Daisy Walker", "Sunny", "Blossom"),
        "pitch": ("a six-petal radial crawler on the Flower's proportions",
                  "a blooming radial walker with six legs around a round hub",
                  "a garden crawler built from the Flower preset"),
    },
    "starfish": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 5, "arrangement": "radial", "bodyRadius": (0.11, 0.14), "bodyAspect": 1.0,
                 "coxa": (0.05, 0.07), "upperLeg": (0.15, 0.19), "lowerLeg": (0.17, 0.21), "actuator": "micro",
                 "strength": (1.0, 1.15)},
        "strong": ("starfish", "sea star", "star fish", "pentapod"),
        "weak": ("five legs", "5 legs", "five-legged", "5-legged", "star-shaped"),
        "look": "starfish", "names": ("Starla", "Patch", "Five-Step", "Twinkle", "Coral"),
        "pitch": ("a five-armed radial walker with {act}",
                  "a starfish bot with five legs evenly around a round hub and {act}",
                  "a five-pointed crawler with {act}"),
    },
    "jellyfish": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 8, "arrangement": "radial", "bodyRadius": (0.16, 0.20), "bodyAspect": 1.0,
                 "coxa": (0.04, 0.06), "upperLeg": (0.12, 0.15), "lowerLeg": (0.20, 0.25), "actuator": "micro",
                 "strength": (0.95, 1.1)},
        "strong": ("jellyfish", "jelly", "medusa", "anemone"),
        "weak": ("floaty", "dreamy", "wobbly"),
        "look": "jellyfish", "names": ("Jiggle", "Drift", "Glowbe", "Wobble"),
        "pitch": ("a dreamy eight-legged radial walker under a big dome, with {act}",
                  "a jelly bot with a wide round hub, eight dangly legs and {act}",
                  "a glowing drifter on eight long legs with {act}"),
    },
    "tripod": {
        "plan": M, "preset": None, "skills": ["walk"],
        "body": {"legCount": 3, "arrangement": "radial", "bodyRadius": (0.14, 0.18), "bodyAspect": 1.0,
                 "coxa": (0.08, 0.10), "upperLeg": (0.24, 0.29), "lowerLeg": (0.28, 0.33), "actuator": "qdd",
                 "strength": (1.25, 1.4)},
        "strong": ("tripod", "alien", "martian", "ufo", "extraterrestrial", "war of the worlds"),
        "weak": ("three legs", "3 legs", "three-legged", "3-legged"),
        "look": "alien", "names": ("Zorp", "Trip", "Tri-Stomp", "Martian Mo", "Triplet"),
        "pitch": ("a three-legged alien walker with long legs and {act}",
                  "a tripod with three tall legs around a round hub and {act}",
                  "a wobbly-but-proud three-legger with {act}"),
    },
}

# keyword -> look theme (when the keyword is not itself a theme name)
KEYWORD_LOOKS = {
    "rabbit": "bunny", "hare": "bunny", "wallaby": "kangaroo", "locust": "grasshopper", "cricket": "grasshopper",
    "flea": "grasshopper", "hopper": "frog", "jerboa": "mouse", "dart frog": "poison dart frog",
    "puppy": "dog", "pup": "dog", "doggo": "dog", "hound": "dog", "greyhound": "dog", "whippet": "dog", "corgi": "dog",
    "husky": "wolf", "coyote": "wolf", "kitty": "cat", "kitten": "cat", "lynx": "cat", "leopard": "cheetah",
    "jaguar": "cheetah", "robot dog": "robot", "robodog": "robot",
    "grizzly": "bear", "teddy": "bear", "mule": "horse", "ox": "cow", "bull": "cow", "yak": "cow", "buffalo": "cow",
    "bison": "bear", "hippo": "elephant", "mammoth": "elephant", "gorilla": "bear", "boar": "bear", "badger": "panda",
    "triceratops": "rhino", "rhinoceros": "rhino", "mech": "robot", "battle bot": "robot", "battlebot": "robot",
    "warbot": "robot", "bulldozer": "firetruck",
    "alpaca": "llama", "camel": "llama", "stilt": "classic", "stilts": "classic", "ostrich": "flamingo", "moose": "deer",
    "pony": "horse", "stallion": "horse", "mare": "horse", "mustang": "horse", "reindeer": "deer", "elk": "deer",
    "antelope": "deer", "gazelle": "deer", "donkey": "horse", "goat": "deer", "fawn": "deer", "stag": "deer",
    "mice": "mouse", "rat": "mouse", "gerbil": "hamster", "chipmunk": "squirrel", "guinea pig": "hamster",
    "hedgehog": "hamster", "ferret": "squirrel", "shrew": "mouse",
    "lizard": "gecko", "salamander": "gecko", "newt": "gecko", "iguana": "gecko", "komodo": "gecko", "skink": "gecko",
    "axolotl": "sakura", "croc": "crocodile", "alligator": "crocodile", "gator": "crocodile", "dinosaur": "dino",
    "t-rex": "dino", "trex": "dino", "raptor": "dino", "stegosaurus": "dino",
    "tortoise": "turtle", "terrapin": "turtle", "armadillo": "rhino", "pangolin": "crocodile",
    "insect": "beetle", "bug": "beetle", "cockroach": "beetle", "roach": "beetle", "ladybird": "ladybug",
    "bumblebee": "bee", "wasp": "bee", "hornet": "bee", "weevil": "beetle", "termite": "ant", "moth": "butterfly",
    "hexapod": "robot", "stick insect": "mantis", "stag beetle": "beetle", "rhino beetle": "beetle",
    "octopi": "octopus", "arachnid": "spider", "daddy long legs": "spider", "black widow": "spider",
    "octopod": "robot", "kraken": "octopus", "squid": "octopus",
    "lobster": "crab", "crayfish": "crab", "hermit crab": "crab", "shrimp": "crab", "krill": "crab",
    "millipede": "caterpillar", "centipede": "caterpillar", "inchworm": "caterpillar", "worm": "caterpillar",
    "snake": "caterpillar", "dachshund": "dog",
    "daisy": "flower", "blossom": "sakura", "petal": "flower", "plant": "flower", "tulip": "flower", "lotus": "sakura",
    "rose": "sakura", "bloom": "flower", "succulent": "flower", "toadstool": "mushroom",
    "sea star": "starfish", "star fish": "starfish", "pentapod": "starfish",
    "jelly": "jellyfish", "medusa": "jellyfish", "anemone": "jellyfish",
    "tripod": "alien", "martian": "alien", "ufo": "alien", "extraterrestrial": "alien", "war of the worlds": "alien",
}

# Flavour for well-known creatures: names and pitches that fit the animal.
KEYWORD_FLAVOUR = {
    ("frog", "toad"): (("Ribbit", "Croaky", "Lily-Pad", "Hoppy"),
                       "a bouncy frog bot with a light {len} m body and coiled legs on {act}, tuned for walk + jump"),
    ("kangaroo", "wallaby"): (("Joey", "Boxer", "Roo-Bot"), "a boxing-ready kangaroo bot with springy legs and {act}, tuned to hop"),
    ("rabbit", "bunny", "hare"): (("Thumper", "Clover", "Hopscotch"), "a bunny bot with quick, springy legs and {act}, tuned to hop"),
    ("dragon",): (("Ember", "Scorch", "Smaug Jr."), "a dragon walker with a long body, strong legs and {act}"),
    ("jade dragon",): (("Jade", "Lucky Lung", "Emerald"), "a jade dragon walker with a long body, strong legs and {act}"),
    ("dino", "dinosaur", "t-rex", "trex", "raptor", "stegosaurus"): (("Rex", "Stompy", "Dino-Mite"),
                                                                    "a stompy dino bot with a long body and {act}"),
    ("crocodile", "croc", "alligator", "gator"): (("Chomper", "Snappy", "Captain Teeth"),
                                                  "a low, armoured croc bot with short legs and {act}"),
    ("octopus", "squid", "kraken", "octopi"): (("Inky", "Octavia", "Squishy"), "an eight-armed octo-walker with {act}"),
    ("unicorn",): (("Sparkle", "Stardust", "Glimmer"), "a magical trotter with long legs and {act}"),
    ("ladybug", "ladybird"): (("Dotty", "Lady Spot", "Scarlet"), "a six-legged ladybug bot with {act}"),
    ("bee", "bumblebee"): (("Buzzby", "Honey", "Bumble"), "a six-legged bumble bot with {act}"),
    ("ant",): (("Antonio", "Antsy", "Colony"), "a hard-working six-legged ant bot with {act}"),
    ("panda",): (("Bao", "Bamboo", "Pandy"), "a cuddly heavyweight panda bot with {act}"),
    ("tiger",): (("Stripes", "Raja", "Tigger-Bot"), "a big-cat prowler with {act}"),
    ("lion",): (("Leo", "Roary", "Mane Event"), "a big-cat prowler with {act}"),
    ("cat", "kitty", "kitten"): (("Whiskers", "Mittens", "Pounce"), "a curious cat bot with soft-footed legs and {act}"),
    ("dog", "puppy", "pup", "doggo", "hound", "corgi"): (("Rover", "Biscuit", "Sparky"), "a loyal pup bot with {act}"),
    ("fox",): (("Rusty", "Foxtrot", "Kit"), "a quick fox bot with {act}"),
    ("wolf", "husky"): (("Shadow", "Luna", "Howler"), "a pack-runner wolf bot with {act}"),
    ("spider", "tarantula"): (("Spindle", "Webster", "Itsy"), "an eight-legged spider bot with long knees and {act}"),
    ("mouse", "mice", "rat"): (("Squeak", "Pip", "Nibbles"), "a desk-sized mouse bot with {act}"),
    ("crab", "lobster"): (("Pinchy", "Clawdia", "Sidestep"), "a sideways-shuffling crab bot with eight paired legs and {act}"),
    ("giraffe",): (("Stretch", "Lofty", "Spots"), "a towering giraffe walker with very long legs and {act}"),
    ("turtle", "tortoise"): (("Shellby", "Mossy", "Pebble"), "a slow-and-steady tortoise bot with stubby legs and {act}"),
    ("beetle", "stag beetle", "rhino beetle", "scarab"): (("Clicker", "Scarab-7", "Beetlebot"), "a six-legged beetle bot with {act}"),
    ("elephant", "mammoth"): (("Peanut", "Trunk-ster", "Big Ears"), "a gentle-giant elephant bot with {act}"),
    ("horse", "pony"): (("Gallop", "Clip-Clop", "Biscuit"), "a long-striding pony bot with {act}"),
}

ACTUATOR_WORDS = {"qdd": "springy QDD motors", "geared": "strong geared motors",
                  "harmonic": "super-strong harmonic drives", "micro": "tiny micro servos"}
NUMBER_WORDS = {"three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "3": 3, "4": 4, "5": 5,
                "6": 6, "7": 7, "8": 8}
COLOR_WORDS = sorted(NAMED_COLORS, key=len, reverse=True)
ACCESSORY_WORDS = {"antenna": "antennae", "antennae": "antennae", "antennas": "antennae", "horn": "horns",
                   "horns": "horns", "antlers": "horns", "ears": "ears", "ear": "ears", "tail": "tail",
                   "spikes": "spikes", "spiky": "spikes", "spines": "spikes", "fin": "fin", "fins": "fin",
                   "wings": "wings", "wing": "wings", "crown": "crown", "tiara": "crown", "hat": "hat",
                   "top hat": "hat", "cap": "hat", "bow": "bow", "bowtie": "bow", "bow tie": "bow",
                   "ribbon": "bow", "propeller": "propeller", "backpack": "backpack", "jetpack": "backpack"}
ACCESSORY_PHRASES = {"antennae": "antennae", "horns": "horns", "ears": "ears", "tail": "a tail", "spikes": "spikes",
                     "fin": "a fin", "wings": "wings", "crown": "a crown", "hat": "a hat", "bow": "a bow",
                     "flower": "a flower", "propeller": "a propeller", "backpack": "a backpack"}
SHELL_WORDS = {"beetle shell": "beetle", "turtle shell": "turtle", "shell": "dome", "dome": "dome",
               "petals": "petals", "armor": "armor", "armour": "armor", "armored": "armor", "armoured": "armor",
               "fluffy": "fluffy", "furry": "fluffy", "fur": "fluffy", "fuzzy": "fluffy", "saddle": "saddle"}
CHIP_THEMES = ("ladybug", "tiger", "lava", "candy", "jade dragon", "astronaut", "ice", "panda", "robot", "galaxy",
               "neon", "bee", "unicorn", "steampunk", "sakura", "dalmatian", "dragon", "alien", "chrome")
# Materials and moods read badly as "one lava coming up".
MASS_THEMES = {"classic", "lava", "ice", "candy", "galaxy", "neon", "royal", "chrome", "pumpkin", "camo", "rainbow",
               "watermelon", "banana", "pastel", "toy", "wooden", "steampunk", "sakura", "ocean", "strawberry"}
LOOK_SURPRISE_CHIP = "Surprise me with a look"


def _norm(text):
    text = (text or "").lower().replace("’", "'").replace("‘", "'")
    text = re.sub(r"[^a-z0-9#'\- ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


@functools.lru_cache(maxsize=8192)
def _word_pattern(phrase):
    # Hundreds of keyword patterns overflow re's own 512-entry cache.
    return re.compile(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?:s|es)?(?![a-z0-9])")


@functools.lru_cache(maxsize=1024)
def _compiled(pattern):
    return re.compile(pattern)


def _span(text, phrase):
    """(start, end) of phrase as whole words (plural-tolerant), or None."""
    match = _word_pattern(phrase).search(text)
    return (match.start(), match.end()) if match else None


def _find(text, phrase):
    span = _span(text, phrase)
    return span[0] if span else -1


def _has(text, *phrases):
    return any(_find(text, phrase) >= 0 for phrase in phrases)


def _re(text, pattern):
    return _compiled(pattern).search(text) is not None


class Intent:
    """What one user message asks for."""

    def __init__(self, raw):
        self.raw = raw or ""
        self.name, name_span = _detect_name(self.raw)
        stripped = self.raw[:name_span[0]] + " " + self.raw[name_span[1]:] if name_span else self.raw
        t = self.text = _norm(stripped)
        self.archetype, self.arch_keyword, self.arch_strong, arch_span = _detect_archetype(t)
        self.look_words = _re(t, r"\b(look|looks|looking|paint|painted|repaint|colou?r|colou?rs|colou?red|dress|dressed|"
                                 r"skin|style|styled|restyle|theme|themed|costume|outfit|decorate|makeover|appearance|wear|"
                                 r"paint ?job|finish)\b")
        self.it_ref = _re(t, r"\b(make|turn|change|transform|paint|dress|convert)\s+(it|him|her|them|this|that|my (robot|creature|bot)|"
                             r"the (robot|creature|bot))\b")
        self.theme, theme_span, self.style_target = _detect_theme(t, self.look_words or self.it_ref)
        self.new_words = _re(t, r"\b(make|build|design|create|draw|sketch|imagine|invent|want|wanna|like|give me|new|"
                                r"how about|what about|let's do|lets do|let's try|lets try|instead|another|different|"
                                r"start over|from scratch|can you|could you|i need|show me)\b")
        self.another = _re(t, r"\b(another one|another|different one|different body|different design|something different|"
                              r"something else|new one|one more|again)\b") and not self.archetype
        self.train_q = _re(t, r"\b(what (does|is) training|how does training|explain training|what does the trainer|"
                              r"how (do|does) (it|they) learn)\b")
        self.greeting = _re(t, r"^(hi|hello|hey|yo|hiya|howdy|greetings|good (morning|afternoon|evening))\b")
        self.thanks = _re(t, r"\b(thanks|thank you|thx|awesome|cool|nice|great|love it|perfect|amazing)\b")
        self.yes = _re(t, r"^(yes|yeah|yep|yup|sure|ok|okay|do it|go for it|please do|sounds good|let's do it|lets do it)\b")
        self.no = _re(t, r"^(no|nope|nah|not really|never mind|nevermind)\b")
        self.help = _re(t, r"\b(help|what can you do|how does (this|it) work|how do i|what do i do|instructions|tutorial)\b")
        self.draft_q = _re(t, r"\b(what('s| is) draft|how does draft|who made draft|draft paper|about draft|explain draft)\b") or \
            t in ("draft", "draft?")
        match = re.search(r"\bwhat('s| is| are| does)\s+(a |an |the )?(qdd|quasi direct drive|harmonic( drive)?|geared|micro|"
                          r"actuators?|motors?|strength|feasibility)\b", t)
        self.term_q = match.group(3) if match else None
        self.why = _re(t, r"\bwhy\b")
        self.fix = _re(t, r"\b(fix|repair|solve|try again|retry|revise|what now|make it work|buildable|feasible|help it pass)\b")
        self.surprise = _re(t, r"\b(surprise me|random|anything|you choose|you pick|dealer's choice|whatever|idk|"
                               r"i don't know|i dont know|dunno|up to you|your choice|wild card)\b")
        self.vague = _re(t, r"\b(robot|bot|creature|thing|something|machine|animal|critter|monster|pet|buddy)\b") and \
            _re(t, r"\b(make|build|design|create|want|need|give me|draw|have|get)\b")
        self.train = _re(t, r"\b(train|training|teach|learn|practice|practise)\b") or \
            _re(t, r"\b(make|get|teach) (it|him|her) (to )?(walk|walking|move|moving)\b")
        self.play = _re(t, r"\b(let's play|lets play|play with|go play|play time|playtime|playground|the park|go to the park|"
                           r"take it for a (spin|walk)|drive it|test drive|explore)\b") or t in ("play", "play!")
        self.build = _re(t, r"\b(build it|compile|generate it|draft it|make it real|print it|run draft)\b")
        # Body modifiers
        self.size = 1 if _re(t, r"\b(bigger|larger|huge|giant|massive|enormous|big|large|chonky|jumbo)\b") else \
            (-1 if _re(t, r"\b(smaller|tiny|mini|little|small|compact|pocket|teeny|wee)\b") else 0)
        self.legs = 1 if _re(t, r"\b(longer legs?|long legs?|leggy|taller|lanky)\b") else \
            (-1 if _re(t, r"\b(shorter legs?|short legs?|stubby|squat|shorter|lower|low rider)\b") else 0)
        self.leg_count = _detect_leg_count(t)
        self.leg_delta = 2 if _re(t, r"\b(more legs|extra legs|add legs|add two legs)\b") else \
            (-2 if _re(t, r"\b(fewer legs|less legs|remove legs|lose two legs)\b") else 0)
        self.no_jump = _re(t, r"\b(no jump|no jumping|without jump|without jumping|don't jump|dont jump|stop jumping|remove (the )?jump|"
                              r"no need to jump|skip (the )?jump)\b")
        self.jump = not self.no_jump and _re(t, r"\b(jump|jumps|jumping|jumper|hop|hops|hopping|leap|leaps|leaping|bounce|bouncy|"
                                                r"springy|pounce|platforms?)\b")
        self.fast = _re(t, r"\b(fast|faster|speedy|quick|quicker|zoom|zoomy|agile|nimble|speedier)\b")
        self.strength = 1 if _re(t, r"\b(stronger|more powerful|more power|beefier|beefy|muscular|powerful|strong)\b") else \
            (-1 if _re(t, r"\b(weaker|gentler|less power|softer)\b") else 0)
        self.heavy = 1 if _re(t, r"\b(heavier|sturdier|sturdy|tougher|tough|robust|tank-like)\b") else \
            (-1 if _re(t, r"\b(lighter|lightweight|light weight|featherweight)\b") else 0)
        self.body_len = 1 if _re(t, r"\b(longer body|long body|stretch|stretched|elongate|elongated|longer torso)\b") else \
            (-1 if _re(t, r"\b(shorter body|short body|compact body|shorter torso|stubby body)\b") else 0)
        self.width = 1 if _re(t, r"\b(wider|broader|wide body|wider stance|wide stance)\b") else \
            (-1 if _re(t, r"\b(narrower|slimmer|thinner|skinnier|narrow)\b") else 0)
        self.arrangement = "radial" if _re(t, r"\b(radial|radially|in a circle|star-shaped|all around)\b") else \
            ("bilateral" if _re(t, r"\b(bilateral|in pairs|insect-like|along the body|left and right)\b") else None)
        self.actuator = None
        if not self.term_q:
            for word, family in (("quasi direct drive", "qdd"), ("qdd", "qdd"), ("harmonic", "harmonic"),
                                 ("strain wave", "harmonic"), ("geared", "geared"), ("planetary", "geared"),
                                 ("gearbox", "geared"), ("micro servo", "micro"), ("servo", "micro"), ("micro", "micro")):
                if _has(t, word):
                    self.actuator = family
                    break
        # Look modifiers. Colour words inside a theme or creature name ("jade
        # dragon", "black cat") belong to that name, not to the palette.
        self.colors = _detect_colors(t, [s for s in (theme_span, arch_span) if s])
        self.finish = next((f for words, f in ((("shiny", "glossy", "gloss", "polished"), "gloss"),
                                               (("matte", "matt", "flat colour", "flat color"), "matte"),
                                               (("satin",), "satin"), (("metallic", "machined"), "metal"),
                                               (("glow", "glowing", "glow in the dark", "luminous", "light up"), "glow"),
                                               (("cartoon", "toon", "cel shaded"), "toon"))
                            if _has(t, *words)), None)
        self.pattern = next((p for words, p in ((("spots", "spotted", "spotty", "polka", "dots", "dotted"), "spots"),
                                                (("stripes", "striped", "stripy"), "stripes"),
                                                (("bands", "banded", "rings"), "bands"),
                                                (("gradient", "ombre", "fade"), "gradient"),
                                                (("checker", "checkered", "chequered", "checkerboard"), "checker"),
                                                (("camo", "camouflage"), "camo"),
                                                (("panels", "paneled", "plated", "plating"), "panels"),
                                                (("no pattern", "plain", "solid colour", "solid color"), "none"))
                             if _has(t, *words)), None)
        self.eyes = next((e for words, e in ((("cute eyes", "big eyes", "kawaii eyes", "anime eyes"), "cute"),
                                             (("visor",), "visor"), (("one eye", "cyclops", "single eye"), "cyclops"),
                                             (("sleepy", "drowsy"), "sleepy"),
                                             (("bug eyes", "compound eyes", "insect eyes"), "compound"),
                                             (("no eyes", "eyeless"), "none"), (("round eyes",), "round"))
                          if _has(t, *words)), None)
        self.remove_accessories = set()
        self.add_accessories = []
        for word, kind in ACCESSORY_WORDS.items():
            pos = _find(t, word)
            if pos < 0:
                continue
            before = t[max(0, pos - 16):pos]
            if re.search(r"\b(no|remove|without|lose|drop|take off)\b[a-z ]*$", before):
                self.remove_accessories.add(kind)
            elif kind not in self.add_accessories:
                self.add_accessories.append(kind)
        if _re(t, r"\b(add|with|give it|put) (a |some )?flower\b") and "flower" not in self.add_accessories:
            self.add_accessories.append("flower")
        self.shell = None
        for word, kind in SHELL_WORDS.items():
            if _has(t, word):
                self.shell = "none" if _re(t, r"\b(no|remove|without) (the )?" + re.escape(word)) else kind
                break
        self.feet = next((f for words, f in ((("paws", "paw"), "paw"), (("hooves", "hoof"), "hoof"),
                                             (("foot pads", "pads"), "pad"), (("ball feet", "round feet"), "ball"))
                          if _has(t, *words)), None)
        self.limb_style = next((s for words, s in ((("chunky legs", "thick legs", "chonky legs"), "chunky"),
                                                   (("sleek legs", "slim legs", "thin legs"), "sleek"),
                                                   (("bony legs", "skeleton legs", "skeletal"), "bones"))
                                if _has(t, *words)), None)

    @property
    def body_mods(self):
        return bool(self.size or self.legs or self.leg_count or self.leg_delta or self.jump or self.no_jump or
                    self.fast or self.strength or self.heavy or self.body_len or self.width or self.arrangement or
                    self.actuator)

    @property
    def look_mods(self):
        return bool(self.colors or self.finish or self.pattern or self.eyes or self.add_accessories or
                    self.remove_accessories or self.shell or self.feet or self.limb_style)


def _detect_archetype(text):
    best = (None, None, False, None)
    for strong in (True, False):
        for key, spec in ARCHETYPES.items():
            for word in spec["strong" if strong else "weak"]:
                span = _span(text, word)
                # Earliest mention wins; longer phrases win ties ("jade dragon" over "dragon").
                if span and (best[3] is None or span[0] < best[3][0] or
                             (span[0] == best[3][0] and len(word) > len(best[1] or ""))):
                    best = (key, word, strong, span)
        if best[0]:
            return best
    return None, None, False, None


LOOK_TARGET = re.compile(r"\b(?:look|looks|looking|paint|painted|repaint|dress|dressed|style|styled|skin|skinned|"
                         r"colou?r(?:ed)?|theme(?:d)?|costume|outfit|restyle|wear|decorate|decorated)\s+"
                         r"(?:it\s+|him\s+|her\s+|this\s+|them\s+)?(?:up\s+)?(?:like|as|in)?\s*(?:a|an|the|some)?\s*"
                         r"([a-z][a-z' \-]{1,40})")
IT_TARGET = re.compile(r"\b(?:make|turn|change|transform|convert)\s+(?:it|him|her|this|that|them)\s+"
                       r"(?P<lead>into\s+|look\s+like\s+|like\s+)?(?P<article>(?:a|an|the|some)\s+)?([a-z][a-z' \-]{1,40})")
STYLE_TARGET = re.compile(r"([a-z][a-z' \-]{1,30}?)\s+(?:skin|style|theme|colou?rs|paint ?job|costume|outfit|look|mode|edition)\b")
STOP_WORDS = {"it", "a", "an", "the", "like", "look", "please", "more", "some", "too", "so", "really", "very"}


def _detect_theme(text, look_context):
    """Return (theme, absolute_span, requested_words). The noun after 'look
    like / paint it as / turn it into' wins; then '<x> style'; then any
    theme word (everyday words only count with a look context)."""
    regions = []
    requested = None
    for pattern in (LOOK_TARGET, IT_TARGET):
        target = pattern.search(text)
        if target:
            group = target.lastindex  # the noun phrase is always the last group
            regions.append((target.start(group), target.group(group), True))
            nounish = pattern is LOOK_TARGET or target.group("lead") or target.group("article")
            if requested is None and nounish:
                words = [w for w in target.group(group).split() if w not in STOP_WORDS][:3]
                requested = " ".join(words) or None
    style = STYLE_TARGET.search(text)
    if style:
        regions.append((style.start(1), style.group(1), True))
    regions.append((0, text, look_context))
    for offset, region, context in regions:
        best = None
        for alias, key in L.ALIASES.items():
            if alias in L.GENERIC_ALIASES and not context:
                continue
            span = _span(region, alias)
            if span and (best is None or span[0] < best[1][0] or (span[0] == best[1][0] and len(alias) > len(best[2]))):
                best = (key, span, alias)
        if best:
            return best[0], (offset + best[1][0], offset + best[1][1]), requested
    return None, None, requested


def _detect_leg_count(text):
    match = re.search(r"\b(three|four|five|six|seven|eight|[3-8])[ -]?(legs?|legged|leg)\b", text)
    if match:
        return NUMBER_WORDS[match.group(1)]
    if _has(text, "hexapod"):
        return 6
    if _has(text, "octopod"):
        return 8
    if _has(text, "quadruped", "four-legged"):
        return 4
    return None


def _detect_name(raw):
    match = re.search(r"\b(?:call|name|rename)\s+(?:it|him|her|them|this one|this)?\s*(?:to\s+|as\s+)?[\"'“]?"
                      r"([A-Za-z0-9][A-Za-z0-9 '\-.]{0,38}?)[\"'”]?\s*(?:[.!?,]|$)", raw or "", flags=re.I)
    if not match:
        return None, None
    name = match.group(1).strip(" .'-")
    if not name or name.lower() in ("it", "something", "anything"):
        return None, None
    return " ".join(w[:1].upper() + w[1:] for w in name.split())[:40], match.span()


def _detect_colors(text, exclude):
    found = []
    for match in re.finditer(r"#[0-9a-f]{6}\b", text):
        found.append((match.start(), match.group(0)))
    for word in COLOR_WORDS:
        for match in _compiled(r"(?<![a-z])" + re.escape(word) + r"(?![a-z])").finditer(text):
            if any(start <= match.start() < end for start, end in exclude):
                continue
            if any(start <= match.start() < start + 7 for start, _ in found):
                continue
            found.append((match.start(), NAMED_COLORS[word]))
    found.sort()
    colors = []
    for _, color in found:
        if color not in colors:
            colors.append(color)
    return colors[:3]


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class StateView:
    """Defensive read of the client's state (designs already schema-repaired)."""

    def __init__(self, state, design, look):
        state = state if isinstance(state, dict) else {}
        body = state.get("body") if isinstance(state.get("body"), dict) else {}
        self.design, self.look = design, look
        self.body = body
        self.body_id = body.get("id") if isinstance(body.get("id"), str) else None
        mass = body.get("massKg")
        self.mass = mass if type(mass) in (int, float) and 0 < mass < 10_000 else None
        feasibility = body.get("feasibility") if isinstance(body.get("feasibility"), dict) else {}
        passed = feasibility.get("passed")
        self.passed = passed if isinstance(passed, bool) else None
        messages = []
        for key in ("reasons", "errors", "failures", "warnings"):
            value = feasibility.get(key)
            if isinstance(value, str):
                value = [value]
            for item in value if isinstance(value, list) else []:
                if isinstance(item, str) and item.strip():
                    messages.append(item.strip()[:200])
        if isinstance(body.get("error"), str) and body["error"].strip():
            messages.insert(0, body["error"].strip()[:300])
            if self.passed is None:
                self.passed = False
        self.feasibility_messages = messages[:6]
        trainability = body.get("trainability") or state.get("trainability")
        notes = []
        if isinstance(trainability, dict):
            trainability = trainability.get("warnings") or trainability.get("messages") or []
        if isinstance(trainability, str):
            trainability = [trainability]
        for item in trainability if isinstance(trainability, list) else []:
            if isinstance(item, str) and item.strip():
                notes.append(item.strip()[:200])
        self.trainability = notes[:4]
        self.policies = {}
        policies = state.get("policies") if isinstance(state.get("policies"), dict) else {}
        for skill in ("walk", "jump"):
            self.policies[skill] = _policy_status(policies.get(skill))

    @property
    def failed(self):
        return self.passed is False

    def ready(self, skill):
        return self.policies.get(skill) == "ready"


def _policy_status(value):
    if value is True:
        return "ready"
    if isinstance(value, str):
        value = value.lower()
        if value in ("ready", "validated", "pass", "passed", "trained", "ok"):
            return "ready"
        if value in ("training", "queued", "running", "pending"):
            return "training"
        if value in ("failed", "error", "fail"):
            return "failed"
        return "none"
    if isinstance(value, dict):
        if value.get("ready") is True or value.get("pass") is True or value.get("validated") is True:
            return "ready"
        return _policy_status(value.get("status")) if value.get("status") else "none"
    return "none"


# ---------------------------------------------------------------------------
# Designer
# ---------------------------------------------------------------------------

class OfflineDesigner:
    def __init__(self, store):
        self.store = store

    def respond(self, messages, view):
        """Return {reply, design?, look?, train?, play?, suggestions}."""
        messages = messages or []
        last_role = messages[-1]["role"] if messages else None
        user_texts = [m["content"] for m in messages if m["role"] == "user"]
        last_user = user_texts[-1] if user_texts and last_role == "user" else ""
        seed = hashlib.sha256(json.dumps([last_user, len(messages), (view.design or {}).get("name")],
                                         sort_keys=True).encode()).digest()
        rng = random.Random(int.from_bytes(seed[:8], "big"))
        intent = Intent(last_user)
        first_design = not any(DRAFT_LINE[:30] in m["content"] for m in messages if m["role"] == "assistant")
        ctx = {"rng": rng, "view": view, "intent": intent, "first": first_design, "messages": messages}

        # "yes" accepts the question Tinker just asked: re-read that question.
        if intent.yes and len(messages) >= 2 and messages[-2]["role"] == "assistant":
            question = _last_question(messages[-2]["content"])
            if question:
                offered = Intent(question)
                if offered.archetype or offered.theme or offered.body_mods or offered.look_mods:
                    ctx["intent"] = intent = offered

        actionable = intent.archetype or intent.theme or intent.body_mods or intent.look_mods
        if view.failed and view.design and (not last_user or intent.fix or intent.why or not actionable):
            return self._revise_for_failure(ctx)
        if intent.train_q:
            return self._explain_training(ctx)
        if intent.train and not (intent.archetype and intent.new_words):
            return self._train(ctx)
        if intent.play:
            return self._play(ctx)
        if intent.draft_q:
            return self._explain_draft(ctx)
        if intent.term_q:
            return self._explain_term(ctx, intent.term_q)
        if intent.build and not intent.archetype:
            return self._explain_build(ctx)
        if intent.name and not (intent.archetype or intent.theme or intent.body_mods or intent.look_mods):
            return self._rename(ctx)
        if (intent.look_words or intent.it_ref) and intent.style_target and not actionable and not intent.surprise:
            return self._unknown_style(ctx)
        if actionable or intent.surprise or (intent.another and view.design):
            result = self._design_turn(ctx)
            if result:
                return result
        if intent.greeting:
            return self._greet(ctx)
        if intent.help:
            return self._help(ctx)
        if view.trainability and view.design and (intent.fix or not last_user):
            return self._revise_for_trainability(ctx)
        if intent.thanks and view.design:
            return self._thanks(ctx)
        if intent.no:
            return _reply(rng.choice(("No problem! What should we change instead?",
                                      "Okay! Tell me what you'd like instead.")), self._suggest(ctx))
        if intent.vague or not view.design:
            return self._clarify(ctx)
        return self._fallback(ctx)

    # -- design turns -----------------------------------------------------
    def _design_turn(self, ctx):
        intent, view, rng = ctx["intent"], ctx["view"], ctx["rng"]
        has_design = view.design is not None
        archetype = intent.archetype
        restyle_only = bool(intent.theme and (intent.look_words or intent.it_ref) and has_design)
        if intent.surprise and intent.look_words and has_design and not intent.theme:
            return self._restyle(ctx, rng.choice(sorted(L.THEMES)))
        if (intent.surprise or intent.another) and not archetype and not restyle_only:
            families = sorted(ARCHETYPES)
            if intent.another and has_design:
                current = _family_for_design(view.design)
                if _re(intent.text, r"\b(different|something else)\b"):
                    archetype = rng.choice([f for f in families if f != current])
                else:
                    archetype = current
            else:
                archetype = rng.choice(families)
            ctx["surprise"] = True
            return self._new_design(ctx, archetype)
        if archetype and intent.arch_strong and not restyle_only and (not has_design or intent.new_words or
                                                                      _bare_keyword(intent)):
            return self._new_design(ctx, archetype)
        if archetype and not intent.arch_strong and has_design and not intent.it_ref and intent.new_words and \
                _re(intent.text, r"\b(a|an|some|something)\b[a-z' -]{0,24}?\b" + re.escape(intent.arch_keyword)):
            return self._new_design(ctx, archetype)  # "make a fast runner" while another design is on the bench
        if restyle_only or (intent.theme and has_design and not intent.body_mods and not archetype):
            return self._restyle(ctx, intent.theme)
        if intent.theme and not has_design and not archetype:
            return self._look_without_body(ctx, intent.theme)
        if has_design and (intent.body_mods or intent.look_mods or archetype):
            return self._modify(ctx)
        if archetype:  # a weak keyword ("something fast") picks the family
            return self._new_design(ctx, archetype)
        if intent.leg_count:
            family = {3: "tripod", 4: "runner", 5: "starfish", 6: "insect", 7: "spider", 8: "spider"}[intent.leg_count]
            return self._new_design(ctx, family)
        if intent.body_mods or intent.look_mods:
            return self._clarify(ctx, need_body=True)
        return None

    def _new_design(self, ctx, key):
        intent, rng, view = ctx["intent"], ctx["rng"], ctx["view"]
        spec = ARCHETYPES[key]
        design = _sample_design(spec, rng)
        keyword = intent.arch_keyword if intent.archetype == key else None
        names, pitch = spec["names"], rng.choice(spec["pitch"])
        for words, (flavour_names, flavour_pitch) in KEYWORD_FLAVOUR.items():
            if keyword in words:
                names, pitch = flavour_names, flavour_pitch
                break
        name = rng.choice(names)
        if view.design and view.design.get("name") == name and len(names) > 1:
            name = rng.choice([n for n in names if n != name])
        design["name"] = intent.name or name
        concept = intent.raw.strip()
        if concept and len(concept) <= 280 and not ctx.get("surprise"):
            design["concept"] = concept
        if keyword in ("crocodile", "croc", "alligator", "gator"):
            design[Q]["actuator"] = "geared"
        if keyword in ("dragon", "jade dragon", "dino", "dinosaur", "t-rex", "trex", "raptor", "stegosaurus"):
            _scale(design[Q], ("torsoHeight",), 1.3)
            _scale(design[Q], ("upperLeg", "lowerLeg"), 1.25)
        notes = _apply_body_mods(design, intent, fresh=True)
        if intent.theme and (intent.look_words or not keyword):
            theme = intent.theme
        else:
            theme = KEYWORD_LOOKS.get(keyword) or (keyword if keyword in L.THEMES else None) or intent.theme or spec["look"]
        # A look the user already picked survives a generic body request
        # ("make a fast runner"); a named creature brings its own costume.
        keep_look = view.look is not None and not intent.arch_strong and not intent.theme and not ctx.get("surprise")
        look = copy.deepcopy(view.look) if keep_look else L.theme_look(theme)
        look_notes = _apply_look_mods(look, intent)
        pitch = pitch.format(len=_size_word(design), act=_actuator_words(design))
        opener = rng.choice(("Ooh, I love this one!", "Fun idea!", "Here's my sketch.", "Okay, sketching…",
                             "Yes! Let's make it.", "Great pick."))
        if ctx.get("surprise"):
            opener = rng.choice(("Surprise!", "Dealer's choice:", "Rolling the dice…", "Here's a fresh one:"))
        lines = [f"{opener} Meet {design['name']}: {pitch}."]
        if notes:
            lines.append(_join_notes(notes))
        if keep_look:
            lines.append(f"It keeps your {look.get('theme') or 'current'} look" + (f", plus {look_notes}." if look_notes else "."))
        elif intent.colors:
            lines.append(f"It's painted {L.describe_look(look)}.")
        else:
            lines.append(f"It's dressed as {L.flavour(theme)}" + (f", plus {look_notes}." if look_notes else "."))
        if ctx["first"]:
            lines.append(DRAFT_LINE + " Hit Build and we'll see what it says.")
        else:
            lines.append(rng.choice(("Build it when you're ready.", "Press Build to let Draft size the motors.",
                                     "Want to tweak anything before you build?")))
        return {"reply": " ".join(lines), "design": design, "look": look,
                "suggestions": self._suggest(ctx, design, look)}

    def _modify(self, ctx):
        intent, view, rng = ctx["intent"], ctx["view"], ctx["rng"]
        design = copy.deepcopy(view.design)
        notes = _apply_body_mods(design, intent) if intent.body_mods else []
        if intent.name:
            design["name"] = intent.name
            notes.append(f"renamed it {intent.name}")
        look = look_notes = None
        if intent.look_mods or intent.theme:
            look = L.theme_look(intent.theme) if intent.theme else (
                copy.deepcopy(view.look) if view.look else L.theme_look(_default_theme(design)))
            look_notes = _apply_look_mods(look, intent)
        changed_body = design != view.design
        reply = []
        if changed_body:
            reply.append(rng.choice(("Done!", "Tweaked!", "Okay!", "Updated!")) + " " + _join_notes(notes))
            if intent.body_mods and (view.ready("walk") or view.body_id):
                reply.append("That's a new body, so it needs a fresh Build (and its own training).")
        elif intent.jump and "jump" in (view.design.get("skills") or []):
            reply.append("It's already set up to jump: light body, springy motors and jump in its skill list.")
        elif intent.body_mods:
            reply.append("That's already at the edge of what Draft's template allows, so I left the body as is.")
        if look is not None:
            if look_notes and intent.add_accessories and not (intent.theme or intent.colors or intent.pattern):
                text = "Added " + look_notes + "."
            elif look_notes:
                text = rng.choice(("Fresh look:", "Restyled:", "Ooh, nice:")) + " " + look_notes + "."
            else:
                text = "New look: " + L.describe_look(look) + "."
            reply.append(text + " Looks are cosmetic, so physics and any trained policy stay the same.")
        if not reply:
            return None
        return {"reply": " ".join(reply), "design": design if changed_body else None, "look": look,
                "suggestions": self._suggest(ctx, design, look or view.look)}

    def _restyle(self, ctx, theme):
        intent, view, rng = ctx["intent"], ctx["view"], ctx["rng"]
        look = L.theme_look(theme)
        extra = _apply_look_mods(look, intent)
        design, notes = None, []
        if intent.body_mods:
            design = copy.deepcopy(view.design)
            notes = _apply_body_mods(design, intent)
            if design == view.design:
                design = None
        label = theme.title()
        openers = [f"{label} mode!", "Restyled!", "Love that look."]
        if theme not in MASS_THEMES:
            openers.append(f"One {theme} coming up!")
        opener = rng.choice(openers)
        reply = [f"{opener} {L.flavour(theme)[:1].upper() + L.flavour(theme)[1:]}" + (f", plus {extra}." if extra else ".")]
        if design:
            reply.append("I also " + _join_notes(notes, lower=True, end="") + " - that body change needs a new Build.")
        else:
            reply.append("Looks are cosmetic, so the physics (and any trained policy) stay exactly the same.")
            offer = self._body_offer(theme, view.design)
            if offer:
                reply.append(offer)
        return {"reply": " ".join(reply), "design": design, "look": look,
                "suggestions": self._suggest(ctx, design or view.design, look)}

    def _look_without_body(self, ctx, theme):
        rng = ctx["rng"]
        look = L.theme_look(theme)
        extra = _apply_look_mods(look, ctx["intent"])
        family = _family_for_theme(theme)
        reply = f"{theme.title()} style is ready: {L.flavour(theme)}" + (f", plus {extra}" if extra else "") + ". "
        if family:
            reply += f"Want me to make a matching body too - say, a {_family_label(family)}?"
        else:
            reply += rng.choice(("What kind of creature should wear it?",
                                 "Which body should wear it - fast, strong, or lots of legs?"))
        chips = [f"Make a {_family_label(family)}"] if family else []
        chips += ["Something fast", "Lots of legs", "A jumping frog"]
        return {"reply": reply, "look": look, "suggestions": chips[:4]}

    def _unknown_style(self, ctx):
        rng, intent = ctx["rng"], ctx["intent"]
        options = list(CHIP_THEMES)
        rng.shuffle(options)
        thing = intent.style_target or "that"
        reply = (f"I don't have a \"{thing}\" style in my paint box yet. How about {options[0]}, {options[1]} or "
                 f"{options[2]}? You can also name colours, like \"purple and gold\".")
        return _reply(reply, [L.CHIPS[o] for o in options[:3]] + ["Paint it purple and gold"])

    # -- build/training feedback -------------------------------------------
    def _revise_for_failure(self, ctx):
        view, rng = ctx["view"], ctx["rng"]
        design = copy.deepcopy(view.design)
        text = " ".join(view.feasibility_messages).lower()
        detail = design.setdefault(design["bodyPlan"], {})
        if re.search(r"overlap|collid|collision|fit|space|clearance|interfer|too small|motor size|crowd", text):
            _scale(detail, ("upperLeg", "lowerLeg", "coxa", "torsoLength", "torsoWidth", "bodyRadius"), 1.12)
            if "strength" in detail:
                detail["strength"] = round(max(0.5, detail["strength"] - 0.15), 2)
            notes = ["gave the motors more room (links and body about 12% bigger)", "eased the strength down a notch"]
        elif re.search(r"speed|velocity|rpm|too slow", text):
            detail["actuator"] = "qdd"
            _scale(detail, ("upperLeg", "lowerLeg"), 0.9)
            notes = ["switched to faster QDD motors", "trimmed the legs 10%"]
        else:
            # Torque, mass, stall and unknown failures: lighter, shorter, stronger.
            _scale(detail, ("upperLeg", "lowerLeg"), 0.86)
            _scale(detail, ("torsoHeight", "torsoWidth", "bodyRadius"), 0.92)
            detail["strength"] = round(min(1.5, detail.get("strength", 1.0) + 0.2), 2)
            notes = ["shortened the legs about 14%", "slimmed the body", "raised motor strength"]
        reason = (view.feasibility_messages[0] if view.feasibility_messages else "the feasibility gate didn't pass").rstrip(".")
        opener = rng.choice(("Draft's feasibility gate said no", "Draft flagged a problem", "Close, but Draft objected"))
        reply = (f"{opener}: \"{_clip(reason, 140)}\". So I {_join_notes(notes, lower=True, end='')}. "
                 + rng.choice(("Want to try building this revision?", "Give the revision a Build?",
                               "Try a Build with this one?")))
        return {"reply": reply, "design": design,
                "suggestions": ["Make it smaller", "Make it lighter", "Try a different body", "What is feasibility?"]}

    def _revise_for_trainability(self, ctx):
        view, rng = ctx["view"], ctx["rng"]
        design = copy.deepcopy(view.design)
        text = " ".join(view.trainability).lower()
        detail = design.setdefault(design["bodyPlan"], {})
        if re.search(r"tip|topple|unstable|balance|tall|narrow|fall", text):
            _scale(detail, ("shoulderWidth", "hipOffset", "torsoWidth", "bodyRadius"), 1.12)
            _scale(detail, ("upperLeg", "lowerLeg"), 0.9)
            note = "widened the stance and lowered it a little for balance"
        elif re.search(r"jump|heavy|mass|weak|torque", text):
            detail["actuator"] = "qdd"
            detail["strength"] = round(min(1.5, detail.get("strength", 1.0) + 0.15), 2)
            _scale(detail, ("torsoHeight", "torsoLength"), 0.9)
            note = "made it lighter with stronger QDD motors"
        else:
            _scale(detail, ("upperLeg", "lowerLeg"), 0.92)
            note = "made the legs a bit shorter and easier to control"
        reply = (f"The trainer warned: \"{_clip(view.trainability[0], 120)}\". I {note} - "
                 + rng.choice(("rebuild it and it should learn more easily.", "a fresh Build should train more happily.")))
        return {"reply": reply, "design": design, "suggestions": ["Make it smaller", "Make it lighter", "Train it anyway"]}

    def _train(self, ctx):
        view, rng = ctx["view"], ctx["rng"]
        design = view.design
        if not design:
            return _reply("Let's design a body first - then Draft builds it and the trainer can teach it to walk. "
                          "What should it be?", ["A jumping frog", "A fast cheetah", "An eight-legged spider"])
        if view.failed:
            return _reply("Training needs a body that passed Draft's feasibility gate. Want me to revise it first?",
                          ["Fix it", "What is feasibility?"])
        skills = list(design.get("skills") or ["walk"])
        if ctx["intent"].jump and "jump" not in skills:
            skills = ["walk", "jump"]
        skills = ["walk"] + [s for s in skills if s != "walk"]
        chips = [LOOK_SURPRISE_CHIP, "What does training do?"] if "jump" in skills else ["Make it jump too", LOOK_SURPRISE_CHIP]
        if not view.body_id:
            return {"reply": "Build it first so Draft can size the motors - then the trainer can start on "
                             + " + ".join(skills) + ". Here's the training plan for after the build.",
                    "train": skills, "suggestions": chips}
        span = "a while" if "jump" in skills else "several minutes"
        reply = rng.choice((f"Ready when you are: training {' + '.join(skills)} runs on this computer's CPU and takes {span}. "
                            "You'll see real progress, then an honest validation report.",
                            f"Let's teach it {' + '.join(skills)}. The trainer runs locally and reports exactly how it did."))
        if "jump" in skills and (design.get(design.get("bodyPlan")) or {}).get("actuator") in ("geared", "harmonic"):
            reply += " Heads-up: jumping is much easier with light QDD motors than geared or harmonic ones."
        return {"reply": reply, "train": skills, "suggestions": chips}

    def _play(self, ctx):
        view = ctx["view"]
        if view.ready("walk"):
            return {"reply": ctx["rng"].choice(("Let's go to the park! Steer with the keyboard, a gamepad or touch.",
                                                "Playground time! Collect sparks and try the ramps.")),
                    "play": True, "suggestions": [LOOK_SURPRISE_CHIP, L.CHIPS["tiger"]]}
        if view.design and view.body_id and not view.failed:
            return _reply("It needs a validated walking policy for this exact body before it can roam the park. "
                          "Want to train it?", ["Train it to walk", "Make it jump too"])
        if view.design:
            return _reply("It needs a validated walking policy for this exact body before it can roam the park. "
                          "Build it first, then train it.", ["Train it to walk"])
        return _reply("Let's design a creature first, then build and train it - the park will be waiting.",
                      ["A jumping frog", "A fast cheetah"])

    # -- talk ---------------------------------------------------------------
    def _greet(self, ctx):
        reply = ctx["rng"].choice((
            "Hi! I'm Tinker, your robot-design buddy. Describe a creature - like \"a frog that jumps onto platforms\" - "
            "and I'll sketch a body Draft can check.",
            "Hey there! Tell me about a creature you'd love to see walk, and I'll turn it into a Draft design.",
            "Hello! What shall we invent today? Animals, bugs, aliens - give me an idea and I'll sketch it."))
        return _reply(reply, ["A jumping frog", "An eight-legged spider", "A tall giraffe", "Surprise me"])

    def _help(self, ctx):
        return _reply("Here's the loop: tell me an idea, I propose a design, Draft builds and checks it, you dress it up, "
                      "the trainer teaches it to walk (or jump), then it's off to the park. Try \"a beetle with six legs\" "
                      "or \"make it look like lava\".", ["A beetle with six legs", "What is Draft?", "Surprise me"])

    def _explain_draft(self, ctx):
        return _reply(DRAFT_LINE + " It's MIT's 2026 robot-design method (Nguyen, Coelho and Kim), and this lab runs the "
                      "real generator on your computer.",
                      self._suggest(ctx) if ctx["view"].design else ["A jumping frog", "Surprise me"])

    def _explain_term(self, ctx, term):
        text = None
        if term.startswith(("qdd", "quasi", "harmonic", "geared", "micro", "actuator", "motor")):
            text = _schema_description(self.store, "actuator")
        elif term == "strength":
            text = _schema_description(self.store, "strength")
        elif term == "feasibility":
            text = ("Draft's feasibility gate checks that the motors it sized can actually hold and move the body, and that "
                    "everything fits. If it fails, I'll revise the design.")
        return _reply(text or DRAFT_LINE, self._suggest(ctx) if ctx["view"].design else ["A jumping frog"])

    def _explain_training(self, ctx):
        return _reply("Training runs reinforcement learning (PPO) on this computer's CPU: the robot practises in a MuJoCo "
                      "simulation thousands of times and slowly learns to follow speed commands. Afterwards an honest "
                      "validation report shows how it really did - only a passing, hash-matched policy unlocks the park.",
                      ["Train it to walk", "Make it jump too"] if ctx["view"].design else ["A jumping frog"])

    def _explain_build(self, ctx):
        if ctx["view"].design:
            return _reply("Press Build on the design card: " + DRAFT_LINE + " If it objects, tell me and I'll revise it.",
                          self._suggest(ctx))
        return _reply("Let's design something first! What creature should we build?", self._suggest(ctx))

    def _rename(self, ctx):
        view, intent = ctx["view"], ctx["intent"]
        if not view.design:
            return _reply(f"{intent.name} is a great name! What kind of creature is it?",
                          ["A jumping frog", "A fast cheetah", "A six-legged beetle"])
        design = copy.deepcopy(view.design)
        design["name"] = intent.name
        return {"reply": ctx["rng"].choice((f"{intent.name} it is!", f"Hello, {intent.name}!", f"Renamed to {intent.name}.")),
                "design": design, "suggestions": self._suggest(ctx, design, view.look)}

    def _thanks(self, ctx):
        return _reply(ctx["rng"].choice(("Anytime! Want to keep tinkering?", "Happy to help - what's next?",
                                         "Glad you like it!")), self._suggest(ctx))

    def _clarify(self, ctx, need_body=False):
        rng = ctx["rng"]
        if need_body:
            question = rng.choice(("Happy to - but first, what creature are we making?",
                                   "Sure! Which creature should I start from?"))
        else:
            question = rng.choice((
                "Ooh, a new robot! What should it be great at - speed, strength, jumping, or creepy-crawly legs?",
                "Let's invent one! Is it more of a speedy runner, a strong hauler, a jumper, or a many-legged crawler?",
                "Fun! Pick a vibe: fast like a cheetah, strong like a bear, bouncy like a frog, or leggy like a spider?"))
        return _reply(question, ["Fast like a cheetah", "Strong like a bear", "A jumping frog", "Eight spider legs"])

    def _fallback(self, ctx):
        reply = ctx["rng"].choice((
            "I'm not sure how to do that one offline. I can change the body (bigger, longer legs, six legs, make it jump) "
            "or the look (ladybug, tiger, lava, candy…).",
            "Hmm, I didn't catch that. Try \"longer legs\", \"make it jump\" or \"paint it like a tiger\"."))
        return _reply(reply, self._suggest(ctx))

    # -- chips --------------------------------------------------------------
    def _suggest(self, ctx, design=None, look=None):
        rng, view = ctx["rng"], ctx["view"]
        design = design or view.design
        look = look or view.look
        if not design:
            return ["A jumping frog", "An eight-legged spider", "A tall giraffe", "Surprise me"]
        chips = []
        skills = design.get("skills") or []
        plan = design.get("bodyPlan")
        detail = design.get(plan) or {}
        if "jump" not in skills and detail.get("actuator") != "harmonic":
            chips.append("Make it jump")
        legs = "Six legs instead" if plan == Q or detail.get("legCount") == 8 else "Eight legs instead"
        chips.append(rng.choice(("Longer legs", "Make it bigger", "Make it smaller", legs, "Make it faster")))
        current = (look or {}).get("theme")
        themes = [t for t in CHIP_THEMES if t != current]
        rng.shuffle(themes)
        chips.append(L.CHIPS[themes[0]])
        chips.append(f"Paint it {rng.choice(('purple and gold', 'mint green', 'hot pink', 'midnight blue', 'sunset orange'))}")
        return chips[:4]

    def _body_offer(self, theme, design):
        family = _family_for_theme(theme)
        if not family or not design:
            return None
        spec = ARCHETYPES[family]
        current = design.get("bodyPlan")
        detail = design.get(current) or {}
        if spec["plan"] == current and (current == Q or detail.get("legCount") == spec["body"].get("legCount")):
            return None
        if spec["plan"] == M:
            legs = {3: "three", 5: "five", 6: "six", 8: "eight"}.get(spec["body"].get("legCount"), "more")
            return f"Want me to make it a real {legs}-legged {theme} too?"
        return f"Want me to make it a real four-legged {theme} too?"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reply(text, suggestions=()):
    return {"reply": text, "suggestions": list(suggestions)}


def _bare_keyword(intent):
    return len(intent.text.split()) <= 4 and not intent.it_ref


def _last_question(text):
    for sentence in reversed(re.split(r"(?<=[.!?])\s+", text or "")):
        if sentence.strip().endswith("?"):
            return sentence
    return None


def _sample_design(spec, rng):
    detail = {}
    for key, value in spec["body"].items():
        if isinstance(value, tuple):
            detail[key] = round(rng.uniform(*value), 2 if key == "strength" else 3)
        else:
            detail[key] = value
    design = {"schema": DESIGN_ID, "name": "", "bodyPlan": spec["plan"]}
    if spec.get("preset"):
        design["basePreset"] = spec["preset"]
    design[spec["plan"]] = detail
    design["skills"] = list(spec["skills"])
    return design


def _scale(detail, keys, factor):
    for key in keys:
        if type(detail.get(key)) in (int, float):
            detail[key] = round(detail[key] * factor, 3)


def _apply_body_mods(design, intent, fresh=False):
    """Mutate design per the intent's body modifiers; return human notes."""
    notes = []
    plan = design.get("bodyPlan")
    count = intent.leg_count
    if not count and intent.leg_delta:
        current = 4 if plan == Q else (design.get(M) or {}).get("legCount", 6)
        count = max(3, min(8, current + intent.leg_delta))
    if count:
        if _set_leg_count(design, count, intent.arrangement):
            notes.append(f"gave it {count} legs")
        plan = design.get("bodyPlan")
    detail = design.setdefault(plan, {})
    if intent.arrangement and plan == M and detail.get("arrangement") != intent.arrangement:
        detail["arrangement"] = intent.arrangement
        detail["bodyAspect"] = max(detail.get("bodyAspect", 1.0), 1.6) if intent.arrangement == "bilateral" else 1.0
        notes.append("arranged the legs radially" if intent.arrangement == "radial" else "put the legs in pairs")
    if intent.size:
        _scale(detail, ("torsoLength", "torsoWidth", "torsoHeight", "shoulderWidth", "hipOffset", "upperLeg", "lowerLeg",
                        "bodyRadius", "coxa"), 1.18 if intent.size > 0 else 0.82)
        if intent.size < 0 and plan == Q and detail.get("actuator") in ("geared", "harmonic") and detail.get("torsoLength", 1) < 0.4:
            detail["actuator"] = "qdd"
        if fresh:
            notes.append("I made it extra big" if intent.size > 0 else "I made it extra small")
        else:
            notes.append("scaled it up about 18%" if intent.size > 0 else "shrank it about 18%")
    if intent.legs:
        _scale(detail, ("upperLeg", "lowerLeg"), 1.2 if intent.legs > 0 else 0.8)
        notes.append("made the legs 20% longer" if intent.legs > 0 else "made the legs 20% shorter")
    if intent.body_len:
        if plan == Q:
            _scale(detail, ("torsoLength",), 1.15 if intent.body_len > 0 else 0.87)
        else:
            detail["bodyAspect"] = round(detail.get("bodyAspect", 1.0) + (0.3 if intent.body_len > 0 else -0.3), 2)
        notes.append("stretched the body" if intent.body_len > 0 else "made the body more compact")
    if intent.width:
        _scale(detail, ("torsoWidth", "shoulderWidth", "bodyRadius"), 1.15 if intent.width > 0 else 0.87)
        notes.append("widened the body" if intent.width > 0 else "slimmed the body")
    if intent.heavy > 0:
        if plan == Q and detail.get("actuator") != "harmonic":
            detail["actuator"] = "geared"
        _scale(detail, ("torsoWidth", "torsoHeight", "bodyRadius"), 1.1)
        notes.append("made it sturdier" + (" with geared motors" if plan == Q else ""))
    elif intent.heavy < 0:
        _scale(detail, ("torsoHeight", "torsoWidth", "bodyRadius"), 0.9)
        if plan == Q or detail.get("actuator") != "micro":
            detail["actuator"] = "qdd"
        notes.append("put it on a diet (lighter body)")
    if intent.fast:
        detail["actuator"] = "qdd"
        detail["strength"] = round(min(1.5, detail.get("strength", 1.0) + 0.1), 2)
        _scale(detail, ("upperLeg", "lowerLeg"), 1.08)
        notes.append("I gave it an extra-long stride for speed" if fresh else
                     "switched to zippy QDD motors with a slightly longer stride")
    if intent.strength:
        detail["strength"] = round(min(1.5, max(0.5, detail.get("strength", 1.0) + 0.2 * intent.strength)), 2)
        if not fresh:
            notes.append("boosted motor strength" if intent.strength > 0 else "dialled motor strength down")
    if intent.actuator:
        allowed = ("micro", "qdd") if plan == M else ("micro", "qdd", "geared", "harmonic")
        if intent.actuator in allowed:
            detail["actuator"] = intent.actuator
            notes.append(f"switched to {ACTUATOR_WORDS[intent.actuator]}")
        else:
            notes.append(f"kept {detail.get('actuator', 'qdd')} motors ({intent.actuator} isn't available for multi-leg bodies)")
    skills = list(design.get("skills") or ["walk"])
    if intent.jump and "jump" not in skills:
        skills = ["walk", "jump"]
        detail["actuator"] = "qdd"
        detail["strength"] = round(max(detail.get("strength", 1.0), 1.3), 2)
        _scale(detail, ("torsoHeight", "bodyRadius"), 0.92)
        if not fresh:
            notes.append("added a jump skill (light body, springy QDD motors, extra strength)")
    if intent.no_jump and "jump" in skills:
        skills = ["walk"]
        notes.append("dropped the jump skill")
    design["skills"] = ["walk"] + [s for s in skills if s != "walk"]
    return notes


def _set_leg_count(design, count, arrangement=None):
    plan = design.get("bodyPlan")
    if plan == Q and count == 4:
        return False
    if plan == M and (design.get(M) or {}).get("legCount") == count and not arrangement:
        return False
    if count == 4 and plan == M and arrangement != "radial":
        multileg = design.pop(M, {})
        radius = multileg.get("bodyRadius", 0.14)
        upper, lower = multileg.get("upperLeg", 0.18), multileg.get("lowerLeg", 0.2)
        design["bodyPlan"] = Q
        design.pop("basePreset", None)
        design[Q] = {"torsoLength": round(radius * 3.4, 3), "torsoWidth": round(radius * 1.5, 3),
                     "torsoHeight": round(radius * 1.0, 3), "shoulderWidth": round(radius * 1.2, 3),
                     "hipOffset": round(max(0.06, radius * 0.6), 3), "upperLeg": round(upper * 1.3, 3),
                     "lowerLeg": round(lower * 1.2, 3), "actuator": multileg.get("actuator", "qdd"),
                     "strength": multileg.get("strength", 1.0)}
        return True
    if plan == Q:
        quad = design.pop(Q, {})
        length = quad.get("torsoLength", 0.5)
        actuator = quad.get("actuator", "qdd")
        design["bodyPlan"] = M
        design.pop("basePreset", None)
        # Six legs read as an insect (pairs); eight as a spider unless the body is long.
        bilateral = arrangement == "bilateral" or (arrangement is None and (count == 6 or (count == 8 and length > 0.5)))
        design[M] = {"legCount": count, "arrangement": "bilateral" if bilateral else "radial",
                     "bodyRadius": round(min(0.22, max(0.1, length / 3.6)), 3),
                     "bodyAspect": 1.7 if bilateral else 1.0, "coxa": 0.06,
                     "upperLeg": round(min(0.3, quad.get("upperLeg", 0.25) * 0.75), 3),
                     "lowerLeg": round(min(0.34, quad.get("lowerLeg", 0.23) * 0.85), 3),
                     "actuator": actuator if actuator in ("micro", "qdd") else "qdd",
                     "strength": quad.get("strength", 1.1)}
        return True
    detail = design.setdefault(M, {})
    detail["legCount"] = count
    if design.get("basePreset") == "flower" and count != 6:
        design.pop("basePreset", None)
    if arrangement:
        detail["arrangement"] = arrangement
    return True


def _apply_look_mods(look, intent):
    """Mutate look per colour/finish/pattern/... words; return a short note."""
    notes = []
    if intent.colors:
        look["palette"] = L.palette_from_colors(intent.colors)
        names = " & ".join(L.color_name(c) for c in intent.colors[:2])
        notes.append(names.replace(" & ", " and ") + " paint")
        theme = look.get("theme") or ""
        look["theme"] = (names + (" " + theme if theme and theme != "classic" else ""))[:40]
    if intent.finish:
        look["finish"] = intent.finish
        notes.append({"gloss": "a glossy finish", "matte": "a matte finish", "satin": "a satin finish",
                      "metal": "a metallic finish", "glow": "a glow", "toon": "toon shading"}[intent.finish])
    if intent.pattern:
        pattern = look.get("pattern") or {}
        if intent.pattern == "none":
            look["pattern"] = {"kind": "none"}
            notes.append("no pattern")
        else:
            color = pattern.get("color") or L.darken((look.get("palette") or {}).get("body", "#888888"), 0.5)
            look["pattern"] = {"kind": intent.pattern, "color": color, "scale": pattern.get("scale", 1.0)}
            notes.append(intent.pattern)
    if intent.shell:
        if intent.shell == "none":
            look["shell"] = {"kind": "none"}
            notes.append("no shell")
        else:
            look["shell"] = {"kind": intent.shell, "color": (look.get("palette") or {}).get("accent", "#cccccc"), "size": 1.0}
            notes.append(f"a {intent.shell} shell" if intent.shell != "fluffy" else "some fluff")
    if intent.eyes:
        face = look.setdefault("face", {})
        face["eyes"] = intent.eyes
        face.setdefault("eyeColor", "#1b1b1f")
        notes.append(f"{intent.eyes} eyes" if intent.eyes != "cyclops" else "one big eye")
    accessories = [a for a in look.get("accessories") or [] if a.get("kind") not in intent.remove_accessories]
    added = []
    for kind in intent.add_accessories:
        if any(a.get("kind") == kind for a in accessories):
            continue
        if len(accessories) >= 4:
            accessories.pop(0)
        accessories.append({"kind": kind, "color": (look.get("palette") or {}).get("accent", "#f2c230"), "size": 1.0})
        added.append(ACCESSORY_PHRASES[kind])
    if added:
        notes.append(added[0] if len(added) == 1 else ", ".join(added[:-1]) + " and " + added[-1])
    if intent.remove_accessories:
        notes.append("no " + ", ".join(sorted(intent.remove_accessories)))
    look["accessories"] = accessories
    if intent.feet:
        look.setdefault("limbs", {})["feet"] = intent.feet
        notes.append(f"{intent.feet} feet")
    if intent.limb_style:
        look.setdefault("limbs", {})["style"] = intent.limb_style
        notes.append(f"{intent.limb_style} legs")
    return ", ".join(notes)


def _default_theme(design):
    if design.get("bodyPlan") == M:
        count = (design.get(M) or {}).get("legCount")
        return {3: "alien", 5: "starfish", 6: "beetle", 8: "spider"}.get(count, "flower")
    return {"cheetah": "cheetah", "bear": "bear", "giraffe": "giraffe"}.get(design.get("basePreset"), "classic")


def _family_for_design(design):
    if not design:
        return "runner"
    if design.get("bodyPlan") == M:
        detail = design.get(M) or {}
        count, arrangement = detail.get("legCount", 6), detail.get("arrangement", "radial")
        if count == 3:
            return "tripod"
        if count == 5:
            return "starfish"
        if count == 6:
            return "flower" if arrangement == "radial" else "insect"
        return "spider" if arrangement == "radial" else "crab"
    detail = design.get(Q) or {}
    if detail.get("actuator") == "micro":
        return "critter"
    return {"bear": "tank", "giraffe": "stilts"}.get(design.get("basePreset"),
                                                     "hopper" if "jump" in (design.get("skills") or []) else "runner")


def _family_for_theme(theme):
    for key, spec in ARCHETYPES.items():
        if spec["look"] == theme or theme in spec["strong"]:
            return key
    for keyword, mapped in KEYWORD_LOOKS.items():
        if mapped == theme:
            for key, spec in ARCHETYPES.items():
                if keyword in spec["strong"]:
                    return key
    return None


def _family_label(family):
    return {"hopper": "jumping frog", "runner": "fast runner", "tank": "strong hauler", "stilts": "tall walker",
            "strider": "long-legged trotter", "critter": "tiny critter", "lizard": "low lizard", "turtle": "tortoise",
            "insect": "six-legged bug", "spider": "eight-legged spider", "crab": "crab", "centipede": "centipede",
            "flower": "flower crawler", "starfish": "five-armed starfish", "jellyfish": "jellyfish walker",
            "tripod": "three-legged alien"}.get(family, family)


def _size_word(design):
    detail = design.get(design.get("bodyPlan")) or {}
    if design.get("bodyPlan") == Q:
        return f"{detail.get('torsoLength', 0.5):.2f}"
    return f"{2 * detail.get('bodyRadius', 0.14):.2f}"


def _actuator_words(design):
    detail = design.get(design.get("bodyPlan")) or {}
    return ACTUATOR_WORDS.get(detail.get("actuator"), "Flower-style motors")


def _join_notes(notes, lower=False, end="."):
    if not notes:
        return ""
    text = notes[0] if len(notes) == 1 else ", ".join(notes[:-1]) + " and " + notes[-1]
    text = text if lower else text[:1].upper() + text[1:]
    return text + end


def _clip(text, limit):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _schema_description(store, field):
    """Pull a field explanation straight from the live design schema."""
    try:
        document = store.doc(DESIGN_ID)
    except Exception:
        return None
    for section in ("quadruped", "multileg"):
        prop = ((document.get("properties") or {}).get(section) or {}).get("properties", {}).get(field)
        if isinstance(prop, dict) and isinstance(prop.get("description"), str):
            return prop["description"]
    return None
