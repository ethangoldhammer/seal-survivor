#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:apex-spring
//
// Checks the secondary-motion rigging on the apex predators against the REAL
// model files, because every failure mode this system has is silent.
//
// `createAnimationController` resolves bone names with getObjectByName and then
// `.filter(Boolean)`, so a typo'd or renamed bone does not throw — the chain
// quietly comes back shorter, or empty, and the creature simply swims stiffly.
// Nothing logs unless EVERY chain on the model missed. Two of those silent
// failures were already in the tree when this file was written: the abyss
// shark had no rig at all, and every shark fin was welded to a bone the wag
// chain excludes. Neither showed up as an error anywhere.
//
// So this asserts the things you cannot see from the code:
//   - every declared chain resolves to the full set of bones it names
//   - each is a genuine parent->child chain (a break means the solver walks a
//     bone whose parent it never displaced, and the travelling wave is lost)
//   - no chain root forks into the body, which would swing the whole animal
//   - the solvers actually get built, one per chain
//   - `role: 'fin'` produces a stiffer spring that holds the same damping RATIO
//   - a body rotation makes the fin tips visibly lag, and that lag settles
//
//   node --import ./tools/vite-loader.mjs tools/apex-spring-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, '../public/models');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};
// Same shape, but it does not fail the run. For the timing budget at the
// bottom, where the measurement depends on what else the machine is doing —
// see the note there for why that cannot be a gate.
const warn = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'WARN'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// Every apex in enemies.csv that carries spawnGroup 'apex'. Listed by hand
// rather than derived, so adding an apex without rigging it fails here.
const APEX = [
  'enemyShark', 'enemyGreatWhite', 'enemyAbyssShark', 'enemyHammerhead',
  'enemyMegalodon', 'enemyMightyMeg', 'enemyDolphin',
  // The orca is TWO bodies now — bossOrca rolls a bull or a cow per arrival
  // (see `assets` on its def) — and they are the same skeleton wearing the
  // same shared ORCA_RIG, so both are listed rather than one standing in for
  // the other. A rig that resolved on the bull and not the cow would be a boss
  // that swims correctly half the time.
  'enemyOrcaBull', 'enemyOrcaCow',
  // bossMosasaur's body. Listed for the same reason the orca pair is: its five
  // chains are named off a rig whose bones are called Bone010_19, so a rename
  // or a re-export that renumbers them would resolve nothing and simply leave a
  // 27-unit animal swimming rigid.
  'enemyMosasaur',
  // bossHammerhead's body — the same binary and the same bone names as the wave
  // hammerhead above, on its own asset key so the boss can carry its own look.
  // Both are listed rather than one standing in for the other: the chains are
  // COPIED between the two defs, not shared, so they can silently drift apart.
  'enemyBossHammerhead',
];

// GLTFLoader decodes embedded textures through a blob: URL, which Node has no
// implementation for — the parse promise then never settles and the process
// exits with a bare "unsettled top-level await" and no stack. Dropping the
// texture references before parsing avoids it entirely; nothing here looks at
// materials.
function stripTextures(buf) {
  let o = 12, json = null, jsonStart = 0, jsonLen = 0;
  while (o < buf.length) {
    const len = buf.readUInt32LE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'JSON') {
      json = JSON.parse(buf.toString('utf8', o + 8, o + 8 + len));
      jsonStart = o + 8;
      jsonLen = len;
    }
    o += 8 + len;
  }
  if (!json) return buf;
  for (const m of json.materials || []) {
    for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
    if (m.pbrMetallicRoughness) {
      for (const k of Object.keys(m.pbrMetallicRoughness)) if (/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
    }
    if (m.extensions) for (const e of Object.values(m.extensions)) for (const k of Object.keys(e)) if (/Texture$/.test(k)) delete e[k];
  }
  delete json.textures; delete json.images; delete json.samplers;
  // Rewritten in place and padded back out to the original chunk length, so
  // every offset in the header and the BIN chunk stays valid.
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  if (js.length > jsonLen) throw new Error('stripped JSON grew — cannot patch in place');
  js = Buffer.concat([js, Buffer.alloc(jsonLen - js.length, 0x20)]);
  const out = Buffer.from(buf);
  js.copy(out, jsonStart);
  return out;
}

