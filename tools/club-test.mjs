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
  clubHitFx, clubTrailMovers, clubsOrbiting, clubsInHand,
} from '../path/src/systems/club.js';
import { player } from '../path/src/entities/player.js';

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
  // ONE PICK IS ONE CLUB, so the pair takes two. The first card used to arm
  // both flippers and the second one was never bought by anything.
  swing(0.2, { level: 1, rig });
  check('one card is one club, in one fin', clubGroup.children.length === 1,
    `${clubGroup.children.length} built`);
  swing(0.5, { level: 2, rig });
  const group = clubGroup;
  check('...and the second card fills the other fin', group?.children.length === 2,
    `${group?.children.length ?? 0} built`);

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
      worstHead = Math.max(worstHead, Math.abs(Math.hypot(head.x - tip.x, head.y - tip.y) - clubLength(2)));
    });
    check('...and each is gripped AT its fin tip', worstBase < 0.3,
      `worst butt-end sits ${worstBase.toFixed(3)}u off the tip`);
    check('...with the head out at the far end of the reach', worstHead < 0.3,
      `worst head is ${worstHead.toFixed(3)}u off ${clubLength(2).toFixed(2)}u`);
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
  //
  // DRIVEN WITH A REAL FIN SPIN, and that is not padding. Speed alone used to
  // produce a fast swing because `assistSpin` turned the clubs on a clock of
  // its own; with that gone, a seal sprinting in a straight line has both
  // clubs streaming flat out behind it and the head never crosses this fish at
  // all — which is the weapon working as intended and a scenario that can no
  // longer ask the question. The claim here is about the SWEEP, so the setup
  // has to actually produce one.
  freshRun();
  const onTheArc = spawnAt('fish', clubLength(1) * 0.92, -20);
  const hp = onTheArc.hp;
  swing(1, { level: 1, speed: CONFIG.player.maxSpeed, dashing: true, finSpin: 16 });
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

section('RIDERS — Boom Boom Club and Cold Snap, on every club hit');

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
  //
  // ...EXCEPT THE BASIC CLUB, WHICH NEVER LEAVES. See
  // CONFIG.clubThrow.neverThrown: the cost used to land on whichever clubs
  // happened to be in the flippers, which on most builds is the Driftwood Club
  // — so the base weapon was the thing a DIFFERENT card spent, and Basic Baby
  // Club's contribution to a Hurler run was to be disarmed twice a minute. The
  // price now falls on the variants, and the driftwood twirls instead (see the
  // twirl section below).
  {
    const { clubsInHand, clubsThrowable } = await import('../path/src/systems/club.js');
    freshRun();
    const rig = rigWithFins(2);
    // ONE OF EACH, so the fins hold a club that goes and a club that stays —
    // which is the only arrangement that can tell the new rule from the old
    // one. Two picks, because one pick is one club.
    swing(0.2, { level: 1, ice: 1, rig });
    check('both fins start holding a club', clubsInHand() === 2, `${clubsInHand()} in hand`);
    check('...and only one of them is the Hurler\'s to take', clubsThrowable() === 1,
      `${clubsThrowable()} of ${clubsInHand()} throwable`);

    resetProjectiles(scene);
    const thrown = fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {});
    check('a throw takes the variant out of its fin', clubsThrowable() === 0,
      `${thrown} thrown, ${clubsThrowable()} throwable left`);
    check('...and leaves the driftwood in the other', clubsInHand() === 1,
      `${clubsInHand()} still in hand`);

    // ...and the emptied fin cannot hit, which is the claim that makes the cost
    // real rather than cosmetic. Measured as a SHARE of what two clubs do
    // rather than as "no damage at all", because the club that stayed is still
    // swinging — that is the whole point of the change, and a test written as
    // `hp === startHp` would now be asserting the bug.
    const bothFish = spawnAt('fish', 1.4, -20);
    const bothHp = bothFish.hp;
    swing(CONFIG.club.respawnTime * 0.5, { level: 1, ice: 1, rig, finSpin: 10 });
    const oneArmed = bothHp - bothFish.hp;
    check('...and the emptied fin swings nothing', clubsInHand() === 1,
      `${clubsInHand()} club still swinging while the other is away`);
    check('...but the club that stayed is still a weapon', oneArmed > 0,
      `fish took ${oneArmed.toFixed(1)} while one fin was empty`);

    // A second release while a socket is still recovering throws nothing. THIS
    // is the cost, and it is the assertion that would have quietly died: the
    // old gate asked whether anything was in hand, and a driftwood club that
    // never leaves makes that true forever.
    resetProjectiles(scene);
    check('...and a second strike before it is back throws nothing',
      fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {}) === 0);

    // Then it comes back.
    swing(CONFIG.club.respawnTime * 0.7, { level: 1, ice: 1, rig, finSpin: 10 });
    check('the club respawns in hand after the cooldown', clubsThrowable() === 1,
      `${clubsThrowable()} back after ${CONFIG.club.respawnTime}s`);
    resetProjectiles(scene);
    check('...and the throw is available again',
      fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {}) > 0);
  }

  // A RUN WHOSE FINS ARE NOTHING BUT DRIFTWOOD. Its Hurler is out on the ring,
  // where the card has never been able to reach it, so there is nothing to
  // spend and the throw is free — which is the correct answer rather than a
  // hole, and it is emphatically not the same as being DEAD. The gate is about
  // an empty socket, and this run never has one.
  {
    const { clubsInHand, clubsThrowable } = await import('../path/src/systems/club.js');
    freshRun();
    const rig = rigWithFins(2);
    swing(0.2, { level: 2, rig });
    check('two driftwood clubs are nobody\'s to throw', clubsThrowable() === 0,
      `${clubsInHand()} in hand, ${clubsThrowable()} throwable`);

    resetProjectiles(scene);
    const first = fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, origin, {});
    check('...and the Hurler still fires', first > 0, `${first} thrown`);
    check('...without emptying a fin', clubsInHand() === 2, `${clubsInHand()} still in hand`);

    // And again on the next beat, because nothing is recovering. A gate written
    // as "is a throwable club in hand" would have made this run's Hurler a dead
    // card forever, which is the failure this case exists to catch.
    resetProjectiles(scene);
    check('...and again on the next strike, with no cooldown to serve',
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
  // .jsonl, which recorded three real runs that took Cold Snap and Boom Boom Club
  // and NO Driftwood Club: the weapon was gated on the base card's level, so
  // those runs got no clubs at all and both picks did nothing. Every variant
  // is takeable on its own by design, so every variant has to arm the fins on
  // its own too.
  for (const [label, levels] of [
    ['Cold Snap alone', { ice: 1 }],
    ['Boom Boom Club alone', { boom: 1 }],
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
  check('Boom Boom Club puts its own club in a fin',
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

// ------------------------------------------------------ the swing is performed

section('PERFORMED — nothing turns these clubs but the animal');

{
  const { clubSwingSpeed } = await import('../path/src/systems/club.js');

  // THE CENTRAL CLAIM OF THE REWRITE. A seal doing NOTHING — no fin motion, no
  // travel, no direction change — must produce no swing at all, and therefore
  // no damage. The free spin that used to sit under this weapon meant a player
  // holding still was still being paid, which is the whole reason there was
  // never a reason to work the fins.
  freshRun();
  const still = rigWithFins(2);
  const idle = spawnAt('fish', 1.4, -20);
  const idleHp = idle.hp;
  for (let i = 0; i < 240; i++) {
    still.pose(0);   // the fins do not move
    updateClub(dt, scene, playerPos, { club: 1 }, enemies,
      { rig: still, velocity: { x: 0, y: 0 } }, {});
  }
  check('a seal doing nothing swings nothing', clubSwingSpeed() < CONFIG.club.minSwing,
    `${clubSwingSpeed().toFixed(2)} rad/s, gate ${CONFIG.club.minSwing}`);
  check('...and hurts nothing', idle.hp === idleHp,
    `fish ${idle.hp.toFixed(1)} of ${idleHp.toFixed(1)} hp`);

  // ...AND NEITHER DOES HOLDING A LINE. Full speed, dead straight, fins still.
  // This is the one that makes the class a technique rather than a toll: the
  // drag has the clubs streaming flat out behind and nothing is putting energy
  // into them.
  freshRun();
  const cruise = rigWithFins(2);
  for (let i = 0; i < 240; i++) {
    cruise.pose(0);
    updateClub(dt, scene, playerPos, { club: 1 }, enemies,
      { rig: cruise, velocity: { x: CONFIG.player.maxSpeed, y: 0 } }, {});
  }
  check('...and neither does holding a straight line at full speed',
    clubSwingSpeed() < CONFIG.club.minSwing,
    `${clubSwingSpeed().toFixed(2)} rad/s`);

  // CARRY-THROUGH FROM THE FIN. Spin the flippers, then STOP them dead: the
  // clubs must still be turning some frames later. That is the difference
  // between momentum and a target — a club that merely chased the flipper
  // stops the same frame the flipper does.
  freshRun();
  const spun = rigWithFins(2);
  for (let i = 0; i < 90; i++) {
    spun.pose(i * dt * 14);
    updateClub(dt, scene, playerPos, { club: 1 }, enemies,
      { rig: spun, velocity: { x: 0, y: 0 } }, {});
  }
  const atStop = clubSwingSpeed();
  const held = spun.muzzles.map((m) => m.clone());
  let after = 0;
  for (let i = 0; i < 6; i++) {
    spun.muzzles.forEach((m, k) => m.copy(held[k]));  // fins frozen
    updateClub(dt, scene, playerPos, { club: 1 }, enemies,
      { rig: spun, velocity: { x: 0, y: 0 } }, {});
    after = clubSwingSpeed();
  }
  check('the clubs keep turning after the fins stop', after > CONFIG.club.minSwing,
    `${atStop.toFixed(2)} -> ${after.toFixed(2)} rad/s, 0.1s after the fins froze`);

  // CARRY-THROUGH FROM THE BODY. Same still fins, same speed — the only
  // difference is that one of them CHANGES DIRECTION. Acceleration and not
  // speed is what this term reads, which is exactly why a straight line at any
  // speed is worth nothing and a carve is worth something.
  const carve = (turning) => {
    freshRun();
    const rig = rigWithFins(2);
    let peak = 0;
    for (let i = 0; i < 180; i++) {
      rig.pose(0);
      const t = i * dt;
      const a = turning ? t * 6 : 0;   // one is swinging its heading round
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: Math.cos(a) * 20, y: Math.sin(a) * 20 } }, {});
      peak = Math.max(peak, clubSwingSpeed());
    }
    return peak;
  };
  const straight = carve(false);
  const turned = carve(true);
  check('changing direction swings them, holding a line does not',
    turned > CONFIG.club.minSwing && turned > straight * 3,
    `${straight.toFixed(2)} rad/s straight vs ${turned.toFixed(2)} carving`);

  // A SWUNG FLIPPER BEATS THE WATER. The drag target at full swim used to pin
  // the clubs flat behind the animal hard enough that spinning the fins bought
  // almost nothing — which would have made "work the fins while swimming" a
  // lie the moment the player got up to speed.
  const spinAt = (speed) => {
    freshRun();
    const rig = rigWithFins(2);
    let peak = 0;
    for (let i = 0; i < 180; i++) {
      rig.pose(i * dt * 16);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: speed, y: 0 } }, {});
      peak = Math.max(peak, clubSwingSpeed());
    }
    return peak;
  };
  const atRest = spinAt(0);
  const atSprint = spinAt(CONFIG.player.maxSpeed);
  check('spinning the fins still works at full swim speed',
    atSprint > atRest * 0.6,
    `${atRest.toFixed(1)} rad/s at rest vs ${atSprint.toFixed(1)} sprinting`);
}

