#!/usr/bin/env node
// ============================================================================
// CSV EDITOR — a spreadsheet for enemies.csv, upgrades.csv and quips.csv that
// runs in the Browser pane, so the tables can be edited without leaving the
// editor for Excel and back.
//
// The point is not "a grid of text boxes" — you already have one of those in
// any text editor. The point is that every column here KNOWS WHAT IT IS:
// `cardArt` is a dropdown of the thirty real card images with thumbnails,
// `enabled` is TRUE/FALSE, `spawnGroup` offers the groups that exist while
// still letting you type a new one, and a number cell that the game would
// reject turns red before you save rather than warning in the console after.
//
// Those rules are not restated here. They are READ OUT OF THE GAME at startup:
// the required/optional/flag column lists come from enemyTable.js, the card art
// keys from config.js, the spawn groups from CONFIG.spawn.groupMaxAlive. Adding
// a column to a CSV or a new hex tile to the art list shows up in this editor
// with no change to this file, and — more importantly — this editor can never
// drift into enforcing a rule the game does not.
//
//   npm run csv        then open http://localhost:5177
//
// Nothing in the game writes back to these files, so this is the only writer
// and there is no race to lose. It still checks mtime on save: another Claude
// session or a text editor can have the file open, and a silent clobber of
// someone else's row is exactly the bug that costs an afternoon.
// ============================================================================

import { createServer } from 'node:http';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, basename } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 5177 is the door to knock on by hand. PORT is what a harness hands over when
// it has assigned one, and it has to be honoured or a second session's editor
// dies on "port in use" against the first session's — which is reachable
// whenever two Claude chats are open on this repo, and is exactly the case
// this file's mtime check exists for. CSV_EDITOR_PORT still wins over both, so
// asking for a specific port by hand is unaffected.
const PORT = Number(process.env.CSV_EDITOR_PORT || process.env.PORT || 5177);

const SRC = join(ROOT, 'path/src');
const readSrc = (f) => { try { return readFileSync(join(SRC, f), 'utf8'); } catch { return ''; } };

// ---------------------------------------------------------------------------
// READING THE RULES OUT OF THE GAME
//
// Regex over source rather than an import, deliberately: config.js pulls in
// three.js and a browser's worth of globals, and this tool wants three lists of
// strings. Every extractor below fails SOFT — an empty result costs you a
// dropdown and leaves a plain text box, which is the same editing experience
// you have today. None of them can fail closed and block a cell from being
// typed into, because a schema this tool got wrong must never outrank you.
// ---------------------------------------------------------------------------

// `const NAME = { field: { min: 0, integer: true }, ... };` -> per-field specs.
function extractNumberSpecs(src, name) {
  const block = matchBlock(src, new RegExp(`const ${name} = \\{`), '}');
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*\{([^}]*)\}/gm)) {
    const [, field, body] = m;
    const min = /min:\s*(-?[\d.]+)/.exec(body);
    out[field] = {
      min: min ? Number(min[1]) : undefined,
      integer: /integer:\s*true/.test(body),
    };
  }
  return out;
}

// `const NAME = ['a', 'b'];` / `export const NAME = [...]` -> the strings.
function extractStringArray(src, name) {
  const block = matchBlock(src, new RegExp(`const ${name} = \\[`), ']');
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// `groupMaxAlive: { apex: 8 }` -> the key names.
function extractObjectKeys(src, name) {
  const block = matchBlock(src, new RegExp(`${name}:\\s*\\{`), '}');
  return [...block.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
}

// Everything between an opening pattern and the first `close` that sits at
// nesting depth zero. Good enough for flat data literals, which is all these
// are, and it returns '' rather than throwing on anything it doesn't find.
function matchBlock(src, openRe, close) {
  const m = openRe.exec(src);
  if (!m) return '';
  const open = close === '}' ? '{' : '[';
  let depth = 1;
  const start = m.index + m[0].length;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i);
  }
  return '';
}

const enemySrc = readSrc('enemyTable.js');
const configSrc = readSrc('config.js');

const ENEMY_REQUIRED = extractNumberSpecs(enemySrc, 'REQUIRED');
const ENEMY_OPTIONAL = extractNumberSpecs(enemySrc, 'OPTIONAL');
const ENEMY_FLAGS = extractStringArray(enemySrc, 'FLAGS');
const CARD_ART_KEYS = extractStringArray(configSrc, 'LEVELUP_IMAGE_KEYS');
const SPAWN_GROUPS = extractObjectKeys(configSrc, 'groupMaxAlive');
// The perks the game actually implements, read out of the source rather than
// listed here — a perk id is a join between three files, and a dropdown that
// offered one the code has no behaviour for would be the editor inviting the
// exact typo the parser refuses.
const PERK_IDS = extractStringArray(readSrc('bossPerkTable.js'), 'PERK_IDS');
// The two closed lists callouts.csv joins on, read out of the parser that
// enforces them for the same reason: a `kind` this editor offered and the game
// refused would be the tool inviting the row-dropping typo. Both fall back to
// what they are today rather than to nothing, so a rename in the parser
// degrades the dropdown instead of emptying it.
const calloutSrc = readSrc('calloutTable.js');
const orToday = (found, today) => (found.length ? found : today);
const CALLOUT_KINDS = orToday(extractStringArray(calloutSrc, 'CALLOUT_KINDS'), ['warn', 'coach']);
const ARROW_TARGETS = orToday(extractStringArray(calloutSrc, 'ARROW_TARGETS'), ['chum', 'surface']);
const CALLOUT_ANCHORS = orToday(extractStringArray(calloutSrc, 'CALLOUT_ANCHORS'), ['band', 'player']);
// Read out of the game rather than restated here, like every other list in this
// file. NAME_SLOTS is the one the parser actually validates against — SLOTS is
// the shorter list of the parts a name is BUILT from, and offering that one
// would leave `nickname` a value the editor refuses to type and the game
// accepts. Falls back to the three composed slots if the extractor comes back
// empty (NAME_SLOTS is a spread of SLOTS, which a literal-array regex can't
// see), so the dropdown degrades to what it always was rather than to nothing.
const NAME_SLOTS = (() => {
  const src = readSrc('bossNameTable.js');
  const composed = extractStringArray(src, 'SLOTS');
  if (!composed.length) return ['prefix', 'root', 'epithet'];
  // `export const NAME_SLOTS = [...SLOTS, 'nickname', 'solo'];` — the extras
  // are whatever is quoted in that literal, on top of the composed slots.
  const extras = extractStringArray(src, 'NAME_SLOTS');
  return [...composed, ...extras.filter((s) => !composed.includes(s))];
})();
// The seal name table's own slots, read the same way and for the same reason.
// SEAL_NAME_SLOTS is a spread of SEAL_SLOTS, which a literal-array regex can't
// see through, so the two are read separately and joined — and it degrades to
// the built halves rather than to an empty dropdown if either goes missing.
const SEAL_NAME_SLOTS = (() => {
  const src = readSrc('sealNameTable.js');
  const built = extractStringArray(src, 'SEAL_SLOTS');
  if (!built.length) return ['adjective', 'nickname'];
  const extras = extractStringArray(src, 'SEAL_NAME_SLOTS');
  return [...built, ...extras.filter((s) => !built.includes(s))];
})();
// ...and the boss archetypes, read out of bosses.csv itself, so the `bosses`
// column offers what is actually in the roster today.
const idsFromCsv = (rel) => {
  try {
    const rows = readFileSync(resolve(ROOT, rel), 'utf8').trim().split(/\r?\n/);
    return rows.slice(1).map((l) => l.split(',')[0].trim()).filter(Boolean);
  } catch { return []; }
};
const BOSS_IDS = idsFromCsv('path/src/bosses.csv');
const ENEMY_IDS = idsFromCsv('path/src/enemies.csv');

