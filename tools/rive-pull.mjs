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
//   node tools/rive-pull.mjs [--project <dir>] [<file.rev>] [--apply]
//
// The project defaults to rive/blubberball; `npm run sealitaire:pull` is the
// same tool with --project rive/sealitaire already on the line.
//
// WHERE THE EDITOR'S COPY COMES FROM: `rive pull`, since CLI 1.1.0. The CLI
// downloads the linked file itself (rive.yaml's push.fileId) and writes it
// out as a project — so the editor app does not have to be running, nothing
// has to be saved by hand, and there is no MCP session to negotiate. This
// tool pulls into a THROWAWAY directory seeded with nothing but rive.yaml,
// which is the whole trick: `rive pull` is "the remote wins" and would
// happily overwrite today's scripts and shaders with whatever was last
// pushed, so it is never pointed at the real project. The snapshot it writes
// is read, diffed, and deleted.
//
// (It replaces a session against the editor app's own MCP endpoint, which
// needed the right tab open and returned a .rev inline as base64. A .rev
// path on the command line still works, for diffing an export off disk.)
//
// Without --apply it only reports, and exits 1 if anything differs — so it can
// gate a build as easily as it can answer "did anyone touch this in the editor".
//
// TWO THINGS --apply REFUSES TO DO, both because they happened:
//
//   A REFERENCE TO SOMETHING WE DO NOT HAVE. An attribute whose value is an
//   id (`fontAssetId`, `styleId`, an artboard ref) is only meaningful beside
//   the element it names. Pull a label whose font was changed in the editor
//   to a font ADDED there, and the id lands while the <FontAsset> and the
//   .ttf — an addition, which this refuses to place — do not. The markup then
//   points at nothing: `fontAssetId="1:9409" matches no id in this file`, the
//   build fails, and the failure is nowhere near the pull. Those changes are
//   held back now and reported with the asset they need.
//
//   LEAVING A BROKEN TREE. The verify used to run AFTER the write, so a merge
//   that did not compile exited loudly with the damage already on disk. Every
//   touched file is snapshotted first and restored if the verify fails.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
  // The cloud's own id for a hosted asset. Ours is a path on disk; the editor
  // assigns the number when the file is pushed, so every asset "changes" on
  // every pull and none of it means anyone touched anything.
  'assetId',
  // Derived from a script's Luau source by the compiler — which methods it
  // implements, which generator it runs — and recomputed on every build. The
  // .luau is the truth and these follow it; written back, they would be
  // right until the next edit and then quietly wrong.
  'generatorFunctionRef', 'serializedImplementedMethods',
]);

/**
 * A change the editor makes on its own, not one a person made.
 *
 * Two the diff cannot tell from a real edit by key alone: the editor names
 * every unnamed object "Component" the moment it loads, and it measures an
 * image's pixel size into the ImageAsset (the .rml leaves both at 0 on
 * purpose — the file on disk is the size). Both would be written back as
 * clutter and the next pull would report them again on every element the
 * .rml still leaves blank.
 */
/**
 * id -> the stem of the `file` this element declares, for every *Asset in the
 * project's markup. `rive inspect` does not report an asset's file (it is our
 * path on disk, not the document's business), so it is read from the .rml.
 */
const assetStem = new Map();
function readAssetStems(dir) {
  assetStem.clear();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.rml')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const m of text.matchAll(/<\w*Asset\b[^>]*>/g)) {
      const id = /\bid="(\d+:\d+)"/.exec(m[0])?.[1];
      const file = /\bfile="([^"]+)"/.exec(m[0])?.[1];
      if (id && file) assetStem.set(id, file.split('/').pop().replace(/\.[^.]+$/, ''));
    }
  }
}

function editorNoise(el, key, from, to) {
  if (key === 'name' && (from ?? '') === '' && to === 'Component') return true;
  if ((key === 'width' || key === 'height') && el.type === 'ImageAsset' && (from ?? 0) === 0) return true;
  // AN ASSET'S NAME BELONGS TO ITS FILE, and `file` is skipped above, so a
  // name applied on its own splits the pair. The generated blocks are why
  // this is not theoretical: the sfx bank and its processed takes number
  // their <AudioAsset> lines POSITIONALLY, so after either is rebaked 0:1400
  // means a different sound here than it does in a file pushed before the
  // bake — and a pull matching on id copied four remote names onto four
  // unrelated local sounds, leaving `file="sfx/seal-07-distant.flac"
  // name="hg-cards-034-phaser"` and a bank that no longer resolved. Where
  // our name IS the file's stem, the file is the truth and the name follows
  // it, never the export.
  if (key === 'name' && assetStem.get(el.id) === from) return true;
  return false;
}

function die(msg) { console.error(`rive-pull: ${msg}`); process.exit(2); }

// --------------------------------------------------------------- the remote

