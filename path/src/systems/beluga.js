import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual, getAssetSizeMultiplier } from '../assets.js';
import { orbitTarget, springFollow } from './orbit.js';
import { createAnimationController, stateForSpeed } from './animation.js';
import { aoe, applyCompanionScale } from './scaling.js';
import { canHold } from './control.js';

// A drone that orbits the ship and lobs a bubble CLUSTER BOMB at the nearest
// enemy. Unlike every other weapon in the game, none of this deals damage — a
// bubble seals what it pops on (frozen, harmless) for a fixed duration, so this
// runs its own small collision check rather than going through combat.js,
// which is damage-only.
//
// THE SHAPE OF THE ABILITY, and why it is this rather than a shot:
//
//   lob      one fat, slow bubble leaves the drone, immediately loses most of
//            its speed to drag, and floats — rising, wandering. You have most
//            of a second to see where it is going.
//   split    it bursts into several smaller bubble bombs that scatter, each
//            with its own drift and its own fuse.
//   pop      each bomblet goes off on its own clock (or the moment something
//            swims into it) and seals everything in its radius.
//
// The version before this was a fast pellet that sealed the first thing it
// touched and vanished. Everything about it happened in one frame, at a size
// you could not read, and the only evidence was a fish that had stopped
// moving. A slow cluster is the same effect spread over three beats you can
// actually watch, and it fails legibly too — a bomblet that pops in open water
// is visibly a miss rather than nothing at all.

// Two nested objects, matching the convention every other creature uses
// (enemies split e.mesh / e.visual, the player splits mesh / body):
//   drone  — outer, owns position and the heading rotation on Z
//   visual — inner, owns ONLY the left/right mirror on Y
// They must stay separate. Setting rotation.y = PI on the same object that
// carries rotation.z re-orients the axis that Z then turns about, so the
// heading comes out inverted the moment the drone swims left — which is
// exactly what "orientation is wrong" looked like.
let drone = null;
let visual = null;
// The swim cycle. beluga.fbx ships one 11.23s take on a 64-bone skeleton whose
// tail tip sweeps 145 units — 29% of the model's own length — and until this
// existed nothing ever played it: the asset declared idle/swim/boost and no
// mixer was ever built, so the drone was a rigid model sliding along its orbit.
// It is not a rig fallback either (no `rig` block on the asset, so no bone
// springs), which is why the stillness had nothing at all to cover it.
let anim = null;
let fireTimer = 0;
const dronePos = new THREE.Vector3();
const droneVel = new THREE.Vector3();
// Everything in the water that hasn't gone off yet — the lobbed cluster and
// the bomblets it threw, in one list because they move identically and differ
// only in what happens when their timer runs out.
const bombs = []; // { mesh, vx, vy, radius, timer, age, phase, cluster }
// Landed: one per creature currently held, wrapped around it for as long as
// the trap lasts. This is the ability — a fish in a bubble, visibly — and
// everything above is only how it gets there.
const shells = []; // { mesh, enemy, age, fit, from, phase, flickerPhase }

// The sphere the trapBubble asset is authored at (assets.js). Every scale here
// is expressed against it, so what it CATCHES and what is DRAWN are one
// number — see the catch radius in the fire block.
const ART_RADIUS = 0.35;
// Reused rather than allocated per shell per frame.
const liveEnemies = new Set();

// THE MODEL'S OWN BUBBLES, which are not this ability's bubbles.
//
// beluga.fbx ships a 72-sphere blowhole burst (`Dummy_bubble1` and the
// `buublesphere_*` meshes under it, on their own `bubble` material) keyed into
// the same take as the swim. They sit at scale 0 for the first five seconds and
// then bloom out to a 77-unit cloud — so while nothing played the clip they
// were invisible, and switching the clip on turns them on with it.
//
// They stay off. This ability's whole read is bubbles: one lobbed cluster, the
// bomblets it throws, and a shell around each fish it seals. A second,
// unrelated stream of bubbles pouring off the drone every eleven seconds
// competes with every one of those for the same glance, and none of it means
// anything — it is scenery on the one companion whose bubbles are load-bearing.
// Hidden rather than deleted so the geometry is still there to turn back on.
const MODEL_BUBBLES = /buublesphere|Dummy_bubble/i;

