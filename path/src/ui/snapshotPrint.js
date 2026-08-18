import { CONFIG } from '../config.js';
import { cssEase } from '../ease.js';
import {
  initSnapshotCards, snapshotCardsLive, buildSnapshotCard,
  settleSnapshotCard, releaseAllSnapshotCards, cardTextFor, playCardWriteOn,
} from './snapshotCard.js';

// ---------------------------------------------------------------------------
// THE PRINT
//
// systems/bossShot.js keeps one PNG per boss killed, and until now the player
// never saw it happen — the picture was taken silently mid-shot and only
// turned up minutes later on the death screen. The grab was invisible, so the
// game got no credit for it, and the held beat had nothing in it but wreckage.
//
// So the photograph comes OUT. A shutter flash on the frame it is taken, then
// the print ejects up into the middle of the screen like something spat out of
// a camera, develops from blank emulsion to the frame that was just grabbed,
// and flies to the top-left corner, shrinking as it goes. It stays there for
// the rest of the run, and the next boss's print lands on top of it — by the
// end of a long run the corner holds the whole set, fanned out like prints
// dropped on a table.
//
// THE WORLD IS STILL SLOW WHILE ALL THIS HAPPENS, and that is arranged from
// the other end: systems/bossKill.js has a `print` phase that lasts exactly as
// long as the flight (printPhaseSeconds, derived from the numbers below), so
// the ocean does not come back until the print has parked. Change a duration
// here and the slow motion follows it — there is no second copy to update.
//
// WHY THIS IS CSS AND NOT THE GAME LOOP. Everything here is a transform on a
// DOM node with a transition on it: the browser owns the interpolation, on the
// wall clock, on the compositor. That matters more than usual for this one —
// it is playing over a frame that is deliberately running at a tenth speed,
// and anything driven from the game loop would be dilated along with the
// ocean and take nine seconds to reach the corner. It is also the reason
// nothing here chases a JS value per frame: a transition that is re-aimed
// every frame never arrives.
//
// Nothing here is on the hot path. One element per boss killed.
// ---------------------------------------------------------------------------

let layer = null;
let flashEl = null;
// Every print lives in here, in flight and parked, so the whole stack can be
// moved with ONE transform. Doing it per print instead would mean composing a
// slide onto each parked print's own translate/rotate/scale and recomputing
// all of them on every resize — and a print still in flight would need its
// destination rewritten mid-transition, which is the one thing a CSS
// transition cannot survive.
let pileEl = null;
// Timer for the drift-away, and whether something is deliberately holding the
// pile on screen (the pause menu). A sticky pile ignores the clock.
let hideTimer = 0;
// Fires after the slide, to take the pile out of the paint path entirely.
let gonePlease = 0;
let pileSticky = false;
let pileHidden = false;
// Prints that have parked, oldest first — the pile. Kept so a resize can
// re-place them: their transforms are in PIXELS (a corner is a distance from
// an edge, not a fraction of one), so the slot has to be recomputed rather
// than scaled.
const parked = [];
let slotCount = 0;
// Bumped by every reset. A print in flight owns a pending timer that will try
// to park it, and a run restarted between the pop and the park would have that
// timer add a detached element to a pile that is meant to be empty — a ghost
// slot that pushes the next run's prints one step down the corner and can
// never be cleared, since the element it holds is no longer in the document.
let generation = 0;

function cfg() {
  return CONFIG.boss?.kill?.print ?? {};
}

