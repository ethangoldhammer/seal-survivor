import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { glowSprite, hdr } from './beams.js';
import { attachDamageGlow } from './damageGlow.js';
import { measureBossBody, bossBoomLead } from './bossBoom.js';

// ---------------------------------------------------------------------------
// THE LIGHT ON THE KILL — a hero light on the seal and a light on what it beat,
// raised in the second before the shutter and gone with the shot.
//
// THE PROBLEM IS THE PHOTOGRAPH, not the fight. systems/bossShot.js keeps one
// square PNG per boss killed and the death screen fans them out, and at the
// moment the shutter goes the frame is a dark animal and a dark seal on dark
// water lit by an ambient and a key that were tuned for gameplay legibility at
// full frame, not for a 620-pixel print of two bodies. Both come out as
// silhouettes: you can tell there was a boss, and not which one, or what the
// seal was doing. Everything else about that moment — the push-in, the held
// beat, the cut score — is already built to make it worth keeping.
//
// THERE IS NO REAL LIGHT IN HERE, and that is not an optimisation. This
// project's creatures are deliberately split between lit MeshStandardMaterial
// and unlit MeshBasicMaterial (`modelUnlit`, chosen per creature for a flat
// silhouette) — see the note in systems/beams.js. A SpotLight would illuminate
// half the roster and do nothing whatever to the other half, so the king crab
// would sit in the middle of a beam looking exactly as it did a frame earlier.
// It would also add a light to the scene mid-run, which recompiles every
// material in the water on the frame a boss dies.
//
// So the light is three things that reach every material equally:
//
//   THE SHAFT     Additive quads over the water — the fake-volumetric cone,
//                 baked into a texture rather than a shader so it can be
//                 verified without a GPU. Blades in front of the seal and
//                 behind it, because what makes a shaft read as VOLUME is that
//                 some of it is between you and the thing it is lighting.
//   THE POOL      A wide flat glow where the shaft lands, so the light has
//                 somewhere to arrive. Without it the cone hangs in the water
//                 with nothing under it and reads as a curtain.
//   THE LIFT      The bodies' own materials brought up, through the shared
//                 damage-glow handle. This is the half that actually answers
//                 "which animal was that": a backlight separates a hide from
//                 the water, and only a lift on the hide itself puts anything
//                 back INSIDE the silhouette.
//
// IT IS ON THE WALL CLOCK, for the reason systems/bossBoom.js is: the kill shot
// holds the water at a tenth speed for a beat and a half, and a rise scheduled
// on the world's clock would still be at a tenth brightness when the picture is
// taken. The lead is derived from the shot's own timing (snapshotMoment, via
// systems/bossCorpse.js's countdown) rather than typed, so retuning the beat
// moves the light with it instead of leaving it behind.
//
// TUNING is CONFIG.boss.light. Nothing here damages anything, moves anything or
// is tested against a radius.
// ---------------------------------------------------------------------------

// WHERE THE FRAME IS, handed in every update — see bladeReach. Held on the
// module rather than threaded through updateHero because it is a property of
// the SHOT, not of the light, and every part of the draw that ever needs to
// know whether something is on screen will want the same answer.
let framed = null;

/** Where the light is right now. Read by the harness and the look sheet. */
export const bossLightState = {
  /** Wall seconds since the light was raised, or -1 when there is none. */
  t: -1,
  /** The envelope, 0..1. What both halves are scaled by. */
  level: 0,
  /** ...and the level actually drawn, which for a borrowed light breathes. */
  lit: 0,
  /** Where the shaft is standing — the seal, plus whatever the wander adds. */
  atX: 0,
  atY: 0,
  /** Is a subject body still being lit, or has it burst out from under us. */
  subject: false,
  /**
   * WHAT RAISED IT. 'kill' is the boss shutter this file was written for;
   * 'goal' is a versus goal borrowing the hero half alone (see fireHeroLight).
   * Null when nothing is lit.
   */
  mode: null,
};

// ---------------------------------------------------------------------------
// THE HERO HALF, LENT OUT — see fireHeroLight.
//
// A versus goal wants exactly the shaft and the pool, on a seal that is not
// necessarily player 1, on a beat that is not the kill shutter's. Everything
// it needs is already here and none of it is the boss's: duplicating the cone
// into a second module would give the game two shafts that agreed on the day
// they were written and drifted the first time either was tuned.
//
// So: an override record, or null for the kill. It carries its own envelope,
// its own subject (a getter, because the seal moves and this file must not
// hold a reference to a body that can be swapped), and the two numbers that
// make a borrowed light look like weather rather than a switch.
// ---------------------------------------------------------------------------
let override = null;

