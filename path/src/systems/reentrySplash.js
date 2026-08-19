import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';

// ============================================================================
// THE LANDING — a splash as a sequence rather than as one burst.
//
// `feedback.reentry` fires a spray and a crown of foam upward on the frame the
// seal comes back through the water line, and for the whole life of the game
// that was the entire effect. It is the second of the four things a splash
// does, on its own, which is why the most athletic move in the game has always
// landed like a puff: the water goes up, and nothing ever went down.
//
// This module owns the other three. It holds no particles, draws nothing and
// simulates nothing — it is a clock with a table of bursts hanging off it (the
// table, and the reasoning for every number in it, is CONFIG.reentrySplash).
// Everything visible is entities/particles.js and the goo pass that was already
// there.
//
// THE ONE MECHANISM WORTH KNOWING ABOUT is how the cavity comes back up,
// because it is not scheduled and it is not a second burst. The particle solve
// is closed-form:
//
//     disp = v * (1 - e^(-k*t)) / k  +  0.5 * g * t^2
//
// The velocity term is damped by drag; the gravity term is not. So a blob
// thrown hard DOWNWARD into heavy drag, carrying a POSITIVE (upward) gravity,
// runs out of downward travel in about 1/k seconds, hangs there while the
// parabola is still small, and is then carried back up through the surface by
// it — accelerating, the way water full of entrained air actually returns.
// Down, hold, up, out of one emitter and one ballistic solve. See
// CONFIG.emitters.reentryCavity.
//
// WHERE IT COMES FROM. Not a point. Every stage that happens AT the water line
// is emitted from a ring of points around the seal's own silhouette, 360° of
// it, each throwing outward from the body — because a splash is made by a
// SHAPE displacing water, and a burst fired from one coordinate reads as a
// firework however well it is timed. The seal enters at an angle, long and
// tilted, and the water has to leave along the whole of it.
//
// The ring is an ellipse fitted to the animal's measured extent (main.js hands
// it in; `ring.minRadius` covers a caller with nothing to measure), and each
// point's throw is the outward normal there blended with the stage's own
// direction by `radial`. That blend is the control worth understanding: at 0
// the ring only moves the ORIGINS and every lobe still goes the stage's way;
// at 1 the stage's direction is ignored and the burst is a pure halo. The
// cavity sits in the middle, which is what a real one does — water leaves the
// whole body outward, and the sum of it still goes down.
//
// The column is the exception and is fired from a POINT on purpose. It is
// thrown by the cavity closing on itself, not by the animal, so it comes out
// of the middle of the hole wherever the seal happened to be.
//
// WHAT CLOCK IT RUNS ON. Real time, the same `realDt` main.js hands
// updateParticles — NOT the gameplay clock. The landing fires a 0.05s hit-stop
// of its own, and a stage table running on the dilated clock would schedule the
// jet against a different timeline than the particles it is squeezing out of
// the cavity.
//
// Imports CONFIG and emit and nothing else, so tools/reentry-splash-test.mjs
// can drive the whole sequence in Node with a stub emitter and read back what
// was fired and when.
// ============================================================================

/**
 * Landings in flight. Almost always one — two seals cannot arrive at once, but
 * a slam near the end of one sequence overlaps the tail of it — and each is a
 * clock, a position, a size and a cursor into the stage table. Never a
 * reference to the player: this outlives the frame it was fired on, and a
 * record holding the seal would keep describing wherever the seal went next
 * rather than where it landed.
 */
const live = [];

function cfg() {
  return CONFIG.reentrySplash ?? {};
}

/**
 * Start a landing.
 *
 * @param {object} at              the feedback payload for the crossing
 * @param {number} at.x            where it crossed
 * @param {number} at.y            the water line there
 * @param {number} at.vx           the seal's horizontal speed at the line
 * @param {number} at.vy           its downward speed, as a positive number
 * @param {number} at.scale        the 0.3..2.2 weight of the landing
 * @param {object} [at.body]         the seal's measured extent — {rx, ry},
 *                                   world-unit half-width and half-height of
 *                                   its silhouette. Omitted, the ring falls
 *                                   back to `ring.minRadius`, which is a
 *                                   smaller splash rather than a broken one.
 */
