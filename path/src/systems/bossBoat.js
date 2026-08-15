import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { player } from '../entities/player.js';
import { fireBossShot, bossGun } from './bossPerks.js';
import { spawnCrewFor, releaseCrew, throwCrewOff, jostleCrew } from './crew.js';
import { updateHullWake, resetHullWake, hullTurnSplash } from './boatWake.js';
import { faceSide } from './facing.js';

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
  deck: null,       // the crew's view of this hull, while it has one
  lastHp: null,     // last frame's hull health, for spotting hits — see the jostle
  // The heading the hull is drawn at this frame. Read by the tests and by
  // nothing else — the turn itself is owned by systems/facing.js, which keeps
  // its state on the visual so a body carries its own heading.
  yaw: 0,
  // Half the hull's MEASURED length, for the wake. Not `radius`: that is the
  // circle you shoot at, deliberately smaller than the boat (4.2 against
  // eleven units of trawler, 4.6 against thirteen of yacht — see the note on
  // CONFIG.enemies.bossYacht), and a wake laid out against it would come out
  // of the middle of the hull. Measured once, on arrival.
  halfLength: 0,
  // Where the hull's BOTTOM is, as an offset from the creature's y. Also for
  // the wake, and also measured once — see attachBossBoat.
  keelOffset: null,
  // THE TURN, for the wake. `turnTo` is the heading the last turn was aimed at,
  // and a turn has BEGUN on the frame systems/facing.js reports a different one
  // — which is the only moment a splash can be fired, since `t` is back at 0 on
  // that frame and at 0 on every frame the hull is settled. `turnT` is how far
  // through it is, 0..1.
  turnTo: null,
  turnT: 1,
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

/**
 * @param exploded true when the hull has just been KILLED, false when the
 *        fight is simply being switched off (a run reset, the boss being
 *        turned off mid-fight). It decides what happens to anyone still
 *        standing on the deck, and the two answers are not interchangeable:
 *        a killed boat throws its guests into the sea, and a run that ended
 *        takes them quietly with it. See releaseCrew.
 */
