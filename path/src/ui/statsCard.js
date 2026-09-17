// ============================================================================
// THE BLUBBERBALL STATS PAGE — the ledger after the whistle, drawn by Rive.
//
// A SECOND .riv, and deliberately. `seal_survivor.riv` is authored in the Rive
// editor and exported over; `blubberball.riv` is authored as TEXT in
// rive/blubberball (three .rml files, compiled by the Rive CLI), so its
// artboards diff and review with the rest of the code. Nothing forces one file
// — every mount in this folder imports its own url — and folding these
// artboards into the editor's file would throw that away.
//
// EVERY WORD AND EVERY NUMBER IS A VIEW MODEL PROPERTY. The artboard ships with
// lorem in it, and what a player reads is written here, from the match. That is
// not a nicety: it is what keeps uiText.csv the owner of the copy and the
// match the owner of the numbers, with the .riv owning only the look. A page
// that had the words baked in would be a second place to write them.
//
// THE STATE MACHINE IS NAMED AT CONSTRUCTION, for the reason riveContract.js
// spells out at length for the splash: `autoBind` binds the view model to the
// machines that exist when the file loads, and a machine started later with
// `play(name)` is a fresh instance the binding never reaches. Its listeners
// still fire and write into nothing. So the name goes in the constructor.
//
// THE POSSESSION BAR MOVES, and it is the one thing on this page the artboard
// does not draw by itself. `leftPossession`/`rightPossession` are bound to the
// fill's width and to the two percentages beside it, so writing them on a
// frame clock replays the match's share of the ball across the bar — see
// ui/possessionReplay.js for the clock and systems/versusTally.js for the
// marks it reads. Every other value on this page is written once.
//
// WITHOUT THE MACHINE RUNNING AT ALL nothing binds either — an artboard that
// never advances never pushes a bind, so every value sits at the lorem it was
// authored with. That failure looks exactly like a file that loaded fine.
// ============================================================================

// THE WEBGL2 PACKAGE, not the canvas one. This page is built out of feathers —
// every button glow, every drop shadow, the record pill's halo — and only the
// Rive Renderer draws a feather SOFT; the Canvas2D renderer in
// `@rive-app/canvas` draws it as a hard-edged offset copy, measured side by
// side at the same runtime version. Same JavaScript API, its own WASM, and the
// splash (ui/riveSplash.js) has ridden it for as long as it has had shadows.
//
// THE COST IS A SECOND GL CONTEXT, which is why the boss bar and the polaroid
// have not moved: the bar would hold one alive through every fight, and the
// polaroid's pixels are read back with drawImage for the share image. This
// page has neither problem. It is built once, at the whistle, over water that
// is frozen at four percent, nothing reads it back, and destroy() drops the
// context with it — so the context exists for as long as a score screen is up
// and not one frame longer.
import { Rive, Layout, Fit, Alignment } from '@rive-app/webgl2';
// Sets the WASM url — for the WEBGL2 package, which has its own loader.
// `setWasmUrl` is global to its own package and does nothing for the other
// one, which is why there are two of these modules. Imported for the side
// effect, and it has to happen before any Rive instance exists — see
// riveRuntimeGl.js.
import './riveRuntimeGl.js';
import rivUrl from './blubberball.riv?url';
import { statsLabels } from './statsCopy.js';
// Which artboard row each seal goes in. Its own file so a test can check the
// arithmetic without the Rive runtime — see ui/statsSeats.js.
import { STATS_SEATS, seatIndexForRow } from './statsSeats.js';
// The replay's clock — its own file for the same reason statsSeats.js is, and
// the only part of this page a test can reach. See its header.
import { makePossessionReplay } from './possessionReplay.js';
import { CONFIG } from '../config.js';

/** What the game needs blubberball.riv to contain. */
export const STATS_ARTBOARD = 'Stats Page';
export const STATS_MACHINE = 'State Machine 1';
// Re-exported: every caller of this module used to get STATS_SEATS from here,
// and where the number lives is not their business.
export { STATS_SEATS };

/** The artboard's own proportions (900 x 760 in rive/blubberball). */
export const STATS_ASPECT = 900 / 760;

/**
 * Rive colours are ARGB integers; the match deals in 0xRRGGBB. A colour that
 * arrived as null (no pick on the wheel) is left alone rather than written as
 * transparent black, so the artboard keeps its authored swatch.
 */
