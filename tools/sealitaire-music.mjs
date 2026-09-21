#!/usr/bin/env node
// ============================================================================
// THE MUSIC BAKE — the track's log-frequency FFT response, precomputed into a
// blob the table reads back against the playhead.
//
// Rive's scripting has no FFT and no way to tap the audio engine's output, so
// the analysis happens HERE, once, and the runtime only looks up a frame.
//
//   node tools/sealitaire-music.mjs "/path/to/track.mp3" [--bpm=94]
//
// Writes rive/sealitaire/music.mp3 (a copy — the AudioAsset the table plays),
// rive/sealitaire/music.bin (the analysis and the loop table, a BlobAsset),
// and rive/sealitaire/music/wash-*.flac (see THE WASH below).
//
// THE LOOP TABLE RIDES IN THE SAME BLOB. rive/sealitaire/musicLoops.csv names
// regions of the one track — a start bar, a length in bars, when the table is
// allowed to play them — and they are baked in here rather than shipped as
// their own asset for one reason: a Luau script cannot read a CSV. It reads
// blobs, and music.bin is the blob the music already has. Two blobs that must
// agree about the same track is a join that can go stale; one cannot.
//
// The regions are NOT cut into files. `AudioSound:seek` exists, so the table
// plays one asset and stays inside a region by seeking — which is what makes
// this work from a single bounce with nothing exported twice. `npm run
// sealitaire:loops` is where the regions are measured; this only carries them.
//
// LOG in both axes, because both are how hearing works:
//   - the BANDS are log-spaced from 40 Hz to 12 kHz, so a band is roughly a
//     constant number of octaves wide rather than a constant number of Hz
//     (linear bands put five of eight in the hiss nobody hears as pitch);
//   - the LEVEL is dB, normalised against the track's own quiet and loud
//     percentiles, so a quiet passage still has shape instead of sitting at
//     zero waiting for a chorus.
//
// Each frame also carries FLUX: how much that band rose over its own recent
// mean. Level is where the water sits, flux is where it gets hit. Baking the
// flux rather than differencing levels at runtime keeps it honest — the
// difference is taken at analysis resolution, before the u8 quantisation
// throws away the small rises that a soft track is mostly made of.
//
//   header   char[4] 'SMUS', u32 version, u32 frameCount, f32 frameRate,
//            f32 duration, u32 bandCount, f32 bandHz[bandCount],
//            f32 barSeconds, u32 blockBars, u32 loopCount
//   loops    loopCount x 36 bytes:  char[16] id, f32 startSec, f32 endSec,
//            u8 role, u8 gate, u16 pad, f32 gateN, f32 washSeconds
//   frames   frameCount x bandCount x 2 u8:  level, flux
//
// Decoding is afconvert, which is in macOS — there is no ffmpeg on this
// machine and an mp3 decoder is not worth vendoring for a one-shot bake.
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'rive/sealitaire');

const RATE = 24000;      // mono analysis rate; 12 kHz Nyquist covers the top band
const FFT = 2048;        // 11.7 Hz bins, 85 ms window — enough low-end resolution
const FPS = 60;          // analysis frames per second; hop = RATE / FPS = 400
const BANDS = 8;
const LO_HZ = 40;
const HI_HZ = 12000;

// The normalisation window, as percentiles of the track's own per-band dB.
// Not a fixed dB floor: a fixed floor makes the bake depend on how hot the
// track was mastered, and two songs would need two different sliders.
const QUIET = 0.15;
const LOUD = 0.98;

