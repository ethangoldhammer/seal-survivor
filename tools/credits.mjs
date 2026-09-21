#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Builds CREDITS.md from what the shipped asset files actually say.
//
//   npm run credits            # print the report, write nothing
//   npm run credits -- --write # write CREDITS.md
//   npm run credits -- --gaps  # only the rows nobody has resolved yet
//
// WHY THIS IS A TOOL AND NOT A HAND-WRITTEN FILE. Every Sketchfab download
// carries its own attribution inside the GLB, as `asset.extras` — author,
// licence, source URL, title, written by Sketchfab at export. That is the
// primary record and it travels with the file, so a credits list typed out
// beside it is a second source of truth that goes stale the first time a model
// is swapped. This reads the extras off the files in public/models and prints
// what is there.
//
// THE PIPELINE DESTROYS THE RECORD, which is the whole reason the DERIVED table
// below exists. Four different tools rebuild a model before it ships —
// optimize-creatures.mjs, fish-split.mjs, orca-split.mjs, split-seabed.mjs and
// friends — and the ones that go through THREE.GLTFExporter write a fresh
// `asset` block with no extras at all. tools/optimize-*.mjs mostly preserve
// them (glTF-Transform keeps the block); anything routed through three.js does
// not. So `public/models/clownfish.glb` is silent about an author that
// `3 low poly fish to split.glb` names plainly.
//
// DERIVED therefore maps a shipped file to the SOURCE ART it was cut from, and
// this tool reads the attribution out of THAT file at run time. The mapping is
// typed; the attribution is not. If the source art is missing from this
// machine, the row says so rather than quietly printing nothing.
//
// OFFLINE maps the rest — the packs that were never glTF and so never had an
// extras block to read: TurboSquid and Sketchfab Store purchases that arrive as
// FBX, OBJ or C4D. Those records ARE typed, because there is nothing in the
// file to read them from. Each one names the folder it came from so the claim
// can be checked against the receipt.
//
// A model that matches nothing is printed under UNRESOLVED. That is the point
// of the report: it is a list of what still needs an answer, not a certificate
// that everything has one.
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const MODELS = join(ROOT, 'public/models');
const ART = join(homedir(), 'Documents/_DesignSystems/SealSurvivor');
const NATURE = join(homedir(), 'Documents/_C4D/_ASSETS/_Nature');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const GAPS_ONLY = args.includes('--gaps');

// --- reading the record -----------------------------------------------------

/** asset.extras out of a .glb (binary container) or .gltf (plain JSON). */
function readExtras(file) {
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  let json;
  if (buf.readUInt32LE(0) === 0x46546c67) {
    const len = buf.readUInt32LE(12);
    json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  } else {
    json = JSON.parse(buf.toString('utf8'));
  }
  return json.asset?.extras ?? null;
}

/** Sketchfab writes "Name (https://sketchfab.com/handle)" — split it. */
function splitLinked(s) {
  const m = /^(.*?)\s*\((https?:\/\/[^)]+)\)\s*$/.exec(s ?? '');
  return m ? { name: m[1], url: m[2] } : { name: s ?? '', url: '' };
}

function fromExtras(extras, origin) {
  if (!extras?.author) return null;
  const author = splitLinked(extras.author);
  const licence = splitLinked(extras.license);
  return {
    title: extras.title ?? '',
    author: author.name,
    authorUrl: author.url,
    licence: licence.name || 'unstated',
    licenceUrl: licence.url,
    source: extras.source ?? '',
    origin,
  };
}

// --- the two typed tables ---------------------------------------------------

