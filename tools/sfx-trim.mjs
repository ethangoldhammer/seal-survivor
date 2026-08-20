#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run sfx:trim            report what could come off
// npm run sfx:trim -- --write rewrite the files
//
// Most of the bank came back from processing with a second of digital silence
// welded to the end. Fifty-one of the eighty-six files in public/sfx carry it,
// and the number really is ~1.000s on the nose:
//
//   Seal_Shoot_01.mp3   1.157s long, 0.993s of it silence
//   Seal_PlayerHit_01   1.358s long, 1.014s of it silence
//
// That silence is not free in either of the two places a sound costs anything:
//
//   DOWNLOAD   it is encoded at the same bitrate as the audible part, so a
//              second of nothing is ~12KB per file, ~600KB across the bank.
//   MEMORY     which is the expensive one. decodeAudioData hands back f32 PCM
//              at the CONTEXT's rate, not the file's — every one of these is a
//              22.05kHz mp3 that lands in memory as 48kHz stereo float, 384KB
//              for every second held. The bank is preloaded whole (see
//              prefetchSamples in systems/audio.js), so the silence is not
//              paged in on demand; it is resident for the whole session.
//
// WHY THIS TRIMS THE FILE AND NOT THE BUFFER. The alternative is to scan each
// AudioBuffer after decode and copy the audible part into a shorter one. That
// saves the same memory, but it saves it AFTER paying for the download, the
// decode, and a second allocation of the full-length buffer to copy out of —
// the peak is unchanged, and the peak is what kills a phone. Cutting the file
// is upstream of all three.
//
// WHAT IT DOES NOT DO
//
//   RE-ENCODE   the cut lands on an mp3 frame boundary and the kept frames are
//               copied through byte for byte. An mp3 frame can borrow bits
//               from frames BEFORE it (the bit reservoir) and never from
//               frames after, so dropping a tail is lossless in the strict
//               sense: every sample that survives decodes to the bits it
//               decoded to before. Re-encoding a lossy file to trim it would
//               be a generation loss on the whole sound to remove silence from
//               its end.
//   TOUCH THE   the head is where the attack is, and the 20-30ms in front of
//   HEAD        these files is mostly encoder delay, which the LAME tag
//               already tells the decoder to skip. Leading silence is reported
//               and never cut.
//   TOUCH       public/music is a bar grid — 2.265s per bar — and the loops
//   MUSIC       are only in phase because their lengths are exact multiples of
//               it. Trimming one would silently detune the whole beat system.
//               This tool only ever looks at public/sfx.
//
// THE THRESHOLD. A tail is cut back to the last 10ms window that peaks above
// -70 dBFS, plus a margin. -70 is deliberately far below anything that could
// be part of the sound: it is chosen to catch APPENDED SILENCE, not to gate a
// fade-out. Files whose quiet tail is a real fade (HG_FLY_Beach_069 rings down
// under -60 for half a second) fall out of the run on their own, because what
// they have is signal and this only removes the absence of it.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, writeFileSync, statSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
// public/sfx unless pointed elsewhere. The override exists for the test, which
// runs the whole pass over throwaway copies and diffs the decoded samples —
// see tools/sfx-trim-test.mjs.
const SFX_DIR = String(flag('dir', join(ROOT, 'public', 'sfx')));
const WRITE = argv.includes('--write');
const THRESHOLD_DB = Number(flag('threshold', -70));
// Silence kept after the last audible window. Two things live in here: the
// decoder's own overlap ringing past the final transient, and the fact that a
// one-shot cut flush against its last sample can read as clipped even when the
// samples say otherwise.
const MARGIN = Number(flag('margin', 0.06));
// Below this there is nothing worth a rewrite, and a file that is already
// tight should come out of this run byte-identical rather than nearly so.
const MIN_TRIM = Number(flag('min', 0.2));

// --- mp3 frames -------------------------------------------------------------
// Enough of the format to find frame boundaries and to keep the Xing/LAME
// header honest afterwards. Layer III only, which is every file in the bank.

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],   // MPEG 1
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],       // MPEG 2 / 2.5
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseHeader(buf, off) {
  if (off + 4 > buf.length) return null;
  if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (buf[off + 1] >> 3) & 3;      // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (buf[off + 1] >> 1) & 3;    // 1 = Layer III
  if (verBits === 1 || layerBits !== 1) return null;
  const protectedCrc = (buf[off + 1] & 1) === 0;
  const brIndex = (buf[off + 2] >> 4) & 15;
  const srIndex = (buf[off + 2] >> 2) & 3;
  if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const padding = (buf[off + 2] >> 1) & 1;
  const channelMode = (buf[off + 3] >> 6) & 3;  // 3 = mono
  const mpeg1 = verBits === 3;
  const bitrate = BITRATES[mpeg1 ? 1 : 2][brIndex] * 1000;
  const rate = RATES[verBits][srIndex];
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor((samples / 8) * bitrate / rate) + padding;
  if (length < 24) return null;
  // Where a Xing/Info tag would sit, if this frame carries one.
  const sideInfo = mpeg1 ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17);
  return { off, length, rate, samples, bitrate, channels: channelMode === 3 ? 1 : 2,
           tagOff: off + 4 + (protectedCrc ? 2 : 0) + sideInfo };
}

