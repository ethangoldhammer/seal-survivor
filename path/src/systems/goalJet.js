// ---------------------------------------------------------------------------
// THE GOAL JET — the goal's explosion, born off screen and fired back out
// through the mouth.
//
// A goal is called once the ball is past the edge of the screen (see
// systems/versusGoal.js), so the moment itself happens where nobody can see
// it. What CAN be seen is the corridor: the goo comes back OUT of it — born
// deep in the tunnel, driven at the water, ricocheting off the lips and
// squeezed through the opening at speed, spreading and tumbling once it is
// clear of the rock. What the ball was, thrown back at the two seals.
//
// DRIVEN SLOTS, NOT A BURST. An ordinary emitter is a closed form — a spawn
// point, a velocity and a drag the shader integrates on its own — and a
// closed form cannot bounce off a wall. These are the particle system's
// driven slots (entities/particles.js): each one is a small body stepped
// here on the CPU every frame, and written into the ball's goo group so the
// pass welds them into the ball's own substance. The spray on top of them —
// sprites with no need to collide, because they are emitted at the mouth —
// is the ordinary `versusGoal` event, which fires alongside.
//
// ON THE WALL CLOCK. The goal drops the world to a near stop for a third of
// a second; a jet on the dilated clock would freeze in the corridor and read
// as the effect having broken. main.js steps it with rawDt beside the boss
// explosion, which is on the wall clock for the same reason.
//
// IT HAS A THIRD AXIS, and it is not decoration. The pitch is filmed by an
// orthographic camera, where depth moves nothing on screen — but the goal's
// explosion is the last beat of the instant replay, and a replay is filmed by
// a pool of PERSPECTIVE cameras that swing right through this cloud
// (systems/replayCams.js). Flat on z = 0 it is a cut-out from every angle but
// dead on. So the lobes are born across a narrow band of depth inside the
// corridor — narrow, because the rock has a bore and the squeeze is the whole
// effect — and spread in z once they are clear of it.
//
// ...AND THE SEALS ARE IN THE WAY. The goo thrown back out of the mouth hits
// whoever is standing in the goal, and it used to pass straight through them.
// Each seal is the same CAPSULE the ball collides with (sealSpine in
// systems/ballShape.js), taken as a capsule in three dimensions here, and a
// lobe that ends up inside one is pushed out to its surface and bounced. With
// the third axis under it that means the cloud goes over, under, in front of
// and behind an animal instead of stopping flat against its silhouette.
//
// THE BODIES ARE HANDED IN, never reached for: this module must not import
// the match (systems/versus.js imports IT), and the F panel fires one on an
// empty ocean with no bodies at all.
//
// Nothing here knows about a match: the F panel fires one on an empty ocean.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { claimDriven, releaseDriven, writeDriven, flushDriven, gooGroupIndex, keepGooAlive } from '../entities/particles.js';
import { rockX, mouthHalfHeight, mouthY, tunnelDepth, goalLineDepth, screenEdgeX } from './versusGoal.js';
import { ballTint, teamColor } from './ballLook.js';
// The seal's body, as the ball already collides with it — one description of
// the animal, so goo and ball agree about where it is.
import { sealSpine } from './ballShape.js';

const cfg = () => CONFIG.versus?.goalJet ?? {};
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (range, fallback) => {
  if (Array.isArray(range)) return lerp(range[0], range[1], Math.random());
  return range ?? fallback;
};

/**
 * WHERE THE JET IS BORN, as a depth past the drawn face — DERIVED, never
 * typed. Two lines have to be behind it and both move with the tuning:
 *
 *   the GOAL LINE, because the jet is the goal going off and a lobe born in
 *   front of the line is goo in the corridor before the ball has scored;
 *
 *   the SCREEN'S EDGE, because a lobe born on camera pops into existence in
 *   full view, and the whole point of this effect is that the bang happens
 *   somewhere you cannot see and only its SPRAY comes back out.
 *
 * So: `bornPast` beyond whichever of the two is further out, across a band
 * `bornSpan` deep, and clipped to the tunnel's back so nothing is born
 * inside the rock. It used to be a pair of hand-typed depths, and every one
 * of the three numbers those had to stay behind has been retuned since.
 */
