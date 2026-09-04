#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:shaders
//
// THE SPLICE THAT WRITES config.js, held to the one thing it must never do:
// produce a file that will not parse.
//
// `record` in the shader lab writes the game directly — it splices numbers into
// the HAND-AUTHORED preset blocks in config.js, comments left standing. That
// makes a button, pressed by someone tuning a look, an editor of a 25,000-line
// source file. When it gets a block shape wrong the failure is not a bad
// number, it is a broken build, and the person who pressed the button is
// looking at a shark and not at a terminal.
//
// It got one wrong. Adding a field to a ONE-LINE preset inserted at the closing
// brace, which is after the block's own trailing whitespace, and emitted:
//
//   shark: { steps: 3, low: 0.3, gamma: 1.15, soft: 0.12
//     range: 1.5,
//   },
//
// — no comma after the last field. Every earlier addition had happened to land
// in a multi-line block whose last field already carried a trailing comma, so
// the bug sat behind a coincidence about formatting until a single-line block
// gained its first field.
//
// So: every block shape config.js actually contains, spliced, then PARSED. The
// parse is the assertion — a shape-matching regex would have passed the broken
// output above just as happily as the correct one.
//
//   node tools/apply-shaders-test.mjs
// ---------------------------------------------------------------------------
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// spliceHandPresets is internal on purpose — it is not something another module
// should call. Re-exported into a temp copy rather than widened in the source,
// so the tool's surface stays what it is.
const src = await readFile(resolve(HERE, 'apply-shaders.mjs'), 'utf8');
const dir = await mkdtemp(join(tmpdir(), 'apply-shaders-test-'));
const mod = join(dir, 'm.mjs');
await writeFile(mod, src.replace('function spliceHandPresets(', 'export function spliceHandPresets('));
const { spliceHandPresets, cellFor } = await import('file://' + mod);

// A SECOND copy, pointed at a scratch CSV. writeCsv writes the real
// path/src/assets.csv, so testing it against the live file is not an option —
// and neither is skipping it, because appending a row to that file is the part
// of this tool that edits the roster.
const CSV_FIXTURE = join(dir, 'assets.csv');
const csvMod = join(dir, 'csv.mjs');
await writeFile(csvMod, src
  .replace(/const CSV = .*;/, `const CSV = ${JSON.stringify(CSV_FIXTURE)};`)
  .replace('async function writeCsv(', 'export async function writeCsv('));
const { writeCsv } = await import('file://' + csvMod);

const HEADER = 'id,size,skin,surface,notes';
const seed = (rows) => writeFile(CSV_FIXTURE, [HEADER, ...rows].join('\n') + '\n');
const readCsv = async () => (await readFile(CSV_FIXTURE, 'utf8')).split('\n').filter((l) => l.trim());
const rowFor = async (id) => (await readCsv()).find((l) => l.startsWith(id + ','));

const wrap = (block) => `  toonShade: {\n    presets: {\n${block}\n    },\n  },\n`;

// The three shapes a hand-authored preset block comes in. All three are real:
// config.js holds one-liners (they are read down a column against each other)
// and multi-line blocks both with and without a trailing comma.
const SHAPES = {
  'one-line, no trailing comma': '      shark: { steps: 3, low: 0.3, soft: 0.12 },',
  'one-line, trailing comma inside': '      shark: { steps: 3, low: 0.3, soft: 0.12, },',
  'multi-line, trailing comma': '      shark: {\n        steps: 3,\n        low: 0.3,\n      },',
  'multi-line, no trailing comma': '      shark: {\n        steps: 3,\n        low: 0.3\n      },',
  'multi-line with a comment': '      shark: {\n        // why the terminator sits here\n        steps: 3,\n        low: 0.3,\n      },',
};

const ADD = { toonShade: { shark: { range: 1.5 } } };

