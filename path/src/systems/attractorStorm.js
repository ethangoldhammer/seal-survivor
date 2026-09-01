// ===========================================================================
// ATTRACTOR STORMS — six candidate bullet-hell attacks, staged for judging.
// ===========================================================================
// TWO DOORS, and which one a study comes through is the design decision:
//
//   AS A BOSS PERK — `saddle`, `ring`, `echo` and `release`. Four rows in
//   bossPerks.csv sharing these ids, rolled onto ordinary bosses exactly as
//   the eye beam and the electric aura are. The field is anchored on the animal
//   and rides it, which is what makes it that boss's attack rather than
//   scenery it happens to be standing in. See updateStorm in bossPerks.js.
//
//   FROM THE U PANEL — all six, staged by hand with no boss involved. Still
//   the only door for the two Thomas studies (`lattice` and `swarm`): one is a
//   whole arena and one is a body, and both are a BOSS rather than a thing a
//   boss does, so neither is a perk and both are waiting on an archetype.
//
// The panel door exists for the four perks too, and not merely as a leftover:
// a perk arrives on a cooldown deep in a fight, and "open it now, on this boss,
// and let me swim at it" is how you actually judge whether a shape teaches the
// player anything.
//
// attractorStorms.csv holds the six rows and what each one's numbers mean;
// systems/attractors.js holds the three systems. This file is what turns a
// field into an attack, and there are only four ideas in it:
//
//   THE STATE IS THE BULLET. Every cube carries its own (x, y, z) through the
//   attractor and its world position is that state projected. The bait ball
//   does the opposite — it samples the flow where a fish is standing and keeps
//   no state — and the difference is the whole point here: the folding, the
//   lobe switch and the sensitive dependence are properties of a TRAJECTORY,
//   and a thing with no history has none of them.
//
//   TWO AXES ON SCREEN, THE THIRD HIDDEN. Collision in this game is planar
//   everywhere, so the projection is not a stylistic choice — a cube has to
//   live in the plane the hit test reads. The third coordinate keeps being
//   integrated and is what stops the motion repeating. It also buys a second
//   attack for free: `ring` and `release` are one Aizawa field seen down two
//   different axes, and one is a hollow ring while the other is a shell.
//
//   SPEED IS CLAMPED, PATH IS NOT. These systems run wildly different speeds in
//   different regions — Lorenz is about forty times faster at a wing rim than
//   at the saddle. Left alone that is not "dynamic", it is a stationary wall of
//   cubes in the slow parts and shots that cross the arena inside one frame in
//   the fast parts. The clamp shortens the INTEGRATION STEP rather than the
//   move, so the trajectory is exactly the one that was drawn and only its
//   timing changes.
//
//   THE SCAFFOLD IS THE TELL. Two of the six are unreadable without the field
//   being visible — a lattice whose channels you cannot see is noise, and a
//   very fast curved bullet is unfair unless its curve was shown first. So the
//   storm can draw its own streamlines as lines in the water.
//
// WHY THE CUBES GO THROUGH spawnProjectile. They are enemy bullets and there is
// already exactly one thing in this game that means "an enemy bullet": it hits
// the seal through combat.js's enemy-bullets-vs-player pass, with the same
// i-frames a bite gets, and it is culled by the arena, the life clock and the
// death of the run without this file knowing. A parallel list of hostile boxes
// would be a second set of all of that, and the second set is the one that gets
// the i-frame rule wrong.
// ===========================================================================

import * as THREE from 'three';
import { spawnProjectile, projectiles } from '../entities/projectiles.js';
import { attractorDeriv, stepAttractor } from './attractors.js';
import { parseAttractorStormCsv } from '../attractorStormTable.js';
import stormsCsv from '../attractorStorms.csv?raw';
import { bounds } from '../arena.js';
import { ASSETS } from '../assets.js';

// Parsed once at module load. The file cannot change while the page is up, and
// six rows is not work worth repeating on the frame a storm is staged.
const STORMS = parseAttractorStormCsv(stormsCsv);

/** Every staged study, in file order. The U panel builds its chips from this. */
export function attractorStormList() {
  return STORMS.map((s) => ({ ...s }));
}

