#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TURNS A SKETCHFAB DOWNLOAD INTO SOMETHING THE SEAL CAN WEAR.
//
//   node tools/optimize-accessories.mjs            # measure, write nothing
//   node tools/optimize-accessories.mjs --write    # write public/models/
//   node tools/optimize-accessories.mjs --only=fedora
//
// An accessory is the smallest thing in the game that anybody looks at closely.
// It rides head_07 on a 2.6-unit animal at a `size` of about one world unit,
// and the camera frames CONFIG.arena.viewHeight (52) top to bottom, so at
// 1080p it covers 1080/52 = 21 pixels, or 65 at cinecam's zoomMax of 3.15, or
// about 130 on a 4K window in the kill shot. That is the whole budget, and the
// six files this reads were authored with no budget at all: 55,168 triangles
// and five 1024-square maps for a pair of sunglasses 130 pixels tall.
//
// WHAT IT DOES, in the order it matters:
//
//   1. UNPACKS THE PACK. gangster_hats.glb is two fedoras side by side,
//      mirrored across x, one per material. A pack is not an accessory; the
//      slot takes one key and `fit` normalises the LONGEST AXIS, so importing
//      it whole would scale the pair to one hat's width and hang both off the
//      seal's skull. `keep` below is the split, and it is a predicate on the
//      material rather than on the node name — the names are `Object_4`..
//      `Object_18` and say nothing.
//
//   2. BAKES THE SKIN OUT. lara_sunglasses.glb is skinned, and not to a rig of
//      its own: it carries the 273-joint humanoid armature the glasses were
//      exported off, hair and fingers and handgun holsters included. All four
//      of its primitives weight to ONE joint, so baking is exact rather than a
//      pose approximation — the joint's world matrix goes onto the vertices and
//      the armature is dropped. It has to be dropped: a SkinnedMesh allocates a
//      bone texture per instance (see the note in entities/enemies.js), and 273
//      joints of that for a pair of glasses is the same bug the spawn path had.
//
//   3. FLATTENS THE TRANSFORMS. Every one of these is nested under a
//      `Sketchfab_model` / `RootNode` chain carrying a rotation and a scale,
//      and two of them sit at y ~ 1.7 because that is where the head was on the
//      character they came off. createVisual recentres on the area-weighted
//      centroid so the offset does not reach the game, but it does reach every
//      measurement anyone makes of the file, which is how a placement gets
//      solved against the wrong origin. The matrices go onto the vertices, the
//      nodes go flat under the scene, and the bbox is centred on origin.
//
//   4. KILLS THE TRANSMISSION. Four of the six declare
//      KHR_materials_transmission, and on the steampunk bowler it is on the ONE
//      material the whole hat shares — a Sketchfab merge that gave the felt the
//      goggle lenses' glass. three.js honours it: MeshPhysicalMaterial with
//      transmission forces a separate transmission render pass over the whole
//      scene, which is a per-frame cost the size of the screen for an object
//      the size of a stamp, and it renders the hat see-through besides. So
//      transmission goes, and a material that was genuinely glass keeps its
//      base-colour alpha and stays BLEND.
//
//   5. BAKES THE MAPS NOBODY CAN SEE INTO FACTORS. A normal map perturbs
//      shading below the scale of a 65-pixel silhouette, and every one of these
//      files ships flat blue (mean 126,128,255 — an unbaked default). The
//      metallicRoughness maps DO carry real values and their materials all ship
//      factors of 1.0/1.0 leaning on them, so dropping the map without
//      averaging it first turns a felt hat into a mirror. They are averaged and
//      written back. Occlusion is the same image as metallicRoughness (packed
//      ORM) and goes with it.
//
//      EMISSIVE IS THE ONE TO WATCH. crosby_zebrawood.glb sets its emissive map
//      to the same image as its base colour, which Sketchfab does routinely and
//      which in this game means a pair of reading glasses that clears the bloom
//      threshold and glows on the seal's face. Dropped, and the factor zeroed.
//
//   6. RESIZES WHAT IS LEFT to 256 square. VRAM is w*h*4*4/3 whatever the file
//      cost (see tools/texture-budget.mjs), so a 1024 map is 5.6MB held for an
//      object that can show 130 texels across. 256 is still four times more map
//      than the kill shot can resolve.
//
//   7. WELDS AND DECIMATES to the triangle target in the table, error-bounded
//      so the simplifier stops rather than mangle a shape it cannot reach
//      cleanly. The targets are not uniform: a felt hat is a smooth blob that
//      decimates to nothing visible, and a wire spectacle frame is a tube whose
//      whole read is its outline, so it keeps more.
//
// WHAT IT WILL NOT DO is judge the result. Run tools/looks/accessory-lab.js, or
// render the before and after side by side, and look at it.
//
// The sources live outside the repo, in ~/Documents/_DesignSystems/SealSurvivor
// — see the note in memory about SeaBed. Nothing here can regenerate one, and
// nothing here writes to one.
// ---------------------------------------------------------------------------

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/models');
const SRC = path.join(os.homedir(), 'Documents/_DesignSystems/SealSurvivor');

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const only = (argv.find((s) => s.startsWith('--only=')) || '').split('=')[1];
// Somewhere other than public/models to write, for looking at a result before
// it is the game's. `--write` still means write; this only moves the target.
const outDir = (argv.find((s) => s.startsWith('--out=')) || '').split('=')[1] || OUT;
// Overrides for choosing a number, the way tools/optimize-guest.mjs does it.
// Whatever you settle on belongs in the row, not in a shell history.
const errorOverride = Number((argv.find((s) => s.startsWith('--error=')) || '').split('=')[1]) || null;
const trisOverride = Number((argv.find((s) => s.startsWith('--tris=')) || '').split('=')[1]) || null;

