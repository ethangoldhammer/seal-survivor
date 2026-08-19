import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { assetBaseColor } from '../assets.js';
import { hitShapeSpheres } from './hitShape.js';
import {
  makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing,
} from './organicRing.js';

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

// The fronts. Their own list because they are on their own clock and their own
// lifetime: a ring outlives the wave table that fired it, and the record above
// is dropped the moment its last puff is out.
const shocks = [];

// Where a ring is added. Null in the Node harness and in anything else with no
// scene — the smoke is the effect and the front is the flourish, so no scene
// means no rings rather than no explosion.
let ringScene = null;

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
 * Hand the module the scene its shockwaves go in. Called once at boot beside
 * initBossGibs, and by the look sheet.
 */
export function initBossBooms(scene) {
  ringScene = scene ?? null;
}

/** Drop every live front and forget the scene. */
export function disposeBossBooms() {
  clearShocks();
  ringScene = null;
}

function clearShocks() {
  for (const s of shocks) if (s.mesh) disposeOrganicRing(s.mesh);
  shocks.length = 0;
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

  // Clamped, and both ends earn their place — see the note on minRadius.
  const r = Math.max(c.minRadius ?? 2.2, Math.min(c.maxRadius ?? 9, m.r));

  const b = {
    x: m.x,
    y: m.y,
    r,
    color,
    // A share of what the animal was doing. A boss killed mid-charge whose
    // cloud hangs exactly where the body was reads as the effect being played
    // at a coordinate; a cloud that carries a little of the run reads as the
    // animal having been there.
    vx: e.vx ?? 0,
    vy: e.vy ?? 0,
    t: 0,
    // Every puff of every ring, in time order, rolled now. See buildPuffs.
    puffs: null,
    // How far down that list this explosion has got. It only ever goes
    // forward, so a frame long enough to cross two rings fires both — a
    // dropped frame should cost the SHAPE of the bloom, never a ring of it.
    next: 0,
  };
  b.puffs = buildPuffs(b, c);
  live.push(b);
  fireShock(b, c);
  return true;
}

// WHAT THIS EXPLOSION IS SHAPED LIKE, rolled once and shared by every ring in
// it.
//
// The two harmonics are the whole reason a cloud has ONE silhouette rather than
// four independent rough circles: every ring pushes its radius in and out
// against the same two waves, so the outer rings bulge where the inner ones
// bulged and the mass reads as a single body that grew. Per-puff jitter cannot
// do this — noise rolled per lobe averages out to a circle across nineteen of
// them, which is exactly what the first pass at this looked like.
//
// Low harmonic: 2 or 3 lobes, which is asymmetry. High: 5 to 7, which is
// roughness. Both at random phase, so no two bosses go up the same shape.
function rollShape(o) {
  const lumps = Math.max(0, o.lumps ?? 0.34);
  const lean = Math.max(0, o.lean ?? 0.16);
  const leanAngle = Math.random() * Math.PI * 2;
  return {
    k1: 2 + Math.floor(Math.random() * 2),
    p1: Math.random() * Math.PI * 2,
    k2: 5 + Math.floor(Math.random() * 3),
    p2: Math.random() * Math.PI * 2,
    lumps,
    leanX: Math.cos(leanAngle) * lean,
    leanY: Math.sin(leanAngle) * lean,
  };
}

// The radius multiplier at one angle. Weighted toward the low harmonic — the
// high one is a roughness on a shape, not a second shape.
function lumpAt(sh, a) {
  return 1 + sh.lumps * (
    0.65 * Math.sin(sh.k1 * a + sh.p1)
    + 0.35 * Math.sin(sh.k2 * a + sh.p2)
  );
}

