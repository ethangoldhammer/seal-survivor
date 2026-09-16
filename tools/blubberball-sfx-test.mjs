#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:blubbersfx
//
// THE BLUBBERBALL SOUND BANK — every moment a match makes, and the route from
// each one to something that can actually make a noise.
//
// Every failure this catches is SILENT, which is the only reason it is worth a
// harness. playSfx returns quietly for a name it does not know (see the note
// on it), so an event whose voice was never written is not an error — it is a
// block, a save or a whole match ending in silence, and nothing anywhere says
// so. feedback() DOES warn about an unknown event, but only when one is
// actually fired, and the events here fire in situations a playtest reaches
// once every few minutes.
//
// So the whole bank is walked as a graph: the section in the workbench's rail
// -> the event in CONFIG.feedback -> the voice in CONFIG.sfx -> a `type` that
// synthesises something. And then the other way, which is the half a list of
// names cannot check: the new moments are DRIVEN in a real match — a body put
// in front of a real shot, a ball that wins the contest, a shot cleared off
// the line, a seal out of air, the fifth goal — and the events they fire are
// counted off a feedback listener. A row that names a voice nobody fires is a
// row that lies just as loudly as a voice nobody wrote.
//
// It also reports the SHARED voices and the shake guest list, neither of which
// is a failure: two events on one voice is sometimes deliberate (the ball's
// two crossings of the surface are the seal's own, pitched) and the shake mute
// is a taste decision — but both are decisions somebody has to be able to see.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enableVersus } from '../path/src/systems/versusFlag.js';
import { bounds, updateBounds, midWater } from '../path/src/arena.js';
import { player, initPlayer, resetPlayer } from '../path/src/entities/player.js';
import { resetStrike, strikeState } from '../path/src/systems/strike.js';
import { initParticles } from '../path/src/entities/particles.js';
import { onFeedback } from '../path/src/systems/feedback.js';
import {
  versusState, ball, startVersus, resetVersus, updateVersus, updateVersusClock,
  resetBall, sealAt, sealPos, matchSeals, seatOf, sealContact, bodyCheck,
  versusOutOfAir, solveBallSurface, ballContactReach, rematch,
} from '../path/src/systems/versus.js';
import { sealHeading } from '../path/src/systems/ballShape.js';
import { rockX, mouthY, goalLineX } from '../path/src/systems/versusGoal.js';
import { teamOfSeat } from '../path/src/systems/sealRoster.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;
// Seeded: bait balls and bubble births draw on it, and an unseeded harness
// answers differently every run.
let seed = 0xb100dba1;
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

// THE SECTION, read out of the workbench rather than retyped. A list of names
// in this file would pass while the panel showed something else entirely —
// which is the exact failure this is here to catch, one layer up.
const railSrc = await import('node:fs').then((fs) => fs.promises.readFile('path/src/ui/workbench.js', 'utf8'));
const railBlock = railSrc.slice(railSrc.indexOf("['Blubberball', ["));
const BANK = [...railBlock.slice(0, railBlock.indexOf(']]')).matchAll(/'([A-Za-z]+)'/g)]
  .map((m) => m[1]).filter((id) => id !== 'Blubberball');

// Every feedback event fired, by name.
const fired = new Map();
onFeedback((name) => fired.set(name, (fired.get(name) ?? 0) + 1));
const count = (name) => fired.get(name) ?? 0;
const seen = (name) => count(name) > 0;

function frame(pads = noPads, raw = dt) {
  const scale = updateVersusClock(raw, pads);
  updateVersus(raw * scale, pads);
  return scale;
}
function settle(seconds) { for (let t = 0; t < seconds; t += dt) frame(); }
function toPlay(limit = 14) {
  for (let t = 0; t < limit && versusState.phase !== 'play'; t += dt) frame();
  return versusState.phase === 'play';
}
function parkSeals(y = midWater() - 16) {
  for (const seal of matchSeals()) {
    const seat = seatOf(seal);
    sealPos(seal).set(bounds.left + 8 + seat * 5, y, 0);
    seal.velocity.set(0, 0);
  }
}

