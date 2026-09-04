#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:levelupseal
//
// The seal that swims up under the upgrade cards (systems/levelUpSeal.js), on
// the real furseal.glb, with no renderer and no DOM: the puppet half of that
// file is handed a frame in CSS pixels and asked where it put the animal.
//
// WHAT IT GUARDS:
//
//   THE STILL SEAL     it never comes up, or comes up and sits there after the
//                      pick — a menu with a second animal parked under it.
//   THE POP            it appears at the crown line instead of rising to it,
//                      or vanishes from the row instead of leaving over the
//                      top. Both are one wrong sign in the from/to.
//   THE BLIND SEAL     the head does not turn toward the card being pointed
//                      at. bustAim is handed a world point, and this world is
//                      pixels with y flipped — a target on the right must
//                      swing the aim right.
//   THE STIFF TAIL     the pin lands whole on the frame the rise ends, rather
//                      than blending in. splashBust's apply(weight) is the
//                      one thing added to that file for this, and it is
//                      checked directly.
//   THE LOST HAND      a second card in the same batch re-enters while the
//                      seal is still leaving. It must finish leaving and come
//                      back from below, not reverse mid-screen.
//   OFF IS OFF         the toggle, read live.
//
// NOTE the load order: dom-stub FIRST, then the game modules — see the
// harness recipe. The eyes are left off (their halo is a canvas texture and
// the stub has no 2D context).
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createBustPin } from '../path/src/systems/splashBust.js';
import { createLevelUpPuppet, levelUpSealEnabled } from '../path/src/systems/levelUpSeal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');
const DT = 1 / 60;

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the seal has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const CFG = CONFIG.levelUpSeal;
CFG.enabled = true;
// Pinned for the arithmetic below, so a retune of the defaults moves the
// game and not this file's expectations.
CFG.height = 0.34;
CFG.gap = 28;
CFG.minVisible = 0.45;
CFG.delay = 0.1;
CFG.inTime = 0.75;
CFG.outTime = 0.45;
CFG.aimSpread = 0.7;
CFG.aimLerp = 7;
CFG.pinLerp = 6;
CFG.faceOut = 0;
CFG.swimRig = true;
CFG.plantAt = 0.6;
CFG.fin = 'near';
CFG.finIdle = 0;
CFG.spin = true;
CFG.spinTurns = 2;
CFG.spinTime = 1;
CFG.spinEase = 'inOutCubic';

const FRAME = { w: 1280, h: 720, crownLine: 480, centreX: 640, idle: { x: 640, y: 320 } };
const bustPx = () => CFG.height * FRAME.h;

function build() {
  const p = createLevelUpPuppet(createVisual('ship'), { eyes: false });
  p.setFrame(FRAME);
  return p;
}
function run(p, seconds) {
  for (let t = 0; t < seconds - 1e-9; t += DT) p.update(DT);
}
const mouthX = (p) => p.rig?.anchors?.mouth?.x ?? NaN;

// ---------------------------------------------------------------------------
section('NOTHING UNTIL THE CARDS');
{
  const p = build();
  check('the rig resolved on this model', !!p.rig, 'no aim rig — the look half of this file has nothing to move');
  check('the pin resolved on this model', !!p.pin);
  check('a fresh puppet is inactive', !p.active && p.phase === 'none');
  check('the bust was measured', p.bustH > 0 && p.bustW > 0, `${p.bustH.toFixed(3)} x ${p.bustW.toFixed(3)} units`);
  const before = p.holder.position.clone();
  p.update(DT);
  check('...and an update while inactive moves nothing', p.holder.position.equals(before) && p.phase === 'none');
}

