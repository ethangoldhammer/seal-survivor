import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { isScenery } from '../enemyTable.js';
import { createVisual } from '../assets.js';
import { rollBiolumSkinVariant } from './biolumSkin.js';
import { setOutlineVariant } from './outlines.js';
import { bounds } from '../arena.js';
import { removeEnemy } from '../entities/enemies.js';
import { createAnimationController } from './animation.js';
import { aoe, targeting } from './scaling.js';
import { player } from '../entities/player.js';
import { seagullLevelStats } from '../levelStats.js';

// SEAGULL BOMB — an attack run, not a projectile.
//
// A gull enters from above the top of the shot on a rolled bearing, cruises in
// over the water alternating flapping flight and glides, picks the densest knot
// of crabs on the seabed, and once it is overhead commits to a dive it holds
// all the way down. It is the crab layer's counter: crabs gather on your
// dropped chum, and the gulls come for the crabs.
//
// THE BEARING IS THREE ROLLS — a side, a length of approach and a depth into or
// out of the picture. It used to be one bit, left wall or right wall at cruise
// altitude, which made the whole presentation of the card the same two shots.
// Entering over the top is what lets the other two vary: a steep approach has
// no room to slide in from a side, and a gull out in the background is the
// wrong SIZE for the play plane while it is back there (see depthScale), so
// either would pop into an empty sky if the run began at cruise altitude. The
// entrance is spent by the time the bird is overhead — level, full size, on the
// play plane — because the dive and its impact test are two-dimensional and
// know nothing about any of this.
//
// ...AND IT DIVES ON WHATEVER IS THERE WHEN THEY ARE NOT. Crabs are the first
// choice and stay the first choice, but a card that sat idle whenever the
// seabed happened to be clear was a card that did nothing through most of an
// open-water fight. With no pile to find the gull takes the densest knot of
// anything and stoops on that instead — see pickTarget.
//
// It is deliberately NOT built on entities/projectiles.js. A projectile has
// one velocity and one asset; this has flight phases, an animation state per
// phase, and a target it chooses in the air. Fitting that into the projectile
// struct would have meant special-casing the projectile update for one user.
//
// Phases:
//   'soar' — crossing the sky toward the target's X, flap/glide alternating
//   'dive' — committed, gaining speed, dive clip looped until it connects
//
// The three flight clips are ranges carved out of the model's single baked
// take; see ASSETS.seagull.subclips. This file drives them by name and never
// goes through stateForSpeed(): 'idle' is the glide, 'swim' the flap, 'boost'
// the dive.
const GLIDE = 'idle';
const FLAP = 'swim';
const DIVE = 'boost';

// How far past the arena edge a gull despawns. The SPAWN is no longer measured
// off the wall — a run now begins above the top of the shot and the roll may
// put it well inside either edge, or well outside one (see spawnSeagull) — so
// this is the leaving side of that pair only, and the cull tests it against the
// direction of travel rather than against the position alone.
const OFFSCREEN_MARGIN = 4;

const DEG = Math.PI / 180;

const gulls = [];

export function resetSeagulls(scene) {
  for (const g of gulls) scene.remove(g.container);
  gulls.length = 0;
}

export function seagullCount() {
  return gulls.length;
}

