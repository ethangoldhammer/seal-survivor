import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, WAVE, sea } from '../arena.js';
import { hexMetrics, hexCorners, hexCellsIn } from './hexLattice.js';
import { touchSlots, TOUCH_SLOTS } from '../input.js';
import { retireMaterial } from './programPin.js';
import { POSSESSION_UNIFORMS_GLSL, POSSESSION_FIELD_GLSL } from './possessionGlsl.js';

// The backdrop grid. Every node is displaced in the vertex shader by a ring
// buffer of ripples plus a constant pull from the ship's wake, so the whole
// field breathes with what the player is doing. Nothing is simulated on the
// CPU — JS only pushes ripple positions into a uniform array.
//
// On a phone the player's own fingers are in there too: every contact shoves
// the lattice apart and lights it in a colour of its own. See CONFIG.grid
// .touchGlow, and input.js for how a finger gets its slot.

const MAX_RIPPLES = 24; // must match the shader's loop bound
// WAKE SOURCES. Slot 0 is the seal, always; the rest are HULLS — up to
// `boats.maxAlive` sailing past plus the one boat boss. The field pulls toward
// each of them, so a boat displaces the water it is sitting in instead of
// floating on a lattice that has not noticed it.
//
// Enough slots for the roster and no more: this is a per-vertex loop over the
// whole grid, so every slot is paid for on every vertex whether it holds
// anything or not. A source with zero strength contributes exactly nothing but
// still costs its iteration.
// Slot 0 is the seal holding the frame; 1..SEAL_WAKES-1 are the OTHER PLAYERS
// on the pitch (Blubberball), and the rest are hulls. The two get separate
// bands rather than sharing one queue because they fill on different clocks:
// five boats sailing past would otherwise take every slot and the seals
// swimming between them would stop denting the water, which is the one dent a
// player is actually looking for.
//
// The seal band is three deep on top of slot 0 — four dents on the water — and
// the hulls keep the five they always had. A roster bigger than that does not
// get a slot each: the seals FURTHEST from player 1 take them (see
// publishSealWakes in main.js), because a seal inside the player's own radius
// is already inside the player's own dent.
const MAX_WAKES = 9; // must match the shader's loop bound
const SEAL_WAKES = 4;
// Same contract, for the fingers. Read from input.js rather than retyped so the
// shader loop and the slot registry cannot drift apart.
const MAX_TOUCH = TOUCH_SLOTS;

// One vec4 per source, reused in place — a fresh array every frame would be a
// new uniform upload of the whole block.
const wakes = Array.from({ length: MAX_WAKES }, () => new THREE.Vector4(0, 0, 1, 0));
// Which slots were claimed by a hull this frame — see hullWake and the sweep in
// update(). A boolean per slot rather than a count, because a hull destroyed
// mid-frame must not leave the slot behind it holding its last position.
const wakeClaims = new Array(MAX_WAKES).fill(false);
let wakeCursor = SEAL_WAKES; // hulls start above the seals' band
let sealCursor = 1;         // slot 0 is the frame's own seal and is never handed out

// Cells something else has claimed and this must not move — see `pin` below.
const MAX_PINS = 8;

// THE BALL'S DENTS. Blubberball only: slot 0 is the ball itself, re-published
// every frame it is on the pitch, and the rest are the ECHOES it has left
// behind it — the water it has already been through, still springing back.
//
// Nothing in here decides when an echo is dropped or how hard: systems/
// ballGrid.js owns the whole ring buffer and republishes it wholesale, the way
// `pin` is republished, because the alternative is a dent left in the water
// where a ball used to be. What this file owns is the SHAPE of a dent — how it
// is stretched along the line the ball was travelling, how it springs, and
// what colour it is lit in.
//
// Eight, and for the same reason the wake band is small: every slot is a loop
// iteration over every vertex in the lattice whether it holds anything or not.
// At the shipped spacing eight dents is about twenty-five units of trail, which
// is a good deal more than a ball covers in the time one takes to die.
const MAX_BALL = 8;

