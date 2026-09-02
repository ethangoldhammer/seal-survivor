#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:swirl
//
// SARDINE SWIRL, ticked headlessly. The upgrade harness proves the card's stat
// wiring; this proves the thing the card buys actually happens in the water —
// which for this ability is a longer list than usual, because almost every way
// it can break is invisible in a screenshot:
//
//   A PAIR THAT NEVER SPLITS. The whole mechanic is two seeds a hair apart
//   ending up on opposite wings. Seed them from the same state, or hand the
//   field the wrong `lift`, and the two fly as one body forever — which looks
//   exactly like a school with half as many fish in it and nothing reports it.
//
//   A SCHOOL THAT DRAINS. Bodies that leave the basin are reseeded rather than
//   retired. Get that backwards and the swirl empties over a minute or two,
//   long after anyone is still looking at it.
//
//   A REACH THAT DOES NOT MATCH THE BODY. The drawn size and the hit radius are
//   derived from one number on purpose (see sardineReach) — this is the paired
//   measurement that has gone quietly wrong elsewhere in this game, so it is
//   asserted here against the geometry that is actually built.
//
//   A SPAN THAT LIES. The card quotes a WIDTH in world units and the field is
//   drawn from a projection multiplier; LORENZ_WIDTH is the measured constant
//   joining them, and a wrong one makes every reading on the card wrong by a
//   fixed factor with nothing on screen to say so.
//
// No renderer: three.js Scene/Object3D/Mesh are plain data here, which is what
// lets this run in a terminal. The browser preview suspends rAF, so a
// screenshot of this game proves nothing about whether its loop works.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';
import { bounds } from '../path/src/arena.js';
import { sardineSwirlLevelStats } from '../path/src/levelStats.js';
import {
  createSardineSwirlVisual, updateSardineSwirl, resetSardineSwirl,
  sardineCount, sardineReach, sardineSize, sardineBedOpen,
} from '../path/src/systems/sardineSwirl.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${label}${detail ? `   (${detail})` : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
}

// SEEDED, so a run that fails is a run that can be re-run. The system seeds off
// Math.random by design — a school is not a thing anyone wants deterministic in
// the game — so the harness pins it rather than plumbing a generator through
// the ability. Mulberry32, the same one assets.js uses for its blade variants.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const realRandom = Math.random;
Math.random = seededRandom(20260901);

const group = createSardineSwirlVisual();
scene.add(group);
const player = { x: 0, y: bounds.surfaceY - 12 };

function fakeEnemy(x, y, radius = 0.5, hp = 1e9) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  return {
    mesh, radius, hp, vx: 0, vy: 0,
    trapTimer: 0, charmTimer: 0, flash: 0, hitThisFrame: false, biteCooldown: 0,
    def: { asset: 'enemyFish', radius, xp: 3, contactDamage: 5 },
    type: 'fish',
  };
}

function run(frames, level, enemies = [], hooks = {}, onFrame = null) {
  for (let i = 0; i < frames; i++) {
    updateSardineSwirl(dt, scene, player, level, {}, enemies, hooks);
    onFrame?.(i);
  }
}

// ---------------------------------------------------------------------------
section('1. the school');
// ---------------------------------------------------------------------------
resetSardineSwirl();
run(1, 0);
check('no card, no school', sardineCount() === 0, `${sardineCount()} bodies`);

run(1, 1);
const pairsAt1 = sardineSwirlLevelStats(1, {}).sardinePairs;
check('one stack opens the school', sardineCount() === pairsAt1 * 2,
  `${sardineCount()} bodies for ${pairsAt1} pairs`);
// WHOLE PAIRS, and this is the assertion that catches the cheapest possible
// mistake here: a count taken straight off the level would put an odd body in
// the water with nothing to diverge from, which is the ability minus its point.
check('...and it is an even number of bodies', sardineCount() % 2 === 0, `${sardineCount()}`);

run(1, 8);
const pairsAt8 = sardineSwirlLevelStats(8, {}).sardinePairs;
check('a stack adds pairs', sardineCount() === pairsAt8 * 2 && pairsAt8 > pairsAt1,
  `${pairsAt1} pairs -> ${pairsAt8}`);

run(1, 1);
check('and dropping back down trims it', sardineCount() === pairsAt1 * 2, `${sardineCount()}`);

