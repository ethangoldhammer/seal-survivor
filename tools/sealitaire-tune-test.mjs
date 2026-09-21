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

console.log('sealitaire tune: 11 checks passed');
