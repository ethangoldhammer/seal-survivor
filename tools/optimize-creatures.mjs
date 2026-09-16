// Turns a raw Sketchfab creature download into a body the game can afford.
//
//   npm run creatures                        # measure, write nothing
//   npm run creatures -- --write             # write public/models/
//   npm run creatures -- --write --only=moonjelly
//
// ONE PASS, TWO REASONS TO NEED IT. The models in the table below are heavy in
// two completely different places, and the pass handles both — which is why
// they share a tool rather than getting one each. Read the table's own notes
// before touching a row; the rationale is per model, not per tool.
//
// THE JELLIES ARE NOT HEAVY MODELS. Four of the five are under 16k triangles
// and the moon jelly is 5,484 — smaller than the crab AFTER optimize-crab.mjs
// ran. And yet three of them arrive at 4-5MB each. The weight is not where it
// usually is:
//
//   simple_moon_jellyfish       4.96MB  of which 4.03MB is ANIMATION
//   simple_spotted_jellyfish    4.83MB  of which 3.19MB is ANIMATION
//   comb_jellyfish              4.38MB  of which 2.30MB is ANIMATION
//
// That is 243,875 / 193,229 / 139,394 keyframes for one looping clip. The files
// say "baked animation" in their names and mean it literally: the artist wrote
// a key on EVERY bone, on EVERY channel, on EVERY one of 400 frames. A jelly
// bell that holds still for two seconds still carries 120 identical keys.
//
// THE FISH ARE THE ORDINARY CASE, and they are in here so that the difference
// is on the record rather than rediscovered. myllokunmingia is 810 keyframes
// and 2.09MB of TEXTURE on a 6,244-triangle animal; lizardfish is 15,184 keys
// and 1.89MB of texture. For those two `resample` does almost nothing and the
// whole saving is the 512 WebP step — the same point tools/prop-import.mjs
// makes at length about prop packs. Running the identical pass over both kinds
// is safe; assuming one kind's lever works on the other is not.
//
// So the lever for the JELLIES is `resample`, not `simplify`. It walks each channel and
// collapses any run of keys that a straight line already describes to within a
// tolerance; a bone that never moves goes from 400 keys to 2, and a smooth
// pulse keeps only its inflections. It is lossy in exactly the way that is
// invisible — the error bound is a distance, and it is checked below against a
// software-skinned re-render rather than assumed.
//
// WHAT ELSE THIS DOES:
//
//   TEXTURES to 512 WebP. VRAM is w*h*4*4/3 whatever the file costs (see
//   tools/texture-budget.mjs), so a 1024 map is 5.6MB of GPU memory per image
//   and these animals are 30-80px across in play. 512 is still oversampled.
//   The moon jelly's canal mask is the one to watch — it is line art, and line
//   art is what a downscale hurts first, so its own resize is checked by eye on
//   the audition page rather than trusted.
//
//   DROPS THE SOURCE SCENE'S FURNITURE, which is the single most damaging
//   thing these downloads carry, because it is invisible in the one place you
//   would look. `fit` scales a model by its LONG AXIS, so a prop that is
//   bigger than the animal silently becomes the thing being fitted and the
//   creature comes out a fraction of the size the number says. Nothing throws
//   and the model on disk is plainly correct.
//
//   TWO SHAPES, and it took both to catch what is actually in these files:
//
//     A. EXPORTER LOCATORS. simple_moon_jellyfish ships a 9th mesh on an
//        untextured `material_0` — seven grey cubes scattered around the
//        animal, inflating the bounding box 80%. Rule: every primitive on a
//        material named `material_N`.
//
//     B. THE GROUND PLANE. A diorama's floor or baked AO shadow, exported
//        along with the subject. crab_claw_attack's `_sand__0` is 10
//        triangles at 324 x 269 x 0 against a 56-unit crab — 5.8x the animal,
//        so `fit` was sizing the sand. dancing_crab has `pPlane1_AOFLoor_0`,
//        and blue_ringed_octopus (rejected) has the same thing again. Rule: a
//        FLAT mesh (one extent under 1% of its own longest) whose longest
//        extent beats every other mesh in the file.
//
//   Rule A alone shipped the crab's sand, which is why B exists. Both print
//   what they dropped and why — a silent drop here is as bad as a silent keep,
//   since the next person has no way to tell a deliberate omission from a bug.
//
//   CONVERTS KHR_materials_pbrSpecularGlossiness. three.js REMOVED this
//   extension; r183's GLTFLoader does not read it, so a specGloss model loads
//   with no base colour at all and renders flat white with only its normal map
//   — which looks like a broken texture path rather than a missing extension.
//   `metalRough()` rewrites those materials into the core PBR slots. The
//   dancing crab is the one row here that needs it, and it needs it badly:
//   as downloaded it is a grey crab, converted it is an orange-clawed one.
//
//   ...AND THEN DROPS WHAT THE CONVERSION ADDS. metalRough preserves the old
//   specular lobe by writing KHR_materials_specular and KHR_materials_ior,
//   which is right for fidelity and wrong for this roster: three.js promotes
//   any material carrying them to MeshPhysicalMaterial, and every other
//   creature in the game is a MeshStandardMaterial. That costs a heavier
//   shader for a wet highlight the water already provides — CONFIG.bloom, the
//   noise shader's `wet` section and toonShade's banding are all tuned against
//   Standard. Dropping the two extensions lands it where the rest of the
//   roster lives. (Standard is Physical's base class, so the shader
//   injections would have bound either way; this is about cost and about the
//   look being tuned once rather than twice.)
//
//   QUANTIZE positions to 14 bits and texcoords to 12. Not joints/weights: the
//   Sketchfab exporter already shipped these as bytes.
//
// WHAT THIS DELIBERATELY DOES NOT DO: simplify. The crab was 92k triangles and
// had to come down; these are already cheap in triangles and the thing that
// would actually break is the tentacle geometry, which is the entire read of a
// jellyfish silhouette. If one of them ever needs to come down, it is the crown
// jelly's 19,500-triangle arm cluster and it is a separate decision.
//
// THE ONE WAY TO BE FOOLED: `npm run ktx2` has to re-run after this, or the
// game goes on loading the old twin out of public/models-ktx2/ and the new art
// simply does not appear.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { metalRough, resample, dedup, prune, quantize, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync, existsSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = process.env.SEAL_ART ?? '/Users/ethangoldhammer/Documents/_DesignSystems/SealSurvivor';
// `--out` exists so the result can be auditioned somewhere that is not the
// game's asset folder — the A/B below is the whole check on `resample`, and it
// has to be possible to run it before anything is committed to public/models.
const OUT_DEFAULT = join(ROOT, 'public/models');

