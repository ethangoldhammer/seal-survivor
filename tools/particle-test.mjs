#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:particles
//
// Everything in a particle burst is decided in two places: the attributes
// entities/particles.js writes on the CPU when a burst is emitted, and the
// closed-form solve the vertex shader runs on them every frame. This drives the
// real emitter with the real merged CONFIG and measures both.
//
// WHAT IT CAN PROVE, and how:
//
//   THE PALETTE   A lint over every emitter in CONFIG.emitters: the colours in
//                 one burst have to sit in one hue family. This is the check
//                 that stops the rainbow coming back — a new emitter with a
//                 magenta in an orange ramp fails here rather than in a
//                 playtest three weeks later.
//   DEATH TINTS   The one exception to the palette rule, and it is checked in
//                 both directions. A burst fed a colour must come out ENTIRELY
//                 that hue (with brightness scattered, or it reads as a blob);
//                 and the only call site in the game allowed to feed one is the
//                 kill. What it feeds must also be a colour for EVERY creature
//                 in the roster — a null there falls back to the emitter's
//                 palette, which is the generic burst this rule forbids.
//   THE CURRENT   Turbulence is written twice — once in GLSL for the shader,
//                 once in JS for the bubble solve — and the two drifting apart
//                 puts a bubble's burst somewhere the bubble isn't. Both
//                 copies are read out of the source file and their constants
//                 compared.
//   DRAG          Every particle in a burst must get its own drag, inside the
//                 configured spread. A burst where they all match is the rigid
//                 shell the spread exists to break up.
//   THE SURFACE   No bubble may render above the water line. The guarantee is a
//                 clip in the shader rather than the CPU tracker, so the test
//                 emits far more bubbles than the tracker's budget and checks
//                 EVERY one carries the flag — the ones the tracker dropped
//                 included. The alive/position solve below mirrors the GLSL;
//                 that the GLSL actually contains the clip is asserted
//                 separately against the source.
//
// Everything expected is derived from CONFIG, never hardcoded: imported-tuning.
// json is merged at import and wins over config.js, so a literal here would be
// a test of the tuning file rather than of the code.
//
// What it cannot tell you: whether the turbulence LOOKS like water. Numbers
// can say the field is divergence-free and that both copies agree; they can't
// say it reads as a current. That is eyes on a screen.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, sea, setWaveTime, surfaceHeightAt } from '../path/src/arena.js';
import { assetBaseColor } from '../path/src/assets.js';
import {
  initParticles,
  emit,
  updateParticles,
  resetParticles,
  turbulenceAt,
  particleCount,
  particleCapacity,
  setParticleRelief,
} from '../path/src/entities/particles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '../path/src/entities/particles.js'), 'utf8');

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const scene = new THREE.Scene();
initParticles(scene);
const geo = scene.children[0].geometry;
const A = geo.attributes;

// Which slots a single emit() call just wrote. The ring buffer hands them out
// in order from `cursor`, so a burst is always the last `n` live slots — but
// asking the buffer directly is more honest than tracking a cursor here.
function burst(name, x, y, opts = {}) {
  const before = A.aStart.array.slice();
  emit(name, x, y, opts);
  const idx = [];
  for (let i = 0; i < A.aStart.count; i++) if (A.aStart.array[i] !== before[i]) idx.push(i);
  return idx;
}

// ===========================================================================
// THE PALETTE
// ===========================================================================
section('Palette: one hue family per emitter');

// Hue in degrees, plus a saturation so near-white and near-grey can be skipped:
// a white highlight belongs in every palette and has no hue to disagree with.
function hsl(hex) {
  const c = new THREE.Color(hex);
  const out = { h: 0, s: 0, l: 0 };
  c.getHSL(out);
  return { h: out.h * 360, s: out.s * (1 - Math.abs(2 * out.l - 1)), l: out.l };
}

// Widest gap between any two hues, measured the short way round the wheel — a
// red at 350 and an orange at 20 are 30 apart, not 330.
function hueSpread(hues) {
  if (hues.length < 2) return 0;
  const sorted = [...hues].sort((a, b) => a - b);
  // The largest empty arc is the one to exclude; what's left is the spread.
  let widestGap = 360 - sorted[sorted.length - 1] + sorted[0];
  for (let i = 1; i < sorted.length; i++) widestGap = Math.max(widestGap, sorted[i] - sorted[i - 1]);
  return 360 - widestGap;
}

// Red through orange to yellow is one family and spans about 60 degrees of the
// wheel; anything past this is a second colour, not a ramp.
const MAX_HUE_SPREAD = 70;
const CHROMATIC = 0.15; // below this a colour is a white/grey and carries no hue

for (const [name, def] of Object.entries(CONFIG.emitters)) {
  const hues = (def.colors ?? [0xffffff]).map(hsl).filter((c) => c.s >= CHROMATIC).map((c) => c.h);
  const spread = hueSpread(hues);
  check(
    `${name} is one family`,
    spread <= MAX_HUE_SPREAD,
    `${spread.toFixed(0)}° across [${(def.colors ?? []).map((c) => '#' + c.toString(16).padStart(6, '0')).join(' ')}]`,
  );
}

// ===========================================================================
// NO CALLER TINTING
// ===========================================================================
section('Colour comes from the emitter — except on a death');

resetParticles();
const PINK = 0xff00c8;
const pink = new THREE.Color(PINK);
const tinted = burst('explosion', 0, -10, { color: PINK, glow: 1 });

// The hue is carried by the channel RATIOS, not the magnitudes: the emitter's
// glow multiplier and the per-particle brightness scatter both scale all three
// channels together, so normalising on the peak channel is what isolates it.
const norm = (i) => {
  const c = [A.aColor.array[i * 3], A.aColor.array[i * 3 + 1], A.aColor.array[i * 3 + 2]];
  const peak = Math.max(...c);
  return peak > 0 ? c.map((v) => v / peak) : c;
};
const pinkNorm = (() => {
  const peak = Math.max(pink.r, pink.g, pink.b);
  return [pink.r / peak, pink.g / peak, pink.b / peak];
})();