const vertexShader = /* glsl */ `
  #define MAX_RIPPLES ${MAX_RIPPLES}
  #define MAX_TOUCH ${MAX_TOUCH}
  #define MAX_WAKES ${MAX_WAKES}
  #define MAX_PINS ${MAX_PINS}
  #define MAX_BALL ${MAX_BALL}

  uniform float uTime;
  uniform vec3 uRipples[MAX_RIPPLES];   // xy = origin, z = start time
  uniform vec2 uRippleParams[MAX_RIPPLES]; // x = strength, y = radius
  uniform vec4 uWake[MAX_WAKES];        // xy = source, z = radius, w = strength
  uniform vec4 uTouch[MAX_TOUCH];       // xy = world pos, z = radius, w = level
  uniform vec4 uTouchWarp;              // x = push, y = swirl, z = wave, w = spin
  uniform vec4 uPin[MAX_PINS];          // xy = centre, z = held radius, w = free radius
  // THE BALL AND ITS ECHOES. xy = centre, z = reach, w = SIGNED amplitude —
  // signed because the spring is solved on the CPU (systems/ballGrid.js) and
  // folded straight into it, so this shader has no clock of its own to
  // disagree with the one the echoes are aged on. A slot at 0 contributes
  // nothing but its iteration.
  uniform vec4 uBall[MAX_BALL];
  // xy = the HEADING this dent was born with, unit; z = the glow, which is the spring's
  // envelope WITHOUT its oscillation — a dent lit by the signed amplitude goes
  // black every time the spring crosses zero, which reads as a strobe rather
  // than as water settling.
  uniform vec4 uBallDir[MAX_BALL];
  uniform vec4 uBallWarp;               // x = radial shove, y = drive along the heading, z = swirl, w = stretch
  uniform float uDecay;
  uniform float uFreq;
  uniform float uWavelength;

  varying float vWarp;
  varying vec2 vPos;

  void main() {
    vec3 pos = position;
    vec2 disp = vec2(0.0);

    for (int i = 0; i < MAX_RIPPLES; i++) {
      vec2 delta = pos.xy - uRipples[i].xy;
      float dist = length(delta) + 0.0001;
      vec2 dir = delta / dist;

      float strength = uRippleParams[i].x;
      float radius = uRippleParams[i].y;
      float age = uTime - uRipples[i].z;

      float isLive = step(0.0001, strength) * step(0.0, age);
      float decay = exp(-age * uDecay);
      float wave = sin(dist * uWavelength - age * uFreq);
      float falloff = smoothstep(radius, 0.0, dist);

      disp += dir * wave * falloff * strength * decay * isLive;
    }

    // Every wake source, summed. The seal is slot 0 and the hulls follow it —
    // see MAX_WAKES. Unfilled slots carry a strength of zero and add nothing,
    // which is why there is no count uniform to branch on.
    for (int i = 0; i < MAX_WAKES; i++) {
      vec2 wakeDelta = pos.xy - uWake[i].xy;
      float wakeDist = length(wakeDelta) + 0.0001;
      float wakeFall = smoothstep(uWake[i].z, 0.0, wakeDist);
      disp += (wakeDelta / wakeDist) * wakeFall * uWake[i].w;
    }

    // Fingers. Two components on purpose: a radial shove that pulses outward
    // (the finger pushing the water away) and a tangential shear (the lattice
    // twisting around it). The radial part alone just makes a clean bubble —
    // it's the shear that breaks the hexes out of alignment with their
    // neighbours, which is the thing that reads as DISRUPTION rather than as
    // one more ripple. A slot with level 0 contributes exactly nothing.
    for (int i = 0; i < MAX_TOUCH; i++) {
      float level = uTouch[i].w;
      vec2 delta = pos.xy - uTouch[i].xy;
      float dist = length(delta) + 0.0001;
      vec2 dir = delta / dist;
      float fall = smoothstep(uTouch[i].z, 0.0, dist);
      float pulse = sin(dist * uTouchWarp.z - uTime * uTouchWarp.w);
      disp += (dir * pulse * uTouchWarp.x + vec2(-dir.y, dir.x) * uTouchWarp.y)
              * fall * level;
    }

    // THE BALL, AND EVERY DENT IT HAS LEFT BEHIND IT. Blubberball only.
    //
    // THREE COMPONENTS, and only the middle one is new. The radial shove and
    // the swirl are the finger's (above) and are here for the same reason: the
    // shove alone opens a clean bubble and it is the shear that breaks the
    // hexes out of alignment with their neighbours, which is what reads as
    // DISRUPTION rather than as one more ripple.
    //
    // The DRIVE is the ball's own. It pushes every node in the dent the same
    // way — along the heading, not away from the centre — so the lattice is
    // dragged bodily along the line of the flight. A dent made only of radial
    // terms is the same picture whichever way the ball was going, and the one
    // thing a player needs to read off the backdrop is which way it went.
    //
    // AND IT IS STRETCHED ALONG THAT LINE. The reach is measured in a frame
    // scaled by uBallWarp.w down the heading, so a fast ball smears its dent
    // out into a streak and a slow one leaves a circle.
    //
    // The heading is LAGGED, and a dent keeps the one it was born with — see
    // systems/ballGrid.js, which is where that is decided and why.
    for (int i = 0; i < MAX_BALL; i++) {
      float amp = uBall[i].w;
      if (amp == 0.0) continue;
      vec2 delta = pos.xy - uBall[i].xy;
      vec2 dir = uBallDir[i].xy;
      float along = dot(delta, dir);
      vec2 across = delta - dir * along;
      float reach = length(vec2(along / max(uBallWarp.w, 0.01), length(across)));
      float fall = smoothstep(uBall[i].z, 0.0, reach);
      if (fall <= 0.0) continue;
      float len = length(delta) + 0.0001;
      vec2 n = delta / len;
      disp += (n * uBallWarp.x + dir * uBallWarp.y + vec2(-n.y, n.x) * uBallWarp.z)
              * fall * amp;
    }

    // PINNED CELLS. Anything else on screen that has claimed a cell of this
    // lattice — the splash menu's buttons sit in three of them — needs those
    // cells to stay exactly where the maths put them, or the thing sitting in
    // the cell and the cell itself drift apart on the first ripple and the
    // button stops looking like part of the grid.
    //
    // Applied to the SUM rather than inside each loop, so one rule covers
    // ripples, wakes and fingers alike and nothing new can leak past it. The
    // test is against the REST position (pos.xy is untouched until the line
    // below), which is what makes the pin a property of the cell rather than of
    // wherever the wave happened to throw it.
    //
    // Two radii, not one: held solid out to z, then eased back to free by w. A
    // hard edge would tear every line that crosses it, which is a worse artifact
    // than the wobble it was fixing.
    float pin = 1.0;
    for (int i = 0; i < MAX_PINS; i++) {
      if (uPin[i].w <= 0.0) continue;
      pin = min(pin, smoothstep(uPin[i].z, uPin[i].w, length(pos.xy - uPin[i].xy)));
    }
    disp *= pin;

    pos.xy += disp;
    vWarp = length(disp);
    // Post-displacement, so the surface clip cuts where the line actually ends
    // up — a ripple that throws a node into the air gets clipped with it.
    // The mesh carries no transform but a z offset, so this is world space.
    vPos = pos.xy;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

// The wave constants are injected from arena.js rather than retyped, so the
// clip line here is the same curve world.js draws the surface with.
const fragmentShader = /* glsl */ `
  #define MAX_TOUCH ${MAX_TOUCH}
  #define MAX_BALL ${MAX_BALL}

  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform float uOpacity;
  uniform float uWarpGain;
  uniform float uSurfaceY;
  uniform float uWaveT;
  uniform float uWaveAmp;
  uniform float uChop;
  uniform float uClip;    // 0 = draw everywhere, 1 = water only
  uniform vec4 uTouch[MAX_TOUCH];      // xy = world pos, z = radius, w = level
  uniform vec3 uTouchColor[MAX_TOUCH]; // one hue per finger, by arrival order
  uniform vec2 uTouchGain;             // x = colour gain, y = extra opacity
  // THE BALL'S DENTS, again — the same slots the vertex shader bends the
  // lattice with, read here to LIGHT what was bent. See the note there.
  uniform vec4 uBall[MAX_BALL];
  uniform vec4 uBallDir[MAX_BALL];
  uniform vec2 uBallGain;              // x = colour gain, y = extra opacity
  // The same clock the vertex stage runs on — the possession drop's lobes roll
  // on it, and they have to roll at the rate they roll at inside the ball.
  uniform float uTime;
  uniform float uBallField;            // 0 = no ball, so the possession loop is skipped entirely
  // WHOSE BALL IT IS, as a field — systems/possessionGlsl.js, which is the same
  // function systems/post.js paints the ball's own body with. That is the whole
  // point of it being a module: a dent in the water is lit by the drop that is
  // in the ball at the moment the ball passed through, so a streak through the
  // hexes is recognisably THIS ball rather than a coloured smear that happens
  // to be nearby. See the header over there.
  ${POSSESSION_UNIFORMS_GLSL}
  // How much of this lattice is being drawn at all — view.fade, 1 in a run.
  // The finger light is ADDED to the line's colour rather than multiplied into
  // it, so it does not go out when uOpacity does: a lattice faded to nothing
  // still lit a glow blob under the cursor, which on the main menu meant the
  // arena's coarse grid answering the pointer over a screen composed on the
  // fine one — the exact two-grids-at-two-sizes read the crossfade exists to
  // remove. So the glow fades with the lattice it belongs to.
  uniform float uFade;

  varying float vWarp;
  varying vec2 vPos;

  // Mirrors surfaceHeightAt() in arena.js. Every constant is written with a
  // decimal point — GLSL ES has no int/float coercion, so a WAVE value that
  // happened to be a whole number would otherwise fail to compile.
  float surfaceAt(float x) {
    return uSurfaceY
      + sin(x * ${WAVE.k1.toFixed(4)} + uWaveT * ${WAVE.w1.toFixed(4)}) * uWaveAmp
      + sin(x * ${WAVE.k2.toFixed(4)} + uWaveT * ${WAVE.w2.toFixed(4)}) * uWaveAmp * ${WAVE.amp2.toFixed(4)}
      + sin(x * ${WAVE.k3.toFixed(4)} + uWaveT * ${WAVE.w3.toFixed(4)}) * uWaveAmp * ${WAVE.amp3.toFixed(4)} * uChop;
  }

  // THE SKIN THE DROP IS HELD BY, and out here there is not one. The goo pass
  // walks a lobe back inside the ball's own solved body, read out of the
  // density field it is already sampling; a dent in the water has no body to
  // be held by, so this is the bare clamp to the circle. The shared field calls
  // whichever of the two it was compiled beside.
  vec2 posHold(vec2 lp, float rim) {
    float len = length(lp);
    return len > rim ? lp * (rim / max(len, 1e-5)) : lp;
  }

  ${POSSESSION_FIELD_GLSL}

  void main() {
    // A narrow band rather than a hard cut: an additive hairline snapped off
    // mid-pixel crawls with the wave, and this costs nothing to avoid.
    const float FADE = 0.2;
    float surf = surfaceAt(vPos.x);
    float underwater = 1.0 - smoothstep(surf - FADE, surf, vPos.y);
    float mask = mix(1.0, underwater, uClip);
    if (mask <= 0.0) discard;

    float heat = clamp(vWarp * uWarpGain, 0.0, 1.0);
    vec3 color = mix(uColor, uHotColor, heat);
    float alpha = uOpacity * (0.3 + heat * 0.7) * mask;

    // Per-fragment rather than per-vertex: a span is only cut into as many
    // pieces as CONFIG.grid.subdivisions asks for, so a glow evaluated at the
    // nodes would step down the line in visible blocks instead of falling off
    // smoothly. Distances are measured against the DISPLACED position, so the
    // light stays on the line the finger just shoved out of place.
    //
    // Colours ADD — two fingers overlapping give you the blend of both, which
    // is what a light does — while the opacity takes the strongest of them
    // rather than summing, so a crowded corner of the screen brightens without
    // blowing out to a white blob.
    vec3 fingerLight = vec3(0.0);
    float fingerAmt = 0.0;
    for (int i = 0; i < MAX_TOUCH; i++) {
      float d = distance(vPos, uTouch[i].xy);
      float f = smoothstep(uTouch[i].z, 0.0, d);
      f *= f; // squared, so the falloff has a hot core instead of a flat disc
      float a = f * uTouch[i].w;
      fingerLight += uTouchColor[i] * a;
      fingerAmt = max(fingerAmt, a);
    }

    // ...AND THE BALL'S, IN THE COLOUR OF WHOEVER OWNS IT. Same construction as
    // the fingers above and for the same reasons — per-fragment so the light
    // falls off smoothly down a span rather than stepping at the nodes,
    // measured against the DISPLACED position so it stays on the line the ball
    // just shoved out of place, colours adding while the opacity takes the
    // strongest.
    //
    // The possession drop is sampled in EACH DENT'S OWN FRAME, so the two
    // colours turn over inside every echo the way they turn over inside the
    // ball — the trail is a row of little balls' worth of the same substance,
    // not a gradient somebody tinted. It is by far the most expensive thing in
    // this shader, which is why nothing reaches it until the dent has been
    // shown to cover this fragment at all.
    vec3 ballLight = vec3(0.0);
    float ballAmt = 0.0;
    // The whole loop is behind one uniform branch, so a frame with no ball on
    // the pitch — which is every frame outside Blubberball — never reaches the
    // possession field at all.
    if (uBallField > 0.0) for (int i = 0; i < MAX_BALL; i++) {
      float glow = uBallDir[i].z;
      if (glow <= 0.0) continue;
      vec2 d = (vPos - uBall[i].xy) / max(uBall[i].z, 1e-4);
      float f = smoothstep(1.0, 0.0, length(d));
      f *= f; // squared, so the falloff has a hot core instead of a flat disc
      float a = f * glow;
      if (a <= 0.002) continue;
      ballLight += mix(uTeamA, uTeamB, possessionMix(d, uTime)) * a;
      ballAmt = max(ballAmt, a);
    }

    gl_FragColor = vec4(
      color + (fingerLight * uTouchGain.x + ballLight * uBallGain.x) * uFade,
      clamp(alpha + (fingerAmt * uTouchGain.y + ballAmt * uBallGain.y) * mask * uFade, 0.0, 1.0)
    );
  }