// The causes of death a quip can be written for, read out of deathCauses.js so
// the picker offers what the game actually classifies. The `label` rides along
// because "orca" and "the orca" are the same tick but only one of them reads
// like a sentence in a checklist.
const DEATH_CAUSES = (() => {
  const src = readSrc('deathCauses.js');
  const out = [];
  for (const m of src.matchAll(/\{\s*id:\s*'([\w]+)',\s*label:\s*'([^']*)'/g)) {
    out.push({ id: m[1], label: m[2] });
  }
  return out;
})();

// ---------------------------------------------------------------------------
// THE GAME ITSELF, loaded on demand.
//
// Two things this editor can only get by RUNNING the game's code rather than
// reading it: the sound bank (CONFIG.sfx, whose entries carry their sample
// paths) and the {effect} preview (which measures an upgrade by calling its
// apply()). Both need config.js, which needs Vite's `?raw` and JSON imports —
// hence the loader on the npm script.
//
// Loaded lazily and allowed to fail. Without it the editor is exactly what it
// was before: the grid still works, the sound column falls back to the files
// on disk, and the desc preview just doesn't appear. A tool for editing tables
// must not refuse to open because a preview couldn't be built.
// Node caches a module graph for the life of the process and there is no
// honest way to invalidate config.js's dependencies from inside it. So rather
// than serving a preview that is quietly out of date — the exact failure
// {effect} exists to prevent — the editor watches the files its measurement
// depends on and says so when one of them has moved under it.
const GAME_SOURCES = ['path/src/config.js', 'path/src/stats.js', 'path/src/upgradeText.js'];
let loadedAt = 0;

async function gameIsStale() {
  if (!loadedAt) return false;
  for (const f of GAME_SOURCES) {
    try {
      const st = await stat(join(ROOT, f));
      if (st.mtimeMs > loadedAt) return f;
    } catch { /* a file that isn't there can't be stale */ }
  }
  return false;
}

let gamePromise = null;
function game() {
  if (!gamePromise) {
    gamePromise = Promise.all([
      import('../path/src/config.js'),
      import('../path/src/upgradeText.js'),
    ]).then(([cfg, text]) => { loadedAt = Date.now(); return { CONFIG: cfg.CONFIG, ...text }; })
      .catch((err) => {
        console.warn(`  note: couldn't load the game for sound names and {effect} previews — ${err.message}`);
        console.warn('        (run via "npm run csv" so the Vite loader is in place)');
        return null;
      });
  }
  return gamePromise;
}

// The sound bank as a pickable list: every key in CONFIG.sfx, tagged with
// whether there is an actual file behind it that the editor can play. A synth
// voice has no sample to preview — it is generated in the browser's audio
// graph — so it is offered without a play button rather than with one that
// does nothing.
async function soundList() {
  const g = await game();
  const files = await sfxFiles();
  if (!g?.CONFIG?.sfx) {
    // No game: offer the raw files, so the column is still pickable.
    return files.map((f) => ({ key: f, kind: 'file', file: `/sfx/${f}` }));
  }
  return Object.entries(g.CONFIG.sfx).map(([key, v]) => {
    const src = v?.srcs?.[0] ?? v?.src ?? null;
    const sampled = typeof src === 'string' && src.startsWith('/sfx/');
    return {
      key,
      kind: sampled ? 'sample' : 'synth',
      file: sampled ? src : null,
      takes: Array.isArray(v?.srcs) ? v.srcs.length : (src ? 1 : 0),
      detail: sampled ? basename(src) : `${v?.type ?? 'synth'} voice`,
    };
  });
}

