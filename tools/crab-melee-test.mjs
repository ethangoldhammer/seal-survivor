#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:crabmelee
//
// THE KING CRAB'S CLOSE-RANGE CHAIN — systems/bossCrab.js, on the real rig.
//
//   THE HAYMAKER   a rear-up more than twice the ordinary pinch's, then a lunge
//                  down a line locked at the end of it. The wind-up is the
//                  whole contract, so it is measured on the SKELETON — how high
//                  the claw actually gets — rather than trusted to a config
//                  multiplier that something downstream might be ignoring.
//
//   THE DODGE      that lunge sets `ramming`, which is what systems/dodge.js
//                  polls to pay a boost refill for a committed run that missed.
//                  Both halves are checked: a swing dodged pays, and a swing
//                  that took hold of the seal does not — the second one is the
//                  silent failure, because a claw connects at arm's length and
//                  the body-overlap test dodge.js used would answer "missed"
//                  for a pass that caught you.
//
//   THE GRAB       a landed haymaker pins the seal to the CLAW BONE, not to a
//                  point in front of the body. Asserted as a distance to the
//                  posed bone, because a seal parked at the aim point instead
//                  would pass every other check while floating beside a claw
//                  that never closed on it.
//
//   THE THROW      half a second later the arm performs one of two: a slam into
//                  the seabed that bills damage, or a hurl up and out that does
//                  not. Either way the IK target is what moves — `clawAim` —
//                  and the seal leaves along the arm's own swing rather than
//                  along the body's heading, which on an animal that walks
//                  sideways points somewhere the attack never went.
//
//   THE POUNCE     a leap at a seal hugging the seabed, for a late-run crab
//                  only. Ballistic: one impulse and the gravity crawlers
//                  already have, so what is checked is that it LEAVES the
//                  ground, comes back to it, and is refused to a crab that has
//                  not earned it.
//
// Real rig, no renderer. The Browser pane suspends requestAnimationFrame, so
// nothing here could be seen by looking at the game anyway.
//
//   node --import ./tools/vite-loader.mjs tools/crab-melee-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// crabpincer.glb embeds its textures — see the note in tools/crab-claw-test.mjs.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel } from '../path/src/assets.js';
import { updateBounds, bounds } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import { strikeState, resetStrike } from '../path/src/systems/strike.js';
import { updateDodge, resetDodge, dodgeState } from '../path/src/systems/dodge.js';
import { playerGrabbed, grabbedBy, updateBossGrab, resetBossGrab } from '../path/src/systems/bossGrab.js';
import { resolveCombat } from '../path/src/systems/combat.js';
import {
  attachBossCrab, updateBossCrab, releaseBossCrab, resetBossCrab,
  crabMeleeState, haymakerRange, canPounce,
} from '../path/src/systems/bossCrab.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]')
    || msg.startsWith('[feedback]'))) return;
  realWarn(msg, ...rest);
};

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/crabpincer.glb');
if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL}\n`);
  process.exit(1);
}
const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('enemyBossCrab', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const note = (t) => console.log(`        ${t}`);

updateBounds(16 / 9);
initPlayer(scene);

const ARCH = parseBossCsv(bossesCsv, CONFIG.enemies, () => {}).find((b) => b.id === 'bossCrab');
const HC = CONFIG.enemies.bossCrab.haymaker;
const GC = CONFIG.enemies.bossCrab.clawGrab;
const JC = CONFIG.enemies.bossCrab.jump;
const FLOOR = bounds.bottom;

// The archetype's size step, applied the way systems/boss.js applies it — the
// same shortcut tools/crab-claw-test.mjs takes, and for the same reason: these
// sections want a boss in the water without the arrival ceremony.
function king(at, level = 20) {
  const e = spawnNamed(scene, 'bossCrab', 0, at, { ignoreCaps: true, overfill: true });
  const mul = ARCH?.sizeMul ?? 1;
  e.visual.scale.multiplyScalar(mul);
  e.spawnScale *= mul;
  e.sizeMul *= mul;
  e.radius *= mul;
  e.isBoss = true;
  e.entering = false;
  e.invuln = 0;
  e.hp = 1e7;
  // The measured hitbox is dropped for the reason tools/boss-dodge-test.mjs
  // spells out: `hitShape: 'bones'` is fitted to GLB vertices, and a live shape
  // with a zero bound answers "did it touch you" no for every pass ever made.
  e.hitShape = null;
  attachBossCrab(scene, e, 0, level);
  return e;
}

function clean() {
  resetEnemies(scene);
  resetPlayer();
  resetStrike();
  resetDodge();
  resetBossGrab();
  resetBossCrab();
  strikeState.charge = 0;
}

// One frame of the real order: the player, then the grab (which has the last
// word on where the seal is), then the boss's abilities, then the creatures —
// which is main.js's order and the order the one-frame lag on the claw anchor
// is written around.
let hits = [];
const hooks = { onPlayerHit: (dmg, dir, source, channel) => hits.push({ dmg, source, channel }) };
// THE REAL resolveCombat, in its real place in the frame. It is what writes
// `clawLanded` — the flag the grab is gated on and the flag systems/dodge.js
// disqualifies a run with — and standing in for it would make every assertion
// below a test of the stand-in. Its position matters as much as its presence:
// the flag is cleared inside updateEnemies every frame (see the note there), so
// it is live only between that call and the next one, which is exactly the
// window combat writes it in and dodge reads it in.
function frame(e, at) {
  if (at) player.mesh.position.set(at.x, at.y, player.mesh.position.z);
  updateBossGrab(dt, hooks);
  updateBossCrab(dt, scene, player.mesh.position, hooks);
  updateEnemies(dt, scene, player.mesh.position, () => {}, () => {});
  resolveCombat(dt, scene, hooks);
  updateDodge(dt, enemies);
  e.visual.updateMatrixWorld(true);
}

const _v = new THREE.Vector3();
const clawAt = (e) => e.claw?.tip(_v.clone(), 0) ?? null;

// ---------------------------------------------------------------------------
section('THE HAYMAKER');
// ---------------------------------------------------------------------------
{
  clean();
  const e = king({ x: -6, y: FLOOR + 2 });
  // Settle the body so the arms are posed and the walk has started.
  for (let i = 0; i < 30; i++) frame(e, { x: 6, y: FLOOR + 2 });
  const arm = e.claw.reach();
  note(`arm ${arm.toFixed(2)}   haymaker opens at ${haymakerRange(e).toFixed(2)}`);

  check('the crab carries a haymaker at all', !!HC, Object.keys(HC ?? {}).join(', '));
  check('...opening from further out than the pinch lands',
    haymakerRange(e) > arm, `${haymakerRange(e).toFixed(2)} against a ${arm.toFixed(2)}-unit arm`);

  // It arrives on its settle, so the opening of a fight is the ordinary crab.
  check('it does not swing the moment it arrives', crabMeleeState.stage === 'ready',
    `${(HC.settle ?? 0)}s of settle`);

  // The claw's resting height, measured over a second of ordinary walking
  // BEFORE anything is forced — the number the rear-up is compared against.
  let base = -Infinity;
  for (let i = 0; i < 60; i++) {
    frame(e, { x: 60, y: FLOOR + 2 });
    const tip = clawAt(e);
    if (tip) base = Math.max(base, tip.y - e.mesh.position.y);
  }

  // Wind it forward to the first swing, with the seal held BESIDE the crab at
  // its own height. Above it, the locked line points down and the lunge spends
  // itself against the floor clamp — which is correct behaviour and useless for
  // measuring travel.
  const beside = () => ({ x: e.mesh.position.x + 12, y: e.mesh.position.y });
  // The grab is switched off for this section: what is under test is the SWING
  // — the rear-up, the commit, the run and the hand-back — and a lunge that
  // ends with the seal in the claw never reaches the hand-back. The grab has
  // its own section below.
  const grabWas1 = GC.enabled;
  GC.enabled = false;
  crabMeleeState.swingCd = 0;
  let rearAt = -1;
  let peak = -Infinity;
  for (let i = 0; i < 60 * 6; i++) {
    frame(e, beside());
    if (crabMeleeState.stage === 'rear' && rearAt < 0) rearAt = i;
    const tip = clawAt(e);
    if (tip) {
      if (crabMeleeState.stage === 'rear') peak = Math.max(peak, tip.y - e.mesh.position.y);
    }
    if (crabMeleeState.stage === 'lunge') break;
  }
  check('the crab rears up', rearAt >= 0, `stage went to rear on frame ${rearAt}`);
  check('...with the claw driver running the big profile', crabMeleeState.swings === 1,
    `${crabMeleeState.swings} swing`);
  check('...and the claw genuinely goes higher than it walks',
    peak > base + 0.5,
    `claw peaked ${peak.toFixed(2)} above the body, against ${base.toFixed(2)} at rest`);

  // ...and then commits.
  check('it commits to a lunge', crabMeleeState.stage === 'lunge', crabMeleeState.stage);
  check('...taking the body off its own steering', e.perkDrive === true);
  check('...and flagged as committed, which is what pays a dodge', e.ramming === true);
  const dir = { x: crabMeleeState.dirX, y: crabMeleeState.dirY };
  const before = e.mesh.position.clone();
  for (let i = 0; i < 60; i++) {
    frame(e, null); // the seal stands still: the line was locked, not steered
    if (crabMeleeState.stage !== 'lunge') break;
  }
  const moved = e.mesh.position.clone().sub(before);
  check('...and it actually travels down that line',
    moved.length() > 1 && moved.x * dir.x + moved.y * dir.y > 0,
    `${moved.length().toFixed(2)} units along (${dir.x.toFixed(2)}, ${dir.y.toFixed(2)})`);
  check('the body is handed back when the run ends',
    crabMeleeState.stage === 'ready' && e.perkDrive === false && e.ramming === false);
  check('...on a long cooldown, so this is punctuation and not a rhythm',
    crabMeleeState.swingCd > 3, `${crabMeleeState.swingCd.toFixed(1)}s`);
  GC.enabled = grabWas1;
}

// ---------------------------------------------------------------------------
section('DODGING IT REFILLS THE BOOST');
// ---------------------------------------------------------------------------
{
  clean();
  const e = king({ x: -6, y: FLOOR + 2 });
  for (let i = 0; i < 30; i++) frame(e, { x: 60, y: FLOOR + 2 });
  strikeState.charge = 0;
  crabMeleeState.swingCd = 0;

  // A swing at a seal that is right there, and then is not.
  let paid = 0;
  for (let i = 0; i < 60 * 8; i++) {
    // Close enough to be swung at while it rears, and GONE the moment it
    // commits — which is what dodging a telegraphed attack IS. The claw shuts
    // on water, combat writes nothing, and the run ends having missed.
    frame(e, crabMeleeState.stage === 'lunge'
      ? { x: e.mesh.position.x + 40, y: FLOOR + 2 }
      : { x: e.mesh.position.x + 12, y: FLOOR + 2 });
    if (dodgeState.dodges > paid) { paid = dodgeState.dodges; break; }
    if (crabMeleeState.swings > 0 && crabMeleeState.stage === 'ready'
      && crabMeleeState.swingCd < (HC.cooldown ?? 7) - 1) break;
  }
  check('a haymaker that missed pays a dodge', dodgeState.dodges >= 1,
    `${dodgeState.dodges} dodges, refill ${dodgeState.lastRefill}`);
  check('...into the boost meter', strikeState.charge > 0,
    `charge ${strikeState.charge.toFixed(2)}`);
}
{
  clean();
  const e = king({ x: -6, y: FLOOR + 2 });
  for (let i = 0; i < 30; i++) frame(e, { x: 60, y: FLOOR + 2 });
  strikeState.charge = 0;
  crabMeleeState.swingCd = 0;
  // The same swing, except the claw lands — which is combat.js writing
  // `clawLanded`, stood in for here because resolveCombat is not what is under
  // test. The grab is switched off so this measures the DODGE and nothing else.
  const grabWas = GC.enabled;
  GC.enabled = false;
  for (let i = 0; i < 60 * 8; i++) {
    // The seal stands its ground this time, so the claw reaches it and
    // combat.js writes `clawLanded`. The grab is off so this measures the DODGE
    // and nothing else.
    frame(e, { x: e.mesh.position.x + 9, y: FLOOR + 2 });
    if (crabMeleeState.swings > 0 && crabMeleeState.stage === 'ready'
      && crabMeleeState.swingCd < (HC.cooldown ?? 7) - 1) break;
  }
  GC.enabled = grabWas;
  check('a haymaker that CONNECTED pays nothing', dodgeState.dodges === 0,
    `${dodgeState.dodges} dodges — a claw reaches, so body overlap is the wrong question`);
}

// ---------------------------------------------------------------------------
section('THE CLAW TAKES HOLD');
// ---------------------------------------------------------------------------
function caught(level = 20, invulnerable = false) {
  clean();
  hits = [];
  const e = king({ x: -6, y: FLOOR + 2 }, level);
  for (let i = 0; i < 30; i++) frame(e, { x: 60, y: FLOOR + 2 });
  crabMeleeState.swingCd = 0;
  for (let i = 0; i < 60 * 8 && !playerGrabbed(); i++) {
    // Held i-framed for the whole approach when asked — which is what a player
    // standing next to a crab that jabs three times a second actually is.
    if (invulnerable) player.invuln = 1;
    frame(e, i < 1 ? { x: e.mesh.position.x + 9, y: FLOOR + 2 } : null);
  }
  return e;
}
{
  const e = caught();
  check('a landed haymaker takes hold of the seal', playerGrabbed(), crabMeleeState.stage);
  check('...and it is this crab holding it', grabbedBy() === e);
  check('...with the claw shut and staying shut', e.claw.isHolding() === true);

  // Pinned to the BONE. Reeled rather than snapped, so it is measured after a
  // few frames of carry.
  for (let i = 0; i < 12; i++) frame(e, null);
  const tip = clawAt(e);
  const gap = Math.hypot(player.mesh.position.x - tip.x, player.mesh.position.y - tip.y);
  check('...pinned to the claw itself, not to a point in front of the body',
    gap < e.radius * 0.6, `${gap.toFixed(2)} from the posed claw bone, on a ${e.radius.toFixed(2)} radius`);

  // ...and the crab is not also billing contact or pinch damage while it holds.
  const before = hits.length;
  for (let i = 0; i < 12; i++) frame(e, null);
  check('...and nothing is chewing on the seal while it is held',
    hits.length === before, `${hits.length - before} hits during the hold`);

  // ...AND IT IS HELD IN DEPTH, not just in the plane. The crab is broadside to
  // an orthographic camera and fifteen units deep; its arm solves to about two
  // units in front of the play plane, so a seal left at z 0 is held BEHIND the
  // claw and inside the animal, with the crab's near half drawn over it. The
  // grab happens and the player cannot see it.
  check('...and carried at the claw\'s own depth, in front of the body',
    Math.abs(player.mesh.position.z - tip.z) < 1
    && Math.abs(player.mesh.position.z) > 0.5,
    `seal z ${player.mesh.position.z.toFixed(2)}, claw z ${tip.z.toFixed(2)}`);
}

// A HAYMAKER THAT LANDS ON AN I-FRAMED SEAL STILL TAKES HOLD.
//
// The one that broke this in play: the king crab jabs twenty times in twenty
// seconds, so at close range the player is nearly always inside a window left
// by the last one — and while `clawLanded` was written inside combat.js's
// i-frame check, the grab was gated on a flag that was almost never set. The
// fight looked exactly like a grab that did not work.
{
  const e = caught(20, true);
  check('the claw takes hold even when the seal is mid i-frame',
    playerGrabbed(), `invuln was ${player.invuln.toFixed(2)} at the catch`);
}

// ---------------------------------------------------------------------------
section('AND THEN THROWS IT');
// ---------------------------------------------------------------------------
// Both outcomes, forced — the roll itself is one line and what matters is that
// each end of it does what it says.
function throwOut(slam) {
  const was = GC.slamChance;
  GC.slamChance = slam ? 1 : 0;
  const e = caught();
  const aimSeen = [];
  let releasedAt = -1;
  for (let i = 0; i < 60 * 3; i++) {
    frame(e, null);
    if (e.clawAim) aimSeen.push({ x: e.clawAim.x, y: e.clawAim.y });
    if (!playerGrabbed() && releasedAt < 0) releasedAt = i;
    if (releasedAt >= 0 && i > releasedAt + 4) break;
  }
  GC.slamChance = was;
  return { e, aimSeen, releasedAt };
}
{
  hits = [];
  const { e, aimSeen, releasedAt } = throwOut(true);
  check('a slam runs the arm through a throw', aimSeen.length > 2,
    `${aimSeen.length} frames of driven claw target`);
  check('...driving it DOWN toward the seabed',
    aimSeen.length > 1 && aimSeen[aimSeen.length - 1].y < aimSeen[0].y,
    `${aimSeen[0]?.y.toFixed(2)} -> ${aimSeen[aimSeen.length - 1]?.y.toFixed(2)}`);
  check('...and letting go at the end of it', releasedAt >= 0 && !playerGrabbed());
  const slam = hits.filter((h) => h.source?.endsWith(':slam'));
  check('...billing the impact through the shared hook', slam.length === 1,
    slam.map((h) => `${h.dmg.toFixed(1)} on the ${h.channel} channel`).join(', ') || 'none');
  check('...on the i-framed channel, like every other timed blow',
    slam[0]?.channel === 'strike', slam[0]?.channel ?? 'none');
  check('the seal is shoved by the throw', Math.hypot(player.knockX, player.knockY) > 1,
    `knock ${Math.hypot(player.knockX, player.knockY).toFixed(1)}`);
  check('...and the crab is back to being a crab',
    crabMeleeState.stage === 'ready' && e.perkDrive === false && e.clawAim === null
    && e.claw.isHolding() === false);
  // AND THE SEAL IS BACK ON THE PLAY PLANE. The one thing in the game that ever
  // takes it off z 0 has to put it back on every exit, or the rest of the run
  // is played by an animal sorting in front of its own water.
  check('...with the seal back on the play plane',
    Math.abs(player.mesh.position.z) < 1e-6, `z ${player.mesh.position.z}`);
}
{
  hits = [];
  const { aimSeen } = throwOut(false);
  check('a hurl runs the arm the other way — up and out',
    aimSeen.length > 1 && aimSeen[aimSeen.length - 1].y > aimSeen[0].y,
    `${aimSeen[0]?.y.toFixed(2)} -> ${aimSeen[aimSeen.length - 1]?.y.toFixed(2)}`);
  check('...and costs the player no health at all',
    hits.filter((h) => h.source?.endsWith(':slam')).length === 0,
    'being thrown is the punishment');
  check('...but still throws them somewhere', Math.hypot(player.knockX, player.knockY) > 1,
    `knock ${Math.hypot(player.knockX, player.knockY).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
section('THE POUNCE');
// ---------------------------------------------------------------------------
{
  clean();
  const early = king({ x: -20, y: FLOOR + 1 }, 1);
  check('a crab from the start of a run cannot leave the ground',
    canPounce(early, 1) === false, `minLevel ${JC.minLevel}`);
  check('...and one from a late run can', canPounce(early, JC.minLevel ?? 10) === true);

  clean();
  const e = king({ x: -20, y: FLOOR + 1 }, JC.minLevel ?? 10);
  // Out of the haymaker's reach, inside the jump's band, seal on the sand.
  const seal = { x: -20 + (JC.minRange ?? 12) + 6, y: FLOOR + 2 };
  for (let i = 0; i < 40; i++) frame(e, seal);
  crabMeleeState.jumpCd = 0;
  crabMeleeState.swingCd = 999; // the swing outranks the jump; this is the jump's test
  let peak = -Infinity;
  let jumped = false;
  for (let i = 0; i < 60 * 6; i++) {
    frame(e, seal);
    if (crabMeleeState.stage === 'air') jumped = true;
    peak = Math.max(peak, e.mesh.position.y - FLOOR);
    if (jumped && crabMeleeState.stage === 'ready') break;
  }
  check('it leaps at a seal on the seabed', jumped, `${crabMeleeState.jumps} jumps`);
  check('...genuinely leaving the ground', peak > e.radius * 1.6,
    `peaked ${peak.toFixed(2)} above the floor, on a ${e.radius.toFixed(2)} radius`);
  check('...under the ceiling its own crawl block gives it',
    peak <= (CONFIG.enemies.bossCrab.crawl?.groundHeight ?? 14) + 0.5,
    `against groundHeight ${CONFIG.enemies.bossCrab.crawl?.groundHeight}`);
  check('...and it comes down again', crabMeleeState.stage === 'ready'
    && e.perkDrive === false && e.ramming === false,
    `landed at ${(e.mesh.position.y - FLOOR).toFixed(2)} above the floor`);
  check('...then waits before doing it again', crabMeleeState.jumpCd > 3,
    `${crabMeleeState.jumpCd.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
section('NOTHING OUTLIVES THE FIGHT');
// ---------------------------------------------------------------------------
{
  const e = caught();
  check('the seal is in the claw to begin with', playerGrabbed());
  releaseBossCrab();
  check('releasing the boss lets the seal go', !playerGrabbed());
  check('...and hands the body back everything this file wrote',
    e.perkDrive === false && e.ramming === false && e.clawAim === null
    && e.claw.isHolding() === false,
    'perkDrive, ramming, clawAim, the claw hold');
  check('...and forgets the crab', crabMeleeState.crab === null);
}

{
  // ...AND A CRAB THAT DIES WITH THE SEAL IN ITS CLAW. The one path where
  // nothing calls the release: no throw finishes, no cooldown ends, the body
  // just stops. Without the hp guard the state machine keeps driving a corpse
  // and the player is welded to a claw for the rest of the run.
  const e = caught();
  check('the seal is in the claw to begin with', playerGrabbed());
  e.hp = 0;
  frame(e, null);
  check('a crab that dies mid-grab drops the seal', !playerGrabbed());
  check('...and stops driving the body', e.perkDrive === false && e.clawAim === null);
  check('...and is forgotten', crabMeleeState.crab === null);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
