#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run gen:sourcelabels  —  uiText.csv  ->  path/src/sourceLabels.generated.js
//
// WHY A GENERATED FILE AND NOT AN IMPORT. The labels are copy and belong in a
// spreadsheet, where the editor's "needs your words" chip and `npm run
// test:copy` can see them. Their reader, systems/playtestAnalysis.js, is
// deliberately import-free: two Node tools load it directly, and uiTextTable.js
// reaches uiText.csv through a `?raw` import that only a bundler resolves. One
// of those tools (`test:bossshot`) uses jsdom, which tools/vite-loader.mjs
// cannot load at all -- so "just give the tools the loader" is not available.
//
// So the CSV stays the place the words are written and this writes the plain-JS
// copy the pure module can import. `npm run test:sourcelabels` regenerates and
// diffs, so the one failure mode a generated file has -- going stale -- is a
// red test rather than a label that silently lags the spreadsheet.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseIdTable } from '../path/src/csvTable.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'path/src/sourceLabels.generated.js');

// The damage sources that are the WATER hurting something rather than a card
// the player picked. The list is code because a source key is a value the
// ledger books against; only the words are copy.
export const ENVIRONMENT_SOURCES = [
  'impact', 'splash', 'deathBlast', 'sunPass', 'reentry', 'lightning',
  'pickupBlast', 'bubbleJet', 'crabRicochet',
];

export const rowIdFor = (s) => `source${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function build() {
  const rows = parseIdTable(readFileSync(resolve(ROOT, 'path/src/uiText.csv'), 'utf8'),
    'uiText', 'uiText.csv', () => {});
  const missing = [];
  const pairs = ENVIRONMENT_SOURCES.map((s) => {
    const row = rows.get(rowIdFor(s));
    const text = String(row?.text ?? '').trim();
    if (!text) missing.push(rowIdFor(s));
    return [s, text];
  });
  const body = pairs.map(([s, t]) => `  ${s}: ${JSON.stringify(t)},`).join('\n');
  const src = `// GENERATED FROM uiText.csv — DO NOT EDIT.
//
// Edit the \`source*\` rows in path/src/uiText.csv, then run:
//   npm run gen:sourcelabels
//
// It exists because systems/playtestAnalysis.js is import-free on purpose and
// cannot reach a \`?raw\` CSV — see tools/gen-source-labels.mjs for the whole
// reason. \`npm run test:sourcelabels\` fails if this file has gone stale.
export const SOURCE_LABELS = {
${body}
};

/** The uiText.csv rows this file was built from — read by tools/ui-text-test.mjs. */
export const SOURCE_TEXT_IDS = [
${ENVIRONMENT_SOURCES.map((s) => `  '${rowIdFor(s)}',`).join('\n')}
];
`;
  return { src, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { src, missing } = build();
  writeFileSync(OUT, src, 'utf8');
  console.log(`wrote ${OUT}`);
  if (missing.length) console.warn(`  no uiText.csv row yet for: ${missing.join(', ')}`);
}
