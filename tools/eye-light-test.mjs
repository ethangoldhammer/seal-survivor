#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:eyes
//
// The seal's lit eyes, and the beams that leave them.
//
// The failure this exists to catch is an anchor that is PLAUSIBLE and wrong.
// `eye_L_09` and `eye_R_010` are real bones on furseal.glb, so an offset typed
// by eye produces two orbs somewhere on the head, at a position nothing in the
// game can contradict — the beams would fire from it, the glow would sit in it,
// and every existing test would pass with the lights an inch inside the skull.
//
// So the anchors are measured against the SKIN, the way every other hand-
// measured rig in this project is (see the note on bone rigs in the tail and
// jaw tests): the eyeball discs are skinned in software and the published
// anchor is required to land inside their own footprint and proud of their
// surface. A bone name and a hierarchy cannot tell you that.
//
// Four sections:
//
//   SOCKETS   the anchors and their normals exist, and sit on the eyeballs.
//   HEAD      they ride the head IK rather than the body — which is the entire
//             point of the feature, and the thing a hardcoded offset from
//             playerPos would silently fail.
//   NEAR/FAR  exactly one eye is lit in a side view, and it is the near one.
//   BEAMS     Laser Eyes fires from the socket, not from the middle of the
//             seal. Fixed with an explicit distance rather than "not equal":
//             the old origin was 2.6 world units behind the eyes and every
//             assertion that merely checked they differed would have passed on
//             a one-millimetre nudge.
//
// What it cannot tell you: whether the orbs look right. That is a seal on a
// screen.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

// eyeLights and beams paint their glow sprite on a 2D canvas, and dom-stub
// returns null for getContext. Same shim beam-churn-test uses — the pixels are
// never read back here, only the objects around them.
document.createElement = (tag) => ({
  tagName: tag, width: 0, height: 0, style: {},
  getContext: () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {}, fillRect: () => {}, clearRect: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(_v) {}, get fillStyle() { return '#000'; },
  }),
});

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../path/src/config.js';
import { installModel, createVisual } from '../path/src/assets.js';
import { createAimRig } from '../path/src/systems/aimRig.js';
import {
  createEyeLights, updateEyeLights, resetEyeLights, eyeFacing, eyeSocket,
  resolveEyeLook, flareEyeLights, flashEyeLightsLaser, flashEyeLightsDamage,
  eyeLightState,
} from '../path/src/systems/eyeLights.js';
import { beams, resetBeams, luminance, lumInto } from '../path/src/systems/beams.js';
import { updateLaserEyes, resetLaserEyes, setLaserAim } from '../path/src/systems/laserEyes.js';
import {
  playerDamageFx, updatePlayerDamageFx, resetPlayerDamageFx,
} from '../path/src/systems/playerDamageFx.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, '../public/models/furseal.glb');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

if (!existsSync(MODEL)) {
  console.error(`\nmissing ${MODEL} — the seal has to be in public/models for the game to load it too.\n`);
  process.exit(1);
}

const buf = readFileSync(MODEL);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
// The seal as the GAME holds it, not as the file ships it. createVisual points
// a creature's nose at +Y, and entities/player.js carries the facing on a
// container above the model — `rotation.z + PI/2` is the direction it swims in
// (see updatePlayer), so -PI/2 is a seal facing +X. Without this the harness
// would aim a nose-up animal at +X, crank the neck IK through ninety degrees
// and measure a pose the game never draws: the head twists far enough that
// both eyes end up on the same side of the body, which quietly turns the
// near/far assertion below into nonsense that still reads like a number.
const holder = new THREE.Object3D();
holder.rotation.z = -Math.PI / 2;
scene.add(holder);
const body = createVisual('ship');
holder.add(body);
const rig = createAimRig(body);
const AIM = new THREE.Vector2(1, 0);
// One solve so the anchors are published before anything reads them.
scene.updateMatrixWorld(true);
rig.update(1 / 60, AIM, { engaged: true });

// ---------------------------------------------------------------------------
section('SOCKETS');
// ---------------------------------------------------------------------------
check('the aim rig resolved off the real model', !!rig);
for (const name of ['eyeL', 'eyeR']) {
  check(`${name} anchor is published`, !!rig.anchors?.[name]);
  check(`${name} publishes a normal`, !!rig.anchorNormals?.[name]);
}
// A normal that arrived as a POSITION would carry the bone's translation and
// come out kilometres long; one that skipped the re-normalise would carry the
// model's 2.36 fit scale. Either reads as a plausible direction and breaks
// every threshold compared against it.
for (const name of ['eyeL', 'eyeR']) {
  const n = rig.anchorNormals[name];
  check(`${name} normal is unit length`, Math.abs(n.length() - 1) < 1e-3, `${n.length().toFixed(4)}`);
}

// --- do the anchors land on the eyeballs? ----------------------------------
// Skinned in software, forcing the whole graph: applyBoneTransform reads
// bone.matrixWorld, and without scene.updateMatrixWorld(true) every pose
// measures identical with nothing thrown.
let mesh = null;
body.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
const sk = mesh.skeleton;
const boneIndex = new Map(sk.bones.map((b, i) => [b.name, i]));

