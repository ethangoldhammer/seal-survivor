// ---------------------------------------------------------------------------
// THE WIRE — what an online match sends, byte for byte.
//
// A LEAF, on purpose. No THREE, no DOM, no socket, no `import.meta.env`. This
// module is pure arithmetic over ArrayBuffers so the harness can hammer it with
// no game running and no network, and so the room server can carry its output
// without ever being able to look inside it.
//
// BINARY FOR THE TWO PER-FRAME TYPES ONLY. Input up and snapshots down are the
// only messages that happen sixty times a minute per second; everything else —
// the lobby, the match start, the result — is JSON, because a control plane you
// can read in devtools is worth more than the bytes it costs. The two that are
// binary earn hand-written codecs. Nothing else does.
//
// EVERYTHING IS RELIABLE AND ORDERED, because a WebSocket is TCP. There is no
// packet loss here to design around — only latency, jitter, and head-of-line
// blocking. So: no acks, no nacks, no input redundancy, none of the machinery a
// UDP netcode needs. What there IS instead is a jitter buffer on the guest,
// because TCP turns a stall into a BURST rather than a gap, and several
// snapshots arriving in one tick is the normal shape of a bad moment.
//
// THE VERSION BYTE IS LOAD-BEARING. Every layout below will move — a field
// added, a scale retuned — and two tabs on different builds must fail loudly at
// the join rather than quietly in the water. Bump `PROTOCOL_VERSION` in the
// same commit as any layout change, and update the byte-length assertions in
// tools/net-protocol-test.mjs with it. Those two assertions are what turn a
// layout mistake into a red test instead of a wobbly ball.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE CODE
//
// Letters only, with I and O and L left out: the three that a person reading a
// code aloud down a phone, or off a screen across a room, confuses with 1, 0
// and 1 again. Digits are left out ENTIRELY rather than mixed in, because the
// moment a code can contain both `0` and `O` the reader has to know which it
// is, and no amount of font choice fixes that reliably on someone else's
// machine.
//
// 23 letters, 5 long, is 6,436,343 codes. That is not a security boundary — a
// determined scanner finds occupied rooms — and it is not meant to be one: a
// room lives for one match, holds two people, and shows the host who joined
// before anything starts. It is long enough that an accidental collision
// between two rooms open at the same time is not a thing that happens.
// ---------------------------------------------------------------------------

export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

/** A fresh code. `random` is injectable so the test can force collisions. */
export function newCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return out;
}

/**
 * What a person typed, as a code — or '' if it isn't one.
 *
 * Case and the separators someone might add ("abc-de", "ABC DE") are forgiven,
 * because those are how the code was READ OUT rather than how it was meant. A
 * character that is not in the alphabet is NOT forgiven: silently dropping it
 * would turn "AB0CD" into a valid-looking four-character string and then into
 * a confusing length error, when the honest answer is that `0` is not a thing
 * a code contains. Rejected codes come back as '' and the caller answers
 * `bad_code`.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length !== CODE_LENGTH) return '';
  for (const c of s) if (!ALPHABET.includes(c)) return '';
  return s;
}

// 2: the meter block's fourth byte stopped being padding and became `charge`,
// the stocked boost meter. The block is the same SIZE, which is exactly why
// the version had to move — two builds either side of this change exchange
// snapshots that decode without error and read a full boost bar as empty.
export const PROTOCOL_VERSION = 2;

export const MSG_INPUT = 0x10;
export const MSG_SNAPSHOT = 0x20;

// ---------------------------------------------------------------------------
// QUANTIZATION
//
// Every scale below is chosen against a real number in the game, not picked for
// roundness — the whole point of a fixed-point wire is that the error is known
// and bounded, and a scale nobody checked is just a lossy float.
//
//   POS   the pitch is CONFIG.arena.width 80 units, so bounds are near +/-40.
//         /256 gives +/-128 at 0.004 — three times the room needed, and finer
//         than the ball moves in a frame at any speed it can reach.
//   VEL   the ball's own cap is CONFIG.versus.ball.maxSpeed 64 u/s and a dash
//         is well under that. /128 gives +/-256 at 0.008.
//   ANGLE a full turn across the int16 range, so the step is 0.0002 rad.
//   RIM   a dent is capped at maxDeform (0.29) x ball.r (2.4) = 0.7 units, and
//         an int8 at /64 carries +/-1.98 — nearly 3x the headroom, at 0.016,
//         which on a 0.7 dent is under two percent and invisible.
//   QUAT  components are already in [-1, 1]; the full int16 range is 0.00003.
//   AXIS  a stick is in [-1, 1] and the deadzone is 0.18, so an int8's 0.008
//         is an order of magnitude below anything a hand can hold.
// ---------------------------------------------------------------------------

export const POS_SCALE = 256;
export const VEL_SCALE = 128;
export const ANGLE_SCALE = 32767 / Math.PI;
export const SPIN_SCALE = 64;
export const RIM_SCALE = 64;
export const QUAT_SCALE = 32767;
export const AXIS_SCALE = 127;

/** `CONFIG.versus.ball.soft.points` — the rim samples a snapshot carries. */
export const RIM_POINTS = 24;

