// ============================================================================
// THE DESKTOP BUILD — the web build, minus Spline, into dist-desktop/.
//
// Everything else is inherited from vite.config.js so the two builds cannot
// drift: the same __BUILD_ID__/__BUILD_NUMBER__ defines, the same handling of
// public/, the same everything. Only what has to differ differs.
//
// ---------------------------------------------------------------------------
// WHY THE SPLINE SCREEN IS REMOVED AT THE IMPORT GRAPH
//
// ui/splineSplash.js fetches the Spline runtime from unpkg and the scene from
// prod.spline.design, at the moment the splash mounts. On the deployed site
// that is a slow title screen. In a downloaded game it is a blank rectangle,
// and a Steam player is offline often enough — on a plane, on a Deck in the
// garden, behind a captive portal — that "often enough" is the wrong standard.
//
// Aliasing the two modules out, rather than branching inside them, is what
// makes this checkable. A branch would leave the Spline module in the bundle
// with its CDN URL intact and merely unreachable, which is a thing somebody has
// to keep re-verifying. Cutting the edge in the import graph means Rollup drops
// the module, and `npm run desktop:test` can assert the string is simply not
// there.
//
// It also leaves path/src completely untouched, so the web build's audition
// (`?splash=spline`) keeps working exactly as it does today.
// ---------------------------------------------------------------------------
//
// SEPARATE OUTPUT DIRECTORY, not a rebuild over dist/. The two builds differ,
// `npm run deploy` publishes dist/ without asking what made it, and a desktop
// build left sitting in dist/ is a web deploy with a stubbed splash in it.
// ============================================================================

import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from './vite.config.js';

const HERE = import.meta.dirname;
const STUBS = resolve(HERE, 'electron/stubs');

export default defineConfig((env) => mergeConfig(
  // vite.config.js exports the function form so it can see `command`.
  typeof base === 'function' ? base(env) : base,
  {
    build: {
      outDir: 'dist-desktop',
      emptyOutDir: true,
    },
    resolve: {
      // Matched on the SPECIFIER, not on a resolved path: ui.js imports
      // './splashChoice.js', so an alias keyed on the absolute path would never
      // be tested against it.
      //
      // THE `^.*` IS LOAD-BEARING. A regex `find` is applied with
      // String.replace, so it substitutes only the part it MATCHED — anchoring
      // on just the slash (/\/splashChoice\.js$/) leaves the leading '.' in
      // place and produces './Users/…/splashChoice.js', a relative path into a
      // directory that does not exist. Matching the whole specifier is what
      // makes the replacement a replacement.
      //
      // Both are aliased even though stubbing the chooser alone makes the
      // Spline screen unreachable: ui.js imports mountSplineSplash STATICALLY,
      // so without the second alias the real module stays in the graph and its
      // CDN URL ships anyway.
      alias: [
        { find: /^.*\/splashChoice\.js$/, replacement: resolve(STUBS, 'splashChoice.js') },
        { find: /^.*\/splineSplash\.js$/, replacement: resolve(STUBS, 'splineSplash.js') },
      ],
    },
  },
));
