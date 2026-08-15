import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { turbulenceAt } from '../entities/particles.js';

// ============================================================================
// THE INK TRAIL — what the giant squid leaves in the water behind it.
//
// THE DELIBERATE MIRROR OF systems/breachTrail.js, and the mirror is the point.
// The seal's breach trail is what a body leaves in AIR: bright, thin, fast, over
// in a second and a half. This is what a body leaves in WATER: dark, swelling,
// slow, and still there long after the animal has gone. Same skeleton — a cloud
// of particles with a ribbon threaded through it — read through the opposite
// optics at every step.
//
// WHAT IS SHARED, and shared on purpose rather than copied:
//
//   the spine          particles born at the source with an outward kick,
//                      pushed by the divergence-free turbulence field from
//                      entities/particles.js as an ACCELERATION, slowed by drag,
//                      each carrying its own lifetime.
//   the cross-section  evaluated per pixel rather than tessellated, so the soft
//                      edge has no polygon silhouette.
//
// WHAT IS NOT SHARED, AND WHY — THE ONE REAL DEPARTURE.
//
// The breach trail threads a RIBBON through its particles: one continuous band
// along a Catmull-Rom curve fitted to the cloud. That was tried here first and
// it is the wrong primitive for ink, for a reason worth writing down because it
// is not obvious and it cost an afternoon.
//
// A ribbon of half-width w drawn along a curve of radius R turns inside out as
// soon as w > R. The breach trail is never in danger: it is 0.72 units wide and
// lives 1.5 seconds, so the turbulence barely folds it inside its own lifetime.
// Ink is 3.4 units wide and lives seven — the field folds the curve into radii
// far tighter than the band is wide, constantly, everywhere. The fold guard then
// has to clamp the width to nearly nothing to stay legal, and every place it
// nearly-but-not-quite manages draws as a long dark hair standing off the cloud.
// Widening the guard's measurement helped, stabilising the rib frames helped,
// slowing the burst helped, and hairs kept coming, because none of them address
// the actual problem: A RIBBON IS A LINE, AND AN INK CLOUD IS NOT.
//
// So the particles are drawn AS PARTICLES — one soft instanced quad each, all
// in a single draw call. There is no spine, no spline, no curvature estimate and
// no fold guard, because there is no band to fold. Density comes out of the
// overlap: where the cloud is thick, quads stack and the alpha compounds, which
// is exactly how ink behaves and is something a single ribbon could never do at
// any width. It is also the cheaper of the two — the ribbon needed 260 curve
// samples per frame on top of the same simulation.
//
// WHAT IS OPPOSITE, and why each one:
//
//   NO RGB SPLIT. The breach trail's is a photographic artefact of a blown-out
//   HIGHLIGHT — three samples of one over-bright thing, a hair apart, summing
//   back to white where they agree. Ink is the ABSENCE of light. There is no
//   highlight to fringe, and three dark copies a hair apart are a muddy edge.
//
//   NORMAL BLENDING, NOT ADDITIVE. Additive can only ever make the frame
//   brighter, which is the one thing ink must not do. So the profile is carried
//   in ALPHA over a near-black colour, and each quad occludes what is behind it.
//   Overlapping quads blend twice and read DENSER, which is not a seam to be
//   fixed — it is how ink stacks, and it is what gives the cloud its internal
//   structure.
//
//   IT DRAWS OVER THE CREATURES. depthTest is off and the render order is above
//   the particles, so a cloud genuinely hides what is inside it — the boss, its
//   arms, and anything else that swims through. That is the whole mechanic; a
//   cloud you can see through is set dressing.
//
//   ...EXCEPT AROUND THE SEAL. `clearRadius` punches a soft hole in the ink
//   centred on the player. Without it the effect is briefly spectacular and then
//   unplayable: a boss whose whole job is filling the arena WILL eventually put
//   ink on top of you, and a player who cannot see their own animal has no way
//   to swim out of it. The hole is small — you can see yourself and your
//   immediate surroundings, and nothing else — so the ink still does its job.
//
//   IT LINGERS. `fade` BELOW 1 rather than above it, which is the single knob
//   that turns "fades out steadily" into "holds, then dissolves". See the note
//   on it in config.js.
//
// ONE CLOUD, ONE SOURCE. There is at most one boss alive at a time
// (maxConcurrent 1, and systems/boss.js is the only thing that can put one in
// the water), so this is a singleton like the breach trail rather than a pool.
// If a second inking creature ever exists, this needs to become an instance.
// ============================================================================


