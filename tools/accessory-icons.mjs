#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE TILE ART FOR WHAT THE SEAL WEARS — the spec list, and the bake.
//
//   npm run accessories:pick                 regenerate, then pick the angles
//   npm run accessories:icons                write the spec list only
//   npm run accessories:icons -- --bake <dir>   embed the PNGs into the game
//
// --bake also takes --strict (write nothing if any named PNG is absent) and,
// for the harness only, --list and --module.
//
// ui/accessoryDrawer.js says, in the paragraph listing what is stubbed about
// it, that each tile is "a coloured lozenge with a name under it" and that the
// honest version is a rendered thumbnail of the actual mesh — "a pipeline, not
// a div". This is that pipeline, and it is deliberately the SAME one the
// upgrade icons use: tools/upgrade-icons.mjs writes a spec list, a browser
// renders it because Node has no WebGL, and a bake reads the PNGs back and
// emits a module of data URIs. Nothing here is new machinery; what is new is a
// third list and a second module to bake into.
//
// A LIST OF ITS OWN, for the reason tools/design-icons.mjs gives for having
// one: an accessory key in icons.json would sit in front of the `known` check
// at the bottom of the upgrade bake, and — if it ever got past — become an icon
// for a card that does not exist. Two lists cost one argument on a URL.
//
// AND A BAKER OF ITS OWN, which is the half that needed the server to change.
// /bake in tools/atlas-render/server.mjs used to run the upgrade bake whatever
// list the page had been started for; its banner warned about this rather than
// fixing it. It now takes `--bake-with`, and this file is what
// `--bake-with accessories` runs.
//
// EVERY STRUCTURAL FIELD COMES OFF THE ASSET TABLE — `file`, `forward`, `up` —
// exactly as it does for the other two lists. Those axes are what the game
// orients each model by, and a tile shot down a different basis is a picture of
// a different hat. Re-running MERGES: the angles you chose in the picker are
// preserved, and the structural half is re-derived, so a model swapped in
// assets.js reaches the tiles without anybody reshooting them.
//
// THE ROSTER IS CONFIG.accessories.items AND NOT A LIST HERE. Adding a ninth
// accessory is an ASSETS entry, a block in config.js and a uiText row; this
// picks it up on the next run and the drawer falls back to its lozenge until
// somebody shoots it. Nothing to forget.
// ---------------------------------------------------------------------------
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';
import { ICON_FORMATS } from './atlas-render/icon-formats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'atlas-render/accessory-icons.json');
const MODULE_OUT = join(HERE, '../path/src/ui/accessoryIcons.js');

// The fields the PICKER owns and this must not overwrite. Same split, and the
// same reason, as the other two lists: everything else is re-derived every run.
const AUTHORED = ['yaw', 'pitch', 'roll', 'zoom', 'flatColor', 'kind', 'image',
                  'bands', 'bandLow', 'bandHigh', 'bandGamma', 'bandSoft',
                  'outline', 'toon', 'square', 'outSize', 'enabled'];

/** Which accessories exist, in the order the drawer shows them. */
const roster = () => Object.keys(CONFIG.accessories?.items ?? {});

