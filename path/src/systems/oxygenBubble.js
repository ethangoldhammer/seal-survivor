import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, seabedTopY } from '../arena.js';

// ---------------------------------------------------------------------------
// THE OXYGEN BUBBLE — the one pickup in the game that is a physical object.
//
// It used to be a 0.6-unit ball that appeared somewhere in the lower 40% of the
// arena and travelled straight up at a constant 1.6 units a second until its
// timer ran out. Nothing in the water could touch it, nothing it passed through
// noticed it, and it arrived by teleporting into open water — which is not how
// air behaves and, more to the point, is not how anything ELSE in this game
// behaves. The whole arena is a physics scene; this was a sprite in it.
//
// So it is a bubble now, in three parts, and they are separable on purpose:
//
//   BIRTH   it seeps out of the seabed and SWELLS. `growTime` is the only thing
//           that makes an arriving bubble legible as an event rather than as a
//           pop-in, and it is also the game's only free tell that a breath is
//           on its way from down there.
//   DRIFT   buoyancy toward a terminal speed, plus a slow horizontal wander.
//           NOT a constant velocity: a bubble that has been shoved has to lose
//           that shove over a second or two, which means the rise has to be a
//           force and not a position write.
//   SKIN    a budget of shove it can absorb before the film gives way. Every
//           creature that barges through spends some of it; the budget heals
//           back, so a bubble bumped once on its way up survives and a bubble
//           caught between two bodies does not.
//
// THE PINCH IS THE INTERESTING PART, and it falls out of the arithmetic rather
// than being a special case. Each frame the bubble collects a push vector from
// every body overlapping it. The NET of those vectors is what moves it. The
// difference between the sum of their magnitudes and the magnitude of their sum
// is what CANCELS — which is precisely "how hard is this thing being squeezed
// from two sides at once", and it costs `pinchMul` times as much skin as a
// clean shove does. One shark barging through moves the bubble and barely marks
// it; the same shark against a wall of crabs bursts it, because none of that
// push went anywhere.
//
// Nothing here writes the scene. The caller (entities/pickups.js) owns the
// mesh, the lifetime and the collect test; this owns where the bubble is and
// whether it is still whole. That split is what lets the Node harness in
// tools/oxygen-bubble-test.mjs drive the physics with no renderer at all.
// ---------------------------------------------------------------------------

function cfg() {
  return CONFIG.oxygen?.bubble ?? {};
}

/**
 * A point on the seabed for a bubble to seep out of.
 *
 * The floor, not "the lower 40% of the arena" — a bubble is air escaping from
 * somewhere, and there is exactly one surface down there it can escape from.
 * Set a little INSIDE the sand so the first frames of the swell are half
 * buried, which is what makes it read as coming out of the floor rather than
 * as being placed on it.
 */
export function bubbleBirthPoint(rand = Math.random) {
  return new THREE.Vector3(
    bounds.left + rand() * bounds.width,
    seabedTopY() - (cfg().birthDepth ?? 0.15),
    0,
  );
}

/**
 * Seed the physics state on a freshly spawned bubble. Called once, by whoever
 * built the mesh — `orb` is the pickup record, not the mesh.
 *
 * `baseScale` is what the mesh was already wearing (the asset's own size
 * multiplier), remembered here so the swell can multiply INTO it rather than
 * over it. Writing an absolute scale instead is how a pickup ends up ignoring
 * assets.csv — see the note on spawn size in the asset table.
 */
export function initBubble(orb, rand = Math.random) {
  const c = cfg();
  orb.vx = 0;
  orb.vy = 0;
  // 0..1, eased on read. Starts at a sliver rather than at 0 so the first
  // frame draws something — a scale of exactly 0 collapses the normals and
  // the fresnel comes back as a black dot for one frame.
  orb.grow = 0.02;
  orb.baseScale = orb.mesh?.scale?.x ?? 1;
  orb.skin = 1;
  orb.age = 0;
  orb.swayPhase = rand() * Math.PI * 2;
  // Per-bubble, so a pair rising side by side wander apart instead of tracking
  // each other. Small spread: they are all the same size of bubble in the same
  // water, and a wide one reads as two different objects.
  orb.swayRate = (c.swayHz ?? 0.28) * (0.75 + rand() * 0.5);
  orb.wobblePhase = rand() * Math.PI * 2;
  return orb;
}

