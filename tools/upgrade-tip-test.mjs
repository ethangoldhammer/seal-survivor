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
    if (spec === '@rive-app/canvas' || spec === '@rive-app/webgl2') return { url: 'stub:rive', format: 'module', shortCircuit: true };
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
const { player, recomputeStats, statsWithOneMore, computeStats } = await import('../path/src/entities/player.js');
const { baseStats } = await import('../path/src/stats.js');
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
section('and where that puts you');
{
  // THE SECOND HALF OF THE `next` ROW. "+25% fire rate" is what the card adds;
  // the span is the number the FIGHT uses once it is taken, with the base, the
  // level growth and every other card folded in — which is why it goes through
  // entities/player.js and not through another measure().
  //
  // A run is stood up for real rather than faked: the whole claim is that the
  // figure comes out of the same pipeline recomputeStats uses, and a hand-built
  // block would be a test of the hand-building.
  const stand = (id, owned, level = owned * 2) => {
    player.upgrades.length = 0;
    for (let i = 0; i < owned; i++) player.upgrades.push({ id, rarity: 'common' });
    player.level = level;
    recomputeStats();
    return { live: player.stats, after: statsWithOneMore(id, 'common') };
  };
  const build = (id, owned, extra = {}) => {
    const { live, after } = stand(id, owned);
    return tip.upgradeTipContent(id, {
      owned, verbosity: 'full', totals: { dealtBySource: {}, killsBySource: {}, controlEvents: {} },
      liveStats: live, afterStats: after, ...extra,
    });
  };
  const rowOf = (c, key) => c.rows.find((r) => r.key === key)?.text ?? null;

  // A COUNT reads as a count. Nothing else in the game grants orbiting shrimp,
  // so the live figure and the card's own total are the same number — which is
  // exactly the case the sole-source rule below is about.
  const shrimp = build('shrimpRing', 4);
  check('a count shows the real before and after', /\b6\b.*\b7\b/.test(rowOf(shrimp, 'next') ?? ''),
    rowOf(shrimp, 'next') ?? 'no row');
  check('...and it is on the next row, not a row of its own',
    !shrimp.rows.some((r) => r.key === 'span'), shrimp.rows.map((r) => r.key).join(','));

  // A `lower` STAT AS A MULTIPLE. fireRate's raw block value is a DELAY in
  // seconds, so it falls as the stat improves — printed raw beside a phrase
  // reading "+25% fire rate" it reads as a downgrade. Three stats in the game
  // carry `lower` and this is the one anybody holds.
  const gun = build('rapidFire', 3);
  const gunRow = rowOf(gun, 'next') ?? '';
  check('a lower-is-better stat is shown as a multiple', gunRow.includes('\u00d7'), gunRow);
  check('...and the multiple goes UP as the stat improves', (() => {
    const [a, b] = [...gunRow.matchAll(/\u00d7([\d.]+)/g)].map((m) => Number(m[1]));
    return Number.isFinite(a) && Number.isFinite(b) && b > a;
  })(), gunRow);
  // The figure is the one recomputeStats produces, not one measure() invented.
  {
    const { live } = stand('rapidFire', 3);
    const base = baseStats().fireRate;
    const want = Math.round((base / live.fireRate) * 100) / 100;
    check('...measured against the base the run actually started from',
      gunRow.includes(`\u00d7${want}`), `${gunRow} — expected \u00d7${want}`);
  }

  // EVERY SOURCE, which is the whole reason it is not another measure().
  //
  // `strikeDamage` is the stat five cards move — the strike family plus Big
  // Willy Style — so it is the one place in the roster where "what this card
  // gave me" and "what I actually have" genuinely diverge. measure() replays
  // ONE apply() against a synthetic seal and can never see the other four.
  {
    const held = [{ id: 'strikePower', rarity: 'common' }, { id: 'strikeDash', rarity: 'common' }];
    player.upgrades.length = 0;
    player.level = 6;
    for (const p of held) player.upgrades.push(p);
    recomputeStats();
    const solo = computeStats([held[0]], 6, 0);
    check('another card moving the same stat is in the figure',
      player.stats.strikeDamage !== solo.strikeDamage,
      `${solo.strikeDamage} from Strike Power alone vs ${player.stats.strikeDamage} live`);
  }

  // NOTHING TO SAY IS SAID BY SAYING NOTHING. With no run there is no live
  // block, and the row falls back to the delta alone rather than to a span of
  // undefineds.
  //
  // `player.stats` is EMPTIED rather than just passing null, because null falls
  // back to the live block on purpose — that fallback is what lets three of the
  // four surfaces call showUpgradeTip without threading a stat block through.
  // An empty block is the state before any run has been started, which is what
  // the main menu and a Node harness are actually in.
  {
    const wasStats = player.stats;
    player.stats = {};
    const noRun = tip.upgradeTipContent('shrimpRing', {
      owned: 2, verbosity: 'full',
      totals: { dealtBySource: {}, killsBySource: {}, controlEvents: {} },
    });
    check('with no run the row is the delta alone',
      !(rowOf(noRun, 'next') ?? '').includes('\u2192'), rowOf(noRun, 'next') ?? '');
    check('...and the tip is still built rather than refused', !!noRun?.rows.length,
      JSON.stringify(noRun?.rows?.map((r) => r.key)));
    player.stats = wasStats;
  }

  // AND SHORT NEVER CARRIES IT. "Where does that put me" is the reading half,
  // which is the whole reason the setting has a middle rung.
  const short = build('shrimpRing', 4, { verbosity: 'short' });
  check('short is the delta alone too',
    !(rowOf(short, 'next') ?? '').includes('\u2192'), rowOf(short, 'next') ?? '');

  // --- THE `now` ROW EARNS ITS PLACE ---------------------------------------
  // Its question is "what has THIS card given me", which is only worth asking
  // when something else gave you some of it too. Nothing else grants orbiting
  // shrimp, so the card's total and the live figure in the span are the same
  // number printed twice, four pixels apart.
  check('a sole source drops the running total', rowOf(shrimp, 'total') === null,
    rowOf(shrimp, 'total') ?? '');
  {
    player.upgrades.length = 0;
    player.level = 8;
    for (let i = 0; i < 2; i++) player.upgrades.push({ id: 'strikePower', rarity: 'common' });
    player.upgrades.push({ id: 'strikeDash', rarity: 'common' });
    recomputeStats();
    const shared = tip.upgradeTipContent('strikePower', {
      owned: 2, verbosity: 'full',
      totals: { dealtBySource: {}, killsBySource: {}, controlEvents: {} },
      liveStats: player.stats, afterStats: statsWithOneMore('strikePower', 'common'),
    });
    check('...and brings it back when another card shares the stat',
      shared.rows.some((r) => r.key === 'total'), shared.rows.map((r) => r.key).join(','));
  }

  // EXCEPT AN UNLOCK, which is prose and cannot be duplicated by a figure. The
  // orca family is of course the only source of orca family levels, and its
  // desc is pure flavour — so the sole-source rule would have eaten the one
  // sentence in the game that says what the ability does.
  // THE UNLOCK SENTENCE SURVIVES THE READOUT. Orca Family has a level table
  // now, and the table replaces the desc — except on the FIRST stack, where the
  // desc is not a figure at all but the ability's unlock sentence, the only
  // prose in the game saying what the thing is. A card whose own desc is
  // flavour ("Boaterhaters") has nothing else.
  const orca0 = build('orcaFamily', 0);
  check('a first pick keeps the unlock sentence', !!orca0.desc, orca0.desc || 'dropped');
  check('...and it really is the sentence, not a figure',
    /[a-z]{4}\s+[a-z]{4}/i.test(orca0.desc ?? ''), orca0.desc ?? '');
  check('...beside the table of what it grants',
    orca0.rows.some((r) => r.key.startsWith('lv:')),
    orca0.rows.map((r) => r.key).join(','));
  // From the second stack on it is a figure again — "+1 orca family level" —
  // which is exactly the line the table exists to replace.
  const orca2 = build('orcaFamily', 2);
  check('a later stack drops it, the table having covered it',
    orca2.desc === '', orca2.desc);

  player.upgrades.length = 0;
  player.level = 1;
  recomputeStats();
}

