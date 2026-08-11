#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE HORIZON SEAM — how hard the edge at the water line actually is, per hour.
//
// Composites one column of pixels through the sun on the CPU, in the same order
// the GPU draws them (sky plane, halo, disc, water fill, fog band) and using the
// real shader maths out of sky.js / celestial.js / water.js / horizon.js, then
// measures the biggest jump between two ADJACENT pixel rows. A "harsh line" is
// exactly that and nothing else: a step with no gradient in it.
//
// WHY THIS IS A NODE HARNESS AND NOT A SCREENSHOT. The browser pane suspends
// rAF, so the game does not run there, and a seam a fifth of a step wide is not
// something a JPEG of a moving frame settles anyway. The number wanted is a
// difference between two neighbouring pixels, which is arithmetic.
//
// WHAT IT CAUGHT, and what it is here to stop coming back: the sun's halo used
// to be cut by a flat clipping plane at the still-water line while the sea is
// drawn on a wave, so in every trough the cut hung in open air above the water —
// 77/255 in one row, an hour after sunrise. It peaked THERE rather than at the
// crossing because the fog band that covers it rode `twilight` (an elevation
// band) while the cut rode `horizonMix` (disc radii), and the second is twice
// as wide. Both halves are asserted below.
//
//   npm run test:horizon
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds, WAVE, sea, setSeaState } from '../path/src/arena.js';
import { updateDayCycle, dayState, skyLight, horizonY } from '../path/src/systems/daylight.js';

const SCREEN_H = 1080; // the seam is measured in PIXELS, so this has to be one
updateBounds(16 / 9);
const PX = (bounds.frameTop - bounds.bottom) / SCREEN_H;

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const cl01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ss = (a, b, x) => { const t = cl01((x - a) / (b - a || 1e-9)); return t * t * (3 - 2 * t); };
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const ldr = (c) => c.map((v) => cl01(v)); // the composite lands in 8-bit

function surfaceAt(x, wt) {
  return bounds.surfaceY
    + Math.sin(x * WAVE.k1 + wt * WAVE.w1) * sea.amp
    + Math.sin(x * WAVE.k2 + wt * WAVE.w2) * sea.amp * WAVE.amp2
    + Math.sin(x * WAVE.k3 + wt * WAVE.w3) * sea.amp * WAVE.amp3 * sea.chop;
}

// --- systems/sky.js --------------------------------------------------------
function skyAt(y) {
  const airH = Math.max(1, bounds.frameTop - bounds.surfaceY);
  const t = Math.pow(cl01((y - bounds.surfaceY) / airH), CONFIG.dayNight.skyCurve ?? 1.35);
  const hz = lin(skyLight.horizon.getHex()), zn = lin(skyLight.zenith.getHex());
  const dim = skyLight.clear > 1e-4 ? skyLight.intensity / skyLight.clear : 1;
  return [0, 1, 2].map((i) => (hz[i] + (zn[i] - hz[i]) * t) * dim);
}

// --- systems/water.js ------------------------------------------------------
function waterAt(x, y, wt) {
  const surf = surfaceAt(x, wt);
  const mask = 1 - ss(surf - 0.08, surf, y);
  if (mask <= 0) return null;
  const depth = cl01((bounds.surfaceY - y) / Math.max(bounds.surfaceY - bounds.bottom, 1e-4));
  const sh = lin(CONFIG.colors.waterShallow), md = lin(CONFIG.colors.waterMid), dp = lin(CONFIG.colors.waterDeep);
  const [s1, s2] = CONFIG.colors.zoneStops;
  const c = depth < s1
    ? [0, 1, 2].map((i) => sh[i] + (md[i] - sh[i]) * (depth / Math.max(s1, 1e-4)))
    : [0, 1, 2].map((i) => md[i] + (dp[i] - md[i]) * cl01((depth - s1) / Math.max(s2 - s1, 1e-4)));
  return { c, mask };
}

// --- systems/celestial.js --------------------------------------------------
const falloff = (d) => { const r = Math.max(0, 1 - d); return Math.pow(r, 2.6) * 0.65 + Math.pow(r, 9) * 0.35; };
const relLum = (n) => 0.2126 * (((n >>> 16) & 255) / 255)
  + 0.7152 * (((n >>> 8) & 255) / 255) + 0.0722 * ((n & 255) / 255);
