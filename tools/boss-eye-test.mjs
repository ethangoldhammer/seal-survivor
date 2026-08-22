#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bosseyes
//
// Every name in CONFIG.boss.perkFx.eyeSockets, checked against the model the
// boss that uses it actually wears.
//
// THE FAILURE THIS EXISTS TO CATCH IS SILENCE. `eyeNodeFor` in
// systems/bossPerks.js resolves these by name and caches `null` on a miss,
// falling back to a body-frame guess — so a stale name does not throw, does not
// warn, and does not even look obviously wrong: the beams keep coming out of
// roughly the right part of the face. Two of the four entries had been stale
// for as long as they had existed when this file was written, both left behind
// by model swaps (the orca's retargeted quadruped, the crab's pre-pincer rig).
//
// It reads the boss roster and the asset table rather than a list typed here,
// so a boss added tomorrow with an eyeSockets entry is checked by existing lines,
// and one added WITHOUT an entry is reported rather than skipped in silence.
//
// The glTF is parsed for its node graph only — no textures, no materials, no
// GL. That is deliberate: several of these models stall a full parse in Node
// on their image decode, and the question here is only what the nodes are
// called.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { PropertyBinding } from 'three';
import { ASSETS } from '../path/src/assets.js';
import { bossArchetypes } from '../path/src/systems/boss.js';

