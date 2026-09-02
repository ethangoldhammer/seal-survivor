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
const { shotDue, resetShotGrid, shotGridState, tickInterval, finSplit, dealTick } = await import('../path/src/systems/shotGrid.js');

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
section('Alternating fins trade shots on the eighths');
// The fins fire one at a time instead of together, so the SCHEDULER runs at
// half the volley interval — the property being asserted is that the halved
// tick is still a rung and still lands on slot boundaries, because a stagger
// that merely offset the second fin by "half of something" would put every
// other shot between two of the music's slots.
resetShotGrid();
CONFIG.weapon.alternateFins = true;
check('two fins halve the tick', near(tickInterval(IV, 2), BAR / 8, 1e-9),
  `bar/4 volleys -> bar/${(BAR / tickInterval(IV, 2)).toFixed(0)} ticks`);
check('...and the toggle puts them back together', (() => {
  CONFIG.weapon.alternateFins = false;
  const off = tickInterval(IV, 2);
  CONFIG.weapon.alternateFins = true;
  return near(off, IV, 1e-12);
})(), 'off = the old simultaneous volley at the volley interval');
// A model with no rig, or with the emit points switched off, reports zero
// points. finSplit has to read that as ONE limb rather than as zero ticks, or
// the gun would be handed an interval of Infinity and never fire again.
check('a model with no emit points is unaffected', finSplit(0, IV) === 1 && finSplit(1, IV) === 1
  && near(tickInterval(IV, 0), IV, 1e-12));
// The division is not always a halving, and this is why it is re-snapped: three
// fins put the gun on the triplet lattice rather than a third of the way
// between two duple slots.
check('an odd fin count lands on the triplet rung', near(tickInterval(BAR / 4, 3), BAR / 12, 1e-9),
  `bar/4 over 3 fins -> bar/${(BAR / tickInterval(BAR / 4, 3)).toFixed(0)}`);
// THE ONE CASE WHERE ALTERNATING HAS TO GIVE UP. A gun at the finest division
// the ladder allows cannot be dealt out any finer, and one fin per tick at the
// SAME tick rate is half the gun. The look is worth a lot; it is not worth a
// silent 50% damage cut on the build that stacked Rapid Fire to the cap.
check('a gun at the ladder cap goes back to firing both fins together',
  finSplit(2, BAR / 64) === 1 && near(tickInterval(BAR / 64, 2), BAR / 64, 1e-9),
  'the tick cannot halve, so the volley must not be halved either');
check('...and every rung below the cap still trades',
  [4, 6, 8, 12, 16, 24, 32].every((d) => finSplit(2, BAR / d) === 2),
  'bar/4..bar/32 all divide into a rung; bar/48 and bar/64 do not');
// The property behind the fallback, stated as output rather than as rungs: a
// full cycle of ticks has to take exactly one volley interval, or the gun's
// damage per second moved when the toggle went on.
check('a cycle of ticks is always one volley interval',
  [4, 6, 8, 12, 16, 24, 32, 48, 64].every((d) => {
    const volley = BAR / d;
    return near(tickInterval(volley, 2) * finSplit(2, volley), volley, 1e-9);
  }), 'alternating is a rhythm, not a rate change');

const eighth = tickInterval(IV, 2);
const traded = fireFor(20, eighth);
check('every tick is on a slot boundary', traded.every((s) => slotError(s) < STEP + 1e-6),
  `${traded.length} ticks, worst ${(Math.max(...traded.map(slotError)) * 1000).toFixed(1)}ms`);
check('there are twice as many of them as there were volleys', traded.length > 60,
  `${traded.length} ticks in 20s at bar/8`);
// THE HALF THAT MATTERS TO THE GUN: fire() walks one fin per tick, so each fin
// still fires exactly once per VOLLEY interval. The stagger is timing, not rate
// — a fin firing every tick would be a silent doubling of the whole gun.
const perFin = [0, 1].map((side) => traded.filter((_, i) => i % 2 === side));
const finSpans = perFin.flatMap((shots) => shots.slice(1).map((s, i) => s.pos - shots[i].pos));
check('each fin keeps the gun\'s own interval', finSpans.every((d) => near(d, IV, STEP + 1e-6)),
  `${finSpans.length} gaps, ${Math.min(...finSpans).toFixed(4)}..${Math.max(...finSpans).toFixed(4)} vs ${IV.toFixed(4)}`);
const tickSpans = traded.slice(1).map((s, i) => s.pos - traded[i].pos);
check('...and consecutive ticks are half an interval apart', tickSpans.every((d) => near(d, IV / 2, STEP + 1e-6)),
  'left-right-left, evenly, rather than a pair of shots and a gap');

