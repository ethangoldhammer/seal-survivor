// ============================================================================
// BUILD THE NAME KIT — bundle the game's real name machinery into one file a
// page with no build step can run.
//
//   npm run spline:kit
//
// The output is an IIFE that hangs everything off `window.SealNames`, written
// to tools/spline/name-kit.bundle.js. That file is then pasted into the Spline
// scene's HTML content (Spline runs it in a sandboxed iframe: no modules, no
// bundler, no way to fetch a CSV).
//
// RUN IT AGAIN WHENEVER sealNames.csv, epitaphs.csv OR ANY OF THE NAME MODULES
// CHANGES. The scene does not read the game's files — it carries a copy, and a
// copy that is not rebuilt is the fork this whole path exists to avoid. The
// bundle prints its own row counts on build so a stale one is visible in the
// diff rather than only on the screen.
//
// WHY esbuild AND NOT vite. This is a library bundle with no HTML, no dev
// server and no asset pipeline, and vite's build wants a page. esbuild is
// already in the tree as vite's own dependency, so this adds nothing.
//
// THE `?raw` PLUGIN is the same shim tools/vite-loader.mjs provides for Node —
// vite turns `import csv from './x.csv?raw'` into the file's text, and nothing
// outside vite knows that. Without it esbuild resolves the query string as part
// of the filename and fails on a path that looks correct.
// ============================================================================

import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ENTRY = path.join(HERE, 'spline', 'name-kit.entry.js');
const OUT = path.join(HERE, 'spline', 'name-kit.bundle.js');

// A SECOND COPY, under public/, so the bundle ships with the site.
//
// The Spline scene INLINES this file today, which makes the scene self
// contained — it works offline, and it survives being exported. The cost is
// that every change to sealNames.csv needs the bundle repasted by hand, and
// that table is edited often enough for "the scene is four names behind" to be
// the normal state rather than an exception.
//
// So it is also published. A scene that loads
// `<script src="https://<the site>/spline/name-kit.js">` instead of carrying
// the code refreshes itself on the next deploy and never needs repasting. The
// trade is that it then depends on the network and on the sandbox allowing a
// cross-origin script, which is why the inline copy is the default rather than
// this one.
const PUBLIC = path.join(ROOT, 'public', 'spline', 'name-kit.js');

/** vite's `?raw` suffix, for a bundler that has never heard of it. */
const rawPlugin = {
  name: 'vite-raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
      contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife',
  // Everything the entry exports lands on this one global. One name on the
  // page rather than twenty, and the same name the panel code reads.
  globalName: 'SealNames',
  // Spline's iframe is a current browser and nothing here is old. Kept
  // explicit so a future change of target is a decision rather than a default.
  target: 'es2020',
  // WHITESPACE AND SYNTAX, BUT NOT IDENTIFIERS — and that is a workflow
  // decision, not a size one.
  //
  // Full minification remangles every name in the file whenever a scope is
  // added anywhere in it: one new `for` loop in parseSealNameCsv renamed
  // variables from one end of the bundle to the other. Since the Spline scene
  // carries this code as pasted text, that turns every change — however small —
  // into a 20KB retype of the whole thing, which is both expensive and the only
  // real chance of corrupting it.
  //
  // Keeping identifiers means a change to one function shows up as a change to
  // one function, and the scene can be patched where it actually differs. The
  // cost is about 8KB of readable names in a document that is already 70KB, and
  // it buys back a paste that can be verified by its own byte count.
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  // No sourcemap: the bundle is pasted into a document, and a map that points
  // at files the page cannot reach is a link to nowhere in the console.
  sourcemap: false,
  legalComments: 'none',
  write: false,
  plugins: [rawPlugin],
  metafile: true,
});

const code = result.outputFiles[0].text;
const banner = [
  '/* ==========================================================================',
  ' * SEAL SURVIVOR NAME KIT — GENERATED. Do not edit this file.',
  ' *',
  ' * Built from path/src by tools/spline-name-kit.mjs. Everything hangs off',
  ' * window.SealNames. Rebuild with `npm run spline:kit` after any change to',
  ' * sealNames.csv, epitaphs.csv, or the name modules — this is a COPY, and a',
  ' * copy that is not rebuilt is a fork.',
  ' * ========================================================================== */',
  '',
].join('\n');

await writeFile(OUT, banner + code, 'utf8');
await mkdir(path.dirname(PUBLIC), { recursive: true });
await writeFile(PUBLIC, banner + code, 'utf8');

// What went in, so a stale bundle is obvious in the diff.
//
// Through the table's OWN PARSER, not by counting lines: rows sharing an id
// collapse, disabled rows do not count, and a quoted note can contain a comma.
// The number printed here has to be the number of parts the scene will actually
// roll from, or it is decoration.
const { parseSealNameCsv } = await import(new URL('../path/src/sealNameTable.js', import.meta.url));
const csv = await readFile(path.join(ROOT, 'path/src/sealNames.csv'), 'utf8');
const parts = parseSealNameCsv(csv, () => {});
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

console.log(`[spline:kit] ${path.relative(ROOT, OUT)} — ${kb(banner.length + code.length)} minified`);
console.log(`[spline:kit] table: ${parts.adjective.length} adjectives x ${parts.nickname.length} nicknames + ${parts.full.length} written`);
console.log(`[spline:kit] ${path.relative(ROOT, PUBLIC)} — same bytes, ships with the site`);
console.log('[spline:kit] repaste the bundle into the Spline scene\'s HTML content — it carries its own copy.');
