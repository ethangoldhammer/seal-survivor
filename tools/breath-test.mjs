#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:breath
//
// The surface breath as a PAIR — systems/oxygenFx.js.
//
// ONE gasp per surfacing and one per oxygen bubble, each closed by one exhale
// when the seal goes back under. Both halves are edges, and both are easy to
// write as something that looks equivalent and is not.
//
// `breathIn` used to run on a timer for as long as the bar was filling, which
// panted through a refill from empty. The first case below is the one that
// stops that coming back, and it is deliberately built out of a LONG refill:
// a test that surfaces briefly passes either way.
//
// THE TEMPTING TEST IS `gaining` GOING FALSE. It is wrong, and it is wrong
// quietly: the bar also stops gaining when it simply hits FULL, and a seal can
// float at the surface on a full bar for as long as it likes. Wired that way
// the exhale lands the moment the bar tops up — a second or more before the
// seal dives, often with nothing on screen to explain it, and it would read as
// a stray sound rather than as a bug. So the trigger is oxygen starting to
// FALL again, and that is what the third case here pins down.
//
// The other two failures are worth a case each because both are silent:
//
//   AN EXHALE WITH NO INHALE   a run that starts at the surface with a full
//                              bar would blow out air it never took in.
//   AN EXHALE PER FRAME        `losing` is true for every frame of a dive, not
//                              just the first. Without the latch this fires
//                              sixty times a second for the whole descent —
//                              which the voice cap would mask into something
//                              that merely sounds thick.
//
//   node --import ./tools/vite-loader.mjs tools/breath-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import { updateOxygenFx, resetOxygenFx } from '../path/src/systems/oxygenFx.js';

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`  ok    ${m}`);

const fired = [];
onFeedback((event) => fired.push(event));

const MAX = CONFIG.oxygen.max;
const player = { oxygen: MAX, mesh: { position: { x: 0, y: 0 } }, stats: { maxOxygen: MAX } };

// One frame at 60fps. `active` is true — this is the in-run path.
function step(oxygen, frames = 1) {
  for (let i = 0; i < frames; i++) {
    player.oxygen = oxygen;
    updateOxygenFx(1 / 60, player, true);
  }
}
function run(fn) { fired.length = 0; resetOxygenFx(); player.oxygen = MAX; fn(); return fired; }
const count = (name) => fired.filter((e) => e === name).length;

// Long enough at the surface that a per-interval gasp would fire several
// times over: the whole point of case 1.
const HOLD = 180;   // three seconds of refilling

// --- 1. one breath per surfacing, however long the refill ------------------
// Down to empty, a long stop at the surface, then back under.
run(() => {
  step(MAX * 0.05, 4);                                       // settled, nearly out
  for (let i = 0; i < HOLD; i++) step(MAX * 0.05 + i * 0.5); // refilling for 3s
  for (let i = 0; i < 30; i++) step(MAX * 0.9 - i * 0.5);    // diving again
});
if (count('breathIn') !== 1) {
  fail(`a ${(HOLD / 60).toFixed(1)}s refill fired ${count('breathIn')} breathIn(s), expected 1`);
} else if (count('breathOut') !== 1) fail(`one dive, ${count('breathOut')} breathOut(s)`);
else pass(`a ${(HOLD / 60).toFixed(1)}s refill is one gasp and one exhale, not a pant`);

// --- 2. no exhale without an inhale -----------------------------------------
// A run that begins at the surface on a full bar and dives straight down.
run(() => {
  step(MAX, 4);
  for (let i = 0; i < 60; i++) step(MAX - i * 0.5);
});
if (count('breathOut')) fail(`dived on a full bar without ever breathing, got ${count('breathOut')} breathOut(s)`);
else pass('a dive with no breath before it exhales nothing');

// --- 3. the bar merely topping up is not a dive -----------------------------
// THE CASE THE OBVIOUS IMPLEMENTATION FAILS. Refill all the way to full, then
// sit there. Nothing has gone under, so nothing should have blown out.
run(() => {
  step(MAX * 0.5, 4);
  for (let i = 0; i < HOLD * 2; i++) step(Math.min(MAX, MAX * 0.5 + i * 1.5)); // up to full
  step(MAX, 60);                                                              // float there
});
if (count('breathOut')) fail(`topping up to full fired ${count('breathOut')} breathOut(s) — should wait for the dive`);
else pass('the bar reaching full is not a dive — no exhale until it falls');