// eyeLights paints its glow sprite on a 2D canvas and dom-stub has no context;
// the pixels are never read back here, only the objects around them.
import './dom-stub.mjs';
document.createElement = (tag) => ({
  tagName: tag, width: 0, height: 0, style: {},
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, fillRect: () => {}, clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
  }),
});

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- the node names in a .glb, without building anything ---------------------
// A glTF binary is a 12-byte header then chunks; the first is the JSON. Node
// names live there, so this is the whole parser needed and it cannot stall.
function nodeNames(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a .glb`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  // SANITISED, the way GLTFLoader does on load — it runs every node name
  // through PropertyBinding.sanitizeNodeName, which strips `.[]:/ ` and is
  // why the crab is `Eye3L_04` at runtime and `Eye.3.L_04` in the file.
  // Comparing raw file names against the config produces a list that looks
  // authoritative and is wrong for every dotted rig; this file got that wrong
  // before it got it right, and "fixed" a name that had never been broken.
  return new Set((json.nodes ?? []).map((n) => n.name).filter(Boolean)
    .map((n) => PropertyBinding.sanitizeNodeName(n)));
}

/** Every model a boss can wear — `assets` is a list for the ones that vary. */
function modelsFor(enemyId) {
  const def = CONFIG.enemies?.[enemyId];
  const keys = def?.assets?.length ? def.assets : [def?.asset ?? enemyId];
  return keys
    .map((k) => ({ key: k, model: ASSETS[k]?.model }))
    .filter((m) => m.model)
    .map((m) => ({ ...m, file: resolve(HERE, '..', 'public', m.model.replace(/^\//, '')) }));
}

const eyeNodes = CONFIG.boss?.perkFx?.eyeSockets ?? {};
// THE ROSTER, FROM THE ROSTER. This used to fall back to a list of ids typed
// into this file, and that list was already one short the day it was written —
// the anglerfish was missing from it, so the inventory below reported eight
// bosses, said nothing about the ninth, and the whole "a boss added tomorrow
// is reported rather than skipped in silence" claim in the header above was
// false for a boss that already existed. A hardcoded roster in a file whose
// job is to notice roster drift is worth nothing.
//
// bossArchetypes() is what systems/boss.js actually picks from, so anything
// that can appear in a run appears here.
const bosses = bossArchetypes().map((b) => b.id ?? b.enemy).filter(Boolean);
if (!bosses.length) {
  check('the boss roster loaded', false, 'bossArchetypes() came back empty');
}

section('CONFIGURED EYE NODES RESOLVE');
for (const [id, names] of Object.entries(eyeNodes)) {
  const models = modelsFor(id);
  check(`${id}: the roster still knows this boss`, models.length > 0,
    models.length ? '' : 'no asset resolved — a renamed boss leaves a dead entry here');
  for (const m of models) {
    if (!existsSync(m.file)) { check(`${id}: ${m.model} is on disk`, false); continue; }
    const have = nodeNames(m.file);
    // EVERY name, on EVERY model the boss can wear. The orca picks between a
    // bull and a cow at spawn, so an entry that is right on one of them and
    // wrong on the other is a fight that has eyes half the time.
    for (const entry of names) {
      // Two shapes — a bare node name, or a measured `{ bone, offset }` for a
      // rig with no eye bone. Both resolve by name; only the bone differs.
      const n = typeof entry === 'string' ? entry : entry.bone;
      check(`${id} (${m.key}): "${n}"${typeof entry === 'string' ? '' : ' + measured offset'}`,
        have.has(n), have.has(n) ? '' : `not in ${m.model} — closest: ${nearest(n, have)}`);
      // A measured socket with no offset is the mistake this catches: it would
      // put both beads at the bone's origin, which on these two rigs is the
      // middle of the skull.
      if (typeof entry !== 'string') {
        const off = entry.offset ?? [];
        check(`${id}: "${n}" offset is a real point`,
          off.length === 3 && off.some((v) => Math.abs(v) > 1e-6), `[${off.join(', ')}]`);
      }
    }
  }
}

/** Best-effort suggestion, so a failure names the fix instead of the problem. */
function nearest(want, have) {
  const w = want.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best = '(nothing eye-ish)';
  let score = 0;
  for (const n of have) {
    const c = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!c.includes('eye')) continue;
    let s = 0;
    for (let i = 0; i < Math.min(c.length, w.length); i++) if (c[i] === w[i]) s++;
    if (s > score) { score = s; best = n; }
  }
  return best;
}

section('WHICH BOSSES HAVE SOCKETS AT ALL');
// Not a pass/fail on having eyes — a trawler is allowed to have none. This is
// the inventory, so that "add the eye glow to all the bosses" is a question
// with a written answer instead of a per-model investigation every time.
for (const id of bosses) {
  const models = modelsFor(id);
  if (!models.length) { console.log(`  ${id.padEnd(16)} no model`); continue; }
  const configured = eyeNodes[id];
  const have = existsSync(models[0].file) ? nodeNames(models[0].file) : new Set();
  const eyeish = [...have].filter((n) => /eye/i.test(n));
  const label = (e) => (typeof e === 'string' ? e : `${e.bone} +measured`);
  console.log(`  ${id.padEnd(16)} ${configured ? `wired: ${configured.map(label).join(', ')}` : eyeish.length ? `UNWIRED, ${eyeish.length} eye node(s) available` : 'no eye nodes in this rig'}`);
  // A rig that HAS eye nodes and is not wired to them is the anglerfish's
  // failure: its beams fell back to a body-frame guess and there was nothing
  // to say so. A rig with no eye nodes at all is fine and stays quiet — that
  // is the trawler, the yacht, and any boss whose sockets are still to be
  // measured.
  if (!configured && eyeish.length) {
    check(`${id}: has eye nodes but is not wired to them`, false,
      `${eyeish.slice(0, 4).join(', ')} — beams and glow fall back to a body-frame guess`);
  }
}

// ---------------------------------------------------------------------------
section('THE EYES THEMSELVES');
// ---------------------------------------------------------------------------
// Driven against stand-in bodies rather than a real spawn: what is being
// checked is systems/bossEyes.js's own rules — who gets a pair, who is lit,
// and that a corpse gives its pair back — and every one of those is about the
// bookkeeping, not about the model. A body here is an object with the two
// fields the system reads (`type` and `visual`) and a node tree with the right
// names, which is exactly what a boss presents to it.
{
  const { Group, Object3D, Scene } = await import('three');
  const { updateBossEyes, resetBossEyes, bossEyeCount, bossEyePairs } =
    await import('../path/src/systems/bossEyes.js');

  /** A body whose rig carries `names`. */
  function body(type, names) {
    const visual = new Group();
    for (const n of names) { const o = new Object3D(); o.name = n; visual.add(o); }
    return { type, visual, hp: 100, isBoss: true, flash: 0 };
  }

  const scene = new Scene();
  const sockets = CONFIG.boss.perkFx.eyeSockets;
  const names = (id) => (sockets[id] ?? []).map((e) => (typeof e === 'string' ? e : e.bone));
  const shark = body('bossShark', names('bossShark'));
  const crab = body('bossCrab', names('bossCrab'));
  // A MEASURED rig: one bone, two beads at two offsets on it. The failure this
  // catches is a socket list that collapses to one entry because both name the
  // same bone — which would leave a two-eyed animal with one eye.
  const mosa = body('bossMosasaur', names('bossMosasaur'));
  // ...and a body with no sockets at all, which must simply be skipped.
  const boat = body('bossBoat', ['hull']);

  resetBossEyes();
  updateBossEyes(1 / 60, scene, [shark, crab, mosa, boat]);
  check('a boss with sockets gets a pair', bossEyeCount() === 3, `${bossEyeCount()} pairs for 4 bodies`);
  check('...and one without is skipped rather than warned about',
    [...bossEyePairs().values()].filter((v) => v === null).length === 1);
  check('a measured rig gets both eyes off one bone',
    bossEyePairs().get(mosa)?.sockets.length === 2,
    `${bossEyePairs().get(mosa)?.sockets.length} sockets`);
  // ...and at two DIFFERENT points, not both at the bone's origin.
  const mo = bossEyePairs().get(mosa)?.sockets ?? [];
  check('...at two different points on it',
    mo.length === 2 && mo[0].offset.distanceTo(mo[1].offset) > 1,
    mo.length === 2 ? `${mo[0].offset.distanceTo(mo[1].offset).toFixed(1)} apart` : '');
  // ONE NODE, ONE BEAD. The megalodon has a single `eye` node and the crab has
  // two stalks, and the system has to build what the rig offers rather than
  // always two — a second bead on the shark would sit at the same point and
  // double its brightness for no reason anyone could name.
  const pairOf = (e) => bossEyePairs().get(e);
  check('the shark builds one eye, the crab two',
    pairOf(shark).sockets.length === 1 && pairOf(crab).sockets.length === 2,
    `${pairOf(shark).sockets.length} and ${pairOf(crab).sockets.length}`);

  // DARK UNTIL SOMETHING HAPPENS. The resting state is the whole design and it
  // is the easy thing to break — a boss whose eyes are always lit has spent
  // the tell before the fight starts.
  for (let i = 0; i < 60; i++) updateBossEyes(1 / 60, scene, [shark, crab, mosa]);
  const glow = (e) => {
    const p = pairOf(e).pair;
    return Math.max(p.charge, p.hurt);
  };
  check('a boss at rest says nothing', glow(shark) === 0 && glow(crab) === 0);

  // HURT — through `e.flash`, the field every damage source in the game
  // already sets. Nothing had to be edited at those call sites, which is the
  // point: hooking them one by one would have been six edits and a seventh
  // missed.
  shark.flash = CONFIG.fx.hitFlash;
  updateBossEyes(1 / 60, scene, [shark, crab, mosa]);
  check('a hit boss goes red', pairOf(shark).pair.hurt > 0,
    `hurt ${pairOf(shark).pair.hurt.toFixed(2)}`);
  check('...and a boss that was not hit stays dark', pairOf(crab).pair.hurt === 0);
  // The flash decays on the creature; the eye must not re-light every frame it
  // is still burning, or a boss under multishot is a solid red dot.
  let relit = 0;
  for (let i = 0; i < 30; i++) {
    shark.flash = Math.max(0, shark.flash - 1 / 60);
    const before = pairOf(shark).pair.hurt;
    updateBossEyes(1 / 60, scene, [shark, crab, mosa]);
    if (pairOf(shark).pair.hurt > before) relit++;
  }
  check('a decaying flash does not re-light it', relit === 0, `${relit} re-lights`);

  // A DEAD BOSS GIVES ITS PAIR BACK. The failure this catches is a leak: one
  // pair of meshes per boss, left in the scene for the rest of the run.
  updateBossEyes(1 / 60, scene, []);
  check('a boss that is gone releases its eyes', bossEyeCount() === 0);
  check('...and takes its meshes out of the scene', scene.children.length === 0,
    `${scene.children.length} left behind`);
  resetBossEyes();
}

// ---------------------------------------------------------------------------
section('THE EYES ARE ACTUALLY VISIBLE');
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO CATCH SHIPPED, and it was invisible for the same
// reason every bug in this file is: nothing threw.
//
// systems/bossEyes.js published its sockets as `eye0`/`eye1` — positional, on
// the reasoning that a one-node rig has no left or right. updateEyeLights gates
// on `SOCKETS.every(...)`, which asks for `eyeL` and `eyeR` BY NAME. It found
// neither, so `has` was false, so the lit target was 0, so both beads were held
// at `visible = false` for the entire run — on every boss in the game, for as
// long as boss eyes have existed.
//
// The section above passed the whole time. `pair.hurt` and `pair.charge` are
// clocks run BEFORE the visibility gate, deliberately (a flash left mid-decay
// while the eyes were hidden must not still be burning when they come back), so
// a harness that measured the flash measured a number that was working
// perfectly on a pair of invisible meshes.
//
// So this asks the only question that could have caught it: after a second of
// being alive and in front of the player, is there anything on screen.
{
  const { Group, Object3D, Scene, Vector3 } = await import('three');
  const { updateBossEyes, resetBossEyes, bossEyePairs } =
    await import('../path/src/systems/bossEyes.js');
  const { EYE_SOCKETS, eyeLightState } = await import('../path/src/systems/eyeLights.js');

  function body(type, names) {
    const visual = new Group();
    for (const n of names) {
      const o = new Object3D();
      o.name = n;
      // Off the origin, or the socket normal has no side to be on and the two
      // eyes fade together — and, more to the point here, the tracker has no
      // offset direction to tip and declines to move anything.
      o.position.set(0, 0, names.indexOf(n) === 0 ? -1 : 1);
      visual.add(o);
    }
    return { type, visual, mesh: visual, hp: 100, maxHp: 100, isBoss: true, flash: 0 };
  }

  const scene = new Scene();
  const sockets = CONFIG.boss.perkFx.eyeSockets;
  const names = (id) => (sockets[id] ?? []).map((e) => (typeof e === 'string' ? e : e.bone));
  const angler = body('bossAnglerfish', names('bossAnglerfish'));
  const player = new Vector3(12, 0, 0);
  for (let i = 0; i < 60; i++) updateBossEyes(1 / 60, scene, [angler], player);

  const entry = bossEyePairs().get(angler);
  check('the boss got a pair at all', !!entry);
  check('...published under the names updateEyeLights actually requires',
    EYE_SOCKETS.every((n) => !!entry?.rig?.sockets?.[n]),
    Object.keys(entry?.rig?.sockets ?? {}).join(', '));
  const st = eyeLightState(entry.pair);
  check('...and it is LIT after a second in front of the player', st.lit > 0.9,
    `lit ${st.lit.toFixed(3)}`);
  // AT LEAST ONE BEAD ON SCREEN, not both, and the difference is the near/far
  // fade doing its job. The eyes are on the sides of a head seen from the side,
  // so one of them is always pointing away from the lens and is correctly faded
  // out — asserting on both would be asserting that the fade is broken.
  check('...with a bead actually on screen',
    entry.pair.eyes.some((e) => e.bead.visible && e.bead.material.opacity > 0),
    entry.pair.eyes.map((e) => `${e.name} visible=${e.bead.visible} op=${e.bead.material.opacity.toFixed(2)}`).join(' | '));

  // A ONE-NODE RIG still has to fill both keys — the megalodon's file names a
  // single midline `eye`, and "both eyes share it" has to mean two beads at one
  // point rather than a pair that never lights.
  const shark = body('bossShark', names('bossShark'));
  for (let i = 0; i < 60; i++) updateBossEyes(1 / 60, scene, [angler, shark], player);
  const sEntry = bossEyePairs().get(shark);
  check('a one-node rig lights too', eyeLightState(sEntry.pair).lit > 0.9,
    `lit ${eyeLightState(sEntry.pair).lit.toFixed(3)} on ${sEntry.sockets.length} socket(s)`);
  check('...and it is aimed once, not once per key', sEntry.tracked.length === 1,
    `${sEntry.tracked.length} tracked`);

  // --- THE TELL -------------------------------------------------------------
  // `e.telegraph` is the channel a boss with no PERK uses to say it is winding
  // something up — the anglerfish's ambush and its lure are the animal rather
  // than a rolled power, so the perk check in bossEyes cannot see them and the
  // eyes stayed dark through every telegraphed moment of that fight.
  check('a boss saying nothing has cold eyes', eyeLightState(entry.pair).charge < 0.05,
    `charge ${eyeLightState(entry.pair).charge.toFixed(3)}`);
  angler.telegraph = 1;
  for (let i = 0; i < 60; i++) updateBossEyes(1 / 60, scene, [angler], player);
  check('a boss writing e.telegraph lights up', eyeLightState(entry.pair).charge > 0.8,
    `charge ${eyeLightState(entry.pair).charge.toFixed(3)}`);
  angler.telegraph = 0;
  for (let i = 0; i < 60; i++) updateBossEyes(1 / 60, scene, [angler], player);
  check('...and goes cold again when the tell ends',
    eyeLightState(entry.pair).charge < 0.05,
    `charge ${eyeLightState(entry.pair).charge.toFixed(3)}`);

  resetBossEyes();
}

// ---------------------------------------------------------------------------
section('THE EYES FOLLOW THE SEAL');
// ---------------------------------------------------------------------------
// The bead is the pupil — see the note in systems/bossEyes.js. What is measured
// is therefore where the bead ENDS UP IN WORLD SPACE, not what angle a bone
// holds: a rotation applied in the wrong space turns the eye by exactly the
// right amount in the wrong direction, which no assertion on the angle can see.
{
  const { Group, Object3D, Scene, Vector3 } = await import('three');
  const { updateBossEyes, resetBossEyes, bossEyePairs } =
    await import('../path/src/systems/bossEyes.js');

  // A rig shaped like the real one: two bones on the midline, each with its
  // socket offset OUT ALONG THE VIEW AXIS. That last part is the whole reason
  // the tracker cannot rotate about world Z — on this game's side-on camera the
  // eyes point at the lens, and a rotation about Z is a rotation about the
  // offset itself, which moves the bead not one pixel.
  function rig() {
    const visual = new Group();
    for (const n of ['Leye_Bone_00', 'Reye_Bone_00']) {
      const o = new Object3D();
      o.name = n;
      o.position.set(0, 0, n[0] === 'L' ? -0.6 : 0.6);
      visual.add(o);
    }
    return { type: 'bossAnglerfish', visual, mesh: visual, hp: 100, maxHp: 100, isBoss: true, flash: 0 };
  }
  const scene = new Scene();
  const e = rig();
  const beadAt = (entry, i) => {
    const v = new Vector3();
    entry.pair.eyes[i].bead.getWorldPosition(v);
    return v;
  };

  const settle = (px, py, frames = 240) => {
    const p = new Vector3(px, py, 0);
    for (let i = 0; i < frames; i++) updateBossEyes(1 / 60, scene, [e], p);
    return bossEyePairs().get(e);
  };

  const right = settle(30, 0);
  const atRight = [beadAt(right, 0), beadAt(right, 1)];
  const left = settle(-30, 0);
  const atLeft = [beadAt(left, 0), beadAt(left, 1)];

  check('the bead moves when the seal crosses the arena',
    atRight[0].distanceTo(atLeft[0]) > 0.02,
    `${atRight[0].distanceTo(atLeft[0]).toFixed(4)} world units of travel`);
  check('...and it moves TOWARD the seal, not away from it',
    atRight[0].x > atLeft[0].x && atRight[1].x > atLeft[1].x,
    `x ${atLeft[0].x.toFixed(3)} -> ${atRight[0].x.toFixed(3)}`);
  // BOTH EYES, same direction. Getting the parent-space conversion wrong sends
  // the two opposite ways, because their offsets point opposite ways — an
  // animal looking at you with one eye and away with the other.
  check('...both of them, the same way',
    Math.sign(atRight[0].x - atLeft[0].x) === Math.sign(atRight[1].x - atLeft[1].x),
    `L ${(atRight[0].x - atLeft[0].x).toFixed(3)}, R ${(atRight[1].x - atLeft[1].x).toFixed(3)}`);

  const up = settle(0, 30);
  const atUp = beadAt(up, 0);
  const down = settle(0, -30);
  check('...vertically too', atUp.y > beadAt(down, 0).y,
    `y ${beadAt(down, 0).y.toFixed(3)} -> ${atUp.y.toFixed(3)}`);

  // IT DOES NOT RATCHET. The mixer does not necessarily rewrite a bone every
  // frame — a clip holding a key skips it — so a delta composed onto whatever
  // is on the bone compounds its own last write, and the eye winds round until
  // it leaves the head. Nothing here writes the bones at all, which is the
  // worst case: every frame is a frame the animation skipped.
  // SETTLED FIRST, and for longer than it takes. The follow is an exponential
  // ease, so a short settle leaves a few percent of the last move still running
  // and the creep that produces is indistinguishable from the ratchet being
  // looked for — which is how this check first "found" a 0.03-unit wind that
  // was nothing but an unconverged lerp.
  const held = settle(30, 0, 600);
  const a = beadAt(held, 0).clone();
  for (let i = 0; i < 600; i++) updateBossEyes(1 / 60, scene, [e], new Vector3(30, 0, 0));
  check('ten seconds of holding still does not wind the eye round',
    beadAt(held, 0).distanceTo(a) < 0.001,
    `drifted ${beadAt(held, 0).distanceTo(a).toFixed(6)} in 10s`);

  // IT IS A ROTATION, so the bead's distance from its own bone cannot change.
  // This is the check that a swivel has not turned into a translation — which
  // is what a delta composed in the wrong space produces once the bone's own
  // pose is anything but identity, and it looks like an eye slowly leaving the
  // head rather than like a maths error.
  const boneW = new Vector3();
  e.visual.getObjectByName('Leye_Bone_00').getWorldPosition(boneW);
  const arm = beadAt(held, 0).distanceTo(boneW);
  const restArm = new Vector3().fromArray(
    (CONFIG.boss.perkFx.eyeSockets.bossAnglerfish[0].offset ?? [0, 0, 0]),
  ).length();
  check('the bead swings on a fixed arm — it turns, it does not slide',
    Math.abs(arm - restArm) < 1e-4, `${arm.toFixed(5)} against a socket arm of ${restArm.toFixed(5)}`);

  // ...and the arc is bounded by the swivel it was given. r * sin(theta) each
  // way, so the full left-to-right sweep is 2 r sin(theta) — past that the bead
  // has left the eyeball and reads as a firefly parked on the animal's cheek.
  const swing = atRight[0].distanceTo(atLeft[0]);
  const bound = 2 * restArm * Math.sin(CONFIG.boss.eyes.track.maxSwivel);
  check('...no further than the configured swivel allows',
    swing <= bound * 1.02, `${swing.toFixed(4)} against a ${bound.toFixed(4)} ceiling`);
  resetBossEyes();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
