#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:updebug
//
// The grant-any-upgrade panel (U), driven through its own buttons against a
// DOM stub.
//
// What is worth testing here is NOT the panel — it is that a granted upgrade is
// indistinguishable from a picked one. A debug tool that produces a state the
// real game cannot reach is worse than no tool, because everything you then
// conclude about the upgrade is about the tool. So: the tier has to ride along
// with the pick the way a card's does, the stat block has to be the one
// recomputeStats() would rebuild, the element has to commit before the first
// stack scales it, and taking a stack back has to land on exactly the numbers
// you started from rather than approximately.
//
// The cap is checked from the other side: the panel must NOT walk an upgrade
// past its maxStacks, because those stacks index tables sized to the cap and
// would report numbers no run can produce.
//
//   node --import ./tools/vite-loader.mjs tools/upgrade-debug-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// --- a DOM just rich enough for one panel ----------------------------------
//
// Clicks are the point: the exported grantUpgrade() would be easy to test on
// its own, and testing only that would leave the buttons — which are what a
// person actually uses — unproven. So every listener is kept and every node
// knows its children.

function makeEl() {
  const node = {
    style: {},
    dataset: {},
    children: [],
    listeners: {},
    _text: '',
    get textContent() { return this._text; },
    // Assigning '' is how the panel clears a list before rebuilding it, so the
    // stub has to drop the children too — otherwise every render appends and
    // the second one finds two of every row.
    set textContent(v) { this._text = String(v); if (v === '') this.children.length = 0; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    insertBefore(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of this.listeners.click ?? []) fn({}); },
  };
  return node;
}
globalThis.document = { createElement: makeEl, createElementNS: makeEl, body: makeEl() };

const keyHandlers = [];
globalThis.window.addEventListener = (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); };
globalThis.window.removeEventListener = () => {};
const pressKey = (key, target = null) => {
  for (const fn of keyHandlers) fn({ key, target, repeat: false });
};

// Depth-first walk, because the panel's tree is rows inside a list inside a
// panel and a test that reached in by index would break on any layout change.
function walk(node, fn) {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}
function findAll(pred) {
  const out = [];
  walk(document.body, (n) => { if (pred(n)) out.push(n); });
  return out;
}
function rowFor(id) {
  return findAll((n) => n.dataset?.upgrade === id)[0] ?? null;
}
function buttonIn(row, label) {
  let hit = null;
  walk(row, (n) => { if (!hit && n.listeners?.click?.length && n.textContent === label) hit = n; });
  return hit;
}
function chipNamed(label) {
  return findAll((n) => n.dataset?.chip === label)[0] ?? null;
}

const { CONFIG } = await import('../path/src/config.js');
const { player, recomputeStats } = await import('../path/src/entities/player.js');
const { activeElement, resetElements } = await import('../path/src/systems/elements.js');
const { rarityMul } = await import('../path/src/systems/rarity.js');
const {
  initUpgradeDebug, setUpgradeDebugVisible, setUpgradeDebugChoice,
  upgradeDebugState, grantUpgrade,
} = await import('../path/src/ui/upgradeDebug.js');

// The boot order the game uses: a stat block exists before anything grants.
recomputeStats();
initUpgradeDebug(() => 12.5);

const reset = () => {
  player.upgrades.length = 0;
  recomputeStats();
};

// ---------------------------------------------------------------------------
section('THE KEY');
// ---------------------------------------------------------------------------
check('starts hidden', upgradeDebugState().visible === false);
pressKey('u');
check('U opens it', upgradeDebugState().visible === true);
pressKey('u', { tagName: 'INPUT' });
check('U inside a text field is ignored', upgradeDebugState().visible === true,
  'typing a name on the game-over screen must not open panels');
pressKey('u');
check('U closes it', upgradeDebugState().visible === false);
setUpgradeDebugVisible(true);

// ---------------------------------------------------------------------------
section('GRANTING BY CLICK');
// ---------------------------------------------------------------------------
reset();
setUpgradeDebugChoice({ family: '(all)', rarity: 'common' });
const rapid = rowFor('rapidFire');
check('every upgrade in the table has a row', rapid != null,
  `${findAll((n) => n.dataset?.upgrade).length} rows for ${CONFIG.upgrades.length} upgrades`);

const beforeRate = player.stats.fireRate;
buttonIn(rapid, '+1').click();
check('the click grants the pick', player.upgrades.length === 1
  && player.upgrades[0].id === 'rapidFire');
check('the stat block moved', player.stats.fireRate < beforeRate,
  `${beforeRate.toFixed(3)} → ${player.stats.fireRate.toFixed(3)}`);
check('the panel says what moved', /fireRate/.test(upgradeDebugState().status),
  upgradeDebugState().status);

// The grant has to survive the rebuild — anything written straight onto
// player.stats would vanish here, which is the whole reason this goes through
// addUpgrade rather than poking the block.
const afterClick = player.stats.fireRate;
recomputeStats();
check('it survives a recompute', player.stats.fireRate === afterClick,
  'a hand-poked stat would be thrown away by the next level-up');

// ---------------------------------------------------------------------------
section('THE FAMILY FILTER');
// ---------------------------------------------------------------------------
const gunCount = CONFIG.upgrades.filter((u) => u.family === 'gun').length;
chipNamed('gun').click();
check('the list narrows to the family',
  findAll((n) => n.dataset?.upgrade).length === gunCount,
  `${findAll((n) => n.dataset?.upgrade).length} rows, ${gunCount} gun upgrades`);
