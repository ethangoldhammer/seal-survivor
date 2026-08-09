#!/usr/bin/env node
// Drives systems/apexCrowd.js with plain objects — no scene, no renderer — and
// measures the thing the code exists to produce: a pack that spreads out.
//
// The old behavior is reproducible here by switching the config off, so the
// numbers below are a before/after on identical starting positions rather than
// an assertion that the new code "looks right".
//
//   npm run test:crowd
import { approachVector, assignFeedingSlots, pickStandoff } from '../path/src/systems/apexCrowd.js';

const CFG = {
  enabled: true,
  avoidGap: 3.2,
  avoidStrength: 1.5,
  feedingSlots: 2,
  feedTurn: 4.5,
  incumbentBonus: 2.5,
  standoff: 7,
  standoffJitter: 2.5,
  circleStrength: 1,
};

// Deterministic RNG so a regression is a regression and not a bad roll.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const PLAYER = { x: 0, y: 0 };
const DT = 1 / 60;
const SPEED = 6.5;
const TURN = 2.6;

function makePack(n) {
  const pack = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pack.push({
      x: Math.cos(a) * 26, y: Math.sin(a) * 26, radius: 1.4,
      heading: a + Math.PI, feeding: false, feedTimer: 0, inCrowd: true,
      orbitDir: i % 2 ? 1 : -1, standoffDist: pickStandoff(CFG, rand),
    });
  }
  return pack;
}

function step(pack, cfg) {
  assignFeedingSlots(pack, PLAYER, DT, cfg);
  for (const e of pack) {
    const dx = PLAYER.x - e.x;
    const dy = PLAYER.y - e.y;
    const dist = Math.hypot(dx, dy) || 1e-4;
    const toward = { dirX: dx / dist, dirY: dy / dist, dist };
    const want = approachVector(e, toward, pack, cfg);
    // Same turn-limited integration steerTo uses, so the test exercises the
    // steering as the game actually applies it rather than teleporting.
    const desired = Math.atan2(want.y, want.x);
    let diff = desired - e.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    e.heading += Math.min(Math.abs(diff), TURN * DT) * Math.sign(diff);
    e.x += Math.cos(e.heading) * SPEED * DT;
    e.y += Math.sin(e.heading) * SPEED * DT;
  }
}

function measure(pack) {
  let minGap = Infinity;
  let overlaps = 0;
  for (let i = 0; i < pack.length; i++) {
    for (let j = i + 1; j < pack.length; j++) {
      const d = Math.hypot(pack[i].x - pack[j].x, pack[i].y - pack[j].y);
      minGap = Math.min(minGap, d);
      if (d < pack[i].radius + pack[j].radius) overlaps += 1;
    }
  }
  // Heading spread: the death-screenshot complaint in one number. All facing
  // the same way -> near 0. Evenly fanned -> near 1.
  let sx = 0;
  let sy = 0;
  for (const e of pack) { sx += Math.cos(e.heading); sy += Math.sin(e.heading); }
  const alignment = Math.hypot(sx, sy) / pack.length;
  const dists = pack.map((e) => Math.hypot(e.x - PLAYER.x, e.y - PLAYER.y));
  return {
    minGap,
    overlaps,
    headingSpread: 1 - alignment,
    inside4: dists.filter((d) => d < 4).length,
    meanDist: dists.reduce((a, b) => a + b, 0) / dists.length,
  };
}

function run(label, cfg, seconds = 30) {
  seed = 12345;
  const pack = makePack(6);
  for (let t = 0; t < seconds / DT; t++) step(pack, cfg);
  const m = measure(pack);
  console.log(
    `  ${label.padEnd(22)} closest pair ${m.minGap.toFixed(1).padStart(5)}  overlapping ${String(m.overlaps).padStart(2)}`
    + `  heading spread ${m.headingSpread.toFixed(2)}  within 4u ${m.inside4}/6  mean dist ${m.meanDist.toFixed(1)}`,
  );
  return m;
}

console.log('\n6 apex hunters converging on a stationary player, 30s:\n');
const off = run('crowding OFF (old)', { ...CFG, enabled: false });
const on = run('crowding ON', CFG);
console.log('');

let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures += 1; };
check(on.minGap > off.minGap * 2, `pack spreads out (closest pair ${off.minGap.toFixed(1)} -> ${on.minGap.toFixed(1)})`);
check(on.overlaps === 0, `no overlapping bodies (was ${off.overlaps} pairs)`);
check(on.headingSpread > 0.5, `hunters face different ways (${off.headingSpread.toFixed(2)} -> ${on.headingSpread.toFixed(2)})`);
check(on.inside4 <= CFG.feedingSlots + 1, `only the committed press in (${off.inside4} -> ${on.inside4} within 4 units)`);

// Slots must rotate, or "taking turns" is just a fixed queue.
seed = 12345;
const pack = makePack(6);
const everFed = new Set();
for (let t = 0; t < 40 / DT; t++) {
  step(pack, CFG);
  pack.forEach((e, i) => { if (e.feeding) everFed.add(e.standoffDist.toFixed(4)); });
}
check(everFed.size >= 3, `slots rotate through the pack (${everFed.size} of 6 held the front in 40s)`);

// A hunter outside the apex group (the otter shares this behavior) must be
// completely unaffected: same path, frame for frame. Asserted as equivalence
// against the crowding-off run rather than as a distance, because a lone
// hunter's closest approach is set by its turning circle, not by any of this.
{
  const path = (cfg, inCrowd) => {
    seed = 12345;
    const loner = makePack(1)[0];
    loner.inCrowd = inCrowd;
    const pack = [loner];
    const trail = [];
    for (let t = 0; t < 20 / DT; t++) { step(pack, cfg); trail.push(loner.x, loner.y); }
    return trail;
  };
  const withCrowding = path(CFG, false);
  const withoutCrowding = path({ ...CFG, enabled: false }, false);
  const drift = Math.max(...withCrowding.map((v, i) => Math.abs(v - withoutCrowding[i])));
  check(drift < 1e-9, `a non-apex hunter's path is untouched by crowding (max drift ${drift.toExponential(1)})`);

  // ...and the closest it ever gets is unchanged too, so "unaffected" isn't
  // hiding a hunter that circles without ever arriving.
  seed = 12345;
  const loner = makePack(1)[0];
  loner.inCrowd = false;
  let closest = Infinity;
  for (let t = 0; t < 20 / DT; t++) { step([loner], CFG); closest = Math.min(closest, Math.hypot(loner.x, loner.y)); }
  check(closest < 2, `a non-apex hunter still reaches the player (closest approach ${closest.toFixed(1)} units)`);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
