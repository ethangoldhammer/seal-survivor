#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:aura
//
// THE SHELL OF CHARGED WATER A BURNING SEAL PUSHES OUT — systems/boostAura.js.
//
// It is a state machine over dt with a colour lookup hanging off it, which is
// exactly the kind of thing that looks perfect in a screenshot and is wrong
// over time: a radius that grows per FRAME rather than per second is right at
// 60fps and half speed at 30; a fade that does not land on zero leaves a shell
// hanging over the animal for the rest of the run; a colour read a frame late
// wears the pip that just went out. So it is driven here frame by frame and
// MEASURED off the real uniforms, with no GL context anywhere.
//
// WHAT IT CANNOT TELL YOU: whether the shader draws anything. A GLSL error
// renders nothing and throws nothing, and Node has no compiler — that is
// tools/aura-shader-check.mjs, which hands these exact strings to a driver.
//
// Everything expected is computed from CONFIG rather than hardcoded: saved
// tuning wins over the config defaults (imported-tuning.json is merged at
// import), so a literal 2.6 here would be a test of the tuning file.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  createBoostAuraInstance, updateBoostAura, drainingPip, bodyReach, auraColor, flowSpeed,
  AURA_UNIFORM_NAMES, AURA_REC,
} from '../path/src/systems/boostAura.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import { feedback, onFeedback } from '../path/src/systems/feedback.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipRGB } from '../path/src/systems/strikeRing.js';
import { createStrikeState, resetStrike, updateCharge, pipCount, windUpTime } from '../path/src/systems/strike.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const A = CONFIG.boostAura;
const PIPS = pipCount(null);
const BURN = windUpTime(null);
// A seal-sized box, stated here rather than loaded: no GLB loads in Node (see
// the note in tools/, and every other harness in this repo), and what is being
// measured is what the system DOES with a box, not what the seal's box is.
const BOX = new THREE.Box3(new THREE.Vector3(-0.9, -1.8, -1.7), new THREE.Vector3(0.9, 1.8, 1.7));
const INNER = bodyReach(BOX) + (A.gap ?? 0.12);
const POS = new THREE.Vector3(12, -4, 0);
const DEF_TURB = CONFIG.emitters.boostAuraBurst.turbulence;

/** A shell and a strike state of their own, opened on a full bar. */
function rig() {
  const a = createBoostAuraInstance();
  const st = createStrikeState();
  resetStrike(st);
  st.charge = 1;
  return { a, st, u: a.mesh.material.uniforms };
}

// The launch line every seal is aimed down in these checks unless one says
// otherwise. Straight right, so a flow offset's sign is readable at a glance.
const EAST = { x: 1, y: 0 };

/** One frame: burn if `held`, then draw. Real seconds, like the game's. */
function frame(r, held, dt, aim = EAST) {
  updateCharge(dt, held, null, r.st);
  r.a.update(dt, POS, r.st, true, { box: BOX, stats: null, aim, held });
}

function hold(r, seconds, dt = 1 / 60, held = true, aim = EAST) {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) frame(r, held, dt, aim);
}

console.log('\nWHERE IT STARTS');
{
  const r = rig();
  frame(r, false, 1 / 60);
  check('an idle frame draws nothing', r.a.mesh.visible === false);
  check('  ...and leaves the fade at zero', r.u.uLife.value === 0);

  // One frame of an actual burn.
  frame(r, true, 1 / 60);
  check('the first burning frame lights it', r.a.mesh.visible === true);
  const outer = r.u.uOuter.value;
  const inner = r.u.uInner.value * outer;
  check('  ...with the inner edge on the body\'s own circle, not the hit circle',
    near(inner, INNER, 1e-9), `${inner.toFixed(4)} vs ${INNER.toFixed(4)}`);
  check('  ...and the body circle is measured, not the gameplay radius',
    INNER > (CONFIG.player.hitRadius ?? 1) * 1.4,
    `body ${INNER.toFixed(2)} vs hit ${(CONFIG.player.hitRadius ?? 1).toFixed(2)}`);
  check('  ...and the quad is scaled to the outer reach, so r = 1 means something',
    near(r.a.mesh.scale.x, outer, 1e-9));
  check('  ...centred on the seal', near(r.a.mesh.position.x, POS.x) && near(r.a.mesh.position.y, POS.y));
  check('  ...and the shader is told where that is in the WATER, for the grain',
    near(r.u.uCenter.value.x, POS.x) && near(r.u.uCenter.value.y, POS.y));
}

console.log('\nA HELD BUTTON WITH NOTHING TO BURN LIGHTS NOTHING');
{
  // The one case that separates "the button is down" from "fuel is leaving" —
  // the signal the sounds and the mouth gate deliberately do NOT use, and the
  // only one this layer may. See the header in boostAura.js.
  const r = rig();
  r.st.charge = 0;
  hold(r, 0.5);
  check('an empty bar held down stays dark', r.a.mesh.visible === false);
  check('  ...and names no pip', drainingPip(r.st.charge, PIPS) === -1);
}