let scene = null;

// The seal's half of it — one group, built once and reused, because the player
// is a singleton and rebuilding a cone of quads per boss is work for nothing.
let hero = null;
// Its lift handle, attached lazily to the body that is actually on screen.
// Rebuilt when the seal's body is swapped (see rebuildShipBody in
// entities/player.js), which is detectable because the handle's materials stop
// belonging to anything in the scene — cheaper to compare the root.
let heroLift = null;
let heroRoot = null;

// What the boss half is lighting. Never a reference to the creature: the body
// goes back to the pool a fifth of a second after the shutter, and a light
// still holding it would be lighting whatever animal wore that visual next.
const subject = {
  live: false,
  x: 0,
  y: 0,
  rx: 1,
  ry: 1,
  mesh: null,
  lift: null,
  // The creature, held ONLY between the fire and the burst, and only so that
  // the light can follow a body that is still drifting and sinking. Dropped by
  // dropBossLightSubject before the visual is released.
  e: null,
};

const SHAFT = { tex: null };

function cfg() {
  return CONFIG.boss?.light ?? {};
}

/**
 * When the light goes up, in WALL seconds BEFORE the snapshot.
 *
 * ITS OWN RISE, PLUS THE EXPLOSION'S LEAD, and the second half is the part
 * worth stating. The light has to be AT FULL before the smoke arrives, not
 * before the shutter: the cloud is the brightest thing in the frame for the
 * third of a second either side of the picture, and a key that comes up
 * underneath it is a key nobody can tell was ever switched on. Timing it off
 * `rise` alone put it a fifth of a second BEHIND the boom at the shipped
 * tuning, which reads as the explosion lighting the seal rather than the other
 * way round.
 *
 * Derived from bossBoomLead rather than kept longer than a copy of it, because
 * both are tuned and a pair of hand-kept numbers drifts the first time either
 * moves. Where this comes out longer than the whole corpse hold the light
 * simply goes up on the killing frame, which is right rather than broken.
 *
 * Exported because the thing that fires it is the countdown in
 * systems/bossCorpse.js, which is the only clock in the game already racing the
 * shutter on the wall. Same arrangement as bossBoomLead.
 */
export function bossLightLead() {
  const c = cfg();
  if (c.enabled === false) return 0;
  return Math.max(0, c.rise ?? 0.55) + bossBoomLead();
}

// The envelope. Up over `rise`, flat over `hold`, out over `fall`, and the
// smoothstep on the way in is what stops the shaft appearing as a hard-edged
// wedge on one frame.
function envelope(t) {
  const c = override ?? cfg();
  const delay = Math.max(0, c.delay ?? 0);
  const rise = Math.max(0.01, c.rise ?? 0.55);
  const hold = Math.max(0, c.hold ?? 0.9);
  const fall = Math.max(0.01, c.fall ?? 0.7);
  // A DELAY BEFORE THE RISE, for a light that is meant to come up AFTER
  // something else. The kill has none — it is racing a shutter and its lead is
  // derived so that it is already at full when the smoke arrives. A goal is
  // the other way round: the explosion is the event and the light is the
  // thing that answers it, so it waits.
  t -= delay;
  if (t <= 0) return 0;
  if (t < rise) {
    const u = t / rise;
    return u * u * (3 - 2 * u);
  }
  if (t < rise + hold) return 1;
  const u = (t - rise - hold) / fall;
  if (u >= 1) return 0;
  return (1 - u) * (1 - u);
}

/** How long the whole light lasts, in wall seconds. */
export function bossLightSeconds() {
  const c = override ?? cfg();
  return Math.max(0, c.delay ?? 0)
    + Math.max(0.01, c.rise ?? 0.55)
    + Math.max(0, c.hold ?? 0.9)
    + Math.max(0.01, c.fall ?? 0.7);
}