async function loadModel(file) {
  const path = resolve(MODELS, file);
  if (!existsSync(path)) return null;
  const buf = stripTextures(readFileSync(path));
  return new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
}

// Mirrors systems/animation.js — both accept a bare array or { bones, role }.
const specOf = (entry) => (Array.isArray(entry)
  ? { names: entry, role: 'tail' }
  : { names: entry?.bones ?? [], role: entry?.role ?? 'tail' });

// --- rigs resolve against the real files -----------------------------------
console.log('\nCHAINS RESOLVE');

const built = new Map(); // key -> { instance, controller, chains }

for (const key of APEX) {
  const def = ASSETS[key];
  const file = def.model.replace('/models/', '');
  const gltf = await loadModel(file);
  if (!gltf) {
    check(`${key}: ${file} is present`, false, 'missing from public/models');
    continue;
  }
  installModel(key, gltf.scene, gltf.animations);
  const instance = createVisual(key);
  instance.updateMatrixWorld(true);

  const chains = [...(def.rig?.springChains ?? [])].map(specOf);
  // The wag chain is a spring too, and is what the clipless shark leans on.
  if (def.rig?.wagChain) chains.unshift({ names: def.rig.wagChain, role: 'tail', wag: true });

  check(`${key}: declares at least one spring chain`, chains.length > 0, `${chains.length} chains`);

  let allResolved = true;
  let allLinked = true;
  let noForkedRoots = true;
  const detail = [];

  for (const { names, role } of chains) {
    const bones = names.map((n) => instance.getObjectByName(n));
    const missing = names.filter((n, i) => !bones[i]);
    if (missing.length) {
      allResolved = false;
      detail.push(`${role}: MISSING ${missing.join(',')}`);
      continue;
    }
    // A chain is only a chain if each bone's parent is the previous one. A
    // break is invisible at runtime: the solver still springs every bone, but
    // the lag stops accumulating across the gap.
    for (let i = 1; i < bones.length; i++) {
      if (bones[i].parent !== bones[i - 1]) {
        allLinked = false;
        detail.push(`${role}: ${names[i]} is not a child of ${names[i - 1]}`);
      }
    }
    // The house rule from assets.js: never start a chain on a bone that forks,
    // because rotating it drags every branch underneath. One bone child is a
    // clean continuation; two or more means this root carries something else.
    const kids = bones[0].children.filter((c) => c.isBone);
    if (kids.length > 1) {
      noForkedRoots = false;
      detail.push(`${role}: root ${names[0]} forks into ${kids.length} branches`);
    }
    if (bones.length < 2) {
      detail.push(`${role}: only ${bones.length} bone — below the solver's minimum, will be dropped`);
    }
  }

  check(`${key}: every named bone exists on the model`, allResolved, detail.join('; '));
  check(`${key}: every chain is parent->child`, allLinked);
  check(`${key}: no chain starts on a forking bone`, noForkedRoots);

  const controller = createAnimationController(instance);
  built.set(key, { instance, controller, chains, def });
}

// --- the solvers get built --------------------------------------------------
console.log('\nSOLVERS');

for (const [key, { controller, chains }] of built) {
  // Every chain of two or more bones should have produced exactly one solver.
  const expected = chains.filter((c) => c.names.length >= 2).length;
  check(`${key}: has a spring at all`, controller.hasSpring === true);
  check(`${key}: one solver per chain`, controller.springCount === expected,
    `${controller.springCount} of ${expected}`);
}