console.log('\nIT PUSHES OUTWARD OVER TIME');
{
  // MEASURED BEFORE THE CAP, which is a TUNED distance and at the live tuning
  // lands a third of a second into a hold. Running past it and asserting the
  // radius still climbs would be a test of Ethan's `reach` slider, and it
  // would fail the moment he shortened it — which is exactly what it did.
  const capAt = (A.reach ?? 2.6) / Math.max(1e-6, A.push ?? 3.2);
  const dt = 1 / 240;
  const n = Math.max(4, Math.floor(capAt * 0.8 / dt));
  const r = rig();
  const seen = [];
  for (let i = 0; i < n; i++) { frame(r, true, dt); seen.push(r.u.uOuter.value); }
  let rising = true;
  for (let i = 1; i < seen.length; i++) if (seen[i] <= seen[i - 1]) rising = false;
  check('the reach grows every frame of a burn, right up to its cap', rising,
    `${seen[0].toFixed(3)} -> ${seen[seen.length - 1].toFixed(3)} over ${(n * dt).toFixed(2)}s`);
  check(`  ...at the tuned ${A.push} units per second`,
    near(seen[seen.length - 1] - INNER, (A.push ?? 3.2) * n * dt, 1e-6),
    `${(seen[seen.length - 1] - INNER).toFixed(4)} in ${(n * dt).toFixed(3)}s`);

  // PER SECOND, NOT PER FRAME. The whole failure this catches is a shell that
  // grows at half speed on a 30fps phone and twice it on a 120Hz screen. Run
  // short of the cap, or both would simply be pinned to it and agree for the
  // wrong reason.
  // A WHOLE NUMBER OF FRAMES AT BOTH RATES. hold() rounds seconds to frames, so
  // an arbitrary span lands on 13 frames at 30Hz (0.4333s) and 53 at 120Hz
  // (0.4417s) and the two runs are then measuring different amounts of TIME —
  // which is the test failing on its own arithmetic and blaming the system.
  const span = Math.max(2, Math.floor(capAt * 0.5 * 30)) / 30;
  const slow = rig(); hold(slow, span, 1 / 30);
  const fast = rig(); hold(fast, span, 1 / 120);
  check('the same span is the same span at 30fps and at 120',
    near(slow.u.uOuter.value, fast.u.uOuter.value, 1e-6),
    `${slow.u.uOuter.value.toFixed(5)} vs ${fast.u.uOuter.value.toFixed(5)}`);
  check('  ...and neither of them had simply hit the cap',
    slow.u.uOuter.value - INNER < (A.reach ?? 2.6) - 1e-6);
}

console.log('\n...AND STOPS AT ITS REACH');
{
  const r = rig();
  hold(r, 10, 1 / 60, true);
  check('it never gets further out than the tuned reach',
    near(r.u.uOuter.value - INNER, A.reach ?? 2.6, 1e-9),
    `${(r.u.uOuter.value - INNER).toFixed(4)}`);
  // The cap has to land INSIDE a full wind-up or "out of fuel" is never drawn
  // as a shell that has stopped growing — it would still be climbing when the
  // tank ran dry. See the note on `reach` in CONFIG.boostAura.
  check('  ...and it gets there before a full bar burns out',
    (A.reach ?? 2.6) / (A.push ?? 3.2) < BURN,
    `${((A.reach ?? 2.6) / (A.push ?? 3.2)).toFixed(2)}s of ${BURN.toFixed(2)}s`);
}

console.log('\nIT WEARS THE PIP THAT IS BURNING');
{
  const r = rig();
  const want = new THREE.Color();
  const worn = [];
  let wrong = 0;
  // A whole bar, sampled every frame, so every pip boundary is crossed.
  const dt = 1 / 240;
  for (let i = 0; i < Math.ceil(BURN / dt); i++) {
    frame(r, true, dt);
    const pip = drainingPip(r.st.charge, PIPS);
    if (pip < 0) break;
    auraColor(want, pip, PIPS);
    if (!r.u.uColor.value.equals(want)) wrong++;
    const hex = r.u.uColor.value.getHexString();
    if (worn[worn.length - 1] !== hex) worn.push(hex);
  }
  check('every frame of a drain wears the pip the drain is eating', wrong === 0, `${wrong} frame(s) off`);
  check(`  ...so a ${PIPS}-pip bar walks ${PIPS} colours on the way down`,
    worn.length === PIPS, worn.join(' '));
  check('  ...ending on the FIRST pip, which is the one that empties last',
    worn[worn.length - 1] === auraColor(want, 0, PIPS).getHexString());

  // EQUALLY BRIGHT, whatever the hue. Normalising on luminance would hand the
  // cold end of the wheel a boost and wash the warm end out; peak-channel
  // leaves hue and saturation exactly as the pip wears them. See npm run glow.
  let dim = 0;
  const hueOff = [];
  const pipCol = new THREE.Color();
  const hslA = { h: 0, s: 0, l: 0 };
  const hslB = { h: 0, s: 0, l: 0 };
  for (let i = 0; i < PIPS; i++) {
    auraColor(want, i, PIPS);
    if (!near(Math.max(want.r, want.g, want.b), 1, 1e-6)) dim++;
    pipCol.set(pipRGB(i, PIPS));
    pipCol.getHSL(hslA);
    want.getHSL(hslB);
    if (!near(hslA.h, hslB.h, 1e-4)) hueOff.push(i);
  }
  check('every pip arrives at the same peak brightness', dim === 0, `${dim} short`);
  check('  ...with the pip\'s own hue untouched', hueOff.length === 0, `pips ${hueOff.join(',')}`);
}

