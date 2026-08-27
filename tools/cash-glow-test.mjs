// The yacht's money, glowing on the beat.
//
// Two mechanisms meet on these four assets, and each one fails SILENTLY on its
// own — the roll still flies, still hits, still trails paper, and nobody
// watching a fight can tell which half died:
//
//   THE MATERIAL. `emissiveFromMap` puts the model's own base-colour texture in
//   its emissive slot. Three things have to hold at once for that to render:
//   the model must actually ship a texture, the emissive COLOUR must be white
//   (three.js multiplies the map by it, so any tint eats the print — and
//   prepareModel's seeding block sets that colour from the diffuse if nothing
//   got there first), and emissiveIntensity must be non-zero (a lit material is
//   seeded at 0, so a mask with no intensity is a pattern multiplied by
//   nothing — the same trap CONFIG.glow.maskIntensity exists to dodge).
//
//   THE PULSE. systems/emissivePulse.js scales that intensity every frame from
//   the beat grid. It writes a SHARED material, and it deliberately does not
//   own the level — it multiplies whatever resting glow it finds, so the Look
//   panel's slider keeps working. Both halves of that are invisible when
//   broken: a pulse that ignores the grid looks like a pulse, and a pulse that
//   overwrites the slider looks like a slider that does not save.
//
// Everything below is run through the REAL pipeline — the real .glb, the real
// prepareModel, the real update function — because the one bug this class of
// code ships is a harness that builds its subject by hand and certifies wiring
// the game never uses.
//
//   npm run test:cashglow
import './dom-stub.mjs';
// A textured GLB embeds its images and GLTFLoader decodes them through
// createImageBitmap; without a stub the parse promise never settles and the
// script exits with "unsettled top-level await" and no error at all.
globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { ASSETS, installModel, getAssetMaterials, prepareModel } from '../path/src/assets.js';
import { updateBeatSync, divisionSeconds } from '../path/src/systems/beatSync.js';
import { updateEmissivePulse, pulseLevel } from '../path/src/systems/emissivePulse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};
const section = (name) => console.log(`\n${name}`);

async function parse(file) {
  const buf = readFileSync(resolve(HERE, '../public/models', file));
  const gltf = await new GLTFLoader().parseAsync(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
  );
  return gltf.scene;
}

const firstMaterial = (root) => {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isMesh || o.userData.__isOutline) return;
    found = Array.isArray(o.material) ? o.material[0] : o.material;
  });
  return found;
};

// --- the asset defs --------------------------------------------------------
section('THE DEFS — every roll asks for its own art as its glow');

const ROLLS = ['moneyRoll1', 'moneyRoll2', 'moneyRoll3', 'moneyRoll4'];
for (const key of ROLLS) {
  const def = ASSETS[key];
  check(`${key}: emissiveFromMap`, def?.emissiveFromMap === true);
  // Without this the map is in the slot and multiplied by zero — configured,
  // rendered, invisible.
  check(`${key}: has a resting emissiveIntensity`, (def?.material?.emissiveIntensity ?? 0) > 0,
    `${def?.material?.emissiveIntensity ?? 0}`);
  // The two mechanisms both own `emissiveMap` and the mask wins, so a roll that
  // ever gains a mask loses its printed glow without a word.
  check(`${key}: does not also name an emissive mask`, !def?.texture?.emissive);
}

// --- the material ----------------------------------------------------------
section('THE MATERIAL — the real .glb through the real prepareModel');

const scene = await parse('moneyroll1.glb');
check('installModel accepts the roll', installModel('moneyRoll1', scene));
const mat = getAssetMaterials('moneyRoll1')[0];

check('the model ships a base-colour texture', !!mat?.map,
  mat?.map ? 'textured' : 'no map — there is nothing to glow WITH');
check('the emissive map is the model\'s own diffuse', mat?.emissiveMap === mat?.map);
// White, or the print is tinted on its way out. prepareModel's seeding block
// copies the diffuse COLOUR into a black emissive, which is exactly this
// failure — it only stays out of the way because emissiveFromMap ran first.
check('the emissive colour is white', mat?.emissive?.getHex() === 0xffffff,
  `#${(mat?.emissive?.getHex() ?? 0).toString(16).padStart(6, '0')}`);