// ---------------------------------------------------------------------------
// THE SHAFT, AS A PICTURE
// ---------------------------------------------------------------------------
// The cone is BAKED, not shaded. An injected shader that fails to compile
// renders nothing at all, throws nothing, and cannot be caught from a Node
// harness (see the note in systems/beams.js); a canvas the harness can read
// back pixel by pixel is boring and provable. It is also one 64x256 upload for
// the whole run.
//
// THE PROFILE IS IN THE ALPHA ONLY. THREE's AdditiveBlending is (SrcAlpha, One),
// so the alpha already multiplies the colour — writing the falloff into the rgb
// as well squares it, and a shaft authored to fade over its length instead
// vanishes over the first third of it.
//
// WHAT MAKES IT A SHAFT rather than a stripe is two gradients that are not the
// same shape. Across, a quartic that has no edge at all. Down, the light
// running OUT: a god ray reads as one because you can see it being eaten by the
// water, and a band of even brightness from the surface to the seabed reads as
// a wall. The cone widens on the way down for the same reason a real one does.
/**
 * The cone's alpha at one point of it. `u` is -0.5..0.5 across the quad and `v`
 * is 0..1 down it, 0 being the end the light comes from.
 *
 * A PURE FUNCTION, and that is the point: the bake below needs a 2D canvas
 * context, which a Node harness does not have (three.js throws from inside
 * CanvasTexture without one), so the SHAPE of the shaft would be the one part
 * of this system nothing could check. Split out, the harness reads the cone
 * off this and the texture is only the upload.
 */
export function shaftAlpha(u, v) {
  const c = cfg().shaft ?? {};
  const topW = Math.max(0.02, c.topWidth ?? 0.34);
  const botW = Math.max(0.02, c.bottomWidth ?? 1);
  const falloff = Math.max(0, c.falloff ?? 1.35);
  // How much of the length is spent fading in at the top. The shaft has no
  // source in the frame — the surface is off the top of most shots — so an
  // abrupt start reads as the quad's own edge.
  const cap = Math.max(0.001, c.capFade ?? 0.09);
  // HOW MUCH OF THE LIGHT SURVIVES TO THE LANDING, and this is not the same
  // decision as the falloff. Taken to zero at the bottom — which is what a god
  // ray dying in deep water does — the cone is brightest thirty units above the
  // seal and has nothing left by the time it reaches it, so the hero light is a
  // bright patch of empty water with a dark animal underneath. It still runs
  // out; it just arrives first.
  const end = Math.max(0, Math.min(1, c.endLevel ?? 0.45));
  // ...AND THE FOOT IS NOT A CUT EITHER. `endLevel` is how much of the light
  // survives to the landing, which is a brightness and not an ending: with the
  // quad simply stopping there, the bottom of every blade was a straight line
  // across the water at 45% alpha — the hard edge this whole bake exists to
  // avoid, at the one end nobody thought to fade because the pool was assumed
  // to cover it. It covers the last unit or two, not a lit edge.
  //
  // A FRACTION OF THE LENGTH, like the cap: the blades are no longer a fixed
  // 30 units (see bladeReach), so an absolute fade would be most of a short
  // one and invisible on a long one. Kept small enough to sit inside the pool
  // at any length the reach asks for.
  const foot = Math.max(0.001, c.footFade ?? 0.05);
  const y = Math.max(0, Math.min(1, v));
  const halfW = (topW + (botW - topW) * y) / 2;
  const down = (end + (1 - end) * (1 - y) ** falloff)
    * Math.min(1, y / cap) * Math.min(1, (1 - y) / foot);
  const d = Math.min(1, Math.abs(u) / halfW);
  const across = (1 - d * d) ** 2;
  return Math.max(0, Math.min(1, across * down));
}

/**
 * The baked cone, or NULL where there is no 2D canvas to bake it on.
 *
 * A Node harness's document stub returns null from getContext('2d') — see the
 * note at shaftAlpha — and this used to reach straight through it and take the
 * frame down from inside three.js with a message about createImageData, on a
 * line that has nothing to do with what the caller was checking. The map is
 * the LOOK; the geometry, the placement and the envelope are the mechanics,
 * and there is no reason a harness should be unable to exercise those. Without
 * a map the blades are plain additive quads: wrong to look at, right in every
 * way anything headless can measure, and never on a screen because a browser
 * always has the context.
 */