console.log('\nTHE FIELD FLOWS DOWN THE LINE OF THE STRIKE');
{
  const r = rig();
  hold(r, 0.25, 1 / 120, true, EAST);
  const f = r.u.uFlow.value;
  check('an eastward strike slides the field east', f.x > 0.1 && Math.abs(f.y) < 1e-9,
    `(${f.x.toFixed(3)}, ${f.y.toFixed(3)})`);
  // THE SIGN IS THE WHOLE DIRECTION. The shader samples at world - uFlow, so a
  // POSITIVE offset is what carries a feature along +x; negative would stream
  // every lump backwards out of the seal's face, which is a one-character bug
  // that looks deliberate.
  check('  ...and it is the offset the shader SUBTRACTS, so lumps travel with it',
    f.x > 0);

  const west = rig();
  hold(west, 0.25, 1 / 120, true, { x: -1, y: 0 });
  check('aiming the other way sends it the other way',
    west.u.uFlow.value.x < -0.1, `${west.u.uFlow.value.x.toFixed(3)}`);

  // A DIAGONAL IS NORMALISED. strikeDirection already returns a unit vector,
  // but a caller that ever hands over a raw stick must not make the field
  // travel 41% faster on the diagonals than on the axes.
  const diag = rig();
  hold(diag, 0.25, 1 / 120, true, { x: 3, y: 3 });
  const d = diag.u.uFlow.value;
  check('a long vector travels no further than a unit one',
    near(Math.hypot(d.x, d.y), Math.abs(f.x), 1e-9),
    `${Math.hypot(d.x, d.y).toFixed(4)} vs ${Math.abs(f.x).toFixed(4)}`);
  check('  ...and goes where it was pointed', near(d.x, d.y, 1e-9) && d.x > 0);
}

console.log('\n...AND FASTER THE LONGER IT IS HELD');
{
  const A = CONFIG.boostAura;
  check('it starts at the tuned rate', near(flowSpeed(0), A.flow ?? 2, 1e-9), `${flowSpeed(0)}`);
  check('  ...and a second of holding adds the tuned ramp',
    near(flowSpeed(1), Math.min(A.flowMax ?? 10, (A.flow ?? 2) + (A.flowRamp ?? 6)), 1e-9));
  check('  ...and it never passes the ceiling', near(flowSpeed(1000), A.flowMax ?? 10, 1e-9));
  check('  ...which is above where it starts, so `flow` is not a lie',
    (A.flowMax ?? 10) > (A.flow ?? 2), `${A.flow} → ${A.flowMax}`);
  // THE RAMP HAS TO BE VISIBLE ACROSS A WIND-UP, which is the design claim.
  // This used to demand the CEILING be reached inside one, and that is a
  // different claim and the wrong one: a ceiling is a clamp, and a tuning that
  // never reaches it (flowMax 26 against a ramp of 8) still accelerates the
  // field by nearly double over a hold, which is the thing the player reads.
  check('  ...and a full wind-up ends meaningfully faster than it began',
    flowSpeed(BURN) >= flowSpeed(0) * 1.3,
    `${flowSpeed(0).toFixed(1)} → ${flowSpeed(BURN).toFixed(1)} u/s`);

  // THE LIVE FIELD ACCELERATES, measured as travel per equal slice of time.
  const r = rig();
  const dt = 1 / 240;
  const slice = 0.1;
  const legs = [];
  let last = 0;
  for (let i = 0; i < 4; i++) {
    hold(r, slice, dt);
    legs.push(r.u.uFlow.value.x - last);
    last = r.u.uFlow.value.x;
  }
  let rising = true;
  for (let i = 1; i < legs.length; i++) if (legs[i] <= legs[i - 1]) rising = false;
  check('each tenth of a second carries the field further than the last', rising,
    legs.map((v) => v.toFixed(3)).join(' → '));
  // legs are DISTANCES per slice, so leg growth over elapsed time is (u/s per
  // s) x slice — the second division by `slice` is what turns it back into the
  // ramp's own units. Getting that wrong prints the right number beside a
  // comparison against the wrong one, which is how this first went green on a
  // value that was 0.1x what it claimed.
  const perSec = (legs[3] - legs[0]) / (slice * 3) / slice;
  check('  ...by about the tuned ramp per second',
    near(perSec, A.flowRamp ?? 6, 0.3), `${perSec.toFixed(2)} u/s per s`);
}

console.log('\nSWINGING THE AIM MID-HOLD');
{
  // INTEGRATED, NOT RECOMPUTED. offset = speed x held would rewrite the whole
  // trail onto the newest heading the moment the aim moved, and the shell
  // would snap sideways a shell's width in one frame. What has been laid down
  // stays laid down; only what is added from here on goes the new way.
  const r = rig();
  hold(r, 0.3, 1 / 240, true, EAST);
  const east = r.u.uFlow.value.x;
  hold(r, 0.3, 1 / 240, true, { x: 0, y: 1 });
  const f = r.u.uFlow.value;
  check('the eastward travel already laid down is kept', near(f.x, east, 1e-9),
    `${f.x.toFixed(3)} vs ${east.toFixed(3)}`);
  check('  ...and the new heading is what carries on from there', f.y > 0.1,
    `${f.y.toFixed(3)}`);
}

