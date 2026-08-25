// THE BOSS DIVIDEND — the corner comes to the middle and asks a question.
//
// A boss goes down, the kill shot lets go of the clock, and then the hive that
// has been sitting in the bottom corner all run picks itself up, flies to the
// centre of the screen at two and a half times its size, and waits. Every tile
// that can still take another pick glows when the pointer crosses it; clicking
// one slams a stack onto it. The first boss buys one stack, the second two, the
// third three, and so on — see CONFIG.boss.dividend.
//
// WHY THE HIVE AND NOT A NEW MENU. The alternative is a row of cards like the
// level-up screen, and it would be the wrong question: a card asks "which of
// these three do you want", and this asks "which of the things you ALREADY
// chose do you want more of". The build is the subject, so the build is what
// comes to the middle — and the player has been reading that exact object in
// the corner for the whole run, so there is nothing new to learn at the moment
// the game most wants them to act quickly.
//
// IT IS THE SAME ELEMENTS, MOVED. Not a copy of the hive, not a second hive
// built at menu size: `ui/upgradeHive.js` owns one set of tiles and this
// transforms their shared root. Which is why a stack taken here is visible
// immediately — setHiveUpgrades rebuilds the tiles under our feet, the new
// stack grows its pile, and the corner the hive flies back to already has it.
//
// EVERYTHING IS TRANSFORM AND OPACITY. The trip in, the trip home, the halo and
// the slam are all compositor properties, so the ceremony costs no layout on any
// frame except the ones where a pick actually rebuilds the tiles.
//
// WHAT THIS MODULE DOES NOT DECIDE: whether a tile can take another stack (the
// caller answers `canStack`, because caps live in entities/player.js), what a
// stack DOES (the caller's `onStack`), or whether the run is paused (main.js
// owns the run). This is the presentation and the input, and nothing else.
import { CONFIG } from '../config.js';
import { cssEase } from '../ease.js';
import { feedback } from '../systems/feedback.js';
import { playSfx } from '../systems/audio.js';
import { menuInput } from '../input.js';
import { hiveParts, slamAndRipple } from './upgradeHive.js';
import { showUpgradeTip, hideUpgradeTip } from './upgradeTip.js';

function cfg() {
  return CONFIG.upgradeHive?.reward ?? {};
}

const state = {
  active: false,
  remaining: 0,
  total: 0,
  root: null,
  host: null,
  banner: null,
  scrim: null,
  count: null,       // the digit inside the banner, rewritten per pick
  halos: new Map(),  // upgrade id -> the glow behind its tile
  stops: [],         // the tiles a pad may land on, in reading order
  sel: -1,
  hot: null,         // upgrade id under the pointer or the pad's cursor
  canStack: null,
  onStack: null,
  onDone: null,
  onClick: null,
  onOver: null,
  onOut: null,
  onResize: null,
  homing: null,      // the timer that tidies up once the flight home lands
};

export function hiveRewardActive() {
  return state.active;
}

/**
 * WHAT THE nTH BOSS KILL PAYS, in stacks. Pure, so the ramp can be checked with
 * real numbers rather than by beating four bosses — see tools/hive-reward-test.
 *
 * The nth kill pays n: one stack for the first boss, two for the second, three
 * for the third. FLOORED, so a fractional rate still ramps (0.5 pays 0, 1, 1, 2,
 * 2, 3) rather than rounding up into a bigger payout than the number says, and
 * CAPPED, because the ramp has no natural end — the eighth boss of a long run
 * would otherwise hand over eight picks at once, which is not a choice, it is a
 * chore with a menu around it.
 *
 * `CONFIG.boss.dividend` and not `CONFIG.upgradeHive.reward`: this is what a
 * kill is WORTH, and that whole block is look-and-feel.
 */
export function bossDividendStacks(defeated) {
  const d = CONFIG.boss?.dividend ?? {};
  if (d.enabled === false) return 0;
  const owed = Math.floor(Math.max(0, defeated) * (d.stacksPerBoss ?? 1));
  const cap = d.maxStacks ?? 0;
  return cap > 0 ? Math.min(cap, owed) : owed;
}

