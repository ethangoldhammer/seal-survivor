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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
