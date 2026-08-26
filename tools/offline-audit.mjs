#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run audit:offline
//
// EVERY HOST THE GAME REACHES FOR AT RUNTIME — and whether it can survive not
// reaching it.
//
// This exists for the desktop build. A player on Steam is frequently offline —
// on a plane, on a Deck in the garden, behind a captive portal — and Valve's
// reviewer will launch the build disconnected at least once. On the deployed
// web site a missing CDN is a slow page; in a downloaded game it is a bug
// report, and the two worst cases here fail SILENTLY:
//
//   THE FONT. ui/ui.js @imports Inter from Google Fonts, and the whole UI is
//   sized in px against Inter's metrics (roughly 1em per glyph). Offline it
//   falls through to system-ui and every px-tuned element mis-sizes — no
//   error, no warning, just a screen that is subtly wrong everywhere.
//
//   THE SPLASH — DECIDED, 2026-08-25: the desktop build has no Spline in it.
//   ui/splineSplash.js fetched the runtime from unpkg and the scene from
//   prod.spline.design at mount time, which offline is a blank title screen.
//   vite.desktop.config.js aliases that module and its chooser out of the
//   import graph, so the desktop build ships the Rive card only and there is
//   nothing left to vendor. The WEB build keeps the audition unchanged.
//
// NOT NAMED `test:offline` ON PURPOSE. tools/ship.mjs builds its gate list
// from every `test:*` script in package.json, so that name would block the web
// deploy today — and the web build is entitled to use a CDN. Promote it once
// the hosts below are vendored and the desktop build is the one shipping.
//
//   node tools/offline-audit.mjs [--dist]
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'path/src');
const DIST = join(ROOT, 'dist');
const DESKTOP = join(ROOT, 'dist-desktop');

// Files worth reading. A .glb or an .mp3 can contain a byte sequence that looks
// like a URL and never is one.
const EXTS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.csv']);

// ---------------------------------------------------------------------------
// WHY path/src GATES AND dist ONLY REPORTS.
//
// A host alone cannot tell you whether it is fetched. `unpkg.com` is the proof:
// it appears twice in the built bundle, and the two are opposites.
//
//   ui/splineSplash.js  fetches the Spline runtime from it, for real, at the
//                       moment the splash mounts. Offline, that screen is blank.
//   @rive-app/canvas    carries it as a DEFAULT that ui/riveRuntime.js
//                       overrides with a bundled ?url before any Rive instance
//                       is constructed. The string ships; the request never
//                       happens.
//
// Minified into one line, those are indistinguishable by host. So the gate is
// our own source, where a vendored library's metadata never appears and every
// hit is something this codebase actually wrote. dist is scanned too, but as an
// INVENTORY — it is how a new CDN dependency gets noticed at all, and it is
// triaged by hand into VERIFIED below rather than by pattern.
// ---------------------------------------------------------------------------

// Hosts that may appear in path/src. Anything else there fails, which is the
// right default: a new CDN dependency should have to be argued for rather than
// merely not noticed.
const ALLOWED = [
  {
    host: 'www.w3.org',
    why: 'the SVG namespace, passed to createElementNS — an identifier, never a request',
  },
  {
    host: 'ko-fi.com',
    why: 'ui/tipJar.js opens it in the system browser on a click; the desktop shell routes it through shell.openExternal',
  },
  {
    host: 'seal-survivor.pages.dev',
    why: 'share text in systems/bossShot.js — a string handed to the OS, not a request',
    note: 'should become the Steam store URL in a Steam build',
  },
  {
    host: 'localhost',
    why: 'the generation recipe in the header comment of ui/upgradeIcons.js — documentation, not code',
  },
];