// THE BOX AS LAID OUT, with whatever transform is on it taken off first.
//
// The centring is written as "put this corner there and scale by this much",
// which needs the UNTRANSFORMED rectangle — and by the second pick the root is
// already carrying the transform from the first, so getBoundingClientRect on its
// own answers about the flying object rather than about the corner.
//
// THE ORDER OF THE FIVE LINES IS THE WHOLE THING. `transition: none` goes on
// FIRST, so the two writes that follow cannot arm a transition of their own; the
// rect read commits `transform: none` under that suppression; the transform is
// put back and committed by a forced reflow while the suppression still holds;
// and only then does the transition come back. Restore the transition any
// earlier and the browser has seen the transform go to none and back, and it
// animates the round trip — the hive snaps to the corner and flies out again on
// every pick.
//
// Nothing paints in between: layout is not paint, and the browser cannot render
// a frame in the middle of a task.
function layoutRect(el) {
  const transition = el.style.transition;
  const transform = el.style.transform;
  el.style.transition = 'none';
  el.style.transform = 'none';
  const r = el.getBoundingClientRect();
  el.style.transform = transform;
  void el.offsetWidth;
  el.style.transition = transition;
  return r;
}

// WHERE THE HIVE GOES, as one transform.
//
// `transform-origin: 0 0` (set in the CSS for the data-reward state) is what
// makes this exact rather than approximate — the same reason flyTransform in
// upgradeHive.js pins the top-left. With a centred origin the scale pulls the
// box back toward its own middle and the landing misses by half the difference
// in size, which on a 2.4x blow-up is most of the screen.
//
// IT IS CENTRED IN WHAT IS LEFT UNDER THE BANNER, NOT IN THE VIEWPORT. Those are
// the same thing on a desktop and they are not on a laptop in a small window,
// where the headline and the top row of the hive land on each other. Keeping the
// hive out of the banner's way by SHRINKING it does not work either: a smaller
// hive centred on the whole screen still has its top row where the words are.
//
// AND THE BANNER IS MEASURED RATHER THAN GUESSED. Its height is the game's own
// menu type at whatever size the typography panel is set to (see .sv-title), so
// any number written here would be a copy of a value the tuner can move — and it
// would be wrong in the direction that overlaps, silently, on whichever machine
// had the larger setting.
//
// THE SCALE IS A CEILING, NOT A PROMISE. A build twenty picks deep is a wide
// corner and a phone is a narrow screen, so the configured blow-up is clamped by
// what actually fits in that band. A hive that overflowed the viewport would put
// its own tiles off-screen, which is the one failure this menu cannot survive:
// the pick you need might be the one past the edge.
function centreTransform() {
  const c = cfg();
  const r = layoutRect(state.root);
  const w = Math.max(1, r.width);
  const h = Math.max(1, r.height);
  const pad = c.pad ?? 40;
  const banner = state.banner?.getBoundingClientRect();
  const top = Math.max(pad, (banner?.bottom ?? 0) + (c.gap ?? 26));
  const band = Math.max(1, window.innerHeight - pad - top);
  const room = Math.max(0.4, Math.min(
    c.scale ?? 2.4,
    (window.innerWidth - pad * 2) / w,
    band / h,
  ));
  const x = (window.innerWidth - w * room) / 2 - r.left;
  const y = top + (band - h * room) / 2 + (c.bias ?? 0) - r.top;
  return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${room.toFixed(4)})`;
}

// The window changing shape under an open ceremony — a rotated phone, a resized
// window. The centring is a one-shot transform worked out against the viewport
// it was opened in, so without this the hive simply stays where it was: on a
// narrower screen that is a menu with tiles hanging off the edge, and the pick
// the player wants may be one of them.
function recentre() {
  if (!state.active || !state.root) return;
  state.root.style.transform = centreTransform();
}

function armFlight() {
  const c = cfg();
  state.root.style.transition =
    `transform ${c.seconds ?? 0.55}s ${cssEase(c.ease ?? 'outCubic')}`;
}

// --- the glow around an offered tile ---------------------------------------
// A SIBLING, NOT A FILTER ON THE TILE. Every hexagon in the hive is clipped to
// its own six vertices, and `filter` is applied BEFORE `clip-path` — so a
// drop-shadow on the tile is drawn and then cut away by the tile's own outline,
// and the glow is simply not there. (The same trap the contact shadow under a
// tower is built around; see buildShade.)
//
// So the halo is its own box, soft-edged by a radial gradient rather than by a
// blur — which needs no filter, cannot be clipped, and composites for free while
// it breathes.
//
// AND IT IS A RING, PAINTED LAST, WHICH IS THE ONLY ARRANGEMENT THAT WORKS.
// Behind its own tile is the obvious place for it and it is wrong: a hexagon in
// a cluster is surrounded by its neighbours, and rebuild() paints the corner in
// painter's order — so every tile appended after this one covers the half of the
// halo on that side. What you get is a glow that leaks out of the top-left of
// the lattice and nowhere else, which reads as a rendering fault rather than as
// an answer to the pointer.
//
// Appended at the END it is over everything, so the glow reaches across its
// neighbours the way light would. What stops it washing out the icon it is
// pointing at is the HOLE: the gradient is transparent across the middle, out to
// past the hexagon's own points, so the only thing it paints on its own tile is
// the air around it.
function buildHalo(tile) {
  const c = cfg();
  const spread = c.glow?.spread ?? 1.85;
  const box = parseFloat(tile.style.width) || 0;
  const left = parseFloat(tile.style.left) || 0;
  const top = parseFloat(tile.style.top) || 0;

  const halo = document.createElement('div');
  halo.className = 'sv-hive-halo';
  halo.style.width = `${box * spread}px`;
  halo.style.height = `${box * spread}px`;
  halo.style.left = `${left - box * (spread - 1) / 2}px`;
  halo.style.top = `${top - box * (spread - 1) / 2}px`;
  // The tier colour is the tile's own custom property. Copied rather than
  // inherited: the halo is a sibling, so it inherits from the host and would
  // come out the fallback grey for every tile in the hive.
  halo.style.setProperty('--sv-hive-rarity',
    tile.style.getPropertyValue('--sv-hive-rarity') || '#b8c2cc');
  return halo;
}

// WHAT IS ON OFFER, RE-ASKED FROM SCRATCH EVERY TIME THE TILES ARE REBUILT.
//
// Both halves of it move during the ceremony: `rebuild()` destroys and recreates
// every tile on each pick, so a cached element list is detached nodes, and a
// stack that has just reached its cap has to stop glowing on the same frame it
// gets there. Cheap enough to redo — it is once per pick, not once per frame.
function markTiles() {
  const { tiles, host } = hiveParts();
  state.halos.clear();
  state.stops = [];
  if (!tiles || !host) return;
  for (const [id, el] of tiles) {
    const open = state.canStack(id);
    el.dataset.reward = open ? 'open' : 'capped';
    if (!open) continue;
    const halo = buildHalo(el);
    host.appendChild(halo);
    state.halos.set(id, halo);
    state.stops.push(el);
  }
  // Reading order — top row first, left to right — so a pad stepping through
  // them moves the way the eye already does.
  state.stops.sort((a, b) => {
    const dy = (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0);
    return Math.abs(dy) > 1 ? dy : (parseFloat(a.style.left) || 0) - (parseFloat(b.style.left) || 0);
  });
  // The pointer may not have moved, so whatever it was over is still under it.
  // Re-lit by id rather than by element, since the element it was over no longer
  // exists.
  const wasHot = state.hot;
  state.hot = null;
  if (wasHot && state.halos.has(wasHot)) setHot(wasHot, false);
  state.sel = state.sel < 0 ? -1 : Math.min(state.sel, state.stops.length - 1);
  if (state.sel >= 0) select(state.sel);
}

/** Light one tile, or none. `voice` is false when nothing new was pointed at. */
function setHot(id, voice = true) {
  if (state.hot === id) return;
  const { tiles } = hiveParts();
  const was = state.hot ? tiles?.get(state.hot) : null;
  if (was) was.classList.remove('sv-hive-hot');
  state.halos.get(state.hot)?.classList.remove('sv-hive-hot');
  state.hot = id;
  if (!id) return;
  tiles?.get(id)?.classList.add('sv-hive-hot');
  state.halos.get(id)?.classList.add('sv-hive-hot');
  if (voice) feedback('uiHover');
}

// THE TIP, AND WHY IT IS NOT setHot's JOB.
//
// setHot lights a tile that can still take a pick — a capped one is
// deliberately never hot, because the halo is an OFFER and offering something
// the player cannot have is the bug that rule exists to stop.
//
// The tip answers a different question: "what is this". A capped tile has an
// answer to that, and on this screen it is a useful one — it is why the tile is
// not on offer. So the two are wired separately, and the tip follows the
// pointer over every hexagon rather than only over the ones still open.
//
// The stack count is left to the tip, which reads it off the live run.
function showRewardTip(el) {
  const id = el?.dataset?.upgrade;
  if (id) showUpgradeTip(id, el, { owned: Number(el.dataset.stacks) || 0 });
  else hideUpgradeTip();
}

function select(i) {
  if (!state.stops.length) return;
  state.sel = Math.max(0, Math.min(state.stops.length - 1, i));
  setHot(state.stops[state.sel]?.dataset.upgrade ?? null);
  // The pad gets the tip too, for the same reason it gets the halo: on a
  // controller the pointer never moves, and a readout only a mouse can reach is
  // a readout half the run cannot see. Same rule as selectCard on the level-up
  // row.
  showRewardTip(state.stops[state.sel]);
}

// The pad's cursor, stepped by whichever tile actually lies that way. Same
// scoring as the level-up row's stepSelection: distance along the pushed
// direction, with sideways drift counting double so a tile straight ahead beats
// a nearer one off to the side. Written against a HEX LATTICE rather than a row,
// which is exactly why it cannot be a modular index step — the neighbours of a
// hexagon are not its neighbours in the map.
function step(dx, dy) {
  const centres = state.stops.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const from = centres[state.sel];
  if (!from) return 0;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < centres.length; i++) {
    if (i === state.sel) continue;
    const ox = centres[i].x - from.x;
    const oy = centres[i].y - from.y;
    const along = ox * dx + oy * dy;
    if (along <= 1) continue;
    const score = along + Math.abs(ox * dy - oy * dx) * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  // Nothing that way: horizontally it wraps (a hive is a block, and running off
  // the right edge should come back on the left), vertically it stays put.
  if (best < 0 && dx) best = dx > 0 ? 0 : state.stops.length - 1;
  return best < 0 ? state.sel : best;
}

// --- taking one -------------------------------------------------------------

function take(id) {
  if (!state.active || !id || state.remaining <= 0) return;
  if (!state.canStack(id)) return;
  // FILED FIRST, ANIMATED SECOND — the same order the level-up card's flight
  // needs: the pick has to be in the build before the hive can rebuild with a
  // deeper pile for it, and the slam is that new pile landing.
  if (state.onStack(id) === false) return;
  state.remaining -= 1;
  // The button answering, then the upgrade arriving — the same two-voice split
  // a level-up card makes. `playSfx` and not feedback('levelUp'): that event
  // carries an emitter, a ripple and a camera shake, and with no `at` behind it
  // they would all land on world origin while the run is held still.
  feedback('uiClick');
  playSfx('levelUp');

  // The caller has just rebuilt the tiles under us, so everything the ceremony
  // is holding is stale. Re-marked before the slam, because slamAndRipple looks
  // the tile up by id in the map that rebuild replaced.
  markTiles();
  slamAndRipple(id);
  // The pile grew, so the corner is a different size and the centring is a few
  // pixels out. Re-eased rather than snapped: the hive settling as it takes
  // weight is the read.
  paintCount();
  // AFTER paintCount, because the count is inside the banner and the banner's
  // height is what the centring measures its band from. "3 stacks" wrapping to
  // "1 stack" on a narrow screen changes that height, and a hive placed against
  // the old one is placed against a banner that no longer exists.
  recentre();

  // Out of picks, or out of anything left to deepen. The second is reachable —
  // a build of two capped cards with three stacks owed — and the honest answer
  // is to close rather than to hold the run still in front of a menu where
  // nothing can be clicked.
  if (state.remaining <= 0 || !state.stops.length) finish();
}

function paintCount() {
  if (!state.count) return;
  state.count.textContent = String(state.remaining);
  const sub = state.banner?.querySelector('.sv-hive-reward-noun');
  if (sub) sub.textContent = state.remaining === 1 ? 'stack' : 'stacks';
}

// --- the banner and the scrim ----------------------------------------------

// EVERYTHING THIS CEREMONY PUT ON THE SCREEN, BY SELECTOR AND NOT BY REFERENCE.
//
// The flight home outlives the ceremony: `finish` hands the run back on the
// frame the last stack is taken and leaves the banner and the scrim fading for
// half a second afterwards. So the nodes and the state that describes them come
// apart on purpose — and a second boss dying inside that half second used to
// cancel the tidy-up timer while its closure was the only thing still holding
// the old nodes, leaving a dead scrim over the game for the rest of the run.
//
// Asking the DOM means there can be at most one of each in the tree no matter
// what order the starts, the finishes and the resets arrive in.
function dropChrome() {
  for (const el of document.querySelectorAll('.sv-hive-reward, .sv-hive-reward-scrim')) {
    el.remove();
  }
  state.scrim = state.banner = state.count = null;
}

function buildChrome(mount) {
  const c = cfg();
  // Whatever the last ceremony left mid-fade.
  dropChrome();
  const scrim = document.createElement('div');
  scrim.className = 'sv-hive-reward-scrim';
  scrim.style.setProperty('--sv-reward-scrim', String(c.scrim ?? 0.6));
  mount.appendChild(scrim);
  state.scrim = scrim;

  // `.sv-title` and `.sv-sub` are the game's own menu text roles — see
  // textRoles.js. Reused rather than styled here so this headline moves with
  // every other menu title when the typography panel is dragged.
  const banner = document.createElement('div');
  banner.className = 'sv-hive-reward';
  banner.innerHTML = `<div class="sv-title"></div>`
    + `<div class="sv-sub">Deepen <b class="sv-hive-reward-count"></b>`
    + ` <span class="sv-hive-reward-noun">stacks</span></div>`;
  banner.querySelector('.sv-title').textContent = c.title ?? 'Boss down';
  mount.appendChild(banner);
  state.banner = banner;
  state.count = banner.querySelector('.sv-hive-reward-count');
  paintCount();

  // Armed on the next frame, so the elements have a committed starting opacity
  // to transition FROM. Set in the same task they were built in, the browser
  // sees only the end state and there is no fade at all.
  requestAnimationFrame(() => {
    scrim.classList.add('sv-in');
    banner.classList.add('sv-in');
  });
}

// ---------------------------------------------------------------------------

/**
 * Bring the hive to the middle and let the player spend `stacks` on it.
 *
 * @returns false when there is nothing to hold a ceremony for — the hive is
 *          switched off, the run holds no upgrade that can take another stack,
 *          or the block is disabled in the tuner. THE CALLER MUST CHECK IT: a
 *          `true` means the run has been handed to this menu and `onDone` will
 *          give it back, and a `false` means it never left, so a caller that
 *          paused before asking would pause forever.
 */
export function startHiveReward({ stacks, canStack, onStack, onDone }) {
  if (state.active) return false;
  if (cfg().enabled === false) return false;
  const { root, host, tiles } = hiveParts();
  if (!root || !host || !tiles?.size) return false;
  // A hive the player switched off is not a menu they are expecting.
  if (root.classList.contains('sv-hidden')) return false;
  if (!(stacks > 0)) return false;
  // Nothing left to deepen — every card held is at its cap. Silent, and the
  // caller keeps the run.
  if (![...tiles.keys()].some((id) => canStack(id))) return false;

  // A flight home from a previous ceremony may still be in the air; its tidy-up
  // would strip the state this one is about to set.
  if (state.homing) { clearTimeout(state.homing); state.homing = null; }

  state.active = true;
  state.total = stacks;
  state.remaining = stacks;
  state.root = root;
  state.host = host;
  state.canStack = canStack;
  state.onStack = onStack;
  state.onDone = onDone;
  state.sel = -1;
  state.hot = null;

  buildChrome(root.parentElement ?? document.body);

  // ONE LISTENER ON THE HOST, NOT ONE PER TILE. Every pick throws the tiles away
  // and builds new ones (see rebuild), so per-tile listeners would have to be
  // re-bound on every stack and the first missed re-bind is a tile that silently
  // stops answering. The host survives the whole ceremony.
  state.onClick = (e) => {
    const el = e.target?.closest?.('.sv-hive-tile');
    if (el?.dataset.upgrade) take(el.dataset.upgrade);
  };
  state.onOver = (e) => {
    const el = e.target?.closest?.('.sv-hive-tile');
    const id = el?.dataset.upgrade;
    setHot(id && state.halos.has(id) ? id : null);
    showRewardTip(el);
  };
  state.onOut = (e) => {
    // Only when the pointer has actually left the hive, not when it crosses from
    // a tile to the halo behind it — those fire pointerout constantly.
    if (!host.contains(e.relatedTarget)) { setHot(null); hideUpgradeTip(); }
  };
  host.addEventListener('click', state.onClick);
  host.addEventListener('pointerover', state.onOver);
  host.addEventListener('pointerout', state.onOut);
  state.onResize = () => recentre();
  window.addEventListener('resize', state.onResize);

  root.dataset.reward = 'on';
  // The two numbers the hover state is drawn from, handed to the CSS once
  // rather than written per tile — every halo and every lit hexagon reads them
  // off the root.
  const c = cfg();
  root.style.setProperty('--sv-hive-hot-lift', String(c.glow?.lift ?? 1.55));
  root.style.setProperty('--sv-hive-breathe', `${c.glow?.breathe ?? 1.15}s`);
  markTiles();
  armFlight();
  root.style.transform = centreTransform();
  return true;
}

/**
 * The pad and the arrow keys, polled once a frame from main.js.
 *
 * A POLL RATHER THAN LISTENERS because the Gamepad API has no events — the same
 * reason updateMenuNav is one. Returns true when it owned the frame's menu
 * input, so the caller can stop before the level-up row sees it.
 */
export function updateHiveRewardNav() {
  if (!state.active || !state.stops.length) return state.active;
  // The first thing the pad says LANDS the cursor rather than moving it: there
  // is nothing on screen to step away from until the player has asked for a
  // selection, and a mouse player must not be shown a tile chosen for them.
  if (state.sel < 0) {
    if (menuInput.x || menuInput.y || menuInput.confirm) select(0);
    return true;
  }
  if (menuInput.x || menuInput.y) select(step(menuInput.x, menuInput.y));
  if (menuInput.confirm) take(state.stops[state.sel]?.dataset.upgrade);
  return true;
}

// --- closing ----------------------------------------------------------------

// The listeners, the halos and the per-tile state, without touching the flight.
// Shared by the graceful close and the hard reset, so the two cannot drift.
function teardown() {
  // The box is on document.body and outlives this menu's own subtree — see the
  // note at the head of upgradeTip.js. Left up, it is a tip about a ceremony
  // that has finished, sitting over a fight that has restarted.
  hideUpgradeTip();
  const { tiles, host } = hiveParts();
  if (host && state.onClick) {
    host.removeEventListener('click', state.onClick);
    host.removeEventListener('pointerover', state.onOver);
    host.removeEventListener('pointerout', state.onOut);
  }
  if (state.onResize) window.removeEventListener('resize', state.onResize);
  state.onClick = state.onOver = state.onOut = state.onResize = null;
  for (const halo of state.halos.values()) halo.remove();
  state.halos.clear();
  if (tiles) {
    for (const el of tiles.values()) {
      delete el.dataset.reward;
      el.classList.remove('sv-hive-hot');
    }
  }
  state.stops = [];
  state.sel = -1;
  state.hot = null;
  state.active = false;
}

/**
 * Send the hive home and give the run back.
 *
 * THE RUN COMES BACK ON THIS FRAME, not when the hive lands — the same trade the
 * level-up screen takes with the card still flying to the corner. The flight
 * home is the ceremony ending, and holding the water still for it would put half
 * a second of unplayable game after the last thing the player did.
 */
function finish() {
  const c = cfg();
  teardown();
  // Faded rather than removed: the nodes stay in the tree for the length of the
  // flight home and dropChrome takes them off the end of it. The references are
  // dropped here so nothing can write into a banner that is on its way out.
  state.scrim?.classList.remove('sv-in');
  state.banner?.classList.remove('sv-in');
  state.scrim = state.banner = state.count = null;

  const root = state.root;
  // 'out' rather than removing the attribute outright: the pointer-events and
  // the z-index lift come off NOW (the seal steers with the mouse and the run is
  // live again from this frame), but `transform-origin: 0 0` has to survive the
  // whole trip home or the transform being animated changes meaning halfway.
  root.dataset.reward = 'out';
  root.style.transform = '';

  const secs = c.seconds ?? 0.55;
  state.homing = setTimeout(() => {
    state.homing = null;
    root.style.transition = '';
    root.style.removeProperty('--sv-hive-hot-lift');
    root.style.removeProperty('--sv-hive-breathe');
    delete root.dataset.reward;
    dropChrome();
  }, Math.round(secs * 1000) + 120);

  state.onDone?.();
  state.onDone = null;
}

/**
 * Hard cancel — a restart, or a run ending underneath the ceremony.
 *
 * No flight and no `onDone`: the caller tearing the run down is already deciding
 * what happens next, and a callback that unpaused a run being restarted would be
 * a second hand on the same switch.
 */
export function resetHiveReward() {
  if (state.homing) { clearTimeout(state.homing); state.homing = null; }
  teardown();
  dropChrome();
  state.onDone = null;
  state.remaining = 0;
  if (state.root) {
    state.root.style.transition = '';
    state.root.style.transform = '';
    state.root.style.removeProperty('--sv-hive-hot-lift');
    state.root.style.removeProperty('--sv-hive-breathe');
    delete state.root.dataset.reward;
  }
}
