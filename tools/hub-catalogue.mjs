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
//
//            ONE EXCEPTION, and it is not an exception to the risk class:
//            `ship:all` stays `publish` and stays button-less HERE, in the
//            list of a hundred and thirty scripts. It has a card of its own at
//            the top of the page that takes a typed commit message and a held
//            press — see hub-ship.mjs for the terms. The distinction that
//            matters is between a button in a row you might scroll past and a
//            control you have to mean.
//
// The names are the names in package.json. `ship:ios` used to be listed here
// and no such script has ever existed, which meant the two that DO —
// `ship:phone` and `ship:mac` — fell through to `check` and rendered with a
// green one-click run button. A set of strings that is never checked against
// the scripts it names will go stale exactly this quietly, so test:hub now
// asserts every ship*/deploy* script is in here.
const PUBLISH = new Set([
  'deploy', 'deploy:preview',
  'ship', 'ship:all', 'ship:phone', 'ship:mac',
]);

const WRITES = new Set([
  'notex', 'accessories:icons',
  'build', 'whale', 'humpback', 'notes', 'split', 'mussels', 'placeholder', 'webp', 'shaders:apply', 'accessories:apply', 'accessories:import',
  'anglerfish', 'guest', 'icons', 'icons:sheet',
  'rig:guest', 'sfx:atlas', 'playtest:pull', 'playtest:atlas', 'playtest:sync',
  'upgrades:icons', 'ktx2', 'props', 'seabed', 'icons:app', 'spline:kit', 'shrink',
  'ios', 'ios:run', 'ios:sync',
  'sealitaire:pull:apply',
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
  atlas: 'Servers', 'icons:pick': 'Servers', 'accessories:pick': 'Servers',
  'accessories:icons': 'Assets', pick: 'Servers',
  'acc:render': 'Assets', 'feel:apply': 'Assets', 'rig:manowar': 'Assets',
  build: 'Publish', deploy: 'Publish', 'deploy:preview': 'Publish', ship: 'Publish',
  // The CI gate. It runs checks, but it is deliberately OUTSIDE the `test:`
  // prefix (ship.mjs gates on every test:* script and would run all 296 of
  // these a second time), so the prefix rule cannot place it and it is named
  // here instead.
  'ci:test': 'Checks',
  // Sets up the git merge driver .gitattributes depends on. Not a check and
  // not a build — it configures this clone, which is the closest thing to
  // authoring the repo itself.
  mergedriver: 'Authoring', prepare: 'Authoring',
  perf: 'Audits', tex: 'Audits', glow: 'Audits', layout: 'Audits', 'sfx:atlas': 'Audits',
  notex: 'Audits',
  // The same audit as `layout`, run against the flipped viewport — it reports
  // and writes nothing, so it sits where `layout` does.
  flip: 'Audits',
  // Generates candidate colour wheels and screens them — it writes nothing and
  // the output is hex rows to paste, so it reads as authoring rather than as an
  // asset job.
  wheel: 'Authoring',
  // Reports by default and only rewrites files with --write, so it reads as
  // an audit until you ask it not to.
  'sfx:trim': 'Audits',
  // Same terms: builds CREDITS.md out of what the shipped asset files actually
  // say, and prints it unless you pass --write.
  credits: 'Audits',
  // Writes the sample assignments for one recording session into the tuning
  // file — an asset job, not a check.
  'sfx:assign': 'Assets',
  // Cuts a usable one-shot out of a long library bed. An asset job, and
  // destructive with --write.
  'sfx:excerpt': 'Assets',
  bones: 'Assets', split: 'Assets', mussels: 'Assets', whale: 'Assets', humpback: 'Assets', notes: 'Assets', takes: 'Assets',
  anglerfish: 'Assets', guest: 'Assets', icons: 'Assets', 'icons:sheet': 'Assets',
  emissive: 'Audits', sockets: 'Audits', headsocket: 'Audits', 'chain:window': 'Audits',
  // Writes path/src/sourceLabels.generated.js out of uiText.csv, so the
  // import-free reader in systems/playtestAnalysis.js can have the words a
  // spreadsheet owns. It writes a source file, which is an asset job — and
  // `test:sourcelabels` regenerates and diffs, so a stale one is a red test.
  'gen:sourcelabels': 'Assets',
  placeholder: 'Assets', webp: 'Assets', 'rig:guest': 'Assets', 'shaders:apply': 'Assets', 'accessories:apply': 'Assets', 'ball:apply': 'Assets', 'imitate:train': 'Assets', 'accessories:import': 'Assets',
  test: 'Checks',
  // The chain trace is a CHECK that prints rather than asserts: it replays the
  // release path in main.js's own order and shows the log the in-game overlay
  // shows on C, so a player's screenshot and a harness run can be compared.
  'chain:trace': 'Checks',
'audit:hitboxes': 'Audits', 'copy:review': 'Audits', 'net:glsl': 'Audits',
  'aura:glsl': 'Audits',
  'net:look': 'Look pages',
  ktx2: 'Assets', props: 'Assets', seabed: 'Assets', 'icons:app': 'Assets',
  // Rewrites the source models in place, bringing every map down to the size
  // the model is drawn at. An asset job and a destructive one — and `ktx2` has
  // to run after it or the game goes on loading the old compressed twins.
  shrink: 'Assets',
  'spline:kit': 'Assets',
  // The iOS build drives Xcode and a device, so it lives with the other things
  // that leave this machine rather than with the web build.
  ios: 'Publish', 'ios:run': 'Publish', 'ios:sync': 'Publish',
  'ship:all': 'Publish', 'ship:ios': 'Publish',
  'ship:phone': 'Publish', 'ship:mac': 'Publish',
  // The desktop build is the Steam/Electron half of shipping: a vite build
  // with its own config, the shell that runs it, and the packer that wraps
  // the two into something installable.
  'build:desktop': 'Publish', 'pack:desktop': 'Publish',
  // ...and `desktop` puts the game on screen in that shell, which is a server
  // in every way that matters here.
  desktop: 'Servers',
  // Filming, which is the desktop shell with the window locked to a 1920x1080
  // capture and a recorder attached — so it sits beside `desktop` rather than
  // in a drawer of its own. `film:open` is the one you want most often: it
  // reveals the newest clip in Finder.
  film: 'Servers', 'film:setup': 'Servers', 'film:finish': 'Servers', 'film:open': 'Servers',
  'desktop:test': 'Checks', 'desktop:test:save': 'Checks', 'desktop:test:shell': 'Checks',
  'desktop:test:playtest': 'Checks',
  'audit:offline': 'Audits', 'steam:status': 'Audits', 'bait:shader': 'Audits',
  // Reads what the phone's last sessions ended as. A report, not an asset job.
  crash: 'Audits',
  // The other half of that reading: iOS's own JetsamEvent reports, which say
  // what the process WEIGHED when the kernel came for it. Also a report.
  jetsam: 'Audits',
  fonts: 'Assets',
  // Audits that print rather than assert, like `chain:trace` above: each one
  // replays a system offline and shows the numbers, and none of them writes.
  aim: 'Audits', gates: 'Audits', jaws: 'Audits', 'outline:glsl': 'Audits',
  // Reads the Mac's CoreAudio device ids for the recorder. A report.
  audio: 'Audits',
  'acc:seed': 'Assets',
  // Rewrites public/models/ with --write, like `shrink`.
  creatures: 'Assets',
  'desktop:test:capture': 'Checks', 'desktop:test:record': 'Checks',
  // THE RIVE CLI, which is the authoring loop for path/src/ui/blubberball.riv.
  // The three that produce the file are asset jobs; `rive:push` sends the
  // project to the editor, which puts it in front of somebody else.
  rive: 'Assets', 'rive:watch': 'Assets', 'rive:rev': 'Assets', 'rive:try': 'Assets',
  'rive:push': 'Publish',
  // ...and these two render the artboards to disk with the real copy pushed
  // in, which is a look page with no server in front of it — the same shape
  // as the `look:` prefix above.
  'rive:preview': 'Look pages', 'rive:live': 'Look pages',
  // Diffs a .rev from the editor back against the hand-written .rml and
  // reports; only --apply writes. The `sfx:trim` shape — an audit until you
  // ask it not to be.
  'rive:pull': 'Audits',
  // SEALITAIRE, the second Rive CLI project — Klondike on the ocean. Same
  // shape as the blubberball block above, drawer for drawer: the watcher is a
  // window you leave open, the bakers are asset jobs, verify/test are checks,
  // `sealitaire:pull` reports until you pass it --apply, and
  // `sealitaire:push` is the one that puts the file in front of somebody else.
  sealitaire: 'Servers',
  // The three Dock buttons, written into ~/Applications the way `film:setup`
  // does. One generator, one row of tools/games.mjs each — see game-app.mjs.
  'sealitaire:app': 'Servers', 'ball:app': 'Servers',
  // Blubberball's door. It starts a dev server only if there is not one
  // already, so it is the same kind of thing as the two viewers above even
  // though what it opens is a browser tab.
  ball: 'Servers',
  'sealitaire:build': 'Assets', 'sealitaire:shot': 'Assets',
  'sealitaire:card': 'Assets', 'sealitaire:mesh': 'Assets',
  'sealitaire:fish': 'Assets', 'sealitaire:music': 'Assets', 'sealitaire:loops': 'Assets',
  'sealitaire:clips': 'Assets', 'sealitaire:fbx': 'Assets',
  'sealitaire:pool': 'Assets', 'sealitaire:sheet': 'Assets',
  'sealitaire:tuner': 'Assets', 'sealitaire:rev': 'Assets',
  // The three BAKES that make the card sounds: the bank itself, the processed
  // takes printed into it (Rive's AudioSound has no filter to do it live), and
  // the SVG->PointsPath conversion. All dry until `--write`, but what they
  // produce is the asset, so they sit with the other bakers rather than with
  // the reports.
  'sealitaire:sfx': 'Assets', 'sealitaire:sfx:fx': 'Assets', 'sealitaire:svg': 'Assets',
  // Renders the table once per candidate palette into a scratch copy; it
  // writes no project file, so it is a look at something, not a bake.
  'sealitaire:bg': 'Audits',
  // Plays the bank one file at a time with the name on screen, so a keeper can
  // be written down against the event it is for. It changes nothing and the
  // output is a decision — the same reading as `wheel`.
  'sealitaire:audition': 'Authoring',
  // Exports the .riv and copies it into public/, which is the file the site
  // serves — so it is `sealitaire:push`'s sibling and not a bake. Grouped like
  // `rive:push`: in the Publish drawer, where a deploy is a decision.
  'sealitaire:ship': 'Publish',
  // ...and the same export served locally on its own port, which is a server
  // in every way that matters here — see `desktop` above.
  'sealitaire:web': 'Servers',
  'sealitaire:verify': 'Checks', 'sealitaire:test': 'Checks', 'test:sealitairetune': 'Checks',
  'sealitaire:pull': 'Audits',
  // The same diff with --apply on the line, because the workbench runs a
  // script by NAME and cannot add a flag. It writes the .rml, so it is in
  // WRITES; it sits beside the report it is the second half of.
  'sealitaire:pull:apply': 'Audits',
  'sealitaire:push': 'Publish',
  // The itch.io build and the upload of it. `itch:push` reaches butler, so it
  // sits with the other things that leave this machine.
  itch: 'Publish', 'itch:push': 'Publish',
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
  film: 'The game in the desktop shell, window locked so every clip is exactly 1920x1080, recording with sound from BlackHole. Quit the game to end the take; the clip is scaled and the folder opens.',
  test: 'Every check in the repo, chained. The first failure hides the rest — see npm-test-is-and-chained.',
  mergedriver: 'Registers the git merge driver that keeps main\'s imported-tuning.json through a merge. .gitattributes does nothing without it. Runs itself on npm install; safe to re-run.',
  prepare: 'npm\'s own install hook. Runs mergedriver so a fresh clone gets the tuning merge rule without anyone remembering to.',
  'playtest:sync': 'Pulls remote runs and rebuilds the playtest atlas from them in one step.',
  ios: 'Builds, syncs the Capacitor iOS project, and opens it in Xcode.',
  // The four desktop scripts run vite/electron/electron-builder directly, so
  // there is no tool file with a banner to read a description off.
  'build:desktop': 'Production build for the Electron shell, using vite.desktop.config.js.',
  desktop: 'Builds for the desktop shell and opens the game in an Electron window.',
  'desktop:test': 'Builds, then runs both desktop checks: the shell serves, and the save round-trips.',
  'pack:desktop': 'Builds and packs the Electron app into an unpacked directory — no installer.',
  'ios:run': 'Builds, syncs, and runs the iOS app on a simulator or attached device.',
  'ios:sync': 'Builds and syncs the web bundle into the Capacitor iOS project. No Xcode.',
  // No banner on tools/head-socket-measure.mjs yet — its sibling
  // eye-socket-measure.mjs has one, and this stands in until it does.
  headsocket: 'Where a head-mounted socket lands on a rig, measured rather than guessed.',
  // THE RIVE CLI SCRIPTS. These five run $HOME/.rive/bin/rive directly, so
  // there is no tool file in this repo with a banner to read a sentence off.
  rive: 'Builds rive/blubberball once and copies the .riv into path/src/ui/, where the game loads it.',
  'rive:watch': 'The same build, left running: every save in the .rml rebuilds the .riv.',
  'rive:rev': 'Builds, and writes a .rev beside it — the editor\'s format, which rive:pull diffs back.',
  'rive:try': 'Renders one frame of the project 60 frames in, to build/try.png. Lorem, not the real copy — see rive:preview.',
  'sealitaire:ship': 'Exports the Sealitaire .riv and copies it over public/sealitaire.riv — the file the site serves. No tool file, so the words are here.',
  // THE THREE DOCK BUTTONS run one generator, so the header of game-app.mjs
  // would describe all three identically. Each says which game it writes.
  'sealitaire:app': 'Writes Sealitaire.app into ~/Applications — the table and its tuning save loop, no terminal. Icon from rive/sealitaire/build/shot.png. Re-run after moving the repo or changing node.',
  'ball:app': 'Writes Blubberball.app into ~/Applications — finds or starts the game server and opens the pitch in a browser. No screenshot script, so it has no icon until you pass --icon.',
  'rive:push': 'Sends the local project up to the Rive editor. Checks the CLI is signed in first; if not, the first line says to run `rive login` in a terminal.',
  // THE SEALITAIRE CLI SCRIPTS, for the same reason: these six run
  // $HOME/.rive/bin/rive directly and have no tool file to read a sentence off.
  'sealitaire:build': 'Builds rive/sealitaire once into build/sealitaire.riv. No window, no watcher.',
  'sealitaire:verify': 'Compiles without writing, then reads the inspect JSON and fails on any problem it reports.',
  'sealitaire:test': 'Runs tests.luau headless: the klondike rules, the bait ball\'s walls, the music\'s onsets.',
  'sealitaire:shot': 'Renders one frame 90 frames in, to build/shot.png.',
  'sealitaire:pool': 'The LAB bake of fish.mesh: tanks.csv\'s models plus every row of pool.csv, so the tuner\'s card rows can step a card through the whole roster live. sealitaire:fish is the lean ship bake.',
  'sealitaire:sheet': 'The contact sheet: every species in fish.mesh rendered on the table, the same deal each, to build/sheet/index.html. Bake the pool first.',
  'test:sealitairetune': 'The TANKS-SAVE write-back: one tanks.csv row changes and no other byte of the file does.',
  'test:sealitairefish': 'The tank pack on disk: v2 header, joints inside their palettes, weights that sum to one, and every clip really moves its creature without changing its size.',
  'sealitaire:clips': 'Every animation clip in every model tanks.csv and pool.csv name, with its length — what a row\'s `clip` cell can pick from.',
  'sealitaire:loops': 'Where the loops are in one long bounce: the bar grid, every 4-bar block\'s level, which blocks are the same take, and the section boundaries. Needs --bpm; --write seeds musicLoops.csv.',
  'sealitaire:fbx': 'An .fbx in public/models to a .glb beside it (mesh, rig, clips; UVs flipped to glTF\'s frame), so the tank pack can bake it: `-- seagull beluga`.',
  'sealitaire:rev': 'Builds, and writes build/sealitaire.rev beside it — the editor\'s format, which sealitaire:pull diffs back. Needs `rive login`.',
  'sealitaire:pull': 'Downloads the linked Rive file and reports what changed there against the .rml — attributes only; additions, deletions and references to things we do not have are listed for a hand. Needs `rive login`, not the editor app. Writes nothing.',
  'sealitaire:pull:apply': 'The same diff, and then writes each changed attribute back into the tag it came from and re-verifies. Pull first and read the report; this is the second click.',
  'sealitaire:push': 'Sends rive/sealitaire up to the Rive editor, replacing what is open there. Pull first or the editor\'s unpulled nudges are gone. Checks the CLI is signed in first; if not, the first line says to run `rive login` in a terminal.',
  // Its banner's first sentence is the whole premise of the file (three
  // clauses about what makes a team name different), which reads as a
  // paragraph in a drawer. Same claim, one line.
  'test:teamnames': 'What a Blubberball side is called: teamNames.csv, and the two joins — the picked colour and the seals in the seats — that a vocabulary test would never check.',
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
  //
  // A sentence in these headers often opens on a lowercase name instead: a repo
  // path, `npm run x`, or a backticked config key. Those start sentences here,
  // so they end the previous one — without this the blurb runs on to the next
  // capital, which is how `sockets` was showing its own usage line and how
  // test:jetsam's ran to 327 characters.
  const para = lines.join(' ').replace(/\s+/g, ' ');
  const OPENS = /[A-Z(`]|(?:tools|path|server|design|rive|dist)\/|npm |node /;
  const m = new RegExp(`^(.+?[.?!])(\\s+(?:${OPENS.source})|$)`).exec(para);
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
  // THE GAME'S MODES — the same page under a URL flag, one card each, so the
  // flags are pinned somewhere findable rather than remembered. Every flag is
  // read once at boot in path/src/main.js; the hub fills in the live port.
  { file: 'index.html', on: 'dev', path: '/', title: 'Versus — two seals, one ball',
    blurb: 'The ball game, under Seal sports on the main menu (it was a ?versus flag): goals in both walls, first to five. Two pads, or one pad as player 2 with the keyboard as player 1; no pad on player 2 and the bot plays it. Tune the ball in the ball lab (looks:ball).' },
  { file: 'index.html', on: 'dev', path: '/?tune', title: 'The game, with the tuner',
    blurb: 'The same run with the dev panels forced on — for a deployed or preview build, where they are otherwise hidden.' },
  { file: 'index.html', on: 'dev', path: '/?title', title: 'The title shot',
    blurb: 'Boots straight into the splash framing so the title seal can be looked at. See CONFIG.titleSeal.' },
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
  { file: 'tip-look.html', on: 'dev', path: '/tip-look.html', title: 'Upgrade tips',
    blurb: 'Every shape an upgrade tip comes in, on one sheet — built by the real ui/upgradeTip.js under jsdom, so the names, the descs and every measured number are the game\'s. Only the run ledger is synthetic. Regenerate with `npm run look:tips`.' },
  { file: 'perf-probe.html', on: 'dev', path: '/perf-probe.html', title: 'Perf probe',
    blurb: 'Frame cost of one system at a time, isolated from a real run.' },
  { file: 'rive-test.html', on: 'dev', path: '/rive-test.html', title: 'Rive splash harness',
    blurb: 'Drives seal_survivor.riv outside the game — artboards, state machines, data binding.' },
  // Generated (3.2MB) and gitignored, so it is absent on a fresh clone until
  // this script writes it. Naming the script is what tells hub-test that.
  { file: 'hive-stacks.html', on: 'dev', path: '/hive-stacks.html', title: 'Hex hive', script: 'look:stacks',
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
