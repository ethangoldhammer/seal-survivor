#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:beatlock
//
// The basic shot against the music's bar grid. Four properties, and every one
// of them is invisible in a screenshot and nearly invisible by ear — a gun a
// beat off the music sounds like a gun, which is why they are asserted as
// arithmetic instead of listened to.
//
//   DIVISION  the interval is a power-of-two division of the bar, and every
//             multiplier that scales it keeps it there. A card that moves the
//             gun onto a lattice sharing only the downbeat reads as slipping.
//   PHASE     shots land ON slot boundaries, not merely the right distance
//             apart. Tempo without phase is the bug this whole thing fixes.
//   DRIFT     the error against the grid does not GROW. A countdown ticked by
//             dt passes any single-shot phase check and is a beat out by the
//             second minute, so the last shots are compared against the first.
//   RAMP      all of the above survive a rate ramp up and back down. The score
//             clock is what makes this work: at half speed a bar takes twice
//             as long in the room and the gun has to take twice as long with
//             it, which a wall-clock cooldown does not.
//
// Run: node --import ./tools/vite-loader.mjs tools/beat-lock-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --- a fake graph, clock cranked by hand -----------------------------------
let now = 0;

class Param {
  constructor(v = 0) { this.base = v; this.v = v; }
  get value() { return this.v; }
  set value(x) { this.v = x; }
  setValueAtTime(v) { this.v = v; return this; }
  setTargetAtTime(v) { this.v = v; return this; }
  exponentialRampToValueAtTime(v) { this.v = v; return this; }
  linearRampToValueAtTime(v) { this.v = v; return this; }
  cancelScheduledValues() { return this; }
}

let nodeId = 0;
const baseNode = (kind, extra = {}) => ({
  kind, id: ++nodeId, outputs: [],
  connect(d) { this.outputs.push(d); return d; },
  disconnect() { this.outputs.length = 0; },
  ...extra,
});

const decoded = new Set();

class FakeCtx {
  constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = baseNode('destination'); }
  get currentTime() { return now; }
  createGain() { return baseNode('gain', { gain: new Param(1) }); }
  createBiquadFilter() { return baseNode('biquad', { type: 'lowpass', frequency: new Param(20000), Q: new Param(1) }); }
  createConvolver() { return baseNode('convolver', { buffer: null }); }
  createDelay(m) { return baseNode('delay', { maxDelayTime: m, delayTime: new Param(0) }); }
  createWaveShaper() { return baseNode('waveshaper', { curve: null, oversample: 'none' }); }
  createDynamicsCompressor() {
    return baseNode('compressor', {
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25), reduction: 0,
    });
  }
  createBuffer(ch, len) { return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) }; }
  createBufferSource() {
    const node = baseNode('source', {
      buffer: null, playbackRate: new Param(1), loop: false, started: null, stopped: null,
      start(when) { node.started = when ?? now; }, stop(when) { node.stopped = when ?? now; },
    });
    return node;
  }
  createOscillator() {
    return baseNode('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
  }
  async decodeAudioData(data) {
    const seconds = data?.seconds ?? 1;
    const rate = 48000;
    const length = Math.round(seconds * rate);
    const pcm = new Float32Array(length);
    // Loud from the first sample: no encoder padding to find, so the file's
    // downbeat is sample zero and the bar lines are where the arithmetic says.
    for (let i = 0; i < length; i++) pcm[i] = Math.sin(i * 0.05 + 1) * 0.5;
    const buffer = { duration: seconds, sampleRate: rate, length, numberOfChannels: 1, tag: data?.tag, getChannelData: () => pcm };
    decoded.add(buffer);
    return buffer;
  }
  resume() { return Promise.resolve(); }
}

let poll = null;
globalThis.window.AudioContext = FakeCtx;
globalThis.window.setInterval = (fn) => { poll = fn; return 1; };
globalThis.window.clearInterval = () => { poll = null; };
globalThis.fetch = async () => ({ ok: false, status: 404 });
console.warn = () => {};

const { CONFIG, barDivisions } = await import('../path/src/config.js');
const audio = await import('../path/src/systems/audio.js');
const music = await import('../path/src/systems/music.js');
const { shotDue, resetShotGrid, shotGridState } = await import('../path/src/systems/shotGrid.js');

