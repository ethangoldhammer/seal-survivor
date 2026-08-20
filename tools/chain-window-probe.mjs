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
// WHICH GATE. The lead-in tracks the SWEET SPOT, and the sweet spot is the
// DAMAGE gate — riderDamage, strikeBurst and the contact bite all return zero
// outside it. It is no longer what arms a food chain; a perfect charge does
// that on its own, at any timing (see tryStrike). The two used to be one
// condition and the cue must follow the one it is actually drawing, or it
// teaches the wrong moment — which is worse than drawing nothing.
//
// So: drive the real model, and on every frame compare what the ring DRAWS
// against what a release on that frame would actually be worth.
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
    const saysHit = U.uLeadGlow.value > 0 && U.uLeadHit.value > 0.5;
    // ...against what a release on this frame would actually be worth.
    // inSweetSpot is what tryStrike asks, and with the button already up the
    // offset no longer moves, so this IS the release frame's verdict.
    const wouldBite = strikeState.pending >= CONFIG.strike.charge.minFire && inSweetSpot(stats);
    if (saysHit !== wouldBite) disagreements++;
    if (U.uLeadGlow.value > 0 || saysHit !== wouldBite) {
      rows.push({ f, off: sweetOffset(), r: U.uLeadR.value, saysHit, wouldBite, glow: U.uLeadGlow.value });
    }
  }
  console.log(`\n--- ${label} ---`);
  console.log('frame   offset    traveller r   ring says   would bite   ');
  for (const r of rows) {
    const off = Number.isFinite(r.off) ? `${r.off >= 0 ? '+' : ''}${(r.off * 1000).toFixed(0)}ms` : '  --';
    console.log(
      String(r.f).padStart(5),
      off.padStart(8),
      r.r.toFixed(3).padStart(13),
      (r.saysHit ? 'RELEASE' : '   .   ').padStart(12),
      (r.wouldBite ? 'bite' : '  . ').padStart(12),
      r.saysHit !== r.wouldBite ? '   <<< DISAGREES' : '',
    );
  }
  console.log(`${disagreements === 0 ? 'ok  ' : 'FAIL'} the cue and the damage gate agreed on all ${Math.round(1.6 / DT)} frames`);
  return disagreements;
}

let bad = 0;
bad += auditLead(1 / 60, '60 fps');
bad += auditLead(1 / 30, '30 fps');
console.log(bad === 0 ? '\nlead-in verified' : `\n${bad} DISAGREEMENTS`);

// ---------------------------------------------------------------------------
// ...AND THE CHAIN ARMS WITHOUT THE TIMING.
//
// The point of the split: a completed wind-up starts a food chain whenever the
// player lets go, and the sweet spot only decides what the dash is worth. A
// release that is late by a quarter of a second is a real strike with no bite
// — not a strike that never happened.
// ---------------------------------------------------------------------------
function armsAt(lateMs) {
  resetStrike();
  for (let i = 0; i < 5; i++) { feedChum(stats); consumeChainLink(); }
  const DT2 = 1 / 60;
  let guard = 0;
  while (!strikeLoaded() && guard++ < 2000) updateCharge(DT2, true, stats);
  for (let t = 0; t < lateMs / 1000 - 1e-9; t += DT2) updateCharge(DT2, true, stats);
  updateCharge(DT2, false, stats);
  const sweet = inSweetSpot(stats);
  tryStrike(DIR, stats);
  feedChum(stats); consumeChainLink();
  const chain = liveChain();
  cancelDash();
  return { sweet, chain };
}

console.log('\n--- a completed charge arms the chain at any timing ---');
let bad2 = 0;
for (const late of [0, 50, 120, 250, 500]) {
  const r = armsAt(late);
  const ok = r.chain > 0;
  if (!ok) bad2++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(late).padStart(3)}ms late -> chain x${r.chain}`
    + `   (damage: ${r.sweet ? 'YES' : 'no '})`);
}
// AND AN UNFINISHED WIND-UP STILL DOES NOT. Letting go early is not a perfect
// charge, so it arms nothing — which is what keeps the mechanic something you
// have to actually do rather than something that happens on every button press.
{
  resetStrike();
  for (let i = 0; i < 5; i++) { feedChum(stats); consumeChainLink(); }
  const DT2 = 1 / 60;
  for (let i = 0; i < 30; i++) updateCharge(DT2, true, stats);  // half a wind-up
  updateCharge(DT2, false, stats);
  tryStrike(DIR, stats);
  feedChum(stats); consumeChainLink();
  const chain = liveChain();
  cancelDash();
  const ok = chain === 0;
  if (!ok) bad2++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} a wind-up let go of early arms nothing -> chain x${chain}`);
}
console.log(bad2 === 0 ? '\narming verified' : `\n${bad2} ARMING FAILURES`);

// ---------------------------------------------------------------------------
// THE WINDOW IN FRAMES, which is the only unit it exists in from the seat.
//
// `sweetFraction` is authored as a fraction of a second and RELEASED in frames,
// and the two do not scale together — so a tightening that reads as a modest
// percentage on paper can quietly land on a single frame, which is not a skill
// gate, it is a coin toss. Worse, `sweetHalfWidth` multiplies by the RUN'S
// `strikeChargeTime`, and Coiled Spring cuts that to 0.78: the card that speeds
// the wind-up up also narrows the window, so the hardest real combination is
// four stacks on a 30fps device rather than anything the default numbers show.
//
// This is the guard on that, and it is why the shipped value is 0.04 and not
// lower: 0.03 is three frames at 60fps and ONE at 30.
// ---------------------------------------------------------------------------
function windowFrames(halfWidth, fps) {
  const dt = 1 / fps;
  let n = 0;
  for (let k = -40; k <= 40; k++) if (Math.abs(k * dt) <= halfWidth + 1e-9) n++;
  return n;
}

{
  const time = CONFIG.strike.charge.time;
  const frac = CONFIG.strike.charge.sweetFraction;
  // 0.78 is Coiled Spring at four stacks — the shortest wind-up that ships, and
  // therefore the narrowest this window ever gets in a real run.
  const cases = [['base', time], ['Coiled Spring x4', time * 0.78]];
  console.log(`\n--- the window in frames (sweetFraction ${frac}) ---`);
  let bad3 = 0;
  for (const [name, t] of cases) {
    const half = t * frac;
    const at60 = windowFrames(half, 60);
    const at30 = windowFrames(half, 30);
    console.log(`  ${name.padEnd(17)} +/-${(half * 1000).toFixed(0).padStart(3)}ms   ${at60} frames @60fps, ${at30} @30fps`);
    // Three frames at 60 is the floor worth defending: it is a window a player
    // can aim at with the lead-in rather than one they can only be lucky in.
    if (at60 < 3) { bad3++; console.log(`  FAIL ${name} is ${at60} frame(s) at 60fps`); }
  }
  console.log(bad3 === 0
    ? '  ok   every wind-up that ships leaves at least 3 frames at 60fps'
    : `  ${bad3} TOO NARROW`);
}