// Fins specifically, since the point of the change is that they exist now.
console.log('\nFIN COVERAGE');
for (const [key, { chains }] of built) {
  const fins = chains.filter((c) => c.role === 'fin');
  check(`${key}: springs its fins, not just its tail`, fins.length >= 2, `${fins.length} fin chains`);
}

// --- role scaling -----------------------------------------------------------
//
// The claim in CONFIG is that a 'fin' is stiffer than a 'tail' but rings the
// same amount — the damping RATIO c / (2*sqrt(k)) is what governs wobble, and
// stiffening without correcting damping would turn every fin into a twanging
// spring. Checked as arithmetic rather than by eye.
console.log('\nROLE SCALING');
{
  const base = CONFIG.animation.spring;
  const L = base.roleLooseness.fin;
  const finK = base.stiffness / L;
  const finC = base.damping / Math.sqrt(L);
  const ratio = (c, k) => c / (2 * Math.sqrt(k));
  check('fin is stiffer than tail', finK > base.stiffness, `${finK.toFixed(1)} vs ${base.stiffness}`);
  check('fin may trail less far', base.maxLag * L < base.maxLag,
    `${(base.maxLag * L).toFixed(3)} vs ${base.maxLag} rad`);
  check('damping ratio is preserved',
    Math.abs(ratio(finC, finK) - ratio(base.damping, base.stiffness)) < 1e-9,
    `${ratio(finC, finK).toFixed(4)}`);
  check('tail role is unscaled (chains written before roles are unchanged)',
    base.roleLooseness.tail === 1);
}

// --- it actually moves ------------------------------------------------------
//
// The arithmetic above says the config is sane; this says the fins respond.
// The spring measures bone directions in WORLD space, so rotating the whole
// creature is what a turn looks like to it — no animation clip needed, which
// matters because the shark ships none.
console.log('\nBEHAVIOUR');

const dt = 1 / 60;
const tipOf = (instance, name) => {
  const bone = instance.getObjectByName(name);
  return bone ? new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld) : null;
};

// Lag has to be measured DIFFERENTIALLY: the same creature, the same frames,
// simulated twice — once with the springs on and once with them off — and the
// distance between the two tips is the lag and nothing else.
//
// The obvious cheaper test does not work, and this is the trap the first
// version of this file fell into. Comparing the tip against its own rest
// position carried rigidly through the body's rotation folds the SWIM CYCLE
// into the measurement, because several of these fins hang off a bone that is
// already moving — the shark's lower caudal lobe branches off a wag-chain bone,
// the megalodon's off a bone its clip keys. On the mighty meg that self-motion
// is 3.4 world units, an order of magnitude more than the lag being looked for,
// and three rigs read as "never settles" when what they were doing was swimming.
//
// Running the pair is exact instead of approximate: both passes get a fresh
// controller (clock at zero), an identical yaw schedule, and the same pose
// driver, so everything except the spring cancels. beatPhase() returns 0 with
// no audio context, so there is no wall-clock term to desynchronise them.
const YAW_START = 120;   // frames of straight swimming first
const YAW_FRAMES = 20;   // then a third of a second of hard turn
const HOLD = 300;        // then hold the new heading and let it settle
const TOTAL = YAW_START + YAW_FRAMES + HOLD;

function tipTrack(key, tipName, { spring, impulseAt = -1 }) {
  const instance = createVisual(key);
  instance.rotation.set(0, 0, 0);
  instance.updateMatrixWorld(true);
  const controller = createAnimationController(instance);
  const wasEnabled = CONFIG.animation.spring.enabled;
  CONFIG.animation.spring.enabled = spring;
  const track = [];
  try {
    for (let i = 0; i < TOTAL; i++) {
      if (i >= YAW_START && i < YAW_START + YAW_FRAMES) {
        instance.rotation.z += 0.09;
        instance.updateMatrixWorld(true);
      }
      if (i === impulseAt) controller.impulse(new THREE.Vector3(0, 1, 0), CONFIG.animation.spring.impulseMax);
      controller.update(dt, 'swim', false);
      instance.updateMatrixWorld(true);
      track.push(tipOf(instance, tipName));
    }
  } finally {
    CONFIG.animation.spring.enabled = wasEnabled;
  }
  return track;
}

