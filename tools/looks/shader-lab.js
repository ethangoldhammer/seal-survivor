// ---------------------------------------------------------------------------
// SHADER LAB — banded shading and painted pattern, on one animal, live
//
//   npm run looks:shaderlab
//
// The picker (tools/atlas-render/picker.html) settles what an ICON looks like.
// This settles what a CREATURE looks like in the water, and it exists because
// the two halves of that answer were in different places: the cel bands are new
// (systems/toonShade.js) and the pattern controls were spread across the tuner's
// procedural-skins panel and CONFIG.sealShader. Tuning either against the other
// meant alt-tabbing between a slider and a memory of the last look.
//
// THREE LAYERS, EACH ON ITS OWN SWITCH, at the top of the panel:
//
//   noise     noiseShader — Perlin mottling
//   toon      toonShade — banded (cel) lighting
//   biolum    biolumSkin — a painted/glowing pattern
//
// ...and under each of them, the control that decides how much of the model's
// own baked map survives: `paint` on the noise, `pigment` on the biolum. That
// pair is the whole answer to "mix or replace" — 0 lets the photograph through
// and reads as markings ON a real animal, 1 covers it and the layer paints the
// hide outright, and everything between is a hide showing through its own
// texture.
//
// IT USED TO BE ONE EXCLUSIVE CHOICE, and switching cost a CSV edit for
// anything the three named combinations did not cover. Two things were wrong
// with that. Banded lighting was welded to the noise, so a painted creature
// could not be banded at all and a photographed one could not be banded without
// also being mottled — and `pigment` was PINNED to 1 whenever the biolum choice
// was selected, so the slider read 0.30 while the GPU got 1 and no blend
// between a pattern and a texture was reachable from this page. Both are gone:
// nothing is forced now, every layer composes, and assets.csv holds a
// `+`-joined list (see path/src/assetTable.js).
//
// toonShade still injects into MeshStandardMaterial rather than swapping in a
// MeshToonMaterial the way the icon renderer does — a swap would drop the
// emissive map, the noise injection, and the roughness CONFIG.bloom is tuned
// against.
//
// WHAT IT WRITES, and it is two different things:
//
//   `record`  the chosen layers for one creature, into
//             tools/looks/shader-lab.json. `npm run shaders:apply` is what
//             then writes it into the `surface` column of assets.csv.
//   `save`    the preset numbers, into the same file, for pasting into
//             config.js — which is hand-authored and keeps its reasoning.
//
// Beside the page, NOT in the build output: dist-shaderlab is emptied by the
// `vite build` this script starts with, which used to delete the applied
// choices before anyone could act on them. It never touches
// imported-tuning.json — this is a vite BUILD with no dev server behind it,
// per SERVERS.md.
//
// ONE GL CONTEXT for the page. A renderer per panel goes black past a dozen.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, ASSETS } from '../../path/src/assets.js';
import { attachBiolumSkin, applyBiolumSkinSettings, updateBiolumSkin, BIOLUM_PATTERNS } from '../../path/src/systems/biolumSkin.js';
import { attachNoiseShader, applyNoiseSettings, setNoiseWetEnv } from '../../path/src/systems/noiseShader.js';
import { attachToonShade, applyToonSettings } from '../../path/src/systems/toonShade.js';
import { initCreatureOutlines, applyCreatureOutlines, applyCompanionOutlines } from '../../path/src/systems/outlines.js';

const $ = (id) => document.getElementById(id);
const W = 460;

const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, W);
gl.outputColorSpace = THREE.SRGBColorSpace;
$('stage').prepend(gl.domElement);

// DAYLIGHT, NOT THE ABYSS — the same argument tools/looks/skins.js makes. The
// lighting is the whole point of both pigment and banding: paint is shaded and
// additive glow is not, and bands only exist where there is a gradient to band.
// A dark scene would flatter every setting here by hiding what separates them.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1420);
scene.add(new THREE.AmbientLight(0xbcd8ff, 1.1));
const key = new THREE.DirectionalLight(0xfff4e0, 2.4);
key.position.set(4, 7, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fb4ff, 0.8);
rim.position.set(-5, 2, -4);
scene.add(rim);

const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 400);

// THREE STATES, NOT TWO. `true` is a failure and stays red; 'warn' is a record
// that LANDED and has something to say about it — most often that a dev server
// is up, so the numbers are in config.js but saved tuning will still shadow
// them. Those two were the same colour, which meant the single most common
// successful outcome of the record button read as the button not working.
const status = (m, level) => {
  $('status').textContent = m;
  $('status').className = level === true ? 'err' : (typeof level === 'string' ? level : '');
};

await preloadAssets();

// THE RIM THE GAME ACTUALLY PUTS ON THESE ANIMALS.
//
// Not decoration, and not optional for this tool to show: CONFIG.creatureOutline
// is already ON for all ten sharks and orcas, in ORANGE at glow 2.4, and it is
// there to mark a thing that can hurt you. Tuning bands against a shark with no
// rim means tuning against an animal the player never sees — and the rim is
// bright, wide and bloomed, so it is competing with the shading for the same
// silhouette.
//
// initCreatureOutlines installs a spawn decorator that createVisual calls per
// visual, so this is the real path rather than a copy of it: what the lab shows
// is what attachCreatureOutline builds.
initCreatureOutlines();

// ---------------------------------------------------------------------------
// The roster. Model assets only — a primitive has no surface to paint — split so
// the ones this was built for are at the top rather than alphabetically buried
// among eighty fish.
// ---------------------------------------------------------------------------
const WANTED = ['enemyShark', 'enemyGreatWhite', 'enemyMegalodon', 'enemyAbyssShark',
  'enemyHammerhead', 'enemyBossHammerhead', 'enemyMightyMeg', 'enemyMosasaur',
  'enemyOrcaBull', 'enemyOrcaCow', 'orcaFriendBull', 'orcaFriendCow', 'orcaFriendCalf'];

const models = Object.entries(ASSETS).filter(([, d]) => d.model).map(([k]) => k);
const primary = WANTED.filter((k) => models.includes(k));
const rest = models.filter((k) => !primary.includes(k)).sort();

// ---------------------------------------------------------------------------
// The state being edited. Keyed by PRESET NAME, not by asset: that is the unit
// CONFIG stores and the unit a species opts into, so editing per-asset here
// would produce numbers with nowhere to live.
// ---------------------------------------------------------------------------
const edited = { toonShade: {}, sealShader: {}, biolumSkin: {}, creatureOutline: {} };
let subject = null;          // the live visual in the scene
let subjectKey = null;
let axis = null;             // the biolum body axis for the current subject
// The posed box of the current subject, measured once per build. Null forces a
// re-measure — see measureSubject for why it is not taken per frame.
let bounds = null;
// How many of the subject's materials actually took the banding. 0 on an unlit
// model, which is a real limit rather than a bug — see the count in build().
let toonable = 0;
// Does this body have a baked colour texture at all? Read once per build, off
// the ORIGINAL materials rather than off the clones — see build(). Both
// "replace the map" controls (`paint`, `pigment`) are inert without one, and
// the assets that ship no map are exactly the ones the noise shader was written
// for, so the panel says so instead of leaving two dead sliders on screen.
let subjectHasMap = false;
// Does this body have a BAKED EMISSIVE map lit above zero? Separate from the
// colour map, because it is a separate photograph being added as light after
// every lighting chunk — and it is the reason a fully painted barracuda still
// looked photographed. Neither paint nor pigment can be judged without knowing
// it is there, and nothing on the page said so.
let subjectHasGlowMap = false;
// THE RIM, OFF BY DEFAULT, and a VIEW switch rather than a setting.
//
// Two different systems put a shell on a body here — CONFIG.creatureOutline
// (#ff7a3d, ten sharks and orcas) and CONFIG.companionOutline (#ffd27a, the
// seal team and the six allies) — and the panel below only drives the first.
// So on any companion the sliders are inert and a yellow rim sits over the
// surface with nothing in the tool able to switch it off, which is exactly the
// wrong way round for a page whose job is authoring what is UNDER it.
//
// Hidden by making the shell meshes invisible, not by touching either config:
// the rim is per-species roster data, and a view preference that wrote to
// CONFIG could be picked up by `record` and shipped as a roster change nobody
// asked for.
let showRim = false;
function applyRimVisibility() {
  subject?.traverse((o) => {
    if (o.userData.__isOutline) o.visible = showRim;
  });
}
const view = { yaw: 0.5, pitch: 0.35, zoom: 1 };

// The preset each layer is editing for the current subject. Defaults to a name
// derived from the asset so two sharks can share one and an orca can differ.
const target = { toon: 'shark', noise: 'shark', bio: null };