// -------------------------------------------------------------- the shockwave

section('SHOCKWAVE — what the top of a real swing is worth');

{
  const shockRun = (finSpin, seconds = 2) => {
    freshRun();
    const rig = rigWithFins(2);
    let shocks = 0;
    let peakRadius = 0;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      rig.pose(i * dt * finSpin);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: 0, y: 0 } },
        { onShock: (x, y, r) => { shocks++; peakRadius = Math.max(peakRadius, r); } });
    }
    return { shocks, peakRadius };
  };

  // A LAZY CLUB DOES NOT CRACK THE WATER. `shock.minSwing` sits well clear of
  // the damage gate on purpose — if a club that merely counts as swinging also
  // set off a wave, the wave would be the weapon and the swing decoration.
  const lazy = shockRun(2);
  check('a drifting club sets off nothing', lazy.shocks === 0, `${lazy.shocks} wave(s)`);

  const hard = shockRun(18);
  check('a hard swing does', hard.shocks > 0, `${hard.shocks} wave(s) in 2s`);

  // ...AND IT DOES NOT MACHINE-GUN. A club oscillating near the threshold peaks
  // several times a second, and `cooldown` is what stops one flick of the stick
  // being worth five waves.
  check('...but no faster than its cooldown allows',
    hard.shocks <= Math.ceil(2 / CONFIG.club.shock.cooldown) * 2,
    `${hard.shocks} across 2 clubs, cooldown ${CONFIG.club.shock.cooldown}s`);

  // A FRESH CLUB CANNOT FIRE ONE. A new socket answers its first real target
  // with a single very fast frame — a discontinuity, not a swing — and without
  // the arm timer every run opened with free waves.
  freshRun();
  {
    const rig = rigWithFins(2);
    let early = 0;
    for (let i = 0; i < Math.round(CONFIG.club.shock.armTime / dt); i++) {
      rig.pose(0);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: 9, y: 0 } }, { onShock: () => { early++; } });
    }
    check('a club that has just appeared cannot crack the water', early === 0,
      `${early} wave(s) inside ${CONFIG.club.shock.armTime}s of spawning`);
  }

  // IT DOES NOT NEED TO HIT ANYTHING. The whole reason the wave exists: the
  // swing's own damage wants a body inside its arc, and this is what a swing is
  // worth when the arc was empty. Measured on a body OUTSIDE the club's reach.
  freshRun();
  {
    const rig = rigWithFins(2);
    const outside = spawnAt('fish', clubLength(1) + 2.2, -20);
    const hp = outside.hp;
    let whacks = 0;
    for (let i = 0; i < 180; i++) {
      rig.pose(i * dt * 18);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: 0, y: 0 } }, { onWhack: () => { whacks++; } });
    }
    const died = !enemies.includes(outside);
    check('a wave reaches a body the swing never touched',
      whacks === 0 && (died || outside.hp < hp),
      died ? 'killed by the wave alone' : `${whacks} whack(s), fish ${outside.hp.toFixed(1)} of ${hp.toFixed(1)}`);
  }

  // AN ORBITER NEVER FIRES ONE. It turns at a rate the ring chose, so it has no
  // peak to find — and more to the point this is the payout for a movement the
  // player performed, and an orbiter performs nothing.
  freshRun();
  {
    let shocks = 0;
    for (let i = 0; i < 600; i++) {
      updateClub(dt, scene, playerPos, { club: 1, ice: 3 }, enemies,
        { rig: { muzzles: [] }, velocity: { x: 0, y: 0 } }, { onShock: () => { shocks++; } });
    }
    check('the ring never cracks the water', shocks === 0, `${shocks} wave(s) from 3 orbiters`);
  }
}

// ------------------------------------------------------------------ teed up

section('TEED UP — the club collects on every hold in the game');

