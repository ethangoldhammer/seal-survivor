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
// The format rule has ONE documented exception, and the exception is the reason
// the rule needed writing down more precisely. Deriving flipY from the model
// format only works because every mask here was thresholded FROM the model's
// own embedded diffuse, so it inherits that texture's orientation. A model that
// ships no maps at all has nothing to inherit: its sidecars were baked by some
// other tool and carry that tool's convention. `def.texture.flipY` overrides
// the rule for exactly those, and each override is asserted by name below so
// adding one stays a deliberate act rather than a quiet opt-out.
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
//
// Overrides are listed here by key rather than read from the asset, so that an
// asset quietly gaining a `texture.flipY` fails this test instead of silently
// redefining what "expected" means. Each entry needs a measurement behind it:
//
//   enemyHammerhead — the model ships no maps of its own (not even in the
//     2.25MB source), so both sidecars came from the external baking tool. At
//     the format default of false its body still looks plausible, because the
//     body is the one big central UV island either way, while every fin lands
//     off its own small island and picks up the black background between them.
const OVERRIDES = { enemyHammerhead: true };
const isFbx = (model) => /\.fbx$/i.test(model);
const expectedFlipY = (key, model) => OVERRIDES[key] ?? isFbx(model);

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
check(/const flipY = def\.texture\?\.flipY \?\? \/\\\.fbx\$\/i\.test\(def\.model \?\? ''\)/.test(src),
  'the format test is on the model extension, with a per-asset override in front of it');
// The override must stay a fallback-to-format, never a replacement: written the
// other way round (`/\.fbx$/.test(...) ?? def.texture?.flipY`) the format result
// is always a boolean, so the override could never win and would read as
// working while doing nothing.
check(/def\.texture\?\.flipY \?\?/.test(src) && !/\?\? def\.texture\?\.flipY/.test(src),
  'the override takes precedence over the format default, not the reverse');

for (const [key, def] of masked) {
  const mask = path.join(ROOT, 'public', def.texture.emissive.replace(/^\//, ''));
  check(fs.existsSync(mask), `${key}: mask file ${def.texture.emissive} exists`);

  const model = path.join(ROOT, 'public', (def.model ?? '').replace(/^\//, ''));
  check(def.model && fs.existsSync(model), `${key}: model ${def.model} exists`);

  // A mask on an FBX is the case that broke. Assert the expectation explicitly
  // per asset so the roster itself is the record of which way each one goes.
  //
  // The comparison that matters: what THIS FILE expects against what the asset
  // actually declares. An asset that grows a `texture.flipY` without a matching
  // entry in OVERRIDES above fails here, which is the point — the exception has
  // to be argued for in both places or not taken at all.
  const want = expectedFlipY(key, def.model ?? '');
  const declared = def.texture?.flipY ?? isFbx(def.model ?? '');
  const why = OVERRIDES[key] != null ? 'declared override' : (want ? 'FBX' : 'glTF') + ' convention';
  check(declared === want, `${key}: ${path.extname(def.model ?? '')} -> flipY ${want} (${why})`);
}

// A composite mask (.jpg) carries the base colour and is meaningless on a model
// whose own texture the renderer never sees; those must be two-tone (--pure).
//
// Keyed on the FORMAT, not on flipY. The two used to be the same question and
// are not any more: enemyHammerhead flips like an FBX but is a glTF whose
// texture the renderer does see, so a composite mask is right for it.
for (const [key, def] of masked) {
  if (!isFbx(def.model ?? '')) continue;
  check(def.texture.emissive.endsWith('.png'),
    `${key}: FBX mask is two-tone .png, not a composite .jpg`);
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