// ---------------------------------------------------------------------------
// WHERE EACH SHAPE'S CUBES ARE BORN
// ---------------------------------------------------------------------------
// Seeding is a property of the SYSTEM, not of the study, so it lives here in
// code rather than as six more columns nobody would ever want to differ.
//
// The ranges are the attractor's own basin, and the two that matter are the two
// that would otherwise fail silently. A Lorenz cube seeded near the origin sits
// on the repelling fixed point and takes seconds to fall onto a wing — so they
// are seeded ON a wing, one side or the other. An Aizawa cube seeded far out is
// outside the basin entirely: the cubic term takes it to infinity, which the
// integrator reports and this file has to handle, so they are seeded at the
// middle where the field itself carries them onto the shape.
const SEEDS = {
  thomas: (rand) => ({
    x: (rand() * 2 - 1) * 11,
    y: (rand() * 2 - 1) * 11,
    z: (rand() * 2 - 1) * 5.4,
  }),
  lorenz: (rand) => {
    const lobe = rand() < 0.5 ? -1 : 1;
    return {
      x: lobe * (4 + rand() * 7),
      y: lobe * (4 + rand() * 7),
      z: 18 + rand() * 16,
    };
  },
  aizawa: (rand) => ({
    x: (rand() * 2 - 1) * 0.1,
    y: (rand() * 2 - 1) * 0.1,
    z: (rand() * 2 - 1) * 0.2,
  }),
};

// How far a state may get before the cube is written off. Not a tidiness rule:
// Lorenz and Aizawa both have a cubic term, so a state that leaves the basin
// does not wander, it diverges — and a projectile at 1e30 is culled by the
// arena bounds a frame later anyway, having been drawn one frame at a position
// no camera can hold. Thomas cannot diverge and is bounded here only so a
// lattice cube that wanders out of the arena is retired rather than orbiting
// off screen for its whole life.
const DOMAIN = { thomas: 26, lorenz: 90, aizawa: 6 };

// How many integration substeps a frame each system gets. An integration
// quality knob and not a balance one, which is why it is here and not in the
// CSV: Lorenz's wing rims run fast enough that a coarse step throws cubes off
// the attractor entirely — the shape stops being the shape — and the other two
// are gentle enough that three is generous.
const SUBSTEPS = { thomas: 3, lorenz: 6, aizawa: 3 };

// The swarm's breath, as a fraction of its scale. Wide enough that the core is
// genuinely exposed at the top of the cycle and genuinely walled at the bottom.
const SWARM_BREATH = 0.42;

// How far behind the rider in front of it each cube in a release train starts,
// in world units. Small enough that a train reads as one thing moving and not
// as four separate shots on the same line.
const RIDER_STAGGER = 5;

// The empty beat between a volley finishing and the next telegraph starting.
// Without it the shape re-draws on the frame the last cube leaves it, and the
// player never gets to see that they survived.
const RELEASE_REST = 0.45;

// ---------------------------------------------------------------------------
// THE LIVE STORM
// ---------------------------------------------------------------------------
// One at a time, deliberately. These are being judged against each other and
// two at once is a question about neither.
let storm = null;

// Scratch, module level for the usual reason — this runs per cube per substep.
const _deriv = { x: 0, y: 0, z: 0 };
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3(1, 0, 0);

/** The staged storm's id, or null. */
export function activeAttractorStorm() {
  return storm ? storm.row.id : null;
}

/** Where the staged storm is anchored, or null. Read by the U panel's status. */
export function attractorStormAnchor() {
  return storm ? { x: storm.anchorX, y: storm.anchorY } : null;
}

// ---------------------------------------------------------------------------
// PROJECTION — attractor coordinates to world offsets from the anchor
// ---------------------------------------------------------------------------
// `plane` picks which two of the three axes are the picture. The vertical one
// has `centre` taken off it first, which is what puts a Lorenz butterfly on the
// anchor rather than twenty-five scaled units above it.
function projectX(row, state) {
  return state.x * row.scale;
}

function projectY(row, state, scaleMul = 1) {
  const v = row.plane === 'xy' ? state.y : state.z;
  return (v - (row.centre ?? 0)) * row.scale * scaleMul;
}

// The swarm is the one study whose scale is not constant: the cloud contracts
// until it is a wall and thins until its core is exposed, and that pulse is one
// multiplier on the projection rather than anything the field knows about.
function scaleMul(s) {
  if (s.row.mode !== 'swarm') return 1;
  const period = Math.max(0.5, s.row.period ?? 11);
  return 1 + SWARM_BREATH * Math.sin((s.clock / period) * Math.PI * 2);
}

