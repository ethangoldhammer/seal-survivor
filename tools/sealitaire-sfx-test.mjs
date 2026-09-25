#!/usr/bin/env node
// ============================================================================
// THE BANK IS AUDIBLE — every sound in rive/sealitaire/sfx actually contains
// audio, matches its row, and is reachable from the scene.
//
//   npm run test:sealitairesfx
//
// This exists because of a specific silent failure. afconvert's FLAC encoder
// writes a HEADER AND NOTHING ELSE — a valid, well-formed, 42-byte file — when
// its input is shorter than one 4608-sample block, and trimming pushed four of
// the pack's shortest sounds under that line. A stub like that:
//
//   * is a valid FLAC, so every parser accepts it;
//   * resolves as an AudioAsset, so `rive --verify` passes with 0 errors;
//   * decodes to silence, so `Audio.play` succeeds and returns a sound;
//   * and is therefore indistinguishable, everywhere a build can look, from a
//     quiet sound. Those four events would simply never have made a noise.
//
// Nothing upstream can catch it, because nothing upstream opens the audio. So
// this does: it decodes every file and looks at the samples.
//
// It also checks the three joins that can silently drift apart — the files on
// disk, the rows in sfx.csv, and the <AudioAsset> lines in scene.rml. A file
// with no asset line is unreachable and ships anyway; an asset line with no
// file is a name that resolves to nothing at runtime.
// ============================================================================

import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BANK = join(ROOT, 'rive/sealitaire/sfx');
const INDEX = join(ROOT, 'rive/sealitaire/sfx.csv');
const SCENE = join(ROOT, 'rive/sealitaire/scene.rml');

// Must agree with tools/sealitaire-sfx.mjs. Not imported from it on purpose:
// a test that reads the baker's own constants cannot tell a wrong bake from a
// wrong constant, which is the same trap as a bound computed from the thing it
// is checking.
const AFCONVERT = '/usr/bin/afconvert';

// ---------------------------------------------------------------------------
// THE DECODER, OR NOTHING TO SAY.
//
// Every check below that means anything decodes real audio, and the decoder is
// `/usr/bin/afconvert` — which ships with macOS and exists nowhere else. On a
// Linux CI runner every single file "fails to decode" with ENOENT, which is
// not a finding about the bank: it is the same finding about the runner, 354
// times. That is what blocked three deploys in a row while `npm run ship`
// stayed green on the Mac that has the binary.
//
// So the absence of the decoder is a SKIP, not a failure, and it says so on
// one line. The gate still runs in full wherever a decoder exists, which is
// every machine the bank is actually baked on — a bank is baked with
// afconvert, so the check and the thing it checks are available together.
if (!existsSync(AFCONVERT)) {
  console.log(`sealitaire sfx: skipped — no ${AFCONVERT} on this machine (macOS only).`);
  console.log('  The bank is checked by decoding it, so there is nothing to say without a decoder.');
  process.exit(0);
}

const RATE = 32000;
const TARGET_PEAK = 0.89;
const SILENCE_FLOOR = 0.02;   // a file whose loudest sample is under this is mute
// The same definition of silence the baker trims to (0.5% of the file's own
// peak), not a stricter one. A higher gate calls a genuine slow attack
// "silence" and fails a file that is perfectly fine — several of this pack's
// longer sounds swell in over 80ms and that is the sound, not a delay.
// MAX_HEAD is the baker's 4ms pre-roll plus its 2ms ramp, with room to spare.
const MAX_HEAD = 0.010;
const HEAD_GATE = 0.005;

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

function decode(path, tmp) {
    const wav = join(tmp, 'probe.wav');
    rmSync(wav, { force: true });
    try {
        execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, path, wav],
            { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
        return { error: String(e.stderr ?? e).trim().split('\n')[0] };
    }
    if (!existsSync(wav)) return { error: 'afconvert wrote nothing' };
    const b = readFileSync(wav);
    let at = 12, ch = 1;
    while (at + 8 <= b.length) {
        const id = b.toString('ascii', at, at + 4);
        const size = b.readUInt32LE(at + 4);
        if (id === 'fmt ') ch = b.readUInt16LE(at + 10);
        if (id === 'data') {
            const total = Math.min(size, b.length - at - 8) >> 1;
            const n = Math.floor(total / ch);
            const s = new Float32Array(n);
            // `peak` is the loudest SAMPLE IN ANY CHANNEL, which is what the
            // level check is about — a stereo file is normalised so that
            // neither channel clips, so measuring the mid (L+R)/2 reads low on
            // anything genuinely stereo and fails a correctly levelled file.
            // `s` stays the mid, because the head scan only wants one trace.
            let peak = 0;
            for (let i = 0; i < n; i++) {
                let m = 0;
                for (let c = 0; c < ch; c++) {
                    const v = b.readInt16LE(at + 8 + (i * ch + c) * 2) / 32768;
                    m += v;
                    peak = Math.max(peak, Math.abs(v));
                }
                s[i] = m / ch;
            }
            return { s, n, ch, peak };
        }
        at += 8 + size + (size & 1);
    }
    return { error: 'no data chunk' };
}