{
  const { holdEnemy, charmEnemy, isDazed } = await import('../path/src/systems/control.js');

  // Same seal, same swing, same fish — the only difference is whether
  // something else had already stopped it. Measured as damage dealt, because a
  // multiplier applied to the wrong variable still multiplies correctly.
  const clubbed = (setup) => {
    freshRun();
    const fish = spawnAt('fish', 1.4, -20);
    fish.hp = 1e6;
    const rig = rigWithFins(2);
    let whacks = 0;
    for (let i = 0; i < 150; i++) {
      rig.pose(i * dt * 12);
      // Re-asserted every frame: enemies.js is not running here, but the club
      // itself decrements nothing and the hold has to still be true at the
      // moment the wood lands rather than only when it was applied.
      setup?.(fish);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: 6, y: 0 } }, { onWhack: () => { whacks++; } });
    }
    return { dealt: 1e6 - fish.hp, whacks };
  };

  const loose = clubbed(null);
  const netted = clubbed((e) => holdEnemy(e, 5));
  // Pinned to the CARD'S NUMBER rather than to "more". A loose "> 1.5x" passed
  // at a measured 15x, which is what a floor multiplying into the multiplier
  // bought before it was taken out — an assertion that cannot tell 2.4 from 15
  // cannot tell a bonus from a second weapon.
  const want = CONFIG.club.teed.damageMul;
  check('a held body takes exactly the card\'s multiplier from the same swing',
    netted.whacks > 0 && Math.abs(netted.dealt / loose.dealt - want) < want * 0.15,
    `${loose.dealt.toFixed(1)} loose vs ${netted.dealt.toFixed(1)} held = x${(netted.dealt / loose.dealt).toFixed(2)}, want x${want}`);

  // CHARM COUNTS TOO. The dumbo's card and the harp's both express themselves
  // as charmTimer rather than trapTimer, and a rule that only read one of the
  // two fields would tie in three abilities and silently skip the other three.
  const charmed = clubbed((e) => charmEnemy(e, 5));
  check('...and so does a charmed one',
    Math.abs(charmed.dealt / loose.dealt - want) < want * 0.15,
    `x${(charmed.dealt / loose.dealt).toFixed(2)} charmed`);

  // AND A DAZED BOSS. This is the one that matters: every hold in the game is
  // REFUSED on a boss and becomes a daze instead, so a rule written against
  // trapTimer alone would read well on the card and do nothing whatever in the
  // one fight the whole run is built around.
  const bossHit = (daze) => {
    freshRun();
    const boss = spawnAt('shark', 1.6, -20);
    boss.isBoss = true;
    boss.hp = 1e6;
    const rig = rigWithFins(2);
    for (let i = 0; i < 150; i++) {
      rig.pose(i * dt * 12);
      // holdEnemy, NOT a daze applied directly — on a boss the hold is refused
      // and BECOMES a daze, which is the path every one of the six control
      // abilities actually takes. Reaching past it would test a state nothing
      // in the game can put a boss into.
      if (daze) holdEnemy(boss, 5);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies, { rig, velocity: { x: 6, y: 0 } }, {});
    }
    return 1e6 - boss.hp;
  };
  const awake = bossHit(false);
  const dazed = bossHit(true);
  check('...and a dazed boss, which is what a hold on a boss becomes',
    dazed > awake * 1.5, `${awake.toFixed(1)} awake vs ${dazed.toFixed(1)} dazed`);

  // ...AND IT LEAVES HARDER. A body that is not swimming away from the blow
  // puts all of it into the throw, which is what makes a carom off a racked
  // school worth building toward rather than just noticing.
  const flungFrom = (setup) => {
    freshRun();
    const fish = spawnAt('fish', 1.4, -20);
    fish.hp = 1e6;
    const start = fish.mesh.position.clone();
    const rig = rigWithFins(2);
    let whacks = 0;
    for (let i = 0; i < 150; i++) {
      rig.pose(i * dt * 12);
      // Applied only until the first hit lands: a hold re-asserted forever
      // would keep `trapTimer` up through the whole flight, and enemies.js
      // (not running here) is what would normally bleed it off.
      if (whacks === 0) setup?.(fish);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: 6, y: 0 } }, { onWhack: () => { whacks++; } });
    }
    return fish.mesh.position.distanceTo(start);
  };
  check('a teed body is thrown further', flungFrom((e) => holdEnemy(e, 1)) > flungFrom(null) * 1.15,
    `${flungFrom(null).toFixed(2)}u loose vs ${flungFrom((e) => holdEnemy(e, 1)).toFixed(2)}u held`);

  // The switch really is the switch. Turned off, a held body is worth exactly
  // what a loose one is — which is what makes the numbers above attributable
  // to this rule rather than to a hold happening to change the geometry.
  const wasOn = CONFIG.club.teed.enabled;
  CONFIG.club.teed.enabled = false;
  const offHeld = clubbed((e) => holdEnemy(e, 5)).dealt;
  const offLoose = clubbed(null).dealt;
  CONFIG.club.teed.enabled = wasOn;
  check('no rule, no bonus', Math.abs(offHeld - offLoose) < offLoose * 0.15,
    `${offLoose.toFixed(1)} vs ${offHeld.toFixed(1)} with the rule off`);
}

// ------------------------------------------------------------------ Big Rigz

section('BIG RIGZ — the ring is a companion, the fins are only a little one');

{
  const { player } = await import('../path/src/entities/player.js');
  const saved = player.stats.companionScale;
  const drawn = (scale, levels, pick) => {
    player.stats.companionScale = scale;
    try {
      freshRun();
      const rig = rigWithFins(2);
      for (let i = 0; i < 20; i++) {
        rig.pose(i * dt * 6);
        updateClub(dt, scene, playerPos, levels, enemies, { rig, velocity: { x: 4, y: 0 } }, {});
      }
      const mesh = pick(clubGroup.children);
      const spin = mesh.rotation.z;
      mesh.rotation.z = 0;
      mesh.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
      mesh.rotation.z = spin;
      return Math.max(size.x, size.y, size.z);
    } finally { player.stats.companionScale = saved; }
  };

  // THE RING TAKES IT WHOLE. An orbiting club is a companion in everything but
  // the stat it was reading, and Big Rigz already promises the size is REAL —
  // mesh and hitbox together — so this has to move with the card.
  // Three clubs, so there is a ring at all — two picks fill the flippers and
  // the third is the first orbiter. {club 1, ice 1} is two clubs and no ring,
  // which measured the FIN club and quietly compared it against itself.
  const ringSmall = drawn(1, { club: 1, ice: 2 }, (kids) => kids[kids.length - 1]);
  const ringBig = drawn(1.5, { club: 1, ice: 2 }, (kids) => kids[kids.length - 1]);
  check('an orbiting club takes Big Rigz whole',
    Math.abs(ringBig - ringSmall * 1.5) < 0.25,
    `${ringSmall.toFixed(2)}u -> ${ringBig.toFixed(2)}u at x1.5`);

  // A FIN CLUB TAKES A SHARE. Some, or a bigger seal is holding the same
  // little stick; only some, because a fin club's reach IS the melee range of
  // the weapon and a companion-size card must not get to rewrite how close the
  // player has to be.
  const finSmall = drawn(1, { club: 1 }, (kids) => kids[0]);
  const finBig = drawn(1.5, { club: 1 }, (kids) => kids[0]);
  const share = CONFIG.club.bigRigShare;
  const wantFin = finSmall * (1 + 0.5 * share);
  check('...and a fin club only a share of it',
    finBig > finSmall * 1.02 && Math.abs(finBig - wantFin) < 0.2,
    `${finSmall.toFixed(2)}u -> ${finBig.toFixed(2)}u, want ${wantFin.toFixed(2)} at share ${share}`);
  check('...which is less than the ring got',
    (finBig / finSmall) < (ringBig / ringSmall),
    `fins x${(finBig / finSmall).toFixed(2)} vs ring x${(ringBig / ringSmall).toFixed(2)}`);
}

// ---------------------------------------------------------------- the Bouncer

section('BOUNCER — one card, every club in the run');

