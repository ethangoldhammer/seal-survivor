#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHAT THE ACCESSORY LAB'S SAVE BUTTON DOES
//
//   npm run accessories:apply [--dry]
//
// The lab (tools/looks/accessory-lab.js) is a viewport with a gizmo on the
// thing the seal is wearing. Dragging it is only worth anything if the number
// it lands on becomes the game's number, so `save` writes
// tools/looks/accessory-lab.json and this splices those numbers into the
// hand-authored `accessories.items` block in config.js — comments left standing
// — and then deletes the `accessories` key from imported-tuning.json.
//
// THE DELETE IS THE HALF THAT IS NOT OBVIOUS, and it is the bug the shader lab
// took three attempts to learn (see the note by clearTuning in
// tools/apply-shaders.mjs). Saved tuning OUTRANKS config.js: the snapshot is
// merged over the defaults at boot, so a value written here that the snapshot
// also holds is shadowed forever and the button looks broken. Writing the
// snapshot instead is not the answer either — it loses the race with any open
// tab, which rewrites the whole file from what it booted with. So the fix is to
// hand ownership back: config.js gets the number, the snapshot loses the key.
//
// Which is also why this REFUSES while a dev server is up. A delete made now is
// undone by that tab's next autosave, minutes later, with nothing said.
//
// The splicing itself is tools/apply-shaders.mjs's, imported rather than
// re-implemented: "put this number into that block in config.js without
// disturbing the prose around it" is one problem however many labs need it, and
// it is a problem with a syntax error in its history. `npm run test:shaders`
// covers the splicer; `npm run test:accessorysave` covers this file's own mapping,
// its refusals, and the snapshot clear.
//
// Like that tool, this reads config.js as TEXT and never imports it, so nothing
// here can pull in the game's config module or its tuning.
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  maskCode, braceBlock, directChild, spliceFields, devServerBlocking, MARK_START,
} from './apply-shaders.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const CONFIG_JS = join(PROJECT, 'path/src/config.js');
const TUNING = join(PROJECT, 'path/src/imported-tuning.json');
export const DEFAULT_SRC = join(PROJECT, 'tools/looks/accessory-lab.json');

// Aliased on one line rather than called by its imported name, so a harness can
// swap it for `async () => false` with a single replacement and still be reading
// the real file. tools/accessory-apply-test.mjs does exactly that: the guard has
// its own reason to exist, and a test that refuses to run whenever the game
// happens to be up is a test that passes by not running.
const guard = devServerBlocking;

// The nine fields an item declares, and the ONLY ones this will write. A
// whitelist rather than "whatever the page sent": the lab renders the resolved
// item, so a key the config deliberately omits comes back carrying a default,
// and splicing everything would invent fields. Same failure the shader lab
// documents at length — rendering a control is not an edit.
//
// `bone` is in the list on purpose — which bone a hat rides is the first thing
// you try when it will not sit right, and it is the one field the lab can
// change without touching the gizmo.
//
// `worn` is NOT, and never was: what the seal has on is one slot at the
// container level (CONFIG.accessories.equipped), not a flag per item. It is
// also not a placement — it is what the player is wearing right now, which the
// menu changes every time somebody pokes the animal. Splicing that into
// config.js would make one session's fiddling the game's default for everybody.
export const FIELDS = [
  'bone', 'snout', 'lift', 'depth', 'pitch', 'yaw', 'roll', 'size',
];

/**
 * Splice one or more items' fields into config.js.
 *
 * @param items  { <assetKey>: { field: value } } — already filtered to what
 *   actually moved. Anything outside FIELDS is dropped here rather than
 *   trusted.
 * @returns { written, notes } — `written` is the dotted leaf paths, which is
 *   exactly what the snapshot clear needs to hand ownership back.
 */