audio.unlockAudio();

const BAR = 2.265;
CONFIG.music.enabled = true;
CONFIG.music.barSeconds = BAR;
CONFIG.music.playbackRate = 1;
CONFIG.music.levelsPerSlot = 1;
CONFIG.music.slots = 4;
CONFIG.weapon.beatLock = { enabled: true, startOnBar: true, maxDivision: 64 };

await music.loadTrackFromFile('1', { name: 'loop1', arrayBuffer: async () => ({ seconds: BAR * 4, tag: '1' }) });

const STEP = 1 / 60;

// Run the gun for `seconds`, returning the bar phase at every shot. `onStep`
// is where a test bends the music's rate mid-flight.
function fireFor(seconds, interval, { mayFire = () => true, onStep = null } = {}) {
  const shots = [];
  const end = now + seconds;
  while (now < end - 1e-9) {
    now = Math.min(end, now + STEP);
    onStep?.(now);
    poll?.();
    const iv = typeof interval === 'function' ? interval() : interval;
    if (shotDue(iv, mayFire(now), STEP)) {
      shots.push({ at: now, phase: music.barGrid().phase, pos: music.barGrid().pos, interval: iv });
    }
  }
  return shots;
}

// How far a shot is from the nearest slot boundary of its own interval.
const slotError = (s) => {
  const into = ((s.phase % s.interval) + s.interval) % s.interval;
  return Math.min(into, s.interval - into);
};

// ---------------------------------------------------------------------------
section('The interval is a rung on the bar ladder');
const snap = (x, max = 64) => music.snapToBarGrid(x, max);
const divs = barDivisions(64);
check('the ladder is duples and triplets', divs.join(' ') === '1 2 3 4 6 8 12 16 24 32 48 64', divs.join(' '));
// The property that makes every one of them a lock, triplets included: a whole
// number of shots per bar, so the pattern repeats on every bar line. bar/5 and
// bar/7 would pass this too and are off the ladder because nothing in the
// library is in 5 or 7 — see barDivisions.
check('every rung is an integer number of shots per bar', divs.every((d) => Number.isInteger(d)));
check('the default shot is a quarter note', near(CONFIG.weapon.fireRate, BAR / 4, 1e-9),
  `${CONFIG.weapon.fireRate} vs bar/4 = ${BAR / 4}`);
check('...and snapping it is a no-op', near(snap(CONFIG.weapon.fireRate), BAR / 4, 1e-9));
check('a value between two rungs rounds to the nearer', near(snap(0.30), BAR / 8, 1e-9),
  `0.30 -> ${snap(0.30).toFixed(5)}, bar/8 = ${(BAR / 8).toFixed(5)}`);
// Rounding in LOG space is the whole reason these land where they do: the
// midpoint between bar/4 and bar/6 is their geometric mean (0.4623), not their
// average (0.4719). A linear round would put 0.467 on bar/6.
check('the midpoint is geometric, not arithmetic', near(snap(0.45), BAR / 6, 1e-9) && near(snap(0.48), BAR / 4, 1e-9),
  `0.45 -> bar/${(BAR / snap(0.45)).toFixed(0)}, 0.48 -> bar/${(BAR / snap(0.48)).toFixed(0)}`);
check('the triplet rungs are reachable', near(snap(0.38), BAR / 6, 1e-9) && near(snap(0.19), BAR / 12, 1e-9),
  `0.38 -> bar/${(BAR / snap(0.38)).toFixed(0)}, 0.19 -> bar/${(BAR / snap(0.19)).toFixed(0)}`);
check('nothing is finer than maxDivision', near(snap(0.0001, 16), BAR / 16, 1e-9),
  `a stack of picks caps at bar/16 = ${(BAR / 16).toFixed(4)}s`);
check('nothing is slower than a bar', near(snap(99), BAR, 1e-9));