// key -> { file, why }. The key is what the model is called in the game; the
// file name is whatever it was downloaded as and is never used past this table.
// `why` is where the weight actually is, measured — it is what tells the next
// person whether a change to the pass is safe for that row.
//
// NOT IN THIS TABLE, and each for a reason that optimising cannot fix:
//   little_hermit_crab      0 bones, 0 skins, 0 clips. Nothing for the game's
//                           spring/wag fallback to drive — a static prop, so
//                           it belongs to tools/prop-import.mjs if anywhere.
//   blue_ringed_octopus     ships a 2-triangle 100x100 backdrop plane from the
//                           Inktober diorama, UVs run to -0.79 (quantize
//                           refuses them), and the animal is 666 flat unlit
//                           triangles.
//   shortfin_mako           works, and comes down to 0.94MB — but it is still
//                           27,524 triangles (9.5x shark.glb) and the sixth
//                           shark in a roster that already has five. That is a
//                           roster call, not a technical one; add the row if
//                           the call goes the other way.
const CREATURES = {
  moonjelly: {
    file: 'simple_moon_jellyfish_baked_animation.glb',
    // 243,875 keyframes on 206 bones. Also the one row that ships a helper
    // mesh, and the one that carries a hand-drawn canal mask in its emissive
    // slot — see the biolum note in the header.
    why: 'keyframes',
  },
  spottedjelly: { file: 'simple_spotted_jellyfish_baked_animation.glb', why: 'keyframes' },
  combjelly: { file: 'comb_jellyfish.glb', why: 'keyframes' },
  crownjelly: {
    file: 'crown_jellyfish_rhizostomeae.glb',
    // Half keyframes, half texture — and 29,788 triangles, the heaviest thing
    // here. If anything in this table ever earns `simplify`, it is this row's
    // 19,500-triangle arm cluster, and that is a separate decision.
    why: 'both',
  },
  flowerhatjelly: { file: 'flower_hat_jellyfish_limnomedusae.glb', why: 'texture' },
  // 8 bones — the cheapest rig in the batch by a wide margin, on a 6,244-
  // triangle animal. Nearly all of its 2.36MB is two 1024 maps.
  myllokunmingia: { file: 'myllokunmingia_fengjiaoa.glb', why: 'texture' },
  lizardfish: { file: 'lizardfishv3.glb', why: 'texture' },
  // Fiddler crab (Uca mjoebergi) — 45 bones, 3,084 triangles, one 2.46s
  // `Dance` clip, and THE BEST-LOOKING CRAB OF THE THREE once it can be seen
  // at all. It arrives as KHR_materials_pbrSpecularGlossiness, which three.js
  // no longer reads, so as downloaded it is a flat white crab on a grey floor
  // — and nothing on screen suggests a missing EXTENSION rather than a missing
  // file. Converted it is what the artist made: a dark red body, a pale
  // carapace and one oversized orange claw.
  //
  // THE ASYMMETRIC CLAW IS THE REASON TO WANT IT. crabpincer's two claws are
  // near-identical and pale, which is most of why that crab reads washed out;
  // one huge coloured claw is a silhouette a player can name at 30px.
  //
  // WHAT IT CANNOT DO, and this is the trade: `Dance` is a display wave, not a
  // walk cycle, and the rig ships no second clip. Its claw is also one closed
  // lump — the same limitation crabwalking.glb had, which is exactly why
  // systems/crabClaw.js exists and why crabpincer replaced it. A better-looking
  // crab that cannot pinch, against a worse-looking one that can.
  dancingcrab: { file: 'dancing_crab_-_uca_mjoebergi.glb', why: 'texture + specGloss' },

  // A WHOLE CRAB, not a claw: 63 nodes of body, arms and legs, animated on
  // node transforms with no skin and no textures at all. 2,430 triangles and
  // it costs 0.05MB, so the only question it raises is whether the game wants
  // a second crab beside crabpincer.glb's shared CRAB_RIG.
  crabclaw: { file: 'crab_claw_attack.glb', why: 'already cheap' },
};

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7);
// A DISTANCE, in the model's own units, and these models are 3-20 units long.
// 1e-4 is a ten-thousandth of a bell across, which no frame can show.
const TOL = Number(args.find((a) => a.startsWith('--tolerance='))?.slice(12) ?? 1e-4);
const MAXTEX = Number(args.find((a) => a.startsWith('--tex='))?.slice(6) ?? 512);
const OUT = resolve(args.find((a) => a.startsWith('--out='))?.slice(6) ?? OUT_DEFAULT);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const MB = (b) => (b / 1048576).toFixed(2) + 'MB';