console.log('\nADDING A FIELD TO A HAND-AUTHORED PRESET');
for (const [label, block] of Object.entries(SHAPES)) {
  const out = spliceHandPresets(wrap(block), ADD, ADD);
  let parsed = null;
  let err = '';
  // The whole point: does what came out still parse as JavaScript?
  try { parsed = new Function(`return {${out.text.replace(/,\s*$/, '')}}`)(); }
  catch (e) { err = e.message; }
  check(`${label}: still parses`, !!parsed, err);
  if (!parsed) continue;
  const shark = parsed.toonShade?.presets?.shark ?? {};
  check(`${label}: the new field is there`, shark.range === 1.5, `range = ${shark.range}`);
  check(`${label}: the old fields survive`,
    shark.steps === 3 && shark.low === 0.3,
    `steps ${shark.steps}, low ${shark.low}`);
  // A one-liner stays a one-liner: several of these blocks are single-line
  // deliberately, and exploding one because a slider moved is a diff nobody
  // asked for.
  if (label.startsWith('one-line')) {
    const line = out.text.split('\n').find((l) => l.includes('shark:'));
    check(`${label}: stays on one line`, /shark: \{.*\},/.test(line ?? ''), (line ?? '').trim());
  }
}

console.log('\nCHANGING A FIELD THAT IS ALREADY THERE');
{
  const out = spliceHandPresets(wrap(SHAPES['one-line, no trailing comma']),
    { toonShade: { shark: { low: 0.9 } } }, { toonShade: { shark: { low: 0.9 } } });
  let parsed = null;
  try { parsed = new Function(`return {${out.text.replace(/,\s*$/, '')}}`)(); } catch { /* reported below */ }
  check('an in-place edit still parses', !!parsed);
  check('...and took the new value', parsed?.toonShade?.presets?.shark?.low === 0.9,
    `low = ${parsed?.toonShade?.presets?.shark?.low}`);
}

console.log('\nCHANGING THE LAST FIELD *AND* ADDING AFTER IT');
{
  // THE COMBINATION NOTHING ABOVE COVERS, and it broke config.js in the wild:
  // the two sections above test replacing a value and appending fields
  // SEPARATELY, and every shape passes both. Do them in one record — which is
  // what moving a slider on the last field of a preset and then moving one on a
  // field it does not declare produces — and the two edits land on top of each
  // other.
  //
  //   greatWhite: { strength: 1.3, wet: 1.2 wetSteps: 3, ... }
  //
  // The insert anchors after the last non-whitespace character; the value span
  // for a one-line block's LAST field used to run to the closing brace, so it
  // swallowed the space and the anchor sat inside it. Right-to-left application
  // then put the addition in first and the value replacement chewed back over
  // its leading comma. The game did not boot.
  const want = { toonShade: { shark: { soft: 0.9, range: 1.5, gamma: 2.2 } } };
  for (const [label, block] of Object.entries(SHAPES)) {
    // `soft` is deliberately the LAST declared field in the one-line shapes.
    const last = /soft/.test(block) ? 'soft' : 'low';
    const edit = { toonShade: { shark: { [last]: 0.9, range: 1.5, gamma: 2.2 } } };
    const rec = { toonShade: { shark: { [last]: 0.9, range: 1.5, gamma: 2.2 } } };
    let out = null; let parsed = null; let err = '';
    try {
      out = spliceHandPresets(wrap(block), rec, edit);
      parsed = new Function(`return {${out.text.replace(/,\s*$/, '')}}`)();
    } catch (e) { err = e.message; }
    check(`${label}: replace-last + append still parses`, !!parsed,
      err || (out?.text.split('\n').find((l) => l.includes('shark:')) ?? '').trim());
    if (!parsed) continue;
    const shark = parsed.toonShade?.presets?.shark ?? {};
    check(`${label}: the replaced value landed`, shark[last] === 0.9, `${last} = ${shark[last]}`);
    check(`${label}: and both additions did`, shark.range === 1.5 && shark.gamma === 2.2,
      `range ${shark.range}, gamma ${shark.gamma}`);
    check(`${label}: nothing else was eaten`, shark.steps === 3, `steps = ${shark.steps}`);
  }
  void want;
}

