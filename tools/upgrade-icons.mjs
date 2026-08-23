#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Builds the render spec for the upgrade hex icons.
//
//   node --import ./tools/vite-loader.mjs tools/upgrade-icons.mjs
//   node tools/atlas-render/server.mjs --out <scratch>
//   open http://localhost:4599/render.html?list=icons.json
//
// Writes tools/atlas-render/icons.json — the same spec shape render.html
// already consumes for the Model Atlas, so the renderer needs no icon-specific
// code beyond the per-spec `yaw`/`pitch`/`clipAt`/`square` fields.
//
// DELIBERATELY NOT list.json. That name belongs to the atlas run (see
// tools/atlas-build.mjs), which generates its own into a scratch directory and
// copies it here; two different spec lists under one filename is how you render
// seventy-nine enemies when you asked for nineteen icons.
//
// EVERY FIELD COMES OFF THE ASSET TABLE. `file`, `forward`, `up` and the clip
// names are read from ASSETS, not retyped here: those axes are the ones the
// game orients each model by, and an icon shot down a different basis than the
// one the player sees it in is a drawing of a different animal. The only
// hand-authored column is which asset each upgrade points AT.
//
// --bake <dir> is the second half of the round trip: it reads the PNGs the
// renderer wrote and emits path/src/ui/upgradeIcons.js with each one embedded
// as a data URI. Embedded rather than served out of public/ for the reason
// levelUpImages.js gives for doing the same thing — it keeps the art working
// across the dev and playtest builds with no file juggling between them.
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';
import { SCENES } from './icon-scenes.mjs';
import { ICON_FORMATS } from './atlas-render/icon-formats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'atlas-render/icons.json');
const MODULE_OUT = join(HERE, '../path/src/ui/upgradeIcons.js');

// upgrade id -> the asset whose model stands for it.
//
// Most of these are the asset the ability actually spawns, read off the
// createVisual() call in its system. Four are STAND-INS, marked as such: the
// upgrade grants no object of its own, so the icon borrows the body the card is
// about. Maneater is the shark you are becoming, not a thing you fire.
//
// Upgrades absent from this table have nothing to render — either their asset
// is a primitive (`missile` is a black oval, `shrapnel` an octahedron) or they
// grant no object at all (Sea Garlic is an aura, Yoga is a number). Those need
// drawn marks; see the hex prototype's notes. Starfish Shuriken is absent for
// the opposite reason: it already ships five drawn .webp sea stars, which are
// better icons than any render of them would be.
const ICON_ASSETS = {
  shrimpRing: 'shrimp',
  seagullBomb: 'seagull',
  sealTeam: 'sealTeam',
  beluga: 'belugaDrone',
  electricEel: 'eelCompanion',
  harp: 'harp',
  octoGrab: 'octoGrabber',
  dumbo: 'dumboOcto',
  bakalar: 'bakalarBoat',
  orcaFamily: 'orcaFriendBull',
  club: 'club',
  scallopSquirter: 'scallopShell',
  maneater: 'enemyGreatWhite',   // stand-in: the taste you have developed
  ironLung: 'whale',             // stand-in: the lungs you want
  dolphinPod: 'enemyDolphin',    // currently disabled, kept so it is ready
};

// --- scenes ---------------------------------------------------------------
//
// A scene part names an ASSET; everything about that asset is looked up here
// rather than typed in tools/icon-scenes.mjs, for the same reason the single
// -model specs derive theirs — a model swapped in the game is swapped in the
// icons too, and an icon shot down a different basis than the one the player
// sees is a picture of a different thing.
//
// An asset WITHOUT a model resolves to its own `shape`. That is most of what
// these scenes are made of: the stone, the mussel, the strike orb and the
// shrapnel are all primitives in the game, and this is what makes the stone in
// the icon the game's stone rather than a sphere that looks like it.
const SHAPE_ARGS = {
  // Only the fields that decide the SHAPE. Size is not among them: every part
  // is normalised to a unit bounding sphere before it is placed, so a radius
  // copied from the asset would be scaled straight back out again.
  oval: (d) => ({ elongate: d.elongate ?? 1.8 }),
  cone: (d) => ({ height: (d.height ?? 1) / (d.radius || 1) }),
  box: (d) => ({ width: d.width ?? 1, height: d.height ?? 1, depth: d.depth ?? 1 }),
  ring: (d) => ({ inner: (d.innerRadius ?? 0.8) / (d.radius || 1), outer: 1 }),
  torus: (d) => ({ tube: (d.tube ?? 0.12) / (d.radius || 1) }),
};

