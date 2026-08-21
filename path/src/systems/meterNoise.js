import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { buildField, loopsInZ, Z_PERIOD } from '../ui/dither.js';
import { advanceCycles } from './beatSync.js';

// ============================================================================
// ONE FIELD OF NOISE, WORN BY EVERY METER.
//
// The gauges used to be flat slabs of colour: a red rectangle, a blue one, a
// column of green pips. Nothing in this game is a flat slab — the water is
// noise, the reveals are noise, the goo is a field cut at an isoline — and
// three solid bars sitting on top of all of it read as the HUD of a different
// game. This breaks them up.
//
// WHY ONE FIELD AND NOT THREE. Health, air, the boost column and the fuel ring
// around the seal are four surfaces in two completely different technologies
// (DOM elements, and a fragment shader). Given a texture each they would drift
// into four unrelated speckles at four sizes, which is exactly how a HUD stops
// looking like one instrument. So the FIELD is built once here — the same
// pixels, from the same generator the menus dissolve through (ui/dither.js,
// which owns this project's whole noise vocabulary) — and handed out in two
// forms: data-URI tiles for the DOM, and a DataTexture for the shader.
//
// The two views are then the same noise at the same phase, sliding at the same
// speed, and one set of sliders moves all of them. See CONFIG.hud.meterNoise.
//
// WHAT MOVES, AND THEY ARE TWO DIFFERENT THINGS:
//
//   DRIFT  the field SLIDES, in tiles per second. Reads as the bar being made
//          of something flowing past — the direction is tunable because up a
//          draining column and down one say different things. IN SECONDS, and
//          it stays there: a translation never comes back round, so there is
//          no cycle to put on a musical grid. systems/beatSync.js argues this
//          distinction at length and it is the same one here.
//   BOIL   the field CHURNS IN PLACE, stepping from one phase to the next. The
//          phases are slices of one continuous 3D field a whole z-period
//          apart, so cycling them boils the way a hand-drawn line does instead
//          of flickering. Same trick, and the same constant, as the menu
//          reveal.
//
//          THIS ONE IS ON THE BEAT. A boil is a repeating cycle, which is
//          precisely what beatSync exists to quantise, and a HUD that churns
//          on a rate in seconds is a HUD very slightly out of time with the
//          loop that is playing — the whole complaint that file opens with.
//          `boilSync` names a division and the field takes ONE STEP per cycle
//          of it, so the grain changes on the eighth note whatever the phase
//          count is. 'free' (or the master switch off) falls back to `boil` in
//          loops per second, which is exactly how this shipped first.
//
// RANK-NORMALISED, WHICH IS THE WHOLE REASON THE DEPTH SLIDER WORKS. Fractal
// noise clusters hard around its middle — buildField says so in its own
// docstring, and the same lesson is written on feTurbulence's door. A linear
// threshold over that does nothing across most of its travel and everything
// across a sliver, so every value here is replaced by its RANK in the sorted
// field. What comes out is a perfectly uniform 0..1: `depth` then means what
// it says at every setting, and `gamma` is free to shape where the bite falls
// rather than being spent undoing the clustering.
//
// IT BUILDS ONE PHASE PER FRAME. A full set is a few hundred thousand noise
// evaluations, which is a visible hitch if it all lands on the frame the HUD
// first draws — and it would land there, because that frame is also the first
// frame of a run. Phase 0 is enough to draw with; the rest arrive over the
// next few frames and nothing looks different until they do.
//
// AND IT SURVIVES HAVING NO DOM. The tiles need a 2D canvas context, which the
// Node harnesses do not have (tools/dom-stub.mjs is explicit about it) — so
// the DOM half is built behind a try/catch and the whole system reports itself
// as off rather than throwing from inside a test that is asking about
// something else entirely. The DataTexture half needs no canvas at all.
// ============================================================================

/** The tuning, with every default stated here as well as in config.js. */
function tuning() {
  const n = CONFIG.hud?.meterNoise ?? {};
  return {
    enabled: n.enabled !== false,
    algo: n.algo ?? 'simplex',
    size: Math.max(16, Math.round(n.size ?? 96)),
    scale: Math.max(1, n.scale ?? 3),
    octaves: Math.max(1, Math.round(n.octaves ?? 2)),
    phases: Math.max(1, Math.round(n.phases ?? 6)),
    gamma: Math.max(0.1, n.gamma ?? 1),
    depth: Math.max(0, Math.min(1, n.depth ?? 0.32)),
    tilePx: Math.max(4, n.tilePx ?? 26),
    tileRing: Math.max(0.02, n.tileRing ?? 0.38),
    driftX: n.driftX ?? 0,
    driftY: n.driftY ?? -0.35,
    boil: Math.max(0, n.boil ?? 0.6),
    boilSync: n.boilSync ?? '1/8',
  };
}

