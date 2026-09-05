// THE POLAROID, drawn by Rive.
//
// One artboard is now the look of a kill shot everywhere it appears: the print
// that ejects mid-run, the fan on the score screen, and (once the caption path
// is retired) the image that gets shared. Before this there were two polaroids
// — a CSS one in snapshotPrint.js and a canvas2d caption baked into the PNG —
// and they were already drifting: different type, different chin, different
// idea of where the level goes.
//
// WHAT THIS FILE OWNS: turning a photograph and a run's numbers into a canvas
// with the `Polaroid` artboard drawn on it. It does NOT own the paper's
// markup, its classes, or the flight — snapshotPrint.js keeps all of that, so
// the develop-and-fly choreography stays in one place whichever renderer is
// drawing. Nor does it own the stylesheet: the class names it is wrapped in
// belong to snapshotPrint.js, which mounts them.
//
// THE CODED PAPER IS STILL THERE. Every export below reports whether Rive is
// actually drawing, and snapshotPrint.js builds its CSS paper whenever the
// answer is no — the same promise bossBarRive.js makes about the health bar,
// for the same reason. This is a WASM runtime, a 1.7MB file the game does not
// author, and a boss kill with no trophy is worse than a plain one.
//
// ONE PARSE FOR THE WHOLE RUN. The file is parsed once at boot into a RiveFile
// and every card is an instance off it: measured at 48ms to parse and ~3ms per
// card, against ~48ms EACH if every card re-parsed. That is only possible
// because the photograph is an image property on the view model instance
// rather than a substituted file asset — assets belong to the file and every
// instance would share one picture. See riveContract.js.

// NOTHING RIVE IS IMPORTED AT MODULE SCOPE, and that is not a bundling
// preference — it is what keeps this file importable from a Node harness.
// tools/boss-shot-test.mjs drives the real snapshotPrint.js, which now reaches
// this module, and `@rive-app/canvas` has no Node build: a static import takes
// the whole suite down at parse time with an export that does not exist, long
// before any test runs. The runtime, the WASM url and the 1.7MB file are all
// pulled in by initSnapshotCards() instead, which a harness simply never calls.
import { SNAPSHOT_ARTBOARD, SNAPSHOT_BINDINGS, SNAPSHOT_KICKER } from './riveContract.js';
import { playerName } from '../systems/playerName.js';
import { CONFIG } from '../config.js';
import { mark as crumb } from '../systems/crashLog.js';

// The artboard's own shape. Anything that sizes a card derives its height from
// its width through this, so a card is one proportion at every size it is
// drawn at — 340px in flight, 132px parked, 1600px in a shared file.
export const CARD_W = 800;
export const CARD_H = 1000;
export const CARD_ASPECT = CARD_H / CARD_W;

const state = {
  rive: null,   // the module namespace, once it has been pulled in
  file: null,   // the parsed RiveFile every card is an instance off
  ready: false,
  failed: false,
  loading: null,
};

// Every live card, so a reset can drop the WASM instances rather than leaking
// one per boss for the life of the tab.
const live = new Map(); // canvas -> { rive, photo }

function cfg() {
  return CONFIG.boss?.kill?.print ?? {};
}

/** Is the Rive polaroid actually available? There is no other polaroid — the
 *  coded paper snapshotPrint.js used to fall back to was deleted 2026-09-05 —
 *  so false here means a boss kill takes no print at all. */
export function snapshotCardsLive() {
  return !!(state.ready && !state.failed && cfg().rive !== false);
}

/**
 * Parse the file, once, at boot.
 *
 * EAGER FOR THE SAME REASON THE BAR IS. The alternative is paying a 1.7MB
 * fetch and parse on the frame a boss dies — the single worst frame in the run
 * to hand the main thread anything, and the one frame this feature exists to
 * decorate. At boot it costs one parsed file held for the session.
 *
 * Safe to call twice; the second call returns the first one's promise.
 */