{
  const { player } = await import('../path/src/entities/player.js');
  const saved = { d: player.stats.clubDamageMul, k: player.stats.clubKnockMul, r: player.stats.clubReachMul };
  const withCard = (mul, fn) => {
    player.stats.clubDamageMul = mul.d ?? 1;
    player.stats.clubKnockMul = mul.k ?? 1;
    player.stats.clubReachMul = mul.r ?? 1;
    try { return fn(); } finally {
      player.stats.clubDamageMul = saved.d;
      player.stats.clubKnockMul = saved.k;
      player.stats.clubReachMul = saved.r;
    }
  };

  // THE SWING. Same seal, same fins, same fish — the only difference is the
  // card. Measured as damage dealt rather than as a number read back out of
  // the config, because a multiplier applied to the wrong variable still
  // multiplies correctly and changes nothing in the water.
  const swungFor = (mul) => withCard(mul, () => {
    freshRun();
    const fish = spawnAt('fish', 1.4, -20);
    fish.hp = 1e6;
    const rig = rigWithFins(2);
    for (let i = 0; i < 120; i++) {
      rig.pose(i * dt * 12);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies, { rig, velocity: { x: 6, y: 0 } }, {});
    }
    return 1e6 - fish.hp;
  });
  const plain = swungFor({});
  const buffed = swungFor({ d: 2 });
  check('the card doubles what a swing does', buffed > plain * 1.6,
    `${plain.toFixed(1)} -> ${buffed.toFixed(1)} damage`);

  // THE REACH, and the DRAWING with it — a card that lengthened the hitbox and
  // not the stick would be a club that hits from where it visibly is not.
  const reachOf = (mul) => withCard(mul, () => {
    freshRun();
    swing(0.05, { level: 1 });
    const mesh = clubGroup.children[0];
    const spin = mesh.rotation.z;
    mesh.rotation.z = 0;
    mesh.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    mesh.rotation.z = spin;
    return Math.max(size.x, size.y, size.z);
  });
  const short = reachOf({});
  const long = reachOf({ r: 1.5 });
  check('...and a longer club is drawn longer, not just felt longer',
    Math.abs(long - short * 1.5) < 0.3, `${short.toFixed(2)}u -> ${long.toFixed(2)}u at x1.5`);

  // THE THROWN ONE. "All club type weapons" is the card's whole claim, and the
  // Hurler is the one that leaves the file — its damage is baked into the
  // projectile at spawn, so a multiplier that never reached the bake would be
  // invisible until someone counted hit points in a real fight.
  const { projectiles } = await import('../path/src/entities/projectiles.js');
  const { fireClubThrow: hurl2 } = await import('../path/src/systems/club.js');
  const thrownFor = (mul) => withCard(mul, () => {
    freshRun();
    projectiles.length = 0;
    hurl2(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {});
    const d = projectiles[0]?.damage ?? 0;
    const k = projectiles[0]?.knockback ?? 0;
    projectiles.length = 0;
    return { d, k };
  });
  const bare = thrownFor({});
  const big = thrownFor({ d: 2, k: 2 });
  check('a thrown club is bought by the same card', big.d > bare.d * 1.6,
    `${bare.d.toFixed(1)} -> ${big.d.toFixed(1)} damage`);
  check('...and so is the shove it carries', big.k > bare.k * 1.6,
    `${bare.k.toFixed(2)} -> ${big.k.toFixed(2)}`);
}

// ------------------------------------------------------- one pick, one club

section('PICKS — one club per card, fins first, then the ring');

{
  const { clubAssetsFor, clubOrbiters, clubsForType, clubsInHand, clubsOrbiting } =
    await import('../path/src/systems/club.js');
  const { clubStackPerk, clubStackTotals } = await import('../path/src/config.js');

  // THE REAL STACK SEQUENCE, from a level of ZERO.
  //
  // `npm run test:upgrades` cannot make this claim and never will: its
  // synthetic base seeds every stat at 100, so replaying a club card there
  // rolls stacks 101-106 and reports on a part of the sequence no run reaches.
  // The numbers it snapshots are still a real regression guard; they are just
  // not the ones a player gets, and this is the only place that difference is
  // visible.
  const guaranteed = CONFIG.clubStacks.guaranteed;
  for (const key of ['club', 'boom', 'ice', 'throw']) {
    const opening = [];
    for (let n = 1; n <= guaranteed; n++) opening.push(clubStackPerk(key, n));
    check(`${key}: the opening ${guaranteed} picks are always a club`,
      opening.every((p) => p === 'amount'), opening.join(' '));
  }
  // ...AND ANY TWO PICKS FILL THE FLIPPERS, which is the point of the
  // guarantee: two of one card, or one each of two, both arm the seal.
  check('two of one card arms both fins', clubStackTotals('club', 2).clubs === 2,
    `${clubStackTotals('club', 2).clubs} club(s)`);
  check('...and so does one each of two', clubsForType('club', 1).clubs + clubsForType('ice', 1).clubs === 2,
    'club 1 + ice 1');

  // THE ROLL IS DETERMINISTIC. This is the one that matters most: apply() is
  // replayed from scratch on every recompute, so a real random here would hand
  // the player a different build every time they levelled and the card's
  // measured text would describe a different pick each time it was read.
  const once = ['club', 'boom', 'ice', 'throw'].map((k) => clubStackTotals(k, 6).clubs).join();
  const twice = ['club', 'boom', 'ice', 'throw'].map((k) => clubStackTotals(k, 6).clubs).join();
  check('the stack roll is the same answer every time it is asked', once === twice, once);
  // ...and it is not the same answer for everyone. A wheel that landed on
  // `amount` for every type at every stack is deterministic and useless.
  const faces = new Set();
  for (const k of ['club', 'boom', 'ice', 'throw']) {
    for (let n = 1; n <= 6; n++) faces.add(clubStackPerk(k, n));
  }
  check('...and it really does roll all three faces', faces.size === 3,
    [...faces].join(' '));

  // ONE PICK, ONE CLUB, AND THE FIRST TWO ARE THE ONES YOU HOLD — in the order
  // the run took them, which is a fact about its history and not about the
  // level table. Two runs holding {club 1, ice 1} took them in some order, and
  // a fixed priority list would arm both the same way.
  freshRun();
  const rig = rigWithFins(2);
  swing(0.2, { level: 1, rig, velocity: { x: 9, y: 0 } });                 // Driftwood first
  check('one card, one club, one empty fin', clubsInHand() === 1 && clubsOrbiting() === 0,
    `${clubsInHand()} held, ${clubsOrbiting()} orbiting`);
  swing(0.2, { level: 1, ice: 1, rig, velocity: { x: 9, y: 0 } });         // then Cold Snap
  check('...the second pick fills the other fin',
    clubAssetsFor({ club: 1, ice: 1 }).join() === 'club,clubIce',
    clubAssetsFor({ club: 1, ice: 1 }).join());
  check('...and nothing is orbiting yet', clubsOrbiting() === 0,
    `${clubsOrbiting()} orbiting`);
  swing(0.2, { level: 1, ice: 2, rig, velocity: { x: 9, y: 0 } });         // and a third
  check('...the THIRD pick starts the ring',
    clubOrbiters({ club: 1, ice: 2 }).join() === 'clubIce',
    clubOrbiters({ club: 1, ice: 2 }).join() || 'empty');

  // Taking them the other way round has to arm the seal the other way round,
  // or the order is decoration.
  freshRun();
  const rig2 = rigWithFins(2);
  swing(0.2, { level: 0, ice: 1, rig: rig2, velocity: { x: 9, y: 0 } });   // Cold Snap first
  swing(0.2, { level: 1, ice: 1, rig: rig2, velocity: { x: 9, y: 0 } });   // then Driftwood
  check('the order really is the run\'s own history',
    clubAssetsFor({ club: 1, ice: 1 }).join() === 'clubIce,club',
    clubAssetsFor({ club: 1, ice: 1 }).join());

  // STACKS ADD CLUBS UNTIL THE ROLL SAYS OTHERWISE, and the count in the water
  // has to be the count the roll table says. Asserted against clubsForType
  // rather than against hand-typed numbers — the wheel is tunable, and a test
  // holding a copy of its output would fail the day somebody reorders it.
  for (const stacks of [1, 2, 4, 6]) {
    freshRun();
    swing(0.3, { level: 1, ice: stacks, rig: rigWithFins(2), velocity: { x: 9, y: 0 } });
    const want = clubsForType('club', 1).clubs + clubsForType('ice', stacks).clubs;
    check(`ice x${stacks}: the water holds what the roll table says`,
      clubsInHand() + clubsOrbiting() === want,
      `${clubsInHand()} + ${clubsOrbiting()} = ${clubsInHand() + clubsOrbiting()}, want ${want}`);
  }

  // ...and the fins are always full before the ring is used. The rule is
  // "fins first"; a ring club while a flipper is empty is the bug.
  freshRun();
  swing(0.3, { level: 1, ice: 4, rig: rigWithFins(2), velocity: { x: 9, y: 0 } });
  check('the flippers fill before the ring does',
    clubsInHand() === 2 && clubsOrbiting() > 0,
    `${clubsInHand()} held, ${clubsOrbiting()} orbiting`);

  // A SIZE OR DAMAGE ROLL IS NOT A CLUB. The whole reason the wheel exists is
  // that four types stacking six deep would otherwise be twenty-odd clubs.
  const sixDeep = ['club', 'boom', 'ice', 'throw']
    .reduce((n, k) => n + clubStackTotals(k, 6).clubs, 0);
  check('a fully stacked club run is not a wall of wood', sixDeep < 24 && sixDeep > 8,
    `${sixDeep} clubs at 6 stacks of all four types, vs 24 if every pick added one`);
}

