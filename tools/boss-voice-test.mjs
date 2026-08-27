#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:voices
//
// TWO THINGS THAT FAIL SILENTLY, which is the only reason they are worth a
// harness at all — neither one throws, and both look exactly like a tuning
// decision from the outside.
//
//   1. A VOICE THAT NAMES A SOUND THAT ISN'T THERE. playSfx returns quietly
//      for a name it doesn't know (see the note on it), so a class whose
//      event, or whose voice, was never written is not an error — it is a boss
//      that hits in silence. Every route from an asset to a sound is walked
//      here: asset -> class -> event -> CONFIG.sfx entry -> something that can
//      actually make a noise.
//
//      WALKED FROM THE ROSTER, not from a list of keys typed into this file.
//      The list is how `voiceClass.bossCrab` survived: it was keyed by the
//      ARCHETYPE while the game looks the map up by the ASSET, so the king crab
//      never once made a shell sound — and the harness agreed with the map,
//      because the harness was asking it the same wrong question. Every subject
//      below now comes out of bosses.csv through CONFIG.enemies, which is the
//      exact path a live boss takes.
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
import { parseBossCsv } from '../path/src/bossTable.js';
import bossesCsv from '../path/src/bosses.csv?raw';
import { bossVoice, onFeedback } from '../path/src/systems/feedback.js';
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
const spy = new Proxy(realFeedback, {
  get(target, prop) {
    if (typeof prop === 'string' && prop.startsWith('boss')) played.push(prop);
    return target[prop];
  },
});

// SWAPPED IN FOR THE CALL AND OUT AGAIN, rather than left installed for the
// file. Everything below reads CONFIG.feedback to assert what an event holds,
// and a spy that is still in place counts those reads as events that fired —
// which would make a check of "did this stay silent" pass or fail on whether a
// nearby line happened to look the table up.
function fire(kind, key, opts) {
  played.length = 0;
  CONFIG.feedback = spy;
  try { bossVoice(kind, key, { x: 0, y: 0 }, opts); } finally { CONFIG.feedback = realFeedback; }
  return played;
}

// EVERY ASSET A BOSS CAN ACTUALLY WEAR, derived the way the game derives it:
// bosses.csv -> CONFIG.enemies[enemy] -> `assets` list, `asset`, or the id as
// the fallback (see spawnOne in entities/enemies.js). A boss that rolls between
// two bodies contributes both, which is how the orca gets caught.
const ROSTER = parseBossCsv(bossesCsv, CONFIG.enemies);
const bossAssets = new Map(); // asset -> archetype ids that can wear it
for (const boss of ROSTER) {
  const def = CONFIG.enemies[boss.enemy] ?? {};
  const worn = Array.isArray(def.assets) && def.assets.length
    ? [...def.assets]
    : [def.asset ?? boss.enemy];
  if (def.nightAsset) worn.push(def.nightAsset);
  for (const a of worn) {
    if (!bossAssets.has(a)) bossAssets.set(a, []);
    bossAssets.get(a).push(boss.id);
  }
}
check('the roster resolves to bodies', bossAssets.size >= ROSTER.length,
  `${ROSTER.length} archetypes wearing ${bossAssets.size} assets`);

// The hulls that are NOT bosses come through bossVoice too (damageBoat), and a
// deliberately unknown key stands in for the boss added tomorrow.
const SUBJECTS = [
  ...[...bossAssets.keys()].map((a) => [a, true]),
  ['boat', false],
  ['trawler', false],
  ['bossSomethingNew', false],
];

for (const [key] of SUBJECTS) {
  for (const kind of ['hit', 'die']) {
    const cls = CONFIG.boss.voiceClass?.[key] ?? CONFIG.boss.voiceDefault;
    fire(kind, key);
    const wanted = `boss${kind === 'die' ? 'Die' : 'Hit'}${cls[0].toUpperCase()}${cls.slice(1)}`;
    check(`${key} ${kind} -> ${wanted}`, played.includes(wanted),
      played.length ? `asked for ${played.join(', ')}` : 'asked for nothing at all');
  }
}

// A KEY THAT MATCHES NOTHING. Both maps are keyed by asset, and a key that is
// not an asset anything wears is not a typo the reader can see — it is a row
// that reads exactly right and never fires. `boat` and `trawler` are the two
// legitimate non-boss keys; everything else has to be a body in the roster.
{
  const AMBIENT = new Set(['boat', 'trawler']);
  for (const [map, name] of [[CONFIG.boss.voiceClass, 'voiceClass'], [CONFIG.boss.voiceType, 'voiceType']]) {
    const dead = Object.keys(map ?? {}).filter((k) => !bossAssets.has(k) && !AMBIENT.has(k));
    check(`every ${name} key is a body something wears`, dead.length === 0,
      dead.length ? `${dead.join(', ')} — no boss wears ${dead.length > 1 ? 'these' : 'this'}` : `${Object.keys(map ?? {}).length} keys`);
  }
}

