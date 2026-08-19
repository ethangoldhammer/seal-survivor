import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { assetBaseColor } from '../assets.js';
import { hitShapeSpheres } from './hitShape.js';

// ---------------------------------------------------------------------------
// THE BOSS GOING UP
//
// A toon smoke explosion — a cauliflower of fused lobes in the dead animal's
// own colour, the size of the dead animal — fired a third of a second before
// the run's photograph is taken.
//
// WHAT IT IS MADE OF is the goo everything else in the game is made of:
// particles flagged `goo: 'boom'` splat into the density field and
// systems/post.js thresholds them into one body, so forty separate lobes weld
// into a single silhouette with a definite line round it. Nothing here draws
// anything. It emits, and the pass that already exists does the rest.
//
// WHAT MAKES IT AN EXPLOSION rather than the puff a burning hull gives off is
// two decisions, and both of them are in this file rather than in the emitter:
//
// THE BLOOM HAPPENS AT BIRTH, NOT UNDER VELOCITY. This fires inside the kill
// shot, which holds the water at a tenth speed for a beat and a half (see
// systems/bossKill.js). Particles move on that dilated clock — one closed form,
// one uniform, no per-burst exception — so a cloud that opened by flying
// outward would get about two hundredths of a second of the water's time before
// the shutter and would be photographed as a tight ball at the boss's nose.
// This one opens in RINGS instead: several waves, each born already at its
// radius, scheduled in WALL seconds. The cloud blooms across a frozen ocean,
// which is both the only way to get it into the picture and the better-looking
// of the two — it is the shape a cel-animated explosion has always had, because
// a drawn one has never had velocity either.
//
// IT IS SIZED OFF THE BODY, MEASURED. Not `def.radius` (the species' figure,
// which a boss is several times over) and not the largest hitbox sphere (the
// body's THICKNESS, which is what a gib should be a fraction of — see
// systems/bossGibs.js) but the EXTENT: how far the animal reaches from its own
// middle. A megalodon is mostly length and a crab is mostly width, and the only
// number that answers "how much frame does this thing take up" for both is the
// one bossCorpse.js already frames the shot with.
//
// TUNING is CONFIG.boss.boom, and every value in it is a multiple of that
// measurement. There is no per-boss row anywhere and there should never be one.
// ---------------------------------------------------------------------------

// Explosions in flight. Almost always one — a second boss killed on top of the
// first is reachable with the debug spawner — and each is a handful of numbers
// plus a cursor into the wave table, never a reference to the creature: the
// body is going back to the pool a fifth of a second after the shutter, and a
// cloud still holding it would be describing whatever animal wore that visual
// next.
const live = [];

const _col = new THREE.Color();
const _tint = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };
const _white = new THREE.Color(1, 1, 1);
const _box = new THREE.Box3();
const _mid = new THREE.Vector3();
const _size = new THREE.Vector3();

function cfg() {
  return CONFIG.boss?.boom ?? {};
}

/**
 * When the explosion goes, in WALL seconds BEFORE the snapshot.
 *
 * Exported because the thing that fires it is a countdown living in
 * systems/bossCorpse.js — that is the only clock in the game already racing
 * the shutter on the wall, and adding a second one here would be a second
 * description of the same moment.
 */
export function bossBoomLead() {
  return Math.max(0, cfg().lead ?? 0.34);
}