// Byte offsets, as sizes rather than positions, so a field added to one block
// cannot silently shift the block after it without this table changing too.
const HEAD_BYTES = 12;
const BALL_BYTES = 12;
const RIM_BYTES = RIM_POINTS;
const SEAL_BYTES = 15;
const METER_BYTES = 4;
const METER_COUNT = 2;
const MATCH_BYTES = 8;

export const INPUT_BYTES = 12;

/** Exactly how long a snapshot for `seals` seals is. Asserted by the test. */
export function snapshotBytes(seals) {
  return HEAD_BYTES + BALL_BYTES + RIM_BYTES + SEAL_BYTES * seals + METER_BYTES * METER_COUNT + MATCH_BYTES;
}

/**
 * The match phases, as a wire enum.
 *
 * ORDER IS THE FORMAT. A phase inserted in the middle renumbers every one
 * after it, which is a layout change and needs the version byte bumped like
 * any other. Append, or bump.
 */
export const PHASES = ['kickoff', 'play', 'scored', 'replay', 'won', 'over'];

// Input flag bits.
export const IN_AIM_LIVE = 1 << 0;
export const IN_AIM_MOVED = 1 << 1;
export const IN_STRIKE_HELD = 1 << 2;
export const IN_CONNECTED = 1 << 3;

// Per-seal flag bits.
export const SEAL_VISIBLE = 1 << 0;
export const SEAL_DEAD = 1 << 1;

// Meter flag bits.
export const METER_CHARGING = 1 << 0;

// Match flag bits.
export const MATCH_WINNER_SIDE = 1 << 0;
export const MATCH_HAS_WINNER = 1 << 1;
export const MATCH_DRAW = 1 << 2;

// ---------------------------------------------------------------------------
// WHAT GETS RELAYED
//
// The guest never runs a collision, a goal test or a respawn, so the events
// those fire have to arrive from the host or they never happen at all. But the
// guest DOES pose every seal and every frame of the ball, so anything that is a
// byproduct of a pose it can fire for itself — and relaying one of those means
// the guest hears it twice.
//
// `strikeCharging` is the example worth keeping in mind: it is a haptic tick on
// an interval while a seal is winding up (versus.js, in stepSeat), and the
// snapshot already carries `charging` for both captains. The guest drives it
// off that meter locally. Relaying it instead would put six events a second on
// the wire to produce a sound the guest could already make.
//
// So the rule is not "relay the important ones" — it is RELAY WHAT THE GUEST
// CANNOT DERIVE. The test asserts that nothing on this list is something the
// pose path fires locally, because a double sound is the kind of bug that gets
// blamed on the audio bank for a week.
// ---------------------------------------------------------------------------

export const RELAYED = new Set([
  // Scoring and the shape of a match.
  'versusGoal', 'versusGoalCheer', 'versusKickoff', 'versusCountdown',
  'versusWin', 'versusLose',
  // Contacts. Every one of these is decided inside a collision the guest does
  // not run, and several are read off trajectory rather than off a touch.
  // The ball's body contact is THREE rows, not one — ballImpactFx picks by how
  // hard the touch was (CONFIG.versus.ball.fx.voice). All three have to be here
  // or the guest goes quiet for exactly the contacts that happen most: a tap is
  // every dribble in the match and a smash is every shot worth hearing, and the
  // middle row alone would relay only the ones in between.
  'versusBallTap', 'versusBallHit', 'versusBallSmash',
  'versusBallWall', 'versusBallSkid', 'versusPost',
  'versusBlock', 'versusSave', 'versusPierce',
  'bodyCheck',
  // A dash and its consequences — tryStrike lives on the host's side of the
  // line, so the guest sees the seal move but knows nothing about why.
  'strike', 'strikePerfect', 'strikeRam', 'strikeVent',
  // Death and coming back.
  'sealBurst', 'versusRespawn',
]);

