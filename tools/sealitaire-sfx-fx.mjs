#!/usr/bin/env node
// ============================================================================
// PROCESSED TAKES — a phaser, a filter, on a card sound, baked into the bank.
//
// Rive's AudioSound is transport and volume only (no pitch, no filter, no
// send), so an effect has to be printed into the file. This reads
// rive/sealitaire/sfxFx.csv — one row per processed take: `source` (a bank
// id), `effect` (a preset below), `notes` — decodes the source through
// afconvert, runs the effect in plain JS on the samples, levels the result to
// the bank's peak and writes `<source>-<effect>.flac` beside the originals,
// with a row in sfx.csv and an <AudioAsset> in scene.rml's SFX FX block. The
// bank's own baker (tools/sealitaire-sfx.mjs) owns the SFX BANK block; this
// owns the block after it, so either can regenerate without dropping the
// other's lines. tools/sealitaire-sfx-test.mjs checks the result like any
// other file in the bank.
//
//   npm run sealitaire:sfx:fx          # bake every row
//   npm run sealitaire:sfx:fx phaser   # only rows using this effect
//   npm run sealitaire:sfx:fx knock    # THE KNOCK BANK (below), its own block
//
// THE KNOCK BANK. A body knocking the tank glass should sound the size of the
// body — a sardine a tick, an orca a thud — and sit on a send bus with a
// reverb and a low-pass that can be swept down. None of that exists at
// runtime (transport and volume, see above), so it is printed here as a
// LADDER the script picks from and mixes by volume:
//
//   <take>-p<k>        every take of sfxEvents.csv's `tankWall`, resampled
//                      to KNOCK.steps pitch steps of KNOCK.semis semitones
//                      (k = -2..2 is an octave each way); DRY
//   knockbus-p<k>-c<c> the BUS: one representative take per pitch step,
//                      through a reverb and then a low-pass at KNOCK.cutoffs[c]
//                      Hz, c = 0 open .. last darkest
//
// knock.luau turns a body's length into k and a sweep 0..1 into two
// neighbouring c's with equal-power weights; table.luau plays the dry and up
// to two bus voices per knock. So the "bus send" is the bus voices' volume
// and the "sweep" is a crossfade down the cutoff ladder — coarse, but real,
// and the only version of it this runtime can play. The ladder's numbers
// live in KNOCK below and are mirrored in knock.luau; the test checks the
// files for every rung exist, so the two cannot drift silently.
//
// Presets take their numbers from PRESETS below; that is where a phaser gets
// deeper or a filter gets darker. Kept here rather than in the csv so a row
// is a choice ("this take, that effect") and the effect is one thing across
// every take it touches.
// ============================================================================

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BANK = join(ROOT, 'rive/sealitaire/sfx');
const INDEX = join(ROOT, 'rive/sealitaire/sfx.csv');
const SPEC = join(ROOT, 'rive/sealitaire/sfxFx.csv');
const SCENE = join(ROOT, 'rive/sealitaire/scene.rml');
const RATE = 32000;
const TARGET_PEAK = 0.89;          // the bank's level (tools/sealitaire-sfx-test.mjs)
const MIN_SAMPLES = 4608 * 2;      // afconvert's FLAC encoder writes a header and nothing else under one block
const FIRST_ID = 1400;             // 0:1400.. for the SFX FX block; the bank's block is 0:1000..
// WHICH IDS THIS TOOL OWNS. One list: the block is built from it and the
// prune deletes by it, and the two going out of step means either orphans
// left on disk or assets dropped from the scene. Every key of PRESETS has to
// appear here — a preset missing from it bakes a file nothing declares.
const FX_SUFFIX = /-(?:phaser|lowpass|telephone|distant)$/;
const KNOCK_FIRST_ID = 1600;       // 0:1600.. for the SFX KNOCK block
const HOVER_FIRST_ID = 1800;       // 0:1800.. for the SFX HOVER block
// THE CARD-HOVER LADDER. Same idea as the knock and a much smaller one: a
// blip per hovered card, pitched DOWN as the stack under it gets deeper, so
// a lone card ticks and a full column thunks. Dry only — no bus, no sweep;
// this is a UI tick, not a body hitting glass.
//
// Mirrored in table.luau's hover playback. Five rungs over +-8 semitones
// covers a Klondike column (1..13 deep) with room at both ends.
const HOVER = { event: 'cardHover', steps: 2, semis: 4 };
const EVENTS = join(ROOT, 'rive/sealitaire/sfxEvents.csv');
// Mirrored in rive/sealitaire/knock.luau.
const KNOCK = {
  event: 'tankWall',
  steps: 2,                        // k = -steps..steps
  semis: 6,                        // semitones per step: +-2 steps is an octave each way
  cutoffs: [12000, 3000, 1000, 400], // the bus's low-pass ladder, Hz, open first
  busTake: 0,                      // which of the event's takes the bus is printed from
};

