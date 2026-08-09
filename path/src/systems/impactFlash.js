import * as THREE from 'three';

// A short, bright bloom of light at a point — the "something just detonated
// here" flash that particles alone can't give you. A burst of points reads as
// debris; what sells a detonation is the instant where the whole area goes
// white before the debris is even visible, and that has to be a solid piece of
// light with real area.
//
// Each flash is one additive quad with a radial falloff, scaled up on an
// ease-out curve and faded on a fast curve, so it snaps out to full size in
// the first couple of frames and is gone inside a fifth of a second. The core
// starts white and settles into the flash's own colour as it dies, which is
// how a hot thing cooling actually looks — and here it's what lets the flash
// be tinted per-hit (a mussel takes the colour of whatever it hit) while
// still landing as a white-hot impact rather than a coloured blob.
//
// Meshes are pooled and reused. These fire in bursts — a volley of five
// mussels landing on a school is five in one frame — and building a mesh and
// a material per detonation would churn exactly when the frame is already
// busy.

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFade;   // 0..1 overall brightness, falls fast
  uniform float uCore;   // 0..1 how white-hot the middle still is
  uniform float uRing;   // 0..1 radius of the expanding shock edge
  uniform float uGlow;   // overdrive, pushed past 1 for the HDR bright-pass
  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float d = length(p);
    if (d > 1.0) discard;

    // Soft body: bright at the middle, gone at the rim.
    float body = pow(max(0.0, 1.0 - d), 2.2);
    // A thin shell riding the leading edge, which is what makes the flash
    // read as expanding rather than merely shrinking in brightness.
    // Squared by multiplication, NOT pow(x, 2.0) — (d - uRing) is negative
    // everywhere inside the ring, and pow() with a negative base is undefined
    // in GLSL. It happens to work on plenty of drivers and returns NaN on
    // others, which would punch a black hole through the middle of every
    // explosion on exactly the hardware nobody tests on.
    float edge = (d - uRing) / 0.16;
    float ring = exp(-(edge * edge)) * uRing;

    float a = (body + ring * 0.7) * uFade;
    // White at the centre while it's hot, the hit creature's colour as it
    // cools — so the tint is unmistakable without the flash losing its punch.
    vec3 col = mix(uColor, vec3(1.0), uCore * body);
    gl_FragColor = vec4(col * uGlow * a, a);
  }
`;

const POOL = 16;
const pool = [];
let group = null;

function makeFlash() {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // Same reasoning as the particle system: these are light, not geometry.
    // Depth-testing them against the creature that's currently exploding just
    // clips the flash in half along the body it's centred on.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uFade: { value: 0 },
      uCore: { value: 0 },
      uRing: { value: 0 },
      uGlow: { value: 2 },
    },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  // Under the particles (renderOrder 10) so the debris reads on top of the
  // light rather than being washed out by it.
  mesh.renderOrder = 9;
  mesh.visible = false;
  return { mesh, life: 0, maxLife: 0, radius: 1, glow: 2 };
}

export function initImpactFlashes(scene) {
  if (group) disposeImpactFlashes(scene);
  group = new THREE.Group();
  group.frustumCulled = false;
  for (let i = 0; i < POOL; i++) {
    const f = makeFlash();
    pool.push(f);
    group.add(f.mesh);
  }
  scene.add(group);
}

export function disposeImpactFlashes(scene) {
  if (!group) return;
  scene.remove(group);
  for (const f of pool) {
    f.mesh.geometry.dispose();
    f.mesh.material.dispose();
  }
  pool.length = 0;
  group = null;
}

/**
 * Fire a flash. Oldest-first stealing when the pool is full — a flash is
 * fractions of a second long, so the one being recycled is already nearly
 * invisible, and dropping the NEW one instead would silently swallow the
 * detonation you're actually looking at.
 *
 * @param {number} x
 * @param {number} y
 * @param {object} opts { color, radius, life, glow, z }
 */
export function spawnImpactFlash(x, y, opts = {}) {
  if (!group) return;
  let f = pool.find((p) => p.life <= 0);
  if (!f) {
    f = pool.reduce((a, b) => (a.life <= b.life ? a : b));
  }

  f.maxLife = Math.max(0.02, opts.life ?? 0.16);
  f.life = f.maxLife;
  f.radius = Math.max(0.1, opts.radius ?? 2.4);
  f.glow = opts.glow ?? 2.6;

  f.mesh.position.set(x, y, opts.z ?? 0.3);
  f.mesh.scale.setScalar(0.001);
  f.mesh.visible = true;
  f.mesh.material.uniforms.uColor.value.set(opts.color ?? 0xffffff);
  f.mesh.material.uniforms.uGlow.value = f.glow;
  f.mesh.material.uniforms.uFade.value = 1;
  f.mesh.material.uniforms.uCore.value = 1;
  f.mesh.material.uniforms.uRing.value = 0;
}

export function updateImpactFlashes(dt) {
  if (!group) return;
  for (const f of pool) {
    if (f.life <= 0) continue;
    f.life -= dt;
    if (f.life <= 0) {
      f.life = 0;
      f.mesh.visible = false;
      continue;
    }
    const t = 1 - f.life / f.maxLife; // 0 at the instant of impact, 1 at the end
    // Ease-out on the growth: almost the whole expansion happens in the first
    // few frames, which is what makes it read as a detonation instead of a
    // bubble inflating.
    const grow = 1 - (1 - t) * (1 - t) * (1 - t);
    f.mesh.scale.setScalar(f.radius * (0.25 + 0.75 * grow));

    const u = f.mesh.material.uniforms;
    // Brightness falls faster than the flash grows, so it's at its biggest
    // just as it's going out rather than hanging around at full size.
    u.uFade.value = (1 - t) * (1 - t);
    // The white core is the shortest-lived part — by a third of the way
    // through, what's left is the hit creature's own colour.
    u.uCore.value = Math.max(0, 1 - t * 3);
    u.uRing.value = grow;
  }
}

export function clearImpactFlashes() {
  for (const f of pool) {
    f.life = 0;
    f.mesh.visible = false;
  }
}
