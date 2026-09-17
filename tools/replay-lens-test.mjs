// ============================================================================
// REPLAY LENS TEST — which camera a goal replay is filmed with, and the one
// way that choice can silently stop working.
//
//   npm run test:replaylens
//
// A Blubberball goal replay is filmed either with the game's own orthographic
// camera (CONFIG.versus.replay.cams.projection === 'flat', the default) or with
// the pool of perspective shots that leave the play plane. The difference is
// not cosmetic: the backdrop is a PICTURE AT ONE DEPTH — sky, water fill and
// seabed strip, each a flat quad a few units behind the play — and that only
// works for a camera whose rays are parallel to -z. A perspective camera sees
// ALONG the picture and every plane in it becomes a wall standing in the scene,
// cutting the gravestones and a third of the plant bed.
//
// WHY THIS FILE EXISTS, and it is one specific failure rather than the feature
// in general. The setting was first called `cams.lens` — and `cams.lens` was
// already taken, by the OPTICAL block beside it (defocus, focus radius, flare),
// which is an object and is in every saved imported-tuning.json. So the toggle
// compared `{defocus: 0.55, ...}` to the string 'flat', was never equal to it,
// and filmed every replay the old way while reading perfectly correctly in
// config.js. Nothing threw. Nothing logged. The only symptom was that a setting
// did not do anything.
//
// So the checks below are about the MERGED config — config.js underneath
// whatever imported-tuning.json pins on top of it, which is what the game
// actually runs on — rather than about the literal in the source.
// ============================================================================
import './dom-stub.mjs';
import { CONFIG } from '../path/src/config.js';
import { flatLens } from '../path/src/systems/replayCams.js';

let failures = 0;
function check(name, pass, detail = '') {
  if (pass) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\nREPLAY LENS\n');

const cams = CONFIG.versus?.replay?.cams ?? {};

console.log('the setting survives the tuning merge');
{
  // imported-tuning.json is a snapshot of whole sections and beats config.js
  // for any key it holds, so a default that is only true in the source is not
  // true on any machine that has ever opened the tuner.
  check('`projection` is a string, not an object',
    typeof cams.projection === 'string', `got ${JSON.stringify(cams.projection)}`);
  check('...and it is one the code understands',
    cams.projection === 'flat' || cams.projection === 'perspective',
    `got ${JSON.stringify(cams.projection)}`);
  // THE COLLISION ITSELF. These two live side by side and mean completely
  // different things; if `lens` ever stops being the optical block, or
  // `projection` starts being one, the toggle is reading the wrong neighbour.
  check('`lens` is still the optical block beside it, not the camera choice',
    cams.lens != null && typeof cams.lens === 'object' && !Array.isArray(cams.lens),
    `lens = ${JSON.stringify(cams.lens)}`);
  check('...and the two are not the same field',
    cams.projection !== cams.lens);
}

console.log('\nthe default is the flat lens');
{
  check('a replay is filmed orthographically unless asked otherwise', flatLens(),
    `projection = ${JSON.stringify(cams.projection)}`);

  // A SNAPSHOT FROM BEFORE THE KEY EXISTED must still get the new behaviour.
  // Every machine that has opened the tuner holds a `cams` block written before
  // this setting was added, so "missing" is the common case rather than the
  // edge one — and defaulting a missing value to 'perspective' would pin all of
  // them to the old camera forever while config.js said otherwise.
  const saved = cams.projection;
  delete cams.projection;
  check('...including one whose saved tuning predates the setting', flatLens());
  cams.projection = saved;
}

console.log('\nthe toggle still reaches the other camera');
{
  const saved = cams.projection;
  cams.projection = 'perspective';
  check('asking for perspective gets perspective', !flatLens());
  cams.projection = 'flat';
  check('...and asking for flat gets flat', flatLens());
  cams.projection = saved;
}

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
