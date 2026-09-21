import * as THREE from 'three';
import { CONFIG } from '../config.js';

// ===========================================================================
// THE FIN FLICK — putting english on a ball with a swipe.
// ===========================================================================
// Blubberball's other spin control is `english` (systems/strike.js): swim
// across the line you are aiming down and your body slides over the ball's
// face as you strike it. That one is part of the SHOT — you buy it at the
// moment of contact and you cannot change your mind afterwards.
//
// This is the other half: a ball already travelling, and a flipper wiped
// across it. Same friction model as the strike (see strikeBall), a much
// weaker press, and no impulse down the line at all — a flick does not shoot
// the ball, it BENDS it, and the Magnus term in stepBall does the rest.
//
// ---------------------------------------------------------------------------
// THE GESTURE IS THE ONE INPUT ALREADY HAS.
// ---------------------------------------------------------------------------
// `input.aimGesture` is the aim device's MOVEMENT, not its heading — the
// mouse's sweep summed over CONFIG.touch.aimFlick.window, or a pushed right
// stick, thresholded so a resting hand is nothing (readFlick in input.js).
// It is exactly the quantity this needs and it is already computed every
// frame, so a flick costs no new binding and no new deadzone: the seal's fins
// keep pointing at the cursor as they always did, and swiping the cursor
// swipes the fins.
//
// A WINDOW, NOT A FRAME. `aimMoved` stays true for as long as the hand keeps
// moving, so the edge is "no window open and not cooling" rather than a rising
// edge on the flag — a continuous swirl is a flick every `cooldown`, which is
// the honest reading of a hand that is continuously swiping. The window then
// stays open for `duration` whatever the hand does next, because a swipe is a
// gesture the player has already committed to by the time it is detected.
//
// ---------------------------------------------------------------------------
// THE HITBOX IS DELIBERATELY BIGGER THAN THE FIN.
// ---------------------------------------------------------------------------
// A flipper tip is a point on a 6-unit animal and the ball is 2.8 across; a
// contact test at the skin would land maybe one swipe in ten and every miss
// would read as the game ignoring the input. So while a window is open each
// muzzle carries a CAPSULE — from the fin tip out along the swipe by `sweep`,
// `reach` thick — and the test is that capsule against the ball's DRAWN edge.
// It exists only inside the window: there is no fin hitbox the rest of the
// time, so the generosity cannot leak into ordinary swimming.
//
// ONE CONNECT PER WINDOW, whichever fin reaches first. Two fins both landing
// would double the spin on a single swipe, and "I flicked it" is one event.
//
// The apply itself lives in systems/versus.js with the rest of the ball's
// physics — this file owns the gesture, the geometry and the debug draw, and
// knows nothing about spin.
// ===========================================================================

const cfg = () => CONFIG.versus?.ball?.finFlick ?? {};

export const finFlickState = {
  // Seconds left in the open window, 0 when none is.
  live: 0,
  // Seconds until another may open. Started at the OPEN rather than the close,
  // so `cooldown` is the whole period between swipes and not the gap after one.
  cool: 0,
  // The swipe's direction, world space, normalized. Held for the window's whole
  // length: the hand may have moved on, the swipe has not.
  dirX: 0,
  dirY: 0,
  // This window has already put spin on something.
  spent: false,
  // How many windows have opened, and how many of those connected. For the
  // harness and for anyone wondering whether the reach is generous enough.
  opened: 0,
  connected: 0,
  // The last connect: { x, y, fin, along, spin } — what the debug draw marks
  // and what `npm run test:finflick` reads.
  last: null,
};

export function resetFinFlick() {
  const s = finFlickState;
  s.live = 0;
  s.cool = 0;
  s.dirX = 0;
  s.dirY = 0;
  s.spent = false;
  s.opened = 0;
  s.connected = 0;
  s.last = null;
  clearDebug();
}

/**
 * Open a window by hand, for the harness and for anything that wants to flick
 * without an aim device. `gx`/`gy` is the swipe direction; it is normalized
 * here. Returns false when the flick is off, cooling or has no direction in it.
 */
