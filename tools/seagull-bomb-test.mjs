#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:seagull
//
// THE RUN AS A SEQUENCE OF EVENTS — the four moments a seagull bomb announces
// itself at, and the two effects that are not instantaneous.
//
// `npm run test:abilities` owns the gull's targeting, its entrance and the
// ragdoll on the way down. This owns what the run SAYS: the cry above the shot,
// the stoop committing, the water being broken, the trail under it, and the
// bang followed by its own return off the seabed.
//
// Its own file because it is the only gull test that needs real particles.
// `initParticles` puts a Points object in the scene and every emit writes into
// its buffer, which is how the trail is counted here — and dropping that into
// the ability harness would put a particle system into two hundred other checks
// that have never had one.
//
// Nothing renders. The particle simulation lives entirely in the vertex shader,
// so the buffer is read back directly the way tools/reentry-splash-test.mjs
// does: `aStart` says when a particle was emitted and that is enough to count
// them and to say which frame they came from.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { initParticles, resetParticles } from '../path/src/entities/particles.js';
import {
  spawnSeagull, updateSeagulls, resetSeagulls, seagullCount, seagullEchoCount,
} from '../path/src/systems/seagull.js';

// The shipped ocean, not the placeholder literals `bounds` is declared with —
// nothing headless resizes a window, so without this the surface, the floor and
// the walls are all at numbers the game never uses. The trail's whole gate is
// "below the water line", so a bounds that never moved would be testing a
// different arena than the one the gull dives into.
updateBounds(CONFIG.arena.referenceAspect || 16 / 9);

// Seeded. spawnSeagull rolls a bearing, a depth and a skin, and emit() rolls a
// speed, a size and a life per particle — so two runs compared against each
// other would differ by the dice as much as by anything under test.
let seed = 0x5ea6011;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const reseed = () => { seed = 0x5ea6011; };

const scene = new THREE.Scene();
initParticles(scene);
const points = scene.children.find((c) => c.isPoints);
const aStart = points.geometry.attributes.aStart.array;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const C = CONFIG.seagullBomb;
const DT = 1 / 60;

const crabAt = (x, y) => {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  return { mesh, radius: 0.5, hp: 1e9, def: { behavior: 'crawl', radius: 0.5 }, type: 'crab' };
};

// How many particles are alive in the buffer. `aStart` is -1e9 on a free slot,
// so counting the ones that are not is counting what has been emitted and not
// yet recycled — which over a single short dive is everything the trail made.
function particleCount() {
  let n = 0;
  for (let i = 0; i < aStart.length; i++) if (aStart[i] > -1e8) n++;
  return n;
}

/**
 * Fly one bomb from the commit to the blast, collecting everything it said.
 *
 * Dropped straight into the dive rather than flown in from the entrance — the
 * approach has sixty runs of its own in `npm run test:abilities`, and what is
 * being measured here starts at the water line.
 */
function bomb({ dt = DT, from = C.cruiseAltitude, frames = 600, hooks = {} } = {}) {
  reseed();
  resetSeagulls(scene);
  resetParticles();
  const enemies = [crabAt(0, bounds.bottom + 2)];
  const g = spawnSeagull(scene, enemies);
  g.container.position.set(0, bounds.surfaceY + from, 0);
  g.phase = 'dive';

  const log = { splash: [], impact: [], echo: [], trail: [], t: 0, particlesAtSplash: 0 };
  let before = particleCount();
  for (let i = 0; i < frames; i++) {
    const had = particleCount();
    updateSeagulls(dt, scene, enemies, {
      onSplash: (x, y, at) => { log.splash.push({ t: log.t, x, y, ...at }); log.particlesAtSplash = particleCount(); },
      onImpact: (x, y, dmg, radius) => log.impact.push({ t: log.t, x, y, dmg, radius }),
      onBlastEcho: (x, y, scale) => log.echo.push({ t: log.t, x, y, scale }),
      ...hooks,
    });
    log.t += dt;
    const now = particleCount();
    if (now > had) log.trail.push({ t: log.t, n: now - had, y: g.container.position.y });
    // Stop a few frames after the echo so the drain can be checked.
    if (log.echo.length && i > 0 && log.impact.length) break;
  }
  log.particles = particleCount() - before;
  return { g, log, enemies };
}

