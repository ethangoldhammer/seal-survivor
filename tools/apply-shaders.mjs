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
// It also creates `presets` on a root that has none. That is still true of any
// future root, though not of CONFIG.sealShader any more — the two shark presets
// were promoted into the hand-written block when the wet film shipped, because
// a base `wet` above 0 would otherwise have glossed both of them. The `??=`
// above is what makes that promotion safe: the copies down here are simply
// ignored.
const MARK_START = '// >>> shader lab presets — generated by tools/apply-shaders.mjs, do not hand-edit';
const MARK_END = '// <<< end shader lab presets';

// Colours read as hex or they are unreviewable — 6343654 tells you nothing, and
// these lines are meant to be moved up into the hand-written blocks by a person.
function fieldLiteral(key, v) {
  if (typeof v === 'number' && /color/i.test(key)) {
    return `0x${(v >>> 0).toString(16).padStart(6, '0')}`;
  }
  // SINGLE QUOTES, because these land in hand-written config.js now and not
  // only in the generated block. JSON.stringify's double quotes were reported
  // as a change on every run — `pattern: 'spots' -> "spots"` — which is noise
  // in a report whose whole job is to say what actually moved.
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(v);
}

// Is the literal already in the file the one being written? Compared with the
// quotes normalised, so a preset the generated block wrote as "veins" years ago
// does not read as different from `'veins'`.
function sameLiteral(a, b) {
  const norm = (t) => t.trim().replace(/^"(.*)"$/, "'$1'");
  return norm(a) === norm(b);
}

// Renders from LINES, not objects, because the block is cumulative: everything
// it already held has to survive a run that names one creature. `merged` is
// "root.name" -> the literal after the colon, which is exactly what
// blockEntries reads back out, so a line this tool wrote last week re-emits
// byte-identical instead of being re-derived from something that no longer
// exists in the document.
function renderBlock(merged) {
  const byRoot = new Map();
  for (const [id, line] of merged) {
    const dot = id.indexOf('.');
    const root = id.slice(0, dot);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push([id.slice(dot + 1), line]);
  }
  const roots = [...byRoot];
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
  for (const [root, entries] of roots) {
    lines.push(`  ${root}: {`);
    for (const [name, line] of entries) lines.push(`    ${JSON.stringify(name)}: ${line}`);
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

// --- writing INTO the hand-authored blocks ----------------------------------
//
// The generated block at the end of config.js can only ADD names (see
// writePresets). This is the other half: when the lab records a preset that
// config.js already declares by hand, the numbers are written into that block,
// in place, with its comments left standing.
//
// WHY NOT INDENTATION. The obvious locator is "a line with six spaces and the
// preset's name", and it is wrong on this file: `biolumSkin` and its own
// `presets` are both written at four spaces, so the container is indented level
// with its parent. Anything counting columns finds nothing here or, worse,
// finds a key of the same name under a different root. So the blocks are found
// by BRACE MATCHING from the root name down — root, then `presets`, then the
// preset — which is indifferent to how the file is laid out.
//
// COMMENTS AND STRINGS ARE MASKED FIRST. config.js argues with itself in prose
// all the way down, and that prose contains braces (`{ ...base, ...preset }` is
// in three notes) and apostrophes. Counting braces over the raw text ends up
// inside a comment within about forty lines. `maskCode` blanks comment bodies
// and string bodies while preserving every offset, so the search runs over the
// code and the edits land on the original.

// Same length as its input, with comment and string CONTENTS replaced by
// spaces. Newlines are kept so line numbers survive for the report.
//
// It does not know about regex literals — a `/[{"]/` before the presets would
// desync it. There are none above the first preset root today and this asserts
// the depth it lands on, which is what would catch one arriving.
function maskCode(src) {
  const out = src.split('');
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && d === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < src.length) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;                                   // the opening quote stays
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { blank(i); i++; }
        if (i < src.length) blank(i);
        i++;
      }
      i++;                                   // and the closing one
      continue;
    }
    i++;
  }
  return out.join('');
}

// The `{...}` that `key` opens, as [openBrace, closeBrace], searched in code
// only and within [from, to). Returns null rather than throwing: a preset the
// file does not declare by hand is the normal case, not an error.
function braceBlock(masked, key, from = 0, to = masked.length) {
  const re = new RegExp(`(^|[\\s,{])(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|"${key}")\\s*:\\s*\\{`, 'gm');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(masked))) {
    if (m.index >= to) return null;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < to; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') { depth--; if (!depth) return [open, i]; }
    }
    return null;                            // unbalanced: leave the file alone
  }
  return null;
}