function buildDrone() {
  const root = new THREE.Group();
  visual = createVisual('belugaDrone');
  visual.traverse((o) => { if (MODEL_BUBBLES.test(o.name)) o.visible = false; });
  // Tied to this specific mesh instance, so every path that swaps the mesh has
  // to rebuild it too — see rebuildBelugaDrone, and the same note on the eel.
  anim = createAnimationController(visual);
  root.add(visual);
  return root;
}

export function createBelugaDrone() {
  drone = buildDrone();
  return drone;
}

// The drone is a singleton created once at boot, not repeatedly cloned like
// an enemy or a shrimp-ring instance — a size multiplier set afterward
// wouldn't show up until a full reload without this. Swaps the mesh in
// place (same parent, same position) so it's seamless from the T-menu.
export function rebuildBelugaDrone(scene) {
  if (!drone) return;
  const { position, visible } = drone;
  scene.remove(drone);
  drone = buildDrone();
  drone.position.copy(position);
  drone.visible = visible;
  scene.add(drone);
}

export function resetBeluga(scene, playerPos) {
  fireTimer = 0;
  dronePos.set(playerPos?.x ?? 0, playerPos?.y ?? 0, 0);
  droneVel.set(0, 0, 0);
  for (const b of bombs) scene.remove(b.mesh);
  bombs.length = 0;
  for (const s of shells) scene.remove(s.mesh);
  shells.length = 0;
}

// The lobbed cluster's world radius. Splash Zone widens it, and so does the
// asset's own Size slider — which is folded in HERE and nowhere else, so that
// dragging it scales the whole chain (cluster, bomblets, and what each of them
// catches) by the same factor exactly once. The bubble is a catch radius that
// happens to be drawn, so this is the rare case where "how big is the effect"
// and "how big is the picture" are literally the same number.
function clusterRadius(level) {
  const base = CONFIG.beluga.baseBubbleRadius + CONFIG.beluga.radiusPerLevel * (level - 1);
  return aoe(base) * getAssetSizeMultiplier('trapBubble');
}

// Random in [a*(1-vary), a*(1+vary)]. Every clock in the cluster runs through
// this: bomblets that split on the same frame and pop on the same frame read as
// one event with a big radius, which is the opposite of what a cluster is for.
function jitter(base, vary) {
  return base * (1 + (Math.random() * 2 - 1) * Math.max(0, Math.min(1, vary)));
}

// How long a catch holds, at this stack. Every other companion buys something
// per level and this one only widened, so a second bubble at level 8 was worth
// no more than the first — see beluga.durationPerLevel in weapons.csv.
export function trapSeconds(level) {
  return CONFIG.beluga.trapDuration + (CONFIG.beluga.durationPerLevel ?? 0) * Math.max(0, level - 1);
}

// The world radius a shell wants, to sit around this creature with a little
// air. e.radius is the creature's own scale-corrected radius (def.radius times
// its spawn scale), which is what "how big is this thing" means everywhere
// else in the game.
function fitRadius(enemy) {
  return Math.max(0.15, enemy.radius * (CONFIG.beluga.fitPad ?? 1.5));
}

