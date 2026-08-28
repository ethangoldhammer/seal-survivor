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
    // Real methods the panel calls on a real input. A stub that omitted them
    // fails loudly here, which is the right direction — the dangerous stub is
    // the one that INVENTS a field and lets a bug through.
    focus() {}, blur() {}, select() {},
  };
  return node;
}
// `canvas` is handed back to dom-stub's own element. Everything else here is a
// bag of children that remembers its listeners, which dom-stub's is not — but
// three.js asks for a canvas by name during a spawn, and a canvas that is a bag
// of children throws from inside the renderer rather than from anything this
// file wrote. Keeping both is what lets the creature spawner below run against
// a real THREE.Scene in the same process as the panel.
const stubCreate = globalThis.document.createElement.bind(globalThis.document);
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? stubCreate(tag) : makeEl()),
  createElementNS: makeEl,
  body: makeEl(),
};

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
  upgradeDebugState, grantUpgrade, spawnCreature,
} = await import('../path/src/ui/upgradeDebug.js');

// The search field, driven through its own listener rather than through the
// setter seam — the seam proves the filter and this proves the wiring, and the
// bug that eats a search box is always in the wiring. `type` is a plain
// property on the stub, so the field is found by its data attribute the same
// way every other control in here is.
function searchField() {
  return findAll((n) => n.dataset?.search === '1')[0] ?? null;
}
function typeSearch(text) {
  const f = searchField();
  f.value = text;
  for (const fn of f.listeners.input ?? []) fn({});
}
const { bossArchetypes } = await import('../path/src/systems/boss.js');

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
section('THE SEARCH BOX');
// ---------------------------------------------------------------------------
// Six family chips over fifty-odd upgrades is coarse, and the box is what makes
// the panel usable for "where is that one". Four things, and three of them fail
// by rendering something plausible.
reset();
setUpgradeDebugChoice({ family: '(all)', rarity: 'common', search: '' });
const total = CONFIG.upgrades.length;
const rowCount = () => findAll((n) => n.dataset?.upgrade).length;

check('the field exists', searchField() != null);

typeSearch('laser');
check('typing filters the list', rowCount() > 0 && rowCount() < total,
  `${rowCount()} of ${total} for "laser"`);
check('...and the typed value is what the panel filters on',
  upgradeDebugState().search === 'laser');
check('the header says how many are hidden',
  /\d+ of \d+ shown/.test(findAll((n) => n._text && / of \d+ shown/.test(n._text))[0]?.textContent ?? ''),
  'a narrowed list otherwise looks exactly like a short table');

// THE ID, NOT JUST THE NAME. This is the whole reason the haystack is more than
// `name`: a staged upgrade arrives as lorem (CLAUDE.md), so the name is
// deliberately not the thing anyone would type. Searching the id has to find it
// or a half-built card is unreachable in the one panel built to reach it.
const staged = CONFIG.upgrades.find((u) => /lorem|ipsum/i.test(u.name ?? ''));
if (staged) {
  typeSearch(staged.id);
  check('an id finds a card whose name is still lorem',
    rowFor(staged.id) != null && rowCount() === 1,
    `"${staged.id}" → ${rowCount()} row(s), name is "${staged.name}"`);
} else {
  check('an id finds its row', (typeSearch('rapidFire'), rowFor('rapidFire') != null));
}

// EVERY TERM HAS TO HIT. Two words must narrow, not widen — a naive includes()
// on the joined string does the opposite and looks fine on one word.
// Derived from the table, not guessed at: a hand-picked pair like "laser eyes"
// happens to match one upgrade either way, so it passes under the naive
// implementation too and proves nothing. A family name matches many rows and a
// member's id matches one, so this pair discriminates by construction.
const wide = [...new Set(CONFIG.upgrades.map((u) => u.family).filter(Boolean))]
  .find((f) => CONFIG.upgrades.filter((u) => u.family === f).length > 1);
const member = CONFIG.upgrades.find((u) => u.family === wide);
typeSearch(wide);
const oneTerm = rowCount();
typeSearch(`${wide} ${member.id}`);
check('a second term narrows rather than widens', rowCount() < oneTerm && rowCount() > 0,
  `${oneTerm} for "${wide}", ${rowCount()} for "${wide} ${member.id}"`);

// AN EMPTY LIST HAS TO SAY SO, or a typo reads as an upgrade missing from the
// table and the panel looks broken.
typeSearch('zzzznothing');
check('no matches is a message, not a blank panel',
  rowCount() === 0 && findAll((n) => n.dataset?.empty === '1').length === 1);

// The box and the chip compose, both narrowing.
setUpgradeDebugChoice({ family: 'gun' });
typeSearch('laser');
check('the chip and the box both apply',
  findAll((n) => n.dataset?.upgrade).every((n) => {
    const def = CONFIG.upgrades.find((u) => u.id === n.dataset.upgrade);
    return def.family === 'gun';
  }));

