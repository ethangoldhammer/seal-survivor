#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:reel
//
// THE HIGHLIGHT REEL — systems/versusReel.js and the playback in versus.js,
// driven headless. A Browser pane cannot film any of this (rAF is suspended
// there) and a real tab on a dev server writes the tuning file, so this is
// the check.
//
// What it is actually about is the ONE THING the reel is for and the instant
// replay is not: OUTLIVING THE RING. The recorder is `replay.buffer` seconds
// deep and reuses its frame objects, so the whole feature turns on the
// archive holding COPIES — a clip taken from the first goal of a match has to
// still be that goal three minutes later, after the ring has rolled over it
// twenty times. Every other assertion here is downstream of that one.
//
// The rest: a save and a body check are NOTICED rather than announced (the
// physics has no event for either), so each is measured against its own
// negative — the same touch by the wrong side, the same shot off target, the
// same shove under the threshold. Then the playlist's shape, the beats each
// kind of clip runs, and the two things a reel does that a replay never had
// to: play a goal that is not the match's LAST goal, and go round again.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { resetStrike, strikeState } from '../path/src/systems/strike.js';
import { initParticles } from '../path/src/entities/particles.js';
import {
  versusState, ball, p2, startVersus, resetVersus, updateVersus, updateVersusClock,
  resetBall, replayState, startReel, stopReel, rematch, sealAt, sealPos, kickoffSpot,
  matchSeals, seatOf, bodyCheck,
} from '../path/src/systems/versus.js';
import { reelState, resetReel, requestClip, harvestClips, buildPlaylist, nextClip } from '../path/src/systems/versusReel.js';
import { poolState } from '../path/src/systems/replayCams.js';
import { goalLineX, mouthY, rockX } from '../path/src/systems/versusGoal.js';
import { teamOfSeat } from '../path/src/systems/sealRoster.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
// Seeded: bait balls and bubble births draw on it, and an unseeded harness
// answers differently every run.
let seed = 0xb10bba11;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const realWarn = console.warn;
console.warn = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[animation]') || msg.startsWith('[assets]') || msg.startsWith('[uiText]'))) return;
  realWarn(msg, ...rest);
};
console.info = () => {};

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function note(text) { console.log(`        ${text}`); }

const V = CONFIG.versus;
V.bot.enabled = false;
const noPads = [];

function frame(pads = noPads, raw = dt) {
  const scale = updateVersusClock(raw, pads);
  updateVersus(raw * scale, pads);
  return scale;
}
function settle(seconds, pads = noPads) { for (let t = 0; t < seconds; t += dt) frame(pads); }
function toPlay(limit = 14) {
  for (let t = 0; t < limit && versusState.phase !== 'play'; t += dt) frame();
  return versusState.phase === 'play';
}
/** Park every seal somewhere harmless so nothing wanders into a staged shot. */
function parkSeals(y = midWater() - 14) {
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    sealPos(seal).set(bounds.left + 6 + seat * 4, y, 0);
    seal.velocity.set(0, 0);
  }
}

enableVersus(true);
updateBounds(16 / 9);
initPlayer(scene);
initParticles(scene);
resetPlayer();
resetStrike();