/** Eased swell, 0..1 — fast out of the sand, easing into its full size. */
export function growthOf(orb) {
  const t = Math.max(0, Math.min(1, orb.grow ?? 1));
  // Slight overshoot at the end: a bubble that pinches off the floor snaps to
  // round, and arriving at exactly its final size with zero velocity is the
  // one thing that reads as an animation stopping.
  const over = cfg().growOvershoot ?? 0.12;
  const e = 1 - Math.pow(1 - t, 3);
  return e * (1 + over * Math.sin(t * Math.PI));
}

/**
 * The bubble's CURRENT world radius — its asset radius times whatever size
 * multiplier the mesh carries times how far it has swelled.
 *
 * Exported because three separate things need the same answer and disagreeing
 * about it is invisible: the collect test in pickups.js widens by it (so a
 * bubble is taken by touching its skin), the collision loop below tests
 * against it, and the harness asserts on it. A half-grown bubble genuinely is
 * a smaller target.
 */
export function bubbleRadius(orb) {
  const base = (orb.assetRadius ?? 0.44) * (orb.baseScale ?? 1);
  return base * growthOf(orb);
}

// How hard one body shoves a bubble it is overlapping.
//
// Two terms, because a bubble is knocked about by two different things. A
// creature MOVING through it hands over its speed; a creature merely sitting
// inside it still has to push it out, or a bubble that rises into a stationary
// crab simply passes through it. `minShove` is that second term and it is
// deliberately small — being nudged aside by something asleep should take a
// while.
function shoveFrom(relSpeed, overlapFrac, c) {
  const gain = c.knockGain ?? 1.35;
  const min = c.minShove ?? 1.1;
  return (relSpeed * gain + min) * Math.max(0, Math.min(1, overlapFrac));
}

/**
 * One bubble, one frame.
 *
 * `bodies` is anything with a world position, a radius and (optionally) vx/vy
 * — the enemy list, as it comes. Passing nothing is legal and gives a bubble
 * rising through empty water, which is what every existing harness does.
 *
 * Returns 'popped' if the film gave way this frame, otherwise null. The caller
 * decides what that means (the pop FX, the array splice); popping is NOT a
 * collect and pays no oxygen — that is the whole risk the pickup now carries.
 */
