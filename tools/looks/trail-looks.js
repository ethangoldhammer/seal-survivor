// ---------------------------------------------------------------------------
// BREACH TRAIL — LOOK DEV
//
// Renders the REAL systems/breachTrail.js six times over, once per parameter
// set, on one identical scripted arc, and lays the results out as a contact
// sheet. It imports the shipped module rather than reimplementing it, so what
// is on screen is what the game draws — the only thing this page adds is a
// small bloom, because the trail is designed around blowing past the bright
// pass and judging it unbloomed would be judging a different effect.
//
// It is a STATIC BUNDLE served by a plain file server on purpose. The game's
// dev server writes path/src/imported-tuning.json, which is real tuning work;
// nothing here talks to a server at all.
//
// The cloud is fully deterministic (every per-particle value comes from a
// coherent wave in the emission counter, not from Math.random), so the
// differences between these panels are the parameters and nothing else.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { updateBreachTrail, clearBreachTrail, breachTrailCount } from '../../path/src/systems/breachTrail.js';
import { initParticles, updateParticles, resetParticles, updateParticleScale } from '../../path/src/entities/particles.js';

const W = 380;
const H = 260;
const DT = 1 / 60;

updateBounds(16 / 9);

// A stand-in for the player: the trail only ever reads these three things.
// THE FINS, as systems/aimRig.js publishes them: two world-space points just
// past the trailing edge of each hind flipper. The trail comes off THESE, not
// off the body origin, so the sheet has to carry them or it would be previewing
// a single plume out of the seal's ribcage — the thing this change removed.
const finL = new THREE.Vector3();
const finR = new THREE.Vector3();
const seal = {
  mesh: { position: new THREE.Vector3() },
  velocity: new THREE.Vector2(),
  aboveSurface: true,
  aimRig: { anchors: { finL, finR } },
};

// Where the flippers sit relative to the body: trailing it, one either side of
// its line of travel, so the two plumes start apart and stay apart.
function placeFins(x, y, dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  const tx = dx / len;
  const ty = dy / len;
  const nx = -ty;
  const ny = tx;
  const back = 1.15;
  const half = 0.5;
  finL.set(x - tx * back + nx * half, y - ty * back + ny * half, 0);
  finR.set(x - tx * back - nx * half, y - ty * back - ny * half, 0);
}

// THE ARC, shared by every panel. A breach that launches, arcs over, gets a
// mid-air relaunch a third of the way through, and comes down — with a little
// lateral weave so the RGB split has curvature to fringe on.
const FRAMES = 132;
function poseAt(i) {
  const t = i / FRAMES;
  const x = -17 + t * 34;
  // Two ballistic hops joined at the relaunch, so the curve has one real corner
  // in it. A trail that only ever sees gentle curves is not being tested.
  const s = t < 0.38 ? t / 0.38 : (t - 0.38) / 0.62;
  const hop = t < 0.38 ? 7.5 : 11.5;
  const y = bounds.surfaceY + 3 + hop * (4 * s * (1 - s)) + Math.sin(t * 9) * 0.55;
  return [x, y];
}

// THE BASE, declared IN FULL rather than read from CONFIG.
//
// CONFIG.breachTrail has the user's saved tuning merged over it (a saved value
// beats a config.js default), so a sheet that inherited the unspecified keys
// would be showing a mixture of these presets and whatever was last dragged in
// the tuner — and the panels would quietly stop matching their own captions.
// Everything that matters is spelled out here.
const NEON = {
  enabled: true,
  samples: 220,
  emitPerSecond: 95,
  life: 1.5,
  lifeVary: 0.35,
  maxNodes: 260,
  width: 0.72,
  growth: 2.1,
  fade: 1.25,
  glow: 2.6,
  z: -0.06,
  coreWidth: 0.07,
  coreGain: 1.25,
  haloGain: 0.9,
  softness: 1.5,
  channelTrail: 0.50,
  channelSpread: 0.46,
  colors: [0xff0000, 0x00ff00, 0x0000ff],
  turbulence: 5.0,
  turbFreq: 0.42,
  turbSpeed: 0.85,
  blowOut: 2.6,
  blowWave: 0.12,
  inherit: 0.18,
  drag: 1.5,
  foldSafety: 0.85,
  curveSmooth: 3,
  minIntensity: 0.35,
  headTaper: 0.05,
  tailTaper: 0.14,
  sealTaperMul: 5,
  erase: { enabled: true, time: 0.5, from: 'tail', burst: 'trailBurn', burstPerSecond: 26, burstScale: 0.85 },
};