// ---------------------------------------------------------------------------
section('2. sensitive dependence — the pair comes apart');
// ---------------------------------------------------------------------------
resetSardineSwirl();
// One pair, so the two bodies in the group ARE the pair.
const oneStack = { ...CONFIG.sardineSwirl };
const savedCount = CONFIG.sardineSwirl.count;
const savedPer = CONFIG.sardineSwirl.countPerLevel;
CONFIG.sardineSwirl.count = 1;
CONFIG.sardineSwirl.countPerLevel = 0;
run(1, 1);
check('the pair is two bodies', sardineCount() === 2, `${sardineCount()}`);
const gapAt = () => {
  const [a, b] = group.children;
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
};
const born = gapAt();
// THEY ARRIVE AS ONE THING. `separation` is 0.03 attractor units, which at the
// swirl's projection is under a hundredth of a world unit — well inside one
// body, so the pair is a single sardine to look at.
check('they arrive on top of each other', born < sardineReach(),
  `${born.toFixed(4)} world units apart, inside a ${sardineReach().toFixed(3)} reach`);

let widest = born;
run(Math.round(20 / dt), 1, [], {}, () => { widest = Math.max(widest, gapAt()); });
// ...AND THEY END UP ON OPPOSITE WINGS. Half the school's own width is the
// weakest claim worth making: anything less could be two bodies drifting apart
// on the same wing, which is not the mechanic.
const span = sardineSwirlLevelStats(1, {}).sardineSpan;
check('...and twenty seconds later they are on opposite sides of the field',
  widest > span * 0.5, `${widest.toFixed(2)} against a ${span.toFixed(2)} span`);
CONFIG.sardineSwirl.count = savedCount;
CONFIG.sardineSwirl.countPerLevel = savedPer;
void oneStack;

// ---------------------------------------------------------------------------
section('3. the field itself');
// ---------------------------------------------------------------------------
resetSardineSwirl();
run(Math.round(3 / dt), 4);
const before = sardineCount();
// FOUR MINUTES. A body leaves the Lorenz basin rarely, so a drain shows up over
// a run rather than over a second — which is exactly why it would ship.
let finite = true;
let maxStep = 0;
let widestSeen = 0;
const prev = new Map();
run(Math.round(240 / dt), 4, [], {}, () => {
  let minX = Infinity; let maxX = -Infinity;
  for (const m of group.children) {
    if (!Number.isFinite(m.position.x) || !Number.isFinite(m.position.y)) finite = false;
    minX = Math.min(minX, m.position.x);
    maxX = Math.max(maxX, m.position.x);
    const p = prev.get(m);
    // The step is measured against the LAST frame's position for this body, and
    // a reseeded body is skipped — a wrap is a teleport by construction and is
    // not what the clamp is about.
    if (p) {
      const step = Math.hypot(m.position.x - p.x, m.position.y - p.y);
      if (step < 5) maxStep = Math.max(maxStep, step);
    }
    prev.set(m, { x: m.position.x, y: m.position.y });
  }
  widestSeen = Math.max(widestSeen, maxX - minX);
});
check('nothing goes NaN', finite);
check('the school does not drain over four minutes', sardineCount() === before,
  `${before} -> ${sardineCount()}`);

// THE CLAMP. `speedCap` is world units a second and it is applied by shortening
// the integration step, so a body may not cover more than its share of it in a
// frame. Slack because the cap bounds the DERIVATIVE at the start of each
// substep and a body accelerating through one covers a little more.
const cap = CONFIG.sardineSwirl.speedCap * dt;
check('no body outruns the speed cap', maxStep <= cap * 1.6 + 1e-6,
  `${(maxStep / dt).toFixed(1)} u/s against a cap of ${CONFIG.sardineSwirl.speedCap}`);

// THE SPAN THE CARD QUOTES IS THE SPAN ON SCREEN. This is the assertion that
// pins LORENZ_WIDTH: the projection is derived from the quoted width by
// dividing by that constant, so if it is wrong the school is a fixed factor
// wider or narrower than the number the tip prints, forever, silently.
const span4 = sardineSwirlLevelStats(4, {}).sardineSpan;
check('...and the school is as wide as the card says',
  widestSeen > span4 * 0.8 && widestSeen < span4 * 1.15,
  `${widestSeen.toFixed(2)} against a quoted ${span4.toFixed(2)}`);

// THE FIELD RIDES THE SEAL, every frame. A swirl that stayed where the player
// used to be is not their ability.
player.x += 9;
run(2, 4);
check('the field follows the seal', Math.abs(group.position.x - player.x) < 1e-6,
  `group at ${group.position.x.toFixed(2)}, seal at ${player.x.toFixed(2)}`);
player.x = 0;