// A bubble that has caught something doesn't disappear on the frame it touched
// — it closes around the creature and stays there for the whole hold, which is
// the only thing on screen that says that fish is out of the fight. It then
// warns before it lets go, and bursts.
//
// The strobe is `mesh.visible`, NOT material opacity. Every trap bubble shares
// one material (see createVisual — primitives don't clone theirs), so fading
// one would fade all of them, including the ones still travelling. `visible`
// is per-object and free.
//
// Returns true when the shell is spent and the caller should drop it.
function updateShell(s, dt, scene, hooks) {
  const cfg = CONFIG.beluga;
  s.age += dt;

  // Gone, or let go. Both end the same way — the bubble bursts where it was.
  // The membership test is what makes holding an enemy reference safe: a dead
  // creature's mesh goes back to the visual pool and is handed to the next
  // spawn, so a shell still following one would ride a completely different
  // animal.
  const held = liveEnemies.has(s.enemy) && s.enemy.trapTimer > 0;
  if (!held) {
    scene.remove(s.mesh);
    hooks.onPop?.(s.mesh.position.x, s.mesh.position.y);
    return true;
  }

  s.mesh.position.copy(s.enemy.mesh.position);

  // Closing. The shell arrives at the size the projectile was and contracts (or
  // opens out, on something bigger than itself) onto the creature, bulging
  // once on the way — a bubble sealing rather than a sphere being resized.
  const sealTime = Math.max(0.0001, cfg.sealTime ?? 0.18);
  const k = Math.min(1, s.age / sealTime);
  const ease = 1 - (1 - k) * (1 - k) * (1 - k);
  const radius = s.from + (s.fit - s.from) * ease;
  const bulge = 1 + ((cfg.sealSwell ?? 1.35) - 1) * Math.sin(Math.PI * k);
  // ...and once settled, breathes. A held bubble that is perfectly still stops
  // being a bubble within about a second of looking at it.
  const breath = 1 + (cfg.wobble ?? 0.05) * Math.sin(s.age * (cfg.wobbleHz ?? 1.6) * Math.PI * 2 + s.phase);
  // setScalar, which DISCARDS the asset's Size multiplier — deliberately, and
  // this is the one place in the file where that is right. Size is an art
  // scale and it still owns the shot (see the spawn); a shell is a FIT to the
  // creature it is wrapped around, so a 5x slider here would put a bubble five
  // times the width of the fish it is supposed to be holding. `fitPad` is the
  // knob for this one.
  s.mesh.scale.setScalar((radius * bulge * breath) / ART_RADIUS);

  // THE WARNING. The last stretch before the hold expires, strobing faster as
  // it goes, so "this one is about to come back at you" is readable across the
  // arena rather than being a surprise. Phase-accumulated instead of derived
  // from the timer, or ramping the rate would step the strobe backwards.
  const warn = cfg.warnFlicker ?? 0;
  if (warn > 0 && s.enemy.trapTimer < warn) {
    const urgency = 0.6 + 1.0 * (1 - s.enemy.trapTimer / warn);
    s.flickerPhase += (cfg.flickerHz ?? 24) * urgency * dt;
    s.mesh.visible = Math.floor(s.flickerPhase * 2) % 2 === 0;
  } else {
    s.mesh.visible = true;
  }
  return false;
}