export function initSnapshotCards() {
  if (state.loading) return state.loading;
  if (cfg().rive === false) return Promise.resolve(false);

  state.loading = (async () => {
    try {
      // Order matters: riveRuntime.js points the loader at our own bundled
      // WASM, and setWasmUrl only has any effect BEFORE the first instance is
      // built. Awaited here, ahead of the parse, rather than left to whichever
      // Rive surface happens to construct something first.
      const [mod, , riv] = await Promise.all([
        import('@rive-app/canvas'),
        import('./riveRuntime.js'),
        import('./seal_survivor.riv?url'),
      ]);
      state.rive = mod;
      const buf = await (await fetch(riv.default)).arrayBuffer();
      state.file = await new Promise((resolve, reject) => {
        const f = new mod.RiveFile({ buffer: buf, onLoad: () => resolve(f), onLoadError: reject });
        f.init();
      });
      // ONE REFERENCE THAT IS NEVER GIVEN BACK, and without it this whole
      // module works exactly once.
      //
      // A RiveFile is reference counted from ZERO. Every Rive instance built
      // from it takes a reference (getInstance, +1) and every cleanup() gives
      // one back (-1) — and at zero the file RELEASES ITSELF and sets
      // `destroyed`. So the first card to be torn down takes the shared file
      // with it, and every card after that fails to load: the score screen's
      // prints stop appearing, the next boss's does too, and the share button
      // returns null. All of it silent, and all of it looking like an
      // intermittent Rive bug rather than a refcount hitting zero.
      //
      // Holding one reference for the life of the session pins the count at 1
      // or above. Nothing releases it: the file is meant to outlive every card,
      // and the tab closing is what frees it.
      state.file.getInstance();
      state.ready = true;
      return true;
    } catch (err) {
      // Offline, a bad CDN day, a renamed artboard. The run carries on
      // WITHOUT trophies now rather than with a second-best paper — see the
      // note in ui/snapshotPrint.js for why the fallback was deleted — and
      // none of it is worth a broken frame.
      console.warn(`[snapshotCard] Rive polaroid unavailable; this run takes no prints — ${err}`);
      state.failed = true;
      return false;
    }
  })();
  return state.loading;
}