// ---------------------------------------------------------------------------
section('4. the body and its reach');
// ---------------------------------------------------------------------------
// PAIRED MEASUREMENT. The drawn shell and the circle it bites with come from
// one number by construction, and this is the check that they still do — a
// reach retuned without the art (or the other way round) is an ability that
// visibly passes through fish, and the only symptom is that it "feels off".
const bladeLen = (ASSETS.sardineBlade?.blade?.length ?? 0) * sardineSize();
const reachDia = sardineReach() * 2;
check('the hit circle is the size of the body drawn',
  Math.abs(reachDia - bladeLen) < bladeLen * 0.15,
  `${reachDia.toFixed(3)} across against a body ${bladeLen.toFixed(3)} long`);
// SHORTER THAN THE RAZOR CLAM'S, which is the brief for the stand-in art.
const clamLen = (ASSETS.razorBlade?.blade?.length ?? 0) * 2.4;
check('...and it is a smaller, shorter shell than the razor clam\'s',
  bladeLen < clamLen * 0.5,
  `${bladeLen.toFixed(2)} against the blade's ${clamLen.toFixed(2)}`);

// ---------------------------------------------------------------------------
section('5. the bite');
// ---------------------------------------------------------------------------
resetSardineSwirl();
const victim = fakeEnemy(player.x, player.y, 0.8);
let hits = 0;
const seconds = 12;
run(Math.round(seconds / dt), 4, [victim], { onContact: () => { hits++; } });
check('the school bites what it crosses', hits > 0, `${hits} contact(s) in ${seconds}s`);

// THE COOLDOWN IS THE BALANCE. Every body in the water passing through one
// creature could bite it every frame; the per-sardine cooldown is the only
// thing between this ability and two orders of magnitude of DPS. The ceiling is
// bodies / cooldown, and being under it is the whole assertion.
const ceiling = (sardineCount() / CONFIG.sardineSwirl.contactCooldown) * seconds;
check('...and no faster than the per-sardine cooldown allows',
  hits <= ceiling + 1e-6,
  `${hits} against a ceiling of ${ceiling.toFixed(0)}`);

const dealt = 1e9 - victim.hp;
const perHit = sardineSwirlLevelStats(4, {}).sardineDamage;
check('every contact is worth the level\'s damage',
  Math.abs(dealt - hits * perHit) < 1e-6,
  `${dealt.toFixed(0)} over ${hits} hits at ${perHit}`);

