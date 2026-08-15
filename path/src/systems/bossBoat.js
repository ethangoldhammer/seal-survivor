import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { player } from '../entities/player.js';
import { fireBossShot, bossGun } from './bossPerks.js';

// THE BOAT — the boss that shells you from above the water.
//
// Every other boss is an animal that comes to where you are. This one never
// does: it rides the waterline out of reach, tracks you across the top of the
// arena, and fills the water underneath it with ordnance. The whole fight is a
// bullet hell — you are not dodging one attack at a time, you are reading a
// pattern and swimming through the gap in it.
//
// WHY IT IS A SYSTEM AND NOT A PERK. Perks are things a boss HAS, rolled from a
// table and interchangeable — a shark with a lunge is still a shark. The
// bombardment is what this boss IS, and it comes with a body that cannot swim,
// a station on the surface and a pattern cycle. It still rolls one ordinary
// perk on top (see bosses.csv `perks`), which is what keeps two boat fights
// from being the same fight.
//
// WHAT IT REUSES, deliberately and entirely:
//   the barrel      fireBossShot with a fused gun — the same floating barrel
//                   the `barrels` perk throws, the same blast, the same
//                   falloff, the same playtest filing.
//   the missile     the same call with the seeker gun, chasing the seal
//                   through entities/projectiles.js's `chase`.
// Nothing about a shell is written twice. What is new here is only WHERE and
// WHEN they are thrown, which is the part that makes it a bullet hell rather
// than a boss that shoots.
//
// THE THREE PATTERNS, and every one of them is built around its gap:
//
//   RAIN      barrels dropped along the surface across the arena, one column at
//             a time, with a gap that MOVES between volleys. Swim to where the
//             gap is going to be.
//   SALVO     homing missiles, few and slow-turning. Not dodged by position but
//             by turning harder than they can — see `turnRate`.
//   SPREAD    a fan of barrels straight down from the hull, wide enough that
//             the answer is to be somewhere else entirely by the time it lands.
//
// A pattern is announced before it fires (`telegraph`), and the gap is decided
// BEFORE the announcement rather than during the volley, so the tell is honest:
// what you are being shown is what is about to happen.

export const boatState = {
  boat: null,
  pattern: 'rain',
  stage: 'ready',   // 'ready' | 'telegraph' | 'firing'
  timer: 0,
  shot: 0,          // shots fired so far in this volley
  gapX: 0,          // where the hole in the wall is, in world x
  index: 0,         // which pattern the cycle is on
  tell: null,       // the telegraph mesh, while one is up
};

const _origin = new THREE.Vector3();
let owned = [];

function cfg() {
  return CONFIG.bossBoat ?? {};
}

/** Is this creature the boat? Read off the def so nothing has to be told. */
export function isBoatBoss(e) {
  return !!e?.def?.surfaceBoss;
}

export function resetBossBoat(scene) {
  for (const o of owned) {
    o.parent?.remove(o);
    o.geometry?.dispose?.();
    o.material?.dispose?.();
  }
  owned = [];
  boatState.boat = null;
  boatState.pattern = 'rain';
  boatState.stage = 'ready';
  boatState.timer = 0;
  boatState.shot = 0;
  boatState.index = 0;
  boatState.tell = null;
}

/**
 * A boat boss has arrived. Called from systems/boss.js on the spawn frame.
 *
 * The creature is left where the spawner put it and pinned to the surface on
 * the first update rather than here — `bounds.surfaceY` is the same number
 * either way, and doing it in one place means the pin cannot be half-applied.
 */
