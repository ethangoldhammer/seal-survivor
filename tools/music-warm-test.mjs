#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:musicwarm
//
// The music bank is LAZY now: `sources` is the catalogue of every slot that has
// music, `tracks` is the handful decoded right now, and `keepWarm` decides
// which. This is the test for that split, and it exists because the one beside
// it cannot be — tools/music-loop-test.mjs builds every loop through
// `loadTrackFromFile`, which produces a PINNED upload that is never evicted and
// never re-fetched. It therefore exercises the transport perfectly and the
// loading not at all, and would go on passing with the whole mechanism removed.
//
// WHY IT MATTERS AT ALL. Web Audio decodes to 32-bit float at the context's
// rate whatever the file was, so 48kHz stereo costs 384KB per second however
// small the mp3: `public/music` is 13MB on disk and 126MB decoded. The old
// loader decoded all twenty-two at boot and never let one go, and the phone's
// own census said what that cost — `aud221` of a 505MB total, on a device that
// kills the web view for memory.
//
// THE FAILURE THIS IS REALLY GUARDING is not the memory, which is a number
// anyone can read. It is the ROTATION SILENTLY STOPPING. Every switch here is
// scheduled against a boundary at most a bar away, and both `queueTrack` and
// `startSource` decline a name that is not decoded — so a warm set that misses
// the next loop does not glitch, or stutter, or throw. The playing loop simply
// repeats forever and the score never advances again, in a build where nothing
// is wrong with the audio graph at all.
//
//   node --import ./tools/vite-loader.mjs tools/music-warm-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

let now = 0;

class Param {
  constructor(v = 0) { this.base = v; }
  get value() { return this.base; }
  set value(v) { this.base = v; }
  setValueAtTime(v) { this.base = v; return this; }
  setTargetAtTime(v) { this.base = v; return this; }
  exponentialRampToValueAtTime(v) { this.base = v; return this; }
  linearRampToValueAtTime(v) { this.base = v; return this; }
  cancelScheduledValues() { return this; }
}

const sourcesStarted = [];
const node = (extra = {}) => ({
  connect() { return this; }, disconnect() {}, ...extra,
});

// EVERY LOOP THE SAME LENGTH, on purpose. This file is about which files are in
// memory and in what order they are reached; the transport's own arithmetic —
// boundaries, dilation, encoder padding — is tools/music-loop-test.mjs's
// subject, and a library of varying lengths here would only make the clock
// harder to drive without testing anything this file is for.
const LOOP = 8;
const RATE = 48000;
// What one decoded loop costs in memory, by the same arithmetic
// musicBankBytes uses: length x channels x 4.
const LOOP_BYTES = LOOP * RATE * 2 * 4;

let decodes = 0;

class FakeCtx {
  constructor() {
    this.destination = node();
    this.sampleRate = RATE;
    this.state = 'running';
  }
  get currentTime() { return now; }
  createGain() { return node({ gain: new Param(1) }); }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: new Param(20000), Q: new Param(1), gain: new Param(0) });
  }
  createConvolver() { return node({ buffer: null }); }
  createDelay(max) { return node({ maxDelayTime: max, delayTime: new Param(0) }); }
  createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
  createDynamicsCompressor() {
    return node({
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25), reduction: 0,
    });
  }
  createBuffer(ch, len) {
    return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    const n = node({
      buffer: null, playbackRate: new Param(1), loop: false,
      start(when) { n.started = when ?? now; sourcesStarted.push(n); },
      stop() {},
    });
    return n;
  }
  createOscillator() {
    return node({ type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
  }
  async decodeAudioData(data) {
    decodes++;
    const length = LOOP * RATE;
    // REAL SAMPLES, because measureTrack reads them to find the downbeat and
    // caches the answer in trackMeta — and trackMeta surviving eviction is one
    // of the things this file checks.
    const pcm = new Float32Array(length);
    for (let i = 0; i < length; i++) pcm[i] = Math.sin(i * 0.05 + 1) * 0.5;
    return {
      duration: LOOP, sampleRate: RATE, length, numberOfChannels: 2,
      tag: data?.tag, getChannelData: () => pcm,
    };
  }
  resume() { return Promise.resolve(); }
}

let poll = null;
globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = (fn) => { poll = fn; return 1; };
globalThis.window.clearInterval = () => { poll = null; };

// THE FETCH IS THE POINT. Every src in the catalogue resolves to bytes carrying
// the name it was asked for, so a decoded buffer can be read back as "which
// file is this" — which is how the rotation is checked below. A src of
// 'missing' 404s, so the catalogue's own failure path is exercised too.
globalThis.fetch = async (src) => {
  if (String(src).includes('missing')) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, arrayBuffer: async () => ({ tag: String(src), byteLength: 1 }) };
};
const warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));

