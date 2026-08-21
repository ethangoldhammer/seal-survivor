import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { seabedTopY } from '../arena.js';
import { createVisual, hasModel } from '../assets.js';
import { emit } from '../entities/particles.js';
import { makeEpitaph, revealEpitaph, disposeEpitaph } from './epitaph.js';
// The beam is fired from here as well as from the label. A death is the one
// time the player is not the reason a grave lights up — see the 'glance' phase.
import { sweepGrave } from './graveBeam.js';
import { loadGraveyard, saveGraveyard } from './graveyardStore.js';

// ============================================================================
// GRAVESITES — where the last few seals died, marked on the seabed.
//
// A run ends with the body settling on the floor (systems/deathDive.js, phase
// 'settle'). That spot is the gravesite: a stone falls onto it out of the dark
// above, punches a cloud of silt off the bed, rocks itself still, and then has
// the seal's name and what killed it cut into its face.
//
// THE GRAVEYARD SURVIVES THE TAB CLOSING, and this reversed once.
//
// It was session-only, argued on the grounds that a graveyard is a record of
// THIS SITTING and that the same four stones greeting you a week later is the
// game telling you that you used to be worse at it. That reasoning was
// overtaken by permadeath: systems/nameLedger.js already remembers every seal
// that has ever died, forever, because the rule is meaningless without it. The
// game is already keeping the record — persisting the stones only makes visible
// something that was true anyway.
//
// IT IS STILL NOT A LEDGER, and the cap is what keeps it honest. A handful of
// stones is evidence of the last few times you played; an unbounded field is an
// archive, and an archive is a different feature with a texture budget of its
// own (a yard of six is about 23MB of inscription).
//
// The objection that DID hold was about coordinates: a position is only
// meaningful against the arena bounds it was captured in, and those move with
// the window's aspect. That is answered in systems/graveyardStore.js, which
// stores a fraction of the arena's half-width rather than a world x — read its
// header before touching the stored shape. `y` is still never stored: it is
// re-measured against the live seabed every time a stone is seated.
//
// THE STONES ARE ALREADY REGISTERED. headstone, tomb and plaque live in
// assets.js with one shared scale factor and a measured `forward`/`up` pair
// each, so all three present their inscription face to the camera. That pair
// is not decorative: get it wrong and the stone still stands, still lights,
// and shows the player its 14-centimetre EDGE. See the note there.
//
// TIME. Everything in here runs on the RAW frame delta, not the gameplay one.
// The death dive dilates the world hard — that is its whole job — and a stone
// dropped on the run clock falls in slow motion for the better part of a
// minute while the score card sits waiting for it. Same lesson as the boss
// kill shutter, which is 1.02 seconds of wall clock and 0.175 of the water's.
// ============================================================================

/** Everything that has died this session, oldest first. */
const graves = [];
let nextId = 0;

/** The scene group. Held across restarts — see the header. */
const group = new THREE.Group();
group.name = 'gravesites';

let scene = null;

function cfg() {
  return CONFIG.gravesite ?? {};
}

// --- recording --------------------------------------------------------------

/**
 * File a death. Called once, from the moment the body comes to rest — NOT from
 * killPlayer. The difference is the whole point: killPlayer fires the instant
 * the last point of health goes, with the seal still wherever it was hit, and
 * the body then sinks for several seconds. The gravesite is where the body
 * ENDED UP, which is the only reading a player will accept, and the only one
 * that is guaranteed to be on the floor rather than in mid-water.
 *
 * @param {object} rec
 *   x, z   world position of the body at rest. `y` is not taken: the stone
 *          stands on the seabed, which is a fact about the floor and not about
 *          the corpse, and a stone seated from a body that settled a hair proud
 *          of the bed would float by exactly that hair.
 *   name   the seal's name at the time of death. Banked rather than read later,
 *          because the player is about to be offered a re-roll and the stone
 *          must keep the name that actually played the run.
 *   cause  the sub-line, as deathCauses.js words it.
 */
