#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:latch
//
// ONCE THE MAGNET HAS AN ORB, IT KEEPS IT.
//
// The reach is a FIRST TOUCH, not a hold: chum that has started travelling to
// the mouth arrives, and nothing that happens to the reach behind it can
// strand it in mid water. That used to be untrue in four separate ways, and
// every one of them looked identical from the player's chair — food flying at
// the seal, and then simply stopping.
//
//   1. THE REACH CLOSED. The chain window ends, the sweep goes with it, and an
//      orb collected under a 13-unit reach is suddenly outside a 6-unit one.
//   2. THE DASH ENDED, taking its corridor — the widest reach in the game —
//      with it, which is exactly when the water is fullest of claimed orbs.
//   3. SOMETHING ELSE ATE IT. A crab or the whale chewing through an orb that
//      is already on its way to the seal deletes it in flight.
//   4. THE ALIVE CAP TOOK IT. `maxAlive` shifts the OLDEST orb, and an orb the
//      player is about to swallow is very often the oldest one in the water.
//
// Every case below fails LOUDLY without the latch and passes with it. Two of
// them go the other way: an orb nobody has claimed must still sink and settle
// normally, and a sealed mouth must still refuse to drag food inside itself —
// a latch that quietly turns into "everything is always collected" would pass
// the four above and ruin both.
//
// AND IT IS NOT ONLY CHUM. Case 2 is the reason the latch exists and it is a
// fact about the DASH, not about food: the corridor is the widest reach in the
// game and it lasts 0.22 seconds. Every pickup in the game is claimed by it,
// and for a long time only chum survived it ending — the strike orb, the
// rapid-fire morsel, the air bubble and the level blob were all claimed from
// nine or ten units out and then abandoned in mid water a fifth of a second
// later, a few units short. That is the "I struck right at it and nearly got
// it" the player sees, and the last section here is the case for each of them.
//
//   node --import ./tools/vite-loader.mjs tools/chum-latch-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  updatePickups, resetPickups, spawnXpOrb, spawnChumChunk, bitePickup,
  spawnStrikeOrb, spawnBubbleOrb, spawnRapidFireOrb, spawnLevelOrb,
  pickups, chumChunks, strikeOrbs, bubbleOrbs, rapidFireOrbs, levelOrbs,
} from '../path/src/entities/pickups.js';
import { spawnAttractorOrb, updateBoats, resetBoats, attractorOrbs } from '../path/src/systems/boats.js';
import { strikeState } from '../path/src/systems/strike.js';
import { player as livePlayer } from '../path/src/entities/player.js';

const DT = 1 / 60;
const scene = new THREE.Scene();

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// The REAL stat names — `pickupRadius` is what foodReach() reads. A stub that
// invents a field name gets `undefined`, which turns the magnet off and
// quietly measures a game with no magnet in it.
function makePlayer(x, y, reach = 6) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return {
    mesh,
    velocity: new THREE.Vector3(0, 0, 0),
    stats: { pickupRadius: reach, chumGulpRadius: 0, maxOxygen: 100, maxHp: 100 },
    oxygen: 50,
    hp: 100,
    chumSealed: false,
  };
}

// One frame of the pickup world. Returns how much xp was paid out this frame,
// so a caller can ask "was it collected" without reaching into the array.
function step(player) {
  let paid = 0;
  updatePickups(DT, scene, player, (v) => { paid += v; }, null, null, null, null);
  return paid;
}

// Runs frames until the orb is paid out or the clock runs out. Returns the
// seconds it took, or null if it never arrived.
function runUntilCollected(player, seconds = 6) {
  for (let t = 0; t < seconds; t += DT) {
    if (step(player) > 0) return t;
  }
  return null;
}

const orbAt = (x, y) => { spawnXpOrb(scene, new THREE.Vector3(x, y, 0), 10, 0.5); return pickups[pickups.length - 1]; };

console.log('\nA claimed orb arrives');

{
  // THE REACH CLOSES BEHIND IT. Claimed at 12 units of reach (a live chain),
  // then the chain lapses and the reach drops to 6 — with the orb still 9
  // units out, which is to say further away than the seal can now reach.
  resetPickups(scene);
  const player = makePlayer(0, 0, 12);
  const orb = orbAt(10, 0);
  step(player);
  const claimed = !!orb.magnetLatch;
  player.stats.pickupRadius = 6;
  const took = runUntilCollected(player);
  check('the reach closing mid-flight does not drop it', claimed && took !== null,
    took === null ? 'never arrived' : `claimed, then collected ${took.toFixed(2)}s later`);
}

