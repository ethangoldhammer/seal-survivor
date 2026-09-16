#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:protocol
//
// The wire format an online Blubberball match runs on: that every message
// round-trips, that the fixed-point error stays inside its stated bound, and
// that a frame which arrives short, stale or malformed comes back as null
// rather than throwing. Each of those fails silently in play — a snapshot
// decoded a version behind is not an error, it is a ball in the wrong place —
// and the byte-length checks here are what turn a layout change made without
// bumping PROTOCOL_VERSION into a red test instead of a week of blaming jitter.
//
// Imports protocol.js alone, which is a leaf with no THREE and no DOM, so
// this runs on plain node with no loader and no game.
// ---------------------------------------------------------------------------

import {
  PROTOCOL_VERSION, MSG_INPUT, MSG_SNAPSHOT,
  INPUT_BYTES, snapshotBytes, RIM_POINTS, PHASES,
  POS_SCALE, VEL_SCALE, ANGLE_SCALE, RIM_SCALE, QUAT_SCALE, AXIS_SCALE,
  RELAYED, LOCAL_EVENTS,
  encodeInput, decodeInput, encodeSnapshot, decodeSnapshot,
} from '../path/src/systems/online/protocol.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
console.log('\ninput — 12 bytes, and no edges on the wire\n');

{
  const buf = encodeInput({
    seq: 1234, clientMs: 55_000,
    move: { x: 0.5, y: -0.25 }, aim: { x: -1, y: 0 },
    aimLive: true, aimMoved: false, strikeHeld: true, connected: true,
  });
  check('an input packet is exactly INPUT_BYTES', buf.byteLength === INPUT_BYTES, `got ${buf.byteLength}`);

  const d = decodeInput(buf);
  check('seq and clientMs round-trip', d.seq === 1234 && d.clientMs === 55_000);
  check('move is within one axis step', near(d.move.x, 0.5, 1 / AXIS_SCALE) && near(d.move.y, -0.25, 1 / AXIS_SCALE),
    `got ${d.move.x}, ${d.move.y}`);
  check('aim is within one axis step', near(d.aim.x, -1, 1 / AXIS_SCALE) && near(d.aim.y, 0, 1 / AXIS_SCALE));
  check('flags round-trip independently',
    d.aimLive === true && d.aimMoved === false && d.strikeHeld === true && d.connected === true);
}

// An edge on the wire would be two machines with an opinion about when a
// button went down. The host derives both from strikeHeld; assert they never
// appear here, so a well-meaning addition has to argue with a test first.
{
  const d = decodeInput(encodeInput({ move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, strikeHeld: true }));
  check('strike and strikeRelease are NOT carried',
    d.strike === undefined && d.strikeRelease === undefined,
    'the host derives both from strikeHeld and its own previous frame');
}

// Every combination, because a flag that shares a bit with another is a bug
// that only shows up when both happen to be set at once.
{
  let bad = '';
  for (let bits = 0; bits < 16; bits += 1) {
    const want = {
      aimLive: !!(bits & 1), aimMoved: !!(bits & 2),
      strikeHeld: !!(bits & 4), connected: !!(bits & 8),
    };
    const d = decodeInput(encodeInput({ move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, ...want }));
    for (const k of Object.keys(want)) if (d[k] !== want[k]) bad = `bits ${bits}: ${k}`;
  }
  check('all 16 flag combinations round-trip', !bad, bad);
}

{
  const d = decodeInput(encodeInput({ move: { x: 9, y: -9 }, aim: { x: 0, y: 0 } }));
  check('an out-of-range stick clamps rather than wrapping', d.move.x === 1 && near(d.move.y, -1, 1 / AXIS_SCALE),
    `got ${d.move.x}, ${d.move.y}`);
}

// ---------------------------------------------------------------------------
console.log('\nsnapshot — the layout, and its error bounds\n');