function pushedFileId(project) {
  const yaml = readFileSync(join(project, 'rive.yaml'), 'utf8');
  return Number(/^\s*fileId:\s*(\d+)/m.exec(yaml)?.[1] ?? 0);
}

/**
 * The linked Rive file, downloaded into a throwaway project.
 *
 * Seeded with rive.yaml ALONE: `rive pull` reports what it changed against
 * whatever is already in the directory, so a copy of the project would hide
 * every difference behind "already matched" — and pointing it at the real
 * project would overwrite it. An empty seed makes every file it writes the
 * remote's own, which is exactly the snapshot to diff against.
 */
function fetchRemote(project, into) {
  if (!pushedFileId(project)) {
    die('rive.yaml has no push.fileId — `rive push` once so the project and the file are linked');
  }
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, 'rive.yaml'), readFileSync(join(project, 'rive.yaml')));
  // The download crashes now and then on a thread it is waiting on
  // (`condition_variable wait failed`, out of the CLI's own C++), and a
  // second go has always worked. A transient crash reading as "the pull tool
  // is broken" is worse than the wait: try again, and only then give up.
  let out = '';
  for (let attempt = 1; ; attempt++) {
    try {
      out = execFileSync(RIVE, ['pull', into, '--yes', '--quiet'], { encoding: 'utf8', maxBuffer: 1 << 28 });
      break;
    } catch (err) {
      const why = `${err.stdout ?? ''}${err.stderr ?? err.message}`;
      if (attempt >= 3) die(`\`rive pull\` failed ${attempt} times:\n${why}`);
      console.log(`rive-pull  the download crashed, trying again (${attempt}/2)`);
      rmSync(into, { recursive: true, force: true });
      mkdirSync(into, { recursive: true });
      writeFileSync(join(into, 'rive.yaml'), readFileSync(join(project, 'rive.yaml')));
    }
  }
  const line = out.split('\n').find((l) => l.startsWith('pulled file')) ?? '';
  console.log(`rive-pull  ${line.trim() || 'downloaded the linked file'}`);
  return into;
}

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
    if (editorNoise(mine, key, a, b)) continue;
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
const pi = args.indexOf('--project');
const eq = args.find((a) => a.startsWith('--project='));
const project = resolve(eq ? eq.slice('--project='.length) : pi >= 0 ? args[pi + 1] : 'rive/blubberball');
// `--project` takes a VALUE, and a value does not start with a dash — so the
// naive "anything without a leading --" read swallows it as the .rev. That is
// not hypothetical: `sealitaire:pull` puts --project on the script line, so
// the path the user appends arrives SECOND and the tool would have tried to
// open the project directory as a revision. Drop the value with the flag.
const positional = args.filter((a, i) => !a.startsWith('--') && i !== pi + 1);

if (!existsSync(join(project, 'rive.yaml'))) die(`not a rive project: ${project}`);
const rev = positional[0] ? resolve(positional[0]) : null;
if (rev && !existsSync(rev)) die(`no such .rev: ${rev}`);

const tmp = mkdtempSync(join(tmpdir(), 'rive-pull-'));
const fresh = join(tmp, 'rt');