console.log('\nAN UNAIMED WIND-UP');
{
  // strikeDirection returns the zero vector only when BOTH sticks are idle,
  // which is a player who has not said where yet — not a request to stop.
  const r = rig();
  hold(r, 0.2, 1 / 240, true, EAST);
  const before = r.u.uFlow.value.x;
  hold(r, 0.2, 1 / 240, true, { x: 0, y: 0 });
  check('a thumb coming to rest does not stall the field',
    r.u.uFlow.value.x > before + 0.1,
    `${before.toFixed(3)} → ${r.u.uFlow.value.x.toFixed(3)}`);
  check('  ...and it carries on down the line it already had',
    Math.abs(r.u.uFlow.value.y) < 1e-9);

  // ...and a shell that has NEVER been given a heading simply does not flow,
  // rather than picking one.
  const blind = rig();
  hold(blind, 0.3, 1 / 240, true, { x: 0, y: 0 });
  check('a shell never given a heading sits still rather than inventing one',
    blind.u.uFlow.value.x === 0 && blind.u.uFlow.value.y === 0);
  check('  ...but it is still drawn', blind.a.mesh.visible === true);
}

console.log('\nTHE LET-GO');
{
  const r = rig();
  hold(r, 0.3);
  const litColor = r.u.uColor.value.clone();
  const wide = r.u.uOuter.value;
  const flowed = r.u.uFlow.value.x;
  check('a burn in progress is fully faded in', near(r.u.uLife.value, 1, 1e-9));

  // Let go. The bar still has fuel, so this is the release rather than a
  // burnout — the one that has to fade rather than being cut.
  const dt = 1 / 240;
  let t = 0;
  const radii = [];
  let lastFlow = flowed;
  while (r.u.uLife.value > 0 && t < 5) {
    frame(r, false, dt);
    t += dt;
    // READ BEFORE THE NEXT FRAME CAN CLEAR IT. The shell resets itself in
    // every channel on the frame life reaches 0, so a value read after the
    // loop is the reset, not the last thing drawn — which is how this first
    // reported that the flow had stopped dead at the let-go.
    if (r.u.uLife.value > 0) lastFlow = r.u.uFlow.value.x;
    radii.push(r.u.uOuter.value);
  }
  check('it fades out inside the tuned fade', t <= (A.fade ?? 0.18) + dt * 2, `${t.toFixed(3)}s`);
  check('  ...and lands exactly on gone', r.u.uLife.value === 0 && r.a.mesh.visible === false);
  // The last frame drawn is the one before life hit 0.
  check('  ...having kept EXPANDING through the fade, not snapped back',
    radii.length > 1 && radii[radii.length - 2] > wide,
    `${wide.toFixed(3)} -> ${radii[radii.length - 2].toFixed(3)}`);
  check('  ...and never changed colour on the way out',
    r.u.uColor.value.equals(litColor), r.u.uColor.value.getHexString());
  check('  ...and kept FLOWING through the fade, like the radius',
    lastFlow > flowed, `${flowed.toFixed(3)} → ${lastFlow.toFixed(3)}`);
}

console.log('\nA SECOND BURN STARTS AT THE ANIMAL AGAIN');
{
  const r = rig();
  hold(r, 0.6);
  hold(r, 1.0, 1 / 60, false);          // let go, let it die
  check('the shell is gone', r.a.mesh.visible === false);
  frame(r, true, 1 / 60);
  check('  ...and the next burn opens with the field back at its origin',
    near(r.u.uFlow.value.x, flowSpeed(1 / 60) / 60, 1e-9), `${r.u.uFlow.value.x.toFixed(5)}`);
  check('  ...and back on the body\'s edge',
    near(r.u.uInner.value * r.u.uOuter.value, INNER, 1e-9),
    `${(r.u.uInner.value * r.u.uOuter.value).toFixed(4)}`);
}

