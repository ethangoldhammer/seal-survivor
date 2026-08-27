import { CONFIG } from '../config.js';

// ---------------------------------------------------------------------------
// BAIT BALLS — a swirling ball of small fish, and the thing everything in the
// water wants at once
// ---------------------------------------------------------------------------
// A real bait ball is what a shoal does when it is being hunted: it packs into
// a sphere and spins, so that no fish is on the outside for long. It is not a
// formation the fish choose to be safe in — it is the shape of being surrounded,
// and every predator in the ocean turns up for it.
//
// IT ROTATES AROUND A VERTICAL AXIS, and that is a fact about the geometry
// rather than a detail of the look. Every fish orbits a standing column in the
// x/z plane and rides up and down it as it goes, so the mass churns: the fish
// that was on the outside a second ago is now at the back, which is the whole
// reason the formation works.
//
// WHY THAT IS AWKWARD HERE, and what is done about it. The camera is
// ORTHOGRAPHIC (world.js: an OrthographicCamera at z = 40 looking down -z), so
// moving a fish through z changes nothing on screen except which body sorts in
// front of which. A column built honestly in three dimensions and left at that
// renders as a row of fish sliding left and right, which is not a bait ball —
// it is a mistake that looks like one. So the depth is drawn rather than
// projected: `depthCue` scales each fish by how far toward the camera it
// currently is, and the near half of the orbit is simply bigger. That, the
// draw order, and the facing flip that comes free from moving -x on the way
// round are the three cues doing all the work.
//
// THE FISH ARE ON SLOTS, not on boids. Cohesion, alignment and separation
// cannot produce a rotating torus — they produce a blob that mills — and the
// ROTATION is the thing being asked for. So each fish owns a slot on the
// column (an angle, a height, a radius) and swims at it; the slot is what
// turns. Everything that makes it feel alive is still steering: a fish chases
// its slot rather than being pinned to it, and the flee and strike-panic terms
// still overwhelm that chase, scatter the ball, and let it re-form.
//
// That is the whole design here. The ball is a POCKET OF CHUM sitting in open
// water with a clock on it, and it is not yours. The sharks and the boss will
// swim over and eat it, and every mouthful they take heals them (see
// baitMealHeal and systems/predation.js). So the ball is a tug of war: whoever
// gets through more of it wins the exchange, and the player's half of that is
// chum, which is the currency their damage scales off.
//
// WHY IT MOSTLY HAPPENS DURING A BOSS FIGHT, and why that is one rule rather
// than two. A ball only forms in water that is NOT VERY FULL (`emptyFrac`) —
// there is nothing to look at in a swirling knot of fish if the arena already
// holds two hundred of them, and nothing to decide either. A boss fight is the
// one stretch of a run where the water is deliberately held near-empty (see
// clearForBoss and CONFIG.boss.clearOut), so the occupancy test lands there
// almost every time on its own. `bossInterval` then makes it arrive more often
// during a fight, on top of that — but the reason it belongs in a fight is the
// emptiness, not a special case for bosses.
//
// WHAT THIS MODULE OWNS. The clock, the eligibility test, and the anchor each
// ball swims around. It never touches the scene, THREE, the arena or the
// enemy list: creatures arrive as plain { x, y } and the caller does the
// spawning. That is what makes tools/bait-ball-test.mjs able to run a whole
// ten-minute run through it in a few milliseconds, which is the only practical
// way to answer "can two of these overlap" or "does one ever form at level 3".
//
// The fish themselves are ORDINARY SMALL FRY — whatever enemies.csv is
// currently offering as prey. Nothing about a bait ball is a species; it is a
// state a school is in, which is why a new little fish added to the table
// joins the ball for free.
// ---------------------------------------------------------------------------

// Live balls, keyed by the schoolId their fish carry. Exported for the harness
// and the debug overlay; nothing outside this module may write it.
export const baitBalls = new Map();

const state = {
  // Seconds until the next ball may form. Held at `firstDelay` whenever the
  // conditions are not met, so the first ball after the water opens up arrives
  // on a full delay rather than the instant the arena thins out — otherwise a
  // boss's clear-out would be followed immediately by a ball, every time.
  timer: 0,
};

/** Start of a run. */
export function resetBaitBalls() {
  baitBalls.clear();
  state.timer = CONFIG.baitBall?.firstDelay ?? 10;
}

function cfg() {
  return CONFIG.baitBall ?? {};
}

/**
 * One tick of the clock that decides whether a ball forms.
 *
 * Returns a SPEC — how many fish, where the ball stations itself, which wall
 * they swim in from — or null. Deliberately does not spawn anything: the
 * caller owns the enemy list and the scene, and keeping this function pure is
 * what makes the pacing testable.
 *
 * @param ctx {
 *   level:        the player's level. The whole feature is gated on it.
 *   difficulty:   the run clock, for the caller's own spawn call.
 *   boss:         the live boss creature as { x, y }, or null.
 *   aliveNonBoss: how many creatures are in the water, bosses excluded.
 *   maxAlive:     CONFIG.spawn.maxAlive, passed rather than read so a harness
 *                 can shrink the arena without editing config.
 *   bounds:       the arena, as { left, right, bottom, surfaceY }.
 *   offscreenX:   world X of the entrance, just past the wall.
 *   player:       { x, y }, so a ball never forms in the seal's lap.
 *   hold:         true to veto and reset the clock — see the note below.
 *   rand:         injected so the harness can seed it.
 * }
 */