// ===========================================================================
section('THE CUES');
// Four moments and five sounds. Every one of these is a name typed in one file
// and looked up in another: `feedback('seagullCry')` warns to the console and
// returns, and a `sfx` naming a row that does not exist is a sound that simply
// never plays. Both are silent in a build and neither is visible in a run.
const EVENTS = ['seagullCry', 'seagullDive', 'seagullSplash', 'seagullBlast', 'seagullBlastTail'];
for (const e of EVENTS) {
  const def = CONFIG.feedback[e];
  check(`${e} is a feedback event`, !!def);
  check(`...naming an sfx cue that exists`, !!def?.sfx && !!CONFIG.sfx[def.sfx],
    def?.sfx ? `${def.sfx}${CONFIG.sfx[def.sfx] ? '' : ' — MISSING'}` : 'no sfx');
}
// THE BIRD AND THE BOMB ARE SEPARATE FAMILIES, which is the request this was
// built from and is a thing a later edit could quietly undo by pointing two
// events at one cue to save a row.
const cueOf = (e) => CONFIG.feedback[e].sfx;
check('every moment has its own cue rather than sharing one',
  new Set(EVENTS.map(cueOf)).size === EVENTS.length,
  EVENTS.map(cueOf).join(', '));
check('...and the bird never borrows the seal\'s breach',
  !EVENTS.some((e) => cueOf(e) === 'breach'));
// STAGED FOR REAL TAKES. `srcs: []` is what lets a file dropped in the F menu's
// Sound tab take over from the synth (loadSampleFromFile appends into the same
// set), and a cue without it is one that can only ever be synthesised.
for (const e of EVENTS) {
  const def = CONFIG.sfx[cueOf(e)];
  check(`${cueOf(e)} is staged for takes`, Array.isArray(def.srcs),
    Array.isArray(def.srcs) ? `${def.srcs.length} take(s) so far` : 'no srcs array');
}

// ===========================================================================
section('BREAKING THE SURFACE');
{
  const { log } = bomb();
  check('a dive splashes exactly once', log.splash.length === 1, `${log.splash.length} splash(es)`);
  const s = log.splash[0];
  check('...at the water line', Math.abs(s.y - bounds.surfaceY) < 1e-6, `y ${s?.y}`);
  // The payload the splash is SIZED from. Without the speed the crown is the
  // same size whatever arrived, and without the body it is fired from a point —
  // both of which the seal's landing stopped doing when reentrySplash was
  // written, and neither of which the gull had until now.
  check('...carrying how hard it arrived', s.speed > 1, `${s.speed?.toFixed(1)} units/s`);
  check('...which is most of the stoop\'s top speed by then',
    s.speed > C.diveSpeedMax * 0.4, `${s.speed?.toFixed(1)} of ${C.diveSpeedMax}`);
  // MEASURED OFF THE POSED BIRD. In this harness no model loads, so the visual
  // is the primitive cone fallback and the extent is small but real — what is
  // being checked is that a shape was measured at all, not its size.
  check('...and the silhouette the water has to leave from',
    !!s.body && s.body.rx > 0 && s.body.ry > 0,
    s.body ? `rx ${s.body.rx.toFixed(2)} ry ${s.body.ry.toFixed(2)}` : 'no body');
}

