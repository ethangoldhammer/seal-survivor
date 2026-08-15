#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:kraken
//
// The giant squid boss and the ink it leaves, checked against the real systems
// rather than against the config that is supposed to drive them.
//
//   1. THE BODY       the rig chains named in assets.js exist on the model, and
//                     every one of them drives vertices. A chain naming a bone
//                     that is not there does not throw — it is silently dropped,
//                     and the limb simply never springs again. That exact
//                     mistake cost the orca cow her whole dorsal on half of all
//                     boss arrivals, and the only reason anyone found it was a
//                     test like this one.
//   2. THE CLIPS      every state the entry maps resolves to a clip that is
//                     really in the file. A bad name here falls through to the
//                     procedural fallback, which looks like bad tuning.
//   3. THE ROSTER     bossSquid is reachable — it is in bosses.csv, its enemy
//                     row exists, and its name parts are live rather than left
//                     disabled. Disabled name rows are dropped BEFORE the roster
//                     check, so a squid shipping with its parts still off would
//                     warn about nothing and roll shark names forever.
//   4. THE CADENCE    the burst ramp is monotonic, floors where it says it does,
//                     and every burst is preceded by a telegraph. A cloud with
//                     no windup is the one thing in this fight the player could
//                     not have avoided. This is the PROWL branch's cadence —
//                     the fight's resting state — so it is driven with no
//                     player, which is what selects that branch.
//   8. THE TRAP       the tree actually reaches weave -> closed -> crush, and
//                     the crush multiplies contact damage and puts it back.
//   9. THE GUARDS     it yields to a perk, falls through to PROWL with no
//                     player, and gives up on a ring it can never close.
//   5. THE INK        the cloud OUTLIVES its source (the whole point), drifts
//                     while nothing is emitting, has drag — mean speed falls —
//                     and expands. Measured off inkTrailStats rather than off
//                     spine coordinates, because particles die and a caller
//                     diffing positions between frames is silently comparing
//                     different particles.
//   6. THE LINGER     ink outlives the breach trail by the margin the two config
//                     blocks claim. They are a deliberate mirror of each other
//                     and that relationship is the feature, so it is asserted
//                     rather than left to two independently drifting files.
//
// No renderer, on purpose: the browser preview suspends requestAnimationFrame,
// so a screenshot proves nothing about a particle simulation. Every number
// below comes from ticking the same functions main.js ticks.
//
//   node --import ./tools/vite-loader.mjs tools/kraken-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

import * as THREE from 'three';
import { readFileSync, existsSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, createVisual } from '../path/src/assets.js';
import { parseBossCsv } from '../path/src/bossTable.js';
import { parseBossNameCsv } from '../path/src/bossNameTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';
import bossNamesCsv from '../path/src/bossNames.csv?raw';
import { burstInk, clearInkTrail, inkTrailStats, updateInkTrail } from '../path/src/systems/inkTrail.js';
import { attachKraken, krakenState, releaseKraken, resetKraken, updateKraken, updateKrakenInk } from '../path/src/systems/kraken.js';
import { inkEncirclement } from '../path/src/systems/inkTrail.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

// ---------------------------------------------------------------------------
console.log('\n1. THE BODY — every spring chain names bones that exist and deform');
// ---------------------------------------------------------------------------
const def = ASSETS.enemyGiantSquid;
const modelPath = 'public' + (def?.model ?? '');
ok(!!def, 'enemyGiantSquid is registered');
ok(existsSync(modelPath), 'the model is on disk', modelPath);

