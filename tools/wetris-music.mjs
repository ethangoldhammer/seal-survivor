#!/usr/bin/env node
// ============================================================================
// WETRIS'S MUSIC — the loop, made small enough to ship and exact enough to
// loop without a seam.
//
// The source is Ethan's lossless bounce (Wetris_Loops.wav in the design
// system: 48kHz float, the loop and nothing else). This encodes it to a
// low-bitrate MP3 at rive/wetris/music/wetris.mp3 and writes the loop's EXACT
// length, from the WAV's own frame count, into rive/wetris/musicLoop.csv —
// music.luau reads it.
//
// WHY THE LENGTH COMES FROM THE WAV, NOT THE MP3. An MP3 is not the length of
// its music: the encoder puts ~50ms of priming in front and pads the end to a
// whole frame, and the runtime's decoder does not strip either. So restarting
// the file when it ends leaves a gap at every loop — the 320k export in the
// design system has 46ms of silence at its head and 11ms at its tail, and is
// missing the last 58ms of the bar that priming pushed off the end. music.luau
// instead schedules every repeat on the audio clock exactly `seconds` after
// the one before: the priming is the same in every copy, so the MUSIC in each
// copy starts exactly where the last one's ends, and the padding is silence
// overlapping silence.
//
// Needs `lame` (brew install lame). afconvert decodes MP3 but will not write
// one, and Rive decodes only WAV, MP3 and FLAC — a FLAC of this loop is ~12MB.
//
//   npm run wetris:music                      encode from the default source
//   npm run wetris:music -- /path/loop.wav 96 encode another, at 96 kbps
// ============================================================================

import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'rive/wetris');
const OUT = join(PROJECT, 'music/wetris.mp3');
const CSV = join(PROJECT, 'musicLoop.csv');
const DEFAULT_SOURCE = join(homedir(), 'Documents/_DesignSystems/SealSurvivor/Music/Wetris_Loops.wav');

const source = process.argv[2] || DEFAULT_SOURCE;
const kbps = Number(process.argv[3] || 96);

function lame() {
  for (const p of ['/opt/homebrew/bin/lame', '/usr/local/bin/lame']) if (existsSync(p)) return p;
  try { return execFileSync('/usr/bin/which', ['lame'], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

// The loop's length from the source's own header: frames over rate.
function wavLength(path) {
  const info = execFileSync('/usr/bin/afinfo', [path], { encoding: 'utf8' });
  const rate = Number(/(\d+) Hz/.exec(info)?.[1]);
  const bytes = Number(/audio bytes: (\d+)/.exec(info)?.[1]);
  const fmt = /Data format:\s+(\d+) ch,\s+\d+ Hz,\s+(\S+)/.exec(info);
  const chans = Number(fmt?.[1]);
  const bits = /Float32|32-bit/.test(info) ? 32 : /24-bit/.test(info) ? 24 : 16;
  if (!rate || !bytes || !chans) throw new Error(`cannot read ${path}'s length from afinfo`);
  const frames = bytes / (chans * bits / 8);
  return { rate, frames, seconds: frames / rate };
}

if (!existsSync(source)) { console.error(`no source at ${source}`); process.exit(1); }
const encoder = lame();
if (!encoder) {
  console.error('lame is not installed (brew install lame) — nothing encoded');
  process.exit(1);
}
const len = wavLength(source);
mkdirSync(dirname(OUT), { recursive: true });
// CBR joint stereo, so every frame is the same size and nothing about the
// decode varies. RESAMPLED TO 32kHz, which is what LAME picks for itself at
// 96kbps anyway: the bits go further, and 96k's lowpass is ~16kHz regardless.
// Said out loud so it is checked: the loop only stays exact if its length is
// a whole number of samples at the new rate (115.2s x 32000 = 3,686,400).
const RATE_OUT = 32000;
const outFrames = len.seconds * RATE_OUT;
if (Math.abs(outFrames - Math.round(outFrames)) > 1e-6) {
  console.error(`the loop (${len.seconds}s) is not a whole number of samples at ${RATE_OUT}Hz — choose another rate`);
  process.exit(1);
}
execFileSync(encoder, ['--silent', '-q', '2', '-b', String(kbps), '--cbr', '-m', 'j', '--resample', String(RATE_OUT / 1000), source, OUT], { stdio: 'inherit' });
writeFileSync(CSV, [
  'asset,seconds,notes',
  `wetrisLoop,${len.seconds},"the loop's exact length: ${len.frames} frames at ${len.rate}Hz, from the lossless source — NOT the MP3's, which carries encoder priming and padding. music.luau repeats the loop every this-many seconds on the audio clock. Written by tools/wetris-music.mjs."`,
].join('\n') + '\n');
const size = statSync(OUT).size;
console.log(`${OUT}: ${kbps} kbps, ${(size / 1e6).toFixed(2)} MB; loop ${len.seconds}s (${len.frames} frames)`);
