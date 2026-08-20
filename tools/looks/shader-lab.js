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
// ONE SURFACE AT A TIME, picked at the top of the panel:
//
//   texture   the model's own baked map, untouched
//   noise     noiseShader — Perlin mottling, quantised by toonShade's bands
//   biolum    biolumSkin — a pattern at full pigment, replacing the map
//
// The three are exclusive rather than stacked: a body carrying both a noise
// field and a biolum pattern wears two unrelated paints and reads as
// double-textured. toonShade still injects into MeshStandardMaterial rather
// than swapping in a MeshToonMaterial the way the icon renderer does — a swap
// would drop the emissive map, the noise injection, and the roughness
// CONFIG.bloom is tuned against.
//
// WHAT IT WRITES, and it is two different things:
//
//   `record`  the chosen surface for one creature, into
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

const status = (m, err) => { $('status').textContent = m; $('status').className = err ? 'err' : ''; };

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

// WHICH SURFACE IS PAINTING. Exactly one, ever.
//
//   texture   the model's own baked map, untouched
//   noise     procedural Perlin mottling, banded by the toon step
//   biolum    a biolumSkin pattern at full pigment, replacing the map
//
// EXCLUSIVE BY DESIGN, and it took a bad render to make that obvious. Left free
// to stack, the noise field and a biolum pattern paint two unrelated fields on
// one body and the animal reads as double-textured — which is exactly the note
// noiseShader.js's own header makes about attaching a biolum skin to the seal.
// They are three answers to one question, not three layers.
//
// Held per ASSET, because that is the unit the game opts in — `noiseShader:` /
// `biolumSkin:` / `toonShade:` are per-asset fields in ASSETS.
const surfaces = new Map();   // assetKey -> 'texture' | 'noise' | 'biolum'
const presetNames = new Map();// assetKey -> { noise, toon, bio } — see defaultPresetFor
const applied = {};           // assetKey -> what `record` pinned, for shader-lab.json
const SURFACES = [
  ['texture', 'photo texture', "the model's own baked map"],
  ['noise', 'noise + toon', 'procedural mottling, banded'],
  ['biolum', 'biolum pattern', 'pigment replaces the map'],
];
const surfaceOf = (k) => surfaces.get(k) ?? 'texture';