// Shipped file -> the source art it was cut, decimated or rebuilt from. The
// attribution is read out of the source at run time; only the mapping is typed.
const DERIVED = {
  'ballroomguest.glb': [ART, 'ballroom_character.glb', 'rig-guest.mjs'],
  'barrel.glb': [ART, 'wooden_barrel.glb', 'prop import'],
  'brownfish.glb': [ART, '3 low poly fish to split.glb', 'fish-split.mjs'],
  'clownfish.glb': [ART, '3 low poly fish to split.glb', 'fish-split.mjs'],
  'surgeonfish.glb': [ART, '3 low poly fish to split.glb', 'fish-split.mjs'],
  'tunafish.glb': [ART, '3 low poly fish to split.glb', 'fish-split.mjs'],
  'grass.glb': [ART, 'game_ready_grass.glb', 'optimize-grass.mjs'],
  'graves/headstone.glb': [ART, 'grave_stone_collection.glb', 'split-islands.mjs'],
  'graves/plaque.glb': [ART, 'grave_stone_collection.glb', 'split-islands.mjs'],
  'graves/tomb.glb': [ART, 'grave_stone_collection.glb', 'split-islands.mjs'],
  'manowar.glb': [ART, 'portuguese_man_o_war.glb', 'tools/lib/glb.mjs'],
  'moneyroll1.glb': [ART, 'money_rolls.glb', 'split-islands.mjs'],
  'moneyroll2.glb': [ART, 'money_rolls.glb', 'split-islands.mjs'],
  'moneyroll3.glb': [ART, 'money_rolls.glb', 'split-islands.mjs'],
  'moneyroll4.glb': [ART, 'money_rolls.glb', 'split-islands.mjs'],
  'musicnote.glb': [ART, 'pflow_practice_-_music_spread.glb', 'note-glyphs.mjs'],
  'musicnotes.glb': [ART, 'pflow_practice_-_music_spread.glb', 'note-glyphs.mjs'],
};
// Every seabed prop is one cut of the same Sketchfab scene.
for (const f of readdirSync(join(MODELS, 'seabed')).filter((f) => f.endsWith('.glb'))) {
  DERIVED[`seabed/${f}`] = [ART, 'sea_bed.glb', 'split-seabed.mjs'];
}

