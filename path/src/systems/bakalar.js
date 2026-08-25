import * as THREE from 'three';
import { snapSide } from './facing.js';
import { CONFIG } from '../config.js';
import { createVisual, getAssetMaterials } from '../assets.js';
import { bounds, seabedTopY } from '../arena.js';
import { removeEnemy } from '../entities/enemies.js';
import { player } from '../entities/player.js';
import { bakalarLevelStats, bakalarSailWindow } from '../levelStats.js';
import { advanceCycles } from './beatSync.js';
import { canHold } from './control.js';
import { attachFlag } from './flags.js';
import { emit } from '../entities/particles.js';
import {
  createBakalarNet, updateBakalarNet, setBakalarNetVisible, seatBakalarNet, kickBakalarNet,
} from './bakalarNet.js';

// Bakalar's Boat — a friendly trawler that sails the surface on a timer,
// dragging a net behind it. Anything the net sweeps through is caught, hauled
// up, and gone when the net reaches the hull.
//
// It's the beluga's trap read from the other direction: the bubble comes to
// the fish and holds it where it is, the net comes down from the sky and takes
// it away. That makes this the one ability in the game that removes enemies
// without dealing a point of damage — the reward is the XP orb the haul drops,
// so a boat sailing through a school is a clear AND a payday, and the tension
// is that you don't choose when it sails.
//
// The net is a rectangle hanging under the boat: as wide as the hull (measured
// — see netGeometry) and reaching `netDepth` below the surface. Enemies inside
// it are frozen with `trapTimer` (topped up every frame, so they can't wriggle
// free mid-haul) and their position is driven directly by this system.
//
// WHAT IT WILL AND WON'T TAKE is a curve, not a list: resistance goes as the
// square of a creature's radius against the net's power, so a school is swept
// up on contact, a shark has to be dragged through for a second or more, and
// the biggest bodies in the water are never held at all. See catchAt().

// VOICEMAIL BOMBS — dropped into the loaded net while the boat sails, ON TOP
// of the haul rather than instead of it. The haul is a quiet remover: fish go
// up the net and away, and it never had a moment you could watch coming. The
// bomb is that moment. It falls down the net among whatever is still being
// dragged, sits armed and blinking for a beat, then detonates in a radius far
// wider than the net itself and pays the whole catch out as chum.
//
// Chum rather than XP, deliberately. The haul already pays XP through
// `onHauled`; if the bomb paid XP too the two halves of the same ability would
// be competing to collect the same fish, and the boat would quietly become the
// only upgrade worth taking. Paying in chum feeds the strike meter instead, so
// the bomb pays into a different loop than the net it rides on.
// What CONFIG.bakalar.bomb.size means when it is left alone. It is a RADIUS —
// the primitive sphere this asset shipped as had r 0.72 — and the model that
// replaced it is fitted so its ball comes out the same width (see the `fit`
// note on voicemailBomb in assets.js, which does the ball-versus-wick
// arithmetic). So the slider divides by this and 0.72 is exactly 1x.
//
// It briefly divided by the DIAMETER instead, which is a factor of two and
// looks like a deliberately smaller bomb rather than like a bug.
const BOMB_BASE_RADIUS = 0.72;

const bombs = []; // { mesh, y, targetY, fuse, armed, level }
let bombTimer = 0;

const caught = []; // { enemy, offsetX } — offsetX keeps the catch spread across the net
// Scratch, refilled every frame and handed to the net sim. Module scope, and
// the entries are REUSED rather than replaced: a boat sailing through a school
// runs this every frame of the pass, and a fresh object per fish per frame is
// exactly the shape of garbage that shows up as a hitch a minute later.
const netLoads = [];
let netLoadCount = 0;
function pushNetLoad(x, y, mass) {
  const slot = netLoads[netLoadCount] ?? (netLoads[netLoadCount] = { x: 0, y: 0, mass: 1 });
  slot.x = x; slot.y = y; slot.mass = mass;
  netLoadCount++;
}
let boat = null;
let visual = null;
let spawnTimer = 0;
let sailing = false;
let dir = 1;
let clock = 0;
let netMesh = null;
// The beam bands' position, in cycles. Module scope rather than per-material:
// there is exactly one boat, and the value has to survive the mesh being
// rebuilt when the model is re-uploaded from the T panel.
let bandCycle = 0;

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

