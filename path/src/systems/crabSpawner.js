import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { countFloorPickups, bestChumTarget } from '../entities/pickups.js';
import { bossLockout, enemies, spawnNamed, nightlifeWeight } from '../entities/enemies.js';
import { inSpawnGroup } from '../enemyTable.js';

// ---------------------------------------------------------------------------
// WHICH CRAB. The family is whatever enemies.csv puts in spawnGroup 'crab',
// and the day/night split is that table's `bioluminescent` column weighed
// against CONFIG.spawn.nightlife — the same two curves that swap the cast for
// the rest of the roster. There is no spawn-rate knob of its own here and
// deliberately so: a second place to set how often a crab appears is a second
// place for it to disagree with the table.
//
// THIS FILE IS THE ONLY DOOR CRABS COME THROUGH. Every crab row ships
// spawnRateMul 0, so the ordinary weighted pool never draws one — chum on the
// seabed is what summons them, and that is the design rather than an accident
// of tuning. Putting them in the pool as well was tried and reverted: it made
// crabs ambient wildlife and quietly removed the reason to leave a pile alone.
//
// Because the pool never sees them, the pool's nightlife weighting never
// touches them either, so the day/night changeover has to be applied here.
// CONFIG.spawn.groupMaxAlive.crab bounds the family across both variants.
//
// Read fresh each call rather than cached: the CSV is re-applied live when the
// file changes, and a cached roster would keep spawning a crab whose row had
// just been deleted.
// ---------------------------------------------------------------------------
let warnedNoFamily = false;

function crabFamily() {
  const out = [];
  for (const [key, def] of Object.entries(CONFIG.enemies)) {
    if (inSpawnGroup(def, 'crab')) out.push({ key, def });
  }
  if (out.length) return out;

  // NOTHING MATCHED, which must never mean "no crabs". The old version of this
  // file named 'walkingCrab' directly and so could not fail; reading the family
  // out of the table is better in every way except this one, because the table
  // is data and data can arrive wrong — a CSV that failed to parse, a column
  // renamed, or a dev page whose module graph reloaded config.js without
  // reloading this file, leaving the two looking at different CONFIG objects.
  // Every one of those turns "crabs are summoned by chum" into silence with no
  // error anywhere.
  //
  // `behavior === 'crawl'` is the fallback because it is a fact about the
  // creature that lives in config.js next to the code that reads it, so it
  // cannot go missing at the same time the CSV column does.
  for (const [key, def] of Object.entries(CONFIG.enemies)) {
    if (def?.behavior === 'crawl') out.push({ key, def });
  }
  if (!warnedNoFamily) {
    warnedNoFamily = true;
    console.warn('[crabSpawner] no enemy row carries spawnGroup "crab" — enemies.csv may not have '
      + `applied. Falling back to behavior 'crawl': ${out.map((c) => c.key).join(', ') || 'nothing at all'}.`);
  }
  return out;
}

// How many crabs of ANY kind are on the seabed. The cap has to be a family
// count, not a per-type one: at dusk both variants are spawning, and two caps
// of ten is twenty crabs.
function crabCount() {
  let n = 0;
  for (const e of enemies) {
    if (inSpawnGroup(CONFIG.enemies[e.type], 'crab')) n++;
  }
  return n;
}

// One draw, weighted by how far through the changeover the sky is. At noon the
// glowing curve is 0 and this can only return the day crab; at full dark the
// daylight curve is 0.08, so roughly one crab in thirteen still walks on
// unlit, which is the same straggler rate the rest of the roster gets.
// Exported for tools/nightlife-test.mjs, which uses it to check the SUMMONED
// half of the changeover. The pool half is covered by the ordinary spawn
// simulation there.
export function pickCrab(difficulty) {
  const all = crabFamily();
  if (!all.length) return null;

  // `minDifficulty` is a CSV column and it has to bind HERE too. The weighted
  // pool checks it; spawnNamed, which is how this file spawns, does not. So
  // without this the night crab's "not before difficulty 1.5" would hold on the
  // pool side and be quietly ignored by every chum-pile wave.
  //
  // Falls back to the unfiltered family rather than to nothing: the day crab
  // ships minDifficulty 0.4, so a strict filter would mean no crabs at all in
  // the first eight seconds of a run and the death pile-on would come up empty
  // if you died in them. Gating the VARIANTS against each other is what this is
  // for; it is not a licence to switch the system off.
  const family = all.filter(({ def }) => (def.minDifficulty ?? 0) <= difficulty);
  if (!family.length) return all[0].key;

  let total = 0;
  const weights = family.map(({ def }) => {
    const w = Math.max(0, nightlifeWeight(!!def.bioluminescent));
    total += w;
    return w;
  });

  // Both curves suppressed to nothing — possible if someone zeroes them in the
  // tuner. Falling through to the first row keeps crabs arriving rather than
  // silently switching the whole system off, which would look like a bug in
  // the pile logic rather than in the curves.
  if (total <= 0) return family[0].key;

  let r = Math.random() * total;
  for (let i = 0; i < family.length; i++) {
    r -= weights[i];
    if (r <= 0) return family[i].key;
  }
  return family[family.length - 1].key;
}

let timer = 0;
// The death pile-on: how many crabs are still owed, and when the next one is
// due. Both wall off from the ordinary pile check above — see summonDeathPile.
let pileLeft = 0;
let pileTimer = 0;
let pileGap = 0;

export function resetCrabSpawner() {
  timer = CONFIG.crabSpawn.checkInterval;
  pileLeft = 0;
  pileTimer = 0;
}