// Packs that were never glTF, so there is no extras block anywhere to read.
// These records are typed. `receipt` names the folder they were unpacked into,
// which is where the purchase can be checked.
const OFFLINE = {
  'anglerfish.glb': {
    title: 'Atlantic Footballfish ♀',
    author: 'Nestaeric',
    authorUrl: 'https://sketchfab.com/Nestaeric',
    licence: 'Sketchfab Store (royalty-free, paid)',
    licenceUrl: 'https://sketchfab.com/licenses',
    source: 'https://sketchfab.com/3d-models/atlantic-footballfish-e53351e2d9264411a7319eba2e347d6c',
    receipt: '_C4D/_ASSETS/_Nature/atlantic-footballfish',
  },
  'beluga.fbx': {
    title: 'Beluga Whale',
    author: 'Nestaeric',
    authorUrl: 'https://sketchfab.com/Nestaeric',
    licence: 'Sketchfab — CONFIRM which of the two listings',
    licenceUrl: 'https://sketchfab.com/licenses',
    source: 'https://sketchfab.com/3d-models/beluga-whale-64b73a627edd467fbf2b193112831ab0',
    receipt: '_C4D/_ASSETS/_Nature/beluga-whale',
    unsure: 'Nestaeric lists a ♂ (Store, paid) and a ♀ (free, CC-BY). The download '
      + 'folder carries no license.txt, so which one this is has to come from the purchase history. '
      + 'If it is the ♀ it needs a CC-BY credit line; if the ♂ it needs none.',
  },
  'hammerhead.glb': {
    title: 'Hammerhead Shark',
    author: 'TurboSquid product 091433327',
    authorUrl: 'https://www.turbosquid.com/3d-models/091433327',
    licence: 'TurboSquid Royalty-Free (no attribution required)',
    licenceUrl: 'https://blog.turbosquid.com/turbosquid-3d-model-license/',
    source: '',
    receipt: '_C4D/_ASSETS/_Nature/091433327-hammerhead-shark',
  },
  'morayeel.fbx': {
    title: 'Gymnothorax javanicus (moray eel)',
    author: 'TurboSquid product 096438851',
    authorUrl: 'https://www.turbosquid.com/3d-models/096438851',
    licence: 'TurboSquid Royalty-Free (no attribution required)',
    licenceUrl: 'https://blog.turbosquid.com/turbosquid-3d-model-license/',
    source: '',
    receipt: '_C4D/_ASSETS/_Nature/096438851-gymnothorax-javanicus',
  },
  'orca.split': {
    title: 'Orca Killer Whale Family',
    author: 'TurboSquid product 091027423',
    authorUrl: 'https://www.turbosquid.com/3d-models/091027423',
    licence: 'TurboSquid Royalty-Free (no attribution required)',
    licenceUrl: 'https://blog.turbosquid.com/turbosquid-3d-model-license/',
    source: '',
    receipt: '_C4D/_ASSETS/_Nature/091027423-orca-killer-whale-family',
  },
  'seagull.fbx': {
    title: 'Seagull, wings folded',
    author: 'TurboSquid product 091431295',
    authorUrl: 'https://www.turbosquid.com/3d-models/091431295',
    licence: 'TurboSquid Royalty-Free (no attribution required)',
    licenceUrl: 'https://blog.turbosquid.com/turbosquid-3d-model-license/',
    source: '',
    receipt: '_C4D/_ASSETS/_Nature/091431295-seagull-wings-folded',
  },
  'squid.glb': {
    title: 'Sea Animals 01 (Squid_01)',
    author: 'TurboSquid product 096421758',
    authorUrl: 'https://www.turbosquid.com/3d-models/096421758',
    licence: 'TurboSquid Royalty-Free (no attribution required)',
    licenceUrl: 'https://blog.turbosquid.com/turbosquid-3d-model-license/',
    source: '',
    receipt: '_C4D/_ASSETS/_Nature/096421758-sea-animals-01',
  },
  'whale.glb': {
    title: 'Bowhead Whale',
    author: 'TurboSquid product 091431916',
    authorUrl: 'https://www.turbosquid.com/3d-models/091431916',
    licence: 'TurboSquid Royalty-Free (no attribution required)',
    licenceUrl: 'https://blog.turbosquid.com/turbosquid-3d-model-license/',
    source: '',
    receipt: '_C4D/_ASSETS/_Nature/091431916-bowhead-whale',
  },
  'trout.fbx': {
    title: 'Animated Trout',
    author: '',
    authorUrl: '',
    licence: '',
    licenceUrl: '',
    source: '',
    receipt: '_DesignSystems/SealSurvivor/animated-trout-3d-animal-model.zip',
    unsure: 'The zip unpacks source/ + textures/ with no license.txt, which is the shape of a '
      + 'Sketchfab Store purchase, but the slug matches several listings and none of them can be '
      + 'told apart from the files. Needs the purchase history.',
  },
  'mussel.glb': {
    title: 'Toon shaded mussel',
    author: '',
    authorUrl: '',
    licence: '',
    licenceUrl: '',
    source: '',
    receipt: '_DesignSystems/SealSurvivor/toon_shaded_mussel.gltf',
    unsure: 'A THREE.GLTFExporter scene with no extras and no receipt folder beside it. Either a '
      + 'Spline export of your own work, in which case it needs no credit, or a download whose '
      + 'origin is not on this machine. musselopen.glb comes from the same file.',
  },
  'crabbase.glb': {
    title: '',
    author: '',
    authorUrl: '',
    licence: '',
    licenceUrl: '',
    source: '',
    receipt: '',
    unsure: 'Authored in Blender (glTF Blender I/O v5.0.21) and referenced by nothing in path/src '
      + '— it looks like a dead file. Delete it and the question goes away.',
  },
};
OFFLINE['musselopen.glb'] = { ...OFFLINE['mussel.glb'] };
for (const n of ['orca_male.glb', 'orca_female.glb', 'orca_calf.glb']) {
  OFFLINE[n] = { ...OFFLINE['orca.split'] };
}
delete OFFLINE['orca.split'];

// --- non-model assets, each with the file that already documents it ---------

const OTHER = [
  {
    what: 'Controller and key prompt icons (art/device-icons/)',
    author: 'Kenney',
    authorUrl: 'https://www.kenney.nl',
    licence: 'CC0 1.0 (public domain, no attribution required)',
    licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    detail: 'Input Prompts pack 1.5A, files unmodified. See art/device-icons/README.md.',
  },
  {
    what: 'UI typefaces (public/fonts/)',
    author: 'Google Fonts',
    authorUrl: 'https://fonts.google.com',
    licence: 'SIL Open Font License 1.1',
    licenceUrl: 'https://openfontlicense.org',
    detail: 'Self-hosted webfont subsets, generated by google-webfonts-helper.',
  },
  {
    what: 'Rive typefaces (rive/sealitaire/fonts/)',
    author: 'Google Fonts',
    authorUrl: 'https://fonts.google.com',
    licence: 'SIL Open Font License 1.1',
    licenceUrl: 'https://openfontlicense.org',
    detail: 'Abril Fatface, Brygada 1918, Inter.',
  },
];