// ---------------------------------------------------------------------------
section('IT COMES UP FROM BELOW');
let held = null;
{
  const p = build();
  p.enter();
  p.update(DT);
  check('the first frame is a wait, off the bottom', p.phase === 'wait' && p.state.crownY > FRAME.h,
    `phase ${p.phase}, crown at ${p.state.crownY.toFixed(1)} of ${FRAME.h}`);
  let n = 0;
  while (p.phase === 'wait' && n++ < 120) p.update(DT);
  check('the rise starts after the delay', p.phase === 'in', `phase ${p.phase} after ${n} frames`);
  check('...from below the screen', p.state.crownY > FRAME.h - 1, `crown ${p.state.crownY.toFixed(1)}`);

  let backwards = 0;
  let prev = p.state.crownY;
  n = 0;
  while (p.phase === 'in' && n++ < 600) {
    p.update(DT);
    if (p.state.crownY > prev + 1e-6) backwards++;
    prev = p.state.crownY;
  }
  check('it never sinks on the way up', backwards === 0, `${backwards} frames`);
  check('it arrives held', p.phase === 'held', `phase ${p.phase}`);
  check('...on the crown line', Math.abs(p.state.crownY - FRAME.crownLine) < 0.5,
    `crown ${p.state.crownY.toFixed(2)} vs line ${FRAME.crownLine}`);
  check('...at the tuned height', Math.abs(p.state.scale * p.bustH - bustPx()) < 0.01,
    `${(p.state.scale * p.bustH).toFixed(1)}px of ${bustPx().toFixed(1)}`);
  // The crown, measured off the placed holder rather than read back from the
  // state: this is the number the pixels actually come from.
  const crownWorld = p.holder.position.y + p.bust.max.y * p.state.scale;
  check('...and the holder puts the crown there', Math.abs(-crownWorld - FRAME.crownLine) < 0.5,
    `holder crown at ${(-crownWorld).toFixed(2)}px`);
  held = p;
}

// ---------------------------------------------------------------------------
section('THE SHORT SCREEN — it comes up behind the cards rather than not at all');
{
  const p = build();
  p.setFrame({ ...FRAME, crownLine: 700 });
  p.enter();
  run(p, 2);
  const want = FRAME.h - CFG.minVisible * bustPx();
  check('held', p.phase === 'held');
  check('the crown is lifted to keep the minimum on screen', Math.abs(p.state.crownY - want) < 0.5,
    `crown ${p.state.crownY.toFixed(1)}, wanted ${want.toFixed(1)}, row asked for 700`);
}

