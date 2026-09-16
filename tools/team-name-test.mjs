#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:teamnames
//
// WHAT A BLUBBERBALL SIDE IS CALLED — teamNames.csv, and the two joins that
// make a team name different from every other rolled string in the game: it is
// built out of a COLOUR the player picked and out of the SEALS sitting in the
// seats, so both halves can be wrong in ways a vocabulary test would never see.
//
// The claims:
//
//   THE BAND IS NEAREST, NOT EXACT. The wheel's hexes are explicitly
//   replaceable, so a colour row names a hue and a kit is matched to the
//   closest one. Nudge a swatch and it keeps its words; add one and it lands
//   in a band rather than in none.
//
//   ...AND IT WRAPS. Red sits at 0°, so a kit at 350° is four bands away by
//   subtraction and one band away on the circle. Getting this wrong names
//   every pink in the red band's words and nothing about the file looks wrong.
//
//   A GREY IS NOT A RED. Hue is meaningless without saturation — every grey
//   reads as hue 0 — so an unsaturated kit takes the neutral band.
//
//   A SHAPE THAT CANNOT BE FILLED IS NOT DRAWN. A side of one-word seals has
//   no adjective to lend; the shapes that want one leave the pool rather than
//   rendering "{adjective} Terrors" onto the card.
//
//   ONE SEAL LENDS A WHOLE NAME. "{adjective} {nickname}" must be one member's
//   two halves and not two members stitched together.
//
//   A TYPO'D TOKEN IS REFUSED AT PARSE, loudly. It is the one failure that
//   ships silently: nobody reads a team name twice.
//
//   BOTH SIDES ARE NEVER CALLED THE SAME THING.
//
// The rules are driven on synthetic tables so this does not start failing the
// day Ethan writes a good name. The SHIPPED file is checked too, but only for
// the mechanical properties — never for its contents.
//
//   node --import ./tools/vite-loader.mjs tools/team-name-test.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTeamNameCsv, rollTeamName, bandOfColor, colourWords, hueSat, hueGap,
  splitLastWord, TEAM_NAME_SLOTS, TEAM_TOKENS, NEUTRAL_BAND, NEUTRAL_SAT,
  MAX_TEAM_NAME_LEN, DEFAULT_FULL_CHANCE,
} from '../path/src/teamNameTable.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const HEAD = 'id,slot,text,review,hue,enabled,weight,notes';
const table = (...rows) => {
  const warns = [];
  const parts = parseTeamNameCsv([HEAD, ...rows].join('\n'), (m) => warns.push(String(m)));
  return { parts, warns };
};
const said = (warns, needle) => warns.some((w) => w.toLowerCase().includes(needle.toLowerCase()));

// A table with one word per band and one shape, so a rolled name says exactly
// which band it came from.
const BANDS = table(
  'red,colour,Red,,0,,,',
  'green,colour,Green,,120,,,',
  'blue,colour,Blue,,240,,,',
  'white,colour,White,,neutral,,,',
  'noun,noun,Terrors,,,,,',
  'shape,shape,{colour} {noun},,,,,',
);

// ---------------------------------------------------------------------------
section('the hue circle');
// ---------------------------------------------------------------------------
{
  check('a pure red reads 0°', Math.round(hueSat(0xff0000).hue) === 0);
  check('a pure green reads 120°', Math.round(hueSat(0x00ff00).hue) === 120);
  check('a pure blue reads 240°', Math.round(hueSat(0x0000ff).hue) === 240);
  check('a grey has no saturation', hueSat(0x808080).sat === 0, String(hueSat(0x808080).sat));
  check('black has no saturation', hueSat(0x000000).sat === 0);
  check('the wheel’s white is under the neutral floor', hueSat(0xf2f2f2).sat < NEUTRAL_SAT);
  check('the wheel’s weakest colour is well over it', hueSat(0x8f5cff).sat > NEUTRAL_SAT * 3, hueSat(0x8f5cff).sat.toFixed(2));

  check('the gap is measured the short way round', hueGap(350, 10) === 20, String(hueGap(350, 10)));
  check('...both directions', hueGap(10, 350) === 20);
  check('...and never over half the circle', hueGap(0, 181) === 179);
}

