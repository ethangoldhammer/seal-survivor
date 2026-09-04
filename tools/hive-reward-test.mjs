#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:dividend
//
// THE BOSS DIVIDEND — the hive coming to the middle of the screen to be spent.
//
// Driven end to end on the jsdom recipe, like tools/hive-test.mjs: the real
// ui.js builds the mount and the stylesheet, the real upgradeHive.js lays the
// tiles out, and the real hiveReward.js picks them up. Nothing here is a stub
// except the caller's own two callbacks, which is the point — the ceremony's
// whole job is to sit between real tiles and a real build.
//
// EIGHT THINGS, and every one of them fails as working-looking code:
//
//   THE RAMP IS THE FEATURE          One stack for the first boss, two for the
//                                    second, three for the third. Checked as
//                                    arithmetic rather than by beating four
//                                    bosses, which is why it is a pure export.
//
//   THE LISTENER MUST SURVIVE A REBUILD   Taking a stack rebuilds every tile in
//                                    the hive from scratch (see rebuild), so a
//                                    per-tile click handler is bound to a
//                                    detached node by the second pick — the
//                                    first click works, the second silently
//                                    does nothing, and the run is stuck in a
//                                    menu it can never spend down. Delegation
//                                    on the host is the fix and this is the
//                                    test that says so.
//
//   A CAP MUST STOP A CLICK          A card at maxStacks is still in the hive
//                                    and still under the pointer. Nothing about
//                                    a capped tile looks unclickable to the
//                                    code; the ceremony has to ask.
//
//   IT MUST CLOSE WHEN NOTHING IS LEFT    A build of capped cards with stacks
//                                    still owed would otherwise hold the run
//                                    still in front of a menu where every click
//                                    is a no-op.
//
//   IT MUST REFUSE TO OPEN AT ALL    ...for the same reason, one step earlier —
//                                    and it has to say so, because a caller
//                                    that paused before asking would pause
//                                    forever.
//
//   THE TRANSFORM MUST SURVIVE THE MEASUREMENT   The centring re-measures the
//                                    hive on every pick, which means taking its
//                                    own transform off to read the layout box.
//                                    Restore the transition too early and the
//                                    browser animates the round trip: the hive
//                                    snaps to the corner and flies out again on
//                                    every stack.
//
//   THE GLOW MUST NOT BE A FILTER    Every tile is clipped to its own hexagon
//                                    and `filter` is applied BEFORE `clip-path`,
//                                    so a drop-shadow on the tile is painted and
//                                    then cut away. It renders nothing and warns
//                                    nowhere.
//
//   THE RUN MUST COME BACK           `onDone` is the only thing that unpauses,
//                                    and the pointer has to leave the hive on
//                                    the same frame — the seal steers with the
//                                    mouse.
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

let clock = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock }, configurable: true, writable: true,
});

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
const hive = await import('../path/src/ui/upgradeHive.js');
const reward = await import('../path/src/ui/hiveReward.js');
const ui = await import('../path/src/ui/ui.js');

ui.initUI({
  onStart() {}, onRestart() {}, onResume() {}, onPauseRestart() {},
  onLevelChoice() {},
});