function shaftTexture() {
  if (SHAFT.tex) return SHAFT.tex;
  const W = 64;
  const H = 256;
  const cv = document.createElement?.('canvas');
  const g = cv?.getContext?.('2d');
  if (!g?.createImageData) return null;
  cv.width = W;
  cv.height = H;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const a = shaftAlpha(x / (W - 1) - 0.5, v);
      const i = (y * W + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  SHAFT.tex = tex;
  return tex;
}

/** Drop the baked cone, so a retune of its shape is picked up. */
export function clearBossLightCache() {
  if (SHAFT.tex) SHAFT.tex.dispose();
  SHAFT.tex = null;
  if (hero) {
    disposeGroup(hero.group);
    hero = null;
  }
}

function additiveMesh(map, color, renderOrder) {
  const mat = new THREE.MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.renderOrder = renderOrder;
  mesh.visible = false;
  return mesh;
}

// THE BLADES. Several overlapping cones rather than one, and the reason is the
// word "volumetric": a single quad is a picture of a shaft, where three at
// different widths, leans and speeds is a shaft you are looking THROUGH. They
// are additive, so where two of them cross is brighter, which is the only cue
// this fake has for depth.
//
// SOME IN FRONT OF THE SEAL AND SOME BEHIND. All behind and the animal stands
// in a lit doorway; all in front and it is behind a curtain. Split, there is
// light between the camera and the subject and light past it, which is what a
// real shaft in real water does and what the eye is actually reading.
function buildHero() {
  const c = cfg();
  const s = c.shaft ?? {};
  const map = shaftTexture();
  const color = hdr(s.color ?? 0xfff2dc, s.overdrive ?? 1.5);
  const group = new THREE.Group();
  const blades = [];
  const rows = Array.isArray(s.blades) ? s.blades : [];
  for (const row of rows) {
    // In front of the seal or behind it. `renderOrder` decides nothing here —
    // these are transparent and unsorted against a depth buffer they do not
    // write — so the z IS the layering.
    const mesh = additiveMesh(map, color, 6);
    group.add(mesh);
    blades.push({ mesh, row, phase: Math.random() * Math.PI * 2 });
  }
  const pool = additiveMesh(glowSprite(), hdr(c.pool?.color ?? s.color ?? 0xfff2dc,
    c.pool?.overdrive ?? 1.2), 5);
  group.add(pool);
  scene.add(group);
  return { group, blades, pool };
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
  });
  group.parent?.remove(group);
}

// ---------------------------------------------------------------------------
// Life
// ---------------------------------------------------------------------------

/** Hand the module its scene. Called once at boot beside initBossBooms. */
export function initBossLight(sc) {
  scene = sc ?? null;
}

/** Drop everything and forget the scene. */
export function disposeBossLight() {
  resetBossLight();
  clearBossLightCache();
  scene = null;
}

/**
 * Raise the light on this body and on the seal.
 *
 * Called from systems/bossCorpse.js when its wall countdown reaches the lead
 * above — the same trigger and the same latch the explosion uses, because they
 * are two parts of one moment and a second countdown would drift the first time
 * the beat was retuned.
 *
 * The creature is held only until it bursts (see dropBossLightSubject), and
 * only so that the light follows a body that is still drifting.
 *
 * @returns true if a light was raised.
 */
export function fireBossLight(e) {
  const c = cfg();
  if (c.enabled === false || !e) return false;
  const m = measureBossBody(e);
  override = null;
  bossLightState.mode = 'kill';
  bossLightState.t = 0;
  bossLightState.level = 0;
  bossLightState.subject = !!m;
  if (m) {
    subject.live = true;
    subject.e = e;
    subject.x = m.x;
    subject.y = m.y;
    // THE WASH IS SHAPED LIKE THE ANIMAL. A round glow on a thirty-unit shark
    // lights its middle and leaves both ends in the water, which in a square
    // crop is a bright patch with a dark nose and a dark tail sticking out of
    // it. The two half-extents come off the same hitbox the explosion is
    // measured from, so a crab is lit wide and a megalodon long.
    const ext = extents(e, m);
    subject.rx = ext.rx;
    subject.ry = ext.ry;
    // The lift on the hide itself. Attached to the VISUAL rather than the mesh
    // container: the container carries the position and has no materials on it.
    //
    // `isObject3D`, not a truth test, and for the same reason measureBossBody
    // checks it: `mesh` is only an Object3D on a real creature. The workbench's
    // Fire button and main.js's no-corpse path both build a body that is a
    // point and a radius, and traverse() on one of those throws rather than
    // returning nothing — which takes down the frame a boss died on.
    const root = e.visual?.isObject3D ? e.visual : (e.mesh?.isObject3D ? e.mesh : null);
    subject.lift = root ? attachDamageGlow(root) : null;
  }
  return true;
}