function sampleSnapshot(n = 2) {
  const rim = new Float32Array(RIM_POINTS);
  for (let i = 0; i < RIM_POINTS; i += 1) rim[i] = Math.sin(i) * 0.6;
  const seals = [];
  for (let i = 0; i < n; i += 1) {
    seals.push({
      x: -30 + i * 7.25, y: 3.5 - i, rz: -2.9 + i * 0.7,
      qx: 0.1, qy: -0.2, qz: 0.3, qw: 0.927,
      visible: i !== 1, dead: i === 1,
    });
  }
  return {
    seq: 40_000, clock: 123.456,
    ball: { x: -12.375, y: 4.25, vx: 33.5, vy: -18.25, angle: 2.5, spin: -7.75, rim },
    seals,
    meters: [
      { pending: 0.5, oxygen01: 0.75, charging: true },
      { pending: 0, oxygen01: 1, charging: false },
    ],
    match: { phase: 'scored', scores: [3, 2], count: -1, phaseT: 1.234, timeScale: 0.04, winner: -1, draw: false },
  };
}

{
  check('a 1v1 snapshot is 94 bytes', snapshotBytes(2) === 94, `got ${snapshotBytes(2)}`);
  check('a full 4-a-side snapshot is 184 bytes', snapshotBytes(8) === 184, `got ${snapshotBytes(8)}`);
  check('encode agrees with snapshotBytes', encodeSnapshot(sampleSnapshot(2)).byteLength === snapshotBytes(2));
  check('and for eight seals too', encodeSnapshot(sampleSnapshot(8)).byteLength === snapshotBytes(8));
}

{
  const s = sampleSnapshot(2);
  const d = decodeSnapshot(encodeSnapshot(s));
  check('seq and clock round-trip', d.seq === 40_000 && near(d.clock, 123.456, 1e-3));

  check('ball position is within one POS step',
    near(d.ball.x, s.ball.x, 1 / POS_SCALE) && near(d.ball.y, s.ball.y, 1 / POS_SCALE),
    `got ${d.ball.x}, ${d.ball.y}`);
  check('ball velocity is within one VEL step',
    near(d.ball.vx, s.ball.vx, 1 / VEL_SCALE) && near(d.ball.vy, s.ball.vy, 1 / VEL_SCALE));
  check('ball angle is within one ANGLE step', near(d.ball.angle, s.ball.angle, 1 / ANGLE_SCALE));

  let worst = 0;
  for (let i = 0; i < RIM_POINTS; i += 1) worst = Math.max(worst, Math.abs(d.ball.rim[i] - s.ball.rim[i]));
  check('every rim sample is within one RIM step', worst <= 1 / RIM_SCALE, `worst ${worst.toFixed(5)}`);

  check('the seal count comes back', d.seals.length === 2);
  const a = d.seals[0];
  check('seal position is within one POS step',
    near(a.x, s.seals[0].x, 1 / POS_SCALE) && near(a.y, s.seals[0].y, 1 / POS_SCALE));
  check('seal heading is within one ANGLE step', near(a.rz, s.seals[0].rz, 1 / ANGLE_SCALE));
  check('the quaternion is within one QUAT step',
    near(a.qx, 0.1, 1 / QUAT_SCALE) && near(a.qy, -0.2, 1 / QUAT_SCALE)
    && near(a.qz, 0.3, 1 / QUAT_SCALE) && near(a.qw, 0.927, 1 / QUAT_SCALE));
  check('per-seal flags are per seal', d.seals[0].visible === true && d.seals[0].dead === false
    && d.seals[1].visible === false && d.seals[1].dead === true);

  // Without these the guest's own charge ring sits frozen while they wind up.
  check('the captains’ meters round-trip',
    near(d.meters[0].pending, 0.5, 1 / 255) && near(d.meters[0].oxygen01, 0.75, 1 / 255)
    && d.meters[0].charging === true && d.meters[1].charging === false);

  check('phase round-trips by name', d.match.phase === 'scored');
  check('scores round-trip', d.match.scores[0] === 3 && d.match.scores[1] === 2);
  check('a countdown that is not running stays -1', d.match.count === -1);
  check('phaseT is within a millisecond', near(d.match.phaseT, 1.234, 1e-3));
  // Hit-stop is authority, not decoration: freezeScale has to survive exactly.
  check('the freeze timeScale survives', near(d.match.timeScale, 0.04, 1 / 200));
  check('no winner reads as -1 and not as side 0', d.match.winner === -1 && d.match.draw === false);
}