// A frame header is four bytes with no length field of its own, so a run of
// audio data can look like one. Requiring that the NEXT header lands exactly
// where this one says it will is what makes the scan reliable.
function findFrame(buf, from) {
  for (let off = from; off + 4 <= buf.length; off++) {
    const h = parseHeader(buf, off);
    if (!h) continue;
    if (h.off + h.length + 4 > buf.length) return h;   // last frame, nothing to confirm against
    if (parseHeader(buf, h.off + h.length)) return h;
  }
  return null;
}

function id3v2Length(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size + ((buf[5] & 0x10) ? 10 : 0);
}

export function parseMp3(buf) {
  const start = id3v2Length(buf);
  const first = findFrame(buf, start);
  if (!first) return null;
  const frames = [];
  let off = first.off;
  while (off + 4 <= buf.length) {
    const h = parseHeader(buf, off);
    if (!h) break;
    if (off + h.length > buf.length) break;   // truncated final frame — drop it
    frames.push(h);
    off += h.length;
  }
  if (!frames.length) return null;
  // An ID3v1 tag is exactly 128 bytes of 'TAG…' at EOF and is not part of the
  // stream; carried through so a rewrite never loses one.
  const trailer = buf.length - off === 128 && buf.toString('latin1', off, off + 3) === 'TAG'
    ? buf.subarray(off) : null;
  const tag = xingOf(buf, frames[0]);
  return { id3: buf.subarray(0, start), frames, trailer, tag,
           rate: frames[0].rate, samplesPerFrame: frames[0].samples, channels: frames[0].channels };
}

// The Xing (VBR) or Info (CBR) header, which the first frame carries instead
// of audio. Its frame count and byte count are what a decoder reports as the
// file's duration, so both have to be rewritten or the file claims a length it
// no longer has.
export function xingOf(buf, frame) {
  const id = buf.toString('latin1', frame.tagOff, frame.tagOff + 4);
  if (id !== 'Xing' && id !== 'Info') return null;
  const flags = buf.readUInt32BE(frame.tagOff + 4);
  let p = frame.tagOff + 8;
  const framesOff = (flags & 1) ? (p += 4, p - 4) : -1;
  const bytesOff = (flags & 2) ? (p += 4, p - 4) : -1;
  const tocOff = (flags & 4) ? (p += 100, p - 100) : -1;
  if (flags & 8) p += 4;
  // The LAME extension is optional and sits straight after the Xing fields.
  const lameOff = buf.toString('latin1', p, p + 4) === 'LAME' ? p : -1;
  return { frame, id, flags, framesOff, bytesOff, tocOff, lameOff };
}

// CRC-16/ARC — the one LAME uses for both of the checksums in its tag. Left
// stale, they make a strict decoder throw the whole LAME extension away, and
// with it the gapless delay the file's head depends on.
export function crc16(buf, crc = 0) {
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return crc & 0xffff;
}

// --- what is actually audible ----------------------------------------------
// Decoded through afconvert rather than a JS mp3 decoder: it is on every Mac,
// it applies the file's own gapless delay/padding (so its timeline is the one
// the game will hear), and being wrong here is the only way this tool can do
// damage. macOS-only, and that is fine — this is a one-off asset pass, not
// something the build runs.

export function decodeToWav(src, dir) {
  const out = join(dir, basename(src).replace(/\.[^.]+$/, '') + '.wav');
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', src, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

function readWav(path) {
  const b = readFileSync(path);
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12) };
    if (id === 'data') return { fmt, data: b.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size & 1);
  }
  return { fmt, data: Buffer.alloc(0) };
}

const WINDOW = 0.01;

