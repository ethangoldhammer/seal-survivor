#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Move the shader lab's decisions into the game.
//
//   npm run looks:shaderlab          choose a surface per creature, hit "record"
//   npm run shaders:apply            write every recorded choice through
//   npm run shaders:apply -- --dry   show what would change and write nothing
//
// The lab's `record` button calls straight into this (see tools/looks/serve.mjs),
// so a choice made in the page reaches the game in one step. The CLI is the same
// code over the whole file, for a batch or a dry run.
//
// The lab writes tools/looks/shader-lab.json. Beside the page, NOT inside the
// build output: that directory is emptied by the `vite build` at the front of
// `npm run looks:shaderlab`, which used to delete the recorded choices before
// this tool ever got to read them.
//
// It holds two different kinds of thing, and they land in two different places:
//
//   THE ASSIGNMENT  which surface each creature wears. That is roster data — a
//                   judgement made against the other rows — so it goes in
//                   assets.csv, in the `surface` column.
//
//   THE NUMBERS     the preset blocks those names point at. Those are CONFIG,
//                   so they go into config.js — see writePresets for the rules
//                   that keep that safe on a hand-authored file.
//
// WHY NOT WRITE THE TUNING FILE. A saved snapshot beats a config default and can
// even change a field's type, and the live game rewrites the whole snapshot from
// whatever it booted with — so a tool that edited it would lose the race with any
// open tab. The CSV and config.js are read fresh on boot. See SERVERS.md.
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const CSV = join(PROJECT, 'path/src/assets.csv');
const CONFIG_JS = join(PROJECT, 'path/src/config.js');
export const DEFAULT_SRC = join(PROJECT, 'tools/looks/shader-lab.json');

// --- the smallest CSV reader/writer that round-trips this file --------------
//
// Quoted cells with commas in them are all over the notes column, so a split(',')
// would corrupt half the file on the first write. Nothing here reformats a row it
// does not change: cells are put back exactly as they came in unless the surface
// cell moved, which keeps the diff to the rows that actually changed.
function parseLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function writeCell(v) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// The cell each recorded creature wants in the `surface` column.
function cellsFor(applied, notes) {
  const cells = new Map();
  for (const [key, entry] of Object.entries(applied)) {
    const kind = entry.surface;
    const a = entry.assets ?? {};
    if (kind === 'texture') cells.set(key, 'texture');
    else if (kind === 'noise') cells.set(key, a.noiseShader ? `noise:${a.noiseShader}` : 'noise');
    else if (kind === 'biolum') cells.set(key, a.biolumSkin ? `biolum:${a.biolumSkin}` : 'biolum');
    else notes.push(`? ${key}: unknown surface "${kind}" — skipped`);
  }
  return cells;
}

async function writeCsv(applied, { dry }, notes) {
  const raw = await readFile(CSV, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const header = parseLine(lines[0]);
  const iId = header.indexOf('id');
  const iSurface = header.indexOf('surface');
  if (iSurface < 0) throw new Error('assets.csv has no `surface` column — add it to the header first.');

  const cells = cellsFor(applied, notes);
  const changed = [];
  const missing = new Set(cells.keys());
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = parseLine(lines[i]);
    const key = row[iId];
    if (!cells.has(key)) continue;
    missing.delete(key);
    const want = cells.get(key);
    // Short rows are legal in a CSV a human has edited; pad rather than throw.
    while (row.length <= iSurface) row.push('');
    if (row[iSurface] === want) continue;
    changed.push(`${key}: ${row[iSurface] || '(blank)'} -> ${want}`);
    row[iSurface] = want;
    lines[i] = row.map(writeCell).join(',');
  }

  // An asset the lab named but the CSV has no row for. REPORTED, not appended:
  // a row here carries a size as well, and inventing one would silently give the
  // creature a size multiplier nobody chose.
  for (const key of missing) {
    notes.push(`! ${key}: no row in assets.csv — add one, then re-run (surface would be "${cells.get(key)}")`);
  }
  if (changed.length && !dry) await writeFile(CSV, lines.join(eol));
  return changed;
}

// --- the numbers, into config.js -------------------------------------------
//
// ONE GENERATED BLOCK AT THE END OF THE FILE, and never an edit to the hand
// written ones above it. Two things make that safe on a file whose whole value
// is the reasoning written beside each number:
//
//   IT IS APPENDED, not spliced. Locating `toonShade.presets` by indentation
//   and inserting into it means parsing 17,000 lines of commented JavaScript —
//   and those line numbers move under you while another session edits the file.
//   The generated region is delimited by two markers and rewritten whole.
//
//   IT DEFERS. The block assigns with `??=`, so a preset that config.js already
//   declares KEEPS its hand-authored value and the lab's copy is dropped. Adding
//   a name that has no home is the only thing this can ever do.
//
// It also creates `presets` on a root that has none — CONFIG.sealShader ships
// with flat fields only, so before this there was nowhere for a per-species
// noise preset to live at all, and every `noise:<name>` silently fell back to
// the base numbers.
const MARK_START = '// >>> shader lab presets — generated by tools/apply-shaders.mjs, do not hand-edit';
const MARK_END = '// <<< end shader lab presets';

