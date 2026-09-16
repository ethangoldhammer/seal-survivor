import { CONFIG } from '../config.js';
import { uiText } from '../uiTextTable.js';
import { accessoryRoster, equipAccessory } from '../systems/accessories.js';
import { ACCESSORY_ICONS } from './accessoryIcons.js';
import { feedback } from '../systems/feedback.js';

// ---------------------------------------------------------------------------
// THE ACCESSORY DRAWER — A STUB. Read this paragraph before extending it.
//
// A strip of tiles along the bottom of the main menu: everything the player has
// unlocked, plus a tile for wearing nothing. Click one to put it on, or DRAG
// one onto the seal. It is deliberately unfinished, and what is missing is
// listed at the bottom of this comment so the next person does not have to
// infer it from what is here.
//
// WHAT IS REAL. The slot it writes (systems/accessories.js's equipAccessory),
// the roster it reads (CONFIG.accessories.items, filtered by `unlocked`), the
// drop target (the seal's own screen position, handed in by the menu, so the
// drop lands on the animal rather than on a rectangle that happens to be near
// it), and the copy, which is staged as lorem in uiText.csv with a brief in
// each row's notes.
//
// WHAT IS STUBBED, and why each is a decision rather than an omission:
//
//   THE UNLOCK — DONE, in systems/unlocks.js. unlocks.csv names what gates
//   each accessory and the ledger of what has been earned lives in its own
//   localStorage key, well away from the tuning snapshot. The roster read
//   here is already filtered by it, so the drawer starts with the bare tile
//   and whatever has no row, and fills in as gates are collected — one tile
//   per unlock, in config order. A gate popped mid-run is NOT in the roster
//   until that run is over (see EARNED IS NOT YET GRANTED there), which is
//   why the menu never has to rebuild this strip while it is up.
//
//   NO NAMES ON THE TILES. The picture is the tile; the name from uiText.csv
//   is its `title` and accessible name, so a hover or a screen reader still
//   gets it and the table's rows are still read. Which is also why the strip
//   is a CAROUSEL: at 64px a tile, eight accessories and the bare seal are
//   wider than a phone, so the row scrolls sideways — a horizontal pan
//   scrolls, a lift toward the seal drags, the wheel scrolls it on a mouse,
//   and the two edges fade so an overflow reads as "more" rather than as a
//   cut. A row that fits needs none of that and gets none of it.
//
//   THE TILE ART — DONE, and left in this list because what it turned into is
//   worth knowing about. It used to be a coloured lozenge per accessory, with
//   the note that the honest version is a rendered thumbnail of the actual
//   mesh and that that is a pipeline rather than a div. The pipeline exists
//   now: tools/accessory-icons.mjs writes a spec list, the picker at
//   `npm run accessories:pick` chooses each angle, and the bake embeds the
//   PNGs into ui/accessoryIcons.js — the same round trip the upgrade hive's
//   icons take, pointed at a third list. The lozenges below are the fallback
//   for anything not yet shot, which on a fresh checkout is all of them.
//
//   THE DRAG IS POINTER EVENTS, not HTML5 drag-and-drop. dragstart/drop cannot
//   see a WebGL canvas as a target — the drop would have to be inferred from
//   coordinates anyway — and the API brings a browser-drawn ghost image that
//   cannot be styled to look like this game. So a press on a tile captures the
//   pointer, a ghost follows it, and the release asks the menu whether it
//   landed on the seal.
//
//   IT IS THE MENU'S, and leaves with it: mounted into the menu's own label
//   layer so the one `remove()` that takes the buttons away takes this too.
//
// THE ONE THING THAT WOULD BE WRONG TO CHANGE without thinking: this never
// writes CONFIG.accessories.equipped itself. equipAccessory owns the two rules
// that guard the slot — a key must exist and must be unlocked — and a second
// writer is a second place to forget them. See the note above it.
// ---------------------------------------------------------------------------