// ...and the two rows that are the whole reason the map exists. Asserted
// through the ROSTER rather than by naming the key, so this fails if the crab
// changes body and the row is left behind.
{
  const classOf = (archetype) => {
    const asset = [...bossAssets].find(([, ids]) => ids.includes(archetype))?.[0];
    return CONFIG.boss.voiceClass?.[asset] ?? CONFIG.boss.voiceDefault;
  };
  check('the king crab is shell', classOf('bossCrab') === 'shell', classOf('bossCrab'));
  check('both boat bosses are steel',
    classOf('bossBoat') === 'hull' && classOf('bossYacht') === 'hull',
    `boat ${classOf('bossBoat')}, yacht ${classOf('bossYacht')}`);
}

// ...and the sounds those events name have to EXIST and be able to make a
// noise. A synth voice with neither a tone nor a noise bed and no sample is
// silence that reports itself as working — see the `missing` branch in playSfx.
const canSound = (voice) => !!voice
  && (voice.src || voice.srcs || voice.type === 'blip' || voice.type === 'boom' || voice.type === 'noise');

for (const cls of ['Flesh', 'Shell', 'Hull']) {
  for (const kind of ['Hit', 'Die']) {
    const event = CONFIG.feedback[`boss${kind}${cls}`];
    check(`boss${kind}${cls} is an event with a sound`, !!event?.sfx, JSON.stringify(event ?? null));
    check(`  ...and ${event?.sfx} is a voice that can sound`, canSound(CONFIG.sfx[event?.sfx]),
      CONFIG.sfx[event?.sfx] ? `type ${CONFIG.sfx[event?.sfx].type}` : 'no entry in CONFIG.sfx');
  }
}

