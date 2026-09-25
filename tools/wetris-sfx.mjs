#!/usr/bin/env node
// ============================================================================
// WETRIS'S SOUND BANK — cast from sealitaire's, never a bank of its own.
//
// rive/wetris/sfxEvents.csv names, per event, takes out of sealitaire's bank
// (rive/sealitaire/sfx): the card-hover blips, the tank-glass flick-plops,
// the seal's celebration voices. This tool gathers exactly those files into
// rive/wetris/sfx and declares them in scene.rml's SFX block, so the .riv
// carries only what wetris plays.
//
// What a take brings with it depends on its row:
//
//   ladder p   the take's KNOCK pitch ladder, <take>-p-2 .. -p2 (six
//              semitones a rung) — printed by `npm run sealitaire:sfx:fx knock`
//   ladder h   the take's HOVER ladder, <take>-h-2 .. -h2 (four a rung) —
//              printed by `npm run sealitaire:sfx:fx hover`
//   bus knock  sealitaire's knock BUS: knockbus-p<k>-c<c>, a flick-plop
//              through a reverb and then a low-pass at four cutoffs, per rung
//   bus blip   the same bus for the blips, which sealitaire never needed (its
//              hover blips are dry): BAKED HERE as blipbus-p<k>-c<c>, from the
//              first take of the first blip-bus row, the same reverb and the
//              same cutoffs as the knock bus, on the hover ladder's rungs
//
// THE FILTER AND THE BUS, then, are what they are in sealitaire: every take
// in the bank is already through its bank-wide low-pass (sfxLowpass, printed
// by the bank's own bake), and the bus is a crossfade down four baked cutoffs
// under the dry take, at the `busSend` and `busSweep` sliders. Rive's audio is
// transport and volume only; everything else has to be printed.
//
// The DSP below (resample, reverb, the biquad, decode/encode) is a copy of
// tools/sealitaire-sfx-fx.mjs's — that file runs its bake on import, so its
// helpers cannot be imported without baking sealitaire's bank. Keep the
// reverb and the cutoffs in step with its KNOCK table, or the two buses stop
// sounding like one room.
//
//   npm run wetris:sfx          gather + bake, rewrite the SFX block
//   npm run test:wetrissfx      check every event's files are there and declared
// ============================================================================

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'rive/sealitaire/sfx');
const PROJECT = join(ROOT, 'rive/wetris');
const BANK = join(PROJECT, 'sfx');
const EVENTS = join(PROJECT, 'sfxEvents.csv');
const SCENE = join(PROJECT, 'scene.rml');
const RATE = 32000;
const TARGET_PEAK = 0.89;
const MIN_SAMPLES = 4608 * 2;
const FIRST_ID = 3000;             // 0:3000.. for the SFX block
const STEPS = 2;                   // k = -2..2, both ladders
const HOVER_SEMIS = 4;             // the hover ladder's rung (sealitaire-sfx-fx.mjs HOVER)
const CUTOFFS = [12000, 3000, 1000, 400]; // sealitaire-sfx-fx.mjs KNOCK.cutoffs

// --- the csv ---------------------------------------------------------------------
export function readEvents(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = []; let cell = '', q = false;
    for (const c of l) {
      if (q) { if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { cells.push(cell); cell = ''; }
      else cell += c;
    }
    cells.push(cell);
    const r = Object.fromEntries(head.map((h, k) => [h.trim(), (cells[k] ?? '').trim()]));
    r.takes = (r.takes || '').split('|').map((t) => t.trim()).filter(Boolean);
    return r;
  }).filter((r) => r.event);
}

/** Every file id the events need, and the one the blip bus is baked from. */
export function wanted(events) {
  const ids = new Set();
  let blipSource = null;
  for (const ev of events) {
    for (const take of ev.takes) {
      ids.add(take);
      if (ev.ladder === 'p' || ev.ladder === 'h') {
        for (let k = -STEPS; k <= STEPS; k++) ids.add(`${take}-${ev.ladder}${k}`);
      }
    }
    if (ev.bus === 'knock') {
      for (let k = -STEPS; k <= STEPS; k++) CUTOFFS.forEach((_, c) => ids.add(`knockbus-p${k}-c${c}`));
    }
    if (ev.bus === 'blip' && !blipSource && ev.takes.length) blipSource = ev.takes[0];
  }
  const baked = new Set();
  if (blipSource) {
    for (let k = -STEPS; k <= STEPS; k++) CUTOFFS.forEach((_, c) => baked.add(`blipbus-p${k}-c${c}`));
  }
  return { copied: [...ids].sort(), baked: [...baked].sort(), blipSource };
}