const buf = readFileSync(modelPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('enemyGiantSquid', gltf.scene, gltf.animations);
const visual = createVisual('enemyGiantSquid');
const scene = new THREE.Scene();
scene.add(visual);
scene.updateMatrixWorld(true);

// Which bones actually dominate vertices, across EVERY skinned mesh — this body
// is ten of them and the first one is a 682-vert eye shell, so a first-mesh
// reading calls a 97-bone rig "2 bones driving".
const driven = new Map();
visual.traverse((o) => {
  if (!o.isSkinnedMesh) return;
  const sk = o.skeleton.bones;
  const si = o.geometry.attributes.skinIndex;
  const sw = o.geometry.attributes.skinWeight;
  for (let v = 0; v < si.count; v++) {
    let best = -1;
    let bw = 0;
    const w = [sw.getX(v), sw.getY(v), sw.getZ(v), sw.getW(v)];
    const b = [si.getX(v), si.getY(v), si.getZ(v), si.getW(v)];
    for (let k = 0; k < 4; k++) if (w[k] > bw) { bw = w[k]; best = b[k]; }
    if (sk[best]) driven.set(sk[best].name, (driven.get(sk[best].name) ?? 0) + 1);
  }
});

const chains = def?.rig?.springChains ?? [];
ok(chains.length === 10, 'ten limb chains are declared', `got ${chains.length}`);
// THE ARMS ARE ON THEIR OWN ROLE. Eight chains (six arms, two feeding
// tentacles) carry `arm`; the two mantle fins stay `fin`. If these ever drift
// back to `fin`, the arms silently tighten to every other creature's fin
// setting — which looks like a tuning choice rather than a lost role.
const armChains = chains.filter((c) => c.role === 'arm');
const finChains = chains.filter((c) => c.role === 'fin');
ok(armChains.length === 8, 'eight chains are arms', `${armChains.length}`);
ok(finChains.length === 2, 'and the two mantle fins are not', `${finChains.length}`);
const loose = CONFIG.animation?.spring?.roleLooseness ?? {};
ok((loose.arm ?? 0) > (loose.fin ?? 0),
  'the arm role is looser than the fin role', `arm ${loose.arm} vs fin ${loose.fin}`);
let missing = 0;
let dead = 0;
for (const chain of chains) {
  for (const name of chain.bones) {
    const bone = visual.getObjectByName(name);
    if (!bone) { missing++; console.log(`        MISSING BONE ${name}`); continue; }
    // A bone that exists but drives nothing still springs — it just moves
    // geometry nobody can see, which is indistinguishable from a chain that
    // works until you look for it.
    if (!driven.has(name)) { dead++; console.log(`        DRIVES NOTHING ${name}`); }
  }
}
ok(missing === 0, 'every named bone is on the rig', `${missing} missing`);
ok(dead === 0, 'every named bone deforms geometry', `${dead} inert`);
// The chains must not share bones: two springs fighting over one joint is a
// jitter that reads as a bad damping value.
const seen = new Set();
let shared = 0;
for (const chain of chains) for (const n of chain.bones) { if (seen.has(n)) shared++; seen.add(n); }
ok(shared === 0, 'no bone appears in two chains', `${shared} shared`);

// ---------------------------------------------------------------------------
console.log('\n2. THE CLIPS — every mapped state resolves to a clip in the file');
// ---------------------------------------------------------------------------
const clipNames = new Set(gltf.animations.map((a) => a.name));
const mapped = def?.animations ?? {};
ok(Object.keys(mapped).length > 0, 'the entry maps at least one state');
for (const [state, clip] of Object.entries(mapped)) {
  ok(clipNames.has(clip), `state "${state}" -> clip "${clip}"`);
}
// The telegraph specifically, because systems/kraken.js triggers it by name and
// a missing one would make every burst arrive unannounced — a silent failure
// that looks like a design choice.
ok(!!mapped.bark, 'the burst telegraph is mapped (bark)', mapped.bark ?? '-');

// ---------------------------------------------------------------------------
console.log('\n3. THE ROSTER — bossSquid is reachable and named');
// ---------------------------------------------------------------------------
const roster = parseBossCsv(bossesCsv, CONFIG.enemies);
const squid = roster.find((b) => b.id === 'bossSquid');
ok(!!squid, 'bossSquid is in bosses.csv');
ok(!!CONFIG.enemies.bossSquid, 'its enemy row exists in CONFIG.enemies');
ok(CONFIG.enemies.bossSquid?.inkBoss === true, 'the def is flagged inkBoss', 'systems/kraken.js reads this');
ok(CONFIG.enemies.bossSquid?.behavior === 'orbit', 'it orbits rather than hunts',
  CONFIG.enemies.bossSquid?.behavior ?? '-');
const warnings = [];
const parts = parseBossNameCsv(bossNamesCsv, (m) => warnings.push(m), {
  bosses: roster.map((b) => b.id),
  perks: [],
});
// parseBossNameCsv returns the parts already bucketed BY SLOT — { prefix: [],
// root: [], epithet: [] } — not one flat list, so this has to walk the buckets.
const squidParts = Object.values(parts)
  .flat()
  .filter((p) => (p.bosses ?? []).includes('bossSquid'));
ok(squidParts.length > 0, 'its name parts are live rather than disabled',
  `${squidParts.length} enabled`);

// ---------------------------------------------------------------------------
console.log('\n4. THE CADENCE — PROWL\'s ramp tightens, floors, and always telegraphs');
// ---------------------------------------------------------------------------
const kc = CONFIG.kraken ?? {};
// A stand-in boss: updateKraken reads position, velocity, radius and health,
// and triggers an anim state. Nothing else.
const triggered = [];
function fakeSquid() {
  return {
    def: CONFIG.enemies.bossSquid,
    mesh: new THREE.Object3D(),
    vx: 3, vy: 0, radius: 4.2,
    hp: 1000, maxHp: 1000, dead: false,
    anim: { trigger: (s) => { triggered.push(s); return true; } },
  };
}
resetKraken(null);
const squidE = fakeSquid();
attachKraken(null, squidE);
ok(krakenState.timer === (kc.openingDelay ?? 3.4), 'the opening delay is honoured',
  `${num(krakenState.timer)}s`);

const gaps = [];
let sinceBurst = 0;
let lastBursts = 0;
let telegraphedBeforeEvery = true;
let sawTelegraph = false;
for (let i = 0; i < 6000; i++) {   // 100s at 60fps
  const before = krakenState.bursts;
  // NO PLAYER, which is what selects PROWL. The burst cadence moved into that
  // branch when the behaviour tree landed: with a player in reach the tree is
  // meant to be weaving a trap instead, and driving this loop with one at
  // distance zero tests the weave while claiming to test the cadence.
  updateKraken(1 / 60, null, null);
  sinceBurst += 1 / 60;
  if (triggered.length && triggered[triggered.length - 1] === 'bark') sawTelegraph = true;
  if (krakenState.bursts > before) {
    if (!sawTelegraph) telegraphedBeforeEvery = false;
    sawTelegraph = false;
    if (lastBursts > 0) gaps.push(sinceBurst);
    sinceBurst = 0;
    lastBursts = krakenState.bursts;
  }
}
ok(gaps.length >= 6, 'the fight produces a run of bursts to compare', `${gaps.length}`);
ok(telegraphedBeforeEvery, 'every burst was preceded by a telegraph');
// Monotonic non-increasing, within a frame of slop.
let tightens = true;
for (let i = 1; i < gaps.length; i++) if (gaps[i] > gaps[i - 1] + 0.02) tightens = false;
ok(tightens, 'the gap between bursts never grows',
  gaps.map((g) => num(g, 1)).join(' -> '));
const floorGap = (kc.burstEveryMin ?? 3.4) + (kc.windup ?? 0.7);
ok(gaps[gaps.length - 1] >= floorGap - 0.05, 'and floors instead of running away',
  `${num(gaps[gaps.length - 1])}s vs floor ${num(floorGap)}s`);

// THE FLINCH — a big hit inks, a scratch does not.
resetKraken(null);
clearInkTrail(null);
const hurt = fakeSquid();
attachKraken(null, hurt);
updateKraken(1 / 60, null, { x: 0, y: 0 });
const beforeScratch = inkTrailStats().burstPending;
hurt.hp -= hurt.maxHp * ((kc.flinchDamage ?? 0.045) * 0.4);   // half a threshold
updateKraken(1 / 60, null, { x: 0, y: 0 });
ok(inkTrailStats().burstPending === beforeScratch, 'a scratch does not trigger the flinch');
hurt.hp -= hurt.maxHp * ((kc.flinchDamage ?? 0.045) * 1.5);   // well over it
updateKraken(1 / 60, null, { x: 0, y: 0 });
ok(inkTrailStats().burstPending > beforeScratch, 'a real hit does',
  `${inkTrailStats().burstPending} queued`);

// ---------------------------------------------------------------------------
console.log('\n4b. THE BEAK — ink leaves the mouth, not the middle');
// ---------------------------------------------------------------------------
// The emission point is read off the eight bones of the mouth chain every frame
// rather than offset from the origin along the heading. The failure this guards
// is silent: a renamed bone leaves `beakBones` empty, sourceFor falls back to
// the body centre, and ink simply starts coming out of the animal's stomach.
{
  const beakScene = new THREE.Scene();
  clearInkTrail(beakScene);
  resetKraken(beakScene);

  const body = createVisual('enemyGiantSquid');
  const holder = new THREE.Object3D();
  holder.position.set(30, -8, 0);
  holder.add(body);
  beakScene.add(holder);
  beakScene.updateMatrixWorld(true);

  const e = {
    def: CONFIG.enemies.bossSquid,
    mesh: holder, visual: body,
    vx: 0, vy: 5, radius: 4.2,
    hp: 1000, maxHp: 1000, dead: false,
    anim: { trigger: () => true },
  };
  attachKraken(beakScene, e);
  ok(krakenState.beakBones?.length === 8, 'all eight mouth bones resolved on the live body',
    `${krakenState.beakBones?.length ?? 0} of 8`);

  // The beak's own world position, measured independently of the system.
  const bp = new THREE.Vector3();
  const mean = new THREE.Vector3();
  for (const b of krakenState.beakBones) { b.getWorldPosition(bp); mean.add(bp); }
  mean.multiplyScalar(1 / Math.max(1, krakenState.beakBones.length));

  // ENOUGH FRAMES TO ACTUALLY EMIT. At 34 a second one frame owes 0.57 of a
  // particle, so a single tick emits nothing at all and instance 0 is still the
  // zero matrix it was allocated with — which sits at the world origin and
  // happens to be about equidistant from a beak and a body 30 units away. That
  // reads as a pass and proves nothing; it is exactly the shape of a test that
  // would have shipped a broken hand-off.
  const cloudGroup0 = (() => {
    for (let i = 0; i < 6; i++) updateKrakenInk(1 / 60, beakScene, null, true);
    return beakScene.children.find((c) => c.name === 'inkTrail');
  })();
  ok(!!cloudGroup0, 'the cloud was built');
  const inst = cloudGroup0.children[0];
  ok(inst.count > 0, 'and something was actually emitted', `${inst.count} instances`);
  const m = new THREE.Matrix4();
  inst.getMatrixAt(0, m);   // newest particle — the draw loop writes nodes[0] first
  const born = new THREE.Vector3().setFromMatrixPosition(m);

  const toBeak = born.distanceTo(new THREE.Vector3(mean.x, mean.y, 0));
  const toCentre = born.distanceTo(new THREE.Vector3(holder.position.x, holder.position.y, 0));
  // Absolute, not just relative: a particle 31 units from both is not "nearer
  // the beak", it is lost. The body is ~15 units long, so a couple of units is
  // the beak and anything else is not.
  ok(toBeak < 3, 'ink is born AT the beak', `${num(toBeak)} units from it`);
  // NOTE the entry's `pivot: 0.38` already recentres the model on the crown
  // base, so the beak sits close to the mesh origin anyway and "nearer the beak
  // than the centre" is a weak claim by construction. The assertion below is the
  // one that captures what the change actually bought.
  ok(toBeak <= toCentre + 0.01, '...and no further from it than the origin is',
    `${num(toBeak)} vs ${num(toCentre)}`);

  // THE JET FOLLOWS THE POSE, NOT THE HEADING — which is what reading bones
  // buys over the old offset-along-travel. The POSITION barely moves under this
  // test and that is correct: the entry's pivot already sits on the crown base,
  // so the beak is ~0.17 from the origin and rotating about it moves it a
  // quarter of a unit. The DIRECTION is the thing that swings, and the old
  // scheme had no way to: it only ever looked at `e.vx/e.vy`, so a squid turning
  // at constant velocity squirted the same way throughout.
  const jetBefore = { x: krakenState.jetX, y: krakenState.jetY };
  holder.rotation.z = Math.PI * 0.5;
  beakScene.updateMatrixWorld(true);
  updateKrakenInk(1 / 60, beakScene, null, true);
  const jetAfter = { x: krakenState.jetX, y: krakenState.jetY };
  const dot = jetBefore.x * jetAfter.x + jetBefore.y * jetAfter.y;
  const turned = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  ok(turned > 60, 'the jet turns with the body at unchanged velocity',
    `${turned.toFixed(0)} degrees of swing on a 90-degree turn`);

  // THE JET. Fired along mantle -> beak, which for this body is its own +Y. A
  // zero here means the direction never reached emitNode and the squirt is a
  // drip — which looks like a tuning problem rather than a broken hand-off.
  const speeds = [];
  for (let i = 0; i < 10; i++) {
    updateKrakenInk(1 / 60, beakScene, null, true);
    speeds.push(inkTrailStats().meanSpeed);
  }
  ok(Math.max(...speeds) > (CONFIG.inkTrail.jetSpeed ?? 13) * 0.3,
    'and leaves with real speed — the jet reached emitNode',
    `peak mean ${num(Math.max(...speeds))} u/s against jetSpeed ${CONFIG.inkTrail.jetSpeed}`);

  resetKraken(beakScene);
}

// ---------------------------------------------------------------------------
console.log('\n5. THE INK — it outlives its source, drifts, drags and spreads');
// ---------------------------------------------------------------------------
const inkScene = new THREE.Scene();
clearInkTrail(inkScene);
const DT = 1 / 60;
// Lay a trail down along a path, the way an orbiting boss would.
for (let i = 0; i < 180; i++) {
  const t = i * DT;
  updateInkTrail(DT, inkScene, { x: Math.cos(t) * 12, y: Math.sin(t) * 12, vx: -Math.sin(t) * 12, vy: Math.cos(t) * 12 }, null, true);
}
const laid = inkTrailStats();
ok(laid.count > 20, 'a pass lays down a cloud', `${laid.count} particles`);

// THE SOURCE GOES AWAY — the boss dies. Nothing should vanish.
const atDeath = inkTrailStats();
updateInkTrail(DT, inkScene, null, null, true);
const justAfter = inkTrailStats();
ok(justAfter.count >= atDeath.count - 2, 'losing the source does not clear the cloud',
  `${atDeath.count} -> ${justAfter.count}`);

// ...and it keeps moving and spreading with nothing emitting.
const t0 = inkTrailStats();
for (let i = 0; i < 60; i++) updateInkTrail(DT, inkScene, null, null, true);
const t1 = inkTrailStats();
ok(t1.spread > t0.spread * 0.98, 'the cloud goes on churning with no source',
  `spread ${num(t0.spread)} -> ${num(t1.spread)}`);
ok(t1.meanAge > t0.meanAge, 'and goes on ageing', `${num(t0.meanAge)}s -> ${num(t1.meanAge)}s`);

// DRAG, measured WITH THE TURBULENCE OFF, and that is the whole subtlety of
// this assertion.
//
// The naive version — fire a burst, drift, expect the speed to fall to nothing —
// fails, and it fails because the system is right. Turbulence is an
// ACCELERATION, so it goes on pumping energy in forever; a particle settles at a
// terminal drift of roughly turbulence/drag (8 / 2.9 ~ 2.8 u/s) rather than
// stopping. That equilibrium IS the lingering creep the effect is for, and a
// test that demanded zero would be a test demanding the feature be removed.
//
// So the field is switched off for the length of this measurement, which leaves
// drag as the only force acting and makes the claim checkable. Restored
// immediately afterwards — CONFIG is shared, and a harness that left it modified
// would poison every assertion below it.
//
// Measured off meanSpeed rather than off positions: particles DIE, so a caller
// diffing spine coordinates between two frames is silently comparing different
// particles the moment one in the middle expires.
clearInkTrail(inkScene);
const savedTurb = CONFIG.inkTrail.turbulence;
CONFIG.inkTrail.turbulence = 0;
for (let i = 0; i < 30; i++) {
  updateInkTrail(DT, inkScene, { x: 0, y: 0, vx: 0, vy: 0 }, null, true);
}
burstInk(1);
// Long enough for the burst to finish paying out. It comes out at one particle
// a frame by design (see burstPerFrame — the rate matches the constant trail's
// particles-per-unit), so sampling twelve frames in measures a burst that is a
// third emitted and reports a swell diluted by the two thirds still to come.
const payout = Math.ceil((CONFIG.inkTrail.burstCount ?? 34) / (CONFIG.inkTrail.burstPerFrame ?? 1)) + 4;
for (let i = 0; i < payout; i++) updateInkTrail(DT, inkScene, { x: 0, y: 0, vx: 0, vy: 0 }, null, true);
const fast = inkTrailStats();
for (let i = 0; i < 90; i++) updateInkTrail(DT, inkScene, null, null, true);
const slow = inkTrailStats();
CONFIG.inkTrail.turbulence = savedTurb;
ok(slow.meanSpeed < fast.meanSpeed * 0.5, 'with the field off, drag takes the burst\'s speed away',
  `${num(fast.meanSpeed)} -> ${num(slow.meanSpeed)} u/s`);
ok(fast.meanSwell > 1.3, 'a burst makes its particles markedly bigger',
  `mean swell ${num(fast.meanSwell)} across the whole cloud`);
ok(inkTrailStats().burstPending === 0, 'and the burst has fully paid out by then');

// ...and with the field back on, the cloud settles at a CREEP rather than
// stopping. This is the other half of the same behaviour and the reason the
// assertion above needed the field off: the terminal speed is what makes ink
// go on moving for its whole seven seconds.
clearInkTrail(inkScene);
for (let i = 0; i < 30; i++) updateInkTrail(DT, inkScene, { x: 0, y: 0, vx: 0, vy: 0 }, null, true);
for (let i = 0; i < 120; i++) updateInkTrail(DT, inkScene, null, null, true);
const creep = inkTrailStats();
const terminal = (CONFIG.inkTrail.turbulence ?? 0) / Math.max(1e-6, CONFIG.inkTrail.drag ?? 1);
ok(creep.meanSpeed > 0.2, 'and with it on, the cloud never stops creeping',
  `${num(creep.meanSpeed)} u/s, terminal ~${num(terminal)}`);
ok(creep.meanSpeed < terminal * 1.5, 'but does not run away either',
  `${num(creep.meanSpeed)} vs ${num(terminal * 1.5)} u/s ceiling`);

// THE PAUSE GATE. Emission stops; drift does not.
clearInkTrail(inkScene);
for (let i = 0; i < 60; i++) updateInkTrail(DT, inkScene, { x: 0, y: 0, vx: 1, vy: 0 }, null, true);
const beforePause = inkTrailStats().count;
for (let i = 0; i < 30; i++) updateInkTrail(DT, inkScene, { x: 0, y: 0, vx: 1, vy: 0 }, null, false);
const afterPause = inkTrailStats();
ok(afterPause.count <= beforePause, 'a paused run lays down no new ink',
  `${beforePause} -> ${afterPause.count}`);
ok(afterPause.meanAge > 0, 'but what is there still ages', `${num(afterPause.meanAge)}s`);

// releaseKraken keeps the water dirty; resetKraken does not.
releaseKraken();
ok(inkTrailStats().count > 0, 'releaseKraken leaves the cloud alone');
resetKraken(inkScene);
ok(inkTrailStats().count === 0, 'resetKraken clears it');

// ---------------------------------------------------------------------------
console.log('\n6. THE LINGER — the mirror of the breach trail holds');
// ---------------------------------------------------------------------------
const ink = CONFIG.inkTrail ?? {};
const breach = CONFIG.breachTrail ?? {};
ok(ink.life > breach.life * 2, 'ink outlives the breach trail several times over',
  `${ink.life}s vs ${breach.life}s`);
// fade BELOW 1 is what makes it hold and then dissolve; above 1 is the breach
// trail's fade-immediately curve. Getting this backwards is a one-character
// change that quietly turns the lingering cloud into a puff.
ok(ink.fade < 1, 'the ink holds before it dissolves (fade < 1)', `fade ${ink.fade}`);
ok(breach.fade > 1, 'and the breach trail does the opposite (fade > 1)', `fade ${breach.fade}`);
ok(ink.drag > breach.drag, 'ink has more drag', `${ink.drag} vs ${breach.drag}`);
ok(ink.turbulence > breach.turbulence, 'and more turbulence',
  `${ink.turbulence} vs ${breach.turbulence}`);
ok(ink.width > breach.width, 'and is a volume rather than a filament',
  `${ink.width} vs ${breach.width}`);
// The porthole is load-bearing rather than decorative: without it the fight is
// unplayable rather than hard.
ok((ink.clearRadius ?? 0) > 0, 'the seal keeps a readable bubble',
  `${ink.clearRadius} + ${ink.clearFeather} feather`);

// ---------------------------------------------------------------------------
console.log('\n8. THE TRAP — the behaviour tree closes a ring, then crushes');
// ---------------------------------------------------------------------------
// A tree is a thing that can silently never reach a branch. These drive the real
// updateKraken against a stationary player and assert the fight actually gets
// through weave -> closed -> crush, and that each guard does its job.
{
  const s2 = new THREE.Scene();
  resetKraken(s2);

  const body = createVisual('enemyGiantSquid');
  const holder = new THREE.Object3D();
  holder.add(body);
  s2.add(holder);
  s2.updateMatrixWorld(true);

  const triggered = [];
  const e = {
    def: CONFIG.enemies.bossSquid,
    mesh: holder, visual: body,
    vx: 0, vy: 0, radius: 4.2,
    hp: 5000, maxHp: 5000, dead: false,
    contactDamage: CONFIG.enemies.bossSquid.contactDamage,
    perkDrive: false,
    anim: { trigger: (n) => (triggered.push(n), true) },
  };
  attachKraken(s2, e);

  // A player standing still at the origin. The squid starts on the ring.
  const player = { x: 0, y: 0 };
  holder.position.set(CONFIG.kraken.trap.radius, 0, 0);

  const seen = new Set();
  let sawWeaveDrive = false;
  let peakContact = 0;
  let peakCoverage = 0;
  let crushDist = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 30; i++) {
    updateKraken(dt, s2, player, {});
    seen.add(krakenState.branch.split(':')[0]);
    // The root selector prefixes the branch it took, so the string is
    // 'kraken/WEAVE/...' and never 'WEAVE...'.
    if (krakenState.branch.startsWith('kraken/WEAVE') && e.perkDrive) sawWeaveDrive = true;
    peakCoverage = Math.max(peakCoverage, krakenState.coverage);
    peakContact = Math.max(peakContact, e.contactDamage ?? 0);
    if (krakenState.crushStage === 'dash') {
      crushDist = Math.max(crushDist, Math.hypot(e.vx, e.vy));
    }
    // Step the body the way updateEnemies would, so the weave actually travels.
    holder.position.x += e.vx * dt;
    holder.position.y += e.vy * dt;
    s2.updateMatrixWorld(true);
    // The ink is on the real-time clock and is driven separately.
    updateKrakenInk(dt, s2, { mesh: { position: { x: player.x, y: player.y } } }, true);
  }

  ok(seen.has('kraken/WEAVE'), 'the tree reaches the WEAVE branch', [...seen].join(' '));
  ok(sawWeaveDrive, 'and takes the wheel while weaving');
  // PEAK, not final. By the time the loop ends the crush has fired and the
  // cloud it was measuring has drifted and started dissolving — asserting on
  // the last frame's coverage tests the aftermath, not the trap.
  ok(peakCoverage >= CONFIG.kraken.trap.closeAt,
    'the ring is measured against the player and reaches closure',
    `peaked at ${(peakCoverage * 100).toFixed(0)}% against a threshold of ${(CONFIG.kraken.trap.closeAt * 100).toFixed(0)}%`);
  ok(krakenState.crushes > 0, 'the trap closes and the crush fires', `${krakenState.crushes} crushes in 30s`);

  const base = CONFIG.enemies.bossSquid.contactDamage;
  ok(peakContact > base * 2, 'the crush multiplies contact damage', `peaked at ${num(peakContact)} against a base of ${base}`);
  ok(e.contactDamage === base, '...and puts it back afterwards', `${e.contactDamage} vs ${base}`);
  ok(crushDist > 20, 'the dash is a real dash', `${num(crushDist)} u/s`);
  ok(triggered.includes('strike'), 'the crush plays the strike one-shot');

  // THE DWELL. The crush must never commit off a one-frame spike: raw coverage
  // swings between 30% and 99% inside a tenth of a second as each weave burst is
  // born fat and close and then thins. Proven by driving a fight with the dwell
  // set absurdly high — the ring still closes, and the crush must never fire.
  const holdFor = CONFIG.kraken.trap.holdFor;
  ok(holdFor > 0, 'the closure has to persist to count', `holdFor ${holdFor}s`);
  CONFIG.kraken.trap.holdFor = 999;
  resetKraken(s2);
  holder.position.set(CONFIG.kraken.trap.radius, 0, 0);
  e.dead = false; e.hp = 5000; e.contactDamage = CONFIG.enemies.bossSquid.contactDamage;
  attachKraken(s2, e);
  let peakUnreachable = 0;
  for (let i = 0; i < 60 * 20; i++) {
    updateKraken(dt, s2, player, {});
    peakUnreachable = Math.max(peakUnreachable, krakenState.coverage);
    holder.position.x += e.vx * dt;
    holder.position.y += e.vy * dt;
    s2.updateMatrixWorld(true);
    updateKrakenInk(dt, s2, { mesh: { position: { x: player.x, y: player.y } } }, true);
  }
  ok(peakUnreachable >= CONFIG.kraken.trap.closeAt,
    'the ring still closes with an unreachable dwell', `peaked ${(peakUnreachable * 100).toFixed(0)}%`);
  ok(krakenState.crushes === 0,
    '...but a spike alone never commits the crush', `${krakenState.crushes} crushes`);
  CONFIG.kraken.trap.holdFor = holdFor;

  resetKraken(s2);
}