// --- presets ---------------------------------------------------------------------
const PRESETS = {
  // A four-stage phaser: the classic swept notches, fed back a little. Slow,
  // wide and wet, so a sub-second sound still gets a whole sweep across it.
  phaser: (x) => {
    const stages = 4, rateHz = 1.4, depth = 0.85, feedback = 0.45, wet = 0.7;
    const minF = 300, maxF = 3200;
    const y = new Float32Array(x.length);
    const z = new Float32Array(stages);
    let fb = 0;
    for (let i = 0; i < x.length; i++) {
      const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * rateHz * i / RATE);
      const f = minF * Math.pow(maxF / minF, lfo * depth + (1 - depth) * 0.5);
      // first-order allpass coefficient for centre frequency f
      const t = Math.tan(Math.PI * f / RATE);
      const a = (t - 1) / (t + 1);
      let s = x[i] + fb * feedback;
      for (let k = 0; k < stages; k++) {
        const out = a * s + z[k];
        z[k] = s - a * out;
        s = out;
      }
      fb = s;
      y[i] = x[i] * (1 - wet) + s * wet;
    }
    return y;
  },
  // FAR AWAY AND UNDER IT — a light room, then the water over the top. For
  // the seal's celebration voices, which are recordings of an animal in air
  // and sit on top of the table unless they are put somewhere.
  //
  // Reverb BEFORE the filter, which is the way round a room works: the
  // reflections are made in the room and then everything reaches you through
  // the water. Filtering first and reverberating after puts a bright tail on
  // a dark sound, which reads as an effect rather than as a place.
  //
  // Light on purpose — 22% wet, half a second. Enough to sit the voice back
  // off the glass; past about a third it stops being a room and starts being
  // a cave, and the card sounds have no reverb at all to answer it.
  distant: (x) => biquad(reverb(x, 0.5, 0.22), lowpassCoefs(1100, 0.7)),
  // Muffled: a two-pole lowpass, as if through the water.
  lowpass: (x) => biquad(x, lowpassCoefs(900, 0.8)),
  // Small speaker: a bandpass around the midrange, brightened a touch.
  telephone: (x) => {
    const y = biquad(biquad(x, highpassCoefs(600, 0.7)), lowpassCoefs(3400, 0.7));
    for (let i = 0; i < y.length; i++) y[i] = Math.tanh(y[i] * 2.2) / 2.2;
    return y;
  },
};

// --- the knock's own processing ------------------------------------------------
// Pitch by resampling (cubic Hermite): a plop an octave down is also twice
// as long, which is what a bigger body knocking sounds like.
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
// A small room: a synthetic impulse — a few early taps, then exponentially
// decaying noise, high end rolling off down the tail — convolved in. Direct
// convolution: the sources are under a second at 32k, so it is cheap enough.
function reverb(x, seconds = 0.7, wet = 0.5) {
  const m = Math.floor(seconds * RATE);
  const ir = new Float32Array(m);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < m; i++) ir[i] = rnd() * Math.exp(-6.9 * i / m) * 0.35;
  for (const [ms, g] of [[11, 0.5], [23, 0.35], [37, 0.3], [53, 0.2]]) ir[Math.floor(ms * RATE / 1000)] += g;
  // the tail darkens: a one-pole lowpass whose cutoff falls down the IR
  let z = 0;
  for (let i = 0; i < m; i++) { const a = 0.15 + 0.6 * (i / m); z += (ir[i] - z) * (1 - a); ir[i] = z; }
  const y = new Float32Array(x.length + m);
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (v === 0) continue; for (let j = 0; j < m; j++) y[i + j] += v * ir[j]; }
  for (let i = 0; i < x.length; i++) y[i] = y[i] * wet + x[i] * (1 - wet);
  for (let i = x.length; i < y.length; i++) y[i] *= wet;
  return y;
}
// Trim leading silence to the bank's pre-roll, so a stretched or wet take
// still starts on its attack (tools/sealitaire-sfx-test.mjs's head limit).
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
function highpassCoefs(f, q) {
  const w = 2 * Math.PI * f / RATE, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
  const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
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

// --- wav in and out (16-bit mono) ----------------------------------------------
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

// --- the csvs --------------------------------------------------------------------
function rows(text) {
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
    return Object.fromEntries(head.map((h, k) => [h.trim(), (cells[k] ?? '').trim()]));
  });
}

