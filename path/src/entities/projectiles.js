import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { createAnimationController } from '../systems/animation.js';
import { updateTumble } from '../systems/rocks.js';
import { isMarked, markWeight, markedTargets } from '../systems/marks.js';
import { facingHotSpots, hotSpotPoint } from '../systems/bossHotSpots.js';
import { projectileLife } from '../systems/scaling.js';

// One list for both sides — `faction` decides who a bullet can hurt. Two
// optional behaviors layer on top of the base fly-in-a-straight-line bullet:
//   homing — re-aims toward the nearest live enemy, turn-rate limited. An
//            ENEMY-faction shot homes on the seal instead: see `chase`, and the
//            note on updateHoming for why that could not be left implicit.
//   bounce — reflects off the arena walls instead of flying past them,
//            consuming one of a limited number of bounces each time
//   chain  — survives hitting an enemy and ricochets on to the next one,
//            spending a bounce per body (see chainToEnemy)
export const projectiles = [];

export function spawnProjectile(scene, {
  origin, dir, faction, damage, speed, life, radius, pierce = 0, asset, source = null,
  homing = false, turnRate = 4, acquireRadius = Infinity, targetType = null, homingDelay = 0,
  // HOW MUCH A BIG TARGET COUNTS AS A NEAR ONE. 0 (every seeker that existed
  // before Sonar Teeth) is plain nearest-wins. See updateHoming for the curve
  // and CONFIG.homingShot for why the basic shot wants this and a mussel does
  // not: one pellet of a volley is cheap enough to spend on the wrong fish, a
  // whole volley of them is not.
  sizeBias = 0, sizeRefRadius = 1,
  // Who a homing shot is FOR. Null means the enemy list, which is the seal's
  // own ordnance and every homing shot that existed before the boat boss. A
  // `{ mesh }` handed in here is followed instead, and never re-acquired —
  // that is how an enemy missile chases the player rather than shopping around
  // the creature list for whichever mackerel happens to be nearest.
  chase = null,
  bounce = false, maxBounces = 0, restitution = 1,
  chain = false, chainRange = 0, chainLock = 0, chainSpeedGain = 1,
  jet = false, jetInterval = [0.2, 0.4], jetSpeed = [10, 18], jetTurn = 2.4, jetDrag = 2,
  spin = 0, scale = 1, splashDamage = 0, splashRadius = 0, orient = false, burst = null,
  // HOW FAST THE BODY WHIPS ABOUT ITS OWN LONG AXIS, in radians a second.
  //
  // Not `spin`, and the difference is the axis. `spin` turns a shot in the
  // screen plane — a starfish tumbling end over end, which throws away any
  // heading it had. This rolls the body about the direction it is TRAVELLING,
  // so a razor clam's shell still flies nose-first and pierces along its own
  // length while its faces sweep through the light. On a flat chrome body that
  // roll is the entire metallic read (see CONFIG.chromeBlade).
  //
  // It composes with `orient` rather than fighting it, which plain Euler
  // angles will not do: the default XYZ order applies the roll AFTER the
  // heading, which swings the nose out of the plane — a blade fired at 60
  // degrees comes out 0.73 units off its own heading on z. So a rolling shot
  // is switched to 'ZYX', where the roll is applied in the body's own frame
  // first and the heading then points the whole thing. `tilt` still lands on
  // x; nothing uses both.
  roll = 0,
  // WHICH BANG THIS SHOT'S SPLASH PLAYS, by feedback event name, or null for
  // the queue's default. A description, exactly like `burst` and `chill`
  // below: projectiles.js never fires it — main.js does, when it resolves the
  // splash — and this file has no idea what a feedback event is.
  //
  // It exists because every splash in the game used to borrow `bigKill`, the
  // event a CREATURE DYING fires. That is right for a pearl and wrong for a
  // mussel barrage, where eight of them go off in a second and the player is
  // told eight things died whether or not anything did.
  splashFx = null,
  // HOW FAR THE BODY IS CANTED OUT OF THE SCREEN PLANE, in radians about x,
  // set once at spawn and never touched again.
  //
  // Only a shot with a MODEL has any use for this, and only because the game
  // is a side view. The camera looks straight down -z, so a body whose long
  // axis lies in the xy plane presents the same profile for its entire flight
  // — and for a cylinder (the yacht's rolls of cash) that profile is a
  // rectangle. Spinning it does not help: it is a rectangle at every angle in
  // that plane. A cant brings the end of the body into view and is the whole
  // difference between reading as a roll and reading as a brick.
  //
  // It survives `spin`, which writes rotation.z alone, and is meaningless
  // beside `orient`, which rewrites the whole orientation every frame.
  tilt = 0,
  gravityScale = 1, chill = null, charm = null, knockback = 0,
  // WHICH FLIPPER'S ELEMENT THIS PELLET IS CARRYING, or null for every shot in
  // the game that carries none. A pure label — this file never reads it. It is
  // set in fire() from the fin the pellet left and spent in combat.js, the same
  // arrangement `chill` and `charm` above already have: the projectile is where
  // a payload rides, and the system that owns the payload is what resolves it.
  //
  // NOT the run's element, which is a property of the BUILD and is looked up
  // (activeElement) rather than carried. A pellet needs to carry this one
  // because two pellets in the same volley can disagree about it.
  finElement = null,
  // WHICH flipper it left, 'left' or 'right', or null for anything that did not
  // leave one. Carried beside the element rather than derived from it, because
  // an UNLIT fin still has a side — and the run summary's whole question is how
  // the two split, which a null on every plain pellet could not answer.
  finSide = null,
  // HOW BIG THIS SHOT'S RIBBON IS, against whatever CONFIG.trails says for its
  // asset. Purely a look — read only by systems/projectileTrails.js, which
  // multiplies the width and the rate the trail sheds particles at.
  //
  // It exists because a ribbon is the only channel some upgrades have. The
  // Hurler's clubs get bigger, faster and more numerous with its stacks and
  // every one of those is visible; the fact that they also hit harder is not,
  // and a fatter, busier wake is what says so. Defaults to 1, so every shot in
  // the game that does not ask for it is exactly as it was.
  trailScale = 1,
}) {
  const mesh = createVisual(asset ?? (faction === 'player' ? 'bullet' : 'enemyBullet'));
  mesh.position.copy(origin);
  if (scale !== 1) mesh.scale.setScalar(scale);
  // Set BEFORE any angle is written, and only on a shot that actually rolls —
  // see the `roll` note above for why the order matters and why everything
  // else keeps three's default.
  if (roll) mesh.rotation.order = 'ZYX';
  if (tilt) mesh.rotation.x = tilt;
  scene.add(mesh);

  // A projectile whose model has real animation (currently: the seagull
  // bomb's flapping wings) gets the same idle/swim/boost controller every
  // creature uses, just always driven in the 'swim' state — there's no
  // speed-tiering concept for a bullet in flight, but the controller still
  // needs a state name to know what to play.
  const hasAnimSource = mesh.userData?.clips?.length || mesh.userData?.rig;
  const anim = hasAnimSource ? createAnimationController(mesh) : null;

  projectiles.push({
    mesh,
    anim,
    dir: dir.clone().normalize(),
    faction,
    // Who fired this, for the playtest recorder — an ability key ('missile',
    // 'starfish') on player shots, the creature's type on enemy ones. Carried
    // on the projectile because the hit lands in combat.js, which by then has
    // no idea what launched it. Null on anything that didn't say.
    source,
    damage,
    speed,
    // ANDRE 3000 IS APPLIED HERE AND NOWHERE ELSE. Every caller hands in the
    // life its own weapon was tuned for; the run's multiplier is spent once, on
    // the way into the list, so a weapon added later is covered by the card
    // without anybody remembering to cover it.
    //
    // Player shots only — an enemy torpedo comes through this same function and
    // has no business inheriting the seal's upgrades.
    life: faction === 'player' ? projectileLife(life) : life,
    radius,
    pierce,
    finElement,
    finSide,
    hits: new Set(), // enemies already pierced, so each takes damage once
    homing,
    // Seconds of straight flight before the seeker engages. Lets a launch be
    // its own beat — the shell visibly leaves the flipper on the heading it
    // was thrown at, THEN turns — instead of curving onto the target from the
    // first frame and hiding the throw.
    homingDelay,
    chase,
    turnRate,
    acquireRadius,
    sizeBias,
    sizeRefRadius,
    targetType, // e.g. 'walkingCrab' — restricts homing to only that enemy type
    target: null,
    // WHICH WEAK SPOT ON THE TARGET this shot is bending toward, once the
    // target is a boss wearing one. Null for everything else in the game,
    // which steers at the middle of the body the way it always did. Held
    // across frames on purpose — see aimAt.
    aimSpot: null,
    bounce,
    bouncesLeft: maxBounces,
    restitution,
    chain,
    chainRange,
    chainLock,
    chainSpeedGain,
    hitLock: 0, // brief post-ricochet immunity so one chain isn't spent in a frame
    bounceCombo: 0, // consecutive ricochets, drives the rising pitch and spray

    // JET — self-propulsion in a direction it keeps changing its mind about.
    // The scallop's whole identity, and the exact opposite of `homing`: it
    // coasts, then claps, and the clap points it somewhere new rather than
    // somewhere chosen. Never combine the two on one projectile — a seeker
    // that also randomises its heading just looks like a broken seeker.
    jet,
    jetInterval, // [min, max] seconds between claps
    jetSpeed, // [min, max] speed a clap imparts
    jetTurn, // radians of heading change one clap may apply
    jetDrag, // per-second falloff while coasting
    // Fires on the first frame rather than after a full interval, so a
    // launched flight scatters immediately instead of travelling as one
    // clump for the first fifth of a second.
    jetTimer: 0,

    // How much of CONFIG.arena.gravity this shot feels ABOVE THE WATER, as a
    // multiplier. 1 is a stone: it falls exactly like the seal that threw it.
    // 0 opts a shot out entirely — for something that has no business falling
    // rather than for something that would merely look better not falling.
    gravityScale,

    spin, // radians/sec, purely visual
    roll, // radians/sec about its own long axis — see the argument note above
    rollAngle: 0,
    trailScale, // ribbon size multiplier — see the argument note above
    orient, // face the direction of travel each frame
    splashDamage, // AoE dealt to OTHER nearby enemies on the first hit (see main.js)
    splashRadius,
    splashFx,     // ...and which event announces it. See the argument note above.
    // Payload description for something that breaks apart where it lands —
    // the oyster's pearl. Read by main.js's impact handler, which hands it to
    // systems/oyster.js; projectiles.js itself never acts on it, because a
    // bullet has no business knowing what a bomblet is.
    burst,
    // Ice this shot puts on what it hits: { slow, duration, freezeFor }, or
    // null for the overwhelming majority that carry none. Applied in
    // combat.js through systems/elements.js, which owns what chill IS — this
    // is a payload description, exactly like `burst` above, and projectiles.js
    // never acts on it either.
    chill,
    // The harp's note: { duration, auraDuration, auraRadius, auraDamage }, or
    // null for everything else. Third payload of the same kind and the third
    // time this sentence is written, which is the point — a shot describes what
    // it is carrying and the system that owns the effect is the only thing that
    // knows what the description MEANS. Applied in combat.js through
    // systems/harp.js.
    charm,
    // How hard this shot shoves what it hits, in applyKnockback's charge units
    // — 0 for the overwhelming majority, which shove nothing. Fourth payload of
    // exactly the same kind as the three above: combat.js hands it to
    // entities/enemies.js along the shot's own heading, and projectiles.js
    // never acts on it either.
    knockback,
  });
}

