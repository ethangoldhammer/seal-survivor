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
//   THE UNLOCK. Every accessory is `unlocked: true` in config.js because
//   nothing in the game yet says what earns one. The field is read here rather
//   than assumed, so whatever eventually grants an accessory — a boss down, a
//   run length, a shop — writes that one flag and this panel is already
//   correct. What is NOT here is where the flag persists: it lives in CONFIG,
//   which the tuner snapshots, and a real inventory belongs in the same store
//   the graveyard and the loadout use, not in a tuning file.
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
  .sv-acc-row { display: flex; gap: 8px; }
  .sv-acc-empty { font-size: 11px; color: rgba(226,240,255,0.35); padding: 10px 4px; }
  .sv-acc-tile { width: 64px; padding: 7px 5px 6px; border-radius: 7px; cursor: grab;
    background: rgba(10,20,32,0.55); border: 1px solid rgba(150,200,255,0.18);
    backdrop-filter: blur(6px); display: flex; flex-direction: column; align-items: center; gap: 5px;
    transition: border-color .12s ease, background .12s ease, transform .12s ease; touch-action: none; }
  .sv-acc-tile:hover { border-color: rgba(150,200,255,0.45); background: rgba(16,32,50,0.7); }
  .sv-acc-tile.on { border-color: rgba(124,230,160,0.75); background: rgba(14,38,32,0.72); }
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
  .sv-acc-name { font-size: 9px; line-height: 1.15; text-align: center; color: rgba(226,240,255,0.8);
    letter-spacing: .02em; }
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
};

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
      const name = document.createElement('div');
      name.className = 'sv-acc-name';
      // A new accessory with no line here falls through to its asset key, which
      // is ugly and visible — the same bargain uiText makes for a missing row.
      name.textContent = key
        ? (TILE_NAME[key]?.() ?? key)
        : uiText('accessoryBare');
      tile.append(swatch, name);

      tile.addEventListener('pointerdown', (e) => startDrag(e, key, tile));
      row.appendChild(tile);
      tiles.set(key, tile);
    }
    paint();
  }

  function paint() {
    const on = CONFIG.accessories?.equipped ?? '';
    for (const [key, tile] of tiles) tile.classList.toggle('on', key === on);
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
    const now = equipAccessory(key);
    paint();
    feedback('uiClick');
    onEquip?.(now);
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
    /** Rebuild the tiles after an unlock. Nothing calls this yet; see the stub note. */
    rebuild: build,
    /** Fade with the shot: the drawer belongs to the menu, not to the run. */
    setWeight(w) { root.style.opacity = String(w); target.style.display = w > 0.01 ? '' : 'none'; },
    destroy() { cancelDrag(); root.remove(); target.remove(); },
  };
}