// ---------------------------------------------------------------------------
// The detector, tested on a stub of our own before it is trusted on the bank.
// A check for a silent failure that has itself gone quiet is worse than no
// check: it is a green light that means nothing.
// ---------------------------------------------------------------------------
function selfCheck(tmp) {
    console.log('the detector:');
    const stub = join(tmp, 'stub.flac');
    // A real 42-byte afconvert stub: 'fLaC' + a STREAMINFO block saying zero
    // samples, and no frames at all.
    const b = Buffer.alloc(42);
    b.write('fLaC', 0, 'ascii');
    b[4] = 0x80;              // last-metadata-block, type 0 (STREAMINFO)
    b.writeUIntBE(34, 5, 3);  // STREAMINFO is 34 bytes
    writeFileSync(stub, b);
    const got = decode(stub, tmp);
    if (got.error || got.n === 0 || (got.peak ?? 0) > SILENCE_FLOOR) {
        ok('a 42-byte header-only flac is caught');
    } else {
        fail(`a 42-byte header-only flac decoded as ${got.n} usable samples — ` +
             `the detector is broken and every check below is meaningless`);
    }
    // And a real sound must NOT trip it, or the check is just "fail always".
    const n = RATE / 4;
    const pcm = Buffer.alloc(44 + n * 2);
    pcm.write('RIFF', 0, 'ascii'); pcm.writeUInt32LE(36 + n * 2, 4);
    pcm.write('WAVEfmt ', 8, 'ascii'); pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 2, 28);
    pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36, 'ascii'); pcm.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 29000), 44 + i * 2);
    const real = join(tmp, 'real.wav');
    writeFileSync(real, pcm);
    const r = decode(real, tmp);
    if (!r.error && r.n > 0 && r.peak > SILENCE_FLOOR) ok('a real quarter-second tone passes');
    else fail(`a real tone was rejected (${r.error ?? `${r.n} samples, peak ${r.peak}`})`);
}

