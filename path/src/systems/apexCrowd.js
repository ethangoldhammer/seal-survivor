// ---------------------------------------------------------------------------
// APEX CROWDING — how several big bodies share one target.
//
// Every hunter used to steer at the player's exact centre point. With one
// shark that reads as a shark; with six it reads as a stack, because they all
// solve the identical problem and arrive at the identical answer. The tell is
// a death screenshot: every predator in the arena nose-down on the same pixel,
// all facing the same way, overlapping. `enemySeparation` didn't fix it — that
// is a physical shove applied AFTER the steering has already aimed everyone at
// the same spot, so it pushes bodies apart while their own steering pulls them
// straight back in.
//
// The fix is in the steering, not the physics, and it is two ideas:
//
//   AVOIDANCE  — a hunter steers around the space other apex bodies occupy,
//                at a radius wider than the physical one so it reads as
//                anticipation rather than as bumping.
//   SLOTS      — only so many get to be ON the player at once. The rest hold
//                at a stand-off ring and circle, and the slots rotate on a
//                timer, so the pack takes turns instead of the whole pod
//                pressing in and the arrival order deciding everything.
//
// Real feeding behaviour, and it makes a pack of six legible: two committed,
// four circling at distance, all facing different directions.
//
// Pure geometry, no THREE and no game imports — creatures come in as anything
// with { x, y, radius }. That keeps it testable headlessly (tools/apex-crowd
// -test.mjs drives it with plain objects), which matters because the whole
// point is emergent behaviour you cannot eyeball from the code.
// ---------------------------------------------------------------------------

// Scratch, reused every call — this runs per hunter per frame and must not
// allocate. Callers read it immediately and never hold on to it.
const out = { x: 0, y: 0 };

/**
 * Steering push away from other apex bodies near `self`.
 *
 * Falls off linearly to zero at the avoid radius, so it's a nudge at the edge
 * and a hard shove at the centre — a step function here makes hunters visibly
 * flinch as they cross the boundary.
 *
 * @param self  { x, y, radius } — the creature steering
 * @param crowd array of { x, y, radius }, may include `self` (skipped)
 * @param cfg   CONFIG.apexCrowd
 * @returns the shared scratch vector; magnitude is roughly 0..strength*n
 */
export function crowdAvoid(self, crowd, cfg) {
  out.x = 0;
  out.y = 0;
  if (!cfg?.enabled || !crowd) return out;
  const gap = cfg.avoidGap ?? 3.2;
  const strength = cfg.avoidStrength ?? 1.5;
  for (const other of crowd) {
    if (other === self) continue;
    const dx = self.x - other.x;
    const dy = self.y - other.y;
    // Scaled by the two bodies' own sizes: a fed megalodon needs more room
    // than a dolphin, and a fixed world radius would have the big ones
    // overlapping while the small ones kept absurd distance.
    const want = (self.radius + other.radius) * gap;
    const d2 = dx * dx + dy * dy;
    if (d2 > want * want) continue;
    // Exactly coincident (spawned on the same point) — pick a deterministic
    // direction rather than dividing by zero and poisoning the vector with
    // NaN, which would freeze the steering for the rest of the run.
    if (d2 < 1e-6) {
      out.x += strength;
      continue;
    }
    const d = Math.sqrt(d2);
    const w = (1 - d / want) * strength;
    out.x += (dx / d) * w;
    out.y += (dy / d) * w;
  }
  return out;
}

/**
 * Decide which apex creatures are allowed to press the player this frame.
 *
 * Ranked by distance, closest first, with two corrections that stop it
 * flickering and stop it stalling:
 *
 *   incumbentBonus — a creature already committed counts as slightly closer
 *                    than it is, so a rival passing it by half a body length
 *                    doesn't swap them every other frame.
 *   feedTurn       — that bonus expires. Once a hunter has held the front for
 *                    its turn it is ranked honestly again and usually loses
 *                    the slot, which is what makes the pack rotate instead of
 *                    the first arrival owning the player forever.
 *
 * Mutates `feeding` and `feedTimer` on each creature.
 *
 * @param crowd array of creatures with { x, y, feeding, feedTimer }
 * @param target { x, y } — the player
 * @param dt seconds
 * @param cfg CONFIG.apexCrowd
 */
