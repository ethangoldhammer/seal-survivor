#!/usr/bin/env node
// ============================================================================
// WHERE THE LOOPS ARE — one long bounce, measured against its own bar grid and
// cut into named regions, so nothing has to be exported twice.
//
//   node tools/sealitaire-loops.mjs <track> --bpm=94 [--bars=4] [--write]
//
// The track Ethan hands over is a single file with the loops laid end to end.
// Nobody is going to re-export twenty-six stems, and nobody should have to:
// the loops are already there, at known bar offsets, and the runtime can seek.
// `AudioSound:seek` and `:seekFrame` exist in Rive's scripting API — an older
// comment in table.luau says `Audio.play` is the whole of it, and that has not
// been true for a while. So a "loop" here is a START and a LENGTH in bars
// against one asset, never a file of its own.
//
// WHAT IS MEASURED, and why each one is needed:
//
//   THE GRID     bpm and a bar count give a block length in seconds; the
//                track's duration divided by it should be a whole number. If
//                it is not, every offset below is built on a wrong bar and
//                the report says so instead of printing plausible numbers.
//
//   NOVELTY      three things that each move at a section change and none of
//                which moves alone reliably:
//                  * the RHYTHM — the block's onset envelope over 32 steps,
//                    compared with the previous block's. A new groove shows
//                    here and nowhere else.
//                  * the BAND PROFILE — eight log bands, level-normalised, so
//                    it reads "the highs came in" rather than "it got louder".
//                  * the LEVEL — plain RMS in dB. An arrangement that drops to
//                    a pad is a section change even when the groove survives.
//                Summed, because on this track each one alone puts a boundary
//                somewhere wrong: rhythm alone calls every fill a section,
//                level alone misses a same-loudness instrument swap.
//
//   REPEATS      raw sample correlation between every pair of blocks, at zero
//                lag. This is the one measurement that answers a question
//                nothing else can: whether two blocks are the SAME RECORDING.
//                Spectral similarity cannot — a whole track in one key on one
//                kit reads as 0.99 similar everywhere, which is how a first
//                pass at this concluded there were no repeats at all. Raw
//                correlation is blunt and honest: above ~0.7 at zero lag is
//                the same performance, and on this bounce it found that the
//                loud last section is a sixteen-bar loop STATED TWICE, not
//                eight separate cells.
//
// The report is the point; `--write` only seeds musicLoops.csv with the
// sections it found, once, and refuses to clobber a file Ethan has since
// edited. The table is his after that — this tool never gets to move a row he
// placed by ear.
//
// Decoding is afconvert, which is in macOS. There is no ffmpeg on this
// machine, and the sibling bake (sealitaire-music.mjs) already made this call.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = join(ROOT, 'rive/sealitaire/musicLoops.csv');

const RATE = 24000;   // mono analysis rate, as the bake uses
const FFT = 2048;
const HOP = 512;      // 46.9 Hz of frames — fine enough to place an onset
const BANDS = 8;
const LO_HZ = 40;
const HI_HZ = 11500;
const STEPS = 32;     // rhythm-envelope resolution across one block

// A boundary is called when the summed novelty clears this. Read off the
// track's own distribution rather than picked: on Sealitaire_Loops the four
// real changes score 0.72, 0.89, 1.63 and 2.00, and the loudest thing that is
// not a change scores 0.365 — a clean factor of two, so anywhere in that gap
// gives the same five sections. Printed with the report, because a future
// track with no such gap makes this a judgement call and should look like one.
const BOUNDARY = 0.40;

// Two blocks above this, correlated raw at zero lag, are the same take.
const SAME_TAKE = 0.70;

