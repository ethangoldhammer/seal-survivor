#!/usr/bin/env node
// ============================================================================
// THE SFX BAKE — a pack of sound files conditioned into a bank Sealitaire can
// hold, audition and assign.
//
//   npm run sealitaire:sfx -- --write        # bake what sfxPacks.csv records
//   node tools/sealitaire-sfx.mjs            # the same, dry: look, change nothing
//   node tools/sealitaire-sfx.mjs packA one.mp3 --write     # an ad-hoc set instead
//
// WHAT GETS BAKED IS RECORDED, not remembered. rive/sealitaire/sfxPacks.csv is
// one row per source — a directory or a single file — and running with no
// arguments bakes exactly that set. To add a sound, add a row.
//
// That file exists because of the id rule below: ids are handed out by
// POSITION, so the bank has to be baked as a whole every time or the numbering
// moves under the scene. "Pass every source every time" is the kind of thing
// that survives one session and fails the next, so the list lives on disk
// where the next person can read it, and Ethan can add a Survivor sound by
// typing a line rather than by knowing a command.
//
// Each source is a directory or a single file, so a handful of sounds can be
// pulled out of a big library (public/sfx has 250) without baking the library.
// Ids come from the filename, so two sources holding the same basename would
// silently overwrite each other — that is refused by name rather than resolved
// by luck.
//
// Writes rive/sealitaire/sfx/*.flac, the bank index rive/sealitaire/sfx.csv,
// and the <AudioAsset> lines into scene.rml between markers.
//
// FOUR THINGS ARE DONE TO EVERY FILE, and only one of them is about size:
//
//   TRIM   Leading silence is LATENCY. A card flip whose file starts with
//          0.2s of nothing plays 0.2s after the card moves, and it reads as
//          the game being slow rather than as the sound being late — which is
//          why it survives a listening test and then quietly makes everything
//          feel worse. The HG_Cards pack's median is 40ms and its worst is
//          205ms. Trailing silence is only size, and is cut while we are here.
//
//   MONO   Measured, not assumed: the side channel is compared with the mid,
//          and a file folds only if there is effectively nothing in it. 79 of
//          that pack's 84 are already mono in a stereo container, so they
//          halve for nothing. The other five keep both channels.
//
//   LEVEL  Peak-normalised to a common target. This is the one that makes an
//          assignment panel usable: the pack's peaks run from 0.024 to 0.949,
//          a forty-to-one spread, so without it every single assignment needs
//          its own volume before it can sit beside the last one, and the
//          volume slider stops being a choice and becomes a chore.
//
//   FADE   A two-millisecond ramp at each end. Cutting silence lands the cut
//          on a non-zero sample often enough, and that step is a click —
//          a worse artefact than the silence we removed.
//
// FLAC, not MP3, and that is the whole point of the format choice: every MP3
// encoder prepends priming samples — 20-36ms of them in this project's
// experience — so re-encoding a trimmed sound puts the latency straight back,
// and the file then measures as trimmed while sounding as though it is not.
// FLAC is lossless and starts on sample zero. miniaudio (the Rive CLI's
// decoder) has its FLAC decoder compiled in, like WAV and MP3.
//
// Decoding is afconvert, which is in macOS; there is no ffmpeg on this machine.
//
// `npm run test:sealitairesfx` checks the result by decoding it again — see
// STUB_BYTES below for the failure that check exists for.
// ============================================================================

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'rive/sealitaire/sfx');
const INDEX = join(ROOT, 'rive/sealitaire/sfx.csv');
const PACKS = join(ROOT, 'rive/sealitaire/sfxPacks.csv');

// Asset ids for the bank. A block of its own, well clear of everything
// hand-written in scene.rml, so a new hand-added asset can never land on a
// generated one.
//
// IT WAS 1000 AND THE SCENE GREW INTO IT. That was chosen when the hand-
// written ids ran to 0:6xx; the editor has since added fonts, images and
// strokes up around 0:11xx, so a bank of 104 sounds reached 0:1103 and
// collided with a Stroke. The CLI catches that loudly — sixteen "duplicate
// id" errors and no build — but the bake itself succeeds and writes the
// clashing block, so the failure appears one command after the cause.
//
// 2000 clears the fx block at 1400 and everything the editor has added.
// Raise it again rather than interleaving: the whole block is rewritten on
// every bake, so it must own a contiguous range nothing else uses.
const SFX_ID0 = 2000;

