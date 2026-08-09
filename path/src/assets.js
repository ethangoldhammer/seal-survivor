import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { attachNoiseShader, applyNoiseSettings } from './systems/noiseShader.js';
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
//   outline  { color, thickness } — draws a constant-width border around the
//            silhouette via an inverted-hull shell (back faces only, pushed
//            out along the normal). Costs ONE extra draw call per mesh and no
//            per-frame work, so it's cheap for a few objects and expensive
//            only if used on something there are dozens of. Works on skinned
//            models: the push happens after skinning, in the vertex shader.
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
    // point a flipper. Their tips are the bullet muzzles.
    //
    // `head` stops at head_07 rather than continuing into mouth_08: mouth_08
    // is the jaw, and rotating it to aim would leave the seal gaping. The
    // effector is a point out at the snout instead.
    //
    // `anchors` are read-only — world points published each frame for the
    // bubble emitters, no IK. The tail anchor is the last tail bone's tip,
    // which is where a wake should come off.
    aimRig: {
      tipAxis: '+Y',
      fins: [
        { name: 'left', bones: ['uparm_L_012', 'arm_L_013', 'hand_L_014'], tipLength: 0.26 },
        { name: 'right', bones: ['uparm_R_016', 'arm_R_017', 'hand_R_018'], tipLength: 0.26 },
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
        tail: { bone: 'tail02_023', offset: [0, 0.16, 0] },
      },
    },
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
    shape: 'octahedron', radius: 0.22, color: 0xff7fb0, unlit: true,
  },
  seagull: {
    model: '/models/seagull.fbx',
    // Two-tone mask (--pure), not a composite: this file's own maps never
    // reach the renderer, so the mask is built from the source base colour
    // in the C4D library. See tools/make-emissive-masks.mjs EXTERNAL.
    texture: { emissive: '/textures/emissive/seagull.png' },
    fit: 1.3,
    forward: '+Z', up: '+Y',
    // One 24.77s "Take 001" with every animation baked end to end and no
    // range markers. Rather than re-exporting it split, the ranges live here
    // — see buildSubclips(). Frames are against the file's own 30fps.
    //
    // Boundaries were found by sampling per-bone motion energy plus wing and
    // pelvis height across all 743 frames, so they land on the quiet joins
    // between takes rather than on guesses:
    //   0-225   grounded idle        400-425  takeoff
    //   230-250 wing flare           430-479  glide (wings held, no motion)
    //   300-400 ground cycle (loops) 480-520  flapping flight
    //   525-560 climb                562-608  soar at altitude
    //   615-645 dive (pelvis 21.9 -> 4.8)     662-743 landed
    //
    // The dive range stops at 645 on purpose: 645-655 is the impact recovery,
    // and the seagull system loops the dive until it actually hits something,
    // so recovery frames in the loop would read as a stutter mid-plunge.
    subclipFps: 30,
    subclips: {
      seagullGlide: [430, 479],
      seagullFlap: [480, 520],
      seagullDive: [615, 645],
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
      death: 'Seal_Rig|Seal_Rig|Seal_Rig|sleep',
    },
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
  trapBubble: { shape: 'sphere', radius: 0.35, color: 0xaeefff, opacity: 0.55, unlit: true },

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

  // Strike shrapnel: small, pale, and short-lived. Reads as bone rather than
  // as another bullet, which matters when a dash through a school throws
  // dozens of them at once.
  shrapnel: { shape: 'octahedron', radius: 0.14, color: 0xfff4e0, unlit: true },
  enemyBullet: { shape: 'sphere', radius: 0.15, color: 0xff7766, unlit: true },

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
    rig: {
      springChains: [
        ['spine002_01', 'spine001_02', 'spine_03',
         'back_finTBk_04', 'back_finT001Bk_05', 'back_finT002Bk_06'],
      ],
      // STUB — other fins, not enabled. Each of these is a valid independent
      // chain that would get its own lag if appended to springChains above.
      // Left off for now because every extra chain is another spring solve
      // per creature per frame, and the tails are where the read actually is.
      // Bone names verified against the file:
      //   lower caudal lobe  ['back_finBBk_07', 'back_finB001Bk_08']
      //   pectoral L         ['shoulderL_018', 'side_finL_019', 'side_finL001_020']
      //   pectoral R         ['shoulderR_021', 'side_finR_022', 'side_finR001_023']
      //   dorsal             ['top_fin_024', 'top_fin001_025']
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
    rig: {
      springChains: [
        ['Spine_04_03', 'Tail_01_04', 'Tail_02_05', 'Tail_03_06', 'Tail_04_07', 'Tail_05_08'],
      ],
      // STUB — other fins, not enabled. See enemyMegalodon.
      //   lower caudal lobe  ['Tail_06_09', 'Tail_07_010']
      //   pectoral L         ['Fin_L_01_013', 'Fin_L_02_014']
      //   pectoral R         ['Fin_R_01_015', 'Fin_R_02_016']
      //   dorsal             ['Fin_01_011', 'Fin_02_012']
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
    rig: {
      springChains: [
        ['Bone003_Armature_5', 'Bone002_Armature_4', 'Bone004_Armature_3'],
      ],
      // STUB — other fins, not enabled. See enemyMegalodon.
      //   pelvic/anal cluster ['Bone017_Armature_12', 'Bone018_Armature_8']
      //   pectoral L          ['Bone011_Armature_22', 'Bone013_Armature_21', 'Bone015_Armature_20']
      //   pectoral R          ['Bone012_Armature_25', 'Bone014_Armature_24', 'Bone016_Armature_23']
      //   dorsal              ['Bone009_Armature_28', 'Bone010_Armature_27']
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
    model: '/models/crabwalking.glb',
    texture: { emissive: '/textures/emissive/crabwalking.jpg' },
    fit: 2.8,
    // '+X' is the STRIDE axis (where the L/R leg pairs straddle), not the way
    // the crab faces — deliberately. With enemies.js pinning the heading for
    // faceCamera creatures, this puts model +X along the screen horizontal,
    // +Y up and +Z (the claws and face) pointing at the camera.
    forward: '+X', up: '+Y',
    // Six legs and two claws, each its own spring chain. No `wagChain`: this
    // model's clips cover every state, so the procedural sine fallback is
    // never wanted — these exist purely so a collision has a skeleton to
    // shove (CONFIG.crabPhysics -> anim.impulse). Each spring's target stays
    // the walk cycle, so the limbs settle back into the loop on their own.
    rig: {
      axis: 'z',
      springChains: [
        ['CATRigLLeg1_02', 'CATRigLLeg2_03', 'CATRigLLeg3_04', 'CATRigLLegAnkle_05'],
        ['CATRigRLeg1_06', 'CATRigRLeg2_07', 'CATRigRLeg3_08', 'CATRigRLegAnkle_09'],
        ['CATRigLLeg1_010', 'CATRigLLeg2_011', 'CATRigLLeg3_012', 'CATRigLLegAnkle_013'],
        ['CATRigRLeg1_014', 'CATRigRLeg2_015', 'CATRigRLeg3_016', 'CATRigRLegAnkle_017'],
        ['CATRigLLeg1_018', 'CATRigLLeg2_019', 'CATRigLLeg3_020', 'CATRigLLegAnkle_00'],
        ['CATRigRLeg1_021', 'CATRigRLeg2_022', 'CATRigRLeg3_023', 'CATRigRLegAnkle_024'],
        ['CATRigLArm1_026', 'CATRigLArm2_027', 'CATRigLArm3_028', 'CATRigLArmPalm_029'],
        ['CATRigRArm1_031', 'CATRigRArm2_032', 'CATRigRArm3_033', 'CATRigRArmPalm_034'],
      ],
    },
    shape: 'octahedron', radius: 0.6, color: 0xc9713f, unlit: true,
  },
  // --- new creatures -------------------------------------------------------
  // Axes below come from rendering each file with an axis helper (see
  // model-inspector.html), not from guessing at the longest dimension.

  enemyOrca: {
    model: '/models/orca.glb',
    fit: 5.2,
    pivot: 0.15,
    forward: '+Z', up: '+Y',
    animations: {
      idle: 'Orca_Rig|Orca_Rig|idle',
      swim: 'Orca_Rig|Orca_Rig|swim',
      boost: 'Orca_Rig|Orca_Rig|rushbeach',
    },
    // Tail trail — see the rationale on enemyMegalodon. Seven bones, the
    // longest tail in the roster, and the only one that can start at its own
    // root: hip_01001_024 is a dedicated tail hip with nothing else hanging
    // off it, so springing it swings the whole rear without touching the
    // head, dorsal or pectorals (those live under the sibling hip_01_05).
    //
    // A cetacean's fluke beats vertically, which is the plane the camera
    // sees, so this is the one creature in the set where the trail reads at
    // full strength rather than partly into the screen.
    // The orca is the one creature here that springs its fins as well as its
    // tail — four independent chains. They have to be separate solvers rather
    // than one long chain: the solver's whole method is each bone measuring
    // its target after its PARENT has moved, which assumes a single root-to-
    // tip ordering, and a body with fins coming off it has no such ordering.
    // Separate chains also means each limb lags on its own timing, which is
    // what stops the whole animal reading as one wobbling piece.
    //
    // The fin bone names are junk from a reused quadruped rig — `Thigh`/`Foot`
    // are the pectoral flippers — so these were identified by measuring world
    // positions, not by reading names. Verified against the file: the dorsal
    // sits on the centreline (x≈0) rising behind midbody, and the pectorals
    // spread to ±X low on the body near the head.
    rig: {
      springChains: [
        // tail
        ['hip_01001_024', 'tail_01_025', 'tail_02_026', 'tail_03_027',
         'tail_04_028', 'tail_05_029', 'tail_05001_030'],
        // dorsal
        ['fin001_06', 'fin002_07', 'fin003_08', 'fin004_09'],
        // pectoral L
        ['Thigh_F01_L_016', 'Foot_F02_L_017', 'Foot_F03_L_018', 'Foot_F04_L_019'],
        // pectoral R
        ['Thigh_F01_R_020', 'Foot_F02_R_021', 'Foot_F03_R_022', 'Foot_F04_R_023'],
      ],
      // STUB — the fluke lobes, still not enabled. They hang off the last
      // tail bone, so they already ride the tail's own trail; giving them
      // their own chains would lag them a second time on top of that.
      //   fluke L ['tailfin_L001_031', 'tailfin_L002_032', 'tailfin_L003_033']
      //   fluke R ['tailfin_R001_034', 'tailfin_R002_035', 'tailfin_R003_036']
    },
    // Head-look — see enemyShark. The one animal in this set with something
    // like a real neck, and the only one whose look chain overlaps the spring
    // chains: Spine_03_012 is the parent of both pectorals, so leaning the
    // head displaces the flippers' spring targets and they trail the turn.
    // That compounds rather than conflicts. The look runs AFTER the springs
    // each frame, so they pick the displacement up on the next one and trail
    // it — which is the direction secondary motion is supposed to go anyway.
    lookRig: {
      head: { bones: ['Spine_03_012', 'Head_013'], tipAxis: '+Y', tipLength: 0.4 },
    },
    // BITE — mouth_015, same rig family as the low-poly shark and the dolphin
    // (Blender's animal armature: Head with eye_L / eye_R / mouth hanging off
    // it). None of this file's 5 clips is a bite, so it's procedural — see
    // systems/jaw.js. Local X, dot 1.000 with the flank axis, positive sign.
    //
    // The widest gape in the roster, and deliberately: this is the creature
    // whose whole design is that it out-eats everything else (a 34-unit prey
    // radius against a shark's 18, and a 0.45s bite cooldown against 1.2), so
    // the mouth is the thing you should be reading off it.
    biteRig: { bone: 'mouth_015', axis: 'x', openAngle: 0.62 },
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
    rig: {
      springChains: [
        ['pelvis_017', 'tail00_018'],
      ],
      // STUB — other fins, not enabled. See enemyMegalodon.
      //   fluke L    ['leg_L_019', 'foot_L_020']
      //   fluke R    ['leg_R_021', 'foot_R_022']
      //   pectoral L ['shoulder_L_011', 'arm_L_012', 'hand_L_013']
      //   pectoral R ['shoulder_R_014', 'arm_R_015', 'hand_R_016']
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

  enemyAnimatedCrab: {
    model: '/models/animatedcrab.glb',
    texture: { emissive: '/textures/emissive/animatedcrab.jpg' },
    fit: 1.9,
    forward: '+X', up: '+Y',
    // 'Derecha'/'Izquierda' are right/left walk cycles (measured: Derecha
    // carries the crab toward model +X, Izquierda toward -X). This walks on
    // Derecha for EVERY locomotion state and gets the other direction by
    // reversing playback, since a faceCamera creature never turns around —
    // see entities/enemies.js.
    //
    // boost deliberately maps to Derecha too, not to Izquierda. The direction
    // logic keys off `gaitTravel`, which describes Derecha; a state that
    // quietly swapped in the opposite-handed clip would have the legs pushing
    // backwards. That was harmless while crabs could never reach boost, but
    // the difficulty speed ramp now takes a rushing crab past
    // animation.boostThreshold late in a run. Izquierda is left unused.
    animations: { idle: 'Derecha', swim: 'Derecha', boost: 'Derecha' },
    // Same idea as the walking crab: six two-bone legs and two three-bone
    // claws, springs only, so collisions have something to knock about.
    rig: {
      axis: 'z',
      springChains: [
        ['Pata1P1R_1', 'Pata1P2R_0'],
        ['Pata2P1R_4', 'Pata2P2R_3'],
        ['Pata3P1R_7', 'Pata3P2R_6'],
        ['Pata1P1L_10', 'Pata1P2L_9'],
        ['Pata2P1L_13', 'Pata2P2L_12'],
        ['Pata3P1L_16', 'Pata3P2L_15'],
        ['PinzaP1R_20', 'PinzaP2R_19', 'PinzaP3R_18'],
        ['PinzaP1L_24', 'PinzaP2L_23', 'PinzaP3L_22'],
      ],
    },
    shape: 'icosahedron', radius: 0.6, color: 0xd06a3a, unlit: true,
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
        const result = await loadModel(picked, def.model);
        // GLTFLoader puts clips on the result object; FBXLoader puts them
        // directly on the returned Object3D. Either way, grab them before
        // prepareModel restructures the hierarchy.
        const clips = result.animations ?? [];
        let overrideTex = null;
        if (def.texture?.map) {
          try {
            overrideTex = await textureLoader.loadAsync(def.texture.map);
            overrideTex.colorSpace = THREE.SRGBColorSpace;
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
            emissiveTex = await textureLoader.loadAsync(def.texture.emissive);
            emissiveTex.colorSpace = THREE.SRGBColorSpace;
            emissiveTex.flipY = false; // glTF UV convention, same as the model's own maps
          } catch (err) {
            console.warn(`[assets] "${key}" emissive mask ${def.texture.emissive} failed to load — it will fall back to uniform glow.`, err?.message ?? err);
          }
        }
        loadedModels.set(key, prepareModel(picked.unwrap(result), def, clips, overrideTex, key, emissiveTex));
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

function prepareModel(source, def, clips = [], overrideTex = null, label = '', emissiveTex = null) {
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
    const processMaterial = (mat) => {
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
      m2.needsUpdate = true;
      return m2;
    };

    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material) ? o.material.map(processMaterial) : processMaterial(o.material);
    });
  }

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
    inst.userData.animationNames = template.userData.animationNames;
    if (sizeMul) inst.scale.multiplyScalar(sizeMul);
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
    color: new THREE.Color(spec.color ?? 0x000000),
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
      if (look.sizeMultiplier != null && look.sizeMultiplier !== 1) {
        setAssetSizeMultiplier(key, look.sizeMultiplier);
      }
    } catch (err) {
      console.warn(`[assets] could not apply saved look for "${key}" —`, err?.message ?? err);
    }
  }
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
async function loadDeclaredSprites(key, def, textureLoader) {
  const size = spriteSizeFor(key);
  const meshes = [];
  await Promise.all(def.sprites.map(async (url, i) => {
    try {
      const tex = await textureLoader.loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      meshes[i] = makeSpriteMesh(key, tex, size);
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

export function getAssetMaterials(key) {
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
      const g = st.glow ?? 1;
      m.color.set(base);
      m.color.multiplyScalar(g);
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
export { applyNoiseSettings };

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
  materialCache.set(key, mat);
  return mat;
}
