import * as THREE from 'three';
import { snapSide } from './facing.js';
import { CONFIG } from '../config.js';
import { createVisual } from '../assets.js';
import { bounds } from '../arena.js';
import { removeEnemy } from '../entities/enemies.js';
import { aoe, companionDamage } from './scaling.js';
import { advanceCycles } from './beatSync.js';
import { canHold } from './control.js';

// Bakalar's Boat — a friendly trawler that sails the surface on a timer,
// dragging a net behind it. Anything the net sweeps through is caught, hauled
// up, and gone when the net reaches the hull.
//
// It's the beluga's trap read from the other direction: the bubble comes to
// the fish and holds it where it is, the net comes down from the sky and takes
// it away. That makes this the one ability in the game that removes enemies
// without dealing a point of damage — the reward is the XP orb the haul drops,
// so a boat sailing through a school is a clear AND a payday, and the tension
// is that you don't choose when it sails.
//
// The net is a rectangle hanging under the boat: `netWidth` across, from the
// surface down to `netDepth`. Enemies inside it are frozen with `trapTimer`
// (topped up every frame, so they can't wriggle free mid-haul) and their
// position is driven directly by this system.

// VOICEMAIL BOMBS — dropped into the loaded net while the boat sails, ON TOP
// of the haul rather than instead of it. The haul is a quiet remover: fish go
// up the net and away, and it never had a moment you could watch coming. The
// bomb is that moment. It falls down the net among whatever is still being
// dragged, sits armed and blinking for a beat, then detonates in a radius far
// wider than the net itself and pays the whole catch out as chum.
//
// Chum rather than XP, deliberately. The haul already pays XP through
// `onHauled`; if the bomb paid XP too the two halves of the same ability would
// be competing to collect the same fish, and the boat would quietly become the
// only upgrade worth taking. Paying in chum feeds the strike meter instead, so
// the bomb pays into a different loop than the net it rides on.
const bombs = []; // { mesh, y, targetY, fuse, armed, level }
let bombTimer = 0;

const caught = []; // { enemy, offsetX } — offsetX keeps the catch spread across the net
let boat = null;
let visual = null;
let spawnTimer = 0;
let sailing = false;
let dir = 1;
let clock = 0;
let netMesh = null;
// The beam bands' position, in cycles. Module scope rather than per-material:
// there is exactly one boat, and the value has to survive the mesh being
// rebuilt when the model is re-uploaded from the T panel.
let bandCycle = 0;

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