// ------------------------------------------------------------------- the ring

section('THE RING — everything past the second club orbits you');

{
  const { clubOrbiters, clubsInHand, clubsOrbiting } = await import('../path/src/systems/club.js');

  // ...AND THEY ACTUALLY GO ROUND. Measured off the meshes over time rather
  // than trusted from the config: a ring whose clubs are built and then parked
  // on top of the player passes every count above and is not an orbit.
  freshRun();
  const rig3 = rigWithFins(2);
  const at = [];
  for (let i = 0; i < 240; i++) {
    rig3.pose(i * dt * 6);
    updateClub(dt, scene, playerPos, { club: 1, ice: 2 }, enemies,
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
  swing(0.3, { level: 1, ice: 4, throwLevel: 1, rig: rig4, velocity: { x: 9, y: 0 } });
  const heldBefore = clubsInHand();
  const ringBefore = clubsOrbiting();
  const { fireClubThrow, clubsThrowable } = await import('../path/src/systems/club.js');
  fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {});
  // The Cold Snap in the second fin goes; the driftwood in the first stays.
  check('a throw empties the fins it is allowed to',
    clubsThrowable() === 0 && clubsInHand() === 1, `${heldBefore} -> ${clubsInHand()} held`);
  check('...and leaves the ring alone', clubsOrbiting() === ringBefore,
    `${ringBefore} -> ${clubsOrbiting()} orbiting`);

  // ...UNLESS THE CHARGE WAS PERFECT, which is the exception the whole ring
  // now hangs off. Checked against clubsRingArmed() and not clubsOrbiting():
  // the SOCKETS stay (the ring's spacing is built off them, so it must not
  // close up while a club is in the air) and what empties is what is in them.
  {
    const { clubsRingArmed } = await import('../path/src/systems/club.js');
    freshRun();
    const rigP = rigWithFins(2);
    swing(0.3, { level: 1, ice: 4, throwLevel: 1, rig: rigP, velocity: { x: 9, y: 0 } });
    const ringArmed = clubsRingArmed();
    const sockets = clubsOrbiting();
    check('the ring has clubs to give', ringArmed > 0, `${ringArmed} armed of ${sockets} socket(s)`);

    const plain = fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {}, {});
    check('an ordinary release still leaves them there', clubsRingArmed() === ringArmed,
      `${ringArmed} -> ${clubsRingArmed()} armed`);

    freshRun();
    const rigQ = rigWithFins(2);
    swing(0.3, { level: 1, ice: 4, throwLevel: 1, rig: rigQ, velocity: { x: 9, y: 0 } });
    const armed2 = clubsRingArmed();
    const perfect = fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {},
      { perfect: true });
    check('a PERFECT release hurls the ring', clubsRingArmed() === 0,
      `${armed2} -> ${clubsRingArmed()} armed`);
    check('...without collapsing the ring\'s spacing', clubsOrbiting() === sockets,
      `${sockets} socket(s) still on the ring`);
    check('...and every one of them is a club in the water',
      perfect === plain + armed2, `${plain} ordinary + ${armed2} ring = ${perfect} thrown`);

    // AND IT IS SPENT. The Hurler's own cost gate already refuses a second
    // release while a fin is waiting on its club, so a perfect one inside the
    // window throws nothing at all — the ring cannot be re-thrown before it
    // comes back, which is what stops a perfect charge being free.
    const again = fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {},
      { perfect: true });
    check('a second perfect release inside the window is refused outright', again === 0,
      `${again} thrown while the sockets recover`);

    // ...and it comes back, on the same clock a fin club does.
    for (let i = 0; i < Math.ceil((CONFIG.club.respawnTime + 0.1) / dt); i++) {
      updateClub(dt, scene, playerPos, { club: 1, ice: 4, throw: 1 }, enemies,
        { rig: rigQ, velocity: { x: 0, y: 0 } }, {});
    }
    check('the ring refills after the cooldown', clubsRingArmed() === armed2,
      `${clubsRingArmed()} of ${armed2} back after ${CONFIG.club.respawnTime}s`);
  }

  // --- Clone Warz and Entourage --------------------------------------------
  //
  // Both add to the ring, and both are spent ONCE for the whole ring rather
  // than once per type on it — two types orbiting is still one thing the
  // player is looking at, and paying per type would make a card that reads
  // "+1" worth +2 or +3 depending on a detail nothing on screen explains.
  const ringOf = (levels, bonus) => clubOrbiters(levels, bonus).length;
  const plain = ringOf({ club: 1, ice: 4 }, 0);
  check('Clone Warz adds a club to the ring', ringOf({ club: 1, ice: 4 }, 2) === plain + 2,
    `${plain} -> ${ringOf({ club: 1, ice: 4 }, 2)} at +2`);
  const twoTypes = ringOf({ club: 1, ice: 3, boom: 2 }, 0);
  check('...once for the whole ring, not once per type',
    ringOf({ club: 1, ice: 3, boom: 2 }, 2) === twoTypes + 2,
    `${twoTypes} -> ${ringOf({ club: 1, ice: 3, boom: 2 }, 2)} at +2`);
  // ...and nothing at all when there is no ring to add to. `+1 of nothing is
  // nothing` is orbiterCount's own rule and this is where it has to hold.
  check('...and adds nothing to a run with no ring', ringOf({ club: 2 }, 3) === 0,
    `${ringOf({ club: 2 }, 3)} orbiting`);
  // The extras walk the ring's types in turn, so a mixed ring gets one more of
  // each rather than several more of whichever happened to be first.
  const mixed = clubOrbiters({ club: 1, ice: 3, boom: 2 }, 2);
  check('...and the extras are spread across the types',
    new Set(mixed).size > 1, mixed.join(' + '));
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
  //
  // MEASURED ON ONE HIT, and it has to be. knockX/knockY is a VECTOR, and a
  // club sweeping round at speed lands its shoves pointing in every direction
  // — so summing a second and a half of them measures how well they CANCEL,
  // which runs backwards to the claim: a fast swing scored lower than a drift
  // purely because its shoves opposed each other. Stopped at the first whack,
  // the number is one swing's shove, which is what the sentence says.
  const at = (spin) => {
    freshRun();
    const boss = spawnAt('shark', 1.6, -20);
    boss.isBoss = true;
    boss.hp = 1e6;
    const rig = rigWithFins(2);
    let whacks = 0;
    for (let i = 0; i < Math.round(1.2 / dt); i++) {
      rig.pose(i * dt * spin);
      updateClub(dt, scene, playerPos, { club: 3 }, enemies,
        { rig, velocity: { x: 9, y: 0 } }, { onWhack: () => { whacks++; } });
      // The shove is applied inside the same call the whack was reported from,
      // so the frame the counter moves is the frame it has landed on.
      if (whacks > 0) break;
    }
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

// ------------------------------------------------------------------- the twirl

section('THE TWIRL — what the club the Hurler leaves behind does with a strike');

// The other half of CONFIG.clubThrow.neverThrown. The basic club stays in the
// fin through a strike, so it needs something to DO with the strike, or the
// base card is the one club in the game with no reaction to the biggest thing
// the player does.
//
// Measured as angular velocity, because that is what the weapon actually runs
// on: every hit is scaled by the club's own measured spin (see `power` in
// updateClub), so "it twirls" and "it hits harder" are the same claim about
// one number rather than two features.
{
  // The fastest a fin club reached over the window, which is the honest read
  // for a spin-up: the twirl ramps in over about a tenth of a second and a
  // sample at one instant would be measuring the ramp rather than the peak.
  const peakSwing = ({ dashing, levels = { level: 1 }, finSpin = 4, seconds = 0.6 }) => {
    freshRun();
    const rig = rigWithFins(2);
    swing(0.4, { ...levels, rig, finSpin, speed: CONFIG.player.maxSpeed });
    let peak = 0;
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i++) {
      rig.pose(0.4 * finSpin + i * dt * finSpin);
      updateClub(dt, scene, playerPos, {
        club: levels.level ?? 0, boom: levels.boom ?? 0, ice: levels.ice ?? 0, throw: levels.throwLevel ?? 0,
      }, enemies, {
        rig, velocity: { x: CONFIG.player.maxSpeed, y: 0 }, dashing,
      }, {});
      peak = Math.max(peak, clubSwingSpeed());
    }
    return peak;
  };

  const cruising = peakSwing({ dashing: false });
  const striking = peakSwing({ dashing: true });
  check('a strike spins the driftwood club up', striking > cruising * 1.5,
    `${cruising.toFixed(1)} rad/s cruising vs ${striking.toFixed(1)} striking`);

  // NOT AN ARBITRARY NUMBER. The twirl has to clear three thresholds or it is
  // a cosmetic spin: `powerReference` x `powerMax` is where a hit stops getting
  // stronger, `shock.fullSwing` is where a shockwave stops being graded down,
  // and `maxSwing` is the ceiling that would silently own this value.
  const c = CONFIG.club;
  check('...past the point where its hits stop getting weaker',
    striking >= c.powerReference * c.powerMax,
    `${striking.toFixed(1)} rad/s against ${(c.powerReference * c.powerMax).toFixed(1)}`);
  check('...and past a full-grade shockwave',
    striking >= c.shock.fullSwing,
    `${striking.toFixed(1)} rad/s against ${c.shock.fullSwing}`);
  check('...but under the swing ceiling, which would own the number instead',
    c.twirl.spin < c.maxSwing, `twirl ${c.twirl.spin} vs maxSwing ${c.maxSwing}`);

  // ...and it is over when the dash is. The wind-down is the weapon's ordinary
  // damping rather than a second timer, so what this really checks is that
  // nothing latched.
  {
    freshRun();
    const rig = rigWithFins(2);
    swing(0.4, { level: 1, rig, finSpin: 4, speed: CONFIG.player.maxSpeed });
    for (let i = 0; i < 30; i++) {
      rig.pose(i * dt * 4);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: CONFIG.player.maxSpeed, y: 0 }, dashing: true }, {});
    }
    const atRelease = clubSwingSpeed();
    for (let i = 0; i < 40; i++) {
      rig.pose(30 * dt * 4 + i * dt * 4);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: CONFIG.player.maxSpeed, y: 0 }, dashing: false }, {});
    }
    check('...and it winds down when the dash ends', clubSwingSpeed() < atRelease * 0.6,
      `${atRelease.toFixed(1)} rad/s at the end of the dash, ${clubSwingSpeed().toFixed(1)} two thirds of a second later`);
  }

  // AND IT HITS HARDER FOR IT, which is the whole reason the twirl is worth
  // having rather than being decoration. Same fish, same fins, same seconds —
  // the only difference is whether a dash is live.
  const chewed = (dashing) => {
    freshRun();
    const rig = rigWithFins(2);
    const fish = spawnAt('fish', playerPos.x + 1.3, playerPos.y);
    fish.hp = 1e6; // so it survives the window and the number is the damage
    const start = fish.hp;
    const frames = Math.round(0.8 / dt);
    for (let i = 0; i < frames; i++) {
      rig.pose(i * dt * 4);
      updateClub(dt, scene, playerPos, { club: 1 }, enemies,
        { rig, velocity: { x: CONFIG.player.maxSpeed, y: 0 }, dashing }, {});
    }
    return start - fish.hp;
  };
  const calm = chewed(false);
  const spun = chewed(true);
  check('a twirling club chews harder than a carried one', spun > calm,
    `${calm.toFixed(1)} hp cruising vs ${spun.toFixed(1)} striking`);

  // THE EXEMPTIONS, and both are the same line the shockwave is drawn on.
  {
    // An orbiter performs nothing the player did, so a dash must not spin it —
    // its rate is the ring's and reading a strike into it would make the ring a
    // second damage spike nobody swung.
    freshRun();
    const rig = rigWithFins(2);
    const ringSpeed = (dashing) => {
      freshRun();
      swing(0.6, { level: 4, rig, finSpin: 4, speed: CONFIG.player.maxSpeed, dashing });
      // The orbiters are everything past the two fin sockets.
      const movers = clubTrailMovers();
      return Math.max(0, ...movers.map((m) => m.speed));
    };
    const ringCalm = ringSpeed(false);
    const ringDash = ringSpeed(true);
    check('the ring is not twirled by a strike',
      Math.abs(ringDash - ringCalm) < Math.max(1, ringCalm * 0.35),
      `${ringCalm.toFixed(1)}u/s cruising vs ${ringDash.toFixed(1)} striking`);
  }
  {
    // ...and neither is a socket that just gave its club away. Nothing to spin.
    const { clubsThrowable, fireClubThrow } = await import('../path/src/systems/club.js');
    const { resetProjectiles } = await import('../path/src/entities/projectiles.js');
    freshRun();
    const rig = rigWithFins(2);
    swing(0.3, { level: 1, ice: 1, rig, finSpin: 4, speed: CONFIG.player.maxSpeed });
    resetProjectiles(scene);
    fireClubThrow(scene, 1, 1, 1, { x: 20, y: 0 }, () => playerPos.clone(), {}, {});
    swing(0.5, { level: 1, ice: 1, rig, finSpin: 4, speed: CONFIG.player.maxSpeed, dashing: true });
    check('an emptied fin has nothing to twirl', clubsThrowable() === 0,
      'the socket is still recovering, and a socket with no club in it swings nothing');
    resetProjectiles(scene);
  }
}