// WHAT THE OTHER TOOLS OWN in sfx/. The fx, knock and hover ladders write
// into the same directory and prune their own by these suffixes; a bank bake
// must never delete or renumber them. Everything else in there is ours, and
// ours-but-not-in-this-bake means the source left sfxPacks.csv.
const OTHERS = /-(?:phaser|lowpass|telephone|distant)$|-p-?\d+$|-h-?\d+$|^knockbus-/;

// 32k, not 44.1k. These are transient-heavy and a low rate dulls the click,
// but 16kHz of Nyquist is above where a card's snap lives and it lands the
// whole pack at the size the 320kbps source was — lossless, for free. The
// game's own bank is 22.05k and its one complaint about rate
// (tools/sfx-assign.mjs) is about 16k mono sounding like a ceiling at 8kHz,
// which this clears twice over.
const RATE = 32000;
const TARGET_PEAK = 0.89;  // short of 1.0, so a resampler's overshoot cannot clip
const GATE = 0.005;        // of the file's own peak: what counts as silence
const PRE_ROLL = 0.004;    // s kept before the first sound, so the attack is not clipped
const FADE = 0.002;        // s ramp at each end, against the click a hard cut makes
// THE BANK'S TONE. A two-pole low-pass over every take, in Hz; 0 turns it
// off. The card pack is bright — most of its takes carry 60-90% of their
// energy above 4kHz — and on a table that is under water, played behind a
// CRT, that reads as harsh rather than as crisp.
//
// APPLIED TO THE WHOLE BANK RATHER THAN PER TAKE, because "these sounds are
// too bright" is one decision about one pack, not eleven decisions about
// eleven events. sfxFx.csv's `lowpass` preset still exists for a take that
// wants to be darker than the bank — it stacks on top of this.
//
// BEFORE THE NORMALISE, and that is the whole reason it lives here instead
// of in a post pass: filtering removes energy, so a take levelled first and
// filtered after lands quiet in proportion to how bright it was — which is
// the level spread the normalise exists to remove, reintroduced by the tone
// control. Filter, then measure, then scale.
//
// The bank is derived: sfxPacks.csv records every source, so this is a knob
// and not a destructive edit. Change it and re-run with --write.
// Read from tuning.luau so the tuner's `sfxLowpass` slider and this agree —
// there must be one number, or the panel shows a cutoff the bank was not
// baked at. Missing row, or an unreadable file, means no filter rather than a
// guessed one: a silently wrong tone is worse than an obviously absent one.
const LOWPASS_HZ = (() => {
    try {
        const t = readFileSync(join(ROOT, 'rive/sealitaire/tuning.luau'), 'utf8');
        const m = /\{\s*key\s*=\s*'sfxLowpass'\s*,[^}]*?value\s*=\s*([-\d.]+)/.exec(t);
        return m ? Number(m[1]) : 0;
    } catch {
        return 0;
    }
})();
const LOWPASS_Q = 0.707;   // Butterworth: flat to the knee, no resonant bump

// A two-pole low-pass, RBJ cookbook, run over the samples in place-ish.
// Twice — forward only would drop 12dB/oct with a phase smear; the second
// pass makes it 24 and the character rounder, which is what "under water"
// wants. Cheap enough on sub-second takes.
function lowpass(x, hz, q) {
    if (!(hz > 0) || hz >= RATE / 2) return x;
    const w = 2 * Math.PI * hz / RATE, cs = Math.cos(w), sn = Math.sin(w);
    const alpha = sn / (2 * q);
    const b0 = (1 - cs) / 2, b1 = 1 - cs, b2 = (1 - cs) / 2;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    let y = x;
    for (let pass = 0; pass < 2; pass++) {
        const o = new Float32Array(y.length);
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < y.length; i++) {
            const v = y[i];
            const r = (b0 / a0) * v + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
            x2 = x1; x1 = v; y2 = y1; y1 = r;
            o[i] = r;
        }
        y = o;
    }
    return y;
}
const MONO_SIDE = 0.15;    // side/mid energy under which a file is called mono

