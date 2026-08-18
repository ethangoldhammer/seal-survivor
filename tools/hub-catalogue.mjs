// ============================================================================
// THE CATALOGUE — every custom tool in this repo, as data.
//
// This is what tools/hub.mjs renders. It exists as its own module for one
// reason: the hub must never be a hand-written list of what the repo used to
// contain. A page that lists eighty of the hundred-and-forty tools is worse
// than no page at all, because it makes the missing sixty look like they do
// not exist.
//
// So almost nothing here is typed out. The command list IS package.json's
// scripts, and each one's description is read out of the header comment of the
// file it runs — the banner every tool in tools/ already carries. Add a script
// with a header and it appears in the hub with no edit here. Add one without,
// and tools/hub-test.mjs fails until it either has a header or an entry in
// BLURBS below.
//
// The two things that ARE typed out are the ones no file can tell us:
//
//   GROUP — which drawer a tool belongs in. Derived from the script name where
//           the prefix says it (`test:`, `looks:`, `playtest:`) and named
//           explicitly otherwise. An unlisted script fails the test rather
//           than landing in a silent "Other" bucket nobody reads.
//
//   RISK  — what running it does to the world. The hub will run a check for
//           you; it will not deploy for you. See RISK below.
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// RISK — the only classification in this file that can cost you something.
//
//   check    reads the repo and prints. Nothing on disk changes. Run freely.
//   writes   rewrites files in the tree — generated assets, atlases, tables.
//            Runnable from the hub, but it says so on the button, because the
//            answer to "what did that do" should not be `git status`.
//   serves   starts a long-running server. The hub links to the URL it prints
//            rather than waiting for it to exit.
//   publish  puts something in front of other people, or rewrites history.
//            NOT runnable from the hub at all — these get a copyable command
//            and nothing else. A deploy is a decision, and a decision should
//            not be one stray click away from a page you leave open all day.
// ---------------------------------------------------------------------------
const PUBLISH = new Set(['deploy', 'deploy:preview', 'ship']);

const WRITES = new Set([
  'build', 'whale', 'notes', 'split', 'placeholder', 'webp', 'shaders:apply',
  'rig:guest', 'sfx:atlas', 'playtest:pull', 'playtest:atlas', 'playtest:sync',
  'upgrades:icons',
]);

// Long-running: the process does not exit on its own, and that is correct.
const SERVES = new Set(['dev', 'csv', 'preview', 'hub', 'atlas']);

// ---------------------------------------------------------------------------
// GROUPS — the drawers, in the order the hub shows them.
// ---------------------------------------------------------------------------
export const GROUP_ORDER = [
  'Servers', 'Authoring', 'Audits', 'Assets', 'Look pages', 'Playtest', 'Checks', 'Publish',
];

// Prefixes first — these are the groups that grow on their own.
const GROUP_BY_PREFIX = [
  [/^test:/, 'Checks'],
  [/^looks:/, 'Look pages'],
  [/^playtest/, 'Playtest'],
  [/^sim:/, 'Audits'],
];

// Everything else, named. A script missing from here fails hub-test rather
// than quietly appearing in a bucket called "Other".
const GROUP_BY_NAME = {
  dev: 'Servers', csv: 'Servers', preview: 'Servers', hub: 'Servers', servers: 'Servers',
  atlas: 'Servers',
  build: 'Publish', deploy: 'Publish', 'deploy:preview': 'Publish', ship: 'Publish',
  perf: 'Audits', tex: 'Audits', glow: 'Audits', layout: 'Audits', 'sfx:atlas': 'Audits',
  bones: 'Assets', split: 'Assets', whale: 'Assets', notes: 'Assets', takes: 'Assets',
  placeholder: 'Assets', webp: 'Assets', 'rig:guest': 'Assets', 'shaders:apply': 'Assets',
  test: 'Checks',
};

