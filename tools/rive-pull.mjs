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
// WITH NO .rev ON THE LINE IT ASKS THE EDITOR. The Rive editor app answers an
// MCP endpoint on localhost, and its export_file tool snapshots the open
// document — unsaved edits included — as a .rev. That is the only way to get
// the editor's copy without a save dialog, and it is what makes the pull a
// button rather than a chore: the workbench (`npm run hub`) runs this with no
// arguments and gets the diff. Two things the fetch insists on, because
// each has bitten: the editor must have THIS project's file open (checked
// against push.fileId in rive.yaml — diffing a different file reports the
// whole document removed, which reads like a catastrophe), and the sandboxed
// editor cannot write to our disk, so the bytes come back inline base64 and
// are written here, to build/editor.rev, where they can be looked at.
//
// Without --apply it only reports, and exits 1 if anything differs — so it can
// gate a build as easily as it can answer "did anyone touch this in the editor".
// ============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const RIVE = process.env.RIVE_CLI || join(process.env.HOME ?? '', '.rive/bin/rive');
// Where the Rive editor app listens for MCP. The same address ~/.claude.json
// binds the `rive` server to; the editor picks it, not us.
const EDITOR_MCP = process.env.RIVE_MCP_URL || 'http://127.0.0.1:9791/mcp';

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
function editorNoise(el, key, from, to) {
  if (key === 'name' && (from ?? '') === '' && to === 'Component') return true;
  if ((key === 'width' || key === 'height') && el.type === 'ImageAsset' && (from ?? 0) === 0) return true;
  return false;
}

function die(msg) { console.error(`rive-pull: ${msg}`); process.exit(2); }

// ------------------------------------------------------------- editor fetch

/**
 * One JSON-RPC call to the editor's MCP endpoint.
 *
 * A session is three messages, and the middle one is the trap: `initialize`
 * hands back a session id, and then a `notifications/initialized` has to be
 * POSTed before any `tools/call` or the server refuses with "Received
 * tools/call before notifications/initialized". The recipe the editor prints
 * in its own permission-denied error skips that step and fails.
 */
async function editorSession() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  let res;
  try {
    res = await fetch(EDITOR_MCP, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rive-pull', version: '1' } },
    }) });
  } catch (err) {
    die(`the Rive editor is not answering at ${EDITOR_MCP} — open the editor app (with the project's file), or pass a .rev on the line\n  ${err.message}`);
  }
  if (!res.ok) die(`editor MCP initialize failed: HTTP ${res.status}`);
  // The editor's server (rive 0.6) issues no session id — it keeps one
  // initialized state for everyone — but the header is honoured if it ever does.
  const sid = res.headers.get('mcp-session-id');
  const h = sid ? { ...headers, 'mcp-session-id': sid } : headers;
  await fetch(EDITOR_MCP, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

  let id = 1;
  return async function call(name, args = {}) {
    const r = await fetch(EDITOR_MCP, { method: 'POST', headers: h, body: JSON.stringify({
      jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args },
    }) });
    const raw = await r.text();
    // Plain JSON on one backend, an SSE frame on the other: take the last data: line.
    const lines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    const body = JSON.parse(lines.length ? lines[lines.length - 1] : raw);
    if (body.error) die(`editor ${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
    const text = body.result?.content?.[0]?.text ?? '';
    if (body.result?.isError) die(`editor ${name}: ${text.split('\n')[0]}`);
    return JSON.parse(text);
  };
}

/** The fileId `rive push` recorded, so the fetch can refuse a different file. */
function pushedFileId(project) {
  const yaml = readFileSync(join(project, 'rive.yaml'), 'utf8');
  return Number(/^\s*fileId:\s*(\d+)/m.exec(yaml)?.[1] ?? 0);
}

/**
 * Snapshot the editor's open document to <project>/build/editor.rev.
 *
 * Overwritten every pull on purpose — it is the editor's state at the moment
 * you asked, not a record, and the record is the .rml this writes into.
 */
async function fetchEditorRev(project) {
  const call = await editorSession();
  const info = await call('session_info');
  const want = pushedFileId(project);
  const open = info.activeFileId;
  if (!want) die('rive.yaml has no push.fileId — `rive push` once so the editor and this project are bound');
  if (open !== want) {
    die(`the editor's active tab is ${info.activeFileName ?? '?'} (file ${open}), not this project's file ${want} — switch tabs in the editor`);
  }
  const out = join(project, 'build');
  mkdirSync(out, { recursive: true });
  // destination is required and refused (sandbox) — inline_base64 is the
  // fallback the tool then takes, and the bytes are written here instead.
  const payload = await call('export_file', { format: 'rev', destination: out, embed_assets: false, inline_base64: true });
  const path = join(out, 'editor.rev');
  if (payload.data) writeFileSync(path, Buffer.from(payload.data, 'base64'));
  else if (payload.path && existsSync(payload.path)) writeFileSync(path, readFileSync(payload.path));
  else die(`editor export returned neither bytes nor a file: ${JSON.stringify(payload).slice(0, 200)}`);
  console.log(`rive-pull  fetched the editor's copy of ${info.activeFileName} → ${relative(process.cwd(), path)}`);
  return path;
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
const rev = positional[0] ? resolve(positional[0]) : await fetchEditorRev(project);
if (!existsSync(rev)) die(`no such .rev: ${rev}`);

const tmp = mkdtempSync(join(tmpdir(), 'rive-pull-'));
const fresh = join(tmp, 'rt');

try {
  rive(['create', fresh, `--from-rev=${rev}`]);

  const mine = inspect(project);
  const theirs = inspect(fresh);

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

  console.log(`rive-pull  ${relative(process.cwd(), project)}  ←  ${relative(process.cwd(), rev)}`);
  console.log(`  ${mine.size} elements here, ${theirs.size} in the export\n`);

  const housekeeping = [];
  if (renumbered.length) housekeeping.push(`${renumbered.length} renumbered by the push`);
  if (scanned.length) housekeeping.push(`${scanned.length} shader(s) the build scans in`);
  if (housekeeping.length) console.log(`  (ignoring ${housekeeping.join(', ')} — same elements, nothing to do)\n`);

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