// afconvert's FLAC encoder writes a HEADER AND NOTHING ELSE — a valid, empty,
// 42-byte file — when the input is shorter than one block. Trimming pushed
// four of the HG_Cards pack's shortest sounds under it, and a 42-byte flac
// decodes to silence without erroring anywhere a build would show it:
// `rive --verify` passes, the asset resolves, and those four events are simply
// mute for ever. So the tail is padded out to one block (a few ms of digital
// silence, at the end, where it costs nothing) and every output is checked
// against the stub size before it is allowed to count as a sound.
const FLAC_BLOCK = 4608;
const STUB_BYTES = 64;

const AUDIO = /\.(mp3|wav|aif|aiff|flac|m4a)$/i;

// The recorded sources. Split on the FIRST comma only, so `notes` may contain
// commas and a path may not — which is the right way round, since a path with
// a comma in it is rare and a note without one is unnatural.
function readPacks() {
    if (!existsSync(PACKS)) return [];
    const out = [];
    for (const line of readFileSync(PACKS, 'utf8').split('\n').slice(1)) {
        const row = line.trim();
        if (row === '' || row.startsWith('#')) continue;
        const at = row.indexOf(',');
        const source = (at < 0 ? row : row.slice(0, at)).trim();
        if (source !== '') out.push(source);
    }
    return out;
}

// A bank id is the source filename, slugged. It is the name the scene declares
// the asset under and the name sfxEvents.csv casts by, so it has to survive a
// round trip through XML and a CSV cell.
function idFor(file) {
    return basename(file, extname(file)).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
}