// ---------------------------------------------------------------------------
// THE LOOP TABLE
//
// Both vocabularies are closed sets, and both are written as numbers into the
// blob rather than strings: the Luau reads an integer and a typo in the CSV
// has to fail HERE, where it can name the row and the column, instead of
// silently matching nothing at runtime and leaving a loop that never plays.
//
// ROLE is when the table reaches for the loop.
//   bed     the deal's music. The beds are a LADDER, not a rotation: the one
//           that plays is the LAST unlocked row, so the table's order is the
//           order the game climbs through them.
//   intro   once, at the start of a deal, before the first bed
//   win     the moment a deal is won — takes over at the next BAR, not at the
//           end of the phrase, because a win should be heard immediately, and
//           then holds until the next deal rather than handing back to a bed
//
// GATE is what has to be true for the loop to be available at all. Every one
// of them is Sealitaire's own play, counted in this session — the table has
// no storage of its own and does not read the run game's unlock ledger.
//
//   open          always
//   deals         games dealt this session ≥ n
//   wins          games won this session ≥ n
//   foundations   cards on the foundations RIGHT NOW ≥ n
//   score         the current deal's score ≥ n
//   moves         moves made in the current deal ≥ n
//
// The last three are state of the DEAL IN PROGRESS, not of the session, so a
// loop gated on one of them arrives as the deal develops and is gone again on
// the next deal. That is the point of having them: the music can grow with a
// game without anything having to be remembered between games.
const ROLES = { bed: 0, intro: 1, win: 2 };
const GATES = { open: 0, deals: 1, wins: 2, foundations: 3, score: 4, moves: 5 };
const ID_BYTES = 16;
const LOOP_BYTES = 36;