// SEEDED FROM THE ROSTER FIRST — what the GAME does today.
//
// ASSETS is the authority on which surface a creature is actually wearing: the
// `surface` column of assets.csv is applied onto these fields at load, and some
// assets declare it in code and have no CSV row at all. The seed below is the
// only thing that can see the second kind.
//
// WITHOUT THIS THE SEAL OPENED ON `texture`. `ship` — the player, and the asset
// this whole shader was written for — carries `noiseShader: true` by hand in
// assets.js and has never been through `record`, so nothing in shader-lab.json
// mentions it. Selecting it showed the texture surface, no noise panel and no
// wet panel, over a model that renders in the run with both. The page was
// reporting its own record file as if it were the game, and for every
// hand-authored asset those are different things.
//
// EXCLUSIVE, in the same priority the game resolves them: biolum replaces the
// map outright, so it wins over a noise field if some def ever declares both.
for (const [key, def] of Object.entries(ASSETS)) {
  if (!def.model) continue;
  if (typeof def.biolumSkin === 'string') surfaces.set(key, 'biolum');
  else if (def.noiseShader) surfaces.set(key, 'noise');
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
try {
  const saved = await (await fetch('/shader/shader-lab.json')).json();
  for (const [key, entry] of Object.entries(saved.applied ?? {})) {
    applied[key] = entry;
    if (entry.surface) surfaces.set(key, entry.surface);
  }
} catch {
  // No file yet, or no server behind the page. Neither is worth a warning: this
  // is the normal first run.
}

// Force the layers to agree with the choice.
//
// APPLIED AS A MASK AT COMMIT TIME, NEVER STORED. The first version wrote the
// zeros into `edited` and read them back as the layer's "remembered" strength —
// so selecting `noise` restored the 0 that selecting `texture` had just saved,
// and the noise surface silently stayed off. `edited` holds what a human
// actually dialled; this only decides which of it reaches the GPU.
function surfaceMask(kind) {
  return {
    // `wet` as well as `strength`, or the preview lies about the choice: the
    // film is a separate layer on the same root, so zeroing the mottling alone
    // left a gloss on an animal whose surface column says `texture` — and in
    // the game a texture surface never attaches this shader at all, so there is
    // nothing there to be glossy.
    sealShader: kind === 'noise' ? null : { strength: 0, wet: 0 },
    toonShade: kind === 'noise' ? null : { strength: 0 },
    biolumSkin: kind === 'biolum' ? { pigment: 1 } : { pigment: 0, strength: 0 },
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
  { key: 'pigment', label: 'pigment', min: 0, max: 1, step: 0.02, def: 1 },
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

  // 3. ...then the surface mask over the top, so exactly one layer paints.
  const mask = surfaceMask(surfaceOf(subjectKey));
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
      if (orig === null) c.map = null;
      else if (orig?.isTexture) c.map = orig;
      // else: a descriptor, not a texture. Leave the clone's own map alone —
      // it is the one the asset is actually wearing.
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

  // The choice, first — everything below it is the settings FOR that choice.
  const pick = document.createElement('div');
  pick.className = 'sect';
  pick.innerHTML = `<h3><span>surface</span><span class="en">${subjectKey}</span></h3><div class="body"></div>`;
  const pb = pick.querySelector('.body');
  for (const [val, label, hint] of SURFACES) {
    const row = document.createElement('label');
    row.className = 'surf';
    row.innerHTML = `<input type="radio" name="surface" value="${val}"
      ${surfaceOf(subjectKey) === val ? 'checked' : ''}><b>${label}</b><i>${hint}</i>`;
    row.querySelector('input').addEventListener('change', () => {
      surfaces.set(subjectKey, val);
      enforceSurface();
      buildPanels();
      draw();
      status(`${subjectKey}: ${label}`);
    });
    pb.appendChild(row);
  }

  // WHICH PRESET THIS SPECIES WRITES TO, on the surface panel rather than buried,
  // because it is the difference between tuning one animal and tuning a family.
  // Two species pointed at one name share it deliberately and can see that they
  // do; the old behaviour shared it by accident and showed nothing.
  const kindNow = surfaceOf(subjectKey);
  if (kindNow !== 'texture') {
    const slot = kindNow === 'biolum' ? 'bio' : 'noise';
    const pr = document.createElement('div');
    pr.className = 'row';
    pr.innerHTML = `<label>preset</label><input type="text" value="${target[slot]}"><output></output>`;
    const inp = pr.querySelector('input');
    const commitName = () => {
      const name = inp.value.trim();
      if (!name || name === target[slot]) return;
      if (slot === 'bio') target.bio = name;
      else { target.noise = name; target.toon = name; }
      presetNames.set(subjectKey, { ...target });
      commit(); buildPanels(); draw();
      const shared = [...presetNames.entries()]
        .filter(([k, v]) => k !== subjectKey && (slot === 'bio' ? v.bio : v.noise) === name)
        .map(([k]) => k);
      status(shared.length
        ? `preset "${name}" — SHARED with ${shared.join(', ')}; editing it moves them too`
        : `preset "${name}" — used by ${subjectKey} alone`);
    };
    inp.addEventListener('change', commitName);
    pb.appendChild(pr);
  }

  p.appendChild(pick);

  const kind = surfaceOf(subjectKey);
  if (kind === 'noise') {
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

  if (kind === 'noise') p.appendChild(section('noise', 'sealShader', target.noise, NOISE, (body, name) => {
    colorRow(body, 'sealShader', name, 'color', 'tint', 0x0a2233);
  }));

  // THE WET FILM, on the same root and the same preset as the noise above, in a
  // section of its own — see the note on WET.
  if (kind === 'noise') {
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
        + `<b>record</b> writes the assets.csv row that points it here. `
        + `For the player's own seal, the tuner's "Seal wetness" panel edits the base directly.`
        + `</output>`;
      wetSect.querySelector('.body').prepend(warn);
    }
    p.appendChild(wetSect);
  }

  if (kind === 'biolum') p.appendChild(section('pattern', 'biolumSkin', target.bio, BIO, (body, name) => {
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

// Pin the current surface and its numbers to THIS asset.
//
// What the game needs is two different things and they land in two different
// places, so this writes both rather than pretending one covers it:
//
//   the ASSIGNMENT   which surface enemyOrcaBull wears — an ASSETS field
//                    (`noiseShader:` / `biolumSkin:` / `toonShade:`), or the
//                    `skin` column of assets.csv for the biolum case
//   the NUMBERS      the preset block those fields point AT, under CONFIG
//
// Written to disk for a human to move across, NOT applied to the running game:
// this page is a vite build with no dev server behind it and it must never
// reach imported-tuning.json. See SERVERS.md.
async function apply() {
  const kind = surfaceOf(subjectKey);
  const assignment = {
    texture: { note: 'no procedural surface — remove any noiseShader/biolumSkin field' },
    noise: { noiseShader: target.noise, toonShade: target.toon },
    biolum: { biolumSkin: target.bio, csvSkinColumn: target.bio },
  }[kind];
  applied[subjectKey] = { surface: kind, assets: assignment, presets: presetsFor(kind) };
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
    const r = await res.json().catch(() => ({}));
    if (r.error) { status(`saved, but the write failed: ${r.error}`, true); return; }
    const bits = [];
    if (r.rows?.length) bits.push(`assets.csv ${r.rows.length} row(s)`);
    if (r.presets?.length) bits.push(`config.js +${r.presets.join(', ')}`);
    // A note is the interesting case — an asset with no CSV row, a comment left
    // arguing for a number that just moved, or a dev server up whose saved
    // tuning still shadows what was written. `~` lines are the per-field diff
    // and belong in the terminal rather than in a one-line status.
    const warn = (r.notes ?? []).filter((n) => n.startsWith('!') || n.startsWith('?'));
    status(warn.length
      ? `${subjectKey} → ${kind}. ${bits.join(', ') || 'no change'} — ${warn.join(' · ')}`
      : `${subjectKey} → ${kind} — ${bits.join(', ') || 'already up to date'}. Reload the game to see it.`,
    warn.length > 0);
    renderList();
  } catch (err) {
    status('record failed: ' + err.message, true);
  }
}

// Only the presets the chosen surface actually uses, so a saved `biolum` choice
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
function presetsFor(kind) {
  const gather = (title, root, name, specs) => {
    if (!name) return {};
    const fields = {};
    for (const spec of specs) fields[spec.key] = valOf(title, root, name, spec);
    return { [root]: { [name]: fields } };
  };
  if (kind === 'noise') {
    // NOISE AND WET ARE THE SAME PRESET, so the two lists have to be MERGED
    // rather than spread side by side — `{...a, ...b}` on two objects that both
    // carry a `sealShader` key keeps only the second, and the recorded preset
    // would come out holding the film and none of the mottling under it.
    const noise = gather('noise', 'sealShader', target.noise, NOISE);
    const wet = gather('wet', 'sealShader', target.noise, WET);
    if (noise.sealShader && wet.sealShader) {
      Object.assign(noise.sealShader[target.noise], wet.sealShader[target.noise]);
      // `color` and `wetColor` are colour pickers rather than sliders, so they
      // are in neither list — and a recorded look without them is a recorded
      // look with the wrong colours.
      for (const [k, d] of [['color', 0x0a2233], ['wetColor', 0xdff2ff]]) {
        noise.sealShader[target.noise][k] = valOf(k, 'sealShader', target.noise, { key: k, def: d });
      }
    }
    return { ...noise, ...gather('toon', 'toonShade', target.toon, TOON) };
  }
  if (kind === 'biolum') {
    // `pattern` is a select rather than a slider, so it is not in BIO — and it
    // is the one field that decides what the surface even looks like.
    const out = gather('pattern', 'biolumSkin', target.bio, BIO);
    const bag = out.biolumSkin?.[target.bio];
    if (bag) {
      bag.pattern = valOf('pattern', 'biolumSkin', target.bio, { key: 'pattern', def: 'blotches' });
      for (const [k, d] of [['colorA', 0x6b5636], ['colorB', 0x9c855a],
        ['colorC', 0xd8c79a], ['shellColor', 0x101820]]) {
        bag[k] = valOf(k, 'biolumSkin', target.bio, { key: k, def: d });
      }
    }
    return out;
  }
  return {};
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
        const mark = applied[k] ? ({ texture: '·', noise: '~', biolum: '*' })[applied[k].surface] : '';
        b.textContent = k.replace(/^enemy/, '') + (mark ? ' ' + mark : '');
        b.title = applied[k] ? `${k} — applied: ${applied[k].surface}` : k;
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