function resolvePart(part, upgradeId) {
  // Authored geometry — an aura ring, a beam, a motion streak. These have no
  // asset to borrow because in the game they are shader passes, not objects.
  if (part.prim) return { ...part };

  const def = ASSETS[part.asset];
  if (!def) throw new Error(`${upgradeId}: scene names no asset "${part.asset}"`);

  const placement = {
    at: part.at, rot: part.rot, scale: part.scale,
    ...(part.color != null ? { color: part.color } : {}),
    ...(part.opacity != null ? { opacity: part.opacity } : {}),
    ...(part.ink === false ? { ink: false } : {}),
  };

  if (def.model) {
    const file = def.model.replace(/^\/models\//, '');
    return {
      asset: part.asset,
      file,
      fmt: file.endsWith('.fbx') ? 'fbx' : 'glb',
      forward: def.forward ?? '+Z',
      up: def.up ?? '+Y',
      ...(def.meshIndex != null ? { meshIndex: def.meshIndex } : {}),
      ...(def.animations ? { wantClips: def.animations } : {}),
      ...(part.clip ? { clip: def.animations?.[part.clip] ?? part.clip } : {}),
      ...(part.clipAt != null ? { clipAt: part.clipAt } : {}),
      ...placement,
    };
  }

  if (!def.shape) throw new Error(`${upgradeId}: asset "${part.asset}" has neither a model nor a shape`);
  return {
    asset: part.asset,
    prim: def.shape,
    color: part.color ?? def.color ?? 0xffffff,
    ...(SHAPE_ARGS[def.shape]?.(def) ?? {}),
    ...placement,
  };
}

// --- bake mode ------------------------------------------------------------
//
// DRIVEN BY THE SPEC LIST, not by whatever files happen to be in the directory.
//
// That was the old behaviour and it cannot express the three kinds: it embedded
// every PNG it found, so a render left over from before an upgrade was switched
// to a drawn file would still be baked, and an upgrade deliberately set to `none`
// was indistinguishable from one whose render had simply failed. icons.json is
// the decision; this reads it and does what it says.
const bakeArg = process.argv.indexOf('--bake');
if (bakeArg > -1) {
  const dir = process.argv[bakeArg + 1];
  // --strict: WRITE NOTHING IF ANYTHING NAMED IS ABSENT.
  //
  // A bake is a full overwrite of upgradeIcons.js, and the shots directory is a
  // scratch folder that gets wiped. So the ordinary failure — running a bake
  // against a directory holding one PNG because you only re-shot one icon — is
  // not "one icon is stale", it is FORTY-SIX ICONS SILENTLY DELETED, and the
  // only symptom is a hive that has gone back to letters. Reported-and-continue
  // is right at a terminal where a human reads the log; it is wrong behind a
  // button, so the button passes this.
  const strict = process.argv.includes('--strict');
  const list = JSON.parse(await readFile(OUT, 'utf8'));
  const known = new Set(CONFIG.upgrades.map((u) => u.id));
  // Shared with the upload gate and the preview server — see icon-formats.mjs
  // for why this is not a fourth copy of the list.
  const MIME = ICON_FORMATS;

  const entries = [];
  const missing = [];
  let renders = 0, scenes = 0, images = 0, nones = 0;

  for (const spec of list) {
    if (!known.has(spec.key)) { console.log(`  skipped ${spec.key}: not an upgrade id`); continue; }
    const kind = spec.kind ?? 'render';
    if (kind === 'none') { nones++; continue; }

    let path, mime;
    if (kind === 'image') {
      // A drawn file. `image` is a server path — /sprites/... for art already in
      // the repo, custom/... for something uploaded through the picker — and is
      // resolved back to disk here.
      const rel = spec.image ?? '';
      if (!rel) { missing.push(`${spec.key}: kind "image" with no file named`); continue; }
      path = rel.startsWith('/sprites/')
        ? join(HERE, '../public/sprites', basename(rel))
        : join(HERE, 'atlas-render', rel);
      mime = MIME[rel.slice(rel.lastIndexOf('.')).toLowerCase()] ?? 'image/png';
      images++;
    } else {
      // `render` and `scene` both land here: both are PNGs this tool asked the
      // browser for, under the upgrade's own key. Only the counters tell them
      // apart, and only so the summary line is honest about what was made.
      path = join(dir, `${spec.key}.png`);
      mime = 'image/png';
      if (kind === 'scene') scenes++; else renders++;
    }

    try {
      const b64 = (await readFile(path)).toString('base64');
      entries.push(`  '${spec.key}': 'data:${mime};base64,${b64}',`);
    } catch {
      // Named but not on disk. Reported rather than thrown: one un-rendered icon
      // should not stop the other forty-seven from baking, and the hive falls
      // back to a monogram for anything absent.
      missing.push(`${spec.key}: no file at ${path}`);
      if (kind === 'image') images--;
      else if (kind === 'scene') scenes--;
      else renders--;
    }
  }

  const src = `// Rendered upgrade icons for the hex hive — GENERATED, do not hand-edit.
//
//   node --import ./tools/vite-loader.mjs tools/upgrade-icons.mjs
//   node tools/atlas-render/server.mjs --out <dir>
//   open http://localhost:4599/picker.html                      set each icon
//   open http://localhost:4599/render.html?list=icons.json      bake the renders
//   node --import ./tools/vite-loader.mjs tools/upgrade-icons.mjs --bake <dir>
//
// No resize step in that list any more: the renderer downsamples from its own
// supersample (see \`outSize\`), because an external \`sips -Z\` pass was resampling
// an already-cropped intermediate and roughening the ink line.
//
// Keyed by UPGRADE id, not by asset: several upgrades would point at one model
// (every club card is the same club) and the hive looks its icon up by the id
// it holds. Entries are a mix of RENDERS and DRAWN FILES — icons.json says which
// each one is. An upgrade with no entry here falls back to a monogram, and for
// most of the roster that is the deliberate answer rather than a gap: see
// ui/upgradeHive.js.
export const UPGRADE_ICONS = {
${entries.join('\n')}
};

export const UPGRADE_ICON_KEYS = Object.keys(UPGRADE_ICONS);
`;
  if (strict && missing.length) {
    console.error(`REFUSED to bake: ${missing.length} icon(s) named by icons.json are not on disk.`);
    for (const m of missing) console.error(`  MISSING ${m}`);
    console.error(`\nNothing was written. ${MODULE_OUT} still holds the last good set.`);
    console.error('Shoot the whole list first: render.html?list=icons.json');
    process.exit(2);
  }

  await writeFile(MODULE_OUT, src);
  const kb = (Buffer.byteLength(src) / 1024).toFixed(0);
  console.log(`baked ${entries.length} icons into ${MODULE_OUT} (${kb}KB)`);
  console.log(`  ${renders} rendered, ${scenes} scenes, ${images} drawn, ${nones} deliberately none`);
  for (const m of missing) console.log(`  MISSING ${m}`);
  process.exit(0);
}

// --- what is AUTHORED, and what is DERIVED --------------------------------
//
// The split this whole file turns on. `file`, `fmt`, `forward`, `up`,
// `meshIndex` and the clip names are FACTS about the asset: they are re-read
// from ASSETS on every run, so a model swapped in the game is swapped here too.
// Everything below is a JUDGEMENT someone made with their eyes in picker.html,
// and it is carried forward untouched.
//
// Without this, regenerating would silently flatten every angle ever chosen —
// the tool that exists to write the file would be the thing that destroys the
// work done in it. Merged rather than overwritten, so the two can be run in any
// order any number of times.
const AUTHORED = ['kind', 'image', 'yaw', 'pitch', 'roll', 'zoom', 'clipAt',
                  'bands', 'bandLow', 'bandHigh', 'bandGamma', 'bandSoft',
                  'outline', 'toon', 'square', 'outSize', 'flatColor', 'dropMeshes'];

// The same split, one level down, INSIDE a scene part.
//
// A part's file, format and axes are facts about the asset and are re-read every
// run. WHERE IT SITS IS A JUDGEMENT, and the picker is where that judgement gets
// made — so placement has to survive regeneration exactly as a camera angle
// does. Without this the tool that exists to rebuild the list is the thing that
// throws away an afternoon of moving a stone half a radius to the left.
//
// tools/icon-scenes.mjs is therefore a SEED for these, in the same sense SEEDS
// above is a seed for the per-icon fields: it is what a fresh checkout gets, and
// what the picker writes wins from then on.
const PART_AUTHORED = ['at', 'rot', 'scale', 'color', 'opacity', 'ink', 'clip', 'clipAt'];

// Layer the authored placements from the previous list over freshly resolved
// parts, BY POSITION — and refuse to when position no longer means the same
// thing.
//
// An index is only a safe key while the scene has the same parts in the same
// order. Edit icon-scenes.mjs to add a fish in the middle and every index after
// it now names a different object, so carrying the old placements forward would
// silently put the stone where the fish was. Both mismatches are reported rather
// than repaired: the seed is the newer intent, so it wins, and the message says
// which icon needs re-framing.
function mergeParts(fresh, prior, id, notes) {
  if (!Array.isArray(prior) || !prior.length) return fresh;
  if (prior.length !== fresh.length) {
    notes.push(`${id}: scene now has ${fresh.length} part(s), not ${prior.length} — placements reset to the seed`);
    return fresh;
  }
  return fresh.map((part, i) => {
    const was = prior[i];
    const isNow = part.asset ?? part.prim;
    const wasIt = was.asset ?? was.prim;
    if (isNow !== wasIt) {
      notes.push(`${id}: part ${i} is now "${isNow}", was "${wasIt}" — its placement reset to the seed`);
      return part;
    }
    // OVERWRITTEN WHERE PRESENT, never deleted. The per-icon merge above does
    // delete an absent key, because unchecking flat colour there has to stay
    // unchecked. Here the same rule would be wrong: a prim's `color` is DERIVED
    // from the asset when nobody has overridden it, so treating "absent" as
    // "deliberately cleared" would strip the shrapnel of its colour the first
    // time anything else about that part was touched.
    const out = { ...part };
    for (const k of PART_AUTHORED) if (k in was) out[k] = was[k];
    return out;
  });
}

// Starting values, per icon, for the ones that need something other than the
// default. The picker overrides all of it; this is only what a fresh checkout
// gets before anyone has looked at it.
//
// FLAT COLOUR IS THE LEVER FOR TELLING THE ROSTER APART. Six of the fifteen are
// white or near-white bodies, and no camera angle turns a white animal on a
// dark blue hex into six distinguishable icons. These five are the ones whose
// own materials give the eye nothing to work with — either because the file
// ships no usable texture, or because the texture is white. The rest keep their
// own materials on purpose: a shrimp is orange, a dumbo octopus is pink, and
// those read at 38px already.
const SEEDS = {
  // Necessity, not taste: the diffuse is an unresolvable D:\ path and six of
  // ten body material slots are pure black. Plus the bubble field.
  beluga: { flatColor: 0xe8f4f8, dropMeshes: 'buublesphere' },
  // Untextured near-white bodies. Tones chosen to separate them from each other
  // first and to be plausible second — this is an icon, not a portrait.
  sealTeam: { flatColor: 0xc9b49a },   // warm grey-brown, against the whales
  ironLung: { flatColor: 0x6f8796 },   // humpback slate
  electricEel: { flatColor: 0x8fbf5a },// moray green, and it needs the help most
  club: { flatColor: 0xc7975a },       // driftwood, so it stops being a white stick
};

const specs = [];
const skipped = [];
const adopted = [];
const reframed = [];

// Whatever is already on disk, so authored fields survive.
let existing = new Map();
try {
  const prior = JSON.parse(await readFile(OUT, 'utf8'));
  existing = new Map(prior.map((s) => [s.key, s]));
} catch {
  // No file yet, or an unreadable one. Either way this run writes a fresh list
  // from the seeds; it must not be a hard failure, because the first run ever
  // is exactly this case.
}

// --- adopting the scenes ---------------------------------------------------
//
// `kind` is an AUTHORED field, and it has to stay one: someone deciding an
// upgrade is better off as a monogram than as a picture is a real decision and
// the generator must not overwrite it. But every row that says `none` today
// says it because `none` was the DEFAULT for an upgrade with no model, not
// because anyone chose it — the thirty were never something the tool could
// express an opinion about until scenes existed.
//
// So the flip is a flag rather than a silent regeneration. `--adopt-scenes`
// turns every row that currently produces NO PICTURE — `none`, or an `image`
// with no file named — into `scene`, names each one, and leaves anything a
// person actually set alone. Run it once; after that the field is authored
// again and the picker owns it.
const adopt = process.argv.includes('--adopt-scenes');

// EVERY UPGRADE GETS A ROW, not just the ones with a model.
//
// The picker is where an icon is decided, so it has to be able to decide for all
// of them — including deciding that an upgrade has no art. Before this, the list
// held only the fifteen with a renderable asset and the other thirty-three were
// invisible to the tool: there was no way to hand one a drawn file and no way to
// say "this one is meant to be a monogram" as opposed to "nobody has looked at
// this one yet". Those are different states and the spec now distinguishes them.
//
//   kind: 'render'   shot from a model, with the angles below
//   kind: 'image'    a drawn file — `image` names it
//   kind: 'none'     deliberately no picture; the hive shows its monogram
//
// An upgrade with a model defaults to 'render' and one without defaults to
// 'none', which is the same behaviour as before for every existing row.
for (const up of CONFIG.upgrades) {
  const id = up.id;
  const assetKey = ICON_ASSETS[id];
  const def = assetKey ? ASSETS[assetKey] : null;
  // A primitive has no file to load. Recorded rather than skipped now: the row
  // still exists so a drawn file can be attached to it in the picker.
  const renderable = !!def?.model;
  if (assetKey && !def) skipped.push(`${id}: no asset "${assetKey}"`);
  else if (assetKey && !renderable) skipped.push(`${id}: "${assetKey}" is a primitive — needs a drawn file or a scene`);

  const file = renderable ? def.model.replace(/^\/models\//, '') : null;

  // The defaults, then the seeds, then whatever was authored. Last writer wins,
  // and the authored values are last on purpose.
  // A scene is the answer for an upgrade that grants no object — see
  // tools/icon-scenes.mjs. `render` still wins where there is a model, because
  // a photograph of the actual thing beats a composition about it.
  const scene = SCENES[id] ?? null;
  const authored = {
    kind: renderable ? 'render' : (scene ? 'scene' : 'none'),
    // Padded back out to a square so every icon lands on its hex at the same
    // apparent size — see the note in iconRender.js's crop().
    square: true,
    // Downsampled in the renderer, from the full 1024px draw, rather than by a
    // `sips -Z` pass afterwards — one high-quality step off the supersample is
    // what keeps the ink line from turning into a staircase.
    outSize: 128,
    // TOON AND AN INK LINE, which is what makes these read at 52px. The photo
    // -real studio render was the right answer for the atlas plates and the
    // wrong one here: six of the fifteen are white marine mammals lit the same
    // way, and at hive size they were the same pale blob. Banded shading plus a
    // hard black silhouette is also the language the hex card art is drawn in.
    //
    // `outline` is a FRACTION OF THE MODEL'S RADIUS, never a constant — the
    // sources run from a 0.9-unit shrimp to a 70-unit trawler.
    toon: true,
    bands: 3,
    bandLow: 70,
    bandHigh: 255,
    bandGamma: 1,
    bandSoft: 0,
    outline: 0.02,
    // The renderer's own defaults, which reproduce the atlas three-quarter view
    // exactly. picker.html is where these stop being defaults.
    yaw: -26,
    pitch: 17.4,
    roll: 0,
    clipAt: 0.33,
    ...(SEEDS[id] ?? {}),
  };
  const prior = existing.get(id);
  if (prior) {
    for (const k of AUTHORED) {
      if (k in prior) authored[k] = prior[k];
      // A field the picker explicitly cleared — unchecking flat colour deletes
      // the key rather than writing a colour — has to STAY cleared, or the seed
      // would reinstate it on the next run and the icon would go back to a
      // tone that was deliberately rejected.
      else delete authored[k];
    }
    // The migration, applied on top of the merge so it can see what the merge
    // restored. A row with a drawn file, or one already set to `scene`, is
    // untouched; so is anything with no scene written for it.
    const blank = authored.kind === 'none' || (authored.kind === 'image' && !authored.image);
    if (adopt && scene && blank) {
      adopted.push(`${id} (was ${authored.kind}${authored.kind === 'image' ? ', no file' : ''})`);
      authored.kind = 'scene';
      delete authored.image;
    }
  }

  // PARTS ARE DERIVED, always, even on a row someone has set back to `none` —
  // so that flipping it to `scene` in the picker shows the composition rather
  // than an empty spec, and so a model swapped in ASSETS reaches every scene it
  // appears in without anyone remembering which ones those are.
  const parts = scene
    ? mergeParts(scene.parts.map((pt) => resolvePart(pt, id)), existing.get(id)?.parts, id, reframed)
    : null;

  specs.push({
    key: id,
    // Carried for the picker's own list: it shows the card name, because that is
    // what the player reads, and `enabled` so a disabled card is visibly not
    // worth spending time on.
    name: up.name ?? id,
    family: up.family ?? null,
    enabled: up.enabled !== false,
    ...(file ? {
      file,
      fmt: file.endsWith('.fbx') ? 'fbx' : 'glb',
      forward: def.forward ?? '+Z',
      up: def.up ?? '+Y',
      ...(def.meshIndex != null ? { meshIndex: def.meshIndex } : {}),
      ...(def.animations ? { wantClips: def.animations } : {}),
    } : {}),
    ...authored,
    ...(parts ? { sceneNote: scene.note, parts } : {}),
  });
}

// Every id in the table has to BE an upgrade. A typo here renders a file to a
// key nothing will ever look up, and the hive falls back to a drawn glyph
// without complaining — the icon is just quietly missing.
const known = new Set(CONFIG.upgrades.map((u) => u.id));
const unknown = specs.map((s) => s.key).filter((k) => !known.has(k));
if (unknown.length) throw new Error(`not upgrade ids: ${unknown.join(', ')}`);

await writeFile(OUT, JSON.stringify(specs, null, 2) + '\n');
const byKind = specs.reduce((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});
console.log(`wrote ${specs.length} icon specs to ${OUT}`);
for (const s of skipped) console.log(`  ${s}`);
for (const a of adopted) console.log(`  adopted as a scene: ${a}`);
for (const r of reframed) console.log(`  ${r}`);
if (!adopt) {
  const waiting = specs.filter((s) => SCENES[s.key]
    && (s.kind === 'none' || (s.kind === 'image' && !s.image)));
  if (waiting.length) {
    console.log(`\n${waiting.length} upgrade(s) have a scene written but show no picture: ` +
      waiting.map((s) => s.key).join(', '));
    console.log('  re-run with --adopt-scenes to switch them on');
  }
}
console.log(`\n${specs.length} upgrades: ` +
  Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', '));
console.log('next: node tools/atlas-render/server.mjs --out <dir>');
console.log('      open http://localhost:4599/picker.html   to set them');
console.log('      open http://localhost:4599/render.html?list=icons.json   to bake the renders');
