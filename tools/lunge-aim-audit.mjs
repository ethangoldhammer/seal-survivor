#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run aim [body] [--dodge] [--trace]
//
// WHERE A COMMITTED RUN ACTUALLY GOES, and which of the three things that could
// be wrong with it is.
//
// `npm run gates` says how OFTEN a body commits and what stops it. This says
// what happens after it does — the question "it keeps missing" is actually
// about, and one the gate table cannot answer because every run in it is a
// commit that already happened.
//
// THREE CANDIDATES, and they want opposite fixes:
//
//   (a) NO LEAD      lungeChase steers at ctx.dirX/dirY, which is where the
//                    seal IS. Nothing in the lunge leads a moving target.
//   (b) TURN LIMIT   `strikeTurnRate` x `strikeTime` is the entire steering
//                    authority a run has. On most of the roster that is ten to
//                    seventeen degrees for the whole pass.
//   (c) BAD LAUNCH   the wind-up never finished turning onto you, and nothing
//                    re-checks the cone at the end of it — a second run of a
//                    `double` gets `reaimCone`, the first run of every plan
//                    gets nothing.
//
// The discriminator is the counterfactual: each run is re-flown from its own
// launch frame aimed at a constant-velocity INTERCEPT instead of at the seal,
// under the same `strikeTurnRate`. If the lead version lands and the real one
// does not, it is (a). If neither lands, the run never had the authority and it
// is (b) or (c) — and the wind-up's two ends tell those apart.
//
// TWO SEALS, and the truth is between them:
//
//   default   a lazy circuit at about the seal's own cruise. A normally-moving
//             player.
//   --dodge   breaks perpendicular to the shark's heading the moment the tell
//             starts. This is the WORST case and is deliberately unfair:
//             perpendicular-to-the-nose held continuously is a tangential
//             ORBIT, and no turn-limited body can ever converge on one (see
//             the same failure in systems/kraken.js's charge). Read it as the
//             floor, not as a player.
//
// `--trace` prints one wind-up frame by frame — bearing, heading and the rate
// of each — which is how you tell a tell that is converging from one the seal
// is out-turning.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();
const realWarn = console.warn;
console.warn = (m, ...r) => {
  if (typeof m === 'string' && /^\[(animation|assets|feedback)\]/.test(m)) return;
  realWarn(m, ...r);
};

const TYPE = process.argv[2] ?? 'shark';
// A SEAL THAT REACTS. `--dodge` makes it break perpendicular the moment the
// shark enters a wind-up, which is what a player who can read the tell does and
// the one case the lazy circuit below cannot show.
const DODGE = process.argv.includes('--dodge');
const TRACE = process.argv.includes('--trace');
let traced = 0;
const dt = 1 / 60;
const MID = -20;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SECONDS = 120;

// THE SEAL'S REAL SPEED, measured rather than guessed: updatePlayer on a full
// stick settles at 15 u/s (CONFIG.player.maxSpeed is 34, which is the dash
// ceiling, not the cruise). Both audits in this directory used to drive it at
// 7-9, which is HALF a real player — and every figure they produced was
// therefore measured against a target moving at half speed, in the direction
// that flatters the boss. A boss's committed run is 20-24 u/s, so the closing
// speed against a real seal is four units a second rather than fifteen.
const SEAL_SPEED = 15;

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

// A seal that swims a lazy circuit at roughly its own cruise.
function swimmer(seed) {
  const rnd = seeded(seed + 7777);
  const speed = SEAL_SPEED * (0.85 + rnd() * 0.3);
  const r = 10 + rnd() * 8;
  const phase = rnd() * Math.PI * 2;
  return (t) => ({
    x: Math.cos(phase + (t * speed) / r) * r,
    y: MID + Math.sin(phase * 1.7 + (t * speed) / (r * 1.4)) * (r * 0.45),
  });
}