// ------------------------------------------------------------------- the juice

section('THE JUICE — what a club is made of, and how much of it');

// The caps, read from config rather than typed here — they are the numbers a
// tuner drags, and a test that hard-coded them would fail the moment somebody
// tuned the thing it exists to protect.
const fxCeiling = (key) => CONFIG.club.fx?.[key] ?? Infinity;

// Everything here is a claim about FEEDBACK, and none of it is a claim about
// how it LOOKS. That half is a controller in your hands, the same way the swing
// is. What can be failed over is the plumbing under it, and the plumbing is the
// part that has silently broken before: an accent keyed on an asset that no
// longer exists, a growth term that stops growing, a ribbon anchored at the
// grip so it scribbles round the orbit point instead of trailing the head.
//
// systems/club.js fills one shared record the instant before it calls a hook
// (clubHitFx) and main.js reads it back, so a hook here can snapshot exactly
// what the game would have drawn.
{
  const fxCfg = CONFIG.club.fx;
  const accent = fxCfg?.accent ?? {};

  // The two tables that can go stale without anything throwing: an accent
  // naming an emitter that was renamed fires nothing at all (feedback() warns
  // to a console nobody is reading), and a club type with no trail preset is a
  // club that silently orbits with no ribbon.
  const missingEmitters = Object.entries(accent)
    .filter(([, name]) => !CONFIG.emitters[name])
    .map(([asset, name]) => `${asset} -> ${name}`);
  check('every club substance names a real emitter', missingEmitters.length === 0,
    missingEmitters.length ? missingEmitters.join(', ') : `${Object.keys(accent).length} club assets`);

  const noTrail = Object.keys(accent).filter((asset) => !CONFIG.trails[asset]);
  check('...and every club type has a ribbon to trail', noTrail.length === 0,
    noTrail.length ? noTrail.join(', ') : Object.keys(accent).join(', '));

  // Every one of those trails sheds a substance too, and it has to be the same
  // FAMILY as the one the club hits with — a Cold Snap trailing embers is the
  // ribbon and the impact disagreeing about what one object is made of.
  //
  // The same family, NOT the same emitter, and the difference is the whole
  // reason this is a colour test rather than a string comparison. A wake and an
  // impact are two different bursts on purpose: a trail's `perSecond` fires the
  // emitter's whole count each time, so shedding the impact burst put four
  // hundred sprites a second into the water off a five-club ring and the fight
  // frame came back as confetti. What has to hold across the pair is the
  // colour, and nothing else.
  //
  // Compared as a NORMALISED palette average — the hue rather than how bright
  // it was authored, since a wake at glow 1.6 and an impact at 2.6 are the same
  // colour at two intensities.
  const paletteHue = (name) => {
    const cols = CONFIG.emitters[name]?.colors ?? [];
    if (!cols.length) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of cols) {
      r += ((c >> 16) & 255) / 255;
      g += ((c >> 8) & 255) / 255;
      b += (c & 255) / 255;
    }
    const peak = Math.max(r, g, b, 1e-6);
    return [r / peak, g / peak, b / peak];
  };
  const strayed = Object.entries(accent).map(([asset, name]) => {
    const shed = CONFIG.trails[asset]?.particles?.emitter;
    if (!shed) return null;
    const hit = paletteHue(name);
    const wake = paletteHue(shed);
    if (!hit || !wake) return `${asset}: ${shed} has no palette`;
    const d = Math.abs(hit[0] - wake[0]) + Math.abs(hit[1] - wake[1]) + Math.abs(hit[2] - wake[2]);
    return d > 0.25 ? `${asset}: ${name} vs ${shed} ${d.toFixed(2)} apart` : null;
  }).filter(Boolean);
  check('...and sheds the same colour it hits with', strayed.length === 0,
    strayed.join(' · ') || Object.keys(accent)
      .map((asset) => CONFIG.trails[asset]?.particles?.emitter).join(', '));
}