/** Is the swarm's core currently exposed? The U panel reports it; nothing else reads it. */
export function attractorCoreOpen() {
  return !!storm && storm.row.mode === 'swarm' && scaleMul(storm) > 1.15;
}

// ---------------------------------------------------------------------------
// THE FIELD PARAMETERS ONE ROW ASKS FOR
// ---------------------------------------------------------------------------
// `lift` is pinned to 0 for every storm, and that is the difference between
// this and the bait ball. A ball SHIFTS the system so the shape sits on its
// anchor; a storm leaves the system canonical and shifts the PICTURE instead
// (see `centre`). Same result on screen, and only one of the two leaves the
// equations being the textbook ones — which matters because the scaffold this
// file draws is a promise about where the cubes will go.
function paramsFor(s) {
  const row = s.row;
  if (row.shape === 'thomas') {
    return { b: row.param ?? 0.19, lift: 0, phase: s.phase };
  }
  return { lift: 0 };
}

// ---------------------------------------------------------------------------
// ONE CUBE'S FRAME
// ---------------------------------------------------------------------------
// Called by updateProjectiles through the `flow` hook, so it is always in step
// with the move it is describing rather than one frame behind it whichever
// order the two systems happen to run in.
function steerCube(p, dt) {
  const s = p.flowState?.storm;
  // The storm was cleared while this cube was still in the air. It keeps the
  // heading it had and flies out of the arena on its own, which is the right
  // ending: deleting it would take a hit out of the player's mouth mid-flight.
  if (!s || s !== storm) { p.flow = null; return; }

  if (s.row.mode === 'release') { steerRider(p, dt, s); return; }

  const st = p.flowState.state;
  const subs = SUBSTEPS[s.row.shape] ?? 3;
  const rate = s.row.rate ?? 1;
  // The clamp, in the attractor's own time. `speedCap` is world units a second;
  // dividing by the scale turns it into attractor units a second, and dividing
  // by the substep count gives each substep its share. Applied by shortening
  // the step rather than the move — see the header.
  const capPerSub = ((s.row.speedCap ?? 30) / Math.max(1e-4, s.row.scale)) * dt / subs;
  const h = (rate * dt) / subs;

  for (let i = 0; i < subs; i++) {
    attractorDeriv(s.row.shape, st.x, st.y, st.z, s.params, _deriv);
    const m = Math.hypot(_deriv.x, _deriv.y, _deriv.z);
    // A zero derivative is a fixed point: the cube is allowed to sit on it, and
    // dividing by it would be the one thing that puts a NaN into the list.
    const hEff = m > 1e-6 ? Math.min(h, capPerSub / m) : h;
    if (!stepAttractor(s.row.shape, st, hEff, s.params)) { p.life = 0; return; }
  }

  const reach = Math.hypot(st.x, st.y, st.z);
  if (reach > (DOMAIN[s.row.shape] ?? 30)) { p.life = 0; return; }

  const mul = scaleMul(s);
  p.flowX = s.anchorX + projectX(s.row, st);
  p.flowY = s.anchorY + projectY(s.row, st, mul);
}

// A release cube does not integrate at all — it walks a polyline that was
// integrated once, when the volley was drawn. That is the mechanic and not an
// optimisation: the player was shown the path, so the path the cube takes has
// to be exactly the one on screen and not a fresh integration of the same
// equations that agrees with it to within a step size.
// WALKED BY ARCLENGTH, NOT BY INDEX. The stored points are dense where the
// field is slow and sparse where it is fast, so a rider advancing one point per
// tick would travel at the field's own speed profile — which is the thing
// `speedCap` exists to refuse, and it would refuse it for every study except
// this one. Stepping a distance instead makes the cap exact and makes the
// point spacing an implementation detail of the drawing rather than a hidden
// speed curve.
function steerRider(p, dt, s) {
  const rider = p.flowState;
  const path = s.paths[rider.line];
  if (!path) { p.life = 0; return; }
  rider.dist += rider.speed * dt;

  // Still staggered behind the start: it waits AT the head of its own line
  // rather than at the anchor, so a volley loads visibly along the shape it is
  // about to fly instead of piling up in a heap at the middle of it.
  if (rider.dist <= 0) {
    p.flowX = s.anchorX + path.pts[0];
    p.flowY = s.anchorY + path.pts[1];
    return;
  }
  // Forward-only, resuming from where this rider got to last frame: the walk is
  // monotonic, so a search from the start would be the same answer for more
  // work every frame of a long path.
  const cum = path.cum;
  while (rider.i + 1 < cum.length && cum[rider.i + 1] < rider.dist) rider.i++;
  if (rider.i + 1 >= cum.length) { p.life = 0; return; }

  // Interpolated between the two points it is between. Without this a cube
  // visibly ticks from stored point to stored point wherever the path is
  // sparse, which is exactly where it is moving fastest and most watched.
  const a = rider.i;
  const seg = Math.max(1e-6, cum[a + 1] - cum[a]);
  const t = Math.min(1, Math.max(0, (rider.dist - cum[a]) / seg));
  p.flowX = s.anchorX + path.pts[a * 2] + (path.pts[a * 2 + 2] - path.pts[a * 2]) * t;
  p.flowY = s.anchorY + path.pts[a * 2 + 1] + (path.pts[a * 2 + 3] - path.pts[a * 2 + 1]) * t;
}