// ===========================================================================
section('THE TRAIL');
{
  const { log } = bomb();
  check('a dive lays down a trail', log.trail.length > 8,
    `${log.trail.length} puffs, ${log.particles} particles`);
  // "SMALL BUT PLENTIFUL" IS NOT ASSERTED HERE, deliberately, and the first
  // draft of this file got that wrong twice over. It compared the emitter's
  // count and size against `wakeBubbles`, which is (a) a look, and every look
  // number in this game is on a slider, and (b) read through CONFIG, where a
  // saved tuning snapshot outranks the default — the shipped `wakeBubbles.count`
  // is 8 against the 2 written in config.js, so the check was reading a number
  // nobody had typed and would have broken the day the seal's wake was tuned.
  //
  // What IS asserted is the mechanism, which is not a matter of taste: the
  // bubbles rise, they pop at the surface rather than flying out of the sea,
  // and the trail is gated and paced correctly below.
  const em = CONFIG.emitters.gullBubbles;
  check('...that rise and pop at the surface rather than flying out of the sea',
    em.gravity[1] > 0 && !!em.surfacePop,
    `gravity ${em.gravity[1]}, pop '${em.surfacePop}'`);

  // NOT IN THE AIR. The gull commits from cruise altitude and is above the
  // water for the first half of its fall; a gate on `phase === 'dive'` alone
  // would trail bubbles through the sky the whole way down, which is the
  // obvious version of this and is wrong.
  const dry = log.trail.filter((p) => p.y > bounds.surfaceY);
  check('nothing is shed above the water line', dry.length === 0,
    `${dry.length} puff(s) in the air`);
}
{
  // ...NOR DURING THE CRUISE. A bird flying over the sea is in air and has
  // nothing to shed — and it spends most of a run below `cruiseAltitude` only
  // in the sense that the surface is below it, so a gate that forgot the phase
  // would trail the whole approach.
  reseed();
  resetSeagulls(scene);
  resetParticles();
  const enemies = [crabAt(0, bounds.bottom + 2)];
  const g = spawnSeagull(scene, enemies);
  // Parked UNDER the water line while still cruising, which is not a place a
  // gull goes — it is the one state that tells the two halves of the gate
  // apart, and a phase check that had been dropped shows up here and nowhere
  // else.
  //
  // HELD AWAY FROM THE PILE, which the first draft of this did not do: a gull
  // parked directly over its target is inside `diveZone` and commits on the
  // first update, so the phase was 'dive' by the time the trail was reached and
  // the check read 40 particles off a bird that was, correctly, diving. The
  // target is moved instead of the phase being forced back every frame — the
  // run has to stay a cruise on its own terms for this to mean anything.
  enemies[0].mesh.position.x = bounds.right - 4;
  g.container.position.set(bounds.left + 4, bounds.surfaceY - 6, 0);
  const before = particleCount();
  for (let i = 0; i < 60; i++) {
    g.container.position.set(bounds.left + 4, bounds.surfaceY - 6, 0);
    updateSeagulls(DT, scene, enemies, {});
  }
  check('...and it really is still cruising', g.phase === 'soar', `phase '${g.phase}'`);
  check('a cruising gull sheds nothing, even below the surface',
    particleCount() === before, `${particleCount() - before} particle(s)`);
}
{
  // FRAME RATE MUST NOT SET THE DENSITY. Emitted per frame, the same dive lays
  // down twice as many bubbles on a 120Hz screen as on a 60Hz one and every
  // particle budget in the game is sized against whatever the monitor handed
  // it. The timer is what makes it a number somebody chose.
  const slow = bomb({ dt: 1 / 30 });
  const fast = bomb({ dt: 1 / 120 });
  const ratio = fast.log.particles / Math.max(1, slow.log.particles);
  check('a 30fps dive and a 120fps dive lay down the same trail',
    ratio > 0.75 && ratio < 1.35,
    `${slow.log.particles} at 30fps against ${fast.log.particles} at 120fps (x${ratio.toFixed(2)})`);
}

// ===========================================================================
section('THE BANG AND ITS RETURN');
{
  const { log } = bomb();
  check('the bomb goes off once', log.impact.length === 1, `${log.impact.length}`);
  check('...and is answered once', log.echo.length === 1, `${log.echo.length} echo(es)`);
  const gap = log.echo[0].t - log.impact[0].t;
  // THE GAP IS THE SOUND. Played together the two are one thicker crack, which
  // is the version that reads as a mixing accident rather than as a room.
  check('...after the gap that makes it a second sound',
    Math.abs(gap - C.blastEcho.delay) <= DT * 1.5,
    `${gap.toFixed(3)}s against an authored ${C.blastEcho.delay}s`);
  check('...from where the bomb went off',
    Math.abs(log.echo[0].x - log.impact[0].x) < 1e-6
      && Math.abs(log.echo[0].y - log.impact[0].y) < 1e-6);
  check('...quieter than the bang it is the tail of', log.echo[0].scale < 1.2,
    `scale ${log.echo[0].scale.toFixed(2)}`);
}
{
  // THE LIST HAS TO DRAIN. It is the only thing in this module that outlives
  // the body that made it, so a record that never came off would grow for a
  // whole run — invisibly, because nothing draws it.
  const { log } = bomb();
  check('every blast owed a return has had one', seagullEchoCount() === 0,
    `${seagullEchoCount()} still queued`);

  // ...AND A RUN ENDING INSIDE THE GAP MUST NOT CARRY IT INTO THE NEXT ONE.
  // resetSeagulls clears the gulls, and this list has to go with them or the
  // next run opens with the last one's explosion.
  reseed();
  resetSeagulls(scene);
  const enemies = [crabAt(0, bounds.bottom + 2)];
  const g2 = spawnSeagull(scene, enemies);
  g2.container.position.set(0, bounds.bottom + 2.4, 0);
  g2.phase = 'dive';
  let queued = 0;
  for (let i = 0; i < 300 && seagullCount() > 0; i++) updateSeagulls(DT, scene, enemies, {});
  queued = seagullEchoCount();
  check('a blast leaves its return waiting', queued === 1, `${queued} queued`);
  resetSeagulls(scene);
  check('...and a reset takes it with the gulls',
    seagullEchoCount() === 0, `${seagullEchoCount()} survived the reset`);
  void log;
}

console.log(failures ? `\nFAILED — ${failures} check(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