// WHICH LAYERS ARE PAINTING. Any of them, independently.
//
//   noise     procedural Perlin mottling (systems/noiseShader.js)
//   toon      banded lighting (systems/toonShade.js)
//   biolum    a biolumSkin pattern — paint, light, or both
//
// NOT EXCLUSIVE, and the reversal is the point of this rewrite. The old page
// offered three named combinations and nothing else, on the argument that a
// noise field and a biolum pattern at once read as double-textured. That is
// true of those two at full strength and false of every other pairing the rule
// swept up with them — banded lighting most of all, which is not paint and
// which a painted animal wants as badly as a photographed one.
//
// So the judgement moved onto the sliders that can actually express it: `paint`
// and `pigment` decide how much of what is underneath each layer survives, and
// two paints stacked into mud is now something you can see happen and back out
// of rather than something the tool refuses to draw.
//
// Held per ASSET, because that is the unit the game opts in — `noiseShader:` /
// `biolumSkin:` / `toonShade:` are per-asset fields in ASSETS.
// The hints are rendered as HTML, so no code-font backticks in them — they come
// out as literal characters beside the label rather than as markup.
const LAYERS = [
  ['noise', 'noise', 'Perlin mottling — its coat can cover the map'],
  ['toon', 'toon', 'banded lighting — no paint of its own'],
  ['biolum', 'biolum', 'pattern — its pigment can cover the map'],
];
// The three named looks that used to be the whole of the picker, kept as
// one-click starting points rather than as the only reachable states.
const COMBOS = [
  ['photo', {}],
  ['noise+toon', { noise: true, toon: true }],
  ['biolum', { biolum: true }],
  ['biolum+toon', { biolum: true, toon: true }],
  ['all three', { noise: true, toon: true, biolum: true }],
];
const layers = new Map();     // assetKey -> { noise, toon, biolum } booleans
const presetNames = new Map();// assetKey -> { noise, toon, bio } — see defaultPresetFor
const applied = {};           // assetKey -> what `record` pinned, for shader-lab.json
const layersOf = (k) => layers.get(k) ?? { noise: false, toon: false, biolum: false };
const layerOn = (k, which) => !!layersOf(k)[which];
// The same wording the CSV cell uses, so a status line, a roster tooltip and
// path/src/assets.csv all say the creature is wearing the same thing. `texture`
// for none of them, because that is what an empty list MEANS in that column —
// not "unset", which is what a blank cell means.
const describeLayers = (on) =>
  LAYERS.filter(([w]) => on[w]).map(([w]) => w).join('+') || 'texture';

// The exact `surface` cell `record` will put in assets.csv for the subject.
//
// Mirrors cellFor in tools/apply-shaders.mjs on purpose and is only ever shown,
// never sent: the tool that writes the file derives its own cell from the same
// layers, so the two cannot disagree about what lands. Quoting a cell in the
// panel is worth the twelve lines — the whole complaint this rewrite answers
// was that changing a look meant knowing what to type into that column.
function surfaceCell() {
  const on = layersOf(subjectKey);
  const named = { noise: target.noise, toon: target.toon, biolum: target.bio };
  const parts = LAYERS.filter(([w]) => on[w])
    .map(([w]) => (named[w] ? `${w}:${named[w]}` : w));
  return parts.join('+') || 'texture';
}

// SEEDED FROM THE ROSTER FIRST — what the GAME does today.
//
// ASSETS is the authority on which layers a creature is actually wearing: the
// `surface` column of assets.csv is applied onto these fields at load, and some
// assets declare them in code and have no CSV row at all. The seed below is the
// only thing that can see the second kind.
//
// WITHOUT THIS THE SEAL OPENED BARE. `ship` — the player, and the asset this
// whole shader was written for — carries `noiseShader: true` by hand in
// assets.js and has never been through `record`, so nothing in shader-lab.json
// mentions it. Selecting it showed no noise panel and no wet panel, over a
// model that renders in the run with both. The page was reporting its own
// record file as if it were the game, and for every hand-authored asset those
// are different things.
//
// ALL THREE READ SEPARATELY now. The old seed asked one question and answered
// it exclusively, so an asset declaring `noiseShader` AND `toonShade` — which
// is every shark in the file — came up as "noise" with the bands invisible in
// the UI even though they were on the animal.
for (const [key, def] of Object.entries(ASSETS)) {
  if (!def.model) continue;
  layers.set(key, {
    noise: !!def.noiseShader,
    toon: !!def.toonShade,
    biolum: !!def.biolumSkin,
  });
}

// ...THEN WHAT THIS PAGE RECORDED, which wins because it is the newer intent:
// a choice recorded but not yet through `npm run shaders:apply` is not in
// assets.csv and so is not in the seed above. Once applied the two agree.
//
// Reading it at all is what stops the file going backwards. `applied` is page
// memory and started empty on every load, while `record` POSTs the WHOLE map —
// so the first record of a session wrote a file containing only that one
// creature and silently dropped every choice made before it. Four recorded
// creatures became one, and since the writing step looked like it had worked,
// the loss showed up much later as "apply isn't really working".
// AN ENTRY IS READ IN EITHER SHAPE. `layers` is what this page writes now;
// `surface` is what the 26 creatures already in the file were recorded under,
// and it expands the way the old CSV cell did — `noise` meant noise AND toon.
// Dropping the old shape would quietly reopen every one of those on the wrong
// switches, which is the same "the page reports its own record file as if it
// were the game" failure the seed above exists to prevent.
function layersFromEntry(entry) {
  if (entry?.layers) {
    return {
      noise: !!entry.layers.noise,
      toon: !!entry.layers.toon,
      biolum: !!entry.layers.biolum,
    };
  }
  const kind = entry?.surface;
  if (kind === 'noise') return { noise: true, toon: true, biolum: false };
  if (kind === 'biolum') return { noise: false, toon: false, biolum: true };
  if (kind === 'texture') return { noise: false, toon: false, biolum: false };
  return null;
}

try {
  const saved = await (await fetch('/shader/shader-lab.json')).json();
  for (const [key, entry] of Object.entries(saved.applied ?? {})) {
    applied[key] = entry;
    const seeded = layersFromEntry(entry);
    if (seeded) layers.set(key, seeded);
  }
} catch {
  // No file yet, or no server behind the page. Neither is worth a warning: this
  // is the normal first run.
}

// Force the shaders to agree with which layers are switched on.
//
// APPLIED AS A MASK AT COMMIT TIME, NEVER STORED. The first version wrote the
// zeros into `edited` and read them back as the layer's "remembered" strength —
// so switching noise back on restored the 0 that switching it off had just
// saved, and the layer silently stayed dead. `edited` holds what a human
// actually dialled; this only decides which of it reaches the GPU.
//
// ONLY EVER ZEROS NOW, and that is the fix for the pigment slider. The old mask
// also wrote `pigment: 1` onto the chosen biolum preset, so the one control
// that decides whether a pattern blends with the photo texture or replaces it
// was pinned at replace: the slider moved, the readout changed, the uniform
// stayed at 1. A mask that can only turn a layer OFF cannot lie about what an
// on layer is set to.
function layerMask(on) {
  return {
    // `wet` as well as `strength`, or the preview lies about the choice: the
    // film is a separate layer on the same root, so zeroing the mottling alone
    // left a gloss on an animal wearing no noise at all — and in the game an
    // asset with no noise layer never attaches this shader, so there is nothing
    // there to be glossy. `paint` for the same reason: it is the coat that
    // hides the model's own map, and a switched-off layer must give it back.
    sealShader: on.noise ? null : { strength: 0, wet: 0, paint: 0 },
    toonShade: on.toon ? null : { strength: 0 },
    // Paint AND light, both. `pigment` is the pattern as a hide and `strength`
    // is it as emission; a mask that dropped either would leave half a switched
    // off pattern on the body.
    biolumSkin: on.biolum ? null : { pigment: 0, strength: 0, shellGlow: 0 },
  };
}

function enforceSurface() {
  commit();
}

// THE PRESET THIS SPECIES WRITES TO. Its own, by default.
//
// This used to guess a family name from the asset key with a regex, and it was
// wrong in both directions. `enemyGreatWhite` matched none of shark/meg/hammer
// and fell through to 'hide' — a BIOLUM preset name, written into the noise and
// toon slots where it means nothing. And every creature that DID match shared
// one name, so tuning the megalodon silently retuned the shark: "apply to this
// enemy type" applied to several, and the last one edited won.
//
// One preset per species now, named after it. Sharing is still available and is
// now a DECISION — type the same preset name into the field on the surface panel
// for two species and they genuinely share, visibly, rather than by accident of
// what their key happens to contain.
function defaultPresetFor(assetKey, kind) {
  // A biolum surface starts from whatever the asset already declares, so opening
  // enemyOrcaCow edits `orcaHide` rather than forking a second preset that
  // silently competes with the one the game is already using.
  if (kind === 'biolum') {
    const existing = ASSETS[assetKey]?.biolumSkin;
    if (typeof existing === 'string') return existing;
  }
  const existing = kind === 'noise' ? ASSETS[assetKey]?.noiseShader : ASSETS[assetKey]?.toonShade;
  if (typeof existing === 'string') return existing;
  return assetKey.replace(/^enemy/, '').replace(/^./, (c) => c.toLowerCase());
}