// ---------------------------------------------------------------------------
// THE SCAFFOLD — the field, drawn
// ---------------------------------------------------------------------------
// Integrate a handful of seeds and keep the projected path. Two studies need
// it and need it differently: the lattice wants it dim and permanent, because
// the channels ARE the readable part of that attack; the release wants it
// bright and progressive, because it is a countdown.
//
// Built in ANCHOR-LOCAL coordinates and carried by the object's position, so a
// storm whose anchor walks (the ring) drags its own telegraph with it instead
// of leaving it behind on the seabed.
function buildPaths(s, seedCount, steps, keepEvery) {
  const paths = [];
  const rate = s.row.rate ?? 1;
  const subs = SUBSTEPS[s.row.shape] ?? 3;
  const h = (rate / 60) / subs;
  const seed = SEEDS[s.row.shape] ?? SEEDS.thomas;
  for (let i = 0; i < seedCount; i++) {
    const st = seed(Math.random);
    const pts = [];
    for (let k = 0; k < steps; k++) {
      if (!stepAttractor(s.row.shape, st, h, s.params)) break;
      if (k % keepEvery) continue;
      pts.push(projectX(s.row, st), projectY(s.row, st));
    }
    // A seed that diverged in its first few steps describes nothing. Kept out
    // rather than drawn, because a two-point line reads as a stray mark in the
    // water and the player would be right to try to dodge it.
    if (pts.length < 12) continue;
    // Cumulative arclength beside the points, so a rider can be walked at a
    // world speed rather than at one stored point per tick — see steerRider.
    // Built here because it is a property of the path and building it per
    // rider would be twenty copies of the same array per volley.
    const cum = new Float64Array(pts.length / 2);
    for (let i = 1; i < cum.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(
        pts[i * 2] - pts[i * 2 - 2],
        pts[i * 2 + 1] - pts[i * 2 - 1],
      );
    }
    paths.push({ pts, cum, length: cum[cum.length - 1] });
  }
  return paths;
}

// Removed from whatever actually holds them rather than from a scene handed
// in, so a caller with no scene to give — systems/bossPerks.js's reset, which
// takes none — can still clean up completely. A `scene.remove` on the wrong
// scene is a silent no-op that leaves the line in the water forever.
function disposeScaffold(scene, s) {
  for (const line of s.lines) {
    (line.parent ?? scene)?.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }
  s.lines.length = 0;
}

// One THREE.Line per path. Flat colour, no shader — this is a stand-in for
// whatever the effect eventually is, exactly as the cubes are, and the only
// thing it has to get right is where the cubes will be.
function buildScaffold(scene, s, opacity) {
  disposeScaffold(scene, s);
  for (const path of s.paths) {
    const pts = path.pts;
    const positions = new Float32Array((pts.length / 2) * 3);
    for (let i = 0; i < pts.length / 2; i++) {
      positions[i * 3] = pts[i * 2];
      positions[i * 3 + 1] = pts[i * 2 + 1];
      positions[i * 3 + 2] = 0;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x45e0be, transparent: true, opacity, depthWrite: false,
    });
    const line = new THREE.Line(geom, mat);
    line.position.set(s.anchorX, s.anchorY, s.anchorZ);
    line.renderOrder = 2;
    scene.add(line);
    s.lines.push(line);
  }
}