/**
 * Events the GUEST fires for itself while posing, listed so the test can prove
 * the two sets do not overlap. Not used at runtime — this is the other half of
 * a claim that would otherwise only live in a comment.
 */
export const LOCAL_EVENTS = new Set([
  'strikeCharging',  // driven off the relayed `charging` meter
  'bubblePop',       // Phase 8: bubbles are spawn/pop events, popped locally
]);

// ---------------------------------------------------------------------------
// INPUT — guest to host, 30 Hz, 12 bytes
//
// `strike` AND `strikeRelease` ARE NOT HERE, and their absence is the design.
// They are edges, and an edge on the wire is two machines holding an opinion
// about when a button went down. The host derives both from `strikeHeld` and
// its own previous frame, exactly the way readP2Input does for a local pad, so
// there is one edge and the host owns it.
// ---------------------------------------------------------------------------

export function encodeInput({ seq = 0, clientMs = 0, move, aim, aimLive, aimMoved, strikeHeld, connected = true }) {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG_INPUT);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint16(2, seq & 0xffff);
  v.setUint16(4, clientMs & 0xffff);
  v.setInt8(6, quant(move?.x ?? 0, AXIS_SCALE, 127));
  v.setInt8(7, quant(move?.y ?? 0, AXIS_SCALE, 127));
  v.setInt8(8, quant(aim?.x ?? 0, AXIS_SCALE, 127));
  v.setInt8(9, quant(aim?.y ?? 0, AXIS_SCALE, 127));
  let flags = 0;
  if (aimLive) flags |= IN_AIM_LIVE;
  if (aimMoved) flags |= IN_AIM_MOVED;
  if (strikeHeld) flags |= IN_STRIKE_HELD;
  if (connected) flags |= IN_CONNECTED;
  v.setUint8(10, flags);
  v.setUint8(11, 0);
  return buf;
}

/** @returns the packet, or null for anything that isn't one. Never throws. */
export function decodeInput(buf) {
  const v = view(buf, MSG_INPUT, INPUT_BYTES);
  if (!v) return null;
  const flags = v.getUint8(10);
  return {
    seq: v.getUint16(2),
    clientMs: v.getUint16(4),
    move: { x: v.getInt8(6) / AXIS_SCALE, y: v.getInt8(7) / AXIS_SCALE },
    aim: { x: v.getInt8(8) / AXIS_SCALE, y: v.getInt8(9) / AXIS_SCALE },
    aimLive: (flags & IN_AIM_LIVE) !== 0,
    aimMoved: (flags & IN_AIM_MOVED) !== 0,
    strikeHeld: (flags & IN_STRIKE_HELD) !== 0,
    connected: (flags & IN_CONNECTED) !== 0,
  };
}

// ---------------------------------------------------------------------------
// SNAPSHOT — host to guest, 20 Hz, 64 + 15n bytes (94 for a 1v1)
//
// WHAT IS DELIBERATELY MISSING: the ball's look and its spin strokes. versus.js
// already carries the sentinels for exactly this case — `look[0] === 0` and
// `spin[0] === -1` mean "this frame recorded none, use the live machines" — so
// the guest's own ballLook and ballSpin run off the posed position and velocity
// and nobody can see the difference. That is ~96 floats a frame not sent.
//
// WHAT IS HERE THAT LOOKS COSMETIC AND IS NOT: `timeScale`. Hit-stop is a feel,
// and a freeze that lands a frame late on one machine is a freeze that reads as
// lag. It is authority, not decoration, which is why the guest returns it out
// of updateVersusClock rather than deriving a scale of its own.
//
// AND THE METERS. The charge ring and the air band are per-seal and diegetic
// (updateSeatRings reads seal.strike and seal.oxygen), so without these eight
// bytes a guest's own charge ring sits frozen while they wind up — which is not
// a polish problem, it is the control being invisible.
// ---------------------------------------------------------------------------