if (WRITE) mkdirSync(OUT, { recursive: true });
let totalBefore = 0, totalAfter = 0;

for (const [key, { file, why }] of Object.entries(CREATURES)) {
  if (ONLY && ONLY !== key) continue;
  const src = join(SRC, file);
  if (!existsSync(src)) { console.log(`${key}: MISSING ${src}`); continue; }

  const doc = await io.read(src);
  const root = doc.getRoot();

  // Extents of a mesh in its OWN space, off the POSITION accessor's min/max —
  // which is what the glTF already carries, so this costs nothing to read.
  const extentsOf = (mesh) => {
    const e = [0, 0, 0];
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const lo = pos.getMin([]), hi = pos.getMax([]);
      for (let i = 0; i < 3; i++) e[i] = Math.max(e[i], hi[i] - lo[i]);
    }
    return e;
  };
  const spanOf = (mesh) => Math.max(...extentsOf(mesh));
  const meshes = root.listMeshes();
  // The longest thing that is NOT this mesh — a plane only counts as furniture
  // if it dwarfs the animal, so a legitimately long fin never trips the rule.
  const biggestOther = (mesh) => Math.max(0, ...meshes.filter((m) => m !== mesh).map(spanOf));

  for (const mesh of meshes) {
    const mats = mesh.listPrimitives().map((p) => p.getMaterial()?.getName() ?? '');
    const isLocator = mats.length > 0 && mats.every((m) => /^material_\d+$/.test(m));
    const e = extentsOf(mesh);
    const span = Math.max(...e);
    // FLAT means one axis is essentially zero next to the other two — a card,
    // not a thin animal. 1% of its own longest edge.
    const flat = span > 0 && Math.min(...e) < span * 0.01;
    const isGround = flat && span > biggestOther(mesh);
    if (!isLocator && !isGround) continue;
    const why = isLocator
      ? `exporter locators on ${mats.join(',')}`
      : `ground plane, ${e.map((v) => v.toFixed(0)).join(' x ')} against a ${biggestOther(mesh).toFixed(0)} body`;
    console.log(`  ${key}: dropped "${mesh.getName()}" — ${why}`);
    for (const n of root.listNodes()) if (n.getMesh() === mesh) n.setMesh(null);
    mesh.dispose();
  }

  const keysOf = (d) => d.getRoot().listAnimations()
    .reduce((a, an) => a + an.listSamplers().reduce((b, s) => b + (s.getInput()?.getCount() ?? 0), 0), 0);
  const keysBefore = keysOf(doc);

  await doc.transform(
    // FIRST, because everything after it reads the core material slots: a
    // specGloss material has no baseColorTexture until this runs, so a
    // textureCompress before it would re-encode nothing and prune would
    // consider the diffuse map unused and delete it outright.
    metalRough(),
    resample({ tolerance: TOL }),
    dedup(),
    prune({ keepAttributes: false, keepLeaves: false }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [MAXTEX, MAXTEX], quality: 88 }),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  );

  // See the header: keep the converted base colour, drop the specular lobe
  // that came with it, so this loads as MeshStandardMaterial like everything
  // else in the roster. dispose() on an Extension detaches it from every
  // material that references it.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_materials_specular' || ext.extensionName === 'KHR_materials_ior') {
      console.log(`  ${key}: dropped ${ext.extensionName} — Standard, not Physical`);
      ext.dispose();
    }
  }

  const bytes = await io.writeBinary(doc);
  const before = statSync(src).size;
  totalBefore += before; totalAfter += bytes.length;
  console.log(
    `${key.padEnd(16)} ${MB(before).padStart(8)} -> ${MB(bytes.length).padStart(8)}`
    + `  (${(100 - bytes.length / before * 100).toFixed(0)}% off)`
    + `  keys ${keysBefore.toLocaleString()} -> ${keysOf(doc).toLocaleString()}`
    // DISTINCT joints. These files carry one skeleton and up to eight skins
    // that all point at it, so summing listJoints() across skins reports the
    // moon jelly at 1,648 bones when it has 206 — an eightfold overcount on
    // the one number that decides whether it can spawn in a crowd.
    + `  bones ${new Set(root.listSkins().flatMap((s) => s.listJoints())).size}`
    + `  [${why}]`,
  );
  if (WRITE) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(OUT, `${key}.glb`), bytes);
  }
}
console.log(`\ntotal ${MB(totalBefore)} -> ${MB(totalAfter)}  (${(100 - totalAfter / totalBefore * 100).toFixed(0)}% off)`);
console.log(WRITE ? `written to ${OUT}${OUT === OUT_DEFAULT ? ' — now run `npm run ktx2`' : ''}` : 'measure only; pass --write to save');