check('the resting intensity survived to the material',
  mat?.emissiveIntensity === ASSETS.moneyRoll1.material.emissiveIntensity,
  `${mat?.emissiveIntensity}`);
check('the material is lit (a MeshBasic has no emissive slot at all)',
  'emissiveIntensity' in (mat ?? {}) && !mat.isMeshBasicMaterial);

// A MASK WINS THE SLOT. Not a preference — applyEmissiveMode rewrites
// emissiveMap on every flip of CONFIG.glow.emissiveMaps, so a model carrying
// both would render its own art until the first flip and a black slot after.
// Asserted rather than commented, because the two features are configured in
// different places and nothing else would notice them meeting.
{
  const fake = new THREE.Texture();
  const masked = prepareModel(await parse('moneyroll1.glb'), ASSETS.moneyRoll1, [], null, 'test', fake);
  const mm = firstMaterial(masked);
  check('a mask takes the emissive slot and emissiveFromMap stands down',
    mm.userData.__emissiveMask === fake && mm.userData.__emissiveFromMap !== true);
}

// An upload has to move both slots together, or the old print glows through the
// new one. Read off the source: the panel's path needs a live texture loader
// and a DOM, and this is the one line that carries the rule.
{
  const src = readFileSync(resolve(HERE, '../path/src/assets.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function setAssetTexture'), src.indexOf('export function setAssetTexture') + 700);
  check('setAssetTexture moves the emissive map with the base map',
    /__emissiveFromMap\)\s*m\.emissiveMap = m\.map/.test(fn));
}

// --- the curve -------------------------------------------------------------
section('THE CURVE — a flash, not a strobe and not a sawtooth');

const cfg = CONFIG.emissivePulse.moneyRoll1;
{
  const N = 2000;
  let lo = Infinity, hi = -Infinity, peakAt = 0;
  for (let i = 0; i < N; i++) {
    const v = pulseLevel(cfg, i / N);
    if (v < lo) lo = v;
    if (v > hi) { hi = v; peakAt = i / N; }
  }
  check('never leaves [min, max]', lo >= cfg.min - 1e-9 && hi <= cfg.max + 1e-9,
    `${lo.toFixed(3)}..${hi.toFixed(3)} against ${cfg.min}..${cfg.max}`);
  check('the peak lands on the attack point', Math.abs(peakAt - cfg.attack) < 2 / N,
    `peak at ${peakAt.toFixed(3)}, attack ${cfg.attack}`);
  // The trough has to be AT the downbeat and the rise has to happen after it.
  // Eased the obvious way — the raw cycle straight into the curve — the level
  // would sit at max on the downbeat and fall for the whole beat, which is a
  // sawtooth: it snaps rather than hits.
  check('the cycle starts in the trough', Math.abs(pulseLevel(cfg, 0) - cfg.min) < 1e-9,
    pulseLevel(cfg, 0).toFixed(3));
  check('and returns to it', Math.abs(pulseLevel(cfg, 0.9999) - cfg.min) < 1e-3);
  // Below the resting level for most of the beat, above it only around the
  // flash. A pulse whose trough is 1.0 is an object that is simply bright.
  check('the trough is under the resting glow', cfg.min < 1 && cfg.max > 1,
    `${cfg.min}x .. ${cfg.max}x`);
}

// --- the live loop ---------------------------------------------------------
section('THE LOOP — on the grid, and not stealing the glow slider');

const BASE = mat.emissiveIntensity;
const beat = divisionSeconds('1/4');
check('a quarter note is a real length of time', beat > 0.1, `${beat.toFixed(3)}s`);

// Frame the clock forward and read the material back.
const step = (dt) => { updateBeatSync(dt); updateEmissivePulse(dt); return mat.emissiveIntensity; };

{
  const seen = [];
  for (let i = 0; i < 24; i++) seen.push(step(beat / 24));
  const lo = Math.min(...seen), hi = Math.max(...seen);
  check('the glow moves across a beat', hi - lo > BASE * 0.3,
    `${lo.toFixed(3)}..${hi.toFixed(3)}`);
  check('and stays inside base x [min, max]',
    lo >= BASE * cfg.min - 1e-6 && hi <= BASE * cfg.max + 1e-6,
    `against ${(BASE * cfg.min).toFixed(3)}..${(BASE * cfg.max).toFixed(3)}`);
  check('it flares past the resting glow', hi > BASE, `peak ${hi.toFixed(3)} vs resting ${BASE}`);
}