export function fireReentrySplash(at = {}) {
  const c = cfg();
  if (!c.enabled) return null;
  const stages = c.stages;
  if (!Array.isArray(stages) || !stages.length) return null;

  // Floored rather than gated. A landing under the threshold still gets the
  // whole sequence, just small — one more unit of downward speed must never be
  // the difference between a splash and no splash, because the player is doing
  // this every few seconds and would feel the edge long before they could name
  // it.
  const scale = Math.max(c.minScale ?? 0, at.scale ?? 1);

  const rec = {
    x: at.x ?? 0,
    y: at.y ?? 0,
    vx: at.vx ?? 0,
    // Stored pointing DOWN, which is the direction it was travelling — main.js
    // hands the feedback payload an absolute value because the sound wants a
    // magnitude. A stage carries it in its own direction (see `lean` below), so
    // it has to be a vector by the time it gets here or the cavity would
    // inherit an upward kick from a seal that was falling.
    vy: -Math.abs(at.vy ?? 0),
    scale,
    // Every gain is `1 + (scale - 1) * gain`, so a landing at scale 1 multiplies
    // by exactly 1 and the emitter's own authored numbers are what fires. Same
    // identity-value rule the air-time multipliers follow.
    count: Math.max(0, 1 + (scale - 1) * (c.countGain ?? 0)),
    // SIZE AND SPEED MOVE TOGETHER, always. This is the one rule about scaling
    // a goo mass: fusion is a question of how far neighbours have separated
    // relative to their own radius, so a cavity with bigger lobes alone welds
    // into a featureless slab and one thrown harder alone tears into loose
    // dots. Two gains rather than one only so they can be nudged apart in the
    // tuner; they are authored equal and should stay near each other.
    sizeMul: Math.max(0.05, 1 + (scale - 1) * (c.sizeGain ?? 0)),
    speedMul: Math.max(0.05, 1 + (scale - 1) * (c.speedGain ?? 0)),
    // THE SILHOUETTE THE WATER LEAVES FROM, measured by the caller and frozen
    // here. Frozen because the record outlives the frame: the seal keeps
    // swimming, and a ring that re-read the body would put the column that is
    // owed 0.26s from now around wherever the animal had got to by then.
    //
    // Floored, not defaulted — a caller that measures a body smaller than the
    // floor gets the floor. A ring inside the animal's own outline is a point
    // burst with extra steps.
    rx: Math.max(c.ring?.minRadius ?? 0.6, at.body?.rx ?? 0),
    ry: Math.max(c.ring?.minRadius ?? 0.6, at.body?.ry ?? 0),
    // Rolled once per landing so the ring is not a clock face in the same
    // place every time. One offset for the whole sequence, so the column and
    // the cavity agree about where the body was.
    phase: Math.random() * Math.PI * 2,
    t: 0,
    next: 0,
  };

  live.push(rec);
  // The zero-second stages go out NOW rather than on the next tick. They are
  // the impact itself, and a frame of daylight between the sound and the hole
  // in the water is a frame the whole effect reads as late.
  advance(rec);
  return rec;
}

/**
 * Fire every stage whose time has come. The table is authored in order, so this
 * walks a cursor rather than scanning — and a stage is fired at most once, by
 * construction, which is what stops a long frame from re-emitting one.
 */
function advance(rec) {
  const stages = cfg().stages ?? [];
  while (rec.next < stages.length && (stages[rec.next].at ?? 0) <= rec.t) {
    fireStage(rec, stages[rec.next]);
    rec.next += 1;
  }
}

