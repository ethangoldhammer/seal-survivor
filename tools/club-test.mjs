#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:club
//
// THE FIN CLUB, which is almost entirely claims about motion over time and so
// is exactly the kind of thing a screenshot cannot answer — and the browser
// preview cannot even run it, since that pane suspends requestAnimationFrame
// and the game loop is frozen there.
//
// Five things worth failing over:
//
//   SWING    that the clubs hang off the fin tips the aim rig publishes, one
//            per fin, and that how fast they turn is a function of how fast
//            the seal is MOVING. That last part is the whole design of the
//            weapon — a club that turned at a constant rate would be a shrimp
//            ring with a different mesh, and nothing would throw if it did.
//
//   WHACK    that a body in the swept path is hit and one outside it is not.
//            The swept test exists because a fast swing steps several units
//            between frames; a naive "is the head touching it right now" test
//            passes this file's slow cases and misses everything at speed.
//
//   THROW    that a whacked body actually MOVES, away from the seal, and that
//            size resists it. Written into the position directly rather than
//            through knockX/knockY, so the failure mode if this regresses is a
//            body that is hit and simply stays put.
//
//   CAROM    that a thrown body damages what it meets on the way, that it can
//            reach several bodies from one whack, and that the bounce budget
//            is a real ceiling rather than a suggestion. This is where the
//            weapon's damage actually lives.
//
//   SETTLE   that every flight ends — hands its leftover speed to the shared
//            shove channel and lets go of the creature. A flight that never
//            ended would hold a strong reference to a dead body and keep
//            writing its position for the rest of the run.
//
// What it cannot tell you: whether the swing reads as a whip, or whether a
// break shot into a school is satisfying. Those are a controller in your hands.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, spawnNamed, resetEnemies } from '../path/src/entities/enemies.js';
import {
  updateClub, resetClub, createClubVisual,
  clubDamage, clubLength, clubBounces, clubSwingSpeed, clubBlast, clubIce,
} from '../path/src/systems/club.js';

const scene = new THREE.Scene();
const dt = 1 / 60;

// The animation controller warns once per state per creature for clips a
// procedural stand-in does not have, which in Node is all of them.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]'))) return;
  realWarn(msg, ...rest);
};

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

const playerPos = new THREE.Vector3(0, -20, 0);

// A stand-in aim rig. The real one (systems/aimRig.js) publishes exactly this:
// a world-space tip point per flipper plus the chain that produced it,
// re-solved every frame after the mixer. The club takes it as an argument
// rather than importing the player, which is the only reason this file runs.
//
// `spin` turns the whole rig — flipper tips orbiting the body and each fin
// pointing outward as it goes. That is the animation the weapon is meant to be
// driven by, and being able to declare it here is the point of this stand-in:
// the fin controller does not exist yet in the form the clubs will finally
// ride on, and none of the claims below should have to wait for it.
function rigWithFins(n = 2) {
  const rig = {
    muzzles: [],
    fins: [],
    // Where each fin tip sits, at rig angle `a`.
    pose(a) {
      for (let i = 0; i < n; i++) {
        const at = a + (i / n) * Math.PI * 2;
        const shoulder = rig.fins[i].tip;
        // The last bone sits inboard of the tip, so tip - bone is the
        // flipper's pointing direction — exactly what finAngle() reads.
        shoulder.position.set(playerPos.x + Math.cos(at) * 0.5, playerPos.y + Math.sin(at) * 0.5, 0);
        shoulder.updateMatrixWorld(true);
        rig.muzzles[i].set(playerPos.x + Math.cos(at) * 1.1, playerPos.y + Math.sin(at) * 1.1, 0);
      }
    },
  };
  for (let i = 0; i < n; i++) {
    const bone = new THREE.Object3D();
    scene.add(bone);
    rig.muzzles.push(new THREE.Vector3());
    rig.fins.push({ tip: bone, point: rig.muzzles[i] });
  }
  rig.pose(0);
  return rig;
}

// The two ends of a drawn club, in world space.
//
// createVisual orients an asset so its forward runs down local +Y, so the
// shaft lies along the mesh's own Y and the club's world direction is its
// rotation.z turned back a quarter. Taking the LOCAL box (position and spin
// removed) and pushing it out along that direction gives the real butt and
// head wherever the mesh's origin happens to sit — which is the whole point,
// since that origin differs between the model and the fallback.
function shaftEnds(mesh) {
  const pos = mesh.position.clone();
  const rot = mesh.rotation.z;
  mesh.position.set(0, 0, 0);
  mesh.rotation.z = 0;
  mesh.updateMatrixWorld(true);
  const local = new THREE.Box3().setFromObject(mesh);
  mesh.position.copy(pos);
  mesh.rotation.z = rot;
  mesh.updateMatrixWorld(true);

  const a = rot + Math.PI / 2;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  return [
    { x: pos.x + dx * local.min.y, y: pos.y + dy * local.min.y },
    { x: pos.x + dx * local.max.y, y: pos.y + dy * local.max.y },
  ];
}

function spawnAt(type, x, y) {
  const e = spawnNamed(scene, type, 0, { x, y }, { ignoreCaps: true });
  if (!e) throw new Error(`could not spawn ${type}`);
  // Spawned creatures may still be "entering" from off the wings, which skips
  // the horizontal clamp and some of the steering.
  e.entering = false;
  return e;
}

// The group createClubVisual() returns is what main.js parents into the scene;
// holding it here is what lets this file look at the clubs themselves.
let clubGroup = null;
function freshRun() {
  resetEnemies(scene);
  resetClub();
  clubGroup = createClubVisual();
  scene.add(clubGroup);
}

// Run the weapon for a while, with the fins turning at `finSpin` rad/s. The
// club is the only thing stepping here — the creatures are deliberately NOT
// updated, so anything that moves was moved by the club and nothing else.
function swing(seconds, {
  level = 1, boom = 0, ice = 0, throwLevel = 0, velocity = null, speed = 0, dashing = false,
  rig = rigWithFins(), finSpin = 6, hooks = {},
} = {}) {
  const frames = Math.round(seconds / dt);
  // A caller that only names a speed gets it as plain forward travel, which is
  // what every claim below that is not ABOUT the heading actually wants.
  const vel = velocity ?? (speed ? { x: speed, y: 0 } : null);
  for (let i = 0; i < frames; i++) {
    rig.pose?.(i * dt * finSpin);
    updateClub(dt, scene, playerPos, { club: level, boom, ice, throw: throwLevel }, enemies,
      { rig, velocity: vel, dashing }, hooks);
  }
}