// ---------------------------------------------------------------------------
// THE TRACTOR BEAM
//
// This was a flat translucent rectangle: honest about the volume, and it read
// as a pane of glass hanging off the boat. What a beam has that a panel does
// not is FALLOFF — it is brightest on its axis and at its source, and it fades
// to nothing at its edges — and falloff is the thing that makes light look
// like light rather than like a shape.
//
// Three falloffs, all in one fragment shader, all sliders:
//
//   cone     the beam is narrow at the hull and wide at the bottom, so it
//            reads as coming FROM somewhere. Geometry stays a plain quad; the
//            width is a mask, so a net that grows with level costs no rebuild.
//   radial   soft across the beam, raised to `edgeFalloff` — this is the one
//            that decides whether it looks like a searchlight (high) or a slab
//            of colour (low).
//   depth    dimmer the further from the hull, because the water eats it.
//
// Over the top, bands scrolling UP the beam. They are the suction made
// visible: everything the beam is doing to a fish is upward, and without a
// direction cue a static glow reads as a wall rather than as a pull.
//
// ADDITIVE, and that is deliberate. The beam is light being added to the
// water, not a surface covering it, so it brightens whatever is behind it and
// never darkens anything — a fish inside the beam stays legible, which matters
// because the beam is full of fish by design. NoDepthWrite for the same
// reason: it must not occlude the catch it is hauling.
//
// (A backtick anywhere in here — even inside a comment — would end the
// template literal and produce an error pointing at a line of prose. Don't.)
const BEAM_VERT = `
  varying vec2 vBeamUv;
  void main() {
    vBeamUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAG = `
  uniform vec3  uColor;
  uniform float uIntensity;
  uniform float uTopWidth;    // beam width at the hull, as a fraction of the quad
  uniform float uEdgeFalloff; // >1 tightens the beam onto its axis
  uniform float uDepthFalloff;
  // The bands' position in CYCLES, advanced on the CPU so the beam can travel
  // on a musical division instead of at a rate in seconds — see
  // systems/beatSync.js.
  uniform float uBandCycle;
  uniform float uBandCount;
  uniform float uBandAmount;
  uniform float uCoreBoost;
  varying vec2  vBeamUv;

  void main() {
    // v: 0 at the bottom of the net, 1 at the hull. The whole shader is
    // written in "distance from the source" so every falloff below reads the
    // same way round.
    float v = vBeamUv.y;
    float axis = abs(vBeamUv.x - 0.5) * 2.0; // 0 on the axis, 1 at the quad edge

    // CONE. Narrow at the hull, full width at the bottom.
    float halfWidth = mix(1.0, uTopWidth, v);
    float radial = 1.0 - clamp(axis / max(halfWidth, 0.001), 0.0, 1.0);

    // The soft edge. smoothstep rather than the raw ramp so there is no hard
    // line where the cone mask reaches zero.
    float body = pow(smoothstep(0.0, 1.0, radial), uEdgeFalloff);

    // DEPTH. Brightest at the hull; the water eats the rest.
    float depth = pow(v, uDepthFalloff);

    // The bands, travelling UP — the suction made visible. Sped up slightly
    // toward the hull so they appear to accelerate into the boat, which is
    // what the fish inside are actually doing.
    //
    // That acceleration is why only ONE depth is exactly on the beat: the
    // (0.7 + v*0.6) factor scales the phase, so the grid holds where it is 1
    // (v = 0.5, the middle of the beam) and runs 30% fast at the hull. Keeping
    // the taper and syncing its midpoint is the right trade — the alternative
    // is a beam whose bands crawl at a uniform speed, which is the thing the
    // taper was added to fix.
    float bands = sin((v * uBandCount - uBandCycle * (0.7 + v * 0.6)) * 6.28318);
    bands = 1.0 + uBandAmount * bands;

    // A hot core down the axis, on top of the body. Without it the beam is
    // uniformly bright across its width and reads flat.
    float core = pow(body, 3.0) * uCoreBoost;

    float a = body * depth * bands + core * depth;
    // Additive: the alpha channel carries the whole strength, and the colour
    // is pushed past 1 so the bright pass in post.js blooms it.
    gl_FragColor = vec4(uColor * uIntensity * max(a, 0.0), max(a, 0.0));
  }
