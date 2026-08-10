import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ASSETS, createVisual, assetSignatureColor, assetBaseColor } from '../assets.js';
import { removeEnemy } from '../entities/enemies.js';
import { buildChain, applyChainToPoint, measureReach } from './ikChain.js';
import { springFollow } from './orbit.js';
import { attachBioluminescence } from './bioluminescence.js';
import { createBoneSpring } from './boneSpring.js';

// Octopus Grabber — the only DEFENSIVE companion in the game, driven by the
// real six-arm rig in /models/octopus_rig.glb.
//
// Every other companion adds output. This one removes threats from the board:
// each arm reaches out on its own cooldown, latches onto its OWN fish, and
// reels it in to be popped into chum. A fish an arm has hold of cannot touch
// you.
//
// That protection needs no new machinery. `e.trapTimer` already means "held
// and inert" — combat.js skips contact damage for it, the separation pass
// skips it, and triggerBite refuses to fire. Topping it up every frame while
// an arm holds a fish buys the whole promise on the card using the convention
// the beluga's bubble and Bakalar's net already use, rather than inventing a
// second flag every one of those call sites would then have to learn.
//
// HOW THE RIG IS DRIVEN
//
// The file ships 128 bones and ZERO animation clips, so there is no clip to
// blend against and everything here is procedural:
//
//   head    the 3-bone mantle chain aims at a point ahead of the body, and
//           that same point is what the body accelerates toward. Steering and
//           propulsion are the same vector, so the octopus swims where its
//           head is pointing instead of sliding sideways.
//   arms    six chains of 18 bones. An idle arm's target trails behind the
//           body and it holds most of its rest pose (a low IK weight, hence
//           "loosely"). An engaged arm's target is a fish, and its weight
//           ramps up — which is what makes the grab read as a reach out of
//           the dangle rather than a snap.
//
// The ramp IS the additive blend: applyChainToPoint slerps each bone between
// its rest pose and the solved pose by `weight`, so easing weight from
// dangle to reach animates the arm toward the target over time.
//
// ARM COUNT IS NOT RIG COUNT. The model has six tentacles at every level;
// CONFIG.octoGrab.arms is how many may be GRABBING at once. Hiding tentacles
// at low level would look like a broken octopus, so the surplus dangle.
//
// CAMOUFLAGE. A real octopus takes the colour of what it is near, and this one
// does it PER ARM: each tentacle's glow channel eases toward the colour of the
// nearest creature within CONFIG.octoGrab.camouflage.radius — the fish it has
// hold of if it has one — and back to the configured glow colour when there is
// nothing close. Six arms therefore routinely wear six different colours at
// once, which is the whole read: the bundle tells you what is around you and
// which arms are on it. See setChannelColor in systems/bioluminescence.js.

let body = null;
let chains = []; // one per arm, in rig order
let headChain = null;
let glowRig = null; // bioluminescence handle, one channel per arm
const arms = []; // per-arm state, index-matched to `chains`

const bodyPos = new THREE.Vector3();
const bodyVel = new THREE.Vector3();
const prevVel = new THREE.Vector3(); // last frame's velocity, for the drag impulse
const _accel = new THREE.Vector3();
const headTarget = new THREE.Vector3();
let clock = 0;
let jetClock = 0;

// Scratch. The per-arm loop runs six times a frame and allocating in it is the
// one place here that would show up in a profile.
const _target = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tint = new THREE.Color();
const _camTint = new THREE.Color();

// --- camouflage ------------------------------------------------------------
// "What colour is this creature", answered once per asset and then cached.
//
// Three sources, in the order of how much each actually knows:
//
//   1. the tuned look. A tint or emissive chosen in the T panel wins outright,
//      because somebody picked it on purpose. Read fresh every time rather
//      than cached, so moving the slider re-colours the arms immediately.
//   2. the average of the model's own base texture. The only source that
//      knows a clownfish is orange — a textured model's material colour is
//      almost always plain white, so sampling the material first would paint
//      every arm the same nothing.
//   3. the material colour, which is what the untextured procedural
//      stand-ins carry, and then the asset's authored fallback colour.
//
// Averaging needs a canvas, so it is guarded on `document` (the Node harnesses
// have none) and every failure path falls through to the next source rather
// than throwing. Downscaled to 16x16 by the draw itself, so the read-back is
// 256 pixels however big the texture is.
const tintCache = new Map();

function averageTextureColor(tex) {
  const img = tex?.image;
  if (!img || typeof document === 'undefined') return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!w || !h) return null;

  try {
    const N = 16;
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;

    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Transparent padding is most of some atlases and is pure black in the
      // colour channels — averaging it in drags every creature toward dark.
      if (data[i + 3] < 8) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (!n) return null;
    // Bytes are sRGB; everything downstream of here is linear, and the glow is
    // added to a linear frame buffer. Converting on the way in is what stops
    // the tint reading two stops brighter than the fish it came from.
    return new THREE.Color().setRGB(
      r / (n * 255), g / (n * 255), b / (n * 255), THREE.SRGBColorSpace,
    );
  } catch {
    return null; // a tainted or not-yet-decoded image; the fallbacks cover it
  }
}