function setScaffoldOpacity(s, opacity) {
  for (const line of s.lines) line.material.opacity = opacity;
}

// How much of each scaffold line is drawn, 0 to 1. Only the release uses it —
// the tell is the shape ARRIVING, which is a different event from the shape
// being there, and a line that simply appeared would be a flash rather than a
// countdown.
function setScaffoldDrawn(s, frac) {
  for (const line of s.lines) {
    const total = line.geometry.getAttribute('position').count;
    line.geometry.setDrawRange(0, Math.max(2, Math.floor(total * frac)));
  }
}

// ---------------------------------------------------------------------------
// STAGING ONE
// ---------------------------------------------------------------------------

/**
 * Put a study in the water.
 *
 * `anchor` is where the pattern is centred — a live boss's mesh position, or
 * the middle of the arena when there is no boss. Copied rather than held: a
 * storm outlives the thing that staged it, and holding a mesh that has since
 * been disposed is a crash on the frame the boss dies.
 *
 * Returns the row that was staged, or null if the id is not one of the six.
 */
export function startAttractorStorm(scene, id, anchor = null, opts = {}) {
  const row = STORMS.find((s) => s.id === id);
  if (!row) return null;
  stopAttractorStorm(scene);

  const follow = opts.follow ?? null;
  storm = {
    row,
    // WHOSE ATTACK THIS IS. A boss, when a perk fired it — and then the anchor
    // is that animal's live position every frame rather than a copy of where it
    // was when the storm opened. This is the difference between a field the
    // boss is standing in and a field the boss OWNS: it swims, and the shape
    // goes with it. Null when the U panel staged it loose in the water.
    //
    // Held as the creature rather than as its mesh so the death check is the
    // same one every other system makes (`hp <= 0`), and dropped the frame it
    // dies — a mesh reference outliving its creature is a crash on the frame
    // the corpse is disposed.
    follow,
    // What the perk is paying for one hit, with bossPerks.csv's
    // `damagePerDifficulty` already resolved. Overrides the study's own
    // `damage`, which is a number tuned for looking at rather than for a fight
    // at minute nine.
    damage: opts.damage,
    // WHO GETS THE BLAME, fixed at the start rather than derived per cube.
    //
    // The `boss:` prefix is load-bearing and not a label: capBossDamage in
    // systems/boss.js and the death-cause table both switch on it, so a storm a
    // boss fired that filed itself as anything else would be uncapped damage
    // that the score screen then blames on nobody. A storm the panel staged
    // loose has no boss to blame and must NOT claim one.
    //
    // Decided once so a boss dying mid-storm does not change what its own
    // cubes are called halfway through the volley.
    source: follow ? `boss:${row.id}` : `attractor:${row.id}`,
    clock: 0,
    // The lattice's slide. Held here rather than derived from the clock,
    // because it steps rather than sweeps: every channel in the water has to
    // move at ONE moment the player can be warned about, and a phase that
    // advanced smoothly would be a lattice that is always slightly moving,
    // which is not a thing anyone can read or dodge.
    phase: 0,
    nextEvent: row.period ?? 0,
    // Release only: 'draw' or 'fire'.
    stage: 'draw',
    stageLeft: 0,
    anchorX: follow?.mesh?.position.x ?? anchor?.x ?? 0,
    anchorY: follow?.mesh?.position.y ?? anchor?.y ?? (bounds.surfaceY - 16),
    anchorZ: follow?.mesh?.position.z ?? anchor?.z ?? 0,
    paths: [],
    lines: [],
    // Echo only: the first of a pair, waiting for its twin. See spawnCube.
    pending: null,
    params: null,
  };
  storm.params = paramsFor(storm);

  if (row.mode === 'release') {
    storm.stage = 'draw';
    storm.stageLeft = row.period ?? 2.6;
    rollRelease(scene);
  } else if (row.id === 'lattice') {
    // The channels, dim and permanent. Without them this attack is a screen of
    // cubes doing something intricate that the player has no way to learn.
    storm.paths = buildPaths(storm, 22, 900, 2);
    buildScaffold(scene, storm, 0.16);
  }
  return { ...row };
}

/** Take it back out. Cubes already in the air fly on — see steerCube. */
export function stopAttractorStorm(scene = null) {
  if (!storm) return;
  disposeScaffold(scene, storm);
  storm = null;
}

