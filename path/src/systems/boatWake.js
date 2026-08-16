import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { feedback } from './feedback.js';
import { surfaceHeightAt } from '../arena.js';

// THE WAKE EVERY HULL LEAVES — one description of what a boat does to water,
// shared by every boat in the game:
//
//   systems/boats.js     the rowboat and the trawler that sail across the top
//                        of the arena and get shot for their catch.
//   systems/bossBoat.js  both boat bosses — the trawler hull and the yacht —
//                        which hold station over the fight instead of sailing.
//
// Those two live in completely different lists (one is a plain object with a
// RigidBody, the other is a creature carrying `surfaceBoss` on its row) and
// have no type in common, so this takes only the four numbers a wake actually
// needs and hangs its own accumulators on whatever it is handed. See
// CONFIG.boatWake for the shape of the effect.
//
// WHAT IT IS MADE OF, and why it is bubbles rather than a ribbon or a decal:
// the game already draws foam for free. A bubble born under the waterline
// rises, breaks the surface and bursts into `bubbleBurst` droplets — that pop
// is handled on the CPU by entities/particles.js and it lands exactly where the
// bubble was drawn. So a line of churn dragged along under the hull surfaces a
// moment later as a line of white behind it, with nothing here drawing a line.
//
// NOTHING IS EVER BORN ON THE BOAT, and this is the rule the whole placement
// below exists to keep.
//
// Particles are drawn with depth testing OFF and a high render order (see the
// material in entities/particles.js), so they are ALWAYS in front of the hull
// whatever their z. "Behind the boat" is therefore not something a z value can
// buy — it has to be true in x and y. The first version of this system ignored
// that: it spread the churn from amidships aft at a fixed depth under the WATER
// LINE, and since a hull sits a good half-unit into the water, most of the wake
// was born INSIDE the boat and painted straight over it.
//
// So there are two zones, both defined against the hull's MEASURED box rather
// than against the water line:
//
//   ASTERN  behind the transom. Cannot overlap anything by construction, and
//           it is the bulk of the effect.
//   KEEL    under the hull bottom, at the aft end, thrown astern hard. This is
//           the half that reads as water dragged UNDER a hull rather than
//           merely trailing it — and it is the half with a constraint on it,
//           because a bubble born under the keel rises, and rising into the
//           hull is the same overlap by a slower route. It is kept near the
//           stern and thrown aft so its path leaves the hull's footprint before
//           buoyancy carries it up to the keel line.
//
// THERE IS NO RUNTIME COLLISION AND THERE CANNOT BE. Every particle's position
// is solved analytically from its age in the vertex shader — there is no CPU
// position to test and no way to change a trajectory once it is emitted. What
// stands in for collision is entirely at BIRTH: the placement above, and an
// astern kick sized so the solved path clears the hull. `npm run test:wake`
// re-solves that path with the same closed form the shader uses and asserts no
// bubble is ever inside the hull box, which is the guarantee this comment is
// claiming.
//
// TWO THINGS IT DELIBERATELY DOES NOT READ:
//
//   THE HULL'S OWN Y, for the water line. The boat bobs and rolls; the sea has
//   its own line at any given x, and they are not the same number. A bubble
//   whose DEPTH is measured off the hull rides the bob, which reads as the wake
//   being welded to the boat. Depth comes off `surfaceHeightAt` — the water's
//   line, the same one the surface clip and the pop are tested against. The
//   hull's own y is read only for where the KEEL is, which is a fact about the
//   boat and belongs in the boat's frame.
//
//   THE HULL'S VELOCITY, for its HEADING. A boat boss spends whole volleys
//   parked in its deadzone, and a stern worked out from a velocity of zero
//   flips side to side at random. Callers pass the direction the hull is
//   POINTING (see the yaw in systems/bossBoat.js) and its speed separately.

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// HOW WIDE A FOAM LOBE ACTUALLY DRAWS, in world units, measured from its centre.
//
// A goo particle is not a sprite: its splat is `size x the group's radius`
// across (see the goo note in entities/particles.js), so the shipped 0.3 x 3.0
// is nearly a unit wide where the bubble it sits next to is a fifth of that.
// Every placement rule in this file is about where a particle is BORN, which is
// only the same question as where it is DRAWN while the drawn thing is small.
//
// Read from config rather than written down so that retuning either half moves
// the hull clearance with it. The largest size the emitter can roll, because
// the guarantee has to hold for every lobe and not for the average one. Falls
// back to the group's default radius, then to the sprite's own size when goo is
// off entirely — where the blob genuinely is just the sprite.
function foamHalfExtent() {
  const def = CONFIG.emitters?.hullFoam;
  if (!def) return 0;
  const size = Array.isArray(def.size) ? def.size[1] : (def.size ?? 0.2);
  const goo = CONFIG.fx?.goo;
  if (!goo || goo.enabled === false) return size * 0.5;
  const radius = goo.groups?.[def.goo]?.radius ?? goo.radius ?? 3;
  return size * radius * 0.5;
}