export function openFinFlick(gx, gy, rig = null) {
  const f = cfg();
  if (f.enabled === false) return false;
  const s = finFlickState;
  if (s.live > 0 || s.cool > 0) return false;
  const len = Math.hypot(gx, gy);
  if (!(len > 1e-4)) return false;
  s.dirX = gx / len;
  s.dirY = gy / len;
  s.live = Math.max(0.01, f.duration ?? 0.18);
  // Never shorter than the window, or a second flick would open on top of one
  // that is still live and the "one connect per window" rule would be moot.
  s.cool = Math.max(s.live, f.cooldown ?? 0.26);
  s.spent = false;
  s.opened++;
  // THE FLIPPERS ACTUALLY MOVE. The same twitch a fired pellet kicks (see
  // kickFin in systems/aimRig.js), on both fins, so the swipe is visible on
  // the animal whether or not it reaches the ball — a gesture that only shows
  // when it lands is a gesture the player cannot learn to aim.
  if (rig?.kickFin) {
    const k = f.kick ?? 1;
    for (let i = 0; i < (rig.muzzles?.length ?? 0); i++) rig.kickFin(i, k);
  }
  return true;
}

/**
 * One frame of the gesture. Call before the ball's contact tests so a window
 * opened this frame can connect on the frame it opened.
 *
 * `input` is the seat's input object (input.aimMoved / input.aimGesture);
 * `rig` is the seal's aim rig, for the twitch and the debug draw.
 *
 * RETURNS whether a window opened on THIS frame — the swipe's own voice hangs
 * off it (versusFinSwipe in systems/versus.js). Reported rather than left to
 * the caller to spot, because `live > 0` is true for the whole window and a
 * caller comparing it frame to frame would fire on the frame a window CLOSED
 * as readily as on the one it opened.
 */
export function updateFinFlick(dt, input, rig = null, scene = null, opts = null) {
  const f = cfg();
  const s = finFlickState;
  if (f.enabled === false) {
    if (s.live || s.cool) { s.live = 0; s.cool = 0; s.spent = false; }
    clearDebug();
    return false;
  }
  if (s.cool > 0) s.cool = Math.max(0, s.cool - dt);
  if (s.live > 0) {
    s.live = Math.max(0, s.live - dt);
    if (s.live === 0) s.spent = false;
  }
  let opened = false;
  // MUTED, NOT SKIPPED. `opts.muted` is the caller saying the hand is busy
  // with another gesture — today that is systems/sealFlip.js, because a circle
  // is made of swipes and every frame of one passes the test below. The
  // clocks above have already ticked, so a window that was live when the mute
  // began closes on time instead of hanging open behind it; only the OPENING
  // is refused.
  if (opts?.muted) { drawDebug(rig, scene); return false; }
  if (s.live <= 0 && s.cool <= 0 && input?.aimMoved) {
    opened = openFinFlick(input.aimGesture?.x ?? 0, input.aimGesture?.y ?? 0, rig);
  }
  drawDebug(rig, scene);
  return opened;
}

// The nearest point on one fin's swept capsule, as the test needs it. Held
// rather than returned fresh: this runs every frame a window is open.
const _near = { x: 0, y: 0, dist: Infinity, fin: -1 };

/**
 * THE NEAREST FIN TO A POINT, over the open window's swept capsules — the
 * SEGMENT distance, so a ball anywhere along the swipe counts, not just one
 * sitting on the fin tip.
 *
 * Returns { x, y, dist, fin } (a held object) or null when no window is open,
 * the window is spent, or the rig has no muzzles. `dist` is to the capsule's
 * SPINE: the caller adds `reach` to whatever radius it is testing against,
 * which is what lets versus.js use the ball's drawn edge rather than a circle.
 */
export function finFlickNearest(rig, px, py) {
  const s = finFlickState;
  if (s.live <= 0 || s.spent) return null;
  const muzzles = rig?.muzzles;
  if (!muzzles?.length) return null;
  const sweep = Math.max(0, cfg().sweep ?? 3);
  _near.dist = Infinity;
  _near.fin = -1;
  for (let i = 0; i < muzzles.length; i++) {
    const m = muzzles[i];
    const ax = m.x;
    const ay = m.y;
    const ex = s.dirX * sweep;
    const ey = s.dirY * sweep;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 1e-9
      ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2))
      : 0;
    const cx = ax + ex * t;
    const cy = ay + ey * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < _near.dist) { _near.dist = d; _near.x = cx; _near.y = cy; _near.fin = i; }
  }
  return _near.fin >= 0 ? _near : null;
}

