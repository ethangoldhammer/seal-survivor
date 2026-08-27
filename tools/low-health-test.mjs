#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:lowhp
//
// THE NEAR-DEATH RAMP — systems/lowHealthFx.js. The curve that decides when
// the frame starts closing in, how fast it gets there, and how fast the heart
// is beating while it does.
//
// This is the STATE half of damage feedback. The event half — the rim flash,
// the shake, the grunt on the frame a bite lands — is tools/damage-fx-test.mjs,
// and the two are deliberately separate systems: one is a spike that decays in
// under half a second, this one eases in over a third of a second and then
// stays until the seal is out of trouble.
//
// Four things here go wrong in ways that look completely fine at 60fps:
//
//   THE FRAME RATE   the ease is exponential, and the naive form (`* 0.9` per
//                    frame) eases more than twice as fast on a 144Hz monitor
//                    as on a 60Hz one. Both look smooth. Only running the same
//                    seconds at three step sizes can tell them apart, which is
//                    the FRAMERATE section below.
//   THE MAX          strain is a fraction of the CURRENT bar, and max HP
//                    roughly doubles over a long run. Divide by CONFIG's base
//                    value instead of player.stats.maxHp and the screen goes
//                    red at a bar that is still a third full — on exactly the
//                    builds that stacked health, which is to say the ones
//                    least in danger.
//   THE TAIL         an exponential approach never actually arrives. A strain
//                    of 0.0009 is invisible and still counts as "running",
//                    which pins the whole post pipeline on for the rest of a
//                    run that recovered ages ago. That is a frame-rate cost,
//                    not a visual bug, so nothing on screen would ever show it.
//   THE BEAT         the interval shortens as the strain rises. Derive the
//                    phase from a clock (`now / interval`) rather than
//                    integrating it and the heart teleports mid-thump every
//                    time the rate changes — which reads as a stutter, and is
//                    invisible in any single frame.
//
// Everything expected is derived from CONFIG rather than typed, because saved
// tuning is merged over the defaults at import (see imported-tuning.json): a
// hardcoded 0.15 here would be a test of the tuning file rather than of the
// code.
//
// What it cannot tell you: whether the vignette LOOKS like anything. A Node
// harness cannot see a fragment shader at all. That is `npm run looks:hurt`,
// which renders the shipping post chain and measures the actual pixels.
//
//   node --import ./tools/vite-loader.mjs tools/low-health-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import {
  updateLowHealthFx,
  resetLowHealthFx,
  lowHealthVignette,
  lowHealthFxState,
  heartbeat,
} from '../path/src/systems/lowHealthFx.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const CFG = CONFIG.fx.lowHealth;
const THRESHOLD = CFG.threshold;

/** A player at a given fraction of a given bar. */
const sealAt = (frac, maxHp = 100) => ({ hp: frac * maxHp, stats: { maxHp } });

/**
 * Hold the seal at `frac` for `seconds` and return where the strain settled.
 * Stepped rather than solved, because the step is the thing under test.
 */
function settle(frac, seconds, { dt = 1 / 60, maxHp = 100, active = true } = {}) {
  const seal = sealAt(frac, maxHp);
  for (let t = 0; t < seconds; t += dt) updateLowHealthFx(dt, seal, active);
  return lowHealthFxState.strain;
}

console.log(`\nthreshold ${(THRESHOLD * 100).toFixed(0)}% of the bar`
  + `   ramp strain^${CFG.rampCurve}   ease ${CFG.attack}s in / ${CFG.release}s out`
  + `   heart ${CFG.beatFar}s → ${CFG.beatNear}s`);

// ---------------------------------------------------------------------------
section('DORMANT ABOVE THE THRESHOLD');
// Most frames of most runs. Nothing may run at all — this is what keeps the
// post pipeline off for a player with bloom and the screen filter switched off.
for (const frac of [1, 0.5, THRESHOLD + 0.05, THRESHOLD + 0.001]) {
  resetLowHealthFx();
  const s = settle(frac, 4);
  check(`${(frac * 100).toFixed(1)}% health is completely dormant`,
    s === 0 && lowHealthVignette() === 0, `strain ${s}`);
}

resetLowHealthFx();
settle(THRESHOLD - 0.0001, 4);
check('...and one hair BELOW it is on, however faintly', lowHealthFxState.strain > 0,
  `strain ${lowHealthFxState.strain.toExponential(2)}`);

// ---------------------------------------------------------------------------
section('THE RAMP');
resetLowHealthFx();
const atEmpty = settle(0, 6);
check('an empty bar pins the ramp at full', atEmpty > 0.99 && lowHealthVignette() > 0.99,
  `strain ${atEmpty.toFixed(4)} → vignette ${lowHealthVignette().toFixed(4)}`);

