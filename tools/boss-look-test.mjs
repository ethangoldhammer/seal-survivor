#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:bosslook
//
// THE PERK IS ON THE BODY, AND IT COMES OFF AGAIN.
//
// bossLooks.csv is the third rendering of one fact. The name says the boss is
// electric, the aura ring is drawn in the electric colour, and the animal is
// painted from the same row — and the whole value of that is the three not
// being able to disagree. So the claims below are about the JOINS rather than
// about any look:
//
//   THE TABLE JOINS TO THE PERKS. An id here that is not a perk id is a look
//   no boss can ever wear, and it fails silently: a perfectly good row, and
//   nothing anywhere saying it never appears.
//
//   BLANK MEANS INHERIT. Every look cell may be empty, and empty must leave
//   the species preset alone rather than writing a zero over it. A row that
//   sets only `strength` must not reset the pattern.
//
//   THE SPARKS ARE THE RING. A blank sparkColor resolves to the perk's attack
//   colour, which is the number the aura ring is built from. This is the one
//   claim in the file that is a guarantee rather than a default, and the way
//   it breaks is somebody typing a hex into the cell because it looked empty.
//
//   IT COMES OFF. The trap this feature is built around: bodies are POOLED,
//   and the usual defence (enemies.js re-rolls the skin on every spawn) does
//   NOT cover a boss, because rollBiolumSkinVariant only stamps when the roll
//   returns something and no boss preset has skins.csv rows. A perk look left
//   on a released body rides the pool onto the next ordinary shark.
//
// The table claims run on synthetic CSV rather than the shipping file, for the
// same reason boss-name-test does: this is about the rules, and a test reading
// bossLooks.csv would start failing the day somebody authored a good look.
//
//   node --import ./tools/vite-loader.mjs tools/boss-look-test.mjs
// ---------------------------------------------------------------------------

import { parseBossLookCsv, buildBossLooks } from '../path/src/bossLookTable.js';
import { BIOLUM_PATTERNS } from '../path/src/systems/biolumSkin.js';
import { PERK_IDS } from '../path/src/bossPerkTable.js';
import { threatColor } from '../path/src/systems/organicRing.js';
import { bossLookRoster, bossSparkColor, bossLookFor } from '../path/src/systems/bossLook.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const HEAD = 'id,enabled,pattern,colorA,colorB,colorC,shellColor,shellGlow,'
  + 'strength,pigment,coverage,scale,sparkColor,notes';
const table = (...rows) => {
  const warns = [];
  const looks = buildBossLooks(
    parseBossLookCsv([HEAD, ...rows].join('\n'), (m) => warns.push(m)),
    { patterns: BIOLUM_PATTERNS, perks: PERK_IDS },
    (m) => warns.push(m),
  );
  return { looks, warns };
};

// ===========================================================================
section('THE TABLE JOINS TO bossPerks.csv');
// ===========================================================================
{
  const { looks, warns } = table('notAPerk,,veins,#ffd83a,,,,,,,,,,');
  check('a row whose id is not a perk is dropped', !looks.notAPerk);
  check('...and says so, naming the known ids',
    warns.some((w) => w.includes('not a perk') && w.includes('electric')),
    warns.join(' | '));
}
{
  const { looks } = table('electric,,veins,#ffd83a,,,,,,,,,,');
  check('a row whose id IS a perk lands', !!looks.electric);
}

// ===========================================================================
section('BLANK MEANS INHERIT, NEVER ZERO');
// ===========================================================================
{
  const { looks } = table('electric,,,,,,,,2.6,,,,,');
  const keys = Object.keys(looks.electric.look);
  check('a row setting only `strength` sets only strength',
    keys.length === 1 && keys[0] === 'strength' && looks.electric.look.strength === 2.6,
    keys.join(','));
  check('...and does not invent a pattern', !('pattern' in looks.electric.look));
  check('...and does not invent a coverage of 0', !('coverage' in looks.electric.look));
}
{
  // The failure this guards is a look that paints a boss BLACK because a hex
  // was typed with a stray character. Inheriting is the only safe answer.
  const { looks, warns } = table('electric,,,#ff,,,,,2.6,,,,,');
  check('an unparseable colour is dropped rather than parsed to black',
    !('colorA' in looks.electric.look));
  check('...loudly', warns.some((w) => w.includes('colorA')), warns.join(' | '));
}
{
  const { looks, warns } = table('electric,,notAPattern,,,,,,2.6,,,,,');
  check('an unknown pattern is dropped rather than indexed to blotches',
    !('pattern' in looks.electric.look));
  check('...loudly', warns.some((w) => w.includes('notAPattern')), warns.join(' | '));
}
{
  const { looks, warns } = table('electric,,,,,,,,,,,,,"nothing set"');
  check('an enabled row that sets nothing is not stored', !looks.electric);
  check('...and is reported as unwritten rather than silently costing a traverse',
    warns.some((w) => w.includes('sets nothing')), warns.join(' | '));
}
{
  const { looks } = table('electric,FALSE,veins,#ffd83a,,,,,2.6,,,,,');
  check('enabled=FALSE takes the row out without deleting it', !looks.electric);
}

