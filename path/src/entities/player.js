import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { baseStats, applyLevelGrowth, applyBossGrowth, applyDamageScaling, applyIronLung, applyLaserReach } from '../stats.js';
import { rollLoadout, laserReachMul, DEFAULT_LOADOUT } from '../loadout.js';
import { applyWithRarity, baseRarity, rarityRank } from '../systems/rarity.js';
import { flipperSideForStack, finElementsIn, otherSide } from '../flipperSide.js';
import { createVisual, getAssetSizeMultiplier } from '../assets.js';
import { bounds, clampToArena, midWater } from '../arena.js';
import { feedback } from '../systems/feedback.js';
import { createAnimationController, stateForSpeed } from '../systems/animation.js';
import { createAimRig } from '../systems/aimRig.js';
import { createCelebrationDriver, resetCelebration, celebrationSpin } from '../systems/celebrate.js';
import { createClapDriver, resetClap } from '../systems/clap.js';
import { createBreathDriver } from '../systems/breathe.js';
import { attachPlayerOutline } from '../systems/outlines.js';
import { cancelDash, dashSteer, strikeState } from '../systems/strike.js';

// dashSteer's per-frame result, reused so a dash frame allocates nothing.
const steerStep = { heading: 0, speed: 0, breakOut: false };
import { launchFor } from '../systems/airborne.js';

// Scratch for the body transform, which composes the mirror, the barrel roll,
// the crane and the wind-up shudder every frame.
const _rollQ = new THREE.Quaternion();
const _craneQ = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0); // the art's forward — the roll axis
const _xAxis = new THREE.Vector3(1, 0, 0); // swings the nose toward the camera
const _spinQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1); // the seal's lateral axis — the somersault's

// THE RAGDOLL'S ROLE, and the reason a living seal is unaffected by it.
//
// ASSETS.ship.rig.springChains declares five loose chains — both front
// flippers, both rear flippers and the neck — all wearing this one role and all
// marked `asleep`, which systems/animation.js honours by muting them as it
// builds them and again on every reset. A muted chain neither solves nor stores
// an impulse, so nothing about a living seal changed when they were added.
// systems/deathDive.js is the only thing that ever wakes them, via setLimp().
//
// Named here because this file is the seal's, and the harnesses that check the
// arrangement have somewhere honest to read the string from.
export const FLOP_ROLE = 'sealFlop';

export const player = {
  mesh: null, // container — carries the aim rotation
  body: null, // visual — carries the left/right flip
  aimRig: null, // fin/head IK, muzzles and bone anchors; null for a model with no rig
  celebrate: null, // boss-kill victory pose; null for a model with no rig to pose
  clap: null, // the clap button's pose; null for a model with no rig to pose
  breathe: null, // the resting breath; null for a model with no breathRig
  // The body's extent, as a Box3 in the container's frame with the body's own
  // rotation at identity — so +y is the art's forward (nose), x is belly to
  // back and z is flank to flank. Measured off whatever is actually under
  // `body` (the stand-in until the model resolves, then the real seal) by
  // measureBody. The death dive reads it to rest the animal's lowest point on
  // the sand instead of its pivot: the pivot sits `hitRadius` above the floor,
  // one unit, and the seal is six long.
  bodyBox: null,
  // The same body as VERTICES — every visible, non-outline mesh under `body`.
  // bodyLowest() poses them (skinned, so the limp limbs count where they
  // actually hang) and answers how far below the pivot the animal reaches as
  // it stands this frame. The box above is the cheap fallback.
  bodyProbe: null,
  velocity: new THREE.Vector2(0, 0),
  // The shove, held apart from `velocity` — see applyPlayerKnockback. World
  // units per second, decaying; zero on every frame nothing has hit the seal.
  knockX: 0,
  knockY: 0,
  hp: 100,
  invuln: 0,
  upgrades: [],
  stats: {},
  aboveSurface: false,
  // 0..1 — how settled the seal is at the waterline, and the only input to the
  // relaxed idle and its breathing. Deliberately SEPARATE from aboveSurface,
  // which is a physics fact (gravity, air drag, the breach splash) and must
  // keep meaning exactly what it always has. See CONFIG.surfaceRest.
  surfaceRest: 0,
  surfaceRestTimer: 0, // seconds held still at the surface, before the ramp
  // Which way the surface was crossed on THIS frame: 1 up, -1 down, 0 not at
  // all. A one-frame edge, cleared at the top of updatePlayer — `aboveSurface`
  // alone can't carry it, since a caller reading it after the fact sees only
  // the state, not the crossing. Porpoising (main.js) is what reads it; kept
  // as a plain field for the same reason as dashTimer and comboSpeedMul —
  // entities/ doesn't import from systems/.
  breachDir: 0,
  // --- air time -------------------------------------------------------------
  // Seconds since the seal last crossed the water line going UP, and the
  // mid-air relaunches spent since. Together they are what CONFIG.airborne
  // scales everything off — see systems/airborne.js, which owns the maths;
  // these three are only the raw record of the arc.
  //
  // Plain fields on the player for the same reason dashTimer and comboSpeedMul
  // are: entities/ doesn't import from systems/, so the state lives here and
  // the system that reads it comes to it.
  //
  // `airPeak` is the high-water mark of the ramp during THIS breach, and it
  // exists because the splash-down is paid out on the way down. A jump spent at
  // the top of the arc is the most expensive thing in the mechanic, and reading
  // the live ramp at the moment of impact — after the descent has run the
  // clock — would quietly refuse to pay for it.
  airTime: 0,
  airJumps: 0,
  airPeak: 0,
  // The side-view mirror, as an ANGLE rather than written straight onto the
  // body. 0 or PI — a mirror about the forward axis IS a half roll, so it
  // lives in the same channel the barrel roll does and the two simply add.
  // Before this the mirror wrote body.rotation.y absolutely from three
  // different places, which left nowhere for a roll to go without one of them
  // stomping it mid-spin.
  mirrorAngle: 0,
  // Procedural barrel roll — the only thing rolling the seal now that the
  // spin clip is gone. Driven by main.js at launch (like dashTimer) and
  // integrated in updatePlayer; both ends land on whole turns, so the roll
  // always finishes flush with the mirror underneath it.
  rollAngle: 0,
  // From/to rather than a bare total, so a strike fired while an earlier roll
  // is still turning continues from where that one had got to instead of
  // snapping the seal back to upright and starting again. With the rhythm
  // loop, re-striking mid-roll is the normal case, not an edge one.
  rollFrom: 0,
  rollTo: 0,
  rollElapsed: 0,
  rollDuration: 0,
  // 0..1 of a strike being wound up, pushed in by main.js each frame — the
  // coil pose the aim rig applies. Same plain-field arrangement as dashTimer
  // and comboSpeedMul, and for the same reason: entities/ doesn't import from
  // systems/, so the strike state comes to it rather than the other way round.
  chargePose: 0,
  // True while a wind-up has the mouth sealed — chum still magnetises in but
  // nothing is swallowed until the strike fires and gulps the lot (see
  // CONFIG.strike.charge.gulp and updatePickups). Pushed in by main.js each
  // frame for the same reason as chargePose above.
  chumSealed: false,
  // --- BEING HELD -----------------------------------------------------------
  // Seconds left of a snare, and what fraction of the seal's own swimming
  // survives it. 1 is free; 0 is held solid. Written by snarePlayer(), read by
  // updatePlayer, and by nothing else — a system that wants to slow the seal
  // asks for a snare rather than reaching into `stats`, because stats are
  // rebuilt from the upgrade list on every level-up and a multiplier parked in
  // there would be silently wiped by the next card.
  //
  // Plain fields on the player for the same reason dashTimer and comboSpeedMul
  // are: entities/ does not import from systems/, so the state lives here and
  // whatever imposes it comes to it.
  snareTimer: 0,
  snareMul: 1,
  snareThaw: 0.3,
  // Body twist toward the camera when the aim goes behind, and the clock for
  // the wind-up tremble. Both live on the same body transform as the mirror
  // and the barrel roll, composed together in updatePlayer.
  craneAngle: 0,
  chargeClock: 0,
  shudderAmp: 0, // eased amplitude, so the tremble fades out instead of cutting
  // Placeholder only — resetPlayer fills the tank from `stats.maxOxygen`,
  // which is where cards reach. Read off CONFIG so the two can't drift.
  oxygen: CONFIG.oxygen.max,
  level: 1, // mirrors gameState.level so stat scaling can read it
  mirrored: null, // side-view facing flip state (null until first resolved)
  // The mirror turnaround, eased rather than swapped. `mirrorAngle` above is
  // the live value; these describe the roll currently carrying it across.
  mirrorFrom: 0,
  mirrorTo: 0,
  mirrorT: 1, // 1 = settled
  mirrorDuration: 0,
  anim: null,
  hitThisFrame: false,
  // >0 while a strike dash is in flight. Set by main.js when the dash fires;
  // the only thing it does is swap which ceiling the velocity clamp uses (see
  // updatePlayer). Lives here rather than being read off strikeState so this
  // module stays free of a systems/ import, like every other entity file.
  dashTimer: 0,
  // Speed multiplier from the live strike combo, pushed in by main.js each
  // frame (same reason as dashTimer above — no systems/ import here). Scales
  // thrust, the speed ceiling AND the dash turn rate together, so a combo is
  // uniformly more agile rather than fast-but-unsteerable.
  comboSpeedMul: 1,
  // Thrust multiplier from the boost meter's current fuel, pushed in by main.js
  // each frame (same reason again). Scales ORDINARY SWIMMING ACCELERATION only
  // — not the ceiling, not the dash — so a full bar gets the seal moving sooner
  // without changing what it is to steer. See chargeThrustMul in
  // systems/strike.js.
  chargeThrustMul: 1,
  // HOW MANY BODIES THE SEAL HAS SWALLOWED THIS RUN. Maneater's whole payload,
  // and the only run-scoped number the stat block is built against other than
  // `level`. It lives here rather than in the stats because it is not a stat:
  // recomputeStats() throws the block away and rebuilds it several times a
  // minute, so a total kept there would be reset by every level-up.
  //
  // main.js is the only writer — the seal's own meal, not a shark's or an
  // orca's, which take bodies the player never got (see eatCrew in
  // systems/crew.js for the four mouths).
  humansEaten: 0,
  // HOW MANY BOSSES THIS RUN HAS PUT DOWN, here for exactly the reason
  // `humansEaten` above is: the stat block is built against it and the block is
  // thrown away and rebuilt several times a minute, so it cannot live there.
  //
  // A MIRROR of `bossState.defeated` in systems/boss.js, which stays the one
  // place a kill is counted — main.js copies it across on the frame it moves
  // and recomputes. Kept as a mirror rather than a second tally so the two can
  // never disagree about how many bosses a run has beaten; see updateBossShot
  // in main.js.
  bossesDefeated: 0,
  // WHICH GUN THIS RUN ROLLED — 'pebbles' or 'laser'. Seeded to the default
  // rather than rolled here: this object is built once at module load and a
  // run's identity is decided at resetPlayer, which is the one place that runs
  // per run. See ../loadout.js.
  loadout: DEFAULT_LOADOUT,
};

