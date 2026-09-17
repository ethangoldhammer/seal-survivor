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
    // ---------------------------------------------------------------------
    // A BOSS DOES NOT QUEUE BEHIND ITS OWN ESCORTS.
    // ---------------------------------------------------------------------
    // The ranking is pure distance, and a boss is systematically the FURTHEST
    // apex body in the water: a lunging boss deliberately holds the ring
    // outside its own `minRange` (times lungeRules.standoffMul, so eight or
    // nine units) precisely so it can open the gap a run needs, while a plain
    // shark circles at the standoff of about seven. So the one body in the
    // arena whose whole job is to attack you was ranked last by the rule that
    // decides who may, every frame, forever.
    //
    // MEASURED, because the comment in lungeChase asserted the opposite ("a
    // single boss always holds a slot") and it was true only of a boss alone
    // in an empty arena — which is not a state a boss fight is ever in, since
    // the spawner narrows the pool to escorts and keeps sending them. With
    // five apex bodies around it, `npm run gates -- --escorts 5` had the four
    // lunging bosses refused on this gate for 75-85% of the fight and their
    // run rate halved: bossShark 6.2 committed runs a minute down to 3.0,
    // bossOrca 8.7 down to 4.3. That is the whole of "the boss never commits".
    //
    // It is seated rather than exempted. Taking it out of the list would also
    // take it out of `crowdAvoid`, so the escorts would stop steering around
    // the biggest body in the water — and it still SPENDS a slot, because the
    // ring's legibility is the point of the mechanism: two bodies pressing and
    // the rest circling. With a boss up, one of the two is always the boss.
    if (e.boss === true) e._rank = -Infinity;
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
    // THE CIRCLING FADES OUT WITH THE DISTANCE ERROR, and without this taper
    // the two terms are the same size whenever the body is a ring's width out
    // of position — which is to say a hunter forty units away steered 45
    // degrees off the player and closed at 71% of its own speed, forever.
    //
    // MEASURED, on the four chasing bosses, over 90-second fights against a
    // parked seal: on the frames they were not mid-run their heading was 61 to
    // 79 degrees off the seal on average, and 13-35% of those frames they were
    // pointed more than 90 degrees away — actively swimming off. That is the
    // "aimless wandering" in one number, and it was not the wander branch (a
    // boss never reaches it) or the weave (too small). It was this.
    //
    // The ring is still a ring. At `err` 0 the body is exactly where it wants
    // to be and the term is entirely tangential, which is the circling the
    // whole mechanism exists for: a crowd holding station legibly rather than
    // hovering. What changes is only the way IN — far out of position it now
    // comes almost straight, and the orbit resumes as it arrives.
    //
    // ONLY ON THE WAY IN — `Math.max(0, err)` and not `Math.abs(err)`, and the
    // difference is a body sitting ON TOP of the player rather than outside its
    // ring. There `err` is -1, and tapering on the absolute value cancelled the
    // circling there too, which turns "orbit out to the ring" into "back
    // straight off it". Nothing asked for that: this exists to fix the way IN.
    //
    // It is not theoretical. A boss carrying the seal in its jaws is at
    // distance zero by definition, so it took the inside-the-ring branch for
    // the whole hold — and npm run test:grab measures the held seal's motion in
    // the body's frame, where the boss's own orbit is part of what it reads.
    // Cancelling that took the bossShark from x2.96 on its phase test to x1.50,
    // under the x1.72 the free sine scores, with nothing about the jaw having
    // changed. Clamped here, both numbers come back.
    //
    // AND SHARED OUT AMONG WHOEVER IS COMPETING FOR THE RING, because the
    // circling on the way in is doing two different jobs and they want
    // opposite answers.
    //
    // For ONE body it is dead time: a boss forty units out steered 45 degrees
    // off the seal and closed at 71% of its own speed, which is what this
    // whole taper exists to stop. For SIX it is the thing that FANS THEM OUT —
    // six hunters coming straight in converge on one line and arrive stacked,
    // and crowdAvoid alone is not enough to separate them. Measured with the
    // taper applied flat, npm run test:crowd went from a closest pair of 1.5
    // units to 0.7, with an overlapping pair and the heading spread down from
    // 0.67 to 0.50: the fix for the boss was a regression for the pack.
    //
    // So a body alone in the crowd takes the whole taper and a body sharing
    // the ring gives it back in proportion. A boss fight is the `1` case by
    // construction — clearForBoss empties the water — and a school of apex
    // sharks is the `6` case, which is the same split the two measurements
    // were pointing at from either side.
    let sharing = 0;
    for (const other of crowd ?? []) {
      if (other !== self && other?.inCrowd === true) sharing += 1;
    }
    const taper = (cfg.circleTaper ?? 1) / (1 + sharing);
    const circle = (cfg.circleStrength ?? 1) * (1 - taper * Math.max(0, err));
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