/** Everything this module owns, gone. Called from the run reset. */
export function resetAttractorStorm(scene) {
  stopAttractorStorm(scene);
}

function rollRelease(scene) {
  storm.paths = buildPaths(storm, 20, 1400, 2);
  buildScaffold(scene, storm, 0.5);
  setScaffoldDrawn(storm, 0);
}

// ---------------------------------------------------------------------------
// SPAWNING
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHAT THE SHOTS ARE MADE OF
// ---------------------------------------------------------------------------
// `body` in attractorStorms.csv, resolved ONCE when the storm is armed rather
// than per shot: a study firing sixty of these a second would otherwise re-warn
// sixty times a second about the same typo, which is a console nobody can read
// and therefore a warning nobody sees.
//
// An unknown key falls back to the cube rather than to nothing. A storm that
// silently stopped putting bodies in the water would look like the flow had
// broken, and the actual fault — a misspelt asset — is nowhere near where you
// would go looking.
const CUBE = 'attractorCube';

function resolveBodies(s, warn = console.warn) {
  const want = s.row.body;
  if (!want?.length) return [CUBE];
  const ok = [];
  for (const key of want) {
    if (ASSETS[key]) ok.push(key);
    else {
      warn(`[attractorStorms] "${s.row.id}" names body "${key}", which is not an asset — `
        + 'that one is being dropped. The study still fires; it fires the cube.');
    }
  }
  return ok.length ? ok : [CUBE];
}

// HOW BIG THAT BODY IS DRAWN, and this is the one piece of arithmetic in here
// that has to be right rather than merely plausible.
//
// The cube is a UNIT cube, so the old code could pass the hit radius doubled
// straight in as `scale` and get a body exactly as wide as the thing it
// collides with. A model cannot: it carries its own `fit`, and
// spawnProjectile's `mesh.scale.setScalar(scale)` lands on the ROOT, which
// holds only the asset table's size multiplier — `fit` is applied further down
// the graph and survives. So the drawn long axis is `fit * scale`, and the
// scale that makes it the hit diameter is the diameter over the fit.
//
// Get this wrong and nothing throws: a money roll with fit 1 happens to be
// right, and a fish with fit 1.25 is a quarter too big for its own hitbox — a
// bullet hell that draws its shots bigger than they are reads as unfair, which
// is the one thing this attack cannot afford to be.
function bodyScale(key, radius) {
  const fit = ASSETS[key]?.fit;
  return (radius * 2) / (fit > 0 ? fit : 1);
}

function spawnCube(scene, s, state, line = -1, stagger = 0) {
  const row = s.row;
  const mul = scaleMul(s);
  // A rider is born at the head of its own line rather than at the anchor. It
  // is one frame either way, but that frame is a cube at the middle of a shape
  // it is not on — and with a whole volley spawning together it is a flash of
  // sixty of them in a heap.
  const head = line >= 0 ? s.paths[line] : null;
  // ROLLED PER SHOT, not per storm. A shoal of one repeated fish is a texture;
  // the variety is the whole reason this column is a list.
  const bodies = (s.bodies ??= resolveBodies(s));
  const body = bodies.length === 1
    ? bodies[0]
    : bodies[(Math.random() * bodies.length) | 0];
  _origin.set(
    s.anchorX + (head ? head.pts[0] : projectX(row, state)),
    s.anchorY + (head ? head.pts[1] : projectY(row, state, mul)),
    s.anchorZ,
  );
  spawnProjectile(scene, {
    origin: _origin,
    dir: _dir,
    faction: 'enemy',
    // The perk's number when a boss fired it, the study's own when the panel
    // staged it loose. A staged storm is being looked at; a fired one is a
    // fight at whatever difficulty the run has reached.
    damage: s.damage ?? row.damage ?? 6,
    // A first frame's worth of speed and nothing more — `flow` overwrites both
    // this and the direction before the cube has moved once.
    speed: 1,
    life: row.life ?? 8,
    radius: row.radius ?? 0.5,
    asset: body,
    // Whatever this body is, drawn exactly as wide as it hits. See bodyScale.
    scale: bodyScale(body, row.radius ?? 0.5),
    // Nosed along the flow. It also mirrors rather than rolling belly-up when
    // a shot travels leftward, which is invisible on a cube and is the whole
    // difference between a shoal and a set of upside-down fish.
    orient: true,
    // The cant out of the screen plane. 0.55 by default, which is what makes a
    // square read as a CUBE; a row sets its own, and a fish wants roughly zero.
    // See the `tilt` column in attractorStormTable.js.
    tilt: row.tilt ?? 0.55,
    source: s.source,
    gravityScale: 0,
    flow: steerCube,
    // THE STREAK. A bare cube shows a POINT on a trajectory, and a strange
    // attractor is the trajectory — the fold, the wing crossing and the two
    // paired cubes coming apart are all things that happened over the last third
    // of a second and are invisible in any single frame. See CONFIG.trails
    // .attractorStorm for why it is the thinnest ribbon in the game.
    //
    // Named for the system rather than left to the asset key, because a row's
    // `body` list rolls per shot and a shoal whose ribbons changed colour fish
    // by fish would read as several things rather than one field.
    trailKey: 'attractorStorm',
    // ...and scaled to this row's own shot. `trailScale` multiplies the width,
    // so a study drawn at twice the hit radius gets twice the streak without a
    // second column to keep in step with the first. Against 0.5, which is the
    // radius the preset's width was tuned at.
    trailScale: (row.radius ?? 0.5) / 0.5,
  });
  const p = projectiles[projectiles.length - 1];
  if (!p) return null;
  p.flowState = line >= 0
    ? { storm: s, line, dist: -stagger, i: 0, speed: row.speedCap ?? 60 }
    : { storm: s, state };
  return p;
}