// Seconds of decoded audio up to and including the last window that peaks
// above the threshold, plus the total length. Both on the decoder's timeline.
export function audibleSpan(wavPath) {
  const { fmt, data } = readWav(wavPath);
  const frames = Math.floor(data.length / 2 / fmt.channels);
  const win = Math.max(1, Math.round(fmt.rate * WINDOW));
  const limit = Math.pow(10, THRESHOLD_DB / 20) * 32768;
  let last = -1, first = -1, peak = 0;
  for (let i = 0; i < frames; i += win) {
    let p = 0;
    const end = Math.min(frames, i + win);
    for (let j = i; j < end; j++) {
      for (let c = 0; c < fmt.channels; c++) {
        const v = Math.abs(data.readInt16LE((j * fmt.channels + c) * 2));
        if (v > p) p = v;
      }
    }
    if (p > peak) peak = p;
    if (p > limit) { last = i + win; if (first < 0) first = i; }
  }
  return {
    duration: frames / fmt.rate,
    audibleEnd: last < 0 ? 0 : Math.min(frames, last) / fmt.rate,
    leading: first < 0 ? frames / fmt.rate : first / fmt.rate,
    rate: fmt.rate, channels: fmt.channels,
    peakDb: peak ? 20 * Math.log10(peak / 32768) : -Infinity,
  };
}

// --- the cut ----------------------------------------------------------------

// The overlap-add in an mp3 decoder means a granule's output is finished by
// the granule AFTER it. Keeping one spare frame past the cut is what stops the
// last audible moment from decoding differently than it used to.
const OVERLAP_FRAMES = 1;

export function trim(buf, mp3, keepSeconds) {
  const { frames, tag, samplesPerFrame, rate } = mp3;
  // Frame 0 is the Xing/Info header and produces no audio, so the audio
  // timeline starts at frame 1. Encoder delay shifts the decoder's timeline
  // against the stream's, and it has to be added back before the seconds we
  // measured can be turned into a frame count.
  const hasTag = !!tag;
  const delay = hasTag && tag.lameOff >= 0 ? (buf[tag.lameOff + 21] << 4) | (buf[tag.lameOff + 22] >> 4) : 0;
  const needSamples = keepSeconds * rate + delay;
  const audioFrames = Math.ceil(needSamples / samplesPerFrame) + OVERLAP_FRAMES;
  const keep = Math.min(frames.length, (hasTag ? 1 : 0) + Math.max(1, audioFrames));
  if (keep >= frames.length) return null;

  const kept = frames.slice(0, keep);
  const parts = [mp3.id3];
  for (const f of kept) parts.push(buf.subarray(f.off, f.off + f.length));
  if (mp3.trailer) parts.push(mp3.trailer);
  const out = Buffer.concat(parts);

  if (hasTag) rewriteTag(out, mp3, kept);
  return { buffer: out, keptFrames: keep, droppedFrames: frames.length - keep };
}

// Everything in the Xing/Info frame that describes the rest of the file, put
// back in agreement with what the file now is.
export function rewriteTag(out, mp3, kept) {
  const { tag } = mp3;
  const base = mp3.id3.length;                 // the tag frame moved with the ID3 block
  const at = (off) => base + (off - mp3.frames[0].off);
  const audio = kept.slice(1);
  const total = out.length;
  const infoLength = kept[0].length;

  if (tag.framesOff >= 0) out.writeUInt32BE(audio.length, at(tag.framesOff));
  if (tag.bytesOff >= 0) out.writeUInt32BE(total, at(tag.bytesOff));

  // The TOC is a hundred seek points, one per percent of the file's DURATION,
  // each a 0-255 fraction of its length. Left alone it points into the middle
  // of a file that ends earlier than it thinks.
  if (tag.tocOff >= 0) {
    const toc = at(tag.tocOff);
    for (let i = 0; i < 100; i++) {
      const frame = Math.min(audio.length - 1, Math.floor(audio.length * i / 100));
      const off = base + infoLength + audio.slice(0, Math.max(0, frame)).reduce((n, f) => n + f.length, 0);
      out[toc + i] = Math.max(0, Math.min(255, Math.round(255 * off / total)));
    }
  }

  if (tag.lameOff >= 0) {
    const lame = at(tag.lameOff);
    // Padding is how many samples the decoder should drop off the END. It
    // described silence that is no longer in the file; leaving it would eat
    // real margin instead. The delay at the head is untouched.
    const delay = (out[lame + 21] << 4) | (out[lame + 22] >> 4);
    out[lame + 21] = (delay >> 4) & 0xff;
    out[lame + 22] = ((delay & 0xf) << 4);
    out[lame + 23] = 0;
    out.writeUInt32BE(total, lame + 28);                       // music length
    out.writeUInt16BE(crc16(out.subarray(base + infoLength)), lame + 32);  // music CRC
    out.writeUInt16BE(crc16(out.subarray(base, lame + 34)), lame + 34);    // tag CRC
  }
}

// --- run --------------------------------------------------------------------
// Guarded, because the test imports the parser above to BUILD its fixtures —
// it pads a real file back out with a second of silence so there is something
// for the cut to remove. An unguarded module body would mean importing that
// parser silently kicked off a pass over public/sfx.

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) run();

function run() {
const files = readdirSync(SFX_DIR).filter((f) => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f)).sort();
const work = mkdtempSync(join(tmpdir(), 'sfx-trim-'));
const rows = [];

