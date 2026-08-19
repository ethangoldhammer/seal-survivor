import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { createVisual } from '../assets.js';
import { removeEnemy, applyKnockback } from '../entities/enemies.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { chillEnemy } from './elements.js';
import { orbitTarget, springFollow } from './orbit.js';
import { player } from '../entities/player.js';
import { projectileCount } from '../stats.js';
import { abilityDamage, aoe, targeting } from './scaling.js';
import { canHold } from './control.js';
import { recordControl } from './playtest.js';
import { hitCreatureSegment } from './hitShape.js';

// Where the wood last met a body. Shared and read immediately — see the note
// on combat.js's own `contact`.
const clubContact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// ---------------------------------------------------------------------------
// THE CLUB — a weapon lashed to the fin tips, swung by THE FINS THEMSELVES.
//
// THE ANIMATION IS THE WEAPON. This system owns no clock of its own. Every
// frame it reads where each flipper is pointing (systems/aimRig.js has just
// solved that against the player's aim) and hands the club a target to chase.
// Spin the fins and the clubs come round with them; flick the aim and they
// crack over like a whip. Whatever the fin controller does, the weapon does —
// which means the attack animation is authored in one place, on the rig, and
// this file never has to be taught about it.
//
// IT CHASES, IT DOES NOT TRACK. The club is on a loose angular spring
// (`stiffness` / `damping`), so it trails the flipper by an angle that grows
// with how fast the fin is moving and overshoots when the fin stops. That lag
// IS the flail: a club welded to the fin direction reads as a rigid prop
// rotating, and the same club a few frames behind reads as a heavy object
// being swung on the end of something. Everything else here — the damage, the
// throw, the caroms — is scaled off the club's own measured angular velocity
// rather than off a configured rate, so the weapon is a readout of the
// animation instead of a system running alongside it.
//
// That is the whole design of the class, and the reason it is not just a
// second shrimp ring. An orbiting companion turns at a rate it chose; a club
// only turns because the animal moved.
//
// A HIT IS A THROW, NOT A TICK. Everything else in the game subtracts hp and
// moves on. A club connects and the body LEAVES — launched along the head's
// tangential travel, out and away from the seal, hard enough to cross a good
// part of the screen. What it hits on the way is hurt by the collision
// (`ricochetDamage`), and the thrown body bounces off it and keeps going, so a
// single whack into a packed school is a break shot. The bounces are the point
// of the weapon; the direct damage is deliberately mediocre so that a club
// swung in open water is a bad club.
//
// Which makes the club the first weapon whose damage depends on the ARENA
// rather than on the target — the same swing is worth one hit in clear water
// and six into a wall of fish. Positioning is the skill it asks for, and it is
// the same skill the strike already asks for, which is why the two stack into
// a style rather than sitting side by side.
//
// Ordering: this must run AFTER updateEnemies for the same reason the octopus
// grabber and Bakalar's net do — a thrown body's position is written directly,
// and enemies.js has already integrated velocity for the frame. Run it first
// and every launch is erased before it can be seen.
// ---------------------------------------------------------------------------

// One entry per SOCKET — a fin tip, or a place on the ring. Shaped
// { mesh, mount, slot, angle, angVel, head, prevHead, cooldowns }. `head` /
// `prevHead` are the swung end of the club this frame and last, which together
// are the swept segment that actually does the hitting.
let clubs = [];
let group = null;
// Bodies currently in the air. Held as a list of records rather than as flags
// on the enemy, because a flight owns state the creature has no business
// carrying around after it lands (bounces left, what it has already hit).
let flights = [];
// Free-running only for the assist spin below — NOT the swing. The swing has
// no clock; it comes off the flippers.
let assistClock = 0;
// The ring's own clock, and the only clock in this file that drives a hit. See
// the note above clubOrbiters for why the orbiting clubs are allowed one when
// the fin clubs emphatically are not.
let orbitClock = 0;

// THE FOUR KINDS OF CLUB, in the order they are checked for a run that somehow
// arrives holding several at once (a debug jump, a harness). The order a run
// actually TOOK them in beats this — see clubTypesFor.
const CLUB_TYPES = [
  { key: 'club', asset: 'club' },
  { key: 'boom', asset: 'clubBoom' },
  { key: 'ice', asset: 'clubIce' },
  { key: 'throw', asset: 'clubThrow' },
];

// WHICH CLUB THE RUN PICKED UP FIRST, remembered rather than derived. The fin
// club is "the first one you equipped", which is a fact about the run's
// history and not about the level table — two runs holding {club 1, ice 1}
// took them in some order, and a fixed priority list would put the same club
// in the fins for both and quietly contradict the card that just arrived.
//
// Sticky on purpose: once a type is in the fins it stays there for the run.
// Cleared by resetClub with everything else.
let typeOrder = [];


const _pivot = new THREE.Vector3();
const _boneAt = new THREE.Vector3();