console.log('\nTHE LET-GO SHATTERS IT');
{
  // The particle buffer, so the specks can be read back off the real
  // attributes rather than off a count this file kept for itself.
  const scene = new THREE.Scene();
  initParticles(scene);
  const A2 = scene.children[0].geometry.attributes;
  const B = CONFIG.boostAura.burst;
  const DEF = CONFIG.emitters.boostAuraBurst;

  /** Which slots a burst just wrote, asked of the ring buffer rather than tracked. */
  function shatter(r, sweet) {
    const before = A2.aStart.array.slice();
    const n = r.a.burst(POS, sweet);
    const idx = [];
    for (let i = 0; i < A2.aStart.count; i++) if (A2.aStart.array[i] !== before[i]) idx.push(i);
    return { n, idx };
  }

  resetParticles();
  const r = rig();
  hold(r, 0.3);
  const lit = r.u.uColor.value.clone();
  const inner = r.u.uInner.value * r.u.uOuter.value;
  const outer = r.u.uOuter.value;
  const { n, idx } = shatter(r, false);

  check('a release with a shell up throws specks', n > 0, `${n}`);
  check('  ...as many as the tuned count', n === Math.round(B.count), `${n} of ${B.count}`);
  check('  ...and the buffer really holds them', idx.length === n, `${idx.length}`);

  // THE SHELL IS CONSUMED. "Explodes into" is the read; a shell left fading
  // under its own debris is two effects that happened to coincide.
  check('  ...and the shell is gone, not left fading',
    r.a.mesh.visible === false && r.u.uLife.value === 0);

  // BORN ON THE SHELL, not at the seal. A burst from the centre is a different
  // effect that happens to be the same colour.
  let off = 0;
  let nearest = Infinity;
  let furthest = 0;
  for (const i of idx) {
    const dx = A2.position.array[i * 3] - POS.x;
    const dy = A2.position.array[i * 3 + 1] - POS.y;
    const d = Math.hypot(dx, dy);
    if (d < inner - 1e-6 || d > outer + 1e-6) off++;
    nearest = Math.min(nearest, d);
    furthest = Math.max(furthest, d);
  }
  check('  ...every speck is born inside the shell\'s own band', off === 0, `${off} outside`);
  check('  ...none of them inside the animal', nearest >= bodyReach(BOX) - 1e-6,
    `nearest ${nearest.toFixed(2)}u, body ${bodyReach(BOX).toFixed(2)}u`);
  check('  ...and they reach most of the way across it',
    furthest > inner + (outer - inner) * 0.5,
    `${nearest.toFixed(2)}..${furthest.toFixed(2)} of ${inner.toFixed(2)}..${outer.toFixed(2)}`);

  // THE SHELL'S OWN COLOUR. emitCloud multiplies by the emitter's glow, so the
  // hue is the channel RATIOS — the same normalise particle-test.mjs uses.
  const glow = (DEF.glow ?? 1) * (CONFIG.bloom?.particleOverdrive ?? 1);
  let offHue = 0;
  for (const i of idx) {
    const c = [A2.aColor.array[i * 3], A2.aColor.array[i * 3 + 1], A2.aColor.array[i * 3 + 2]];
    if (c.some((v, k) => Math.abs(v - [lit.r, lit.g, lit.b][k] * glow) > 1e-4)) offHue++;
  }
  check('  ...wearing the shell\'s colour, which is the burning pip\'s hue',
    offHue === 0, `${offHue} off`);

  // TINY AND BRIEF is the whole brief.
  let bigs = 0;
  let longs = 0;
  for (const i of idx) {
    if (A2.aSize.array[i] > DEF.size[1] + 1e-6 || A2.aSize.array[i] < DEF.size[0] - 1e-6) bigs++;
    if (A2.aLife.array[i] > DEF.life[1] + 1e-6 || A2.aLife.array[i] < DEF.life[0] - 1e-6) longs++;
  }
  check('  ...tiny, inside the emitter\'s own size range', bigs === 0, `${bigs} out of range`);
  check('  ...and short-lived, inside its life range', longs === 0, `${longs} out of range`);
  check('  ...which really is brief — nothing outlives a third of a second',
    DEF.life[1] <= 0.35, `${DEF.life[1]}s`);
}

console.log('\n...AND HARDER INSIDE THE WINDOW');
{
  const scene = new THREE.Scene();
  initParticles(scene);
  const A2 = scene.children[0].geometry.attributes;
  const B = CONFIG.boostAura.burst;
  const SW = B.sweet ?? {};

  // SEEDED, AND AVERAGED OVER FIXED SEEDS. Every speck draws an angle and a
  // speed out of a range, so the MEAN speed of one burst wobbles by a few
  // percent run to run — which flaked this comparison about once in twelve.
  // The fix is not a looser threshold (that would only make the check quieter
  // about a real regression); it is to stop the answer depending on which
  // stream the process happened to get. Same rule every spawn harness in this
  // repo follows.
  const SEEDS = [1, 7, 13, 29, 101];
  function seeded(seed) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shatter(sweet, seed) {
    resetParticles();
    const real = Math.random;
    // The RIG is built under the real stream — only the BURST is seeded, so
    // this measures the burst's own draws rather than re-seeding the wind-up.
    const r = rig();
    hold(r, 0.3);
    const before = A2.aStart.array.slice();
    Math.random = seeded(seed);
    let n;
    try { n = r.a.burst(POS, sweet); } finally { Math.random = real; }
    const idx = [];
    for (let i = 0; i < A2.aStart.count; i++) if (A2.aStart.array[i] !== before[i]) idx.push(i);
    const speeds = idx.map((i) => Math.hypot(A2.aVelocity.array[i * 3], A2.aVelocity.array[i * 3 + 1]));
    const turb = idx.length ? A2.aTurb.array[idx[0]] : 0;
    return {
      n,
      mean: speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length),
      turb,
    };
  }

  const pool = (sweet) => {
    const runs = SEEDS.map((sd) => shatter(sweet, sd));
    return {
      n: runs[0].n,
      turb: runs[0].turb,
      mean: runs.reduce((a, r) => a + r.mean, 0) / runs.length,
    };
  };
  const miss = pool(false);
  const hit = pool(true);

  check('a release in the window throws MORE of it',
    hit.n === Math.min(256, Math.round(B.count * (SW.count ?? 2.2))),
    `${miss.n} → ${hit.n}`);
  check('  ...and it really is more', hit.n > miss.n * 1.2);
  check('  ...FASTER', hit.mean > miss.mean * ((SW.speed ?? 1.8) * 0.9),
    `${miss.mean.toFixed(1)} → ${hit.mean.toFixed(1)} u/s`);
  check('  ...and CHURNING harder',
    near(hit.turb, miss.turb * (SW.turbulence ?? 2.2), 1e-5),
    `${miss.turb.toFixed(3)} → ${hit.turb.toFixed(3)}`);
  // ONE EMITTER IN TWO REGISTERS, not two effects. The turbulence still goes
  // through the def and through the global switch, so a player who has
  // turbulence off gets a flat burst either way rather than a sweet release
  // quietly reintroducing it.
  check('  ...through the emitter\'s own figure, not around it',
    miss.turb > 0 ? near(miss.turb, DEF_TURB, 1e-6) : true,
    `${miss.turb.toFixed(3)} vs the def's ${DEF_TURB}`);
}