function haloStrengthFor(cfg) {
  const base = cfg.haloStrength ?? 0.5, want = cfg.bloomRim ?? 0;
  if (!(want > 0) || CONFIG.bloom?.enabled === false) return base;
  return Math.max(base, (CONFIG.bloom?.threshold ?? 0.55) * want
    / Math.max(1e-4, relLum(cfg.color) * falloff(1 / Math.max(1, cfg.halo ?? 2))));
}
// `legacy` is the behaviour this replaced — one flat THREE.Plane at horizonY()
// cutting both quads — kept so the checks below can prove the harness actually
// sees the defect it is guarding against, rather than passing because the
// window happens to be looking somewhere nothing ever happens.
function bodyAt(x, y, st, cfg, wt, legacy = false) {
  const out = { add: [0, 0, 0], src: null, alpha: 0, inDisc: false };
  if (legacy && y <= horizonY()) return out;
  if (!(st.y > horizonY() - cfg.size * (cfg.halo ?? 2) * 0.5)) return out;
  const col = lin(cfg.color);
  const flare = 1 + (cfg.horizonGlow ?? 0) * st.horizonMix;

  // The halo's dissolve into the wave — the fix under test.
  const meet = legacy ? 1 : ss(0, Math.max(cfg.haloFade ?? 4.5, 1e-4), y - surfaceAt(x, wt));
  const hs = cfg.size * (cfg.halo ?? 2) * (1 + 0.12 * st.horizonMix);
  const dH = 2 * Math.hypot((x - st.x) / hs, (y - st.y) / hs);
  if (dH < 1 && meet > 0) {
    const a = falloff(dH) * haloStrengthFor(cfg) * flare * meet;
    out.add = col.map((v) => v * a);
  }

  const dD = 2 * Math.hypot((x - st.x) / cfg.size, (y - st.y) / cfg.size);
  out.inDisc = dD < 1;
  if (dD < 1) {
    const a = (cfg.maskToDisc ?? true) ? ss(1, 1 - (cfg.edgeFeather ?? 0.06), dD) : 1;
    if (a > 0.002) { out.alpha = a; out.src = col.map((v) => v * cfg.brightness * (1 - 0.18 * dD * dD)); }
  }
  return out;
}

// --- systems/horizon.js ----------------------------------------------------
function fogAt(x, y, wt, n = 0.75) {
  const cfg = CONFIG.horizonGlow;
  if (!cfg?.enabled) return null;
  const tw = CONFIG.dayNight?.enabled ? Math.max(skyLight.twilight, skyLight.horizonBody) : 0;
  const d = y - surfaceAt(x, wt);
  const lift = 1 + ((0.35 + 1.3 * n) - 1) * (cfg.noise ?? 0.7);
  const reach = (d >= 0 ? (cfg.up ?? 3) : (cfg.down ?? 2)) * (1 + tw * (cfg.twilightSpread ?? 0)) * lift;
  const k = Math.abs(d) / Math.max(reach, 1e-4);
  let den = Math.exp(-k * k * Math.max(0.2, cfg.falloff ?? 3.2)) * (1 - ss(0.5, 1.7, k)) * (0.75 + 0.4 * n);
  if (den <= 0.0006) return null;
  den = cl01(den);
  const boost = 1 + tw * (cfg.twilightBoost ?? 0);
  const tint = new THREE.Color(cfg.color);
  if (CONFIG.dayNight?.enabled) {
    tint.lerp(skyLight.horizon, (cfg.skyTint ?? 0) * (1 - tw) + (cfg.twilightTint ?? 0) * tw);
  }
  return { rgb: [tint.r, tint.g, tint.b], den, light: (cfg.light ?? 0) * boost, op: Math.min(1, (cfg.opacity ?? 0) * boost) };
}