const STYLES = `
  .sv-acc-drawer { position: absolute; left: 50%; bottom: 3.2vh; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    pointer-events: auto; user-select: none; -webkit-user-select: none; }
  .sv-acc-drawer h4 { margin: 0; font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
    color: rgba(226,240,255,0.45); font-weight: 600; }
  .sv-acc-row { display: flex; gap: 8px; padding: 3px 6px;
    max-width: min(92vw, 720px); overflow-x: auto; overflow-y: hidden;
    scroll-snap-type: x proximity; overscroll-behavior-x: contain;
    scrollbar-width: none; -ms-overflow-style: none; }
  .sv-acc-row::-webkit-scrollbar { display: none; }
  /* The fade at either edge, only once the strip overflows — set by the
     drawer after it measures itself, so a row that fits has hard edges. */
  .sv-acc-row.overflowing { mask-image: linear-gradient(90deg, transparent, #000 28px, #000 calc(100% - 28px), transparent);
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 28px, #000 calc(100% - 28px), transparent); }
  .sv-acc-empty { font-size: 11px; color: rgba(226,240,255,0.35); padding: 10px 4px; }
  /* touch-action: pan-x — a sideways finger scrolls the strip and the browser
     cancels the pointer (see cancelDrag); an upward one is the drag. */
  .sv-acc-tile { width: 64px; flex: 0 0 auto; scroll-snap-align: center;
    padding: 7px 5px 6px; border-radius: 7px; cursor: grab;
    background: rgba(10,20,32,0.55); border: 1px solid rgba(150,200,255,0.18);
    backdrop-filter: blur(6px); display: flex; flex-direction: column; align-items: center; gap: 5px;
    transition: border-color .12s ease, background .12s ease, transform .12s ease; touch-action: pan-x; }
  .sv-acc-tile:hover { border-color: rgba(150,200,255,0.45); background: rgba(16,32,50,0.7); }
  .sv-acc-tile.on { border-color: rgba(124,230,160,0.75); background: rgba(14,38,32,0.72); }
  /* THE CURSOR — a pad's, or the arrow keys'. A ring rather than a change of
     border colour, because the equipped state is already a border colour and
     "the hat I am wearing" and "the hat I am pointing at" have to be two
     readable states at once.
     (No backticks in this block: it is inside a template literal and one would
     end the string, with the error pointing at a comment.) Same ring the score card and the pause menu use (.sv-nav-sel in
     ui/ui.js), restated here because this strip is mounted into the menu's
     label layer and carries its own sheet.
     :focus-visible beside it so the keyboard route (a tile is tabbable now) is
     lit by the browser as well, on the frames before the cursor has adopted it. */
  .sv-acc-tile:focus-visible, .sv-acc-tile.sv-nav-sel { outline: 2px solid #fff; outline-offset: 2px; }
  .sv-acc-tile:focus { outline-offset: 2px; }
  .sv-acc-tile.dragging { opacity: 0.35; cursor: grabbing; }
  .sv-acc-swatch { width: 100%; height: 26px; border-radius: 4px; }
  /* A RENDERED TILE IS TALLER THAN A LOZENGE. 26px was the height of a coloured
     rectangle, which needs no room to be read; a hat at 26px is a smudge. The
     picture gets 40, and only the picture — a tile with no render keeps the
     strip it always had, so the row does not change height depending on how
     many icons have been shot. The framing (contain, centred, no repeat) is
     written on the element rather than here, because it rides the same one-line
     background shorthand that carries the image. */
  .sv-acc-swatch.shot { height: 40px; }
  /* A THUMB. A tile is 64 wide and always has been, but its HEIGHT is whatever
     its picture asks for: a rendered hat is 40 plus 13 of padding and clears the
     minimum, and a tile with no render yet is 26 plus 13 — 39px, under Apple's
     44, on the one screen this game opens on. Which tiles have been shot is a
     question about the asset bake (see ACCESSORY_ICONS), so a strip could be
     half above the minimum and half below it with nothing to say so.
     .sv-touch and not a width query: whether there is a thumb is not a question
     about how wide the screen is — an iPad in landscape is 1024px and is still
     touched. ui.js puts the class on the UI root, which this strip is inside. */
  .sv-touch .sv-acc-tile { min-height: 44px; }
  .sv-acc-ghost { position: fixed; z-index: 40; pointer-events: none; width: 64px;
    transform: translate(-50%, -50%) scale(1.08); opacity: 0.92; }
  /* The seal lighting up as a drop target. Drawn on the drawer rather than on
     the canvas because the canvas is a single quad with no DOM to style — the
     3D highlight would be a shader change, which a stub has no business making. */
  .sv-acc-target { position: absolute; border-radius: 50%; pointer-events: none;
    border: 1px dashed rgba(124,230,160,0.55); background: rgba(124,230,160,0.07);
    transform: translate(-50%, -50%); opacity: 0; transition: opacity .12s ease; }
  .sv-acc-target.live { opacity: 1; }
`;