// How many of this storm's cubes are in the water. Derived from the projectile
// list rather than kept as a count, because this module does not own the moment
// a cube leaves it — a hit, the life clock and the arena edge all despawn one
// without telling anybody, and a counter would drift down one path and never
// come back up.
function liveCount(s) {
  let n = 0;
  for (const p of projectiles) if (p.flowState?.storm === s) n++;
  return n;
}

function topUp(scene, s) {
  const want = s.row.count ?? 0;
  let short = want - liveCount(s);
  if (short <= 0) return;
  // A cap per frame, so a storm staged into an empty arena fills over about a
  // second instead of arriving as one wall on one frame. The wall is a
  // different attack and not one of the six.
  short = Math.min(short, 4);
  const seed = SEEDS[s.row.shape] ?? SEEDS.thomas;

  for (let i = 0; i < short; i++) {
    if (s.row.mode === 'echo') {
      // PAIRS. The second is seeded a hair off the first — 0.03 attractor units,
      // which at this scale is a fortieth of a world unit and reads as one cube
      // for the first few seconds. Then they are on opposite wings.
      //
      // The pending half is held across frames rather than both being spawned
      // together, so the top-up cap above cannot split a pair and leave a
      // widow that has nothing to diverge from.
      if (s.pending) {
        const q = s.pending;
        s.pending = null;
        spawnCube(scene, s, { x: q.x + 0.03, y: q.y, z: q.z });
      } else {
        const st = seed(Math.random);
        s.pending = { ...st };
        spawnCube(scene, s, st);
      }
      continue;
    }
    spawnCube(scene, s, seed(Math.random));
  }
}

// ---------------------------------------------------------------------------
// THE FRAME
// ---------------------------------------------------------------------------

/**
 * Drive the staged storm.
 *
 * Called from the frame loop beside the boss's own abilities. `playerPos` is
 * what the one mobile study walks toward; nothing else here reads it.
 */