export function updateBaitBallClock(dt, ctx) {
  const c = cfg();
  const rand = ctx.rand ?? Math.random;
  if (c.enabled === false) return null;

  // A CALLER-SIDE VETO, and it resets the clock rather than merely pausing it.
  // Used for a boss's entrance: the arrival is a promise that nothing else is
  // happening, and a ball swimming in under it reads as the water not having
  // been cleared at all, which is the one beat that whole sequence sells.
  //
  // It has to be a gate IN HERE rather than an early return at the call site.
  // A boss mid-entrance is passed as `boss: null` (its position is not where it
  // will fight from), so the clock would see calm water, fire on the ambient
  // interval, and the caller would throw the spec away — spending the wait and
  // showing nothing. That is a ball the player never gets, once per fight,
  // and there is nothing anywhere to say so.
  if (ctx.hold) { state.timer = c.firstDelay ?? 10; return null; }

  // THE LEVEL GATE, and it is the first thing checked because it is the only
  // one that is about the player rather than about the water. A ball is a
  // decision — leave the fight, go and eat, come back — and a level 1 seal has
  // no fight to leave and nothing to spend the chum on.
  if ((ctx.level ?? 1) < (c.minLevel ?? 4)) { state.timer = c.firstDelay ?? 10; return null; }

  // Only so many at a time. One is the default and the number this is designed
  // around: a ball is a landmark you swim to, and two of them is a choice
  // between two identical things, which is not a choice.
  if (baitBalls.size >= (c.maxBalls ?? 1)) { state.timer = Math.max(state.timer, 0); return null; }

  // HOW FULL IS THE WATER. The test that makes this a boss-fight feature
  // without ever naming a boss — see the header.
  //
  // AN ABSOLUTE HEADCOUNT, not a fraction of CONFIG.spawn.maxAlive. It was a
  // fraction and that was wrong twice over: maxAlive is a MEMORY bound (220)
  // rather than a design one, so a share of it is a share of the wrong number,
  // and the fraction that actually works comes out at 0.09 — which reads as a
  // rounding error rather than as "about twenty creatures", the thing it
  // means. Twenty is a picture; 9% of a memory bound is not.
  //
  // WHY IT IS THIS LOW. Twenty is chosen to sit in the gap between the two
  // states it is sorting: a boss fight holds nine
  // (CONFIG.boss.clearOut.foodMaxAlive) and an ordinary arena is past fifty by
  // the mid-game and pinned at maxAlive by the late one. Anything up near the
  // ordinary figure and a ball forms through the whole run — which is a
  // BALANCE change and not only a pacing one, because a ball's fish arrive
  // outside the spawner's per-tick budget and hold slots the ordinary mix
  // would have filled. tools/enemy-ramp-test.mjs is what measures that.
  if ((ctx.aliveNonBoss ?? 0) > (c.maxWater ?? 20)) { state.timer = c.firstDelay ?? 10; return null; }

  state.timer -= dt;
  if (state.timer > 0) return null;
  state.timer = Math.max(1, ctx.boss ? (c.bossInterval ?? 14) : (c.interval ?? 26));

  const b = ctx.bounds;
  const margin = c.margin ?? 6;

  // WHICH SIDE IT COMES IN FROM. With a boss in the water, the opposite wall —
  // the same rule the forage uses (see forageSpawnPoint in entities/enemies.js)
  // and for the same reason: food placed at the fight is a free top-up, and
  // food placed away from it is a decision that costs you the swim out, the
  // swim back, and a boss following you the whole way.
  //
  // With no boss, away from the SEAL instead, so a ball never forms on top of
  // the player and hands them a free one.
  const mid = (b.left + b.right) * 0.5;
  const from = ctx.boss ? (ctx.boss.x ?? 0) : (ctx.player?.x ?? 0);
  const side = from >= mid ? -1 : 1;

  // Where it settles once it is on screen: comfortably inside the wall it came
  // through, at a random depth. Not the centre — a ball parked in the middle of
  // the arena is passed through rather than swum to.
  const inset = c.stationInset ?? 0.42;
  const stationX = side < 0
    ? b.left + (b.right - b.left) * inset * 0.5
    : b.right - (b.right - b.left) * inset * 0.5;
  const stationY = b.bottom + margin + rand() * Math.max(1, (b.surfaceY - b.bottom) - margin * 2);

  const min = Math.max(1, Math.round(c.size?.min ?? 10));
  const max = Math.max(min, Math.round(c.size?.max ?? 18));

  return {
    count: min + Math.floor(rand() * (max - min + 1)),
    // The fish are placed around this, outside the picture, and the anchor
    // swims them in — see updateBaitBalls. A ball that blinked into existence
    // mid-water would be the one spawn in the game the player is guaranteed to
    // be looking at when it happens.
    x: side * ctx.offscreenX,
    y: stationY,
    stationX,
    stationY,
    side,
    spin: rand() < 0.5 ? -1 : 1,
    shape: rollBaitShape(rand, c),
  };
}

/**
 * Which flow a new ball gets. The vortex is what a bait ball does; the
 * attractors are the experiment, and they are RARE on purpose — the value of a
 * strange one is that it is strange, and a run where every ball is a Lorenz
 * butterfly has no ordinary bait ball left to be strange against.
 */