function bornBand(side) {
  const c = cfg();
  const face = rockX(side);
  const line = Math.max(0, goalLineDepth());
  const edge = (screenEdgeX(side) - face) * side;
  const span = Math.max(0, c.bornSpan ?? 5);
  // The nearest the band may start: behind BOTH lines, plus the margin.
  const floor = Math.max(line, edge) + Math.max(0, c.bornPast ?? 2);
  const back = tunnelDepth();
  const deepest = back - 0.5;
  // THE BACK IS THE HARD LIMIT and the floor is the other one, so a tunnel
  // with less room than the band asks for loses the BAND rather than the
  // surprise: the near end stays behind the lines and the span is squeezed.
  // Written the other way round — keeping the span and letting the near end
  // fall wherever — it silently put the front of the jet back on screen the
  // first time the tunnel was shortened, which is what this is.
  const to = Math.min(deepest, floor + span);
  const from = Math.min(to, Math.max(floor, to - span));
  return { from, to, want: span, room: Math.max(0, deepest - floor), squeezed: deepest - floor < span - 1e-6 };
}

/**
 * WHERE THE BANG IS, as a point in the water's plane: the middle of the band
 * the lobes are born across (bornBand), at the height the goal was scored at
 * — clamped into the mouth exactly as fireGoalJet clamps it, so a goal off
 * the lip still explodes inside the corridor.
 *
 * Exported because the goo is not the only thing the explosion throws. The
 * seals standing in front of the hole are shoved away from it (goalBlast in
 * systems/versus.js) and the two have to agree about where "it" is, or the
 * animals fly away from a point the cloud never came out of. Derived from
 * the same band, so retuning where the jet is born moves the shove with it.
 *
 * `out` is reused by the caller — this runs once per goal, but the caller's
 * is a module singleton and there is no reason to hand it a fresh object.
 */
export function goalJetOrigin(side, y = mouthY(), out = { x: 0, y: 0 }) {
  const gy = mouthY();
  const h = mouthHalfHeight();
  const born = bornBand(side);
  out.x = rockX(side) + side * (born.from + born.to) * 0.5;
  out.y = Math.max(gy - h * 0.5, Math.min(gy + h * 0.5, y));
  return out;
}

/**
 * A LOBE'S RADIUS IN WORLD UNITS — what it is worth as a body to the lips and
 * to the other lobes.
 *
 * `size` is NOT a world measurement. It is a multiple of the ball goo group's
 * own splat radius (see the workbench's "lobe size": "the same units as the
 * ball's own splats"), which is 5.5 units where the ball's is tuned — so a
 * lobe of 0.4 draws a blob of a couple of units and a lip clamp on `size`
 * alone held back four tenths of one. That is why the goo poked through the
 * rock: the thing being clamped was a number in one unit system and the wall
 * it was clamped against was in another.
 *
 * `bodyRadius` is the fudge on top of the honest number, because the drawn
 * surface is an ISOLINE through the density field and not the density radius
 * itself — how far out it sits is the group's `iso`, which is tuned on the
 * ball lab and has no business being read here.
 */
function lobeRadius(size) {
  const c = cfg();
  const goo = CONFIG.fx?.goo;
  const splat = goo?.groups?.ball?.radius ?? goo?.radius ?? 3.4;
  return Math.max(0, size) * Math.max(0, splat) * Math.max(0, c.bodyRadius ?? 1);
}

// Every live jet. More than one only when two goals land inside a second
// and a half of each other, which a match cannot do — but the F panel can.
const jets = [];
const _rgb = new THREE.Color();

export const goalJetState = {
  fired: 0,       // jets fired this session, for the harness
  live: 0,        // particles being driven this frame
  // The band the last jet was actually born across (see bornBand) — the
  // workbench reads it, because "born past the trigger" and "across a band"
  // are both requests the tunnel is allowed to refuse and a slider that has
  // quietly stopped doing anything is the worst kind.
  born: { from: 0, to: 0, want: 0, room: 0, squeezed: false },
};

/**
 * Fire the jet out of the goal on `side` (-1 the left wall, +1 the right)
 * at height `y` — the ball's, so the burst comes back out where it went in.
 * Returns the jet, or null when the reserve is empty or the feature is off.
 */