// ---------------------------------------------------------------------------
// Decode. Mono, because every measurement here is about time and spectrum and
// none is about the stereo field.
// ---------------------------------------------------------------------------
function decodeMono(src) {
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-loops-'));
    const wav = join(tmp, 'mono.wav');
    try {
        execFileSync('/usr/bin/afconvert', [
            '-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', src, wav,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        const buf = readFileSync(wav);
        // Walk the chunks. afconvert writes an FLLR padding chunk before
        // `data` often enough that a fixed 44-byte offset decodes the padding
        // as audio and every offset below comes out shifted.
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

function unit(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) + 1e-12;
    return v.map((x) => x / n);
}

function dot(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += a[i] * b[i];
    return d;
}

// ---------------------------------------------------------------------------
// The analysis: one pass of FFT frames, then everything folded onto blocks.
// ---------------------------------------------------------------------------
function analyse(pcm, blockSamples, blocks) {
    const win = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));

    const edgeHz = [];
    for (let k = 0; k <= BANDS; k++) edgeHz.push(LO_HZ * Math.pow(HI_HZ / LO_HZ, k / BANDS));
    const edges = edgeHz.map((hz) => Math.max(1, Math.round((hz * FFT) / RATE)));
    for (let k = 0; k < BANDS; k++) if (edges[k + 1] <= edges[k]) edges[k + 1] = edges[k] + 1;

    const hops = Math.max(1, Math.floor((pcm.length - FFT) / HOP));
    const bandDb = [];
    const flux = new Float64Array(hops);
    const re = new Float64Array(FFT);
    const im = new Float64Array(FFT);
    let prev = null;
    for (let h = 0; h < hops; h++) {
        const at = h * HOP;
        for (let i = 0; i < FFT; i++) {
            re[i] = (pcm[at + i] || 0) * win[i];
            im[i] = 0;
        }
        fft(re, im);
        const half = FFT / 2;
        const mag = new Float64Array(half);
        for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
        const row = new Float64Array(BANDS);
        for (let k = 0; k < BANDS; k++) {
            let sum = 0;
            const a = edges[k], b = Math.min(edges[k + 1], half);
            for (let bin = a; bin < b; bin++) sum += mag[bin] * mag[bin];
            row[k] = 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12);
        }
        bandDb.push(row);
        // Spectral flux: the RISES only. A fall is the note ending and is not
        // an onset; counting it puts a phantom beat at every release.
        let f = 0;
        if (prev) for (let k = 0; k < half; k++) { const d = mag[k] - prev[k]; if (d > 0) f += d; }
        flux[h] = f;
        prev = mag;
    }

    const hopsPerBlock = blockSamples / HOP;
    const out = [];
    for (let b = 0; b < blocks; b++) {
        const h0 = Math.floor((b * blockSamples) / HOP);
        const h1 = Math.min(hops, Math.ceil(((b + 1) * blockSamples) / HOP));
        const band = new Float64Array(BANDS);
        for (let h = h0; h < h1; h++) for (let k = 0; k < BANDS; k++) band[k] += bandDb[h][k];
        for (let k = 0; k < BANDS; k++) band[k] /= Math.max(1, h1 - h0);

        const rhythm = new Float64Array(STEPS);
        for (let h = h0; h < h1; h++) {
            const s = Math.min(STEPS - 1, Math.floor(((h - h0) / hopsPerBlock) * STEPS));
            rhythm[s] = Math.max(rhythm[s], flux[h]);
        }

        const s0 = b * blockSamples;
        const s1 = Math.min(pcm.length, s0 + blockSamples);
        let q = 0, peak = 0;
        for (let i = s0; i < s1; i++) {
            const v = pcm[i];
            q += v * v;
            if (Math.abs(v) > peak) peak = Math.abs(v);
        }
        out.push({
            band: unit([...band]),
            rhythm: unit([...rhythm]),
            rms: 20 * Math.log10(Math.sqrt(q / Math.max(1, s1 - s0)) + 1e-12),
            peak: 20 * Math.log10(peak + 1e-12),
        });
    }
    return out;
}

// Raw-sample correlation at zero lag. Strided: at 24 kHz every seventh sample
// is still forty thousand points per pair, which is far more than enough to
// separate "the same take" from "the same instruments".
function takeCorr(pcm, a0, b0, n) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i += 7) {
        const x = pcm[a0 + i] || 0, y = pcm[b0 + i] || 0;
        d += x * y; na += x * x; nb += y * y;
    }
    return d / Math.sqrt(na * nb + 1e-20);
}

