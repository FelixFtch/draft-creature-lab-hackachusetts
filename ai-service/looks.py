"""Look themes for the offline designer (creature-look/1 objects).

Purely cosmetic: a look never changes masses, collisions or the compiled
model. Every theme below is checked against contracts/look.schema.json at
runtime (and repaired if that schema tightens), so this file is a palette
book, not a second copy of the schema.
"""
from __future__ import annotations

import copy

from schemas import NAMED_COLORS

LOOK_ID = "creature-look/1"


def _look(theme, body, limbs, joints, accent, feet, finish="satin", pattern=None, shell=None, eyes="round",
          eye="#1b1b1f", acc=(), style="classic", foot="ball"):
    look = {
        "schema": LOOK_ID,
        "theme": theme,
        "palette": {"body": body, "limbs": limbs, "joints": joints, "accent": accent, "feet": feet},
        "finish": finish,
        "pattern": {"kind": "none"} if pattern is None else {"kind": pattern[0], "color": pattern[1], "scale": pattern[2]},
        "shell": {"kind": "none"} if shell is None else {"kind": shell[0], "color": shell[1], "size": shell[2]},
        "face": {"eyes": eyes, "eyeColor": eye},
        "accessories": [{"kind": kind, "color": color, "size": size} for kind, color, size in acc],
        "limbs": {"style": style, "feet": foot},
    }
    return look