export function fireGoalJet(side, y = mouthY(), team = -1) {
  const c = cfg();
  if (c.enabled === false) return null;
  const count = Math.max(1, Math.round(c.count ?? 36));
  const slots = claimDriven(count);
  if (!slots.length) return null;
  const gy = mouthY();
  const h = mouthHalfHeight();
  const face = rockX(side);
  const born = bornBand(side);
  Object.assign(goalJetState.born, born);
  const spread = Math.max(0, Math.min(1, c.spread ?? 0.9));
  const stagger = Math.max(0, c.stagger ?? 0.3);
  const bore = Math.max(0, c.bore ?? 0.7);
  // The share of the launch speed that goes into depth. Small: the corridor
  // is what aims this thing, and the wide part of the cone is bought at the
  // mouth by `flare` and `zFlare`, not at birth. See the note on `scatter`.
  const zAim = Math.max(0, c.zScatter ?? 0.12);
  // Clamped into the band, so a goal scored off the lip still fires from a
  // point inside the corridor.
  const cy = Math.max(gy - h * 0.5, Math.min(gy + h * 0.5, y));
  const parts = [];
  for (let i = 0; i < slots.length; i++) {
    const size = rand(c.size, 0.4);
    // Born INSIDE the tunnel, past the face by `born` — the edge of the
    // screen is a few units past the face, so this is off it — spread up
    // and down the corridor's height and released over `stagger` seconds so
    // it reads as a jet, not a puff.
    const depth = lerp(born.from, born.to, Math.random());
    const rad = Math.min(h * 0.9, lobeRadius(size));
    const along = (Math.random() - 0.5) * 2 * spread * (h - rad);
    const speed = rand(c.speed, 60);
    // Aimed at the water, with a scatter that the lips will fold back in —
    // and CLAMPED TO WHAT THE CORRIDOR CAN ACTUALLY FOLD.
    //
    // The ceiling is the geometry's, not a number: from this lobe's birth
    // depth, an aim steeper than atan(headroom / depth) puts it into a lip
    // before it ever reaches the opening. Past that the scatter stops buying
    // a wider jet and starts buying a queue at the mouth — lobes that cannot
    // get out, shoved backwards by the ones behind them, the last of them
    // still leaking out after the shutter has left the goal.
    //
    // That is what a birth scatter of 1.15 rad bought: sixty-six degrees in a
    // corridor that folds about half of it. The cone you can SEE is `flare`,
    // added at the mouth where there is no rock left to fold it back in (see
    // updateGoalJets) — which is the mechanism that makes a wide birth
    // scatter unnecessary as well as harmful.
    const headroom = Math.max(0.01, h - rad);
    const canFold = Math.atan2(headroom, Math.max(1, depth));
    const aim = (Math.random() - 0.5) * 2 * Math.min(c.scatter ?? 0.6, canFold);
    // THE THIRD AXIS. Born across the corridor's BORE — the rock has a depth
    // as well as a height and a lobe born outside it is goo inside stone —
    // and given a small outward push in z that only takes effect once it is
    // clear of the mouth (see updateGoalJets). The bore is a share of the
    // mouth's half height rather than a number of its own: the opening is as
    // deep as it is tall unless somebody says otherwise, and one slider
    // moving both is one fewer way for them to disagree.
    const boreR = Math.max(0, h * bore - rad);
    parts.push({
      slot: slots[i],
      x: face + side * depth,
      // ...and never through a lip, wherever the ball went in.
      y: Math.max(gy - h + rad, Math.min(gy + h - rad, cy + along)),
      z: boreR > 0 ? (Math.random() - 0.5) * 2 * boreR : 0,
      vx: -side * speed * Math.cos(aim),
      vy: speed * Math.sin(aim),
      vz: (Math.random() - 0.5) * 2 * speed * zAim,
      age: -Math.random() * stagger,
      life: rand(c.life, 1.2),
      size,
      out: false,
      kicked: false,
    });
  }
  // WHOSE GOAL IT WAS. The jet is the ball's own substance thrown back out of
  // the hole, so it used to come out in the ball's colour — which is right for
  // a ball nobody owns and wrong at the one moment it is most owned. A goal is
  // scored BY somebody, and the thing that comes out of the mouth is that
  // team's. -1 keeps the ball's own colour, which is what the lab fires.
  const jet = { side, parts, group: gooGroupIndex('ball'), t: 0, team };
  jets.push(jet);
  goalJetState.fired += 1;
  return jet;
}