// The map size every accessory gets. See the header: 256 is four times what the
// most zoomed-in frame in the game can resolve on an object this size.
const MAP = 256;

// ---------------------------------------------------------------------------
// THE POOL. One row per file the game will load.
//
// `tris` is the target, and it is chosen by SHAPE rather than by a flat ratio.
// A hat is a closed smooth surface: its silhouette survives almost any
// decimation because the simplifier's error is measured against that surface
// and there is nothing sharp to lose. A wire spectacle frame is the opposite —
// it is a swept tube one or two pixels thick whose entire read IS the
// silhouette, and collapsing its rings is immediately visible as a kink. So the
// hats come down to about 1,500 and the wire frames hold 2,000-2,500.
//
// For scale: the placeholder hat.glb this replaces is 260 triangles and the
// placeholder sunglasses.glb is 412, both crude enough that the difference is
// the point of the exercise.
// ---------------------------------------------------------------------------
const POOL = [
  {
    name: 'bowlerhat',
    src: 'steampunk_hat.glb',
    tris: 1600,
    // The single material carries the goggle lenses' transmission over the
    // whole hat — felt included. See step 4.
    note: 'goggled bowler',
  },
  {
    name: 'tricornhat',
    src: 'pirate_hat.glb',
    tris: 1500,
    // Already the lightest of the six at 2,894, and the only one whose
    // silhouette has three points to lose, so it barely comes down.
    note: 'pirate tricorn',
  },
  {
    name: 'fedorahat',
    src: 'gangster_hats.glb',
    tris: 1600,
    // HALF A FILE. The pack holds the same fedora twice, mirrored across x and
    // differing only in its base map — a brown one (`hat4`, mean 48,38,37) and
    // a near-black one (`Material.001`, mean 23,24,28). At the size this is
    // drawn, in water the game grades blue, those two are the same hat, so the
    // black one is not imported. It is one texture swap from being a second
    // colourway if it is ever wanted.
    keep: (mat) => mat === 'hat4',
    // 2,416 -> 2,546 triangles when the prune moved ahead of the measurement:
    // the ratio used to be taken against BOTH fedoras, so a third of this
    // hat's budget was being spent on a hat that had already been dropped.
    // The only file in the first batch whose output the fix changed.
    note: 'brown fedora (half of the pack)',
  },
  {
    name: 'roundglasses',
    src: 'crosby_zebrawood.glb',
    tris: 2000,
    // Its emissive map is its base map. See step 5 — this is the one that
    // would have glowed.
    note: 'round wood frames',
  },
  {
    name: 'aviatorglasses',
    src: 'aviator_sunglasses.glb',
    tris: 2400,
    // No textures at all, five materials of pure factors, and 55,168 triangles
    // — 32,864 of them in the gold wire alone. The heaviest source here and the
    // one with the least in it.
    hardWeld: true,
    note: 'aviators',
  },
  {
    name: 'wireglasses',
    src: 'lara_sunglasses.glb',
    tris: 2200,
    // See weldPositions: this one is topology-bound, not error-bound, and an
    // exact weld leaves it at 8,469 triangles however hard you push --error.
    hardWeld: true,
    // The skinned one. See step 2.
    note: 'round wire frames',
  },

  // -------------------------------------------------------------------------
  // THE SECOND BATCH. Seven files came in; six are here — five worn, one a
  // creature. What was cut and why is at the bottom of this list: a rejection
  // is a finding and belongs beside the ones that passed, or the same file
  // gets re-imported in a year.
  // -------------------------------------------------------------------------

  {
    name: 'hardhat',
    src: 'hard_hat.glb',
    // 562 TRIANGLES IN THE SOURCE, which is under every other target here and
    // the only file in either batch that arrives already inside the budget.
    // The target is set above what it has so `ratio` clamps to 1 and simplify
    // is a no-op: there is nothing to take off a hat this clean, and pushing
    // it to 500 would round the dome for no gain anyone could see.
    //
    // All the weight is in three 1024 maps, one of which is a 390-byte flat
    // blue normal (mean 127,128,255 — the unbaked default step 5 describes).
    // 913KB of file for 562 triangles.
    tris: 700,
    note: 'orange hard hat',
  },
  {
    name: 'cowboyhat',
    src: 'hat.glb',
    // A brown wide-brim with an upturned edge, and the upturn is the whole
    // read — it is what separates this silhouette from the fedora already in
    // the pool. Smooth all the way round, so it decimates like the other hats.
    // Its normal map is 2.2MB, more than half the file, for a surface that is
    // 65 pixels of felt.
    tris: 1500,
    note: 'brown cowboy hat',
  },
  {
    name: 'wizardhat',
    src: 'wizards_hat.glb',
    // THE CHAIN GOES. See dropPrims for the full reasoning: 41,264 of this
    // file's 45,710 triangles are a beaded chain wound round the crown, packed
    // into volumes a third the hat's size, and simplify()'s per-primitive ratio
    // would spend the entire budget on it and leave the hat at 130 triangles.
    //
    // The rule is "dense and small", not a node name — every primitive in the
    // file is called `defaultMaterial`. The hat body is 3,358 triangles across
    // 2.0 units and survives; the three chain pieces are 30,704 / 7,448 / 3,112
    // across 1.42 / 0.43 / 0.31 and do not.
    dropPrim: (p) => p.tris > 2000 && p.longest < 1.5,
    // Higher than the other hats because the curl is not a smooth blob: the
    // point folds forward and hooks, and that hook IS the hat. A brim can lose
    // half its rings without anyone noticing and this cannot.
    tris: 1900,
    note: 'floppy witch hat (chain dropped)',
  },
  {
    name: 'sharkhood',
    src: 'gawr_gura_shark_hat.glb',
    // HALF THE FILE IS AN OUTLINE HULL. `Outline` is an exact inverted copy of
    // `Hood` in flat black — the standard cel-shading trick, and 3,316 of the
    // 6,632 triangles. The game draws its own rims (see CONFIG.creatureOutline
    // and the `outline` block in assets.js), so a baked-in second hull would
    // both double the cost and fight the rim the game puts there.
    keep: (mat) => mat === 'Hood',
    // The teeth. An open jaw with a full set of them, each one two triangles
    // across, and the read of the whole thing is a shark about to bite. This
    // holds more than a hat for the same reason the wire frames do.
    tris: 2200,
    note: 'shark-head hood',
  },
  // -------------------------------------------------------------------------
  // THE ONE THAT IS NOT AN ACCESSORY. It came in with the wardrobe batch and it
  // is a CREATURE — `enemyJellyfish` in assets.js, a row in enemies.csv — not
  // something the seal wears. It stays in this pool anyway, and that is a
  // decision rather than an oversight:
  //
  //   THE SETTINGS HAPPEN TO BE RIGHT. The one thing that would make an
  //   accessory build wrong for an enemy is the map size, because an enemy is
  //   drawn far larger than an accessory's 65 pixels. Measured: puffer, tang
  //   and cutesquid already ship 256-square maps and the squid ships 512, so
  //   this pool's 256 is in family rather than a compromise. The triangle
  //   budget lands it at 3,780, between the oyster's 2,248 and the puffer's
  //   5,152. Nothing is being stretched to fit.
  //
  //   AND THE EMISSIVE TREATMENT IS RIGHT TWICE OVER. Averaging the map into a
  //   factor is what this pool does to keep a glow without keeping the image;
  //   for an enemy it is also what the game wants, because NO creature in the
  //   roster carries an emissive map — bioluminescence is the `biolum` surface
  //   system in assets.csv, which paints the body properly and animates. The
  //   factor is a floor to build that preset on, not the final look.
  //
  // Splitting this into a tools/optimize-jellyfish.mjs alongside the other
  // per-creature importers would be five hundred duplicated lines to say the
  // same thing in a differently-named file. If a second creature ever needs
  // this pipeline, split it then and take both.
  // -------------------------------------------------------------------------
  {
    name: 'jellyfish',
    src: 'jellyfish.glb',
    // SKINNED ACROSS 25 JOINTS AND GENUINELY POSED — the rest-pose skinning
    // matrices deviate from identity by 0.72, so the vertices as stored are
    // not where this animal looks. The general linear-blend bake handles it;
    // see bakeSkins.
    //
    // THE ANIMATION GOES WITH THE SKIN, and here that is a real loss rather
    // than a formality: the source carries a swim cycle, and this pool bakes
    // skins off because an accessory is a static thing bolted to a bone. A
    // creature is not. enemyJellyfish drifts for now, which suits a jellyfish
    // better than it would suit anything else in the roster — but if it ever
    // needs to pulse, it has to be re-imported KEEPING the skin, and that is a
    // different tool rather than a flag on this row.
    emissive: 'bake',
    // The filaments are swept tubes one or two pixels wide, which is the
    // topology-bound case weldPositions exists for.
    hardWeld: true,
    // LANDS AT 3,780, not 2,000. It is error-bound, not ratio-bound — the
    // simplifier reaches its 0.004 and stops rather than collapse tubes it
    // cannot collapse cleanly, which is what the header asks for and not a
    // target that needs raising. Recorded so the gap between the number and
    // the result is not read as a bug next time.
    tris: 2000,
    note: 'a jellyfish — an ENEMY, not a hat; see the block above',
  },
];