# key: (look, aliases, flavour words used in replies)
THEMES = {
    "classic": (_look("classic", "#1f8c80", "#4fb3a6", "#155f57", "#f2c230", "#2a2f33"),
                ("default look", "original look", "classic look", "default colors", "default colours"), "the original Draft-lab teal"),
    "frog": (_look("frog", "#4caf50", "#7cc96b", "#2e6b34", "#f4d03f", "#2e6b34", pattern=("spots", "#2e6b34", 1.2),
                   eyes="cute", style="chunky", foot="pad"), ("froggy", "lily pad"), "pond-green with dark spots and big cute eyes"),
    "toad": (_look("toad", "#8a7a3b", "#a8955a", "#5a4d22", "#d9c27a", "#5a4d22", finish="matte",
                   pattern=("spots", "#5a4d22", 0.8), eyes="sleepy", eye="#c9a227", style="chunky", foot="pad"),
             ("toadie",), "warty olive with sleepy golden eyes"),
    "poison dart frog": (_look("poison dart frog", "#1f6fd6", "#1b1b1f", "#0d2a66", "#f2c230", "#1b1b1f", finish="gloss",
                               pattern=("spots", "#1b1b1f", 1.0), eyes="cute", style="chunky", foot="pad"),
                         ("dart frog", "poison frog"), "electric blue gloss with black spots"),
    "bunny": (_look("bunny", "#f4f1ee", "#e8dcd6", "#d8b4c0", "#f4a6c0", "#f4a6c0", shell=("fluffy", "#ffffff", 1.0),
                    eyes="cute", eye="#3b2a2a", acc=(("ears", "#f4a6c0", 1.3), ("tail", "#ffffff", 0.8)), foot="paw"),
              ("rabbit", "hare", "bunny rabbit"), "fluffy white with pink ears and a pom-pom tail"),
    "kangaroo": (_look("kangaroo", "#c68a4f", "#b37744", "#6e4526", "#f1d3a8", "#6e4526", finish="matte",
                       acc=(("ears", "#c68a4f", 1.0), ("tail", "#b37744", 1.4)), style="chunky", foot="pad"),
                 ("roo", "wallaby"), "outback tan with a big balancing tail"),
    "grasshopper": (_look("grasshopper", "#8bc34a", "#6a9f32", "#3e6b1a", "#d4e157", "#3e6b1a", pattern=("bands", "#6a9f32", 1.0),
                          eyes="compound", eye="#2e4a12", acc=(("antennae", "#3e6b1a", 1.4),), style="sleek", foot="pad"),
                    ("cricket", "locust"), "leaf-green with banded legs and long antennae"),
    "cheetah": (_look("cheetah", "#e8b04a", "#f0c674", "#6b4a1f", "#1b1b1f", "#3b2a1a", pattern=("spots", "#1b1b1f", 0.8),
                      eye="#c99a2e", acc=(("ears", "#e8b04a", 0.8), ("tail", "#e8b04a", 1.2)), style="sleek", foot="paw"),
                ("leopard", "jaguar", "spotted"), "golden with sprinter spots"),
    "panther": (_look("panther", "#1b1b1f", "#26262b", "#33363b", "#3fa34d", "#1b1b1f", finish="gloss", eye="#9ad63a",
                      acc=(("ears", "#1b1b1f", 0.8), ("tail", "#1b1b1f", 1.3)), style="sleek", foot="paw"),
                ("black panther", "black cat"), "midnight gloss with green eyes"),
    "dog": (_look("dog", "#c58b54", "#e0b07c", "#7a4f2a", "#d94f4f", "#7a4f2a", eyes="cute", eye="#2b1d14",
                  acc=(("ears", "#7a4f2a", 1.2), ("tail", "#c58b54", 1.0)), foot="paw"),
            ("puppy", "pup", "doggo", "hound", "doggy", "corgi", "golden retriever"), "warm caramel with floppy ears and a red collar"),
    "dalmatian": (_look("dalmatian", "#f7f7f2", "#f0f0ea", "#2a2a2a", "#d93a32", "#2a2a2a", pattern=("spots", "#1b1b1f", 1.0),
                        eyes="cute", acc=(("ears", "#1b1b1f", 1.1), ("tail", "#f7f7f2", 1.0)), foot="paw"),
                  ("firehouse dog",), "white with black spots, firehouse style"),
    "cat": (_look("cat", "#f08a24", "#f6a94f", "#a85410", "#fff3e0", "#fff3e0", pattern=("stripes", "#a85410", 0.9),
                  eyes="cute", eye="#3fa34d", acc=(("ears", "#f08a24", 1.0), ("tail", "#f08a24", 1.2)), style="sleek", foot="paw"),
            ("kitty", "kitten", "tabby", "kitteh"), "ginger tabby stripes with green eyes"),
    "fox": (_look("fox", "#e5671f", "#2a1d17", "#8a3a10", "#fff5ea", "#2a1d17", pattern=("gradient", "#fff5ea", 1.0),
                  eye="#f2a51a", acc=(("ears", "#e5671f", 1.2), ("tail", "#e5671f", 1.5)), style="sleek", foot="paw"),
            ("foxy", "kitsune"), "russet orange with dark socks and a huge tail"),
    "wolf": (_look("wolf", "#8c9196", "#b8bcc0", "#4a4f55", "#f4f4f2", "#4a4f55", finish="matte", pattern=("gradient", "#f4f4f2", 1.0),
                   eye="#7cc4f0", acc=(("ears", "#8c9196", 1.1), ("tail", "#8c9196", 1.3)), foot="paw"),
             ("husky", "wolfie", "malamute"), "storm grey with ice-blue eyes"),
    "tiger": (_look("tiger", "#f08a24", "#f6a94f", "#1b1b1f", "#f4f4f2", "#1b1b1f", pattern=("stripes", "#1b1b1f", 1.2),
                    eye="#d4a72c", acc=(("ears", "#f08a24", 0.9), ("tail", "#f08a24", 1.3)), style="chunky", foot="paw"),
              ("tigress", "bengal"), "blazing orange with bold black stripes"),
    "lion": (_look("lion", "#d9a441", "#e6bd6a", "#7a4f1f", "#8a4b1f", "#7a4f1f", shell=("fluffy", "#8a4b1f", 1.2), eye="#c9a227",
                   acc=(("tail", "#d9a441", 1.2), ("ears", "#d9a441", 0.8)), style="chunky", foot="paw"),
             ("lioness", "king of the jungle"), "golden with a fluffy mane"),
    "panda": (_look("panda", "#f4f4f2", "#1b1b1f", "#1b1b1f", "#1b1b1f", "#1b1b1f", finish="matte", shell=("fluffy", "#f4f4f2", 1.0),
                    eyes="sleepy", acc=(("ears", "#1b1b1f", 1.0),), style="chunky", foot="paw"),
              ("giant panda", "bamboo"), "black-and-white and very huggable"),
    "bear": (_look("bear", "#8a5a3b", "#6e472e", "#4a2f1e", "#d9b38c", "#4a2f1e", finish="matte", shell=("fluffy", "#8a5a3b", 1.1),
                   eyes="cute", acc=(("ears", "#8a5a3b", 0.9),), style="chunky", foot="paw"),
             ("grizzly", "teddy", "teddy bear", "brown bear"), "cosy brown fur, teddy-bear style"),
    "polar bear": (_look("polar bear", "#f4f4f2", "#e8e8e2", "#b9c4cc", "#1b1b1f", "#b9c4cc", finish="matte",
                         shell=("fluffy", "#ffffff", 1.1), eyes="cute", acc=(("ears", "#f4f4f2", 0.8),), style="chunky", foot="paw"),
                   ("polar", "arctic bear"), "snowy white fluff"),
    "elephant": (_look("elephant", "#9aa0a6", "#8a9096", "#5f656b", "#f3ead2", "#5f656b", finish="matte", eyes="sleepy",
                       acc=(("ears", "#9aa0a6", 1.6), ("tail", "#8a9096", 0.7)), style="chunky", foot="hoof"),
                 ("jumbo", "mammoth", "dumbo"), "dusty grey with enormous ears"),
    "rhino": (_look("rhino", "#7d8287", "#6b7075", "#44484c", "#e3d5b8", "#44484c", finish="matte", pattern=("panels", "#6b7075", 1.2),
                    shell=("armor", "#7d8287", 1.0), acc=(("horns", "#e3d5b8", 1.3),), style="chunky", foot="hoof"),
              ("rhinoceros", "triceratops"), "armour-plated grey with a proud horn"),
    "giraffe": (_look("giraffe", "#e8b04a", "#f0c674", "#8a5a22", "#8a5a22", "#5a3a14", pattern=("spots", "#8a5a22", 1.4),
                      eyes="cute", eye="#3b2a1a", acc=(("horns", "#8a5a22", 0.7), ("ears", "#e8b04a", 0.8), ("tail", "#e8b04a", 0.9)),
                      style="sleek", foot="hoof"), ("giraffes",), "sunny yellow with big patchwork spots"),
    "zebra": (_look("zebra", "#f4f4f2", "#f4f4f2", "#1b1b1f", "#1b1b1f", "#1b1b1f", pattern=("stripes", "#1b1b1f", 1.0),
                    acc=(("ears", "#f4f4f2", 0.9), ("tail", "#1b1b1f", 1.0)), style="sleek", foot="hoof"),
              ("zebras", "stripy horse"), "crisp black-and-white stripes"),
    "horse": (_look("horse", "#7a4a2a", "#6a3e22", "#3e2412", "#f3ead2", "#2a1a10", shell=("saddle", "#b8733a", 1.0),
                    acc=(("ears", "#7a4a2a", 0.9), ("tail", "#2a1a10", 1.3)), style="sleek", foot="hoof"),
              ("pony", "stallion", "mare", "mustang"), "chestnut coat with a leather saddle"),
    "unicorn": (_look("unicorn", "#f7f2fb", "#ece4f5", "#c8a2d8", "#f07aa8", "#c8a2d8", finish="gloss", pattern=("gradient", "#b9a4e6", 1.0),
                      eyes="cute", eye="#7c4dbe", acc=(("horns", "#f2c230", 1.0), ("tail", "#f07aa8", 1.3), ("ears", "#f7f2fb", 0.8)),
                      style="sleek", foot="hoof"), ("magical", "pegasus"), "pearly white with a lilac fade and a golden horn"),
    "deer": (_look("deer", "#b5793f", "#c98f55", "#6e4523", "#f6efe2", "#3e2412", pattern=("spots", "#f6efe2", 0.6), eyes="cute",
                   acc=(("horns", "#6e4523", 1.4), ("ears", "#b5793f", 1.0), ("tail", "#f6efe2", 0.6)), style="sleek", foot="hoof"),
             ("reindeer", "elk", "moose", "fawn", "antelope", "gazelle", "stag"), "fawn brown with antlers"),
    "llama": (_look("llama", "#efe3cf", "#e3d3b8", "#b39a74", "#e86a8a", "#8a7457", finish="matte", shell=("fluffy", "#f7efe2", 1.2),
                    eyes="sleepy", acc=(("ears", "#efe3cf", 1.1), ("bow", "#e86a8a", 0.8)), style="chunky", foot="hoof"),
              ("alpaca", "camel"), "creamy wool with a pink bow"),
    "mouse": (_look("mouse", "#a8adb3", "#c4c8cc", "#6b7075", "#f4a6c0", "#f4a6c0", eyes="cute",
                    acc=(("ears", "#f4a6c0", 1.5), ("tail", "#f4a6c0", 1.4)), foot="paw"),
              ("mice", "rat", "mousey"), "soft grey with big pink ears"),
    "hamster": (_look("hamster", "#e8a85c", "#f6e0c4", "#b0743a", "#fff5ea", "#f4c7a1", finish="matte", shell=("fluffy", "#e8a85c", 1.2),
                      eyes="cute", acc=(("ears", "#f4c7a1", 0.8),), style="chunky", foot="paw"),
                ("gerbil", "guinea pig"), "golden fluffball"),
    "squirrel": (_look("squirrel", "#b5562a", "#c9703f", "#6e3417", "#f3ead2", "#6e3417", eyes="cute",
                       acc=(("tail", "#b5562a", 1.6), ("ears", "#b5562a", 0.9)), foot="paw"),
                 ("chipmunk",), "rusty red with a giant fluffy tail"),
    "gecko": (_look("gecko", "#8fd14f", "#6fb33a", "#3e7a1a", "#f2c230", "#3e7a1a", pattern=("spots", "#f2c230", 0.7), eye="#f2a51a",
                    acc=(("tail", "#8fd14f", 1.4),), style="sleek", foot="pad"),
              ("lizard", "salamander", "newt", "iguana", "komodo"), "lime green with sunny freckles"),
    "chameleon": (_look("chameleon", "#3fbf8f", "#f2c230", "#2a7a5c", "#f07aa8", "#2a7a5c", finish="gloss", pattern=("gradient", "#f07aa8", 1.0),
                        eyes="compound", eye="#f2c230", acc=(("tail", "#3fbf8f", 1.3),), style="sleek", foot="pad"),
                  ("colour changing", "color changing"), "a teal-to-pink colour shift"),
    "crocodile": (_look("crocodile", "#4a6b2e", "#3e5a26", "#26381a", "#d9c78a", "#26381a", finish="matte", pattern=("panels", "#3e5a26", 0.8),
                        shell=("armor", "#4a6b2e", 1.0), eyes="sleepy", eye="#d9c227", acc=(("spikes", "#26381a", 1.0), ("tail", "#4a6b2e", 1.5)),
                        style="chunky", foot="paw"), ("croc", "alligator", "gator"), "swamp green with armour scutes"),
    "dino": (_look("dino", "#6fbf4a", "#5aa63a", "#2e6b1a", "#f2a51a", "#2e6b1a", finish="toon", pattern=("spots", "#2e6b1a", 1.4),
                   acc=(("spikes", "#f2a51a", 1.2), ("tail", "#6fbf4a", 1.5)), style="chunky", foot="paw"),
             ("dinosaur", "t-rex", "trex", "raptor", "stegosaurus", "jurassic"), "cartoon green with orange back spikes"),
    "dragon": (_look("dragon", "#c62828", "#a31f1f", "#5a1010", "#f2c230", "#5a1010", finish="metal", pattern=("panels", "#8a1a1a", 1.0),
                     eye="#f2c230", acc=(("horns", "#f2c230", 1.2), ("wings", "#a31f1f", 1.4), ("spikes", "#f2c230", 1.0), ("tail", "#c62828", 1.4)),
                     style="chunky", foot="paw"), ("fire dragon", "red dragon", "wyvern", "drake"), "molten red scales with golden horns and wings"),
    "jade dragon": (_look("jade dragon", "#3f9e7a", "#5fb894", "#1f5e46", "#d4a72c", "#1f5e46", finish="gloss", pattern=("panels", "#2a7a5c", 1.0),
                          eye="#d4a72c", acc=(("horns", "#d4a72c", 1.1), ("spikes", "#d4a72c", 0.9), ("tail", "#3f9e7a", 1.4)),
                          style="sleek", foot="paw"), ("lunar dragon", "chinese dragon", "imperial dragon"), "polished jade with gold trim"),
    "turtle": (_look("turtle", "#6b8f3a", "#8fae5a", "#3e5a1a", "#c9a46b", "#3e5a1a", finish="matte", shell=("turtle", "#7a5a2e", 1.2),
                     eyes="sleepy", style="chunky", foot="pad"), ("tortoise", "terrapin"), "mossy green under a patterned shell"),
    "ladybug": (_look("ladybug", "#d93a32", "#1b1b1f", "#1b1b1f", "#1b1b1f", "#1b1b1f", finish="gloss", pattern=("spots", "#1b1b1f", 1.1),
                      shell=("beetle", "#d93a32", 1.1), eyes="cute", acc=(("antennae", "#1b1b1f", 1.0),), style="sleek"),
                ("ladybird", "lady bug", "lady beetle"), "glossy red with black spots and a beetle shell"),
    "beetle": (_look("beetle", "#1f3f66", "#1b1b1f", "#0d1a2a", "#3fa34d", "#0d1a2a", finish="metal", shell=("beetle", "#2a4f7a", 1.2),
                     eyes="compound", eye="#3fa34d", acc=(("horns", "#1b1b1f", 1.2), ("antennae", "#1b1b1f", 1.0)), style="sleek"),
               ("stag beetle", "rhino beetle", "rhinoceros beetle", "weevil", "bug"), "iridescent blue armour with a big horn"),
    "scarab": (_look("scarab", "#d4a72c", "#8a6a14", "#5a4410", "#2a9d68", "#5a4410", finish="metal", shell=("beetle", "#d4a72c", 1.2),
                     eyes="compound", eye="#2a9d68", acc=(("antennae", "#8a6a14", 0.9),), style="sleek"),
               ("golden beetle", "egyptian"), "pharaoh gold with an emerald glint"),
    "ant": (_look("ant", "#8a1f1f", "#3b0f0f", "#1b0a0a", "#d93a32", "#1b0a0a", finish="gloss", pattern=("bands", "#3b0f0f", 1.0),
                  eyes="compound", acc=(("antennae", "#3b0f0f", 1.3),), style="sleek"), ("ants", "fire ant", "termite"), "fire-ant red with dark bands"),
    "bee": (_look("bee", "#f2c230", "#1b1b1f", "#1b1b1f", "#1b1b1f", "#1b1b1f", pattern=("stripes", "#1b1b1f", 1.0),
                  shell=("fluffy", "#f2c230", 0.9), eyes="compound", acc=(("wings", "#e8f4ff", 1.2), ("antennae", "#1b1b1f", 1.0)), style="sleek"),
            ("bumblebee", "bumble bee", "honeybee", "wasp", "hornet"), "fuzzy yellow-and-black stripes with little wings"),
    "butterfly": (_look("butterfly", "#2a2a4a", "#1b1b1f", "#1b1b1f", "#f08a24", "#1b1b1f", finish="gloss", pattern=("gradient", "#7c4dbe", 1.0),
                        eyes="compound", acc=(("wings", "#f08a24", 1.6), ("antennae", "#1b1b1f", 1.2)), style="sleek"),
                  ("moth", "monarch"), "velvet body with big monarch wings"),
    "mantis": (_look("mantis", "#7fc241", "#6aa632", "#3e6b1a", "#d4e157", "#3e6b1a", eyes="compound", eye="#d4e157",
                     acc=(("antennae", "#3e6b1a", 1.2),), style="sleek", foot="pad"), ("praying mantis", "stick insect"), "leaf-green and lean"),
    "firefly": (_look("firefly", "#2a2a2a", "#3b3b3b", "#1b1b1f", "#e8f54a", "#1b1b1f", finish="glow", pattern=("gradient", "#e8f54a", 1.0),
                      eyes="compound", eye="#e8f54a", acc=(("wings", "#c8d8e8", 1.0), ("antennae", "#1b1b1f", 1.0)), style="sleek"),
                ("lightning bug", "glow bug", "glowworm"), "night black with a glowing lantern tail"),
    "spider": (_look("spider", "#1b1b1f", "#2a2a2e", "#d93a32", "#d93a32", "#1b1b1f", finish="gloss", shell=("dome", "#1b1b1f", 1.0),
                     eyes="compound", eye="#d93a32", acc=(("spikes", "#d93a32", 0.7),), style="bones"),
               ("arachnid", "black widow", "daddy long legs", "spidey"), "glossy black with red joints, black-widow chic"),
    "tarantula": (_look("tarantula", "#5e3a24", "#4a2c1a", "#f08a24", "#f08a24", "#2a1a10", finish="matte", pattern=("bands", "#f08a24", 0.8),
                        shell=("fluffy", "#5e3a24", 1.0), eyes="compound", style="chunky"), ("hairy spider",), "fuzzy brown with orange knees"),
    "octopus": (_look("octopus", "#9b4dca", "#b56fe0", "#6a2a96", "#f07aa8", "#f07aa8", finish="gloss", pattern=("spots", "#f07aa8", 0.8),
                      shell=("dome", "#9b4dca", 1.2), eye="#f2c230", style="sleek", foot="pad"), ("octopi", "squid", "kraken"), "deep-sea purple with pink suckers"),
    "jellyfish": (_look("jellyfish", "#b9a4e6", "#f4c7f0", "#7c4dbe", "#7cf0e8", "#7cf0e8", finish="glow", pattern=("gradient", "#7cf0e8", 1.0),
                        shell=("dome", "#d8c8f8", 1.3), eyes="sleepy", eye="#7c4dbe", style="bones"), ("jelly", "medusa"), "glowing lilac with a jelly dome"),
    "crab": (_look("crab", "#e0482e", "#f06a4a", "#8a2010", "#f6c9a0", "#8a2010", finish="gloss", shell=("armor", "#e0482e", 1.1),
                   acc=(("antennae", "#8a2010", 0.8),), style="chunky"), ("lobster", "crayfish", "hermit crab", "crabby"), "boiled-lobster red armour"),
    "scorpion": (_look("scorpion", "#3b2a1a", "#5e4630", "#1b1208", "#f2a51a", "#1b1208", finish="metal", pattern=("bands", "#5e4630", 0.8),
                       shell=("armor", "#3b2a1a", 1.0), eyes="compound", eye="#f2a51a", acc=(("tail", "#3b2a1a", 1.5), ("spikes", "#f2a51a", 0.8)),
                       style="sleek"), ("scorpions",), "desert bronze with a stinger tail"),
    "caterpillar": (_look("caterpillar", "#7fc241", "#3e6b1a", "#2a4a12", "#f2c230", "#2a4a12", finish="toon", pattern=("bands", "#f2c230", 1.0),
                          eyes="cute", acc=(("antennae", "#2a4a12", 1.0),), style="chunky"), ("centipede", "millipede", "inchworm", "worm"),
                    "chubby green with yellow bands"),
    "starfish": (_look("starfish", "#f08a24", "#f6a94f", "#b85a10", "#fff3e0", "#f6c9a0", finish="matte", pattern=("spots", "#fff3e0", 0.6),
                       eyes="cute", style="chunky", foot="pad"), ("sea star", "patrick"), "coral orange with sandy dots"),
    "flower": (_look("flower", "#f2c230", "#3fa34d", "#2a7a3a", "#f07aa8", "#2a7a3a", shell=("petals", "#f7f7f2", 1.2), eyes="cute",
                     eye="#3b2a1a", acc=(("flower", "#f07aa8", 1.0),), style="sleek", foot="pad"), ("daisy", "blossom", "bloom", "petal"),
               "a daisy: white petals around a sunny centre"),
    "sunflower": (_look("sunflower", "#6b3e1f", "#3fa34d", "#2a7a3a", "#f2c230", "#2a7a3a", pattern=("spots", "#3b2410", 0.5),
                        shell=("petals", "#f2c230", 1.3), eyes="sleepy", style="sleek", foot="pad"), ("sun flower",), "big golden petals"),
    "sakura": (_look("sakura", "#f7c8d8", "#8a5a3b", "#6e472e", "#e86a8a", "#6e472e", pattern=("spots", "#ffffff", 0.6),
                     shell=("petals", "#f7d8e4", 1.1), eyes="cute", eye="#6e472e", acc=(("flower", "#e86a8a", 1.0),), style="sleek", foot="pad"),
               ("cherry blossom", "cherry", "blossoms", "spring", "lotus"), "cherry-blossom pink on dark branches"),
    "mushroom": (_look("mushroom", "#d93a32", "#f3ead2", "#b8ad7a", "#f4f4f2", "#b8ad7a", pattern=("spots", "#f4f4f2", 1.2),
                       shell=("dome", "#d93a32", 1.2), eyes="cute", style="chunky", foot="pad"), ("toadstool", "fungus", "shroom"),
                 "a red toadstool cap with white spots"),
    "robot": (_look("robot", "#c3c8cf", "#8c9196", "#33363b", "#2fc2d6", "#33363b", finish="metal", pattern=("panels", "#8c9196", 1.0),
                    eyes="visor", eye="#2fc2d6", acc=(("antennae", "#33363b", 0.9),), style="chunky"),
              ("mech", "droid", "android", "cyborg", "metal", "machine", "robotic", "battle bot", "battlebot"), "brushed metal panels and a cyan visor"),
    "tank": (_look("tank", "#5b6b3a", "#4a5630", "#2a3018", "#c9a46b", "#2a3018", finish="matte", pattern=("camo", "#3e4a24", 1.2),
                   shell=("armor", "#5b6b3a", 1.1), eyes="visor", eye="#f2a51a", style="chunky", foot="pad"), ("toy tank", "army tank", "panzer"),
             "olive armour in camo"),
    "camo": (_look("camo", "#6f7a2e", "#5a6426", "#33381a", "#b8ad7a", "#33381a", finish="matte", pattern=("camo", "#3e4520", 1.0),
                   eyes="visor", eye="#b8ad7a", acc=(("backpack", "#5a6426", 1.0),), style="chunky", foot="pad"),
             ("army", "military", "soldier", "camouflage", "commando"), "field camo with a little backpack"),
    "candy": (_look("candy", "#f7a8d0", "#a8e6f0", "#f2c230", "#ffffff", "#f07aa8", finish="gloss", pattern=("stripes", "#ffffff", 1.2),
                    eyes="cute", eye="#7c4dbe", acc=(("bow", "#f07aa8", 1.0),), style="chunky"),
              ("sweet", "sweets", "lollipop", "bubblegum", "candy cane", "sugar", "dessert", "cupcake"), "bubblegum pink with candy stripes"),
    "lava": (_look("lava", "#2a1a14", "#3b2418", "#ff6a1a", "#ffb01a", "#1b100c", finish="glow", pattern=("panels", "#ff6a1a", 1.3),
                   eyes="visor", eye="#ffb01a", acc=(("spikes", "#ff6a1a", 1.0),), style="chunky"),
             ("magma", "volcano", "volcanic", "molten", "fire", "fiery", "obsidian"), "cracked obsidian glowing with magma"),
    "ice": (_look("ice", "#cfefff", "#a8dcf5", "#5fb0d8", "#ffffff", "#7cc4f0", finish="gloss", pattern=("gradient", "#ffffff", 1.0),
                  eye="#2f6fd6", acc=(("spikes", "#e8f8ff", 0.8),), style="sleek"),
            ("frost", "frosty", "frozen", "snow", "snowy", "glacier", "crystal", "icy", "winter"), "frosted glacier blue with icicle spikes"),
    "astronaut": (_look("astronaut", "#f4f4f2", "#dfe3e8", "#8c9196", "#f08a24", "#8c9196", pattern=("panels", "#dfe3e8", 0.8),
                        shell=("dome", "#c9e8ff", 1.0), eyes="visor", eye="#f2c230", acc=(("backpack", "#dfe3e8", 1.1), ("antennae", "#8c9196", 0.7)),
                        style="chunky", foot="pad"), ("spacesuit", "space suit", "spaceman", "nasa", "cosmonaut", "moon"),
                  "white space suit, gold visor and a life-support pack"),
    "galaxy": (_look("galaxy", "#1f2f66", "#2a1f5c", "#7c4dbe", "#f4f4f2", "#120c33", finish="glow", pattern=("spots", "#f4f4f2", 0.5),
                     eye="#b9a4e6", style="sleek"), ("space", "cosmic", "stars", "starry", "night sky", "nebula", "universe"),
               "deep-space indigo sprinkled with stars"),
    "neon": (_look("neon", "#1b1b28", "#22223a", "#ff2fa8", "#2ff0e8", "#1b1b28", finish="glow", pattern=("panels", "#2ff0e8", 1.0),
                   eyes="visor", eye="#ff2fa8", acc=(("antennae", "#2ff0e8", 0.8),), style="sleek"),
             ("cyber", "cyberpunk", "synthwave", "tron", "vaporwave", "arcade", "glowing"), "midnight black with hot-pink and cyan neon"),
    "royal": (_look("royal", "#d4a72c", "#f4f4f2", "#8a6a14", "#7c2d8f", "#8a6a14", finish="metal", eye="#7c2d8f",
                    acc=(("crown", "#d4a72c", 1.0),), foot="paw"), ("golden", "king", "queen", "prince", "princess", "luxury", "fancy", "regal"),
              "polished gold with a royal crown"),
    "chrome": (_look("chrome", "#d8dde3", "#b8bfc7", "#5f656b", "#2f6fd6", "#44484c", finish="metal", eyes="visor", eye="#2f6fd6", style="sleek"),
               ("steel", "mirror", "liquid metal", "silver chrome"), "mirror chrome with a blue visor"),
    "pumpkin": (_look("pumpkin", "#f08a24", "#3b2a1a", "#1b1b1f", "#6fbf4a", "#1b1b1f", finish="matte", pattern=("bands", "#d9701a", 1.4),
                      eyes="cyclops", eye="#f2c230", acc=(("hat", "#1b1b1f", 1.0),), style="bones"),
                ("halloween", "spooky", "jack o lantern", "witch"), "jack-o'-lantern orange with a witchy hat"),
    "ghost": (_look("ghost", "#f4f4f8", "#e2e2ea", "#b9b9c8", "#7cc4f0", "#b9b9c8", finish="glow", pattern=("gradient", "#c8d8f0", 1.0),
                    eyes="sleepy", style="bones"), ("ghostly", "phantom", "spirit", "boo"), "pale glowing white, a little spooky"),
    "skeleton": (_look("skeleton", "#1b1b1f", "#f4f4f2", "#d8d8d0", "#f4f4f2", "#f4f4f2", finish="matte", eyes="round", eye="#f2a51a",
                       style="bones"), ("bones", "skull", "bony", "undead"), "black body with bone-white limbs"),
    "rainbow": (_look("rainbow", "#e0301e", "#2f6fd6", "#7c4dbe", "#f2c230", "#3fa34d", finish="gloss", pattern=("stripes", "#f2c230", 1.0),
                      eyes="cute", acc=(("propeller", "#3fa34d", 1.0),), style="chunky"), ("pride", "colorful", "colourful", "multicolor"),
                "every colour at once, plus a propeller hat"),
    "watermelon": (_look("watermelon", "#e8505b", "#3fa34d", "#1f6b2e", "#1b1b1f", "#1f6b2e", pattern=("spots", "#1b1b1f", 0.6),
                         eyes="cute", style="chunky"), ("melon",), "juicy red with seed spots and green rind legs"),
    "strawberry": (_look("strawberry", "#e0301e", "#3fa34d", "#1f6b2e", "#f2c230", "#1f6b2e", finish="gloss", pattern=("spots", "#f2c230", 0.5),
                         eyes="cute", acc=(("flower", "#3fa34d", 0.8),), style="chunky"), ("berry",), "glossy strawberry red with golden seeds"),
    "banana": (_look("banana", "#f6d43a", "#f2c230", "#6b4a1f", "#8a5a3b", "#6b4a1f", eyes="cute"), ("bananas",), "banana yellow, a-peel-ing"),
    "pastel": (_look("pastel", "#9de0c2", "#f7c8d8", "#b9a4e6", "#fff1a8", "#b9a4e6", finish="matte", eyes="cute", eye="#7c4dbe",
                     acc=(("bow", "#f7c8d8", 0.9),)), ("pastels", "cotton candy", "kawaii", "soft colors", "soft colours"), "mint and blush pastels"),
    "firetruck": (_look("firetruck", "#d32f2f", "#c3c8cf", "#33363b", "#f2c230", "#1b1b1f", finish="gloss", pattern=("bands", "#f4f4f2", 0.8),
                        eyes="visor", eye="#f2c230", acc=(("backpack", "#c3c8cf", 0.9),), style="chunky"),
                  ("fire truck", "fire engine", "firefighter", "emergency"), "fire-engine red with chrome trim"),
    "penguin": (_look("penguin", "#1b1b1f", "#1b1b1f", "#f2a51a", "#f4f4f2", "#f2a51a", pattern=("gradient", "#f4f4f2", 1.0),
                      acc=(("bow", "#d93a32", 0.8),), style="chunky", foot="pad"), ("penguins", "tuxedo"), "tuxedo black-and-white with a red bow tie"),
    "flamingo": (_look("flamingo", "#f48fb1", "#f8bbd0", "#c2185b", "#1b1b1f", "#c2185b", acc=(("tail", "#f48fb1", 0.8),), style="bones",
                       foot="pad"), ("pink bird",), "flamingo pink on skinny legs"),
    "shark": (_look("shark", "#6b7f99", "#8fa3bd", "#33465c", "#f4f4f2", "#33465c", finish="gloss", pattern=("gradient", "#f4f4f2", 1.0),
                    acc=(("fin", "#6b7f99", 1.4), ("tail", "#6b7f99", 1.2)), style="sleek", foot="pad"), ("great white", "orca", "whale"),
              "ocean-grey with a dorsal fin"),
    "ocean": (_look("ocean", "#1f8cc0", "#4fd6d0", "#0d4a6b", "#f4f4f2", "#0d4a6b", finish="gloss", pattern=("gradient", "#4fd6d0", 1.0),
                    acc=(("fin", "#4fd6d0", 1.0),), style="sleek", foot="pad"), ("sea", "wave", "waves", "marine", "aqua", "underwater", "beach"),
              "deep blue fading to lagoon teal"),
    "alien": (_look("alien", "#7ee05a", "#5fc23a", "#2a6b1a", "#c8f0ff", "#2a6b1a", finish="glow", shell=("dome", "#c8f0ff", 1.1),
                    eyes="cyclops", acc=(("antennae", "#7ee05a", 1.4),), style="bones"),
              ("martian", "ufo", "extraterrestrial", "outer space"), "radioactive green with one big eye and a glass dome"),
    "cow": (_look("cow", "#f4f4f2", "#f4f4f2", "#1b1b1f", "#f4a6c0", "#1b1b1f", finish="matte", pattern=("spots", "#1b1b1f", 1.5),
                  eyes="sleepy", acc=(("horns", "#e3d5b8", 0.8), ("ears", "#f4f4f2", 0.9), ("tail", "#1b1b1f", 1.0)), style="chunky", foot="hoof"),
            ("cows", "moo", "cattle", "ox", "bull", "yak"), "dairy-cow patches"),
    "toy": (_look("toy", "#f2c230", "#d93a32", "#2f6fd6", "#3fa34d", "#1b1b1f", finish="gloss", acc=(("propeller", "#d93a32", 1.0),),
                  style="chunky"), ("lego", "plastic", "brick", "toybox", "primary colors", "primary colours"), "primary-colour toy plastic"),
    "wooden": (_look("wooden", "#b8834f", "#a06d3e", "#6e472e", "#e3d5b8", "#4a2f1e", finish="matte", pattern=("stripes", "#8a5a3b", 0.6),
                     foot="pad"), ("wood", "oak", "timber", "carved", "pinocchio"), "carved oak with visible grain"),
    "steampunk": (_look("steampunk", "#b8733a", "#8a5a2e", "#4a2f1e", "#d4a72c", "#33231a", finish="metal", pattern=("panels", "#8a5a2e", 0.9),
                        eyes="cyclops", eye="#d4a72c", acc=(("hat", "#33231a", 1.0), ("backpack", "#b8733a", 0.9)), style="chunky"),
                  ("brass", "victorian", "clockwork", "gears"), "brass and copper with a tiny top hat"),
    "ninja": (_look("ninja", "#1b1b1f", "#2a2a2e", "#33363b", "#d93a32", "#1b1b1f", finish="matte", eyes="visor", eye="#d93a32",
                    acc=(("bow", "#d93a32", 0.8),), style="sleek", foot="pad"), ("stealth", "shadow", "samurai"), "stealth black with a red headband"),
    "pirate": (_look("pirate", "#5e3a24", "#33231a", "#1b1b1f", "#d93a32", "#1b1b1f", finish="matte", pattern=("stripes", "#f4f4f2", 0.8),
                     eyes="cyclops", acc=(("hat", "#1b1b1f", 1.1),), foot="pad"), ("pirates", "buccaneer", "captain"), "sea-dog stripes and a captain's hat"),
}