let offHue = 0;
const brightness = [];
for (const i of tinted) {
  const n = norm(i);
  if (n.some((v, k) => Math.abs(v - pinkNorm[k]) > 1e-3)) offHue++;
  brightness.push(Math.max(A.aColor.array[i * 3], A.aColor.array[i * 3 + 1], A.aColor.array[i * 3 + 2]));
}
check('a tinted burst is entirely the caller\'s hue', offHue === 0,
  `${tinted.length} particles, ${offHue} off-hue`);
// One hue applied flat is a blob rather than an explosion. The scatter is what
// gives a single-colour burst the depth the multi-colour palettes have.
const spread = Math.max(...brightness) / Math.min(...brightness);
check('and its brightness is scattered, not flat', spread > 1.5,
  `brightest/dimmest ${spread.toFixed(2)}`);

// Untinted, the same emitter still comes out of its own palette — the tint is
// an override for the one caller, not a new default.
resetParticles();
const plain = burst('explosion', 0, -10, { glow: 1 });
const palette = (CONFIG.emitters.explosion.colors ?? []).map((c) => new THREE.Color(c));
let offPalette = 0;
const glowMul = (CONFIG.emitters.explosion.glow ?? 1) * (CONFIG.bloom?.particleOverdrive ?? 1);
for (const i of plain) {
  const r = A.aColor.array[i * 3] / glowMul;
  const g = A.aColor.array[i * 3 + 1] / glowMul;
  const b = A.aColor.array[i * 3 + 2] / glowMul;
  const match = palette.some((p) => Math.abs(p.r - r) < 1e-3 && Math.abs(p.g - g) < 1e-3 && Math.abs(p.b - b) < 1e-3);
  if (!match) offPalette++;
}
check('an untinted burst is still the emitter\'s palette', offPalette === 0,
  `${plain.length} particles, ${offPalette} off-palette`);

