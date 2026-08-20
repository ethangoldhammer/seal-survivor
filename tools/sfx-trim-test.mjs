#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sfxtrim
//
// tools/sfx-trim.mjs cuts mp3s by dropping whole frames off the end and then
// rewriting the header that describes them. Two things can go wrong, and
// neither of them makes a noise:
//
//   THE CUT LANDS TOO EARLY   and the end of the sound is gone. On a tail that
//                             was ~1s of silence, losing the last 30ms of a
//                             decay is not something you would hear on the one
//                             file you happened to audition.
//   THE HEADER GOES STALE     and a decoder that validates the LAME tag CRC
//                             throws the extension away — taking the encoder
//                             delay with it, so every trimmed file gains 26ms
//                             of silence at the FRONT. That is a timing bug in
//                             a game where the shot sound is the feedback for
//                             the shot, and it would show up as "the audio
//                             feels late" long before anyone suspected a tag.
//
// So this does not check that the tool ran. It decodes both versions: every
// sample the trimmed file still has must be the sample the original had, at
// the same index. Byte-identical decoding is the only claim worth making about
// a lossless cut, and it is checkable.
//
// WHERE THE SUBJECTS COME FROM. Not from the bank as it stands — the bank has
// already been trimmed, so every file in it is a file with nothing to remove,
// and a test that ran over them would report seven passes for seven no-ops
// forever. Each subject is PADDED BACK OUT first, by appending copies of its
// own final (silent) frame until it carries a second of tail again, which is
// exactly the shape the processing left them in. Then the tool has to put it
// back, and "back" is a file we still have to compare against.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseMp3, crc16, rewriteTag } from './sfx-trim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SFX_DIR = join(ROOT, 'public', 'sfx');