export function recordGrave({ x, z, name, cause, lead = '', onEtched = null }) {
  const c = cfg();
  const rec = {
    onEtched,
    // Identity, so a label can tell it has moved to a DIFFERENT stone rather
    // than that this one's text changed. Position is not identity here: two
    // runs can end within a unit of each other, and a name is not identity
    // either — dying twice as the same seal is the normal case.
    id: nextId += 1,
    x: Number.isFinite(x) ? x : 0,
    z: Number.isFinite(z) ? z : (c.z ?? -3.2),
    name: String(name ?? '').trim() || 'A SEAL',
    cause: String(cause ?? '').trim(),
    // The connector, rolled once at death from epitaphs.csv and banked with the
    // rest of the stone. Blank falls back to the config default in makeEpitaph,
    // which is what a harness and the look page get.
    lead: String(lead ?? '').trim(),
    stone: null,      // the asset key, chosen at plant time
    object: null,     // the scene object, once planted
    epitaph: null,
    phase: 'pending', // pending -> falling -> settling -> etching -> glance -> done
    clock: 0,
    vy: 0,
    seatY: 0,
    spin: 0,
  };
  graves.push(rec);

  // The oldest stone goes when the yard is full. A cap rather than an
  // unbounded list because each stone is a draw call and a texture, and a
  // player who dies twenty times in a sitting should get a graveyard, not a
  // wall. Oldest-first: the interesting deaths are the recent ones.
  const cap = Math.max(1, Math.floor(c.max ?? 6));
  while (graves.length > cap) retire(graves.shift());

  // Once per death, on the far side of the cap — so what is written is the yard
  // as it will actually stand rather than the yard plus the one just pushed off
  // the end of it.
  saveGraveyard(graves);
  return rec;
}

/**
 * Bring back the stones from previous sessions. Called once, from boot, AFTER
 * the world exists — positions are stored as a fraction of the arena's
 * half-width and resolving them needs the live bounds. See graveyardStore.js.
 *
 * Restored graves are already 'done': they have been dropped, carved and
 * glanced at, in a session that is over. Filing them as 'pending' would have
 * the game re-enact three old deaths over the opening frames of a new run.
 *
 * Their `onEtched` is null, which matters more than it looks — that callback is
 * what puts a score card up, and a restored grave has no card to release.
 */
export function restoreGraves() {
  if (graves.length) return 0; // a session already under way owns the yard
  const c = cfg();
  let n = 0;
  for (const g of loadGraveyard()) {
    graves.push({
      onEtched: null,
      id: nextId += 1,
      x: Number.isFinite(g.x) ? g.x : 0,
      z: Number.isFinite(g.z) ? g.z : (c.z ?? -3.2),
      name: g.name,
      cause: g.cause ?? '',
      lead: g.lead ?? '',
      stone: null,
      object: null,
      epitaph: null,
      phase: 'done',
      clock: 0,
      vy: 0,
      seatY: 0,
      spin: 0,
    });
    n += 1;
  }
  // Trimmed to the LIVE cap rather than the stored one, so turning the yard
  // down in the tuner takes effect on the stones that are already on disk.
  const cap = Math.max(1, Math.floor(c.max ?? 6));
  while (graves.length > cap) retire(graves.shift());
  return n;
}

/**
 * THE DEATH MOMENT, and the only thing main.js has to call. Files the grave,
 * plants the stone, drops it, and calls `onEtched` when the name has finished
 * being cut — which is what puts the score card up.
 *
 * THE CALLBACK IS GUARANTEED, and that is the whole reason this wrapper exists
 * rather than main.js calling recordGrave and plantGraves itself. Every way
 * this can decline to do anything — the yard switched off in the tuner, an
 * asset that never loaded, a canvas with no 2D context — has to still end with
 * the player looking at their score. A gravesite that fails is a missing
 * decoration; a gravesite that fails SILENTLY is a run that ended and left
 * somebody staring at an empty seabed with no button to press.
 *
 * @param {THREE.Scene} target  world.scene
 * @param {object} rec          x, z, name, cause — see recordGrave
 * @param {Function} onEtched   called exactly once, on the far side
 */