// The font families the stylesheet actually declares, read rather than typed.
function fontFamilies() {
  const css = join(ROOT, 'public/fonts/fonts.css');
  if (!existsSync(css)) return [];
  const names = new Set();
  for (const m of readFileSync(css, 'utf8').matchAll(/font-family:\s*['"]([^'"]+)['"]/g)) names.add(m[1]);
  return [...names].sort();
}

function runtimeDeps() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return Object.keys(pkg.dependencies ?? {}).sort().map((name) => {
    const p = join(ROOT, 'node_modules', name, 'package.json');
    const licence = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).license ?? '?' : 'not installed';
    return { name, licence };
  });
}

// --- resolve every shipped model -------------------------------------------

function shippedModels() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(glb|gltf|fbx|obj)$/i.test(e)) out.push(relative(MODELS, full));
    }
  };
  walk(MODELS);
  return out.sort();
}

function resolve1(rel) {
  const own = /\.(glb|gltf)$/i.test(rel) ? fromExtras(readExtras(join(MODELS, rel)), 'in the file') : null;
  if (own) return { file: rel, ...own };

  const d = DERIVED[rel];
  if (d) {
    const src = join(d[0], d[1]);
    const rec = fromExtras(readExtras(src), `${d[1]} — cut by ${d[2]}`);
    if (rec) return { file: rel, ...rec };
    return { file: rel, unresolved: `source art missing from this machine: ${src}` };
  }

  const o = OFFLINE[basename(rel)];
  if (o) {
    if (o.unsure || !o.author) return { file: rel, ...o, needsYou: o.unsure ?? 'no record found' };
    return { file: rel, ...o, origin: o.receipt };
  }
  return { file: rel, unresolved: 'nothing in the file and no mapping for it' };
}

// --- report -----------------------------------------------------------------

const rows = shippedModels().map(resolve1);
const gaps = rows.filter((r) => r.unresolved || r.needsYou);

// Group the credited rows by the work they came from, so one source that
// became nineteen props is one credit line and not nineteen.
const byWork = new Map();
for (const r of rows) {
  if (r.unresolved || r.needsYou) continue;
  const key = `${r.author} ${r.title} ${r.licence}`;
  if (!byWork.has(key)) byWork.set(key, { ...r, files: [] });
  byWork.get(key).files.push(r.file);
}
const works = [...byWork.values()].sort((a, b) => (a.author + a.title).localeCompare(b.author + b.title));

const needsCredit = (w) => /^CC-BY/i.test(w.licence);

// A licence that forbids a paid build, derived from the licence string rather
// than judged. `NC` is the one that matters most here: it is not a credit
// problem, it is a ship problem, and it is invisible in a list sorted by author
// because it reads like every other CC-BY line.
const nonCommercial = (w) => /-NC(-|$)/i.test(w.licence);
const shareAlike = (w) => /-SA(-|$)/i.test(w.licence);

// Titles whose UPLOADER granted a licence they may not have held. A Creative
// Commons tag on a model of someone else's character does not make the
// character Creative Commons; the underlying rights never moved. This is a
// judgement about the title and so it is typed, unlike everything above.
const BORROWED_IP = {
  'shark.glb': 'The title names Jaws Unleashed (Majesco, 2006). If this is a rip of that '
    + 'game’s asset, the CC-BY tag is the uploader’s to give and not theirs to give.',
  'sharkhood.glb': 'Gawr Gura is a Hololive / Cover Corp. character. The hat is fan work; the '
    + 'design is not the uploader’s to license.',
  'harp.glb': 'Ported from Poly by Google, which shut down in 2021. The CC-BY is plausible — '
    + 'Poly was CC-BY — but the original author is not named in the file.',
};

