// ============================================================================
// BUILDING FOR itch.io.
//
// The difference from `npm run build` is one flag — `--base=./` — and the
// reason is in path/src/assetPath.js: itch serves an uploaded HTML5 build from
// a per-project subdirectory (html-classic.itch.zone/html/<id>/), so every
// root-absolute URL in the build points at the wrong host root.
//
// THE GATE IS THE POINT OF THIS FILE. A rebased build fails SILENTLY and
// plausibly: a model that 404s leaves a hole, a sample that 404s falls back to
// the synth, and the page still boots and plays. So after building, this walks
// the output and fails on any root-absolute reference in a file that
// assetUrl can never reach — the HTML, the CSS, the generated font sheet. Those
// are resolved by the browser before a line of our code runs.
//
// It cannot check the 243 absolute paths inside the JS: those are rewritten at
// load time on purpose and are SUPPOSED to still read '/models/...' in the
// bundle. What it checks instead is that the rewrite shipped at all.
//
//   node tools/itch.mjs              build, check, zip
//   node tools/itch.mjs --push       …and push it with butler
//   node tools/itch.mjs --no-build   check and zip what is already there
// ============================================================================

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const OUT = 'dist-itch';
const ZIP = 'seal-survivor-itch.zip';
const TARGET = 'hammeredgold/seal-survivor:html5';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function run(cmd, argv, opts = {}) {
  execFileSync(cmd, argv, { stdio: 'inherit', ...opts });
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

if (!has('--no-build')) {
  rmSync(OUT, { recursive: true, force: true });
  run('npx', ['vite', 'build', '--base=./', '--outDir', OUT]);
}

if (!existsSync(OUT)) {
  console.error(`\n  ${OUT}/ does not exist — drop --no-build\n`);
  process.exit(1);
}

// public/_headers is Cloudflare Pages configuration and nothing else reads it.
// On itch it would be served as a stray text file, and the caching policy it
// describes is not ours to set there. See its own header for what is lost:
// the sample bank revalidates on every boot on a host we cannot configure.
const headers = join(OUT, '_headers');
if (existsSync(headers)) {
  rmSync(headers);
  console.log('  dropped _headers (Cloudflare-only)');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const problems = [];

// A root-absolute URL in markup or a stylesheet. The browser resolves these
// against the ORIGIN, so on itch they leave the project's subdirectory and hit
// html-classic.itch.zone/… — which is not ours and has none of our files.
const PATTERNS = [
  [/\b(?:href|src)\s*=\s*["']\/[^/"']/g, 'root-absolute href/src'],
  [/\burl\(\s*["']?\/[^/"')]/g, 'root-absolute url() in CSS'],
  [/\bimport\s+["']\/[^/"']/g, 'root-absolute static import'],
];
const CHECKED = new Set(['.html', '.css', '.webmanifest', '.json']);

for (const file of walk(OUT)) {
  if (!CHECKED.has(extname(file))) continue;
  // The bundled JS is exempt by design, but a .json data table is not: nothing
  // rewrites a path read straight out of one.
  const text = readFileSync(file, 'utf8');
  for (const [re, what] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      problems.push(`${relative(OUT, file)}: ${what} — ${m[0].trim()}`);
    }
  }
}

// And the structural half: the runtime rewrite has to be in the bundle. If a
// refactor ever drops the assetPath import, every check above still passes and
// every model still 404s.
const js = walk(OUT).filter((f) => extname(f) === '.js');
const rewrote = js.some((f) => readFileSync(f, 'utf8').includes('setURLModifier'));
if (!rewrote) {
  problems.push('no setURLModifier in the bundle — path/src/assetPath.js did not ship');
}

if (problems.length) {
  console.error(`\n  ${problems.length} thing(s) will 404 from a subdirectory:\n`);
  for (const p of problems) console.error(`    ${p}`);
  console.error('\n  see path/src/assetPath.js\n');
  process.exit(1);
}
console.log(`  checked ${js.length} js + markup/CSS — nothing root-absolute outside the JS`);

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

// index.html must be at the TOP LEVEL of the zip — itch looks for it there and
// will not go hunting one directory down.
rmSync(ZIP, { force: true });
run('zip', ['-qr', join('..', ZIP), '.'], { cwd: OUT });

function sh(cmd) { return execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim(); }
console.log(`\n  ${ZIP} — ${sh(`du -h ${ZIP} | cut -f1`)}`);

if (has('--push')) {
  // butler pushes the DIRECTORY, not the zip: it diffs against what is already
  // on the channel and uploads only the blocks that changed, which on a 100MB+
  // build is the difference between a minute and twenty.
  run('butler', ['push', OUT, TARGET]);
}
