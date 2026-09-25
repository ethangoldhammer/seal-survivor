#!/usr/bin/env node
// ============================================================================
// THE LOOP TABLE IS REACHABLE AND POINTS AT AUDIO
//
//   npm run test:sealitaireloops
//
// musicLoops.csv is a hand-edited table of offsets into one bounce, and the
// runtime reads it as thirty-two bytes per row out of a blob. There are three
// ways that goes wrong quietly, and this is the only place any of them shows:
//
//   THE JOIN GOES STALE. A row is edited and `npm run sealitaire:music` is not
//   re-run. The CSV says one thing, the .riv plays another, and both files
//   look fine on their own. So every row is re-derived from the CSV here and
//   compared with what is actually in music.bin.
//
//   AN OFFSET POINTS AT NOTHING. A region past the end of the track, or one
//   whose bars do not land on the bar grid the bake was made with. A seek to
//   either is not an error at runtime — the sound simply plays the wrong bar,
//   or completes, and the table's music appears to have "stopped working".
//
//   A REGION OPENS ON A HOLE. The offsets can be perfectly correct and still
//   start in a gap between phrases. Nothing structural can see that, so this
//   decodes the track and looks at the samples under every region's first
//   beat. It is the same argument as sealitaire-sfx-test.mjs: a file that
//   parses everywhere and decodes to silence is indistinguishable from a
//   quiet one until something opens the audio.
//
//   A LADDER RUNG IS UNREACHABLE. The beds are climbed in table order and the
//   one playing is the LAST unlocked row, so a rung whose threshold is at or
//   below the rung beneath it opens at the same moment and is never the last.
//   It is a row that reads as configured and can never be heard.
//
//   A WASH IS MISSING OR ORPHANED. The ring-out is an asset per loop, so it
//   has the join every asset has: a .flac with no row is dead weight in a 22
//   MB file, a row with no .flac cuts the music with no reverb behind it, and
//   an <AudioAsset> line missing from scene.rml makes the file unreachable
//   while it still sits on disk looking present.
//
// The vocabularies below are RE-SPELLED rather than imported from the baker.
// A test that reads the baker's own tables cannot tell a wrong bake from a
// wrong constant.
// ============================================================================

import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = join(ROOT, 'rive/sealitaire/musicLoops.csv');
const BIN = join(ROOT, 'rive/sealitaire/music.bin');

const ASSETS = join(ROOT, 'rive/sealitaire/music');
const SCENE = join(ROOT, 'rive/sealitaire/scene.rml');

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
  console.log(`sealitaire loops: skipped — no ${AFCONVERT} on this machine (macOS only).`);
  console.log('  The bank is checked by decoding it, so there is nothing to say without a decoder.');
  process.exit(0);
}

const ROLES = ['bed', 'intro', 'win'];
const GATES = ['open', 'deals', 'wins', 'foundations', 'score', 'moves'];
const LOOP_BYTES = 36;
const ID_BYTES = 16;

// Floats go into the blob as f32 and come back with f32's precision. A tenth
// of a millisecond is four samples at 48 kHz and far tighter than anything
// audible; anything looser would hide a real off-by-a-bar on a long track.
const EPS = 1e-4;

// A region's first beat must carry audio. 0.002 is generous on purpose: the
// quietest region in this bounce sits at -44 dBFS RMS and a real fade-in is
// slow. This is looking for a HOLE, not for a level.
const HOLE = 0.002;

let failures = 0;
function fail(msg) {
    console.error(`  FAIL  ${msg}`);
    failures++;
}
function pass(msg) {
    console.log(`  ok    ${msg}`);
}

// ---------------------------------------------------------------------------
function splitCsvLine(line) {
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
}

function readTable() {
    const lines = readFileSync(TABLE, 'utf8').split('\n').filter((l) => l.trim().length);
    const head = splitCsvLine(lines[0]).map((h) => h.trim());
    return lines.slice(1).map((line, i) => {
        const cells = splitCsvLine(line);
        const row = { _line: i + 2 };
        head.forEach((h, k) => { row[h] = (cells[k] ?? '').trim(); });
        return row;
    });
}

