#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:chumglow
//
// Chum brightens as the seal closes on it (CONFIG.pickups.glow). Three layers
// have to line up for that to be visible on screen, and each fails silently on
// its own:
//
//   THE RAMP     entities/pickups.js chumGlowAt — distance to a multiplier.
//   THE BUFFER   systems/instancedPool.js setGlow — that multiplier written to
//                the ORB'S OWN instance, not to the material every orb shares.
//                Get this wrong and the whole seabed lights up together, which
//                is the exact failure the gulp tell was built to avoid.
//   THE BLOOM    systems/post.js — a multiplier over 1 is only a glow because
//                the scene renders to a HalfFloat target and the bright-pass
//                sees the true value. A ramp that never crosses
//                CONFIG.bloom.threshold is a slightly paler orb, not a glow.
//
// The last one is why this file does colour arithmetic rather than trusting the
// numbers to look big. Brightness is not luminance: the orb is RED, and red is
// 21% of the luminance the bright-pass thresholds on, so a multiplier that
// sounds enormous can still land under the line. See the memory note on bloom
// thresholding luminance, not brightness.
//
// Everything expected is derived from CONFIG rather than typed in — saved
// tuning is merged over the defaults at import (imported-tuning.json), so a
// hardcoded 2.6 here would be testing the tuning file rather than the code. The
// merged values are printed at the top for the same reason, and the bloom
// section reports BOTH the pristine default look and whatever the texture panel
// currently has chum wearing, because the panel's own glow slider multiplies
// into the same colour this does.
//
// What it cannot tell you: whether the swell actually catches your eye mid-run.
// That is a run.
//
//   node --import ./tools/vite-loader.mjs tools/chum-glow-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  pickups, chumGlowAt, spawnXpOrb, updatePickups, resetPickups, flushPickupInstances,
} from '../path/src/entities/pickups.js';
import { createInstancedPool } from '../path/src/systems/instancedPool.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const G = CONFIG.pickups.glow;
const REACH = CONFIG.player.pickupRadius;
const OUTER = REACH * G.radius;

console.log('Chum proximity glow — merged config');
console.log(`  enabled ${G.enabled}   near ${G.near}   far ${G.far}`);
console.log(`  radius ${G.radius}x pickup (${REACH}) = ${OUTER} world units`);
console.log(`  curve ${G.curve}   pulse ${G.pulse.hz}Hz depth ${G.pulse.depth}`);

// ===========================================================================
section('The ramp');

const steady = (d) => chumGlowAt(d, REACH);

check('on top of the orb it is the near value',
  Math.abs(steady(0) - G.near) < 1e-9, `${steady(0).toFixed(3)}`);
check('at the rim it is the far value',
  Math.abs(steady(OUTER) - G.far) < 1e-9, `${steady(OUTER).toFixed(3)}`);
check('and past the rim it stays there rather than going negative',
  Math.abs(steady(OUTER * 5) - G.far) < 1e-9, `${steady(OUTER * 5).toFixed(3)}`);

let monotonic = true;
let prev = -Infinity;
for (let d = OUTER * 1.2; d >= 0; d -= OUTER / 40) {
  const v = steady(d);
  if (v < prev - 1e-9) monotonic = false;
  prev = v;
}
check('every step closer is brighter than the last, never dimmer', monotonic);

// The curve is the difference between "the arena glows" and "the orb you are
// arriving at glows". At the halfway mark the lift should still be a minority
// of the total, or the ramp is effectively a flood light with a soft edge.
const half = (steady(OUTER / 2) - G.far) / (G.near - G.far);
check('half a halo out, most of the lift is still ahead of you',
  half < 0.5, `${(half * 100).toFixed(0)}% of the way up at ${(OUTER / 2).toFixed(1)} units`);

// The magnet is the promise the glow is making. A halo that didn't grow with
// pickupRadius would light chum the seal has no reach for after a Magnet pick.
const magnet = REACH * 1.5; // the Magnet upgrade, exactly
check('a wider magnet lights chum that was dark before it',
  chumGlowAt(OUTER * 1.2, magnet) > chumGlowAt(OUTER * 1.2, REACH) + 1e-6,
  `${chumGlowAt(OUTER * 1.2, REACH).toFixed(2)} -> ${chumGlowAt(OUTER * 1.2, magnet).toFixed(2)} at ${(OUTER * 1.2).toFixed(1)} units`);

