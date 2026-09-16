#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run film:open
//
// OPEN THE FOLDER THE CLIPS ARE IN, with the newest one selected.
//
// A script rather than a second .app in ~/Applications: the path lives in
// electron/takeFile.js and this is the only place that needs to know it, so an
// app bundle would be a copy of a constant with a Dock icon on it. The
// workbench (`npm run hub`) lists every script in the repo, which makes this a
// button there for free.
//
//   node tools/open-takes.mjs
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RECORDINGS } from '../electron/takeFile.js';

// Created rather than reported missing: `open` on a folder that does not exist
// is an error dialog, and "you have not filmed anything yet" is better said by
// an empty window than by a failure.
mkdirSync(RECORDINGS, { recursive: true });

const newest = readdirSync(RECORDINGS)
  .filter((f) => f.endsWith('.mov'))
  .map((f) => ({ f, at: statSync(join(RECORDINGS, f)).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0];

// -R reveals and SELECTS the file, so the clip you just filmed is the one
// under the cursor rather than one of forty in a list.
if (newest) execFileSync('/usr/bin/open', ['-R', join(RECORDINGS, newest.f)]);
else execFileSync('/usr/bin/open', [RECORDINGS]);

console.log(`  ${RECORDINGS}${newest ? `\n  newest: ${newest.f}` : '\n  (nothing filmed yet)'}`);