// root -> presets -> name, each one inside the last.
function presetBlock(masked, root, name, limit) {
  const r = braceBlock(masked, root, 0, limit);
  if (!r) return null;
  const p = braceBlock(masked, 'presets', r[0], r[1]);
  if (!p) return null;
  return braceBlock(masked, name, p[0], p[1]);
}

// Every `key: value` in one block, as key -> [valueStart, valueEnd). Fields
// share lines here (`pulseAmp: 0, flickerAmp: 0, flow: 0,` is one line in
// `hide`), so this is offset work rather than line work.
function fieldSpans(masked, [open, close]) {
  const spans = new Map();
  const re = /(^|[\s,{])([A-Za-z_$][\w$]*)\s*:\s*/g;
  re.lastIndex = open + 1;
  let m;
  while ((m = re.exec(masked)) && m.index < close) {
    const start = m.index + m[0].length;
    if (masked[start] === '{' || masked[start] === '[') continue;   // nested: not ours
    let end = start;
    while (end < close && masked[end] !== ',' && masked[end] !== '\n' && masked[end] !== '}') end++;
    spans.set(m[2], [start, end]);
  }
  return spans;
}

// Does a comment sit immediately above this field? That is the prose this tool
// cannot rewrite and the reason it reports rather than staying quiet — half the
// numbers in config.js have a paragraph above them arguing for the exact value
// being replaced.
function commentAbove(src, at) {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1;
  let end = lineStart;
  for (let n = 0; n < 3 && end > 0; n++) {
    const prevEnd = end - 1;
    const prevStart = src.lastIndexOf('\n', prevEnd - 1) + 1;
    if (prevStart >= prevEnd) break;
    if (/^\s*\/\//.test(src.slice(prevStart, prevEnd))) return true;
    end = prevStart;
  }
  return false;
}

/**
 * Write recorded numbers into the hand-authored preset blocks. Returns the set
 * of "root.name" it handled, so writePresets can leave those out of the
 * generated block, plus a per-field report.
 */
function spliceHandPresets(text, presetsByRoot, editBuffer = {}) {
  const generated = text.indexOf(MARK_START);
  const limit = generated > -1 ? generated : text.length;
  const masked = maskCode(text);
  const handled = new Set();
  const changes = [];
  const stale = [];
  const untouched = [];
  // Edits are collected against the ORIGINAL offsets and applied last, right to
  // left, so one splice cannot move the next one's target.
  const edits = [];

  for (const [root, presets] of Object.entries(presetsByRoot)) {
    for (const [name, fields] of Object.entries(presets)) {
      const block = presetBlock(masked, root, name, limit);
      if (!block) continue;                 // not hand-declared: the block adds it
      handled.add(`${root}.${name}`);

      // ONLY WHAT A SLIDER ACTUALLY MOVED. The lab records the whole panel —
      // every spec key, resolved — not the handful the user touched, and a
      // resolved value is not the same thing as a declared one: a key the
      // preset leaves out on purpose comes back carrying the SLIDER'S OWN
      // default. Splicing the full record therefore invents fields. `kingCrab`
      // is not a pigment preset and says nothing about `pigment`; a record of
      // it wanted to write `pigment: 1` purely because that is where the row
      // sits, which would have moved it into the pigment family and broken the
      // three rules tools/biolum-skin-test.mjs holds that family to.
      //
      // Same failure as the tuner rows that used to write their midpoint onto
      // any preset with no value: RENDERING A CONTROL IS NOT AN EDIT. So the
      // edit buffer is the authority on what to write, and a preset nobody
      // touched is left exactly as it is.
      const touched = editBuffer[root]?.[name];
      if (!touched || !Object.keys(touched).length) {
        untouched.push(`${root}.${name}`);
        continue;
      }
      const spans = fieldSpans(masked, block);
      const additions = [];
      for (const [key, value] of Object.entries(fields)) {
        if (!(key in touched)) continue;
        const want = fieldLiteral(key, value);
        const span = spans.get(key);
        if (span) {
          const had = text.slice(span[0], span[1]).trim();
          if (sameLiteral(had, want)) continue;
          edits.push([span[0], span[1], want]);
          changes.push(`${root}.${name}.${key}: ${had} -> ${want}`);
          if (commentAbove(text, span[0])) stale.push(`${root}.${name}.${key}`);
        } else {
          additions.push([key, want]);
        }
      }
      if (additions.length) {
        const body = text.slice(block[0] + 1, block[1]);
        // AFTER THE LAST REAL CHARACTER, not at the closing brace. Inserting at
        // the brace put the new field after the block's own trailing whitespace,
        // which on a ONE-LINE preset meant it landed with no comma in front of
        // it and no line break behind the field before it:
        //
        //   shark: { steps: 3, low: 0.3, gamma: 1.15, soft: 0.12
        //     range: 1.5,
        //   },
        //
        // — a syntax error, in config.js, written by a button. It broke the
        // build the first time a hand-authored preset gained a field, because
        // every earlier addition had happened to land in a multi-line block
        // whose last field already carried a trailing comma. Anchoring to the
        // last non-whitespace character leaves the block's own closing
        // whitespace (and any trailing comment) exactly where it was.
        const tail = body.length - body.replace(/\s+$/, '').length;
        const at = block[1] - tail;
        // The separator the block does not already have. A block whose last
        // field ends in a comma needs none; one that does not needs one, and
        // that is the whole of the bug above.
        const sep = /,\s*$/.test(body) ? '' : ',';
        // A ONE-LINE PRESET STAYS ONE LINE. Several of the hand-authored blocks
        // are single-line on purpose — they are read down a column against each
        // other — and exploding one into seven lines because a slider moved is
        // a diff nobody asked for.
        const add = body.includes('\n')
          ? '\n' + additions.map(([k, v]) => {
            const indent = (body.match(/\n(\s+)\S/) || [null, '        '])[1];
            return `${indent}${k}: ${v},`;
          }).join('\n')
          : ' ' + additions.map(([k, v]) => `${k}: ${v}`).join(', ');
        edits.push([at, at, sep + add]);
        for (const [k, v] of additions) changes.push(`${root}.${name}.${k}: (absent) -> ${v}`);
      }
    }
  }

  let next = text;
  for (const [start, end, str] of edits.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + str + next.slice(end);
  }
  return { text: next, handled, changes, stale, untouched };
}

async function writePresets(presetsByRoot, { dry, edits = {} }, notes) {
  const text = await readFile(CONFIG_JS, 'utf8');

  // THE HAND-AUTHORED BLOCKS FIRST. Anything config.js already declares is
  // written in place, comments intact; only what is left over — a genuinely new
  // preset name — goes into the generated block below, where `??=` still means
  // it can never fight a hand-written value it did not just set itself.
  //
  // This is what makes `record` mean "make the game look like the lab". It used
  // to mean "make the game look like the lab unless somebody already had an
  // opinion", and the note explaining that was the most common output this tool
  // produced.
  const spliced = spliceHandPresets(text, presetsByRoot, edits);
  const already = [];
  for (const one of spliced.changes) notes.push(`~ ${one}`);
  for (const one of spliced.untouched) {
    notes.push(`. ${one}: already in config.js and no slider moved — left as it is`);
  }
  for (const one of new Set(spliced.stale)) {
    notes.push(`! ${one}: the comment above it argues for the number that was just replaced — reword it`);
  }

  // CUMULATIVE, and this is the bug that showed up the moment a record started
  // naming one creature: rendering the block from just that creature's presets
  // stripped every other name out of it, and the block is the ONLY home for the
  // ones no hand-written block declares. So it starts from what is already
  // there, takes this run's additions on top, and drops anything now spliced
  // into a hand-authored block above — where `??=` would ignore it anyway, and
  // where leaving it would be a second copy of the same numbers going stale.
  const merged = blockEntries(text);
  for (const [root, presets] of Object.entries(presetsByRoot)) {
    for (const [name, fields] of Object.entries(presets)) {
      if (spliced.handled.has(`${root}.${name}`)) continue;
      const body = Object.entries(fields).map(([k, v]) => `${k}: ${fieldLiteral(k, v)}`).join(', ');
      merged.set(`${root}.${name}`, `{ ${body} },`);
    }
  }
  for (const id of spliced.handled) merged.delete(id);
  const block = renderBlock(merged);

  // Strip any previous copy first, so the block moves rather than multiplying.
  let body = spliced.text;
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
  const names = [...spliced.handled].filter((id) => !spliced.untouched.includes(id));
  for (const [id, line] of after) if (before.get(id) !== line) names.push(id);
  if (next !== text && !dry) await writeFile(CONFIG_JS, next);
  return names.filter((n) => !already.includes(n));
}

// --- the third gate: the saved snapshot -------------------------------------
//
// A value in imported-tuning.json BEATS the config.js default it shadows, so a
// preset written above is still not what the game boots with — the snapshot
// holds a full copy of every preset the moment the game has saved once. That is
// why this tool used to appear to work on a brand-new preset name and never
// again on the same one: the first record landed before the snapshot had an
// entry, and every record after it was shadowed by the entry the first one
// caused.
//
// So the preset is DELETED from the snapshot rather than written into it. The
// game rewrites that file wholesale from whatever it booted with, so a tool
// that wrote values there would lose the race with any open tab; deleting a key
// hands ownership back to config.js, which is read fresh on every boot.
//
// REFUSED WHILE THE GAME IS UP, for the same race. `npm run servers` is the
// same survey the panel prints.
const TUNING = join(PROJECT, 'path/src/imported-tuning.json');

async function clearTuning(handled, { dry }, notes) {
  if (!handled.size) return [];
  let running = [];
  try {
    const { survey } = await import('./servers.mjs');
    running = survey().filter((p) => p.role === 'dev');
  } catch {
    // No survey (not macOS, lsof missing). Say so rather than assume it is safe.
    notes.push('? could not check for a running dev server — if the game is open, reload it before trusting this');
  }
  if (running.length) {
    notes.push(`! the game is running on port ${running[0].ports.join(', ')} — saved tuning still shadows `
      + `${[...handled].join(', ')}. Stop it (npm run servers, then stop <port>) and re-run, or the game will boot the old numbers.`);
    return [];
  }

  const raw = await readFile(TUNING, 'utf8');
  const doc = JSON.parse(raw);
  const dropped = [];
  for (const id of handled) {
    const [root, name] = id.split('.');
    const bag = doc[root]?.presets;
    if (bag && name in bag) { delete bag[name]; dropped.push(id); }
  }
  // Two-space JSON with a trailing newline is byte-for-byte what the game
  // writes, so a run that drops nothing leaves no diff at all.
  if (dropped.length && !dry) await writeFile(TUNING, JSON.stringify(doc, null, 2) + '\n');
  for (const id of dropped) notes.push(`- ${id}: cleared from imported-tuning.json — config.js owns it now`);
  return dropped;
}

// Every preset a recorded creature points AT, gathered from what the lab saved.
// ONE ENTRY, NOT THE WHOLE FILE, whenever the caller names one — and the lab's
// record button always does.
//
// `applied` accumulates: every creature ever recorded keeps its own copy of the
// presets it was wearing AT THE TIME. While the generated block could only add
// names that was harmless, because a stale copy lost to the hand-written block
// anyway. Now that a record overwrites, replaying the whole file means the
// oldest snapshot of a SHARED preset silently reverts the newest — recording
// the boss crab would have rolled `orcaHide` back to a copy from this morning,
// and the report would have called it a change the user had just asked for.
function entriesOf(doc, only) {
  const all = doc.applied ?? {};
  return only ? (all[only] ? [all[only]] : []) : Object.values(all);
}

function presetsFromDoc(doc, only) {
  const out = { toonShade: {}, sealShader: {}, biolumSkin: {} };
  for (const entry of entriesOf(doc, only)) {
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
export async function applyRecorded(doc, { dry = false, only = doc.recorded, batch = false } = {}) {
  const notes = [];
  const every = doc.applied ?? {};
  // A SUBJECT IS REQUIRED TO WRITE. Both of the lab's buttons POST this file and
  // the server applies whatever it is handed, so "save presets" — which names no
  // creature — would otherwise replay every record in the document and let the
  // oldest copy of a shared preset win. Saving the file is all it should do.
  if (!only && !batch) {
    return { rows: [], presets: [], notes: ['saved — no creature named, so nothing was written to config.js or assets.csv'] };
  }
  const applied = only ? (every[only] ? { [only]: every[only] } : {}) : every;
  if (!Object.keys(applied).length) {
    return { rows: [], presets: [], notes: [only ? `nothing recorded for ${only}` : 'nothing recorded yet'] };
  }
  const rows = await writeCsv(applied, { dry }, notes);
  const presets = await writePresets(presetsFromDoc(doc, only), { dry, edits: doc.config ?? {} }, notes);
  // Ownership last, and only for what actually got written: clearing the
  // snapshot for a preset this run did not touch would silently revert somebody
  // else's tuning to a config default.
  await clearTuning(new Set(presets), { dry }, notes);
  return { rows, presets, notes };
}

// --- CLI --------------------------------------------------------------------
// Guarded so tools/looks/serve.mjs can import applyRecorded without this running.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  // `--all` REQUIRED TO WRITE, and it is not ceremony. Without a named subject
  // this replays every record the file holds, which for a shared preset means
  // the oldest copy wins — see entriesOf. The default is therefore a report.
  const all = argv.includes('--all');
  const dry = argv.includes('--dry') || !all;
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

  const { rows, presets, notes } = await applyRecorded(doc, { dry, only: null, batch: true });
  const verb = dry ? 'WOULD change' : 'wrote';
  if (!all) {
    console.log('DRY RUN — every record in the file, oldest copy of a shared preset winning.');
    console.log('Hit record in the lab to apply one creature, or pass --all to write all of this.\n');
  }
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