for (const name of files) {
  const abs = join(SFX_DIR, name);
  const row = { name, bytes: statSync(abs).size };
  rows.push(row);
  if (!/\.mp3$/i.test(name)) { row.skip = 'not mp3'; continue; }

  let span;
  try { span = audibleSpan(decodeToWav(abs, work)); }
  catch (err) { row.skip = `decode failed (${err?.message ?? err})`; continue; }

  Object.assign(row, {
    duration: span.duration, tail: span.duration - span.audibleEnd,
    leading: span.leading, peakDb: span.peakDb, channels: span.channels,
  });
  if (span.audibleEnd <= 0) { row.skip = 'silent'; continue; }

  const keepSeconds = span.audibleEnd + MARGIN;
  if (span.duration - keepSeconds < MIN_TRIM) { row.skip = 'already tight'; continue; }

  const buf = readFileSync(abs);
  const mp3 = parseMp3(buf);
  if (!mp3) { row.skip = 'no mp3 frames'; continue; }

  const cut = trim(buf, mp3, keepSeconds);
  if (!cut) { row.skip = 'already tight'; continue; }
  row.newBytes = cut.buffer.length;
  row.dropped = cut.droppedFrames;
  row.newDuration = keepSeconds;

  if (WRITE) {
    writeFileSync(abs, cut.buffer);
    // The proof is the file on disk, not the plan: decode what was just
    // written and confirm the audible part survived intact.
    try {
      const after = audibleSpan(decodeToWav(abs, work));
      row.check = after.audibleEnd + 0.001 >= span.audibleEnd
        ? 'ok'
        : `LOST ${(span.audibleEnd - after.audibleEnd).toFixed(3)}s`;
      row.newDuration = after.duration;
    } catch (err) { row.check = `unreadable (${err?.message ?? err})`; }
  }
}

rmSync(work, { recursive: true, force: true });

// Decoded cost, which is the number this is really about: Web Audio resamples
// to the context rate and stores float32, so a second of a 22kHz mp3 and a
// second of a 48kHz one weigh exactly the same in memory.
const CTX_RATE = 48000;
const decodedBytes = (seconds, channels) => seconds * CTX_RATE * 4 * channels;

const trimmed = rows.filter((r) => r.newBytes);
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d = 3) => String(v == null ? '-' : v.toFixed(d)).padStart(n);

console.log(`\n  ${pad('file', 44)}${'dur'.padStart(8)}${'tail'.padStart(8)}${'lead'.padStart(8)}${'→ dur'.padStart(9)}${'  kb'.padStart(8)}  note`);
console.log('  ' + '-'.repeat(94));
for (const r of rows.sort((a, b) => (b.tail ?? -1) - (a.tail ?? -1))) {
  const kb = r.newBytes ? `${(r.bytes / 1024).toFixed(0)}→${(r.newBytes / 1024).toFixed(0)}` : (r.bytes / 1024).toFixed(0);
  console.log(`  ${pad(r.name.slice(0, 43), 44)}${num(r.duration, 8)}${num(r.tail, 8)}${num(r.leading, 8)}${num(r.newDuration, 9)}${kb.padStart(8)}  ${r.check ?? r.skip ?? ''}`);
}

const before = rows.reduce((n, r) => n + r.bytes, 0);
const after = rows.reduce((n, r) => n + (r.newBytes ?? r.bytes), 0);
const memBefore = rows.reduce((n, r) => n + (r.duration ? decodedBytes(r.duration, r.channels) : 0), 0);
const memSaved = trimmed.reduce((n, r) => n + decodedBytes(r.duration - r.newDuration, r.channels), 0);

console.log(`\n  ${trimmed.length} of ${rows.length} files carry a trimmable tail`
  + ` (threshold ${THRESHOLD_DB} dBFS, margin ${MARGIN}s, minimum ${MIN_TRIM}s)`);
console.log(`  on disk   ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`
  + `   (−${((before - after) / 1024).toFixed(0)} KB, ${(100 * (before - after) / before).toFixed(0)}%)`);
console.log(`  decoded   ${(memBefore / 1048576).toFixed(1)} MB → ${((memBefore - memSaved) / 1048576).toFixed(1)} MB`
  + `   (−${(memSaved / 1048576).toFixed(1)} MB at ${CTX_RATE / 1000}kHz float32)`);

const lost = rows.filter((r) => r.check && r.check !== 'ok');
if (lost.length) {
  console.log(`\n  ${lost.length} file(s) did not verify:`);
  for (const r of lost) console.log(`    ${r.name} — ${r.check}`);
  process.exitCode = 1;
} else if (!WRITE && trimmed.length) {
  console.log('\n  nothing written. re-run with --write to apply.\n');
} else {
  console.log('');
}
}
