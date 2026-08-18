#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:hive
//
// THE CORNER THAT SHOWS THE BUILD YOU ARE HOLDING.
//
// Driven end to end: the real ui.js builds the mount, the real upgradeHive.js
// lays the tiles out, and the real feedback() is what makes one flash — so a
// renamed event or a dropped listener fails here rather than in a run.
//
// SIX THINGS, each of which looks like working code from the outside:
//
//   THE EVENT MAP GOES STALE SILENTLY   Every entry in EVENT_UPGRADE names a
//                                   feedback event AND an upgrade id. Either
//                                   can be renamed by work that has nothing to
//                                   do with the hive, and both failures are
//                                   invisible: the tile simply never flashes.
//                                   Both sides are checked against CONFIG here.
//
//   A PULSE THAT CANNOT RE-FIRE     Restarting a running CSS animation needs a
//                                   forced reflow between the class coming off
//                                   and going back on. Without it the second
//                                   shot inside the first flash produces no
//                                   second flash — which on a fast weapon means
//                                   the tile flashes once and then looks dead.
//
//   STACKS FOLD, TIERS DO NOT       Six picks of one ability are one tile, and
//                                   the tier kept has to be the BEST seen or a
//                                   Legendary roll disappears behind five
//                                   Commons.
//
//   THE HOST MUST BE SIZED          Tiles are absolutely positioned, so the
//                                   host has no size of its own. Leave it at
//                                   zero and the corner block collapses.
//
//   LAYOUTS MUST NOT OVERLAP        A packing bug reads as "a bit tight" in a
//                                   screenshot and as unreadable in a fight.
//                                   Measured as real rectangles, per layout.
//
//   AN OBSERVER MUST NOT BE ABLE TO KILL THE HIT   feedback() drives the shake,
//                                   the burst and the sound. A HUD listener
//                                   that throws must cost a tile animation and
//                                   nothing else.
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
globalThis.Image = dom.window.Image;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// jsdom has no 2D context and ui.js reaches for one — see dom-stub's note.
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {}, getImageData: (w, h) => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
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
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.map(String).join(' '));

const { CONFIG } = await import('../path/src/config.js');
const { feedback, onFeedback } = await import('../path/src/systems/feedback.js');
const hive = await import('../path/src/ui/upgradeHive.js');
const { UPGRADE_ICONS } = await import('../path/src/ui/upgradeIcons.js');
const ui = await import('../path/src/ui/ui.js');

// Swappable so a later section can be the real main.js for one pick — filing the
// choice and feeding the hive, which is what gives the flight somewhere to land.
let onChoice = () => {};
ui.initUI({
  onStart() {}, onRestart() {}, onResume() {}, onPauseRestart() {},
  onLevelChoice: (c) => onChoice(c),
});

