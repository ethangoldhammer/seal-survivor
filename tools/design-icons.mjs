#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Render specs for DESIGN shots — art for one-pagers, posters and slides, not
// for the game.
//
//   npm run pick        regenerates this list and serves the picker
//
// or, to write the list without starting anything:
//
//   node --import ./tools/vite-loader.mjs tools/design-icons.mjs
//
// Same spec shape and the same picker as the upgrade icons, so there is one
// place that knows how a model is framed and one place that knows how to
// choose an angle. The only thing that differs is where the PNG ends up: an
// upgrade icon is baked into path/src/ui/upgradeIcons.js and ships, and one of
// these is dropped into a design file by hand.
//
// A SEPARATE LIST, and that is the whole point of the file. Adding a design
// shot to icons.json would put a non-upgrade key in front of the id check at
// the bottom of tools/upgrade-icons.mjs, and — if it ever got past — into the
// hive as an icon for a card that does not exist. Two lists cost one argument
// on a URL.
//
// EVERY STRUCTURAL FIELD COMES OFF THE ASSET TABLE, exactly as it does for the
// upgrade icons: `file`, `forward`, `up` and the clip names are what the game
// orients and animates this model by, and a shot taken down a different basis
// is a picture of a different animal.
//
// ONE ENTRY PER CLIP. The picker has no clip chooser — it takes swim, or idle
// if there is no swim — so the way to compare poses is to put each clip in the
// list under its own key and click between them. yaw/pitch/roll/pose are then
// chosen per entry, which is correct: the angle that flatters a swim is not
// the angle that flatters a roll.
//
// Re-running MERGES: every authored field below is preserved from the file on
// disk, so a re-run after the asset table moves re-derives the structural half
// and leaves the chosen angles alone.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../path/src/assets.js';
import { CONFIG } from '../path/src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'atlas-render/design-icons.json');

// The fields the PICKER owns. Everything else is re-derived on every run.
// Same split, and the same reason, as tools/upgrade-icons.mjs.
const AUTHORED = ['yaw', 'pitch', 'roll', 'clipAt', 'zoom', 'flatColor',
                  'bands', 'bandLow', 'bandHigh', 'bandGamma', 'bandSoft',
                  'outline', 'toon', 'square', 'outSize', 'ring'];

// The mottling is DERIVED, every run, and deliberately not in the list above.
//
// It is the one thing on these specs that is not a design decision: it is what
// the seal's hide IS, and CONFIG.sealShader is where that lives. Letting the
// picker author it would mean a document showing an animal the game stopped
// rendering, with nothing to say which of the two was out of date.
//
// Only the mottling — the glow, the charge flash and the wet film in that same
// config block are run-time gameplay layers a still has no state for.
function mottleFromConfig() {
  const c = CONFIG.sealShader ?? {};
  if (c.enabled === false) return null;
  return {
    size: c.size ?? 0.4,
    strength: c.strength ?? 0.35,
    contrast: c.contrast ?? 1,
    color: c.color ?? 0x0a2233,
    baseColor: c.baseColor ?? 0xffffff,
    paint: c.paint ?? 0,
  };
}

// The ring the loop icon is drawn inside. A design decision, so it is authored
// — these are only where the sliders start. `radius` and `tube` are multiples
// of the subject's own size, never world units; see buildRing in iconRender.js.
const RING = {
  enabled: true,
  radius: 1.45,
  tube: 0.045,
  arrows: 4,
  gap: 0.16,
  tilt: 0,
  yaw: 0,
  spin: 0,
  color: 0x6fd3ff,
  opacity: 1,
};

// What each shot is FOR, in one line, so a list of keys is still readable in a
// month. `asset` is a key in ASSETS; `clip` is a key in that asset's
// `animations` map.
const SHOTS = [
  { key: 'loopSealSwim',  asset: 'ship', clip: 'swim',  ring: true,
    name: 'loop icon — swim',  note: 'the seal inside the core-loop ring' },
  { key: 'loopSealBoost', asset: 'ship', clip: 'boost', ring: true,
    name: 'loop icon — boost', note: 'the sliding pose, for a ring about the boost' },
  { key: 'loopSealIdle',  asset: 'ship', clip: 'idle',  ring: true,
    name: 'loop icon — idle',  note: 'the resting water pose' },
];

const prior = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => []);
const priorBy = new Map(prior.map((s) => [s.key, s]));

const specs = SHOTS.map((shot) => {
  const def = ASSETS[shot.asset];
  if (!def) throw new Error(`no asset "${shot.asset}" for shot ${shot.key}`);
  const file = def.model?.replace(/^\/models\//, '');
  if (!file) throw new Error(`asset "${shot.asset}" has no model`);
  const clipName = def.animations?.[shot.clip];
  if (shot.clip && !clipName) {
    throw new Error(`asset "${shot.asset}" has no "${shot.clip}" clip`);
  }

  const was = priorBy.get(shot.key) ?? {};
  const authored = {};
  for (const k of AUTHORED) if (was[k] !== undefined) authored[k] = was[k];

  return {
    key: shot.key,
    name: shot.name,
    // The picker groups the sidebar on this and shows the note under the
    // canvas, so both are for reading rather than for rendering.
    family: 'design',
    enabled: true,
    sceneNote: shot.note,
    kind: 'render',
    file,
    fmt: file.endsWith('.fbx') ? 'fbx' : 'glb',
    forward: def.forward ?? '+Z',
    up: def.up ?? '+Y',
    ...(clipName ? { clip: clipName } : {}),
    ...(def.animations ? { wantClips: def.animations } : {}),

    // --- defaults, all of them overridable in the picker -------------------
    // BIGGER THAN AN UPGRADE ICON (128). These land in a printed one-pager at
    // roughly 130 CSS px, and the artboards export to PNG and PDF at a higher
    // device ratio than that — so the shot is supersampled and downscaled by
    // the page rather than blown up by it.
    square: true,
    outSize: 512,
    // The game's own look: banded toon shading with a rim, so the seal in a
    // document is the seal on the screen. `outline` is a FRACTION of the
    // model's radius — see the note in tools/upgrade-icons.mjs.
    toon: true,
    bands: 3,
    bandLow: 70,
    bandHigh: 255,
    bandGamma: 1,
    bandSoft: 0,
    outline: 0.02,
    yaw: -26,
    pitch: 17.4,
    roll: 0,
    clipAt: 0.33,
    ...(shot.ring ? { ring: { ...RING } } : {}),
    ...authored,
    // AFTER the authored spread, because this one is not the picker's to keep.
    ...(mottleFromConfig() ? { noise: mottleFromConfig() } : {}),
  };
});

await writeFile(OUT, JSON.stringify(specs, null, 2) + '\n');
const kept = specs.filter((s) => priorBy.has(s.key)).length;
console.log(`wrote ${specs.length} design specs to ${OUT}` + (kept ? ` (kept the angles on ${kept})` : ''));