// The three classes have to be TOLD APART. Six voices that are all the same
// numbers is the same failure as one voice, and it would pass every check
// above.
const fp = (name) => {
  const v = CONFIG.sfx[name] ?? {};
  return [v.type, v.decay, v.gain, v.filter, ...(v.freq ?? [])].join('/');
};
{
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
section('THE SHARED LAYER, AND WHAT IS NOT A BOSS');
// ===========================================================================
// `bossHit`/`bossDeath` fire for every boss and for nothing else. The failure
// this catches is a rowboat announcing a boss fight — damageBoat runs the
// ambient hulls through bossVoice for their steel, and they are scenery.
for (const kind of ['hit', 'die']) {
  const general = kind === 'die' ? 'bossDeath' : 'bossHit';
  check(`a boss ${kind} fires ${general}`,
    fire(kind, [...bossAssets.keys()][0]).includes(general), played.join(', '));
  check(`  ...and a trawler ${kind} does not`,
    !fire(kind, 'trawler', { general: false }).includes(general), played.join(', '));
}

// The shared layer is allowed the channels nothing else on the frame carries,
// and no others. A second shake here lands on a frame that already has
// bulletHit's going in and bigKill's plus the explosion going out.
for (const name of ['bossHit', 'bossDeath']) {
  const def = CONFIG.feedback[name];
  check(`${name} exists`, !!def, def ? '' : 'missing from CONFIG.feedback');
  check(`  ...and carries no second impact`, !def?.shake && !def?.hitstop && !def?.emit && !def?.ripple,
    JSON.stringify(def));
  // The audit in tools/upgrade-test.mjs fails an event with no live channel at
  // all, and an inert row is a slider that looks connected and is not.
  check(`  ...and is not inert`, !!(def?.glow || def?.sfx || def?.haptic), JSON.stringify(def));
}

// ===========================================================================
section('EVERY BOSS THAT CRIES OUT, CRIES IN ITS OWN VOICE');
// ===========================================================================
// The third layer — CONFIG.boss.voiceType, the animal rather than the material.
// Sparse by design: no row means no cry, so what is checked is that every row
// that IS there reaches a sound, and that no two of them reach the same one.
const cries = [];
for (const [asset, type] of Object.entries(CONFIG.boss.voiceType ?? {})) {
  for (const kind of ['hit', 'die']) {
    const verb = kind === 'die' ? 'Die' : 'Hit';
    const event = `boss${verb}${type}`;
    cries.push(event);
    const def = CONFIG.feedback[event];
    check(`${asset} ${kind} -> ${event}`, !!def, def ? '' : 'no such event — the cry never plays');
    check(`  ...and ${def?.sfx} can sound`, canSound(CONFIG.sfx[def?.sfx]),
      CONFIG.sfx[def?.sfx] ? `type ${CONFIG.sfx[def?.sfx].type}` : `no CONFIG.sfx.${def?.sfx}`);
    // SOUND ONLY, like the material voices it rides on. A cry that shook the
    // camera would be the third thing shaking it on one blow.
    check('  ...and adds nothing but sound', !def?.shake && !def?.hitstop && !def?.emit && !def?.ripple && !def?.glow,
      JSON.stringify(def));
  }
}

// ...and fired through bossVoice, which is where the spelling can go wrong.
for (const [asset, type] of Object.entries(CONFIG.boss.voiceType ?? {})) {
  check(`${asset} cries as ${type} when it is hit`,
    fire('hit', asset).includes(`bossHit${type}`), played.join(', '));
}

// A boss with no row is SILENT, not falling back into some other animal's
// voice. That is the design (see the note on voiceType) and it is one `??`
// away from being untrue.
{
  const cried = fire('hit', 'bossSomethingNew').filter((e) => cries.includes(e));
  check('a boss with no cry row stays silent', cried.length === 0, cried.join(', '));
}

// EIGHTEEN CRIES, EIGHTEEN SOUNDS. The one that matters most in this file: the
// whole point of the layer is that the hammerhead is not the megalodon, and a
// copied row passes every check above.
{
  const unique = new Set(cries);
  const seen = new Set([...unique].map(fp));
  check('every cry is a different sound', seen.size === unique.size,
    `${seen.size} distinct of ${unique.size}`);
}

// AND QUIETER THAN THE BODY THEY SIT ON. The layer that says what was struck
// has to stay the loudest thing in the moment — see the note in CONFIG.sfx.
for (const [asset, type] of Object.entries(CONFIG.boss.voiceType ?? {})) {
  const cls = CONFIG.boss.voiceClass?.[asset] ?? CONFIG.boss.voiceDefault;
  const under = CONFIG.sfx[`bossHit${cls[0].toUpperCase()}${cls.slice(1)}`];
  const over = CONFIG.sfx[`bossHit${type}`];
  check(`the ${type} cry sits under its own ${cls}`, (over?.gain ?? 1) < (under?.gain ?? 0),
    `${over?.gain} vs ${under?.gain}`);
}

// AND SLOWER. A cry on every pellet is a loop, not an animal — the material
// voice answers each hit, this one answers the fight.
for (const [, type] of Object.entries(CONFIG.boss.voiceType ?? {})) {
  const cry = CONFIG.feedback[`bossHit${type}`];
  check(`the ${type} cry is throttled well past the material voice`,
    (cry?.sfxMinGap ?? 0) >= (CONFIG.feedback.bossHitFlesh.sfxMinGap ?? 0) * 5,
    `${cry?.sfxMinGap}s vs ${CONFIG.feedback.bossHitFlesh.sfxMinGap}s`);
  check(`  ...and the ${type} death is not throttled at all`,
    !CONFIG.feedback[`bossDie${type}`]?.sfxMinGap, `${CONFIG.feedback[`bossDie${type}`]?.sfxMinGap}`);
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

// ===========================================================================
section('EVERY BLOW THAT HURTS A HULL RINGS IT, AND EVERY SUNK HULL GOES UP');
// ===========================================================================
// The regression this exists for: the hull's hit voice was wired to the BULLET
// path and its explosion to a hook the caller had to remember to pass, so a
// boat rammed by the seal, run down by the orca pod or shoved into by another
// boat took damage in silence, and one sunk by any of them went up without the
// blast. Both live in damageBoat now, which is the one door all four routes go
// through — so this drives that door directly and passes NO hooks at all,
// because "the caller forgot the hook" is exactly the failure.
{
  const heard = [];
  const stop = onFeedback((event) => heard.push(event));

  const hull = () => {
    const r = hullRun({ hits: [], hp: 1 });
    heard.length = 0;
    return r?.boat;
  };

  // A DAMAGING BLOW. No `at`, no `dir`, no hooks — the shape of the call the
  // physics solver and a splash make, and the one that used to be mute.
  if (hull()) {
    damageBoat(scene, 0, 5, {}, null, null, false);
    check('a damaging hit rings the hull', heard.includes('bossHitHull'),
      heard.length ? `heard ${heard.join(', ')}` : 'heard nothing');
  }

  // ...and a call that only remembers a scar is not a blow. damageBoat at zero
  // is how a hit with no damage records where it landed (see hullRun above),
  // and a ring on it would be a hull that pings when nothing hurt it.
  if (hull()) {
    damageBoat(scene, 0, 0, {}, null, { x: 0, y: 0 }, false);
    check('  ...and a zero-damage scar stays quiet', !heard.includes('bossHitHull'),
      `heard ${heard.join(', ') || 'nothing'}`);
  }

  // THE KILL, again with no hooks.
  if (hull()) {
    const gone = damageBoat(scene, 0, 1e6, {}, null, null, false);
    check('a sunk hull explodes without being handed a hook',
      gone && heard.includes('boatExplosion'), `heard ${heard.join(', ') || 'nothing'}`);
    check('  ...and dies in its own voice', heard.includes('bossDieHull'),
      `heard ${heard.join(', ') || 'nothing'}`);
  }

  stop();
}

resetBoats(scene);
console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