export function rollBaitShape(rand = Math.random, c = cfg()) {
  const chance = Math.max(0, Math.min(1, c.strangeChance ?? 0));
  if (chance <= 0 || rand() >= chance) return 'vortex';
  const pool = STRANGE_SHAPES;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

export const STRANGE_SHAPES = ['thomas', 'lorenz', 'aizawa'];

/**
 * Register a ball the caller has just spawned the fish for.
 *
 * `id` is the schoolId those fish carry — a bait ball IS a school, in a
 * particular state, so it reuses the existing grouping rather than inventing a
 * second one that could drift out of step with it.
 */
export function openBaitBall(id, spec) {
  const c = cfg();
  baitBalls.set(id, {
    id,
    x: spec.x,
    y: spec.y,
    stationX: spec.stationX,
    stationY: spec.stationY,
    spin: spec.spin ?? 1,
    // WHAT FLOW THIS ONE SWIMS. Almost always the vortex; `strangeChance` of
    // the time it is one of the attractors instead. Rolled once, here, and
    // carried for the ball's life — re-rolling per frame would have the mass
    // change its mind about what shape it is, which is not chaos, it is a bug.
    shape: spec.shape ?? 'vortex',
    // Wander phase, so two balls in a row do not wallow in lockstep.
    phase: Math.random() * Math.PI * 2,
    // How long it has been turning. The column's rotation is read off THIS
    // rather than off a global clock, so every fish in one ball agrees on
    // where the formation currently points — a shared clock would have a ball
    // spawned mid-run start part-way through its own rotation, which is
    // harmless, and two balls rotate in lockstep, which is not.
    age: 0,
    // How wide the shell is right now. Squeezes toward `tighten` while a
    // predator is on it and relaxes back out — the visible half of being
    // hunted, and the thing that tells the player from across the arena that
    // something is already eating.
    shell: c.radius ?? 2.6,
    threat: 0,
    // Seconds this ball has left before the survivors give up on the formation
    // and go back to being ordinary fish. The clock is what makes it an
    // opportunity rather than a fixture: leave it alone and it is gone, and
    // whatever ate from it in the meantime kept the difference.
    life: c.life ?? 40,
    arriving: true,
    count: spec.count ?? 0,
    // THE LEDGER — who got how much of it. The whole feature is one exchange,
    // and the exchange is the thing you cannot see while it is happening: a
    // boss eating four fish while the player takes nine looks, in the moment,
    // exactly like a boss eating nine while the player takes four. Counted
    // here rather than derived at the end because the fish are gone by then.
    //
    // `opened` is the headcount it started with, so a ball that simply timed
    // out is legible as one — 12 opened, 3 eaten, 2 taken, 7 swam off — rather
    // than reading as a close-run thing.
    opened: spec.count ?? 0,
    eaten: 0,
    taken: 0,
  });
  return baitBalls.get(id);
}

/**
 * One fish off a ball, and which side of the tug of war took it.
 *
 * Called from the two places a bait fish can die — systems/predation.js for a
 * mouthful and main.js's kill funnel for the player's — rather than inferred
 * from the headcount dropping, because the headcount cannot tell you WHO. That
 * distinction is the entire mechanic: a ball emptying fast is either the player
 * winning the exchange or losing it, and those look identical from here.
 *
 * A no-op on a fish that is not in a ball, so callers need no test of their own.
 *
 * @param side 'predator' or 'player'
 */
export function noteBaitLoss(schoolId, side) {
  const ball = schoolId == null ? null : baitBalls.get(schoolId);
  if (!ball) return;
  if (side === 'player') ball.taken += 1;
  else ball.eaten += 1;
}

/** The ball a school belongs to, or null. */
export function baitBallFor(schoolId) {
  if (schoolId == null) return null;
  return baitBalls.get(schoolId) ?? null;
}

/**
 * Advance every live ball's anchor.
 *
 * @param ctx {
 *   schools:   the Map updateEnemies already builds, schoolId -> creatures.
 *   predators: everything with a `hunt` block, as { x, y }.
 *   player:    { x, y }.
 *   bounds:    the arena.
 * }
 *
 * Ends any ball whose fish are gone, whose clock has run out, or which has
 * been reduced below `disperseAt` — a knot of two fish is not a ball, and the
 * two survivors should go back to swimming at the seal like anything else.
 *
 * Ended BALLS come back, not just their ids: the caller needs the id to clear
 * the flag on the survivors, and it needs the ledger on the same object to
 * report how the exchange went. Returning ids alone meant the counters were
 * deleted on the frame they finally meant something.
 */
export function updateBaitBalls(dt, ctx) {
  const c = cfg();
  const dispersed = [];
  if (!baitBalls.size) return dispersed;

  const b = ctx.bounds;
  const margin = c.margin ?? 6;
  const relax = c.tightenRelax ?? 1.6;

  for (const ball of [...baitBalls.values()]) {
    const mates = ctx.schools?.get(ball.id);
    const alive = mates ? mates.length : 0;
    ball.count = alive;

    ball.age += dt;
    ball.life -= dt;
    if (alive <= (c.disperseAt ?? 3) || ball.life <= 0) {
      baitBalls.delete(ball.id);
      ball.timedOut = ball.life > 0 ? false : true;
      dispersed.push(ball);
      continue;
    }

    // HOW HARD IT IS BEING PRESSED, and the seal counts. A ball that only
    // flinched from sharks would sit still while the player swam into the
    // middle of it, which is the one moment the formation is supposed to be
    // doing something.
    //
    // ONE number does both jobs — the squeeze and the run — and it is a
    // WEIGHTED proximity rather than a raw distance. Weighting only the shove
    // was the obvious version and it is subtly wrong: the ball would slide away
    // from the seal more gently while panicking at it exactly as hard as at a
    // shark, so the tell that says "a predator is on this" would fire on the
    // player's own approach. `press` is 0 at the edge of `radius` and
    // `weight` at zero distance.
    let peak = 0;
    let awayX = 0;
    let awayY = 0;
    const flee = c.flee ?? {};
    const reach = flee.radius ?? 9;
    const consider = (x, y, weight) => {
      const dx = ball.x - x;
      const dy = ball.y - y;
      const d = Math.hypot(dx, dy);
      if (d > reach || d < 1e-4) return;
      const press = (1 - d / reach) * weight;
      if (press > peak) peak = press;
      awayX += (dx / d) * press;
      awayY += (dy / d) * press;
    };
    for (const p of ctx.predators ?? []) consider(p.x, p.y, 1);
    if (ctx.player) consider(ctx.player.x, ctx.player.y, flee.playerWeight ?? 0.7);

    // Smoothed rather than switched: a shell that snapped between two widths
    // reads as a rendering glitch, and the squeeze is meant to be legible from
    // the far side of the arena.
    const want = Math.min(1, peak);
    ball.threat += (want - ball.threat) * Math.min(1, dt * relax);

    // HOW WIDE THE BALL IS, and it is a function of how many fish are left in
    // it. `radius` is the width at a NOMINAL ball — the middle of the
    // `size` range — and a ball scales off that by the square root of its
    // headcount, which is what holds the packing constant: a fixed radius
    // means a ten-fish ball is a scatter and an eighteen-fish ball is a crowd,
    // off one setting, decided by a spawn roll.
    //
    // It also means A BALL VISIBLY SHRINKS AS IT IS EATEN, which is the one
    // piece of feedback this mechanic had no way of giving. The exchange is
    // otherwise invisible until the ledger prints; now the thing itself is the
    // gauge, and a knot that has gone from a crowd to a handful reads across
    // the arena.
    const tight = c.tighten ?? 0.55;
    const full = c.radius ?? 1.7;
    const nominal = Math.max(1, ((c.size?.min ?? 10) + (c.size?.max ?? 18)) * 0.5);
    const packed = full * Math.sqrt(Math.max(1, alive) / nominal);
    ball.shell = packed * (1 - ball.threat * (1 - tight));

    // --- where the anchor goes -------------------------------------------
    let vx = 0;
    let vy = 0;

    if (ball.arriving) {
      // Straight to its station, at a swim rather than a slide. `arriveSpeed`
      // is faster than the wallow below because the entrance is dead time —
      // the ball is not a decision until it is somewhere the player can reach.
      const dx = ball.stationX - ball.x;
      const dy = ball.stationY - ball.y;
      const d = Math.hypot(dx, dy);
      if (d < (c.arriveGap ?? 1.5)) ball.arriving = false;
      else {
        const s = c.arriveSpeed ?? 7;
        vx = (dx / d) * s;
        vy = (dy / d) * s;
      }
    }

    if (!ball.arriving) {
      // A wallow, not a patrol: two sines out of phase, so the ball drifts
      // around its station without ever leaving it. The station is the promise
      // — the player looked at the ball, swam for it, and it has to still be
      // roughly there when they arrive.
      const drift = c.drift ?? 1.2;
      ball.phase += dt;
      vx = Math.cos(ball.phase * 0.7) * drift;
      vy = Math.sin(ball.phase * 0.53) * drift * 0.6;
      // Leashed to the station, so a long chase does not walk the ball into a
      // corner one nudge at a time.
      const leash = c.leash ?? 9;
      const lx = ball.stationX - ball.x;
      const ly = ball.stationY - ball.y;
      const ld = Math.hypot(lx, ly);
      if (ld > leash) {
        const pull = (ld - leash) / leash;
        vx += (lx / ld) * pull * (c.leashPull ?? 6);
        vy += (ly / ld) * pull * (c.leashPull ?? 6);
      }
    }

    // AND IT RUNS. The whole ball slides away from whatever is on it, which is
    // what turns "swim to the fish" into "swim to where the fish are going" —
    // and, during a fight, into a three-way race between the seal, the boss
    // and the fish themselves.
    const runSpeed = flee.speed ?? 5;
    vx += awayX * runSpeed;
    vy += awayY * runSpeed;

    ball.x += vx * dt;
    ball.y += vy * dt;

    // Inside the water. Not a bounce — a ball pinned against the wall by a
    // shark is a fair position for the player to exploit, and one that
    // ricocheted off it would look like it had been kicked.
    ball.x = Math.min(b.right - margin, Math.max(b.left + margin, ball.x));
    ball.y = Math.min(b.surfaceY - margin * 0.5, Math.max(b.bottom + margin, ball.y));
    ball.vx = vx;
    ball.vy = vy;
  }

  return dispersed;
}

// Scratch, reused every call — baitFlock runs per fish per frame and must not
// allocate. Callers read it immediately and never hold on to it.
const flockOut = { x: 0, y: 0, z: 0, speed: 0, scale: 1, noise: 0 };

// ---------------------------------------------------------------------------
// THE NOISE FIELD — the same one twice, in two languages
// ---------------------------------------------------------------------------
// A slow-moving Perlin field. It does two jobs and they have to be the SAME
// field or the whole idea falls apart: it pushes the fish around (below), and
// systems/baitShimmer.js samples it in the fragment shader to light them. The
// shimmer then is not decoration next to the motion — it is the motion, made
// visible, and a fish brightens because of the water it is actually in.
//
// So this is a hand port of noiseFbm from systems/noiseGlsl.js, gradient for
// gradient. tools/bait-ball-test.mjs checks the two agree at sample points,
// because a port that has drifted is a shimmer that no longer lines up with
// anything and there is nothing on screen that would say so.
function hash3(x, y, z, o) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + o) * 43758.5453123;
  return -1 + 2 * (s - Math.floor(s));
}