const { CONFIG } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const music = await import('../path/src/systems/music.js');

CONFIG.music.enabled = true;
CONFIG.music.bpm = 120;
CONFIG.music.beatsPerLoop = 16;
CONFIG.music.playbackRate = 1;
CONFIG.music.slots = 6;
CONFIG.music.levelsPerSlot = 3;
CONFIG.music.bossIntro = true;
CONFIG.music.defaultSrc = ['s1', 's2', 's3', 's4', 's5', 's6'];
CONFIG.music.bossSrc = ['b0', 'b1', 'b2', 'b3', 'b4'];
const LIBRARY = CONFIG.music.defaultSrc.length + CONFIG.music.bossSrc.length;

audio.unlockAudio();

/** Let every decode kicked off by the last call actually land. */
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// ASYNC, AND THAT IS NOT A CONVENIENCE. The 40ms poll is a real timer in the
// browser, so the microtask queue drains between every tick and a decode
// started on one tick has landed several ticks later. A synchronous loop here
// runs a whole minute of music without letting a single promise resolve, which
// makes every lazily-fetched loop arrive late and reports the warm set as
// broken when it is doing exactly what it should. Cost an hour of chasing a
// bug that was in this function.
async function run(seconds) {
  const step = 0.04;
  const end = now + seconds;
  while (now < end - 1e-9) {
    now = Math.min(end, now + step);
    poll?.();
    await Promise.resolve();
  }
}

const resident = () => Math.round(music.musicBankBytes() / LOOP_BYTES);
const playing = () => sourcesStarted[sourcesStarted.length - 1]?.buffer?.tag ?? null;

// ===========================================================================
section('The bank is the whole library from the first frame — the MEMORY is not');

await music.preloadDefaultTracks();
await settle();

check('every ordinary slot is offered to a level',
  new Set([1, 4, 7, 10, 13, 16].map((l) => music.slotForLevel(l))).size === 6,
  [1, 4, 7, 10, 13, 16].map((l) => music.slotForLevel(l)).join(','));
// The bank a fight draws on is the full five, not the one or two decoded. Read
// through the rotation rather than off an export: a bank that had collapsed to
// the warm set would show up here as a fight that repeats two loops.
check('the library is eleven files', LIBRARY === 11, `${LIBRARY}`);
check('...and only a handful of them are in memory', resident() <= 4 && resident() >= 1,
  `${resident()} of ${LIBRARY} decoded`);
check('...which is the whole point: the bank costs a fraction of the library',
  music.musicBankBytes() < LOOP_BYTES * LIBRARY * 0.5,
  `${(music.musicBankBytes() / 1048576).toFixed(1)}MB of ${(LOOP_BYTES * LIBRARY / 1048576).toFixed(1)}MB`);
// The DECODE count, not just what is resident. A loader that decoded the whole
// library and then evicted most of it would pass every check above and would
// have paid the entire cost this change exists to avoid — on the phone, in the
// first seconds of a run, which is the worst moment to ask for 126MB.
check('...and the files it does not need were never decoded at all',
  decodes < LIBRARY, `${decodes} decode(s) for ${LIBRARY} files`);

// ===========================================================================
section('A run walks its slots without ever waiting for a decode');

music.play(1);
await run(0.2);
await settle();
check('the first loop is playing', playing() === 's1', String(playing()));

// Every level boundary in the run, in order. The check is not that the switch
// is queued — it is that it LANDS, which is the thing an undecoded track fails
// silently. A missed one leaves the previous loop playing and says nothing.
const wanted = ['s2', 's3', 's4', 's5', 's6'];
const reached = [];
for (let slot = 1; slot < 6; slot++) {
  music.setLevel(slot * CONFIG.music.levelsPerSlot + 1);
  await settle();
  await run(LOOP + 0.2);
  await settle();
  reached.push(playing());
}
check('every slot in the run was reached, in order',
  reached.join(',') === wanted.join(','), reached.join(','));
check('...and the bank never grew past the working set', resident() <= 4,
  `${resident()} decoded at the end of the walk`);

// ===========================================================================
section('A fight walks the boss rotation without ever stalling');