// ---------------------------------------------------------------------------
section('The archive outlives the ring it was copied out of');
{
  V.replay.enabled = false;   // the shutter's own replay is not what is under test here
  startVersus(scene);
  toPlay();
  parkSeals();
  // A shot into the right mouth, from a seal that touched it: a goal with a
  // touch behind it, which is what a clip is opened on.
  settle(1.5);              // ...so the ring has a lead-up to give the clip
  resetBall();
  ball.x = bounds.right - 30;
  ball.y = midWater();
  ball.vx = 40;
  // THE TOUCH the goal is credited to. Staged rather than swum: a seal driven
  // into the ball for a scripted contact is the strike test's business
  // (tools/versus-test.mjs), and what the archive reads is the ledger this
  // line is the shape of — see noteTouch.
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  let n = 0;
  while (versusState.phase === 'play' && n < 400) { frame(); n++; }
  check('the ball went in', versusState.phase === 'scored', versusState.phase);
  check('...and the goal filed a clip', reelState.clips.length + reelState.pending.length >= 1,
    `${reelState.clips.length} held, ${reelState.pending.length} pending`);
  settle(0.1);
  const clip = reelState.clips[0];
  check('the clip was harvested with real footage', !!clip?.frames && clip.frames.length >= (V.reel.minFrames ?? 8),
    `${clip?.frames?.length ?? 0} frame(s)`);
  const firstT = clip.frames[0].t;
  const firstBx = clip.frames[0].bx;
  const lastBx = clip.frames[clip.frames.length - 1].bx;
  note(`clip spans ${clip.fromT.toFixed(2)}–${clip.toT.toFixed(2)}s, ball ${firstBx.toFixed(1)} → ${lastBx.toFixed(1)}`);
  check('...and the footage MOVES: it is a span, not a still', Math.abs(lastBx - firstBx) > 5,
    `${firstBx.toFixed(1)} → ${lastBx.toFixed(1)}`);

  // NOW ROLL THE RING RIGHT OVER IT. More than `replay.buffer` seconds of
  // play, which is exactly what a full match does between its first goal and
  // its last, and is what the instant replay's own buffer cannot survive.
  toPlay();
  parkSeals();
  const buffer = V.replay.buffer ?? 8;
  settle(buffer + 3);
  check('the ring has been round twice over', versusState.clock > clip.toT + buffer,
    `clock ${versusState.clock.toFixed(1)}s vs clip end ${clip.toT.toFixed(1)}s`);
  check('the clip still holds its own first frame, to the second', Math.abs(clip.frames[0].t - firstT) < 1e-9,
    `${clip.frames[0].t.toFixed(3)} vs ${firstT.toFixed(3)}`);
  check('...and its own ball position, untouched', Math.abs(clip.frames[0].bx - firstBx) < 1e-9,
    `${clip.frames[0].bx.toFixed(3)} vs ${firstBx.toFixed(3)}`);
  check('...and its rim is its own buffer, not the recorder\'s', clip.frames[0].rim !== clip.frames[1].rim);
}

// ---------------------------------------------------------------------------
section('A save is the ball on target and a defender getting to it');
{
  resetReel();
  toPlay();
  parkSeals();
  const R = V.reel.save;
  // P1 defends the LEFT goal (teamOfSeat 0 === 0), so a ball driving left at
  // mouth height inside `zone` of that wall is on target for P1's own goal.
  const openDanger = () => {
    resetBall();
    ball.x = rockX(-1) + (R.zone ?? 34) * 0.5;
    ball.y = mouthY();
    ball.vx = -(R.speed ?? 20) - 18;
    ball.vy = 0;
  };

  // (a) the defender gets to it.
  openDanger();
  settle(0.12);              // a few frames of danger, so the watch opens
  const dangerFrames = reelState.pending.length;
  // The defender's touch, staged the way a contact leaves the ledger.
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  ball.vx = 34;              // ...and the ball is going the other way now
  settle(0.1);
  check('a defender clearing an on-target shot files a save',
    reelState.pending.some((c) => c.kind === 'save') || reelState.clips.some((c) => c.kind === 'save'),
    `${reelState.pending.length} pending, ${reelState.clips.length} held`);
  check('...and nothing was filed while the danger was merely open', dangerFrames === 0, `${dangerFrames} pending mid-danger`);
  const save = [...reelState.pending, ...reelState.clips].find((c) => c.kind === 'save');
  check('...credited to the seal that touched it', save?.who === 0, `who ${save?.who}`);
  check('...and to the mouth it was heading for', save?.side === -1, `side ${save?.side}`);

  // (b) the ATTACKER taking its own shot off target is a miss, not a save.
  resetReel();
  toPlay();
  parkSeals();
  openDanger();
  settle(0.12);
  versusState.lastTouch = { t: versusState.clock, who: 1, kind: 'strike', x: ball.x, y: ball.y };
  ball.vx = 34;
  settle(0.1);
  check('the attacking side taking its own shot off target is not a save',
    ![...reelState.pending, ...reelState.clips].some((c) => c.kind === 'save'));

  // (c) a shot that was never on target.
  resetReel();
  toPlay();
  parkSeals();
  resetBall();
  ball.x = rockX(-1) + (R.zone ?? 34) * 0.5;
  ball.y = mouthY();
  ball.vx = -(R.speed ?? 20) - 18;
  ball.vy = 90;              // climbing hard: it crosses the line nowhere near the mouth
  settle(0.12);
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  ball.vx = 34;
  settle(0.1);
  check('a shot that would have missed the mouth is not a save',
    ![...reelState.pending, ...reelState.clips].some((c) => c.kind === 'save'));

  // (d) a ball crawling goalward is not a shot.
  resetReel();
  toPlay();
  parkSeals();
  resetBall();
  ball.x = rockX(-1) + (R.zone ?? 34) * 0.5;
  ball.y = mouthY();
  ball.vx = -((R.speed ?? 20) - 6);
  settle(0.12);
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  ball.vx = 34;
  settle(0.1);
  check('a ball drifting goalward under `speed` is not a save',
    ![...reelState.pending, ...reelState.clips].some((c) => c.kind === 'save'));
}

