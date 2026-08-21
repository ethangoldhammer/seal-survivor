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

await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)\n` : '\nthe splice keeps config.js parseable\n');
process.exit(failures ? 1 : 0);