{
  // THE SEAL SWIMS OFF. Same claim, then the mouth leaves at a speed the orb
  // has to chase — the magnet pull is faster than the seal, which is the whole
  // reason it can be a promise at all.
  resetPickups(scene);
  const player = makePlayer(0, 0);
  orbAt(5, 0);
  step(player);
  let took = null;
  for (let t = 0; t < 8; t += DT) {
    player.mesh.position.x -= 8 * DT;
    if (step(player) > 0) { took = t; break; }
  }
  check('swimming away does not shake it off', took !== null,
    took === null ? 'left behind' : `caught up ${took.toFixed(2)}s later`);
}

{
  // AND IT SWIMS OFF AT EVERYTHING IT HAS. The case above leaves at 8 u/s,
  // which is slower than the base pull of 14 and so passes with no floor under
  // the magnet at all. These are the speeds the game actually reaches: a full
  // cruise (CONFIG.player.maxSpeed) and a dash (CONFIG.strike.dashSpeed), both
  // of which are FASTER than the base pull. Without outrunPull() the claimed
  // orb closes at a negative rate and simply trails the seal for the whole run.
  //
  // The velocity is set as well as the position, and that is the whole test:
  // `speed` comes off player.velocity, so a stub that moves the mesh alone
  // reports a stationary seal and measures the idle pull while the mouth is
  // crossing the arena.
  for (const [label, speed] of [['a full cruise', CONFIG.player.maxSpeed], ['a dash', CONFIG.strike.dashSpeed]]) {
    resetPickups(scene);
    const player = makePlayer(0, 0);
    orbAt(5, 0);
    step(player);
    player.velocity.set(-speed, 0, 0);
    let took = null;
    let gained = 0; // furthest the orb ever fell behind, in units
    const start = player.mesh.position.x - pickups[0]?.mesh.position.x;
    for (let t = 0; t < 4; t += DT) {
      player.mesh.position.x -= speed * DT;
      const orb = pickups[0];
      if (orb) gained = Math.max(gained, Math.abs(player.mesh.position.x - orb.mesh.position.x) - Math.abs(start));
      if (step(player) > 0) { took = t; break; }
    }
    check(`${label} cannot outswim it (${speed} u/s)`, took !== null && took < 1,
      took === null ? `left behind — fell ${gained.toFixed(1)} units further back` : `caught up ${took.toFixed(2)}s later`);
  }
}

{
  // SOMETHING ELSE TRIES TO EAT IT. `amount` of 1 is a whole orb in one bite,
  // which is what a crab finishing its meal or a whale swallowing looks like
  // to bitePickup — and the claimed orb has to survive it.
  resetPickups(scene);
  const player = makePlayer(0, 0);
  const orb = orbAt(4, 0);
  step(player);
  const eaten = bitePickup(scene, orb, 1, { x: 40, y: 0, z: 0, rate: 20, dt: DT });
  const stillThere = pickups.includes(orb);
  const took = runUntilCollected(player);
  check('a crab cannot eat it out from under the seal', !eaten && stillThere && took !== null,
    eaten ? 'swallowed by the crab' : `survived the bite, collected ${took?.toFixed(2)}s later`);
}

{
  // THE ALIVE CAP. Fill the water past `maxAlive` with one claimed orb as the
  // OLDEST — the exact one the cap used to shift out.
  resetPickups(scene);
  const player = makePlayer(0, 0);
  const orb = orbAt(4, 0);
  step(player);
  for (let i = 0; i < CONFIG.pickups.maxAlive + 5; i++) orbAt(60 + i, -20);
  const survived = pickups.includes(orb);
  const took = runUntilCollected(player);
  check('the alive cap takes an abandoned orb, not the claimed one',
    survived && pickups.length <= CONFIG.pickups.maxAlive && took !== null,
    survived ? `${pickups.length} alive, arrived in ${took?.toFixed(2)}s` : 'culled in flight');
}

{
  // A CHUNK IS CHUM TOO — same latch, and it must not time out on the way in.
  resetPickups(scene);
  const player = makePlayer(0, 0, 12);
  spawnChumChunk(scene, new THREE.Vector3(10, 0, 0));
  const chunk = chumChunks[0];
  let collected = false;
  updatePickups(DT, scene, player, () => {}, null, null, null, () => { collected = true; });
  const claimed = !!chunk.magnetLatch;
  player.stats.pickupRadius = 6;
  // Its lifespan runs out while it is still in the air. Before the latch this
  // was the rarest pickup in the game blinking out a metre from the mouth.
  chunk.life = 0.05;
  for (let t = 0; t < 6 && !collected; t += DT) {
    updatePickups(DT, scene, player, () => {}, null, null, null, () => { collected = true; });
  }
  check('a claimed chunk neither drops nor expires in flight', claimed && collected,
    claimed ? (collected ? 'arrived' : 'lost in flight') : 'never claimed');
}