try {
  // A .rev on the line is converted the old way; with nothing on the line the
  // CLI downloads the linked file itself.
  if (rev) rive(['create', fresh, `--from-rev=${rev}`]);
  else fetchRemote(project, fresh);

  const mine = inspect(project);
  const theirs = inspect(fresh);
  readAssetStems(project);

  const files = idFileMap(project);
  let added = [...theirs.keys()].filter((id) => !mine.has(id));
  let removed = [...mine.keys()].filter((id) => !theirs.has(id));

  // TWO KINDS OF "ADDED" THAT ARE NOT. Every pull of rive/sealitaire used to
  // list 29 additions and 19 removals that nobody made and nobody could act
  // on, and the real edit sat above them, five lines in a hundred.
  //
  //   RENUMBERED: `rive push` gives ScriptInputArtboards fresh ids on the way
  //   up (0:600 here becomes 1:9342 there), so the same element is "removed"
  //   under its old id and "added" under the new one. Pair by type and name,
  //   one-to-one on both sides, and it is one element that moved house.
  //
  //   SCANNED: shaders need no markup — the build takes every .wgsl in the
  //   project — but the editor stores them as ShaderAssets with ids, so they
  //   are always "added". A ShaderAsset whose name is a .wgsl on disk is ours.
  const wgsl = new Set(readdirSync(project).filter((n) => n.endsWith('.wgsl')).map((n) => n.slice(0, -5)));
  const sig = (el) => `${el.type}\u0000${el.name ?? ''}`;
  const count = (ids, src) => { const m = new Map(); for (const id of ids) { const k = sig(src.get(id)); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const addedBy = count(added, theirs);
  const removedBy = count(removed, mine);
  const renumbered = [];
  const scanned = [];
  added = added.filter((id) => {
    const el = theirs.get(id);
    if (el.type === 'ShaderAsset' && wgsl.has(el.name)) { scanned.push(id); return false; }
    const k = sig(el);
    if (addedBy.get(k) === 1 && removedBy.get(k) === 1) { renumbered.push(el); return false; }
    return true;
  });
  removed = removed.filter((id) => { const k = sig(mine.get(id)); return !(addedBy.get(k) === 1 && removedBy.get(k) === 1); });

  const changed = [];
  for (const [id, el] of mine) {
    if (!theirs.has(id)) continue;
    const delta = attrDelta(el, theirs.get(id));
    if (delta.length) changed.push({ id, el, delta });
  }

  // AN ID IS ONLY MEANINGFUL BESIDE THE THING IT NAMES. Split off every
  // change whose new value points at an element this project does not have:
  // applying one writes a reference to nothing, and the build fails somewhere
  // else entirely (see the note at the top). What it wants is an ADDITION,
  // which this tool does not place, so it is reported with the element it
  // needs and left for a person.
  const idRef = /^\d+:\d+$/;
  const refKey = (k) => /(?:Id|Ids|Ref|Refs)$/.test(k);
  const dangling = [];
  for (const c of changed) {
    c.delta = c.delta.filter((d) => {
      if (!refKey(d.key)) return true;
      const targets = String(d.to ?? '').split(/[\s,;-]+/).filter((v) => idRef.test(v));
      const missing = targets.filter((v) => !mine.has(v));
      if (!missing.length) return true;
      dangling.push({ el: c.el, d, missing, wants: missing.map((m) => theirs.get(m)).filter(Boolean) });
      return false;
    });
  }
  for (let i = changed.length - 1; i >= 0; i--) if (!changed[i].delta.length) changed.splice(i, 1);

  console.log(`rive-pull  ${relative(process.cwd(), project)}  ←  ${rev ? relative(process.cwd(), rev) : `the linked file (${pushedFileId(project)})`}`);
  console.log(`  ${mine.size} elements here, ${theirs.size} in the export\n`);

  const housekeeping = [];
  if (renumbered.length) housekeeping.push(`${renumbered.length} renumbered by the push`);
  if (scanned.length) housekeeping.push(`${scanned.length} shader(s) the build scans in`);
  if (housekeeping.length) console.log(`  (ignoring ${housekeeping.join(', ')} — same elements, nothing to do)\n`);

  if (!added.length && !removed.length && !changed.length && !dangling.length) {
    console.log('  nothing changed in the editor — the .rml already says what the remote does');
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
  if (dangling.length) {
    console.log(`\n  ! ${dangling.length} change(s) POINT AT SOMETHING THIS PROJECT DOES NOT HAVE — not applied:`);
    for (const g of dangling) {
      console.log(`      ${label(g.el)}`);
      console.log(`        ${g.d.key}: ${g.d.from} → ${g.d.to}`);
      for (const w of g.wants) {
        const file = w.file ? `, file "${w.file}"` : '';
        console.log(`        needs ${w.type}${w.name ? ` "${w.name}"` : ''} ${w.id}${file} — add it first, then pull again`);
      }
      for (const m of g.missing) if (!g.wants.some((w) => w.id === m)) console.log(`        needs ${m}, which is not in the remote either`);
    }
  }

  if (!apply) {
    console.log(`\n  run again with --apply to write the ${changed.length} attribute change(s) back`);
    process.exit(1);
  }
  if (!changed.length) {
    console.log('\n  nothing --apply can write: everything above needs a person');
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

  // THE SNAPSHOT. A merge that does not compile used to exit loudly with the
  // damage already written, which is how a dangling font reference outlived
  // the pull that made it. Every file this is about to touch is kept here and
  // put back if the verify fails.
  const before = new Map();
  for (const file of byFile.keys()) before.set(file, readFileSync(join(project, file)));

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

  // A merge that does not compile is worse than no merge: put every file back
  // and say what it was, rather than leaving a broken tree behind a cheerful
  // summary — or behind a loud failure, which is just as broken.
  try {
    execFileSync(RIVE, [project, '--verify'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (err) {
    for (const [file, bytes] of before) writeFileSync(join(project, file), bytes);
    const out = `${err.stdout ?? ''}${err.stderr ?? err.message}`;
    console.error(`\n  the merged project does not verify — every file put back, nothing changed:\n${out.split('\n').filter((l) => /error/.test(l)).slice(0, 8).join('\n')}`);
    process.exit(2);
  }
  console.log(`\n  ${written} element(s) updated, and the project still verifies`);
  if (added.length || removed.length || dangling.length) {
    console.log('  NOTE: additions, deletions and dangling references were reported, not applied — see above');
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