// HOW BIG THE ANIMAL IS, in world units, and WHERE ITS MIDDLE IS.
//
// The centre is the volume-weighted centroid of the hitbox rather than
// `mesh.position`: a rig's origin sits wherever the artist left it, which for
// most of the roster is the head, and an explosion centred on the nose of a
// forty-unit shark is a cloud with a whole animal hanging out the back of it.
//
// The radius is then the furthest that hitbox reaches from that centroid, so a
// cloud at `ring: 1` is a cloud the size of the body whichever way the body
// happens to be long. Same measurement bossCorpse.js frames the shot with, for
// the same reason.
//
// Exported for the harness and the look sheet, which both have to be able to
// print the number the effect is actually scaled by rather than a second
// implementation of it that agrees most of the time.
export function measureBossBody(e) {
  const spheres = e?.hitShape ? hitShapeSpheres(e.hitShape) : null;
  const p = e?.mesh?.position;
  let cx = 0;
  let cy = 0;
  let vol = 0;
  if (spheres?.length) {
    for (const s of spheres) {
      if (!(s.wr > 0)) continue;
      const w = s.wr * s.wr * s.wr;
      cx += s.wx * w;
      cy += s.wy * w;
      vol += w;
    }
  }
  if (vol > 0) {
    cx /= vol;
    cy /= vol;
    let r = 0;
    for (const s of spheres) {
      if (!(s.wr > 0)) continue;
      r = Math.max(r, Math.hypot(s.wx - cx, s.wy - cy) + s.wr);
    }
    if (r > 0) return { x: cx, y: cy, r };
  }
  // NO MEASURED HITBOX, and this fallback is not a formality — the king crab
  // has no hit shape at all, and it is the biggest boss in the game.
  //
  // `e.radius` is what systems/bossGibs.js falls back to and it is wrong here
  // for the reason a def radius is always wrong for a crab: that number is its
  // HALF-HEIGHT (it doubles as how high the animal rests off the sand) while
  // the silhouette is three times as wide. Sized off it, the largest animal in
  // the roster went up in the smallest cloud in the game, at a quarter of the
  // megalodon's — which is the exact inversion of the rule this whole file is
  // built on.
  //
  // So the VISUAL is measured instead. Box3 on a skinned body reads the bind
  // -pose bounds through the world matrix rather than the posed vertices, which
  // is a real approximation and a far smaller one than a half-height: it is out
  // by however far the animal has moved from its bind pose, where the radius
  // was out by a factor of three.
  //
  // Once, on the frame of the kill, and never in a loop.
  // `isObject3D`, not a truth test: `mesh` is only an Object3D on a real
  // creature, and Box3.setFromObject throws rather than returning empty on
  // anything else — so a harness body, or a creature whose visual has already
  // gone back to the pool, would take the whole frame down.
  const root = e.visual?.isObject3D ? e.visual : (e.mesh?.isObject3D ? e.mesh : null);
  if (root) {
    _box.makeEmpty();
    _box.setFromObject(root);
    if (!_box.isEmpty() && Number.isFinite(_box.min.x) && Number.isFinite(_box.max.x)) {
      _box.getCenter(_mid);
      _box.getSize(_size);
      // Half the DIAGONAL of the silhouette, which is the same "how far does it
      // reach from its middle" the hitbox branch above returns — not half the
      // width, which would size a long animal off its short axis.
      const r = Math.hypot(_size.x, _size.y) / 2;
      if (r > 0.05) return { x: _mid.x, y: _mid.y, r };
    }
  }
  if (!p) return null;
  return { x: p.x, y: p.y, r: Math.max(0.5, e.radius ?? e.def?.radius ?? 1) };
}

// THE COLOUR OF THE SMOKE, from the colour of the animal.
//
// The raw asset colour cannot be used and this is the whole reason the function
// exists. A boss's colour is a HIDE — the orca is #22303c, the kraken #2a0f14,
// the crab #0d1016, three near-blacks — and the game's composite writes linear
// straight to the framebuffer, so every one of them lands about a stop and a
// half darker still. Tinting smoke with them produces a black cloud on dark
// water: the effect fires, nothing appears, and no amount of tuning the ring
// table finds the problem.
//
// So the HUE is what is taken and the value is set. Hue is the part that
// answers "which boss was that" — a slate-blue cloud for the orca, a dusty red
// one for the kraken — and it is the only part of a hide colour that survives
// being made bright enough to see. Saturation is lifted a little, because
// raising lightness washes it out, and capped, because a boss's smoke should
// not be neon.
//
// Read and written in sRGB rather than in the working space on purpose:
// "lightness" here means what it means to an eye, and the same call in linear
// puts the mid-grey it lands on somewhere quite different.
//
// A GREY ANIMAL STAYS GREY. Its saturation is near zero and it is only ever
// scaled, never floored — a minimum saturation would give the megalodon, whose
// hue is a meaningless 0, a bright red explosion.
function tintFor(hex) {
  const t = CONFIG.boss?.boom?.tint ?? {};
  _tint.set(hex);
  _tint.getHSL(_hsl, THREE.SRGBColorSpace);
  _tint.setHSL(
    _hsl.h,
    Math.min(t.maxSaturation ?? 0.55, _hsl.s * (t.saturation ?? 1.4)),
    Math.max(0, Math.min(1, t.lightness ?? 0.82)),
    THREE.SRGBColorSpace,
  );
  return _tint.getHex();
}

/**
 * Blow this boss up.
 *
 * Called from systems/bossCorpse.js when its wall countdown reaches the lead
 * above, and from main.js's kill hook directly on the frame of the kill when
 * the corpse hold is switched off and there is no countdown to hang it on.
 *
 * The creature is READ HERE AND DROPPED. Everything the waves need — a point,
 * a radius, a colour, a drift — is copied out now, while the body is still
 * posed and still owns its hitbox.
 *
 * @returns true if an explosion was started.
 */