// One instanced quad per particle, one draw call. See the header for why this
// is not a ribbon.
const HARD_MAX_NODES = 700;   // higher than the breach trail's: this lives ~4x longer

let group = null;
let cloud = null;   // THREE.InstancedMesh
let capacity = 0;   // instances the geometry is currently sized for
let nodeCap = 96;   // particles the simulation may hold

// THE SPINE, newest first. Each entry is a live particle:
//   x, y        position, integrated every frame
//   vx, vy      its own velocity — outward kick + inherited travel, then drag
//   age, life   seconds; `life` is per-particle so the cloud dissolves raggedly
//   swell       the size multiplier this particle was born with. Around 1 for
//               the constant trail; up to `burstSwell` for one laid down by a
//               burst. This is the ENTIRE mechanism of an ink burst — see
//               burstInk.
//   strand      which emission run it belongs to. Kept because it costs nothing
//               and a future effect (a second inking creature, a fade-per-burst)
//               would want it; nothing reads it now that there is no ribbon to
//               break, which is one of the things the rewrite simplified away.
const nodes = [];

let clock = 0;
let emitDebt = 0;
let emitIndex = 0;
let strand = 0;
let hadSource = false;
let lastX = 0;
let lastY = 0;
// Particles owed to a burst, paid out over the frames after it fires rather
// than all at once — see burstInk.
let burstLeft = 0;
let burstTotal = 0;
let burstSwell = 1;
let burstSpread = 1;

const _col = new THREE.Color();
const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

function cfg() {
  return CONFIG.inkTrail ?? {};
}

// How many PARTICLES the simulation may hold — rate x life, plus the biggest
// burst that could be in flight, or a burst fired into an already-full cloud
// would evict its own head as it emitted.
function wantNodeCap(c) {
  const rate = Math.max(1, c.emitPerSecond ?? 34);
  const life = Math.max(0.05, c.life ?? 7) * (1 + Math.max(0, c.lifeVary ?? 0));
  const burst = Math.max(0, c.burstCount ?? 0);
  return Math.max(4, Math.min(c.maxNodes ?? HARD_MAX_NODES, Math.ceil(rate * life) + burst + 4));
}

// ---------------------------------------------------------------------------
// THE BLOB, in the fragment shader.
//
// Same two-term shape the breach trail uses across its band, evaluated radially
// instead of across a width — and every term means the opposite thing, because
// that trail is a highlight and this is the absence of one:
//
//   THE BODY   a wide, near-OPAQUE middle. This is the part that hides things.
//              The breach trail's equivalent is a thin filament, because a
//              highlight is a line; ink is a volume, so this is most of the disc.
//   THE EDGE   a soft skirt that never reaches a hard boundary. Without it every
//              particle is a visible circle, and a cloud of visible circles is a
//              cloud of bubbles rather than ink.
//
// `uClear` is the porthole. A WORLD-SPACE circle rather than anything baked into
// the geometry, because the ink does not move with the player: the hole has to
// slide across a cloud that is standing still.
// ---------------------------------------------------------------------------
const inkVertexShader = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  varying vec2 vLocal;
  varying vec2 vWorld;
  void main() {
    vAlpha = aAlpha;
    // -1..1 across the quad, which is what the radial profile is measured in.
    vLocal = position.xy * 2.0;
    vec4 world = instanceMatrix * vec4(position, 1.0);
    // The group sits at the origin in XY and is only pushed along Z, so this IS
    // the world position for the purposes of the porthole.
    vWorld = world.xy;
    gl_Position = projectionMatrix * modelViewMatrix * world;
  }