// THE OTHER HALF OF A WAKE, and it is not particles at all.
//
// Bubbles say a hull is churning; they cannot say it is SITTING IN something.
// The grid already draws that for the seal — a standing pull that warps the
// lattice inward wherever the player is (CONFIG.grid.wakeStrength) — and it was
// a single source only because there had only ever been one thing worth
// warping around. Hulls are the second, and they want exactly the same effect
// for exactly the same reason, so this publishes them into the same field
// rather than inventing a surface distortion of its own.
//
// Held here as a module reference the way systems/feedback.js holds it, and for
// the same reason: neither systems/boats.js nor systems/bossBoat.js has any
// business knowing the grid exists, and threading it through every call would
// put a renderer argument on a function about water.
let grid = null;

/** Hand the wake the grid to warp. Called once, from main.js. */
export function setWakeGrid(g) {
  grid = g;
}

/**
 * Clear the accumulators. Only the boss needs this — an ordinary boat's state
 * dies with the boat — but a hull whose fight was reset mid-wake would
 * otherwise carry a fraction of a burst into the next one.
 */
export function resetHullWake(hull) {
  if (!hull) return;
  hull.wakeChurn = 0;
  hull.wakeSpray = 0;
  hull.wakeFoam = 0;
}

/**
 * A HULL COMING ABOUT. One event, fired on the frame a turn begins.
 *
 * Only the boat boss can reach this — the boats that sail past are spun to face
 * their heading once at spawn and never turn again — but it lives here with the
 * rest of the wake because it is the same question (what does this boat do to
 * the water) and because nothing about it is boss-specific.
 *
 * BOTH ENDS, and that is the whole reason it is not a single burst at the
 * centre. A hull swings about a point somewhere near its middle, so the bow and
 * the stern travel in opposite directions and each shoulders its own slug of
 * water. One splash, anywhere, reads as the boat being HIT; two, at the ends,
 * read as it turning. They go through feedback() as one named event, so the
 * sound throttle collapses the pair into a single splash rather than playing it
 * twice on the same frame — see `boatTurn` in CONFIG.feedback.
 *
 * @param o same payload the frame update takes: { x, halfLength, dir }
 */
export function hullTurnSplash(o) {
  const c = CONFIG.boatWake;
  if (!c?.enabled || c.turnSplash === false || !o) return;
  const halfLength = Math.max(0.2, o.halfLength || 1);
  const at = Math.min(1, Math.max(0, c.turnSplashAt ?? 0.85));
  const scale = Math.min(c.turnSplashMax ?? 2.2,
    (c.turnSplashScale ?? 1) * Math.max(0.5, halfLength / Math.max(0.1, c.refHalfLength ?? 3)));
  for (const end of [1, -1]) {
    const x = o.x + end * at * halfLength;
    feedback('boatTurn', {
      x,
      // ON the water rather than under it: this is a slug of water shouldered
      // aside and thrown, which happens at the surface. The splash emitter
      // throws its own arc from here.
      y: surfaceHeightAt(x),
      dirX: end * 0.35,
      dirY: 1,
      scale,
    });
  }
}

