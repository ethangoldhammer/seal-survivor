#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run sfx:excerpt -- <file.mp3> [--seconds 1.5] [--write]
//
// Cuts a one-shot out of the middle of a long bed.
//
// Library "ambience" arrives as a minute of continuous material — the two
// electricity beds in this bank are 61s and 64s — and a minute is not a sound
// effect. Assigned to a voice it is preloaded and decoded whole, and decoded
// whole it is 23MB of resident float per file (see the note in sfx-trim.mjs
// about what a second of audio actually costs). The usable sound inside it is
// about a second and a half.
//
// SAME FRAME SURGERY AS sfx-trim, with one extra problem. Dropping frames off
// the END is unconditionally safe: an mp3 frame can borrow bits from frames
// before it and never from frames after. Dropping frames off the FRONT is not
// — the first frame kept may be one whose audio lives partly in the bit
// reservoir of a frame that no longer exists, and it decodes with whatever was
// in the decoder's empty reservoir instead.
//
// The clean fix is to start on a frame whose `main_data_begin` is ZERO, the
// header field meaning "this frame owes the reservoir nothing". The tool looks
// for one, and on sparse material it finds one within a few frames.
//
// IT USUALLY WILL NOT FIND ONE. A dense bed is exactly the case where the
// encoder is borrowing in every single frame: the 61s electricity bed has ONE
// reservoir-free frame in 2338, and it is the first. So the tool does not
// pretend — when it cannot start clean it starts anyway and MEASURES what that
// cost, by decoding the excerpt and diffing it against the same region decoded
// from the original. That number is printed every run. On noise it is a couple
// of frames of slightly wrong noise and inaudible; on a tonal sound it would
// be a click, and then you would see it here rather than ship it.
//
// The window itself is chosen to SOUND LIKE A ONE-SHOT, which is not the same
// as being the loudest stretch. A one-shot starts and stops; the loudest 1.5s
// of a continuous bed stops mid-crackle, and a file that simply ceases at full
// level is a click no matter how cleanly the frames were cut. So the score is
// front-loaded energy MINUS end energy: the window that begins hard and has
// already died away by the time the file ends. Picking by hand is not
// repeatable, and picking by loudness alone gives you a chunk, not a sound.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { parseMp3, rewriteTag, decodeToWav } from './sfx-trim.mjs';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : fallback;
};
const SECONDS = flag('seconds', 1.5);
const targets = argv.filter((a) => !a.startsWith('--') && /\.mp3$/i.test(a));

if (!targets.length) {
  console.error('  usage: sfx-excerpt <file.mp3> [...] [--seconds 1.5] [--write]');
  process.exit(1);
}