console.log('\nAnd an unclaimed orb is still ordinary chum');

{
  // NOTHING IS COLLECTED BY DEFAULT. An orb well outside the reach sinks and
  // settles, as it always did — a latch that latched everything would pass
  // every case above and empty the ocean into the seal.
  resetPickups(scene);
  const player = makePlayer(0, 0);
  const orb = orbAt(40, 0);
  let paid = 0;
  for (let t = 0; t < 3; t += DT) paid += step(player);
  check('out of reach it sinks and is not collected',
    paid === 0 && !orb.magnetLatch && orb.mesh.position.y < -0.5,
    `paid ${paid}, sank ${Math.abs(orb.mesh.position.y).toFixed(1)} units`);
}

{
  // A SEALED MOUTH STILL REFUSES IT. The wind-up gate is the one thing the
  // latch must not walk through: dragging orbs inside a closed mouth was the
  // bug that gate exists for. Held in place, not sunk, and moving again the
  // moment the mouth opens.
  resetPickups(scene);
  const player = makePlayer(0, 0);
  const orb = orbAt(4, 0);
  step(player);
  player.chumSealed = true;
  const held = orb.mesh.position.clone();
  let paid = 0;
  for (let t = 0; t < 1; t += DT) paid += step(player);
  const stayedPut = held.distanceTo(orb.mesh.position) < 0.01;
  player.chumSealed = false;
  const took = runUntilCollected(player);
  check('a wind-up holds it rather than swallowing it or dropping it',
    paid === 0 && stayedPut && took !== null,
    `${paid === 0 ? 'not swallowed' : 'SWALLOWED'}, ${stayedPut ? 'held' : 'drifted'}, ` +
    `resumed in ${took === null ? 'never' : `${took.toFixed(2)}s`}`);
}


// ---------------------------------------------------------------------------
// ...AND EVERY OTHER PICKUP, THROUGH THE ONE CASE THAT ACTUALLY BITES.
//
// The dash corridor (CONFIG.pickups.magnet.striking) is the widest reach in
// the game — 2.2x the base radius, swept ten units back down the dash line —
// and it lasts 0.22 seconds. The moment the dash ends the state falls back to
// whatever the seal is doing now, and a seal that has finished its dash and
// is drifting reaches 4.4 units. An orb claimed out at the corridor's edge is
// then twice that distance from a mouth that can no longer see it.
//
// So each case below claims the pickup with ONE FRAME of corridor and then
// takes the corridor away, which is the same shape as "the reach closes
// mid-flight" at the top of this file. Without the latch every one of them
// stops dead in open water; with it, every one arrives.
// ---------------------------------------------------------------------------
console.log('\nA dash claims it, and the dash ending does not drop it');

// The dash, faked at the level the magnet reads it: magnetState() tests
// `strikeState.active` before it looks at speed, so this is the whole of "the
// seal is striking" as far as the reach is concerned.
function dashFrame(on, dirX = 1, dirY = 0) {
  strikeState.active = on;
  strikeState.dashDir = { x: dirX, y: dirY };
  strikeState.dashDuration = CONFIG.strike.dashDuration;
  strikeState.dashTimeLeft = on ? CONFIG.strike.dashDuration : 0;
  strikeState.power = 1;
}

// Every collect callback, so a case can ask "did THIS one arrive" without
// caring which array it lives in. Counted rather than summed: only chum pays
// an xp value, and the rest would all read as zero.
function stepAll(player, dt = DT) {
  let took = 0;
  const hit = () => { took++; };
  updatePickups(dt, scene, player, hit, hit, hit, hit, hit, { onLevelOrb: hit });
  return took;
}

// Off the dash line by more than a drifting seal can reach and less than the
// corridor can: the striking radius is pickupRadius x 2.2 (9.7 at the shipped
// 4.4) and the idle one is the bare 4.4. Nine units is claimable by the dash
// and unreachable the instant it ends, which is the whole question.
const CORRIDOR_EDGE = 9;

// The dash runs UP the screen and the pickup sits beside it, rather than the
// other way round. Nine units of headroom is not a thing this arena has — the
// waterline is a couple of units above the seal and a bubble put over it is
// snapped back down to the surface before the magnet is ever asked — so the
// offset that can be nine units is the horizontal one, and the corridor is
// pointed to match. Well under the surface for the same reason.
const LANE_Y = -8;