function skinnedWorld(v) {
  const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, v);
  mesh.applyBoneTransform(v, p);
  return p.applyMatrix4(mesh.matrixWorld);
}
/** Vertices this bone weights most heavily — the eyeball disc. */
function eyeballVerts(boneName) {
  const want = boneIndex.get(boneName);
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  const out = [];
  for (let v = 0; v < mesh.geometry.attributes.position.count; v++) {
    let best = -1; let bw = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(v, k);
      if (w > bw) { bw = w; best = si.getComponent(v, k); }
    }
    if (best === want) out.push(v);
  }
  return out;
}

scene.updateMatrixWorld(true);
const EYES = [
  { anchor: 'eyeL', bone: 'eye_L_09' },
  { anchor: 'eyeR', bone: 'eye_R_010' },
];
for (const e of EYES) {
  const verts = eyeballVerts(e.bone);
  check(`${e.bone} drives eyeball geometry`, verts.length > 8, `${verts.length} vertices`);
  const pts = verts.map(skinnedWorld);
  const centre = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const radius = pts.reduce((m, p) => Math.max(m, p.distanceTo(centre)), 0);

  const a = rig.anchors[e.anchor];
  const n = rig.anchorNormals[e.anchor];
  const d = a.clone().sub(centre);
  const along = d.dot(n);              // out of the face
  const across = d.clone().addScaledVector(n, -along).length();

  // ACROSS the disc: inside the eyeball's own footprint. This is what catches
  // an anchor placed at the bone ORIGIN, which sits at the rim rather than the
  // middle and is the mistake the offset exists to correct.
  check(`${e.anchor} sits inside the eyeball's footprint`,
    across < radius * 0.5, `${across.toFixed(4)} across, eye radius ${radius.toFixed(4)}`);
  // ALONG the normal: proud of the surface, but still ON the animal. The skin
  // reaches ~0.005 past the eyeball centroid right at the eye, so anything
  // under that is buried and anything past a couple of eye-radii is floating.
  check(`${e.anchor} is proud of the eyeball surface`,
    along > 0.005 && along < radius * 2,
    `${along.toFixed(4)} out (eye radius ${radius.toFixed(4)})`);
}

// The pair is a pair: same height and same reach up the snout, separated in
// camera depth only. If this ever fails, the camera is no longer side-on and
// the whole near/far mechanism below needs rethinking rather than retuning.
{
  const l = rig.anchors.eyeL; const r = rig.anchors.eyeR;
  check('the two sockets share their screen position',
    Math.hypot(l.x - r.x, l.y - r.y) < 0.05,
    `${Math.hypot(l.x - r.x, l.y - r.y).toFixed(4)} apart on screen`);
  check('the two sockets are separated in camera depth',
    Math.abs(l.z - r.z) > 0.2, `${Math.abs(l.z - r.z).toFixed(3)} in z`);
}

// ---------------------------------------------------------------------------
section('HEAD');
// ---------------------------------------------------------------------------
// The sockets have to travel with the head, not with the body. A hardcoded
// offset from the player's position passes every check above and fails this
// one, which is the only reason the anchors were worth building.
{
  const before = rig.anchors.eyeL.clone();
  const bodyPos = body.getWorldPosition(new THREE.Vector3());
  // Swing the aim hard the other way and let the neck IK chase it for a
  // second of frames. Nothing moves the seal itself.
  const away = new THREE.Vector2(-0.2, 1).normalize();
  for (let i = 0; i < 90; i++) {
    scene.updateMatrixWorld(true);
    rig.update(1 / 60, away, { engaged: true });
  }
  const after = rig.anchors.eyeL.clone();
  check('the body did not move',
    body.getWorldPosition(new THREE.Vector3()).distanceTo(bodyPos) < 1e-6);
  check('the sockets ride the head IK', after.distanceTo(before) > 0.05,
    `moved ${after.distanceTo(before).toFixed(3)} world units`);
  // ...and the normal turns with them, or the near/far test below would be
  // reading a direction frozen at the rest pose.
  // Read from the ANCHOR DEFINITION rather than naming a bone here. These
  // sockets moved off the eye bones and onto head_07 (the eye bones carry a
  // blink — see the note in assets.js), and a test that names the bone itself
  // goes from proving something to proving nothing the moment that happens: it
  // fails for the right reason once, gets "fixed" by pasting in the new name,
  // and is then just as brittle again.
  {
    const def = body.userData.aimRig.anchors.eyeL;
    const bone = body.getObjectByName(def.bone);
    const want = new THREE.Vector3().fromArray(def.normal).transformDirection(bone.matrixWorld);
    check('the socket normal turns with the head',
      rig.anchorNormals.eyeL.clone().sub(want).length() < 1e-6);
  }
  // Back to level for everything that follows.
  for (let i = 0; i < 90; i++) {
    scene.updateMatrixWorld(true);
    rig.update(1 / 60, AIM, { engaged: true });
  }
}