// ---------------------------------------------------------------------------
// Controls, declared. `apply` decides whether a change is a uniform push (cheap,
// every frame of a drag) or a rebuild (a new attach).
// ---------------------------------------------------------------------------
const TOON = [
  { key: 'strength', label: 'strength', min: 0, max: 1, step: 0.02, def: 1 },
  { key: 'steps', label: 'bands', min: 1, max: 8, step: 1, def: 3 },
  { key: 'gamma', label: 'terminator', min: 0.3, max: 3, step: 0.05, def: 1 },
  { key: 'low', label: 'shadow', min: 0, max: 1, step: 0.01, def: 0.28 },
  { key: 'high', label: 'light', min: 0.2, max: 1.6, step: 0.01, def: 1 },
  { key: 'soft', label: 'softness', min: 0, max: 1, step: 0.02, def: 0 },
  { key: 'range', label: 'full-lit at', min: 0.2, max: 3, step: 0.05, def: 1 },
];

const NOISE = [
  // FIRST, because it is the question the rest of this section is an answer to:
  // is this layer marking up the model's photograph, or is it painting the
  // animal? At 0 the baked map shows through every trough in the field no
  // matter where `strength` goes — which is what "the barracuda is stuck with
  // its photo texture" was. At 1 the map is covered and the mottling below is
  // the whole hide.
  { key: 'paint', label: 'cover the photo map', min: 0, max: 1, step: 0.02, def: 0 },
  // ...and the same question asked of the model's baked EMISSIVE map, which on
  // the barracuda and both hammerheads is that same photograph lit white at
  // CONFIG.glow.maskIntensity. Covering the colour and leaving this at 1 paints
  // a hide and then draws the photograph back on top of it in light.
  { key: 'paintGlow', label: 'keep its photo glow', min: 0, max: 1, step: 0.02, def: 0 },
  { key: 'strength', label: 'strength', min: 0, max: 1.5, step: 0.02, def: 0.35 },
  { key: 'size', label: 'size', min: 0.02, max: 2, step: 0.01, def: 0.4 },
  { key: 'contrast', label: 'contrast', min: 0.2, max: 4, step: 0.05, def: 1 },
];

// THE WET FILM (CONFIG.sealShader.wet*). A list of its own rather than more rows
// on NOISE, and a section of its own in the panel, because it is a different
// question: NOISE is what the SKIN is, this is what is lying ON it. They share a
// preset — both are CONFIG.sealShader — and exactly one control crosses between
// them, `wetPatch`, which reaches back into the markings the noise paints.
//
// Every `def` here mirrors the base in config.js. It should never be reached —
// valOf falls through to the base first — but a def that disagreed would be
// invisible until the day someone deleted a base field, and then it would look
// like a tuning change.
const WET = [
  { key: 'wet', label: 'wetness', min: 0, max: 2, step: 0.05, def: 0.55 },
  { key: 'wetGloss', label: 'highlight', min: 0, max: 3, step: 0.05, def: 0.7 },
  // The two that decide whether this reads as toon or as plastic. Softness is in
  // TERRACE widths, not in units of the falloff — 0.08 is eight per cent of one
  // step and still a razor, which on a low-poly body traces the tessellation.
  { key: 'wetSteps', label: 'highlight steps', min: 1, max: 5, step: 1, def: 2 },
  { key: 'wetSoft', label: 'step softness', min: 0, max: 1, step: 0.02, def: 0.5 },
  { key: 'wetTight', label: 'highlight tightness', min: 1, max: 200, step: 1, def: 24 },
  { key: 'wetEdge', label: 'highlight cut', min: 0, max: 1, step: 0.01, def: 0.15 },
  { key: 'wetRim', label: 'wet rim', min: 0, max: 2, step: 0.02, def: 0.9 },
  { key: 'wetRimPower', label: 'rim tightness', min: 0.5, max: 8, step: 0.1, def: 3.4 },
  { key: 'wetPatch', label: 'markings break it up', min: 0, max: 1, step: 0.05, def: 0.35 },
  { key: 'wetCaustics', label: 'caustic veins', min: 0, max: 3, step: 0.05, def: 1.2 },
  { key: 'wetCausticScale', label: 'vein size vs the water', min: 0.1, max: 8, step: 0.1, def: 4 },
  { key: 'wetCausticUp', label: 'veins favour up-facing', min: 0, max: 1, step: 0.05, def: 0.75 },
  { key: 'wetGlow', label: 'glow burns the sheen', min: 0, max: 4, step: 0.05, def: 1 },
  { key: 'wetTint', label: 'sheen takes the water colour', min: 0, max: 1, step: 0.05, def: 0.5 },
];

const BIO = [
  // The biolum half of the same question `paint` asks of the noise: how much of
  // the model's baked map survives under the pattern. 0 is a glow over a
  // photograph, 1 is a painted hide. `def` mirrors CONFIG.biolumSkin.base, which
  // is 0 — it was 1 here, which would have shown a full-pigment slider over an
  // additive-only preset the day anyone deleted that base field.
  { key: 'pigment', label: 'pigment (covers the map)', min: 0, max: 1, step: 0.02, def: 0 },
  // The biolum half of `paintGlow` above, and the reason the hammerhead read as
  // "stuck with the photo texture" at pigment 1: its emissive sidecar was still
  // adding its own photograph as light over the painted hide.
  { key: 'pigmentGlow', label: 'keep its photo glow', min: 0, max: 1, step: 0.02, def: 0 },
  { key: 'scale', label: 'feature size', min: 0.04, max: 1.2, step: 0.01, def: 0.25 },
  { key: 'contrast', label: 'contrast', min: 0.2, max: 4, step: 0.05, def: 1.6 },
  { key: 'coverage', label: 'coverage', min: 0, max: 1, step: 0.02, def: 0.45 },
  { key: 'strength', label: 'glow', min: 0, max: 3, step: 0.02, def: 0 },
  { key: 'flow', label: 'drift', min: 0, max: 2, step: 0.02, def: 0 },
];

// The rim. NOT part of toonShade — the game builds outlines as inverted-hull
// shells (systems/outlines.js), the same technique the icon renderer uses, and
// they are a separate material from the surface entirely. Exposed here because
// the two are judged together or not at all: a 0.12 orange rim at glow 2.4 is a
// loud edge, and how many bands read inside it depends entirely on how much of
// the silhouette it is eating.
//
// THIS EDITS THE SHARED FAMILY SETTING. CONFIG.creatureOutline.on lists species,
// but colour, thickness, glow and opacity are ONE set for every creature wearing
// a rim — so a change here moves all ten sharks and orcas together. That is the
// system as built, not a limitation of the panel.
const OUTLINE = [
  { key: 'thickness', label: 'thickness', min: 0, max: 0.6, step: 0.005, def: 0.12 },
  { key: 'glow', label: 'glow', min: 0, max: 5, step: 0.05, def: 2.4 },
  { key: 'opacity', label: 'opacity', min: 0, max: 1, step: 0.02, def: 1 },
];

const cssToInt = (s) => parseInt(s.slice(1), 16);
const intToCss = (n) => '#' + ((n ?? 0) >>> 0).toString(16).padStart(6, '0');

// The value in play for one field: what has been edited, else what CONFIG holds
// for this preset, else the base, else the control's own default.
function valOf(layer, cfgRoot, presetName, spec) {
  // A FLAT root — creatureOutline has no presets, its fields sit at the top.
  // Passing presetName null is how a section says so.
  if (presetName === null) {
    const e = edited[cfgRoot]?.__flat;
    if (e && spec.key in e) return e[spec.key];
    const root = CONFIG[cfgRoot] ?? {};
    return spec.key in root ? root[spec.key] : spec.def;
  }
  const e = edited[cfgRoot]?.[presetName];
  if (e && spec.key in e) return e[spec.key];
  const root = CONFIG[cfgRoot] ?? {};
  const p = (root.presets ?? {})[presetName] ?? {};
  if (spec.key in p) return p[spec.key];
  const base = root.base ?? root;
  if (spec.key in base) return base[spec.key];
  return spec.def;
}

function setVal(cfgRoot, presetName, k, v) {
  (edited[cfgRoot] ??= {})[presetName === null ? '__flat' : presetName] ??= {};
  edited[cfgRoot][presetName === null ? '__flat' : presetName][k] = v;
}

// THE PRESETS AS CONFIG.JS AUTHORED THEM, captured before anything is committed
// and never written to again. Every rebuild starts here, so no amount of masking
// and un-masking can drift the values a human never touched. Deep-cloned because
// these are the live CONFIG objects otherwise, and commit() writes into those.
const PRISTINE = structuredClone({
  toonShade: CONFIG.toonShade?.presets ?? {},
  sealShader: CONFIG.sealShader?.presets ?? {},
  biolumSkin: CONFIG.biolumSkin?.presets ?? {},
  creatureOutline: CONFIG.creatureOutline?.presets ?? {},
});

