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
check('the kill feedback passes a colour', /color:\s*assetBaseColor\(/.test(killCall));

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
    if (file.endsWith('main.js') && /assetBaseColor\(/.test(args)) continue; // the kill
    // The boss hit mark, checked properly above. Matched on the emitter name
    // rather than on the file, so bossImpact.js is not a blanket exemption —
    // a second tinted burst added there is still a failure.
    if (/emit\(\s*'bossHitGoo'/.test(`emit('bossHitGoo'${args}`) && /\bcolor:\s*opts\.color/.test(args)) continue;
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
// round(def.count * scale) per call, so the walk is arithmetic rather than a
// search — and `scale` is how the count is set, since the emitter's own count
// is a tuned number this test has no business depending on.
const per = (n) => n / CONFIG.emitters.explosion.count;
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
process.exit(failures ? 1 : 0);