export function markDeathSite(target, rec, onEtched) {
  const done = typeof onEtched === 'function' ? onEtched : () => {};
  if (cfg().enabled === false || !target) {
    done();
    return null;
  }
  let grave = null;
  try {
    grave = recordGrave({ ...rec, onEtched: done });
    plantGraves(target);
  } catch (err) {
    console.warn('[gravesite] could not mark the death site', err);
  }
  // Planted but never started — no model, no epitaph, or the cap retired it on
  // the same call. Nothing is going to advance it, so release the card now.
  if (!grave || !grave.object) done();
  return grave;
}

/** Which stone marks a given grave. Seeded off the grave's INDEX rather than
 *  Math.random, so the yard doesn't reshuffle its own history when the floor
 *  moves and everything is re-seated. */
function stoneFor(index) {
  const set = cfg().stones ?? ['headstone', 'plaque', 'tomb'];
  return set[index % set.length] ?? 'headstone';
}

// --- planting ---------------------------------------------------------------

/**
 * Put every recorded grave into the world, and start the drop on any that has
 * not had one yet.
 *
 * MUST be called after preloadAssets resolves. createVisual before the model
 * cache fills silently returns the procedural fallback shape, and the fallback
 * for a stone would be a cone — see the scar tissue noted in systems/decor.js.
 *
 * @param {THREE.Scene} target world.scene, NOT the backdrop group: the backdrop
 *   is disposed and rebuilt wholesale on every resize, which would take the
 *   graveyard with it.
 */
export function plantGraves(target) {
  scene = target ?? scene;
  if (!scene) return group;
  if (group.parent !== scene) scene.add(group);
  if (cfg().enabled === false) return group;

  graves.forEach((rec, i) => {
    if (rec.object) return;
    rec.stone = stoneFor(i);
    // NO STONE UNTIL THE MODEL IS REALLY THERE. createVisual before the cache
    // fills returns the procedural fallback and does it silently — and the
    // fallback for these three entries is a CONE, which would stand a traffic
    // cone on the seabed with somebody's name cut into it and look for all the
    // world like a deliberate joke. Skipped rather than substituted: the grave
    // stays in the list, and the plantGraves call at the top of the next run
    // picks it up once the models are in. See the same scar in systems/decor.js.
    if (!hasModel(rec.stone)) return;
    const object = createVisual(rec.stone);
    // THE ONE SIZE KNOB. Multiplied onto the root rather than written into the
    // asset's `fit`, and that split is the whole point: `fit` is the three
    // stones' shared real-world proportion — one factor makes the headstone
    // 1.8 units, the tomb 4.687 and the plaque 1.172, which is what makes them
    // read as a SET cut from one collection. Editing those individually is how
    // a set becomes three unrelated props. This scales all of them together
    // and leaves that proportion alone.
    //
    // multiplyScalar and never setScalar: the root's scale is where the asset's
    // own size multiplier from assets.csv already lives (`fit` is on a
    // grandchild), so an absolute set would silently eat it.
    // The set's size, times this stone's own. See CONFIG.gravesite.faces: the
    // per-stone factor is a deliberate break from "one shared scale keeps the
    // three in proportion", because the proportion the models were cut at is a
    // REAL-WORLD one and this is a side-view game where a 1.5-unit plaque next
    // to a 5.4-unit headstone reads as a chip of gravel.
    const scale = (cfg().scale ?? 3) * (cfg().faces?.[rec.stone]?.scale ?? 1);
    if (scale !== 1) object.scale.multiplyScalar(scale);
    object.position.set(rec.x, 0, rec.z);
    // A little cant, so a row of them doesn't read as fence posts. Off the
    // index for the same reason the stone choice is.
    object.rotation.z = ((i % 2 ? 1 : -1) * (cfg().lean ?? 0.05));
    rec.object = object;
    group.add(object);

    seat(rec);
    attachEpitaph(rec);

    // A grave planted after its own drop already played — a stone from an
    // earlier run being re-planted — starts where it ended up. Only the newest
    // one falls, and only once.
    if (rec.phase === 'pending') startDrop(rec);
    else finishInstantly(rec);
  });

  return group;
}

