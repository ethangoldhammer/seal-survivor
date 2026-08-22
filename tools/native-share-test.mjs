// ---------------------------------------------------------------------------
// THE NATIVE SHARE ROUTE — `npm run test:nativeshare`.
//
// systems/nativeShare.js is the iOS build's way of handing a kill shot to the
// OS, and it exists because the web one cannot be trusted inside a WKWebView.
// The thing it replaced failed SILENTLY on a phone — an a[download] on a data:
// URL that iOS ignores, with the button reporting "saved" over a file that
// never arrived — so the checks here are mostly about the ways this one could
// do the same.
//
// WHAT A STUB CAN AND CANNOT SAY. It cannot tell you the iOS share sheet opens;
// only a device can. What it CAN tell you is that the bridge is handed
// something valid and that every answer it can give is turned into the right
// outcome — which is exactly where the last silent failure lived.
// ---------------------------------------------------------------------------

import { registerHooks } from 'node:module';

// The recorder the stubbed plugins write into. On a global because the stub
// modules below are generated source strings and cannot close over anything.
const bridge = {
  writes: [],
  shares: [],
  writeResult: () => ({ uri: 'file:///Library/Caches/shot.png' }),
  shareResult: () => undefined,
};
globalThis.__bridge = bridge;

// @capacitor/* is a real dependency, and importing the real thing here would
// load the WEB implementation — Filesystem-on-web is IndexedDB, which Node does
// not have, so every case would fail for a reason that has nothing to do with
// the code under test. Same trick as tools/vite-loader.mjs, pointed at the
// bridge instead of at Vite's import suffixes.
const STUBS = {
  '@capacitor/share': `
    export const Share = { share: (o) => { globalThis.__bridge.shares.push(o); return Promise.resolve(globalThis.__bridge.shareResult()); } };
  `,
  '@capacitor/filesystem': `
    export const Directory = { Cache: 'CACHE', Documents: 'DOCUMENTS' };
    export const Filesystem = { writeFile: (o) => { globalThis.__bridge.writes.push(o); return Promise.resolve(globalThis.__bridge.writeResult()); } };
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) return { url: `stub:${specifier}`, format: 'module', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('stub:')) {
      return { format: 'module', shortCircuit: true, source: STUBS[url.slice('stub:'.length)] };
    }
    return nextLoad(url, context);
  },
});

// FileReader is a browser API and Node has never had it, so nativeShare's
// base64 hop needs one here. Written to produce a REAL data URL rather than a
// canned string: the prefix is what the split under test has to get past, and a
// stub that returned bare base64 would pass a function that never split at all.
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buf) => {
      const b64 = Buffer.from(buf).toString('base64');
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
      this.onload?.();
    });
  }
};

let native = true;
globalThis.window = { Capacitor: { isNativePlatform: () => native } };

const { nativeShareAvailable, nativeShareImage } = await import('../path/src/systems/nativeShare.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const blob = () => new Blob([PNG], { type: 'image/png' });

console.log('\nA BROWSER IS LEFT ALONE');
native = false;
check('no bridge, no claim to have shared', await nativeShareImage(blob(), 'a.png', 't', 'x') === null);
check('...and it does not touch the filesystem', bridge.writes.length === 0);
native = true;

console.log('\nTHE PICTURE REACHES THE SHEET');
bridge.writes = [];
bridge.shares = [];
const out = await nativeShareImage(blob(), 'kill.png', 'Seal Survivor', 'a boss died');
check('it reports the sheet was dealt with', out === 'shared', String(out));
check('one file written', bridge.writes.length === 1);
const w = bridge.writes[0] ?? {};
check('...named as asked', w.path === 'kill.png', w.path);
check('...into the cache, not the user\'s documents', w.directory === 'CACHE', w.directory);
// The bug this is really for: readAsDataURL hands back "data:image/png;base64,AAA"
// and the plugin wants only the payload. Shipping the whole thing writes a file
// that is valid base64 and is not a PNG — it opens as garbage, or not at all.
check('...as base64 with the data: prefix stripped', w.data === Buffer.from(PNG).toString('base64'), String(w.data).slice(0, 24));
check('the sheet was handed the file that was written', bridge.shares[0]?.files?.[0] === 'file:///Library/Caches/shot.png');
check('...with the title and text', bridge.shares[0]?.title === 'Seal Survivor' && bridge.shares[0]?.text === 'a boss died');

console.log('\nCLOSING THE SHEET IS NOT A FAILURE');
// The plugin rejects on dismissal rather than resolving, and a caller that read
// that as "the native route did not work" would fall through and hand the
// player a download they did not ask for — which is precisely what the web
// path's AbortError check exists to stop.
bridge.shareResult = () => { throw new Error('Share canceled'); };
check('a dismissed sheet says so', await nativeShareImage(blob(), 'k.png', 't', 'x') === 'cancelled');

console.log('\nA REAL FAILURE FALLS THROUGH');
bridge.shareResult = () => { throw new Error('bridge exploded'); };
check('a broken bridge returns null so the web route still runs',
  await nativeShareImage(blob(), 'k.png', 't', 'x') === null);
bridge.shareResult = () => undefined;

console.log('\nNOTHING TO SHARE');
bridge.writes = [];
check('a null blob never reaches the bridge', await nativeShareImage(null, 'k.png', 't', 'x') === null);
check('...and writes nothing', bridge.writes.length === 0);

console.log(failures ? `\nFAILED — ${failures} check(s)\n` : '\nPASS — all checks\n');
process.exit(failures ? 1 : 0);
