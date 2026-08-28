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

/** Where the light is right now. Read by the harness and the look sheet. */
export const bossLightState = {
  /** Wall seconds since the light was raised, or -1 when there is none. */
  t: -1,
  /** The envelope, 0..1. What both halves are scaled by. */
  level: 0,
  /** Is a subject body still being lit, or has it burst out from under us. */
  subject: false,
};

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
  const c = cfg();
  const rise = Math.max(0.01, c.rise ?? 0.55);
  const hold = Math.max(0, c.hold ?? 0.9);
  const fall = Math.max(0.01, c.fall ?? 0.7);
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
  const c = cfg();
  return Math.max(0.01, c.rise ?? 0.55)
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
  const y = Math.max(0, Math.min(1, v));
  const halfW = (topW + (botW - topW) * y) / 2;
  const down = (end + (1 - end) * (1 - y) ** falloff) * Math.min(1, y / cap);
  const d = Math.min(1, Math.abs(u) / halfW);
  const across = (1 - d * d) ** 2;
  return Math.max(0, Math.min(1, across * down));
}

function shaftTexture() {
  if (SHAFT.tex) return SHAFT.tex;
  const W = 64;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
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
export function updateBossLight(rawDt, playerPos, playerRoot) {
  if (bossLightState.t < 0) return;
  const c = cfg();
  if (c.enabled === false) { resetBossLight(); return; }

  bossLightState.t += rawDt;
  const level = envelope(bossLightState.t);
  bossLightState.level = level;
  if (bossLightState.t >= bossLightSeconds()) { resetBossLight(); return; }

  updateHero(level, playerPos, playerRoot);
  updateSubject(level);
}

function updateHero(level, playerPos, playerRoot) {
  const c = cfg();
  const s = c.shaft ?? {};
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

  for (const b of hero.blades) {
    const row = b.row;
    const w = width * (row.width ?? 1);
    const h = height * (row.height ?? 1);
    const sway = Math.sin(t * (row.swaySpeed ?? 0.9) + b.phase) * (row.sway ?? 0.12);
    b.mesh.scale.set(w, h, 1);
    const lean = tilt * (row.lean ?? 1) + sway;
    b.mesh.rotation.z = lean;
    const c0 = bladeCentre(playerPos.x + (row.offsetX ?? 0) * width, playerPos.y, h, lean);
    b.mesh.position.set(c0.x, c0.y, row.z ?? -1);
    b.mesh.material.opacity = level * (row.opacity ?? 0.5);
  }

  const p = c.pool ?? {};
  const pw = Math.max(0.5, p.width ?? 12);
  const ph = Math.max(0.5, p.height ?? 7);
  hero.pool.scale.set(pw, ph, 1);
  hero.pool.position.set(playerPos.x, playerPos.y + (p.offsetY ?? 0), p.z ?? -0.9);
  hero.pool.material.opacity = level * (p.opacity ?? 0.55);

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
  heroLift?.set(level * Math.max(0, c.heroLift ?? 1), 'killLightHero');
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
  bossLightState.subject = false;
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

/** For the harness. The envelope, so its shape can be asserted without a scene. */
export function bossLightEnvelope(t) {
  return envelope(t);
}
