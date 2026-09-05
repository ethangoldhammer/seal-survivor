#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:unlocks
//
// THE GATE between a thing being in the game and a thing being OFFERED — the
// switch that is off in a dev build and on in a public one, and the ledger of
// what a player has earned across every run. Every failure here is silent in
// play: a card simply is not dealt, a hat simply is not in the drawer, and
// both look exactly like a roll that did not come up.
//
//   THE SWITCH     off, nothing is withheld, whatever the ledger says. On, a
//                  gated thing is withheld until its stat is met, and a thing
//                  with no row is never touched.
//   THE TABLE      every row's target must exist, its kind must be one of the
//                  two rosters, and a bad row is dropped rather than left to
//                  gate a door that isn't there.
//   THE LEDGER     one short of the count is locked, the count is open, and
//                  the call that crosses the line says so — once. It survives
//                  a reload, and an earned gate stays earned when its count
//                  is raised later.
//   THE TWO DOORS  accessoryUnlocked / accessoryRoster (the drawer) and
//                  availableUpgrades (the hand) both go through the same
//                  question, so they cannot disagree.
//   THE WIRING     main.js records a hull going up and a boss going down.
//                  Checked at the source, the same way the drawer test checks
//                  mainMenu.js — that file cannot run headless.
// ---------------------------------------------------------------------------

// A storage the ledger can write to, before anything imports the config.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

import './dom-stub.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const { CONFIG } = await import('../path/src/config.js');
const { parseUnlockCsv, buildUnlocks, GATE_KINDS } = await import('../path/src/unlockTable.js');
const unlocks = await import('../path/src/systems/unlocks.js');
const {
  STATS, GATE_DEFAULT, unlockGates, rebuildUnlockGates, setUnlockGate, unlockGateOn,
  loadUnlocks, resetUnlocks, unlockStats, recordUnlockStat, recordBoatDestroyed,
  recordBossDefeated, unlockGranted, unlockProgress,
} = unlocks;
const { accessoryUnlocked, accessoryRoster, wornAccessory } = await import('../path/src/systems/accessories.js');
const { player, availableUpgrades } = await import('../path/src/entities/player.js');

const quiet = () => {};
const warnings = [];
const collect = (m) => warnings.push(String(m));

// ---------------------------------------------------------------------------
section('THE TABLE (unlocks.csv)');
const csv = readFileSync(resolve(ROOT, 'path/src/unlocks.csv'), 'utf8');
const rows = parseUnlockCsv(csv, collect);
const accessoryKeys = Object.keys(CONFIG.accessories.items);
const upgradeIds = CONFIG.upgrades.map((u) => u.id);
warnings.length = 0;
const gates = buildUnlocks(rows, { accessory: accessoryKeys, upgrade: upgradeIds }, collect, STATS);
check('every row builds', gates.length === rows.size, `${gates.length} of ${rows.size}`);
check('...without a warning', warnings.length === 0, warnings.join(' | '));
for (const g of gates) {
  const roster = g.kind === 'accessory' ? accessoryKeys : upgradeIds;
  check(`${g.id} gates a real ${g.kind}`, roster.includes(g.target), g.target);
  check(`${g.id} waits on a counted stat`, STATS.includes(g.stat)
    || STATS.some((s) => s.endsWith('.') && g.stat.startsWith(s)), g.stat);
  check(`${g.id} needs at least one`, Number.isInteger(g.count) && g.count >= 1, String(g.count));
}
const hat = gates.find((g) => g.id === 'sailorHat');
const eyes = gates.find((g) => g.id === 'laserEyes');
check('the example: the sailor hat is 50 boats', hat?.kind === 'accessory' && hat.target === 'accessoryHat'
  && hat.stat === 'boatsDestroyed' && hat.count === 50);
check('the example: laser eyes is one eyebeam boss', eyes?.kind === 'upgrade' && eyes.target === 'laserEyes'
  && eyes.stat === 'perk.eyebeam' && eyes.count === 1);
const glasses = gates.find((g) => g.id === 'dealWithIt');
check('the example: the glasses are one boss, any boss', glasses?.kind === 'accessory' && glasses.target === 'accessoryGlasses'
  && glasses.stat === 'bossesDefeated' && glasses.count === 1);
check('the live list is the same table', unlockGates().map((g) => g.id).join() === gates.map((g) => g.id).join());

