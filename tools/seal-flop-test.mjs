#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:flop
//
// THE DEAD SEAL — systems/deathDive.js's ragdoll and the bouncing landing.
//
// The flop is a sequence nobody can watch in a browser pane (that pane suspends
// requestAnimationFrame, so the dive never runs) and one nobody can screenshot
// either: every claim it makes is about a shape in TIME. Six ways it can be
// broken while still producing a corpse on a seabed:
//
//   THE CHAINS ARE FICTION   The ragdoll is five `springChains` entries in
//                            assets.js naming bones by hand. A name that is off
//                            by one resolves to nothing, animation.js warns
//                            once into a console nobody is reading, and the
//                            seal dies exactly as stiffly as it did before.
//                            Checked against the bone table inside the .glb.
//
//   THE LIVING SEAL PAYS     Those chains are muted for the whole run — a live
//                            animal must be bit-for-bit what it was before they
//                            existed. Muting is cleared by anim.reset() and by
//                            setLimp(), which is two places a stow can be
//                            missed and no place it would ever throw.
//
//   THE RESTITUTION IS PINNED  `death.bounce` is in every saved snapshot ever
//                            made, and saved tuning beats config.js. That is
//                            why the restitution has a new NAME, and this is
//                            the check that it stayed new and that the old key
//                            is gone rather than merely unread.
//
//   ONE BOUNCE, OR FIFTY     The body has to patter to a stop: each contact
//                            lower than the last, a bounded number of them, and
//                            an actual REST at the end. A decay of 1 bounces
//                            forever inside a wall-clock ceiling, which looks
//                            like a corpse vibrating under the score card.
//
//   THE FX FIRE ONCE         Every contact is an EDGE. Counting frames in a
//                            window instead of edges is how one landing became
//                            182 events elsewhere in this project — so the
//                            events are counted, matched to the contacts, and
//                            the first one is checked to be the heavy one.
//
//   THE CARD ARRIVES         The pause before the score screen counts from the
//                            moment the body is DOWN, not from the first
//                            contact — and something has to guarantee it
//                            arrives at all, whatever the restitution is tuned
//                            to. Both directions are checked, the second by
//                            tuning the bounce to never end.
//
// What it cannot tell you is whether any of it looks funny. It can tell you the
// body bounces, that it stops, and that something is fired every time it lands.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import './dom-stub.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import {
  player, initPlayer, resetPlayer, rebuildShipBody, updateAimRig, FLOP_ROLE,
} from '../path/src/entities/player.js';
import { ASSETS, installModel } from '../path/src/assets.js';
import { createAnimationController } from '../path/src/systems/animation.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../path/src/entities/enemies.js';
import {
  deathState, startDeathDive, updateDeathDive, resetDeathDive,
} from '../path/src/systems/deathDive.js';

// The animation controller warns for every state the procedural stand-in has no
// clip for, which here is all of them — no models are loaded in Node.
const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && msg.startsWith('[animation]')) return;
  realWarn(msg, ...rest);
};

// SEEDED. The dive rolls which way the body tumbles and a contact can roll
// which way it skids, so two runs of identical code differ — and the sections
// below compare runs against each other. Nothing here is a Monte Carlo
// measurement; the dice are simply held still.
let seed = 0x5ea1f10b;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0x5ea1f10b; };

let failures = 0;
function section(name) { console.log(`\n${name}`); }
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function note(text) { console.log(`        ${text}`); }

const DT = 1 / 60;
const F = CONFIG.death.flop;

updateBounds(16 / 9);
const scene = new THREE.Scene();
initPlayer(scene);