// The chips are rebuilt every render for exactly this: one built at init keeps
// the highlight it was born with, and the row goes on showing the wrong pick.
check('the chosen chip is the lit one',
  chipNamed('gun').dataset.on === '1' && chipNamed('(all)').dataset.on === '');
chipNamed('(all)').click();
check('and back to everything',
  findAll((n) => n.dataset?.upgrade).length === CONFIG.upgrades.length);

// ---------------------------------------------------------------------------
section('THE TIER RIDES ALONG');
// ---------------------------------------------------------------------------
reset();
setUpgradeDebugChoice({ rarity: 'common' });
buttonIn(rowFor('heavyRounds'), '+1').click();
const commonDamage = player.stats.damage;

reset();
chipNamed('legendary').click(); // the tier chips are the panel's own control
check('the tier chip selects', upgradeDebugState().rarity === 'legendary');
buttonIn(rowFor('heavyRounds'), '+1').click();
check('the pick carries the tier it was granted at',
  player.upgrades[0].rarity === 'legendary', JSON.stringify(player.upgrades[0]));
check('a legendary grant is worth more than a common one',
  player.stats.damage > commonDamage,
  `${commonDamage.toFixed(2)} vs ${player.stats.damage.toFixed(2)} (statMul ${rarityMul('legendary')})`);

// ---------------------------------------------------------------------------
section('THE CAP');
// ---------------------------------------------------------------------------
reset();
setUpgradeDebugChoice({ rarity: 'common' });
// Whichever upgrade is capped lowest today. Named ids drift — the caps live in
// upgrades.csv and are edited constantly — and the contract being checked is
// about `maxStacks`, not about any one card.
const capped = CONFIG.upgrades
  .filter((u) => Number.isFinite(u.maxStacks))
  .sort((a, b) => a.maxStacks - b.maxStacks)[0];
for (let i = 0; i < capped.maxStacks + 3; i++) buttonIn(rowFor(capped.id), '+1')?.click();
check(`stops '${capped.id}' at maxStacks`, player.upgrades.length === capped.maxStacks,
  `${player.upgrades.length} of ${capped.maxStacks}`);
check('the button says so once full', buttonIn(rowFor(capped.id), 'max') != null,
  'clicking past the cap would report numbers no run can produce');

// ---------------------------------------------------------------------------
section('TAKING ONE BACK');
// ---------------------------------------------------------------------------
reset();
const base = { ...player.stats };
buttonIn(rowFor('vitality'), '+1').click();
const grown = player.stats.maxHp;
buttonIn(rowFor('vitality'), '−').click();
check('the minus removes the stack', player.upgrades.length === 0);
const drift = Object.keys(base).filter((k) => typeof base[k] === 'number' && base[k] !== player.stats[k]);
check('the stat block lands exactly where it started', drift.length === 0,
  drift.length ? drift.join(', ') : `maxHp went ${base.maxHp} → ${grown} → ${player.stats.maxHp}`);

// ---------------------------------------------------------------------------
section('THE ELEMENT PICKER');
// ---------------------------------------------------------------------------
reset();
resetElements(null);
const glowUp = CONFIG.upgrades.find((u) => u.roll === 'biolumElement');
check('there is a rolled upgrade to pick for', glowUp != null);
setUpgradeDebugChoice({ element: 'venom' });
grantUpgrade(glowUp.id, { rarity: 'common', element: 'venom' });
check('the chosen element is committed, not rolled', activeElement() === 'venom', activeElement());
setUpgradeDebugVisible(true); // re-render now that the run has an element
check('the picker locks once the run has one',
  chipNamed('shock') == null && /locked/.test(findAll((n) => /locked/.test(n.textContent ?? ''))[0]?.textContent ?? ''),
  'commitElement is one-way, so a live picker there would silently do nothing');
resetElements(null);

// ---------------------------------------------------------------------------
section('THE UNDEALABLE ONES');
// ---------------------------------------------------------------------------
// The reason the panel exists. `enabled: FALSE` removes an upgrade from the
// offer pool entirely — there is no way to see it in the water otherwise.
reset();
const disabled = CONFIG.upgrades.find((u) => u.enabled === false);
if (disabled) {
  const row = rowFor(disabled.id);
  check(`'${disabled.id}' is listed even though it is never dealt`, row != null);
  buttonIn(row, '+1')?.click();
  check('and it can be granted', player.upgrades.some((p) => p.id === disabled.id));
} else {
  check('no disabled upgrades in the table right now', true, 'nothing to check');
}

// ---------------------------------------------------------------------------
section('CLEAR ALL');
// ---------------------------------------------------------------------------
reset();
const baseline = { ...player.stats };
grantUpgrade('rapidFire', { rarity: 'epic' });
grantUpgrade('magnet', { rarity: 'rare' });
const clear = findAll((n) => n.textContent === 'Clear all')[0];
clear.click();
check('clears every pick', player.upgrades.length === 0);
const left = Object.keys(baseline).filter((k) => typeof baseline[k] === 'number' && baseline[k] !== player.stats[k]);
check('and the stat block with them', left.length === 0, left.join(', '));

reset();
resetElements(null);

console.log(`\n${failures ? `${failures} FAILED` : 'all good'}`);
process.exit(failures ? 1 : 0);