// WHICH CLUB DID IT. The whole point of the accent: four kinds of club can be
// swinging and orbiting at once, and the burst is the only channel that says
// which one landed the blow you just felt.
{
  const seen = (levels) => {
    freshRun();
    const fish = spawnAt('fish', playerPos.x + 1.2, playerPos.y);
    const assets = new Set();
    swing(1.5, {
      ...levels,
      finSpin: 12,
      speed: CONFIG.player.maxSpeed,
      hooks: { onWhack: () => assets.add(clubHitFx().asset) },
    });
    void fish;
    return assets;
  };

  const ice = seen({ level: 0, ice: 1 });
  check('a Cold Snap club reports itself as one', ice.has('clubIce'),
    [...ice].join(', ') || 'nothing connected');

  const boom = seen({ level: 0, boom: 1 });
  check('...and a Boom Boom Club as one', boom.has('clubBoom'),
    [...boom].join(', ') || 'nothing connected');

  const plain = seen({ level: 1 });
  check('...and a plain club is driftwood', plain.has('club'),
    [...plain].join(', ') || 'nothing connected');
}

// HOW MUCH. Three growth claims, and each one is a separate question — see
// CONFIG.club.fx. Asserted as MULTIPLES rather than as "more", because a
// growth term that has come unhooked still drifts up a hair with the swing and
// "more than before" would pass on that alone.
{
  const amountAt = (stacks) => {
    freshRun();
    spawnAt('fish', playerPos.x + 1.2, playerPos.y);
    let peak = 0;
    swing(1.5, {
      level: stacks,
      finSpin: 12,
      speed: CONFIG.player.maxSpeed,
      hooks: { onWhack: () => { peak = Math.max(peak, clubHitFx().amount); } },
    });
    return peak;
  };

  const one = amountAt(1);
  const six = amountAt(6);
  check('a deeper stack throws more of it', six > one * 1.5,
    `${one.toFixed(2)}x at one stack, ${six.toFixed(2)}x at six`);
  check('...and never past the ceiling', six <= fxCeiling('maxAmount') + 1e-6,
    `${six.toFixed(2)}x against a cap of ${fxCeiling('maxAmount')}`);

  // And the swing still matters at every stack, which is the rule the whole
  // weapon runs on: a six-stack club drifting into a fish is still a drift.
  const lazy = (() => {
    freshRun();
    spawnAt('fish', playerPos.x + 1.2, playerPos.y);
    let low = Infinity;
    swing(2.5, {
      level: 6,
      finSpin: 0.8,
      speed: 0,
      hooks: { onWhack: () => { low = Math.min(low, clubHitFx().amount); } },
    });
    return low;
  })();
  check('...and a lazy swing still throws less than a whip',
    Number.isFinite(lazy) && lazy < six,
    `${lazy === Infinity ? 'no hit' : lazy.toFixed(2)}x at a drift vs ${six.toFixed(2)}x at a whip`);
  check('...but a connecting club always throws SOMETHING',
    !Number.isFinite(lazy) || lazy > 0,
    'a hit with no particles reads as a miss, not as a weak hit');
}

// SIZE follows the club's DRAWN size, which is what folds Big Rigz, the ring's
// smaller orbiters and reach-per-level into one number. Measured through the
// stat block, because that is how the card actually arrives.
{
  const sizeWith = (companionScale) => {
    const saved = player.stats;
    player.stats = { ...saved, companionScale };
    freshRun();
    spawnAt('fish', playerPos.x + 1.2, playerPos.y);
    let peak = 0;
    swing(1.5, {
      level: 4,
      finSpin: 12,
      speed: CONFIG.player.maxSpeed,
      hooks: { onWhack: () => { peak = Math.max(peak, clubHitFx().size); } },
    });
    player.stats = saved;
    return peak;
  };
  const small = sizeWith(1);
  const big = sizeWith(2);
  check('a bigger stick sheds bigger splinters', big > small,
    `${small.toFixed(2)}x at Big Rigz 1, ${big.toFixed(2)}x at 2`);
  check('...within the ceiling', big <= fxCeiling('maxSize') + 1e-6,
    `${big.toFixed(2)}x against a cap of ${fxCeiling('maxSize')}`);
}

// THE DIRECTION. `clubChips` has a cone, and emit() reads a missing direction
// as due east — so a burst handed (0, 0) fires every splinter to the right of
// the screen forever. There is no assertion that would catch that by looking
// at the picture; there is one here.
{
  freshRun();
  spawnAt('fish', playerPos.x + 1.2, playerPos.y);
  let flat = 0;
  let total = 0;
  const watch = () => {
    const fx = clubHitFx();
    total++;
    if (Math.hypot(fx.dirX, fx.dirY) < 1e-6) flat++;
  };
  swing(2, {
    level: 2, boom: 1, finSpin: 12, speed: CONFIG.player.maxSpeed,
    hooks: { onWhack: watch, onShock: watch, onBlast: watch, onRicochet: watch },
  });
  check('every club event points somewhere', total > 0 && flat === 0,
    `${total - flat} of ${total} events carried a heading`);
}