export function updateBubblePhysics(dt, orb, bodies = null) {
  const c = cfg();
  orb.age = (orb.age ?? 0) + dt;

  // --- the swell ------------------------------------------------------------
  const growTime = Math.max(0.01, c.growTime ?? 1.1);
  if ((orb.grow ?? 1) < 1) orb.grow = Math.min(1, (orb.grow ?? 0) + dt / growTime);

  const r = bubbleRadius(orb);
  const pos = orb.mesh.position;

  // --- buoyancy -------------------------------------------------------------
  // Toward a terminal speed rather than at it, so a shove decays instead of
  // being overwritten. `bubbleRiseSpeed` stays the number that means "how fast
  // does a bubble go up" — this only changes how it gets there.
  const rise = CONFIG.oxygen?.bubbleRiseSpeed ?? 1.6;
  // ...AND IT YIELDS TO THE MAGNET. Buoyancy is a force that re-asserts itself
  // in well under a second, which is correct for a shove and completely wrong
  // for the seal reaching for it: a bubble ABOVE the player had its downward
  // pull erased faster than the magnet could apply it, so the one pickup you
  // most want to come to you was the one that could only ever be chased.
  // `magnetHold` is set by the caller on any frame the magnet has it, and it
  // is consumed rather than latched — let go and it floats again on the next
  // frame.
  const lift = (c.lift ?? 3.2) * (orb.magnetHold ? (c.magnetLiftMul ?? 0.15) : 1);
  orb.vy += (rise - orb.vy) * Math.min(1, lift * dt);

  // --- the wander -----------------------------------------------------------
  // An acceleration, not a position offset. A bubble pushed sideways and then
  // released should ease back into its own drift; an offset written on top of
  // the position would snap it back to the line it was travelling on and undo
  // every knock the moment the creature let go.
  const sway = c.sway ?? 1.1;
  orb.vx += Math.cos(orb.age * (orb.swayRate ?? 0.28) * Math.PI * 2 + (orb.swayPhase ?? 0)) * sway * dt;
  // Drag yields too, and for the same reason — it is what stops a shoved
  // bubble, and the magnet is a shove the player asked for.
  const drag = (c.drag ?? 1.6) * (orb.magnetHold ? (c.magnetLiftMul ?? 0.15) : 1);
  orb.vx -= orb.vx * Math.min(1, drag * dt);

  // --- what is touching it --------------------------------------------------
  let spent = 0;
  if (bodies?.length) spent = applyBodyShoves(dt, orb, bodies, r, c);

  // --- the skin -------------------------------------------------------------
  const heal = c.skinHeal ?? 0.5;
  const toughness = Math.max(0.01, c.toughness ?? 2.6);
  orb.skin = Math.min(1, (orb.skin ?? 1) - spent / toughness + heal * dt);

  // A speed ceiling AFTER the shoves, so a pile-up cannot fling a bubble
  // across the arena in a frame. Applied to the whole velocity rather than
  // per-axis: clamping x and y separately turns a fast diagonal into a
  // direction change, which reads as the bubble steering.
  const maxSpeed = c.maxSpeed ?? 14;
  const sp = Math.hypot(orb.vx, orb.vy);
  if (sp > maxSpeed) {
    orb.vx *= maxSpeed / sp;
    orb.vy *= maxSpeed / sp;
  }

  pos.x += orb.vx * dt;
  pos.y += orb.vy * dt;

  // --- the walls ------------------------------------------------------------
  // Bounced, not clamped, and the bounce costs skin like anything else does —
  // a bubble driven into the arena wall by a shark is being crushed against
  // something. `wallBounce` under 1 is what stops one rattling side to side.
  const bounce = c.wallBounce ?? 0.4;
  if (pos.x < bounds.left + r) {
    pos.x = bounds.left + r;
    if (orb.vx < 0) { orb.skin -= (-orb.vx * (c.wallCost ?? 0.05)) / toughness; orb.vx *= -bounce; }
  } else if (pos.x > bounds.right - r) {
    pos.x = bounds.right - r;
    if (orb.vx > 0) { orb.skin -= (orb.vx * (c.wallCost ?? 0.05)) / toughness; orb.vx *= -bounce; }
  }
  // The seabed, for a bubble shoved back down into it. It cannot go through.
  const floorY = seabedTopY() + r * 0.35;
  if (pos.y < floorY) {
    pos.y = floorY;
    if (orb.vy < 0) orb.vy = 0;
  }
  // The surface. It stops here and bobs rather than popping: a bubble that
  // burst on arrival would mean the pickup expires on a timer the player
  // cannot see and has no way to beat from across the arena.
  const ceiling = bounds.surfaceY - r * 0.6;
  if (pos.y > ceiling) {
    pos.y = ceiling;
    if (orb.vy > 0) orb.vy *= -0.15;
  }

  // --- the look -------------------------------------------------------------
  applyBubbleShape(orb, r);

  // Consumed, not latched — the caller re-raises it every frame the magnet
  // still has the bubble, so letting go hands it straight back to buoyancy.
  orb.magnetHold = false;

  if (orb.skin <= 0) return 'popped';
  return null;
}