// ---------------------------------------------------------------------------
// BLURBS — the handful of scripts whose target file has no usable header, or
// where the header's first sentence is about something other than the script.
// Every other description in the hub is read off disk.
// ---------------------------------------------------------------------------
const BLURBS = {
  dev: 'The game, on a vite dev server. Writes imported-tuning.json — run exactly one.',
  build: 'Production build into dist/. No server; use preview to look at it.',
  preview: 'Serves the last build in dist/. Goes stale silently — rebuild before trusting it.',
  deploy: 'Builds and publishes straight to the live site, with no commit.',
  'deploy:preview': 'Builds and publishes to preview.seal-survivor.pages.dev, leaving production alone.',
  hub: 'This page. The index of every tool in the repo, on a port that never moves.',
  test: 'Every check in the repo, chained. The first failure hides the rest — see npm-test-is-and-chained.',
  'playtest:sync': 'Pulls remote runs and rebuilds the playtest atlas from them in one step.',
};

// ---------------------------------------------------------------------------
// READING A DESCRIPTION OUT OF A TOOL
//
// Every tool in tools/ opens with a banner: a rule, the command line that runs
// it, a blank comment line, then prose. We want the first sentence of the
// prose — it is, without exception in this repo, the sentence that says what
// the thing is for.
//
// Fails soft in both directions. A file with no banner returns '' and the
// entry shows its command instead; a banner in an unexpected shape returns
// whatever its first prose line was, which is still better than nothing.
// ---------------------------------------------------------------------------
export function blurbFromFile(file) {
  if (!existsSync(file)) return '';
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }

  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#!')) continue;                 // shebang
    if (line === '') { if (lines.length) break; continue; }
    if (!line.startsWith('//')) break;                   // banner is over
    const body = line.replace(/^\/\/\s?/, '').trimEnd();
    if (/^[-=]{3,}$/.test(body)) continue;               // rule line
    if (body === '') { if (lines.length) break; continue; } // blank line INSIDE
    if (/^(npm run |node |vite )/.test(body)) continue;  // the usage line
    lines.push(body);
  }
  if (!lines.length) return '';

  // First sentence. `. ` followed by a capital, or the end of the paragraph —
  // which keeps "three.js" and "e.g." from cutting a description in half.
  const para = lines.join(' ').replace(/\s+/g, ' ');
  const m = /^(.+?[.?!])(\s+[A-Z(]|$)/.exec(para);
  return (m ? m[1] : para).trim();
}

// The file a script actually runs, if it runs one. `--import ./tools/...` is
// the loader shim, never the subject, so the LAST .mjs on the line wins.
export function targetFile(command) {
  const files = [...command.matchAll(/(?:^|\s)((?:tools|path|server)\/[\w./-]+\.(?:mjs|js))/g)].map((m) => m[1]);
  const subject = files.filter((f) => !f.endsWith('vite-loader.mjs')).pop();
  return subject ? join(ROOT, subject) : '';
}

function groupOf(name) {
  for (const [re, group] of GROUP_BY_PREFIX) if (re.test(name)) return group;
  return GROUP_BY_NAME[name] ?? '';
}

function riskOf(name) {
  if (PUBLISH.has(name)) return 'publish';
  if (SERVES.has(name)) return 'serves';
  if (WRITES.has(name)) return 'writes';
  if (/^looks:/.test(name)) return 'serves';   // builds, then serves the page
  return 'check';
}