/**
 * @returns {THREE.Color|null} possibly SHARED scratch — read it or copy it on
 *   the spot, never hold onto it.
 */
function creatureTint(e) {
  const key = e?.def?.asset ?? e?.type ?? null;

  const tuned = key ? assetSignatureColor(key) : null;
  if (tuned != null) return _tint.set(tuned);

  if (key && tintCache.has(key)) return tintCache.get(key);

  let color = null;
  // A texture that exists but has not DECODED yet. The answer this call gives
  // is still usable, but it must not be cached — a model whose texture landed
  // a frame late would otherwise wear its material colour (plain white, for
  // anything textured) for the rest of the session. Narrowed to "no dimensions
  // yet" on purpose: every other reason averaging can fail is permanent, and
  // retrying those would mean traversing the mesh again on every frame.
  let provisional = false;

  e?.visual?.traverse((o) => {
    if (color || !o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!mat) return;
    color = averageTextureColor(mat.map);
    if (!color) {
      const img = mat.map?.image;
      if (mat.map && !(img?.width || img?.videoWidth)) provisional = true;
      if (mat.color) color = new THREE.Color(mat.color);
    }
  });

  if (!color && key) {
    const fallback = assetBaseColor(key);
    if (fallback != null) color = new THREE.Color(fallback);
  }
  if (key && !provisional) tintCache.set(key, color);
  return color;
}

