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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
const PUBLISH = new Set(['deploy', 'deploy:preview', 'ship', 'ship:all', 'ship:ios']);

const WRITES = new Set([
  'build', 'whale', 'notes', 'split', 'mussels', 'placeholder', 'webp', 'shaders:apply',
  'anglerfish', 'guest', 'icons', 'icons:sheet',
  'rig:guest', 'sfx:atlas', 'playtest:pull', 'playtest:atlas', 'playtest:sync',
  'upgrades:icons', 'ktx2', 'props', 'seabed', 'icons:app', 'spline:kit',
  'ios', 'ios:run', 'ios:sync',
]);

// Long-running: the process does not exit on its own, and that is correct.
const SERVES = new Set(['dev', 'csv', 'preview', 'hub', 'atlas', 'icons:pick', 'pick']);

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
  // `look:` (no s) is the same idea without a server: the page is written to
  // disk by a jsdom run and opened by hand, so it can never touch the tuning.
  [/^look:/, 'Look pages'],
  [/^playtest/, 'Playtest'],
  [/^sim:/, 'Audits'],
];

// Everything else, named. A script missing from here fails hub-test rather
// than quietly appearing in a bucket called "Other".
const GROUP_BY_NAME = {
  dev: 'Servers', csv: 'Servers', preview: 'Servers', hub: 'Servers', servers: 'Servers',
  atlas: 'Servers', 'icons:pick': 'Servers', pick: 'Servers',
  build: 'Publish', deploy: 'Publish', 'deploy:preview': 'Publish', ship: 'Publish',
  perf: 'Audits', tex: 'Audits', glow: 'Audits', layout: 'Audits', 'sfx:atlas': 'Audits',
  // Reports by default and only rewrites files with --write, so it reads as
  // an audit until you ask it not to.
  'sfx:trim': 'Audits',
  // Writes the sample assignments for one recording session into the tuning
  // file — an asset job, not a check.
  'sfx:assign': 'Assets',
  // Cuts a usable one-shot out of a long library bed. An asset job, and
  // destructive with --write.
  'sfx:excerpt': 'Assets',
  bones: 'Assets', split: 'Assets', mussels: 'Assets', whale: 'Assets', notes: 'Assets', takes: 'Assets',
  anglerfish: 'Assets', guest: 'Assets', icons: 'Assets', 'icons:sheet': 'Assets',
  emissive: 'Audits', sockets: 'Audits', headsocket: 'Audits', 'chain:window': 'Audits',
  placeholder: 'Assets', webp: 'Assets', 'rig:guest': 'Assets', 'shaders:apply': 'Assets',
  test: 'Checks',
  // The chain trace is a CHECK that prints rather than asserts: it replays the
  // release path in main.js's own order and shows the log the in-game overlay
  // shows on C, so a player's screenshot and a harness run can be compared.
  'chain:trace': 'Checks',
'audit:hitboxes': 'Audits', 'copy:review': 'Audits', 'net:glsl': 'Audits',
  'net:look': 'Look pages',
  ktx2: 'Assets', props: 'Assets', seabed: 'Assets', 'icons:app': 'Assets',
  'spline:kit': 'Assets',
  // The iOS build drives Xcode and a device, so it lives with the other things
  // that leave this machine rather than with the web build.
  ios: 'Publish', 'ios:run': 'Publish', 'ios:sync': 'Publish',
  'ship:all': 'Publish', 'ship:ios': 'Publish',
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
  ios: 'Builds, syncs the Capacitor iOS project, and opens it in Xcode.',
  'ios:run': 'Builds, syncs, and runs the iOS app on a simulator or attached device.',
  'ios:sync': 'Builds and syncs the web bundle into the Capacitor iOS project. No Xcode.',
  // No banner on tools/head-socket-measure.mjs yet — its sibling
  // eye-socket-measure.mjs has one, and this stands in until it does.
  headsocket: 'Where a head-mounted socket lands on a rig, measured rather than guessed.',
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
// ---------------------------------------------------------------------------
// LOOK PAGES — derived, because a hand-written list of them went stale in
// forty-eight hours.
//
// This file shipped with eight look pages typed out. Two days later there were
// twenty-six, and the hub was confidently showing a third of them — which is
// the precise failure this module's header warns about, committed by the
// module itself. So they are read out of the build configs instead:
//
//   npm run looks:<x>  ->  --config tools/looks/vite.<x>.config.mjs
//                      ->  input:  tools/looks/<page>.html   (what to open)
//                          outDir: dist-<x>                  (how to tell
//                                  which running server is serving it)
//
// The outDir is the load-bearing half. Several look servers can be up at once
// and they no longer share a port, so "is this page being served, and where"
// is answered by matching a server's command line against its dist directory,
// never by assuming an address.
//
// The URL path is `/` + the input path relative to the project root: vite
// keeps the input's own path in the output, and serve.mjs mounts the build at
// the root. Deriving it rather than assuming `/index.html` is why these links
// land on the page instead of on a 404 that says "no".
// ---------------------------------------------------------------------------
function lookPages(scripts) {
  const out = [];
  const claimed = new Set();

  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('looks:')) continue;
    const cfg = /--config\s+(\S+)/.exec(command)?.[1];
    if (!cfg) continue;
    let src = '';
    try { src = readFileSync(join(ROOT, cfg), 'utf8'); } catch { continue; }

    // EVERY input, not the first. `input:` takes a string, an array of them, or
    // a whole block — vite.tip.config.mjs builds two pages from one config, and
    // matching only the first shape silently loses the second page. matchAll
    // over the config's HERE-relative html names is shape-agnostic and cannot
    // quietly return one when there were two.
    const block = /input:\s*(\[[^\]]*\]|\{[^}]*\}|resolve\([^)]*\))/.exec(src)?.[1] ?? '';
    const found = [...block.matchAll(/resolve\(HERE,\s*'([^']+\.html)'\)/g)].map((m) => m[1]);
    const outDir = /outDir:\s*resolve\(PROJECT,\s*'([^']+)'/.exec(src)?.[1]
      ?? /--outDir\s+(\S+)/.exec(command)?.[1];
    if (!found.length || !outDir) continue;

    for (const page of found) {
      claimed.add(page);
      out.push(lookCard(page, { script: name, outDir }));
    }
  }

  // A look page with no script that builds it. It is still a tool, it is still
  // on disk, and leaving it off the page means the only way to know it exists
  // is to already know — so it gets a card that says plainly that nothing
  // builds it. Hiding it would make the index a liar in the one direction it
  // cannot afford, and this is how yacht-deck and trail-looks were invisible.
  let onDisk = [];
  try { onDisk = readdirSync(join(ROOT, 'tools/looks')).filter((f) => f.endsWith('.html')); } catch { /* none */ }
  for (const page of onDisk) {
    if (!claimed.has(page)) out.push(lookCard(page, { orphan: true }));
  }

  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function lookCard(page, extra) {
  const file = `tools/looks/${page}`;
  return {
    file, on: 'built', path: `/${file}`,
    title: titleOf(join(ROOT, file)) || page.replace(/\.html$/, ''),
    blurb: blurbFromFile(join(ROOT, file.replace(/\.html$/, '.js'))),
    ...extra,
  };
}