const css = [...document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
const host = () => document.querySelector('.sv-hive-host');
const tiles = () => [...document.querySelectorAll('.sv-hive-tile')];
const tileFor = (id) => document.querySelector(`.sv-hive-tile[data-upgrade="${id}"]`);
const px = (v) => parseFloat(v) || 0;
// The drawn hexagon's placement inside its square box — see HEX_GEOMETRY.
const G = hive.HEX_GEOMETRY;

// ---------------------------------------------------------------------------
section('mounts');
check('hive is in the tree', !!document.querySelector('.sv-hive'));
check('host exists', !!host());
check('hive is NOT inside the HUD corner',
  !document.querySelector('.sv-hud-corner .sv-hive'),
  'a filter there would capture its fixed positioning');

// ---------------------------------------------------------------------------
section('sits under the menus');
// A LAYER NUMBER, NOT DOM ORDER. The hive, the menus, the HUD and the toasts are
// all children of one root, so they share a stacking context — and the hive is
// appended LAST, which means without an explicit ladder it paints over the
// level-up cards and the score card. It shipped at z-index 3 against menus with
// none, which is that bug.
const zOf = (sel) => {
  const rule = css.slice(css.indexOf(sel + ' {'));
  const m = rule.slice(0, rule.indexOf('}')).match(/z-index:\s*(-?\d+)/);
  return m ? Number(m[1]) : null;
};
const zHive = zOf('.sv-hive');
const zCenter = zOf('.sv-center');
const zToast = zOf('.sv-toast-layer');
check('the hive declares a layer', zHive !== null, String(zHive));
check('menus declare one too', zCenter !== null, String(zCenter));
check('the hive is UNDER every menu', zHive < zCenter, `hive ${zHive} vs menus ${zCenter}`);
check('and under the toasts', zHive < zToast, `hive ${zHive} vs toasts ${zToast}`);

section('folds picks into tiles');
const picks = [
  { id: 'shrimpRing', rarity: 'common' },
  { id: 'shrimpRing', rarity: 'legendary' },
  { id: 'shrimpRing', rarity: 'common' },
  { id: 'club', rarity: 'rare' },
  { id: 'seaGarlic', rarity: 'uncommon' },
];
hive.setHiveUpgrades(picks);
check('one tile per ability, not per pick', tiles().length === 3, `${tiles().length} tiles from 5 picks`);
const shrimp = tileFor('shrimpRing');
check('stack count is shown', shrimp?.querySelector('.sv-hive-pip')?.textContent === '3');
const folded = hive.foldUpgrades(picks).find((f) => f.id === 'shrimpRing');
check('best tier survives the fold', folded.rarity === 'legendary', `kept ${folded.rarity}`);
check('a single pick has no count badge', !tileFor('club')?.querySelector('.sv-hive-pip'));

// ---------------------------------------------------------------------------
section('marks');
check('an upgrade with a render shows it', !!tileFor('shrimpRing')?.querySelector('.sv-hive-icon'));
check('an upgrade without one falls back to a monogram',
  !!tileFor('seaGarlic')?.querySelector('.sv-hive-mono'),
  'Sea Garlic is an aura — it can never have a render');
check('the monogram comes off the CARD name, not the id',
  tileFor('seaGarlic')?.querySelector('.sv-hive-mono')?.textContent === 'SG');
// The icon module is generated from whatever was rendered; the thing that must
// hold is that every key in it is a real upgrade, or the tile is never found.
const ids = new Set(CONFIG.upgrades.map((u) => u.id));
const orphanIcons = Object.keys(UPGRADE_ICONS).filter((k) => !ids.has(k));
check('every baked icon is keyed to a real upgrade', orphanIcons.length === 0, orphanIcons.join(' '));

// The tier colour must reach the DOM as CSS, not as the number rarityTable.js
// parses it into. A number survives being written to a custom property without
// complaint and is only rejected where the property is USED — which drops the
// whole declaration, fallback included, leaving a tile with no rim and, in the
// rarity style, no face at all. Nothing warns. Checked as a string here because
// jsdom will not resolve the var for us.
hive.setHiveUpgrades([{ id: 'club', rarity: 'legendary' }]);
const tint = tileFor('club').style.getPropertyValue('--sv-hive-rarity');
check('the rarity custom property is a CSS colour', /^#[0-9a-f]{6}$/i.test(tint), `got "${tint}"`);
check('and it is the tier that was dealt', tint.toLowerCase() === '#ffb020', tint);

// ---------------------------------------------------------------------------
section('the event map is still wired to the game');
// Both halves. An event renamed in config.js and an upgrade renamed in
// upgrades.csv are the same silent failure from the hive's side.
const events = new Set(Object.keys(CONFIG.feedback));
const map = hive.EVENT_UPGRADE ?? null;
if (!map) {
  check('EVENT_UPGRADE is exported for auditing', false, 'not exported');
} else {
  const badEvents = Object.keys(map).filter((e) => !events.has(e));
  const badIds = [...new Set(Object.values(map))].filter((i) => !ids.has(i));
  check('every mapped event exists in CONFIG.feedback', badEvents.length === 0, badEvents.join(' '));
  check('every mapped upgrade exists', badIds.length === 0, badIds.join(' '));
}

// ---------------------------------------------------------------------------
section('firing');
hive.setHiveUpgrades([{ id: 'shrimpRing', rarity: 'common' }, { id: 'club', rarity: 'common' }]);
const t = tileFor('shrimpRing');
t.classList.remove('sv-hive-firing');
feedback('shrimpHit', { x: 0, y: 0 });
check('the real feedback event flashes the tile', t.classList.contains('sv-hive-firing'));
check('and only that tile', !tileFor('club').classList.contains('sv-hive-firing'));

// Re-firing while already lit. In jsdom the class never clears on its own (no
// animation runs), so what is actually being checked is that pulseHive does the
// remove/reflow/add dance rather than a bare add — a bare add is a no-op here
// and a no-op in a browser mid-animation, which is the bug.
let reflows = 0;
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { reflows++; return 52; },
});
feedback('shrimpHit', { x: 0, y: 0 });
check('a repeat forces a reflow so the animation restarts', reflows > 0,
  `${reflows} reads of offsetWidth`);