// ---------------------------------------------------------------------------
// REJECTED, and the reason, so the file is not re-imported next year.
//
//   sailor_hat.glb — 972,616 triangles in 30MB, and two thirds of that is
//   STITCHING. Five primitives of ~112,000 triangles each, all called
//   Stitch1_1/Stitch2_1, modelling the thread of the seams as individual
//   tubes. It also ships the MANNEQUIN: one 830 x 1,817 x 307 node and one
//   837 x 639 x 215 node — a head and shoulders the hat was posed on — which
//   is why the file's bounding box is 1,829 units tall for a hat 100 units
//   deep.
//
//   Isolating the hat is easy enough. What is not is the decimation: the hat
//   alone is ~700,000 triangles against a budget of 1,500, a 470:1 reduction
//   on geometry that is mostly thin thread, and thin thread is exactly what
//   the simplifier turns into confetti (see the note on the wire frames).
//   There is no version of this that ends up looking like a hat.
//
//   And it would be a second one anyway: `accessoryHat` is already a sailor's
//   cap, gated on 50 hulls with "Hello Sailor!" on the toast. This file has
//   nowhere to go even if it were free.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const mulPoint = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
// Normals take the inverse transpose, which for the rigid-plus-uniform-scale
// matrices in these files is the rotation part renormalised — done the long way
// anyway, because one of them carries a non-uniform scale.
const mulDir = (m, v) => {
  const r = [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
  const l = Math.hypot(r[0], r[1], r[2]) || 1;
  return [r[0] / l, r[1] / l, r[2] / l];
};
const inverse3x3T = (m) => {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-12) return m;
  const i = [
    (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
    (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
    (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det,
  ];
  // Column-major 4x4 holding the transpose of the inverse of the linear part.
  return [i[0], i[3], i[6], 0, i[1], i[4], i[7], 0, i[2], i[5], i[8], 0, 0, 0, 0, 1];
};

/** Every triangle count in the document, for the before/after line. */
function stats(doc) {
  const root = doc.getRoot();
  let tris = 0;
  for (const m of root.listMeshes()) {
    for (const p of m.listPrimitives()) {
      const idx = p.getIndices();
      tris += idx ? idx.getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
    }
  }
  let texBytes = 0;
  for (const t of root.listTextures()) texBytes += t.getImage()?.byteLength ?? 0;
  return {
    tris: Math.round(tris),
    mats: root.listMaterials().length,
    texes: root.listTextures().length,
    texKB: Math.round(texBytes / 1024),
    prims: root.listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0),
  };
}

/**
 * Drop every mesh whose material `keep` rejects, and the nodes holding them.
 *
 * On the material rather than the node, because the node names in a Sketchfab
 * export are `Object_4`. See the fedora's row.
 */
function isolate(doc, keep) {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const mats = mesh.listPrimitives().map((p) => p.getMaterial()?.getName() ?? '');
    if (mats.every((m) => !keep(m))) {
      node.setMesh(null);
      node.dispose();
    }
  }
}

/**
 * Turn a skinned mesh into a static one at its bind pose.
 *
 * ONLY WHERE THAT IS EXACT, which means every vertex weighting to a single
 * joint. A mesh spanning two joints has no single matrix to bake and this
 * refuses rather than picking one — a pair of glasses that half-follows a jaw
 * is a bug you would find on the seal, not here.
 */
function bakeSkins(doc) {
  const notes = [];
  const scene = doc.getRoot().listScenes()[0];
  const baked = [];
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;

    const joints = skin.listJoints();
    const ibm = skin.getInverseBindMatrices();
    const used = new Set();
    for (const p of mesh.listPrimitives()) {
      const j = p.getAttribute('JOINTS_0');
      const w = p.getAttribute('WEIGHTS_0');
      if (!j || !w) continue;
      const ja = [0, 0, 0, 0];
      const wa = [0, 0, 0, 0];
      for (let i = 0; i < j.getCount(); i++) {
        j.getElement(i, ja);
        w.getElement(i, wa);
        for (let k = 0; k < 4; k++) if (wa[k] > 0) used.add(ja[k]);
      }
    }
    // MORE THAN ONE JOINT: bake the skin the way the GPU would, per vertex.
    //
    // The single-matrix path below is exact and cheap and covers the glasses,
    // which weight everything to one joint. The jellyfish do not: their bells
    // and tentacles are weighted across 25 and 7 joints and their rest pose is
    // genuinely POSED — the skinning matrices deviate from identity by 0.72 and
    // 2.00, so the vertices as stored are NOT where the model looks. Ignoring
    // the skin would import a jellyfish inside out.
    //
    // Linear blend skinning at rest is not an approximation of anything: it is
    // the exact position the renderer would put every vertex at on frame zero,
    // which is the only pose a static accessory ever has. What is lost is the
    // ability to animate it later, which an accessory riding head_07 was never
    // going to do.
    if (used.size !== 1) {
      bakeLinearBlend(mesh, skin);
      node.setSkin(null);
      node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      baked.push(node);
      notes.push(`baked ${joints.length}-joint skin by linear blend (weights on ${used.size} joints)`);
      continue;
    }
    const ji = [...used][0];
    const joint = joints[ji];
    const bind = [];
    ibm.getElement(ji, bind);
    // The skinning matrix at rest: joint world * inverse bind. The node's own
    // world matrix is NOT part of it — glTF ignores a skinned mesh node's
    // transform, which is exactly the trap that leaves a baked mesh in the
    // wrong place if you multiply it in out of habit.
    const jw = joint.getWorldMatrix();
    const m = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += jw[k * 4 + r] * bind[c * 4 + k];
        m[c * 4 + r] = s;
      }
    }
    applyMatrix(mesh, m);
    for (const p of mesh.listPrimitives()) {
      for (const sem of ['JOINTS_0', 'WEIGHTS_0']) {
        const acc = p.getAttribute(sem);
        if (acc) { p.setAttribute(sem, null); acc.dispose(); }
      }
    }
    node.setSkin(null);
    node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    baked.push(node);
    notes.push(`baked skin off ${joints.length} joints (all weights on "${joint.getName()}")`);
  }
  // ...AND THE BAKED NODE GOES TO THE SCENE ROOT.
  //
  // A skin's joint world matrices already run all the way up to the scene, so
  // a baked mesh's vertices are in SCENE space — while the node it hangs off
  // still sits under whatever chain the exporter left, and glTF told the
  // renderer to ignore that chain precisely because the skin superseded it.
  // flattenTransforms, one step later, does not know that: it multiplies every
  // mesh by its world matrix, and on a Sketchfab export that chain carries the
  // quarter turn from Z-up. So a baked jellyfish came out upside down — bell
  // below, tentacles arcing up — while the glasses, whose skinned node happens
  // to sit directly under the scene, were unaffected and hid the bug for two
  // imports.
  for (const node of baked) {
    node.getParentNode()?.removeChild(node);
    scene.addChild(node);
  }
  for (const skin of doc.getRoot().listSkins()) skin.dispose();
  return notes;
}