`;

const inkFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uBody;      // radius of the opaque middle, as a fraction
  uniform float uEdgeGain;
  uniform float uSoft;      // higher = the skirt hugs the body more tightly
  uniform float uOpacity;
  uniform vec2 uClear;      // the seal, in world units
  uniform float uClearR;
  uniform float uClearFeather;
  varying float vAlpha;
  varying vec2 vLocal;
  varying vec2 vWorld;

  void main() {
    float d = length(vLocal);
    // Off the disc entirely — the quad's corners. Discarded rather than shaded
    // to nothing so the overdraw of a few hundred overlapping quads stays cheap.
    if (d > 1.0) discard;
    float body = 1.0 - smoothstep(0.0, max(uBody, 0.001), d);
    // Generalised gaussian, as in the breach trail: at d = 1 this is about 2%,
    // so a particle has faded out before it reaches its own quad's edge and the
    // silhouette never shows.
    float skirt = exp(-pow(d, uSoft) * 4.0);
    // max rather than sum: two overlapping opacities that ADD clip to 1 across
    // most of the disc and flatten the profile into a hard-edged coin.
    float a = max(body, skirt * uEdgeGain) * vAlpha * uOpacity;

    // THE PORTHOLE. smoothstep from fully clear at the seal to fully inked at
    // radius + feather, so the player always has a readable bubble around
    // themselves however thick the water gets.
    a *= smoothstep(uClearR, uClearR + max(uClearFeather, 0.001), distance(vWorld, uClear));

    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
  }
`;

function buildCloud(scene, count) {
  disposeCloud(scene);
  capacity = count;
  group = new THREE.Group();
  group.name = 'inkTrail';
  group.frustumCulled = false;

  // A unit quad, scaled per instance. PlaneGeometry rather than a sphere or a
  // disc: the profile is a shader, so the geometry only has to be big enough to
  // hold it, and two triangles is the cheapest thing that is.
  const geo = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(1, 1);
  geo.index = plane.index;
  geo.attributes.position = plane.attributes.position;
  geo.attributes.uv = plane.attributes.uv;
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
  geo.instanceCount = 0;

  const mat = new THREE.ShaderMaterial({
    vertexShader: inkVertexShader,
    fragmentShader: inkFragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(0x05070c) },
      uBody: { value: 0.55 },
      uEdgeGain: { value: 0.85 },
      uSoft: { value: 1.7 },
      uOpacity: { value: 0.94 },
      uClear: { value: new THREE.Vector2(1e6, 1e6) },
      uClearR: { value: 2.2 },
      uClearFeather: { value: 2.6 },
    },
    transparent: true,
    // NORMAL, not additive. See the header: additive ink is a contradiction.
    blending: THREE.NormalBlending,
    depthWrite: false,
    // OFF, which is what lets the cloud hide creatures that are nominally in
    // front of it. Enemies scatter across a range of z (enemies.js gives each
    // one a depth lane), so no single z for this plane could reliably sit in
    // front of all of them and behind nothing.
    depthTest: false,
    side: THREE.DoubleSide,
  });

  cloud = new THREE.InstancedMesh(geo, mat, count);
  cloud.frustumCulled = false;
  // Rewritten every frame from a simulation that has already thrown away the
  // dead, so there is nothing for three to keep between frames.
  cloud.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Above the particles (10) and the breach trail (9): a bubble stream or a
  // damage burst shining through a cloud that is meant to be opaque would give
  // the whole effect away. Below the aim indicator (30), which is HUD.
  cloud.renderOrder = 12;
  group.add(cloud);
  plane.dispose();
  scene.add(group);
}

function disposeCloud(scene) {
  if (cloud) {
    cloud.geometry.dispose();
    cloud.material.dispose();
    cloud.dispose?.();
    cloud = null;
  }
  if (group) {
    scene.remove(group);
    group = null;
  }
  capacity = 0;
}

function setVisible(v) {
  if (group) group.visible = v;
}

