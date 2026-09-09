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
import { rockX, mouthHalfHeight, mouthY, tunnelDepth } from './versusGoal.js';
import { ballTint } from './ballLook.js';

const cfg = () => CONFIG.versus?.goalJet ?? {};
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (range, fallback) => {
  if (Array.isArray(range)) return lerp(range[0], range[1], Math.random());
  return range ?? fallback;
};

// Every live jet. More than one only when two goals land inside a second
// and a half of each other, which a match cannot do — but the F panel can.
const jets = [];
const _rgb = new THREE.Color();

export const goalJetState = {
  fired: 0,       // jets fired this session, for the harness
  live: 0,        // particles being driven this frame
};

/**
 * Fire the jet out of the goal on `side` (-1 the left wall, +1 the right)
 * at height `y` — the ball's, so the burst comes back out where it went in.
 * Returns the jet, or null when the reserve is empty or the feature is off.
 */
export function fireGoalJet(side, y = mouthY()) {
  const c = cfg();
  if (c.enabled === false) return null;
  const count = Math.max(1, Math.round(c.count ?? 36));
  const slots = claimDriven(count);
  if (!slots.length) return null;
  const gy = mouthY();
  const h = mouthHalfHeight();
  const face = rockX(side);
  const born = c.born ?? [4, 10];
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
    const depth = rand(born, 6);
    const along = (Math.random() - 0.5) * 2 * spread * (h - size);
    const speed = rand(c.speed, 60);
    // Aimed at the water, with a scatter that the lips will fold back in.
    const aim = (Math.random() - 0.5) * 2 * (c.scatter ?? 0.6);
    parts.push({
      slot: slots[i],
      x: face + side * depth,
      // ...and never through a lip, wherever the ball went in.
      y: Math.max(gy - h + size, Math.min(gy + h - size, cy + along)),
      vx: -side * speed * Math.cos(aim),
      vy: speed * Math.sin(aim),
      age: -Math.random() * stagger,
      life: rand(c.life, 1.2),
      size,
      out: false,
    });
  }
  const jet = { side, parts, group: gooGroupIndex('ball'), t: 0 };
  jets.push(jet);
  goalJetState.fired += 1;
  return jet;
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
  ballTint(_rgb).multiplyScalar(c.glow ?? 1);
  let live = 0;
  for (let j = jets.length - 1; j >= 0; j--) {
    const jet = jets[j];
    const side = jet.side;
    const face = rockX(side);
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
        p.out = true;
      }
      const k = Math.exp(-drag * dt * (inside ? 0.35 : 1));
      p.vx *= k;
      p.vy *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (side < 0 ? p.x < face : p.x > face) {
        // THE LIPS. A body in the corridor bounces off its floor and ceiling
        // — the same two lines the ball bounces off — and off the tunnel's
        // back, so nothing is lost behind the rock.
        const top = gy + h - p.size;
        const bot = gy - h + p.size;
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