/**
 * Measure where the stone's base actually is, then lift it so it lands ON the
 * floor. The same problem decor.js has and for the same reason: assets.js
 * recentres every model on its area-weighted centroid, not on its feet, so the
 * origin is somewhere up inside the stone and by an amount that depends on
 * `fit`, the centroid and any size multiplier. Measured, never assumed.
 */
function seat(rec) {
  const { object } = rec;
  if (!object) return;
  object.position.y = 0;
  object.updateMatrixWorld(true);
  const baseOffset = new THREE.Box3().setFromObject(object).min.y;
  rec.seatY = seabedTopY() - baseOffset - (cfg().sink ?? 0.05);
  object.position.y = rec.seatY;
  // Where the top of the stone ends up, banked HERE because this is the one
  // place that has already paid for the world matrix and a bounding box. The
  // label hangs off this every frame it is up, and measuring a box per frame
  // for a decoration is the kind of cost that never shows in a profile as
  // anything but "the game got slower".
  object.updateMatrixWorld(true);
  const seated = new THREE.Box3().setFromObject(object);
  rec.topY = seated.max.y;
  // Where it STANDS. The label hangs off `topY`; the beam rakes from this, and
  // the difference matters more than it looks — the rake is multiplied by the
  // height above this line, so a beam handed the wrong one is displaced
  // sideways by tilt x whatever it was given. See BEAM_GLSL.
  rec.baseY = seated.min.y;
}

/**
 * Cut the inscription and pin it to the stone's face.
 *
 * The face rectangle is MEASURED off the assembled object rather than declared
 * per stone. Three reasons: the three stones are different shapes on one shared
 * scale factor, so no single rect fits them; `fit` is tunable, so a written
 * rect would drift silently the first time one moved; and the orientation the
 * asset entries already carry guarantees the inscription face is +Z, which
 * makes the front of the bounding box the right plane by construction.
 *
 * The box is taken with the stone at zero rotation. With the lean applied the
 * box is the stone's PROJECTION rather than its face — a couple of degrees is
 * enough to widen it — and the quad would come out oversized and skewed off
 * the stone's edge. Same trap the score card's flip mask hit.
 */
function attachEpitaph(rec) {
  const { object } = rec;
  if (!object) return;

  const lean = object.rotation.z;
  object.rotation.z = 0;
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  object.rotation.z = lean;

  const size = box.getSize(new THREE.Vector3());
  const c = cfg();
  // THIS STONE'S PANEL, or the generic rectangle for one that has none. Two of
  // the three models have a recessed inscription panel cut into them, in a
  // different place on each, and a fraction of the bounding box lands inside it
  // only by luck — see CONFIG.gravesite.faces.
  const face = c.faces?.[rec.stone] ?? {};
  const w = size.x * (face.width ?? c.faceWidth ?? 0.72);
  const h = size.y * (face.height ?? c.faceHeight ?? 0.44);
  if (!(w > 0) || !(h > 0)) return;

  // Built at WORLD size, then divided back down. Everything above is measured
  // in world units off a bounding box, and the quad is about to become a CHILD
  // of a stone whose root carries the size knob — so a quad handed those world
  // numbers directly comes out multiplied by the scale a second time, at the
  // wrong offset, and lands somewhere off the side of the stone. At scale 1
  // that bug is invisible, which is exactly why it has to be written down: the
  // graveyard shipped at 1 and the first thing anybody does is turn it up.
  //
  // World size is also what makes the inscription's resolution right. `dpi` is
  // texels per WORLD unit, so handing makeEpitaph the local size would give a
  // three-times-bigger stone the same canvas and a third of the sharpness, on
  // the one surface in the game whose whole job is to be read.
  const mesh = makeEpitaph({
    name: rec.name, cause: rec.cause, lead: rec.lead, width: w, height: h,
    // Anything the stone's panel wants to say about type size. `width`,
    // `height` and `rise` are this file's business and are stripped out; the
    // rest is the etch block's vocabulary.
    type: faceType(face),
  });
  const s = Math.abs(object.scale.x) || 1;
  mesh.scale.setScalar(1 / s);

  // Local space, so the quad rides the lean and the drop for free. The stone's
  // origin is the centroid, so the face's offset from it is measured, not zero.
  const centre = box.getCenter(new THREE.Vector3());
  mesh.position.set(
    (centre.x - object.position.x) / s,
    (centre.y - object.position.y + size.y * (face.rise ?? c.faceRise ?? 0.12)) / s,
    (box.max.z - object.position.z + (c.faceLift ?? 0.02)) / s,
  );
  object.add(mesh);
  rec.epitaph = mesh;
}