console.log('\nNOTHING TO SHATTER');
{
  const scene = new THREE.Scene();
  initParticles(scene);
  resetParticles();
  // A release on a wind-up that never burned anything. Not a failure — a
  // perfectly ordinary tap on an empty bar.
  const r = rig();
  r.st.charge = 0;
  hold(r, 0.3);
  check('a release with no shell up throws nothing', r.a.burst(POS, true) === 0);

  const off = rig();
  hold(off, 0.3);
  const was = CONFIG.boostAura.burst.enabled;
  CONFIG.boostAura.burst.enabled = false;
  check('  ...and the toggle silences it', off.a.burst(POS, true) === 0);
  CONFIG.boostAura.burst.enabled = was;
  check('  ...without having eaten the shell on the way past',
    off.a.mesh.visible === true);
}

console.log('\nTHE SHATTER IS AN EVENT, WHICH IS WHAT PUTS IT IN A REPLAY');
{
  const scene = new THREE.Scene();
  initParticles(scene);
  resetParticles();

  const seen = [];
  const off = onFeedback((name, at) => { if (name === 'boostShatter') seen.push(at); });

  const r = rig();
  hold(r, 0.3);
  const lit = r.u.uColor.value.clone();
  const inner = r.u.uInner.value * r.u.uOuter.value;
  const outer = r.u.uOuter.value;
  const n = r.a.burst(POS, true);
  off();

  check('a shatter goes out through feedback()', seen.length === 1, `${seen.length} event(s)`);
  const at = seen[0] ?? {};
  // POSITIONED, or the replay's recorder drops it on the floor — it keeps only
  // events that say where in the water they happened.
  check('  ...positioned, so the recorder will keep it',
    at.x === POS.x && at.y === POS.y);
  check('  ...carrying the shell\'s geometry, which cannot be re-derived later',
    near(at.inner, inner, 1e-9) && near(at.outer, outer, 1e-9));
  check('  ...its colour', near(at.r, lit.r, 1e-9) && near(at.g, lit.g, 1e-9) && near(at.b, lit.b, 1e-9));
  check('  ...the line it was flowing down', Number.isFinite(at.dirX) && Number.isFinite(at.dirY));
  check('  ...and whether the release landed in the window', at.sweet === 1);

  // EVERY FIELD A PRIMITIVE. The recorder keeps `{ ...at }` — a shallow copy —
  // so a THREE.Color or a Vector2 in here would still be a live reference to
  // the shell's own uniform, and by the time the replay read it back it would
  // describe whatever that shell is doing now. Which is nothing, because it
  // was consumed.
  const objs = Object.entries(at).filter(([, v]) => v !== null && typeof v === 'object');
  check('  ...and nothing but primitives, so a shallow copy is a snapshot',
    objs.length === 0, objs.map(([k]) => k).join(' '));

  check('  ...and the specks still went out on the live firing', n > 0, `${n}`);
}

console.log('\n...AND A REPLAYED ONE DRAWS THE SAME PICTURE');
{
  const scene = new THREE.Scene();
  initParticles(scene);
  const A2 = scene.children[0].geometry.attributes;

  // Catch one event, then fire it back the way systems/versus.js does: the
  // same `at`, with `replay: true` on it and no shell anywhere in the game.
  let caught = null;
  const off = onFeedback((name, at) => { if (name === 'boostShatter' && !at.replay) caught = { ...at }; });
  const r = rig();
  hold(r, 0.3);
  resetParticles();
  const liveN = r.a.burst(POS, false);
  off();

  const liveIdx = [];
  for (let i = 0; i < A2.aStart.count; i++) if (A2.aStart.array[i] !== 0) liveIdx.push(i);

  resetParticles();
  const before = A2.aStart.array.slice();
  feedback('boostShatter', { ...caught, replay: true });
  const backIdx = [];
  for (let i = 0; i < A2.aStart.count; i++) if (A2.aStart.array[i] !== before[i]) backIdx.push(i);

  check('a replayed shatter draws specks with no shell in the game',
    backIdx.length === liveN, `${backIdx.length} vs ${liveN}`);
  // THE SAME PICTURE, which is the whole reason the drawing lives in one
  // function: the band it is scattered across and the colour it wears come off
  // the event, so a replay a minute later is the shell that was there then.
  let offBand = 0;
  let offHue = 0;
  for (const i of backIdx) {
    const d = Math.hypot(A2.position.array[i * 3] - caught.x, A2.position.array[i * 3 + 1] - caught.y);
    if (d < caught.inner - 1e-6 || d > caught.outer + 1e-6) offBand++;
    const c = [A2.aColor.array[i * 3], A2.aColor.array[i * 3 + 1], A2.aColor.array[i * 3 + 2]];
    const peak = Math.max(...c);
    const want = [caught.r, caught.g, caught.b];
    const wp = Math.max(...want);
    if (peak > 1e-6 && want.some((v, k) => Math.abs(c[k] / peak - v / wp) > 1e-3)) offHue++;
  }
  check('  ...on the band the shell actually had', offBand === 0, `${offBand} outside`);
  check('  ...in the colour it actually wore', offHue === 0, `${offHue} off-hue`);
}