/**
 * Linear blend skinning, evaluated once and written onto the vertices.
 *
 * Positions blend by weight, which is the definition. NORMALS use the same
 * weights against the inverse transpose of each joint matrix and are
 * renormalised — correct for the rigid-plus-uniform-scale joints these files
 * carry, and the alternative (leaving them) would light a re-posed mesh by the
 * shading of a pose it is no longer in.
 *
 * Weights are renormalised per vertex rather than trusted: an exporter that
 * writes 0.4999/0.4999 would otherwise shrink the model toward its origin by
 * a fraction of a percent, which is invisible here and compounds through the
 * `fit` normalisation downstream.
 */
function bakeLinearBlend(mesh, skin) {
  const ibm = skin.getInverseBindMatrices();
  const joints = skin.listJoints();
  const mats = joints.map((j, i) => {
    const b = [];
    ibm.getElement(i, b);
    const jw = j.getWorldMatrix();
    const m = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) acc += jw[k * 4 + r] * b[c * 4 + k];
        m[c * 4 + r] = acc;
      }
    }
    return m;
  });
  const normalMats = mats.map(inverse3x3T);

  const seen = new Set();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const nrm = prim.getAttribute('NORMAL');
    const J = prim.getAttribute('JOINTS_0');
    const W = prim.getAttribute('WEIGHTS_0');
    if (!pos || !J || !W || seen.has(pos)) continue;
    seen.add(pos);

    const v = [0, 0, 0];
    const n = [0, 0, 0];
    const ja = [0, 0, 0, 0];
    const wa = [0, 0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      J.getElement(i, ja);
      W.getElement(i, wa);
      let total = 0;
      for (let k = 0; k < 4; k++) if (wa[k] > 0) total += wa[k];
      // A vertex with no weight at all is left where it is rather than
      // collapsed to the origin, which is what dividing by zero would do.
      if (!(total > 0)) continue;

      const op = [0, 0, 0];
      const on = [0, 0, 0];
      if (nrm) nrm.getElement(i, n);
      for (let k = 0; k < 4; k++) {
        const w = wa[k] / total;
        if (!(w > 0)) continue;
        const p = mulPoint(mats[ja[k]], v);
        op[0] += p[0] * w; op[1] += p[1] * w; op[2] += p[2] * w;
        if (!nrm) continue;
        const m = normalMats[ja[k]];
        on[0] += (m[0] * n[0] + m[4] * n[1] + m[8] * n[2]) * w;
        on[1] += (m[1] * n[0] + m[5] * n[1] + m[9] * n[2]) * w;
        on[2] += (m[2] * n[0] + m[6] * n[1] + m[10] * n[2]) * w;
      }
      pos.setElement(i, op);
      if (nrm) {
        const l = Math.hypot(on[0], on[1], on[2]) || 1;
        nrm.setElement(i, [on[0] / l, on[1] / l, on[2] / l]);
      }
    }
  }
  for (const prim of mesh.listPrimitives()) {
    for (const sem of ['JOINTS_0', 'WEIGHTS_0']) {
      const acc = prim.getAttribute(sem);
      if (acc) { prim.setAttribute(sem, null); acc.dispose(); }
    }
  }
}