export function attachBossBoat(scene, e) {
  resetBossBoat(scene);
  if (!isBoatBoss(e)) return;
  boatState.boat = e;
  // NOT WALKING IN FROM THE WINGS. `entering` is raised on every spawn and
  // routes the creature through clampVertical, which pins it a full radius
  // BELOW the waterline until it is inside the side walls — on a hull four
  // units across that is the boat fighting the whole entrance from underwater,
  // and it is the exact shape of a bug that looks like a design choice. The
  // boat arrives on station; it does not swim on.
  e.entering = false;
  e.mesh.position.y = bounds.surfaceY + (cfg().draft ?? -0.35);
  e.vx = 0;
  e.vy = 0;
  // The first volley waits out the entrance and then some. A bullet hell that
  // opens on the frame you get control is a bullet hell nobody has read yet.
  boatState.timer = cfg().openingDelay ?? 2.2;
  boatState.index = 0;
}

// WHERE THE HULL SITS. Pinned to the waterline every frame, because everything
// else in the game is trying to put it somewhere else: the steering integrator
// writes vy, the arena clamp keeps creatures BELOW the surface, and separation
// shoves bodies apart. A boat that is merely spawned at the surface sinks
// within a second and spends the fight as a submarine.
//
// The x is its own: it tracks the player at its own pace, which is what makes
// swimming sideways a real answer to a pattern rather than a way to change
// nothing.
function ride(dt, e, playerPos) {
  const c = cfg();
  // THE BOAT STEERS ITSELF. `perkDrive` is the existing seam for "something
  // else owns this creature's velocity this frame" (see updateEnemies), and
  // without it the hull's own behaviour would be written over the top of
  // everything below — a boat that hunts the seal downward, which is the one
  // thing a boat cannot do.
  e.perkDrive = true;
  const y = bounds.surfaceY + (c.draft ?? -0.35);
  e.mesh.position.y = y;
  e.vy = 0;

  // Horizontal station-keeping. `lead` puts it slightly ahead of where the
  // player is going, so parking directly underneath does not make you safe.
  const want = playerPos.x + (player.velocity?.x ?? 0) * (c.lead ?? 0.35);
  const dx = want - e.mesh.position.x;
  const speed = c.trackSpeed ?? 4.5;
  // Deadzone, or the hull jitters left and right over a player who is holding
  // still, and a boat that twitches reads as broken rigging.
  const dead = c.deadzone ?? 1.5;
  const target = Math.abs(dx) < dead ? 0 : Math.sign(dx) * speed;
  e.vx += (target - e.vx) * Math.min(1, (c.accel ?? 2.2) * dt);

  // Inside the walls under its own power, so the hull never has to be clamped
  // out of one — a boat that bumps the edge and stops looks stuck, and the
  // patterns are laid out against the arena's width rather than its own.
  const margin = (e.radius ?? 4) * 0.6;
  if (e.mesh.position.x < bounds.left + margin && e.vx < 0) e.vx = 0;
  if (e.mesh.position.x > bounds.right - margin && e.vx > 0) e.vx = 0;
  e.mesh.position.x += e.vx * dt;

  // Level, and facing the way it is going. A hull that pitches with its
  // velocity like a fish is the single fastest way to stop reading as a boat.
  if (e.visual) {
    const roll = Math.sin(performance.now() * 0.0011) * (c.rollAmount ?? 0.05);
    e.visual.rotation.z = roll + (e.vx < 0 ? Math.PI : 0) * 0;
    e.visual.rotation.y = e.vx < -0.2 ? Math.PI : (e.vx > 0.2 ? 0 : e.visual.rotation.y);
  }
}

// The tell. A ring on the water where the next thing is going to happen, or a
// line along the wall the barrels are about to fall from — drawn for
// `telegraph` seconds before a volley and taken down as it fires.
function showTell(scene, x, y, radius, color) {
  const geo = new THREE.RingGeometry(0.82, 1, 40);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.position.set(x, y, 0);
  ring.scale.setScalar(radius);
  scene.add(ring);
  owned.push(ring);
  return ring;
}

function clearTell() {
  if (!boatState.tell) return;
  const t = boatState.tell;
  t.parent?.remove(t);
  t.geometry?.dispose?.();
  t.material?.dispose?.();
  const i = owned.indexOf(t);
  if (i >= 0) owned.splice(i, 1);
  boatState.tell = null;
}