// ---------------------------------------------------------------------------
section('what a level actually buys');
{
  // measure() replays apply() and reports the stat block, which for half the
  // roster is ONE number — `s.bakalarLevel += 1`. Everything the card is about
  // lives in systems/bakalar.js, derived from that level, where no measurement
  // could reach it. levelStats.js is the second source of truth, and the tip
  // prefers it.
  const { levelChanges, bakalarLevelStats } = await import('../path/src/levelStats.js');

  const stand = (id, owned, extra = []) => {
    player.upgrades.length = 0;
    for (let i = 0; i < owned; i++) player.upgrades.push({ id, rarity: 'common' });
    for (const e of extra) player.upgrades.push({ id: e, rarity: 'common' });
    player.level = Math.max(1, owned * 2);
    recomputeStats();
    return { live: player.stats, after: statsWithOneMore(id, 'common') };
  };
  const tipFor = (id, owned, extra = []) => {
    const { live, after } = stand(id, owned, extra);
    return tip.upgradeTipContent(id, {
      owned, verbosity: 'full',
      totals: { dealtBySource: {}, killsBySource: {}, controlEvents: {} },
      liveStats: live, afterStats: after,
    });
  };
  const labels = (c) => c.rows.map((r) => r.label.replace('[DRAFT] ', ''));

  const boat = tipFor('bakalar', 1);
  check('a levelled card lists the quantities its level moves',
    labels(boat).length > 3, labels(boat).join(' | '));
  check('...rather than the one number apply() writes',
    !labels(boat).some((l) => /level/i.test(l)), labels(boat).join(' | '));
  // The two the old hand-typed desc never mentioned, and which are the biggest
  // things a stack buys.
  const named = labels(boat).join(' ');
  check('...including the bomb', /damage/.test(named), named);
  check('...and the blast', /blast|radius/.test(named), named);

  // EVERY ROW CARRIES ITS OWN SPAN. These quantities are not stat-block keys —
  // `bakalarBombDamage` is derived from a level and exists nowhere in the block
  // — so the span cannot come from effectiveSpan, which looks the stat up in
  // the two blocks and quietly returns '' when it is not there.
  const dmg = boat.rows.find((r) => /damage/.test(r.label));
  check('a row shows the step and where it lands', /→/.test(dmg?.text ?? ''), dmg?.text ?? 'no row');
  check('...matching the ability\'s own numbers', (() => {
    const a = bakalarLevelStats(1, player.stats).bakalarBombDamage;
    const b = bakalarLevelStats(2, player.stats).bakalarBombDamage;
    return dmg.text.includes(String(a)) && dmg.text.includes(String(b));
  })(), dmg?.text ?? '');

  // A LOWER-IS-BETTER ADDITIVE STAT MUST NOT READ "+-0.32s". The hardcoded plus
  // in phrase() was fine while every additive stat went up; the boat's bomb
  // interval is the first that goes down.
  const gap = boat.rows.find((r) => /bomb/.test(r.label) && /s ·|s$/.test(r.text));
  check('a quantity that shrinks reads as a minus, not a plus-minus',
    !boat.rows.some((r) => r.text.includes('+-')),
    boat.rows.map((r) => r.text).join(' | '));

  // ONLY WHAT MOVED. The sailing interval hits its floor a few stacks in, and a
  // card still claiming faster sailings after that is the same class of lie the
  // typed desc was telling.
  const deep = tipFor('bakalar', 4);
  // THE CAP CHANGED WHAT THIS CAN ASK. Sailings is sixth in the boat's declared
  // order, so the four-row limit drops it from the tip either way — the
  // question "is a floored quantity excluded" has to be put to levelChanges
  // directly rather than to the rendered rows.
  const { levelChanges: lc } = await import('../path/src/levelStats.js');
  const stats = (owned) => {
    const { live, after } = stand('bakalar', owned);
    return (lc('bakalar', owned, owned + 1, live, after, 8) ?? []).map((c) => c.stat);
  };
  check('a quantity still moving is listed',
    stats(1).includes('bakalarSailGap'), stats(1).join(', '));
  check('...and one that has hit its floor is not',
    !stats(4).includes('bakalarSailGap'), stats(4).join(', '));

  // THE STAT BLOCKS GO WITH THEIR LEVELS. Big Rigz multiplies companion damage
  // and Splash Zone widens blasts; measured against today's block on both sides
  // the step would be under-reported for a player holding either.
  const rigged = tipFor('bakalar', 4, ['companionSize', 'areaOfEffect']);
  const step = (c) => {
    const t = c.rows.find((r) => /damage/.test(r.label))?.text ?? '';
    return Number(t.match(/^\+([\d.]+)/)?.[1] ?? 0);
  };
  check('the multipliers a build already has are folded in',
    step(rigged) > step(deep), `${step(deep)} bare vs ${step(rigged)} with Big Rigz`);

  // THE DESC IS THE LINE THIS REPLACES. 49 of the 51 descs are {effect}, which
  // on a levelled card expands to "+1 Bakalar's boat level" — printed directly
  // above the table saying what that means.
  check('the stale one-liner is not printed above the table', boat.desc === '', boat.desc);

  // AND EVERYTHING WITHOUT A READOUT IS UNTOUCHED. Most of the roster, for now.
  // Homing Pebbles has a readout now too (one row — the reach, the only one of
  // its three numbers with a meaning outside the code). `maneater` is the
  // standing example of a level that needs none: it feeds a damage multiplier
  // straight into the stat block, where measure() has always seen it.
  check('an ability with no readout keeps the phrase it always had',
    levelChanges('maneater', 1, 2) === null, String(levelChanges('maneater', 1, 2)));
  const shrimp = tipFor('shrimpRing', 4);
  check('...and a stat card is unaffected',
    shrimp.rows.some((r) => r.key === 'next'), shrimp.rows.map((r) => r.key).join(','));

  // ONE IMPLEMENTATION, which is the whole promise. A readout that merely
  // AGREED with systems/bakalar.js today would stop agreeing the first time
  // either was retuned, silently, because nothing compares them. Read off the
  // source rather than driven: importing bakalar.js pulls in three.js, the
  // arena and the entity layer, and what can regress here is the import being
  // dropped, not the arithmetic.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../path/src/systems/bakalar.js', import.meta.url), 'utf8');
  check('the boat sources its numbers from the same file the tip does',
    /import \{[^}]*bakalarLevelStats[^}]*\} from '\.\.\/levelStats\.js'/.test(src));
  // COMMENTS STRIPPED FIRST. Several of them name a tuning key while explaining
  // why a clamp exists, and a check that counted those would either fail on
  // prose or be quietly loosened until it stopped catching a real second copy.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const copies = code.match(/\w+PerLevel/g) ?? [];
  check('...and keeps no second copy of the formulas', copies.length === 0, copies.join(', '));

  // --- A QUANTITY THAT IS NOT MOVING YET -----------------------------------
  //
  // Counts step on rounding: Laser Eyes gains a second beam at stack four and
  // nothing on the three picks either side. Two kinds of standing still, and
  // the tip must not treat them alike — one has stopped for good, the other is
  // still coming. Driven through a synthetic readout because no shipped ability
  // has both shapes at once yet.
  {
    const { LEVEL_STATS, levelChanges, RATIO_STATS } = await import('../path/src/levelStats.js');
    LEVEL_STATS.__probe = (level) => ({
      // climbs every level
      bakalarBombDamage: 10 * Math.max(1, level),
      // steps on a round: 1 at levels 1-3, 2 from 4
      bakalarGrip: Math.round(1 + 0.34 * (Math.max(1, level) - 1)),
      // hit its ceiling at level 2 and will never move again
      bakalarNetDepth: Math.min(2, Math.max(1, level)),
    });

    const at = (from, to, cap) => levelChanges('__probe', from, to, {}, {}, cap);
    const byStat = (rows, stat) => rows.find((r) => r.stat === stat);

    const mid = at(1, 2, 8);
    check('a quantity that moves is reported as a change',
      byStat(mid, 'bakalarBombDamage')?.how === 'add', JSON.stringify(mid));
    check('...one that is mid-step is kept, flat',
      byStat(mid, 'bakalarGrip')?.how === 'none', JSON.stringify(byStat(mid, 'bakalarGrip')));
    check('...and one at its ceiling is dropped',
      byStat(at(3, 4, 8), 'bakalarNetDepth') == null,
      JSON.stringify(at(3, 4, 8).map((r) => r.stat)));
    // The step itself is a real change, not a flat row. round(1 + 0.34n) turns
    // over between the second and third level, which is the pick to ask about.
    check('the pick the step lands on reports it as a change',
      byStat(at(2, 3, 8), 'bakalarGrip')?.how === 'add',
      JSON.stringify(byStat(at(2, 3, 8), 'bakalarGrip')));
    // With no cap to look ahead to, nothing can be known to be still coming.
    check('with no cap given, a still quantity is simply absent',
      byStat(at(1, 2, 0), 'bakalarGrip') == null, JSON.stringify(at(1, 2, 0)));

    // RATIOS ARE DECLARED, never guessed — two points fit a sum and a product
    // equally well, and an additive reading of a rate prints "-0.08s" for what
    // is really "x0.88".
    check('a quantity is additive unless the ability says otherwise',
      byStat(at(1, 2, 8), 'bakalarBombDamage')?.how === 'add');
    RATIO_STATS.__probe = new Set(['bakalarBombDamage']);
    check('...and a declared one comes back as a ratio',
      byStat(at(1, 2, 8), 'bakalarBombDamage')?.how === 'mul',
      JSON.stringify(byStat(at(1, 2, 8), 'bakalarBombDamage')));
    delete RATIO_STATS.__probe;
    delete LEVEL_STATS.__probe;
  }

  // --- THE FIRST PICK IS AN UNLOCK ------------------------------------------
  //
  // The bug that made the whole feature look broken on the screen it matters
  // most. A card you do not already hold is measured from level 0, and there is
  // no level 0 of an ability — so both sides of the subtraction were level 1,
  // every quantity came out unmoved, and the flat rule KEPT them all (they do
  // all move on a later pick). Every card in the deal you had not taken yet
  // read "bomb damage 61 -> 61, blast 11 -> 11, net depth 14.5 -> 14.5", which
  // early in a run is nearly the whole screen.
  {
    const { levelChanges: lc } = await import('../path/src/levelStats.js');
    const first = lc('bakalar', 0, 1, {}, {}, 8) ?? [];
    check('a card never taken reports an unlock, not a delta',
      first.length > 0 && first.every((c) => c.how === 'unlock'),
      first.map((c) => `${c.stat}:${c.how}`).join(' '));
    check('...with no before to arrow from',
      first.every((c) => c.from === null), JSON.stringify(first[0]));
    check('...and a real value in it',
      first.every((c) => Number.isFinite(c.to) && c.to !== 0),
      first.map((c) => c.to).join(', '));

    const fresh = tipFor('bakalar', 0);
    const table = fresh.rows.filter((r) => r.key.startsWith('lv:'));
    check('so the card shows what the ability DOES', table.length > 0,
      table.map((r) => r.text).join(' | '));
    check('...as bare values, with no arrow and nothing dimmed',
      table.every((r) => !r.text.includes('\u2192') && !r.flat),
      table.map((r) => r.text).join(' | '));
    // Dropped at Short, a first-pick card would have no rows at all — which is
    // the state this branch exists to fix, arriving by a different road.
    const short = tip.upgradeTipContent('bakalar', { owned: 0, verbosity: 'short' });
    check('...and Short keeps them, or the card says nothing at all',
      short.rows.filter((r) => r.key.startsWith('lv:')).length > 0,
      short.rows.map((r) => r.key).join(','));

    // The delta path is untouched by any of it.
    const second = lc('bakalar', 2, 3, {}, {}, 8) ?? [];
    check('a stack you already hold is still a delta',
      second.some((c) => c.how === 'add'), second.map((c) => c.how).join(' '));
  }

  // --- A RUN THAT IS OVER ---------------------------------------------------
  //
  // Every other surface showing a hexagon asks "should I take another one" —
  // the corner hive, the boss dividend, the level-up cards. The score screen
  // asks the opposite: the build is finished, so "+22 bomb damage if you take a
  // ninth" is an offer nobody can accept, printed over the one screen that
  // exists to say what the run WAS.
  {
    const fin = (id, owned) => tip.upgradeTipContent(id, {
      owned, verbosity: 'full', final: true,
      totals: { dealtBySource: {}, killsBySource: {}, controlEvents: {} },
    });

    const over = fin('bakalar', 4);
    const table = over.rows.filter((r) => r.key.startsWith('lv:'));
    check('a finished run prints where each quantity landed', table.length > 0,
      table.map((r) => r.text).join(' | '));
    check('...as values, with nothing to arrow toward',
      table.every((r) => !r.text.includes('\u2192')), table.map((r) => r.text).join(' | '));
    check('...and never a next stack', over.rows.every((r) => r.key !== 'next'),
      over.rows.map((r) => r.key).join(','));

    // A card with NO readout takes the other branch, and it has the same
    // problem: its measured "next stack" line prices a pick the run cannot make.
    const plain = fin('shrimpRing', 4);
    check('a card with no readout drops its next stack too',
      plain.rows.every((r) => r.key !== 'next'), plain.rows.map((r) => r.key).join(','));
    check('...and still says what it was worth',
      plain.rows.some((r) => r.key === 'total'), plain.rows.map((r) => r.key).join(','));

    // The run row is the whole reason to hover a hexagon on that screen.
    check('the run row survives on both kinds of card',
      fin('bakalar', 4).rows.some((r) => r.key === 'run')
      && plain.rows.some((r) => r.key === 'run'));

    // And mid-run is untouched — the same card, one flag apart.
    const live = tip.upgradeTipContent('bakalar', {
      owned: 4, verbosity: 'full',
      totals: { dealtBySource: {}, killsBySource: {}, controlEvents: {} },
    });
    check('mid-run still prices the next pick',
      live.rows.filter((r) => r.key.startsWith('lv:')).some((r) => r.text.includes('\u2192')),
      live.rows.filter((r) => r.key.startsWith('lv:')).map((r) => r.text).join(' | '));
  }

  // --- FOUR ROWS ------------------------------------------------------------
  // Harp Seal moves seven things and the boat six; six is already a tall box on
  // a phone, and it is held under a thumb.
  {
    const deep = tipFor('bakalar', 4);
    const table = deep.rows.filter((r) => r.key.startsWith('lv:'));
    check('a tip carries at most four measured rows', table.length <= 4,
      table.map((r) => r.label.replace('[DRAFT] ', '')).join(' | '));
    check('...in the order the readout declares, not sorted by size',
      table[0].label.includes('bomb damage'),
      table.map((r) => r.label.replace('[DRAFT] ', '')).join(' | '));
  }

  player.upgrades.length = 0;
  player.level = 1;
  recomputeStats();
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
section('the hive is the WHOLE build, and the only copy of it');
{
  // THE HEXAGONS ARE NOW THE ONLY ACCOUNT OF WHAT WAS PICKED — the text list
  // that stood beside them in the readout's second column is gone. So the trap
  // that list was written to close is this block's to hold: anything built from
  // SOURCE_UPGRADES sees the ~30 abilities with a damage tag and nothing else.
  // Yoga (`oxygenMax`) is the check: no damage tag, no kills, and a pick of it
  // is still a third of a build.
  const held = [...document.querySelectorAll('.sv-fan-hive .sv-hive-tile')]
    .map((t) => t.dataset.upgrade);
  check('the damage ability has a hexagon', held.includes('shrimpRing'), held.join(' | '));
  check('...and so does the stat card with no damage tag',
    held.includes('oxygenMax'), held.join(' | '));
  // ONE TILE PER CARD, whatever the stack depth — two picks of shrimpRing are
  // one hexagon standing two deep, which is what the count on its tip reads.
  check('a stack is one hexagon, not one per pick', held.length === 2, held.join(' | '));
  // AND NO SECOND COPY IN THE READOUT. A list that comes back is two answers to
  // one question a scroll apart, free to disagree about the count.
  check('there is no build list beside it',
    document.getElementById('svPanelBuild') === null);
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