check('and the tile is lit again afterwards', t.classList.contains('sv-hive-firing'));

// An event belonging to no upgrade must not touch the hive at all.
const before = tiles().filter((n) => n.classList.contains('sv-hive-firing')).length;
feedback('uiHover');
check('an unmapped event flashes nothing new',
  tiles().filter((n) => n.classList.contains('sv-hive-firing')).length === before);

// ---------------------------------------------------------------------------
section('a broken listener cannot take the hit down');
const off = onFeedback(() => { throw new Error('listener blew up'); });
let survived = true;
try { feedback('shrimpHit', { x: 0, y: 0 }); } catch { survived = false; }
off();
check('feedback survives a throwing observer', survived);
check('and says so', warnings.some((w) => w.includes('listener failed')));

// ---------------------------------------------------------------------------
section('the art is carried the way the cards carry it');
// The hex art is a flat-top hexagon drawn with a MARGIN inside a square image.
// Two things have to be true or the clip cuts through its dark border: the box
// is square, and it is clipped on the art's vertices rather than on a generic
// full-bleed hexagon. Both were wrong at first and the symptom was an outline
// shaved off two sides and left on the others.
hive.setHiveUpgrades([{ id: 'club', rarity: 'common' }]);
const one = tileFor('club');
check('the tile box is square', px(one.style.width) === px(one.style.height),
  `${one.style.width} x ${one.style.height}`);
// The card's polygon is the reference: it was measured against this same art.
const cardClip = /polygon\(5\.7% 51%, 27\.1% 12\.7%, 72\.3% 12\.7%, 93\.9% 51%, 72\.3% 89\.6%, 27\.1% 89\.6%\)/;
const tileRule = css.slice(css.indexOf('.sv-hive-tile {'), css.indexOf('.sv-hive-face'));
check('the tile is clipped on the art\'s own vertices, like .sv-card',
  cardClip.test(tileRule), 'a full-bleed hexagon here cuts the border');
// And the geometry the layout uses has to be the same shape the CSS draws.
check('the packing geometry matches that clip',
  Math.abs(G.w - (0.939 - 0.057)) < 1e-9 && Math.abs(G.h - (0.896 - 0.127)) < 1e-9);
check('the drawn hexagon is near-regular', Math.abs(G.h / G.w - 0.866) < 0.01,
  `ratio ${(G.h / G.w).toFixed(3)}`);

section('the chosen card flies to its tile');
// The flight is a clone of the card, flown to a MEASURED tile box and swapped
// for the tile on landing. What has to hold, and each of these fails silently:
//
//   the destination is real       hiveTileRect returns null for a hive that is
//                                 off or a tile that isn't there, and the caller
//                                 must treat that as "no flight" rather than
//                                 flying to 0,0.
//   the tile keeps its box        it is hidden with `visibility`, not `display`
//                                 — hiding the box reflows the corner mid-flight
//                                 and the destination goes stale.
//   the tile comes BACK           a flight that never lands leaves an upgrade
//                                 you hold and cannot see.
hive.setHiveUpgrades([{ id: 'club', rarity: 'common' }, { id: 'harp', rarity: 'rare' }]);
check('a held upgrade reports a destination',
  // jsdom gives every element a zero box, so the null here is the ZERO guard
  // firing, not a missing tile — which is exactly the branch that must not fly.
  hive.hiveTileRect('club') === null, 'zero-sized boxes must not be flown to');
check('an upgrade that is not held reports none', hive.hiveTileRect('nosuchUpgrade') === null);

const clubTile = tileFor('club');
hive.setTileVisible('club', false);
check('hiding a tile uses visibility, not display',
  clubTile.style.visibility === 'hidden' && clubTile.style.display !== 'none',
  `visibility "${clubTile.style.visibility}", display "${clubTile.style.display}"`);
hive.setTileVisible('club', true);
check('and it comes back', !clubTile.style.visibility);
check('setTileVisible on an absent id is a no-op', (() => {
  try { hive.setTileVisible('nosuchUpgrade', false); return true; } catch { return false; }
})());

// The flier's CSS has to animate compositor properties only: the run is live
// underneath it, and a left/top animation puts a layout on every frame of the
// busiest moment in the game.
const flierRule = css.slice(css.indexOf('.sv-hive-flier {'), css.indexOf('}', css.indexOf('.sv-hive-flier {')));
check('the flier is position: fixed', /position:\s*fixed/.test(flierRule));
check('and scales from its top-left corner', /transform-origin:\s*0 0/.test(flierRule),
  'a centred origin makes the landing miss by half the size difference');
