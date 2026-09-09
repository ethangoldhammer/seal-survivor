#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Move the level-up look page's FEEL into the game.
//
//   npm run looks:levelup              set the seal and the tooltip, hit
//                                      "Write to config.js"
//   npm run feel:apply                 write the saved preset through
//   npm run feel:apply -- --dry        show what would change, write nothing
//
// The page's Save feel writes tools/looks/level-up-seal-feel.json — a flat map
// of full CONFIG paths (`levelUpSeal.motion.blendTime`, `cardTip.cards.1.x`)
// to values. The game never reads that file: it boots config.js, and every
// one of those paths is a hand-authored number there. This writes them in,
// through the same masked-text splice the shader lab uses (tools/apply-
// shaders.mjs), so the file's comments and layout survive and only the
// literal after each colon moves.
//
// THE SNAPSHOT SHADOWS ALL OF IT. The tuner (`) has rows for the whole
// levelUpSeal block, so imported-tuning.json holds a copy of every one of
// these numbers the moment the game has saved once — and a saved value beats
// the config.js default. So a written path is DELETED from the snapshot too,
// which hands it back to config.js; refused while the game is up, for the
// race the shader lab spells out (its devServerBlocking is the guard here).
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { maskCode, braceBlock, spliceFields, MARK_START, devServerBlocking } from './apply-shaders.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
export const DEFAULT_SRC = join(PROJECT, 'tools/looks/level-up-seal-feel.json');
const CONFIG_JS = join(PROJECT, 'path/src/config.js');
const TUNING = join(PROJECT, 'path/src/imported-tuning.json');

// What the page may write. Anything else in the file is ignored with a note —
// a preset is a document a person can edit, and a path this tool does not
// know is more likely a typo than a new field.
const ROOTS = ['levelUpSeal', 'cardTip'];
// Which top-level CONFIG blocks a preset may write, and which one an un-rooted
// key belongs to. The level-up feel's by default; tools/apply-ball-lab.mjs
// passes the versus ball's, and the machinery below is otherwise the same.
const rootedIn = (roots, path) => (roots.some((r) => path.startsWith(r + '.')) ? path : roots[0] + '.' + path);

// The `[...]` that `key` opens, as [open, close] — braceBlock's twin for an
// array field such as `cards: [`.
function bracketBlock(masked, key, from, to) {
  const re = new RegExp(`(^|[\\s,{])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*\\[`, 'gm');
  re.lastIndex = from;
  const m = re.exec(masked);
  if (!m || m.index >= to) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (masked[i] === '[') depth++;
    else if (masked[i] === ']') { depth--; if (!depth) return [open, i]; }
  }
  return null;
}

// The nth `{...}` element of an array block.
function nthElement(masked, [open, close], n) {
  let depth = 0; let idx = -1; let start = -1;
  for (let i = open + 1; i < close; i++) {
    const ch = masked[i];
    if (ch === '{') { if (depth === 0) { idx++; start = i; } depth++; } else if (ch === '}') {
      depth--;
      if (depth === 0 && idx === n) return [start, i];
    }
  }
  return null;
}

/**
 * The `{...}` a dotted container path names, walking objects and array
 * elements: `levelUpSeal.motion` -> the motion block; `cardTip.cards.1` ->
 * the second object in the cards array. Null when any step is missing.
 */
export function locateBlock(masked, segments, limit) {
  return locateFrom(masked, segments, 0, 0, limit);
}

// The walk, one segment at a time. A NAMED segment may match more than once
// inside its parent — `fx: {` is a key on half the creatures long before the
// top-level effects block — so a match whose inside does not hold the rest of
// the path is stepped past rather than reported as "no such block".
function locateFrom(masked, segs, i, from, to) {
  const seg = segs[i];
  const last = i === segs.length - 1;
  if (/^\d+$/.test(seg)) {
    const arr = bracketBlock(masked, segs[i - 1], from, to);
    if (!arr) return null;
    const block = nthElement(masked, arr, Number(seg));
    if (!block) return null;
    return last ? block : locateFrom(masked, segs, i + 1, block[0], block[1]);
  }
  // An array follows: the element step below looks the array up by THIS name
  // inside the current block, so this segment claims no block of its own.
  if (/^\d+$/.test(segs[i + 1] ?? '')) return locateFrom(masked, segs, i + 1, from, to);
  let start = from;
  for (;;) {
    const block = braceBlock(masked, seg, start, to);
    if (!block) return null;
    if (last) return block;
    const inner = locateFrom(masked, segs, i + 1, block[0], block[1]);
    if (inner) return inner;
    start = block[1];
  }
}