// ---------------------------------------------------------------------------
function main() {
    const args = process.argv.slice(2);
    const src = args.find((a) => !a.startsWith('--'));
    const flag = (name, dflt) => {
        const hit = args.find((a) => a.startsWith(`--${name}=`));
        return hit === undefined ? dflt : Number(hit.slice(name.length + 3));
    };
    if (!src) {
        console.error('usage: node tools/sealitaire-loops.mjs <track> --bpm=94 [--bars=4] [--write]');
        process.exit(1);
    }
    const bpm = flag('bpm', 0);
    const barsPer = flag('bars', 4);
    const beats = flag('beats', 4);      // beats in a bar; 4/4 unless told otherwise
    const write = args.includes('--write');
    if (!bpm) {
        console.error('--bpm is required: nothing here can measure a tempo, only check one');
        process.exit(1);
    }

    const pcm = decodeMono(src);
    const duration = pcm.length / RATE;
    const barSec = (beats * 60) / bpm;
    const blockSec = barSec * barsPer;
    const blockSamples = Math.round(blockSec * RATE);
    const exact = duration / blockSec;
    const blocks = Math.round(exact);
    const slipMs = (exact - blocks) * blockSec * 1000;

    console.log(`sealitaire-loops: ${src}`);
    console.log(`  ${duration.toFixed(3)}s at ${bpm} bpm — bar ${barSec.toFixed(6)}s, ` +
        `${barsPer}-bar block ${blockSec.toFixed(6)}s`);
    console.log(`  ${exact.toFixed(4)} blocks → ${blocks}, off by ${slipMs.toFixed(1)}ms`);
    // A bounce that is a whole number of blocks to within a millisecond is on
    // the grid. More than that and the last block's offset is wrong by more
    // than a sample-accurate seek can hide, and so is every section below it.
    if (Math.abs(slipMs) > 1) {
        console.log(`  ⚠ NOT a whole number of ${barsPer}-bar blocks. Either the bpm is not ` +
            `${bpm}, the bar is not ${beats} beats, or the bounce has a head/tail. ` +
            `Every offset below is suspect.`);
    }

    const f = analyse(pcm, blockSamples, blocks);

    // Novelty per boundary.
    const novelty = [0];
    for (let b = 1; b < blocks; b++) {
        const dR = 1 - dot(f[b].rhythm, f[b - 1].rhythm);
        const dB = 1 - dot(f[b].band, f[b - 1].band);
        const dL = Math.abs(f[b].rms - f[b - 1].rms) / 20;
        novelty.push(dR + dB + dL);
    }

    console.log(`\n  blk    bar     start      rms    peak   novelty`);
    for (let b = 0; b < blocks; b++) {
        const mark = b > 0 && novelty[b] >= BOUNDARY ? '  ← section' : '';
        console.log(
            `  ${String(b).padStart(3)}  ${String(b * barsPer).padStart(5)}  ` +
            `${(b * blockSec).toFixed(3).padStart(8)}  ` +
            `${f[b].rms.toFixed(1).padStart(7)} ${f[b].peak.toFixed(1).padStart(7)}  ` +
            `${b === 0 ? '      -' : novelty[b].toFixed(3).padStart(7)}${mark}`
        );
    }

    // Same-take pairs.
    const same = [];
    for (let a = 0; a < blocks; a++) {
        for (let b = a + 1; b < blocks; b++) {
            const c = takeCorr(pcm, a * blockSamples, b * blockSamples, blockSamples);
            if (c >= SAME_TAKE) same.push([a, b, c]);
        }
    }
    console.log(`\n  same take (raw correlation ≥ ${SAME_TAKE}):`);
    if (!same.length) {
        console.log('    none — every block is its own recording');
    } else {
        for (const [a, b, c] of same.sort((x, y) => y[2] - x[2])) {
            console.log(`    ${String(a).padStart(3)} ≈ ${String(b).padStart(3)}   ${c.toFixed(3)}`);
        }
    }

    // Sections, and each one's internal period if it has one.
    const cuts = [0];
    for (let b = 1; b < blocks; b++) if (novelty[b] >= BOUNDARY) cuts.push(b);
    cuts.push(blocks);
    const sections = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const from = cuts[i], to = cuts[i + 1];
        const n = to - from;
        // Does the section repeat inside itself? If blocks p apart are the
        // same take for every pair that fits, the LOOP is p blocks and the
        // section is that loop stated n/p times — which is the difference
        // between one sixteen-bar row and eight four-bar ones.
        let period = n;
        for (let p = 1; p < n; p++) {
            if (n % p !== 0) continue;
            let all = true;
            for (let k = from; k + p < to && all; k++) {
                all = takeCorr(pcm, k * blockSamples, (k + p) * blockSamples, blockSamples) >= SAME_TAKE;
            }
            if (all) { period = p; break; }
        }
        sections.push({ from, to, period });
    }

    console.log(`\n  sections (novelty ≥ ${BOUNDARY}):`);
    for (const s of sections) {
        const n = s.to - s.from;
        const stated = s.period < n ? `  — a ${s.period * barsPer}-bar loop stated ${n / s.period}×` : '';
        console.log(
            `    blocks ${s.from}-${s.to - 1}   bar ${s.from * barsPer}, ` +
            `${n * barsPer} bars, ${(s.from * blockSec).toFixed(3)}s–${(s.to * blockSec).toFixed(3)}s${stated}`
        );
    }

    if (!write) {
        console.log(`\n  --write seeds ${TABLE.replace(ROOT + '/', '')} with these rows.`);
        return;
    }
    if (existsSync(TABLE)) {
        console.error(`\n  refusing to overwrite ${TABLE.replace(ROOT + '/', '')} — ` +
            `it exists, and the rows in it are hand-placed. Delete it first if you mean to reseed.`);
        process.exit(1);
    }
    const rows = ['id,startBar,bars,role,gate,gateN,notes'];
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        // The loop is the PERIOD, not the section: a section that states a
        // sixteen-bar loop twice is one row, and the runtime repeats it.
        const bars = s.period * barsPer;
        rows.push(`loop${String(i).padStart(2, '0')},${s.from * barsPer},${bars},bed,open,0,`);
    }
    writeFileSync(TABLE, rows.join('\n') + '\n');
    console.log(`\n  wrote ${TABLE.replace(ROOT + '/', '')}: ${sections.length} rows, all open. ` +
        `Set role and gate by hand.`);
}

main();