// What the built set was built FROM. Anything in here changing throws the set
// away; `depth` and the two drifts are deliberately not in it, because they
// are applied at draw time and a slider that rebuilt the field would stutter
// for as long as it was being dragged.
function bakeKey(t) {
  return `${t.algo}|${t.size}|${t.scale}|${t.octaves}|${t.phases}|${t.gamma}`;
}

let bake = null;

function freshBake(t) {
  // THE OLD SET'S TEXTURES ARE HANDED BACK, and this is not housekeeping for
  // its own sake: a rebuild happens on every step of four of the sliders, so
  // dragging one across its travel would otherwise abandon a set of uploads
  // per frame — a GPU leak whose only symptom is that the tab gets slower the
  // longer somebody spends tuning it.
  if (bake) for (const tex of bake.textures) tex.dispose();
  return {
    key: bakeKey(t),
    size: t.size,
    phases: t.phases,
    built: 0,               // how many of them exist yet
    fields: [],             // rank-normalised Float32Array per phase
    tiles: [],              // `url(data:...)` per phase, for the DOM
    textures: [],           // THREE.DataTexture per phase, for the shader
    domFailed: false,       // no 2D context here — see the header
  };
}

/**
 * Every value replaced by its own rank in the field, then gamma-shaped.
 *
 * The sort is over an index array rather than the values, because what is
 * wanted is WHERE each pixel came in — sorting the values themselves would
 * give the quantile boundaries but not which pixel belongs to which.
 */
function rankNormalise(field, gamma) {
  const n = field.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Float32Array.prototype.sort is numeric already; this one is over indices,
  // so the comparator is doing the looking-up.
  const idx = Array.from(order).sort((a, b) => field[a] - field[b]);
  const out = new Float32Array(n);
  const last = Math.max(1, n - 1);
  for (let r = 0; r < n; r++) {
    const q = r / last;
    out[idx[r]] = gamma === 1 ? q : q ** gamma;
  }
  return out;
}