// ------------------------------------------------------------------- swinging

section('FLOP — the seal\'s own travel is what moves the clubs');

{
  // THE CENTRAL CLAIM: a club dragged through water streams out BEHIND the
  // direction of travel. Swim right, the clubs trail left.
  const restAngle = (velocity) => {
    freshRun();
    const rig = rigWithFins(2);
    // No fin spin and no assist, so the only thing left moving the club is the
    // drag — otherwise this measures the crutch instead of the mechanic.
    const savedAssist = CONFIG.club.assistSpin;
    CONFIG.club.assistSpin = 0;
    swing(3, { level: 1, rig, finSpin: 0, velocity });
    CONFIG.club.assistSpin = savedAssist;
    return clubGroup.children[0].rotation.z + Math.PI / 2;
  };

  // Asserted as "leans BEHIND rather than ahead" instead of "points exactly
  // behind", because a club socketed in a fin is held by it: CONFIG.club
  // .velocityFollow is deliberately below 1, so the rest pose is a blend of
  // the drag and the flipper's own direction. Pinning the exact angle here
  // would be a test of that one tuning value rather than of the mechanic, and
  // it would fail the moment the number is dialled.
  const gap = (a, b) => Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);

  const right = restAngle({ x: 14, y: 0 });
  check('a club swimming right leans behind the seal, not ahead of it',
    gap(right, Math.PI) < gap(right, 0),
    `${(gap(right, Math.PI) * 57.3).toFixed(0)}deg off behind vs ${(gap(right, 0) * 57.3).toFixed(0)}deg off ahead`);

  const up = restAngle({ x: 0, y: 14 });
  check('...and one swimming up leans below it',
    gap(up, -Math.PI / 2) < gap(up, Math.PI / 2),
    `${(gap(up, -Math.PI / 2) * 57.3).toFixed(0)}deg off down vs ${(gap(up, Math.PI / 2) * 57.3).toFixed(0)}deg off up`);

  // ...and the two disagree, which is the actual claim: the heading of travel
  // moved the club. A weapon that ignored velocity would rest identically.
  check('...and travelling a different way rests them somewhere different',
    gap(right, up) > 0.3, `${(gap(right, up) * 57.3).toFixed(0)}deg apart`);

  // TURNING IS WHAT SWINGS IT. Holding a line lets the clubs settle; reversing
  // drags them across the body, and that crossing is where the hits come from.
  freshRun();
  const rig = rigWithFins(2);
  const savedAssist = CONFIG.club.assistSpin;
  CONFIG.club.assistSpin = 0;
  swing(2, { level: 1, rig, finSpin: 0, velocity: { x: 14, y: 0 } });
  const settled = clubSwingSpeed();
  swing(0.35, { level: 1, rig, finSpin: 0, velocity: { x: -14, y: 0 } });
  const turned = clubSwingSpeed();
  CONFIG.club.assistSpin = savedAssist;
  check('holding a straight line settles them', settled < 1,
    `${settled.toFixed(2)} rad/s after 2s of cruising`);
  check('...and reversing drags them across the body', turned > settled * 3,
    `${settled.toFixed(2)} -> ${turned.toFixed(2)} rad/s on the turn`);
}

section('SWING — the fins are what turn the clubs');

{
  // THE CENTRAL CLAIM OF THE WEAPON: spin the flippers faster and the clubs
  // swing faster, with nothing in this system having been told to.
  freshRun();
  swing(1.5, { level: 1, finSpin: 2 });
  const slowFins = clubSwingSpeed();
  freshRun();
  swing(1.5, { level: 1, finSpin: 12 });
  const fastFins = clubSwingSpeed();

  check('the fins drive the swing', fastFins > slowFins * 1.5,
    `fins at 2 rad/s -> ${slowFins.toFixed(2)}, at 12 rad/s -> ${fastFins.toFixed(2)}`);

  // ...and stopping the fins stops the weapon. The other half of "the
  // animation is the weapon": a club with its own clock would keep going.
  freshRun();
  swing(1.5, { level: 1, finSpin: 12 });
  const moving = clubSwingSpeed();
  // Assist spin is the deliberate crutch for a rig whose fins don't move yet,
  // so it has to be off to ask this question honestly.
  const savedAssist = CONFIG.club.assistSpin;
  CONFIG.club.assistSpin = 0;
  swing(2.5, { level: 1, finSpin: 0 });
  const stopped = clubSwingSpeed();
  CONFIG.club.assistSpin = savedAssist;
  check('...and still fins settle the clubs', stopped < moving * 0.3,
    `${moving.toFixed(2)} -> ${stopped.toFixed(2)} rad/s`);
}