for (const [name, spawn, alive] of [
  ['the strike orb', (p) => spawnStrikeOrb(scene, p), strikeOrbs],
  ['the rapid-fire morsel', (p) => spawnRapidFireOrb(scene, p), rapidFireOrbs],
  ['the level blob', (p) => spawnLevelOrb(scene, p), levelOrbs],
  ['the air bubble', (p) => spawnBubbleOrb(scene, p), bubbleOrbs],
]) {
  resetPickups(scene);
  const player = makePlayer(0, LANE_Y, CONFIG.player.pickupRadius);
  spawn(new THREE.Vector3(CORRIDOR_EDGE, LANE_Y, 0));
  // A bubble spawns SWELLING and the magnet will not touch one still attached
  // to the floor. Grown by hand because the question here is the latch, not
  // the swell gate — a half-grown bubble would answer neither.
  for (const b of bubbleOrbs) b.grow = 1;

  dashFrame(true, 0, 1);
  stepAll(player);
  const claimed = !!alive[0]?.magnetLatch;
  dashFrame(false);

  let took = false;
  for (let t = 0; t < 4; t += DT) {
    for (const b of bubbleOrbs) b.grow = 1;
    if (stepAll(player) > 0) { took = true; break; }
  }
  check(`${name} claimed by the corridor still arrives`, claimed && took,
    !claimed ? 'the corridor never claimed it' : took ? `pulled in from ${CORRIDOR_EDGE} units off the line` : 'stranded when the dash ended');
}

{
  // AND THE CLAM, which had no magnet at all. It was taken by touching it and
  // nothing else — collectRadius plus its body, about 2.2 units, a fifth of
  // what every orb above reaches — so the one pickup whose coach line tells
  // you to go and grab it was the one you had to fly through the middle of at
  // 46 u/s. Striking at it and nearly getting it was the normal outcome.
  //
  // The dash runs UP the screen here, not across: spawnAttractorOrb drops the
  // clam just under the waterline whatever y it is handed (a clam spawned in
  // the air is a clam nothing can reach), so the offset that can be controlled
  // is the horizontal one, and the corridor has to be pointed to match.
  resetPickups(scene);
  resetBoats(scene);
  const boatsWere = CONFIG.boats.enabled;
  CONFIG.boats.enabled = false;
  spawnAttractorOrb(scene, new THREE.Vector3(CORRIDOR_EDGE, LANE_Y, 0));
  const clam = attractorOrbs[0];
  const player = makePlayer(0, clam.mesh.position.y, CONFIG.player.pickupRadius);
  // updateBoats reads the shared `player` singleton for the magnet's state —
  // the speed it is travelling at and the stats that set the reach — and takes
  // the position separately. Both are pointed at this stub for the case and
  // put back afterwards, so nothing here leaks into the harnesses that follow.
  const real = { mesh: livePlayer.mesh, velocity: livePlayer.velocity, stats: livePlayer.stats };
  livePlayer.mesh = player.mesh;
  livePlayer.velocity = player.velocity;
  livePlayer.stats = player.stats;

  dashFrame(true, 0, 1);
  updateBoats(DT, scene, 1, player.mesh.position);
  const claimed = !!clam.magnetLatch;
  dashFrame(false);

  let took = false;
  for (let t = 0; t < 4; t += DT) {
    updateBoats(DT, scene, 1, player.mesh.position);
    if (clam.taken) { took = true; break; }
  }

  livePlayer.mesh = real.mesh;
  livePlayer.velocity = real.velocity;
  livePlayer.stats = real.stats;
  CONFIG.boats.enabled = boatsWere;
  resetBoats(scene);
  check('the attractive clam claimed by the corridor still arrives', claimed && took,
    !claimed ? 'the corridor never claimed it' : took ? `pulled in from ${CORRIDOR_EDGE} units off the line` : 'flown past');
}

{
  // AND A DASH PAST NOTHING IN PARTICULAR STILL LEAVES IT ALONE. The latch is
  // a claim KEPT, not a claim invented: a pickup the corridor never reached
  // has to still be sitting where it was afterwards, or every case above is
  // passing because the magnet now takes everything in the ocean.
  resetPickups(scene);
  const player = makePlayer(0, LANE_Y, CONFIG.player.pickupRadius);
  spawnStrikeOrb(scene, new THREE.Vector3(40, LANE_Y, 0));
  const orb = strikeOrbs[0];
  const where = orb.mesh.position.clone();
  dashFrame(true, 0, 1);
  let took = 0;
  for (let t = 0; t < 1; t += DT) took += stepAll(player);
  dashFrame(false);
  check('a pickup the corridor never reached is not claimed',
    !took && !orb.magnetLatch && where.distanceTo(orb.mesh.position) < 0.01,
    took ? 'collected anyway' : 'left where it was');
}

console.log(failures ? `\n${failures} failure(s).\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