// Fold an angle into (-PI, PI]. A club chasing a flipper that has just crossed
// the -PI/+PI seam must take the SHORT way round: without this the spring sees
// six radians of error and slings the weapon a full turn backwards, which
// reads as the club detaching rather than as a swing.
//
// Deliberately a local copy of the one in systems/rigidBody.js rather than an
// import: that file is a body simulator this weapon has no other reason to
// depend on, and three lines of angle arithmetic is a cheaper thing to repeat
// than a coupling to it.
function wrapAngle(a) {
  const TAU = Math.PI * 2;
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

export function createClubVisual() {
  group = new THREE.Group();
  return group;
}

/**
 * Every club type the run owns, in the order it took them.
 *
 * Types already seen keep the slot they were first given; anything new is
 * appended in CLUB_TYPES order, which only decides ties inside a single frame
 * (a debug jump handing over two cards at once).
 *
 * Pure with respect to `levels` — it reads the remembered order but does not
 * add to it. `noteTypes` is the one thing that writes, and it is called once a
 * frame from updateClub, so the card text and the tuner readout can ask this
 * without quietly deciding which club the seal is holding.
 */
export function clubTypesFor(levels = {}) {
  const level = (t) => Math.max(0, Math.floor(levels[t.key] ?? 0));
  const owned = CLUB_TYPES.filter((t) => level(t) > 0);
  const seen = owned.filter((t) => typeOrder.includes(t.key))
    .sort((a, b) => typeOrder.indexOf(a.key) - typeOrder.indexOf(b.key));
  const fresh = owned.filter((t) => !typeOrder.includes(t.key));
  return [...seen, ...fresh].map((t) => ({ key: t.key, asset: t.asset, level: level(t) }));
}

// Remember any type the run has just started owning. Called once a frame, from
// the one place that is entitled to decide the run's history has moved on.
function noteTypes(levels) {
  for (const t of CLUB_TYPES) {
    if (!(levels[t.key] > 0) || typeOrder.includes(t.key)) continue;
    typeOrder.push(t.key);
  }
}

/**
 * Which club assets go in the FINS, in fin order.
 *
 * THE FIRST TYPE YOU TOOK IS THE ONE YOU HOLD. Every fin gets that same club,
 * so the weapon in the seal's flippers is one identifiable object rather than
 * a pair that disagrees — and so the answer to "what am I swinging" does not
 * change when a rider card lands.
 *
 * Falls back to the base club when the run owns nothing yet, which is also
 * what a run with the base card alone should look like.
 */
export function clubAssetsFor(levels = {}) {
  const first = clubTypesFor(levels)[0];
  return [first ? first.asset : 'club'];
}

/**
 * Which club assets ride the RING, one entry per club.
 *
 * THE SPARE CLUBS ORBIT. The seal has two fins and the run can own four kinds
 * of club, so everything past the first type used to fight for a socket — and
 * a card whose only visible effect is a mesh you cannot see is a card that
 * reads as nothing. Every type after the first floats around the animal
 * instead, one club per stack, so a third pick of Cold Snap is three clubs on
 * the ring and you can count them.
 *
 * They are real clubs: same swept hit test, same damage, same riders. What
 * they do not have is the fin's flop — nothing is holding them, so there is no
 * flipper for the water to drag them against, and they ride the ring and
 * tumble at a rate CONFIG.club.orbit.spin chooses. That is a deliberate break
 * from "the animation is the weapon" and the only one in this file: an orbiter
 * is a companion that happens to be made of wood, and pretending otherwise
 * would mean a ring that goes limp whenever the seal swims in a straight line.
 */
export function clubOrbiters(levels = {}) {
  const out = [];
  for (const t of clubTypesFor(levels).slice(1)) {
    for (let i = 0; i < t.level; i++) out.push(t.asset);
  }
  return out;
}

// Build one club mesh and measure it. Split out from addClub because a socket
// can be handed a DIFFERENT club later — the frame a variant card is taken —
// and that swap needs exactly this and none of the socket state around it.
function buildClubMesh(asset = 'club') {
  const mesh = createVisual(asset);
  mesh.userData.clubAsset = asset;
  // The scale createVisual just wrote is `fit` normalisation times the asset's
  // own size multiplier from assets.csv. Stash it and multiply, rather than
  // setScalar-ing over the top of it every frame: assigning would throw the
  // csv row away (a club that ships at 1.0 whatever the table says), and
  // multiplying in place would compound the slider once per frame until the
  // club filled the arena. Same fix as applyCompanionScale in scaling.js.
  mesh.userData.clubBaseScale = mesh.scale.x;
  // WHERE THIS MESH'S BASE IS, measured rather than assumed. Two conventions
  // reach this line and they disagree: a loaded model is pivoted at its handle
  // (ASSETS.club.pivot), so its origin IS the grip; the procedural fallback is
  // a shape centred on its origin, so half of it sticks out behind. Hard-coding
  // either one puts the other club through the seal's flipper — and since the
  // fallback is what every Node harness sees and the model is what the game
  // sees, that mismatch is invisible in exactly the place it would be caught.
  //
  // createVisual has already oriented the asset so its forward runs down +Y,
  // so the distance from the origin back to the base is just -box.min.y.
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  mesh.userData.clubGripLocal = Math.max(0, -box.min.y);
  return mesh;
}

function addClub(asset = 'club', mount = 'fin') {
  const mesh = buildClubMesh(asset);
  group.add(mesh);
  clubs.push({
    mesh,
    // 'fin' — socketed in a flipper, swung by the rig. 'orbit' — riding the
    // ring. The only two things that differ are where the pivot comes from
    // and what the shaft is chasing; everything downstream (the swept test,
    // the damage, the launch, the riders) is shared, which is the point.
    mount,
    // Which place on the ring this one holds. Meaningless for a fin club.
    slot: 0,
    // Where an orbiter actually IS, as opposed to where the ring says it
    // should be. Springs toward the target so the ring lags on a turn — a
    // club pinned to its orbit point reads as a decal on the player.
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    // Where the club is pointing and how fast that is changing. The spring
    // state — this is the flail, and it is per club because the two flippers
    // do not move together.
    angle: 0,
    angVel: 0,
    // THE SOCKET. A club is either in the fin or it isn't: the Hurler throws
    // the actual clubs off the flippers, and until they come back this fin has
    // nothing to swing. `armed` false means no mesh, no hitbox, no swing.
    armed: true,
    respawnLeft: 0,
    head: new THREE.Vector3(),
    prevHead: new THREE.Vector3(),
    // Per-club, per-enemy re-hit lock. Per CLUB and not global: two clubs
    // sweeping the same crab from opposite sides should both connect, which is
    // what makes swimming through a crowd feel like a threshing machine.
    cooldowns: new Map(),
    primed: false, // false until the head has a real previous position
  });
}

function removeClub() {
  const c = clubs.pop();
  if (c) group.remove(c.mesh);
}

/**
 * Make the sockets match the fins AND the cards.
 *
 * Takes the whole arrangement as a list — the fin sockets first, in fin order,
 * then the ring — because the two are decided together and a call that set one
 * without the other would leave the ring holding a club the fins have just
 * been given.
 *
 * Rebuilds a club whose asset has changed, which is what makes a variant show
 * up the moment its card is taken rather than on the next run — the mesh is
 * built once at spawn and there is no other point where a level-up could reach
 * it. Cheap: the comparison is a string, and the rebuild only fires on the one
 * frame the owned set actually moves.
 *
 * @param spec array of { asset, mount }
 */
function syncSockets(spec) {
  while (clubs.length < spec.length) {
    const want = spec[clubs.length];
    addClub(want.asset, want.mount);
  }
  while (clubs.length > spec.length) removeClub();

  let slot = 0;
  for (let i = 0; i < clubs.length; i++) {
    const want = spec[i];
    const club = clubs[i];
    // A socket that has changed what it IS starts over. The spring state below
    // is kept across a mesh swap on purpose, but a club that has just moved
    // between the flipper and the ring is somewhere else entirely, and keeping
    // its `primed` head would sweep a hit across everything in between.
    if (club.mount !== want.mount) {
      club.mount = want.mount;
      club.primed = false;
      club.armed = true;
      club.respawnLeft = 0;
      club.cooldowns.clear();
      // Explicitly, and this is not belt-and-braces. A socket that was a fin
      // MID-THROW is invisible, and the loop below only ever turns a mesh back
      // on down the `!armed` branch — which re-arming here has just skipped.
      // Without this line, moving a card while the clubs are in the air leaves
      // an orbiter that hits, sounds and shoves and cannot be seen.
      club.mesh.visible = true;
    }
    club.slot = want.mount === 'orbit' ? slot++ : 0;
    if (club.mesh.userData.clubAsset === want.asset) continue;
    // Swap the mesh, keep the socket. The spring state, the respawn timer and
    // the re-hit locks all belong to the FIN, not to the lump of wood in it —
    // rebuilding the whole entry would snap a mid-swing club back to rest and
    // hand a thrown fin its club back early.
    group.remove(club.mesh);
    const mesh = buildClubMesh(want.asset);
    group.add(mesh);
    mesh.visible = club.armed;
    club.mesh = mesh;
  }
}

// --- the numbers, per level ------------------------------------------------
//
// Exported so the tuner readout and the card text can ask the same functions
// the weapon itself uses, rather than re-deriving the curve and drifting.

/** What one connecting swing hits for. */
export function clubDamage(level) {
  const c = CONFIG.club;
  return c.damage + c.damagePerLevel * Math.max(0, level - 1);
}

/** How far the head sits from the fin tip — the weapon's whole reach. */
export function clubLength(level) {
  const c = CONFIG.club;
  return c.length + c.lengthPerLevel * Math.max(0, level - 1);
}

/** How many bodies a thrown body may carom off before it settles. */
export function clubBounces(level) {
  const c = CONFIG.club;
  return Math.floor(c.maxBounces + c.bouncesPerLevel * Math.max(0, level - 1));
}

/** How many clubs are actually in the FINS right now. */
export function clubsInHand() {
  let n = 0;
  for (const club of clubs) if (club.armed && club.mount === 'fin') n++;
  return n;
}

/** How many clubs are riding the ring right now. */
export function clubsOrbiting() {
  let n = 0;
  for (const club of clubs) if (club.mount === 'orbit') n++;
  return n;
}

/**
 * Take every club out of its socket — they have just been thrown.
 *
 * Returns how many were actually there to throw. The Hurler hurls the REAL
 * clubs off the flippers rather than conjuring copies, so the cost of the
 * ability is that the melee weapon is gone until they come back: throw, and
 * for `respawnTime` the seal is swimming with empty fins.
 *
 * THE RING IS NOT THROWN. The cost of this card is the weapon leaving your
 * HANDS, and the orbiting clubs are not in them — they are a second thing the
 * run bought, on their own cards, and emptying them here would mean a Hurler
 * pick silently deleting somebody else's Cold Snap stacks for two seconds.
 */
export function disarmClubs() {
  const c = CONFIG.club;
  let taken = 0;
  for (const club of clubs) {
    if (!club.armed || club.mount !== 'fin') continue;
    club.armed = false;
    club.respawnLeft = c.respawnTime;
    club.mesh.visible = false;
    // Drop the re-hit locks with the club. They belong to a weapon that is no
    // longer in this hand, and a club that comes back should connect on the
    // first swing rather than honouring a cooldown from before it left.
    club.cooldowns.clear();
    taken++;
  }
  return taken;
}

/**
 * How fast the clubs are actually swinging right now, radians/sec, measured.
 *
 * The fastest of the pair rather than an average: what the sound and the
 * throw care about is whether A club is moving, and a seal mid-turn has one
 * flipper whipping and one nearly still.
 *
 * MEASURED, not configured. There is no "swing rate" number anywhere in this
 * weapon — the fins move, the springs chase, and this reports what came out.
 */
export function clubSwingSpeed() {
  let fastest = 0;
  for (const club of clubs) fastest = Math.max(fastest, Math.abs(club.angVel));
  return fastest;
}

/**
 * Where a club WANTS to lie, given how the seal is moving.
 *
 * THE DRAG IS THE ANIMATION. A loose weight socketed in a flipper and hauled
 * through water streams out BEHIND the direction of travel — so the target is
 * the reciprocal of the velocity, and the faster the seal goes the harder that
 * wins. Swim right and both clubs trail left; turn, and they swing across the
 * body to catch up. That crossing is where the hits come from, which is why
 * the weapon rewards changing direction rather than holding a line.
 *
 * Under way it is drag; at rest it is gravity (`droop`, applied by the caller),
 * and `finFollow` keeps a share of the flipper's own pointing direction in the
 * blend so a club still reads as being HELD rather than as hanging off a
 * string. Returns an absolute angle.
 */
function flopTarget(finAt, vx, vy, angVel) {
  const c = CONFIG.club;
  const speed = Math.hypot(vx, vy);
  // Where the flipper is pointing, or straight down if there is no rig to ask.
  const held = finAt ?? -Math.PI / 2;

  // How completely the water wins, 0..1. Ramped rather than switched: a seal
  // easing into a swim should see its clubs ease backward, not snap.
  const pull = speed < 1e-4 ? 0
    : Math.min(1, speed / Math.max(1e-3, c.dragFullSpeed)) * c.velocityFollow;
  // Blended the short way round, or a club whose drag target has just crossed
  // the seam takes the long way and visibly rotates through the animal.
  let target = pull > 0 ? held + wrapAngle(Math.atan2(-vy, -vx) - held) * pull : held;

  // GRAVITY GETS WHATEVER THE WATER DOESN'T. A heavy thing sags when nothing
  // is holding it out, so the sag is gated on `1 - pull` — the share of the
  // club the flow has NOT claimed — and not on how fast the club happens to
  // be rotating. That was the bug: a club streaming flat behind a cruising
  // seal has almost no angular velocity, so an angVel-gated droop read it as
  // idle and sagged it 45 degrees off the drag it was supposed to be lying
  // along. The spin term stays as a second condition, so a club mid-swing
  // isn't dragged downward through its own arc.
  if (c.droop > 0) {
    const still = 1 - Math.min(1, Math.abs(angVel) / Math.max(1e-3, c.droopCutoff));
    const limp = (1 - pull) * still;
    if (limp > 0) target += wrapAngle(-Math.PI / 2 - target) * c.droop * limp;
  }
  return target;
}

/**
 * Where a flipper is pointing, as an angle in the play plane.
 *
 * Two sources, in order of how much they actually know:
 *   1. the fin's own last bone -> its tip. This is the flipper's POINTING
 *      direction, which is what the aim controller is solving for, and it is
 *      what should drive the weapon.
 *   2. failing that (a rig that published tips but no chains, or a stand-in),
 *      the body -> tip direction. A flipper swung in a circle carries its tip
 *      around the body, so this still spins when the fin spins; it is simply
 *      coarser about which way the limb is facing.
 */
function finAngle(rig, i, tip, playerPos) {
  const chain = rig?.fins?.[i];
  if (chain?.tip?.getWorldPosition) {
    chain.tip.getWorldPosition(_boneAt);
    const dx = tip.x - _boneAt.x;
    const dy = tip.y - _boneAt.y;
    if (dx * dx + dy * dy > 1e-8) return Math.atan2(dy, dx);
  }
  const bx = tip.x - playerPos.x;
  const by = tip.y - playerPos.y;
  if (bx * bx + by * by > 1e-8) return Math.atan2(by, bx);
  return null;
}

// ---------------------------------------------------------------------------
// THE TWO RIDERS — Powder Keg and Cold Snap.
//
// Neither is a weapon. Each is a thing that happens ON TOP of a club hit,
// which is why they live here as a few lines rather than as systems of their
// own: they ride EVERY club in the run at once — the swing off the fin, the
// body caroming through a crowd, and the thrown variant — so a run that has
// taken the club line gets one coherent upgrade rather than three weapons
// that happen to share a name.
//
// They also stack with each other on purpose. A frozen body is a body that
// stays where the blast put it.
// ---------------------------------------------------------------------------

/** What a club hit's blast does at this level, or null if the card isn't owned. */
export function clubBlast(level) {
  const c = CONFIG.clubBoom;
  if (!c?.enabled || !(level > 0)) return null;
  return {
    damage: abilityDamage(c.damage + c.damagePerLevel * (level - 1)),
    radius: aoe(c.radius + c.radiusPerLevel * (level - 1)),
  };
}

/** The ice a club hit puts on a body, or null if the card isn't owned. */
export function clubIce(level) {
  const c = CONFIG.clubIce;
  if (!c?.enabled || !(level > 0)) return null;
  return {
    slow: c.slowPerHit + c.slowPerHitPerLevel * (level - 1),
    duration: c.duration,
    freezeFor: c.freezeFor + c.freezeForPerLevel * (level - 1),
  };
}

/**
 * Set off a blast at a point, hurting everything but `exclude`.
 *
 * Victims are collected BEFORE any of them are damaged. hurt() removes a dead
 * body from `enemiesList` on the spot, and a blast that killed as it scanned
 * would shift the array under its own loop — the same reason main.js defers
 * every splash in the game through a queue rather than bursting inline.
 */
function detonate(scene, x, y, blast, enemiesList, exclude, hooks) {
  const caught = [];
  for (const other of enemiesList) {
    if (other === exclude || (Array.isArray(exclude) && exclude.includes(other))) continue;
    const dx = other.mesh.position.x - x;
    const dy = other.mesh.position.y - y;
    if (dx * dx + dy * dy > blast.radius * blast.radius) continue;
    caught.push(other);
  }
  for (const other of caught) hurt(scene, other, blast.damage, enemiesList, hooks);
  hooks.onBlast?.(x, y, blast.radius, caught.length);
  return caught.length;
}

/** Is this body already in the air? Returns its live flight, or null. */
function flightFor(e) {
  for (const f of flights) if (f.e === e && !f.dead) return f;
  return null;
}

/**
 * Put a body in the air.
 *
 * Reuses any record it already had rather than adding a second — the hit loop
 * already refuses to re-whack a body that is flying, so this only comes up for
 * a body that has landed, but two live flights for one creature would
 * integrate its position twice per frame and fling it off the map.
 */
function launch(e, dirX, dirY, speed, level) {
  const existing = flightFor(e);
  const f = existing ?? { e, vx: 0, vy: 0, bounces: 0, life: 0, lock: new Map(), dead: false };
  f.vx = dirX * speed;
  f.vy = dirY * speed;
  f.bounces = clubBounces(level);
  f.life = CONFIG.club.flightTime;
  f.dead = false;
  f.lock.clear();
  if (!existing) flights.push(f);
  return f;
}

// Hand what's left of a flight back to the shared shove channel and forget it.
// Deliberately not a dead stop: a body whose bounces ran out should coast and
// settle like anything else that has been knocked about (enemies.js integrates
// and decays knockX/knockY), not stop dead in open water on the frame its
// counter hit zero.
function land(f) {
  const e = f.e;
  e.knockX = (e.knockX ?? 0) + f.vx * (CONFIG.club.landHandoff ?? 0);
  e.knockY = (e.knockY ?? 0) + f.vy * (CONFIG.club.landHandoff ?? 0);
}

/**
 * Damage a body, and clean up if that killed it.
 *
 * Returns true if it died. The index lookup happens HERE, at the moment of the
 * kill, rather than being passed in: every caller in this file is iterating
 * something other than `enemiesList` (the club list, the flight list), so an
 * index captured earlier in the frame may already have been invalidated by an
 * earlier kill in the same frame.
 */
function hurt(scene, e, dmg, enemiesList, hooks, at = null) {
  e.hp -= dmg;
  e.flash = CONFIG.fx.hitFlash;
  e.hitThisFrame = true;
  // `at` is where the wood landed, when the caller knows. The blast path
  // doesn't — a detonation catching a body several metres away has no contact
  // point on it — and passes nothing, which leaves the feedback where it has
  // always been: on the creature.
  hooks.onEnemyDamaged?.(e, dmg, at?.x, at?.y, null, null, at);
  if (e.hp > 0) return false;

  hooks.onEnemyKilled?.(e);
  const index = enemiesList.indexOf(e);
  if (index >= 0) removeEnemy(scene, index);
  // Whatever it was doing in the air, it isn't any more. FLAGGED, not spliced:
  // a kill can land on any flight from inside the flight loop, and removing an
  // entry the loop has already walked past shifts every later entry down an
  // index — which silently integrates one of them twice on the same frame.
  // The list is compacted once, at the end of the loop, where that can't bite.
  for (const f of flights) if (f.e === e) f.dead = true;
  return true;
}

/**
 * @param dt
 * @param scene
 * @param playerPos
 * @param levels  { club, boom, ice } — the three club cards' stacks. An object
 *                rather than three positional numbers because two of them are
 *                riders that do nothing on their own, and a call site with
 *                three bare integers in a row is a call site where two of them
 *                will eventually be swapped.
 * @param enemiesList
 * @param motion  { rig, velocity, dashing } — the aim rig the fin tips come
 *                from (systems/aimRig.js), the seal's VELOCITY (not just its
 *                speed: the clubs stream out behind the direction of travel,
 *                so the heading is the input), and whether a strike dash is in
 *                flight. Passed in rather than imported so this stays testable
 *                without a player. A bare `speed` is still accepted and is
 *                read as "moving, direction unknown".
 * @param hooks   { onEnemyDamaged(e, dmg), onEnemyKilled(e),
 *                  onWhack(x, y, speed), onRicochet(x, y, n),
 *                  onBlast(x, y, radius, caught), onFreeze(x, y) }
 */
export function updateClub(dt, scene, playerPos, levels, enemiesList, motion = {}, hooks = {}) {
  if (!group) return;
  const c = CONFIG.club;
  // A bare number still works, and is what every harness and the tuner pass
  // when they only care about the base weapon.
  const lv = typeof levels === 'number' ? { club: levels } : (levels ?? {});
  const boomLv = Math.max(0, Math.floor(lv.boom ?? 0));
  const iceLv = Math.max(0, Math.floor(lv.ice ?? 0));
  const throwLv = Math.max(0, Math.floor(lv.throw ?? 0));

  // `alwaysOn` is an AUTHORING switch, not a balance one: it puts clubs in the
  // fins without the card so a model, a tint or a flop curve can be judged
  // without rolling the upgrade first. Off by default — with it on, every run
  // starts armed.
  //
  // ANY CLUB CARD ARMS THE SEAL, and this is the other half of that. The
  // riders and the Hurler are deliberately takeable WITHOUT Driftwood Club —
  // a card that can be dealt as a dead pick is worse than one that is merely
  // better in the right build — but the weapon used to be gated on `lv.club`
  // alone, which made them exactly that dead pick. A run that took Cold Snap
  // and Powder Keg and no base card got no clubs at all: both cards did
  // nothing, and there was nothing on screen to explain why. A variant on its
  // own now swings a level-1 club, which is what its card has claimed all
  // along.
  const carried = (boomLv || iceLv || throwLv) ? 1 : 0;
  const level = Math.max(c.alwaysOn ? 1 : 0, carried, Math.floor(lv.club ?? 0));
  const blast = clubBlast(boomLv);
  const ice = clubIce(iceLv);
  const active = !!c?.enabled && level > 0;

  group.visible = active;
  if (!active) {
    if (clubs.length) syncSockets([]);
    // Anything still in the air when the weapon goes away (a tuner toggle
    // mid-run) is put down rather than frozen in place forever.
    for (const f of flights) land(f);
    flights.length = 0;
    return;
  }

  const { rig = null, velocity = null, dashing = false } = motion;
  // The velocity the flop is read from. A caller that only knows a scalar
  // speed still gets a sensible weapon — the drag simply has no heading to
  // stream along, so the fin's own direction carries it.
  const vx = velocity?.x ?? 0;
  const vy = velocity?.y ?? 0;
  const speed = velocity ? Math.hypot(vx, vy) : (motion.speed ?? 0);

  // One club per fin tip the model actually publishes. A rig with no fins (a
  // ship model that never had them, or a model still loading) leaves the
  // weapon with nothing to hang off, which is a silent no-op by design — the
  // same degradation every emit point in the game already does.
  const tips = rig?.muzzles ?? [];

  // THE WHOLE ARRANGEMENT, decided once. The run's first club type goes in
  // every fin; every other type it owns rides the ring, one club per stack. A
  // run holding one type has no ring at all, which is what a run with one club
  // card should look like.
  //
  // `noteTypes` is called here and nowhere else — this is the one place in the
  // game entitled to say that the run has just picked up a kind of club it did
  // not have, and the fin club is decided by that history rather than by a
  // priority list. See clubTypesFor.
  const owned = { club: Math.floor(lv.club ?? 0), boom: boomLv, ice: iceLv, throw: throwLv };
  noteTypes(owned);
  const finAsset = clubAssetsFor(owned);
  const orbiters = clubOrbiters(owned);
  const spec = [];
  for (let i = 0; i < tips.length; i++) spec.push({ asset: finAsset[i % finAsset.length], mount: 'fin' });
  for (const asset of orbiters) spec.push({ asset, mount: 'orbit' });
  syncSockets(spec);
  if (clubs.length === 0) {
    // Nothing to hang the weapon off this frame — a model being swapped in the
    // T-menu, or a rig that hasn't resolved yet. Anything ALREADY thrown still
    // has to finish its flight: returning outright here freezes those bodies
    // mid-air, holding a live reference to each one, for the rest of the run.
    updateFlights(dt, scene, enemiesList, level, blast, ice, hooks);
    return;
  }

  assistClock += dt;
  orbitClock += dt;
  const length = clubLength(level);
  const headRadius = c.headRadius;
  const damage = abilityDamage(clubDamage(level));
  const ring = c.orbit ?? {};
  const ringCount = clubsOrbiting();

  for (let i = 0; i < clubs.length; i++) {
    const club = clubs[i];
    const orbiting = club.mount === 'orbit';

    // THE SOCKET IS EMPTY — thrown, and not back yet. No mesh, no swing, no
    // hitbox. Ticked before anything else so the frame it refills is a frame
    // it can already hit on.
    if (!club.armed) {
      club.respawnLeft -= dt;
      if (club.respawnLeft > 0) { club.mesh.visible = false; continue; }
      club.armed = true;
      club.respawnLeft = 0;
      club.mesh.visible = true;
      // Comes back IN the fin rather than springing in from wherever it was
      // when it left, which would fling a fresh club across the arena on its
      // first frame.
      club.primed = false;
    }

    let target;
    if (orbiting) {
      // THE RING. Where this club's place on it currently is (systems/orbit.js
      // owns the shape — tilted, squashed, one slot per club), sprung rather
      // than pinned so the ring lags on a turn and swings wide coming out of
      // one. A club welded to its orbit point reads as a decal painted on the
      // player; a club that has to catch up reads as a thing being towed.
      const at = orbitTarget(orbitClock, playerPos, {
        orbitRadius: ring.radius,
        orbitSpeed: ring.speed,
        orbitDepth: ring.depth,
        bobAmount: ring.bob,
      }, club.slot, ringCount);
      if (!club.primed) club.pos.copy(at);
      springFollow(club.pos, club.vel, at, dt, ring.spring ?? 26, ring.damp ?? 6);
      _pivot.copy(club.pos);
      // ITS OWN TUMBLE, and no flop. Nothing is holding an orbiting club, so
      // there is no flipper for the water to drag it against — feeding it
      // through flopTarget would have the ring go limp exactly when the seal
      // is swimming in a straight line, which is most of a run. `spin` is
      // therefore a chosen rate, and it is what an orbiter hits for: the
      // power below is measured off the angular velocity this produces.
      target = orbitClock * (ring.spin ?? 0) + club.slot * 1.7;
    } else {
      _pivot.copy(tips[i]);
      // Flattened onto the body's plane for the same reason every muzzle is: the
      // two flippers are separated by pure camera depth in side view, and a club
      // swung at the fin's own z sorts behind the water plane on one side of the
      // seal and in front of it on the other.
      if (CONFIG.fins.flattenZ) _pivot.z = playerPos.z;

      // WHERE IT WANTS TO LIE: dragged out behind the seal's travel, eased back
      // toward the flipper's own direction as the animal slows. See flopTarget.
      const finAt = finAngle(rig, i, tips[i], playerPos);
      // `assistSpin` adds a slow turn of its own on top of that. It exists so
      // the weapon still swings on a rig whose flippers only ever point at the
      // cursor, on a run where the player is barely moving — set it to 0 once
      // the fins drive themselves and the flop is purely the water's.
      // (the sag lives in flopTarget, blended against the drag rather than
      // applied on top of it — see the comment there)
      target = flopTarget(finAt, vx, vy, club.angVel) + assistClock * c.assistSpin;
    }

    if (!club.primed) {
      // First frame: start ON the fin rather than springing to it from zero,
      // or every new club swings once across the whole screen on spawn.
      club.angle = target;
      club.angVel = 0;
    }

    // THE FLAIL. A loose angular spring chasing the flipper. The error is
    // wrapped so the club always takes the short way round, and the damping is
    // exponential so it is framerate-independent — a spring integrated the
    // naive way changes stiffness with the frame time, which is how a weapon
    // ends up feeling different on a 144Hz monitor.
    const err = wrapAngle(target - club.angle);
    club.angVel += err * c.stiffness * dt;
    club.angVel *= Math.exp(-c.damping * dt);
    // A ceiling, because a spring given an impulsive target (an aim that
    // snapped across the screen) can wind itself up past the point where the
    // swept hit test can keep up.
    const cap = c.maxSwing;
    if (club.angVel > cap) club.angVel = cap;
    else if (club.angVel < -cap) club.angVel = -cap;
    club.angle = wrapAngle(club.angle + club.angVel * dt);

    const angle = club.angle;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    // HOW FAR THIS ONE REACHES. An orbiter is a smaller club — it is further
    // from the animal and a stack of five at fin size is a wall of wood the
    // player cannot see the water through — and the reach follows the drawing
    // rather than being set beside it, so the hitbox and the mesh can never
    // disagree about how long the stick is.
    const reach = length * (orbiting ? (ring.scale ?? 1) : 1);

    club.prevHead.copy(club.primed ? club.head : _pivot);
    club.head.set(_pivot.x + dirX * reach, _pivot.y + dirY * reach, _pivot.z);
    club.primed = true;

    // THE GRIP SITS ON THE FIN TIP, whichever way the art is built: the mesh
    // is pushed out by its own measured base offset (see addClub), so the butt
    // of the club lands on the flipper and the shaft runs outward from it.
    //
    // `reachScale` keeps the drawing honest as the card stacks: reach grows
    // per level, and a club that stayed one size would be swinging two units
    // of wood through four units of hitbox.
    const reachScale = reach / Math.max(1e-3, c.length);
    const drawScale = (club.mesh.userData.clubBaseScale ?? 1) * c.scale * reachScale;
    const along = (club.mesh.userData.clubGripLocal ?? 0) * c.scale * reachScale + c.gripOffset;
    club.mesh.position.set(_pivot.x + dirX * along, _pivot.y + dirY * along, _pivot.z + c.depth);
    // createVisual points a model's forward down world +Y, so a shaft that
    // should lie along `angle` turns by angle - 90 degrees.
    club.mesh.rotation.z = angle - Math.PI / 2;
    club.mesh.scale.setScalar(drawScale);

    // How hard THIS club is swinging, as a share of a good full-speed swing.
    // Everything the hit does is scaled by it, which is what makes the weapon
    // a readout of the animation rather than a system with its own tempo.
    const swing = Math.abs(club.angVel);
    const power = Math.min(c.powerMax, swing / Math.max(1e-3, c.powerReference));
    const launchSpeed = c.launchSpeed * power * (dashing ? c.dashLaunchMul : 1);

    for (const [enemy, t] of club.cooldowns) {
      const left = t - dt;
      if (left <= 0) club.cooldowns.delete(enemy);
      else club.cooldowns.set(enemy, left);
    }

    // A CLUB THAT IS NOT MOVING DOES NOT HURT. The literal reading of "the
    // animation is the weapon", and a necessary one: without it a club left
    // lying against a crab grinds it down at the contact cooldown for as long
    // as the player stands still, which is a damage source nobody performed.
    if (swing < c.minSwing) continue;

    // Tangential travel of the head — the direction a struck body is thrown.
    // Perpendicular to the shaft, signed by which way the swing is going, and
    // then leaned OUTWARD by `outwardShare` so bodies are sent away from the
    // seal instead of being spun around it into the other fin.
    //
    // WHAT "OUTWARD" MEANS DEPENDS ON WHERE THE CLUB IS. For a fin club the
    // shaft already points away from the animal — the grip is on the flipper,
    // an arm's length from the body — so the shaft direction IS outward. An
    // orbiter's grip is metres out on the ring and its shaft points wherever
    // the tumble has it this frame, which is as often back INTO the seal as
    // away from it; using the shaft there would fire half the crowd through
    // the player. Measured from the animal instead, which is what the number
    // has always meant.
    let outX = dirX;
    let outY = dirY;
    if (orbiting) {
      const ox = _pivot.x - playerPos.x;
      const oy = _pivot.y - playerPos.y;
      const olen = Math.hypot(ox, oy);
      if (olen > 1e-4) { outX = ox / olen; outY = oy / olen; }
    }
    const sign = club.angVel >= 0 ? 1 : -1;
    let throwX = -dirY * sign * (1 - c.outwardShare) + outX * c.outwardShare;
    let throwY = dirX * sign * (1 - c.outwardShare) + outY * c.outwardShare;
    const throwLen = Math.hypot(throwX, throwY) || 1;
    throwX /= throwLen;
    throwY /= throwLen;

    for (let j = enemiesList.length - 1; j >= 0; j--) {
      const e = enemiesList[j];
      if (club.cooldowns.has(e)) continue;
      // ALREADY IN THE AIR — left alone until it lands. Catching a body
      // mid-carom sounds like the fun version and is the bug that ate the
      // weapon: two clubs turning at swim speed re-hit a heavy body about
      // five times a second, and each re-launch resets its heading, so it
      // never travels far enough to reach anything and simply juggles beside
      // the seal. The throw has to be allowed to finish for the ricochet —
      // the whole point of the class — to happen at all.
      if (flightFor(e)) continue;

      // Two tests, one weapon. The swept head path is what catches a fast
      // swing that would otherwise step straight over a small fish between
      // frames; the shaft as it currently stands is what lets the club connect
      // with something leaning on the seal, where the head is elsewhere on its
      // arc but the wood is right there. Either counts as a hit.
      //
      // Both go through the shared swept test, which is the circle every
      // creature has always used except on a body carrying a measured shape —
      // there, the swing is tested against the flesh, so clubbing a boss
      // across the tail connects with the tail. See systems/hitShape.js.
      const sweptHit = hitCreatureSegment(e, club.prevHead.x, club.prevHead.y, club.head.x, club.head.y, headRadius, clubContact);
      const shaftHit = !sweptHit && c.shaftHits
        && hitCreatureSegment(e, _pivot.x, _pivot.y, club.head.x, club.head.y, c.shaftRadius, clubContact);
      if (!sweptHit && !shaftHit) continue;

      // WHERE THE WOOD LANDED, and only then the body's own position as the
      // fallback the circle path already produces. The riders below (the ice,
      // the blast, the whack itself) all read this as "the point of contact",
      // and on a boss the two are metres apart.
      const ex = clubContact.x;
      const ey = clubContact.y;

      club.cooldowns.set(e, c.contactCooldown);
      hooks.onWhack?.(ex, ey, swing);

      // THE RIDERS, before the damage. Ice first so a body that dies to the
      // whack still reads as having been frozen by it, and the blast is
      // collected at the point of contact rather than wherever the body ends
      // up after being thrown.
      if (ice && chillEnemy(e, ice.slow, ice.duration, ice.freezeFor, hooks, ex, ey)) recordControl('clubIce');
      const blastHere = blast;

      // Scaled by how hard this club is actually travelling. A clip through a
      // school at full whip hits for the card's number; a lazy drift into one
      // fish does a fraction of it.
      const died = hurt(scene, e, damage * power, enemiesList, hooks, clubContact);
      if (blastHere) detonate(scene, ex, ey, blastHere, enemiesList, died ? null : e, hooks);
      if (died) continue;

      // THE SHOVE, and it lands on EVERYTHING — before the launch check
      // below, not after it. That ordering is the whole point: the launch is
      // refused for half the roster (see canHold), so a boss took a club
      // across the jaw and did not move, and the one weapon in the game whose
      // read is "things leave when you hit them" was the weapon that bounced
      // off the animal the run is built around. Knockback is explicitly what a
      // boss stays open to — systems/control.js draws that line and this stays
      // the right side of it.
      //
      // Along the same vector the launch would have used, so on a body that
      // gets both they add rather than fight, and scaled by the swing's power
      // like everything else in this file.
      if (c.knock > 0) applyKnockback(e, throwX, throwY, c.knock * power);

      // Survived the whack, so it goes flying — unless it is a boss, which
      // takes the damage and keeps swimming. A flight is a HOLD: updateFlights
      // tops up `trapTimer` for every frame of it, so a clubbed boss would be
      // inert for the whole of CONFIG.club.flightTime however little the mass
      // scaling actually moved it. See systems/control.js.
      if (!canHold(e)) continue;

      // Mass matters here the same way it does for a strike's shove — a
      // megalodon leans, a minnow sails.
      const pivotR = Math.max(0.05, c.launchPivotRadius);
      const mass = Math.max(1, (e.radius ?? pivotR) / pivotR) ** c.launchMassExp;
      launch(e, throwX, throwY, launchSpeed / mass, level);
    }
  }

  updateFlights(dt, scene, enemiesList, level, blast, ice, hooks);
}

// --- the flights ------------------------------------------------------------
//
// A thrown body, integrated by hand. It does NOT go through knockX/knockY
// while it is in the air, and that is deliberate: the shared shove channel is
// a decaying nudge with no notion of hitting anything, and the whole value of
// this weapon is in what the body collides with on the way. The handoff back
// to that channel happens when the flight ends (see land()).
function updateFlights(dt, scene, enemiesList, level, blast, ice, hooks) {
  const c = CONFIG.club;
  const drag = Math.exp(-c.flightDrag * dt);

  for (const f of flights) {
    if (f.dead) continue;
    const e = f.e;
    // Died to something else mid-flight, or the run reset under us.
    if (enemiesList.indexOf(e) < 0) { f.dead = true; continue; }

    for (const [other, t] of f.lock) {
      const left = t - dt;
      if (left <= 0) f.lock.delete(other);
      else f.lock.set(other, left);
    }

    // A body in the air is not swimming and is not biting. Topped up every
    // frame rather than set once, because enemies.js decrements it — the same
    // reason the octopus grabber re-asserts it on a held fish.
    e.trapTimer = Math.max(e.trapTimer ?? 0, dt * 2);

    const p = e.mesh.position;
    p.x += f.vx * dt;
    p.y += f.vy * dt;
    f.vx *= drag;
    f.vy *= drag;
    f.life -= dt;

    // The wall. A body thrown at the edge of the arena comes back off it, and
    // that counts against the bounce budget like any other carom — otherwise
    // the corners are a free damage multiplier.
    const r = e.radius ?? 0.5;
    let walled = false;
    if (p.x - r < bounds.left && f.vx < 0) { p.x = bounds.left + r; f.vx = -f.vx; walled = true; }
    else if (p.x + r > bounds.right && f.vx > 0) { p.x = bounds.right - r; f.vx = -f.vx; walled = true; }
    if (p.y - r < bounds.bottom && f.vy < 0) { p.y = bounds.bottom + r; f.vy = -f.vy; walled = true; }
    else if (p.y + r > bounds.top && f.vy > 0) { p.y = bounds.top - r; f.vy = -f.vy; walled = true; }
    if (walled) {
      f.vx *= c.bounceSpeedKeep;
      f.vy *= c.bounceSpeedKeep;
      f.bounces -= 1;
    }

    // THE RICOCHET. Everything the flying body reaches this frame. Walked
    // backwards because a kill splices `enemiesList` at the index being looked
    // at, and only the entries ABOVE it move.
    const ricochet = abilityDamage(c.ricochetDamage + c.ricochetDamagePerLevel * Math.max(0, level - 1));
    for (let j = enemiesList.length - 1; j >= 0 && f.bounces >= 0; j--) {
      // THE LIST CAN SHRINK BY MORE THAN ONE PER PASS. Walking backwards is
      // enough when the only thing that removes an entry is the hit itself,
      // and `detonate` below is not that: a blast clears everything inside it,
      // at whatever indices those bodies happen to sit, so the array can be
      // several shorter by the time this comes round again. `j--` only steps
      // back one, and the read then lands past the end and crashes on
      // `other.mesh`.
      //
      // Clamped rather than guarded with a null check, so nothing gets skipped
      // — anything that shuffled down is still visited, and `f.lock` is what
      // stops a body being struck twice by the same carom.
      if (j >= enemiesList.length) j = enemiesList.length - 1;
      if (j < 0) break;
      const other = enemiesList[j];
      if (other === e || f.lock.has(other)) continue;
      const dx = other.mesh.position.x - p.x;
      const dy = other.mesh.position.y - p.y;
      const want = r + (other.radius ?? 0.5);
      const d2 = dx * dx + dy * dy;
      if (d2 > want * want) continue;

      const d = Math.sqrt(d2) || 1e-4;
      const nx = dx / d;
      const ny = dy / d;

      const cx = other.mesh.position.x;
      const cy = other.mesh.position.y;
      hooks.onRicochet?.(cx, cy, clubBounces(level) - f.bounces);
      // THE RIDERS TRAVEL WITH THE BODY. A carom is a club hit that happens to
      // be delivered by a shark, so it freezes and it detonates like any other
      // — which is what makes the two cards worth taking alongside the base
      // club rather than only alongside the thrown one.
      if (ice && chillEnemy(other, ice.slow, ice.duration, ice.freezeFor, hooks, cx, cy)) recordControl('clubIce');
      // ...AND SO IS THE SHOVE. A carom is a club hit delivered by a shark, so
      // it knocks what it lands on off its line the way the swing that started
      // it did. Along the flight's own heading, which is the direction the
      // mass actually arrived from. Full strength rather than power-scaled:
      // the flight has no swing of its own to read, and what it has instead is
      // a whole body's momentum.
      if (c.knock > 0) applyKnockback(other, f.vx, f.vy, c.knock);
      // Both bodies pay. The one that was standing there takes the collision;
      // the one being thrown takes a smaller share of it, so a long carom
      // eventually kills the projectile too rather than leaving one
      // indestructible pinball loose in the arena.
      const struckDied = hurt(scene, other, ricochet, enemiesList, hooks);
      // THE FLYER IS ALWAYS EXCLUDED from its own blast. It is the thing
      // carrying the explosive, and letting it eat every detonation it causes
      // would have Powder Keg quietly shortening the carom chains the base
      // club is bought for — the two cards would fight instead of stacking.
      // The body just struck is excluded too, unless the collision killed it,
      // since it has already taken its damage this frame.
      if (blast) detonate(scene, cx, cy, blast, enemiesList, [e, other], hooks);
      const flyerDied = hurt(scene, e, ricochet * c.selfDamageShare, enemiesList, hooks);
      if (flyerDied) break;

      // Reflect about the contact normal and push clear, so a body that
      // bounced can't sit inside what it hit and re-trigger next frame.
      const dot = f.vx * nx + f.vy * ny;
      f.vx = (f.vx - 2 * dot * nx) * c.bounceSpeedKeep;
      f.vy = (f.vy - 2 * dot * ny) * c.bounceSpeedKeep;
      p.x -= nx * (want - d);
      p.y -= ny * (want - d);
      f.bounces -= 1;
      f.lock.set(other, c.reHitLock);
      // A body that was knocked out from under the flight doesn't hold it up.
      if (struckDied) continue;
    }

    if (f.dead) continue; // killed by its own carom, above
    const slow = Math.hypot(f.vx, f.vy) < c.restSpeed;
    if (f.bounces < 0 || f.life <= 0 || slow) {
      land(f);
      f.dead = true;
    }
  }

  // The one place the list shrinks. See hurt().
  if (flights.some((f) => f.dead)) flights = flights.filter((f) => !f.dead);
}

// ---------------------------------------------------------------------------
// THE THROWN CLUB — the variant. On a strike RELEASE the seal hurls clubs, and
// how many is bought with the charge the dash was paid for.
//
// Not a second weapon so much as the same weapon let go of. Everything the fin
// clubs do is untouched: they stay on the flippers, they keep swinging off the
// fin controller, and they keep hitting for `clubDamage`. A thrown club hits
// for that same number, because it IS one — what changed is that it left.
//
// No cooldown, and deliberately no update() of its own: the cost was the
// wind-up already spent, so metering it again would be charging twice for one
// commitment. Same shape as the mussel barrage (systems/musselVolley.js), and
// for the same reason.
//
// TWO THINGS DECIDE WHERE IT GOES, in this order:
//
//   1. THE SEAL'S OWN VELOCITY throws it. Not the cursor and not the aim — the
//      club leaves at the speed the animal is already travelling, so a throw
//      on a full-commitment dash is genuinely harder than one from a standstill
//      and it visibly comes off the body's motion. This is the whole reason
//      the throw is bound to the strike rather than to a button.
//   2. THEN THE SEEKER TAKES IT. After `homingDelay` the club turns onto the
//      highest-priority target the projectile system can find — which is the
//      NEAREST body scaled by `markWeight`, so anything the strike just
//      painted wins over a closer minnow (see entities/projectiles.js and
//      systems/marks.js). A dash that rams a shark paints it and then throws
//      clubs at it, which is one gesture, not two.
// ---------------------------------------------------------------------------

/** How many clubs a release at this charge and level throws. */
export function clubThrowCount(power, level) {
  const c = CONFIG.clubThrow;
  if (level <= 0) return 0;
  const p = Math.min(1, Math.max(0, power));
  // Lerped across the charge rather than stepped at a threshold: the card says
  // the number depends on how hard you charged, so a half-charge should throw
  // a visibly middling handful and not either the floor or the ceiling.
  const forPower = c.countAtMin + (c.countAtFull - c.countAtMin) * p;
  return Math.max(1, Math.round(forPower + c.countPerLevel * (level - 1)));
}

/**
 * Does a release with this much banked power throw at all?
 *
 * Split out so the thing that TELLS the player it is coming (the charge ring)
 * and the thing that does it cannot disagree — the same split musselVolley
 * makes, for the same reason.
 */
export function clubThrowReady(power, level) {
  const c = CONFIG.clubThrow;
  if (!c?.enabled || !(level > 0) || power < c.minPower) return false;
  // AND THERE HAS TO BE A CLUB IN HAND. This is the whole cost of the card:
  // the seal throws the clubs it is holding, so a second strike released
  // before they have come back throws nothing. Without this the ability is
  // free and the respawn timer is decoration.
  //
  // `clubs.length === 0` means the weapon has no sockets at all yet — a rig
  // still resolving, or a harness driving the throw on its own. That is not
  // the same as empty hands, and refusing it would make the throw untestable
  // and silently dead for a frame or two at the start of a run.
  return clubs.length === 0 || clubsInHand() > 0;
}

/**
 * Hurl the clubs. Returns how many actually left.
 *
 * @param scene
 * @param power     banked charge the dash was bought with, 0..1. NOT the
 *                  meter — tryStrike has already zeroed that by release time.
 * @param level     stats.clubThrowLevel
 * @param clubLevel stats.clubLevel — the thrown club hits for whatever the fin
 *                  clubs hit for, so stacking the base card arms this one too
 * @param velocity  { x, y } the seal's velocity THIS frame. By release time
 *                  main.js has already written the dash onto it, so this is
 *                  the dash's own speed and heading.
 * @param originFor (i) -> launch point, a callback because the emit points
 *                  walk across the flippers and only main.js owns that rig
 * @param hooks     { onThrow(i, x, y, dirX, dirY, speed) }
 */
export function fireClubThrow(scene, power, level, clubLevel, velocity, originFor, hooks = {}, riders = {}) {
  if (!clubThrowReady(power, level)) return 0;

  const c = CONFIG.clubThrow;
  const count = projectileCount(clubThrowCount(power, level), player.stats);
  const damage = abilityDamage(clubDamage(Math.max(1, clubLevel)) * c.damageMul);
  // THE SAME TWO RIDERS THE FIN CLUBS CARRY. The blast rides as splashDamage,
  // which every explosive in the game already goes through (main.js queues it
  // rather than bursting inline); the ice rides as a payload combat.js hands
  // to systems/elements.js. Neither is re-implemented here.
  const blast = clubBlast(Math.max(0, Math.floor(riders.boom ?? 0)));
  const ice = clubIce(Math.max(0, Math.floor(riders.ice ?? 0)));

  // THE CLUBS LEAVE THE FINS. Done before the projectiles are spawned so the
  // sockets are already empty on the frame the throw is seen — a fin that
  // still had its club for one more frame would read as the seal throwing a
  // copy, which is exactly the impression this whole mechanic exists to avoid.
  const emptied = disarmClubs();

  // THE THROW'S SPEED IS THE SEAL'S SPEED. Clamped at both ends: a throw from a
  // standing start still has to leave the flipper, and a dash at full tilt must
  // not put a club somewhere the seeker cannot turn it back from.
  const vx = velocity?.x ?? 0;
  const vy = velocity?.y ?? 0;
  const carried = Math.hypot(vx, vy);
  const speed = Math.min(c.maxSpeed, Math.max(c.minSpeed, carried * c.velocityScale));
  // ...and its heading is that velocity too, falling back to straight ahead
  // only if the seal is somehow motionless on the frame it let go.
  const heading = carried > 1e-4 ? Math.atan2(vy, vx) : 0;

  for (let i = 0; i < count; i++) {
    // Fanned across the heading so a handful of clubs leaves as a spread
    // rather than as one club drawn several times. Homing pulls them back onto
    // the target from wherever the fan put them.
    const lane = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
    const angle = heading + lane * c.arc * 0.5 + (Math.random() * 2 - 1) * c.spread;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const origin = originFor(i, dirX, dirY);

    hooks.onThrow?.(i, origin.x, origin.y, dirX, dirY, speed, i === 0 ? emptied : 0);

    spawnProjectile(scene, {
      origin,
      dir: new THREE.Vector2(dirX, dirY),
      faction: 'player',
      damage,
      speed,
      life: c.life,
      radius: c.radius,
      pierce: c.pierce,
      // The thrown club's OWN key, so a Hurler shell reads as one in flight
      // and has somewhere for its own model to land later. It carries the
      // riders' damage but not their colour: a thrown club is a thrown club
      // whichever variants the run also took, and tinting it three ways would
      // make the throw ambiguous rather than informative.
      asset: 'clubThrow',
      scale: c.scale,
      // End over end, the way a thrown club goes. `spin` wins over `orient` in
      // projectiles.js, which is right here: a club that stayed nose-on to its
      // own travel reads as a dart.
      spin: c.spin * (Math.random() < 0.5 ? -1 : 1),
      // Its own tag, not 'club': the playtest report has to be able to say
      // whether the variant earned its pick, and folding it into the melee
      // club's numbers would hide that behind a card most runs also have.
      source: 'clubThrow',
      homing: true,
      // Longer than a missile's, and load-bearing: the whole point of this
      // weapon is that you can SEE it leave on the seal's own momentum. Homing
      // that engaged instantly would collapse the throw into a stream of
      // guided shots and take the velocity read away with it.
      homingDelay: c.homingDelay,
      turnRate: c.turnRate,
      acquireRadius: targeting(c.acquireRadius),
      splashDamage: blast ? blast.damage : 0,
      splashRadius: blast ? blast.radius : 0,
      chill: ice,
      // AND THE SHOVE, the third thing every club in the run carries. A payload
      // description like `chill` and `splashDamage` beside it — combat.js hands
      // it to applyKnockback along the shot's own heading, and this file never
      // learns what a knockback IS. Without it the Hurler was the one club that
      // hit like a bullet, which is the opposite of what the class reads as.
      knockback: CONFIG.club.knock,
    });
  }
  return count;
}

export function resetClub() {
  for (const club of clubs) group?.remove(club.mesh);
  clubs = [];
  flights = [];
  assistClock = 0;
  orbitClock = 0;
  // WHICH CLUB IS IN THE FINS IS A FACT ABOUT ONE RUN. Carried across a reset
  // it would put the last run's first pick in this run's flippers, which is a
  // wrong answer that looks exactly like a right one.
  typeOrder = [];
}
