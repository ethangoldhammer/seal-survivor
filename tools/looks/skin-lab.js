// ---------------------------------------------------------------------------
// SKIN LAB — banded shading and painted pattern, on one animal, live
//
//   npm run looks:skinlab
//
// The picker (tools/atlas-render/picker.html) settles what an ICON looks like.
// This settles what a CREATURE looks like in the water, and it exists because
// the two halves of that answer were in different places: the cel bands are new
// (systems/toonShade.js) and the pattern controls were spread across the tuner's
// procedural-skins panel and CONFIG.sealShader. Tuning either against the other
// meant alt-tabbing between a slider and a memory of the last look.
//
// THREE STACKED LAYERS, one per section, in the order the shader applies them:
//
//   pattern   biolumSkin — pigment replaces the base colour, glow adds to it
//   noise     noiseShader — Perlin mottling modulating the diffuse
//   toon      toonShade — quantises the light that lands on all of the above
//
// They stack rather than replace, which is the whole reason toonShade injects
// into MeshStandardMaterial instead of swapping in a MeshToonMaterial the way
// the icon renderer does. A swap would drop the emissive map, both injections
// above, and the roughness CONFIG.bloom is tuned against.
//
// WHAT IT WRITES: nothing, by itself. `save` POSTs a JSON of the presets you
// have edited to the look server, which drops it next to the shots; the
// textarea holds the same thing as a config.js-shaped block to paste. It never
// touches imported-tuning.json — this is a vite BUILD with no dev server behind
// it, per SERVERS.md.
//
// ONE GL CONTEXT for the page. A renderer per panel goes black past a dozen.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual, ASSETS } from '../../path/src/assets.js';
import { attachBiolumSkin, applyBiolumSkinSettings, updateBiolumSkin, BIOLUM_PATTERNS } from '../../path/src/systems/biolumSkin.js';
import { attachNoiseShader, applyNoiseSettings } from '../../path/src/systems/noiseShader.js';
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
const view = { yaw: 0.5, pitch: 0.35, zoom: 1 };

// The preset each layer is editing for the current subject. Defaults to a name
// derived from the asset so two sharks can share one and an orca can differ.
const target = { toon: 'shark', noise: 'shark', bio: null };

function presetFor(assetKey) {
  if (/orca/i.test(assetKey)) return 'orca';
  if (/shark|meg|hammer|mosasaur/i.test(assetKey)) return 'shark';
  return 'hide';
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

// Merge the edits into the live CONFIG so the real apply* functions see them.
// Written into CONFIG rather than pushed at uniforms directly, deliberately: the
// point is to exercise the same path the game uses, so a look that works here
// works there. Nothing saves CONFIG, and this page cannot reach the tuning file.
function commit() {
  for (const [root, presets] of Object.entries(edited)) {
    const c = (CONFIG[root] ??= {});
    const bag = (c.presets ??= {});
    for (const [name, fields] of Object.entries(presets)) {
      if (name === '__flat') { Object.assign(c, fields); continue; }
      bag[name] = { ...(bag[name] ?? {}), ...fields };
    }
  }
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
function frameSubject() {
  subject.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  subject.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.__isOutline) return;
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    // The geometry's own box through the mesh's world matrix. Good enough for a
    // frame — this is not the skinned-vertex measurement the icon renderer needs,
    // because nothing here is posed away from where its bounds say it is.
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    for (const [x, y, z] of [[b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z],
      [b.min.x, b.max.y, b.min.z], [b.max.x, b.min.y, b.max.z],
      [b.min.x, b.min.y, b.max.z], [b.max.x, b.max.y, b.min.z],
      [b.min.x, b.max.y, b.max.z], [b.max.x, b.min.y, b.min.z]]) {
      box.expandByPoint(o.localToWorld(p.set(x, y, z)));
    }
  });
  if (box.isEmpty()) box.setFromObject(subject);
  const size = new THREE.Vector3(); const centre = new THREE.Vector3();
  box.getSize(size); box.getCenter(centre);
  const span = Math.max(size.x, size.y, size.z, 1e-4);
  const back = span * 1.9 / view.zoom;
  camera.position.set(
    centre.x + back * Math.cos(view.pitch) * Math.sin(view.yaw),
    centre.y + back * Math.sin(view.pitch),
    centre.z + back * Math.cos(view.pitch) * Math.cos(view.yaw),
  );
  camera.lookAt(centre);
  return size;
}