const only = process.argv[2];

// --- the knock bank -------------------------------------------------------------
function bakeKnock() {
  const ev = rows(readFileSync(EVENTS, 'utf8')).find((r) => r.event === KNOCK.event);
  if (!ev || !ev.takes) { console.error(`sfxEvents.csv has no "${KNOCK.event}" row with takes`); process.exit(1); }
  const takes = ev.takes.split('|').map((t) => t.trim()).filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), 'sfx-knock-'));
  const made = [];
  const write = (id, x) => {
    x = level(trimHead(x));
    encode(x, join(BANK, `${id}.flac`), tmp);
    made.push({ id, seconds: (x.length / RATE).toFixed(3) });
  };
  for (const take of takes) {
    const src = join(BANK, `${take}.flac`);
    if (!existsSync(src)) { console.error(`SKIP ${take}: not in the bank`); continue; }
    const x = decode(src, tmp);
    for (let k = -KNOCK.steps; k <= KNOCK.steps; k++) {
      const ratio = Math.pow(2, (k * KNOCK.semis) / 12);
      write(`${take}-p${k}`, resample(x, ratio));
    }
    console.log(`${take}: ${KNOCK.steps * 2 + 1} pitch steps`);
  }
  const busSrc = join(BANK, `${takes[KNOCK.busTake]}.flac`);
  const bx = decode(busSrc, tmp);
  for (let k = -KNOCK.steps; k <= KNOCK.steps; k++) {
    const ratio = Math.pow(2, (k * KNOCK.semis) / 12);
    const wet = reverb(resample(bx, ratio), 0.7, 1.0);
    KNOCK.cutoffs.forEach((hz, c) => {
      // Two poles twice: 24dB/oct, so the darkest rung is felt as a sweep
      // down and not as a slightly duller room.
      const y = hz >= RATE / 2 - 1 ? wet : biquad(biquad(wet, lowpassCoefs(hz, 0.707)), lowpassCoefs(hz, 0.707));
      write(`knockbus-p${k}-c${c}`, y);
    });
  }
  console.log(`bus: ${KNOCK.steps * 2 + 1} steps x ${KNOCK.cutoffs.length} cutoffs from ${takes[KNOCK.busTake]}`);
  rmSync(tmp, { recursive: true, force: true });

  let index = readFileSync(INDEX, 'utf8').replace(/\s+$/, '').split('\n');
  for (const m of made) {
    const line = `${m.id},${m.seconds},1,`;
    const k = index.findIndex((l) => l.startsWith(`${m.id},`));
    if (k >= 0) index[k] = line; else index.push(line);
  }
  writeFileSync(INDEX, index.join('\n') + '\n');
  let scene = readFileSync(SCENE, 'utf8');
  const ids = made.map((m) => m.id).sort();
  const block = ['    <!-- SFX KNOCK: generated by tools/sealitaire-sfx-fx.mjs knock; do not hand-edit -->',
    ...ids.map((id, k) => `    <AudioAsset file="sfx/${id}.flac" name="${id}" id="0:${KNOCK_FIRST_ID + k}"/>`),
    '    <!-- /SFX KNOCK -->'].join('\n');
  const re = /    <!-- SFX KNOCK:[\s\S]*?<!-- \/SFX KNOCK -->/;
  if (re.test(scene)) scene = scene.replace(re, block);
  else {
    const at = scene.indexOf('    <!-- /SFX FX -->');
    const eol = scene.indexOf('\n', at);
    scene = scene.slice(0, eol + 1) + block + '\n' + scene.slice(eol + 1);
  }
  writeFileSync(SCENE, scene);
  console.log(`${made.length} knock files baked into the SFX KNOCK block`);
}
// A DRY PITCH LADDER for an event's takes. Deliberately NOT merged with
// bakeKnock above: that one also prints a reverb bus at four cutoffs and is
// being worked on elsewhere, and folding the two together to save fifteen
// lines would put this change in the middle of that one.
function bakeHover() {
  const ev = rows(readFileSync(EVENTS, 'utf8')).find((r) => r.event === HOVER.event);
  if (!ev || !ev.takes) { console.error(`sfxEvents.csv has no "${HOVER.event}" row with takes`); process.exit(1); }
  const takes = ev.takes.split('|').map((t) => t.trim()).filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), 'sfx-hover-'));
  const made = [];
  for (const take of takes) {
    const src = join(BANK, `${take}.flac`);
    if (!existsSync(src)) { console.error(`SKIP ${take}: not in the bank`); continue; }
    const x = decode(src, tmp);
    for (let k = -HOVER.steps; k <= HOVER.steps; k++) {
      const y = level(trimHead(resample(x, Math.pow(2, (k * HOVER.semis) / 12))));
      const id = `${take}-h${k}`;
      encode(y, join(BANK, `${id}.flac`), tmp);
      made.push({ id, seconds: (y.length / RATE).toFixed(3) });
    }
  }
  console.log(`${takes.length} takes x ${HOVER.steps * 2 + 1} rungs = ${made.length} hover files`);
  rmSync(tmp, { recursive: true, force: true });

  let index = readFileSync(INDEX, 'utf8').replace(/\s+$/, '').split('\n');
  // Prune rungs for takes the event no longer names, so dropping a blip from
  // the row does not leave its ladder behind.
  const want = new Set(made.map((m) => m.id));
  const orphans = [];
  index = index.filter((l) => {
    const id = l.split(',')[0];
    if (!/-h-?\d+$/.test(id) || want.has(id)) return true;
    orphans.push(id);
    return false;
  });
  for (const id of orphans) rmSync(join(BANK, `${id}.flac`), { force: true });
  if (orphans.length) console.log(`pruned ${orphans.length} stale rung(s)`);
  for (const m of made) {
    const line = `${m.id},${m.seconds},1,`;
    const k = index.findIndex((l) => l.startsWith(`${m.id},`));
    if (k >= 0) index[k] = line; else index.push(line);
  }
  writeFileSync(INDEX, index.join('\n') + '\n');

  let scene = readFileSync(SCENE, 'utf8');
  const ids = made.map((m) => m.id).sort();
  const block = ['    <!-- SFX HOVER: generated by tools/sealitaire-sfx-fx.mjs hover; do not hand-edit -->',
    ...ids.map((id, k) => `    <AudioAsset file="sfx/${id}.flac" name="${id}" id="0:${HOVER_FIRST_ID + k}"/>`),
    '    <!-- /SFX HOVER -->'].join('\n');
  const re = /    <!-- SFX HOVER:[\s\S]*?<!-- \/SFX HOVER -->/;
  if (re.test(scene)) scene = scene.replace(re, block);
  else {
    const at = scene.indexOf('    <!-- /SFX KNOCK -->');
    const eol = scene.indexOf('\n', at);
    scene = scene.slice(0, eol + 1) + block + '\n' + scene.slice(eol + 1);
  }
  writeFileSync(SCENE, scene);
  console.log(`${made.length} hover files in the SFX HOVER block`);
}