/**
 * @param dt   seconds
 * @param hull anything with a stable identity — the accumulators are stored on
 *             it, so two boats never share one carry and a low rate still fires
 *             at the right average frequency per hull instead of being rounded
 *             away to nothing every frame.
 * @param o    { x, halfLength, keelY, dir, speed, vx }
 *             x          the CENTRE OF THE MEASURED BOX, in world units — not
 *                        the mesh origin. prepareModel anchors these hulls on
 *                        their centre of mass, which is not the middle of the
 *                        boat, so the two differ by `offsetX` and placing the
 *                        transom against the wrong one puts the wake inside the
 *                        stern.
 *             halfLength half its MEASURED length — not a hitbox radius. The
 *                        boss's `radius` is the circle you shoot at (4.2) and
 *                        is deliberately smaller than the boat it belongs to;
 *                        a wake laid out against it comes out of the middle of
 *                        the hull.
 *             keelY      world y of the hull's BOTTOM. Optional: without it
 *                        there is no way to know what "under the boat" means,
 *                        so the keel zone is skipped entirely and the whole
 *                        wake goes astern — which is degraded but never wrong.
 *             dir        +1 if the bow points along +x, -1 if it points along
 *                        -x. Where it is POINTING, not where it is going.
 *             speed      how fast it is actually travelling, unsigned
 *             vx         its signed velocity, for what the water carries
 *             turning    0..1 through a turn, 0 when settled. Optional, and
 *                        only the boss ever sends it — a hull coming about has
 *                        almost no forward speed and would otherwise go quiet
 *                        through the manoeuvre.
 */
