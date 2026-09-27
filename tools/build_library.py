"""
Builds js/library.js for The Bard's Grimoire.

For every theme it runs a few YouTube searches, keeps long-form music/ambience
videos, checks each one is embeddable (via YouTube oEmbed) and writes the result
plus the theme icons (game-icons.net, CC BY 3.0) into a single JS file.

    python tools/build_library.py            # rebuild everything
    python tools/build_library.py --per 20   # more videos per theme
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "js", "library.js")
ICON_CACHE = os.path.join(ROOT, "tools", ".game-icons.json")
ICON_URL = "https://cdn.jsdelivr.net/npm/@iconify-json/game-icons/icons.json"

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

GROUPS = [
    ("charts", "Charts", "What tables around the world play most"),
    ("battle", "Steel & Blood", "When initiative is rolled"),
    ("hearth", "Hearth & Hall", "Towns, taverns and the halls of power"),
    ("wilds", "The Wilds", "Roads, forests, seas and storms"),
    ("depths", "Into the Depths", "Dungeons, darkness and dread"),
    ("story", "Story Beats", "Scenes between the swords"),
    ("beyond", "Beyond the Realm", "For other worlds and other systems"),
]

# id, name, tagline, group, game-icon, hue, search queries
CATEGORIES = [
    ("combat", "Combat", "Swords drawn, dice rolling", "battle", "crossed-swords", 8,
     ["dnd combat music", "ttrpg battle music 1 hour", "fantasy battle music for dnd"]),
    ("boss", "Boss Battle", "The big bad finally shows up", "battle", "dragon-head", 350,
     ["dnd boss battle music", "epic boss fight music ttrpg", "dragon battle music dnd"]),
    ("chase", "Chase & Escape", "Run. Now.", "battle", "sprint", 25,
     ["dnd chase music", "fantasy chase music rpg", "escape music ttrpg tense"]),
    ("villain", "Villain's Lair", "Evil has a home, and a theme song", "battle", "evil-tower", 285,
     ["villain lair music dnd", "dark evil fantasy music villain", "necromancer lair ambience"]),
    ("epic", "Epic & Heroic", "The moment the legend begins", "battle", "sword-brandish", 42,
     ["epic heroic fantasy music dnd", "epic fantasy music heroic 1 hour", "heroic adventure orchestral music rpg"]),

    ("tavern", "Tavern & Inn", "Ale, gossip and a bard in the corner", "hearth", "beer-stein", 34,
     ["dnd tavern music", "medieval tavern ambience", "fantasy inn music 1 hour"]),
    ("town", "Town & Village", "Quiet streets and friendly faces", "hearth", "village", 95,
     ["dnd town music", "medieval village ambience", "fantasy village music peaceful"]),
    ("city", "City & Market", "Crowds, hawkers and cutpurses", "hearth", "tower-flag", 20,
     ["fantasy city ambience dnd", "medieval market ambience", "dnd city music"]),
    ("shop", "Shops & Merchants", "Haggling over a +1 dagger", "hearth", "shop", 48,
     ["dnd shop music", "fantasy shop music", "potion shop ambience"]),
    ("castle", "Castle & Court", "Nobles, ballrooms and politics", "hearth", "castle", 265,
     ["dnd castle music", "royal court music medieval", "fantasy noble ball music"]),
    ("temple", "Temple & Sacred", "Candles, choirs and old gods", "hearth", "angel-wings", 50,
     ["fantasy temple music", "sacred church ambience dnd", "monastery ambience fantasy"]),
    ("dwarven", "Dwarven Halls", "Stone, steel and a forge that never sleeps", "hearth", "anvil", 28,
     ["dwarven music dnd", "dwarf fortress ambience fantasy", "dwarven forge ambience"]),
    ("elven", "Elven Realms", "Starlight, silver and very old songs", "hearth", "elf-ear", 175,
     ["elven city music fantasy", "elven kingdom music", "rivendell ambience"]),

    ("travel", "Travel & Road", "Miles to go before we rest", "wilds", "compass", 150,
     ["dnd travel music", "fantasy adventure travel music", "overland travel music ttrpg"]),
    ("exploration", "Exploration", "What's over that ridge?", "wilds", "treasure-map", 170,
     ["dnd exploration music", "fantasy exploration music", "ttrpg exploration ambience"]),
    ("forest", "Forest & Wilds", "Birdsong and snapping twigs", "wilds", "pine-tree", 120,
     ["dnd forest ambience", "fantasy forest music", "elven forest music"]),
    ("fey", "Feywild & Enchanted", "Beautiful, strange, and a little dangerous", "wilds", "fairy", 300,
     ["feywild music", "fairy forest music magical", "enchanted forest ambience fantasy"]),
    ("sea", "Sea & Sailing", "Salt spray and creaking hulls", "wilds", "galleon", 200,
     ["dnd pirate music", "sailing ship ambience fantasy", "dnd ocean music"]),
    ("desert", "Desert", "Sun, sand and buried empires", "wilds", "camel", 38,
     ["fantasy desert music dnd", "desert ambience fantasy", "arabian fantasy music"]),
    ("winter", "Winter & Mountains", "Frostbite and howling winds", "wilds", "mountains", 195,
     ["dnd winter music", "snowy mountain ambience fantasy", "icewind dale music"]),
    ("swamp", "Swamp & Marsh", "Something moved under the water", "wilds", "swamp", 90,
     ["swamp ambience dnd", "fantasy swamp music", "bog ambience fantasy"]),
    ("storm", "Storm & Weather", "Rain on the shutters, thunder overhead", "wilds", "lightning-storm", 215,
     ["thunderstorm ambience medieval", "rain storm ambience dnd", "fantasy storm music"]),
    ("jungle", "Jungle & Tropics", "Vines, heat and things that watch", "wilds", "palm-tree", 105,
     ["jungle ambience dnd", "fantasy jungle music", "tomb of annihilation music"]),
    ("underwater", "Underwater", "Pressure, silence and the deep", "wilds", "giant-squid", 182,
     ["underwater ambience fantasy", "underwater city music fantasy", "deep sea ambience dnd"]),
    ("sky", "Sky & Airships", "Above the clouds, below the stars", "wilds", "zeppelin", 60,
     ["airship music fantasy", "sky city ambience fantasy", "floating islands music fantasy"]),

    ("dungeon", "Dungeon", "Dripping stone and distant screams", "depths", "dungeon-gate", 30,
     ["dnd dungeon ambience", "dungeon crawl music ttrpg", "dnd dungeon music"]),
    ("underdark", "Caves & Underdark", "No sun has ever touched these halls", "depths", "cave-entrance", 275,
     ["underdark music dnd", "cave ambience dnd", "underground cavern ambience fantasy"]),
    ("horror", "Horror & Dread", "Don't split the party", "depths", "haunting", 0,
     ["dnd horror ambience", "curse of strahd music", "creepy ambience ttrpg"]),
    ("crypt", "Crypts & Undead", "The dead do not rest here", "depths", "skull-crossed-bones", 160,
     ["crypt ambience dnd", "undead music fantasy", "graveyard ambience dnd"]),
    ("ruins", "Ruins & Lost Cities", "What was here before us?", "depths", "ancient-ruins", 35,
     ["ancient ruins ambience dnd", "lost city music fantasy", "abandoned ruins music ttrpg"]),
    ("volcano", "Volcano & Infernal", "Brimstone, lava and bad bargains", "depths", "volcano", 15,
     ["volcano ambience dnd", "lava cave ambience fantasy", "infernal hell ambience dnd"]),

    ("planning", "Planning & Downtime", "Background music for arguing about the plan", "story", "quill-ink", 40,
     ["dnd planning music", "calm fantasy music for dnd downtime", "relaxing dnd background music"]),
    ("camp", "Campfire & Rest", "Long rest, short stories", "story", "campfire", 22,
     ["dnd campfire ambience", "long rest music dnd", "campfire ambience fantasy night"]),
    ("mystery", "Mystery & Investigation", "Something doesn't add up", "story", "magnifying-glass", 230,
     ["dnd mystery music", "investigation music ttrpg", "mystery ambience fantasy"]),
    ("stealth", "Stealth & Heist", "Roll with advantage. Please.", "story", "cloak-dagger", 255,
     ["dnd stealth music", "fantasy heist music", "sneaking music rpg"]),
    ("puzzle", "Puzzles & Riddles", "Speak, friend, and enter", "story", "jigsaw-box", 185,
     ["dnd puzzle music", "riddle music rpg", "thinking music fantasy puzzle"]),
    ("arcane", "Magic & Arcane", "Wizard towers and forbidden libraries", "story", "spell-book", 260,
     ["wizard tower ambience", "magic library ambience dnd", "arcane magic music fantasy"]),
    ("sorrow", "Sorrow & Loss", "For the fallen", "story", "broken-heart", 220,
     ["sad fantasy music dnd", "fantasy funeral music", "emotional sad music rpg"]),
    ("victory", "Victory & Feast", "We did it! Now, loot.", "story", "laurels-trophy", 45,
     ["victory music epic fantasy", "fantasy celebration music feast", "medieval festival music"]),

    ("scifi", "Sci-Fi & Space", "Starships, stations and the void", "beyond", "spaceship", 190,
     ["sci-fi ambience starship", "space ambience music ttrpg", "starfinder music"]),
    ("cyberpunk", "Cyberpunk & Neon", "Chrome, rain and bad decisions", "beyond", "cyber-eye", 310,
     ["cyberpunk ambience music", "cyberpunk red music ttrpg", "neon city ambience rain"]),
    ("cosmic", "Cosmic Horror", "Call of Cthulhu, sanity checks included", "beyond", "cultist", 140,
     ["call of cthulhu ambience", "lovecraftian horror ambience", "cosmic horror music"]),
    ("western", "Wild West", "Dust, spurs and six-shooters", "beyond", "cash", 30,
     ["western ambience music", "wild west saloon music", "western ttrpg music"]),
    ("norse", "Norse & Viking", "Shield walls and longships", "beyond", "drakkar", 210,
     ["viking ambience music", "norse epic music", "nordic folk music fantasy"]),
    ("eastern", "Eastern & Wuxia", "Temples, blossoms and blades", "beyond", "pagoda", 340,
     ["japanese fantasy music ambience", "wuxia music", "samurai music ambience"]),
    ("steampunk", "Steampunk & Clockwork", "Brass, steam and bad ideas", "beyond", "gears", 25,
     ["steampunk ambience music", "steampunk city music", "clockwork city ambience"]),
]

# Extra searches used when topping up an existing theme with --add, so it finds
# videos beyond the first page of the original searches.
EXTRA_QUERIES = {
    "combat": ["rpg battle music 1 hour", "dnd fight music epic"],
    "boss": ["final boss music fantasy orchestral", "dnd lich boss fight music"],
    "chase": ["chase music ttrpg 1 hour", "pursuit music fantasy tense"],
    "villain": ["dark lord theme music fantasy", "villain ambience dnd"],
    "epic": ["epic orchestral music dnd session", "heroic fantasy music 1 hour"],
    "tavern": ["tavern ambience dnd 1 hour", "medieval inn music bard"],
    "town": ["fantasy town ambience dnd", "peaceful village music rpg"],
    "city": ["medieval city ambience 1 hour", "fantasy capital city music"],
    "shop": ["blacksmith shop ambience fantasy", "magic shop music fantasy"],
    "castle": ["castle ambience dnd", "throne room music fantasy"],
    "temple": ["cathedral ambience fantasy", "holy temple music dnd"],
    "dwarven": ["dwarven mines ambience", "dwarf kingdom music fantasy"],
    "elven": ["elven music ambience", "elf village music fantasy"],
    "travel": ["travel music rpg fantasy", "road trip fantasy music dnd"],
    "exploration": ["exploration music rpg 1 hour", "adventure exploration ambience fantasy"],
    "forest": ["forest ambience fantasy rpg", "druid grove music"],
    "fey": ["fairy music ambience", "fey realm music dnd"],
    "sea": ["sea shanty instrumental dnd", "ship at sea ambience"],
    "desert": ["desert music rpg", "desert travel ambience fantasy"],
    "winter": ["winter ambience fantasy", "frozen north music fantasy"],
    "swamp": ["swamp music dnd", "marsh ambience fantasy"],
    "storm": ["storm ambience fantasy", "rain ambience medieval"],
    "jungle": ["jungle music rpg", "tropical island ambience fantasy"],
    "underwater": ["underwater music rpg", "sunken city ambience"],
    "sky": ["sky music rpg fantasy", "floating castle ambience"],
    "dungeon": ["dungeon music 1 hour", "dungeon crawl ambience"],
    "underdark": ["underdark ambience", "cave music rpg"],
    "horror": ["horror ambience rpg", "haunted house ambience dnd"],
    "crypt": ["tomb ambience fantasy", "necropolis music dnd"],
    "ruins": ["ruins music rpg", "forgotten temple ambience"],
    "volcano": ["volcano music rpg", "fire giant lair ambience"],
    "planning": ["background music for dnd session calm", "rpg downtime music"],
    "camp": ["campfire music rpg", "night camp ambience fantasy"],
    "mystery": ["mystery music rpg 1 hour", "detective ambience fantasy"],
    "stealth": ["stealth music rpg 1 hour", "thieves guild music"],
    "puzzle": ["puzzle music rpg", "mysterious puzzle music fantasy"],
    "arcane": ["magic academy ambience", "mage tower music"],
    "sorrow": ["sad music rpg", "melancholy fantasy music"],
    "victory": ["victory fanfare music fantasy", "feast hall ambience medieval"],
    "scifi": ["sci fi ambience music rpg", "starship bridge ambience"],
    "cyberpunk": ["cyberpunk music rpg", "cyberpunk city ambience"],
    "cosmic": ["cosmic horror music", "lovecraft ambience"],
    "western": ["western music rpg", "cowboy campfire ambience"],
    "norse": ["viking music rpg", "nordic ambience"],
    "eastern": ["japanese ambience music", "chinese fantasy music"],
    "steampunk": ["steampunk music rpg", "victorian steampunk ambience"],
}

# New additions need at least this many views, which weeds out spam re-uploads.
MIN_VIEWS = 2000

# ---------------------------------------------------------------------------
# Hashtags. A video gets a tag when its title contains one of the tag's words
# (a trailing "s" is also accepted). The site's search uses the same word lists,
# so typing "ruins", "abandoned" or "#ruins" all find the same videos.
# Order matters: cards show the first few matching tags, so specific tags come
# before broad mood/sound tags.
# ---------------------------------------------------------------------------
TAGS = [
    # creatures & peoples
    ("dragon", ["dragon", "wyrm", "drake", "dragonlance", "dragonstorm"]),
    ("undead", ["undead", "zombie", "skeleton", "ghoul", "lich", "necromancer", "necromancy", "the dead", "dead kings"]),
    ("vampire", ["vampire", "strahd", "barovia", "dracula"]),
    ("ghost", ["ghost", "haunted", "haunting", "spectral", "phantom"]),
    ("demon", ["demon", "devil", "hell", "infernal", "avernus", "abyss", "fiend"]),
    ("witch", ["witch", "witches", "hag", "witchcraft", "coven"]),
    ("wizard", ["wizard", "mage", "sorcerer", "sorcery", "arcane", "spell", "spellbook"]),
    ("elven", ["elf", "elves", "elven", "sylvan", "rivendell", "lothlorien"]),
    ("dwarven", ["dwarf", "dwarves", "dwarven", "forge", "blacksmith", "mines", "mining", "moria", "khazad"]),
    ("fairy", ["fey", "feywild", "fairy", "fairies", "fae", "faerie", "pixie"]),
    ("pirate", ["pirate", "shanty", "shanties", "buccaneer", "caribbean"]),
    ("knight", ["knight", "paladin", "crusade", "crusader"]),
    ("barbarian", ["barbarian", "orc", "warrior", "warpath"]),
    ("thieves", ["thief", "thieves", "rogue", "assassin", "heist", "cutpurse"]),
    ("cthulhu", ["cthulhu", "lovecraft", "lovecraftian", "eldritch", "innsmouth", "arkham", "dunwich", "azathoth", "cosmic horror"]),
    # places
    ("ruins", ["ruin", "ruined", "abandoned", "lost temple", "lost city", "lost palace", "lost kingdom",
               "ancient city", "ancient temple", "ancient tomb", "forgotten temple", "forgotten city", "fallen kingdom"]),
    ("tavern", ["tavern", "inn", "pub", "ale", "saloon", "alehouse"]),
    ("market", ["market", "bazaar", "marketplace", "merchant", "shop", "shopping", "store", "trade"]),
    ("potion", ["potion", "apothecary", "alchemy", "alchemist", "herbalist", "cauldron"]),
    ("library", ["library", "libraries", "scriptorium", "archive", "tome", "academy"]),
    ("castle", ["castle", "fortress", "citadel", "palace", "throne"]),
    ("royal", ["royal", "king", "queen", "court", "noble", "ball", "ballroom", "gala", "baroque", "banquet", "crown"]),
    ("church", ["church", "cathedral", "monastery", "abbey", "chapel", "sanctum", "sanctuary", "sacred", "holy",
                "temple", "shrine", "cleric", "gregorian"]),
    ("city", ["city", "cities", "capital", "streets", "metropolis", "waterdeep", "baldur's gate"]),
    ("village", ["village", "town", "hamlet"]),
    ("dungeon", ["dungeon", "prison", "jail", "jailbreak", "labyrinth", "catacomb", "dungeon synth"]),
    ("tomb", ["tomb", "crypt", "grave", "graveyard", "cemetery", "necropolis", "mausoleum"]),
    ("cave", ["cave", "cavern", "underground", "underdark", "subterranean", "drow"]),
    ("forest", ["forest", "woods", "woodland", "grove", "trees", "druid"]),
    ("jungle", ["jungle", "tropical", "tropics", "rainforest", "chult", "annihilation"]),
    ("underwater", ["underwater", "sunken", "coral", "mermaid", "atlantis", "deep sea", "abyssal", "reef", "undersea"]),
    ("sky", ["sky", "skies", "airship", "skyship", "zeppelin", "clouds", "floating island", "floating castle", "sky city"]),
    ("volcano", ["volcano", "volcanic", "lava", "magma", "molten", "brimstone", "fire giant"]),
    ("swamp", ["swamp", "marsh", "marshes", "bog", "bayou", "wetlands", "fen"]),
    ("desert", ["desert", "sand", "dunes", "oasis", "arabian", "djinn", "sunworn"]),
    ("mountain", ["mountain", "mountain pass", "peak", "highlands", "cliff"]),
    ("winter", ["winter", "snow", "snowy", "snowing", "ice", "icy", "frost", "frozen", "blizzard", "arctic",
                "icewind", "glacier", "frostlands", "frostmaiden", "cold"]),
    ("sea", ["sea", "ocean", "sailing", "sail", "ship", "boat", "harbor", "harbour", "port", "shore", "coast",
             "coastal", "nautical", "voyage", "waves"]),
    ("space", ["space", "spaceship", "starship", "sci-fi", "scifi", "galactic", "galaxy", "astral",
               "spelljammer", "spelljammers", "starfinder", "interplanetary"]),
    ("cyberpunk", ["cyberpunk", "neon", "cyber", "blade runner", "dystopian", "synthwave", "night city"]),
    ("western", ["western", "cowboy", "wild west", "old west", "frontier", "outlaw", "red dead"]),
    ("steampunk", ["steampunk", "clockwork", "arcanepunk", "victorian", "brass", "gears"]),
    # weather, time, nature
    ("rain", ["rain", "rainy", "rainstorm", "raindrop", "drizzle"]),
    ("storm", ["storm", "stormy", "thunder", "thunderstorm", "lightning", "tempest", "hurricane"]),
    ("fire", ["fire", "fireplace", "hearth", "campfire", "flame", "ember", "burning", "fireside"]),
    ("night", ["night", "midnight", "moon", "moonlight", "moonlit", "nightfall", "evening", "dusk"]),
    ("water", ["water", "waterfall", "river", "lake", "stream", "deep waters"]),
    ("nature", ["nature", "birds", "birdsong", "crickets", "owl", "frogs", "wind", "windy"]),
    # scenes
    ("battle", ["battle", "combat", "fight", "fighting", "war", "warfare", "skirmish", "clash", "attack", "siege", "encounter"]),
    ("boss", ["boss", "final battle", "showdown"]),
    ("chase", ["chase", "escape", "pursuit", "run", "fleeing"]),
    ("stealth", ["stealth", "stealthy", "sneak", "sneaking", "sneaky", "infiltration", "spy"]),
    ("mystery", ["mystery", "mysteries", "mysterious", "investigation", "investigating", "detective", "secret",
                 "clue", "noir", "murder"]),
    ("puzzle", ["puzzle", "riddle", "thinking"]),
    ("planning", ["planning", "plotting", "plan", "negotiation", "negotiations", "negotiating", "talks",
                  "strategist", "war room", "downtime"]),
    ("travel", ["travel", "traveling", "travelling", "traveler", "journey", "road", "wander", "wandering",
                "wanderings", "caravan", "trail", "expedition"]),
    ("exploration", ["exploration", "explore", "exploring", "discovery", "adventure", "quest"]),
    ("rest", ["rest", "resting", "long rest", "camp", "camping"]),
    ("celebration", ["celebration", "festival", "feast", "party", "victory", "triumph", "dance", "merry",
                     "jolly", "upbeat", "parade"]),
    # moods
    ("epic", ["epic", "heroic", "hero", "heroes", "legend", "legendary", "glory", "powerful", "majestic"]),
    ("horror", ["horror", "creepy", "scary", "eerie", "dread", "spooky", "terror", "nightmare", "sinister",
                "halloween", "cursed", "curse"]),
    ("dark", ["dark", "darkness", "grim", "grimdark", "shadow", "shadowfell", "gloom", "gloomy", "evil", "villain"]),
    ("tense", ["tense", "tension", "suspense", "danger", "dangerous", "stressful", "intense"]),
    ("sad", ["sad", "sorrow", "grief", "mourning", "funeral", "tragedy", "farewell", "emotional", "melancholy",
             "lament", "heartbreak", "heartbreaking"]),
    ("calm", ["calm", "peaceful", "relaxing", "relax", "relaxation", "serene", "cozy", "gentle", "soothing",
              "tranquil", "quiet", "chill", "meditation"]),
    ("whimsical", ["whimsical", "quirky", "funny", "comical", "playful"]),
    ("mystical", ["mystical", "magical", "magic", "enchanted", "enchanting", "ethereal", "celestial"]),
    # sound & style
    ("ambience", ["ambience", "ambient", "soundscape", "asmr", "sounds", "atmosphere"]),
    ("no-music", ["no music"]),
    ("orchestral", ["orchestral", "orchestra", "symphony", "symphonic", "cinematic"]),
    ("celtic", ["celtic", "irish", "folk"]),
    ("medieval", ["medieval", "renaissance", "middle ages"]),
    ("choir", ["choir", "chant", "hymn", "vocal", "vocals"]),
    ("piano", ["piano", "ragtime"]),
    ("strings", ["lute", "harp", "violin", "guitar", "oud"]),
    ("drums", ["drum", "drums", "percussion"]),
    ("flute", ["flute"]),
    ("norse", ["viking", "norse", "nordic", "valhalla", "skald", "longship"]),
    ("eastern", ["japanese", "oni", "samurai", "chinese", "eastern", "wuxia", "pagoda", "bamboo", "kyoto", "zen", "shogun"]),
    # sources
    ("video-game", ["skyrim", "witcher", "baldur", "warcraft", "elder scrolls", "mass effect", "cyberpunk 2077",
                    "red dead redemption", "zelda", "final fantasy"]),
    ("dnd-module", ["curse of strahd", "icewind dale", "rime of the frostmaiden", "dragon heist", "golden vault",
                    "avernus", "shadow of the dragon queen", "spelljammer"]),
    ("no-ai", ["no ai", "non-ai", "not ai"]),
    ("popular", []),  # in the Most Popular chart
    ("long", []),  # 3 hours or more, added from the video length
]

# Every video in a theme also gets that theme's tag, so #tavern finds all tavern tracks.
CATEGORY_TAG = {
    "combat": "battle", "boss": "boss", "chase": "chase", "villain": "dark", "epic": "epic",
    "tavern": "tavern", "town": "village", "city": "city", "shop": "market", "castle": "castle",
    "temple": "church", "travel": "travel", "exploration": "exploration", "forest": "forest",
    "fey": "fairy", "sea": "sea", "desert": "desert", "winter": "winter", "swamp": "swamp",
    "storm": "storm", "dungeon": "dungeon", "underdark": "cave", "horror": "horror", "crypt": "tomb",
    "planning": "planning", "camp": "rest", "mystery": "mystery", "stealth": "stealth",
    "puzzle": "puzzle", "arcane": "wizard", "sorrow": "sad", "victory": "celebration",
    "scifi": "space", "cyberpunk": "cyberpunk", "cosmic": "cthulhu", "western": "western",
    "dwarven": "dwarven", "elven": "elven", "jungle": "jungle", "underwater": "underwater", "sky": "sky",
    "ruins": "ruins", "volcano": "volcano", "norse": "norse", "eastern": "eastern", "steampunk": "steampunk",
    "popular": "popular",
}

# ---------------------------------------------------------------------------
# "Most Popular" chart: the most-viewed TTRPG music, from YouTube searches
# sorted by view count plus everything already in the library. Only titles that
# are clearly TTRPG count, so giant generic "relaxing music" videos don't win.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# The big catalogue (tools/catalog.py): ~375 more themes in 12 more groups, each
# with its own hashtag, plus extra hashtags. Hashtags also get a "facet" so the
# site can list them by kind (creatures, places, moods…).
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import catalog  # noqa: E402

FACETS = {"creatures": "Creatures", "places": "Places", "planes": "Places", "scenes": "Scenes",
          "moods": "Moods", "weather": "Weather & time", "realms": "Cultures", "classes": "Characters",
          "settings": "Settings", "systems": "Game systems", "sounds": "Sounds", "soundtracks": "Soundtracks"}
FACET_ORDER = ["Creatures", "Places", "Characters", "Settings", "Game systems", "Soundtracks", "Cultures",
               "Scenes", "Weather & time", "Moods", "Sounds", "More", "Sources"]
# facets for the original hashtags, by the first tag of each block in TAGS
_BLOCKS = [("dragon", "Creatures"), ("ruins", "Places"), ("rain", "Weather & time"), ("battle", "Scenes"),
           ("epic", "Moods"), ("ambience", "Sounds"), ("video-game", "Sources")]
TAG_FACET = {}
_facet = "More"
for _t, _ in TAGS:
    _facet = dict(_BLOCKS).get(_t, _facet)
    TAG_FACET[_t] = _facet

GENERIC_WORDS = {"music", "ambience", "ambient", "dnd", "fantasy", "rpg", "medieval", "theme", "sounds",
                 "soundtrack", "relaxing", "battle", "ost", "game", "rpg", "at", "night", "the"}
KEYWORDS = {}      # theme id -> phrases that mark a result as clearly on-topic
GROUP_ORDER = ["charts", "battle", "hearth", "wilds", "depths", "story", "creatures", "places", "scenes",
               "moods", "weather", "planes", "realms", "classes", "settings", "systems", "beyond",
               "sounds", "soundtracks"]
_tag_index = {t: i for i, (t, _) in enumerate(TAGS)}
for gid, gname, gtag, gicon, templates in catalog.GROUPS:
    GROUPS.append((gid, gname, gtag))
    for entry in catalog.THEMES[gid]:
        tid, name, tagline, icon, q = entry[:5]
        aliases = list(entry[5]) if len(entry) > 5 else []
        phrase = " ".join(w for w in q.split() if w.lower() not in GENERIC_WORDS) or q
        hue = int(hashlib.md5(tid.encode()).hexdigest()[:4], 16) % 360
        CATEGORIES.append((tid, name, tagline, gid, icon, hue, [t.format(q=q) for t in templates]))
        words = sorted({phrase.lower(), *[a.lower() for a in aliases]})
        KEYWORDS[tid] = words
        if tid in _tag_index:                       # a hashtag with this name exists: extend it
            TAGS[_tag_index[tid]] = (tid, sorted(set(TAGS[_tag_index[tid]][1]) | set(words)))
        else:
            _tag_index[tid] = len(TAGS)
            TAGS.append((tid, words))
            TAG_FACET[tid] = FACETS[gid]
        CATEGORY_TAG[tid] = tid
for _t, _words in catalog.EXTRA_TAGS:
    if _t in _tag_index:
        TAGS[_tag_index[_t]] = (_t, sorted(set(TAGS[_tag_index[_t]][1]) | set(_words)))
    else:
        _tag_index[_t] = len(TAGS)
        TAGS.append((_t, _words))
        TAG_FACET[_t] = "More"
GROUPS.sort(key=lambda g: GROUP_ORDER.index(g[0]) if g[0] in GROUP_ORDER else len(GROUP_ORDER))
# cards show a video's first few hashtags: specific ones (creatures, places…) before moods and sounds
TAG_RANK = {t: (FACET_ORDER.index(TAG_FACET.get(t, "More")), i) for i, (t, _) in enumerate(TAGS)}
# the original themes' keywords come from their own hashtag's words
for _cid, *_rest in CATEGORIES:
    if _cid not in KEYWORDS:
        KEYWORDS[_cid] = dict(TAGS).get(CATEGORY_TAG[_cid], [])

POPULAR = ("popular", "Most Popular", "The most-viewed TTRPG music on YouTube", "charts", "podium-winner", 45)
POPULAR_SIZE = 100
MARATHON = ("marathon", "Marathon Mixes", "Three hours or more: press play and forget about it", "charts", "hourglass", 265)
MARATHON_SIZE = 80
CATEGORY_TAG["marathon"] = "long"
POPULAR_QUERIES = [
    "dnd music", "d&d music", "dnd ambience", "ttrpg music", "dnd battle music", "dnd tavern music",
    "dnd combat music", "tabletop rpg music", "dungeons and dragons music", "rpg ambience", "dnd background music",
    "dnd boss music", "dnd horror music", "pathfinder music", "dnd epic music", "rpg music 1 hour",
]
TTRPG_TITLE = re.compile(
    r"(?<!\w)(?:d ?& ?d|dnd|dungeons? ?(?:&|and|n') ?dragons|ttrpg|rpg|tabletop|pathfinder (?:rpg|2e|ttrpg)|5e|dungeon master|"
    r"call of cthulhu|critical role|starfinder|shadowrun|warhammer|curse of strahd|baldur'?s gate)(?!\w)", re.I)

# One combined pattern for every hashtag word, instead of 600+ separate regex searches per title.
_TAG_BY_WORD = {}
for _t, _words in TAGS:
    for _w in _words:
        _TAG_BY_WORD.setdefault(_w.lower(), []).append(_t)
_ALL_WORDS_RE = re.compile(r"(?<!\w)(" + "|".join(re.escape(w) for w in sorted(_TAG_BY_WORD, key=len, reverse=True))
                           + r")s?(?!\w)", re.I)


def tag_video(v, cat_id):
    title = v["title"].replace("’", "'")
    # the game's name says nothing about the scene: don't tag every "Dungeons & Dragons" title #dragon #dungeon
    title = re.sub(r"dungeons? ?(?:&|and|n') ?dragons", " ", title, flags=re.I)
    tags = set()
    # try every word start, so overlapping phrases all count ("red dragon" and "dragon")
    for pos in range(len(title)):
        if pos and title[pos - 1].isalnum():
            continue
        m = _ALL_WORDS_RE.match(title, pos)
        if m:
            tags.update(_TAG_BY_WORD.get(m.group(1).lower(), []))
            # a shorter phrase may also start here ("dragon" vs "dragon age"): check each length
            for w in _TAG_BY_WORD:
                if len(w) < len(m.group(1)) and title[pos:pos + len(w)].lower() == w and \
                        (pos + len(w) == len(title) or not title[pos + len(w)].isalnum() or title[pos + len(w)] in "sS"):
                    tags.update(_TAG_BY_WORD[w])
    tags.add(CATEGORY_TAG[cat_id])
    if v["length"] >= 3 * 3600:
        tags.add("long")
    v["tags"] = sorted(tags, key=lambda t: TAG_RANK.get(t, (99, 0)))
    return v


# Off-topic results that slipped through the searches in the past.
OFF_TOPIC = re.compile(r"club penguin|parody|sudoku|word search|puzzle lovers|chris ramsay|riddle of fire|"
                       r"empty life|relax jazz music|- topic$", re.I)

JUNK = re.compile(r"reaction|#shorts|\breview\b|how to|tutorial|walkthrough|gameplay|trailer|podcast|"
                  r"actual play|episode|\bep\.? ?\d|live stream|let's play|explained|lore|\bguide\b", re.I)


# Pop/metal music videos that merely share a theme's word ("Limbo", "Afterlife", "The Last Stand")
# are only kept if the title also says it's tabletop/fantasy music — fan D&D songs say so, band videos don't.
SONG_VIDEO = re.compile(r"official (?:music |lyric |lyrics )?video|official audio|\(official|\blyrics?\b|\bletra\b|\bmv\b", re.I)
TTRPG_MARKERS = re.compile(r"d ?& ?d|dnd|ttrpg|\brpg|tabletop|fantasy|\bbard|tavern|medieval|dungeon|dragon|ambien|asmr|"
                           r"soundscape|\bost\b|soundtrack|instrumental|celtic|orchestral|music for|campaign|adventure", re.I)
NOT_FOR_THE_TABLE = re.compile(r"kids? songs?|nursery|brain break|rap battle|\brap\b|real vs|size comparison|workout|\bgym\b|"
                               r"\blego\b|universal kids|\btrap\b|emotional healing|anxiety relief|trolls movie", re.I)
MIN_THEME_TRACKS = 4  # thinner themes stay hidden until a later run finds more


def acceptable(v):
    t = v["title"]
    if NOT_FOR_THE_TABLE.search(t):
        return False
    return not (SONG_VIDEO.search(t) and not TTRPG_MARKERS.search(t))


def parse_len(s):
    if not s:
        return 0
    secs = 0
    for part in s.split(":"):
        secs = secs * 60 + int(part)
    return secs


def parse_views(v):
    if not v:
        return 0
    text = v.get("simpleText") or "".join(r.get("text", "") for r in v.get("runs", []))
    digits = re.sub(r"[^\d]", "", text)
    return int(digits) if digits else 0


def iter_renderers(o):
    if isinstance(o, dict):
        if "videoRenderer" in o:
            yield o["videoRenderer"]
        for v in o.values():
            yield from iter_renderers(v)
    elif isinstance(o, list):
        for x in o:
            yield from iter_renderers(x)


def search(query, by_views=False):
    url = "https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(query)
    if by_views:
        url += "&sp=CAM%3D"  # YouTube's "sort by view count" filter
    for attempt in range(3):
        try:
            html = requests.get(url, headers=UA, timeout=20).text
            m = re.search(r"var ytInitialData = (\{.*?\});</script>", html)
            if not m:
                raise ValueError("no ytInitialData")
            data = json.loads(m.group(1))
            break
        except Exception as e:  # noqa: BLE001
            print(f"  ! search retry ({query}): {e}", file=sys.stderr)
            time.sleep(2 + attempt * 2)
    else:
        return []

    out = []
    for r in iter_renderers(data):
        title = "".join(x.get("text", "") for x in r.get("title", {}).get("runs", []))
        length = parse_len(r.get("lengthText", {}).get("simpleText"))
        if not r.get("videoId") or not title or length < 180 or JUNK.search(title):
            continue
        channel = (r.get("ownerText", {}).get("runs") or [{}])[0].get("text", "")
        if OFF_TOPIC.search(title) or OFF_TOPIC.search(channel):
            continue
        out.append({
            "id": r["videoId"],
            "title": title,
            "channel": channel,
            "length": length,
            "views": parse_views(r.get("viewCountText")),
        })
    return out


def embeddable(vid):
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(
        f"https://www.youtube.com/watch?v={vid}")
    for _ in range(3):
        try:
            return requests.get(url, headers=UA, timeout=15).status_code == 200
        except requests.RequestException:
            time.sleep(1)
    return False


# ---------------------------------------------------------------------------
# Big runs: several result pages per search, cached on disk so an interrupted
# run picks up where it stopped (tools/.cache/, safe to delete).
# ---------------------------------------------------------------------------
CACHE_DIR = os.path.join(ROOT, "tools", ".cache")
_cache_lock = threading.Lock()


class DiskCache:
    def __init__(self, name):
        self.path = os.path.join(CACHE_DIR, name)
        self.data = {}
        if os.path.exists(self.path):
            with open(self.path, encoding="utf8") as f:
                self.data = json.load(f)
        self.dirty = 0

    def get(self, k):
        return self.data.get(k)

    def put(self, k, v):
        with _cache_lock:
            self.data[k] = v
            self.dirty += 1
            if self.dirty >= 25:
                self.save_locked()

    def save_locked(self):
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(self.data, f, ensure_ascii=False)
        os.replace(tmp, self.path)
        self.dirty = 0

    def save(self):
        with _cache_lock:
            self.save_locked()


_innertube = {}


def _videos_from(data):
    out = []
    for r in iter_renderers(data):
        title = "".join(x.get("text", "") for x in r.get("title", {}).get("runs", []))
        length = parse_len(r.get("lengthText", {}).get("simpleText"))
        if not r.get("videoId") or not title or length < 180 or JUNK.search(title):
            continue
        channel = (r.get("ownerText", {}).get("runs") or [{}])[0].get("text", "")
        if OFF_TOPIC.search(title) or OFF_TOPIC.search(channel) or not acceptable({"title": title}):
            continue
        out.append({"id": r["videoId"], "title": title, "channel": channel, "length": length,
                    "views": parse_views(r.get("viewCountText"))})
    return out


def _walk_key(o, key):
    if isinstance(o, dict):
        if key in o:
            yield o[key]
        for v in o.values():
            yield from _walk_key(v, key)
    elif isinstance(o, list):
        for x in o:
            yield from _walk_key(x, key)


def search_pages(query, pages=2):
    """Page 1 from the results page, then more pages through YouTube's own 'load more' requests."""
    for attempt in range(4):
        try:
            html = requests.get("https://www.youtube.com/results?search_query=" + urllib.parse.quote_plus(query),
                                headers=UA, timeout=20).text
            m = re.search(r"var ytInitialData = (\{.*?\});</script>", html)
            if not m:
                raise ValueError("no results page (rate limited?)")
            data = json.loads(m.group(1))
            if "key" not in _innertube:
                k = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
                v = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
                if k and v:
                    _innertube.update(key=k.group(1), version=v.group(1))
            break
        except Exception as e:  # noqa: BLE001
            print(f"  ! search retry ({query}): {e}", file=sys.stderr, flush=True)
            time.sleep(5 * (attempt + 1) ** 2)  # back off harder each time
    else:
        return None  # give up for now; not cached, so a later run tries again
    out = _videos_from(data)
    token = next((c.get("token") for c in _walk_key(data, "continuationCommand")), None)
    for _ in range(pages - 1):
        if not token or "key" not in _innertube:
            break
        try:
            r = requests.post(f"https://www.youtube.com/youtubei/v1/search?key={_innertube['key']}&prettyPrint=false",
                              headers={**UA, "Content-Type": "application/json"}, timeout=20,
                              json={"context": {"client": {"clientName": "WEB", "clientVersion": _innertube["version"],
                                                           "hl": "en", "gl": "US"}}, "continuation": token})
            d = r.json()
        except Exception:  # noqa: BLE001
            break
        out += _videos_from(d)
        token = next((c.get("token") for c in _walk_key(d, "continuationCommand")), None)
        time.sleep(0.3)
    return out