function readBake() {
    const b = readFileSync(BIN);
    if (b.toString('ascii', 0, 4) !== 'SMUS') throw new Error('music.bin is not a bake');
    const version = b.readUInt32LE(4);
    if (version !== 3) throw new Error(`music.bin is version ${version}, not 3 — re-run npm run sealitaire:music`);
    const bands = b.readUInt32LE(20);
    const barSeconds = b.readFloatLE(24 + bands * 4);
    const blockBars = b.readUInt32LE(28 + bands * 4);
    const count = b.readUInt32LE(32 + bands * 4);
    const at = 36 + bands * 4;
    const loops = [];
    for (let i = 0; i < count; i++) {
        const o = at + i * LOOP_BYTES;
        let id = '';
        for (let c = 0; c < ID_BYTES; c++) {
            const byte = b[o + c];
            if (!byte) break;
            id += String.fromCharCode(byte);
        }
        loops.push({
            id,
            startSec: b.readFloatLE(o + ID_BYTES),
            endSec: b.readFloatLE(o + ID_BYTES + 4),
            role: b[o + ID_BYTES + 8],
            gate: b[o + ID_BYTES + 9],
            gateN: b.readFloatLE(o + ID_BYTES + 12),
            washSeconds: b.readFloatLE(o + ID_BYTES + 16),
        });
    }
    return {
        duration: b.readFloatLE(16),
        bands,
        barSeconds,
        blockBars,
        loops,
        // Where the frames start, so a wrong loop-table size shows as a
        // blob that is the wrong length rather than as audio read from
        // inside a loop record.
        framesAt: at + count * LOOP_BYTES,
        frames: b.readUInt32LE(8),
        bytes: b.length,
    };
}