const DEF = CONFIG.enemies[TYPE];
const REACH = (DEF.radius ?? 1) * (CONFIG.bite?.mouthReach ?? 0.55) + (CONFIG.player?.hitRadius ?? 0.5);
const runs = [];
const cruise = [];
for (const seed of SEEDS) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    resetEnemies(scene);
    const at = swimmer(seed);
    const e = spawnNamed(scene, TYPE, 6, { x: -22, y: MID }, { ignoreCaps: true });
    if (TYPE.startsWith('boss')) e.isBoss = true;
    const pos = new THREE.Vector3();
    let live = null;
    let lastStage = null;
    let dodgeSide = 1;
    let windStart = 0;
    let windFrames = 0;
    let lastHeading = 0;
    let lastBearing = 0;
    let windEnd = 0;
    // How close it gets at ANY moment, run or not — the cruise's own answer to
    // "does this animal ever reach me", which the per-run figures cannot give.
    let everMin = Infinity;
    let framesInReach = 0;
    let prev = at(0);
    for (let i = 0; i < Math.round(SECONDS / dt); i++) {
      const t = i * dt;
      const p = at(t);
      // THE DODGE IS APPLIED BEFORE `pos` IS FILLED, and the order is the whole
      // correctness of this file. Written the other way round — pos.set(p) and
      // then mutate p — the game was handed the CIRCUIT position while every
      // measurement here was taken against the DODGED one, so the two were
      // different points and the tool reported a 37-degree "launch error" on
      // runs the shark had aimed perfectly. It is the classic harness failure:
      // it measured its own stand-in rather than the thing under test, and it
      // did it in the direction that confirms the bug you went looking for.
      if (DODGE && (e.lungeStage === 'wind' || e.lungeStage === 'strike')) {
        // Break perpendicular to the shark's heading, at the seal's own cruise.
        const away = (e.heading ?? 0) + Math.PI / 2 * (dodgeSide || 1);
        p.x = prev.x + Math.cos(away) * SEAL_SPEED * dt;
        p.y = prev.y + Math.sin(away) * SEAL_SPEED * dt;
      } else if (DODGE) {
        dodgeSide = Math.sin(t * 0.37) > 0 ? 1 : -1;
      }
      pos.set(p.x, p.y, 0);
      const sealVx = (p.x - prev.x) / dt;
      const sealVy = (p.y - prev.y) / dt;
      prev = p;

      updateEnemies(dt, scene, pos, () => {}, () => {});
      if (!enemies.includes(e)) break;

      const ex = e.mesh.position.x;
      const ey = e.mesh.position.y;
      const stage = e.lungeStage;
      const nowGap = Math.hypot(p.x - ex, p.y - ey);
      everMin = Math.min(everMin, nowGap);
      if (nowGap <= REACH) framesInReach++;

      // The wind-up's own two ends: is the tell CONVERGING on the seal, or is
      // the seal outrunning the turn? A launch error of 37 degrees means one of
      // two completely different things depending on where the wind-up started.
      if (stage === 'wind' && lastStage !== 'wind') {
        windStart = Math.abs(wrap(Math.atan2(p.y - ey, p.x - ex) - (e.heading ?? 0)));
      }
      if (stage === 'wind') {
        windEnd = Math.abs(wrap(Math.atan2(p.y - ey, p.x - ex) - (e.heading ?? 0)));
        if (TRACE && traced < 1) {
          const bearing = Math.atan2(p.y - ey, p.x - ex);
          console.log(`   wind f${windFrames.toString().padStart(2)}  gap ${nowGap.toFixed(1).padStart(5)}  `
            + `bearing ${(bearing * 180 / Math.PI).toFixed(0).padStart(5)}  heading ${((e.heading ?? 0) * 180 / Math.PI).toFixed(0).padStart(5)}  `
            + `err ${(windEnd * 180 / Math.PI).toFixed(0).padStart(3)}  `
            + `head turned ${(wrap((e.heading ?? 0) - lastHeading) * 180 / Math.PI / dt).toFixed(0).padStart(5)} deg/s  `
            + `bearing moved ${(wrap(bearing - lastBearing) * 180 / Math.PI / dt).toFixed(0).padStart(5)} deg/s`);
          lastBearing = bearing;
        }
        windFrames++;
      }
      if (stage !== 'wind' && lastStage === 'wind' && TRACE) { traced++; windFrames = 0; }
      lastHeading = e.heading ?? 0;

      if (stage === 'strike' && lastStage !== 'strike') {
        // The launch frame. Everything that decides the run is fixed here.
        const step = e.lungePlan?.[e.lungeStep];
        const speed = e.speed * (step?.speedMul ?? e.def.lunge.speedMul ?? 3.6);
        const toSeal = Math.atan2(p.y - ey, p.x - ex);
        // The intercept a constant-velocity lead would have picked.
        const gap = Math.hypot(p.x - ex, p.y - ey);
        const tof = gap / Math.max(1, speed);
        const lx = p.x + sealVx * tof;
        const ly = p.y + sealVy * tof;
        live = {
          launchErr: Math.abs(wrap(toSeal - e.heading)),
          leadErr: Math.abs(wrap(Math.atan2(ly - ey, lx - ex) - e.heading)),
          gap,
          speed,
          sealSpeed: Math.hypot(sealVx, sealVy),
          min: Infinity,
          minLead: Infinity,
          // The same run re-flown from the launch frame with the lead heading,
          // under the SAME strikeTurnRate — so the comparison isolates the aim
          // and holds the turn limit fixed.
          simX: ex, simY: ey, simH: Math.atan2(ly - ey, lx - ex),
          frames: 0,
          windStart,
          windEnd,
        };
      }

      if (stage === 'strike' && live) {
        live.min = Math.min(live.min, Math.hypot(p.x - ex, p.y - ey));
        // Fly the counterfactual one frame, same rules as the strike branch.
        const rate = e.def.lunge.strikeTurnRate ?? 0.5;
        const want = Math.atan2(p.y - live.simY, p.x - live.simX);
        const d = wrap(want - live.simH);
        live.simH += Math.min(Math.abs(d), rate * dt) * Math.sign(d);
        live.simX += Math.cos(live.simH) * live.speed * dt;
        live.simY += Math.sin(live.simH) * live.speed * dt;
        live.minLead = Math.min(live.minLead, Math.hypot(p.x - live.simX, p.y - live.simY));
        live.frames++;
      }

      if (stage !== 'strike' && lastStage === 'strike' && live) {
        runs.push(live);
        live = null;
      }
      lastStage = stage;
    }
    cruise.push({ everMin, framesInReach, seconds: SECONDS });
  } finally {
    Math.random = orig;
  }
}