// ---------------------------------------------------------------------------
// WHERE THE SEAL'S OWN OVERLAYS SIT, in z.
//
// Everything drawn AROUND the animal rather than on it — the charge meter's
// arcs, the aura, the shockwave rings — is a flat quad on a plane, and that
// plane has to clear the whole animal rather than just its origin. They used
// to sit at -0.05 and -0.2, which is INSIDE the body: furseal.glb as the game
// builds it spans -1.72..+1.79 in z at the shipped size, so the meter was
// sliced by the seal — arcs disappearing into the flank and coming out the
// other side. That reads as clipping, not as an instrument, and it is why the
// glow looked like it was painted on the seal instead of behind it.
//
// The camera is orthographic at z=+40 looking down -z (see world.js), so a
// smaller z is further away and nothing about this changes with framing.
//
// DERIVED FROM THE LIVE SIZE MULTIPLIER, not typed as a world number, because
// the T-panel's seal size is a slider that actually gets moved: the rear
// extent measured 1.717 units at the shipped multiplier of 2.36, which is
// 0.728 per unit of it. A hand-typed -2 would put the meter back inside the
// animal the first time the seal was scaled up.
//
// There is room behind: the surface line sits at -3, the fog band at -3.2 and
// the grid at -4.5, so at any sane size this stays in front of the scenery.
const SEAL_REAR_EXTENT_PER_SIZE = 0.728;
// Clearance for the parts of the animal that move in z without changing the
// bounding box the number above came from — the barrel roll and the wind-up
// tremble.
const OVERLAY_CLEARANCE = 0.3;

export function playerOverlayZ() {
  return -(SEAL_REAR_EXTENT_PER_SIZE * (getAssetSizeMultiplier('ship') || 1) + OVERLAY_CLEARANCE);
}

const _measureRel = new THREE.Matrix4();
const _measureInv = new THREE.Matrix4();
const _measureBox = new THREE.Box3();

/**
 * The body's bounding box in the container's frame, body rotation aside.
 *
 * Each mesh's box is carried through its transform RELATIVE to the body, then
 * the body's own scale (the size multiplier lives on the root — see
 * createVisual) is put back on. Skinned meshes are boxed posed rather than
 * bind-pose, the same distinction assets.js draws in referenceBox, and a mesh
 * createVisual hid as an outlier stays out of the measurement.
 *
 * Forced world matrices first: a body that has never been through a render
 * has stale ones and every mesh measures at the origin.
 */
function measureBody(body) {
  body.updateMatrixWorld(true);
  _measureInv.copy(body.matrixWorld).invert();
  const box = new THREE.Box3();
  body.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    if (o.isSkinnedMesh) {
      o.computeBoundingBox();
      _measureBox.copy(o.boundingBox);
    } else {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _measureBox.copy(o.geometry.boundingBox);
    }
    _measureRel.multiplyMatrices(_measureInv, o.matrixWorld);
    _measureBox.applyMatrix4(_measureRel);
    box.union(_measureBox);
  });
  if (box.isEmpty()) return null;
  _measureRel.makeScale(body.scale.x, body.scale.y, body.scale.z);
  return box.applyMatrix4(_measureRel);
}

/**
 * The meshes bodyLowest samples: every visible, non-outline mesh under the
 * body. The outline shells are left out — they are the same vertices pushed
 * outward by the rim, and would only thicken the answer.
 */
function probeBody(body) {
  const meshes = [];
  let count = 0;
  body.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
    if (o.userData?.__isOutline) return;
    meshes.push(o);
    count += o.geometry.attributes.position.count;
  });
  if (!meshes.length) return null;
  // Doubles, not floats: the rest height is compared to the pivot exactly,
  // and a float32 line is off by 1e-5 at a depth of forty.
  return { meshes, ys: new Float64Array(count) };
}

const _probeV = new THREE.Vector3();

/**
 * HOW FAR BELOW THE PIVOT THE BODY REACHES, in world y, as it stands this
 * frame — under whatever tumble, roll and crane the container and the body
 * are holding — as a positive distance.
 *
 * Posed, not bind-pose: a SkinnedMesh's getVertexPosition runs every vertex
 * through its bones' world matrices, so a flipper the ragdoll has let hang
 * counts where it hangs. That answer is only right when the bones and the
 * mesh were updated TOGETHER — the skin is undone through the mesh's own
 * world matrix, and bones one update behind it come out somewhere else
 * entirely (in the harness, five units under a body three long). So the
 * whole rig's world matrices are refreshed here first. In the game that
 * repeats what the renderer is about to do for a hundred-odd nodes, which is
 * nothing next to the vertices.
 *
 * `share` is the fraction of the body allowed to be UNDER the answer — the
 * thinnest few percent of it. At zero the answer is the single lowest vertex,
 * which for a seal on its side is the tip of one flipper, and the whole animal
 * then hovers a flipper's depth above the sand. A few percent lets the fin bed
 * into the silt and rests the body itself on the line, which is what a body on
 * sand looks like. The stand-in ellipsoid has no fins and does not care.
 *
 * Returns null for a body nothing has probed.
 */
export function bodyLowest(share = 0) {
  const probe = player.bodyProbe;
  if (!probe || !player.mesh) return null;
  player.mesh.updateMatrixWorld(true);
  const ys = probe.ys;
  let n = 0;
  for (const mesh of probe.meshes) {
    const count = mesh.geometry.attributes.position.count;
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, _probeV);
      _probeV.applyMatrix4(mesh.matrixWorld);
      ys[n++] = _probeV.y;
    }
  }
  if (n === 0) return null;
  const view = ys.subarray(0, n);
  const k = Math.min(n - 1, Math.max(0, Math.floor(share * n)));
  let line;
  if (k === 0) {
    line = Infinity;
    for (let i = 0; i < n; i++) if (view[i] < line) line = view[i];
  } else {
    view.sort();
    line = view[k];
  }
  return player.mesh.position.y - line;
}

