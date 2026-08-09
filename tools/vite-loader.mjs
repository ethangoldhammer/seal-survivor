// ---------------------------------------------------------------------------
// A Node module loader that understands the two Vite-isms config.js uses, so
// the config can be imported from a terminal script instead of a browser.
//
//   import importedTuning from './imported-tuning.json';   ← no import attribute
//   import upgradesCsv from './upgrades.csv?raw';          ← ?raw suffix
//
// Node needs `with { type: 'json' }` on the first and has no idea what to do
// with the second, so both throw before a single line of config runs. Rather
// than change config.js to suit a test — the browser is the real target, and
// the bundler is the real environment — the test brings its own resolver.
//
// Register it with:  node --import ./tools/vite-loader.mjs your-script.mjs
//
// These are `registerHooks` (synchronous, same thread), not the older
// `register()` + worker-thread hooks. The async form has to name a SEPARATE
// module to load off-thread; pointing it at this file made the process exit 0
// having silently never run the entry script at all.
// ---------------------------------------------------------------------------

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = '?raw';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(RAW)) return nextResolve(specifier, context);
    // Resolve the real path with the suffix off, then put it back so `load`
    // below can still tell this import wanted the file's text.
    const resolved = nextResolve(specifier.slice(0, -RAW.length), context);
    return { ...resolved, url: resolved.url + RAW, format: 'module', shortCircuit: true };
  },

  load(url, context, nextLoad) {
    if (url.endsWith(RAW)) {
      const text = readFileSync(fileURLToPath(url.slice(0, -RAW.length)), 'utf8');
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
    }

    // JSON without an import attribute. Emitted as a module rather than
    // format:'json' so Node doesn't re-check for the attribute it was never
    // given. Parsed and re-serialised so a malformed tuning file fails here,
    // naming itself, instead of as a syntax error in a generated module.
    if (url.endsWith('.json')) {
      const path = fileURLToPath(url);
      const text = readFileSync(path, 'utf8');
      try {
        return {
          format: 'module',
          shortCircuit: true,
          source: `export default ${JSON.stringify(JSON.parse(text))};`,
        };
      } catch (err) {
        throw new Error(`${path} is not valid JSON: ${err.message}`);
      }
    }

    return nextLoad(url, context);
  },
});
