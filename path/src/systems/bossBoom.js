import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { assetBaseColor } from '../assets.js';
import { hitShapeSpheres } from './hitShape.js';
import { bodyPalette } from './bodyPalette.js';
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
const _swatch = new THREE.Color();
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

// ---------------------------------------------------------------------------
// THE EDGE OF THE ANIMAL — the silhouette, as a closed loop you can walk.
//
// The cloud used to be rings about the body's CENTROID, which put its brightest
// and densest part exactly where the boss was. Additive light or not, forty
// overlapping lobes stacked over the middle of the animal is a wash across the
// one thing the photograph is of: the trophy came out with a lit shape in it
// and the shape was the smoke, not the shark.
//
// So the bands are struck off the EDGE instead. This measures how far the body
// reaches at every angle round its own centroid, and the waves are then laid
// along that loop and pushed OUTWARD from it — nothing is ever born inside the
// silhouette, so the animal is photographed against its own explosion rather
// than through it. It also reads better: a cloud that hugs the outline is an
// aura, and an aura says "this thing just went up" without standing in front of
// it.
//
// WHAT IS MEASURED is the union of the posed hitbox spheres — the same spheres
// the size is measured off, refreshed by systems/bossCorpse.js on the frame the
// explosion fires, so the loop follows a body that has been folding since it
// died. For each of `samples` rays out of the centroid, the far exit point of
// whichever sphere reaches furthest along it. A body with no hitbox (the king
// crab has none) measures nothing, and a loop of nothing is a CIRCLE — which is
// exactly the shape the old effect used, so the fallback is the old behaviour
// rather than an absence.
//
// IT IS NORMALISED TO A PEAK OF 1 and kept that way. Every number in this file
// is a multiple of the measured body and this is no exception: the loop is in
// body radii, so one multiply at fire time turns it into world units and the
// rule the whole file is built on survives.
//
// THE OUTWARD DIRECTION IS THE LOOP'S NORMAL, not the radial from the centroid,
// and on a megalodon the two are nowhere near each other: thirty units of shark
// is almost all flank, where "away from the middle" points along the body and
// "away from the skin" points across it. Bands pushed radially pile up off the
// nose and the tail and leave the flanks bare, which is the same failure as
// centring them, rotated.
// ---------------------------------------------------------------------------
export function measureBossRim(e, m, rc = {}) {
  if (!m) return null;
  const n = Math.max(8, Math.min(256, Math.round(rc.samples ?? 48)));
  const spheres = e?.hitShape ? hitShapeSpheres(e.hitShape) : null;
  const d = new Float64Array(n);
  let peak = 0;

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let far = 0;
    if (spheres) {
      for (const s of spheres) {
        if (!(s.wr > 0)) continue;
        const ox = s.wx - m.x;
        const oy = s.wy - m.y;
        // The far root of the ray/sphere intersection. Negative roots are
        // behind the centroid and belong to the ray pointing the other way,
        // which the sample at a + PI is already measuring.
        const t = ox * dx + oy * dy;
        const h2 = s.wr * s.wr - (ox * ox + oy * oy - t * t);
        if (h2 <= 0) continue;
        const hit = t + Math.sqrt(h2);
        if (hit > far) far = hit;
      }
    }
    d[i] = far;
    if (far > peak) peak = far;
  }

  // NOTHING MEASURABLE IS A CIRCLE. See the header — this is the old effect's
  // own shape, so a boss with no hitbox loses the aura and keeps the cloud.
  if (!(peak > 0)) {
    d.fill(1);
    peak = 1;
  }

  // A FLOOR UNDER THE THIN PLACES. A ray that leaves through a gap between two
  // spheres measures almost nothing, and a loop with a notch cut to the
  // centroid in it puts a band of smoke through the middle of the animal —
  // which is the exact thing this is here to stop. As a share of the reach.
  const floor = peak * Math.max(0, Math.min(0.9, rc.minShare ?? 0.18));
  for (let i = 0; i < n; i++) if (d[i] < floor) d[i] = floor;

  // THE SEAM BETWEEN TWO SPHERES IS A CUSP, and a lobe born in one points its
  // normal somewhere sudden. Smoothed round the loop rather than fitted to
  // anything: a hitbox is a chain of overlapping balls and the only artefact
  // worth removing is the crease where two of them meet.
  const passes = Math.max(0, Math.min(6, Math.round(rc.smooth ?? 2)));
  for (let k = 0; k < passes; k++) {
    const src = Float64Array.from(d);
    for (let i = 0; i < n; i++) {
      d[i] = 0.25 * src[(i - 1 + n) % n] + 0.5 * src[i] + 0.25 * src[(i + 1) % n];
    }
  }

  // AND HOW MUCH OF THE OUTLINE IS KEPT AT ALL. A hitbox traced exactly is a
  // diagram of the collision shape; blended toward its own mean it is the
  // animal's mass with the accidents of where the spheres were placed taken
  // out. 0 is the hitbox, 1 is a circle.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  const round = Math.max(0, Math.min(1, rc.round ?? 0.25));
  let max = 0;
  for (let i = 0; i < n; i++) {
    d[i] += (mean - d[i]) * round;
    if (d[i] > max) max = d[i];
  }
  if (!(max > 0)) return null;

  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    d[i] /= max;
    px[i] = Math.cos(a) * d[i];
    py[i] = Math.sin(a) * d[i];
  }

  // The outward normal, from the tangent through each sample's neighbours. The
  // loop is wound anticlockwise (the angles increase), so rotating the tangent
  // by -90 degrees points away from the body.
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const tx = px[b] - px[a];
    const ty = py[b] - py[a];
    const len = Math.hypot(tx, ty) || 1;
    nx[i] = ty / len;
    ny[i] = -tx / len;
  }

  // CUMULATIVE ARC LENGTH, which is what the puffs are actually spaced along.
  // Spacing them by ANGLE is the obvious build and it beads a long animal at
  // both ends: equal angles round a shark put a dozen lobes across the nose and
  // three down thirty units of flank. Equal arc is even spacing on the skin,
  // which is the only spacing a fused band can be authored against.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(px[j] - px[i], py[j] - py[i]);
  }

  return { n, d, px, py, nx, ny, cum, len: cum[n] };
}