// hooks: { onTrap(enemy), onPop(x, y) } — for feedback only, no damage/kill
// involved. onTrap is the catch, onPop the shell bursting when the hold ends
// (or when whatever it was wrapped around dies inside it).
export function updateBeluga(dt, scene, playerPos, level, enemiesList, clock, hooks) {
  if (!drone) return;

  const active = level > 0;
  drone.visible = active;

  if (active) {
    // The drone used to be pinned to an exact orbit position every frame,
    // which read as a rigid attachment rather than an animal swimming
    // alongside you. Now the orbit point is only a TARGET, and the drone
    // spring-follows it (same damped-spring approach as the eel companion)
    // — so it lags on turns, overshoots slightly, and
    // generally swims rather than being welded to a circle.
    // The tilted 3D ring and the spring-follow both live in systems/orbit.js
    // now, shared with Seal Team so the two companion abilities move alike and
    // read from the same offset controls.
    const to = orbitTarget(clock, playerPos, CONFIG.beluga);
    springFollow(dronePos, droneVel, to, dt, CONFIG.beluga.followSpring, CONFIG.beluga.followDamping);
    drone.position.copy(dronePos);
    applyCompanionScale(visual);

    // Heading on the OUTER object, mirror on the INNER one — see the note by
    // the declarations for why these can't share an object. Heading uses only
    // the screen-plane velocity, so swinging through depth doesn't tip the
    // model over.
    const spd = Math.hypot(droneVel.x, droneVel.y);
    if (spd > 0.3) {
      drone.rotation.z = Math.atan2(droneVel.y, droneVel.x) - Math.PI / 2;
      visual.rotation.y = droneVel.x < 0 ? Math.PI : 0;
    }

    // The swim cycle, paced by how fast the spring is actually carrying it.
    // idle/swim/boost all name the one take (see the asset), so this chooses a
    // PACE on that clip rather than a clip — which is the right model for an
    // animal that only ever cruises. `false` is "not hit this frame": nothing
    // in the game can damage the drone.
    //
    // Safe alongside the two rotations above. The clip keys nodes INSIDE the
    // model; `visual` is createVisual's wrapper and `drone` the group above it,
    // so neither of them is a track target and the mixer cannot fight the
    // heading or the mirror.
    if (CONFIG.animation.enabled && anim) anim.update(dt, stateForSpeed(spd), false);

    fireTimer -= dt;
    if (fireTimer <= 0) {
      fireTimer = CONFIG.beluga.fireRate;
      let target = null;
      let bestD = Infinity;
      for (const e of enemiesList) {
        if (e.trapTimer > 0) continue; // already trapped, leave it be
        const d = e.mesh.position.distanceTo(drone.position);
        if (d < bestD) { bestD = d; target = e; }
      }
      if (target) {
        const dx = target.mesh.position.x - drone.position.x;
        const dy = target.mesh.position.y - drone.position.y;
        const len = Math.hypot(dx, dy) || 1;
        // THE LOB IS AIMED, NOT JUST POINTED. The split is on a fuse, so the
        // only way the cluster comes apart ON the fish is to leave at the speed
        // that puts it there when the fuse runs out. Under exponential drag a
        // bubble thrown at v covers v/k * (1 - e^-kT) in T seconds, so this
        // inverts that for the distance it actually has to cross.
        //
        // Fired at a flat speed instead, a near target was simply overflown —
        // the cluster sailed past whatever it was aimed at and split in open
        // water behind it, which is a miss that looks like a bug.
        const fuse = jitter(CONFIG.beluga.splitDelay ?? 0.9, CONFIG.beluga.splitVary ?? 0.3);
        const k = Math.max(0.05, CONFIG.beluga.drag ?? 1.9);
        const reachable = (1 - Math.exp(-k * fuse)) / k;
        // `speed` is the CEILING now — the range beyond which it falls short,
        // rather than the speed everything leaves at.
        const speed = Math.min(CONFIG.beluga.speed, len / Math.max(0.0001, reachable));
        spawnBomb(scene, drone.position, clusterRadius(level), {
          vx: (dx / len) * speed,
          vy: (dy / len) * speed,
          cluster: true,
          timer: fuse,
        });
      }
    }
  }

  const hold = trapSeconds(level);
  // How many creatures ONE BOMBLET may seal — per pop, not per cluster, so a
  // full spread over a school can take several times this. A bubble drawn wide
  // enough to cover three fish and sealing only the first of them reads as a
  // miss on the other two — see beluga.maxCatch in weapons.csv.
  const maxCatch = Math.max(1, Math.round(CONFIG.beluga.maxCatch ?? 1));

  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    drift(b, dt, clock);
    b.timer -= dt;
    b.age += dt;

    // `life` is the ceiling on how long ANY bubble may drift, so a fuse tuned
    // absurdly long can't leave bubbles wandering the arena for a whole run.
    const spent = b.timer <= 0 || b.age >= (CONFIG.beluga.life ?? 4);

    if (b.cluster) {
      // The cluster is a FUSE, not a contact shot. Splitting on the first fish
      // it brushed would mean that in a crowd — which is every fight worth
      // firing into — it burst a few feet from the drone every time, and the
      // slow float the whole ability is now built around would never be seen.
      if (!spent) continue;
      splitCluster(scene, b, hooks);
    } else {
      // Bomblets ARE contact-sensitive: one drifting into a fish should go off
      // on it rather than through it.
      if (!spent && !touchedEnemy(b, enemiesList)) continue;
      detonate(scene, b, enemiesList, hold, maxCatch, hooks);
    }
    bombs.splice(i, 1);
  }

  // Rebuilt each frame rather than maintained: enemies are spliced out of the
  // list by index from a dozen places (kills, hauls, despawns), and none of
  // them can be expected to tell this system about it. Only paid for while
  // something is actually held.
  if (shells.length) {
    liveEnemies.clear();
    for (const e of enemiesList) liveEnemies.add(e);
    for (let i = shells.length - 1; i >= 0; i--) {
      if (updateShell(shells[i], dt, scene, hooks)) shells.splice(i, 1);
    }
  }
}