// One clap of the bubble jet: pick a new heading within `jetTurn` of the
// current one and shove off along it. Between claps the shell only coasts,
// which is what gives it the stop-start rhythm a straight-line bullet with
// randomised velocity would not have.
function updateJet(p, dt) {
  p.jetTimer -= dt;
  // Exponential falloff rather than linear: a linear drag large enough to
  // settle the shell between claps would stop it dead the instant a clap
  // ended, and the coast is half the movement.
  p.speed *= Math.exp(-p.jetDrag * dt);

  if (p.jetTimer > 0) return false;

  const [tMin, tMax] = p.jetInterval;
  p.jetTimer = tMin + Math.random() * Math.max(0, tMax - tMin);

  const turn = (Math.random() * 2 - 1) * p.jetTurn;
  const angle = Math.atan2(p.dir.y, p.dir.x) + turn;
  p.dir.set(Math.cos(angle), Math.sin(angle), 0);

  const [sMin, sMax] = p.jetSpeed;
  p.speed = sMin + Math.random() * Math.max(0, sMax - sMin);
  return true;
}

// HOW MUCH NEARER A BODY OF THIS SIZE READS, as a divisor on its distance.
//
// (radius / ref) ^ sizeBias. At sizeBias 0 that is 1 for everything — every
// seeker in the game before Sonar Teeth, unchanged — and at 1 it is the plain
// size ratio, so twice the body is half the distance. The exponent is what
// makes the middle useful: it compounds gently, so the bias never turns into
// "always pick the biggest thing on screen regardless of range", which is a
// seeker that ignores the fight the player is actually in.
//
// A target with no radius (a boat hull reached through the mark list) reads as
// ordinary rather than as zero-sized — dividing by a ratio of 0 would put it
// infinitely far away and quietly make marked hulls unhittable.
function sizePull(p, radius) {
  if (!p.sizeBias) return 1;
  const ref = p.sizeRefRadius > 0 ? p.sizeRefRadius : 1;
  if (!(radius > 0)) return 1;
  return Math.pow(radius / ref, p.sizeBias);
}