if (only === 'knock') { bakeKnock(); process.exit(0); }
if (only === 'hover') { bakeHover(); process.exit(0); }

const allRows = rows(readFileSync(SPEC, 'utf8')).filter((r) => r.source && r.effect);
const spec = allRows.filter((r) => !only || r.effect === only);
// EVERY take the table names, whatever `only` narrows the BAKE to — this is
// the set the bank should end up holding, and what the prune below measures
// against. Scoping it to `only` would delete the other effects' takes every
// time somebody baked one effect.
const want = new Set(allRows.map((r) => `${r.source}-${r.effect}`));
if (spec.length === 0 && want.size > 0) { console.error('nothing to bake'); process.exit(1); }
// A ROW DELETED FROM THE TABLE HAS TO TAKE ITS FILE WITH IT. Without this the
// tool only ever added: empty sfxFx.csv, run it, and it says "nothing to
// bake" while four orphan .flacs, four sfx.csv rows and four <AudioAsset>
// lines stay in the build — reachable by name, playable by a typo, and
// counted in the bank. That is how the phaser takes outlived the phaser
// idea. tools/sealitaire-sfx-test.mjs checks the three joins agree, so an
// orphan is caught, but only after it has shipped once.
const tmp = mkdtempSync(join(tmpdir(), 'sfx-fx-'));
const made = [];
for (const r of spec) {
  const fx = PRESETS[r.effect];
  if (!fx) { console.error(`SKIP ${r.source}: no preset "${r.effect}" (have ${Object.keys(PRESETS).join(', ')})`); continue; }
  const src = join(BANK, `${r.source}.flac`);
  if (!existsSync(src)) { console.error(`SKIP ${r.source}: not in the bank`); continue; }
  // Level to the bank's peak (and pad under afconvert's block, see MIN_SAMPLES).
  let x = level(fx(decode(src, tmp)));
  const id = `${r.source}-${r.effect}`;
  encode(x, join(BANK, `${id}.flac`), tmp);
  made.push({ id, seconds: (x.length / RATE).toFixed(3), notes: r.notes });
  console.log(`${id.padEnd(26)} ${(x.length / RATE).toFixed(2)}s  ${r.effect}`);
}
rmSync(tmp, { recursive: true, force: true });