{
  const s = sampleSnapshot(2);
  s.match = { ...s.match, phase: 'won', winner: 1, draw: false };
  const d = decodeSnapshot(encodeSnapshot(s));
  check('a winning side round-trips', d.match.winner === 1);

  s.match = { ...s.match, winner: -1, draw: true };
  check('a draw round-trips', decodeSnapshot(encodeSnapshot(s)).match.draw === true);
}

{
  // The enum is the format: a phase inserted in the middle renumbers the rest.
  let bad = '';
  for (const p of PHASES) {
    const s = sampleSnapshot(2);
    s.match = { ...s.match, phase: p };
    if (decodeSnapshot(encodeSnapshot(s)).match.phase !== p) bad = p;
  }
  check('every phase in PHASES round-trips', !bad, bad);
}

// ---------------------------------------------------------------------------
console.log('\nbad frames — null, never a throw\n');

function safeDecode(fn, buf) {
  try { return { threw: false, value: fn(buf) }; } catch (e) { return { threw: true, value: e.message }; }
}

{
  const full = encodeSnapshot(sampleSnapshot(2));

  const short = full.slice(0, full.byteLength - 1);
  const r = safeDecode(decodeSnapshot, short);
  check('a snapshot one byte short decodes to null', !r.threw && r.value === null, r.threw ? r.value : `got ${r.value}`);

  const stale = full.slice(0);
  new DataView(stale).setUint8(1, PROTOCOL_VERSION + 1);
  const rv = safeDecode(decodeSnapshot, stale);
  check('a snapshot on another protocol version decodes to null', !rv.threw && rv.value === null);

  const wrongType = full.slice(0);
  new DataView(wrongType).setUint8(0, MSG_INPUT);
  check('a snapshot claiming to be input decodes to null', decodeSnapshot(wrongType) === null);

  // A seal count from the wire decides how much is read. A frame claiming
  // eighty seals in ninety-four bytes is the same bug as a truncated one, and
  // must be the same answer rather than a RangeError inside a message handler.
  const liar = full.slice(0);
  new DataView(liar).setUint16(4, 80);
  const rl = safeDecode(decodeSnapshot, liar);
  check('a snapshot lying about its seal count decodes to null', !rl.threw && rl.value === null,
    rl.threw ? rl.value : `got ${rl.value}`);

  check('an empty buffer decodes to null', decodeSnapshot(new ArrayBuffer(0)) === null);
  check('a non-buffer decodes to null', decodeSnapshot('hello') === null && decodeInput(null) === null);
  check('a Uint8Array view decodes like the buffer it wraps',
    decodeSnapshot(new Uint8Array(full))?.seq === 40_000);
}

{
  const input = encodeInput({ move: { x: 0, y: 0 }, aim: { x: 1, y: 0 } });
  check('an input one byte short decodes to null', decodeInput(input.slice(0, INPUT_BYTES - 1)) === null);
  const stale = input.slice(0);
  new DataView(stale).setUint8(1, 99);
  check('an input on another protocol version decodes to null', decodeInput(stale) === null);
  check('a snapshot handed to decodeInput decodes to null',
    decodeInput(encodeSnapshot(sampleSnapshot(2))) === null);
}

// ---------------------------------------------------------------------------
console.log('\nthe relay whitelist\n');

{
  const overlap = [...RELAYED].filter((n) => LOCAL_EVENTS.has(n));
  check('nothing relayed is also fired locally by the guest', overlap.length === 0,
    overlap.length ? `${overlap.join(', ')} would play twice on the guest` : '');
  check('the guest derives strikeCharging from the meter rather than the wire',
    LOCAL_EVENTS.has('strikeCharging') && !RELAYED.has('strikeCharging'));
  check('the events a guest cannot derive are all listed',
    ['versusGoal', 'versusSave', 'versusBlock', 'versusBallHit', 'bodyCheck', 'sealBurst']
      .every((n) => RELAYED.has(n)));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
