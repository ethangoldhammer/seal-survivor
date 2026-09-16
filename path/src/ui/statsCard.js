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
// WITHOUT THE MACHINE RUNNING AT ALL nothing binds either — an artboard that
// never advances never pushes a bind, so every value sits at the lorem it was
// authored with. That failure looks exactly like a file that loaded fine.
// ============================================================================

import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
// Sets the WASM url. Imported for the side effect — see riveRuntime.js.
import './riveRuntime.js';
import rivUrl from './blubberball.riv?url';
import { statsLabels, championLabel } from './statsCopy.js';
// Which artboard row each seal goes in. Its own file so a test can check the
// arithmetic without the Rive runtime — see ui/statsSeats.js.
import { STATS_SEATS, seatIndexForRow } from './statsSeats.js';

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
function paint(vmi, data) {
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
  w('number', 'leftPossession', t0.possession);
  w('number', 'rightGoals', t1.goals);
  w('number', 'rightAssists', t1.assists);
  w('number', 'rightSaves', t1.saves);
  w('number', 'rightPossession', t1.possession);

  // THE CHAMPION — the result line, which used to be a DOM text box floating
  // over this artboard.
  //
  // ONE BAND, TWO BADGES. The champion line and the record pill are both laid
  // out under the title at the same height and neither makes room for the
  // other, so the artboard cannot be shown both — and nothing in the artboard
  // can stop it. Here is where it is stopped. The champion wins: it is the
  // result of the match on screen, and a record is a note about it.
  //
  // A DRAW HAS A LINE BUT NO NAME. Nobody won, so `championName` is blank and
  // the label carries the whole of it — which is exactly what the DOM box did.
  const draw = !!data.draw;
  const champion = draw || !!data.championName;
  w('boolean', 'hasChampion', champion);
  if (champion) {
    w('string', 'championLabel', championLabel(draw));
    w('string', 'championName', draw ? '' : data.championName);
  }
  w('boolean', 'isRecord', !!data.isRecord && !champion);
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
 * Put the page up.
 *
 * @param parent  the element it goes in.
 * @param data    { title, scores:[n,n], colors:[rgb,rgb], accent,
 *                  teams:[{name,goals,assists,saves,possession}, …],
 *                  seats:[{name,goals,assists,saves}, …] — DENSE, in column
 *                  order: the left side's `seatsPerSide` seals, then the
 *                  right's,
 *                  seatsPerSide, isRecord, championName, draw,
 *                  labels:{…} for a harness only }
 * @returns a handle whose every method is safe to call whether or not the
 *          artboard ever loaded. `live` stays false if it did not.
 */
export function mountStatsCard({ parent, data = {} } = {}) {
  if (!parent) return null;

  const el = document.createElement('div');
  el.className = 'sv-stats-card';
  el.style.cssText = 'position:absolute; inset:0; display:grid; place-items:center; pointer-events:auto; opacity:0; transition:opacity 220ms ease;';
  const canvas = document.createElement('canvas');
  // A fixed backing store, sized before the runtime is built — that is when it
  // reads the size it lays the artboard out in, and a surface sized while the
  // wrapper was still unlaid-out draws nothing forever without erroring. See
  // the same note in nameTag.js.
  canvas.width = 1100;
  canvas.height = Math.round(1100 / STATS_ASPECT);
  canvas.style.cssText = 'display:block; width:min(92vw, 900px); height:auto;';
  el.appendChild(canvas);
  parent.appendChild(el);

  const state = { rive: null, live: false, destroyed: false };

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
        const missing = paint(vmi, data);
        if (missing.length) warn(`these properties are not in the file: ${missing.join(', ')}`);
        state.live = true;
        el.style.opacity = '1';
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
      if (vmi) paint(vmi, next ?? {});
    },
    destroy() {
      state.destroyed = true;
      state.live = false;
      try { state.rive?.cleanup(); } catch { /* already gone */ }
      state.rive = null;
      el.remove();
    },
  };
}