// ---------------------------------------------------------------------------
section('a kit colour finds its band');
// ---------------------------------------------------------------------------
{
  const { parts } = BANDS;
  check('a red kit takes the red band', bandOfColor(parts, 0xff0000) === 0);
  check('a green kit takes the green band', bandOfColor(parts, 0x00ff00) === 120);
  // Hue 82 — 82° from red and 38° from green.
  check('a colour BETWEEN two bands takes the nearer one', bandOfColor(parts, 0xa8e63d) === 120, String(bandOfColor(parts, 0xa8e63d)));
  // Hue 60 — exactly between them. The first row in the file wins, which is
  // arbitrary and has to be DECIDED rather than left to sort order: a tie that
  // flipped between loads would give one match red words and the next green.
  check('...and a dead tie goes to the row that comes first', bandOfColor(parts, 0xffff00) === 0, String(bandOfColor(parts, 0xffff00)));
  // 0xff0080 is hue 330: four bands away by subtraction, one band away round
  // the circle. This is the assertion that catches a missing wrap.
  check('a magenta wraps round to red rather than to blue', bandOfColor(parts, 0xff0080) === 0, String(bandOfColor(parts, 0xff0080)));
  check('a grey takes the neutral band, not red', bandOfColor(parts, 0x808080) === NEUTRAL_BAND, String(bandOfColor(parts, 0x808080)));
  check('...and so does a near-white', bandOfColor(parts, 0xf2f2f2) === NEUTRAL_BAND);
  check('a wheel swatch NUDGED keeps its band', bandOfColor(parts, 0xf03a3a) === 0, String(bandOfColor(parts, 0xf03a3a)));

  const { parts: noNeutral } = table('red,colour,Red,,0,,,', 'noun,noun,Terrors,,,,,', 'shape,shape,{colour} {noun},,,,,');
  check('a grey with no neutral band is unnamed rather than red', bandOfColor(noNeutral, 0x808080) === null);
  check('...so its side gets no name at all', rollTeamName(noNeutral, { color: 0x808080, members: ['Phat Tony'] }) === '');
  check('...but a red side still does', rollTeamName(noNeutral, { color: 0xff4d4d, members: ['Phat Tony'] }) === 'Red Terrors');

  const { parts: empty } = table('noun,noun,Terrors,,,,,');
  check('a table with no colour rows has no band', bandOfColor(empty, 0xff0000) === null);
}

// ---------------------------------------------------------------------------
section('a band is a pool, not a word');
// ---------------------------------------------------------------------------
{
  const { parts } = table(
    'r1,colour,Crimson,,0,,,',
    'r2,colour,Scarlet,,0,,,',
    'b1,colour,Cobalt,,240,,,',
    'noun,noun,Terrors,,,,,',
    'shape,shape,{colour} {noun},,,,,',
  );
  check('every row at that hue is available', colourWords(parts, 0xff0000).map((w) => w.text).sort().join('/') === 'Crimson/Scarlet');
  check('...and no row from another band is', colourWords(parts, 0xff0000).every((w) => w.text !== 'Cobalt'));
  const drawn = new Set();
  for (let i = 0; i < 200; i++) drawn.add(rollTeamName(parts, { color: 0xff0000, members: ['Phat Tony'] }));
  check('both words in a band are actually drawn', drawn.size === 2, [...drawn].join(' / '));

  const { parts: weighted } = table(
    'r1,colour,Crimson,,0,,9,',
    'r2,colour,Scarlet,,0,,1,',
    'noun,noun,Terrors,,,,,',
    'shape,shape,{colour} {noun},,,,,',
  );
  let crimson = 0;
  for (let i = 0; i < 600; i++) if (rollTeamName(weighted, { color: 0xff0000, members: [] }).startsWith('Crimson')) crimson++;
  check('weight moves the odds inside a band', crimson > 450 && crimson < 590, `${crimson}/600`);
}

