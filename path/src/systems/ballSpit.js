import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { surfaceHeightAt } from '../arena.js';

// ============================================================================
// WHAT THE BALL SPITS WHEN IT IS HIT — the cloud that comes out of the contact
// patch, as opposed to the wake that comes off its back.
//
// systems/ballTrail.js already boils bubbles continuously, from two points
// solved DEAD ASTERN of the heading. That is the right place for a wake and the
// wrong place for an impact: astern says how fast the ball is going, and an
// impact has two things to say that a wake structurally cannot.
//
//   WHERE IT WAS HIT. The contact point is on the drawn edge, at a bearing that
//   has nothing to do with the heading — a ball struck square on the nose and a
//   ball clipped off its shoulder leave at the same speed and are not the same
//   event. The patch is the only thing on screen that can say which it was, and
//   it is also the only thing that points back at whoever did it.
//
//   WHICH WAY THE IMPULSE WENT. A wake trails the flight, so it draws the
//   answer a quarter of a second late and only while the ball is still moving.
//   The jet here is thrown on the line the ball LEAVES on, at the instant it
//   leaves, which is what makes a smash read as a smash on its own frame.
//
// SO IT IS TWO FANS OUT OF ONE PATCH, and neither of them is decoration:
//
//   THE JET   a narrow cone along the impulse, fast, carrying most of the
//             ball's new velocity. This is the direction.
//   THE WASH  a wide cone back along the contact normal — water squeezed out
//             of the pinch, thrown past the striker. This is the source.
//
// AND THE NOISE IS STRUCTURED, NOT ROLLED. The shared current
// (CONFIG.fx.turbulence) is a slow arena-wide swirl: it is what makes two
// bursts beside each other bend the same way, and at the tenth-of-a-second
// scale of an impact it does almost nothing. Churn at THIS scale comes from
// firing the fans as several small PUFFS spread across the contact patch, each
// one bent by where on the patch it sits and jittered off that — so the cloud
// tears and folds instead of expanding as one clean cone. The particles are
// then handed the current on top at a high `turbulence`, which is what keeps
// the tail of it wandering after the throw has died.
//
// SMALL AND CHEAP, DELIBERATELY. This fires on every touch the ball has, which
// in a scramble is a handful inside a second. The bubbles are a third the size
// of the wake's and live half as long; what makes it read is that there are a
// hundred of them, not that any one of them is worth looking at. `spriteDensity`
// and the relief ramp thin it with every other burst in the game, and
// `maxParticles` is the ceiling no single impact may go past.
//
// ONE CALLER: ballImpactFx in systems/versus.js, which is already the one
// funnel every touch goes through — a strike, a block, a pierce, a wall, a
// post, a hull, a fish. Nothing else should fire this, because anything that
// did would be claiming the ball was hit.
// ============================================================================

const _col = new THREE.Color();
const _team = new THREE.Color();

// Bursts asked for since the last reset, and particles with them. `emit` is a
// no-op with no particle system initialised — which is exactly the case a Node
// harness runs in — so counting the ASK is the only way to prove the bubbles
// are being requested at all. See ballSpitStats.
let bursts = 0;
let fired = 0;
let lastAt = null;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function cfg() {
  return CONFIG.versus?.ball?.spit ?? {};
}

/**
 * ONE IMPACT'S WORTH.
 *
 * @param x,y      the contact point — the DRAWN edge, which on a dented ball is
 *                 not a circle. ballImpactFx has already solved it.
 * @param nx,ny    the contact normal, pointing from the contact point toward
 *                 the ball's middle. This is the sign convention the whole of
 *                 versus.js uses: the striker is on the `-n` side.
 * @param impX,impY the line the ball leaves on. Defaults to the normal, which
 *                 is exactly right for a wall (the rock's impulse is its inward
 *                 normal) and close for everything else; the strike passes its
 *                 own, because `grip` swings it off the normal toward the dash.
 * @param force    0..1, the same figure ballImpactFx sizes the splash from.
 * @param vx,vy    the ball's velocity AFTER the touch, for the inherit term.
 * @param r        the ball's radius at the contact, which sets the patch width.
 * @param color    the SOURCE's colour — the striking team's, not the ball's.
 *                 Null for a wall, which is nobody's.
 * @returns how many particles were asked for.
 */
