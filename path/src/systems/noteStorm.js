import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createInstancedPool } from './instancedPool.js';

// ===========================================================================
// THE NOTE FIELD — every music note on screen, in eight draw calls.
//
// Two effects share this, because they are the same thing at two lifetimes:
//
//   a BURST   thrown once and left to fly, for the moment a note lands and a
//             creature is charmed. The storm.
//   an AURA   bound to a creature for as long as its charm lasts, orbiting it.
//
// Splitting them would mean two pools, two glyph loads and two flushes for one
// ability's worth of notes. They differ by which of two position functions runs
// each frame, and that is not a system boundary.
//
// GLYPHS, NOT A BAKED CLIP. public/models/musicnotes.glb holds eight note
// shapes lifted out of the Particle Flow source (tools/note-glyphs.mjs — read
// its header for why the source's own 4-second animation is unusable). Eight
// separate geometries rather than one merged mesh is forced by the instancing:
// an InstancedMesh varies the transform and the colour between instances and
// nothing else, so a glyph is a group and 199 notes of mixed shape still cost
// eight draws.
//
// COLOUR IS PER INSTANCE, and that is the whole reason this is instanced at
// all rather than a pool of cloned Meshes. createVisual caches ONE material per
// asset key, so a charmed shark tinting its notes violet would tint every note
// in the game violet, including the ones in flight from the harp — see the note
// in assets.js and [[primitive-assets-share-one-material]]. instanceColor is
// the only per-note colour that exists here.
//
// The hue is rolled per HOST, not per note: a charmed body wears one colour so
// that two grinders standing near each other stay readable as two. See
// rollNoteColor for why the roll normalises on the peak channel instead of just
// picking a random hex.
// ===========================================================================

// The glyph set, loaded once. Geometries only — this system never wants a built
// visual, and going through createVisual would hand back a Mesh whose material
// is shared with every other copy, which is the thing being avoided.
let GLYPHS = null;
let pending = null;

/**
 * Fetch and keep the eight note geometries. Idempotent, and safe to call before
 * or after the field exists: a field with no glyphs draws nothing and throws
 * nothing, so a burst fired during the load is simply lost rather than fatal.
 */
export function loadNoteGlyphs(url = '/models/musicnotes.glb') {
  if (GLYPHS) return Promise.resolve(GLYPHS);
  if (!pending) {
    pending = new GLTFLoader().loadAsync(url).then((gltf) => {
      const out = [];
      gltf.scene.traverse((o) => { if (o.isMesh) out.push(o.geometry); });
      GLYPHS = out;
      return out;
    });
  }
  return pending;
}

/** For harnesses and the look page: hand in geometries parsed some other way. */
export function installNoteGlyphs(geometries) {
  GLYPHS = geometries;
  pending = Promise.resolve(geometries);
}