// Every preset the surface mask has written into, as root -> set of preset names,
// so the next commit knows what to put back. A Map of Sets rather than one flat
// key, so a preset name is never parsed back out of a joined string — the names
// are typed by hand on the surface panel and can contain anything.
const masked = new Map();

// One preset, rebuilt from scratch: what config.js declared, plus what a human
// dialled. Deliberately an assignment and not a merge — see commit step 1.
function rebuildPreset(root, name) {
  if (!name) return;
  const bag = ((CONFIG[root] ??= {}).presets ??= {});
  bag[name] = { ...(PRISTINE[root]?.[name] ?? {}), ...(edited[root]?.[name] ?? {}) };
}

// Merge the edits into the live CONFIG so the real apply* functions see them.
// Written into CONFIG rather than pushed at uniforms directly, deliberately: the
// point is to exercise the same path the game uses, so a look that works here
// works there. Nothing saves CONFIG, and this page cannot reach the tuning file.
function commit() {
  // 1. UNDO THE LAST MASK FIRST, and this is the fix for "the toon sliders do
  //    nothing on exactly the creatures the tool was built for".
  //
  //    surfaceMask says it is never stored. It was: `maskInto` merged its zeros
  //    straight into CONFIG.<root>.presets.<name>, and the only thing selecting
  //    another surface did was STOP writing them — nothing ever put the old
  //    value back. So the very first commit, on the default `texture` surface,
  //    wrote strength 0 into the toon and noise presets of whatever species was
  //    open; switching to `noise + toon` then revealed a panel whose sliders all
  //    read 0, over an animal that never changed. Measured across the roster: 9
  //    of 10 sharks and orcas came up with toon strength 0 against a CONFIG
  //    default of 1.
  //
  //    Rebuilding from PRISTINE rather than from whatever is in CONFIG now is
  //    what makes the mask genuinely temporary: layering onto the live object
  //    can only ever accumulate, because a zero and an unset field are the same
  //    shape once merged.
  for (const [root, names] of masked) for (const n of names) rebuildPreset(root, n);
  masked.clear();

  // 2. What a human actually dialled, over the pristine values.
  for (const [root, presets] of Object.entries(edited)) {
    const c = (CONFIG[root] ??= {});
    for (const [name, fields] of Object.entries(presets)) {
      if (name === '__flat') { Object.assign(c, fields); continue; }
      rebuildPreset(root, name);
    }
  }

  // 3. ...then the layer mask over the top, so a switched-off layer is off.
  const mask = layerMask(layersOf(subjectKey));
  const maskInto = (root, name, fields) => {
    if (!fields || !name) return;
    const bag = ((CONFIG[root] ??= {}).presets ??= {});
    bag[name] = { ...(bag[name] ?? {}), ...fields };
    // Remembered so step 1 can put it back. Without this the restore cannot
    // reach a preset that was masked but never edited — which is every preset
    // on a species you only looked at.
    if (!masked.has(root)) masked.set(root, new Set());
    masked.get(root).add(name);
  };
  maskInto('sealShader', target.noise, mask.sealShader);
  maskInto('toonShade', target.toon, mask.toonShade);
  maskInto('biolumSkin', target.bio, mask.biolumSkin);

  applyToonSettings();
  applyNoiseSettings();
  applyBiolumSkinSettings();
  applyCreatureOutlines();
  applyCompanionOutlines();
}

// ---------------------------------------------------------------------------
// The subject
// ---------------------------------------------------------------------------
// FRAMED ON THE BODY, NOT ON THE BODY PLUS ITS RIM.
//
// Box3.setFromObject walks everything under the node, and the outline shells are
// meshes — so a wider rim inflates the box, the camera pulls back to fit it, and
// the animal renders SMALLER. Dragging the thickness slider up then puts fewer
// rim pixels on screen than dragging it down, which reads as the control being
// inverted rather than as the framing moving. Measured, not guessed: at 0.30 the
// rim covered 8,843 pixels against 13,100 at 0.02.
//
// The icon renderer avoids this by building its shells after it frames. Here the
// shells already exist by the time anything is measured, so the box is taken
// from the non-outline meshes instead.
// MEASURED THROUGH THE SKIN, not off the bind-pose box, and that is what put
// two of the thirteen subjects off-screen entirely.
//
// A SkinnedMesh's geometry box describes where its vertices sit BEFORE the
// skeleton moves them, and on a rig whose bind pose is nowhere near its rest
// pose the two are wildly different sizes. enemyMegalodon measured 252 units
// across that way against a real body of about 15 — so the camera pulled back
// to 478, past the far plane at 400, and the animal was clipped out of the
// scene. Nothing errored: the panel just rendered empty water, and every toon
// slider on it looked broken because there was no animal to band.
// orcaFriendCalf was the same fault with a smaller number: 0.01% of the canvas.
//
// So each vertex is pushed through its own bone transform first, exactly as the
// icon renderer's meshBoxes does. Once per subject rather than once per frame —
// nothing here animates the pose, so the box cannot move between draws, and
// walking 37,000 vertices on every slider drag would be felt.
function measureSubject() {
  subject.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  subject.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.__isOutline) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    if (o.isSkinnedMesh) o.skeleton?.update();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      // applyBoneTransform is the same call three.js's own raycaster uses; on a
      // non-skinned mesh it does not exist and the vertex is already right.
      if (o.isSkinnedMesh) o.applyBoneTransform(i, p);
      box.expandByPoint(o.localToWorld(p));
    }
  });
  if (box.isEmpty()) box.setFromObject(subject);
  const size = new THREE.Vector3(); const centre = new THREE.Vector3();
  box.getSize(size); box.getCenter(centre);
  bounds = { size, centre, span: Math.max(size.x, size.y, size.z, 1e-4) };
  return size;
}

function frameSubject() {
  if (!bounds) measureSubject();
  const { centre, span } = bounds;
  const back = span * 1.9 / view.zoom;
  camera.position.set(
    centre.x + back * Math.cos(view.pitch) * Math.sin(view.yaw),
    centre.y + back * Math.sin(view.pitch),
    centre.z + back * Math.cos(view.pitch) * Math.cos(view.yaw),
  );
  // THE CLIP PLANES FOLLOW THE SUBJECT. A fixed far plane is a size limit on
  // what the tool can show, and it was being hit silently — see measureSubject.
  // Derived from the distance actually in use, so any body frames the same way.
  camera.near = Math.max(back * 0.002, 1e-4);
  camera.far = back + span * 4;
  camera.updateProjectionMatrix();
  camera.lookAt(centre);
  return bounds.size;
}