let styled = false;

// WHICH ROW IN uiText.csv NAMES EACH ONE. The id has to be a LITERAL inside the
// call — not `${key}Name`, and not a lookup handed to uiText either. npm run
// test:uitext greps this file for calls with a quoted id to check that every
// row is shown somewhere and that every read has a row (its scanner is a regex
// over the source and does not skip comments, so this sentence deliberately
// does not spell one out — a made-up id in a comment is reported as a read of a
// row that does not exist). It cannot follow anything
// computed: an id built at runtime makes both halves of that check silently
// vacuous, which is a table quietly going stale. Hence a thunk per accessory —
// the call is written out, and it is still resolved at paint time rather than
// at import, so a re-parsed table reaches the tiles.
//
// The cost is one line per accessory, which is the same cost as its CSV row and
// its ASSETS entry.
const TILE_NAME = {
  accessoryHat: () => uiText('accessoryHatName'),
  accessoryGlasses: () => uiText('accessoryGlassesName'),
  accessoryBowler: () => uiText('accessoryBowlerName'),
  accessoryTricorn: () => uiText('accessoryTricornName'),
  accessoryFedora: () => uiText('accessoryFedoraName'),
  accessoryRounds: () => uiText('accessoryRoundsName'),
  accessoryAviators: () => uiText('accessoryAviatorsName'),
  accessoryWireFrames: () => uiText('accessoryWireFramesName'),
  // These four shipped with meshes and no line, so their tiles showed the raw
  // asset key as their name — "accessoryCowboy" on a hover and to a screen
  // reader. The fallback in accessoryName is deliberate (a new accessory should
  // be visible rather than nameless) but it is a fallback, not a destination.
  accessoryHardHat: () => uiText('accessoryHardHatName'),
  accessoryCowboy: () => uiText('accessoryCowboyName'),
  accessoryWizard: () => uiText('accessoryWizardName'),
  accessorySharkHood: () => uiText('accessorySharkHoodName'),
  // The fourth batch. Five hats and two haircuts; their rows are staged as
  // [DRAFT] in uiText.csv with a brief each, so they are in the drawer and
  // wearable while the names are still outstanding — and the copy gate can see
  // exactly which lines it is waiting on, which is the point of staging a
  // marker rather than a plausible word.
  accessoryUshanka: () => uiText('accessoryUshankaName'),
  accessoryStetson: () => uiText('accessoryStetsonName'),
  accessoryBobble: () => uiText('accessoryBobbleName'),
  accessoryCloche: () => uiText('accessoryClocheName'),
  accessoryJester: () => uiText('accessoryJesterName'),
  accessoryShortHair: () => uiText('accessoryShortHairName'),
  accessoryBobHair: () => uiText('accessoryBobHairName'),
};

/**
 * WHAT TO CALL ONE, for any screen that shows an accessory. '' is the bare
 * seal, which has a name of its own rather than a dash.
 *
 * Exported from HERE rather than written out again wherever it is needed,
 * because of the rule above: the id has to be a literal inside the uiText call
 * for the table's own test to see the read at all, and a second copy of this
 * map somewhere else would be a second set of reads to keep in step. The team
 * select's per-seat accessory button is the second caller.
 */
export function accessoryName(key) {
  return key ? (TILE_NAME[key]?.() ?? key) : uiText('accessoryBare');
}

// The tile colours — THE FALLBACK NOW, not the plan. ACCESSORY_ICONS holds a
// render of the actual mesh for anything somebody has sat down with the picker
// and shot (npm run accessories:pick); this is what a tile looks like until
// then, and what it looks like for good if a render is deliberately dropped.
// Keyed by asset so a new accessory gets a neutral slate rather than silently
// sharing one.
const SWATCH = {
  accessoryHat: 'linear-gradient(160deg, #f3f7fb, #9db4c6)',
  accessoryGlasses: 'linear-gradient(160deg, #2b3440, #05070a)',
  // Taken off each model's own material rather than picked: the bowler's
  // brass and felt, the tricorn's grey, the fedora's brown, the wooden
  // frames, and the two golds. It is still a lozenge and not a thumbnail —
  // see the note above about what the honest version of this is.
  accessoryBowler: 'linear-gradient(160deg, #d8a463, #3d2f22)',
  accessoryTricorn: 'linear-gradient(160deg, #b6c0ca, #4a535d)',
  accessoryFedora: 'linear-gradient(160deg, #6d5744, #2a211a)',
  accessoryRounds: 'linear-gradient(160deg, #9c7043, #2e1f11)',
  accessoryAviators: 'linear-gradient(160deg, #e2b45c, #1d2418)',
  accessoryWireFrames: 'linear-gradient(160deg, #d8a132, #17111c)',
  '': 'linear-gradient(160deg, rgba(120,150,180,0.25), rgba(60,80,100,0.15))',
};