// ---------------------------------------------------------------------------
section('6. the sound bed');
// ---------------------------------------------------------------------------
// THE ONE PIECE OF SHARED CODE THIS ABILITY CHANGED. systems/jetBed.js was the
// bubble jet's and read its settings off one fixed path; it now takes a block
// and REMEMBERS IT ON THE VOICE, because a bed released against a different
// block's numbers is a fade at the wrong speed onto the wrong cutoff — and a
// sustained voice let go wrongly is inaudible as a bug and obvious as a taste.
//
// The graph is faked, the way tools/sfx-bus-test.mjs fakes it. That is enough
// for everything worth asserting here: how many voices are open, that a held
// bed is not re-triggered every frame, and which block's numbers the nodes were
// built from.
{
  class Param {
    constructor(v = 0) { this.value = v; }
    setValueAtTime(v) { this.value = v; return this; }
    setTargetAtTime(v) { this.value = v; return this; }
    linearRampToValueAtTime(v) { this.value = v; return this; }
    exponentialRampToValueAtTime(v) { this.value = v; return this; }
    cancelScheduledValues() { return this; }
  }
  let nodeId = 0;
  const oscillators = [];
  const node = (kind, extra = {}) => ({
    kind, id: ++nodeId, outputs: [],
    connect(dest) { this.outputs.push(dest); return dest; },
    disconnect() { this.outputs.length = 0; },
    ...extra,
  });
  let clock = 0;
  class FakeCtx {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = node('destination');
    }
    // NEVER REWOUND. Voices retire against currentTime, so a clock that went
    // back would fake a saturated voice cap out of nothing.
    get currentTime() { return clock; }
    createGain() { return node('gain', { gain: new Param(1) }); }
    createBiquadFilter() {
      return node('biquad', { type: 'lowpass', frequency: new Param(20000), Q: new Param(1) });
    }
    createConvolver() { return node('convolver', { buffer: null }); }
    createDelay(max) { return node('delay', { maxDelayTime: max, delayTime: new Param(0) }); }
    createWaveShaper() { return node('waveshaper', { curve: null, oversample: 'none' }); }
    createDynamicsCompressor() {
      return node('compressor', {
        threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
        attack: new Param(0.003), release: new Param(0.25), reduction: 0,
      });
    }
    createBuffer(ch, len) {
      return { numberOfChannels: ch, length: len, getChannelData: () => new Float32Array(len) };
    }
    createBufferSource() {
      return node('source', { buffer: null, playbackRate: new Param(1), loop: false, loopStart: 0, loopEnd: 0, start() {}, stop() {} });
    }
    createOscillator() {
      const o = node('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0), start() {}, stop() {} });
      oscillators.push(o);
      return o;
    }
    async decodeAudioData() { return { duration: 1 }; }
    resume() { return Promise.resolve(); }
  }
  globalThis.window.AudioContext = FakeCtx;
  globalThis.window.setInterval = () => 0;
  globalThis.window.clearInterval = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  // SILENCED FOR THE REST OF THE PROCESS, not just across the unlock. Unlocking
  // kicks off a fetch for every voice in the bank and there is no server here,
  // so a hundred and sixty 404 warnings land ASYNCHRONOUSLY — after the last
  // check has printed, which would bury the result of the suite under them.
  console.warn = () => {};
  console.error = () => {};
  const audio = await import('../path/src/systems/audio.js');
  const { jetBedCount, releaseAllJetBeds } = await import('../path/src/systems/jetBed.js');
  audio.unlockAudio();

  releaseAllJetBeds(0.01);
  resetSardineSwirl();
  check('audio is live for this section', audio.isAudioLive());

  oscillators.length = 0;
  run(1, 3);
  check('a school in the water opens a bed', jetBedCount() === 1, `${jetBedCount()} voice(s)`);

  // THE MOST IMPORTANT LINE IN jetBed.js, from this side: the ability asks for
  // its bed every frame it has a school, so re-triggering would be sixty
  // attacks a second and no hold at all.
  run(120, 3);
  check('...and holding it is not re-triggering it', jetBedCount() === 1, `${jetBedCount()}`);

  // WHICH BLOCK'S NUMBERS. The swirl's stack is over an octave above the jet's,
  // so the note the oscillators were built at says which settings the voice
  // actually got — the whole point of passing the block rather than reading one.
  const note = CONFIG.sardineSwirl.bed.note;
  const built = oscillators.map((o) => o.frequency.value);
  check('the voice is built from the SWIRL\'s block, not the jet\'s',
    built.includes(note) && !built.includes(CONFIG.bubbleJet.bed.note),
    `oscillators at ${built.join(', ')} Hz against the swirl's ${note} and the jet's ${CONFIG.bubbleJet.bed.note}`);

  // ...and the sampled layer is looped at the measured points rather than end
  // to end. Left whole, BubbleBeam_04's seam is a tick every 2.29s riding a
  // sound whose entire job is to hold flat.
  const layer = CONFIG.sardineSwirl.bed.layers[0];
  check('the loop points are the measured ones',
    layer.loopEnd > layer.loopStart && layer.loopStart > 0,
    `${layer.loopStart}s .. ${layer.loopEnd}s of ${layer.sample}`);
  check('...and that sample is a voice in the bank',
    !!CONFIG.sfx[layer.sample]?.srcs?.length, layer.sample);

  // LOSING THE CARD IS NOT A THING THAT HAPPENS, but emptying the school is —
  // and a bed left open on an empty field is a drone for the rest of the run.
  run(2, 0);
  check('an empty school lets the bed go', jetBedCount() === 0, `${jetBedCount()}`);

  run(1, 3);
  check('...and a school coming back opens it again', jetBedCount() === 1, `${jetBedCount()}`);
  resetSardineSwirl();
  check('a reset lets it go too', jetBedCount() === 0 && sardineBedOpen() === false);
  releaseAllJetBeds(0.01);
}

// ---------------------------------------------------------------------------
section('7. teardown');
// ---------------------------------------------------------------------------
// A LOOPING VOICE OUTLIVES A RUN unless something lets it go. There is no audio
// context in Node so the bed never opens here — which is the point: the flag
// has to be false either way, and a reset that left it true would be a bed the
// next run could never re-open.
resetSardineSwirl();
check('a reset empties the school', sardineCount() === 0, `${sardineCount()} bodies`);
check('...and leaves no bed open', sardineBedOpen() === false);
check('...and takes the meshes out of the group', group.children.length === 0,
  `${group.children.length} left`);

Math.random = realRandom;
console.log('');
if (failures) {
  console.log(`FAIL — ${failures} problem(s)`);
  process.exit(1);
}
console.log('all good');
