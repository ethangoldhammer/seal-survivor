#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:voices
//
// TWO THINGS THAT FAIL SILENTLY, which is the only reason they are worth a
// harness at all — neither one throws, and both look exactly like a tuning
// decision from the outside.
//
//   1. A MATERIAL VOICE THAT NAMES A SOUND THAT ISN'T THERE. playSfx returns
//      quietly for a name it doesn't know (see the note on it), so a class
//      whose event, or whose voice, was never written is not an error — it is
//      a boss that hits in silence. Every route from an asset to a sound is
//      walked here: asset -> class -> event -> CONFIG.sfx entry -> something
//      that can actually make a noise.
//
//   2. A HULL THAT SMOKES WHERE IT WASN'T HIT. The puffs are placed from scars
//      remembered in the BOAT'S OWN FRAME, so the sums that convert them back
//      out are the whole feature: get them wrong and the smoke sits at the
//      origin, or trails a boat that has sailed on, and the picture still
//      looks like smoke. Measured against the hull box the same way the wake
//      is (tools/boat-wake-test.mjs).
//
//   node --import ./tools/vite-loader.mjs tools/boss-voice-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bossVoice } from '../path/src/systems/feedback.js';
import { initParticles, resetParticles, updateParticles } from '../path/src/entities/particles.js';
import { boats, updateBoats, damageBoat, resetBoats } from '../path/src/systems/boats.js';
import { setWaveTime } from '../path/src/arena.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const scene = new THREE.Scene();
initParticles(scene);
const points = scene.children.find((c) => c.isPoints);
const attrs = points.geometry.attributes;
const CAP = attrs.aStart.count;
const DT = 1 / 60;

// ===========================================================================
section('EVERY BOSS HAS A VOICE, AND EVERY VOICE HAS A SOUND');
// ===========================================================================
// Driven through bossVoice() rather than by reading the tables, because the
// name it builds is a STRING BUILT FROM A CLASS — `boss` + Hit/Die + the class
// capitalised — and a table that all lines up is no use if that spelling is
// wrong by a letter.
const played = [];
const realFeedback = CONFIG.feedback;
// A proxy over the event table records which event was asked for, without
// running any of the effects it names.
CONFIG.feedback = new Proxy(realFeedback, {
  get(target, prop) {
    if (typeof prop === 'string' && prop.startsWith('boss')) played.push(prop);
    return target[prop];
  },
});

// Every asset a boss can wear, plus the hulls that are not bosses at all, plus
// one that is deliberately unknown.
const SUBJECTS = [
  ['bossShark', 'flesh'],
  ['bossOrca', 'flesh'],
  ['bossSquid', 'flesh'],
  ['bossCrab', 'shell'],
  ['bossBoat', 'hull'],
  ['boat', 'hull'],
  ['trawler', 'hull'],
  // Not in the table on purpose: a boss added tomorrow must still make a noise.
  ['bossSomethingNew', 'flesh'],
];

for (const [key, want] of SUBJECTS) {
  for (const kind of ['hit', 'die']) {
    played.length = 0;
    bossVoice(kind, key, { x: 0, y: 0 });
    const wanted = `boss${kind === 'die' ? 'Die' : 'Hit'}${want[0].toUpperCase()}${want.slice(1)}`;
    check(`${key} ${kind} -> ${wanted}`, played.includes(wanted),
      played.length ? `asked for ${played.join(', ')}` : 'asked for nothing at all');
  }
}
CONFIG.feedback = realFeedback;

// ...and the sounds those events name have to EXIST and be able to make a
// noise. A synth voice with neither a tone nor a noise bed and no sample is
// silence that reports itself as working — see the `missing` branch in playSfx.
for (const cls of ['Flesh', 'Shell', 'Hull']) {
  for (const kind of ['Hit', 'Die']) {
    const event = CONFIG.feedback[`boss${kind}${cls}`];
    check(`boss${kind}${cls} is an event with a sound`, !!event?.sfx, JSON.stringify(event ?? null));
    const voice = CONFIG.sfx[event?.sfx];
    check(`  ...and ${event?.sfx} is a voice that can sound`,
      !!voice && (voice.src || voice.srcs || voice.type === 'blip' || voice.type === 'boom' || voice.type === 'noise'),
      voice ? `type ${voice.type}` : 'no entry in CONFIG.sfx');
  }
}

// The three classes have to be TOLD APART. Six voices that are all the same
// numbers is the same failure as one voice, and it would pass every check
// above.
{
  const fp = (name) => {
    const v = CONFIG.sfx[name] ?? {};
    return [v.type, v.decay, v.gain, v.filter, ...(v.freq ?? [])].join('/');
  };
  const names = ['bossHitFlesh', 'bossHitShell', 'bossHitHull', 'bossDieFlesh', 'bossDieShell', 'bossDieHull'];
  const seen = new Set(names.map(fp));
  check('all six voices are actually different sounds', seen.size === names.length,
    `${seen.size} distinct of ${names.length}`);
  // The one distinction the ear is being asked to make: steel rings, flesh
  // does not. A tone is what makes that difference, so it is asserted rather
  // than left to the numbers above.
  check('...and only steel rings', CONFIG.sfx.bossHitHull.type === 'boom'
    && CONFIG.sfx.bossHitFlesh.type === 'noise',
    `hull ${CONFIG.sfx.bossHitHull.type}, flesh ${CONFIG.sfx.bossHitFlesh.type}`);
}