export function initPlayer(scene) {
  const group = new THREE.Group();
  group.name = 'player';

  const body = createVisual('ship');
  group.add(body);
  // Readability comes from the seal's own silhouette now, not from a ring
  // drawn around it — see systems/outlines.js and CONFIG.playerOutline.
  attachPlayerOutline(body);

  player.mesh = group;
  player.body = body;
  player.bodyBox = measureBody(body);
  player.bodyProbe = probeBody(body);
  player.anim = createAnimationController(body);
  player.aimRig = createAimRig(body);
  player.celebrate = createCelebrationDriver(body);
  player.clap = createClapDriver(body);
  player.breathe = createBreathDriver(body);
  scene.add(group);
  recomputeStats();
}

// player.body is a singleton created once above, not repeatedly cloned like
// an enemy — startGame()'s resetPlayer() only resets its position/stats, it
// never recreates the mesh. That means a T-menu size change (or a restored
// one from a previous session) would update the multiplier used for FUTURE
// createVisual('ship') calls, but silently do nothing to the ship already on
// screen — indistinguishable from "the slider doesn't work" if you're trying
// to make it bigger to see it. Swaps the body mesh in place, same rotation
// state, and rebuilds the animation controller since that's tied to the
// specific mesh instance.
export function rebuildShipBody() {
  if (!player.mesh || !player.body) return;
  const oldRotationY = player.body.rotation.y;
  player.mesh.remove(player.body);
  const body = createVisual('ship');
  body.rotation.y = oldRotationY;
  player.mesh.add(body);
  player.body = body;
  player.bodyBox = measureBody(body);
  player.bodyProbe = probeBody(body);
  // The shells hang off the meshes inside the OLD body, which just left the
  // scene — a rebuilt seal starts with no outline until they're remade.
  attachPlayerOutline(body);
  player.anim = createAnimationController(body);
  // Bones are per-instance, so the aim rig is as tied to this mesh as the
  // animation controller is — a swapped body leaves the old one pointing at
  // bones that are no longer in the scene.
  player.aimRig = createAimRig(body);
  player.celebrate = createCelebrationDriver(body);
  player.clap = createClapDriver(body);
  player.breathe = createBreathDriver(body);
}

/**
 * THE WHOLE PIPELINE, AS A PURE FUNCTION — a stat block from a pick list.
 *
 * Pulled out of recomputeStats when the hover tips needed to answer "and where
 * would that put me" (see ui/upgradeTip.js): the honest answer is this exact
 * pipeline run again with one more pick on the end, and there is no other way
 * to get it. Reimplementing the order — upgrades, then level growth, then the
 * two damage-scaling cards — somewhere else would be a second copy of a
 * sequence whose whole comment is about why the order matters, and the drift
 * would show up as a tooltip promising a number the fight does not deliver.
 *
 * Nothing here touches `player`. recomputeStats below is the one caller that
 * commits the result.
 *
 * @param picks  { id, rarity } entries, oldest first.
 * @param level  player level, for the baseline growth.
 * @param humansEaten  for Maneater.
 * @param bossesDefeated  for the per-boss pellet.
 * @param oxygen  the air the seal is holding, for Iron Lung. Left out on a
 *   hypothetical block (the hover tips, a Node harness) so the card measures
 *   at a full breath — see ironLungMul in stats.js.
 */
export function computeStats(picks = [], level = 1, humansEaten = 0, bossesDefeated = 0, oxygen,
  loadout = DEFAULT_LOADOUT) {
  // SEEDED WITH THE LOADOUT, before any apply() runs, because two of the gun
  // cards fork on it — see Pocket Full of Stones and André 3000 in config.js.
  // Last parameter and defaulted, so every existing caller (the hover tips, the
  // Node harnesses) gets the pebble gun, which is what they were measuring
  // before this existed.
  const s = baseStats(loadout);

  // `player.upgrades` holds { id, rarity } rather than bare ids, because the
  // tier a card was DEALT at is part of what that pick is worth and has to
  // survive every recompute — the block is rebuilt from scratch on each
  // level-up and on every tuner nudge, so a rarity kept anywhere else would be
  // thrown away several times a minute.
  for (const pick of picks) {
    const u = CONFIG.upgrades.find((x) => x.id === pick.id);
    if (u) applyWithRarity(u, s, pick.rarity);
  }

  // Baseline growth applied AFTER upgrades — see stats.js for the why.
  applyLevelGrowth(s, level);
  // The run's other baseline growth, on the same terms and for the same
  // reason — a flat pellet per boss beaten. See applyBossGrowth in stats.js.
  applyBossGrowth(s, bossesDefeated);
  // ...and the laser's reach ramp, which is the third thing that is a function
  // of the whole run rather than of one pick. AFTER applyBossGrowth and before
  // the damage scaling, which is only ordering hygiene — it moves `life` and
  // nothing else reads or writes that — but the block is built in one order and
  // a number that arrives at a different point in it is a number somebody will
  // eventually have to reason about. See applyLaserReach in stats.js.
  applyLaserReach(s, laserReachMul(picks, bossesDefeated));
  // ...and the two damage-scaling cards after THAT, so Maneater and Iron Lung
  // multiply the finished numbers rather than a partial block. Both are
  // no-ops on a run that holds neither. See applyDamageScaling in stats.js.
  applyDamageScaling(s, humansEaten, oxygen);
  return s;
}

// Rebuild the stat block from CONFIG, then replay every upgrade on top. Called
// on reset, on level-up, and whenever the tuner changes a value — which is why
// sliders affect a run already in progress.
export function recomputeStats() {
  const s = computeStats(
    player.upgrades, player.level, player.humansEaten, player.bossesDefeated, player.oxygen,
    player.loadout,
  );
  player.stats = s;
  player.hp = Math.min(player.hp, s.maxHp);
  return s;
}

/**
 * The stat block this run WOULD have with one more of `id` in it.
 *
 * The tips' "and where does that put me" figure. Nothing is committed — the
 * live block is untouched — and the answer includes everything the fight
 * includes: the base, every other card, the level growth and the damage
 * scaling, which is the whole point of routing it through computeStats rather
 * than replaying one apply() in isolation.
 *
 * `rarity` is the tier the hypothetical pick would arrive at. The level-up
 * screen knows it (the card has been dealt); a hexagon in the hive does not,
 * and passing null lands on the base tier — the same default addUpgrade uses,
 * which is the conservative read rather than a flattering one.
 */
export function statsWithOneMore(id, rarity = null) {
  if (!id) return null;
  return computeStats(
    [...player.upgrades, { id, rarity: rarity ?? baseRarity() }],
    player.level,
    player.humansEaten,
    player.bossesDefeated,
    // Oxygen deliberately omitted — see computeStats. The LOADOUT is not: a tip
    // that measured Pocket Full of Stones against the pebble gun on a laser run
    // would promise a bolt the card is not going to hand over.
    undefined,
    player.loadout,
  );
}

/**
 * THE FLIPPER ROLL — which element the stack being taken puts on its fin.
 *
 * Here, on the PICK, and not at draw time: a Flippers Up! stack can arrive
 * without a card ever being dealt (applyLevelOrb in main.js hands a stack to a
 * random held upgrade), so a roll living on the level-up screen would leave
 * those stacks elementless and nothing would say why.
 *
 * Nor in apply(): recomputeStats() rebuilds the block from scratch on every
 * level-up and every tuner nudge, so a Math.random in there is re-rolled
 * several times a minute. Stamped on the pick, it is decided once and read back
 * by finElements() — a pure function of the pick list, which is the same
 * arrangement the run's element has.
 *
 * IT AVOIDS THE OTHER FIN'S ELEMENT. Two flippers throwing the same element is
 * the one outcome that makes the whole thing invisible — same colour of flash,
 * same status, no reason to look at which fin fired. With four elements and two
 * fins there is always something left to roll, so this can never fail to find
 * one.
 *
 * `random` is injectable for the same reason drawUpgrades takes one: so the
 * distribution can be checked without running the game.
 */