// ---------------------------------------------------------------------------
section('NEAR / FAR');
// ---------------------------------------------------------------------------
// The curve on its own, with no model: an eye looking at the lens is lit, one
// looking away is not, and the away case is exactly `farEye` rather than some
// fraction of it.
{
  const c = { faceStart: -0.05, faceFull: 0.25, farEye: 0 };
  check('an eye facing the lens is fully lit', eyeFacing(1, c) === 1);
  check('an eye facing away is dark', eyeFacing(-1, c) === 0);
  check('the fade is monotonic',
    eyeFacing(-0.2, c) <= eyeFacing(0, c) && eyeFacing(0, c) <= eyeFacing(0.2, c));
  const floored = { ...c, farEye: 0.3 };
  check('farEye is a floor, not a target',
    Math.abs(eyeFacing(-1, floored) - 0.3) < 1e-9 && Math.abs(eyeFacing(1, floored) - 1) < 1e-9,
    `${eyeFacing(-1, floored).toFixed(3)} .. ${eyeFacing(1, floored).toFixed(3)}`);
}

// ...and on the real rig, which is the assertion that matters: side-on, the
// camera sees one eye.
const group = createEyeLights();
scene.add(group);
// Found by walking the scene rather than read off `group.children`: the eyes
// are re-parented onto the eye bones the first frame a rig offers them, so
// after one update the group is empty. That is the fix for the drift — see the
// LOCKED TO THE BONE section below.
const beads = [];
const haloes = [];
scene.traverse((o) => {
  if (o.geometry?.type === 'SphereGeometry') beads.push(o);
  else if (o.isSprite) haloes.push(o);
});
const _wp = new THREE.Vector3();
const worldOf = (o) => o.getWorldPosition(_wp.clone());

/** Settle the eyes at a given gate, with the sockets kept current. */
function runEyes(frames, opts) {
  for (let i = 0; i < frames; i++) {
    scene.updateMatrixWorld(true);
    rig.update(1 / 60, AIM, { engaged: true });
    updateEyeLights(1 / 60, rig, opts);
  }
}

{
  check('two beads and two haloes were built',
    beads.length === 2 && haloes.length === 2, `${beads.length} beads, ${haloes.length} haloes`);
  runEyes(120, { lit: 1 });

  const shown = beads.filter((o) => o.visible && o.material.opacity > 0.01);
  check('exactly one eye is visible side-on', shown.length === 1, `${shown.length} of 2 beads`);
  // ...and it is the one nearer the camera. The camera looks down -Z from +Z
  // and is never rotated (world.js), so nearer is simply larger z.
  const nearZ = Math.max(rig.anchors.eyeL.z, rig.anchors.eyeR.z);
  // WORLD position, since the bead's own `position` is now an offset in its
  // bone's local space.
  const shownZ = worldOf(shown[0]).z;
  check('the visible eye is the near one',
    Math.abs(shownZ - nearZ) < 1e-3,
    `visible at z ${shownZ.toFixed(3)}, near socket at ${nearZ.toFixed(3)}`);
  // Drawn over the face rather than depth-tested into it — the eyeball is
  // flush with the skin and a wide halo would be sliced by the brow.
  const all = [...beads, ...haloes];
  check('the eyes are drawn over the face', all.every((o) => o.material.depthTest === false));
  check('the eyes never write depth', all.every((o) => o.material.depthWrite === false));
  check('the halo is wide enough to bloom', (CONFIG.eyes.haloRadius ?? 0) >= 0.3,
    `${CONFIG.eyes.haloRadius}`);
}

// ---------------------------------------------------------------------------
section('AT REST');
// ---------------------------------------------------------------------------
// The default state, and the whole design: a shiny black bead saying nothing.
// This is the assertion that catches a glow accidentally left switched on —
// which is invisible in a still, because a lit eye looks perfectly fine.
{
  runEyes(180, { lit: 1, charge: 0 });
  const lit = beads.find((o) => o.material.opacity > 0.01);
  check('the resting eye emits nothing',
    lit.material.emissive.r === 0 && lit.material.emissive.g === 0 && lit.material.emissive.b === 0,
    `#${lit.material.emissive.getHexString()}`);
  // The halo contributes NOTHING, which is not the same as opacity 0 any more:
  // opacity is the fade and the COLOUR carries the brightness, so a resting
  // halo is a black sprite at whatever alpha the fade is at. Additive blending
  // is colour x alpha, so black adds nothing however opaque it is — and this
  // asserts the thing that is actually true on screen.
  const contribution = (h) => Math.max(h.material.color.r, h.material.color.g, h.material.color.b)
    * h.material.opacity;
  check('...and its halo adds nothing', haloes.every((h) => contribution(h) === 0),
    haloes.map((h) => contribution(h).toFixed(4)).join(', '));
  // It is a LIT material, which is the only reason there is a catchlight at
  // all — a MeshBasicMaterial has no specular and the eye would be a flat
  // black hole however low its roughness was set.
  check('the bead takes light from the scene', lit.material.isMeshStandardMaterial === true);
  check('...and is glossy enough to catch a highlight',
    lit.material.roughness > 0 && lit.material.roughness < 0.4, `roughness ${lit.material.roughness}`);
  // Not pure black: a 0x000000 diffuse takes no light at all, so the eye
  // becomes a hole at every angle where the specular lobe misses the camera.
  const col = lit.material.color;
  check('the bead is dark but not pure black',
    col.getHex() !== 0x000000 && Math.max(col.r, col.g, col.b) < 0.2,
    `#${col.getHexString()}`);
}

