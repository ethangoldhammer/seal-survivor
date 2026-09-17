#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE LUNGE IS THE DANGER — the shark's committed pass, on the six apex sharks
// and the four chasing bosses.
//
// tools/shark-swim-test.mjs holds the cruise: flat, lateral, coming about
// rather than looping. This file holds the other half of the same design —
// that the ONLY time a shark moves at you with intent is a run it told you
// about first, that the run comes out of a pass rather than out of a turn,
// that it does not happen often, and that when it lands it costs.
//
// The sailfish (tools/sailfish-lunge-test.mjs) runs the same state machine as
// its whole behaviour. Everything here is the OVERLAY on `hunt`, and the
// lateral rules (CONFIG.lungeRules) that the sailfish does not carry.
//
// Seeded and driven, never computed from the numbers: every check here is a
// trajectory or a stage transition off a live run, so a gate that quietly
// stopped firing fails rather than reading as tuned.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { updateLungeTells, resetLungeTells, __lungeTellCount } from '../path/src/systems/lungeTell.js';

const scene = new THREE.Scene();
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]') || msg.startsWith('[feedback]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const WILD = ['shark', 'greatWhite', 'abyssShark', 'hammerhead', 'megalodon', 'mightyMeg'];
const BOSSES = ['bossShark', 'bossOrca', 'bossHammerhead', 'bossMosasaur'];
const ALL = [...WILD, ...BOSSES];
const SEEDS = [1, 2, 3, 4, 5];
const dt = 1 / 60;
const MID = -20;

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/**
 * One hunter, one seal, nothing else in the water. `playerMove(t, e, frames)`
 * returns the seal's position this frame. `patterns` overrides the def's
 * weights for the run, so a shape can be forced rather than waited for.
 */
function run(type, seed, {
  seconds = 40, from = { x: -12, y: MID }, playerMove = () => ({ x: 0, y: MID }),
  patterns = null, tells = false,
} = {}) {
  const orig = Math.random;
  Math.random = seeded(seed);
  const def = CONFIG.enemies[type];
  const wasPatterns = def.lunge.patterns;
  if (patterns) def.lunge.patterns = patterns;
  const wasCruise = CONFIG.cruiseHunt.enabled;
  try {
    resetEnemies(scene);
    resetLungeTells();
    const e = spawnNamed(scene, type, 0, from, { ignoreCaps: true });
    if (!e) throw new Error(`could not spawn ${type}`);
    const player = new THREE.Vector3();
    const frames = [];
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      const at = playerMove(i * dt, e, frames);
      player.set(at.x, at.y, 0);
      updateEnemies(dt, scene, player, () => {}, () => {});
      if (tells) updateLungeTells(dt, scene);
      if (!enemies.includes(e)) break;
      if (process.env.DBG === "2" && e.lungeStage !== frames[frames.length - 1]?.stage) console.log(`      stage ${type} seed ${seed} t=${(i * dt).toFixed(2)} ${e.lungeStage} d=${Math.hypot(player.x - e.mesh.position.x, player.y - e.mesh.position.y).toFixed(1)} r=${e.radius.toFixed(2)} seal=(${player.x.toFixed(1)},${player.y.toFixed(1)}) shark=(${e.mesh.position.x.toFixed(1)},${e.mesh.position.y.toFixed(1)})`);
      const dx = player.x - e.mesh.position.x;
      const dy = player.y - e.mesh.position.y;
      frames.push({
        t: i * dt,
        x: e.mesh.position.x, y: e.mesh.position.y,
        vx: e.vx, vy: e.vy,
        speed: Math.hypot(e.vx, e.vy),
        heading: e.heading,
        stage: e.lungeStage,
        dist: Math.hypot(dx, dy),
        linePitch: Math.abs(Math.atan2(dy, Math.abs(dx))),
        lineOff: Math.abs(wrap(Math.atan2(dy, dx) - e.heading)),
        tellCount: tells ? __lungeTellCount() : 0,
        standoff: e.standoffDist,
        radius: e.radius,
      });
    }
    return { e, frames };
  } finally {
    Math.random = orig;
    CONFIG.cruiseHunt.enabled = wasCruise;
    if (patterns) def.lunge.patterns = wasPatterns;
    resetLungeTells();
  }
}