/**
 * RAISE THE HERO HALF ALONE, on a seal of the caller's choosing and to the
 * caller's own beat — the shaft and the pool and the lift on the hide, with no
 * subject and no boss anywhere in it.
 *
 * WHY IT LIVES HERE. Every part of this is the kill light's: the baked cone,
 * the blades split in front of and behind the animal, the landing hung by the
 * bottom edge, the lift through the shared damage-glow handle. A second copy
 * in versus.js would be a second shaft that agreed with this one until the
 * first time either was tuned. What a goal actually needs is different TIMING
 * and a different SUBJECT, and both of those are arguments.
 *
 * @param opts.follow  () => ({ pos, root }) — the seal to light, read every
 *                     frame. A getter and not a body, because the scorer may
 *                     be player 2, whose visual is rebuilt when its body is
 *                     swapped, and this file must never hold that reference.
 * @param opts.delay   wall seconds before the rise begins.
 * @param opts.rise/hold/fall  the envelope, as CONFIG.boss.light's.
 * @param opts.breathe how much the level wanders about itself, 0..1.
 * @param opts.wander  how far the landing drifts off the seal, in world units.
 * @param opts.lift    the lift on the seal's own hide, x the master.
 */
export function fireHeroLight(opts = {}) {
  const c = cfg();
  if (c.enabled === false || typeof opts.follow !== 'function') return false;
  override = {
    delay: Math.max(0, opts.delay ?? 0),
    rise: Math.max(0.01, opts.rise ?? 0.6),
    hold: Math.max(0, opts.hold ?? 1),
    fall: Math.max(0.01, opts.fall ?? 0.9),
    breathe: Math.max(0, Math.min(1, opts.breathe ?? 0.14)),
    wander: Math.max(0, opts.wander ?? 1.2),
    wanderSpeed: Math.max(0, opts.wanderSpeed ?? 0.55),
    lift: Math.max(0, opts.lift ?? 1),
    follow: opts.follow,
  };
  bossLightState.mode = 'goal';
  bossLightState.t = 0;
  bossLightState.level = 0;
  bossLightState.subject = false;
  subject.live = false;
  subject.e = null;
  return true;
}

// How far the body reaches on each axis, for the wash's ellipse. Off the hitbox
// where there is one and off the visual's bounds where there is not — the same
// two-step measureBossBody makes, and for the same reason: the king crab has no
// hit shape and is the biggest boss in the game.
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
function extents(e, m) {
  let rx = 0;
  let ry = 0;
  const spheres = e?.hitShape?.spheres;
  if (spheres?.length) {
    for (const s of spheres) {
      if (!(s.wr > 0)) continue;
      rx = Math.max(rx, Math.abs(s.wx - m.x) + s.wr);
      ry = Math.max(ry, Math.abs(s.wy - m.y) + s.wr);
    }
  }
  if (!(rx > 0) || !(ry > 0)) {
    const root = e?.visual?.isObject3D ? e.visual : (e?.mesh?.isObject3D ? e.mesh : null);
    if (root) {
      _box.makeEmpty();
      _box.setFromObject(root);
      if (!_box.isEmpty() && Number.isFinite(_box.min.x)) {
        _box.getSize(_size);
        rx = Math.max(rx, _size.x / 2);
        ry = Math.max(ry, _size.y / 2);
      }
    }
  }
  return { rx: Math.max(0.5, rx || m.r), ry: Math.max(0.5, ry || m.r) };
}

/**
 * The body is about to burst and go back to the pool.
 *
 * Called from systems/bossCorpse.js's burst, BEFORE releaseVisual. Two things
 * have to happen here and neither can wait for the envelope to finish: the lift
 * has to come off the materials, or a pooled body carries a boss's key light
 * into whatever creature wears it next, and the creature reference has to go,
 * for the same reason.
 *
 * The wash stays — it keeps the position it last had and fades on its own. The
 * light outliving the body by a moment is correct: it is what is over the
 * wreckage while the print flies to the corner.
 */
export function dropBossLightSubject(e) {
  if (e && subject.e && subject.e !== e) return;
  subject.lift?.release();
  subject.lift = null;
  subject.e = null;
}

/**
 * @param rawDt UNSCALED seconds. The whole point — see the header.
 * @param playerPos where the seal is, or null for no hero half. Passed in
 *                  rather than imported so this module never reaches into the
 *                  player, exactly as systems/bossKill.js is handed its framing.
 * @param playerRoot the seal's body, for the lift. Optional.
 */
/**
 * @param view  world.framedView() — where the frame actually is, so the shaft
 *              can be lengthened until its ORIGIN is off the top of it. Null
 *              from a harness, which falls back to the authored length; see
 *              bladeReach.
 */