const STYLES = `
  .sv-print-layer { position: fixed; inset: 0; pointer-events: none; z-index: 9;
    overflow: hidden; font-family: var(--sv-font, 'Inter', system-ui, sans-serif); }
  .sv-print-flash { position: absolute; inset: 0; background: #fff; opacity: 0; }

  /* THE PILE. A layer of its own so the corner can be cleared without touching
     any print's own transform — see hidePile. Inset rather than sized, and
     pointer-events stay off: it covers the whole screen because the prints
     inside it are positioned from the middle of the viewport. */
  .sv-print-pile { position: absolute; inset: 0; will-change: transform; }
  .sv-print-flash.sv-print-lit { animation: sv-print-flash var(--sv-flash) ease-out 1; }
  @keyframes sv-print-flash {
    0% { opacity: 0; }
    18% { opacity: var(--sv-flash-alpha); }
    100% { opacity: 0; }
  }

  /* The paper. transform-origin dead centre, because every stage of this is a
     transform about the middle of the print — an origin anywhere else makes
     the shrink to the corner curve on its way there.

     POSITION IS NOT PART OF BEING A PRINT: the score screen lays the same
     paper out in a fan, in normal flow (see showTrophy in ui/ui.js), and an
     absolute position baked in here would drop every one of them on top of
     each other. Only a print in FLIGHT is positioned. (No backticks in this
     string, ever — one in a comment ends the template literal and the error
     lands on the next word.) */
  .sv-print { transform-origin: 50% 50%; will-change: transform; }
  .sv-print-flight { position: absolute; left: 50%; top: 50%; }
  .sv-print-paper { background: var(--sv-paper); padding: var(--sv-pad) var(--sv-pad) 0;
    box-shadow: 0 18px 46px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4); }
  .sv-print-frame { position: relative; overflow: hidden; background: #05070d; line-height: 0; }
  .sv-print-photo { display: block; width: 100%; height: auto; }

  /* THE UNDEVELOPED PRINT. A flat sheet of emulsion over the picture that
     fades off it — the picture underneath is already there, which is what
     makes this cost nothing. The tint drains at the same time, so the first
     thing to arrive is a grey ghost and the colour comes up under it. */
  /* Developed is the DEFAULT — a print that is not currently coming out of a
     camera is a finished photograph, and an emulsion that had to be switched
     off would cover every print on the score screen. */
  .sv-print-dev { position: absolute; inset: 0; background: var(--sv-emulsion); opacity: 0;
    transition: opacity var(--sv-develop) ease-out var(--sv-develop-delay); }
  .sv-print-photo { transition: filter var(--sv-develop) ease-out var(--sv-develop-delay); }
  .sv-print-wet .sv-print-dev { opacity: 1; }
  .sv-print-wet .sv-print-photo { filter: saturate(0.1) contrast(0.75) brightness(1.15); }
  .sv-print-dry .sv-print-dev { opacity: 0; }
  .sv-print-dry .sv-print-photo { filter: none; }

  /* The chin: the wide bottom border that makes a print a print, with the
     name written across it. */
  .sv-print-chin { display: flex; justify-content: space-between; align-items: baseline;
    gap: 10px; color: var(--sv-ink); padding: calc(var(--sv-pad) * 0.62) 2px calc(var(--sv-pad) * 1.5);
    font-size: var(--sv-chin); letter-spacing: 0.02em; }
  .sv-print-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .sv-print-stat { font-weight: 600; opacity: 0.55; white-space: nowrap;
    font-variant-numeric: tabular-nums; }

  /* THE RIVE PAPER. The artboard draws the whole print — paper, photograph,
     chin and all — so there is no border and no chin to style here.

     IT ALSO OWNS THE DEVELOP. The canvas used to carry .sv-print-photo so the
     emulsion above applied to it too, one develop whichever renderer drew the
     print. That is over: the artboard fades its photograph in itself as part
     of tWriteOn, and a sheet of emulsion over the canvas would hide exactly
     the animation the trigger exists to play. Nothing here fades a Rive print.

     drop-shadow rather than box-shadow, because the canvas is transparent
     around the paper and a box shadow would trace the CANVAS — a hard
     rectangle floating well outside the print. */
  .sv-print-frame-riv { position: relative; line-height: 0;
    filter: drop-shadow(0 14px 34px rgba(0,0,0,0.55)) drop-shadow(0 2px 5px rgba(0,0,0,0.4)); }

  /* A player who has asked for less motion gets the print, in place, with no
     flight and no flash. The information is the picture; the animation is the
     flourish, and it is the flourish that makes people ill. */
  @media (prefers-reduced-motion: reduce) {
    .sv-print { transition: none !important; }
    .sv-print-dev, .sv-print-photo { transition: none !important; }
    .sv-print-flash { display: none; }
  }
`;