function grad3(ix, iy, iz, fx, fy, fz) {
  const gx = hash3(ix, iy, iz, 0);
  const gy = hash3(ix, iy, iz, 1.7);
  const gz = hash3(ix, iy, iz, 3.4);
  return gx * fx + gy * fy + gz * fz;
}

function perlin3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(
      lerp(grad3(ix, iy, iz, fx, fy, fz), grad3(ix + 1, iy, iz, fx - 1, fy, fz), ux),
      lerp(grad3(ix, iy + 1, iz, fx, fy - 1, fz), grad3(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), ux), uy),
    lerp(
      lerp(grad3(ix, iy, iz + 1, fx, fy, fz - 1), grad3(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), ux),
      lerp(grad3(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), grad3(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), ux), uy),
    uz);
}

/** Three octaves, matching noiseFbm in systems/noiseGlsl.js. */
export function baitNoise(x, y, z) {
  let v = 0;
  let a = 0.5;
  let px = x;
  let py = y;
  let pz = z;
  for (let i = 0; i < 3; i++) {
    v += a * perlin3(px, py, pz);
    px *= 2.02; py *= 2.02; pz *= 2.02;
    a *= 0.5;
  }
  return v;
}

// ---------------------------------------------------------------------------
// STRANGE ATTRACTORS — the experimental balls
// ---------------------------------------------------------------------------
// A bait ball's ordinary flow is a circle about a standing axis, which is what
// the real thing does and is also, after ten seconds of watching, a circle. An
// attractor is the same idea with a system that never closes: the fish swim its
// streamlines, so the mass folds through itself, comes back near where it was
// without ever repeating, and has a SHAPE that is not a shape anybody drew.
//
// Three of them, chosen because they are bounded — an attractor whose orbit
// escapes is a school leaving the arena, and the wall would spend the whole
// ball's life fighting it:
//
//   thomas   cyclically symmetric, ±4-ish in every axis, and the roundest of
//            the three. The closest to a ball that still isn't one.
//   lorenz   the butterfly. Two lobes the flock crosses between at no fixed
//            interval, which is the one that reads as a decision being made.
//            Its own z runs 0..50 and is recentred here so the shape stands up
//            in the water rather than hovering above it.
//   aizawa   a torus with a spike through it. The strangest to look at, and
//            the one that most obviously is not wildlife.
//
// The system's own coordinates map to the WORLD with y as the attractor's
// vertical, so a butterfly stands up rather than lying on its side. Input is
// the fish's offset from the anchor in SHELL UNITS, so a ball of any size gets
// the whole shape; `attractorScale` is how much of the attractor's own space
// one shell spans.
//
// Returns a flow vector, not a position: the fish steers along the streamline
// it is standing on, exactly as it steers along the vortex's tangent. Nothing
// integrates the attractor's own state, so there is no divergence to manage and
// no per-fish history to keep.
// How wide each system's own interesting region is, relative to Thomas. Without
// this `attractorScale` means a different thing per attractor, and the one it
// means for Lorenz is a disaster: the butterfly spans about ±20, so a window of
// ±3.4 samples ONLY the middle — which is the repelling fixed point between the
// two lobes, an outward flow everywhere, and a ball that pushes itself apart
// against the wall for its whole life. Measured: a particle following the
// normalised field reached 8.8 shells from the anchor. With the span applied it
// stays inside 1.7.
const ATTRACTOR_SPAN = { thomas: 1, lorenz: 5.5, aizawa: 0.45 };

