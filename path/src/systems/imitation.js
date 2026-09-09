// ---------------------------------------------------------------------------
// IMITATION — what a seal SAW and what its player DID, one row a tick.
//
// The versus bot learns from play the cheapest way there is: while a human
// plays a match, every twentieth of a second this files one row — the state
// of the game from that seal's point of view, and the stick and strike the
// player was holding at that instant. tools/imitate-train.mjs fits a small
// network to those rows and writes it to path/src/versusPolicy.json, and
// systems/versusBot.js runs it as player 2. A bot trained this way plays
// like the player it watched, bad habits included; that is the point.
//
// ONE FRAME OF REFERENCE. Rows are always written as if the seal's OWN goal
// were on the left, so a row from player 1 (who really defends the left) and
// a row from player 2 (mirrored) are the same kind of row and train the same
// policy — and the policy, run for player 2, has its answer mirrored back.
// Everything with an x in it flips: positions, velocities, the stick, the
// aim, and the ball's spin (a mirror turns clockwise into anticlockwise).
//
// THE FEATURES are bounded by construction — a share of the pitch, a share of
// a top speed, a 0..1 meter — so the network needs no normalisation table
// that could drift from the game. FEATURE_NAMES is the schema; the trainer
// refuses rows of any other length, and `version` bumps when it changes.
//
// WHERE THE ROWS GO. Batched and posted to the dev server's /__imitation,
// which appends to playtest/imitation.jsonl (gitignored session data, like
// the runs ledger). A production build has no endpoint and keeps nothing.
// ---------------------------------------------------------------------------

export const IMITATION_VERSION = 1;

export const FEATURE_NAMES = [
  'ballDx', 'ballDy',       // ball relative to me, as a share of the pitch's width / depth
  'ballVx', 'ballVy',       // ball velocity, as a share of its top speed
  'myVx', 'myVy',           // my velocity, as a share of swim top speed
  'charge', 'pending',      // my meter: fuel, and the wind-up banked
  'myX', 'myY',             // where I am on the pitch, -1..1 (own goal at -1)
  'oppDx', 'oppDy',         // the other seal relative to me
  'ballSpin',               // the ball's spin, as a share of ten rad/s
  'dashing',                // 1 while my dash is in flight
];
export const ACTION_NAMES = ['moveX', 'moveY', 'aimX', 'aimY', 'strike'];
export const N_FEATURES = FEATURE_NAMES.length;
export const N_ACTIONS = ACTION_NAMES.length;

const ENDPOINT = '/__imitation';
const RATE_HZ = 20;
const FLUSH_AT = 600; // rows per post — half a minute of one seal

export const imitationState = {
  enabled: true,
  rows: [],          // pending rows, each [...features, ...actions]
  side: [],          // which seal each pending row came from, for the harness
  posted: 0,         // rows handed to the server this session
  total: 0,          // rows filed this session, posted or not
  clock: 0,
};

/**
 * The state as one seal sees it. `me` and `opp` are { x, y, vx, vy };
 * `meter` is { charge, pending, dashing }; `mirror` flips x for the seal
 * whose goal is really on the right. `pitch` is { left, right, bottom,
 * surface } — the arena's bounds — and `ballMax` / `swimMax` the speeds the
 * velocities are measured against.
 */
export function features(me, opp, ball, meter, mirror, pitch, ballMax = 64, swimMax = 34, out = new Float32Array(N_FEATURES)) {
  const sx = mirror ? -1 : 1;
  const W = Math.max(1, pitch.right - pitch.left);
  const H = Math.max(1, pitch.surface - pitch.bottom);
  const cx = (pitch.left + pitch.right) / 2;
  const cy = (pitch.surface + pitch.bottom) / 2;
  out[0] = clampUnit(sx * (ball.x - me.x) / W * 2);
  out[1] = clampUnit((ball.y - me.y) / H * 2);
  out[2] = clampUnit(sx * ball.vx / ballMax);
  out[3] = clampUnit(ball.vy / ballMax);
  out[4] = clampUnit(sx * me.vx / swimMax);
  out[5] = clampUnit(me.vy / swimMax);
  out[6] = clamp01(meter.charge);
  out[7] = clamp01(meter.pending);
  out[8] = clampUnit(sx * (me.x - cx) / (W / 2));
  out[9] = clampUnit((me.y - cy) / (H / 2));
  out[10] = clampUnit(sx * (opp.x - me.x) / W * 2);
  out[11] = clampUnit((opp.y - me.y) / H * 2);
  out[12] = clampUnit(sx * (ball.spin ?? 0) / 10);
  out[13] = meter.dashing ? 1 : 0;
  return out;
}