// The page's own <title>, minus the "Name — the rest of the sentence" tail that
// most of them carry: the tail is the description, and it is already the blurb.
function titleOf(file) {
  if (!existsSync(file)) return '';
  try {
    const m = /<title>([^<]*)<\/title>/i.exec(readFileSync(file, 'utf8'));
    return m ? m[1].split(/\s+[—–-]\s+/)[0].trim() : '';
  } catch { return ''; }
}

const FIXED_PAGES = [
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
  { file: 'hive-stacks.html', on: 'dev', path: '/hive-stacks.html', title: 'Hex hive',
    blurb: 'Hive tile layouts and styles, side by side — the stacked-sibling arrangement the upgrade hive uses.' },

  { file: 'tools/csv-editor.html', on: 'own', server: 'csv', script: 'csv', port: 5177, path: '/', title: 'CSV editor',
    blurb: 'Spreadsheet for enemies, upgrades and quips, with the game’s own column rules baked into every cell.' },
  { file: 'tools/atlas-render/render.html', on: 'own', port: 4599, path: '/render.html',
    script: 'icons:pick', title: 'Icon renderer',
    blurb: 'Batch-renders every icon from the angles the picker chose, and POSTs the PNGs back. Needs real WebGL, which is why it runs in a browser.' },
  { file: 'tools/atlas-render/picker.html', on: 'own', port: 4599, path: '/picker.html',
    script: 'icons:pick', title: 'Icon picker',
    blurb: 'Choose the yaw, pitch and clip time for each upgrade-card icon by eye, then bake the numbers straight into upgradeIcons.js.' },
  { file: 'tools/atlas-render/audition.html', on: 'own', port: 4599, path: '/audition.html',
    script: 'icons:pick', title: 'Clip audition',
    blurb: 'Play a model’s clips back to back to choose a take.' },
  { file: 'tools/atlas-render/rig-transfer.html', on: 'own', port: 4599, path: '/rig-transfer.html',
    script: 'icons:pick', title: 'Rig transfer',
    blurb: 'Compare two rigs bone by bone before retargeting a clip between them.' },

];

// Called per request, never cached in a module constant. The hub is left open
// for days while the repo grows underneath it — a list frozen at import is a
// hub that silently stops mentioning anything added after you started it, and
// that is not a theoretical failure: it is how a shader lab that existed, was
// catalogued and was already being served still could not be found on this
// page.
export function pages() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return [...FIXED_PAGES, ...lookPages(pkg.scripts)]
    .map((p) => ({ ...p, blurb: p.blurb || blurbFromFile(join(ROOT, p.file.replace(/\.html$/, '.js'))) }));
}

// Kept as a live getter so anything still reading PAGES sees current data
// rather than a snapshot.
export const PAGES = pages();