const flowOut = { x: 0, y: 0, z: 0 };

// The raw system, before de-biasing. Writes into `out` so the caller can hand
// it either the shared scratch or its own — refreshBias below needs the second,
// and an earlier version that had both share `flowOut` clobbered a call from
// inside itself.
function rawFlow(shape, ux, uy, uz, c, out) {
  const k = (c.attractorScale ?? 3.4) * (ATTRACTOR_SPAN[shape] ?? 1);
  const x = ux * k;
  const y = uz * k;          // the attractor's y is the world's DEPTH
  const z = uy * k;          // ...and its z is the world's UP
  let dx = 0;
  let dy = 0;
  let dz = 0;

  if (shape === 'lorenz') {
    // Recentred: Lorenz's z lives around 25, so the raw system would place the
    // whole shape far above the anchor.
    const zc = z + (c.lorenzLift ?? 25);
    dx = 10 * (y - x);
    dy = x * (28 - zc) - y;
    dz = x * y - (8 / 3) * zc;
  } else if (shape === 'aizawa') {
    const a = 0.95;
    const b = 0.7;
    const cc = 0.6;
    const d = 3.5;
    const e = 0.25;
    const f = 0.1;
    const zc = z + (c.aizawaLift ?? 0.8);
    dx = (zc - b) * x - d * y;
    dy = d * x + (zc - b) * y;
    dz = cc + a * zc - (zc * zc * zc) / 3 - (x * x + y * y) * (1 + e * zc) + f * zc * x * x * x;
  } else {
    // thomas, and the fallback for an unknown name — bounded whatever you hand
    // it, which is the right property for a default nobody chose.
    const b = c.thomasB ?? 0.19;
    dx = Math.sin(y) - b * x;
    dy = Math.sin(z) - b * y;
    dz = Math.sin(x) - b * z;
  }

  // Back to world axes, undoing the swap above.
  out.x = dx;
  out.y = dz;
  out.z = dy;
  return out;
}

// THE FLOW AT THE BALL'S OWN CENTRE, cached per shape — and subtracting it is
// the difference between a shape and a shape that swims away.
//
// These systems have no reason to sit still. Lorenz at the ball's centre
// evaluates to dz = -(8/3) x 25, a hard downward push applied to every fish in
// the ball at once, and Aizawa's bias is nearly as strong: measured, an Aizawa
// ball's flock sat 2.3 units BELOW its own anchor and spent its life grinding
// against the bottom of the wall. That reads as a knot of fish stuck on
// something, not as an attractor.
//
// Subtracting the centre's flow leaves the field's SHAPE — the folding, the
// lobes, the differences between one part of the ball and another — and removes
// only the part that is a constant translation. The anchor has its own motion
// (the wallow, the flee) and that is the only thing that should move a ball.
//
// Cached because it depends on nothing but the config constants, and deriving
// it per fish per frame would double the cost of the most expensive term in the
// flock.
const biasOut = { x: 0, y: 0, z: 0 };
const bias = { x: 0, y: 0, z: 0 };
let biasKey = null;
let biasScale = null;