/**
 * Drop primitives a predicate rejects, by SHAPE rather than by material.
 *
 * The `keep` predicate above splits a pack whose halves are different
 * materials. This is the other case: wizards_hat.glb is one material over six
 * primitives, and three of them are a beaded chain wound round the crown —
 * 41,264 of its 45,710 triangles, packed into volumes a third the size of the
 * hat. At 65 pixels that chain is a smudge, and leaving it in is worse than
 * cosmetic: simplify() applies its ratio PER PRIMITIVE, so a budget of 1,800
 * over this file spends 1,700 of it on the chain and leaves the hat itself
 * with 130 triangles. The dense decoration does not just fail to survive, it
 * eats the thing it decorates.
 *
 * The predicate is handed { tris, size, longest } in world units, so a row can
 * say "dense and small" without naming a node whose name is `defaultMaterial`.
 */
function dropPrims(doc, reject) {
  const notes = [];
  const scene = doc.getRoot().listScenes()[0];
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const wm = node.getWorldMatrix();
    for (const prim of [...mesh.listPrimitives()]) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const lo = [1e9, 1e9, 1e9];
      const hi = [-1e9, -1e9, -1e9];
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const w = mulPoint(wm, v);
        for (let k = 0; k < 3; k++) { if (w[k] < lo[k]) lo[k] = w[k]; if (w[k] > hi[k]) hi[k] = w[k]; }
      }
      const size = [0, 1, 2].map((k) => +(hi[k] - lo[k]).toFixed(4));
      const idx = prim.getIndices();
      const tris = Math.round((idx ? idx.getCount() : pos.getCount()) / 3);
      const info = { tris, size, longest: Math.max(...size) };
      if (!reject(info)) continue;
      mesh.removePrimitive(prim);
      prim.dispose();
      notes.push(`dropped a ${tris}-tri primitive spanning ${size.join(' x ')}`);
    }
    if (mesh.listPrimitives().length === 0) { node.setMesh(null); mesh.dispose(); node.dispose(); }
  });
  return notes;
}

