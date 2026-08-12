import { bounds } from '../arena.js';
import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// THE THINGS THAT GET KNOCKED AROUND.
//
// Two bodies in this game are not really combatants: the sea turtle, which
// cannot die (hp 1e9 — see entities/enemies.js), and a boat, which cannot
// chase. Both spend their whole life being hit by something. That makes them
// the only two things worth simulating rather than animating: a creature that
// dies to a strike never needs to tumble, but a turtle that survives every
// strike forever can be a ball the seal plays with, and a hull that has been
// rammed into another hull is a chain reaction the fight cannot otherwise
// produce.
//
// So both get the same body, and it is deliberately a SMALL one:
//
//   * linear velocity, integrated on top of whatever the owner's own
//     locomotion already did — the body is the shove, never the swimming or
//     the sailing, so nothing has to give up its steering to have one.
//   * ONE angular degree of freedom, the roll about the screen normal. This
//     is a side-on 2D game; a body that pitched or yawed would be rotating
//     into the camera where the motion cannot be read anyway.
//   * a RIGHTING SPRING on that roll. Every body here floats, and a floating
//     thing has a right way up it returns to. That is the whole reason this
//     is one class: the crab has a version of it (CONFIG.crabPhysics), the
//     boat had another, and they had drifted into two different springs with
//     two different sets of names for the same three numbers.
//
// What it deliberately is NOT: a general physics engine. Angular velocity
// does not feed back into the contact point's velocity, so a spinning body
// does not fling what it touches — the roll is dressing on a linear impulse.
// Boxes collide as axis-aligned, which is true to within the roll clamp a
// hull is allowed (±0.55 rad) and never true for a tumbling turtle, which is
// why the turtle is a circle.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