export function attractorFlow(shape, ux, uy, uz, c = cfg()) {
  // Keyed on the scale too: `attractorScale` is a live tuning row, and a bias
  // cached against the old one is a constant push in a direction nothing is
  // pointing any more.
  if (biasKey !== shape || biasScale !== c.attractorScale) {
    // AVERAGED OVER THE BALL'S VOLUME, not read at its centre. The centre was
    // the obvious version and it did not work: measured, an Aizawa ball still
    // sat 2.9 units below its anchor, because these fields are strongly
    // curved and the mean over a region is nowhere near the value at its
    // middle. A 5x5x5 grid over the local cube is cheap — it runs once per
    // shape, not per fish — and it is the number that actually describes
    // "where is this flow taking the whole mass".
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        for (let k = 0; k < 5; k++) {
          rawFlow(shape, (i / 2) - 1, (j / 2) - 1, (k / 2) - 1, c, biasOut);
          // NORMALISED before averaging, because that is how the fish take it:
          // baitFlock uses the direction and throws the magnitude away, so an
          // average of raw vectors is dominated by whichever corner of the ball
          // happens to have the fastest flow rather than by where most of the
          // ball is being pushed.
          const l = Math.hypot(biasOut.x, biasOut.y, biasOut.z);
          if (l < 1e-6) continue;
          sx += biasOut.x / l;
          sy += biasOut.y / l;
          sz += biasOut.z / l;
          n += 1;
        }
      }
    }
    bias.x = n ? sx / n : 0;
    bias.y = n ? sy / n : 0;
    bias.z = n ? sz / n : 0;
    biasKey = shape;
    biasScale = c.attractorScale;
  }
  rawFlow(shape, ux, uy, uz, c, flowOut);
  // Normalised before the subtraction, to match the space the bias was
  // averaged in. Subtracting a unit-scale bias from a raw vector whose length
  // runs into the hundreds (Lorenz's does) would be subtracting nothing at all.
  const l = Math.hypot(flowOut.x, flowOut.y, flowOut.z);
  if (l > 1e-6) {
    flowOut.x = flowOut.x / l - bias.x;
    flowOut.y = flowOut.y / l - bias.y;
    flowOut.z = flowOut.z / l - bias.z;
  }
  return flowOut;
}

/**
 * One fish's steering inside a bait ball: BOIDS IN THREE DIMENSIONS, plus a
 * vortex about the vertical and a soft wall holding it in.
 *
 * WHY BOIDS AND NOT SLOTS. This was slots — each fish assigned a place on a
 * turning column and told to swim at it — and slots are wrong for two reasons
 * that are really one. They overlap: two slots can be a body apart in space and
 * on top of each other in the picture, and nothing in a rails system pushes
 * anybody off anybody, so the ball reads as fish colliding. And they are rigid:
 * the formation turns as a machined object, which is the opposite of the thing
 * being drawn. SEPARATION is what stops the collisions and it only exists in a
 * flock, so the flock is what the ball has to be.
 *
 * The five terms, and what each one is actually for:
 *
 *   SEPARATION   the strongest by a distance, and the whole answer to "they are
 *                colliding". In 3D — two fish at the same screen position but a
 *                unit apart in depth are NOT touching, and a 2D separation term
 *                shoves them apart anyway, which is a ball that boils.
 *   ALIGNMENT    matches a neighbour's heading. What turns individual swimmers
 *                into a sheet moving together.
 *   COHESION     toward the local centroid, and deliberately weak: the wall
 *                below is what holds the shape, and a strong cohesion fights it
 *                for the same job and wins in the middle.
 *   VORTEX       tangential about the VERTICAL axis through the anchor. The
 *                rotation, and the only term that knows the ball has an axis at
 *                all. Falls off toward the axis so a fish that has drifted into
 *                the middle spends its effort getting back out rather than
 *                spinning uselessly.
 *   WALL         a soft shell. Pulls in from outside `shell` and pushes out
 *                from well inside it, so the mass is hollow-ish and rounded
 *                rather than a solid lump with a dense core.
 *
 * All five are summed and the result NORMALISED, so what comes back is a
 * heading rather than a force — the weights decide direction only, and speed is
 * decided separately. That is what keeps a fish from being fired across the
 * arena by a weight somebody raised.
 *
 * Pure geometry: `self` and each of `mates` is anything with
 * { x, y, z, vx, vy, vz }. No creature, no THREE, so tools/bait-ball-test.mjs
 * can run a whole ball for a minute and measure what actually emerges — which
 * is the only way to check a flock, because nothing about the result is written
 * down anywhere in the weights.
 *
 * @returns the shared scratch: a unit heading, the speed to swim it at, and the
 *          depth scale (see the header — the camera is orthographic and the
 *          near half of the orbit has to be drawn bigger or the rotation cannot
 *          be seen at all).
 */
