import { CONFIG } from '../config.js';

// ============================================================================
// WHAT BEING EATEN LOOKS LIKE — the curl on the way in, and the streak behind.
//
// Every mouth in this game already pulls chum toward itself: the seal's magnet
// (entities/pickups.js), a crab or a shark's hoover (bitePickup), and the
// whale's intake (systems/whale.js). All three moved the orb the same way — a
// straight line, closing at a constant rate — and a straight line at constant
// speed is the one motion the eye reads as "teleported slowly". Nothing about
// it says a mouth is doing it.
//
// TWO THINGS ARE ADDED HERE, and they are deliberately in one file because
// they answer to the same question ("is this orb on its way into something")
// and because three call sites each growing their own version of both is how
// the crab's claw ended up measuring a different reach from the damage it
// dealt.
//
//   THE CURL. A perpendicular offset that grows with the distance left and
//   dies at the mouth, beaten against a second, slower wobble along the line
//   of travel. The orb corkscrews in rather than sliding in, and a pile all
//   claimed at once arrives as a swirl instead of a starburst — each orb
//   carries its own phase and its own spin direction.
//
//   THE STREAK. A ribbon behind anything currently being drawn in, through
//   systems/projectileTrails.js rather than a second ribbon implementation
//   (see the note above updateTrail there for what a "mover" is — a position
//   with a name and a heading, which is all a trail ever needed). It is what
//   makes the pull legible from across the arena: the orb is not just closer
//   than it was, it has a visible line saying where it came from.
//
// THE CURL IS AN OFFSET, NOT A VELOCITY, and that is the whole safety
// argument. Every caller still closes the gap exactly as it did — clamped,
// outrunning the seal, exponential at a whale's lips — and this only displaces
// the orb sideways off that line by an amount that is a FRACTION OF WHAT IS
// LEFT. So it cannot slow an arrival down, cannot stop one, and vanishes to
// nothing at the moment of the swallow. A curl written as a force instead
// would be a fourth thing fighting the three pulls above, and the failure mode
// of that is food orbiting a mouth forever, which is the exact bug the magnet
// latch exists to prevent.
//
// The offset is stored and REMOVED before the next one is applied, so it never
// integrates into a drift — the same discipline the wind-up shiver in
// updatePickups uses, and for the same reason: the mesh position is read by
// the gulp, the pile grid, the crabs and the whale's body test, and every one
// of them wants the orb's real position.
// ============================================================================

function tuning() {
  return CONFIG.pickups?.pull ?? {};
}

// Everything being drawn into a mouth right now: entry -> its trail mover.
//
// A Map keyed on the ENTRY rather than a flag on the entry itself, because the
// ribbon in systems/projectileTrails.js is keyed on the mover object and a
// mover that is rebuilt per frame is a ribbon that restarts its history every
// frame — which draws nothing at all. One mover per orb, for as long as that
// orb lives.
const active = new Map();

// Handed to updateProjectileTrails and rewritten in place, so the common frame
// allocates nothing. Same contract as clubTrailMovers().
const movers = [];

/**
 * THE CURL — call it AFTER moving the orb toward (tx, ty), never instead of.
 *
 * @param entry  the orb or chunk ({ mesh } is all that is touched)
 * @param dt     the frame
 * @param tx,ty  the mouth it is going into
 */