// Fold an angle into (-PI, PI]. A turtle that has spun three and a half times
// is a turtle lying on its back, and the righting spring has to unwind it the
// SHORT way — without this the spring sees 22 radians of error and rewinds
// three full visible turns before settling, which reads as a bug rather than
// as an animal righting itself.
export function wrapAngle(a) {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

export class RigidBody {
  constructor(opts = {}) {
    // What this is, for the collision rules that care (see canCollide).
    this.kind = opts.kind ?? 'body';
    this.shape = opts.shape ?? 'circle';
    // The entity this body belongs to, and the mesh it drives. The step writes
    // position and roll straight onto the mesh so there is exactly one place
    // that does it, rather than every owner remembering to read the body back.
    this.owner = opts.owner ?? null;
    this.object = opts.object ?? null;

    this.radius = opts.radius ?? 1;
    this.halfLength = opts.halfLength ?? this.radius;
    this.halfHeight = opts.halfHeight ?? this.radius;
    // Where the box actually sits relative to the mesh origin. Hulls are
    // anchored on their centre of mass, which is not the centre of the box —
    // see hullExtents in boats.js.
    this.offsetX = opts.offsetX ?? 0;
    this.offsetY = opts.offsetY ?? 0;

    this.setMass(opts.mass ?? 1);
    this.drag = opts.drag ?? 1;
    this.angularDrag = opts.angularDrag ?? 1;
    this.righting = opts.righting ?? 0;
    this.rightingDamping = opts.rightingDamping ?? 0;
    // Speed above which the righting spring lets go entirely, fading back in
    // as the body slows. A thing that is still flying does not right itself —
    // it tumbles, and it sorts itself out when it lands. Without this the
    // spring fights the tumble from the first frame and a turtle punted across
    // the arena arrives perfectly level, which is the whole effect gone. 0
    // means "always upright me", which is what a hull wants.
    this.rightingSpeed = opts.rightingSpeed ?? 0;
    this.maxAngle = opts.maxAngle ?? Infinity;
    // Whether a full turn counts as upright. True for anything that may roll
    // all the way over (the turtle), false for anything clamped short of it
    // (a hull, which capsizes only by sinking).
    this.wrap = opts.wrap ?? false;
    // Radians of roll per unit of torque — the dial between "shoves and stays
    // level" and "cartwheels".
    this.spin = opts.spin ?? 0;
    this.restitution = opts.restitution ?? null; // null = the shared default
    // Arena walls. A hull sails THROUGH them to despawn; a turtle bounces.
    this.walls = opts.walls ?? false;
    this.wallRestitution = opts.wallRestitution ?? 0.5;
    // Whether the water line is a wall for this body or just water. False for
    // the turtle, which skips off the underside of the surface rather than
    // being launched into the sky — the same rule its clampBelowSurface gave
    // it before it had a body.
    this.breaches = opts.breaches ?? false;
    // Set by the owner while the body is deliberately leaving the arena, which
    // opens the side walls it would otherwise bounce off. See hitWalls.
    this.escaping = false;
    this.collides = opts.collides !== false;

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    // Accelerations applied by the owner this frame (a boat's thrust and
    // buoyancy), consumed and cleared at the next integrate.
    this.ax = 0;
    this.ay = 0;

    // Roll, measured as an OFFSET from restAngle — the orientation the owner
    // would have used if nothing had ever hit it (a turtle's heading, a
    // hull's bob). Keeping them apart is what lets the spring right the body
    // to a rest pose that is itself moving.
    this.angle = 0;
    this.angVel = 0;
    this.restAngle = 0;

    // Seconds left of "something hit this recently". Only used to decide
    // whether two hulls are allowed to touch — see canCollide.
    this.disturbed = 0;
    // Largest impulse this body took since the last frame, for owners that
    // want to react to being hit without subscribing to the impact hook.
    this.lastImpulse = 0;
  }

  setMass(mass) {
    this.mass = mass;
    // Infinite mass means immovable, and 1/Infinity is 0, which the solver
    // already handles correctly — a body with no invMass simply takes none of
    // the impulse.
    this.invMass = mass > 0 && Number.isFinite(mass) ? 1 / mass : 0;
  }

  /** Where the owner's own locomotion has left it this frame. */
  place(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  /** An acceleration for this frame only (thrust, buoyancy, gravity). */
  addAcceleration(ax, ay) {
    this.ax += ax;
    this.ay += ay;
  }

  /**
   * An impulse, in mass-units per second — the velocity change is divided by
   * mass, so the same hit that launches a turtle only leans on a trawler.
   *
   * `atX, atY` is where it landed, in world space. The lever arm from the
   * body's centre to that point is what makes hitting a bow spin a hull and
   * hitting it amidships shove it flat, and it is the same 2D cross product
   * the boats already used — now shared, so the turtle gets it for free.
   */
  applyImpulse(ix, iy, atX = null, atY = null) {
    const dv = this.invMass;
    if (dv === 0) return 0;
    this.vx += ix * dv;
    this.vy += iy * dv;

    const arm = Math.max(this.shape === 'box' ? this.halfLength : this.radius, 1e-3);
    if (atX != null && atY != null) {
      const rx = atX - (this.x + this.offsetX);
      const ry = atY - (this.y + this.offsetY);
      this.angVel += ((rx * iy - ry * ix) / arm) * this.spin * dv;
    } else {
      // No contact point: a shove with no known lever arm still has to look
      // like it landed somewhere, so it rolls the body a random way.
      const push = Math.hypot(ix, iy) * dv;
      this.angVel += push * this.spin * (Math.random() < 0.5 ? -1 : 1);
    }

    const p = CONFIG.physics ?? {};
    this.disturbed = p.disturbedFor ?? 1.5;
    const mag = Math.hypot(ix, iy) * dv;
    if (mag > this.lastImpulse) this.lastImpulse = mag;
    return mag;
  }

  speed() {
    return Math.hypot(this.vx, this.vy);
  }

  /** Is anything about this body still moving? */
  get awake() {
    return this.speed() > 0.02 || Math.abs(this.angVel) > 0.02 || Math.abs(this.angle) > 1e-3;
  }

  integrate(dt) {
    if (this.disturbed > 0) this.disturbed = Math.max(0, this.disturbed - dt);

    this.vx += this.ax * dt;
    this.vy += this.ay * dt;
    this.ax = 0;
    this.ay = 0;

    // Exponential drag rather than a subtraction, so the decay is the same at
    // any frame rate and never overshoots through zero into a body that
    // reverses because the frame was long.
    if (this.drag > 0) {
      const keep = Math.exp(-this.drag * dt);
      this.vx *= keep;
      this.vy *= keep;
    }
    if (Math.abs(this.vx) < 1e-4) this.vx = 0;
    if (Math.abs(this.vy) < 1e-4) this.vy = 0;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // THE RIGHTING SPRING. Torque toward upright, damped so the body settles
    // instead of ringing, and a separate drag on the spin so a body that has
    // been sent cartwheeling loses the spin itself rather than only being
    // pulled back by the spring.
    if (this.righting > 0) {
      const err = this.wrap ? wrapAngle(this.angle) : this.angle;
      // Damping applies whatever the body is doing — that is what makes a
      // tumble slow down rather than run forever — but the pull toward upright
      // fades out while it is travelling. See rightingSpeed.
      const settled = this.rightingSpeed > 0
        ? Math.max(0, 1 - this.speed() / this.rightingSpeed)
        : 1;
      this.angVel += (-this.righting * settled * err - this.rightingDamping * this.angVel) * dt;
    }
    if (this.angularDrag > 0) this.angVel *= Math.exp(-this.angularDrag * dt);
    this.angle += this.angVel * dt;
    if (this.wrap) this.angle = wrapAngle(this.angle);

    // The clamp is what stops a hull going over. The angular velocity dies at
    // the stop too, or the spring keeps driving into it and the body sticks at
    // the limit instead of rocking back off it.
    if (this.angle > this.maxAngle) {
      this.angle = this.maxAngle;
      if (this.angVel > 0) this.angVel = 0;
    } else if (this.angle < -this.maxAngle) {
      this.angle = -this.maxAngle;
      if (this.angVel < 0) this.angVel = 0;
    }
    if (Math.abs(this.angle) < 1e-4 && Math.abs(this.angVel) < 1e-3) {
      this.angle = 0;
      this.angVel = 0;
    }

    if (this.walls) this.hitWalls();
  }

  // Bounce off the arena. Real reflection, not the clamp everything else gets:
  // a turtle launched at the sea floor should come back off it, and a clamp
  // would park it against the sand with its velocity still pointing down.
  hitWalls() {
    const r = this.shape === 'box' ? Math.max(this.halfLength, this.halfHeight) : this.radius;
    const e = this.wallRestitution;
    let bounced = 0;
    // ON ITS WAY OUT. The side walls open for a body that has decided to
    // leave (a turtle whose stay is up — see BEHAVIORS.drift); the floor and
    // the water line below stay solid, because swimming out is a horizontal
    // act and the alternative is a departing turtle drifting up through the
    // surface. Set and cleared by the owner, never by the solver.
    if (this.escaping) {
      // fall through to the vertical limits
    } else if (this.x < bounds.left + r) {
      this.x = bounds.left + r;
      if (this.vx < 0) { this.vx = -this.vx * e; bounced = Math.abs(this.vx); }
    } else if (this.x > bounds.right - r) {
      this.x = bounds.right - r;
      if (this.vx > 0) { this.vx = -this.vx * e; bounced = Math.abs(this.vx); }
    }
    // The water line is a wall for anything that lives under it. Bodies that
    // may breach set `breaches` and get the arena ceiling instead.
    const ceiling = (this.breaches ? bounds.top : bounds.surfaceY) - r;
    if (this.y > ceiling) {
      this.y = ceiling;
      if (this.vy > 0) { this.vy = -this.vy * e; bounced = Math.max(bounced, Math.abs(this.vy)); }
    } else if (this.y < bounds.bottom + r) {
      this.y = bounds.bottom + r;
      if (this.vy < 0) { this.vy = -this.vy * e; bounced = Math.max(bounced, Math.abs(this.vy)); }
    }
    // A bounce is a hit like any other: it spins the body. Without this a
    // turtle skips off the seabed perfectly level, which is the one thing a
    // knocked-around body should never look like.
    if (bounced > 0.5) this.angVel += bounced * this.spin * 0.15 * (Math.random() < 0.5 ? -1 : 1);
  }

  /** Position and roll onto the mesh. The one place either is written. */
  writeBack() {
    if (!this.object) return;
    this.object.position.x = this.x;
    this.object.position.y = this.y;
    this.object.rotation.z = this.restAngle + this.angle;
  }
}

// ---------------------------------------------------------------------------
// The world: every live body, stepped together so a hull shoved into a turtle
// and a turtle shoved into a hull are the same event resolved once.
// ---------------------------------------------------------------------------

export const bodies = [];

export function addBody(body) {
  if (body && !bodies.includes(body)) bodies.push(body);
  return body;
}

export function removeBody(body) {
  const i = bodies.indexOf(body);
  if (i >= 0) bodies.splice(i, 1);
}

export function resetBodies() {
  bodies.length = 0;
}

// Two hulls sailing normally do NOT touch. They cross the arena in opposite
// directions on the same line, both under thrust, so a solid collision between
// them is a head-on deadlock: neither can win, and the pair grinds to a stop
// in the middle of the screen for the rest of the run. What SHOULD collide is
// a hull that has just been hit — the turtle punt, the blast wave — and that
// is exactly what `disturbed` marks. It expires, so even a pair left
// overlapping by a chain reaction quietly separates once the fight moves on.
function canCollide(a, b) {
  if (!a.collides || !b.collides) return false;
  if (a.kind === 'boat' && b.kind === 'boat') {
    if (CONFIG.physics?.boatVsBoat === false) return false;
    return a.disturbed > 0 || b.disturbed > 0;
  }
  return true;
}

// Contact between two bodies, or null. The normal points from `a` to `b`.
function contact(a, b) {
  if (a.shape === 'circle' && b.shape === 'circle') return circleCircle(a, b);
  if (a.shape === 'circle' && b.shape === 'box') return circleBox(a, b, 1);
  if (a.shape === 'box' && b.shape === 'circle') return circleBox(b, a, -1);
  return boxBox(a, b);
}

function circleCircle(a, b) {
  const dx = (b.x + b.offsetX) - (a.x + a.offsetX);
  const dy = (b.y + b.offsetY) - (a.y + a.offsetY);
  const sum = a.radius + b.radius;
  const d2 = dx * dx + dy * dy;
  if (d2 > sum * sum) return null;
  const d = Math.sqrt(d2) || 1e-6;
  return { nx: dx / d, ny: dy / d, depth: sum - d, px: a.x + (dx / d) * a.radius, py: a.y + (dy / d) * a.radius };
}

// `sign` flips the normal when the caller's a/b are the other way round, so
// one routine serves both orderings.
function circleBox(c, box, sign) {
  const bx = box.x + box.offsetX;
  const by = box.y + box.offsetY;
  const cx = c.x + c.offsetX;
  const cy = c.y + c.offsetY;
  const dx = cx - bx;
  const dy = cy - by;
  const qx = Math.max(-box.halfLength, Math.min(box.halfLength, dx));
  const qy = Math.max(-box.halfHeight, Math.min(box.halfHeight, dy));
  let ox = dx - qx;
  let oy = dy - qy;
  let d = Math.hypot(ox, oy);
  let depth;
  if (d < 1e-6) {
    // Centre is INSIDE the box — there is no outward direction to read off
    // the nearest point, so leave along whichever face is closest. Without
    // this a turtle that ends a frame fully inside a hull gets a zero-length
    // normal and is never pushed out of it.
    const ex = box.halfLength - Math.abs(dx);
    const ey = box.halfHeight - Math.abs(dy);
    if (ex < ey) { ox = Math.sign(dx) || 1; oy = 0; depth = ex + c.radius; }
    else { ox = 0; oy = Math.sign(dy) || 1; depth = ey + c.radius; }
    d = 1;
  } else {
    if (d > c.radius) return null;
    depth = c.radius - d;
    ox /= d;
    oy /= d;
    d = 1;
  }
  // Normal from the BOX toward the CIRCLE; flipped to the caller's ordering.
  return {
    nx: -ox * sign,
    ny: -oy * sign,
    depth,
    px: cx - ox * c.radius,
    py: cy - oy * c.radius,
  };
}

function boxBox(a, b) {
  const ax = a.x + a.offsetX;
  const ay = a.y + a.offsetY;
  const bx = b.x + b.offsetX;
  const by = b.y + b.offsetY;
  const dx = bx - ax;
  const dy = by - ay;
  const px = (a.halfLength + b.halfLength) - Math.abs(dx);
  if (px <= 0) return null;
  const py = (a.halfHeight + b.halfHeight) - Math.abs(dy);
  if (py <= 0) return null;
  // Least-penetration axis: the way out that moves them apart the least is
  // the way they came in.
  if (px < py) {
    const s = Math.sign(dx) || 1;
    return { nx: s, ny: 0, depth: px, px: ax + s * a.halfLength, py: ay + Math.max(-a.halfHeight, Math.min(a.halfHeight, dy)) };
  }
  const s = Math.sign(dy) || 1;
  return { nx: 0, ny: s, depth: py, px: ax + Math.max(-a.halfLength, Math.min(a.halfLength, dx)), py: ay + s * a.halfHeight };
}

// Impacts found this frame, reported to the game AFTER the pass that found
// them. A hook is allowed to SINK a boat, which unregisters its body — and
// splicing `bodies` from inside the pair loop below shifts every index after
// it, so the loop walks straight past bodies it has not compared yet and can
// go on to resolve contacts for a hull that is already wreckage. Collecting
// them and reporting afterwards keeps the pass over a list nothing is editing.
// Same reason main.js defers its splash damage out of the enemy loop.
const pendingImpacts = [];

function resolve(a, b, hit, hooks) {
  const p = CONFIG.physics ?? {};
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const approach = rvx * hit.nx + rvy * hit.ny;

  const inv = a.invMass + b.invMass;
  if (inv <= 0) return;

  // Separate first, so a resting contact doesn't sink further every frame
  // while the impulse below refuses to act on it.
  const correction = (hit.depth * (p.positionCorrection ?? 0.7)) / inv;
  a.x -= hit.nx * correction * a.invMass;
  a.y -= hit.ny * correction * a.invMass;
  b.x += hit.nx * correction * b.invMass;
  b.y += hit.ny * correction * b.invMass;

  if (approach >= 0) return; // already flying apart — nothing to bounce off

  const e = Math.max(a.restitution ?? p.restitution ?? 0.4, b.restitution ?? p.restitution ?? 0.4);
  const j = (-(1 + e) * approach) / inv;

  a.vx -= hit.nx * j * a.invMass;
  a.vy -= hit.ny * j * a.invMass;
  b.vx += hit.nx * j * b.invMass;
  b.vy += hit.ny * j * b.invMass;

  // The same lever arm applyImpulse uses, so a turtle caught under the bow
  // rolls a hull the way a shot to the bow does.
  spinFromContact(a, -hit.nx * j, -hit.ny * j, hit.px, hit.py);
  spinFromContact(b, hit.nx * j, hit.ny * j, hit.px, hit.py);

  a.disturbed = p.disturbedFor ?? 1.5;
  b.disturbed = p.disturbedFor ?? 1.5;

  // TWO numbers, because the game layer wants different things from them.
  // `speed` is how fast they closed — mass-free, so a threshold written in it
  // means the same thing for every pair. `impulse` is what was actually
  // exchanged, which is the one that knows a boulder of a turtle hits harder
  // than a runt at the same speed. Damage is priced off the impulse; whether
  // it counts as a hit at all is decided by the speed.
  const speed = j * inv;
  a.lastImpulse = Math.max(a.lastImpulse, j);
  b.lastImpulse = Math.max(b.lastImpulse, j);
  if (speed >= (p.minImpactSpeed ?? 1.5) && hooks.onImpact) {
    pendingImpacts.push({ a, b, speed, impulse: j, x: hit.px, y: hit.py });
  }
}

function spinFromContact(body, ix, iy, atX, atY) {
  if (body.invMass === 0 || body.spin === 0) return;
  const arm = Math.max(body.shape === 'box' ? body.halfLength : body.radius, 1e-3);
  const rx = atX - (body.x + body.offsetX);
  const ry = atY - (body.y + body.offsetY);
  body.angVel += ((rx * iy - ry * ix) / arm) * body.spin * body.invMass;
}

/**
 * One physics frame: integrate every body, resolve what overlaps, then write
 * the result onto the meshes. Called once from the game loop AFTER the owners
 * have moved themselves — the body is the shove laid over their own motion,
 * so it has to go last or it would be integrating a stale position.
 *
 * hooks: { onImpact({ a, b, speed, impulse, x, y }) } — reported after the
 * pass, so a hook may sink what it was told about. See pendingImpacts.
 */
export function stepBodies(dt, hooks = {}) {
  for (const body of bodies) {
    body.lastImpulse = 0;
    body.integrate(dt);
  }

  // `enabled` turns off the part that is a physics ENGINE — bodies meeting
  // each other. It deliberately does not turn off the integration above or the
  // write-back below: a hull's position IS its body now, so a switch that
  // skipped those would not disable the physics, it would park every boat in
  // the game mid-ocean and leave the player wondering what broke.
  if (CONFIG.physics?.enabled !== false) {
    // Every pair, brute force. There are at most three turtles and three boats
    // alive at once (maxConcurrent / maxAlive), so a broad phase would cost
    // more to maintain than the fifteen comparisons it saves.
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (!canCollide(a, b)) continue;
        const hit = contact(a, b);
        if (hit) resolve(a, b, hit, hooks);
      }
    }
  }

  for (const body of bodies) {
    if (body.walls) body.hitWalls();
    body.writeBack();
  }

  // Now that nothing is iterating `bodies`, tell the game what hit what. A
  // hook here may sink a hull, blast every body near it, and remove both from
  // the world — all of which is safe from out here and none of which is safe
  // from inside the pass above.
  for (const hit of pendingImpacts) hooks.onImpact(hit);
  pendingImpacts.length = 0;
}

/**
 * An explosion, as far as the bodies are concerned. This is the chain: a hull
 * the seal blew up throws the turtle that was floating past it, and any hull
 * the blast reaches — which is the same call the debris and the crew already
 * take, so the whole wreck leaves on one impulse.
 */
export function blastBodies(x, y, radius, strength, exclude = null) {
  if (CONFIG.physics?.enabled === false) return;
  const mul = CONFIG.physics?.blastMul ?? 1;
  for (const body of bodies) {
    if (body === exclude || body.invMass === 0) continue;
    const dx = (body.x + body.offsetX) - x;
    const dy = (body.y + body.offsetY) - y;
    const d = Math.hypot(dx, dy);
    if (d > radius) continue;
    // Linear falloff from the centre, and scaled by mass so the impulse is a
    // consistent SPEED at the epicentre no matter what it caught.
    const falloff = 1 - d / Math.max(radius, 1e-3);
    const speed = strength * falloff * mul;
    const nx = d > 1e-3 ? dx / d : 0;
    const ny = d > 1e-3 ? dy / d : 1;
    body.applyImpulse(nx * speed * body.mass, ny * speed * body.mass, x, y);
  }
}