// Where `s` of the way round the loop is, by arc length rather than by angle.
// One shared record: this is called once per puff at fire time and never held.
const _rimHit = { x: 0, y: 0, nx: 0, ny: 0 };
function rimAt(rim, s) {
  const f = ((s % 1) + 1) % 1;
  const target = f * rim.len;
  let lo = 0;
  let hi = rim.n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rim.cum[mid + 1] <= target) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  const j = (i + 1) % rim.n;
  const seg = rim.cum[i + 1] - rim.cum[i];
  const t = seg > 1e-9 ? (target - rim.cum[i]) / seg : 0;
  _rimHit.x = rim.px[i] + (rim.px[j] - rim.px[i]) * t;
  _rimHit.y = rim.py[i] + (rim.py[j] - rim.py[i]) * t;
  const bx = rim.nx[i] + (rim.nx[j] - rim.nx[i]) * t;
  const by = rim.ny[i] + (rim.ny[j] - rim.ny[i]) * t;
  const l = Math.hypot(bx, by) || 1;
  _rimHit.nx = bx / l;
  _rimHit.ny = by / l;
  return _rimHit;
}

// HOW MANY LOBES A BAND NEEDS, which in rim mode is geometry and not taste.
//
// A ring of lobes only fuses into one edge while neighbours still overlap, and
// the wave table's counts were authored against a CIRCLE of `ring` body radii.
// A band struck off the silhouette has a perimeter of its own — longer than
// that circle on a round animal, much shorter on a long one — so a fixed count
// beads the crab and crowds the megalodon, and neither is visible from the
// table.
//
// So the count is DERIVED from the same three numbers the harness checks
// fusion with: the band's perimeter, the smallest lobe the emitter can roll,
// and the goo group's own splat radius. `overlap` is how much of a lobe a
// neighbour has to cover, so under 1 is an overlap and 1 is lobes exactly
// touching (which the metaball pass renders as beads).
//
// THIS IS NOT THE THING THE TABLE FORBIDS ROLLING. `organic` deliberately
// varies everything about a puff except how many there are, because a rolled
// count breaks fusion at random. A count computed FROM the fusion condition is
// the opposite: it is what keeps that guarantee on a shape the author never
// measured. The authored `puffs` stays as the floor, so a wave asking for more
// than the geometry needs still gets them.
function rimPuffs(b, c, w, off, rc) {
  const authored = Math.max(1, Math.round(w.puffs ?? 8));
  if (rc.derivePuffs === false || !b.rim) return authored;
  const size = Math.max(0, c.size ?? 1);
  // The band, not the outline: a band pushed out from the skin is longer than
  // the skin by 2*PI*offset however the body is shaped.
  const perim = b.rim.len * b.br + 2 * Math.PI * off * b.r * size;
  const minSize = CONFIG.emitters?.bossBoom?.size?.[0] ?? 0.5;
  const gooR = CONFIG.fx?.goo?.groups?.boom?.radius ?? 3.2;
  const dia = b.r * size * minSize * (w.lobe ?? 0.3) * gooR;
  if (!(dia > 0) || !(perim > 0)) return authored;
  const overlap = Math.max(0.05, Math.min(1, rc.overlap ?? 0.62));
  const need = Math.ceil(perim / (dia * overlap));
  return Math.max(authored, Math.min(Math.max(1, Math.round(rc.maxPuffs ?? 34)), need));
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
function tintFor(hex, at = null) {
  const t = CONFIG.boss?.boom?.tint ?? {};
  _tint.set(hex);
  _tint.getHSL(_hsl, THREE.SRGBColorSpace);
  // WHERE THIS SWATCH SITS IN THE BODY'S OWN RANGE, when it is one of several.
  //
  // A single lift to a constant lightness is right for one colour and destroys
  // a palette: the kraken's #cdb6b4 and its #000000 are the two ends of the
  // animal, and both arriving at 0.82 makes them the same swatch twice. `at`
  // is this swatch's lightness relative to the palette's mean, and
  // `lightnessSpread` is how much of that relative ordering survives the lift —
  // so a pale part of the animal still comes out paler than a dark one, and
  // both are still clear of the water.
  const spread = Math.max(0, Math.min(1, t.lightnessSpread ?? 0));
  const base = Math.max(0, Math.min(1, t.lightness ?? 0.82));
  // THE CEILING IS NOT TIDINESS. HSL at lightness 1.0 is white whatever the hue
  // and saturation say, so a pale swatch pushed to the top of the range does
  // not come out as a bright version of its colour — it comes out as white, and
  // its hue is gone. Two of the kraken's six swatches landed there, which is a
  // third of the palette carrying no colour at all while every number in the
  // config still read as if it did.
  const l = at == null || spread <= 0
    ? base
    : Math.max(t.lightnessFloor ?? 0.35,
      Math.min(t.lightnessCeil ?? 0.9, base + at * spread));
  _tint.setHSL(
    _hsl.h,
    Math.min(t.maxSaturation ?? 0.55, _hsl.s * (t.saturation ?? 1.4)),
    l,
    THREE.SRGBColorSpace,
  );
  return _tint.getHex();
}

// EVERY COLOUR THE ANIMAL HAD, TURNED INTO SMOKE.
//
// systems/bodyPalette.js answers "what is this body made of" — the texture
// averages, the material colours, the bioluminescent uniforms, the tuned Look
// signature and whatever elemental status is on it — as weighted swatches. This
// is the half that decides what to DO with them, and the two are separate
// because "what colour is the orca" has one right answer and "what should its
// smoke look like" is taste.
//
// THE LIFT IS STILL THE WHOLE PROBLEM. Every boss in the roster is a near-black
// hide and the composite writes linear straight to the framebuffer, so an
// untouched swatch is a black cloud on dark water: the effect fires, nothing
// appears, and no amount of tuning the ring table finds it. Each swatch goes
// through tintFor individually, keeping its hue and its place in the animal's
// own light-to-dark order.
//
// ELEMENTAL SWATCHES PASS THROUGH UNTOUCHED. They arrive flagged `raw` because
// they are UI colours, authored bright and already saturated — put through the
// hide correction, a vivid venom green comes out as the same pale wash as
// everything else, which is the one swatch on the list that had something to
// say.
function paletteFor(e, c) {
  const p = c.palette ?? {};
  const fallback = () => {
    const hex = tintFor(assetBaseColor(e?.assetKey)
      ?? CONFIG.boss?.gibs?.fallbackColor ?? 0xc4705c);
    return { swatches: [{ hex, share: 1 }], mean: hex };
  };
  if (p.enabled === false) return fallback();
  const found = bodyPalette(e);
  if (!found?.swatches?.length) return fallback();

  // The palette's own mean lightness, which is what each swatch is placed
  // against. Read in sRGB for the same reason tintFor is: "lighter than the
  // rest of the animal" is a statement about what an eye sees.
  let meanL = 0;
  for (const sw of found.swatches) {
    _tint.setHex(sw.hex);
    _tint.getHSL(_hsl, THREE.SRGBColorSpace);
    meanL += _hsl.l * sw.share;
  }

  const swatches = found.swatches.map((sw) => {
    if (sw.raw) return { hex: sw.hex, share: sw.share, raw: true, sources: sw.sources };
    _tint.setHex(sw.hex);
    _tint.getHSL(_hsl, THREE.SRGBColorSpace);
    return {
      hex: tintFor(sw.hex, _hsl.l - meanL),
      share: sw.share,
      raw: false,
      sources: sw.sources,
    };
  });
  // The mean is what the SHOCKWAVE takes, and it is one front in one colour by
  // design — see makeRing, which pulls it most of the way to white anyway. Taken
  // from the lifted swatches rather than from the raw mean so the front and the
  // cloud are the same family.
  let r = 0;
  let g = 0;
  let b = 0;
  for (const sw of swatches) {
    _tint.setHex(sw.hex);
    r += _tint.r * sw.share;
    g += _tint.g * sw.share;
    b += _tint.b * sw.share;
  }
  return { swatches, mean: _tint.setRGB(r, g, b).getHex() };
}

// WHICH SWATCH THIS PUFF WEARS, picked by WHERE IT IS rather than by a die.
//
// Rolled per puff, a six-colour palette is confetti: neighbouring lobes fuse
// into one mass in the goo pass and the mass comes out mottled, which reads as
// noise rather than as an animal. Picked by position, the cloud has REGIONS —
// pale here, dark there, green where the venom was — and because the bands go
// round the same loop the puffs are spaced along, those regions land roughly
// where the animal's own colours were.
//
// `bands` is how many times the palette is walked around the cloud. Low, and
// deliberately fractional: a whole number closes the loop on itself and puts
// the same colour at both ends of a seam.
function swatchAt(pal, u, jitter) {
  const list = pal.swatches;
  if (list.length === 1) return list[0].hex;
  let f = ((u % 1) + 1) % 1;
  f = ((f + (Math.random() - 0.5) * jitter) % 1 + 1) % 1;
  let acc = 0;
  for (const sw of list) {
    acc += sw.share;
    if (f <= acc) return sw.hex;
  }
  return list[list.length - 1].hex;
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

  // EVERY COLOUR THE ANIMAL HAD, not one. See paletteFor: the texture averages,
  // the material colours, the bioluminescent uniforms, the Look panel's tuned
  // signature, and whatever elemental status is on the body at the moment it
  // died. A boss that goes up in some other colour would read as an effect
  // played at a position rather than as THIS boss ending — and a boss that goes
  // up in ONE colour, when four of its ten materials disagree, reads as a
  // preset that happens to be near it.
  const pal = paletteFor(e, c);

  const { r, br, rim } = sizeBoom(e, m, c);

  const b = {
    x: m.x,
    y: m.y,
    r,
    br,
    rim,
    // The mean, for the shockwave — one front, one colour.
    color: pal.mean,
    // ...and the whole palette, for the cloud. Read here and dropped, like
    // everything else in this record: the body is going back to the pool a
    // fifth of a second after the shutter.
    pal,
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

// THE TWO RADII AND THE LOOP, in one place because three callers need the same
// answer and a second derivation of them is a second one to get wrong.
//
// `r` is HOW MUCH SMOKE — its clamp is what stops the biggest animal in the
// roster filling the arena — and it scales the lobes, the throw and how far the
// bands stand off the skin. `br` is WHERE THE ANIMAL ENDS, and it cannot be
// clamped by the same number: the roster measures 12.5 to 16.8 against a tuned
// ceiling of 9.5, so a rim placed at `r` would be drawn several units INSIDE
// every boss in the game — an aura hidden under the body it is meant to be
// around, which renders perfectly and looks exactly like the feature being off.
//
// `br` keeps the floor (a body with no measurement at all still gets a loop
// worth seeing) and gets a rail of its own, well clear of the roster, so a
// nonsense measurement cannot draw a ring across the whole arena.
function sizeBoom(e, m, c) {
  const rc = c.rim ?? {};
  return {
    r: Math.max(c.minRadius ?? 2.2, Math.min(c.maxRadius ?? 9, m.r)),
    br: Math.max(c.minRadius ?? 2.2, Math.min(rc.maxBody ?? 24, m.r)),
    rim: rc.enabled === false ? null : measureBossRim(e, m, rc),
  };
}

// WHERE EACH WAVE SITS AND HOW MANY LOBES IT GETS. Pure — no dice — so the
// harness and the look sheet can ask what an explosion WOULD do without firing
// one, and get the answer the explosion will actually use.
//
// WHAT `ring` MEANS WHEN THE BANDS ARE STRUCK OFF THE EDGE. In the old shape it
// was a radius about the centroid. On a rim it is how far past the SKIN a band
// sits, and the two cannot be the same number — the table is authored 0.14 to
// 1.15, and read as an offset that is a cloud two and a half bodies across.
//
// So the table's values are read as an ORDER rather than as distances: the
// innermost wave lands at `hug` and the outermost at `reach`, and everything
// between keeps the relative spacing it was authored with. That is also what
// lets the rim be owned by config.js while the wave table is owned by the
// tuning file — the bands can be moved without touching a tuned row, and a
// retuned table still spaces itself the way its author meant it to.
function bandsFor(b, c) {
  const waves = Array.isArray(c.waves) ? c.waves : [];
  const rc = c.rim ?? {};
  let ringLo = Infinity;
  let ringHi = -Infinity;
  for (const w of waves) {
    const r = w.ring ?? 1;
    if (r < ringLo) ringLo = r;
    if (r > ringHi) ringHi = r;
  }
  const span = ringHi - ringLo;
  const hug = rc.hug ?? 0.02;
  const reach = rc.reach ?? 0.6;
  return waves.map((w) => {
    const u = span > 1e-6 ? ((w.ring ?? 1) - ringLo) / span : 0;
    const off = hug + u * (reach - hug);
    return {
      w,
      u,
      // How far past the skin, in body radii. Meaningless without a rim, where
      // the puff's distance from the centre is `ring` itself.
      off,
      puffs: b.rim ? rimPuffs(b, c, w, off, rc) : Math.max(1, Math.round(w.puffs ?? 8)),
    };
  });
}

/**
 * The colours this body would go up in, without setting anything off.
 *
 * For tools/body-palette-test.mjs, the look sheet and the workbench swatch
 * strip: the lifted palette and its mean, exactly as fireBossBoom would build
 * them. A second implementation of the lift is one that agrees with the effect
 * right up until the day somebody retunes `lightnessSpread`.
 */
export function bossBoomPalette(e) {
  return paletteFor(e, cfg());
}

/**
 * What this body's explosion is going to be, without setting one off.
 *
 * For tools/boss-boom-test.mjs and the look sheet: the two radii, the measured
 * loop, and the band table with its DERIVED puff counts in it. Every one of
 * those is a thing a harness would otherwise have to reimplement, and a second
 * implementation of the fusion arithmetic is one that agrees with the effect
 * right up until the day it matters.
 */
export function bossBoomBands(e) {
  const c = cfg();
  const m = measureBossBody(e);
  if (!m) return null;
  const { r, br, rim } = sizeBoom(e, m, c);
  const b = { r, br, rim };
  return { m, r, br, rim, bands: bandsFor(b, c) };
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
// COUNTS ARE NOT ROLLED, and that is deliberate. How many puffs are in a band
// is what guarantees neighbours still overlap at that radius (see the note on
// `puffs` in CONFIG.boss.boom.waves); varying it would randomly break the
// silhouette into separate beads. Everything else about a puff is rolled. On a
// rim they are DERIVED instead (see rimPuffs), which is the same rule from the
// other end: the count is whatever the fusion condition needs on the shape that
// was actually measured, and still never a die roll.
function buildPuffs(b, c) {
  const o = c.organic ?? {};
  const sh = rollShape(o);
  const stagger = Math.max(0, o.stagger ?? 0);
  const lobeVary = Math.max(0, o.lobeVary ?? 0);
  const toneVary = Math.max(0, o.toneVary ?? 0);
  const out = [];

  const rim = b.rim;
  const plan = bandsFor(b, c);
  // WHERE THE PALETTE STARTS AND HOW FAST IT WALKS. Rolled once per explosion,
  // like the harmonics: two bosses of the same species must not put the same
  // colour on the same side of the cloud every time.
  const pc = c.palette ?? {};
  const bands = pc.bands ?? 2.5;
  const colJitter = Math.max(0, pc.jitter ?? 0.18);
  const colPhase = Math.random();
  // The gap between two neighbouring bands, which is the unit `jitter` is worth
  // on a rim: a band at `hug` is sitting on the skin and has no radius for a
  // share of it to mean anything.
  const bandStep = plan.length > 1
    ? Math.abs(plan[plan.length - 1].off - plan[0].off) / (plan.length - 1)
    : Math.abs(plan[0]?.off ?? 0);

  for (const band of plan) {
    const w = band.w;
    const jitter = Math.max(0, w.jitter ?? 0.25);
    const ring = w.ring ?? 1;
    const off = band.off;
    const puffs = band.puffs;
    // The band is rolled from a different place per wave, so the four of them
    // don't stack their lobes along the same spokes and draw a star.
    const phase = Math.random() * Math.PI * 2;
    // How far this ring has walked off the body's centre. Scaled by how far out
    // the band is, so the innermost stays on the animal and the outer ones
    // drift — a blast leaning as it opens rather than a cloud drawn off-centre.
    const lean = rim ? band.u : ring;
    const offX = sh.leanX * lean;
    const offY = sh.leanY * lean;

    if (rim) {
      for (let i = 0; i < puffs; i++) {
        // Spaced by ARC, and jittered along the same axis — a share of one
        // spacing either way, which is what the angular jitter was.
        const s = phase / (Math.PI * 2)
          + (i + (Math.random() - 0.5) * jitter) / puffs;
        const hit = rimAt(rim, s);
        const lump = lumpAt(sh, Math.atan2(hit.y, hit.x));
        // THE HARMONICS RIDE THE OFFSET, NOT THE DISTANCE, and that is the one
        // place the rim shape cannot reuse the old arithmetic. `lumps` is a
        // +/- 34% on a radius; applied to a distance measured from the centroid
        // it pushes a third of every band back INSIDE the animal, which is the
        // whole failure this mode exists to fix. Applied to the stand-off it
        // makes the aura thick in places and thin in others and never negative.
        const push = off * lump + (Math.random() - 0.5) * jitter * bandStep;
        out.push({
          at: (w.at ?? 0) + Math.random() * stagger,
          // WHERE ROUND THE ANIMAL THIS PUFF IS, which is what decides its
          // colour — see swatchAt. `s` is already the arc fraction, so the
          // palette walks the outline the lobes are spaced along.
          hex: swatchAt(b.pal, s * bands + colPhase, colJitter),
          bx: hit.x,
          by: hit.y,
          ox: hit.nx * push + offX,
          oy: hit.ny * push + offY,
          dx: hit.nx,
          dy: hit.ny,
          lobe: (w.lobe ?? 0.3) * lump * (1 + (Math.random() - 0.5) * lobeVary),
          throw: w.throw ?? 1,
          tone: (w.tone ?? 1) * (1 + (Math.random() - 0.5) * toneVary),
          white: w.white ?? 0,
          rise: w.rise ?? 0,
        });
      }
      continue;
    }

    for (let i = 0; i < puffs; i++) {
      const a = phase + (i / puffs) * Math.PI * 2
        + (Math.random() - 0.5) * (Math.PI * 2 / puffs) * jitter;
      const lump = lumpAt(sh, a);
      // The shared silhouette, then this lobe's own noise on top of it.
      const rad = ring * lump * (1 + (Math.random() - 0.5) * jitter);
      out.push({
        at: (w.at ?? 0) + Math.random() * stagger,
        // The angle round the ring, on the same terms the rim uses its arc.
        hex: swatchAt(b.pal, (a / (Math.PI * 2)) * bands + colPhase, colJitter),
        bx: 0,
        by: 0,
        ox: offX + Math.cos(a) * rad,
        oy: offY + Math.sin(a) * rad,
        dx: Math.cos(a),
        dy: Math.sin(a),
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
  const c = cfg();
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
  // THIS PUFF'S OWN SWATCH, pulled back toward the body's mean by `spread` —
  // 0 is the single flat tint this had before and 1 is the full palette. The
  // pull is what stops a boss with one vivid elemental swatch coming out half
  // green and half grey with a hard line between them.
  const spread = Math.max(0, Math.min(1, (c.palette ?? {}).spread ?? 0.75));
  _col.set(b.color).lerp(_swatch.set(p.hex ?? b.color), spread);
  _col.lerp(_white, Math.max(0, Math.min(1, p.white)));

  // TWO SCALES, AND THEY ARE DIFFERENT NUMBERS ON PURPOSE — see `br` in
  // fireBossBoom. `bx, by` is a point on the animal's own skin and rides the
  // measured body; `ox, oy` is how far the smoke stands off that point and
  // rides the clamped one, which is what makes `size` and `maxRadius` mean "how
  // much cloud" rather than "how big is the animal". In the rings-about-the
  // -centre shape `bx, by` is zero and this is the arithmetic it always was.
  emit('bossBoom',
    b.x + p.bx * b.br + p.ox * scale,
    b.y + rise + p.by * b.br + p.oy * scale, {
      // Away from the skin — the loop's normal on a rim, and straight out from
      // the centre without one. The emitter's own cone spreads it from there.
      dirX: p.dx,
      dirY: p.dy,
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