export function updateAttractorStorm(dt, scene, playerPos = null) {
  const s = storm;
  if (!s) return;
  s.clock += dt;
  const row = s.row;

  // THE ANCHOR, and there are two kinds.
  //
  // A storm a BOSS is firing rides that boss. Every frame, not once at the
  // start: the animal swims, and a field that stayed where the animal used to
  // be is not its attack, it is a thing that happened near it. This is also
  // what makes `reach` moot for a perk-fired ring — the boss's own swimming is
  // the closing, and a second walk on top of it would be the pattern sliding
  // off the body that is supposed to own it.
  if (s.follow) {
    const e = s.follow;
    if (!e.mesh || e.hp <= 0) {
      // The boss died mid-storm. Let go of the body rather than reading a mesh
      // that is about to be disposed; the field finishes where it stands and
      // the perk stops it a frame later.
      s.follow = null;
    } else {
      s.anchorX = e.mesh.position.x;
      s.anchorY = e.mesh.position.y;
      s.anchorZ = e.mesh.position.z;
      for (const line of s.lines) line.position.set(s.anchorX, s.anchorY, s.anchorZ);
    }
  }

  // A LOOSE storm's ring closes on its own: a fixed walk toward wherever the
  // seal is, so the fight is about the gap rather than about reaction. Clamped
  // inside the arena so it cannot walk the pattern off the edge of the world
  // following a seal in the corner.
  if (!s.follow && row.mode === 'ring' && playerPos && (row.reach ?? 0) > 0) {
    const dx = playerPos.x - s.anchorX;
    const dy = playerPos.y - s.anchorY;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) {
      const step = Math.min(d, (row.reach ?? 0) * dt);
      s.anchorX += (dx / d) * step;
      s.anchorY += (dy / d) * step;
    }
    s.anchorX = Math.max(bounds.left + 4, Math.min(bounds.right - 4, s.anchorX));
    s.anchorY = Math.max(bounds.bottom + 4, Math.min(bounds.surfaceY - 2, s.anchorY));
    for (const line of s.lines) line.position.set(s.anchorX, s.anchorY, s.anchorZ);
  }

  // THE LATTICE SLIDE. One number turns and every channel in the arena moves
  // with it. The scaffold is rebuilt on the same frame, because the scaffold is
  // a promise about where the cubes are going and a stale one is worse than
  // none — the player would be dodging into the lane that used to be safe.
  if (row.id === 'lattice' && (row.period ?? 0) > 0) {
    s.nextEvent -= dt;
    if (s.nextEvent <= 0) {
      s.phase += Math.PI * 0.5;
      s.params = paramsFor(s);
      s.nextEvent = row.period;
      s.paths = buildPaths(s, 22, 900, 2);
      buildScaffold(scene, s, 0.16);
    } else if (s.nextEvent < 1.1) {
      // The warning. The channels brighten for the last beat before they move —
      // the only tell this attack has, and without it the slide is a screen of
      // bullets teleporting.
      setScaffoldOpacity(s, 0.16 + 0.4 * (1 - s.nextEvent / 1.1));
    }
  }

  // THE RELEASE CYCLE. Draw, then fire, then re-roll the shape so the telegraph
  // is never the same twice.
  // THE RELEASE CYCLE: draw, fire, rest, re-roll. `period` is the DRAW alone —
  // the length of the telegraph, which is the only half of this attack anybody
  // would want to tune. How long the firing takes is not a choice: it is how
  // long the volley needs to walk the shape at its own speed, and a fixed
  // window would either cut the last cubes off the end of their path or leave
  // the water empty for a beat in the middle of an attack.
  if (row.mode === 'release') {
    s.stageLeft -= dt;
    const drawFor = Math.max(0.4, row.period ?? 2.6);
    if (s.stage === 'draw') {
      setScaffoldDrawn(s, Math.min(1, 1 - Math.max(0, s.stageLeft) / drawFor));
      if (s.stageLeft <= 0) {
        s.stage = 'fire';
        setScaffoldOpacity(s, 0.22);
        s.stageLeft = fireRelease(scene, s) + RELEASE_REST;
      }
    } else if (s.stageLeft <= 0) {
      s.stage = 'draw';
      s.stageLeft = drawFor;
      rollRelease(scene);
    }
    return;
  }

  topUp(scene, s);
}

// One volley: every path carries a short train of cubes, staggered so the shape
// is drawn along its own length rather than arriving everywhere at once.
//
// The count is `count` spread over however many paths survived the build, which
// is why the row's number is a total and not a per-line figure — a build that
// dropped a few diverged seeds would otherwise quietly fire a bigger volley.
// Returns how long the volley will take to clear the shape, which is what the
// caller sets the firing stage to.
function fireRelease(scene, s) {
  const lines = s.paths.length;
  if (!lines) return 0.5;
  const per = Math.max(1, Math.round((s.row.count ?? 40) / lines));
  const speed = s.row.speedCap ?? 60;
  let longest = 0;
  for (let i = 0; i < lines; i++) {
    for (let k = 0; k < per; k++) spawnCube(scene, s, null, i, k * RIDER_STAGGER);
    longest = Math.max(longest, s.paths[i].length + (per - 1) * RIDER_STAGGER);
  }
  return longest / Math.max(1, speed);
}