export function encodeSnapshot(s) {
  const n = s.seals.length;
  const buf = new ArrayBuffer(snapshotBytes(n));
  const v = new DataView(buf);

  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint16(2, (s.seq ?? 0) & 0xffff);
  v.setUint16(4, n);
  v.setUint16(6, 0);
  v.setFloat32(8, s.clock ?? 0);

  let o = HEAD_BYTES;
  const b = s.ball;
  v.setInt16(o, quant(b.x, POS_SCALE)); o += 2;
  v.setInt16(o, quant(b.y, POS_SCALE)); o += 2;
  v.setInt16(o, quant(b.vx, VEL_SCALE)); o += 2;
  v.setInt16(o, quant(b.vy, VEL_SCALE)); o += 2;
  v.setInt16(o, quant(wrapAngle(b.angle), ANGLE_SCALE)); o += 2;
  v.setInt16(o, quant(b.spin, SPIN_SCALE)); o += 2;

  for (let i = 0; i < RIM_POINTS; i += 1) {
    v.setInt8(o + i, quant(b.rim?.[i] ?? 0, RIM_SCALE, 127));
  }
  o += RIM_BYTES;

  for (const seal of s.seals) {
    v.setInt16(o, quant(seal.x, POS_SCALE)); o += 2;
    v.setInt16(o, quant(seal.y, POS_SCALE)); o += 2;
    v.setInt16(o, quant(wrapAngle(seal.rz), ANGLE_SCALE)); o += 2;
    v.setInt16(o, quant(seal.qx, QUAT_SCALE)); o += 2;
    v.setInt16(o, quant(seal.qy, QUAT_SCALE)); o += 2;
    v.setInt16(o, quant(seal.qz, QUAT_SCALE)); o += 2;
    v.setInt16(o, quant(seal.qw, QUAT_SCALE)); o += 2;
    let f = 0;
    if (seal.visible) f |= SEAL_VISIBLE;
    if (seal.dead) f |= SEAL_DEAD;
    v.setUint8(o, f); o += 1;
  }

  for (let i = 0; i < METER_COUNT; i += 1) {
    const m = s.meters[i] ?? {};
    v.setUint8(o, clamp255((m.pending ?? 0) * 255)); o += 1;
    v.setUint8(o, clamp255((m.oxygen01 ?? 1) * 255)); o += 1;
    v.setUint8(o, m.charging ? METER_CHARGING : 0); o += 1;
    // THE STOCKED METER, in what used to be the block's pad byte.
    //
    // `pending` above is NOT this and the difference is the whole of a bug:
    // pending is how far the CURRENT wind-up has got, which is zero except in
    // the moment somebody is holding the button, while `charge` is the fuel in
    // the tank — the bar that is on screen the whole match. A guest sent only
    // pending had a boost meter that sat empty and twitched.
    v.setUint8(o, clamp255((m.charge ?? 1) * 255)); o += 1;
  }

  const mt = s.match;
  const phase = PHASES.indexOf(mt.phase);
  v.setUint8(o, phase < 0 ? 0 : phase); o += 1;
  v.setUint8(o, clamp255(mt.scores?.[0] ?? 0)); o += 1;
  v.setUint8(o, clamp255(mt.scores?.[1] ?? 0)); o += 1;
  // -1 is "no count running", and a u8 has no sign — so it rides as 255. The
  // decoder maps it back rather than leaving a caller to wonder why the
  // countdown says two hundred and fifty five.
  v.setUint8(o, mt.count < 0 ? 255 : clamp255(mt.count)); o += 1;
  v.setUint16(o, Math.min(65535, Math.max(0, Math.round((mt.phaseT ?? 0) * 1000)))); o += 2;
  v.setUint8(o, clamp255((mt.timeScale ?? 1) * 200)); o += 1;
  let mf = 0;
  if (mt.winner === 0 || mt.winner === 1) { mf |= MATCH_HAS_WINNER; if (mt.winner === 1) mf |= MATCH_WINNER_SIDE; }
  if (mt.draw) mf |= MATCH_DRAW;
  v.setUint8(o, mf);

  return buf;
}

