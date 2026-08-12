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
const PORT = Number(process.env.CSV_EDITOR_PORT || 5177);

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
    hp: 'Starting health at difficulty 0.',
    hpPerDifficulty: 'Health gained per difficulty point (1 point = 20s).',
    speed: 'Base swim speed.',
    speedVariance: 'Per-individual speed jitter.',
    speedPerDifficulty: 'Linear speed gain per difficulty point.',
    turnRate: 'Radians/sec. Blank means it pivots on the spot.',
    contactDamage: 'Damage dealt on touching the seal.',
    contactDamagePerDifficulty: 'Contact damage gained per difficulty point.',
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
  },
  // The three path-keyed tables share one column contract, so the docs are
  // written once and pointed at rather than copied into places that drift.
  'assets.csv': {
    id: 'The ASSET key from assets.js \u2014 not a creature id. One asset can back several creatures, and plenty (grass, boats, the escorts) are not creatures at all.',
    size: 'Spawn scale for this model. Applies to FUTURE spawns; anything already on screen keeps the size it was created at. The hitbox is derived from it, so a bigger model is a genuinely bigger target.',
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
    text: 'The game-over headline itself.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows. Blank = 1, 0 is never shown.',
  },
  'bossNames.csv': {
    id: 'A short handle for the row. Never shown to the player — it exists so a reworded part keeps its identity in a diff.',
    slot: 'Which PART of the name this is: prefix ("Gore") + root ("maw") make the name, epithet ("the Devourer") follows it. Any other value is ignored, loudly.',
    text: 'The part itself, used with exactly the capitalisation typed here — prefixes are capitalised, roots are not, and an epithet carries its own article.',
    enabled: 'FALSE takes it out of rotation. Blank means enabled.',
    weight: 'Likelihood relative to the other rows IN THE SAME SLOT. Blank = 1, 0 is never used.',
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
    contactDamagePerDifficulty: '0', scalePerDifficulty: '0', maxGrowth: '∞',
    scaleVariance: '0',
    weightPerDifficulty: '0', maxWeight: '∞', maxConcurrent: '∞',
    minDifficulty: '0', minPlayerLevel: '0', spawnRateMul: '1',
    spawnGroup: 'no group', bioluminescent: 'no', bossMinion: 'no',
  },
  'upgrades.csv': { maxStacks: 'unlimited', enabled: 'enabled', weight: '1', name: 'built-in', desc: 'built-in', cardArt: 'plain card', sfx: 'standard level-up' },
  'quips.csv': { enabled: 'enabled', weight: '1' },
  'bossNames.csv': { enabled: 'enabled', weight: '1', notes: '—' },
  // A blank spawn value means "leave the built-in alone", NOT zero — zero
  // would switch a system off, which is the opposite of leaving it alone.
  'spawning.csv': { value: 'config.js default', min: '—', max: '—', notes: '—' },
  'weapons.csv': { value: 'config.js default', min: '—', max: '—', notes: '—' },
  'behaviour.csv': { value: 'config.js default', min: '—', max: '—', notes: '—' },
  'assets.csv': { size: '1 (unscaled)', notes: '—' },
};

// ---------------------------------------------------------------------------
// THE TABLES
// ---------------------------------------------------------------------------
export const TABLES = [
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
    file: 'path/src/quips.csv',
    label: 'Death quips',
    blurb: 'The game-over headline. This table joins to nothing in code, so new lines are just new rows — add away.',
    addRows: true,
  },
  {
    file: 'path/src/bossNames.csv',
    label: 'Boss names',
    blurb: 'What the giant shark is called. These are PARTS, not names — a prefix, a root and an epithet are drawn separately, so eight of each is hundreds of sharks. Joins to nothing in code; add away.',
    addRows: true,
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

  // A closed list, unlike enemies.csv's spawnGroup combo above: an unknown
  // slot is not a new kind of name part, it is a part that never appears.
  if (file === 'path/src/bossNames.csv' && name === 'slot') {
    return { ...base, type: 'enum', options: ['prefix', 'root', 'epithet'] };
  }
  if (name === 'enabled') return { ...base, type: 'enum', options: ['', 'TRUE', 'FALSE'], labels: { '': '—  (enabled)' } };
  if (name === 'weight') return { ...base, type: 'number', min: 0 };
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