// ---------------------------------------------------------------------------
section('A body check files itself, and only when it is a ram');
{
  resetReel();
  toPlay();
  parkSeals();
  const R = V.reel.check;
  const me = sealAt(0);
  const them = sealAt(1);
  const ram = (speed) => {
    resetReel();
    me.mesh.position.set(0, midWater(), 0);
    sealPos(them).set(2.0, midWater(), 0);
    me.velocity.set(speed, 0);
    them.velocity.set(0, 0);
    strikeState.active = true;
    strikeState.power = speed > 20 ? 1 : 0;
    versusState.checked.fill(false);
    versusState.lastCheck = null;
    bodyCheck();
    strikeState.active = false;
    strikeState.power = 0;
    return versusState.lastCheck?.push ?? 0;
  };
  const hard = ram(34);
  check('a full-power ram lands a shove over the threshold', hard >= (R.push ?? 34), `shove ${hard.toFixed(1)} vs ${R.push}`);
  check('...and files itself with the archive', reelState.pending.some((c) => c.kind === 'check'),
    `${reelState.pending.length} pending`);
  const filed = reelState.pending.find((c) => c.kind === 'check');
  check('...credited to the seal that threw it', filed?.who === 0, `who ${filed?.who}`);
  check('...and naming the one it landed on, for the frame', filed?.victim === 1, `victim ${filed?.victim}`);
  check('...ranked by how big the shove was', filed && filed.strength > 0 && filed.strength <= 1, `${filed?.strength?.toFixed(2)}`);
  // ...and a brush is not a highlight. The shove floor is bodyCheck.knock, so
  // this asks the archive rather than the physics: a landed check under
  // `push` is a real check and not a clip.
  const soft = ram(1);
  check('a brush still lands as a check', soft > 0, `shove ${soft.toFixed(1)}`);
  check('...and does not go in the reel', soft >= (R.push ?? 34) || !reelState.pending.some((c) => c.kind === 'check'),
    `shove ${soft.toFixed(1)} vs ${R.push}`);
}

// ---------------------------------------------------------------------------
section('One clip per moment, and the biggest one wins');
{
  resetReel();
  const gap = V.reel.minGap ?? 1.2;
  requestClip('check', { at: 10, fromT: 9, toT: 11, who: 0, strength: 0.2 });
  requestClip('check', { at: 10 + gap * 0.4, fromT: 9.5, toT: 11.5, who: 1, strength: 0.9 });
  check('a second check inside minGap replaces rather than adds', reelState.pending.length === 1, `${reelState.pending.length}`);
  check('...and what survives is the bigger shove', reelState.pending[0].who === 1, `who ${reelState.pending[0].who}`);
  requestClip('check', { at: 10 + gap * 0.4, fromT: 9.5, toT: 11.5, who: 0, strength: 0.1 });
  check('...and a smaller one after it does not displace it', reelState.pending[0].who === 1);
  requestClip('check', { at: 10 + gap * 2, fromT: 11, toT: 13, who: 0, strength: 0.5 });
  check('a check well clear of it is its own clip', reelState.pending.length === 2, `${reelState.pending.length}`);
  // A goal and a check at the same instant are two different moments.
  requestClip('goal', { at: 10, fromT: 9, toT: 11, who: 0, strength: 0.5, goal: { t: 11, side: 'left', scorer: 1, x: 0, y: 0 } });
  check('a goal at the same second as a check is not folded into it', reelState.pending.length === 3, `${reelState.pending.length}`);
}

// ---------------------------------------------------------------------------
section('A clip too short to be a clip is dropped, not played');
{
  resetReel();
  requestClip('check', { at: 5, fromT: 4, toT: 6, who: 0, strength: 0.5 });
  const stub = () => ({ frames: [{ t: 4 }, { t: 6 }], events: [] });
  harvestClips(7, stub);
  check('two frames is a still and does not enter the archive', reelState.clips.length === 0, `${reelState.clips.length}`);
  check('...and it is counted as dropped', reelState.dropped === 1, `${reelState.dropped}`);
}

