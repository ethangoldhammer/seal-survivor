#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:reexport
//
// A RE-EXPORT IS NOT AN IMPORT, and the difference is a game that throws on
// every frame while the build is clean and the whole suite is green.
//
// `export { x } from './y.js'` forwards the name to this module's CONSUMERS
// and creates no local binding. So a file that moves a helper into a leaf,
// re-exports it so its own importers do not have to change, and goes on
// calling it internally has just replaced ten working calls with ten
// ReferenceErrors — and nothing catches it:
//
//   node --check    parses; an undefined identifier is a RUNTIME error.
//   the bundler     resolves the re-export happily; it is valid ESM.
//   the harnesses   none of them runs a UI file's per-frame path.
//
// It cost a session: ui/ui.js moved worldToScreen into ui/project.js, kept
// `export { worldToScreen, projectToScreen } from './project.js'`, and the
// game threw `projectToScreen is not defined` from the first frame onward —
// which reads as a frozen picture with the audio and the toasts still running,
// because everything in the frame AFTER the throw simply stops.
//
// So: every re-exported name, checked against whether the file also CALLS it.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const ROOT = new URL('../path/src/', import.meta.url).pathname;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// `export { a, b as c } from './x.js'` — the FORWARDING form. A plain
// `export { a }` is a local binding and is exactly what we want people to use.
const FORWARD = /export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;

/**
 * Strip what a call cannot be inside — comments and strings — so a name that
 * only appears in prose does not read as a use. The banners in this codebase
 * are long and name their functions constantly; without this every file with a
 * good comment would be a false positive.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

const offenders = [];
let forwarded = 0;
let scanned = 0;

for (const file of files(ROOT)) {
  const src = readFileSync(file, 'utf8');
  if (!/export\s*\{[^}]*\}\s*from/.test(src)) continue;
  scanned++;
  const body = code(src);
  for (const m of src.matchAll(FORWARD)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim();
      if (!spec) continue;
      // `a as b` exposes b and forwards a; the LOCAL name is neither, so what
      // matters is whether either spelling is called in this file.
      const [from, to] = spec.split(/\s+as\s+/).map((x) => x.trim());
      for (const name of new Set([from, to].filter(Boolean))) {
        if (name === 'default' || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        forwarded++;
        // A CALL, not a mention: the name followed by an open paren.
        const used = new RegExp(`\\b${name}\\s*\\(`).test(body);
        // ...unless the file also imports it properly, which is the fix.
        const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(body);
        if (used && !imported) offenders.push(`${file.replace(ROOT, '')}: ${name}`);
      }
    }
  }
}

console.log('\nA re-export forwards a name; it does not bring it into scope');
console.log(`  (${forwarded} forwarded name(s) across ${scanned} file(s))`);
check('nothing calls a name it only re-exports', offenders.length === 0,
  offenders.length ? offenders.join('; ') + ' — import it as well as re-exporting it' : '');

// THE CHECK CHECKS ITSELF. A scanner whose pattern has quietly stopped matching
// is a green light that means nothing, so it is run once against the exact
// shape of the bug it exists for.
{
  // The forwarding pattern is matched against the RAW source and the use
  // against the stripped copy — the same two inputs the scan above uses, and
  // the reason they are two: code() removes the string literal that FORWARD
  // needs, so running both over one of them silently matches nothing.
  const raw = `
    export { worldToScreen, projectToScreen } from './project.js';
    function f(camera) { return projectToScreen(camera, V, out); }
  `;
  const body = code(raw);
  const caught = [];
  for (const m of raw.matchAll(FORWARD)) {
    for (const part of m[1].split(',')) {
      const name = part.trim();
      if (!name) continue;
      const used = new RegExp(`\\b${name}\\s*\\(`).test(body);
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(body);
      if (used && !imported) caught.push(name);
    }
  }
  check('...and the scanner still recognises the bug it was written for',
    caught.length === 1 && caught[0] === 'projectToScreen', caught.join(' ') || 'nothing caught');
  // ...AND CLEARS THE FIXED SHAPE, run through the same two steps rather than
  // asserted about. A check that only ever sees the broken sample cannot tell
  // you it would leave a correct file alone, which is the half that decides
  // whether this is a guard or a nuisance.
  const fixedRaw = `
    import { worldToScreen, projectToScreen } from './project.js';
    export { worldToScreen, projectToScreen };
    function f(camera) { return projectToScreen(camera, V, out); }
  `;
  const fixedBody = code(fixedRaw);
  const flagged = [];
  for (const m of fixedRaw.matchAll(FORWARD)) {
    for (const part of m[1].split(',')) {
      const name = part.trim();
      if (!name) continue;
      const used = new RegExp(`\\b${name}\\s*\\(`).test(fixedBody);
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(fixedBody);
      if (used && !imported) flagged.push(name);
    }
  }
  check('...and leaves the fixed shape alone', flagged.length === 0, flagged.join(' '));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