def rank_candidates(cid, lists):
    """Interleave each query's results; on-topic titles first, then only YouTube's top picks."""
    words = [w.lower() for w in KEYWORDS.get(cid, []) if w]
    rx = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(w) for w in words) + r")", re.I) if words else None
    strong, weak, ids = [], [], set()
    for i in range(max((len(x) for x in lists), default=0)):
        for lst in lists:
            if i < len(lst) and lst[i]["id"] not in ids:
                v = lst[i]
                ids.add(v["id"])
                if rx is None or rx.search(v["title"].replace("’", "'")):
                    strong.append(v)
                elif i < 6:
                    weak.append(v)
    return strong + weak


def load_icons():
    if not os.path.exists(ICON_CACHE):
        print("Downloading game-icons set…")
        with open(ICON_CACHE, "w", encoding="utf8") as f:
            f.write(requests.get(ICON_URL, timeout=60).text)
    with open(ICON_CACHE, encoding="utf8") as f:
        return json.load(f)["icons"]


def write_library(cats, icon_bodies):
    """cats carry icon *names*; each icon's SVG is stored once in the payload (many themes share one)."""
    chart_ids = {v["id"] for c in cats if c["id"] == "popular" for v in c["videos"]}
    for c in cats:
        for v in c["videos"]:
            tag_video(v, c["id"])
            if v["id"] in chart_ids and "popular" not in v["tags"]:
                # the same track inside its own theme is marked #popular too
                v["tags"] = sorted(v["tags"] + ["popular"], key=lambda t: TAG_RANK.get(t, (99, 0)))
    for c in cats:
        c["videos"] = [v for v in c["videos"] if acceptable(v)]
    # themes still waiting for enough tracks stay hidden (the charts are always shown)
    cats = [c for c in cats if len(c["videos"]) >= MIN_THEME_TRACKS or (c.get("group") == "charts" and c["videos"])]
    used = {c["icon"] for c in cats}
    payload = {
        "generated": dt.date.today().isoformat(),
        "groups": [{"id": g, "name": n, "tagline": t} for g, n, t in GROUPS],
        "tags": [[t, words, TAG_FACET.get(t, "More")] for t, words in TAGS],
        "facets": FACET_ORDER,
        "icons": {name: icon_bodies[name] for name in sorted(used) if name in icon_bodies},
        "categories": cats,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        f.write("// Generated by tools/build_library.py — do not edit by hand.\n")
        f.write("window.GRIMOIRE = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    for attempt in range(20):  # Windows refuses while something (a local server, a browser) is reading the file
        try:
            os.replace(tmp, OUT)
            break
        except PermissionError:
            time.sleep(0.5)
    else:
        raise PermissionError(f"Couldn't replace {OUT} — is something holding it open?")
    total = len({v["id"] for c in cats for v in c["videos"]})  # chart tracks can repeat theme tracks
    tagged = {t for c in cats for v in c["videos"] for t in v["tags"]}
    print(f"Wrote {total} videos across {len(cats)} themes, {len(tagged)} hashtags in use -> {OUT}", flush=True)


BLOCKLIST = os.path.join(ROOT, "tools", "blocklist.txt")


def load_blocklist():
    if not os.path.exists(BLOCKLIST):
        return set()
    with open(BLOCKLIST, encoding="utf8") as f:
        return {line.split("#")[0].strip() for line in f if line.split("#")[0].strip()}


def load_library():
    """(categories with icon names, icon name -> svg). Reads both the old and the new file layout."""
    with open(OUT, encoding="utf8") as f:
        body = json.loads(f.read().split("window.GRIMOIRE = ", 1)[1].rstrip().rstrip(";"))
    bodies = dict(body.get("icons", {}))
    defs = {cid: icon for cid, _n, _t, _g, icon, _h, _q in CATEGORIES}
    defs.update({POPULAR[0]: POPULAR[4], MARATHON[0]: MARATHON[4]})
    for c in body["categories"]:
        if c["icon"] not in bodies:            # old layout: the SVG itself was stored on the theme
            name = defs.get(c["id"], c["id"])
            bodies[name] = c["icon"]
            c["icon"] = name
    return body["categories"], bodies


def retag():
    """Re-apply TAGS (and drop blocklisted videos) without searching YouTube again."""
    blocked = load_blocklist()
    cats, bodies = load_library()
    for c in cats:
        c["videos"] = [v for v in c["videos"] if v["id"] not in blocked]
    write_library(cats, bodies)


def build_popular(cats, blocked):
    """The Most Popular chart: top TTRPG tracks by views, from the library + view-sorted searches."""
    print("[popular] searching by view count...", flush=True)
    pool = {}
    for c in cats:
        if c["id"] in (POPULAR[0], MARATHON[0]):
            continue
        for v in c["videos"]:
            pool[v["id"]] = dict(v, known=True)  # already verified embeddable
    for q in POPULAR_QUERIES:
        for v in search(q, by_views=True):
            if v["id"] not in pool:
                pool[v["id"]] = dict(v, known=False)
        time.sleep(0.6)
    ranked = sorted((v for v in pool.values()
                     if v["id"] not in blocked and TTRPG_TITLE.search(v["title"].replace("’", "'"))),
                    key=lambda v: -v["views"])
    chart = []
    for v in ranked:
        if len(chart) >= POPULAR_SIZE:
            break
        if v["known"] or embeddable(v["id"]):
            chart.append({k: v[k] for k in ("id", "title", "channel", "length", "views")})
    print(f"  -> {len(chart)} tracks, {sum(not pool[v['id']]['known'] for v in chart)} new to the library", flush=True)
    cid, name, tagline, group, icon, hue = POPULAR
    return {"id": cid, "name": name, "tagline": tagline, "group": group, "hue": hue, "icon": icon, "videos": chart}


def build_marathon(cats):
    """Marathon Mixes: the most-viewed tracks of three hours or more already in the library."""
    seen, pool = set(), []
    for c in cats:
        if c["id"] in (POPULAR[0], MARATHON[0]):
            continue
        for v in c["videos"]:
            if v["length"] >= 3 * 3600 and v["id"] not in seen:
                seen.add(v["id"])
                pool.append(v)
    pool.sort(key=lambda v: -v["views"])
    cid, name, tagline, group, icon, hue = MARATHON
    return {"id": cid, "name": name, "tagline": tagline, "group": group, "hue": hue, "icon": icon,
            "videos": [{k: v[k] for k in ("id", "title", "channel", "length", "views")} for v in pool[:MARATHON_SIZE]]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=22, help="videos per theme")
    ap.add_argument("--add", action="store_true",
                    help="keep the current library and only add videos (new themes + top-ups to --per)")
    ap.add_argument("--popular", action="store_true", help="only rebuild the charts")
    ap.add_argument("--retag", action="store_true", help="only refresh hashtags on the existing library")
    ap.add_argument("--pages", type=int, default=2, help="result pages per search (about 20 videos each)")
    ap.add_argument("--workers", type=int, default=3, help="searches running at the same time")
    args = ap.parse_args()
    if args.retag:
        return retag()

    icons = load_icons()
    bodies = {name: icons[name]["body"] for name in icons}
    blocked = load_blocklist()
    if args.popular:
        cats, _ = load_library()
        cats = [c for c in cats if c["id"] not in (POPULAR[0], MARATHON[0])]
        return write_library(cats + [build_popular(cats, blocked), build_marathon(cats)], bodies)

    existing = {}
    if args.add:
        old, _ = load_library()
        existing = {c["id"]: [v for v in c["videos"] if v["id"] not in blocked]
                    for c in old if c["id"] not in (POPULAR[0], MARATHON[0])}
    seen = blocked | {v["id"] for vids in existing.values() for v in vids}
    min_views = MIN_VIEWS if args.add else 0

    cats = []
    for cid, name, tagline, group, icon, hue, queries in CATEGORIES:
        if icon not in icons:  # fall back to the closest icon by keyword, then the group's
            words = [w for w in cid.split("-") if len(w) > 2]
            icon = next((n for w in words for n in icons if w in n), None) or next(
                (g[3] for g in catalog.GROUPS if g[0] == group), "castle")
        cats.append({"id": cid, "name": name, "tagline": tagline, "group": group, "hue": hue, "icon": icon,
                     "videos": existing.get(cid, []), "_queries": queries})
    todo = [c for c in cats if len(c["videos"]) < args.per]
    print(f"{len(cats)} themes; {len(todo)} need tracks. Searching ({args.workers} at a time, cached)...", flush=True)

    def theme_queries(c):
        # themes that already have tracks also use fresh phrasings, to get past what they already found
        return c["_queries"] + (EXTRA_QUERIES.get(c["id"], []) if c["videos"] else [])

    # Phase 1: run every search (cached, so a rerun skips what's done)
    search_cache, embed_cache = DiskCache("search.json"), DiskCache("embed.json")
    pending = [q for q in dict.fromkeys(q for c in todo for q in theme_queries(c))
               if search_cache.get(f"{q}|{args.pages}") is None]
    done = [0]

    def run(q):
        res = search_pages(q, args.pages)
        if res is not None:
            search_cache.put(f"{q}|{args.pages}", res)
        done[0] += 1
        if done[0] % 50 == 0:
            print(f"  searched {done[0]}/{len(pending)}", flush=True)
        time.sleep(0.4)

    with ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(run, pending))
    search_cache.save()

    # Phase 2: theme by theme, in catalogue order (so each video lands in its first theme):
    # rank candidates, check embeddability in parallel, keep the best.
    added = 0
    for n, c in enumerate(todo, 1):
        need = args.per - len(c["videos"])
        lists = [[v for v in (search_cache.get(f"{q}|{args.pages}") or []) if acceptable(v)] for q in theme_queries(c)]
        cands = [v for v in rank_candidates(c["id"], lists) if v["id"] not in seen and v["views"] >= min_views]
        cands = cands[: need * 3]
        unknown = [v["id"] for v in cands if embed_cache.get(v["id"]) is None]
        with ThreadPoolExecutor(12) as ex:
            for vid, ok in zip(unknown, ex.map(embeddable, unknown)):
                embed_cache.put(vid, ok)
        picked = [v for v in cands if embed_cache.get(v["id"])][:need]
        for v in picked:
            seen.add(v["id"])
        c["videos"] = c["videos"] + picked
        added += len(picked)
        if n % 25 == 0 or n == len(todo):
            print(f"  [{n}/{len(todo)}] {c['name']}: +{len(picked)} / {added} added so far", flush=True)
            embed_cache.save()
            write_library([{k: v for k, v in x.items() if k != "_queries"} for x in cats], bodies)  # checkpoint
    embed_cache.save()
    for c in cats:
        c.pop("_queries", None)
    # the charts are rebuilt on every run so view counts stay current
    write_library(cats + [build_popular(cats, blocked), build_marathon(cats)], bodies)
    print(f"Added {added} new videos.", flush=True)


if __name__ == "__main__":
    main()