function fireStage(rec, stage) {
  if (!stage?.emit) return;
  const c = cfg();
  const dir = stage.dir ?? 1;
  const lean = stage.lean ?? 0;
  const y = rec.y + (stage.y ?? 0);
  // WHAT THE BURST CARRIES OF THE ARRIVAL — sideways drift and downward speed
  // both, each in the stage's own direction, and then multiplied again by the
  // emitter's `inherit`. The cavity takes most of it, because it is literally
  // the water the body pushed out of its way and it should go where the body
  // went. The column takes none: it is thrown by the hole closing on itself
  // rather than by the animal, so it stands straight up however sideways the
  // landing was.
  const opts = {
    vx: rec.vx * lean,
    vy: rec.vy * lean * -dir,
    sizeMul: rec.sizeMul,
    speedMul: rec.speedMul,
  };

  // A stage with no arc is a POINT burst at the middle of the hole — the
  // column, and anything else that is thrown by the water rather than by the
  // animal.
  const arc = stage.arc ?? 0;
  if (arc <= 0) {
    emit(stage.emit, rec.x, y, {
      ...opts,
      x: rec.x,
      y,
      // The emitter's own cone opens around this, so it is the whole difference
      // between the hole and the column.
      dirX: 0,
      dirY: dir,
      scale: rec.count * (stage.count ?? 1),
    });
    return;
  }

  const ring = c.ring ?? {};
  const points = Math.max(1, Math.round(ring.points ?? 7));
  const pad = ring.pad ?? 0;
  const jitter = ring.jitter ?? 0;
  const radial = Math.min(1, Math.max(0, stage.radial ?? 1));
  // The centre of the arc is the stage's own direction, so a full 360 starts
  // anywhere (the phase decides) and a partial one is centred on where the
  // water is being sent.
  const mid = Math.atan2(dir, 0);
  const full = arc >= Math.PI * 2 - 1e-6;
  // Each point gets its share, and the share is at least one lobe — emit()
  // floors at 1 anyway, so a ring of eight points on a small landing is eight
  // single lobes rather than nothing.
  const share = (rec.count * (stage.count ?? 1)) / points;

  const rx = rec.rx + pad;
  const ry = rec.ry + pad;

  for (let i = 0; i < points; i++) {
    // A closed ring divides by `points`; an arc that does not close divides by
    // the gaps between them, so both ends of it actually get a burst.
    const t = full ? i / points : (points === 1 ? 0.5 : i / (points - 1));
    const a = mid - arc / 2 + arc * t + rec.phase
      + (jitter ? (Math.random() * 2 - 1) * jitter : 0);

    const ox = Math.cos(a) * rx;
    const oy = Math.sin(a) * ry;
    // THE OUTWARD NORMAL OF AN ELLIPSE, which is not the direction of the point
    // from its centre — on a body three times longer than it is deep those two
    // are most of a right angle apart along the flanks, and using the offset
    // would throw the water off the seal's nose and tail instead of off its
    // back and belly. Gradient of (x/rx)^2 + (y/ry)^2.
    let nx = ox / (rx * rx);
    let ny = oy / (ry * ry);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;

    // Blended with the stage's own direction. `radial` 1 is a pure halo, 0 is
    // the old point burst's direction fired from a ring of origins.
    const dx = nx * radial;
    const dy = ny * radial + dir * (1 - radial);
    const dlen = Math.hypot(dx, dy) || 1;

    emit(stage.emit, rec.x + ox, y + oy, {
      ...opts,
      x: rec.x + ox,
      y: y + oy,
      dirX: dx / dlen,
      dirY: dy / dlen,
      scale: share,
    });
  }
}

/**
 * Advance every landing in flight. Called once per frame from main.js on
 * `realDt`, next to updateParticles and for the same reason.
 */
export function updateReentrySplash(realDt) {
  if (!live.length) return;
  const dt = Math.max(0, realDt || 0);
  for (let i = live.length - 1; i >= 0; i--) {
    const rec = live[i];
    rec.t += dt;
    advance(rec);
    // Dropped the moment the last stage is out. The particles it fired outlive
    // it by a second and are not this module's business — they belong to the
    // buffer, which is what they were handed to.
    if (rec.next >= (cfg().stages ?? []).length) live.splice(i, 1);
  }
}

/**
 * Drop every landing mid-sequence. Run start and death, so a jet scheduled by
 * the last thing the previous run did cannot arrive over the menu.
 */
export function resetReentrySplash() {
  live.length = 0;
}

/** How many landings are still owed stages. For the harness. */
export function reentrySplashCount() {
  return live.length;
}