// ---------------------------------------------------------------------------
// THE BIRD AS A FOOTHOLD.
//
// A mid-air relaunch that passes through a gull refills the boost meter and
// scores a food chain link. main.js owns what it is WORTH — this owns only
// "was there a bird there", because the gull list lives here and nothing else
// should be handed it.
//
// ONE PAYOUT PER BIRD, and the flag is on the gull rather than on a timer.
// A cooldown would be the wrong shape twice over: two gulls in the air at once
// are two separate opportunities and a timer would eat the second, while one
// gull hovering inside the seal's radius across several jumps is the SAME
// opportunity and a timer short enough to feel responsive would pay it twice.
// The bird is the thing being spent, so the bird is what remembers.
//
// The gull's flight is deliberately untouched. It is on a run it committed to
// — the whole approach is a promise about a pile of crabs — and shoving it off
// that line would trade a payout the player chose for an ability firing where
// they didn't aim it.
//
// @param {number} x       the seal's position
// @param {number} y
// @param {number} radius  the seal's own contact radius; the gull's reach is
//                         added to it, exactly like the crab impact test
// @returns {{x: number, y: number} | null} where the bird was, for the burst
export function kickGull(x, y, radius) {
  const k = CONFIG.seagullBomb.kick ?? {};
  if (!k.enabled) return null;
  const reach = radius + (k.radius ?? 0);
  let best = null;
  let bestD2 = reach * reach;
  for (const g of gulls) {
    if (g.kicked) continue;
    const dx = g.container.position.x - x;
    const dy = g.container.position.y - y;
    const d2 = dx * dx + dy * dy;
    // `>` not `>=`, so a gull exactly on the rim still counts and the nearest
    // of several overlapping birds is the one that pays.
    if (d2 > bestD2) continue;
    bestD2 = d2;
    best = g;
  }
  if (!best) return null;
  best.kicked = true;
  return { x: best.container.position.x, y: best.container.position.y };
}

// Which enemies a gull considers food: anything living on the seabed — the
// crawlers and the anchored traps — rather than a hardcoded species list, so
// a new crab slots in without touching this file.
function isCrabLike(e) {
  return e.def.behavior === 'crawl' || e.def.behavior === 'trap';
}

// The "pile": the body with the most neighbours within clusterRadius. Returns
// the centroid of that knot, so the gull aims at the middle of a group rather
// than at whichever individual it happened to score first.
//
// `accept` is what counts as food for this scan — crabs for the run's first
// choice, everything for the fallback. See pickTarget.
//
// SCORING IS QUADRATIC in the candidates, which was free while the only
// candidates were crabs and is not free over a late-run population of 220. The
// outer loop is strided so at most `scanCap` bodies are ever scored as pile
// CENTRES, while every candidate still counts as a neighbour — the densest
// knot is a wide, blunt thing and sampling which of its members gets to name
// it moves the centroid by a body's width at worst.
function findCluster(enemiesList, accept) {
  const c = CONFIG.seagullBomb;
  // Acquisition: how wide a knot counts as one pile worth diving on.
  const r2 = targeting(c.clusterRadius) ** 2;
  const candidates = [];
  // Scenery is never a candidate, in either tier — as a member it would fatten
  // a knot it does not belong to, and as a centre it would name the pile.
  for (const e of enemiesList) if (!isScenery(e) && accept(e)) candidates.push(e);
  if (!candidates.length) return null;

  const cap = Math.max(1, Math.round(c.scanCap ?? 48));
  const stride = Math.max(1, Math.ceil(candidates.length / cap));

  let best = null;
  let bestCount = 0;
  for (let i = 0; i < candidates.length; i += stride) {
    const e = candidates[i];
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (const o of candidates) {
      const dx = o.mesh.position.x - e.mesh.position.x;
      const dy = o.mesh.position.y - e.mesh.position.y;
      if (dx * dx + dy * dy > r2) continue;
      count += 1;
      sx += o.mesh.position.x;
      sy += o.mesh.position.y;
    }
    if (count > bestCount) {
      bestCount = count;
      best = { x: sx / count, y: sy / count, count };
    }
  }
  if (best && best.count >= (c.minClusterSize ?? 1)) return best;
  return null;
}

// WHAT THIS RUN IS FOR, and whether the gull will settle for it.
//
// Crabs first, because that is the card's job: they gather on your dropped
// chum where nothing else you own reaches them, and the gulls are the answer
// to that layer. But "no crabs on the seabed" used to mean no run at all — a
// card you had bought and levelled did nothing whatsoever for whole stretches
// of a fight that was going on in open water right under the bird. So the
// fallback is the densest knot of ANYTHING, and the gull dives on the school.
//
// Returned with the run's PREY RULE attached, because the two cannot be
// decided separately: a crab run must go on ignoring the fish swimming over
// the pile on the way down (or it detonates early, on the wrong layer, every
// time), and a fallback run has to be able to hit what it was aimed at.
function pickTarget(enemiesList) {
  const crabs = findCluster(enemiesList, isCrabLike);
  if (crabs) return { target: crabs, anyPrey: false };
  const anything = findCluster(enemiesList, () => true);
  if (anything) return { target: anything, anyPrey: true };
  return null;
}