// One bubble in the water, whatever generation. `radius` is the world radius it
// is drawn AND catches at — one number, deliberately. They used to be two, and
// the Size slider quietly separated them: at a 5x Size the bubble on screen was
// five times the width of the thing that actually caught fish, so most of the
// ball was decoration and shots that visibly enveloped a fish went through it.
//
// setScalar, so the size the caller asked for is the size that lands. The
// asset's Size multiplier (the T-panel slider) is folded in ONCE, by the lob
// that starts the chain — see clusterRadius. Applying it here instead meant
// every generation multiplied by it again, and at a 5x slider a bomblet came
// out more than twice the width of the cluster that threw it.
function spawnBomb(scene, at, radius, opts) {
  const mesh = createVisual('trapBubble');
  mesh.scale.setScalar(radius / ART_RADIUS);
  mesh.position.copy(at);
  mesh.position.z = 0;
  scene.add(mesh);
  const bomb = {
    mesh,
    vx: opts.vx ?? 0,
    vy: opts.vy ?? 0,
    radius,
    timer: opts.timer,
    age: 0,
    cluster: !!opts.cluster,
    // Its own turbulence phase, or every bubble in a cluster wanders in
    // formation — which reads as one rigid object, the exact opposite of a bag
    // of bubbles coming apart.
    phase: Math.random() * Math.PI * 2,
  };
  bombs.push(bomb);
  return bomb;
}

// HOW A BUBBLE MOVES. Heavy drag, buoyancy and a wander, in that order of
// importance — the shot is thrown hard, loses nearly all of it within half a
// second, and from then on it is floating rather than travelling. That is the
// legibility fix: a projectile you can outrun is a projectile you can read.
//
// The wander is two out-of-phase sines rather than a random walk per frame.
// Random per-frame acceleration averages out to a straight line with the
// silhouette shaking, which reads as a rendering fault; a slow beat between two
// frequencies reads as water moving something light around.
function drift(b, dt, clock) {
  const cfg = CONFIG.beluga;
  const keep = Math.exp(-(cfg.drag ?? 1.9) * dt);
  b.vx *= keep;
  b.vy *= keep;
  b.vy += (cfg.rise ?? 1.1) * dt;
  const turb = cfg.turbulence ?? 1.6;
  if (turb > 0) {
    const w = (clock * (cfg.turbulenceHz ?? 0.9)) * Math.PI * 2;
    b.vx += Math.sin(w + b.phase) * turb * dt;
    b.vy += Math.cos(w * 0.7 + b.phase * 1.7) * turb * dt;
  }
  b.mesh.position.x += b.vx * dt;
  b.mesh.position.y += b.vy * dt;
}

