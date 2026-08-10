import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds, surfaceHeightAt } from '../arena.js';
import { weatherState } from './weather.js';

// THUNDERSTORMS — the electrical half of the weather.
//
// Whether a storm has lightning in it is decided ONCE, when the storm starts,
// rather than rolled per bolt. That's the difference between "this is a
// thunderstorm" and "it occasionally flashes when it rains": a run gets whole
// storms with a character, and the first flash is a warning that more are
// coming rather than a one-off.
//
// Two kinds of event, and the ratio between them is the whole feel of it:
//
//   flicker — the sky lights up and nothing else happens. Sheet lightning,
//             miles off. This is most of them, and it is what makes a real
//             strike land: if every flash killed something, the flash would
//             stop being a warning and start being a metronome.
//   strike  — a bolt out of the top of the frame, down to the water, and
//             everything caught near where it lands dies.
//
// This module decides WHERE and WHEN, and draws the bolt. It deliberately
// does not decide what a strike does to the world: it pushes onto
// `lightningStrikes`, and main.js drains that and owns the consequences —
// the same split as the pending-splash queue it feeds into.

const TAU = Math.PI * 2;
const Z = 1.5; // in the air in front of the ocean, just behind the rain

export const lightningState = {
  flash: 0, // 0..1 — read by the sky gradient and the day/night light bus
  thunder: false, // is the storm currently overhead an electrical one?
  strikes: 0, // bolts this storm, for anything that wants to know
};

// Strikes that landed this frame, in world coordinates. Drained by main.js.
export const lightningStrikes = [];

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

function randomIn(range, fallback = 0) {
  if (!Array.isArray(range)) return range ?? fallback;
  return randomBetween(range[0], range[1]);
}

export function resetLightning() {
  lightningState.flash = 0;
  lightningState.thunder = false;
  lightningState.strikes = 0;
  lightningStrikes.length = 0;
}

// ---------------------------------------------------------------------------
// The bolt
// ---------------------------------------------------------------------------
const boltVertex = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const boltFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGain;
  varying float vAlpha;

  void main() {
    // Additive, and deliberately allowed past 1: the scene target is
    // half-float and the bright-pass is what turns this into a glow, so a
    // bolt that clamped to white here would be a thin bright line with no
    // bloom around it.
    gl_FragColor = vec4(uColor * vAlpha * uGain, 1.0);
  }