export function updateBossLight(rawDt, playerPos, playerRoot, view = null) {
  framed = view ?? null;
  if (bossLightState.t < 0) return;
  const c = cfg();
  if (c.enabled === false) { resetBossLight(); return; }

  bossLightState.t += rawDt;
  const level = envelope(bossLightState.t);
  bossLightState.level = level;
  if (bossLightState.t >= bossLightSeconds()) { resetBossLight(); return; }

  // A BORROWED LIGHT BRINGS ITS OWN SUBJECT. Read every frame rather than
  // captured at fire time: the seal it is on is swimming, and on player 2 the
  // visual is a different object after a body swap.
  let pos = playerPos;
  let root = playerRoot;
  if (override) {
    const on = override.follow();
    pos = on?.pos ?? null;
    root = on?.root ?? null;
  }
  // WHERE THE LIGHT IS STANDING AND HOW BRIGHT IT IS, worked out here and
  // PUBLISHED rather than computed inside the draw. Both are answers about the
  // light — a harness with no 2D canvas can check them, and the workbench can
  // read them — and a number that only exists as a local inside the function
  // that positions a quad is a number nothing can ask about.
  organics(level, pos);
  updateHero(pos, root);
  updateSubject(level);
}

// THE ORGANIC HALF — see CONFIG.versus.goal.spotlight. Only a borrowed light
// breathes; the kill's is racing a shutter and wants to be exactly as bright
// as its envelope says on the frame the picture is taken.
function organics(level, pos) {
  bossLightState.lit = level;
  bossLightState.atX = pos?.x ?? 0;
  bossLightState.atY = pos?.y ?? 0;
  if (!override || !pos) return;
  const t = bossLightState.t;
  // BREATHE. Three sines at rates sharing no common period, so the pattern
  // does not repeat inside the few seconds anyone is looking at it — one sine
  // reads as a pulse and a random walk reads as a fault in the renderer.
  // Normalised so the sum can only pull the level DOWN: a light that
  // overshoots its own envelope pops on the frame the hold begins.
  const b3 = Math.sin(t * 0.83) + Math.sin(t * 1.47 + 1.7) + Math.sin(t * 2.31 + 4.1);
  bossLightState.lit = level * (1 - override.breathe * (0.5 - b3 / 6));
  // WANDER. Small — a couple of units on a thirty-unit shaft — because past
  // that it stops being light moving and starts being a light aimed at the
  // wrong animal. The blades and the pool both take it, or the pool detaches
  // and the shaft is left pointing beside its own landing.
  // BOTH TERMS START AT ZERO PHASE, and neither is a near-harmonic of the
  // other. Phase-shifted, the second sine spends the light's whole life moving
  // AGAINST the first: at the shipped rates that cancelled the drift down to a
  // seventh of what it should have been, so the light sat a little off centre
  // and never actually went anywhere. Zero phase also means the light starts
  // exactly on the seal and drifts off it, rather than arriving beside it.
  const w = override.wander;
  const ws = override.wanderSpeed;
  bossLightState.atX += (Math.sin(t * ws) + Math.sin(t * ws * 2.7) * 0.5) * w * 0.55;
  bossLightState.atY += Math.sin(t * ws * 0.53) * w * 0.25;
}

/**
 * HOW LONG A BLADE HAS TO BE FOR ITS ORIGIN TO BE OFF THE TOP OF THE FRAME.
 *
 * The authored `height` is a length in world units and the frame is not: the
 * camera zooms from a kill shot pushed in on one animal out to a Blubberball
 * pitch at 0.55, so the same thirty units is comfortably past the top edge in
 * one shot and stops a third of the way up the screen in the other. A shaft
 * whose top edge is in the crop reads as a quad, which is the one thing this
 * whole bake is arranged to avoid — the cone's alpha fades in over `capFade`
 * precisely so the start is not a line, and a fade that ENDS on screen is
 * still a visible top to the light.
 *
 * THE LEAN IS WHY IT IS NOT JUST A SUBTRACTION. A blade is rotated about its
 * foot, so a length h only reaches cos(lean) x h above where it lands — at the
 * shipped rake that is most of it, and at any rake worth calling a rake it
 * stops being negligible. `clearTop` is how far past the edge the origin sits,
 * so a camera that pans up a little during the hold does not find it.
 *
 * @param atY      where the blade lands
 * @param lean     radians, including this frame's sway
 * @param authored what the config asked for, which is the FLOOR: a frame that
 *                 happens to be short must not make the light stubby.
 */