// HOW BIG A GULL IS DRAWN AT A DEPTH, which is the only way its depth is
// visible at all.
//
// The camera is orthographic and looks straight down -z (world.js), so moving a
// body through z changes nothing on screen except which one sorts in front of
// which. A gull honestly flown in from the background and left at that renders
// as a bird that is simply THERE, at full size, in the middle of the sky — the
// pop the entrance exists to remove, arriving at a different coordinate. So the
// depth is drawn rather than projected, exactly as the bait ball draws its
// column (systems/baitBall.js, CONFIG.baitBall.depthCue).
//
// @param {number} z     where the bird is
// @param {number} t     0..1 of the entrance still to fly; the cue rides it to
//                       0 alongside the depth itself, so the bird is at its
//                       true size by the time it is on the play plane
function depthScale(c, z, t) {
  const range = c.depthRange ?? 0;
  if (range <= 0) return 1;
  const near = Math.max(-1, Math.min(1, z / range));
  return 1 + (c.depthCue ?? 0) * near * t;
}

// THE TOP OF THE SHOT, which is not the top of the frame.
//
// `bounds.frameTop` is where the frame's upper edge sits with the camera at
// rest, and the cinematic rig is not at rest. A breach pans it up, and at the
// arena's ceiling (arena.js: bounds.top is three times the air) the shot's top
// is twenty-one units above where a resting frame puts it. An entrance
// measured off the resting frame would put the gull inside that gap and it
// would appear out of nothing in the middle of an empty sky — the one thing
// this entrance exists to prevent — and it would only ever do it during a big
// jump, i.e. only when there is something else to look at and nobody is going
// to catch it happening.
//
// world.framedView() is the answer to exactly this question and folds in the
// two things that make it easy to get wrong: the frustum's centre is not the
// camera's position, and the zoom shrinks about that centre rather than about
// the camera. Handed in rather than imported, the way graveGaze and
// shaderWarmup take the camera — world.js owns the frame and nothing in
// systems/ reaches back for it. Without one (every headless harness) the
// resting frame is the honest answer, because that is where the camera is.
function shotTop(view) {
  if (!view) return bounds.frameTop;
  return view.y + view.halfH;
}