// ---------------------------------------------------------------------------
// WHAT A SEEKER WILL NOT CHASE
//
// The rule, in full: NEVER A TURTLE AND NEVER A WHALE. It is a rule rather
// than a weight because there is no distance at which either becomes the right
// answer — see CONFIG.homing.ignoreTypes for why each is on the list, and note
// that the turtle is also the boss's `turtles` screen, which is a wall made of
// exactly this creature. A seeker that treats a wall as a target empties every
// volley into it for as long as the screen is up.
//
// The set is rebuilt only when the config array itself is replaced, so the
// tuner can edit the list live without this costing an allocation a frame.
// ---------------------------------------------------------------------------
let _ignoreSrc = null;
let _ignore = new Set();
function ignoredType(type) {
  const list = CONFIG.homing?.ignoreTypes;
  if (list !== _ignoreSrc) {
    _ignoreSrc = list;
    _ignore = new Set(list ?? []);
  }
  return _ignore.has(type);
}

// Is this body worth a guided shot at all?
//
// `invincible` is the same rule generalised — a shot that cannot hurt what it
// hits has no business steering at it — and is checked on the live flag AND on
// the def, matching systems/whale.js, because the flag is installed at spawn
// and the def is the truth about the species.
function seekable(e) {
  const c = CONFIG.homing ?? {};
  if (c.ignoreInvincible !== false && (e.invincible || e.def?.invincible)) return false;
  return !ignoredType(e.type);
}