// ---------------------------------------------------------------------------
section('the seals lend their names');
// ---------------------------------------------------------------------------
{
  const { parts } = table(
    'red,colour,Red,,0,,,',
    'noun,noun,Terrors,,,,,',
    'poss,shape,{nickname}’s {noun},,,,,',
  );
  check('a shape can be named after a member', rollTeamName(parts, { color: 0xff0000, members: ['Phat Tony'] }) === 'Tony’s Terrors');
  check('a one-word member lends the whole word', rollTeamName(parts, { color: 0xff0000, members: ['Tony'] }) === 'Tony’s Terrors');
  check('a member shape with NO members is not drawn', rollTeamName(parts, { color: 0xff0000, members: [] }) === '');

  const { parts: adj } = table(
    'red,colour,Red,,0,,,',
    'noun,noun,Terrors,,,,,',
    'both,shape,{adjective} {nickname},,,,,',
  );
  const pairs = new Set();
  for (let i = 0; i < 300; i++) pairs.add(rollTeamName(adj, { color: 0xff0000, members: ['Phat Tony', 'Prickly Pete'] }));
  check('every member token in one name is the SAME seal', [...pairs].every((p) => p === 'Phat Tony' || p === 'Prickly Pete'), [...pairs].join(' / '));
  check('...and both members get a turn', pairs.size === 2);
  check('a side of one-word seals cannot fill {adjective}', rollTeamName(adj, { color: 0xff0000, members: ['Tony', 'Pete'] }) === '');

  const mixed = table(
    'red,colour,Red,,0,,,',
    'noun,noun,Terrors,,,,,',
    'plain,shape,{colour} {noun},,,,,',
    'both,shape,{adjective} {nickname},,,,,',
  ).parts;
  const out = new Set();
  for (let i = 0; i < 300; i++) out.add(rollTeamName(mixed, { color: 0xff0000, members: ['Tony'] }));
  check('an unfillable shape leaves the pool, it does not empty it', out.size === 1 && out.has('Red Terrors'), [...out].join(' / '));

  check('the default split takes the LAST word', JSON.stringify(splitLastWord('The One and Only Osbourne')) === '{"adjective":"The One and Only","nickname":"Osbourne"}');
  check('...and a one-word name is all nickname', JSON.stringify(splitLastWord('Tony')) === '{"adjective":"","nickname":"Tony"}');
  const { parts: split } = table('red,colour,Red,,0,,,', 'noun,noun,Terrors,,,,,', 'poss,shape,{nickname} {noun},,,,,');
  check('a caller’s own split is used', rollTeamName(split, {
    color: 0xff0000, members: ['The One and Only Osbourne'], split: () => ({ adjective: '', nickname: 'Ozzy' }),
  }) === 'Ozzy Terrors');
}

// ---------------------------------------------------------------------------
section('written names');
// ---------------------------------------------------------------------------
{
  const { parts } = table(
    'red,colour,Red,,0,,,',
    'noun,noun,Terrors,,,,,',
    'shape,shape,{colour} {noun},,,,,',
    'full,full,The Big Wet,,,,,',
  );
  check('a written name never appears at fullChance 0', (() => {
    for (let i = 0; i < 300; i++) if (rollTeamName(parts, { color: 0xff0000, members: [], fullChance: 0 }) === 'The Big Wet') return false;
    return true;
  })());
  check('...and is the only answer at 1', rollTeamName(parts, { color: 0xff0000, members: [], fullChance: 1 }) === 'The Big Wet');
  check('the default chance is under half', DEFAULT_FULL_CHANCE < 0.5, String(DEFAULT_FULL_CHANCE));

  const { parts: onlyFull } = table('full,full,The Big Wet,,,,,');
  check('a table of nothing but written names still names a side', rollTeamName(onlyFull, { color: 0xff0000, members: [], fullChance: 0 }) === 'The Big Wet');

  const long = 'Z'.repeat(MAX_TEAM_NAME_LEN + 1);
  const { parts: over, warns } = table(`full,full,${long},,,,,`);
  check('a written name too wide for the card is refused at parse', over.full.length === 0);
  check('...loudly', said(warns, 'room for'), warns.join(' | '));
}