export function bladeReach(atY, lean, authored, view = framed) {
  const c = cfg().shaft ?? {};
  if (!view || !(view.halfH > 0)) return authored;
  const clear = Math.max(0, c.clearTop ?? 6);
  const top = view.y + view.halfH;
  // Guarded: a blade raked past about eighty degrees reaches almost nothing
  // upward, and dividing by its cosine asks for a shaft the length of the
  // arena. Nothing in the roster is near that, and the guard is what stops a
  // tuning slider being able to ask for one.
  const up = Math.max(0.2, Math.cos(lean));
  return Math.max(authored, (top + clear - atY) / up);
}

function updateHero(playerPos, playerRoot) {
  const c = cfg();
  const s = c.shaft ?? {};
  const level = bossLightState.lit;
  if (!scene || !playerPos || s.enabled === false) {
    if (hero) setHeroVisible(false);
    return;
  }
  if (!hero) hero = buildHero();
  setHeroVisible(level > 0.001);
  if (!(level > 0.001)) return;

  const height = Math.max(1, s.height ?? 26);
  const width = Math.max(0.5, s.width ?? 7);
  const tilt = s.tilt ?? 0.16;
  // The shaft's own clock, in wall seconds — the sway has to keep moving while
  // the water is held at a tenth speed, or the one held beat in the game is the
  // one place the light stands perfectly still.
  const t = bossLightState.t;

  const lit = level;
  const atX = bossLightState.atX;
  const atY = bossLightState.atY;

  for (const b of hero.blades) {
    const row = b.row;
    const w = width * (row.width ?? 1);
    const sway = Math.sin(t * (row.swaySpeed ?? 0.9) + b.phase) * (row.sway ?? 0.12);
    const lean = tilt * (row.lean ?? 1) + sway;
    // PER BLADE, not once for the group. The rows are authored at different
    // lengths on purpose, and a single base long enough for the shortest of
    // them would stretch the long ones — the alpha profile runs along the
    // quad, so a longer blade is a slower falloff and a different light.
    // Lengthening only the rows that need it keeps every one of them at least
    // as long as it asked to be and none of them ending on screen.
    const h = bladeReach(atY, lean, height * (row.height ?? 1));
    b.mesh.scale.set(w, h, 1);
    b.mesh.rotation.z = lean;
    const c0 = bladeCentre(atX + (row.offsetX ?? 0) * width, atY, h, lean);
    b.mesh.position.set(c0.x, c0.y, row.z ?? -1);
    b.mesh.material.opacity = lit * (row.opacity ?? 0.5);
  }

  const p = c.pool ?? {};
  const pw = Math.max(0.5, p.width ?? 12);
  const ph = Math.max(0.5, p.height ?? 7);
  hero.pool.scale.set(pw, ph, 1);
  hero.pool.position.set(atX, atY + (p.offsetY ?? 0), p.z ?? -0.9);
  hero.pool.material.opacity = lit * (p.opacity ?? 0.55);

  // AND THE SEAL ITSELF. The shaft is light in the water; this is the light
  // arriving on the animal, and without it the seal is a silhouette standing in
  // a bright cone — which is a worse photograph than the one this replaced,
  // because now something in the frame is obviously lit and the subject
  // obviously is not.
  const root = playerRoot ?? null;
  if (root && root !== heroRoot) {
    heroLift?.release();
    heroLift = attachDamageGlow(root);
    heroRoot = root;
  }
  // The hide takes the BREATHING level too, or the animal sits at a constant
  // brightness inside a light that is visibly moving over it.
  heroLift?.set(lit * Math.max(0, override?.lift ?? c.heroLift ?? 1), 'killLightHero');
}

/**
 * Where a blade's CENTRE goes so that its bottom edge lands on (px, py).
 *
 * THE SHAFT IS HUNG BY ITS BOTTOM EDGE, not by its middle, and that is the
 * whole reason this is a function rather than two lines inline. The rake is the
 * look — an upright shaft is a spotlight rig and a leaned one is light arriving
 * from somewhere — and a blade rotated about its centre swings its LANDING
 * sideways by half a length. Thirty units of shaft at a sixth of a radian puts
 * the pool two and a half units off the animal, which on screen is a beautiful
 * god ray pointed at the water beside the seal.
 *
 * The quad's local +Y under a rotation of `lean` is (-sin, cos). The sign of
 * that first term is the entire correction, and having it backwards moves the
 * landing by twice the error instead of to the middle — which is exactly what
 * shipped in the first pass, and looked deliberate.
 *
 * Pure and exported so tools/boss-light-test.mjs can assert the landing without
 * a scene: the whole failure is invisible to anything that checks the shaft
 * exists, is bright, and is the right length.
 */