// Monotonic on the way down: a ramp that backs up mid-way reads as a glitch
// rather than as a slide.
const walk = [];
for (let i = 0; i <= 15; i++) {
  const frac = THRESHOLD * (1 - i / 15);
  resetLowHealthFx();
  settle(frac, 6);
  walk.push({ frac, v: lowHealthVignette() });
}
check('it only ever gets worse as the bar empties',
  walk.every((w, i) => i === 0 || w.v > walk[i - 1].v - 1e-9),
  walk.filter((_, i) => i % 5 === 0).map((w) => w.v.toFixed(2)).join(' → ') + ` → ${walk.at(-1).v.toFixed(2)}`);

// THE CURVE, and the reason it is below 1. Health can drop 50% in one bite, so
// the crossing itself has to be the moment the player notices — an effect that
// is still at 3% of its strength a third of the way down the last sliver has
// spent the crossing on nothing. Measured at the MIDPOINT of the band because
// that is where the two curve directions differ most.
resetLowHealthFx();
settle(THRESHOLD * 0.5, 6);
const half = lowHealthVignette();
check('half way through the last sliver is already well past subtle', half > 0.45,
  `${(half * 100).toFixed(0)}% of full at ${(THRESHOLD * 50).toFixed(1)}% health`);

// ---------------------------------------------------------------------------
section('A FRACTION OF THE BAR, NOT A DAMAGE NUMBER');
// The Blubber trap. Same fraction of two very different bars has to read the
// same, or a health build gets the emergency screen while it is still safe —
// or, worse, does not get it when it is not.
resetLowHealthFx();
settle(0.5 * THRESHOLD, 6, { maxHp: 100 });
const small = lowHealthVignette();
resetLowHealthFx();
settle(0.5 * THRESHOLD, 6, { maxHp: 340 });
const big = lowHealthVignette();
check('the same fraction of a 340hp bar reads the same as a 100hp one',
  Math.abs(small - big) < 1e-6, `${small.toFixed(4)} vs ${big.toFixed(4)}`);

// ...and the same RAW health on the two bars must NOT.
resetLowHealthFx();
settle(12 / 100, 6, { maxHp: 100 });
const raw100 = lowHealthVignette();
resetLowHealthFx();
settle(12 / 340, 6, { maxHp: 340 });
const raw340 = lowHealthVignette();
check('...while 12 health left is a bigger emergency on the smaller bar',
  raw340 > raw100 + 0.1, `12/340 → ${raw340.toFixed(2)}, 12/100 → ${raw100.toFixed(2)}`);

// ---------------------------------------------------------------------------
section('FRAMERATE INDEPENDENCE');
// The original sin of every eased effect. Half a second of ease from clean to
// empty, run at three step sizes — they have to agree, or the effect arrives
// at a different speed depending on the monitor.
const partials = [1 / 30, 1 / 60, 1 / 144].map((dt) => {
  resetLowHealthFx();
  return { dt, s: settle(0, 0.5, { dt }) };
});
const spread = Math.max(...partials.map((p) => p.s)) - Math.min(...partials.map((p) => p.s));
check('half a second of ease-in lands in the same place at 30/60/144fps', spread < 0.02,
  partials.map((p) => `${Math.round(1 / p.dt)}fps ${p.s.toFixed(3)}`).join('  '));

// ---------------------------------------------------------------------------
section('EASING OUT');
resetLowHealthFx();
settle(0, 6);
const before = lowHealthFxState.strain;
// One frame of full health does NOT clear it — that would be the snap the ease
// exists to avoid.
updateLowHealthFx(1 / 60, sealAt(1), true);
check('a heal does not snap the frame clean in one step',
  lowHealthFxState.strain > before * 0.9,
  `${before.toFixed(3)} → ${lowHealthFxState.strain.toFixed(3)}`);

// ...but it does get there, and it gets there at a TRUE zero rather than at an
// asymptote, or the post pipeline stays switched on for the rest of the run.
settle(1, 8);
check('...and it does reach exactly zero, not an asymptote',
  lowHealthFxState.strain === 0 && lowHealthVignette() === 0,
  `strain ${lowHealthFxState.strain}`);

// The asymmetry: arriving in trouble is quicker than leaving it. Measured as
// the time to cross halfway in each direction.
function crossTime(fromFrac, toFrac, target, up) {
  resetLowHealthFx();
  settle(fromFrac, 8);
  const seal = sealAt(toFrac);
  const dt = 1 / 240;
  for (let t = 0; t < 12; t += dt) {
    updateLowHealthFx(dt, seal, true);
    if (up ? lowHealthFxState.strain >= target : lowHealthFxState.strain <= target) return t;
  }
  return Infinity;
}
const inT = crossTime(1, 0, 0.5, true);
const outT = crossTime(0, 1, 0.5, false);
check('it arrives faster than it leaves', inT < outT,
  `in ${inT.toFixed(2)}s, out ${outT.toFixed(2)}s`);