// Decode to mono. afconvert, as everywhere else here — there is no ffmpeg on
// this machine.
function decodeMono(src, rate) {
    const tmp = mkdtempSync(join(tmpdir(), 'sealitaire-loops-test-'));
    const wav = join(tmp, 'mono.wav');
    try {
        execFileSync('/usr/bin/afconvert', [
            '-f', 'WAVE', '-d', `LEI16@${rate}`, '-c', '1', src, wav,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        const buf = readFileSync(wav);
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
console.log('sealitaire loop table');

for (const [what, path] of [['musicLoops.csv', TABLE], ['music.bin', BIN]]) {
    if (!existsSync(path)) {
        fail(`${what} is missing`);
        process.exit(1);
    }
}

const rows = readTable();
const bake = readBake();

// --- the vocabularies -------------------------------------------------------
{
    const seen = new Set();
    for (const r of rows) {
        const where = `musicLoops.csv:${r._line} (${r.id || '?'})`;
        if (!r.id) fail(`${where}: no id`);
        if (seen.has(r.id)) fail(`${where}: duplicate id`);
        seen.add(r.id);
        if (Buffer.byteLength(r.id, 'utf8') > ID_BYTES - 1) {
            fail(`${where}: id does not fit in ${ID_BYTES - 1} bytes, so two rows could collide in the blob`);
        }
        if (!ROLES.includes(r.role)) fail(`${where}: role "${r.role}" is not one of ${ROLES.join(', ')}`);
        if (!GATES.includes(r.gate)) fail(`${where}: gate "${r.gate}" is not one of ${GATES.join(', ')}`);
        if (!(Number(r.bars) > 0)) fail(`${where}: bars "${r.bars}"`);
        if (!(Number(r.startBar) >= 0)) fail(`${where}: startBar "${r.startBar}"`);
    }
    if (!failures) pass(`${rows.length} rows, ids unique, roles and gates known`);
}

// A fresh session has no deals, no wins, nothing on the foundations. If no
// bed is reachable from there the table opens silent — and every later gate
// is unreachable too, because nothing would ever be playing to change from.
{
    const start = rows.filter((r) => r.role === 'bed' && r.gate === 'open');
    if (!start.length) fail('no bed with gate "open": a fresh session would have nothing to play');
    else pass(`${start.length} bed(s) open from a standing start`);
}

// --- the join ---------------------------------------------------------------
{
    if (rows.length !== bake.loops.length) {
        fail(`musicLoops.csv has ${rows.length} rows, music.bin has ${bake.loops.length} — re-run npm run sealitaire:music`);
    } else {
        let drift = 0;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i], b = bake.loops[i];
            const where = `row ${i + 1}`;
            if (r.id !== b.id) { fail(`${where}: CSV says "${r.id}", the bake says "${b.id}"`); drift++; continue; }
            const startSec = Number(r.startBar) * bake.barSeconds;
            const endSec = (Number(r.startBar) + Number(r.bars)) * bake.barSeconds;
            if (Math.abs(startSec - b.startSec) > EPS) {
                fail(`${where} (${r.id}): bar ${r.startBar} is ${startSec.toFixed(4)}s, the bake has ${b.startSec.toFixed(4)}s`);
                drift++;
            }
            if (Math.abs(endSec - b.endSec) > EPS) {
                fail(`${where} (${r.id}): ends at ${endSec.toFixed(4)}s, the bake has ${b.endSec.toFixed(4)}s`);
                drift++;
            }
            if (ROLES.indexOf(r.role) !== b.role) { fail(`${where} (${r.id}): role`); drift++; }
            if (GATES.indexOf(r.gate) !== b.gate) { fail(`${where} (${r.id}): gate`); drift++; }
            if (Math.abs(Number(r.gateN || 0) - b.gateN) > EPS) { fail(`${where} (${r.id}): gateN`); drift++; }
        }
        if (!drift) pass(`every row matches music.bin (bar ${bake.barSeconds.toFixed(6)}s)`);
    }
}

// --- the offsets are inside the track ---------------------------------------
{
    let bad = 0;
    for (const l of bake.loops) {
        if (l.startSec < 0 || l.endSec > bake.duration + 0.001) {
            fail(`"${l.id}" spans ${l.startSec.toFixed(3)}-${l.endSec.toFixed(3)}s, past the track's ${bake.duration.toFixed(3)}s`);
            bad++;
        }
        if (l.endSec <= l.startSec) { fail(`"${l.id}" has no length`); bad++; }
        // On the grid. A region that is not a whole number of bars from zero
        // starts off the downbeat, which reads as the music being wrong
        // rather than as a wrong number.
        const bars = l.startSec / bake.barSeconds;
        if (Math.abs(bars - Math.round(bars)) > 1e-3) {
            fail(`"${l.id}" starts ${bars.toFixed(3)} bars in — not on a bar line`);
            bad++;
        }
    }
    if (!bad) pass(`every region is on the bar grid and inside ${bake.duration.toFixed(3)}s`);
}

// --- the blob is the length its header claims -------------------------------
{
    const want = bake.framesAt + bake.frames * bake.bands * 2;
    if (bake.bytes !== want) fail(`music.bin is ${bake.bytes} bytes, its header describes ${want}`);
    else pass(`music.bin is ${(bake.bytes / 1024).toFixed(1)} KB, exactly what its header describes`);
}

// --- the ladder climbs ------------------------------------------------------
{
    const beds = rows.filter((r) => r.role === 'bed');
    let bad = 0;
    for (let i = 1; i < beds.length; i++) {
        const a = beds[i - 1], b = beds[i];
        if (b.gate === a.gate && Number(b.gateN) <= Number(a.gateN)) {
            fail(
                `bed "${b.id}" asks for ${b.gateN} and sits below "${a.id}" which asks for ${a.gateN}. ` +
                `The ladder plays the LAST unlocked rung, so this one can never be it.`
            );
            bad++;
        }
    }
    if (beds.length && beds[0].gate !== 'open') {
        fail(`the first bed ("${beds[0].id}") is gated — the bottom rung has to be reachable from a standing start`);
        bad++;
    }
    if (!bad) {
        pass(`the bed ladder climbs: ${beds.map((r) => `${r.id}${r.gate === 'open' ? '' : ` @${r.gate} ${r.gateN}`}`).join(' → ')}`);
    }
}

// --- every region and ring-out is on disk, declared, and audible -----------
{
    const want = [];
    for (const l of bake.loops) {
        want.push({ id: l.id, seconds: l.endSec - l.startSec, loop: true });
        if (l.washSeconds > 0) want.push({ id: `wash-${l.id}`, seconds: l.washSeconds, loop: false });
    }
    const wantIds = want.map((w) => w.id);
    const onDisk = existsSync(ASSETS)
        ? readdirSync(ASSETS).filter((f) => f.endsWith('.flac')).map((f) => f.slice(0, -5))
        : [];
    const declared = [...readFileSync(SCENE, 'utf8')
        .matchAll(/<AudioAsset file="music\/([^"]+)\.flac" name="([^"]+)"/g)]
        .map((m) => m[2]);
    let bad = 0;
    for (const id of wantIds) {
        if (!onDisk.includes(id)) { fail(`${id}.flac is not in rive/sealitaire/music — re-run npm run sealitaire:music`); bad++; }
        if (!declared.includes(id)) { fail(`${id} has no <AudioAsset> in scene.rml, so the table cannot reach it`); bad++; }
    }
    for (const id of onDisk) {
        if (!wantIds.includes(id)) { fail(`music/${id}.flac is not wanted by any row — it ships for nothing`); bad++; }
    }
    for (const id of declared) {
        if (!wantIds.includes(id)) { fail(`scene.rml declares ${id}, which no row wants`); bad++; }
    }
    // The single-track asset belonged to the seek design and must not come
    // back: with it present the riv carries the whole bounce twice.
    if (/<AudioAsset file="music\.mp3"/.test(readFileSync(SCENE, 'utf8'))) {
        fail('scene.rml still declares music.mp3 — the whole bounce is shipping alongside the regions cut from it');
        bad++;
    }

    // And they contain audio, of the right LENGTH. Length is the one that
    // matters most for a region: the transport loops it on the clock, using
    // the length musicLoops.csv claims, so a file that is short plays
    // silence at the end of every pass and one that is long is cut off —
    // and neither is visible anywhere else. afconvert's FLAC encoder also
    // writes a valid, empty 42-byte file when its input is too short, which
    // is the trap sealitaire-sfx-test.mjs exists for.
    for (const w of want) {
        const path = join(ASSETS, `${w.id}.flac`);
        if (!existsSync(path)) continue;
        if (statSync(path).size < 1024) { fail(`${w.id}.flac is ${statSync(path).size} bytes — an empty FLAC header`); bad++; continue; }
        const RATE = 32000;
        const pcm = decodeMono(path, RATE);
        const heard = pcm.length / RATE;
        if (Math.abs(heard - w.seconds) > 0.02) {
            fail(`${w.id}.flac is ${heard.toFixed(3)}s, its row says ${w.seconds.toFixed(3)}s`);
            bad++;
        }
        if (w.loop) {
            const bars = heard / bake.barSeconds;
            if (Math.abs(bars - Math.round(bars)) > 0.01) {
                fail(`${w.id}.flac is ${bars.toFixed(3)} bars — a region that is not a whole number of bars cannot loop on the grid`);
                bad++;
            }
        }
        let q = 0;
        for (let i = 0; i < pcm.length; i++) q += pcm[i] * pcm[i];
        const rms = Math.sqrt(q / Math.max(1, pcm.length));
        if (rms < 1e-4) { fail(`${w.id}.flac decodes to silence (${(20 * Math.log10(rms + 1e-12)).toFixed(1)} dBFS)`); bad++; }
    }
    if (!bad) pass(`${want.length} assets on disk, declared in scene.rml, whole bars, and audible`);
}

// --- the bake describes the same track the regions were cut from -----------
{
    // The one staleness the join check cannot see: musicLoops.csv and
    // music.bin agreeing with each other about a track neither of them
    // describes any more. The regions' total length is the tell.
    const cut = bake.loops.reduce((n, l) => n + (l.endSec - l.startSec), 0);
    if (cut > bake.duration + 0.01) {
        fail(`the regions total ${cut.toFixed(1)}s but the bake was made from a ${bake.duration.toFixed(1)}s track`);
    } else {
        pass(`${bake.loops.length} regions, ${cut.toFixed(1)}s cut from a ${bake.duration.toFixed(1)}s bounce`);
    }
}

if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nthe loop table is reachable and points at audio');
