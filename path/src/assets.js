import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CONFIG, registerSkinWearers } from './config.js';
import { applyAssetTable } from './assetTable.js';
import { attachNoiseShader, applyNoiseSettings } from './systems/noiseShader.js';
import { attachToonShade, applyToonSettings } from './systems/toonShade.js';
import { attachBiolumSkin, applyBiolumSkinSettings, instantiateBiolumSkin, splitForEdges } from './systems/biolumSkin.js';
import { attachGrassSway, applyGrassSettings } from './systems/grassSway.js';
import { makeOrganicRing } from './systems/organicRing.js';
import { createRockGeometry, startTumble } from './systems/rocks.js';

// ============================================================================
// ASSETS — one entry per visual thing in the game.
//
// Each entry can define BOTH a 3D model and a procedural shape. If `model` is
// set and loads, it wins; otherwise the shape is used. A missing or broken
// model degrades to a working game instead of a crash.
//
//   model    path under public/ — .glb, .gltf or .fbx
//   fit      scale so the model's longest axis equals this many world units
//   scaleXYZ optional [x,y,z] multiplied on top of `fit` — non-uniform tweaks
//            (squash/stretch) without touching the source file
//   forward  which MODEL axis points the way it travels  ('+Z','-X', …)
//   up       which MODEL axis is its back/top            (default '+Y')
//   offset   [x,y,z] nudge after centring
//   pivot    where the model's origin sits ALONG ITS `forward` AXIS, as a
//            fraction measured from the nose: 0 = nose tip, 1 = tail tip.
//            Omitted, the model balances on its centre of mass (the historic
//            behaviour, and right for anything that isn't a swimmer).
//            Swimming creatures want a small value — they turn by leading
//            with the head, so rotating about a point near the skull looks
//            like steering, while rotating about the centre of mass makes
//            the nose swing backwards through the turn.
//   tint     hex, overrides the model's material colour (null = keep original)
//   outline  { color, thickness, glow } — draws a constant-width border around
//            the silhouette via an inverted-hull shell (back faces only, pushed
//            out along the normal). Costs ONE extra draw call per mesh and no
//            per-frame work, so it's cheap for a few objects and expensive
//            only if used on something there are dozens of. Works on skinned
//            models: the push happens after skinning, in the vertex shader.
//            `glow` (default 1 = flat) multiplies the colour past 1.0 so the
//            bloom bright-pass haloes the rim; `thickness` is in the OBJECT
//            space the shader offsets in, so its scale is the source file's,
//            not the world's — see the seagull for how to convert.
//
//   material optional overrides applied to every mesh's material:
//            { roughness, metalness, emissive (hex), emissiveIntensity }
//            This is how lighting response is tuned per model — a lower
//            roughness makes the key light's highlight sharper and brighter.
//   emissiveFromMap
//            true = the model's OWN base-colour texture is also its emissive
//            map, so the thing lights up wearing its own art rather than
//            flooding with one flat colour. For a model whose texture IS the
//            effect — a banknote, a screen, a sign — which is the case a flat
//            emissive cannot serve: `emissive` is a single colour, and glow on
//            a lit model multiplies it, so turning the glow up on a printed
//            object washes the print away exactly when you wanted to see it.
//            Needs `material.emissiveIntensity` to be visible at all (a lit
//            material is seeded at 0 — see processMaterial), and is exclusive
//            with `texture.emissive`: both own `emissiveMap`, and the mask
//            wins because its toggle rewrites that slot on every flip.
//   texture  optional { map: '/textures/foo.png' } — loads a replacement base
//            colour texture over whatever the model shipped with. Missing
//            file logs a warning and keeps the model's original texture.
//   sprites  [paths under public/] — flat drawn art instead of a 3D model:
//            each image becomes a camera-facing quad cut to its own aspect
//            ratio, sized from `fit`/`radius` like an uploaded sprite. More
//            than one path means a POOL, one picked at random per spawn (as
//            with shape:'rock'), so a rapid-fire ability isn't the same
//            picture over and over. Files that fail to load drop out of the
//            pool; if none survive the `shape` below is used instead.
//
//   rig      for skinned models with no baked animation clips: describes a
//            bone chain to drive procedurally. See CONFIG.animation.
//            { axis: 'x'|'y'|'z', wagChain: [...bone names, root to tip],
//              headChain: [...bone names] }
//   morphs   { ourName: 'TargetNameInTheFile', ... } — named handles on the
//            model's blend shapes, resolved per instance by morphControl().
//            Influences are per-instance (the material is not), so this is how
//            one animal opens its mouth without every other one doing the same.
//   animations  { idle: 'ClipName', swim: 'ClipName', boost: 'ClipName' } —
//            if the model DOES ship clips with these names, they're used
//            instead of the procedural rig fallback.
//   aimRig   bone chains aimed at the player's aim direction, overriding the
//            clip for those bones ONLY, plus named anchor points published
//            for particle emitters. See systems/aimRig.js, CONFIG.fins and
//            CONFIG.head.
//            { tipAxis, fins: [{ name, bones: [root..tip], tipLength }],
//              head: { bones, tipLength },
//              anchors: { <name>: { bone, offset: [x,y,z] } } }
//
// `forward` and `up` describe the model itself, not the camera. The game maps
// them into view space based on CONFIG.view, so switching between the side and
// top-down views needs no asset edits.
//
//   shape    'cone'|'icosahedron'|'octahedron'|'sphere'|'ring'|'box'|'torus'
//            |'rock'
//
//   'ring' is special: it is built by systems/organicRing.js rather than from
//   a RingGeometry, so it wears the same broken, gooey edge and the same
//   noise sweep every circle drawn around a threat does. It reads three extra
//   keys — `attack` (an entry in CONFIG.fx.attackTypes, which supplies both
//   colour and edge dialect), `arcs` (0 for a closed ring, 4 for a targeting
//   bracket) and the usual `inner`/`outer` — and it is the ONE primitive with
//   a per-instance material. See the note at the build site.
//   unlit    true = MeshBasicMaterial (flat neon, ignores scene lights),
//            false = MeshStandardMaterial (lit — responds to CONFIG.lighting)
//
//   rock     only read by shape:'rock' — a Perlin-displaced icosphere (see
//            systems/rocks.js). Unlike every other shape, ONE asset key means
//            a POOL of geometries: `variants` noise seeds built once, one
//            picked at random per spawn, so a volley is a handful of
//            different stones rather than the same one repeated. Defaults
//            come from CONFIG.rocks; anything here overrides them per asset.
//            { variants, detail, amplitude, frequency, octaves, squash,
//              shade, grit, tumble }
//            `tumble` is radians/sec about one random axis, applied by
//            whichever system owns the mesh — see updateTumble.
// ============================================================================

// ============================================================================
// THE ORCA RIG — shared by all five orca bodies
//
// One family file (Orca_Family_GLB.glb) cut into three animals by
// tools/orca-split.mjs, and each animal used twice: once hostile (a boss) and
// once friendly (the pod the Orca Family card buys). Five ASSETS entries, one
// skeleton, so the chains live here rather than five times over.
//
// EVERY CHAIN BELOW WAS MEASURED, not read — tools/orca-rig-propose.mjs prints
// them and checks each one before it is used. That is not superstition about
// the old rig's junk names; this rig's names are honest and still lie in one
// specific way. `Fin_L1..L4` and `Fin_L5..L8` are the LEFT and RIGHT pectoral
// flippers, both labelled L, and the same is true of `Tail_Fin_L1..L4` against
// `Tail_Fin_L5..L8` for the two fluke lobes. Reading the names would have put
// both pectoral springs on the same side of the animal.
//
// WHAT THE CLIP DOES AND DOES NOT TOUCH matters as much as the chains. The
// swim take animates 14 bones — Spine_Root through Spine10, Tail_01/02 and
// Head — and nothing else. The dorsal, the pectorals and the flukes are
// unanimated, so the spring solver owns them outright with nothing to fight,
// which is exactly the arrangement the old rig had to be coaxed into.
// The giant squid, and the roomiest rig in the game: 86 of its 97 bones drive
// vertices, in ten limb chains that a spring solver can own outright.
//
// MEASURED, like the orca's — tools/check-squid-orientation.mjs walks the
// hierarchy and prints each chain with the vertex count it drives, so a chain
// named here is one that was seen to move geometry. The names happen to be
// honest on this rig (unlike the orca's two flippers both called L), but the
// arrangement is not obvious from them and is worth stating:
//
//   TTC              the artist's abbreviation for the arm chains. Six of them,
//                    5-6 bones each: one Front, two Frontside (L/R), one Back,
//                    two Side (L/R). Together they are the crown.
//   nondeform L/R    NOT non-deforming, whatever the name says — each drives
//                    ~1,000 vertices across seven bones. These are the two long
//                    FEEDING TENTACLES, the pair that reach much further than
//                    the other six, and they are the reason this body reads as a
//                    giant squid rather than as a big octopus.
//   topflapper L/R   the mantle fins.
//   middlebone       the mantle itself. Deliberately NOT given a chain: it is
//                    the body, and springing the body makes the whole animal
//                    wobble rather than making its limbs trail.
//
// EVERY CHAIN IS UNANIMATED BY THE CLIPS WE USE. The file's `Idle` and `flapper`
// takes move the arms a little, but nothing in the set covers a swim or a
// lunge — see the entry below — so the springs have almost nothing to fight and
// the trailing motion is theirs. That is the same arrangement the orca's dorsal
// and pectorals have, arrived at by luck there and on purpose here.
const SQUID_RIG = {
  springChains: [
    // The six arms of the crown, on their own ROLE — `arm`, which nothing else in
    // the game uses.
    //
    // The alternative was to reuse `fin` and raise CONFIG.animation.spring
    // .roleLooseness.fin, and that would have loosened every pectoral, dorsal
    // and tail fin on the roster to make one squid's arms hang right. A role is
    // the unit looseness is keyed on (see springCfgFor in systems/animation.js),
    // so adding one is the extension point rather than a workaround — and an
    // unregistered role degrades to the base spring rather than throwing, so
    // this was safe before the config entry existed.
    //
    // Arms want to be much looser than a fin: a fin is a control surface held
    // against the water, an arm is a rope being towed. `roleLooseness.arm`
    // divides the stiffness and multiplies the lag, which is what makes them
    // stream behind the body's path instead of turning with it.
    { role: 'arm', bones: ['FrontTTC_20', 'FrontTTC001_19', 'FrontTTC002_18', 'FrontTTC003_17', 'FrontTTC004_16', 'FrontTTC005_15'] },
    { role: 'arm', bones: ['FrontsideTTCL_26', 'FrontsideTTCL001_25', 'FrontsideTTCL002_24', 'FrontsideTTCL003_23', 'FrontsideTTCL004_22', 'FrontsideTTCL005_21'] },
    { role: 'arm', bones: ['FrontsideTTCR_43', 'FrontsideTTCR001_42', 'FrontsideTTCR002_41', 'FrontsideTTCR003_40', 'FrontsideTTCR004_39', 'FrontsideTTCR005_38'] },
    // Five bones, not six — the back arm is genuinely one joint shorter, and
    // naming a sixth would cost this chain its spring entirely rather than
    // failing loudly. That exact mistake cost the orca cow her whole dorsal on
    // half of all boss arrivals; see the note on ORCA_RIG below.
    { role: 'arm', bones: ['BackTTC_31', 'BackTTC001_30', 'BackTTC002_29', 'BackTTC003_28', 'BackTTC004_27'] },
    { role: 'arm', bones: ['SideTTCL_37', 'SideTTCL001_36', 'SideTTCL002_35', 'SideTTCL003_34', 'SideTTCL004_33', 'SideTTCL005_32'] },
    { role: 'arm', bones: ['SideTTCR_49', 'SideTTCR001_48', 'SideTTCR002_47', 'SideTTCR003_46', 'SideTTCR004_45', 'SideTTCR005_44'] },
    // The two long feeding tentacles, also `arm`. Seven bones each and they start
    // from a DIFFERENT parent (middlebone002) than the crown does, which is what
    // lets them swing on their own rather than with the arms around them — and
    // being the longest chains on the body, they are where the looseness reads
    // most.
    { role: 'arm', bones: ['nondeformL001_83', 'nondeformL003_82', 'nondeformL004_81', 'nondeformL005_80', 'nondeformL006_79', 'nondeformL007_78'] },
    { role: 'arm', bones: ['nondeformR001_92', 'nondeformR003_91', 'nondeformR004_90', 'nondeformR005_89', 'nondeformR006_88', 'nondeformR007_87'] },
    // The mantle fins — and the only chains here left on `fin`. Their job is to
    // lag slightly, not to stream: they are the surfaces the animal drives with,
    // so an arm's looseness on them would read as a broken wing rather than as
    // something being towed.
    { role: 'fin', bones: ['topflapperL_71', 'topflapperL001_70', 'topflapperL002_69'] },
    { role: 'fin', bones: ['topflapperR_74', 'topflapperR001_73', 'topflapperR002_72'] },
  ],
};

const ORCA_RIG = {
  springChains: [
    // The fluke, starting well up the spine so the whole rear swings. Longer
    // than the old rig's seven-bone chain and it does not need a dedicated tail
    // hip to start from — Spine8 has nothing but tail below it.
    { role: 'tail', bones: ['Spine8', 'Spine9', 'Spine10', 'Tail_01', 'Tail_02'] },
    // The dorsal. Rises on the centreline (x = 0) behind midbody — verified,
    // because a dorsal chain that had picked up a pectoral would look like a
    // fin lagging correctly right up until the animal turned.
    //
    // FOUR BONES, WHICH IS WHAT ALL THREE ANIMALS HAVE. The bull's dorsal runs
    // to Dorsal_Fin6 and the cow's and calf's stop at Fin4 — a real anatomical
    // difference (a bull's fin is the tall straight one, a cow's is shorter and
    // curved) faithfully carried into the rig, and the reason the bull has 52
    // bones against their 50. The shared chain takes the intersection: naming
    // Fin5 cost the cow her entire dorsal spring, silently, on half of all boss
    // arrivals. tools/apex-spring-test.mjs caught it by checking both bodies
    // instead of letting one stand in for the other.
    { role: 'fin', bones: ['Dorsal_Fin1', 'Dorsal_Fin2', 'Dorsal_Fin3', 'Dorsal_Fin4'] },
    // The pectorals, +X and -X. See the note above about both being named L.
    { role: 'fin', bones: ['Shoulder_L', 'Fin_L1', 'Fin_L2', 'Fin_L3'] },
    { role: 'fin', bones: ['Shoulder_L1', 'Fin_L5', 'Fin_L6', 'Fin_L7'] },
  ],
  // STUB — the fluke lobes, deliberately not enabled, for the same reason the
  // old entry gave: they hang off Tail_02 and already ride the tail's trail, so
  // their own chains would lag them a second time.
  //   lobe +X ['Tail_Fin_L1', 'Tail_Fin_L2', 'Tail_Fin_L3']
  //   lobe -X ['Tail_Fin_L5', 'Tail_Fin_L6', 'Tail_Fin_L7']
};

// A real neck, which the old rig only approximated. `Neck` sits between
// Spine_Root and Head and is the parent of nothing else, so leaning it turns
// the head without dragging the pectorals along — the coupling the old entry
// documented as a happy accident is now simply absent, and does not need to be.
// MEASURED PER ANIMAL, which is why this is a function and not a constant.
// `tipLength` walks from the last bone in the chain out to the snout, in the
// BONE'S OWN units — and these models live in a ~700-unit space where the old
// orca lived in a ~2.4-unit one. Carrying the old rig's 0.4 across put the
// effector inside the skull, and the symptom was a head that converged on the
// player so slowly it read as not tracking at all: tools/boss-rig-test.mjs
// measured the cow still 94.7 degrees off four seconds after the player crossed
// her body. The snout offsets are 91.5 / 75.5 / 44.4 for bull / cow / calf,
// measured off the models, and they differ because the animals differ.
//
// `+Y` IS the snout direction on this rig — checked, not assumed: the Head
// bone's local +Y lands on the body's forward axis at dot 1.000 on the bull and
// 0.983 on the cow, whose head sits at a slight downward angle in the bind pose.
const orcaLook = (tipLength) => ({
  head: { bones: ['Neck', 'Head'], tipAxis: '+Y', tipLength },
});

// A JAW WITH FLESH ON IT. `Jaw_Bone` drives 2,094 vertices; the old rig's
// `mouth_015` drove a token few, which is why the orca's bite never read as
// more than a twitch. None of this file's motion is a bite, so it stays
// procedural — see systems/jaw.js.
const ORCA_BITE = { bone: 'Jaw_Rotate', axis: 'x', openAngle: 0.62 };

// --- crabpincer.glb, shared by every crab in the game -----------------------
// THREE assets ride this one binary — the day crab, the ember crab after dark,
// and the king crab boss — and they are separate keys rather than one key with
// a flag for the reason spelled out on enemyEmberCrab: a material is shared
// across every clone of a key, so lighting the boss would light every crab on
// the seabed with it.
//
// What is NOT allowed to differ between them is anything below: the spring
// chains, the pincer and the eye stalks are facts about the FILE, and the claw
// driver and the animation springs resolve them by name off whichever key
// spawned. These used to be copy-pasted per entry and the copies carried a
// standing instruction to keep each other in step, which is a promise a file
// this size does not keep. Shared by reference instead — nothing writes to
// them, and a rig that drifted would fail as stiff legs or a claw that never
// opens rather than as an error.
const CRAB_RIG = {
  axis: 'z',
  // EIGHT legs, not six: this rig models all four pairs as legs where the old
  // one made the rear pair a stub "arm" chain and left it out. Plus the two
  // arms, so ten spring chains against eight.
  springChains: [
    ['leg47L_010', 'leg46L_011', 'leg45L_012', 'leg44L_013', 'leg43L_014', 'leg42L_015', 'leg41L_016'],
    ['leg37L_017', 'leg36L_018', 'leg35L_019', 'leg34L_020', 'leg33L_021', 'leg32L_022', 'leg31L_023'],
    ['leg27L_024', 'leg26L_025', 'leg25L_026', 'leg24L_027', 'leg23L_028', 'leg22L_029', 'leg21L_030'],
    ['leg17L_031', 'leg16L_032', 'leg15L_033', 'leg14L_034', 'leg13L_035', 'leg12L_036', 'leg11L_037'],
    ['leg47R_061', 'leg46R_062', 'leg45R_063', 'leg44R_064', 'leg43R_065', 'leg42R_066', 'leg41R_067'],
    ['leg37R_068', 'leg36R_069', 'leg35R_070', 'leg34R_071', 'leg33R_072', 'leg32R_073', 'leg31R_074'],
    ['leg27R_075', 'leg26R_076', 'leg25R_077', 'leg24R_078', 'leg23R_079', 'leg22R_080', 'leg21R_081'],
    ['leg17R_082', 'leg16R_083', 'leg15R_084', 'leg14R_085', 'leg13R_086', 'leg12R_087', 'leg11R_088'],
    // THE TWO CHELIPEDS, and they are the only chains here that carry a role.
    //
    // Every other chain on this animal is a leg, and a leg has nothing to do
    // but absorb a shove. These two are the ARM systems/crabClaw.js poses — the
    // IK chain runs ShoulderL_039 -> Hand3L_044, which is these bones and their
    // parent — so a hit landing mid-pinch shoves the exact bones the gesture is
    // trying to aim. Measured on the king crab under 12 hits a second: the claw
    // tip sat 9.7 world units from where the pinch alone would have put it, on
    // an arm 7.9 units long. The pinch was playing perfectly and was completely
    // invisible underneath the flinch.
    //
    // Naming the role is what lets the two be told apart: `claw` is stiffer
    // than the shared baseline (CONFIG.animation.spring.roleLooseness), and
    // entities/enemies.js mutes it outright for as long as the claw is striking
    // — see anim.muteSpring, which is how an attack overrides a hit reaction on
    // a creature with no authored flinch clip to out-prioritise.
    { bones: ['Shoulder2L_041', 'Hand1L_042', 'Hand2L_043', 'Hand3L_044'], role: 'claw' },
    { bones: ['Shoulder2R_051', 'Hand1R_052', 'Hand2R_053', 'Hand3R_054'], role: 'claw' },
  ],
};

// --- the chelipeds, as an IK rig --------------------------------------------
// THIS RIG HAS A REAL PINCER, which the crab that came before it did not. The
// wrist forks into two finger chains driving separate geometry — `Hand6` (fixed
// prong) and `Hand5 -> Hand7` (movable) — and rotating the movable one opens the
// tip-to-tip aperture from 9% of finger length to 33%, a measured +277%. So the
// pinch here is a JAW, not the scissor fake systems/crabClaw.js falls back to on
// a claw that cannot open. tools/crab-claw-probe.mjs reprints every number here.
const CRAB_CLAW_RIG = {
  // Bones run along their own local +Y on this rig (every child sits at
  // (0, n, 0) in its parent) — NOT +X, which is what crabwalking.glb used.
  // Getting this wrong points the IK effector sideways out of the wrist and the
  // arm solves toward a spot beside the player.
  tipAxis: '+Y',
  tipLength: 0.06,
  arms: [
    // Rooted at the SHOULDER, which is where an arm actually swings from. That
    // is only safe because systems/crabClaw.js restores the whole chain each
    // frame: this clip keys rotation on 50 of the rig's 126 bones and neither
    // shoulder bone is among them, so a solver that treated the bone's current
    // value as the clip's pose would creep further out on every pinch. Rooting
    // at the first KEYED bone instead sidesteps that and costs half the rear-up
    // — 0.137 of reach against 0.154, and the claw visibly stops lifting.
    { root: 'ShoulderL_039', tip: 'Hand3L_044', jaw: 'Hand5L_047', sign: -1 },
    { root: 'ShoulderR_049', tip: 'Hand3R_054', jaw: 'Hand5R_057', sign: 1 },
  ],
  // The finger hinge, and it needs OPPOSITE signs per side (above): this rig's
  // arms are mirrored in world space rather than in their bone orientations, so
  // one angle would open one claw and close the other. crabwalking.glb needed no
  // signs for exactly the opposite reason. Measured per side, not assumed from
  // the naming.
  jawAxis: 'x',
  // Unused on this model — both arms declare a `jaw`, so the scissor path never
  // runs. Kept so falling back to it stays a config change rather than a code one.
  scissorAxis: 'z',
};

// The eye stalks, for the per-vertex eye glow (systems/biolumSkin.js
// bakeEyeGlow). Base bone first, tip locator last — the ramp is a projection
// onto that line, so the order is the gradient's direction and reversing it
// lights the sockets instead of the eyes.
//
// Dots stripped, as everywhere the game names a bone: the raw glTF calls these
// Eye.1.L_02 and three.js sanitises node names on load.
const CRAB_EYE_STALKS = [
  ['Eye1L_02', 'Eye2L_03', 'Eye3L_04', 'Eye3L_end_099'],
  ['Eye1R_05', 'Eye2R_06', 'Eye3R_07', 'Eye3R_end_0100'],
];

export const ASSETS = {
  ship: {
    model: '/models/furseal.glb',
    fit: 2.6,
    forward: '+Z',
    up: '+Y',
    offset: [0, 0, 0],
    tint: null,
    material: { roughness: 0.55, metalness: 0.05, emissive: 0x0a2233, emissiveIntensity: 0.15 },
    // furseal.glb has UVs but no image, so without this the seal is one flat
    // colour. See systems/noiseShader.js and CONFIG.sealShader.
    noiseShader: true,
    // 11 real clips, so every state gets its own authored animation — no
    // single-clip reuse or procedural fallback needed here. Underwater
    // locomotion uses the water clips; breaching the surface swaps to the
    // land ones. See systems/animation.js for how one-shots interrupt and
    // hand back to locomotion.
    animations: {
      idle: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|water_idle',
      swim: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|swim',
      boost: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|sliding',
      surfaceIdle: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|idle',
      surfaceMove: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|walk',
      strike: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|roll',
      hit: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|ball',
      bark: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|bark',
      death: 'Furseal_Rig|Furseal_Rig|Furseal_Rig|sleep_side',
    },
    // Unused now that every state has a real clip, but kept so a future model
    // swap to an unrigged/unanimated file still degrades to procedural motion
    // rather than freezing. (Bone names are from the OLD seal.fbx rig and
    // won't match this model — that's fine, the resolver just finds nothing
    // and the clips above take precedence anyway.)
    rig: {
      axis: 'y',
      wagChain: ['animT2', 'animT3', 'animT4', 'animT5', 'animT6', 'animT7', 'animT8', 'animT9'],
      headChain: ['Animneck', 'Animhead'],
    },
    // Bones systems/aimRig.js drives or reads. Every bone in this rig runs its
    // length along its own +Y (each child sits at a pure +Y offset from its
    // parent), so `tipLength` walks that far past the last joint to reach the
    // actual end of the limb.
    //
    // `fins` are the two front flippers, listed shoulder-out but WITHOUT
    // `shoulder_*` itself — rotating the shoulder drags the chest skinning
    // with it, and three bones is already more than enough articulation to
    // point a flipper. Their tips are the bullet muzzles — see `muzzleLength`
    // below, which is where the flipper ends rather than where it aims.
    //
    // `head` stops at head_07 rather than continuing into mouth_08: mouth_08
    // is the jaw, and rotating it to aim would leave the seal gaping. The
    // effector is a point out at the snout instead.
    //
    // `anchors` are read-only — world points published each frame for the
    // bubble emitters, no IK.
    //
    // `finL`/`finR` are the ENDS of the two hind flippers, which is where the
    // wake sheds. Measured rather than guessed: the skin `foot_*_0xx` drives
    // runs 0.00 to 0.26 down the bone's own +Y, so +0.24 sits a hair past the
    // trailing edge of the webbing. The tail anchor at the end of `tail02` is
    // 0.16 SHORT of that and off to the middle — it lands on the ankle joint
    // both flippers hang off, so a wake fired from it came out of the base of
    // the fins rather than off their tips.
    aimRig: {
      tipAxis: '+Y',
      // `tipLength` is the AIM effector — deliberately past the skin, since
      // pointing a flipper means straightening it along the aim and an effector
      // short of the tip fights the joint limits for the last few degrees.
      //
      // `muzzleLength` is where the flipper actually ENDS, and is what the
      // flash, the bullet, the club and the fin bubbles come off. Measured on
      // the skin: the vertices `hand_*` drives run 0.00 to 0.187 down the
      // bone's own +Y, so 0.185 sits on the outermost of them. The two were one
      // number until the flash was visibly detached from the flipper.
      fins: [
        { name: 'left', bones: ['uparm_L_012', 'arm_L_013', 'hand_L_014'], tipLength: 0.26, muzzleLength: 0.185 },
        { name: 'right', bones: ['uparm_R_016', 'arm_R_017', 'hand_R_018'], tipLength: 0.26, muzzleLength: 0.185 },
      ],
      head: { bones: ['neck01_05', 'neck02_06', 'head_07'], tipLength: 0.19 },
      // Not IK — this chain gets damped-spring lag so the tail trails the
      // body's turns instead of moving rigidly with the clip. `leg_L/R` are
      // deliberately left out: they're the rear flippers hanging off
      // tail01, and swinging those with the tail would paddle them
      // backwards against the swim cycle.
      tail: { bones: ['tail00_019', 'tail01_020', 'tail02_023'], tipLength: 0.16 },
      anchors: {
        mouth: { bone: 'mouth_08', offset: [0, 0.14, 0] },
        // THE EYE SOCKETS. `eye_L_09` / `eye_R_010` are real bones parented to
        // head_07 that drive real eyeball geometry — 17 and 29 vertices each,
        // a flat disc 0.049 across and 0.003 thick — so these ride the head IK
        // and the swim clip for free. See systems/eyeLights.js for the orbs
        // that sit in them and systems/laserEyes.js for the beams that leave
        // from them.
        //
        // MEASURED, not guessed, by skinning the discs and taking their
        // centroid in each bone's own local frame: (0.000, 0.024, 0.000) for
        // the left and (0.002, 0.025, 0.000) for the right, which is one
        // number for both. The bone ORIGIN is 0.024 short of that — it sits at
        // the rim of the disc, not its middle, so an anchor at [0,0,0] would
        // put the orb on the edge of the eye.
        //
        // The +Z is the lift out of the socket. The disc is set flush into the
        // skull (the skin reaches only 0.005 world units past the eyeball
        // centroid within 0.1 of the eye axis), so 0.006 model units — 0.014
        // world at the seal's 2.36 fit — is proud of the face without floating
        // off it.
        //
        // `normal` is the disc's own facing, which is bone-local +Z on both
        // eyes: the rig is mirrored, so the same local axis points OUT of the
        // face on each side. It is what tells the near eye from the far one in
        // a camera that only ever sees this animal side-on.
        // ON head_07, NOT ON eye_L_09 / eye_R_010, and that is the whole point
        // of these two lines.
        //
        // The seal's eye bones carry a BLINK, and they carry it on all three
        // channels: across the clips their scale runs 0.200 to 1.300, their
        // position over a 0.23 range and their quaternion the full sweep.
        // Anything parented to them is squashed six-fold and shoved about
        // several times a second — which is right for the eyeball geometry
        // they are there to drive, and ruinous for a bead socketed into it.
        // The blink is the animation working; borrowing its bone is the bug.
        //
        // `head_07` is rigid by comparison: position and rotation only, its
        // scale track a flat 1.0 in every clip, and it is already the last
        // bone of the aim rig's head chain — so the eyes still track the
        // cursor, which is the entire feature.
        //
        // MEASURED, not converted by hand: `npm run headsocket` skins the
        // eyeball discs, takes their centroids and re-expresses them in
        // head_07's own space. The result is checked against the old eye-bone
        // anchor at rest and lands 0.0001 (left) and 0.0019 (right) away, with
        // the facings exactly parallel — same socket, different parent.
        //
        // `normal` is the disc's own facing, carried into the same frame. It
        // is what tells the near eye from the far one in a camera that only
        // ever sees this animal side-on.
        eyeL: { bone: 'head_07', offset: [0.0849, 0.1465, -0.0334], normal: [0.7606, 0.6490, -0.0153] },
        eyeR: { bone: 'head_07', offset: [-0.0836, 0.1479, -0.0335], normal: [-0.7606, 0.6490, -0.0153] },
        // Still the tail tip, and still what CONFIG.emitPoints 'tail' fires
        // from. The bubbles no longer use it on this model — see finL/finR
        // above — but it stays the sane fallback for one that has no fin
        // anchors, and starfish are thrown from it.
        tail: { bone: 'tail02_023', offset: [0, 0.16, 0] },
        finL: { bone: 'foot_L_022', offset: [0, 0.24, 0] },
        finR: { bone: 'foot_R_025', offset: [0, 0.24, 0] },
      },
    },
    // The resting breath — see systems/breathe.js. Every field here was
    // MEASURED by rotating the bone and watching where the skin actually went,
    // the same method the biteRig entries use:
    //
    //   chest_04 about its own local X, +0.15 rad  ->  mouth -0.190,
    //     shoulders -0.052, tail +0.081. The whole animal see-saws about the
    //     chest, which is the most a rig with ONE trunk bone and no ribs can
    //     do. `sign: -1` because that positive direction drops the front and a
    //     breath in lifts it.
    //   neck02_06 takes part of it back so the head holds its line.
    //
    // neck02_06 and NOT neck01_05, which is the obvious choice and a trap: the
    // swim clip keys neck01_05 exactly once, and a single-keyframe track is a
    // constant the mixer stops rewriting — so a delta added there would
    // compound forever. chest_04 and neck02_06 are keyed by every locomotion
    // clip, which is what lets the breath be a plain additive rotation.
    breathRig: { chest: 'chest_04', neck: 'neck02_06', axis: 'x', sign: -1 },
    shape: 'cone', // a cone already points +Y, the game's forward axis
    radius: 0.7,
    height: 1.6,
    color: 0x7ad7ff,
    unlit: true,
  },

  // The basic shot: a tumbling stone. Same size and same yellow as the sphere
  // it replaces, so the shot reads exactly as it did — what's new is that it
  // has a form and turns while it flies. Faster tumble than the pickups
  // because it's only on screen for a moment (CONFIG.weapon.life is 1.6s) and
  // needs to show more than one face in that time.
  // THE BASIC PEBBLE. Grey stone, and the hex looks far too dark for that
  // because it is not a display colour — the Look panel carries a glow of
  // ~4.95 on this asset, and `bullet` is UNLIT, so applyColorAndGlow
  // multiplies the colour itself by that instead of driving an emissive
  // channel. This value times the glow is what reaches the screen: measured,
  // 0.72 0.79 0.91, a cool pale grey that clears the bloom threshold without
  // clipping any channel.
  //
  // WHICH IS WHY THE OLD YELLOW WAS NOT REALLY YELLOW. 0xffe066 times 4.95 is
  // (4.95, 3.69, 0.66) — red and green both pinned at 1, so the only channel
  // still carrying any hue was the blue one. It rendered as a warm white, and
  // any hue picked here at that glow does the same thing. If the glow slider
  // ever moves, this needs re-picking with it: they are one setting wearing
  // two names. `npm run glow` is the audit.
  bullet: { shape: 'rock', radius: 0.18, color: 0x6b7078, unlit: true, rock: { tumble: 7 } },
  // THE HOMING MUSSEL — a real shell, cut out of the Spline scene in SeaBed by
  // tools/mussel-split.mjs (npm run mussels). See that file for what the source
  // is and what the export does not carry.
  //
  // IT USED TO BE UNLIT AND ALMOST BLACK, on the reasoning that what you track
  // across the screen is the burning trail (CONFIG.trails.missile.particles)
  // and not the shell. That reasoning held while the shell was a rugby ball at
  // 1.8:1 — there was nothing in the silhouette worth lighting. It has a form
  // now: a flattened teardrop with a seam down the middle and a pointed umbo,
  // and `size 2` in assets.csv puts it on screen at about 1.15 units long
  // against a 2.6-unit seal. So it is LIT, and it wears the `mussel` surface
  // (`noise:mussel` in assets.csv) — the same Perlin-and-banding pair the
  // sharks wear. The trail is still the thing you track at speed; the shell is
  // what you see when one goes past you.
  //
  // WHICH IS ALSO WHY `unlit` HAD TO GO rather than merely being turned down.
  // attachToonShade reads `reflectedLight`, which only the lighting chunks
  // declare, so it refuses an unlit material outright — silently, since
  // injecting there would be a compile error and a compile error renders
  // nothing at all. An unlit mussel would simply never have banded.
  //
  // AXES. The model's nose is +Z and its broad face is normal to +Y. In the
  // side view orientationQuaternion sends model FORWARD to entity +Y (the
  // direction of travel) and the FLANK — forward x up — to entity +Z, which is
  // the camera. So `up: '+X'` is not "which way is up on a mussel": it is the
  // axis that puts f x u on +Y and turns the broad face towards the lens. The
  // intuitive '+Y' presents the shell edge-on and it flies as a 1.5-unit
  // splinter. Same class of choice as `grass` and the yacht above.
  //
  // `fit` is the LONGEST axis in world units, and 0.58 is exactly what the
  // oval it replaces measured (radius 0.16 x 2 x elongate 1.8), so the swap
  // carries no size change with it. The oval stays as the fallback and still
  // has to be legible if the file ever fails to load.
  //
  // NO `tint` HERE, DELIBERATELY, even though the shipped hide (0x2b2f3f) is
  // not the one in the Spline file (0x07070a — a 2.7% albedo, too dark for the
  // toon pass to have anything to band). The lift is baked by
  // tools/mussel-split.mjs instead, and the reason is `musselOpen` below:
  // `tint` repaints EVERY material on a model, and the open shell's whole point
  // is the orange body and pale nacre inside it. Tinting only the closed one
  // shipped for a revision and made the detonation swap a charcoal shell for a
  // black one mid-flash. See that tool for the full note.
  missile: {
    model: '/models/mussel.glb',
    fit: 0.58,
    forward: '+Z', up: '+X',
    shape: 'oval', radius: 0.16, elongate: 1.8, color: 0x07070a, unlit: true,
  },
  // The same animal, gaping — what a mussel becomes at the instant it goes off
  // (systems/musselShell.js). Six meshes and six materials, because the whole
  // point of it is the inside: an orange body and a tan mantle behind pale
  // nacre, none of which exists on the closed shell.
  //
  // `up: '+Y'` where the closed shell takes '+X', and the difference is the
  // reason both exist. The gape opens along model +Y; sending that to the
  // camera would show you the top valve's back, which is the one view of an
  // open mussel indistinguishable from a shut one. '+Y' keeps the hinge in the
  // screen plane so the mouth reads as a mouth.
  //
  // `fit` is 0.6 against the shell's 0.58 because the open model is 3.40 long
  // to the closed one's 3.31 — the same ratio, so the two states come out the
  // same size and the pop is the shell opening rather than the shell growing.
  // What growth there is belongs to CONFIG.missile.shell.pop.
  //
  // No fallback shape: nothing spawns this except the detonation, which checks
  // that the model loaded. A primitive stand-in for "the inside of a mussel"
  // would be a coloured blob appearing at every hit.
  musselOpen: {
    model: '/models/musselopen.glb',
    fit: 0.6,
    forward: '+Z', up: '+Y',
  },
  bounceShot: { shape: 'octahedron', radius: 0.2, color: 0x66ddff, unlit: true },
  // The harp's music note — a real eighth-note glyph, cut out of the Particle
  // Flow bake by tools/note-glyphs.mjs. 32 triangles and no texture at all.
  //
  // The axes are the harp's, and for the same reason: the glyph is authored
  // FLAT in model X-Y with nothing at all in Z, so '+Y'/'-X' is what stands it
  // up facing the camera. Get the `up` sign wrong and a zero-thickness plane is
  // presented edge-on for its whole flight, which looks like the model failed
  // to load rather than like a rotation.
  //
  // `orient: true` on the projectile lines the long axis up with its flight,
  // so the note noses onto the curve as the seeker pulls it round rather than
  // sliding through the arc sideways.
  //
  // The oval stays as the fallback and still earns its place: a note glyph at
  // this size on a fast-moving projectile is a bright smear either way, and the
  // fallback has to be legible if the file ever fails to load.
  musicNote: {
    model: '/models/musicnote.glb',
    fit: 0.85,
    forward: '+Y', up: '-X',
    // Unlit and warm. The glyph ships white so per-instance colour has an
    // identity to multiply into (see systems/noteStorm.js); the PROJECTILE is
    // not instanced and takes its colour here, where it can also be retinted
    // from the T panel.
    tint: 0xffe9a3,
    // The glyph is a zero-thickness plane, so it has to ignore scene lights or
    // it goes dark the moment it turns away from the key — and the T panel's
    // glow slider only reaches past the bloom threshold on an unlit material.
    // The file already declares KHR_materials_unlit and doubleSided; this is
    // the asset layer agreeing with it rather than relying on it.
    modelUnlit: true,
    shape: 'oval', radius: 0.16, elongate: 2.1, color: 0xffe9a3, unlit: true,
  },
  // Orbiting shrimp. `fit` is its size at CONFIG.shrimpRing.scale === 1; the
  // ring multiplies by the live slider value, so the size control still does
  // something now that a model ships (it used to be inert whenever one had
  // been uploaded). The icosahedron stays as the fallback.
  shrimp: {
    model: '/models/shrimp.glb',
    fit: 1,
    forward: '+Z', up: '+Y', // eyes sit at +Z, tail curls back to -Z
    shape: 'icosahedron', radius: 0.3, color: 0xffb0a0, unlit: true,
  },
  // Power-up pickups are rocks too — they sit still waiting to be collected,
  // so a slow turn is the only thing that separates them from the background.
  // Chunkier than the bullet (lower frequency, more squash) so they read as
  // held objects rather than as debris.
  strikeOrb: { shape: 'rock', radius: 0.3, color: 0x4db8ff, unlit: true, rock: { tumble: 1.2, frequency: 1.8, squash: 0.34 } },
  // A LITERAL AIR BUBBLE — and a big one. It wears the same Fresnel film the
  // trap bubble does (see makeShellMaterial) off its own config block, because
  // the two are not the same object: a trap is a small hard capsule read
  // against the fish inside it, this is a soft balloon read against open
  // water, and one set of numbers cannot flatter both.
  //
  // `opacity: 1` because the shader owns the alpha from here (see
  // CONFIG.oxygenBubbleShell.coreAlpha); it stays non-null so the material is
  // still built transparent. Segments are up from the default for the same
  // reason the trap bubble's are — the rim is a silhouette effect and a coarse
  // sphere shows its facets exactly where the brightest line is drawn.
  //
  // The radius is the BUBBLE'S OWN, and it is load-bearing beyond the look:
  // pickups.js widens the collect test by it, so a bubble is taken by touching
  // its skin rather than by reaching its centre. See CONFIG.oxygen.bubble.
  bubbleOrb: { shape: 'sphere', radius: 0.44, segments: 32, color: 0xbfefff, opacity: 1, unlit: true, shell: 'oxygenBubbleShell' },
  rapidFireOrb: { shape: 'rock', radius: 0.3, color: 0xffe066, unlit: true, rock: { tumble: 1.2, frequency: 1.8, squash: 0.34 } },
  // THE LEVEL BLOB, which createVisual never builds. Its body is grown per
  // spawn and its material is its own (systems/levelOrb.js), for the same two
  // reasons the coral's are — the shape is the point, and the colour lives in
  // uniforms that a shared material would beat in lockstep. The entry is here
  // so `levelOrb` is a key assets.csv is allowed to have a row for: that row is
  // the size multiplier the spawner applies, and an asset with no row spawns at
  // 1. `radius` is the collect test's fallback and matches the fit the blob
  // normalises itself to; the colour is never read, because the whole point of
  // the thing is that it does not have one for longer than a quarter note.
  levelOrb: { shape: 'sphere', radius: 0.4, segments: 16, color: 0xffffff, unlit: true },
  // Boats read as dark silhouettes against the sky rather than lit objects —
  // they sit on the horizon line, far away in fiction if not in world units,
  // and a flat dark shape sells that distance better than a fully shaded hull
  // would. `unlit` + a near-black tint means scene lighting can't lift them
  // back out of silhouette; `glow` in the T-menu still works if you want them
  // to catch some light.
  //
  // These hulls are modelled X=length, Y=mast, Z=beam. Side view maps
  // world Y <- forward and world X <- -up, so '+Y'/'-X' is the identity
  // mapping: the boat stays in profile instead of being stood on its end
  // like a creature that swims toward the game's forward axis. Left/right
  // sailing is then just a Y-flip — see updateBoats.
  boat: {
    model: '/models/fishingboat.glb',
    fit: 6,
    forward: '+Y', up: '-X',
    modelUnlit: true, // flat silhouette: scene lights can't lift it
    tint: 0x0a1018,
    outline: { color: 0x9fc6e8, thickness: 0.02 },
    shape: 'box', width: 2.6, height: 0.9, depth: 1.2, color: 0xd9e6f2, unlit: true,
  },
  trawler: {
    model: '/models/trawler.glb',
    fit: 9,
    // `up: '+X'` where the boat uses '-X': this hull was modelled bow-to-stern
    // the opposite way round, so it needs the mirrored basis or it sails
    // backwards. Flipping `up` mirrors both X and Z, which works out to a
    // clean 180° spin about the vertical (determinant stays +1), so normals
    // and the outline shell are unaffected.
    forward: '+Y', up: '+X',
    modelUnlit: true, // flat silhouette: scene lights can't lift it
    tint: 0x0a1018,
    outline: { color: 0x9fc6e8, thickness: 0.02 },
    shape: 'box', width: 3.4, height: 1.3, depth: 1.4, color: 0xffd27a, unlit: true,
  },
  // The man on the boat. Stands on deck, runs about once the hull is holed,
  // and ragdolls when it goes up — see systems/crew.js.
  //
  // He is modelled Y-up and facing +Z (measured: the arms spread along X and
  // the toes point +Z). In side view `forward` lands on world +Y and `up` on
  // world -X (see orientationQuaternion), so standing him up means putting his
  // HEIGHT on forward and his FACING on up: '+Y'/'-Z' leaves him upright and
  // looking along +X. Facing the other way is the same 180° flip a boat gets.
  //
  // `fit` is his standing height in world units and is deliberately NOT scaled
  // with the boat: a trawler is bigger than a rowboat, its crew is not.
  //
  // Two clips, both misspelt in the file, both quoted here exactly as exported
  // — 'idol' is the idle and the walk carries trailing spaces. `boost` reuses
  // the walk so the animation system's own clipTimeScale gives the panic run
  // without a second clip.
  fisherman: {
    model: '/models/fisherman.glb',
    fit: 1.25,
    forward: '+Y', up: '-Z',
    animations: {
      idle: 'Armature|idol',
      swim: 'Armature|walk cycle ',
      boost: 'Armature|walk cycle ',
    },
    outline: { color: 0x9fc6e8, thickness: 0.004 },
    shape: 'box', width: 0.4, height: 1.2, depth: 0.3, color: 0x14202c, unlit: true,
  },
  attractorOrb: { shape: 'sphere', radius: 0.4, color: 0xffcf40, unlit: true },
  // Thrown starfish. Five drawn sea stars rather than one, picked at random
  // per throw — the ability fires fast enough that a single repeated sprite
  // reads as one object flickering across the screen. The octahedron below
  // stays as the fallback for when none of the images load.
  starfish: {
    sprites: [
      '/sprites/starfish-1.webp',
      '/sprites/starfish-2.webp',
      '/sprites/starfish-3.webp',
      '/sprites/starfish-4.webp',
      '/sprites/starfish-5.webp',
    ],
    // GLOWING, and this number is the reason it can be. The five drawings are
    // not calibrated against each other — measured mean linear luminance runs
    // 0.054 (starfish-5) to 0.29 (starfish-4), a factor of five. That gap is
    // invisible on an ordinary sprite and fatal on a glowing one: a single
    // glow multiplier pushes the bright stars past the bloom threshold and
    // leaves the dark ones under it, so the same throw produces one star that
    // blazes and one that does not light at all.
    //
    // Normalising to 0.34 puts every variant a comfortable way above
    // CONFIG.bloom.threshold before the per-asset glow is applied on top, so
    // `glow` means one thing across the whole pool. See normalizeSpriteLuma.
    //
    // Deliberately NOT additive blending, which is the other way to make a
    // sprite look emissive: these are drawn stars with dark outlines and
    // interior shading, and additive throws all of that away — the outline is
    // the drawing. Overdriven colour into the HDR bright-pass keeps the art
    // and puts a bloom halo around it, which is the look being asked for.
    spriteNormalize: 0.34,
    shape: 'octahedron', radius: 0.22, color: 0xff7fb0, unlit: true,
  },
  seagull: {
    model: '/models/seagull.fbx',
    fit: 1.3,
    forward: '+Z', up: '+Y',
    // NO emissive mask, deliberately — a rim instead. This file's own maps
    // never reach the renderer, so the bird is one flat colour and the mask
    // was the only thing giving the silhouette any internal shape. It never
    // paid for itself: the gull is a small shape crossing a bright sky at
    // cruise altitude, where wingtip banding is below the size you can read
    // and a border around the whole shape is not.
    //
    // To bring the mask back, it is one command — tools/make-emissive-masks.mjs
    // against `~/Documents/_C4D/_ASSETS/SEAGULL RAW FILES/Textures/
    // T_Seagull_BaseColor.jpg` with `--pure --lit 0.8`. Keep the 0.8: the art
    // sits at luminance p25=139 / p50=160 / p90=217, so the tool's default
    // pivot of 210 lands ABOVE the ninth decile and thresholds the entire wing
    // fan — the largest island on the sheet — to black, giving a bird that
    // glows on the body with dead wings. 0.8 drops the pivot to 125.
    //
    // The warm rim every companion carries rather than the cold hostile one —
    // see bakalarBoat for why an ability creature never shares a colour with
    // the things hunting you.
    //
    // THICKNESS IS OBJECT SPACE, i.e. the source file's units, and this one is
    // 73.26 units across — the boats' 0.02 would be an invisible rim here.
    // Measured rather than guessed: fit 1.3 over that bbox is a 1.77e-2 fit
    // scale, and with the T-menu size multiplier at 9.54 one object unit is
    // 0.169 world, so 0.71 buys a 0.12-world rim — the same width
    // CONFIG.creatureOutline draws on a shark. It rides the size slider (the
    // shell is baked into the template, before the per-instance multiplier),
    // so a big move on the gull's size wants this renormalised.
    outline: { color: 0xffd27a, thickness: 0.71, glow: 2.4 },
    // One 24.77s "Take 001" with every animation baked end to end (743 frames,
    // keyed on every one) and no range markers. Rather than re-exporting it
    // split, the ranges live here — see buildSubclips(). Frames are against
    // the file's own 30fps.
    //
    // The take, measured per frame off pelvis height, wingspan and body pitch
    // (tail->head, where level flight reads -3.6 degrees):
    //   0-225   grounded idle          400-425  takeoff
    //   230-250 wing flare             430-470  GLIDE, wings held at full span
    //   300-400 ground cycle           470-510  FLAP, exactly one wingbeat
    //   512-558 climb and pitch over   560-610  STOOP, tucked and nose-down
    //   611-615 the plunge itself      616-659  landing, bounce and flare
    //   660-743 landed
    //
    // ONLY THESE THREE RANGES LOOP CLEANLY, and that is why they are these
    // three. Every range here starts and ends on an IDENTICAL pose — measured
    // seam of 0.00 total bone distance, so a repeat is invisible. The ranges
    // this replaced were each cut mid-transition and seamed at 96 (glide), 443
    // (flap) and 515 (dive) bone-units, i.e. every loop snapped through frames
    // out of a neighbouring take: the glide opened on the tail of the takeoff
    // flap and closed on the start of the next one, and the flap was offset ten
    // frames from the wingbeat so it never closed at all.
    //
    // THE DIVE IS 560-610, NOT 615-645. What the old range caught was the
    // landing: at 615 the bird is already on the ground (pelvis 4.76) and over
    // the rest of the range it goes back UP, flaring and hopping. The actual
    // stoop is the held pose before it — wings tucked to a third of full span
    // (25 against 80) and the body pitched 84 degrees nose-down — which the
    // artist animated IN PLACE, with the descent left to whatever drives the
    // bird. 571-599 is the quiet middle of that hold; 600-610 is a dead frozen
    // tail and 611-615 is the five-frame drop, neither of which loops.
    //
    // That baked nose-down pitch is not free — systems/seagull.js has to cancel
    // it while aiming the body down its flight path. See CONFIG.seagullBomb.divePitch.
    subclipFps: 30,
    subclips: {
      seagullGlide: [430, 470],
      seagullFlap: [470, 510],
      seagullDive: [571, 599],
    },
    // The locomotion vocabulary is idle/swim/boost (systems/animation.js), so
    // the three flight states borrow those slots rather than the state machine
    // growing bird-specific names: glide is the low-energy state, flapping the
    // cruise, diving the committed one. systems/seagull.js drives these
    // explicitly by name — it never goes through stateForSpeed().
    animations: { idle: 'seagullGlide', swim: 'seagullFlap', boost: 'seagullDive' },
    shape: 'cone', radius: 0.3, height: 0.7, color: 0xf2f2f2, unlit: true,
  },

  // THE BOWHEAD — the arena sweeper. See systems/whale.js.
  //
  // Built by tools/build-whale.mjs from a hand re-export of the pack's .c4d.
  // Do NOT point this at the pack's own Bowhead_Whale_2009-3.fbx: that file is
  // FBX **6100** (2009), which three.js's FBXLoader and Blender both refuse
  // outright, so it cannot be read by anything in this repo.
  //
  // NO `animations` BLOCK, and that is not an omission. The re-export ships one
  // clip, "Take 001", and it is empty: 0.033s, three channels, and posing the
  // skin across the whole of it moves every sampled vertex by 0.00 units. The
  // build step drops it precisely so nothing here can bind it — a named clip of
  // the right shape would be picked up as a locomotion state and would suppress
  // the procedural wag below, leaving a whale that crosses the arena rigid with
  // no error anywhere. The source never had a swim cycle; its .fbx says the
  // same thing in its own format (`Channel: "Visibility", KeyCount 1`).
  whale: {
    model: '/models/whale.glb',
    // 12 x the 2.6 in assets.csv = 31.2 world units of animal, against a
    // frame 80 wide. Deliberately larger than any boss body (the mosasaur is
    // 27.2, and it is the biggest thing in the game otherwise): the sweep only
    // works as a relief event if the thing arriving is unmistakably not
    // another enemy, and size is the whole of that read at a glance.
    fit: 12,
    forward: '+Z', up: '+Y',
    // Measured, not read off the names. The mouth morphs are centred at z=+66
    // and the blowhole at y=+29, so the head is +Z and the dorsal side +Y;
    // the pectoral fins hang to y=-30, which is the check that settles it.
    //
    // Nose-ward pivot like every other swimmer, and further forward than most:
    // this animal is a third head, and the gulp is measured off the mouth, so
    // rotating about a point near the skull keeps the jaw where the geometry
    // says it is when the body banks.
    pivot: 0.18,
    rig: {
      // THE BEND AXIS, and the one thing on this rig worth measuring twice.
      // Rotating a spine bone about its local z displaces skin along world
      // +Y — a DORSOVENTRAL stroke, which is how a whale swims. Local y gives
      // the lateral sweep of a fish and is what a guess would have picked,
      // since 'y' is this project's default and every fish in the roster uses
      // it. A bowhead swimming like a trout is wrong in a way that reads
      // instantly at this size.
      axis: 'z',
      // Each bone's own length runs along its local +X: every child in this
      // hierarchy sits at a pure +X offset from its parent (Spine2 +11.57,
      // Spine3 +14.00, Spine6 +18.40, Tail +9.83, and so on). Not the +Y
      // default, which would have the spring solver measuring across the body
      // instead of along it.
      boneAxis: '+X',
      // Root to tip, and every one of these drives a contiguous band of the
      // mesh — mean z runs 22.6, 9.3, -11.3, -24.2, -29.8, -52.1, -64.7, -77.3
      // with no gaps and no overlaps, which is what a real spine chain looks
      // like from the weights.
      wagChain: ['Spine1', 'Spine2', 'Spine3', 'Spine4', 'Spine5', 'Spine6', 'Spine7', 'Tail'],
      // A LOOSE BODY. The spring that rides this chain defaults to the `tail`
      // role, which is the unscaled baseline shared by every fish in the game —
      // and at 31 world units that baseline holds the spine nearly rigid, so the
      // whole animal turns as one piece and the fluke tops its stroke at the
      // same moment as the shoulder. A whale reads the other way round: the
      // stroke starts at the shoulder and runs down the body, and the fluke
      // finishes last. See CONFIG.animation.spring.roleLooseness.whaleBody.
      wagRole: 'whaleBody',
      // `Head` is not a neck — it drives 6,594 of the mesh's 8,436 vertices,
      // i.e. the entire forebody. That is right for a bowhead, whose skull is
      // a third of its length, and it is why the headBob it gets is worth
      // having: CONFIG.animation's 0.03 rad at swim is under two degrees, and
      // two degrees of the whole front of the animal nodding into the stroke
      // is the difference between swimming and being towed.
      headChain: ['Head'],
      // THE PECTORALS, and only the pectorals.
      //
      // They hang off Clavicle_L/R, which hang off Skeleton_Root — outside the
      // wag chain entirely — so without these they are welded rigid to a body
      // that is undulating behind them. Exactly the fault the mosasaur's fins
      // had.
      //
      // The two FLUKE lobes (joint16..19 and joint24..27) are deliberately NOT
      // here, for the same reason the orca's are not: they fork off `Tail`,
      // which is the last bone of the wag chain, so they already ride its lag.
      // Springing them again would be a second solver fighting the first.
      // joint19/joint23/joint27 and joint10/joint11/joint15/joint25/joint17
      // drive zero vertices and are pure tips — listing them buys nothing.
      springChains: [
        { role: 'whaleFin', names: ['Clavicle_L', 'Fin_L1', 'Fin_L2'] },
        { role: 'whaleFin', names: ['Clavicle_R', 'Fin_R1', 'Fin_R2'] },
      ],
    },
    // The three shape targets, named by tools/build-whale.mjs — the C4D
    // exporter writes none, so they arrive as 0/1/2 and would otherwise be
    // reachable only by an index that shifts on the next export. systems/
    // whale.js drives `mouthNarrow` and `mouthWide` as a two-stage gape and
    // pops `blowhole` at the surface.
    morphs: { blowhole: 'blowhole', mouthNarrow: 'mouthNarrow', mouthWide: 'mouthWide' },
    // Cold rim, not the warm one the companions wear — this is not an ability
    // and not on your side, it just does not hunt you. Thickness is OBJECT
    // space, i.e. this file's units, and the body is 180.4 of them long: at
    // fit 12 over that box one object unit is 0.0665 world before the 2.6 size
    // multiplier, so 1.1 buys a 0.19-world rim, a little heavier than the
    // 0.12 a shark carries because there is a lot more silhouette to hold.
    outline: { color: 0x9fd8e8, thickness: 1.1, glow: 1.6 },
    // THE FILE IS PURE WHITE. Its one material is an untextured
    // MeshStandardMaterial at #ffffff — not an art choice, just the slot the
    // exporter left behind, and the pack's own 4096x4096 diffuse is never wired
    // to it. Rendered as shipped this is a beluga, not a bowhead: a white
    // 31-unit body against dark water reads as the brightest thing on screen,
    // which is a claim on the eye that a non-threat should not be making.
    //
    // Tinted rather than textured. A 4096 map is a lot of VRAM for an animal
    // that appears for fifteen seconds every minute or so, and at the size it
    // crosses at, the read is the silhouette and the pale rim — not skin
    // detail. Dark slate keeps the outline doing the work.
    tint: 0x3d4b57,
    material: { roughness: 0.72, metalness: 0.0 },
    shape: 'cone', radius: 2.4, height: 14, color: 0x51606b, unlit: true,
  },

  belugaDrone: {
    model: '/models/beluga.fbx',
    // Built from the source diffuse (beluga_whale_diff.png) in the C4D
    // library — the file names it as an absolute D:\ path that cannot
    // resolve, so nothing textured reaches the renderer. That atlas has a
    // GREY background rather than black, which the tool's pivot heuristic
    // does not discount, so it needs a threshold high enough to drop the
    // background and a steep ramp to take the body to white:
    //   --pure --lit 0.5 --blur 3 --slope 20
    // The payoff is the eye, blowhole and open mouth staying dark while
    // the body glows, instead of the whole silhouette flooding evenly.
    texture: { emissive: '/textures/emissive/beluga.png' },
    fit: 1.4,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    animations: { idle: 'Take 001', swim: 'Take 001', boost: 'Take 001' },
    shape: 'icosahedron', radius: 0.5, color: 0xdff6ff, unlit: true,
  },
  // Seal Team escorts — the same low-poly seal as the player's, at a smaller
  // fit so they read as companions rather than clones. Shares the furseal's
  // clip vocabulary (swim/idle) since it's the same rig family.
  sealTeam: {
    model: '/models/sealhelper.glb',
    fit: 1.3,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    // The player's material, copied deliberately rather than left to the
    // file's own. sealhelper.glb ships the same untextured near-white body the
    // furseal does, but at the exporter's defaults (roughness 1, no emissive),
    // so without this the escorts take the light differently from the animal
    // they are escorting — a flatter, chalkier seal, which reads as a
    // different species before the noise pattern even gets a say. These are
    // the DEFAULTS: the Look panel's saved emissive and glow still layer on
    // top, exactly as they do for `ship`.
    material: { roughness: 0.55, metalness: 0.05, emissive: 0x0a2233, emissiveIntensity: 0.15 },
    // The same state vocabulary the player's furseal uses, so an escort reads
    // as the same animal: water clips below the surface, land clips above it,
    // and a roll for the direction-reversal spin. This rig has 7 of the
    // player's 11 clips; the four it lacks map to its nearest equivalent —
    // `run` for boost (no 'sliding'), `clapping` for bark, `sleep` for death
    // (no 'sleep_side'). 'hit' is deliberately left unmapped: escorts are not
    // damageable, so nothing ever triggers it.
    animations: {
      idle: 'Seal_Rig|Seal_Rig|Seal_Rig|water_idle',
      swim: 'Seal_Rig|Seal_Rig|Seal_Rig|swim',
      boost: 'Seal_Rig|Seal_Rig|Seal_Rig|run',
      surfaceIdle: 'Seal_Rig|Seal_Rig|Seal_Rig|idle',
      surfaceMove: 'Seal_Rig|Seal_Rig|Seal_Rig|walk',
      strike: 'Seal_Rig|Seal_Rig|Seal_Rig|roll',
      bark: 'Seal_Rig|Seal_Rig|Seal_Rig|clapping',
      // The same clip again, as its own state — and this is the state it was
      // actually authored for. As `bark` it is a 0.6s stand-in for a sound the
      // escorts have no clip for; as `celebrate` it plays from just before the
      // flippers meet (CONFIG.animation.states.celebrate.startAt) and runs long
      // enough to land the clap. The escorts are the only model in the game
      // with a real celebration clip — the player's is posed procedurally, on
      // a rig this one only resembles. See systems/celebrate.js.
      celebrate: 'Seal_Rig|Seal_Rig|Seal_Rig|clapping',
      death: 'Seal_Rig|Seal_Rig|Seal_Rig|sleep',
    },
    // The player's own surface, not a glow. sealhelper.glb ships no texture
    // either, so the escorts wear the same procedural mottling the furseal
    // does (CONFIG.sealShader) and read as the same animal swimming beside
    // you — which is the whole claim the upgrade makes. See
    // systems/noiseShader.js.
    //
    // They stay UNLIT: setNoiseGlow and setNoiseChargeGlow are scoped to the
    // player's root, so Glow Up! and the charge meter light the seal you are
    // steering and nothing else. Previously the squad wore a `biolumSkin`
    // preset with a different colour per member, which made six escorts read
    // as six unrelated glowing fish rather than as your own seals.
    //
    // ONE `size` CAN COVER BOTH BODIES ONLY BECAUSE THE TWO FILES AGREE ON
    // UNITS. The noise is sampled at the bind-pose vertex, in raw model units,
    // before `fit` reaches a parent's scale — so a model exported at a
    // different scale would show the same setting as confetti or as one flat
    // blob. Measured: furseal.glb is 1.68 units long, sealhelper.glb 1.47, so
    // the escorts carry 37 features down the body against the player's 42.
    // Swap either model for one exported in centimetres and this needs a
    // per-asset divisor, not a nudge of CONFIG.sealShader.size.
    noiseShader: true,
    shape: 'cone', radius: 0.3, height: 0.8, color: 0xbfe6ff, unlit: true,
  },

  eelCompanion: {
    model: '/models/morayeel.fbx',
    // As with the seagull, built from the source diffuse rather than the
    // file. The moray's skin is evenly mottled with no distinct markings, so
    // it needs a much lower threshold and a wide blur or it thresholds into
    // shimmering confetti — regenerate with the flags recorded in the tool.
    texture: { emissive: '/textures/emissive/morayeel.png' },
    fit: 2.4,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    // The file ships 2 clips over the same bones (base motion + what looks
    // like an additive "angle" layer three.js doesn't automatically
    // composite) — using just the base motion clip rather than trying to
    // layer them, since the shared idle/swim/boost controller plays one
    // clip at a time, not blended layers.
    animations: { idle: 'MorayEelRigging|MorayEelRigging|Main|Layer0', swim: 'MorayEelRigging|MorayEelRigging|Main|Layer0', boost: 'MorayEelRigging|MorayEelRigging|Main|Layer0' },
    shape: 'icosahedron', radius: 0.4, color: 0x9fe8ff, unlit: true,
  },
  // `shell` is the Fresnel film — see makeShellMaterial. Opacity is 1 here
  // because the shader owns the alpha now (CONFIG.bubbleShell.coreAlpha is the
  // 0.55 this used to be, and it applies to the middle of the bubble only);
  // it stays non-null so the material is still built transparent.
  // Segments up from the default: the rim is a silhouette effect, and a coarse
  // sphere shows its facets exactly where this draws its brightest line.
  trapBubble: { shape: 'sphere', radius: 0.35, segments: 32, color: 0xaeefff, opacity: 1, unlit: true, shell: true },

  // Bakalar's trawler — the same hull as the hostile `trawler`, deliberately
  // NOT the same entry: this one is yours, so it keeps a warm outline instead
  // of the cold one the enemy boats share, and it can be re-skinned from the T
  // panel without changing what the boats you shoot at look like.
  bakalarBoat: {
    model: '/models/trawler.glb',
    fit: 9,
    forward: '+Y', up: '+X', // mirrored basis, same as `trawler` — see its note
    modelUnlit: true,
    tint: 0x14202c,
    outline: { color: 0xffd27a, thickness: 0.025 },
    shape: 'box', width: 3.4, height: 1.3, depth: 1.4, color: 0xffd27a, unlit: true,
  },

  // THE BOAT BOSS's hull. Pointed at the trawler as a PLACEHOLDER — the real
  // hull is coming, and when it lands this is the one line that changes: drop
  // the .glb into public/models/ and repoint `model`. Everything else about
  // the fight is measured off `fit` and the row's radius, so a bigger or
  // smaller boat needs no other edit.
  //
  // Deliberately its own entry rather than reusing `trawler`: that one is the
  // boat you shoot at for chum, and a boss wearing the same silhouette as
  // scenery is a boss nobody reads as a boss. It also means the boss can be
  // re-skinned from the T panel without touching the hostile fleet.
  bossBoat: {
    model: '/models/trawler.glb',
    fit: 11,
    forward: '+Y', up: '+X', // mirrored basis, same as `trawler` — see its note
    modelUnlit: true,
    tint: 0x2a1a1a,
    outline: { color: 0xff6a5a, thickness: 0.02 },
    shape: 'box', width: 8, height: 2.6, depth: 2.4, color: 0xff6a5a, unlit: true,
  },

  // THE YACHT — the boat boss's other hull (CONFIG.enemies.bossYacht). Same
  // fight, same patterns; what changes is the silhouette and the fact that
  // there are people standing on it.
  bossYacht: {
    model: '/models/yacht.glb',
    // Longer and lower than the trawler's 11, which is the shape of the claim
    // this boat makes. Everything else about the fight is measured off `fit`
    // and the row's radius, so nothing downstream needed a second edit.
    fit: 13,
    // A THIRD BASIS, and not by preference. This hull's length runs down the
    // model's Z where both other boats run along X, so the pair that works for
    // them is wrong here. `forward` lands on world +Y and `up` on world -X (see
    // orientationQuaternion), so: '+Y' stands the model's own up axis up, and
    // '-Z' sends the bow — which is the +Z end, measured off the side view —
    // to world +X. That is the heading systems/bossBoat.js calls rotation.y 0,
    // so the hull faces the way it is sailing instead of backing across the
    // arena.
    forward: '+Y', up: '-Z',
    // WHERE THE WATERLINE IS, and it is not where prepareModel puts it. Left
    // alone the origin lands on the area centroid, y -7.91 — three units above
    // this hull's boot top, so the yacht would float buried to its main deck.
    // That is the cosmetic half. The half that breaks something: systems/
    // crew.js reads "above the water" as local y > 0 when it looks for a deck
    // to stand on, so with the origin three units high the lowest surface it
    // can find is underwater, and every guest is placed on the sea bed of the
    // boat's own coordinate system. 0.829 of the way down from the masthead is
    // the black-to-white line on the hull, measured against the model.
    pivot: 0.829,
    modelUnlit: true, // same reason as `trawler`: scene lights can't lift it
    // Pale, where the trawler is near-black. This is the one boat in the game
    // that ships a full PBR set — base colour, a normal map and an ORM — and a
    // white hull under a gold rim is most of why the subtype reads as a
    // different boat before you have read anything else about it.
    tint: 0xb9c8d6,
    // 0.042, not the 0.02 the other two boats use. Outline thickness is in the
    // SOURCE model's units, and this hull is 40.3 of them long against the
    // trawler's 19.0 — copying the number across would draw a rim half as wide
    // on a boat twice the size.
    outline: { color: 0xffd27a, thickness: 0.042 },
    shape: 'box', width: 9, height: 2.2, depth: 2.4, color: 0xffd27a, unlit: true,
  },

  // THE GUEST. Who is standing on the yacht — see systems/crew.js, which owns
  // both the idle on deck and the ragdoll off it.
  //
  // RIGGED BY tools/rig-guest.mjs, and that is not an implementation detail
  // that can be forgotten. The source file is a statue: 0 skins, 0 clips. The
  // crew ragdoll drives real bones, so loaded as it shipped this model fails
  // buildHumanoidRig, silently falls back to the procedural box body, and the
  // man in the tailcoat is never drawn at all. Re-exporting the source over
  // public/models/ballroomguest.glb without re-running that tool puts the bug
  // straight back, with no error anywhere to say so.
  //
  // He is modelled Y-up and facing +Z, the same as the fisherman, so he takes
  // the same basis: '+Y' puts his height on world +Y and '-Z' leaves him
  // upright and looking along +X.
  //
  // NO `animations`. There is no clip in the file and none was invented for
  // one: crew.js's attachClips finds nothing, leaves body.mixer null, and a
  // guest simply stands still until something hits him. A man at a rail is
  // meant to look like he is doing nothing.
  //
  // `fit` is his standing height and is deliberately NOT scaled with the hull,
  // for the same reason the fisherman's isn't: a yacht is bigger than a
  // trawler, the people on it are not. Slightly over the fisherman's 1.25
  // because this one is not wearing sea boots.
  ballroomGuest: {
    model: '/models/ballroomguest.glb',
    fit: 1.3,
    forward: '+Y', up: '-Z',
    outline: { color: 0xffe7b0, thickness: 0.006 },
    shape: 'box', width: 0.4, height: 1.2, depth: 0.3, color: 0x14202c, unlit: true,
  },

  // THE OTHER GUEST — the one in the suit. The yacht rolls one model per
  // person from CONFIG.enemies.bossYacht's `crewAssets`, so a party is a party
  // rather than the same man printed four times.
  //
  // NOT rigged by tools/rig-guest.mjs, and it is worth saying why given its
  // neighbour above is: this model arrived with a real skeleton — 55 joints, a
  // standard Hips/Spine/Neck/Head chain with fingers, and an idle clip. There
  // is nothing for the rigging tool to do, and running it over this file would
  // throw away a better rig than it can build. The tool is for statues.
  //
  // Same basis as the ballroom guest and the fisherman: modelled Y-up facing
  // +Z, so '+Y'/'-Z' stands him up looking along +X.
  //
  // `fit` is his standing height and is deliberately the ballroom guest's, so
  // two men on the same deck are the same size as each other. Note the source
  // is nearly as WIDE as it is tall (1.75 against 1.84) because the idle has
  // his arms out; `fit` normalises the longest side, which is still the height,
  // so that does not shrink him.
  businessGuest: {
    model: '/models/businessguest.glb',
    fit: 1.3,
    forward: '+Y', up: '-Z',
    // The one clip in the file, quoted exactly as exported. systems/crew.js
    // plays only the idle — see attachClips — so the other two names are the
    // same clip rather than a guess at one that isn't there.
    animations: {
      idle: 'IdleV4.2(maya_head)',
      swim: 'IdleV4.2(maya_head)',
      boost: 'IdleV4.2(maya_head)',
    },
    outline: { color: 0xffe7b0, thickness: 0.006 },
    shape: 'box', width: 0.4, height: 1.2, depth: 0.3, color: 0x14202c, unlit: true,
  },

  // The boat's seeker. Small, bright and pointed the way it is travelling
  // (`orient` on the gun), because reading its TURN is the whole counterplay.
  bossMissile: {
    shape: 'cone', radius: 0.22, height: 0.9, color: 0xffd27a, unlit: true, glow: 1.4,
  },

  // Dumbo octopus — standing in with the cute squid until real dumbo art
  // arrives. `fit` matches the icosahedron's old 0.9 footprint so nothing
  // downstream had to move. Forward is +Y because that's the mantle: squid
  // swim mantle-first with the tentacles trailing, and systems/dumbo.js
  // already turns entity-local +Y to the heading.
  dumboOcto: {
    model: '/models/cutesquid.glb',
    fit: 0.9,
    forward: '+Y', up: '+Z',
    // One 5s take, so every locomotion state shares it — the octopus never
    // stops undulating, and there's nothing else in the file to switch to.
    animations: { idle: 'Take 001', swim: 'Take 001', boost: 'Take 001' },
    // The mask that shipped for this model, unused until now. It confines the
    // glow to the parts that should light up instead of blowing the whole
    // body to white — which is what a high flat glow does to a shaded model.
    texture: { emissive: '/textures/emissive/cutesquid.jpg' },
    shape: 'icosahedron', radius: 0.45, color: 0xffd83d, unlit: true,
  },

  // The harp itself, orbiting the seal.
  //
  // MEASURED, not guessed (tools/inspect-club.mjs reads any glb): 2.31 x by
  // 5.20 y by 0.91 z, so the pillar runs up +Y and the flat face — the plane
  // the strings lie in — is X-Y with Z as the thin axis. That pair of facts is
  // what fixes the two axes below, and they are not the defaults:
  //
  //   forward '+Y'  the long axis, which side view sends to entity +Y (up).
  //   up      '-X'  chosen so `flank` (= forward x up) comes out as model +Z,
  //                 and entity +Z is the camera. Get this wrong by a sign and
  //                 the harp is edge-on — a 0.9-unit sliver — for the whole
  //                 run, which looks like the model failed to load rather than
  //                 like a rotation.
  //
  // No `pivot`: it balances on its centre of mass, which is what an object
  // being carried around a circle should turn about. `pivot` is for swimmers
  // that lead with the head.
  harp: {
    model: '/models/harp.glb',
    // 1.6 world units tall against the seal's 2.6 — a carried instrument, and
    // deliberately under the animal holding it.
    fit: 1.6,
    forward: '+Y', up: '-X',
    // The file is one flat white MeshStandardMaterial at roughness 0.97, with
    // UVs but no image — the same situation the seal is in. Left as-is it is a
    // matte white blob, so the colour is tinted on and the roughness dropped
    // far enough for the key light to put a highlight down the pillar as it
    // turns. Gold rather than pale for the bloom's sake: the bright-pass reads
    // luminance, and a warm ramp carries where a cold one barely registers.
    tint: 0xffcc66,
    material: { roughness: 0.3, metalness: 0.65, emissive: 0x2a1c04, emissiveIntensity: 0.35 },
    // The fallback, and it earns its place — a harp is, at a glance and at this
    // size, a triangle, and a three-sided cone is the only primitive here that
    // reads as one. `unlit: false` to match the model: this thing swings through
    // the full depth of the orbit ring, and a flat neon triangle would give away
    // that it has no thickness at the moment it presents its edge.
    shape: 'cone', radius: 0.5, height: 1.3, segments: 3,
    color: 0xffd479, unlit: false,
  },

  // Octopus Grabber — the reeling companion, standing in with the same cute
  // squid the dumbo borrows. A SEPARATE entry rather than a reuse of
  // `dumboOcto` for the reason `bakalarBoat` is separate from `trawler`: the
  // two octopuses do opposite things and are both on screen at once, so they
  // have to be re-skinnable and re-tintable apart from each other. Cooler and
  // darker than the dumbo's yellow so a glance tells them apart.
  //
  // The ARMS are not in this entry. They're procedural curves drawn by
  // systems/octoGrab.js from CONFIG.octoGrab.arm* until the rigged arm art
  // lands — see that file's header.
  octoGrabber: {
    model: '/models/octopus_rig.glb',
    // Sized off the ARMS, not off taste. At this fit one tentacle measures
    // ~4.4 world units root to tip, which is what makes CONFIG.octoGrab.reach
    // achievable without the octopus having to be absurd — the first pass sat
    // at 2.6 (a 2.5-unit arm) against a configured 8.5 grab radius, so every
    // grab was clamped out and the companion did nothing at all. Getting 8.5
    // honestly would have needed fit ~8.9, i.e. an octopus nine units wide
    // next to a seal whose hit radius is 1.
    fit: 4.6,
    // Measured, not guessed — see tools/check-octopus-orientation.mjs. The
    // arms radiate around the model's Y axis, so Y has to point at the camera
    // or they reach into and out of the screen instead of across it. This
    // basis puts 3.08 x 1.94 units of arm spread in the screen plane against
    // 0.96 of depth, with the mantle leading +Y (the travel direction).
    //
    // Deliberately NOT the squid's '+Y'/'+Z': that convention on this rig
    // splays the arms into the screen (0.96 across, 3.08 deep).
    forward: '-Z', up: '-X',
    // No clips at all — this is a bare rig. Everything it does is procedural,
    // driven from systems/octoGrab.js: the head chain steers and propels, the
    // arms dangle or reach. That is why there is no `animations` block here
    // and why the system never builds an animation controller for it.
    tint: 0xb07ad0,
    outline: { color: 0xe0b0ff, thickness: 0.02 },

    // The six arms and the mantle, each named by its ROOT and TIP rather than
    // by listing all 19 bones. The chains are unbranched single-child runs, so
    // the middle is walkable at load (see systems/octoGrab.js buildArm) and
    // 114 hand-typed bone names is 114 chances to typo one.
    //
    // Verified against the file: 128 bones, 6 chains of 18 driven bones each,
    // a 3-bone mantle on the midline, and 4 face bones. Every `*_end_*` bone
    // carries ZERO skin weight — they drive no vertices at all, which is
    // exactly what makes them usable as pure target locators.
    armRig: {
      tipAxis: '+Y',
      arms: [
        { root: 'Bone001_06', tip: 'Bone018_end_0119' },
        { root: 'Bone019_024', tip: 'Bone036_end_0120' },
        { root: 'Bone037_042', tip: 'Bone054_end_0121' },
        { root: 'Bone055_060', tip: 'Bone072_end_0122' },
        { root: 'Bone073_078', tip: 'Bone090_end_0123' },
        { root: 'Bone091_096', tip: 'Bone108_end_0124' },
      ],
      // The mantle. Short (3 driven bones), on the midline, and the only chain
      // whose skin-weight centroids all sit at x=0 — which is how it was told
      // apart from the arms rather than by its number.
      head: { root: 'Bone110_03', tip: 'Bone111_end_0118' },
    },

    shape: 'icosahedron', radius: 0.55, color: 0xb07ad0, unlit: true,
  },

  // THE POD — an actual family, which is what the card has always been called.
  //
  // Three bodies rather than three copies of one: the bull leads, the cow
  // flanks, the calf brings up the rear (systems/orca.js picks by slot). They
  // are the same three animals the bosses are cut from, wearing the warm
  // friendly outline every companion uses instead of the cold hostile one —
  // the same split `bakalarBoat` makes, and the reason these are separate
  // entries rather than a flag on the enemy ones.
  //
  // A shade smaller than the hostile bodies — a family, not a boss — and the
  // calf smaller again, because a calf that matched its mother would just read
  // as a third adult swimming in a slightly odd formation.
  orcaFriendBull: {
    model: '/models/orca_male.glb',
    fit: 4.4,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    // NO `animations` MAPPING, deliberately. The file carries one clip, and
    // systems/animation.js reuses a lone clip for every state at a different
    // playback rate (rule 2 in its header) — so idle, swim and boost come out
    // of this one cycle, cruising and charging at different speeds. Naming a
    // clip here would opt out of that and pin all three to one rate.
    rig: ORCA_RIG,
    lookRig: orcaLook(91.5),
    // NO `outline` HERE ANY MORE. It said `{ color: 0xffd27a, thickness: 0.022 }`,
    // and thickness on an asset def is OBJECT space — 0.022 on a model whose
    // source units run to 686 is a rim three thousandths of a percent of the
    // body, which is to say invisible. The escorts are on CONFIG.companionOutline
    // now, whose thickness is WORLD units divided by each model's own scale, so
    // the bull, the cow and the calf finally wear the same rim as each other.
    shape: 'icosahedron', radius: 1.1, color: 0x2c3a4a, unlit: true,
  },
  orcaFriendCow: {
    model: '/models/orca_female.glb',
    // The source animals' own proportions, carried across: measured on the
    // family file the cow is 0.85 of the bull's length and the calf is 0.50.
    // `fit` normalises every model to a target length, so without this the
    // three would arrive identical and the family would read as triplets.
    fit: 3.74,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    rig: ORCA_RIG,
    lookRig: orcaLook(75.5),
    // NO `outline` HERE ANY MORE. It said `{ color: 0xffd27a, thickness: 0.022 }`,
    // and thickness on an asset def is OBJECT space — 0.022 on a model whose
    // source units run to 686 is a rim three thousandths of a percent of the
    // body, which is to say invisible. The escorts are on CONFIG.companionOutline
    // now, whose thickness is WORLD units divided by each model's own scale, so
    // the bull, the cow and the calf finally wear the same rim as each other.
    shape: 'icosahedron', radius: 1.05, color: 0x2c3a4a, unlit: true,
  },
  orcaFriendCalf: {
    model: '/models/orca_calf.glb',
    fit: 2.2,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    rig: ORCA_RIG,
    lookRig: orcaLook(44.4),
    // NO `outline` HERE ANY MORE. It said `{ color: 0xffd27a, thickness: 0.022 }`,
    // and thickness on an asset def is OBJECT space — 0.022 on a model whose
    // source units run to 686 is a rim three thousandths of a percent of the
    // body, which is to say invisible. The escorts are on CONFIG.companionOutline
    // now, whose thickness is WORLD units divided by each model's own scale, so
    // the bull, the cow and the calf finally wear the same rim as each other.
    shape: 'icosahedron', radius: 0.8, color: 0x2c3a4a, unlit: true,
  },

  // Scallop Squirter. Borrowing the oyster hull — both are bivalves and at
  // this camera distance the silhouette reads correctly; the real Noble
  // Scallop model in SeaBed is still zipped. Tinted coral so it can't be
  // mistaken for the oyster ENEMY it shares geometry with.
  scallopShell: {
    model: '/models/oyster.glb',
    texture: { emissive: '/textures/emissive/oyster.jpg' },
    fit: 0.95,
    forward: '+Z', up: '+Y',
    tint: 0xff9a6a,
    shape: 'icosahedron', radius: 0.42, color: 0xff9a6a, unlit: true,
  },

  // RAZOR CLAM. A thin chrome rectangle, and deliberately not a model: the
  // whole look is the fake environment sweeping across a warped surface (see
  // makeChromeMaterial), which needs nothing but normals, and a real shell
  // model would only get in the way of a silhouette that has to stay legible
  // at ten blades on screen going in ten directions.
  //
  // `shape: 'blade'` builds a POOL of slightly different warped rectangles
  // rather than one — see getBladeGeometry for why that cannot live in the
  // material. `radius` is not used by the geometry (the blade block below owns
  // the dimensions); it is here because the outline and glow paths read it.
  razorBlade: {
    shape: 'blade', radius: 0.22, color: 0xdfe9f5, unlit: true, chrome: true,
    blade: {
      // A shell rather than a scalpel: the razor clam is long. Depth is
      // genuinely thin, which is what makes the twist below worth having —
      // the near face and the far face fall on opposite sides of the horizon.
      width: 0.17, length: 1.1, depth: 0.05,
      // Enough segments for the bow and the twist to be curves rather than
      // creases. Ten is already past the point where more of them changes the
      // silhouette; below about six the twist reads as a fold.
      segments: 10,
      variants: 7,
      taper: 0.34,
      bow: 0.1,
      twist: 0.55,
      grit: 0.1,
    },
  },

  // Oyster Blaster's payload. Both are unlit glowing spheres rather than
  // models on purpose: a pearl is a highlight, and any baked shading on a
  // thing this bright clips to flat white in the composite anyway.
  pearl: { shape: 'sphere', radius: 0.4, color: 0xfff3d6, unlit: true },
  pearlBomblet: { shape: 'sphere', radius: 0.2, color: 0xfff0c0, unlit: true },

  // Bakalar's voicemail bomb — a fat dark canister with a warm blinking
  // light, built as a shape rather than a model so the blink can drive its
  // colour directly (see systems/bakalar.js).
  voicemailBomb: { shape: 'sphere', radius: 0.72, color: 0x2a2118, unlit: true },

  // The fin-tip club (systems/club.js). Procedural for now — a stretched oval
  // reads as a length of driftwood at the size this thing swings at, and every
  // number the weapon uses is in CONFIG.club rather than in the geometry.
  //
  // Built to receive an uploaded model, which is what the shape below is a
  // placeholder for:
  //   * `fit` is the club's length at scale 1, and is deliberately the same
  //     number as CONFIG.club.length — the hitbox is the config value, so a
  //     model normalised to anything else would swing a stick visibly longer
  //     or shorter than the one doing the hitting.
  //   * `oval` stretches along +Y, which is art-forward, so the shaft already
  //     lies along the direction club.js rotates it to. An imported model that
  //     comes out crossways wants `forward: '+Y', up: '-Z'` instead.
  //   * where the GRIP sits along the model is a property of the art, not of
  //     the weapon, so it's CONFIG.club.gripOffset rather than an offset here.
  // THE FOUR CLUBS. One model, four entries — see clubVariantAsset below.
  //
  // Separate asset KEYS rather than one key tinted at spawn, and that is the
  // point of the arrangement: a key is the unit the T-menu uploads against and
  // the unit assets.csv sizes, so each variant already has its own row waiting
  // for its own model. Until that art exists they all name the same file and
  // differ only in colour, which is enough to tell them apart in the water and
  // is a one-line change per variant later.
  //
  // `tint` is doing the work, and it is NOT the `color` field below it:
  // `color` only ever reaches the procedural fallback SHAPE. A loaded model
  // with no tint renders in its own file material, which for club.glb is
  // untextured pure white lit by the scene — which is exactly why these could
  // not be seen.
  club: {
    model: '/models/club.glb',
    // THE SHAFT is driftwood on every variant — a club is a club, and what
    // tells them apart is the business end. `headTint` paints only the head
    // (see paintHeadTint); `headFrom` is measured, not eyeballed: 0.6 is where
    // this model's shaft flares from radius 0.015 to 0.028.
    tint: 0x8a6b47,   // driftwood
    headTint: 0x6f5436, // base club: a darker band of the same wood
    headFrom: 0.6,
    modelUnlit: true, // flat, so scene lighting can neither wash it out nor black it
    // Thickness is in SOURCE units, and this model is 0.5 long by 0.07 across
    // — the boats' 0.02 would be a rim a third the width of the shaft.
    // Measured for this file rather than copied from another one.
    outline: { color: 0x1a1208, thickness: 0.006 },
    // DERIVED, not copied. This was the literal 2.2 while CONFIG.club.length
    // was also 2.2, which is fine right up until the length moves — and now
    // that weapons.csv owns the reach it moves without anyone touching this
    // file. Reading it keeps the two from ever disagreeing. Safe at module
    // scope: config.js has no import back to here, so CONFIG (and the path
    // table already applied over it) is built by the time this evaluates.
    fit: CONFIG.club.length,
    // MEASURED, not guessed (tools/inspect-club.mjs): the shaft lies along z,
    // spanning -0.5 (the fat HEAD) to 0 (the grip), so grip -> head points
    // down -Z. That is the club's "forward", because forward is the direction
    // the weapon is swung.
    forward: '-Z', up: '+Y',
    // AND THIS IS THE WHOLE ATTACHMENT. createVisual recentres every model on
    // its centre of mass, which for a club is a third of the way up the shaft
    // — hang that off a fin and the flipper grips the weapon by its waist.
    // `pivot` is measured from the nose, so 1 is the far end from the head:
    // the grip. The club now rotates about the point the seal is holding.
    pivot: 1,
    // radius * elongate * 2 == CONFIG.club.length, derived for the same reason
    // `fit` is. The fallback shape is sized to the same reach the model is
    // fitted to, so the wood you see is the reach that hits either way.
    shape: 'oval', radius: CONFIG.club.length / 10, elongate: 5, color: 0x8a6b47, unlit: true,
  },

  // Strike shrapnel: small, pale, and short-lived. Reads as bone rather than
  // as another bullet, which matters when a dash through a school throws
  // dozens of them at once.
  shrapnel: { shape: 'octahedron', radius: 0.14, color: 0xfff4e0, unlit: true },
  enemyBullet: { shape: 'sphere', radius: 0.15, color: 0xff7766, unlit: true },

  // --- what a boss shoots (see systems/bossPerks.js) ------------------------
  // Both are spawned with `orient: true`, so the elongation runs along the
  // direction of travel: a beam is a streak pointing where it is going and a
  // barrel noses over as it goes.
  //
  // A LONG THIN BOLT, not a beam that exists for one frame. An instant
  // hitscan line is unreadable on a body the size of a boss — by the time the
  // player has seen it they have taken it — so the eyebeam fires something
  // that TRAVELS, and the shape is what sells it as light rather than as
  // another rock.
  bossBeam: { shape: 'oval', radius: 0.12, elongate: 5, color: 0xff5a3c, unlit: true },
  // Dark and dull against everything else the boss throws, on purpose: a
  // barrel is the one projectile the player is meant to read as an OBJECT
  // sitting in the water rather than as an attack in flight.
  bossBarrel: { shape: 'oval', radius: 0.36, elongate: 1.4, color: 0x7a5230, unlit: true },

  // --- THE YACHT'S ORDNANCE — banded rolls of hundreds ----------------------
  //
  // The yacht throws money. Mechanically it is the same barrel and the same
  // seeker every boat boss fires (see CONFIG.enemies.bossYacht `ordnance`, and
  // the note in systems/bossBoat.js) — what changes is entirely what the thing
  // in the water looks like, because a yacht shelling you with oil drums was
  // the trawler's fight wearing a nicer hull.
  //
  // FOUR ROLLS AND NOT ONE. The source pack is a single merged mesh of four
  // rolls lying in a pile; `npm run split` cuts it into four files, welds each
  // roll back to its own end caps, and turns every one of them to point down
  // +Y — so all four are interchangeable in a gun slot and the pair the yacht
  // names is a choice rather than the only thing that would fit. See
  // tools/split-islands.mjs for why the cut is by CONTAINMENT and not by
  // overlap, and why the axis comes off the normals.
  //
  // `fit` is the one number here that is not taste: each is set to the length
  // of the procedural shot it replaces (the barrel's oval is 1.0 units end to
  // end, the seeker's cone is 0.9), so the swap changes what the player is
  // dodging and not how big it is. The gun's own `radius` — what it can hit
  // you with — is untouched in either direction.
  //
  // LIT, unlike every other projectile in the game, and deliberately: these
  // read as OBJECTS thrown into the water rather than as bolts of light, which
  // is the same call `bossBarrel` makes one line above with `unlit: true` and a
  // dull brown. The bills carry their own colour and the trail supplies the
  // glow, so nothing here has to be overdriven to be seen.
  //
  // AND THEY LIGHT UP WEARING THEIR OWN PRINT. `emissiveFromMap` hands the
  // model's base-colour texture straight to the emissive slot, which is the one
  // way to make money GLOW and still look like money: a flat emissive colour is
  // multiplied over the whole surface, so the harder it glows the more of the
  // banding it eats, and at the intensity that reads across a fight the roll is
  // a green pill with a trail on it. Lit from its own art, the bands are the
  // brightest thing on it and the paper between them stays dark.
  //
  // `emissiveIntensity` here is the RESTING level, and it is what the Look
  // panel's glow slider writes. On the two rolls the yacht actually fires it is
  // then multiplied every frame by the beat pulse — CONFIG.emissivePulse, see
  // systems/emissivePulse.js — so this number is the height of the whole thing
  // and the pulse is its shape. moneyRoll2 and moneyRoll4 have no pulse row for
  // the same reason they have no trail: nothing fires them.
  //
  // `forward: '+Y'` is the cylinder axis, which is what the splitter aligned
  // them to. On a gun with `orient: true` that flies the roll END-ON, like a
  // shell; a gun that wants it broadside and tumbling turns `orient` off and
  // lets systems/rocks.js spin it instead.
  moneyRoll1: {
    model: '/models/moneyroll1.glb',
    fit: 1,
    forward: '+Y', up: '+Z',
    emissiveFromMap: true,
    // Paper, not metal. A high roughness keeps the key light off the curved
    // side as a broad sheen instead of a hot line, which at this size would be
    // the only thing on screen and would read as chrome.
    material: { roughness: 0.85, metalness: 0, emissiveIntensity: 0.8 },
  },
  moneyRoll2: {
    model: '/models/moneyroll2.glb',
    fit: 1,
    forward: '+Y', up: '+Z',
    emissiveFromMap: true,
    material: { roughness: 0.85, metalness: 0, emissiveIntensity: 0.8 },
  },
  moneyRoll3: {
    model: '/models/moneyroll3.glb',
    fit: 0.9,
    forward: '+Y', up: '+Z',
    emissiveFromMap: true,
    material: { roughness: 0.85, metalness: 0, emissiveIntensity: 0.8 },
  },
  moneyRoll4: {
    model: '/models/moneyroll4.glb',
    fit: 0.9,
    forward: '+Y', up: '+Z',
    emissiveFromMap: true,
    material: { roughness: 0.85, metalness: 0, emissiveIntensity: 0.8 },
  },

  // A BONE, thrown out of a man being eaten. Not a creature and not a pickup:
  // nothing ever spawns one of these as a visual — systems/gore.js takes the
  // GEOMETRY out of it once, at the first meal, and everything after that is
  // instanced. It is an ASSETS entry purely so the loader brings it in with
  // everything else and so a replacement can be dropped over it the usual way.
  //
  // WHICH IS ALSO WHY IT HAS NO assets.csv ROW AND NO `fit`. Both of those set
  // how big a thing spawns, and the gore pool centres and normalises every
  // shape it takes in — a bone comes out at CONFIG.gore.pieces.size times the
  // MAN'S height and nothing else can reach it. See the note on normalise().
  //
  // The file is one mesh, so it is one shape: sixteen identical femurs unless
  // something else varies them, which is what `lengthJitter`/`girthJitter` and
  // the flesh lumps in CONFIG.gore.pieces are for. A pack holding several
  // different bones as several meshes would need none of that — every mesh
  // becomes its own shape.
  gorebone: {
    model: '/models/bone.glb',
    // Bone is not wet and not metal. High roughness so the key light lands as
    // a broad sheen rather than the hot specular line that would make a
    // tumbling piece read as chrome.
    material: { roughness: 0.86, metalness: 0 },
    // What the pieces are tinted. The file ships a white material, so without
    // this every bone would come out the flat white of the brightest thing in
    // the game — see `boneColor` in CONFIG.gore.pieces, which this is read
    // through by assetBaseColor.
    color: 0xe4dcc4,
  },

  enemyShark: {
    model: '/models/shark.glb',
    fit: 3.8,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z',
    up: '+Y',
    // shark.glb ships ZERO animation clips but a full 40-bone skeleton, so
    // it used to hang in the water like a prop. These names turn on the
    // procedural sine wag (CONFIG.animation.states.*.wag*) plus the spring
    // layer over it (CONFIG.animation.spring), which together give it a swim
    // cycle, lag on turns, and a hit reaction — see systems/animation.js.
    //
    // axis 'x' is not a guess: every spine bone's local X maps exactly to the
    // model's own X (verified against the file), and model X is the flank
    // axis, so bending about it moves the body in its VERTICAL plane. That's
    // the plane a side-view camera can actually see. A real shark bends
    // side-to-side, which here would be straight into the screen and
    // invisible.
    //
    // The chain starts at spine_1 rather than pelvis_03: pelvis carries the
    // head, both pectoral fins and the dorsal, so rotating it swings the
    // entire front of the animal instead of undulating the body.
    rig: {
      axis: 'x',
      wagChain: [
        'spine_1_04', 'spine_2_05', 'spine_3_06', 'spine_4_07', 'spine_5_08',
        'spine_6_09', 'spine_7_010', 'spine_8_011',
        'unused_valvebipedcaudal01_012', 'unused_valvebipedcaudal02_013',
        'unused_valvebipedcaudal03_014',
      ],
      headChain: ['head_neck_lower_020', 'head_neck_upper_021'],
      // FINS. The wag chain above undulates the spine, but every fin on this
      // model hangs off `pelvis_03`, which the wag chain deliberately does NOT
      // include — so until now the fins were welded to the body and the only
      // thing moving was the spine behind them. These give each one its own
      // lag, which on a creature with no animation clips at all is the whole
      // of the motion they have.
      //
      // Nothing here is driven by the sine wag, so a fin only moves when the
      // BODY does: the spring measures its bone directions in world space, and
      // a turn swings them. That is exactly the read wanted — fins that trail
      // through a turn and settle after it.
      //
      // Verified against the file: each is a clean single-child chain ending on
      // a bone that still has an `_end` child, so the solver reads its tip
      // direction from that child rather than the tipLength fallback.
      springChains: [
        // The lower caudal lobe. Forks off spine_8_011, which is mid-wag-chain,
        // so it already inherits some of the spine's motion — this adds its own
        // lag on top, which is right for a lobe that flexes separately from the
        // upper one.
        { role: 'fin', bones: ['unused_valvebipedcaudal_lower01_015', 'unused_valvebipedcaudal_lower02_016'] },
        { role: 'fin', bones: ['fin_pectoral_l_026', 'unused_valvebipedl_pectoral02_027'] },
        { role: 'fin', bones: ['fin_pectoral_r_024', 'unused_valvebipedr_pectoral02_025'] },
        { role: 'fin', bones: ['fin_dorsal_018', 'unused_valvebipeddorsal02_019'] },
      ],
      // STUB — the pelvic/anal pair, ['unused_valvebipedl_buttfin_00'] and
      // ['unused_valvebipedr_buttfin_017'], not enabled. Each is ONE bone above an
      // `_end` leaf, and the solver needs two DRIVEN bones. Including the `_end`
      // to make up the count would rotate a bone the exporter emitted as a pure
      // direction marker, which is not what it is for.
    },
    // HEAD-LOOK — points the snout at whatever this shark is chasing, via the
    // CCD chain in systems/ikChain.js. See systems/headLook.js and
    // CONFIG.enemyLook. Same two bones the procedural rig uses above, and
    // deliberately NOT `head_jaw_022`: rotating the jaw to aim leaves the
    // shark gaping, exactly as the seal's chain stops before `mouth_08`.
    //
    // tipAxis is '-Z' here, not the '+Y' every other rig in this project
    // uses. Measured, not assumed: local -Z on head_neck_upper_021 lines up
    // with the model's forward at dot 0.87, while +Y comes out at -0.49. The
    // 0.87 rather than ~1.0 means the effector sits a little off the true
    // nose, so the aim carries a small constant bias — invisible at this bend
    // cap, which stops the head well short of ever fully aligning.
    lookRig: {
      head: { bones: ['head_neck_lower_020', 'head_neck_upper_021'], tipAxis: '-Z', tipLength: 0.35 },
    },
    // BITE — the jaw the head-look chain deliberately stops short of. This
    // file has no clips whatsoever, so the snap is entirely procedural; see
    // systems/jaw.js.
    //
    // All three values here were MEASURED off the file, and the method is the
    // same for every biteRig in this project, so it's written out once here:
    //
    //   bone       the one bone under the skull that carries the lower jaw.
    //   axis       a jaw hinges about the animal's FLANK axis (forward x up,
    //              which for this model's '+Z'/'+Y' is model -X). Of the three
    //              local axes of head_jaw_022, local X maps to model (1,0,0) —
    //              dot 1.000 with the flank axis, against 0.000 for the other
    //              two. So there is no ambiguity about which one it is.
    //   openAngle  SIGNED, and the sign is the actual finding. Rotating +theta
    //              about local X carries the model's forward direction toward
    //              -up (the cross product comes out at -1 along up), i.e. the
    //              jaw swings DOWN and the mouth opens. On the great white and
    //              mightymeg the same test comes out the other way and their
    //              angles are negative — which is why this is per asset rather
    //              than one constant in the driver.
    //
    // The magnitude is a look, not a measurement: 0.55 rad is ~31 degrees,
    // which reads as a real gape at this fit without the lower jaw tearing
    // through the skinning. It's on a tuner slider if it wants pushing.
    biteRig: { bone: 'head_jaw_022', axis: 'x', openAngle: 0.55 },
    shape: 'cone',
    radius: 0.8,
    height: 2.4,
    color: 0x8fa3b0,
    unlit: true,
  },
  // Same source file as enemyShark, loaded as its own template so it gets an
  // independent material — materials are shared across clones of one asset
  // key, so giving the shark a strong glow without a separate entry here
  // would light up every regular shark too.
  enemyFish: {
    model: '/models/fish.glb',
    texture: { emissive: '/textures/emissive/fish.jpg' },
    fit: 0.9,
    pivot: 0.15, // turn about the head, not the belly
    forward: '-X',
    up: '+Y',
    shape: 'icosahedron',
    radius: 0.35,
    color: 0xffb347,
    unlit: true,
  },

  // --- predators (behavior:'hunt' in CONFIG.enemies — eat prey-tagged fish) ---
  //
  // The sea otter used to sit at the top of this block. It is gone: the
  // creature, its row in enemies.csv, its row in assets.csv, its death cause,
  // and now `/models/otter.glb` and `/textures/emissive/otter.jpg` too — they
  // sat unreferenced in public/ for a fortnight, which is not free: vite copies
  // public/ wholesale, so an unloaded model is still a model every player
  // downloads. Both are in git history if the otter ever comes back.
  enemyMegalodon: {
    model: '/models/megalodon.glb',
    fit: 7.0,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y', // was '-Z' — verified backwards via axis-marked silhouette

    // 4 real clips in this file — the best-equipped predator: a genuinely
    // slower idle vs swim vs a distinct sprint clip, not speed-scaled reuse.
    //
    // And the ONLY model in the roster with a real authored bite. "metarig|
    // Bite" is 1.30s over 32 tracks and does key jaw_016, so this one hunter
    // needs no procedural jaw — it gets the `bite` one-shot instead, and
    // entities/enemies.js skips building a jaw driver for anything whose
    // controller already covers the state. ("metarig|Tear", 2.93s, is the
    // other half of the same performance and goes unused: at 0.45x this
    // shark's `hunt.biteCooldown` it would still be chewing when it was due
    // to bite again.)
    animations: {
      idle: 'metarig|Swim', swim: 'metarig|Swim', boost: 'metarig|Swim Fast',
      bite: 'metarig|Bite',
    },

    // TAIL TRAIL — the house rule for anything that swims: the tail lags the
    // body rather than moving rigidly with it. `springChains` (not `wagChain`)
    // is the right field for a creature that already has clips: it attaches a
    // damped spring with NO procedural sine drive, so the authored swim cycle
    // still writes the pose and the spring only adds lag and overshoot on top
    // of it. See systems/boneSpring.js — despite the name it is not IK,
    // nothing aims at a target; each bone chases wherever the clip just put
    // it and declines to keep up.
    //
    // Two rules decide where a chain STARTS, and both come from the same
    // failure: rotating a bone drags every branch under it.
    //   - Never start on the bone that forks into the rest of the animal.
    //     Here that is `spine003_00`, which carries the tail on one side and
    //     the entire front half on the other — springing it would swing the
    //     head. Same trap as `pelvis_03` on enemyShark.
    //   - Fins hanging off a spine bone ride along with it, which is correct
    //     and wanted; only fins that need their OWN lag want their own chain.
    //
    // Chain ends on the upper caudal lobe, so the trail carries all the way
    // out to the fin tip instead of stopping at the peduncle.
    //
    // FINS TOO, since this is an apex. The tail alone was the cheap 80%, but a
    // body this size turning with four rigid blades stuck to it is the thing
    // that still read as a prop. Each fin is its own chain and its own solver
    // for the reason spelled out on enemyOrca — they branch off the spine, and
    // the solver assumes a single root-to-tip ordering — and the payoff is that
    // they lag on their OWN timing rather than as one piece.
    //
    // `role: 'fin'` solves them against a stiffer scaled copy of the spring
    // config; see CONFIG.animation.spring.roleLooseness. A fin run at the
    // tail's numbers trails as far as a tail does over a fifth the span, which
    // reads as detached rather than as flexing.
    //
    // Every chain here was verified against the file: each is a clean
    // single-child parent chain, and none of the roots forks into the body.
    rig: {
      springChains: [
        { role: 'tail',
          bones: ['spine002_01', 'spine001_02', 'spine_03',
                  'back_finTBk_04', 'back_finT001Bk_05', 'back_finT002Bk_06'] },
        // The lower caudal lobe forks off ABOVE where the tail chain starts, so
        // it is not already riding that chain's lag — unlike the orca's fluke
        // lobes, which hang off the last tail bone and are deliberately still
        // left alone below.
        { role: 'fin', bones: ['back_finBBk_07', 'back_finB001Bk_08'] },
        { role: 'fin', bones: ['shoulderL_018', 'side_finL_019', 'side_finL001_020'] },
        { role: 'fin', bones: ['shoulderR_021', 'side_finR_022', 'side_finR001_023'] },
        { role: 'fin', bones: ['top_fin_024', 'top_fin001_025'] },
      ],
    },
    // Head-look — see enemyShark. Stops at spine007_015 rather than running
    // on into jaw_016, and starts at spine006_014 rather than spine005_013,
    // which carries both pectorals. Two spine bones is all the "neck" a
    // megalodon has, and they are long ones, so the bend cap is doing most of
    // the work here.
    lookRig: {
      head: { bones: ['spine006_014', 'spine007_015'], tipAxis: '+Y', tipLength: 0.3 },
    },
    shape: 'cone', radius: 1.4, height: 4, color: 0x51606b, unlit: true,
  },

  // THE MOSASAUR — bossMosasaur's body, and the longest animal in the game.
  //
  // Built by tools/optimize-mosasaurus.mjs from the raw Sketchfab download:
  // 7.87MB and 67,434 triangles down to 1.82MB and 33,711, which puts it in the
  // megalodon's band (30,100) rather than at twice it. Most of that saving is
  // the textures — 3.94MB of PNG re-encoded to 0.58MB of WebP — so the mesh it
  // kept is the mesh the artist drew.
  //
  // WHY THIS BODY IS WORTH A BOSS SLOT: it is the only new SILHOUETTE available.
  // Every other apex in the roster is a shark shape, an orca shape or a squid,
  // and a fifth swimming boss that was another torpedo with fins would be a
  // reskin. This one is a four-flippered reptile with a 60-unit skull, and it
  // reads as a different animal from across the arena, which is the only place
  // a boss is ever read from.
  enemyMosasaur: {
    model: '/models/mosasaurus.glb',
    // 7.4, the kraken's number rather than the megalodon's 7.0 — and unlike the
    // kraken's, this length is all BODY. Against the assets.csv size of 2.3 and
    // bossMosasaur's 1.6 that measures 27.2 units on screen, the longest final
    // body in the game (megalodon 25.8, orca 24.8, kraken 22.2). Deliberate: a
    // mosasaur that did not out-measure the shark would have nothing to say.
    fit: 7.4,
    pivot: 0.15, // turn about the head, not the belly — as every swimmer here does
    // MEASURED, and measured in the right space, which on this file is the trap.
    // The mesh's own geometry through its node matrix comes out 89 units long
    // on Y, and every axis read off it is wrong: a skinned vertex is placed by
    // the BONE matrices, not by the mesh's, and the armature in between carries
    // the FBX -90-degree X rotation. Software-skinned, the animal is 355.8 units
    // along Z with the snout at +194 and the fluke at -162, and the jaw bone
    // sits below the skull on -Y. Hence +Z / +Y, the same basis as every shark.
    forward: '+Z', up: '+Y',

    // ONE 13.2s REEL, cut here rather than re-exported — the seagull's
    // arrangement, and see buildSubclips(). 25fps is the FILE's keyframe rate,
    // derived from its smallest gap between keys (0.0400s), not a guess and not
    // the display rate.
    //
    // What is in the reel, measured by tools/clip-takes.mjs — the energy
    // profile for the takes, the jaw angle for what the mouth is doing, and a
    // seam distance for whether a range can loop at all:
    //
    //   0-100    a swim cycle repeating on a 40-frame period, energy climbing
    //   34-78    ...with a 37-degree bite in the middle of it
    //   100-142  THE BIG BITE: gape to 62.5 degrees by frame 114, then the whole
    //            body lunges (peak energy 2.06/frame against the swim's 0.72)
    //            and the mouth shuts by 134
    //   150-250  a quiet hold, mouth closed, several frames of no motion at all
    //   260-330  the swim cycle again, calm and clean
    //
    // THE RANGES BELOW ARE THE ONES THAT LOOP. Seams, as a share of the body's
    // length: swim 0.038%, idle 0.443%. Every other 40-frame window in the reel
    // measures between 1.6% and 4% — including 37-77, which looks like a second
    // swim take and is really the first bite, so a boost mapped there would open
    // the animal's mouth once per stroke.
    subclipFps: 25,
    subclips: {
      mosaIdle: [198, 228],
      mosaSwim: [289, 329],
      mosaBite: [100, 142],
    },
    // `boost` reuses the swim stroke, played at the boost state's own
    // clipTimeScale — the arrangement the hammerhead and the orca already run
    // on. It is not a shortcut here so much as the honest reading: the file has
    // exactly one locomotion cycle in it, and the faster-looking stretches of
    // the reel are the animal ACCELERATING into the bite, which by definition
    // does not loop.
    //
    // `bite` is the second authored bite in the whole roster (megalodon's is
    // the first), and it earns this body its jaw for free: entities/enemies.js
    // skips building a procedural jaw driver for anything whose controller
    // already covers the state, so there is no `biteRig` here on purpose. The
    // range starts and ends with the mouth shut, which is what lets a one-shot
    // blend back into the swim without the jaw snapping closed on the seam.
    animations: {
      idle: 'mosaIdle', swim: 'mosaSwim', boost: 'mosaSwim', bite: 'mosaBite',
    },

    rig: {
      // THIS RIG RUNS ALONG LOCAL +X, like the hammerhead's and unlike most of
      // this file. Measured off the bind pose, not inferred: every bone's offset
      // from its parent comes out along X — Bone002_10 at (81.95, 0, 0),
      // Bone010_19 at (125.99, 0, 0), the flippers at (99.64, -0.01, 0). Left at
      // the default '+Y' every chain's last bone would be handed a tip direction
      // square to the bone itself.
      boneAxis: '+X',

      // Bone names in this file carry no meaning at all, so every chain was
      // picked by measuring where the driven flesh sits and verified to be a
      // clean parent-to-child run whose root does not fork into the body.
      //
      // THE TAIL starts at Bone010_19, not at Bone009_30. Bone009_30 has four
      // bone children — the tail, a belly stub and BOTH hind flippers — so a
      // spring on it would swing the flippers with the tail as one welded
      // piece. Bone010_19 is the first bone whose only descendant is the tail,
      // and the chain runs 129.6 units out to Bone017_14, the fluke tip.
      //
      // FOUR FLIPPERS, which is the thing this body has and no other boss does.
      // Each is its own chain and its own solver for the reason spelled out on
      // enemyOrca: they branch off the spine, the solver assumes one root-to-tip
      // ordering, and the payoff is that they lag on their own timing rather
      // than as a set. `role: 'fin'` solves them against a stiffer scaled copy of
      // the spring config — a flipper run at the tail's numbers trails as far as
      // a tail does over a quarter the span, which reads as detached.
      //
      // Each flipper chain includes its shoulder pivot (Bone023_40 and friends,
      // which dominate no vertices of their own). They are single-child bones
      // hanging off the spine, so they cannot swing anything but their own
      // flipper, and starting there gives a four-bone curl where the megalodon's
      // pectorals only get three.
      springChains: [
        { role: 'tail',
          bones: ['Bone010_19', 'Bone011_18', 'Bone014_17',
                  'Bone015_16', 'Bone016_15', 'Bone017_14'] },
        // Front pair, off the neck-side spine bone at z+97 — just behind the skull.
        { role: 'fin', bones: ['Bone023_40', 'Bone024_39', 'Bone025_38', 'Bone026_37'] },
        { role: 'fin', bones: ['Bone032_44', 'Bone033_43', 'Bone034_42', 'Bone035_41'] },
        // Hind pair, off Bone009_30 at mid-body.
        { role: 'fin', bones: ['Bone028_25', 'Bone029_24', 'Bone030_23', 'Bone031_22'] },
        { role: 'fin', bones: ['Bone036_29', 'Bone037_28', 'Bone038_27', 'Bone039_26'] },
      ],
    },

    // HEAD-LOOK, and this animal has a real neck to do it with — three bones
    // spanning 37.8 units, where the megalodon has two short spine bones and
    // the mightymeg has one. Bone001_13 is safe as the root even though it has
    // two bone children: the second is a 16-vertex throat stub, and the front
    // flippers hang off the OTHER branch out of Bone020_48 entirely, so nothing
    // below the neck moves when the head turns.
    //
    // tipLength 260 is in the tip bone's OWN local units, which is what
    // tipWorld() multiplies before handing the point to localToWorld — so the
    // armature's 0.2302 scale is applied for us and must not be applied here.
    // Measured rather than estimated: the furthest vertex this skull dominates
    // sits 259.9 local units along the bone's +X, which lands the effector on
    // the snout tip at world z+194.1 instead of inside the head.
    lookRig: {
      head: { bones: ['Bone001_13', 'Bone002_10', 'Bone004_7'], tipAxis: '+X', tipLength: 260 },
    },

    // THE FALLBACK BODY, for a run where the model fails to load. Sized against
    // the hitbox rather than against the animal: tools/boss-test.mjs measures
    // the two against each other and wants them within sight, which is the right
    // requirement — a fallback drawn at half its hitbox is a boss that hits you
    // from off its own body. Slimmer and longer than the megalodon's 1.4 x 4.0,
    // as this body is.
    // Colour sampled from the file's own base map (mean of its non-black
    // texels, #434035) rather than picked, so an unloaded boss is at least the
    // right animal's colour.
    shape: 'cone', radius: 1.3, height: 4.6, color: 0x434035, unlit: true,
  },

  enemyMightyMeg: {
    model: '/models/mightymeg.glb',
    fit: 6.0,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+X', up: '+Y',
    animations: { idle: 'Take 001', swim: 'Take 001', boost: 'Take 001' },
    // Tail trail — see the rationale on enemyMegalodon.
    //
    // Starts at Spine_04_03, not further up: Spine_02_01 forks into both
    // pectorals and Spine_03_02 carries the dorsal, so either would swing a
    // fin set with the tail. Spine_04 is the first bone whose only descendant
    // is the tail itself. Ends on Tail_05_08, the upper lobe.
    // Fins too — see enemyMegalodon. All four are 2-bone chains here, the
    // solver's minimum, so they hinge rather than curl. That is this rig, not a
    // tuning problem.
    rig: {
      springChains: [
        { role: 'tail',
          bones: ['Spine_04_03', 'Tail_01_04', 'Tail_02_05', 'Tail_03_06', 'Tail_04_07', 'Tail_05_08'] },
        { role: 'fin', bones: ['Tail_06_09', 'Tail_07_010'] },
        { role: 'fin', bones: ['Fin_L_01_013', 'Fin_L_02_014'] },
        { role: 'fin', bones: ['Fin_R_01_015', 'Fin_R_02_016'] },
        { role: 'fin', bones: ['Fin_01_011', 'Fin_02_012'] },
      ],
    },
    // Head-look — see enemyShark. A ONE-BONE chain, which is everything this
    // rig has: Head_017 hangs straight off Spine_01_00, and Spine_01_00 is
    // the root of the entire animal, so including it would swing the body
    // rather than the head. systems/headLook.js allows a single bone for
    // exactly this case.
    //
    // tipAxis '+X', measured — this rig's head bone runs along its own X
    // (dot 0.98 with the model's forward) where +Y comes out at 0.21.
    lookRig: {
      head: { bones: ['Head_017'], tipAxis: '+X', tipLength: 0.3 },
    },
    // BITE — Jaw_018, the one bone hanging off Head_017. This rig's only clip
    // ("Take 001") does key it, so the driver layers ON TOP of that pose
    // rather than replacing it; see the anti-ratchet note in systems/jaw.js.
    //
    // The odd one out on two counts, both because this model faces '+X'
    // rather than '+Z': its flank axis is model +Z, and the local axis that
    // lines up with it is local Z (dot 1.000) rather than local X. And the
    // sign comes out negative — see the method note on enemyShark.biteRig.
    biteRig: { bone: 'Jaw_018', axis: 'z', openAngle: -0.5 },
    shape: 'cone', radius: 1.3, height: 3.6, color: 0x3d4a55, unlit: true,
  },
  enemyGreatWhite: {
    model: '/models/greatwhite.glb',
    texture: { emissive: '/textures/emissive/greatwhite.jpg' },
    fit: 4.2,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y', // was '-Z' — verified backwards via axis-marked silhouette

    // "ArmatureAction" and "Swim" look like duplicates of the same cycle in
    // this file, and "Bite" has 0 duration (effectively an empty marker, not
    // a usable clip) — so every state reuses "Swim" at different speeds.
    animations: { idle: 'Swim', swim: 'Swim', boost: 'Swim' },

    // Tail trail — see the rationale on enemyMegalodon.
    //
    // This rig's bone names carry no meaning at all, so the chain was picked
    // by measuring world positions rather than by reading names: the model
    // faces +Z, the snout bones sit at z+0.94, and this branch runs back to
    // z-0.91. Bone001_Armature_13 is the rear root and forks into both the
    // tail and the pelvic/anal fins, so the chain starts one bone in.
    //
    // Only three bones long — the shortest tail in the roster — so it will
    // read as a stiffer trail than the megalodon's six. That is the rig, not
    // a tuning problem. The caudal lobes fork at Bone004_Armature_3, and the
    // solver picks up the first of them as its direction reference.
    // Fins too — see enemyMegalodon. They matter more on this model than on
    // any other apex, because its tail chain is the shortest in the roster
    // (three bones) and so contributes the least secondary motion of the set.
    rig: {
      springChains: [
        { role: 'tail', bones: ['Bone003_Armature_5', 'Bone002_Armature_4', 'Bone004_Armature_3'] },
        { role: 'fin', bones: ['Bone011_Armature_22', 'Bone013_Armature_21', 'Bone015_Armature_20'] },
        { role: 'fin', bones: ['Bone012_Armature_25', 'Bone014_Armature_24', 'Bone016_Armature_23'] },
        { role: 'fin', bones: ['Bone009_Armature_28', 'Bone010_Armature_27'] },
      ],
      // STUB — the pelvic/anal cluster ['Bone017_Armature_12', 'Bone018_Armature_8'],
      // still not enabled, and this one is a rig fact rather than a budget call.
      // Bone017 forks into BOTH Bone018 and Bone019, so a chain through it
      // drives one of the pair and drags the other along rigidly — the fins
      // would swing as a welded cluster. There is no fork-free way in: Bone018
      // then forks again into Bone020 and Bone022. Low on the belly and small,
      // so it is not worth a bespoke solver.
    },
    // Head-look — see enemyShark. Names mean nothing in this rig, so the
    // chain was read off world positions: this branch runs from z+0.46 out to
    // the snout at z+0.94. It starts at Bone007 rather than Bone005, which
    // forks into both pectorals.
    //
    // Bone008_Armature_14 is a leaf, so tipLength can't be read off a child
    // bone — 0.24 is the bone's own offset from its parent, which for a rig
    // running along +Y is the best estimate of its length. It has to be
    // non-zero: with tipLength 0 the last bone's effector sits exactly on its
    // own origin, the solver's degenerate-input guard fires, and that bone
    // never rotates at all.
    lookRig: {
      head: { bones: ['Bone007_Armature_19', 'Bone006_Armature_18', 'Bone008_Armature_14'], tipAxis: '+Y', tipLength: 0.24 },
    },
    // BITE — and note the file's "Bite" clip is NOT what does it. That clip is
    // 0 seconds long, its 13 single-key tracks all reproduce the rest pose
    // (several as the q/-q negation of it, which is the same rotation), and it
    // keys no jaw at all. It moves nothing. So this rig bites procedurally like
    // the rest — systems/jaw.js.
    //
    // Since these bone names mean nothing, the jaw was found by skinning
    // weight rather than by reading the hierarchy — and the hierarchy would
    // have got it wrong. Bone026_Armature_17 hangs off the skull pointing
    // straight down and looks like the jaw, but it is the MOUTH ROOT: it forks
    // into Bone027 and Bone028, the two halves, so rotating it swings the
    // upper and lower jaw together and the mouth never opens. Measured, that
    // is exactly what it does — its verts travel 0.0533 with only 0.0174 of it
    // downward, i.e. the snout slides forward.
    //
    // Bone028_Armature_16 is the lower half: 298 vertices at high weight,
    // sitting BELOW the snout bone at rest, and at -0.5 rad they move 0.0421
    // of which 0.0418 is straight down. That drops the jaw by 18% of its own
    // mesh span, which puts it in the same band as the rigs that read well
    // (shark 18%, mightymeg 21%, dolphin 14%, orca 11%) —
    // the reason it needs no bigger angle despite the number looking small is
    // that this file is a third the size of shark.glb (2.49 long against 7.5).
    //
    // openAngle is NEGATIVE here, unlike the sharks': this rig's jaw local X
    // comes out at model (-0.984, 0.008, 0.179), so the sign that swings the
    // mouth down is the opposite one. See the method note on enemyShark.
    biteRig: { bone: 'Bone028_Armature_16', axis: 'x', openAngle: -0.5 },
    shape: 'cone', radius: 0.9, height: 2.6, color: 0x8b96a0, unlit: true,
  },

  enemyAbyssShark: {
    model: '/models/greatwhite.glb',
    fit: 4.2,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    animations: { idle: 'Swim', swim: 'Swim', boost: 'Swim' },
    // The great white's own biteRig, verified on that model and unchanged
    // here — this is the same file, so the same bone and the same sign hold.
    biteRig: { bone: 'Bone028_Armature_16', axis: 'x', openAngle: -0.5 },
    // And its rig, for the same reason: same file, same bones. This asset had
    // no `rig` at all, which meant the one apex in the roster that is supposed
    // to be the scariest thing in the water was also the only one that swam
    // rigidly and did not flinch when shot — `hasSpring` was false, so
    // main.js's impulse call skipped it entirely. Copied rather than shared
    // because these are per-asset declarations and the great white may yet want
    // different chains from the abyss one.
    rig: {
      springChains: [
        { role: 'tail', bones: ['Bone003_Armature_5', 'Bone002_Armature_4', 'Bone004_Armature_3'] },
        { role: 'fin', bones: ['Bone011_Armature_22', 'Bone013_Armature_21', 'Bone015_Armature_20'] },
        { role: 'fin', bones: ['Bone012_Armature_25', 'Bone014_Armature_24', 'Bone016_Armature_23'] },
        { role: 'fin', bones: ['Bone009_Armature_28', 'Bone010_Armature_27'] },
      ],
    },
    // NOTE: this asset also has no `lookRig`, so it does not turn its head
    // toward what it is chasing the way the great white does. Same cause —
    // nothing was copied across when this entry was cloned — but it is a
    // separate system from the springs and is left alone here.
    // UNLIT, unlike the creatures these three copy. The glow is ADDITIVE, so
    // anything the scene lights contributes on top of it — and on a broad flat
    // body angled at the key light (the ray, measured: its dorsal surface
    // washed all ten patterns into one pale smear) the lit contribution simply
    // beats the pattern. Ignoring scene lights makes the creature's own light
    // the only light on it, which is the whole proposition.
    modelUnlit: true,
    biolumSkin: 'abyssHunter',
    // THE TINT MULTIPLIES THE SHARK'S OWN TEXTURE, it does not replace it, and
    // that is why this number matters more than it looks.
    //
    // greatwhite.glb does ship a base-colour map — 225 KB of it, the same one
    // enemyGreatWhite wears. `modelUnlit` keeps it (processMaterial copies
    // `map` onto the MeshBasicMaterial); the tint then multiplies it. At the
    // old 0x141c24 that was a factor of 0.08/0.11/0.14, which crushed a
    // perfectly good shark to within a few percent of black and left the
    // additive pattern as the only thing on screen. It did not read as a dark
    // animal, it read as a solid glowing shape.
    //
    // 0x7a8794 is about 6x that. The texture comes back as texture — the
    // counter-shading and the gill slits read again — while the body still
    // lands around 0.2 luminance against a pattern that peaks near 0.9, so the
    // glow is comfortably the brightest thing on the animal. That balance is
    // the whole reason a tint is here at all (see enemyLanternfish for the
    // argument); the fault was the magnitude, not the idea.
    //
    // Picked by arithmetic rather than off the auditioned plate, because the
    // plate is LIT and this material is not: in game `modelUnlit` makes the
    // pixel exactly texture x tint with no light on it, so a render that looks
    // right in the studio rig is a stop or so too dark in the water.
    tint: 0x7a8794,
    shape: 'cone', radius: 0.9, height: 2.6, color: 0x141c24, unlit: true,
  },

  enemyHammerhead: {
    model: '/models/hammerhead.glb',
    // The ONLY model in the roster that needs an explicit diffuse map. Every
    // other file carries its texture embedded; this one ships none at all —
    // not even in the 2.25MB source — so its colour lives entirely in these
    // two sidecars. Without them it renders as flat untextured grey, and
    // nothing warns, because an absent map is not an error.
    //
    // flipY TRUE on a glTF, which breaks the rule the loader derives from the
    // model format — see the note beside it. Measured, not guessed: at the
    // format default of false the body still looks plausible (its UV island is
    // the big central one either way) while every fin lands off its own small
    // island and picks up the black background between them, so the animal
    // renders with hard black-and-white patches on the fins and nowhere else.
    // That is the tell for a vertically mirrored atlas, and it is easy to
    // misread as bad source art.
    //
    // The cause is that these sidecars were NOT thresholded from this model's
    // own maps the way every other mask here was — the file has none — so they
    // carry the baking tool's convention instead of the model's. Both sidecars
    // share one UV layout (the emissive is the diffuse with its brights blown
    // out), so one value is correct for both.
    texture: {
      map: '/textures/hammerhead.jpg',
      emissive: '/textures/emissive/hammerhead.jpg',
      flipY: true,
    },
    fit: 4.0, // between the shark's 3.8 and the great white's 4.2, as it is in life
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y', // measured: Head bone at z+3.6, tail tip at z-6.9

    // One clip, so every locomotion state reuses it at its own configured
    // pace — the same arrangement as mightymeg. It keys all 11 bones, which
    // matters for the springs below: a clip-keyed bone is rebuilt from the
    // clip every frame and so has something to spring back toward.
    animations: { idle: 'Take 001', swim: 'Take 001', boost: 'Take 001' },

    rig: {
      // THIS RIG RUNS ALONG LOCAL +X, and it is the only one here that does.
      // Measured, not inferred: every bone's bind offset from its parent comes
      // out as (1.000, 0.000, 0.000) to three decimals, where every other file
      // in this project gives (0, 1, 0). All three chains below end on a leaf
      // bone, so all three consult this — see makeSpring in systems/animation
      // .js. Left at the default it would hand each chain's last bone a tip
      // direction square to the bone itself.
      boneAxis: '+X',

      // The chain starts at Torso2, not Torso1, and this rig makes the reason
      // unusually easy to see. Skinned and measured at 0.4 rad:
      //   Torso1  moves 699 verts spanning z -9.2..2.3 — the whole body behind
      //           the head, max displacement 4.3
      //   Torso2  moves 472 verts spanning z -9.2..1.1, max 0.75
      // and the head is NOT under the torso on this rig at all: `Head` and both
      // pectorals hang off a sibling root (`HeadFin_Rotation`), so bending
      // Torso1 swings the body while the head stays put and the mesh shears at
      // the neck. Confirmed the other way too — springing Torso2 moves 23
      // head-region vertices by at most 0.0155, which is nothing.
      //
      // No dorsal or lower-lobe chain, because this rig has no bones for them:
      // 11 bones total against the megalodon's 29. The dorsal and the caudal
      // lobes are skinned to the torso and tail and ride them.
      springChains: [
        { role: 'tail', bones: ['Torso2', 'Torso3', 'Torso4', 'Tail1', 'Tail2'] },
        { role: 'fin', bones: ['Fin_L1', 'Fin_L2'] },
        { role: 'fin', bones: ['Fin_R1', 'Fin_R2'] },
      ],
    },

    // HEAD-LOOK — and on this creature it is the whole point of the model. A
    // hammerhead reads as a hammerhead when the head swings; a shark silhouette
    // that tracks you is the one thing this rig does better than any other in
    // the roster.
    //
    // A ONE-BONE chain, which is all there is: `Head` hangs straight off
    // `HeadFin_Rotation`, and that bone also carries both pectorals and moves
    // 3936 vertices at 0.4 rad — the entire front assembly. Including it would
    // swing the fins with the skull. systems/headLook.js allows a single bone
    // for exactly this case.
    //
    // tipAxis '+X', measured like everything else here: local +X on `Head`
    // maps to world (0, 0, 1), dot 1.000 with the model's forward, against
    // 0.000 for both other axes. tipLength is the bone's own bind length in
    // the FILE's units — raw, not fit-scaled, since the fit is applied to the
    // wrapper and never reaches the bone transforms (verified against the
    // great white, whose declared 0.24 still measures 0.2421 after loading).
    lookRig: {
      head: { bones: ['Head'], tipAxis: '+X', tipLength: 1.6 },
    },

    // NO biteRig, and this is a rig limitation rather than an oversight: there
    // is no jaw bone in this file. The 11 bones are torso x4, tail x2, head,
    // the head/fin root and two fins x2 — nothing under the skull to hinge. So
    // this is the one hunter in the roster that closes without a gape. If it
    // ever needs one it wants a new bone in the source, not a different bone
    // name here; systems/jaw.js is simply never built for it (see the biteRig
    // check in entities/enemies.js).
    shape: 'cone', radius: 0.85, height: 2.6, color: 0x7d8a94, unlit: true,
  },

  // THE HAMMERHEAD BOSS BODY. Same binary, same sidecar textures, same rig and
  // the same one-bone head-look — its own key for the reason enemyBossCrab has
  // one: a material is shared across every clone of a key, so a boss given its
  // own look would hand that look to all four hammerheads in the wave with it.
  // It arrives alone, so it can afford one they cannot.
  //
  // `fit` is the wave animal's 4.0, unchanged. The boss step is bosses.csv's
  // `sizeMul` over assets.csv's size for this key — putting it here instead
  // would hide the escalation in the wrong file and break the drawn-size against
  // hitbox measurement in tools/boss-test.mjs.
  //
  // EVERYTHING BELOW IS COPIED, NOT SHARED, and deliberately: these are
  // per-asset declarations, and the boss may yet want different chains, a
  // different tint or a glow the wave animal must not have. The one thing that
  // must not drift is the bone NAMES, which is what tools/apex-spring-test.mjs
  // checks on both keys.
  enemyBossHammerhead: {
    model: '/models/hammerhead.glb',
    texture: {
      map: '/textures/hammerhead.jpg',
      emissive: '/textures/emissive/hammerhead.jpg',
      // TRUE on a glTF, against the rule the loader derives from the model
      // format. Not a mistake and not copied blind — see the long note on
      // enemyHammerhead, which measured it: these sidecars carry the baking
      // tool's convention rather than the model's, and at the format default
      // every fin lands off its own UV island and picks up the black background
      // between them.
      flipY: true,
    },
    fit: 4.0,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    animations: { idle: 'Take 001', swim: 'Take 001', boost: 'Take 001' },
    rig: {
      // The rig runs along local +X — the measurement is on enemyHammerhead.
      boneAxis: '+X',
      springChains: [
        { role: 'tail', bones: ['Torso2', 'Torso3', 'Torso4', 'Tail1', 'Tail2'] },
        { role: 'fin', bones: ['Fin_L1', 'Fin_L2'] },
        { role: 'fin', bones: ['Fin_R1', 'Fin_R2'] },
      ],
    },
    // The head swing is the whole point of this animal, and it matters more on
    // the boss than on the wave version: it is the only tell the shove has.
    // A hammerhead that turns to face you before it hits you is a hammerhead
    // the player can read.
    lookRig: {
      head: { bones: ['Head'], tipAxis: '+X', tipLength: 1.6 },
    },
    // No biteRig — this file has no jaw bone at all. See enemyHammerhead.
    shape: 'cone', radius: 1.1, height: 3.4, color: 0x7d8a94, unlit: true,
  },

  // --- schooling prey (behavior:'swarm', prey:true) ---
  enemyTrout: {
    model: '/models/trout.fbx',
    fit: 1.3,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    // Two real clips, cleanly named for exactly this purpose.
    animations: {
      idle: 'SKM_Trout|SKM_Trout|Trout_Swim_1',
      swim: 'SKM_Trout|SKM_Trout|Trout_Swim_1',
      boost: 'SKM_Trout|SKM_Trout|Trout_Swim_1_Fast',
    },
    shape: 'icosahedron', radius: 0.35, color: 0x9fb8c8, unlit: true,
  },
  enemyTang: {
    model: '/models/tang.glb',
    texture: { emissive: '/textures/emissive/tang.jpg' },
    fit: 1.1,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    animations: { idle: 'ArmatureAction', swim: 'ArmatureAction', boost: 'ArmatureAction' },
    shape: 'icosahedron', radius: 0.35, color: 0x2f6fd6, unlit: true,
  },
  enemyReeffish: {
    model: '/models/fish2.glb',
    texture: { emissive: '/textures/emissive/fish2.jpg' },
    fit: 1.0,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    // Static mesh, no skeleton — spins to face its heading like the
    // procedural shapes do, no animation controller involved.
    shape: 'icosahedron', radius: 0.32, color: 0xffb347, unlit: true,
  },
  // One file with 3 separate fish in it — meshIndex isolates each into its
  // own asset so all three get used instead of always overlapping as one.
  enemyFishPackA: {
    model: '/models/fishpack.glb', meshIndex: 0,
    fit: 1.0, forward: '+Z', up: '+Y',
    pivot: 0.15, // turn about the head, not the belly
    shape: 'icosahedron', radius: 0.32, color: 0xc9d6e3, unlit: true,
  },
  enemyFishPackB: {
    model: '/models/fishpack.glb', meshIndex: 1,
    fit: 1.3, forward: '+Z', up: '+Y',
    pivot: 0.15, // turn about the head, not the belly
    shape: 'icosahedron', radius: 0.38, color: 0xaebfd1, unlit: true,
  },
  enemyFishPackC: {
    model: '/models/fishpack.glb', meshIndex: 2,
    fit: 0.9, forward: '+Z', up: '+Y',
    pivot: 0.15, // turn about the head, not the belly
    shape: 'icosahedron', radius: 0.3, color: 0xd8c9a3, unlit: true,
  },

  // --- fishes.glb — a second meshIndex trio, and the cheapest art in the game
  //
  // 137KB for three fish, ~1.2k triangles each, and NO TEXTURES AT ALL: the
  // file carries one flat material for all three meshes. That is why each
  // entry below sets its own `tint` and why it has to. Untinted these are
  // three identical dull-teal bodies, which is the exact failure the fishpack
  // trio was split to avoid — and tinting works here only because materials
  // are per ASSET KEY (see instantiateParsedModel), so one file backing three
  // keys really is three independent colours.
  //
  // No skeleton and no clips, so all three take the static path enemyReeffish
  // is on: they spin to face their heading and nothing bends. At 1.0-1.25
  // units that reads fine — the tang next to them is 1058 triangles of
  // ACTUAL swim cycle, and the difference is invisible at gameplay distance.
  //
  // `forward: '-Z'`, which is the opposite of every other fish in this file
  // and is MEASURED rather than assumed. Slab-profiling each mesh along its
  // long axis, the cross-section collapses in thickness at HIGH z on all
  // three (0.30, 0.34 and 0.12 units, against 0.73/0.90/0.89 at the other
  // end) while staying tall — that is a caudal blade, so the head is the
  // low-z end. The same measurement run against fish2.glb comes out the other
  // way round and agrees with the '+Z' that entry has always declared, which
  // is the only reason to trust it here.
  enemyFishesA: {
    model: '/models/fishes.glb', meshIndex: 0,
    fit: 1.0, forward: '-Z', up: '+Y',
    pivot: 0.15, // turn about the head, not the belly
    tint: 0x7fb5a3,
    shape: 'icosahedron', radius: 0.34, color: 0x7fb5a3, unlit: true,
  },
  enemyFishesB: {
    model: '/models/fishes.glb', meshIndex: 1,
    fit: 1.25, forward: '-Z', up: '+Y',
    pivot: 0.15, // turn about the head, not the belly
    tint: 0xc98f5a,
    shape: 'icosahedron', radius: 0.4, color: 0xc98f5a, unlit: true,
  },
  enemyFishesC: {
    model: '/models/fishes.glb', meshIndex: 2,
    fit: 1.1, forward: '-Z', up: '+Y',
    pivot: 0.15, // turn about the head, not the belly
    tint: 0x8f7fc0,
    shape: 'icosahedron', radius: 0.33, color: 0x8f7fc0, unlit: true,
  },

  // --- the split pack: four rigged schoolers, ~700-900 triangles each -------
  //
  // Cut out of one merged file by tools/fish-split.mjs — see that file for what
  // the cut has to preserve and how it proves it did. What matters HERE is that
  // all four came out of the same tool with the same treatment, which is why
  // they can share these notes instead of repeating them four times:
  //
  //   '+Z' / '+Y' ON ALL FOUR IS BAKED, NOT DISCOVERED. Each fish was posed at
  //   its own angle in the source pile, so as-cut they swim diagonally across
  //   the screen and no forward/up pair can say so (the squid problem — see
  //   enemySquid). The tool straightens each one onto its own principal axes,
  //   so the entry gets to declare the clean pair and mean it. Do not "fix" a
  //   future re-export by hunting for the right axis names here; re-run the
  //   tool.
  //
  //   NO `animations` MAPPING. One clip each (FishSwimming, 1.67s), which puts
  //   them on the single-clip-reuse path — same arrangement as enemyPuffer,
  //   and the note there explains why naming it three times is the long road
  //   to the same place.
  //
  //   NO TEXTURES ANYWHERE. The source is flat-shaded material colour, which
  //   is why these are 130-150KB apiece and why they carry no `texture.emissive`
  //   — there is no base-colour map for a mask to be generated against.
  //   They keep their own material colours rather than taking a `tint`: unlike
  //   the fishes.glb trio, which is three bodies sharing ONE dull teal and so
  //   needs tinting apart, these four already ship distinct paint.
  enemyBrownFish: {
    model: '/models/brownfish.glb',
    fit: 1.15,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    shape: 'icosahedron', radius: 0.36, color: 0xa8846b, unlit: true,
  },
  enemyClownFish: {
    model: '/models/clownfish.glb',
    fit: 0.85, // the smallest body in the roster — a clownfish is tiny
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    shape: 'icosahedron', radius: 0.3, color: 0xe8511c, unlit: true,
  },
  // The biggest of the four (4.20 long against the clownfish's 3.34) and the
  // only one built like something that swims fast, which is what its creature
  // entry is written around.
  enemyTuna: {
    model: '/models/tunafish.glb',
    fit: 1.5,
    pivot: 0.12, // leads harder than the schoolers: a longer, faster body
    forward: '+Z', up: '+Y',
    shape: 'cone', radius: 0.4, height: 1.2, color: 0x51637d, unlit: true,
  },
  // A palette surgeonfish. NOT the same creature as enemyTang, which is a blue
  // powder tang off blue_powder_tang.glb — two different animals that a careless
  // name would have merged, which is why neither the asset key nor the model
  // file is called anything with "tang" in it on its own.
  enemySurgeonFish: {
    model: '/models/surgeonfish.glb',
    fit: 1.0,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    shape: 'icosahedron', radius: 0.34, color: 0x1b3fd8, unlit: true,
  },

  // Pufferfish. 5,152 triangles on a 16-bone rig with one 0.88s swim cycle,
  // and the whole file is 444KB — the best value in the roster after the trio
  // above.
  //
  // NO `animations` MAPPING, deliberately, and it is not an omission. The file
  // ships exactly one clip, which puts it on the single-clip-reuse path in
  // systems/animation.js (`clips.length === 1 && !explicitlyMapped`): the same
  // cycle drives idle, swim and boost, retimed per state by
  // CONFIG.animation.states[...].clipTimeScale. Naming that one clip three
  // times over — as enemyTang does — lands in the same place by a longer road,
  // because `shared` is computed from how many states resolved to the action
  // rather than from how they got there.
  //
  // `modelUnlit` is already true of the FILE (its material carries
  // KHR_materials_unlit), so this line changes nothing today. It is here as
  // the statement that this fish is meant to ignore scene lights, so a
  // re-export that quietly drops the extension doesn't quietly change how it
  // reads.
  //
  // Orientation measured off the bones, which for a skinned model is the only
  // honest source: `face.001/002` sit at z +1.70 and +2.75, `tail.001..004`
  // run to z -3.88, and the pectorals are at ±x with fin.T above fin.B on y.
  // The POSITION accessors say the long axis is Y, and they are wrong in the
  // way skinned accessors always are — they are in skin space, not the space
  // the node transforms describe.
  // IT IS NOT INFLATED, and that is worth saying out loud because the name
  // promises otherwise. Auditioned in the game's own basis it is a slim
  // spotted fish about 3.2 times longer than it is deep — a puffer swimming,
  // which is how they spend their lives, not the spiny ball. The rig has no
  // inflate in it either: 16 bones covering face, tail and four fins, and one
  // 0.88s swim cycle. So nothing about this creature's numbers can be
  // justified by spines the player cannot see, and CONFIG.enemies.puffer is
  // tuned to the fish in the picture rather than to the word.
  //
  // `fit` is above the schoolers' 0.9-1.3 on purpose: it is a solitary
  // mid-tier body and needs to read as bigger than the shoal it drifts past,
  // which at this silhouette is the only thing separating them at a glance.
  enemyPuffer: {
    model: '/models/puffer.glb',
    fit: 1.4,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    shape: 'icosahedron', radius: 0.45, color: 0xd8c07a, unlit: true,
  },

  // Same file as enemyFish, loaded as its OWN template — materials are shared
  // across clones of one asset key, so injecting the glow here rather than
  // into enemyFish is what keeps every ordinary fish dark.
  //
  // Deliberately ships no emissive mask, unlike enemyFish. The mask says
  // "these texels of this fish are bright" and the pattern says the same
  // thing in a different, moving voice; running both means the mask's fixed
  // hotspots sit under the pattern and never move with it, which reads as a
  // texturing bug rather than as two effects.
  //
  // The tint is much darker than the fish it copies, and that IS the effect:
  // the glow is additive, so what the pattern is added TO decides whether it
  // looks like light coming out of an animal or like a bright animal. The
  // shader darkens further on top of this (biolumSkin.bodyDarken).
  enemyLanternfish: {
    model: '/models/fish.glb',
    fit: 0.9,
    pivot: 0.15, // turn about the head, not the belly
    forward: '-X',
    up: '+Y',
    // UNLIT, unlike the creatures these three copy. The glow is ADDITIVE, so
    // anything the scene lights contributes on top of it — and on a broad flat
    // body angled at the key light (the ray, measured: its dorsal surface
    // washed all ten patterns into one pale smear) the lit contribution simply
    // beats the pattern. Ignoring scene lights makes the creature's own light
    // the only light on it, which is the whole proposition.
    modelUnlit: true,
    biolumSkin: 'lantern',
    tint: 0x1b2b3a,
    shape: 'icosahedron',
    radius: 0.35,
    color: 0x1b2b3a,
    unlit: true,
  },

  // Two more glowing schoolers, so a night is not one shoal repeated. Both
  // follow the lanternfish's recipe exactly and only the parts that MUST
  // differ do: their own asset key (materials are shared per key, so reusing
  // enemyTang here would light every daytime tang with it), their own preset,
  // and a tint dark enough that the additive pattern is the brightest thing on
  // the body.
  //
  // Deliberately built on models already in the roster rather than new art.
  // The night reads by PATTERN and COLOUR at gameplay distance — silhouette
  // barely registers on a 0.4-unit fish — so a second palette on a familiar
  // body buys a new species far more cheaply than a new mesh would.
  enemyGlowTang: {
    model: '/models/tang.glb',
    fit: 1.1,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    animations: { idle: 'ArmatureAction', swim: 'ArmatureAction', boost: 'ArmatureAction' },
    // No `texture.emissive`, unlike the daytime tang it copies: a baked mask
    // and a generated pattern are two answers to "which bits of this fish are
    // bright", and the fixed one sits under the moving one looking like a bug.
    modelUnlit: true,
    biolumSkin: 'reefGlow',
    tint: 0x14232b,
    shape: 'icosahedron', radius: 0.35, color: 0x14232b, unlit: true,
  },
  enemyGlowDarter: {
    model: '/models/fishpack.glb', meshIndex: 1,
    fit: 1.3,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    biolumSkin: 'dartGlow',
    tint: 0x1a1526,
    shape: 'icosahedron', radius: 0.38, color: 0x1a1526, unlit: true,
  },

  // ---------------------------------------------------------------------------
  // NIGHT FORMS — the nine new fish after dark
  //
  // These are NOT nine new species. Each one is the night costume of a
  // creature that already has a row in enemies.csv, reached through
  // `nightAsset` on that row rather than through a second enemy id (see the
  // asset pick in entities/enemies.js spawnOne). The three glow creatures
  // above this block are the older arrangement — their own ids, their own
  // balance numbers, tagged `bioluminescent` so they only exist after sunset —
  // and it is worth being clear about why these did not copy it: a second id
  // is a second set of hp, speed, xp, weight, caps and ramp behaviour to keep
  // in step with the first, forever, for a creature that is the same animal.
  // What a costume needs is a material, and a material is what an asset key
  // is.
  //
  // A SECOND KEY IS STILL UNAVOIDABLE. attachBiolumSkin injects the pattern
  // through onBeforeCompile and materials are shared across every clone of a
  // key, so lighting the day fish's key would light the day fish. Nor can it
  // be done per instance: Material.clone() drops onBeforeCompile, so the copy
  // comes back with its userData still claiming the shader is attached and
  // nothing rendering. Nine keys is the floor, and it is the cheap half —
  // these carry no numbers anyone has to balance.
  //
  // NO NEW PRESETS, deliberately. The four these share are already measured
  // (`npm run glow` reports every ramp stop against the bloom threshold, and
  // the family was rescaled together — see lantern.strength), and a preset
  // authored by eye is a preset that sits under 0.58 and never haloes while
  // looking perfectly reasonable in the file. Sharing also buys per-individual
  // variety for free: skins.csv joins by PRESET, not by creature, so every row
  // listed against `lantern` already applies to all three fish wearing it.
  //
  // Which preset each one wears is chosen by body and by role, not spread
  // round for the sake of it:
  //   reefGlow    net — seams and cell borders, a coral read. The reef fish.
  //   lantern     speckle — a fine shimmering dust. The open shoals.
  //   dartGlow    spots — discrete photophores, cold violet, the most nervous
  //               tempo of the three. The small fast ones.
  //   abyssHunter stripes in ember, the one preset meant to read as a threat
  //               rather than as scenery. The sailfish, and nothing else here.
  //
  // Every tint is much darker than the day body it copies, and that IS the
  // effect rather than a side effect — the pattern is ADDITIVE, so what it is
  // added to decides whether the animal reads as light coming out of a fish or
  // as a bright fish. See enemyLanternfish, which explains it at length.
  // ---------------------------------------------------------------------------
  enemyGlowFishesA: {
    model: '/models/fishes.glb', meshIndex: 0,
    fit: 1.0, forward: '-Z', up: '+Y',
    pivot: 0.15,
    modelUnlit: true,
    biolumSkin: 'reefGlow',
    tint: 0x14231f,
    shape: 'icosahedron', radius: 0.34, color: 0x14231f, unlit: true,
  },
  enemyGlowFishesB: {
    model: '/models/fishes.glb', meshIndex: 1,
    fit: 1.25, forward: '-Z', up: '+Y',
    pivot: 0.15,
    modelUnlit: true,
    biolumSkin: 'lantern',
    tint: 0x18293a,
    shape: 'icosahedron', radius: 0.4, color: 0x18293a, unlit: true,
  },
  enemyGlowFishesC: {
    model: '/models/fishes.glb', meshIndex: 2,
    fit: 1.1, forward: '-Z', up: '+Y',
    pivot: 0.15,
    modelUnlit: true,
    biolumSkin: 'dartGlow',
    tint: 0x1a1526,
    shape: 'icosahedron', radius: 0.33, color: 0x1a1526, unlit: true,
  },
  enemyGlowBrownFish: {
    model: '/models/brownfish.glb',
    fit: 1.15,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    biolumSkin: 'lantern',
    tint: 0x1b2b3a,
    shape: 'icosahedron', radius: 0.36, color: 0x1b2b3a, unlit: true,
  },
  // The tightest shoal in the roster (6-14) gets the preset built for a knot
  // of small bodies: dartGlow's spots are discrete organs rather than a wash,
  // so fourteen of them read as a scatter of moving points instead of one
  // luminous cloud with no edges.
  enemyGlowClownFish: {
    model: '/models/clownfish.glb',
    fit: 0.85,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    biolumSkin: 'dartGlow',
    tint: 0x1d1728,
    shape: 'icosahedron', radius: 0.3, color: 0x1d1728, unlit: true,
  },
  enemyGlowSurgeonFish: {
    model: '/models/surgeonfish.glb',
    fit: 1.0,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    biolumSkin: 'reefGlow',
    tint: 0x13221d,
    shape: 'icosahedron', radius: 0.34, color: 0x13221d, unlit: true,
  },
  enemyGlowTuna: {
    model: '/models/tunafish.glb',
    fit: 1.5,
    pivot: 0.12,
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    biolumSkin: 'lantern',
    tint: 0x17273a,
    shape: 'cone', radius: 0.4, height: 1.2, color: 0x17273a, unlit: true,
  },
  // reefGlow rather than one of the faster two, for the tempo and not the
  // pattern: its flicker and pulse both run at half the lanternfish's rate,
  // and a puffer moving at 3.2 with a nervous sixteenth-note shimmer on it
  // would read as two animals at once.
  enemyGlowPuffer: {
    model: '/models/puffer.glb',
    fit: 1.4,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    modelUnlit: true,
    biolumSkin: 'reefGlow',
    tint: 0x162420,
    shape: 'icosahedron', radius: 0.45, color: 0x162420, unlit: true,
  },
  // The only one here wearing the shark's preset, and the only one that should:
  // abyssHunter is stripes in ember on a mostly-dark body — a warning rather
  // than a light show — and the sailfish is the one fish in this group with
  // teeth and a body long enough for wide bands to land on.
  enemyGlowSailfish: {
    model: '/models/sailfish.glb',
    fit: 3.0,
    pivot: 0.1,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'Armature|Swim',
      swim: 'Armature|Swim',
      boost: 'Armature|SwimFast',
    },
    modelUnlit: true,
    biolumSkin: 'abyssHunter',
    tint: 0x241a14,
    shape: 'cone', radius: 0.4, height: 1.9, color: 0x241a14, unlit: true,
  },

  // --- seabed dwellers ---
  // Ships exactly ONE clip (a 3.33s in-place walk cycle), and deliberately
  // gets no `animations` mapping: that puts it on the single-clip-reuse path
  // in systems/animation.js, which drives the same walk across idle/swim/boost
  // at CONFIG.animation.states[...].clipTimeScale. A crab's walk IS its idle,
  // just slower, so one cycle stretched over the speed tiers is the right
  // model here — and it sidesteps the trap the hermit crab fell into, where
  // `boost` was mapped to a clip no crab is ever fast enough to reach.
  // Claws point +Z; the L/R leg pairs straddle X.
  enemyWalkingCrab: {
    // crabpincer.glb, built by tools/optimize-crab.mjs from an 8.64MB,
    // 92,491-triangle download. It replaced crabwalking.glb for one reason: it
    // has a claw that actually opens. It is also 1.09MB against the old crab's
    // 2.74MB, at 12,012 triangles against 8,520 — the decimation paid for the
    // upgrade and then some. The one place it costs more is the skeleton: 126
    // bones against 42, on the creature that spawns in the biggest crowds.
    model: '/models/crabpincer.glb',
    // No emissive mask: this model ships none, and the daytime shell pattern
    // (`carapace`) is doing that job procedurally anyway.
    fit: 2.8,
    // '+X' is the STRIDE axis (where the L/R leg pairs straddle), not the way
    // the crab faces — deliberately. With enemies.js pinning the heading for
    // faceCamera creatures, this puts model +X along the screen horizontal,
    // +Y up and +Z (the claws and face) pointing at the camera.
    forward: '+X', up: '+Y',
    // Eight legs and two claws, each its own spring chain. No `wagChain`: this
    // model's clips cover every state, so the procedural sine fallback is
    // never wanted — these exist purely so a collision has a skeleton to
    // shove (CONFIG.crabPhysics -> anim.impulse). Each spring's target stays
    // the walk cycle, so the limbs settle back into the loop on their own.
    // Shared with every other crab — see CRAB_RIG above.
    rig: CRAB_RIG,
    clawRig: CRAB_CLAW_RIG,
    // The shell pattern. Static in daylight and quite dim — see the `carapace`
    // preset for the three zeroes that make it a texture rather than an effect.
    //
    // This one KEEPS its baked emissive mask, unlike every other creature
    // wearing a biolumSkin. The reason those drop theirs is that a moving
    // pattern sliding under fixed hotspots reads as a texturing bug — but
    // `carapace` sets flow, pulseAmp and flickerAmp all to 0, so nothing here
    // moves relative to anything. A static pattern and a baked mask are just
    // two layers of the same still image.
    biolumSkin: 'carapace',
    // NOT the derived axis. The bind-pose box is (0.476, 0.178, 0.321), so the
    // longest-side rule picks X — and X on a crab runs from one claw to the
    // OTHER, because a crab is wider than it is long. Derived, `tailBias` and
    // `hueBias` would light one claw and darken the other. Declaring 'z' runs
    // the gradient front-to-back, which is the axis the animal has: claws at
    // one end, rear legs at the other. Every preset knob that reads the body
    // axis depends on this.
    eyeStalks: CRAB_EYE_STALKS,
    biolumAxis: 'z',
    shape: 'octahedron', radius: 0.6, color: 0xc9713f, unlit: true,
  },

  // The crab after dark. Same model, same rig, same claw — a different skin and
  // a much darker body under it. Separate asset key rather than a flag, for the
  // reason spelled out on enemyLanternRay: a material is shared across every
  // clone of a key, so lighting `enemyWalkingCrab` would set every daytime crab
  // on the seabed alight too.
  enemyEmberCrab: {
    // The same binary as the day crab, as ever — see enemyWalkingCrab for what
    // crabpincer.glb is and what it replaced.
    model: '/models/crabpincer.glb',
    fit: 2.8,
    forward: '+X', up: '+Y',
    // Shared with the day crab rather than copied — see CRAB_RIG. The claw
    // driver and the animation springs resolve bones by name off whichever key
    // spawned, so a variant that dropped these would walk with stiff legs and
    // never raise a claw.
    rig: CRAB_RIG,
    clawRig: CRAB_CLAW_RIG,
    // UNLIT, for the reason written out at length on enemyLanternRay: the glow
    // is additive, and a lit shell angled at the key light beats the pattern.
    modelUnlit: true,
    biolumSkin: 'emberClaw',
    eyeStalks: CRAB_EYE_STALKS,
    biolumAxis: 'z',
    // Nearly black, so the ember in the seams is the only thing with a colour.
    tint: 0x1a0f0c,
    shape: 'octahedron', radius: 0.6, color: 0x1a0f0c, unlit: true,
  },

  // THE KING CRAB — the boss body. Same binary, same rig, same claw; its own
  // key so its own material, for the reason on the ember crab above: a material
  // is shared across every clone of a key, so a boss that lit its shell would
  // light every crab on the seabed with it. This one arrives alone, so it can
  // afford a look the swarm cannot.
  //
  // `fit` is the day crab's, unchanged. The boss step is bosses.csv's `sizeMul`
  // on top of assets.csv's size for this key — putting it here instead would
  // hide the escalation in the wrong file and break tools/boss-test.mjs's
  // measurement of drawn size against hitbox.
  enemyBossCrab: {
    model: '/models/crabpincer.glb',
    fit: 2.8,
    forward: '+X', up: '+Y',
    rig: CRAB_RIG,
    clawRig: CRAB_CLAW_RIG,
    // Unlit, like the ember crab and for the same reason — and this body is
    // mostly glow, so a key light raking a shell that dark would only wash out
    // the seams the whole look is carried by.
    modelUnlit: true,
    biolumSkin: 'kingCrab',
    eyeStalks: CRAB_EYE_STALKS,
    biolumAxis: 'z',
    // Colder and darker than the ember crab's brown-black: the boss reads as
    // deep-water armour, and the shell being nearly black is what lets a pair
    // of eyes find you across the arena.
    tint: 0x0d1016,
    shape: 'octahedron', radius: 0.6, color: 0x0d1016, unlit: true,
  },
  // --- seabed decor --------------------------------------------------------
  // A clump of blades that bends in the current. Built by
  // tools/optimize-grass.mjs from the raw Sketchfab download, which arrives as
  // 18 meshes over 4 materials plus four swatch quads floating above the
  // model; that script merges it to one mesh with one atlased material and
  // reseats it so the BASE sits at y=0. Placing a clump is therefore just
  // "put it on the seabed" — no offset needed to stop it hovering.
  //
  // `fit` normalises the LONGEST axis, and this clump is wider (6.36) than it
  // is tall (3.98). So fit is its WIDTH, and the grass stands about 0.63x fit
  // high — 3 gives a clump roughly 3 wide and 1.9 tall.
  grass: {
    model: '/models/grass.glb',
    fit: 3,
    // Blades grow along model +Y and the clump spreads on XZ, but `forward`
    // and `up` are NOT "which way is up in the file" — orientationQuaternion
    // maps them into view space, and in the side view (CONFIG.view) it sends
    // model FORWARD to world +Y and model UP to world -X. So the axis that
    // has to be named `forward` is the one the blades grow along, and `up`
    // gets the clump's width. The intuitive-looking '+Z'/'+Y' lays the whole
    // stand on its side, pointing the blades into the screen.
    //   forward '+Y' -> blades stand up   (model +Y  -> world +Y)
    //   up      '-X' -> width across      (model +X  -> world +X)
    //                   depth stays depth (model +Z  -> world +Z)
    forward: '+Y', up: '-X',
    // Bending happens in the vertex shader in OBJECT space, so it follows this
    // orientation rather than fighting it. See systems/grassSway.js and
    // CONFIG.grass.sway.
    sway: true,
    // Lit, so the daylight cycle reaches it — grass that stays noon-green
    // while the water goes to dusk is the thing that gives decor away. Low
    // metalness because wet plant is not metal, high roughness so the key
    // light does not put a specular hotspot on a flat card.
    material: { roughness: 0.9, metalness: 0 },
    shape: 'cone', radius: 0.5, height: 1.2, color: 0x3f7d44,
  },
  // --- new creatures -------------------------------------------------------
  // Axes below come from rendering each file with an axis helper (see
  // model-inspector.html), not from guessing at the longest dimension.

  // THE BOSS BODIES. Two of them, and the boss rolls between them at spawn —
  // see `asset` on CONFIG.enemies.bossOrca, which takes a list. One set of
  // stats, one name pool, one health bar, two animals: a bull with the tall
  // dorsal fin and a cow with the curved one, which is the difference a person
  // who has ever seen an orca reads instantly and is the whole point of using
  // both.
  //
  // Cut from Orca_Family_GLB.glb by tools/orca-split.mjs. What that replaced —
  // and why — is worth knowing before anybody swaps it back: the old orca.glb
  // was 968 vertices on a rig built for a quadruped, whose pectoral flippers
  // were driven by bones called `Thigh_F01_L` and `Foot_F02_L` hanging off a
  // `hip_01`, and whose swim clip moved the fluke a third as far as this one.
  // Nothing was wrong with the animation tuning; the rig was a whale wearing
  // somebody else's skeleton.
  enemyOrcaBull: {
    model: '/models/orca_male.glb',
    fit: 5.2,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    // THE PAINTED HIDE. `biolumSkin` names the preset it wears, which replaces
    // the model's baked map outright — see the note on the preset itself in
    // config.js, which it used to share with the lattice under the old name.
    //
    // NO `biolumEdges` HERE ANY MORE. This body used to wear the lattice, and
    // that pattern needs barycentric coordinates, which need one vertex per
    // triangle corner — a `toNonIndexed` at load that took the orca from 6,994
    // vertices to 33,714. The preset is a `spots` pigment now and samples no
    // edges, so the split is deleted rather than left paying for a pattern
    // nothing selects. Putting the lattice back means restoring the flag here
    // AND the pattern there; splitForEdges is still in systems/biolumSkin.js.
    biolumSkin: 'orcaHide',
    // One clip, reused across every state at a different rate — see the note
    // on orcaFriendBull for why there is no mapping here.
    rig: ORCA_RIG,
    lookRig: orcaLook(91.5),
    biteRig: ORCA_BITE,
    shape: 'cone', radius: 0.9, height: 2.6, color: 0x22303c, unlit: true,
  },
  enemyOrcaCow: {
    model: '/models/orca_female.glb',
    fit: 5.0, // fractionally the smaller animal, as she is
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    // THE PAINTED HIDE. `biolumSkin` names the preset it wears, which replaces
    // the model's baked map outright — see the note on the preset itself in
    // config.js, which it used to share with the lattice under the old name.
    //
    // NO `biolumEdges` HERE ANY MORE. This body used to wear the lattice, and
    // that pattern needs barycentric coordinates, which need one vertex per
    // triangle corner — a `toNonIndexed` at load that took the orca from 6,994
    // vertices to 33,714. The preset is a `spots` pigment now and samples no
    // edges, so the split is deleted rather than left paying for a pattern
    // nothing selects. Putting the lattice back means restoring the flag here
    // AND the pattern there; splitForEdges is still in systems/biolumSkin.js.
    biolumSkin: 'orcaHide',
    rig: ORCA_RIG,
    lookRig: orcaLook(75.5),
    biteRig: ORCA_BITE,
    shape: 'cone', radius: 0.9, height: 2.6, color: 0x22303c, unlit: true,
  },

  enemyDolphin: {
    model: '/models/dolphin.glb',
    fit: 3.0,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    // Only 'move' is usable — the other clip is a T-pose, which would snap the
    // model into a rest stance if it were ever selected.
    animations: {
      idle: 'Dolphin_Rig|Dolphin_Rig|move',
      swim: 'Dolphin_Rig|Dolphin_Rig|move',
      boost: 'Dolphin_Rig|Dolphin_Rig|move',
    },
    // Tail trail — see the rationale on enemyMegalodon. Included because the
    // dolphin counts against the same apex allowance as the sharks, and a big
    // body in that group that moved rigidly next to ones that don't would be
    // the odd one out.
    //
    // Two bones is all this rig has: pelvis_017 is a clean tail root, but
    // tail00_018 immediately forks into the two flukes, so there is nowhere
    // further to run. That is the solver's minimum, and it will read as a
    // hinge rather than as a wave — a rig limitation, not a tuning one.
    //
    // The flukes and pectorals carry the motion here BECAUSE the tail is only
    // two bones — this is the rig with the least spine to work with and the
    // most to gain from the rest of the skeleton. Unlike the orca's fluke lobes
    // (left off deliberately), these hang off tail00_018, which is the LAST
    // bone of a 2-bone chain and therefore barely moves: the tail's own lag has
    // almost no span to accumulate over, so the flukes are not double-lagged in
    // any meaningful way, they are where the trail actually happens.
    rig: {
      springChains: [
        { role: 'tail', bones: ['pelvis_017', 'tail00_018'] },
        { role: 'fin', bones: ['leg_L_019', 'foot_L_020'] },
        { role: 'fin', bones: ['leg_R_021', 'foot_R_022'] },
        { role: 'fin', bones: ['shoulder_L_011', 'arm_L_012', 'hand_L_013'] },
        { role: 'fin', bones: ['shoulder_R_014', 'arm_R_015', 'hand_R_016'] },
      ],
    },
    // Head-look — see enemyShark. The best-shaped head chain in the set: a
    // real neck bone and a real skull, both keyed by the 'move' clip, and
    // head_07 stops short of mouth_010 so aiming never opens the beak.
    //
    // neck_06 carries both pectorals, so leaning the head swings the
    // flippers with it — the same arrangement as the orca's Spine_03_012, and
    // wanted for the same reason.
    lookRig: {
      head: { bones: ['neck_06', 'head_07'], tipAxis: '+Y', tipLength: 0.28 },
    },
    // BITE — mouth_010, the same Blender animal rig as the orca and the
    // low-poly shark, so the same axis and sign (local X, dot 1.000 with the
    // flank axis, positive). A narrow gape: this is a beak, not a maw, and it
    // is the smallest body of the apex group.
    biteRig: { bone: 'mouth_010', axis: 'x', openAngle: 0.38 },
    shape: 'cone', radius: 0.5, height: 1.6, color: 0x9fb4c4, unlit: true,
  },

  enemyStingray: {
    model: '/models/stingray.glb',
    fit: 2.6,
    // This file's origin sits well OUTSIDE the mesh. prepareModel re-centres
    // on centre of mass so it isn't broken, but stating the pivot explicitly
    // keeps it turning about the head like the other swimmers.
    pivot: 0.2,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Stingray_swim',
      swim: 'Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Stingray_swim',
      boost: 'Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Stingray_swim2',
    },
    shape: 'octahedron', radius: 0.6, color: 0x6b7f8f, unlit: true,
  },

  // The ray and the shark, each a copy of an existing creature wearing a
  // different preset. Separate asset keys for the same reason the lanternfish
  // is one: a material is shared across every clone of a key, so lighting
  // `enemyStingray` would light every ordinary ray in the arena with it.
  //
  // Both drop their emissive mask where the original had one. A baked mask
  // says "these texels are bright" and the pattern says the same thing in a
  // moving voice; running both leaves fixed hotspots sitting under a pattern
  // that slides past them, which reads as a texturing bug.
  enemyLanternRay: {
    model: '/models/stingray.glb',
    fit: 2.6,
    pivot: 0.2,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Stingray_swim',
      swim: 'Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Stingray_swim',
      boost: 'Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Animal_3045_Rig|Stingray_swim2',
    },
    // UNLIT, unlike the creatures these three copy. The glow is ADDITIVE, so
    // anything the scene lights contributes on top of it — and on a broad flat
    // body angled at the key light (the ray, measured: its dorsal surface
    // washed all ten patterns into one pale smear) the lit contribution simply
    // beats the pattern. Ignoring scene lights makes the creature's own light
    // the only light on it, which is the whole proposition.
    modelUnlit: true,
    biolumSkin: 'veil',
    tint: 0x16242e,
    shape: 'octahedron', radius: 0.6, color: 0x16242e, unlit: true,
  },

  enemySeaTurtle: {
    model: '/models/seaturtle.glb',
    fit: 2.2,
    pivot: 0.2,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'TurtleChocolate_Rig|TurtleChocolate_Rig|TurtleChocolate_Rig|Turtle_idle',
      swim: 'TurtleChocolate_Rig|TurtleChocolate_Rig|TurtleChocolate_Rig|Turtle_swim',
      boost: 'TurtleChocolate_Rig|TurtleChocolate_Rig|TurtleChocolate_Rig|Turtle_run',
    },
    shape: 'icosahedron', radius: 0.7, color: 0x5d7a4f, unlit: true,
  },

  // ATLANTIC FOOTBALLFISH — the deep-sea anglerfish, built by
  // tools/build-anglerfish.mjs out of an 8-file, 50MB FBX pack. It is the only
  // creature in the roster that arrives with SEVEN authored clips on one rig,
  // which is why the state mapping below is a real mapping rather than the
  // usual one-clip-named-three-times.
  //
  // ORIENTATION IS MEASURED THROUGH THE SKINNING, not read off the geometry —
  // the mosasaur's lesson, and the reason every axis here is stated with the
  // number that settled it. Software-skinned in the rest pose the animal is
  // 62.07 units along Z, and the two landmarks that cannot be argued with sit
  // where they should: the TEETH centroid at z +16.1 against the whole body's
  // +1.7 (so the head is +Z), and the EYES at y +7.4 against the teeth's +0.4
  // (so up is +Y). Same basis as every shark here.
  //
  // FIT 3.4. Against the assets.csv size of 2.5 that measures 8.5 units on
  // screen — deliberately between the dolphin's 7.2 and the shark's 10.1. It is
  // a chunky ambusher rather than an apex body, and the roster already has four
  // animals past 20 units. Note the fit divides the LONGEST axis, which on this
  // animal is nose-to-tail: the illicium sticks up rather than forward, so it
  // inflates the height (37.67) and not the number this scales by.
  //
  // THE CLIPS, measured by mean vertex travel per second on a fixed subset, and
  // by the vertical gape of the teeth mesh for what the mouth is doing:
  //
  //   idle        8.33s   0.74/s   gape 10.9-11.5   a quiet hold
  //   swim1       4.00s   3.22/s   gape 10.2-11.7   the cruise
  //   swim2       4.40s   7.79/s   gape 10.4-12.3   2.4x the cruise — a real gear
  //   bite        4.67s   4.36/s   gape  7.8-11.9   the only clip that SHUTS the
  //                                                 mouth; rest gape is ~11, so
  //                                                 this is a snap, not a gape
  //   trap        8.00s   1.84/s   gape 10.9-13.2   the ambush: near-still, mouth
  //                                                 opening WIDER than rest
  //   swim_start  8.33s   3.50/s                    transitions in and out of the
  //   swim_end    8.33s   2.36/s                    cruise
  //
  // EVERY CLIP LOOPS. The seam — how far the last frame sits from the first —
  // measures 0.00 units on all seven, so any of them can be a locomotion state
  // without a pop, and the one-shots blend back cleanly. That is unusual enough
  // in this roster to be worth writing down.
  //
  // THREE CLIPS ARE MAPPED TO NOTHING, on purpose rather than by omission.
  // `swim_start` and `swim_end` are transitions and there is no state for a
  // transition — createAnimationController blends between locomotion states
  // itself. `trap` is the interesting one: it is this animal's whole character,
  // an ambush hold with the jaw opening past its rest gape, and it has no home
  // until the creature has a behaviour that can sit still and wait. Mapping it
  // to `idle` was tempting and would be wrong — idle is the loop a creature
  // plays while ALIVE and drifting, and a permanently gaping anglerfish would
  // never close its mouth.
  //
  // NO biteRig. entities/enemies.js skips building a procedural jaw driver for
  // anything whose controller already covers `bite`, and this file ships a real
  // one — the mosasaur's arrangement.
  //
  // This asset is REGISTERED, not spawned. It has no enemies.csv row and no
  // spawning.csv entry, so nothing places it in a wave yet.
  enemyAnglerfish: {
    model: '/models/anglerfish.glb',
    fit: 3.4,
    pivot: 0.15, // turn about the head, as every swimmer here does
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'idle',
      swim: 'swim1',
      boost: 'swim2',
      bite: 'bite',
    },
    // The fallback primitive, for the playtest build and for any path that
    // draws before the model resolves. An ellipsoid is the honest stand-in for
    // a body this round — the cone every other fish uses would read as a
    // barracuda.
    shape: 'icosahedron', radius: 0.55, color: 0x2b3a44, unlit: true,
  },

  // THE ANGLERFISH BOSS — the same file as enemyAnglerfish above, mapped to a
  // different set of states.
  //
  // A SECOND ASSET RATHER THAN A FLAG, which is the arrangement
  // enemyBossHammerhead already uses against enemyHammerhead. The reason here
  // is the clip mapping rather than the size: this boss's RESTING state is the
  // ambush, so `idle` has to resolve to `trap` — and a wave anglerfish idling
  // with its jaw cranked past rest, forever, would look broken. One asset
  // cannot answer both, and the alternative (a system reaching in to re-map a
  // shared template at spawn) writes the template every other instance is
  // sharing, which is the same class of bug as flashing the emissive on all of
  // them. Two keys, one model file, no runtime mutation.
  //
  // WHAT EACH STATE IS FOR — the fight is systems/bossAngler.js, and this is
  // the half of it that is data:
  //
  //   idle   -> trap        the lurk. Near-still, jaw opening past its rest
  //                         gape. The boss holds this for most of the fight.
  //   bark   -> swim_start  THE TELL. `swim_start` is the file's transition
  //                         INTO the cruise — an animal gathering itself to
  //                         move — which is exactly what a wind-up is, and it
  //                         is why this clip was worth keeping. `bark` is the
  //                         one-shot slot because that is what the kraken
  //                         already uses for its telegraph (`eyeballing`); a
  //                         player is learning one grammar, not two.
  //   boost  -> swim2       the lunge. 7.79u/s against the cruise's 3.22.
  //   bite   -> bite        the snap at the end of it.
  //   swim   -> swim1       repositioning between ambushes.
  //
  // `hit` IS DELIBERATELY UNMAPPED. The file's `swim_end` is the obvious
  // candidate and it is wrong: a hit reaction has to read in the frame it
  // lands, and swim_end is a 8.3s glide. Left unmapped, systems/animation.js
  // falls through to the spring impulse — which is the reaction every other
  // boss here uses and is authored for exactly this.
  //
  // NO `rig`. The file's own clips cover every state this boss enters, so the
  // procedural wag would only ever fight them. Spring secondary motion still
  // applies through `springChains` — that is what carries the hit.
  enemyBossAnglerfish: {
    model: '/models/anglerfish.glb',
    fit: 3.4,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'trap',
      swim: 'swim1',
      boost: 'swim2',
      bark: 'swim_start',
      bite: 'bite',
    },
    shape: 'icosahedron', radius: 0.55, color: 0x2b3a44, unlit: true,
  },

  enemyBarracuda: {
    model: '/models/barracuda.glb',
    texture: { emissive: '/textures/emissive/barracuda.jpg' },
    fit: 2.4,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    // No clips in the file — the shared controller falls back to the
    // procedural rig, or to no motion at all. Fine for a stiff, darting fish.
    shape: 'cone', radius: 0.35, height: 1.5, color: 0xa8b8c0, unlit: true,
  },

  // Sailfish — the first fast chaser in the roster that actually swims.
  //
  // The barracuda directly above is the creature this is answering. That one
  // is a good silhouette with NO CLIPS AT ALL: it darts across the water as a
  // rigid board, which is acceptable at 0.45 radius and stops being acceptable
  // as the body gets longer. This file ships three takes on a 17-bone rig, so
  // the same role can be played by something a third bigger without the
  // stiffness scaling up with it.
  //
  // THE CLIP MAPPING IS THE POINT. `Armature|Swim` (2.50s) and
  // `Armature|SwimFast` (1.67s) are a genuine cruise/sprint pair, which almost
  // nothing else in the roster has — most entries here name one clip three
  // times because one clip is all there is. So `boost` is a real gear change,
  // not the swim cycle played faster, and `idle` deliberately shares the
  // cruise action with `swim`: that makes the pair `shared` in
  // createAnimationController and hands both of them back to
  // CONFIG.animation.states[...].clipTimeScale, which is where a sailfish
  // idling slower than it cruises wants to be tuned from.
  //
  // THE THIRD CLIP IS UNUSED, on purpose. `Armature|Bite` (1.67s) and the
  // honest `Jaw_04` bone under `Head_02` are between them everything a
  // `behavior: 'hunt'` version of this creature would need — but `biteRig`
  // takes a bone, an AXIS and an angle, and which local axis opens that jaw
  // DOWNWARD is a thing to measure through the skinning rather than read off
  // the hierarchy (see enemyShark.biteRig and enemyOtter.biteRig, both of
  // which came out somewhere the names did not predict). It is a chaser until
  // somebody does that measurement.
  //
  // Orientation is off the bones, not the accessors: `Head_02` sits at z +149
  // and `Jaw_04` at z +243 against `CaudalFin_09` at z -340, and the four
  // `Sail` bones climb to y +414 while the jaw sits at y +238. Nose +Z, back
  // +Y. (The raw POSITION bounds claim the long axis is Y — skin space again,
  // exactly as on enemyPuffer.)
  //
  // `pivot` is tighter than the 0.15 every other fish here uses. The dorsal
  // sail is a tall flag running most of the body's length, so a turn about a
  // point further back sweeps it through a much bigger arc than the head
  // moves; leading closer to the nose keeps the sail trailing the turn rather
  // than swinging across it.
  enemySailfish: {
    model: '/models/sailfish.glb',
    fit: 3.0,
    pivot: 0.1,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'Armature|Swim',
      swim: 'Armature|Swim',
      boost: 'Armature|SwimFast',
    },
    shape: 'cone', radius: 0.4, height: 1.9, color: 0x4a6f8f, unlit: true,
  },


  // Squid. Built by tools/build-squid.mjs from a STILL-RENDER obj, and it has
  // no rig for the same reason the wasp in that library has none: OBJ carries
  // no bones at all, and the only rig-capable sibling is a 2017 VRay .c4d. So
  // the arms are frozen in the flare the artist posed them in, permanently.
  // Everything below is chosen to make that pose WORK rather than to hide it.
  //
  // `forward: '+Z'` is baked rather than declared, unlike most entries here.
  // The source pose runs diagonally through XZ — principal axis
  // (0.582, 0.136, -0.802) — and no forward/up pair can express a diagonal, so
  // the build tool rotates the mesh onto its own axis and this entry just names
  // the result. That rotation is also why the raw file's 23.2 x 9.6 x 26.5
  // bounding box is not worth reading: it is a corner-to-corner box around a
  // streamlined animal. On its own axis the model is 0.475 x 0.252 x 1.000.
  //
  // +Z IS THE ARM END, not the mantle. A squid jets mantle-first to flee and
  // swims arms-first to hunt, and this one is hunting — leading with the
  // tentacles keeps its eyes and its grasping end pointed at what it is closing
  // on, with the fins trailing where they read as propulsion. Mantle-first
  // would send it at the seal tail-first with its face pointing home. The two
  // ends measure within 5% of each other on every shape heuristic worth
  // trying, so this was settled off a rendered plate, not off the geometry.
  //
  // `fit` scales the WHOLE length: at 2.8 that is ~1.6 units of mantle and
  // ~1.2 of arm, which puts the body between the barracuda's 2.4-unit fish and
  // the ray's 2.6 while the arms add reach that carries no hitbox.
  enemySquid: {
    model: '/models/squid.glb',
    fit: 2.8,
    // Origin at the head — where the arms meet the mantle, 42% back from the
    // arm tips. This mesh's centre of mass sits inside the mantle, so at the
    // default the squid would swing its whole arm bundle around a point behind
    // its own eyes every time it corrected course.
    pivot: 0.42,
    forward: '+Z', up: '+Y',
    // No clips — the source is one static mesh. The shared controller falls
    // back to the procedural rig or to no motion, same as the barracuda.
    shape: 'cone', radius: 0.4, height: 1.5, color: 0x86705b, unlit: true,
  },

  // THE GIANT SQUID — the boss body, and the rigged sibling enemySquid above
  // says it never had. That entry's note is worth reading first: the small squid
  // is frozen in the flare its artist posed it in, permanently, because OBJ
  // carries no bones and the only rig-capable relative was a 2017 VRay .c4d.
  // This is a different animal from a different source with a real armature, so
  // everything that entry had to design around, this one simply does.
  //
  // Source: "Giant Squid Creature" by Ethan (sketchfab.com/ethanchew), CC-BY-4.0.
  // The licence needs a visible credit somewhere in the build, which this
  // comment is NOT — see the note in the README.
  //
  // 23,305 verts / 41,943 triangles / six 1024x1024 maps. That is megalodon
  // budget (37,604 / 30,100 / seven maps) and it is affordable for the same
  // reason the megalodon's is: maxConcurrent 1, and systems/boss.js is the only
  // thing that can put one in the water. It would not be affordable for anything
  // that spawns in numbers.
  //
  // ORIENTATION, MEASURED — tools/check-squid-orientation.mjs renders all six
  // plausible pairs through the game's own basis and camera. The two facts that
  // decided it:
  //
  //   THE CROWN HAS TO SPLAY ACROSS THE SCREEN, not into it. Same requirement
  //   octoGrabber has and for the same reason: the arms are the silhouette, and
  //   a crown pointed at the camera is a mantle with a smudge under it. Under
  //   '-Y'/'+X' the body measures 2.60 x 6.00 on screen against 2.71 deep, with
  //   the arms fanned symmetrically either side of the mantle.
  //
  //   THE BIND POSE LEANS. Not by much, but it leans in one plane — so the true
  //   side view ('-Y'/'+Z', one eye, anatomically correct) draws the animal at a
  //   visible slant, and `faceMotion` would then swim it crabwise for the whole
  //   fight. '+X' puts that lean directly along the view axis where it does not
  //   show. Choosing the dorsal read over the lateral one is the same trade
  //   octoGrabber made, and it is what the crown wants anyway.
  //
  // ARMS LEAD, mantle trails: forward is '-Y' rather than '+Y'. A squid jets
  // mantle-first to flee and swims arms-first to hunt, and a boss is hunting —
  // exactly the argument enemySquid makes at length above, reaching the same
  // answer on a different axis.
  enemyGiantSquid: {
    model: '/models/giantsquid.glb',
    // The longest axis in world units, which on this body is mantle tip to arm
    // tip. Bigger than the orca bull's 5.2 because much more of that length is
    // ARM — the mantle alone is about 45% of it — and a kraken whose body reads
    // the size of an orca's needs to be longer overall than one.
    fit: 7.4,
    // Origin at the crown's base, where the arms meet the head. The bounding
    // box centre sits inside the mantle, and pivoting there would swing the
    // whole arm bundle around a point well behind the animal's eyes on every
    // course correction — the same reason enemySquid pivots at 0.42.
    pivot: 0.38,
    forward: '-Y', up: '+X',
    // THE FIVE CLIPS THE FILE SHIPS, mapped onto the state machine. What is
    // NOT here is the important part: there is no swim take and no attack take
    // in this file at all. Measured travel tops out at 17.7% of body length on
    // `Idle` and 23.6% on `flapper`, and the other three are eye motion.
    //
    // So the mapping is deliberately thin and the RIG does the locomotion —
    // ten spring chains with no clip fighting them, which is the arrangement
    // systems/animation.js documents as rule 3 and which the octopus companion
    // already runs on (octopus_rig.glb ships 128 bones and zero clips).
    //
    //   idle    -> Idle      the arms working, the animal holding station.
    //   swim    -> flapper   the mantle fins driving. It is the only take in the
    //                        file that moves the body rather than the limbs, so
    //                        it is the only honest candidate for locomotion.
    //   boost   -> flapper   the same take. animation.js plays it at the boost
    //                        state's own clipTimeScale, which is what a squid
    //                        jetting looks like: the same stroke, faster.
    //
    //   bark    -> eyeballing  the ink burst's TELEGRAPH. `bark` is the state
    //                          machine's emote one-shot, and systems/kraken.js
    //                          fires it in the beat before every burst so the
    //                          eyes roll first and the cloud is something the
    //                          player saw coming. Reusing the shared emote state
    //                          rather than inventing a kraken-only one is
    //                          deliberate — see the note there.
    //
    // The two blink takes are left unmapped. They are ambient detail rather than
    // states, and the only way to play them would be a second AnimationMixer on
    // the same tree, fighting `Idle` (175 tracks, the eyelids among them) over
    // the same bones. A mixer cannot restore a bone another mixer wrote.
    animations: {
      idle: 'Idle',
      swim: 'flapper',
      boost: 'flapper',
      bark: 'eyeballing',
    },
    rig: SQUID_RIG,
    // THE FALLBACK BODY, used when the model fails to load — and sized against
    // the MANTLE rather than against the whole animal. tools/boss-test.mjs
    // measures it against the hitbox radius and wants the two within sight of
    // each other, which is the right requirement: a fallback drawn at half its
    // hitbox is a boss that hits you from off its own body.
    //
    // The mantle-and-head is the solid ~55% of this creature; the arms are the
    // rest and they carry no hitbox at all. So this stands in for the part a
    // circle can honestly represent. At 1.6 x 4.2 it measures 1.00x the hitbox
    // through the boss's two size steps, against the megalodon's 0.91x — the
    // first guess (0.8 x 2.4) came out at 0.57x and boss-test failed it, which
    // is exactly what that assertion is for.
    shape: 'cone', radius: 1.6, height: 4.2, color: 0x2a0f14, unlit: true,
  },

  enemyOyster: {
    model: '/models/oyster.glb',
    texture: { emissive: '/textures/emissive/oyster.jpg' },
    fit: 1.8,
    forward: '+Z', up: '+Y',
    shape: 'icosahedron', radius: 0.5, color: 0xd8c4b0, unlit: true,
  },

  // Chum. The one rock that turns up in piles — a dozen settled on the seabed
  // used to be a dozen identical spheres, so this gets the biggest variant
  // pool and the roughest noise (high amplitude, low frequency) to break that
  // up. Tumbles slowest of the lot: they're litter on the floor, not something
  // in flight.
  xpOrb: {
    shape: 'rock', radius: 0.28, color: 0xff3355, unlit: true,
    rock: { variants: 10, tumble: 0.55, amplitude: 0.5, frequency: 1.7, squash: 0.38 },
  },

  // A CHUNK — one large piece of the same catch, worth a real bite of health
  // rather than the sliver an orb pays. Same `rock` machinery as chum above and
  // deliberately so: it has to read as MORE OF THE SAME THING, not as a medkit,
  // or the seal is picking up a different game's pickup. What separates it is
  // size (see assets.csv), a warmer, meatier colour, and the fact that it is
  // the only chum that glows on arrival.
  //
  // Rougher and slower than an orb: fewer variants because you see one at a
  // time rather than a dozen in a heap, higher amplitude because at this size
  // a smooth lump reads as a ball, and half the tumble because a heavy piece
  // should turn like one.
  chumChunk: {
    shape: 'rock', radius: 0.28, color: 0xff6a4a, unlit: true,
    rock: { variants: 5, tumble: 0.28, amplitude: 0.62, frequency: 1.3, squash: 0.3 },
  },
  particle: { shape: 'sphere', radius: 0.08, color: 0xffffff, unlit: true },
};

// --- the club variants -----------------------------------------------------
//
// Derived from `club` rather than written out four times, so the things that
// make a club a club — the grip pivot, the forward axis, the fit that ties the
// drawing to the reach it hits with — can only ever be changed in one place.
// Four hand-copied entries is four chances for one of them to keep a stale
// pivot and be held by its middle.
//
// Each is a real asset key, which is what buys the arrangement its future: the
// T-menu uploads per key and assets.csv sizes per key, so dropping a distinct
// model on Cold Snap later is a drag and a row, with no code change at all.
// Today they all name the same file and differ only in colour.
for (const [key, headTint] of [
  ['clubBoom', 0xd94a2b],   // Boom Boom Club — ember
  ['clubIce', 0x7fd4f5],    // Cold Snap — ice
  ['clubThrow', 0xe0c070],  // Hurler — bound in pale cord
]) {
  ASSETS[key] = {
    ...ASSETS.club,
    // THE SHAFT STAYS BROWN. Only the head carries the variant, which is what
    // makes the set read as four clubs rather than four differently-coloured
    // sticks — and it keeps the silhouette honest, since the wood is the part
    // the seal is actually holding.
    headTint,
    // The fallback SHAPE has no head to speak of (it is one oval), so its flat
    // colour takes the head's tint instead: a variant whose model failed to
    // load still says which variant it is, which is exactly the moment you
    // most need to know.
    color: headTint,
    outline: { ...ASSETS.club.outline },
  };
}

const loadedModels = new Map();
const geometryCache = new Map();
const materialCache = new Map();
// key -> [Mesh], one per entry in ASSETS[key].sprites. A POOL rather than a
// single template, like shape:'rock' — createVisual picks one per spawn. An
// upload for the same key still wins, since loadedModels is checked first.
const spriteVariants = new Map();

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Marks a texture that was never fetched because it doesn't exist — see
// fbxManager below. prepareModel drops any slot holding one of these.
const MISSING_SIDECAR = '__missingSideCar';

// Texture slots an FBX material can arrive with. Any of these left pointing at
// a texture that never resolves is actively harmful, not merely unused: three
// binds a 1x1 transparent-black texture in its place, so `map` multiplies the
// diffuse to black and `alphaMap` multiplies alpha to zero.
const FBX_TEXTURE_SLOTS = [
  'map', 'alphaMap', 'bumpMap', 'normalMap', 'specularMap', 'roughnessMap',
  'metalnessMap', 'emissiveMap', 'aoMap', 'displacementMap', 'lightMap', 'envMap',
];

// Every .fbx here is a third-party export whose material slots name side-car
// textures that live on the author's own machine — `F:\3dsmax\...\
// T_Seagull_BaseColor.jpg`, `D:\artworks\...\beluga_whale_diff.png`,
// `Trout.fbm\T_Trout_3_D.dds`. None of them were ever shipped with the models.
// FBXLoader takes the basename and requests it next to the model, so each slot
// cost a 404 on every boot (/models/T_Trout_3_D.dds and friends) AND left the
// material holding a texture that never resolves — which is why the trout
// spawned completely invisible: its alphaMap sampled the empty texture and
// zeroed the whole mesh's alpha.
//
// Fetching them can never succeed, so don't: hand FBXLoader a stub that
// returns an empty texture without touching the network, tagged so the slot
// gets dropped rather than rendered through. Textures EMBEDDED in an .fbx
// still load normally — those arrive as blob:/data: URLs and are passed
// through to a real TextureLoader.
const fbxManager = new THREE.LoadingManager();
{
  const real = new THREE.TextureLoader(fbxManager);
  const stub = {
    path: '',
    setPath(p) { this.path = p ?? ''; return this; },
    setCrossOrigin() { return this; },
    load(url, onLoad, onProgress, onError) {
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        return real.load(url, onLoad, onProgress, onError);
      }
      const t = new THREE.Texture();
      t.userData[MISSING_SIDECAR] = true;
      return t;
    },
  };
  // FBXLoader looks a handler up by extension alone, e.g. getHandler('.dds').
  for (const ext of ['jpg', 'jpeg', 'png', 'dds', 'tga', 'bmp', 'tif', 'tiff', 'psd']) {
    fbxManager.addHandler(new RegExp(`\\.${ext}$`, 'i'), stub);
  }
}

// Pick a loader from the file extension so the registry stays format-agnostic.
// .glb/.gltf resolve to `gltf.scene`; .fbx returns the Object3D directly.
function loaderFor(url) {
  if (url.startsWith('data:model/gltf-binary') || url.startsWith('data:model/gltf+json')) {
    return { kind: 'gltf', loader: new GLTFLoader(), unwrap: (r) => r.scene };
  }
  if (url.startsWith('data:application/octet-stream')) {
    return { kind: 'fbx', loader: new FBXLoader(fbxManager), unwrap: (r) => r };
  }
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  if (ext === 'fbx') return { kind: 'fbx', loader: new FBXLoader(fbxManager), unwrap: (r) => r };
  if (ext === 'glb' || ext === 'gltf') return { kind: 'gltf', loader: new GLTFLoader(), unwrap: (r) => r.scene };
  return null;
}

// Decode a base64 data URI into an ArrayBuffer ourselves.
//
// loadAsync() would route this through fetch(), and some sandboxed hosts
// intercept fetch and try to postMessage the Request object, which isn't
// structured-cloneable — the load fails with a confusing clone error. Parsing
// the bytes directly skips the network layer altogether.
function dataUriToArrayBuffer(uri) {
  const base64 = uri.slice(uri.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadModel(picked, url) {
  if (!url.startsWith('data:')) return picked.loader.loadAsync(url);

  const buffer = dataUriToArrayBuffer(url);
  // FBXLoader.parse returns the object directly; GLTFLoader.parse is callback
  // based and must only ever be invoked once.
  if (picked.kind === 'fbx') return picked.loader.parse(buffer, '');
  return new Promise((resolve, reject) => picked.loader.parse(buffer, '', resolve, reject));
}

// Nine files in ASSETS are named by more than one entry — fishpack.glb by three
// (the meshIndex trio), oyster/fish/greatwhite/trawler/orca/stingray/crabpincer
// by two each. THREE.Cache is off by default and loadModel goes straight to the
// loader, so each entry used to fetch and PARSE its own copy: 13.4MB of
// redundant transfer, and — because the second parse builds a second set of
// THREE.Textures over a second decode of the same JPEG — a second full GPU
// upload of textures the first entry had already resident. fishpack alone paid
// for three.
//
// So parse once per URL and hand every entry an independent instance of that
// one parse. What "independent" has to mean here is the whole subtlety:
//
//   NODES must be per-entry. prepareModel mutates the hierarchy it is given —
//     isolateMesh deletes the meshes a meshIndex entry didn't ask for, and the
//     fit/pivot maths writes scale and position onto the root.
//   GEOMETRY must be per-entry. attachBiolumSkin (called from prepareModel)
//     writes aBioPos/aBioAxis attributes onto the geometry, and the pairs
//     sharing a file are not all alike: lanternfish is bioluminescent and fish
//     is not, off one fish.glb; likewise lanternRay against stingray.
//   TEXTURES must be per-entry OBJECTS over a SHARED image. setAssetRepeat and
//     the texture panel write wrapS/repeat onto material.map for one asset key,
//     which would otherwise reach through into the other entry's materials.
//
// That last one is why this shares Sources rather than Textures. Texture.copy
// assigns `this.source = source.source` by reference, and WebGLTextures keys
// its upload cache on the Source (`_sources.get(source)`) with a secondary key
// built from the sampler settings — so two clones of one texture that still
// agree on wrap/filter/flipY resolve to a single WebGLTexture and upload once.
// Change the repeat on one asset afterwards and only that asset's cache key
// moves, allocating a second GL texture for it alone. The sharing is real but
// it is not a trap: it comes apart exactly where the tuner needs it to.
const parsedModelCache = new Map(); // url -> Promise<{ source, animations }>

function loadSharedModel(picked, url) {
  let pending = parsedModelCache.get(url);
  if (!pending) {
    pending = loadModel(picked, url).then((result) => ({
      // GLTFLoader puts clips on the result object and the scene under
      // `.scene`; FBXLoader returns the Object3D itself with clips on it.
      // Unwrap here so the cached shape is the same for both.
      source: picked.unwrap(result),
      animations: result.animations ?? [],
    }));
    parsedModelCache.set(url, pending);
  }
  return pending;
}

// Never hands back the cached parse itself, even to the first caller — the
// master stays pristine so it does not matter which entry gets there first,
// and preloadAssets drops the cache at the end so the master is collectable
// (its Sources stay alive, held by the clones that are actually in the scene).
//
// Exported for tools/model-share-test.mjs, for the same reason installModel is:
// preloadAssets fetches by URL and a terminal script has no way to serve that,
// so the sharing rules above are only testable if the instancing step can be
// called on a model the harness parsed itself.
export function instantiateParsedModel(source) {
  let skinned = false;
  source.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
  const copy = skinned ? skeletonClone(source) : source.clone(true);

  // One texture used twice within a single model stays one texture within the
  // clone of it — the isolation this needs is between ENTRIES, not between the
  // slots of one entry.
  const textures = new Map();
  const cloneTexture = (t) => {
    if (!t?.isTexture) return t;
    let c = textures.get(t);
    if (!c) {
      c = t.clone();
      // Texture.clone() leaves needsUpdate false, and must: the Source is
      // already uploaded (or queued) by whoever else holds it, and flipping
      // needsUpdate here would bump source.version and force every sharer to
      // re-upload the image we just went to the trouble of sharing.
      textures.set(t, c);
    }
    return c;
  };
  const cloneMaterial = (mat) => {
    const m = mat.clone();
    // FBX_TEXTURE_SLOTS is just the standard map-slot list; nothing about the
    // sweep below is FBX-specific.
    for (const slot of FBX_TEXTURE_SLOTS) {
      if (m[slot]?.isTexture) m[slot] = cloneTexture(m[slot]);
    }
    return m;
  };

  copy.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.geometry = o.geometry.clone();
    o.material = Array.isArray(o.material)
      ? o.material.map(cloneMaterial)
      : cloneMaterial(o.material);
  });
  return copy;
}

/**
 * Register an already-parsed model under an asset key, running it through the
 * same `prepareModel` the network path uses so it gets the identical fit,
 * orientation, pivot and material treatment.
 *
 * This exists because `preloadAssets` fetches by URL, which a terminal script
 * has no way to serve — so a headless harness that wants to exercise a real
 * RIG (bone chains, IK reach) rather than the procedural stand-in has no way
 * in. It's the same operation `loadUploadedModel` already performs on a File,
 * just starting from an Object3D someone else parsed.
 */
export function installModel(key, source, clips = []) {
  const def = ASSETS[key];
  if (!def) {
    console.warn(`[assets] installModel: unknown asset "${key}"`);
    return false;
  }
  loadedModels.set(key, prepareModel(source, def, clips, null, key));
  return true;
}

export async function preloadAssets(onProgress) {
  const entries = Object.entries(ASSETS).filter(([, def]) => def.model);
  const spriteEntries = Object.entries(ASSETS).filter(([, def]) => def.sprites?.length);
  const total = entries.length + spriteEntries.length;
  let done = 0;
  const textureLoader = new THREE.TextureLoader();
  const step = () => {
    done += 1;
    onProgress?.(done / total);
  };

  // Loose side-car textures have the same duplicate problem as the models —
  // enemyOyster and scallopShell both name /textures/emissive/oyster.jpg — and
  // TextureLoader caches nothing either. Same treatment: decode once, hand out
  // clones over the shared Source. Keyed by flipY as well as URL because the
  // caller sets flipY per ENTRY (from the model's format), and while a clone
  // could carry its own value, two entries that disagree would each need their
  // own upload anyway — keeping them in separate cache slots just makes that
  // explicit instead of surprising.
  const looseTextures = new Map();
  const loadSharedTexture = async (url, flipY) => {
    const cacheKey = `${url}|${flipY}`;
    let pending = looseTextures.get(cacheKey);
    if (!pending) {
      pending = textureLoader.loadAsync(url).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = flipY;
        return t;
      });
      looseTextures.set(cacheKey, pending);
    }
    return (await pending).clone();
  };

  await Promise.all([
    ...spriteEntries.map(async ([key, def]) => {
      try {
        await loadDeclaredSprites(key, def, textureLoader);
      } finally {
        step();
      }
    }),
    ...entries.map(async ([key, def]) => {
      try {
        const picked = loaderFor(def.model);
        if (!picked) throw new Error(`no loader for ${def.model}`);
        // Parsed at most once per URL however many entries name it; this is
        // always our own instance of it. Clips are shared as-is: an
        // AnimationClip is inert data that the per-entry AnimationMixer reads
        // and never writes, and buildSubclips already clones before slicing.
        const parsed = await loadSharedModel(picked, def.model);
        const source = instantiateParsedModel(parsed.source);
        const clips = parsed.animations;
        // Which way up a loaded-by-hand texture goes is a per-FORMAT decision,
        // not one convention for the whole roster. GLTFLoader sets
        // flipY = false on the maps it creates, because glTF UVs are top-left
        // origin; FBXLoader sets nothing, so an FBX keeps the THREE.Texture
        // default of true. A texture we load ourselves has to match whatever
        // the model's own maps did, or it renders vertically mirrored.
        //
        // `def.texture.flipY` overrides that, and the reason it has to exist is
        // that the rule above assumes the loose texture was DERIVED FROM the
        // model's own maps — which is true of every emissive mask here, since
        // they were thresholded from the embedded diffuse and so inherit its
        // orientation. It is not true of a model that ships no maps at all: its
        // sidecars came from somewhere else entirely and carry whatever
        // convention that tool wrote. See enemyHammerhead, which is the only
        // asset in that position.
        const flipY = def.texture?.flipY ?? /\.fbx$/i.test(def.model ?? '');
        let overrideTex = null;
        if (def.texture?.map) {
          try {
            overrideTex = await loadSharedTexture(def.texture.map, flipY);
          } catch (err) {
            console.warn(`[assets] "${key}" texture ${def.texture.map} failed to load — keeping the model's own texture.`, err?.message ?? err);
          }
        }
        // The emissive mask (CONFIG.glow.emissiveMaps). sRGB like the colour
        // map, not linear: it was thresholded in sRGB space from an sRGB
        // source, so decoding it as linear would pull the midtones down and
        // shrink the lit area against what the mask actually looks like.
        //
        // A failure here is deliberately non-fatal and non-blocking — the
        // model still loads, it just has no mask, and the toggle then does
        // nothing for this one asset rather than taking the creature with it.
        let emissiveTex = null;
        if (def.texture?.emissive) {
          try {
            // flipY is not a hardcoded false: that is the glTF value, and it
            // silently mirrored the mask on every FBX creature. A flipped mask
            // still looks like a plausible mask, so it was measured rather
            // than eyeballed — rasterising the seagull's own mapped UV
            // triangles onto its art sheet puts 0.6% of the mapped area on
            // sheet background the right way up and 24.1% the wrong way up.
            // tools/uv-flip-check.mjs re-runs that on any model.
            emissiveTex = await loadSharedTexture(def.texture.emissive, flipY);
          } catch (err) {
            console.warn(`[assets] "${key}" emissive mask ${def.texture.emissive} failed to load — it will fall back to uniform glow.`, err?.message ?? err);
          }
        }
        loadedModels.set(key, prepareModel(source, def, clips, overrideTex, key, emissiveTex));
      } catch (err) {
        console.warn(
          `[assets] "${key}" could not load ${def.model} — using the built-in shape instead.`,
          err?.message ?? err
        );
      } finally {
        step();
      }
    }),
  ]);

  // The masters have done their job. Dropping them lets the duplicated node
  // graphs and geometry be collected; the Sources they decoded stay alive
  // through the texture clones now sitting on real materials, which is the
  // whole point. Uploaded/restored models take their own path and never
  // consult this cache, so there is nothing left to serve.
  parsedModelCache.clear();

  if (total === 0) onProgress?.(1);
}

const AXES = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};

function axisVec(name) {
  const a = AXES[name];
  if (!a) {
    console.warn(`[assets] bad axis "${name}", falling back to '+Y'`);
    return new THREE.Vector3(0, 1, 0);
  }
  return new THREE.Vector3().fromArray(a);
}

// Build the rotation that takes the model's own axes into entity-local space,
// where +Y is the direction of travel and +Z points at the camera.
//
//   side view : forward -> +Y, the model's up -> -X (screen-up when heading
//               right), and its flank turns to face the camera.
//   top-down  : forward -> +Y, the model's up -> +Z (facing the camera).
export function orientationQuaternion(def) {
  const f = axisVec(def.forward ?? '-Z').normalize();
  const u = axisVec(def.up ?? '+Y').normalize();
  const flank = new THREE.Vector3().crossVectors(f, u).normalize();

  let ax, ay, az;
  if (CONFIG.view === 'side') {
    ax = u.clone().negate();
    ay = f.clone();
    az = flank.clone();
  } else {
    ax = flank.clone();
    ay = f.clone();
    az = u.clone();
  }

  // makeBasis gives world -> model; its transpose is the rotation we want.
  const basis = new THREE.Matrix4().makeBasis(ax, ay, az).transpose();
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

// Some exports include a sub-mesh at a wildly different scale from the rest
// of the model (seen in practice: an eyeball mesh with a broken huge bounding
// box on an otherwise normally-scaled body, and — the opposite direction —
// a "Gills" mesh nearly 100x too big). If that mesh dominates the union bbox,
// `fit` normalizes the WHOLE model to make the outlier fit, and the real body
// shrinks to near-invisible. Excluding it from JUST the sizing math isn't
// enough on its own, though: fit scales the whole model uniformly, so an
// outlier that's too BIG (not too small) stays roughly 100x too big after
// scaling too — it doesn't shrink to a harmless speck the way an oversized
// bounding box on a tiny-vertex mesh does. So the outlier is hidden outright,
// not just excluded from sizing — it was already broken data either way, and
// this makes that harmless regardless of which direction the corruption goes.
function referenceBox(model, label) {
  model.updateMatrixWorld(true); // guarantee world-space math below is correct, not relying on Box3's internal side effects
  const meshes = [];
  model.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (meshes.length <= 1) return { box: new THREE.Box3().setFromObject(model), excluded: [], included: meshes };

  let infos = meshes.map((o) => {
    const b = new THREE.Box3().setFromObject(o);
    const s = new THREE.Vector3();
    b.getSize(s);
    return { o, b, diag: s.length() };
  });

  // A real body-plus-detail model (body + teeth + eyes, say) can legitimately
  // have its biggest mesh 10-20x the size of its smallest — that's normal and
  // must not trigger exclusion. What's NOT normal is a detail mesh whose bbox
  // is two-plus orders of magnitude beyond everything else in the file.
  // So only ever drop the single largest mesh, and only when it dwarfs the
  // next-largest by a huge margin — repeated in case more than one mesh in
  // the file is broken this way.
  const excludedInfos = [];
  for (let guard = 0; guard < 3; guard++) {
    if (infos.length <= 1) break;
    const sorted = [...infos].sort((a, b) => b.diag - a.diag);
    const [largest, second] = sorted;
    if (second.diag > 1e-6 && largest.diag > second.diag * 40) {
      infos = infos.filter((i) => i !== largest);
      excludedInfos.push(largest);
    } else {
      break;
    }
  }

  const box = new THREE.Box3();
  for (const info of infos) box.union(info.b);
  if (infos.length === 0) return { box: new THREE.Box3().setFromObject(model), excluded: [], included: meshes };

  if (excludedInfos.length > 0) {
    console.warn(`[assets] "${label}": ${excludedInfos.length} sub-mesh(es) at a wildly different scale were hidden (broken export data — not used for sizing OR rendered).`);
  }
  return { box, excluded: excludedInfos.map((i) => i.o), included: infos.map((i) => i.o) };
}

// The bounding-box midpoint ((min+max)/2) is NOT the same thing as a mesh's
// center of mass — for anything asymmetric (a tail extending further one
// way than the head, flippers splayed off to one side, a long thin body),
// the two can be meaningfully different, and using the bbox midpoint as the
// rotation/position pivot makes the model visibly orbit around the wrong
// point. This computes an area-weighted centroid across the mesh's actual
// triangles instead — treating the surface as a uniform-density shell, a
// standard, cheap stand-in for true center of mass that doesn't require a
// full volumetric (tetrahedral) integral, and accurate enough for a game
// asset's pivot. Falls back to the bbox center if a mesh has no triangles.
//
// A single corrupted triangle inside an otherwise-normal mesh (found in
// practice: megalodon's body mesh has one degenerate face with an area
// ~40x any real triangle on it, connected to a stray vertex 59 units from
// the rest of the mesh) can dominate an area-weighted sum on its own —
// invisible to the whole-MESH outlier check above, since it doesn't make
// that mesh's overall bbox anomalous relative to its neighbors, only badly
// distorts what should be a fine-grained surface average. So this runs two
// passes: gather every triangle's area and centroid first, find the median
// area (robust to a few extreme outliers, unlike a mean would be), then sum
// only triangles under a reasonable multiple of that — same "one broken
// thing shouldn't dominate a big average" principle as the mesh-level
// check, just applied per-triangle instead of per-mesh.
// A vertex in the SAME space referenceBox measured the model in.
//
// This has to go through getVertexPosition rather than reading `position`
// directly: for a SkinnedMesh the raw position attribute is the BIND pose,
// which for a rigged export can sit nowhere near where the model actually
// renders. three.js's Box3.setFromObject already accounts for this (a
// SkinnedMesh defines its own computeBoundingBox, which poses every vertex),
// so referenceBox's box is the POSED body while the raw attribute is not —
// and averaging one against the other put the anchor in a different
// coordinate space from the body it was supposed to balance.
//
// Measured on the shipped models, bind pose vs posed vertical extent:
//   megalodon.glb  posed [0.37, 4.83]   bind [-158.29, 68.11]
//   shark.glb      posed [-0.28, 2.33]  bind [-4.16, 3.35]
//   greatwhite.glb posed [0.19, 1.02]   bind [-1.71, 0.79]
// which is how the megalodon's anchor ended up nearly five body-heights
// below its own mesh. getVertexPosition is what three uses internally for
// exactly this, and also folds in morph targets.
function worldVertex(mesh, index, target) {
  if (typeof mesh.getVertexPosition === 'function') {
    mesh.getVertexPosition(index, target);
  } else {
    target.fromBufferAttribute(mesh.geometry.attributes.position, index);
  }
  return target.applyMatrix4(mesh.matrixWorld);
}

function computeCentroid(meshes, fallback, referenceBounds = null) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const triCentroid = new THREE.Vector3();
  const weightedSum = new THREE.Vector3();
  let totalArea = 0;
  let totalRejected = 0;

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos) continue;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;

    // Different meshes in one file can have very different natural triangle
    // densities (teeth densely tessellated with tiny faces, a body with
    // fewer, legitimately larger ones) — the outlier threshold has to be
    // relative to THIS mesh's own typical face size, not a global figure
    // mixing scales that were never meant to be compared to each other.
    const meshTris = [];
    for (let i = 0; i < count; i += 3) {
      const ia = idx ? idx.getX(i) : i;
      const ib = idx ? idx.getX(i + 1) : i + 1;
      const ic = idx ? idx.getX(i + 2) : i + 2;
      worldVertex(mesh, ia, a);
      worldVertex(mesh, ib, b);
      worldVertex(mesh, ic, c);

      const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() * 0.5;
      if (area < 1e-12) continue;

      triCentroid.copy(a).add(b).add(c).divideScalar(3);
      meshTris.push({ area, x: triCentroid.x, y: triCentroid.y, z: triCentroid.z });
    }
    if (meshTris.length === 0) continue;

    const sortedAreas = meshTris.map((t) => t.area).sort((x, y) => x - y);
    const medianArea = sortedAreas[Math.floor(sortedAreas.length / 2)];
    const areaCap = medianArea > 1e-12 ? medianArea * 75 : Infinity;

    for (const t of meshTris) {
      if (t.area > areaCap) { totalRejected++; continue; }
      weightedSum.addScaledVector(new THREE.Vector3(t.x, t.y, t.z), t.area);
      totalArea += t.area;
    }
  }

  if (totalRejected > 0) {
    console.warn(`[assets] ignored ${totalRejected} degenerate triangle(s) (area far beyond that mesh's own typical face) when computing its center-of-mass pivot.`);
  }

  if (totalArea <= 1e-9) return fallback;
  const centroid = weightedSum.divideScalar(totalArea);

  // The centre of mass of a closed surface cannot lie outside that surface's
  // own bounding box, so if it does, the input was bad data however it got
  // that way and the average is not describing the body. Fall back per axis
  // rather than wholesale: one corrupted axis shouldn't throw away a
  // perfectly good centroid on the other two. Same "one broken thing
  // shouldn't dominate" principle as the mesh- and triangle-level checks
  // above, one level up — and a guard against the next bad export, not just
  // the ones in the project today.
  if (referenceBounds && !referenceBounds.isEmpty()) {
    const size = new THREE.Vector3();
    referenceBounds.getSize(size);
    const mid = new THREE.Vector3();
    referenceBounds.getCenter(mid);
    for (const axis of ['x', 'y', 'z']) {
      if (size[axis] < 1e-6) continue;
      const slack = size[axis] * 0.05; // a hair of tolerance for float noise
      if (centroid[axis] < referenceBounds.min[axis] - slack || centroid[axis] > referenceBounds.max[axis] + slack) {
        console.warn(`[assets] centre-of-mass ${axis} landed outside the model's own bounds — using its bounding-box centre on that axis instead.`);
        centroid[axis] = mid[axis];
      }
    }
  }

  return centroid;
}

// For a file bundling several creatures in one scene (e.g. a "fish pack"),
// `meshIndex` on an ASSETS entry keeps only that one mesh (plus whatever
// ancestor nodes it needs) and prunes the rest, so one loaded file can back
// several independent, separately-scaled/centred assets.
function isolateMesh(model, index) {
  const meshes = [];
  model.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const target = meshes[index];
  if (!target) {
    console.warn(`[assets] meshIndex ${index} out of range (file has ${meshes.length} meshes).`);
    return;
  }
  const keep = new Set();
  for (let o = target; o; o = o.parent) keep.add(o);
  const toRemove = [];
  model.traverse((o) => { if (o.isMesh && !keep.has(o)) toRemove.push(o); });
  for (const o of toRemove) o.parent?.remove(o);
}

// Carve named sub-clips out of one long baked take.
//
// 3ds Max and similar exporters often ship every animation end-to-end in a
// single "Take 001" with no range markers — seagull.fbx is 24.77s of idle,
// walk, takeoff, glide, flap, soar and dive in one track. Splitting that in a
// DCC and re-exporting works, but it puts the frame ranges somewhere you
// can't retune; declaring them here keeps them as two numbers per state, next
// to everything else about the asset.
//
// Ranges are [startFrame, endFrame] against `subclipFps` (the file's own
// keyframe rate, NOT the display frame rate). The source clip is kept as
// well, so an asset can still map a state to the whole take if it wants.
function buildSubclips(clips, def, label) {
  if (!def.subclips || clips.length === 0) return clips;
  const source = def.subclipSource
    ? THREE.AnimationClip.findByName(clips, def.subclipSource)
    : clips[0];
  if (!source) {
    console.warn(`[assets] "${label}" declares subclips but source clip "${def.subclipSource}" is not in the file — keeping the original clips.`);
    return clips;
  }
  const fps = def.subclipFps ?? 30;
  const out = clips.slice();
  for (const [name, range] of Object.entries(def.subclips)) {
    const [from, to] = range;
    // subclip() keeps any keyframe inside the range; a range past the end of
    // the take yields a clip with no motion at all, which is a silent freeze
    // rather than an error, so it's worth saying so out loud.
    const maxFrame = Math.round(source.duration * fps);
    if (from >= maxFrame) {
      console.warn(`[assets] "${label}" subclip "${name}" starts at frame ${from}, past the end of "${source.name}" (${maxFrame} frames) — skipped.`);
      continue;
    }
    const cut = THREE.AnimationUtils.subclip(source.clone(), name, from, Math.min(to, maxFrame), fps);
    // subclip() leaves `duration` at whatever the trimmed tracks span, which
    // for a range whose last key sits before `to` is shorter than requested.
    // Pin it to the asked-for span so a loop reads at the authored tempo.
    cut.duration = (Math.min(to, maxFrame) - from) / fps;
    out.push(cut);
  }
  return out;
}

// Exported for the harnesses only. `fit`, `pivot` and the orientation basis
// are pure geometry, and the alternative to running the real function over the
// real file is a test that recomputes the same arithmetic and therefore only
// ever proves it agrees with itself. Nothing in the game calls this by name —
// it goes through createVisual — so this is a window, not an entry point.
// See tools/club-test.mjs, which uses it to check the club really is gripped
// at its handle; Node cannot fetch a model, so createVisual there silently
// returns the procedural fallback instead.
export function prepareModel(source, def, clips = [], overrideTex = null, label = '', emissiveTex = null) {
  const model = source;
  clips = buildSubclips(clips, def, label);

  if (def.meshIndex != null) isolateMesh(model, def.meshIndex);

  const { box, excluded, included } = referenceBox(model, label);
  for (const o of excluded) o.parent?.remove(o);
  const size = new THREE.Vector3();
  const bboxCenter = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(bboxCenter);
  // The pivot uses the mesh's actual center of mass (area-weighted triangle
  // centroid), not the bounding-box midpoint — see computeCentroid's comment
  // for why those two aren't the same thing for an asymmetric creature.
  // Overall SIZE for the fit-scale below still comes from the bbox, since
  // that's genuinely about extent, not mass distribution.
  const center = computeCentroid(included, bboxCenter, box);

  // `pivot` moves the origin along the travel axis only; the other two axes
  // keep the centre-of-mass placement, so the body still balances left/right
  // and top/bottom. Measured from the NOSE so the number reads the way you'd
  // describe it ("15% back from the head") regardless of which model axis
  // forward happens to be, or which direction it points.
  if (def.pivot != null) {
    const spec = def.forward ?? '+Z';
    const axis = spec.slice(-1).toLowerCase(); // 'x' | 'y' | 'z'
    const towardNose = spec.startsWith('-') ? -1 : 1;
    const extent = size[axis];
    if (extent > 1e-6) {
      // Nose is whichever end of the box the forward axis points at.
      const nose = towardNose > 0 ? box.max[axis] : box.min[axis];
      const t = Math.max(0, Math.min(1, def.pivot));
      center[axis] = nose - towardNose * t * extent;
    }
  }

  // Scale first, then recentre. An Object3D's matrix is T * R * S, so `position`
  // is NOT affected by `scale` — the centering offset has to be scaled by hand
  // or off-origin models end up shifted by (scale - 1) * center.
  const fitScale = def.fit ? def.fit / (Math.max(size.x, size.y, size.z) || 1) : 1;
  model.scale.multiplyScalar(fitScale);
  model.position.copy(center).multiplyScalar(-fitScale);

  // Optional non-uniform tweak on top of the uniform fit, e.g. [1, 1.15, 1]
  // to make something look slightly longer without touching the source file.
  if (def.scaleXYZ) model.scale.multiply(new THREE.Vector3(...def.scaleXYZ));

  // Materials are ALWAYS cloned per template (not just when an override is
  // configured), so every loaded model ends up with its own material
  // instances — never sharing with another asset that happened to reuse the
  // same base material in its source file — and so the texture panel always
  // has something safe to mutate later, on any model, not just ones with
  // overrides set up front. Original map/colour are stashed for the panel's
  // "reset" action.
  {
    const tint = def.tint != null ? new THREE.Color(def.tint) : null;

    // A mesh's `.material` can be a single Material or an array of them
    // (multi-material meshes — seen in practice on some FBX exports), so
    // every step below has to handle both rather than assuming one shape.
    // `mesh` is only read by attachBiolumSkin, which needs the GEOMETRY to
    // normalise its pattern against the body's own bounding box — everything
    // else here is a property of the material alone.
    const processMaterial = (mat, mesh) => {
      // NOTE: deliberately NOT `def.unlit` — that flag belongs to the
      // procedural shape fallback and is set on nearly every entry in this
      // file, so honouring it here would flip almost every model in the game
      // to an unlit material and throw away its emissive glow. `modelUnlit`
      // is the opt-in for the model itself: ignore scene lights, and let glow
      // push the colour past 1.0 into the bloom threshold.
      let m2;
      if (def.modelUnlit === true && !mat.isMeshBasicMaterial) {
        m2 = new THREE.MeshBasicMaterial({
          color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
          map: mat.map ?? null,
          transparent: mat.transparent,
          opacity: mat.opacity,
          side: mat.side,
          alphaTest: mat.alphaTest,
        });
      } else {
        m2 = mat.clone();
      }
      // Drop side-car slots that were never fetched (see fbxManager). Done
      // before the stash below so the texture panel's "reset" restores "no
      // map" rather than putting the dead texture back.
      for (const slot of FBX_TEXTURE_SLOTS) {
        if (m2[slot]?.userData?.[MISSING_SIDECAR]) m2[slot] = null;
      }
      m2.userData.__originalMap = m2.map ?? null;

      if (tint && m2.color) m2.color.copy(tint);
      // Captured AFTER the asset's own tint, so `def.tint` is the baseline
      // that glow multiplies and that "reset" returns to. Capturing it first
      // meant applyColorAndGlow restored the raw file colour and silently
      // threw the tint away the moment any glow was set — which is how a
      // near-black silhouette came back white.
      m2.userData.__originalColor = m2.color ? m2.color.getHex() : null;
      if (overrideTex) m2.map = overrideTex;
      if (def.material) {
        const dm = def.material;
        if (dm.roughness != null && 'roughness' in m2) m2.roughness = dm.roughness;
        if (dm.metalness != null && 'metalness' in m2) m2.metalness = dm.metalness;
        if (dm.emissive != null && 'emissive' in m2) m2.emissive.set(dm.emissive);
        if (dm.emissiveIntensity != null && 'emissiveIntensity' in m2) m2.emissiveIntensity = dm.emissiveIntensity;
      }
      // THE MODEL'S OWN ART AS ITS GLOW. `emissiveFromMap` puts the base
      // colour texture in the emissive slot as well, so what lights up is the
      // print rather than a flat colour behind it — the roll of hundreds keeps
      // its banding when it flares instead of turning into a green pill.
      //
      // The emissive COLOUR has to be white here, and that is the whole trick:
      // three.js multiplies emissiveMap by `emissive`, so anything else tints
      // the art on its way out, and the seeding block just below — which copies
      // the diffuse colour into a black emissive — would do exactly that. It is
      // skipped because this ran first and left emissive non-black.
      //
      // Exclusive with a mask by construction: both want `emissiveMap`, and
      // applyEmissiveMode rewrites that slot (to the mask, or to null) on every
      // flip of the global toggle, so a model carrying both would lose this on
      // the first flip. The mask keeps the slot and this stands down, rather
      // than the two racing for it.
      if (def.emissiveFromMap && !emissiveTex && 'emissiveMap' in m2 && m2.map) {
        m2.emissiveMap = m2.map;
        m2.emissive.set(def.material?.emissive ?? 0xffffff);
        m2.userData.__emissiveFromMap = true;
      }
      // Glow on a LIT model scales emissiveIntensity — which does nothing at
      // all while emissive is still black, the default in most exported
      // materials. Seeding emissive from the diffuse colour means turning the
      // glow slider up actually lights the model, instead of silently doing
      // nothing until you also pick an emissive colour by hand.
      if (def.modelUnlit !== true && 'emissive' in m2 && m2.emissive.getHex() === 0x000000) {
        m2.emissive.copy(m2.color ?? new THREE.Color(0xffffff));
        if ('emissiveIntensity' in m2 && def.material?.emissiveIntensity == null) {
          m2.emissiveIntensity = 0; // off until something asks for glow
        }
      }
      // Emissive mask. Stashed rather than assigned, because which of the two
      // glow sources is live is a runtime toggle (CONFIG.glow.emissiveMaps) —
      // applyEmissiveMode owns the actual assignment, here and on every later
      // flip. `__uniformEmissive` is the colour the seeding above just chose,
      // captured now so switching the mask back off restores it exactly
      // rather than leaving the body glowing white.
      if (emissiveTex && 'emissiveMap' in m2) {
        m2.userData.__emissiveMask = emissiveTex;
        m2.userData.__uniformEmissive = m2.emissive.getHex();
        applyEmissiveMode(m2);
      }
      // Procedural surface noise, for models that ship no texture at all
      // (CONFIG.sealShader). Attached here so it survives every later path
      // that rebuilds a look — tint, glow and the emissive toggle all write
      // uniforms or colours, none of which disturb the injected shader.
      if (def.noiseShader) attachNoiseShader(m2, typeof def.noiseShader === 'string' ? def.noiseShader : null);
      // Banded lighting (CONFIG.toonShade). ATTACHED AFTER the noise and BEFORE
      // the biolum skin, and the order is not arbitrary: attachToonShade chains
      // onto whatever onBeforeCompile is already there rather than assigning
      // over it, so it has to go on after any injection it must not erase and
      // before any that will chain onto it in turn. See the note in
      // systems/toonShade.js about the assignment bug this avoids.
      if (def.toonShade) attachToonShade(m2, typeof def.toonShade === 'string' ? def.toonShade : null);
      // Procedural glow patterns (CONFIG.biolumSkin). Attached in the same
      // place and for the same reason as the noise above — it survives tint,
      // glow and the emissive toggle, all of which write colours or uniforms
      // rather than rebuilding the material.
      // `biolumEdges` splits the geometry so the body can wear the `wireframe`
      // pattern — one vertex per triangle corner, which barycentric
      // coordinates require. Done BEFORE the attach, because the attach bakes
      // its per-vertex attributes off whatever geometry it finds and a split
      // afterwards would throw them away. Once per asset, not per creature:
      // clones share the geometry. See systems/biolumSkin.js.
      if (def.biolumEdges) splitForEdges(mesh);
      // `def.eyeStalks` is the fifth argument and it USED TO BE DROPPED HERE,
      // which is the whole reason the crabs' eyes never lit in the game while
      // every test of them passed: the harness calls attachBiolumSkin with the
      // stalks by hand, this call site is the only one the game itself takes,
      // and bakeEyeGlow with no stalks bakes an all-zero aEyeGlow that the
      // shader multiplies out to nothing. No warning, no error — a tuned
      // eyeStrength simply scaling zero. See the guard in
      // tools/biolum-skin-test.mjs, which now reads this line.
      if (def.biolumSkin) attachBiolumSkin(m2, mesh, def.biolumSkin, def.biolumAxis ?? null, def.eyeStalks ?? null);
      // Current-driven bend for seabed plants (CONFIG.grass.sway). `size.y` is
      // the clump's height in MODEL units, before `fit` reaches the node's
      // scale — the shader wants it there, both as the amplitude scale and as
      // the mask denominator on a stand-in with no UVs.
      if (def.sway) attachGrassSway(m2, size.y);
      m2.needsUpdate = true;
      return m2;
    };

    model.traverse((o) => {
      if (!o.isMesh) return;
      // The array branch wraps rather than passing processMaterial straight to
      // map: map's second argument is the INDEX, which would arrive where the
      // mesh is expected.
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => processMaterial(m, o))
        : processMaterial(o.material, o);
    });
  }

  if (def.headTint != null) paintHeadTint(model, def);

  // ONE OUTLINE MATERIAL PER ASSET, not one per mesh, and that is what makes a
  // static rim tunable at all. addOutlineShells builds a fresh material per
  // mesh when it is handed none — fine when the values were only ever going to
  // be the literals in this file, and useless the moment there is a swatch:
  // an edit would have to find every shell of every creature already swimming.
  // Handing it one material means a colour or a thickness written here reaches
  // all of them, because they are all the same object.
  //
  // Registered under `label`, which is the ASSET KEY at both of the game's call
  // sites. A harness passing something else gets an unreachable rim rather than
  // a crash, which is the right way round.
  if (def.outline) {
    const shared = makeOutlineMaterial(def.outline);
    if (label) outlineMaterials.set(label, { material: shared, base: def.outline });
    addOutlineShells(model, { ...def.outline, material: shared });
  }

  const orient = new THREE.Group();
  orient.quaternion.copy(orientationQuaternion(def));
  orient.add(model);
  if (def.offset) orient.position.fromArray(def.offset);

  const wrapper = new THREE.Group();
  wrapper.add(orient);
  wrapper.userData.clips = clips;
  wrapper.userData.rig = def.rig ?? null;
  wrapper.userData.aimRig = def.aimRig ?? null;
  wrapper.userData.lookRig = def.lookRig ?? null;
  wrapper.userData.biteRig = def.biteRig ?? null;
  wrapper.userData.clawRig = def.clawRig ?? null;
  wrapper.userData.breathRig = def.breathRig ?? null;
  wrapper.userData.morphs = def.morphs ?? null;
  wrapper.userData.animationNames = def.animations ?? {};
  return wrapper;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

// Per-asset runtime size multiplier — a "Size" slider in the tuner applies
// to every FUTURE createVisual() call (existing spawned instances keep
// their size, same limitation as the shrimp-model upload; both are tuning
// tools, not something that needs to rewrite everything already on screen).
const sizeMultipliers = new Map();

export function setAssetSizeMultiplier(key, multiplier) {
  if (multiplier == null || multiplier === 1) sizeMultipliers.delete(key);
  else sizeMultipliers.set(key, multiplier);
}

export function getAssetSizeMultiplier(key) {
  return sizeMultipliers.get(key) ?? 1;
}

// Called with every visual createVisual hands out, so a system can decorate
// each spawn without every spawn site having to know about it.
// systems/outlines.js is the one user: it hangs outline shells on the
// creatures configured for them.
//
// A hook rather than a direct import because the dependency only runs one way
// — outlines.js needs assets.js for the shell builder, and importing back the
// other way would make a cycle out of what is really just "tell me when you
// build one".
let spawnDecorator = null;

export function setSpawnDecorator(fn) {
  spawnDecorator = fn;
}

// ---------------------------------------------------------------------------
// MORPH TARGETS — a named handle on one instance's blend shapes.
//
// `ASSETS.<key>.morphs` maps a name this codebase uses to the name the target
// actually has in the file, and this resolves that to the (mesh, index) pairs
// needed to drive it. Two things make the indirection worth having:
//
//   1. AN INDEX IS NOT A NAME. glTF stores target names in a mesh `extras`
//      that plenty of exporters simply do not write — the whale's C4D export
//      is one, and its three targets arrive as "0", "1", "2" with an empty
//      morphTargetDictionary. tools/build-whale.mjs names them by MEASURING
//      what each one moves, so by the time a file reaches here the names are
//      real; asking for `mouthWide` then fails loudly if a re-export drops
//      them, where a hardcoded `influences[2]` would quietly gape the wrong
//      part of the animal.
//   2. A TARGET CAN LIVE ON ANY MESH, and a model split across several would
//      otherwise need every caller to know which. `set` writes every mesh
//      carrying that name.
//
// Influences are PER INSTANCE (three's Mesh.copy slices the array), unlike the
// material, which every clone shares — so this is safe to drive per animal in
// a way that tinting is not. See the note on biolumSkin in createVisual.
export function morphControl(visual) {
  const names = visual?.userData?.morphs ?? null;
  const bound = new Map(); // our name -> [{ mesh, index }, ...]
  if (names) {
    visual.traverse((o) => {
      const dict = o.morphTargetDictionary;
      if (!dict || !o.morphTargetInfluences) return;
      for (const [ours, theirs] of Object.entries(names)) {
        const index = dict[theirs];
        if (index == null) continue;
        if (!bound.has(ours)) bound.set(ours, []);
        bound.get(ours).push({ mesh: o, index });
      }
    });
    for (const ours of Object.keys(names)) {
      if (!bound.has(ours)) {
        console.warn(`[assets] morph "${ours}" (target "${names[ours]}") is not on this model — `
          + 'the export lost its target names. Re-run the model\'s build step.');
      }
    }
  }
  return {
    // Whether anything at all resolved. A caller that drives a gape can skip
    // the work entirely rather than writing into nothing every frame.
    get available() { return bound.size > 0; },
    has(name) { return bound.has(name); },
    set(name, value) {
      const slots = bound.get(name);
      if (!slots) return false;
      const v = Math.max(0, Math.min(1, value));
      for (const { mesh, index } of slots) mesh.morphTargetInfluences[index] = v;
      return true;
    },
    get(name) {
      const slots = bound.get(name);
      return slots ? slots[0].mesh.morphTargetInfluences[slots[0].index] : 0;
    },
  };
}

export function createVisual(key) {
  const def = ASSETS[key];
  if (!def) {
    console.warn(`[assets] unknown asset "${key}"`);
    return new THREE.Object3D();
  }

  const sizeMul = sizeMultipliers.get(key);

  const template = loadedModels.get(key);
  if (template) {
    const inst = cloneSafe(template);
    inst.name = key;
    inst.userData.clips = template.userData.clips;
    inst.userData.rig = template.userData.rig;
    inst.userData.aimRig = template.userData.aimRig;
    inst.userData.lookRig = template.userData.lookRig;
    inst.userData.biteRig = template.userData.biteRig;
    inst.userData.clawRig = template.userData.clawRig;
    inst.userData.breathRig = template.userData.breathRig;
    inst.userData.morphs = template.userData.morphs;
    inst.userData.animationNames = template.userData.animationNames;
    if (sizeMul) inst.scale.multiplyScalar(sizeMul);
    // A glowing creature gets its OWN material here, unlike every other clone,
    // which shares the template's. That is the price of a per-individual
    // flicker phase — nine fish on one uniform block breathe as one animal.
    // The compiled shader is still shared; see instantiateBiolumSkin.
    if (def.biolumSkin) instantiateBiolumSkin(inst);
    spawnDecorator?.(inst, key);
    return inst;
  }

  // Repo sprites, checked after loadedModels so an upload still overrides
  // them. Each variant is its own template; the clone shares its material by
  // reference, exactly as a model clone does, so the look controls reach
  // every one already in flight.
  const variants = spriteVariants.get(key);
  if (variants?.length) {
    const inst = variants[(Math.random() * variants.length) | 0].clone();
    inst.name = key;
    if (sizeMul) inst.scale.multiplyScalar(sizeMul);
    spawnDecorator?.(inst, key);
    return inst;
  }

  // A RING IS THE ONE PRIMITIVE THAT CANNOT SHARE ITS MATERIAL. Every other
  // shape here goes through getMaterial's per-key cache, which is right: one
  // bubble material serves every bubble, and a look control reaches all of them
  // at once. The organic ring (systems/organicRing.js) carries its sweep, its
  // charge and its threat colour in UNIFORMS, so a cached material would give
  // every ring on screen one shared hand and one shared colour — the same trap
  // as fading one bubble and fading them all. It gets its own material per
  // instance and its own build path, and it is deliberately the only exception.
  if (def.shape === 'ring') {
    const ring = makeOrganicRing({
      type: def.attack ?? 'kinetic',
      // A ring asset that names its own colour keeps it; one that names only a
      // threat type takes the palette's.
      color: def.attack && def.color == null ? null : (def.color ?? 0xffffff),
      // Same conversion the boss tells use: a band spanning inner..outer has a
      // half-width of (outer - inner) / 2.
      thickness: ((def.outer ?? 1) - (def.inner ?? 0.8)) / 2,
      arcs: def.arcs ?? 0,
    });
    ring.name = key;
    ring.visible = true;
    // NOTHING HERE TICKS IT. The dialects that animate — electric's stepped
    // jags, blast's churn, venom's crawl — read uTime, and assets.js has no
    // per-frame pass to advance it. Whoever spawns a ring asset owns that:
    // call updateOrganicRing(mesh, dt) from the system that holds it, the way
    // systems/bossPerks.js and systems/bossBoat.js do. Left un-ticked it draws
    // a perfectly good still frame, which is why this is a note rather than a
    // throw — and also why it would be easy to miss.
    if (sizeMul) ring.scale.multiplyScalar(sizeMul);
    spawnDecorator?.(ring, key);
    return ring;
  }

  const mesh = new THREE.Mesh(getGeometry(key, def), getMaterial(key, def));
  mesh.name = key;
  if (sizeMul) mesh.scale.multiplyScalar(sizeMul);
  // Seeded here rather than at each spawn site so that `shape: 'rock'` is the
  // only thing an asset needs to say to get a randomly-oriented, tumbling
  // stone. The systems that own the mesh just call updateTumble each frame;
  // anything that never does simply gets a rock lying at a random angle.
  if (def.shape === 'rock') {
    startTumble(mesh, (def.rock?.tumble ?? CONFIG.rocks?.tumble ?? 0) * (CONFIG.rocks?.tumbleScale ?? 1));
  }
  spawnDecorator?.(mesh, key);
  return mesh;
}

// ---------------------------------------------------------------------------
// RECYCLING A VISUAL
//
// createVisual is not cheap and it is not only CPU. A skinned clone gets its
// own Skeleton, and every Skeleton allocates its own bone texture — three's
// computeBoneTexture builds a DataTexture of the matrix palette — so a spawn is
// a cloned bone hierarchy, a mixer, AND a GPU texture. removeEnemy used to drop
// all of it on the floor: scene.remove and a splice, no dispose, and WebGL does
// not free on JS garbage collection.
//
// Measured on a real run: textures created came to 1.00 per kill (1.16 and 0.92
// across two runs), renderer.info.memory.textures climbed to 1,466 over nine
// minutes and never came down, and the frame-time record showed 199 of 224
// hitches were neither a shader link nor a texture upload — the signature of
// the garbage, not of the allocation. Spikes tracked the KILL RATE and not the
// creature count: the smoothest run of four had 195 creatures alive and 0.7
// kills a second, the worst had 4.6.
//
// So a dead creature's body is kept and handed to the next one that needs it.
// Nothing is disposed because nothing is thrown away.
//
// THE RESET IS A SNAPSHOT, not a list of fields. Systems reach into these
// hierarchies from everywhere — a boss scales the visual, statuses hang motes
// off it, a rig hides a sub-mesh — and a reset written as "the things I could
// think of" is a reset that goes stale the first time somebody adds a system.
// Recording every node's local transform once, at birth, and restoring the lot
// is mechanical, and it cannot fall behind code it knows nothing about.
// ---------------------------------------------------------------------------

const visualPool = new Map();

// --- how many bodies a key is allowed to keep -------------------------------
//
// The cap exists so the pool absorbs a school dying at once without holding
// the whole roster resident forever. It used to be a flat 24, and a flat
// number is wrong in the one case it was written for: tools/crowd-profile.mjs
// finds enemyClownFish sitting at 28 alive at a level-9 population, so four of
// every wave landed over the cap, were disposed on death, and had to be cloned
// fresh next wave — a new Skeleton each, and a new bone DataTexture uploaded on
// the frame it first drew. The cheapest key in the game paying the most
// expensive cost, forever.
//
// So the cap is the key's own high-water mark of CONCURRENTLY LIVE bodies
// instead. That number has a property a hand-picked one cannot: holding it
// costs exactly what the game already spent at its own busiest moment for that
// key, because those bodies were all in the water together at some point. It
// can never ask for memory the run has not already demonstrated it needs, and
// it re-tunes itself when the spawn tables move — which they do, and which is
// how the flat 24 went stale without anything failing.
//
// A body waiting in the pool is cheap: geometry and materials belong to the
// template, so what is retained is a node hierarchy and (if it is skinned) one
// Skeleton with its bone texture — 16KB of GPU for a 126-bone crab. Disposing
// and re-cloning it is the expensive half, which is why the floor is generous.
const POOL_MIN_PER_KEY = 24;
// A backstop, not a target. Something spawning hundreds of one key at once is
// a spawn-table bug, and the pool should not quietly hold the evidence.
const POOL_MAX_PER_KEY = 96;

// Acquired and not yet handed back — the bodies of this key the game has in
// play right now — and the largest that has ever been.
const liveByKey = new Map();
const peakLiveByKey = new Map();

function poolCap(key) {
  const peak = peakLiveByKey.get(key) ?? 0;
  return Math.min(POOL_MAX_PER_KEY, Math.max(POOL_MIN_PER_KEY, peak));
}

function captureRest(visual) {
  const order = [];
  visual.traverse((o) => order.push(o));
  const t = new Float32Array(order.length * 10);
  const vis = new Uint8Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const o = order[i];
    o.position.toArray(t, i * 10);
    o.quaternion.toArray(t, i * 10 + 3);
    o.scale.toArray(t, i * 10 + 7);
    vis[i] = o.visible ? 1 : 0;
  }
  visual.userData.__rest = { order, nodes: new Set(order), t, vis };
}

// Put a used body back the way it was born. Returns false if it can't be
// trusted, in which case the caller builds a fresh one — a reset that is unsure
// is worth exactly nothing, and a clone is only expensive, not wrong.
function resetVisual(visual) {
  const rest = visual.userData?.__rest;
  if (!rest) return false;

  // Anything hung on the body after birth — a status mote, a net, a marker —
  // goes first. Collected before removing, because removing detaches subtrees
  // and traversal would lose its place.
  let strays = null;
  visual.traverse((o) => { if (!rest.nodes.has(o)) (strays ??= []).push(o); });
  if (strays) for (const s of strays) s.parent?.remove(s);

  const { order, t, vis } = rest;
  for (let i = 0; i < order.length; i++) {
    const o = order[i];
    // A node that was taken out of the hierarchy entirely means somebody
    // restructured this body, and the snapshot no longer describes it.
    if (i > 0 && !o.parent) return false;
    o.position.fromArray(t, i * 10);
    o.quaternion.fromArray(t, i * 10 + 3);
    o.scale.fromArray(t, i * 10 + 7);
    o.visible = vis[i] === 1;
    o.matrixWorldNeedsUpdate = true;
  }
  return true;
}

// The bone texture is the only GPU resource a clone owns — geometry and
// materials belong to the template and are shared with every other instance, so
// disposing those would take the asset out from under everything on screen.
function disposeVisual(visual) {
  visual.traverse((o) => { if (o.isSkinnedMesh) o.skeleton?.dispose(); });
}

/**
 * A body for a new creature: a recycled one if there is one, otherwise a fresh
 * clone. Drop-in for createVisual.
 */
export function acquireVisual(key) {
  // Counted here rather than at the call sites, because this is the only place
  // a pooled body is issued from and the count has to mean "in play" whether
  // the body came back off the free list or was cloned fresh.
  const live = (liveByKey.get(key) ?? 0) + 1;
  liveByKey.set(key, live);
  if (live > (peakLiveByKey.get(key) ?? 0)) peakLiveByKey.set(key, live);

  const free = visualPool.get(key);
  while (free?.length) {
    const used = free.pop();
    if (resetVisual(used)) return used;
    // Unrecoverable — better disposed than handed out in an unknown state.
    disposeVisual(used);
  }
  const fresh = createVisual(key);
  captureRest(fresh);
  return fresh;
}

/**
 * Hand a body back. Safe on anything, including a visual this never issued —
 * which is what lets the caller release unconditionally instead of tracking
 * which creatures came from the pool.
 */
export function releaseVisual(visual) {
  if (!visual) return false;
  visual.parent?.remove(visual);
  const key = visual.name;
  if (!key || !visual.userData?.__rest) {
    disposeVisual(visual);
    return false;
  }
  // Past the guard above, so only bodies this issued are counted down: the
  // `__rest` snapshot is written by acquireVisual and by nothing else, which is
  // what makes a foreign visual arriving here harmless to the live count.
  const live = liveByKey.get(key);
  if (live) liveByKey.set(key, live - 1);

  // Hidden while it waits. A system holding a stale reference to a creature
  // that just died can then still write to it without anything appearing on
  // screen — the reset clears the flag on the way back out.
  visual.visible = false;
  let free = visualPool.get(key);
  if (!free) { free = []; visualPool.set(key, free); }
  if (free.length >= poolCap(key)) {
    disposeVisual(visual);
    return false;
  }
  free.push(visual);
  return true;
}

/**
 * Empty the pool. Anything that rebuilds an asset — a model upload, a look
 * change — invalidates every body already built from it, and a recycled one
 * would come back wearing the old asset.
 */
export function clearVisualPool() {
  for (const free of visualPool.values()) for (const v of free) disposeVisual(v);
  visualPool.clear();
  // The high-water marks go too. They describe bodies built from the asset
  // that was just invalidated, and a cap carried across a look change would
  // size the new pool from the old roster.
  liveByKey.clear();
  peakLiveByKey.clear();
}

/** Bodies waiting, per key. Diagnostics only. */
export function visualPoolStats() {
  const out = {};
  for (const [key, free] of visualPool) if (free.length) out[key] = free.length;
  return out;
}

/**
 * What each key is allowed to keep, and the peak concurrent count that set it.
 * Diagnostics only — this is the number to look at when spawns are still
 * cloning fresh bodies mid-run.
 */
export function visualPoolCaps() {
  const out = {};
  for (const [key, peak] of peakLiveByKey) out[key] = { peak, cap: poolCap(key) };
  return out;
}

function cloneSafe(template) {
  // three.js deep-copies userData on every clone via
  // JSON.parse(JSON.stringify(...)). Our templates park the whole
  // AnimationClip array there, so each spawn was serialising and re-parsing
  // every keyframe track of every clip — 250ms for the hermit crab (69 bones
  // x 13 clips), 113ms for the school pod. That's what the periodic frame
  // hitches were.
  //
  // The clone never needs those values copied: createVisual reassigns clips,
  // rig and animationNames by reference the moment this returns. So hide the
  // root userData for the duration of the clone and put it straight back.
  // Cost becomes proportional to the rig, not to the animation data.
  const saved = template.userData;
  template.userData = {};
  try {
    let skinned = false;
    template.traverse((o) => {
      if (o.isSkinnedMesh) skinned = true;
    });
    return skinned ? skeletonClone(template) : template.clone(true);
  } finally {
    template.userData = saved;
  }
}

export function hasModel(key) {
  return loadedModels.has(key) || spriteVariants.has(key);
}

// ---------------------------------------------------------------------------
// Runtime model upload — e.g. the shrimp ring lets the user upload their own
// model instead of shipping one. Loads via FBXLoader/GLTFLoader chosen from
// the filename, centres and scales it just like prepareModel does for the
// built-in models, and registers it under `key` so createVisual(key) works
// exactly like any other asset from then on.
// ---------------------------------------------------------------------------

// three.js's GLTFLoader treats a failed texture decode as fatal to the WHOLE
// model — it re-throws after logging (see GLTFLoader.js's loadTextureImage:
// `.catch(e => { console.error(...); throw e; })`), so one bad embedded
// texture aborts an otherwise-fine upload entirely. Embedded textures decode
// via a temporary blob: URL internally, which some environments intercept or
// rewrite (seen in practice as a "blob-request://" scheme instead of the
// normal "blob:") — nothing this app controls once that's happening. Rather
// than depend on that always working, texture references are stripped from
// an uploaded .glb before it's ever parsed, the same technique already used
// to shrink the bundled creature models for the playtest build, just run
// here in the browser instead of as a build step. FBXLoader doesn't need
// this — its texture failures are already just warnings, not fatal.
function stripGLBTextureRefs(arrayBuffer) {
  const magic = new TextDecoder('ascii').decode(new Uint8Array(arrayBuffer, 0, 4));
  if (magic !== 'glTF') return arrayBuffer; // not a binary glb — leave it alone

  const view = new DataView(arrayBuffer);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < arrayBuffer.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = new TextDecoder('ascii').decode(new Uint8Array(arrayBuffer, offset + 4, 4));
    const chunkStart = offset + 8;
    const chunkBytes = arrayBuffer.slice(chunkStart, chunkStart + chunkLength);
    if (chunkType === 'JSON') json = JSON.parse(new TextDecoder('utf-8').decode(chunkBytes));
    else if (chunkType.startsWith('BIN')) bin = chunkBytes;
    offset = chunkStart + chunkLength;
  }
  if (!json) return arrayBuffer;

  for (const m of json.materials || []) {
    for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
    if (m.pbrMetallicRoughness) for (const k of Object.keys(m.pbrMetallicRoughness)) if (/Texture$/.test(k)) delete m.pbrMetallicRoughness[k];
    delete m.extensions;
  }
  delete json.textures;
  delete json.images;
  delete json.samplers;
  delete json.extensionsUsed;
  delete json.extensionsRequired;

  const enc = new TextEncoder();
  const jsonBytes = enc.encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const paddedJsonLen = jsonBytes.length + pad;
  const binLen = bin ? bin.byteLength : 0;
  const totalLen = 12 + 8 + paddedJsonLen + (bin ? 8 + binLen : 0);

  const out = new ArrayBuffer(totalLen);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);

  outBytes.set(enc.encode('glTF'), 0);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, totalLen, true);

  outView.setUint32(12, paddedJsonLen, true);
  outBytes.set(enc.encode('JSON'), 16);
  outBytes.set(jsonBytes, 20);
  for (let i = 0; i < pad; i++) outBytes[20 + jsonBytes.length + i] = 0x20;

  if (bin) {
    const pos = 20 + paddedJsonLen;
    outView.setUint32(pos, binLen, true);
    outBytes.set(enc.encode('BIN\0'), pos + 4);
    outBytes.set(new Uint8Array(bin), pos + 8);
  }
  return out;
}

// Restore every model the player has uploaded in a previous session, BEFORE
// anything calls createVisual. This is the real fix for "uploaded models are
// stale until I poke the T menu": the per-row restore in the texture panel
// runs after initPlayer/createBelugaDrone/etc. have already built their
// meshes from the built-in models, so those singletons kept the old mesh
// until something happened to rebuild them. Doing it here, during boot,
// means the FIRST mesh built already uses the uploaded model.
// Apply every saved per-asset look (tint, emissive, glow, tiling, size)
// from CONFIG.assetLooks. Called during boot BEFORE any mesh is created —
// the texture panel also applies these when it builds its rows, but that
// happens after the player and ability singletons already exist, so a saved
// size would otherwise not reach them until something forced a rebuild.
// The colour a creature should throw off when it dies, so the burst reads as
// coming from THAT animal rather than from a generic explosion palette.
//
// Emissive first — it's the glow the creature is already radiating on screen,
// so matching it makes the burst look like the thing coming apart. Tint is
// the fallback for creatures lit by base colour instead (a procedural shape
// has no emissive at all). Returning null means "no signature colour", and the
// emitter keeps its own palette.
// Inverted-hull outline: for each mesh, add a sibling that renders only its
// BACK faces, pushed outward along the surface normal. Front faces are culled,
// so all you ever see of the shell is the rim sticking out past the real mesh
// — a constant-width border.
//
// Cost is one extra draw call per mesh, and nothing else: no post-processing
// pass, no depth/normal prepass, no per-frame work. That's cheap for a handful
// of objects (the three boats) and would only matter if you outlined something
// there are dozens of on screen at once.
//
// The push happens in the VERTEX SHADER rather than by scaling the clone,
// because scaling a SkinnedMesh fights the skinning transform — a scaled shell
// tears away from an animating creature. Displacing along the normal after
// skinning has been applied stays glued to the deformed surface, so this works
// on rigged models too.
//
// Returns the shells it made, so a caller that wants to keep tuning the look
// (both outlines in systems/outlines.js do) can hold onto them; asset defs
// with a static `outline` block just ignore the return.
//
// `spec.material` reuses one material for every shell instead of building one
// each. That's what makes a per-species outline tunable: every creature of a
// species shares the one material, so a colour, glow or thickness edit — or
// switching the whole thing off — reaches every one already swimming, without
// anything having to hunt down live instances.
// ---------------------------------------------------------------------------
// TWO-TONE PAINT — a shaft in one colour and a head in another, on a model that
// ships as ONE mesh with ONE material.
//
// Vertex colours rather than a second material, because splitting the mesh
// would mean two draw calls and a seam to keep aligned; the colour lives on the
// geometry, which instantiateParsedModel already clones per asset key, so the
// four club variants cannot bleed into each other.
//
// PER TRIANGLE, ON A NON-INDEXED COPY, and that is the whole subtlety. Measured
// on club.glb: the shaft is a bare cylinder with vertices only at its two ENDS
// — nothing along its length. Colour that per vertex and the grip's brown and
// the head's colour interpolate across every pixel between them, so instead of
// a brown handle you get a full-length gradient. Duplicating the shared
// vertices (toNonIndexed) lets each triangle carry one flat colour, which is
// what puts a hard edge exactly where the head begins.
//
// `headFrom` is a fraction along `forward`, 0 at the grip and 1 at the head. For
// the club it is 0.6, which is where the shaft measurably starts to flare (mean
// radius 0.015 -> 0.028) rather than a number picked by eye.
function paintHeadTint(model, def) {
  const spec = def.forward ?? '+Z';
  const axis = spec.slice(-1).toLowerCase();
  const towardHead = spec.startsWith('-') ? -1 : 1;
  const shaftColor = new THREE.Color(def.tint ?? 0xffffff);
  const headColor = new THREE.Color(def.headTint);
  const headFrom = def.headFrom ?? 0.6;

  model.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const meshes = [];
  model.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.geometry?.attributes?.position) meshes.push(o);
  });
  if (meshes.length === 0) return;

  // Bounds along the axis first, over every mesh together: the split has to be
  // measured against the whole model, not against whichever part is being
  // walked, or a two-part model paints each piece on its own scale.
  const v = new THREE.Vector3();
  const local = new Map();
  let lo = Infinity;
  let hi = -Infinity;
  for (const mesh of meshes) {
    const m = new THREE.Matrix4().multiplyMatrices(toModel, mesh.matrixWorld);
    local.set(mesh, m);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v[axis] < lo) lo = v[axis];
      if (v[axis] > hi) hi = v[axis];
    }
  }
  const span = (hi - lo) || 1;

  for (const mesh of meshes) {
    if (mesh.geometry.index) mesh.geometry = mesh.geometry.toNonIndexed();
    const m = local.get(mesh);
    const pos = mesh.geometry.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    for (let tri = 0; tri < pos.count; tri += 3) {
      // The triangle's own position along the shaft, from its centroid — so a
      // face straddling the split lands wholly on one side instead of being
      // half-shaded.
      let t = 0;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, tri + k).applyMatrix4(m);
        t += towardHead > 0 ? (v[axis] - lo) / span : (hi - v[axis]) / span;
      }
      const c = (t / 3) >= headFrom ? headColor : shaftColor;
      for (let k = 0; k < 3; k++) {
        colors[(tri + k) * 3] = c.r;
        colors[(tri + k) * 3 + 1] = c.g;
        colors[(tri + k) * 3 + 2] = c.b;
      }
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
      if (!mat) continue;
      mat.vertexColors = true;
      // The colours are IN the attribute now, so the material has to go
      // neutral — three multiplies the two together, and leaving the tint on
      // `color` would square the shaft's brown and darken the whole club.
      mat.color?.setRGB(1, 1, 1);
      mat.needsUpdate = true;
    }
  }
}

// THE NORMAL THE SHELL IS PUSHED ALONG, welded across the seams the exporter
// split. Ported from tools/atlas-render/iconRender.js, where it fixed exactly
// this on the icons.
//
// WHY THE RAW `normal` ATTRIBUTE TEARS. An exporter duplicates a vertex wherever
// two faces disagree about anything the fragment stage reads — a UV island edge,
// a smoothing-group boundary, a second material. One point on the surface then
// exists as several vertices carrying DIFFERENT normals, and the inverted hull
// pushes each of them a different way. The shell splits open along every one of
// those seams, and because the gap is a hole in a back-faced hull you see the
// rim double back on itself: the ragged, doubled edges on the orca's mouth and
// the roots of its fins.
//
// Welding is by QUANTISED POSITION rather than by index, because the seam is
// precisely where the index does NOT join the vertices — that is what a seam is.
// 1e4 is a tenth of a millimetre in model units, coarse enough to survive the
// float drift of an export round trip and fine enough not to weld a thin fin to
// itself. Averaging the normals of everything at one point reconstructs the
// normal the surface would have had if it had never been split.
// A SMOOTHING ANGLE, which is the one thing this adds to the icon renderer's
// version, and it is what makes the function safe to run on everything.
//
// iconRender only ever sees exported organic models, so it can average every
// normal sharing a position. This runs on the crew's boxes and the boat debris
// cells as well, and a box's corner is THREE normals 90 degrees apart: averaging
// those points the corner vertex diagonally inward, the hull stops reaching the
// mitre, and the rim rounds off the corners of every crate in the game.
//
// A seam is different in kind from a hard edge, and the angle is what tells them
// apart. Two vertices split by a UV island carry normals that agree to within a
// degree or two — the split is about texture coordinates, not about shape — so
// they average to the normal the surface always had. A genuine crease disagrees
// by tens of degrees and is left alone, which is what keeps a box a box.
const OUTLINE_WELD_COS = Math.cos(40 * Math.PI / 180);

function smoothNormals(geometry) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!pos || !nor) return null;

  // Vertices sharing a point in space. Keyed on QUANTISED position rather than
  // on the index, because a seam is precisely where the index does not join
  // them. 1e4 is a tenth of a millimetre in model units — coarse enough to
  // survive the float drift of an export round trip, fine enough not to weld a
  // thin fin to its own other side.
  const buckets = new Map();
  const key = (i) => {
    const q = 1e4;
    return `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
  };
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const cur = buckets.get(k);
    if (cur) cur.push(i); else buckets.set(k, [i]);
  }

  const out = new Float32Array(pos.count * 3);
  for (const group of buckets.values()) {
    for (const i of group) {
      const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      let sx = 0, sy = 0, sz = 0;
      // Only the neighbours this vertex actually agrees with, so one point
      // carrying both a seam and a crease resolves each side on its own.
      for (const j of group) {
        const jx = nor.getX(j), jy = nor.getY(j), jz = nor.getZ(j);
        if (nx * jx + ny * jy + nz * jz < OUTLINE_WELD_COS) continue;
        sx += jx; sy += jy; sz += jz;
      }
      const len = Math.hypot(sx, sy, sz);
      // A degenerate sum can only mean this vertex agreed with nothing, itself
      // included — a zero-length normal. Its own value is the honest answer.
      const ok = len > 1e-8;
      out[i * 3] = ok ? sx / len : nx;
      out[i * 3 + 1] = ok ? sy / len : ny;
      out[i * 3 + 2] = ok ? sz / len : nz;
    }
  }
  return new THREE.BufferAttribute(out, 3);
}

/**
 * Give a geometry the welded normal the outline shader reads, once.
 *
 * EVERY geometry that will wear an outline material has to go through this,
 * including the ones whose shells are built by hand (systems/crew.js and
 * systems/boatDebris.js make their own meshes rather than calling
 * addOutlineShells). The shader declares `aOutlineNormal` unconditionally, and
 * WebGL feeds a missing attribute as (0,0,0) rather than failing — so a geometry
 * that skips this loses its rim completely and reports nothing.
 */
export function ensureOutlineNormal(geometry) {
  if (!geometry || geometry.attributes.aOutlineNormal) return geometry;
  // A model with no normals at all still needs something to push along;
  // computing them is what the raw `normal` path was implicitly relying on
  // three to have done at load.
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const smooth = smoothNormals(geometry);
  if (smooth) geometry.setAttribute('aOutlineNormal', smooth);
  return geometry;
}

export function addOutlineShells(model, spec) {
  const shared = spec.material ?? null;
  const targets = [];
  const shells = [];
  // Shells are meshes too, so a second call on the same object would outline
  // the outlines — half of them inside-out, since a shell is already reversed.
  model.traverse((o) => { if (o.isMesh && !o.userData.__isOutline) targets.push(o); });

  for (const mesh of targets) {
    // EVERY outlined geometry gets the attribute, not just the ones that need
    // welding, and that is a requirement rather than tidiness: one outline
    // material is shared across all of an asset's meshes (see spec.material),
    // so its shader declares `aOutlineNormal` once for all of them. A mesh
    // missing the attribute would read it as (0,0,0) and lose its rim entirely
    // — silently, since an absent attribute is not an error in WebGL.
    //
    // Cached on the geometry the real mesh shares, so clones and a second shell
    // pay for the walk once. An attribute no other shader declares costs one
    // upload and is otherwise inert.
    ensureOutlineNormal(mesh.geometry);

    const mat = shared ?? makeOutlineMaterial(spec);

    let shell;
    if (mesh.isSkinnedMesh) {
      shell = new THREE.SkinnedMesh(mesh.geometry, mat);
      shell.bind(mesh.skeleton, mesh.bindMatrix);
      // Sibling, not child: the skeleton already places this in world space,
      // and nesting it under the skinned mesh would apply that transform a
      // second time.
      mesh.parent?.add(shell);
      // Being a sibling means the shell's parent chain does NOT include any
      // scale on `mesh` itself — but the skeleton still places its vertices at
      // that scale, so a caller sizing the rim by walking the shell's parents
      // would be off by exactly it. Kept as a reference to the mesh rather
      // than a copied number so a rig that is rescaled later stays honest.
      // See accumulatedScale in systems/outlines.js.
      shell.userData.__outlineSource = mesh;
    } else {
      shell = new THREE.Mesh(mesh.geometry, mat);
      // Child with an identity transform, so it tracks the mesh exactly
      // wherever the model hierarchy puts it.
      mesh.add(shell);
    }
    shell.name = `${mesh.name}__outline`;
    // Draw before the real mesh so the model always wins the depth test where
    // the two overlap, leaving only the rim visible.
    shell.renderOrder = (mesh.renderOrder ?? 0) - 1;
    shell.userData.__isOutline = true;
    shells.push(shell);
  }
  return shells;
}

// The back-face material an outline shell draws with, and the vertex-shader
// patch that pushes it out along the normal.
//
// Exported because a per-species outline needs ONE of these shared across
// every shell of every instance — see addOutlineShells' `spec.material`.
export function makeOutlineMaterial(spec = {}) {
  const mat = new THREE.MeshBasicMaterial({
    // `glow` multiplies the colour past 1.0, which only means anything because
    // the scene renders to an HDR target: the bloom bright-pass then sees the
    // true value instead of a pre-clamped white, so the rim throws light rather
    // than being a brighter line. 1 — the default — is a flat border, which is
    // what the boats want. systems/outlines.js computes the same product in
    // applyLook rather than passing it here, so a static def block and a tuned
    // rim mean the same thing by the same number.
    color: new THREE.Color(spec.color ?? 0x000000).multiplyScalar(Math.max(0, spec.glow ?? 1)),
    side: THREE.BackSide,
  });
  // The uniform object is created HERE and handed to the shader, rather than
  // being written by onBeforeCompile and read back off `shader.uniforms`
  // afterwards: that callback doesn't run until the material is first
  // rendered, so a thickness set before the first frame — which is every value
  // pushed in at build time, and any tuner edit made while nothing carrying
  // this material is on screen — would be silently dropped. Owning it means
  // writes always land, whether the shader has compiled yet or not.
  const uOutline = { value: spec.thickness ?? 0.03 };
  mat.userData.__outlineThickness = uOutline;
  mat.userData.__isOutline = true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = uOutline;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uOutline;\nattribute vec3 aOutlineNormal;'
      )
      // Offset in OBJECT space, immediately after begin_vertex sets
      // `transformed` and BEFORE skinning runs. Skinning then transforms the
      // already-offset position, so the shell deforms with the animation
      // instead of tearing away from it.
      //
      // Must not use `objectNormal` or `mvPosition`: the first is only
      // defined by <beginnormal_vertex>, which MeshBasicMaterial doesn't
      // include, and the second isn't declared until <project_vertex>.
      //
      // `aOutlineNormal` rather than the raw `normal`, and that is what closes
      // the torn rim: the built-in attribute is split at every UV and smoothing
      // seam, so the hull came apart along each one. addOutlineShells guarantees
      // the attribute exists on every geometry it outlines — WebGL would
      // silently feed (0,0,0) here otherwise and the rim would vanish.
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed += aOutlineNormal * uOutline;'
      );
  };
  return mat;
}

// Rim width, in the OBJECT space the shader offsets in. Callers that think in
// world units divide by the model's scale first — see systems/outlines.js.
export function setOutlineThicknessOn(material, value) {
  const u = material?.userData?.__outlineThickness;
  if (u) u.value = value;
}

export function assetSignatureColor(key) {
  const look = CONFIG.assetLooks?.[key];
  if (!look) return null;
  return look.emissive ?? look.tint ?? null;
}

// Same question as assetSignatureColor — "what colour IS this thing" — but
// answered for a caller that needs an actual colour rather than permission to
// fall back to a palette. The tuned look wins if there is one; otherwise the
// fallback shape's authored colour stands in, which is the creature's colour
// for everything that hasn't had a model uploaded over it.
//
// THIS is what the kill burst asks. A death is always the dying creature's
// colour and never the emitter's generic palette, so the kill feedback needs
// the function that always answers — assetSignatureColor's null would drop any
// creature with no tuned look straight back onto the palette, which is the one
// outcome that rule forbids. The two stay separate because a null IS the right
// answer elsewhere: octoGrab reads the signature to decide whether there is a
// configured look to honour at all.
export function assetBaseColor(key) {
  const tuned = assetSignatureColor(key);
  if (tuned != null) return tuned;
  return ASSETS[key]?.color ?? null;
}

// Which procedural skin an asset wears, from the `skin` column of assets.csv.
//
// Writes the asset DEFINITION rather than a side map, because that field is
// what instantiateParsedModel reads on its way past — one source of truth for
// "does this body have a pattern", shared by the loader, glowIsProcedural and
// the panel's own note. A CSV row and a hand-written `biolumSkin:` in this file
// therefore cannot disagree: the row simply wins, which is the whole point of
// having the column.
//
// Null clears it, and clears `biolumEdges` with it. Leaving the edge split
// behind would keep splitting a body's geometry — one vertex per triangle
// corner, so a real cost in memory and upload — for a pattern that is no longer
// attached to read it.
export function setAssetSkin(key, preset) {
  const def = ASSETS[key];
  if (!def) return;
  if (preset == null) {
    delete def.biolumSkin;
    delete def.biolumEdges;
    return;
  }
  def.biolumSkin = preset;
  // `wireframe` is the one pattern that needs something OF THE MESH — see
  // splitForEdges. A CSV row can now put that pattern on a body that never
  // declared the split, and without it the body has no barycentric attribute,
  // reads distance 0 at every fragment and renders as a solid glowing blob...
  // except the shader's own guard draws it as NOTHING instead, which is a
  // creature that silently fails to appear. Opting the split in here is the
  // only place that knows both facts.
  if (CONFIG.biolumSkin?.presets?.[preset]?.pattern === 'wireframe') def.biolumEdges = true;
}

// Sizes and skins come from assets.csv, applied AFTER the saved looks above so
// the file wins over anything a snapshot still carries. Exported and called
// from the same places, so a CSV edit takes effect on the next apply rather
// than only on a cold boot.
//
// The SIZE half of that is genuinely live; the SKIN half is not, and cannot be.
// attachBiolumSkin runs once, when a model is parsed, so re-applying here
// updates the definition for everything loaded after this moment and changes
// nothing already on screen. In practice that means a reload — see the note on
// applyAssetTable, and the line the Models tab prints next to the skin.
export function applyAssetSizesFromTable() {
  applyAssetTable({
    setSize: setAssetSizeMultiplier,
    setSkin: setAssetSkin,
    // The other two thirds of the `surface` column. Same shape as setAssetSkin:
    // null clears whatever the asset declared in code, a string names a preset,
    // and `true` means "on, at the base settings".
    setNoise: (key, v) => { if (ASSETS[key]) ASSETS[key].noiseShader = v ?? undefined; },
    setToon: (key, v) => { if (ASSETS[key]) ASSETS[key].toonShade = v ?? undefined; },
    knownKey: (key) => key in ASSETS,
    knownSkin: (name) => !!CONFIG.biolumSkin?.presets?.[name],
  });
}

// Tell the tuner which assets wear each skin preset, so a preset group can say
// whether it is connected to anything.
//
// Registered rather than imported: config.js cannot import this file (it is
// already imported BY it), and the answer has to be computed at paint time
// anyway — setAssetSkin rewrites `def.biolumSkin` whenever the table is
// re-applied, so a map built once here would go stale the first time a CSV row
// changed. Walking ASSETS costs a hundred property reads on a readout that only
// paints while its group is open.
registerSkinWearers((preset) => Object.entries(ASSETS)
  .filter(([, def]) => def.biolumSkin === preset)
  .map(([key]) => key));

// Applied at MODULE LOAD, not only from applySavedAssetLooks(). The file is
// the source of truth for spawn size, so it has to be true from the moment
// anything can call createVisual — not merely once whatever boot path happens
// to call the saved-looks hook has run. The call inside that hook stays, so a
// re-apply after a CSV edit still lands.
//
// The skin column depends on this placement rather than merely benefiting from
// it: preloadAssets parses every model, and the definition has to already carry
// its skin by then or the pattern is decided before the file was read.
applyAssetSizesFromTable();

// IS THIS ASSET'S GLOW PROCEDURAL? True for a creature whose light comes from
// its biolumSkin pattern and that ships no baked emissive map to shape a flat
// one with.
//
// For those, `emissive` and `glow` in a saved look are not a look — they are a
// UNIFORM flood over the whole body, and a body with no mask has nothing to
// shape it. The pattern is the mask, which is the entire point of the
// procedural system: light in the seams, on the claws, in the eyes, and dark
// shell between.
//
// This was live and it cost the day crab its whole shell. `assetLooks
// .enemyWalkingCrab` carried emissive #f4d2f8 at glow 4.05 with the mask
// override off, so every walking crab rendered as a flat white silhouette —
// all three carapace skins identical, because none of the pattern survived
// underneath it. Nothing reported it: `npm run glow` audits biolumSkin ramps,
// not per-asset Look values, and the asset's own comment says the opposite is
// intended ("no emissive mask: the daytime shell pattern is doing that job
// procedurally anyway").
//
// Skipped rather than stripped from the snapshot on the way in, because this
// is a fact about the ASSET and assets.js is the only module that holds those.
// config.js does the stripping for table-owned fields and cannot do this one:
// it would have to import assets.js, which imports it (see assetTable.js).
//
// An asset that declares BOTH a biolumSkin and a real emissive map is exempt —
// there the flat channel has a mask to ride and is a legitimate control.
// Exported for ui/textures.js, which hides the two controls rather than
// leaving live sliders pointing at a value nothing will read back — the same
// call the Size slider got when assets.csv took it over.
export function glowIsProcedural(key) {
  const def = ASSETS[key];
  return !!def?.biolumSkin && !def?.texture?.emissive;
}

// Which preset it wears, for the note the panel shows in their place.
export function assetGlowPreset(key) {
  return ASSETS[key]?.biolumSkin ?? null;
}

export function applySavedAssetLooks() {
  const looks = CONFIG.assetLooks ?? {};
  for (const [key, look] of Object.entries(looks)) {
    if (!look) continue;
    try {
      const procedural = glowIsProcedural(key);
      if (look.tint != null) setAssetTint(key, look.tint);
      if (!procedural && look.emissive != null) setAssetEmissive(key, look.emissive);
      if (!procedural && look.glow != null && look.glow !== 1) setAssetGlow(key, look.glow);
      // Only when explicitly chosen. `null` means this model was left on auto,
      // and writing it back would pin it to whatever the global happened to be
      // at save time.
      if (!procedural && look.emissiveMask != null) setAssetEmissiveMask(key, look.emissiveMask);
      if (look.repeatX != null && (look.repeatX !== 1 || look.repeatY !== 1)) {
        setAssetRepeat(key, look.repeatX, look.repeatY);
      }
      // `sizeMultiplier` is deliberately NOT read here any more — assets.csv
      // owns it (see assetTable.js). A snapshot still carries the field, and
      // applying it would put the last slider drag back over the file.
    } catch (err) {
      console.warn(`[assets] could not apply saved look for "${key}" —`, err?.message ?? err);
    }
  }
  applyAssetSizesFromTable();
}

export async function restoreUploadedModels() {
  const { listSavedModelKeys, loadModelFromDB } = await import('./systems/modelStorage.js');
  let restored = 0;
  try {
    const keys = await listSavedModelKeys();
    for (const key of keys) {
      try {
        const file = await loadModelFromDB(key);
        if (!file) continue;
        await loadUploadedAsset(key, file);
        restored += 1;
      } catch (err) {
        console.warn(`[assets] saved model for "${key}" could not be restored — using the built-in one.`, err?.message ?? err);
      }
    }
  } catch (err) {
    console.warn('[assets] could not read saved models —', err?.message ?? err);
  }
  if (restored) console.info(`[assets] restored ${restored} uploaded model(s) from previous session.`);
  return restored;
}

export async function loadUploadedModel(key, file, fit = 1) {
  const ext = file.name.split('.').pop().toLowerCase();
  const picked = ext === 'fbx'
    ? { kind: 'fbx', loader: new FBXLoader(fbxManager), unwrap: (r) => r }
    : { kind: 'gltf', loader: new GLTFLoader(), unwrap: (r) => r.scene };

  // Read the file directly and parse the bytes ourselves rather than going
  // through loadAsync()'s fetch(blob-url) path — the same fetch-hang issue
  // that affects data: URIs elsewhere in this file can affect blob: URLs too
  // in some environments, and parsing bytes directly sidesteps it entirely.
  const buffer = await file.arrayBuffer();
  const result = picked.kind === 'fbx'
    ? picked.loader.parse(buffer, '')
    : await new Promise((resolve, reject) => picked.loader.parse(stripGLBTextureRefs(buffer), '', resolve, reject));

  const clips = result.animations ?? [];
  const source = picked.unwrap(result);
  loadedModels.set(key, prepareModel(source, { fit, forward: '+Z', up: '+Y' }, clips, null, key));
  return true;
}

// ---------------------------------------------------------------------------
// 2D SPRITE UPLOAD — the flat-art alternative to a 3D model.
//
// Not the same thing as the texture upload on the same row: that wraps an
// image around whatever geometry the asset already has (a starfish sprite
// smeared over an octahedron). This REPLACES the geometry with a quad cut to
// the image's own aspect ratio, so a drawn starfish reads as a drawn starfish.
//
// It registers under the same loadedModels map a real model would, which is
// what makes everything downstream work for free: createVisual clones it,
// getAssetMaterials finds its material, and tint/glow/size act on it exactly
// as they do on a model. The play plane is XY facing the camera, so a quad in
// that plane needs no billboarding — spinning it on Z (the starfish's tumble)
// is a sprite rotating in frame, which is what you'd want anyway.
// ---------------------------------------------------------------------------

const SPRITE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

export function isSpriteFile(file) {
  return SPRITE_EXTENSIONS.has((file.name.split('.').pop() ?? '').toLowerCase());
}

// World size for a sprite standing in for `key`, so an uploaded image lands at
// the size of the shape it replaces rather than needing the size slider dialled
// in from scratch. Longest side of the image maps to this.
export function spriteSizeFor(key) {
  const def = ASSETS[key];
  if (!def) return 1;
  if (def.fit) return def.fit;
  if (def.radius) return def.radius * 2;
  if (def.height) return def.height;
  return 1;
}

async function decodeImage(file) {
  // createImageBitmap takes the File's bytes directly — no blob: URL, and so
  // none of the fetch-hang risk the model loader avoids the same way.
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  // Older/odd environments: fall back to an <img> on an object URL.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The quad itself, shared by the upload path and the declared-file path below.
// `tex` must already have its image decoded — the aspect ratio is read off it.
function makeSpriteMesh(key, tex, size) {
  const w = tex.image?.width || 1;
  const h = tex.image?.height || 1;
  const longest = Math.max(w, h);
  const geo = new THREE.PlaneGeometry((w / longest) * size, (h / longest) * size);

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    // Cutout rather than pure alpha blending: sprites are usually drawn on
    // transparent backgrounds, and blending alone leaves the quad fighting
    // every other transparent thing in the scene for sort order.
    alphaTest: 0.1,
    depthWrite: false,
    // A projectile flying left is mirrored on Y, which would otherwise show
    // the quad's back face and vanish.
    side: THREE.DoubleSide,
  });
  // The look controls read these to know what "no tint" means — without them
  // the first tint applied has nothing to fall back to when it's cleared.
  mat.userData.__originalMap = tex;
  mat.userData.__originalColor = 0xffffff;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = key;
  mesh.userData.sprite = true;
  return mesh;
}

export async function loadUploadedSprite(key, file, size = 1) {
  const image = await decodeImage(file);
  const tex = new THREE.Texture(image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  loadedModels.set(key, makeSpriteMesh(key, tex, size));
  return true;
}

// Sprites shipped in the repo — `sprites: [...]` on an ASSETS entry, loaded at
// boot alongside the models. Same quad as an upload, but there can be several
// per key: they land in spriteVariants as a pool and createVisual picks one
// per spawn. Files that fail to load are dropped individually, so four good
// images out of five still give a pool of four rather than nothing; if every
// one fails the key falls back to its built-in shape.
// Mean LINEAR luminance of a texture's opaque pixels, or null if it can't be
// measured. Same 16x16 canvas downscale creatureTint uses in systems/
// octoGrab.js — 256 samples however big the image is — and the same guards:
// no document in the Node harnesses, and a tainted or undecoded image falls
// back to null rather than throwing.
//
// LINEAR, not the raw bytes, and that is the whole reason this is worth
// measuring at all. The bytes are sRGB; the renderer and the bloom bright-pass
// both work in linear, where sRGB 128 is 0.216 rather than 0.5. Averaging the
// bytes would rank the sprites correctly but scale them by numbers that mean
// nothing to the thing doing the thresholding.
function averageSpriteLuma(tex) {
  const img = tex?.image;
  if (!img || typeof document === 'undefined') return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!w || !h) return null;

  try {
    const N = 16;
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;

    const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // A drawn sprite is mostly transparent background — averaging it in
      // would rank every star by how much empty space is around it rather
      // than by how bright the star is.
      if (data[i + 3] < 8) continue;
      const r = toLinear(data[i] / 255);
      const g = toLinear(data[i + 1] / 255);
      const b = toLinear(data[i + 2] / 255);
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
    }
    return n ? sum / n : null;
  } catch {
    return null;
  }
}

// SPRITE LUMINANCE NORMALIZATION — why a glowing sprite pool needs it.
//
// A pool is several DRAWN images, and drawn images are not calibrated against
// each other. The five starfish measure a mean linear luminance of 0.054 to
// 0.29 — a factor of five — which is invisible while they are ordinary
// sprites and fatal the moment they are meant to glow: one glow multiplier
// puts the bright ones well past the bloom threshold and leaves the dark ones
// under it, so the same ability throws two stars that blaze and one that does
// not light at all. That reads as a bug, not as variety.
//
// So each variant is scaled to a common target BEFORE the glow slider is
// applied. `glow` then means the same thing for every star in the pool, and
// the art keeps its own internal contrast — this is one multiply per variant,
// not a per-pixel remap, so a star with bright highlights still has them.
//
// Stored on the material rather than folded into its colour, because
// applyColorAndGlow rewrites that colour from scratch every time a tint or
// glow changes and would throw a baked-in factor away on the first slider
// touch. Clamped: a nearly-black variant would otherwise ask for a multiplier
// in the hundreds and come back as a white blob.
// Exported for tools/sprite-glow-test.mjs, which measures the real files.
export function spriteLumaNorm(measured, target) {
  return Math.min(6, Math.max(0.2, target / Math.max(1e-4, measured)));
}

function normalizeSpriteLuma(mesh, tex, target, key) {
  const measured = averageSpriteLuma(tex);
  const mat = mesh?.material;
  // A texture that failed to decode leaves the variant un-normalised rather
  // than scaled by a garbage factor — it will simply glow like it used to.
  if (!mat || !measured) return;
  mat.userData.__spriteLumaNorm = spriteLumaNorm(measured, target);
  // Re-resolved rather than multiplied in here, so this lands through the same
  // one path that owns an unlit material's colour.
  applyColorAndGlow(key);
}

async function loadDeclaredSprites(key, def, textureLoader) {
  const size = spriteSizeFor(key);
  const meshes = [];
  await Promise.all(def.sprites.map(async (url, i) => {
    try {
      const tex = await textureLoader.loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      meshes[i] = makeSpriteMesh(key, tex, size);
      if (def.spriteNormalize) normalizeSpriteLuma(meshes[i], tex, def.spriteNormalize, key);
    } catch (err) {
      console.warn(`[assets] "${key}" sprite ${url} failed to load — skipping this variant.`, err?.message ?? err);
    }
  }));

  const loaded = meshes.filter(Boolean);
  if (loaded.length) spriteVariants.set(key, loaded);
  else console.warn(`[assets] "${key}" loaded none of its ${def.sprites.length} sprites — using the built-in shape instead.`);
}

// One entry point for "the user handed us a file for this asset" — picks the
// sprite or the model path by extension. Both the upload button and the
// restore-on-boot pass through here, so a saved sprite comes back as a sprite
// instead of being fed to the GLB parser.
export async function loadUploadedAsset(key, file) {
  if (isSpriteFile(file)) return loadUploadedSprite(key, file, spriteSizeFor(key));
  return loadUploadedModel(key, file, ASSETS[key]?.fit ?? 1.5);
}

// ---------------------------------------------------------------------------
// Live texture/material editing — used by the in-game texture panel.
//
// Every mesh material is cloned per template (see prepareModel above), and
// every instance created via createVisual SHARES that template's material by
// reference (three.js's default clone behaviour) — so mutating a template's
// material here updates every instance of that asset already on screen, not
// just future spawns.
// ---------------------------------------------------------------------------

// ONE SURFACE, TWO ASSETS. A follower has no look of its own: every tint,
// emissive, glow, roughness and texture written for the leader lands on both,
// and there is no way to set them apart.
//
// The seal team follows the player because they ARE the player's animal —
// smaller escorts of the same species, wearing the same procedural mottling
// (see `noiseShader` on both defs). Keeping two independent looks meant the
// squad could drift away from the seal it escorts, and it did: a saved
// `assetLooks.sealTeam` from back when the escorts wore a rainbow glow skin
// left them lit green at 2.7x while the player sat at a white 0.4x sheen.
// Deleting that saved value could not fix it either — a snapshot is deep-
// merged from disk AND from localStorage, so the browser's cached copy put the
// green straight back. This does fix it, because the field no longer exists:
// config.js strips `assetLooks.sealTeam` on the way in (see the dead-address
// list in withoutTableOwnedKeys) and the panel's escort row now edits the
// player's look.
export const LOOK_FOLLOWS = { sealTeam: 'ship' };

// Followers, by leader. Built once — it is a two-entry map read on every look
// write.
const LOOK_FOLLOWERS = new Map();
for (const [follower, leader] of Object.entries(LOOK_FOLLOWS)) {
  if (!LOOK_FOLLOWERS.has(leader)) LOOK_FOLLOWERS.set(leader, []);
  LOOK_FOLLOWERS.get(leader).push(follower);
}

/** The key whose stored look owns `key`'s appearance. Identity for most assets. */
export function lookLeader(key) {
  return LOOK_FOLLOWS[key] ?? key;
}

export function getAssetMaterials(key) {
  // A follower's materials are reached through its leader, never on their own,
  // so a stray write with the follower's key cannot paint half the pair.
  const lead = lookLeader(key);
  const followers = LOOK_FOLLOWERS.get(lead);
  if (followers) {
    const mats = new Set(assetMaterialsFor(lead));
    for (const f of followers) for (const m of assetMaterialsFor(f)) mats.add(m);
    return [...mats];
  }
  return assetMaterialsFor(lead);
}

function assetMaterialsFor(key) {
  const template = loadedModels.get(key);
  if (template) {
    const mats = new Set();
    template.traverse((o) => {
      if (!o.isMesh) return;
      // Outline shells are meshes on the template too (asset defs with a
      // static `outline` block bake them in). They are NOT part of the
      // creature's look: tint/glow/emissive here would overwrite the rim
      // colour, and since a shell material has no `__originalColor` to fall
      // back on, tinting a boat used to turn its outline white.
      if (o.userData.__isOutline) return;
      // A mesh's material can be a single Material or an array of them.
      if (Array.isArray(o.material)) for (const m of o.material) mats.add(m);
      else mats.add(o.material);
    });
    return [...mats];
  }
  // A sprite pool is several templates, so tint/glow/size have to reach all of
  // them or a run would show, say, four pink stars and one untinted one.
  const variants = spriteVariants.get(key);
  if (variants?.length) return variants.map((m) => m.material);

  const def = ASSETS[key];
  return def ? [getMaterial(key, def)] : [];
}

export function setAssetTexture(key, texture) {
  for (const m of getAssetMaterials(key)) {
    m.map = texture ?? m.userData.__originalMap ?? null;
    // A model whose glow IS its art has to have both slots move together (see
    // `emissiveFromMap`), or an upload leaves the OLD print glowing through the
    // new one — two textures on one object, which reads as a broken material
    // rather than as the wrong image.
    if (m.userData.__emissiveFromMap) m.emissiveMap = m.map;
    m.needsUpdate = true;
  }
}

// Tint and glow both write the SAME property on an unlit material (its
// colour), so they're resolved together rather than fighting each other:
// the last one set would otherwise clobber the other. Tracked per asset and
// re-applied as a pair.
const tintState = new Map(); // key -> { tint, glow, blend }

// Scratch for the blend below. Module-level so a per-frame caller (the
// element's shot colour is one) doesn't allocate a Color every frame.
const _blendCol = new THREE.Color();
const _blendScratch = new THREE.Color();

// The base colour an asset's material resolves to before glow: the Look
// panel's tint if somebody set one, otherwise the def's own colour, with a
// RUN-TIME blend on top of it.
//
// The blend is a third layer rather than a second writer of `tint` on purpose.
// `tint` is the user's — the texture workbench writes it and saves it with the
// look — and a system that recoloured an asset mid-run by writing there would
// overwrite that tint and then "restore" it to the def's colour when it let
// go, quietly eating somebody's work. Blending on top leaves the tint intact
// underneath, so it comes back the moment the run-time layer is cleared.
function resolveColor(m, st) {
  _blendCol.set(st.tint ?? m.userData.__originalColor ?? 0xffffff);
  if (st.blend) _blendCol.lerp(_blendScratch.set(st.blend.hex), st.blend.mix);
  return _blendCol;
}

function applyColorAndGlow(key) {
  const st = tintState.get(key) ?? {};
  for (const m of getAssetMaterials(key)) {
    if (!m.color) continue;
    const base = resolveColor(m, st);

    if ('emissiveIntensity' in m) {
      // Lit material: glow belongs on emissiveIntensity, colour stays colour.
      m.color.set(base);
    } else {
      // Unlit material (every orb, bullet and procedural shape): there's no
      // emissive channel at all, so glow means driving the colour itself
      // past 1.0. That's only meaningful because the scene renders to an HDR
      // target — the bloom bright-pass sees the true value instead of a
      // pre-clamped white. Same mechanism the particle overdrive uses.
      // A sprite pool's per-variant brightness correction rides along here —
      // see normalizeSpriteLuma. It has to be inside this function rather than
      // baked into the colour at load, because this is the one place that
      // rewrites an unlit material's colour and it starts from `base` every
      // time; a baked factor would survive exactly until the first tint or
      // glow change and then silently vanish.
      const g = st.glow ?? 1;
      m.color.set(base);
      m.color.multiplyScalar(g * (m.userData.__spriteLumaNorm ?? 1));
    }
  }
}

export function setAssetTint(key, hex) {
  const st = tintState.get(key) ?? {};
  st.tint = hex ?? null;
  tintState.set(key, st);
  applyColorAndGlow(key);
}

/**
 * A RUN-TIME colour on top of the Look panel's tint — the layer a system owns
 * rather than the user.
 *
 * `mix` is how far toward `hex` the asset's own colour travels, 0..1, so a
 * caller can fade the recolour in and out instead of switching it. Pass a null
 * hex or a mix of 0 to hand the colour back to the tint underneath.
 *
 * Cheap to call every frame: it early-outs when nothing moved, which is what
 * lets systems/elements.js drive it off a value that changes with the sky.
 */
export function setAssetBlendTint(key, hex, mix = 1) {
  const st = tintState.get(key) ?? {};
  const m = Math.max(0, Math.min(1, mix));
  const next = hex == null || m <= 0 ? null : { hex, mix: m };
  const prev = st.blend ?? null;
  if (prev?.hex === next?.hex && prev?.mix === next?.mix) return;
  st.blend = next;
  tintState.set(key, st);
  applyColorAndGlow(key);
}

export function setAssetRepeat(key, x, y) {
  for (const m of getAssetMaterials(key)) {
    if (!m.map) continue;
    m.map.wrapS = THREE.RepeatWrapping;
    m.map.wrapT = THREE.RepeatWrapping;
    m.map.repeat.set(x, y);
    m.map.needsUpdate = true;
  }
}

export function hasCustomTexture(key) {
  return getAssetMaterials(key).some((m) => m.map && m.map !== m.userData.__originalMap);
}

// Emissive colour, glow (emissiveIntensity), and roughness — a simpler way to
// reskin a creature than uploading a texture: no image needed, just pick a
// flat glowing colour. Silently no-ops on materials that don't support a
// given property (e.g. MeshBasicMaterial has no emissive or roughness —
// those are already fully "unlit bright" by construction, so there's nothing
// useful to add).
// Which of the two glow sources a single material is currently using.
//
// The mask and the flat emissive colour occupy the same slot by construction:
// three.js multiplies emissiveMap by `emissive`, so a mask on a near-black
// orca whose emissive was seeded from its diffuse colour would be multiplied
// to nothing — the pattern would be there and invisible. So turning the mask
// ON also neutralises the colour to white (or to whatever the tuner picked),
// and turning it OFF puts the seeded colour back.
//
// Exported nowhere: every caller goes through setEmissiveMapsEnabled or
// setAssetEmissive, so the two can never disagree about which mode is live.
// Does THIS material want its mask on? Three tiers, most specific first:
//
//   1. no mask at all      -> nothing to decide; applyEmissiveMode bails and
//      the material keeps the uniform-glow behaviour untouched. This is why
//      an asset without a mask is unaffected by any of this.
//   2. a per-asset choice  -> `__maskPref`, set from the model's own row in
//      the tuner and saved in CONFIG.assetLooks[key].emissiveMask.
//   3. otherwise           -> the global default, CONFIG.glow.emissiveMaps.
//
// null (rather than false) is what "no per-asset choice, follow the global"
// looks like, so a model can be left on auto instead of being pinned the
// moment the global is flipped once.
function maskWanted(m) {
  const pref = m.userData.__maskPref;
  if (pref == null) return CONFIG.glow?.emissiveMaps === true;
  return pref === true;
}

function applyEmissiveMode(m) {
  const mask = m.userData.__emissiveMask;
  if (!mask || !('emissiveMap' in m)) return;
  const on = maskWanted(m);
  m.emissiveMap = on ? mask : null;
  const chosen = m.userData.__chosenEmissive;
  if (chosen != null) m.emissive.set(chosen);
  else m.emissive.set(on ? 0xffffff : (m.userData.__uniformEmissive ?? 0x000000));

  // A mask alone renders NOTHING. Lit models are seeded with
  // emissiveIntensity 0 ("off until something asks for glow"), so switching
  // the masks on without this would look like a dead toggle — the pattern is
  // there, multiplied by zero. Lend it an intensity while the mask is on and
  // take it back when it goes off, so the toggle is self-contained and does
  // not quietly leave every creature glowing after being switched off.
  //
  // `__maskLit` records that the intensity is OURS to reclaim. setAssetGlow
  // clears it, so the moment the glow slider is touched for a creature that
  // value is the user's and this stops overwriting it.
  if ('emissiveIntensity' in m) {
    if (on && m.emissiveIntensity === 0 && !m.userData.__maskLit) {
      m.userData.__maskLit = true;
      m.emissiveIntensity = CONFIG.glow?.maskIntensity ?? 1;
    } else if (!on && m.userData.__maskLit) {
      m.userData.__maskLit = false;
      m.emissiveIntensity = 0;
    } else if (on && m.userData.__maskLit) {
      m.emissiveIntensity = CONFIG.glow?.maskIntensity ?? 1;
    }
  }
  m.needsUpdate = true;
}

// Flip every loaded asset between masked and uniform glow. Cheap enough to
// call from a tuner checkbox — it only touches materials that actually have a
// mask stashed, so assets without one are skipped rather than reset.
export { applyNoiseSettings, applyToonSettings, applyGrassSettings, applyBiolumSkinSettings };

export function setEmissiveMapsEnabled(on) {
  if (!CONFIG.glow) CONFIG.glow = {};
  CONFIG.glow.emissiveMaps = !!on;
  // Walks the LOADED models rather than every key in ASSETS: getAssetMaterials
  // falls back to building a procedural material for any asset without a
  // model, so iterating the whole registry would instantiate a fallback
  // material for every orb and bullet in the game just to check for a mask
  // none of them can have.
  for (const key of loadedModels.keys()) {
    for (const m of getAssetMaterials(key)) applyEmissiveMode(m);
  }
}

// Does this asset have a mask to toggle? Lets the tuner show the control only
// for creatures where flipping it would do anything.
export function hasEmissiveMask(key) {
  return getAssetMaterials(key).some((m) => m.userData.__emissiveMask);
}

/**
 * Per-model override of the global glow source.
 * @param on  true = always masked, false = always uniform glow,
 *            null/undefined = clear the override and follow CONFIG.glow.
 */
export function setAssetEmissiveMask(key, on) {
  for (const m of getAssetMaterials(key)) {
    if (!m.userData.__emissiveMask) continue;
    m.userData.__maskPref = on == null ? null : !!on;
    applyEmissiveMode(m);
  }
}

// What the model is actually doing right now, override or not — so the tuner
// row can show the resolved state rather than an empty box on a creature that
// is masked because the global says so.
export function assetEmissiveMaskState(key) {
  for (const m of getAssetMaterials(key)) {
    if (!m.userData.__emissiveMask) continue;
    return { has: true, on: maskWanted(m), overridden: m.userData.__maskPref != null };
  }
  return { has: false, on: false, overridden: false };
}

export function setAssetEmissive(key, hex) {
  for (const m of getAssetMaterials(key)) {
    if (!('emissive' in m)) continue;
    if (m.userData.__originalEmissive === undefined) m.userData.__originalEmissive = m.emissive?.getHex() ?? 0x000000;
    // Remembered separately from the material's live colour: with a mask
    // attached, `emissive` is the glow's TINT and gets rewritten on every
    // mode flip, so a picked colour read back off the material would be lost
    // the first time the toggle moved.
    m.userData.__chosenEmissive = hex ?? null;
    if (m.userData.__emissiveMask) applyEmissiveMode(m);
    else m.emissive.set(hex ?? m.userData.__originalEmissive);
  }
}

export function setAssetGlow(key, intensity) {
  const st = tintState.get(key) ?? {};
  st.glow = intensity ?? null;
  tintState.set(key, st);

  for (const m of getAssetMaterials(key)) {
    if (!('emissiveIntensity' in m)) continue;
    if (m.userData.__originalEmissiveIntensity === undefined) m.userData.__originalEmissiveIntensity = m.emissiveIntensity ?? 1;
    m.emissiveIntensity = intensity ?? m.userData.__originalEmissiveIntensity;
    // From here the intensity is the user's, not the mask toggle's borrowed
    // default — see the __maskLit note in applyEmissiveMode.
    m.userData.__maskLit = false;
  }
  // Unlit materials get their glow through colour magnitude instead.
  applyColorAndGlow(key);
}

// Every material can take a glow now — lit ones via emissiveIntensity,
// unlit ones via HDR colour overdrive — so the control is always shown.
export function supportsGlow() {
  return true;
}

// HOW A BODY ANSWERS THE KEY LIGHT — the pair that was hardcoded in the ASSETS
// entries above and had no control anywhere. Ten entries set `material` and the
// rest inherit whatever their file shipped with, so "why is this creature matte
// and that one wet" was a question you answered by editing code and reloading.
//
// Both stash the value they found the first time, so passing null is a real
// undo back to the model's own number rather than a guess at what it was. That
// matters more here than for tint: a tint has an obvious neutral and these do
// not — 0 is a legitimate metalness and so is 1.
//
// Unlit materials have neither property and are skipped rather than warned
// about; roughly half the roster is `modelUnlit`, and a warning per creature
// per drag is noise about a design decision.
export function setAssetRoughness(key, value) {
  for (const m of getAssetMaterials(key)) {
    if (!('roughness' in m)) continue;
    if (m.userData.__originalRoughness === undefined) m.userData.__originalRoughness = m.roughness ?? 1;
    m.roughness = value ?? m.userData.__originalRoughness;
  }
}

export function setAssetMetalness(key, value) {
  for (const m of getAssetMaterials(key)) {
    if (!('metalness' in m)) continue;
    if (m.userData.__originalMetalness === undefined) m.userData.__originalMetalness = m.metalness ?? 0;
    m.metalness = value ?? m.userData.__originalMetalness;
  }
}

// Whether the two above can do anything on this asset — a lit material has both
// and an unlit one has neither, so this is one question, not two. The panel
// uses it to leave the rows out rather than show two sliders that move nothing.
export function supportsSurface(key) {
  return getAssetMaterials(key).some((m) => 'roughness' in m);
}

// ---------------------------------------------------------------------------
// THE RIM — the other look that was code-only.
//
// Keyed by asset, holding the ONE material every shell of that asset draws with
// (see the call in prepareModel) plus the block the entry declared, which is
// what a reset goes back to.
// ---------------------------------------------------------------------------
const outlineMaterials = new Map();

export function assetOutlineBase(key) {
  return outlineMaterials.get(key)?.base ?? null;
}

export function hasOutline(key) {
  return outlineMaterials.has(key);
}

/**
 * Recolour / resize an asset's rim. Any field left undefined falls back to what
 * the entry declared, so this is also the reset.
 *
 * COLOUR AND GLOW ARE ONE WRITE, not two, because the shell has no separate
 * intensity: `glow` is the colour multiplied past 1.0, which only means
 * anything because the scene renders to an HDR target — the bright pass then
 * sees the true value instead of a pre-clamped white. Setting them separately
 * would mean the second write undoing the first, which is exactly the bug
 * makeOutlineMaterial's own note is about.
 *
 * THICKNESS IS IN THE SOURCE FILE'S UNITS, not the world's — the shader offsets
 * in object space. That is why the boats sit at 0.02 and the seagull at 0.71:
 * one is a 73-unit FBX and the other is not. A number copied between two
 * species is almost always wrong, which is why the panel prints the current one
 * rather than starting every asset from a shared default.
 */
export function setAssetOutline(key, { color, thickness, glow } = {}) {
  const entry = outlineMaterials.get(key);
  if (!entry) return false;
  const { material, base } = entry;
  const c = color ?? base.color ?? 0x000000;
  const g = Math.max(0, glow ?? base.glow ?? 1);
  material.color.set(c).multiplyScalar(g);
  setOutlineThicknessOn(material, thickness ?? base.thickness ?? 0.03);
  return true;
}

export function supportsEmissive(key) {
  return getAssetMaterials(key).some((m) => 'emissive' in m);
}

// ---------------------------------------------------------------------------
// Rock variant pool
//
// Rocks are the one shape where an asset key maps to MORE than one geometry:
// a small pool of Perlin-displaced icospheres, built once and picked from at
// spawn. That's the whole reason they sidestep `geometryCache` below, which is
// strictly one geometry per key.
//
// The pool is keyed by a signature of the parameters that shaped it, so
// dragging a slider in the tuner rebuilds it on the next spawn instead of
// silently doing nothing — no hook into the tuner's change path needed, and no
// rebuild at all while the numbers sit still.
// ---------------------------------------------------------------------------

const rockPools = new Map(); // key -> { sig, geos }

function rockOptions(key, def) {
  return {
    ...(CONFIG.rocks ?? {}),
    ...(def.rock ?? {}),
    radius: def.radius ?? 0.3,
    // The asset's own glow, because the facet shading has to be baked deep
    // enough to survive being multiplied by it — see shadingFloor in rocks.js.
    // Read from the saved look rather than from the material, since the pool
    // can be built before applySavedAssetLooks has run.
    glow: CONFIG.assetLooks?.[key]?.glow ?? 1,
  };
}

function rockSignature(o) {
  return [o.radius, o.detail, o.variants, o.amplitude, o.frequency,
    o.octaves, o.lacunarity, o.gain, o.squash, o.shade, o.grit,
    o.glow, o.glowHeadroom].join('|');
}

// FNV-1a, so 'bullet' and 'xpOrb' seed different stones rather than sharing
// the same six shapes at different scales.
function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getRockGeometry(key, def) {
  const o = rockOptions(key, def);
  const sig = rockSignature(o);
  let pool = rockPools.get(key);

  if (!pool || pool.sig !== sig) {
    if (pool) for (const g of pool.geos) g.dispose();
    const count = Math.max(1, Math.round(o.variants ?? 6));
    const base = hashKey(key);
    const geos = [];
    for (let i = 0; i < count; i++) geos.push(createRockGeometry({ ...o, seed: base + i * 2654435761 }));
    pool = { sig, geos };
    rockPools.set(key, pool);
  }

  return pool.geos[(Math.random() * pool.geos.length) | 0];
}

// ---------------------------------------------------------------------------
// BLADE variant pool — the razor clam's shell.
//
// Second shape after `rock` where one asset key maps to SEVERAL geometries,
// and for the same reason: the card promises a handful of shells thrown at
// once, and a handful of identical rectangles reads as a UI element rather
// than as a fistful of shrapnel. `geometryCache` is strictly one geometry per
// key, so like the rocks this sidesteps it.
//
// It cannot be done in the material instead. Every primitive asset shares ONE
// cached material per key (see getMaterial), so a per-blade warp driven from a
// uniform would warp every blade in the water identically — the same trap as
// fading one bubble and fading them all. The variation has to be in the
// vertices, and once it is in the vertices it may as well be baked at boot.
//
// Four warps, all of them small, applied in this order down the body:
//
//   taper   the shell is narrower at the hinge than at the lip, and each
//           variant disagrees slightly about how much
//   bow     a gentle single-arc bend, so the edge is not a ruled line
//   twist   the cross-section rotates about the long axis along its length.
//           THIS IS THE ONE THAT MATTERS for the chrome: the fake environment
//           is read off the normal (see makeChromeMaterial), so a body whose
//           normal is constant along its length shades as one flat slab. A few
//           degrees of twist is what puts a highlight that TRAVELS down the
//           blade instead of a highlight that sits on it.
//   grit    per-vertex noise, a fraction of the width. Kills the machined
//           look without ever being individually visible.
//
// Normals are recomputed at the end. Skipping that is the quiet failure here —
// the geometry warps, the shading does not follow it, and the blades go back to
// looking stamped from one die while the silhouette says otherwise.
// ---------------------------------------------------------------------------

const bladePools = new Map(); // key -> { sig, geos }

function bladeOptions(def) {
  const b = def.blade ?? {};
  return {
    width: b.width ?? 0.16,
    length: b.length ?? 1.05,
    depth: b.depth ?? 0.05,
    segments: Math.max(1, Math.round(b.segments ?? 10)),
    variants: Math.max(1, Math.round(b.variants ?? 7)),
    taper: b.taper ?? 0.34,
    bow: b.bow ?? 0.1,
    twist: b.twist ?? 0.55,
    grit: b.grit ?? 0.1,
  };
}

function bladeSignature(o) {
  return [o.width, o.length, o.depth, o.segments, o.variants,
    o.taper, o.bow, o.twist, o.grit].join('|');
}

// Mulberry32. Seeded so a variant is stable across a rebuild — dragging a
// blade slider must not reshuffle which shells already exist, only reshape
// them, and an unseeded Math.random() here would do both.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createBladeGeometry(o, seed) {
  const rand = seededRandom(seed);
  // Long along +Y, because art forward is +Y everywhere in this file and the
  // shot is spawned with `orient: true` — a blade built along X would fly
  // broadside-on down its own path.
  const geo = new THREE.BoxGeometry(o.width, o.length, o.depth, 1, o.segments, 1);
  const pos = geo.attributes.position;
  const half = o.length * 0.5;

  // Each variant disagrees about its own warp as well as its own noise, so the
  // pool is a set of DIFFERENT shells rather than one shell at seven roughnesses.
  const taper = o.taper * (0.6 + rand() * 0.8);
  const bow = o.bow * (rand() * 2 - 1);
  // A MAGNITUDE AND A SIGN, not a range through zero, and this is the one warp
  // where that distinction matters. `o.twist * (rand() * 2 - 1)` is the obvious
  // spelling and it is wrong: it draws a value NEAR ZERO about as often as an
  // extreme one, and a blade with no twist is a blade whose normal is constant
  // down its whole length — which is exactly the flat slab the chrome shader
  // has nothing to say about. Measured at seven variants, one of them came out
  // at 1.4 degrees of sweep against the other six at 17 to 19, and on screen
  // that one is the shell that looks painted while the rest look polished.
  // Half the configured twist is the floor; the direction is a coin flip.
  const twist = o.twist * (0.5 + rand() * 0.5) * (rand() < 0.5 ? -1 : 1);
  // Which way up the hinge is. Without it every shell in a fan tapers the same
  // way and the volley reads as combed.
  const flip = rand() < 0.5 ? -1 : 1;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // 0 at the hinge, 1 at the lip.
    const t = (y * flip + half) / o.length;

    // taper — narrower at the hinge, in both cross-section axes so the shell
    // keeps its proportions instead of turning into a wedge of foil.
    const s = 1 - taper * (1 - t);
    let nx = x * s;
    let nz = z * s;

    // twist about the long axis, growing along it.
    const a = twist * (t - 0.5);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tx = nx * ca - nz * sa;
    const tz = nx * sa + nz * ca;
    nx = tx;
    nz = tz;

    // bow — one gentle arc, zero at both ends, so the body bends rather than
    // leaning. Scaled by the length, so a longer shell bows further and the
    // curvature stays the same shape.
    nx += bow * o.length * Math.sin(t * Math.PI);

    pos.setXYZ(
      i,
      nx + (rand() * 2 - 1) * o.grit * o.width,
      y + (rand() * 2 - 1) * o.grit * o.width,
      nz + (rand() * 2 - 1) * o.grit * o.depth,
    );
  }

  pos.needsUpdate = true;
  // The whole point of the twist — see the note above.
  geo.computeVertexNormals();
  return geo;
}

function getBladeGeometry(key, def) {
  const o = bladeOptions(def);
  const sig = bladeSignature(o);
  let pool = bladePools.get(key);

  if (!pool || pool.sig !== sig) {
    if (pool) for (const g of pool.geos) g.dispose();
    const base = hashKey(key);
    const geos = [];
    for (let i = 0; i < o.variants; i++) geos.push(createBladeGeometry(o, base + i * 2654435761));
    pool = { sig, geos };
    bladePools.set(key, pool);
  }

  return pool.geos[(Math.random() * pool.geos.length) | 0];
}

function getGeometry(key, def) {
  if (def.shape === 'rock') return getRockGeometry(key, def);
  if (def.shape === 'blade') return getBladeGeometry(key, def);
  if (geometryCache.has(key)) return geometryCache.get(key);
  let geo;
  switch (def.shape) {
    case 'cone':
      geo = new THREE.ConeGeometry(def.radius ?? 0.7, def.height ?? 1.6, def.segments ?? 16);
      break;
    case 'icosahedron':
      geo = new THREE.IcosahedronGeometry(def.radius ?? 0.6, def.detail ?? 0);
      break;
    case 'octahedron':
      geo = new THREE.OctahedronGeometry(def.radius ?? 0.65, def.detail ?? 0);
      break;
    case 'sphere':
      geo = new THREE.SphereGeometry(def.radius ?? 0.2, def.segments ?? 8, def.segments ?? 8);
      break;
    // A sphere stretched along Y — which is art-forward, so anything spawned
    // with `orient: true` (the mussel) lies along its own direction of travel
    // rather than across it.
    case 'oval':
      geo = new THREE.SphereGeometry(def.radius ?? 0.2, def.segments ?? 14, def.segments ?? 14);
      geo.scale(1, def.elongate ?? 1.7, 1);
      break;
    // Unreachable from createVisual — `shape: 'ring'` is intercepted above and
    // built as an organic ring with its own material. Kept because getGeometry
    // is also called by tooling that only wants a shape, and a ring asset
    // falling through to the 0.3 sphere default would be a silent blob.
    case 'ring':
      geo = new THREE.RingGeometry(def.inner ?? 0.8, def.outer ?? 1, def.segments ?? 24);
      break;
    // Two spellings, because the hulls describe themselves as width/height/
    // depth while everything else uses a size triple. Both are read, so a
    // fallback box keeps its intended proportions instead of collapsing to
    // the 1x1x1 default when its model fails to load.
    case 'box': {
      const s = def.size ?? [def.width ?? 1, def.height ?? 1, def.depth ?? 1];
      geo = new THREE.BoxGeometry(s[0], s[1], s[2]);
      break;
    }
    case 'torus':
      geo = new THREE.TorusGeometry(def.radius ?? 0.4, def.tube ?? 0.15, 8, def.segments ?? 16);
      break;
    default:
      geo = new THREE.SphereGeometry(0.3, 8, 8);
  }
  geometryCache.set(key, geo);
  return geo;
}

function getMaterial(key, def) {
  if (materialCache.has(key)) return materialCache.get(key);
  const opts = {
    color: def.color ?? 0xffffff,
    transparent: def.opacity != null,
    opacity: def.opacity ?? 1,
    side: def.shape === 'ring' ? THREE.DoubleSide : THREE.FrontSide,
    // A rock's facet shading lives in its vertex colours (greyscale, baked in
    // systems/rocks.js). three multiplies those into `color`, so tint and glow
    // still own the hue and brightness exactly as they did on the sphere —
    // this only carves the form back in on a material that has no lighting.
    vertexColors: def.shape === 'rock',
  };
  const mat = def.unlit === false ? new THREE.MeshStandardMaterial(opts) : new THREE.MeshBasicMaterial(opts);
  mat.userData.__originalMap = null;
  mat.userData.__originalColor = def.color ?? 0xffffff;
  // `shell: true` takes the trap bubble's numbers; `shell: '<configKey>'` takes
  // its own block off CONFIG. Two assets wear this film now and they are not
  // the same object — a trap is a small hard capsule with a fish visible
  // inside it, an oxygen bubble is a big soft one with nothing in it — so the
  // fresnel that sells each of them is tuned separately. See makeShellMaterial.
  if (def.shell) makeShellMaterial(mat, typeof def.shell === 'string' ? def.shell : 'bubbleShell');
  // `chrome: true` takes CONFIG.chromeBlade; `chrome: '<configKey>'` takes its
  // own block, on the same rule `shell` follows. Only one asset wears it today
  // (the razor clam's shell) and the key is still read rather than assumed,
  // because the second polished thing in the game will not want the first
  // one's horizon. See makeChromeMaterial.
  if (def.chrome) makeChromeMaterial(mat, typeof def.chrome === 'string' ? def.chrome : 'chromeBlade');
  materialCache.set(key, mat);
  return mat;
}

// ---------------------------------------------------------------------------
// FAKE GLASS. `shell: true` on an asset turns its flat translucent ball into
// something that reads as a bubble.
//
// The trick is that a real bubble is not evenly see-through: it is a thin film,
// so you look through almost nothing where it faces you and through a long
// slice of film where it turns away — which is why the edge is bright and the
// middle is not there at all. That is a Fresnel term, and one dot product buys
// the whole read. A uniform 55% alpha instead reads as a fogged marble: the
// same veil over the creature inside as over empty water, with a hard circular
// edge that says "sphere" rather than "surface".
//
// Deliberately NOT a physical transmission material. This has to survive on a
// phone in a crowd of thirty, it has to work on the unlit MeshBasicMaterial
// every primitive asset here already uses, and — the part a real refraction
// would fight — the creature inside must stay legible. This is a look, not
// optics.
// ---------------------------------------------------------------------------

// Every live shell material and WHICH CONFIG BLOCK IT READS, so a tuner edit
// reaches the ones already on screen. A Map rather than a walk of ASSETS:
// getMaterial caches one material per key, and this holds exactly those.
//
// The value is the config key, because the film is worn by two assets that
// want opposite settings from it. Sharing one block meant every number was a
// compromise between a 0.35-unit capsule seen against a fish and a 1.4-unit
// balloon seen against open water.
const shellMaterials = new Map();

// The one place the injected GLSL lives. Kept as a plain string rather than
// spread across .replace() calls so the whole shader can be read at once — and
// with NO backtick anywhere in it, including in the comments, since a backtick
// inside a template literal ends the string and reports itself as a syntax
// error somewhere else entirely.
const SHELL_FRAGMENT = `
  // Facing-ness, folded so it is the same on both faces of the sphere: the
  // far wall of a bubble is film too, and abs() is what lets one material
  // draw both without the back half inverting.
  float shellFace = 1.0 - abs(dot(normalize(vShellN), normalize(vShellV)));
  float shellRim = pow(clamp(shellFace, 0.0, 1.0), uShellPower);
  // A second, much tighter band right at the silhouette. Without it the rim is
  // a soft halo — a glow around a ball — and with it there is a bright line ON
  // the surface, which is what sells a film with a thickness.
  float shellSheen = pow(clamp(shellFace, 0.0, 1.0), uShellPower * 4.0) * uShellSheen;
  vec4 diffuseColor = vec4(
    // Multiplied past 1.0 on purpose: the scene renders to an HDR target, so
    // the rim is what bloom's bright-pass picks up while the body stays under
    // threshold. See CONFIG.bloom.
    diffuse * (1.0 + shellRim * uShellBoost + shellSheen * 3.0),
    clamp(opacity * mix(uShellCore, uShellRim, shellRim) + shellSheen, 0.0, 1.0)
  );
`;

function makeShellMaterial(mat, cfgKey = 'bubbleShell') {
  mat.transparent = true;
  // A bubble you can see the far side of, and see a fish THROUGH. Depth
  // writing is what would stop both: the near wall would z-reject the far one
  // and the creature it is wrapped around, and a bubble that hides what it
  // caught is worse than no bubble at all.
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;

  // Owned here rather than pulled off `shader.uniforms` afterwards, for the
  // same reason the outline shells own theirs: onBeforeCompile does not run
  // until this material is first rendered, so anything written before the
  // first bubble reaches the screen — every boot value, and any tuner edit
  // made while none are in the water — would be dropped on the floor.
  mat.userData.__shell = {
    uShellPower: { value: 2.6 },
    uShellCore: { value: 0.06 },
    uShellRim: { value: 0.95 },
    uShellBoost: { value: 2.2 },
    uShellSheen: { value: 0.35 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.__shell);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShellN;\nvarying vec3 vShellV;')
      // AFTER project_vertex, which is where `mvPosition` is defined — it is a
      // local of the chunk's scope, not a varying, so this cannot be hoisted
      // any earlier. `normalMatrix` and `normal` are default uniforms/attributes
      // and are available in every material, lit or not.
      .replace('#include <project_vertex>',
        '#include <project_vertex>\n\tvShellN = normalize(normalMatrix * normal);\n\tvShellV = normalize(-mvPosition.xyz);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uShellPower;\nuniform float uShellCore;\nuniform float uShellRim;'
        + '\nuniform float uShellBoost;\nuniform float uShellSheen;\nvarying vec3 vShellN;\nvarying vec3 vShellV;')
      // Replaces the line that DECLARES diffuseColor, so everything downstream
      // — the map, the tint, the alpha test — still runs on top of it exactly
      // as it would have. Injecting after <map_fragment> instead would throw
      // away any texture the Look panel put on the bubble.
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', SHELL_FRAGMENT);
  };

  shellMaterials.set(mat, cfgKey);
  applyBubbleShellSettings();
  return mat;
}

// Push CONFIG.bubbleShell onto every shell material. Pure uniform writes on an
// already-compiled shader, so this is safe to call from a slider's every input
// event — see handleTunerChange in main.js.
export function applyBubbleShellSettings() {
  for (const [mat, cfgKey] of shellMaterials) {
    // Falls back to the trap bubble's block rather than to the bare defaults,
    // so an asset naming a config key that has not been written yet wears a
    // film that at least looks like a bubble instead of the hardcoded numbers
    // nobody has looked at since this shader was written.
    const cfg = CONFIG[cfgKey] ?? CONFIG.bubbleShell ?? {};
    const u = mat.userData.__shell;
    if (!u) continue;
    u.uShellPower.value = Math.max(0.1, cfg.power ?? 2.6);
    u.uShellCore.value = cfg.coreAlpha ?? 0.06;
    u.uShellRim.value = cfg.rimAlpha ?? 0.95;
    u.uShellBoost.value = cfg.rimBoost ?? 2.2;
    u.uShellSheen.value = cfg.sheen ?? 0.35;
  }
}

// ---------------------------------------------------------------------------
// FAKE CHROME. `chrome: true` on an asset turns its flat coloured body into
// polished metal.
//
// Real metal is nothing but reflection — it has no diffuse colour of its own,
// which is exactly why `metalness: 1` on a MeshStandardMaterial renders BLACK
// in this game: there is no environment map anywhere in the scene for it to
// reflect, and there is not going to be one. A cube-mapped PMREM probe to make
// six shells on screen look shiny is not a trade worth making on a phone.
//
// So the environment is faked, and faked in VIEW SPACE, which is the whole
// trick. Chrome is legible as chrome because of ONE feature: a hard horizon
// between a dark ground and a bright sky, sitting still in the world while the
// object turns through it. Read the ramp off a view-space normal and you get
// that for free — the band sweeps across the body as it rolls and stays put as
// the body travels, which is a matcap in four lines and no texture.
//
// Three things stack on the ramp, in ascending order of how much each one is
// doing:
//
//   the horizon line   a narrow bright band where sky meets water. Without it
//                      the ramp is a soft gradient, which reads as plastic.
//   the key            one hot specular lobe, so a blade FLASHES once as it
//                      rolls through it rather than glinting continuously.
//   the rim            grazing angles on polished metal go BRIGHT. This is the
//                      opposite of the bubble's fresnel, which is a film seen
//                      edge-on, and the two must not be confused.
//
// All three are multiplied past 1.0 on purpose, the same as the shell above:
// the scene renders to an HDR target, so they are what bloom's bright-pass
// picks up while the body stays under threshold. Bloom thresholds LUMINANCE,
// where blue counts for about 7%, so a highlight tinted cold enough to read as
// steel will not bloom at all — which is why `light` and `spec` here are near
// white and the COLD is spent on `dark` instead.
//
// Not lit, not shaded, not physical. This is a look.
// ---------------------------------------------------------------------------

// Every live chrome material and which CONFIG block it reads, exactly as
// shellMaterials above — so a tuner edit reaches the blades already in flight.
const chromeMaterials = new Map();

// One string, no backtick anywhere in it including the comments: a backtick
// inside a template literal ends the string and reports itself as a syntax
// error somewhere else entirely.
const CHROME_FRAGMENT = `
  vec3 chromeN = normalize(vChromeN);
  vec3 chromeV = normalize(vChromeV);

  // THE ENVIRONMENT. A vertical ramp read off the view-space normal: dark
  // water below, bright sky above, a horizon between them. The body turns,
  // the horizon does not, and that is the read.
  float chromeUp = chromeN.y * 0.5 + 0.5;
  float chromeBand = smoothstep(uChromeHorizon - uChromeBlend, uChromeHorizon + uChromeBlend, chromeUp);
  vec3 chromeEnv = mix(uChromeDark, uChromeLight, chromeBand);

  // The horizon LINE, much narrower than the blend above. This is what makes
  // the surface read as polished rather than as merely light-on-top.
  float chromeEdge = 1.0 - smoothstep(0.0, max(uChromeLineWidth, 0.001), abs(chromeUp - uChromeHorizon));
  chromeEnv += chromeEdge * uChromeLine;

  // The key light, pinned to the camera rather than to the world, so every
  // blade in a fan catches it at the same point in its own roll.
  float chromeKey = pow(max(dot(chromeN, normalize(uChromeKeyDir)), 0.0), max(uChromeGloss, 1.0));
  chromeEnv += chromeKey * uChromeSpec;

  // Grazing angles. Bright, because this is metal and not film.
  float chromeFace = 1.0 - abs(dot(chromeN, chromeV));
  chromeEnv += pow(clamp(chromeFace, 0.0, 1.0), max(uChromePower, 0.01)) * uChromeRim;

  vec4 diffuseColor = vec4(diffuse * chromeEnv, opacity);
`;

function makeChromeMaterial(mat, cfgKey = 'chromeBlade') {
  // Opaque, unlike the shell: a blade is solid, and the far wall of the box
  // has no business showing through the near one.
  mat.side = THREE.FrontSide;

  // Owned here rather than read off `shader.uniforms` afterwards, for the same
  // reason the shell owns its block: onBeforeCompile does not run until the
  // material is first RENDERED, so every boot value — and any tuner edit made
  // while no blade happens to be in the water — would be dropped on the floor.
  mat.userData.__chrome = {
    uChromeDark: { value: new THREE.Color(0x0b1a2c) },
    uChromeLight: { value: new THREE.Color(0xf2f8ff) },
    uChromeHorizon: { value: 0.5 },
    uChromeBlend: { value: 0.09 },
    uChromeLineWidth: { value: 0.05 },
    uChromeLine: { value: 1.1 },
    uChromeKeyDir: { value: new THREE.Vector3(0.35, 0.7, 0.62) },
    uChromeGloss: { value: 26 },
    uChromeSpec: { value: 2.2 },
    uChromePower: { value: 2.4 },
    uChromeRim: { value: 0.9 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.__chrome);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vChromeN;\nvarying vec3 vChromeV;')
      // AFTER project_vertex, where `mvPosition` is defined — it is a local of
      // that chunk's scope and not a varying, so this cannot be hoisted any
      // earlier. `normalMatrix` and `normal` are default uniforms/attributes
      // and exist on every material, lit or not.
      .replace('#include <project_vertex>',
        '#include <project_vertex>\n\tvChromeN = normalize(normalMatrix * normal);\n\tvChromeV = normalize(-mvPosition.xyz);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uChromeDark;\nuniform vec3 uChromeLight;\nuniform float uChromeHorizon;'
        + '\nuniform float uChromeBlend;\nuniform float uChromeLineWidth;\nuniform float uChromeLine;'
        + '\nuniform vec3 uChromeKeyDir;\nuniform float uChromeGloss;\nuniform float uChromeSpec;'
        + '\nuniform float uChromePower;\nuniform float uChromeRim;\nvarying vec3 vChromeN;\nvarying vec3 vChromeV;')
      // Replaces the line that DECLARES diffuseColor, so the map, the tint and
      // the alpha test downstream all still run on top of it — injecting after
      // <map_fragment> instead would throw away anything the Look panel put on
      // the blade.
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', CHROME_FRAGMENT);
  };

  chromeMaterials.set(mat, cfgKey);
  applyChromeSettings();
  return mat;
}

// Push CONFIG.chromeBlade onto every chrome material. Pure uniform writes on an
// already-compiled shader, so this is safe to call from a slider's every input
// event — see handleTunerChange in main.js.
export function applyChromeSettings() {
  for (const [mat, cfgKey] of chromeMaterials) {
    const cfg = CONFIG[cfgKey] ?? CONFIG.chromeBlade ?? {};
    const u = mat.userData.__chrome;
    if (!u) continue;
    u.uChromeDark.value.set(cfg.dark ?? 0x0b1a2c);
    u.uChromeLight.value.set(cfg.light ?? 0xf2f8ff);
    u.uChromeHorizon.value = cfg.horizon ?? 0.5;
    u.uChromeBlend.value = Math.max(0.001, cfg.blend ?? 0.09);
    u.uChromeLineWidth.value = Math.max(0.001, cfg.lineWidth ?? 0.05);
    u.uChromeLine.value = cfg.line ?? 1.1;
    // Normalised in the shader, so a key direction dragged to all zeros is a
    // dead specular rather than a NaN across the whole body.
    u.uChromeKeyDir.value.set(cfg.keyX ?? 0.35, cfg.keyY ?? 0.7, cfg.keyZ ?? 0.62);
    u.uChromeGloss.value = Math.max(1, cfg.gloss ?? 26);
    u.uChromeSpec.value = cfg.spec ?? 2.2;
    u.uChromePower.value = Math.max(0.01, cfg.rimPower ?? 2.4);
    u.uChromeRim.value = cfg.rim ?? 0.9;
  }
}