let failures = 0;
const fail = (msg) => { console.log(`  FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`  ok    ${msg}`);

// afconvert is the tool's own decoder, and macOS-only. Everywhere else this
// test has nothing to measure with, so it says so and stops rather than
// passing on no evidence. (`afconvert` with no work to do exits 2, so its own
// exit code says nothing about whether it is installed.)
try {
  execFileSync('/usr/bin/which', ['afconvert'], { stdio: 'ignore' });
} catch {
  console.log('\n  sfx-trim needs afconvert (macOS). Skipping.\n');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'sfx-trim-test-'));
const subjects = join(work, 'sfx');
mkdirSync(subjects);

// A spread rather than the whole bank: one file per shape the parser has to
// cope with — a long ambient bed, short one-shots where the tail was most of
// the file, and one whose quiet end is a real fade rather than appended
// silence. PAD marks the ones handed back a second of tail to remove; the
// others go in as they are and have to come out untouched.
const SUBJECTS = [
  { file: 'Seal_Ambient_04.mp3', pad: 1 },
  { file: 'Seal_Shoot_05.mp3', pad: 1 },     // 0.24s of audio — the tail was 80% of it
  { file: 'Seal_PlayerHit_01.mp3', pad: 1 },
  { file: 'pickup1.mp3', pad: 1 },
  { file: 'HG_FLY_Beach_069.mp3', pad: 0 },  // fades under the threshold; nothing appended
  { file: 'HG_UI_Ball_Bink.mp3', pad: 0 },   // 0.16s, tight
  { file: 'Juno60_blips_043.mp3', pad: 0 },  // tight, and the longest leading silence
];

// A second of tail, built out of the file's own last frame. That frame is
// already silence (the tool leaves a margin), it is the right format by
// construction, and repeating it is what an encoder appending silence does.
//
// The Xing header HAS to be brought along. Left saying what it said before,
// it declares the old frame count — and a decoder believes it: afconvert
// stopped at the pre-padding length, so the fixture decoded as though it had
// never been padded, the tool correctly found nothing to trim, and every
// assertion below passed against a file the cut had never touched. A fixture
// that quietly isn't the thing under test is worse than no fixture.
function padWithSilence(buf, seconds) {
  const mp3 = parseMp3(buf);
  if (!mp3) return null;
  const last = mp3.frames[mp3.frames.length - 1];
  const silent = buf.subarray(last.off, last.off + last.length);
  const count = Math.ceil(seconds * mp3.rate / mp3.samplesPerFrame);
  const body = buf.subarray(0, last.off + last.length);
  const padded = Buffer.concat([body, ...Array.from({ length: count }, () => silent)]);
  const grown = parseMp3(padded);
  if (grown?.tag) rewriteTag(padded, grown, grown.frames);
  return padded;
}

// Samples per frame: MPEG 2 / 2.5 halved Layer III's granule count, and every
// file in the bank that was resampled on the way in is on that side of it.
const spfFor = (rate) => (rate <= 24000 ? 576 : 1152);

function decode(src, tag) {
  const out = join(work, `${tag}.wav`);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', src, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  const b = readFileSync(out);
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

// Everything in the Xing/Info frame that makes a claim about the rest of the
// file, checked against what the file actually is.
function tagFaults(buf) {
  const mp3 = parseMp3(buf);
  if (!mp3) return ['unparseable as mp3'];
  const tag = mp3.tag;
  if (!tag) return [];   // no Xing frame to go stale
  const faults = [];
  const audio = mp3.frames.slice(1);
  if (tag.framesOff >= 0 && buf.readUInt32BE(tag.framesOff) !== audio.length) {
    faults.push(`Xing frame count says ${buf.readUInt32BE(tag.framesOff)}, file has ${audio.length}`);
  }
  if (tag.bytesOff >= 0 && buf.readUInt32BE(tag.bytesOff) !== buf.length) {
    faults.push(`Xing byte count says ${buf.readUInt32BE(tag.bytesOff)}, file is ${buf.length}`);
  }
  if (tag.lameOff >= 0) {
    const start = mp3.frames[0].off;
    const music = buf.subarray(start + mp3.frames[0].length);
    if (buf.readUInt32BE(tag.lameOff + 28) !== buf.length) {
      faults.push(`LAME music length says ${buf.readUInt32BE(tag.lameOff + 28)}, file is ${buf.length}`);
    }
    if (buf.readUInt16BE(tag.lameOff + 32) !== crc16(music)) faults.push('LAME music CRC stale');
    if (buf.readUInt16BE(tag.lameOff + 34) !== crc16(buf.subarray(start, tag.lameOff + 34))) {
      faults.push('LAME tag CRC stale');
    }
  }
  return faults;
}

// The check above is only worth anything if crc16 computes what LAME computes.
// A bank file is the control: those bytes were written by LAME itself and
// nothing here has touched them, so they must come out clean.
{
  const control = 'Seal_Ambient_04.mp3';
  const faults = readdirSync(SFX_DIR).includes(control) ? tagFaults(readFileSync(join(SFX_DIR, control))) : ['missing'];
  if (faults.length) fail(`header check is broken — ${control} as shipped reads as ${faults.join('; ')}`);
  else pass(`header check agrees with LAME on an untouched file`);
}

const onDisk = readdirSync(SFX_DIR);
const present = SUBJECTS.filter((s) => onDisk.includes(s.file));
if (present.length < SUBJECTS.length) {
  fail(`missing subjects: ${SUBJECTS.filter((s) => !present.includes(s)).map((s) => s.file).join(', ')}`);
}

const reference = new Map();  // file -> decoded bank version, before any padding
for (const { file, pad } of present) {
  const bank = readFileSync(join(SFX_DIR, file));
  reference.set(file, { bytes: bank, fixture: bank, audio: decode(join(SFX_DIR, file), `ref-${file}`) });
  if (!pad) { copyFileSync(join(SFX_DIR, file), join(subjects, file)); continue; }
  const padded = padWithSilence(bank, pad);
  if (!padded) { fail(`${file} — could not be parsed as mp3`); continue; }
  writeFileSync(join(subjects, file), padded);
  reference.get(file).fixture = padded;
}

// A non-zero exit is the tool's own post-write check refusing what it wrote.
// Caught rather than thrown, so it reads as a failing test instead of a stack
// trace with the per-file results never printed.
try {
  execFileSync(process.execPath, [join(HERE, 'sfx-trim.mjs'), '--dir', subjects, '--write'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  fail(`sfx-trim exited ${err.status}: ${String(err.stdout ?? '').trim().split('\n').slice(-3).join(' / ')}`);
}

for (const { file, pad } of present) {
  const ref = reference.get(file);
  if (!ref) continue;
  const a = ref.audio;
  const b = decode(join(subjects, file), `out-${file}`);
  const untouched = Buffer.compare(ref.fixture, readFileSync(join(subjects, file))) === 0;

  if (a.rate !== b.rate || a.channels !== b.channels) {
    fail(`${file} — format changed, ${a.rate}Hz x${a.channels} → ${b.rate}Hz x${b.channels}`);
    continue;
  }
  const aFrames = a.data.length / 2 / a.channels;
  const bFrames = b.data.length / 2 / b.channels;

  if (!pad) {
    // Nothing was appended, so there was nothing to take away. Byte-identical
    // is the assertion, not "about the same length": a tool that re-encoded a
    // file to the same duration would pass a duration check having thrown away
    // a generation of quality.
    if (untouched) pass(`${file} — nothing to trim, left byte for byte`);
    else fail(`${file} — rewritten with no tail to remove`);
    continue;
  }

  if (untouched) { fail(`${file} — ${pad}s of appended silence went unnoticed`); continue; }

  // The fixture is the bank file plus silence, and the bank file is what this
  // same tool already produced — so the only right answer is the length it
  // arrived at before, within the frame the cut rounds to. Checked in BOTH
  // directions: the sample comparison below runs over a prefix, and a prefix
  // can never notice a cut that landed early.
  const slack = spfFor(a.rate);
  if (Math.abs(bFrames - aFrames) > slack) {
    const delta = (bFrames - aFrames) / a.rate;
    fail(`${file} — came out ${Math.abs(delta).toFixed(3)}s ${delta > 0 ? 'longer' : 'SHORTER'} than the bank`
      + ` (${(bFrames / a.rate).toFixed(3)}s vs ${(aFrames / a.rate).toFixed(3)}s)`);
    continue;
  }

  // The head is where a dropped LAME tag would show up: the whole waveform
  // slides by the encoder delay and nothing else about the file looks wrong.
  // Comparing from sample zero catches it in the first mismatch.
  //
  // The final frame is excluded — its output is completed by the frame after
  // it, and that is the frame the cut removed, so it is the one place the two
  // decodes may legitimately disagree.
  const compare = Math.max(0, Math.min(aFrames, bFrames) - slack * 2);
  if (compare <= 0) { fail(`${file} — trimmed to ${bFrames} samples, nothing left to compare`); continue; }
  let firstBad = -1;
  for (let i = 0; i < compare * a.channels; i++) {
    if (a.data.readInt16LE(i * 2) !== b.data.readInt16LE(i * 2)) { firstBad = Math.floor(i / a.channels); break; }
  }
  if (firstBad >= 0) {
    fail(`${file} — decoded samples diverge at ${(firstBad / a.rate).toFixed(3)}s`
      + ` of ${(bFrames / a.rate).toFixed(3)}s kept`);
    continue;
  }
  // Sample-exact is not the whole claim. The Xing/LAME header describes a file
  // that just changed length, and afconvert reads its gapless delay without
  // ever validating the checksum that guards it — so a rewrite that left the
  // CRC stale would decode perfectly HERE and lose 26ms to a stricter decoder
  // elsewhere. The header is checked directly instead of inferred.
  const stale = tagFaults(readFileSync(join(subjects, file)));
  if (stale.length) { fail(`${file} — ${stale.join('; ')}`); continue; }

  pass(`${file} — ${pad}s appended, cut back to ${(bFrames / a.rate).toFixed(3)}s`
    + ` (bank has ${(aFrames / a.rate).toFixed(3)}s), sample-exact, header agrees`);
}

rmSync(work, { recursive: true, force: true });

console.log(failures ? `\n  ${failures} failure(s)\n` : '\n  sfx trim: all good\n');
process.exit(failures ? 1 : 0);