export function spitBallBubbles({
  x = 0, y = 0, nx = 1, ny = 0, impX = null, impY = null,
  force = 1, vx = 0, vy = 0, r = 2.4, color = null, underwater = null,
} = {}) {
  const c = cfg();
  if (c.enabled === false) return 0;

  // NOTHING TO BOIL IN THE AIR. A lob volleyed above the line is a real touch
  // and gets its splash, its goo and its sound from ballImpactFx like any
  // other — it just has no water in it. Measured against the WAVING surface
  // rather than the flat `bounds.surfaceY`: the ball spends half a match
  // within a wave height of the line, and the two disagree exactly there.
  const wet = underwater ?? (y < surfaceHeightAt(x));
  if (!wet) return 0;

  const k = clamp01(force);
  if (k < (c.minForce ?? 0.02)) return 0;
  // The count ramp is CONCAVE. Force is impulse over the hardest strike there
  // is, so an ordinary pass sits down around 0.2 and a linear count would make
  // every touch in a normal possession nearly invisible while reserving the
  // whole effect for a shot nobody takes twice a match.
  const ramp = Math.pow(k, c.forcePow ?? 0.6);

  const nl = Math.hypot(nx, ny) || 1;
  const cnx = nx / nl;
  const cny = ny / nl;
  let jx = impX ?? cnx;
  let jy = impY ?? cny;
  const jl = Math.hypot(jx, jy);
  if (jl > 1e-6) { jx /= jl; jy /= jl; }
  else { jx = cnx; jy = cny; }

  // Across the patch: the normal turned a quarter turn, which is the same `t`
  // the strike's friction uses.
  const tx = -cny;
  const ty = cnx;
  // How wide the contact patch is taken to be. A harder hit flattens more of
  // the ball against the striker, so the spread opens with the force — the
  // same reason the dent does.
  const patch = Math.max(0, r) * (c.patch ?? 0.55) * lerp(c.patchSoft ?? 0.45, 1, ramp);
  // Off the skin, along -n. Born exactly on the drawn edge they start inside
  // the goo body's isoline and the first frames of the cloud are swallowed.
  const lift = Math.max(0, r) * (c.lift ?? 0.12);

  const tint = resolveTint(c, color);
  const cap = Math.max(1, c.maxParticles ?? 170);
  let budget = cap;

  budget -= fan(c, {
    emitter: c.jetEmitter ?? 'ballSpit',
    puffs: Math.max(1, Math.round(lerp(c.jetPuffsMin ?? 2, c.jetPuffsMax ?? 5, ramp))),
    dirX: jx, dirY: jy,
    scale: lerp(c.jetScaleMin ?? 0.45, c.jetScaleMax ?? 1.9, ramp),
    sizeMul: lerp(c.sizeMin ?? 0.7, c.sizeMax ?? 1.25, ramp),
    speedMul: lerp(c.jetSpeedMin ?? 0.7, c.jetSpeedMax ?? 2.3, ramp),
    // The jet is the ball's own water leaving with it, so it keeps most of the
    // new velocity; the wash is water that stayed behind, so it keeps little.
    inherit: c.jetInherit ?? 1,
    fan: c.jetFan ?? 0.55,
    wander: c.jetWander ?? 0.3,
    x, y, tx, ty, nx: cnx, ny: cny, patch, lift, vx, vy, tint, budget,
  });

  budget -= fan(c, {
    emitter: c.washEmitter ?? 'ballSpitWash',
    puffs: Math.max(1, Math.round(lerp(c.washPuffsMin ?? 1, c.washPuffsMax ?? 3, ramp))),
    // BACK OUT OF THE PINCH — the striker's side, which is -n. The emitter's
    // own cone is wide enough that the edges of it come out nearly sideways,
    // so one fan covers the whole collar.
    dirX: -cnx, dirY: -cny,
    scale: lerp(c.washScaleMin ?? 0.35, c.washScaleMax ?? 1.5, ramp),
    sizeMul: lerp(c.sizeMin ?? 0.7, c.sizeMax ?? 1.25, ramp) * (c.washSize ?? 1.15),
    speedMul: lerp(c.washSpeedMin ?? 0.5, c.washSpeedMax ?? 1.4, ramp),
    inherit: c.washInherit ?? 0.15,
    fan: c.washFan ?? 0.9,
    wander: c.washWander ?? 0.45,
    x, y, tx, ty, nx: cnx, ny: cny, patch, lift, vx, vy, tint, budget,
  });

  bursts++;
  lastAt = { x, y, nx: cnx, ny: cny, impX: jx, impY: jy, force: k, spent: cap - budget, color: tint };
  return cap - budget;
}