// Colours read as hex or they are unreviewable — 6343654 tells you nothing, and
// these lines are meant to be moved up into the hand-written blocks by a person.
function fieldLiteral(key, v) {
  if (typeof v === 'number' && /color/i.test(key)) {
    return `0x${(v >>> 0).toString(16).padStart(6, '0')}`;
  }
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

function renderBlock(presetsByRoot) {
  const roots = Object.entries(presetsByRoot).filter(([, p]) => Object.keys(p).length);
  if (!roots.length) return '';
  const lines = [
    '',
    MARK_START,
    '//',
    '// Written by the shader lab\'s `record` button. ADD-ONLY: `??=` below means a',
    '// preset already declared above wins and the copy here is ignored, so nothing',
    '// hand-authored is ever overwritten. Move any of these up into the block it',
    '// belongs to whenever you want to give it a comment of its own.',
    'for (const [root, presets] of Object.entries({',
  ];
  for (const [root, presets] of roots) {
    lines.push(`  ${root}: {`);
    for (const [name, fields] of Object.entries(presets)) {
      const body = Object.entries(fields)
        .map(([k, v]) => `${k}: ${fieldLiteral(k, v)}`)
        .join(', ');
      lines.push(`    ${JSON.stringify(name)}: { ${body} },`);
    }
    lines.push('  },');
  }
  lines.push('})) {');
  lines.push('  const bag = ((CONFIG[root] ??= {}).presets ??= {});');
  lines.push('  for (const [name, fields] of Object.entries(presets)) bag[name] ??= fields;');
  lines.push('}');
  lines.push(MARK_END);
  return lines.join('\n') + '\n';
}

// Which of these presets CONFIG already declares, for the report — correctness
// comes from the `??=` in the generated block, not from this.
//
// ASKED OF THE LOADED CONFIG, not of the file's text, and the difference is not
// academic. Grepping config.js for `^\s+mightyMeg: {` matches the ENEMY block of
// that name, the boss block, the asset block — anything at all keyed by the
// species. Every per-species preset name is therefore a false positive, and the
// report confidently told you your numbers had been ignored when they had just
// been written. Names are only meaningful under their root.
//
// A child process because config.js needs the vite loader to import at all (a
// JSON import attribute and a `?raw` CSV), and because this file is imported by
// tools/looks/serve.mjs, which must not pull config.js into the look server.
// Reading is all it does; nothing here can reach imported-tuning.json.
async function existingPresets() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // The VALUES, not just the names. Whether the lab's copy of a preset is the
  // one in force cannot be answered by a name: `hide` is declared by hand AND
  // recorded by the lab, so a name-only check called it ours and reported it as
  // written when `??=` had in fact deferred to the hand-authored block.
  const script = 'import("' + pathToFileURL(CONFIG_JS).href + '").then(({CONFIG})=>{'
    + 'const o={};for(const r of ["toonShade","sealShader","biolumSkin"])'
    + 'o[r]=CONFIG[r]?.presets??{};'
    + 'process.stdout.write("@@"+JSON.stringify(o));});';
  try {
    const { stdout } = await run(process.execPath,
      ['--import', join(PROJECT, 'tools/vite-loader.mjs'), '--input-type=module', '-e', script],
      { cwd: PROJECT, timeout: 30000 });
    return JSON.parse(stdout.slice(stdout.indexOf('@@') + 2));
  } catch {
    // Config would not load. Say nothing rather than guess — the `??=` still
    // does the right thing either way.
    return null;
  }
}

// The generated block read back as "root.name" -> the line that declares it, so
// two versions of the file can be compared entry by entry.
function blockEntries(text) {
  const out = new Map();
  const start = text.indexOf(MARK_START);
  if (start < 0) return out;
  const region = text.slice(start, text.indexOf(MARK_END, start));
  let root = null;
  for (const line of region.split('\n')) {
    const r = line.match(/^ {2}([a-zA-Z_$][\w$]*): \{$/);
    if (r) { root = r[1]; continue; }
    const e = line.match(/^ {4}"([^"]+)": (.*)$/);
    if (e && root) out.set(`${root}.${e[1]}`, e[2]);
  }
  return out;
}