function markdown() {
  const L = [];
  L.push('# Credits and attribution');
  L.push('');
  L.push('Generated by `npm run credits`. Do not hand-edit — the author, licence and source');
  L.push('of every Sketchfab model are read out of the `.glb` itself, and the mapping from a');
  L.push('shipped file back to the art it was cut from lives in `tools/credits.mjs`.');
  L.push('');
  L.push('All music and sound effects are original work and are not listed here.');
  L.push('');

  // The risks go first, because a credit line does not fix any of them.
  const restricted = works.filter((w) => nonCommercial(w) || shareAlike(w));
  const borrowed = works.filter((w) => w.files.some((f) => BORROWED_IP[basename(f)]));
  if (restricted.length || borrowed.length) {
    L.push('## Before this ships for money');
    L.push('');
    L.push('Nothing in this section is fixed by adding a credit line.');
    L.push('');
    if (restricted.length) {
      L.push('**Non-commercial or share-alike.** A paid build cannot carry these as they stand.');
      L.push('Each one needs the artist’s written permission, a paid licence, or a replacement model.');
      L.push('');
      L.push('| Work | Author | Licence | Used as | Why it blocks |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const w of restricted) {
        const why = nonCommercial(w) && shareAlike(w)
          ? 'no commercial use, and derivatives must carry the same licence'
          : nonCommercial(w) ? 'no commercial use' : 'derivatives must carry the same licence';
        const title = w.source ? `[${w.title}](${w.source})` : w.title;
        L.push(`| ${title} | [${w.author}](${w.authorUrl}) | ${w.licence} | ${w.files.join(', ')} | ${why} |`);
      }
      L.push('');
    }
    if (borrowed.length) {
      L.push('**Licensed by someone who may not have held the rights.** The Creative Commons tag on');
      L.push('these is the uploader’s; the underlying design belongs to someone else.');
      L.push('');
      for (const w of borrowed) {
        for (const f of w.files) {
          if (BORROWED_IP[basename(f)]) L.push(`- **${f}** — “${w.title}” by ${w.author}. ${BORROWED_IP[basename(f)]}`);
        }
      }
      L.push('');
    }
  }

  const cc = works.filter(needsCredit);
  const rest = works.filter((w) => !needsCredit(w));

  L.push('## 3D models — attribution required');
  L.push('');
  L.push('Creative Commons Attribution. Each line must appear wherever the game credits are shown.');
  L.push('');
  L.push('| Work | Author | Licence | Used as |');
  L.push('| --- | --- | --- | --- |');
  for (const w of cc) {
    const title = w.source ? `[${w.title}](${w.source})` : w.title;
    const author = w.authorUrl ? `[${w.author}](${w.authorUrl})` : w.author;
    const lic = w.licenceUrl ? `[${w.licence}](${w.licenceUrl})` : w.licence;
    L.push(`| ${title} | ${author} | ${lic} | ${w.files.join(', ')} |`);
  }
  L.push('');

  L.push('## 3D models — no attribution required');
  L.push('');
  L.push('Licensed but not credit-bearing. Listed so the provenance of every shipped file is on');
  L.push('the record, and because crediting them anyway costs nothing.');
  L.push('');
  L.push('| Work | Author | Licence | Used as |');
  L.push('| --- | --- | --- | --- |');
  for (const w of rest) {
    const title = w.source ? `[${w.title}](${w.source})` : w.title;
    const author = w.authorUrl ? `[${w.author}](${w.authorUrl})` : w.author;
    const lic = w.licenceUrl ? `[${w.licence}](${w.licenceUrl})` : w.licence;
    L.push(`| ${title} | ${author} | ${lic} | ${w.files.join(', ')} |`);
  }
  L.push('');

  L.push('## Icons, fonts and other art');
  L.push('');
  L.push('| What | Author | Licence | Notes |');
  L.push('| --- | --- | --- | --- |');
  for (const o of OTHER) {
    L.push(`| ${o.what} | [${o.author}](${o.authorUrl}) | [${o.licence}](${o.licenceUrl}) | ${o.detail} |`);
  }
  L.push('');
  const fams = fontFamilies();
  if (fams.length) {
    L.push(`Font families declared in \`public/fonts/fonts.css\`: ${fams.join(', ')}.`);
    L.push('');
  }
  L.push('Level-up hex card art, the starfish sprites, the flag and the app icon are original');
  L.push('work. Emissive masks in `public/textures/emissive/` are generated from each model’s');
  L.push('own texture, so they carry that model’s licence and need no separate line.');
  L.push('');

  L.push('## Software');
  L.push('');
  L.push('| Package | Licence |');
  L.push('| --- | --- |');
  for (const d of runtimeDeps()) L.push(`| ${d.name} | ${d.licence} |`);
  L.push('');

  if (gaps.length) {
    L.push('## Unresolved');
    L.push('');
    L.push('Shipped files whose origin nothing on this machine can prove. Each one is either a');
    L.push('missing credit or a file to delete.');
    L.push('');
    for (const g of gaps) {
      L.push(`- **${g.file}** — ${g.unresolved ?? g.needsYou}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// --- filling the design frame ----------------------------------------------
//
// design/components/credits.html is the screen's layout. It ships six real rows
// so it reads in the design pane with nothing run; this replaces the block
// between its ROWS BEGIN/END markers with the whole roster.
//
// IT EDITS BETWEEN MARKERS RATHER THAN WRITING THE FILE, because everything
// else in that file — the stylesheet, the scaffolding, the lorem labels — is
// design work and this tool has no business regenerating it.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (text, href) => (href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text));

// A CHIP HOLDS A TAG, NOT A SENTENCE. "TurboSquid Royalty-Free (no attribution
// required)" is a correct licence name and a 300px pill, wider than the author
// column beside it. The long form stays in CREDITS.md, where it is prose in a
// table and has room; the screen gets the short one. `title` carries the full
// string so nothing is actually lost on hover.
const CHIP = {
  'TurboSquid Royalty-Free (no attribution required)': 'TurboSquid RF',
  'Sketchfab Store (royalty-free, paid)': 'Sketchfab Store',
  'SKETCHFAB Standard': 'Sketchfab Standard',
};

function rowHtml(w) {
  const restricted = nonCommercial(w) || shareAlike(w) ? ' sv-cr-restricted' : '';
  const chip = CHIP[w.licence] ?? w.licence;
  const title = chip === w.licence ? '' : ` title="${esc(w.licence)}"`;
  return [
    '            <div class="sv-cr-row">',
    `              <div class="sv-cr-work">${link(w.title || '—', w.source)}</div>`,
    `              <div class="sv-cr-author">${link(w.author, w.authorUrl)}</div>`,
    `              <div class="sv-cr-licence${restricted}"${title}>${esc(chip)}</div>`,
    `              <div class="sv-cr-files">${esc(w.files.join(', '))}</div>`,
    '            </div>',
  ].join('\n');
}

function fillFrame() {
  const file = join(ROOT, 'design/components/credits.html');
  if (!existsSync(file)) {
    console.error('design/components/credits.html is missing — nothing to fill.');
    process.exit(1);
  }
  let html = readFileSync(file, 'utf8');
  // Every model, credit-bearing first, then the rest; one row per WORK, so a
  // source that became nineteen props is one line and not nineteen.
  const ordered = [...works.filter(needsCredit), ...works.filter((w) => !needsCredit(w))];
  const body = `\n          <div class="sv-cr-rows">\n\n${ordered.map(rowHtml).join('\n\n')}\n\n          </div>\n          `;
  const re = /(<!-- ROWS BEGIN cc[\s\S]*?-->)[\s\S]*?(<!-- ROWS END cc -->)/;
  if (!re.test(html)) {
    console.error('ROWS BEGIN/END cc markers not found in the frame — refusing to guess.');
    process.exit(1);
  }
  html = html.replace(re, (_, open, close) => `${open}${body}${close}`);
  writeFileSync(file, html);
  console.log(`design/components/credits.html  ${ordered.length} rows`);
}

if (args.includes('--html')) {
  fillFrame();
  process.exit(0);
}

if (GAPS_ONLY) {
  if (!gaps.length) console.log('Nothing unresolved.');
  for (const g of gaps) console.log(`${g.file}\n  ${g.unresolved ?? g.needsYou}\n`);
  process.exit(0);
}

const md = markdown();
if (WRITE) {
  writeFileSync(join(ROOT, 'CREDITS.md'), `${md}\n`);
  console.log(`CREDITS.md  ${works.length} works, ${rows.length} files, ${gaps.length} unresolved`);
} else {
  console.log(md);
  console.log(`\n— ${works.length} works, ${rows.length} files, ${gaps.length} unresolved. --write to save.`);
}