// One pixel, composited in draw order. `bodies` off is the same frame with the
// sun and moon taken out — the difference between the two is what the celestial
// rig is contributing to the seam, which is the thing being asserted.
function px(x, y, wt, bodies = true, legacy = false) {
  // Below the sky plane's bottom edge, what shows is scene.background, which
  // world.js keeps copied from the gradient's horizon stop.
  let c = y >= bounds.surfaceY ? skyAt(y) : lin(skyLight.horizon.getHex());
  let inDisc = false;
  if (bodies) {
    for (const [st, cfg] of [[dayState.sun, CONFIG.dayNight.sun], [dayState.moon, CONFIG.dayNight.moon]]) {
      const b = bodyAt(x, y, st, cfg, wt, legacy);
      c = c.map((v, i) => v + b.add[i]);
      if (b.alpha > 0) c = c.map((v, i) => v * (1 - b.alpha) + b.src[i] * b.alpha);
      inDisc = inDisc || b.inDisc;
    }
  }
  const w = waterAt(x, y, wt);
  if (w) c = c.map((v, i) => v * (1 - w.mask) + w.c[i] * w.mask);
  const f = fogAt(x, y, wt);
  if (f) c = c.map((v, i) => f.rgb[i] * f.den * f.light + v * (1 - f.den * f.op));
  return { c: ldr(c), inDisc };
}

// The worst step between two adjacent rows in the OPEN AIR above the water,
// maxed over the halo's width and over wave phases.
//
// Two things make this the right region to measure, and both matter:
//
//   STRICTLY ABOVE THE WAVE, AND OUTSIDE THE DISC. What is left up there is
//     sky, glow and fog, all three of which are gradients — so any step at all
//     is something that stopped, and that is the entire defect. The old plane
//     cut the halo at y=0 while the wave at that x was at -0.28, which is six
//     pixels of open air: dead centre of this window.
//
//     Both exclusions are edges that BELONG. On the water line the fill makes
//     its own crest cut and the surface line is drawn over it, and a setting
//     sun behind that correctly makes it higher-contrast rather than softer —
//     measuring there would be asserting that the sun may not be occluded by
//     the sea. The disc's rim is the sun having an edge, feathered by
//     `edgeFeather`; it measures ~16/255 and is supposed to.
//   BODY-ATTRIBUTABLE. The sky gradient has a slope of its own; what is being
//     asserted is what the celestial rig ADDS to it.
function worstSeam(st, cfg, legacy = false) {
  const R = cfg.size * (cfg.halo ?? 2) * 0.5;
  let worst = 0, at = 0, atX = 0;
  for (let wt = 0; wt < 9; wt += 1.5) {
    for (let x = st.x - R; x <= st.x + R; x += 0.5) {
      // Two pixels of clearance, so the fill's own soft crest edge (0.08 units,
      // under two pixels) is never inside the window.
      const floor = surfaceAt(x, wt) + 2 * PX;
      for (let i = -60; i <= 60; i++) {
        const y = horizonY() + i * PX;
        if (y < floor) continue;
        const hi = px(x, y + PX, wt, true, legacy);
        const lo = px(x, y, wt, true, legacy);
        if (hi.inDisc || lo.inDisc) continue;
        const step = Math.abs(lum(hi.c) - lum(lo.c));
        const bare = Math.abs(lum(px(x, y + PX, wt, false).c) - lum(px(x, y, wt, false).c));
        if (step - bare > worst) { worst = step - bare; at = y; atX = x - st.x; }
      }
    }
  }
  return { worst, at, atX };
}

// ---------------------------------------------------------------------------
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// A step of this size in one pixel row, in open air, reads as a drawn line
// rather than as light. For scale: the water's own edge carries about 40/255,
// the sky gradient moves at well under 1, and the defect this replaced measured
// 77. A smoothstep fade over `haloFade` peaks at about 4.
const LIMIT = 8 / 255;

console.log('--- the seam through sunrise and sunset ---\n');
console.log('hour   body  twilight  horizonBody  worst body-attributable step');
CONFIG.dayNight.paused = true;