const css = [...document.querySelectorAll('style')].map((n) => n.textContent).join('\n');
const root = () => document.querySelector('.sv-hive');
const host = () => document.querySelector('.sv-hive-host');
const tileFor = (id) => document.querySelector(`.sv-hive-tile[data-upgrade="${id}"]`);
const halos = () => [...document.querySelectorAll('.sv-hive-halo')];
const clickTile = (id) => {
  // On the FACE, not on the tile — a real click lands on whichever child is
  // under the pointer, and the delegation has to walk back up to the hexagon.
  const el = tileFor(id);
  const target = el?.querySelector('.sv-hive-face') ?? el;
  target?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

// The build the ceremony is held over. `shrimpRing` and `club` are stackable;
// `sealTeam` is pinned at its cap below so there is always one tile that must
// refuse to be clicked.
const CAPPED = 'sealTeam';
const cappedDef = CONFIG.upgrades.find((u) => u.id === CAPPED);
const cap = cappedDef?.maxStacks ?? 3;
let picks = [];
const rebuildFrom = () => hive.setHiveUpgrades(picks);
const countOf = (id) => picks.filter((p) => p.id === id).length;
// The real rule, straight out of entities/player.js's shape: a card can take
// another stack while it is under its own ceiling.
const canStack = (id) => {
  const def = CONFIG.upgrades.find((u) => u.id === id);
  if (!def || def.enabled === false) return false;
  return def.maxStacks == null || countOf(id) < def.maxStacks;
};
const taken = [];
const onStack = (id) => {
  if (!canStack(id)) return false;
  taken.push(id);
  picks.push({ id, rarity: 'epic' });
  rebuildFrom();
  return true;
};

const setBuild = (list) => {
  picks = list.map((id) => ({ id, rarity: 'epic' }));
  taken.length = 0;
  rebuildFrom();
};

// ---------------------------------------------------------------------------
section('the ramp');
// The whole ask: one stack after the first boss, two after the second, three
// after the third. Read off the shipped config rather than off a local copy of
// it, so a retune moves the expectation with the game.
{
  const d = CONFIG.boss?.dividend ?? {};
  check('the dividend is on', d.enabled !== false);
  check('the first boss pays one stack', reward.bossDividendStacks(1) === 1,
    String(reward.bossDividendStacks(1)));
  check('the second pays two', reward.bossDividendStacks(2) === 2,
    String(reward.bossDividendStacks(2)));
  check('the third pays three', reward.bossDividendStacks(3) === 3,
    String(reward.bossDividendStacks(3)));
  check('and it keeps climbing', reward.bossDividendStacks(5) === 5,
    String(reward.bossDividendStacks(5)));
  check('no bosses, no payout', reward.bossDividendStacks(0) === 0);
  // The ramp has no natural end, so a long run would be handed a dozen picks in
  // one menu — not a choice, a chore.
  const capStacks = d.maxStacks ?? 0;
  check('a single payout is capped', capStacks > 0 && reward.bossDividendStacks(99) === capStacks,
    `${reward.bossDividendStacks(99)} vs cap ${capStacks}`);
}

// ---------------------------------------------------------------------------
section('it refuses to open when there is nothing to spend on');
// EVERY ONE OF THESE MUST RETURN FALSE, because the caller pauses the run only
// once it is told the ceremony has it. A silent no-op that still returned true
// would leave the game frozen behind a menu that never appeared.
{
  hive.clearHive();
  hive.setHiveUpgrades([]);
  check('an empty hive is not a menu',
    reward.startHiveReward({ stacks: 2, canStack, onStack, onDone() {} }) === false);

  setBuild(Array(cap).fill(CAPPED));
  check('a build of nothing but capped cards is not a menu',
    reward.startHiveReward({ stacks: 2, canStack, onStack, onDone() {} }) === false);

  setBuild(['shrimpRing']);
  check('nor is a payout of zero stacks',
    reward.startHiveReward({ stacks: 0, canStack, onStack, onDone() {} }) === false);

  root().classList.add('sv-hidden');
  check('nor is a hive the player switched off',
    reward.startHiveReward({ stacks: 1, canStack, onStack, onDone() {} }) === false);
  root().classList.remove('sv-hidden');
  check('and none of that left the ceremony running', !reward.hiveRewardActive());
}

// ---------------------------------------------------------------------------
section('it opens, and only the offerable tiles are offered');
let done = 0;
{
  setBuild(['shrimpRing', 'club', ...Array(cap).fill(CAPPED)]);
  const opened = reward.startHiveReward({
    stacks: 2, canStack, onStack, onDone: () => { done++; },
  });
  check('it opens', opened === true);
  check('the ceremony is live', reward.hiveRewardActive());
  check('the hive is flagged as a menu', root().dataset.reward === 'on');
  check('it is carrying a transform', /translate/.test(root().style.transform),
    root().style.transform.slice(0, 40));
  check('...on a transition, so it flies rather than teleports',
    /transform/.test(root().style.transition), root().style.transition);

  check('a stackable tile is open', tileFor('shrimpRing').dataset.reward === 'open');
  check('a capped tile is not', tileFor(CAPPED).dataset.reward === 'capped',
    tileFor(CAPPED).dataset.reward);
  check('one halo per offerable tile, and no more', halos().length === 2,
    `${halos().length} halos for 3 tiles`);
  // Sibling, not child: a halo inside the tile is clipped away by the tile's own
  // hexagon and is simply never painted.
  check('the halo is a sibling of its tile, not a child',
    halos().every((h) => h.parentElement === host()));
  // OVER the lattice, not behind it. A hexagon in a cluster is ringed by
  // neighbours, and every tile painted after it covers that side of the glow —
  // behind its own tile the halo leaks out of one corner of the hive and
  // nowhere else. What keeps it off the icon is the hole in the middle, checked
  // against the stylesheet below.
  check('every halo is painted after every tile', (() => {
    const kids = [...host().children];
    const lastTile = kids.map((k) => k.classList.contains('sv-hive-tile')).lastIndexOf(true);
    return halos().every((h) => kids.indexOf(h) > lastTile);
  })(), 'behind its own tile the glow is covered by whichever neighbour paints next');
  check('it inherits nothing — the tier colour is copied onto it',
    halos().every((h) => /#|rgb/.test(h.style.getPropertyValue('--sv-hive-rarity'))),
    'a sibling inherits from the host and would come out the fallback grey');
}

// ---------------------------------------------------------------------------
section('clicking a tile stacks it — twice');
// THE SECOND CLICK IS THE TEST. The first pick rebuilds every tile in the hive,
// so a handler bound per tile is on a detached node by now: click one, nothing
// happens, and the run is stuck in a menu it can never spend down.
{
  const before = countOf('shrimpRing');
  clickTile('shrimpRing');
  check('the first click files a stack', taken.length === 1 && taken[0] === 'shrimpRing',
    taken.join(','));
  check('the build actually deepened', countOf('shrimpRing') === before + 1);
  check('the ceremony is still up with one stack left', reward.hiveRewardActive());
  check('the tiles were rebuilt under it and re-marked',
    tileFor('shrimpRing').dataset.reward === 'open');
  check('and the halos came back with them', halos().length === 2, `${halos().length}`);
  check('the hive is still centred, not snapped home',
    /translate/.test(root().style.transform), root().style.transform.slice(0, 40));
  check('...and its flight transition survived the re-measurement',
    /transform/.test(root().style.transition) && !/none/.test(root().style.transition),
    root().style.transition);

  clickTile('club');
  check('the second click lands on the rebuilt tiles', taken.length === 2 && taken[1] === 'club',
    taken.join(','));
  check('spending the last stack closes it', !reward.hiveRewardActive());
  check('the run was handed back exactly once', done === 1, String(done));
  check('the hive is on its way home', root().dataset.reward === 'out');
  check('with the transform cleared so it eases back to the corner',
    root().style.transform === '', `"${root().style.transform}"`);
  check('and it has stopped taking the pointer', root().dataset.reward !== 'on',
    'the seal steers with the mouse from this frame');
  check('every tile lost its offer marking',
    ![...document.querySelectorAll('.sv-hive-tile')].some((t) => t.dataset.reward));
  check('and every halo went with it', halos().length === 0);
}

// ---------------------------------------------------------------------------
section('a capped tile refuses');
{
  done = 0;
  setBuild(['shrimpRing', ...Array(cap).fill(CAPPED)]);
  reward.startHiveReward({ stacks: 1, canStack, onStack, onDone: () => { done++; } });
  const before = taken.length;
  clickTile(CAPPED);
  check('clicking a capped stack files nothing', taken.length === before, taken.join(','));
  check('and does not spend the payout', reward.hiveRewardActive());
  clickTile('shrimpRing');
  check('an open tile still works right after it', taken.length === before + 1);
  check('which closes the ceremony', !reward.hiveRewardActive());
}

// ---------------------------------------------------------------------------
section('it closes early when the build runs out of room');
// Reachable: a payout of three over a build with one pick left in it. The honest
// answer is to close, not to hold the run still in front of a dead menu.
{
  done = 0;
  const almost = Math.max(1, cap - 1);
  setBuild([...Array(almost).fill(CAPPED)]);
  const opened = reward.startHiveReward({
    stacks: 3, canStack, onStack, onDone: () => { done++; },
  });
  check('it opens on the one card that can still take a pick', opened === true);
  clickTile(CAPPED);
  check('that pick capped it', !canStack(CAPPED));
  check('so the ceremony closed with stacks still owed', !reward.hiveRewardActive());
  check('and gave the run back', done === 1, String(done));
}

// ---------------------------------------------------------------------------
section('a hard reset leaves nothing behind');
{
  setBuild(['shrimpRing', 'club']);
  reward.startHiveReward({ stacks: 2, canStack, onStack, onDone: () => { done++; } });
  const was = done;
  reward.resetHiveReward();
  check('the ceremony is down', !reward.hiveRewardActive());
  check('the hive is back in the corner',
    root().style.transform === '' && !root().dataset.reward);
  check('the transition is off it too', root().style.transition === '');
  check('the banner and the scrim are gone',
    !document.querySelector('.sv-hive-reward') && !document.querySelector('.sv-hive-reward-scrim'));
  check('no halos survive', halos().length === 0);
  // A restart is already deciding what happens next; a callback that unpaused
  // the run being torn down would be a second hand on the same switch.
  check('and it did NOT call the caller back', done === was, `${done} vs ${was}`);
}

// ---------------------------------------------------------------------------
section('a second boss inside the first flight home');
// The chrome outlives the ceremony by the length of the trip back to the corner,
// and a boss dying inside that window used to cancel the timer that was the only
// thing still holding the old nodes — leaving a dead scrim over the game for the
// rest of the run, with nothing on fire anywhere.
{
  setBuild(['shrimpRing', 'club']);
  reward.startHiveReward({ stacks: 1, canStack, onStack, onDone() {} });
  clickTile('shrimpRing');                    // closes; the chrome is now fading
  check('the chrome is still in the tree, fading', !!document.querySelector('.sv-hive-reward'));
  reward.startHiveReward({ stacks: 1, canStack, onStack, onDone() {} });
  check('a second ceremony opens over it', reward.hiveRewardActive());
  check('and there is exactly one banner',
    document.querySelectorAll('.sv-hive-reward').length === 1,
    String(document.querySelectorAll('.sv-hive-reward').length));
  check('and exactly one scrim',
    document.querySelectorAll('.sv-hive-reward-scrim').length === 1,
    String(document.querySelectorAll('.sv-hive-reward-scrim').length));
  reward.resetHiveReward();
  check('and a reset takes every last one of them',
    !document.querySelector('.sv-hive-reward, .sv-hive-reward-scrim'));
}

// ---------------------------------------------------------------------------
section('the stylesheet');
const rule = (sel) => {
  const at = css.indexOf(sel + ' ');
  if (at < 0) return '';
  const open = css.indexOf('{', at);
  return css.slice(open, css.indexOf('}', open));
};
{
  check('the lit hexagon brightens and does not scale',
    /filter:\s*brightness/.test(rule('.sv-hive[data-reward="on"] .sv-hive-tile.sv-hive-hot'))
      && !/transform/.test(rule('.sv-hive[data-reward="on"] .sv-hive-tile.sv-hive-hot')),
    'a tile that grew would slide off its own pile, which is a set of siblings');
  // filter runs BEFORE clip-path, so a glow drawn on the tile is cut away by
  // the tile's own hexagon — painted, clipped, and invisible with no warning.
  check('the glow is a gradient on a sibling, not a drop-shadow on the tile',
    /radial-gradient/.test(rule('.sv-hive-halo')) && !/drop-shadow/.test(rule('.sv-hive-halo')));
  check('the halo carries no z-index of its own',
    !/z-index/.test(rule('.sv-hive-halo')),
    'last in the host is already the top; a z-index lifts the invisible ones too');
  // A filled blob painted over its own tile fogs the icon the glow is pointing
  // at, and the hole has to clear the hexagon's POINTS, which reach further than
  // its flats — measured at 48% of the halo's radius at the default spread.
  check('and it is a ring — transparent across the middle', (() => {
    const m = rule('.sv-hive-halo').match(/rgba\(0,0,0,0\)\s*0\s*(\d+)%/);
    return m && Number(m[1]) >= 48;
  })(), rule('.sv-hive-halo').replace(/\s+/g, ' ').slice(0, 120));
  check('the menu state takes the pointer',
    /pointer-events:\s*auto/.test(rule('.sv-hive[data-reward="on"]')));
  check('...and the flight home does not',
    !/pointer-events/.test(rule('.sv-hive[data-reward="out"]')),
    'the run is live again from that frame and the mouse steers the seal');
  // The transform being animated is meaningless if the origin moves halfway
  // through it, so the attribute has to outlive the trip home.
  check('transform-origin is pinned for BOTH states',
    /transform-origin:\s*0 0/.test(rule('.sv-hive[data-reward]')));
  check('the banner sets no type of its own',
    !/font-family|font-size|font:/.test(rule('.sv-hive-reward')),
    'it wears .sv-title / .sv-sub so the typography panel still owns it');
  check('the hive still declares its resting layer under the menus',
    /z-index:\s*1\b/.test(rule('.sv-hive')));
}

// ---------------------------------------------------------------------------
section('nothing warned');
const noise = warnings.filter((w) => /feedback|hive|upgrade/i.test(w));
check('no unknown feedback events or missing upgrades', noise.length === 0,
  noise.slice(0, 3).join(' | '));

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