export function resetBossBoat(scene, exploded = false) {
  for (const o of owned) {
    o.parent?.remove(o);
    o.geometry?.dispose?.();
    o.material?.dispose?.();
  }
  owned = [];
  // THE DECK GOES FIRST, while the hull it is measured against is still where
  // it was. goLimp hands each figure from the boat to the scene with `attach`,
  // which composes the boat's transform out — do it after the mesh has been
  // dropped and every guest jumps to wherever a stale matrix put them.
  if (boatState.deck) {
    if (exploded) {
      const at = boatState.boat?.mesh?.position;
      // Everyone aboard, at full strength, thrown outward from the hull's own
      // centre — see throwCrewOff for why this is not blastCrew's job. From
      // here they are on the solver alone: gravity, drag, the water, the
      // seabed and the arena walls, and they land wherever that puts them.
      throwCrewOff(scene, boatState.deck, at?.x ?? 0, at?.y ?? 0, cfg().crewBlast ?? 24);
      // Anything the throw did not reach — a body already in the water from an
      // earlier hull, or a figure whose boat link was cleared — goes limp here
      // rather than being deleted mid-air.
      releaseCrew(scene, boatState.deck, true);
    } else {
      releaseCrew(scene, boatState.deck, false);
    }
    boatState.deck = null;
  }
  boatState.lastHp = null;
  boatState.yaw = 0;
  boatState.halfLength = 0;
  boatState.keelOffset = null;
  boatState.turnTo = null;
  boatState.turnT = 1;
  // The wake's accumulators live on boatState, so a hull whose fight ended
  // mid-burst must not carry a fraction of one into the next boat.
  resetHullWake(boatState);
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

  // HOW LONG THE HULL ACTUALLY IS, for the wake — see `halfLength` on
  // boatState for why this is measured rather than read off `radius`.
  // Measured on the VISUAL and in world units, so the yacht's extra length and
  // whatever the tuner's Size slider did to it are both already in the number,
  // the same way systems/boats.js measures its own hulls.
  //
  // Taken here, before the first ride(): from then on the visual carries a yaw
  // and a turn swing. Neither would change the x extent of the box, but the
  // hull is at a known heading exactly once and this is it.
  boatState.halfLength = (e.radius ?? 4) * 2;
  boatState.keelOffset = null;
  if (e.visual) {
    e.visual.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(e.visual);
    if (!box.isEmpty()) {
      boatState.halfLength = Math.max(0.5, (box.max.x - box.min.x) / 2);
      // WHERE THE BOTTOM OF THE HULL IS, kept as an offset from the creature's
      // own y rather than as a world height: the boat is re-pinned to the
      // waterline every frame and rolls on top of that, so an absolute figure
      // taken now would be stale by the next one. The wake needs it to know
      // what "under the boat" means — see systems/boatWake.js.
      boatState.keelOffset = box.min.y - e.mesh.position.y;
    }
  }

  // ANYONE ABOARD. Declared by the creature's own row (CONFIG.enemies.
  // bossYacht) rather than switched on for "the yacht", so a second hull that
  // wants a crew needs no code — and the trawler, which names nobody, keeps
  // sailing alone.
  //
  // systems/crew.js was written against systems/boats.js's hulls, which are a
  // different shape of object entirely. Rather than teach it about creatures,
  // it is handed the four things it actually reads — see the adapter — which
  // also means the ordinary boats' code path is untouched by any of this.
  //
  // Everything after this point is free: updateCrew already runs every frame
  // from updateBoats, so once they are on the deck they ride it, sway on it
  // and — when it goes down — fall off it, with nothing here ticking anything.
  if (e.def?.crewAsset || e.def?.crewAssets?.length) {
    e.visual.updateMatrixWorld(true);
    boatState.deck = {
      // THE VISUAL, NOT THE CONTAINER, and the difference is the whole of a bug
      // that looks like the guest being badly placed. A creature is a plain
      // Group (`mesh`) with the drawn body (`visual`) inside it, and it is the
      // VISUAL that ride() turns to face the way the boat is sailing. Parent a
      // man to the container and the hull swings 180 degrees underneath him
      // while he does not: he was standing on the bow, and now he is hanging in
      // the air off the stern, because the bow moved and he didn't.
      //
      // It is also the frame the deck was measured in — deckProfile bins along
      // its LOCAL x, which is "along the hull" only in the oriented body's own
      // space — so this is the one node where the measurement and the parenting
      // agree.
      mesh: e.visual,
      // The deck profile is cached against this, and it is a fact about the
      // MODEL — so it must be the asset key and not the creature, or two
      // yachts in one session would measure the same hull twice.
      assetKey: e.def.asset,
      crewAsset: e.def.crewAsset,
      crewAssets: e.def.crewAssets,
      crewCount: e.def.crewCount,
      crewMin: e.def.crewMin,
      crewMax: e.def.crewMax,
      // 'bow' | 'stern' | null (spread along the main deck) — see pickSlots.
      crewAt: e.def.crewAt ?? null,
      // They ride the whole fight and leave together — see `glued` in crew.js.
      crewGlued: e.def.crewGlued === true,
      // Only reached if the hull's geometry cannot be read at all, in which
      // case the guests are spread along the boat's own reach.
      halfLength: e.radius ?? 5,
      spawnScale: e.visual.scale.x || 1,
    };
    spawnCrewFor(scene, boatState.deck);
  }
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
    e.visual.rotation.z = roll;

    // IT STEERS ROUND, it does not flip. This used to be one line that snapped
    // rotation.y between 0 and PI on the frame the velocity changed sign, which
    // is a forty-metre boat changing ends in a single frame — and it is the one
    // moment the whole fight is watching the hull, because the boat only turns
    // when the player has just swum past underneath it.
    //
    // A fixed DURATION rather than a fixed rate, eased in and out: a rudder
    // takes a while to bite and a while to stop biting, and the ease is what
    // carries that. See ease.js for the curve names.
    //
    // The turn itself is systems/facing.js, which is the same easing every
    // creature in the game now turns with — what a hull gets of its own is a
    // much longer `turnTime` and the swing below. The wider deadzone is the
    // station-keeping: a boat parked over a player who is holding still hunts
    // back and forth across them at a fraction of a unit a second, and at the
    // roster's 0.05 it would come about on every one of those twitches.
    const face = faceSide(e.visual, e.vx, dt, {
      time: c.turnTime ?? 1.6,
      curve: c.turnEase ?? 'inOutCubic',
      dead: c.turnDeadzone ?? 0.2,
    });
    boatState.yaw = face.at;

    // COMING ABOUT. Caught here rather than from the velocity sign, because the
    // velocity crosses zero constantly inside the station-keeping deadzone and
    // only some of those crossings are actually a turn — systems/facing.js is
    // the thing that decides, and `to` changing is it deciding.
    //
    // The first call is skipped: `turnTo` starts null, and the hull adopting
    // its opening heading is not a manoeuvre. Splashing on it would mean every
    // boat boss arriving on station with a bang.
    if (face.to !== boatState.turnTo) {
      const wasSettled = boatState.turnTo !== null;
      boatState.turnTo = face.to;
      if (wasSettled) {
        hullTurnSplash({
          x: e.mesh.position.x,
          halfLength: boatState.halfLength,
          dir: Math.cos(boatState.yaw) >= 0 ? 1 : -1,
        });
      }
    }
    boatState.turnT = face.t;

    // AND IT DOES NOT PIVOT ON ITS NAVEL. A hull turning about its own centre
    // is a model spinning on a pin; a boat swings, because the point it turns
    // about is nowhere near the middle of it. Rather than actually move the
    // pivot — which would leave the art permanently offset from the hitbox at
    // one of the two headings — the body slides out and back across the turn.
    // `sin` is zero at both headings and widest halfway between, so the swing
    // exists only while the turn does and there is nothing left over at either
    // end to drift out of register with the circle you shoot at.
    //
    // Signed by which way it is turning, so the hull carries through the turn
    // rather than always leaning the same way.
    const turning = Math.sign(face.to - face.from) || 1;
    e.visual.position.x = (c.turnSwing ?? 1.1) * Math.sin(boatState.yaw) * turning;
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

  // AND IT PUSHES WATER, through the same system the boats that sail past use
  // — a boss hull is still a hull, and a forty-metre boat sitting on a flat
  // sea is the one thing that makes the whole fight read as a diorama.
  //
  // The heading comes from the YAW and not from `vx`. This boat spends whole
  // volleys parked in its deadzone with a velocity of a few hundredths, and a
  // stern worked out from that flips end to end at random; the yaw is where the
  // hull is actually pointing, all the way through a turn.
  updateHullWake(dt, boatState, {
    x: e.mesh.position.x,
    halfLength: boatState.halfLength,
    keelY: boatState.keelOffset == null ? null : e.mesh.position.y + boatState.keelOffset,
    dir: Math.cos(boatState.yaw) >= 0 ? 1 : -1,
    speed: Math.abs(e.vx ?? 0),
    vx: e.vx ?? 0,
    // A bell across the turn rather than a flag: the churn swells as the hull
    // reaches its beam-on and dies away as it settles, which is when the water
    // is actually being shoved. A flat 1 for the duration reads as the wake
    // being switched on and off.
    turning: boatState.turnT < 1 ? Math.sin(Math.PI * boatState.turnT) : 0,
  });

  // THE DECK FEELS IT. Watched as a drop in the hull's health rather than
  // hooked to a damage callback, because there isn't one that sees everything:
  // bullets, blasts, the club, the strike and every ability in the game reach a
  // boss through their own paths, and all of them show up here as hp going
  // down. Anything that hurts the boat shakes the party on it, with nothing
  // needing to be told about the party.
  //
  // Scaled by the size of the hit against a slice of the hull's own health, so
  // a pea-shooter is a shiver and a fully stacked strike rocks them — and
  // capped, or a late-run burst puts the guests horizontal.
  if (boatState.deck) {
    const hp = e.hp ?? 0;
    if (boatState.lastHp != null && hp < boatState.lastHp) {
      const bite = (boatState.lastHp - hp) / Math.max(1, (e.maxHp ?? 1) * 0.04);
      jostleCrew(e.mesh.position.x, e.mesh.position.y,
        (e.radius ?? 5) * 2.5, Math.min(1.6, bite));
    }
    boatState.lastHp = hp;
  }

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

/**
 * WHAT THIS HULL THROWS.
 *
 * The bombardment is the same mechanism on every boat — the same barrel, the
 * same fuse, the same seeker, the same three patterns — and this is the seam
 * where one of them is allowed to look different without becoming a second
 * fight. A def's `ordnance` block is a set of OVERRIDES merged over a row of
 * the shared GUNS table: an asset key, whether the shot points or tumbles, how
 * fast it tumbles. The yacht uses it to shell you with rolls of cash.
 *
 * Read off the def, exactly like `surfaceBoss` is, so this file still is not
 * told which hull it has — a third boat with its own ordnance is a data row and
 * nothing here changes. A def that says nothing gets the trawler's barrel,
 * which is the whole of what the trawler's row has to say on the subject.
 *
 * WHAT IT DELIBERATELY CANNOT REACH: damage, speed, fuse, blast radius, count
 * and spread all come from CONFIG.bossBoat.patterns and are not in this merge.
 * A hull that could retune those would be a rebalance wearing a look change,
 * and the two yachts-are-trawlers guarantees in bosses.csv would quietly stop
 * being true. Only `radius` moves with the art, and only because a shot the
 * player can be hit by has to be the size of the thing they can see.
 */
function gunFor(e, id) {
  const base = bossGun(id);
  const over = e?.def?.ordnance?.[id];
  return over ? { ...base, ...over } : base;
}

// One shot of whatever pattern is running. Split out so each pattern is a
// paragraph rather than a branch inside a state machine.
function fire(scene, e, playerPos, p) {
  const barrel = gunFor(e, 'barrels');
  const seeker = gunFor(e, 'missiles');
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