/** @returns the snapshot, or null for anything that isn't one. Never throws. */
export function decodeSnapshot(buf) {
  const head = view(buf, MSG_SNAPSHOT, HEAD_BYTES);
  if (!head) return null;
  const n = head.getUint16(4);
  // The seal count comes off the wire, so it decides how long the buffer must
  // be — check it against what actually arrived before reading a byte of it. A
  // truncated frame and a frame claiming eighty seals are the same bug here,
  // and both have to come back as null rather than as a RangeError.
  const v = view(buf, MSG_SNAPSHOT, snapshotBytes(n));
  if (!v) return null;

  let o = HEAD_BYTES;
  const ball = {
    x: v.getInt16(o) / POS_SCALE,
    y: v.getInt16(o + 2) / POS_SCALE,
    vx: v.getInt16(o + 4) / VEL_SCALE,
    vy: v.getInt16(o + 6) / VEL_SCALE,
    angle: v.getInt16(o + 8) / ANGLE_SCALE,
    spin: v.getInt16(o + 10) / SPIN_SCALE,
    rim: new Float32Array(RIM_POINTS),
  };
  o += BALL_BYTES;
  for (let i = 0; i < RIM_POINTS; i += 1) ball.rim[i] = v.getInt8(o + i) / RIM_SCALE;
  o += RIM_BYTES;

  const seals = [];
  for (let i = 0; i < n; i += 1) {
    const f = v.getUint8(o + 14);
    seals.push({
      x: v.getInt16(o) / POS_SCALE,
      y: v.getInt16(o + 2) / POS_SCALE,
      rz: v.getInt16(o + 4) / ANGLE_SCALE,
      qx: v.getInt16(o + 6) / QUAT_SCALE,
      qy: v.getInt16(o + 8) / QUAT_SCALE,
      qz: v.getInt16(o + 10) / QUAT_SCALE,
      qw: v.getInt16(o + 12) / QUAT_SCALE,
      visible: (f & SEAL_VISIBLE) !== 0,
      dead: (f & SEAL_DEAD) !== 0,
    });
    o += SEAL_BYTES;
  }

  const meters = [];
  for (let i = 0; i < METER_COUNT; i += 1) {
    meters.push({
      pending: v.getUint8(o) / 255,
      oxygen01: v.getUint8(o + 1) / 255,
      charging: (v.getUint8(o + 2) & METER_CHARGING) !== 0,
      charge: v.getUint8(o + 3) / 255,
    });
    o += METER_BYTES;
  }

  const rawCount = v.getUint8(o + 3);
  const mf = v.getUint8(o + 7);
  const match = {
    phase: PHASES[v.getUint8(o)] ?? PHASES[0],
    scores: [v.getUint8(o + 1), v.getUint8(o + 2)],
    count: rawCount === 255 ? -1 : rawCount,
    phaseT: v.getUint16(o + 4) / 1000,
    timeScale: v.getUint8(o + 6) / 200,
    winner: (mf & MATCH_HAS_WINNER) ? ((mf & MATCH_WINNER_SIDE) ? 1 : 0) : -1,
    draw: (mf & MATCH_DRAW) !== 0,
  };

  return { seq: head.getUint16(2), clock: head.getFloat32(8), ball, seals, meters, match };
}

// ---------------------------------------------------------------------------

/**
 * A DataView over `buf` if it really is a `type` frame of at least `min` bytes
 * on this protocol version, and null otherwise.
 *
 * TOTAL BY DESIGN. Every way a frame can be wrong — a short buffer, a stale
 * version, a type from the other direction, something that isn't a buffer at
 * all — comes back as null. The alternative is a throw inside a message
 * handler, which on the guest means one bad frame ends the match.
 */
function view(buf, type, min) {
  if (!buf) return null;
  const ab = buf instanceof ArrayBuffer ? buf : (ArrayBuffer.isView(buf) ? buf.buffer : null);
  if (!ab) return null;
  const offset = buf instanceof ArrayBuffer ? 0 : buf.byteOffset;
  const length = buf.byteLength;
  if (length < min) return null;
  const v = new DataView(ab, offset, length);
  if (v.getUint8(0) !== type) return null;
  if (v.getUint8(1) !== PROTOCOL_VERSION) return null;
  return v;
}

function quant(n, scale, cap = 32767) {
  const q = Math.round((Number.isFinite(n) ? n : 0) * scale);
  return q > cap ? cap : (q < -cap ? -cap : q);
}

function clamp255(n) {
  const r = Math.round(Number.isFinite(n) ? n : 0);
  return r > 255 ? 255 : (r < 0 ? 0 : r);
}

/** Into [-pi, pi], so the angle scale never clips a heading that wound past. */
function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  return Math.atan2(Math.sin(a), Math.cos(a));
}