// Coherent 1D noise in the emission counter. Every per-particle variation goes
// through this rather than through Math.random for the reason breachTrail.js
// spells out at length: independent randomness makes particle N go left and
// N+1 go right, so the spine is a sawtooth and a spline through a sawtooth is a
// beautifully smooth sawtooth.
function wave(u) {
  return Math.sin(u) * 0.6
    + Math.sin(u * 0.37 + 1.7) * 0.3
    + Math.sin(u * 0.19 + 4.1) * 0.1;
}

/**
 * Lay down one particle at (x, y).
 *
 * THREE VELOCITY TERMS, and they do different jobs:
 *
 *   THE JET      `jx, jy` is the direction the animal is squirting — measured
 *                off its own beak by systems/kraken.js, not inferred from where
 *                it happens to be going. This is the term that makes ink leave
 *                the body rather than appear beside it, and `drag` is what
 *                catches it a few units out. Fanned by the coherent wave so the
 *                jet spreads into a plume instead of firing a line of dots.
 *   THE KICK     a smaller sideways push along the normal, sign swinging on the
 *                wave. What gives the plume its lobes.
 *   THE INHERIT  a fraction of the animal's own travel, so the cloud is not
 *                left perfectly still in water the squid is moving through.
 */
function emitNode(x, y, dirX, dirY, vx, vy, c, swell = 1, spread = 1, jx = 0, jy = 0) {
  const u = emitIndex * (c.blowWave ?? 0.09);
  emitIndex++;

  const kick = (c.blowOut ?? 1.4) * wave(u) * spread;
  const nx = -dirY;
  const ny = dirX;
  const inherit = c.inherit ?? 0.12;

  // THE JET, fanned. `jetFan` is a half-angle in radians, swung by the wave, so
  // consecutive particles leave on slightly different headings and the squirt
  // opens into a cone. Sampled from the wave rather than from Math.random for
  // the reason everything here is: independent per-particle randomness makes
  // neighbours diverge, and a cloud whose neighbours diverge is confetti.
  let jetVX = 0;
  let jetVY = 0;
  const jetLen = Math.hypot(jx, jy);
  if (jetLen > 1e-6) {
    const speed = (c.jetSpeed ?? 0) * spread;
    if (speed > 0) {
      const a = Math.atan2(jy, jx) + (c.jetFan ?? 0) * wave(u * 1.7 + 2.9);
      jetVX = Math.cos(a) * speed;
      jetVY = Math.sin(a) * speed;
    }
  }

  // THE BAND'S OWN WOBBLE, and without it the constant trail reads as a painted
  // stripe rather than as ink. `growth` already varies the width from head to
  // tail, but that is one smooth gradient along the whole cloud — every part of
  // it the same age is the same width. A gentle per-particle term on top makes
  // the band swell and pinch in long lobes down its length, which is most of the
  // difference between "a dark line" and "something suspended in water".
  //
  // Sampled from the same coherent wave as everything else here, on its own
  // phase. Math.random would put a different width on every consecutive
  // particle, and a band whose half-width zigzags per sample is precisely the
  // comb the fold guard exists to prevent.
  const wobble = 1 + (c.widthVary ?? 0) * wave(u * 0.31 + 5.3);

  const node = {
    x,
    y,
    vx: jetVX + nx * kick + vx * inherit,
    vy: jetVY + ny * kick + vy * inherit,
    age: 0,
    life: Math.max(0.05, (c.life ?? 6)
      * (1 - (c.lifeVary ?? 0.4) * (0.5 + 0.5 * wave(u * 0.7 + 11)))),
    swell: swell * Math.max(0.15, wobble),
    strand,
  };
  nodes.unshift(node);
  while (nodes.length > nodeCap) nodes.pop();
}

/**
 * Integrate every particle and drop the dead ones.
 *
 * Runs whatever the boss is doing, and whether or not there IS a boss — a cloud
 * has to go on churning and dissolving after the fight ends. That is most of
 * what "lingers" means.
 */