`;

/**
 * A jagged path from (x0,y0) to (x1,y1), as a flat list of segment endpoints.
 * The sideways wander is tapered to nothing at both ends — a jitter applied
 * evenly along the run would miss the water by its own amplitude, and the
 * point the bolt lands on is the point that kills things.
 */
function boltPath(x0, y0, x1, y1, segs, jitter, out) {
  let px = x0;
  let py = y0;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const taper = Math.sin(t * Math.PI);
    const nx = x0 + (x1 - x0) * t + (Math.random() * 2 - 1) * jitter * taper;
    const ny = y0 + (y1 - y0) * t;
    out.push(px, py, nx, ny);
    px = nx;
    py = ny;
  }
}

export function createLightning(scene) {
  const cfg = () => CONFIG.weather?.lightning;

  // Sized for the worst case rather than grown: the most bolts allowed, each
  // with a full set of branches, all alive at once.
  const maxVerts = 4096;
  const positions = new Float32Array(maxVerts * 3);
  const alphas = new Float32Array(maxVerts);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader: boltVertex,
    fragmentShader: boltFragment,
    uniforms: {
      uColor: { value: new THREE.Color(0xeaf2ff) },
      uGain: { value: 1.6 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.LineSegments(geometry, material);
  mesh.position.z = Z;
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  mesh.visible = false;
  scene.add(mesh);

  const bolts = []; // { pts:number[], alpha:number[], age, life }
  let timer = 0;
  let wasStorm = false;
  let clock = 0;
  let flashBase = 0;

  // What a bolt looks like: one trunk plus a few offshoots that peel away
  // partway down and die out. The branches are what stop it reading as a
  // crack in the glass.
  function spawnBolt(xEnd, yEnd) {
    const b = cfg().bolt;
    const pts = [];
    const alpha = [];

    const xStart = xEnd + randomBetween(-1, 1) * b.leanX;
    const yStart = bounds.top + b.overscan;
    const trunkStart = pts.length;
    boltPath(xStart, yStart, xEnd, yEnd, Math.max(2, b.segments | 0), b.jitter, pts);
    for (let i = trunkStart; i < pts.length; i += 4) alpha.push(1, 1);

    const branches = Math.round(randomIn(b.branches, 2));
    for (let n = 0; n < branches; n++) {
      // Branch off a point in the middle of the trunk — one leaving from the
      // very top or the very bottom reads as a second bolt, not a fork.
      const seg = Math.floor(randomBetween(0.2, 0.8) * (pts.length / 4)) * 4;
      const bx = pts[seg];
      const by = pts[seg + 1];
      const drop = (by - yEnd) * b.branchLength;
      if (drop <= 0.2) continue;
      const bEnd = bx + randomBetween(-1, 1) * drop * 0.9;
      const start = pts.length;
      boltPath(bx, by, bEnd, by - drop, Math.max(2, Math.round(b.segments * 0.4)), b.jitter * 0.7, pts);
      // Fade each branch out along its own length, so it thins into nothing
      // instead of stopping dead.
      const count = (pts.length - start) / 4;
      for (let i = 0; i < count; i++) {
        const t = i / Math.max(1, count - 1);
        const a = b.branchAlpha * (1 - t);
        alpha.push(a, a * (1 - 1 / Math.max(1, count)));
      }
    }

    bolts.push({ pts, alpha, age: 0, life: randomIn(b.life, 0.25) });
    if (bolts.length > Math.max(1, b.maxBolts | 0)) bolts.shift();
  }

  /**
   * @param onEvent fired for every flash — ('strike' | 'flicker', x, y). The
   *   caller decides what it sounds like and what it does; see main.js.
   */
  function update(dt, waveT, onEvent) {
    const c = cfg();
    const storming = CONFIG.weather?.enabled && weatherState.intensity > 0;

    // --- is this storm electrical? -------------------------------------------
    // Rolled on the rising edge of the storm, once. Pinning the intensity for
    // tuning forces it on: rolling dice for whether the thing you are trying
    // to look at exists is not a workflow.
    const isStorm = storming && weatherState.phase === 'storm';
    if (isStorm && !wasStorm) {
      const forced = (CONFIG.weather.forceIntensity ?? -1) >= 0;
      lightningState.thunder = forced || Math.random() < (c?.chance ?? 0);
      lightningState.strikes = 0;
      timer = randomIn(c?.interval, 6) * 0.5; // don't open with a bolt
    } else if (!isStorm && wasStorm) {
      lightningState.thunder = false;
    }
    wasStorm = isStorm;

    clock += dt;

    // --- scheduling -----------------------------------------------------------
    const live = !!c?.enabled && lightningState.thunder
      && weatherState.intensity >= (c.minIntensity ?? 0);
    if (live) {
      timer -= dt;
      if (timer <= 0) {
        // Heavier rain, more of it. The scale is the inverse of intensity, so
        // a storm at its peak fires at the configured interval and one barely
        // over the threshold is several times slower.
        timer = randomIn(c.interval, 6) / Math.max(0.25, weatherState.intensity);

        const strike = Math.random() < (c.strikeChance ?? 0);
        const f = c.flash ?? {};
        if (strike) {
          // Anywhere across the arena, including off the sides — a bolt that
          // only ever lands on screen reads as aimed at the player.
          const x = randomBetween(bounds.left - 6, bounds.right + 6);
          const y = surfaceHeightAt(x, waveT);
          spawnBolt(x, y);
          flashBase = Math.max(flashBase, f.strike ?? 0.85);
          lightningState.strikes += 1;
          // Only what lands INSIDE the arena is worth telling anyone about;
          // a bolt past the edge is scenery and has nothing to kill.
          if (x > bounds.left && x < bounds.right) {
            lightningStrikes.push({ x, y });
            onEvent?.('strike', x, y);
          } else {
            onEvent?.('flicker', x, y);
          }
        } else {
          flashBase = Math.max(flashBase, f.flicker ?? 0.45);
          onEvent?.('flicker', 0, bounds.top);
        }
      }
    }

    // --- the flash ------------------------------------------------------------
    // An exponential decay with a strobe over it. Lightning is not one flash,
    // it's a burst of them a few milliseconds apart, and the strobe is what
    // separates "the sky lit up" from "someone faded a white rectangle in".
    const f = cfg()?.flash ?? {};
    if (flashBase > 0.0005) {
      flashBase *= Math.exp(-(f.decay ?? 5.5) * dt);
      const strobe = 0.55 + 0.45 * Math.sin(clock * (f.flickerHz ?? 22) * TAU);
      lightningState.flash = Math.min(1, flashBase * strobe);
    } else {
      flashBase = 0;
      lightningState.flash = 0;
    }

    // --- the bolts ------------------------------------------------------------
    let v = 0;
    for (let i = bolts.length - 1; i >= 0; i--) {
      const bolt = bolts[i];
      bolt.age += dt;
      if (bolt.age >= bolt.life) { bolts.splice(i, 1); continue; }

      // Same strobe as the sky, so the bolt and the flash are visibly the
      // same event rather than two effects that happen to overlap.
      const k = 1 - bolt.age / bolt.life;
      const env = k * (0.55 + 0.45 * Math.sin(clock * (f.flickerHz ?? 22) * TAU));

      for (let p = 0, a = 0; p < bolt.pts.length; p += 4, a += 2) {
        if (v + 2 > maxVerts) break;
        const i3 = v * 3;
        positions[i3] = bolt.pts[p];
        positions[i3 + 1] = bolt.pts[p + 1];
        positions[i3 + 2] = 0;
        positions[i3 + 3] = bolt.pts[p + 2];
        positions[i3 + 4] = bolt.pts[p + 3];
        positions[i3 + 5] = 0;
        alphas[v] = bolt.alpha[a] * env;
        alphas[v + 1] = bolt.alpha[a + 1] * env;
        v += 2;
      }
    }

    mesh.visible = v > 0;
    if (mesh.visible) {
      const b = cfg().bolt;
      material.uniforms.uColor.value.set(b.color ?? 0xeaf2ff);
      material.uniforms.uGain.value = b.gain ?? 1.6;
    }
    geometry.setDrawRange(0, v);
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  function reset() {
    bolts.length = 0;
    flashBase = 0;
    resetLightning();
    mesh.visible = false;
    geometry.setDrawRange(0, 0);
  }

  return { update, reset, mesh };
}