// ---------------------------------------------------------------------------
// THE WASH — a loop's ring-out, baked.
//
// "Throw the music into a reverb delay with a long decay" is not something
// the runtime can do. knock.luau says it plainly and it is still true:
// Rive's AudioSound is TRANSPORT AND VOLUME — no pitch, no filter, no send.
// There is no bus to throw anything into.
//
// So the wash is rendered here, once, into its own small asset per loop, and
// the table plays it as a second voice at the instant it cuts the music. That
// is the same answer tools/sealitaire-sfx-fx.mjs already gives for the knock
// bus, and it buys a REAL reverb rather than an impression of one built out
// of the one control there is.
//
// The chain is the one the ask describes, in that order:
//
//   DELAY    a tempo-synced feedback delay. Half a bar, because a whole bar
//            at 94bpm is 2.55s and the repeats stop reading as repeats. This
//            is what makes it sound thrown rather than faded.
//   REVERB   a Schroeder network — four combs into two allpasses. NOT a
//            convolution: the sfx baker convolves because its sounds are a
//            second long, and at ten seconds of input against a six-second
//            impulse the same direct loop is 10^11 multiplies. A recursive
//            network is linear in the input and is what a long decay is
//            actually made of.
//   DARKEN   the feedback path loses its top on every pass, so the tail goes
//            from the music's colour to a hum, which is what a long decay
//            does in a real room and what stops it sounding like a stuck
//            loop played quietly.
//
// Only the TAIL is kept — the output from the moment the dry input stops. The
// table cuts the music at the bar line and starts this at the same instant,
// so the wash must begin where the music ended, not replay it.
//
// 32 kHz, matching the sfx bank: after the darkening there is nothing above
// 10 kHz in it, and the three washes are 2 MB at this rate instead of 3.
const WASH_RATE = 32000;
const WASH_DELAY_BARS = 0.5;
const WASH_FEEDBACK = 0.55;   // the delay's, per repeat
// How far under the bar it follows a wash opens. A SEND level: one number
// for every loop, so the effect is one room. -10dB is the usual place for a
// throw — present, clearly the music, clearly behind it. `musicWash` in
// tuning.luau scales it live from there.
const WASH_SEND_DB = -10;
const WASH_FIRST_ID = 2400;   // scene.rml asset ids; the bank ends at 2099

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------
function decodeMono(src) {
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-music-'));
    const wav = join(tmp, 'mono.wav');
    try {
        execFileSync('/usr/bin/afconvert', [
            '-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', src, wav,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        const buf = readFileSync(wav);
        // Walk the RIFF chunks rather than assuming a 44-byte header:
        // afconvert writes a FLLR padding chunk before `data` often enough
        // that a fixed offset decodes the padding as audio and the whole
        // analysis comes out shifted by a fraction of a second.
        let at = 12;
        while (at + 8 <= buf.length) {
            const id = buf.toString('ascii', at, at + 4);
            const size = buf.readUInt32LE(at + 4);
            if (id === 'data') {
                const n = Math.min(size, buf.length - at - 8) >> 1;
                const out = new Float32Array(n);
                for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(at + 8 + i * 2) / 32768;
                return out;
            }
            at += 8 + size + (size & 1);
        }
        throw new Error('no data chunk in the decoded wav');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// FFT — iterative radix-2, in place, on split real/imag arrays.
// ---------------------------------------------------------------------------
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const ar = re[i + k], ai = im[i + k];
                const br = re[i + k + len / 2], bi = im[i + k + len / 2];
                const tr = br * cr - bi * ci;
                const ti = br * ci + bi * cr;
                re[i + k] = ar + tr; im[i + k] = ai + ti;
                re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stereo decode, at whatever rate is asked for. Separate from decodeMono
// above because the analysis wants one channel at 24 kHz and the wash wants
// two at 32 kHz, and sharing one decode would make one of them wrong.
// ---------------------------------------------------------------------------
function decodeStereo(src, rate) {
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-wash-'));
    const wav = join(tmp, 'st.wav');
    try {
        execFileSync('/usr/bin/afconvert', [
            '-f', 'WAVE', '-d', `LEI16@${rate}`, '-c', '2', src, wav,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        const buf = readFileSync(wav);
        let at = 12;
        while (at + 8 <= buf.length) {
            const id = buf.toString('ascii', at, at + 4);
            const size = buf.readUInt32LE(at + 4);
            if (id === 'data') {
                const n = Math.min(size, buf.length - at - 8) >> 2;
                const l = new Float32Array(n), r = new Float32Array(n);
                for (let i = 0; i < n; i++) {
                    l[i] = buf.readInt16LE(at + 8 + i * 4) / 32768;
                    r[i] = buf.readInt16LE(at + 8 + i * 4 + 2) / 32768;
                }
                return [l, r];
            }
            at += 8 + size + (size & 1);
        }
        throw new Error('no data chunk in the decoded wav');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// A feedback delay, in place, over a buffer already padded with the tail's
// worth of silence. `repeats` is bounded rather than run to the noise floor:
// at 0.55 feedback the eighth repeat is -47dB and the reverb behind it has
// long since taken over.
function feedbackDelay(x, samples, feedback, repeats = 8) {
    for (let r = 1; r <= repeats; r++) {
        const g = Math.pow(feedback, r);
        const at = samples * r;
        if (at >= x.length || g < 1e-4) break;
        for (let i = 0; i + at < x.length; i++) x[i + at] += x[i] * g;
    }
    return x;
}

// A Schroeder reverb: four parallel combs into two series allpasses, with a
// one-pole lowpass inside each comb's feedback so the tail darkens as it
// decays. The delay lengths are the classic mutually-prime-ish set, scaled to
// the rate and nudged per channel so the two sides decorrelate — a reverb
// with identical channels is a mono reverb and collapses to the middle.
function schroeder(x, rate, rt60, spread) {
    const COMBS = [1116, 1188, 1277, 1356];
    const ALLPASS = [556, 441];
    const scale = (rate / 44100) * spread;
    const out = new Float32Array(x.length);
    for (const len of COMBS) {
        const n = Math.max(1, Math.round(len * scale));
        // The feedback that gives this comb the asked-for RT60: -60dB over
        // rt60 seconds, in steps of the comb's own delay.
        const g = Math.pow(10, (-3 * (n / rate)) / rt60);
        // THE INPUT IS SCALED BY (1 - g), AND THAT IS NOT A DETAIL. A comb
        // with feedback g has a steady-state gain of 1/(1-g); at the 0.9994
        // an eight-second decay needs, that is +64 dB. Fed a minute of music
        // it pins the ceiling, every wash renders at -0.4 dBFS whatever it
        // was made from, and the quiet loop's ring-out comes back as loud as
        // the loud one's — which is exactly what the first bake did.
        const drive = 1 - g;
        const buf = new Float32Array(n);
        let z = 0, at = 0;
        for (let i = 0; i < x.length; i++) {
            const y = buf[at];
            out[i] += y;
            // The damping: each pass round the comb loses a little more top.
            z += (y - z) * 0.38;
            buf[at] = x[i] * drive + z * g;
            at = at + 1 === n ? 0 : at + 1;
        }
    }
    for (let i = 0; i < out.length; i++) out[i] *= 0.25;
    for (const len of ALLPASS) {
        const n = Math.max(1, Math.round(len * scale));
        const buf = new Float32Array(n);
        let at = 0;
        for (let i = 0; i < out.length; i++) {
            const bufOut = buf[at];
            const v = out[i];
            buf[at] = v + bufOut * 0.5;
            out[i] = bufOut - v * 0.5;
            at = at + 1 === n ? 0 : at + 1;
        }
    }
    return out;
}

// One loop's ring-out, as interleaved 16-bit stereo.
function renderWash(chans, loop, rate, barSeconds, seconds) {
    const from = Math.round(loop.startSec * rate);
    const to = Math.min(chans[0].length, Math.round(loop.endSec * rate));
    const tail = Math.round(seconds * rate);
    const dry = to - from;
    const delaySamples = Math.max(1, Math.round(barSeconds * WASH_DELAY_BARS * rate));
    const sides = [];
    for (let c = 0; c < 2; c++) {
        const x = new Float32Array(dry + tail);
        x.set(chans[c].subarray(from, to));
        feedbackDelay(x, delaySamples, WASH_FEEDBACK);
        // Slightly different networks per side. 1.0 and 1.037 is about a
        // 3% length difference — enough to decorrelate, small enough that
        // the two sides are the same room.
        sides.push(schroeder(x, rate, seconds, c === 0 ? 1.0 : 1.037));
    }
    // Keep only what rings out AFTER the music stops.
    const out = new Int16Array(tail * 2);
    const fadeIn = Math.round(0.005 * rate);        // kill the splice click
    const fadeOut = Math.round(0.25 * rate);        // and end on true zero
    let peak = 0;
    for (let c = 0; c < 2; c++) {
        for (let i = 0; i < tail; i++) peak = Math.max(peak, Math.abs(sides[c][dry + i]));
    }
    // THE SEND IS A RATIO, SO IT IS MEASURED AND CORRECTED HERE.
    //
    // Not normalised to a peak — that would make a quiet loop's ring-out as
    // loud as the loud one's. But not left raw either: how hard a reverb
    // network rings depends on the material's density and spectrum, not only
    // its level, and raw these three open between 8 and 20 dB under the bar
    // they follow. A real send is one gain for everything, so the wet/dry
    // ratio is the SAME for every loop — that constant is what makes the
    // effect read as one room rather than as three different reverbs.
    //
    // So: measure this wash's opening second against the dry bar it follows,
    // and put it where a send would have. The ratio is the spec; the gain
    // that achieves it is arithmetic.
    const second = Math.min(tail, rate);
    const back = Math.min(dry, rate);
    let raw = 0, dryRms = 0;
    for (let c = 0; c < 2; c++) {
        for (let i = 0; i < second; i++) raw += sides[c][dry + i] ** 2;
        for (let i = dry - back; i < dry; i++) dryRms += (chans[c][from + i] ?? 0) ** 2;
    }
    raw = Math.sqrt(raw / (2 * second));
    dryRms = Math.sqrt(dryRms / (2 * back));
    const target = dryRms * Math.pow(10, WASH_SEND_DB / 20);
    let gain = raw > 1e-9 ? target / raw : 1;
    // And a ceiling, in case the correction asked for more than there is
    // headroom for. The ratio gives way to not clipping, and the caller
    // prints what it actually got.
    if (peak * gain > 0.95) gain = 0.95 / peak;
    const wet = raw * gain;
    for (let i = 0; i < tail; i++) {
        let env = gain;
        if (i < fadeIn) env *= i / fadeIn;
        if (i > tail - fadeOut) env *= (tail - i) / fadeOut;
        for (let c = 0; c < 2; c++) {
            const v = Math.max(-1, Math.min(1, sides[c][dry + i] * env));
            out[i * 2 + c] = Math.round(v * 32767);
        }
    }
    return { pcm: out, peak: peak * gain, wet, dry: dryRms };
}

function writeFlac(dir, name, pcm, rate) {
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-wash-out-'));
    const wav = join(tmp, 'w.wav');
    try {
        const bytes = pcm.length * 2;
        const head = Buffer.alloc(44);
        head.write('RIFF', 0, 'ascii');
        head.writeUInt32LE(36 + bytes, 4);
        head.write('WAVEfmt ', 8, 'ascii');
        head.writeUInt32LE(16, 16);
        head.writeUInt16LE(1, 20);
        head.writeUInt16LE(2, 22);
        head.writeUInt32LE(rate, 24);
        head.writeUInt32LE(rate * 4, 28);
        head.writeUInt16LE(4, 32);
        head.writeUInt16LE(16, 34);
        head.write('data', 36, 'ascii');
        head.writeUInt32LE(bytes, 40);
        writeFileSync(wav, Buffer.concat([head, Buffer.from(pcm.buffer, pcm.byteOffset, bytes)]));
        const out = join(dir, `${name}.flac`);
        execFileSync('/usr/bin/afconvert', ['-f', 'flac', '-d', 'flac', wav, out],
            { stdio: ['ignore', 'ignore', 'pipe'] });
        return statSync(out).size;
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// musicLoops.csv → loop records. Every failure here is fatal and names the
// row: a loop table is small, hand-edited, and read by a runtime that has no
// way to complain, so the last chance to catch a bad row is this function.
// ---------------------------------------------------------------------------
function readLoops(path, barSeconds, duration) {
    if (!existsSync(path)) {
        console.log('sealitaire-music: no musicLoops.csv — the whole track is one loop');
        return [];
    }
    const text = readFileSync(path, 'utf8');
    // Quoted cells: the notes column holds commas. Nothing else in this file
    // needs a real CSV parser, and one row parsed wrong is a wrong offset.
    const lines = text.split('\n').filter((l) => l.trim().length);
    const split = (line) => {
        const out = [];
        let cell = '', quoted = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (quoted) {
                if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
                else if (c === '"') quoted = false;
                else cell += c;
            } else if (c === '"') quoted = true;
            else if (c === ',') { out.push(cell); cell = ''; }
            else cell += c;
        }
        out.push(cell);
        return out;
    };
    const head = split(lines[0]).map((h) => h.trim());
    const need = ['id', 'startBar', 'bars', 'role', 'gate', 'gateN'];
    for (const col of need) {
        if (!head.includes(col)) throw new Error(`musicLoops.csv has no "${col}" column`);
    }
    const loops = [];
    const seen = new Set();
    for (let i = 1; i < lines.length; i++) {
        const cells = split(lines[i]);
        const row = {};
        head.forEach((h, k) => { row[h] = (cells[k] ?? '').trim(); });
        const where = `musicLoops.csv row ${i + 1} ("${row.id}")`;
        if (!row.id) throw new Error(`${where}: no id`);
        if (seen.has(row.id)) throw new Error(`${where}: duplicate id`);
        // The id is the only string that crosses into the blob, and it goes
        // into a fixed 16 bytes. Truncating one silently would collide two
        // rows whose first sixteen characters match.
        if (Buffer.byteLength(row.id, 'utf8') > ID_BYTES - 1) {
            throw new Error(`${where}: id is longer than ${ID_BYTES - 1} bytes`);
        }
        seen.add(row.id);
        const startBar = Number(row.startBar), bars = Number(row.bars), gateN = Number(row.gateN || 0);
        if (!Number.isFinite(startBar) || startBar < 0) throw new Error(`${where}: startBar "${row.startBar}"`);
        if (!Number.isFinite(bars) || bars <= 0) throw new Error(`${where}: bars "${row.bars}"`);
        if (!Number.isFinite(gateN)) throw new Error(`${where}: gateN "${row.gateN}"`);
        if (!(row.role in ROLES)) {
            throw new Error(`${where}: role "${row.role}" — one of ${Object.keys(ROLES).join(', ')}`);
        }
        if (!(row.gate in GATES)) {
            throw new Error(`${where}: gate "${row.gate}" — one of ${Object.keys(GATES).join(', ')}`);
        }
        const startSec = startBar * barSeconds;
        const endSec = (startBar + bars) * barSeconds;
        // A region past the end of the file seeks to somewhere that does not
        // exist; the sound simply completes and the loop is never heard. A
        // millisecond of slack, because the last bar of a bounce is routinely
        // a sample or two short of the arithmetic.
        if (endSec > duration + 0.001) {
            throw new Error(
                `${where}: bars ${startBar}-${startBar + bars} end at ${endSec.toFixed(3)}s, ` +
                `past the track's ${duration.toFixed(3)}s`
            );
        }
        const washSeconds = Number(row.washSeconds || 0);
        if (!Number.isFinite(washSeconds) || washSeconds < 0) {
            throw new Error(`${where}: washSeconds "${row.washSeconds}"`);
        }
        loops.push({
            id: row.id, startSec, endSec, startBar, bars,
            role: ROLES[row.role], gate: GATES[row.gate], gateN, washSeconds,
        });
    }
    const beds = loops.filter((l) => l.role === ROLES.bed);
    if (!beds.length) {
        throw new Error('musicLoops.csv has no row with role "bed" — nothing would play');
    }
    // A bed that no amount of play can unlock is a row that reads as working
    // and never makes a sound. `open` is the only gate guaranteed reachable
    // from a standing start, so at least one bed must carry it — and it must
    // be the FIRST, because the ladder plays the last unlocked rung and an
    // open bed below a gated one would be the rung nothing ever came back to.
    if (beds[0].gate !== GATES.open) {
        throw new Error(
            `musicLoops.csv: the first bed ("${beds[0].id}") is gated. ` +
            `The beds are a ladder and the bottom rung has to be reachable from a standing start.`
        );
    }
    // THE LADDER HAS TO CLIMB. Consecutive beds on the same gate must ask for
    // more, not less: a rung whose threshold is below the one under it is
    // unlocked at the same moment and is simply never the LAST unlocked row,
    // so it never plays and nothing else can tell you that.
    for (let i = 1; i < beds.length; i++) {
        const a = beds[i - 1], b = beds[i];
        if (b.gate === a.gate && b.gateN <= a.gateN) {
            throw new Error(
                `musicLoops.csv: bed "${b.id}" asks for ${b.gate === GATES.open ? 'nothing' : b.gateN} ` +
                `and sits below "${a.id}" which asks for ${a.gateN}. A ladder rung that opens no later ` +
                `than the one beneath it can never be the one playing.`
            );
        }
    }
    return loops;
}

// ---------------------------------------------------------------------------
// The washes, and the <AudioAsset> lines that make them reachable. Pruning is
// part of it: a renamed row leaves its old .flac on disk and in the scene,
// and an asset nobody plays is dead weight in a 22 MB file.
// ---------------------------------------------------------------------------
function bakeWashes(src, loops, barSeconds) {
    const dir = join(DEST, 'music');
    const want = loops.filter((l) => l.washSeconds > 0);
    mkdirSync(dir, { recursive: true });
    const names = new Set(want.map((l) => `wash-${l.id}`));
    for (const f of readdirSync(dir)) {
        if (f.endsWith('.flac') && !names.has(f.slice(0, -5))) {
            rmSync(join(dir, f));
            console.log(`  pruned music/${f} — no row wants it any more`);
        }
    }
    if (want.length) {
        const chans = decodeStereo(src, WASH_RATE);
        for (const l of want) {
            const { pcm, peak, wet, dry } = renderWash(chans, l, WASH_RATE, barSeconds, l.washSeconds);
            const bytes = writeFlac(dir, `wash-${l.id}`, pcm, WASH_RATE);
            const db = (v) => (20 * Math.log10(v + 1e-12)).toFixed(1);
            console.log(
                `  wash-${l.id.padEnd(11)} ${l.washSeconds}s ring-out, peak ${db(peak)} dBFS, ` +
                `opens ${db(wet / (dry || 1))} dB under the bar it follows, ${(bytes / 1024).toFixed(0)} KB`
            );
        }
    }
    // scene.rml, between markers, exactly as the sfx bakers do it.
    const ids = [...names].sort();
    const scene = readFileSync(join(DEST, 'scene.rml'), 'utf8');
    const block = [
        '    <!-- MUSIC WASH: generated by tools/sealitaire-music.mjs from musicLoops.csv; do not hand-edit -->',
        ...ids.map((id, k) => `    <AudioAsset file="music/${id}.flac" name="${id}" id="0:${WASH_FIRST_ID + k}"/>`),
        '    <!-- /MUSIC WASH -->',
    ].join('\n');
    const re = /    <!-- MUSIC WASH:[\s\S]*?<!-- \/MUSIC WASH -->/;
    let next;
    if (re.test(scene)) {
        next = scene.replace(re, block);
    } else {
        const anchor = scene.indexOf('    <AudioAsset file="music.mp3"');
        const eol = scene.indexOf('\n', anchor);
        next = scene.slice(0, eol + 1) + block + '\n' + scene.slice(eol + 1);
    }
    if (next !== scene) writeFileSync(join(DEST, 'scene.rml'), next);
    return ids.length;
}

function percentile(values, p) {
    const s = Float64Array.from(values).sort();
    if (s.length === 0) return 0;
    const at = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[at];
}

// ---------------------------------------------------------------------------
function main() {
    const args = process.argv.slice(2);
    const src = args.find((a) => !a.startsWith('--'));
    if (!src) {
        console.error('usage: node tools/sealitaire-music.mjs <track.mp3> [--bpm=94] [--beats=4]');
        process.exit(1);
    }
    const num = (name, dflt) => {
        const hit = args.find((a) => a.startsWith(`--${name}=`));
        return hit === undefined ? dflt : Number(hit.slice(name.length + 3));
    };
    const bpm = num('bpm', 0);
    const beats = num('beats', 4);
    const blockBars = num('block', 4);
    // No tempo means no bar, and a loop table measured in bars cannot be
    // turned into seconds without one. Refuse rather than guess — a wrong bar
    // puts every region a little off the downbeat, which is the one error
    // here that sounds like the music rather than like a bug.
    if (!bpm && existsSync(join(DEST, 'musicLoops.csv'))) {
        console.error('sealitaire-music: musicLoops.csv is in bars, so --bpm is required');
        process.exit(1);
    }
    const barSeconds = bpm ? (beats * 60) / bpm : 0;

    const pcm = decodeMono(src);
    const duration = pcm.length / RATE;
    const loops = readLoops(join(DEST, 'musicLoops.csv'), barSeconds, duration);
    const hop = Math.round(RATE / FPS);
    const frameCount = Math.max(1, Math.floor((pcm.length - FFT) / hop) + 1);
    console.log(`sealitaire-music: ${duration.toFixed(2)}s, ${frameCount} frames at ${FPS}Hz`);

    // Hann window, and the log-spaced band edges as bin indices.
    const win = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));

    const edgeHz = [];
    for (let k = 0; k <= BANDS; k++) {
        edgeHz.push(LO_HZ * Math.pow(HI_HZ / LO_HZ, k / BANDS));
    }
    const binOf = (hz) => Math.round((hz * FFT) / RATE);
    const edges = edgeHz.map(binOf);
    // A log low edge is only a bin or two wide down here; widen so the lowest
    // band is not one bin's worth of noise standing in for the whole bass.
    for (let k = 0; k < BANDS; k++) {
        if (edges[k + 1] <= edges[k]) edges[k + 1] = edges[k] + 1;
    }
    const centreHz = [];
    for (let k = 0; k < BANDS; k++) centreHz.push(Math.sqrt(edgeHz[k] * edgeHz[k + 1]));

    // Pass 1: dB per band per frame.
    const db = [];
    for (let k = 0; k < BANDS; k++) db.push(new Float64Array(frameCount));
    const re = new Float64Array(FFT);
    const im = new Float64Array(FFT);
    for (let f = 0; f < frameCount; f++) {
        const at = f * hop;
        for (let i = 0; i < FFT; i++) {
            re[i] = (pcm[at + i] || 0) * win[i];
            im[i] = 0;
        }
        fft(re, im);
        for (let k = 0; k < BANDS; k++) {
            let sum = 0;
            const a = edges[k], b = Math.min(edges[k + 1], FFT / 2);
            for (let bin = a; bin < b; bin++) sum += re[bin] * re[bin] + im[bin] * im[bin];
            // Mean power, not total: otherwise a band's loudness is mostly a
            // report of how many bins it happens to span, and log spacing
            // means the top band spans two hundred times the bottom one's.
            const mean = sum / Math.max(1, b - a);
            db[k][f] = 10 * Math.log10(mean + 1e-12);
        }
    }

    // Pass 2: normalise each band against its own percentiles, then the flux
    // against a 250 ms trailing mean of the normalised level.
    const level = [];
    const flux = [];
    const MEAN_FRAMES = Math.round(FPS * 0.25);
    for (let k = 0; k < BANDS; k++) {
        const lo = percentile(db[k], QUIET);
        const hi = percentile(db[k], LOUD);
        const span = Math.max(1e-3, hi - lo);
        const lv = new Float64Array(frameCount);
        for (let f = 0; f < frameCount; f++) {
            lv[f] = Math.min(1, Math.max(0, (db[k][f] - lo) / span));
        }
        const fx = new Float64Array(frameCount);
        let mean = lv[0];
        for (let f = 0; f < frameCount; f++) {
            fx[f] = Math.max(0, lv[f] - mean);
            mean += (lv[f] - mean) / MEAN_FRAMES;
        }
        // Each band's flux gets its own scale for the same reason its level
        // does: a hi-hat's rises and a bass note's rises are not the same size
        // and a shared scale would give the water one band and seven silences.
        const peak = Math.max(1e-3, percentile(fx, 0.995));
        for (let f = 0; f < frameCount; f++) fx[f] = Math.min(1, fx[f] / peak);
        level.push(lv);
        flux.push(fx);
        console.log(
            `  band ${k} ${centreHz[k].toFixed(0).padStart(6)}Hz  ` +
            `${edgeHz[k].toFixed(0)}-${edgeHz[k + 1].toFixed(0)}Hz  ` +
            `bins ${edges[k]}-${edges[k + 1]}  ${lo.toFixed(1)}..${hi.toFixed(1)} dB  ` +
            `flux peak ${peak.toFixed(3)}`
        );
    }

    // Write.
    const headBytes = 4 + 4 + 4 + 4 + 4 + 4 + BANDS * 4 + 4 + 4 + 4;
    const out = Buffer.alloc(headBytes + loops.length * LOOP_BYTES + frameCount * BANDS * 2);
    out.write('SMUS', 0, 'ascii');
    out.writeUInt32LE(3, 4);
    out.writeUInt32LE(frameCount, 8);
    out.writeFloatLE(FPS, 12);
    out.writeFloatLE(duration, 16);
    out.writeUInt32LE(BANDS, 20);
    for (let k = 0; k < BANDS; k++) out.writeFloatLE(centreHz[k], 24 + k * 4);
    out.writeFloatLE(barSeconds, 24 + BANDS * 4);
    // The BLOCK: the cell the bounce is built out of, four bars here. It is
    // the quantum an escalation waits for — a bed change at the next bar is
    // twitchy and at the end of a forty-bar phrase is a minute late, and the
    // grid the music was written on is the one that is neither.
    out.writeUInt32LE(blockBars, 28 + BANDS * 4);
    out.writeUInt32LE(loops.length, 32 + BANDS * 4);
    const ROLE_NAME = Object.keys(ROLES);
    const GATE_NAME = Object.keys(GATES);
    for (let i = 0; i < loops.length; i++) {
        const l = loops[i];
        const o = headBytes + i * LOOP_BYTES;
        out.write(l.id, o, ID_BYTES - 1, 'utf8');   // the 16th byte stays 0: the terminator
        out.writeFloatLE(l.startSec, o + ID_BYTES);
        out.writeFloatLE(l.endSec, o + ID_BYTES + 4);
        out[o + ID_BYTES + 8] = l.role;
        out[o + ID_BYTES + 9] = l.gate;
        out.writeFloatLE(l.gateN, o + ID_BYTES + 12);
        out.writeFloatLE(l.washSeconds, o + ID_BYTES + 16);
        console.log(
            `  loop ${l.id.padEnd(12)} bar ${String(l.startBar).padStart(4)} +${String(l.bars).padStart(3)}  ` +
            `${l.startSec.toFixed(3).padStart(8)}s-${l.endSec.toFixed(3).padStart(8)}s  ` +
            `${ROLE_NAME[l.role].padEnd(6)} ${GATE_NAME[l.gate]}${l.gate ? ` ≥ ${l.gateN}` : ''}` +
            `${l.washSeconds ? `  wash ${l.washSeconds}s` : ''}`
        );
    }
    let at = headBytes + loops.length * LOOP_BYTES;
    for (let f = 0; f < frameCount; f++) {
        for (let k = 0; k < BANDS; k++) {
            out[at++] = Math.round(level[k][f] * 255);
            out[at++] = Math.round(flux[k][f] * 255);
        }
    }
    writeFileSync(join(DEST, 'music.bin'), out);
    copyFileSync(src, join(DEST, 'music.mp3'));
    const washes = bakeWashes(src, loops, barSeconds);
    console.log(
        `sealitaire-music: music.bin ${(out.length / 1024).toFixed(1)} KB ` +
        `(${loops.length} loops, ${washes} washes), music.mp3 copied`
    );
}

main();