/**
 * The type overrides on a stone's panel entry, separated from the rectangle.
 *
 * One object in the config rather than two, because a person tuning a stone is
 * answering one question — "where does the writing go on this thing" — and
 * splitting it into a rect table and a type table would mean two places to look
 * and two places to forget.
 */
function faceType(face) {
  const { width, height, rise, scale, ...type } = face ?? {};
  return type;
}

// --- the drop ---------------------------------------------------------------

function startDrop(rec) {
  const c = cfg().drop ?? {};
  rec.phase = 'falling';
  rec.clock = 0;
  rec.vy = 0;
  rec.spin = (Math.random() * 2 - 1) * (c.spin ?? 0.6);
  rec.object.position.y = rec.seatY + (c.height ?? 14);
  rec.object.rotation.z += rec.spin;
  revealEpitaph(rec.epitaph, 0);
}

/** An older stone, already part of the scenery. */
function finishInstantly(rec) {
  rec.phase = 'done';
  rec.object.position.y = rec.seatY;
  revealEpitaph(rec.epitaph, 1);
  fireEtched(rec);
}

/**
 * Advance every stone that is still moving.
 *
 * @param {number} rawDt WALL-CLOCK seconds, not the dilated gameplay delta.
 *   See the header — this is the single most important argument in the file.
 */