// ---------------------------------------------------------------------------
// THE TRACTOR BEAM
//
// This was a flat translucent rectangle: honest about the volume, and it read
// as a pane of glass hanging off the boat. What a beam has that a panel does
// not is FALLOFF — it is brightest on its axis and at its source, and it fades
// to nothing at its edges — and falloff is the thing that makes light look
// like light rather than like a shape.
//
// Three falloffs, all in one fragment shader, all sliders:
//
//   cone     the beam is narrow at the hull and wide at the bottom, so it
//            reads as coming FROM somewhere. Geometry stays a plain quad; the
//            width is a mask, so a net that grows with level costs no rebuild.
//   radial   soft across the beam, raised to `edgeFalloff` — this is the one
//            that decides whether it looks like a searchlight (high) or a slab
//            of colour (low).
//   depth    dimmer the further from the hull, because the water eats it.
//
// Over the top, bands scrolling UP the beam. They are the suction made
// visible: everything the beam is doing to a fish is upward, and without a
// direction cue a static glow reads as a wall rather than as a pull.
//
// ADDITIVE, and that is deliberate. The beam is light being added to the
// water, not a surface covering it, so it brightens whatever is behind it and
// never darkens anything — a fish inside the beam stays legible, which matters
// because the beam is full of fish by design. NoDepthWrite for the same
// reason: it must not occlude the catch it is hauling.
//
// (A backtick anywhere in here — even inside a comment — would end the
// template literal and produce an error pointing at a line of prose. Don't.)
const BEAM_VERT = `
  varying vec2 vBeamUv;
  void main() {
    vBeamUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAG = `
  uniform vec3  uColor;
  uniform float uIntensity;
  uniform float uTopWidth;    // beam width at the hull, as a fraction of the quad
  uniform float uEdgeFalloff; // >1 tightens the beam onto its axis
  uniform float uDepthFalloff;
  // The bands' position in CYCLES, advanced on the CPU so the beam can travel
  // on a musical division instead of at a rate in seconds — see
  // systems/beatSync.js.
  uniform float uBandCycle;
  uniform float uBandCount;
  uniform float uBandAmount;
  uniform float uCoreBoost;
  varying vec2  vBeamUv;

  void main() {
    // v: 0 at the bottom of the net, 1 at the hull. The whole shader is
    // written in "distance from the source" so every falloff below reads the
    // same way round.
    float v = vBeamUv.y;
    float axis = abs(vBeamUv.x - 0.5) * 2.0; // 0 on the axis, 1 at the quad edge

    // CONE. Narrow at the hull, full width at the bottom.
    float halfWidth = mix(1.0, uTopWidth, v);
    float radial = 1.0 - clamp(axis / max(halfWidth, 0.001), 0.0, 1.0);

    // The soft edge. smoothstep rather than the raw ramp so there is no hard
    // line where the cone mask reaches zero.
    float body = pow(smoothstep(0.0, 1.0, radial), uEdgeFalloff);

    // DEPTH. Brightest at the hull; the water eats the rest.
    float depth = pow(v, uDepthFalloff);

    // The bands, travelling UP — the suction made visible. Sped up slightly
    // toward the hull so they appear to accelerate into the boat, which is
    // what the fish inside are actually doing.
    //
    // That acceleration is why only ONE depth is exactly on the beat: the
    // (0.7 + v*0.6) factor scales the phase, so the grid holds where it is 1
    // (v = 0.5, the middle of the beam) and runs 30% fast at the hull. Keeping
    // the taper and syncing its midpoint is the right trade — the alternative
    // is a beam whose bands crawl at a uniform speed, which is the thing the
    // taper was added to fix.
    float bands = sin((v * uBandCount - uBandCycle * (0.7 + v * 0.6)) * 6.28318);
    bands = 1.0 + uBandAmount * bands;

    // A hot core down the axis, on top of the body. Without it the beam is
    // uniformly bright across its width and reads flat.
    float core = pow(body, 3.0) * uCoreBoost;

    float a = body * depth * bands + core * depth;
    // Additive: the alpha channel carries the whole strength, and the colour
    // is pushed past 1 so the bright pass in post.js blooms it.
    gl_FragColor = vec4(uColor * uIntensity * max(a, 0.0), max(a, 0.0));
  }