export async function writeItems(items, { dry = false } = {}, notes = []) {
  const keys = Object.keys(items);
  if (!keys.length) return { written: [], notes };

  const text = await readFile(CONFIG_JS, 'utf8');
  const masked = maskCode(text);
  // Never match inside the shader lab's generated block — the same limit that
  // tool's own writers use. Nothing accessory-shaped lives in there today, but
  // "the first `items: {` in the file" is the kind of anchor that is right until
  // somebody generates a second one.
  const generated = text.indexOf(MARK_START);
  const limit = generated > -1 ? generated : text.length;

  const root = braceBlock(masked, 'accessories', 0, limit);
  if (!root) {
    notes.push('! config.js has no `accessories: {` block to write into — nothing written');
    return { written: [], notes };
  }
  // DIRECT CHILDREN, not the first textual match. `items: {` is a common enough
  // name that a plain search inside a 44,000-line file finds somebody else's,
  // and an item's own key would find another asset's block just as happily.
  const itemsBlock = directChild(masked, 'items', root);
  if (!itemsBlock) {
    notes.push('! no `items: {` inside accessories — nothing written');
    return { written: [], notes };
  }

  const changes = [];
  const stale = [];
  const edits = [];
  const written = [];
  for (const key of keys) {
    const block = directChild(masked, key, itemsBlock);
    if (!block) {
      // A new accessory is a config.js edit by hand — an ASSETS entry, a block
      // here and a tuner group. Inventing the block would be inventing two of
      // the three and leaving the third to fail at boot.
      notes.push(`! accessories.items.${key}: no block in config.js — add it by hand first, nothing written`);
      continue;
    }
    const fields = {};
    for (const f of FIELDS) if (f in items[key]) fields[f] = items[key][f];
    if (!Object.keys(fields).length) continue;
    edits.push(...spliceFields(text, masked, block, fields, `accessories.items.${key}`, changes, stale));
    for (const f of Object.keys(fields)) written.push(`accessories.items.${key}.${f}`);
  }

  for (const one of changes) notes.push(`~ ${one}`);
  for (const one of stale) {
    notes.push(`! ${one}: the comment above it argues for the value that was just replaced — reword it`);
  }
  if (!edits.length) return { written: [], notes };

  // Right to left, so one splice cannot move the next one's target — every edit
  // was collected against the ORIGINAL offsets.
  let next = text;
  for (const [start, end, str] of edits.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + str + next.slice(end);
  }
  if (next !== text && !dry) await writeFile(CONFIG_JS, next);
  return { written, notes };
}

/**
 * Drop the leaves config.js now owns out of imported-tuning.json.
 *
 * A LEAF AT A TIME, never the `accessories` container: the container also holds
 * `enabled` and `boneAlign`, and a player who has switched accessories off in
 * the tuner has said something this tool was not asked about.
 */
export async function clearAccessoryTuning(written, { dry = false } = {}, notes = []) {
  if (!written.length) return [];
  if (await guard(new Set(written.map((p) => p.split('.').slice(0, 3).join('.'))), notes)) return [];

  let doc;
  try { doc = JSON.parse(await readFile(TUNING, 'utf8')); } catch { return []; }
  const dropped = [];
  for (const path of written) {
    const parts = path.split('.');
    const leaf = parts.pop();
    let bag = doc;
    for (const step of parts) bag = bag?.[step];
    if (bag && leaf in bag) { delete bag[leaf]; dropped.push(path); }
  }
  // An item left holding nothing is noise in a diff, and so is the container
  // above it — but `accessories` itself stays if anything else is in there.
  const items = doc.accessories?.items;
  if (items) {
    for (const key of Object.keys(items)) if (!Object.keys(items[key]).length) delete items[key];
    if (!Object.keys(items).length) delete doc.accessories.items;
  }
  if (doc.accessories && !Object.keys(doc.accessories).length) delete doc.accessories;

  // Two-space JSON with a trailing newline is byte-for-byte what the game
  // writes, so a run that drops nothing leaves no diff at all.
  if (dropped.length && !dry) await writeFile(TUNING, JSON.stringify(doc, null, 2) + '\n');
  for (const id of dropped) notes.push(`- ${id}: cleared from imported-tuning.json — config.js owns it now`);
  return dropped;
}

/**
 * The whole of what the save button does, and what the CLI runs. One
 * implementation, so the button and the command cannot drift.
 *
 * `doc.items` is the lab's edit buffer: only the accessories whose numbers
 * actually moved, each holding only the fields that moved.
 */
export async function applyPlacements(doc, { dry = false } = {}) {
  const notes = [];
  const items = doc?.items ?? {};
  const { written } = await writeItems(items, { dry }, notes);
  const dropped = await clearAccessoryTuning(written, { dry }, notes);
  return { written, dropped, notes };
}

// --- the CLI ----------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry');
  let doc = {};
  try { doc = JSON.parse(await readFile(DEFAULT_SRC, 'utf8')); } catch {
    console.log(`nothing saved yet — ${DEFAULT_SRC} does not exist. Place something in`
      + ' `npm run looks:accessorylab` and press save.');
    process.exit(0);
  }
  const report = await applyPlacements(doc, { dry });
  for (const n of report.notes) console.log('  ' + n);
  console.log(dry
    ? `\n--dry: ${report.written.length} field(s) would be written, nothing touched.\n`
    : `\n${report.written.length} field(s) written to config.js, ${report.dropped.length} cleared from the snapshot.\n`);
}