// Crabs walk on from off the side of the arena rather than appearing in the
// middle of the seabed. Which side is decided by where the chum actually is —
// they come from whichever edge is further from the pile, so the arrival is a
// visible scuttle across the floor instead of a pop-in next to the food.
function edgeFloorPoint() {
  const margin = CONFIG.crabSpawn.spawnMargin ?? 3;
  const pile = bestChumTarget(0, bounds.bottom, Infinity, CONFIG.crabSpawn.clusterRadius ?? 6);
  const pileX = pile ? pile.mesh.position.x : 0;
  const mid = (bounds.left + bounds.right) * 0.5;
  // Further edge, with a little randomness so a wave doesn't file in from one
  // side in a perfectly straight line.
  const fromLeft = pileX > mid ? Math.random() < 0.85 : Math.random() < 0.15;
  return {
    x: fromLeft ? bounds.left - margin : bounds.right + margin,
    y: bounds.bottom + CONFIG.crabSpawn.floorHeight * 0.5,
  };
}

// The same walk-on, but aimed at a point instead of at the chum: the crabs
// come from whichever edge is NEARER, because the pile-on has only the length
// of a death dive to form and a crab starting from the far wing never arrives.
function edgePointNear(x) {
  const margin = CONFIG.crabSpawn.spawnMargin ?? 3;
  const mid = (bounds.left + bounds.right) * 0.5;
  const fromLeft = x < mid ? Math.random() < 0.85 : Math.random() < 0.15;
  return {
    x: fromLeft ? bounds.left - margin : bounds.right + margin,
    y: bounds.bottom + CONFIG.crabSpawn.floorHeight * 0.5,
  };
}

// THE PILE-ON — armed the moment the seal dies, drained by updateDeathPile.
//
// Only queues the wave; nothing spawns on this call. A dozen crabs appearing
// on the frame of death reads as a spawn, whereas a straggling line walking in
// over the next second and a half reads as the seabed noticing.
export function summonDeathPile() {
  const cfg = CONFIG.crabSpawn.deathPile;
  if (!cfg?.enabled) return;
  const already = crabCount();
  pileLeft = Math.max(0, Math.min(cfg.count ?? 0, (cfg.maxCrabs ?? 20) - already));
  // Spread across the window, with the first one immediately.
  pileGap = (cfg.spawnWindow ?? 1.5) / Math.max(1, pileLeft);
  pileTimer = 0;
}

// Drained from main.js's death branch, on the same dilated clock as everything
// else in the descent, so the arrivals slow down with the rest of the scene
// rather than marching in at full speed under a slow-motion corpse.
//
// Bypasses the normal caps on purpose: `maxConcurrent` and the pile-threshold
// maths exist to keep a FIGHT readable, and there is no fight left. It still
// respects CONFIG.spawn.maxAlive, which is a memory ceiling, not a design one.
export function updateDeathPile(dt, scene, difficulty, at) {
  if (pileLeft <= 0) return;
  pileTimer -= dt;
  if (pileTimer > 0) return;
  pileTimer = pileGap;
  pileLeft--;
  if (enemies.length >= CONFIG.spawn.maxAlive) return;
  const key = pickCrab(difficulty);
  if (key) spawnNamed(scene, key, difficulty, edgePointNear(at?.x ?? 0), { ignoreCaps: true });
}

// Checked on its own timer (not every frame — counting the pickup pile is
// cheap but there's no reason to do it 60 times a second).
export function updateCrabSpawner(dt, scene, difficulty) {
  if (!CONFIG.crabSpawn.enabled) return;
  timer -= dt;
  if (timer > 0) return;
  timer = CONFIG.crabSpawn.checkInterval;

  const floorCount = countFloorPickups();
  if (floorCount < CONFIG.crabSpawn.pileThreshold) return;

  const over = floorCount - CONFIG.crabSpawn.pileThreshold;
  const desired = Math.min(CONFIG.crabSpawn.maxCrabsPerWave, 1 + Math.floor(over / CONFIG.crabSpawn.orbsPerCrab));

  // The headcount is the FAMILY's, and so is the cap it is measured against —
  // the variants all carry the same maxConcurrent, so the smallest of them is
  // the honest ceiling on "how many crabs may be on screen".
  const family = crabFamily();
  const maxConcurrent = family.reduce(
    (m, { def }) => Math.min(m, def.maxConcurrent ?? Infinity), Infinity,
  );
  const n = Math.min(desired, maxConcurrent - crabCount(), CONFIG.spawn.maxAlive - enemies.length);
  if (n <= 0) return;

  // A BOSS FIGHT IS NOT A CHUM PILE. The weighted pool is locked to minions
  // while a boss is in the water, and this is the game's other source of
  // creatures — left ungated, the crabs would be the one thing that carried on
  // walking in, and the clear-out would look broken specifically because the
  // seabed is where the player is farming.
  //
  // The test is on the DRAW rather than on the wave, so a crab variant tagged
  // `bossMinion` in enemies.csv still turns up: a draw that comes back with a
  // non-escort is skipped instead of substituted, which keeps the day/night
  // mix pickCrab exists to produce honest rather than quietly re-rolling it
  // into whichever variant happens to be flagged.
  //
  // Deliberately NOT inside pickCrab: the death pile-on draws from the same
  // function, and a player who dies to a boss leaves it in the water — gating
  // there would mean the corpse gets no crabs at all, which is a different
  // system's whole point.
  const lockout = bossLockout();

  // Drawn per crab rather than once for the wave, so a wave that lands during
  // dusk arrives visibly mixed instead of all-one-kind.
  for (let i = 0; i < n; i++) {
    const key = pickCrab(difficulty);
    if (!key) continue;
    if (lockout && !CONFIG.enemies[key]?.bossMinion) continue;
    spawnNamed(scene, key, difficulty, edgeFloorPoint());
  }
}