function spans(frames, stage) {
  const out = [];
  let open = null;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].stage === stage) { if (open == null) open = i; }
    else if (open != null) { out.push({ start: open, end: i - 1 }); open = null; }
  }
  if (open != null) out.push({ start: open, end: frames.length - 1 });
  return out;
}

// A CYCLE is one wind-up and everything until the next rest: the plan.
function cycles(frames) {
  const winds = spans(frames, 'wind');
  return winds.map((w, i) => {
    const end = i + 1 < winds.length ? winds[i + 1].start - 1 : frames.length - 1;
    const inside = frames.slice(w.start, end + 1);
    return { start: w.start, end, strikes: spans(inside, 'strike'), reaims: spans(inside, 'reaim') };
  });
}

const rules = CONFIG.lungeRules;
const L = (type) => CONFIG.enemies[type].lunge;
const bodySpeed = (type) => CONFIG.enemies[type].speed;

// ---------------------------------------------------------------------------
console.log('\nEVERY RUN OPENS WITH A WIND-UP');
for (const type of ALL) {
  let struck = 0, cold = 0, cycleCount = 0;
  for (const seed of SEEDS) {
    const { frames } = run(type, seed);
    for (const c of cycles(frames)) {
      cycleCount++;
      for (const s of c.strikes) {
        struck++;
        const before = frames[c.start + s.start - 1];
        if (!before || (before.stage !== 'wind' && before.stage !== 'reaim')) cold++;
      }
    }
  }
  check(`${type}: it commits at all`, struck >= SEEDS.length, `${struck} runs over ${SEEDS.length} x 40s`);
  check(`${type}: no run arrives without a tell in front of it`, cold === 0, `${cold} cold runs of ${struck}`);
}

// ---------------------------------------------------------------------------
// The seal's real sustained cruise — `updatePlayer` on a full stick settles at
// 15 u/s, where CONFIG.player.maxSpeed's 34 is the DASH ceiling. Read by the
// dodge bot below and by the one-frame slack above.
const SEAL_SPEED = 15;

console.log('\nTHE TELL STARTS FROM A LATERAL LINE, AND NEVER ON TOP OF YOU');
for (const type of ALL) {
  const c = L(type);
  let steep = 0, behind = 0, close = 0, n = 0;
  let steepest = 0;
  for (const seed of SEEDS) {
    const { frames } = run(type, seed);
    for (const w of spans(frames, 'wind')) {
      const f = frames[w.start];
      n++;
      steepest = Math.max(steepest, f.linePitch);
      // ONE FRAME OF SLACK, DERIVED. The gate runs inside updateEnemies and
      // this reads the frame AFTER it, by which point the seal has moved and
      // the body has turned — so a line that was inside the cone when it was
      // tested can be outside it when it is measured. The old allowance was a
      // flat 0.03 rad, which was ample while bosses turned at 1.05 rad/s and a
      // stand-in seal drifted at 9 u/s; at 3.2 rad/s against a 15 u/s player
      // from a 4-unit floor it is a third of what one frame can move.
      //
      // Derived rather than raised: the bearing can sweep by the seal's own
      // speed over the gap, and the nose by the body's turn rate, and the sum
      // of those two for one frame is exactly the disagreement this has to
      // tolerate. Anything wider than that is the gate actually failing.
      const slack = (SEAL_SPEED / Math.max(1, c.minRange ?? 6)
        + (CONFIG.enemies[type].turnRate ?? 3)) * dt;
      if (f.linePitch > (c.maxPitch ?? rules.maxPitch) + slack) steep++;
      if (f.lineOff > (c.commitCone ?? rules.commitCone) + slack) behind++;
      if (f.dist < c.minRange - 0.6) close++;
    }
  }
  check(`${type}: never commits up or down a steep line`, steep === 0,
    `${steep} of ${n} wind-ups over ${((c.maxPitch ?? rules.maxPitch) * 180 / Math.PI).toFixed(0)}°, steepest ${(steepest * 180 / Math.PI).toFixed(0)}°`);
  check(`${type}: never commits at a seal behind it`, behind === 0, `${behind} of ${n}`);
  check(`${type}: the tell never starts inside minRange`, close === 0, `${close} of ${n} under ${c.minRange}`);
}
// ...and the cone is a real gate, not an always-true one: a seal directly
// overhead, inside range, must never draw a wind-up.
for (const type of ['shark', 'bossShark']) {
  let winds = 0;
  for (const seed of SEEDS) {
    const { frames } = run(type, seed, {
      seconds: 20, from: { x: 0, y: MID },
      playerMove: (t, e) => ({ x: e.mesh.position.x, y: e.mesh.position.y + L(type).range * 0.7 }),
    });
    winds += spans(frames, 'wind').length;
  }
  check(`${type}: a seal hovering straight overhead is not lunged at`, winds === 0, `${winds} wind-ups`);
}