// ===========================================================================
section('The shimmer');

// Sampled across a full period of the pulse, at both ends of the halo.
const samples = (d, phase = 0) => {
  const out = [];
  const period = 1 / G.pulse.hz;
  for (let i = 0; i < 64; i++) out.push(chumGlowAt(d, REACH, (i / 64) * period, phase));
  return out;
};

// Just inside the rim rather than exactly on it: the ramp is what scales the
// shimmer, so at the rim the answer is trivially zero. A hair inside is where a
// pulse that ignored the ramp would show up as chum twinkling across the arena.
const atRim = samples(OUTER * 0.95);
const rimSwing = Math.max(...atRim) - Math.min(...atRim);
check('chum out at the rim sits all but still',
  rimSwing < (G.near - G.far) * 0.01, `swing ${rimSwing.toFixed(4)}`);

const onTop = samples(0);
check('chum underfoot breathes', Math.max(...onTop) - Math.min(...onTop) > 1e-6,
  `${Math.min(...onTop).toFixed(2)}..${Math.max(...onTop).toFixed(2)}`);
check('and never dips below the resting brightness while doing it',
  Math.min(...onTop) > G.far, `trough ${Math.min(...onTop).toFixed(2)} vs far ${G.far}`);

// Phase is what makes a pile read as loose bits rather than one breathing
// object. Two orbs a frame apart in the same place must not agree.
const a = chumGlowAt(1, REACH, 0.3, 0);
const b = chumGlowAt(1, REACH, 0.3, Math.PI);
check('two orbs in the same spot pulse out of step', Math.abs(a - b) > 1e-6,
  `${a.toFixed(3)} vs ${b.toFixed(3)}`);

// ===========================================================================
section('It crosses the bloom threshold');

// The bright-pass, verbatim from systems/post.js: luminance, then a smoothstep
// over a 0.25 band above the threshold. Everything below the line contributes
// nothing to the halo at all.
const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);
const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
// What the bright-pass actually hands the blur: colour scaled by the mask. Both
// halves matter — past the top of the band the mask is pinned at 1 and the
// swell comes entirely from the colour, which is where a well-tinted orb lives.
function brightOut(color, mul) {
  const c = new THREE.Vector3(color.r, color.g, color.b).multiplyScalar(mul);
  const lum = c.dot(LUMA);
  return { lum, out: lum * smoothstep(CONFIG.bloom.threshold, CONFIG.bloom.threshold + 0.25, lum) };
}

// Two looks: the colour chum has out of the box (the mid tier's), and the one
// it is wearing right now if the texture panel has been near it. `setStyle`
// converts through the same colour management the material does, so these are
// the values the shader really multiplies.
const looks = [];
const mid = CONFIG.pickups.tiers[1];
looks.push({ name: 'default tier colour', color: new THREE.Color(mid.color), panel: 1 });
const saved = CONFIG.assetLooks?.xpOrb;
if (saved && (saved.tint != null || (saved.glow ?? 1) !== 1)) {
  looks.push({
    name: 'texture panel',
    color: new THREE.Color(saved.tint ?? mid.color),
    panel: saved.glow ?? 1,
  });
}

for (const look of looks) {
  const rest = brightOut(look.color, look.panel * G.far);
  const near = brightOut(look.color, look.panel * G.near);
  console.log(`  ${look.name} (glow x${look.panel}): luminance ${rest.lum.toFixed(2)} -> ${near.lum.toFixed(2)}, bloom ${rest.out.toFixed(2)} -> ${near.out.toFixed(2)}`);
  check(`${look.name}: the near end reaches the bright-pass`,
    near.out > 0, `threshold ${CONFIG.bloom.threshold}, luminance ${near.lum.toFixed(2)}`);
  // A halo that grows by a tenth is a halo nobody notices. Half again is the
  // floor for "something over there changed".
  check(`${look.name}: and the halo swells enough to catch an eye`,
    near.out > Math.max(rest.out, 0.02) * 1.5,
    `${rest.out.toFixed(2)} -> ${near.out.toFixed(2)} (x${(near.out / Math.max(rest.out, 1e-6)).toFixed(1)})`);
}