export function updateGravesites(rawDt) {
  const dt = Math.min(Math.max(rawDt ?? 0, 0), 0.1);
  if (dt <= 0) return;
  const c = cfg().drop ?? {};

  for (const rec of graves) {
    if (!rec.object || rec.phase === 'done' || rec.phase === 'pending') continue;
    rec.clock += dt;

    if (rec.phase === 'falling') {
      rec.vy -= (c.gravity ?? 42) * dt;
      rec.object.position.y += rec.vy * dt;
      // Turning as it comes down, so it reads as a thrown object rather than a
      // lift descending. Damped by the same clock, so it is nearly still by the
      // time it lands and the settle has something small to finish.
      rec.object.rotation.z += rec.spin * dt;

      if (rec.object.position.y <= rec.seatY) {
        rec.object.position.y = rec.seatY;
        land(rec);
      }
      continue;
    }

    if (rec.phase === 'settling') {
      // A short damped rock rather than a bounce: a stone the size of a person
      // does not bounce, it thumps and rings itself still. The overshoot is on
      // ROTATION only — a stone that hopped back into the water would read as
      // rubber, and the one frame of vertical it would buy is not worth it.
      const k = c.settleRate ?? 9;
      const decay = Math.exp(-k * rec.clock);
      const target = rec.baseLean ?? 0;
      rec.object.rotation.z = target + Math.sin(rec.clock * (c.settleHz ?? 22)) * (c.settleTilt ?? 0.05) * decay;

      if (rec.clock >= (c.settleTime ?? 0.9)) {
        rec.object.rotation.z = target;
        rec.phase = 'etching';
        rec.clock = 0;
      }
      continue;
    }

    if (rec.phase === 'etching') {
      const hold = c.etchDelay ?? 0.25;
      const span = Math.max(0.01, c.etchTime ?? 1.4);
      const t = (rec.clock - hold) / span;
      revealEpitaph(rec.epitaph, t);
      if (t >= 1) {
        rec.phase = 'glance';
        rec.clock = 0;
        rec.glanced = false;
      }
      continue;
    }

    // --- the glance ---------------------------------------------------------
    // THE LAST BEAT BEFORE THE SCORE CARD, and the only part of this sequence
    // that exists purely to be looked at.
    //
    // The name has just finished being cut and the obvious thing to do is put
    // the card up — which is exactly the mistake. The card is an interface: the
    // moment it arrives the player is reading numbers and deciding whether to
    // press a button, and whatever is on the seabed behind it has stopped being
    // something they are watching. So the stone gets one unhurried pass of
    // light first, with nothing on screen competing for it, and the run ends on
    // the grave rather than on a menu that happens to have a grave behind it.
    //
    // THE WAIT IS THE SAME WHETHER OR NOT THE BEAM CAN DRAW. sweepGrave does
    // nothing when the yard's beam is switched off or its materials never
    // loaded, and tying the pause to that would make the pacing of a death
    // depend on whether a shader attached — a beat that is there on one machine
    // and not another. The beat is a design decision; the light is a feature on
    // top of it.
    if (rec.phase === 'glance') {
      const delay = Math.max(0, c.glanceDelay ?? 0.35);
      const beam = Math.max(0.05, CONFIG.gravesite?.beam?.time ?? 1.1);
      const tail = Math.max(0, c.glanceTail ?? 0.45);

      // Fired ONCE, on the far side of the beat rather than the instant the
      // etch lands — the two are separate events and running them together
      // reads as the beam being part of the carving.
      if (!rec.glanced && rec.clock >= delay) {
        rec.glanced = true;
        sweepGrave(rec.x, rec.baseY ?? rec.object.position.y);
      }

      if (rec.clock >= delay + beam + tail) {
        rec.phase = 'done';
        rec.clock = 0;
        fireEtched(rec);
      }
    }
  }
}

/**
 * Hand the run back to whoever is waiting on the stone — in practice, the score
 * card. EXACTLY ONCE, and the guard is not defensive tidiness: this callback is
 * the only thing that puts the score screen up, so firing it twice shows the
 * card over itself and never firing it at all is a game that has ended and
 * left the player looking at an empty seabed with no way out.
 */
function fireEtched(rec) {
  const cb = rec.onEtched;
  if (!cb) return;
  rec.onEtched = null;
  cb();
}

/**
 * The stone hits the bed. The silt burst is the SAME emitter the dead seal's
 * own landing uses (CONFIG.emitters.silt, fired by the `seabedImpact` feedback
 * event) — deliberately, because the two events are seconds apart on the same
 * patch of floor and two different clouds would read as two different materials
 * rather than as one seabed being hit twice.
 */
function land(rec) {
  const c = cfg().drop ?? {};
  rec.phase = 'settling';
  rec.baseLean = rec.object.rotation.z % (Math.PI * 2);
  // Snapped to the nearest lean the stone is meant to rest at, so the spin
  // during the fall doesn't leave it face-down. The rotation it settles TO is
  // the small cant plantGraves gave it, not whatever the tumble ended on.
  rec.baseLean = (cfg().lean ?? 0.05) * (rec.baseLean >= 0 ? 1 : -1);
  rec.clock = 0;
  rec.spin = 0;

  // Fired wide rather than at a point: the stone is a couple of units across
  // and a single burst at its centre reads as a puff coming out from under it.
  const spread = c.siltSpread ?? 0.6;
  const y = seabedTopY();
  const puffs = Math.max(1, Math.floor(c.siltPuffs ?? 3));
  for (let i = 0; i < puffs; i += 1) {
    const f = puffs === 1 ? 0 : (i / (puffs - 1)) * 2 - 1;
    emit('silt', rec.x + f * spread, y, { dirX: f, dirY: 1, speedMul: c.siltSpeed ?? 1.15 });
  }
}