function driftNodes(dt, c) {
  const drag = Math.exp(-Math.max(0, c.drag ?? 2.6) * dt);
  const turb = c.turbulence ?? 7;
  const freq = c.turbFreq ?? 0.3;
  const t = clock * (c.turbSpeed ?? 0.5);

  let write = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.age += dt;
    if (n.age >= n.life) continue;

    if (turb > 0) {
      // An ACCELERATION, so the push is KEPT and drag is what takes it away.
      // Water is the case this matters most in: the whole read of "ink in
      // water" is that it goes on creeping long after whatever moved it.
      const [tx, ty] = turbulenceAt(n.x * freq, n.y * freq, t);
      n.vx += tx * turb * dt;
      n.vy += ty * turb * dt;
    }

    n.vx *= drag;
    n.vy *= drag;
    n.x += n.vx * dt;
    n.y += n.vy * dt;

    nodes[write++] = n;
  }
  nodes.length = write;
}

/**
 * Fire an ink burst — the loud half of the effect.
 *
 * NOT A SECOND SYSTEM. A burst is `count` extra particles emitted over the next
 * few frames, each carrying a `swell` that multiplies its own SIZE. The cloud
 * thickens where they are, the turbulence pulls the thickening apart, and the
 * constant trail carries on through the middle of it. One geometry, one draw
 * call, and a burst automatically inherits every property the trail has — the
 * drift, the lingering fade, the porthole.
 *
 * PAID OUT OVER FRAMES rather than all at once: forty particles emitted inside
 * one frame all land at the same coordinates and draw as one disc. Spread over
 * the following frames they are laid down along the squid's actual path, which
 * is what makes a burst a cloud rather than a dot. See `burstPerFrame` — the
 * rate is set by matching the constant trail's particles-per-unit rather than
 * by taste.
 *
 * @param strength 0..1+, scales both how many and how wide. 1 is the configured
 *                 burst; the caller uses less than 1 for a nervous half-ink.
 */
export function burstInk(strength = 1) {
  const c = cfg();
  if (!c.enabled) return;
  const s = Math.max(0, strength);
  burstLeft = Math.max(burstLeft, Math.round((c.burstCount ?? 34) * s));
  burstTotal = burstLeft;
  burstSwell = (c.burstSwell ?? 3.2) * (0.5 + 0.5 * s);
  burstSpread = (c.burstSpread ?? 2.4) * (0.5 + 0.5 * s);
}

/**
 * Rebuild the cloud for this frame.
 *
 * @param dt      real seconds — the cloud is water, and a hit-stop must not
 *                stall it mid-billow. Same reasoning as the breach trail.
 * @param scene
 * @param source  `{ x, y, vx, vy, jx, jy }` — where ink is coming from and
 *                which way it is being squirted, or null when nothing is
 *                inking. `jx, jy` is a direction, not a speed: `CONFIG
 *                .inkTrail.jetSpeed` scales it. systems/kraken.js measures both
 *                off the animal's beak rather than off its travel, so a squid
 *                mid-turn inks out of its mouth and not out of its flank. Null does NOT clear the cloud; it stops
 *                emission and lets what is already in the water go on drifting,
 *                which is exactly what should happen when the boss dies.
 * @param focus   `{ x, y }` — the seal, for the porthole. Null parks the hole
 *                off-arena rather than at the origin, which is mid-arena and
 *                would put a permanent clear circle in the middle of the water.
 * @param emitting whether new ink should be laid down at all. Drifting happens
 *                regardless; emission is gated on the run being live, or a
 *                paused boss stacks the whole rate at one coordinate.
 */