async function sfxFiles() {
  try {
    const names = await readdir(join(ROOT, 'public/sfx'));
    return names.filter((n) => ['.mp3', '.wav', '.ogg', '.m4a'].includes(extname(n).toLowerCase())).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// COLUMN PROSE
//
// The one thing that can't be extracted: what a column MEANS, and what the
// game does with an empty cell. Lifted from the header comments of the table
// modules. A column with no entry here still edits fine — it just has no
// tooltip, which is what happens to any column added after this map.
// ---------------------------------------------------------------------------
const DOCS = {
  'enemies.csv': {
    id: 'Must match a key in CONFIG.enemies. The join key — renaming it here orphans the row.',
    radius: 'Hitbox radius in world units.',
    chumRadius: 'What the chum orb is sized and priced off — its tier, the mass ramp, its heal and its scale. Blank means "same as radius", which is right for everything whose hitbox describes how big it is. Fill it in only when radius is doing a second job: the king crab\'s is its resting height off the sand, so at 0.5 it dropped a minnow\'s orb.',
    hp: 'Starting health at difficulty 0.',
    hpPerDifficulty: 'Health gained per difficulty point (1 point = 20s).',
    speed: 'Base swim speed.',
    speedVariance: 'Per-individual speed jitter.',
    speedPerDifficulty: 'Linear speed gain per difficulty point.',
    turnRate: 'Radians/sec. Blank means it pivots on the spot.',
    contactDamage: 'Damage dealt on touching the seal.',
    contactDamagePerDifficulty: 'Contact damage gained per difficulty point.',
    biteDamage: 'What the JAWS CLOSING cost the seal, as one burst on the frame they shut — separate from the per-second drain of touching the body, and only for a creature with a hunt block to close them with. Blank means the snap is a sound and a pose, which is right for every wildlife row; the bosses that chase fill it in, and it is the whole of what their attack is worth.',
    scalePerDifficulty: 'Visual + hitbox growth over a run.',
    maxGrowth: 'Cap on scalePerDifficulty.',
    scaleVariance: 'Per-individual size jitter, +/- this fraction, rolled once at spawn. The hitbox follows the visual, so it is a real spread of body sizes — and for the sea turtle, which has a rigid body, a spread of masses with it.',
    xp: 'XP orb value on death.',
    weight: 'Spawn weight, relative to the rest of the roster.',
    weightPerDifficulty: 'Spawn weight gained per difficulty point.',
    maxWeight: 'Cap on weightPerDifficulty.',
    maxConcurrent: 'Per-species headcount on screen.',
    minDifficulty: 'Difficulty before it can appear at all. 1 point = 20 seconds.',
    minPlayerLevel: 'Hard level gate, independent of time.',
    spawnRateMul: 'Spawn rate multiplier. 0 disables the creature outright.',
    spawnGroup: 'Family-wide headcount cap, see CONFIG.spawn.groupMaxAlive.',
    bioluminescent: 'Only spawns once the sun is down.',
    bossMinion: 'Stays in the water during a boss fight. Everything without this swims out when a boss arrives, and only minions spawn until it is dead.',
    invincible: 'Cannot be killed — scenery, not an opponent. Damage to it is absorbed and never counted, and it is not counted as pressure to clear. Set this rather than typing a huge hp: a big number gets read AS a number, and one lethal hit on a creature with hp 1e9 books a billion damage against whatever did it.',
  },
  'upgrades.csv': {
    id: 'Must match an id in CONFIG.upgrades. The join key — renaming it here orphans the row.',
    name: 'Card title. Blank keeps the built-in name.',
    desc: 'Card body text. Blank keeps the built-in description. Takes {placeholders} — see the ⊕ button in the cell.',
    sfx: 'Sound played when this card is TAKEN, on top of the click. Blank uses the shared level-up sound.',
    maxStacks: 'How many times it can be taken. BLANK MEANS UNLIMITED.',
    enabled: 'FALSE removes it from the offer pool. Blank means enabled.',
    weight: 'How likely this is, relative to the other rows. Blank = 1. 0 is never dealt but still shows in the Upgrades tab.',
    cardArt: 'Hex background for the card. Blank means the plain card.',
      weaponName: 'What the WEAPON this upgrade modifies is called once you hold it \u2014 "Cloned Pebbles" instead of "Fin Pebbles". A whole name, not an adjective, so write anything. It shows on the kill-shot polaroid and in the score screen\u2019s weapon table. Blank on nearly every row, which means "this upgrade does not rename anything". `{element}` becomes whichever element Glow Up! rolled this run (Voltaic, Venom, Chill, Infected). When you hold several renaming upgrades the MOST RECENTLY TAKEN one wins.',
},
  // The three path-keyed tables share one column contract, so the docs are
  // written once and pointed at rather than copied into places that drift.
  'assets.csv': {
    id: 'The ASSET key from assets.js \u2014 not a creature id. One asset can back several creatures, and plenty (grass, boats, the escorts) are not creatures at all.',
    size: 'Spawn scale for this model. Applies to FUTURE spawns; anything already on screen keeps the size it was created at. The hitbox is derived from it, so a bigger model is a genuinely bigger target.',
    surface: 'WHICH TREATMENT PAINTS THIS BODY \u2014 one of three, never a mix. "texture" keeps the model\u2019s own baked map. "noise" or "noise:<preset>" is procedural Perlin mottling banded by the toon step. "biolum" or "biolum:<preset>" is a pattern at full pigment, replacing the map. Blank leaves whatever assets.js declares. Set it in the shader lab (npm run looks:shaderlab) and write it here with npm run shaders:apply. It WINS over the skin column \u2014 two writers on one field is how you get a look that depends on load order. Takes effect on the next RELOAD.',
    skin: 'Which procedural skin this model wears \u2014 a preset name from the Procedural skins folder on the T panel. Blank keeps whatever assets.js declares; "none" takes one away. A preset on full pigment PAINTS the body, so the model no longer needs its own texture. Takes effect on the next RELOAD: the pattern is baked into the material when the model is parsed.',
    notes: 'Free text \u2014 nothing reads it.',
  },
  'weapons.csv': { __sharedWith: 'spawning.csv' },
  'behaviour.csv': { __sharedWith: 'spawning.csv' },
  'spawning.csv': {
    id: 'A dotted path into CONFIG. This is the join key — a path that matches nothing is reported and skipped, so a typo cannot silently do nothing.',
    value: 'The value itself. On/off settings are 1 or 0. The TYPE comes from config.js, so this can change what a setting is SET to but never what it IS \u2014 a nonsense value keeps the built-in and warns rather than taking the boot down.',
    min: 'Documentation only, and the range this editor lets the slider cover. The game does not clamp to it.',
    max: 'Documentation only, and the range this editor lets the slider cover. The game does not clamp to it.',
    notes: 'What the setting does. Free text — nothing reads it.',
  },
  'quips.csv': {
    id: 'A short handle for the row. Never shown to the player — it exists so a reworded line keeps its identity in a diff.',
    text: 'The game-over headline itself. `{player}` becomes whatever the player is called — the name they typed, or "Seal" if they never did.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows. Blank = 1, 0 is never shown.',
    causes: 'What has to have killed you for this line to fire. BLANK MEANS ANY DEATH. A line written for a cause BEATS the general pool rather than competing with it — die to a crab and only the crab lines are drawn from, so tagging one makes it certain, not merely likelier. Tick several and the line covers all of them.',
  },
  'greetings.csv': {
    id: 'A short handle for the row. Never shown to the player \u2014 it exists so a reworded line keeps its identity in a diff.',
    text: 'The hello itself, one line on the band at the top of a run. `{player}` becomes whatever the player is called \u2014 the name they typed, or "Seal" if they never did. `{cause}` becomes what killed them LAST run, worded as "a shark", "a crab", "running out of air" \u2014 so write it mid-sentence and lowercase: "Last time it was {cause}." A line with `{cause}` in it is simply held back on a run that follows no death, so using it is the only guard you need.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows IT IS POOLED WITH. Blank = 1, 0 is never shown.',
    when: 'Which run this line is for. "first" is somebody who has never played, "again" is a run that follows another one. BLANK MEANS EITHER, which is right for a line that says nothing about history and wrong for almost everything else \u2014 "Welcome to the deep" on the fortieth run and "Back again?" on the first are both perfectly formed sentences and both are wrong.',
    causes: 'What has to have killed them LAST RUN for this line to fire. BLANK MEANS ANY DEATH, and also a run that ended without one. A line written for a cause BEATS the general pool rather than competing with it \u2014 die to a crab and only the crab lines are drawn from, so tagging one makes it certain, not merely likelier.',
  },
  'kickers.csv': {
    id: 'A short handle for the row. Never shown to the player — it exists so a reworded label keeps its identity in a diff.',
    text: 'The label the cause of death reads under, on the polaroid: "cause of death: Homing Missile". Write it WITHOUT a trailing space — the gap before the weapon name is added in code, because a trailing space is invisible in this editor and would go missing the first time a row was touched.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows. Blank = 1, 0 is never shown. The straight reading ships at 3 against the jokes\u2019 1 — a bit that lands one print in five is a bit; one that lands every print is the format.',
  },
  'sealNames.csv': {
    id: 'A short handle for the row. Never shown to the player — it exists so a reworded part keeps its identity in a diff.',
    slot: 'Which PART of the name this is: adjective ("Fat") + nickname ("Tony") are drawn separately and set side by side. A full name is a WHOLE name written out ("Sir Flops-A-Lot") — the way to hand-write something the halves could never assemble. Any other value is ignored, loudly.',
    text: 'The part itself, used with exactly the capitalisation typed here — both halves are capitalised, because either can also end up standing alone. Nothing may contain <>&"\'\\: the name field strips those, so they are removed at load with a warning naming the row.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows IN THE SAME SLOT. Blank = 1, 0 is never used.',
    notes: 'Free text — nothing reads it.',
  },
  'callouts.csv': {
    id: 'WHICH callout this is, and it joins to code — the condition that fires a warning, or the step that offers a tip. Renaming one takes it out of the game; rewording `text` does not. Adding a row does nothing on its own: something has to fire it.',
    kind: '`warn` for a state you must fix now (fires every run, forever) or `coach` for a first-run tip (fires ONCE EVER per device and then never again). Anything else is ignored, loudly.',
    text: 'The line itself. This is the whole point of the row, and the one column you can change freely. `{player}` becomes whatever the player is called — the name they typed, or "Seal" if they never did — and unlike a key token it needs no textPad, since a name reads the same in any pair of hands.',
    textTouch: 'What to say instead on a touchscreen. Blank uses `text`. Fill it in wherever the line names a control — "press Space" is nonsense held in two hands.',
    textPad: 'What to say instead on a controller. Blank uses `text`. A `{strike}` token becomes whatever strike is bound to right now and `{bumper}` becomes what THIS pad calls its shoulders, so neither a rebind nor a change of controller can make the line lie. A row carrying a key token with no `textPad` tells a controller player to press Space, which is the exact failure this column exists to prevent.',
    devices: 'Which devices this row exists on at all — space-separated `kbm`, `touch`, `pad`. Blank is all of them, which is nearly every row. An unrecognised name is dropped rather than widening the list, and a row left with nothing to say on a device it can still appear on is dropped outright, the same as a row with no text.',
    enabled: 'FALSE takes the callout out of the game entirely. Blank means enabled.',
    anchor: 'WHERE it appears — and each anchor is its own one-at-a-time slot, so a `band` line and a `player` line CAN be up together. `band` is the big line across the middle of the screen; `player` is a small line riding just above the boost ring on the seal. Blank = band.',
    priority: 'Who gets the surface when two rows on the SAME anchor want it at once — higher wins, and the loser is DROPPED rather than queued. For a tip it is also the order tips are offered in, and a tip that becomes ready INTERRUPTS a lower one. Every coach row outranks every warning regardless of this number.',
    hold: 'Seconds on screen. For a BAND tip this is also its patience: do the thing and it goes at once, ignore it and it goes at this. For a tip with a `subject` it is no longer a life — the label stands on the thing until the thing is gone — and is only the cap on how long that line may demand to be read. Every tip, either kind, is also ended by the overall ceiling in the Text panel (Tip max). Blank falls back to Callout placement in the Text panel (Y).',
    subject: 'The THING this tip stands beside, which turns it from a line across the middle of the screen into a label in the water on the thing it is about — and the object is lit up for as long as the line is up. `chum` is the nearest bite, `pickup` an orb of this row\'s own kind (the row id names which), `creature` the nearest animal that cannot be killed, and `surface` / `seabed` are PLACES rather than objects: straight up out of the water, straight down at the floor. A subject tip has no clock of its own — it ends when the player does the thing, when the thing goes, or at the ceiling. Blank keeps the line on the band, which is right for the rows about a BUTTON: a stick is not somewhere in the water.',
    repeat: 'Seconds before a warning may say itself AGAIN while its condition is still true. Blank = say it once per crossing and then stay quiet until the trouble clears and comes back. Ignored on a tip — those never repeat.',
    arrow: 'What the arrow points at while this line is up. Two of them name a THING and can come up empty, because it can be eaten or expire mid-sentence: `chum` is the nearest bite, `pickup` is the nearest orb OF THIS ROW\'S OWN KIND (the row id names it, which is why there is one arrow value for five pickup tips rather than five). The other two name a DIRECTION and always answer: `surface` is straight up out of the water, `seabed` straight down at the floor. Blank is no arrow, which is most rows.',
  },
  'bossNames.csv': {
    id: 'A short handle for the row. Never shown to the player — it exists so a reworded part keeps its identity in a diff.',
    slot: 'Which PART of the name this is: prefix ("Gore") + root ("maw") make the name, epithet ("the Devourer") follows it. A nickname is a WHOLE name ("Ol\' Chompy") that replaces the prefix and root together — the way to hand-write a name the machine could never assemble. A solo name is a nickname that takes no epithet either: the cell is the entire name, the way a ship\'s name is complete on its own. Any other value is ignored, loudly.',
    text: 'The part itself, used with exactly the capitalisation typed here — prefixes are capitalised, roots are not, an epithet carries its own article, and a nickname is written exactly as it should read.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows IN THE SAME SLOT. Blank = 1, 0 is never used.',
    bosses: 'Which boss archetypes can wear this part. BLANK MEANS ALL — fill it in to narrow ("Sharky" is not a name an orca can carry). Space- or comma-separated ids from bosses.csv.',
    perk: 'Tie this part to a boss PERK. Blank is the general pool. A part with a perk only appears on a boss that has it — and one of that perk\'s parts is guaranteed to land, which is how the name warns the player what the fight does.',
    notes: 'Free text — nothing reads it.',
  },
  'bosses.csv': {
    id: 'A short handle for the archetype. bossNames.csv\'s `bosses` column joins to this, so renaming one unhooks its name parts.',
    enemy: 'Which row in enemies.csv this boss is built from. A key that does not exist is refused at boot.',
    sizeMul: 'How much bigger than its own row it arrives — applied to the model, the hitbox and the size roll together.',
    weight: 'Likelihood relative to the other ELIGIBLE archetypes. Blank = 1, 0 takes it out without disabling the row.',
    minLevel: 'The player level from which this archetype can appear at all. 0 means from the very first boss.',
    ownNames: 'TRUE means this archetype draws ONLY from bossNames.csv rows that name it, never the shared pool. For a boss that should not sound like the fish — a boat. Leave blank to share.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    notes: 'Free text — nothing reads it.',
  },
  'bossPerks.csv': {
    id: 'Which perk. The code joins to this, so only ids the game implements are accepted — anything else is refused, loudly.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other perks. Blank = 1.',
    cooldown: 'Seconds between activations. Electric is always on and ignores it; giant and swift never activate at all.',
    windup: 'Seconds of telegraph before it fires — the tell the player is meant to read.',
    duration: 'Seconds the effect itself lasts: the dash, the time spent gone or unseen, a barrel\'s fuse, how long an escort turtle stays.',
    speed: 'World units per second. The lunge\'s dash, how fast a shooter\'s projectile travels, how fast a turtle repositions.',
    radius: 'World units. Electric: the aura\'s reach. Teleport: how far from the player it lands. Barrels: the blast. Turtles: how far off the boss they hold station.',
    range: 'World units. How close the player must be before a shooter opens fire at all — a boss that shoots across the whole arena is a fight with no distance in it.',
    count: 'How many per activation: shots in a volley, or turtles kept up.',
    mul: 'A plain multiplier, and what it multiplies is the perk\'s own business — giant scales SIZE, swift scales SPEED (and turn rate with it).',
    damage: 'Lunge: a multiplier on contact damage while dashing. Electric: damage per second inside the aura. The shooters: damage per projectile.',
    attack: 'What KIND of harm this is — kinetic, electric, blast, beam, void, venom, chill or infection. It decides what the telegraph ring looks like: the colour and the crackling/roiling/sagging edge both come from the shared threat palette, so an electric boss draws in the exact cyan of the player\'s Voltaic element. Look only — nothing about damage reads it. Blank keeps the colour the perk had before the palette existed.',
    notes: 'Free text — nothing reads it.',
  },
};

// What the game falls back to when the cell is empty, shown as placeholder
// text so an empty cell reads as a value rather than as an oversight.
const BLANK_MEANS = {
  'enemies.csv': {
    // Short enough to fit a 92px number column — the full sentence is in the
    // column tooltip, which is where a placeholder that clips belongs anyway.
    speedVariance: '0', speedPerDifficulty: '0', turnRate: 'pivots',
    contactDamagePerDifficulty: '0', biteDamage: 'no bite', scalePerDifficulty: '0', maxGrowth: '∞',
    scaleVariance: '0',
    weightPerDifficulty: '0', maxWeight: '∞', maxConcurrent: '∞',
    minDifficulty: '0', minPlayerLevel: '0', spawnRateMul: '1',
    spawnGroup: 'no group', bioluminescent: 'no', bossMinion: 'no', invincible: 'no',
  },
  'upgrades.csv': { maxStacks: 'unlimited', enabled: 'enabled', weight: '1', name: 'built-in', desc: 'built-in', cardArt: 'plain card', sfx: 'standard level-up', weaponName: 'renames nothing' },
  'quips.csv': { enabled: 'enabled', weight: '1', causes: 'any death' },
  'greetings.csv': { enabled: 'enabled', weight: '1', causes: 'any death', when: 'either run' },
  'kickers.csv': { enabled: 'enabled', weight: '1' },
  'sealNames.csv': { enabled: 'enabled', weight: '1', notes: '—' },
  'callouts.csv': { enabled: 'enabled', anchor: 'band', priority: '0 (last)', hold: 'the panel default', repeat: 'never repeats', arrow: 'no arrow' },
  'bossNames.csv': { enabled: 'enabled', weight: '1', notes: '—', bosses: 'any boss', perk: 'general pool' },
  'bosses.csv': { enabled: 'enabled', weight: '1', sizeMul: '1 (unscaled)', minLevel: '0 (from the first)', ownNames: 'shares the pool', notes: '—' },
  'bossPerks.csv': { enabled: 'enabled', weight: '1', notes: '—', cooldown: 'unused', windup: 'unused', duration: 'unused', speed: 'unused', radius: 'unused', range: 'any range', count: '1', mul: '1', damage: 'unused', attack: 'the old colour' },
  // A blank spawn value means "leave the built-in alone", NOT zero — zero
  // would switch a system off, which is the opposite of leaving it alone.
  'spawning.csv': { value: 'config.js default', min: '—', max: '—', notes: '—' },
  'weapons.csv': { value: 'config.js default', min: '—', max: '—', notes: '—' },
  'behaviour.csv': { value: 'config.js default', min: '—', max: '—', notes: '—' },
  'assets.csv': { size: '1 (unscaled)', skin: 'whatever assets.js declares', surface: 'whatever assets.js declares', notes: '—' },
};

// ---------------------------------------------------------------------------
// THE TABLES
// ---------------------------------------------------------------------------
// ORDER IS THE MENU. The two tables that are pure writing — the boss's name and
// the line you read when you die — sit at the top because they are the ones
// opened to add a row rather than to check a number. Everything below them is
// balance, and balance is a thing you go looking for.
export const TABLES = [
  {
    file: 'path/src/bossNames.csv',
    label: 'Boss names',
    blurb: 'What the boss is called. These are PARTS, not names — a prefix, a root and an epithet are drawn separately, so eight of each is hundreds of bosses. `bosses` narrows a part to one archetype, `perk` ties it to a power; both blank is the general pool. Add away.',
    addRows: true,
  },
  {
    file: 'path/src/quips.csv',
    label: 'Death quips',
    blurb: 'The game-over headline. The `id` joins to nothing in code, so new lines are just new rows — add away. `causes` is the one column that does join: leave it blank and the line can answer any death, or tick what has to have killed you. A line written for a cause BEATS the general pool rather than competing with it, so tagging one makes it certain for that death, not merely likelier.',
    addRows: true,
  },
  {
    file: 'path/src/greetings.csv',
    label: 'Greetings',
    blurb: 'The line a run OPENS with \u2014 one rolled sentence on the band with the player\u2019s name in it, every run. The `id` joins to nothing, so new lines are just new rows. `when` picks which run it is for: a first-timer is welcomed, everybody else is greeted as a return. A returning line may also comment on the last death \u2014 tag it with a cause, or drop `{cause}` into the words and let it name whatever it was.',
    addRows: true,
  },
  {
    file: 'path/src/kickers.csv',
    label: 'Kill-shot kickers',
    blurb: 'The label above the cause of death on the polaroid — "cause of death: Homing Missile", "kill\u2019d by: Belly Flop". One is rolled per kill shot and kept with it, so a print never re-captions itself. The `id` joins to nothing, so new lines are just new rows; leave the trailing space off the text, it is added in code.',
    addRows: true,
  },
  {
    file: 'path/src/sealNames.csv',
    label: 'Seal names',
    blurb: 'What the dice button on the splash calls the player. PARTS, like the boss names — an adjective and a nickname are drawn separately, so "Fat" and "Tony" is thirty rows and five hundred seals. A `full` row is a whole name written out, for the ones the halves could never build. Whatever is rolled lands in the name field, where the player can edit it or roll again.',
    addRows: true,
  },
  {
    file: 'path/src/upgrades.csv',
    label: 'Upgrades',
    blurb: 'The editable half of every upgrade. What an upgrade DOES is code in config.js; everything here is content.',
    // A row here joins to CONFIG.upgrades by id, so a new row without matching
    // code does nothing and warns. Adding one is a job for /upgrades.
    addRows: false,
  },
  {
    file: 'path/src/enemies.csv',
    label: 'Creatures',
    blurb: 'The balance half of every creature. Behaviour blocks, models and flags stay in config.js and on the ` tuner.',
    addRows: false,
  },
  {
    file: 'path/src/spawning.csv',
    label: 'Spawning',
    blurb: 'What arrives and how often — the whole spawn system on one screen. These were thirty sliders on the ` tuner; a spawn rate is judged over minutes and against the other rates, which is a table\u2019s job, not a slider\u2019s.',
    // Every row joins to a path in config.js. A new row without a matching
    // setting is reported and skipped, so adding one here does nothing.
    addRows: false,
  },
  {
    file: 'path/src/weapons.csv',
    label: 'Weapons',
    blurb: 'The balance half of the seal\u2019s weapons \u2014 rate, damage, speed, lifespan, chaining. These pair with upgrades.csv, which multiplies exactly these numbers; the trails, impact flashes and flight SFX stay on the ` tuner where you judge them by eye.',
    addRows: false,
  },
  {
    file: 'path/src/behaviour.csv',
    label: 'Behaviour',
    blurb: 'How creatures hunt, school, scavenge and press you \u2014 per-creature behaviour blocks plus the shared bite, hunter-ramp and apex-crowd settings, which were scattered across four tuner sections.',
    addRows: false,
  },
  {
    file: 'path/src/assets.csv',
    label: 'Model sizes',
    blurb: 'How big each model spawns. This is not a look \u2014 the hitbox is derived from the visual scale, so it decides how big a creature is to HIT as well as to see. An asset with no row here spawns unscaled.',
    addRows: false,
  },
  {
    file: 'path/src/callouts.csv',
    label: 'Warnings & tips',
    blurb: 'What the game SHOUTS: the four warnings that fire whenever you are in trouble, and the five first-run tips that fire once each per device and then never again. Rewording a line is free; the `id` joins to the code that fires it, so a new row needs a condition to go with it.',
    addRows: false,
  },
  {
    file: 'path/src/bosses.csv',
    label: 'Boss roster',
    blurb: 'Which creatures can be THE boss, how big each arrives, and from what level. One is drawn per boss out of a shuffle bag, so a run meets every archetype it has unlocked before it sees one twice.',
    addRows: true,
  },
  {
    file: 'path/src/bossPerks.csv',
    label: 'Boss perks',
    blurb: 'The one special thing a boss can do. The first boss of a run has none; every one after it gets exactly one, and its name always says which. Only ids the game implements can be added — a perk with no code behind it is refused.',
    addRows: false,
  },
];

const BY_FILE = new Map(TABLES.map((t) => [t.file, t]));

// The path-keyed tables all share one column contract: id, value, min, max,
// notes. Listed once so adding a fourth is a one-line change.
const PATH_TABLE_FILES = new Set([
  'path/src/spawning.csv', 'path/src/weapons.csv', 'path/src/behaviour.csv',
]);

// Decide what control a column gets. Columns the game has no opinion about
// fall through to a text box, which is why an unknown column is harmless.
function columnSpec(file, name, rows) {
  // DOCS and BLANK_MEANS are keyed by bare filename; `file` is the repo path.
  const base_ = file.split('/').pop();
  // The path tables share one contract, so their docs are written once and
  // pointed at rather than copied into three places that could drift.
  const docs = DOCS[base_]?.__sharedWith ? DOCS[DOCS[base_].__sharedWith] : DOCS[base_];
  const doc = docs?.[name];
  const blank = BLANK_MEANS[base_]?.[name];
  const base = { name, doc, blank, type: 'text' };

  if (name === 'id') return { ...base, type: 'text', readonly: !BY_FILE.get(file).addRows, key: true };

  if (file === 'path/src/assets.csv') {
    if (name === 'size') return { ...base, type: 'number', min: 0.001, required: true };
    return { ...base, type: 'text' };
  }

  if (PATH_TABLE_FILES.has(file)) {
    // `value` is the only editable cell. It is typed per ROW rather than per
    // column, which no other table here needs: this file mixes numbers with
    // on/off settings, and the row's own min/max carry the range. A row whose
    // current value reads as yes/no gets the enum; everything else is a number
    // bounded by its own min/max columns.
    // Everything is a NUMBER here, on/off settings included: they are written
    // 1/0 rather than yes/no so this one column can be typed once. The actual
    // type still comes from config.js — spawnTable coerces 1 to true only
    // where the built-in it is replacing is a boolean — so the file cannot
    // change what a setting IS, only what it is set to.
    if (name === 'value') return { ...base, type: 'number', required: true };
    // The bounds and the prose are reference material, not settings — editable
    // so the file can document itself, but never something the game reads.
    return { ...base, type: 'text' };
  }

  if (file === 'path/src/enemies.csv') {
    const num = ENEMY_REQUIRED[name] || ENEMY_OPTIONAL[name];
    if (num) return { ...base, type: 'number', ...num, required: name in ENEMY_REQUIRED };
    if (ENEMY_FLAGS.includes(name)) return { ...base, type: 'enum', options: ['', 'yes', 'no'], labels: { '': '—  (no)' } };
    if (name === 'spawnGroup') {
      // A combo, not a closed list: the groups that exist are worth one click,
      // but a group with no groupMaxAlive entry is legal (it just has no cap),
      // so inventing one has to stay a matter of typing it.
      const seen = [...new Set(rows.map((r) => (r[name] || '').trim()).filter(Boolean))];
      return { ...base, type: 'combo', options: [...new Set([...SPAWN_GROUPS, ...seen])].sort() };
    }
    return base;
  }

  // Closed for the same reason bossNames.csv's slot is, one block down: an
  // unknown slot is not a new kind of part, it is a part that never appears.
  if (file === 'path/src/sealNames.csv' && name === 'slot') {
    return {
      ...base,
      type: 'enum',
      options: SEAL_NAME_SLOTS,
      labels: {
        adjective: 'adjective  (the front half)',
        nickname: 'nickname  (the back half, and a name on its own)',
        full: 'full  (a whole name, written out)',
      },
    };
  }
  // A closed list, unlike enemies.csv's spawnGroup combo above: an unknown
  // slot is not a new kind of name part, it is a part that never appears.
  if (file === 'path/src/bossNames.csv' && name === 'slot') {
    return {
      ...base,
      type: 'enum',
      options: NAME_SLOTS,
      labels: {
        nickname: 'nickname  (a whole name)',
        solo: 'solo  (a whole name, no epithet)',
      },
    };
  }
  // Both closed lists for the same reason: a `perk` or a `bosses` value that
  // matches nothing is not a new tag, it is a name part that silently never
  // appears again. Blank is offered first in each, because blank is the
  // common answer — "any boss" and "the general pool".
  if (file === 'path/src/bossNames.csv' && name === 'perk') {
    return { ...base, type: 'enum', options: ['', ...PERK_IDS], labels: { '': '—  (general pool)' } };
  }
  // One quip, several causes. Closed for the same reason the two above are: a
  // cause id the game doesn't know is dropped at parse with a warning, which
  // leaves a line that reads perfectly in the file and can never fire.
  // The hello at the top of a run tags the same way, about the run BEFORE this
  // one — same closed list, same reason.
  if ((file === 'path/src/quips.csv' || file === 'path/src/greetings.csv') && name === 'causes') {
    return {
      ...base,
      type: 'multi',
      options: DEATH_CAUSES.map((c) => c.id),
      labels: Object.fromEntries(DEATH_CAUSES.map((c) => [c.id, `${c.id}  —  ${c.label}`])),
      blankLabel: 'any death',
      source: 'deathCauses.js',
    };
  }
  // Closed, because the third answer is blank and everything else is a typo
  // that quietly widens a line to both runs \u2014 "Back again?" on somebody's
  // first dive is the failure, and it reads perfectly in the file.
  if (file === 'path/src/greetings.csv' && name === 'when') {
    return {
      ...base,
      type: 'enum',
      options: ['', 'first', 'again'],
      labels: {
        '': '\u2014  (either run)',
        first: 'first  (they have never played)',
        again: 'again  (a run that follows another)',
      },
    };
  }
  if (file === 'path/src/bossNames.csv' && name === 'bosses') {
    // The cell holds SEVERAL ids ("bossShark bossOrca"), which no dropdown can
    // express — so it gets a checklist instead. Still a closed list for the
    // same reason `perk` is: an id that matches nothing is not a new tag, it
    // is a name part that silently never appears again.
    return { ...base, type: 'multi', options: BOSS_IDS, blankLabel: 'any boss', source: 'bosses.csv' };
  }
  // The creature the archetype is built from. A combo rather than an enum so a
  // row can be pointed at a creature that has not been added to enemies.csv
  // yet — the parser refuses it at boot with a message naming the key, which
  // is a better place to find out than a greyed-out dropdown.
  if (file === 'path/src/bosses.csv' && name === 'enemy') {
    return { ...base, type: 'combo', options: ENEMY_IDS };
  }
  // The callout table's own columns. Two closed lists, because both are joins
  // rather than free text: a `kind` the parser doesn't know drops the row, and
  // an `arrow` it doesn't know silently loses the arrow — neither is a typo you
  // would find by looking at the file.
  if (file === 'path/src/callouts.csv') {
    if (name === 'kind') {
      return { ...base, type: 'enum', options: CALLOUT_KINDS,
        labels: { warn: 'warn  (every run)', coach: 'coach  (first run only)' } };
    }
    if (name === 'arrow') {
      return { ...base,
        type: 'enum',
        options: ['', ...ARROW_TARGETS],
        labels: {
          '': '—  (no arrow)',
          chum: 'chum  (the nearest bite)',
          pickup: 'pickup  (the nearest orb of this row\'s own kind)',
          surface: 'surface  (straight up)',
          seabed: 'seabed  (straight down)',
        } };
    }
    if (name === 'anchor') {
      return { ...base, type: 'enum', options: ['', ...CALLOUT_ANCHORS],
        labels: { '': `—  (${CALLOUT_ANCHORS[0]})`, band: 'band  (middle of the screen)', player: 'player  (above the boost ring)' } };
    }
    if (name === 'priority') return { ...base, type: 'number', min: 0 };
    if (name === 'hold') return { ...base, type: 'number', min: 0 };
    // Blank is a real answer here ("never repeats"), so the cell has to be
    // clearable — which the number control allows and an enum would not.
    if (name === 'repeat') return { ...base, type: 'number', min: 0 };
  }
  if (name === 'enabled') return { ...base, type: 'enum', options: ['', 'TRUE', 'FALSE'], labels: { '': '—  (enabled)' } };
  if (name === 'weight') return { ...base, type: 'number', min: 0 };
  // The boss tables' own numbers. Listed by name rather than by file because
  // they mean the same thing in both, and every one of them is a quantity that
  // cannot sensibly be negative.
  if (['sizeMul', 'cooldown', 'windup', 'duration', 'speed', 'radius', 'damage'].includes(name)) {
    return { ...base, type: 'number', min: 0 };
  }
  if (name === 'minLevel') return { ...base, type: 'number', min: 0, integer: true };
  if (name === 'maxStacks') return { ...base, type: 'number', min: 1, integer: true };
  if (name === 'cardArt') return { ...base, type: 'art', options: ['', ...CARD_ART_KEYS] };
  // Options are fetched when the picker opens rather than shipped with the
  // table: the bank is 54 entries and the point of the picker is hearing them,
  // which is a request either way.
  if (name === 'sfx') return { ...base, type: 'sound' };
  // `templated` turns on the {placeholder} affordances — an insert menu and a
  // live preview of what the card will actually read.
  if (name === 'desc') return { ...base, type: 'text', wide: true, templated: true };
  if (name === 'text') return { ...base, type: 'text', wide: true };
  return base;
}

// ---------------------------------------------------------------------------
// CSV IN / OUT
//
// The reader is a straight port of parseCsv from path/src/csvTable.js, on
// purpose: this editor must see the file exactly as the game does, including
// the Excel BOM and the doubled-quote escape, or it would round-trip a row
// into something the game reads differently.
// ---------------------------------------------------------------------------
// `marks`, if given an array, is filled with a matching grid of booleans
// saying which cells arrived wrapped in quotes. The game does not care — it
// reads the same value either way — but the diff does. See writeCsv.
export function parseCsv(text, marks = null) {
  const rows = [], flags = [];
  let row = [], flag = [], field = '', quoted = false, started = false, wasQuoted = false;
  const endField = () => { row.push(field); flag.push(wasQuoted); field = ''; started = false; wasQuoted = false; };
  const endRow = () => { endField(); rows.push(row); flags.push(flag); row = []; flag = []; };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && !started) { quoted = true; started = true; wasQuoted = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRow(); continue; }
    field += c;
    started = true;
  }
  if (field !== '' || row.length) endRow();

  // Drop blank lines — a spreadsheet loves to leave a few at the bottom — from
  // both grids together, so the marks stay aligned to the rows.
  const keep = rows.map((r) => r.some((v) => v.trim() !== ''));
  if (marks) marks.push(...flags.filter((_, i) => keep[i]));
  return rows.filter((_, i) => keep[i]);
}