// --- dialling in --------------------------------------------------------------
// SPLIT STRENGTH, ON ITS OWN AXIS. Everything else is held identical; the only
// thing moving from panel to panel is how far the three channels are pushed
// apart.
//
// The number that matters is the offset between ADJACENT channels measured
// against the band's RADIUS, which is half its width. The two authored knobs
// are perpendicular (one along the curve, one across it), so the offset is
// their hypotenuse — and the shipped pair is kept in ratio and simply scaled,
// so this really is one axis rather than two.
//
//   under ~0.25   the three halos sit on top of each other and sum to a neutral
//                 core with coloured fringes. This is an RGB SPLIT.
//   0.25 - 0.5    transitional; the white centre thins out.
//   over ~0.5     the halos have no overlap left at all and each channel draws
//                 alone. This is a SPECTRUM — red/orange/yellow/green/cyan/blue
//                 in bands, no white anywhere. It is what shipped by mistake.
const RATIO_T = 0.50; // the shipped pair, kept in proportion
const RATIO_S = 0.46;
const RATIO_H = Math.hypot(RATIO_T, RATIO_S);

function splitAt(target) {
  const k = target / RATIO_H;
  return { channelTrail: +(RATIO_T * k).toFixed(3), channelSpread: +(RATIO_S * k).toFixed(3) };
}

function zoneOf(h) {
  if (h < 0.25) return 'split — halos overlap, neutral core';
  if (h < 0.5) return 'transitional — core thinning';
  return 'SPECTRUM — no overlap, no white core';
}

const LOOKS = [0.08, 0.16, 0.24, 0.36, 0.50, 0.68].map((h) => ({
  name: `${h.toFixed(2)} of a band width`,
  why: zoneOf(h),
  h,
  p: splitAt(h),
}));

// --- renderer + a small bloom ------------------------------------------------
// Same shape as systems/post.js: HDR scene target, bright pass, separable blur,
// additive composite. Values above the threshold survive because the target is
// HalfFloat — on an 8-bit target a glow of 3.0 and 1.0 would be identical and
// none of this would mean anything.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setClearColor(0x05070d, 1);

const scene = new THREE.Scene();
// TIGHT. The previous sheets framed the whole arc, at which scale the band is a
// couple of pixels across and a fringe is literally unresolvable — every panel
// looked the same and the differences being judged were invisible. This crops
// to a stretch of the trail near the apex, where the curvature is doing
// something, so the cross-section is big enough to read.
const VIEW = 6.5;
const FOCUS_X = 4;
const FOCUS_Y = bounds.surfaceY + 12.2;
const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW * H / W, -VIEW * H / W, -100, 100);
camera.position.set(FOCUS_X, FOCUS_Y, 10);
camera.lookAt(FOCUS_X, FOCUS_Y, 0);

// The spark bursts the erase throws are REAL particles, out of the game's own
// one-draw-call system — so the sheet has to stand that system up, or the wipe
// would be previewed with its loudest half missing.
initParticles(scene);

const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
const sceneRT = new THREE.WebGLRenderTarget(W, H, rtOpts);
const rtA = new THREE.WebGLRenderTarget(W >> 1, H >> 1, rtOpts);
const rtB = new THREE.WebGLRenderTarget(W >> 1, H >> 1, rtOpts);

// Points are sized in PIXELS, so the world-to-pixel ratio has to be handed to
// the particle shader or every spark is drawn at whatever scale the last camera
// implied. Missing this made the bursts render as fist-sized white blobs — a
// preview artefact that looked exactly like the emitter being far too big.
updateParticleScale(camera, renderer);

const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadScene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadMesh = new THREE.Mesh(quadGeo, null);
quadScene.add(quadMesh);

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const bright = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.5 } },
  vertexShader: VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uThreshold; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0); }`,
});
const blur = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
  vertexShader: VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uDir; varying vec2 vUv;
    void main(){ vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;
      s += texture2D(tDiffuse, vUv + uDir * 1.3846).rgb * 0.316216;
      s += texture2D(tDiffuse, vUv - uDir * 1.3846).rgb * 0.316216;
      s += texture2D(tDiffuse, vUv + uDir * 3.2308).rgb * 0.070270;
      s += texture2D(tDiffuse, vUv - uDir * 3.2308).rgb * 0.070270;
      gl_FragColor = vec4(s, 1.0); }`,
});
const comp = new THREE.ShaderMaterial({
  uniforms: { tScene: { value: null }, tGlow: { value: null }, uIntensity: { value: 1.15 } },
  vertexShader: VERT,
  fragmentShader: `uniform sampler2D tScene; uniform sampler2D tGlow; uniform float uIntensity;
    varying vec2 vUv;
    void main(){ vec3 c = texture2D(tScene, vUv).rgb + texture2D(tGlow, vUv).rgb * uIntensity;
      // Reinhard-ish shoulder so a 5.0 core reads as white-hot rather than
      // clipping to a flat slab — the same job CONFIG.bloom.knee does in game.
      c = c / (1.0 + c * 0.55);
      gl_FragColor = vec4(pow(c, vec3(1.0 / 1.9)), 1.0); }`,
});