export function spawnSeagull(scene, enemiesList, view = null) {
  const c = CONFIG.seagullBomb;
  const pick = pickTarget(enemiesList);
  // EMPTY WATER, which is now the only thing that holds a run back. Skipping
  // the spawn (rather than sending one out to wander) keeps the cooldown
  // meaningful: the next tick tries again, so a gull arrives shortly after
  // anything does.
  if (!pick) return null;
  const { target, anyPrey } = pick;

  // THE BEARING. Three rolls — a side, a length of run and a depth — and
  // together they are the angle the run comes in on. See the entrance block in
  // CONFIG.seagullBomb for why it is three numbers rather than a left/right
  // flag, which is all this used to be.
  //
  // The side is rolled FREELY, with no check for room. It used to be forced to
  // whichever wall the pile was furthest from, because the spawn sat at cruise
  // altitude and a side with no room in front of it would put the bird inside
  // the frame. Every entrance starts above the frame now (see entryY below), so
  // there is no such thing as a side without room: a run rolled onto the near
  // wall simply spends longer coming down.
  const dir = Math.random() < 0.5 ? 1 : -1;
  const run = c.approachMin + Math.random() * Math.max(0, (c.approachMax ?? 0) - (c.approachMin ?? 0));
  const z0 = (Math.random() * 2 - 1) * (c.depthRange ?? 0);

  // ABOVE THE SHOT, always. This is the one part of the entrance that is not
  // rolled, and it is what lets the rest of it be — see the entrance block in
  // config.js.
  const entryY = shotTop(view) + (c.entryHeight ?? 0);
  const drop = Math.max(0, entryY - (bounds.surfaceY + c.cruiseAltitude));

  // The run, held to two bounds the roll knows nothing about.
  //
  // Never inside the commit distance, whatever the table says: a spawn closer
  // than `diveZone` is a gull that dives on the frame it was created, from
  // above the top of the shot — the approach the whole ability is presented
  // through, skipped entirely.
  //
  // And never coming down faster than `entryDropMax`, which is the clause that
  // earns its keep when the camera is high. The drop is measured from the top
  // of the SHOT, so a breach that pans the frame up to the arena's ceiling
  // makes it three times what it is at rest — and a short run rolled against a
  // drop that size is not a steep entrance, it is a bird falling out of the sky
  // faster than the stoop it is about to perform. Lengthening the run rather
  // than clamping the descent is what keeps the line straight.
  //
  // Solved against the stretch of run the descent is actually flown over, not
  // the whole approach: `entryDescent` spends it in the first share and cruises
  // the rest, so measuring across the full span would report a line a third as
  // steep as the one the bird flies.
  const share = Math.max(0.05, Math.min(1, c.entryDescent ?? 1));
  const span = Math.max(
    c.diveZone * 3,
    run,
    drop * c.cruiseSpeed / (Math.max(1, c.entryDropMax ?? 20) * share),
  );

  // Container carries position and heading; the visual inside it carries the
  // left/right flank flip. Same split entities/enemies.js uses for faceMotion
  // — the two rotations must not compound on one object.
  const container = new THREE.Group();
  const visual = createVisual('seagull');
  // The bomber's own look, from skins.csv, exactly as a spawned creature gets
  // one — body and rim from a single row. The seagull is built here rather
  // than through spawnOne, so the roll has to be made here too or the whole
  // flock comes out wearing the preset and the table looks broken.
  setOutlineVariant(visual, 'seagull', rollBiolumSkinVariant(visual)?.__rim ?? null);
  container.add(visual);
  container.position.set(target.x - dir * span, entryY, z0);
  // The depth cue's first frame, applied here rather than left to the first
  // update: a gull rolled deep into the background is drawn at 0.78x, and one
  // frame of it at full size would be a pop in exactly the place this entrance
  // exists to remove one.
  container.scale.setScalar(depthScale(c, z0, 1));
  scene.add(container);

  const anim = (visual.userData?.clips?.length || visual.userData?.rig)
    ? createAnimationController(visual)
    : null;

  const gull = {
    container,
    visual,
    anim,
    phase: 'soar',
    dir,
    target,
    // Whether this run will detonate on anything it touches or only on the
    // seabed layer — decided with the target and never re-decided against a
    // different rule. See pickTarget.
    anyPrey,
    vx: dir * c.cruiseSpeed,
    vy: 0,
    // --- the entrance, kept so the descent can be flown ----------------------
    // How much of the arrival is left, 1 at the spawn and 0 once overhead. The
    // altitude the spring holds and the depth the bird is drawn at both ride on
    // it, so a run levels off and lands on the play plane at the same moment,
    // whatever bearing it came in on. See updateSeagulls.
    descend: 1,
    entryY,
    entrySpan: span,
    z0,
    // The descent's own speed, kept SEPARATE from vy — which stays what it has
    // always been, the bob around whatever height the bird is holding.
    //
    // Two variables because the descent is a feed-forward and the bob is a
    // chase, and a chase cannot fly a descent. The altitude spring corrects
    // whatever error it is handed; against a setpoint that is itself moving
    // down it trails by however long it takes to respond, and the first pass
    // did exactly that — every bearing, however steep it was rolled, arrived
    // over the pile four units high and dove out of the top of the frame. So
    // the line's rate is applied directly and the spring is left doing the one
    // thing it is good at.
    entryVy: 0,
    // Flap and glide alternate on a timer rather than tracking speed: a gull
    // crossing at constant velocity would otherwise sit in one clip the whole
    // way, and the glide is half of what makes it read as a seagull.
    gliding: false,
    phaseTimer: c.flapTime,
    retargetTimer: 0,
    life: c.life,
    // 0..1 through the rotation that cancels the stoop clip's baked pitch —
    // see the heading block in updateSeagulls.
    diveBlend: 0,
    // Whether the seal has already kicked off this bird. One payout per gull —
    // see kickGull.
    kicked: false,
  };
  gulls.push(gull);
  return gull;
}