export function noteGlyphCount() {
  return GLYPHS?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const _c = new THREE.Color();

const REC709 = [0.2126, 0.7152, 0.0722];
const luminance = (c) => REC709[0] * c.r + REC709[1] * c.g + REC709[2] * c.b;

/**
 * Roll the colour one charmed body's notes will wear.
 *
 * THE HARD PART IS NOT PICKING A HUE, it is that a random hue does not bloom.
 * The bright pass thresholds Rec.709 LUMINANCE, where green is worth 0.7152 and
 * blue 0.0722. A fully saturated blue and a fully saturated green at the same
 * VALUE are a factor of ten apart in luminance, so a field of randomly hued
 * notes comes out as some notes blazing with a halo and others sitting flat and
 * dark — which reads as a bug, not as variety. Measured on this project's own
 * settings (threshold 0.58): twelve evenly spaced hues span 6.3x in luminance,
 * and five of the twelve never cross the threshold at all.
 *
 * Normalising on the PEAK CHANNEL does not fix it, which is the trap: HSL at
 * lightness 0.5 already has a constant peak for every hue, so peak-normalising
 * is very nearly a no-op and leaves the same 6.3x spread. (Peak is still the
 * right normalisation for a DIFFERENT question — not clipping at the composite;
 * see the knee in systems/post.js.)
 *
 * THE CHOSEN FIX IS TO RESTRICT THE WHEEL. `NOTE_HUES` is the arc where full
 * saturation blooms honestly, measured rather than picked: over hue 0.08..0.50
 * — amber, yellow, lime, green, spring, cyan — luminance runs 1.12 to 1.77, a
 * 1.57x spread with nothing within twice the threshold of dying. Outside it,
 * hue 0.68 (blue) sits at 0.28 and never blooms at all. The cost is real and
 * deliberate: no red, blue, violet or magenta notes. What is bought is that
 * every hue that DOES come up is fully saturated, so a charmed body's colour is
 * a strong one rather than a pastel, and the arc also keeps the notes off the
 * water's own dark blue.
 *
 * The other two modes stay, because they are the two ways to get the whole
 * wheel back if that trade is ever revisited:
 *
 *   'lum'   keep the saturation and scale until the luminance hits the target.
 *           Hue is exact and the HALO is strongly coloured; the cost is that a
 *           blue needs a peak channel near 10 and its core goes white through
 *           the knee.
 *   'even'  solve for the SATURATION at which this hue reaches `lumTarget`
 *           while its peak channel is still at or under `glow`. Every hue
 *           blooms identically and nothing clips; the cost is pastel — a blue
 *           lands near s=0.17 and reads as ice rather than as royal blue.
 *
 * `hues` overrides the arc. Passing `[0, 1]` with the default mode is the naive
 * roll, and is what the look page renders to show the problem.
 */
export const NOTE_HUES = [0.08, 0.50];

export function rollNoteColor(rng = Math.random, {
  glow = 1.9, lumTarget = 1.4, saturation = 0.85, hues = NOTE_HUES, mode = 'peak',
} = {}) {
  const h = (hues ? hues[0] + rng() * (hues[1] - hues[0]) : rng()) % 1;

  if (mode === 'even') {
    // The hue at full saturation and lightness 0.5. Every less-saturated
    // version of it is a straight lerp from mid grey, which is what makes the
    // solve a line rather than a search:
    //     c(s)    = 0.5 + s * (h1 - 0.5)
    //     peak(s) = 0.5 + 0.5s          (the top channel of h1 is always 1)
    //     lum(s)  = 0.5 + s * (L1 - 0.5)
    // Scaling by k = glow/peak(s) afterwards, the final luminance is
    // glow * lum(s)/peak(s), so asking for `lumTarget` is asking for
    // lum(s)/peak(s) = q, one equation in s.
    _c.setHSL(h, 1, 0.5);
    const L1 = luminance(_c);
    const q = lumTarget / glow;
    const denom = 0.5 + 0.5 * q - L1;
    // denom <= 0 is a hue already brighter at full saturation than the target
    // asks for — the yellows. They stay fully saturated and take a smaller
    // multiplier instead, which is the `min` below.
    const s = denom > 1e-4 ? Math.min(1, Math.max(0, (0.5 - 0.5 * q) / denom)) : 1;
    const r = 0.5 + s * (_c.r - 0.5);
    const g = 0.5 + s * (_c.g - 0.5);
    const b = 0.5 + s * (_c.b - 0.5);
    const k = Math.min(glow / Math.max(r, g, b), lumTarget / (REC709[0] * r + REC709[1] * g + REC709[2] * b));
    return { r: r * k, g: g * k, b: b * k };
  }

  _c.setHSL(h, saturation, 0.5);
  const k = mode === 'lum'
    ? lumTarget / (luminance(_c) || 1)
    : glow / (Math.max(_c.r, _c.g, _c.b) || 1);
  return { r: _c.r * k, g: _c.g * k, b: _c.b * k };
}

// ---------------------------------------------------------------------------
// Motion presets
// ---------------------------------------------------------------------------

/**
 * How a burst throws its notes. One integrator reads all of these, so an option
 * here is a row of numbers and never a branch — which is what makes them
 * mixable and what will make them tuner rows if one of them is chosen.
 *
 *   spread     half-angle of the launch fan, radians. PI is a full circle.
 *   aim        centre of that fan, radians. PI/2 is straight up.
 *   speed      launch speed, world units/sec, jittered by +/- `speedVary`.
 *   swirl      tangential speed added at launch — the corkscrew.
 *   rise       constant upward acceleration. Buoyancy, not gravity: notes in
 *              water float, and a note that fell would read as debris.
 *   drag       fraction of speed shed per second.
 *   sway       sideways sine displacement, amplitude in world units.
 *   swayRate   radians/sec of that sine.
 *   spin       radians/sec the glyph tumbles about the camera axis.
 *   depth      how far into/out of the screen the fan scatters.
 *   life       seconds, jittered by +/- `lifeVary` as a fraction.
 */
export const BURST_PRESETS = {
  // A chord struck. Everything leaves at once in every direction and slows
  // hard — the shape is a ring that stops, which is what makes the moment of
  // the charm land rather than reading as a continuous emitter.
  bloom: {
    spread: Math.PI, aim: Math.PI / 2, speed: 7.5, speedVary: 0.45, swirl: 0,
    rise: 2.2, drag: 2.4, sway: 0.25, swayRate: 5, spin: 2.6, depth: 1.2,
    life: 1.05, lifeVary: 0.3,
  },
  // Music going up out of the animal. Slow, narrow, and the sway is doing most
  // of the work — the notes wander as they climb instead of tracking straight.
  updraft: {
    spread: 0.5, aim: Math.PI / 2, speed: 3.2, speedVary: 0.5, swirl: 0,
    rise: 3.4, drag: 0.9, sway: 0.75, swayRate: 3.1, spin: 1.4, depth: 1.6,
    life: 1.6, lifeVary: 0.25,
  },
  // The same outward throw as `bloom` with a tangential kick, so the field
  // turns as it expands. Reads loudest of the four in a crowd and is the one
  // most likely to fight the aura ring spinning underneath it.
  spiral: {
    spread: Math.PI, aim: Math.PI / 2, speed: 5.5, speedVary: 0.35, swirl: 6.5,
    rise: 1.8, drag: 1.9, sway: 0.15, swayRate: 6, spin: 4.2, depth: 1.0,
    life: 1.25, lifeVary: 0.25,
  },
  // A phrase played out sideways: a narrow fan thrown across the screen, which
  // is the one option that echoes what the source file actually baked (a
  // travelling source laying a line of notes down behind it).
  fanfare: {
    spread: 0.62, aim: 0, speed: 9.5, speedVary: 0.55, swirl: 1.2,
    rise: 3.0, drag: 2.0, sway: 0.3, swayRate: 4.2, spin: 3.0, depth: 0.9,
    life: 1.15, lifeVary: 0.3,
  },
};

/**
 * How an aura arranges its notes around the body carrying it.
 *
 *   kind       'ring' | 'swarm' | 'staff'
 *   spin       radians/sec the arrangement turns (or scrolls, for a staff)
 *   tilt       fraction of the radius the ring swings through DEPTH, so it
 *              reads as a circle around the animal and not as a flat halo
 *   squash     vertical fraction of the radius — the side-on view of a ring
 *              lying flat is an ellipse, and 1.0 would be a wheel
 *   bob        world units a note rises and falls over its own cycle
 *   radiusMin  swarm only: inner edge as a fraction of the aura radius
 *   heights    swarm only: vertical scatter as a fraction of the radius
 *   lines      staff only: how many horizontal lines the notes sit on
 */
export const AURA_PRESETS = {
  // What ships today, with real glyphs in place of the oval bead. Even spacing
  // is the most legible statement of "this radius is what hurts" — you can
  // count the notes and see the circle.
  ring: { kind: 'ring', spin: 2.4, tilt: 0.5, squash: 0.6, bob: 0.35 },
  // The storm answer: notes at scattered radii, heights and speeds, so the body
  // sits inside a churn rather than inside a wheel. Costs the read of the exact
  // radius — the outer notes ARE on it, but nothing lines them up.
  swarm: {
    kind: 'swarm', spin: 1.5, tilt: 0.7, squash: 0.85, bob: 0.55,
    radiusMin: 0.45, heights: 0.55, speedVary: 0.8,
  },
  // Notes riding five staff lines that scroll horizontally through the animal
  // and wrap. The only option that says MUSIC rather than "glowing things", and
  // the only one whose silhouette doesn't collide with the shrimp ring's.
  staff: { kind: 'staff', spin: 1.6, tilt: 0.35, squash: 0.75, bob: 0.12, lines: 5 },
};

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {object} opts
 *   max      hard cap on live notes. Past it, a burst is trimmed rather than
 *            dropped — a storm that thins out under load still reads as a
 *            storm, where one that vanishes reads as a bug.
 *   rng      seeded in harnesses so a burst is reproducible.
 */
export function createNoteField(scene, { max = 320, rng = Math.random } = {}) {
  const pool = createInstancedPool(scene, 'notes');
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    // The glyphs are flat single-sided planes. A note tumbling about the camera
    // axis never turns away, but one in a burst with `depth` scatter does, and
    // a note that disappears for half its life reads as a flicker bug.
    side: THREE.DoubleSide,
    transparent: false,
    toneMapped: false,
  });
  // Live notes. A plain array with swap-removal rather than a free list: the
  // pool underneath already swap-removes, and keeping the two in the same order
  // is what lets a note's slot be found without a second index.
  const notes = [];

  // Uniform over the eight shapes rather than weighted by how often the bake
  // used each one: the source's mix is an artefact of one Particle Flow run, and
  // an even draw is what puts a beamed triple in every handful.
  function glyphFor() {
    return GLYPHS[Math.floor(rng() * GLYPHS.length) % GLYPHS.length] ?? GLYPHS[0];
  }

  function take(color) {
    if (!GLYPHS?.length || notes.length >= max) return null;
    const mesh = new THREE.Mesh(glyphFor(), material);
    pool.acquire(mesh);
    // Written through the pool, never onto the material — see the header. And
    // through setColorRGB rather than setColor: rollNoteColor returns channels
    // ABOVE 1 on purpose, and a hex round-trip would clamp away exactly the
    // headroom that gives the note its halo.
    pool.setColorRGB(mesh, color.r, color.g, color.b);
    const n = {
      mesh, t: 0, life: 1, scale: 1, baseScale: 1, spin: 0, rot: 0,
      // The colour it was born with, kept so heatHost can brighten it and put
      // it back. Copied rather than referenced: the caller's object is one
      // shared roll handed to every note in the ring.
      color: { r: color.r, g: color.g, b: color.b },
      tint: 1,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      host: null, phase: 0, radius: 0, height: 0, rate: 1, preset: null, lane: 0,
    };
    notes.push(n);
    return n;
  }

  function drop(i) {
    const n = notes[i];
    pool.release(n.mesh);
    notes[i] = notes[notes.length - 1];
    notes.pop();
  }

  /**
   * Throw a one-shot storm from a point.
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {object} o  { count, color, preset, scale, radius }
   *   `radius` scatters the launch points over a disc rather than starting
   *   every note at one pixel — a burst from a shark should leave the whole
   *   animal at once, not its centre of mass.
   */
  function burst(x, y, z, {
    count = 18, color = { r: 1, g: 1, b: 1 }, preset = 'bloom', scale = 0.5, radius = 0,
  } = {}) {
    const p = typeof preset === 'string' ? BURST_PRESETS[preset] : preset;
    if (!p) return 0;
    let made = 0;
    for (let i = 0; i < count; i++) {
      const n = take(color);
      if (!n) break;
      const a = p.aim + (rng() * 2 - 1) * p.spread;
      const speed = p.speed * (1 + (rng() * 2 - 1) * p.speedVary);
      // Tangential to the launch direction, so `swirl` curls the whole fan the
      // same way instead of scattering it.
      const tx = -Math.sin(a); const ty = Math.cos(a);
      n.preset = p;
      n.t = 0;
      n.life = p.life * (1 + (rng() * 2 - 1) * p.lifeVary);
      n.x = x + (rng() * 2 - 1) * radius;
      n.y = y + (rng() * 2 - 1) * radius;
      n.z = z + (rng() * 2 - 1) * p.depth;
      n.vx = Math.cos(a) * speed + tx * p.swirl;
      n.vy = Math.sin(a) * speed + ty * p.swirl;
      n.vz = (rng() * 2 - 1) * p.depth;
      n.spin = (rng() < 0.5 ? -1 : 1) * p.spin * (0.6 + rng() * 0.8);
      n.rot = rng() * Math.PI * 2;
      n.phase = rng() * Math.PI * 2;
      n.baseScale = scale * (0.75 + rng() * 0.5);
      n.host = null;
      made++;
    }
    return made;
  }

  /**
   * Bind a set of notes to a creature for as long as it carries an aura.
   *
   * The notes read `host.mesh.position` every frame rather than being moved by
   * whoever moves the host, so a charmed body that is being shoved, killed or
   * teleported keeps its ring attached without anything else knowing this
   * exists. They are dropped the frame `alive(host)` goes false.
   */
  function attach(host, {
    count = 5, color = { r: 1, g: 1, b: 1 }, preset = 'ring', scale = 0.55, radius = 3.4,
  } = {}) {
    const p = typeof preset === 'string' ? AURA_PRESETS[preset] : preset;
    if (!p) return 0;
    let made = 0;
    for (let i = 0; i < count; i++) {
      const n = take(color);
      if (!n) break;
      n.preset = p;
      n.host = host;
      n.t = 0;
      n.life = Infinity;
      n.baseScale = scale;
      n.rot = rng() * Math.PI * 2;
      n.spin = 0;
      if (p.kind === 'swarm') {
        n.phase = rng() * Math.PI * 2;
        n.radius = radius * (p.radiusMin + rng() * (1 - p.radiusMin));
        n.height = (rng() * 2 - 1) * radius * p.heights;
        n.rate = 1 + (rng() * 2 - 1) * p.speedVary;
      } else if (p.kind === 'staff') {
        n.lane = i % p.lines;
        // Spread along the line rather than stacked, so a five-note staff shows
        // five notes crossing rather than one column of five.
        n.phase = (i / count) * Math.PI * 2;
        n.radius = radius;
        n.height = ((n.lane / (p.lines - 1)) - 0.5) * radius * 0.9;
        n.rate = 1;
      } else {
        n.phase = (i / count) * Math.PI * 2;
        n.radius = radius;
        n.height = 0;
        n.rate = 1;
      }
      made++;
    }
    return made;
  }

  /** Drop every note bound to this host. */
  function detach(host) {
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].host === host) drop(i);
  }

  /**
   * @param {number} dt
   * @param {(host:any)=>boolean} alive  asked once per bound note; a host that
   *   answers false has its notes dropped this frame. Passed in rather than
   *   read off the creature so this file never learns what a creature is.
   */
  function update(dt, alive = () => true) {
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      n.t += dt;

      if (n.host) {
        if (!alive(n.host) || !n.host.mesh?.parent) { drop(i); continue; }
        placeBound(n, dt);
      } else {
        if (n.t >= n.life) { drop(i); continue; }
        placeFree(n, dt);
      }

      // Scale, not opacity. Every note shares one material, so a fade would
      // fade the whole field — the same constraint the aura ring already works
      // under. A note shrinking to nothing reads as it going quiet.
      const mesh = n.mesh;
      mesh.position.set(n.x, n.y, n.z);
      mesh.rotation.z = n.rot;
      mesh.scale.setScalar(n.baseScale * n.scale);
    }
    pool.flush();
  }

  function placeFree(n, dt) {
    const p = n.preset;
    const k = Math.exp(-p.drag * dt);
    n.vx *= k; n.vy *= k; n.vz *= k;
    n.vy += p.rise * dt;
    n.x += (n.vx + Math.cos(n.t * p.swayRate + n.phase) * p.sway) * dt;
    n.y += n.vy * dt;
    n.z += n.vz * dt;
    n.rot += n.spin * dt;
    // In fast, out slow: a note is at full size within a fifth of its life and
    // spends the rest shrinking. The pop is what sells the pluck.
    const f = n.t / n.life;
    n.scale = f < 0.18 ? f / 0.18 : 1 - ((f - 0.18) / 0.82) ** 2;
  }

  function placeBound(n, dt) {
    const p = n.preset;
    const hp = n.host.mesh.position;
    if (p.kind === 'staff') {
      // A scroll, not an orbit. The note crosses the body from one side to the
      // other on its lane and wraps, and `spin` is how fast it crosses.
      const u = ((n.t * p.spin * n.rate + n.phase) / (Math.PI * 2)) % 1;
      n.x = hp.x + (u * 2 - 1) * n.radius;
      n.y = hp.y + n.height + Math.sin(n.t * 3 + n.phase) * p.bob;
      n.z = hp.z + Math.sin(u * Math.PI) * n.radius * p.tilt;
      n.rot = Math.sin(n.t * 1.6 + n.phase) * 0.25;
      // Fade in and out at the ends of the pass instead of popping at the wrap.
      n.scale = Math.sin(u * Math.PI) ** 0.5;
      return;
    }
    const a = n.t * p.spin * n.rate + n.phase;
    n.x = hp.x + Math.cos(a) * n.radius;
    n.y = hp.y + Math.sin(a) * n.radius * p.squash + n.height
      + Math.sin(n.t * 2.6 + n.phase) * p.bob;
    n.z = hp.z + Math.sin(a) * n.radius * p.tilt;
    // Tumbling on its own axis rather than facing anywhere — a note is a glyph,
    // and one pointing carefully at something reads as a projectile.
    n.rot = a * 0.5;
    n.scale = 1;
  }

  /**
   * Set the size of every note bound to this host. The aura shrinking away over
   * its last beat, and the only lever available: a fade would have to go through
   * the material every note shares.
   */
  function scaleHost(host, scale) {
    for (const n of notes) if (n.host === host) n.baseScale = scale;
  }

  /**
   * Brighten every note bound to this host — the ring going hot while it is
   * actually grinding something (systems/damageGlow.js).
   *
   * Through the POOL's per-instance colour, which is why this is possible at
   * all: every note shares one material, so anything written there would
   * brighten the whole field including the notes still in flight from other
   * hosts. instanceColor is the one per-note channel there is, and the
   * multiplier rides on the note's own rolled colour so a hot ring is a
   * brighter version of itself rather than a wash toward white.
   *
   * Written only when the multiplier actually moved: this runs per host per
   * frame, and a ring that has been sitting cold for four seconds should not
   * be paying for a buffer upload to say so.
   */
  function heatHost(host, mul) {
    const m = Math.max(0, mul);
    for (const n of notes) {
      if (n.host !== host || n.tint === m) continue;
      n.tint = m;
      pool.setColorRGB(n.mesh, n.color.r * m, n.color.g * m, n.color.b * m);
    }
  }

  function reset() {
    for (let i = notes.length - 1; i >= 0; i--) drop(i);
  }

  function dispose() {
    pool.reset();
    notes.length = 0;
    material.dispose();
  }

  return {
    burst, attach, detach, update, reset, dispose, scaleHost, heatHost,
    stats: pool.stats,
    get count() { return notes.length; },
    _notes: notes,
  };
}