function pass(material, target) {
  quadMesh.material = material;
  renderer.setRenderTarget(target);
  renderer.render(quadScene, quadCam);
  renderer.setRenderTarget(null);
}

function renderWithBloom() {
  renderer.setRenderTarget(sceneRT);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  bright.uniforms.tDiffuse.value = sceneRT.texture;
  pass(bright, rtA);
  for (let i = 0; i < 3; i++) {
    blur.uniforms.tDiffuse.value = rtA.texture;
    blur.uniforms.uDir.value.set(1 / (W >> 1), 0);
    pass(blur, rtB);
    blur.uniforms.tDiffuse.value = rtB.texture;
    blur.uniforms.uDir.value.set(0, 1 / (H >> 1));
    pass(blur, rtA);
  }
  comp.uniforms.tScene.value = sceneRT.texture;
  comp.uniforms.tGlow.value = rtA.texture;
  quadMesh.material = comp;
  renderer.render(quadScene, quadCam);
}

// --- run one look -------------------------------------------------------------
// Flown to a point PART WAY THROUGH the arc and stopped there, with the seal
// still in the air: this sheet is about the trail itself, not about how it ends,
// so nothing here is sealed or erased.
function runLook(look) {
  Object.assign(CONFIG.breachTrail, NEON, look.p);
  clearBreachTrail(scene);
  resetParticles();

  seal.aboveSurface = true;
  let [px, py] = poseAt(0);
  seal.mesh.position.set(px, py, 0);
  placeFins(px, py, 1, 0);
  updateBreachTrail(DT, scene, seal, 0, true);

  for (let i = 1; i <= FRAMES; i++) {
    const [nx, ny] = poseAt(i);
    const dx = nx - px;
    const dy = ny - py;
    seal.velocity.set(dx / DT, dy / DT);
    seal.mesh.position.set(nx, ny, 0);
    placeFins(nx, ny, dx, dy);
    px = nx;
    py = ny;
    // The ramp climbs through the arc exactly as air time does in game, so the
    // brightness gradient along the trail is the real one.
    updateBreachTrail(DT, scene, seal, Math.min(1.4, i / 55), true);
    updateParticles(DT);
  }

  renderWithBloom();
  return breachTrailCount();
}

// --- contact sheet -----------------------------------------------------------
// Composited into ONE canvas rather than a CSS grid of <img>: a tall page only
// screenshots a couple of panels at a time, and the whole point of a look sheet
// is seeing them beside each other.
const COLS = 3;
const ROWS = Math.ceil(LOOKS.length / COLS);
const PAD = 8;
const CAPH = 54;
const sheet = document.createElement('canvas');
sheet.width = COLS * W + PAD * (COLS + 1);
sheet.height = ROWS * (H + CAPH) + PAD * (ROWS + 1);
const g2 = sheet.getContext('2d');
g2.fillStyle = '#05070d';
g2.fillRect(0, 0, sheet.width, sheet.height);

LOOKS.forEach((look, i) => {
  runLook(look);
  const cx = PAD + (i % COLS) * (W + PAD);
  const cy = PAD + Math.floor(i / COLS) * (H + CAPH + PAD);
  g2.drawImage(renderer.domElement, cx, cy, W, H);
  g2.strokeStyle = '#1b2b45';
  g2.strokeRect(cx + 0.5, cy + 0.5, W - 1, H - 1);

  g2.fillStyle = '#ffffff';
  g2.font = '600 15px ui-monospace, Menlo, monospace';
  g2.fillText(look.name, cx, cy + H + 19);
  // The zone, coloured by which side of the line it falls on — the whole point
  // of the sheet is where that line actually is by eye.
  g2.fillStyle = look.h < 0.25 ? '#7dff9e' : look.h < 0.5 ? '#ffd166' : '#ff6b8a';
  g2.font = '12px ui-monospace, Menlo, monospace';
  g2.fillText(look.why, cx, cy + H + 36);
  g2.fillStyle = '#6fd3ff';
  g2.font = '11px ui-monospace, Menlo, monospace';
  g2.fillText(`channelTrail ${look.p.channelTrail}   channelSpread ${look.p.channelSpread}`, cx, cy + H + 51);
});

const grid = document.getElementById('grid');
grid.style.display = 'block';
grid.appendChild(sheet);
sheet.style.width = '100%';
sheet.style.height = 'auto';
document.getElementById('sub').textContent =
  '— split strength only; everything else held identical. Cropped tight to the apex so the cross-section is readable. Green = neutral core survives, red = spectrum.';
