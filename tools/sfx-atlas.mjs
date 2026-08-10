#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run sfx:atlas
//
// Writes tools/sfx-atlas.json and tools/sfx-atlas.html: every sound the game
// can make, what fires it, and where from.
//
// The point is that the answer is spread across five places that nothing joins
// up on its own — CONFIG.sfx is the voice, CONFIG.feedback is the event that
// plays it, the call sites are in gameplay code, the actual files are on disk,
// and imported-tuning.json quietly overrides all of it. Asking "what does a
// crab eating an orb sound like" currently means reading four files and
// knowing that the fifth exists.
//
// Everything here is DERIVED. Nothing in the page is typed by hand, so
// re-running it after a change is always the correct fix for a stale atlas.
//
// Two things it reads that a naive version would miss:
//
//   TUNING     CONFIG is imported through the vite loader shim, which means
//              imported-tuning.json has already been merged in. That file is
//              where the real sample assignments live — config.js still says
//              `src: null` for every single sound.
//   ORPHANS    public/sfx is listed and diffed against what the config points
//              at, because a file nothing references is invisible otherwise
//              and ships anyway.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import '../tools/dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'path', 'src');
const SFX_DIR = join(ROOT, 'public', 'sfx');

// --- what the config says --------------------------------------------------

const sourcesFor = (def) => {
  if (!def) return [];
  if (Array.isArray(def.srcs) && def.srcs.length) return def.srcs.filter(Boolean);
  return def.src ? [def.src] : [];
};