// ---------------------------------------------------------------------------
section('The playlist is the match\'s own order, capped, and always about a goal');
{
  resetReel();
  const fake = (kind, at, strength, extra = {}) => {
    requestClip(kind, { at, fromT: at - 1, toT: at + 1, who: 0, strength, ...extra });
    harvestClips(at + 1, (a, b) => ({
      frames: Array.from({ length: 20 }, (_, i) => ({ t: a + (b - a) * (i / 19), bx: i })),
      events: [],
    }));
  };
  // Out of order on purpose: the archive sorts, the playlist does not have to.
  fake('check', 30, 0.9);
  fake('goal', 10, 0.1, { goal: { t: 11, side: 'left', scorer: 1, x: 0, y: 0 } });
  fake('save', 20, 0.9);
  fake('goal', 40, 0.1, { goal: { t: 41, side: 'right', scorer: 0, x: 0, y: 0 } });
  const order = buildPlaylist();
  check('every clip is in the reel while there is room', order.length === 4, `${order.length}`);
  check('...in match order, opener first', order.map((c) => c.at).join(',') === '10,20,30,40', order.map((c) => c.at).join(','));
  check('...so the reel ends on the goal that won it', order[order.length - 1].kind === 'goal' && order[order.length - 1].at === 40);

  // Now more highlights than the reel has room for.
  const max = V.reel.maxClips;
  resetReel();
  for (let i = 0; i < max + 4; i++) fake('check', 5 + i * 3, 0.9);
  fake('goal', 5 + (max + 4) * 3, 0, { goal: { t: 1, side: 'left', scorer: 1, x: 0, y: 0 } });
  const capped = buildPlaylist();
  check('the reel is capped at maxClips', capped.length === max, `${capped.length} of ${max}`);
  check('...and the last goal survives the cut whatever it weighs',
    capped.some((c) => c.kind === 'goal'), capped.map((c) => c.kind).join(','));
  check('...still in match order', capped.every((c, i) => i === 0 || c.at >= capped[i - 1].at));
  const weakest = Math.min(...capped.filter((c) => c.kind === 'check').map((c) => c.weight));
  check('...and a goal outranks the strongest check by design', V.reel.goal.weight > V.reel.check.weight + V.reel.check.spread,
    `goal floor ${V.reel.goal.weight} vs check ceiling ${V.reel.check.weight + V.reel.check.spread} (kept weakest ${weakest.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
section('The reel plays under the prompt, and goes round again');
{
  // A match that ends, with three clips of three kinds in the archive — the
  // second goal is NOT the match's last, which is the case that used to blow
  // out the wrong mouth.
  resetReel();
  toPlay();
  parkSeals();
  // Far enough back that every clip's own tail is already behind the clock —
  // a clip is not harvested until the recorder has passed its last second.
  settle(6);
  const mk = (kind, at, extra) => {
    requestClip(kind, { at, fromT: at - 0.8, toT: at + 0.8, who: kind === 'goal' ? 0 : 1, side: -1, x: 0, y: midWater(), strength: 0.6, ...extra });
    harvestClips(versusState.clock, (f, t) => {
      // The recorder's own frames for that window, copied the way versus.js
      // copies them — this is the archive's contract, not its implementation.
      const out = [];
      for (let i = 0; i < 24; i++) {
        const tt = f + (t - f) * (i / 23);
        out.push({ t: tt, bx: i * 0.5, by: midWater(), bvx: 10, bvy: 0, bang: 0, bspin: 0, rim: new Float32Array(64), seals: Array.from({ length: 16 }, () => ({ x: 0, y: midWater(), rz: 0, q: new THREE.Quaternion(), vis: true })) });
      }
      return { frames: out, events: [] };
    });
  };
  const t0 = versusState.clock - 4.8;
  mk('goal', t0, { goal: { t: t0 + 0.8, side: 'left', scorer: 1, x: bounds.left, y: midWater() } });
  mk('check', t0 + 1.0);
  mk('save', t0 + 2.0);
  mk('goal', t0 + 3.0, { goal: { t: t0 + 3.8, side: 'right', scorer: 0, x: bounds.right, y: midWater() } });
  check('four clips in the archive', reelState.clips.length === 4, `${reelState.clips.length}`);

  const started = startReel();
  check('the reel starts', started && reelState.playing);
  check('...and it is a replay as far as the rest of the game is concerned', replayState.active);
  check('...opening on the FIRST clip, the earliest moment', replayState.clip === reelState.order[0]);
  check('...and that clip carries its own goal, not the match\'s last',
    replayState.goal === reelState.order[0].goal && replayState.goal?.scorer === 1,
    `scorer ${replayState.goal?.scorer}, match last ${versusState.lastGoal?.scorer}`);
  check('...on the mouth that goal went into', replayState.side === -1, `side ${replayState.side}`);
  check('...and the director is choosing', poolState.active);

  // Drive the whole thing on the wall clock, the way updateVersusClock does
  // in the `over` phase, and watch it walk the playlist.
  versusState.phase = 'over';
  versusState.phaseT = 0;
  const seenKinds = new Set();
  const seenBeats = new Set();
  const seenClips = new Set();
  let framesRun = 0;
  for (let t = 0; t < 60 && reelState.loops < 1; t += dt) {
    frame();
    framesRun++;
    if (replayState.active) {
      seenKinds.add(replayState.kind);
      seenBeats.add(`${replayState.kind}:${replayState.beat}`);
      if (replayState.clip) seenClips.add(replayState.clip);
    }
  }
  check('every clip in the playlist was played', seenClips.size === 4, `${seenClips.size} of 4`);
  check('...all three kinds among them', seenKinds.has('goal') && seenKinds.has('check') && seenKinds.has('save'), [...seenKinds].join(','));
  check('a goal clip runs all four beats', ['impact', 'wide', 'explosion', 'celebration'].every((b) => seenBeats.has(`goal:${b}`)),
    [...seenBeats].filter((b) => b.startsWith('goal:')).join(' '));
  check('a check clip runs its own second beat and nothing to blow up',
    seenBeats.has('check:impact') && seenBeats.has('check:check') && !seenBeats.has('check:explosion'),
    [...seenBeats].filter((b) => b.startsWith('check:')).join(' '));
  check('a save clip likewise — nothing explodes and nobody celebrates',
    seenBeats.has('save:impact') && seenBeats.has('save:save')
      && !seenBeats.has('save:explosion') && !seenBeats.has('save:celebration'),
    [...seenBeats].filter((b) => b.startsWith('save:')).join(' '));
  check('and the reel came round again rather than stopping', reelState.loops >= 1, `${reelState.loops} loop(s)`);
  check('...with footage still in it on the second lap', replayState.active && replayState.frames.length > 2,
    `${replayState.frames.length} frame(s)`);
  check('...the archive intact', reelState.clips.every((c) => c.frames.length > 2),
    reelState.clips.map((c) => c.frames.length).join(','));
  note(`${framesRun} frames — ${(framesRun * dt).toFixed(1)}s of wall clock — for one lap of four clips`);
}

// ---------------------------------------------------------------------------
section('Answering the prompt takes the world back');
{
  check('the reel is running before the answer', reelState.playing && replayState.active);
  rematch();
  check('the reel stops', !reelState.playing && !replayState.active);
  check('...and the archive is cleared: a rematch is a new match', reelState.clips.length === 0 && reelState.order.length === 0);
  check('...on a kickoff, from nothing', versusState.phase === 'kickoff' && versusState.scores.join('-') === '0-0', versusState.phase);
  // The seals must be on their spots and STAY there — a reel left posing them
  // would put them back in the middle of a clip on the next frame.
  const spot = kickoffSpot(0, {});
  frame();
  frame();
  check('...with the seals on their kickoff spots and staying there',
    Math.abs(player.mesh.position.x - spot.x) < 1.5, `x ${player.mesh.position.x.toFixed(2)} vs ${spot.x.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
section('The camera pool has angles for the new beats');
{
  const shots = V.replay.cams.shots ?? [];
  for (const beat of ['impact', 'wide', 'explosion', 'celebration', 'save', 'check']) {
    const n = shots.filter((s) => (s.beats ?? []).includes(beat)).length;
    check(`\`${beat}\` has a shot that may serve it`, n > 0, `${n} shot(s)`);
  }
  // The pool lives in config.js and a `shots` key in imported-tuning.json
  // REPLACES it wholesale (deepMerge does not merge arrays), so a snapshot
  // carrying its own copy makes every shot written above dead text.
  const raw = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile('path/src/imported-tuning.json', 'utf8')));
  check('...and no tuning snapshot is shadowing the pool',
    raw?.versus?.replay?.cams?.shots === undefined,
    'imported-tuning.json holds versus.replay.cams.shots');
}

resetVersus();
enableVersus(false);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