console.log('\nRENDERING A CONTROL IS NOT AN EDIT');
{
  // The other half of the same lesson, and it has its own scar: the lab records
  // the whole panel RESOLVED, so a key a preset deliberately omits comes back
  // carrying the slider's own default. Writing that invents fields — `pigment: 1`
  // onto a preset that is not in the pigment family. The edit buffer is the
  // authority on what may be written, and an empty one writes nothing.
  const full = { toonShade: { shark: { range: 1.5, steps: 3, low: 0.3, soft: 0.12, gamma: 1 } } };
  const out = spliceHandPresets(wrap(SHAPES['one-line, no trailing comma']), full, {});
  check('a preset nobody touched is left alone',
    out.changes.length === 0 && out.untouched.includes('toonShade.shark'),
    `${out.changes.length} change(s)`);
  const only = spliceHandPresets(wrap(SHAPES['one-line, no trailing comma']),
    full, { toonShade: { shark: { range: 1.5 } } });
  check('only the moved slider is written', only.changes.length === 1,
    only.changes.join('; ') || 'nothing');
}

console.log('\nTHE SURFACE CELL');
{
  // The `surface` column holds a `+`-joined list of layers now, and this file
  // is CUMULATIVE — tools/looks/shader-lab.json still carries 26 creatures
  // recorded under the old one-value shape. Both have to come out as a cell
  // that path/src/assetTable.js reads back as the same layers, or reapplying an
  // old record silently strips a creature's banding.
  const cell = (entry) => cellFor(entry, 'x', []);

  check('the current shape names every layer it has',
    cell({ layers: { noise: 'shark', toon: 'shark', biolum: null } }) === 'noise:shark+toon:shark',
    cell({ layers: { noise: 'shark', toon: 'shark', biolum: null } }));
  check('...in the order assetTable documents, whatever order it was written in',
    cell({ layers: { biolum: 'hide', toon: 'shark', noise: 'shark' } })
      === 'noise:shark+toon:shark+biolum:hide');
  check('a layer with no preset name is the bare kind',
    cell({ layers: { noise: true } }) === 'noise', cell({ layers: { noise: true } }));
  check('no layers is "texture", never a blank cell',
    cell({ layers: {} }) === 'texture', cell({ layers: {} }));

  // THE OLD SHAPE. `noise` meant noise AND toon — which is why every noise row
  // in assets.csv was rewritten to say both — so an entry recorded before
  // layers existed must still expand to both.
  check('a pre-layers "noise" record still carries its bands',
    cell({ surface: 'noise', assets: { noiseShader: 'shark', toonShade: 'shark' } })
      === 'noise:shark+toon:shark');
  check('...even when the entry only recorded the noise name',
    cell({ surface: 'noise', assets: { noiseShader: 'shark' } }) === 'noise:shark+toon:shark');
  check('a pre-layers "biolum" record stays biolum alone',
    cell({ surface: 'biolum', assets: { biolumSkin: 'hide' } }) === 'biolum:hide');
  check('a pre-layers "texture" record stays texture',
    cell({ surface: 'texture', assets: {} }) === 'texture');

  // `layers` WINS when both are present, because apply() writes `surface` as a
  // human-readable summary of the same choice — reading the summary would parse
  // prose, and prose that says "noise+toon" matches none of the old three.
  check('the layer map wins over the summary beside it',
    cell({ surface: 'noise+toon+biolum', layers: { biolum: 'hide' } }) === 'biolum:hide');

  const notes = [];
  check('an entry naming neither is skipped with a note',
    cellFor({ surface: 'sparkles' }, 'x', notes) === null && notes.length === 1,
    notes.join('; '));
}