// ---------------------------------------------------------------------------
section('INACTIVE — THE SCORE CARD');
// `active` false is death, the pause menu and the upgrade screen. The effect
// has to walk DOWN rather than freeze, or the score card is served under the
// last red frame of the fight.
resetLowHealthFx();
settle(0, 6);
const held = lowHealthFxState.strain;
settle(0, 3, { active: false });
check('a dead seal still on 0hp walks the frame clean anyway',
  lowHealthFxState.strain < held * 0.1,
  `${held.toFixed(3)} → ${lowHealthFxState.strain.toFixed(3)}`);

// ---------------------------------------------------------------------------
section('THE HEART');
// The shape, stepped directly rather than sampled off whatever frames happen
// to land. Two thumps per cycle and a quiet stretch after them.
const lub = heartbeat(0);
const dub = heartbeat(0.26);
const quiet = heartbeat(0.62);
check('the beat is a lub-dub pair, not a single blink',
  lub > 0.95 && dub > 0.35 && dub < lub && quiet < 0.05,
  `lub ${lub.toFixed(2)}, dub ${dub.toFixed(2)}, rest ${quiet.toFixed(3)}`);

// The wrap. The lub sits at phase 0, so half of it lives at the end of the
// previous cycle; without the mirrored spike the sharpest part of the beat is
// sliced flat every single cycle.
check('...and it is continuous across the cycle boundary',
  Math.abs(heartbeat(0.999) - heartbeat(0.001)) < 0.02,
  `${heartbeat(0.999).toFixed(3)} vs ${heartbeat(0.001).toFixed(3)}`);

check('the beat never leaves 0..1',
  Array.from({ length: 400 }, (_, i) => heartbeat(i / 400)).every((v) => v >= 0 && v <= 1));

/** Beats counted as rising EDGES over a held second — see the note below. */
function beatsPerSecond(frac, seconds = 20) {
  resetLowHealthFx();
  settle(frac, 8);
  const seal = sealAt(frac);
  const dt = 1 / 120;
  let beats = 0;
  let wasLow = lowHealthFxState.beat < 0.5;
  for (let t = 0; t < seconds; t += dt) {
    updateLowHealthFx(dt, seal, true);
    const high = lowHealthFxState.beat > 0.8;
    if (high && wasLow) beats++;
    if (lowHealthFxState.beat < 0.3) wasLow = true;
    else if (high) wasLow = false;
  }
  return beats / seconds;
}
// EDGES, not frames above a threshold. Counting frames is the mistake that
// once turned one event into 182 of them elsewhere in this codebase, and it
// would be silently wrong here too: the beat is above any threshold for a
// number of frames that itself depends on the rate being measured.
const slow = beatsPerSecond(THRESHOLD * 0.98);
const fast = beatsPerSecond(0.001);
check('the heart is measurably faster on an empty bar', fast > slow * 1.4,
  `${slow.toFixed(2)}/s at the threshold → ${fast.toFixed(2)}/s at empty`);
// Against the configured intervals rather than against a number typed here.
// The dub is the second thump of the SAME beat and is under the 0.8 edge, so
// only the lub is counted — one per cycle.
check('...at about the configured rate',
  Math.abs(fast - 1 / CFG.beatNear) < 0.2 && Math.abs(slow - 1 / CFG.beatFar) < 0.2,
  `expected ${(1 / CFG.beatFar).toFixed(2)}/s → ${(1 / CFG.beatNear).toFixed(2)}/s`);

// The phase is INTEGRATED, so speeding the heart up cannot teleport it. Walk
// the seal down through the whole band and watch for a step no single frame
// could have produced.
resetLowHealthFx();
let biggest = 0;
const dt = 1 / 120;
for (let i = 0; i < 1200; i++) {
  const frac = THRESHOLD * (1 - i / 1200);
  const was = lowHealthFxState.beatPhase;
  updateLowHealthFx(dt, sealAt(frac), true);
  let step = lowHealthFxState.beatPhase - was;
  if (step < 0) step += 1; // an ordinary wrap, not a jump
  biggest = Math.max(biggest, step);
}
check('shortening the interval never jumps the heart mid-thump',
  biggest < dt / CFG.beatNear + 1e-6,
  `biggest phase step ${biggest.toFixed(5)}, one frame at the fastest rate is ${(dt / CFG.beatNear).toFixed(5)}`);

check('the heart stops dead when the effect does',
  (() => {
    resetLowHealthFx();
    settle(0, 4);
    settle(1, 8);
    return lowHealthFxState.beat === 0 && lowHealthFxState.beatPhase === 0;
  })(),
  'parked at phase 0, so the next emergency arrives ON a beat');

// ---------------------------------------------------------------------------
section('THE OFF SWITCH');
const wasEnabled = CFG.enabled;
CFG.enabled = false;
resetLowHealthFx();
settle(0, 6);
check('CONFIG.fx.lowHealth.enabled false costs nothing at all',
  lowHealthFxState.strain === 0 && lowHealthVignette() === 0 && lowHealthFxState.beat === 0);
CFG.enabled = wasEnabled;

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