export function fireBossBoom(e) {
  const c = cfg();
  if (c.enabled === false || !e) return false;
  const m = measureBossBody(e);
  if (!m) return false;

  // The animal's own colour, exactly as its death burst and its wreckage take
  // it: the tuned signature where the Look panel has set one, the asset's
  // authored colour behind that. A boss that goes up in some other colour would
  // read as an effect played at a position rather than as THIS boss ending.
  const color = tintFor(assetBaseColor(e.assetKey) ?? CONFIG.boss?.gibs?.fallbackColor ?? 0xc4705c);

  live.push({
    x: m.x,
    y: m.y,
    // Clamped, and both ends earn their place — see the note on minRadius.
    r: Math.max(c.minRadius ?? 2.2, Math.min(c.maxRadius ?? 9, m.r)),
    color,
    // A share of what the animal was doing. A boss killed mid-charge whose
    // cloud hangs exactly where the body was reads as the effect being played
    // at a coordinate; a cloud that carries a little of the run reads as the
    // animal having been there.
    vx: e.vx ?? 0,
    vy: e.vy ?? 0,
    t: 0,
    // How far down the wave table this explosion has got. The waves are in
    // time order and this only ever goes forward, so a frame long enough to
    // cross two of them fires both — a dropped frame should cost the SHAPE of
    // the bloom, never a ring of it.
    next: 0,
  });
  return true;
}

/**
 * @param rawDt UNSCALED seconds. The whole point: see the header. A cloud
 *              scheduled on the world's clock would still be on its first ring
 *              when the shutter went.
 */
export function updateBossBooms(rawDt) {
  if (!live.length) return;
  const c = cfg();
  const waves = Array.isArray(c.waves) ? c.waves : [];
  const sizeMaster = Math.max(0, c.size ?? 1);
  const speedMaster = Math.max(0, c.speed ?? 1);
  const glow = Math.max(0, c.glow ?? 1);

  for (let i = live.length - 1; i >= 0; i--) {
    const b = live[i];
    b.t += rawDt;
    while (b.next < waves.length && b.t >= (waves[b.next].at ?? 0)) {
      fireWave(b, waves[b.next], sizeMaster, speedMaster, glow);
      b.next += 1;
    }
    // Dropped the moment the last ring is out. The particles are the
    // particle system's problem from here, and they outlive this record by
    // seconds — nothing about a cloud already in the water is decided in here.
    if (b.next >= waves.length) live.splice(i, 1);
  }
}

// ONE RING OF LOBES, born at once.
//
// Each puff is its own emit() call, at its own point on the ring, aimed
// outward. That is the whole reason this is a ring rather than one burst with a
// wide speed band: emit() spawns every particle at the point it is given, so
// the only way to be born SPREAD is to be born several times.
function fireWave(b, w, sizeMaster, speedMaster, glow) {
  const puffs = Math.max(1, Math.round(w.puffs ?? 8));
  const ring = b.r * (w.ring ?? 1) * sizeMaster;
  // Size and throw scale together and by the same factor, which is the one
  // lever that means "bigger" without changing the shape — a blob twice as big
  // thrown twice as far fuses exactly as it did. Every other way of scaling goo
  // (the group's radius, its isoline) describes the splats' relationship to
  // each other and comes out as a flat slab or a scatter of dots.
  const lobe = b.r * (w.lobe ?? 0.3) * sizeMaster;
  const throwSpeed = b.r * (w.throw ?? 1) * speedMaster;
  const jitter = Math.max(0, w.jitter ?? 0.25);
  // How far above the body this ring is centred, x the body. Zero for a ball,
  // and the only thing that separates a puffball from a rising column — the
  // rings still open outward, they just open from a point that has climbed.
  const rise = b.r * (w.rise ?? 0) * sizeMaster;

  // The tone. `white` is mixed into the COLOUR (a hot core is whiter, not just
  // brighter) and `tone` rides on the glow rather than on the colour, because
  // emit() lifts a dark tint clear of the water before it uses it — a wave
  // authored at 0.6 of the boss's colour would be lifted straight back to the
  // boss's colour and the ramp across the cloud would quietly not exist. See
  // CONFIG.fx.deathTintMinPeak.
  _col.set(b.color).lerp(_white, Math.max(0, Math.min(1, w.white ?? 0)));

  // The ring is rolled from a different angle per wave, so the four of them
  // don't stack their lobes along the same spokes and draw a star.
  const phase = Math.random() * Math.PI * 2;
  for (let i = 0; i < puffs; i++) {
    const a = phase + (i / puffs) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI * 2 / puffs) * jitter;
    const rr = ring * (1 + (Math.random() - 0.5) * jitter);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    emit('bossBoom', b.x + dx * rr, b.y + rise + dy * rr, {
      // Outward, and the emitter's own cone spreads it from there.
      dirX: dx,
      dirY: dy,
      vx: b.vx,
      vy: b.vy,
      color: _col.getHex(),
      glow: glow * (w.tone ?? 1),
      sizeMul: lobe,
      speedMul: throwSpeed,
    });
  }
}

/**
 * End of a run, or the start of one. Any scheduled rings are dropped WITHOUT
 * being fired: this is a restart, a death, the tuner switching it off, and none
 * of them wants a boss going up over a menu three frames later.
 */
export function resetBossBooms() {
  live.length = 0;
}

/** For the harness. How many explosions still have rings to fire. */
export function bossBoomCount() {
  return live.length;
}