ALIASES = {}
for _key, (_look_value, _aliases, _flavour) in THEMES.items():
    ALIASES[_key] = _key
    for _alias in _aliases:
        ALIASES.setdefault(_alias, _key)

# Everyday words that only mean a look when the user is clearly talking about
# appearance ("make a robot" is a body request; "robot style" is a look).
GENERIC_ALIASES = {
    "robot", "robotic", "machine", "metal", "mech", "droid", "android", "cyborg", "fire", "fiery", "space", "star",
    "stars", "starry", "cosmic", "universe", "sweet", "sweets", "sugar", "dessert", "soft colors", "soft colours",
    "shadow", "stealth", "boo", "moon", "bones", "bony", "skull", "wood", "carved", "sea", "wave", "waves", "beach",
    "underwater", "marine", "aqua", "brick", "plastic", "berry", "cherry", "melon", "magical", "gears", "captain",
    "king", "queen", "prince", "princess", "luxury", "fancy", "regal", "army", "soldier", "military", "commando",
    "spirit", "phantom", "winter", "snow", "snowy", "crystal", "frozen", "icy", "frost", "frosty", "glowing",
    "colorful", "colourful", "multicolor", "toybox", "spring", "emergency", "pride", "jelly", "bloom", "petal",
    "blossom", "blossoms", "bug", "spotted", "mirror", "steel", "molten", "volcanic", "obsidian", "witch", "spooky",
    "undead", "kawaii", "lotus", "moo", "cattle", "bamboo", "jumbo", "dumbo", "patrick", "magma", "volcano",
}