/** Mark the open window as having connected. One per window — see the header. */
export function spendFinFlick(hit = null) {
  const s = finFlickState;
  s.spent = true;
  s.connected++;
  s.last = hit;
}

// ---------------------------------------------------------------------------
// THE HITBOX, DRAWN — CONFIG.versus.ball.finFlick.debug.
// ---------------------------------------------------------------------------
// `reach` and `sweep` are two numbers in world units against an animal whose
// fins move every frame, and there is no way to tell a reach that is too short
// from a window that is too brief by watching swipes miss. So this draws what
// is actually being tested: the capsule's spine out of each fin, capped by a
// ring at `reach`, for as long as the window is open, plus a mark where the
// last connect landed.
//
// ONE GEOMETRY, MANY LINES, the way systems/attackOverlay.js does it: a unit
// circle and a unit segment, scaled and placed per draw. Built on the first
// frame the flag is on and torn down when it goes off, so an off switch costs
// one boolean test a frame.
let dbg = null;

function buildDebug(scene) {
  const g = new THREE.Group();
  g.renderOrder = 9000;
  const ring = new THREE.BufferGeometry();
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0);
  }
  ring.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const seg = new THREE.BufferGeometry();
  seg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x66ddff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
  });
  const hitMat = new THREE.LineBasicMaterial({
    color: 0xffdd55, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
  });
  dbg = { group: g, ring, seg, mat, hitMat, rings: [], segs: [], mark: null, scene };
  dbg.mark = new THREE.LineLoop(ring, hitMat);
  dbg.mark.renderOrder = 9001;
  dbg.mark.visible = false;
  g.add(dbg.mark);
  scene.add(g);
  return dbg;
}

function clearDebug() {
  if (!dbg) return;
  dbg.group.parent?.remove(dbg.group);
  dbg.ring.dispose();
  dbg.seg.dispose();
  dbg.mat.dispose();
  dbg.hitMat.dispose();
  dbg = null;
}

function drawDebug(rig, scene) {
  const f = cfg();
  if (!f.debug || !scene) { if (dbg) clearDebug(); return; }
  const d = dbg ?? buildDebug(scene);
  const muzzles = rig?.muzzles ?? [];
  const s = finFlickState;
  const reach = Math.max(0.01, f.reach ?? 2.4);
  const sweep = Math.max(0, f.sweep ?? 3);
  // Grow the pool to however many fins this rig has — two on the seal, and
  // never more than once per rig.
  while (d.rings.length < muzzles.length) {
    const ring = new THREE.LineLoop(d.ring, d.mat);
    const tail = new THREE.LineLoop(d.ring, d.mat);
    const line = new THREE.Line(d.seg, d.mat);
    d.group.add(ring, tail, line);
    d.rings.push([ring, tail]);
    d.segs.push(line);
  }
  const open = s.live > 0 && !s.spent;
  for (let i = 0; i < d.rings.length; i++) {
    const on = open && i < muzzles.length;
    const [ring, tail] = d.rings[i];
    const line = d.segs[i];
    ring.visible = tail.visible = line.visible = on;
    if (!on) continue;
    const m = muzzles[i];
    ring.position.set(m.x, m.y, m.z);
    ring.scale.setScalar(reach);
    tail.position.set(m.x + s.dirX * sweep, m.y + s.dirY * sweep, m.z);
    tail.scale.setScalar(reach);
    line.position.set(m.x, m.y, m.z);
    line.rotation.z = Math.atan2(s.dirY, s.dirX);
    line.scale.setScalar(sweep);
  }
  // The last connect, held until the next window opens: a flash you have to
  // catch is no use for tuning a reach.
  const hit = s.last;
  d.mark.visible = !!hit;
  if (hit) {
    d.mark.position.set(hit.x, hit.y, 0);
    d.mark.scale.setScalar(reach * 0.45);
  }
}