/** Write a matrix onto a mesh's vertices, positions and normals both. */
function applyMatrix(mesh, m) {
  const nm = inverse3x3T(m);
  const seen = new Set();
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    const nrm = p.getAttribute('NORMAL');
    for (const [acc, fn] of [[pos, mulPoint], [nrm, mulDir]]) {
      // Primitives inside one mesh routinely share an accessor. Transforming it
      // twice would square the transform, silently.
      if (!acc || seen.has(acc)) continue;
      seen.add(acc);
      const v = [0, 0, 0];
      for (let i = 0; i < acc.getCount(); i++) {
        acc.getElement(i, v);
        acc.setElement(i, fn(acc === nrm ? nm : m, v));
      }
    }
    // TANGENT is dropped below anyway; a tangent left un-transformed under a
    // mirroring matrix is worse than no tangent.
  }
}

/** Bake the node hierarchy into the vertices and hang everything off the scene. */
function flattenTransforms(doc) {
  const scene = doc.getRoot().listScenes()[0];
  const meshNodes = [];
  scene.traverse((n) => { if (n.getMesh()) meshNodes.push(n); });
  for (const n of meshNodes) {
    applyMatrix(n.getMesh(), n.getWorldMatrix());
    n.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    n.getParentNode()?.removeChild(n);
    scene.addChild(n);
  }
  // Whatever is left of the Sketchfab_model / RootNode chain holds nothing now.
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getMesh() && n.listChildren().length === 0) n.dispose();
  }
}

/** Put the bounding box on the origin. */
function centre(doc) {
  const lo = [1e9, 1e9, 1e9];
  const hi = [-1e9, -1e9, -1e9];
  const seen = new Set();
  const accs = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION');
      if (!pos || seen.has(pos)) continue;
      seen.add(pos);
      accs.push(pos);
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
      }
    }
  }
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  for (const pos of accs) {
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      pos.setElement(i, [v[0] - c[0], v[1] - c[1], v[2] - c[2]]);
    }
  }
  return { size: [0, 1, 2].map((k) => +(hi[k] - lo[k]).toFixed(4)) };
}

/** Drop the vertex attributes nothing downstream reads. */
function trimAttributes(doc) {
  const dropped = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      for (const sem of p.listSemantics()) {
        // TANGENT is read by a normal map and by nothing else, and every normal
        // map here is dropped. TEXCOORD_1..4 are Sketchfab lightmap slots that
        // no material in these files references. COLOR_0 is checked rather than
        // assumed — a vertex colour that is not white is art.
        const drop =
          sem === 'TANGENT' ||
          /^TEXCOORD_[1-9]/.test(sem) ||
          (sem === 'COLOR_0' && isWhite(p.getAttribute('COLOR_0')));
        if (!drop) continue;
        const acc = p.getAttribute(sem);
        p.setAttribute(sem, null);
        acc.dispose();
        dropped.add(sem);
      }
    }
  }
  return [...dropped];
}

function isWhite(acc) {
  const v = [0, 0, 0, 0];
  for (let i = 0; i < acc.getCount(); i++) {
    acc.getElement(i, v);
    for (let k = 0; k < 3; k++) if (v[k] < 0.999) return false;
  }
  return true;
}

/**
 * MERGE VERTICES BY POSITION ALONE, and recompute the normals from the faces.
 *
 * weld() in gltf-transform is an EXACT match on every attribute, which is right
 * for a mesh whose splits are real and useless on a mesh whose splits are an
 * exporter artefact. lara_sunglasses.glb's frame is the second kind: 16,639
 * vertices over 11,648 triangles, and after an exact weld and a decimation to
 * its error bound it still holds 8,469 triangles across 4,249 distinct
 * POSITIONS — every seam split twice for a normal that differs in the sixth
 * decimal. The simplifier cannot collapse an edge whose two halves it sees as
 * separate surfaces, so the model is not error-bound at all, it is topology-
 * bound, and raising --error does nothing (measured: 0.004, 0.01, 0.02 and 0.04
 * all land within 20 triangles of each other).
 *
 * OPT-IN PER ROW, because this throws away every hard edge the file declared.
 * On a swept wire tube that is what you want and the smooth normals are an
 * improvement. On a hat brim it would round off a crease that is meant to be
 * sharp — and the hats do not need it: the fedora exact-welds from 27,344
 * triangles to 2,416 on its own.
 */
function weldPositions(doc) {
  const notes = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) continue;
      const count = idx ? idx.getCount() : pos.getCount();

      const key = new Map();
      const remap = new Int32Array(pos.getCount());
      const kept = [];
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const k = `${v[0].toFixed(6)},${v[1].toFixed(6)},${v[2].toFixed(6)}`;
        let at = key.get(k);
        if (at === undefined) { at = kept.length; key.set(k, at); kept.push([v[0], v[1], v[2]]); }
        remap[i] = at;
      }
      if (kept.length === pos.getCount()) continue;

      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = remap[idx ? idx.getScalar(i) : i];

      // Area-weighted face normals, which is the whole reason this is safe on a
      // tube: the cross product is proportional to the triangle's area, so a
      // sliver contributes to the average in proportion to how much surface it
      // actually is.
      const normals = new Float32Array(kept.length * 3);
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [kept[indices[i]], kept[indices[i + 1]], kept[indices[i + 2]]];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        for (const j of [indices[i], indices[i + 1], indices[i + 2]]) {
          normals[j * 3] += n[0]; normals[j * 3 + 1] += n[1]; normals[j * 3 + 2] += n[2];
        }
      }
      for (let i = 0; i < kept.length; i++) {
        const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
        normals[i * 3] /= l; normals[i * 3 + 1] /= l; normals[i * 3 + 2] /= l;
      }

      // Every other attribute takes the value of the FIRST vertex that claimed
      // the position — arbitrary between two seam halves, and the reason this
      // is opt-in. On these frames the only survivor is a TEXCOORD_0 whose
      // material has no map left, and prune() deletes it a step later.
      const buffer = pos.getBuffer();
      const before = { tris: count / 3, verts: pos.getCount() };
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem);
        if (sem === 'POSITION' || sem === 'NORMAL') continue;
        const el = acc.getElementSize();
        const out = new Float32Array(kept.length * el);
        const tmp = new Array(el).fill(0);
        const done = new Uint8Array(kept.length);
        for (let i = 0; i < acc.getCount(); i++) {
          const at = remap[i];
          if (done[at]) continue;
          done[at] = 1;
          acc.getElement(i, tmp);
          for (let k = 0; k < el; k++) out[at * el + k] = tmp[k];
        }
        acc.setArray(out);
      }
      pos.setArray(new Float32Array(kept.flat()));
      const nrm = prim.getAttribute('NORMAL');
      if (nrm) nrm.setArray(normals);
      else prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer));
      const newIdx = idx ?? doc.createAccessor().setType('SCALAR').setBuffer(buffer);
      newIdx.setArray(indices);
      prim.setIndices(newIdx);
      notes.push(`${mesh.getName()}: ${before.verts} -> ${kept.length} verts by position`);
    }
  }
  return notes;
}