// ---------------------------------------------------------------------------
section('a broken row is loud, not silent');
// ---------------------------------------------------------------------------
{
  const { parts, warns } = table('t,shape,{colour} {nikname},,,,,');
  check('a typo’d token takes the shape out', parts.shape.length === 0);
  check('...and names it', said(warns, 'nikname'), warns.join(' | '));

  const bad = table('s,shape,The Terrors,,,,,');
  check('a shape with no tokens at all is refused', bad.parts.shape.length === 0);
  check('...and is pointed at the full slot', said(bad.warns, 'full'), bad.warns.join(' | '));

  const slot = table('x,sound,Boom,,,,,');
  check('an unknown slot is ignored, loudly', slot.parts.colour.length === 0 && said(slot.warns, 'which is not one of'));

  const hue = table('c,colour,Red,,maroon,,,');
  check('a hue that is not a number falls back to neutral, loudly', hue.parts.colour[0]?.band === NEUTRAL_BAND && said(hue.warns, 'neither a number'));
  const wrap = table('c,colour,Red,,400,,,');
  check('a hue over 360 wraps rather than being refused', wrap.parts.colour[0]?.band === 40);

  const strayHue = table('n,noun,Terrors,,120,,,');
  check('a hue on a noun row is called out', said(strayHue.warns, 'only means anything on a colour row'));

  const dupBand = table('a,colour,Red,,0,,,', 'b,colour,Red,,240,,,');
  check('one word in two bands is called out', said(dupBand.warns, 'cannot name two colours'), dupBand.warns.join(' | '));
  const dupNoun = table('a,noun,Terrors,,,,,', 'b,noun,Terrors,,,,,');
  check('the same noun twice is called out', said(dupNoun.warns, 'twice as likely'));
  const sameBand = table('a,colour,Red,,0,,,', 'b,colour,Red,,0,,,');
  check('...and so is the same word twice in ONE band', said(sameBand.warns, 'twice as likely'));

  const off = table('a,colour,Red,,0,FALSE,,', 'b,colour,Scarlet,,0,,,', 'n,noun,Terrors,,,,,', 's,shape,{colour} {noun},,,,,');
  check('enabled=FALSE takes a row out of rotation', colourWords(off.parts, 0xff0000).map((w) => w.text).join('') === 'Scarlet');

  const nothing = table('n,noun,Terrors,,,,,');
  check('a table that can build nothing says so', said(nothing.warns, 'no colour rows'), nothing.warns.join(' | '));
  const noShape = table('c,colour,Red,,0,,,', 'n,noun,Terrors,,,,,');
  check('...and so does one with words but no shapes', said(noShape.warns, 'no shape rows'));
  check('a side of a broken table is unnamed, not "undefined"', rollTeamName(noShape.parts, { color: 0xff0000, members: ['Phat Tony'] }) === '');
}