{
  // THE FLAIL. A club welded to the fin direction would sit at a constant
  // offset; one on a spring trails further the faster the fin is going. That
  // difference is the whole visual difference between a prop and a weapon.
  freshRun();
  const rig = rigWithFins(2);
  const lagAt = (finSpin) => {
    freshRun();
    swing(2, { level: 1, rig, finSpin });
    // Fin direction vs club direction, at the same instant.
    const tip = rig.muzzles[0];
    const bone = rig.fins[0].tip.position;
    const finDir = Math.atan2(tip.y - bone.y, tip.x - bone.x);
    const mesh = clubGroup.children[0];
    const clubDir = mesh.rotation.z + Math.PI / 2;
    let d = (clubDir - finDir + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return Math.abs(d);
  };
  const slowLag = lagAt(2);
  const fastLag = lagAt(14);
  check('the club trails the fin, and trails it further when swung harder',
    fastLag > slowLag,
    `${(slowLag * 57.3).toFixed(1)}deg behind at 2 rad/s, ${(fastLag * 57.3).toFixed(1)}deg at 14`);
}

{
  freshRun();
  const rig = rigWithFins(2);
  swing(0.5, { level: 1, rig });
  const group = clubGroup;
  check('one club per fin tip', group?.children.length === 2, `${group?.children.length ?? 0} built`);

  // ATTACHED AT THE GRIP — measured end to end, on the drawn mesh, because
  // this is the claim two different art conventions can silently break: a
  // loaded model is pivoted at its handle while the procedural fallback is
  // centred on its origin, and the fallback is the ONLY one a Node harness
  // ever sees. Asserting on `mesh.position` would test the convention rather
  // than the result, and would pass for a club held by its waist.
  if (group) {
    let worstBase = 0;
    let worstHead = 0;
    group.children.forEach((m, i) => {
      const [base, head] = shaftEnds(m);
      const tip = rig.muzzles[i];
      worstBase = Math.max(worstBase, Math.hypot(base.x - tip.x, base.y - tip.y));
      worstHead = Math.max(worstHead, Math.abs(Math.hypot(head.x - tip.x, head.y - tip.y) - clubLength(1)));
    });
    check('...and each is gripped AT its fin tip', worstBase < 0.3,
      `worst butt-end sits ${worstBase.toFixed(3)}u off the tip`);
    check('...with the head out at the far end of the reach', worstHead < 0.3,
      `worst head is ${worstHead.toFixed(3)}u off ${clubLength(1).toFixed(2)}u`);
    const apart = group.children.length === 2
      && group.children[0].position.distanceTo(group.children[1].position) > 0.5;
    check('...and the pair is spread around the body, not stacked', apart);
  }
}

{
  // Level 0 is the card never taken. Nothing should exist and nothing should
  // be hit — the usual way a new weapon leaks into every run by accident.
  freshRun();
  const bystander = spawnAt('fish', 0.3, -20);
  const hp = bystander.hp;
  swing(1, { level: 0, speed: 10 });
  check('no card, no weapon', bystander.hp === hp, `${bystander.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
}

// -------------------------------------------------------------------- whacking

section('WHACK — what the swept head touches');

{
  freshRun();
  // Inside the arc, and far enough out that only the club can reach it.
  const near = spawnAt('fish', 1.4, -20);
  const hp = near.hp;
  let whacks = 0;
  swing(2, { level: 1, speed: 8, hooks: { onWhack: () => { whacks++; } } });
  check('a body inside the arc is hit', near.hp < hp || whacks > 0,
    `${whacks} whack(s), ${near.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
}

{
  freshRun();
  // Well outside the longest reach the weapon has at this level.
  const far = spawnAt('fish', clubLength(1) + 8, -20);
  const hp = far.hp;
  let whacks = 0;
  swing(2, { level: 1, speed: 8, hooks: { onWhack: () => { whacks++; } } });
  check('a body outside the reach is not', far.hp === hp && whacks === 0,
    `${whacks} whack(s)`);
}

{
  // The swept test earning its keep: at a dash rate the head crosses several
  // units per frame, so a body sitting on the arc is only ever BETWEEN two
  // sampled positions. A contact test without the sweep misses this.
  freshRun();
  const onTheArc = spawnAt('fish', clubLength(1) * 0.92, -20);
  const hp = onTheArc.hp;
  swing(1, { level: 1, speed: CONFIG.player.maxSpeed, dashing: true });
  check('a fast swing does not step over a small body', onTheArc.hp < hp,
    `${onTheArc.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
}

// --------------------------------------------------------------------- throwing

section('THROW — a hit is a launch, not a tick');

{
  freshRun();
  const fish = spawnAt('fish', 1.4, -20);
  const from = Math.hypot(fish.mesh.position.x - playerPos.x, fish.mesh.position.y - playerPos.y);
  swing(1.2, { level: 1, speed: 8 });

  if (enemies.includes(fish)) {
    const to = Math.hypot(fish.mesh.position.x - playerPos.x, fish.mesh.position.y - playerPos.y);
    check('a whacked body is thrown clear of the seal', to > from + 1,
      `${from.toFixed(1)} -> ${to.toFixed(1)} units out`);
  } else {
    // Died to the whack instead, which is a legitimate outcome for a minnow —
    // re-run the same claim on something that survives it.
    const shark = spawnAt('shark', 1.4, -20);
    const sFrom = Math.hypot(shark.mesh.position.x - playerPos.x, shark.mesh.position.y - playerPos.y);
    swing(1.2, { level: 1, speed: 8 });
    const sTo = Math.hypot(shark.mesh.position.x - playerPos.x, shark.mesh.position.y - playerPos.y);
    check('a whacked body is thrown clear of the seal', sTo > sFrom + 1,
      `${sFrom.toFixed(1)} -> ${sTo.toFixed(1)} units out (shark)`);
  }
}

{
  // Size resists the throw, the same rule the strike's shove follows. Measured
  // as distance travelled from an identical start, because a body's own
  // steering is off in this harness and the club is the only mover.
  freshRun();
  const shark = spawnAt('shark', 1.4, -20);
  const sharkStart = shark.mesh.position.clone();
  swing(1.2, { level: 1, speed: 8 });
  const sharkMoved = shark.mesh.position.distanceTo(sharkStart);

  freshRun();
  const meg = spawnAt('megalodon', 1.4, -20);
  const megStart = meg.mesh.position.clone();
  swing(1.2, { level: 1, speed: 8 });
  const megMoved = meg.mesh.position.distanceTo(megStart);

  check('a big body is thrown less far than a small one', megMoved < sharkMoved,
    `megalodon ${megMoved.toFixed(1)}u vs shark ${sharkMoved.toFixed(1)}u`);
  check('...but it is still moved at all', megMoved > 0.05, `${megMoved.toFixed(2)}u`);
}

// ---------------------------------------------------------------------- caroms

section('CAROM — the thrown body is the weapon');

{
  // A wall of fish in the throw's path. What the flight lands on should take
  // damage from the collision, and that damage is reported as the club's.
  freshRun();
  const target = spawnAt('shark', 1.5, -20);
  const crowd = [];
  for (let i = 0; i < 12; i++) crowd.push(spawnAt('fish', 3 + i * 0.9, -20 + (i % 3) * 0.5));
  const crowdHp = new Map(crowd.map((e) => [e, e.hp]));

  let ricochets = 0;
  swing(2.5, {
    level: 3,
    speed: CONFIG.player.maxSpeed,
    hooks: { onRicochet: () => { ricochets++; } },
  });

  const hurt = crowd.filter((e) => !enemies.includes(e) || e.hp < crowdHp.get(e)).length;
  check('a thrown body damages what it meets', hurt > 0,
    `${hurt} of ${crowd.length} bodies hurt, ${ricochets} carom(s)`);
  check('...and one throw can reach more than one of them', hurt > 1 || ricochets > 1,
    `${hurt} hurt, ${ricochets} carom(s)`);
  // The budget is the balance lever. A flight that ignored it would clear the
  // screen from one whack.
  const ceiling = (clubBounces(3) + 1) * 6; // generous: several throws over 2.5s
  check('...but the bounce budget is a real ceiling', ricochets <= ceiling,
    `${ricochets} carom(s), budget ${clubBounces(3)} per throw`);
  // The crowd is what got hurt, not just the body that was thrown into it.
  check('the damage lands on the crowd, not only on the thrown body',
    hurt > 0 && crowd.some((e) => !enemies.includes(e) || e.hp < crowdHp.get(e)),
    `${hurt} crowd bodies hurt (target was ${enemies.includes(target) ? 'still alive' : 'killed'})`);
}

{
  // The flyer pays too, or the arena ends up with one indestructible pinball.
  freshRun();
  const flyer = spawnAt('shark', 1.5, -20);
  for (let i = 0; i < 8; i++) spawnAt('fish', 3 + i * 0.8, -20);
  const hp = flyer.hp;
  swing(2.5, { level: 3, speed: CONFIG.player.maxSpeed });
  const died = !enemies.includes(flyer);
  check('the thrown body takes damage from its own caroms', died || flyer.hp < hp,
    died ? 'died in flight' : `${flyer.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
}

// ---------------------------------------------------------------------- settling

section('SETTLE — every flight ends');

{
  freshRun();
  const shark = spawnAt('shark', 1.5, -20);
  // One whack, then stop swinging entirely: level stays up but the seal is
  // still, so nothing new is launched and the flight has to end on its own.
  swing(0.6, { level: 1, speed: CONFIG.player.maxSpeed });
  const rig = { muzzles: [] }; // no fins => no clubs => no new hits at all
  let moved = 0;
  for (let i = 0; i < 300; i++) {
    const before = shark.mesh.position.clone();
    updateClub(dt, scene, playerPos, 1, enemies, { rig, speed: 0, dashing: false }, {});
    moved = shark.mesh.position.distanceTo(before);
  }
  check('a flight stops writing the body\'s position', moved === 0,
    `${moved.toFixed(4)}u on the last frame`);
  // Asserted as a real number rather than "or it never moved": a flight that
  // was frozen instead of finished also stops writing the position, and that
  // is exactly the bug this pair is here to catch (no fins used to return
  // before the flights were stepped at all).
  check('...and hands what is left to the shared shove channel',
    Math.hypot(shark.knockX ?? 0, shark.knockY ?? 0) > 0,
    `knock ${(shark.knockX ?? 0).toFixed(2)}, ${(shark.knockY ?? 0).toFixed(2)}`);
}

{
  // A body killed mid-flight must not leave the flight behind holding it.
  freshRun();
  const fish = spawnAt('fish', 1.4, -20);
  swing(0.5, { level: 1, speed: CONFIG.player.maxSpeed });
  fish.hp = -1; // killed by something else entirely
  const rig = rigWithFins();
  let threw = false;
  try {
    swing(1, { level: 1, speed: CONFIG.player.maxSpeed, rig });
  } catch (err) {
    threw = true;
    realWarn(err);
  }
  check('a body that dies mid-flight is let go of cleanly', !threw);
}

// ----------------------------------------------------------------------- levels

section('LEVELS — every stack is worth taking');

check('damage climbs per stack', clubDamage(6) > clubDamage(1),
  `${clubDamage(1)} -> ${clubDamage(6)}`);
check('reach climbs per stack', clubLength(6) > clubLength(1),
  `${clubLength(1).toFixed(2)} -> ${clubLength(6).toFixed(2)} units`);
check('bounces climb per stack', clubBounces(6) > clubBounces(1),
  `${clubBounces(1)} -> ${clubBounces(6)}`);
// THE WOOD YOU SEE IS THE REACH THAT HITS. Measured off the built mesh rather
// than compared against a hand-typed number, because every body in this game
// carries a size multiplier (assets.csv) on top of its own geometry — a stick
// sized by eye is a stick that lies about its range, and the lie is invisible
// in a screenshot.
{
  freshRun();
  swing(0.05, { level: 1 });
  const mesh = clubGroup.children[0];
  // Measured with the swing taken OUT. A world-axis box around a stick lying
  // on a diagonal is shorter than the stick, so measuring the club mid-swing
  // reports whatever angle it happened to be at — which is a test that fails
  // for a reason that has nothing to do with the model.
  const spin = mesh.rotation.z;
  mesh.rotation.z = 0;
  mesh.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  mesh.rotation.z = spin;
  const drawn = Math.max(size.x, size.y, size.z);
  check('the club is drawn at the reach it actually has',
    Math.abs(drawn - clubLength(1)) < 0.15,
    `${drawn.toFixed(2)}u drawn vs ${clubLength(1).toFixed(2)}u of reach`);

  // ...and the drawing grows with the reach. Stacks lengthen the hitbox, so a
  // club drawn at a fixed size would be swinging two units of wood through
  // four units of reach by the top of the card.
  freshRun();
  swing(0.05, { level: 6 });
  const [base6, head6] = shaftEnds(clubGroup.children[0]);
  const drawn6 = Math.hypot(head6.x - base6.x, head6.y - base6.y);
  check('...and a stacked club is drawn longer, matching its reach',
    Math.abs(drawn6 - clubLength(6)) < 0.3,
    `${drawn6.toFixed(2)}u drawn vs ${clubLength(6).toFixed(2)}u of reach at level 6`);
}

// ------------------------------------------------------------------ the riders

section('RIDERS — Powder Keg and Cold Snap, on every club hit');

{
  // POWDER KEG reaches bodies the club never touched. Measured against a
  // control run with the card off, because a crowd this tight takes carom
  // damage either way and "some of them got hurt" proves nothing on its own.
  const hurtCount = (boom) => {
    freshRun();
    spawnAt('shark', 1.5, -20);
    const crowd = [];
    for (let i = 0; i < 10; i++) crowd.push(spawnAt('fish', 3 + i * 0.7, -19.5));
    const hp = new Map(crowd.map((e) => [e, e.hp]));
    swing(1.5, { level: 1, boom, finSpin: 10, speed: CONFIG.player.maxSpeed });
    return crowd.filter((e) => !enemies.includes(e) || e.hp < hp.get(e)).length;
  };
  const without = hurtCount(0);
  const with3 = hurtCount(3);
  check('a detonating club reaches more of the crowd than a plain one',
    with3 > without, `${without} hurt without the keg, ${with3} with it`);

  let blasts = 0;
  freshRun();
  spawnAt('fish', 1.4, -20);
  swing(1.5, { level: 1, boom: 1, finSpin: 10, hooks: { onBlast: () => { blasts++; } } });
  check('...and it announces itself', blasts > 0, `${blasts} blast(s)`);
  check('no card, no blast', clubBlast(0) === null);

  // COLD SNAP puts the game's OWN chill on a body — the same fields the
  // element rolls, so the enemy integrator slows it with no new concept.
  freshRun();
  const chilled = spawnAt('shark', 1.4, -20);
  swing(1, { level: 1, ice: 3, finSpin: 10 });
  check('an ice club chills what it hits',
    (chilled.chillSlow ?? 0) > 0 || (chilled.trapTimer ?? 0) > 0,
    `slow ${(chilled.chillSlow ?? 0).toFixed(2)}, trapped ${(chilled.trapTimer ?? 0).toFixed(2)}s`);
  check('no card, no ice', clubIce(0) === null);

  // ...AND IT THAWS. The bug this is really here for: the chill decay used to
  // live inside a loop updateElements skips outright when the run rolled no
  // element, so a club-applied chill would have slowed a body for the rest of
  // the run with nothing left able to clear it.
  {
    const { updateElements, resetElements } = await import('../path/src/systems/elements.js');
    freshRun();
    resetElements(scene);            // no element rolled — the dangerous case
    const body = spawnAt('shark', 1.4, -20);
    // ONE stack and a short swing, deliberately: at high stacks the chill
    // SATURATES, and a saturating hit spends the slow (that is what buys the
    // freeze), leaving nothing behind to thaw. Asserting on that state would
    // have been a test that passes without the decay existing at all.
    swing(0.35, { level: 1, ice: 1, finSpin: 10 });
    const slowed = body.chillSlow ?? 0;
    check('...and a hit that does not saturate leaves a slow behind', slowed > 0,
      `slow ${slowed.toFixed(2)} — if this is 0 the thaw check below proves nothing`);
    for (let i = 0; i < 60 * 12; i++) updateElements(dt, scene, enemies, {});
    check('a club-applied chill thaws even with no element rolled',
      (body.chillSlow ?? 0) === 0 && (body.chillTimer ?? 0) === 0,
      `slowed ${slowed.toFixed(2)} -> ${(body.chillSlow ?? 0).toFixed(2)} after 12s`);
  }
}

// ------------------------------------------------------------------ the hurler

section('HURLER — the variant, thrown on a strike release');

{
  const { projectiles, resetProjectiles } = await import('../path/src/entities/projectiles.js');
  const { fireClubThrow, clubThrowCount, clubThrowReady } = await import('../path/src/systems/club.js');

  const origin = (i) => new THREE.Vector3(playerPos.x, playerPos.y, 0);
  // resetClub() before every throw, because a throw now EMPTIES THE FINS and
  // a second one would be refused for having nothing left to throw — which is
  // the socket rule, tested on its own below. These cases are about the count
  // and the velocity, so each starts from a weapon that has not been thrown.
  const throwAt = (power, level = 1, vel = { x: 20, y: 0 }, clubLevel = 1) => {
    resetProjectiles(scene);
    resetClub();
    const n = fireClubThrow(scene, power, level, clubLevel, vel, origin, {});
    return { n, shots: projectiles.filter((p) => p.source === 'clubThrow') };
  };

  // THE CARD'S PROMISE: how many depends on how hard you charged.
  const flick = throwAt(0.2);
  const full = throwAt(1);
  check('a full charge throws more clubs than a flick', full.n > flick.n,
    `${flick.n} at 0.2 power, ${full.n} at full`);
  check('...and the count is a ramp, not a step',
    clubThrowCount(0.5, 1) > clubThrowCount(0.2, 1) && clubThrowCount(1, 1) > clubThrowCount(0.5, 1),
    `${clubThrowCount(0.2, 1)} / ${clubThrowCount(0.5, 1)} / ${clubThrowCount(1, 1)} at 0.2 / 0.5 / 1.0`);
  check('...and stacks throw more again', clubThrowCount(1, 5) > clubThrowCount(1, 1),
    `${clubThrowCount(1, 1)} -> ${clubThrowCount(1, 5)}`);
  check('a release under the threshold throws nothing',
    !clubThrowReady(CONFIG.clubThrow.minPower - 0.01, 1) && throwAt(0).n === 0);
  check('no card, no throw', throwAt(1, 0).n === 0);

  // THE SEAL'S VELOCITY IS THE THROW. Faster seal, faster club — and it leaves
  // along the body's heading rather than along a cursor.
  const slow = throwAt(1, 1, { x: 6, y: 0 }).shots;
  const fast = throwAt(1, 1, { x: 34, y: 0 }).shots;
  check('the seal\'s speed drives the throw\'s speed', fast[0].speed > slow[0].speed,
    `${slow[0].speed.toFixed(1)} at 6 u/s, ${fast[0].speed.toFixed(1)} at 34 u/s`);

  const up = throwAt(1, 1, { x: 0, y: 25 }).shots;
  const heads = up.map((p) => Math.atan2(p.dir.y, p.dir.x));
  const offAxis = Math.max(...heads.map((h) => Math.abs(h - Math.PI / 2)));
  check('...and its heading is the seal\'s heading', offAxis < CONFIG.clubThrow.arc,
    `worst club is ${(offAxis * 57.3).toFixed(0)}deg off a straight-up dash`);

  // A throw is a real club: it hits for what the fin clubs hit for, and it
  // seeks rather than flying straight.
  const armed = throwAt(1, 1, { x: 20, y: 0 }, 6).shots;
  const bare = throwAt(1, 1, { x: 20, y: 0 }, 1).shots;
  check('stacking the base club arms the thrown one too', armed[0].damage > bare[0].damage,
    `${bare[0].damage.toFixed(1)} at club 1, ${armed[0].damage.toFixed(1)} at club 6`);
  check('a thrown club homes', bare.every((p) => p.homing));
  check('...but flies straight first, so the throw is visible',
    bare.every((p) => p.homingDelay > 0), `${bare[0].homingDelay}s of straight flight`);

  // THE SOCKETS. The Hurler throws the REAL clubs off the fins, so the melee
  // weapon is gone until they come back — that gap is the whole price of the
  // card, and without it the respawn timer is decoration.
  {
    const { clubsInHand } = await import('../path/src/systems/club.js');
    freshRun();
    const rig = rigWithFins(2);
    swing(0.2, { level: 1, rig });
    check('both fins start holding a club', clubsInHand() === 2, `${clubsInHand()} in hand`);

    resetProjectiles(scene);
    const thrown = fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {});
    check('a throw empties the fins', clubsInHand() === 0,
      `${thrown} thrown, ${clubsInHand()} left in hand`);

    // ...and an empty fin cannot hit. This is the claim that makes the cost
    // real rather than cosmetic.
    const fish = spawnAt('fish', 1.4, -20);
    const hp = fish.hp;
    swing(CONFIG.club.respawnTime * 0.5, { level: 1, rig, finSpin: 10 });
    check('...and an empty fin swings nothing', fish.hp === hp && clubsInHand() === 0,
      `fish ${fish.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);

    // A second release while empty-handed throws nothing at all.
    resetProjectiles(scene);
    check('...and a second strike while empty-handed throws nothing',
      fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {}) === 0);

    // Then they come back.
    swing(CONFIG.club.respawnTime * 0.7, { level: 1, rig, finSpin: 10 });
    check('the clubs respawn in hand after the cooldown', clubsInHand() === 2,
      `${clubsInHand()} back after ${CONFIG.club.respawnTime}s`);
    resetProjectiles(scene);
    check('...and the throw is available again',
      fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {}) > 0);
  }

  resetProjectiles(scene);
}

// ----------------------------------------------------------------- the variants

section('VARIANTS — you can tell from the water what you are holding');

{
  const { clubAssetsFor } = await import('../path/src/systems/club.js');
  const { ASSETS } = await import('../path/src/assets.js');

  check('a plain run holds the base club', clubAssetsFor({}).join() === 'club');

  // A VARIANT ON ITS OWN STILL ARMS THE SEAL. Straight out of playtest/runs
  // .jsonl, which recorded three real runs that took Cold Snap and Powder Keg
  // and NO Driftwood Club: the weapon was gated on the base card's level, so
  // those runs got no clubs at all and both picks did nothing. Every variant
  // is takeable on its own by design, so every variant has to arm the fins on
  // its own too.
  for (const [label, levels] of [
    ['Cold Snap alone', { ice: 1 }],
    ['Powder Keg alone', { boom: 1 }],
    ['Hurler alone', { throw: 1 }],
    ['Keg + Snap, no base card', { boom: 1, ice: 1 }],
  ]) {
    freshRun();
    const rig = rigWithFins(2);
    const fish = spawnAt('fish', 1.4, -20);
    const hp = fish.hp;
    swing(1.2, { level: 0, boom: levels.boom ?? 0, ice: levels.ice ?? 0, rig, finSpin: 10,
      velocity: { x: 9, y: 0 }, throwLevel: levels.throw ?? 0 });
    const built = clubGroup.children.length;
    check(`${label}: still puts clubs in the fins`, built > 0, `${built} club(s) built`);
    if (levels.throw == null) {
      check(`${label}: ...and they still hit`, fish.hp < hp,
        `fish ${fish.hp.toFixed(1)} of ${hp.toFixed(1)} hp`);
    }
  }
  check('Powder Keg puts its own club in a fin',
    clubAssetsFor({ boom: 1 }).includes('clubBoom'));
  check('Cold Snap puts its own club in a fin',
    clubAssetsFor({ ice: 1 }).includes('clubIce'));
  // Two variants must both be visible rather than one masking the other. They
  // no longer share the fins to manage it — the first type taken is what the
  // seal HOLDS and the second rides the ring — so the claim is that between
  // the two mounts, both are on screen.
  const { clubOrbiters } = await import('../path/src/systems/club.js');
  const twoFin = clubAssetsFor({ boom: 1, ice: 1 });
  const twoRing = clubOrbiters({ boom: 1, ice: 1 });
  const shown = [...twoFin, ...twoRing];
  check('...and owning two shows one of each',
    shown.includes('clubBoom') && shown.includes('clubIce'),
    `fins ${twoFin.join('+')}, ring ${twoRing.join('+') || 'empty'}`);

  // EVERY VARIANT IS THE SAME MODEL FOR NOW, and the fields that make a club
  // hang right have to survive being derived — a variant that lost the grip
  // pivot would be held by its middle, and that is invisible in a still.
  for (const key of ['club', 'clubBoom', 'clubIce', 'clubThrow']) {
    const def = ASSETS[key];
    check(`${key}: same model, gripped at the handle`,
      def?.model === ASSETS.club.model && def?.pivot === ASSETS.club.pivot
        && def?.forward === ASSETS.club.forward && def?.fit === ASSETS.club.fit,
      def?.model ?? 'MISSING');
  }

  // THE BUG THIS SECTION EXISTS FOR. club.glb ships an untextured pure-white
  // material, and `color` in an asset def only ever reaches the procedural
  // fallback shape — so a model entry with no `tint` renders as a white stick
  // lit by the scene, which is why none of these could be seen. A tint is not
  // decoration here; it is the only thing that colours a loaded model.
  const heads = new Set();
  for (const key of ['club', 'clubBoom', 'clubIce', 'clubThrow']) {
    const def = ASSETS[key];
    check(`${key}: has a tint, so the model is not left white`,
      typeof def?.tint === 'number', def?.tint == null ? 'NO TINT' : `#${def.tint.toString(16)}`);
    heads.add(def?.headTint);
  }
  // THE SHAFT IS SHARED, THE HEAD IS NOT. A club is a club — what tells the
  // variants apart is the business end, and colouring the whole stick would
  // make them read as four different weapons rather than one weapon's family.
  const shafts = new Set(['club', 'clubBoom', 'clubIce', 'clubThrow'].map((k) => ASSETS[k].tint));
  check('every variant keeps the same brown shaft', shafts.size === 1,
    `${shafts.size} shaft colour(s)`);
  check('...and no two variants share a head colour', heads.size === 4,
    `${heads.size} distinct heads`);
  // The split is a MEASURED fraction, not a guess: club.glb's shaft carries no
  // vertices along its length, so the head has to start where the mesh
  // actually flares or the paint smears down the handle.
  check('...and the head starts where the model flares',
    ASSETS.club.headFrom > 0.4 && ASSETS.club.headFrom < 0.8,
    `headFrom ${ASSETS.club.headFrom}`);
}

// ------------------------------------------------------------------- the ring

section('THE RING — the club types you are not holding orbit you');

{
  const { clubAssetsFor, clubOrbiters, clubsInHand, clubsOrbiting } = await import('../path/src/systems/club.js');

  // THE FIRST TYPE YOU TOOK IS THE ONE IN YOUR FINS, and it is the run's
  // history that decides it rather than a priority list. The same two levels
  // taken in the other order have to put the other club in the flippers, or
  // the card that just arrived is contradicted by the flipper it lands on.
  freshRun();
  const rig = rigWithFins(2);
  swing(0.2, { level: 1, rig, velocity: { x: 9, y: 0 } });              // base club first
  swing(0.2, { level: 1, ice: 2, rig, velocity: { x: 9, y: 0 } });      // then Cold Snap
  check('the club you took first is the one in your fins',
    clubAssetsFor({ club: 1, ice: 2 }).join() === 'club',
    clubAssetsFor({ club: 1, ice: 2 }).join());
  check('...and the second type is on the ring, one club per stack',
    clubOrbiters({ club: 1, ice: 2 }).join() === 'clubIce,clubIce',
    clubOrbiters({ club: 1, ice: 2 }).join() || 'empty');

  freshRun();
  const rig2 = rigWithFins(2);
  swing(0.2, { level: 0, ice: 1, rig: rig2, velocity: { x: 9, y: 0 } }); // Cold Snap first
  swing(0.2, { level: 1, ice: 1, rig: rig2, velocity: { x: 9, y: 0 } }); // then the base club
  check('...and taking them the other way round swaps which one you hold',
    clubAssetsFor({ club: 1, ice: 1 }).join() === 'clubIce',
    clubAssetsFor({ club: 1, ice: 1 }).join());

  // ONE TYPE MEANS NO RING AT ALL. A run holding one club card should look
  // exactly like it always did — the ring is what the SECOND type buys.
  freshRun();
  swing(0.3, { level: 3, rig: rigWithFins(2), velocity: { x: 9, y: 0 } });
  check('one club type still means fins only', clubsOrbiting() === 0 && clubsInHand() === 2,
    `${clubsInHand()} held, ${clubsOrbiting()} orbiting`);

  // STACKS ADD CLUBS. The whole promise of the second half of the card: a
  // third pick of Cold Snap is a third club on the ring and you can count it.
  const built = [];
  for (const stacks of [1, 2, 4]) {
    freshRun();
    swing(0.3, { level: 1, ice: stacks, rig: rigWithFins(2), velocity: { x: 9, y: 0 } });
    built.push(clubsOrbiting());
  }
  check('every extra stack is another club on the ring',
    built.join() === '1,2,4', `${built.join(' -> ')} orbiting for 1, 2, 4 stacks`);

  // ...AND THEY ACTUALLY GO ROUND. Measured off the meshes over time rather
  // than trusted from the config: a ring whose clubs are built and then parked
  // on top of the player passes every count above and is not an orbit.
  freshRun();
  const rig3 = rigWithFins(2);
  const at = [];
  for (let i = 0; i < 240; i++) {
    rig3.pose(i * dt * 6);
    updateClub(dt, scene, playerPos, { club: 1, ice: 1 }, enemies,
      { rig: rig3, velocity: { x: 0, y: 0 } }, {});
    // The orbiters are appended after the fin sockets, so the last child is one.
    const m = clubGroup.children[clubGroup.children.length - 1];
    at.push({ x: m.position.x - playerPos.x, y: m.position.y - playerPos.y, a: Math.atan2(m.position.y - playerPos.y, m.position.x - playerPos.x) });
  }
  const far = at.map((p) => Math.hypot(p.x, p.y));
  check('an orbiting club stays out at arm\'s length',
    Math.min(...far) > 0.8 && Math.max(...far) < CONFIG.club.orbit.radius * 2.2,
    `${Math.min(...far).toFixed(2)}..${Math.max(...far).toFixed(2)}u from the seal`);
  // A full turn, not a wobble: the angle has to visit all four quadrants.
  const quadrants = new Set(at.map((p) => Math.floor(((p.a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2))));
  check('...and goes all the way round', quadrants.size === 4,
    `${quadrants.size} of 4 quadrants visited`);

  // AN ORBITER IS A REAL CLUB. Driven with NO fins at all, so the only thing
  // in the water that can hit anything is the ring — a decorative orbiter
  // passes every check above and this is the one it cannot fake.
  freshRun();
  const ringOnly = { muzzles: [] };
  const victim = spawnAt('fish', CONFIG.club.orbit.radius, -20);
  const vhp = victim.hp;
  for (let i = 0; i < 300; i++) {
    updateClub(dt, scene, playerPos, { club: 1, ice: 2 }, enemies,
      { rig: ringOnly, velocity: { x: 0, y: 0 } }, {});
  }
  const killed = !enemies.includes(victim);
  check('an orbiting club hits what it sweeps through', killed || victim.hp < vhp,
    killed ? 'killed by the ring' : `fish ${victim.hp.toFixed(1)} of ${vhp.toFixed(1)} hp`);

  // THE HURLER DOES NOT THROW THE RING. The card's cost is the weapon leaving
  // your HANDS; emptying the ring here would have one pick silently delete
  // another card's stacks for two seconds.
  freshRun();
  const rig4 = rigWithFins(2);
  swing(0.3, { level: 1, ice: 2, throwLevel: 1, rig: rig4, velocity: { x: 9, y: 0 } });
  const heldBefore = clubsInHand();
  const ringBefore = clubsOrbiting();
  const { fireClubThrow } = await import('../path/src/systems/club.js');
  fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {});
  check('a throw empties the fins', clubsInHand() === 0, `${heldBefore} -> ${clubsInHand()} held`);
  check('...and leaves the ring alone', clubsOrbiting() === ringBefore,
    `${ringBefore} -> ${clubsOrbiting()} orbiting`);
}

// ------------------------------------------------------------------ the shove

section('SHOVE — every club hit knocks the body off its line');

{
  // THE BUG THIS SECTION EXISTS FOR. The launch is refused for everything
  // canHold() says no to, which is every boss — so the weapon whose whole read
  // is "things leave when you hit them" was the weapon that bounced off the
  // animal the run is built around. `isBoss` is the only thing controlImmune
  // reads, so this is the real refusal and not a stand-in for it.
  const bossRun = (knock) => {
    const was = CONFIG.club.knock;
    CONFIG.club.knock = knock;
    freshRun();
    const boss = spawnAt('shark', 1.6, -20);
    boss.isBoss = true;
    boss.hp = 1e6;           // it must survive to be measured, not be launched
    const from = boss.mesh.position.clone();
    swing(1.2, { level: 3, rig: rigWithFins(2), velocity: { x: 9, y: 0 } });
    // The shove lands in knockX/knockY, which the club never integrates — that
    // is entities/enemies.js's job and this harness deliberately does not run
    // it. So the claim is measured where the club actually writes it.
    const shove = Math.hypot(boss.knockX ?? 0, boss.knockY ?? 0);
    CONFIG.club.knock = was;
    return { shove, moved: boss.mesh.position.distanceTo(from), hurt: boss.hp < 1e6 };
  };

  const off = bossRun(0);
  const on = bossRun(CONFIG.club.knock);
  check('a club connects with a body the launch refuses', on.hurt,
    on.hurt ? 'took damage' : 'never hit');
  check('...and shoves it, where it used to do nothing at all',
    on.shove > 0 && off.shove === 0,
    `${off.shove.toFixed(2)} with knock off, ${on.shove.toFixed(2)} with it on`);

  // AND THE SHOVE IS THE SWING'S. Everything else in this weapon is scaled by
  // how hard the club is actually travelling, and a knockback that ignored
  // that would be the one part of the club a stationary player gets for free.
  const at = (spin) => {
    freshRun();
    const boss = spawnAt('shark', 1.6, -20);
    boss.isBoss = true;
    boss.hp = 1e6;
    swing(1.2, { level: 3, rig: rigWithFins(2), finSpin: spin, velocity: { x: 9, y: 0 } });
    return Math.hypot(boss.knockX ?? 0, boss.knockY ?? 0);
  };
  const lazy = at(1);
  const hard = at(14);
  check('a harder swing shoves harder', hard > lazy * 1.15,
    `${lazy.toFixed(2)} at a drift vs ${hard.toFixed(2)} at a whip`);

  // THE THROWN CLUB CARRIES IT TOO, as a payload on the shot rather than as
  // anything club.js knows how to do — the same arrangement `chill` uses. This
  // is the claim that "all clubs" is true and not just the fin swing.
  freshRun();
  const { projectiles } = await import('../path/src/entities/projectiles.js');
  projectiles.length = 0;
  const { fireClubThrow: hurl } = await import('../path/src/systems/club.js');
  hurl(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {});
  const carried = projectiles.filter((b) => b.source === 'clubThrow' && b.knockback > 0).length;
  check('a thrown club carries the shove as a payload',
    carried > 0 && carried === projectiles.length,
    `${carried} of ${projectiles.length} thrown clubs shove`);
  projectiles.length = 0;
}

// --------------------------------------------------------------- the real file

section('THE MODEL — club.glb, through the real fitting path');

// Everything above ran on the PROCEDURAL FALLBACK: Node cannot fetch
// /models/club.glb, so createVisual quietly returns the built-in shape. That
// makes the model's own placement the one claim this file would otherwise
// never touch — and it is the claim most likely to be wrong, because the
// fallback is centred on its origin while the model is pivoted at its handle.
// So the real bytes go through the real fit/pivot/orientation code here.
{
  const { readFileSync } = await import('node:fs');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { prepareModel, ASSETS } = await import('../path/src/assets.js');

  const buf = readFileSync(new URL('../public/models/club.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );

  const def = ASSETS.club;
  const built = prepareModel(gltf.scene, def, [], null, 'club-test');
  const root = built.object ?? built.model ?? built.scene ?? built;
  const holder = new THREE.Object3D();
  holder.add(root);
  holder.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  check('the model is fitted to the club\'s reach',
    Math.abs(longest - def.fit) < 0.2, `${longest.toFixed(2)}u against fit ${def.fit}`);

  // THE GRIP. createVisual points forward down +Y, so with the handle pivot
  // the shaft should run from ~0 up to +fit — nothing behind the origin. A
  // model recentred on its centre of mass instead would straddle it, and the
  // seal would be holding the club by its middle.
  const behind = Math.max(0, -box.min.y);
  check('...and hangs from its handle, not its middle',
    behind < def.fit * 0.25,
    `${behind.toFixed(2)}u of shaft sits behind the grip (of ${def.fit})`);

  // And the fat end is the far end — a club held by the head is a club that
  // whacks with its handle.
  let loMass = 0;
  let hiMass = 0;
  const v = new THREE.Vector3();
  holder.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i);
      o.localToWorld(v);
      if (v.y < box.min.y + size.y * 0.25) loMass++;
      else if (v.y > box.max.y - size.y * 0.25) hiMass++;
    }
  });
  check('...with the heavy end out at the far end', hiMass > loMass,
    `${loMass} verts at the grip, ${hiMass} at the head`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