// ---------------------------------------------------------------------------
section('WHAT THE EYE SAYS');
// ---------------------------------------------------------------------------
// The priority chain on its own, with no rig, no model and no renderer. This
// is where the rules live, so this is where they are asserted exhaustively —
// through updateEyeLights they would each need a pose, a clock and a frame
// budget, and the interesting cases (hurt DURING a full charge) would be
// awkward enough to arrange that they would quietly not get written.
{
  const c = CONFIG.eyes;
  const out = new THREE.Color();
  const S = (o) => ({
    charge: 0, flare: 0, flarePower: 0, laser: 0, hurt: 0, hurtPower: 0, ...o,
  });

  check('a cold eye glows not at all', resolveEyeLook(S({}), c, out) === 0);

  // CHARGE — rides the bank, in the charge ring's own two colours.
  const quarter = resolveEyeLook(S({ charge: 0.25 }), c, out);
  const cQuarter = out.getHex();
  const full = resolveEyeLook(S({ charge: 1 }), c, out);
  const cFull = out.getHex();
  check('the glow rises with the bank', full > quarter && quarter > 0,
    `${quarter.toFixed(2)} at a quarter, ${full.toFixed(2)} at full`);
  check('a filling bank is the deeper green',
    cQuarter !== cFull && new THREE.Color(c.boostColor).getHex() !== cFull,
    `#${cQuarter.toString(16)} -> #${cFull.toString(16)}`);
  check('a full bank is the pale green',
    cFull === new THREE.Color(c.boostReadyColor).getHex(),
    `#${cFull.toString(16)} against #${new THREE.Color(c.boostReadyColor).getHex().toString(16)}`);

  // RELEASE — a spike past anything the wind-up reaches.
  const flare = resolveEyeLook(S({ flare: 1, flarePower: 1, charge: 1 }), c, out);
  check('the release outshines a full charge', flare > full,
    `${flare.toFixed(2)} against ${full.toFixed(2)}`);
  check('...and it keeps the colour the bank had reached',
    out.getHex() === cFull, `#${out.getHex().toString(16)}`);
  check('a fizzle pops less than a commitment',
    resolveEyeLook(S({ flare: 1, flarePower: 0.2 }), c, out) < flare);

  // HURT — outright, whatever else is going on. The case the whole priority
  // chain exists for: bitten mid-charge, at a full bank, with a release
  // flare and a laser both burning.
  const busy = S({ charge: 1, flare: 1, flarePower: 1, laser: 1, hurt: 1, hurtPower: 1 });
  const hurt = resolveEyeLook(busy, c, out);
  check('being hit takes the eye outright',
    out.getHex() === new THREE.Color(c.hitColor).getHex(), `#${out.getHex().toString(16)}`);
  check('...and does it however loud everything else is', hurt > 0);
  check('a graze is dimmer than a maiming',
    resolveEyeLook(S({ hurt: 1, hurtPower: 0.2 }), c, out) < hurt);

  // LASER — its own channel, its own colour.
  resolveEyeLook(S({ laser: 1 }), c, out);
  check('a laser volley flares in the beam\'s colour',
    out.getHex() === new THREE.Color(c.laserColor).getHex(), `#${out.getHex().toString(16)}`);
  // ...and loses to a hit, which is the rule that matters when a beam is up
  // and something bites you standing in it.
  resolveEyeLook(S({ laser: 1, hurt: 1, hurtPower: 1 }), c, out);
  check('...but a bite still wins', out.getHex() === new THREE.Color(c.hitColor).getHex());
}

