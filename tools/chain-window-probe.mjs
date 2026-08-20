// Scratch: how wide is the release window in FRAMES, and where do the tells land.
import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import {
  strikeState, resetStrike, updateCharge, tryStrike, feedChum, updateStrike,
  strikeLoaded, sweetHalfWidth, sweetOffset, inSweetSpot, perfectCrossed,
  consumeChainLink, liveChain, cancelDash,
} from '../path/src/systems/strike.js';
import { createStrikeRing, updateStrikeRing, resetStrikeRing } from '../path/src/systems/strikeRing.js';

const stats = {
  strikeChumRefill: CONFIG.strike.charge.chumRefill,
  strikeChargeTime: CONFIG.strike.charge.time,
  strikeDashDuration: CONFIG.strike.dashDuration,
  strikeDashSpeed: CONFIG.strike.dashSpeed,
  strikeChainMul: CONFIG.strike.chainDamageMul,
  strikeDamage: CONFIG.strike.damage,
};
const DIR = { x: 1, y: 0 };
const half = sweetHalfWidth(stats);

// Hold for `frames` frames from a full tank, then release on the next frame.
// Returns what the player SAW on the last frame before letting go, and what
// tryStrike actually measured.
function trial(DT, holdFrames) {
  resetStrike();
  for (let i = 0; i < 5; i++) { feedChum(stats); consumeChainLink(); } // fill the tank
  let seen = -Infinity, tellFrame = -1, loadedFrame = -1;
  for (let f = 0; f < holdFrames; f++) {
    updateCharge(DT, true, stats);
    if (perfectCrossed()) tellFrame = f;
    if (loadedFrame < 0 && strikeLoaded()) loadedFrame = f;
    seen = sweetOffset();                       // what the HUD would draw this frame
  }
  updateCharge(DT, false, stats);               // the release frame
  const measured = sweetOffset();
  const sweet = inSweetSpot(stats);
  const fired = tryStrike(DIR, stats);
  feedChum(stats); consumeChainLink();          // one chum swum through
  const chain = liveChain();
  cancelDash();
  return { seen, measured, sweet, fired, chain, tellFrame, loadedFrame };
}

for (const [label, DT] of [['60 fps', 1 / 60], ['30 fps', 1 / 30]]) {
  console.log(`\n=== ${label} — full tank, ${CONFIG.strike.charge.time}s wind-up, sweet +/-${(half * 1000).toFixed(0)}ms ===`);
  console.log('hold   HUD shows   tryStrike sees   armed?  chain   note');
  const loadFrame = Math.round(CONFIG.strike.charge.time / DT);
  for (let f = loadFrame - 6; f <= loadFrame + 6; f++) {
    if (f < 1) continue;
    const r = trial(DT, f);
    const ms = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 1000).toFixed(0)}ms` : '  --');
    const note = f === r.loadedFrame + 1 ? '<- "STRIKE NOW!" / PERFECT appears here' : '';
    console.log(
      String(f).padStart(4),
      ms(r.seen).padStart(11),
      ms(r.measured).padStart(15),
      (r.sweet ? '  YES ' : '   no ').padStart(9),
      `  x${r.chain}`.padStart(6),
      ' ', note,
    );
  }
}

// How much of the window survives the tell.
console.log(`\nThe tell fires at offset 0. Window after it: ${(half * 1000).toFixed(0)}ms.`);
console.log(`Frames of window at 60fps: ${(2 * half / (1 / 60)).toFixed(1)}   at 30fps: ${(2 * half / (1 / 30)).toFixed(1)}`);


// ---------------------------------------------------------------------------
// THE CUE AND THE GATE MUST AGREE, FRAME FOR FRAME.
//
// The lead-in exists to tell the player when a release would arm. If it says
// green on a frame the gate would refuse — or stays blue on a frame that would
// arm — it is worse than no cue at all, because the player would be learning
// the wrong moment. So: drive the real model, and on every frame compare what
// the ring DRAWS against what tryStrike would DO.
// ---------------------------------------------------------------------------
const ring = createStrikeRing();
const U = ring.material.uniforms;
const ORIGIN = { x: 0, y: 0, z: 0 };

function auditLead(DT, label) {
  resetStrike(); resetStrikeRing();
  for (let i = 0; i < 5; i++) { feedChum(stats); consumeChainLink(); }
  const rows = [];
  let disagreements = 0;
  for (let f = 0; f < Math.round(1.6 / DT); f++) {
    updateCharge(DT, true, stats);
    updateStrikeRing(DT, ORIGIN, strikeState, true, stats);
    // What the ring is saying this frame...
    const saysArm = U.uLeadGlow.value > 0 && U.uLeadHit.value > 0.5;
    // ...against what a release on this frame would actually do. inSweetSpot
    // is what tryStrike asks, and with the button already up the offset no
    // longer moves, so this IS the release frame's verdict.
    const wouldArm = strikeState.pending >= CONFIG.strike.charge.minFire && inSweetSpot(stats);
    if (saysArm !== wouldArm) disagreements++;
    if (U.uLeadGlow.value > 0 || saysArm !== wouldArm) {
      rows.push({ f, off: sweetOffset(), r: U.uLeadR.value, saysArm, wouldArm, glow: U.uLeadGlow.value });
    }
  }
  console.log(`\n--- ${label} ---`);
  console.log('frame   offset    traveller r   ring says   gate would   ');
  for (const r of rows) {
    const off = Number.isFinite(r.off) ? `${r.off >= 0 ? '+' : ''}${(r.off * 1000).toFixed(0)}ms` : '  --';
    console.log(
      String(r.f).padStart(5),
      off.padStart(8),
      r.r.toFixed(3).padStart(13),
      (r.saysArm ? 'RELEASE' : '   .   ').padStart(12),
      (r.wouldArm ? 'arm' : ' . ').padStart(12),
      r.saysArm !== r.wouldArm ? '   <<< DISAGREES' : '',
    );
  }
  console.log(`${disagreements === 0 ? 'ok  ' : 'FAIL'} the cue and the gate agreed on all ${Math.round(1.6 / DT)} frames`);
  return disagreements;
}

let bad = 0;
bad += auditLead(1 / 60, '60 fps');
bad += auditLead(1 / 30, '30 fps');
console.log(bad === 0 ? '\nlead-in verified' : `\n${bad} DISAGREEMENTS`);