/**
 * THE LOBES PUSH EACH OTHER APART — see CONFIG.versus.goalJet.collide.
 *
 * The cloud fired down the corridor is wider than the opening it has to leave
 * by, and without this it simply passes through itself: thirty-six lobes on
 * thirty-six independent paths, arriving as a thin stream because nothing
 * ever got in anything else's way. Colliding them makes the mass JAM at the
 * mouth and squeeze out of it, which is the whole of the splurt.
 *
 * Written as an acceleration rather than a positional relax so the lips and
 * the nozzle stay the only things that move a lobe outright — a position
 * correction here would fight the lip clamp below and jitter along it.
 *
 * O(n²) on the jet's own parts, which is 630 pairs at the shipped count and
 * nothing at all beside the goo pass this feeds.
 */
function repelParts(jet, c) {
  for (const p of jet.parts) { p.rx = 0; p.ry = 0; p.rz = 0; }
  if ((c.collide ?? true) === false) return;
  const push = Math.max(0, c.collidePush ?? 260);
  if (push <= 0) return;
  const parts = jet.parts;
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (a.slot < 0 || a.age < 0) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j];
      if (b.slot < 0 || b.age < 0) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // IN THREE DIMENSIONS, because the lobes are. Left in two the jam at
      // the mouth would push apart lobes that are already a body's width
      // apart in depth, and the cloud would arrive as a flat fan again the
      // moment the third axis was given anything to do.
      const dz = (b.z ?? 0) - (a.z ?? 0);
      const rr = lobeRadius(a.size) + lobeRadius(b.size);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      // Two lobes on the same point have no direction to part along. Give
      // them one off the index rather than dividing by zero — a NaN here is
      // a lobe that vanishes, and the pair that most needs parting is
      // exactly the pair that has landed on top of each other.
      const nx = d > 1e-4 ? dx / d : Math.cos(i * 2.399);
      const ny = d > 1e-4 ? dy / d : Math.sin(i * 2.399);
      const nz = d > 1e-4 ? dz / d : 0;
      const k = (1 - d / rr) * push;
      a.rx -= nx * k; a.ry -= ny * k; a.rz -= nz * k;
      b.rx += nx * k; b.ry += ny * k; b.rz += nz * k;
    }
  }
}


// The nearest point on a seal's spine, reused: this runs once per lobe per
// body per frame and a fresh object each time is a few thousand a second.
const _spine = { x: 0, y: 0, r: 0 };

/**
 * THE SEALS ARE IN THE WAY — see the header. `bodies` is what matchBodies()
 * in systems/versus.js hands over: a spine position and a heading each, which
 * sealSpine turns into the same capsule the ball collides with.
 *
 * A POSITIONAL PUSH PLUS A BOUNCE, and both are needed. The push is what
 * actually keeps goo out of an animal — an acceleration alone lets a fast
 * lobe cross a whole body in one step and come out the far side — and the
 * bounce is what makes the mass pile up on the near side instead of sliding
 * round and carrying on at full speed.
 *
 * IN THREE DIMENSIONS. The capsule is a segment in the water's plane with a
 * radius around it, so a lobe with depth is only inside it while it is within
 * that radius in z as well: goo passes IN FRONT OF and BEHIND a seal and
 * sticks to the sides of it, which is the wrap.
 */
function collideBodies(p, rad, bodies, rest, pad) {
  for (const b of bodies) {
    sealSpine(b, b.heading ?? null, p.x, p.y, _spine);
    const dx = p.x - _spine.x;
    const dy = p.y - _spine.y;
    const dz = p.z ?? 0;
    // `pad` is the goo's own idea of how fat a seal is, on top of the capsule
    // the BALL uses. The two want different numbers and it would be a mistake
    // to make them share one: the ball's is a contest and has to be the honest
    // animal, and this one is a surface goo lands on, which reads better a
    // little proud of the fur than a little inside it.
    const min = _spine.r + rad + pad;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2);
    // Dead centre of the capsule: no direction to leave along. Out through
    // the side it is nearest in the water's plane rather than a divide by
    // zero — a NaN here is a lobe that vanishes.
    let nx; let ny; let nz;
    if (d > 1e-4) { nx = dx / d; ny = dy / d; nz = dz / d; }
    else { nx = 0; ny = 1; nz = 0; }
    p.x = _spine.x + nx * min;
    p.y = _spine.y + ny * min;
    p.z = nz * min;
    // Only the part of the velocity going INTO the body is turned. The rest
    // is left alone, so a lobe that clipped a flank slides along it and keeps
    // going instead of stopping dead against the animal.
    const into = p.vx * nx + p.vy * ny + (p.vz ?? 0) * nz;
    if (into < 0) {
      const k = into * (1 + rest);
      p.vx -= nx * k;
      p.vy -= ny * k;
      p.vz = (p.vz ?? 0) - nz * k;
    }
  }
}

