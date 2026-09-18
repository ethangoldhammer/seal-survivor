#!/usr/bin/env node
// npm run test:sourcelabels
//
// THE ONE FAILURE A GENERATED FILE HAS is going stale: uiText.csv is edited,
// nobody reruns the generator, and the score screen keeps showing the old word
// while the spreadsheet shows the new one — with every other check green,
// because both files are individually valid. So this regenerates in memory and
// diffs against what is on disk.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build, ENVIRONMENT_SOURCES, rowIdFor } from './gen-source-labels.mjs';
import { SOURCE_LABELS, SOURCE_TEXT_IDS } from '../path/src/sourceLabels.generated.js';
import { sourceLabel } from '../path/src/systems/playtestAnalysis.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) bad++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const onDisk = readFileSync(resolve(ROOT, 'path/src/sourceLabels.generated.js'), 'utf8');
const { src, missing } = build();
ok('the generated file matches uiText.csv', onDisk === src,
  onDisk === src ? '' : 'stale — run `npm run gen:sourcelabels`');
ok('every environmental source has a row', missing.length === 0, missing.join(', '));
ok('the row ids it consumed are exported for the uiText audit',
  SOURCE_TEXT_IDS.length === ENVIRONMENT_SOURCES.length
  && ENVIRONMENT_SOURCES.every((s) => SOURCE_TEXT_IDS.includes(rowIdFor(s))));

// THE POINT OF THE WHOLE ARRANGEMENT: this resolves with no bundler, which is
// what the two plain-node tools that read playtestAnalysis.js need.
ok('a label resolves under plain node', sourceLabel('reentry') === SOURCE_LABELS.reentry,
  sourceLabel('reentry'));
// ...and an unknown source is still its own key, which is the tell that one has
// been added with no row anywhere.
ok('an unknown source is still its raw key', sourceLabel('megalodon') === 'megalodon');

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