function updateHoming(p, dt, enemiesList) {
  // A SHOT WITH SOMETHING TO CHASE NEVER SHOPS AROUND. The re-acquire below
  // walks the enemy list, which for an enemy-faction missile is a list of its
  // own side — an unguided version of this perk spent its first flight
  // circling the nearest mackerel, and it read as a bug in the boss rather
  // than as a missile.
  //
  // Held even when the target is dead: the seal dying mid-flight ends the run,
  // and a missile that switched to hunting fish on that frame would be the
  // last thing on screen doing something inexplicable.
  if (p.chase) {
    if (!p.chase.mesh?.parent) return;
    p.target = p.chase;
    steerToward(p, dt);
    return;
  }
  // A target the seal has PAINTED (systems/marks.js) counts as closer than it
  // is, so a shell picks the marked shark over the minnow beside it. This is
  // the payoff for a strike that couldn't hurt what it rammed: the seal spots,
  // the ordnance follows. `markWeight` returns 1 for everything unmarked, so
  // an un-upgraded run behaves exactly as it always did.
  if (!p.target || p.target.hp <= 0 || !p.target.mesh?.parent) {
    // A PAINTED TARGET IS ITS OWN TIER, not a lean. `markFirst` is the whole
    // difference: `homingPull` counts a marked body as a FRACTION of its
    // distance, which a close fish or a big shark still beats — so the reticle
    // the player deliberately put on something could be, and often was,
    // ignored by the ordnance it was drawn for. Now anything marked outranks
    // everything unmarked and the pull only orders the marked ones among
    // themselves.
    //
    // The REACH is untouched by this: `acquireRadius` still gates every
    // candidate, so a mark decides which target in reach and never how far a
    // shot can see.
    const tiered = CONFIG.homing?.markFirst !== false;
    let best = null;
    let bestD = Infinity;
    let bestMarked = false;
    for (const e of enemiesList) {
      if (p.targetType && e.type !== p.targetType) continue;
      if (!seekable(e)) continue;
      const marked = tiered && isMarked(e);
      // Already holding a painted one — an unpainted body cannot beat it at
      // any distance, so it is not even measured.
      if (bestMarked && !marked) continue;
      const dx = e.mesh.position.x - p.mesh.position.x;
      const dy = e.mesh.position.y - p.mesh.position.y;
      const d = Math.hypot(dx, dy) * markWeight(e) / sizePull(p, e.radius);
      if (d >= p.acquireRadius) continue;
      if (marked && !bestMarked) { bestD = d; best = e; bestMarked = true; continue; }
      if (d < bestD) { bestD = d; best = e; }
    }
    // Hulls are not in the enemy list and are not normally something a homing
    // shell goes looking for. A MARKED one is: the seal swam up and headbutted
    // it, which is as clear an instruction as this game has. Only marked ones,
    // so nothing changes about how mussels behave around ordinary boats.
    if (!p.targetType) {
      for (const t of markedTargets()) {
        if (!t.mesh?.parent || (t.hp != null && t.hp <= 0)) continue;
        // Everything in this list is painted by definition, so it enters the
        // top tier — but the rule about what a seeker refuses to chase still
        // applies. A turtle cannot be marked today (a strike scopes itself by
        // size, systems/strike.js) and the rule does not depend on that.
        if (!seekable(t)) continue;
        const dx = t.mesh.position.x - p.mesh.position.x;
        const dy = t.mesh.position.y - p.mesh.position.y;
        const d = Math.hypot(dx, dy) * markWeight(t);
        if (d >= p.acquireRadius) continue;
        if (tiered && !bestMarked) { bestD = d; best = t; bestMarked = true; continue; }
        if (d < bestD) { bestD = d; best = t; }
      }
    }
    // A new body means the old weak spot is somebody else's. Cleared here
    // rather than trusted to aimAt's identity check, so nothing downstream can
    // ever read a spot belonging to a target this shot is no longer chasing.
    if (best !== p.target) p.aimSpot = null;
    p.target = best;
  }
  if (!p.target) return;
  steerToward(p, dt);
}