// --- dsp: a copy of sealitaire-sfx-fx.mjs's (see the header) -----------------
function resample(x, ratio) {
  const n = Math.max(1, Math.floor(x.length / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * ratio, k = Math.floor(t), f = t - k;
    const p0 = x[Math.max(0, k - 1)], p1 = x[Math.min(x.length - 1, k)], p2 = x[Math.min(x.length - 1, k + 1)], p3 = x[Math.min(x.length - 1, k + 2)];
    y[i] = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}
function reverb(x, seconds = 0.7, wet = 0.5) {
  const m = Math.floor(seconds * RATE);
  const ir = new Float32Array(m);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < m; i++) ir[i] = rnd() * Math.exp(-6.9 * i / m) * 0.35;
  for (const [ms, g] of [[11, 0.5], [23, 0.35], [37, 0.3], [53, 0.2]]) ir[Math.floor(ms * RATE / 1000)] += g;
  let z = 0;
  for (let i = 0; i < m; i++) { const a = 0.15 + 0.6 * (i / m); z += (ir[i] - z) * (1 - a); ir[i] = z; }
  const y = new Float32Array(x.length + m);
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (v === 0) continue; for (let j = 0; j < m; j++) y[i + j] += v * ir[j]; }
  for (let i = 0; i < x.length; i++) y[i] = y[i] * wet + x[i] * (1 - wet);
  for (let i = x.length; i < y.length; i++) y[i] *= wet;
  return y;
}
function trimHead(x, preRoll = 0.004) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const gate = peak * 0.005;
  let head = 0;
  while (head < x.length && Math.abs(x[head]) < gate) head++;
  const keep = Math.max(0, head - Math.floor(preRoll * RATE));
  return keep > 0 ? x.subarray(keep) : x;
}
function level(x) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0) for (let i = 0; i < x.length; i++) x[i] *= TARGET_PEAK / peak;
  if (x.length < MIN_SAMPLES) { const p = new Float32Array(MIN_SAMPLES); p.set(x); x = p; }
  return x;
}
function lowpassCoefs(f, q) {
  const w = 2 * Math.PI * f / RATE, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  const b0 = (1 - c) / 2, b1 = 1 - c, b2 = (1 - c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function decode(path, tmp) {
  const wav = join(tmp, 'in.wav');
  rmSync(wav, { force: true });
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', path, wav], { stdio: ['ignore', 'ignore', 'pipe'] });
  const b = readFileSync(wav);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4), len = b.readUInt32LE(at + 4);
    if (id === 'data') {
      const n = len / 2, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(at + 8 + i * 2) / 32768;
      return x;
    }
    at += 8 + len + (len & 1);
  }
  throw new Error(`${path}: no data chunk`);
}
function encode(x, out, tmp) {
  const wav = join(tmp, 'out.wav');
  const n = x.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(wav, b);
  rmSync(out, { force: true });
  execFileSync('/usr/bin/afconvert', ['-f', 'flac', '-d', 'flac', wav, out], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// --- the scene block ----------------------------------------------------------
function blockFor(ids) {
  return ['    <!-- SFX: generated by tools/wetris-sfx.mjs from sfxEvents.csv; do not hand-edit -->',
    ...ids.map((id, k) => `    <AudioAsset file="sfx/${id}.flac" name="${id}" id="0:${FIRST_ID + k}"/>`),
    '    <!-- /SFX -->'].join('\n');
}
const BLOCK = /    <!-- SFX: generated[\s\S]*?<!-- \/SFX -->/;

function bake() {
  const events = readEvents(readFileSync(EVENTS, 'utf8'));
  const { copied, baked, blipSource } = wanted(events);
  mkdirSync(BANK, { recursive: true });
  const missing = copied.filter((id) => !existsSync(join(SOURCE, `${id}.flac`)));
  if (missing.length) {
    console.error(`not in rive/sealitaire/sfx — bake its ladders first (npm run sealitaire:sfx:fx knock / hover):\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  for (const id of copied) copyFileSync(join(SOURCE, `${id}.flac`), join(BANK, `${id}.flac`));
  if (blipSource) {
    const tmp = mkdtempSync(join(tmpdir(), 'wetris-sfx-'));
    const x = decode(join(SOURCE, `${blipSource}.flac`), tmp);
    for (let k = -STEPS; k <= STEPS; k++) {
      const wet = reverb(resample(x, Math.pow(2, (k * HOVER_SEMIS) / 12)), 0.7, 1.0);
      CUTOFFS.forEach((hz, c) => {
        const y = hz >= RATE / 2 - 1 ? wet : biquad(biquad(wet, lowpassCoefs(hz, 0.707)), lowpassCoefs(hz, 0.707));
        encode(level(trimHead(y)), join(BANK, `blipbus-p${k}-c${c}.flac`), tmp);
      });
    }
    rmSync(tmp, { recursive: true, force: true });
    console.log(`blip bus: ${STEPS * 2 + 1} rungs x ${CUTOFFS.length} cutoffs from ${blipSource}`);
  }
  // Nothing left behind that nothing plays.
  const keep = new Set([...copied, ...baked].map((id) => `${id}.flac`));
  let pruned = 0;
  for (const f of readdirSync(BANK)) {
    if (f.endsWith('.flac') && !keep.has(f)) { rmSync(join(BANK, f)); pruned++; }
  }
  let scene = readFileSync(SCENE, 'utf8');
  const block = blockFor([...copied, ...baked].sort());
  if (BLOCK.test(scene)) scene = scene.replace(BLOCK, block);
  else scene = scene.replace('</Rive>', `${block}\n</Rive>`);
  writeFileSync(SCENE, scene);
  console.log(`${copied.length} files from sealitaire, ${baked.length} baked, ${pruned} pruned; SFX block rewritten`);
}

function check() {
  const events = readEvents(readFileSync(EVENTS, 'utf8'));
  const { copied, baked } = wanted(events);
  const scene = readFileSync(SCENE, 'utf8');
  let bad = 0;
  for (const id of [...copied, ...baked]) {
    const onDisk = existsSync(join(BANK, `${id}.flac`));
    const declared = scene.includes(`name="${id}"`);
    if (!onDisk || !declared) {
      console.log(`  FAIL  ${id}: ${onDisk ? '' : 'not in rive/wetris/sfx '}${declared ? '' : 'not declared in scene.rml'}`);
      bad++;
    }
  }
  // A copy that has drifted from sealitaire's (it was re-baked there).
  for (const id of copied) {
    const a = join(BANK, `${id}.flac`), b = join(SOURCE, `${id}.flac`);
    if (existsSync(a) && existsSync(b) && !readFileSync(a).equals(readFileSync(b))) {
      console.log(`  FAIL  ${id} differs from sealitaire's — npm run wetris:sfx`);
      bad++;
    }
  }
  for (const ev of events) {
    if (ev.ladder && ev.ladder !== 'p' && ev.ladder !== 'h') { console.log(`  FAIL  ${ev.event}: ladder "${ev.ladder}" is not p or h`); bad++; }
    if (ev.bus && ev.bus !== 'knock' && ev.bus !== 'blip') { console.log(`  FAIL  ${ev.event}: bus "${ev.bus}" is not knock or blip`); bad++; }
  }
  console.log(bad ? `${bad} problem${bad === 1 ? '' : 's'}` : `ok — ${events.length} events, ${copied.length + baked.length} files, all present and declared`);
  if (bad) process.exit(1);
}

const cmd = process.argv[1] === fileURLToPath(import.meta.url) ? (process.argv[2] ?? 'bake') : null;
if (cmd === 'bake') bake();
else if (cmd === 'check') check();
else if (cmd !== null) { console.error('usage: wetris-sfx.mjs [bake|check]'); process.exit(2); }