// ---------------------------------------------------------------------------
section('The section is the match: every moment in it, in the order one goes');
{
  check('the rail has a Blubberball section', BANK.length > 0, `${BANK.length} row(s)`);
  note(BANK.join(' '));
  const missing = BANK.filter((id) => !CONFIG.feedback[id]);
  check('every row in it is a real feedback event', missing.length === 0, missing.join(', '));
  // ...and nothing a match fires is filed anywhere else. Read off CONFIG
  // rather than listed here: an event added to the table and forgotten in the
  // rail has no UI at all, which is how half of these came to be missing.
  const strays = Object.keys(CONFIG.feedback)
    .filter((id) => /^versus/.test(id) || id === 'bodyCheck' || id === 'sealBurst')
    .filter((id) => !BANK.includes(id));
  check('...and no match event is filed outside it', strays.length === 0, strays.join(', '));
  // The pairs, adjacent, because the second of each is judged over the first.
  const adjacent = (a, b) => BANK.indexOf(b) === BANK.indexOf(a) + 1;
  check('the block and the save it layers over are neighbours', adjacent('versusBlock', 'versusSave'));
  check('the goal and its cheer are neighbours', adjacent('versusGoal', 'versusGoalCheer'));
  check('the win and the lose are neighbours', adjacent('versusWin', 'versusLose'));
}

// ---------------------------------------------------------------------------
section('Every moment reaches something that can make a noise');
{
  const TONE = new Set(['blip', 'boom', 'noise']);
  const bad = [];
  for (const id of BANK) {
    const def = CONFIG.feedback[id];
    const voice = def?.sfx;
    const v = voice ? CONFIG.sfx[voice] : null;
    if (!voice) { bad.push(`${id}: names no voice`); continue; }
    if (!v) { bad.push(`${id}: voice "${voice}" is not in CONFIG.sfx`); continue; }
    // A voice is either a synthesised type or a file (or both). `src` set with
    // no type is a sample voice and legitimate.
    const canSpeak = TONE.has(v.type) || !!v.src || (Array.isArray(v.srcs) && v.srcs.length > 0);
    if (!canSpeak) bad.push(`${id}: voice "${voice}" has type "${v.type}" and no file`);
  }
  check('event -> voice -> a sound, for all of them', bad.length === 0, bad.join('; '));

  // The seven new ones, named, because "all of them" passing is also what it
  // looks like when the loop above is walking an empty list.
  for (const id of ['versusBlock', 'versusSave', 'versusPierce', 'sealBurst', 'versusRespawn', 'versusWin', 'versusLose']) {
    const v = CONFIG.sfx[CONFIG.feedback[id]?.sfx];
    check(`${id} has a voice of its own`, !!v, CONFIG.feedback[id]?.sfx ?? 'none');
  }
  check('the burst is off the body check\'s voice', CONFIG.feedback.sealBurst.sfx !== CONFIG.feedback.bodyCheck.sfx,
    `${CONFIG.feedback.sealBurst.sfx} vs ${CONFIG.feedback.bodyCheck.sfx}`);
  check('...and the respawn is off the pickup\'s', CONFIG.feedback.versusRespawn.sfx !== 'bubblePop',
    CONFIG.feedback.versusRespawn.sfx);

  // SHARED VOICES, reported rather than failed: two of these are deliberate.
  const byVoice = new Map();
  for (const id of BANK) {
    const v = CONFIG.feedback[id]?.sfx;
    if (!v) continue;
    byVoice.set(v, [...(byVoice.get(v) ?? []), id]);
  }
  const shared = [...byVoice].filter(([, ids]) => ids.length > 1);
  note(shared.length
    ? `shared voices: ${shared.map(([v, ids]) => `${v} <- ${ids.join(' + ')}`).join('; ')}`
    : 'no two events in the match share a voice');
  // The two crossings borrow the seal's own breach/reentry ON PURPOSE — see
  // the note in CONFIG.feedback. Everything else in the bank is its own.
  const borrowed = BANK.filter((id) => {
    const v = CONFIG.feedback[id]?.sfx;
    return v && !BANK.includes(v) && !/^versus|^bodyCheck$/.test(v);
  });
  check('nothing borrows a voice from outside the match but the two crossings',
    borrowed.every((id) => id === 'versusBallBreach' || id === 'versusBallReentry'), borrowed.join(', '));
}

// ---------------------------------------------------------------------------
section('The camera: what a match is allowed to move it with');
{
  const only = CONFIG.fx.shakeOnly ?? [];
  const withShake = BANK.filter((id) => (CONFIG.feedback[id].shake ?? 0) > 0);
  const live = withShake.filter((id) => only.includes(id));
  // NOT A FAILURE. An empty guest list means everything shakes, and a name
  // absent from a non-empty one is a deliberate mute — but "no moment in a
  // whole game mode may move the camera" is a decision that should be looked
  // at rather than discovered.
  check('the guest list is a list, so the mute is deliberate rather than empty', Array.isArray(only));
  note(only.length === 0
    ? 'the guest list is empty: every match event shakes'
    : `${live.length} of ${withShake.length} match events with a shake are on CONFIG.fx.shakeOnly`);
  if (only.length && !live.length) note('  -> every `shake` in the Blubberball block is authored and muted');
}

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION: drive the moments and count what came out.
// ---------------------------------------------------------------------------
enableVersus(true);
updateBounds(16 / 9);
initPlayer(scene);
initParticles(scene);
resetPlayer();
resetStrike();
V.replay.enabled = false;   // the shutter's replay is versus-test's business
startVersus(scene);
toPlay();