// ---------------------------------------------------------------------------
// THE COMMANDS — package.json's scripts, described and sorted.
// ---------------------------------------------------------------------------
export function commands() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return Object.entries(pkg.scripts).map(([name, command]) => {
    const file = targetFile(command);
    return {
      name,
      command,
      file: file ? file.slice(ROOT.length + 1) : '',
      group: groupOf(name),
      risk: riskOf(name),
      blurb: BLURBS[name] ?? blurbFromFile(file),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// THE PAGES — browser tools, which package.json knows nothing about.
//
// `on` says which server puts it on an origin, because that is the fact you
// need and the one that is easy to get wrong:
//
//   dev    a page in the repo root, served by `npm run dev`. Its port MOVES,
//          so the hub rewrites these links against whatever the dev server is
//          on right now. This is the whole reason bookmarking a port fails.
//   own    the tool brings its own server on a fixed port.
//   built  a vite BUILD that a script builds and serves on demand — there is
//          nothing to link to until you run it, so the hub offers the script.
// ---------------------------------------------------------------------------
export const PAGES = [
  { file: 'index.html', on: 'dev', path: '/', title: 'The game',
    blurb: 'Seal Survivor itself. Backtick opens the tuner, T the workbench.' },
  { file: 'tuner.html', on: 'dev', path: '/tuner.html', title: 'Standalone tuner',
    blurb: 'The tuning panels with no game behind them. Same writer as the in-game panel — use one or the other, never both.' },
  { file: 'model-inspector.html', on: 'dev', path: '/model-inspector.html', title: 'Model inspector',
    blurb: 'Every model in the repo on one contact sheet, with its bones and bounds.' },
  { file: 'biolum-preview.html', on: 'dev', path: '/biolum-preview.html', title: 'Bioluminescent skins',
    blurb: 'Contact sheet of every biolumSkin preset against the creatures that wear it.' },
  { file: 'crab-skins.html', on: 'dev', path: '/crab-skins.html', title: 'Crab shells',
    blurb: 'Shell pattern options for the crab, side by side.' },
  { file: 'boat-preview.html', on: 'dev', path: '/boat-preview.html', title: 'Boat preview',
    blurb: 'The boat models and their destruction states.' },
  { file: 'orbit-preview.html', on: 'dev', path: '/orbit-preview.html', title: 'Orbit preview',
    blurb: 'Orbiting-ability visuals against a stationary seal.' },
  { file: 'perf-probe.html', on: 'dev', path: '/perf-probe.html', title: 'Perf probe',
    blurb: 'Frame cost of one system at a time, isolated from a real run.' },
  { file: 'rive-test.html', on: 'dev', path: '/rive-test.html', title: 'Rive splash harness',
    blurb: 'Drives seal_survivor.riv outside the game — artboards, state machines, data binding.' },

  { file: 'tools/csv-editor.html', on: 'own', server: 'csv', script: 'csv', port: 5177, path: '/', title: 'CSV editor',
    blurb: 'Spreadsheet for enemies, upgrades and quips, with the game’s own column rules baked into every cell.' },
  { file: 'tools/atlas-render/render.html', on: 'own', port: 4599, path: '/render.html',
    script: 'atlas', title: 'Atlas renderer',
    blurb: 'Renders every model portrait for the Model Atlas in a real browser.' },
  { file: 'tools/atlas-render/picker.html', on: 'own', port: 4599, path: '/picker.html',
    script: 'atlas', title: 'Atlas picker',
    blurb: 'Pick and frame the portrait pose for a model.' },
  { file: 'tools/atlas-render/audition.html', on: 'own', port: 4599, path: '/audition.html',
    script: 'atlas', title: 'Clip audition',
    blurb: 'Play a model’s clips back to back to choose a take.' },
  { file: 'tools/atlas-render/rig-transfer.html', on: 'own', port: 4599, path: '/rig-transfer.html',
    script: 'atlas', title: 'Rig transfer',
    blurb: 'Compare two rigs bone by bone before retargeting a clip between them.' },

  { file: 'tools/looks/shader-lab.html', on: 'built', script: 'looks:shaderlab', title: 'Shader lab' },
  { file: 'tools/looks/skins.html', on: 'built', script: 'looks:skins', title: 'Skins' },
  { file: 'tools/looks/kill-goo.html', on: 'built', script: 'looks:goo', title: 'Kill goo' },
  { file: 'tools/looks/gore.html', on: 'built', script: 'looks:gore', title: 'Gore' },
  { file: 'tools/looks/cash-ordnance.html', on: 'built', script: 'looks:cash', title: 'Cash ordnance' },
  { file: 'tools/looks/note-storm.html', on: 'built', script: 'looks:notes', title: 'Note storm' },
  { file: 'tools/looks/crab-reach.html', on: 'built', script: 'looks:crab', title: 'Crab reach' },
  { file: 'tools/looks/whale-sweep.html', on: 'built', script: 'looks:whale', title: 'Whale sweep' },
].map((p) => ({ ...p, blurb: p.blurb ?? blurbFromFile(join(ROOT, p.file.replace(/\.html$/, '.js'))) }));