// THE FAILURE THIS IS FOR: queueNextBossLoop runs immediately after each
// switch, so the loop AFTER the one just started has to be resident a whole
// loop early. If it is not, queueTrack declines it, nothing is queued, and the
// playing loop repeats for the rest of the fight — no error, no gap, no way to
// tell from the outside except that the music stops developing.
warnings.length = 0;
check('the fight takes the transport', music.startBossMusic() === true);
await settle();
// Collected from the bar the fight takes the transport on, not from a loop
// later: the INTRO is the first thing it plays and is only ever heard once a
// run, so sampling after it has gone by makes the two checks below vacuous.
const heard = [];
for (let i = 0; i < 14; i++) {
  await run(LOOP);
  await settle();
  const p = playing();
  if (p !== heard[heard.length - 1]) heard.push(p);
}
check('the rotation moved through the bank rather than repeating one loop',
  new Set(heard).size >= 4, heard.join(' → '));
check('...it opened on the intro', heard[0] === 'b0', heard.join(' → '));
check('...and never returned to it', !heard.slice(1).includes('b0'), heard.join(' → '));
check('...with nothing ever queued before it was decoded',
  !warnings.some((w) => w.includes('before it was decoded')),
  warnings.filter((w) => w.includes('before it was decoded'))[0] ?? '');
check('...and the bank still is not the library', resident() <= 5,
  `${resident()} of ${LIBRARY}`);

music.endBossMusic();
await settle();
await run(LOOP + 0.2);
await settle();
check('the run\'s own loop comes back after the fight',
  String(playing()).startsWith('s'), String(playing()));

// ===========================================================================
section('An upload is never evicted — there is nothing to fetch it back from');

await music.loadTrackFromFile('2', { name: 'mine', arrayBuffer: async () => ({ tag: 'UPLOAD' }) });
check('the upload is in its slot', music.hasTrack('2'));
// Walk far enough that every ordinary slot has been through the warm set and
// out the other side. A track that came from a file would have been dropped
// several times over by now.
for (let level = 1; level <= 18; level += 3) {
  music.setLevel(level);
  await settle();
  await run(LOOP + 0.2);
  await settle();
}
check('...and it is still there after the whole run has walked past it',
  music.hasTrack('2'));
music.setLevel(4);
await settle();
await run(LOOP + 0.2);
await settle();
check('...and still plays when the run comes back to it', playing() === 'UPLOAD',
  String(playing()));

// IN MEMORY, as opposed to catalogued: hasTrack answers "does this slot have
// music behind it", which is true of every slot from the first frame. Whether
// the bytes are decoded is what trackReport walks.
const warm = (name) => music.trackReport().some((r) => r.name === name);

// ===========================================================================
section('A new run opens on the first loop, however far the last one climbed');

// THE SCORE CARD. A run that climbed to slot 3 or beyond had slot 1 walk out
// of the warm set — it was neither the loop for this level nor the next — and
// the next run's play(1) then asked startSource for a buffer that was not in
// memory. startSource declines a name it cannot start, so the previous run's
// loop simply carried on under the new run: the transport reported a fresh
// start, the beat grid re-anchored, and the music never went back to the top.
// Slot 2 is the pinned upload from the section above, and the walk climbs one
// slot per level-up so every switch is warm: levels 4, 7, 10 are slots 2, 3, 4.
music.stop();
music.play(1);
await run(0.2);
await settle();
for (const level of [4, 7, 10]) {
  music.setLevel(level);
  await settle();
  await run(LOOP + 0.2);
  await settle();
}
check('the run climbed past the opening loop', playing() === 's4', String(playing()));
check('...which stayed in memory the whole way', warm('1'));
music.restMusic(0.3);
await run(0.5);
// The card then hands over to a new run the way startGame does.
const took = music.releaseMusicIntoRun(1);
check('the new run takes the transport over', took === true);
check('...and opens on the first loop ON THE FRAME, not wherever the last run died',
  playing() === 's1', String(playing()));

// The same restart with the opening loop genuinely cold — the case the warm set
// no longer produces, but the one play() has to survive: evicted by anything,
// the file is fetched and the run still opens on it. Emptying the slot count
// for one keepWarm is how the test evicts, since nothing in the game can.
music.stop();
music.play(1);
await run(0.2);
await settle();
for (const level of [4, 7, 10]) {
  music.setLevel(level);
  await settle();
  await run(LOOP + 0.2);
  await settle();
}
check('back on a late slot', playing() === 's4', String(playing()));
CONFIG.music.slots = 0;
music.setLevel(10);
CONFIG.music.slots = 6;
check('...with the opening loop out of memory', !warm('1'));
const before = sourcesStarted.length;
music.restMusic(0.3);
await run(0.5);
warnings.length = 0;
music.releaseMusicIntoRun(1);
check('a cold opening loop does not start anything yet', sourcesStarted.length === before);
check('...and says so, because the warm set was supposed to hold it',
  warnings.some((w) => w.includes('opening loop')));
