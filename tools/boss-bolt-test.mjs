#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bolts
//
// THE ELECTRIC AURA IS ONE SHAPE, NOT TWO THINGS IN THE SAME CIRCLE.
//
// The boundary of an electric boss's field is the shared organic ring speaking
// its `electric` dialect — a zigzag held through spline nodes and re-rolled on
// a stepped clock — and the bolts are struck from the animal's body out to a
// CORNER of that zigzag, forking onto the corners either side of it on the way.
// Everything below is a way for that sentence to stop being true without
// anything throwing, because every one of these failures renders a perfectly
// plausible electric boss:
//
//   THE CLOCK STOPS HOLDING. The step used to be floor(uTime * rate) computed
//   in the shader, and the rate rides a charge that breathes three times a
//   second. Multiplying a growing time by a wobbling rate moves the step by
//   TENS per frame once a fight is a few seconds old: the jags re-roll faster
//   than they are drawn, the dialect degenerates into per-frame noise, and what
//   the eye averages out of it is a smooth band. That is what an electric aura
//   looked like for as long as it existed, and nothing about it reads as a bug.
//
//   THE BOLTS MISS. Their endpoints are solved on the CPU from the same step,
//   so a bolt written against a different roll from the one being drawn ends
//   near the ring rather than on it. Half a second of that a minute is
//   invisible; it just stops looking welded.
//
//   THE EDGE SPENDS NOTHING. The dialect's amplitude is a WORLD distance, and
//   the shared default is tuned for a two-unit strike mark. On a twenty-unit
//   aura it is a quarter of one percent of the radius — the zigzag is running
//   at a size no pixel can show.
//
//   THE EDGE SPENDS TOO MUCH. The ring IS the hitbox. CONFIG.fx.organicRing.
//   wobbleMax is the whole game's promise about how far a threat circle may lie
//   about its reach, and a per-perk dial that could exceed it would be a boss
//   claiming reach it does not have through a door the ring audit never looks
//   at.
//
// The one thing that CANNOT be checked here is whether electricNode's
// transcription still agrees with the GLSL it was transcribed from — nothing in
// Node has a context to compile against. `npm run looks:ring` renders a ring and
// measures the paint against the same function. Both are needed: this file says
// the bolts land on what electricNode reports, that page says electricNode
// reports what is actually drawn.
//
//   node --import ./tools/vite-loader.mjs tools/boss-bolt-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, resetEnemies, spawnNamed } from '../path/src/entities/enemies.js';
import { resetProjectiles } from '../path/src/entities/projectiles.js';
import { resetBeams } from '../path/src/systems/beams.js';
import { attachBossPerk, updateBossPerks, resetBossPerks } from '../path/src/systems/bossPerks.js';
import {
  electricNode, electricNodeCount, isOrganicRing, threatType,
} from '../path/src/systems/organicRing.js';
import { updateBeatSync, divisionSeconds } from '../path/src/systems/beatSync.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import {
  setPlayerFlashTarget, updatePlayerFlash, resetPlayerFlash, flashPlayer,
  playerFlashLevel, playerFlashAttached,
} from '../path/src/systems/playerFlash.js';
import { parseBossPerkCsv } from '../path/src/bossPerkTable.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();
initParticles(scene);

const PERKS = parseBossPerkCsv(
  readFileSync(resolve(HERE, '../path/src/bossPerks.csv'), 'utf8'), () => {});
const perk = PERKS.find((p) => p.id === 'electric');
const fx = CONFIG.boss?.perkFx?.electric ?? {};

const playerFar = { x: 400, y: 0 };
const hooks = { onPlayerHit: () => {} };

// A lit electric boss, and the two objects it put in the scene. Everything
// below reads them straight out of the buffer the renderer would draw, which is
// the only description of a bolt that exists — there is no per-bolt object.
function fight() {
  resetBossPerks();
  resetProjectiles(scene);
  resetBeams(scene);
  resetEnemies(scene);
  resetParticles();
  const e = spawnNamed(scene, 'bossShark', 0, { x: 0, y: 0 }, { ignoreCaps: true, overfill: true });
  e.isBoss = true;
  e.invuln = 0;
  const st = attachBossPerk(scene, e, perk);
  const ring = scene.children.find((c) => isOrganicRing(c) && c.visible);
  const lines = scene.children.find((c) => c.isLineSegments);
  return { e, st, ring, lines };
}