// ---------------------------------------------------------------------------
section('BIG BLOOM, BOTH COLOURS');
// ---------------------------------------------------------------------------
// The boost is green and the damage flash is red, and BOTH are meant to bloom
// hard. That is not one setting away from being true, because the bright pass
// gates on Rec.709 luminance — green is worth 72% of it and red 21%. A single
// peak-channel overdrive makes the green blaze and leaves the red sitting flat
// and dark, which reads as a rendering bug rather than as a colour choice.
//
// So the halo is normalised on LUMINANCE, and this is the section that proves
// the two hues actually arrive at the same place. It is worth asserting rather
// than eyeballing: the difference is a factor of 2.3 in the multiplier each
// colour needs, and nothing on screen names it.
{
  const c = CONFIG.eyes;
  const st = eyeLightState();
  const T = CONFIG.bloom?.threshold ?? 0.58;
  // brightFragmentShader: smoothstep(threshold, threshold + 0.25, lum), so
  // this is where a pixel contributes its FULL brightness to the bloom.
  const FULL = T + 0.25;

  /** The luminance this eye actually puts into the scene target. */
  const emitted = () => {
    const h = haloes.find((x) => x.visible) ?? haloes[0];
    return luminance(h.material.color) * h.material.opacity;
  };

  resetEyeLights();
  runEyes(30, { lit: 1 });
  check('a resting eye is under the bright pass entirely', emitted() < T,
    `${emitted().toFixed(3)} against a threshold of ${T}`);

  // GREEN — a full boost bank.
  runEyes(120, { lit: 1, charge: 1 });
  const green = emitted();
  check('a full boost blooms, and hard', green > FULL,
    `${green.toFixed(2)} luminance against ${FULL} for full bloom — ${(green / FULL).toFixed(1)}x`);
  // ...IN THE COLOUR THE CONFIG NAMES, which is not the same claim as "green".
  // `boostReadyColor` is a swatch in the tuner and it is a hot pink today; the
  // check asked for g > r and g > b and so failed on a colour somebody chose on
  // purpose. What has to hold is that the halo is wearing the boost's own hue —
  // normalising both to a peak of 1 takes the brightness out and leaves the
  // hue — and that it is nowhere near the damage colour, since the whole point
  // of the pair is that the player can tell a full bank from a bitten seal.
  const hueOf = (col) => {
    const peak = Math.max(col.r, col.g, col.b) || 1;
    return [col.r / peak, col.g / peak, col.b / peak];
  };
  check('...and it is the boost colour, not the damage one',
    st.charge > 0.95 && (() => {
      const h = haloes.find((x) => x.visible) ?? haloes[0];
      const want = hueOf(new THREE.Color(c.boostReadyColor));
      const hit = hueOf(new THREE.Color(c.hitColor));
      const got = hueOf(h.material.color);
      const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.05);
      return near(got, want) && !near(got, hit);
    })(),
    `#${c.boostReadyColor.toString(16)}`);

  // RED — a full damage flash, which must land in the same place.
  resetEyeLights();
  runEyes(30, { lit: 1 });
  flashEyeLightsDamage(1);
  runEyes(1, { lit: 1 });
  const red = emitted();
  check('a full hit blooms just as hard', red > FULL,
    `${red.toFixed(2)} luminance — ${(red / FULL).toFixed(1)}x`);
  check('...and it is red', (() => {
    const h = haloes.find((x) => x.visible) ?? haloes[0];
    return h.material.color.r > h.material.color.g && h.material.color.r > h.material.color.b;
  })());

  // THE POINT OF THE WHOLE MECHANISM. Within a few percent, not "both are
  // big" — the failure this guards is one hue quietly sitting at a third of
  // the other while every number in the tuner says they match.
  check('green and red bloom the SAME amount',
    Math.abs(green - red) / Math.max(green, red) < 0.05,
    `green ${green.toFixed(2)}, red ${red.toFixed(2)}`);

  // And the cost, stated so nobody "fixes" it: red needs a much bigger
  // multiplier to get there, so its peak channel runs far hotter and the
  // composite knee whitens its core. That is the trade, not a bug.
  const gPeak = (() => { const o = new THREE.Color(); lumInto(o, c.boostReadyColor, c.bloomLum); return Math.max(o.r, o.g, o.b); })();
  const rPeak = (() => { const o = new THREE.Color(); lumInto(o, c.hitColor, c.bloomLum); return Math.max(o.r, o.g, o.b); })();
  // HOTTER, and by how much depends on the hue somebody picked: red carries 21%
  // of Rec.709 luminance, a green 72%, and the pink in the swatch today about
  // half — so the factor was 2.3x when the boost was green and is 1.9x now.
  // Asserting the factor asserts the colour choice; what is worth holding is
  // the direction, which is the thing that surprises whoever reads the two
  // numbers and reaches for the multiplier.
  check('red pays for it in peak channel, as expected', rPeak > gPeak * 1.25,
    `red peaks at ${rPeak.toFixed(1)}, the boost at ${gPeak.toFixed(1)}`
    + ` — ${(rPeak / gPeak).toFixed(1)}x, the price of ${(0.2126 / 0.7152).toFixed(2)} of the luminance per unit`);
}