check('the flight is above the menus it leaves',
  Number((flierRule.match(/z-index:\s*(\d+)/) || [])[1]) > zCenter,
  'it starts life as a card sitting on the menu');
// The curve is a NAME from ease.js, not a hand-written bezier — see cssEase.
const flyCfg = CONFIG.upgradeHive?.fly ?? {};
const { EASINGS } = await import('../path/src/ease.js');
check('the fly curve is a known easing name', EASINGS.includes(flyCfg.ease ?? 'outCubic'),
  String(flyCfg.ease));
check('the flight is short enough to not be in the way', (flyCfg.seconds ?? 0.34) <= 0.5,
  `${flyCfg.seconds}s`);

section('the landing is exact');
// Real geometry, which the DOM cannot give us here: a 210px card sitting in the
// middle of a 1280x800 screen, and a 59px tile down in the bottom-left corner.
// The transform has to map the card's box ONTO the tile's box — every corner,
// not just the one it is anchored by.
{
  const card = { left: 421, top: 260, width: 210, height: 210 };
  const tile = { left: 14, top: 706, width: 58.96, height: 58.96 };
  const m = hive.flyTransform(card, tile);
  // Where each corner of the card ends up, under transform-origin 0 0.
  const map = (x, y) => ({
    x: card.left + m.dx + (x - card.left) * m.scale,
    y: card.top + m.dy + (y - card.top) * m.scale,
  });
  const tl = map(card.left, card.top);
  const br = map(card.left + card.width, card.top + card.height);
  const near = (a, b) => Math.abs(a - b) < 0.01;
  check('the top-left corner lands on the tile\'s',
    near(tl.x, tile.left) && near(tl.y, tile.top),
    `(${tl.x.toFixed(2)}, ${tl.y.toFixed(2)}) vs (${tile.left}, ${tile.top})`);
  check('and so does the bottom-right',
    near(br.x, tile.left + tile.width) && near(br.y, tile.top + tile.height),
    `(${br.x.toFixed(2)}, ${br.y.toFixed(2)}) vs (${(tile.left + tile.width).toFixed(2)}, ${(tile.top + tile.height).toFixed(2)})`);
  check('which means the hexagons coincide, not just the boxes',
    near(m.scale, tile.width / card.width),
    'both are square and share the clip polygon, so one scale does both');
  // The failure this guards against, spelled out: a centred origin.
  const centred = {
    x: card.left + m.dx + (card.left - (card.left + card.width / 2)) * m.scale + card.width / 2,
  };
  check('a centred origin would MISS — this is why the CSS says 0 0',
    Math.abs(centred.x - tile.left) > 1, `off by ${Math.abs(centred.x - tile.left).toFixed(0)}px`);
}

section('the flight actually runs');
// THE TEST THAT WOULD HAVE CAUGHT THE REAL BUG, and the reason it did not:
// every element in jsdom measures zero, so hiveTileRect() returned null and
// flyCardToHive bailed at its first guard — one line before the call that threw.
// A guard short-circuiting the code under test is a green suite over a feature
// that does nothing, so the boxes are stubbed here and the whole path runs.
{
  const CARD = { left: 421, top: 260, width: 210, height: 210, right: 631, bottom: 470 };
  const TILE = { left: 14, top: 706, width: 59, height: 59, right: 73, bottom: 765 };
  const real = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('sv-hive-tile')) return { ...TILE, x: TILE.left, y: TILE.top };
    if (this.classList?.contains('sv-card')) return { ...CARD, x: CARD.left, y: CARD.top };
    return real.call(this);
  };

  const picks = [];
  onChoice = (choice) => { picks.push({ id: choice.id, rarity: choice.rarity }); hive.setHiveUpgrades(picks); };

  hive.setHiveUpgrades([]);
  ui.showLevelUp();
  // The deal locks the menu until the cards have finished arriving; a click
  // before then is ignored on purpose (see setMenuLocked), so let it settle.
  await new Promise((r) => setTimeout(r, 400));
  const cards = [...document.querySelectorAll('.sv-card')];
  check('a hand was dealt', cards.length > 0, `${cards.length} cards`);

  const chosen = cards[0];
  const chosenId = chosen?.dataset?.upgrade ?? null;
  chosen?.click();
  await new Promise((r) => setTimeout(r, 30));

  const flier = document.querySelector('.sv-hive-flier');
  check('a flier was appended', !!flier, 'this is the call that used to throw');
  check('the pick was filed', picks.length === 1, JSON.stringify(picks));
  if (flier) {
    check('it starts at the card, in fixed position',
      flier.style.position === '' && flier.style.left === `${CARD.left}px`
        && flier.style.top === `${CARD.top}px`,
      `left ${flier.style.left}, top ${flier.style.top}`);
    check('it is sized to the card', flier.style.width === `${CARD.width}px`);
    check('and it is not a live card any more',
      !flier.classList.contains('sv-card') && flier.classList.contains('sv-hive-flier'));
  }
  const id = picks[0]?.id;
  const tileNow = id ? tileFor(id) : null;
  check('the destination tile is hidden for the trip',
    !!tileNow && tileNow.style.visibility === 'hidden',
    tileNow ? `visibility "${tileNow.style.visibility}"` : 'no tile');

  // jsdom runs no CSS transitions, so transitionend never fires — which is
  // exactly the case the timeout backstop exists for. If it did not land, an
  // upgrade you hold would stay invisible for the rest of the run.
  await new Promise((r) => setTimeout(r, 700));
  check('the flier is gone after the flight', !document.querySelector('.sv-hive-flier'));
  check('and the tile is visible again — the backstop landed it',
    !!tileNow && !tileNow.style.visibility,
    tileNow ? `visibility "${tileNow.style.visibility}"` : 'no tile');

  dom.window.Element.prototype.getBoundingClientRect = real;
  onChoice = () => {};
  hive.setHiveUpgrades([]);
}