// ON THE GRID, not integrated from dt. Both runs below cover exactly four
// beats; a synced phase is derived from the transport, so what the frames were
// CHOPPED into cannot matter. Integrated instead, an irregular frame pattern
// drifts against a steady one and the flash walks off the beat over a run.
// Both runs are read one identical part-beat PAST the four, so the comparison
// lands mid-flare rather than at the trough — where every phase, right or
// wrong, is briefly worth the same thing.
{
  // IN THE PULSE'S OWN CYCLES, not in beats. Each call spends exactly five
  // cycles: four in whatever frames it was given, one more split around the
  // reading. The two runs are sequential on a transport that only goes
  // forwards, so what lets the second be compared to the first at all is that
  // the first leaves the clock a whole number of CYCLES along — the phase is
  // `transport / cycle`, and five beats of a 1-bar pulse is a beat and a
  // quarter of one, which lands the second run a quarter-cycle out and looks
  // exactly like the drift this is here to catch. `pulseSync` is a picker in
  // the tuner and this row is on '1 bar' today, so the unit has to be read
  // from the row rather than assumed to be the beat it was when this was
  // written.
  const cycle = divisionSeconds(cfg.pulseSync);
  const ragged = (frames) => {
    const total = frames.reduce((s, x) => s + x, 0);
    for (const f of frames) step(cycle * 4 * (f / total));
    const v = step(cycle * 0.137);
    step(cycle * 0.863);
    return v;
  };
  const a = ragged(Array(40).fill(0.1));
  const b = ragged([0.31, 0.02, 0.47, 0.9, 0.63, 0.17, 0.5, 1.0, 0.4]);
  check('four beats of ragged frames land where four steady ones did',
    Math.abs(a - b) < 1e-9, `${a.toFixed(6)} vs ${b.toFixed(6)}`);
  check('...and that reading is mid-flare, not the trough',
    a > BASE * cfg.min * 1.05, `${a.toFixed(3)} vs trough ${(BASE * cfg.min).toFixed(3)}`);
}

// THE GLOW SLIDER STILL MEANS SOMETHING. setAssetGlow writes emissiveIntensity
// straight onto the material; the pulse has to notice that and treat it as the
// new resting level. Without the check it re-reads its own last write as the
// base and the drag is gone on the next frame — a slider that visibly snaps
// back, which is what this whole arrangement of multipliers exists to avoid.
{
  const dragged = BASE * 2;
  mat.emissiveIntensity = dragged;
  const after = step(beat * 0.137);
  check('a glow drag becomes the new resting level',
    after >= dragged * cfg.min - 1e-6 && after <= dragged * cfg.max + 1e-6
    && after > BASE * cfg.max,
    `${after.toFixed(3)} against dragged base ${dragged}`);
  mat.emissiveIntensity = BASE;
  step(beat * 0.011);
}

// Switched off, it hands the material back rather than freezing it wherever the
// last frame happened to leave it.
{
  CONFIG.emissivePulse.enabled = false;
  const off = step(beat * 0.29);
  check('disabling restores the resting glow exactly', off === BASE, `${off} vs ${BASE}`);
  const still = step(beat * 0.29);
  check('...and holds it there', still === BASE);
  CONFIG.emissivePulse.enabled = true;
}

// The spares have no row, and asking for one must not invent anything — every
// asset in the game reaches getAssetMaterials, and a table lookup that fell
// through to a default would put a pulse on all of them.
{
  check('the spare rolls carry no pulse row',
    !CONFIG.emissivePulse.moneyRoll2 && !CONFIG.emissivePulse.moneyRoll4);
  const keys = Object.keys(CONFIG.emissivePulse).filter((k) => k !== 'enabled');
  check('every pulse row names a real asset', keys.every((k) => !!ASSETS[k]), keys.join(', '));
  check('every pulse row is on an asset that lights from its own map',
    keys.every((k) => ASSETS[k].emissiveFromMap || ASSETS[k].material?.emissive != null),
    keys.join(', '));
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