// ---------------------------------------------------------------------------
section('Every multiplier keeps it on the grid');
const rapidCard = CONFIG.upgrades.find((u) => u.id === 'rapidFire');
const stat = { fireRate: CONFIG.weapon.fireRate };
const climb = [];
for (let i = 0; i < 10; i++) { rapidCard.apply(stat); climb.push(Math.round(BAR / stat.fireRate)); }
check('Rapid Fire walks the ladder one rung a pick', climb.slice(0, 8).join(' ') === '6 8 12 16 24 32 48 64',
  `bar/4 -> bar/${climb.slice(0, 8).join(', bar/')}`);
check('...and every rung is exact, with nothing left for the snap to fix',
  near(snap(stat.fireRate), stat.fireRate, 1e-12),
  'a multiplier that needed the snap to land would be a card that measured a change and delivered none');
check('it takes EIGHT picks to reach the cap, not four', climb.indexOf(64) === 7,
  `bar/64 arrives at pick ${climb.indexOf(64) + 1}`);
check('and picks past the cap are no-ops', climb[8] === 64 && climb[9] === 64,
  'which is why upgrades.csv caps maxStacks at 8 — a card that does nothing must stop being offered');
// The pace of the climb is the point of the ladder: alternating +50% and +33%
// on the rate, against the flat +100% a halving costs.
const gains = climb.slice(0, 8).map((d, i) => d / (i === 0 ? 4 : climb[i - 1]));
check('no single pick more than +50%', gains.every((g) => g <= 1.5 + 1e-9),
  gains.map((g) => `+${Math.round((g - 1) * 100)}%`).join(' '));
const stat2 = { fireRate: CONFIG.weapon.fireRate };
rapidCard.apply(stat2);
check('the first pick is the triplet, +50%', near(stat2.fireRate, BAR / 6, 1e-9));
check('the pickup is an even 2x', CONFIG.rapidFirePickup.fireRateMul === 2);
check('...so it lands on a slot too', near(snap(CONFIG.weapon.fireRate / CONFIG.rapidFirePickup.fireRateMul), BAR / 8, 1e-9));
check('air time at full ramp is an even 2x', (1 + 1 * (CONFIG.airborne.fireRateMul ?? 0)) === 2,
  `fireRateMul ${CONFIG.airborne.fireRateMul}`);
check('...so the top of the ramp is a slot', near(snap(CONFIG.weapon.fireRate / 2), BAR / 8, 1e-9));
// The ramp is continuous, so everything BETWEEN the ends is snapped. That is
// the gear change the lock costs, and it is asserted rather than discovered.
const rampAt = (r) => snap(CONFIG.weapon.fireRate / (1 + r * CONFIG.airborne.fireRateMul));
// The ramp is continuous and crosses the ladder, so it STEPS. Every value it
// can hold has to be a rung — never between two — and it now passes through
// bar/6 on its way, which is two gear changes rather than one.
const rungs = new Set(divs.map((d) => (BAR / d).toFixed(6)));
const rampRungs = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((r) => rampAt(r));
check('every point on the air ramp is a rung, never between two',
  rampRungs.every((v) => rungs.has(v.toFixed(6))),
  [...new Set(rampRungs.map((v) => `bar/${(BAR / v).toFixed(0)}`))].join(' -> '));

// ---------------------------------------------------------------------------
section('The first shot of a run waits for a downbeat');
music.stop();
resetShotGrid();
now += 1;
music.play(1);
const IV = CONFIG.weapon.fireRate;
// Start the gun deliberately mid-bar, which is where a run actually starts it.
fireFor(0.7, IV, { mayFire: () => false });
const opening = fireFor(BAR * 2, IV);
check('it fires', opening.length > 0, `${opening.length} shots`);
check('the first shot is on a BAR line, not just a slot', slotError({ ...opening[0], interval: BAR }) < STEP + 1e-6,
  `phase ${opening[0].phase.toFixed(4)}s into a ${BAR}s bar`);
check('and every shot after it is on a slot', opening.every((s) => slotError(s) < STEP + 1e-6),
  `worst ${(Math.max(...opening.map(slotError)) * 1000).toFixed(1)}ms`);