section('the corner makes room, then feels the impact');
// Driven through the real setHiveUpgrades, with the boxes stubbed so the tiles
// have positions to move BETWEEN — the lesson from the flight test, where a
// guard short-circuited the whole feature and the suite stayed green.
{
  const real = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('sv-hive-tile')) {
      return { left: 14, top: 706, width: 59, height: 59, right: 73, bottom: 765, x: 14, y: 706 };
    }
    return real.call(this);
  };

  // A cluster big enough that adding one more re-rings it and most tiles move.
  const start = ['shrimpRing', 'club', 'seaGarlic', 'harp', 'dumbo', 'beluga', 'octoGrab']
    .map((id) => ({ id, rarity: 'common' }));
  hive.setHiveUpgrades([]);
  hive.setHiveUpgrades(start);
  const posBefore = new Map([...tiles()].map((t) => [t.dataset.upgrade, t.style.left + ',' + t.style.top]));

  hive.setHiveUpgrades([...start, { id: 'bakalar', rarity: 'rare' }]);
  const after = [...tiles()];
  const posAfter = new Map(after.map((t) => [t.dataset.upgrade, t.style.left + ',' + t.style.top]));

  let relaid = 0;
  for (const [id, p] of posBefore) if (posAfter.get(id) && posAfter.get(id) !== p) relaid++;
  check('adding a tile really does move the others', relaid > 0, `${relaid} tiles re-placed`);

  // The FLIP leaves its evidence in the TRANSITION, not the transform. The
  // offset is written and cleared inside the same tick — that IS the mechanism:
  // set the old position, force one reflow, release to the new one and let the
  // browser interpolate. Asserting on `transform` here reads the end state and
  // concludes nothing happened, which is how a working FLIP looks broken.
  const animated = after.filter((t) => /transform/.test(t.style.transition || ''));
  check('every tile that moved is animating there',
    animated.length === relaid, `${animated.length} animating vs ${relaid} moved`);
  check('the newcomer is not — it has no old place to come from',
    !/transform/.test(tileFor('bakalar')?.style.transition || ''));
  check('the transition drives transform, never left/top',
    animated.length > 0 && animated.every((t) => /^transform /.test(t.style.transition)),
    'animating left/top would lay the corner out on every frame of it');

  // Staggered, and ordered by distance from the newcomer rather than by index.
  const delays = animated.map((t) =>
    parseFloat((t.style.transition.match(/\s([\d.]+)s\s*$/) || [])[1] || '0'));
  check('they start a few milliseconds apart, not together',
    new Set(delays).size > 1, `delays ${delays.map((d) => d.toFixed(3)).join(' ')}`);
  check('the furthest tile starts last',
    Math.max(...delays) > Math.min(...delays),
    `${Math.min(...delays).toFixed(3)}s .. ${Math.max(...delays).toFixed(3)}s`);

  // The arrival. Slam on the newcomer, ripple outward on the rest.
  hive.slamAndRipple('bakalar');
  check('the newcomer slams', tileFor('bakalar').classList.contains('sv-hive-arriving'));
  check('and nothing else has slammed', after.filter((t) =>
    t.classList.contains('sv-hive-arriving')).length === 1);
  check('the wave has not started yet — it follows the slam',
    after.every((t) => !t.classList.contains('sv-hive-rippling')),
    'firing together reads as the whole panel flashing');

  await new Promise((r) => setTimeout(r, 500));
  const rippled = after.filter((t) => t.classList.contains('sv-hive-rippling')
    || t.dataset.rippled === '1').length;
  check('then the rest of the hive ripples', rippled > 0, `${rippled} tiles`);

  dom.window.Element.prototype.getBoundingClientRect = real;
  hive.setHiveUpgrades([]);
}

