#!/usr/bin/env node
// ============================================================================
// AUDITION THE CARD SOUNDS — rive/sealitaire/sfx/*.flac through the Mac's own
// player, one at a time, with the name on screen so a keeper can be written
// down against the event it is for.
//
//   npm run sealitaire:audition     # interactive: space/n next, p previous,
//                                   #   r replay, digits+enter jump, q quit
//   npm run sealitaire:audition 37  # play one and exit
//   npm run sealitaire:audition digi     # only the files whose name has "digi"
//   npm run sealitaire:audition survivor # the game's own pool instead: public/sfx/*.mp3
//
// The same pack can be stepped through INSIDE the live game (npm run
// sealitaire): J previous, L next, K replay, each printed to the console —
// that is the one that tells you how a hit sits under the water and the CRT.
// ============================================================================

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let arg = process.argv[2];
const survivor = arg === 'survivor';
if (survivor) arg = process.argv[3];
const DIR = join(ROOT, survivor ? 'public/sfx' : 'rive/sealitaire/sfx');
let files = readdirSync(DIR).filter((f) => /\.(flac|mp3|wav)$/.test(f)).sort();
if (arg && !/^\d+$/.test(arg)) files = files.filter((f) => f.toLowerCase().includes(arg.toLowerCase()));
if (files.length === 0) { console.error('no sounds match'); process.exit(1); }

let child = null;
function play(i) {
  if (child) child.kill();
  const f = files[i];
  process.stdout.write(`\r\x1b[K[${String(i + 1).padStart(2)}/${files.length}] ${f}   `);
  child = spawn('afplay', [join(DIR, f)], { stdio: 'ignore' });
  child.on('exit', () => { child = null; });
}

if (arg && /^\d+$/.test(arg)) {
  const i = Math.max(1, Math.min(files.length, Number(arg))) - 1;
  play(i);
  child.on('exit', () => { console.log(); process.exit(0); });
} else {
  let i = 0;
  let typed = '';
  console.log(`${files.length} sounds in ${survivor ? 'public/sfx' : 'sfx'}/. space/n next · p previous · r replay · digits+enter jump · q quit`);
  play(i);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k) => {
    if (k === 'q' || k === '') { if (child) child.kill(); console.log(); process.exit(0); }
    if (/^\d$/.test(k)) { typed += k; process.stdout.write(k); return; }
    if (k === '\r' && typed) { i = Math.max(1, Math.min(files.length, Number(typed))) - 1; typed = ''; play(i); return; }
    typed = '';
    if (k === ' ' || k === 'n' || k === '[C') { i = (i + 1) % files.length; play(i); }
    else if (k === 'p' || k === '[D') { i = (i - 1 + files.length) % files.length; play(i); }
    else if (k === 'r') play(i);
  });
}