// ---------------------------------------------------------------------------
function decode(src, tmp) {
    const wav = join(tmp, 'in.wav');
    execFileSync('/usr/bin/afconvert', [
        '-f', 'WAVE', '-d', `LEI16@${RATE}`, src, wav,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const b = readFileSync(wav);
    // Walk the chunks rather than assuming 44 bytes: afconvert writes an FLLR
    // padding chunk often enough that a fixed offset decodes the padding as
    // audio, and every measurement below is then off by a fraction of a second.
    let at = 12, ch = 2;
    while (at + 8 <= b.length) {
        const id = b.toString('ascii', at, at + 4);
        const size = b.readUInt32LE(at + 4);
        if (id === 'fmt ') ch = b.readUInt16LE(at + 10);
        if (id === 'data') {
            const total = Math.min(size, b.length - at - 8) >> 1;
            const n = Math.floor(total / ch);
            const L = new Float32Array(n);
            const R = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                L[i] = b.readInt16LE(at + 8 + i * ch * 2) / 32768;
                R[i] = ch > 1 ? b.readInt16LE(at + 8 + (i * ch + 1) * 2) / 32768 : L[i];
            }
            rmSync(wav, { force: true });
            return { L, R, ch };
        }
        at += 8 + size + (size & 1);
    }
    throw new Error(`no data chunk decoding ${src}`);
}

function condition(L, R) {
    // The tone, first: everything below measures the signal that is written.
    if (LOWPASS_HZ > 0) {
        L = lowpass(L, LOWPASS_HZ, LOWPASS_Q);
        R = lowpass(R, LOWPASS_HZ, LOWPASS_Q);
    }
    const n = L.length;
    let peak = 0, mid = 0, side = 0;
    for (let i = 0; i < n; i++) {
        peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
        const m = (L[i] + R[i]) / 2, d = (L[i] - R[i]) / 2;
        mid += m * m;
        side += d * d;
    }
    const sideRatio = Math.sqrt(side / Math.max(1e-12, mid));
    const mono = sideRatio < MONO_SIDE;

    const gate = peak * GATE;
    let head = 0;
    while (head < n && Math.abs(L[head]) < gate && Math.abs(R[head]) < gate) head++;
    let tail = n - 1;
    while (tail > head && Math.abs(L[tail]) < gate && Math.abs(R[tail]) < gate) tail--;
    if (head >= n) return null;   // the whole file is under the gate
    head = Math.max(0, head - Math.round(PRE_ROLL * RATE));
    tail = Math.min(n - 1, tail + Math.round(PRE_ROLL * RATE));

    // Padded to a whole FLAC block, at the TAIL only — the head is the attack
    // and the whole point of the trim (see FLAC_BLOCK).
    const out = Math.max(tail - head + 1, FLAC_BLOCK);
    const chans = mono ? 1 : 2;
    // NORMALISE THE SIGNAL THAT IS ACTUALLY WRITTEN, not the one that came in.
    // `peak` above is max(|L|,|R|) over the whole source; a folded file is the
    // MID, (L+R)/2, and the moment the two channels differ at all the mid
    // peaks lower than either of them. Normalising to the source's peak then
    // lands the file quiet in proportion to how stereo it was — 0.66 instead
    // of 0.89 on this pack's worst — which is invisible in a waveform and is
    // exactly the level spread the normalise exists to remove.
    const cut = new Float32Array(out * chans);
    const ramp = Math.max(1, Math.round(FADE * RATE));
    const last = tail - head;          // the final REAL sample; `out` may be padding
    // The envelope, as a function of the output index — needed twice, because
    // the peak has to be measured THROUGH it.
    const envAt = (i) => {
        let env = 1;
        if (i < ramp) env = i / ramp;
        if (i > last - ramp) env = Math.min(env, Math.max(0, (last - i) / ramp));
        return env;
    };

    // MEASURED AFTER THE FADE, and this is not pedantry. Normalising to the
    // raw peak and then fading multiplies the two: a sound whose loudest
    // sample falls inside the 2ms ramp comes out at TARGET_PEAK x (i/ramp) —
    // quieter than target by however early its transient is, which for a
    // plosive is most of the way.
    //
    // It went unnoticed for the whole card pack because a card's snap has a
    // millisecond or two of attack in front of it. Ethan's flick-plops do
    // not: the loudest sample is the first one, and three of the sixteen
    // landed at 0.63-0.79 against a 0.89 target — audibly quieter in a rattle
    // of sixteen, and exactly the spread the normalise exists to remove.
    // `npm run test:sealitairesfx` decodes the result and is what caught it.
    let outPeak = 0;
    for (let i = 0; i < out; i++) {
        const s = head + i;
        if (s > tail) break;
        const raw = mono ? Math.abs((L[s] + R[s]) / 2)
                         : Math.max(Math.abs(L[s]), Math.abs(R[s]));
        outPeak = Math.max(outPeak, raw * envAt(i));
    }
    const gain = TARGET_PEAK / Math.max(1e-6, outPeak);
    for (let i = 0; i < out; i++) {
        const env = envAt(i);
        const s = head + i;
        const l = s <= tail ? L[s] : 0;
        const r = s <= tail ? R[s] : 0;
        if (mono) {
            cut[i] = ((l + r) / 2) * gain * env;
        } else {
            cut[i * 2] = l * gain * env;
            cut[i * 2 + 1] = r * gain * env;
        }
    }
    return {
        pcm: cut, chans, frames: out,
        trimmedHead: head / RATE, trimmedTail: (n - 1 - tail) / RATE,
        peakWas: outPeak, gain, sideRatio, mono,
    };
}

function writeWav(path, pcm, chans) {
    const frames = pcm.length / chans;
    const data = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm[i]));
        data.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(chans, 22);
    head.writeUInt32LE(RATE, 24);
    head.writeUInt32LE(RATE * chans * 2, 28);
    head.writeUInt16LE(chans * 2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    writeFileSync(path, Buffer.concat([head, data]));
    return frames;
}