const _centre = { x: 0, y: 0 };
export function bladeCentre(px, py, height, lean) {
  _centre.x = px - Math.sin(lean) * (height / 2);
  _centre.y = py + Math.cos(lean) * (height / 2);
  return _centre;
}

function setHeroVisible(on) {
  if (!hero) return;
  for (const b of hero.blades) b.mesh.visible = on;
  hero.pool.visible = on;
}

function updateSubject(level) {
  if (!subject.live) return;
  const c = cfg();
  const w = c.wash ?? {};
  // Follows the body while there is one — a corpse drifts and sinks for the
  // whole of this — and holds its last position once it has burst.
  if (subject.e?.mesh?.position) {
    subject.x = subject.e.mesh.position.x;
    subject.y = subject.e.mesh.position.y;
  }
  if (scene && w.enabled !== false) {
    if (!subject.mesh) {
      subject.mesh = additiveMesh(glowSprite(),
        hdr(w.color ?? 0xbfe4ff, w.overdrive ?? 1.1), 4);
      scene.add(subject.mesh);
    }
    subject.mesh.visible = level > 0.001;
    // BEHIND THE BODY, which is the whole job. A wash laid over a near-black
    // hide brightens the hide and the water equally and the silhouette stays
    // exactly as unreadable as it was; laid behind it, the hide is the one dark
    // shape on a light field and reads instantly. See the note on hides in
    // systems/bossBoom.js — every boss in the roster is one.
    subject.mesh.position.set(subject.x, subject.y, w.z ?? -1.2);
    subject.mesh.scale.set(
      subject.rx * 2 * (w.spread ?? 1.5),
      subject.ry * 2 * (w.spread ?? 1.5),
      1,
    );
    subject.mesh.material.opacity = level * (w.opacity ?? 0.5);
  }
  subject.lift?.set(level * Math.max(0, c.subjectLift ?? 1), 'killLightSubject');
}

/**
 * End of a run, or the end of the light. Everything goes back to nothing: the
 * lifts are released (a pooled body must not carry a boss's key light), the
 * meshes are hidden, and the creature reference is dropped.
 */
export function resetBossLight() {
  bossLightState.t = -1;
  bossLightState.level = 0;
  bossLightState.lit = 0;
  bossLightState.subject = false;
  bossLightState.mode = null;
  override = null;
  setHeroVisible(false);
  heroLift?.release();
  subject.lift?.release();
  subject.lift = null;
  subject.e = null;
  subject.live = false;
  if (subject.mesh) {
    disposeGroup(subject.mesh);
    subject.mesh = null;
  }
}

/**
 * For the harness. What the boss half is lighting: where, how big, and whether
 * it still has hold of a body's materials.
 *
 * A copy rather than the record — nothing outside this file should be able to
 * take a reference to a creature that is about to go back to the pool, which is
 * the mistake the whole `subject` record is arranged to prevent.
 */
export function bossLightSubject() {
  return {
    live: subject.live,
    x: subject.x,
    y: subject.y,
    rx: subject.rx,
    ry: subject.ry,
    held: !!subject.e,
    lifted: !!subject.lift,
  };
}

/** For the harness. Every mesh this system has in the scene right now. */
export function bossLightMeshes() {
  const out = [];
  if (hero) {
    for (const b of hero.blades) if (b.mesh.visible) out.push(b.mesh);
    if (hero.pool.visible) out.push(hero.pool);
  }
  if (subject.mesh?.visible) out.push(subject.mesh);
  return out;
}

/**
 * THE ENVELOPE THAT IS ACTUALLY RUNNING, in wall seconds.
 *
 * Not the same numbers as the tuning when a borrowed light is up: a goal's
 * ramps are squeezed to fit the celebration (see spotlightScorer in
 * versus.js), so CONFIG says what was asked for and this says what happened.
 * The workbench reads it, and so does anything asserting the shape.
 */
export function bossLightShape() {
  const c = override ?? cfg();
  return {
    delay: Math.max(0, c.delay ?? 0),
    rise: Math.max(0.01, c.rise ?? 0.55),
    hold: Math.max(0, c.hold ?? 0.9),
    fall: Math.max(0.01, c.fall ?? 0.7),
    borrowed: !!override,
  };
}

/** For the harness. The envelope, so its shape can be asserted without a scene. */
export function bossLightEnvelope(t) {
  return envelope(t);
}