// EVERY PUFF OF EVERY RING, ROLLED AT ONCE, in time order.
//
// The wave table is expanded here rather than walked at fire time so that a
// puff can be given its own BIRTH MOMENT: a ring whose lobes all appear on one
// frame is the thing that made the bloom read as four steps of a machine, and
// the fix is a few tens of milliseconds of stagger per ring. Sorting once here
// is also what lets the update loop stay a single cursor — the drain order is
// the schedule, and a frame that crosses three rings fires them in the order
// they were meant to arrive.
//
// COUNTS ARE NOT ROLLED, and that is deliberate. How many puffs are in a ring
// is what guarantees neighbours still overlap at that radius (see the note on
// `puffs` in CONFIG.boss.boom.waves); varying it would randomly break the
// silhouette into separate beads. Everything else about a puff is rolled.
function buildPuffs(b, c) {
  const waves = Array.isArray(c.waves) ? c.waves : [];
  const o = c.organic ?? {};
  const sh = rollShape(o);
  const stagger = Math.max(0, o.stagger ?? 0);
  const lobeVary = Math.max(0, o.lobeVary ?? 0);
  const toneVary = Math.max(0, o.toneVary ?? 0);
  const out = [];

  for (let wi = 0; wi < waves.length; wi++) {
    const w = waves[wi];
    const puffs = Math.max(1, Math.round(w.puffs ?? 8));
    const jitter = Math.max(0, w.jitter ?? 0.25);
    // The ring is rolled from a different angle per wave, so the four of them
    // don't stack their lobes along the same spokes and draw a star.
    const phase = Math.random() * Math.PI * 2;
    // How far this ring has walked off the body's centre. Scaled by the ring's
    // own radius, so the inner core stays on the animal and the outer rings
    // drift — a blast leaning as it opens rather than a cloud drawn off-centre.
    const ring = w.ring ?? 1;
    const offX = sh.leanX * ring;
    const offY = sh.leanY * ring;

    for (let i = 0; i < puffs; i++) {
      const a = phase + (i / puffs) * Math.PI * 2
        + (Math.random() - 0.5) * (Math.PI * 2 / puffs) * jitter;
      const lump = lumpAt(sh, a);
      out.push({
        at: (w.at ?? 0) + Math.random() * stagger,
        a,
        // The shared silhouette, then this lobe's own noise on top of it.
        ring: ring * lump * (1 + (Math.random() - 0.5) * jitter),
        offX,
        offY,
        // SCALED BY THE SAME LUMP, and this is not decoration: the puffs in a
        // ring only fuse while neighbours still overlap, and a bulge pushes
        // them apart by exactly `lump`. Growing the lobes by it too keeps that
        // ratio fixed, so the harmonics can be turned up to any depth without
        // beading the ring — and a bulge comes out as a bigger lump of cloud,
        // which is what a bulge in a cauliflower is.
        lobe: (w.lobe ?? 0.3) * lump * (1 + (Math.random() - 0.5) * lobeVary),
        throw: w.throw ?? 1,
        tone: (w.tone ?? 1) * (1 + (Math.random() - 0.5) * toneVary),
        white: w.white ?? 0,
        rise: w.rise ?? 0,
      });
    }
  }
  out.sort((x, y) => x.at - y.at);
  return out;
}

// THE FRONT. One organic ring per row of `shock.rings`, scheduled on the same
// wall clock the puffs are and sized off the same measured body.
//
// Nothing is created here: the mesh is made on the frame the ring is actually
// due, so a shockwave switched off between the kill and its `at` costs nothing,
// and a run with no scene (the Node harness) simply never makes one.
function fireShock(b, c) {
  const sc = c.shock ?? {};
  if (sc.enabled === false || !ringScene) return;
  const rings = Array.isArray(sc.rings) ? sc.rings : [];
  for (const row of rings) {
    shocks.push({
      x: b.x,
      y: b.y,
      r: b.r,
      color: b.color,
      row,
      t: 0,
      // Where the trailing edge starts eating from. Rolled per ring: the rub
      // -out starting at the same clock position every time is the tell that
      // this is one effect played twice rather than two explosions.
      from: Math.random(),
      mesh: null,
    });
  }
}