let worstAll = 0, worstHour = 0;
for (const hour of [6.0, 6.5, 7.0, 7.5, 8.0, 17.0, 17.5, 18.0, 18.5, 19.0]) {
  CONFIG.dayNight.scrubHour = hour;
  updateDayCycle(0);
  const above = dayState.sun.above;
  const st = above ? dayState.sun : dayState.moon;
  const cfg = above ? CONFIG.dayNight.sun : CONFIG.dayNight.moon;
  const { worst, at, atX } = worstSeam(st, cfg);
  if (worst > worstAll) { worstAll = worst; worstHour = hour; }
  console.log(`${hour.toFixed(1).padStart(5)}  ${(above ? 'sun' : 'moon').padEnd(5)} ` +
    `${skyLight.twilight.toFixed(2).padStart(8)}  ${skyLight.horizonBody.toFixed(2).padStart(11)}  ` +
    `${(worst * 255).toFixed(0).padStart(4)} / 255  at y=${at.toFixed(2).padStart(6)} x=sun${atX >= 0 ? '+' : ''}${atX.toFixed(1)}` +
    `  ${'*'.repeat(Math.round(worst * 255 / 3))}`);
}
console.log('');
check(worstAll <= LIMIT, 'no body puts a hard edge on the water line',
  `worst ${(worstAll * 255).toFixed(0)}/255 at hour ${worstHour} (limit ${(LIMIT * 255).toFixed(0)})`);

// --- the two halves of the fix, each on its own -----------------------------
console.log('\n--- the mechanisms ---\n');

CONFIG.dayNight.scrubHour = 7;
updateDayCycle(0);

// 1. The window is looking where the defect was. Run the old geometry — one
//    flat plane at horizonY(), no fade — through the same measurement: it has
//    to come out far over the limit, or the check above is passing because
//    nothing is ever measured rather than because the edge is gone.
const legacy = worstSeam(dayState.sun, CONFIG.dayNight.sun, true).worst;
const now = worstSeam(dayState.sun, CONFIG.dayNight.sun).worst;
check(legacy > LIMIT * 3, 'the harness sees the old flat clipping plane',
  `legacy ${(legacy * 255).toFixed(0)}/255 vs ${(now * 255).toFixed(0)}/255 now`);
check(now <= LIMIT, 'and the wave-anchored fade removes it',
  `${(now * 255).toFixed(0)}/255`);

// 2. The fog's cover outlasts the overlap it is covering. Measured as hours,
//    not as a curve value, because "the hour after sunrise" is the complaint.
const span = (read) => {
  let lo = 24, hi = 0;
  for (let h = 4; h <= 10; h += 0.05) {
    CONFIG.dayNight.scrubHour = h;
    updateDayCycle(0);
    if (read() > 0.05) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  }
  return hi - lo;
};
const twSpan = span(() => skyLight.twilight);
const bodySpan = span(() => skyLight.horizonBody);
const coverSpan = span(() => Math.max(skyLight.twilight, skyLight.horizonBody));
console.log(`  twilight alone covers ${twSpan.toFixed(2)}h, a body is in the water for ${bodySpan.toFixed(2)}h`);
check(coverSpan >= bodySpan - 1e-6, 'the fog band covers the whole overlap',
  `cover ${coverSpan.toFixed(2)}h vs overlap ${bodySpan.toFixed(2)}h`);
check(twSpan < bodySpan, 'twilight alone would NOT have (the original bug)',
  `${twSpan.toFixed(2)}h vs ${bodySpan.toFixed(2)}h`);

// --- and the same thing in a storm, where the wave is four times as tall ----
console.log('\n--- storm sea ---\n');
setSeaState(CONFIG.arena.waveAmplitude * (CONFIG.weather?.sea?.amp ?? 2.6), CONFIG.weather?.sea?.chop ?? 1);
CONFIG.dayNight.scrubHour = 7;
updateDayCycle(0);
const storm = worstSeam(dayState.sun, CONFIG.dayNight.sun);
console.log(`  wave excursion ${(sea.amp * (1 + WAVE.amp2 + WAVE.amp3)).toFixed(2)} units ` +
  `(${((sea.amp * (1 + WAVE.amp2 + WAVE.amp3)) / PX).toFixed(0)} px)`);
check(storm.worst <= LIMIT, 'still no hard edge with a storm running',
  `worst ${(storm.worst * 255).toFixed(0)}/255`);
setSeaState(CONFIG.arena.waveAmplitude, 0);

console.log(`\n${failures === 0 ? 'ALL HORIZON SEAM CHECKS PASSED' : `${failures} HORIZON SEAM CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