await settle();
await run(0.2);
await settle();
check('...but the run still opens on it once it lands', playing() === 's1', String(playing()));
check('...exactly once', sourcesStarted.length === before + 1, `${sourcesStarted.length - before} started`);

// ===========================================================================
section('Levelling up during a fight keeps the loop the kill hands back to warm');

// setLevel stands down during a boss fight — it must not queue the run's next
// loop under the boss music — but it also stopped moving the warm set, so a
// player who levelled from 7 to 13 during the fight had the kill hand the
// transport to a slot nobody had decoded: endBossMusic asked startSource for
// it, startSource declined, and the BOSS loop played on for the rest of the run.
music.stop();
music.play(1);
await run(0.2);
await settle();
for (const level of [4, 7]) {
  music.setLevel(level);
  await settle();
  await run(LOOP + 0.2);
  await settle();
}
check('the run is on its third loop', playing() === 's3', String(playing()));
warnings.length = 0;
music.startBossMusic();
await settle();
await run(LOOP);
await settle();
check('the fight is up', String(playing()).startsWith('b'), String(playing()));
music.setLevel(13);
await settle();
await run(LOOP);
await settle();
check('...and levelling inside it did not end its music', String(playing()).startsWith('b'), String(playing()));
check('...but did warm the loop the kill will hand back to', warm('5'));
music.endBossMusic();
await settle();
await run(0.2);
await settle();
check('the kill hands the transport to the level the run reached',
  playing() === 's5', String(playing()));
check('...on the frame, with nothing queued late',
  !warnings.some((w) => w.includes('before it was decoded')),
  warnings.filter((w) => w.includes('before it was decoded'))[0] ?? '');

// ===========================================================================
section('A switch aimed at a cold file lands when the file does, not never');

// The last resort under all of the above. queueTrack warned and started the
// decode, and then nothing ever asked again — the boundary it was aiming for
// came and went, and so did every one after it.
music.stop();
music.play(1);
await run(0.2);
await settle();
check('on the first loop', playing() === 's1', String(playing()));
// A jump of three slots at once: the warm set holds slot 2 for the next
// level-up, not slot 4 — made certain here rather than inherited from whatever
// the section above left in memory.
CONFIG.music.slots = 0;
music.setLevel(1);
CONFIG.music.slots = 6;
check('the far slot is cold', !warm('4'));
warnings.length = 0;
music.setLevel(10);
check('the switch was asked for before its file was decoded',
  warnings.some((w) => w.includes('before it was decoded')));
await settle();
await run(LOOP * 2 + 0.2);
await settle();
check('...and still lands once the file is in memory', playing() === 's4', String(playing()));

// ===========================================================================
section('A file that 404s leaves the bank rather than stalling it');

// The eager loader skipped a slot whose fetch failed, and the lazy one has to
// reach the same place from the other end: the failure now happens minutes into
// a run rather than at boot, so a slot that kept claiming to exist would be
// queued, decline, and stop the rotation on the level that reached it.
music.stop();
CONFIG.music.defaultSrc = ['s1', 'missing-2', 's3'];
CONFIG.music.bossSrc = [];
CONFIG.music.slots = 3;
const fresh = await import(`../path/src/systems/music.js?warm=${Date.now()}`);
await fresh.preloadDefaultTracks();
await settle();
// The slot is catalogued straight from CONFIG, so it IS offered — right up
// until the warm set reaches it and the fetch comes back 404. That happens
// within the first moments of a run rather than at boot, which is the whole
// difference from the eager loader, and the assertion worth making is about
// where it ends up rather than about that window.
check('the broken slot is dropped once its file turns out not to be there',
  !fresh.hasTrack('2'), 'still offered');
fresh.play(1);
await run(0.2);
await settle();
fresh.setLevel(1 + CONFIG.music.levelsPerSlot);
await settle();
await run(LOOP + 0.2);
await settle();
check('...and the level that would have played it falls through to one that exists',
  String(playing()).startsWith('s'), String(playing()));
check('...leaving the two that do exist',
  new Set([1, 4, 7].map((l) => fresh.slotForLevel(l))).size === 2,
  [1, 4, 7].map((l) => fresh.slotForLevel(l)).join(','));

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