export function baitFlock(self, mates, ball, c = cfg()) {
  const R = ball.shell ?? c.radius ?? 1.7;
  const spin = ball.spin ?? 1;

  let ax = 0;
  let ay = 0;
  let az = 0;

  // --- the three boids terms ------------------------------------------------
  const sepD = c.separation ?? 0.95;
  const nbrD = c.neighbour ?? 2.6;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let avx = 0;
  let avy = 0;
  let avz = 0;
  let n = 0;

  for (const m of mates) {
    if (m === self) continue;
    const dx = self.x - m.x;
    const dy = self.y - m.y;
    const dz = self.z - m.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > nbrD * nbrD) continue;
    const d = Math.sqrt(d2) || 1e-4;
    cx += m.x; cy += m.y; cz += m.z;
    avx += m.vx; avy += m.vy; avz += m.vz;
    n += 1;
    if (d < sepD) {
      // Inverse falloff rather than linear: a body already overlapping has to
      // be pushed much harder than one merely close, and a linear ramp gives
      // its hardest shove at exactly the distance where nothing is wrong yet.
      const push = (sepD / d - 1);
      sx += (dx / d) * push;
      sy += (dy / d) * push;
      sz += (dz / d) * push;
    }
  }

  if (n > 0) {
    ax += sx * (c.sepWeight ?? 9);
    ay += sy * (c.sepWeight ?? 9);
    az += sz * (c.sepWeight ?? 9);

    const al = Math.hypot(avx, avy, avz);
    if (al > 1e-4) {
      ax += (avx / al) * (c.alignWeight ?? 2.2);
      ay += (avy / al) * (c.alignWeight ?? 2.2);
      az += (avz / al) * (c.alignWeight ?? 2.2);
    }

    cx /= n; cy /= n; cz /= n;
    const cd = Math.hypot(cx - self.x, cy - self.y, cz - self.z);
    if (cd > 1e-4) {
      ax += ((cx - self.x) / cd) * (c.cohesionWeight ?? 1.1);
      ay += ((cy - self.y) / cd) * (c.cohesionWeight ?? 1.1);
      az += ((cz - self.z) / cd) * (c.cohesionWeight ?? 1.1);
    }
  }

  // --- the flow: a vortex, or something stranger ----------------------------
  // Horizontal offset from the vertical axis. y is ALONG the axis and must not
  // enter this — it is what makes the rotation a rotation about a standing
  // column rather than a wheel facing the camera.
  const rx = self.x - ball.x;
  const ry = self.y - ball.y;
  const rz = self.z;
  const rd = Math.hypot(rx, rz);
  const vw = c.vortexWeight ?? 6;

  if (ball.shape && ball.shape !== 'vortex') {
    // A STRANGE ATTRACTOR instead. See attractorFlow — the ball's fish are
    // swimming the streamlines of a chaotic system rather than a circle, so the
    // mass folds and re-folds through itself and never repeats. Rare and
    // experimental; `strangeChance` decides how often one turns up.
    const f = attractorFlow(ball.shape, rx / R, ry / R, rz / R, c);
    const fl = Math.hypot(f.x, f.y, f.z);
    if (fl > 1e-5) {
      ax += (f.x / fl) * vw * spin;
      ay += (f.y / fl) * vw;
      az += (f.z / fl) * vw * spin;
    }
  } else if (rd > 1e-3) {
    const swirl = vw * Math.min(1, rd / Math.max(0.2, R)) * spin;
    ax += (-rz / rd) * swirl;
    az += (rx / rd) * swirl;
  } else {
    // Dead on the axis: no tangent to speak of, so nudge it out along x and let
    // the next frame have a direction to work with. Without this a fish that
    // lands exactly on the axis has a zero vortex forever.
    ax += vw * 0.5;
  }

  // --- the noise ------------------------------------------------------------
  // What stops the ball being a machine. Everything above is smooth and
  // deterministic, and a smooth deterministic flock reads as a simulation —
  // the fish trace the same streamlines forever and the mass has no weather in
  // it. This is a slow Perlin field sampled at the fish's own position, so
  // neighbours get nearly the same push (a shared drift, which is a current)
  // while fish across the ball get different ones (which is turbulence).
  //
  // The vector comes from three offset samples of one scalar field rather than
  // three fields: it costs a third as much and the components are decorrelated
  // enough at these scales, which is all a wander needs.
  //
  // `noise` goes back out on the result, because this exact value is what
  // systems/baitShimmer.js lights the fish with. Same field, same phase — the
  // shimmer IS the drift, made visible.
  const nAmp = c.noiseWeight ?? 2.4;
  const nScale = Math.max(0.05, c.noiseScale ?? 3.2);
  const nT = (ball.age ?? 0) * (c.noiseRate ?? 0.25);
  const nx = self.x / nScale;
  const ny = self.y / nScale;
  const nz = self.z / nScale + nT;
  const n0 = baitNoise(nx, ny, nz);
  flockOut.noise = n0;
  if (nAmp > 0) {
    ax += n0 * nAmp;
    ay += baitNoise(nx + 31.4, ny, nz) * nAmp;
    az += baitNoise(nx, ny + 17.9, nz) * nAmp;
  }

  // --- the wall -------------------------------------------------------------
  // Horizontal: in from outside the shell, out from the hollow middle.
  const hollow = R * (c.hollow ?? 0.45);
  if (rd > 1e-3) {
    let radial = 0;
    if (rd > R) radial = -(rd - R) / Math.max(0.2, R);
    else if (rd < hollow) radial = (hollow - rd) / Math.max(0.2, hollow);
    if (radial !== 0) {
      const w = (c.wallWeight ?? 7) * Math.min(1, Math.abs(radial)) * Math.sign(radial);
      ax += (rx / rd) * w;
      az += (rz / rd) * w;
    }
  }
  // Vertical: only outside the column's half-height, so the fish are free
  // inside it and the ball has a flat-ish top and bottom rather than a point.
  const halfH = (c.height ?? 2.4) * 0.5 * (R / Math.max(0.01, c.radius ?? 1.7));
  const dy = self.y - ball.y;
  if (Math.abs(dy) > halfH) {
    const over = Math.min(1, (Math.abs(dy) - halfH) / Math.max(0.2, halfH));
    ay -= Math.sign(dy) * over * (c.wallWeight ?? 7);
  }

  // --- normalise ------------------------------------------------------------
  const len = Math.hypot(ax, ay, az);
  if (len < 1e-6) {
    flockOut.x = 1; flockOut.y = 0; flockOut.z = 0;
  } else {
    flockOut.x = ax / len;
    flockOut.y = ay / len;
    flockOut.z = az / len;
  }

  // WHAT IT SWIMS AT. The orbital speed the ball's rotation implies, plus
  // whatever the anchor itself is travelling at — a fish holding station on a
  // ball fleeing a shark has to carry both, and without the second term the
  // anchor outruns its own flock and drags it into a comet tail.
  flockOut.speed = R * (c.spinRate ?? 1.2) + Math.hypot(ball.vx ?? 0, ball.vy ?? 0);

  // THE DEPTH CUE — see the header. Proportional to actual z rather than to an
  // angle, so a fish near the axis (which barely moves in depth) does not swell
  // as though it were out on the rim.
  //
  // Divided by 1.25 shells rather than by the shell itself. The flock's
  // equilibrium sits a little OUTSIDE `shell` — separation pushes outward all
  // the time and the wall only balances it, measured at 1.78 against a 1.70
  // shell with a maximum near 2.1 — so dividing by the shell alone clamps
  // about a third of the ball at the extremes and flat-tops the cue: every
  // fish on the near face the same size, which is the shimmer this is supposed
  // to replace. The clamp stays as a bound on how big a body may ever be drawn.
  const reach = Math.max(0.01, R * 1.25);
  flockOut.scale = 1 + (c.depthCue ?? 0.28) * Math.max(-1, Math.min(1, self.z / reach));
  return flockOut;
}

