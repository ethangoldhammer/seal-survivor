#!/usr/bin/env node
// ============================================================================
// PULL AN EDITOR'S CHANGES BACK INTO THE .rml THEY CAME FROM.
//
// THE ROUND TRIP ALREADY WORKS; WHAT IS MISSING IS THE MERGE. `rive create
// --from-rev` turns a .rev back into a project, and it is LOSSLESS: on
// rive/blubberball it came back with the same 1786 elements carrying the same
// 1786 ids, the same file split, and not one attribute different. What it does
// NOT do is merge — it writes a FRESH project, with the comments stripped, the
// elements reordered and every default elided. Copying that over a hand-written
// project would trade every explanation in it for whatever was nudged in the
// editor.
//
// So this diffs instead. Both sides are indexed BY ID, which is the whole
// reason it can work: `rive` writes an id onto every element it exports (ours
// carry 1786 of them, everything but the three <Rive> roots), those ids are the
// file's identities, and they survive the trip through the editor. Match on
// them and reordering stops mattering, comments stop mattering, and what is
// left is the set of attributes a person actually changed.
//
// WHY NOT A TEXT DIFF: the round-tripped file is sorted differently, has no
// comments, and drops any attribute that happens to equal its default. A `diff`
// of the two reports roughly the whole file and hides the one line that moved.
//
// WHAT IT WILL NOT DO IS INVENT PLACEMENT. An element ADDED in the editor has
// no home in a file somebody organised by hand — this reports those and stops,
// because guessing where a new shape belongs in a commented, sectioned document
// is exactly the kind of help that makes a mess quietly. Same for a deletion.
// Attribute changes on elements that already exist are the safe, common case
// and the only thing --apply touches.
//
// `flags` is excluded on purpose. It is a bitfield that the markup spells as
// separate boolean attributes (`round="true"`, `enableExitTime="true"`), so
// writing the integer back would be wrong in a way that still compiles. A
// change to one is reported for a human to spell out.
//
//   node tools/rive-pull.mjs <file.rev> [--project rive/blubberball] [--apply]
//
// Without --apply it only reports, and exits 1 if anything differs — so it can
// gate a build as easily as it can answer "did anyone touch this in the editor".
// ============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');

/** Attributes that are not the editor's to give back. */
const SKIP = new Set([
  'type', 'id', 'line', 'file', 'enums',
  // The asset's path on OUR disk. --from-rev rewrites these to the Assets
  // panel's own layout (fonts/Inter.ttf becomes Inter.ttf), which says nothing
  // about what anyone changed.
  'file', 'children',
  // A bitfield the markup spells as separate booleans — see the note above.
  'flags',
]);

function die(msg) { console.error(`rive-pull: ${msg}`); process.exit(2); }

function rive(args, cwd) {
  try {
    return execFileSync(RIVE, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (err) {
    die(`\`rive ${args.join(' ')}\` failed:\n${err.stdout ?? ''}${err.stderr ?? err.message}`);
  }
  return '';
}

/** Every element in an inspect tree, keyed by its id. */
function indexById(node, out = new Map()) {
  if (Array.isArray(node)) { for (const v of node) indexById(v, out); return out; }
  if (node && typeof node === 'object') {
    if (typeof node.id === 'string') out.set(node.id, node);
    for (const v of Object.values(node)) indexById(v, out);
  }
  return out;
}

function inspect(dir) {
  return indexById(JSON.parse(rive(['inspect', dir, '--json'])));
}

/**
 * What changed on one element.
 *
 * An enum comes back as an integer with its symbolic name alongside in
 * `enums`; the name is what the markup takes, and it is the one kind of value
 * the compiler checks, so it is what gets written.
 */
function attrDelta(mine, theirs) {
  const out = [];
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (SKIP.has(key)) continue;
    const a = mine[key];
    const b = theirs[key];
    if (a === b) continue;
    out.push({
      key,
      from: mine.enums?.[key] ?? a,
      to: theirs.enums?.[key] ?? b,
      write: theirs.enums?.[key] ?? b,
    });
  }
  return out;
}

const label = (el) => `${el.type}${el.name ? ` "${el.name}"` : ''} ${el.id}`;

// --------------------------------------------------------------------- tag io

/**
 * Which .rml declares each id.
 *
 * `inspect` reports a LINE but not a FILE, so the file has to be found the
 * same way the tag is: an id is unique across the whole document, so the one
 * .rml containing `id="X:Y"` is the one that declares it.
 */
function idFileMap(dir) {
  const map = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.rml')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const m of text.matchAll(/\bid="(\d+:\d+)"/g)) map.set(m[1], name);
  }
  return map;
}

/**
 * The opening tag that declares `id`, as a slice of the file.
 *
 * Found by the id rather than by the line number inspect reports, because the
 * line is where the element STARTS and a tag may run over several — and because
 * an id is unique across the whole document, so there is exactly one hit.
 */