// --- a recorded asset with no CSV row gets one ------------------------------
//
// This used to be a refusal — "no row in assets.csv, add one, then re-run" —
// on the grounds that a row carries a size and inventing one would resize the
// creature. The answer is that a BLANK size cell is not an invented size: it
// is what a missing row already means. These checks are what hold that.
{
  console.log('\nA RECORDED ASSET WITH NO ROW IN assets.csv');

  const applied = {
    enemyTuna: { layers: { noise: 'tuna', toon: 'tuna', biolum: 'tuna' } },
    aaaFirst: { layers: { biolum: 'hide' } },
  };

  await seed(['enemyShark,2.66,,noise:shark,', 'enemyStingray,3.1,,,', 'zzzLast,1,,,']);
  const notes = [];
  const changed = await writeCsv(applied, { dry: false }, notes);

  check('the row is created rather than refused',
    !notes.some((n) => n.startsWith('!')), notes.join(' · '));
  check('and it is reported as a change',
    changed.length === 2, changed.join(' · '));

  const tuna = await rowFor('enemyTuna');
  check('the surface it was recorded with lands in the row',
    /^enemyTuna,,,noise:tuna\+toon:tuna\+biolum:tuna,/.test(tuna ?? ''), tuna);

  const cells = (tuna ?? '').split(',');
  check('the SIZE cell is blank — a missing row already means 1, so nothing resizes',
    cells[1] === '', `size cell = "${cells[1]}"`);
  check('the SKIN cell is blank — the surface carries its own preset',
    cells[2] === '', `skin cell = "${cells[2]}"`);
  check('the row carries a note saying why the size is blank',
    /blank/i.test(tuna ?? ''));

  const ids = (await readCsv()).slice(1).map((l) => l.split(',')[0]);
  check('the file is still sorted by id — the row is inserted, not appended',
    ids.every((v, i) => i === 0 || ids[i - 1] <= v), ids.join(', '));
  check('...including one that sorts to the very front', ids[0] === 'aaaFirst', ids[0]);

  // The lab re-records the same creature constantly. A second pass must be a
  // no-op, not a duplicate row.
  const notes2 = [];
  const again = await writeCsv(applied, { dry: false }, notes2);
  check('re-recording the same choice changes nothing',
    again.length === 0, again.join(' · '));
  check('and does not add a second row',
    (await readCsv()).filter((l) => l.startsWith('enemyTuna,')).length === 1);

  // --dry has to stay honest now that this writes more than one cell.
  await seed(['enemyShark,2.66,,noise:shark,']);
  const before = await readFile(CSV_FIXTURE, 'utf8');
  await writeCsv(applied, { dry: true }, []);
  check('--dry adds nothing to the file',
    (await readFile(CSV_FIXTURE, 'utf8')) === before);

  // A file somebody has been appending to by hand is not sorted, and pretending
  // it is puts the new row in an arbitrary place that looks deliberate.
  await seed(['zzzLast,1,,,', 'enemyShark,2.66,,noise:shark,']);
  await writeCsv({ enemyTuna: applied.enemyTuna }, { dry: false }, []);
  const unsorted = (await readCsv()).slice(1).map((l) => l.split(',')[0]);
  check('an unsorted file gets the row at the end instead',
    unsorted[unsorted.length - 1] === 'enemyTuna', unsorted.join(', '));
}