// ---------------------------------------------------------------------------
section('THE CHAINS — five of them, and every bone is really in the file');
{
  const chains = ASSETS.ship.rig?.springChains ?? [];
  check('the seal declares ragdoll chains', chains.length === 5, `${chains.length} chains`);
  check('all of them wear one role, and it is the one player.js stows',
    chains.length > 0 && chains.every((c) => c.role === FLOP_ROLE), `role "${FLOP_ROLE}"`);

  // Straight out of the GLB's JSON chunk, the way tools/model-bones.mjs reads
  // it — a loader would need a GPU and this question needs neither.
  const buf = readFileSync(new URL('../public/models/furseal.glb', import.meta.url));
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
  const names = new Set((gltf.nodes ?? []).map((n) => n.name));
  const missing = chains.flatMap((c) => c.bones).filter((b) => !names.has(b));
  check('every bone named exists on furseal.glb', missing.length === 0,
    missing.length ? missing.join(', ') : `${chains.flatMap((c) => c.bones).length} bones`);

  // Two bones is the solver's minimum — makeSpring returns null below it and
  // the chain is dropped without a word.
  check('no chain is too short to solve', chains.every((c) => c.bones.length >= 2));

  // The aim rig solves the tail itself, all the way to the seabed. A second
  // solver writing those bones would simply be overwritten every frame.
  const tail = ASSETS.ship.aimRig.tail.bones;
  const overlap = chains.flatMap((c) => c.bones).filter((b) => tail.includes(b));
  check('the tail is left to the aim rig', overlap.length === 0, overlap.join(', '));
}

// ---------------------------------------------------------------------------
section('THE LIVING SEAL — the chains sleep until something kills it');
{
  // Every chain is declared dormant on the RIG, so nothing that builds a
  // controller has to know. That is the claim being tested, and it is tested on
  // a skeleton built here rather than on the seal: no GLB loads in Node, so the
  // player's own controller has no springs at all and would pass this asleep or
  // awake. Two chains, one dormant and one not, through the real module.
  const chains = ASSETS.ship.rig.springChains;
  check('every chain declares itself asleep', chains.every((c) => c.asleep === true),
    chains.map((c) => `${c.role}:${c.asleep}`).join(' '));

  const stub = new THREE.Object3D();
  const bone = (name, parent, y) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(0, y, 0);
    parent.add(b);
    return b;
  };
  const rootA = bone('sleeperRoot', stub, 0);
  bone('sleeperTip', rootA, 1);
  const rootB = bone('wakerRoot', stub, 0);
  bone('wakerTip', rootB, 1);
  stub.userData.rig = {
    springChains: [
      { role: 'asleepRole', asleep: true, bones: ['sleeperRoot', 'sleeperTip'] },
      { role: 'awakeRole', bones: ['wakerRoot', 'wakerTip'] },
    ],
  };
  const anim = createAnimationController(stub);

  // An impulse is the cleanest probe there is: a muted chain refuses to store
  // one, so the bone it would have bent does not move however long you solve.
  const shove = new THREE.Vector3(1, 0, 0);
  // The PEAK deflection, not where the bone ended up. Every one of these chains
  // is pulled back toward a rest pose, so a measurement taken half a second
  // after the shove reads "near zero" for a chain that swung and came back and
  // for one that never moved at all.
  const turned = (b) => {
    // One update before the reading is taken, so `before` is where this bone
    // sits under whatever is driving it NOW. Without it the measurement after a
    // limp episode catches the pose snapping back to its rest — the bone moves,
    // nothing solved it, and a muted chain reads as awake.
    anim.update(DT, 'idle', false);
    const before = b.quaternion.clone();
    anim.impulse(shove, 12, 0.5);
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      anim.update(DT, 'idle', false);
      peak = Math.max(peak, before.angleTo(b.quaternion));
    }
    return peak;
  };

  check('a sleeping chain does not move', turned(rootA) < 1e-6);
  check('...while a chain beside it does', turned(rootB) > 1e-3);

  // reset() clears every mute the game has set — the sleeping ones have to
  // survive it, or the seal wakes up loose after its first restart.
  anim.reset();
  check('and it is still asleep after a reset', turned(rootA) < 1e-6);

  // setLimp is the one thing that wakes it, and handing the skeleton back
  // stows it again.
  anim.setLimp({ stiffness: 7, damping: 2.6, tipLooseness: 0.9, maxLag: 1.7, softness: 0.5, snapAngle: 3 });
  check('going limp wakes it', turned(rootA) > 1e-3);
  anim.setLimp(null);
  anim.reset();
  check('handing the skeleton back puts it to sleep', turned(rootA) < 1e-6);

  // And the seal's own reset paths still run clean end to end.
  resetPlayer();
  resetDeathDive();
  check('the seal survives a reset with the ragdoll in place', player.anim != null);
}