const maxBetween = (a, b, from, to) => {
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, a[i].distanceTo(b[i]));
  return peak;
};

// The first fin chain on each creature, which is what the change added.
const firstFin = (def) => [...(def.rig?.springChains ?? [])].map(specOf).find((c) => c.role === 'fin');

for (const [key, { def }] of built) {
  const fin = firstFin(def);
  if (!fin) continue;
  const tipName = fin.names[fin.names.length - 1];

  const rigid = tipTrack(key, tipName, { spring: false });
  const sprung = tipTrack(key, tipName, { spring: true });

  // Straight swimming, after the solver has primed: some lag is expected here
  // (the body is undulating), it just should not be the whole story.
  const straight = maxBetween(rigid, sprung, 30, YAW_START);
  const turning = maxBetween(rigid, sprung, YAW_START, YAW_START + YAW_FRAMES);
  check(`${key}: fin tip lags the body through a turn`, turning > straight * 1.3,
    `${turning.toFixed(4)} turning vs ${straight.toFixed(4)} straight, at ${tipName}`);

  // And the lag has to bleed off once the heading holds, or the fin is stuck
  // in a new pose rather than trailing and returning to it.
  //
  // "Settled" is the STRAIGHT-swimming lag, not zero. A fin on a hard-swinging
  // tail lags all the time — the mighty meg's lower lobe sits at 1.26 units
  // just cruising — so demanding it fall to a fraction of the turning peak
  // asks it to stop lagging, which is the opposite of the point.
  const settled = maxBetween(rigid, sprung, TOTAL - 60, TOTAL);
  check(`${key}: and settles back once the turn stops`,
    settled < Math.max(straight * 1.25, turning * 0.5),
    `${settled.toFixed(4)} from a peak of ${turning.toFixed(4)}, straight is ${straight.toFixed(4)}`);
}

// A hit shoves every chain, including the new ones — that is the whole reason
// the abyss shark having no rig mattered.
// Differential for the same reason the lag test is: an un-shoved fin is not a
// still fin, it is a swimming one. Both passes here have springs ON and differ
// only in whether the hit landed.
console.log('\nIMPULSE');
const HIT_AT = 60;
for (const [key, { def }] of built) {
  const fin = firstFin(def);
  if (!fin) continue;
  const tipName = fin.names[fin.names.length - 1];

  const calm = tipTrack(key, tipName, { spring: true });
  const shoved = tipTrack(key, tipName, { spring: true, impulseAt: HIT_AT });

  const kick = maxBetween(calm, shoved, HIT_AT, YAW_START);
  check(`${key}: a hit reaches the fins`, kick > 1e-3, `${kick.toFixed(4)} world units at ${tipName}`);

  // And it is a flinch, not a new resting pose — the shove has to wash out.
  const after = maxBetween(calm, shoved, TOTAL - 60, TOTAL);
  check(`${key}: and the shove washes out`, after < kick * 0.5,
    `${after.toFixed(4)} from a kick of ${kick.toFixed(4)}`);
}