// Quote only when the value would otherwise reparse wrong.
function needsQuote(s) { return /[",\r\n]/.test(s); }
function quote(s) { return `"${s.replace(/"/g, '""')}"`; }

// Serialize `rows` the way the file on disk already writes itself.
//
// The naive rule — quote if and only if required — is wrong here, and the test
// caught it: musselVolley's description in upgrades.csv is wrapped in quotes it
// does not need, and "Breathe Deep " carries a trailing space with no quotes at
// all. Both reparse perfectly, so both are correct, and rewriting either one is
// churn in a diff that should have shown a single changed cell.
//
// So a cell that still holds the value it had on disk is written back exactly
// as it was found, quotes and all. Only cells you actually changed get
// normalized, and new rows get the plain rule. Matched by id rather than by
// position, so a row added, deleted or moved doesn't drag the rest of the file
// into the diff with it.
export function writeCsv(header, rows, priorText = '') {
  const marks = [];
  const grid = priorText ? parseCsv(priorText, marks) : [];
  const priorHeader = (grid[0] || []).map((h) => h.trim());
  const idCol = priorHeader.indexOf('id');

  const prior = new Map();
  for (let r = 1; r < grid.length; r++) {
    const id = (grid[r][idCol] ?? '').trim();
    if (id && !prior.has(id)) prior.set(id, { cells: grid[r], quoted: marks[r] });
  }

  const cell = (value, was) => {
    const s = String(value ?? '');
    if (needsQuote(s)) return quote(s);
    return was && was.value === s && was.quoted ? quote(s) : s;
  };

  const headerWas = (h, i) => (marks[0] ? { value: priorHeader[i], quoted: marks[0][i] } : null);
  const lines = [header.map((h, i) => cell(h, headerWas(h, i))).join(',')];

  for (const row of rows) {
    const p = prior.get(String(row.id ?? '').trim());
    lines.push(header.map((h) => {
      const at = p ? priorHeader.indexOf(h) : -1;
      const was = at >= 0 ? { value: p.cells[at] ?? '', quoted: !!p.quoted[at] } : null;
      return cell(row[h], was);
    }).join(','));
  }
  return lines.join('\n') + '\n';
}

export async function loadTable(t) {
  const abs = join(ROOT, t.file);
  const [text, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
  const grid = parseCsv(text);
  const header = (grid[0] || []).map((h) => h.trim()).filter(Boolean);
  const rows = grid.slice(1).map((cells) => {
    const rec = {};
    header.forEach((h, c) => { rec[h] = cells[c] ?? ''; });
    return rec;
  });
  return {
    ...t,
    header,
    rows,
    mtimeMs: st.mtimeMs,
    columns: header.map((h) => columnSpec(t.file, h, rows)),
  };
}

// ---------------------------------------------------------------------------
// CARD ART
//
// levelUpImages.js is half a megabyte of base64 on thirty one-line entries.
// Pulled per key with a regex and cached, so opening the picker costs one
// request and the page doesn't carry the whole gallery until you ask for it.
// ---------------------------------------------------------------------------
let artCache = null;
export function cardArt() {
  if (artCache) return artCache;
  artCache = {};
  const src = readSrc('ui/levelUpImages.js');
  for (const m of src.matchAll(/'([\w]+)':\s*\{\s*label:\s*'([^']*)',\s*src:\s*'(data:[^']+)'/g)) {
    artCache[m[1]] = { label: m[2], src: m[3] };
  }
  return artCache;
}

// ---------------------------------------------------------------------------
// SERVER
// ---------------------------------------------------------------------------
const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(join(ROOT, 'tools/csv-editor.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/tables') {
      const tables = await Promise.all(TABLES.map(loadTable));
      return json(res, 200, { tables });
    }

    if (req.method === 'GET' && url.pathname === '/api/cardart') {
      return json(res, 200, cardArt());
    }

    if (req.method === 'GET' && url.pathname === '/api/sounds') {
      return json(res, 200, { sounds: await soundList() });
    }

    // Audio for the preview button. Confined to public/sfx by rebuilding the
    // path from the basename — the query string is the one thing here that a
    // page could put anything into, and this endpoint reads files.
    if (req.method === 'GET' && url.pathname === '/api/sound') {
      const name = basename(url.searchParams.get('file') || '');
      const files = await sfxFiles();
      if (!files.includes(name)) return json(res, 404, { error: `No such sound: ${name}` });
      const bytes = await readFile(join(ROOT, 'public/sfx', name));
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
      return res.end(bytes);
    }

    if (req.method === 'GET' && url.pathname === '/api/tokens') {
      const g = await game();
      return json(res, 200, { tokens: g?.TOKENS ?? [], available: !!g });
    }

    // What a desc will actually read on the card. The whole reason {effect} is
    // measured rather than typed is that nobody can evaluate it by looking at
    // it, so the editor has to show the answer.
    if (req.method === 'POST' && url.pathname === '/api/preview') {
      const body = JSON.parse(await readBody(req));
      const g = await game();
      if (!g) return json(res, 200, { text: null, available: false });
      const u = g.CONFIG.upgrades.find((x) => x.id === body.id);
      if (!u) return json(res, 200, { text: null, error: `No upgrade with id "${body.id}" in config.js.` });
      const warnings = [];
      // Against a COPY: expandDesc doesn't mutate, but this process holds the
      // same CONFIG the preview measures against, and handing it a live entry
      // to an id that also owns an apply() is not a risk worth taking.
      //
      // maxStacks comes from the ROW being edited rather than from config.js,
      // so an unsaved change to the cap is reflected in the preview beside it.
      const cap = body.maxStacks == null || body.maxStacks === '' ? null : Number(body.maxStacks);
      const probe = { ...u, maxStacks: Number.isFinite(cap) ? cap : null };
      const render = (owned) => g.expandDesc(body.desc ?? '', probe, { owned, warn: (m) => warnings.push(m) });

      // Both ends of the card, because they are different cards. {effect} on
      // the first Coiled Spring and on the fourth quote different stacks, and
      // {total} is degenerate at zero owned — it can only ever equal {effect}
      // there, which makes a correct token look broken.
      const first = render(0);
      const laterStack = Number.isFinite(cap) && cap > 1 ? cap : (cap === 1 ? 1 : 5);
      const later = laterStack > 1 ? render(laterStack - 1) : null;
      const stale = await gameIsStale();
      return json(res, 200, {
        text: first,
        later: later === first ? null : later,
        laterStack,
        capped: Number.isFinite(cap) && cap > 1,
        warnings: [...new Set(warnings)],
        available: true,
        stale: stale ? `${stale} changed since this editor started — restart "npm run csv" to preview against it` : null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = JSON.parse(await readBody(req));
      const t = BY_FILE.get(body.file);
      // The whitelist is the whole point: this process can write, and it may
      // only ever write the three files it was built for.
      if (!t) return json(res, 400, { error: `Not an editable table: ${body.file}` });

      const abs = join(ROOT, t.file);
      const st = await stat(abs);
      if (body.mtimeMs && Math.abs(st.mtimeMs - body.mtimeMs) > 1) {
        return json(res, 409, {
          error: `${t.file} changed on disk since this page loaded — another session or editor has it open. Reload to pick up their version (you'll lose these edits), or copy your changes out first.`,
        });
      }

      const priorText = await readFile(abs, 'utf8');
      await writeFile(abs, writeCsv(body.header, body.rows, priorText), 'utf8');
      const after = await stat(abs);
      console.log(`saved ${t.file} — ${body.rows.length} rows`);
      return json(res, 200, { ok: true, mtimeMs: after.mtimeMs });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err && err.message || err) });
  }
});

function readBody(req) {
  return new Promise((ok, fail) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4e6) { fail(new Error('body too large')); req.destroy(); } });
    req.on('end', () => ok(s));
    req.on('error', fail);
  });
}

// Only when run directly: csv-editor-test.mjs imports the parser and the
// schema extractors, and a test run must not leave a listening socket behind.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`CSV editor  →  http://localhost:${PORT}`);
    console.log(`  tables: ${TABLES.map((t) => t.file).join(', ')}`);
    const missing = [];
    if (!Object.keys(ENEMY_REQUIRED).length) missing.push('enemyTable.js column specs');
    if (!CARD_ART_KEYS.length) missing.push('LEVELUP_IMAGE_KEYS');
    if (missing.length) console.warn(`  note: couldn't read ${missing.join(' or ')} — those columns fall back to plain text boxes.`);
  });
}

export const SCHEMA = { ENEMY_REQUIRED, ENEMY_OPTIONAL, ENEMY_FLAGS, CARD_ART_KEYS, SPAWN_GROUPS };