// Reused across every guided shot in the air, one after another, and never
// held past the call that filled it.
const _aim = { x: 0, y: 0, r: 0 };
const _spots = [];

// CAN THIS SHOT STILL BEND ONTO THAT POINT?
//
// A shot that turns at a fixed rate while flying at a fixed speed carves a
// circle of radius speed/turnRate, and there are two of them — one for each
// way it could turn. Anything INSIDE one of those circles is behind the shot's
// own turn: no sequence of hard turns reaches it without first flying away
// from it and coming back, which for a shot with a few seconds of life means
// not reaching it at all.
//
// That is the exact test, and having it is what makes aiming at a weak spot
// safe: a spot the shot cannot make is refused and the shot aims at the body
// instead, which is what every seeker did before weak spots existed. Without
// it, a pellet that committed to an unreachable spot would spiral past a boss
// it would otherwise have hit — trading a certain body hit for a crit it was
// never geometrically able to land.
//
// `clearance` widens both circles, because a spot reachable only by a perfect
// arc is a spot the animal moves out from under while the shot is arcing.
function reachable(p, x, y, clearance) {
  if (!(p.turnRate > 0)) return false;
  const r = p.speed / p.turnRate;
  if (!(r > 0)) return true; // a shot that turns on the spot can reach anything
  const px = p.mesh.position.x;
  const py = p.mesh.position.y;
  const lim = r * (1 + clearance);
  // The two turn circles are one radius off each beam, i.e. along ±perp(dir).
  const ax = px - p.dir.y * r;
  const ay = py + p.dir.x * r;
  if (Math.hypot(x - ax, y - ay) < lim) return false;
  const bx = px + p.dir.y * r;
  const by = py - p.dir.x * r;
  return Math.hypot(x - bx, y - by) >= lim;
}