// ---------------------------------------------------------------------------
console.log('\n9. THE GUARDS — the tree yields, latches and gives up');
// ---------------------------------------------------------------------------
{
  const s3 = new THREE.Scene();
  resetKraken(s3);
  const body = createVisual('enemyGiantSquid');
  const holder = new THREE.Object3D();
  s3.add(holder.add(body));
  s3.updateMatrixWorld(true);
  const e = {
    def: CONFIG.enemies.bossSquid,
    mesh: holder, visual: body,
    vx: 0, vy: 0, radius: 4.2, hp: 5000, maxHp: 5000, dead: false,
    contactDamage: CONFIG.enemies.bossSquid.contactDamage,
    perkDrive: false, anim: { trigger: () => true },
  };
  attachKraken(s3, e);

  // NO PLAYER — the tree must fall all the way through to PROWL rather than
  // reading a null position. A boss that threw here would take the whole run
  // down on the frame the player died.
  for (let i = 0; i < 30; i++) updateKraken(1 / 60, s3, null, {});
  ok(krakenState.branch.startsWith('kraken/PROWL'), 'with no player it prowls', krakenState.branch);
  ok(e.perkDrive === false, 'and does not hold the wheel while prowling');

  // OUT OF RANGE — same fallback, by a different guard.
  holder.position.set(500, 0, 0);
  s3.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) updateKraken(1 / 60, s3, { x: 0, y: 0 }, {});
  ok(krakenState.branch.startsWith('kraken/PROWL'), 'out of range it prowls too', krakenState.branch);

  // THE GIVE-UP. A player the squid can never wall in must not pin it forever.
  holder.position.set(9, 0, 0);
  s3.updateMatrixWorld(true);
  let gaveUp = false;
  for (let i = 0; i < 60 * 20 && !gaveUp; i++) {
    // The player runs, so the ring never closes.
    const t = i / 60;
    updateKraken(1 / 60, s3, { x: Math.cos(t) * 400, y: Math.sin(t) * 400 }, {});
    if (krakenState.weaveCooldown > 0) gaveUp = true;
  }
  ok(gaveUp || krakenState.branch.startsWith('kraken/PROWL'),
    'a ring that never closes is abandoned rather than woven forever',
    krakenState.branch);

  resetKraken(s3);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
