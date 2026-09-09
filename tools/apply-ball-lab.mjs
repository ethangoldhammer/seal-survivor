#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run ball:apply [--dry] [file.json]
//
// The ball lab's numbers (tools/looks/ball-lab.json, written by the page's
// save) into config.js — CONFIG.versus.ball.* and the goo surface at
// CONFIG.fx.goo.groups.ball.* — and OUT of imported-tuning.json, where a
// saved copy would otherwise shadow the new literal forever. The same code as
// the level-up feel's apply (tools/apply-level-up-feel.mjs), told which roots
// the ball's paths live under; see that file for why the snapshot has to be
// cleared and why it refuses while the game's dev server is up.
//
// The look's colour is left out on purpose: config.js writes it as a hex
// literal and the splicer would write a decimal. Set it by hand from the
// lab's readout.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyFeel } from './apply-level-up-feel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
export const DEFAULT_SRC = join(PROJECT, 'tools/looks/ball-lab.json');
export const BALL_ROOTS = ['versus', 'fx'];

/** Everything the lab saved except the colour, as apply paths. */
export function ballPreset(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc ?? {})) {
    if (k.startsWith('__') || k === 'savedAt') continue;
    if (k.endsWith('.color')) continue;
    if (typeof v !== 'number' && typeof v !== 'boolean') continue;
    out[k] = v;
  }
  return out;
}

export async function applyBall(doc, opts = {}) {
  return applyFeel(ballPreset(doc), { roots: BALL_ROOTS, ...opts });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dry = process.argv.includes('--dry');
  const src = process.argv.find((a) => a.endsWith('.json')) ?? DEFAULT_SRC;
  const doc = JSON.parse(await readFile(src, 'utf8'));
  const r = await applyBall(doc, { dry });
  for (const n of r.notes) console.log(`  ${n}`);
  console.log(r.dry ? '\n(dry run — nothing written)' : r.wrote ? '\nwrote path/src/config.js' : '\nconfig.js already matches');
}