// WHERE ON THE TARGET THIS SHOT IS STEERING — the middle of the body, or a
// weak spot if the target is a boss wearing one the shot can see and make.
//
// The middle of the body is where every seeker in this game has always aimed,
// and on ordinary creatures it is right: they are round and small enough that
// the centre and the animal are the same place. On a boss it is a point buried
// several metres inside a thirteen-metre shark, which meant the crit the weak
// spots exist for was available only to a player aiming by hand — a guided
// shot could land on one, but only by accident.
//
// THE CHOICE IS HELD ACROSS FRAMES. Two spots at nearly equal range swap the
// nearest-wins answer every few frames, and a shot re-picking each time weaves
// between them and arrives at neither. So the held spot wins its own re-pick
// whenever it is still an answer at all, and only a spot going dark, turning
// away with the animal, or passing out of the shot's turn drops it.
function aimAt(p) {
  const pos = p.target.mesh.position;
  const c = CONFIG.homing?.hotSpots ?? {};
  if (c.enabled === false || !p.target.isBoss) {
    p.aimSpot = null;
    _aim.x = pos.x;
    _aim.y = pos.y;
    return _aim;
  }
  const clearance = c.clearance ?? 0.25;
  const px = p.mesh.position.x;
  const py = p.mesh.position.y;
  const spots = facingHotSpots(p.target, px, py, c.facing ?? 0.15, _spots);
  let best = null;
  let bestD = Infinity;
  for (const s of spots) {
    hotSpotPoint(s, _aim);
    if (!reachable(p, _aim.x, _aim.y, clearance)) continue;
    // The one it is already on, still good — keep it and stop looking.
    if (s === p.aimSpot) { best = s; break; }
    const d = Math.hypot(_aim.x - px, _aim.y - py);
    if (d < bestD) { bestD = d; best = s; }
  }
  p.aimSpot = best;
  if (best) return hotSpotPoint(best, _aim);
  _aim.x = pos.x;
  _aim.y = pos.y;
  return _aim;
}

// Turn toward `p.target`, no faster than the shot's own turn rate. Split out so
// the chase path above and the acquire path below cannot drift apart — the turn
// limit IS the counterplay for a homing shot (out-turn it and it overshoots),
// and two copies of it is two places for that to stop being true.
function steerToward(p, dt) {
  const aim = aimAt(p);
  const dx = aim.x - p.mesh.position.x;
  const dy = aim.y - p.mesh.position.y;
  const desired = Math.atan2(dy, dx);
  const current = Math.atan2(p.dir.y, p.dir.x);
  let diff = desired - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = p.turnRate * dt;
  const step = Math.max(-maxTurn, Math.min(maxTurn, diff));
  const angle = current + step;
  p.dir.set(Math.cos(angle), Math.sin(angle));
}