function build(assetKey) {
  if (subject) scene.remove(subject);
  subjectKey = assetKey;
  // Remembered per asset once chosen, so switching away and back does not
  // silently re-derive a different name and strand the edits under the old one.
  const remembered = presetNames.get(assetKey);
  target.noise = remembered?.noise ?? defaultPresetFor(assetKey, 'noise');
  target.toon = remembered?.toon ?? defaultPresetFor(assetKey, 'toon');
  target.bio = remembered?.bio ?? defaultPresetFor(assetKey, 'biolum');
  presetNames.set(assetKey, { ...target });

  const visual = createVisual(assetKey);
  if (!visual) { status(`createVisual returned nothing for ${assetKey}`, true); return; }
  // Lay the body flat. createVisual points a creature forward at world +Y — nose
  // up — and a nose-up animal in a square panel is a thin vertical sliver that
  // says nothing about its surface. Same rotation as every preview in this folder.
  visual.rotation.z = -Math.PI / 2;
  subject = visual;
  scene.add(visual);
  bounds = null;               // a new body: measure it, do not reuse the last one
  const size = measureSubject();
  frameSubject();
  axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');

  // CLONE FIRST, ATTACH SECOND, ALWAYS. createVisual hands back instances that
  // SHARE the asset's materials, so attaching in place would paint every other
  // creature made from the same asset — and three's Material.clone() drops
  // onBeforeCompile, so cloning after an attach silently throws the shader away.
  let count = 0;
  toonable = 0;
  subjectHasMap = false;
  subjectHasGlowMap = false;
  visual.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.__isOutline) return;
    const one = (m) => {
      const c = m.clone();
      // THE CLONE TRAP, and it silently emptied every creature that already had
      // a skin. Material.clone() deep-copies userData but DROPS onBeforeCompile,
      // so a clone of an asset-level attach keeps every flag saying "attached"
      // while carrying none of the shader. Each attach below then short-circuits
      // on the flag and does nothing — and because a pigment attach also nulls
      // the model's `map` on the original, the clone inherits a body with its
      // texture removed AND no pattern to replace it. enemyOrcaBull rendered as
      // a featureless white blob: no markings, and every slider inert.
      //
      // So the flags are cleared and the map put back, which makes the clone
      // honest — an unpainted material that the attaches below can actually
      // paint. See the same hazard in tools/looks/skins.js, which sidesteps it
      // by only ever cloning materials that were never attached.
      for (const k of Object.keys(c.userData)) {
        if (/^__(bioSkin|noise|toon)/.test(k)) delete c.userData[k];
      }
      // PUT THE TEXTURE BACK ONLY IF IT IS STILL A TEXTURE.
      //
      // This is the uncaught "Cannot read properties of undefined (reading
      // 'elements')" on load, and it is the clone trap again one level deeper.
      // three's Material.copy() deep-copies userData through JSON.parse(
      // JSON.stringify(...)) — and THREE.Texture has a toJSON(), so a Texture
      // stashed in userData comes back as its DESCRIPTOR: a plain object with
      // uuid/image/repeat/offset and no .matrix on it.
      //
      // Assets that share a model file inherit that corruption at the asset
      // level, because the second asset's material is a clone of the first's:
      // enemyAbyssShark reuses greatwhite.glb, so its `__originalMap` was
      // already a descriptor before the lab touched it. Assigning that as `map`
      // renders fine right up until three reaches refreshTransformUniform and
      // reads texture.matrix — which throws once per frame, from inside the
      // renderer, pointing at three rather than at here.
      const orig = m.userData.__originalMap;
      if (orig?.isTexture) c.map = orig;
      // else: a descriptor, or null. Leave the clone's own map alone — it is
      // the one the asset is actually wearing.
      //
      // NULL USED TO MEAN "TAKE THE MAP OFF", and that was wrong about what
      // this field is. `__originalMap` is stashed by processMaterial BEFORE the
      // sidecar assignment two lines below it, so on any asset whose diffuse
      // comes from a `texture: { map: ... }` sidecar it is null while the
      // material is fully textured — and the hammerhead, which assets.js calls
      // the one model in the roster that needs an explicit diffuse map, is
      // exactly that. The lab deleted it on every build and then reported "NO
      // baked map", so the one control the page exists to judge (how much of
      // the photograph the pigment covers) was being judged against a body with
      // no photograph on it.
      //
      // Nothing nulls a material's map any more either, which is what the old
      // branch was written to undo — the pigment replacement is a mix inside
      // the shader now (uBioPigment), not an assignment.
      //
      // Asked AFTER the restore above and of the clone, which is the material
      // the panel's sliders will actually be pointed at. Asking the original
      // instead would answer for a body whose map a pigment attach had already
      // nulled, and the page would claim there is no photograph to cover on
      // exactly the creatures wearing one.
      if (c.map) subjectHasMap = true;
      // The MASK, not the live slot: applyEmissiveMode swaps `emissiveMap` in
      // and out on the global CONFIG.glow.emissiveMaps toggle, so reading the
      // slot answers "is the toggle on right now" rather than "does this animal
      // ship one". Intensity counts too — a mask multiplied by zero is not
      // competing with anything.
      if ((c.userData.__emissiveMask || c.emissiveMap) && (c.emissiveIntensity ?? 0) > 0) {
        subjectHasGlowMap = true;
      }
      if ('__originalColor' in m.userData && m.userData.__originalColor != null) {
        c.color.setHex(m.userData.__originalColor);
      }
      c.needsUpdate = true;
      // Order matches processMaterial in assets.js: noise, then toon, then the
      // biolum skin. All three chain onBeforeCompile, and toonShade is the only
      // one that composes rather than assigns — see its header.
      attachNoiseShader(c, target.noise);
      attachToonShade(c, target.toon);
      attachBiolumSkin(c, o, target.bio, axis, null);
      // DID THE BANDING ACTUALLY TAKE? attachToonShade returns early on anything
      // that is not a lit material, because the quantise reads `reflectedLight`
      // and only the lighting chunks declare it — so on an unlit body every toon
      // slider is genuinely inert, and silently so. Counted rather than assumed
      // so the panel can say which it is instead of the tool looking broken.
      // `modelUnlit: true` in ASSETS is what puts a model here; 27 of the 82 are.
      if (c.userData.__toonAttached) toonable++;
      count++;
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });

  enforceSurface();
  buildPanels();

  // A handle on what is actually on screen, for asking the page questions it
  // cannot answer from the DOM — how many shells a body ended up with, whether
  // an injected shader survived a clone, which materials claim an attach they no
  // longer carry. Diagnostics only; nothing reads it.
  window.__subject = visual;
  window.__inspect = () => {
    const bodies = [], shells = [];
    visual.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      (o.userData.__isOutline ? shells : bodies).push(o);
    });
    const mats = (list) => list.flatMap((o) => (Array.isArray(o.material) ? o.material : [o.material]));
    const flag = (m) => ({
      map: !!m.map,
      noise: !!m.userData.__noiseAttached,
      toon: !!m.userData.__toonAttached,
      toonCompiled: !!m.userData.__toonCompiled,
      bio: !!m.userData.__bioAttached || !!m.userData.__biolumAttached,
      // THE CLONE TRAP: userData survives Material.clone(), onBeforeCompile does
      // not. A material claiming an attach with no callback on it is one whose
      // shader was silently thrown away — and every later attach short-circuits
      // on the flag, so it never comes back.
      hasCallback: typeof m.onBeforeCompile === 'function',
    });
    return {
      bodyMeshes: bodies.length,
      shellMeshes: shells.length,
      shellsPerBody: (shells.length / Math.max(bodies.length, 1)).toFixed(2),
      bodyMats: mats(bodies).map(flag),
      shellMats: mats(shells).length,
    };
  };
  applyRimVisibility();
  $('notes').textContent =
    `${assetKey} — ${ASSETS[assetKey].model}\n`
    + `${count} material(s) painted · long axis ${axis} · `
    + `${subjectHasMap ? 'has a baked map' : 'NO baked map'}`
    + `${subjectHasGlowMap ? ' + a baked emissive' : ''} · `
    + `layers ${describeLayers(layersOf(assetKey))} · `
    + `toon preset "${target.toon}" · noise preset "${target.noise}" · pattern preset "${target.bio}"`;
  draw();
}

let frames = 0;
let wetClock = 0;

// WHAT THE WET FILM THINKS THE OCEAN IS DOING. There is no water plane on this
// page, and without this the film falls back to the uniforms' own defaults —
// a vein scale of 0.16 against the game's 0.52, frozen at phase 0. The vein
// sliders would then preview at a size no run ever shows, which is the one way
// a look page can be worse than no look page.
//
// Read from CONFIG.caustics, so it is the same field the water builds. Two
// deliberate departures, both because this is a PORTRAIT and not a run:
//
//   light 1     noon. The day/night bus is a thing to judge in the game, and a
//               page that happened to open at 3am would show every vein setting
//               at a fifth of itself.
//   falloff 0   pow(1 - depth, 0) is 1 everywhere, so the veins do not fade with
//               where the subject happens to be floating. The depth ramp is real
//               and belongs to the arena, not to the pattern being tuned here.
const causticColor = new THREE.Color();
function pushWetEnv() {
  setNoiseWetEnv({
    on: CONFIG.caustics?.enabled ? 1 : 0,
    light: 1,
    scale: CONFIG.caustics?.scale ?? 0.16,
    phase: wetClock * (CONFIG.caustics?.speed ?? 0.55),
    falloff: 0,
    color: causticColor.set(CONFIG.caustics?.color ?? 0xbfefff),
    surfaceY: 0,
    bottomY: -1,
  });
}