function argb(rgb) {
  if (!Number.isFinite(rgb)) return null;
  return (0xff000000 | (rgb & 0xffffff)) >>> 0;
}

/**
 * Write one property, and say so once if it is not there.
 *
 * A missing property is the failure this whole file is most likely to hit —
 * rename a property in data.rml and nothing throws, nothing logs, and the page
 * draws lorem where a name should be. So every write goes through here.
 */
function write(vmi, kind, name, value, missing) {
  if (value === null || value === undefined) return;
  let prop = null;
  try { prop = vmi?.[kind]?.(name) ?? null; } catch { prop = null; }
  if (!prop) { missing.push(`${kind} ${name}`); return; }
  try { prop.value = value; } catch { missing.push(`${kind} ${name} (write failed)`); }
}

/**
 * Fill the page from a match.
 *
 * @param vmi   the artboard's bound view model instance.
 * @param data  see showStatsCard.
 * @returns the property names that were not there, for one warning.
 */
function paint(vmi, data, replay = null) {
  const missing = [];
  const w = (kind, name, value) => write(vmi, kind, name, value, missing);

  w('string', 'leftName', data.teams?.[0]?.name);
  w('string', 'rightName', data.teams?.[1]?.name);
  w('number', 'leftScore', data.scores?.[0]);
  w('number', 'rightScore', data.scores?.[1]);
  w('color', 'leftColor', argb(data.colors?.[0]));
  w('color', 'rightColor', argb(data.colors?.[1]));
  w('color', 'accent', argb(data.accent));

  const t0 = data.teams?.[0] ?? {};
  const t1 = data.teams?.[1] ?? {};
  w('number', 'leftGoals', t0.goals);
  w('number', 'leftAssists', t0.assists);
  w('number', 'leftSaves', t0.saves);
  // THE BAR'S FIRST FRAME, which is the replay's if there is one — not the
  // closing number. Writing the whistle's figure here and then starting a
  // replay a frame later is a bar that snaps out of the answer and back into
  // it, and the snap is on the frame the page fades in on.
  const share = replay ? replay.at(0) : { left: t0.possession, right: t1.possession };
  w('number', 'leftPossession', share.left);
  w('number', 'rightGoals', t1.goals);
  w('number', 'rightAssists', t1.assists);
  w('number', 'rightSaves', t1.saves);
  w('number', 'rightPossession', share.right);

  // THE RECORD PILL, which has the badge band to itself. It used to share that
  // height with a champion line — "Champion!" over the winning side's name —
  // and neither was laid out around the other, so this had to choose between
  // them. The line said what the two names and the two big numbers under it
  // already said, and it is gone; the badge is no longer conditional on
  // anything but the record.
  w('boolean', 'isRecord', !!data.isRecord);
  // How many ROWS of each column to draw — per side, not per seat. The two
  // columns are the two sides, so a flat count of every seal in the match
  // would draw twice as many rows down each column as there are seals in it.
  w('number', 'seatsPerSide', data.seatsPerSide);

  // THE LABELS ARE NOT THE CALLER'S TO PASS. Every one is a uiText.csv row and
  // is written on every paint, so there is no path through this file that shows
  // the artboard's placeholder to a player — a caller cannot forget, because a
  // caller is not asked. `data.labels` exists for a harness that wants to prove
  // a particular string reached a particular slot, and overrides by merging
  // after, never instead.
  for (const [name, value] of Object.entries({ ...statsLabels(), ...(data.labels ?? {}) })) {
    w('string', name, value);
  }

  // THE SEATS. Eight nested view models, `player1`..`player8`, laid out as the
  // artboard's TWO COLUMNS — `player1`..`player4` down the left, `player5`..
  // `player8` down the right.
  //
  // THE CALLER'S LIST IS DENSE AND `seatsPerSide` IS WHERE IT BREAKS. A match
  // is two equal sides, so the list is the left side's seals followed by the
  // right side's, and the break is after `seatsPerSide` of them — not after
  // four. Reading it as "0..3 left, 4..7 right" was right only for a
  // four-a-side and wrong for every smaller match: a 1v1 handed its two seals
  // to `player1` and `player2`, which is one column, and `player5` — the row
  // the right-hand column actually shows — was handed nothing and kept the
  // lorem it was authored with. The name of the seal you just played against
  // read as "Lorem ipsum".
  //
  // A row past the end of a column is left at that lorem on purpose and is
  // simply not looked at: `seatsPerSide` above tells the artboard how many
  // rows of each column to draw.
  const seats = data.seats ?? [];
  for (let i = 0; i < STATS_SEATS; i++) {
    const at = seatIndexForRow(i, data.seatsPerSide);
    // -1 is a row past the end of its column: not drawn, so nothing is written.
    const s = at < 0 ? null : seats[at];
    if (!s) continue;
    let row = null;
    try { row = vmi?.viewModel?.(`player${i + 1}`) ?? null; } catch { row = null; }
    if (!row) { missing.push(`viewModel player${i + 1}`); continue; }
    write(row, 'string', 'name', s.name, missing);
    write(row, 'number', 'goals', s.goals, missing);
    write(row, 'number', 'assists', s.assists, missing);
    write(row, 'number', 'saves', s.saves, missing);
  }

  return missing;
}

