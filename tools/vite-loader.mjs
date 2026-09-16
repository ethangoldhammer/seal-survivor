// ---------------------------------------------------------------------------
// A Node module loader that understands the two Vite-isms config.js uses, so
// the config can be imported from a terminal script instead of a browser.
//
//   import importedTuning from './imported-tuning.json';   ← no import attribute
//   import upgradesCsv from './upgrades.csv?raw';          ← ?raw suffix
//   import rivUrl from './blubberball.riv?url';            ← ?url suffix
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
//
// IMPORT THIS BEFORE A HARNESS REGISTERS HOOKS OF ITS OWN.
//
// registerHooks runs NEWEST FIRST — the last hook registered sees a specifier
// before the older ones do — and the resolve hook below claims every `?raw`
// and `?url` import outright, resolving it to the real file on disk and
// short-circuiting. So a harness that registers its own stubs and *then*
// imports this file has its `?raw`/`?url` stubs silently swallowed: the module
// under test gets a real path where the harness meant to hand it a fake one.
//
// It fails quietly, which is the whole problem. tools/rive-boss-test.mjs stubs
// '@rive-app/canvas/rive.wasm?url' and asserts the runtime was pointed at it;
// with the order wrong the assertion read back an absolute node_modules path,
// and every other harness in the same shape went on passing only because none
// of them asserted on the stubbed value. Thirty-two of them were like that.
//
// Plain specifiers are unaffected either way — a stub for '@rive-app/canvas'
// wins from either side, because this file passes anything without a Vite
// suffix straight through to `next`. It is only the suffixed ones that clash.
// ---------------------------------------------------------------------------

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = '?raw';
// `?url` is how a module asks the bundler for an ASSET'S PATH rather than its
// contents — the .riv files in ui/ are imported that way. Node cannot load a
// .riv at all, so without this any harness that touches ui/statsCard.js dies
// on ERR_UNKNOWN_FILE_EXTENSION before a line of it runs. The string handed
// back is the file's own path, which is what Vite hands back too and is enough
// for a test that never actually fetches it.
const URL_SUFFIX = '?url';
const SUFFIXES = [RAW, URL_SUFFIX];

/** The Vite suffix on this specifier, or '' for a plain one. */
function suffixOf(s) {
  return SUFFIXES.find((x) => s.endsWith(x)) ?? '';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const suffix = suffixOf(specifier);
    if (!suffix) return nextResolve(specifier, context);
    // Resolve the real path with the suffix off, then put it back so `load`
    // below can still tell what this import wanted.
    const resolved = nextResolve(specifier.slice(0, -suffix.length), context);
    return { ...resolved, url: resolved.url + suffix, format: 'module', shortCircuit: true };
  },

  load(url, context, nextLoad) {
    if (url.endsWith(RAW)) {
      const text = readFileSync(fileURLToPath(url.slice(0, -RAW.length)), 'utf8');
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
    }

    // The asset's PATH, not its bytes. Nothing is read: a missing file should
    // fail where it is fetched, the way it does in the browser, rather than
    // taking down the import.
    if (url.endsWith(URL_SUFFIX)) {
      const path = fileURLToPath(url.slice(0, -URL_SUFFIX.length));
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(path)};` };
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
