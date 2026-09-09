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
// Nothing here knows about a match: the F panel fires one on an empty ocean.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { claimDriven, releaseDriven, writeDriven, flushDriven, gooGroupIndex, keepGooAlive } from '../entities/particles.js';
import { rockX, mouthHalfHeight, mouthY, tunnelDepth, goalLineDepth, screenEdgeX } from './versusGoal.js';
import { ballTint, teamColor } from './ballLook.js';

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
    // Aimed at the water, with a scatter that the lips will fold back in.
    const aim = (Math.random() - 0.5) * 2 * (c.scatter ?? 0.6);
    parts.push({
      slot: slots[i],
      x: face + side * depth,
      // ...and never through a lip, wherever the ball went in.
      y: Math.max(gy - h + rad, Math.min(gy + h - rad, cy + along)),
      vx: -side * speed * Math.cos(aim),
      vy: speed * Math.sin(aim),
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
  for (const p of jet.parts) { p.rx = 0; p.ry = 0; }
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
      const rr = lobeRadius(a.size) + lobeRadius(b.size);
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      // Two lobes on the same point have no direction to part along. Give
      // them one off the index rather than dividing by zero — a NaN here is
      // a lobe that vanishes, and the pair that most needs parting is
      // exactly the pair that has landed on top of each other.
      const nx = d > 1e-4 ? dx / d : Math.cos(i * 2.399);
      const ny = d > 1e-4 ? dy / d : Math.sin(i * 2.399);
      const k = (1 - d / rr) * push;
      a.rx -= nx * k; a.ry -= ny * k;
      b.rx += nx * k; b.ry += ny * k;
    }
  }
}

/** Step every live jet by `dt` wall seconds and write it. Call once a frame. */
export function updateGoalJets(dt) {
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
        writeDriven(p.slot, p.x, p.y, 1e6, 1, 0, _rgb, jet.group);
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
      if (inside) {
        // THE SQUEEZE. Driven at the water the whole way down the corridor,
        // and pulled toward the corridor's centre line — a nozzle — so the
        // lot arrives at the mouth together and fast.
        p.vx += -side * push * dt;
        p.vy += (gy - p.y) * nozzle * dt;
      } else {
        p.vy += gravity * dt;
        // OUT OF THE MOUTH, once — the frame a lobe clears the face it is
        // kicked along the way it is going, so the jet leaves the opening
        // with a bang rather than merely stopping being pushed. An EDGE:
        // `kicked` and not `out`, because a lobe shoved back over the face
        // by the crowd behind it would otherwise be kicked again every time
        // it crossed.
        if (!p.kicked) { p.kicked = true; p.vx += -side * burstOut; }
        p.out = true;
      }
      p.vx += p.rx * dt;
      p.vy += p.ry * dt;
      const k = Math.exp(-drag * dt * (inside ? 0.35 : 1));
      p.vx *= k;
      p.vy *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (side < 0 ? p.x < face : p.x > face) {
        // THE LIPS. A body in the corridor bounces off its floor and ceiling
        // — the same two lines the ball bounces off — and off the tunnel's
        // back, so nothing is lost behind the rock.
        // THE LIPS HOLD THE LOBE'S BODY BACK, not its splat centre — see
        // lobeRadius. Capped at most of the half height so a lobe fatter
        // than the corridor is pinned to the centre line rather than
        // clamped to a band that has turned inside out.
        const rad = Math.min(h * 0.9, lobeRadius(p.size));
        const top = gy + h - rad;
        const bot = gy - h + rad;
        if (p.y > top) { p.y = top; if (p.vy > 0) p.vy = -p.vy * rest; }
        else if (p.y < bot) { p.y = bot; if (p.vy < 0) p.vy = -p.vy * rest; }
        const backX = face + side * back;
        if (side < 0 ? p.x < backX : p.x > backX) { p.x = backX; p.vx = -side * Math.abs(p.vx) * rest; }
      }
      // Fades over its life, the way an emitted particle's sprite does —
      // the size is what the goo pass reads as density, so a lobe shrinking
      // to nothing is a lobe dissolving into the water.
      const t = p.age / p.life;
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      writeDriven(p.slot, p.x, p.y, 0, 1, p.size * fade, _rgb, jet.group);
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