section('THE PARSER');
const bad = parseUnlockCsv([
  'id,kind,target,stat,count,label,enabled',
  'noKind,shop,accessoryHat,boatsDestroyed,5,,',
  'noTarget,accessory,accessoryNothing,boatsDestroyed,5,,',
  'noStat,upgrade,laserEyes,,5,,',
  'badCount,upgrade,laserEyes,boatsDestroyed,lots,,',
  'blankCount,upgrade,laserEyes,boatsDestroyed,,,',
  'off,upgrade,rapidFire,boatsDestroyed,5,,FALSE',
  'unknownStat,upgrade,rapidFire,thingsNobodyCounts,5,,',
].join('\n'), quiet);
warnings.length = 0;
const built = buildUnlocks(bad, { accessory: accessoryKeys, upgrade: upgradeIds }, collect, STATS);
const ids = built.map((g) => g.id);
check('kinds are exactly the two rosters', GATE_KINDS.join() === 'accessory,upgrade');
check('an unknown kind is dropped', !ids.includes('noKind'));
check('a target nothing declares is dropped', !ids.includes('noTarget'));
check('a row with no stat is dropped', !ids.includes('noStat'));
check('an unreadable count reads as once', built.find((g) => g.id === 'badCount')?.count === 1);
check('a blank count reads as once', built.find((g) => g.id === 'blankCount')?.count === 1);
check('enabled=FALSE takes the gate out', !ids.includes('off'));
check('a stat nothing counts is KEPT (a visible locked door)...', ids.includes('unknownStat'));
check('...and warned about', warnings.some((w) => w.includes('thingsNobodyCounts') && w.includes('never open')));
check('every drop was warned about', ['noKind', 'noTarget', 'noStat'].every((id) => warnings.some((w) => w.includes(`"${id}"`))));

// ---------------------------------------------------------------------------
section('THE SWITCH');
resetUnlocks();
check('the default is the private build — gate off', GATE_DEFAULT === false && unlockGateOn() === false);
check('gate off: the hat is wearable with zero boats', accessoryUnlocked('accessoryHat'));
check('gate off: the hat is in the drawer', accessoryRoster(true).includes('accessoryHat'));
player.upgrades.length = 0;
check('gate off: laser eyes is in the hand', availableUpgrades().some((u) => u.id === 'laserEyes'));

setUnlockGate(true);
check('gate on: the hat is withheld', !accessoryUnlocked('accessoryHat'));
check('gate on: ...and out of the drawer', !accessoryRoster(true).includes('accessoryHat'));
check('gate on: ...but still in the tools\' roster', accessoryRoster(false).includes('accessoryHat'));
check('gate on: laser eyes is not dealt', !availableUpgrades().some((u) => u.id === 'laserEyes'));
check('gate on: the glasses are withheld too', !accessoryUnlocked('accessoryGlasses'));
check('gate on: a thing with no row is untouched (bowler)', accessoryUnlocked('accessoryBowler'));
CONFIG.accessories.equipped = 'accessoryGlasses';
check('gate on: the default slot holds the glasses, but the seal is bare', wornAccessory() === '');
check('gate on: a card with no row is untouched (rapidFire)', availableUpgrades().some((u) => u.id === 'rapidFire'));
check('the hand lock still holds on its own', (() => {
  CONFIG.accessories.items.accessoryGlasses.unlocked = false;
  const r = !accessoryUnlocked('accessoryGlasses');
  CONFIG.accessories.items.accessoryGlasses.unlocked = true;
  return r;
})());

// ---------------------------------------------------------------------------
section('THE LEDGER');
let opened = [];
for (let i = 0; i < 49; i++) opened.push(...recordBoatDestroyed({ isTrawler: false }));
check('49 boats: nothing opens', opened.length === 0);
check('49 boats: the hat is still withheld', !accessoryUnlocked('accessoryHat'));
let p = unlockProgress('sailorHat');
check('progress reads 49 of 50', p?.have === 49 && p.need === 50 && p.done === false);
opened = recordBoatDestroyed({ isTrawler: true });
check('the 50th hull opens the hat, and says so', opened.length === 1 && opened[0] === 'sailorHat', opened.join());
check('the trawler counted twice — once as a hull, once as a trawler', unlockStats().boatsDestroyed === 50
  && unlockStats().trawlersDestroyed === 1);
check('the hat is wearable', accessoryUnlocked('accessoryHat'));
check('...and back in the drawer', accessoryRoster(true).includes('accessoryHat'));
check('the 51st says nothing', recordBoatDestroyed({}).length === 0);
check('an unknown gate id reads null', unlockProgress('nope') === null);