// ---------------------------------------------------------------------------
section('A body in the way is a block; a body beaten is a pierce');
{
  parkSeals();
  const me = sealAt(0);
  const F = V.ball.fx;
  // THE SEAL SWIMS INTO IT, and that is not a convenience of the harness — it
  // is what a block IS here. The contest is the ball's speed against the
  // seal's (contestMargin), so a seal treading water loses to any moving ball
  // and is run through; holding a shot means having swum at it at least as
  // fast as it was coming. `speed` is therefore both the ball's and the
  // seal's — a dead heat, which the seal takes.
  //
  // The nose has to point at it too: the contact is the seal's BODY, a
  // capsule down the spine, so a seal left at rotation 0 is nose-UP (the
  // art's forward is +Y) and the ball meets its flank.
  const arrive = (speed) => {
    fired.clear();
    versusState.lastBlock = null;
    resetBall();
    me.mesh.position.set(0, midWater(), 0);
    me.velocity.set(speed, 0);
    me.mesh.rotation.z = Math.atan2(0, speed) - Math.PI / 2;
    solveBallSurface();
    // Half a unit inside the drawn edge: exactly ON it is not a contact.
    ball.x = ballContactReach(0) - 0.5;
    ball.y = midWater();
    ball.vx = -speed;
    ball.vy = 0;
    ball.dashHit[0] = false;
    ball.pierced[0] = false;
    return sealContact(0, me.mesh.position, me.velocity, false, null, 0, 0, sealHeading(me));
  };

  check('the contact lands at all', arrive(F.blockMin + 6));
  check('a shot held by a body swimming into it fires a block', seen('versusBlock'), `${count('versusBlock')}`);
  check('...over the slap, not instead of it', seen('versusBallHit'), `${count('versusBallHit')}`);
  check('...and it is booked for the harness', versusState.lastBlock?.who === 0, JSON.stringify(versusState.lastBlock));
  check('...and the seal held: this is not a pierce', !seen('versusPierce'), `${count('versusPierce')}`);
  const soft = versusState.lastBlock.t;

  arrive(Math.max(1, F.blockMin - 6));
  check('a ball being shepherded is not a block', !seen('versusBlock'), `${count('versusBlock')}`);

  arrive(F.blockRef);
  check('a harder shot is a bigger block', versusState.lastBlock.t > soft, `${versusState.lastBlock.t.toFixed(2)} vs ${soft.toFixed(2)}`);
  check('...topping out at 1 and no more', versusState.lastBlock.t <= 1 + 1e-9, `${versusState.lastBlock.t}`);
  check('...on a top end a seal can actually reach', F.blockRef <= CONFIG.player.maxSpeed,
    `blockRef ${F.blockRef} vs a seal's ${CONFIG.player.maxSpeed} u/s top speed`);

  // THE CONTEST THE OTHER WAY: a seal that is not swimming at it loses to
  // anything moving, which is the pierce.
  fired.clear();
  resetBall();
  me.mesh.position.set(0, midWater(), 0);
  me.velocity.set(0, 0);
  me.mesh.rotation.z = -Math.PI / 2;
  solveBallSurface();
  ball.x = ballContactReach(0) - 0.5;
  ball.y = midWater();
  ball.vx = -(V.ball.maxSpeed ?? 64);
  ball.vy = 0;
  ball.dashHit[0] = false;
  ball.pierced[0] = false;
  sealContact(0, me.mesh.position, me.velocity, false, null, 0, 0, sealHeading(me));
  check('a ball the seal cannot hold goes through it', !!versusState.lastPierce, JSON.stringify(versusState.lastPierce));
  check('...and that fires a pierce, not a block', seen('versusPierce') && !seen('versusBlock'),
    `pierce ${count('versusPierce')}, block ${count('versusBlock')}`);
}