// Every body overlapping the bubble, resolved into one net push plus a measure
// of how much of that push cancelled out. Returns the skin spent this frame.
function applyBodyShoves(dt, orb, bodies, r, c) {
  const pos = orb.mesh.position;
  let netX = 0;
  let netY = 0;
  let gross = 0;
  for (const b of bodies) {
    // Enemies keep their position on the mesh, never as b.x/b.y — reading the
    // fields that do not exist would make a NaN velocity here and a bubble
    // that vanishes with no error attached to it.
    const bp = b?.mesh?.position;
    if (!bp) continue;
    // A body being eaten, bubbled or already dead is not pushing anything.
    if (b.dead || b.removed) continue;
    const br = b.radius ?? b.def?.radius ?? 0;
    if (!(br > 0)) continue;
    const dx = pos.x - bp.x;
    const dy = pos.y - bp.y;
    const d = Math.hypot(dx, dy);
    const reach = r + br;
    if (d >= reach) continue;
    // Dead centre: shove it straight up, which is where it wanted to go
    // anyway, rather than dividing by zero and picking a random direction.
    const nx = d > 1e-4 ? dx / d : 0;
    const ny = d > 1e-4 ? dy / d : 1;
    const relSpeed = Math.hypot(b.vx ?? 0, b.vy ?? 0);
    const push = shoveFrom(relSpeed, (reach - d) / reach, c);

    // WHICH WAY THE SHOVE POINTS. Not purely radial, and that is the one thing
    // here that had to be got right by feel rather than by physics.
    //
    // A body ploughing straight through the middle of a bubble pushes it
    // FORWARD on the way in and BACKWARD on the way out — perfectly
    // symmetrical, so a shark swimming through a bubble left it exactly where
    // it found it while spending most of its skin. That is arguably correct
    // and it looks like nothing happened. What a bubble in front of something
    // moving actually does is get carried along in the water it is displacing,
    // so the direction is blended toward the body's own heading and the barge
    // reads as a barge.
    //
    // The pinch survives this untouched, which is why it is safe: two bodies
    // closing head-on have OPPOSITE headings, so the blend cancels exactly as
    // the radial term does.
    let dirX = nx;
    let dirY = ny;
    const bias = c.travelBias ?? 0.55;
    if (relSpeed > 1e-4 && bias > 0) {
      dirX = nx * (1 - bias) + ((b.vx ?? 0) / relSpeed) * bias;
      dirY = ny * (1 - bias) + ((b.vy ?? 0) / relSpeed) * bias;
      const dl = Math.hypot(dirX, dirY) || 1;
      dirX /= dl;
      dirY /= dl;
    }
    netX += dirX * push;
    netY += dirY * push;
    gross += push;
  }
  if (gross <= 0) return 0;

  const net = Math.hypot(netX, netY);
  orb.vx += netX * dt;
  orb.vy += netY * dt;

  // THE SQUEEZE. Whatever did not survive the vector sum is push that went
  // into the bubble instead of into moving it. See the header.
  const cancelled = Math.max(0, gross - net);
  return (net + cancelled * (c.pinchMul ?? 5)) * dt;
}

// The skin under load: a bubble is not a rigid ball, so it wobbles as it rises
// and it visibly SAGS as its budget is spent. That sag is the only warning the
// player gets that one more shove will burst it, and it is the reason the skin
// is a continuous number rather than a hit count.
function applyBubbleShape(orb, r) {
  const c = cfg();
  const mesh = orb.mesh;
  if (!mesh) return;
  const base = (orb.baseScale ?? 1) * growthOf(orb);
  const wob = (c.wobble ?? 0.05) * (1 + (1 - (orb.skin ?? 1)) * (c.strainWobble ?? 2.2));
  const w = orb.age * (c.wobbleHz ?? 1.5) * Math.PI * 2 + (orb.wobblePhase ?? 0);
  // Volume-preserving: what it gains across it loses up its axis. A bubble
  // that simply pulsed bigger and smaller reads as breathing, which is a
  // creature's tell and not a gas's.
  const sx = 1 + Math.sin(w) * wob;
  mesh.scale.set(base * sx, base / sx, base);
  // Squashed the way it is TRAVELLING, very slightly — the leading face of a
  // rising bubble flattens against the water it is pushing.
  const lead = Math.min(1, Math.abs(orb.vy ?? 0) / 6) * (c.travelSquash ?? 0.1);
  mesh.scale.y *= 1 + lead;
  mesh.scale.x *= 1 - lead * 0.6;
  void r;
}