// ---------------------------------------------------------------------------
section('THE CLOCKS');
// ---------------------------------------------------------------------------
// Every flash has to end. A channel that never decays is a stuck colour, and
// on a four-pixel dot it is the kind of stuck that goes unnoticed for weeks.
{
  const st = eyeLightState();

  // A hit at full strength, and how long it is allowed to burn.
  resetEyeLights();
  runEyes(30, { lit: 1 });
  flashEyeLightsDamage(1);
  check('a hit lights the eye', st.hurt > 0);
  runEyes(Math.ceil((CONFIG.eyes.hitTime + 0.2) * 60), { lit: 1 });
  check('...and burns out on its own', st.hurt === 0);

  // A small hit landing inside a big one must not cut it short.
  resetEyeLights();
  runEyes(30, { lit: 1 });
  flashEyeLightsDamage(1);
  runEyes(6, { lit: 1 });
  const midPower = st.hurtPower * st.hurt;
  flashEyeLightsDamage(0.05);
  check('a scratch does not downgrade a maiming', st.hurtPower >= midPower - 1e-6,
    `${st.hurtPower.toFixed(3)} against ${midPower.toFixed(3)} still burning`);

  // Same rule on the release.
  resetEyeLights();
  runEyes(30, { lit: 1 });
  flareEyeLights(1);
  runEyes(6, { lit: 1 });
  const midFlare = st.flarePower * st.flare;
  flareEyeLights(0.1);
  check('a flick does not downgrade a commitment', st.flarePower >= midFlare - 1e-6);
  runEyes(Math.ceil((CONFIG.eyes.flareTime + 0.2) * 60), { lit: 1 });
  check('the release flare burns out', st.flare === 0);

  // The laser muzzle.
  resetEyeLights();
  runEyes(30, { lit: 1 });
  flashEyeLightsLaser(1);
  check('a volley lights the muzzle', st.laser > 0);
  runEyes(Math.ceil((CONFIG.eyes.laserTime + 0.2) * 60), { lit: 1 });
  check('...and it burns out', st.laser === 0);

  // THE CLOCKS RUN WHILE THE EYES ARE HIDDEN. A flash left mid-decay behind a
  // death fade would still be burning when the next run lit them, and the seal
  // would blink red on its first frame.
  resetEyeLights();
  runEyes(30, { lit: 1 });
  flashEyeLightsDamage(1);
  runEyes(Math.ceil((CONFIG.eyes.hitTime + 0.2) * 60), { lit: 0 });
  check('a flash decays even with the eyes out', st.hurt === 0);

  // The wind-up EASES rather than tracking the button, or every flick strobes.
  resetEyeLights();
  runEyes(30, { lit: 1, charge: 0 });
  runEyes(1, { lit: 1, charge: 1 });
  check('the charge does not snap on', st.charge > 0 && st.charge < 0.5,
    `${st.charge.toFixed(3)} after one frame at a full bank`);
  runEyes(90, { lit: 1, charge: 1 });
  check('...but it does get there', st.charge > 0.95, `${st.charge.toFixed(3)}`);
  runEyes(90, { lit: 1, charge: 0 });
  check('...and eases back down when the button goes', st.charge === 0);
}

// ---------------------------------------------------------------------------
section('THE GATE');
// ---------------------------------------------------------------------------
{
  const st = eyeLightState();
  resetEyeLights();
  runEyes(120, { lit: 1 });
  // Death puts them out, and reset leaves nothing lit behind.
  for (let i = 0; i < 120; i++) updateEyeLights(1 / 60, rig, { lit: 0 });
  check('the eyes go out when the seal dies', beads.every((o) => !o.visible));
  resetEyeLights();
  check('reset leaves nothing lit', beads.every((o) => !o.visible && o.material.opacity === 0)
    && haloes.every((o) => !o.visible && o.material.opacity === 0));
  check('...and no flash still burning',
    st.hurt === 0 && st.flare === 0 && st.laser === 0 && st.charge === 0);

  // A model with no eye bones gets no beads rather than two at the origin.
  updateEyeLights(1 / 60, null, { lit: 1 });
  check('a seal with no eye sockets shows nothing', beads.every((o) => !o.visible));
  // ...and back on again, so the gate is a gate rather than a one-way switch.
  runEyes(120, { lit: 1 });
  check('they light again once a rig is back', beads.some((o) => o.visible && o.material.opacity > 0.01));
}