/** The player's input in the same mirrored frame: [moveX, moveY, aimX, aimY, strike]. */
export function actions(input, mirror, out = new Float32Array(N_ACTIONS)) {
  const sx = mirror ? -1 : 1;
  out[0] = clampUnit(sx * (input.move?.x ?? 0));
  out[1] = clampUnit(input.move?.y ?? 0);
  out[2] = clampUnit(sx * (input.aim?.x ?? 0));
  out[3] = clampUnit(input.aim?.y ?? 0);
  out[4] = input.strikeHeld ? 1 : 0;
  return out;
}

/**
 * File one seal's row, rate-limited to RATE_HZ by the caller's clock. Call
 * every frame with the frame's dt; it returns true on the frames it filed.
 */
export function recordImitation(dt, side, feat, act) {
  if (!imitationState.enabled) return false;
  imitationState.clock += dt;
  if (imitationState.clock < 1 / RATE_HZ) return false;
  imitationState.clock -= 1 / RATE_HZ;
  const row = new Array(N_FEATURES + N_ACTIONS);
  for (let i = 0; i < N_FEATURES; i++) row[i] = round3(feat[i]);
  for (let i = 0; i < N_ACTIONS; i++) row[N_FEATURES + i] = round3(act[i]);
  imitationState.rows.push(row);
  imitationState.side.push(side);
  imitationState.total++;
  if (imitationState.rows.length >= FLUSH_AT) flushImitation('batch');
  return true;
}

/** Hand the pending rows to the dev server (a build keeps nothing). */
export function flushImitation(reason = 'end') {
  const rows = imitationState.rows;
  if (!rows.length) return 0;
  const n = rows.length;
  const doc = {
    version: IMITATION_VERSION,
    at: new Date().toISOString(),
    reason,
    features: FEATURE_NAMES,
    actions: ACTION_NAMES,
    rows: rows.splice(0, rows.length),
  };
  imitationState.side.length = 0;
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV && typeof fetch === 'function') {
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
        keepalive: true,
      }).then((r) => { if (r.ok) imitationState.posted += n; })
        .catch((err) => console.warn('[imitation] rows not written —', err?.message ?? err));
    } catch (err) {
      console.warn('[imitation] rows not written —', err?.message ?? err);
    }
  }
  return n;
}

export function resetImitation() {
  imitationState.rows.length = 0;
  imitationState.side.length = 0;
  imitationState.clock = 0;
}

// ---------------------------------------------------------------------------
// THE POLICY — a small dense network, evaluated here and trained in
// tools/imitate-train.mjs with this same forward pass, so the two cannot
// disagree about what a layer means.
//
// model = { trained, inputs, layers: [{ w: number[out*in], b: number[out], act }] }
// act: 'tanh' | 'relu' | 'linear'. The last layer is 'linear'; the caller
// squashes it — tanh for the four stick/aim outputs, a sigmoid for the strike.
// ---------------------------------------------------------------------------

export function mlpForward(model, x, out = null) {
  let a = x;
  for (const layer of model.layers) {
    const nOut = layer.b.length;
    const nIn = a.length;
    const y = new Float32Array(nOut);
    const w = layer.w;
    for (let o = 0; o < nOut; o++) {
      let s = layer.b[o];
      const row = o * nIn;
      for (let i = 0; i < nIn; i++) s += w[row + i] * a[i];
      y[o] = layer.act === 'tanh' ? Math.tanh(s) : layer.act === 'relu' ? (s > 0 ? s : 0) : s;
    }
    a = y;
  }
  if (out) { for (let i = 0; i < a.length; i++) out[i] = a[i]; return out; }
  return a;
}

/** The network's raw output as an input: stick and aim through tanh, strike through a sigmoid. */
export function policyAction(model, feat, out = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, strike: 0 }) {
  const y = mlpForward(model, feat);
  out.moveX = Math.tanh(y[0]);
  out.moveY = Math.tanh(y[1]);
  out.aimX = Math.tanh(y[2]);
  out.aimY = Math.tanh(y[3]);
  out.strike = 1 / (1 + Math.exp(-y[4]));
  return out;
}

export function policyUsable(model) {
  return !!(model && model.trained && Array.isArray(model.layers) && model.layers.length
    && model.inputs === N_FEATURES && model.layers[model.layers.length - 1].b.length === N_ACTIONS);
}

function clampUnit(v) { return v < -1 ? -1 : v > 1 ? 1 : (Number.isFinite(v) ? v : 0); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : (Number.isFinite(v) ? v : 0); }
function round3(v) { return Math.round(v * 1000) / 1000; }