// Hosts found in dist and triaged BY HAND. Each line is a claim somebody
// checked; re-check it if the dependency is upgraded.
const VERIFIED = [
  {
    host: 'unpkg.com',
    why: "Rive's default WASM URL, overridden by ui/riveRuntime.js before any instance is built",
    caveat: 'ALSO the real Spline runtime fetch — caught in the path/src scan above',
  },
  {
    host: 'cdn.jsdelivr.net',
    why: "Rive's fallback WASM URL, unreachable for the same reason",
  },
  {
    host: 'prod.spline.design',
    why: 'CONFIG.splineSplash.src in config.js (and the same value saved in imported-tuning.json) — inert data in dist-desktop, where the runtime that would fetch it has been aliased out of the graph',
    caveat: 'in plain dist/ this IS fetched, by the web build\'s audition splash. `npm run desktop:test` is what proves the desktop bundle has no Spline runtime',
  },
  {
    host: 'rive.app',
    why: "@rive-app/canvas inlines its own package.json; this is the `homepage` field",
  },
  {
    host: 'github.com',
    why: 'the `repository` field of the same inlined package.json, plus a license header',
  },
  {
    host: '101arrowz.github.io',
    why: "fflate's license header",
  },
  {
    host: 'jcgt.org',
    why: 'a paper citation in a three.js shader comment',
  },
  {
    host: 'capacitorjs.com',
    why: 'a docs link in a Capacitor error message; the plugin chunk is never loaded on desktop',
  },
  {
    host: 'seal-survivor-playtest.ethan-goldhammer.workers.dev',
    why: 'VITE_PLAYTEST_URL. Fetched, but systems/playtest.js writes localStorage first and treats the POST as best-effort',
    caveat: 'decide whether a Steam build phones home at all — it needs a store-page disclosure if so',
  },
  {
    host: 'seal-survivor-leaderboard.ethan-goldhammer.workers.dev',
    why: 'VITE_LEADERBOARD_URL. Fetched, but aborts at 6s and falls through to the local board',
  },
];

// The detector. Deliberately greedy about what counts as a URL: a false
// positive costs a line in the allowlist, a false negative costs a shipped
// dependency nobody knew about.
const URL_RE = /https?:\/\/([A-Za-z0-9.-]+)/g;

