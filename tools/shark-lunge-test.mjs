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
      if (f.linePitch > (c.maxPitch ?? rules.maxPitch) + 0.03) steep++;
      if (f.lineOff > (c.commitCone ?? rules.commitCone) + 0.03) behind++;
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
    const hot = frames.filter((f) => f.speed > e.speed * 2).length / frames.length;
    check(`${type} seed ${seed}: ...and most of the time it is not happening`, hot < 0.25,
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
    let bad = 0, n = 0, slowJab = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const { e, frames } = run(type, seed, { patterns: { feint: 1 } });
      for (const cy of cycles(frames)) {
        if (cy.end === frames.length - 1) continue;
        n++;
        if (cy.strikes.length !== 2 || cy.reaims.length !== 1) { bad++; continue; }
        const jab = frames[cy.start + cy.strikes[0].start + 1];
        const real = frames[cy.start + cy.strikes[1].start + 1];
        if (jab && real && jab.speed < real.speed * 0.8 && jab.speed > e.speed * 1.2) slowJab++;
      }
    }
    check(`${type} feint: a jab, a re-aim, the run`, n > 0 && bad === 0, `${bad} of ${n} cycles wrong`);
    check(`${type} feint: the jab is slower than the run and faster than the cruise`, slowJab === n - bad, `${slowJab} of ${n - bad}`);
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
console.log('\nA SEAL THAT MOVES IS MISSED; ONE THAT STANDS STILL IS NOT');
// Hit = a strike frame with the seal inside the bite's own reach — the exact
// gate main.js bills on (mouthReach x radius, plus the seal) — so this is the
// number that would actually have cost you.
//
// The dodge itself is described beside the bot below.
function hits(type, seed, playerMove, patterns) {
  const e0 = CONFIG.enemies[type];
  const { frames } = run(type, seed, { playerMove, patterns, seconds: 40 });
  const radius = frames[0]?.radius ?? e0.radius;
  const reach = radius * (CONFIG.bite.mouthReach ?? 0.55) + (CONFIG.player.hitRadius ?? 0.5);
  let n = 0;
  for (const f of frames) if (f.stage === 'strike' && f.dist <= reach) { n++; if (process.env.DBG) console.log(`      hit ${type} seed ${seed} t=${f.t.toFixed(2)} d=${f.dist.toFixed(2)} reach=${reach.toFixed(2)} shark=(${f.x.toFixed(1)},${f.y.toFixed(1)}) sp=${f.speed.toFixed(1)}`); }
  return { n, strikes: spans(frames, 'strike').length };
}
for (const type of ['shark', 'hammerhead', 'megalodon', 'bossShark', 'bossMosasaur']) {
  let still = 0, moved = 0, stillStrikes = 0, movedStrikes = 0;
  const c0 = L(type);
  for (const seed of SEEDS) {
    const s = hits(type, seed, () => ({ x: 0, y: MID }), { pass: 1 });
    still += s.n; stillStrikes += s.strikes;
    // THE DODGE: swim ACROSS the shark's nose, always. The wind-up tracks the
    // seal at the body's full turn rate and the line locks where the nose is
    // when the clock runs out (see lungeChase), so what a moving seal is
    // offered is not "have moved" but "be moving across the line while the
    // run is happening". The bot does the simplest version of that: from the
    // first tell on, it holds a course perpendicular to whatever the shark is
    // pointing at right now, at its own cruise, keeping the same sense so it
    // does not jitter, and turning back only for the surface or the floor.
    let across = null; // +1 / -1: which perpendicular
    let hold = { x: 0, y: MID };
    const m = hits(type, seed, (t, e) => {
      const telling = e.lungeStage === 'wind' || e.lungeStage === 'strike' || e.lungeStage === 'reaim';
      if (!telling) return hold;
      const hx = Math.cos(e.heading), hy = Math.sin(e.heading);
      let px = -hy, py = hx;
      if (across == null) across = (hold.y + py * 6 > -4 || hold.y + py * 6 < -36) ? -1 : 1;
      px *= across; py *= across;
      let ny = hold.y + py * 9 * dt;
      if (ny > -3 || ny < -37) { across = -across; px = -px; py = -py; ny = hold.y + py * 9 * dt; }
      hold = { x: Math.max(-38, Math.min(38, hold.x + px * 9 * dt)), y: ny };
      return hold;
    }, { pass: 1 });
    moved += m.n; movedStrikes += m.strikes;
  }
  check(`${type}: a still seal is caught`, stillStrikes > 0 && still > 0, `${still} biting frames over ${stillStrikes} runs`);
  check(`${type}: a seal swimming across its nose is missed`, movedStrikes > 0 && moved === 0, `${moved} biting frames over ${movedStrikes} runs`);
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