// Seconds, via afinfo. macOS only and deliberately best-effort: a duration is
// a nice-to-have on the page, and shelling out per file must never be the
// reason the atlas can't be regenerated.
function durationOf(absPath) {
  try {
    const out = execFileSync('afinfo', [absPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/estimated duration:\s*([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// MIME by extension, for the data URIs below.
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };

// path -> data URI. Held in one flat map rather than on each file record
// because the same file is described from several places (a sound, the ambient
// bed, the on-disk listing) and a base64 payload repeated per mention would
// triple the size of the page for nothing.
const audioData = {};

const fileInfo = new Map(); // '/sfx/x.mp3' -> { exists, bytes, seconds }
function describeFile(webPath) {
  if (fileInfo.has(webPath)) return fileInfo.get(webPath);
  const abs = join(ROOT, 'public', webPath.replace(/^\//, ''));
  let info = { path: webPath, exists: false, bytes: 0, seconds: null };
  if (existsSync(abs)) {
    info = { path: webPath, exists: true, bytes: statSync(abs).size, seconds: durationOf(abs) };
    // Inlined as a data URI so the atlas can actually PLAY the bank. An audio
    // reference you can't hear is a spreadsheet, and the published page has no
    // access to this repo's public/ — a src="/sfx/..." would 404 on every row.
    // Only public/sfx is embedded; public/music is 9MB of loops and belongs on
    // the page as a list, not as a payload.
    const ext = webPath.split('.').pop().toLowerCase();
    if (webPath.startsWith('/sfx/') && MIME[ext]) {
      audioData[webPath] = `data:${MIME[ext]};base64,${readFileSync(abs).toString('base64')}`;
    }
  }
  fileInfo.set(webPath, info);
  return info;
}

// --- where the game fires them --------------------------------------------
// A regex over the source rather than a parse. It only has to find
// `feedback('name'` and `playSfx('name'`, both of which are written the same
// way everywhere in this codebase, and being approximate here is fine: a
// missed call site makes the atlas less useful, never wrong.

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const CALL_RE = /\b(feedback|playSfx)\(\s*'([A-Za-z0-9_]+)'/g;
const eventSites = new Map(); // event name -> [{ file, line }]
const directSfxSites = new Map(); // sfx name -> [{ file, line }]

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  // feedback.js and audio.js are the dispatchers, not call sites — including
  // them would list every event as firing from the file that fires all of them.
  if (rel.endsWith('systems/feedback.js') || rel.endsWith('systems/audio.js')) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    // Skip comment lines: config.js and several systems discuss these calls in
    // prose, and a comment about `playSfx('strike')` is not a call site.
    if (/^\s*(\/\/|\*)/.test(text)) return;
    for (const m of text.matchAll(CALL_RE)) {
      const [, fn, name] = m;
      const bucket = fn === 'feedback' ? eventSites : directSfxSites;
      if (!bucket.has(name)) bucket.set(name, []);
      bucket.get(name).push({ file: rel, line: i + 1 });
    }
  });
}

// --- events ----------------------------------------------------------------

const events = Object.entries(CONFIG.feedback ?? {}).map(([name, def]) => ({
  name,
  sfx: def.sfx ?? null,
  sfxMinGap: def.sfxMinGap ?? 0,
  emit: def.emit ?? null,
  shake: def.shake ?? 0,
  hitstop: def.hitstop ?? 0,
  glow: def.glow ?? 0,
  ripple: def.ripple ?? null,
  haptic: describeHaptic(def.haptic),
  sites: eventSites.get(name) ?? [],
}));

// A haptic is authored two ways — a millisecond on/off list, or explicit
// {duration, magnitude} pulses. Flattened to one readable string so the page
// doesn't have to know the difference.
function describeHaptic(pattern) {
  if (!pattern) return null;
  if (typeof pattern === 'number') return `${pattern}ms`;
  if (!Array.isArray(pattern)) return `${Math.round(pattern.duration ?? 0)}ms`;
  if (pattern.every((v) => typeof v === 'number')) return pattern.map((v) => `${v}ms`).join(' / ');
  return pattern
    .map((p) => `${Math.round(p.duration ?? 0)}ms @ ${(p.magnitude ?? 0).toFixed(2)}`)
    .join(' + ');
}

// --- sounds ----------------------------------------------------------------

const sfx = Object.entries(CONFIG.sfx ?? {}).map(([name, def]) => {
  const files = sourcesFor(def).map(describeFile);
  const firedBy = events.filter((e) => e.sfx === name);
  return {
    name,
    // "sample" wins over the synth entirely when files are assigned — the
    // synth block below is then dead settings kept as the fallback, which is
    // worth showing precisely BECAUSE it is invisible in game.
    mode: files.length ? 'sample' : 'synth',
    files,
    missing: files.filter((f) => !f.exists).map((f) => f.path),
    variations: files.length,
    synth: {
      type: def.type ?? null,
      wave: def.wave ?? null,
      freq: def.freq ?? null,
      filter: def.filter ?? null,
      noise: def.noise ?? null,
      decay: def.decay ?? null,
      gain: def.gain ?? null,
      pitchVary: def.pitchVary ?? 0,
      filterVary: def.filterVary ?? 0,
      detune: def.detune ?? 0,
    },
    firedBy: firedBy.map((e) => e.name),
    // Events are the normal route; anything here is a sound played directly,
    // which today means the tuner's Test buttons.
    directSites: directSfxSites.get(name) ?? [],
    // How often this can possibly be heard, which is the single most useful
    // number for judging whether it is mixed too loud. Taken from the
    // tightest throttle across every event that plays it.
    minGap: firedBy.length ? Math.min(...firedBy.map((e) => e.sfxMinGap)) : null,
    orphaned: firedBy.length === 0 && !(directSfxSites.get(name)?.length),
  };
});

// Events naming a sound that no longer exists in CONFIG.sfx: silent in game,
// and nothing warns about it because playSfx returns early on an unknown name.
const danglingEvents = events
  .filter((e) => e.sfx && !CONFIG.sfx?.[e.sfx])
  .map((e) => ({ event: e.name, sfx: e.sfx }));

// Events fired from gameplay that CONFIG.feedback has no entry for. These DO
// warn at runtime, but only once the code path is taken.
const unknownEvents = [...eventSites.keys()]
  .filter((name) => !CONFIG.feedback?.[name])
  .map((name) => ({ event: name, sites: eventSites.get(name) }));

// --- continuous sound ------------------------------------------------------

const continuous = {
  music: {
    enabled: CONFIG.music?.enabled !== false,
    bpm: CONFIG.music?.bpm ?? null,
    beatsPerLoop: CONFIG.music?.beatsPerLoop ?? null,
    volume: CONFIG.music?.volume ?? null,
    levelsPerSlot: CONFIG.music?.levelsPerSlot ?? null,
    tracks: (CONFIG.music?.defaultSrc ?? []).filter(Boolean).map(describeFile),
    depth: { surfaceHz: CONFIG.music?.surfaceHz, deepHz: CONFIG.music?.deepHz },
    duckedHz: CONFIG.music?.duckedHz ?? null,
  },
  ambient: {
    enabled: CONFIG.ambient?.enabled !== false,
    // `gapSeconds` is the mode switch, not just a number — above zero each clip
    // is a single appearance with silence around it, at zero it is a continuous
    // crossfading bed. Resolved here so the page doesn't have to know the rule.
    mode: (CONFIG.ambient?.gapSeconds ?? 0) > 0 ? 'sporadic' : 'continuous',
    volume: CONFIG.ambient?.volume ?? null,
    gapSeconds: CONFIG.ambient?.gapSeconds ?? 0,
    gapVary: CONFIG.ambient?.gapVary ?? 0,
    fadeSeconds: CONFIG.ambient?.fadeSeconds ?? null,
    holdSeconds: CONFIG.ambient?.holdSeconds ?? null,
    holdVary: CONFIG.ambient?.holdVary ?? null,
    crossfade: CONFIG.ambient?.crossfade ?? null,
    pitchVary: CONFIG.ambient?.pitchVary ?? null,
    shuffle: CONFIG.ambient?.shuffle !== false,
    fadeOut: CONFIG.ambient?.fadeOut ?? null,
    slots: CONFIG.ambient?.slots ?? null,
    clips: (CONFIG.ambient?.srcs ?? []).filter(Boolean).map(describeFile),
  },
  flight: Object.entries(CONFIG.flightSfx ?? {})
    .filter(([, v]) => v && typeof v === 'object')
    .map(([name, v]) => ({
      name,
      enabled: v.enabled !== false,
      gain: v.gain ?? null,
      toneWave: v.toneWave ?? null,
      toneHz: v.toneHz ?? null,
      noiseHz: v.noiseHz ?? null,
      doppler: v.doppler ?? null,
      warbleHz: v.warbleHz ?? null,
      falloff: v.falloff ?? null,
    })),
  flightGlobals: {
    enabled: CONFIG.flightSfx?.enabled !== false,
    gain: CONFIG.flightSfx?.gain ?? null,
    maxVoices: CONFIG.flightSfx?.maxVoices ?? null,
    smoothing: CONFIG.flightSfx?.smoothing ?? null,
  },
};

const bus = {
  masterVolume: CONFIG.audio?.masterVolume ?? null,
  maxConcurrent: CONFIG.audio?.maxConcurrent ?? null,
  filterType: CONFIG.audio?.bus?.filterType ?? null,
  filterHz: CONFIG.audio?.bus?.filterHz ?? null,
  filterQ: CONFIG.audio?.bus?.filterQ ?? null,
  reverbMix: CONFIG.audio?.bus?.reverbMix ?? null,
  reverbSeconds: CONFIG.audio?.bus?.reverbSeconds ?? null,
  reverbDecay: CONFIG.audio?.bus?.reverbDecay ?? null,
  depth: CONFIG.audio?.bus?.depth ?? null,
  comp: CONFIG.audio?.bus?.comp ?? null,
};

// --- the files on disk -----------------------------------------------------

const referenced = new Set();
for (const s of sfx) for (const f of s.files) referenced.add(f.path);
for (const c of continuous.ambient.clips) referenced.add(c.path);

const files = existsSync(SFX_DIR)
  ? readdirSync(SFX_DIR)
      .filter((n) => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(n))
      .map((n) => {
        const webPath = `/sfx/${n}`;
        const info = describeFile(webPath);
        const usedBy = sfx.filter((s) => s.files.some((f) => f.path === webPath)).map((s) => s.name);
        const ambientUse = continuous.ambient.clips.some((c) => c.path === webPath) ? ['(ambient bed)'] : [];
        return { ...info, name: n, usedBy: [...usedBy, ...ambientUse] };
      })
      .sort((a, b) => b.bytes - a.bytes)
  : [];

const atlas = {
  generatedAt: new Date().toISOString(),
  counts: {
    sounds: sfx.length,
    sampled: sfx.filter((s) => s.mode === 'sample').length,
    synth: sfx.filter((s) => s.mode === 'synth').length,
    events: events.length,
    eventsWithSound: events.filter((e) => e.sfx).length,
    silentEvents: events.filter((e) => !e.sfx).length,
    callSites: [...eventSites.values()].reduce((n, v) => n + v.length, 0),
    files: files.length,
    orphanFiles: files.filter((f) => !f.usedBy.length).length,
    unreferencedSounds: sfx.filter((s) => s.orphaned).length,
  },
  bus,
  sfx,
  events,
  continuous,
  files,
  problems: {
    danglingEvents,
    unknownEvents,
    missingFiles: sfx.flatMap((s) => s.missing.map((p) => ({ sfx: s.name, path: p }))),
    orphanFiles: files.filter((f) => !f.usedBy.length).map((f) => f.name),
    unreferencedSounds: sfx.filter((s) => s.orphaned).map((s) => s.name),
    silentEvents: events.filter((e) => !e.sfx).map((e) => e.name),
  },
};

// The JSON is the reviewable artifact — a diff of it is how you see what a
// change did to the sound bank — so it is written BEFORE the audio payloads go
// on. They exist only to make the HTML playable, and a megabyte of base64 in a
// tracked file would make every regeneration an unreadable diff.
const jsonPath = join(HERE, 'sfx-atlas.json');
writeFileSync(jsonPath, `${JSON.stringify(atlas, null, 2)}\n`);
atlas.audioData = audioData;

// --- the page --------------------------------------------------------------
// Pure ASCII on purpose: the Artifact wrapper owns <head> and sets no charset,
// so a stray non-ASCII byte renders as mojibake. Anything typographic goes in
// as an HTML entity here and as \uXXXX inside the script.

const htmlPath = join(HERE, 'sfx-atlas.html');
const page = renderPage(atlas);
// Enforced rather than assumed. A single non-ASCII byte renders as mojibake on
// the published page and there is no way to fix it from here, so this fails the
// build instead — write entities in the markup and \uXXXX inside the script.
const stray = page.match(/[^\x00-\x7F]/g);
if (stray) {
  const at = page.search(/[^\x00-\x7F]/);
  throw new Error(
    `sfx-atlas.template.html contains ${stray.length} non-ASCII character(s), first at offset ${at} `
    + `(${JSON.stringify(page.slice(Math.max(0, at - 40), at + 40))}). `
    + 'The Artifact wrapper owns <head> and sets no charset, so the page must be pure ASCII.',
  );
}
writeFileSync(htmlPath, page);

console.log(`sfx atlas: ${atlas.counts.sounds} sounds, ${atlas.counts.events} events, ${atlas.counts.files} files`);
console.log(`  ${relative(ROOT, jsonPath)}`);
console.log(`  ${relative(ROOT, htmlPath)}`);
for (const [key, list] of Object.entries(atlas.problems)) {
  if (list.length) console.log(`  ${key}: ${list.length}`);
}

// eslint-disable-next-line no-unused-vars -- kept below the call for reading order
function renderPage(data) {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    // Any non-ASCII that crept in through a file name or a config string.
    .replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return readFileSync(join(HERE, 'sfx-atlas.template.html'), 'utf8').replace('/*ATLAS_DATA*/null', json);
}