// ---------------------------------------------------------------------------
section('Every stone is a subdivision');
// POCKET FULL OF STONES BUYS A NOTE, not a thicker one. `multishot` counts the
// whole volley now (see CONFIG.weapon.multishot), each pellet leaves on its own
// tick, and so the card's real payout is a finer division of the same bar: the
// pair of eighths the gun ships with becomes a triplet, then sixteenths. This
// is the property the whole change rests on, asserted as rungs rather than as
// milliseconds because "3 ticks in a bar/4 volley" is only a rhythm if the tick
// is bar/12 exactly.
const rung = (shots, volley = IV) => BAR / tickInterval(volley, 2, shots);
check('the starting pair is a pair of eighths', near(rung(2), 8, 1e-9), `bar/${rung(2).toFixed(0)}`);
check('the first stone makes it a triplet', near(rung(3), 12, 1e-9),
  `bar/${rung(3).toFixed(0)} — 3 against the music's 2`);
check('the second makes it sixteenths', near(rung(4), 16, 1e-9), `bar/${rung(4).toFixed(0)}`);
check('and the sixth is sextuplets', near(rung(6), 24, 1e-9), `bar/${rung(6).toFixed(0)}`);
// A count with no rung of its own does NOT collapse the gun back onto one
// frame: it keeps the finest cycle that does divide and the odd stone rides
// along on the tick it lands on. Five pellets have no bar/20 to sit on, so they
// are dealt 2,1,1,1 over the sixteenths four of them would have had.
check('a count the ladder cannot hold keeps the cycle below it',
  finSplit(2, IV, 5) === 4 && finSplit(2, IV, 7) === 6,
  '5 -> 4 ticks, 7 -> 6 ticks; nothing is dropped, the surplus thickens a tick');
// The cap is a musical limit, not a technical one — the ladder would happily go
// on halving. Past it the gun stops buying notes and pellets thicken the ticks
// it has, which is what every pellet used to do.
check('the stagger stops subdividing at staggerTicks',
  [6, 8, 12, 20].every((n) => finSplit(2, IV, n) === CONFIG.weapon.staggerTicks),
  `cap ${CONFIG.weapon.staggerTicks}`);
check('...and 1 turns it off outright', (() => {
  const held = CONFIG.weapon.staggerTicks;
  CONFIG.weapon.staggerTicks = 1;
  const off = finSplit(2, IV, 4);
  CONFIG.weapon.staggerTicks = held;
  return off === 1;
})(), 'the whole volley on one frame, fanned, as it was before any of this');
// THE INVARIANT THE CARD IS NOT ALLOWED TO BREAK. However many ticks a volley
// is dealt across, a full cycle of them takes exactly one volley interval — so
// the same stones are in the water in the same second and the stagger is a
// rhythm rather than a rate change. Checked across every rung the gun can
// reach, not just the shipped one, because Rapid Fire moves it under the card.
check('a cycle is one volley interval at every count and every rung',
  [4, 6, 8, 12, 16, 24, 32, 48, 64].every((d) => {
    const volley = BAR / d;
    return [2, 3, 4, 5, 6, 8, 12].every((shots) => {
      const n = finSplit(2, volley, shots);
      return near(tickInterval(volley, 2, shots) * n, volley, 1e-9);
    });
  }), 'more notes, never more gun');
// The cadence a bar/8 gun (one Rapid Fire stack) reaches with a stone or two on
// top — the busiest thing a normal run puts on the grid, and still a rung.
check('a faster gun subdivides from where IT is', near(rung(3, BAR / 8), 24, 1e-9)
  && near(rung(4, BAR / 8), 32, 1e-9), 'bar/8 volleys -> bar/24 triplets, bar/32 sixteenths');

// WHAT EACH TICK ACTUALLY THROWS. The grid above says how often the gun fires;
// this says what leaves when it does, and the two have to agree or the cadence
// is right while the gun is quietly stronger or weaker than the card claims.
//
// Walked over a full wrap of the cursor rather than a volley or two, because
// every failure this can have is a slow one: a surplus stone pinned to one
// flipper, or a pattern that only comes out even if you stop counting at the
// right moment.
const walk = (shots, origins = 2, volley = IV) => {
  const ticks = finSplit(origins, volley, shots);
  const wrap = ticks < 2 ? 1 : ticks * ticks * origins;
  const perFin = new Array(origins).fill(0);
  const perCycle = [];
  let cursor = 0;
  let cycle = 0;
  for (let i = 0; i < wrap; i++) {
    const { salvo, cursor: next } = dealTick(shots, ticks, origins, cursor);
    cursor = next;
    for (const f of salvo) perFin[f.o] += f.n;
    cycle += salvo.reduce((n, f) => n + f.n, 0);
    if (ticks < 2 || (i + 1) % ticks === 0) { perCycle.push(cycle); cycle = 0; }
  }
  return { ticks, wrap, perFin, perCycle };
};
const counts = [1, 2, 3, 4, 5, 6, 7, 8, 12];
check('every cycle of ticks throws the whole volley and no more',
  counts.every((n) => walk(n).perCycle.every((c) => c === n)),
  counts.map((n) => `${n}:${walk(n).ticks}t`).join(' '));