// PNG bytes out of whatever the caller had. A canvas is the usual case — the
// square crop of the frame that was just grabbed — and toBlob is preferred
// over toDataURL because it skips base64ing two megabytes to immediately
// un-base64 it again.
async function toBytes(photo) {
  if (!photo) return null;
  if (photo instanceof Uint8Array) return photo;
  if (typeof photo === 'string') return new Uint8Array(await (await fetch(photo)).arrayBuffer());
  if (photo instanceof Blob) return new Uint8Array(await photo.arrayBuffer());
  if (typeof photo.toBlob === 'function') {
    const blob = await new Promise((r) => photo.toBlob(r, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
  if (typeof photo.toDataURL === 'function') {
    return new Uint8Array(await (await fetch(photo.toDataURL('image/png'))).arrayBuffer());
  }
  return null;
}

/**
 * A run's raw numbers as the card's strings.
 *
 * ALL STRINGS, INCLUDING THE NUMBERS — Rive cannot format, so a score needs
 * its separators and a time needs to be m:ss before it gets here. It lives in
 * this module rather than in whichever surface happens to want a card, because
 * the print, the score-screen fan and the shared file all go through it: a
 * player comparing the picture they posted against the screen they posted it
 * from has to be reading one set of figures.
 *
 * @param meta { name, cause, player, level, time, score } — time in SECONDS,
 *             score raw. `player` is optional; see the fallback below.
 */
export function cardTextFor(meta = {}) {
  const s = Math.max(0, Math.floor(meta.time ?? 0));
  const snap = CONFIG.boss?.kill?.snapshot ?? {};
  return {
    name: meta.name ?? '',
    // Passed through rather than formatted: it arrives as a weapon's display
    // name from systems/boss.js, and there is nothing left to do to it. Empty
    // when the run has no record of what landed the last hit, which the
    // artboard has to be able to draw — a stamp is the one element on this
    // card that is allowed to be missing.
    cause: meta.cause ?? '',
    // FALLS BACK TO A LIVE READ rather than to a blank. A shot always carries
    // its own name (systems/bossShot.js banks it on capture), so the fallback
    // is for the metas that are not shots: the demo card behind the Text panel,
    // a look page, anything that hands this function four numbers. Those should
    // show a name, and the one this player is called is the right one — a card
    // with an empty title reads as a broken write rather than as a preview.
    player: meta.player ?? playerName(),
    // Passed through, already carrying its trailing space — see kickerTable.js
    // for why the space is added there and not in the file. A meta with no
    // kicker is a preview or a demo card, and those get the straight reading
    // rather than a roll: a page being looked at should not change its own
    // caption between two glances at it.
    kicker: meta.kicker ?? SNAPSHOT_KICKER,
    level: `LVL ${meta.level ?? 0}`,
    time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
    score: Math.floor(meta.score ?? 0).toLocaleString(),
    wordmark: snap.wordmark ?? 'Seal Survivor',
  };
}

// Everything the card says, written in one place so the print, the fan and the
// shared file cannot caption the same kill differently.
//
// ALL STRINGS, INCLUDING THE NUMBERS. Rive has no number formatting: a score
// needs its thousands separators and a time needs to be m:ss, and both have to
// arrive already written. The formatters live with the run, not here.
function writeMeta(vmi, meta = {}) {
  // A NAME THE ARTBOARD DOES NOT HAVE IS A NO-OP, and that is the safe
  // direction — it is what lets the game write a property before the export
  // that draws it exists (see PENDING_BINDINGS in riveContract.js). It is also
  // completely silent, which is the wrong direction the day a property is
  // RENAMED in the editor: the card keeps drawing, with one field stuck on
  // whatever default value the artboard was saved with, and nothing anywhere
  // says so. `npm run test:bossbar` scans the shipped file for exactly this,
  // but only for the names in the contract, and only when somebody runs it.
  // So the miss is collected and reported once per session as well.
  const missing = [];
  const set = (key, value) => {
    const prop = vmi.string(SNAPSHOT_BINDINGS[key]);
    if (!prop) { missing.push(SNAPSHOT_BINDINGS[key]); return; }
    prop.value = value;
  };
  set('name', meta.name ?? '');
  set('cause', meta.cause ?? '');
  set('player', meta.player ?? '');
  // The trailing space is load-bearing — see SNAPSHOT_KICKER. What arrives here
  // has one already: kickerTable.js adds it on the way out of the table, which
  // is the only place it is ever added.
  set('kicker', meta.kicker ?? SNAPSHOT_KICKER);
  set('level', meta.level ?? '');
  set('time', meta.time ?? '');
  set('score', meta.score ?? '');
  set('wordmark', meta.wordmark ?? '');
  if (missing.length) warnNoStrings(missing);
}

// Once per session, like the write-on's. A run that beats eight bosses would
// otherwise print the same list eight times, and it is the same export every
// time.
let warnedNoStrings = false;
function warnNoStrings(missing) {
  if (warnedNoStrings) return;
  warnedNoStrings = true;
  console.warn(
    `[snapshotCard] the Polaroid view model has no ${missing.map((n) => `"${n}"`).join(', ')} `
    + 'property — those fields will show whatever the artboard was exported with.',
  );
}

/**
 * A canvas with the polaroid drawn on it, sized to `width` in CSS pixels.
 *
 * Returns synchronously with a canvas that is briefly EMPTY: the artboard
 * binds on the next tick and the photograph has to be decoded before it can be
 * assigned. That is not a defect to paper over — it is the develop. The print
 * arrives as blank emulsion and the picture comes up under it, which is
 * exactly what the wet/dry classes in snapshotPrint.js are already animating.
 *
 * @param photo  a canvas, blob, PNG bytes or data URL. The SQUARE crop of the
 *               frame — the artboard's zone is 620x620 and a 16:9 picture
 *               would be cropped by the fill rather than by the game.
 * @param meta   { name, kicker, cause, player, level, time, score, wordmark },
 *               already formatted.
 * @param width  CSS pixels. Height follows from CARD_ASPECT.
 * @returns { canvas, ready } — ready resolves once the photo is on it.
 */
export function buildSnapshotCard({ photo, meta, width = 340, pixelRatio } = {}) {
  if (!snapshotCardsLive()) return null;
  crumb('card:rive', Math.round(width));

  const w = Math.max(48, Math.round(width));
  const canvas = document.createElement('canvas');
  // Backed at device resolution: the card is mostly hand-drawn type, and type
  // rendered at CSS pixels on a 2x screen is the one thing that would make the
  // Rive paper look worse than the CSS paper it replaced.
  //
  // OVERRIDABLE, because a card destined for a file has no screen to match.
  // The run sheet composes at fixed pixel sizes, and letting a 3x phone quietly
  // triple every cell is how eight polaroids become 70MB of backing store and
  // a sheet nobody can share.
  const dpr = pixelRatio ?? Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(w * CARD_ASPECT * dpr);
  // THE SHAPE IS DECLARED, NOT INHERITED FROM THE BACKING STORE. `height: auto`
  // on a canvas takes its ratio from the width/height ATTRIBUTES, and those are
  // not ours alone: Rive re-sizes the drawing surface of every canvas it owns
  // whenever that canvas goes from display:none back to displayed, and it takes
  // the new size from getBoundingClientRect. On the score screen that toggle
  // happens at the halfway point of a card flip, so the rect it reads is the
  // card's PROJECTION — a print two thirds edge-on — and the surface comes back
  // a quarter as wide as it is meant to be. With the ratio declared here, the
  // worst that does is letterbox the drawing for the rest of the turn;
  // resyncSnapshotCards() puts the surface back when the card lands. Without
  // it, `height: auto` followed that ruined ratio and blew a 238px print up to
  // eleven hundred, which pushes the fan, the buttons and the board out of the
  // bottom of a face that clips — the card comes back "empty".
  canvas.style.cssText = `display:block; width:100%; height:auto; aspect-ratio:${CARD_W}/${CARD_H};`;
  // What the surface is MEANT to be, so a resize we did not ask for can be
  // undone without measuring anything. See resyncSnapshotCards.
  const surface = { w: canvas.width, h: canvas.height };

  const ready = (async () => {
    const { Rive, Layout, Fit, Alignment, decodeImage } = state.rive;
    const bytes = await toBytes(photo);
    const rive = await new Promise((resolve) => {
      const r = new Rive({
        riveFile: state.file,
        canvas,
        artboard: SNAPSHOT_ARTBOARD,
        // Without autoBind there is no view model instance and every write
        // below is a silent no-op.
        autoBind: true,
        autoplay: true,
        layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
        onLoadError: (e) => {
          console.warn(`[snapshotCard] a card failed to load — ${e}`);
          resolve(null);
        },
        onLoad: () => resolve(r),
      });
    });
    if (!rive) return null;

    const vmi = rive.viewModelInstance;
    if (!vmi) {
      console.warn('[snapshotCard] the Polaroid artboard bound no view model.');
      rive.cleanup();
      return null;
    }
    // REGISTERED BEFORE THE PHOTOGRAPH, not after it. The image below is a
    // decode of up to two megabytes and the card is turnable the whole time it
    // is running — a flip that lands during it would find no entry here and
    // leave that card's surface as Rive last measured it. The view model is
    // kept alongside the instance so the write-on can be fired later, from the
    // flight, without re-reading it off a Rive object the caller has no
    // business holding.
    live.set(canvas, { rive, vmi, surface });
    writeMeta(vmi, meta);

    let image = null;
    if (bytes) {
      image = await decodeImage(bytes);
      const slot = vmi.image(SNAPSHOT_BINDINGS.shot);
      if (slot) slot.value = image;
      // The artboard holds its own reference now. Ours is released here rather
      // than at teardown: an image kept per card is a bitmap per boss held for
      // the life of the tab.
      image.unref();
    }

    const machines = rive.stateMachineNames ?? [];
    if (machines.length) rive.play(machines[0]); else rive.play();
    return rive;
  })();

  return { canvas, ready };
}

/**
 * Play the card's write-on — the artboard drawing itself onto the paper.
 *
 * SEPARATE FROM BUILDING IT, because the two happen seconds apart and in the
 * wrong order to be one step. A card is built, bound, given its photograph and
 * set playing while it is still off the bottom of the screen; it becomes
 * something a player is LOOKING at only once the flight has landed it in the
 * middle. The artboard cannot know that moment. This is the game telling it.
 *
 * Awaits the card's own `ready` when it is handed one, because a print can land
 * before its image has finished decoding on a slow frame — and a trigger fired
 * at a view model that does not exist yet is the quietest possible failure:
 * the print simply sits there fully drawn, having skipped its own animation,
 * with nothing logged.
 *
 * Returns whether it actually fired, for the test and for nothing else.
 */
export async function playCardWriteOn(canvas, ready = null) {
  if (!canvas) return false;
  try {
    if (ready) await ready;
  } catch { /* the card failed to load; the paper below it is still fine */ }
  const vmi = live.get(canvas)?.vmi;
  if (!vmi) return false;
  try {
    const trigger = vmi.trigger(SNAPSHOT_BINDINGS.writeOn);
    if (!trigger) {
      // An export without it. Worth one line, because the visible result is
      // "the print is a bit flat" rather than anything anybody would report.
      warnNoWriteOn();
      return false;
    }
    trigger.trigger();
    return true;
  } catch (err) {
    warnNoWriteOn(err);
    return false;
  }
}

// Once per session. A run that beats eight bosses would otherwise print the
// same complaint eight times, and it is the same missing property every time.
let warnedNoWriteOn = false;
function warnNoWriteOn(err) {
  if (warnedNoWriteOn) return;
  warnedNoWriteOn = true;
  console.warn(
    `[snapshotCard] the Polaroid artboard has no "${SNAPSHOT_BINDINGS.writeOn}" trigger — `
    + 'prints will appear without their write-on.', err?.message ?? '',
  );
}

/**
 * The card has stopped moving — stop drawing it.
 *
 * Rive runs its own rAF and does not care that a canvas is parked in a corner
 * or sitting still in a fan. A run that beat eight bosses would otherwise have
 * eight artboards redrawing themselves sixty times a second underneath the
 * fight, which is the whole cost of this feature and none of the point.
 */
export function settleSnapshotCard(canvas) {
  live.get(canvas)?.rive?.pause();
}

/**
 * Put every live card's drawing surface back to the size it was built at.
 *
 * WHY A CARD'S SURFACE MOVES WITHOUT BEING ASKED. Rive observes each canvas it
 * owns with a ResizeObserver, and on the one transition it cares about — a
 * canvas going from a zero-sized box back to a real one, which is what
 * `display: none` coming off looks like — it re-sizes the drawing surface from
 * `getBoundingClientRect()`.
 *
 * On the score screen that transition happens on every death: every print is
 * built while the menu is still hidden and un-hidden with it. The rect Rive
 * reads on that frame is a PROJECTION — the card arrives through a reveal that
 * scales it, the same trap the worn edge fell into, see sizeCard in ui.js — so
 * a print is handed a surface a fraction of the size it was built at. Then it
 * stops: Rive only re-measures on the NEXT display toggle, so it stays wrong
 * for as long as the screen is up, which is the report this fixes.
 *
 * (It used to be the card's FLIP that produced the bad rect, at the halfway
 * point of the turn where the card is seventy-five degrees over. The score card
 * has one face now; the repair outlived the turn because the display toggle
 * did.)
 *
 * NOTHING IS MEASURED HERE, deliberately. The obvious repair is to call Rive's
 * own `resizeDrawingSurfaceToCanvas()` once the card is square, and it is
 * wrong for this card: the picked print sits under a scale of its own, so its
 * rect is a projection even at rest. The size a card was BUILT at is the only honest answer, and it
 * is already known.
 *
 * Idempotent, and free when nothing has moved.
 */
export function resyncSnapshotCards() {
  for (const [canvas, entry] of live) {
    const want = entry.surface;
    if (!want || (canvas.width === want.w && canvas.height === want.h)) continue;
    canvas.width = want.w;
    canvas.height = want.h;
    // Writing either attribute CLEARS the canvas, and a settled card has no
    // rAF of its own left to redraw it — settleSnapshotCard paused it once the
    // print parked. So the frame has to be asked for by hand: resizeToCanvas
    // moves the layout bounds onto the restored surface, drawFrame paints it.
    entry.rive?.resizeToCanvas?.();
    entry.rive?.drawFrame?.();
  }
}

/** Drop one card's runtime instance. The canvas keeps its last frame. */
export function releaseSnapshotCard(canvas) {
  const entry = live.get(canvas);
  if (!entry) return;
  entry.rive?.cleanup();
  live.delete(canvas);
}

/** A new run: every card from the last one goes. */
export function releaseAllSnapshotCards() {
  for (const canvas of [...live.keys()]) releaseSnapshotCard(canvas);
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

// Wait for `frames` animation frames AND at least `ms` of wall clock, whichever
// finishes last. Used before reading a card back — see renderSnapshotCardPng.
function settle(frames, ms) {
  const byFrames = (async () => {
    for (let i = 0; i < Math.max(1, frames); i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
  })();
  const byClock = new Promise((r) => setTimeout(r, Math.max(0, ms)));
  return Promise.all([byFrames, byClock]);
}

// WAIT UNTIL THE CARD STOPS MOVING.
//
// The artboard WRITES ITSELF ON — the name, the chin, the level all draw in
// over about a second — and a read taken while that is happening produces a
// polaroid with half a boss name on it. A fixed delay cannot solve this: it is
// authored in Rive, it changes whenever the animation is retimed, and a number
// in this file would have to be kept in sync with a file this codebase does not
// author. The first version of this waited 700ms and shipped half-written PNGs.
//
// So the card is watched instead of timed. Frames are sampled down to a
// thumbnail and compared until several in a row are identical, which is true
// exactly when the state machine has settled — whatever it was authored to do,
// however long it takes. The cap is there so a looping artboard (a shimmer, a
// cursor blink, anything that never settles) degrades to "long enough" rather
// than hanging the share button forever.
//
// The comparison is on a THUMBNAIL, not the full 1600x2000: a per-frame read of
// three megapixels is slower than the frame it is measuring, and the write-on
// moves whole words rather than single pixels.
const STILL_W = 48;

function signature(canvas, scratch) {
  const g = scratch.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, scratch.width, scratch.height);
  g.drawImage(canvas, 0, 0, scratch.width, scratch.height);
  return g.getImageData(0, 0, scratch.width, scratch.height).data;
}

// WAITING FOR "IDENTICAL" DOES NOT WORK ON THIS ARTBOARD, and finding that out
// is what this comment is for. The card never stops changing: something on it
// loops — the same per-letter shimmer the boss bar's name carries — so a
// frame-to-frame comparison never matches twice in a row, and a naive
// still-detector burns its entire timeout on every single share and STILL
// hands back a frame from the middle of a loop.
//
// What actually has to finish is the WRITE-ON, and that has a different
// signature: it ADDS ink to the paper, monotonically, until the last stroke
// lands. A shimmer oscillates around a level; a write-on climbs to one. So
// what is watched is the amount of dark ink on the card, and the card is
// considered written when that stops growing — which is true the moment the
// last letter is down, and stays true forever after, loop or no loop.
function inkFraction(canvas, scratch) {
  const g = scratch.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, scratch.width, scratch.height);
  g.drawImage(canvas, 0, 0, scratch.width, scratch.height);
  const d = g.getImageData(0, 0, scratch.width, scratch.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    // Luminance, not alpha: the paper is opaque white and the type is dark, so
    // "how much of this card is ink" is a brightness question. Alpha would
    // count the paper itself and never move.
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (d[i + 3] > 100 && lum < 110) ink++;
  }
  return ink / (d.length / 4);
}

/**
 * Resolve once the card has finished writing itself on.
 *
 * @returns { ms, written } — how long it took, and whether the ink actually
 *          plateaued or the cap was hit. Reported rather than swallowed: a
 *          card that never plateaus means the artboard grew an animation that
 *          keeps adding ink, and that is worth knowing about rather than
 *          silently paying for on every share.
 */
async function awaitWritten(canvas, { minMs, maxMs, frames }) {
  const scratch = document.createElement('canvas');
  scratch.width = STILL_W;
  scratch.height = Math.max(1, Math.round(STILL_W * CARD_ASPECT));
  const t0 = performance.now();
  let peak = -1;
  let held = 0;
  while (performance.now() - t0 < maxMs) {
    await new Promise((r) => requestAnimationFrame(r));
    let ink;
    try {
      ink = inkFraction(canvas, scratch);
    } catch {
      // A canvas that cannot be read is not going to become readable. Serve
      // out the minimum on the clock rather than spinning to the cap.
      await new Promise((r) => setTimeout(r, Math.max(0, minMs - (performance.now() - t0))));
      return { ms: performance.now() - t0, written: false };
    }
    // Still climbing? Then the last stroke has not landed. The tolerance is
    // what lets a shimmer wobble under the peak without resetting the count.
    if (ink > peak * 1.005 || peak < 0) {
      peak = Math.max(peak, ink);
      held = 0;
    } else {
      peak = Math.max(peak, ink);
      held++;
    }
    if (held >= frames && performance.now() - t0 >= minMs) {
      return { ms: performance.now() - t0, written: true };
    }
  }
  return { ms: performance.now() - t0, written: false };
}

/** For a harness: how many cards are holding a runtime instance. */
export function snapshotCardCount() {
  return live.size;
}

/**
 * The same card, out of sight, at whatever size a shared file wants.
 *
 * Read straight back off the canvas, which works because Rive draws through a
 * 2D context we can drawImage from — unlike the WebGL surface the game itself
 * renders to, which needs the grab to happen inside the drawing frame.
 *
 * The instance and the element it drew into are both torn down before this
 * resolves. Nothing here is on the hot path: it runs from a button, or from
 * the score screen's warm-up.
 *
 * @returns a data URL, or null if the card could not be drawn.
 */
export async function renderSnapshotCards(items = [], { width = 1600, pixelRatio = 1 } = {}) {
  if (!snapshotCardsLive() || !items.length) return items.map(() => null);

  // IT HAS TO BE IN THE DOCUMENT TO DRAW. Rive stops rendering a canvas it
  // cannot see, and a detached one is never visible — so an off-DOM render
  // produces exactly one frame, the artboard's authored default, and then
  // nothing. That failure is silent and extremely convincing: a perfectly
  // formed 1600x2000 polaroid, correct in every respect except that it says
  // LVL 5 and carries the placeholder photograph baked into the .riv.
  //
  // So they go in the page, clipped to a pixel in the corner: the canvases keep
  // their full size and their full backing stores, and the wrapper is what is
  // one pixel — enough to intersect the viewport, too little to see.
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText = 'position:fixed; left:0; top:0; width:1px; height:1px;'
    + ' overflow:hidden; opacity:0.01; pointer-events:none; z-index:-1;';
  document.body.appendChild(stage);

  const built = items.map((it) => {
    const card = buildSnapshotCard({ photo: it?.photo, meta: it?.meta, width, pixelRatio });
    if (card) {
      card.canvas.style.width = `${card.canvas.width}px`;
      card.canvas.style.height = `${card.canvas.height}px`;
      stage.appendChild(card.canvas);
    }
    return card;
  });

  try {
    const rives = await Promise.all(built.map((b) => (b ? b.ready : Promise.resolve(null))));

    // LET THEM ACTUALLY DRAW. The writes land on the view models the moment
    // they are made, but they do not reach a canvas until Rive's own loop has
    // advanced the artboard and rendered it.
    //
    // Frames AND wall time, because neither alone is enough: a backgrounded tab
    // stops issuing frames, and a fast machine can fire six of them before the
    // runtime has drawn once.
    await settle(num(cfg().cardFrames, 12), num(cfg().cardSettleMs, 700));

    // ALL OF THEM AT ONCE, and this is the whole reason the batch exists.
    // Waiting for the write-on is wall-clock time — a second or two per card —
    // and eight cards done one after another is twenty seconds with a share
    // button apparently hung. Run concurrently they overlap almost entirely:
    // the same frames advance every artboard, so a full run costs about what
    // one card costs.
    const rest = await Promise.all(built.map((b) => (b
      ? awaitWritten(b.canvas, {
        minMs: num(cfg().cardWriteMinMs, 0),
        maxMs: num(cfg().cardWriteMaxMs, 2500),
        frames: num(cfg().cardWriteFrames, 8),
      })
      : Promise.resolve(null))));
    const late = rest.filter((r) => r && !r.written).length;
    if (late) {
      console.warn(`[snapshotCard] ${late} card(s) were still writing when read — see cardWriteMaxMs.`);
    }

    // Copied off the live canvases before anything is torn down: the originals
    // belong to Rive instances that are about to be destroyed.
    return built.map((b, i) => {
      if (!b || !rives[i]) return null;
      try {
        const out = document.createElement('canvas');
        out.width = b.canvas.width;
        out.height = b.canvas.height;
        const g = out.getContext('2d');
        if (!g) return null;
        g.drawImage(b.canvas, 0, 0);
        return out;
      } catch (err) {
        console.warn(`[snapshotCard] could not read a card back — ${err}`);
        return null;
      }
    });
  } finally {
    for (const b of built) if (b) releaseSnapshotCard(b.canvas);
    // The stage goes with them. Left behind, every shared card would strand a
    // full-size canvas in the document — eight of those is a great deal of
    // backing store held for the life of the tab, for pictures already copied.
    stage.remove();
  }
}

/**
 * One card, as a data URL. A wrapper over the batch above rather than a second
 * implementation: the settle rules, the hidden stage and the teardown are all
 * things that have already been got wrong once, and two copies of them would
 * drift the first time either is fixed.
 *
 * @returns a data URL, or null if the card could not be drawn.
 */
export async function renderSnapshotCardPng({ photo, meta, width = 1600 } = {}) {
  const [canvas] = await renderSnapshotCards([{ photo, meta }], { width, pixelRatio: 1 });
  return canvas ? canvas.toDataURL('image/png') : null;
}