/**
 * Where a fish is dropped when its ball opens: scattered through the column's
 * volume rather than placed on a shell.
 *
 * Random inside the solid, not on a ring, because the flock sorts itself out
 * within a second and a ring is a shape it would have to LEAVE first — which
 * looks like the ball breaking up on the frame it arrives. Height is biased
 * toward the middle by the same taper the wall uses.
 */
export function baitSeed(index, count, ball, rand = Math.random, c = cfg()) {
  const R = ball.shell ?? c.radius ?? 1.7;
  // Evenly spread in ANGLE and random in radius: a purely random pair leaves
  // clumps, and a clump at spawn is the one moment the flock cannot smooth over
  // because it has not started yet.
  const a = (index / Math.max(1, count)) * Math.PI * 2 + (rand() - 0.5) * 0.6;
  const rad = R * (0.45 + rand() * 0.55);
  const halfH = (c.height ?? 2.4) * 0.5 * (R / Math.max(0.01, c.radius ?? 1.7));
  return {
    x: ball.x + Math.cos(a) * rad,
    y: ball.y + (rand() * 2 - 1) * halfH * 0.8,
    z: Math.sin(a) * rad,
  };
}

/**
 * One line describing how a finished ball's exchange went, for the dev log.
 *
 * Here rather than at the call site because the numbers and the sentence that
 * reads them have to agree, and a caller formatting `eaten` and `taken` by hand
 * is a caller that can get the two the wrong way round — which would be a
 * readout that says the player is winning while they lose.
 */
export function baitBallLedger(ball) {
  // THE SURVIVORS ARE COUNTED, NOT DERIVED. `opened - eaten - taken` was the
  // obvious arithmetic and it is a line that lies: it assumes the only two ways
  // out of a ball are the two this feature books, and the game has others — a
  // haul, a whale's intake, an ability that removes without a kill. Every fish
  // that leaves by one of those was silently reported as having "swum off",
  // which is a readout quietly overstating how much of the ball nobody got.
  //
  // `count` is the live headcount updateBaitBalls refreshes from the school
  // every frame, so it is what is actually still there.
  const left = Math.max(0, ball.count ?? 0);
  const contested = ball.eaten + ball.taken;
  // ...and anything the three of them do not add up to is SAID, rather than
  // absorbed into whichever number happens to be derived. A ledger with a hole
  // in it should look like one.
  const missing = Math.max(0, ball.opened - contested - left);
  const share = contested > 0 ? ball.taken / contested : null;
  return `${ball.opened} fish: you took ${ball.taken}, they ate ${ball.eaten}, `
    + `${left} swam off`
    + (missing > 0 ? `, ${missing} left some other way` : '')
    + (share == null ? ' (nobody touched it)' : ` — your share of the contested ${contested} was ${(share * 100).toFixed(0)}%`)
    + (ball.timedOut ? ', ball timed out' : ', ball broke up');
}

/**
 * What a predator gains from one mouthful of bait ball.
 *
 * A FRACTION OF ITS OWN HEALTH, floored at whatever it would have got from an
 * ordinary fish. `hunt.healPerMeal` is a flat number authored against the
 * wildlife — 18 on a shark that has 75 health is a quarter of its bar, and 18
 * on a boss that has 2,400 is nothing at all, so a flat heal is exactly
 * invisible on the one creature this mechanic exists to make interesting. The
 * fraction is what makes a boss eating twelve fish a real swing in the fight,
 * and the floor is what stops it being a NERF to the sharks the flat number
 * was written for.
 *
 * Deliberately small per mouthful: the tug of war is about how much of the
 * ball each side gets through, and a heal you can lose the fight to in three
 * bites would mean the correct play is always to ignore the ball and kill the
 * boss, which is the same as not having built this.
 *
 * @param spawnHp the predator's health at spawn — NOT its current max, which
 *                grows as it overheals and would let the fraction compound.
 */
export function baitMealHeal(spawnHp, base = 0, c = cfg()) {
  const f = c.feed ?? {};
  if (f.enabled === false) return base;
  const frac = (spawnHp ?? 0) * (f.healFrac ?? 0.012);
  return Math.max(base, frac, f.minHeal ?? 0);
}