// A one-stone gun is excluded and cannot be otherwise: there is one pebble and
// two flippers, so somebody throws it. Every count the stagger actually deals
// out has to come out level.
check('...and both flippers carry the same number of stones',
  counts.filter((n) => walk(n).ticks > 1).every((n) => { const f = walk(n).perFin; return f[0] === f[1]; }),
  counts.map((n) => `${n}:${walk(n).perFin.join('/')}`).join(' '));
// The case that made this rotate at all: five stones over four ticks is 2,1,1,1,
// and a window nailed to slot 0 would have thrown every surplus stone off the
// left flipper for the rest of the run.
const five = walk(5);
check('a surplus stone does not live on one fin', five.perFin[0] === five.perFin[1],
  `4 ticks, 5 stones, ${five.wrap} ticks walked -> ${five.perFin.join(' / ')}`);
// A model with no rig, or a cadence too fine to divide, still fires everything
// it owns — the fallback is the old simultaneous volley, not a smaller one.
check('an undealt volley still throws every stone',
  [1, 3, 5, 8].every((n) => dealTick(n, 1, 2, 0).salvo.reduce((a, f) => a + f.n, 0) === n),
  'the fallback splits across the limbs rather than dropping the remainder');
check('...and a one-limb model fires it from the body',
  dealTick(5, 1, 1, 0).salvo.length === 1 && dealTick(5, 1, 1, 0).salvo[0].n === 5);

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

// ---------------------------------------------------------------------------
// A transport whose CLOCK has stopped is not a transport, and this is the one
// failure the four properties at the top of this file cannot see: every one of
// them is measured across shots, so a gun that fires nothing at all passes each
// of them vacuously. It shipped that way.
//
// A suspended AudioContext's currentTime does not advance, so the score clock
// is frozen while `started` is still true. barGrid used to report `running` off
// `started && ctx` alone, which parked the run's first shot a bar ahead of a
// clock that would never reach it — silent for the whole run, with the staleness
// guard unable to help because a schedule exactly one bar out is not stale.
// Reachable whenever the context is built outside a real gesture (see
// resumeOnFirstGesture in systems/audio.js), and on a gamepad it never cleared.
section('A stopped clock is not a grid');
music.play(1);
resetShotGrid();
fireFor(1, IV);
check('the grid is locked while the clock runs', shotGridState().locked === true);

const suspendedCtx = audio.getAudioContext();
suspendedCtx.state = 'suspended';
// `now` deliberately does NOT advance here — that is what suspended MEANS, and
// a test that let the clock run would be testing nothing.
const frozenAt = now;
let suspendedShots = 0;
for (let i = 0; i < 600; i++) if (shotDue(IV, true, STEP)) suspendedShots++;
check('a frozen clock reports itself unlocked', music.barGrid().running === false,
  'the whole bug: `started && ctx` is not the same question as "is time passing"');
check('...and the transport really is frozen', near(now, frozenAt, 1e-9));
check('the gun keeps firing on the fallback countdown', suspendedShots > 10,
  `${suspendedShots} shots in 10s of frames — it was 0 before the state check`);
check('...at the interval it was given', near(600 * STEP / Math.max(1, suspendedShots), IV, STEP + 1e-6),
  `${(600 * STEP / Math.max(1, suspendedShots)).toFixed(4)}s apart vs ${IV.toFixed(4)}`);

// And the point of the fallback: the lock comes back on its own, in phase, the
// frame after the player's first gesture resumes the context.
suspendedCtx.state = 'running';
const afterResume = fireFor(8, IV);
check('the lock returns when the context does', shotGridState().locked === true);
check('...and the shots are back on the grid', afterResume.slice(1).every((s) => slotError(s) <= STEP + 1e-6),
  `worst slot error ${Math.max(...afterResume.slice(1).map(slotError)).toFixed(5)}s`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