// ---------------------------------------------------------------------------
// THE DETECTOR IS TESTED FIRST, the same way tools/copy-check.mjs tests its
// own. A regex that quietly stopped matching would turn this whole audit into
// a green light that means nothing, and it would do that on the day somebody
// reformatted a file rather than on the day they broke something.
// ---------------------------------------------------------------------------
function selfTest() {
  const fixtures = [
    ["@import url('https://fonts.googleapis.com/css2?family=Inter');", 'fonts.googleapis.com'],
    ["const R = 'https://unpkg.com/@splinetool/runtime@2.0.5/build/runtime.js';", 'unpkg.com'],
    ['src: "http://example.com/a.png"', 'example.com'],
    ['const ns = "http://www.w3.org/2000/svg";', 'www.w3.org'],
  ];
  const bad = [];
  for (const [text, expected] of fixtures) {
    URL_RE.lastIndex = 0;
    const found = [...text.matchAll(URL_RE)].map((m) => m[1]);
    if (!found.includes(expected)) bad.push(`${expected} not found in: ${text}`);
  }
  // And that it does NOT match something with no URL in it, so a regex that
  // degenerated into matching everything fails here too.
  URL_RE.lastIndex = 0;
  if ([...'a plain sentence about https and http'.matchAll(URL_RE)].length) {
    bad.push('matched a string containing no URL');
  }
  return bad;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (EXTS.has(extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

async function scan(dir, label) {
  const hits = new Map(); // host -> [{ file, line }]
  for await (const file of walk(dir)) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      URL_RE.lastIndex = 0;
      for (const m of lines[i].matchAll(URL_RE)) {
        const host = m[1];
        if (!hits.has(host)) hits.set(host, []);
        const list = hits.get(host);
        // One example per file is enough to find it; the count is what matters.
        if (list.length < 200) list.push({ file: relative(ROOT, file), line: i + 1 });
      }
    }
  }
  return { label, dir, hits };
}

// ---------------------------------------------------------------------------

const wantDist = process.argv.includes('--dist');

console.log('\nOFFLINE AUDIT — hosts reachable from the shipped game\n');

// ---------------------------------------------------------------------------
// IS THE SPLINE SPLASH SWITCHED ON? Read out of the code, not stored here.
//
// ui/splashChoice.js has a SPLINE_ENABLED constant, and while it is false
// nothing can mount ui/splineSplash.js — so its unpkg fetch and the scene URL
// in CONFIG.splineSplash are unreachable rather than merely unused. Reporting
// them as failures then would train the habit of ignoring this gate.
//
// DERIVED, so it cannot go stale: flip the constant back to true and the two
// hosts start failing again on the next run, with no list here to remember to
// update. Same reasoning as the lorem flag in CLAUDE.md — the flag IS the code.
//
// AND IT FAILS TOWARDS NOISE. If this regex ever stops matching (the constant
// is renamed, moved, computed), `enabled` stays true and the hosts are reported
// as live. A detector that breaks into a louder gate is one you find out about;
// one that breaks into a quieter gate is one that silently stops working.
// ---------------------------------------------------------------------------
async function splineEnabled() {
  try {
    const text = await readFile(join(SRC, 'ui/splashChoice.js'), 'utf8');
    return !/\bSPLINE_ENABLED\s*=\s*false\b/.test(text);
  } catch {
    return true;
  }
}

const SPLINE_ON = await splineEnabled();

// Hosts that are only reachable through the Spline splash. Live when the switch
// is on, inert when it is off.
const SPLINE_HOSTS = {
  'unpkg.com': 'ui/splineSplash.js fetches the Spline runtime from it at mount time',
  'prod.spline.design': 'CONFIG.splineSplash.src — the scene the splash loads',
};

const detectorFaults = selfTest();
console.log('detector');
if (detectorFaults.length) {
  for (const f of detectorFaults) console.log(`  FAIL ${f}`);
  console.log('\nThe URL detector is broken, so nothing below can be trusted.\n');
  process.exit(1);
}
console.log('  ok   matches CDN, namespace and plain-http forms, and nothing else\n');

const targets = [{ dir: SRC, label: 'path/src', gates: true }];
for (const [dir, name] of [[DIST, 'dist'], [DESKTOP, 'dist-desktop']]) {
  if (!existsSync(dir)) {
    if (wantDist) console.log(`  note ${name}/ does not exist\n`);
    continue;
  }
  const info = await stat(dir);
  const built = info.mtime.toISOString().slice(0, 16).replace('T', ' ');
  targets.push({ dir, label: `${name} (built ${built})`, gates: false });
}

let failures = 0;
let unreviewed = 0;

for (const { dir, label, gates } of targets) {
  const { hits } = await scan(dir, label);
  console.log(`${label}${gates ? '' : '   (inventory — does not gate)'}`);
  if (!hits.size) {
    console.log('  ok   no remote hosts\n');
    continue;
  }
  const sorted = [...hits.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [host, list] of sorted) {
    const where = list.slice(0, 3).map((h) => `${h.file}:${h.line}`).join(', ');
    const more = list.length > 3 ? ` +${list.length - 3} more` : '';

    // Unreachable while the Spline switch is off — see splineEnabled above.
    if (!SPLINE_ON && SPLINE_HOSTS[host]) {
      console.log(`  ok   ${host} — ${SPLINE_HOSTS[host]}, and the Spline splash is switched off`);
      console.log('       ui/splashChoice.js: SPLINE_ENABLED = false — flip it and this fails again');
      continue;
    }

    const allowed = ALLOWED.find((a) => a.host === host);
    if (allowed) {
      console.log(`  ok   ${host} — ${allowed.why}`);
      if (allowed.note) console.log(`       note: ${allowed.note}`);
      continue;
    }

    // dist only: a host somebody has already looked at and explained.
    const verified = !gates && VERIFIED.find((v) => v.host === host);
    if (verified) {
      console.log(`  ok   ${host} — ${verified.why}`);
      if (verified.caveat) console.log(`       caveat: ${verified.caveat}`);
      continue;
    }

    if (gates) {
      failures++;
      console.log(`  FAIL ${host} — ${list.length} reference${list.length === 1 ? '' : 's'}`);
    } else {
      unreviewed++;
      console.log(`  ??   ${host} — ${list.length} reference${list.length === 1 ? '' : 's'}, never triaged`);
    }
    console.log(`       ${where}${more}`);
  }
  console.log('');
}

if (unreviewed) {
  console.log(
    `${unreviewed} host${unreviewed === 1 ? '' : 's'} in the bundle nobody has looked at.\n`
    + 'Most will be a license header or an inlined package.json. Check what each one\n'
    + 'actually does and add it to VERIFIED with the reason, so the next new one\n'
    + 'stands out instead of joining a list nobody reads.\n',
  );
}

if (failures) {
  console.log(
    `${failures} host${failures === 1 ? '' : 's'} in path/src would be fetched at runtime.\n`
    + 'Each one is a screen that is wrong, or blank, for a player with no network.\n'
    + 'Vendor it, or make the code fall back deliberately, then add it to ALLOWED\n'
    + 'with the reason it is safe.\n',
  );
  process.exit(1);
}

console.log('Nothing in path/src reaches for a host it cannot do without.\n');