// ===========================================================================
section('THE SPARKS ARE THE RING, UNLESS SOMEBODY SAYS OTHERWISE');
// ===========================================================================
{
  // Against the SHIPPING table, deliberately — this is the guarantee, and the
  // way it breaks is a hex typed into the shipped row.
  const roster = bossLookRoster();
  const electric = roster.electric;
  check('the shipped electric row exists', !!electric);
  if (electric) {
    check('...and leaves sparkColor blank, so the arcs take the ring colour',
      electric.sparkColor == null,
      electric.sparkColor == null ? '' : `#${electric.sparkColor.toString(16)}`);
  }
  const ring = threatColor('electric');
  check('bossSparkColor on an electric perk IS the ring colour',
    bossSparkColor({ id: 'electric', attack: 'electric' }) === ring,
    `#${ring.toString(16)}`);
  check('...and a perk with no row still gets its attack colour rather than white',
    bossSparkColor({ id: 'turtles', attack: 'void' }) === threatColor('void'));
}

// ===========================================================================
section('THE SHIPPED TABLE IS COHERENT');
// ===========================================================================
{
  const roster = bossLookRoster();
  const ids = Object.keys(roster);
  check('every id in bossLooks.csv is a real perk',
    ids.every((id) => PERK_IDS.includes(id)), ids.join(','));
  check('every pattern named is a real pattern',
    ids.every((id) => !roster[id].look.pattern || BIOLUM_PATTERNS.includes(roster[id].look.pattern)));
  check('bossLookFor returns null for a perk with no row',
    bossLookFor('giant') === null || !!roster.giant);
  check('bossLookFor(null) is null rather than a throw', bossLookFor(null) === null);
}

// ===========================================================================
section('IT COMES OFF THE BODY AGAIN');
// ===========================================================================
// A stand-in for a built body: applyBossLook/clearBossLook only ever reach the
// materials through traverse + userData, so a plain object tree is a faithful
// subject and needs no GL context. What is being tested is the LIFECYCLE, not
// the shader.
{
  const { applyBossLook, clearBossLook } = await import('../path/src/systems/bossLook.js');
  const makeBody = (preset) => {
    const mat = {
      userData: { __bioSkin: true, __bioSkinInstance: true, __bioSkinPreset: preset,
        __bioSkinVariant: null },
    };
    const mesh = { isMesh: true, material: mat, traverse(fn) { fn(this); } };
    return {
      mesh,
      mat,
      traverse(fn) { fn(this); fn(mesh); },
    };
  };

  const body = makeBody('hide');
  const enemy = { visual: body };

  applyBossLook(enemy, { id: 'electric', attack: 'electric' });
  const painted = body.mat.userData.__bioSkinVariant;
  check('applying an electric perk stamps a variant on the body', !!painted,
    JSON.stringify(painted));
  check('...tagged with which look it came from', painted?.__bossLook === 'electric');

  clearBossLook();
  const after = body.mat.userData.__bioSkinVariant;
  check('clearing hands the body back with no look on it',
    !!after && !('__bossLook' in after) && !('strength' in after),
    JSON.stringify(after));
  // THE BUG THIS WHOLE FUNCTION EXISTS FOR. setBiolumSkinVariant early-outs on
  // a falsy variant, so restoring `null` would leave the paint exactly where
  // it was — and the next creature to recycle this body would wear it.
  check('...as an EMPTY variant, not null, or the stamp would have been skipped',
    after !== null && typeof after === 'object');
}
{
  const { applyBossLook, clearBossLook } = await import('../path/src/systems/bossLook.js');
  const mat = {
    userData: { __bioSkin: true, __bioSkinInstance: true, __bioSkinPreset: 'kingCrab',
      __bioSkinVariant: { pattern: 'lattice', __skin: 'lattice' } },
  };
  const mesh = { isMesh: true, material: mat, traverse(fn) { fn(this); } };
  const body = { traverse(fn) { fn(this); fn(mesh); } };

  applyBossLook({ visual: body }, { id: 'electric', attack: 'electric' });
  const painted = mat.userData.__bioSkinVariant;
  check('a look merges OVER the skin the individual rolled, rather than replacing it',
    painted.__skin === 'lattice' && painted.__bossLook === 'electric',
    JSON.stringify(painted));

  clearBossLook();
  check('...and the rolled skin is what comes back',
    mat.userData.__bioSkinVariant.__skin === 'lattice'
      && !('__bossLook' in mat.userData.__bioSkinVariant),
    JSON.stringify(mat.userData.__bioSkinVariant));
}
{
  const { applyBossLook } = await import('../path/src/systems/bossLook.js');
  // A body with no procedural skin at all — every boat, and every swimmer
  // before assets.csv gave them a `surface`. Must be a warned no-op, never a
  // throw: the fight has to happen even if the paint cannot.
  const body = { traverse(fn) { fn(this); } };
  let threw = false;
  let out;
  try { out = applyBossLook({ visual: body }, { id: 'electric', attack: 'electric' }); }
  catch { threw = true; }
  check('an unskinned body is a no-op rather than a crash', !threw && out === null);
}