// The sheet is mounted separately from the layer because the score screen
// builds prints (buildPrintPaper) without ever flying one: with the flight
// switched off, or on a run whose prints were all shown before a reload, the
// fan would otherwise render as unstyled markup — a column of raw <img> with
// no paper around it.
let styled = false;

function mountStyles() {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function mount() {
  if (layer) return layer;
  mountStyles();

  layer = document.createElement('div');
  layer.className = 'sv-print-layer';
  flashEl = document.createElement('div');
  flashEl.className = 'sv-print-flash';
  layer.appendChild(flashEl);
  // The flash is NOT in the pile: it is a full-screen blink belonging to the
  // camera, and sliding it up with the prints would drag a white sheet off the
  // top of the screen on every kill.
  pileEl = document.createElement('div');
  pileEl.className = 'sv-print-pile';
  layer.appendChild(pileEl);
  document.body.appendChild(layer);
  window.addEventListener('resize', relayout);
  return layer;
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Stop a parked card drawing, and drop nothing else. */
function settle(el) {
  if (el?._svCard) settleSnapshotCard(el._svCard);
}

// ---------------------------------------------------------------------------
// THE PILE COMES AND GOES
//
// A print that has parked has been LOOKED AT. Leaving the whole run's stack in
// the corner turns a trophy into clutter — by the fifth boss it is a wall of
// paper across the top of the screen, over the water the player is aiming
// into. So the pile sits for a few seconds and then eases out of frame, and
// comes back for the two moments it is worth seeing again: the pause menu,
// where the player is looking at their run rather than playing it, and the
// next kill, where the new print needs somewhere to land.
//
// THE SLIDE IS A CSS TRANSITION, on the wall clock, for the same reason the
// flight is: this plays over a frame that is deliberately running at a tenth
// speed, and anything driven from the game loop would take nine seconds to
// leave. The curve comes from ease.js through cssEase, so the name in config
// is the same name every other curve in the game is picked by.
// ---------------------------------------------------------------------------

function pileCfg() {
  return cfg().pile ?? {};
}

// HOW FAR IT HAS TO GO. Positive is down; the pile lives in the top-left corner
// so leaving means a negative number, up through the top edge.
//
// `dy: null` measures instead of guessing. The pile grows as a run goes on —
// eight prints fan further down the corner than one — and a fixed offset that
// clears a single print leaves the bottom of a full stack peeking into frame.
// The measurement is of the real boxes, so it is right at any stack size,
// print size or screen size. A number in config overrides it outright.
function hideOffset() {
  const set = pileCfg().dy;
  if (Number.isFinite(set)) return set;
  let bottom = 0;
  for (const p of parked) bottom = Math.max(bottom, p.el.getBoundingClientRect().bottom);
  return -(bottom + num(pileCfg().clearance, 24));
}

function applyPile(hidden, ms, easeName) {
  if (!pileEl) return;
  window.clearTimeout(gonePlease);
  // A PURE SLIDE. No opacity in here on purpose: a fade reads as the prints
  // dissolving where they sit, which is a different idea from them being put
  // away, and it also makes the pile linger as a ghost over the water for the
  // whole of the travel.
  pileEl.style.transition = `transform ${Math.max(0, ms)}ms ${cssEase(easeName)}`;
  // Back into the paint path BEFORE it moves, or the return journey animates
  // something the compositor has been told not to draw.
  if (!hidden) {
    pileEl.style.visibility = '';
    void pileEl.offsetWidth;
  }
  pileEl.style.transform = hidden ? `translateY(${hideOffset()}px)` : 'translateY(0px)';
  pileHidden = hidden;

  // AND THEN IT STOPS COSTING ANYTHING. Off the top of the screen the prints
  // are still a composited layer per print for the rest of the run, so once the
  // slide is done the whole pile goes visibility:hidden — no paint, no
  // compositing, and the browser skips the subtree. The Rive cards inside were
  // already paused as each one parked (see settle), so nothing is left running.
  //
  // On a timer rather than transitionend, for the reason the flight is: the
  // event is per property and is missed outright if the tab is backgrounded
  // mid-slide, and a pile that never gets hidden is the cost this exists to
  // avoid, quietly still being paid.
  if (hidden) {
    gonePlease = window.setTimeout(() => {
      if (pileHidden) pileEl.style.visibility = 'hidden';
    }, Math.max(0, ms) + 60);
  }
}

/** Ease the pile out of frame. Ignored while something is holding it open. */
function hidePile() {
  if (pileSticky || pileHidden || !parked.length) return;
  applyPile(true, num(pileCfg().hideMs, 620), pileCfg().hideEase ?? 'inCubic');
}

// Bring it back, and start the clock that takes it away again. Called on every
// new print and whenever something that was holding it open lets go.
function armHide() {
  window.clearTimeout(hideTimer);
  if (pileSticky) return;
  hideTimer = window.setTimeout(hidePile, Math.max(0, num(pileCfg().holdMs, 3200)));
}

/**
 * Show the pile now.
 *
 * @param sticky keep it up until releasePile() — what the pause menu wants.
 *               Without it the pile would drift away three seconds into a
 *               menu the player is still reading.
 */
export function revealPile(sticky = false) {
  if (!pileEl || pileCfg().enabled === false) return;
  if (sticky) pileSticky = true;
  window.clearTimeout(hideTimer);
  applyPile(false, num(pileCfg().showMs, 520), pileCfg().showEase ?? 'outCubic');
  if (!sticky) armHide();
}

/** Let go of a sticky pile, and let the clock take it away again. */
export function releasePile() {
  pileSticky = false;
  armHide();
}

/** For the harness: is the pile currently out of frame? */
export function pileIsHidden() {
  return pileHidden;
}

/**
 * Start loading the artboard, minutes before any boss exists — see
 * initSnapshotCards. Called from initUI, next to the boss bar's.
 */
export function initSnapshotPrints() {
  return initSnapshotCards();
}

// How wide the print is on screen. In vw with a floor and a ceiling rather
// than a flat pixel size: this has to be a third of the screen on a phone held
// sideways and on a 32" monitor, and neither a fixed 420px nor a bare 34vw is
// both.
function printWidth() {
  const c = cfg();
  const w = window.innerWidth * (num(c.widthVw, 34) / 100);
  return Math.round(Math.max(num(c.minWidth, 200), Math.min(num(c.maxWidth, 520), w)));
}

// Where slot `n` of the pile sits: a fixed distance in from the corner, plus a
// small step per print so the pile fans instead of stacking into one shape.
// The tilts repeat rather than growing, or the tenth print would be upside
// down.
const TILTS = [-6.5, -3.2, -8.4, -4.6, -7.2, -2.4];

function slotFor(n) {
  const c = cfg();
  return {
    x: num(c.marginX, 16) + n * num(c.stackDx, 7),
    y: num(c.marginY, 26) + n * num(c.stackDy, 5),
    tilt: TILTS[n % TILTS.length],
  };
}

// The parked transform, in pixels, for a print of this size in this slot.
//
// The element is centred on the viewport by `left/top: 50%` and pulled back by
// its own half-size with the -50% pair, so everything here is expressed as a
// delta from the middle of the screen. The scale is about the element's centre
// (transform-origin above), so landing its top-left corner at the slot means
// aiming its CENTRE at the slot plus half its SCALED size — forgetting that
// half is what puts the pile a print's width off the edge of the screen.
function parkTransform(el, n) {
  const c = cfg();
  const w = el.offsetWidth || printWidth();
  const h = el.offsetHeight || w;
  const scale = Math.min(1, num(c.cornerWidth, 132) / Math.max(1, w));
  const slot = slotFor(n);
  const dx = slot.x + (w * scale) / 2 - window.innerWidth / 2;
  const dy = slot.y + (h * scale) / 2 - window.innerHeight / 2;
  return `translate(calc(-50% + ${Math.round(dx)}px), calc(-50% + ${Math.round(dy)}px))`
    + ` rotate(${slot.tilt}deg) scale(${scale.toFixed(4)})`;
}

function relayout() {
  for (const p of parked) {
    p.el.style.transition = 'none';
    p.el.style.transform = parkTransform(p.el, p.slot);
    // Read it back so the transition-none actually takes effect before the
    // next line puts the transition back — without this the browser coalesces
    // both writes and the pile SLIDES to its new place on every resize tick.
    void p.el.offsetWidth;
    p.el.style.transition = '';
  }
}

/**
 * One print, as paper: the photograph, the border and the chin. No position,
 * no transition, no flight — just the object.
 *
 * Exported because the score screen fans the whole run's prints out (see
 * showRecap in ui/ui.js) and they have to be the SAME piece of paper the
 * player watched come out of the camera. Two implementations of a polaroid
 * would drift apart the first time either is retuned, and the one that drifted
 * would be the one the player is asked to share.
 *
 * @param width in pixels. The border, the chin and the type are all derived
 *              from it, so a print is one shape at any size.
 */
export function buildPrintPaper(url, meta = {}, width = 240) {
  mountStyles();
  const c = cfg();
  const w = Math.max(80, Math.round(width));

  // THE RIVE PAPER, when there is one. Two conditions, and the second is the
  // one that matters: `meta.square` is the UNCAPTIONED square crop of the
  // frame, and without it the only picture on hand is the composited one with
  // a caption already burnt into it — which inside an artboard that draws its
  // own chin would read as a print of a print. A run whose capture path has
  // not handed one over falls through to the coded paper, which is a look the
  // game already shipped rather than a broken one.
  const card = (snapshotCardsLive() && meta.square)
    ? buildSnapshotCard({ photo: meta.square, meta: cardTextFor(meta), width: w })
    : null;

  if (card) {
    const el = document.createElement('div');
    el.className = 'sv-print sv-print-riv';
    el.style.width = `${w}px`;
    // NO EMULSION, AND NO DEVELOP FILTER, and that is the whole difference
    // between the two papers now. The artboard fades its own photograph in as
    // part of `tWriteOn` — a grey sheet over the canvas would cover the
    // animation it exists to play, and a saturate/contrast filter on the
    // canvas would be a second develop fighting the first.
    //
    // So the card carries neither `.sv-print-photo` nor a `.sv-print-dev`
    // sibling, which leaves the `.sv-print-wet` / `.sv-print-dry` classes the
    // flight still sets on it matching nothing. They are left on rather than
    // branched around: they are how the flight describes its own state, and
    // the coded paper below reads them exactly as it always did.
    const frame = document.createElement('div');
    frame.className = 'sv-print-frame-riv';
    card.canvas.setAttribute('role', 'img');
    card.canvas.setAttribute('aria-label', meta.name ? `You beat ${meta.name}` : 'Your boss kill');
    frame.appendChild(card.canvas);
    el.appendChild(frame);
    // Held so the flight can stop the card drawing once it has parked, and so
    // a reset can drop the runtime instance rather than the element alone.
    el._svCard = card.canvas;
    // Held so the flight can wait for the card to finish binding before firing
    // its write-on. Only the flight uses it; the score screen's fan never does.
    el._svCardReady = card.ready;
    return el;
  }

  const el = document.createElement('div');
  el.className = 'sv-print';
  el.style.width = `${w}px`;
  el.style.setProperty('--sv-paper', c.paper ?? '#eef2f3');
  el.style.setProperty('--sv-ink', c.ink ?? '#232b33');
  el.style.setProperty('--sv-emulsion', c.emulsion ?? '#e7ebec');
  el.style.setProperty('--sv-pad', `${Math.max(4, Math.round(w * num(c.paperPad, 0.038)))}px`);
  el.style.setProperty('--sv-chin', `${Math.max(9, Math.round(w * num(c.chinSize, 0.045)))}px`);
  el.style.setProperty('--sv-develop', `${num(c.developMs, 620)}ms`);
  el.style.setProperty('--sv-develop-delay', `${num(c.developDelayMs, 120)}ms`);
  el.innerHTML = `
    <div class="sv-print-paper">
      <div class="sv-print-frame">
        <img class="sv-print-photo" alt="" />
        <div class="sv-print-dev"></div>
      </div>
      <div class="sv-print-chin">
        <span class="sv-print-name"></span>
        <span class="sv-print-stat"></span>
      </div>
    </div>`;
  el.querySelector('.sv-print-photo').src = url;
  el.querySelector('.sv-print-photo').alt = meta.name ? `You beat ${meta.name}` : 'Your boss kill';
  el.querySelector('.sv-print-name').textContent = meta.name ?? '';
  el.querySelector('.sv-print-stat').textContent =
    `LV ${meta.level ?? 0} · ${formatTime(meta.time)}`;
  return el;
}

/**
 * A boss went down and the picture has been taken. Pop it.
 *
 * @param url  the composited PNG, straight out of systems/bossShot.js.
 * @param meta { name, level, time } for the chin.
 * @returns the element, or null when the print is switched off.
 */
export function showSnapshotPrint(url, meta = {}) {
  const c = cfg();
  if (c.enabled === false || !url) return null;
  mount();

  // THE FLASH. Restarted rather than merely re-triggered: a class that is
  // already on the element does not replay an animation, and the second boss
  // of a run would go off in silence. The reflow between the two writes is
  // what makes the removal real.
  if (num(c.flashMs, 90) > 0) {
    flashEl.classList.remove('sv-print-lit');
    void flashEl.offsetWidth;
    flashEl.style.setProperty('--sv-flash', `${num(c.flashMs, 90)}ms`);
    flashEl.style.setProperty('--sv-flash-alpha', String(num(c.flashAlpha, 0.55)));
    flashEl.classList.add('sv-print-lit');
  }

  const w = printWidth();
  const el = buildPrintPaper(url, meta, w);
  el.classList.add('sv-print-flight', 'sv-print-wet');

  // OUT OF THE BOTTOM OF THE FRAME. Placed there with no transition at all, so
  // the start of the flight is a position rather than an animation from
  // wherever the browser thought the element was.
  const eject = num(c.ejectMs, 260);
  el.style.transition = 'none';
  el.style.transform = `translate(-50%, calc(-50% + ${Math.round(window.innerHeight * 0.62)}px))`
    + ` rotate(${num(c.ejectTilt, 2.5)}deg) scale(${num(c.ejectScale, 0.94)})`;
  // Into the pile, not the layer — and the pile is brought back to zero FIRST.
  // A print flying into a container that is still translated off the top of
  // the screen would eject, develop and park entirely out of frame, and the
  // slow motion the kill bought would play over nothing at all.
  pileEl.appendChild(el);
  revealPile();

  const slot = slotCount++;
  const settled = `translate(-50%, -50%) rotate(${num(c.tilt, -2)}deg) scale(1)`;

  // Then the same element, one frame later, with the transition on and the
  // settled transform — which is the whole flight. Two frames of rAF rather
  // than one: a single frame is enough for the layout but not reliably enough
  // for the style flush on a browser that is busy compositing a boss dying,
  // and a missed flush is a print that simply appears in the middle of the
  // screen with no travel at all.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.transition = `transform ${eject}ms cubic-bezier(0.16, 0.9, 0.28, 1.06)`;
    el.style.transform = settled;
    el.classList.remove('sv-print-wet');
    el.classList.add('sv-print-dry');
  }));

  // THE WRITE-ON, on the frame the print stops moving.
  //
  // WHY NOT AT THE POP. The card is built, bound and playing while it is still
  // below the bottom of the screen, and it then crosses the whole frame. An
  // animation fired there is one nobody sees the start of and most of nobody
  // sees at all — it would be over, or nearly, by the time the paper arrives.
  // "Fully visible" is the end of the eject, which is this timer.
  //
  // ONCE PER PRINT, AND ONLY HERE. buildPrintPaper is also how the score
  // screen lays out its fan, and those are the same photographs a second time
  // — a card that writes itself on again every time it is laid out is an
  // animation about nothing. Firing from the flight rather than from the build
  // is what keeps that distinction, and it is why this is not inside
  // buildSnapshotCard where it would look more natural.
  //
  // Same generation guard as the park below: a run restarted mid-flight must
  // not fire a trigger at a card whose runtime has already been dropped.
  const era = generation;
  const writeOnAt = eject;
  window.setTimeout(() => {
    if (era !== generation) return;
    if (el._svCard) playCardWriteOn(el._svCard, el._svCardReady);
  }, writeOnAt);

  // Held long enough to be looked at, then away to the corner. On timers
  // rather than on transitionend: `transitionend` fires per property and can
  // be missed entirely if the tab is backgrounded mid-flight, and a print that
  // never gets its park class is one stuck across the middle of the screen for
  // the rest of the run.
  const park = num(c.parkMs, 520);
  window.setTimeout(() => {
    if (era !== generation) return;
    el.style.transition = `transform ${park}ms cubic-bezier(0.5, 0, 0.2, 1)`;
    el.style.transform = parkTransform(el, slot);
    parked.push({ el, slot });
    trim();
    // Once it has landed it is a still photograph in a corner, and a Rive card
    // left playing would redraw an artboard sixty times a second for the rest
    // of the run — per print, on top of the fight. The last frame stays on the
    // canvas; only the loop stops.
    window.setTimeout(() => {
      if (era !== generation) return;
      settle(el);
      // The clock only starts once the print has actually landed. Starting it
      // at the pop instead would have the pile drift away while the newest
      // print was still crossing the screen toward it.
      armHide();
    }, park + 40);
    // The longer of the beat and the write-on, not the sum: they are the same
    // stillness. The print stops moving, the artboard draws itself on, and the
    // paper leaves once BOTH the animation has finished and the print has been
    // stood still long enough to look at. Must agree with printPhaseSeconds in
    // systems/bossKill.js, or the ocean comes back under a print that is still
    // on its way to the corner.
  }, eject + Math.max(num(c.holdMs, 620), num(c.writeOnMs, 800)));

  return el;
}

