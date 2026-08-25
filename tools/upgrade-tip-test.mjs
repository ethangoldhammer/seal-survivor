#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:tips
//
// THE HOVER TIP, and the three surfaces that were hexagons with nothing to say.
//
// ui/upgradeTip.js builds one answer to "what is this upgrade, what does one
// more do, and what has it actually done" and four surfaces render it: the
// level-up cards (covered by npm run test:tooltip, which drives the real
// menu), the boss-dividend hive, the corner hive while the run is stopped, and
// the snapshot on the score screen.
//
// EIGHT THINGS, and every one of them is a lie that renders perfectly:
//
//   A STALE LEDGER          runTotals() has to include the OPEN bucket.
//                           systems/playtest.js only pushes one every twenty
//                           seconds, so a reader that summed run.buckets alone
//                           shows an ability picked forty seconds ago as having
//                           done nothing — for up to a full bucket at a time,
//                           and as a confident zero rather than a blank.
//
//   THE WRONG OWNER         `gun` is five cards and `strike` is three, so an
//                           upgrade id does not map one-to-one onto a damage
//                           tag. The inverse index has to be built FROM
//                           SOURCE_UPGRADES; a hand-kept copy is the silent
//                           zero that file already has five comments about.
//
//   A ZERO THAT HIDES       an ability you are holding that has done nothing is
//                           the most useful thing the ledger knows. Dropping
//                           the row reads as "the tip does not have that", not
//                           as "it has done nothing".
//
//   A STAT CARD SHOWN AS DEAD   Yoga and Iron Lung have no damage tag at all,
//                           because they make other things better. They must
//                           get NO run row rather than a zero.
//
//   TWO PACKINGS            the snapshot on the score screen and the live
//                           corner have to share layoutHive. Two lattices that
//                           must agree forever is the failure the whole of
//                           upgradeHive.js is written around.
//
//   A SNAPSHOT THAT MOVES THE CORNER   the score screen builds a second hive
//                           while the run's own tiles are still in the tree.
//                           Building it through rebuild() would empty the
//                           corner, and nothing would throw.
//
//   AN UNREACHABLE HEXAGON  .sv-hive is pointer-events:none and the pause menu
//                           is a full-screen .sv-center at z-index 8 on top of
//                           it. A hive that opted back into the pointer without
//                           also clearing that stacking layer receives nothing
//                           and looks exactly like a wiring bug.
//
//   A RAIL THAT STAYS HIDDEN    .sv-trophy was hidden whenever no boss died,
//                           which is exactly the run — a death at minute four —
//                           most in need of being told what it was holding.
//
// Load order is the jsdom recipe: jsdom, then the vite loader, then the game
// modules. Run WITHOUT --import for that reason.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom has no 2D context and ui.js reaches for one — see dom-stub's note.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    clearRect() {}, fillRect() {}, drawImage() {}, save() {}, restore() {},
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
  };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

const { registerHooks } = await import('node:module');
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@rive-app/canvas') return { url: 'stub:rive', format: 'module', shortCircuit: true };
    if (spec.endsWith('.riv?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    if (spec.endsWith('.wasm?url')) return { url: 'stub:rivurl', format: 'module', shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === 'stub:rive') {
      return { format: 'module', shortCircuit: true, source: 'export class Rive { constructor(){} on(){} play(){} cleanup(){} } export const EventType = {}; export const Layout = class {}; export const Fit = {}; export const Alignment = {}; export const RuntimeLoader = { setWasmUrl(){} };' };
    }
    if (url === 'stub:rivurl') return { format: 'module', shortCircuit: true, source: 'export default "stub.riv";' };
    return next(url, ctx);
  },
});
await import('./vite-loader.mjs');