// Which pattern is next. A CYCLE rather than a roll: the fight has to be
// learnable, and three patterns in a fixed order is a rhythm a player can get
// inside. The randomness is in where the gap is, which is the part that has to
// stay unread.
function nextPattern() {
  const order = cfg().order ?? ['rain', 'salvo', 'spread'];
  const name = order[boatState.index % order.length];
  boatState.index += 1;
  return name;
}

function patternCfg(name) {
  return cfg().patterns?.[name] ?? {};
}

export function updateBossBoat(dt, scene, playerPos, hooks = {}) {
  const e = boatState.boat;
  if (!e) return;
  if (!e.mesh || e.hp <= 0) { resetBossBoat(scene); return; }

  ride(dt, e, playerPos);

  // The entrance is a promise that nothing is happening yet — the same rule
  // every perk follows. A barrel out of the ceremony is a hit the player was
  // given no chance to read.
  if (e.invuln > 0) { clearTell(); return; }

  boatState.timer -= dt;
  if (boatState.timer > 0) return;

  const p = patternCfg(boatState.pattern);

  if (boatState.stage === 'ready') {
    // Pick the next pattern AND its gap, then announce it. Both before the
    // telegraph, so what is shown is what happens.
    boatState.pattern = nextPattern();
    boatState.shot = 0;
    const span = bounds.right - bounds.left;
    boatState.gapX = bounds.left + span * (0.15 + Math.random() * 0.7);
    const q = patternCfg(boatState.pattern);
    boatState.stage = 'telegraph';
    boatState.timer = q.telegraph ?? 0.7;
    clearTell();
    const fx = cfg().tellColor ?? 0xff9a4a;
    if (boatState.pattern === 'rain') {
      // The gap, marked. The one place on the wall that will not be a barrel.
      boatState.tell = showTell(scene, boatState.gapX, bounds.surfaceY - 3, q.gapWidth ?? 6, 0x6ad4ff);
    } else if (boatState.pattern === 'salvo') {
      boatState.tell = showTell(scene, e.mesh.position.x, e.mesh.position.y - 2, 2.4, fx);
    } else {
      boatState.tell = showTell(scene, e.mesh.position.x, e.mesh.position.y - 3, 3.2, fx);
    }
    return;
  }

  if (boatState.stage === 'telegraph') {
    clearTell();
    boatState.stage = 'firing';
    boatState.shot = 0;
    boatState.timer = 0;
    return;
  }

  // --- firing --------------------------------------------------------------
  const fired = fire(scene, e, playerPos, p);
  boatState.shot += 1;
  const shots = p.shots ?? 1;
  if (boatState.shot < shots) {
    boatState.timer = p.shotGap ?? 0.12;
    return;
  }
  boatState.stage = 'ready';
  boatState.timer = p.cooldown ?? 2.4;
  return fired;
}