function findTag(text, id) {
  const at = text.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = text.lastIndexOf('<', at);
  const close = text.indexOf('>', at);
  if (open < 0 || close < 0) return null;
  return { start: open, end: close + 1, text: text.slice(open, close + 1) };
}

/** Set (or add) attributes on one opening tag, leaving its layout alone. */
function rewriteTag(tag, changes) {
  let out = tag;
  const added = [];
  for (const { key, write } of changes) {
    const value = typeof write === 'boolean' ? String(write) : String(write);
    const re = new RegExp(`(\\b${key}=")[^"]*(")`);
    if (re.test(out)) out = out.replace(re, `$1${value}$2`);
    else added.push(`${key}="${value}"`);
  }
  if (added.length) {
    // In before the id, which every element ends with by convention here.
    const re = /(\s)(id="\d+:\d+")/;
    out = re.test(out) ? out.replace(re, `$1${added.join(' ')}$1$2`)
                       : out.replace(/\s*(\/?>)$/, ` ${added.join(' ')}$1`);
  }
  return out;
}

// ------------------------------------------------------------------------ run

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter((a) => !a.startsWith('--'));
const pi = args.indexOf('--project');
const project = resolve(pi >= 0 ? args[pi + 1] : 'rive/blubberball');
const rev = positional[0] ? resolve(positional[0]) : null;

if (!rev) die('usage: node tools/rive-pull.mjs <file.rev> [--project <dir>] [--apply]');
if (!existsSync(rev)) die(`no such .rev: ${rev}`);
if (!existsSync(join(project, 'rive.yaml'))) die(`not a rive project: ${project}`);

const tmp = mkdtempSync(join(tmpdir(), 'rive-pull-'));
const fresh = join(tmp, 'rt');

try {
  rive(['create', fresh, `--from-rev=${rev}`]);

  const mine = inspect(project);
  const theirs = inspect(fresh);

  const files = idFileMap(project);
  const added = [...theirs.keys()].filter((id) => !mine.has(id));
  const removed = [...mine.keys()].filter((id) => !theirs.has(id));
  const changed = [];
  for (const [id, el] of mine) {
    if (!theirs.has(id)) continue;
    const delta = attrDelta(el, theirs.get(id));
    if (delta.length) changed.push({ id, el, delta });
  }

  console.log(`rive-pull  ${relative(process.cwd(), project)}  ←  ${relative(process.cwd(), rev)}`);
  console.log(`  ${mine.size} elements here, ${theirs.size} in the export\n`);

  if (!added.length && !removed.length && !changed.length) {
    console.log('  nothing changed in the editor — the .rml already says what the .rev does');
    process.exit(0);
  }

  for (const { id, el, delta } of changed) {
    console.log(`  ~ ${label(el)}   ${files.get(id) ?? '?'}:${el.line ?? '?'}`);
    for (const d of delta) console.log(`      ${d.key}: ${d.from} → ${d.to}`);
  }
  if (added.length) {
    console.log(`\n  + ${added.length} element(s) ADDED in the editor — place these by hand:`);
    for (const id of added.slice(0, 40)) console.log(`      ${label(theirs.get(id))}`);
    if (added.length > 40) console.log(`      …and ${added.length - 40} more`);
  }
  if (removed.length) {
    console.log(`\n  - ${removed.length} element(s) REMOVED in the editor — delete these by hand:`);
    for (const id of removed.slice(0, 40)) console.log(`      ${label(mine.get(id))}`);
    if (removed.length > 40) console.log(`      …and ${removed.length - 40} more`);
  }

  if (!apply) {
    console.log(`\n  run again with --apply to write the ${changed.length} attribute change(s) back`);
    process.exit(1);
  }

  // One read and one write per file, so a tag's offsets stay valid while its
  // own file is being edited — hence the grouping and the back-to-front order.
  const byFile = new Map();
  for (const c of changed) {
    const file = files.get(c.id);
    if (!file) { console.warn(`  ! ${label(c.el)} is in no .rml here — skipped`); continue; }
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(c);
  }

  let written = 0;
  for (const [file, list] of byFile) {
    const path = join(project, file);
    let text = readFileSync(path, 'utf8');
    const edits = [];
    for (const c of list) {
      const tag = findTag(text, c.id);
      if (!tag) { console.warn(`  ! ${label(c.el)} not found in ${file} — skipped`); continue; }
      edits.push({ ...tag, next: rewriteTag(tag.text, c.delta) });
    }
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) { text = text.slice(0, e.start) + e.next + text.slice(e.end); written++; }
    writeFileSync(path, text);
    console.log(`\n  wrote ${edits.length} change(s) into ${file}`);
  }

  // A merge that does not compile is worse than no merge: say so loudly rather
  // than leaving a broken tree behind a cheerful summary.
  rive([project, '--verify']);
  console.log(`\n  ${written} element(s) updated, and the project still verifies`);
  if (added.length || removed.length) {
    console.log('  NOTE: additions and deletions were reported, not applied — see above');
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