// ===========================================================================
section('A DAMAGED HULL SMOKES WHERE IT WAS HIT');
// ===========================================================================
const smoke = CONFIG.boats.smoke;

// The boats system spawns on its own timer and sails hulls off the arena, so
// the subject here is placed by hand: one boat, hit where the test says, run
// for a fixed time.
function hullRun({ hits, seconds = 2, hp = 1 }) {
  resetBoats(scene);
  resetParticles();
  setWaveTime(0);
  // Spawning is the system's own business and its timer is random; borrow one
  // hull by driving the update once with spawning forced.
  const wasEnabled = CONFIG.boats.enabled;
  CONFIG.boats.enabled = true;
  let guard = 0;
  while (!boats.length && guard++ < 4000) updateBoats(DT, scene, 1, new THREE.Vector3(), {});
  CONFIG.boats.enabled = wasEnabled;
  if (!boats.length) return null;

  const b = boats[0];
  // Parked, so the hull box is where the sums say it is for the whole run and a
  // puff left behind by a moving boat is not confused with one placed wrong.
  b.speed = 0;
  b.body.vx = 0;
  b.dir = 1;
  b.mesh.updateMatrixWorld(true);

  for (const h of hits) {
    damageBoat(scene, 0, 0, {}, null, { x: b.mesh.position.x + h[0], y: b.mesh.position.y + h[1] }, false);
  }
  // Health is set directly rather than damaged down to it: `damageBoat` at zero
  // blows the hull up, and what is being measured is the arc BEFORE that.
  b.hp = b.maxHp * hp;

  const seen = new Map();
  const puffs = [];
  const frames = Math.round(seconds / DT);
  for (let f = 0; f < frames; f++) {
    updateBoats(DT, scene, 1, new THREE.Vector3(), {});
    if (!boats.length) break;
    for (let i = 0; i < CAP; i++) {
      const start = attrs.aStart.array[i];
      if (start < -1e8 || seen.get(i) === start) continue;
      seen.set(i, start);
      // The smoke is the only goo this system emits; the wake's foam is the
      // other one and it is a different group, so they are told apart by which
      // group index the emitter wrote rather than by position.
      if (attrs.aGoo.array[i] !== SMOKE_GROUP) continue;
      puffs.push({ x: attrs.position.array[i * 3], y: attrs.position.array[i * 3 + 1] });
    }
    updateParticles(DT);
  }
  return { boat: b, puffs };
}

const SMOKE_GROUP = Object.keys(CONFIG.fx.goo.groups).indexOf('smoke') + 1;
check('the smoke group is addressable', SMOKE_GROUP > 0, `index ${SMOKE_GROUP}`);

// An untouched hull is clean. This is the arc: if a boat smokes from the first
// pellet there is nothing left for the rate to say.
{
  const r = hullRun({ hits: [[1, 0]], hp: 1 });
  check('a hull at full health does not smoke', r && r.puffs.length === 0,
    `${r?.puffs.length} puffs`);
}

// ...and a failing one does, from the place it was hit rather than from its
// middle. The offset is deliberately at one end of the boat, so "at the scar"
// and "at the hull's origin" are different answers.
{
  const r = hullRun({ hits: [[2.4, 0.2]], hp: 0.1 });
  check('a failing hull smokes', r && r.puffs.length > 0, `${r?.puffs.length} puffs`);
  if (r?.puffs.length) {
    const b = r.boat;
    const scarX = b.mesh.position.x + 2.4;
    const nearScar = r.puffs.filter((p) => Math.abs(p.x - scarX) < 1.2).length;
    check('  ...at the place it was hit', nearScar === r.puffs.length,
      `${nearScar}/${r.puffs.length} within 1.2u of the scar at x ${scarX.toFixed(1)}`);
    // ...and not at the origin, which is what a dropped local->world conversion
    // would produce and which would still look like smoke.
    const atOrigin = r.puffs.filter((p) => Math.abs(p.x) < 0.5 && Math.abs(p.y) < 0.5).length;
    check('  ...and not at the world origin', atOrigin === 0, `${atOrigin} puffs at 0,0`);
  }
}

// The rate is the readout, so it has to actually move with the damage.
{
  const light = hullRun({ hits: [[1, 0]], hp: 0.6 });
  const heavy = hullRun({ hits: [[1, 0]], hp: 0.05 });
  check('a nearly-dead hull smokes harder than a scratched one',
    light && heavy && heavy.puffs.length > light.puffs.length * 1.5,
    `${light?.puffs.length} at 60% hp against ${heavy?.puffs.length} at 5%`);
}

// A hull nothing has touched has no scars, and a puff with no scar to come from
// would have to be invented at the origin — the same failure as above, arriving
// by a different route.
{
  const r = hullRun({ hits: [], hp: 0.05 });
  check('a hull that lost health with no recorded hits stays clean',
    r && r.puffs.length === 0, `${r?.puffs.length} puffs from no scars`);
}

// The memory is short on purpose, or a chewed hull is a uniform cloud.
{
  const many = Array.from({ length: smoke.sites + 4 }, (_, i) => [i * 0.4 - 2, 0]);
  const r = hullRun({ hits: many, hp: 0.2 });
  check(`only the last ${smoke.sites} hit sites are remembered`,
    r && r.boat.scars.length === smoke.sites, `${r?.boat.scars.length} scars`);
}

resetBoats(scene);
console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