/**
 * The match's share of the ball, as something that can be asked for a moment.
 *
 * TUNED IN CONFIG, OVERRIDABLE BY A HARNESS. The speed is a look — how fast
 * the bar is worth watching — and lives with the rest of the mode's numbers; a
 * caller may override it (`data.possession.speed`) so a look page does not
 * have to sit through a match at whatever the game is tuned to.
 *
 * `null` when there is nothing to replay: no marks, or the mode's switch off.
 * Every caller treats that as "the bar is the closing number", which is what
 * this page did before the replay existed.
 */
function buildReplay(data) {
  const src = data?.possession;
  if (!src?.points?.length) return null;
  const cfg = CONFIG?.versus?.stats?.possession ?? {};
  if (cfg.enabled === false) return null;
  return makePossessionReplay({
    points: src.points,
    seconds: src.seconds,
    // WHERE IT COMES TO REST is the ledger's own pair, not the last mark —
    // the figure printed beside the bar has to be the one the match reported.
    final: { left: data.teams?.[0]?.possession, right: data.teams?.[1]?.possession },
    speed: src.speed ?? cfg.speed ?? 5,
    delay: src.delay ?? cfg.delay ?? 0.35,
  });
}

/**
 * Put the page up.
 *
 * @param parent  the element it goes in.
 * @param data    { title, scores:[n,n], colors:[rgb,rgb], accent,
 *                  teams:[{name,goals,assists,saves,possession}, …],
 *                  possession: tallyTimeline()'s { seconds, points } — the
 *                  share over the match, replayed across the bar. Without it
 *                  the bar is the closing number and does not move,
 *                  seats:[{name,goals,assists,saves}, …] — DENSE, in column
 *                  order: the left side's `seatsPerSide` seals, then the
 *                  right's,
 *                  seatsPerSide, isRecord,
 *                  labels:{…} for a harness only }
 * @returns a handle whose every method is safe to call whether or not the
 *          artboard ever loaded. `live` stays false if it did not.
 */