export function assignFeedingSlots(crowd, target, dt, cfg) {
  if (!cfg?.enabled || !crowd?.length) return;
  const slots = cfg.feedingSlots ?? 2;
  // Nothing to arbitrate: everyone gets in. Skipping the sort here also keeps
  // the common single-hunter case free.
  if (crowd.length <= slots) {
    for (const e of crowd) {
      e.feeding = true;
      e.feedTimer = (e.feedTimer ?? cfg.feedTurn ?? 4.5) - dt;
    }
    return;
  }

  const bonus = cfg.incumbentBonus ?? 2.5;
  for (const e of crowd) {
    const dx = e.x - target.x;
    const dy = e.y - target.y;
    e._rank = Math.sqrt(dx * dx + dy * dy);
    // The bonus only applies while this one's turn has time left on it.
    if (e.feeding && (e.feedTimer ?? 0) > 0) e._rank -= bonus;
  }
  crowd.sort((a, b) => a._rank - b._rank);

  for (let i = 0; i < crowd.length; i++) {
    const e = crowd[i];
    const wasFeeding = e.feeding === true;
    e.feeding = i < slots;
    if (e.feeding) {
      // Starting a turn: charge the clock. Continuing one: run it down.
      e.feedTimer = wasFeeding ? (e.feedTimer ?? 0) - dt : (cfg.feedTurn ?? 4.5);
    } else {
      // Waiting its turn, and its clock is reset so that when it does get the
      // slot it gets a full one rather than the tail of an old timer.
      e.feedTimer = cfg.feedTurn ?? 4.5;
    }
  }
}

/**
 * The direction a hunter should steer to approach the player, given the crowd.
 *
 * Committed hunters go straight in (plus avoidance). Everyone else converges
 * on a stand-off ring and circles it — inward when outside the ring, outward
 * when inside it, always with a tangential component, which is what turns
 * "waiting" into circling rather than into hovering.
 *
 * @param self  { x, y, radius, feeding, orbitDir, standoffDist }
 * @param toward { dirX, dirY, dist } — normalised direction to the player
 * @param crowd array of apex creatures
 * @param cfg CONFIG.apexCrowd
 * @returns the shared scratch vector — NOT normalised; steerTo does that.
 */
export function approachVector(self, toward, crowd, cfg) {
  let x = toward.dirX;
  let y = toward.dirY;

  // `inCrowd` is what keeps this to the tagged bodies. Without it, any hunter
  // outside the apex group would read as "never given a slot" and circle the
  // stand-off ring forever without ever closing.
  //
  // It is now also the opt-OUT for the wildlife sharks, which set it false
  // (CONFIG.cruiseHunt.standoffRing): a hunter whose pursuit turning circle is
  // twice the ring cannot converge on the player anyway, so the ring only ever
  // added a second circle to something already circling. They still steer
  // around each other — crowdAvoid below is separate and unconditional.
  // A body with a feeding slot leaves the ring and goes in — unless it
  // `holdsRing`, which a LUNGING hunter does (see crowdSelf in
  // entities/enemies.js): its way in is the run, its slot is spent as the
  // right to commit (lungeChase), and a body that also drove straight in
  // parked on top of the seal inside its own lunge floor and never ran again.
  if (cfg?.enabled && self.inCrowd === true && (self.feeding === false || self.holdsRing === true)) {
    const ring = self.standoffDist ?? cfg.standoff ?? 7;
    // How wrong the current distance is, as a signed fraction of the ring.
    // Clamped so a hunter arriving from across the arena doesn't approach at
    // ten times the weight of one already in position.
    const err = Math.max(-1, Math.min(1, (toward.dist - ring) / Math.max(1, ring)));
    const spin = self.orbitDir ?? 1;
    const circle = cfg.circleStrength ?? 1;
    x = toward.dirX * err - toward.dirY * spin * circle;
    y = toward.dirY * err + toward.dirX * spin * circle;
  }

  const avoid = crowdAvoid(self, crowd, cfg);
  out.x = x + avoid.x;
  out.y = y + avoid.y;
  return out;
}

/**
 * A per-creature stand-off radius, so the ring is a loose shoal rather than a
 * drawn circle. Called once per creature; the caller caches the result.
 */
export function pickStandoff(cfg, rand = Math.random) {
  const base = cfg?.standoff ?? 7;
  const jitter = cfg?.standoffJitter ?? 2.5;
  return base + (rand() * 2 - 1) * jitter;
}