globalThis.fetch = async () => ({ ok: false, status: 404 });
const warnings = [];
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
const { initFeedback } = await import('../path/src/systems/feedback.js');
const tip = await import('../path/src/ui/upgradeTip.js');
const hive = await import('../path/src/ui/upgradeHive.js');
const playtest = await import('../path/src/systems/playtest.js');
const { SOURCE_UPGRADES, sourceForUpgrade } = await import('../path/src/systems/playtestAnalysis.js');
const { setSetting, SCHEMA, settings } = await import('../path/src/systems/settings.js');
const { player } = await import('../path/src/entities/player.js');
initFeedback(null);

const ui = await import('../path/src/ui/ui.js');
ui.initUI({ onStart() {}, onRestart() {}, onResume() {}, onPauseRestart() {}, onLevelChoice() {} });

const css = [...document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
const byId = new Map(CONFIG.upgrades.map((u) => [u.id, u]));
const tipEl = () => document.body.querySelector('.sv-uptip');
const tipUp = () => {
  const n = tipEl();
  return !!n && n.classList.contains('sv-uptip-on');
};
const row = (key) => tipEl()?.querySelector(`.sv-uptip-row[data-row="${key}"] .sv-uptip-text`)?.textContent ?? null;

// ---------------------------------------------------------------------------
section('the ledger is readable mid-run');
{
  playtest.beginRun({});
  playtest.recordDamage('shrimp', 900);
  playtest.recordKill({}, 'shrimp');
  // NOT A SINGLE BUCKET'S WORTH. Nothing has closed a bucket, so run.buckets is
  // still empty — which is exactly the window a reader that skipped the open
  // bucket would report a zero in, and it is the first twenty seconds of every
  // single run.
  check('no bucket has closed yet', (playtest.currentRun()?.buckets.length ?? -1) === 0,
    String(playtest.currentRun()?.buckets.length));
  const t = playtest.runTotals();
  check('the open bucket is counted anyway', t.dealtBySource.shrimp === 900,
    String(t.dealtBySource.shrimp));
  check('...and its kills', t.killsBySource.shrimp === 1, String(t.killsBySource.shrimp));

  // Buckets are twenty seconds wide; two ticks past the boundary close one.
  playtest.tick(21, { time: 21, level: 1, hp: 100, maxHp: 100, alive: 0, draws: 0 });
  playtest.recordDamage('shrimp', 100);
  const t2 = playtest.runTotals();
  check('a closed bucket and an open one add up, once each',
    t2.dealtBySource.shrimp === 1000, String(t2.dealtBySource.shrimp));

  playtest.recordControl('beluga', 4);
  check('control events come through', playtest.runTotals().controlEvents.beluga === 4,
    String(playtest.runTotals().controlEvents.beluga));

  check('stacksHeld reads the live run', playtest.stacksHeld('shrimpRing') === 0);
  playtest.recordUpgrade('shrimpRing');
  playtest.recordUpgrade('shrimpRing');
  check('...and counts picks as they land', playtest.stacksHeld('shrimpRing') === 2,
    String(playtest.stacksHeld('shrimpRing')));

  playtest.endRun('quit');
  // The final partial bucket is pushed by endRun. Read again through `last`,
  // the open bucket must NOT be added a second time.
  check('a finished run does not double-count its last bucket',
    playtest.runTotals().dealtBySource.shrimp === 1000,
    String(playtest.runTotals().dealtBySource.shrimp));
  check('...and finalStacks answers stacksHeld once the run is over',
    playtest.stacksHeld('shrimpRing') === 2, String(playtest.stacksHeld('shrimpRing')));
}

// ---------------------------------------------------------------------------
section('an upgrade id maps onto the tag its work is booked under');
{
  check('a card with its own tag', sourceForUpgrade('shrimpRing') === 'shrimp',
    String(sourceForUpgrade('shrimpRing')));
  check('the whole pebble volley books under one', sourceForUpgrade('rapidFire') === 'gun'
    && sourceForUpgrade('heavyRounds') === 'gun', 'gun');
  // Yoga's id is `oxygenMax` — a stat card, no damage tag, because it makes
  // OTHER things better. Named by id and not by display name on purpose: the
  // display name is Ethan's and can change, and a test that guessed the id
  // would pass on `undefined === null` while checking nothing.
  check('a stat card has no tag at all', sourceForUpgrade('oxygenMax') === null,
    String(sourceForUpgrade('oxygenMax')));
  check('...and it really is a card', byId.has('oxygenMax'));

  // BUILT FROM THE TABLE, checked against it. A hand-kept inverse drifts the
  // day a source gains an upgrade, and the symptom is a tip that says an
  // ability has done nothing.
  const missing = [];
  for (const source in SOURCE_UPGRADES) {
    for (const id of SOURCE_UPGRADES[source].upgrades) {
      if (sourceForUpgrade(id) !== source) missing.push(`${id} -> ${sourceForUpgrade(id)} not ${source}`);
    }
  }
  check('every upgrade the table names resolves back to it', missing.length === 0,
    missing.slice(0, 3).join(' | '));

  // And the other way: every id in the table is a real card.
  const ghosts = [];
  for (const source in SOURCE_UPGRADES) {
    for (const id of SOURCE_UPGRADES[source].upgrades) if (!byId.has(id)) ghosts.push(`${source}.${id}`);
  }
  check('and every id in the table is a card that exists', ghosts.length === 0, ghosts.join(', '));
}

// ---------------------------------------------------------------------------
section('what the run line says');
{
  const totals = {
    dealtBySource: { shrimp: 412100, octoGrab: 0 },
    killsBySource: { shrimp: 380 },
    controlEvents: { octoGrab: 7 },
  };
  const weapon = tip.runLine('shrimpRing', totals);
  check('a weapon reports damage and kills', weapon.includes('412k') && weapon.includes('380'),
    weapon);
  check('...compacted, because a tip is read at a glance',
    tip.compactDamage(950) === '950' && tip.compactDamage(4200) === '4.2k'
    && tip.compactDamage(412100) === '412k' && tip.compactDamage(2.4e6) === '2.4M',
    [950, 4200, 412100, 2.4e6].map(tip.compactDamage).join(' '));
  check('...named by the LINE the ledger books it under', weapon.startsWith('Shrimp Ring:'), weapon);

  const control = tip.runLine('octoGrab', totals);
  check('a damageless ability reports events', control.includes('7'), control);
  check('...and not a zero damage figure', !control.includes('dealt'), control);

  const quiet = tip.runLine('seagullBomb', totals);
  check('an ability that has done nothing SAYS so rather than dropping the row',
    !!quiet, quiet);

  check('a stat card gets no run line at all', tip.runLine('oxygenMax', totals) === '',
    tip.runLine('oxygenMax', totals));
}

// ---------------------------------------------------------------------------
section('the tip content');
{
  const totals = { dealtBySource: { shrimp: 5000 }, killsBySource: { shrimp: 9 }, controlEvents: {} };
  const full = tip.upgradeTipContent('shrimpRing', { owned: 2, verbosity: 'full', totals });
  check('it is named', full.name === byId.get('shrimpRing').name, full.name);
  check('it carries the stack count', full.stacks === 2, String(full.stacks));
  const keys = full.rows.map((r) => r.key);
  check('full has all three rows', keys.join(',') === 'next,total,run', keys.join(','));

  const short = tip.upgradeTipContent('shrimpRing', { owned: 2, verbosity: 'short', totals });
  check('short keeps only the next stack', short.rows.map((r) => r.key).join(',') === 'next',
    short.rows.map((r) => r.key).join(','));
  check('...and drops the desc as well', short.desc === '', short.desc);

  check('off is nothing at all',
    tip.upgradeTipContent('shrimpRing', { owned: 2, verbosity: 'off', totals }) === null);

  const fresh = tip.upgradeTipContent('shrimpRing', { owned: 0, verbosity: 'full', totals });
  // A card you have never taken has no running total (the total IS the next
  // stack, and saying the same sentence under two headings teaches the player
  // that the headings mean nothing) and no run row (it has done nothing by
  // definition, and the zero would be about the card rather than about the run).
  check('an unheld card has no total row', !fresh.rows.some((r) => r.key === 'total'),
    fresh.rows.map((r) => r.key).join(','));
  check('...and no run row', !fresh.rows.some((r) => r.key === 'run'),
    fresh.rows.map((r) => r.key).join(','));

  // THE NEXT STACK IS THE ONE BEING OFFERED, not stack 1. A tip stuck on the
  // first stack quotes an unlock the player already owns, which is wrong in
  // exactly the direction that flatters the card.
  const one = tip.upgradeTipContent('shrimpRing', { owned: 0, verbosity: 'short', totals });
  const three = tip.upgradeTipContent('shrimpRing', { owned: 3, verbosity: 'short', totals });
  check('the next-stack row follows how many are held',
    one.rows[0].text !== three.rows[0].text || !one.rows.length,
    `${one.rows[0]?.text} vs ${three.rows[0]?.text}`);

  // A capped stack has no next one and says so, rather than quoting a stack
  // that can never be bought.
  const capped = byId.get('shrimpRing').maxStacks;
  check('shrimpRing really has a cap', capped > 0, String(capped));
  const atCap = tip.upgradeTipContent('shrimpRing', { owned: capped, verbosity: 'full', totals });
  const next = atCap.rows.find((r) => r.key === 'next');
  check('at the cap the next row says there is no next one',
    !!next && next.text !== tip.upgradeTipContent('shrimpRing', { owned: 0, verbosity: 'short', totals }).rows[0].text,
    next?.text ?? 'no row');

  check('an id that is not an upgrade gets nothing',
    tip.upgradeTipContent('notAnUpgrade', { owned: 1, verbosity: 'full', totals }) === null);
}

// ---------------------------------------------------------------------------
section('the verbosity setting exists and defaults to full');
{
  const item = SCHEMA.hud.items.find((i) => i.key === 'upgradeTips');
  check('there is a row in the pause menu for it', !!item);
  check('...offering off, short and full',
    item.options.join(',') === 'off,short,full', item.options.join(','));
  check('...defaulting to full', item.def === 'full', String(item.def));
  check('...and a label for every option',
    item.options.every((o) => !!item.labels?.[o]), JSON.stringify(item.labels));
  check('the live settings carry it', settings.hud.upgradeTips === 'full',
    String(settings.hud.upgradeTips));
  setSetting('hud.upgradeTips', 'short');
  check('tipVerbosity reads it back', tip.tipVerbosity() === 'short', tip.tipVerbosity());
  setSetting('hud.upgradeTips', 'full');

  // AND IT REACHES THE MENU. The pause panel is built from SCHEMA rather than
  // hand-listed, which is the arrangement that makes this cheap — but "cheap"
  // is not "checked", and a row declared in a section nothing renders is a
  // setting only a test can reach.
  const pause = await import('../path/src/ui/pauseMenu.js');
  pause.showPauseMenu({ standalone: true });
  // The panel opens on Audio. The HUD tab is where this row lives, and the tab
  // strip is built from the same SCHEMA — so it is found by the section's own
  // label rather than by an index that would move the day a tab is added.
  const tab = [...document.querySelectorAll('.sv-pm-tab')]
    .find((t) => t.textContent.trim().toLowerCase() === SCHEMA.hud.label.toLowerCase());
  check('there is a HUD tab to find it under', !!tab,
    [...document.querySelectorAll('.sv-pm-tab')].map((t) => t.textContent).join(' | '));
  tab?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const labels = [...document.querySelectorAll('.sv-pm-row .sv-pm-label, .sv-pm-name, .sv-pm-row > span')]
    .map((n) => n.textContent);
  const row = labels.some((t) => t.includes(item.label));
  check('the row is drawn in the pause menu', row, labels.slice(-6).join(' | '));
  const choices = [...document.querySelectorAll('.sv-pm-choice')].map((n) => n.textContent);
  check('...as a cycling choice showing the current value',
    choices.some((t) => t === item.labels.full), choices.join(' | '));
  pause.hidePauseMenu();
}

// ---------------------------------------------------------------------------
section('the corner answers only while the run is stopped');
{
  const picks = [
    { id: 'shrimpRing', rarity: 'common' },
    { id: 'shrimpRing', rarity: 'rare' },
    { id: 'seagullBomb', rarity: 'common' },
  ];
  hive.setHiveUpgrades(picks);
  const root = document.querySelector('.sv-hive');
  const tile = document.querySelector('.sv-hive-tile[data-upgrade="shrimpRing"]');
  check('the corner has tiles', !!tile);

  check('at rest the hive takes no pointer',
    css.includes('.sv-hive { pointer-events: none;'),
    'a hive that answered the pointer mid-fight would open a box every time your aim crossed the corner');
  check('...and nothing is bound', !root.hasAttribute('data-tips'));

  let shownFor = null;
  hive.setHiveTips(true, { onShow: (id) => { shownFor = id; }, onHide: () => { shownFor = null; } });
  check('turning tips on marks the root', root.dataset.tips === 'on', root.dataset.tips ?? '');
  // BOTH HALVES. pointer-events alone is not enough: the pause menu is a
  // full-screen .sv-center at z-index 8 sitting on top of the corner, so a hive
  // left at z-index 1 receives nothing however many listeners it has.
  const tipsRule = css.slice(css.indexOf('.sv-hive[data-tips="on"] {'));
  const decl = tipsRule.slice(0, tipsRule.indexOf('}'));
  check('...which opts back into the pointer', decl.includes('pointer-events: auto'), decl.trim());
  const zTips = Number(decl.match(/z-index:\s*(\d+)/)?.[1]);
  const zCenter = Number(css.slice(css.indexOf('.sv-center {')).match(/z-index:\s*(\d+)/)?.[1]);
  check('...and clears the menu layer that covers the corner', zTips > zCenter,
    `tips ${zTips} vs menus ${zCenter}`);

  tile.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  check('hovering a tile asks for its tip', shownFor === 'shrimpRing', String(shownFor));

  hive.setHiveTips(false);
  check('turning them off clears the mark', !root.hasAttribute('data-tips'));
  shownFor = null;
  tile.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  check('...and the listener really is gone', shownFor === null, String(shownFor));
}

// ---------------------------------------------------------------------------
section('the floating box');
{
  const tile = document.querySelector('.sv-hive-tile[data-upgrade="shrimpRing"]');
  tip.showUpgradeTip('shrimpRing', tile, { owned: 2 });
  check('a box appears', tipUp());
  // ON document.body. The corner hive, a menu mid-reveal and a rail that
  // scrolls sideways are three coordinate spaces; a box parented into any of
  // them inherits that container's transform, clip or scroll.
  check('...on the body, not inside the hive', tipEl().parentElement === document.body,
    tipEl().parentElement?.className ?? '');
  check('...naming the upgrade', tip.upgradeTipFor() === 'shrimpRing', String(tip.upgradeTipFor()));
  check('...with rows in it', !!row('next'), row('next') ?? 'no row');

  tip.hideUpgradeTip();
  check('hiding it takes the class off', !tipUp());
  check('...and the node stays, to be moved rather than remade', !!tipEl());
  check('...and it reports nothing under the pointer', tip.upgradeTipFor() === null);

  // A run ending must DROP it: it is describing the last run's stacks and the
  // last run's ledger, and it outlives every menu because it is on the body.
  tip.showUpgradeTip('shrimpRing', tile, { owned: 2 });
  tip.resetUpgradeTip();
  check('a reset removes the node entirely', !tipEl());

  setSetting('hud.upgradeTips', 'off');
  tip.showUpgradeTip('shrimpRing', tile, { owned: 2 });
  check('with tips off nothing is shown', !tipUp());
  setSetting('hud.upgradeTips', 'full');
}

// ---------------------------------------------------------------------------
section('the snapshot is the corner, at another size');
{
  const picks = [
    { id: 'shrimpRing', rarity: 'common' },
    { id: 'shrimpRing', rarity: 'legendary' },
    { id: 'seagullBomb', rarity: 'common' },
    { id: 'yoga', rarity: 'rare' },
  ];
  hive.setHiveUpgrades(picks);
  const cornerTiles = document.querySelectorAll('.sv-hive-host:not(.sv-hive-snap) .sv-hive-tile').length;

  const snap = hive.buildHiveSnapshot(picks, { size: 30 });
  check('a snapshot is built', !!snap);
  check('...one tile per ability, stacks folded', snap.tiles.size === 3, String(snap.tiles.size));
  check('...detached, so nothing has been added to the page', !snap.host.isConnected);
  // BUILDING IT MUST NOT EMPTY THE CORNER. rebuild() throws the live tile map
  // away; a snapshot routed through it would leave the run's own hive blank and
  // nothing would throw.
  check('...and the live corner is untouched',
    document.querySelectorAll('.sv-hive-host:not(.sv-hive-snap) .sv-hive-tile').length === cornerTiles,
    `${cornerTiles} before`);
  check('...carrying the run\'s own look', snap.host.dataset.style === (CONFIG.upgradeHive.style ?? 'ink'),
    snap.host.dataset.style ?? '');

  // ONE LATTICE. The size is the hexagon's, and the boxes are hung around it,
  // so a snapshot at half the size is half the block — not a differently packed
  // one. Measured off the stamped host, which is the only thing jsdom can give
  // us and the thing the score screen lays out against.
  const big = hive.buildHiveSnapshot(picks, { size: 60 });
  const w = (h) => parseFloat(h.host.style.width);
  check('doubling the hexagon roughly doubles the block',
    Math.abs(w(big) / w(snap) - 2) < 0.25, `${w(snap)} -> ${w(big)}`);
  check('the host is sized rather than left at zero', w(snap) > 0, String(w(snap)));

  check('an empty build is null, not an empty frame', hive.buildHiveSnapshot([]) === null);

  // The style hook has to be on the HOST. On the root it would miss every
  // snapshot, which renders as tiles with no face — a loading failure, not a
  // missing selector.
  check('the three looks key on the host', css.includes('.sv-hive-host[data-style="ink"]'));
  check('...and not on the root any more', !css.includes('.sv-hive[data-style='));
}

// ---------------------------------------------------------------------------
section('the score screen shows the build even when no boss died');
{
  player.upgrades.length = 0;
  player.upgrades.push({ ...byId.get('shrimpRing') }, { ...byId.get('shrimpRing') },
    { ...byId.get('oxygenMax') });
  playtest.beginRun({});
  playtest.recordDamage('shrimp', 2500);
  // TICKED BEFORE IT ENDS. endRun only files the final partial bucket when it
  // has run for a non-zero time — a run that ends on the frame it began throws
  // its only bucket away, which is correct for the recorder and would make this
  // section assert against an empty ledger.
  playtest.tick(2, { time: 2, level: 1, hp: 1, maxHp: 100, alive: 0, draws: 0 });
  playtest.endRun('death');

  ui.showGameOver({ score: 1200, deathCauses: new Set(), deathSource: null, time: 240 }, { bosses: 0 });

  const trophy = document.getElementById('svTrophy');
  check('the rail is shown', !trophy.classList.contains('sv-hidden'),
    'a run that died at minute four is the one most in need of being told what it was holding');
  const slot = document.querySelector('.sv-fan-hive');
  check('...holding the build', !!slot);
  check('...to the RIGHT of everything else on it',
    slot && slot === document.getElementById('svFan').lastElementChild);
  check('...and there are no kill shots beside it',
    document.querySelectorAll('.sv-fan-slot:not(.sv-fan-hive)').length === 0);
  // Share and Save act on a selected shot, and there is none. Four buttons that
  // all report "Nothing to share" read as a broken screen.
  check('...and the share buttons are gone',
    document.getElementById('svTrophyRow').classList.contains('sv-hidden'));
  check('...and the heading no longer says kill shots',
    document.getElementById('svStripLabel').textContent !== 'Kill shots',
    document.getElementById('svStripLabel').textContent);

  // THE HEXAGONS ANSWER THE POINTER. Same tip, same builder, this run's ledger.
  const tile = slot.querySelector('.sv-hive-tile[data-upgrade="shrimpRing"]');
  check('the snapshot has hoverable tiles', !!tile);
  tile.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  check('...and hovering one opens the tip', tipUp());
  // THE COUNT COMES OFF THE TILE, not off the ledger. Nothing recorded a pick
  // here — recordUpgrade was never called — so a tip that asked the recorder
  // how many stacks were held would get zero and drop half its rows, which is
  // exactly what the demo score screen does on every run.
  check('...knowing how many stacks the tile is', tipEl().querySelector('.sv-uptip-stacks')?.textContent === '×2',
    tipEl().querySelector('.sv-uptip-stacks')?.textContent ?? 'no count');
  check('...reading this run\'s ledger', row('run')?.includes('2.5k') === true, row('run') ?? '');
}

// ---------------------------------------------------------------------------
section('the build list beside it covers the WHOLE build');
{
  // It was built from SOURCE_UPGRADES, which is the ~30 abilities with a damage
  // tag — so the panel whose own comment said the stat cards were invisible was
  // itself missing every one of them. Yoga (`oxygenMax`) is the check: no
  // damage tag, no kills, and a pick of it is still a third of a build.
  const rows = [...document.querySelectorAll('#svPanelBuild .sv-brk-name')].map((n) => n.textContent);
  check('the damage ability is listed', rows.includes(byId.get('shrimpRing').name), rows.join(' | '));
  check('...and so is the stat card with no damage tag',
    rows.includes(byId.get('oxygenMax').name), rows.join(' | '));
  // The list and the hexagons are the same run side by side on one screen, so
  // the one thing they may never do is disagree about the count.
  const listed = rows.length;
  const hexes = document.querySelectorAll('.sv-fan-hive .sv-hive-tile').length;
  check('the list and the hive agree on how many abilities', listed === hexes,
    `${listed} rows vs ${hexes} hexagons`);
}

// ---------------------------------------------------------------------------
section('the build opens');
{
  const slot = document.querySelector('.sv-fan-hive');
  slot.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  const view = document.getElementById('svHiveView');
  check('clicking it opens the sheet', !view.classList.contains('sv-hidden'));
  check('...with a hive in it', !!view.querySelector('.sv-hive-tile'));
  // A SECOND SNAPSHOT, not the rail's one moved: a hive's rims, piles and
  // shadows are laid out in pixels against the hexagon's size, so a 30px hive
  // scaled up is a 2px rim magnified to 5.
  const railStill = document.querySelector('.sv-fan-hive .sv-hive-tile');
  check('...and the rail still has its own', !!railStill);
  const big = parseFloat(view.querySelector('.sv-hive-tile').style.width);
  const small = parseFloat(railStill.style.width);
  check('...built larger rather than scaled', big > small, `${small} -> ${big}`);

  document.getElementById('svHiveViewClose').dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  check('closing it hides the sheet', view.classList.contains('sv-hidden'));
  check('...and drops the hexagons it was holding',
    !view.querySelector('.sv-hive-tile'),
    'each one carries a card-art background and an icon bitmap');
}

// ---------------------------------------------------------------------------
section('nothing warned');
{
  const noisy = warnings.filter((w) => /\[upgrades\]|\[ui\]|\[hive\]/.test(w));
  check('no warnings from the surfaces under test', noisy.length === 0, noisy.slice(0, 2).join(' | '));
}

player.upgrades.length = 0;
console.log(`\n${failures ? `FAILED (${failures})` : 'all passed'}`);
process.exit(failures ? 1 : 0);