function draw() {
  if (!subject) return;
  frameSubject();
  // The biolum shader animates off a clock; stepped by hand rather than in a rAF
  // loop so the page works in a backgrounded tab, where rAF does not fire.
  updateBiolumSkin?.(1 / 60);
  // Same reasoning, same step: the caustic veins crawl because this advances.
  wetClock += 1 / 60;
  pushWetEnv();
  gl.render(scene, camera);
  frames++;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------
function section(title, cfgRoot, presetName, specs, extra) {
  const sect = document.createElement('div');
  sect.className = 'sect';
  const h = document.createElement('h3');
  h.innerHTML = `<span>${title}</span><span class="en">${presetName ?? 'base'}</span>`;
  h.addEventListener('click', () => sect.classList.toggle('shut'));
  sect.appendChild(h);
  const body = document.createElement('div');
  body.className = 'body';
  sect.appendChild(body);

  for (const spec of specs) {
    const row = document.createElement('div');
    row.className = 'row';
    const v = valOf(title, cfgRoot, presetName, spec);
    row.innerHTML = `<label>${spec.label}</label>
      <input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${v}">
      <output>${spec.step >= 1 ? v : (+v).toFixed(2)}</output>`;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.addEventListener('input', () => {
      const nv = parseFloat(input.value);
      out.textContent = spec.step >= 1 ? nv : nv.toFixed(2);
      setVal(cfgRoot, presetName, spec.key, nv);
      commit();
      draw();
      dumpJson();
    });
    body.appendChild(row);
  }
  if (extra) extra(body, presetName);
  return sect;
}

function colorRow(body, cfgRoot, presetName, key, label, def) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}</label><div class="cols"><input type="color"></div><output></output>`;
  const input = row.querySelector('input');
  const cur = valOf(label, cfgRoot, presetName, { key, def });
  input.value = typeof cur === 'number' ? intToCss(cur) : (cur ?? intToCss(def));
  input.addEventListener('input', () => {
    setVal(cfgRoot, presetName, key, cssToInt(input.value));
    commit(); draw(); dumpJson();
  });
  body.appendChild(row);
}

function buildPanels() {
  const p = $('panels');
  p.innerHTML = '';

  // The switches, first — everything below is the settings for whatever is on.
  const pick = document.createElement('div');
  pick.className = 'sect';
  pick.innerHTML = `<h3><span>layers</span><span class="en">${subjectKey}</span></h3><div class="body"></div>`;
  const pb = pick.querySelector('.body');

  // ONE CLICK PER LAYER, and the preset it writes to on the same line.
  //
  // The preset field used to live below the picker and drive TWO slots at once —
  // typing a noise preset also renamed the toon one, because the two were welded
  // together by the old exclusive choice. They are separate layers with separate
  // preset bags in CONFIG, so they get separate fields: a shark can wear the
  // family's bands over its own mottling, which is not expressible otherwise.
  const slotOf = { noise: 'noise', toon: 'toon', biolum: 'bio' };
  for (const [which, label, hint] of LAYERS) {
    const on = layerOn(subjectKey, which);
    const row = document.createElement('label');
    row.className = 'surf';
    row.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><b>${label}</b><i>${hint}</i>`;
    row.querySelector('input').addEventListener('change', (e) => {
      layers.set(subjectKey, { ...layersOf(subjectKey), [which]: e.target.checked });
      enforceSurface();
      buildPanels();
      draw();
      renderList();
      status(`${subjectKey}: ${describeLayers(layersOf(subjectKey))}`);
    });
    pb.appendChild(row);

    if (!on) continue;
    const slot = slotOf[which];
    const pr = document.createElement('div');
    pr.className = 'row';
    pr.innerHTML = `<label>${label} preset</label><input type="text" value="${target[slot]}"><output></output>`;
    const inp = pr.querySelector('input');
    inp.addEventListener('change', () => {
      const name = inp.value.trim();
      if (!name || name === target[slot]) return;
      target[slot] = name;
      presetNames.set(subjectKey, { ...target });
      // REBUILT, because the preset name decides which material each layer
      // answers to and that is baked in at attach time — pushing uniforms at
      // the old bag would leave the sliders writing somewhere the animal is not
      // reading from.
      build(subjectKey);
      const shared = [...presetNames.entries()]
        .filter(([k, v]) => k !== subjectKey && v[slot] === name)
        .map(([k]) => k);
      status(shared.length
        ? `${label} preset "${name}" — SHARED with ${shared.join(', ')}; editing it moves them too`
        : `${label} preset "${name}" — used by ${subjectKey} alone`);
    });
    pb.appendChild(pr);
  }

  // The three named looks the picker used to be, as shortcuts. Every one of
  // them is now just a set of the switches above, which is the point: they are
  // a fast start rather than the only reachable states.
  const quick = document.createElement('div');
  quick.className = 'row combos';
  quick.innerHTML = '<label>quick</label><div class="cols"></div><output></output>';
  const cols = quick.querySelector('.cols');
  for (const [label, set] of COMBOS) {
    const b = document.createElement('button');
    b.className = 'combo';
    b.textContent = label;
    b.addEventListener('click', () => {
      layers.set(subjectKey, { noise: !!set.noise, toon: !!set.toon, biolum: !!set.biolum });
      enforceSurface(); buildPanels(); draw(); renderList();
      status(`${subjectKey}: ${describeLayers(layersOf(subjectKey))}`);
    });
    cols.appendChild(b);
  }
  pb.appendChild(quick);

  // WHETHER THERE IS A PHOTOGRAPH UNDER ANY OF THIS. `paint` and `pigment` are
  // both "how much of the model's own map survives", and on a model that ships
  // no map at all they have nothing to cover — the seal is exactly that, which
  // is what noiseShader was written for. Without this line the two sliders look
  // broken on precisely the assets they are least needed on.
  if (!subjectHasMap) {
    const warn = document.createElement('div');
    warn.className = 'row warnrow';
    warn.innerHTML = '<label>no map</label><output>'
      + 'this model ships no baked colour texture, so <b>cover the photo map</b> '
      + 'and <b>pigment</b> have nothing to replace — both layers paint the flat '
      + 'base colour either way.'
      + '</output>';
    pb.appendChild(warn);
  }

  // THE PHOTOGRAPH THAT IS NOT ON THE DIFFUSE. Four animals ship an emissive
  // sidecar (the barracuda, both hammerheads, the great white) and it is their
  // own colour map with the brights blown out, lit in white at
  // CONFIG.glow.maskIntensity. Until the two "keep its photo glow" sliders
  // existed nothing on the diffuse side could reach it, and the symptom was a
  // fully painted animal that still read as photographed — with every paint
  // control on this page apparently doing nothing.
  if (subjectHasGlowMap) {
    const warn = document.createElement('div');
    warn.className = 'row warnrow';
    warn.innerHTML = '<label>photo glow</label><output>'
      + 'this model ships a baked <b>emissive</b> map — its own photograph, added '
      + 'as light on top of everything below. Turn <b>keep its photo glow</b> down '
      + 'on whichever layer is covering the map, or the paint sits under it.'
      + '</output>';
    pb.appendChild(warn);
  }

  // THE CELL THIS WOULD WRITE, spelled out. Not decoration: "I don't want to
  // edit the CSV to change from toon to biolum" is the note this page is
  // answering, and showing the cell is how it stops being a thing you have to
  // know. It is also the one line that makes a shared preset name visible as a
  // shared preset name before you press record.
  const cellRow = document.createElement('div');
  cellRow.className = 'row warnrow';
  cellRow.innerHTML = `<label>assets.csv</label><output class="cell">surface = ${surfaceCell()}</output>`;
  cellRow.querySelector('output').style.color = '#7fa8c8';
  pb.appendChild(cellRow);

  p.appendChild(pick);

  const on = layersOf(subjectKey);
  if (on.toon) {
    const toonSect = section('toon', 'toonShade', target.toon, TOON);
    // SAY SO WHEN THE BANDING CANNOT LAND, rather than presenting seven live
    // sliders over a body that will never respond to any of them. An unlit model
    // has no `reflectedLight` for attachToonShade to quantise, so it refuses the
    // attach — silently, by design, because injecting there is a compile error.
    // Among the thirteen sharks and orcas this tool is for, exactly one is unlit
    // (enemyAbyssShark); the noise layer below still works on it.
    if (toonable === 0) {
      const warn = document.createElement('div');
      warn.className = 'row warnrow';
      warn.innerHTML = '<label>unlit</label><output>'
        + 'this model renders unlit (modelUnlit) — it has no lighting to band, '
        + 'so the sliders below do nothing. Noise and pattern still apply.'
        + '</output>';
      toonSect.querySelector('.body').prepend(warn);
    }
    p.appendChild(toonSect);
  }

  if (on.noise) p.appendChild(section('noise', 'sealShader', target.noise, NOISE, (body, name) => {
    // The coat's colour, beside the mottling's. Two pickers rather than one
    // because they are the two ends of what this layer paints: `base` is the
    // hide it lays down over the photograph and `tint` is what the field pulls
    // it toward. White base means "the asset's own tint" — see the GLSL.
    colorRow(body, 'sealShader', name, 'baseColor', 'coat colour', 0xffffff);
    colorRow(body, 'sealShader', name, 'color', 'tint', 0x0a2233);
  }));

  // THE WET FILM, on the same root and the same preset as the noise above, in a
  // section of its own — see the note on WET.
  if (on.noise) {
    const wetSect = section('wet', 'sealShader', target.noise, WET, (body, name) => {
      colorRow(body, 'sealShader', name, 'wetColor', 'sheen', 0xdff2ff);
    });
    // SAY SO WHEN THE NUMBERS HAVE NOWHERE TO GO. These sliders write to
    // CONFIG.sealShader.presets.<name>, and the game only reads that preset for
    // an asset whose `surface` cell names it — `noise:<name>` in assets.csv.
    // An asset that attaches with no preset (noiseShader: true, which is the
    // player's seal and the escorts) reads the BASE numbers instead, so
    // everything dialled here would preview perfectly and change nothing in the
    // run until `record` writes the CSV row.
    //
    // Worth a line specifically because wetness is the seal's feature, the seal
    // is exactly the asset with no preset, and the failure is silent at both
    // ends: the lab looks right and the game looks untouched.
    const wearing = ASSETS[subjectKey]?.noiseShader;
    if (wearing !== target.noise) {
      const warn = document.createElement('div');
      warn.className = 'row warnrow';
      warn.innerHTML = `<label>not live</label><output>`
        + `the game reads ${wearing === true ? 'the BASE numbers' : `"${wearing ?? 'no noise surface'}"`} `
        + `for ${subjectKey}, not the preset "${target.noise}" these sliders write. `
        + `<b>record</b> writes the assets.csv row (surface="${surfaceCell()}") that points it here. `
        + `For the player's own seal, the tuner's "Seal wetness" panel edits the base directly.`
        + `</output>`;
      wetSect.querySelector('.body').prepend(warn);
    }
    p.appendChild(wetSect);
  }

  if (on.biolum) p.appendChild(section('pattern', 'biolumSkin', target.bio, BIO, (body, name) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>pattern</label><select></select><output></output>`;
    const sel = row.querySelector('select');
    for (const n of BIOLUM_PATTERNS) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    }
    sel.value = valOf('pattern', 'biolumSkin', name, { key: 'pattern', def: 'blotches' });
    sel.addEventListener('change', () => {
      setVal('biolumSkin', name, 'pattern', sel.value);
      commit(); draw(); dumpJson();
    });
    body.appendChild(row);
    for (const [k, lbl, d] of [['colorA', 'colour A', 0x6b5636], ['colorB', 'colour B', 0x9c855a],
      ['colorC', 'colour C', 0xd8c79a], ['shellColor', 'between', 0x101820]]) {
      colorRow(body, 'biolumSkin', name, k, lbl, d);
    }
  }));

  p.appendChild(section('outline', 'creatureOutline', null, OUTLINE, (body) => {
    // The view switch first, because it is the one that decides whether any of
    // the rest of this section is visible on the model at all.
    const see = document.createElement('div');
    see.className = 'row';
    see.innerHTML = `<label>show rim</label>
      <input type="checkbox" ${showRim ? 'checked' : ''}>
      <output>${showRim ? '' : 'hidden'}</output>`;
    see.querySelector('input').addEventListener('change', (e) => {
      showRim = e.target.checked;
      see.querySelector('output').textContent = showRim ? '' : 'hidden';
      applyRimVisibility();
      draw();
    });
    body.appendChild(see);

    // WHOSE RIM IS THIS. A companion wears one from a different config root
    // that this section cannot reach, and without saying so the sliders read as
    // broken — they move, the readouts change, the model does not.
    if (CONFIG.companionOutline?.on?.[subjectKey]) {
      const warn = document.createElement('div');
      warn.className = 'row warnrow';
      warn.innerHTML = '<label>companion</label><output>'
        + 'this one wears the COMPANION rim (CONFIG.companionOutline, the yellow one), '
        + 'which the sliders below do not control — they are creatureOutline. '
        + 'Use "show rim" above to get it out of the way.'
        + '</output>';
      body.appendChild(warn);
    }
    colorRow(body, 'creatureOutline', null, 'color', 'colour', 0xff7a3d);
    // The per-species switch, which IS per species even though the look is not.
    const row = document.createElement('div');
    row.className = 'row';
    const on = CONFIG.creatureOutline?.on ?? {};
    const listed = subjectKey in on;
    row.innerHTML = `<label>on ${listed ? '' : '(unlisted)'}</label>
      <input type="checkbox" ${on[subjectKey] ? 'checked' : ''} ${listed ? '' : 'disabled'}>
      <output>${listed ? '' : 'not in .on'}</output>`;
    const box = row.querySelector('input');
    box.addEventListener('change', () => {
      // Written straight into CONFIG rather than into `edited`: this is a
      // per-species switch, not part of the shared look block the textarea
      // emits, and rolling it into that block would paste a roster change in
      // with a colour change.
      CONFIG.creatureOutline.on[subjectKey] = box.checked;
      commit(); draw();
      status(`${subjectKey} rim ${box.checked ? 'on' : 'off'} — switch is per species, the look below is shared`);
    });
    body.appendChild(row);
  }));

  const btns = document.createElement('div');
  btns.className = 'btns';
  // "record", not "apply", and the difference USED to be the whole of a bug
  // report. It no longer is: the button writes tools/looks/shader-lab.json AND
  // the server applies it on the same request (see the POST handler in
  // tools/looks/serve.mjs, which imports applyRecorded from
  // tools/apply-shaders.mjs). One press moves the choice into assets.csv, the
  // numbers into config.js, and clears those presets out of
  // imported-tuning.json so the new values are what boots.
  //
  // The name stayed anyway. `record` says what the button is FOR — pinning this
  // creature's look — where "apply" invited the reading that the whole roster
  // had just moved, and the write is deliberately scoped to one creature (see
  // `recorded` below). Running `npm run shaders:apply --all` by hand is still
  // possible and still replays the whole document, which is why it needs a flag.
  //
  // THE SERVER STILL CANNOT REACH THE RUNNING GAME. It reads config.js as TEXT
  // and never imports it, so the rule this page was built under holds: a look
  // page does not race the game's tuning (SERVERS.md). The tuning clear is
  // refused outright while a dev server is up.
  //
  // Labelled "apply to enemyOrcaBull", it read as the whole job being done when
  // it was half of it — the second step was never run and the choice appeared
  // not to work. That is the history the name is carrying.
  btns.innerHTML = `<button class="act" id="bApply">record ${subjectKey}</button>
    <button class="act" id="bSave">save presets</button>
    <button class="act" id="bShot">save frame</button>
    <button class="act warn" id="bReset">reset edits</button>`;
  p.appendChild(btns);

  const ta = document.createElement('textarea');
  ta.id = 'json';
  ta.spellcheck = false;
  p.appendChild(ta);

  $('bApply').addEventListener('click', apply);
  $('bSave').addEventListener('click', save);
  $('bShot').addEventListener('click', shot);
  $('bReset').addEventListener('click', () => {
    for (const k of Object.keys(edited)) edited[k] = {};
    build(subjectKey);
    status('edits dropped — CONFIG values restored');
  });
  dumpJson();
}

// The paste-ready block. Only what has actually been EDITED, so pasting cannot
// bury an unrelated CONFIG value under a number nobody chose — the same rule the
// tuner row learned the hard way.
function dumpJson() {
  const out = editedBlock();
  const t = $('json');
  if (t) t.value = Object.keys(out).length
    ? JSON.stringify(out, null, 2)
    : '// nothing edited yet — move a slider';
}

// Pin the current layers and their numbers to THIS asset.
//
// What the game needs is two different things and they land in two different
// places, so this writes both rather than pretending one covers it:
//
//   the ASSIGNMENT   which layers enemyOrcaBull wears and under what preset
//                    names — the `surface` column of assets.csv, as a
//                    `+`-joined list (see path/src/assetTable.js)
//   the NUMBERS      the preset blocks those names point AT, under CONFIG
//
// `layers` REPLACES `surface` in the entry, and both are still read on the way
// back in — see layersFromEntry and cellFor in tools/apply-shaders.mjs. The 26
// creatures recorded before this existed are in the file under the old key and
// must keep opening on the switches they were recorded with.
//
// Written to disk for a human to move across, NOT applied to the running game:
// this page is a vite build with no dev server behind it and it must never
// reach imported-tuning.json. See SERVERS.md.
async function apply() {
  const on = layersOf(subjectKey);
  const layerNames = {
    noise: on.noise ? target.noise : null,
    toon: on.toon ? target.toon : null,
    biolum: on.biolum ? target.bio : null,
  };
  applied[subjectKey] = {
    // `surface` kept as a HUMAN-READABLE summary of the same thing, so a diff of
    // shader-lab.json still reads as English. Nothing parses it any more —
    // layersFromEntry prefers `layers` whenever it is there — so the two cannot
    // drift into disagreeing about what was recorded.
    surface: describeLayers(on),
    layers: layerNames,
    assets: {
      noiseShader: layerNames.noise,
      toonShade: layerNames.toon,
      biolumSkin: layerNames.biolum,
      csvSkinColumn: layerNames.biolum,
    },
    presets: presetsFor(on),
  };
  let r;
  try {
    const res = await fetch('/shader/shader-lab.json', {
      method: 'POST',
      // `recorded` NAMES THE SUBJECT, and the write is scoped to it. This file
      // keeps every creature ever recorded, each with its own copy of the
      // presets it wore AT THE TIME — so applying the whole document would let
      // a snapshot from this morning overwrite the preset edited a moment ago.
      // The entry written on the line above is the only one known to be current.
      // Without this key the server saves the file and writes nothing.
      body: JSON.stringify({ applied, config: editedBlock(), recorded: subjectKey }, null, 2) + '\n',
    });
    if (!res.ok) throw new Error(await res.text());
    // The server writes assets.csv and config.js as part of the same request and
    // reports what it did, so the button can say the change LANDED rather than
    // naming a command to run next.
    r = await res.json().catch(() => ({}));
  } catch (err) {
    status('record failed: ' + err.message, true);
    return;
  }

  // PAST THIS LINE THE WRITE HAS LANDED. Nothing below may report a failure,
  // and that is why it is outside the try rather than inside it: composing the
  // status used to sit in the same block as the fetch, so a ReferenceError in
  // the success message printed "record failed" over a record that had just
  // written both files. Someone reads that and tunes it all again.
  if (r.error) { status(`saved, but the write failed: ${r.error}`, true); return; }
  const bits = [];
  if (r.rows?.length) bits.push(`assets.csv ${r.rows.length} row(s)`);
  if (r.presets?.length) bits.push(`config.js +${r.presets.join(', ')}`);
  // A note is the interesting case — an asset with no CSV row, a comment left
  // arguing for a number that just moved, or a dev server up whose saved
  // tuning still shadows what was written. `~` lines are the per-field diff
  // and belong in the terminal rather than in a one-line status.
  const warn = (r.notes ?? []).filter((n) => n.startsWith('!') || n.startsWith('?'));
  // The LAYER LIST, not a surface kind. There is no single `kind` any more —
  // a creature wears any combination of noise/toon/biolum — and this is the
  // same summary `applied[subjectKey].surface` is written with above, so the
  // status and the recorded document cannot describe the record differently.
  const wearing = describeLayers(on);
  status(warn.length
    ? `${subjectKey} → ${wearing}. ${bits.join(', ') || 'no change'} — ${warn.join(' · ')}`
    : `${subjectKey} → ${wearing} — ${bits.join(', ') || 'already up to date'}. Reload the game to see it.`,
  warn.length ? 'warn' : '');
  renderList();
}

// Only the presets the switched-on layers actually use, so a recorded pattern
// does not carry a noise block nobody will read.
// THE WHOLE PRESET, not just the sliders that were moved.
//
// This used to send `edited` — the deltas from this page session — so recording
// a creature you had not touched sent `presets: {}`. The CSV then named a preset
// that nothing anywhere defined, and the game fell back to the base numbers: the
// creature came out looking nothing like the preview, with no error to explain
// it. Recording a look has to carry the look.
//
// Read through valOf, so what is written is exactly what the panel is showing:
// edited value, else the preset in CONFIG, else the base, else the control's own
// default. Rendering is not editing — see the note on the tuner row — but this
// is a deliberate act of recording, which is when the effective value IS the
// value you mean.
function presetsFor(on) {
  const gather = (title, root, name, specs) => {
    if (!name) return {};
    const fields = {};
    for (const spec of specs) fields[spec.key] = valOf(title, root, name, spec);
    return { [root]: { [name]: fields } };
  };
  // MERGED PER ROOT, not spread side by side. `{...a, ...b}` on two objects that
  // both carry a `sealShader` key keeps only the second — which is how the wet
  // film once got recorded with none of the mottling under it. Three layers
  // that can now be on at once make that a live hazard on every root rather
  // than only on the one pair, so the merge is done here for all of them.
  const out = {};
  const fold = (part) => {
    for (const [root, bag] of Object.entries(part)) {
      for (const [name, fields] of Object.entries(bag)) {
        ((out[root] ??= {})[name] ??= {});
        Object.assign(out[root][name], fields);
      }
    }
  };

  if (on.noise) {
    // NOISE AND WET ARE THE SAME PRESET — both are CONFIG.sealShader.
    fold(gather('noise', 'sealShader', target.noise, NOISE));
    fold(gather('wet', 'sealShader', target.noise, WET));
    // The colour pickers are in neither list, and a recorded look without them
    // is a recorded look with the wrong colours. `baseColor` joins them: it is
    // what `paint` lays down, so recording a covered map without it would write
    // a preset that covers the photograph with a colour nobody chose.
    for (const [k, d] of [['color', 0x0a2233], ['wetColor', 0xdff2ff], ['baseColor', 0xffffff]]) {
      out.sealShader[target.noise][k] = valOf(k, 'sealShader', target.noise, { key: k, def: d });
    }
  }
  if (on.toon) fold(gather('toon', 'toonShade', target.toon, TOON));
  if (on.biolum) {
    fold(gather('pattern', 'biolumSkin', target.bio, BIO));
    const bag = out.biolumSkin?.[target.bio];
    if (bag) {
      // `pattern` is a select rather than a slider, so it is not in BIO — and it
      // is the one field that decides what the layer even looks like.
      bag.pattern = valOf('pattern', 'biolumSkin', target.bio, { key: 'pattern', def: 'blotches' });
      for (const [k, d] of [['colorA', 0x6b5636], ['colorB', 0x9c855a],
        ['colorC', 0xd8c79a], ['shellColor', 0x101820]]) {
        bag[k] = valOf(k, 'biolumSkin', target.bio, { key: k, def: d });
      }
    }
  }
  return out;
}

function editedBlock() {
  const out = {};
  for (const [root, presets] of Object.entries(edited)) {
    for (const [name, fields] of Object.entries(presets)) {
      if (Object.keys(fields).length) ((out[root] ??= {})[name] = fields);
    }
  }
  return out;
}

async function save() {
  try {
    const res = await fetch('/shader/shader-lab.json', {
      method: 'POST',
      body: JSON.stringify({ applied, config: editedBlock() }, null, 2) + '\n',
    });
    if (!res.ok) throw new Error(await res.text());
    status('saved tools/looks/shader-lab.json — presets for config.js, choices for npm run shaders:apply');
  } catch (err) {
    status('save failed: ' + err.message, true);
  }
}

async function shot() {
  const c = document.createElement('canvas');
  c.width = gl.domElement.width; c.height = gl.domElement.height;
  c.getContext('2d').drawImage(gl.domElement, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await fetch(`/shot/${subjectKey}.png`, { method: 'POST', body: blob });
  status(`wrote ${subjectKey}.png`);
}

// ---------------------------------------------------------------------------
// Roster UI + orbit
// ---------------------------------------------------------------------------
// `buildList` is a REAL declaration, not the name of a function expression
// inside an IIFE. It was the latter, which puts the name in scope only inside
// itself — so apply()'s call to refresh the roster marks threw "buildList is not
// defined" at the moment of saving, i.e. only on the one path nobody exercises
// until the tool is actually being used for its job.
let renderList = () => {};
function buildList() {
  const l = $('list');
  l.innerHTML = '';
  const search = document.createElement('input');
  search.placeholder = 'filter…';
  l.appendChild(search);
  const holder = document.createElement('div');
  l.appendChild(holder);

  const render = (q) => {
    holder.innerHTML = '';
    const add = (heading, keys) => {
      const hit = keys.filter((k) => !q || k.toLowerCase().includes(q));
      if (!hit.length) return;
      const h = document.createElement('div');
      h.className = 'group'; h.textContent = heading;
      holder.appendChild(h);
      for (const k of hit) {
        const b = document.createElement('button');
        // ONE GLYPH PER LAYER, derived from the switches rather than looked up
        // from a table of the three names the picker used to offer. That table
        // returned undefined for every combination outside it, so a creature
        // recorded as anything else came up with no mark at all and read as
        // never recorded.
        const on = layersOf(k);
        const mark = LAYERS.filter(([w]) => on[w])
          .map(([w]) => ({ noise: '~', toon: '=', biolum: '*' })[w]).join('') || '·';
        b.textContent = k.replace(/^enemy/, '') + (applied[k] ? ' ' + mark : '');
        b.title = applied[k]
          ? `${k} — recorded: ${describeLayers(layersOf(k))}`
          : `${k} — ${describeLayers(on)} (from the roster; not recorded here)`;
        if (k === subjectKey) b.className = 'on';
        b.addEventListener('click', () => { build(k); render(search.value.trim().toLowerCase()); });
        holder.appendChild(b);
      }
    };
    add('sharks & orcas', primary);
    add('everything else', rest);
  };
  search.addEventListener('input', () => render(search.value.trim().toLowerCase()));
  // Re-run the CURRENT filter rather than rebuilding the whole panel: apply()
  // only needs the marks to change, and blowing the input away mid-session would
  // clear a filter someone is working inside.
  renderList = () => render(search.value.trim().toLowerCase());
  render('');
}
buildList();

(function orbit() {
  const stage = $('stage');
  let down = false, lx = 0, ly = 0;
  stage.addEventListener('pointerdown', (e) => {
    down = true; lx = e.clientX; ly = e.clientY;
    stage.classList.add('drag'); stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!down) return;
    view.yaw += (e.clientX - lx) * 0.008;
    view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch + (e.clientY - ly) * 0.006));
    lx = e.clientX; ly = e.clientY;
    draw();
  });
  const up = () => { down = false; stage.classList.remove('drag'); };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.zoom = Math.max(0.4, Math.min(4, view.zoom * (1 - Math.sign(e.deltaY) * 0.08)));
    draw();
  }, { passive: false });
})();

build(primary[0] ?? rest[0]);
window.__ready = true;
window.__frames = () => frames;