// A CAROM CARRIES THE BLOW THAT THREW IT. The one club event that cannot read
// its numbers off a club still in front of it — the swing happened frames ago
// and the club that made it may since have been thrown or swapped.
{
  freshRun();
  spawnAt('shark', playerPos.x + 1.4, playerPos.y);
  for (let i = 0; i < 8; i++) spawnAt('fish', playerPos.x + 5 + i * 1.2, playerPos.y + 0.2);
  const caromed = [];
  swing(3, {
    level: 0, ice: 3, finSpin: 14, speed: CONFIG.player.maxSpeed,
    hooks: { onRicochet: () => caromed.push({ ...clubHitFx() }) },
  });
  check('a carom is made of the club that launched it', caromed.length > 0
    && caromed.every((fx) => fx.asset === 'clubIce'),
    `${caromed.length} carom(s), ${new Set(caromed.map((f) => f.asset)).size} substance(s)`);
  check('...and carries that swing\'s size with it, not a default',
    caromed.length > 0 && caromed.every((fx) => fx.amount > 0),
    caromed.length ? `${caromed[0].amount.toFixed(2)}x` : 'no carom');
}

// ------------------------------------------------------------------ the ribbon

section('THE RIBBON — the clubs you are not holding');

{
  freshRun();
  // Two in the fins and three on the ring: five club picks, and the layout
  // rule is that the first two go in the flippers.
  swing(1, { level: 3, ice: 2, finSpin: 8, speed: CONFIG.player.maxSpeed });
  const movers = clubTrailMovers();
  const orbiting = clubsOrbiting();
  check('every club on the ring gets an anchor', orbiting > 0 && movers.length === orbiting,
    `${movers.length} anchor(s) for ${orbiting} orbiter(s)`);
  const held = clubsInHand();
  check('...and the clubs in the fins get none', held > 0 && movers.length === orbiting,
    `${held} in the fins, ${movers.length} anchors — a ribbon off a fin club is a ribbon off the seal`);

  // NAMED AFTER THE ASSET, because that is what CONFIG.trails is keyed on —
  // an anchor with the wrong name resolves no preset and draws nothing at all,
  // silently.
  const named = movers.filter((m) => CONFIG.trails[m.mesh.name]);
  check('...each naming a preset that exists', movers.length > 0 && named.length === movers.length,
    [...new Set(movers.map((m) => m.mesh.name))].join(', '));

  // ANCHORED AT THE HEAD. The grip is the end that barely moves, so a ribbon
  // hung off the mesh origin draws a tight scribble around the orbit point
  // instead of a trail. The head is further out than the grip, by roughly the
  // shaft — which is exactly the thing to measure.
  const gripGap = movers.map((m) => Math.min(...clubGroup.children.map(
    (club) => Math.hypot(club.position.x - m.mesh.position.x, club.position.y - m.mesh.position.y),
  )));
  const outboard = gripGap.filter((d) => d > 0.2).length;
  check('...hung off the head rather than the handle',
    movers.length > 0 && outboard === movers.length,
    `nearest club origin is ${Math.min(...gripGap).toFixed(2)}u away at the closest`);

  // And it is MOVING, which is what a ribbon is drawn through. Differenced
  // rather than taken from the ring's own numbers, because the head's travel
  // is the orbit plus the spring lag plus the tumble.
  const moving = movers.filter((m) => m.speed > 0.5);
  check('...and travelling, so there is a trail to draw',
    moving.length === movers.length && movers.length > 0,
    `${moving.length} of ${movers.length} moving, fastest ${Math.max(0, ...movers.map((m) => m.speed)).toFixed(1)}u/s`);

  // The growth, one step down from the bursts' — see CONFIG.club.fx.trailShare.
  const widest = Math.max(0, ...movers.map((m) => m.trailScale));
  check('...at a width the run\'s cards have bought',
    widest >= 1 && widest <= fxCeiling('maxTrail') + 1e-6,
    `${widest.toFixed(2)}x against a cap of ${fxCeiling('maxTrail')}`);
}

{
  // A ring that is taken away leaves no anchors behind. The trail system keys
  // its ribbons on these objects, so a stale list is a ribbon hanging in the
  // water behind a club that is not there.
  freshRun();
  swing(1, { level: 4, finSpin: 8, speed: CONFIG.player.maxSpeed });
  const had = clubTrailMovers().length;
  resetClub();
  check('a reset takes the ribbons with it', had > 0 && clubTrailMovers().length === 0,
    `${had} anchor(s) -> 0`);
}

{
  // THE THROWN CLUB gets its ribbon through the projectile itself, since by
  // the time it is in the air it is an ordinary shot. `trailScale` is what
  // carries the Hurler's stacks onto it — and onto the debris it sheds when it
  // lands, which reads the same number (see main.js).
  const { projectiles } = await import('../path/src/entities/projectiles.js');
  const { fireClubThrow } = await import('../path/src/systems/club.js');
  const throwAt = (throwLevel) => {
    freshRun();
    projectiles.length = 0;
    swing(0.5, { level: 1, throwLevel, finSpin: 8, speed: CONFIG.player.maxSpeed });
    fireClubThrow(scene, 1, throwLevel, 1, { x: 20, y: 0 },
      () => new THREE.Vector3(playerPos.x, playerPos.y, 0), {}, {});
    const thrown = projectiles.filter((b) => b.source === 'clubThrow');
    const scale = Math.max(0, ...thrown.map((b) => b.trailScale ?? 0));
    projectiles.length = 0;
    return scale;
  };
  const one = throwAt(1);
  const five = throwAt(5);
  check('a thrown club trails a ribbon at all', one > 0, `${one.toFixed(2)}x at one stack`);
  check('...that thickens with the Hurler\'s stacks', five > one,
    `${one.toFixed(2)}x at one, ${five.toFixed(2)}x at five`);
}

// --------------------------------------------------------- and main.js wires it

section('THE WIRING — no club event ships without its substance');

// A SOURCE SCAN, and it earns its place: everything above proves the club
// REPORTS what it is made of, and none of it proves anybody listens. The six
// hooks live in main.js, which needs a browser and cannot be imported here, so
// the only thing that can be checked from Node is that each handler actually
// reaches the one helper. Cheap, and it is exactly the regression that would
// otherwise ship — a seventh club event added next to six that all look done.
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../path/src/main.js', import.meta.url), 'utf8');
  // SCOPED TO THE CLUB'S OWN HOOK BLOCK, and that is not fussiness: `onBlast`
  // and `onFreeze` are both names the oyster and the elements use too, and a
  // whole-file search finds theirs first and reports the club's as wired when
  // it is not. The block starts at the updateClub call and is generously
  // bounded — crude on purpose, since a parser here would be a bigger thing to
  // keep right than the claim it is protecting.
  // Bounded at the next system's update rather than by a character count: the
  // club's hooks run to about six thousand characters of comment and a fixed
  // window that fitted them yesterday silently drops the last one tomorrow.
  const from = src.indexOf('updateClub(dt,');
  const to = src.indexOf('updateOctoGrab(', from);
  const block = src.slice(from, to > from ? to : from + 12000);
  const wired = ['onWhack', 'onRicochet', 'onBlast', 'onShock', 'onFreeze'].filter((hook) => {
    const at = block.indexOf(`${hook}: (`);
    if (at < 0) return false;
    return /clubAccent\(/.test(block.slice(at, at + 1600));
  });
  check('every club hook fires an accent', wired.length === 5, `${wired.join(', ') || 'none'}`);

  // ...and the thrown club, which does not come through those hooks at all —
  // it is an ordinary projectile by the time it lands, resolved in combat.js.
  check('...and so does a thrown club landing',
    /CONFIG\.club\.fx\?\.accent\?\.\[projectile\?\.mesh\?\.name\]/.test(src),
    'the impact reads the same table the hooks do');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