export function updateSeagulls(dt, scene, enemiesList, hooks = {}) {
  const c = CONFIG.seagullBomb;

  for (let i = gulls.length - 1; i >= 0; i--) {
    const g = gulls[i];
    g.life -= dt;
    let state = FLAP;

    if (g.phase === 'soar') {
      g.phaseTimer -= dt;
      if (g.phaseTimer <= 0) {
        g.gliding = !g.gliding;
        g.phaseTimer = g.gliding ? c.glideTime : c.flapTime;
      }
      state = g.gliding ? GLIDE : FLAP;

      // A glide sheds height and a flap regains it, so the cruise undulates
      // instead of tracking a ruler-straight line.
      g.vy += (g.gliding ? -c.glideSink : c.flapLift) * dt;

      // FLYING THE ENTRANCE IN. `descend` is how much of the arrival is left,
      // measured off the horizontal distance still to close and normalised so
      // it hits 0 exactly where the run commits. The altitude below and the
      // depth further down both ride on it, which is what ties a rolled bearing
      // together: however steep or however deep the entrance was, the bird is
      // level, full size and on the play plane at the moment it is overhead.
      //
      // MONOTONE BY CONSTRUCTION, and it has to be. A retarget (just above) can
      // hand the run a pile FURTHER away than the spawn was, and a raw distance
      // ratio would send the gull climbing back out of the top of the frame to
      // re-fly an entrance the player has already watched.
      const closing = Math.abs(g.container.position.x - g.target.x) - c.diveZone;
      const remain = Math.max(0, Math.min(1, closing / Math.max(1, g.entrySpan - c.diveZone)));
      // ...spent over the FIRST share of the approach and no more. The entrance
      // is a way IN, not the whole flight. Stretched across the entire run it
      // put the bird below the top of the shot only for the last third of one —
      // measured, under half a second of visible approach on a short bearing
      // against nearly two seconds of flight — and the flap and the glide that
      // are the whole reason a seagull reads as a seagull never got a frame.
      // It comes down early and cruises the rest, which is also the order the
      // two motions want: the bob is authored around a level hold.
      const share = Math.max(0.05, Math.min(1, c.entryDescent ?? 1));
      const wasDescend = g.descend;
      g.descend = Math.min(g.descend, Math.max(0, Math.min(1, (remain - (1 - share)) / share)));

      // ...pulled back toward the cruising altitude, because the bob does NOT
      // cancel itself out. Lift x flapTime and sink x glideTime are two
      // independently tuned numbers, so any mismatch integrates: the first
      // pass climbed 10 units in 5 seconds and left the top of the screen
      // (the visible sky is only arena.viewHeight * surfaceFromTop tall).
      // A spring keeps the undulation without letting it drift.
      //
      // The height it holds is the entrance's, not the cruise's, until the
      // entrance is flown. Same spring, same undulation on top of it — the
      // descent is the line it bobs along rather than a separate motion.
      const cruiseY = bounds.surfaceY + c.cruiseAltitude;
      const holdY = cruiseY + (g.entryY - cruiseY) * g.descend;
      g.vy += (holdY - g.container.position.y) * c.altitudeHold * dt;
      g.vy *= 1 - Math.min(1, c.altitudeDamp * dt);

      const vyCap = c.cruiseSpeed * 0.5;
      g.vy = Math.max(-vyCap, Math.min(vyCap, g.vy));
      g.vx = g.dir * c.cruiseSpeed;

      // ...and the line the bob is riding, measured rather than derived: how
      // far the hold height moved THIS frame is exactly the descent's speed,
      // and taking it from the two heights means it cannot disagree with them.
      // Zero the moment the entrance is flown, so a cruising gull is the same
      // gull it always was.
      g.entryVy = dt > 0
        ? (g.entryY - cruiseY) * (g.descend - wasDescend) / dt
        : 0;

      // BACK ONTO THE PLAY PLANE, and squared so the depth is spent EARLY. The
      // approach is where the flourish belongs; the last stretch before the
      // commit has to be flat and in-plane, because the dive and the impact
      // test are both two-dimensional and a bird that went off a unit in front
      // of the crab it aimed at is a miss nothing on screen explains.
      const depthT = g.descend * g.descend;
      g.container.position.z = g.z0 * depthT;
      g.container.scale.setScalar(depthScale(c, g.z0, depthT));

      // Retarget while inbound — crabs move, and the pile it picked may have
      // been eaten or killed by the time it gets there.
      g.retargetTimer -= dt;
      if (g.retargetTimer <= 0) {
        g.retargetTimer = c.retargetInterval;
        const fresh = pickTarget(enemiesList);
        // The prey rule travels with the target. A run that started at a crab
        // pile and re-acquired onto a school has to be allowed to hit the
        // school, and one that finds crabs on the way in goes back to
        // ignoring everything else.
        if (fresh) { g.target = fresh.target; g.anyPrey = fresh.anyPrey; }
      }

      // Overhead? Commit. `diveZone` is the horizontal half-width of the
      // trigger, so it fires as the gull passes over the pile rather than
      // while it is still approaching on the diagonal.
      if (Math.abs(g.container.position.x - g.target.x) <= c.diveZone) {
        g.phase = 'dive';
        // The entrance is over. `descend` is already 0 here by construction —
        // it is normalised against exactly this distance — so these two are
        // pinned rather than eased, and the stoop is flown at true size on the
        // play plane where the impact test can see it. A gull that reached the
        // commit some other way (a retarget onto a pile it was already over)
        // lands on the same plane instead of diving a few tenths off it.
        g.container.position.z = 0;
        g.container.scale.setScalar(1);
        // The descent folds into the bob's velocity here and stops being its
        // own term — a stoop is one motion and `entryVy` has no meaning inside
        // it. Folded rather than dropped, so the plunge starts from the speed
        // the bird actually had rather than losing whatever it was carrying.
        g.vy += g.entryVy;
        g.entryVy = 0;
        // Once, at the top of the stoop — the phase flip is edge-triggered by
        // this branch only running while still cruising, so it can't repeat
        // on the way down.
        hooks.onDive?.(g.container.position.x, g.container.position.y);
      }
    } else if (g.phase === 'dive') {
      // Held for the whole plunge — the clip loops rather than playing once,
      // so a long fall doesn't run out of animation partway down.
      state = DIVE;
      // Steer the remaining horizontal error out while accelerating down, so
      // the dive converges on the pile instead of falling past it.
      const dx = g.target.x - g.container.position.x;
      g.vx += Math.max(-1, Math.min(1, dx)) * c.diveSteer * dt;
      g.vx *= 0.96;
      g.vy -= c.diveAccel * dt;
      g.vy = Math.max(-c.diveSpeedMax, g.vy);
    }

    // The bob and the descent, which are one motion to everything downstream of
    // here — the surface break, the nose, the plunge. Only the soar keeps them
    // apart, and only because they are steered differently.
    const vy = g.vy + g.entryVy;

    const prevY = g.container.position.y;
    g.container.position.x += g.vx * dt;
    g.container.position.y += vy * dt;

    // Breaking the surface on the way down.
    if (prevY > bounds.surfaceY && g.container.position.y <= bounds.surfaceY) {
      hooks.onSplash?.(g.container.position.x, bounds.surfaceY);
    }

    // Nose along the flight path. Model forward is mapped to the container's
    // +Y by the shared orientation code, hence the -90 degrees.
    //
    // ...minus the pitch the DIVE CLIP already contains. The two cruise clips
    // are near-level poses, so aiming the container down the velocity vector is
    // all they need. The stoop is not: it is authored as a tuck with the body
    // already 84 degrees nose-down (ASSETS.seagull.subclips), so a container
    // also aimed at the ground stacked the two and sent the gull down sideways.
    // CONFIG.seagullBomb.divePitch takes it back out.
    //
    // Eased on the clip's own crossfade clock rather than applied the instant
    // the phase flips, or the body would snap through 96 degrees on one frame
    // while the tuck was still fading in.
    const fade = Math.max(0.01, CONFIG.animation?.states?.boost?.fade ?? CONFIG.animation?.crossfade ?? 0.2);
    g.diveBlend = Math.max(0, Math.min(1, g.diveBlend + (g.phase === 'dive' ? dt : -dt) / fade));

    if (Math.hypot(g.vx, vy) > 0.05) {
      // Both the flank flip and the correction's sign come off `dir` — the side
      // the run entered from — and NOT off vx. A dive bleeds vx toward zero and
      // steers across it, so reading the sign live lets it cross mid-plunge,
      // which would mirror the bird and jump the correction by 192 degrees.
      // The gull never turns around, so `dir` is the honest answer for both.
      const flip = g.dir < 0 ? -1 : 1;
      const correction = flip * g.diveBlend * (c.divePitch ?? 0) * DEG;
      g.container.rotation.z = Math.atan2(vy, g.vx) - Math.PI / 2 + correction;
      if (CONFIG.view === 'side') g.visual.rotation.y = g.dir < 0 ? Math.PI : 0;
    }

    // Impact — only while diving. A gull cruising over the water shouldn't
    // detonate on a crab that happens to pass beneath it.
    if (g.phase === 'dive') {
      let hitIndex = -1;
      for (let k = enemiesList.length - 1; k >= 0; k--) {
        const e = enemiesList[k];
        if (!g.anyPrey && !isCrabLike(e)) continue;
        const dx = e.mesh.position.x - g.container.position.x;
        const dy = e.mesh.position.y - g.container.position.y;
        const reach = e.radius + c.hitRadius;
        if (dx * dx + dy * dy <= reach * reach) { hitIndex = k; break; }
      }
      const grounded = g.container.position.y <= bounds.bottom + c.hitRadius;

      if (hitIndex !== -1 || grounded) {
        const x = g.container.position.x;
        const y = g.container.position.y;
        // WHAT THE BIRD IS CARRYING, at the level the run is holding. A level
        // used to buy nothing but a faster gull; the hit, the blast and the
        // blast's reach all climb with it now, and all three come from
        // levelStats.js so the tip that quotes them and the bomb that delivers
        // them cannot drift apart. Big Rigz and Splash Zone are folded in
        // there, which is why neither is applied again here.
        const lv = seagullLevelStats(player.stats?.seagullLevel ?? 1, player.stats);
        if (hitIndex !== -1) {
          const hit = enemiesList[hitIndex];
          hit.hp -= lv.seagullHit;
          hit.flash = CONFIG.fx.hitFlash;
          hit.hitThisFrame = true;
          hooks.onEnemyDamaged?.(hit, lv.seagullHit, x, y);
          if (hit.hp <= 0) {
            hooks.onEnemyKilled?.(hit);
            removeEnemy(scene, hitIndex);
          }
        }
        hooks.onImpact?.(x, y, lv.seagullSplash, lv.seagullSplashRadius);
        scene.remove(g.container);
        gulls.splice(i, 1);
        continue;
      }
    }

    // Left the arena without ever lining up, or ran out of life.
    const offscreen = g.container.position.x > bounds.right + OFFSCREEN_MARGIN
      || g.container.position.x < bounds.left - OFFSCREEN_MARGIN;
    // A gull that has just spawned is legitimately offscreen — only cull one
    // that is heading further out, or the spawn would be removed on frame one.
    const leaving = g.dir > 0
      ? g.container.position.x > bounds.right
      : g.container.position.x < bounds.left;
    if ((offscreen && leaving) || g.life <= 0) {
      scene.remove(g.container);
      gulls.splice(i, 1);
      continue;
    }

    if (CONFIG.animation.enabled && g.anim) g.anim.update(dt, state, false);
  }
}