// --- housekeeping -----------------------------------------------------------

function retire(rec) {
  if (!rec) return;
  // A stone torn down mid-etch still owes somebody a score card. See fireEtched.
  fireEtched(rec);
  disposeEpitaph(rec.epitaph);
  rec.object?.parent?.remove(rec.object);
  // The stone's GEOMETRY and MATERIAL are not disposed: both belong to the
  // template createVisual cloned from, which the asset cache may hand to the
  // next grave. Disposing them here would blank every stone in the yard.
  rec.object = null;
  rec.epitaph = null;
}

/** Re-seat every stone at the current seabed height. Call after anything that
 *  moves bounds.bottom — the tuner's arena.viewHeight is the path that matters,
 *  exactly as it is for the decor. */
export function reseatGraves() {
  for (const rec of graves) {
    if (!rec.object) continue;
    const y = rec.object.position.y;
    const airborne = rec.phase === 'falling';
    seat(rec);
    if (airborne) rec.object.position.y = y; // still falling; only its target moved
  }
}

/**
 * The stone the seal is standing over, or null.
 *
 * HORIZONTAL DISTANCE ONLY. The graveyard sits on the floor at z = -3.2 and the
 * seal swims the z = 0 plane, so a true distance is never smaller than that gap
 * and every radius would have to be written around a constant that has nothing
 * to do with the question. Depth is not a thing the player can steer in a side
 * view; x is the whole of "am I over it".
 *
 * SETTLED STONES ONLY. A stone still falling has a label that would chase it
 * down through the water, and the one it is about to carry is being cut into
 * its face at that exact moment — reading it out in a caption first is telling
 * the joke before the picture.
 *
 * @param {number} x       the seal's world x
 * @param {number} radius  how close counts, in world units
 */
export function nearestGrave(x, radius) {
  let best = null;
  let bestD = Math.max(0, radius);
  for (const rec of graves) {
    if (!rec.object || rec.phase !== 'done') continue;
    const d = Math.abs(rec.object.position.x - x);
    if (d > bestD) continue;
    bestD = d;
    best = rec;
  }
  if (!best) return null;
  return {
    id: best.id,
    name: best.name,
    cause: best.cause,
    lead: best.lead,
    x: best.object.position.x,
    topY: best.topY ?? best.object.position.y,
    baseY: best.baseY ?? best.object.position.y,
    distance: bestD,
  };
}

/**
 * Rebuild every stone from the config as it now stands. What the tuner calls:
 * size, the stones in rotation, the lean and every number the inscription is
 * cut with are all spent at PLANT time, so without this the sliders move and
 * the graveyard standing in the water does not — which reads as the panel
 * being broken rather than as the yard being built once.
 *
 * The records survive; only the objects are rebuilt. Nothing re-drops and
 * nothing re-fires its callback — these graves have already been marked, and a
 * yard that re-enacts every death in it whenever a slider moves is a worse bug
 * than the one this fixes.
 */
export function restyleGraves() {
  for (const rec of graves) {
    if (!rec.object) continue;
    disposeEpitaph(rec.epitaph);
    rec.object.parent?.remove(rec.object);
    rec.object = null;
    rec.epitaph = null;
    // Not 'pending': that is what plantGraves reads as "this one has never been
    // dropped" and it would throw the stone back into the sky.
    rec.phase = 'done';
  }
  plantGraves(scene);
}

/** What the yard holds. For the tuner readout and for tests. */
export function graveList() {
  return graves.map((g) => ({ x: g.x, z: g.z, name: g.name, cause: g.cause, lead: g.lead, stone: g.stone, phase: g.phase }));
}

/** Tear the whole yard down. The development door and what a harness calls
 *  between simulated sessions — NOT something a restart does. */
export function clearGraves() {
  for (const rec of graves) retire(rec);
  graves.length = 0;
  saveGraveyard(graves);
  group.parent?.remove(group);
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('resize', reseatGraves);
}