// ---------------------------------------------------------------------------
section('IT LOOKS AT THE CARD');
{
  const p = held;
  p.look({ x: 1100, y: 300 });
  run(p, 1.5);
  const right = mouthX(p);
  check('a card on the right swings the aim right', p.aim.x > 0.2, `aim.x ${p.aim.x.toFixed(3)}`);
  p.look({ x: 180, y: 300 });
  run(p, 1.5);
  const left = mouthX(p);
  check('a card on the left swings it left', p.aim.x < -0.2, `aim.x ${p.aim.x.toFixed(3)}`);
  check('...and the head actually moves between the two', right - left > 4,
    `mouth ${right.toFixed(1)}px → ${left.toFixed(1)}px`);
  p.look(null);
  run(p, 1.5);
  check('nothing pointed at: it watches the row', Math.abs(p.aim.x) < 0.2, `aim.x ${p.aim.x.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
section('IT SWIMS UP AS THE RUN\'S SEAL, THEN STANDS');
{
  const p = build();
  const identity = new THREE.Quaternion();
  p.enter();
  let n = 0;
  while (p.phase !== 'in' && n++ < 120) p.update(DT);
  for (let i = 0; i < 6; i++) p.update(DT);
  check('early in the rise it is not planted', p.state.plant < 0.05, `plant ${p.state.plant.toFixed(3)}`);
  check('...so the body is on its heading, not the bust\'s plumb',
    p.holder.quaternion.angleTo(identity) < 0.02,
    `${p.holder.quaternion.angleTo(identity).toFixed(3)} rad off heading`);
  check('...the clip is picked from its speed', p.state.animState === 'swim' || p.state.animState === 'boost',
    `${p.state.animState} at ${p.state.speed.toFixed(1)} units/s`);
  check('...and no flipper is gated', p.state.finGate === null);
  run(p, 2);
  check('held, it is the bust', p.phase === 'held' && p.state.plant > 0.999 && p.state.animState === 'idle',
    `plant ${p.state.plant.toFixed(3)}, ${p.state.animState}`);
  check('...standing on the measured plumb', p.holder.quaternion.angleTo(identity) > 0.05,
    `${p.holder.quaternion.angleTo(identity).toFixed(3)} rad`);

  CFG.swimRig = false;
  const q = build();
  q.enter();
  n = 0;
  while (q.phase !== 'in' && n++ < 120) q.update(DT);
  for (let i = 0; i < 6; i++) q.update(DT);
  check('with the swim off it rises already standing', q.state.plant > 0.999 && q.state.animState === 'idle',
    `plant ${q.state.plant.toFixed(3)}, ${q.state.animState}`);
  CFG.swimRig = true;
}

// ---------------------------------------------------------------------------
section('ONE FLIPPER POINTS');
{
  const p = build();
  p.enter();
  run(p, 2);
  const fins = p.rig.fins;
  check('the rig has two fins to choose from', fins.length === 2, `${fins.length}`);
  check('the screen-left fin was measured', p.screenLeftFin >= 0, `index ${p.screenLeftFin}`);
  const ones = (g) => (g ?? []).filter((v) => v === 1).length;

  p.look(null);
  run(p, 0.5);
  check('nothing pointed at: both flippers to the clip', ones(p.state.finGate) === 0 && (p.state.finGate ?? []).every((v) => v === 0),
    JSON.stringify(p.state.finGate));

  p.look({ x: 1100, y: 300 });
  run(p, 1);
  const rightGate = p.state.finGate;
  check('a card on the right: exactly one flipper', ones(rightGate) === 1, JSON.stringify(rightGate));
  const screenRight = p.screenLeftFin === 0 ? 1 : 0;
  check('...the one on the card\'s side', rightGate?.[screenRight] === 1, `screen-right fin is ${screenRight}`);

  p.look({ x: 180, y: 300 });
  run(p, 1);
  const leftGate = p.state.finGate;
  check('a card on the left: the other one', ones(leftGate) === 1 && leftGate?.[p.screenLeftFin] === 1, JSON.stringify(leftGate));

  CFG.fin = 'far';
  run(p, 0.2);
  check('`far` flips it', p.state.finGate?.[screenRight] === 1 && ones(p.state.finGate) === 1, JSON.stringify(p.state.finGate));
  CFG.fin = 'left';
  run(p, 0.2);
  const li = fins.findIndex((f) => f.name === 'left');
  check('`left` is the animal\'s own left, whatever the screen', p.state.finGate?.[li] === 1 && ones(p.state.finGate) === 1);
  CFG.fin = 'both';
  run(p, 0.2);
  check('`both` hands the rig no gate at all', p.state.finGate === null);
  CFG.fin = 'none';
  run(p, 0.2);
  check('`none` gates every flipper', ones(p.state.finGate) === 0);
  CFG.fin = 'near';
  CFG.finIdle = 0.3;
  run(p, 0.2);
  check('finIdle is what the other flipper keeps', ones(p.state.finGate) === 1 && p.state.finGate.includes(0.3), JSON.stringify(p.state.finGate));
  CFG.finIdle = 0;

  // The fin actually moves: the pointing flipper's tip, on a right card
  // versus a left card, ends up on different sides of the shoulder.
  const tipX = (i) => { const v = new THREE.Vector3(); fins[i].bones[fins[i].bones.length - 1].getWorldPosition(v); return v.x; };
  p.look({ x: 1100, y: 300 });
  run(p, 1.5);
  const r = tipX(screenRight);
  p.look({ x: 180, y: 300 });
  run(p, 1.5);
  const l = tipX(screenRight);
  check('the pointing flipper follows the card', Math.abs(r - l) > 1, `tip ${r.toFixed(1)}px → ${l.toFixed(1)}px`);
}

// ---------------------------------------------------------------------------
section('THE EXIT IS THE STRIKE\'S BARREL ROLL');
{
  const p = build();
  p.enter();
  run(p, 2);
  p.leave();
  const identity = new THREE.Quaternion();
  run(p, CFG.outTime / 2);
  check('halfway out it is mid-roll', p.state.roll > 0.5 && p.state.roll < CFG.spinTurns * Math.PI * 2 - 0.5,
    `${(p.state.roll / (Math.PI * 2)).toFixed(2)} turns`);
  check('...on the body, about its spine', p.body.quaternion.angleTo(identity) > 0.05,
    `${p.body.quaternion.angleTo(identity).toFixed(3)} rad`);
  check('...and swimming again, not standing', p.state.plant < 0.5 && p.state.animState !== 'idle',
    `plant ${p.state.plant.toFixed(2)}, ${p.state.animState}`);
  let n = 0;
  while (p.phase === 'out' && n++ < 600) p.update(DT);
  check('gone, the body is back to identity', p.phase === 'none' && p.body.quaternion.angleTo(identity) < 1e-6);

  CFG.spin = false;
  const q = build();
  q.enter();
  run(q, 2);
  q.leave();
  run(q, CFG.outTime / 2);
  check('spin off: no roll', q.state.roll === 0 && q.body.quaternion.angleTo(identity) < 1e-6);
  CFG.spin = true;
}

// ---------------------------------------------------------------------------
section('THE WAIST PLANTS, IT DOES NOT SNAP');
{
  const p = build();
  p.enter();
  let n = 0;
  while (p.phase !== 'in' && n++ < 120) p.update(DT);
  p.update(DT);
  check('early in the rise the pin is off', p.state.pinWeight < 0.3, `weight ${p.state.pinWeight.toFixed(3)}`);
  run(p, 2);
  check('held, the pin is on', p.phase === 'held' && p.state.pinWeight > 0.95, `weight ${p.state.pinWeight.toFixed(3)}`);

  // And the blend itself, on a pin of its own: disturb a held bone, apply at
  // half weight, and it should be halfway home — not home, not untouched.
  const body = createVisual('ship');
  body.updateMatrixWorld(true);
  const pin = createBustPin(body);
  const bone = pin.bones[1]; // first child of the waist
  const rest = bone.quaternion.clone();
  const away = rest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8));
  bone.quaternion.copy(away);
  pin.apply(0.5);
  const toRest = bone.quaternion.angleTo(rest);
  const toAway = bone.quaternion.angleTo(away);
  check('apply(0.5) lands halfway', Math.abs(toRest - toAway) < 0.02 && toRest > 0.3,
    `${toRest.toFixed(3)} rad from rest, ${toAway.toFixed(3)} from the disturbance`);
  pin.apply(1);
  check('apply(1) lands home', bone.quaternion.angleTo(rest) < 1e-4);
  bone.quaternion.copy(away);
  pin.apply(0);
  check('apply(0) writes nothing', bone.quaternion.angleTo(away) < 1e-6);
}

// ---------------------------------------------------------------------------
section('THE PICK SENDS IT OFF THE TOP');
{
  const p = held;
  p.leave();
  check('it is leaving', p.phase === 'out');
  let rises = 0, sinks = 0;
  let prev = p.state.crownY;
  let n = 0;
  while (p.phase === 'out' && n++ < 600) {
    p.update(DT);
    if (p.state.crownY < prev - 1e-6) rises++;
    if (p.state.crownY > prev + 1e-6) sinks++;
    prev = p.state.crownY;
  }
  check('it goes up, never down', rises > 0 && sinks === 0, `${rises} up, ${sinks} down`);
  check('...and is gone within the tuned time', p.phase === 'none' && n <= Math.ceil(CFG.outTime / DT) + 2,
    `${n} frames, phase ${p.phase}`);
  check('...with the whole bust above the screen', p.state.crownY + bustPx() < 0,
    `crown ${p.state.crownY.toFixed(1)}, bust ${bustPx().toFixed(0)}px tall`);
}

// ---------------------------------------------------------------------------
section('A SECOND HAND BRINGS IT BACK');
{
  const p = build();
  p.enter();
  run(p, 2);
  check('held', p.phase === 'held');
  p.leave();
  run(p, CFG.outTime / 2);
  check('halfway out', p.phase === 'out' && p.state.crownY < FRAME.crownLine, `crown ${p.state.crownY.toFixed(1)}`);
  p.enter();
  check('a re-entry mid-exit does not reverse it', p.phase === 'out' && p.state.reenter === true);
  let n = 0;
  while (p.phase === 'out' && n++ < 600) p.update(DT);
  check('...it finishes leaving and starts again from below', (p.phase === 'wait' || p.phase === 'in') && p.state.crownY > FRAME.h - 1,
    `phase ${p.phase}, crown ${p.state.crownY.toFixed(1)}`);
  run(p, 2);
  check('...and is held again', p.phase === 'held' && Math.abs(p.state.crownY - FRAME.crownLine) < 0.5);
  p.reset();
  check('reset puts it away', !p.active);
}

// ---------------------------------------------------------------------------
section('OFF IS OFF');
{
  CFG.enabled = false;
  check('the flag reads off', !levelUpSealEnabled());
  const p = build();
  p.enter();
  p.update(DT);
  check('enter() does nothing while it is off', !p.active && p.phase === 'none');
  CFG.enabled = true;
  p.enter();
  run(p, 2);
  check('...and works again the moment it is on', p.phase === 'held');
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