function readWav(path) {
  const b = readFileSync(path);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12) };
    if (id === 'data') return { ...fmt, data: b.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

// The best `seconds`-long one-shot in the file. Stepped in tenths rather than
// per sample: the answer only has to be the right MOMENT, and a hundred-times
// finer search picks a window a few milliseconds over on material that is
// uniform at that scale anyway.
function oneShotWindow(wav, seconds) {
  const frames = Math.floor(wav.data.length / 2 / wav.channels);
  const step = Math.round(wav.rate * 0.1);
  const width = Math.round(wav.rate * seconds);
  if (frames <= width) return 0;
  // Running sum of squares over 0.1s cells, so each window is a cheap slice sum.
  const cells = [];
  for (let i = 0; i < frames; i += step) {
    let sum = 0;
    const end = Math.min(frames, i + step);
    for (let j = i; j < end; j++) {
      for (let c = 0; c < wav.channels; c++) {
        const v = wav.data.readInt16LE((j * wav.channels + c) * 2) / 32768;
        sum += v * v;
      }
    }
    cells.push(sum);
  }
  const span = Math.max(1, Math.round(width / step));
  if (span >= cells.length) return 0;
  // Front is the attack the window is chosen for; back is what has to have
  // gone quiet by the end. Weighted so a loud window with a loud ending loses
  // to a slightly quieter one that decays — the ending is the part you would
  // notice, because it is where the file stops.
  const front = Math.max(1, Math.round(span * 0.4));
  const back = Math.max(1, Math.round(span * 0.2));
  const mean = (from, count) => {
    let sum = 0;
    for (let i = from; i < from + count; i++) sum += cells[i] ?? 0;
    return sum / count;
  };
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i + span <= cells.length; i++) {
    const score = mean(i, front) - 2 * mean(i + span - back, back);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best * step / wav.rate;
}

// Whether this frame's audio is self-contained. `main_data_begin` is the first
// field of the side info — 9 bits on MPEG1, 8 on MPEG2/2.5 — and counts bytes
// backwards into the reservoir. Zero means it reaches back nowhere.
function reservoirFree(buf, frame, mpeg1, protectedCrc) {
  const si = frame.off + 4 + (protectedCrc ? 2 : 0);
  if (mpeg1) return ((buf[si] << 1) | (buf[si + 1] >> 7)) === 0;
  return buf[si] === 0;
}

const work = mkdtempSync(join(tmpdir(), 'sfx-excerpt-'));
let failed = false;

for (const target of targets) {
  const abs = resolve(target);
  const name = basename(abs);
  const buf = readFileSync(abs);
  const mp3 = parseMp3(buf);
  if (!mp3) { console.log(`  ${name} — not an mp3 this can parse`); failed = true; continue; }

  const wav = readWav(decodeToWav(abs, work));
  const total = (wav.data.length / 2 / wav.channels) / wav.rate;
  if (total <= SECONDS * 1.2) { console.log(`  ${name} — already ${total.toFixed(2)}s, nothing to excerpt`); continue; }

  const at = oneShotWindow(wav, SECONDS);

  // Frame 0 carries the Xing header and no audio, so the audio timeline starts
  // at frame 1. The decoder's clock is the stream's minus the encoder delay,
  // which has to be added back before a moment in the wav can be a frame here.
  const spf = mp3.samplesPerFrame;
  const lame = mp3.tag?.lameOff ?? -1;
  const delay = lame >= 0 ? (buf[lame + 21] << 4) | (buf[lame + 22] >> 4) : 0;
  const audio = mp3.frames.slice(1);
  const frameAt = (sec) => Math.floor((sec * mp3.rate + delay) / spf);

  const mpeg1 = mp3.rate > 24000;
  const protectedCrc = (buf[mp3.frames[0].off + 1] & 1) === 0;

  const wanted = Math.max(0, Math.min(audio.length - 1, frameAt(at)));
  // Walk BACK to a frame that owes the reservoir nothing — backwards, never
  // forwards, so this can only ever add lead-in, where forwards would clip the
  // transient the window was chosen for. Bounded, because on dense material
  // the search would otherwise run to the top of the file and hand back the
  // whole bed, which is the opposite of the job.
  const LOOKBACK = Math.max(1, Math.round(0.5 * mp3.rate / spf));
  let scan = wanted;
  while (scan > 0 && wanted - scan < LOOKBACK
    && !reservoirFree(buf, audio[scan], mpeg1, protectedCrc)) scan--;
  const clean = reservoirFree(buf, audio[scan], mpeg1, protectedCrc);
  const first = clean ? scan : wanted;
  const lead = (wanted - first) * spf / mp3.rate;
  // One frame past the window, for the same reason sfx-trim keeps one: an mp3
  // granule's output is finished by the granule after it, so the final frame
  // of any cut decodes incomplete. Without the spare that lands INSIDE the
  // excerpt and the last 26ms come out wrong.
  const last = Math.min(audio.length, frameAt(at + SECONDS) + 2);

  const kept = [mp3.frames[0], ...audio.slice(first, last)];
  const parts = [mp3.id3, ...kept.map((f) => buf.subarray(f.off, f.off + f.length))];
  if (mp3.trailer) parts.push(mp3.trailer);
  const out = Buffer.concat(parts);
  if (mp3.tag) rewriteTag(out, mp3, kept);

  const secs = (kept.length - 1) * spf / mp3.rate;

  // Decode what we are about to write and hold it against the same stretch of
  // the original. Everything after the reservoir has refilled must be sample
  // for sample identical; the head is where a cold start shows, and how far it
  // reaches is the number worth printing.
  const probe = join(work, `probe-${name}`);
  writeFileSync(probe, out);
  const cut = readWav(decodeToWav(probe, work));
  // Where the excerpt's first decoded sample sits in the original's decoded
  // timeline. The two files carry the SAME LAME delay, so it cancels: the
  // excerpt's sample 0 is stream sample `delay` of a stream that begins at
  // original stream sample `first * spf`, which is original decoded sample
  // `first * spf` exactly. Deriving it from the requested seconds instead
  // lands a few milliseconds out and reports the whole excerpt as damaged.
  const origAt = Math.max(0, first * spf);
  const n = Math.min(cut.data.length / 2 / cut.channels, (wav.data.length / 2 / wav.channels) - origAt);
  // Reported as a HEAD span and a TAIL span, never as one "last bad sample".
  // A single last-bad scan reads the final frame's incomplete overlap as if
  // the whole excerpt were damaged — which is exactly the wrong conclusion,
  // since everything between the two ends is bit-identical.
  const errAt = (i) => {
    let d = 0;
    for (let c = 0; c < cut.channels; c++) {
      d = Math.max(d, Math.abs(wav.data.readInt16LE(((origAt + i) * wav.channels + c) * 2)
        - cut.data.readInt16LE((i * cut.channels + c) * 2)));
    }
    return d;
  };
  const FLOOR = 64;   // 64/32768 ≈ -54 dBFS
  // Measured in 10ms WINDOWS, not in runs of consecutive bad samples. A cold
  // start is intermittent — it dips under the floor for a sample or two and
  // comes back — so a run-length scan stops after 2ms and reports the rest of
  // the damage as if it were in the middle of the file, which then reads as
  // "the body does not match" on an excerpt whose body is bit-perfect.
  const CELL = Math.round(cut.rate * 0.01);
  const cells = [];
  for (let i = 0; i < n; i += CELL) {
    let d = 0;
    for (let j = i; j < Math.min(n, i + CELL); j++) d = Math.max(d, errAt(j));
    cells.push(d);
  }
  let head = 0;
  while (head < cells.length && cells[head] > FLOOR) head++;
  let tail = 0;
  while (tail < cells.length - head && cells[cells.length - 1 - tail] > FLOOR) tail++;
  const headPeak = Math.max(0, ...cells.slice(0, head));
  const tailPeak = Math.max(0, ...cells.slice(cells.length - tail));
  const middle = Math.max(0, ...cells.slice(head, cells.length - tail));
  const db = (v) => (v ? `${(20 * Math.log10(v / 32768)).toFixed(0)} dBFS` : 'silent');
  let sig = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < cut.channels; c++) sig = Math.max(sig, Math.abs(cut.data.readInt16LE((i * cut.channels + c) * 2)));
  }

  console.log(`  ${name}`);
  console.log(`    ${total.toFixed(2)}s → ${secs.toFixed(2)}s from ${at.toFixed(2)}s`
    + `   ${(buf.length / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB`);
  console.log(`    start: ${clean ? `clean — reservoir-free frame, ${(lead * 1000).toFixed(0)}ms lead-in`
    : `cold — no reservoir-free frame within ${(LOOKBACK * spf / mp3.rate * 1000).toFixed(0)}ms`}`);
  console.log(`    head ${head ? `${head * 10}ms at ${db(headPeak)}` : 'exact'}`
    + ` · middle ${middle > FLOOR ? `DIVERGES at ${db(middle)}` : 'bit-identical'}`
    + ` · tail ${tail ? `${tail * 10}ms at ${db(tailPeak)}` : 'exact'}`
    + `   (signal ${db(sig)})`);
  if (middle > FLOOR) { console.log('    REFUSING — the body of the excerpt does not match the original'); failed = true; continue; }

  if (WRITE) {
    writeFileSync(abs, out);
    console.log('    written.');
  }
}

rmSync(work, { recursive: true, force: true });
if (!WRITE) console.log('\n  nothing written. re-run with --write to apply.\n');
process.exit(failed ? 1 : 0);