// The beat clock is ticked here exactly where main.js ticks it — once a frame,
// before anything that reads it. The aura's surge is derived from the transport
// rather than integrated, so a harness that forgot this would measure a field
// frozen on the downbeat and call it stable.
function stepFrame(e, at = playerFar, hk = hooks) {
  e.invuln = 0;
  updateBeatSync(DT);
  updateBossPerks(DT, scene, at, hk, DT);
  updateParticles(DT);
}

// One slot of the buffer, decomposed. `null` for a slot holding a dead bolt,
// which is collapsed to the origin rather than removed.
function readBolt(st, i) {
  const p = st.arcPositions;
  const o = i * st.boltVerts;
  let any = false;
  for (let k = 0; k < st.boltVerts; k++) if (p[o + k] !== 0) { any = true; break; }
  if (!any) return null;
  const trunkFloats = st.arcSegs * 6;
  const forkFloats = st.forkSegs * 6;
  const pt = (base) => ({ x: p[base], y: p[base + 1], z: p[base + 2] });
  const forks = [];
  for (let f = 0; f < st.forkCount; f++) {
    const fo = o + trunkFloats + f * forkFloats;
    forks.push({ from: pt(fo), to: pt(fo + (st.forkSegs - 1) * 6 + 3) });
  }
  const joints = [];
  joints.push(pt(o));
  for (let s = 1; s <= st.arcSegs; s++) joints.push(pt(o + (s - 1) * 6 + 3));
  return { from: pt(o), to: pt(o + (st.arcSegs - 1) * 6 + 3), forks, joints };
}