/**
 * ONE FAN, AS A HANDFUL OF PUFFS ACROSS THE PATCH.
 *
 * `u` walks -1..1 over the puffs, which is where along the contact patch this
 * one sits. It does three things at once, and they are the whole of the churn:
 * it MOVES the origin across the patch, it BENDS the throw outward in the
 * direction it sits (`fan`, so the cloud opens like water squeezed out of a
 * closing gap rather than expanding as one cone), and it is jittered off both
 * by `wander` so no two impacts fold the same way.
 *
 * Evenly spaced rather than rolled: three random points on a line land in a
 * clump about a third of the time, and a clump is one puff that cost three.
 */
function fan(c, o) {
  const def = CONFIG.emitters?.[o.emitter];
  if (!def) return 0;
  const per = Math.max(1, Math.round((def.count ?? 8) * o.scale));
  let spent = 0;
  for (let i = 0; i < o.puffs; i++) {
    if (spent + per > o.budget) break;
    // -1..1, and a single puff sits in the middle rather than at the end.
    const u = o.puffs === 1 ? 0 : (i / (o.puffs - 1)) * 2 - 1;
    const jitter = (Math.random() * 2 - 1);
    const across = u * o.patch + jitter * o.patch * (c.patchJitter ?? 0.35);
    const a = Math.atan2(o.dirY, o.dirX) + u * o.fan + jitter * o.wander;
    // Speed scattered per puff as well as per particle: the emitter's own band
    // spreads the particles WITHIN a puff, and this is what stops the puffs
    // themselves arriving as one shell.
    const sp = o.speedMul * (1 + (Math.random() * 2 - 1) * (c.speedVary ?? 0.35));
    emit(o.emitter,
      o.x + o.tx * across - o.nx * o.lift,
      o.y + o.ty * across - o.ny * o.lift, {
        dirX: Math.cos(a),
        dirY: Math.sin(a),
        vx: o.vx * o.inherit,
        vy: o.vy * o.inherit,
        scale: o.scale,
        sizeMul: o.sizeMul,
        speedMul: sp,
        color: o.tint,
      });
    spent += per;
    fired += per;
  }
  return spent;
}

/**
 * THE SOURCE'S COLOUR, MIXED INTO WATER — never used outright.
 *
 * `tint` is a mix the same way the wake's is, and for the same reason: at 1
 * these stop being bubbles and become a coloured puff, which reads as an
 * ability firing rather than as the sea being displaced. What the colour has to
 * carry is WHO hit it, and a fifth of it does that while the cloud stays water.
 *
 * A wall passes none, because a wall is nobody's — those come out plain, which
 * is itself the information.
 */
function resolveTint(c, color) {
  const mix = clamp01(c.tint ?? 0.35);
  if (color == null || mix <= 0) return null;
  _team.set(color);
  return _col.set(c.color ?? 0xdff6ff).lerp(_team, mix).getHex();
}

/** For the harness and the ball lab: what has been asked for since the reset. */
export function ballSpitStats() {
  return { bursts, particles: fired, last: lastAt };
}

/** Kickoff, a goal, the end of a match, the lab's R. */
export function resetBallSpit() {
  bursts = 0;
  fired = 0;
  lastAt = null;
}