// Clearing restores everything. Driven through the × the way a person would,
// because "the clear button is wired" is exactly the kind of thing that is
// never true and never noticed.
setUpgradeDebugChoice({ family: '(all)' });
const clearBtn = findAll((n) => n.textContent === '\u00d7' && n.listeners?.click?.length)[0];
check('the clear button exists', clearBtn != null);
clearBtn?.click();
check('clearing restores the whole table',
  rowCount() === total && upgradeDebugState().search === '',
  `${rowCount()} of ${total}`);

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
// THE PICKER IS A READOUT NOW. It used to steer a roll — one card that chose an
// element at draw time — and the panel needed a chip row to force which. There
// are four cards, so asking for an element means granting that card, the same
// door every other upgrade goes through.
const venomCard = CONFIG.upgrades.find((u) => u.element === 'venom');
check('there is a card for each element', venomCard != null);
grantUpgrade(venomCard.id, { rarity: 'common' });
check('granting the card carries its element', activeElement() === 'venom', activeElement());
setUpgradeDebugVisible(true); // re-render now that the run has an element
check('the panel reports which element the run is carrying',
  findAll((n) => /venom/.test(n.textContent ?? '')).length > 0,
  'the row says what is held; the other three are out of the pool');
check('...and offers no chips to change it',
  chipNamed('shock') == null,
  'a picker that silently did nothing is worse than no picker');
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
section('THE CREATURE PICKER');
// ---------------------------------------------------------------------------
// The roster half of the same door. What is worth checking without a scene is
// the OFFER — that the list is the spawnable roster and nothing else — because
// the failure mode here is silent in both directions: a creature missing from
// the list is one nobody looks at, and a BOSS in the list is a body that would
// arrive without its arrival, its bar or its name, and read as a bug in the
// boss rather than as a bug in this panel.
const offered = findAll((n) => n.dataset?.creature).map((n) => n.dataset.creature);
const bossBodies = bossArchetypes().map((b) => b.enemy);
const roster = Object.keys(CONFIG.enemies).filter((k) => !bossBodies.includes(k));
check('every spawnable creature is offered', offered.length === roster.length
  && roster.every((k) => offered.includes(k)),
  `${offered.length} of ${roster.length}`);
check('...and no boss body is', !offered.some((k) => bossBodies.includes(k)),
  offered.filter((k) => bossBodies.includes(k)).join(', ')
    || `${bossBodies.length} boss bodies held back for the block above`);

setUpgradeDebugChoice({ creature: 'shark', count: 1 });
chipNamed('6').click();
check('the count chip selects', upgradeDebugState().count === 6, `count ${upgradeDebugState().count}`);
check('...and the body picker holds what it was set to', upgradeDebugState().creature === 'shark');

// The panel is wired without a world here (initUpgradeDebug above takes only a
// clock), which is the same state it is in before main.js hands it the scene.
// Clicking then has to REPORT that rather than throw — a debug panel that dies
// on a click takes the run with it.
check('spawning with no scene returns null rather than throwing', spawnCreature('shark', 1) === null);
findAll((n) => n.textContent === 'Spawn creature')[0].click();
check('...and the button says why', /no scene/.test(upgradeDebugState().status),
  upgradeDebugState().status);

// ---------------------------------------------------------------------------
section('THE CREATURE SPAWNER — against a real scene');
// ---------------------------------------------------------------------------
// Now with a scene and a seal, because the half worth proving is the LAYOUT.
// The spawn itself is spawnNamed's, tested where the spawner is tested; what
// is this panel's own is where the bodies are put, and every one of those
// rules is a thing that reads as a bug in the creature rather than as a bug
// here: a shark in the air, a crab falling out of the sky, a row of twelve
// that spills out of the arena and gets dragged back into a heap.
const THREE = await import('three');
const { initPlayer, player: seal } = await import('../path/src/entities/player.js');
const { enemies, resetEnemies } = await import('../path/src/entities/enemies.js');
const { bounds } = await import('../path/src/arena.js');

const scene = new THREE.Scene();
initPlayer(scene);
const gameState = { difficulty: 20, level: 15 };
initUpgradeDebug(() => 12.5, () => ({ scene, gameState }));
setUpgradeDebugVisible(true);

seal.mesh.position.set(0, -20, 0);
resetEnemies(scene);
check('the button puts bodies in the water', (() => {
  setUpgradeDebugChoice({ creature: 'fish', count: 6 });
  findAll((n) => n.textContent === 'Spawn creature')[0].click();
  return enemies.length === 6;
})(), `${enemies.length} alive · ${upgradeDebugState().status}`);
check('...spread out rather than stacked on one spot',
  new Set(enemies.map((e) => e.mesh.position.x.toFixed(2))).size === enemies.length);
