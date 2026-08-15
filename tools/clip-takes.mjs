#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FINDS THE TAKES INSIDE ONE BAKED CLIP, and measures whether each one loops.
//
//   node --import ./tools/vite-loader.mjs tools/clip-takes.mjs <model.glb> [clip]
//   ... tools/clip-takes.mjs <model.glb> --range 0,96 --range 100,150
//
// WHY THIS EXISTS. Half the animal files in this project ship as a single
// "Take 001" with every performance baked end to end and no range markers — the
// seagull's 24.77s reel, the mosasaurus's 13.2s one. assets.js can cut those up
// without re-exporting (see `subclips` and buildSubclips), but only if somebody
// supplies the frame numbers, and a WRONG range is a plausible pair of integers:
// it plays, it looks like an animation, and it snaps once per loop.
//
// So the numbers have to be measured, and there are two separate questions:
//
//   WHERE ARE THE TAKES?  A reel is a sequence of performances with quiet
//                         moments between them. `energy` below is the per-frame
//                         bone travel, and the troughs in it are where one take
//                         ends and the next begins. This is a hint, not an
//                         answer — some takes run straight into each other.
//
//   DOES IT LOOP?         The only question that matters, and the one the eye
//                         cannot answer at 60fps. A range loops iff the pose at
//                         `start` and the pose at `end` are the SAME pose. That
//                         is measurable exactly: skin nothing, just take every
//                         bone's world position at both frames and sum the
//                         distances. Zero means invisible; anything above a few
//                         percent of the body's length is a visible snap.
//
// The self-similarity pass is what turns the second question into a search: for
// every frame, the closest OTHER frame at least `--min` frames later. A cyclic
// take (a swim stroke) shows up as a run of frames whose best match sits one
// cycle ahead — so the cycle length falls out of the data rather than being
// guessed, and the range that starts and ends on the same pose is the loop.
//
// WHAT IT CANNOT TELL YOU is what a take MEANS. It will find a clean 24-frame
// loop and have no idea whether it is a swim cycle or a death twitch. Read the
// energy profile, take the ranges it proposes, and look at them.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
// Embedded textures decode through createImageBitmap; without a stub the parse
// promise never settles and the script exits silently having printed nothing.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const args = process.argv.slice(2);
const PATH = args.find((a) => !a.startsWith('--'));
if (!PATH) {
  console.error('usage: clip-takes.mjs <model.glb> [clipName] [--fps=N] [--min=N] [--range=a,b ...]');
  process.exit(1);
}
const CLIP_NAME = args.filter((a) => !a.startsWith('--'))[1] ?? null;
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const RANGES = args.filter((a) => a.startsWith('--range='))
  .map((a) => a.split('=')[1].split(',').map(Number));

const buf = readFileSync(PATH);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
gltf.scene.updateMatrixWorld(true);

let skinned = null;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
if (!skinned) { console.error('no skinned mesh in this file'); process.exit(1); }
const bones = skinned.skeleton.bones;

const clips = gltf.animations;
const clip = CLIP_NAME ? THREE.AnimationClip.findByName(clips, CLIP_NAME) : clips[0];
if (!clip) {
  console.error(`no clip "${CLIP_NAME}". This file has: ${clips.map((c) => c.name).join(', ')}`);
  process.exit(1);
}

// THE FILE'S OWN FRAME RATE, derived rather than assumed — every range printed
// below is in frames against it, and assets.js `subclipFps` has to match or the
// numbers mean nothing. Taken from the SMALLEST gap between adjacent keyframes
// rather than from key count over duration: a track with a held section has
// sparse keys through it, and averaging over that reports a rate no keyframe
// was ever authored on.
let step = Infinity;
for (const track of clip.tracks) {
  for (let i = 1; i < track.times.length; i++) {
    const d = track.times[i] - track.times[i - 1];
    if (d > 1e-6 && d < step) step = d;
  }
}
const FPS = opt('fps', Math.round(1 / step));
const FRAMES = Math.round(clip.duration * FPS);
const MIN_LOOP = opt('min', Math.max(6, Math.round(FPS * 0.4)));
// A CEILING on loop length, and it is not a nicety. Left unbounded, the search
// answers a different question than the one being asked: a reel that ends near
// the pose it started in matches its own first frame to its last, that pair is
// closer than any real cycle, and it wins every row — which is true, useless,
// and hides every stroke inside it. Cap it near the longest cycle a creature
// plausibly has and the short takes come back.
const MAX_LOOP = opt('max', FRAMES);

// THE YARDSTICK: how long the animal is, measured across the BONES in their
// rest pose. Not Box3.setFromObject — on a skinned mesh that boxes the geometry
// through the node transform and can come back several times the creature's
// visible length, which silently divides every seam below by the wrong number
// and turns a snap into a rounding error. Bone positions are the space the
// seams are measured in, so the scale has to come from there too.
const bbMin = new THREE.Vector3(Infinity, Infinity, Infinity);
const bbMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
for (const b of bones) {
  const p = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  bbMin.min(p); bbMax.max(p);
}
const size = bbMax.clone().sub(bbMin);
const SPAN = Math.max(size.x, size.y, size.z);

console.log(`\n${basename(PATH)}  "${clip.name}"`);
console.log(`  ${clip.duration.toFixed(3)}s over ${clip.tracks.length} tracks, ${bones.length} bones`);
console.log(`  smallest keyframe gap ${step.toFixed(4)}s -> ${FPS} fps, ${FRAMES} frames`);
console.log(`  body span ${SPAN.toFixed(1)} units — seams are reported against it\n`);