function rollFinElement(picks, random = Math.random) {
  const stack = picks.filter((p) => p.id === 'flippersUp').length + 1;
  if (stack < (CONFIG.weapon?.flipperElementStack ?? Infinity)) return null;

  const side = flipperSideForStack(stack);
  const held = finElementsIn(picks);
  // Already lit: a later stack DEEPENS the fin it lit rather than re-rolling it,
  // which is the rule Glow Up!'s own stacks follow. The level is apply()'s job;
  // this only has to not change the identity.
  if (held[side]) return held[side];

  const other = held[otherSide(side)];
  const pool = Object.keys(CONFIG.biolum?.elements ?? {}).filter((id) => id !== other);
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export function addUpgrade(id, rarity = null, random = Math.random) {
  const pick = { id, rarity: rarity ?? baseRarity() };
  if (id === 'flippersUp') {
    const el = rollFinElement(player.upgrades, random);
    if (el) pick.finElement = el;
  }
  player.upgrades.push(pick);
  const beforeHp = player.stats.maxHp;
  const beforeO2 = player.stats.maxOxygen;
  recomputeStats();
  player.hp = Math.min(player.stats.maxHp, player.hp + Math.max(0, player.stats.maxHp - beforeHp));
  // Same grant for oxygen as for health: taking a bigger tank hands you the
  // extra air, rather than leaving the bar looking emptier than it did a
  // second ago because only the denominator moved.
  player.oxygen = Math.min(
    player.stats.maxOxygen,
    player.oxygen + Math.max(0, player.stats.maxOxygen - beforeO2),
  );
  // ...and the lung is worth what the topped-up bar says, not what it said one
  // line ago. recomputeStats above ran before the grant, so without this a
  // Deep Lungs pick would leave Iron Lung reading the old tank until the next
  // frame — a frame in which the card that was just taken looks like it did
  // nothing.
  applyIronLung(player.stats, player.oxygen);
}

/**
 * The held upgrades that could take ANOTHER stack right now, each with the
 * count it is on and the best tier it has been taken at.
 *
 * The level blob's pool — see applyLevelOrb in main.js. Three things are
 * deliberately filtered here rather than at the call site, because all three
 * are properties of the BUILD and this file is where the build lives:
 *
 *   at the cap        `maxStacks` is a real ceiling, and a pickup that ignored
 *                     it would be the one route in the game past a limit every
 *                     card in the level-up menu respects (see availableUpgrades
 *                     below, which drops a maxed card from the offer pool for
 *                     exactly the same reason).
 *   switched off      an upgrade turned off in upgrades.csv is out of the game.
 *                     A run that is still holding one from before the row was
 *                     disabled must not be able to deepen it.
 *   the tier          the stack is added at the BEST rarity this upgrade has
 *                     already been taken at, not at the floor. The blob's
 *                     sentence is "more of what you have", and handing a common
 *                     stack of a card the player took as an epic would quietly
 *                     dilute it — recomputeStats replays every pick at its own
 *                     tier, so a floor-tier stack is worth measurably less than
 *                     the ones beside it.
 */
export function levelableUpgrades() {
  const counts = new Map();
  for (const pick of player.upgrades) {
    const cur = counts.get(pick.id);
    if (!cur) { counts.set(pick.id, { id: pick.id, count: 1, rarity: pick.rarity }); continue; }
    cur.count += 1;
    if (rarityRank(pick.rarity) > rarityRank(cur.rarity)) cur.rarity = pick.rarity;
  }
  const out = [];
  for (const entry of counts.values()) {
    const u = CONFIG.upgrades.find((x) => x.id === entry.id);
    if (!u || u.enabled === false) continue;
    if (u.maxStacks != null && entry.count >= u.maxStacks) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Does this card put an ANIMAL in the water?
 *
 * `family: 'companion'` is two different things: eight cards that add a body
 * and two — Entourage, Big Rigz — that scale the bodies already there. Only the
 * first kind spends one of the run's companion slots, and the second kind is
 * marked in config.js rather than listed here, so a companion added later is
 * counted without anyone having to remember this function exists.
 *
 * Exported for the harnesses, which have to be able to ask the same question
 * the offer pool asks rather than keeping their own list of ids.
 */
export function isCompanionCard(u) {
  return !!u && u.family === 'companion' && u.companionMod !== true;
}

export function availableUpgrades() {
  // WHICH EXCLUSIVE GROUPS ARE ALREADY SPOKEN FOR. A card carrying
  // `exclusive: 'group'` locks that group to itself the moment it is taken:
  // every OTHER card in the same group leaves the pool for the rest of the run.
  //
  // The four elements are the only group so far, and they are the reason it
  // exists — a run carries one element, and everything downstream assumes it
  // (one tint on the seal, one word in the weapon's name, one set of curves).
  // Before this the guarantee came from a Math.random roll on a single card;
  // now it comes from the offer pool, where it can be read.
  //
  // BUILT PER CALL, not cached. This runs once per level-up, on a paused game,
  // over fifty upgrades — and a cache would have to be invalidated on every
  // pick, which is the one place it would ever be wrong.
  const claimed = new Map();
  // ...and which companions the run is already carrying, for the other rule of
  // the same kind: CONFIG.maxCompanionCards caps how many DIFFERENT animals a
  // run may collect (see the note there). A Set of ids, so six escorts count
  // once — the cap is on variety, never on depth.
  const companions = new Set();
  for (const pick of player.upgrades) {
    const u = CONFIG.upgrades.find((x) => x.id === pick.id);
    if (!u) continue;
    if (u.exclusive && !claimed.has(u.exclusive)) claimed.set(u.exclusive, u.id);
    if (isCompanionCard(u)) companions.add(u.id);
  }
  const companionCap = CONFIG.maxCompanionCards;

  return CONFIG.upgrades.filter((u) => {
    // `enabled: false` (set in the upgrade table) removes an upgrade from
    // the offer pool entirely, without deleting it from config.
    if (u.enabled === false) return false;
    // Held the group already, and it was somebody else.
    if (u.exclusive && claimed.has(u.exclusive) && claimed.get(u.exclusive) !== u.id) return false;
    // The run's companion slots are full, and this would be a NEW one. One
    // already held is always still offered: the cap is on how many different
    // animals a run collects, not on how deep any of them goes.
    if (companionCap != null && isCompanionCard(u)
      && !companions.has(u.id) && companions.size >= companionCap) return false;
    if (u.maxStacks == null) return true;
    return player.upgrades.filter((p) => p.id === u.id).length < u.maxStacks;
  });
}

export function resetPlayer() {
  player.mesh.position.set(0, midWater(), 0);
  player.mesh.rotation.z = 0;
  player.mirrorAngle = 0;
  player.craneAngle = 0;
  player.chargeClock = 0;
  player.shudderAmp = 0;
  player.body.rotation.y = 0;
  player.body.quaternion.identity();
  // The wind-up's positional buzz. Only the tremble ever writes this, and a run
  // that ended mid-hold would otherwise open with the seal a few hundredths off
  // its own container — invisible, but it would never come back.
  player.body.position.set(0, 0, 0);
  player.rollAngle = 0;
  player.rollElapsed = 0;
  player.rollDuration = 0;
  player.rollFrom = 0;
  player.rollTo = 0;
  player.velocity.set(0, 0);
  // Cleared with the velocity, and for the same reason: a run that ended with
  // the seal mid-shove would otherwise start the next one still sliding.
  player.knockX = 0;
  player.knockY = 0;
  player.aboveSurface = false;
  player.breachDir = 0;
  player.airTime = 0;
  player.airJumps = 0;
  player.airPeak = 0;
  player.level = 1;
  player.mirrored = null;
  player.mirrorFrom = 0;
  player.mirrorTo = 0;
  player.mirrorT = 1;
  player.mirrorDuration = 0;
  player.upgrades.length = 0;
  // Before recomputeStats() below, not after — the block is built against this
  // and a new run must not open carrying the last one's Maneater bonus.
  player.humansEaten = 0;
  // Before recomputeStats() below for the same reason, and it is the same
  // mistake: a new run must not open firing the last one's boss pellets.
  player.bossesDefeated = 0;
  // BEFORE recomputeStats() below, and for the same reason the two lines above
  // are: the block is seeded from this, and two of the gun cards fork on it. A
  // run that rolled the laser and built its stats against the pebble gun would
  // fire bolts with the pebble's reach and convert none of its multishot.
  player.loadout = rollLoadout();
  player.invuln = 0;
  player.dashTimer = 0;
  player.comboSpeedMul = 1;
  player.chargeThrustMul = 1;
  player.chumSealed = false;
  // A run that ended held does not start held.
  player.snareTimer = 0;
  player.snareMul = 1;
  // The controller is reused across runs, and 'death' is a one-shot that
  // never expires by design — so without this the seal stays clamped in its
  // death pose for every subsequent run.
  player.anim?.reset();
  player.aimRig?.reset();
  // Both halves: the shared clock (or a run that starts moments after a boss
  // died resumes celebrating for it) and this body's smoothed IK pose, which
  // would otherwise blend the last run's clap into the first frames of this
  // one. See systems/celebrate.js.
  resetCelebration();
  player.celebrate?.reset();
  // Same two halves for the clap, and the shared half matters more here: its
  // clock is what the minimum-gap throttle measures against, so a run started
  // moments after the last clap of the previous one would refuse its first
  // press. See systems/clap.js.
  resetClap();
  player.clap?.reset();
  // A new run starts on a fresh breath, not mid-exhale, and never still
  // relaxed from where the last seal came to rest.
  player.breathe?.reset();
  player.surfaceRest = 0;
  player.surfaceRestTimer = 0;
  recomputeStats();
  player.hp = player.stats.maxHp;
  // After recomputeStats, not before: upgrades were just cleared above, so the
  // cap is back to base and this fills the real tank rather than last run's.
  player.oxygen = player.stats.maxOxygen;
  // Same order problem as addUpgrade, for the same one-line fix: the block was
  // rebuilt while `player.oxygen` still held whatever the last run drowned on.
  applyIronLung(player.stats, player.oxygen);
}

// ---------------------------------------------------------------------------
// THE SNARE — something has hold of the seal
// ---------------------------------------------------------------------------
// A window in which the seal's own swimming is worth a fraction of what it
// normally is. `mul` 0 is held solid, 0.15 is wading, 1 is nothing at all.
//
// IT SCALES THE SEAL, NOT THE WATER. Thrust and the speed ceiling both, because
// scaling only one of them does not work in either direction: cutting thrust
// alone leaves a seal already at top speed coasting out of the trap on
// momentum, and cutting the ceiling alone leaves it pinned at a low speed it
// still reaches instantly, which reads as swimming through treacle rather than
// as being caught.
//
// KNOCKBACK IS DELIBERATELY OUTSIDE IT. A shove is integrated after the clamp
// (see updatePlayer) and a held seal should still be thrown by what hits it —
// otherwise the snare quietly becomes immunity to being moved, which is the
// opposite of what it is for.
//
// STRONGEST AND LONGEST WIN rather than the newest. Two overlapping sources
// would otherwise let the weaker one, arriving second, cancel the stronger —
// and the shape that produces is a freeze that a glancing second hit undoes.
export function snarePlayer(seconds, mul = 0, thaw = 0.3) {
  if (!(seconds > 0)) return;
  // Expired: start from free rather than from whatever the last one left, or a
  // long-dead weak snare would floor every later one at its own multiplier.
  if (player.snareTimer <= 0) player.snareMul = 1;
  player.snareTimer = Math.max(player.snareTimer, seconds);
  player.snareMul = Math.min(player.snareMul, Math.max(0, mul));
  player.snareThaw = Math.max(0, thaw);
}

/** Is the seal held right now? For the readouts and the harness. */
export function playerSnared() {
  return player.snareTimer > 0;
}

// What fraction of its own swimming the seal has this frame, and the only
// place the clock is advanced.
//
// THE RELEASE IS A RAMP, not the timer hitting zero. A hold that ends on one
// frame snaps the seal from a twelfth of its speed to all of it, which reads
// as the game hitching rather than as the grip letting go — so the last
// `snareThaw` seconds of every snare walk the multiplier back to 1. The hold
// itself is still exactly as long as it was asked to be; the thaw is spent
// inside it, which is why a snare shorter than its own thaw is simply a shove
// that fades rather than an error.
function snareFactor(dt) {
  if (player.snareTimer <= 0) return 1;
  player.snareTimer -= dt;
  if (player.snareTimer <= 0) {
    player.snareTimer = 0;
    player.snareMul = 1;
    return 1;
  }
  const thaw = player.snareThaw ?? 0;
  const out = thaw > 0 && player.snareTimer < thaw ? 1 - player.snareTimer / thaw : 0;
  return player.snareMul + (1 - player.snareMul) * out;
}

export function updatePlayer(dt, input) {
  const s = player.stats;
  const pos = player.mesh.position;

  // Decremented up here rather than down by the clamp: everything below wants
  // to know whether this frame is a dash frame, not just the clamp.
  if (player.dashTimer > 0) player.dashTimer -= dt;
  const dashing = player.dashTimer > 0;
  const combo = player.comboSpeedMul || 1;
  // Thrust only — the ceiling and the dash below read `combo` alone.
  const boost = player.chargeThrustMul || 1;
  // Advanced exactly once a frame, here, because it is a clock as well as a
  // multiplier — reading it twice would run the hold out at double speed.
  const snare = snareFactor(dt);

  if (CONFIG.player.thrustEnabled) {
    player.velocity.x += input.move.x * s.thrust * combo * boost * snare * dt;
    player.velocity.y += input.move.y * s.thrust * combo * boost * snare * dt;
  }

  // Steering mid-dash. A strike used to be a straight line you waited out —
  // the impulse set velocity once and thrust alone (19 u/s^2 against a 46 u/s
  // dash) couldn't meaningfully bend it inside 0.22s. Now the dash keeps its
  // SPEED and swings its HEADING toward the stick at a capped angular rate,
  // which is what makes it a turn radius rather than a lerp: speed/turnRate,
  // ~3.8 world units at defaults. The rate scales with the combo alongside
  // the speed it divides, so the radius stays constant as you get faster.
  // A DASH IS STEERED, THROTTLED AND CANCELLABLE — see CONFIG.strike.dashControl.
  //
  // It used to be none of those things past a slow turn: the heading swung
  // toward the stick at a capped rate and the speed was pinned at dashSpeed for
  // the whole length, so the only choice you had mid-strike was which arc to
  // ride. Turn authority was never really the problem — 12 rad/s already bends
  // a base dash through 151 degrees — being locked to 46 u/s with no way out
  // was.
  //
  // THE RULE ITSELF IS dashSteer IN systems/strike.js — turn, throttle and
  // break-out — because the lens corridor forecasts a dash by running the
  // same function ahead of time, and a copy here would be a corridor that
  // lies the first time one of them is retuned.
  if (dashing && input.move.lengthSq() > 0.001) {
    const v = player.velocity.length();
    if (v > 0.001) {
      const cur = Math.atan2(player.velocity.y, player.velocity.x);
      // How far through the strike this is, for the takeover curve. A dash
      // that is not a strike (the breach impulse borrows dashTimer for its
      // ceiling) has no launch to be committed to, and steers at full
      // authority as it always did.
      const strike = strikeState.active && strikeState.dashDuration > 0;
      const progress = strike ? 1 - strikeState.dashTimeLeft / strikeState.dashDuration : 1;
      // ...and what it was bought with: a one-pip dash does not steer at all.
      const power = strike ? strikeState.power : 1;
      dashSteer(cur, v, input.move.x, input.move.y, input.aim.x, input.aim.y, combo, dt, s, progress, power, steerStep);
      if (steerStep.breakOut) {
        // BREAK OUT. Steering hard AGAINST the dash ends it on the spot and
        // hands back ordinary swimming, at the cost of the reach not yet
        // spent.
        player.dashTimer = 0;
        cancelDash();
      } else {
        player.velocity.set(Math.cos(steerStep.heading) * steerStep.speed, Math.sin(steerStep.heading) * steerStep.speed);
      }
    }
  }

  // Breaching the surface is free; what happens after it is gravity, and it is
  // the SAME gravity every shot the seal fires feels once it leaves the water
  // (CONFIG.arena.gravity — see the note there for where 29.7 comes from).
  const airborne = pos.y > bounds.surfaceY;
  if (airborne && CONFIG.arena.gravity > 0) {
    player.velocity.y -= CONFIG.arena.gravity * dt;
  }

  // The strike dash gets its own, higher ceiling for the length of the dash.
  // Without this the clamp ran before the impulse ever moved anything: main.js
  // sets velocity to dashSpeed (46), then the very next frame this line cut it
  // back to maxSpeed (34) BEFORE position integrated — so the dash never
  // actually travelled at dash speed and the dashSpeed slider did nothing.
  // Still clamped, just against the dash's own ceiling, so nothing runs away.
  // Both ceilings ride the combo multiplier: every live chain link makes the
  // seal faster, in the dash AND in the swimming between dashes.
  //
  // AND BY THE SNARE, which is what makes a hold bite on a seal already moving:
  // the clamp runs every frame, so a ceiling cut to a twelfth takes the
  // momentum out on the frame the snare lands rather than waiting for drag to
  // bleed it off over the second the hold was supposed to last.
  const ceiling = (dashing ? Math.max(s.maxSpeed, s.strikeDashSpeed) : s.maxSpeed) * combo * snare;
  const speed = player.velocity.length();
  if (speed > ceiling) player.velocity.multiplyScalar(ceiling / speed);

  // Drag, and WHICH drag depends on what the seal is in. `friction` is the
  // water's — 0.98 per frame, i.e. 70% of your speed gone every second, which
  // is about right for a body moving through water and completely wrong for
  // one moving through air. Applying it above the surface too was what made a
  // breach feel weighted down: the arc lost its horizontal run on the way up
  // and dropped nearly straight back in, so the jump read as short no matter
  // what gravity was set to. Air is nearly frictionless by comparison, so the
  // arc up there is now the ballistic curve gravity alone describes.
  player.velocity.multiplyScalar(Math.pow(airborne ? CONFIG.arena.airDrag : s.friction, dt * 60));

  pos.x += player.velocity.x * dt;
  pos.y += player.velocity.y * dt;

  // BEING SHOVED, integrated on top of whatever the seal's own swimming asked
  // for and decaying exponentially back to nothing. See applyPlayerKnockback
  // for why it is a position offset rather than a velocity impulse: in one
  // line, everything above this reads `velocity` and several things assign it.
  //
  // AFTER the speed clamp and the drag, deliberately — neither applies to it.
  // A shove that the seal's own top speed could clip would be a shove that got
  // weaker the better the player's movement upgrades were, which is the wrong
  // way round; and bleeding it through the water's friction as well as its own
  // decay would double-count the same slowing.
  if (player.knockX || player.knockY) {
    pos.x += player.knockX * dt;
    pos.y += player.knockY * dt;
    const drop = Math.exp(-(CONFIG.playerKnockback?.decay ?? 9) * dt);
    player.knockX *= drop;
    player.knockY *= drop;
    if (Math.abs(player.knockX) < 0.01) player.knockX = 0;
    if (Math.abs(player.knockY) < 0.01) player.knockY = 0;
  }

  const wasAbove = player.aboveSurface;
  const hitWall = clampToArena(pos, player.velocity, s.hitRadius, CONFIG.arena.wallRestitution);
  if (hitWall) {
    feedback('bounce', { x: pos.x, y: pos.y, vx: player.velocity.x, vy: player.velocity.y });
  }

  // Breaching the surface throws up a splash, in either direction.
  player.aboveSurface = pos.y > bounds.surfaceY;
  player.breachDir = player.aboveSurface === wasAbove ? 0 : (player.aboveSurface ? 1 : -1);

  // --- resting at the surface ---------------------------------------------
  // A second, gentler reading of the same position, for the ANIMATION only.
  // `aboveSurface` above is a hard line the seal is on one side of; this asks
  // whether the animal is parked at the waterline, which is a band around it
  // and includes floating just under. See CONFIG.surfaceRest for why the hard
  // line made `surfaceIdle` a ~100ms window at the top of a jump.
  {
    const rest = CONFIG.surfaceRest ?? {};
    const atSurface = pos.y > bounds.surfaceY - (rest.band ?? 1.3);
    const settled = player.velocity.length() < (rest.speed ?? 2.4);
    if (rest.enabled !== false && atSurface && settled) {
      player.surfaceRestTimer += dt;
    } else {
      player.surfaceRestTimer = 0;
    }
    // Ease IN over settleTime once it has held still that long, and OUT over
    // the much shorter releaseTime. Asymmetric on purpose — relaxing is a
    // decision the animal takes its time over, moving is not.
    const want = player.surfaceRestTimer >= (rest.settleTime ?? 0.7) ? 1 : 0;
    const tau = want > player.surfaceRest ? (rest.settleTime ?? 0.7) : (rest.releaseTime ?? 0.16);
    player.surfaceRest += (want - player.surfaceRest) * (1 - Math.exp(-dt / Math.max(0.01, tau)));
    if (player.surfaceRest < 0.001) player.surfaceRest = 0;
  }

  // THE ARC'S CLOCK. Zeroed on the way UP and left alone on the way down —
  // the descent is not a fourth state to clear, it is the frame the arc gets
  // PAID (systems/airborne.js fires the splash-down off exactly these values,
  // from main.js, later in the same frame). Clearing here instead would delete
  // the record of the arc one line before the only thing that reads it.
  //
  // `airJumps` and `airPeak` are written by systems/airborne.js, not here, for
  // the usual reason — but they are reset on the upward crossing alongside the
  // clock, because "a new breach starts" is one event and splitting it across
  // two files is how one of the three ends up not being reset.
  if (player.breachDir > 0) {
    player.airTime = 0;
    player.airJumps = 0;
    player.airPeak = 0;
  } else if (player.aboveSurface) {
    player.airTime += dt;
  }

  // LEAVING the water only. This used to fire in both directions, which meant
  // the breach and the landing were the same event with the same sound and the
  // same burst — so the end of an arc was indistinguishable from its start.
  // The way down is now its own event, fired from main.js, because what it is
  // worth depends on the air that was banked and entities/ has no business
  // knowing about that. See CONFIG.feedback.reentry and systems/airborne.js.
  if (player.breachDir > 0) {
    // TWO KINDS OF CROSSING, and they are not the same moment. A head lifted
    // for a breath and an animal clearing the sea shared one event — one
    // sound, one shake, one cloud of foam — which meant the quietest thing the
    // seal does and the loudest were announced identically, and neither could
    // be tuned without ruining the other.
    //
    // Split on how much AIR the crossing bought rather than on speed, and by
    // systems/airborne.js rather than here, so the launch and the landing are
    // decided by one file in one language. `null` is the split switched off:
    // every crossing is a breach, exactly as before.
    const up = Math.abs(player.velocity.y);
    const launch = launchFor(player, up);
    const flying = !launch || launch.flying;
    const at = {
      x: pos.x,
      y: bounds.surfaceY,
      dirX: 0,
      dirY: 1,
      vx: player.velocity.x,
      vy: up,
      scale: launch ? launch.scale : Math.min(2, 0.5 + up / 14),
    };
    // THE BREATH IS NOT IN HERE and must not be. systems/oxygenFx.js already
    // fires one `breathIn` per surfacing, off the oxygen bar's rising edge —
    // which catches an oxygen bubble grabbed underwater too, and this cannot.
    // These two events are the WATER; the gasp over the top of them is that
    // one, and the slow crossing is the case where the gasp is most of what
    // the player hears.
    if (flying) {
      // Pitched DOWN as the launch gets bigger, the same trick `reentry` uses
      // on the other end of the arc and for the same reason: an athletic
      // breach should land audibly heavier rather than merely louder, and the
      // two ends of one jump should be shaped by one idea.
      const power = launch ? launch.power : 0;
      feedback('breach', {
        ...at,
        sfxOpts: { pitch: 1 / (0.92 + power * 0.18), decayMul: 1 + power * 0.3 },
      });
    } else {
      // Scaled against the line rather than against a full breach: a surface
      // that only just failed to be a flight should be the loud end of THIS
      // cue, not the silent end of the other one.
      const frac = launch ? Math.min(1, launch.air / Math.max(0.01, CONFIG.airborne?.launch?.flyAir ?? 0.4)) : 1;
      feedback('surfacing', { ...at, scale: 0.45 + 0.55 * frac });
    }
    // Surfacing for air is the moment a seal vocalizes; barking as you dive
    // back under reads as a hiccup. Lowest one-shot priority, so a hit or
    // death cuts it off cleanly.
    player.anim?.trigger('bark');
  }

  if (CONFIG.oxygen.enabled) {
    if (player.aboveSurface) {
      player.oxygen = Math.min(s.maxOxygen, player.oxygen + s.oxygenRefillRate * dt);
    } else {
      player.oxygen = Math.max(0, player.oxygen - CONFIG.oxygen.depleteRate * dt);
    }
  }

  // IRON LUNG, RE-SPENT AGAINST THE BAR THAT JUST MOVED. Here rather than in a
  // recomputeStats(), which is the other way a stat block changes mid-run: a
  // full recompute replays every upgrade the run holds and is affordable once
  // a level-up, not once a frame. applyIronLung re-derives four numbers from
  // the stash applyDamageScaling left, so a run without the card pays one
  // property lookup for it. See stats.js.
  applyIronLung(s, player.oxygen);

  // --- facing, mirror, roll, crane and the body transform -------------------
  // The whole block moved into poseBody below, so the title screen can pose the
  // seal with exactly this code (systems/titleSeal.js). What the run passes here
  // is what the block used to work out for itself, and nothing else changed.
  //
  // The seal points where it's MOVING by default, not where it's aiming — a
  // swimming animal turns its body to travel, and following the cursor made
  // it twitch on every mouse jiggle while drifting the other way. Aim-facing
  // is still selectable via CONFIG.player.faceMode.
  const useVelocity = CONFIG.player.faceMode !== 'aim';
  poseBody(
    dt,
    useVelocity ? player.velocity.x : input.aim.x,
    useVelocity ? player.velocity.y : input.aim.y,
    {
      // Velocity spends most of a drift near zero, so it needs a floor or the
      // seal spins on rounding noise. An aim vector is always a unit direction
      // and needs none.
      minTurn: useVelocity ? CONFIG.player.minSpeedToTurn : 0.0001,
      // Dashing swaps in its own, much faster facing rate, and a combo scales
      // the normal one — at combo speeds the default smoothing reads as the
      // model lagging behind where you're actually going.
      lerpRate: dashing ? CONFIG.strike.dashFaceLerp : CONFIG.player.turnLerp * combo,
      // A dash redirect still turns over much faster — waiting out a lazy
      // swim turnaround for the model to agree with where you are already
      // going is the "animation has to finish before the input counts" feel.
      // It is a shorter roll now, not an instant flip: the snap this whole
      // mechanism exists to avoid was just as ugly during a dash.
      turnDuration: (!dashing && CONFIG.player.turnAroundEnabled)
        ? CONFIG.player.turnAroundDuration
        : (CONFIG.player.turnAroundDashDuration ?? 0.12),
    },
  );

  if (player.invuln > 0) player.invuln -= dt;

  if (player.hp < s.maxHp) {
    player.hp = Math.min(s.maxHp, player.hp + s.regenPerSec * dt);
  }

  if (CONFIG.animation.enabled && player.anim) {
    // aboveSurface picks the land clips (idle/walk) over the water ones —
    // a seal that's breached shouldn't be swim-cycling through the air.
    const state = stateForSpeed(player.velocity.length(), player.aboveSurface, player.surfaceRest);
    player.anim.update(dt, state, player.hitThisFrame);
    // Straight after the controller, so the breath lands on top of the pose the
    // mixer just wrote rather than under it. Both bones it drives are keyed by
    // every locomotion clip, so this needs no restore of its own — see
    // systems/breathe.js.
    player.breathe?.update(dt, player.surfaceRest);
  }

  // Fin and head IK run AFTER the mixer, deliberately: they overwrite the
  // flipper and neck bones the clip just posed, and nothing else. Outside the
  // CONFIG.animation.enabled gate above, so turning creature animation off
  // leaves the seal still aiming — these are control surfaces, not a
  // performance. This is also the last thing to touch the skeleton before the
  // frame renders, which is what makes the muzzles and bubble anchors it
  // publishes current rather than one frame stale.
  updateAimRig(dt, input.aim, CONFIG.weapon.autofire, player.chargePose);

  player.hitThisFrame = false;
}

/**
 * FACING, MIRROR, ROLL, CRANE AND THE ONE TRANSFORM THEY COMPOSE INTO.
 *
 * Lifted out of updatePlayer unchanged so the title screen can pose the seal
 * with the same code the run does — see systems/titleSeal.js, which turns the
 * animal toward the cursor while the Rive card is up and there is no velocity
 * for the run's own rule to read. Every number the run used to compute inline
 * is now passed in by the run at the single call site above; nothing about the
 * behaviour moved with it.
 *
 * ONE WRITER OF player.body.quaternion, which is the reason this is a whole
 * function rather than two helpers. The mirror, the barrel roll, the crane, the
 * charge tremble and the victory somersault are five axes of the same
 * transform, and any caller that posed a subset of them would be silently
 * throwing the rest away on every frame it ran.
 *
 * @param {number} dt seconds
 * @param {number} dirX where the seal should be pointing, x — need not be unit
 * @param {number} dirY ...and y
 * @param {object} opts
 * @param {number} opts.minTurn below this the direction is treated as absent
 *   and the current facing is held, rather than spinning on rounding noise
 * @param {number} opts.lerpRate how fast the heading chases the target, per second
 * @param {number} opts.turnDuration seconds the half-roll takes when the seal
 *   crosses from facing one way to the other
 */
export function poseBody(dt, dirX, dirY, { minTurn = 0.0001, lerpRate = 6, turnDuration = 0.35 } = {}) {
  // --- facing -------------------------------------------------------------
  const dirLen = Math.hypot(dirX, dirY);

  // Below the threshold there's no meaningful direction, so hold the current
  // facing instead of spinning on near-zero noise.
  if (dirLen > minTurn) {
    // The art's forward is +Y, so subtract a quarter turn.
    const target = Math.atan2(dirY, dirX) - Math.PI / 2;
    // Smooth toward the target the SHORT way around, so crossing the
    // -pi/pi seam doesn't send it spinning the long way. Frame-rate
    // independent, so the feel doesn't change with framerate.
    let delta = target - player.mesh.rotation.z;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const t = 1 - Math.exp(-lerpRate * dt);
    player.mesh.rotation.z += delta * t;

    // In side view a full turn would leave the animal belly-up, so the model
    // is mirrored about its own forward axis instead of rolling over.
    //
    // That mirror used to be a hard 180 swap, hidden by playing a spin CLIP
    // and deferring the swap to the clip's midpoint — the pop was still there,
    // it just happened while the seal was edge-on and hardest to see. Now the
    // mirror is rolled: it is a half turn about the same axis the barrel roll
    // uses, so easing the angle across IS the turnaround, and there is no
    // moment where anything jumps. The clip is gone.
    if (CONFIG.view === 'side') {
      const facingX = Math.cos(player.mesh.rotation.z + Math.PI / 2);
      const wantMirror = facingX < 0;

      if (player.mirrored == null) {
        // First resolve of the run — there is no previous facing to ease from.
        player.mirrored = wantMirror;
        player.mirrorAngle = wantMirror ? Math.PI : 0;
        player.mirrorT = 1;
      } else if (wantMirror !== player.mirrored) {
        // Always rolls the same way rather than unwinding the way it came, so
        // reversing twice reads as one continuous corkscrew instead of a
        // wobble. Started from the CURRENT angle, so a reversal that arrives
        // mid-turnaround simply extends the roll already happening — and
        // ROUNDED OUT to the next half turn that matches the new facing, which
        // is the same guarantee the barrel roll makes when a strike interrupts
        // one (main.js).
        //
        // That rounding is the whole point. This used to add a flat PI to
        // wherever the angle had got to, which is only a half turn if the
        // previous one had FINISHED: reverse after half of a 0.35s turnaround
        // and the seal settles a quarter turn off, and because every later
        // reversal adds another flat PI the offset never comes out. A couple
        // of fast direction changes — a player shimmying left and right, which
        // is most of a dodge — and the animal is stuck swimming belly-up for
        // the rest of the run, with `mirrored` insisting it is upright.
        //
        // The duration travels with the distance, so a corkscrew of one and a
        // half turns keeps the same angular speed as a plain turnaround rather
        // than whipping round in the time budgeted for half of it.
        const HALF = Math.PI;
        const wantParity = wantMirror ? 1 : 0;
        // The next half turn strictly ahead of here, walked on until it is one
        // that leaves the seal upright the new way round.
        let half = Math.floor(player.mirrorAngle / HALF) + 1;
        if (((half % 2) + 2) % 2 !== wantParity) half += 1;
        player.mirrored = wantMirror;
        player.mirrorFrom = player.mirrorAngle;
        player.mirrorTo = half * HALF;
        player.mirrorT = 0;
        player.mirrorDuration = turnDuration * ((player.mirrorTo - player.mirrorFrom) / HALF);
      }
    }
  }

  // Ease the mirror across. Smoothstep, like the barrel roll — a linear sweep
  // starts and stops abruptly, which is the same pop in a different costume.
  if (player.mirrorT < 1) {
    player.mirrorT = Math.min(1, player.mirrorT + dt / Math.max(0.01, player.mirrorDuration));
    const e = player.mirrorT * player.mirrorT * (3 - 2 * player.mirrorT);
    player.mirrorAngle = player.mirrorFrom + (player.mirrorTo - player.mirrorFrom) * e;
    if (player.mirrorT >= 1) {
      // Snapped to the pose it was rolling AT, rather than wrapped off the raw
      // sum: it keeps a long run of reversals from walking the angle up
      // forever and bleeding float precision into everything added to it, and
      // it makes the settled angle exactly one of the two poses — which is
      // what the rounding above divides by, and what main.js reads to decide
      // which way a barrel roll spins.
      player.mirrorAngle = player.mirrored ? Math.PI : 0;
    }
  }

  // --- barrel roll ----------------------------------------------------------
  // Advanced here and composited with the mirror in ONE place, so neither can
  // stomp the other. Whole extra turns, bought with how hard the strike was
  // charged. (The state machine no longer rolls at all — see the note on the
  // mirror above; this is the only thing rolling the seal now.)
  if (player.rollDuration > 0) {
    player.rollElapsed += dt;
    const t = Math.min(1, player.rollElapsed / player.rollDuration);
    // Smoothstep rather than a linear sweep or an ease-out: a roll that starts
    // and stops abruptly reads as a snap, and one that decelerates into the
    // finish reads as running out of steam halfway through the manoeuvre.
    player.rollAngle = player.rollFrom + (player.rollTo - player.rollFrom) * (t * t * (3 - 2 * t));
    if (t >= 1) {
      // Zeroed rather than left at rollTo. Both ends are whole turns, so the
      // two are the same pose, but letting the raw angle accumulate across a
      // run would bleed float precision into the mirror it's added to.
      player.rollDuration = 0;
      player.rollElapsed = 0;
      player.rollFrom = 0;
      player.rollTo = 0;
      player.rollAngle = 0;
    }
  }
  // --- body crane -----------------------------------------------------------
  // A target behind the seal is reached by turning the BODY, not by folding
  // the neck backwards. `glance` is the aim rig's own measure of how far the
  // head has given up (see systems/aimRig.js); the body twists that far toward
  // the camera, which brings the target back inside the head's cone and lets
  // the neck go back to doing something a neck can do.
  //
  // Read from LAST frame's glance on purpose: the rig solves at the end of
  // this function, against the body orientation set here, so using this
  // frame's value would need the rig to run first and then re-pose the body
  // it had already solved against. The value is heavily eased anyway, so a
  // frame of lag is invisible.
  const wantCrane = (player.aimRig?.glance ?? 0) * (CONFIG.head.craneAngle ?? 0);
  player.craneAngle += (wantCrane - player.craneAngle) * (1 - Math.exp(-(CONFIG.head.craneLerp ?? 5) * dt));

  // Wind-up tremble on the body, the companion to the head's (aimRig.js).
  //
  // The amplitude is EASED rather than read straight off chargePose. Releasing
  // drops chargePose to 0 in one frame, and since the shudder is applied raw
  // to the body (unlike the head's, which the IK smoothing rounds off) that
  // left the body snapping up to two degrees on the frame of the launch — a
  // visible tick on the single most-repeated action in the game.
  //
  // THREE CHANNELS, on three incommensurate rates off the one `hz`. One
  // oscillation at any amplitude reads as the seal nodding; three that never
  // line up read as an animal straining against something. See
  // CONFIG.strike.charge.tremble for what each is allowed to be worth.
  const wantShudder = player.chargePose;
  player.shudderAmp += (wantShudder - player.shudderAmp) * (1 - Math.exp(-18 * dt));
  if (player.shudderAmp < 0.001) player.shudderAmp = 0;
  let shudder = 0;
  let rattle = 0;
  if (player.shudderAmp > 0) {
    const vib = CONFIG.strike.charge.tremble ?? {};
    player.chargeClock += dt;
    const w = player.chargeClock * (vib.hz ?? 22) * Math.PI * 2;
    shudder = player.shudderAmp * (vib.body ?? 0) * Math.sin(w);
    // About the seal's own spine, folded into the barrel roll's axis below.
    rattle = player.shudderAmp * (vib.roll ?? 0) * Math.sin(w * 1.37 + 2.1);
    // ...and the one that actually MOVES the animal. Written to the visual
    // root, not to player.mesh — the container carries the position the whole
    // game collides and aims against, and vibrating that would vibrate the
    // hitbox. createVisual hands back a wrapper Group whose position nothing
    // else touches (the model's own fit and offset live on its children), so
    // this owns the field outright and can write it absolutely.
    const sh = player.shudderAmp * (vib.shiver ?? 0);
    player.body.position.set(sh * Math.sin(w * 1.61 + 0.7), sh * Math.sin(w * 0.83 + 3.4), 0);
  } else {
    player.chargeClock = 0;
    // Only when there is something to clear — this runs every frame of every
    // run, and the seal is not winding up for nearly all of them.
    if (player.body.position.lengthSq() !== 0) player.body.position.set(0, 0, 0);
  }

  // One composition for all five. They are separate axes of the same
  // transform, and writing them as Euler components would make the result
  // depend on Euler order — the roll has to happen about the seal's own long
  // axis (+Y is the art's forward) whatever the crane is doing to it, which is
  // exactly what `crane * roll` gives and what `rotation.set(x, y, z)` does
  // not. Crane about the PARENT's X swings the nose out toward the camera and
  // is mirror-independent, since a 180 roll about forward leaves forward alone.
  //
  // The victory somersault is the last term, about the seal's own LATERAL axis
  // — which is also the camera axis, so the turn happens in the screen plane
  // and reads whichever way the seal is facing. It belongs in this composition
  // rather than being written onto the body by systems/celebrate.js for the
  // reason the paragraph above gives: one transform, one writer. It is an
  // angle asked for on demand (a pure function of the celebration clock), so
  // there is no ordering to get wrong and nothing to accumulate on a frame
  // where this function doesn't run.
  _rollQ.setFromAxisAngle(_yAxis, player.mirrorAngle + player.rollAngle + rattle);
  _craneQ.setFromAxisAngle(_xAxis, player.craneAngle + shudder);
  _spinQ.setFromAxisAngle(_zAxis, celebrationSpin());
  player.body.quaternion.copy(_craneQ).multiply(_rollQ).multiply(_spinQ);
}

/**
 * SHOVE THE SEAL. The mirror of applyKnockback in entities/enemies.js, and it
 * makes the same two choices for the same reasons.
 *
 * A POSITION OFFSET, NOT A VELOCITY IMPULSE. `player.velocity` is not a free
 * field: updatePlayer clamps it to the seal's own top speed, bleeds it through
 * the water's friction every frame, reflects it off the arena walls, and the
 * aim, the animation state and the breach test all read it. An impulse added
 * there would be clipped to `maxSpeed` the same frame — so an "extreme" shove
 * would land at whatever the seal could already swim at, and would get WEAKER
 * as the player bought movement upgrades. It would also swing the aim, since
 * velocity is what the aim falls back to when there is no cursor. Held apart,
 * the shove composes with the swimming instead of competing for the field.
 *
 * NOT clamped to the arena here either — the caller's integration runs before
 * clampToArena, so a shove into a wall stops at the wall like anything else.
 * At the default 9/s decay a shove travels speed/9 units and is 95% spent in a
 * third of a second, which is a hit that lands and is over. It is deliberately
 * NOT a hold: nothing here suppresses thrust, so the player can swim out of it
 * from the first frame, and the shove is something they have to swim against
 * rather than something that takes their turn away. See systems/control.js for
 * why that line matters in this game.
 *
 * @param dirX,dirY  direction to shove along; need not be normalised
 * @param speed      world units/sec imparted, before decay
 */
export function applyPlayerKnockback(dirX, dirY, speed) {
  if (CONFIG.playerKnockback?.enabled === false || !(speed > 0)) return 0;
  const len = Math.hypot(dirX, dirY);
  if (len < 1e-6) return 0;
  // A ceiling on what any one source may impart, because this is the one place
  // an enemy writes the player's position and the failure mode is the seal
  // leaving the screen. Per-hit, not cumulative: two shoves in the same moment
  // are meant to stack, a single mistuned one is not meant to be survivable.
  const push = Math.min(speed, CONFIG.playerKnockback?.maxSpeed ?? 60);
  player.knockX += (dirX / len) * push;
  player.knockY += (dirY / len) * push;
  return push;
}

// `share` is the fraction of a volley this shot is — 1 for a volley that left
// every fin at once, and 1/n when alternating fins deal the same volley out
// one limb at a time. The push per second is the property being held constant:
// n shoves of 1/n each is the one shove the gun always gave.
export function applyRecoil(dir, share = 1) {
  if (!CONFIG.weapon.recoilEnabled) return;
  player.velocity.x -= dir.x * player.stats.recoil * share;
  player.velocity.y -= dir.y * player.stats.recoil * share;
}

// Shared by the game loop and by the menus: the rig must keep ticking even
// when updatePlayer isn't running, or the seal idling behind a menu freezes
// its flippers mid-aim and the bubble anchors go stale where they stand.
// `limp` is the death dive (systems/deathDive.js). It doesn't pose anything —
// it just declines to hand the rig over to the one-shot that's playing, which
// matters because 'death' is the one clip that never expires: left suppressed,
// the tail spring's weight eases to zero and the corpse sinks with a tail as
// stiff as a board. The fins and head still go slack, but they do that on
// their own, because the dive stops feeding the rig an aim to point at.
export function updateAimRig(dt, aim, engaged, charge = 0, limp = false) {
  player.aimRig?.update(dt, aim, {
    engaged,
    // Passed through as well as consumed below: the tail is the one chain the
    // rig keeps solving through the death dive, and a dead animal's tail is
    // looser than a swimming one's. See CONFIG.death.flop.tailLooseness.
    limp,
    // 0..1 of a strike being wound up — coils the head back and lifts the
    // tail. Passed in rather than read off strikeState, for the same reason
    // dashTimer and comboSpeedMul are: entities/ doesn't import from systems/.
    charge,
    // One `suppressed` flag for both chains — the fins and the head read it
    // through their own releaseOnOneShot toggles, so either can opt out of
    // handing control back to an authored performance.
    suppressed: !limp && (player.anim?.isPlayingOneShot() ?? false),
  });
}