// The nearest creature to a POINT — the arm's own solved tip, not the body, so
// "close to" means close to that tentacle rather than close to the octopus.
// Unfiltered by size on purpose: an arm brushing a megalodon it could never
// grab should still take its colour.
function nearestCreature(x, y, list, radius) {
  let best = null;
  let bestD2 = radius * radius;
  for (const e of list) {
    const dx = e.mesh.position.x - x;
    const dy = e.mesh.position.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// Walk a single-child bone run from `root` to `tip`. The rig's chains are
// unbranched, so the middle is derivable — which beats listing all 19 bones
// per arm in assets.js, where 114 names is 114 chances to typo one and get a
// chain that silently resolves short.
function boneRun(instance, rootName, tipName, label) {
  const root = instance.getObjectByName(rootName);
  const tip = instance.getObjectByName(tipName);
  if (!root || !tip) {
    console.warn(`[octoGrab] ${label}: could not find ${!root ? rootName : tipName} — this arm will not move.`);
    return null;
  }

  // Walk UP from the tip rather than down from the root: a bone has one
  // parent but may have several children, so the upward walk is unambiguous
  // even if the rig later grows a branch.
  const names = [];
  let cur = tip;
  while (cur && cur !== root) {
    names.unshift(cur.name);
    cur = cur.parent;
    if (names.length > 64) break; // a cycle, or the tip isn't under this root
  }
  if (cur !== root) {
    console.warn(`[octoGrab] ${label}: ${tipName} is not a descendant of ${rootName} — this arm will not move.`);
    return null;
  }
  names.unshift(root.name);
  return names;
}

export function createOctoGrabber() {
  body = createVisual('octoGrabber');
  body.visible = false;
  buildChains();
  return body;
}

function buildChains() {
  // The old handle points at materials on a mesh that is being thrown away —
  // released here rather than in rebuildOctoGrabber so the create and rebuild
  // paths can't disagree about whose job it is.
  glowRig?.dispose();
  glowRig = null;
  chains = [];
  headChain = null;
  arms.length = 0;

  const rig = ASSETS.octoGrabber?.armRig;
  if (!rig || !body) return;

  // A procedural stand-in has no bones at all. That is a legitimate state —
  // the model may simply not have loaded — so it warns once and the whole
  // system then no-ops rather than throwing every frame.
  rig.arms.forEach((spec, i) => {
    const bones = boneRun(body, spec.root, spec.tip, `arm ${i}`);
    if (!bones) return;
    const chain = buildChain(body, { bones, tipAxis: rig.tipAxis, name: `arm${i}` }, rig.tipAxis, `arm ${i}`);
    if (!chain) return;
    chains.push(chain);
    const slot = chains.length - 1;
    // Per-arm spring stiffness, spread either side of the configured value so
    // the six settle at visibly different rates. Derived from the slot rather
    // than randomised, so an arm's character is stable across a run instead of
    // being reshuffled on every reset.
    const spread = CONFIG.octoGrab.drift.stiffnessVariance;
    const bias = chains.length > 1 ? (slot / (chains.length - 1)) * 2 - 1 : 0;

    arms.push({
      chain,
      slot,
      state: 'idle', // idle | reaching | holding
      target: null,
      cooldown: Math.random() * CONFIG.octoGrab.grabCooldown,
      reaching: 0, // seconds spent extending, for the grasp timeout
      weight: CONFIG.octoGrab.dangleWeight,
      // The lagging IK target and its velocity — this pair IS the secondary
      // motion (see CONFIG.octoGrab.drift).
      lag: new THREE.Vector3(),
      lagVel: new THREE.Vector3(),
      // Accumulated by the spread pre-pass each frame and spent in the spring
      // section — see computeSpread. Held per arm rather than applied on the
      // spot because the pass needs every tip measured before any of them move.
      spreadForce: new THREE.Vector3(),
      stiffMul: 1 + bias * spread,
      glow: 0, // eased 0..1, drives this arm's bioluminescence channel
      // This arm's live camouflage colour, eased toward whatever it is near.
      tint: new THREE.Color(CONFIG.octoGrab.glow?.color ?? 0xffffff),
      // Per-bone flow. Built over the DRIVEN bones only — the last entry of
      // the run is the `_end` locator, and handing it to the spring would
      // both waste a joint on something that deforms nothing and rob the last
      // real bone of the child it needs to know which way it points.
      spring: createBoneSpring(chain.bones.slice(0, -1), {
        tipAxis: chain.tipAxis,
        tipLength: chain.tipLength,
      }),
    });
  });

  const headBones = boneRun(body, rig.head.root, rig.head.tip, 'head');
  if (headBones) {
    headChain = buildChain(
      body,
      { bones: headBones, tipAxis: rig.tipAxis, name: 'head' },
      rig.tipAxis, 'head', 1,
    );
  }

  if (!chains.length) {
    console.warn('[octoGrab] no arm chains resolved — the octopus will drift with no tentacle motion.');
    return;
  }

  // One glow channel per arm, parameterised along the arm's own bone chain, so
  // channel N lights exactly the tentacle that arm N is driving. The chains
  // are handed over as bone-name lists — the same lists the IK was built from,
  // so the glow can never disagree with the motion about which arm is which.
  const g = CONFIG.octoGrab.glow;
  glowRig = g?.enabled === false ? null : attachBioluminescence(body, {
    tag: 'octoArms',
    channels: chains.length,
    source: { type: 'boneChains', chains: chains.map((c) => c.bones.map((b) => b.name)) },
    color: g.color,
    strength: g.strength,
    falloff: g.falloff,
    span: g.span,
    ambient: g.ambient,
    shimmerAmp: g.shimmerAmp,
    shimmerFreq: g.shimmerFreq,
    shimmerSpeed: g.shimmerSpeed,
  });
}

// Same singleton-swap need as every other companion: a model uploaded from the
// T panel wouldn't appear until a reload. The chains are bound to the specific
// bone instances, so they have to be rebuilt with the mesh.
export function rebuildOctoGrabber(scene) {
  if (!body) return;
  const { position, visible } = body;
  scene.remove(body);
  body = createVisual('octoGrabber');
  body.position.copy(position);
  body.visible = visible;
  buildChains();
  scene.add(body);
}

// How far an arm can stretch. Scales with ability level — the grab radius is
// the stat the upgrade actually buys — but is CAPPED at the arm's real reach,
// measured from the rig each frame. Letting the config ask for more than the
// tentacle is long would mean the IK straightens the arm, fails to touch the
// fish, and the grab lands anyway from a tip that is visibly nowhere near it.
function armReach(chain, level) {
  const c = CONFIG.octoGrab;
  const wanted = c.reach + c.reachPerLevel * (Math.max(1, level) - 1);
  // Capped at what the arm can physically cover, times whatever strain is
  // allowed. Measured from the rig every frame rather than configured, so it
  // survives the `fit` scale and the per-asset size slider — a bigger
  // octopus genuinely does have a longer reach.
  return Math.min(wanted, measureReach(chain, 1) * (c.reachStretch ?? 1));
}

// Where an idle arm trails: behind the body, fanned across the trail so six
// tentacles don't converge on one point, sagging a little, and wandering.
function danglePoint(arm, out) {
  const c = CONFIG.octoGrab;
  const n = Math.max(1, chains.length);
  // -1..1 across the fan, so the arms spread either side of the trail line.
  const lane = n > 1 ? (arm.slot / (n - 1)) * 2 - 1 : 0;

  // Opposite the direction of travel. A near-stationary octopus has no
  // meaningful travel direction, so it falls back to straight down and the
  // arms simply hang.
  const speed = Math.hypot(bodyVel.x, bodyVel.y);
  if (speed > 0.4) _dir.set(-bodyVel.x / speed, -bodyVel.y / speed, 0);
  else _dir.set(0, -1, 0);
  _perp.set(-_dir.y, _dir.x, 0);

  // Two wander octaves at a non-harmonic ratio. One sine on its own reads as a
  // metronome the moment you watch it for more than a few seconds; the second,
  // slower and off-ratio, keeps the drift from ever landing on an obvious
  // beat. Each arm is phase-offset by its slot so no two wander together.
  const d = c.drift;
  const phase = arm.slot * 1.7;
  const wobble =
    Math.sin(clock * c.idleWave + phase) * c.idleAmp +
    Math.sin(clock * c.idleWave * d.wanderOctave + phase * 2.3) * c.idleAmp * d.wanderOctaveAmp;
  const sag =
    Math.sin(clock * c.idleWave * 0.6 + arm.slot) * c.idleAmp * 0.5 +
    Math.cos(clock * c.idleWave * d.wanderOctave * 1.4 + phase) * c.idleAmp * 0.35;

  out.copy(bodyPos)
    .addScaledVector(_dir, c.dangleLength + wobble * 0.4)
    .addScaledVector(_perp, lane * c.dangleSpread + wobble);
  // Thrown further back the faster it swims, so the bundle visibly streams
  // behind a jetting octopus instead of staying the same length.
  out.x -= bodyVel.x * d.velocityDrag;
  out.y -= bodyVel.y * d.velocityDrag;
  out.y += -c.dangleDroop + sag;
  out.z = 0;
  return out;
}

// Smooth pseudo-random scalar in roughly [-1, 1], continuous in `t`.
//
// Three sines at non-harmonic ratios. Continuity is the requirement — this
// feeds a force, and a force that jumps between frames reads as a glitch
// rather than as turbulence — and the ratios are what stop it landing on an
// audible beat the way a single sine does within about two seconds of
// watching. Cheap enough to call six times a frame without thinking about it.
function wander(t, seed) {
  return Math.sin(t + seed) * 0.62
    + Math.sin(t * 1.618 + seed * 2.7) * 0.27
    + Math.sin(t * 2.714 + seed * 5.1) * 0.11;
}

// What the BODY should go after: the nearest fish it could actually grab,
// inside `hunt.radius`. Deliberately a different question from acquire()
// below, which asks what one ARM can reach right now — the body commits to
// things well outside arm range, which is the entire point of hunting.
function huntTarget(enemiesList) {
  const c = CONFIG.octoGrab;
  const h = c.hunt;
  let best = null;
  let bestD2 = h.radius * h.radius;

  for (const e of enemiesList) {
    // Same size gate the arms use. Charging something no arm can lift would
    // park the octopus next to a megalodon doing nothing.
    if (e.radius > c.maxTargetRadius) continue;
    // Already being reeled in — chasing it means swimming away from the seal
    // it is being delivered to.
    if (h.skipHeld !== false && arms.some((a) => a.target === e)) continue;

    const dx = e.mesh.position.x - bodyPos.x;
    const dy = e.mesh.position.y - bodyPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// Nearest ungrabbed, reelable fish inside this arm's reach.
//
// Nearest-first rather than biggest-first: the arm's job is to take pressure
// off, and the closest fish is the one about to land a hit. Fish already
// claimed by another arm are skipped, which is what "target separate fish with
// each one" comes down to.
function acquire(arm, enemiesList, reach) {
  const c = CONFIG.octoGrab;
  let best = null;
  let bestD2 = reach * reach;

  for (const e of enemiesList) {
    // Too big to move. An arm that latched onto a megalodon would be tied up
    // for the rest of the run pulling on something that doesn't budge.
    if (e.radius > c.maxTargetRadius) continue;
    if (arms.some((other) => other.target === e)) continue;

    const dx = e.mesh.position.x - bodyPos.x;
    const dy = e.mesh.position.y - bodyPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
}

// THE ANTI-BUNCHING PASS. See CONFIG.octoGrab.spread for why it is needed at
// all: with dangleWeight at 0 nothing poses an idle arm, and the drag and
// droop impulses push all six the same way, so the bundle collects into one
// rope under the mantle.
//
// Measured on last frame's solved tips. A frame of lag on a repulsion force is
// invisible, and it is what lets this run as a single pass BEFORE any arm has
// moved — computing it inside the main loop would have each arm pushing off
// tips that some of its neighbours had already updated and others hadn't,
// which is an asymmetric force and drifts the whole bundle sideways.
function computeSpread(dt) {
  const s = CONFIG.octoGrab.spread;
  for (const arm of arms) arm.spreadForce.set(0, 0, 0);
  if (!s || s.enabled === false || !arms.length) return;

  // THE FAN. Each arm owns a permanent bearing — its slot's share of the full
  // circle — and is pulled toward the point at `fanRadius` along it.
  //
  // This replaced a purely reactive version that only pushed once two tips had
  // already collapsed, and measured at an 8% improvement: a bounded impulse
  // fighting a stiffness-12 spring settles at a small deflection, so reacting
  // to a collapse can never undo one. Giving every arm somewhere to BE is what
  // holds the star open, and it costs nothing in looseness — this is a force
  // through the same spring, not an IK pose, so the arm still flows and
  // turbulence still owns its character. The fan only says which way out.
  //
  // Rotated to sit behind the direction of travel, like the old dangle fan, so
  // a swimming octopus streams its arms rather than holding a fixed compass
  // rose while it moves.
  const n = Math.max(1, arms.length);
  const speed = Math.hypot(bodyVel.x, bodyVel.y);
  const base = speed > 0.4 ? Math.atan2(-bodyVel.y, -bodyVel.x) : -Math.PI / 2;
  for (const arm of arms) {
    if (s.skipBusy !== false && arm.state !== 'idle') continue;
    // Spread across a fan centred on `base` rather than the whole circle, or
    // the two end arms meet again round the front of the body.
    const lane = n > 1 ? (arm.slot / (n - 1)) * 2 - 1 : 0;
    const bearing = base + lane * (s.fanArc ?? Math.PI) * 0.5;
    const wantX = bodyPos.x + Math.cos(bearing) * s.fanRadius;
    const wantY = bodyPos.y + Math.sin(bearing) * s.fanRadius;
    arm.spreadForce.x += (wantX - arm.chain.point.x) * s.fanForce;
    arm.spreadForce.y += (wantY - arm.chain.point.y) * s.fanForce;
  }

  // Radial: a tip that has still ended up inside minRadius is pushed straight
  // out along its own bearing. The fan above handles the steady state; this is
  // the hard floor for a tentacle that got dragged through the mantle anyway.
  for (const arm of arms) {
    const dx = arm.chain.point.x - bodyPos.x;
    const dy = arm.chain.point.y - bodyPos.y;
    const d = Math.hypot(dx, dy);
    if (d >= s.minRadius) continue;
    // A tip sitting exactly on the body has no bearing to push along; its slot
    // supplies one, which also guarantees the six pick different directions
    // out of that degenerate case instead of all choosing the same axis.
    const a = d > 1e-3 ? Math.atan2(dy, dx) : (arm.slot / n) * Math.PI * 2;
    const deficit = (s.minRadius - d) / s.minRadius; // 0 at the edge, 1 at the centre
    arm.spreadForce.x += Math.cos(a) * s.radialForce * deficit;
    arm.spreadForce.y += Math.sin(a) * s.radialForce * deficit;
  }

  // Pairwise: tips that have drifted within minGap of each other shove apart.
  // Equal and opposite, so this can never move the bundle as a whole.
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    if (s.skipBusy !== false && a.state !== 'idle') continue;
    for (let j = i + 1; j < arms.length; j++) {
      const b = arms[j];
      if (s.skipBusy !== false && b.state !== 'idle') continue;
      const dx = a.chain.point.x - b.chain.point.x;
      const dy = a.chain.point.y - b.chain.point.y;
      const d = Math.hypot(dx, dy);
      if (d >= s.minGap) continue;
      const push = ((s.minGap - d) / s.minGap) * s.gapForce;
      // Same degenerate case as above: two tips at the same point have no
      // separating axis, so the slots pick one.
      const ux = d > 1e-3 ? dx / d : Math.cos(a.slot * 2.4);
      const uy = d > 1e-3 ? dy / d : Math.sin(a.slot * 2.4);
      a.spreadForce.x += ux * push;
      a.spreadForce.y += uy * push;
      b.spreadForce.x -= ux * push;
      b.spreadForce.y -= uy * push;
    }
  }
}

function release(arm) {
  arm.target = null;
  arm.state = 'idle';
  arm.reaching = 0;
}

/**
 * hooks: { onGrab(e), onPop(e, x, y) }
 * `onPop` is where the caller turns the fish into chum — this system removes
 * the enemy but has no opinion about what it pays out.
 */
export function updateOctoGrab(dt, scene, playerPos, level, enemiesList, hooks = {}) {
  if (!body) return;

  const active = level > 0;
  body.visible = active;
  if (!active) {
    for (const arm of arms) release(arm);
    return;
  }

  const c = CONFIG.octoGrab;
  clock += dt;

  // --- head target: where it wants to be, and therefore where it swims ------
  // The preferred station is an offset from the seal. The head target leads
  // that by `lead` so the mantle is always pointing at where the body is
  // going rather than at where it already is.
  let wantX = playerPos.x + c.bodyOffset[0];
  let wantY = playerPos.y + c.bodyOffset[1];

  // THE HUNT. The station above is where it idles; a fish inside hunt.radius
  // drags that station toward itself, and because the head target is also the
  // thrust vector the whole animal goes with it. Blended rather than switched
  // so it leans into a chase and drifts back off one, instead of snapping
  // between two behaviours the moment a fish crosses the radius.
  const hunting = c.hunt?.enabled !== false ? huntTarget(enemiesList) : null;
  if (hunting) {
    const w = c.hunt.weight;
    wantX += (hunting.mesh.position.x - wantX) * w;
    wantY += (hunting.mesh.position.y - wantY) * w;
  }

  _dir.set(wantX - bodyPos.x, wantY - bodyPos.y, 0);
  const toStation = _dir.length();
  if (toStation > 1e-4) _dir.divideScalar(toStation);
  else _dir.set(0, 1, 0);

  headTarget.set(
    bodyPos.x + _dir.x * c.head.lead,
    bodyPos.y + _dir.y * c.head.lead,
    0,
  );

  // --- propulsion: jetted, not continuous ----------------------------------
  // An octopus glides between contractions. Thrusting every frame reads as a
  // hovering drone, so thrust only fires during the first `pulseFraction` of
  // each interval and the rest of the cycle is a coast.
  jetClock = (jetClock + dt) % Math.max(1e-3, c.head.pulseInterval);
  // A committed octopus spends far more of each cycle under power and pushes
  // harder while it does — coasting is what patrolling looks like, not what
  // closing on prey looks like.
  const duty = hunting ? (c.hunt.pulseFraction ?? c.head.pulseFraction) : c.head.pulseFraction;
  const jetting = jetClock < c.head.pulseInterval * duty;

  if (jetting) {
    // Scaled by how far off station it is, so it doesn't jet at full power
    // while already sitting where it wants to be.
    const urgency = Math.min(1, toStation / Math.max(1e-3, c.head.lead));
    const push = c.head.thrust * (hunting ? (c.hunt.thrustBoost ?? 1) : 1);
    bodyVel.x += _dir.x * push * urgency * dt;
    bodyVel.y += _dir.y * push * urgency * dt;
  }

  const damp = Math.exp(-c.head.drag * dt);
  bodyVel.x *= damp;
  bodyVel.y *= damp;
  const speed = Math.hypot(bodyVel.x, bodyVel.y);
  if (speed > c.head.maxSpeed) {
    bodyVel.x *= c.head.maxSpeed / speed;
    bodyVel.y *= c.head.maxSpeed / speed;
  }

  // Acceleration over this frame, in world units per second squared. Measured
  // from the velocity CHANGE rather than read off the thrust term, so it also
  // catches drag, the speed clamp and the arrival at station — every reason
  // the body's motion changes should throw the arms, not just the jet.
  _accel.subVectors(bodyVel, prevVel).divideScalar(Math.max(1e-4, dt));
  prevVel.copy(bodyVel);

  bodyPos.x += bodyVel.x * dt;
  bodyPos.y += bodyVel.y * dt;
  body.position.set(bodyPos.x, bodyPos.y, 0.04);

  // Face the way it's travelling. Entity-local +Y is the travel axis (see the
  // orientation note on ASSETS.octoGrabber), so the heading is a Z rotation
  // measured from +Y rather than from +X.
  if (speed > 0.5) {
    body.rotation.z = Math.atan2(bodyVel.y, bodyVel.x) - Math.PI / 2;
  }

  // The mantle aims at the same point the body is accelerating toward.
  if (headChain) {
    applyChainToPoint(headChain, dt, c.ik, c.head.weight, 1, headTarget);
  }

  // --- arms ----------------------------------------------------------------
  const grabbers = Math.min(chains.length, c.arms + c.armsPerLevel * (Math.max(1, level) - 1));
  const reelSpeed = c.reelSpeed + c.reelSpeedPerLevel * (Math.max(1, level) - 1);
  let grabbing = 0;

  // Every tip measured before any arm moves — see the note on computeSpread.
  computeSpread(dt);

  for (const arm of arms) {
    // A target killed by something else mid-reel is gone from enemiesList, and
    // holding the reference would leave the arm stretched toward a corpse.
    if (arm.target && !enemiesList.includes(arm.target)) release(arm);
    if (arm.cooldown > 0) arm.cooldown -= dt;

    const reach = armReach(arm.chain, level);
    if (arm.state !== 'idle') grabbing++;

    if (arm.state === 'idle') {
      // Only the first `grabbers` arms may take a fish; the rest dangle. The
      // gate is on ACQUIRING, not on holding, so an arm that already has one
      // when the count drops finishes its reel rather than dropping it.
      if (arm.cooldown <= 0 && grabbing < grabbers) {
        const found = acquire(arm, enemiesList, reach);
        if (found) {
          arm.target = found;
          arm.state = 'reaching';
          arm.reaching = 0;
          grabbing++;
          hooks.onGrab?.(found);
        }
      }
      danglePoint(arm, _target);
    } else if (arm.state === 'reaching') {
      const tp = arm.target.mesh.position;
      _target.set(tp.x, tp.y, 0);
      arm.reaching += dt;

      // Arrived when the solved tip actually got there — measured off the
      // CHAIN's own tip rather than assumed after a fixed time, so a fish
      // swimming away genuinely delays the catch.
      //
      // The timeout is the second condition and not a nicety: an arm straining
      // past its real length (see reachStretch) never gets its tip onto the
      // fish at all, so a distance test alone would leave those grabs stuck in
      // `reaching` for the whole run.
      const gap = arm.chain.point.distanceTo(_target);
      if (gap <= c.popDistance || arm.reaching >= c.graspTimeout) arm.state = 'holding';

      // Swam out of range while the arm was extending: give up rather than
      // stretch a tentacle across the arena.
      const away = Math.hypot(tp.x - bodyPos.x, tp.y - bodyPos.y);
      if (away > reach * 1.35) { release(arm); arm.cooldown = c.grabCooldown * 0.5; }
    } else if (arm.state === 'holding') {
      const e = arm.target;
      const tp = e.mesh.position;

      // THE PROTECTION. Topped up every frame rather than set once, because
      // enemies.js decrements it — a fish held through a long reel would
      // otherwise wake up and start biting halfway in.
      e.trapTimer = Math.max(e.trapTimer, 0.4);

      // Reel toward the SEAL, not toward the octopus: the fish is being
      // brought to the player, which is where the chum wants to end up.
      // Position is written directly for the same reason Bakalar's net does
      // it — enemies.js has already integrated velocity for the frame, so
      // anything short of writing the position gets undone.
      const dx = playerPos.x - tp.x;
      const dy = playerPos.y - tp.y;
      const dist = Math.hypot(dx, dy) || 1e-4;
      const step = Math.min(dist, reelSpeed * dt);
      tp.x += (dx / dist) * step;
      tp.y += (dy / dist) * step;
      _target.set(tp.x, tp.y, 0);

      if (dist <= c.popDistance) {
        const index = enemiesList.indexOf(e);
        if (index >= 0) {
          hooks.onPop?.(e, tp.x, tp.y);
          removeEnemy(scene, index);
        }
        arm.cooldown = c.grabCooldown;
        release(arm);
        danglePoint(arm, _target);
      }
    }

    // THE DRAG. An idle arm's target does not sit on the point computed above;
    // it lags behind it on a soft, per-arm spring. That lag is the secondary
    // motion — accelerate the body and the arms are still where it used to be,
    // then get hauled into line over the next half second.
    //
    // Engaged arms are exempt: an arm reaching for a fish should go to the
    // fish, not to where the fish was, and running the grab through the same
    // lazy spring made the grab itself feel unresponsive.
    if (arm.state === 'idle') {
      const d = c.drift;
      springFollow(arm.lag, arm.lagVel, _target, dt, d.stiffness * arm.stiffMul, d.damping);
      arm.lag.z = 0;
      _target.copy(arm.lag);
    } else {
      // Keep the lag tracking the live target while engaged, so releasing the
      // fish doesn't snap the arm back from a stale point half the arena away.
      arm.lag.copy(_target);
      arm.lagVel.set(0, 0, 0);
    }

    // The weight ramp is the additive blend — see the header. In toward the
    // reach weight while engaged, back out toward the dangle weight when not,
    // and slower on the way out because letting go is lazier than grabbing.
    const want = arm.state === 'idle' ? c.dangleWeight : c.reachWeight;
    const lerp = want > arm.weight ? c.weightLerpIn : c.weightLerpOut;
    arm.weight += (want - arm.weight) * (1 - Math.exp(-lerp * dt));

    // GLOW. The tip lights while the arm is working and fades slowly when it
    // lets go — so a glance at the bundle reads how much the octopus is
    // actually doing for you. Rise is fast (intent), fall is slow (afterglow).
    const g = c.glow;
    const wantGlow = arm.state === 'holding' ? g.holdLevel
      : arm.state === 'reaching' ? g.reachLevel
      : 0;
    const rate = wantGlow > arm.glow ? g.riseRate : g.fallRate;
    arm.glow += (wantGlow - arm.glow) * (1 - Math.exp(-rate * dt));
    glowRig?.setChannel(arm.slot, arm.glow);

    // CAMOUFLAGE. What this tentacle is holding, or failing that whatever is
    // nearest its TIP — see the header. Eased rather than switched, because
    // the whole point is watching the colour bleed across the arm as it
    // reaches; a hard set would just be six arms changing swatch.
    const cam = c.camouflage;
    if (glowRig && cam?.enabled !== false) {
      // Before the first solve the tip is still at the origin, which would
      // sample whatever happens to be near the middle of the arena.
      const tip = arm.chain.primed ? arm.chain.point : bodyPos;
      const near = arm.target ?? nearestCreature(tip.x, tip.y, enemiesList, cam.radius);
      const found = near ? creatureTint(near) : null;
      if (found) {
        // Pushed past what was sampled so the tint survives being added to an
        // already-lit body — a fish's own colour, added at its own level, is
        // a wash rather than a glow.
        _camTint.copy(found).multiplyScalar(cam.gain ?? 1);
        arm.tint.lerp(_camTint, 1 - Math.exp(-cam.blend * dt));
      } else {
        arm.tint.lerp(glowRig.baseColor, 1 - Math.exp(-cam.fade * dt));
      }
      glowRig.setChannelColor(arm.slot, arm.tint);
    }

    // IK writes the pose the arm is AIMING at...
    applyChainToPoint(arm.chain, dt, c.ik, arm.weight, 1, _target);

    // ...and the spring immediately declines to keep up with it. Run second,
    // because the solver's target is "wherever the pose already put this
    // bone" — doing it the other way round would have the IK stamp straight
    // over the flow every frame and nothing would ever lag.
    const sp = c.spring;
    if (arm.spring && sp.enabled !== false) {
      // THE WHIP. The spring only reacts to the parent chain rotating, and an
      // octopus sliding across the screen barely rotates at all — so without
      // this the arms would hang perfectly still while the body flew about.
      // Feeding body acceleration in as an impulse is what makes dragging it
      // around throw the tentacles.
      const mag = Math.min(sp.dragMax, _accel.length() * sp.dragGain);
      if (mag > 1e-3) {
        _dir.copy(_accel).divideScalar(_accel.length()).negate();
        arm.spring.impulse(_dir, mag * dt, sp.tipBias);
      }
      // A steady downward push, so the bundle hangs and sways under its own
      // weight rather than floating in a neutral star.
      if (sp.droop > 0) {
        _dir.set(0, -1, 0);
        arm.spring.impulse(_dir, sp.droop * dt, sp.tipBias);
      }

      // TURBULENCE. A slow, strong, per-arm force field — the thing that makes
      // a stationary octopus's arms move at all, since every other impulse
      // here is a reaction to the body going somewhere. See CONFIG's block:
      // the character is the ratio of a big strength to a small speed.
      const tb = c.turbulence;
      if (tb?.enabled !== false && tb.strength > 0) {
        const t = clock * tb.speed;
        const seed = arm.slot * 7.31;
        // Two octaves at a non-harmonic ratio, per axis. The x and y seeds are
        // offset rather than sharing one, or the vector would only ever swing
        // along a single diagonal.
        const nx = wander(t, seed) + wander(t * tb.octave, seed * 1.9) * tb.octaveAmp;
        const ny = wander(t, seed + 3.77) + wander(t * tb.octave, seed * 1.9 + 8.4) * tb.octaveAmp;
        _dir.set(nx, ny, 0);
        const mag = _dir.length();
        if (mag > 1e-4) {
          _dir.divideScalar(mag);
          // Some of the push is turned 90 degrees into a swirl around the
          // body. A purely linear shove slides a tentacle back and forth; the
          // tangential part is what makes it curl and sweep.
          if (tb.swirl > 0) {
            _perp.set(-_dir.y, _dir.x, 0);
            _dir.lerp(_perp, tb.swirl).normalize();
          }
          // Still moving while it works, just not thrashing hard enough to
          // miss the fish it is reaching for.
          const scale = arm.state === 'idle' ? 1 : (tb.busyScale ?? 1);
          arm.spring.impulse(_dir, tb.strength * mag * scale * dt, tb.tipBias ?? 1);
        }
      }

      // SPREAD, computed for every arm before any of them moved.
      const push = arm.spreadForce.length();
      if (push > 1e-4) {
        _dir.copy(arm.spreadForce).divideScalar(push);
        arm.spring.impulse(_dir, push * dt, c.spread.tipBias ?? 1);
      }

      arm.spring.update(dt, sp, arm.state === 'idle' ? sp.weightIdle : sp.weightBusy);
    }
  }

  if (glowRig) {
    glowRig.update(dt);
    // Re-read the look every frame so the tuner sliders move a creature that
    // is already on screen, rather than only the next one built.
    glowRig.apply(c.glow);
  }
}

export function resetOctoGrab(scene, playerPos) {
  const c = CONFIG.octoGrab;
  clock = 0;
  jetClock = 0;
  bodyVel.set(0, 0, 0);
  prevVel.set(0, 0, 0);
  _accel.set(0, 0, 0);
  // Placed BEFORE the arm loop, which seeds each lag vector on it — reading
  // bodyPos first would seed them at the previous run's position.
  bodyPos.set(
    (playerPos?.x ?? 0) + c.bodyOffset[0],
    (playerPos?.y ?? 0) + c.bodyOffset[1],
    0,
  );

  for (const arm of arms) {
    release(arm);
    arm.cooldown = Math.random() * c.grabCooldown;
    arm.weight = c.dangleWeight;
    arm.chain.primed = false;
    arm.glow = 0;
    // Back to the configured glow colour, or the arms open the next run still
    // wearing whatever they were last near in the previous one.
    arm.tint.set(c.glow?.color ?? 0xffffff);
    glowRig?.setChannelColor(arm.slot, null);
    // Seeded ON the body rather than at the origin: a lag vector left over
    // from a previous run would spend the first second of this one being
    // dragged across the arena, with six tentacles pointing at nothing.
    arm.lag.set(bodyPos.x, bodyPos.y, 0);
    arm.lagVel.set(0, 0, 0);
    arm.spreadForce.set(0, 0, 0);
    arm.spring?.reset();
    glowRig?.setChannel(arm.slot, 0);
  }

  if (body) {
    body.position.copy(bodyPos);
    body.visible = false;
  }
}