// ---------------------------------------------------------------------------
section('BEAMS');
// ---------------------------------------------------------------------------
{
  const playerPos = new THREE.Vector3(0, 0, 0);
  const aim = { x: 1, y: 0 };
  const socket = eyeSocket(rig, 0, null);
  check('eyeSocket hands back the live anchor', socket === rig.anchors.eyeL);
  check('eyeSocket falls back when there is no rig', eyeSocket(null, 0, playerPos) === playerPos);

  // How far ahead of the seal's origin the sockets actually are. This is the
  // number the old hand-typed `eyeForward` of 0.55 was wrong by.
  const forward = socket.clone().sub(playerPos);
  check('the sockets are well ahead of the body origin',
    Math.hypot(forward.x, forward.y) > 2,
    `${Math.hypot(forward.x, forward.y).toFixed(2)} world units`);

  resetBeams(scene);
  resetLaserEyes();
  setLaserAim(aim);
  resetEyeLights();
  updateLaserEyes(1 / 60, scene, playerPos, 1, aim, rig);
  check('a stack of one lights two beams', beams.length === 2, `${beams.length}`);
  // THE WIRING, not the channel — the channel itself is asserted up in THE
  // CLOCKS. Without this the eyes stay black while a line of light leaves
  // them, which reads as a beam with no source and is exactly the sort of
  // thing a look page shows and a test never does.
  check('firing a volley lights the muzzle', eyeLightState().laser > 0,
    `${eyeLightState().laser.toFixed(2)}`);

  // The origin, in the play plane. Both sockets flatten onto one point (they
  // differ only in camera depth), so both beams start there give or take the
  // `eyeSide` straddle that keeps a pair legible.
  const straddle = CONFIG.laserEyes.eyeSide ?? 0.28;
  beams.forEach((b, i) => {
    // Beam i leaves socket i%2 — a fan of four is still two eyes.
    const s = eyeSocket(rig, i, null);
    const d = Math.hypot(b.x - s.x, b.y - s.y);
    check(`beam ${i} starts at its eye socket`, d <= straddle + 1e-3,
      `${d.toFixed(3)} from the socket (straddle allows ${straddle})`);
    // ...and NOT at the middle of the seal, which is where it used to start.
    check(`beam ${i} is not firing out of the ribcage`,
      Math.hypot(b.x - playerPos.x, b.y - playerPos.y) > 2,
      `${Math.hypot(b.x - playerPos.x, b.y - playerPos.y).toFixed(2)} from the body origin`);
  });

  // The fallback path, for a model swapped in with no eye bones. It has to be
  // the OLD behaviour exactly — a seal from the workbench must not lose its
  // lasers because it lost its eyelids.
  resetBeams(scene);
  resetLaserEyes();
  setLaserAim(aim);
  updateLaserEyes(1 / 60, scene, playerPos, 1, aim, null);
  check('a rigless model still fires', beams.length === 2, `${beams.length}`);
  const fwd = CONFIG.laserEyes.eyeForward ?? 0.55;
  check('...from the old body-relative offset',
    beams.every((b) => Math.abs(b.x - (playerPos.x + fwd)) < 1e-6),
    `x ${beams[0]?.x.toFixed(3)}, expected ${(playerPos.x + fwd).toFixed(3)}`);

  // The sweep re-reads the socket every frame rather than capturing it, which
  // is what makes the line stay welded to a head that is turning.
  resetBeams(scene);
  resetLaserEyes();
  setLaserAim(aim);
  updateLaserEyes(1 / 60, scene, playerPos, 1, aim, rig);
  const b0 = beams[0];
  const startedAt = { x: b0.x, y: b0.y };
  const follow = b0.follow?.();
  check('a beam knows how to re-read its own origin', !!follow);
  const away = new THREE.Vector2(-0.2, 1).normalize();
  for (let i = 0; i < 60; i++) {
    scene.updateMatrixWorld(true);
    rig.update(1 / 60, away, { engaged: true });
  }
  const moved = b0.follow();
  check('the origin follows the head as it turns',
    Math.hypot(moved.x - startedAt.x, moved.y - startedAt.y) > 0.05,
    `moved ${Math.hypot(moved.x - startedAt.x, moved.y - startedAt.y).toFixed(3)}`);
  resetBeams(scene);
  resetLaserEyes();
}