check('...clear of the seal',
  enemies.every((e) => e.mesh.position.y > seal.mesh.position.y),
  'a body spawned on the player is contact damage before you have looked at it');

// The caps are the thing you are trying to see past, so the door has to ignore
// them — this is the check that would fail if `ignoreCaps` were ever dropped.
resetEnemies(scene);
const sharkCap = CONFIG.spawn.groupMaxAlive?.shark ?? Infinity;
spawnCreature('shark', sharkCap + 3);
check('the family cap does not apply to a hand-placed spawn',
  enemies.length === sharkCap + 3, `${enemies.length} sharks against a cap of ${sharkCap}`);

check('...and a row too long for the arena still fits inside it',
  enemies.every((e) => e.mesh.position.x >= bounds.left && e.mesh.position.x <= bounds.right),
  `x from ${Math.min(...enemies.map((e) => e.mesh.position.x)).toFixed(1)} `
  + `to ${Math.max(...enemies.map((e) => e.mesh.position.x)).toFixed(1)} in a ${bounds.width}-wide ocean`);

// The seal spends a lot of the run AT the surface, which is where the +3 lift
// would otherwise put a shark in the air.
resetEnemies(scene);
seal.mesh.position.set(0, bounds.surfaceY - 0.5, 0);
spawnCreature('shark', 2);
check('a spawn beside a surfaced seal stays in the water',
  enemies.every((e) => e.mesh.position.y + e.radius <= bounds.surfaceY + 1e-6),
  enemies.map((e) => e.mesh.position.y.toFixed(2)).join(', '));

// A crab is a seabed animal whose `radius` is its resting height, not its size.
resetEnemies(scene);
seal.mesh.position.set(0, -20, 0);
spawnCreature('walkingCrab', 2);
check('a seabed dweller arrives on the sand, not in mid-water',
  enemies.length === 2 && enemies.every((e) => Math.abs(e.mesh.position.y - (bounds.bottom + e.radius)) < 1e-6),
  enemies.map((e) => e.mesh.position.y.toFixed(2)).join(', ') + ` · floor ${bounds.bottom}`);

check('an unknown key spawns nothing and does not throw', spawnCreature('notACreature', 3) === 0);
resetEnemies(scene);

// ---------------------------------------------------------------------------
section('THE ATTRACTOR STORM BLOCK');
// ---------------------------------------------------------------------------
// Six candidate bullet-hell attacks that nothing in the game rolls — the panel
// is the ONLY way any of them reaches the water, so a chip that does not select
// or a button that does not stage is not a broken control, it is a feature with
// no door. What each storm then does is tested where the storm is
// (tools/attractor-storm-test.mjs); this is the door.
{
  const { attractorStormList, activeAttractorStorm, stopAttractorStorm } =
    await import('../path/src/systems/attractorStorm.js');
  const storms = attractorStormList();

  // The LAST match, not the first. This file inits the panel twice — once with
  // no world and once against a real scene — so both panels' nodes are in the
  // document while only the second one's are the ones the module is writing to.
  const chipFor = (id) => findAll((n) => n.dataset?.chip === id).at(-1);
  const noteText = () => findAll((n) => n.dataset?.stormNote === '1').at(-1)?.textContent ?? '';
  check('every study in the table has a chip', storms.every((s) => !!chipFor(s.id)),
    storms.map((s) => s.id).join(', '));

  // The brief under the chips. Six designs is more than anyone holds in their
  // head between sessions, and the difference between them is the thing being
  // judged — a blank line here is the panel offering six identical buttons.
  check('...and the panel prints the selected one\'s brief', noteText().length > 40);

  const second = storms[1];
  chipFor(second.id).click();
  check('clicking a chip selects that study',
    chipFor(second.id).dataset.on === '1'
    && chipFor(storms[0].id).dataset.on !== '1', second.id);
  check('...and the brief follows the selection',
    noteText().includes(second.notes.slice(0, 30)));

  findAll((n) => n.textContent === 'Stage storm')[0].click();
  check('the button stages the selected study', activeAttractorStorm() === second.id,
    upgradeDebugState().status);

  // One at a time. These are being judged against each other and two at once is
  // a question about neither.
  const first = storms[0];
  chipFor(first.id).click();
  findAll((n) => n.textContent === 'Stage storm')[0].click();
  check('...and staging another replaces it', activeAttractorStorm() === first.id);

  findAll((n) => n.textContent === 'Stop storm')[0].click();
  check('Stop takes it back out', activeAttractorStorm() === null,
    upgradeDebugState().status);
  check('...and says so in a way that explains the cubes still on screen',
    upgradeDebugState().status.includes('fly on'));

  stopAttractorStorm(scene);
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