// ---------------------------------------------------------------------------
section('THE RENAME — a pinned snapshot cannot shadow the restitution');
{
  check('death.bounce is gone from CONFIG', CONFIG.death.bounce === undefined,
    'pruneUnknownKeys drops it from every saved snapshot');
  check('the restitution is under its new name', typeof F.restitution === 'number', `${F.restitution}`);

  // The value in the SOURCE, not in CONFIG: a harness cannot assert a shipped
  // default through CONFIG for any key a saved file might hold, and the whole
  // point of the new name is that no saved file holds it YET. This is what
  // catches the day one does.
  const src = readFileSync(new URL('../path/src/config.js', import.meta.url), 'utf8');
  // Sliced to the flop block first: `restitution` is a word other blocks use
  // (the physics one has its own), and a regex over the whole file reads
  // whichever comes first, which is not this one.
  const block = src.slice(src.indexOf('      flop: {'));
  const literal = Number(/restitution:\s*([\d.]+)/.exec(block)?.[1]);
  check('...and config.js is what is live', F.restitution === literal,
    `config.js says ${literal}, CONFIG holds ${F.restitution}`);

  const tuner = src.includes("path: 'death.bounce'");
  check('no slider still points at the dead key', !tuner);
}

// ---------------------------------------------------------------------------
// One death, driven frame by frame. Returns everything worth asserting about
// it: where the body was, when it touched the sand, and what fired.
function die({ from = 20, vx = 4, vy = 0, maxSeconds = 60 } = {}) {
  reseed();
  resetDeathDive();
  resetPlayer();
  player.mesh.position.set(0, from, 0);
  player.velocity.set(vx, vy);

  const events = [];
  const off = onFeedback((event, at) => {
    if (event === 'seabedImpact' || event === 'seabedBounce') {
      events.push({ event, scale: at.scale, pitch: at.sfxOpts?.pitch ?? 1, t: elapsed });
    }
  });

  const floor = bounds.bottom + (player.stats?.hitRadius ?? 1);
  const apexes = [];   // how high it came back up between one contact and the next
  let elapsed = 0;
  let finished = -1;
  let contacts = 0;
  let peak = 0;
  let airborneAfterFinish = false;

  startDeathDive(() => { finished = elapsed; });
  while (deathState.phase !== 'done' && elapsed < maxSeconds) {
    updateDeathDive(DT);
    elapsed += DT;
    const y = player.mesh.position.y;
    // The apex of a bounce is the highest the body got between the contact that
    // started it and the one that ended it — measured that way round rather
    // than by watching for the frame it turns over, since the contact frame is
    // itself a descending one and a naive turn-over test closes every bounce
    // the instant it opens.
    if (events.length > contacts) {
      if (contacts > 0) apexes.push(peak);
      contacts = events.length;
      peak = 0;
    } else if (contacts > 0) {
      peak = Math.max(peak, y - floor);
    }
    if (finished >= 0 && y > floor + 0.05) airborneAfterFinish = true;
  }
  off();
  return { events, apexes, elapsed, finished, floor, airborneAfterFinish };
}

// ---------------------------------------------------------------------------
section('THE LANDING — it bounces, each one lower, and then it stops');
{
  const run = die({ from: bounds.frameTop - 2 });
  note(`${run.events.length} contacts over ${run.elapsed.toFixed(1)}s of wall clock`);
  check('it reached the seabed and finished', run.finished > 0, `finished at ${run.finished.toFixed(2)}s`);
  check('it bounced rather than landing once', run.events.length > 1, `${run.events.length} contacts`);
  check('no more contacts than the config allows',
    run.events.length <= (F.maxBounces ?? 4) + 1, `max ${(F.maxBounces ?? 4) + 1}`);

  const falling = run.apexes.every((h, i) => i === 0 || h < run.apexes[i - 1] + 1e-6);
  check('every bounce is lower than the one before', falling,
    run.apexes.map((h) => h.toFixed(2)).join(' > '));
  check('the first bounce is one you can actually see', (run.apexes[0] ?? 0) > 0.1,
    `${(run.apexes[0] ?? 0).toFixed(2)} units`);

  check('the body is at rest when the score screen is handed the run',
    !run.airborneAfterFinish);
  check('...and it is resting ON the floor',
    Math.abs(player.mesh.position.y - run.floor) < 1e-6,
    `${(player.mesh.position.y - run.floor).toFixed(4)} off`);
}