/**
 * @param rawDt UNSCALED seconds. The whole point: see the header. A cloud
 *              scheduled on the world's clock would still be on its first ring
 *              when the shutter went.
 */
export function updateBossBooms(rawDt) {
  updateShocks(rawDt);
  if (!live.length) return;
  const c = cfg();
  const sizeMaster = Math.max(0, c.size ?? 1);
  const speedMaster = Math.max(0, c.speed ?? 1);
  const glow = Math.max(0, c.glow ?? 1);

  for (let i = live.length - 1; i >= 0; i--) {
    const b = live[i];
    b.t += rawDt;
    const list = b.puffs;
    while (b.next < list.length && b.t >= list[b.next].at) {
      firePuff(b, list[b.next], sizeMaster, speedMaster, glow);
      b.next += 1;
    }
    // Dropped the moment the last lobe is out. The particles are the
    // particle system's problem from here, and they outlive this record by
    // seconds — nothing about a cloud already in the water is decided in here.
    if (b.next >= list.length) live.splice(i, 1);
  }
}

// THE FRONT, ON THE WALL CLOCK.
//
// Grown by a decelerating ease rather than at a speed: the ring has to be most
// of the way out within a few frames of the bang (that is what makes it a
// front and not a hoop) and then hold, so that whichever frame the shutter
// happens to catch has a big ring in it. `placeOrganicRing` rather than a scale
// write — the shader's edge amplitude is a world-unit number divided by the
// radius, so the two are a pair.
function updateShocks(rawDt) {
  if (!shocks.length) return;
  const sc = cfg().shock ?? {};
  const ease = Math.max(0.2, sc.ease ?? 2.6);

  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i];
    s.t += rawDt;
    const at = s.row.at ?? 0;
    if (s.t < at) continue;
    const seconds = Math.max(0.01, s.row.seconds ?? 0.26);
    const u = Math.min(1, (s.t - at) / seconds);

    if (!s.mesh) {
      // Switched off, or the scene taken away, between the kill and this ring
      // being due.
      if (sc.enabled === false || !ringScene) { shocks.splice(i, 1); continue; }
      s.mesh = makeRing(s, sc);
      ringScene.add(s.mesh);
    }

    const grow = 1 - (1 - u) ** ease;
    const from = (s.row.from ?? 0.3) * s.r;
    const to = (s.row.to ?? 2) * s.r;
    const radius = from + (to - from) * grow;

    placeOrganicRing(s.mesh, s.x, s.y, radius);
    const th = Array.isArray(s.row.thick) ? s.row.thick : [0.24, 0.05];
    // THINNING AS IT OPENS, and it has to be done here rather than left as one
    // number: `uThickness` is a share of the radius, so a constant one grows
    // with the ring and the front turns into a swelling doughnut.
    const thickness = th[0] + ((th[1] ?? th[0]) - th[0]) * grow;
    const fade = s.row.fade ?? 1.6;
    // EATEN, not faded. The trailing edge chases the leading one round the
    // circle from `from`, which is the organic ring's own sweep and the reason
    // a ring that has half gone still has a hard edge where it is going.
    const eat = Math.max(0, Math.min(0.999, s.row.eat ?? 0.45));
    const out = u <= eat ? 0 : (u - eat) / (1 - eat);
    updateOrganicRing(s.mesh, rawDt, {
      opacity: (1 - u) ** fade,
      thickness,
      sweepIn: 1,
      sweepOut: out,
    });

    if (u >= 1) {
      disposeOrganicRing(s.mesh);
      shocks.splice(i, 1);
    }
  }
}

