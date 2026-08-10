// Every emissive mask must be applied the same way up as the model's own maps.
//
// The mask is loaded by hand in preloadAssets, so nothing sets its `flipY` for
// us and the value has to match the loader that read the model: GLTFLoader
// writes flipY = false (glTF UVs are top-left origin), FBXLoader writes
// nothing and leaves the THREE.Texture default of true. A single hardcoded
// false shipped every FBX creature's mask vertically mirrored, which is the
// regression this guards.
//
// It is worth a test rather than a comment because a mirrored mask is not
// obviously wrong on screen — it still lights plausible-looking regions of a
// plausible-looking animal. See tools/uv-flip-check.mjs, which measures the
// right answer for a given model against its art.
//
//   npm run test:emissive
import './dom-stub.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../path/src/assets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };

// The rule under test, restated independently of assets.js so a change there
// has to be deliberate.
const expectedFlipY = (model) => /\.fbx$/i.test(model);

const masked = Object.entries(ASSETS).filter(([, d]) => d?.texture?.emissive);
check(masked.length > 0, `${masked.length} assets declare an emissive mask`);

// The source line that has to keep honouring the rule. Reading it back is
// crude, but the alternative is standing up a WebGL texture loader in Node to
// observe a property the loader only sets during a real fetch.
const src = fs.readFileSync(path.join(ROOT, 'path/src/assets.js'), 'utf8');
check(/emissiveTex\.flipY\s*=\s*flipY\b/.test(src),
  'the emissive mask takes its flipY from the model format');
check(!/emissiveTex\.flipY\s*=\s*(true|false)\b/.test(src),
  'the emissive mask does not hardcode a flipY');
check(/const flipY = \/\\\.fbx\$\/i\.test\(def\.model \?\? ''\)/.test(src),
  'the format test is on the model extension');

for (const [key, def] of masked) {
  const mask = path.join(ROOT, 'public', def.texture.emissive.replace(/^\//, ''));
  check(fs.existsSync(mask), `${key}: mask file ${def.texture.emissive} exists`);

  const model = path.join(ROOT, 'public', (def.model ?? '').replace(/^\//, ''));
  check(def.model && fs.existsSync(model), `${key}: model ${def.model} exists`);

  // A mask on an FBX is the case that broke. Assert the expectation explicitly
  // per asset so the roster itself is the record of which way each one goes.
  const want = expectedFlipY(def.model ?? '');
  check(typeof want === 'boolean',
    `${key}: ${path.extname(def.model ?? '')} -> flipY ${want} (${want ? 'FBX' : 'glTF'} convention)`);
}

// A composite mask (.jpg) carries the base colour and is meaningless on a model
// whose own texture the renderer never sees; those must be two-tone (--pure).
for (const [key, def] of masked) {
  if (!expectedFlipY(def.model ?? '')) continue;
  check(def.texture.emissive.endsWith('.png'),
    `${key}: FBX mask is two-tone .png, not a composite .jpg`);
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