// ===========================================================================
section('It reaches the orb and not its neighbours');

// The real path: spawn chum, run a frame of updatePickups, read the instance
// buffer. This is the half that a pure-function test cannot see — a ramp that
// is perfect and written to the shared material would pass everything above and
// light the entire seabed.
const scene = new THREE.Scene();
const player = {
  mesh: new THREE.Object3D(),
  stats: { pickupRadius: REACH, chumGulpRadius: 0 },
};
player.mesh.position.set(0, -10, 0);

// Opposite ends of the halo, level with the seal so nothing sinks out from
// under the measurement. The near one is placed just outside collectRadius —
// any closer and it is swallowed on the frame this reads it, which is the
// correct behaviour and useless for measuring brightness.
const near = { x: CONFIG.pickups.collectRadius * 2.5, y: -10 };
const far = { x: OUTER * 0.95, y: -10 };
spawnXpOrb(scene, new THREE.Vector3(near.x, near.y, 0), 1, 0.5);
spawnXpOrb(scene, new THREE.Vector3(far.x, far.y, 0), 1, 0.5);
const [nearOrb, farOrb] = pickups;

// A collect would swallow the near orb before anything could be read off it, so
// the callback is a counter and the orb is placed just outside collectRadius.
let collected = 0;
updatePickups(1 / 60, scene, player, () => { collected++; });
flushPickupInstances();

const instanceGlow = (mesh) => {
  const inst = scene.children.find((c) => c.isInstancedMesh && c.geometry === mesh.geometry);
  const i = mesh.userData.__poolSlot * 3;
  return inst?.instanceColor ? inst.instanceColor.array[i] : null;
};

const nearGlow = instanceGlow(nearOrb.mesh);
const farGlow = instanceGlow(farOrb.mesh);
check('the near orb is lit through its own instance', nearGlow > 1,
  `${nearGlow?.toFixed?.(2) ?? nearGlow}`);
check('the far one is left alone', farGlow != null && Math.abs(farGlow - G.far) < 0.05,
  `${farGlow?.toFixed?.(2) ?? farGlow}`);
check('so the two differ, which is the whole effect', nearGlow - farGlow > 0.5,
  `${(nearGlow - farGlow).toFixed(2)} apart`);
check('and the shared material was not touched',
  Math.abs(nearOrb.mesh.material.color.r - farOrb.mesh.material.color.r) < 1e-9,
  'both orbs still read one material');
check('the frame ran normally around it', collected === 0 && pickups.length === 2,
  `${pickups.length} orbs, ${collected} collected`);

// ===========================================================================
section('A released orb takes its brightness with it');

// The pool swap-removes: releasing an instance moves the last one down into the
// hole. The matrix is rewritten from the mesh every flush and heals itself; the
// colour is only written by whoever owns it, so an instance that inherited a
// dead orb's entry wears it until then. On screen that is a collected orb
// handing its glow to a stranger across the arena for a frame.
const geo = new THREE.IcosahedronGeometry(0.3, 1);
const material = new THREE.MeshBasicMaterial();
const swapScene = new THREE.Scene();
const pool = createInstancedPool(swapScene, 'swap');
const made = [];
for (let i = 0; i < 3; i++) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(i * 2, 0, 0);
  pool.acquire(m);
  pool.setGlow(m, 1 + i); // 1, 2, 3 — each instance distinguishable
  made.push(m);
}
pool.flush();
const swapInst = swapScene.children.find((c) => c.isInstancedMesh);
pool.release(made[0]);          // the last one, made[2], moves into slot 0
pool.flush();
check('the instance that moved kept its own brightness',
  Math.abs(swapInst.instanceColor.array[made[2].userData.__poolSlot * 3] - 3) < 1e-6,
  `slot ${made[2].userData.__poolSlot} holds ${swapInst.instanceColor.array[made[2].userData.__poolSlot * 3].toFixed(2)}, wanted 3`);
check('and the one that did not move was untouched',
  Math.abs(swapInst.instanceColor.array[made[1].userData.__poolSlot * 3] - 2) < 1e-6,
  `slot ${made[1].userData.__poolSlot} holds ${swapInst.instanceColor.array[made[1].userData.__poolSlot * 3].toFixed(2)}, wanted 2`);

resetPickups(scene);
console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