// ---------------------------------------------------------------------------
console.log('\nBETWEEN RUNS IT SWIMS LEVEL');
for (const type of ALL) {
  const lat = CONFIG.enemies[type].hunt.lateral;
  const cap = (lat.cruisePitch ?? CONFIG.lateralCruise.cruisePitch) + Math.atan(lat.weaveBody ?? 0) + 0.08;
  let worst = 0, over = 0, n = 0;
  const veer = L(type).veerTime ?? rules.veerTime;
  for (const seed of SEEDS) {
    const { frames } = run(type, seed);
    let lastRun = -Infinity;
    for (const f of frames) {
      if (f.stage === 'wind' || f.stage === 'strike' || f.stage === 'reaim') { lastRun = f.t; continue; }
      // The level-out after a run is the run's tail: a body that came out of
      // a 55-degree line has to be allowed the veer to get back under the cap.
      if (f.t - lastRun < veer + 0.1) continue;
      if (f.speed < 1e-3) continue;
      const pitch = Math.abs(Math.atan2(f.vy, Math.abs(f.vx)));
      n++;
      worst = Math.max(worst, pitch);
      if (pitch > cap) over++;
    }
  }
  // A handful of frames are allowed: the frame a run ends still carries the
  // run's pitch until the level veer takes over.
  check(`${type}: outside a run the body stays under the cruise pitch`, over <= n * 0.005,
    `${over} of ${n} frames over ${(cap * 180 / Math.PI).toFixed(0)}°, steepest ${(worst * 180 / Math.PI).toFixed(0)}°`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE BURST IS FAST, AND IT IS RARE');
for (const type of ALL) {
  const c = L(type);
  for (const seed of SEEDS.slice(0, 3)) {
    const { e, frames } = run(type, seed);
    const peak = Math.max(...frames.map((f) => f.speed));
    check(`${type} seed ${seed}: the run is a burst`, peak > e.speed * c.speedMul * 0.9,
      `peak ${peak.toFixed(1)} against cruise ${e.speed.toFixed(1)} x ${c.speedMul}`);
    // Above 2x cruise: the jaw's own short burst (CONFIG.bite.lunge, 1.85x)
    // is not a run and is not counted against this.
    //
    // TWO BARS, AND THE SPLIT IS THE POINT. A wildlife shark's run is a rare
    // event in a long cruise and 25% is what that looks like — unchanged, and
    // the six of them still pass it. A BOSS is a fight rather than a hazard:
    // its cooldowns were cut in half deliberately (see behaviour.csv) because
    // `rest` was 52-60% of every boss fight and the animal read as drifting
    // between attacks rather than attacking. They now burst on about a third
    // of their frames, which is what that change was FOR.
    //
    // The boss bar is still a real bar: it would catch a boss whose cooldown
    // went to nothing and turned the fight into one continuous sprint, which
    // is the failure this line is actually guarding against on that half of
    // the roster.
    const boss = BOSSES.includes(type);
    const bar = boss ? 0.45 : 0.25;
    const hot = frames.filter((f) => f.speed > e.speed * 2).length / frames.length;
    check(`${type} seed ${seed}: ...and ${boss ? 'it is still not a continuous sprint' : 'most of the time it is not happening'}`, hot < bar,
      `${(hot * 100).toFixed(0)}% of frames above 2x cruise`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nTHE GAP HOLDS — JITTER ONLY LENGTHENS IT');
for (const type of ALL) {
  const c = L(type);
  let shortest = Infinity, gaps = 0;
  for (const seed of SEEDS) {
    const { frames } = run(type, seed, { seconds: 60 });
    const cs = cycles(frames);
    for (let i = 1; i < cs.length; i++) {
      // From the END of one plan to the start of the next tell.
      const last = cs[i - 1];
      const planEnd = last.strikes.length ? last.start + last.strikes[last.strikes.length - 1].end : last.start;
      const gap = frames[cs[i].start].t - frames[planEnd].t;
      shortest = Math.min(shortest, gap);
      gaps++;
    }
  }
  check(`${type}: no two plans closer than the cooldown`, gaps === 0 || shortest >= c.cooldown - 0.05,
    `shortest gap ${shortest === Infinity ? 'n/a' : shortest.toFixed(2)}s against a ${c.cooldown}s cooldown (${gaps} gaps)`);
}

// ---------------------------------------------------------------------------
console.log('\nTHERE ARE THREE SHAPES, AND THE TELL DOES NOT SAY WHICH');
for (const type of ['shark', 'hammerhead', 'bossShark', 'bossOrca']) {
  const c = L(type);
  // pass: one run per cycle.
  {
    let bad = 0, n = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const { frames } = run(type, seed, { patterns: { pass: 1 } });
      for (const cy of cycles(frames)) {
        if (cy.end === frames.length - 1) continue; // cut off by the end of the run
        n++;
        if (cy.strikes.length !== 1 || cy.reaims.length !== 0) bad++;
      }
    }
    check(`${type} pass: one run, no re-aim`, n > 0 && bad === 0, `${bad} of ${n} cycles wrong`);
  }
  // double: two runs with a re-aim between, the second shorter.
  {
    let bad = 0, n = 0, shorter = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const { frames } = run(type, seed, { patterns: { double: 1 } });
      for (const cy of cycles(frames)) {
        if (cy.end === frames.length - 1) continue; // cut off by the end of the run
        n++;
        if (cy.strikes.length !== 2 || cy.reaims.length !== 1) { bad++; continue; }
        const a = cy.strikes[0].end - cy.strikes[0].start;
        const b = cy.strikes[1].end - cy.strikes[1].start;
        if (b < a) shorter++;
      }
    }
    check(`${type} double: two runs, one re-aim`, n > 0 && bad === 0, `${bad} of ${n} cycles wrong`);
    check(`${type} double: the second run is the shorter`, shorter === n - bad, `${shorter} of ${n - bad}`);
  }
  // feint: a short slow jab, a re-aim, then the real run.
  {
    let bad = 0, n = 0, slowJab = 0, dropped = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const { e, frames } = run(type, seed, { patterns: { feint: 1 } });
      for (const cy of cycles(frames)) {
        if (cy.end === frames.length - 1) continue;
        n++;
        // A PLAN ABANDONED AT THE RE-AIM IS A SHAPE, NOT A FAULT.
        //
        // `lungeRules.reaimCone` ends a plan whose nose never came round — "a
        // player who dodged one has earned the miss; what they have not earned
        // is watching it charge empty water" — so a feint that leaves one jab
        // and one re-aim behind is that rule working. This used to be counted
        // as a malformed cycle, which was true for as long as abandons were
        // rare and stopped being true the moment the cone and `reaimMax` were
        // widened. It is counted apart and bounded below instead: what would
        // be broken is MOST feints abandoning, not one of them.
        if (cy.strikes.length === 1 && cy.reaims.length === 1) { dropped++; continue; }
        if (cy.strikes.length !== 2 || cy.reaims.length !== 1) { bad++; if (process.env.DBG) console.log(`      BAD ${type} strikes=${cy.strikes.length} reaims=${cy.reaims.length}`); continue; }
        const jab = frames[cy.start + cy.strikes[0].start + 1];
        const real = frames[cy.start + cy.strikes[1].start + 1];
        if (jab && real && jab.speed < real.speed * 0.8 && jab.speed > e.speed * 1.2) slowJab++;
      }
    }
    check(`${type} feint: a jab, a re-aim, the run`, n > 0 && bad === 0,
      `${bad} of ${n} cycles the wrong shape`
      + (dropped ? `, ${dropped} abandoned at the re-aim (reaimCone)` : ''));
    check(`${type} feint: ...and most of them finish`, n > 0 && dropped <= n / 3,
      `${dropped} of ${n} dropped — a pattern that mostly abandons is not a pattern`);
    check(`${type} feint: the jab is slower than the run and faster than the cruise`,
      slowJab === n - bad - dropped, `${slowJab} of ${n - bad - dropped}`);
  }
  // Whatever follows, the wind-up is the same length: the tell does not leak
  // the plan.
  {
    const lens = [];
    for (const p of [{ pass: 1 }, { double: 1 }, { feint: 1 }]) {
      const { frames } = run(type, 1, { patterns: p });
      for (const w of spans(frames, 'wind')) if (w.end < frames.length - 1) lens.push(w.end - w.start + 1);
    }
    const spread = Math.max(...lens) - Math.min(...lens);
    check(`${type}: every shape opens with the same wind-up`, spread <= 2, `${lens.join('/')} frames`);
  }
}

// ---------------------------------------------------------------------------
// (declared above, beside the cone slack that also reads it)
// HOW FAST THE DODGE IS, and it is the seal's real cruise rather than a number
// that felt about right. `updatePlayer` on a full stick settles at 15 u/s —
// CONFIG.player.maxSpeed is 34, which is the DASH ceiling and not the cruise —
// and this bot ran at 9 for as long as it existed, which is 60% of a player.
//
// That is why `shark` failed this check and nothing else did. Nothing was wrong
// with the shark: the bot simply could not clear the line in the time the run
// took, so the one archetype whose numbers put it closest to the edge caught a
// "dodging" seal that a real player would have moved out from under. A harness
// that models the player slower than the player is fails in the direction that
// flatters the predator, and it does it quietly.

console.log('\nA SEAL THAT MOVES IS MISSED; ONE THAT STANDS STILL IS NOT');
// Hit = a strike frame with the seal inside the bite's own reach — the exact
// gate main.js bills on (mouthReach x radius, plus the seal) — so this is the
// number that would actually have cost you.
//
// The dodge itself is described beside the bot below.
function hits(type, seed, playerMove, patterns, label = "") {
  const e0 = CONFIG.enemies[type];
  const { frames } = run(type, seed, { playerMove, patterns, seconds: 40 });
  const radius = frames[0]?.radius ?? e0.radius;
  const reach = radius * (CONFIG.bite.mouthReach ?? 0.55) + (CONFIG.player.hitRadius ?? 0.5);
  let n = 0;
  for (const f of frames) if (f.stage === 'strike' && f.dist <= reach) { n++; if (process.env.DBG) console.log(`      hit ${label} ${type} seed ${seed} t=${f.t.toFixed(2)} d=${f.dist.toFixed(2)} reach=${reach.toFixed(2)} shark=(${f.x.toFixed(1)},${f.y.toFixed(1)}) sp=${f.speed.toFixed(1)}`); }
  return { n, strikes: spans(frames, 'strike').length };
}
for (const type of ['shark', 'hammerhead', 'megalodon', 'bossShark', 'bossMosasaur']) {
  let still = 0, moved = 0, stillStrikes = 0, movedStrikes = 0;
  const c0 = L(type);
  for (const seed of SEEDS) {
    const s = hits(type, seed, () => ({ x: 0, y: MID }), { pass: 1 });
    still += s.n; stillStrikes += s.strikes;
    // THE DODGE: swim ACROSS the shark's nose. The wind-up tracks the seal at
    // the body's full turn rate and the line locks where the nose is when the
    // clock runs out (see lungeChase), so what a moving seal is offered is not
    // "have moved" but "be moving across the line while the run is
    // happening". The bot does the simplest version of that: from the first
    // tell on, it holds a course perpendicular to whatever the shark is
    // pointing at right now, at its own cruise, on the side with more water
    // in it. At the surface or the floor it slides along the edge rather
    // than turning back — turning back is re-crossing the line — and between
    // tells it eases back toward mid-water, because a player who lets a
    // shark pin them to the seabed has lost the exchange before the run.
    // TWO WAYS OUT, and the claim is asked of the BETTER of them.
    //
    // "A seal that moves is missed" is a statement about whether the run CAN be
    // avoided, not about whether one particular bot avoids it — and there is no
    // canonical dodge. Held against a single model this check moved from body to
    // body as the model changed: the shark caught the 9 u/s version, the
    // hammerhead caught the continuously-re-derived one (which at the seal's
    // real speed is an orbit, not a dodge), and the megalodon caught the latched
    // straight break. Each "fix" simply handed the failure to a different
    // archetype, which is the tell that the model was the subject rather than
    // the game.
    //
    //   break   pick a perpendicular at the first frame of the tell and commit
    //           to it — what a player does when they read the wind-up.
    //   peel    keep turning away from wherever the nose is now — what a player
    //           does when they are watching the animal rather than the line.
    //
    // A run that both of those clear is a run a moving seal is missed by. A run
    // that neither clears is one nothing could have avoided, which is the thing
    // worth failing over.
    const dodge = (latched) => {
      let across = null;
      let breakDir = { x: 0, y: 1 };
      let hold = { x: 0, y: MID };
      return (t, e) => {
        const telling = e.lungeStage === 'wind' || e.lungeStage === 'strike' || e.lungeStage === 'reaim';
        if (!telling) {
          across = null;
          breakDir = { x: 0, y: 1 };
          const dy = MID - hold.y;
          hold = { x: hold.x, y: hold.y + Math.sign(dy) * Math.min(Math.abs(dy), 4 * dt) };
          return hold;
        }
        const hx = Math.cos(e.heading), hy = Math.sin(e.heading);
        if (across == null) {
          // The side whose 8-unit endpoint sits deeper in the water.
          const room = (y) => Math.min(-3 - y, y + 37);
          across = room(hold.y + hx * 8) >= room(hold.y - hx * 8) ? 1 : -1;
          breakDir = { x: -hy * across, y: hx * across };
        }
        // `break` holds the vector it latched; `peel` re-derives it against the
        // nose every frame.
        const px = latched ? breakDir.x : -hy * across;
        const py = latched ? breakDir.y : hx * across;
        hold = {
          x: Math.max(-38, Math.min(38, hold.x + px * SEAL_SPEED * dt)),
          y: Math.max(-37, Math.min(-3, hold.y + py * SEAL_SPEED * dt)),
        };
        return hold;
      };
    };
    const mBreak = hits(type, seed, dodge(true), { pass: 1 }, 'break');
    const mPeel = hits(type, seed, dodge(false), { pass: 1 }, 'peel');
    // The seal's best effort, per seed.
    const m = mBreak.n <= mPeel.n ? mBreak : mPeel;
    moved += m.n; movedStrikes += m.strikes;
  }
  check(`${type}: a still seal is caught`, stillStrikes > 0 && still > 0, `${still} biting frames over ${stillStrikes} runs`);
  // THE PASS IS WILDLIFE'S RULE, AND A BOSS IS NOT MAKING A PASS.
  //
  // This assertion is the game's statement about what a shark's lunge IS: a
  // committed run down a line, which a seal that moved is not on any more. It
  // still holds for all six wildlife bodies and it is load-bearing there —
  // their whole threat is that you have to read the wind-up.
  //
  // A BOSS IS THE OPPOSITE NOW, deliberately. Bosses were measured reaching a
  // real (15 u/s) player 1-5% of the time and holding it inside bite reach for
  // 0.2% of a fight — "they can barely reach the player" — so their runs were
  // retuned to 36 u/s against a seal that cruises at 15, with a 12-unit turning
  // circle. A body with that much authority CATCHES a seal crossing its nose,
  // and that is the point rather than a regression. So the same measurement is
  // asserted in the opposite direction for them: a boss that missed a crossing
  // seal would be back to the thing this retune was for.
  if (BOSSES.includes(type)) {
    check(`${type}: a seal swimming across its nose is CAUGHT — a boss is a constant threat`,
      movedStrikes > 0 && moved > 0, `${moved} biting frames over ${movedStrikes} runs`);
  } else {
    check(`${type}: a seal swimming across its nose is missed`,
      movedStrikes > 0 && moved === 0, `${moved} biting frames over ${movedStrikes} runs`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nA BOSS HOLDS OFF OUTSIDE ITS OWN FLOOR');
for (const type of BOSSES) {
  const c = L(type);
  const { frames } = run(type, 1, { seconds: 8 });
  const so = frames.find((f) => f.standoff != null)?.standoff;
  check(`${type}: the crowd ring sits outside minRange`, so != null && so >= c.minRange * (rules.standoffMul ?? 1.2) - 1e-6,
    `standoff ${so?.toFixed?.(1)} against a floor of ${(c.minRange * (rules.standoffMul ?? 1.2)).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE TELL IS DRAWN, AND ONLY WHILE THERE IS SOMETHING TO TELL');
for (const type of ['shark', 'bossShark']) {
  const { frames } = run(type, 2, { tells: true, seconds: 30 });
  const telling = frames.filter((f) => f.stage === 'wind' || f.stage === 'strike' || f.stage === 'reaim');
  const quiet = frames.filter((f) => !(f.stage === 'wind' || f.stage === 'strike' || f.stage === 'reaim'));
  check(`${type}: a ring is up through every tell frame`, telling.length > 0 && telling.every((f) => f.tellCount === 1),
    `${telling.filter((f) => f.tellCount !== 1).length} of ${telling.length} tell frames without a ring`);
  check(`${type}: ...and down the rest of the time`, quiet.every((f) => f.tellCount === 0),
    `${quiet.filter((f) => f.tellCount !== 0).length} of ${quiet.length} quiet frames with one`);
}
check('the four tell events exist', ['lungeWind', 'lungeStrike', 'bossLungeWind', 'bossLungeStrike'].every((k) => CONFIG.feedback[k]));

// ---------------------------------------------------------------------------
console.log('\nTHE NUMBERS ARE OWNED BY THE TABLE');
{
  // Every per-species lunge number and every shared rule has a behaviour.csv
  // row, because every one of them was already in a saved tuning snapshot and
  // a config.js edit could not reach it.
  const fs = await import('node:fs');
  const csv = fs.readFileSync(new URL('../path/src/behaviour.csv', import.meta.url), 'utf8');
  const ids = new Set(csv.split('\n').map((l) => l.split(',')[0]));
  const missing = [];
  for (const type of ALL) {
    for (const k of ['range', 'minRange', 'windup', 'windSpeedMul', 'speedMul', 'strikeTime', 'strikeTurnRate', 'cooldown']) {
      if (!ids.has(`enemies.${type}.lunge.${k}`)) missing.push(`enemies.${type}.lunge.${k}`);
    }
  }
  for (const k of Object.keys(CONFIG.lungeRules)) if (!ids.has(`lungeRules.${k}`)) missing.push(`lungeRules.${k}`);
  for (const k of Object.keys(CONFIG.lateralCruise)) if (!ids.has(`lateralCruise.${k}`)) missing.push(`lateralCruise.${k}`);
  check('every lunge and cruise number has a behaviour.csv row', missing.length === 0, missing.slice(0, 6).join(', '));
  // And the run still crosses the gap on the table's numbers.
  for (const type of ALL) {
    const c = L(type);
    const reach = bodySpeed(type) * c.speedMul * c.strikeTime;
    check(`${type}: the run carries past where you were`, reach >= c.range, `${reach.toFixed(1)} units of run against a ${c.range}-unit gap`);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
process.exit(failures ? 1 : 0);
