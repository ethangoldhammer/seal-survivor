import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { applyAssetTable } from './assetTable.js';
import { attachNoiseShader, applyNoiseSettings } from './systems/noiseShader.js';
import { attachBiolumSkin, applyBiolumSkinSettings, instantiateBiolumSkin, splitForEdges } from './systems/biolumSkin.js';
import { attachGrassSway, applyGrassSettings } from './systems/grassSway.js';
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
    ['Shoulder2L_041', 'Hand1L_042', 'Hand2L_043', 'Hand3L_044'],
    ['Shoulder2R_051', 'Hand1R_052', 'Hand2R_053', 'Hand3R_054'],
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
  bullet: { shape: 'rock', radius: 0.18, color: 0xffe066, unlit: true, rock: { tumble: 7 } },
  // The homing mussel: a black shell, deliberately almost unlit — what you
  // track across the screen is the burning trail it leaves (CONFIG.trails.
  // missile.particles), not the shell itself. Glow can't brighten it, since
  // the overdrive multiplies colour and black stays black however hard you
  // multiply it — that's the intent, not an oversight.
  missile: { shape: 'oval', radius: 0.16, elongate: 1.8, color: 0x07070a, unlit: true },
  bounceShot: { shape: 'octahedron', radius: 0.2, color: 0x66ddff, unlit: true },
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
  // NOT a rock, deliberately: this one is a literal air bubble rising to the
  // surface. Flip `shape` to 'rock' here if you want it stony like the rest.
  bubbleOrb: { shape: 'sphere', radius: 0.22, color: 0xdff6ff, opacity: 0.65, unlit: true },
  rapidFireOrb: { shape: 'rock', radius: 0.3, color: 0xffe066, unlit: true, rock: { tumble: 1.2, frequency: 1.8, squash: 0.34 } },
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
    outline: { color: 0xffd27a, thickness: 0.022 },
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
    outline: { color: 0xffd27a, thickness: 0.022 },
    shape: 'icosahedron', radius: 1.05, color: 0x2c3a4a, unlit: true,
  },
  orcaFriendCalf: {
    model: '/models/orca_calf.glb',
    fit: 2.2,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    rig: ORCA_RIG,
    lookRig: orcaLook(44.4),
    outline: { color: 0xffd27a, thickness: 0.022 },
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
  enemyOtter: {
    model: '/models/otter.glb',
    texture: { emissive: '/textures/emissive/otter.jpg' },
    fit: 2.1,
    pivot: 0.15, // turn about the head, not the belly
    forward: '+Z', up: '+Y',
    animations: { idle: 'fast_swim_steady_baked', swim: 'fast_swim_steady_baked', boost: 'fast_swim_steady_baked' },
    // BITE — jaw_00, under head_024. Not a shark, but it carries `hunt` and so
    // eats fish exactly as they do, and a hunter chewing with its mouth shut
    // is the thing this whole system exists to stop.
    //
    // Negative, unlike the other '+Z'-facing rigs: this jaw's local X comes
    // out at model (-0.999, -0.011, 0.049), so the sign flips. See the method
    // note on enemyShark.biteRig.
    //
    // The weakest bite in the roster, and it is the RIG, not the number. This
    // jaw hinges oddly: measured, -0.5 rad moves its 780 vertices 0.0178, but
    // only 0.0086 of that is downward — the rest is forward, so it reads more
    // as the snout pushing out than as a mouth opening. (The other direction
    // and the other axes are worse: +x lifts the jaw INTO the skull, and local
    // z is 0.05 off the flank axis and barely moves anything.) The otter is a
    // small side hunter rather than one of the sharks, so a subtle chomp is an
    // acceptable answer; if it ever wants to read properly it needs a
    // two-bone treatment (jaw_00 plus jaw001_025), not a bigger angle.
    biteRig: { bone: 'jaw_00', axis: 'x', openAngle: -0.35 },
    shape: 'icosahedron', radius: 0.5, color: 0x8a6a4a, unlit: true,
  },
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
    tint: 0x141c24,
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
    // THE WIREFRAME SKIN, available to this body. `biolumEdges` splits the
    // geometry at load so barycentric coordinates exist (see splitForEdges);
    // `biolumSkin` names the preset it wears. The orca is the right animal to
    // carry it: 11,238 triangles of smooth hull means an edge flow that reads
    // as a drawn cage rather than as noise, which is not true of the
    // roster's low-poly fish.
    biolumEdges: true,
    biolumSkin: 'wireframeGlow',
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
    // THE WIREFRAME SKIN, available to this body. `biolumEdges` splits the
    // geometry at load so barycentric coordinates exist (see splitForEdges);
    // `biolumSkin` names the preset it wears. The orca is the right animal to
    // carry it: 11,238 triangles of smooth hull means an edge flow that reads
    // as a drawn cage rather than as noise, which is not true of the
    // roster's low-poly fish.
    biolumEdges: true,
    biolumSkin: 'wireframeGlow',
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
  ['clubBoom', 0xd94a2b],   // Powder Keg — ember
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
      if (def.noiseShader) attachNoiseShader(m2);
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

  if (def.outline) addOutlineShells(model, def.outline);

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
// Per key, because the pool exists to absorb a school dying at once and not to
// hold the whole roster resident forever. Past this a body really is disposed.
const POOL_PER_KEY = 24;

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
  // Hidden while it waits. A system holding a stale reference to a creature
  // that just died can then still write to it without anything appearing on
  // screen — the reset clears the flag on the way back out.
  visual.visible = false;
  let free = visualPool.get(key);
  if (!free) { free = []; visualPool.set(key, free); }
  if (free.length >= POOL_PER_KEY) {
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
}

/** Bodies waiting, per key. Diagnostics only. */
export function visualPoolStats() {
  const out = {};
  for (const [key, free] of visualPool) if (free.length) out[key] = free.length;
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

export function addOutlineShells(model, spec) {
  const shared = spec.material ?? null;
  const targets = [];
  const shells = [];
  // Shells are meshes too, so a second call on the same object would outline
  // the outlines — half of them inside-out, since a shell is already reversed.
  model.traverse((o) => { if (o.isMesh && !o.userData.__isOutline) targets.push(o); });

  for (const mesh of targets) {
    const mat = shared ?? makeOutlineMaterial(spec);

    let shell;
    if (mesh.isSkinnedMesh) {
      shell = new THREE.SkinnedMesh(mesh.geometry, mat);
      shell.bind(mesh.skeleton, mesh.bindMatrix);
      // Sibling, not child: the skeleton already places this in world space,
      // and nesting it under the skinned mesh would apply that transform a
      // second time.
      mesh.parent?.add(shell);
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
      .replace('#include <common>', '#include <common>\nuniform float uOutline;')
      // Offset in OBJECT space, immediately after begin_vertex sets
      // `transformed` and BEFORE skinning runs. Skinning then transforms the
      // already-offset position, so the shell deforms with the animation
      // instead of tearing away from it.
      //
      // Must not use `objectNormal` or `mvPosition`: the first is only
      // defined by <beginnormal_vertex>, which MeshBasicMaterial doesn't
      // include, and the second isn't declared until <project_vertex>.
      // `normal` is a default attribute and is always available here.
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\ttransformed += normal * uOutline;'
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
// Deliberately a second function rather than a fallback bolted onto
// assetSignatureColor: that one returning null is load-bearing at the kill
// feedback, where "no configured look" is what selects the emitter's own
// multi-colour palette. Widening it there would quietly flatten every kill
// burst to one hue.
export function assetBaseColor(key) {
  const tuned = assetSignatureColor(key);
  if (tuned != null) return tuned;
  return ASSETS[key]?.color ?? null;
}

// Sizes come from assets.csv, applied AFTER the saved looks above so the file
// wins over anything a snapshot still carries. Exported and called from the
// same places, so a CSV edit takes effect on the next apply rather than only
// on a cold boot.
export function applyAssetSizesFromTable() {
  applyAssetTable(setAssetSizeMultiplier, (key) => key in ASSETS);
}

// Applied at MODULE LOAD, not only from applySavedAssetLooks(). The file is
// the source of truth for spawn size, so it has to be true from the moment
// anything can call createVisual — not merely once whatever boot path happens
// to call the saved-looks hook has run. The call inside that hook stays, so a
// re-apply after a CSV edit still lands.
applyAssetSizesFromTable();

export function applySavedAssetLooks() {
  const looks = CONFIG.assetLooks ?? {};
  for (const [key, look] of Object.entries(looks)) {
    if (!look) continue;
    try {
      if (look.tint != null) setAssetTint(key, look.tint);
      if (look.emissive != null) setAssetEmissive(key, look.emissive);
      if (look.glow != null && look.glow !== 1) setAssetGlow(key, look.glow);
      // Only when explicitly chosen. `null` means this model was left on auto,
      // and writing it back would pin it to whatever the global happened to be
      // at save time.
      if (look.emissiveMask != null) setAssetEmissiveMask(key, look.emissiveMask);
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
    m.needsUpdate = true;
  }
}

// Tint and glow both write the SAME property on an unlit material (its
// colour), so they're resolved together rather than fighting each other:
// the last one set would otherwise clobber the other. Tracked per asset and
// re-applied as a pair.
const tintState = new Map(); // key -> { tint, glow }

function applyColorAndGlow(key) {
  const st = tintState.get(key) ?? {};
  for (const m of getAssetMaterials(key)) {
    if (!m.color) continue;
    const base = st.tint ?? m.userData.__originalColor ?? 0xffffff;

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
export { applyNoiseSettings, applyGrassSettings, applyBiolumSkinSettings };

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

export function setAssetRoughness(key, value) {
  for (const m of getAssetMaterials(key)) {
    if (!('roughness' in m)) continue;
    if (m.userData.__originalRoughness === undefined) m.userData.__originalRoughness = m.roughness ?? 1;
    m.roughness = value ?? m.userData.__originalRoughness;
  }
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

function getGeometry(key, def) {
  if (def.shape === 'rock') return getRockGeometry(key, def);
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
  if (def.shell) makeShellMaterial(mat);
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

// Every live shell material, so a tuner edit reaches the ones already on
// screen. A Set rather than a walk of ASSETS: getMaterial caches one material
// per key, and this holds exactly those.
const shellMaterials = new Set();

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

function makeShellMaterial(mat) {
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

  shellMaterials.add(mat);
  applyBubbleShellSettings();
  return mat;
}

// Push CONFIG.bubbleShell onto every shell material. Pure uniform writes on an
// already-compiled shader, so this is safe to call from a slider's every input
// event — see handleTunerChange in main.js.
export function applyBubbleShellSettings() {
  const cfg = CONFIG.bubbleShell ?? {};
  for (const mat of shellMaterials) {
    const u = mat.userData.__shell;
    if (!u) continue;
    u.uShellPower.value = Math.max(0.1, cfg.power ?? 2.6);
    u.uShellCore.value = cfg.coreAlpha ?? 0.06;
    u.uShellRim.value = cfg.rimAlpha ?? 0.95;
    u.uShellBoost.value = cfg.rimBoost ?? 2.2;
    u.uShellSheen.value = cfg.sheen ?? 0.35;
  }
}