// ---------------------------------------------------------------------------
function main() {
    if (!existsSync(BANK)) {
        console.error(`no bank at ${BANK} — run: node tools/sealitaire-sfx.mjs <pack> --write`);
        process.exit(1);
    }
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-sfxtest-'));
    try {
        selfCheck(tmp);

        // --- the three joins ---
        console.log('\nthe joins:');
        const files = readdirSync(BANK).filter(f => f.endsWith('.flac')).map(f => basename(f, '.flac')).sort();
        const rows = new Map();
        for (const line of readFileSync(INDEX, 'utf8').trim().split('\n').slice(1)) {
            const [id, seconds, chans] = line.split(',');
            if (id) rows.set(id, { seconds: Number(seconds), chans: Number(chans) });
        }
        const scene = readFileSync(SCENE, 'utf8');
        const declared = new Set(
            [...scene.matchAll(/<AudioAsset file="sfx\/([^"]+)\.flac" name="([^"]+)"/g)]
                .map(m => { if (m[1] !== m[2]) fail(`scene.rml: ${m[1]}.flac is declared under the name "${m[2]}"`); return m[2]; })
        );

        const missingRow = files.filter(f => !rows.has(f));
        const orphanRow = [...rows.keys()].filter(id => !files.includes(id));
        const undeclared = files.filter(f => !declared.has(f));
        const dangling = [...declared].filter(d => !files.includes(d));
        if (missingRow.length) fail(`on disk with no sfx.csv row: ${missingRow.join(', ')}`);
        if (orphanRow.length) fail(`sfx.csv rows with no file: ${orphanRow.join(', ')}`);
        if (undeclared.length) fail(`no <AudioAsset> in scene.rml, so unreachable and shipping anyway: ${undeclared.join(', ')}`);
        if (dangling.length) fail(`<AudioAsset> pointing at a file that is not there: ${dangling.join(', ')}`);
        if (!missingRow.length && !orphanRow.length && !undeclared.length && !dangling.length) {
            ok(`${files.length} files, ${rows.size} rows and ${declared.size} asset lines all agree`);
        }

        // THE INDEX HAS TO BE READABLE FROM THE SCRIPT, not just correct on
        // disk. J/K/L walks self.sfxBank, which is this file read through
        // `context:blob('sfxBank')` — so the <BlobAsset> line is what makes
        // every sound in the bank reachable from inside the game. Lose it and
        // the join above still passes, every event still plays, and the only
        // thing that breaks is the audition: one line on the console saying
        // the index is missing, easy to scroll past.
        if (!/<BlobAsset file="sfx\.csv" name="sfxBank"/.test(scene)) {
            fail('scene.rml has no <BlobAsset file="sfx.csv" name="sfxBank">, so J/K/L cannot audition the bank');
        } else {
            ok('sfx.csv is declared as the "sfxBank" blob, so J/K/L can walk it');
        }

        // --- the audio itself ---
        console.log('\nthe audio:');
        let mute = 0, late = 0, offLevel = 0, offLength = 0, quietest = 1, worstHead = 0;
        for (const id of files) {
            const got = decode(join(BANK, `${id}.flac`), tmp);
            const bytes = statSync(join(BANK, `${id}.flac`)).size;
            if (got.error) { fail(`${id}: will not decode — ${got.error}`); mute++; continue; }
            if (got.n === 0) { fail(`${id}: ${bytes} bytes and zero samples — a header with no audio`); mute++; continue; }
            if (got.peak < SILENCE_FLOOR) { fail(`${id}: decodes, but its loudest sample is ${got.peak.toFixed(4)} — silent`); mute++; continue; }
            quietest = Math.min(quietest, got.peak);

            // The trim: leading silence is latency, and it is the reason the
            // bake exists at all.
            const gate = got.peak * HEAD_GATE;
            let head = 0;
            while (head < got.n && Math.abs(got.s[head]) < gate) head++;
            const headS = head / RATE;
            worstHead = Math.max(worstHead, headS);
            if (headS > MAX_HEAD) { fail(`${id}: ${(headS * 1000).toFixed(0)}ms of silence before the attack — not trimmed`); late++; }

            // The normalise: the whole bank has to sit at one level or every
            // assignment needs its own volume before it can be judged.
            if (Math.abs(got.peak - TARGET_PEAK) > 0.06) {
                fail(`${id}: peaks at ${got.peak.toFixed(3)}, not ${TARGET_PEAK} — not normalised`);
                offLevel++;
            }

            const row = rows.get(id);
            if (row && Math.abs(got.n / RATE - row.seconds) > 0.02) {
                fail(`${id}: ${(got.n / RATE).toFixed(3)}s of audio but sfx.csv says ${row.seconds}s`);
                offLength++;
            }
            if (row && got.ch !== row.chans) fail(`${id}: ${got.ch} channels, sfx.csv says ${row.chans}`);
        }
        if (!mute && !late && !offLevel && !offLength) {
            ok(`${files.length} sounds all carry audio (quietest peak ${quietest.toFixed(3)})`);
            ok(`all start within ${(worstHead * 1000).toFixed(0)}ms (limit ${MAX_HEAD * 1000}ms)`);
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }

    // THE SEAL'S VOICE. react.luau's roster and sfxEvents.csv are two files that
    // have to agree on seven names, and nothing at runtime makes them: the event
    // is built as `react` + the variant's name capitalised, so a variant renamed
    // or added on one side goes quiet on the other and only says so on a console
    // nobody is watching. These voices were already dead once, cast and never
    // fired, which is exactly how long that goes unnoticed.
    {
        const variants = [...readFileSync(join(ROOT, 'rive/sealitaire/react.luau'), 'utf8')
            .matchAll(/\{ name = '([a-z]+)'/g)].map((m) => m[1]);
        const events = new Map();
        const lines = readFileSync(join(ROOT, 'rive/sealitaire/sfxEvents.csv'), 'utf8').split('\n').slice(1);
        for (const line of lines) {
            const cells = line.split(',');
            if (cells[0]) events.set(cells[0].trim(), (cells[1] || '').trim());
        }
        // Read off sfx.csv here rather than borrowing the map above: that one
        // lives inside the block that unpacks the audio, and this check has to
        // keep working if that block is ever skipped.
        const ids = new Set(readFileSync(INDEX, 'utf8').split('\n').slice(1)
            .map((l) => l.split(',')[0].trim()).filter(Boolean));
        let bad = 0;
        for (const v of variants) {
            const ev = 'react' + v[0].toUpperCase() + v.slice(1);
            const takes = events.get(ev);
            if (takes === undefined) { fail(`react.luau has variant "${v}" but sfxEvents.csv has no row "${ev}"`); bad++; continue; }
            if (!takes) { fail(`${ev} has no takes cast: the ${v} reaction is silent`); bad++; continue; }
            for (const t of takes.split('|')) {
                if (t && !ids.has(t)) { fail(`${ev} casts "${t}", which is not in sfx.csv`); bad++; }
            }
        }
        if (!bad) ok(`all ${variants.length} reactions have a voice cast from the bank`);
    }

    console.log('');
    if (failures) {
        console.error(`sealitaire sfx: ${failures} problem${failures === 1 ? '' : 's'}`);
        process.exit(1);
    }
    console.log('sealitaire sfx: the bank is audible, level and reachable');
}

main();