/** The mean of one channel of a texture, 0..1. */
async function channelMeans(texture) {
  const st = await sharp(Buffer.from(texture.getImage())).stats();
  return st.channels.map((c) => c.mean / 255);
}

/**
 * Everything in steps 4-6: transmission off, the invisible maps averaged into
 * factors and dropped, what is left resized.
 */
async function fixMaterials(doc, spec = {}) {
  const notes = [];
  for (const mat of doc.getRoot().listMaterials()) {
    const label = mat.getName() || '(unnamed)';

    // CLEARCOAT goes for the same reason transmission does, one step milder:
    // it is the other property that promotes a material to MeshPhysicalMaterial
    // in three.js, and a second specular lobe on an object 65 pixels tall is a
    // per-pixel cost buying a highlight nothing can resolve.
    // green_neon_jellyfish.glb declares it on both its materials.
    const cc = mat.getExtension('KHR_materials_clearcoat');
    if (cc) {
      mat.setExtension('KHR_materials_clearcoat', null);
      notes.push(`${label}: clearcoat dropped (it forced MeshPhysicalMaterial)`);
    }

    // UNLIT is the opposite problem and the same answer. gawr_gura_shark_hat
    // .glb declares it, which in three.js means MeshBasicMaterial: the hood
    // would ignore every light in the ocean and sit on the seal's head at a
    // constant brightness while the animal under it shades with the water.
    // The whole point of an accessory is that it looks like it belongs to the
    // creature wearing it.
    const unlit = mat.getExtension('KHR_materials_unlit');
    if (unlit) {
      mat.setExtension('KHR_materials_unlit', null);
      notes.push(`${label}: unlit dropped (it would not shade with the seal)`);
    }

    const tr = mat.getExtension('KHR_materials_transmission');
    if (tr) {
      mat.setExtension('KHR_materials_transmission', null);
      // A material that was glass keeps its alpha and stays BLEND; one that
      // picked transmission up in a merge (the bowler's felt) goes opaque, and
      // its base-colour alpha says which it was.
      const a = mat.getBaseColorFactor()[3];
      const mapAlpha = mat.getBaseColorTexture() ? (await channelMeans(mat.getBaseColorTexture()))[3] : 1;
      const glass = a < 0.95 || (mapAlpha != null && mapAlpha < 0.95);
      if (!glass) mat.setAlphaMode('OPAQUE');
      notes.push(`${label}: transmission ${tr.getTransmissionFactor().toFixed(2)} -> ${glass ? 'blend' : 'opaque'}`);
    }

    const mr = mat.getMetallicRoughnessTexture();
    if (mr) {
      // glTF packs roughness in G and metalness in B, linear. The factors these
      // materials ship are 1.0/1.0 and lean entirely on the map, so the average
      // has to go back or a felt hat becomes chrome.
      const [, g, b] = await channelMeans(mr);
      mat.setRoughnessFactor(+(mat.getRoughnessFactor() * g).toFixed(3));
      mat.setMetallicFactor(+(mat.getMetallicFactor() * b).toFixed(3));
      mat.setMetallicRoughnessTexture(null);
      notes.push(`${label}: mr map -> rough ${mat.getRoughnessFactor()} metal ${mat.getMetallicFactor()}`);
    }
    if (mat.getNormalTexture()) { mat.setNormalTexture(null); notes.push(`${label}: normal map dropped`); }
    if (mat.getOcclusionTexture()) { mat.setOcclusionTexture(null); notes.push(`${label}: occlusion dropped`); }
    if (mat.getEmissiveTexture()) {
      // TWO KINDS OF EMISSIVE MAP, and they are not the same mistake.
      //
      // The Sketchfab default is the base map wired into the emissive slot,
      // which means a pair of reading glasses that clears the bloom threshold.
      // That one is a bug and is zeroed — see step 5.
      //
      // jellyfish.glb's is real art: a DIFFERENT image from its base colour, on
      // a translucent bell, on an animal whose whole read is that it glows. So
      // a row can ask for the map to be AVERAGED into the factor instead —
      // the same treatment metallicRoughness gets, and for the same reason.
      // The glow survives, uniformly over the bell rather than patterned, and
      // the 1.3MB image does not have to live in VRAM to deliver it.
      if (spec.emissive === 'bake') {
        const [r, g, b] = await channelMeans(mat.getEmissiveTexture());
        const f = mat.getEmissiveFactor();
        mat.setEmissiveFactor([+(f[0] * r).toFixed(3), +(f[1] * g).toFixed(3), +(f[2] * b).toFixed(3)]);
        notes.push(`${label}: emissive map -> factor ${mat.getEmissiveFactor().join(', ')}`);
      } else {
        mat.setEmissiveFactor([0, 0, 0]);
        notes.push(`${label}: EMISSIVE map dropped (it was the base map — see step 5)`);
      }
      mat.setEmissiveTexture(null);
    }
  }

  // Drop the extension itself, not just the per-material property, or the file
  // still declares a dependency the loader has to satisfy.
  const DEAD = ['KHR_materials_transmission', 'KHR_materials_clearcoat', 'KHR_materials_unlit'];
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (DEAD.includes(ext.extensionName)) ext.dispose();
  }

  for (const tex of doc.getRoot().listTextures()) {
    const [w] = tex.getSize() ?? [0];
    if (w <= MAP) continue;
    const img = sharp(Buffer.from(tex.getImage())).resize(MAP, MAP, { fit: 'fill' });
    const alpha = (await sharp(Buffer.from(tex.getImage())).stats()).channels.length === 4;
    const buf = alpha
      ? await img.png({ compressionLevel: 9, palette: true }).toBuffer()
      : await img.jpeg({ quality: 82, chromaSubsampling: '4:2:0' }).toBuffer();
    tex.setImage(buf).setMimeType(alpha ? 'image/png' : 'image/jpeg');
    notes.push(`${tex.getName() || 'texture'}: ${w} -> ${MAP} (${Math.round(buf.byteLength / 1024)}KB)`);
  }
  return notes;
}