opened = recordBossDefeated('bossShark', 'lunge');
check('a lunging shark does not open laser eyes', !opened.includes('laserEyes') && !availableUpgrades().some((u) => u.id === 'laserEyes'));
check('...but it is a boss, so it opens the glasses', opened.includes('dealWithIt') && accessoryUnlocked('accessoryGlasses'));
check('...and the slot it already held goes on without a re-equip', wornAccessory() === 'accessoryGlasses');
check('...but counted as a boss, and as that boss', unlockStats().bossesDefeated === 1 && unlockStats()['boss.bossShark'] === 1);
opened = recordBossDefeated('bossCrab', 'eyebeam');
check('an eyebeam boss opens laser eyes', opened.includes('laserEyes'), opened.join());
check('...and the card is dealt', availableUpgrades().some((u) => u.id === 'laserEyes'));
check('a perkless boss records no perk', (() => {
  const before = Object.keys(unlockStats()).length;
  recordBossDefeated('bossOrca', null);
  return Object.keys(unlockStats()).length === before + 1; // boss.bossOrca only
})());
check('a zero or empty record is a no-op', recordUnlockStat('', 1).length === 0 && recordUnlockStat('boatsDestroyed', 0).length === 0
  && unlockStats().boatsDestroyed === 51);

section('IT SURVIVES A RELOAD');
const saved = store.get('sealSurvivor.unlocks');
check('the ledger was written', typeof saved === 'string' && saved.includes('"sailorHat":true'));
loadUnlocks();
check('read back: the hat is still earned', accessoryUnlocked('accessoryHat') && unlockStats().boatsDestroyed === 51);
store.set('sealSurvivor.unlocks', '{not json');
loadUnlocks();
check('unreadable storage starts fresh rather than throwing', !accessoryUnlocked('accessoryHat') && unlockStats().boatsDestroyed == null);
store.set('sealSurvivor.unlocks', JSON.stringify({ v: 1, stats: { boatsDestroyed: -3, bossesDefeated: 2.7 }, unlocked: { sailorHat: 'yes' } }));
loadUnlocks();
check('a mangled ledger is coerced: negatives dropped, floats floored, non-true forgotten',
  unlockStats().boatsDestroyed == null && unlockStats().bossesDefeated === 2 && !accessoryUnlocked('accessoryHat'));

section('AN EARNED GATE STAYS EARNED');
resetUnlocks();
for (let i = 0; i < 50; i++) recordBoatDestroyed({});
check('earned at 50', accessoryUnlocked('accessoryHat'));
const raised = parseUnlockCsv(csv.replace('boatsDestroyed,50', 'boatsDestroyed,500'), quiet);
rebuildUnlockGates(raised);
check('the count raised to 500 afterwards: still earned', accessoryUnlocked('accessoryHat') && unlockProgress('sailorHat').need === 500);
rebuildUnlockGates();
check('the table rebuilt from the file reads 50 again', unlockProgress('sailorHat').need === 50);

section('GATE OFF WINS OVER THE LEDGER');
resetUnlocks();
setUnlockGate(false);
check('nothing earned, gate off: the hat is wearable', accessoryUnlocked('accessoryHat'));
check('...and laser eyes is dealt', availableUpgrades().some((u) => u.id === 'laserEyes'));
check('the ledger still counts in a dev build', recordBoatDestroyed({}).length === 0 && unlockStats().boatsDestroyed === 1);

// ---------------------------------------------------------------------------
section('THE WIRING (source level — main.js cannot run headless)');
const main = readFileSync(resolve(ROOT, 'path/src/main.js'), 'utf8');
const boatHook = main.slice(main.indexOf('function onBoatDestroyed('));
check('main.js imports both recorders', /import \{[^}]*recordBoatDestroyed[^}]*recordBossDefeated[^}]*\} from '\.\/systems\/unlocks\.js'/.test(main));
check('a hull going up is recorded in onBoatDestroyed', boatHook.slice(0, boatHook.indexOf('\n}')).includes('recordBoatDestroyed(boat)'));
const shot = main.slice(main.indexOf('function updateBossShot('));
check('a boss going down is recorded on the gained edge, with its archetype and perk',
  /if \(gained\) recordBossDefeated\(bossState\.archetype, bossState\.perk\?\.id/.test(shot.slice(0, shot.indexOf('\n}'))));
const acc = readFileSync(resolve(ROOT, 'path/src/systems/accessories.js'), 'utf8');
check('the drawer roster and the slot ask the same function', /filter\(\(k\) => !onlyUnlocked \|\| accessoryUnlocked\(k\)\)/.test(acc));
const pl = readFileSync(resolve(ROOT, 'path/src/entities/player.js'), 'utf8');
check('the offer pool asks unlockGranted', /unlockGranted\('upgrade', u\.id\)/.test(pl));
check('the mesh goes on what is WORN, not what is in the slot', /wornAccessory\(\) === key && body/.test(acc));

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