// ---------------------------------------------------------------------------
section('A shot cleared off the line is a save');
{
  toPlay();
  parkSeals();
  const R = V.reel.save;
  fired.clear();
  // P1 defends the LEFT mouth, so a ball driving left at mouth height inside
  // `zone` of that wall is on target for its own goal.
  resetBall();
  ball.x = rockX(-1) + (R.zone ?? 34) * 0.5;
  ball.y = mouthY();
  ball.vx = -(R.speed ?? 20) - 22;
  ball.vy = 0;
  settle(0.15);
  check('nothing fires while the shot is merely on its way', !seen('versusSave'));
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  ball.vx = 36;
  settle(0.1);
  check('a defender clearing it fires a save', seen('versusSave'), `${count('versusSave')}`);
  check('...booked to the seal and the mouth', versusState.lastSave?.who === 0 && versusState.lastSave?.side === -1,
    JSON.stringify(versusState.lastSave));
  check('...and its scale rides the shot it stopped', versusState.lastSave.peak > (R.speed ?? 20),
    `peak ${versusState.lastSave.peak.toFixed(1)} u/s`);

  // The negative, because a save that fires on everything is not a save.
  fired.clear();
  toPlay();
  parkSeals();
  resetBall();
  ball.x = 0;
  ball.y = midWater();
  ball.vx = -30;
  settle(0.15);
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  ball.vx = 30;
  settle(0.1);
  check('a touch in midfield is not a save', !seen('versusSave'), `${count('versusSave')}`);
}

// ---------------------------------------------------------------------------
section('The shove, the burst and the seal coming back');
{
  toPlay();
  parkSeals();
  fired.clear();
  const me = sealAt(0);
  const them = sealAt(1);
  me.mesh.position.set(0, midWater(), 0);
  sealPos(them).set(2.0, midWater(), 0);
  me.velocity.set(34, 0);
  them.velocity.set(0, 0);
  strikeState.active = true;
  strikeState.power = 1;
  versusState.checked.fill(false);
  bodyCheck();
  strikeState.active = false;
  strikeState.power = 0;
  check('a dash into another seal fires the check', seen('bodyCheck'), `${count('bodyCheck')}`);

  fired.clear();
  versusOutOfAir(1);
  check('a seal out of air bursts', seen('sealBurst'), `${count('sealBurst')}`);
  check('...on its own voice, not the check\'s', !seen('bodyCheck'));
  // ...and back in the water on the respawn clock.
  fired.clear();
  settle((V.respawn?.delay ?? 1) + 0.3);
  check('and comes back on its own sound', seen('versusRespawn'), `${count('versusRespawn')}`);
  check('...not on the bubble pickup\'s', !seen('bubblePop'), `${count('bubblePop')}`);
}

// ---------------------------------------------------------------------------
section('One result, heard two ways');
{
  toPlay();
  parkSeals();
  fired.clear();
  versusState.scores[0] = (V.toWin ?? 5) - 1;
  versusState.scores[1] = 1;
  resetBall();
  ball.x = bounds.right - 14;
  ball.y = mouthY();
  ball.vx = 40;
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  for (let n = 0; n < 400 && versusState.phase === 'play'; n++) frame();
  check('the match is won', versusState.phase === 'won', versusState.phase);
  check('the goal still fires its bang and its cheer', seen('versusGoal') && seen('versusGoalCheer'));
  check('a win is heard', seen('versusWin'), `${count('versusWin')}`);
  check('...and a loss with it, on the same frame', seen('versusLose'), `${count('versusLose')}`);
  // ONE PER SEAT, not one per match: a side is a side, and every seal in the
  // water hears which end of the result it is on.
  const perSide = matchSeals().filter((s) => teamOfSeat(seatOf(s)) === 0).length;
  check('one per seal, on the winning side', count('versusWin') === perSide, `${count('versusWin')} for ${perSide} seat(s)`);
  check('...and one per seal on the other', count('versusLose') === matchSeals().length - perSide,
    `${count('versusLose')} for ${matchSeals().length - perSide} seat(s)`);
  // A goal that does not end the match must stay silent about it. THE PROMPT
  // FIRST: a won match sits in `over` until somebody answers it, so a plain
  // toPlay() here would spin out its whole budget and then measure a phase
  // that never moved.
  rematch();
  fired.clear();
  toPlay();
  parkSeals();
  versusState.scores[0] = 0;
  versusState.scores[1] = 0;
  resetBall();
  ball.x = bounds.right - 14;
  ball.y = mouthY();
  ball.vx = 40;
  versusState.lastTouch = { t: versusState.clock, who: 0, kind: 'strike', x: ball.x, y: ball.y };
  for (let n = 0; n < 400 && versusState.phase === 'play'; n++) frame();
  check('an ordinary goal ends nothing', versusState.phase === 'scored' && !seen('versusWin') && !seen('versusLose'),
    `${versusState.phase}, win ${count('versusWin')}, lose ${count('versusLose')}`);
}

resetVersus();
enableVersus(false);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