/** Step every live jet by `dt` wall seconds and write it. Call once a frame. */
export function updateGoalJets(dt, bodies0 = null) {
  if (!jets.length) { goalJetState.live = 0; return; }
  const c = cfg();
  const gy = mouthY();
  const h = mouthHalfHeight();
  const drag = Math.max(0, c.drag ?? 1.6);
  const turb = Math.max(0, c.turbulence ?? 60);
  const turbIn = Math.max(0, c.turbulenceInside ?? 0.35);
  const push = Math.max(0, c.push ?? 120);
  const nozzle = Math.max(0, c.nozzle ?? 4);
  const rest = Math.max(0, Math.min(1, c.restitution ?? 0.55));
  const gravity = c.gravity ?? -3;
  const back = tunnelDepth();
  const burstOut = Math.max(0, c.burstOut ?? 26);
  const flare = Math.max(0, c.flare ?? 0.5);
  // The cone's depth half, added at the mouth for the same reason `flare` is:
  // spread bought inside the corridor is spread the bore and the nozzle take
  // straight back off you.
  const zFlare = Math.max(0, c.zFlare ?? 18);
  const bore = Math.max(0, c.bore ?? 0.7);
  const sealPad = Math.max(0, c.sealPad ?? 0.6);
  const bodies = (c.hitSeals ?? true) !== false && bodies0?.length ? bodies0 : null;
  let live = 0;
  for (let j = jets.length - 1; j >= 0; j--) {
    const jet = jets[j];
    // Per JET, not once for the pass: two goals can be in the air at the same
    // mouth over a rematch, and they are not necessarily the same team's.
    if (jet.team >= 0) _rgb.set(teamColor(jet.team)).multiplyScalar(c.glow ?? 1);
    else ballTint(_rgb).multiplyScalar(c.glow ?? 1);
    const side = jet.side;
    const face = rockX(side);
    repelParts(jet, c);
    let alive = 0;
    for (const p of jet.parts) {
      p.age += dt;
      if (p.age >= p.life) {
        if (p.slot >= 0) { writeDriven(p.slot, 0, 0, 1e6, 1, 0, _rgb, jet.group); releaseDriven(p.slot); p.slot = -1; }
        continue;
      }
      alive++;
      if (p.age < 0) {
        // Not released yet: parked dead until its turn.
        writeDriven(p.slot, p.x, p.y, 1e6, 1, 0, _rgb, jet.group, p.z);
        continue;
      }
      // Inside the corridor? Past the face on the rock's side.
      const inside = side < 0 ? p.x < face : p.x > face;
      // Turbulence: a random walk on the velocity, damped inside the
      // corridor (the walls are doing the work there) and free outside it,
      // which is what makes the cloud tumble once it is clear.
      const tk = turb * (inside ? turbIn : 1) * dt;
      p.vx += (Math.random() - 0.5) * 2 * tk;
      p.vy += (Math.random() - 0.5) * 2 * tk;
      p.vz += (Math.random() - 0.5) * 2 * tk;
      if (inside) {
        // THE SQUEEZE. Driven at the water the whole way down the corridor,
        // and pulled toward the corridor's centre line — a nozzle — so the
        // lot arrives at the mouth together and fast.
        p.vx += -side * push * dt;
        p.vy += (gy - p.y) * nozzle * dt;
        // The nozzle works on the bore too — the corridor squeezes the cloud
        // in depth exactly as it squeezes it in height, and a jet that came
        // out already spread in z would never read as having been forced
        // through an opening at all.
        p.vz += -p.z * nozzle * dt;
      } else {
        p.vy += gravity * dt;
        // OUT OF THE MOUTH, once — the frame a lobe clears the face it is
        // kicked along the way it is going, so the jet leaves the opening
        // with a bang rather than merely stopping being pushed. An EDGE:
        // `kicked` and not `out`, because a lobe shoved back over the face
        // by the crowd behind it would otherwise be kicked again every time
        // it crossed.
        if (!p.kicked) {
          p.kicked = true;
          // THE FLARE — the cone the jet actually leaves by, opened AT THE
          // MOUTH rather than at birth.
          //
          // Aim scatter down the corridor cannot buy a wide cone: a lobe
          // aimed steeper than atan(halfHeight / tunnel) hits a lip before it
          // reaches the opening, and the nozzle spends the whole trip pulling
          // whatever is left back onto the centre line. Both of those are
          // wanted — they are what gets the goo out under pressure — so the
          // spread you can SEE has to be added on the way out, where there is
          // no rock left to fold it back in.
          if (flare > 0) {
            const a = (Math.random() - 0.5) * 2 * flare;
            const ca = Math.cos(a); const sa = Math.sin(a);
            const vx = p.vx * ca - p.vy * sa;
            p.vy = p.vx * sa + p.vy * ca;
            p.vx = vx;
          }
          p.vx += -side * burstOut;
          // ...AND THE CONE OPENS IN DEPTH at the same moment, for the same
          // reason. u/s rather than radians: the two in-plane axes are turned
          // as a pair by `flare` and depth has no pair to turn with.
          if (zFlare > 0) p.vz += (Math.random() - 0.5) * 2 * zFlare;
        }
        p.out = true;
      }
      p.vx += p.rx * dt;
      p.vy += p.ry * dt;
      p.vz += p.rz * dt;
      const k = Math.exp(-drag * dt * (inside ? 0.35 : 1));
      p.vx *= k;
      p.vy *= k;
      p.vz *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      // THE LOBE'S BODY, not its splat centre — see lobeRadius. Capped at
      // most of the half height so a lobe fatter than the corridor is pinned
      // to the centre line rather than clamped to a band that has turned
      // inside out. Hoisted out of the corridor branch because the seals want
      // the same number.
      const rad = Math.min(h * 0.9, lobeRadius(p.size));
      if (side < 0 ? p.x < face : p.x > face) {
        // THE LIPS. A body in the corridor bounces off its floor and ceiling
        // — the same two lines the ball bounces off — and off the tunnel's
        // back, so nothing is lost behind the rock.
        const top = gy + h - rad;
        const bot = gy - h + rad;
        if (p.y > top) { p.y = top; if (p.vy > 0) p.vy = -p.vy * rest; }
        else if (p.y < bot) { p.y = bot; if (p.vy < 0) p.vy = -p.vy * rest; }
        // THE BORE — the same two walls again, in depth. The corridor is cut
        // through rock and has a far side and a near one; without this the
        // cloud would spread in z INSIDE the stone and come out of the mouth
        // already the width of the wall.
        const boreR = Math.max(0, h * bore - rad);
        if (p.z > boreR) { p.z = boreR; if (p.vz > 0) p.vz = -p.vz * rest; }
        else if (p.z < -boreR) { p.z = -boreR; if (p.vz < 0) p.vz = -p.vz * rest; }
        const backX = face + side * back;
        if (side < 0 ? p.x < backX : p.x > backX) { p.x = backX; p.vx = -side * Math.abs(p.vx) * rest; }
      } else if (bodies) {
        // OUT IN THE WATER, WHERE THE SEALS ARE. Only out here: nothing can
        // be standing inside the rock, and a body check against every lobe
        // for the whole trip down the corridor is work done to find nothing.
        collideBodies(p, rad, bodies, rest, sealPad);
      }
      // Fades over its life, the way an emitted particle's sprite does —
      // the size is what the goo pass reads as density, so a lobe shrinking
      // to nothing is a lobe dissolving into the water.
      const t = p.age / p.life;
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      writeDriven(p.slot, p.x, p.y, 0, 1, p.size * fade, _rgb, jet.group, p.z);
    }
    live += alive;
    if (!alive) jets.splice(j, 1);
  }
  goalJetState.live = live;
  flushDriven();
  if (live) keepGooAlive('ball', 0.25);
}

/** Take every jet down at once — a match reset, or the F panel firing again. */
export function resetGoalJets() {
  for (const jet of jets) for (const p of jet.parts) if (p.slot >= 0) releaseDriven(p.slot);
  jets.length = 0;
  goalJetState.live = 0;
}

/** The live jets, for the harness. */
export function goalJets() { return jets; }