// --- 4. once per dive, not once per frame -----------------------------------
run(() => {
  step(MAX * 0.5, 4);
  for (let i = 0; i < HOLD; i++) step(MAX * 0.5 + i * 0.5);
  for (let i = 0; i < 200; i++) step(MAX * 0.9 - i * 0.2);   // a long descent
});
if (count('breathOut') !== 1) fail(`a 200-frame descent fired ${count('breathOut')} breathOut(s), expected 1`);
else pass('one exhale for a long descent, not one per frame');

// --- 5. two dives, two exhales ----------------------------------------------
run(() => {
  for (let cycle = 0; cycle < 2; cycle++) {
    step(MAX * 0.4, 4);
    for (let i = 0; i < HOLD; i++) step(MAX * 0.4 + i * 0.5);
    for (let i = 0; i < 40; i++) step(MAX * 0.8 - i * 0.5);
  }
});
if (count('breathOut') !== 2) fail(`two dives fired ${count('breathOut')} breathOut(s)`);
else pass('two surfacings, two exhales');

// --- 6. an oxygen bubble is a breath ---------------------------------------
// The other way air arrives: a bubble pays its whole refill in ONE frame, deep
// underwater, with no surfacing involved. It has to gasp — and it has to gasp
// exactly once, then exhale as the bar resumes falling.
run(() => {
  step(MAX * 0.3, 10);                                    // sinking, no air
  step(MAX * 0.3 + CONFIG.oxygen.bubbleRefillAmount, 1);  // pop — one frame
  for (let i = 0; i < 40; i++) step(MAX * 0.3 + CONFIG.oxygen.bubbleRefillAmount - i * 0.5);
});
if (count('breathIn') !== 1) fail(`a bubble pop fired ${count('breathIn')} breathIn(s), expected 1`);
else if (count('breathOut') !== 1) fail(`a bubble pop fired ${count('breathOut')} breathOut(s), expected 1`);
else pass('an oxygen bubble underwater is one gasp, then one exhale');

// --- 7. a bubble on an almost-full bar still gasps --------------------------
// The old timer carried a `frac < 1` guard, and it ate exactly this pop: the
// player made a bubble burst and heard nothing back from the seal.
run(() => {
  step(MAX * 0.98, 10);
  step(MAX, 1);
  step(MAX, 30);
});
if (count('breathIn') !== 1) fail(`a bubble that topped the bar up fired ${count('breathIn')} breathIn(s)`);
else pass('a bubble grabbed on an almost-full bar still gasps');

// --- 8. no interval left to tune -------------------------------------------
// The slider that drove the old repeat is gone. Left behind it would read as a
// live control over a mechanism that no longer exists.
if (CONFIG.oxygen.fx?.breathInterval !== undefined) {
  fail('oxygen.fx.breathInterval still exists — the gasp does not repeat any more');
} else pass('the per-interval repeat and its slider are both gone');

// --- 9. the events are wired to voices with takes ---------------------------
// A feedback event whose `sfx` names nothing is silent and says nothing about
// it — the atlas calls these silentEvents.
for (const [event, voice] of [['breathOut', 'breathOut'], ['chumFull', 'chumFull']]) {
  const def = CONFIG.feedback[event];
  const name = def?.sfx;
  const takes = (CONFIG.sfx[name]?.srcs ?? []).filter(Boolean);
  if (!def) fail(`CONFIG.feedback.${event} does not exist`);
  else if (name !== voice) fail(`${event}.sfx is ${JSON.stringify(name)}, expected '${voice}'`);
  else if (!takes.length) fail(`${event} names voice '${voice}', which has no samples`);
  else pass(`${event} → ${voice}, ${takes.length} take(s)`);
}

console.log(failures ? `\n  ${failures} failure(s)\n` : '\n  breath: all good\n');
process.exit(failures ? 1 : 0);