`;

function makeBeamMaterial() {
  const b = CONFIG.bakalar.beam;
  return new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(CONFIG.bakalar.netColor) },
      uIntensity: { value: b.intensity },
      uTopWidth: { value: b.topWidth },
      uEdgeFalloff: { value: b.edgeFalloff },
      uDepthFalloff: { value: b.depthFalloff },
      uBandCycle: { value: 0 },
      uBandCount: { value: b.bandCount },
      uBandAmount: { value: b.bandAmount },
      uCoreBoost: { value: b.coreBoost },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// Push the live config at the beam every frame, so the tuner sliders move a
// beam that is already sailing rather than only the next one.
function applyBeamSettings() {
  const b = CONFIG.bakalar.beam;
  const u = netMesh?.material?.uniforms;
  if (!u) return;
  u.uColor.value.set(CONFIG.bakalar.netColor);
  u.uIntensity.value = b.intensity;
  u.uTopWidth.value = b.topWidth;
  u.uEdgeFalloff.value = b.edgeFalloff;
  u.uDepthFalloff.value = b.depthFalloff;
  // uBandCycle is a POSITION, owned by the update below — not written here.
  u.uBandCount.value = b.bandCount;
  u.uBandAmount.value = b.bandAmount;
  u.uCoreBoost.value = b.coreBoost;
}

/**
 * How hard the beam pulls at a point, 0..1 — and the single source of truth
 * for it, because the LOOK and the PULL have to agree. The shader's falloff
 * and this function are the same two curves (across the cone, and down from
 * the hull); if they drifted apart, fish would be dragged hardest through the
 * dim parts of the beam, which is the kind of thing that reads as broken
 * without anyone being able to say why.
 *
 * @param dx    horizontal distance from the beam axis
 * @param depth how far below the hull, in world units
 * @param halfWidth the beam's half-width at the BOTTOM (the cone's wide end)
 * @param netDepth  the beam's full length
 */
export function suctionAt(dx, depth, halfWidth, netDepth) {
  const s = CONFIG.bakalar.suction;
  const v = 1 - Math.min(1, Math.max(0, depth / Math.max(1e-4, netDepth))); // 1 at the hull
  // Same cone the shader draws: narrow at the hull, wide at the bottom.
  const coneHalf = halfWidth * (1 - (1 - CONFIG.bakalar.beam.topWidth) * v);
  const radial = 1 - Math.min(1, Math.abs(dx) / Math.max(1e-4, coneHalf));
  if (radial <= 0) return 0;
  return Math.pow(radial, s.edgeFalloff) * Math.pow(v, s.depthFalloff) * s.strength;
}

// HOW WIDE THE HULL ACTUALLY IS, measured off the built visual.
//
// The net used to be `netWidth` world units with `netWidthPerLevel` added on
// top, and by eight stacks that was a 16.8-unit mouth hanging off a 9-unit
// boat — a net wider than the thing towing it, which reads as the trawler
// dragging a wall. The net is now the hull's own width and grows DOWNWARD
// only: a deeper net is a bigger net you can still believe.
//
// Measured, not typed, for the reason whale.js gives about its own body:
// `fit` scales a grandchild of what createVisual hands back and the T-panel
// size multiplier scales the root, so no single number in the asset entry is
// the boat's world width. A hand-written 9 would go stale the first time
// anyone dragged the size slider — and the failure is a net that is quietly
// the wrong width, which looks like a tuning choice.
let hullWidth = 0;

function buildBoat() {
  const root = new THREE.Group();
  visual = createVisual('bakalarBoat');
  root.add(visual);
  // Before any rotation or placement: createVisual has already applied the
  // orientation, so the visual's local box is the hull as it will be seen, and
  // its X extent is the beam-on width the net has to fit inside.
  _hullBox.setFromObject(visual);
  _hullBox.getSize(_hullSize);
  hullWidth = _hullSize.x;
  // AFTER the measurement above, and that ordering is the whole of it: the net
  // is the hull's own width, and a flag streaming aft of the mast is width the
  // hull does not have. Hoisted first, every stack of this ability would tow a
  // net a flag wider than the boat and nothing would say why.
  //
  // No cleanup path: the boat is a singleton that lives for the session, and
  // rebuildBakalarBoat throws the whole visual away and calls this again.
  attachFlag(visual, 'bakalarBoat');
  return root;
}
const _hullBox = new THREE.Box3();
const _hullSize = new THREE.Vector3();

export function createBakalarBoat(scene) {
  boat = buildBoat();
  boat.visible = false;
  scene.add(boat);

  // The beam. Still one quad — the shape is all in the fragment shader, which
  // is what lets the cone, the falloff and the scrolling bands be sliders
  // rather than geometry that has to be rebuilt whenever the net grows.
  //
  // See CONFIG.bakalar.beam for what each control does and why the beam
  // replaced the flat panel it used to be.
  netMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeBeamMaterial());
  netMesh.position.z = -0.15;
  netMesh.visible = false;
  scene.add(netMesh);

  // ...and the twine hanging in it. The beam is the suction drawn; the net is
  // the physical thing the catch is inside, and the only part of the ability
  // anything can push back on. See systems/bakalarNet.js.
  createBakalarNet(scene);

  return boat;
}

// Singleton, same as the beluga drone — a model uploaded from the T panel
// wouldn't appear until a reload without an explicit swap.
export function rebuildBakalarBoat(scene) {
  if (!boat) return;
  const { position, visible } = boat;
  scene.remove(boat);
  boat = buildBoat();
  boat.position.copy(position);
  boat.visible = visible;
  scene.add(boat);
}

export function resetBakalar(scene = null) {
  // Anything still in the net when a run ends is simply released — the enemy
  // array is about to be cleared by resetEnemies anyway, so removing them here
  // would just be fighting over the same indices.
  caught.length = 0;
  sailing = false;
  clock = 0;
  bombTimer = 0;
  // Bombs DO have to be cleaned up: unlike the catch, they own meshes this
  // module put in the scene, and nothing else will take them out.
  // ...and their flames with them: the flame is a child of the bomb so removing
  // the bomb hides it, but its material is per bomb (own flicker phase) and
  // nothing else frees it.
  for (const b of bombs) { b.flame?.material.dispose(); b.mesh.parent?.remove(b.mesh); }
  bombs.length = 0;
  if (boat) boat.visible = false;
  if (netMesh) netMesh.visible = false;
  setBakalarNetVisible(false);
  blinkOn = false; blinkAny = false;
  paintArmedBombs();
  spawnTimer = randomBetween(CONFIG.bakalar.spawnMin, CONFIG.bakalar.spawnMax);
}

/**
 * What one voicemail bomb hits for at this level, Big Rigz included.
 *
 * Exported because the perfect strike's companion stack
 * (systems/companionStrike.js) has to ask what the boat lends WITHOUT a boat,
 * a net or a bomb in the water — and because bombStats() below cannot be the
 * answer: it also rolls a radius through aoe(), and a caller that only wants
 * the number should not be made to build the rest.
 */
export function bombDamage(level) {
  // THE FORMULA LIVES IN levelStats.js NOW, and this reads it rather than
  // keeping a second copy. The hover tips have to answer "what does one more
  // level buy" in real numbers, and a readout that merely AGREED with this
  // function would stop agreeing the first time either was retuned — silently,
  // because nothing compares them. One implementation is the only version of
  // that promise that survives.
  return bakalarLevelStats(level, player.stats).bakalarBombDamage;
}

// ---------------------------------------------------------------------------
// WHAT THE NET CAN TAKE
//
// It used to take everything that was not a boss. That is the right rule for a
// mechanic whose whole job is clearing schools, and the wrong one the moment
// you watch a megalodon get hauled out of the water by a fishing boat.
//
// So the net has POWER and a creature has RESISTANCE, and resistance goes as
// the SQUARE of its radius. Squared rather than linear because this is a 2D
// playfield: area is the honest stand-in for mass here, and it is the same
// weighting entities/enemies.js already uses to resolve a collision between
// two bodies. Linear would make a shark three times a sardine; squared makes
// it eight, which is the difference between "the net favours small fish" and
// "the net is FOR small fish".
//
// The result is a curve rather than a list. At one stack a school is swept up
// on contact, a dolphin usually goes, a shark has to be dragged through the
// whole mouth and mostly gets away; at eight the boat takes sharks reliably.
// Nothing is hard-coded per species and nothing needs revisiting when a new
// creature is added — it inherits its place from how big it is.
//
// TWO HARD REFUSALS SIT ABOVE THE CURVE, because neither is a question of
// degree:
//
//   SCENERY. The sea turtle is `invincible` — the game has declared it cannot
//   be killed. The haul is the one mechanic in the game that removes a
//   creature WITHOUT dealing damage, so it is also the one thing that could
//   quietly delete an unkillable animal. Refused by the flag rather than by
//   name, so anything else marked scenery is covered on the day it lands.
//
//   ANYTHING WHALE-SIZED. `maxPrey` is an absolute ceiling in world units. The
//   bowhead is not an enemy today (systems/whale.js owns its own list, and
//   `enemiesList` never contains one), so this cannot fire on it yet — which
//   is exactly why it is written as a size rule and not as a name check. A
//   sweep creature that ever becomes an ordinary spawn should not need anyone
//   to remember this file exists.
//
// (`canHold` still refuses every boss above all of it — see systems/control.js
// for why that one is a flat no rather than a big number.)

/** The net's power at this stack. */
function netPower(level) {
  return bakalarLevelStats(level, player.stats).bakalarGrip;
}

/**
 * How hard this creature is to ensnare, as a multiple of the calibration fish.
 * 1 at `refPrey`, and rising with the square of the radius from there.
 */
function netResistance(e) {
  const c = CONFIG.bakalar.catch;
  const r = Math.max(0.01, e.radius ?? 1);
  return Math.pow(r / Math.max(0.01, c.refPrey), c.massExponent);
}

/**
 * Can the net EVER hold this creature — before any question of how long?
 *
 * Split from the grip below so the answer is available without a net in the
 * water: the smoke harness asks it directly, and a refusal here is a fact
 * about the animal rather than about this pass.
 */
/**
 * How long this creature has to be held in the mouth before it is ensnared, at
 * this stack. Infinity if the net will never take it at all.
 *
 * The mechanic itself, as one pure function — exported so the harness can
 * assert the CURVE rather than infer it from a stopwatch. Timing a haul
 * end-to-end measures the spawn wait (14-22 seconds of it, rolled at random)
 * plus the sweep up to the hull, and both of those dwarf the grip: the first
 * version of that test read 21s against 17s for fish half a size apart and
 * called the curve inverted.
 */
export function ensnareSeconds(e, level) {
  if (!netAccepts(e)) return Infinity;
  return CONFIG.bakalar.catch.grip * netResistance(e) / netPower(level);
}

export function netAccepts(e) {
  if (!canHold(e)) return false;          // bosses — systems/control.js
  if (e.invincible) return false;         // scenery; see the note above
  return (e.radius ?? 1) <= CONFIG.bakalar.catch.maxPrey;
}

function bombStats(level) {
  // Splash Zone widens the BLAST and Big Rigz makes it hit harder — but neither
  // touches the net (its mouth or its depth). The net is how the boat works;
  // the bomb is the moment you watch. Widening the net as well would quietly
  // turn one card into a second Bakalar upgrade. Both multipliers are applied
  // inside levelStats.js, against the block passed to it.
  const st = bakalarLevelStats(level, player.stats);
  return {
    interval: st.bakalarBombGap,
    radius: st.bakalarBlast,
    damage: st.bakalarBombDamage,
  };
}

// WHERE THE CATCH IS, as one point — the thing the bomb is aimed at.
//
// Weighted by radius squared, which on a 2D playfield is area and therefore
// mass (the same weighting entities/enemies.js uses to resolve a collision).
// A plain mean would let six sardines outvote the shark, and the shark is what
// the player is watching.
//
// Null when the net is empty, which is a real answer and not a failure: the
// bomb then falls to the middle of the net the way it always did.
function bundleCentre() {
  let wx = 0;
  let wy = 0;
  let total = 0;
  for (const h of caught) {
    const r = h.enemy.radius ?? 1;
    const m = r * r;
    wx += h.enemy.mesh.position.x * m;
    wy += h.enemy.mesh.position.y * m;
    total += m;
  }
  return total > 0 ? { x: wx / total, y: wy / total } : null;
}

function dropBomb(scene, x, netTop, netBottom, level) {
  const c = CONFIG.bakalar.bomb;
  const mesh = createVisual('voicemailBomb');
  mesh.position.set(x, bounds.surfaceY, -0.1);
  // multiplyScalar, not setScalar — see the note in systems/beluga.js. This
  // preserves the per-asset Size multiplier createVisual just applied.
  //
  // 1x at the authored size; see BOMB_BASE_RADIUS.
  mesh.scale.multiplyScalar(c.size / BOMB_BASE_RADIUS);
  scene.add(mesh);

  bombs.push({
    mesh,
    // THE BOMB SAILS WITH THE BOAT. It was dropped from a moving hull into a
    // moving net, so it inherits the hull's velocity and keeps pace with the
    // catch. Without this it hung in the water where it was released while the
    // net sailed on at 7 units/sec — by the time the ~1.9s of fall and fuse
    // had run, the fish it was meant to blow up were thirteen units downrange
    // and the blast reliably hit nothing at all.
    vx: dir * CONFIG.bakalar.speed,
    // IT FALLS AT THE BUNDLE, and re-aims every frame while it is falling.
    //
    // This was a fixed depth — the middle of the net — with a comment
    // explaining that the floor was wrong because the catch is hauled upward
    // while the bomb falls downward and the two pass each other. The middle is
    // the same bug with a smaller error bar: it is right only for a net whose
    // catch happens to be halfway up at that moment, and the whole point of
    // the bomb is that it goes off IN the fish.
    //
    // Re-aimed rather than led: the haul rate depends on where each fish sits
    // in the beam (see suctionAt), so predicting where the bundle will be is
    // predicting a curve the player can change by getting in the way.
    //
    // Seeded here so a bomb dropped into an empty net still has a target, and
    // clamped into the net by the caller of the update below.
    targetY: bundleCentre()?.y ?? (netTop + netBottom) * 0.5,
    netTop,
    netBottom,
    fuse: c.fuse,
    armed: false,
    // THE WICK, as a countdown rather than a decoration.
    //
    // `burn` runs 0 (lit at the tip) to 1 (reached the powder), scheduled
    // across the bomb's whole REMAINING life — the fall plus the fuse — so the
    // flame arrives at the ball on the frame it detonates. A fuse that burns
    // at its own rate is a light on a stick: it tells you nothing about when,
    // and the player learns to ignore it.
    //
    // `wickSpan` is that life at the moment of the drop, and `burn` is kept
    // monotonic against it below — the target moves while the bomb falls, so
    // the remaining time can grow, and a fuse that un-burns is worse than one
    // that runs slightly early.
    burn: 0,
    wickSpan: Math.max(0.1, (bounds.surfaceY - (bundleCentre()?.y ?? (netTop + netBottom) * 0.5)) / Math.max(0.1, c.fallSpeed) + c.fuse),
    sparkTimer: 0,
    flame: null,
    level,
  });
}

// ---------------------------------------------------------------------------
// THE BURNING WICK
//
// The bomb model carries its fuse as a polyline: tools/optimize-bomb.mjs
// measures the wick's centreline out of the mesh and bakes it into the file,
// assets.js converts it into the model's own space on load (see wickPath in
// prepareModel), and createVisual hands each clone the same array. There is no
// bone, no node and no locator in the source — a fuse is not something a
// modeller rigs — so a measured path is the only thing that can be trusted to
// still point at the wick after the model is re-exported or re-decimated.
//
// The flame is a CHILD of the bomb. That is the whole reason it costs nothing:
// the bomb bobs, sails with the hull, scales with the size slider and is
// oriented by the def's forward/up, and a child at a local coordinate inherits
// every one of those for free. Parented, not tracked — see the note in
// systems/eyeLights.js about a light that follows a bone by copying its world
// position and lags it by exactly one frame.

// One geometry for every flame ever. The MATERIAL is per bomb, because each
// one flickers on its own phase and a shared material would make two bombs
// gutter in lockstep — the same trap as fading one bubble and fading them all
// (see the note on primitive assets in assets.js).
let flameGeometry = null;

function makeFlame(bomb) {
  const w = CONFIG.bakalar.bomb.wick;
  const path = bomb.mesh.userData?.wickPath;
  if (!w?.enabled || !Array.isArray(path) || path.length < 2) return null;
  flameGeometry ??= new THREE.SphereGeometry(1, 8, 6);
  const mesh = new THREE.Mesh(flameGeometry, new THREE.MeshBasicMaterial({
    color: new THREE.Color(w.flameColor),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  mesh.renderOrder = 10;
  // Its own flicker phase, so two bombs in the water are two fires.
  mesh.userData.phase = Math.random() * Math.PI * 2;
  bomb.mesh.add(mesh);
  return mesh;
}

// Where the flame sits, in the bomb's LOCAL space, at burn 0..1.
//
// The path runs root -> tip (that is the order the optimizer measures it in,
// and the direction it is documented as), so a fuse burning DOWN walks it
// backwards: burn 0 is the last point, burn 1 the first. Getting this
// backwards produces a flame that starts at the powder and travels out to the
// tip, which looks like the bomb is charging up rather than counting down —
// and reads as perfectly intentional to anyone who has not seen the other one.
const _flameLocal = new THREE.Vector3();
function flameAt(path, burn) {
  const t = (1 - Math.min(1, Math.max(0, burn))) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(t));
  const f = t - i;
  const a = path[i];
  const b = path[i + 1];
  return _flameLocal.set(
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  );
}

const _flameWorld = new THREE.Vector3();
function updateWick(bomb, dt) {
  const c = CONFIG.bakalar.bomb;
  const w = c.wick;
  const path = bomb.mesh.userData?.wickPath;
  if (!w?.enabled || !Array.isArray(path) || path.length < 2) return;

  bomb.flame ??= makeFlame(bomb);
  if (!bomb.flame) return;

  // MONOTONIC, against the life the wick was cut to. The bomb re-aims at the
  // catch every frame while it falls and the catch is being hauled UP, so the
  // remaining time can grow — and a fuse that visibly un-burns is worse than
  // one that runs a little early.
  const remain = bomb.armed
    ? Math.max(0, bomb.fuse)
    : (bomb.mesh.position.y - bomb.targetY) / Math.max(0.1, c.fallSpeed) + Math.max(0, bomb.fuse);
  bomb.burn = Math.min(1, Math.max(bomb.burn, 1 - remain / bomb.wickSpan));

  const p = flameAt(path, bomb.burn);
  bomb.flame.position.copy(p);

  // Gutter. Scale and colour together, because a flame that only changes size
  // reads as a pulsing ball and one that only changes colour reads as a lamp
  // on a dimmer.
  const phase = Math.sin(clock * w.flicker + bomb.flame.userData.phase);
  const lick = 1 + phase * w.flickerAmount;
  // The flame is a child of the bomb, so it is already in the bomb's scaled
  // space — flameSize is in the AUTHORED bomb's units and needs no correction
  // for the size slider. It does need the local space's own scale undone,
  // which the parent applies for us; nothing to do here beyond the radius.
  bomb.flame.scale.setScalar(Math.max(0.01, w.flameSize * lick));
  bomb.flame.material.color.set(w.flameColor)
    .lerp(_hotColor.set(w.flameHot), Math.max(0, phase))
    .multiplyScalar(w.flameGlow);

  // EMBERS, on a timer rather than per frame, so the shower is the same
  // density at 30fps and at 144. World space: the particle system is not in
  // the bomb's hierarchy.
  bomb.sparkTimer -= dt;
  if (bomb.sparkTimer <= 0) {
    bomb.sparkTimer = Math.max(0.01, w.emitEvery);
    bomb.mesh.localToWorld(_flameWorld.copy(p));
    emit('bombWick', _flameWorld.x, _flameWorld.y);
  }
}
const _hotColor = new THREE.Color();

// THE ARMING BLINK, across whatever the bomb currently IS.
//
// This used to write b.mesh.material.color, which worked exactly as long as
// the bomb stayed the procedural sphere it shipped as: createVisual returns a
// Mesh for a primitive and a GROUP for an uploaded model, and a Group has no
// `.material`. The guard on that line meant an uploaded toon bomb simply
// stopped blinking — no error, no warning, and the one tell that says the
// thing is about to go off silently gone.
//
// Written through getAssetMaterials so both cases land, and per ASSET rather
// than per bomb, because every clone shares the template's materials anyway
// (see the same note in systems/emissivePulse.js) — two armed bombs blink in
// unison, which is what a shared material can express and is the right read
// for two of the same object on the same fuse.
//
// The resting colour is captured the first time it is touched and put back the
// frame nothing is armed. Without the restore the bomb keeps whatever half of
// the blink it died on, and every bomb dropped afterwards inherits it.
// material -> what it looked like before any blink. Two fields because the
// blink writes a different one depending on what the bomb IS; see below.
const bombRest = new Map();
let blinkOn = false;
let blinkAny = false;

function paintArmedBombs() {
  const c = CONFIG.bakalar.bomb;
  for (const m of getAssetMaterials('voicemailBomb')) {
    if (!m?.color) continue;
    if (!bombRest.has(m)) {
      bombRest.set(m, { color: m.color.clone(), ei: m.emissiveIntensity ?? null });
    }
    const rest = bombRest.get(m);

    // LIT MODEL: blink the GLOW, not the paint. Writing `color` on a textured
    // MeshStandardMaterial multiplies the map, so the off-beat repaints the
    // bomb's own art half as dark and the on-beat tints the rope orange — a
    // bomb changing colour rather than a bomb flashing. The model already
    // carries emissiveFromMap (see its def), so pushing emissiveIntensity
    // lights it up wearing its own paint and drops it back to nothing, which
    // is what a warning light does.
    if (rest.ei != null) {
      m.emissiveIntensity = blinkAny && blinkOn ? c.blinkGlow : rest.ei;
      continue;
    }

    // UNLIT FALLBACK: the procedural sphere has no emissive at all, and its
    // glow is colour magnitude (see the note on unlit materials in assets.js),
    // so the colour write is the only channel there is.
    if (blinkAny) m.color.set(blinkOn ? c.color : 0x2a2118);
    else m.color.copy(rest.color);
  }
}

// hooks: { onEnemyDamaged, onEnemyKilled, onBombBlast(x, y, radius), onChum(x, y) }
function updateBombs(dt, scene, enemiesList, hooks) {
  const c = CONFIG.bakalar.bomb;
  blinkOn = false;
  blinkAny = false;

  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    const s = bombStats(b.level);

    // Keeps pace with the net for its whole life, armed or not — the fuse
    // burns while it is still travelling with the catch.
    b.mesh.position.x += b.vx * dt;

    if (!b.armed) {
      // RE-AIMED AT THE BUNDLE, every frame it is still falling. The catch is
      // hauled upward the whole time the bomb falls downward, so a target
      // fixed at drop time is a target the fish have left. Clamped inside the
      // net the bomb was dropped into: a bundle that has already reached the
      // hull would otherwise pull the bomb back up out of the water.
      const bundle = bundleCentre();
      if (bundle) {
        b.targetY = Math.min(b.netTop - 0.4, Math.max(b.netBottom, bundle.y));
      }
      b.mesh.position.y -= c.fallSpeed * dt;
      // Armed when it MEETS the bundle, from either direction — the fish are
      // rising into it as often as it is falling onto them, and a test that
      // only fires on the way down leaves a bomb hanging above a catch that
      // has already passed it.
      if (b.mesh.position.y <= b.targetY) {
        b.mesh.position.y = b.targetY;
        b.armed = true;
      }
    } else {
      b.fuse -= dt;
      // Blink faster as the fuse runs out — the tell that says "now".
      const urgency = 1 + (1 - Math.max(0, b.fuse) / Math.max(1e-3, c.fuse)) * 2;
      blinkOn ||= Math.sin(clock * c.blinkSpeed * urgency) > 0;
      blinkAny = true;
    }

    // After the fall and the fuse, so the flame is scheduled against the time
    // that is actually left rather than against last frame's.
    updateWick(b, dt);

    if (!b.armed || b.fuse > 0) continue;

    // --- detonate ---------------------------------------------------------
    const x = b.mesh.position.x;
    const y = b.mesh.position.y;
    const r2 = s.radius * s.radius;
    let kills = 0;

    hooks.onBombBlast?.(x, y, s.radius);
    // ...and the wick goes with it. The flame is a child of the bomb mesh, so
    // scene.remove below takes it off screen — but the material is per bomb
    // (each flickers on its own phase) and nothing else will ever free it.
    b.flame?.material.dispose();
    // The net is what the bomb went off INSIDE. Its own radius, not the
    // blast's: the shockwave reaches across the arena and the twine only has
    // the net's width to move in, so feeding it s.radius punched every node at
    // once and the mesh simply jumped sideways instead of holing.
    kickBakalarNet(x, y, CONFIG.bakalar.net.blastKick, s.radius * 0.5);

    for (let j = enemiesList.length - 1; j >= 0; j--) {
      const e = enemiesList[j];
      const dx = e.mesh.position.x - x;
      const dy = e.mesh.position.y - y;
      if (dx * dx + dy * dy > r2) continue;

      e.hp -= s.damage;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;

      const len = Math.hypot(dx, dy) || 1e-4;
      e.vx += (dx / len) * c.knockback;
      e.vy += (dy / len) * c.knockback;

      hooks.onEnemyDamaged?.(e, s.damage, e.mesh.position.x, e.mesh.position.y);
      if (e.hp <= 0) {
        kills++;
        // Freed from the net first: the haul list holds a reference, and a
        // hauler still dragging a creature that has just been removed would
        // spend the rest of the sailing pulling on nothing.
        const held = caught.findIndex((h) => h.enemy === e);
        if (held >= 0) caught.splice(held, 1);
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, j);
      }
    }

    // Chum for the catch, plus a flat scatter so a bomb that hits nothing
    // still reads as worth having watched.
    const payout = c.chumScatter + kills * c.chumPerKill;
    for (let n = 0; n < payout; n++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * c.chumSpread;
      hooks.onChum?.(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }

    // AND THE REST OF THE CATCH GOES EVERYWHERE. The spray above is the
    // blast's own — a circle of guts where the net was, which is chum you were
    // already swimming toward. This is a netful of fish going up at the
    // surface and coming down across the whole arena, and it is deliberately
    // NOT a wider `chumSpread`: what it buys is a reason to be somewhere else.
    // The floor gets re-seeded with food, the strike meter is the thing that
    // food feeds, and a boat sailing the top of the screen therefore matters
    // to a player who was nowhere near it.
    //
    // Placed with the arena's own bounds rather than by flinging further from
    // the blast, because "further" from a bomb dropped at the left wall is
    // mostly off-screen. Every bit lands somewhere reachable.
    const wide = Math.round((c.arenaChum ?? 0) + kills * (c.arenaChumPerKill ?? 0));
    for (let n = 0; n < wide; n++) {
      hooks.onChum?.(
        bounds.left + Math.random() * (bounds.right - bounds.left),
        bounds.bottom + Math.random() * (bounds.surfaceY - bounds.bottom),
      );
    }

    scene.remove(b.mesh);
    bombs.splice(i, 1);
  }

  // After the loop, so a bomb that detonated this frame has already been
  // removed and cannot leave the shared material stuck mid-blink.
  paintArmedBombs();
}

/**
 * The net's mouth and reach at this level.
 *
 * WIDTH IS THE HULL'S and does not move with the stack. A trawler drags a net
 * it can physically hold, and a mouth wider than the boat above it reads as a
 * wall being towed rather than as a net being dragged — so levelling makes the
 * net DEEPER, which is the axis where more is still believable and where the
 * extra volume actually meets fish (the water below the boat is where they
 * are; the water beside it is where the boat already is).
 *
 * `netWidthFraction` is a trim on the measured hull, not a size: at 1 the net
 * spans the hull exactly, and below it the mouth sits inside the gunwales.
 *
 * Exported because tools/ability-smoke.mjs has to place a fish at the rim of
 * the net and cannot re-derive it — the width comes from a MEASUREMENT of the
 * built boat, so the harness's answer and the game's would differ by whatever
 * the procedural fallback's box is.
 */
export function netGeometry(level) {
  const c = CONFIG.bakalar;
  // CLAMPED AT THE SEABED, because depth is the growth axis now and an
  // unbounded one runs out of ocean: the water column is 40 units and a maxed
  // stack asks for nearly 35 of it, so a single retune of `netDepthPerLevel`
  // puts the foot of the net through the floor. Twine drawn inside the seabed
  // is a bug at any tuning, and the fish are not down there either.
  //
  // Against the seabed's TOP rather than bounds.bottom: the floor has visible
  // height (SEABED_HEIGHT) and the net should stop on it, not in it.
  const room = Math.max(2, bounds.surfaceY - seabedTopY() - (c.netFloorGap ?? 0));
  return {
    // NOT LEVELLED, and this is the line that made a hand-typed desc wrong: the
    // net's mouth is a fraction of the HULL, so it is the same width at stack
    // one and stack eight. Only the depth grows. The card said "+net size" for
    // a long time on the strength of the half that does.
    halfWidth: Math.max(0.5, hullWidth * (c.netWidthFraction ?? 1)) * 0.5,
    // `room` is handed over so the clamp stays here, where the arena is
    // knowable — levelStats.js is a leaf and cannot see the seabed.
    depth: bakalarLevelStats(level, player.stats, room).bakalarNetDepth,
  };
}

function launch(level) {
  const c = CONFIG.bakalar;
  sailing = true;
  // Reset per sailing rather than running free: the first bomb should land
  // partway through a pass with a net that has had time to fill, not on the
  // frame the boat appears with an empty one.
  bombTimer = bombStats(level).interval;
  dir = Math.random() < 0.5 ? 1 : -1;
  const { halfWidth, depth } = netGeometry(level);
  // Start far enough out that the whole net is offscreen, so fish don't
  // materialise mid-haul at the arena edge.
  const margin = halfWidth + c.hullRadius + 2;
  boat.position.set(dir > 0 ? bounds.left - margin : bounds.right + margin, bounds.surfaceY, 0);
  // Hull is modelled along +X, same convention as systems/boats.js.
  // Snapped: this is an ARRIVAL, from off-screen, with a heading already —
  // see systems/facing.js and the same note in systems/boats.js.
  snapSide(boat, dir);
  boat.visible = true;
  netMesh.visible = true;
  // Seat the twine on the frame the boat appears, not on the first update:
  // otherwise the net unfolds out of wherever the last sailing abandoned it,
  // which for a boat entering from the opposite side is a lattice stretched
  // across the whole arena for one visible frame.
  const netTop = boat.position.y;
  setBakalarNetVisible(CONFIG.bakalar.net.enabled);
  seatBakalarNet(boat.position.x - dir * c.netTrail, netTop, halfWidth, depth);
}

// Release everything without collecting it — used when the boat leaves with
// fish still being hauled, so nothing is left frozen forever offscreen.
function releaseAll() {
  for (const c of caught) c.enemy.trapTimer = 0;
  caught.length = 0;
}

// hooks: { onHauled(enemy) } — called just before the enemy is removed, so the
// caller can run its normal kill handling (score, XP orb) on it.
export function updateBakalar(dt, scene, level, enemiesList, hooks = {}) {
  if (!boat) return;

  const active = level > 0 && CONFIG.bakalar.enabled;
  if (!active) {
    if (sailing) { releaseAll(); sailing = false; boat.visible = false; netMesh.visible = false; setBakalarNetVisible(false); }
    for (const b of bombs) { b.flame?.material.dispose(); scene.remove(b.mesh); }
    bombs.length = 0;
    // Nothing is armed any more, and the blink writes a SHARED material — left
    // unpainted it would keep whatever half of the flash the last bomb died on
    // for the rest of the run.
    blinkOn = false; blinkAny = false;
    paintArmedBombs();
    return;
  }

  const c = CONFIG.bakalar;
  clock += dt;

  // Bombs are updated BEFORE the sailing check, and outside it: one dropped on
  // the boat's last frame in the arena still has to fall, arm and go off. Tying
  // them to `sailing` would make a late drop vanish silently, which looks
  // exactly like a bug from the seabed.
  if (c.bomb?.enabled) updateBombs(dt, scene, enemiesList, hooks);

  if (!sailing) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      // More levels = the boat comes around more often. Clamped so a maxed
      // stack still leaves gaps you have to fight through on your own.
      const { min, max } = bakalarSailWindow(level);
      spawnTimer = randomBetween(min, max);
      launch(level);
    }
    return;
  }

  const { halfWidth, depth } = netGeometry(level);

  boat.position.x += dir * c.speed * dt;
  boat.position.y = bounds.surfaceY + Math.sin(clock * c.bobSpeed) * c.bobAmount;
  boat.rotation.z = Math.sin(clock * c.bobSpeed * 0.7) * 0.06;

  // The net hangs straight down from the hull, trailing slightly behind it so
  // it looks dragged rather than carried.
  const netCenterX = boat.position.x - dir * c.netTrail;
  const netTop = boat.position.y;
  const netBottom = netTop - depth;
  netMesh.position.set(netCenterX, (netTop + netBottom) * 0.5, -0.15);
  netMesh.scale.set(halfWidth * 2, depth, 1);
  // `bandSpeed` is already in cycles per second (the shader multiplies the
  // whole term by 2π), so it needs no conversion. Wrap 1: one sin() reads it.
  bandCycle = advanceCycles(bandCycle, c.beam.bandSync, c.beam.bandSpeed, dt, 1);
  netMesh.material.uniforms.uBandCycle.value = bandCycle;
  applyBeamSettings();

  // --- catch: anything inside the net volume that isn't already held --------
  const power = netPower(level);
  const cc = CONFIG.bakalar.catch;
  for (const e of enemiesList) {
    if (caught.some((h) => h.enemy === e)) continue;
    // Bosses, scenery and anything whale-sized. Refused at the CATCH rather
    // than at the haul below, because one of them sitting in `caught` would be
    // dragged toward the surface with its steering intact — a worse picture
    // than not catching it, and one where the net visibly holds something that
    // is plainly not held. See netAccepts.
    if (!netAccepts(e)) continue;
    const ex = e.mesh.position.x;
    const ey = e.mesh.position.y;
    if (Math.abs(ex - netCenterX) > halfWidth + e.radius) continue;
    if (ey > netTop + e.radius || ey < netBottom - e.radius) continue;

    // IN THE NET IS NOT CAUGHT. Grip accumulates while the creature is inside
    // the mouth, at the net's power over its own resistance — so a sardine is
    // taken on the frame it touches the twine and a shark has to be dragged
    // through the whole sweep, which it usually out-swims.
    //
    // Timestamped rather than decayed. The alternative is bleeding grip off
    // every enemy in the water every frame to catch the ones that got away,
    // which is a whole-list pass to maintain a number that only matters to
    // whatever is standing in a 9-unit rectangle. A creature that has been out
    // of the net longer than `gripReset` simply starts again.
    if (clock - (e.netGripAt ?? -Infinity) > cc.gripReset) e.netGrip = 0;
    e.netGripAt = clock;
    e.netGrip = (e.netGrip ?? 0) + (power / netResistance(e)) * dt / Math.max(0.01, cc.grip);
    if (e.netGrip < 1) continue;

    caught.push({ enemy: e, offsetX: ex - netCenterX });
    // A jolt where it went in. The pocket the creature makes is a steady
    // force (see the loads below) and steady forces have no MOMENT — without
    // this the mesh eases open around a fish that arrived at full speed.
    kickBakalarNet(ex, ey, CONFIG.bakalar.net.catchKick * (e.radius ?? 1), (e.radius ?? 1) * 3);
  }

  // --- drop a voicemail bomb into the loaded net ----------------------------
  // Gated on the net actually holding something (`minCatch`), so a boat
  // sailing through empty water doesn't litter the arena with bombs. The
  // timer only runs while sailing — the interval describes drops per
  // sailing, not per run.
  if (c.bomb?.enabled) {
    bombTimer -= dt;
    if (bombTimer <= 0 && caught.length >= c.bomb.minCatch) {
      bombTimer = bombStats(level).interval;
      // Dropped at the net's centre so it falls THROUGH the catch, rather than
      // at the hull where it would detonate above everything being hauled.
      dropBomb(scene, netCenterX, netTop, netBottom, level);
      hooks.onBombDrop?.(netCenterX, netTop);
    }
  }

  // --- haul: drag every catch up toward the hull ----------------------------
  for (let i = caught.length - 1; i >= 0; i--) {
    const h = caught[i];
    const e = h.enemy;

    // The enemy may have been killed by something else mid-haul; enemiesList is
    // the authority on what still exists.
    if (!enemiesList.includes(e)) {
      caught.splice(i, 1);
      continue;
    }

    // Topped up rather than set once: enemies.js decrements it every frame, so
    // a long haul would otherwise let the fish start swimming again halfway up.
    e.trapTimer = Math.max(e.trapTimer, 0.5);

    // THE SUCTION, and its falloff. This used to be a constant `haulSpeed`
    // with the catch pinned to a fixed offset — every fish rose at the same
    // rate wherever it sat, which is a conveyor belt, not a pull. Now the
    // strength comes from suctionAt(), the same two curves the beam is drawn
    // with, so a fish out at the dim edge is dragged slowly and one on the hot
    // axis is dragged fast, and what you see is what is happening.
    const belowHull = netTop - e.mesh.position.y;
    // The floor is applied ONCE, here, and both halves of the pull read the
    // result. A fish out past the cone edge gets a suction of exactly 0, and
    // without the floor reaching the inward draw as well it would never
    // converge — it would ride straight up the outside of the beam on the
    // minimum rise and never enter it. The falloff is meant to make the haul
    // uneven, not to strand anything outside the light.
    const pull = Math.max(
      c.suction.minPull,
      suctionAt(h.offsetX, belowHull, halfWidth, depth),
    );

    // Drawn IN toward the axis as well as up — the horizontal half of the
    // pull, and the reason the catch converges into a column under the hull
    // instead of riding up in the spread-out formation it was caught in.
    h.offsetX -= h.offsetX * Math.min(1, c.suction.inwardRate * pull * dt);

    // Position is written directly because enemies.js has already zeroed this
    // creature's velocity and integrated for the frame — this must run after
    // updateEnemies.
    e.mesh.position.x = netCenterX + h.offsetX;
    e.mesh.position.y = Math.min(netTop, e.mesh.position.y + c.haulSpeed * pull * dt);

    // Reached the hull: hauled out of the water and gone.
    if (e.mesh.position.y >= netTop - c.haulCatchGap) {
      const index = enemiesList.indexOf(e);
      if (index >= 0) {
        hooks.onHauled?.(e);
        removeEnemy(scene, index);
      }
      caught.splice(i, 1);
    }
  }

  // --- the twine ------------------------------------------------------------
  // Stepped LAST, after the haul has moved the catch: the net is a picture of
  // where the fish are, and running it first would draw the pockets one frame
  // behind the creatures making them — which on a haul travelling upward at
  // speed reads as the fish escaping through their own net.
  //
  // Mass is the creature's collision radius. Not def.radius x sizeMul, which
  // is the right number for anything that means MASS elsewhere: here the
  // pocket has to line up with the BODY the player can see being held, and the
  // hitbox is what the catch test above used to decide it was in the net at
  // all. A pocket that disagreed with the catch would hold fish through gaps.
  if (CONFIG.bakalar.net.enabled) {
    setBakalarNetVisible(true);
    netLoadCount = 0;
    for (const h of caught) {
      pushNetLoad(h.enemy.mesh.position.x, h.enemy.mesh.position.y, h.enemy.radius ?? 1);
    }
    // Bombs are in the net too, and the one thing in it with a visible weight
    // the player is waiting on. A bomb that fell through the mesh without
    // touching it is the whole illusion gone.
    for (const b of bombs) {
      if (Math.abs(b.mesh.position.x - netCenterX) > halfWidth) continue;
      pushNetLoad(b.mesh.position.x, b.mesh.position.y, c.bomb.size);
    }
    // The COUNT, not the array's length — the pool keeps its high-water mark,
    // so netLoads is longer than the catch and the tail is last frame's fish.
    updateBakalarNet(dt, { centerX: netCenterX, top: netTop, halfWidth, depth }, netLoads, netLoadCount);
  } else {
    setBakalarNetVisible(false);
  }

  // --- sailed off the far side ---------------------------------------------
  const margin = halfWidth + c.hullRadius + 3;
  if (boat.position.x < bounds.left - margin || boat.position.x > bounds.right + margin) {
    releaseAll();
    sailing = false;
    boat.visible = false;
    netMesh.visible = false;
    setBakalarNetVisible(false);
    spawnTimer = randomBetween(c.spawnMin, c.spawnMax);
  }
}

// Exported for tools/ability-smoke.mjs. Nothing in Node can COMPILE GLSL, and
// the browser preview suspends requestAnimationFrame so it never renders a
// frame to compile it in either — which leaves the realistic failure here
// completely uncovered: a uniform renamed on one side of the pair and not the
// other. The material declares uniforms in JS and the shader reads them by
// name, and a mismatch is silently a black beam. Exposing both halves lets the
// harness check they agree.
export const __beamShader = { BEAM_VERT, BEAM_FRAG, makeBeamMaterial };