# Chips that, when sent back to Tinker, parse to the same theme.
CHIPS = {
    "ladybug": "Make it look like a ladybug", "tiger": "Paint it like a tiger", "lava": "Make it look like lava",
    "candy": "Candy colours, please", "jade dragon": "Make it look like a jade dragon",
    "astronaut": "Give it an astronaut suit look", "ice": "Make it look icy", "panda": "Make it look like a panda",
    "robot": "Robot style, please", "galaxy": "Galaxy paint job", "neon": "Neon style", "bee": "Dress it as a bumblebee",
    "unicorn": "Make it look like a unicorn", "steampunk": "Steampunk style", "sakura": "Cherry blossom style",
    "dalmatian": "Paint it like a dalmatian", "dragon": "Make it look like a dragon", "alien": "Alien look, please",
    "pumpkin": "Halloween pumpkin style", "chrome": "Chrome finish look",
}


def theme_look(key):
    return copy.deepcopy(THEMES[key][0])


def flavour(key):
    return THEMES[key][2]


def _rgb(hex_color):
    return tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))


def _hex(rgb):
    return "#" + "".join(f"{max(0, min(255, int(round(c)))):02x}" for c in rgb)


def mix(color, other, amount):
    a, b = _rgb(color), _rgb(other)
    return _hex(tuple(x + (y - x) * amount for x, y in zip(a, b)))