// ===========================================================================
section('AND THE PAINT MOVES WITH THE FIGHT');
// ===========================================================================
// updateBossLook drives one number, 0..1, off the perk's STAGE, and multiplies
// the two channels that mean "charged" — the marking's strength and the light
// behind it. What is asserted here is the shape of that drive, because the
// failure modes are all silent: a drive that never rises is a body that
// declines to take part in its own attack, and one that never falls is a boss
// permanently lit, which reads as the tell having stopped meaning anything.
{
  const { applyBossLook, clearBossLook, updateBossLook, bossLookDrive } =
    await import('../path/src/systems/bossLook.js');
  const mat = {
    userData: { __bioSkin: true, __bioSkinInstance: true, __bioSkinPreset: 'kingCrab',
      __bioSkinVariant: null },
  };
  const mesh = { isMesh: true, material: mat, traverse(fn) { fn(this); } };
  const body = { mesh, traverse(fn) { fn(this); fn(mesh); } };

  // `saddle` — the study the king crab leans on from level 5.
  const perk = { id: 'saddle', attack: 'void' };
  const resting = applyBossLook({ visual: body }, perk);
  check('an attractor perk paints the body at all', !!resting,
    JSON.stringify({ strength: resting?.strength, shellGlow: resting?.shellGlow }));
  check('...and starts at rest', bossLookDrive() === 0);

  const step = (stage, seconds) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      updateBossLook(1 / 60, stage ? { id: 'saddle', stage } : null);
    }
    return mat.userData.__bioSkinVariant;
  };

  // Sitting on its cooldown: nothing moves.
  step('ready', 1);
  check('a perk on cooldown leaves the look exactly as authored',
    bossLookDrive() === 0
      && mat.userData.__bioSkinVariant.strength === resting.strength,
    `drive ${bossLookDrive().toFixed(3)}`);

  // Winding up: the drive climbs, and the paint climbs with it.
  const lit = step('windup', 1);
  check('a perk winding up lights the body', bossLookDrive() > 0.8,
    `drive ${bossLookDrive().toFixed(3)} after 1s of tell`);
  check('...raising the marking', lit.strength > resting.strength,
    `${resting.strength} -> ${lit.strength.toFixed(2)}`);
  check('...and the light behind it harder still',
    (lit.shellGlow / resting.shellGlow) > (lit.strength / resting.strength),
    `shell x${(lit.shellGlow / resting.shellGlow).toFixed(2)} against `
    + `marking x${(lit.strength / resting.strength).toFixed(2)}`);
  // COLOUR IS NOT PART OF IT. The palette is what says WHICH perk this is, and
  // a look that shifted hue as it climbed would be two bosses in one fight.
  check('...without touching the palette',
    lit.colorA === resting.colorA && lit.colorB === resting.colorB
      && lit.pattern === resting.pattern,
    'hue and pattern are the perk\'s identity, not its state');

  // ...and it comes back down when the perk does.
  step('ready', 3);
  check('and it ebbs when the perk goes quiet', bossLookDrive() < 0.05,
    `drive ${bossLookDrive().toFixed(3)} three seconds later`);
  check('...all the way back to what the row authored',
    Math.abs(mat.userData.__bioSkinVariant.strength - resting.strength) < 0.05,
    `${mat.userData.__bioSkinVariant.strength.toFixed(2)} against ${resting.strength}`);

  // A FIELD THAT IS OPEN BREATHES. Every other stage is over in under a second;
  // this one lasts seconds, and a static level over that reads as a still frame.
  {
    step('storm', 1.5);
    const seen = new Set();
    for (let i = 0; i < 90; i++) {
      updateBossLook(1 / 60, { id: 'saddle', stage: 'storm' });
      seen.add(mat.userData.__bioSkinVariant.strength.toFixed(3));
    }
    check('an open field breathes rather than holding still', seen.size > 3,
      `${seen.size} distinct levels over 1.5s`);
  }

  // ...and none of it survives the body going back to the pool.
  clearBossLook();
  check('clearing the look drops the drive with it', bossLookDrive() === 0);
  // A perk arriving on a body that was never painted must be a no-op rather
  // than a throw — the boats and every unskinned archetype take this path.
  let threw = false;
  try { updateBossLook(1 / 60, { id: 'saddle', stage: 'windup' }); } catch { threw = true; }
  check('...and driving an unpainted body is a no-op', !threw && bossLookDrive() === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