export function updateInkTrail(dt, scene, source, focus = null, emitting = true) {
  const c = cfg();
  if (!c.enabled) {
    if (group) clearInkTrail(scene);
    return;
  }

  clock += dt;
  nodeCap = wantNodeCap(c);
  // The instance buffer is sized to the particle cap, so a tuner drag that
  // raises the rate or the lifetime rebuilds it rather than silently clipping
  // the cloud at whatever it was built for.
  if (!group || capacity !== nodeCap) buildCloud(scene, nodeCap);

  // A new source starts a new STRAND rather than clearing the cloud: the
  // previous boss's ink is still in the water and still worth looking at.
  const has = !!source;
  if (has && !hadSource) {
    strand++;
    emitDebt = 0;
    burstLeft = 0;
    burstTotal = 0;
    lastX = source.x;
    lastY = source.y;
  }
  hadSource = has;

  // Whatever else happens, the ink in the water keeps moving.
  driftNodes(dt, c);

  if (has && emitting) {
    const px = source.x;
    const py = source.y;
    const rate = Math.max(0, c.emitPerSecond ?? 26);
    emitDebt += rate * dt;
    let n = Math.floor(emitDebt);

    // The burst's share of this frame, capped so a big one still takes several
    // frames to come out.
    let fromBurst = 0;
    if (burstLeft > 0) {
      fromBurst = Math.min(burstLeft, Math.max(1, Math.round((c.burstPerFrame ?? 6))));
      burstLeft -= fromBurst;
    }

    if (n > 0 || fromBurst > 0) {
      emitDebt -= n;
      n = Math.min(n, 12);
      const vx = source.vx ?? 0;
      const vy = source.vy ?? 0;
      let tx = px - lastX;
      let ty = py - lastY;
      const len = Math.hypot(tx, ty);
      if (len < 1e-6) {
        const vlen = Math.hypot(vx, vy);
        if (vlen > 1e-6) { tx = vx / vlen; ty = vy / vlen; } else { tx = 0; ty = 1; }
      } else {
        tx /= len;
        ty /= len;
      }

      // REARMOST FIRST. emitNode unshifts, so the last one emitted becomes the
      // head of the spine; emitting front-to-back reverses the polyline by
      // nearly 180 degrees at the head on every multi-emit frame. This was the
      // largest single source of kinks in the breach trail and the fix is the
      // same one.
      const total = n + fromBurst;
      // How far through the burst's payout this frame's share sits. Used to
      // shape the swell as a smooth WINDOW rather than a step — see below.
      const doneBefore = burstTotal > 0 ? (burstTotal - burstLeft - fromBurst) / burstTotal : 0;
      for (let i = 0; i < total; i++) {
        const t = total > 1 ? (total - 1 - i) / total : 0;
        // The burst's particles go LAST — i.e. nearest the head — so a burst
        // reads as blooming out of the animal rather than out of its wake.
        const isBurst = i >= n;
        let swell = 1;
        let spread = 1;
        if (isBurst) {
          // A SMOOTH WINDOW, not a flat multiplier, and this is a fix for a
          // specific artefact rather than a refinement.
          //
          // Applied flat, the first burst particle sits next to a trail particle
          // at swell 1 and the band's half-width STEPS by a factor of three
          // between two adjacent spine samples. The fold guard then clamps hard
          // on one side of that step and not the other, and the three smoothing
          // passes cannot absorb a discontinuity that large — so the join comes
          // out as a comb of dark spikes, which is the same scalloping
          // breachTrail.js documents, arriving through a different door.
          //
          // A half-sine over the burst's own payout means the band opens and
          // closes continuously: every neighbouring pair of particles differs by
          // a few percent, which is what the guard and the smoothing are sized
          // for. It is also simply the right shape — ink billows out and thins
          // again rather than switching on.
          const k = burstTotal > 0 ? doneBefore + ((i - n) / burstTotal) : 0.5;
          const window = Math.sin(Math.PI * Math.max(0, Math.min(1, k)));
          swell = 1 + (burstSwell - 1) * window;
          spread = 1 + (burstSpread - 1) * window;
        }
        emitNode(
          lastX + (px - lastX) * (1 - t), lastY + (py - lastY) * (1 - t),
          tx, ty, vx, vy, c, swell, spread,
          source.jx ?? 0, source.jy ?? 0,
        );
      }
    }
  }

  // Outside the emit gate: a boss that kept moving behind a paused simulation
  // would otherwise have its next batch smeared across the whole gap.
  if (has) {
    lastX = source.x;
    lastY = source.y;
  }

  if (nodes.length < 1) {
    setVisible(false);
    return;
  }
  setVisible(true);
  group.position.z = c.z ?? 0.12;

  const u = cloud.material.uniforms;
  _col.set(c.color ?? 0x05070c);
  u.uColor.value.copy(_col);
  u.uBody.value = c.bodyWidth ?? 0.55;
  u.uEdgeGain.value = c.edgeGain ?? 0.85;
  u.uSoft.value = c.softness ?? 1.7;
  u.uOpacity.value = c.opacity ?? 0.94;
  u.uClearR.value = c.clearRadius ?? 2.2;
  u.uClearFeather.value = c.clearFeather ?? 2.6;
  // Parked far outside any arena when there is nobody to keep clear, rather
  // than at the origin — which is the middle of the water.
  if (focus) u.uClear.value.set(focus.x, focus.y);
  else u.uClear.value.set(1e6, 1e6);

  // ONE QUAD PER PARTICLE. No spine, no spline, no fold guard — see the header.
  const width = c.width ?? 3.4;
  const growth = c.growth ?? 4.2;
  const fade = c.fade ?? 0.5;
  const alpha = cloud.geometry.attributes.aAlpha;
  const count = Math.min(nodes.length, capacity);

  for (let i = 0; i < count; i++) {
    const n = nodes[i];
    const age = Math.min(1, n.age / n.life);
    // `growth` opens each particle as it ages — ink diffusing — and `swell`
    // is what a burst multiplies on top. The same two terms the ribbon used
    // for its half-width, now a radius.
    const r = width * n.swell * (1 + growth * age);
    _pos.set(n.x, n.y, 0);
    _quat.identity();
    _scale.set(r, r, 1);
    _mat.compose(_pos, _quat, _scale);
    cloud.setMatrixAt(i, _mat);
    // (1 - age)^fade with fade BELOW 1 is the lingering curve: still 71% at
    // half life, then dropping away over the last quarter. The breach trail
    // uses the same expression with fade above 1, which is the opposite shape.
    alpha.setX(i, (1 - age) ** fade);
  }

  cloud.count = count;
  cloud.geometry.instanceCount = count;
  cloud.instanceMatrix.needsUpdate = true;
  alpha.needsUpdate = true;
}