// ---------------------------------------------------------------------------
section('LOCKED TO THE BONE');
// ---------------------------------------------------------------------------
// The eyes must sit exactly on the eyeball AT DRAW TIME, on every frame, under
// every clock. They used to be positioned from `rig.anchors` — a world-space
// snapshot taken when the aim rig last solved — and that silently assumed
// nothing moves the seal between the solve and the render. Anything that does
// leaves the bead a frame behind, and a frame behind is a whole eye-width.
//
// The adversarial case below is the one that matters and the one no amount of
// reading main.js can rule out for good: SOMETHING TURNS THE SEAL AFTER THE
// RIG HAS PUBLISHED. It stands in for any system added later in the frame, and
// for any frame where the rig does not solve at all. Measured against the
// world-space version this section is 0.12 world units off at 60fps and 0.25
// at 30, on a bead of radius 0.08 — worse the longer the frame, which is why
// it was ugliest under time dilation.
//
// It is zero now because the beads are CHILDREN of the eye bones, so the
// renderer builds their matrices from the one it skins the head with. This
// section is what stops anyone quietly putting them back in world space.
{
  const def = body.userData.aimRig.anchors.eyeL;
  const bone = body.getObjectByName(def.bone);
  const offset = new THREE.Vector3().fromArray(def.offset);
  const bead = beads.find((b) => {
    let p = b.parent;
    while (p) { if (p === bone) return true; p = p.parent; }
    return false;
  }) ?? beads[0];

  /** Where the bone actually is once the renderer has updated everything. */
  const truth = () => {
    scene.updateMatrixWorld(true);
    return bone.localToWorld(offset.clone());
  };

  check('the beads were re-parented onto a bone',
    beads.every((b) => b.parent?.isBone === true),
    beads.map((b) => b.parent?.name ?? 'unparented').join(', '));

  // ---------------------------------------------------------------------
  // ...AND NOT ONTO ONE THAT IS BEING ANIMATED UNDERNEATH THEM.
  // ---------------------------------------------------------------------
  // The obvious bone for an eye socket is the EYE bone, and on this model it
  // is the wrong one: `eye_L_09` and `eye_R_010` carry the blink, on all
  // three channels — scale 0.200..1.300 across the clips, position over a
  // 0.23 range, quaternion the full sweep. A bead parented there is squashed
  // six-fold and shoved about several times a second. That is the animation
  // doing its job on the geometry it exists to drive; borrowing its bone is
  // the bug, and it is a bug you can only see moving.
  //
  // SCALE is the one that has to fail here rather than merely be noticed.
  // Position and rotation are fine on a socket — the head has both and the
  // eyes are supposed to ride them — but a bead cannot survive its parent
  // being squashed: `boneScale` divides out the average of the three axes,
  // so a uniform pulse would be cancelled and a NON-uniform squash comes
  // through as a distortion that no compensation can undo.
  for (const [name, clips] of [['furseal', gltf.animations]]) {
    const socketBones = new Set(
      Object.values(body.userData.aimRig.anchors)
        .filter((a) => a.bone && ['eyeL', 'eyeR'].some((k) => body.userData.aimRig.anchors[k] === a))
        .map((a) => a.bone),
    );
    const scaled = [];
    for (const clip of clips) {
      for (const t of clip.tracks) {
        if (!t.name.endsWith('.scale')) continue;
        const boneName = t.name.slice(0, -'.scale'.length).split('.').pop();
        if (!socketBones.has(boneName)) continue;
        const v = Array.from(t.values);
        const mn = Math.min(...v);
        const mx = Math.max(...v);
        if (mx - mn > 1e-4) scaled.push(`${clip.name}:${boneName} ${mn.toFixed(2)}..${mx.toFixed(2)}`);
      }
    }
    check(`${name}: no eye socket sits on a bone whose SCALE is animated`,
      scaled.length === 0,
      scaled.length ? scaled.slice(0, 3).join('; ') : [...socketBones].join(', '));
  }
  check('...and so were the haloes', haloes.every((h) => h.parent?.isBone === true));
  // A Sprite, not a quad: its parent turns with the head and flips 180 with
  // the side-view mirror, and a plane hung off that would foreshorten to a
  // line. The renderer billboards a Sprite regardless of its parent.
  check('the halo billboards itself', haloes.every((h) => h.isSprite === true));

  // The radii are authored in WORLD units, so the inherited fit scale (2.36 on
  // this seal) has to be divided back out or the eyes come out that much too
  // big — a failure that looks like a tuning mistake rather than a bug.
  const c = CONFIG.eyes;
  const worldRadius = bead.scale.x * bead.parent.matrixWorld.getMaxScaleOnAxis();
  check('the bead is its tuned size in WORLD units, not the bone\'s',
    Math.abs(worldRadius - c.radius) < 1e-3,
    `${worldRadius.toFixed(4)} against ${c.radius}`);

  /** One frame in main.js's order, with `after` moving the seal post-solve. */
  function frame(dt, after = 0, turn = 0) {
    holder.rotation.z += turn * dt;
    scene.updateMatrixWorld(true);
    rig.update(dt, AIM, { engaged: true });
    updateEyeLights(dt, rig, { lit: 1 });
    holder.rotation.z += after * dt; // ...anything that runs later in the frame
  }

  for (const [label, dt, after, turn] of [
    ['a still seal', 1 / 60, 0, 0],
    ['turning hard', 1 / 60, 0, 4],
    ['moved AFTER the rig solved, 60fps', 1 / 60, 3, 0],
    ['moved AFTER the rig solved, 30fps', 1 / 30, 3, 0],
    ['moved AFTER the rig solved, 10fps', 1 / 10, 6, 4],
    ['a frame where the rig never solves', 0, 4, 0],
  ]) {
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      frame(dt, after, turn);
      worst = Math.max(worst, worldOf(bead).distanceTo(truth()));
    }
    check(`locked to the eyeball — ${label}`, worst < 1e-6,
      `worst ${worst.toFixed(6)} world units`);
  }
}

// ---------------------------------------------------------------------------
section('DAMAGE, THROUGH THE REAL DOOR');
// ---------------------------------------------------------------------------
// systems/playerDamageFx.js is the ONE place player damage becomes
// presentation — it owns the throttle and the fraction-of-the-health-bar
// reading every channel is scaled by. The eyes have to arrive through it and
// not from some second call site, or a bite would flash the rim and not the
// eye (or, worse, flash the eye sixty times a second for contact damage).
{
  const st = eyeLightState();
  resetPlayerDamageFx();
  resetEyeLights();
  runEyes(30, { lit: 1 });
  check('a cold eye is not red', st.hurt === 0);

  const shown = playerDamageFx(40, 100, { x: 0, y: 0 });
  check('a real hit is shown', shown > 0, `${shown} damage`);
  check('...and it reddens the eyes', st.hurt > 0 && st.hurtPower > 0,
    `power ${st.hurtPower.toFixed(2)}`);

  // The throttle. Contact damage arrives as a per-frame slice, and an eye that
  // re-lit on every one of them would be a solid red dot for as long as
  // anything was chewing on you rather than a flash you can count.
  resetPlayerDamageFx();
  resetEyeLights();
  runEyes(30, { lit: 1 });
  let lit = 0;
  for (let i = 0; i < 60; i++) {
    const before = st.hurt;
    playerDamageFx(0.7, 100, { x: 0, y: 0 }); // a megalodon's 42/second at 60fps
    if (st.hurt > before) lit++;
    updatePlayerDamageFx(1 / 60);
    runEyes(1, { lit: 1 });
  }
  check('being chewed on flashes, it does not stay red',
    lit > 0 && lit <= 8, `${lit} flashes in a second of contact damage`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