async function writePresets(presetsByRoot, { dry }, notes) {
  const text = await readFile(CONFIG_JS, 'utf8');
  // What CONFIG holds BEFORE this write, so a name already declared by hand can
  // be named as deferred-to rather than silently dropped. The generated block is
  // stripped from the comparison the same way it is stripped from the file, so a
  // preset this tool wrote last time counts as ours and can be updated.
  const live = await existingPresets();
  // A preset is "deferred to" when CONFIG holds it with values that are NOT the
  // ones the lab is writing — which is exactly what `??=` does to a name
  // config.js already declares. Comparing only the fields being written, since a
  // hand-authored preset legitimately carries more.
  const already = [];
  if (live) {
    for (const [root, presets] of Object.entries(presetsByRoot)) {
      for (const [name, fields] of Object.entries(presets)) {
        const cur = live[root]?.[name];
        if (!cur) continue;
        const wins = Object.entries(fields).every(([k, v]) => cur[k] === v);
        if (!wins) already.push(`${root}.${name}`);
      }
    }
  }
  for (const one of already) {
    notes.push(`= ${one}: already declared in config.js by hand — left alone, the lab's numbers were NOT applied`);
  }
  const block = renderBlock(presetsByRoot);

  // Strip any previous copy first, so the block moves rather than multiplying.
  let body = text;
  const old = body.indexOf(MARK_START);
  if (old > -1) {
    const end = body.indexOf(MARK_END, old);
    if (end < 0) throw new Error('config.js has a shader-lab start marker with no end marker — fix by hand.');
    body = body.slice(0, old).replace(/\n+$/, '\n') + body.slice(end + MARK_END.length + 1).replace(/^\n/, '');
  }

  // BEFORE THE TUNER SCHEMA, not at the end of the file, and the difference is a
  // preset nobody can reach.
  //
  // The biolum tuner builds one group per preset by walking
  // Object.keys(CONFIG.biolumSkin.presets) — so a preset added after that ran
  // gets no group, no panel and no sliders, and tools/biolum-skin-test.mjs fails
  // on exactly that ("a preset with no group is one nobody can reach").
  // Appending to the end of the file is too late by a few hundred lines.
  // Immediately above the schema is the latest point that is still early enough,
  // and CONFIG is necessarily complete there because the schema reads it.
  const ANCHOR = 'export const TUNER_SCHEMA = [';
  const at = body.indexOf(ANCHOR);
  const next = at > -1
    ? body.slice(0, at) + block.replace(/^\n/, '') + '\n' + body.slice(at)
    : body.replace(/\n*$/, '\n') + block;
  // Only what actually MOVED, so the status line says something. The block is
  // rewritten whole every time, so without this every record reported every
  // preset the block has ever held and the one you just changed was lost in it.
  const before = blockEntries(text);
  const after = blockEntries(next);
  const names = [];
  for (const [id, line] of after) if (before.get(id) !== line) names.push(id);
  if (next !== text && !dry) await writeFile(CONFIG_JS, next);
  return names.filter((n) => !already.includes(n));
}

// Every preset a recorded creature points AT, gathered from what the lab saved.
function presetsFromDoc(doc) {
  const out = { toonShade: {}, sealShader: {}, biolumSkin: {} };
  for (const entry of Object.values(doc.applied ?? {})) {
    for (const [root, byName] of Object.entries(entry.presets ?? {})) {
      if (!out[root]) continue;
      for (const [name, fields] of Object.entries(byName)) {
        if (fields && Object.keys(fields).length) out[root][name] = fields;
      }
    }
  }
  return out;
}

/**
 * Write one recorded document through to the game: the assignments into
 * assets.csv, the numbers into config.js. Returns what changed, for a caller
 * that wants to say so (the lab's status line, or the CLI below).
 */
export async function applyRecorded(doc, { dry = false } = {}) {
  const notes = [];
  const applied = doc.applied ?? {};
  if (!Object.keys(applied).length) return { rows: [], presets: [], notes: ['nothing recorded yet'] };
  const rows = await writeCsv(applied, { dry }, notes);
  const presets = await writePresets(presetsFromDoc(doc), { dry }, notes);
  return { rows, presets, notes };
}

// --- CLI --------------------------------------------------------------------
// Guarded so tools/looks/serve.mjs can import applyRecorded without this running.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const fromArg = argv.indexOf('--from');
  const SRC = fromArg > -1 ? resolve(argv[fromArg + 1]) : DEFAULT_SRC;

  let doc;
  try {
    doc = JSON.parse(await readFile(SRC, 'utf8'));
  } catch (err) {
    console.error(`cannot read ${SRC}\n  ${err.message}\n\n`
      + 'Run the lab and hit "record" on at least one creature first:\n'
      + '  npm run looks:shaderlab');
    process.exit(1);
  }

  const { rows, presets, notes } = await applyRecorded(doc, { dry });
  const verb = dry ? 'WOULD change' : 'wrote';
  if (rows.length) {
    console.log(`${verb} ${rows.length} row(s) in path/src/assets.csv:`);
    for (const r of rows) console.log(`  ${r}`);
  } else {
    console.log('every recorded surface already matches assets.csv.');
  }
  if (presets.length) {
    console.log(`\n${verb} ${presets.length} preset(s) in path/src/config.js:`);
    for (const p of presets) console.log(`  ${p}`);
  }
  for (const n of notes) console.log(`  ${n}`);
}