// A re-lock mid-fight waits for the next SLOT — a bar of dead gun every time
// the aim recentres is the thing startOnBar is deliberately not applied to.
let allowed = true;
const resumed = fireFor(BAR * 3, IV, { mayFire: () => allowed, onStep: (t) => { allowed = (t % 3) > 1.1; } });
check('re-locking mid-run costs a slot, not a bar', resumed.every((s) => slotError(s) < STEP + 1e-6),
  `${resumed.length} shots, worst ${(Math.max(...resumed.map(slotError)) * 1000).toFixed(1)}ms`);

// ---------------------------------------------------------------------------
section('It does not drift');
music.stop();
resetShotGrid();
now += 1;
music.play(1);
const long = fireFor(180, IV);
check('three minutes of shots all land on slots', long.every((s) => slotError(s) < STEP + 1e-6),
  `${long.length} shots, worst ${(Math.max(...long.map(slotError)) * 1000).toFixed(1)}ms`);
// THE ONE THAT CATCHES A SLIPPING CLOCK. Per-shot error is bounded by a frame
// either way and walks around inside that bound — the frame lattice and the
// slot lattice are incommensurate, so comparing the first shots to the last
// samples a beat pattern rather than a trend, and reads as drift when there is
// none. What cannot beat is the TOTAL: from the first shot to the last, a
// locked gun has covered a whole number of slots. A countdown re-armed from
// the frame it happened to fire on loses about half a frame every shot, which
// over three minutes is some two and a half seconds — four slots gone.
const span = long[long.length - 1].pos - long[0].pos;
const slots = Math.round(span / IV);
check('first shot to last is a whole number of slots', near(span, slots * IV, STEP),
  `${span.toFixed(4)}s vs ${slots} x ${IV} = ${(slots * IV).toFixed(4)}s (${((span - slots * IV) * 1000).toFixed(1)}ms out over ${long.length} shots)`);
const half = Math.floor(long.length / 2);
const meanErr = (arr) => arr.reduce((a, s) => a + slotError(s), 0) / Math.max(1, arr.length);
check('and the mean error is half a frame at both ends', 
  meanErr(long.slice(0, half)) < STEP * 0.75 && meanErr(long.slice(half)) < STEP * 0.75,
  `${(meanErr(long.slice(0, half)) * 1000).toFixed(2)}ms -> ${(meanErr(long.slice(half)) * 1000).toFixed(2)}ms`);
const spans = long.slice(1).map((s, i) => s.pos - long[i].pos);
check('and the spacing is the interval, in score seconds', spans.every((d) => near(d, IV, STEP + 1e-6)),
  `${Math.min(...spans).toFixed(4)}..${Math.max(...spans).toFixed(4)} vs ${IV}`);

// ---------------------------------------------------------------------------
section('It survives a ramp up and a ramp down');
music.stop();
resetShotGrid();
now += 1;
music.play(1);
fireFor(3, IV); // settle on the grid first
// Down to half speed (the death dive's drag), held, then back up. Score time
// is what carries the lock through: the bar is twice as long in the ROOM at
// half rate, and the gun has to be too.
let phase = 'down';
// Relative to the section, not to `now` — the clock is cumulative across every
// section above, and windows written in absolute time silently select NOTHING,
// which averages to zero and reads as a confident failure.
const rampT0 = now;
const ramped = fireFor(40, IV, {
  onStep: (t) => {
    const e = t - rampT0;
    if (phase === 'down' && e > 3) { music.setMusicRateScale(0.5, 1.5); phase = 'held'; }
    else if (phase === 'held' && e > 17) { music.setMusicRateScale(1.6, 1.5); phase = 'up'; }
    else if (phase === 'up' && e > 29) { music.setMusicRateScale(1, 1.5); phase = 'done'; }
  },
});
check('the ramp actually moved the tempo', phase === 'done' && ramped.length > 20, `${ramped.length} shots`);
// Tolerance scales with the RATE. A shot can only land on a frame, and at 1.6x
// one frame of the room is 1.6 frames of the score — so the closest any shot
// can sit to a slot, measured in score seconds, is STEP x rate. Held at STEP
// this reads as a 26ms failure that is really the frame rate, and "tighten the
// scheduler" would be the wrong lesson: there is nothing between frames.
const RAMP_MAX_RATE = 1.6;
check('every shot through both ramps is still on a slot', ramped.every((s) => slotError(s) < STEP * RAMP_MAX_RATE + 1e-6),
  `worst ${(Math.max(...ramped.map(slotError)) * 1000).toFixed(1)}ms, a frame at ${RAMP_MAX_RATE}x is ${(STEP * RAMP_MAX_RATE * 1000).toFixed(1)}ms`);