function makeRing(s, sc) {
  // WHITE-HOT, and mixed into the COLOUR rather than added as brightness: a
  // hotter front is a whiter one, and pushing the glow instead would give a
  // saturated hoop in the boss's own hue with a bloom welded across it.
  _col.set(s.color).lerp(_white, Math.max(0, Math.min(1,
    (sc.white ?? 0.72) * (s.row.white ?? 1))));
  const mesh = makeOrganicRing({
    color: _col.getHex(),
    edge: sc.edge ?? 'roil',
    glow: (sc.glow ?? 3.2) * (s.row.glow ?? 1),
    // THE ONLY WORLD-UNIT NUMBER IN THE EFFECT, and it is derived rather than
    // typed: the ring shader takes its wobble in world units, so a fixed one
    // would make a crab's front as ragged as a megalodon's is smooth. Scaled by
    // the body, exactly like everything else here.
    wobble: (sc.wobble ?? 0.1) * s.r,
    wobbleMax: sc.wobbleMax ?? 0.16,
    massVar: sc.massVar ?? 0.55,
    noiseScale: sc.noiseScale ?? 0.5,
    thickness: (Array.isArray(s.row.thick) ? s.row.thick[0] : null) ?? 0.24,
    // Over the water and the wreckage, under the smoke — the goo is a
    // fullscreen pass composited after the scene, so the cloud lands on top of
    // this whatever this says. Which is the right way round: the front leaves,
    // the smoke follows it out.
    renderOrder: 6,
  });
  // The rub-out starts somewhere different every time. `uSweepOut` runs from
  // the same zero angle as `uSweepIn`, so rotating the quad is what moves it.
  mesh.rotation.z = s.from * Math.PI * 2;
  return mesh;
}

// ONE LOBE CLUSTER, at its own point on its own ring, at its own moment.
//
// Each puff is its own emit() call. That is the whole reason a wave is a list
// rather than one burst with a wide speed band: emit() spawns every particle at
// the point it is given, so the only way to be born SPREAD is to be born
// several times.
function firePuff(b, p, sizeMaster, speedMaster, glow) {
  // Size and throw scale together and by the same factor, which is the one
  // lever that means "bigger" without changing the shape — a blob twice as big
  // thrown twice as far fuses exactly as it did. Every other way of scaling goo
  // (the group's radius, its isoline) describes the splats' relationship to
  // each other and comes out as a flat slab or a scatter of dots.
  // Everything in a puff record is a multiple of the body, so one factor turns
  // the whole schedule into world units.
  const scale = b.r * sizeMaster;
  const lobe = b.r * p.lobe * sizeMaster;
  const throwSpeed = b.r * p.throw * speedMaster;
  // How far above the body this ring is centred, x the body. Zero for a ball,
  // and the only thing that separates a puffball from a rising column — the
  // rings still open outward, they just open from a point that has climbed.
  const rise = b.r * p.rise * sizeMaster;

  // The tone. `white` is mixed into the COLOUR (a hot core is whiter, not just
  // brighter) and `tone` rides on the glow rather than on the colour, because
  // emit() lifts a dark tint clear of the water before it uses it — a wave
  // authored at 0.6 of the boss's colour would be lifted straight back to the
  // boss's colour and the ramp across the cloud would quietly not exist. See
  // CONFIG.fx.deathTintMinPeak.
  _col.set(b.color).lerp(_white, Math.max(0, Math.min(1, p.white)));

  const dx = Math.cos(p.a);
  const dy = Math.sin(p.a);
  emit('bossBoom',
    b.x + (p.offX + dx * p.ring) * scale,
    b.y + rise + (p.offY + dy * p.ring) * scale, {
      // Outward, and the emitter's own cone spreads it from there.
      dirX: dx,
      dirY: dy,
      vx: b.vx,
      vy: b.vy,
      color: _col.getHex(),
      glow: glow * p.tone,
      sizeMul: lobe,
      speedMul: throwSpeed,
    });
}

/**
 * End of a run, or the start of one. Any scheduled rings are dropped WITHOUT
 * being fired: this is a restart, a death, the tuner switching it off, and none
 * of them wants a boss going up over a menu three frames later.
 */
export function resetBossBooms() {
  live.length = 0;
  clearShocks();
}

/** For the harness. How many explosions still have rings to fire. */
export function bossBoomCount() {
  return live.length;
}