/**
 * @param preset  { 'levelUpSeal.motion.blendTime': 0.68, ... } — un-rooted
 *                keys are the seal's, as the page saved them before the
 *                tooltip joined.
 * @returns { changes, stale, cleared, notes, wrote }
 */
export async function applyFeel(preset, { dry = false, configPath = CONFIG_JS, tuningPath = TUNING, guard = true, roots = ROOTS } = {}) {
  const notes = [];
  const changes = [];
  const stale = [];
  // Group leaves by their container.
  const byBlock = new Map();
  for (const [k, v] of Object.entries(preset ?? {})) {
    if (k.startsWith('__')) continue;
    const path = rootedIn(roots, k);
    if (!roots.some((r) => path.startsWith(r + '.'))) { notes.push(`? ${k}: not a ${roots.join('/')} path — skipped`); continue; }
    if (v === null || v === undefined || (typeof v === 'object')) { notes.push(`? ${path}: not a number, string or boolean — skipped`); continue; }
    const segs = path.split('.');
    const leaf = segs.pop();
    const key = segs.join('.');
    if (!byBlock.has(key)) byBlock.set(key, {});
    byBlock.get(key)[leaf] = v;
  }

  const text = await readFile(configPath, 'utf8');
  const masked = maskCode(text);
  const generated = text.indexOf(MARK_START);
  const limit = generated > -1 ? generated : text.length;
  const edits = [];
  const written = [];
  for (const [key, fields] of byBlock) {
    const block = locateBlock(masked, key.split('.'), limit);
    if (!block) { notes.push(`! ${key}: config.js has no such block — ${Object.keys(fields).join(', ')} not written`); continue; }
    const before = changes.length;
    edits.push(...spliceFields(text, masked, block, fields, key, changes, stale));
    for (const leaf of Object.keys(fields)) written.push(`${key}.${leaf}`);
    if (changes.length === before) notes.push(`= ${key}: ${Object.keys(fields).join(', ')} already as saved`);
  }
  let wrote = false;
  if (edits.length && !dry) {
    // Right to left, so one splice cannot move the next one's target.
    edits.sort((a, b) => b[0] - a[0]);
    let out = text;
    for (const [s, e, v] of edits) out = out.slice(0, s) + v + out.slice(e);
    await writeFile(configPath, out);
    wrote = true;
  }
  for (const one of changes) notes.push(`~ ${one}`);
  for (const one of stale) notes.push(`! ${one}: the comment above it argues for the value just replaced — reword it`);

  // THE SNAPSHOT. Every written path is deleted from it, so config.js owns
  // the number again. Only what was written: a path config.js had no block
  // for stays shadowed, and says so above.
  const cleared = [];
  if (written.length) {
    const blocked = guard ? await devServerBlocking(new Set(written), notes) : false;
    if (!blocked) {
      let doc = null;
      try { doc = JSON.parse(await readFile(tuningPath, 'utf8')); } catch { doc = null; }
      if (doc) {
        for (const path of written) {
          const segs = path.split('.');
          let o = doc;
          for (const s of segs.slice(0, -1)) { o = o?.[s]; if (!o || typeof o !== 'object') break; }
          const leaf = segs[segs.length - 1];
          if (o && typeof o === 'object' && leaf in o) { if (!dry) delete o[leaf]; cleared.push(path); }
        }
        if (cleared.length && !dry) await writeFile(tuningPath, JSON.stringify(doc, null, 2) + '\n');
        if (cleared.length) notes.push(`- snapshot: ${cleared.length} shadowing value(s) cleared — ${cleared.join(', ')}`);
      }
    }
  }
  return { changes, stale, cleared, notes, wrote, dry };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dry = process.argv.includes('--dry');
  const src = process.argv.find((a) => a.endsWith('.json')) ?? DEFAULT_SRC;
  const preset = JSON.parse(await readFile(src, 'utf8'));
  const r = await applyFeel(preset, { dry });
  for (const n of r.notes) console.log(`  ${n}`);
  console.log(r.dry ? '\n(dry run — nothing written)' : r.wrote ? '\nwrote path/src/config.js' : '\nconfig.js already matches');
}