function build(assetKey) {
  if (subject) scene.remove(subject);
  subjectKey = assetKey;
  const p = presetFor(assetKey);
  target.toon = p; target.noise = p;
  target.bio = (CONFIG.biolumSkin?.presets?.[p]) ? p : 'hide';

  const visual = createVisual(assetKey);
  if (!visual) { status(`createVisual returned nothing for ${assetKey}`, true); return; }
  // Lay the body flat. createVisual points a creature forward at world +Y — nose
  // up — and a nose-up animal in a square panel is a thin vertical sliver that
  // says nothing about its surface. Same rotation as every preview in this folder.
  visual.rotation.z = -Math.PI / 2;
  subject = visual;
  scene.add(visual);
  const size = frameSubject();
  axis = size.x >= size.y && size.x >= size.z ? 'x' : (size.y >= size.z ? 'y' : 'z');

  // CLONE FIRST, ATTACH SECOND, ALWAYS. createVisual hands back instances that
  // SHARE the asset's materials, so attaching in place would paint every other
  // creature made from the same asset — and three's Material.clone() drops
  // onBeforeCompile, so cloning after an attach silently throws the shader away.
  let count = 0;
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
      if ('__originalMap' in m.userData) c.map = m.userData.__originalMap ?? null;
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
      count++;
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
  });

  commit();
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
  $('notes').textContent =
    `${assetKey} — ${ASSETS[assetKey].model}\n`
    + `${count} material(s) painted · long axis ${axis} · `
    + `toon preset "${target.toon}" · noise preset "${target.noise}" · pattern preset "${target.bio}"`;
  draw();
}

let frames = 0;
function draw() {
  if (!subject) return;
  frameSubject();
  // The biolum shader animates off a clock; stepped by hand rather than in a rAF
  // loop so the page works in a backgrounded tab, where rAF does not fire.
  updateBiolumSkin?.(1 / 60);
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

  p.appendChild(section('toon', 'toonShade', target.toon, TOON));

  p.appendChild(section('noise', 'sealShader', target.noise, NOISE, (body, name) => {
    colorRow(body, 'sealShader', name, 'color', 'tint', 0x0a2233);
  }));

  p.appendChild(section('pattern', 'biolumSkin', target.bio, BIO, (body, name) => {
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
  btns.innerHTML = `<button class="act" id="bSave">save presets</button>
    <button class="act" id="bShot">save frame</button>
    <button class="act warn" id="bReset">reset edits</button>`;
  p.appendChild(btns);

  const ta = document.createElement('textarea');
  ta.id = 'json';
  ta.spellcheck = false;
  p.appendChild(ta);

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
  const out = {};
  for (const [root, presets] of Object.entries(edited)) {
    for (const [name, fields] of Object.entries(presets)) {
      if (Object.keys(fields).length) ((out[root] ??= {})[name] = fields);
    }
  }
  const t = $('json');
  if (t) t.value = Object.keys(out).length
    ? JSON.stringify(out, null, 2)
    : '// nothing edited yet — move a slider';
}

async function save() {
  try {
    const res = await fetch('/skin/skin-lab.json', {
      method: 'POST',
      body: JSON.stringify({ edited, subject: subjectKey }, null, 2) + '\n',
    });
    if (!res.ok) throw new Error(await res.text());
    status('saved skin-lab.json next to the shots — paste the block into config.js');
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
(function buildList() {
  const l = $('list');
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
        b.textContent = k.replace(/^enemy/, '');
        b.title = k;
        if (k === subjectKey) b.className = 'on';
        b.addEventListener('click', () => { build(k); render(search.value.trim().toLowerCase()); });
        holder.appendChild(b);
      }
    };
    add('sharks & orcas', primary);
    add('everything else', rest);
  };
  search.addEventListener('input', () => render(search.value.trim().toLowerCase()));
  render('');
})();

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