// ---------------------------------------------------------------------------

await MeshoptSimplifier.ready;
if (!write) console.log('\n(dry run — pass --write to replace public/models/)');

const rows = [];
for (const spec of POOL) {
  if (only && spec.name !== only) continue;
  const src = path.join(SRC, spec.src);
  if (!fs.existsSync(src)) { console.error(`missing source: ${src}`); process.exitCode = 1; continue; }

  console.log(`\n=== ${spec.name}.glb  <-  ${spec.src}  (${spec.note})`);
  const doc = await io.read(src);
  const before = { ...stats(doc), fileKB: Math.round(fs.statSync(src).size / 1024) };

  if (spec.keep) isolate(doc, spec.keep);
  // Before the skin bake and the flatten, because the predicate is written
  // against the file's own world units and both of those move them.
  if (spec.dropPrim) for (const n of dropPrims(doc, spec.dropPrim)) console.log('  ' + n);
  for (const n of bakeSkins(doc)) console.log('  ' + n);
  flattenTransforms(doc);
  const dropped = trimAttributes(doc);
  if (dropped.length) console.log('  dropped attributes: ' + dropped.join(', '));
  for (const n of await fixMaterials(doc, spec)) console.log('  ' + n);

  if (spec.hardWeld) for (const n of weldPositions(doc)) console.log('  ' + n);

  // PRUNE BEFORE MEASURING. isolate() and dropPrims() detach nodes and
  // primitives but do not delete the meshes behind them, and stats() walks the
  // root's mesh list — so without this the ratio below is computed against
  // geometry that is already gone. On the shark hood that meant dividing the
  // budget by 6,632 when only 3,316 triangles were left, and the hood came out
  // at 1,476 against a target of 2,200: a third of the teeth spent on an
  // outline hull that was not in the file any more.
  await doc.transform(prune());
  const mid = stats(doc);
  const target = trisOverride ?? spec.tris;
  const ratio = Math.min(1, target / mid.tris);
  await doc.transform(
    // Weld first — the simplifier collapses edges and cannot see two coincident
    // vertices as one, so an unwelded mesh decimates into confetti. These files
    // are unwelded: lara's frame carries 16,639 vertices for 11,648 triangles.
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: errorOverride ?? spec.error ?? 0.004, lockBorder: false }),
    prune(),
    dedup(),
  );
  const box = centre(doc);
  const after = stats(doc);

  const glb = await io.writeBinary(doc);
  after.fileKB = Math.round(glb.byteLength / 1024);

  const line = (l, s) =>
    `  ${l.padEnd(7)} ${String(s.tris).padStart(6)} tris  ${String(s.prims).padStart(2)} prims  ` +
    `${String(s.mats).padStart(2)} mats  ${String(s.texes).padStart(2)} tex ${String(s.texKB).padStart(5)}KB  ` +
    `${String(s.fileKB ?? '').padStart(5)}KB file`;
  console.log(line('before', before));
  console.log(line('after', after));
  console.log(`  size ${box.size.join(' x ')}  (fit:1 normalises the longest of these to one world unit)`);

  if (write) {
    fs.writeFileSync(path.join(outDir, `${spec.name}.glb`), Buffer.from(glb));
    console.log(`  -> ${path.relative(ROOT, path.join(outDir, `${spec.name}.glb`))}`);
  }
  rows.push({ name: spec.name, before, after });
}

console.log('\n' + '-'.repeat(72));
const sum = (k, w) => rows.reduce((n, r) => n + r[w][k], 0);
console.log(`total  ${sum('tris', 'before')} tris / ${sum('fileKB', 'before')}KB  ->  ${sum('tris', 'after')} tris / ${sum('fileKB', 'after')}KB`);
if (!write) console.log('nothing written — pass --write');