// sfx.csv: replace or append a row per processed take.
let index = readFileSync(INDEX, 'utf8').replace(/\s+$/, '').split('\n');
for (const m of made) {
  const line = `${m.id},${m.seconds},1,${m.notes ? `"${m.notes.replace(/"/g, '""')}"` : ''}`;
  const k = index.findIndex((l) => l.startsWith(`${m.id},`));
  if (k >= 0) index[k] = line; else index.push(line);
}
// The prune: any take with one of this tool's suffixes that the table no
// longer names, out of the index and off the disk.
const orphans = [];
index = index.filter((l) => {
  const id = l.split(',')[0];
  if (!FX_SUFFIX.test(id) || want.has(id)) return true;
  orphans.push(id);
  return false;
});
for (const id of orphans) rmSync(join(BANK, `${id}.flac`), { force: true });
writeFileSync(INDEX, index.join('\n') + '\n');
if (orphans.length) console.log(`pruned ${orphans.length} take(s) the table no longer names: ${orphans.join(', ')}`);

// scene.rml: the SFX FX block, every processed take the csv names.
let scene = readFileSync(SCENE, 'utf8');
const all = rows(readFileSync(INDEX, 'utf8')).map((r) => r.id).filter((id) => FX_SUFFIX.test(id)).sort();

const block = ['    <!-- SFX FX: generated by tools/sealitaire-sfx-fx.mjs from sfxFx.csv; do not hand-edit -->',
  ...all.map((id, k) => `    <AudioAsset file="sfx/${id}.flac" name="${id}" id="0:${FIRST_ID + k}"/>`),
  '    <!-- /SFX FX -->'].join('\n');
const re = /    <!-- SFX FX:[\s\S]*?<!-- \/SFX FX -->/;
if (re.test(scene)) scene = scene.replace(re, block);
else {
  const anchor = scene.lastIndexOf('    <AudioAsset file="sfx/');
  const eol = scene.indexOf('\n', anchor);
  scene = scene.slice(0, eol + 1) + block + '\n' + scene.slice(eol + 1);
}
writeFileSync(SCENE, scene);
console.log(`${made.length} processed take(s) baked; ${all.length} in the SFX FX block`);