/** Tear the cloud down — run start, and whenever the effect is switched off. */
export function clearInkTrail(scene) {
  disposeCloud(scene);
  nodes.length = 0;
  emitDebt = 0;
  emitIndex = 0;
  strand = 0;
  hadSource = false;
  burstLeft = 0;
  burstTotal = 0;
  clock = 0;
}

/** How many particles are alive. For the harness and for perf logging. */
export function inkTrailCount() {
  return nodes.length;
}

/**
 * HOW ENCLOSED IS A POINT? — the measurement the kraken's trap is built on.
 *
 * Sweeps the ring around (x, y) and reports how much of it the cloud has walled
 * off. This lives here rather than in systems/kraken.js because it needs the
 * particle array, and handing that array out would make every reader a place the
 * cloud's representation could leak into.
 *
 * THE BAND IS LOAD-BEARING. Only particles between `rMin` and `rMax` count, and
 * both ends matter for a different reason:
 *
 *   rMin   ink ON the player is not a wall. A cloud the seal is standing inside
 *          would otherwise read as 100% enclosure at the exact moment the player
 *          is most obviously free to swim out of it.
 *   rMax   ink on the far side of the arena is not a wall either. Without this
 *          the drifting remains of every earlier burst slowly add up to a ring
 *          that was never built, and the boss fires its punish at nothing.
 *
 * EACH PARTICLE COVERS AN ARC, not a point. A blob's angular width is
 * `atan(halfWidth / distance)`, so the same particle plugs a lot of the ring up
 * close and almost none of it far away — which is the geometry the player
 * actually sees. Point-sampling instead makes a wall of fat, touching blobs read
 * as a sieve, and the trap would never close.
 *
 * Returns `{ coverage, gapAngle, gapDir, counted }`:
 *   coverage   0..1, the fraction of the ring with ink in it
 *   gapAngle   radians of the WIDEST unbroken opening — the way out
 *   gapDir     the bearing of that opening's centre, which is both where the
 *              player should swim and where the squid has to go to close it
 *   counted    how many particles were in the band at all
 */