export function mountStatsCard({ parent, data = {} } = {}) {
  if (!parent) return null;

  // THE PAGE IS FITTED TO THE SCREEN, BOTH WAYS.
  //
  // The artboard is 900 x 760 — taller than it is wide — and the canvas used
  // to be sized `width: min(92vw, 900px)` with `height: auto`. A width-only
  // rule is a rule with no opinion about height, and on a phone on its side
  // there is barely any: 92vw of an iPhone 15 landscape is 784px, which makes
  // the page 662px TALL in a viewport 393px high. `place-items: center` then
  // centres the overflow, so a third of the page hangs off the top and a third
  // off the bottom — and the bottom third is Rematch and Main Menu. The one
  // screen in the mode with nothing else on it became the one screen you could
  // not leave without the pointer finding a button it could not see.
  //
  // FOUR MARGINS, NAMED ONCE. They are what the box is padded by and what the
  // width below subtracts, and they have to be the same four numbers or the
  // page is centred in one box and sized against another. A vmin margin so the
  // gap looks the same whichever way the phone is held, plus the device's own
  // inset: the page draws edge to edge (viewport-fit=cover in index.html), so
  // on a phone held sideways about 59px of the window is behind the Dynamic
  // Island and a page centred in the window is not centred in what can be
  // seen.
  const el = document.createElement('div');
  el.className = 'sv-stats-card';
  const pad = {
    t: 'calc(4vmin + env(safe-area-inset-top, 0px))',
    r: 'calc(4vmin + env(safe-area-inset-right, 0px))',
    b: 'calc(4vmin + env(safe-area-inset-bottom, 0px))',
    l: 'calc(4vmin + env(safe-area-inset-left, 0px))',
  };
  // THE HEIGHT IS svh, NOT THE PARENT'S. `.sv-versus` is fixed at inset:0,
  // which in a mobile browser is the LARGE viewport — the one you get once the
  // address bar and the tab bar have scrolled away — so a page fitted to it is
  // a page fitted to screen the browser is standing on. In Safari on a phone
  // held upright that is about 80px at the bottom, which is where the buttons
  // are, and env(safe-area-inset-bottom) does not describe it: a browser bar
  // is not a hardware inset and reports 0. `svh` is the SMALL viewport, the
  // one with the bars showing, so the page is laid out against the least
  // screen there will ever be and a button cannot end up behind one. Installed
  // and fullscreen the two are the same number, so it costs those nothing. The
  // plain `vh` declaration before each `svh` one is the fallback for a browser
  // that does not know the unit — which is what shipped before this.
  el.style.cssText = 'position:absolute; top:0; left:0; right:0;'
    + ' height:100vh; height:100svh;'
    + ' display:grid; place-items:center; box-sizing:border-box;'
    + ' pointer-events:auto; opacity:0; transition:opacity 220ms ease;'
    + ` padding:${pad.t} ${pad.r} ${pad.b} ${pad.l};`;
  const canvas = document.createElement('canvas');
  // A fixed backing store, sized before the runtime is built — that is when it
  // reads the size it lays the artboard out in, and a surface sized while the
  // wrapper was still unlaid-out draws nothing forever without erroring. See
  // the same note in nameTag.js.
  canvas.width = 1100;
  canvas.height = Math.round(1100 / STATS_ASPECT);
  // THE FIT IS WRITTEN OUT, not left to the replaced-element maxima.
  //
  // `max-width: min(900px, 100%)` with `max-height: 100%` is the textbook way
  // to contain a canvas and it does not work here: measured in Chromium at
  // 874x402, the width constraint applied and the height one did not, leaving
  // the page 611px tall in a 402px box — the same overflow, arrived at by a
  // rule that looks like it says otherwise. So the smaller of the three
  // answers is taken in the width itself, where there is nothing to interpret:
  // the authored size, the room across, and the room down expressed as the
  // width that fits in it. `height: auto` then follows the backing store's own
  // proportions, which are the artboard's.
  //
  // The vh pair is the svh fallback — see the note on the box's height.
  const room = (vh) => `min(900px, calc(100vw - ${pad.l} - ${pad.r}),`
    + ` calc((100${vh} - ${pad.t} - ${pad.b}) * ${STATS_ASPECT.toFixed(6)}))`;
  canvas.style.cssText = `display:block; height:auto; width:${room('vh')}; width:${room('svh')};`;
  el.appendChild(canvas);
  parent.appendChild(el);

  const state = { rive: null, live: false, destroyed: false, replay: null, raf: 0, t0: 0 };

  // ------------------------------------------------------------ the bar's clock
  //
  // ITS OWN FRAME LOOP, not the match's. The match is frozen at four percent
  // while this page is up and its dt is scaled to match (see updateOver in
  // systems/versus.js) — a bar driven off that would replay a three-minute
  // match in two hours. This is footage of a match that is over, on the wall
  // clock, exactly like the highlight reel playing behind it.
  //
  // IT STOPS WHEN THE REPLAY DOES. A loop that keeps writing the same two
  // numbers every frame forever is a page that never idles, and the artboard
  // is already redrawing itself for the hover glows.
  function stopReplay() {
    if (state.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  function stepReplay() {
    state.raf = 0;
    if (state.destroyed || !state.live || !state.replay) return;
    const vm = state.rive?.viewModelInstance;
    if (!vm) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const share = state.replay.at(now - state.t0);
    const missing = [];
    write(vm, 'number', 'leftPossession', share.left, missing);
    write(vm, 'number', 'rightPossession', share.right, missing);
    // Warned once and then dropped: a missing property on a per-frame write is
    // sixty warnings a second, and the paint above has already said so.
    if (missing.length) { state.replay = null; return; }
    if (!share.done) schedule();
  }

  function schedule() {
    if (typeof requestAnimationFrame !== 'function') return;
    state.raf = requestAnimationFrame(stepReplay);
  }

  /** Start it from now, wherever it had got to. */
  function runReplay() {
    stopReplay();
    if (!state.replay) return;
    state.t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    schedule();
  }

  function warn(why) {
    console.warn(`[statsCard] the stats page is off — ${why}`);
  }

  try {
    state.rive = new Rive({
      src: rivUrl,
      canvas,
      artboard: STATS_ARTBOARD,
      // Named here, not in a later play() — see the note at the top.
      stateMachines: STATS_MACHINE,
      autoBind: true,
      autoplay: true,
      layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
      onLoadError: (err) => {
        warn(`the ${STATS_ARTBOARD} artboard did not load (${err})`);
        el.remove();
      },
      onLoad: () => {
        if (state.destroyed) { try { state.rive?.cleanup(); } catch { /* gone */ } state.rive = null; return; }
        const vmi = state.rive?.viewModelInstance;
        if (!vmi) {
          warn('the artboard loaded with no view model bound — every value would draw its placeholder');
          el.remove();
          return;
        }
        state.replay = buildReplay(data);
        const missing = paint(vmi, data, state.replay);
        if (missing.length) warn(`these properties are not in the file: ${missing.join(', ')}`);
        state.live = true;
        el.style.opacity = '1';
        runReplay();
      },
    });
  } catch (err) {
    warn(`the runtime could not be built (${err?.message ?? err})`);
    el.remove();
  }

  /** One place the prompt's three values are read or written. */
  function vmi() { return state.live ? (state.rive?.viewModelInstance ?? null) : null; }

  return {
    get live() { return state.live; },

    /**
     * The play-again prompt: whether it is up, and which button is lit.
     *
     * `cursor` is the SAME number a pad and a keyboard move, and the artboard's
     * own hover listeners write it too — so a pointer moving onto a button and
     * a D-pad pushing at it cannot end up disagreeing about which one is
     * selected. There is one cursor and three things that move it.
     */
    setOver(shown, cursor) {
      const v = vmi();
      if (!v) return;
      const missing = [];
      write(v, 'boolean', 'overShown', !!shown, missing);
      write(v, 'number', 'overCursor', cursor, missing);
      if (missing.length) warn(`the prompt is not in this artboard: ${missing.join(', ')}`);
    },

    /**
     * What the player clicked, and CLEARED as it is read — 0 none, 1 rematch,
     * 2 main menu.
     *
     * A number the caller drains rather than a trigger it subscribes to, for
     * two reasons: the match already polls this prompt every frame for the
     * gamepads, so there is a natural place to ask; and a number can be read
     * back by the Rive CLI's `--data-dump`, which is the only way a click on
     * this artboard is testable without a browser.
     */
    /**
     * Which button the ARTBOARD has lit, or null when it cannot be read.
     *
     * The read half of `setOver`'s cursor: the page's own hover listeners move
     * it when a pointer crosses a button, and the match reads it back so the
     * pad's next press starts from what the player can actually see lit.
     */
    readCursor() {
      const v = vmi();
      if (!v) return null;
      let prop = null;
      try { prop = v.number('overCursor') ?? null; } catch { prop = null; }
      if (!prop) return null;
      const n = Number(prop.value);
      return n === 0 || n === 1 ? n : null;
    },

    takePick() {
      const v = vmi();
      if (!v) return 0;
      let prop = null;
      try { prop = v.number('overPick') ?? null; } catch { prop = null; }
      if (!prop) return 0;
      const picked = Number(prop.value) || 0;
      // Cleared here rather than by the caller: a pick left set is a pick the
      // next frame reads again, which is a rematch that restarts forever.
      if (picked) prop.value = 0;
      return picked;
    },
    /** Re-fill it without rebuilding — a rematch, or a live scoreboard. */
    update(next) {
      if (!state.live) return;
      const vmi = state.rive?.viewModelInstance;
      if (!vmi) return;
      // A fresh ledger is a fresh replay — and from the top, because the bar
      // is describing a different match than the one it was part way through.
      state.replay = buildReplay(next ?? {});
      paint(vmi, next ?? {}, state.replay);
      runReplay();
    },
    destroy() {
      state.destroyed = true;
      state.live = false;
      stopReplay();
      state.replay = null;
      try { state.rive?.cleanup(); } catch { /* already gone */ }
      state.rive = null;
      el.remove();
    },
  };
}
