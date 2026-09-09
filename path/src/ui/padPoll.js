// ---------------------------------------------------------------------------
// EVERY PAD, EDGE-TRIGGERED. input.js reads ONE pad — the one driving the
// seal — and menuInput is that pad's cursor. Two screens need all of them at
// once: the Blubberball team select, where each controller is a person
// choosing a side, and the prompt after a match, which either player may
// answer. This is the poll they share: one snapshot of navigator.getGamepads
// turned into presses (this frame and not the last) per pad, with the d-pad
// and the left stick folded into one direction.
//
// A poll, not listeners, because the Gamepad API has none for buttons. The
// previous state lives in the Map the caller owns, so two screens polling in
// the same frame do not eat each other's edges — and so a screen that closes
// and re-opens starts from "nothing held", which is what a held A on the way
// in must read as.
//
// Standard Gamepad mapping: 0 A/Cross, 1 B/Circle, 9 Start, 12-15 the d-pad.
// The same numbers input.js uses (CONFIRM_BUTTONS, BACK_BUTTON, PAUSE_BUTTON).
// ---------------------------------------------------------------------------

const STICK = 0.55;   // how far the left stick goes before it is a press
const RELEASE = 0.35; // ...and how far back before it can press again

/** A pad's state as this poll remembers it between frames. */
function fresh() {
  return { a: false, b: false, start: false, x: 0, y: 0, seen: 0 };
}

/**
 * Read every connected pad. `prev` is a Map keyed by pad index that the
 * caller keeps between calls (and clears when its screen closes).
 *
 * @returns [{ index, id, press: { a, b, start, left, right, up, down }, held: { a } }]
 *          in index order. A pad that has gone is dropped from `prev`.
 */
export function pollPads(prev, list = null) {
  let pads = list;
  if (!pads) {
    try { pads = navigator.getGamepads?.() ?? []; } catch { pads = []; }
  }
  const out = [];
  const alive = new Set();
  for (const pad of pads) {
    if (!pad?.connected) continue;
    alive.add(pad.index);
    let p = prev.get(pad.index);
    if (!p) { p = fresh(); prev.set(pad.index, p); }
    const a = !!pad.buttons?.[0]?.pressed;
    const b = !!pad.buttons?.[1]?.pressed;
    const start = !!pad.buttons?.[9]?.pressed;
    // One direction from the d-pad OR the stick, with the stick given a
    // hysteresis band so a thumb resting near the threshold does not machine-
    // gun the cursor.
    const ax = pad.axes?.[0] ?? 0;
    const ay = pad.axes?.[1] ?? 0;
    let x = pad.buttons?.[15]?.pressed ? 1 : pad.buttons?.[14]?.pressed ? -1 : 0;
    let y = pad.buttons?.[13]?.pressed ? 1 : pad.buttons?.[12]?.pressed ? -1 : 0;
    const stick = (v, was) => (Math.abs(v) >= STICK ? Math.sign(v) : Math.abs(v) <= RELEASE ? 0 : was);
    if (!x) x = stick(ax, p.x);
    if (!y) y = stick(ay, p.y);
    const press = {
      a: a && !p.a,
      b: b && !p.b,
      start: start && !p.start,
      left: x < 0 && p.x >= 0,
      right: x > 0 && p.x <= 0,
      up: y < 0 && p.y >= 0,
      down: y > 0 && p.y <= 0,
    };
    p.a = a; p.b = b; p.start = start; p.x = x; p.y = y; p.seen++;
    out.push({ index: pad.index, id: pad.id ?? 'gamepad', press, held: { a } });
  }
  for (const k of [...prev.keys()]) if (!alive.has(k)) prev.delete(k);
  out.sort((m, n) => m.index - n.index);
  return out;
}