/** One phase, as an 8-bit grey texture the shader can sample. */
function toTexture(field, size) {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(field[i] * 255);
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  // TILED, in both axes — the field is periodic by construction and the
  // instrument is bigger than one tile at most sizes.
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // NO MIPMAPS. The sample is taken inside a branch, and a mipmapped fetch in
  // a branch needs derivatives that GLSL ES 1.00 does not have (see the note
  // on fwidth at the top of the shader in systems/strikeRing.js).
  tex.generateMipmaps = false;
  // ONE BYTE PER PIXEL AND ONE BYTE OF ALIGNMENT. The default unpack alignment
  // is 4, which is right for RGBA and skews a single-channel upload the moment
  // the width is not a multiple of it — as a diagonal smear, which reads
  // exactly like a noise algorithm doing something interesting.
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** ...and as a data-URI tile the DOM can multiply through. */
function toTile(field, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const v = Math.round(field[i] * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return `url(${canvas.toDataURL()})`;
}

/**
 * Build at most one more phase.
 *
 * Called once per frame from the HUD. Returns the bake so callers can see how
 * much of it exists — everything downstream indexes modulo `built`, so a
 * half-built set boils across the phases it has rather than flashing an empty
 * one.
 */
function ensureBake() {
  const t = tuning();
  const key = bakeKey(t);
  if (!bake || bake.key !== key) bake = freshBake(t);
  if (bake.built >= bake.phases) return bake;

  const p = bake.built;
  const z = (p / bake.phases) * Z_PERIOD;
  let field = buildField(t.algo, t.size, t.scale, t.octaves, z);
  if (!loopsInZ(t.algo)) {
    // Crossfaded into a copy of itself a whole period back, exactly as the
    // menu reveal does it: an algorithm that is not periodic in z would pop on
    // the frame the boil wraps, and the pop is one frame long, which is the
    // hardest kind of fault to catch in the act.
    const back = buildField(t.algo, t.size, t.scale, t.octaves, z - Z_PERIOD);
    const w = p / bake.phases;
    for (let i = 0; i < field.length; i++) field[i] = field[i] * (1 - w) + back[i] * w;
  }
  field = rankNormalise(field, t.gamma);

  bake.fields.push(field);
  bake.textures.push(toTexture(field, t.size));
  if (!bake.domFailed) {
    try {
      const tile = toTile(field, t.size);
      if (tile) bake.tiles.push(tile);
      else bake.domFailed = true;
    } catch {
      // A harness with no canvas. The shader half is untouched by this.
      bake.domFailed = true;
    }
  }
  bake.built++;
  return bake;
}

// --- the clock --------------------------------------------------------------
// ONE clock for every surface, advanced from ONE place. The HUD owns it (see
// advanceMeterNoise) because updateHUD runs exactly once per live frame; the
// ring READS it. Two callers each advancing it would run the drift at double
// speed whenever both were on screen, which is precisely the frames that
// matter — and it would look like a tuning value being wrong.
const clock = { x: 0, y: 0, boil: 0 };

/**
 * Move the field on by `dt` REAL seconds.
 *
 * Real seconds because this is a read-out for a person: a hit-stop dropping
 * the water to a tenth speed must not also slow down the HUD, and the beat
 * clock it hands `dt` to wants raw time for the same reason.
 */
export function advanceMeterNoise(dt) {
  const t = tuning();
  if (!t.enabled) return;
  const step = Math.min(0.1, Math.max(0, dt));

  // DRIFT — integrated, in seconds, and kept small rather than allowed to run
  // away: these end up in a CSS length and in a float uniform, and after an
  // hour of drift a float32 has lost the precision the movement is made of.
  // Wrapping at a whole tile is invisible because the field tiles.
  clock.x += t.driftX * step;
  clock.y += t.driftY * step;
  if (Math.abs(clock.x) > 1) clock.x -= Math.trunc(clock.x);
  if (Math.abs(clock.y) > 1) clock.y -= Math.trunc(clock.y);

  // BOIL — on the grid. The counter is in PHASE STEPS rather than in whole
  // loops, which is the one decision that makes this quantise usefully: a step
  // is what the eye actually sees change, so putting the STEP on the division
  // lands the churn on the beat no matter how many phases the loop is cut
  // into. Counting whole loops instead would put six evenly-spaced steps
  // inside one bar and only the first of them on a beat.
  //
  // wrap is the phase COUNT, a whole number of steps, or the wrap itself would
  // land mid-step as a visible stutter — see the note on `wrap` in
  // advanceCycles. `built` can trail `phases` during the bake and is handled
  // where the phase is read, not here, so the grid never depends on how far
  // the bake has got.
  //
  // The free rate is loops/sec times the phase count, so 'free' behaves
  // exactly as it did before any of this was on a grid.
  clock.boil = advanceCycles(clock.boil, t.boilSync, t.boil * t.phases, step, t.phases);
}

/** Where the field has slid to, in TILES. */
export function meterNoiseOffset() {
  return clock;
}

/**
 * The state every surface needs to draw the field this frame.
 *
 * Builds one more phase as a side effect — this is the once-a-frame call.
 * `ready` is false while there is nothing to draw yet or the field is switched
 * off, and every caller is expected to draw its plain self in that case rather
 * than to skip drawing.
 */
export function meterNoiseFrame() {
  const t = tuning();
  if (!t.enabled) return { ready: false, tuning: t };
  const b = ensureBake();
  if (!b.built) return { ready: false, tuning: t };
  // clock.boil counts PHASE STEPS (see advanceMeterNoise), so the whole part
  // IS the phase. Taken modulo what has actually been baked rather than modulo
  // the configured count: during the first few frames the set is still filling
  // in, and indexing past it would draw nothing at all.
  const phase = Math.floor(clock.boil) % b.built;
  return {
    ready: true,
    tuning: t,
    phase,
    tile: b.tiles.length ? b.tiles[phase % b.tiles.length] : null,
    texture: b.textures[phase],
    offset: clock,
  };
}

/**
 * Back to the start between runs, so two runs opened a minute apart are the
 * same picture rather than the same picture at two arbitrary offsets.
 *
 * ONLY THE DRIFT ACTUALLY MOVES. A quantised boil is derived from the
 * transport absolutely — that is what keeps it locked to the grid however long
 * a session runs — so it snaps straight back to where the music says it should
 * be on the next frame, and that is correct: the field is in time with a loop
 * that did not restart just because this run did.
 */
export function resetMeterNoise() {
  clock.x = 0;
  clock.y = 0;
  clock.boil = 0;
}