// ---------------------------------------------------------------------------
// BAKE — read the PNGs back and write the module the drawer imports.
// ---------------------------------------------------------------------------
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const bakeArg = process.argv.indexOf('--bake');
if (bakeArg > -1) {
  const dir = process.argv[bakeArg + 1];
  // --list and --module exist FOR THE HARNESS, and are worth the two lines.
  // The guard below — a key that is not an accessory never reaches the module —
  // is the one thing here that has to be true, and the only honest way to prove
  // it is to bake a list with a foreign key in it. Doing that against the real
  // spec file would mean a test that edits source and restores it, which is a
  // test that leaves the repo broken when it throws. Both default to the real
  // pair, so every other caller is unchanged.
  const listFile = flag('list') ?? OUT;
  const moduleFile = flag('module') ?? MODULE_OUT;
  // --strict: WRITE NOTHING IF ANYTHING NAMED IS ABSENT — the same guard the
  // upgrade bake carries, for the same reason. A bake is a full overwrite and
  // the shots directory is scratch, so running one after reshooting a single
  // tile would otherwise delete every other tile from the game with no error
  // and no symptom but a drawer that has gone back to lozenges.
  const strict = process.argv.includes('--strict');
  const list = JSON.parse(await readFile(listFile, 'utf8'));
  // The mirror of the upgrade bake's `known` check, and the thing that makes
  // two lists safe: a key that is not an accessory cannot reach the drawer's
  // module even if somebody points this at the wrong file.
  const known = new Set(roster());

  const entries = [];
  const missing = [];
  let renders = 0; let images = 0; let nones = 0;

  for (const spec of list) {
    if (!known.has(spec.key)) { console.log(`  skipped ${spec.key}: not an accessory`); continue; }
    const kind = spec.kind ?? 'render';
    if (kind === 'none') { nones++; continue; }

    let path; let mime;
    if (kind === 'image') {
      // A drawn file, uploaded through the picker or already in the repo — the
      // same two roots the upgrade bake resolves, so an accessory tile can be a
      // drawing rather than a render if that reads better at 64px.
      const rel = spec.image ?? '';
      if (!rel) { missing.push(`${spec.key}: kind "image" with no file named`); continue; }
      path = rel.startsWith('/sprites/')
        ? join(HERE, '../public/sprites', basename(rel))
        : join(HERE, 'atlas-render', rel);
      mime = ICON_FORMATS[rel.slice(rel.lastIndexOf('.')).toLowerCase()] ?? 'image/png';
      images++;
    } else {
      path = join(dir, `${spec.key}.png`);
      mime = 'image/png';
      renders++;
    }

    try {
      const b64 = (await readFile(path)).toString('base64');
      entries.push(`  '${spec.key}': 'data:${mime};base64,${b64}',`);
    } catch {
      missing.push(`${spec.key}: no file at ${path}`);
      if (kind === 'image') images--; else renders--;
    }
  }

  const src = `// Rendered accessory tiles for the drawer — GENERATED, do not hand-edit.
//
//   npm run accessories:pick                      shoot and apply, in a browser
//   npm run accessories:icons -- --bake <dir>     or bake a directory of PNGs
//
// Keyed by ASSET key, which is the same key CONFIG.accessories.items and the
// slot use — ui/accessoryDrawer.js looks a tile up by the key it already holds.
// Embedded as data URIs rather than served out of public/ for the reason
// upgradeIcons.js and levelUpImages.js both give: it keeps the art working
// across the dev and playtest builds with no file juggling between them.
//
// AN ACCESSORY WITH NO ENTRY HERE IS NOT A BUG. The drawer falls back to its
// coloured lozenge, which is what every tile was before this file existed, so a
// newly imported accessory is wearable the moment its ASSETS entry lands and
// gets its picture whenever somebody sits down with the picker.
export const ACCESSORY_ICONS = {
${entries.join('\n')}
};

export const ACCESSORY_ICON_KEYS = Object.keys(ACCESSORY_ICONS);
`;

  if (strict && missing.length) {
    console.error(`REFUSED to bake: ${missing.length} tile(s) named by accessory-icons.json are not on disk.`);
    for (const m of missing) console.error(`  MISSING ${m}`);
    console.error(`\nNothing was written. ${moduleFile} still holds the last good set.`);
    console.error('Shoot the whole list first: render.html?list=accessory-icons.json');
    process.exit(2);
  }

  await writeFile(moduleFile, src);
  const kb = (Buffer.byteLength(src) / 1024).toFixed(0);
  console.log(`baked ${entries.length} accessory tiles into ${moduleFile} (${kb}KB)`);
  console.log(`  ${renders} rendered, ${images} drawn, ${nones} deliberately none`);
  for (const m of missing) console.log(`  MISSING ${m}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// GENERATE — one spec per accessory, structure from the asset table.
// ---------------------------------------------------------------------------
const prior = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => []);
const priorBy = new Map(prior.map((s) => [s.key, s]));

// A TILE IS 64 CSS PIXELS WIDE, and `background-size: contain` bounds the
// picture by that, so the shot is supersampled past it and downscaled by the
// RENDERER (see `outSize`) rather than blown up by the browser. 160 is 2.5x,
// which covers a 2x device ratio with margin — the same ratio the upgrade icons
// use, 128 into a 52px hex.
//
// IT IS A SHIPPED BYTE COUNT, not a scratch file, which is why this is not
// simply set generously. These bake into path/src/ui/accessoryIcons.js as data
// URIs and every player downloads all of them: 256 made the module 361KB for
// eight tiles, against the upgrade hive's 1MB for fifty-two. 160 lands it near
// 140KB for detail nobody can see at 64 pixels.
const OUT_SIZE = 160;

const specs = roster().map((key) => {
  const def = ASSETS[key];
  if (!def) throw new Error(`CONFIG.accessories.items has "${key}" but ASSETS does not`);
  const file = def.model?.replace(/^\/models\//, '');
  // An accessory with no model is a stand-in primitive (a cone, a box). It has
  // no picture worth taking, and saying so as `kind: 'none'` is a decision the
  // bake reads rather than a gap it trips over.
  const was = priorBy.get(key) ?? {};
  const authored = {};
  for (const k of AUTHORED) if (was[k] !== undefined) authored[k] = was[k];

  return {
    key,
    // The dev-facing name, matching the tuner's slider prefixes. NOT the
    // player's name for it: that is uiText's `<key>Name` and is Ethan's to
    // write — see CLAUDE.md. A picker sidebar is not player-facing copy.
    name: key.replace(/^accessory/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
    // The picker groups its sidebar on this.
    family: 'accessory',
    enabled: true,
    sceneNote: `${key} — the drawer tile, 64px`,
    kind: file ? 'render' : 'none',
    ...(file ? {
      file,
      fmt: file.endsWith('.fbx') ? 'fbx' : 'glb',
      forward: def.forward ?? '+Z',
      up: def.up ?? '+Y',
      ...(def.meshIndex != null ? { meshIndex: def.meshIndex } : {}),
    } : {}),

    // --- defaults, all of them overridable in the picker -------------------
    square: true,
    outSize: OUT_SIZE,
    // The game's own look, so a tile is the thing you are about to put on
    // rather than an impression of it. `outline` is a FRACTION of the model's
    // radius — see the note in tools/upgrade-icons.mjs — and is a shade heavier
    // than an upgrade icon's 0.006 because these are small dark objects on a
    // dark tile and the rim is most of what separates them from it.
    toon: true,
    bands: 4,
    bandLow: 70,
    bandHigh: 255,
    bandGamma: 1,
    bandSoft: 0,
    outline: 0.012,
    // FRONT-ON, TILTED DOWN — and this is measured rather than picked by
    // taste. The game draws these in profile, which is the one angle that
    // cannot work here: a pair of glasses side-on is a stick, and every hat
    // side-on is the same dark lozenge. So the tile has to face the thing.
    //
    // -90 rather than +90, and the difference is not cosmetic. Swept through
    // eight yaws at 192px (round frames, the bowler and the tricorn), +90 looks
    // into the tricorn's CROWN — an empty grey bowl — and -90 gives it the
    // three-cornered silhouette that is the whole reason to wear one. The
    // glasses read at both. The bowler is the one item that wants the other
    // half turn, because its goggles are on the far side at -90; that is one
    // drag in the picker and is exactly what the picker is for.
    //
    // These are only where the sliders start. Whatever is chosen there is kept
    // across every later run of this file — see AUTHORED.
    yaw: -90,
    // Enough to show the crown of a hat above its brim without looking down
    // into it.
    pitch: 18,
    roll: 0,
    ...authored,
  };
});

await writeFile(OUT, JSON.stringify(specs, null, 2) + '\n');
const kept = specs.filter((s) => priorBy.has(s.key)).length;
console.log(`wrote ${specs.length} accessory tile specs to ${OUT}`
  + (kept ? ` (kept the angles on ${kept})` : ''));