// ---------------------------------------------------------------------------
function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const given = args.filter(a => !a.startsWith('--'));
    const fromFile = given.length === 0;
    // A recorded path may be repo-relative (public/sfx/Chain_01.mp3) or
    // absolute (a pack outside the repo); both read naturally in the file.
    const sources = (fromFile ? readPacks() : given)
        .map(src => (src.startsWith('/') ? src : join(ROOT, src)));
    if (sources.length === 0) {
        console.error(fromFile
            ? `no sources recorded in ${PACKS}\nAdd a row (a directory or a single file), or pass one: node tools/sealitaire-sfx.mjs <source>... [--write]`
            : 'usage: node tools/sealitaire-sfx.mjs [<pack-dir-or-file>...] [--write]');
        process.exit(1);
    }
    for (const source of sources) {
        if (!existsSync(source)) {
            console.error(fromFile
                ? `${PACKS} records a source that is not there:\n  ${source}\nFix the row or remove it.`
                : `no such source: ${source}`);
            process.exit(1);
        }
    }
    console.log(fromFile
        ? `${sources.length} source(s) from sfxPacks.csv`
        : `${sources.length} source(s) given on the command line (sfxPacks.csv ignored)`);

    // Every source expanded to a flat list of files, each with the id it will
    // be baked under.
    const inputs = [];
    for (const source of sources) {
        if (statSync(source).isDirectory()) {
            const all = readdirSync(source).filter(f => AUDIO.test(f));
            for (const f of all
                // One entry per sound: a pack that ships the same take as both
                // a .wav and a .mp3 would otherwise be baked twice under two
                // names.
                .filter(f => extname(f).toLowerCase() === '.mp3'
                    || !all.includes(basename(f, extname(f)) + '.mp3'))
                .sort()) {
                inputs.push({ full: join(source, f), id: idFor(f) });
            }
        } else {
            inputs.push({ full: source, id: idFor(basename(source)) });
        }
    }
    const seen = new Map();
    for (const it of inputs) {
        const prev = seen.get(it.id);
        if (prev && prev !== it.full) {
            console.error(`both of these bake to "${it.id}":\n  ${prev}\n  ${it.full}`);
            console.error('rename one, or pass them separately — an id is a filename and cannot be shared.');
            process.exit(1);
        }
        seen.set(it.id, it.full);
    }
    if (inputs.length === 0) {
        console.error('no audio files in any of the sources given');
        process.exit(1);
    }

    if (write) mkdirSync(DEST, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-sfx-'));
    let inBytes = 0, outBytes = 0, cutSeconds = 0, monoCount = 0;
    const rows = [];

    try {
        for (const { full, id } of inputs) {
            const { L, R } = decode(full, tmp);
            const c = condition(L, R);
            if (c === null) {
                console.log(`  ${id.padEnd(26)} SKIPPED — nothing above the silence gate`);
                continue;
            }
            const wav = join(tmp, `${id}.wav`);
            writeWav(wav, c.pcm, c.chans);
            const flac = join(write ? DEST : tmp, `${id}.flac`);
            execFileSync('/usr/bin/afconvert', ['-f', 'flac', '-d', 'flac', wav, flac],
                { stdio: ['ignore', 'ignore', 'pipe'] });

            const was = statSync(full).size;
            const now = statSync(flac).size;
            // The check that makes the padding above trustworthy rather than
            // hopeful. A stub is a VALID file that decodes to nothing, so
            // nothing downstream can tell it from a quiet sound.
            if (now <= STUB_BYTES) {
                throw new Error(
                    `${id}: the encoder wrote ${now} bytes — a header with no audio. ` +
                    `It would resolve, decode to silence and never error.`
                );
            }
            inBytes += was;
            outBytes += now;
            cutSeconds += c.trimmedHead + c.trimmedTail;
            if (c.mono) monoCount++;
            rows.push({ id, seconds: c.frames / RATE, chans: c.chans });
            console.log(
                `  ${id.padEnd(22)} ${(c.frames / RATE).toFixed(2)}s  ` +
                `head -${(c.trimmedHead * 1000).toFixed(0)}ms  ` +
                `${c.mono ? 'mono' : 'ST  '}  ` +
                `peak ${c.peakWas.toFixed(3)} x${c.gain.toFixed(1)}  ` +
                `${(was / 1024).toFixed(0)}K -> ${(now / 1024).toFixed(0)}K`
            );
            if (!write) rmSync(flac, { force: true });
            rmSync(wav, { force: true });
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }

    console.log(
        `\n${rows.length} sounds  ${(inBytes / 1024 / 1024).toFixed(2)}MB -> ` +
        `${(outBytes / 1024 / 1024).toFixed(2)}MB  ` +
        `(${(100 - outBytes / inBytes * 100).toFixed(0)}% smaller)  ` +
        `${cutSeconds.toFixed(1)}s of silence cut  ${monoCount} folded to mono`
    );

    if (!write) {
        console.log('\nNothing written. Re-run with --write.');
        return;
    }

    // THE BANK, and only the bank: what exists, not what it is for. Which
    // sound plays on which event lives elsewhere, because an event holds
    // SEVERAL takes and one row per file cannot say that. `notes` is kept per
    // file so a line about a take survives a re-bake.
    const head = 'id,seconds,chans,notes';
    const baked = new Set(rows.map(r => r.id));
    const notes = new Map();
    // ROWS THIS BAKE DID NOT MAKE ARE KEPT. Another tool writes derived takes
    // beside these — tools/sealitaire-sfx-fx.mjs bakes processed variants,
    // `hg-cards-033-phaser.flac` and the like, with their own rows here and
    // their own asset block in scene.rml. Dropping them on a re-bake would
    // leave the files on disk with no row, which is exactly what
    // test:sealitairesfx fails on, and the fix would be to remember to re-run
    // the other tool. Keeping them makes the two tools order-independent.
    //
    // Only kept if the FILE IS STILL THERE: a preserved row for a file nobody
    // wrote is the same broken join pointing the other way.
    const carried = [];
    if (existsSync(INDEX)) {
        for (const line of readFileSync(INDEX, 'utf8').trim().split('\n').slice(1)) {
            const cells = line.split(',');
            const id = cells[0];
            if (!id) continue;
            if (baked.has(id)) {
                if (cells[3]) notes.set(id, cells[3]);
            } else if (!OTHERS.test(id)) {
                // Ours, and not in this bake: the source is gone from
                // sfxPacks.csv. Dropped here rather than left to the file
                // delete further down — that runs AFTER this read, so
                // carrying it on the strength of the file still being there
                // made a removal need two bakes to settle.
                continue;
            } else if (existsSync(join(DEST, `${id}.flac`))) {
                carried.push(line);
            } else {
                console.log(`  dropped stale row "${id}" — no ${id}.flac on disk`);
            }
        }
    }
    const out = [head];
    for (const r of rows) {
        out.push(`${r.id},${r.seconds.toFixed(3)},${r.chans},${notes.get(r.id) ?? ''}`);
    }
    for (const line of carried) {
        out.push(line);
    }
    // Held, not written. Everything below can still refuse the whole bake, and
    // a refusal that has already rewritten the index is not a refusal — the
    // first version of this printed "Nothing was written" over a rewritten
    // sfx.csv.
    const indexText = out.join('\n') + '\n';

    // The asset declarations, rewritten between markers in scene.rml. Eighty-
    // four of these are generated content: hand-maintaining them means a file
    // that is on disk and silently unreachable the one time somebody forgets a
    // line, which is indistinguishable from the sound being wrong.
    //
    // ONLY this block is touched. A second block (SFX FX) holds processed
    // variants baked by another tool; regenerating this one must not drop it.
    const scene = join(ROOT, 'rive/sealitaire/scene.rml');
    const sceneSrc = readFileSync(scene, 'utf8');
    const open = '    <!-- SFX BANK: generated by tools/sealitaire-sfx.mjs; do not hand-edit -->';
    const close = '    <!-- END SFX BANK -->';
    const block = [open]
        .concat(rows.map((r, i) => `    <AudioAsset file="sfx/${r.id}.flac" name="${r.id}" id="0:${SFX_ID0 + i}"/>`))
        .concat([close]).join('\n');
    let next;
    const a = sceneSrc.indexOf(open), b = sceneSrc.indexOf(close);
    if (a >= 0 && b > a) {
        // ANYTHING IN HERE THAT IS NOT OURS COMES BACK OUT, below the close
        // marker, instead of being replaced along with the rest. The fx tool
        // put its own generated block inside these markers — reasonable, they
        // are adjacent and both are sfx assets — and a straight splice of the
        // region silently deleted four assets that every other check was
        // happy with: the files were on disk, the rows were in sfx.csv, and
        // `rive --verify` passed because a cast take that resolves to nothing
        // is not a build error. Carrying strangers out makes the two tools
        // order-independent however either of us writes next.
        const mine = new Set(rows.map(r => `sfx/${r.id}.flac`));
        // A STRANGER IS NOT THE SAME AS OUR OWN LEFTOVER, and telling them
        // apart is what the id says. Only this tool allocates from SFX_ID0,
        // so a line in the block at or above it that is NOT in this bake is a
        // row we wrote for a source that has since left sfxPacks.csv —
        // stale, ours, and to be dropped. Carrying it instead made removing
        // a source impossible: the leftover kept an id the renumbered bake
        // then wanted, and the collision guard below refused the write with
        // a message about another tool, which was not what had happened.
        const stale = [];
        const foreign = sceneSrc.slice(a + open.length, b).split('\n').filter((line) => {
            if (line.trim() === '') return false;
            const m = line.match(/<AudioAsset file="([^"]+)"/);
            if (m && mine.has(m[1])) return false;
            const id = (line.match(/id="0:(\d+)"/) || [])[1];
            if (id && Number(id) >= SFX_ID0) { stale.push(m ? m[1] : line.trim()); return false; }
            return true;
        });
        if (stale.length > 0) {
            console.log(`  dropped ${stale.length} stale line(s) for sources no longer in sfxPacks.csv`);
        }
        if (foreign.length > 0) {
            console.log(`  carried ${foreign.length} line(s) from another tool out of the bank block`);
        }
        // Our ids run from SFX_ID0 BY POSITION, so a bake of a different set of
        // sources renumbers from the same base while the carried lines keep the
        // ids they were given. Two assets on one id is not something the build
        // reports, so it is refused here, loudly, with the thing to do about it.
        const ours = new Set(rows.map((_r, i) => `0:${SFX_ID0 + i}`));
        const clash = foreign
            .map(line => (line.match(/id="([^"]+)"/) || [])[1])
            .filter(id => id && ours.has(id));
        if (clash.length > 0) {
            console.error(
                `\nid collision: ${clash.join(', ')} would be used twice in scene.rml.\n` +
                `This bake produced ${rows.length} assets (0:${SFX_ID0}..0:${SFX_ID0 + rows.length - 1}) ` +
                `but lines already in the block hold some of those ids.\n` +
                `The bank is baked as a WHOLE, so the numbering is the same every time. ` +
                `Run with NO arguments to bake everything sfxPacks.csv records, and add a row ` +
                `there for anything new. Nothing was written.`
            );
            process.exit(1);
        }
        const tailBlock = foreign.length > 0 ? block + '\n' + foreign.join('\n') : block;
        next = sceneSrc.slice(0, a) + tailBlock + sceneSrc.slice(b + close.length);
    } else {
        const anchor = '    <ScriptAsset file="klondike.luau"';
        const at = sceneSrc.indexOf(anchor);
        if (at < 0) throw new Error('scene.rml: no anchor to put the sfx bank before');
        next = sceneSrc.slice(0, at) + block + '\n\n' + sceneSrc.slice(at);
    }
    // Both, together, once nothing can refuse any more.
    // A SOURCE REMOVED FROM sfxPacks.csv TAKES ITS FILE WITH IT. Its scene
    // line and index row go above; without this its .flac stays in sfx/,
    // where it is an orphan the join test reports — reachable by name from a
    // typo, counted in the bank's size, and shipping.
    //
    // Only files this tool owns. The fx, knock and hover ladders write into
    // the same directory and prune their own by their own suffixes, and a
    // bank bake must not reach into them: the knock's hundred files are
    // derived from tankWall's takes and are not in `mine` at all.
    const keep = new Set(rows.map(r => `${r.id}.flac`));
    const gone = readdirSync(DEST)
        .filter(f => f.endsWith('.flac') && !keep.has(f) && !OTHERS.test(f.replace('.flac', '')));
    for (const f of gone) rmSync(join(DEST, f), { force: true });
    if (gone.length > 0) {
        console.log(`  deleted ${gone.length} file(s) for sources no longer in sfxPacks.csv: ${gone.map(f => f.replace('.flac', '')).join(', ')}`);
    }
    writeFileSync(INDEX, indexText);
    writeFileSync(scene, next);
    console.log(`wrote ${DEST}, ${INDEX}, and ${rows.length} AudioAssets into scene.rml`);
    console.log(
        `(${notes.size} per-file notes kept, ${carried.length} rows carried from another tool; ` +
        `event assignment is in sfxEvents.csv and is untouched)`
    );
}

main();