// ---------------------------------------------------------------------------
// A DEATH IS ALWAYS THE CREATURE'S COLOUR
//
// Two ways this rule dies quietly. One: a second call site starts passing a
// colour, and the per-creature tint stops meaning "something died". Two: the
// kill passes a colour that comes back null for some creature, which is not an
// error — it falls straight through to the emitter's generic palette, so that
// creature explodes anonymously and nothing anywhere reports it.
// ---------------------------------------------------------------------------
const MAIN = fs.readFileSync(path.join(HERE, '../path/src/main.js'), 'utf8');
const killCall = /function onEnemyKilledFeedback[\s\S]*?\n}/.exec(MAIN)?.[0] ?? '';
// THE ONE BODY THAT IS NOT ITS OWN COLOUR WHEN IT DIES is a frozen one: it
// shatters into ice (CONFIG.feedback.killFrozen, systems/statusFx.js), and ice
// is the ice's colour whatever the animal was — a creature tint over the
// splinters would turn the shatter lime or purple. The regex admits exactly
// that branch and nothing else: the resolver is still assetBaseColor, the
// guard is still the one word `frozen`.
check('the kill feedback passes a colour', /color:\s*(?:frozen \? undefined : \()?assetBaseColor\(/.test(killCall));
check('...and only a body that died as ice is exempt',
  /const frozen = isFrozen\(e\)/.test(killCall) && /killFrozen/.test(killCall));

// THE SECOND EXCEPTION, and there are exactly two.
//
// A boss hit is the other place a burst's colour is information rather than
// decoration: the mark left on the skin says WHAT is landing — venom, ice,
// shock, a plain shot — and a fixed palette there would be a readout that
// reports the same answer whatever the player built. Same shape of argument as
// the death's, and it earns the same exemption.
//
// Held to the ONE call, though, and to the resolver behind it: `color:` in
// spawnBossImpact's own emit, fed from damageSourceColor in main.js. Anything
// else tinting a burst is still the rainbow this whole block exists to keep out.
const IMPACT = fs.readFileSync(path.join(HERE, '../path/src/systems/bossImpact.js'), 'utf8');
check('the boss hit mark passes the damage source colour',
  /emit\('bossHitGoo'[\s\S]{0,400}?color:\s*opts\.color/.test(IMPACT));
check('...resolved from what actually did the damage',
  /function damageSourceColor[\s\S]*?elementColor\(/.test(MAIN)
  && /spawnBossImpact\([\s\S]{0,200}?color:\s*damageSourceColor\(/.test(MAIN));

// A PICKUP GOING DOWN is the third case, and it is the same argument twice
// over. There is ONE burst emitter for every pickup in the game
// (CONFIG.emitters.pickupGoo) precisely so that what separates a breath of air
// from a strike orb from a coral is the colour of the thing you just ate — so
// the colour is the readout, and a fixed palette there would say the same
// thing every time. A per-pickup emitter with its own hardcoded colours is the
// alternative, and it is strictly worse: four copies of a tint that go stale
// the moment anyone re-skins a pickup.
//
// The three SWALLOWS resolve through assetBaseColor, which is the same
// sanctioned resolver the kill uses and is already exempt below. Two pickups
// are the odd ones out, each for its own reason, and each is held to its own
// event AND its own source so that a hardcoded tint would still fail this:
//
//   THE CLAM   is not built by createVisual and reads none of the Look panel,
//              so both its moments (the drop and the grab) take their colour
//              from its own tuned block.
//   THE BLOB   has no base colour to resolve. It is a different colour four
//              times a bar (see systems/levelOrb.js), so assetBaseColor would
//              hand back a tint the object has not worn since the last note —
//              the one frame of the whole effect that was off the beat. It
//              reports what it is wearing instead, through levelOrbColor.
const BOATS = fs.readFileSync(path.join(HERE, '../path/src/systems/boats.js'), 'utf8');
check('the clam announces itself in its own tuned colour',
  /feedback\('clamDrop'[\s\S]{0,300}?color:\s*CONFIG\.attractorOrb\.look\?\.waveColorNear/.test(BOATS));
check('...and so does the grab',
  /feedback\('clamGrab'[\s\S]{0,300}?color:\s*CONFIG\.attractorOrb\.look\?\.waveColorNear/.test(BOATS));
// COUNTED AGAINST THE CALLS THAT EXIST, not against a number. There were three
// swallows when this was written and there are four now — the trap bubble pays
// air the same way the loose bubble does — so a hardcoded 3 failed on a fourth
// one that was doing exactly the right thing. What has to hold is that every
// call naming one of these events resolves its colour off the asset.
{
  const swallows = (MAIN.match(/feedback\('(?:bubblePop|strikeOrbTaken|coralTaken)'/g) || []).length;
  const resolved = (MAIN.match(/feedback\('(?:bubblePop|strikeOrbTaken|coralTaken)'[\s\S]{0,300}?color:\s*assetBaseColor\(/g) || []).length;
  check('...and every swallow resolves its colour off the asset',
    swallows >= 3 && resolved === swallows, `${resolved} of ${swallows} swallows`);
}
check('...and the blob reports the colour it is actually wearing',
  /feedback\('levelOrbTaken'[\s\S]{0,400}?color:\s*levelOrbColor\(/.test(MAIN));
//   THE WEAK SPOT'S MEAT is the third odd one out, and it is the blob's reason
//              again: the piece is drawn with the chumChunk asset but is
//              deliberately NOT wearing that asset's colour — it pays boost
//              pips rather than health and wears the fuel tint to say so (see
//              CONFIG.hotSpots.chum.tint), so assetBaseColor would hand back
//              the meat's red-to-amber and undo the one tell that separates
//              the two pickups. It reports the colour it was spawned with.
check('...and a piece off a weak spot reports the fuel tint it was spawned with',
  /feedback\('hotSpotChumTaken'[\s\S]{0,400}?color:\s*chunk\.base/.test(MAIN));

// Every other feedback() call in the game must NOT. Comments are allowed to
// discuss it; code isn't.
const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const srcFiles = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.js')) srcFiles.push(p);
  }
})(path.join(HERE, '../path/src'));

// Balanced-paren scan rather than a regex. A non-greedy match to the next `})`
// runs straight past the end of a one-line `feedback('uiHover')` and swallows
// whatever function follows it, so ui.js reported a tint it does not have.
const callArgs = (code, fnName) => {
  const out = [];
  const re = new RegExp(`\\b${fnName}\\(`, 'g');
  for (const m of code.matchAll(re)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < code.length; i++) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { out.push(code.slice(m.index + m[0].length, i)); break; }
      }
    }
  }
  return out;
};

const strayTints = [];
for (const file of srcFiles) {
  const code = strip(fs.readFileSync(file, 'utf8'));
  for (const args of [...callArgs(code, 'feedback'), ...callArgs(code, 'emit')]) {
    if (!/\bcolor:/.test(args)) continue;
    if (file.endsWith('main.js') && /assetBaseColor\(/.test(args)) continue; // the kill, and the three swallows
    // The clam's two moments, checked properly above. Matched on the EVENT the
    // call actually names — `args` opens with it — and on the source of the
    // colour, rather than on the file: boats.js is not a blanket exemption, so
    // a third tinted burst added there is still a failure.
    if (/^\s*'clam(?:Drop|Grab)'/.test(args)
      && /\bcolor:\s*CONFIG\.attractorOrb\.look\?\.waveColorNear/.test(args)) continue;
    // The boss hit mark, checked properly above. Matched on the emitter name
    // rather than on the file, so bossImpact.js is not a blanket exemption —
    // a second tinted burst added there is still a failure.
    if (/emit\(\s*'bossHitGoo'/.test(`emit('bossHitGoo'${args}`) && /\bcolor:\s*opts\.color/.test(args)) continue;
    // The level blob's swallow, checked properly above. Same shape as the
    // clam's exemption and for the same reason: matched on the EVENT and on
    // the SOURCE of the colour, so main.js is not widened by it and a second
    // hand-tinted burst there is still a failure.
    if (/^\s*'levelOrbTaken'/.test(args) && /\bcolor:\s*levelOrbColor\(/.test(args)) continue;
    // The weak spot's meat, checked properly above. Same shape again — the
    // EVENT and the SOURCE, so main.js is not widened and a hand-typed hex
    // here would still fail.
    if (/^\s*'hotSpotChumTaken'/.test(args) && /\bcolor:\s*chunk\.base\b/.test(args)) continue;
    // THE MUZZLE FLASH, which is the fourth odd one out and the first that is
    // not a pickup. The palette rule this check enforces — a burst's colour says
    // what KIND of event it was — is not being broken here so much as taken
    // literally: Flippers Up! can put a different element on each flipper, so
    // two flashes in the same volley genuinely ARE different kinds of event, and
    // one stock blue for both would be the burst lying about which fin threw
    // what. It is also the only way the muzzle can agree with the pellet and the
    // ribbon leaving it, which elementFlightParticles has always tinted.
    //
    // Held to the EVENT and the SOURCE like the four above, so main.js and the
    // muzzle emitter are not widened by it: a hand-typed hex on either call is
    // still a failure, and so is a tint on any other burst in either file.
    // THE EVENT IS CHOSEN NOW. main.js fires `laser ? 'shootLaser' : 'shoot'`,
    // so an anchor on a literal opening quote stopped matching and the shot
    // that has always been exempt here started reading as a stray tint. Match
    // the pair as well as the bare name; the SOURCE half of the rule is
    // unchanged, so a hand-typed hex on either branch still fails.
    if (/^\s*(?:'shoot'|[\w.]+\s*\?\s*'shootLaser'\s*:\s*'shoot')/.test(args)
      && /\bcolor:\s*lead \? flashColor\(/.test(args)) continue;
    if (/^\s*'muzzle'/.test(args) && /\bcolor:\s*flashColor\(/.test(args)) continue;
    // THE BOSS GOING UP, which is the fifth odd one out and the muzzle's
    // argument again. The cloud is the BOSS'S OWN colour (b.color, off the
    // corpse) lerped toward white for the hot core, so the burst is saying
    // which animal just came apart — a stock tint would be the one thing on
    // screen at that moment that disagreed with the body it came out of. The
    // white-hot mix has to be in the colour rather than the glow because emit()
    // lifts a dark tint clear of the water before it uses it; see the note at
    // firePuff. Held to the EVENT and the SOURCE, so bossBoom.js is not a
    // blanket exemption and a hand-typed hex there is still a failure.
    if (/^\s*'bossBoom'/.test(args) && /\bcolor:\s*_col\.getHex\(\)/.test(args)) continue;
    // THE BOLT COMING APART, which is the same argument once more: a lattice
    // split is the element that threw it breaking up, so the pieces have to be
    // that element's colour or the burst disagrees with the bolt it came from.
    // `boltColor(b.finElement)` is the shared resolver every other element
    // effect reads, not a hex — held to the EVENT and the SOURCE like the rest.
    if (/^\s*'latticeSplit'/.test(args) && /\bcolor:\s*boltColor\(/.test(args)) continue;
    strayTints.push(`${path.relative(path.join(HERE, '..'), file)}: ${args.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
}
check('and no other burst in the game passes one', strayTints.length === 0,
  strayTints.length ? [...new Set(strayTints)].join(', ') : `${srcFiles.length} source files`);

// The colour it passes must exist for every creature that can die. Both spawn
// routes: `asset`, and the `assets` LIST a variant rolls one entry out of.
const rosterKeys = new Set();
for (const def of Object.values(CONFIG.enemies ?? {})) {
  if (Array.isArray(def?.assets)) for (const k of def.assets) { if (k) rosterKeys.add(k); }
  else if (def?.asset) rosterKeys.add(def.asset);
}
const colourless = [...rosterKeys].filter((k) => assetBaseColor(k) == null);
check('every creature in the roster has one', colourless.length === 0,
  colourless.length ? colourless.join(', ') : `${rosterKeys.size} asset keys`);

// And it must not collapse to one hue across the roster — if it did, the tint
// would be carrying no information and the palette would have been simpler.
const hues = new Set([...rosterKeys].map((k) => assetBaseColor(k)).filter((c) => c != null));
check('and they are not all the same colour', hues.size > 1, `${hues.size} distinct colours`);

// ---------------------------------------------------------------------------
// ...AND VISIBLE. Roughly a third of the roster is near-black (abyss shark,
// boss crab, ember crab, the squids). Fired literally those deaths are
// invisible over dark water, so the tint gets a brightness floor — the failure
// this catches is a burst that is correctly the creature's colour and still
// cannot be seen, which no colour assertion above would notice.
// ---------------------------------------------------------------------------
const floor = CONFIG.fx?.deathTintMinPeak ?? 0;
check('the death tint has a brightness floor', floor > 0, `deathTintMinPeak ${floor}`);

const DARKEST = [...rosterKeys]
  .map((k) => ({ k, c: new THREE.Color(assetBaseColor(k) ?? 0) }))
  .sort((a, b) => Math.max(a.c.r, a.c.g, a.c.b) - Math.max(b.c.r, b.c.g, b.c.b))[0];

resetParticles();
const darkBurst = burst('explosion', 0, -10, { color: assetBaseColor(DARKEST.k), glow: 1 });
// Against the emitter's own glow, so this is "as bright as an ordinary burst",
// not an absolute that a tuning change to the overdrive would move.
const emitterGlow = (CONFIG.emitters.explosion.glow ?? 1) * (CONFIG.bloom?.particleOverdrive ?? 1);
let darkestPeak = Infinity;
for (const i of darkBurst) {
  darkestPeak = Math.min(darkestPeak, Math.max(
    A.aColor.array[i * 3], A.aColor.array[i * 3 + 1], A.aColor.array[i * 3 + 2],
  ) / emitterGlow);
}
// 0.65 is the bottom of the per-particle scatter, so even the dimmest particle
// of the darkest creature's death clears floor * 0.65.
check('the darkest creature still explodes visibly', darkestPeak >= floor * 0.65 - 1e-3,
  `${DARKEST.k} #${(assetBaseColor(DARKEST.k) >>> 0).toString(16).padStart(6, '0')} -> dimmest peak ${darkestPeak.toFixed(2)}`);

// The lift must not have bleached the hue on the way up — that is the whole
// reason it scales on the peak channel rather than on luminance.
const darkNorm = (() => {
  const c = new THREE.Color(assetBaseColor(DARKEST.k));
  const peak = Math.max(c.r, c.g, c.b);
  return [c.r / peak, c.g / peak, c.b / peak];
})();
let lifted = 0;
for (const i of darkBurst) {
  const n = norm(i);
  if (n.some((v, k) => Math.abs(v - darkNorm[k]) > 1e-3)) lifted++;
}
check('and its hue survived the lift', lifted === 0, `${darkBurst.length} particles, ${lifted} shifted`);

// ===========================================================================
// PEARL BURSTS ARE WHITE
// ===========================================================================
section('Pearl bursts');

check('pearlBurst exists as its own emitter', !!CONFIG.emitters.pearlBurst);
check(
  'its palette is white only',
  (CONFIG.emitters.pearlBurst?.colors ?? []).every((c) => c === 0xffffff),
  JSON.stringify(CONFIG.emitters.pearlBurst?.colors),
);
check('the bomblet event fires it', CONFIG.feedback.pearlBurst?.emit === 'pearlBurst',
  `feedback.pearlBurst.emit = ${CONFIG.feedback.pearlBurst?.emit}`);

resetParticles();
const pearl = burst('pearlBurst', 0, -10);
let nonWhite = 0;
let dimmest = Infinity;
for (const i of pearl) {
  const [r, g, b] = [A.aColor.array[i * 3], A.aColor.array[i * 3 + 1], A.aColor.array[i * 3 + 2]];
  if (Math.abs(r - g) > 1e-4 || Math.abs(g - b) > 1e-4) nonWhite++;
  dimmest = Math.min(dimmest, r);
}
check('every particle is neutral white', nonWhite === 0, `${pearl.length} particles, ${nonWhite} tinted`);
// Glowing, not merely white: the burst has no palette depth, so the overdrive
// past 1.0 is the only thing making it bloom.
check('and driven past white so it glows', dimmest > 1, `dimmest channel ${dimmest.toFixed(2)}`);

// ===========================================================================
// THE CURRENT — the two copies of the field
// ===========================================================================
section('Turbulence: GLSL and JS agree');

// Both copies are sums of sines over the two axes. Comparing the numbers in
// each, in order, catches the realistic drift: someone retunes one harmonic
// and doesn't touch the other copy.
function constantsOf(re) {
  const body = SRC.match(re)?.[1];
  return body ? (body.match(/\d+\.\d+/g) ?? []).map(Number) : null;
}
const glslConsts = constantsOf(/const TURBULENCE_GLSL = \/\* glsl \*\/ `([\s\S]*?)`;/);
const jsConsts = constantsOf(/export function turbulenceAt\(x, y, t\) \{([\s\S]*?)\n\}/);
check('both copies were found in the source', !!glslConsts && !!jsConsts,
  `glsl ${glslConsts?.length} constants, js ${jsConsts?.length}`);
check('their constants match exactly',
  JSON.stringify(glslConsts) === JSON.stringify(jsConsts),
  `${JSON.stringify(glslConsts)} vs ${JSON.stringify(jsConsts)}`);

// Divergence-free is the property that makes it read as liquid rather than as
// noise: each component may depend only on the OTHER axis, so d(fx)/dx and
// d(fy)/dy are both zero and the field can only swirl, never compress.
let maxDiv = 0;
for (let i = 0; i < 200; i++) {
  const x = (Math.random() - 0.5) * 60;
  const y = (Math.random() - 0.5) * 60;
  const t = Math.random() * 10;
  const h = 1e-4;
  const dfx = (turbulenceAt(x + h, y, t)[0] - turbulenceAt(x - h, y, t)[0]) / (2 * h);
  const dfy = (turbulenceAt(x, y + h, t)[1] - turbulenceAt(x, y - h, t)[1]) / (2 * h);
  maxDiv = Math.max(maxDiv, Math.abs(dfx + dfy));
}
check('the field is divergence-free', maxDiv < 1e-6, `max |div| ${maxDiv.toExponential(1)}`);

// It has to actually move things, or none of the above matters.
const tb = CONFIG.fx.turbulence;
check('turbulence is on', tb?.enabled !== false && (tb?.strength ?? 0) > 0,
  `strength ${tb?.strength}, frequency ${tb?.frequency}, timeScale ${tb?.timeScale}`);

resetParticles();
const explo = burst('explosion', 0, -10);
const turbAttr = explo.map((i) => A.aTurb.array[i]);
check('explosion particles carry it', turbAttr.every((v) => v > 0), `aTurb = ${turbAttr[0]}`);
check('the shader applies it', /turbulenceAt\(pos\.xy \* uTurb\.y/.test(SRC));

// ===========================================================================
// DRAG SPREAD
// ===========================================================================
section('Drag: every particle its own');

const drags = explo.map((i) => A.aDrag.array[i]);
const dMin = Math.min(...drags);
const dMax = Math.max(...drags);
const base = CONFIG.emitters.explosion.drag ?? 2;
const vary = CONFIG.fx.turbulence?.dragVary ?? 0;
check('the burst is not one rigid shell', dMax - dMin > 1e-6,
  `${drags.length} particles across ${dMin.toFixed(2)}..${dMax.toFixed(2)} (base ${base})`);
check('and stays inside the configured spread',
  dMin >= base * (1 - vary) - 1e-6 && dMax <= base * (1 + vary) + 1e-6,
  `allowed ${(base * (1 - vary)).toFixed(2)}..${(base * (1 + vary)).toFixed(2)}`);
check('nothing gets a drag of zero', dMin > 0, `min ${dMin.toFixed(3)}`);

// ===========================================================================
// THE SURFACE
// ===========================================================================
section('Bubbles die at the water line');

check('the shader clips against the surface', /alive \*= 1\.0 - aClip \* step\(surfaceHeightAt\(pos\.x\), pos\.y\)/.test(SRC));

resetParticles();
setWaveTime(0);
sea.amp = CONFIG.arena.waveAmplitude;
sea.chop = 0;

// Far more bubbles than the CPU tracker will follow (its cap is 256), which is
// the whole point: the ones it drops must still be flagged.
const bubbles = [];
for (let i = 0; i < 400; i++) {
  const x = (Math.random() - 0.5) * 40;
  bubbles.push(...burst('breathBubbles', x, -6, { dirX: 0, dirY: 1 }));
}
const flagged = bubbles.filter((i) => A.aClip.array[i] === 1).length;
check('every bubble born underwater is flagged', flagged === bubbles.length,
  `${flagged}/${bubbles.length} — tracker cap is irrelevant to this`);

// Born in the air on a breach: nothing above it to burst against, so it must
// NOT be flagged or it would be deleted on its first frame.
resetParticles();
const airborne = burst('breathBubbles', 0, bounds.surfaceY + 3, { dirX: 0, dirY: 1 });
check('a mid-breach puff above the water is not',
  airborne.every((i) => A.aClip.array[i] === 0), `${airborne.length} particles`);

// Now run one underwater bubble out over its whole life and solve it the way
// the shader does. It has to break the surface (or the emitter is not one that
// rises) and it must not be drawn for a single frame once it has.
resetParticles();
const one = burst('breathBubbles', 0, -3, { dirX: 0, dirY: 1 });

function solve(i, clock) {
  const age = clock - A.aStart.array[i];
  const life = A.aLife.array[i];
  if (age < 0 || age > life) return null; // expired on its own timer
  const k = Math.max(A.aDrag.array[i], 0.0001);
  const f = (1 - Math.exp(-k * age)) / k;
  let x = A.position.array[i * 3] + A.aVelocity.array[i * 3] * f + 0.5 * A.aGravity.array[i * 2] * age * age;
  let y = A.position.array[i * 3 + 1] + A.aVelocity.array[i * 3 + 1] * f + 0.5 * A.aGravity.array[i * 2 + 1] * age * age;
  const t = CONFIG.fx.turbulence;
  if (t?.enabled !== false && A.aTurb.array[i]) {
    const [tx, ty] = turbulenceAt(x * t.frequency, y * t.frequency, clock * t.timeScale);
    const amt = t.strength * A.aTurb.array[i] * age;
    x += tx * amt;
    y += ty * amt;
  }
  // The clip, mirroring the GLSL asserted above.
  if (A.aClip.array[i] === 1 && y >= surfaceHeightAt(x)) return null;
  return { x, y };
}

let everBroke = false;
let drawnAboveWater = 0;
let clock = 0;
for (let step = 0; step < 400; step++) {
  updateParticles(1 / 60);
  clock += 1 / 60;
  for (const i of one) {
    const p = solve(i, clock);
    if (!p) continue;
    if (p.y > surfaceHeightAt(p.x)) drawnAboveWater++;
    // Un-clipped, the same particle would have kept rising past the line.
    const age = clock - A.aStart.array[i];
    if (A.aStart.array[i] > -1e8 && age > 0) {
      const k = Math.max(A.aDrag.array[i], 0.0001);
      const f = (1 - Math.exp(-k * age)) / k;
      const rawY = A.position.array[i * 3 + 1] + A.aVelocity.array[i * 3 + 1] * f
        + 0.5 * A.aGravity.array[i * 2 + 1] * age * age;
      if (rawY >= surfaceHeightAt(p.x)) everBroke = true;
    }
  }
}
check('a breath bubble does reach the surface', everBroke, 'otherwise the clip proves nothing');
check('and is never drawn above it', drawnAboveWater === 0, `${drawnAboveWater} frames above the water line`);

// The tracker's job — the little burst left behind. This runs deep into the
// harness on purpose, with the particle clock well away from zero: the tracker
// identifies a slot by its spawn time, and comparing a double against the
// float32 the attribute actually holds is unequal for almost every clock value
// that isn't 0. A fresh clock passes that bug; this doesn't.
resetParticles();
const popped = burst('breathBubbles', 0, -1.5, { dirX: 0, dirY: 1 });
const beforePop = popped.filter((i) => A.aStart.array[i] > -1e8).length;
for (let step = 0; step < 240; step++) updateParticles(1 / 60);
const killed = popped.filter((i) => A.aStart.array[i] <= -1e8).length;
check('the tracker kills the slot when a bubble pops', killed > 0,
  `${killed}/${beforePop} bubbles burst at the line`);
check('bubble emitters name a burst to leave behind',
  !!CONFIG.emitters.breathBubbles.surfacePop && !!CONFIG.emitters.wakeBubbles.surfacePop);

// ===========================================================================
// THE GLOBAL THINNING KNOB
// ===========================================================================
// CONFIG.fx.spriteDensity scales every SPRITE burst in the game and leaves the
// goo emitters alone. Both halves of that need a test, and the second half is
// the one that matters: the goo counts are single digits, so a multiplier that
// leaked onto them would drop a lobe or two out of a mass and the isoline would
// come apart — a look someone would read as a goo bug, not as a density
// setting, and go tuning `radius` and `iso` to chase.
//
// Every emitter is fired, because this is a rule about ALL of them, and a new
// emitter is exactly the thing that quietly gets it wrong.
section('Sprite density: one knob over the sprites, none over the goo');

const DENSITY = CONFIG.fx.spriteDensity ?? 1;
const gooGroupKeys = Object.keys(CONFIG.fx.goo?.groups ?? {});
// The same resolution emit() does: `goo: true` means the first group, and a
// name that is not a group at all falls through to a sprite burst.
const gooGroupOf = (def) => {
  if (!def.goo || !CONFIG.fx.goo?.enabled) return null;
  const want = def.goo === true ? gooGroupKeys[0] : def.goo;
  return gooGroupKeys.includes(want) ? want : null;
};

const wrongCount = [];
const thinned = [];
let fullStrength = 0;
for (const [name, def] of Object.entries(CONFIG.emitters)) {
  resetParticles();
  const got = burst(name, 0, -10).length;
  const isGoo = gooGroupOf(def) !== null;
  const want = Math.max(1, Math.round((def.count ?? 8) * (isGoo ? 1 : DENSITY)));
  if (got !== want) wrongCount.push(`${name} ${got} != ${want}`);
  if (isGoo) fullStrength++;
  // The floor is what a one- or two-particle emitter hits, and it is meant to:
  // an event that fires is an event you can see. Only the ones above it can be
  // expected to have actually come down.
  else if (want < (def.count ?? 8)) thinned.push(name);
}

check('every burst is its count times the knob', wrongCount.length === 0,
  wrongCount.length ? wrongCount.slice(0, 4).join(', ') : `${Object.keys(CONFIG.emitters).length} emitters`);
check('the goo emitters are at full strength', fullStrength > 0 && gooGroupKeys.length > 0,
  `${fullStrength} goo emitters across ${gooGroupKeys.length} groups`);
// If the knob is at 1 there is nothing to thin, and this says so rather than
// failing — the invariant above is the real test, this is the reality check
// that the setting is doing something.
check(DENSITY < 1 ? 'and the sprites are thinner than authored' : 'the knob is at full (nothing thinned)',
  DENSITY < 1 ? thinned.length > 0 : thinned.length === 0,
  `spriteDensity ${DENSITY} — ${thinned.length} emitters below their authored count`);
// A burst is allowed to be sparse and never allowed to vanish.
check('and no emitter was thinned out of existence',
  Object.keys(CONFIG.emitters).every((n) => { resetParticles(); return burst(n, 0, -10).length >= 1; }),
  `${Object.keys(CONFIG.emitters).length} emitters still emit`);

// ===========================================================================
// UPLOADS: only the slots that changed
// ===========================================================================
//
// A bare `needsUpdate` makes three re-send the entire attribute — ~530KB across
// these ten buffers at the shipped capacity, in every frame anything was
// emitted. emit() writes a contiguous run, so it declares one.
//
// The failure this guards is silent in the worst way: ranges are measured in
// ARRAY ELEMENTS, so a vec3 attribute given vertex indices uploads the first
// third of the burst and leaves the rest holding whatever the previous owner of
// those slots wrote. Nothing throws; particles just appear in last burst's
// positions. So the check is coverage of the exact indices written, per
// attribute, at each attribute's own item size.
section('Uploads: only the slots that changed');

// Union of an attribute's declared ranges, as a set of array elements.
function covered(attr) {
  const set = new Set();
  for (const r of attr.updateRanges) for (let i = r.start; i < r.start + r.count; i++) set.add(i);
  return set;
}

function clearRanges() {
  for (const a of Object.values(A)) a.clearUpdateRanges();
}

resetParticles();
clearRanges();
const wrote = burst('explosion', 3, -4);
let mismatched = [];
for (const [name, attr] of Object.entries(A)) {
  const cov = covered(attr);
  for (const slot of wrote) {
    for (let k = 0; k < attr.itemSize; k++) {
      if (!cov.has(slot * attr.itemSize + k)) { mismatched.push(`${name}[${slot}.${k}]`); break; }
    }
  }
}
check('every written element is inside a declared range', mismatched.length === 0,
  mismatched.length ? `missed ${mismatched.slice(0, 4).join(', ')}` : `${wrote.length} slots x 10 attributes`);

// And that it is a RANGE, not the whole buffer dressed up as one — the entire
// point is not re-sending 8000 slots to change 46.
const posCovered = covered(A.position).size;
check('and the range is the burst, not the buffer',
  posCovered < A.position.array.length / 4,
  `${posCovered} of ${A.position.array.length} floats`);

// THE WRAP. The ring buffer hands out slots modulo capacity, so a burst that
// starts near the end straddles the join and needs two ranges. One range from
// `start` to `start + count` would run off the end of the buffer — three
// happily uploads a short read there, and the particles that wrapped never get
// their data.
resetParticles();
const capacity = A.aStart.count;
// Park the cursor a known distance from the end. emit() advances it by exactly
// round(def.count * scale * spriteDensity) per call, so the walk is arithmetic
// rather than a search — and `scale` is how the count is set, since both the
// emitter's own count and the global thinning multiplier are tuned numbers this
// test has no business depending on. Divide by BOTH: dividing by the count
// alone asks for a hundred particles and gets sixty, and the walk then parks
// the cursor somewhere that never straddles the join — a green test for a
// buffer wrap that was never exercised.
const per = (n) => n / (CONFIG.emitters.explosion.count * (CONFIG.fx.spriteDensity ?? 1));
const STRIDE = 100;
for (let i = 0; i < Math.floor((capacity - 50) / STRIDE); i++) emit('explosion', 0, -4, { scale: per(STRIDE) });
emit('explosion', 0, -4, { scale: per((capacity - 50) % STRIDE) }); // now exactly 50 from the end
clearRanges();
emit('explosion', 0, -4, { scale: per(STRIDE) }); // 50 slots at the end, 50 at the start
const wrapped = A.position.updateRanges.length;
check('a burst that straddles the join declares two ranges', wrapped === 2,
  `${wrapped} range(s)`);
const wrapCov = covered(A.position);
let wrapOk = true;
for (const r of A.position.updateRanges) {
  if (r.start < 0 || r.start + r.count > A.position.array.length) wrapOk = false;
}
check('and neither range runs off the end of the buffer', wrapOk,
  `${A.position.updateRanges.map((r) => `${r.start}+${r.count}`).join(' ')} of ${A.position.array.length}`);
check('the two together still cover the whole burst', wrapCov.size === STRIDE * 3,
  `${wrapCov.size / 3} of ${STRIDE} slots`);

// A wipe has to survive an emit landing after it. resetParticles runs from the
// start/restart handler, outside the frame loop, and the next frame emits
// immediately — so by upload time the attribute is carrying that burst's range
// too. Declared as a whole-buffer range, three merges the two and still sends
// everything; cleared instead, the burst's range would win and the previous
// run's particles would come back to life.
resetParticles();
burst('muzzle', 0, 0);
const startCov = covered(A.aStart);
check('a reset still uploads the whole buffer when an emit follows it',
  startCov.size === A.aStart.array.length,
  `${startCov.size} of ${A.aStart.array.length} floats`);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}`);
// ---------------------------------------------------------------------------
section('THE LIVE COUNT IS A LOAD, NOT A HIGH-WATER MARK');
// ---------------------------------------------------------------------------
// This is the crash trail's only view of how much the particle system is
// doing, and it was reporting the ring buffer's capacity rather than the load:
// `Math.min(cursor, capacity)` over a write head that only climbs, so it read
// the cap from the first wrap onward and never came down. Every tick of every
// run on the phone said `8000p`, which looked like a system pinned at its
// ceiling and was really a counter that had stopped being able to say anything.
//
// The check that matters is that it can COME DOWN. A saturating counter passes
// any test that only emits and looks for a big number.
{
  resetParticles();
  const cap = particleCapacity();
  check('an empty system reports nothing alive', particleCount(0) === 0, `${particleCount(0)}`);

  // Enough bursts to wrap the ring at least once — the exact condition that
  // used to pin the old counter at capacity forever.
  // `burst` above returns the slots an emit actually wrote, so the emitter
  // name is verified rather than assumed — a name the config does not carry
  // writes nothing and would make the count below trivially zero.
  const names = Object.keys(CONFIG.emitters);
  let wrote = 0;
  for (let i = 0; i < 40; i++) wrote += burst(names[i % names.length], 0, -2).length;
  check('the bursts actually wrote slots', wrote > 0, `${wrote} slots`);
  const alive = particleCount();
  check('a burst is counted while it lives', alive > 0, `${alive} alive of ${wrote} written`);
  check('...and never more than the ring holds', alive <= cap, `${alive} of ${cap}`);

  // The whole point: run the clock past every particle's life and the number
  // must fall to nothing. The old implementation returned `cap` here.
  const late = particleCount(1e6);
  check('...and falls back to zero once they have all expired', late === 0,
    `${late} still counted a million seconds later`);
  check('...which the old high-water version could not do', late !== cap,
    `${late} vs a capacity of ${cap}`);
  resetParticles();
}

// ---------------------------------------------------------------------------
section('PARTICLE RELIEF FOLLOWS THE ADAPTIVE CONTROLLER');
// ---------------------------------------------------------------------------
// The renderer is fill-bound and particles are what frame time correlated with
// on the phone (-0.57, against -0.21 for enemies). So the adaptive controller
// that already gives back pixels gives back particles too — and the two things
// that must hold are that a machine keeping up pays NOTHING, and that goo is
// left alone on both axes.
{
  const sizesOf = (idx) => idx.map((i) => A.aSize.array[i]);
  const spriteName = Object.keys(CONFIG.emitters).find((n) => !CONFIG.emitters[n].goo);
  const gooName = Object.keys(CONFIG.emitters).find((n) => CONFIG.emitters[n].goo);

  setParticleRelief(1);
  resetParticles();
  const fullIdx = burst(spriteName, 0, -2);
  const fullSize = sizesOf(fullIdx).reduce((a, b) => a + b, 0) / Math.max(1, fullIdx.length);

  // A machine at 1.0 must be bit-for-bit what it was before any of this
  // existed — the relief multiplies by exactly one there.
  setParticleRelief(1);
  resetParticles();
  const againIdx = burst(spriteName, 0, -2);
  check('relief 1.0 changes the count not at all', againIdx.length === fullIdx.length,
    `${againIdx.length} vs ${fullIdx.length}`);

  // At the resolution floor the burst is thinner and smaller, and BOTH move —
  // fill is count x area, so taking a little of each beats taking a lot of one.
  setParticleRelief(0.4);
  resetParticles();
  const lowIdx = burst(spriteName, 0, -2);
  const lowSize = sizesOf(lowIdx).reduce((a, b) => a + b, 0) / Math.max(1, lowIdx.length);
  check('under relief the sprite burst is thinner', lowIdx.length < fullIdx.length,
    `${lowIdx.length} vs ${fullIdx.length}`);
  check('...and its particles are smaller', lowSize < fullSize,
    `${lowSize.toFixed(3)} vs ${fullSize.toFixed(3)}`);
  // Thinning may make a burst sparse, never delete it.
  check('...but the burst still happens', lowIdx.length >= 1, `${lowIdx.length}`);

  // GOO IS EXEMPT ON BOTH AXES. A goo particle is a lobe of a mass: thinning
  // opens holes in the isoline and shrinking breaks the fusion between
  // neighbours, so relief here would read as the metaball shader being broken.
  if (gooName) {
    // SEEDED, because `rand(def.size, 0.15)` varies per particle: two
    // unseeded bursts differ whether or not relief touched them, and the
    // comparison would be of two random draws rather than of the multiplier.
    const realRandom = Math.random;
    const seeded = (n) => () => (n = (n * 1664525 + 1013904223) >>> 0) / 4294967296;

    Math.random = seeded(0x9E3779B9);
    setParticleRelief(1);
    resetParticles();
    const gFull = burst(gooName, 0, -2);
    const gFullSize = sizesOf(gFull).reduce((a, b) => a + b, 0) / Math.max(1, gFull.length);

    Math.random = seeded(0x9E3779B9);
    setParticleRelief(0.4);
    resetParticles();
    const gLow = burst(gooName, 0, -2);
    const gLowSize = sizesOf(gLow).reduce((a, b) => a + b, 0) / Math.max(1, gLow.length);
    Math.random = realRandom;
    check('goo keeps every lobe under relief', gLow.length === gFull.length,
      `${gLow.length} vs ${gFull.length}`);
    check('...at full size, so the isoline still fuses',
      Math.abs(gLowSize - gFullSize) < 1e-6, `${gLowSize.toFixed(3)} vs ${gFullSize.toFixed(3)}`);
  }
  setParticleRelief(1);
  resetParticles();
}

process.exit(failures ? 1 : 0);