section('layouts pack without overlapping');
// Twenty-two picks is a full late run, and the number at which a packing bug
// stops being subtle.
const many = ['shrimpRing', 'club', 'seaGarlic', 'harp', 'dumbo', 'beluga', 'octoGrab',
  'bakalar', 'orcaFamily', 'maneater', 'ironLung', 'electricEel', 'seagullBomb', 'sealTeam',
  'scallopSquirter', 'calamari', 'clubBoom', 'clubIce', 'clubThrow', 'oysterBlaster',
  'homingMissile', 'laserEyes'].map((id) => ({ id, rarity: 'common' }));

// THE VISIBLE HEXAGON, not the box.
//
// The art is drawn with a margin inside a square image, so a tile's box is
// bigger than the shape on screen and neighbouring BOXES overlap by a lot —
// correctly. Measuring boxes here would fail a perfectly good packing, and
// (worse) would pass a bad one that happened to keep its boxes apart, which is
// a hive with visible gaps between the tiles.
const rectOf = (n) => {
  const box = px(n.style.width);
  return {
    x: px(n.style.left) + box * G.left,
    y: px(n.style.top) + box * G.top,
    w: box * G.w,
    h: box * G.h,
  };
};
// Hexes interlock, so their bounding boxes legitimately touch and may share an
// edge. What must never happen is two tiles at the SAME POINT, or boxes
// overlapping by more than the interlock — a quarter of a tile is the most a
// correct flat-top packing ever shares.
const overlapArea = (a, b) => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
};

for (const layout of ['cluster', 'rows', 'arc']) {
  hive.setHiveLayout(layout);
  hive.setHiveUpgrades(many);
  const ns = tiles();
  const rs = ns.map(rectOf);
  const area = rs[0].w * rs[0].h;
  let worst = 0, dupes = 0;
  const seen = new Set();
  for (let i = 0; i < rs.length; i++) {
    const k = `${Math.round(rs[i].x)},${Math.round(rs[i].y)}`;
    if (seen.has(k)) dupes++;
    seen.add(k);
    for (let j = i + 1; j < rs.length; j++) worst = Math.max(worst, overlapArea(rs[i], rs[j]));
  }
  check(`${layout}: every tile placed`, ns.length === many.length, `${ns.length}/${many.length}`);
  check(`${layout}: no two tiles at the same point`, dupes === 0, `${dupes} duplicates`);
  check(`${layout}: worst overlap is interlock, not collision`, worst <= area * 0.3,
    `${(worst / area * 100).toFixed(0)}% of a tile`);
  const hw = px(host().style.width), hh = px(host().style.height);
  const maxX = Math.max(...rs.map((r) => r.x + r.w));
  const maxY = Math.max(...rs.map((r) => r.y + r.h));
  check(`${layout}: host is sized to its tiles`, hw >= maxX - 0.5 && hh >= maxY - 0.5,
    `host ${hw}x${hh}, tiles reach ${maxX.toFixed(0)}x${maxY.toFixed(0)}`);
  check(`${layout}: nothing placed at a negative offset`,
    rs.every((r) => r.x >= -0.5 && r.y >= -0.5));
}

// ---------------------------------------------------------------------------
section('a corner has to stay a corner');
// The whole brief is "fits in a corner". A late build must not grow into the
// middle of a 1280x800 screen, and `rows` and `arc` are the two that can.
hive.setHiveLayout('cluster');
hive.setHiveUpgrades(many);
const w = px(host().style.width), h = px(host().style.height);
check('a 22-pick cluster stays inside a quarter of a 1280x800 screen',
  w <= 640 && h <= 400, `${w}x${h}`);

// ---------------------------------------------------------------------------
section('clears between runs');
hive.setHiveUpgrades([]);
check('an empty pick list leaves no tiles', tiles().length === 0);

console.warn = realWarn;
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