/**
 * Mount the drawer.
 *
 * @param parent    the menu's label layer, so it leaves when the menu does.
 * @param sealRect  () => ({ x, y, r }) in CLIENT pixels — where the seal is on
 *   screen and how big a target it is. Handed in rather than measured here: the
 *   menu already projects the bust every frame for the nametag, and a second
 *   projection would be a second thing to keep in step with a resize.
 * @param onEquip   called with the key that landed, for the menu's own reaction
 *   (a knock in the water, a look at the player). Optional.
 */
export function mountAccessoryDrawer({ parent, sealRect, onEquip } = {}) {
  if (!styled) {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    styled = true;
  }

  const root = document.createElement('div');
  root.className = 'sv-acc-drawer';

  const title = document.createElement('h4');
  title.textContent = uiText('accessoryDrawerTitle');
  root.appendChild(title);

  const row = document.createElement('div');
  row.className = 'sv-acc-row';
  root.appendChild(row);

  // The drop target's halo, over the seal. In the PARENT rather than in the
  // drawer: the drawer is a strip at the bottom of the screen and this has to
  // sit on the animal, which is most of the way up it.
  const target = document.createElement('div');
  target.className = 'sv-acc-target';
  parent.appendChild(target);

  parent.appendChild(root);

  const tiles = new Map();

  function build() {
    row.textContent = '';
    tiles.clear();
    // THE CURSOR CANNOT SURVIVE ITS OWN LIST. Every tile here is about to be
    // thrown away, so an index into the old row is an index into nothing — and
    // the menu above would go on believing the player was down here.
    navAt = -1;
    const roster = accessoryRoster(true);
    if (!roster.length) {
      const empty = document.createElement('div');
      empty.className = 'sv-acc-empty';
      empty.textContent = uiText('accessoryDrawerEmpty');
      row.appendChild(empty);
      return;
    }
    // '' FIRST, and it is a tile like any other. Taking a hat off has to be a
    // thing you can point at — see the same argument in cycleAccessory, which
    // puts the bare seal in the ring for the same reason.
    for (const key of ['', ...roster]) {
      const tile = document.createElement('div');
      tile.className = 'sv-acc-tile';
      tile.dataset.key = key;

      const swatch = document.createElement('div');
      swatch.className = 'sv-acc-swatch';
      // THE RENDER IF THERE IS ONE, the lozenge if there is not. A background
      // image rather than an <img>: the two states then differ in one property
      // instead of in what element is in the tile, so there is no branch here
      // that builds a different DOM for a tile that has been shot.
      //
      // The bare-seal tile ('') has no asset and so can never have a render —
      // it is the one tile that is a lozenge on purpose.
      const shot = key ? ACCESSORY_ICONS[key] : null;
      swatch.classList.toggle('shot', !!shot);
      swatch.style.background = shot
        ? `url("${shot}") center / contain no-repeat`
        : (SWATCH[key] ?? 'linear-gradient(160deg, #6d7f92, #33414f)');
      // The name is the tile's title and accessible name, not a caption. A
      // new accessory with no line here falls through to its asset key, which
      // is ugly on hover — the same bargain uiText makes for a missing row.
      const name = accessoryName(key);
      tile.title = name;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', name);
      tile.appendChild(swatch);

      tile.addEventListener('pointerdown', (e) => startDrag(e, key, tile));
      // A TILE IS A BUTTON AND NOW BEHAVES LIKE ONE. It has said role="button"
      // to a screen reader since it was written, which was a promise it did not
      // keep: no tabindex, so Tab never reached it, and no key handler, so
      // Enter did nothing when it did. The only way to put a hat on was a
      // pointer — on the one screen in this game that a controller is most
      // likely to be sitting in front of.
      tile.tabIndex = 0;
      tile.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        equip(key);
      });
      // Focus and the cursor are the same thing on this strip — unlike the
      // panels, where the highlight is deliberately independent of focus. There
      // is nothing else on the screen to tab to while the strip has focus, and
      // a Tab that moved the ring but not the cursor would be two selections.
      tile.addEventListener('focus', () => { navAt = tileList().indexOf(tile); paintNav(); });
      row.appendChild(tile);
      tiles.set(key, tile);
    }
    paint();
    measure();
  }

  // Does the strip overflow? Decides the edge fade, and it is re-asked on
  // resize because the answer is a function of the viewport.
  function measure() {
    row.classList.toggle('overflowing', row.scrollWidth > row.clientWidth + 1);
  }
  window.addEventListener('resize', measure);

  // A mouse has no sideways gesture; the wheel is it. Only claimed while the
  // strip actually overflows, so a wheel over a row that fits still reaches
  // whatever is behind it.
  row.addEventListener('wheel', (e) => {
    if (row.scrollWidth <= row.clientWidth + 1) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    row.scrollLeft += d;
    e.preventDefault();
  }, { passive: false });

  function paint() {
    const on = CONFIG.accessories?.equipped ?? '';
    for (const [key, tile] of tiles) tile.classList.toggle('on', key === on);
  }

  // --- the cursor -----------------------------------------------------------
  // WHAT A PAD AND THE ARROW KEYS DRIVE. The strip is a row under the menu's
  // hexagons and it is walked as one: the hexagon cursor drops into it on a push
  // DOWN with nothing below (systems/mainMenu.js), left and right walk the
  // tiles, up climbs back out, confirm puts the hat on.
  //
  // ITS OWN INDEX AND NOT THE MENU'S. The hexagons are picked in world space by
  // where they are; this is a list in DOM order, and the two have no common
  // coordinate to be walked in. What they share is the one confirm button, which
  // is why the menu hands the frame over rather than driving both.
  //
  // CLAMPED AT BOTH ENDS, like every other list in this game: a push at the end
  // of the row that lands you back at the start is a cursor that has teleported,
  // and on a strip that scrolls it is one that has also scrolled the strip out
  // from under itself.
  let navAt = -1;

  function tileList() { return [...row.querySelectorAll('.sv-acc-tile')]; }

  function paintNav() {
    const list = tileList();
    list.forEach((t, i) => t.classList.toggle('sv-nav-sel', i === navAt));
    // THE STRIP SCROLLS, so the cursor has to bring its tile with it — the row
    // is a carousel once there are more hats than fit (see measure), and a
    // selection off the end of it is a selection nobody can see.
    list[navAt]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /** Equip `key` the way a click does — one path, sound and callback included. */
  function equip(key) {
    const now = equipAccessory(key);
    paint();
    feedback('uiClick');
    onEquip?.(now);
    return now;
  }


  // --- the drag -------------------------------------------------------------
  // A press that never moves far is a CLICK and equips on release; one that
  // travels past the threshold becomes a drag and equips only over the seal.
  // Both, rather than one or the other: dragging a hat onto an animal is the
  // gesture the screen is for, and being made to drag when a tap would do is
  // the kind of thing that reads as a bug on a phone.
  const DRAG_START = 6;
  let drag = null;

  function startDrag(e, key, tile) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    drag = { key, tile, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, id: e.pointerId };
    // CAPTURE THROWS ON A POINTER THAT IS NOT ACTIVE — NotFoundError — and a
    // throw here aborts startDrag before the move and up listeners are attached,
    // so the tile becomes a thing you can press and never release. Synthesised
    // events (a test driver, an accessibility tool) are the case that hits it,
    // and capture is a nicety anyway: without it a drag that leaves the tile
    // still works, because the listeners are on the tile and the pointer is
    // already down on it.
    try { tile.setPointerCapture?.(e.pointerId); } catch { /* not a live pointer */ }
    // ON THE WINDOW, NOT ON THE TILE. Pointer capture is supposed to keep the
    // events coming to the element the press started on, and in a real browser
    // it does — but it throws on a pointer id that is not live, it is not
    // implemented everywhere, and the moment it does not take, every move and
    // the release land on whatever is under the cursor instead. The tile then
    // never hears the `up`, the drag never ends, and a ghost follows the
    // pointer around the screen forever. Measured that way with a synthesised
    // drag; the fix costs nothing and removes the dependency.
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', cancelDrag);
  }

  function overSeal(x, y) {
    const rect = sealRect?.();
    if (!rect) return false;
    return Math.hypot(x - rect.x, y - rect.y) <= rect.r;
  }

  function onDrag(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_START) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.tile.classList.add('dragging');
      // The ghost is a CLONE of the tile, so what follows the pointer is the
      // thing that was picked up rather than a second design of the same
      // object. Appended to the body, not the drawer: the drawer is
      // transformed, and a fixed-position child of a transformed ancestor
      // positions against that ancestor instead of the viewport.
      drag.ghost = drag.tile.cloneNode(true);
      drag.ghost.className = 'sv-acc-tile sv-acc-ghost';
      document.body.appendChild(drag.ghost);
      const rect = sealRect?.();
      if (rect) {
        target.style.left = `${rect.x}px`;
        target.style.top = `${rect.y}px`;
        target.style.width = `${rect.r * 2}px`;
        target.style.height = `${rect.r * 2}px`;
      }
    }
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
    target.classList.toggle('live', overSeal(e.clientX, e.clientY));
  }

  function endDrag(e) {
    if (!drag) return;
    const { key, moved } = drag;
    const landed = !moved || overSeal(e.clientX, e.clientY);
    cancelDrag();
    if (!landed) return;
    // Through `equip`, which is the one path a hat goes on by — a pointer, a
    // key and a pad all end here, so none of them can take a route the others
    // do not (the repaint, the click and the menu's own reaction included).
    equip(key);
  }

  function cancelDrag() {
    if (!drag) return;
    drag.tile.classList.remove('dragging');
    window.removeEventListener('pointermove', onDrag);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', cancelDrag);
    try { drag.tile.releasePointerCapture?.(drag.id); } catch { /* never captured */ }
    drag.ghost?.remove();
    target.classList.remove('live');
    drag = null;
  }

  build();

  return {
    /** Repaint after something else moved the slot — the seal being clicked. */
    refresh: paint,

    // --- the pad's cursor, driven by systems/mainMenu.js ---------------------
    /** Is the cursor in the strip right now? */
    padInside: () => navAt >= 0,
    /**
     * Drop into the strip, landing on the hat the seal is ALREADY WEARING
     * rather than on the first tile — the row is a ring the player is stepping
     * through, and starting anywhere else means the first press walks away from
     * where they are. False if there is nothing in the strip to land on, which
     * is a real state: the roster is empty until something is unlocked.
     */
    padIn() {
      const list = tileList();
      if (!list.length) return false;
      const on = CONFIG.accessories?.equipped ?? '';
      const at = list.findIndex((t) => t.dataset.key === on);
      navAt = at >= 0 ? at : 0;
      paintNav();
      list[navAt].focus?.({ preventScroll: true });
      feedback('uiHover');
      return true;
    },
    /** Left or right one tile. Silent at either end — see the note on navAt. */
    padStep(dir) {
      const list = tileList();
      if (navAt < 0 || !list.length) return;
      const next = Math.max(0, Math.min(list.length - 1, navAt + Math.sign(dir)));
      if (next === navAt) return;
      navAt = next;
      paintNav();
      list[navAt].focus?.({ preventScroll: true });
      feedback('uiHover');
    },
    /** Put on whatever the cursor is over. */
    padConfirm() {
      const list = tileList();
      const tile = list[navAt];
      if (tile) equip(tile.dataset.key ?? '');
    },
    /** Climb back out to the hexagons. */
    padOut() {
      navAt = -1;
      paintNav();
      // BLUR THE TILE, or it keeps the browser's focus and its own Enter
      // handler over a cursor that has gone back to the buttons above — one
      // key press putting a hat on and pressing a hexagon. Only if the focus is
      // actually in this strip: blurring whatever happens to be focused would
      // reach into a screen this drawer knows nothing about.
      const focused = document.activeElement;
      if (focused && row.contains(focused)) focused.blur?.();
    },
    /** Rebuild the tiles after an unlock. Nothing calls this yet; see the stub note. */
    rebuild: build,
    /** Fade with the shot: the drawer belongs to the menu, not to the run. */
    setWeight(w) { root.style.opacity = String(w); target.style.display = w > 0.01 ? '' : 'none'; },
    destroy() { cancelDrag(); window.removeEventListener('resize', measure); root.remove(); target.remove(); },
  };
}