// ---------------------------------------------------------------------------
// THE TWO RIMS — the flat roots.
//
// CONFIG.creatureOutline and CONFIG.companionOutline are one block each, not a
// preset family, so every rule above misses them. That was not a decision: the
// lab's outline section wrote its edits into the document and nothing ever read
// them back, so a rim dialled in the lab was gone the moment the tab closed —
// no error, and nothing in the report to say so.
//
// Two things are tested and they fail in opposite directions. The SPLICE must
// keep config.js parseable, same bar as the preset splice. The CLEAR must take
// exactly the keys it names out of the snapshot and leave the rest of a file
// full of somebody's tuning alone — an over-broad delete there reverts real work
// and looks, in a diff, exactly like the tool doing its job.
// ---------------------------------------------------------------------------
const CONFIG_FIXTURE = join(dir, 'config.js');
const TUNING_FIXTURE = join(dir, 'imported-tuning.json');
const flatMod = join(dir, 'flat.mjs');
await writeFile(flatMod, src
  .replace(/const CONFIG_JS = .*;/, `const CONFIG_JS = ${JSON.stringify(CONFIG_FIXTURE)};`)
  .replace(/const TUNING = .*;/, `const TUNING = ${JSON.stringify(TUNING_FIXTURE)};`)
  // The dev-server guard would refuse every write below whenever the game
  // happens to be up, which would turn this file into a test that passes by not
  // running. The guard has its own reason to exist and is not what is under
  // test here.
  // The `export ` is optional because the splicer's helpers are shared with
  // tools/apply-accessories.mjs now and carry one; without it here the rename
  // still fires (the pattern is a substring) and the stub does NOT, which
  // leaves the real guard renamed away and every rim test dying on a
  // ReferenceError several hundred lines later.
  .replace(/(export )?async function devServerBlocking\(/, '$1async function unusedDevServerBlocking(')
  .replace(/^(export )?async function unusedDevServerBlocking\(what, notes\) \{/m,
    'async function devServerBlocking() { return false; }\n$1async function unusedDevServerBlocking(what, notes) {')
  .replace('async function writeFlatRoots(', 'export async function writeFlatRoots(')
  .replace(/const ASSETS_JS = .*;/, `const ASSETS_JS = ${JSON.stringify(join(dir, 'assets.js'))};`)
  .replace('async function writeAssetOutlines(', 'export async function writeAssetOutlines('));
const { writeFlatRoots, clearRimTuning, writeAssetOutlines } = await import('file://' + flatMod);

// Both blocks as config.js actually lays them out: prose above the numbers, an
// `on` list nested inside, and a same-named `on` in a NEIGHBOURING root — which
// is the one that catches a brace search that starts from the wrong place.
const RIMS = `export const CONFIG = {
  // The threat rim. This paragraph is the thing the splice must not eat.
  creatureOutline: {
    color: 0xff7a3d,
    // WORLD units, divided by each model's own scale.
    thickness: 0.12,
    glow: 2.4,
    opacity: 1,
    bosses: false,
    on: {
      enemyShark: false,
      enemyGreatWhite: false,
    },
  },
  companionOutline: {
    color: 0xffd27a,
    thickness: 0.1,
    on: {
      sealTeam: false,
      dumboOcto: false,
    },
  },
};
`;

console.log('\nTHE RIM BLOCKS, SPLICED');
{
  await writeFile(CONFIG_FIXTURE, RIMS);
  const notes = [];
  const written = await writeFlatRoots({
    creatureOutline: { __flat: { thickness: 0.365, glow: 3.2 }, __on: { enemyShark: true, enemyAbyssShark: true } },
    companionOutline: { __on: { dumboOcto: true } },
  }, { dry: false }, notes);
  const out = await readFile(CONFIG_FIXTURE, 'utf8');

  let parsed = null, err = '';
  try {
    parsed = (await import('data:text/javascript,' + encodeURIComponent(out))).CONFIG;
  } catch (e) { err = e.message; }
  check('the spliced file still parses', !!parsed, err);
  check('a number moves in place', parsed?.creatureOutline?.thickness === 0.365,
    String(parsed?.creatureOutline?.thickness));
  check('...and so does the one beside it', parsed?.creatureOutline?.glow === 3.2,
    String(parsed?.creatureOutline?.glow));
  check('a switch already in the list flips', parsed?.creatureOutline?.on?.enemyShark === true);
  check('a switch that was NOT in the list is ADDED — a rim can reach a new species',
    parsed?.creatureOutline?.on?.enemyAbyssShark === true);
  check('the OTHER root\'s list is reached, not the first one\'s',
    parsed?.companionOutline?.on?.dumboOcto === true && parsed?.creatureOutline?.on?.dumboOcto === undefined);
  check('a field nobody touched is left exactly as it was',
    parsed?.creatureOutline?.opacity === 1 && parsed?.creatureOutline?.on?.enemyGreatWhite === false);
  check('the prose above the block survives', out.includes('This paragraph is the thing the splice must not eat'));
  check('...including the comment inside it', out.includes("WORLD units, divided by each model's own scale"));
  check('a comment arguing for a replaced number is reported, not silently left',
    notes.some((n) => n.includes('creatureOutline.thickness') && n.includes('reword')), notes.join(' · '));
  check('the leaf paths come back for the snapshot clear',
    written.includes('creatureOutline.thickness') && written.includes('companionOutline.on.dumboOcto'),
    written.join(', '));

  // --dry has to stay honest here too: this one edits config.js.
  await writeFile(CONFIG_FIXTURE, RIMS);
  await writeFlatRoots({ creatureOutline: { __flat: { thickness: 0.9 } } }, { dry: true }, []);
  check('--dry writes nothing to config.js', (await readFile(CONFIG_FIXTURE, 'utf8')) === RIMS);

  // A root the file does not declare is reported rather than invented. These
  // blocks are always hand-authored and there is no generated-block fallback
  // for them on purpose — a rim appended to the end of config.js would be a
  // second copy of a roster, which is the failure this whole tool exists past.
  await writeFile(CONFIG_FIXTURE, 'export const CONFIG = {};\n');
  const gone = [];
  const none = await writeFlatRoots({ creatureOutline: { __flat: { glow: 1 } } }, { dry: false }, gone);
  check('a root with no block is reported, not appended',
    none.length === 0 && gone.some((n) => n.includes('no `creatureOutline: {` block')), gone.join(' · '));
}

// ---------------------------------------------------------------------------
// The rim an ASSET declares — `outline: {...}` on its ASSETS entry, which is the
// whales, the boats and the seagull. Neither CONFIG family reaches it, so the
// lab writes these into assets.js. The traps are all about WHICH block: the
// file is one object literal in which `outline: {` appears inside dozens of
// entries, an entry can nest a same-named key deeper, and the entry being
// written may have no rim at all — in which case the first `outline: {` after
// it is the NEXT species' rim.
// ---------------------------------------------------------------------------
const ASSETS_FIXTURE = join(dir, 'assets.js');
const ASSET_SRC = `import * as THREE from 'three';
// A helper above the literal, with a rim-shaped thing in it that is not a rim.
const decoy = { outline: { color: 0x123456, thickness: 9 } };
export const ASSETS = {
  enemyWhale: {
    model: 'models/decoy.glb',
    outline: { color: 0x000000, thickness: 0.5 },
  },
  whale: {
    model: 'models/whale.glb',
    rig: { outline: { color: 0x111111, thickness: 7 } },
    // Cold rim like the bowhead's. Object-space thickness — 180 source units.
    outline: { color: 0x9fd8e8, thickness: 1.1, glow: 1.6 },
    tint: 0xffffff,
  },
  bareFish: {
    model: 'models/bare.glb',
  },
  humpbackWhale: {
    model: 'models/humpback.glb',
    outline: { color: 0x9fd8e8, thickness: 0.11, glow: 1.6 },
  },
};
export const decoyToo = { whale: { outline: { color: 0xabcdef, thickness: 3 } } };
`;

console.log('\nTHE RIM AN ASSET DECLARES, SPLICED INTO assets.js');
{
  await writeFile(ASSETS_FIXTURE, ASSET_SRC);
  const notes = [];
  const written = await writeAssetOutlines({
    assetOutline: {
      whale: { color: 0xffb070, thickness: 1.35 },
      humpbackWhale: { glow: 0.9 },
      bareFish: { color: 0xff0000 },
    },
  }, { dry: false }, notes);
  const out = await readFile(ASSETS_FIXTURE, 'utf8');
  let mod = null, err = '';
  try {
    mod = await import('data:text/javascript,' + encodeURIComponent(out.replace("import * as THREE from 'three';", '')));
  } catch (e) { err = e.message; }
  const A = mod?.ASSETS;
  check('the spliced file still parses', !!A, err);
  check('the colour lands on the named entry', A?.whale?.outline?.color === 0xffb070, String(A?.whale?.outline?.color));
  check('...as a hex literal, the way the file writes colours', /color: 0xffb070/.test(out));
  check('thickness moves beside it', A?.whale?.outline?.thickness === 1.35);
  check('a field nobody touched is left alone', A?.whale?.outline?.glow === 1.6 && A?.whale?.tint === 0xffffff);
  check('the OTHER whale gets only its own edit',
    A?.humpbackWhale?.outline?.glow === 0.9 && A?.humpbackWhale?.outline?.color === 0x9fd8e8);
  check('a key that is a SUFFIX of another (enemyWhale) is untouched',
    A?.enemyWhale?.outline?.color === 0x000000 && A?.enemyWhale?.outline?.thickness === 0.5);
  check('a same-named key nested deeper in the entry is not the one written',
    A?.whale?.rig?.outline?.color === 0x111111 && A?.whale?.rig?.outline?.thickness === 7);
  check('a decoy above the literal is untouched', /const decoy = \{ outline: \{ color: 0x123456, thickness: 9 \} \};/.test(out));
  check('a decoy below it is untouched', /decoyToo = \{ whale: \{ outline: \{ color: 0xabcdef/.test(out));
  check('an entry with NO rim is reported, and the next species\' rim is not written instead',
    A?.humpbackWhale?.outline?.color === 0x9fd8e8 && notes.some((n) => n.includes('bareFish') && n.includes('declares no')),
    notes.join(' · '));
  check('the comment above the rim survives', out.includes("Cold rim like the bowhead's"));
  check('...and is reported as arguing for a replaced number',
    notes.some((n) => n.includes('whale.outline.color') && n.includes('reword')), notes.join(' · '));
  check('the snapshot keys come back in the T-menu\'s shape',
    written.includes('assetLooks.whale.outlineColor') && written.includes('assetLooks.whale.outlineThickness')
      && written.includes('assetLooks.humpbackWhale.outlineGlow') && written.length === 3,
    written.join(', '));

  await writeFile(ASSETS_FIXTURE, ASSET_SRC);
  await writeAssetOutlines({ assetOutline: { whale: { glow: 3 } } }, { dry: true }, []);
  check('--dry writes nothing to assets.js', (await readFile(ASSETS_FIXTURE, 'utf8')) === ASSET_SRC);
}

// ---------------------------------------------------------------------------
// An entry the file DERIVES after the literal. The club variants are built in a
// loop that spreads `ASSETS.club` — there is no `clubBoom: {` to splice into,
// and the writer used to give up with "no ASSETS.clubBoom entry" while the lab
// showed a working own-rim panel for it. The design in assets.js is that the
// variants share the base club's rim, so that is where the edit goes, and the
// snapshot clear has to cover every variant or the file's new number reaches
// four clubs and not the fifth.
// ---------------------------------------------------------------------------
const DERIVED_SRC = (ASSET_SRC + `
export const club = 1;
for (const [key, headTint] of [
  ['clubBoom', 0xd94a2b],   // ember
  ['clubIce', 0x7fd4f5],    // ice
]) {
  ASSETS[key] = {
    ...ASSETS.club,
    headTint,
    color: headTint,
    outline: { ...ASSETS.club.outline },
  };
}
// A variant family whose parent has no rim at all.
for (const [key, tint] of [['fishRed', 0xff0000]]) {
  ASSETS[key] = { ...ASSETS.bareFish, tint };
}
// And one that gives its variants a rim of their OWN — the parent's is not the
// one on screen, so an edit must not be routed there.
for (const [key, glow] of [['whaleGhost', 4]]) {
  ASSETS[key] = { ...ASSETS.whale, outline: { color: 0xffffff, thickness: 2, glow } };
}
`).replace("export const ASSETS = {", `export const ASSETS = {
  club: {
    model: 'models/club.glb',
    // Measured for this file: 0.5 long by 0.07 across.
    outline: { color: 0x1a1208, thickness: 0.006 },
  },`);

console.log('\nA RIM ON AN ENTRY THE FILE DERIVES');
{
  await writeFile(ASSETS_FIXTURE, DERIVED_SRC);
  const notes = [];
  const written = await writeAssetOutlines({
    assetOutline: {
      clubBoom: { thickness: 0.00186 },
      fishRed: { color: 0xff00ff },
      whaleGhost: { glow: 1 },
    },
  }, { dry: false }, notes);
  const out = await readFile(ASSETS_FIXTURE, 'utf8');
  let mod = null, err = '';
  try {
    mod = await import('data:text/javascript,' + encodeURIComponent(out.replace("import * as THREE from 'three';", '')));
  } catch (e) { err = e.message; }
  const A = mod?.ASSETS;
  check('the spliced file still parses', !!A, err);
  check('the variant\'s edit lands on the base club', A?.club?.outline?.thickness === 0.00186, String(A?.club?.outline?.thickness));
  check('...and reaches the variant through the loop', A?.clubBoom?.outline?.thickness === 0.00186);
  check('...and its siblings, because they share it', A?.clubIce?.outline?.thickness === 0.00186);
  check('the loop itself is untouched', /outline: \{ \.\.\.ASSETS\.club\.outline \},/.test(out));
  check('the redirect is reported, naming every club that shares the rim',
    notes.some((n) => n.startsWith('~ clubBoom') && n.includes('club.outline') && n.includes('clubIce')), notes.join(' · '));
  check('the snapshot keys cover the base AND every variant',
    ['club', 'clubBoom', 'clubIce'].every((k) => written.includes(`assetLooks.${k}.outlineThickness`)), written.join(', '));
  check('a variant of a parent with no rim is reported, not given one',
    notes.some((n) => n.startsWith('! bareFish') && n.includes('declares no')) && !/bareFish: \{[^}]*outline/.test(out), notes.join(' · '));
  check('a variant with a rim of its OWN is not routed onto its parent',
    A?.whale?.outline?.glow === 1.6 && notes.some((n) => n.startsWith('! whaleGhost') && n.includes('rim of its own')), notes.join(' · '));

  // Two variants, two numbers, one rim.
  await writeFile(ASSETS_FIXTURE, DERIVED_SRC);
  const clash = [];
  const w2 = await writeAssetOutlines({
    assetOutline: { clubBoom: { thickness: 0.002, glow: 2 }, clubIce: { thickness: 0.003 } },
  }, { dry: false }, clash);
  const after = await readFile(ASSETS_FIXTURE, 'utf8');
  check('a conflict between variants writes neither number',
    /thickness: 0\.006/.test(after) && clash.some((n) => n.includes('one rim, two numbers')), clash.join(' · '));
  check('...but a field only one of them moved still lands', /glow: 2/.test(after) && w2.includes('assetLooks.clubIce.outlineGlow'), w2.join(', '));
}

console.log('\nHANDING THE RIMS BACK FROM THE SNAPSHOT');
{
  // A snapshot with real work in it either side of the rims. The clear must be
  // a scalpel: everything here that is not a rim key is somebody's tuning.
  const snapshot = {
    _savedAt: 'yesterday',
    creatureOutline: { color: 16742973, thickness: 0.12, on: { enemyShark: true, enemyOrca: true } },
    companionOutline: { on: { dumboOcto: true } },
    playerOutline: { color: 543884, thickness: 0.025 },
    bloom: { intensity: 0.8 },
  };
  await writeFile(TUNING_FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
  const { dropped } = await clearRimTuning({ dry: false });
  const after = JSON.parse(await readFile(TUNING_FIXTURE, 'utf8'));

  // Five: the two rim containers hold four keys and one between them, and the
  // count is asserted rather than "more than zero" — a clear that took some of
  // them would leave the rest shadowing config.js and read as a success.
  check('every rim key is gone', dropped.length === 5, dropped.join(', '));
  check('both rim containers are gone with them — an empty one is a lie in a diff',
    !('creatureOutline' in after) && !('companionOutline' in after), Object.keys(after).join(', '));
  check('playerOutline is UNTOUCHED — it is a different rim and nobody asked',
    after.playerOutline?.thickness === 0.025);
  check('...and so is the rest of the snapshot', after.bloom?.intensity === 0.8 && after._savedAt === 'yesterday');

  // Running it twice is the normal case — the snapshot re-grows an opinion
  // every time the game saves — so the second run has to be quiet, not a crash.
  const again = await clearRimTuning({ dry: false });
  check('a second run has nothing to do and says so',
    again.dropped.length === 0 && again.notes.some((n) => n.includes('already owns')), again.notes.join(' · '));

  await writeFile(TUNING_FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
  const raw = await readFile(TUNING_FIXTURE, 'utf8');
  await clearRimTuning({ dry: true });
  check('--dry clears nothing', (await readFile(TUNING_FIXTURE, 'utf8')) === raw);
}

await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)\n` : '\nthe splice keeps config.js parseable\n');
process.exit(failures ? 1 : 0);