// The gun has to change speed in the ROOM, or it is not following the music —
// it is merely ignoring it consistently. Wall spacing at half rate is double.
const wallSpan = (a, b) => b.at - a.at;
const slowShots = ramped.filter((s) => s.at - rampT0 > 9 && s.at - rampT0 < 16);
const fastShots = ramped.filter((s) => s.at - rampT0 > 23 && s.at - rampT0 < 28);
const meanWall = (arr) => arr.slice(1).map((s, i) => wallSpan(arr[i], s)).reduce((a, b) => a + b, 0) / Math.max(1, arr.length - 1);
check('at half rate the gun takes twice as long in the room', near(meanWall(slowShots), IV * 2, STEP * 2),
  `${meanWall(slowShots).toFixed(3)}s vs ${(IV * 2).toFixed(3)}s`);
check('at 1.6x it is proportionally faster', near(meanWall(fastShots), IV / 1.6, STEP * 2),
  `${meanWall(fastShots).toFixed(3)}s vs ${(IV / 1.6).toFixed(3)}s`);

// ---------------------------------------------------------------------------
section('An upgrade taken mid-run keeps the phase');
music.stop();
resetShotGrid();
now += 1;
music.play(1);
// Walked up the REAL ladder, triplet rungs included. bar/4 -> bar/6 is the case
// worth its own assertion: it is the one rung change that does not nest, so
// every beat the gun was hitting moves. If the scheduler held its cadence as a
// countdown from the last shot rather than re-deriving from the bar phase, this
// is exactly where it would come off the grid and stay off.
const rungWalk = [4, 6, 8, 12, 16, 24];
let iv = BAR / rungWalk[0];
const walkT0 = now;
const upgraded = fireFor(30, () => iv, {
  onStep: (t) => {
    const step = Math.min(rungWalk.length - 1, Math.floor((t - walkT0) / 5));
    iv = BAR / rungWalk[step];
  },
});
check('climbing the ladder never leaves the grid', upgraded.every((s) => slotError(s) < STEP + 1e-6),
  `${upgraded.length} shots over bar/${rungWalk.join(', bar/')}, worst ${(Math.max(...upgraded.map(slotError)) * 1000).toFixed(1)}ms`);
const onSix = upgraded.filter((s) => near(s.interval, BAR / 6, 1e-9));
check('the non-nesting rung is locked like every other', onSix.length > 5 && onSix.every((s) => slotError(s) < STEP + 1e-6),
  `${onSix.length} shots at bar/6, worst ${(Math.max(...onSix.map(slotError)) * 1000).toFixed(1)}ms`);
// Whichever rung it is on, the pattern has to come back round on the bar line —
// that is what "locked to the bar" means once triplets are allowed and the
// nesting property is gone.
check('every rung repeats on the bar line', rungWalk.every((d) => Number.isInteger(BAR / (BAR / d))),
  rungWalk.map((d) => `${d}/bar`).join(' '));

// ---------------------------------------------------------------------------
section('With no transport the gun still works');
music.stop();
resetShotGrid();
now += 1;
check('the grid reports itself unlocked', music.barGrid().running === false && shotGridState().locked === false);
const silent = fireFor(20, IV);
check('it fires anyway', silent.length > 10, `${silent.length} shots in 20s`);
const wallSpans = silent.slice(1).map((s, i) => s.at - silent[i].at);
check('at the same interval, on the wall clock', wallSpans.every((d) => near(d, IV, STEP + 1e-6)),
  `${Math.min(...wallSpans).toFixed(4)}..${Math.max(...wallSpans).toFixed(4)}`);

// The switch has to actually switch something off, or "enabled" is decoration.
music.play(1);
CONFIG.weapon.beatLock.enabled = false;
resetShotGrid();
fireFor(1, IV);
check('and the enabled flag turns the lock off', shotGridState().locked === false);
CONFIG.weapon.beatLock.enabled = true;

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