def lighten(color, amount=0.3):
    return mix(color, "#ffffff", amount)


def darken(color, amount=0.35):
    return mix(color, "#000000", amount)


def color_name(hex_color):
    """Nearest friendly colour word for replies."""
    try:
        target = _rgb(hex_color)
    except (ValueError, TypeError, IndexError):
        return "custom"
    best, best_distance = "custom", None
    for name, value in NAMED_COLORS.items():
        if name in ("grey",):
            continue
        rgb = _rgb(value)
        distance = sum((a - b) ** 2 for a, b in zip(target, rgb))
        if best_distance is None or distance < best_distance:
            best, best_distance = name, distance
    return best


def palette_from_colors(colors):
    """Build a palette from 1-3 user colours: body, accent, limbs."""
    body = colors[0]
    accent = colors[1] if len(colors) > 1 else lighten(body, 0.55)
    limbs = colors[2] if len(colors) > 2 else lighten(body, 0.25)
    return {"body": body, "limbs": limbs, "joints": darken(body, 0.4), "accent": accent, "feet": darken(body, 0.55)}


def describe_look(look):
    """'glossy red with black spots, a beetle shell, cute eyes and antennae'."""
    if not isinstance(look, dict):
        return "a fresh coat of paint"
    finish = {"gloss": "glossy", "matte": "matte", "satin": "satin", "metal": "metallic", "toon": "toon-shaded",
              "glow": "glowing"}.get(look.get("finish"), "")
    body = (look.get("palette") or {}).get("body")
    words = [w for w in (finish, color_name(body) if body else "") if w]
    text = " ".join(words) or "fresh paint"
    pattern = look.get("pattern") or {}
    if pattern.get("kind") not in (None, "none"):
        color = color_name(pattern["color"]) + " " if pattern.get("color") else ""
        text += f" with {color}{pattern['kind']}"
    extras = []
    shell = look.get("shell") or {}
    if shell.get("kind") not in (None, "none"):
        extras.append(f"a {shell['kind']} shell" if shell["kind"] not in ("petals", "armor") else
                      ("petals" if shell["kind"] == "petals" else "armour plates"))
    eyes = (look.get("face") or {}).get("eyes")
    if eyes and eyes not in ("round", "none"):
        extras.append(f"{eyes} eyes" if eyes != "cyclops" else "one big eye")
    kinds = [a.get("kind") for a in look.get("accessories") or [] if isinstance(a, dict)]
    extras += [{"antennae": "antennae", "horns": "horns", "ears": "ears", "tail": "a tail", "spikes": "spikes",
                "fin": "a fin", "wings": "wings", "crown": "a crown", "hat": "a hat", "bow": "a bow",
                "flower": "a flower", "propeller": "a propeller", "backpack": "a backpack"}.get(k, k) for k in kinds[:3]]
    if extras:
        text += ", " + (", ".join(extras[:-1]) + " and " + extras[-1] if len(extras) > 1 else extras[0])
    return text