// Returns true if the projectile hit a wall and had no bounces left (caller
// should despawn it) — otherwise reflects it in place and consumes a bounce.
function updateBounce(p, onBounce) {
  const pos = p.mesh.position;
  const r = p.radius;
  let hit = false;

  if (pos.x < bounds.left + r) { pos.x = bounds.left + r; if (p.dir.x < 0) { p.dir.x = -p.dir.x; hit = true; } }
  else if (pos.x > bounds.right - r) { pos.x = bounds.right - r; if (p.dir.x > 0) { p.dir.x = -p.dir.x; hit = true; } }

  if (pos.y < bounds.bottom + r) { pos.y = bounds.bottom + r; if (p.dir.y < 0) { p.dir.y = -p.dir.y; hit = true; } }
  else if (pos.y > bounds.top - r) { pos.y = bounds.top - r; if (p.dir.y > 0) { p.dir.y = -p.dir.y; hit = true; } }

  if (!hit) return false;
  if (p.bouncesLeft <= 0) return true; // out of bounces — caller despawns

  p.bouncesLeft -= 1;
  p.bounceCombo += 1;
  p.speed *= p.restitution;
  // Coming off a wall is a fresh run at the crowd — a chaining shot gets to
  // hit the same bodies again on the way back in.
  if (p.chain) p.hits.clear();
  onBounce?.(pos.x, pos.y, p);
  return false;
}

// Redirects a chaining shot at its next victim. Prefers the nearest live enemy
// inside chainRange that this shot hasn't already hit; if everything in range
// is already on its list, the list is wiped so a pair of enemies can volley the
// shot back and forth rather than the combo dead-ending at two. Returns false
// when there's nobody nearby at all, leaving the caller to deflect or despawn.
export function chainToEnemy(p, enemiesList, exclude = null) {
  const pos = p.mesh.position;
  const rangeSq = p.chainRange * p.chainRange;
  let fresh = null;
  let freshD = Infinity;
  let repeat = null;
  let repeatD = Infinity;

  for (const e of enemiesList) {
    if (e === exclude || e.hp <= 0) continue;
    const dx = e.mesh.position.x - pos.x;
    const dy = e.mesh.position.y - pos.y;
    const d = dx * dx + dy * dy;
    if (d > rangeSq) continue;
    if (p.hits.has(e)) {
      if (d < repeatD) { repeatD = d; repeat = e; }
    } else if (d < freshD) {
      freshD = d; fresh = e;
    }
  }

  const target = fresh ?? repeat;
  if (!target) return false;
  if (!fresh) p.hits.clear(); // everyone nearby has been hit — open them back up

  const dx = target.mesh.position.x - pos.x;
  const dy = target.mesh.position.y - pos.y;
  const len = Math.hypot(dx, dy) || 1;
  p.dir.set(dx / len, dy / len);
  return true;
}

// No chain target in range: kick the shot back the way it came with a bit of
// scatter, so it keeps living off the walls instead of stopping dead in the
// middle of the arena.
export function deflectProjectile(p) {
  const angle = Math.atan2(p.dir.y, p.dir.x) + Math.PI + (Math.random() - 0.5) * 1.2;
  p.dir.set(Math.cos(angle), Math.sin(angle));
}