// ---------------------------------------------------------------------------
section('two sides, two names');
// ---------------------------------------------------------------------------
{
  const { parts } = table(
    'red,colour,Red,,0,,,',
    'blue,colour,Blue,,240,,,',
    'noun,noun,Terrors,,,,,',
    'shape,shape,{colour} {noun},,,,,',
    'full,full,The Big Wet,,,,,',
  );
  // Both sides handed the SAME written name is the reachable collision — a
  // full name says nothing about the kit, so the colours cannot separate them.
  //
  // DRIVEN ON A SCRIPTED RANDOM rather than on odds: the redraw is ONE extra
  // draw (the same contract sealNames' `avoid` has), so a pair of runs proves
  // it and a thousand runs of real randomness would only measure it.
  const { parts: two } = table('a,full,The Big Wet,,,,,', 'b,full,The Deep End,,,,,');
  const scripted = (...seq) => { let i = 0; return () => seq[i++ % seq.length]; };
  // Per draw: the fullChance roll, then the weighted pick — under .5 is the
  // first written row, over it the second.
  check('without avoid, the same numbers give the same name',
    rollTeamName(two, { color: 0xff0000, members: [], fullChance: 1 }, scripted(0.1, 0.2)) === 'The Big Wet');
  check('a name that would repeat the other side redraws',
    rollTeamName(two, { color: 0xff0000, members: [], fullChance: 1, avoid: 'The Big Wet' }, scripted(0.1, 0.2, 0.1, 0.9)) === 'The Deep End');

  let same = 0;
  for (let i = 0; i < 400; i++) {
    const a = rollTeamName(parts, { color: 0xff0000, members: ['Phat Tony'] });
    const b = rollTeamName(parts, { color: 0x0000ff, members: ['Prickly Pete'], avoid: a });
    if (a === b) same++;
  }
  check('two sides are practically never called the same thing', same < 12, `${same}/400`);
}

// ---------------------------------------------------------------------------
section('the shipped table');
// ---------------------------------------------------------------------------
{
  const here = dirname(fileURLToPath(import.meta.url));
  const csv = readFileSync(resolve(here, '../path/src/teamNames.csv'), 'utf8');
  const warns = [];
  const parts = parseTeamNameCsv(csv, (m) => warns.push(String(m)));
  check('teamNames.csv parses with no rows dropped and nothing to say', warns.length === 0, warns.join(' | '));
  check('every slot has rows in it', TEAM_NAME_SLOTS.every((s) => parts[s].length > 0),
    TEAM_NAME_SLOTS.map((s) => `${s} ${parts[s].length}`).join(', '));

  // EVERY WHEEL SWATCH MUST LAND ON A WORD. A kit colour a captain can pick
  // and the table cannot name is a side that plays the whole match unnamed,
  // and it is invisible until somebody picks that one swatch.
  const { CONFIG } = await import('../path/src/config.js');
  const wheel = CONFIG.versus?.wheel ?? [];
  check('the wheel has swatches to check', wheel.length > 0, `${wheel.length}`);
  const unnamed = wheel.filter((hex) => !colourWords(parts, hex).length);
  check('every swatch on the wheel has a colour word', unnamed.length === 0,
    unnamed.map((h) => '#' + h.toString(16)).join(' '));
  const bands = new Set(wheel.map((hex) => String(bandOfColor(parts, hex))));
  check('...and no two swatches share a band', bands.size === wheel.length,
    `${bands.size} bands for ${wheel.length} swatches`);

  // The defaults in CONFIG.versus.teams are what an unpicked side plays in.
  for (const [i, t] of (CONFIG.versus?.teams ?? []).entries()) {
    check(`the default kit for side ${i} has a colour word`, colourWords(parts, t.color).length > 0, '#' + (t.color >>> 0).toString(16));
  }

  // Every shape the file ships must be fillable by a REAL roster — one-word
  // names included, which is what the player field can hold.
  for (const shape of parts.shape) {
    const tokens = [...shape.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    check(`shape "${shape.id}" spends only real tokens`, tokens.every((t) => TEAM_TOKENS.includes(t)), tokens.join(','));
  }

  let longest = '';
  for (let i = 0; i < 2000; i++) {
    const name = rollTeamName(parts, { color: wheel[i % wheel.length], members: ['Phat Tony', 'Prickly Pete'] });
    if (!name) { check('every roll off the shipped table names the side', false, `blank at #${wheel[i % wheel.length].toString(16)}`); break; }
    if (name.length > longest.length) longest = name;
    if (i === 1999) check('every roll off the shipped table names the side', true);
  }
  check('...and fits the card', longest.length <= MAX_TEAM_NAME_LEN, `"${longest}" is ${longest.length}`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