// --- cost -------------------------------------------------------------------
//
// Every extra chain is another solver per creature per frame, which is the
// reason these were left as stubs in the first place. Measured against the
// concurrency caps in enemies.csv rather than guessed at.
console.log('\nCOST');
{
  const CAPS = {
    enemyShark: 6, enemyGreatWhite: 4, enemyAbyssShark: 2, enemyHammerhead: 4,
    enemyMegalodon: 2, enemyMightyMeg: 2, enemyDolphin: 4,
    enemyOrcaBull: 2, enemyOrcaCow: 2,
    // A boss is a singleton — maxConcurrent 1 in enemies.csv — so its five
    // chains are only ever paid for once, which is what makes four flippers
    // affordable on this body and not on a wave creature.
    enemyMosasaur: 1, enemyBossHammerhead: 1,
  };
  // The springs are timed by DIFFERENCE — the same update run with them on and
  // with them off — because controller.update also advances the mixer and the
  // sine drive, and attributing all of that to the springs would be wrong in
  // whichever direction the split happens to fall. Measured, the springs turn
  // out to be most of it (roughly 19us of a 22us update on the shark), which
  // is worth knowing precisely BECAUSE it is the part this change multiplied.
  const N = 600;
  const timeUpdate = (instance, controller, spring) => {
    const was = CONFIG.animation.spring.enabled;
    CONFIG.animation.spring.enabled = spring;
    try {
      for (let i = 0; i < 120; i++) { controller.update(dt, 'swim', false); instance.updateMatrixWorld(true); }
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) controller.update(dt, 'swim', false);
      return Number(process.hrtime.bigint() - t0) / 1000 / N;
    } finally {
      CONFIG.animation.spring.enabled = was;
    }
  };

  let springMs = 0;
  let totalMs = 0;
  for (const [key, { instance, controller, def }] of built) {
    const withSpring = timeUpdate(instance, controller, true);
    const without = timeUpdate(instance, controller, false);
    const spring = Math.max(0, withSpring - without);
    const cap = CAPS[key] ?? 1;
    springMs += (spring * cap) / 1000;
    totalMs += (withSpring * cap) / 1000;
    const chains = (def.rig?.springChains?.length ?? 0) + (def.rig?.wagChain ? 1 : 0);
    console.log(`  ${key.padEnd(18)} ${chains} chains  spring ${spring.toFixed(1)}us of ${withSpring.toFixed(1)}us  x${cap} = ${((spring * cap) / 1000).toFixed(3)}ms`);
  }
  // A 60fps frame is 16.67ms, and this is the whole apex roster simultaneously
  // at its concurrency caps — a worst case that also needs the seal, the swarm,
  // the crabs and the actual rendering to fit alongside it.
  //
  // ADVISORY, not a gate. This is wall-clock time on whatever machine happens
  // to be running the file, and it moves by a factor of four with nothing but
  // load: an idle box measures ~0.42ms here, and the same unchanged tree
  // measures 0.87-1.7ms with a couple of other test suites, a dev server or a
  // browser running alongside it. As a hard check it therefore failed on the
  // developer's own machine most of the time — and because `npm test` chains
  // the suites with &&, that took the ~18 suites after this one down with it,
  // which is a far worse outcome than not knowing the number.
  //
  // Re-baselining was the alternative and is worse: a budget loose enough to
  // survive a loaded machine (4ms+) no longer says anything about a 60fps
  // frame, so it would be a number that always passes rather than a number
  // that means something. Printed and flagged instead — the per-creature
  // breakdown above is the real signal, and a genuine regression shows up
  // there as a changed us-per-update, which load moves far less than it moves
  // this total.
  const BUDGET = 0.5;
  warn(`springing every apex at once stays under ${BUDGET}ms`,
    springMs < BUDGET,
    `${springMs.toFixed(3)}ms of spring, ${totalMs.toFixed(3)}ms of animation in total`
    + (springMs < BUDGET ? '' : ' — over budget, but this is wall-clock: re-run on an idle machine before believing it'));

  // The one thing load cannot explain. An order of magnitude past the budget is
  // not a busy laptop, it is a solver that started doing real work per bone —
  // so this stays a failure, and is the reason the check above can safely not
  // be one.
  check('...and is not catastrophically over',
    springMs < BUDGET * 10, `${springMs.toFixed(3)}ms vs a ${(BUDGET * 10).toFixed(1)}ms ceiling`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