console.log('\nTHE SHELL ITSELF IS RECORDED, FRAME BY FRAME');
{
  const r = rig();
  const buf = new Float32Array(AURA_REC * 3);

  // A dark shell records as nothing at all.
  r.a.record(buf, AURA_REC);
  check('a dark shell records a zero life', buf[AURA_REC] === 0);
  // ZEROED THROUGHOUT, not merely flagged. Two recorded frames are LERPED, so
  // a dark frame still carrying the last burn's 8-unit radius would drag the
  // lit frame beside it halfway out to it.
  let stale = 0;
  for (let k = 0; k < AURA_REC; k++) if (buf[AURA_REC + k] !== 0) stale++;
  check('  ...and zeroes every other slot with it', stale === 0, `${stale} left over`);

  hold(r, 0.25);
  const lit = { inner: r.u.uInner.value * r.u.uOuter.value, outer: r.u.uOuter.value,
    life: r.u.uLife.value, fx: r.u.uFlow.value.x, col: r.u.uColor.value.clone() };
  r.a.record(buf, AURA_REC);
  check('a lit shell records its life', near(buf[AURA_REC + 0], lit.life, 1e-6));
  check('  ...its radii', near(buf[AURA_REC + 1], lit.inner, 1e-6) && near(buf[AURA_REC + 2], lit.outer, 1e-6));
  check('  ...how far its field had flowed', near(buf[AURA_REC + 3], lit.fx, 1e-6));
  check('  ...and its colour',
    near(buf[AURA_REC + 5], lit.col.r, 1e-6) && near(buf[AURA_REC + 7], lit.col.b, 1e-6));
  check('  ...writing exactly its own slot and no neighbour\'s',
    buf[0] === 0 && buf[AURA_REC * 2] === 0);
}

console.log('\n...AND POSED BACK ONTO A REPLAYED BODY');
{
  // Two recorded frames, a quarter of a second apart, off one wind-up.
  const src = rig();
  const fa = new Float32Array(AURA_REC);
  const fb = new Float32Array(AURA_REC);
  hold(src, 0.15);
  src.a.record(fa, 0);
  hold(src, 0.15);
  src.a.record(fb, 0);

  // A DIFFERENT shell — the replay's — and a body posed somewhere else
  // entirely, which is the case that matters: the record stores the shell's
  // SIZE, and where it goes is wherever the camera has just put the animal.
  const shown = createBoostAuraInstance();
  const at = new THREE.Vector3(-40, 9, 0);
  const drew = shown.pose(fa, fb, 0.5, at, 0);
  const u = shown.mesh.material.uniforms;
  check('a recorded shell poses back', drew === true && shown.mesh.visible === true);
  check('  ...on the body where the replay put it, not where the match was',
    near(shown.mesh.position.x, at.x) && near(u.uCenter.value.y, at.y));
  check('  ...halfway between the two frames',
    near(u.uOuter.value, (fa[2] + fb[2]) / 2, 1e-5),
    `${u.uOuter.value.toFixed(3)} between ${fa[2].toFixed(3)} and ${fb[2].toFixed(3)}`);
  check('  ...with the band it had', near(u.uInner.value * u.uOuter.value, (fa[1] + fb[1]) / 2, 1e-5));
  check('  ...and the flow it had', near(u.uFlow.value.x, (fa[3] + fb[3]) / 2, 1e-5));
  check('  ...and the quad scaled to it, so r = 1 still means the reach',
    near(shown.mesh.scale.x, u.uOuter.value, 1e-9));

  // THE KNOBS ARE LIVE, NOT RECORDED. A replay of a shot thrown before somebody
  // dragged `grain` is drawn with the grain that is set now — what was recorded
  // is the moment, not the settings it was drawn with.
  const keep = CONFIG.boostAura.grain;
  CONFIG.boostAura.grain = keep * 2;
  shown.pose(fa, fb, 0.5, at, 0);
  check('the tuning is read live rather than restored from the record',
    near(u.uGrain.value, keep * 2, 1e-9), `${u.uGrain.value}`);
  CONFIG.boostAura.grain = keep;

  // THE NEARER FRAME DECIDES WHETHER THERE IS A SHELL. The let-go is instant —
  // the shell is consumed on one frame — so lerping the life across that frame
  // would dissolve it through a half-lit shell that was never on screen.
  const dark = new Float32Array(AURA_REC);
  check('a pose past the shatter draws nothing',
    shown.pose(fb, dark, 0.9, at, 0) === false && shown.mesh.visible === false);
  check('  ...and one before it still draws',
    shown.pose(fb, dark, 0.1, at, 0) === true && shown.mesh.visible === true);
  check('  ...without the dark frame dragging the radius in',
    near(u.uOuter.value, fb[2], 1e-5) || u.uOuter.value > fb[2] * 0.85,
    `${u.uOuter.value.toFixed(2)} of ${fb[2].toFixed(2)}`);

  // A frame a lab built by hand has no record in it at all, and must pose
  // nothing rather than throwing — the same guarantee poseBallLook gives.
  check('a frame nothing recorded poses nothing',
    shown.pose(null, fb, 0.5, at, 0) === false);
  shown.dispose();
}