// --- sample every frame -----------------------------------------------------
// The pose is every bone's WORLD position. Not the quaternions: two rotations
// can differ numerically and put the flesh in the same place (q and -q are the
// same rotation), and it is where the flesh ends up that a viewer sees.
// updateMatrixWorld(true) is forced — without it every sample comes back
// identical and nothing throws.
const mixer = new THREE.AnimationMixer(gltf.scene);
const action = mixer.clipAction(clip);
action.play();

const poses = [];
for (let f = 0; f < FRAMES; f++) {
  mixer.setTime(f / FPS);
  gltf.scene.updateMatrixWorld(true);
  const p = new Float64Array(bones.length * 3);
  bones.forEach((b, i) => {
    p[i * 3] = b.matrixWorld.elements[12];
    p[i * 3 + 1] = b.matrixWorld.elements[13];
    p[i * 3 + 2] = b.matrixWorld.elements[14];
  });
  poses.push(p);
}

/** Mean per-bone distance between two frames, as a share of the body's span. */
function dist(a, b) {
  let sum = 0;
  for (let i = 0; i < poses[a].length; i += 3) {
    sum += Math.hypot(
      poses[a][i] - poses[b][i],
      poses[a][i + 1] - poses[b][i + 1],
      poses[a][i + 2] - poses[b][i + 2],
    );
  }
  return sum / bones.length;
}

// --- energy profile ---------------------------------------------------------
const energy = [];
for (let f = 1; f < FRAMES; f++) energy.push(dist(f - 1, f));
const peak = Math.max(...energy);
const BARS = ' ▁▂▃▄▅▆▇█';
console.log('MOTION PER FRAME (bone travel between adjacent frames)');
let line = '';
for (const e of energy) line += BARS[Math.min(8, Math.round((e / peak) * 8))];
// A ruler under it, so a trough can be read off as a frame number by eye.
let ruler = '';
for (let f = 1; f < FRAMES; f += 1) ruler += f % 50 === 0 ? '|' : (f % 10 === 0 ? '+' : '.');
for (let i = 0; i < line.length; i += 120) {
  console.log(`  ${String(i + 1).padStart(4)} ${line.slice(i, i + 120)}`);
  console.log(`       ${ruler.slice(i, i + 120)}`);
}
console.log(`  peak ${peak.toFixed(3)} units/frame; '.'=1 frame, '+'=10, '|'=50\n`);

// --- quiet moments ----------------------------------------------------------
// Local minima of the energy, which is where one performance has finished and
// the next has not started. These are the CUT candidates.
const quiet = [];
const window = Math.max(2, Math.round(FPS / 6));
for (let f = window; f < energy.length - window; f++) {
  let isMin = true;
  for (let k = f - window; k <= f + window; k++) if (energy[k] < energy[f]) { isMin = false; break; }
  if (isMin && energy[f] < peak * 0.25) quiet.push(f + 1);
}
console.log(`QUIET FRAMES (local troughs under 25% of peak): ${quiet.length ? quiet.join(', ') : 'none — the reel never rests'}\n`);

// --- self-similarity: where does the pose come back? ------------------------
console.log(`BEST LOOP FROM EACH FRAME (nearest pose ${MIN_LOOP}..${MAX_LOOP} frames later)`);
console.log('  start   end   len   seam        seam as % of body span');
const found = [];
for (let a = 0; a < FRAMES - MIN_LOOP; a++) {
  let best = -1, bestD = Infinity;
  for (let b = a + MIN_LOOP; b < Math.min(FRAMES, a + MAX_LOOP + 1); b++) {
    const d = dist(a, b);
    if (d < bestD) { bestD = d; best = b; }
  }
  found.push({ a, b: best, d: bestD });
}
// Report only the genuinely tight ones, and only the best of each cluster —
// consecutive frames all find nearly the same loop and printing 300 rows of it
// hides the answer.
const tight = found.filter((r) => r.d < SPAN * 0.01).sort((x, y) => x.d - y.d);
const shown = [];
for (const r of tight) {
  if (shown.some((s) => Math.abs(s.a - r.a) < MIN_LOOP / 2 && Math.abs(s.b - r.b) < MIN_LOOP / 2)) continue;
  shown.push(r);
  if (shown.length > 14) break;
}
if (!shown.length) console.log('  none under 1% of body span — this reel has no clean loop in it.');
for (const r of shown) {
  console.log(`  ${String(r.a).padStart(5)} ${String(r.b).padStart(5)} ${String(r.b - r.a).padStart(5)}   ${r.d.toFixed(4).padStart(8)}    ${((r.d / SPAN) * 100).toFixed(3)}%`);
}

// --- explicit ranges --------------------------------------------------------
if (RANGES.length) {
  console.log(`\nRANGES YOU ASKED ABOUT`);
  console.log('  range          len    seam       % span    mean energy   verdict');
  for (const [a, b] of RANGES) {
    const A = Math.max(0, Math.min(FRAMES - 1, a));
    const B = Math.max(0, Math.min(FRAMES - 1, b));
    const seam = dist(A, B);
    const pct = (seam / SPAN) * 100;
    let mean = 0;
    for (let f = A + 1; f <= B; f++) mean += energy[f - 1] ?? 0;
    mean /= Math.max(1, B - A);
    const verdict = pct < 0.5 ? 'clean' : pct < 2 ? 'visible snap' : 'BROKEN';
    console.log(`  ${String(a).padStart(4)}-${String(b).padEnd(5)} ${String(B - A).padStart(5)}   ${seam.toFixed(4).padStart(8)}   ${pct.toFixed(3).padStart(7)}%   ${mean.toFixed(4).padStart(9)}     ${verdict}`);
  }
}
console.log('');