`;

function makeBeamMaterial() {
  const b = CONFIG.bakalar.beam;
  return new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(CONFIG.bakalar.netColor) },
      uIntensity: { value: b.intensity },
      uTopWidth: { value: b.topWidth },
      uEdgeFalloff: { value: b.edgeFalloff },
      uDepthFalloff: { value: b.depthFalloff },
      uBandCycle: { value: 0 },
      uBandCount: { value: b.bandCount },
      uBandAmount: { value: b.bandAmount },
      uCoreBoost: { value: b.coreBoost },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// Push the live config at the beam every frame, so the tuner sliders move a
// beam that is already sailing rather than only the next one.
function applyBeamSettings() {
  const b = CONFIG.bakalar.beam;
  const u = netMesh?.material?.uniforms;
  if (!u) return;
  u.uColor.value.set(CONFIG.bakalar.netColor);
  u.uIntensity.value = b.intensity;
  u.uTopWidth.value = b.topWidth;
  u.uEdgeFalloff.value = b.edgeFalloff;
  u.uDepthFalloff.value = b.depthFalloff;
  // uBandCycle is a POSITION, owned by the update below — not written here.
  u.uBandCount.value = b.bandCount;
  u.uBandAmount.value = b.bandAmount;
  u.uCoreBoost.value = b.coreBoost;
}

/**
 * How hard the beam pulls at a point, 0..1 — and the single source of truth
 * for it, because the LOOK and the PULL have to agree. The shader's falloff
 * and this function are the same two curves (across the cone, and down from
 * the hull); if they drifted apart, fish would be dragged hardest through the
 * dim parts of the beam, which is the kind of thing that reads as broken
 * without anyone being able to say why.
 *
 * @param dx    horizontal distance from the beam axis
 * @param depth how far below the hull, in world units
 * @param halfWidth the beam's half-width at the BOTTOM (the cone's wide end)
 * @param netDepth  the beam's full length
 */
export function suctionAt(dx, depth, halfWidth, netDepth) {
  const s = CONFIG.bakalar.suction;
  const v = 1 - Math.min(1, Math.max(0, depth / Math.max(1e-4, netDepth))); // 1 at the hull
  // Same cone the shader draws: narrow at the hull, wide at the bottom.
  const coneHalf = halfWidth * (1 - (1 - CONFIG.bakalar.beam.topWidth) * v);
  const radial = 1 - Math.min(1, Math.abs(dx) / Math.max(1e-4, coneHalf));
  if (radial <= 0) return 0;
  return Math.pow(radial, s.edgeFalloff) * Math.pow(v, s.depthFalloff) * s.strength;
}

function buildBoat() {
  const root = new THREE.Group();
  visual = createVisual('bakalarBoat');
  root.add(visual);
  return root;
}

export function createBakalarBoat(scene) {
  boat = buildBoat();
  boat.visible = false;
  scene.add(boat);

  // The beam. Still one quad — the shape is all in the fragment shader, which
  // is what lets the cone, the falloff and the scrolling bands be sliders
  // rather than geometry that has to be rebuilt whenever the net grows.
  //
  // See CONFIG.bakalar.beam for what each control does and why the beam
  // replaced the flat panel it used to be.
  netMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeBeamMaterial());
  netMesh.position.z = -0.15;
  netMesh.visible = false;
  scene.add(netMesh);

  return boat;
}

// Singleton, same as the beluga drone — a model uploaded from the T panel
// wouldn't appear until a reload without an explicit swap.
export function rebuildBakalarBoat(scene) {
  if (!boat) return;
  const { position, visible } = boat;
  scene.remove(boat);
  boat = buildBoat();
  boat.position.copy(position);
  boat.visible = visible;
  scene.add(boat);
}

export function resetBakalar(scene = null) {
  // Anything still in the net when a run ends is simply released — the enemy
  // array is about to be cleared by resetEnemies anyway, so removing them here
  // would just be fighting over the same indices.
  caught.length = 0;
  sailing = false;
  clock = 0;
  bombTimer = 0;
  // Bombs DO have to be cleaned up: unlike the catch, they own meshes this
  // module put in the scene, and nothing else will take them out.
  for (const b of bombs) b.mesh.parent?.remove(b.mesh);
  bombs.length = 0;
  if (boat) boat.visible = false;
  if (netMesh) netMesh.visible = false;
  spawnTimer = randomBetween(CONFIG.bakalar.spawnMin, CONFIG.bakalar.spawnMax);
}

function bombStats(level) {
  const c = CONFIG.bakalar.bomb;
  const lv = Math.max(1, level);
  return {
    interval: Math.max(c.dropIntervalFloor, c.dropInterval - c.dropIntervalPerLevel * (lv - 1)),
    // Splash Zone widens the BLAST and Big Rigz makes it hit harder — but
    // neither touches the net (netWidth/netDepth). The net is how the boat
    // works; the bomb is the moment you watch. Widening the net as well
    // would quietly turn one card into a second Bakalar upgrade.
    radius: aoe(c.radius + c.radiusPerLevel * (lv - 1)),
    damage: companionDamage(c.damage + c.damagePerLevel * (lv - 1)),
  };
}

function dropBomb(scene, x, netTop, netBottom, level) {
  const c = CONFIG.bakalar.bomb;
  const mesh = createVisual('voicemailBomb');
  mesh.position.set(x, bounds.surfaceY, -0.1);
  // multiplyScalar, not setScalar — see the note in systems/beluga.js. This
  // preserves the per-asset Size multiplier createVisual just applied.
  mesh.scale.multiplyScalar(c.size / 0.72); // the asset's authored radius
  scene.add(mesh);

  bombs.push({
    mesh,
    // THE BOMB SAILS WITH THE BOAT. It was dropped from a moving hull into a
    // moving net, so it inherits the hull's velocity and keeps pace with the
    // catch. Without this it hung in the water where it was released while the
    // net sailed on at 7 units/sec — by the time the ~1.9s of fall and fuse
    // had run, the fish it was meant to blow up were thirteen units downrange
    // and the blast reliably hit nothing at all.
    vx: dir * CONFIG.bakalar.speed,
    // Falls to the MIDDLE of the net rather than the bottom. The catch is
    // being hauled upward the whole time the bomb is falling downward, so
    // aiming at the floor of the net means the two pass each other.
    targetY: (netTop + netBottom) * 0.5,
    fuse: c.fuse,
    armed: false,
    level,
  });
}

// hooks: { onEnemyDamaged, onEnemyKilled, onBombBlast(x, y, radius), onChum(x, y) }
function updateBombs(dt, scene, enemiesList, hooks) {
  const c = CONFIG.bakalar.bomb;

  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    const s = bombStats(b.level);

    // Keeps pace with the net for its whole life, armed or not — the fuse
    // burns while it is still travelling with the catch.
    b.mesh.position.x += b.vx * dt;

    if (!b.armed) {
      b.mesh.position.y -= c.fallSpeed * dt;
      if (b.mesh.position.y <= b.targetY) {
        b.mesh.position.y = b.targetY;
        b.armed = true;
      }
    } else {
      b.fuse -= dt;
      // Blink faster as the fuse runs out — the tell that says "now".
      const urgency = 1 + (1 - Math.max(0, b.fuse) / Math.max(1e-3, c.fuse)) * 2;
      const on = Math.sin(clock * c.blinkSpeed * urgency) > 0;
      if (b.mesh.material?.color) b.mesh.material.color.set(on ? c.color : 0x2a2118);
    }

    if (!b.armed || b.fuse > 0) continue;

    // --- detonate ---------------------------------------------------------
    const x = b.mesh.position.x;
    const y = b.mesh.position.y;
    const r2 = s.radius * s.radius;
    let kills = 0;

    hooks.onBombBlast?.(x, y, s.radius);

    for (let j = enemiesList.length - 1; j >= 0; j--) {
      const e = enemiesList[j];
      const dx = e.mesh.position.x - x;
      const dy = e.mesh.position.y - y;
      if (dx * dx + dy * dy > r2) continue;

      e.hp -= s.damage;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;

      const len = Math.hypot(dx, dy) || 1e-4;
      e.vx += (dx / len) * c.knockback;
      e.vy += (dy / len) * c.knockback;

      hooks.onEnemyDamaged?.(e, s.damage, e.mesh.position.x, e.mesh.position.y);
      if (e.hp <= 0) {
        kills++;
        // Freed from the net first: the haul list holds a reference, and a
        // hauler still dragging a creature that has just been removed would
        // spend the rest of the sailing pulling on nothing.
        const held = caught.findIndex((h) => h.enemy === e);
        if (held >= 0) caught.splice(held, 1);
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, j);
      }
    }

    // Chum for the catch, plus a flat scatter so a bomb that hits nothing
    // still reads as worth having watched.
    const payout = c.chumScatter + kills * c.chumPerKill;
    for (let n = 0; n < payout; n++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * c.chumSpread;
      hooks.onChum?.(x + Math.cos(a) * d, y + Math.sin(a) * d);
    }

    scene.remove(b.mesh);
    bombs.splice(i, 1);
  }
}

function netGeometry(level) {
  const c = CONFIG.bakalar;
  return {
    halfWidth: (c.netWidth + c.netWidthPerLevel * (level - 1)) * 0.5,
    depth: c.netDepth + c.netDepthPerLevel * (level - 1),
  };
}

function launch(level) {
  const c = CONFIG.bakalar;
  sailing = true;
  // Reset per sailing rather than running free: the first bomb should land
  // partway through a pass with a net that has had time to fill, not on the
  // frame the boat appears with an empty one.
  bombTimer = bombStats(level).interval;
  dir = Math.random() < 0.5 ? 1 : -1;
  const { halfWidth } = netGeometry(level);
  // Start far enough out that the whole net is offscreen, so fish don't
  // materialise mid-haul at the arena edge.
  const margin = halfWidth + c.hullRadius + 2;
  boat.position.set(dir > 0 ? bounds.left - margin : bounds.right + margin, bounds.surfaceY, 0);
  // Hull is modelled along +X, same convention as systems/boats.js.
  // Snapped: this is an ARRIVAL, from off-screen, with a heading already —
  // see systems/facing.js and the same note in systems/boats.js.
  snapSide(boat, dir);
  boat.visible = true;
  netMesh.visible = true;
}

// Release everything without collecting it — used when the boat leaves with
// fish still being hauled, so nothing is left frozen forever offscreen.
function releaseAll() {
  for (const c of caught) c.enemy.trapTimer = 0;
  caught.length = 0;
}

// hooks: { onHauled(enemy) } — called just before the enemy is removed, so the
// caller can run its normal kill handling (score, XP orb) on it.
export function updateBakalar(dt, scene, level, enemiesList, hooks = {}) {
  if (!boat) return;

  const active = level > 0 && CONFIG.bakalar.enabled;
  if (!active) {
    if (sailing) { releaseAll(); sailing = false; boat.visible = false; netMesh.visible = false; }
    for (const b of bombs) scene.remove(b.mesh);
    bombs.length = 0;
    return;
  }

  const c = CONFIG.bakalar;
  clock += dt;

  // Bombs are updated BEFORE the sailing check, and outside it: one dropped on
  // the boat's last frame in the arena still has to fall, arm and go off. Tying
  // them to `sailing` would make a late drop vanish silently, which looks
  // exactly like a bug from the seabed.
  if (c.bomb?.enabled) updateBombs(dt, scene, enemiesList, hooks);

  if (!sailing) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      // More levels = the boat comes around more often. Clamped so a maxed
      // stack still leaves gaps you have to fight through on your own.
      const interval = Math.max(c.spawnMinFloor, c.spawnMin - c.spawnFasterPerLevel * (level - 1));
      spawnTimer = randomBetween(interval, Math.max(interval, c.spawnMax - c.spawnFasterPerLevel * (level - 1)));
      launch(level);
    }
    return;
  }

  const { halfWidth, depth } = netGeometry(level);

  boat.position.x += dir * c.speed * dt;
  boat.position.y = bounds.surfaceY + Math.sin(clock * c.bobSpeed) * c.bobAmount;
  boat.rotation.z = Math.sin(clock * c.bobSpeed * 0.7) * 0.06;

  // The net hangs straight down from the hull, trailing slightly behind it so
  // it looks dragged rather than carried.
  const netCenterX = boat.position.x - dir * c.netTrail;
  const netTop = boat.position.y;
  const netBottom = netTop - depth;
  netMesh.position.set(netCenterX, (netTop + netBottom) * 0.5, -0.15);
  netMesh.scale.set(halfWidth * 2, depth, 1);
  // `bandSpeed` is already in cycles per second (the shader multiplies the
  // whole term by 2π), so it needs no conversion. Wrap 1: one sin() reads it.
  bandCycle = advanceCycles(bandCycle, c.beam.bandSync, c.beam.bandSpeed, dt, 1);
  netMesh.material.uniforms.uBandCycle.value = bandCycle;
  applyBeamSettings();

  // --- catch: anything inside the net volume that isn't already held --------
  for (const e of enemiesList) {
    if (caught.some((h) => h.enemy === e)) continue;
    // The net passes over a boss. Refused at the CATCH rather than at the haul
    // below, because a boss in `caught` would be dragged toward the surface
    // with its steering intact — a worse picture than not catching it, and one
    // where the net visibly holds something that is plainly not held. See
    // systems/control.js.
    if (!canHold(e)) continue;
    const ex = e.mesh.position.x;
    const ey = e.mesh.position.y;
    if (Math.abs(ex - netCenterX) > halfWidth + e.radius) continue;
    if (ey > netTop + e.radius || ey < netBottom - e.radius) continue;
    caught.push({ enemy: e, offsetX: ex - netCenterX });
  }

  // --- drop a voicemail bomb into the loaded net ----------------------------
  // Gated on the net actually holding something (`minCatch`), so a boat
  // sailing through empty water doesn't litter the arena with bombs. The
  // timer only runs while sailing — the interval describes drops per
  // sailing, not per run.
  if (c.bomb?.enabled) {
    bombTimer -= dt;
    if (bombTimer <= 0 && caught.length >= c.bomb.minCatch) {
      bombTimer = bombStats(level).interval;
      // Dropped at the net's centre so it falls THROUGH the catch, rather than
      // at the hull where it would detonate above everything being hauled.
      dropBomb(scene, netCenterX, netTop, netBottom, level);
      hooks.onBombDrop?.(netCenterX, netTop);
    }
  }

  // --- haul: drag every catch up toward the hull ----------------------------
  for (let i = caught.length - 1; i >= 0; i--) {
    const h = caught[i];
    const e = h.enemy;

    // The enemy may have been killed by something else mid-haul; enemiesList is
    // the authority on what still exists.
    if (!enemiesList.includes(e)) {
      caught.splice(i, 1);
      continue;
    }

    // Topped up rather than set once: enemies.js decrements it every frame, so
    // a long haul would otherwise let the fish start swimming again halfway up.
    e.trapTimer = Math.max(e.trapTimer, 0.5);

    // THE SUCTION, and its falloff. This used to be a constant `haulSpeed`
    // with the catch pinned to a fixed offset — every fish rose at the same
    // rate wherever it sat, which is a conveyor belt, not a pull. Now the
    // strength comes from suctionAt(), the same two curves the beam is drawn
    // with, so a fish out at the dim edge is dragged slowly and one on the hot
    // axis is dragged fast, and what you see is what is happening.
    const belowHull = netTop - e.mesh.position.y;
    // The floor is applied ONCE, here, and both halves of the pull read the
    // result. A fish out past the cone edge gets a suction of exactly 0, and
    // without the floor reaching the inward draw as well it would never
    // converge — it would ride straight up the outside of the beam on the
    // minimum rise and never enter it. The falloff is meant to make the haul
    // uneven, not to strand anything outside the light.
    const pull = Math.max(
      c.suction.minPull,
      suctionAt(h.offsetX, belowHull, halfWidth, depth),
    );

    // Drawn IN toward the axis as well as up — the horizontal half of the
    // pull, and the reason the catch converges into a column under the hull
    // instead of riding up in the spread-out formation it was caught in.
    h.offsetX -= h.offsetX * Math.min(1, c.suction.inwardRate * pull * dt);

    // Position is written directly because enemies.js has already zeroed this
    // creature's velocity and integrated for the frame — this must run after
    // updateEnemies.
    e.mesh.position.x = netCenterX + h.offsetX;
    e.mesh.position.y = Math.min(netTop, e.mesh.position.y + c.haulSpeed * pull * dt);

    // Reached the hull: hauled out of the water and gone.
    if (e.mesh.position.y >= netTop - c.haulCatchGap) {
      const index = enemiesList.indexOf(e);
      if (index >= 0) {
        hooks.onHauled?.(e);
        removeEnemy(scene, index);
      }
      caught.splice(i, 1);
    }
  }

  // --- sailed off the far side ---------------------------------------------
  const margin = halfWidth + c.hullRadius + 3;
  if (boat.position.x < bounds.left - margin || boat.position.x > bounds.right + margin) {
    releaseAll();
    sailing = false;
    boat.visible = false;
    netMesh.visible = false;
    spawnTimer = randomBetween(c.spawnMin, c.spawnMax);
  }
}

// Exported for tools/ability-smoke.mjs. Nothing in Node can COMPILE GLSL, and
// the browser preview suspends requestAnimationFrame so it never renders a
// frame to compile it in either — which leaves the realistic failure here
// completely uncovered: a uniform renamed on one side of the pair and not the
// other. The material declares uniforms in JS and the shader reads them by
// name, and a mismatch is silently a black beam. Exposing both halves lets the
// harness check they agree.
export const __beamShader = { BEAM_VERT, BEAM_FRAG, makeBeamMaterial };