console.log('\nTHE REPLAY ACTUALLY ASKS FOR ALL THAT');
{
  // The wiring, read off the source — the same way tools/charge-fx-test.mjs
  // holds main.js to its call sites. A perfect record and a perfect poser that
  // nothing calls is the failure this catches, and it is invisible to every
  // check above.
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const versus = fs.readFileSync(path.join(HERE, '../path/src/systems/versus.js'), 'utf8');
  const main = fs.readFileSync(path.join(HERE, '../path/src/main.js'), 'utf8');

  check('the recorded frame has a slot for every seat\'s shell',
    /aura: new Float32Array\(AURA_REC \* MAX_PER_SIDE \* 2\)/.test(versus));
  check('  ...deep-copied with the frame, or a clip plays back the next rally\'s',
    /aura: Float32Array\.from\(f\.aura\)/.test(versus));
  check('the recorder writes it every frame', /auraAt\(i\)\?\.record\(f\.aura/.test(versus));
  check('  ...and a seat with no shell is zeroed rather than left stale',
    /f\.aura\.fill\(0, i \* AURA_REC/.test(versus));
  check('the replay poses it back onto the body it just placed',
    /shell\.pose\(a\.aura, b\.aura, u, body\.mesh\.position, k \* AURA_REC\)/.test(versus));
  check('  ...and boils the field on the replay\'s own clock',
    /shell\.churnField\(Math\.max\(0, rs\.wallDt\) \* rs\.speed\)/.test(versus));
  // SEAT 0 IS THE ONE THAT GETS FORGOTTEN — its shell is main.js's singleton,
  // not a field on a seal — so the lookup that hides that split is held here.
  check('seat 0\'s shell is reached through the same lookup as everyone else\'s',
    /function auraAt\(i\) \{\s*if \(i === 0\) return player\.mesh \? _aura0 : null;/.test(versus));
  // ...and the live update must stand down while the record owns the shell, or
  // it stamps on the posed one with the frozen match's state on the same frame.
  check('the live update stands down while a replay is posing',
    /if \(!replayHoldsInput\(\)\) \{\s*updateBoostAura\(/.test(main));
}

console.log('\nSWITCHES AND GATES');
{
  const r = rig();
  hold(r, 0.3);
  r.a.update(1 / 60, POS, r.st, false, { box: BOX, stats: null, aim: EAST, held: true });
  check('a run that is not live hides it outright', r.a.mesh.visible === false);
  check('  ...leaving nothing lit behind it', r.u.uLife.value === 0);

  const was = CONFIG.boostAura.enabled;
  CONFIG.boostAura.enabled = false;
  const off = rig();
  hold(off, 0.3);
  check('the toggle keeps it off', off.a.mesh.visible === false);
  CONFIG.boostAura.enabled = was;

  const back = rig();
  hold(back, 0.1);
  check('  ...and switching it back on brings it back', back.a.mesh.visible === true);
}

console.log('\nONE SHELL PER SEAL');
{
  // A Blubberball pitch runs one of these per seal, bots included. Two sharing
  // a uniform object would give four seals one colour and one radius.
  const a = rig(); const b = rig();
  hold(a, 0.4);
  hold(b, 0.05);
  check('two shells hold two different reaches',
    a.u.uOuter.value > b.u.uOuter.value + 0.5,
    `${a.u.uOuter.value.toFixed(3)} vs ${b.u.uOuter.value.toFixed(3)}`);
  check('  ...and two different colour objects', a.u.uColor.value !== b.u.uColor.value);
  check('  ...and two different quads', a.a.mesh !== b.a.mesh);
}

console.log('\nTHE WHEEL IS QUOTED ONCE');
{
  // The ring's shader, the HUD column and this all colour pip i. They used to
  // be three copies of one mix(); pipRGB is now the only one, and these are
  // the properties the two views depend on.
  check('the last pip keeps its own pinned hue',
    pipRGB(PIPS - 1, PIPS) === ((CONFIG.strike.ring.lastPipColor ?? CONFIG.strike.ring.readyColor) >>> 0),
    '0x' + pipRGB(PIPS - 1, PIPS).toString(16));
  check('the first pip is the wheel\'s base colour',
    pipRGB(0, PIPS) === (CONFIG.strike.ring.color >>> 0));
  check('a one-pip bar is all last-pip', pipRGB(0, 1) === ((CONFIG.strike.ring.lastPipColor ?? 0) >>> 0));
  let mono = 0;
  for (let i = 1; i < PIPS - 1; i++) if (pipRGB(i, PIPS) === pipRGB(i - 1, PIPS)) mono++;
  check('  ...and the ramp between really does move', mono === 0, `${mono} repeat(s)`);
}

console.log('\nTHE UNIFORM LIST IS THE MATERIAL\'S');
{
  const r = rig();
  const live = Object.keys(r.a.mesh.material.uniforms).sort();
  check('every uniform the checker asks about is one the material carries',
    AURA_UNIFORM_NAMES.slice().sort().join(',') === live.join(','));
}

console.log('\nBOUNDARIES');
{
  check('an empty bar names no pip', drainingPip(0, 5) === -1);
  check('a full bar names the last one', drainingPip(1, 5) === 4);
  check('exactly on a boundary names the pip BELOW it, the one about to go',
    drainingPip(0.8, 5) === 3);
  check('  ...and a hair under names the same one', drainingPip(0.8 - 1e-9, 5) === 3);
  check('the very last sliver is still pip 0', drainingPip(1e-9, 5) === 0);
  check('a body nothing measured falls back to the number it was handed',
    bodyReach(null, 1.25) === 1.25);
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