// One shot of whatever pattern is running. Split out so each pattern is a
// paragraph rather than a branch inside a state machine.
function fire(scene, e, playerPos, p) {
  const barrel = bossGun('barrels');
  const seeker = bossGun('missiles');
  _origin.set(e.mesh.position.x, e.mesh.position.y, e.mesh.position.z);

  if (boatState.pattern === 'rain') {
    // A WALL WITH A HOLE IN IT. Barrels are dropped along the surface at even
    // spacing across the whole arena, and every column within `gapWidth` of the
    // gap is skipped — so the wall arrives with exactly one way through it.
    //
    // Dropped from the SURFACE rather than from the hull, so the wall is a wall
    // and not a fan radiating from wherever the boat happens to be standing.
    const span = bounds.right - bounds.left;
    const columns = Math.max(3, p.columns ?? 9);
    const step = span / columns;
    const half = (p.gapWidth ?? 6) / 2;
    // One column per shot, left to right, so the wall SWEEPS rather than
    // appearing — a wall that arrives whole gives the player nothing to react
    // to, and a sweep is a thing you can outrun.
    const i = boatState.shot % columns;
    const x = bounds.left + step * (i + 0.5);
    // THE HOLE. Every column within half a gap of the marked centre is
    // skipped, AND the nearest column always is, whatever the numbers say.
    // That second clause is the guarantee: with a gap narrower than the column
    // spacing the arithmetic can put the hole neatly between two columns and
    // skip neither, and one wall in forty arrives with no way through it —
    // which is not a hard wave, it is an unsurvivable one, and it happens
    // rarely enough to be dismissed as bad luck by everyone who plays it.
    const nearest = Math.round((boatState.gapX - bounds.left) / step - 0.5);
    if (Math.abs(x - boatState.gapX) < half || i === nearest) return 0;
    _origin.set(x, bounds.surfaceY - 0.4, e.mesh.position.z);
    // THE FUSE IS CUT TO THE SEAL'S DEPTH. A barrel dropped from the surface on
    // a flat fuse detonates wherever it had got to, which at 9 units a second
    // over 2.4 seconds is twenty-two units down — comfortably short of a player
    // sitting near the seabed of a forty-unit arena, so the whole pattern went
    // off in open water above their head and the wall was decorative. Cut to
    // the flight time to their depth (floored, so a barrel dropped on a
    // surfaced seal still travels), the wall converges on where they actually
    // are and the gap becomes the only answer to it.
    const drop = Math.max(2, (bounds.surfaceY - 0.4) - playerPos.y);
    const fuse = Math.min(p.fuse ?? 3.6, Math.max(0.5, drop / Math.max(1, p.speed ?? 9)));
    fireBossShot(scene, {
      gun: barrel,
      origin: _origin,
      dirX: 0,
      dirY: -1,
      damage: p.damage ?? 16,
      speed: p.speed ?? 9,
      life: fuse,
      blastRadius: p.blastRadius ?? 3.2,
      source: 'boss:boatRain',
    });
    return 1;
  }

  if (boatState.pattern === 'salvo') {
    // SEEKERS. Few, and slow to turn — the counterplay is a hard turn of your
    // own, not distance. Fired wide and allowed to come back, so the launch is
    // legible before the tracking starts.
    const count = Math.max(1, p.count ?? 3);
    const half = (count - 1) / 2;
    const spread = p.spread ?? 0.5;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (i - half) * spread;
      _origin.set(
        e.mesh.position.x + Math.cos(a) * (e.radius ?? 4) * 0.5,
        e.mesh.position.y - 0.3,
        e.mesh.position.z,
      );
      fireBossShot(scene, {
        gun: seeker,
        origin: _origin,
        dirX: Math.cos(a),
        dirY: Math.sin(a),
        damage: p.damage ?? 14,
        speed: p.speed ?? 13,
        life: p.life ?? 5,
        turnRate: p.turnRate ?? 1.1,
        chase: player,
        source: 'boss:boatSalvo',
      });
    }
    return count;
  }

  // SPREAD — a fan straight down from the hull. The gap is the arena either
  // side of it: this one is answered by not being under the boat, which is the
  // opposite answer to `rain` and is why the two sit next to each other in the
  // cycle.
  const count = Math.max(1, p.count ?? 7);
  const half = (count - 1) / 2;
  const spread = p.spread ?? 0.26;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i - half) * spread;
    _origin.set(
      e.mesh.position.x + Math.cos(a) * (e.radius ?? 4) * 0.4,
      e.mesh.position.y - 0.4,
      e.mesh.position.z,
    );
    fireBossShot(scene, {
      gun: barrel,
      origin: _origin,
      dirX: Math.cos(a),
      dirY: Math.sin(a),
      damage: p.damage ?? 14,
      speed: p.speed ?? 11,
      life: p.fuse ?? 1.6,
      blastRadius: p.blastRadius ?? 2.8,
      source: 'boss:boatSpread',
    });
  }
  return count;
}
