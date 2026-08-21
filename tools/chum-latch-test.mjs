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
// Every case below fails LOUDLY without the latch and passes with it. The last
// two go the other way: an orb nobody has claimed must still sink and settle
// normally, and a sealed mouth must still refuse to drag food inside itself —
// a latch that quietly turns into "everything is always collected" would pass
// the four above and ruin both.
//
//   node --import ./tools/vite-loader.mjs tools/chum-latch-test.mjs
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  updatePickups, resetPickups, spawnXpOrb, spawnChumChunk, bitePickup,
  pickups, chumChunks,
} from '../path/src/entities/pickups.js';

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

console.log(failures ? `\n${failures} failure(s).\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
