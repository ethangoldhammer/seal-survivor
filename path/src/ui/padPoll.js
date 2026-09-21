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
// Standard Gamepad mapping: 0 A/Cross, 1 B/Circle, 4/5 the shoulders, 9 Start,
// 12-15 the d-pad, axes 2/3 the right stick. The same numbers input.js uses
// (CONFIRM_BUTTONS, BACK_BUTTON, PAUSE_BUTTON).
//
// THE RIGHT STICK IS NOT A DIRECTION, it is a HEADING, and that is why it comes
// out of here as a raw vector rather than as four more presses. The team
// select's colour wheel is a ring of swatches and pushing the stick at one of
// them should take that one — "picked with the right stick" means pointed at,
// not stepped towards. Folding it into left/right/up/down here would throw the
// angle away before the one screen that wants it ever sees it, and no other
// caller is worse off: a screen that wants the right stick as a d-pad can
// threshold the vector in two lines.
// ---------------------------------------------------------------------------

const STICK = 0.55;   // how far the left stick goes before it is a press
const RELEASE = 0.35; // ...and how far back before it can press again
// ...and how far the RIGHT stick goes before it is pointing at anything. Looser
// than STICK because it is not fighting a repeat: a heading is read every frame
// and nothing happens until it names a different swatch, so there is no machine
// gun to guard against — only a resting thumb, and a resting thumb on a worn
// stick can sit past 0.2.
const AIM = 0.5;

/** A pad's state as this poll remembers it between frames. */
function fresh() {
  return { a: false, b: false, start: false, lb: false, rb: false, x: 0, y: 0, seen: 0 };
}

/**
 * Read every connected pad. `prev` is a Map keyed by pad index that the
 * caller keeps between calls (and clears when its screen closes).
 *
 * @returns [{ index, id, press: { a, b, start, lb, rb, left, right, up, down },
 *            aim: { x, y, on }, held: { a } }]
 *          in index order. `aim` is the right stick as a vector, `on` false
 *          inside the deadzone. A pad that has gone is dropped from `prev`.
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
    const lb = !!pad.buttons?.[4]?.pressed;
    const rb = !!pad.buttons?.[5]?.pressed;
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
      lb: lb && !p.lb,
      rb: rb && !p.rb,
      left: x < 0 && p.x >= 0,
      right: x > 0 && p.x <= 0,
      up: y < 0 && p.y >= 0,
      down: y > 0 && p.y <= 0,
    };
    // The right stick, as it is. No edge and no memory: see the header.
    const rx = pad.axes?.[2] ?? 0;
    const ry = pad.axes?.[3] ?? 0;
    const aim = { x: rx, y: ry, on: Math.hypot(rx, ry) >= AIM };
    p.a = a; p.b = b; p.start = start; p.lb = lb; p.rb = rb; p.x = x; p.y = y; p.seen++;
    out.push({ index: pad.index, id: pad.id ?? 'gamepad', press, aim, held: { a } });
  }
  for (const k of [...prev.keys()]) if (!alive.has(k)) prev.delete(k);
  out.sort((m, n) => m.index - n.index);
  return out;
}