const def = DEF;
// The gate onPlayerBite measures: the creature's radius x mouthReach + the
// seal's hit radius. Radius here is the def's, since these bodies are spawned
// at a fixed difficulty.
const reach = REACH;
const deg = (r) => ((r * 180) / Math.PI).toFixed(0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, f) => (a.filter(f).length / a.length * 100).toFixed(0);

console.log(`\n${TYPE}${DODGE ? ' (seal DODGES the tell)' : ' (seal swims a circuit)'} — ${runs.length} committed runs over ${SEEDS.length} x ${SECONDS}s, seal swimming.\n`);
console.log(`  bite reach                 ${reach.toFixed(2)}u  (radius ${def.radius} x mouthReach ${CONFIG.bite.mouthReach} + seal ${CONFIG.player.hitRadius})`);
console.log(`  run speed / turn           ${med(runs.map((r) => r.speed)).toFixed(1)} u/s, ${deg(def.lunge.strikeTurnRate)} deg/s  -> turning circle ${(med(runs.map((r) => r.speed)) / (def.lunge.strikeTurnRate ?? 0.5)).toFixed(0)}u`);
console.log(`  seal speed                 ${med(runs.map((r) => r.sealSpeed)).toFixed(1)} u/s`);
console.log(`  gap at launch              ${med(runs.map((r) => r.gap)).toFixed(1)}u, flight ${(med(runs.map((r) => r.frames)) * dt).toFixed(2)}s`);
console.log('');
console.log(`  wind-up opened            median ${deg(med(runs.map((r) => r.windStart)))} deg off you`);
console.log(`  ...and ended              median ${deg(med(runs.map((r) => r.windEnd)))} deg off you   <- the turn ${med(runs.map((r) => r.windEnd)) < med(runs.map((r) => r.windStart)) ? 'converged' : 'LOST GROUND'}`);
console.log(`  launch error (aim at you)  median ${deg(med(runs.map((r) => r.launchErr)))} deg`);
console.log(`  ...if it had led you       median ${deg(med(runs.map((r) => r.leadErr)))} deg`);
console.log('');
console.log(`  CLOSEST APPROACH  real     median ${med(runs.map((r) => r.min)).toFixed(2)}u   connects ${pct(runs, (r) => r.min <= reach)}%`);
console.log(`                    with lead median ${med(runs.map((r) => r.minLead)).toFixed(2)}u   connects ${pct(runs, (r) => r.minLead <= reach)}%`);
console.log('');
// How much of the miss is the turn limit: a run whose launch error is already
// wider than it could turn through in its own flight time was lost before it
// started.
const flight = med(runs.map((r) => r.frames)) * dt;
const turnable = (def.lunge.strikeTurnRate ?? 0.5) * flight;
const reaimCone = CONFIG.lungeRules?.reaimCone ?? Infinity;
console.log(`  ${pct(runs, (r) => r.launchErr > reaimCone)}% launched wider than lungeRules.reaimCone (${deg(reaimCone)} deg) — the check a SECOND run gets and a first never does`);
console.log(`  it can turn ${deg(turnable)} deg over the whole run; ${pct(runs, (r) => r.launchErr > turnable)}% of runs launched wider than that`);
console.log('');
const inReachSecs = cruise.reduce((a, c) => a + c.framesInReach, 0) * dt;
const totalSecs = cruise.reduce((a, c) => a + c.seconds, 0);
console.log(`  THE WHOLE FIGHT, not just the runs:`);
console.log(`    inside bite reach          ${(inReachSecs / totalSecs * 100).toFixed(1)}% of the time (${inReachSecs.toFixed(1)}s of ${totalSecs}s)`);
console.log(`    runs per minute            ${(runs.length / totalSecs * 60).toFixed(1)}`);
console.log('');