export function strangePull(entry, dt, tx, ty) {
  if (!entry?.mesh) return;
  const c = tuning();
  let s = entry.pull;
  if (!s) {
    s = entry.pull = {
      ox: 0,
      oy: 0,
      // Per-orb, or a claimed pile corkscrews in lockstep and reads as one
      // object wobbling rather than a dozen loose bits being inhaled.
      phase: Math.random() * Math.PI * 2,
      seed: Math.random() * Math.PI * 2,
      // Which way round it turns. Half the pile going one way is what stops
      // the swirl reading as a single current.
      spin: Math.random() < 0.5 ? -1 : 1,
      // THE SWING RAMPS ON. Applied at full size on the first frame it is a
      // sideways POP of up to `swirlMax` — the orb is claimed and instantly a
      // unit and a half to one side of where it was, which reads as a glitch
      // rather than as a pull. The phase is rolled per orb, so frame one is
      // just as likely to land at the top of the sine as at the bottom, and
      // there is nothing about the offset itself that eases it in.
      grip: 0,
      mover: null,
      age: 0,
    };
  }

  // Last frame's offset comes off first — the mesh has to hold the orb's real
  // position for everything that measures it, and an offset left on integrates
  // into a drift across a long pull.
  entry.mesh.position.x -= s.ox;
  entry.mesh.position.y -= s.oy;
  s.ox = 0;
  s.oy = 0;
  s.age = 0;

  const dx = tx - entry.mesh.position.x;
  const dy = ty - entry.mesh.position.y;
  const d = Math.hypot(dx, dy);

  if (c.enabled !== false && d > 1e-4) {
    s.phase += (c.hz ?? 2.6) * Math.PI * 2 * dt * s.spin;
    // A FRACTION OF WHAT IS LEFT, capped. The taper is the whole design: at the
    // rim of a reach the orb swings wide, and by the time it is at the lips the
    // swing is under a tenth of a unit, so the swallow lands where the caller's
    // own arithmetic says it does.
    s.grip = Math.min(1, s.grip + dt / Math.max(1e-3, c.curlIn ?? 0.14));
    const amp = Math.min(d * (c.swirl ?? 0.34), c.swirlMax ?? 1.6) * s.grip;
    const ux = dx / d;
    const uy = dy / d;
    // Perpendicular to the line of travel, which is the direction that reads as
    // a curve rather than as hesitation.
    const across = amp * Math.sin(s.phase);
    // ...beaten at an unrelated rate ALONG that line, so the path is a lopsided
    // lissajous rather than a clean sine. This is the half that makes it look
    // wrong on purpose — a clean sine reads as machinery, and a mouth is not
    // machinery.
    const along = amp * (c.lissajous ?? 0.4) * Math.sin(s.phase * 1.7 + s.seed);
    s.ox = -uy * across + ux * along;
    s.oy = ux * across + uy * along;
    entry.mesh.position.x += s.ox;
    entry.mesh.position.y += s.oy;
  }

  // THE STREAK. Registered here rather than by each caller, so anything that
  // pulls chum gets the ribbon by virtue of having pulled it — a new eater
  // cannot be given the curl and quietly miss the trail.
  if (!s.mover) {
    s.mover = {
      mesh: entry.mesh,
      // Differenced below, like the club's — the orb's motion is the pull plus
      // the curl plus whatever the eater is doing, and none of those three is a
      // number this file could ask for.
      dir: { x: 1, y: 0 },
      speed: 0,
      trailKey: 'chumPull',
      trailScale: 1,
      primed: false,
      px: 0,
      py: 0,
    };
  }
  const m = s.mover;
  if (m.primed && dt > 0) {
    const mx = entry.mesh.position.x - m.px;
    const my = entry.mesh.position.y - m.py;
    const len = Math.hypot(mx, my);
    m.speed = len / dt;
    if (len > 1e-6) { m.dir.x = mx / len; m.dir.y = my / len; }
  }
  m.px = entry.mesh.position.x;
  m.py = entry.mesh.position.y;
  m.primed = true;
  active.set(entry, s);
}

/**
 * LET GO GENTLY — for an orb that is still in the water.
 *
 * The offset can be a unit and a half at the far end of a reach, so taking it
 * off in one frame is a visible sideways POP the moment the seal turns away or
 * a crab loses interest. It is eased off instead, over `uncurl`, which reads as
 * the orb settling out of the swing it was in.
 *
 * Returns false once there is nothing left to unwind, so callers can stop.
 */
export function decayPull(entry, dt) {
  const s = entry?.pull;
  if (!s || (!s.ox && !s.oy)) return false;
  const k = Math.exp(-dt / Math.max(1e-3, tuning().uncurl ?? 0.12));
  const nx = s.ox * k;
  const ny = s.oy * k;
  entry.mesh.position.x += nx - s.ox;
  entry.mesh.position.y += ny - s.oy;
  s.ox = Math.abs(nx) < 1e-4 ? 0 : nx;
  s.oy = Math.abs(ny) < 1e-4 ? 0 : ny;
  if (!s.ox && !s.oy) {
    active.delete(entry);
    return false;
  }
  return true;
}

/**
 * LET GO — the orb goes back to being an orb.
 *
 * Takes the offset off, so an orb that was released mid-swing does not keep it
 * as a permanent displacement, and drops the ribbon. Safe on an entry that was
 * never pulled, which is most of them.
 */
export function releasePull(entry) {
  const s = entry?.pull;
  if (!s) return;
  if (s.ox || s.oy) {
    entry.mesh.position.x -= s.ox;
    entry.mesh.position.y -= s.oy;
    s.ox = 0;
    s.oy = 0;
  }
  active.delete(entry);
}

/**
 * The chum that wants a ribbon this frame, for systems/projectileTrails.js.
 *
 * AGED OUT RATHER THAN CLEARED, and that is what makes the file order-proof.
 * The whale runs before the pickups do and a crab runs between them, so a
 * "clear at the top of the frame" list would be half-built by the time
 * anything read it. An entry drops out of the list when nothing has pulled it
 * for `trailHold` — a couple of frames — which is also what retires the ribbon
 * of an orb that has just been swallowed, since the swallow simply stops
 * pulling it.
 *
 * CAPPED. The ribbons are merged into one draw per length (see
 * systems/projectileTrails.js) so the draw cost does not scale, but the vertex
 * writes do, and `maxAlive` is 140 orbs. The cap is on how many wear a streak,
 * not on how many are collected.
 */
export function pullTrailMovers(dt = 0) {
  const c = tuning();
  movers.length = 0;
  const hold = c.trailHold ?? 0.08;
  const max = c.maxTrails ?? 48;
  for (const [entry, s] of active) {
    s.age += dt;
    if (s.age > hold) { active.delete(entry); continue; }
    if (c.trail !== false && s.mover && movers.length < max) movers.push(s.mover);
  }
  return movers;
}

/** Between runs. The entries are gone; nothing here may outlive them. */
export function resetChumPull() {
  active.clear();
  movers.length = 0;
}

/** How many orbs are being drawn into something right now. For the tests. */
export function pullCount() {
  return active.size;
}