// The first creature actually overlapping this bubble, or null. Trapped ones
// are skipped: a bomblet drifting through a fish already in a shell should
// float on rather than being consumed by a catch it can't make.
function touchedEnemy(b, enemiesList) {
  for (const e of enemiesList) {
    if (e.trapTimer > 0) continue;
    const dx = e.mesh.position.x - b.mesh.position.x;
    const dy = e.mesh.position.y - b.mesh.position.y;
    const reach = b.radius + e.radius;
    if (dx * dx + dy * dy <= reach * reach) return e;
  }
  return null;
}

// The cluster coming apart. The bomblets are thrown out in a full circle at a
// spread of speeds, each with its own fuse — so they arrive at their own
// moments across a patch of water instead of detonating as one ring.
function splitCluster(scene, b, hooks) {
  const cfg = CONFIG.beluga;
  const count = Math.max(1, Math.round(cfg.splitCount ?? 5));
  const child = b.radius * (cfg.bombletScale ?? 0.45);
  // Evenly spaced and then jittered, rather than fully random: pure random
  // angles clump, and a cluster that throws four of its five bomblets the same
  // way has visibly missed three quarters of the water it was aimed at.
  const step = (Math.PI * 2) / count;
  const offset = Math.random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const a = offset + step * (i + (Math.random() - 0.5) * 0.6);
    const speed = jitter(cfg.splitSpread ?? 3.2, 0.45);
    spawnBomb(scene, b.mesh.position, child, {
      vx: Math.cos(a) * speed + b.vx * 0.25,
      vy: Math.sin(a) * speed + b.vy * 0.25,
      timer: jitter(cfg.fuse ?? 0.8, cfg.fuseVary ?? 0.6),
    });
  }
  scene.remove(b.mesh);
  hooks.onSplit?.(b.mesh.position.x, b.mesh.position.y);
}

// A bomblet going off. Seals everything it covers, up to the cap, and each
// catch gets its own shell.
function detonate(scene, b, enemiesList, hold, maxCatch, hooks) {
  let caught = 0;
  for (const e of enemiesList) {
    if (caught >= maxCatch) break;
    if (e.trapTimer > 0) continue;
    // A bubble does not seal a boss. Skipped while CHOOSING, not refused after
    // — `maxCatch` is the bomblet's whole budget, and a pop that spent one of
    // its catches on a boss it cannot hold would seal one fewer fish for
    // nothing. See systems/control.js.
    if (!canHold(e)) continue;
    const dx = e.mesh.position.x - b.mesh.position.x;
    const dy = e.mesh.position.y - b.mesh.position.y;
    const reach = b.radius + e.radius;
    if (dx * dx + dy * dy > reach * reach) continue;
    e.trapTimer = hold;
    hooks.onTrap?.(e);
    // One shell per creature rather than one per bomblet: two fish sealed by
    // the same pop are two fish in two bubbles, which is the only version that
    // still reads once they drift apart.
    addShell(scene, e, b, caught === 0);
    caught += 1;
  }
  // The mesh became the first shell if anything was caught; otherwise this is a
  // bubble popping in open water, which is a visible miss and meant to be.
  if (caught === 0) scene.remove(b.mesh);
  hooks.onPop?.(b.mesh.position.x, b.mesh.position.y);
}

// `reuse` hands the bomblet's own mesh to the first creature it caught, so the
// bubble that popped is the bubble that closes — no pop-out and back in on the
// frame of the catch. Anything else caught by the same pop gets a fresh one.
function addShell(scene, enemy, bubble, reuse) {
  const mesh = reuse ? bubble.mesh : createVisual('trapBubble');
  if (!reuse) scene.add(mesh);
  mesh.position.copy(enemy.mesh.position);
  shells.push({
    mesh,
    enemy,
    age: 0,
    from: bubble.radius,      // the size it arrived at
    fit: fitRadius(enemy),    // ...and the size it closes to
    // Per-shell so a crowd of held fish doesn't breathe in lockstep, which
    // reads as one object rather than several.
    phase: Math.random() * Math.PI * 2,
    flickerPhase: 0,
  });
}