`;

// Every line the grid draws goes through here, so both patterns get the same
// `subdivisions` treatment: a straight run is cut into pieces that the vertex
// shader can bend independently, otherwise a ripple only kinks the endpoints.
function pushRun(pts, x1, y1, x2, y2, sub) {
  for (let s = 0; s < sub; s++) {
    const t0 = s / sub;
    const t1 = (s + 1) / sub;
    pts.push(
      x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0, 0,
      x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, 0
    );
  }
}

// The lattice is generated across the WALLS but only up to the FRAME's top,
// never the arena ceiling. `clipAtSurface` throws away everything above the
// water line in the fragment shader, so lattice built up into the jump ceiling
// (arena.airScale) is vertices paid for and then discarded — at the shipped
// airScale 3 that is three times the air band, for nothing on screen. Width is
// different and is NOT trimmed: that is all underwater, and all drawn.
function gridRect() {
  return { left: bounds.left, right: bounds.right, top: bounds.frameTop, bottom: bounds.bottom };
}

function squarePoints(spacing, sub) {
  const pts = [];
  const { left, right, top, bottom } = gridRect();

  // Horizontal runs, subdivided so warped lines curve instead of kinking.
  for (let y = bottom; y <= top + 0.001; y += spacing) {
    for (let x = left; x < right - 0.001; x += spacing) {
      const span = Math.min(spacing, right - x);
      pushRun(pts, x, y, x + span, y, sub);
    }
  }
  // Vertical runs.
  for (let x = left; x <= right + 0.001; x += spacing) {
    for (let y = bottom; y < top - 0.001; y += spacing) {
      const span = Math.min(spacing, top - y);
      pushRun(pts, x, y, x, y + span, sub);
    }
  }
  return pts;
}

function hexPoints(spacing, sub) {
  const pts = [];
  const m = hexMetrics(spacing);

  // Neighbouring cells share an edge, so the same segment comes up twice as
  // the lattice is walked. Drawing it twice would double its brightness under
  // additive blending — a visible seam pattern — so edges are de-duplicated by
  // their (quantised) endpoints, orientation-independent.
  const seen = new Set();
  // hexCellsIn already overscans by a full cell on every side, which is enough
  // for a warped edge to stay off-screen — no extra margin needed here.
  for (const cell of hexCellsIn(gridRect(), m, 0)) {
    const corners = hexCorners(cell.x, cell.y, m.R);
    for (let k = 0; k < 6; k++) {
      const [x1, y1] = corners[k];
      const [x2, y2] = corners[(k + 1) % 6];
      const a = `${Math.round(x1 * 1e4)},${Math.round(y1 * 1e4)}`;
      const b = `${Math.round(x2 * 1e4)},${Math.round(y2 * 1e4)}`;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pushRun(pts, x1, y1, x2, y2, sub);
    }
  }
  return pts;
}

export function createGrid(scene) {
  let mesh = null;
  let material = null;
  let clock = 0;
  let cursor = 0;
  let waveT = 0; // pushed in by world.updateSurface; see setWaveTime

  const pins = new Array(MAX_PINS).fill(0).map(() => new THREE.Vector4(0, 0, 0, 0));
  const ripples = new Array(MAX_RIPPLES).fill(0).map(() => new THREE.Vector3());
  const rippleParams = new Array(MAX_RIPPLES).fill(0).map(() => new THREE.Vector2());

  // One entry per finger slot. `w` is the eased level — it rises while a finger
  // is down and falls back after it lifts, so nothing pops on or off.
  const touch = new Array(MAX_TOUCH).fill(0).map(() => new THREE.Vector4(0, 0, 1, 0));
  const touchColor = new Array(MAX_TOUCH).fill(0).map(() => new THREE.Color(0xffffff));
  const touchWarp = new THREE.Vector4(0, 0, 1, 0);
  const touchGain = new THREE.Vector2(0, 0);
  // Which finger each slot is currently showing. A slot freed and immediately
  // re-taken by another finger has to restart rather than slide its glow across
  // the screen from wherever the last one was.
  const touchOwner = new Array(MAX_TOUCH).fill(null);
  const touchPoint = new THREE.Vector3();

  // THE BALL'S DENTS, as uniforms. Republished wholesale every frame by
  // systems/ballGrid.js — see `ballWarp` below.
  const ballSlots = new Array(MAX_BALL).fill(0).map(() => new THREE.Vector4(0, 0, 1, 0));
  const ballDirs = new Array(MAX_BALL).fill(0).map(() => new THREE.Vector4(1, 0, 0, 0));
  const ballShape = new THREE.Vector4(0, 0, 0, 1);
  const ballGain = new THREE.Vector2(0, 0);
  // The possession field, in the shape possessionGlsl.js declares. Colours are
  // THREE.Color and the rest are plain uniform values, set in place.
  const teamA = new THREE.Color(0xffffff);
  const teamB = new THREE.Color(0xffffff);
  const ballDrift = new THREE.Vector2(0, 0);
  const field = { share: 0, seed: 0, lobes: 5, lobeSize: 0.62, wobble: 0.7, spin: 0.5, breathe: 0.25, on: 0 };
  // Seconds until this finger's next charge pulse. Counted down per slot rather
  // than off one global clock so two fingers charging at once don't pulse in
  // lockstep, which reads as one big event instead of two.
  const touchPulseAt = new Float32Array(MAX_TOUCH);

  function build() {
    dispose();
    if (!CONFIG.grid.enabled) return;

    const spacing = Math.max(0.5, CONFIG.grid.spacing);
    const sub = Math.max(1, Math.floor(CONFIG.grid.subdivisions));
    const pts = CONFIG.grid.pattern === 'hex'
      ? hexPoints(spacing, sub)
      : squarePoints(spacing, sub);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));

    material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uRipples: { value: ripples },
        uRippleParams: { value: rippleParams },
        uWake: { value: wakes },
        uPin: { value: pins },
        uTouch: { value: touch },
        uTouchColor: { value: touchColor },
        uTouchWarp: { value: touchWarp },
        uTouchGain: { value: touchGain },
        uBall: { value: ballSlots },
        uBallDir: { value: ballDirs },
        uBallWarp: { value: ballShape },
        uBallGain: { value: ballGain },
        uBallField: { value: 0 },
        uTeamA: { value: teamA },
        uTeamB: { value: teamB },
        uShare: { value: 0 },
        uSeed: { value: 0 },
        uLobes: { value: 5 },
        uLobeSize: { value: 0.62 },
        uWobble: { value: 0.7 },
        uSpin: { value: 0.5 },
        uBreathe: { value: 0.25 },
        uDrift: { value: ballDrift },
        uDecay: { value: CONFIG.grid.rippleDecay },
        uFreq: { value: CONFIG.grid.rippleFreq },
        uWavelength: { value: CONFIG.grid.rippleWavelength },
        uColor: { value: new THREE.Color(CONFIG.grid.color) },
        uHotColor: { value: new THREE.Color(CONFIG.grid.hotColor) },
        uOpacity: { value: CONFIG.grid.opacity },
        uFade: { value: 1 },
        uWarpGain: { value: CONFIG.grid.warpGain },
        uSurfaceY: { value: bounds.surfaceY },
        uWaveT: { value: waveT },
        uWaveAmp: { value: CONFIG.arena.waveAmplitude },
        uChop: { value: 0 },
        uClip: { value: CONFIG.grid.clipAtSurface ? 1 : 0 },
      },
    });

    mesh = new THREE.LineSegments(geometry, material);
    mesh.position.z = -4.5;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  function dispose() {
    if (!mesh) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
    retireMaterial(mesh.material);
    mesh = null;
    material = null;
  }

  // The surface owns the wave clock; the grid only borrows it to know where to
  // cut. Kept off update() so the grid never has to be told twice per frame.
  function setWaveTime(t) {
    waveT = t;
    if (material) material.uniforms.uWaveT.value = t;
  }

  /**
   * HOLD THESE CELLS STILL. `list` is [{ x, y, radius, feather }] in world
   * units — everything within `radius` of one of those points does not move at
   * all, and the lattice eases back to its normal behaviour by `feather`.
   *
   * For whatever is sitting IN the lattice rather than on top of it: the splash
   * menu's buttons are three cells of it (systems/hexMenu.js), and a button
   * whose cell ripples out from under it stops reading as part of the grid.
   *
   * Republished wholesale rather than added to, like the hulls: the caller owns
   * the list, and a pin that has to be un-registered is a pin that gets left
   * behind when whatever claimed it is gone.
   */
  function pin(list = []) {
    for (let i = 0; i < MAX_PINS; i++) {
      const p = list[i];
      if (!p) { pins[i].set(0, 0, 0, 0); continue; }
      const r = Math.max(0, p.radius ?? 0);
      pins[i].set(p.x, p.y, r, Math.max(r + 1e-3, p.feather ?? r * 2));
    }
  }

  /**
   * THE BALL, AND THE WATER IT HAS BEEN THROUGH. Blubberball's, published every
   * frame by systems/ballGrid.js — `spec` is
   *
   *   { dents: [{ x, y, radius, amp, dirX, dirY, glow }], warp: { radial, drive,
   *     swirl, stretch }, gain: { color, alpha }, field: <possession> }
   *
   * and null (or a spec with no dents) is a pitch with no ball on it.
   *
   * REPUBLISHED WHOLESALE rather than fired and forgotten, which is the pin's
   * contract and not the ripple's. The two are different KINDS of thing: a
   * ripple is an event that expands and dies on the shader's own clock, while a
   * dent is a thing that exists as long as somebody keeps saying it does. A
   * ball that goes in, a match that ends, a replay that cuts — all of them stop
   * the publishing, and the failure mode of a fire-and-forget channel is a
   * streak of somebody's colour left across the backdrop of the next kickoff.
   *
   * `amp` is SIGNED and already carries the spring; `glow` is the same envelope
   * without the oscillation. Both are solved on the CPU where they can be
   * tested, and neither has a clock in here to drift against.
   *
   * The possession `field` is the object systems/ballLook.js hands the goo pass
   * (ballTeams()), so the dents are lit by the same drop that is in the ball.
   */
  function ballWarp(spec) {
    const dents = spec?.dents ?? null;
    const live = !!(dents && dents.length && spec.field);
    for (let i = 0; i < MAX_BALL; i++) {
      const d = live ? dents[i] : null;
      if (!d) { ballSlots[i].set(0, 0, 1, 0); ballDirs[i].set(1, 0, 0, 0); continue; }
      ballSlots[i].set(d.x, d.y, Math.max(0.001, d.radius ?? 1), d.amp ?? 0);
      ballDirs[i].set(d.dirX ?? 1, d.dirY ?? 0, Math.max(0, d.glow ?? 0), 0);
    }
    if (!material) return;
    const u = material.uniforms;
    u.uBallField.value = live ? 1 : 0;
    if (!live) { field.on = 0; return; }
    const w = spec.warp ?? {};
    ballShape.set(w.radial ?? 0, w.drive ?? 0, w.swirl ?? 0, Math.max(0.01, w.stretch ?? 1));
    ballGain.set(spec.gain?.color ?? 0, spec.gain?.alpha ?? 0);
    const f = spec.field;
    teamA.set(f.a ?? 0xffffff);
    teamB.set(f.b ?? 0xffffff);
    u.uShare.value = Math.min(1, Math.max(0, f.share ?? 0));
    u.uSeed.value = f.seed ?? 0;
    u.uLobes.value = Math.max(0, Math.min(7, f.lobes ?? 5));
    u.uLobeSize.value = Math.max(0, f.lobeSize ?? 0.62);
    u.uWobble.value = Math.max(0, f.wobble ?? 0.7);
    u.uSpin.value = f.spin ?? 0.5;
    u.uBreathe.value = Math.max(0, f.breathe ?? 0.25);
    ballDrift.set(f.driftX ?? 0, f.driftY ?? 0);
    // Kept for the harness, which cannot read a uniform off a material it never
    // built — see tools/ball-grid-test.mjs.
    field.share = u.uShare.value;
    field.seed = u.uSeed.value;
    field.lobes = u.uLobes.value;
    field.lobeSize = u.uLobeSize.value;
    field.wobble = u.uWobble.value;
    field.spin = u.uSpin.value;
    field.breathe = u.uBreathe.value;
    field.on = 1;
  }

  /** What the ball channel currently holds — for the harness and the labs. */
  function ballState() {
    return {
      dents: ballSlots.map((v, i) => ({
        x: v.x, y: v.y, radius: v.z, amp: v.w,
        dirX: ballDirs[i].x, dirY: ballDirs[i].y, glow: ballDirs[i].z,
      })),
      warp: { radial: ballShape.x, drive: ballShape.y, swirl: ballShape.z, stretch: ballShape.w },
      gain: { color: ballGain.x, alpha: ballGain.y },
      field: { ...field, a: teamA.getHex(), b: teamB.getHex(), driftX: ballDrift.x, driftY: ballDrift.y },
      on: material ? material.uniforms.uBallField.value : 0,
    };
  }

  // Punch the grid. Called by the feedback system for every juicy event.
  function ripple(x, y, strength, radius) {
    if (!material || !strength) return;
    const slot = cursor % MAX_RIPPLES;
    cursor += 1;
    ripples[slot].set(x, y, clock);
    rippleParams[slot].set(strength, Math.max(0.1, radius));
  }

  // The fingers, resolved from screen space into the water every frame. It has
  // to be every frame, not just when a finger moves: the camera follows the
  // player, so a thumb held perfectly still is over a different piece of ocean
  // each frame, and a world position cached at touchdown would slide out from
  // under it. Slots keep their last NDC after the lift, so the fade-out stays
  // put on screen where the finger was.
  //
  // `view.charging` / `view.charge` are the strike meter, handed in by main.js
  // rather than imported. systems/strike.js pulls the whole enemy graph in
  // behind it, and the backdrop wants two numbers, not a dependency on combat.
  function updateTouch(dt, view) {
    const camera = view.camera;
    const cfg = CONFIG.grid.touchGlow ?? {};
    const fingers = cfg.fingers ?? [];
    const on = cfg.enabled !== false && !!camera;

    touchWarp.set(cfg.push ?? 0, cfg.swirl ?? 0, cfg.wave ?? 1, cfg.spin ?? 0);
    touchGain.set(cfg.gain ?? 0, cfg.alpha ?? 0);

    const knock = cfg.ripple ?? {};
    const chg = cfg.charge ?? {};

    for (let i = 0; i < MAX_TOUCH; i++) {
      const slot = touchSlots[i];
      const live = on && slot.id !== null;
      // Falls back to the last entry rather than going dark, so shortening the
      // palette in the tuner doesn't silently disable the outer fingers.
      const finger = fingers[i] ?? fingers[fingers.length - 1] ?? {};
      const u = touch[i];

      const landed = live && slot.id !== touchOwner[i];
      const lifted = !live && touchOwner[i] !== null;
      if (landed) {
        // A brand-new finger in this slot: start from nothing, wherever it
        // landed, instead of inheriting the last one's level and position.
        u.w = 0;
        touchOwner[i] = slot.id;
        touchPulseAt[i] = 0;
      }
      if (!live) touchOwner[i] = null;

      // How far into a wind-up this finger is, 0..1. Only the finger actually
      // doing it grows — the strike meter is ONE meter shared by every route
      // into it (a held trigger charges the same one), so without the per-slot
      // flag a thumb resting on the glass would swell along with it.
      const winding = live && slot.charging && !!view.charging;
      const wind = winding ? Math.min(1, Math.max(0, view.charge ?? 0)) : 0;

      // Skip the unproject once a released slot has faded out — there's nothing
      // left to place, and this is the state every slot is in most of the time.
      if (live || u.w > 0.001) {
        touchPoint.set(slot.x, slot.y, 0).unproject(camera);
        u.x = touchPoint.x;
        u.y = touchPoint.y;
        u.z = Math.max(0.001,
          (cfg.radius ?? 6) * (finger.spread ?? 1) * (1 + (chg.grow ?? 0) * wind));
      }

      // Both knocks are fired AFTER the position above is resolved, or the
      // first one of a touch would land at wherever the slot pointed last.
      if (landed) ripple(u.x, u.y, knock.strength ?? 0, knock.radius ?? 1);
      if (lifted) {
        ripple(u.x, u.y, (knock.strength ?? 0) * (knock.liftScale ?? 0), knock.radius ?? 1);
      }

      // The wind-up's own beat. Timed rather than fired on a fraction of the
      // meter so it keeps pulsing on an empty tank — the player is still
      // holding, the strike is still coming, and a backdrop that went quiet
      // exactly when the fuel ran out would read as the input being dropped.
      if (winding) {
        touchPulseAt[i] -= dt;
        if (touchPulseAt[i] <= 0) {
          ripple(u.x, u.y, (chg.pulseStrength ?? 0) * (0.35 + 0.65 * wind),
            (chg.pulseRadius ?? 1) * (0.55 + 0.45 * wind));
          const gap = (chg.pulseAt ?? 0.5) + ((chg.pulseAtFull ?? 0.15) - (chg.pulseAt ?? 0.5)) * wind;
          touchPulseAt[i] = Math.max(0.02, gap);
        }
      } else {
        touchPulseAt[i] = 0; // so the next wind-up pulses immediately
      }

      // Exponential, so it's framerate-independent — the same feel at 60 and at
      // 120. Attack is the faster of the two: a finger landing should be
      // instant, a finger lifting should trail.
      const target = live ? (finger.power ?? 1) * (1 + (chg.power ?? 0) * wind) : 0;
      const rate = live ? (cfg.attack ?? 16) : (cfg.release ?? 5);
      u.w += (target - u.w) * (1 - Math.exp(-Math.max(0, rate) * dt));
      if (!live && u.w < 0.001) u.w = 0;

      touchColor[i].set(finger.color ?? 0xffffff);
    }
  }

  function update(dt, shipPos, shipVel, view = {}) {
    clock += dt;
    if (!material) return;
    material.uniforms.uTime.value = clock;
    material.uniforms.uDecay.value = CONFIG.grid.rippleDecay;
    material.uniforms.uFreq.value = CONFIG.grid.rippleFreq;
    material.uniforms.uWavelength.value = CONFIG.grid.rippleWavelength;
    // `view.fade` is a multiplier on the authored opacity for whoever is
    // holding the frame — 1 in a run. The main menu draws a lattice of its own,
    // six times finer than this one, and two hex grids at two sizes on top of
    // each other read as a fault; so this one is held down while that screen is
    // up and brought back as the shot opens out. See mainMenuGrid.
    const fade = view.fade ?? 1;
    material.uniforms.uOpacity.value = CONFIG.grid.opacity * fade;
    material.uniforms.uFade.value = fade;
    material.uniforms.uWarpGain.value = CONFIG.grid.warpGain;
    material.uniforms.uSurfaceY.value = bounds.surfaceY;
    // The live sea state — see the same note in water.js. The grid clips to
    // the water line too, so it has to be cut on the same curve.
    material.uniforms.uWaveAmp.value = sea.amp;
    material.uniforms.uChop.value = sea.chop;
    material.uniforms.uClip.value = CONFIG.grid.clipAtSurface ? 1 : 0;

    const speed = shipVel ? Math.hypot(shipVel.x, shipVel.y) : 0;
    // THE SEAL'S OWN DENT, and `view.wake` is an absolute override of
    // CONFIG.grid.wakeStrength for whoever is holding the frame.
    //
    // It exists for the main menu. In a run the wake is a gameplay read — the
    // lattice bulges around the player so you can find yourself in a crowded
    // frame — and it is tuned against a fifty-unit view, where a 7-unit radius
    // is a local dimple. The menu holds the same water at fifteen times that
    // zoom (systems/mainMenu.js): the radius is then wider than the whole
    // picture, every node on screen is pulled toward one point, and the lattice
    // reads as a cobweb rather than as a grid. See CONFIG.splashBust.menu
    // .sealWake, which is the value handed in here.
    //
    // `??`, so a handed-in 0 is honoured — that is the shipped menu value.
    const wakeStrength = view.wake ?? CONFIG.grid.wakeStrength;
    wakes[0].set(
      shipPos.x,
      shipPos.y,
      CONFIG.grid.wakeRadius,
      wakeStrength * (1 + speed * CONFIG.grid.wakeSpeedGain)
    );
    // THE HULLS. Re-published every frame by whoever owns them rather than
    // registered once: a boat is destroyed mid-frame more often than not, and a
    // registry would leave its dent in the water behind it. Anything that did
    // not claim a slot this frame is cleared here, so a source can only ever
    // persist by asserting itself.
    for (let i = 1; i < MAX_WAKES; i++) {
      if (wakeClaims[i]) wakeClaims[i] = false;
      else wakes[i].w = 0;
    }
    wakeCursor = SEAL_WAKES;
    sealCursor = 1;

    updateTouch(dt, view);
  }

  /**
   * A HULL DISPLACING WATER. Published every frame by whoever owns the boat —
   * systems/boats.js for the ones sailing past, systems/bossBoat.js for the
   * boss — and dropped automatically by the sweep in update() the first frame
   * nobody re-asserts it. That is deliberate rather than a registry with an
   * unregister: hulls are destroyed mid-frame constantly, and the failure mode
   * of a registry is a permanent dent in the water where a boat used to be.
   *
   * Past MAX_WAKES the extra hulls simply do not warp the field. They still
   * bubble (systems/boatWake.js is unbounded) — this is the decoration, and
   * dropping the sixth boat's share of it costs nothing anybody can see.
   *
   * @param strength signed, and NEGATIVE pulls the lattice inward toward the
   *        hull — the same convention CONFIG.grid.wakeStrength uses for the
   *        seal, and the reason a boat reads as sitting IN the water rather
   *        than as a bubble pushing it away.
   */
  function hullWake(x, y, radius, strength) {
    if (wakeCursor >= MAX_WAKES || !(radius > 0)) return;
    const i = wakeCursor++;
    wakes[i].set(x, y, radius, strength);
    wakeClaims[i] = true;
  }

  /**
   * ANOTHER PLAYER DISPLACING WATER. Same contract as hullWake and dropped by
   * the same sweep — published every frame by whoever owns the body, so a seal
   * that bursts cannot leave a dent behind it until it respawns. Player 1 is
   * not one of these: it is slot 0, handed to update() as the seal the frame
   * belongs to.
   *
   * WHY IT HAS ITS OWN BAND. It is the same displacement a hull makes, and it
   * competes with hulls for a fixed per-vertex loop — so if they shared a queue
   * a busy shipping lane would silently switch the other players' dents off.
   * Past the band the extra seals simply do not warp the field; publish the
   * ones FURTHEST from player 1 first, since a seal swimming inside the
   * player's own radius is already inside the player's own dent.
   */
  function sealWake(x, y, radius, strength) {
    if (sealCursor >= SEAL_WAKES || !(radius > 0)) return;
    const i = sealCursor++;
    wakes[i].set(x, y, radius, strength);
    wakeClaims[i] = true;
  }

  function reset() {
    for (let i = 1; i < MAX_WAKES; i++) {
      wakes[i].set(0, 0, 1, 0);
      wakeClaims[i] = false;
    }
    wakeCursor = SEAL_WAKES;
    sealCursor = 1;
    for (let i = 0; i < MAX_RIPPLES; i++) rippleParams[i].set(0, 1);
    cursor = 0;
    for (let i = 0; i < MAX_TOUCH; i++) {
      touch[i].set(0, 0, 1, 0);
      touchOwner[i] = null;
      touchPulseAt[i] = 0;
    }
    // The ball's dents go with it. They are republished every frame anyway,
    // but a reset is exactly the moment nobody is publishing.
    ballWarp(null);
  }

  build();
  reset();

  return { build, dispose, ripple, hullWake, sealWake, pin, ballWarp, ballState, update, reset, setWaveTime };
}