// ---------------------------------------------------------------------------
// HOW OFTEN AIR ARRIVES — a POPULATION, not a cadence.
//
// The spawner used to be one interval timer: every 7-13 seconds a bubble seeps
// out, and whatever the arena happened to be holding at the time was whatever
// it was holding. Against a 14-second life that averages a bubble and a half,
// which sounds fine and is not what it feels like — the average is made of
// stretches with two of them up and stretches with none, and the empty ones
// land wherever the rolls happen to cluster. A pickup you cannot see is a
// pickup that does not exist, so on a bad run of rolls the one answer to a
// half-empty tank is a swim to the surface, and the whole floor stops being a
// place air comes from.
//
// So the arena carries a headcount instead. `bubbleMinAlive` is a FLOOR the
// spawner refills toward on a short clock, `bubbleMaxAlive` is the cap it will
// not top up past, and the 7-13 interval is only what paces the trip between
// them. The interval still exists because the gap between one and two is the
// part that should feel like weather; the floor exists because the gap between
// one and none should not happen at all.
//
// Two details, both of which read as bugs if they are got wrong:
//
//   THE REFILL IS NOT INSTANT. A bubble taken (or burst in a crowd) would
//   otherwise be replaced on the same frame, and a headcount that repairs
//   itself inside a frame is a spawner the player can see working.
//   `bubbleRefillDelay` is the beat before the floor sends up another.
//   AT THE CAP THE CLOCK HOLDS. Counting down while the arena is already full
//   banks spawns, and the moment one is collected the banked ones all arrive
//   together — two bubbles out of the floor in the same second, which is the
//   one thing a cap is supposed to prevent.
//
// Pure, and takes the count rather than the array, so tools/oxygen-bubble-
// test.mjs can run an hour of arena through it with no scene at all.
// ---------------------------------------------------------------------------

/** One roll of the ambient interval — the trip from the floor up to the cap. */
export function rollBubbleSpawnDelay(rand = Math.random) {
  const lo = CONFIG.oxygen?.bubbleSpawnMin ?? 4;
  const hi = CONFIG.oxygen?.bubbleSpawnMax ?? 8;
  return lo + rand() * Math.max(0, hi - lo);
}

/**
 * One frame of the spawner. `timer` is the caller's countdown, `alive` is how
 * many bubbles the arena is holding right now (every one of them — a bubble
 * shaken out of a boat's hull is air in the water exactly as much as one that
 * seeped out of the sand, and it should hold the floor off).
 *
 * Returns the new timer and whether a bubble should be born this frame.
 */
export function stepBubbleSpawner(dt, timer, alive, rand = Math.random) {
  const o = CONFIG.oxygen ?? {};
  const min = o.bubbleMinAlive ?? 1;
  const max = Math.max(min, o.bubbleMaxAlive ?? 2);
  // At the cap the clock holds where it is. See the header.
  if (alive >= max) return { timer, spawn: false };
  // Below the floor the wait is cut to the refill beat — Math.min rather than
  // an assignment, so a timer already shorter than the beat is left alone
  // instead of being pushed back out every frame the arena is short.
  let t = timer;
  if (alive < min) t = Math.min(t, o.bubbleRefillDelay ?? 0.9);
  t -= dt;
  if (t > 0) return { timer: t, spawn: false };
  return { timer: rollBubbleSpawnDelay(rand), spawn: true };
}