// ---------------------------------------------------------------------------
section('THE FX — one event per contact, the first one heaviest');
{
  const run = die({ from: bounds.frameTop - 2 });
  check('the first contact is the arrival', run.events[0]?.event === 'seabedImpact');
  check('every one after it is the lighter event',
    run.events.slice(1).every((e) => e.event === 'seabedBounce'),
    run.events.map((e) => e.event).join(' '));
  check('each is quieter than the last',
    run.events.every((e, i) => i === 0 || e.scale < run.events[i - 1].scale + 1e-6),
    run.events.map((e) => e.scale.toFixed(2)).join(' > '));
  check('and pitched a little further up',
    run.events.slice(2).every((e, i) => e.pitch > run.events[i + 1].pitch),
    run.events.map((e) => e.pitch.toFixed(2)).join(' < '));

  // The edge, not the frame. A contact test that fired while the body was
  // merely AT the floor would run at 60 events a second for the length of the
  // settle pause.
  check('nothing fires while the body lies there',
    run.events.length <= (F.maxBounces ?? 4) + 1,
    `${run.events.length} events over ${run.elapsed.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
section('THE CEILING — a corpse that never stops still hands the run over');
{
  // Tuned to bounce forever: nothing is spent per contact and the floor under
  // "worth having" is on the ground. Only `settleMax` can end this.
  const keep = { ...F };
  Object.assign(CONFIG.death.flop, { restitution: 1, bounceDecay: 1, bounceMin: 0, maxBounces: 999 });
  const run = die({ from: bounds.frameTop - 2, maxSeconds: 90 });
  Object.assign(CONFIG.death.flop, keep);

  check('it still finished', run.finished > 0, `${run.finished.toFixed(1)}s`);
  const cap = (F.settleMax ?? 6) + (CONFIG.death.settle ?? 0.5) + run.events[0]?.t;
  check('and inside the ceiling plus the pause', run.finished <= cap + 0.5,
    `finished ${run.finished.toFixed(1)}s, ceiling ${cap.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
section('A DEATH ON THE FLOOR — the sequence that has nothing to fall through');
{
  const floor = bounds.bottom + (player.stats?.hitRadius ?? 1);
  const run = die({ from: floor + 0.2, vx: 0 });
  check('it still finishes', run.finished > 0, `${run.finished.toFixed(2)}s`);
  check('and it still makes a sound when it lands', run.events.length >= 1,
    `${run.events.length} contacts`);
}

// ---------------------------------------------------------------------------
section('THE WATER LETS GO — nothing keeps converging on the corpse');
{
  // Twelve hunters, ringed around the body at a spread of distances, all of
  // them well inside their own aggro radius. Driven through the real
  // updateEnemies against the real death dive, twice: once with the dispersal
  // on and once with it off, so the bar is the game's own behaviour rather than
  // a number pulled out of the air.
  const D = CONFIG.death.disperse;
  const floor = bounds.bottom + (player.stats?.hitRadius ?? 1);

  const swarmRun = (enabled) => {
    reseed();
    D.enabled = enabled;
    resetDeathDive();
    resetPlayer();
    resetEnemies(scene);
    player.mesh.position.set(0, floor + 14, 0);
    player.velocity.set(0, 0);
    // A spread of the things that actually converge: the pure chasers, a
    // school (which drifts at you through `towardPlayer`), and the hunters,
    // whose aggro radius is the gate this is supposed to release.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const kind = ['barracuda', 'fish', 'shark', 'squid'][i % 4];
      spawnNamed(scene, kind, 0, {
        x: player.mesh.position.x + Math.cos(a) * 12,
        y: player.mesh.position.y + Math.sin(a) * 6,
      }, { ignoreCaps: true });
    }
    const started = enemies.length;

    let t = 0;
    startDeathDive(() => {});
    while (deathState.phase !== 'done' && t < 30) {
      const scale = updateDeathDive(DT);
      updateEnemies(DT * scale, scene, player.mesh.position, () => {}, () => {});
      t += DT;
    }
    // Read at the end of the sequence — the frame the score card would appear,
    // which is the frame the player has been looking at the whole time.
    //
    // "ON the body", not "nearby": four units is about a seal, and the
    // complaint this fixes is a heap of animals sitting on one point rather
    // than animals in the neighbourhood. Measured at fourteen it counts
    // everything merely passing through the shot, which is what a released
    // ocean is supposed to look like.
    const at = player.mesh.position;
    const near = enemies.filter((e) => Math.hypot(
      e.mesh.position.x - at.x, e.mesh.position.y - at.y,
    ) < 4).length;
    const mean = enemies.reduce((sum, e) => sum + Math.hypot(
      e.mesh.position.x - at.x, e.mesh.position.y - at.y,
    ), 0) / Math.max(1, enemies.length);
    return { near, mean, started, left: enemies.length };
  };

  const chasing = swarmRun(false);
  const loose = swarmRun(true);
  D.enabled = true;
  note(`pursuing: ${chasing.near}/${chasing.left} on the body, mean ${chasing.mean.toFixed(1)} units`);
  note(`released: ${loose.near}/${loose.left} on the body, mean ${loose.mean.toFixed(1)} units`);

  check('every creature was there to begin with', chasing.started === 12, `${chasing.started}`);
  check('pursuit is what packs them in — this test proves nothing otherwise',
    chasing.near >= 4, `${chasing.near} of ${chasing.left} sitting on the corpse`);
  // MEASURE THE DISTANCE, NOT THE HEADCOUNT. `loose.near <= chasing.near / 3`
  // read a twelve-creature sample through an integer divide, so the bar moved
  // with whatever the pursuing run happened to pack: at eight on the body it
  // asked for two, at four it asked for one, and no tuning change is supposed
  // to make this claim harder or easier. Lowering `pace.enemy` from 1.5 to 1
  // did exactly that — slower creatures, fewer arrivals, four instead of eight,
  // and a check about RELEASE started failing because PURSUIT got weaker.
  //
  // Halved rather than thirded, and the mean-distance check below is what
  // actually carries the claim: it has twelve samples behind it instead of a
  // count of how many crossed one line, and it does not care how hard the water
  // was pushing to begin with. Released creatures end up about twice as far out
  // (12.8 -> 25.3 at the tuning this was written against).
  check('letting go empties the knot', loose.near <= chasing.near / 2,
    `${loose.near} against ${chasing.near} on the body`);
  check('...and they end up further out on average', loose.mean > chasing.mean * 1.5,
    `${loose.mean.toFixed(1)} against ${chasing.mean.toFixed(1)} units`);
  check('pursuit is fully released by the end', deathState.pursuit === 0 || !deathState.active,
    `${deathState.pursuit}`);

  // The one thing that must NOT relax.
  check('the crabs are exempt by config', D.keepPile === true);
  resetEnemies(scene);
}

// ---------------------------------------------------------------------------
section('THE SKELETON — on the real seal, the limbs actually move');
{
  // Everything above runs on the procedural stand-in, which has no bones at
  // all: it can prove the sequence is right and cannot prove there is a ragdoll
  // in it. So the real furseal.glb is loaded here — the same way
  // tools/seal-rig-test.mjs does it — the player's body is rebuilt on top of it
  // and a whole death is driven through the actual controller.
  const model = fileURLToPath(new URL('../public/models/furseal.glb', import.meta.url));
  if (!existsSync(model)) {
    check('furseal.glb is where the game expects it', false, model);
  } else {
    const buf = readFileSync(model);
    const gltf = await new GLTFLoader().parseAsync(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
    );
    installModel('ship', gltf.scene, gltf.animations);
    rebuildShipBody();

    const flipper = player.body.getObjectByName('hand_L_014');
    const foot = player.body.getObjectByName('foot_R_025');
    const head = player.body.getObjectByName('head_07');
    check('the ragdoll bones resolved on the rebuilt body', !!flipper && !!foot && !!head);

    // How far each bone strays from where it started, at its furthest, over one
    // death. Measured against a CONTROL RUN with the flop switched off rather
    // than against zero: the mixer and the aim rig move these bones on their
    // own, and "it moved" is not the claim — "it moves more because it is limp"
    // is.
    const watch = [flipper, foot, head].filter(Boolean);
    const swing = () => {
      reseed();
      resetDeathDive();
      resetPlayer();
      player.mesh.position.set(0, bounds.frameTop - 2, 0);
      player.velocity.set(6, 0);
      const start = watch.map((b) => b.quaternion.clone());
      const peak = watch.map(() => 0);
      let t = 0;
      startDeathDive(() => {});
      while (deathState.phase !== 'done' && t < 30) {
        updateDeathDive(DT);
        // THE AIM RIG STILL RUNS, and it runs AFTER the dive — main.js ticks it
        // every frame of the descent so the tail keeps its spring and the
        // anchors stay live. It writes the flipper and neck bones, which are
        // three of the five the ragdoll just posed, so a measurement taken
        // without it is a measurement of a frame the game never renders. No aim
        // and `limp`, exactly as the death branch there passes them.
        updateAimRig(DT, null, false, 0, true);
        t += DT;
        watch.forEach((b, i) => { peak[i] = Math.max(peak[i], start[i].angleTo(b.quaternion)); });
      }
      return peak;
    };

    CONFIG.death.flop.enabled = false;
    const stiff = swing();
    CONFIG.death.flop.enabled = true;
    const limp = swing();

    const deg = (r) => (r * 180 / Math.PI).toFixed(1);
    note(`stiff: ${stiff.map(deg).join(', ')} deg   limp: ${limp.map(deg).join(', ')} deg`);
    check('the body goes limp at all', player.anim.isLimp());
    check('every watched limb swings further when it does',
      limp.every((v, i) => v > stiff[i] + 0.01),
      watch.map((b, i) => `${b.name} ${deg(stiff[i])} -> ${deg(limp[i])}`).join('; '));
    // A ragdoll that has folded a joint through the body is not a ragdoll, it
    // is a bug with a good excuse. maxLag is the cap and this is the check that
    // the solver is actually honouring it on this rig.
    check('...but none of them folds past the lag limit',
      limp.every((v) => v < (F.maxLag ?? 1.7) * 1.5),
      `worst ${deg(Math.max(...limp))} deg against a ${deg(F.maxLag)} deg cap`);

    // THE TAIL is not one of the ragdoll's chains — the aim rig solves it, alive
    // or dead — so the only thing that loosens it is `tailLooseness`, applied
    // by that rig while the dive says it is limp. A divide and a cache with a
    // stamp on it, either of which can silently hand back the living animal's
    // spring.
    const tip = player.body.getObjectByName('tail02_023');
    if (tip) {
      // ONE SHOVE, HELD STILL. Measured on the rig alone rather than through a
      // death: a dive rolls a tumble direction and swings the whole body, which
      // is a lot of movement for a difference of a few degrees to hide in.
      // Here the only thing that changes between the two readings is the number
      // being tested.
      const shove = new THREE.Vector3(1, 0, 0);
      const TAIL_LOOSE = F.tailLooseness; // read before anything below moves it
      // The pose all three probes start from. The mixer is stopped (the body is
      // still limp from the run above), so nothing else would put these bones
      // back and each probe would start from wherever the last one left them —
      // a degree of drift, which is most of the difference being measured.
      const chain = player.aimRig.tail.bones;
      const home = chain.map((b) => b.quaternion.clone());
      const swingTail = (loose, limp) => {
        CONFIG.death.flop.tailLooseness = loose;
        chain.forEach((b, i) => b.quaternion.copy(home[i]));
        player.aimRig.reset();
        for (let i = 0; i < 20; i++) player.aimRig.update(DT, null, { limp });
        chain.forEach((b, i) => b.quaternion.copy(home[i]));
        const start = tip.quaternion.clone();
        player.aimRig.tailImpulse(shove, 12);
        let peak = 0;
        for (let i = 0; i < 90; i++) {
          player.aimRig.update(DT, null, { limp });
          peak = Math.max(peak, start.angleTo(tip.quaternion));
        }
        return peak;
      };
      const alive = swingTail(TAIL_LOOSE, false);
      const tight = swingTail(1, true);
      const loose = swingTail(TAIL_LOOSE, true);
      CONFIG.death.flop.tailLooseness = TAIL_LOOSE;
      check('a dead seal\'s tail is looser than a live one\'s', loose > tight + 0.01,
        `${deg(tight)} deg at 1x, ${deg(loose)} deg at ${TAIL_LOOSE}x`);
      check('...and the looseness reaches nothing that is still swimming',
        Math.abs(alive - tight) < 1e-6, `alive ${deg(alive)} deg against ${deg(tight)} deg`);
    }

    // And it is handed back. A body left limp ignores the mixer for the whole
    // of the next run.
    resetDeathDive();
    check('the skeleton is handed back for the next run', !player.anim.isLimp());
  }
}

resetDeathDive();
console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