// The pile has a depth. Past it the oldest print is dropped — eight kills is
// already more than a corner can hold, and a run that somehow goes further
// would otherwise build a wall of paper across the top of the screen.
function trim() {
  const max = Math.max(1, num(cfg().stackMax, 8));
  while (parked.length > max) {
    const gone = parked.shift();
    gone.el.remove();
  }
}

/** A new run: the corner starts empty. Every print goes, wherever it was. */
export function resetSnapshotPrints() {
  generation += 1;
  // The runtime instances go with them. An element removed from the document
  // still owns a Rive instance and its render loop, so dropping the pile
  // without this leaks one artboard per boss for the life of the tab.
  releaseAllSnapshotCards();
  for (const p of parked) p.el.remove();
  parked.length = 0;
  slotCount = 0;
  // Prints still in flight are not in `parked` yet — their timer is pending
  // and is disarmed by the generation bump above. Emptying the pile is what
  // actually takes them off the screen.
  if (pileEl) pileEl.replaceChildren();
  // And the corner starts SHOWING. A run that ended with the pile eased out
  // would otherwise begin with it still translated off the top, and the first
  // print of the new run would fly to a corner that is not on screen — the
  // reveal on the next pop fixes it, but only after a print has already been
  // thrown at an empty space.
  window.clearTimeout(hideTimer);
  window.clearTimeout(gonePlease);
  pileSticky = false;
  if (pileEl) {
    pileEl.style.transition = 'none';
    pileEl.style.transform = 'translateY(0px)';
    pileEl.style.visibility = '';
    // Read back so the transition-none lands before anything re-arms it —
    // without this the browser coalesces the writes and the empty pile SLIDES
    // back into place at the start of every run.
    void pileEl.offsetWidth;
    pileEl.style.transition = '';
  }
  pileHidden = false;
}

/** For the harness: how many prints are on screen. */
export function snapshotPrintCount() {
  return pileEl ? pileEl.children.length : 0;
}