// A corner of the ring, in the ANIMAL'S frame — which is the frame the bolts are
// written in. The whole set rides the boss by moving the LineSegments object,
// because a bolt held for a roll while the boss swims would otherwise be left
// behind by a fraction of a unit a frame, and a fraction of a unit is the
// difference between an endpoint on a corner and an endpoint near one.
function cornerAt(ring, index) {
  const n = electricNode(ring, index);
  return {
    x: Math.cos(n.angle) * n.radius,
    y: Math.sin(n.angle) * n.radius,
    outward: n.outward,
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ===========================================================================
section('THE RING HOLDS ITS JAGS');
// ===========================================================================
// The regression that matters most, because its symptom is a ring that looks
// fine in a still and averages to a smooth band in motion. The step counter is
// an accumulated phase now; what is asserted is that it climbs at the rate the
// config asks for, however hard the charge breathes underneath it.
{
  const { e, ring } = fight();
  const rate = CONFIG.fx?.organicRing?.elecRate ?? 13;
  const marks = [];
  let backwards = 0;
  let last = ring.material.uniforms.uElecStep.value;
  let biggestJump = 0;
  // Long enough that uTime is well past the point where the old form came
  // apart: the error grew WITH the clock, so a two-second run would have passed.
  for (let f = 0; f < 60 * 45; f++) {
    stepFrame(e);
    const s = ring.material.uniforms.uElecStep.value;
    if (s < last) backwards++;
    biggestJump = Math.max(biggestJump, s - last);
    last = s;
    if (f % 60 === 59) marks.push(s);
  }
  const perSecond = (marks.at(-1) - marks[0]) / (marks.length - 1);
  // The rate is the config's, scaled by 0.6 + 0.8 * charge with the aura's
  // charge breathing between 0.75 and 1 — so between 1.2x and 1.4x of it.
  check('the re-roll counter climbs at about the rate the config asks for',
    perSecond > rate * 1.1 && perSecond < rate * 1.5,
    `${perSecond.toFixed(1)} rolls a second against elecRate ${rate}`);
  check('...and never runs backwards', backwards === 0,
    `${backwards} frames of ${60 * 45} went back in time`);
  // The old bug in one number. At 45 seconds in, floor(uTime * rate) moved by
  // more than twenty steps in a single frame every time the charge breathed.
  check('...and never skips more than a couple of rolls in one frame',
    biggestJump <= 2, `worst frame advanced ${biggestJump} rolls`);
  // And the hold is real: a jag that survives several frames is the whole
  // difference between arcs and a fuzzy band.
  let heldFrames = 0;
  let framesSeen = 0;
  let prev = ring.material.uniforms.uElecStep.value;
  for (let f = 0; f < 600; f++) {
    stepFrame(e);
    framesSeen++;
    const s = ring.material.uniforms.uElecStep.value;
    if (s === prev) heldFrames++;
    prev = s;
  }
  check('...so most frames are drawn on a jag the frame before was also drawing',
    heldFrames > framesSeen * 0.5,
    `${heldFrames}/${framesSeen} frames held their shape`);
}

// ===========================================================================
section('THE EDGE SPENDS ITS BUDGET, AND NOT A UNIT MORE');
// ===========================================================================
{
  const { e, ring } = fight();
  const u = ring.material.uniforms;
  const reach = e.radius + (perk.radius ?? 9);
  const cap = CONFIG.fx?.organicRing?.wobbleMax ?? 0.18;
  const amp = Math.min(u.uWobble.value / u.uRadius.value, u.uWobbleMax.value);
  // Before this, uWobble was the shared half a world unit and uRadius was the
  // aura's reach, so amp came out at well under one percent.
  check('the aura edge runs at an amplitude that can actually be seen',
    amp > 0.05, `${(amp * 100).toFixed(1)}% of a ${reach.toFixed(1)}u radius`);
  check('...and never past the shared ceiling the ring audit measures',
    u.uWobbleMax.value <= cap + 1e-9,
    `wobbleMax ${u.uWobbleMax.value} against organicRing.wobbleMax ${cap}`);

  // The dial is clamped rather than trusted. Turned up past the ceiling it must
  // saturate, because the ceiling is the promise the player reads the ring by.
  const shipped = fx.edgeWobble;
  fx.edgeWobble = 5;
  const wild = fight();
  check('...even when the per-perk dial is turned past it',
    wild.ring.material.uniforms.uWobbleMax.value <= cap + 1e-9,
    `edgeWobble 5 gave wobbleMax ${wild.ring.material.uniforms.uWobbleMax.value}`);
  fx.edgeWobble = shipped;

  // And every corner stays inside that promise, which is the thing the ceiling
  // is a ceiling ON.
  const again = fight();
  let worst = 0;
  for (let f = 0; f < 120; f++) {
    stepFrame(again.e);
    const n = electricNodeCount(again.ring);
    const rad = again.ring.material.uniforms.uRadius.value;
    for (let i = 0; i < n; i++) worst = Math.max(worst, electricNode(again.ring, i).radius / rad);
  }
  check('no corner of the zigzag reaches past the radius times the ceiling',
    worst <= 1 + cap + 1e-6, `worst corner at ${worst.toFixed(3)}x the reach`);
}

// ===========================================================================
section('EVERY BOLT RUNS FROM THE BODY TO A CORNER');
// ===========================================================================
{
  const { e, st, ring, lines } = fight();
  const reach = e.radius + (perk.radius ?? 9);
  const inset = fx.boltInset ?? 0.55;

  let seen = 0;
  let onCorner = 0;
  let outward = 0;
  let onBody = 0;
  let forksOnCorner = 0;
  let forksSeen = 0;
  let forksRooted = 0;
  let bad = 0;
  let worstEnd = 0;

  for (let f = 0; f < 60 * 20; f++) {
    stepFrame(e);
    const n = electricNodeCount(ring);
    for (let i = 0; i < st.arcCount; i++) {
      const bolt = readBolt(st, i);
      if (!bolt) continue;
      seen++;
      if (!Number.isFinite(bolt.to.x) || !Number.isFinite(bolt.to.y)) bad++;

      // THE ENDPOINT IS A CORNER. Nearest node wins, and the distance to it has
      // to be zero — not small. Both ends of this are solved by electricNode,
      // so anything but an exact hit is a buffer stride or an index that has
      // come adrift, and both of those draw something that still looks like
      // lightning.
      let best = Infinity;
      let bestI = -1;
      for (let k = 0; k < n; k++) {
        const d = dist(bolt.to, cornerAt(ring, k));
        if (d < best) { best = d; bestI = k; }
      }
      worstEnd = Math.max(worstEnd, best);
      if (best < 1e-6) onCorner++;
      if (cornerAt(ring, bestI).outward) outward++;

      // ...AND THE OTHER END IS ON THE ANIMAL.
      const fromR = Math.hypot(bolt.from.x, bolt.from.y);
      if (Math.abs(fromR - e.radius * inset) < 1e-6) onBody++;

      for (const fk of bolt.forks) {
        forksSeen++;
        // A fork leaves a genuine joint of its trunk. Recomputing the
        // displacement instead of reading it back would put the root NEAR the
        // trunk, which is two bolts rather than one forking.
        if (bolt.joints.some((j) => dist(j, fk.from) < 1e-9)) forksRooted++;
        let fb = Infinity;
        let fbI = -1;
        for (let k = 0; k < n; k++) {
          const d = dist(fk.to, cornerAt(ring, k));
          if (d < fb) { fb = d; fbI = k; }
        }
        // ...and lands on a corner NEXT TO the one its trunk took. A fork that
        // stopped in open water would be the one part of this still floating
        // free of the ring.
        const gap = Math.min(Math.abs(fbI - bestI), n - Math.abs(fbI - bestI));
        if (fb < 1e-6 && gap > 0 && gap <= st.forkCount) forksOnCorner++;
      }
    }
  }

  check('bolts are being struck at all', seen > 50, `${seen} live bolt-frames over 20s`);
  check('every one of them ends exactly on a corner of the ring',
    seen > 0 && onCorner === seen, `${onCorner}/${seen}, worst miss ${worstEnd.toExponential(1)}u`);
  check('...on a corner leaning OUTWARD, which is the one that looks struck',
    outward === seen, `${outward}/${seen}`);
  check('...and starts on the body rather than in open water',
    onBody === seen, `${onBody}/${seen} at ${(inset * 100).toFixed(0)}% of the hitbox radius`);
  check('...with nothing NaN in the buffer', bad === 0, `${bad} bolts`);
  check('every fork leaves a real joint of its trunk',
    forksSeen > 0 && forksRooted === forksSeen, `${forksRooted}/${forksSeen}`);
  check('...and lands on a neighbouring corner of the same zigzag',
    forksSeen > 0 && forksOnCorner === forksSeen, `${forksOnCorner}/${forksSeen}`);
  check('the whole set rides the animal rather than being left in the water',
    Math.hypot(lines.position.x - e.mesh.position.x, lines.position.y - e.mesh.position.y) < 1e-9,
    `boss at ${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)}`);
  check('the whole set is still one draw call',
    lines.isLineSegments === true && lines.geometry.attributes.position.count
      === st.arcCount * st.boltVerts / 3,
    `${st.arcCount} slots x ${st.boltVerts / 3} vertices`);
}

// ===========================================================================
section('AND NO BOLT OUTLIVES THE CORNER IT ENDS ON');
// ===========================================================================
// The fusion is a shared clock and nothing else. A bolt allowed to run past a
// re-roll is drawn against corners that have already moved — which is not a
// visible break, just the effect quietly coming apart.
{
  const { e, st, ring } = fight();
  let stale = 0;
  let checked = 0;
  let maxAlive = 0;
  let strikes = 0;
  // Counted off the ROLL each slot was struck on, not off the slot going empty.
  // A slot is almost always restruck on the same frame its bolt died — the
  // strike loop starts at zero — so it never appears empty between two bolts,
  // and "slots that showed up this frame" undercounts by a factor of four.
  const born = new Float64Array(st.arcCount).fill(NaN);
  for (let f = 0; f < 60 * 20; f++) {
    stepFrame(e);
    const step = ring.material.uniforms.uElecStep.value;
    let alive = 0;
    for (let i = 0; i < st.arcCount; i++) {
      if (!readBolt(st, i)) continue;
      alive++;
      checked++;
      if (st.arcStep[i] !== step) stale++;
      if (born[i] !== st.arcStep[i]) { strikes++; born[i] = st.arcStep[i]; }
    }
    maxAlive = Math.max(maxAlive, alive);
  }
  check('no live bolt is ever left over from an earlier re-roll',
    stale === 0, `${stale}/${checked} bolt-frames were stale`);
  // ...and the population is not passing that by being empty, nor by being
  // every slot at once, which would mean the cadence had collapsed.
  check('...while the field still has bolts in it and never fills every slot',
    maxAlive > 0 && maxAlive < st.arcCount, `at most ${maxAlive} of ${st.arcCount} alive at once`);
  // THE TUNED RATE IS STILL THE RATE. Strikes may only land on a re-roll now,
  // so the fraction is carried across frames rather than rounded away — without
  // that carry, 14 a second against a ~17Hz ring becomes 17.
  const perSecond = strikes / 20;
  check('...and they arrive at about the rate arcRate asks for',
    Math.abs(perSecond - (fx.arcRate ?? 14)) < (fx.arcRate ?? 14) * 0.25,
    `${perSecond.toFixed(1)} a second against arcRate ${fx.arcRate ?? 14}`);
}

// ===========================================================================
section('THE FIELD IS YELLOW, AND VOLTAIC IS NOT');
// ===========================================================================
// The threat palette answers "what kind of harm is this" and CONFIG.biolum
// .elements answers "what does the player's ability look like". For every other
// element those are one number on purpose. `electric` is the one entry that
// names both an element and a literal colour — a deliberate split, and the
// thing that makes it work is threatType preferring the literal. Get that
// precedence backwards and the ring silently goes back to cyan, which looks
// exactly like a colour that was never changed.
{
  const t = threatType('electric');
  const voltaic = CONFIG.biolum?.elements?.shock?.color;
  const c = new THREE.Color(t.color);
  check('the electric threat reads as yellow', c.r > 0.85 && c.g > 0.7 && c.b < 0.5,
    `#${t.color.toString(16).padStart(6, '0')}`);
  check('...taken from the entry\'s own colour, not its element',
    t.color !== voltaic, `threat #${t.color.toString(16)} vs shock #${voltaic?.toString(16)}`);
  // ...and the join is still LIVE for everything that did not opt out, or the
  // precedence flip would have quietly cut every other element loose.
  const venom = threatType('venom');
  check('...while venom still reads its colour straight off its element',
    venom.color === CONFIG.biolum?.elements?.venom?.color,
    `#${venom.color.toString(16)}`);
  // And it still blooms. The bright pass thresholds LUMINANCE — blue is worth
  // 7% — so the old cyan could not cross it at any glow the ring was willing to
  // run at. This is the number that changed.
  const lum = (col) => {
    const k = new THREE.Color(col);
    return 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
  };
  check('...and carries far more luminance into the bright pass than the cyan did',
    lum(t.color) > lum(0x8fe6ff) * 0.95,
    `${lum(t.color).toFixed(2)} against the old ${lum(0x8fe6ff).toFixed(2)}`);
}

// ===========================================================================
section('THE SURGE IS ON THE HALF NOTE');
// ===========================================================================
// The ring used to breathe on a free sine at `pulseHz`, a rate picked by eye
// and therefore never quite in time with the music. What is measured here is
// the PERIOD of the glow overdrive against what a half note is actually worth
// at the tempo being heard — the only way to tell a field on the grid from one
// that happens to be near it.
{
  const { e, ring } = fight();
  const half = divisionSeconds('1/2');
  const u = ring.material.uniforms;
  // Peaks of the overdrive. Read off uGlow rather than off the cycle counter:
  // the counter is the thing under test, and a number checked against itself
  // proves nothing.
  const glow = [];
  for (let f = 0; f < 60 * 12; f++) {
    stepFrame(e);
    glow.push(u.uGlow.value);
  }
  const peaks = [];
  for (let i = 1; i < glow.length - 1; i++) {
    if (glow[i] > glow[i - 1] && glow[i] >= glow[i + 1]) peaks.push(i * DT);
  }
  const gaps = peaks.slice(1).map((t, i) => t - peaks[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  check('the overdrive surges once per half note', gaps.length > 4 && Math.abs(mean - half) < half * 0.1,
    `${mean.toFixed(3)}s between surges against a ${half.toFixed(3)}s half note`);
  // ...and not on the old free rate, which is the failure that looks like
  // success: 3.5Hz is a perfectly respectable-looking pulse.
  const freeSecs = 1 / (CONFIG.boss?.perkFx?.electric?.pulseHz ?? 3.5);
  check('...and not on the free rate it used to run at',
    Math.abs(mean - freeSecs) > freeSecs * 0.25,
    `${mean.toFixed(3)}s against pulseHz's ${freeSecs.toFixed(3)}s`);

  const lo = Math.min(...glow);
  const hi = Math.max(...glow);
  const fx2 = CONFIG.boss?.perkFx?.electric ?? {};
  check('...between the ring\'s floor and its floor plus the beat\'s add',
    Math.abs(lo - (fx2.ringGlow ?? 2.2)) < 0.15
      && Math.abs(hi - ((fx2.ringGlow ?? 2.2) + (fx2.beatGlow ?? 1.6))) < 0.15,
    `${lo.toFixed(2)} .. ${hi.toFixed(2)}`);
  // The floor must be a real floor. A ring whose glow never comes down is a
  // ring that is always blooming, which is a ring with no beat in it.
  check('...and the trough is genuinely darker than the peak', hi > lo * 1.3,
    `${(hi / lo).toFixed(2)}x`);
}

// ===========================================================================
section('ONLY A BOLT TOUCHING YOU SHOCKS YOU');
// ===========================================================================
// The aura used to damage the whole disc at a flat rate, so where the player
// stood inside it changed nothing. Now the bolts are the hitbox. Three ways
// that goes wrong and still looks right on screen:
//
//   THE DEAD SLOTS. A bolt that is not alive is collapsed to the ORIGIN rather
//   than removed from the buffer — which is inside the boss. Without the skip
//   in zapPlayer every dead slot reads as a bolt touching anyone standing on
//   the animal, and a player at point blank takes twelve zaps a frame.
//   THE FORKS. A strike is a trunk and two branches. Charging per stroke makes
//   a fork worth triple, and how many branches a bolt has is a drawing
//   decision.
//   THE FRAME. The buffer is in the animal's frame and the player is in the
//   world's. Testing them against each other unconverted damages whoever is
//   standing at the world origin.
{
  const shots = [];
  const hk = {
    onPlayerHit: (dmg, dir, src) => { shots.push({ dmg, src }); return dmg; },
  };
  const fx2 = CONFIG.boss?.perkFx?.electric ?? {};

  // An independent answer to "was anything actually touching the seal", built
  // from the buffer by a different route from the one under test.
  const touching = (st, e, at, radius) => {
    const px = at.x - e.mesh.position.x;
    const py = at.y - e.mesh.position.y;
    const p = st.arcPositions;
    let n = 0;
    for (let i = 0; i < st.arcCount; i++) {
      if (!(st.arcLife[i] > 0)) continue;
      const o = i * st.boltVerts;
      for (let k = 0; k < st.boltVerts; k += 6) {
        const ax = p[o + k]; const ay = p[o + k + 1];
        const bx = p[o + k + 3]; const by = p[o + k + 4];
        if (ax === 0 && ay === 0 && bx === 0 && by === 0) continue;
        const vx = bx - ax; const vy = by - ay;
        const l2 = vx * vx + vy * vy;
        let t = l2 > 1e-12 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + vx * t - px; const qy = ay + vy * t - py;
        if (qx * qx + qy * qy <= radius * radius) { n++; break; }
      }
    }
    return n;
  };

  // --- standing in the middle of the field ---------------------------------
  {
    const { e, st } = fight();
    const at = { x: 0, y: 4 };
    const radius = 1 + (fx2.boltHitRadius ?? 0.35);
    hk.playerRadius = 1;
    shots.length = 0;
    let expected = 0;
    // Each bolt may only charge once per re-roll, so the expectation counts
    // (slot, roll) pairs that were touching — not touching FRAMES, which would
    // be three or four times as many and is the shape of the bug.
    const charged = new Float64Array(st.arcCount).fill(NaN);
    for (let f = 0; f < 60 * 25; f++) {
      e.mesh.position.set(0, 0, 0); e.vx = 0; e.vy = 0;
      stepFrame(e, at, hk);
      for (let i = 0; i < st.arcCount; i++) {
        if (!(st.arcLife[i] > 0) || charged[i] === st.arcStep[i]) continue;
        if (touching({ ...st, arcCount: 1, arcLife: [st.arcLife[i]], arcPositions: st.arcPositions.subarray(i * st.boltVerts, (i + 1) * st.boltVerts) }, e, at, radius)) {
          charged[i] = st.arcStep[i];
          expected++;
        }
      }
    }
    check('a seal standing inside the field is shocked, but only sometimes',
      shots.length > 3 && shots.length < 25 * 14,
      `${shots.length} zaps in 25s against ${(25 * 14)} strikes`);
    check('...exactly once per bolt that touched it, forks and all',
      shots.length === expected, `${shots.length} charged against ${expected} touching`);
    check('...every one of them at the row\'s rate times zapSeconds',
      shots.every((z) => Math.abs(z.dmg - (16 * (fx2.zapSeconds ?? 0.5))) < 1e-6),
      `${shots[0]?.dmg} each`);
    check('...and all of them named as the shock', shots.every((z) => z.src === 'bossShock'));
  }

  // --- standing ON the boss ------------------------------------------------
  // The dead-slot guard. Every unused slot is a run of segments sitting at the
  // origin, which is exactly where the seal is here.
  {
    const { e, st } = fight();
    const at = { x: 0, y: 0 };
    hk.playerRadius = 1;
    shots.length = 0;
    let frames = 0;
    let dead = 0;
    for (let f = 0; f < 60 * 8; f++) {
      e.mesh.position.set(0, 0, 0); e.vx = 0; e.vy = 0;
      stepFrame(e, at, hk);
      frames++;
      for (let i = 0; i < st.arcCount; i++) if (!(st.arcLife[i] > 0)) dead++;
    }
    check('a dead slot collapsed to the origin is not a bolt',
      shots.length < frames * 0.2,
      `${shots.length} zaps against ${dead} dead-slot frames on top of the seal`);
  }

  // --- standing outside it --------------------------------------------------
  {
    const { e } = fight();
    const reach = e.radius + (perk.radius ?? 9);
    const at = { x: reach * 3, y: 0 };
    hk.playerRadius = 1;
    shots.length = 0;
    for (let f = 0; f < 60 * 8; f++) {
      e.mesh.position.set(0, 0, 0); e.vx = 0; e.vy = 0;
      stepFrame(e, at, hk);
    }
    check('nothing reaches a seal outside the ring', shots.length === 0,
      `${shots.length} zaps at ${(reach * 3).toFixed(1)}u from a ${reach.toFixed(1)}u field`);
  }

  // --- and the presentation is gated on the damage LANDING ------------------
  // main.js wraps onPlayerHit so an invulnerable seal takes nothing and gets 0
  // back. A flash and a spray of sparks on a dash the player deliberately timed
  // to pass through would be the effect announcing a hit that did not happen.
  {
    const { e } = fight();
    const at = { x: 0, y: 4 };
    let calls = 0;
    const events = [];
    const invuln = {
      playerRadius: 1,
      onPlayerHit: () => { calls++; return 0; },
    };
    onFeedback((name) => { if (name === 'bossShockZap') events.push(name); });
    for (let f = 0; f < 60 * 15; f++) {
      e.mesh.position.set(0, 0, 0); e.vx = 0; e.vy = 0;
      stepFrame(e, at, invuln);
    }
    check('an invulnerable seal is still reached by the bolts', calls > 3, `${calls} attempts`);
    check('...and nothing is thrown on screen for a hit that did not land',
      events.length === 0, `${events.length} zap events`);
  }
}

// ===========================================================================
section('AND THE SEAL\'S OWN BODY SAYS SO');
// ===========================================================================
// The third channel on a player hit, beside the rim and the eyes — both of
// which are AROUND the animal rather than on it. What is checked is the part
// that is easy to get wrong and impossible to see: the seal's GLB material is
// SHARED with the escort pod and the menu bust, so a flash written straight
// onto it lights every seal in the game, and a body swap mid-flash leaves the
// old one hot forever.
{
  const litMat = () => new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0x000000, emissiveIntensity: 0 });
  // ONE MATERIAL, TWO BODIES — the shipped situation exactly: a GLB clone shares
  // its template's material by reference.
  const shared = litMat();
  const seal = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  const escort = new THREE.Mesh(new THREE.BoxGeometry(), shared);

  resetPlayerFlash();
  setPlayerFlashTarget(seal);
  check('a body is attached', playerFlashAttached());
  check('...on a material of its own, not the one the escort is wearing',
    seal.material !== escort.material,
    'a shared write here lights the whole pod and the menu bust');

  flashPlayer(1, 'playerZap');
  // dt 0 is the moment of the hit. A frame of decay in between would measure
  // the curve rather than the peak, and `inCubic` has already given a quarter
  // of it away by then.
  updatePlayerFlash(0);
  const peak = seal.material.emissiveIntensity;
  const row = CONFIG.damageGlow?.sources?.playerZap ?? {};
  check('a zap lights the body', peak > 0.5, `emissiveIntensity ${peak.toFixed(2)}`);
  check('...at the playerZap row\'s own brightness and colour',
    Math.abs(peak - (row.peak ?? 0)) < 1e-6
      && seal.material.emissive.getHex() === (row.color ?? 0),
    `${peak.toFixed(2)} against peak ${row.peak}, #${seal.material.emissive.getHexString()}`);
  check('...and the escort beside it is untouched',
    escort.material.emissiveIntensity === 0, `${escort.material.emissiveIntensity}`);

  // ...and it FALLS. A flash that held would be a glow.
  updatePlayerFlash(1 / 60);
  check('...and starts falling on the next frame',
    seal.material.emissiveIntensity < peak, `${seal.material.emissiveIntensity.toFixed(2)}`);

  // A WEAKER HIT INSIDE A STRONGER ONE RAISES IT, never dims it — otherwise the
  // second zap of a pair reads as the thing that ENDED the flash.
  const mid = playerFlashLevel();
  flashPlayer(0.2, 'playerZap');
  updatePlayerFlash(0);
  check('a smaller hit inside a bigger one does not dim it',
    playerFlashLevel() >= mid - 1e-9, `${playerFlashLevel().toFixed(3)} against ${mid.toFixed(3)}`);

  // ...and it goes out.
  const secs = CONFIG.fx?.playerFlash?.seconds ?? 0.18;
  for (let f = 0; f < Math.ceil(secs * 60) + 4; f++) updatePlayerFlash(1 / 60);
  check('...and it is off again inside its own window',
    playerFlashLevel() === 0 && seal.material.emissiveIntensity === 0,
    `${seal.material.emissiveIntensity} after ${secs}s`);

  // A BODY SWAP MID-FLASH. The old seal must be handed back cold: on the menu
  // bust, a heat left behind is a heat left behind forever.
  flashPlayer(1, 'playerZap');
  updatePlayerFlash(1 / 60);
  const other = new THREE.Mesh(new THREE.BoxGeometry(), litMat());
  setPlayerFlashTarget(other);
  check('swapping bodies mid-flash leaves the old one cold',
    seal.material.emissiveIntensity === 0, `${seal.material.emissiveIntensity}`);
  check('...and nothing is on the new one until it is hit',
    other.material.emissiveIntensity === 0);

  // Re-pointing at the same root every frame — which is what main.js does — must
  // not re-clone. A fresh clone per frame is a material leak with no symptom
  // except a frame time that climbs.
  const before = other.material;
  for (let f = 0; f < 10; f++) setPlayerFlashTarget(other);
  check('...and pointing at the same body again is free',
    other.material === before, 'a re-clone per frame is a silent leak');

  resetPlayerFlash();
  setPlayerFlashTarget(null);
}

// ===========================================================================
section('AND IT ALL GOES AWAY WITH THE FIGHT');
// ===========================================================================
{
  const { e } = fight();
  for (let f = 0; f < 60; f++) stepFrame(e);
  resetBossPerks();
  resetEnemies(scene);
  check('the ring and the bolts leave the scene with the boss',
    !scene.children.some((c) => isOrganicRing(c) || c.isLineSegments),
    `${scene.children.length} objects left`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