const ENCIRCLE_BUCKETS = 72;   // 5 degrees each — finer than the player can read
const _ring = new Uint8Array(ENCIRCLE_BUCKETS);
export function inkEncirclement(x, y, opts = {}) {
  const c = cfg();
  const rMin = opts.rMin ?? 2.5;
  const rMax = opts.rMax ?? 20;
  _ring.fill(0);

  let counted = 0;
  const width = c.width ?? 1.15;
  const growth = c.growth ?? 4.2;
  for (const n of nodes) {
    const dx = n.x - x;
    const dy = n.y - y;
    const d = Math.hypot(dx, dy);
    if (d < rMin || d > rMax) continue;
    counted += 1;

    // The same half-width the draw loop uses, so what is measured is what is on
    // screen. A particle that has aged is wider, and it walls off more.
    const age = n.life > 0 ? n.age / n.life : 1;
    const half = width * n.swell * (1 + growth * age);

    const mid = Math.atan2(dy, dx);
    const spanHalf = Math.atan2(half, Math.max(0.001, d));
    const from = Math.floor((mid - spanHalf + Math.PI * 4) / (Math.PI * 2) * ENCIRCLE_BUCKETS);
    const to = Math.ceil((mid + spanHalf + Math.PI * 4) / (Math.PI * 2) * ENCIRCLE_BUCKETS);
    for (let b = from; b <= to; b++) _ring[((b % ENCIRCLE_BUCKETS) + ENCIRCLE_BUCKETS) % ENCIRCLE_BUCKETS] = 1;
  }

  let filled = 0;
  for (let i = 0; i < ENCIRCLE_BUCKETS; i++) filled += _ring[i];

  // THE WIDEST GAP, found on a doubled sweep so a run that straddles the wrap
  // point is one gap rather than two. A ring broken only at 0 degrees would
  // otherwise report two half-sized openings and the trap would look closed.
  let best = 0;
  let bestEnd = 0;
  let run = 0;
  for (let i = 0; i < ENCIRCLE_BUCKETS * 2; i++) {
    if (_ring[i % ENCIRCLE_BUCKETS]) { run = 0; continue; }
    run += 1;
    if (run > best) { best = run; bestEnd = i; }
  }
  // A completely empty ring is not a gap of 360 degrees around a meaningful
  // centre — it is no ring at all. Clamp so callers get one obvious signal.
  if (filled === 0) {
    return { coverage: 0, gapAngle: Math.PI * 2, gapDir: 0, counted };
  }
  const gapAngle = Math.min(best, ENCIRCLE_BUCKETS) / ENCIRCLE_BUCKETS * Math.PI * 2;
  const midBucket = (bestEnd - best / 2 + 0.5);
  const gapDir = (midBucket / ENCIRCLE_BUCKETS) * Math.PI * 2;

  return {
    coverage: filled / ENCIRCLE_BUCKETS,
    gapAngle,
    gapDir: Math.atan2(Math.sin(gapDir), Math.cos(gapDir)),
    counted,
  };
}

/**
 * The cloud's state, for the harness and for perf logging.
 *
 * `meanSpeed` is reported rather than left to be inferred from positions for
 * the reason breachTrailStats gives: particles DIE, so a caller diffing spine
 * coordinates between two frames is silently comparing different particles the
 * moment one in the middle expires.
 *
 * `meanSwell` is what tells a burst apart from the constant trail, and
 * `spread` is the cloud's own bounding extent — the number that answers
 * "is it still growing".
 */
export function inkTrailStats() {
  let speed = 0;
  let age = 0;
  let swell = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    speed += Math.hypot(n.vx, n.vy);
    age += n.age;
    swell += n.swell;
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const c = nodes.length || 1;
  return {
    count: nodes.length,
    meanSpeed: speed / c,
    meanAge: age / c,
    meanSwell: swell / c,
    spread: nodes.length ? Math.hypot(maxX - minX, maxY - minY) : 0,
    burstPending: burstLeft,
  };
}
