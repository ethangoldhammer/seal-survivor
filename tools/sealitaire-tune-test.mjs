#!/usr/bin/env node
// The TANKS-SAVE write-back: one row of tanks.csv changes and nothing else
// in the file does — not the header, not another row's quoted notes, not
// the flip cell of the row itself.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTankSave, TANK_FIELDS } from './sealitaire-tune.mjs';

const text = [
  'card,model,flip,count,size,back,belly,bg,colGap,rowGap,padX,padY,notes',
  '2 fish,sardine,,2,1,#336B99,#F0F7FA,#767C82,,,,,"the school, with a comma and ""quotes"" in the notes"',
  'Q star,furseal,1,1,1.4,#4E3A2A,#B69A7C,#767C82,,,0.2,,',
  'K shell,octopus_rig,,1,1.4,#7A3E5A,#E4B8C8,#767C82,,,,,court',
  '',
].join('\n');

const next = applyTankSave(text, { card: 'Q:star', model: 'orca_male', count: '1', size: '1.6', back: '#151A22', belly: '#F2F2F0', bg: '#767C82' });
assert.ok(next, 'a changed row writes');
const lines = next.split('\n');
assert.equal(lines[0], 'card,model,flip,count,size,back,belly,bg,colGap,rowGap,padX,padY,notes', 'the header is untouched');
assert.equal(lines[1], text.split('\n')[1], 'a row with quoted notes passes through byte for byte');
assert.equal(lines[2], 'Q star,orca_male,1,1,1.6,#151A22,#F2F2F0,#767C82,,,0.2,,', 'the named row takes the fields and keeps its flip and its own padX');
assert.equal(lines[3], text.split('\n')[3], 'the row after is untouched');
assert.equal(lines[4], '', 'the trailing newline survives');

assert.equal(applyTankSave(text, { card: 'Q:star', model: 'furseal', count: '1', size: '1.4', back: '#4E3A2A', belly: '#B69A7C', bg: '#767C82', padX: '0.2' }), null, 'an unchanged row is no write');
const blanked = applyTankSave(text, { card: 'Q:star', padX: '', colGap: '0.7' });
assert.equal(blanked.split('\n')[2], 'Q star,furseal,1,1,1.4,#4E3A2A,#B69A7C,#767C82,0.7,,,,', 'a blank field clears the cell (back to the tuner\'s global) and a set one lands');
assert.equal(applyTankSave(text, { card: '5:bubble', model: 'tang' }), null, 'a card with no row is no write');

const withComma = applyTankSave(text, { card: 'K:shell', model: 'a,b' });
assert.ok(withComma.includes('"a,b"'), 'a cell that needs quoting gets it');

// The three axes and the glow land too — and every panel-writable column of
// the REAL tanks.csv is in the tool's list, so a slider added to the panel
// cannot save into nothing.
const axes = applyTankSave(text.replace('padY,notes', 'padY,drop,rotate,rotateVary,yaw,roll,sway,loop,bio,bioColor,notes').replace(/,court$/m, ',,,,,,,,,,court'), { card: 'K:shell', rotate: '0.3', yaw: '-0.5', roll: '1.2', sway: '0', loop: '1', bio: '0.8', bioColor: '#66FFE0' });
assert.ok(axes && axes.includes('K shell,octopus_rig,,1,1.4,#7A3E5A,#E4B8C8,#767C82,,,,,,0.3,,-0.5,1.2,0,1,0.8,#66FFE0,court'), 'rotate, the two new axes, sway, loop and the glow all write');
const realHead = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../rive/sealitaire/tanks.csv'), 'utf8').split('\n')[0].split(',');
for (const key of TANK_FIELDS) assert.ok(realHead.includes(key), `tanks.csv has a ${key} column`);
for (const col of realHead) if (!['card', 'flip', 'knock', 'clip', 'notes'].includes(col)) assert.ok(TANK_FIELDS.includes(col), `${col} is saveable from the panel`);

// ---------------------------------------------------------------------------
// THE TABLE ITSELF: a number card's pips read CENTRED.
//
// 2-10 are the pip layout made of fish — the count IS the number — so the
// formation belongs in the middle of the card the way a printed pip block
// does. `drop` biases it DOWN, which is framing for a lone creature (an ace
// or a court card) and is simply off-centre on a number.
//
// This exists because fourteen number cards carried one. `drop` used to
// clamp PER SEAT, so a big value parked the bottom row and squashed the rows
// above onto it — it read as "tighten the number", and it was tuned that way
// by eye. Fixing the clamp (it biases the whole formation now and stops as
// one) turned every one of those into a number shoved against the bottom
// edge with a gap above it. Nothing could see that but a person looking at
// the table, so it is checked here: `rowGap` is how a number is tightened.
{
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../rive/sealitaire/tanks.csv'), 'utf8');
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  const at = { card: head.indexOf('card'), drop: head.indexOf('drop') };
  const dropped = lines.slice(1)
    .map((l) => l.split(','))
    .filter((c) => !['A', 'J', 'Q', 'K'].includes((c[at.card] || '').split(' ')[0]))
    .filter((c) => (c[at.drop] || '').trim())
    .map((c) => `${c[at.card]} (drop ${c[at.drop].trim()})`);
  // REPORTED, NOT FAILED. It was an assertion for about an hour, and in that
  // hour Ethan set seven new drops from the live tuner — which is the answer
  // to the question the gate was asking. Now that drop biases the whole
  // formation as one (it used to squash it), an off-centre number is a look
  // somebody can want, so this says what it sees and gets out of the way.
  // What it is still worth saying: the fourteen it found the first time were
  // STALE, tuned against the squash, and every one of them read as a number
  // shoved against the bottom edge.
  if (dropped.length) {
    console.log(`  --   ${dropped.length} number card(s) sit off-centre by a drop: ${dropped.join(', ')}`);
    console.log('       (deliberate is fine — drop moves the whole formation now. rowGap is what tightens one.)');
  }
}

console.log('sealitaire tune: 11 checks passed');