export function updateHullWake(dt, hull, o) {
  const c = CONFIG.boatWake;
  if (!c?.enabled || !hull || !o || !(dt > 0)) return;

  const halfLength = Math.max(0.2, o.halfLength || 1);
  const speed = Math.abs(o.speed ?? 0);
  const vx = o.vx ?? 0;
  const dir = (o.dir ?? 1) >= 0 ? 1 : -1;
  const keelY = Number.isFinite(o.keelY) ? o.keelY : null;

  // How hard this hull is working, 0..1. Ramped rather than switched, so a boat
  // getting under way fades its wake in instead of popping it — same reasoning
  // as the seal's in systems/bubbles.js.
  const ramp = Math.min(1, speed / Math.max(0.1, c.speedRef ?? 5));
  // A bigger hull moves more water. Floored below 1 as well as capped, so a
  // hull smaller than the reference still bubbles rather than going silent.
  const hullScale = Math.min(c.scaleMax ?? 2.4,
    Math.max(0.5, halfLength / Math.max(0.1, c.refHalfLength ?? 3)));
  const cap = Math.max(1, c.maxPerFrame ?? 4);

  // --- the churn -------------------------------------------------------------
  // Down the wetted length and out behind the transom, on a rate that never
  // reaches zero: `idleShare` is what a hull sitting still still displaces.
  const idle = Math.min(1, Math.max(0, c.idleShare ?? 0));
  // A HULL SLEWING SIDEWAYS IS WORKING, whatever its forward speed says. `ramp`
  // is read off travel along the heading and a boat coming about has almost
  // none — it is turning, not sailing — so without this the churn goes QUIET
  // through the one manoeuvre the whole fight is watching. `turning` is 0..1
  // across the turn (see hullTurnSplash for the event that opens it).
  const turning = Math.min(1, Math.max(0, o.turning ?? 0));
  const drive = Math.max(idle + (1 - idle) * ramp, turning * (c.turnChurn ?? 0.9));
  const rate = (c.churnPerSecond ?? 22) * hullScale * drive;
  hull.wakeChurn = (hull.wakeChurn ?? 0) + rate * dt;
  let bursts = Math.floor(hull.wakeChurn);
  hull.wakeChurn -= bursts;
  bursts = Math.min(bursts, cap);
  // --- HOW MUCH OF THE KEEL IS SAFE TO USE ------------------------------------
  //
  // A bubble under a hull rises, and rising into the hull is the same overlap as
  // being born in it. What saves it is not its own motion — it is thrown aft but
  // water stops it almost at once — it is that THE BOAT LEAVES. So the usable
  // stretch of keel is however much hull passes over the bubble while it climbs
  // the clearance it was given, and that is a length the hull's own speed
  // decides: `speed * keelRise`.
  //
  // Which means it self-limits at the one case that would otherwise be
  // guaranteed to break. A hull holding station — the boat boss through an
  // entire volley — flushes nothing out from under itself however long you
  // wait, so the span collapses to zero and the whole wake goes astern. That is
  // both the safe answer and the right-looking one: a boat that is not moving
  // is not dragging anything under its keel.
  //
  // `keelRise` is a constant rather than a solve. The real climb depends on the
  // emitter's gravity, its drag, and a per-particle drag scatter, so an exact
  // figure here would be a second copy of the shader's closed form that could
  // drift from it. Instead it is set conservatively and the guarantee is
  // MEASURED: `npm run test:wake` re-solves every bubble's path with the same
  // closed form the shader uses and fails if one is ever inside the hull.
  //
  // Without a measured keel there is no safe "under the boat" at all, so the
  // zone is skipped rather than placed by guesswork.
  const flush = speed * Math.max(0, c.keelRise ?? 0.22) - Math.max(0, c.keelMargin ?? 0.15);
  const keelSpan = keelY == null
    ? 0
    : Math.min(halfLength * Math.max(0, c.keelSpanMax ?? 0.3), Math.max(0, flush));
  const keelShare = keelSpan > 0
    ? 1 - Math.min(1, Math.max(0, c.asternShare ?? 0.62))
    : 0;

  for (let i = 0; i < bursts; i++) {
    // Spread per burst rather than per frame — that is what makes the wake a
    // length of disturbed water instead of an emitter parked at one point that
    // happens to be moving.
    const underKeel = Math.random() < keelShare;
    let x;
    let y;
    if (underKeel) {
      // UNDER THE HULL, measured FORWARD FROM THE TRANSOM by at most the span
      // the boat's own motion can flush — see above. Anchoring it to the stern
      // rather than to a fraction of the hull is what makes the rule hold for
      // a six-unit rowboat and a thirteen-unit yacht without a second number.
      x = o.x - dir * halfLength + dir * Math.random() * keelSpan;
      // Below the hull's OWN bottom, not below the water line. This is the one
      // number that has to be in the boat's frame — it is the boat that the
      // bubble must not be inside of.
      y = keelY - Math.max(0.02, (c.keelClearance ?? 0.26)
        * (1 + (Math.random() * 2 - 1) * (c.depthVary ?? 0.4)));
    } else {
      // ASTERN OF THE TRANSOM. `asternFrom` is just past 1 for a reason — at
      // exactly 1 a bubble sits on the transom itself, and with the hull's roll
      // and bob that is inside it about half the time.
      const along = lerp(c.asternFrom ?? 1.02, c.asternTo ?? 1.55, Math.random());
      x = o.x - dir * along * halfLength;
      const jitter = 1 + (Math.random() * 2 - 1) * (c.depthVary ?? 0.4);
      y = surfaceHeightAt(x) - Math.max(0.02, (c.depth ?? 0.35) * jitter);
    }
    // Two emitters, and the difference between them is the CONE — see
    // `hullKeel` in CONFIG.emitters. A keel bubble must go astern and only
    // astern; the wide spread that makes foam boil nicely behind a transom
    // would throw a third of them straight up into the boat.
    emit(underKeel ? 'hullKeel' : 'hullWake', x, y, {
      // Astern, and — for the astern zone only — upward: the bubble is cast
      // back by the hull passing and then does what a bubble does. Magnitude is
      // irrelevant, the emitter reads the ANGLE and throws at its own speed. A
      // keel bubble is aimed dead flat, because what it has to do first is LEAVE.
      dirX: -dir,
      dirY: underKeel ? 0 : (0.5 + Math.random() * 0.5) / Math.max(0.05, c.back ?? 0.8),
      // Only a share of the hull's speed, and less of it under the keel: what
      // flushes a keel bubble out is the boat leaving, and carrying it FORWARD
      // with the boat is the one thing working against that.
      vx: vx * (underKeel ? (c.keelCarry ?? 0) : (c.carry ?? 0.35)),
      vy: 0,
    });
  }

  // --- the white water --------------------------------------------------------
  // The foam the bubbles above are boiling out of, as one fusing mass rather
  // than as more dots (see `hullFoam` in CONFIG.emitters). Astern only: the
  // keel zone's whole safety argument is that a bubble is flushed out from
  // under the boat before it can rise into it, and a blob several times the
  // size of a bubble is not flushed by the same margin.
  if (c.foamEnabled !== false) {
    hull.wakeFoam = (hull.wakeFoam ?? 0) + (c.foamPerSecond ?? 5) * hullScale * drive * dt;
    let lobes = Math.floor(hull.wakeFoam);
    hull.wakeFoam -= lobes;
    lobes = Math.min(lobes, cap);

    // THE CLEARANCE IS DERIVED, NOT TYPED, and this is the whole reason the
    // foam is not simply `hullWake` with a group name on it.
    //
    // Every placement rule above is about where a particle is BORN, because a
    // sprite is a tenth of a unit across and its centre is as good as its
    // edge. A goo blob is not: it draws `size x radius` wide — the shipped
    // numbers are 0.3 x 3.0, or nine tenths of a unit — so a lobe born legally
    // one hair astern of the transom still paints a third of itself across the
    // hull. Reading both values here means retuning either one moves the
    // clearance with it instead of silently invalidating the guarantee that
    // `npm run test:wake` makes.
    const clear = halfLength + foamHalfExtent() + Math.max(0, c.foamGap ?? 0.08);
    const span = halfLength * Math.max(0, c.foamSpan ?? 0.55);

    for (let i = 0; i < lobes; i++) {
      const x = o.x - dir * (clear + Math.random() * span);
      // At the line, a touch under it. Foam is what is left ON the water.
      const y = surfaceHeightAt(x) - Math.max(0, c.foamDepth ?? 0.06);
      emit('hullFoam', x, y, {
        dirX: -dir,
        dirY: 0.35,
        // More of the hull's speed than the bubbles take: this mass is being
        // dragged along by the boat that made it, and foam that instantly
        // stops dead reads as a stain rather than as a wake.
        vx: vx * (c.carry ?? 0.35) * 1.4,
        vy: 0,
      });
    }
  }

  // --- the dent in the water --------------------------------------------------
  // Re-published every frame rather than registered, so a hull that is shot out
  // from under its own wake takes the warp with it — see grid.hullWake. Sized
  // off the hull's own length and pulled INWARD (negative), the same sign the
  // seal's uses: a boat should read as sitting in the water, not as repelling
  // it. The pull deepens with speed, so a hull under way drags a visibly bigger
  // hollow than one holding station.
  const g = CONFIG.boatWake.grid ?? {};
  if (grid?.hullWake && g.enabled !== false) {
    grid.hullWake(
      o.x,
      surfaceHeightAt(o.x),
      halfLength * (g.radius ?? 1.6),
      -(g.strength ?? 0.5) * (1 + ramp * (g.speedGain ?? 1.1)),
    );
  }

  // --- the bow wave ----------------------------------------------------------
  // The half that happens in the air, and the half that reads as SPEED. Gated
  // well up the ramp so it belongs to a hull under way and never to one parked
  // over the player.
  const minRamp = Math.min(0.99, Math.max(0, c.sprayMinRamp ?? 0.35));
  if (c.sprayEnabled === false || ramp <= minRamp) {
    hull.wakeSpray = 0;
    return;
  }
  const sprayRamp = (ramp - minRamp) / (1 - minRamp);
  hull.wakeSpray = (hull.wakeSpray ?? 0) + (c.sprayPerSecond ?? 9) * hullScale * sprayRamp * dt;
  let drops = Math.floor(hull.wakeSpray);
  hull.wakeSpray -= drops;
  drops = Math.min(drops, cap);
  for (let i = 0; i < drops; i++) {
    // Spread FORWARD only. A symmetric jitter about `sprayAt` puts half the
    // drops back inside the bow, which is the overlap this was moved to avoid.
    // HOW FAR AHEAD IT STARTS, and it cannot be a fixed fraction of the hull.
    // A drop leaves at the boat's own speed, but drag bleeds that off within a
    // few tenths and from then on the hull is CLOSING on it — so a lead that
    // sits nicely off the stem at a sailing speed of three is inside the
    // foredeck at twelve, which is what a blast does to a rowboat. The ground
    // the hull makes up over a drop's life is proportional to its speed, so the
    // lead is too. (Deriving it exactly would mean a second copy of the
    // shader's closed form here, free to drift from it; the coefficient is
    // conservative instead and the harness checks it at 12 u/s.)
    const x = o.x
      + dir * ((c.sprayAt ?? 1.2) + Math.random() * 0.2) * halfLength
      + dir * speed * (c.sprayLeadPerSpeed ?? 0.14);
    // ABOVE the line, which is what keeps this out of the surface clip — see
    // the note on `hullSpray` in CONFIG.emitters.
    const y = surfaceHeightAt(x) + Math.max(0.01, c.sprayHeight ?? 0.12);
    emit('hullSpray', x, y, {
      // Up and forward, off the stem.
      dirX: dir * 0.55,
      dirY: 1,
      // ALL of it, not a share. See `hullSpray` in CONFIG.emitters: a drop that
      // does not leave at the boat's own speed is a drop the boat overtakes,
      // and an overtaken bow wave is drawn across the foredeck.
      vx,
      vy: 0,
    });
  }
}