export function updateProjectiles(dt, scene, enemiesList = [], onBounce = null, onJet = null, onExpire = null) {
  const m = 3;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];

    if (p.homingDelay > 0) p.homingDelay -= dt;
    if (p.homing && p.homingDelay <= 0) updateHoming(p, dt, enemiesList);
    if (p.jet && updateJet(p, dt)) onJet?.(p);

    // GRAVITY, and only above the water. Below the line the sea carries a
    // shell — which is why a bullet crosses the arena flat and always has —
    // and the instant it breaks the surface there is nothing holding it up any
    // more, so it falls on exactly the curve the seal that fired it falls on.
    //
    // `dir` and `speed` ARE this thing's velocity, kept split because every
    // other behaviour in here writes one or the other: homing rewrites the
    // heading, a bounce reflects it, a clap sets the speed. So gravity has to
    // go out to a velocity and come back as a pair. That round trip is also
    // what puts the arc into `orient` for free — a falling shell noses over
    // and follows its curve down instead of sliding sideways along it.
    //
    // Exempt: anything under power. A missile with its motor lit and a scallop
    // clapping its way across the sky are not in free fall, and it could not
    // work anyway — updateHoming above rewrites `dir` from the target angle
    // every frame, so a fall folded into it would be gone by the next one.
    const powered = p.homing || p.jet;
    if (!powered && p.gravityScale > 0 && p.mesh.position.y > bounds.surfaceY) {
      const g = CONFIG.arena.gravity * (CONFIG.arena.projectileGravity ?? 1) * p.gravityScale;
      const vx = p.dir.x * p.speed;
      const vy = p.dir.y * p.speed - g * dt;
      const sp = Math.hypot(vx, vy);
      // A shot thrown straight up passes through a frame where its velocity
      // cancels to nothing; it keeps its last heading rather than dividing by
      // zero, and the next frame's gravity points it down.
      if (sp > 1e-4) {
        p.dir.x = vx / sp;
        p.dir.y = vy / sp;
        p.speed = sp;
      }
    }

    p.mesh.position.x += p.dir.x * p.speed * dt;
    p.mesh.position.y += p.dir.y * p.speed * dt;

    // Point along the direction of travel. Matters most for homing missiles
    // and the seagull, which curve constantly — without this they slide
    // sideways through their own arc. Skipped for spinners (starfish), whose
    // whole look is tumbling rather than pointing.
    if (p.orient && !p.spin) {
      // Art forward is +Y, hence the quarter turn.
      p.mesh.rotation.z = Math.atan2(p.dir.y, p.dir.x) - Math.PI / 2;
      // Mirror instead of rolling belly-up when travelling leftward.
      //
      // `orient: 'axis'` OPTS OUT, for a body that has no belly to protect —
      // the razor clam's blade, which is symmetric end to end and face to face.
      // It is not merely unnecessary there, it is wrong: the mirror is a Ry(PI)
      // composed AFTER the heading (three's XYZ order applies z first), which
      // lands on the intended pose only when the heading is on an axis. At a
      // leftward DIAGONAL it is 90 degrees out — measured at 135 and 225
      // degrees — and a blade fired up-left flies broadside.
      //
      // Every other projectile keeps the old behaviour deliberately. It has the
      // same 90-degree error at those two headings, and a mussel or a gull is
      // round enough that nobody has ever seen it; changing the shared branch
      // would silently re-pose every weapon in the game, which is not something
      // to do from inside a new card.
      const mirror = p.orient !== 'axis' && p.dir.x < 0 ? Math.PI : 0;
      // ...AND THE ROLL, on the same axis the mirror uses, because on a body
      // already pointed down its heading that axis IS the long one. Added to
      // the mirror rather than replacing it so a shot could have both; the
      // rotation order set at spawn is what keeps this from dragging the nose
      // off the heading.
      if (p.roll) {
        p.rollAngle += p.roll * dt;
        p.mesh.rotation.y = mirror + p.rollAngle;
      } else {
        p.mesh.rotation.y = mirror;
      }
    }
    if (p.spin) p.mesh.rotation.z += p.spin * dt;
    // Rock ammo tumbles about its own arbitrary axis. Only when nothing else
    // is driving the orientation: `orient` and `spin` both write Euler angles
    // straight onto the mesh each frame, which would wipe out the quaternion
    // this composes onto.
    else if (!p.orient) updateTumble(p.mesh, dt);
    if (p.anim) p.anim.update(dt, 'swim', false);
    if (p.hitLock > 0) p.hitLock -= dt;
    p.life -= dt;

    if (p.bounce) {
      const exhausted = updateBounce(p, onBounce);
      if (exhausted) { despawn(scene, i); continue; }
    }

    const pos = p.mesh.position;
    const outside =
      pos.x < bounds.left - m || pos.x > bounds.right + m ||
      pos.y < bounds.bottom - m || pos.y > bounds.top + m;

    // A projectile that RAN OUT is a different event from one that left the
    // arena, and only the first gets `onExpire`. A pearl that sails off the
    // side of the world must not crack open out there: the bomblets would deal
    // damage the player can neither see nor have aimed.
    if (p.life <= 0 && !outside) onExpire?.(p);
    if (p.life <= 0 || outside) despawn(scene, i);
  }
}

export function despawn(scene, index) {
  const p = projectiles[index];
  if (!p) return;
  scene.remove(p.mesh);
  projectiles.splice(index, 1);
}

export function resetProjectiles(scene) {
  for (const p of projectiles) scene.remove(p.mesh);
  projectiles.length = 0;
}
