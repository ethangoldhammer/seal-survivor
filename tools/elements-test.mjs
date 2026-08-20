#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:elements
//
// Exercises Glow Up! — the elemental system (path/src/systems/elements.js) —
// and the two cross-cutting scalers it shipped alongside (Clone Warz's
// projectileCount and Splash Zone's aoe/targeting).
//
// This is the half `npm run test:upgrades` cannot cover. That harness proves
// the stat block is right and the card is dealable; it never runs a frame, so
// it cannot tell you that venom expires, that a contagion actually reaches the
// fish next to it, or that the night ramp is wired to the sky at all. Those are
// behaviours over time, and every one of them is a place where a plausible
// implementation does nothing at all in the water.
//
// No renderer: three.js Scene/Object3D/Mesh are plain data and nothing here
// draws. That matters because the browser preview suspends
// requestAnimationFrame — a screenshot of this game proves nothing about
// whether its loop runs.
//
//   node --import ./tools/vite-loader.mjs tools/elements-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { baseStats, projectileCount, INTEGER_STATS } from '../path/src/stats.js';
import { player } from '../path/src/entities/player.js';
import { skyLight } from '../path/src/systems/daylight.js';
import { aoe, targeting, companionDamage } from '../path/src/systems/scaling.js';
import { currentGarlicRadius } from '../path/src/systems/garlic.js';
import { currentCalamariStats } from '../path/src/systems/calamari.js';
import { rarities, rollRarity, rarityMul, applyWithRarity, bestRarity } from '../path/src/systems/rarity.js';
import {
  rollElementFor, commitElement, resetElements, activeElement,
  applyElementalHit, updateElements, onEnemyKilled, nightFactor,
  elementCardName, elementCardDesc, clearStatuses, elementHitEvent, elementGlow, moteSnapshot,
  updateElementSkin,
} from '../path/src/systems/elements.js';
import { attachNoiseShader } from '../path/src/systems/noiseShader.js';
import { getAssetMaterials, setAssetTint } from '../path/src/assets.js';
import { elementColor, elementTrailMix, elementFlightParticles } from '../path/src/systems/elements.js';

const scene = new THREE.Scene();
const dt = 1 / 60;
let failures = 0;

function section(name) { console.log(`\n${name}`); }
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

function fakeEnemy(x, y, radius = 0.5, hp = 400) {
  const mesh = new THREE.Object3D();
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  return {
    mesh, radius, hp, vx: 0, vy: 0,
    trapTimer: 0, charmTimer: 0, flash: 0, hitThisFrame: false,
    venomTimer: 0, venomStacks: 0, venomTick: 0,
    chillTimer: 0, chillSlow: 0,
    infectTimer: 0, infectDps: 0, infectTick: 0, infectGen: 0, infectSpreadTimer: 0,
    def: { asset: 'enemyFish', radius, xp: 3 },
  };
}

// Put the run in a known state: an element rolled, a level, and a time of day.
// `player.stats` is the live stat block every system reads, so the harness
// writes it directly rather than replaying upgrades — this is a test of the
// element, not of apply().
function setup({ element, level = 1, night = 0 }) {
  resetElements(scene);
  commitElement(element);
  player.stats = baseStats();
  player.stats.biolumLevel = level;
  skyLight.night = night;
  skyLight.twilight = 0;
}

const noHooks = {};
const b = CONFIG.biolum;

// NOTHING IS HELD OPEN ANY MORE, and that is the point.
//
// This file used to force `night.dayPower` to 1 for every section, because the
// day gate folded into `share` and every mechanical check below would
// otherwise have been measuring a switched-off ability and passing on zeroes.
// The sky no longer reaches a single number — see THE SKY IS A LOOK at the
// end, which is now an invariant rather than a tuning check — so the sections
// below run at whatever hour they like and read the same figures either way.

// ===========================================================================
section('THE ROLL');
// ===========================================================================
{
  resetElements(scene);
  const ids = Object.keys(b.elements);
  check('four elements are configured', ids.length === 4, ids.join(', '));

  // Injected random, so the distribution is checkable without running the game.
  const first = rollElementFor(() => 0);
  const last = rollElementFor(() => 0.999);
  check('the roll spans the whole table', first === ids[0] && last === ids[ids.length - 1],
    `${first} .. ${last}`);

  // The card must be able to say what it is offering BEFORE the pick, which is
  // the whole reason the roll happens at draw time.
  const name = elementCardName('Glow Up!', 'venom', 1);
  const desc = elementCardDesc('venom', 1);
  check('the card names the element it is offering', name.includes('Venom'), name);
  check('...and describes it', typeof desc === 'string' && desc.length > 10, desc);
  check('a later stack reads as deepening, not re-rolling',
    elementCardDesc('venom', 3).includes('+damage'), elementCardDesc('venom', 3));

  // Rolled ONCE per run: after the first commit every later draw must offer the
  // element already carried, or stacking Glow Up! becomes a slot machine.
  commitElement('chill');
  const again = rollElementFor(() => 0.9);
  check('the roll sticks for the rest of the run', again === 'chill', `rolled ${again}`);
  commitElement('venom');
  check('...and a second commit cannot overwrite it', activeElement() === 'chill', activeElement());
}

// ===========================================================================
section('JUICE — every element has a voice');
// ===========================================================================
{
  // The upgrade harness checks every feedback key that appears LITERALLY in the
  // source. These four are built from the element id (elementHitEvent), so it
  // can only see the one that happens to be the fallback — it reports the other
  // three as configured-but-unfired. This is the check that actually covers
  // them, and it is the reason adding a fifth element with no juice fails a
  // test rather than shipping silent.
  for (const id of Object.keys(b.elements)) {
    const key = elementHitEvent(id);
    const def = CONFIG.feedback[key];
    const live = !!def && (def.emit || def.sfx || def.shake || def.glow || def.ripple || def.haptic);
    check(`${id} has a feedback entry that does something`, live, key);
    check(`...with its own emitter, so it is its own colour`,
      !!def?.emit && !!CONFIG.emitters[def.emit], def?.emit ?? 'none');
  }

  // The four emitters must actually differ, or "one per element" is four rows
  // of the same picture.
  const emitters = Object.keys(b.elements).map((id) => CONFIG.feedback[elementHitEvent(id)]?.emit);
  check('every element emits something different', new Set(emitters).size === emitters.length,
    emitters.join(', '));

  const colours = Object.keys(b.elements).map((id) => b.elements[id].color);
  check('...and no two elements share a colour', new Set(colours).size === colours.length,
    colours.map((c) => '#' + c.toString(16)).join(' '));
}

// ===========================================================================
section('THE NIGHT RAMP');
// ===========================================================================
{
  setup({ element: 'venom', level: 1, night: 0 });
  const day = nightFactor();
  skyLight.night = 1;
  const dark = nightFactor();
  check('day reads 0, full dark reads 1', day === 0 && dark === 1, `${day} .. ${dark}`);

  skyLight.night = 0;
  skyLight.twilight = 1;
  check('dusk counts for part of it, so the ability wakes at sunset',
    nightFactor() > 0 && nightFactor() < 1, nightFactor().toFixed(2));

  // THE MULTIPLIERS ARE GONE. They are asserted absent rather than merely not
  // used, because a leftover `damageMul` sitting in the config is an invitation
  // to wire it back up, and the next person to do it would be re-creating an
  // ability whose worth depended on what time the player sat down.
  check('no night damage multiplier survives in the config',
    b.night.damageMul === undefined, `damageMul ${b.night.damageMul}`);
  check('...and no night duration multiplier either',
    b.night.durationMul === undefined, `durationMul ${b.night.durationMul}`);

  // Measured end to end rather than read off the config: a multiplier deleted
  // from the config but still applied from a literal would pass the two checks
  // above and fail these.
  skyLight.twilight = 0;
  setup({ element: 'venom', level: 3, night: 0 });
  const byDay = fakeEnemy(0, 0);
  applyElementalHit(scene, byDay, 100, [byDay], noHooks);
  const dayDamage = 400 - byDay.hp;
  const dayDuration = byDay.venomTimer;

  setup({ element: 'venom', level: 3, night: 1 });
  const byNight = fakeEnemy(0, 0);
  applyElementalHit(scene, byNight, 100, [byNight], noHooks);
  const nightDamage = 400 - byNight.hp;
  const nightDuration = byNight.venomTimer;

  check('the same hit does the same damage at noon and at midnight',
    Math.abs(nightDamage - dayDamage) < 1e-9,
    `${dayDamage.toFixed(2)} vs ${nightDamage.toFixed(2)}`);
  check('...and its status lasts exactly as long',
    Math.abs(nightDuration - dayDuration) < 1e-9,
    `${dayDuration.toFixed(3)}s vs ${nightDuration.toFixed(3)}s`);
}

// ===========================================================================
section('ELEMENTAL DAMAGE');
// ===========================================================================
{
  setup({ element: 'venom', level: 0 });
  const untouched = fakeEnemy(0, 0);
  const none = applyElementalHit(scene, untouched, 100, [untouched], noHooks);
  check('no element at level 0 — the card was never taken', none === 0 && untouched.hp === 400);

  setup({ element: 'venom', level: 1 });
  const one = fakeEnemy(0, 0);
  const d1 = applyElementalHit(scene, one, 100, [one], noHooks);
  setup({ element: 'venom', level: 4 });
  const four = fakeEnemy(0, 0);
  const d4 = applyElementalHit(scene, four, 100, [four], noHooks);
  check('the packet grows with the stack', d4 > d1 * 1.5, `${d1.toFixed(1)} -> ${d4.toFixed(1)}`);
  check('...as a fraction of the hit, so it keeps pace with the gun',
    Math.abs(d1 / 100 - b.damageFraction) < 1e-6, `${(d1 / 100).toFixed(3)} of the hit`);

  // The strike carries it at a discount, or a dash through a school applies a
  // full-strength status per fish on one frame.
  setup({ element: 'venom', level: 3 });
  const gun = fakeEnemy(0, 0);
  const dash = fakeEnemy(5, 0);
  const gunDamage = applyElementalHit(scene, gun, 100, [gun], noHooks, 1);
  const dashDamage = applyElementalHit(scene, dash, 100, [dash], noHooks, b.strikeFraction);
  check('the strike carries the element at a discount', dashDamage < gunDamage,
    `${gunDamage.toFixed(1)} vs ${dashDamage.toFixed(1)}`);
}

// ===========================================================================
section('VENOM — the focus-fire element');
// ===========================================================================
{
  setup({ element: 'venom', level: 2, night: 0 });
  const fish = fakeEnemy(0, 0);
  const list = [fish];
  applyElementalHit(scene, fish, 50, list, noHooks);
  const afterHit = fish.hp;
  check('a hit poisons', fish.venomTimer > 0 && fish.venomStacks === 1);

  // Ticks over time — the thing a config check can't see.
  for (let i = 0; i < 60; i++) updateElements(dt, scene, list, noHooks);
  check('venom ticks damage over time', fish.hp < afterHit,
    `${afterHit.toFixed(1)} -> ${fish.hp.toFixed(1)} over 1s`);

  // Stacks, and caps.
  for (let i = 0; i < 20; i++) applyElementalHit(scene, fish, 50, list, noHooks);
  check('stacks are capped', fish.venomStacks === b.elements.venom.maxStacks,
    `${fish.venomStacks} stacks`);

  const stacked = fish.hp;
  for (let i = 0; i < 30; i++) updateElements(dt, scene, list, noHooks);
  const stackedTick = stacked - fish.hp;
  check('a fully stacked venom ticks harder than one stack', stackedTick > 0,
    `${stackedTick.toFixed(1)} over 0.5s at ${fish.venomStacks} stacks`);

  // ...and expires. A status that never ends is the failure mode a seeded-NaN
  // timer produces, and it is invisible until a run has been going ten minutes.
  const clean = fakeEnemy(0, 0);
  const solo = [clean];
  applyElementalHit(scene, clean, 50, solo, noHooks);
  const duration = clean.venomTimer;
  for (let i = 0; i < Math.ceil(duration / dt) + 10; i++) updateElements(dt, scene, solo, noHooks);
  check('venom expires', clean.venomTimer === 0 && clean.venomStacks === 0,
    `after ${duration.toFixed(2)}s`);
}

// ===========================================================================
section('CHILL — the defensive element');
// ===========================================================================
{
  setup({ element: 'chill', level: 1, night: 0 });
  const fish = fakeEnemy(0, 0);
  const list = [fish];
  applyElementalHit(scene, fish, 50, list, noHooks);
  check('a hit slows', fish.chillSlow > 0 && fish.chillTimer > 0,
    `${(fish.chillSlow * 100).toFixed(0)}% slowed`);
  check('the slow is capped below a full stop', fish.chillSlow < 1);

  // Saturation freezes, reusing the beluga's `trapTimer` — which is what makes
  // every other system in the game already agree the fish is inert.
  let hits = 1;
  while (fish.trapTimer <= 0 && hits < 40) { applyElementalHit(scene, fish, 50, list, noHooks); hits++; }
  check('enough of them freeze it outright', fish.trapTimer > 0, `after ${hits} hits`);
  check('...through trapTimer, the field every system already knows', fish.trapTimer > 0);
  check('...and the slow is spent, so it is not a permanent stun-lock',
    fish.chillSlow === 0, `slow now ${fish.chillSlow}`);

  // Thaws.
  const thawing = fakeEnemy(0, 0);
  const solo = [thawing];
  applyElementalHit(scene, thawing, 50, solo, noHooks);
  const dur = thawing.chillTimer;
  for (let i = 0; i < Math.ceil(dur / dt) + 5; i++) updateElements(dt, scene, solo, noHooks);
  check('chill wears off', thawing.chillTimer === 0 && thawing.chillSlow === 0,
    `after ${dur.toFixed(2)}s`);
}

// ===========================================================================
section('SHOCK — the reach element');
// ===========================================================================
{
  setup({ element: 'shock', level: 6, night: 0 });
  const c = b.elements.shock;
  const shot = fakeEnemy(0, 0);
  const near = fakeEnemy(c.arcRange * 0.5, 0);
  const far = fakeEnemy(c.arcRange * 4, 0);
  const list = [shot, near, far];

  let arcs = 0;
  const hooks = { onArc: () => { arcs++; } };
  for (let i = 0; i < 60; i++) applyElementalHit(scene, shot, 40, list, hooks);

  check('shots arc to a second body', arcs > 0, `${arcs} arcs in 60 hits`);
  check('...to something in range', near.hp < 400, `neighbour at ${near.hp.toFixed(0)} hp`);
  check('...and never to something out of it', far.hp === 400,
    `${(c.arcRange * 4).toFixed(1)} units away, untouched`);
  check('the arc costs the victim less than the shot', c.arcDamage < 1, `${c.arcDamage}x`);

  // --- the chain diminishes ------------------------------------------------
  // Forced to a certain proc for everything below: this is a test of the CHAIN
  // and the roll in front of it is measured in THE SKY IS A LOOK. Restored at
  // the end of the section, because CONFIG is shared with every file after it.
  // BOTH of them, or this flakes one run in ten: `chance` is what the level
  // curve climbs toward and `chanceMax` is the ceiling it is clamped to, and
  // the ceiling ships at 0.9. Setting only the first leaves a 90% coin in
  // front of every measurement below, which fails rarely enough to look like
  // a real intermittent bug in the chain. See [[seeded-rng-in-spawn-harnesses]].
  const shippedChance = c.chance;
  const shippedMax = c.chanceMax;
  const shippedArcs = c.arcs;
  const shippedPerLevel = c.arcsPerLevel;
  c.chance = 1;
  c.chanceMax = 1;

  // A LINE OF TANKS, so nothing dies and every hop is spent on reaching rather
  // than on killing. 1.2 units apart against an arcRange of 6.5 — close enough
  // that the nearest unstruck body is always the next one along, so the chain
  // walks the line in order and the hops can be read off in sequence.
  const chainLine = (n, hp = 1e7) => {
    const list = [fakeEnemy(0, 0, 0.5, hp)];
    for (let i = 1; i <= n; i++) list.push(fakeEnemy(i * 1.2, 0, 0.5, hp));
    return list;
  };

  setup({ element: 'shock', level: 1, night: 0 });
  c.arcs = 6;
  c.arcsPerLevel = 0;
  {
    const line = chainLine(6);
    const strengths = [];
    applyElementalHit(scene, line[0], 100, line, {
      onArc: (x1, y1, x2, y2, strength) => { strengths.push(strength); },
    });
    const hops = line.slice(1).map((e) => 1e7 - e.hp).filter((d) => d > 0);

    check('the chain reaches past the second body', hops.length >= 3,
      `${hops.length} bodies hit`);
    check('...taking less out of each one than the last',
      hops.every((d, i) => i === 0 || d < hops[i - 1]),
      hops.map((d) => d.toFixed(1)).join(' -> '));
    check('...by the configured falloff, not by some other number',
      hops.length > 1 && Math.abs(hops[1] / hops[0] - c.arcFalloff) < 1e-9,
      `${(hops[1] / hops[0]).toFixed(3)} vs arcFalloff ${c.arcFalloff}`);
    // The bolt is the only thing on screen that says how far down the chain a
    // hop is. If it stopped tracking the damage, a chain would LOOK the same
    // all the way along while landing a sixteenth as much at the far end.
    check('...and the bolt is drawn weaker in step with it',
      strengths.length === hops.length
      && strengths.every((v, i) => i === 0 || v < strengths[i - 1]),
      strengths.map((v) => v.toFixed(2)).join(' -> '));
  }

  // --- it does not die with its first victim -------------------------------
  // THE BUG THIS REPLACED. The chain used to `break` on a kill, so against the
  // schools it exists to answer — where the first hop always kills — a
  // six-hop chain landed exactly one hop. It was weakest in the only fight
  // that ever needed it.
  {
    setup({ element: 'shock', level: 1, night: 0 });
    const line = chainLine(6, 1);
    let killed = 0;
    applyElementalHit(scene, line[0], 100, line, {
      onEnemyKilled: () => { killed++; },
    });
    check('a chain through a school does not stop at the first kill', killed > 1,
      `${killed} killed`);

    // ...but a kill is not free either. Same budget, same spacing, bodies that
    // survive: the chain reaches strictly further when it is not blowing
    // through anything.
    const tanky = chainLine(6);
    applyElementalHit(scene, tanky[0], 100, tanky, noHooks);
    const reached = tanky.slice(1).filter((e) => e.hp < 1e7).length;
    check('...and a kill still costs it a hop', reached > killed,
      `${reached} bodies through survivors vs ${killed} through kills`);
  }

  // --- it gives up rather than hopping forever ------------------------------
  // Without the floor the falloff is an infinite series: in a dense enough
  // crowd the chain keeps going for hops worth fractions of a point, each one
  // a bolt, a spark burst and a sound.
  {
    setup({ element: 'shock', level: 1, night: 0 });
    c.arcs = 200;
    const line = chainLine(199);
    let arcs2 = 0;
    applyElementalHit(scene, line[0], 100, line, { onArc: () => { arcs2++; } });
    const expected = Math.ceil(Math.log(c.arcDamageFloor / c.arcDamage) / Math.log(c.arcFalloff));
    check('a 200-hop budget still stops where the damage floor says',
      arcs2 > 1 && arcs2 <= expected + 1,
      `${arcs2} hops, floor reached at about ${expected}`);
  }

  c.chance = shippedChance;
  c.chanceMax = shippedMax;
  c.arcs = shippedArcs;
  c.arcsPerLevel = shippedPerLevel;
}

// ===========================================================================
section('THE PELLET SHOWS WHAT IT IS CARRYING');
// ===========================================================================
// Each element gets its own answer to "what does this look like on the way
// there", and two of them are deliberately NOTHING. That is the part worth
// testing: a gap that is a decision looks exactly like a gap that is an
// oversight, and the next person to read the config cannot tell them apart
// without this section.
//
//   shock      crackles      — its whole effect is over in the frame it lands
//   venom      drips         — heavy, sagging, obviously about to be left on something
//   chill      nothing       — ice on the body is already its loudest moment
//   infection  motes         — real objects, handed to the fish on impact
{
  setup({ element: 'shock', level: 1, night: 0 });
  const spec = elementFlightParticles();
  check('a Voltaic run crackles in flight', !!spec?.emitter, spec?.emitter ?? 'nothing');
  check('...on a rate, so it holds at any framerate', spec?.perSecond > 0,
    `${spec?.perSecond}/s`);
  check('...from an emitter that actually exists', !!CONFIG.emitters[spec?.emitter],
    spec?.emitter ?? '');
  // The gun fires a lot of pellets and every one of them runs this rate. A
  // burst count above a couple here is a four-figure particle budget for a
  // detail meant to be read out of the corner of an eye.
  check('...one speck at a time, because there are a lot of pellets',
    CONFIG.emitters[spec.emitter].count <= 2, `count ${CONFIG.emitters[spec.emitter].count}`);
  check('...in the element\'s own colours',
    CONFIG.emitters[spec.emitter].colors.includes(b.elements.shock.color),
    CONFIG.emitters[spec.emitter].colors.map((c2) => '#' + c2.toString(16)).join(' '));

  // IT DOES NOT RIDE THE SKY. The pellet's colour fades at noon because that
  // is a wash over something already on screen; sparks that thinned out would
  // read as the gun misfiring.
  setup({ element: 'shock', level: 1, night: 1 });
  const atNight = elementFlightParticles();
  check('the sparks are the same at noon as at midnight',
    atNight?.perSecond === spec.perSecond, `${spec.perSecond}/s either way`);

  // --- venom drips ---------------------------------------------------------
  setup({ element: 'venom', level: 1, night: 0 });
  const drip = elementFlightParticles();
  check('a venom run drips in flight', !!drip?.emitter, drip?.emitter ?? 'nothing');
  const dripDef = CONFIG.emitters[drip?.emitter];
  check('...from an emitter that actually exists', !!dripDef, drip?.emitter ?? '');
  // THE THREE THINGS THAT MAKE IT A DRIP rather than a spark, all of which a
  // copy-paste from the shock preset would silently get wrong.
  check('...and it falls, which is the whole read', dripDef.gravity[1] < 0,
    `gravity ${dripDef.gravity[1]}`);
  check('...lingering longer than a spark does', dripDef.life[1] > CONFIG.emitters[spec.emitter].life[1],
    `${dripDef.life[1]}s vs ${CONFIG.emitters[spec.emitter].life[1]}s`);
  // A drop thrown along WITH the pellet arrives where the pellet does and the
  // trail never sags. Near-zero inherit is what leaves it behind in the water.
  check('...and is left behind rather than thrown along', dripDef.inherit < 0.1,
    `inherit ${dripDef.inherit}`);
  check('...in the element\'s own colours', dripDef.colors.includes(b.elements.venom.color),
    dripDef.colors.map((c2) => '#' + c2.toString(16)).join(' '));

  // --- chill and infection shed nothing, on purpose ------------------------
  // Chill's ice and freeze are already its loudest moment. Infection does not
  // use this path at all: its motes are real objects that ride the pellet and
  // are handed over on impact, which no emitter could do — see the section
  // below.
  for (const id of ['chill', 'infection']) {
    setup({ element: id, level: 1, night: 0 });
    check(`${id} sheds nothing in flight, deliberately`, elementFlightParticles() === null);
  }

  setup({ element: 'shock', level: 0, night: 0 });
  check('a run that never took the card sheds nothing', elementFlightParticles() === null);
}

// ===========================================================================
section('THE CONTAGION RIDES THE PELLET');
// ===========================================================================
// The infected fish already wear orbiting lights, and a spread is drawn as one
// of those lights crossing the gap to the next body. So the shot carries them
// too, and impact is that same crossing one step earlier — the ammunition was
// holding the contagion and it visibly changes hands.
//
// WHY NOT A PARTICLE TRAIL. A spore emitter would have to be extinguished and
// a separate burst lit on the fish, and the two would never quite read as the
// same objects. These are the same objects.
{
  const fakeShot = (x, y) => {
    const mesh = new THREE.Object3D();
    mesh.position.set(x, y, 0);
    scene.add(mesh);
    return { mesh, radius: 0.18, source: 'gun', faction: 'player' };
  };
  // Settled on it, not merely aimed at it — a mote mid-flight is still the
  // pellet's picture, not the fish's.
  const orbiting = (host) => moteSnapshot().filter((mo) => !mo.travelling && mo.host === host).length;
  const motesInFlightTo = (t) => moteSnapshot().filter((mo) => mo.travelling && mo.target === t).length;

  setup({ element: 'infection', level: 3, night: 0 });
  const shot = fakeShot(-3, 0);
  // Several frames: ensureMotes adds ONE per call, so a host ramps up to its
  // complement over a few frames rather than popping into existence wearing
  // all of them. A single tick here would assert against a half-dressed shot.
  for (let i = 0; i < 6; i++) updateElements(dt, scene, [], noHooks, [shot]);
  const carried = orbiting(shot);
  const perShot = b.elements.infection.motes.perShot;
  check('a pellet in the air carries motes', carried === perShot, `${carried} on the shot`);
  check('...fewer than an infected fish gets, because it is a promise not the ability',
    carried < b.elements.infection.motes.perHost, `${carried} vs ${b.elements.infection.motes.perHost}`);

  // THE HAND-OVER. After the hit the lights belong to the fish, and they are
  // in flight toward it rather than teleported.
  const fish = fakeEnemy(0, 0);
  applyElementalHit(scene, fish, 100, [fish], noHooks, 1, shot);
  check('the fish it hits is infected', fish.infectTimer > 0);
  check('...and the pellet is no longer holding them', orbiting(shot) === 0,
    `${orbiting(shot)} left on the shot`);
  const travelling = motesInFlightTo(fish);
  check('...they are crossing the gap to it', travelling === carried,
    `${travelling} in flight`);

  // ...and they actually arrive, rather than easing forever toward a fish.
  for (let i = 0; i < 240; i++) updateElements(dt, scene, [fish], noHooks, []);
  check('...and arrive', orbiting(fish) > 0, `${orbiting(fish)} now orbiting the fish`);

  // --- a pellet that hits nothing does not leak ----------------------------
  // The one failure a pool like this fails with: a light orbiting an object
  // that is gone. A shot that flies off and expires takes its motes with it.
  setup({ element: 'infection', level: 3, night: 0 });
  const missed = fakeShot(6, 6);
  updateElements(dt, scene, [], noHooks, [missed]);
  check('a shot that hits nothing still carries them', orbiting(missed) > 0);
  scene.remove(missed.mesh); // what despawning a projectile does
  updateElements(dt, scene, [], noHooks, []);
  check('...and takes them with it when it despawns', orbiting(missed) === 0,
    `${orbiting(missed)} orphaned`);

  // --- the volley may not eat the pool -------------------------------------
  // Eight pellets against one shared ceiling. Without the reserve a Cloned
  // Pebbles run spends its whole mote budget on ammunition in the air and the
  // infected fish — the actual readout — orbit nothing at all.
  setup({ element: 'infection', level: 3, night: 0 });
  const volley = [];
  for (let i = 0; i < 80; i++) volley.push(fakeShot(i * 0.5 - 20, 4));
  for (let i = 0; i < 10; i++) updateElements(dt, scene, [], noHooks, volley);
  const m = b.elements.infection.motes;
  const onShots = moteSnapshot().filter((mo) => mo.onShot).length;
  check('a huge volley cannot spend the whole mote pool',
    onShots <= Math.floor(m.maxAlive * m.shotShare),
    `${onShots} on pellets, reserve ${Math.floor(m.maxAlive * m.shotShare)} of ${m.maxAlive}`);

  // ...and with the pellets holding their share, a fish infected afterwards
  // still gets lights. This is the check the reserve exists for.
  const late = fakeEnemy(0, -4);
  applyElementalHit(scene, late, 100, [late], noHooks);
  for (let i = 0; i < 10; i++) updateElements(dt, scene, [late], noHooks, volley);
  check('...and a fish infected while it is in the air still gets its own',
    orbiting(late) > 0, `${orbiting(late)} on the fish`);

  resetElements(scene);
}

// ===========================================================================
section('INFECTION — the contagion');
// ===========================================================================
{
  const c = b.elements.infection;

  // --- it creeps ---
  setup({ element: 'infection', level: 3, night: 0 });
  const host = fakeEnemy(0, 0);
  const neighbour = fakeEnemy(c.spreadRange * 0.5, 0);
  const distant = fakeEnemy(c.spreadRange * 6, 0);
  const school = [host, neighbour, distant];

  applyElementalHit(scene, host, 60, school, noHooks);
  check('a hit infects', host.infectTimer > 0 && host.infectDps > 0,
    `${host.infectDps.toFixed(1)} dps`);

  let spreads = 0;
  const hooks = { onSpread: () => { spreads++; } };
  for (let i = 0; i < 150; i++) updateElements(dt, scene, school, hooks);

  check('the infection creeps to a neighbour', neighbour.infectTimer > 0 || spreads > 0,
    `${spreads} hops`);
  check('...but not across the arena', distant.infectTimer === 0,
    `${(c.spreadRange * 6).toFixed(1)} units away, clean`);
  check('a hop is weaker than its source', c.hopFalloff < 1, `${c.hopFalloff}x per generation`);

  // --- it ticks ---
  setup({ element: 'infection', level: 3, night: 0 });
  const lone = fakeEnemy(0, 0);
  const solo = [lone];
  applyElementalHit(scene, lone, 60, solo, noHooks);
  const start = lone.hp;
  for (let i = 0; i < 60; i++) updateElements(dt, scene, solo, noHooks);
  check('infection ticks damage', lone.hp < start,
    `${start.toFixed(1)} -> ${lone.hp.toFixed(1)} over 1s`);

  // --- it bursts on death ---
  // The burst is QUEUED from the kill funnel and drained on the next tick, so
  // this also proves the deferral works rather than silently dropping the event.
  setup({ element: 'infection', level: 3, night: 0 });
  const dying = fakeEnemy(0, 0);
  const bystander = fakeEnemy(c.burstRange * 0.5, 0);
  const crowd = [dying, bystander];
  applyElementalHit(scene, dying, 60, crowd, noHooks);

  let bursts = 0;
  onEnemyKilled(dying);          // as main.js's kill funnel does
  crowd.splice(0, 1);            // ...and then the corpse leaves the array
  const bystanderHp = bystander.hp;
  updateElements(dt, scene, crowd, { onBurst: () => { bursts++; } });

  check('a dead host bursts', bursts === 1, `${bursts} burst`);
  check('...damaging what was standing near it', bystander.hp < bystanderHp,
    `${bystanderHp.toFixed(1)} -> ${bystander.hp.toFixed(1)}`);
  check('...and infecting it', bystander.infectTimer > 0);

  // --- the limits hold ---
  // Without these a contagion in a dense school never stops, which is the one
  // failure mode that ends a run rather than merely looking wrong.
  setup({ element: 'infection', level: 6, night: 1 });
  const dense = [];
  for (let i = 0; i < 60; i++) dense.push(fakeEnemy((i % 10) * 0.8, Math.floor(i / 10) * 0.8, 0.4, 100000));
  applyElementalHit(scene, dense[0], 60, dense, noHooks);
  for (let i = 0; i < 900; i++) updateElements(dt, scene, dense, noHooks);
  const sick = dense.filter((e) => e.infectTimer > 0).length;
  check('live hosts are capped', sick <= c.maxHosts, `${sick} infected of ${dense.length}, cap ${c.maxHosts}`);

  const worstGen = Math.max(...dense.map((e) => e.infectGen ?? 0));
  check('...and so is how far it travels from the shot fish',
    worstGen <= c.generations, `generation ${worstGen}, cap ${c.generations}`);
}

// ===========================================================================
section('LIFECYCLE');
// ===========================================================================
{
  setup({ element: 'venom', level: 3 });
  const survivor = fakeEnemy(0, 0);
  applyElementalHit(scene, survivor, 60, [survivor], noHooks);
  check('a status is live before the reset', survivor.venomTimer > 0);

  resetElements(scene);
  clearStatuses([survivor]);
  check('a run restart drops the element', activeElement() === null);
  check('...and clears statuses off anything still in the water',
    survivor.venomTimer === 0 && survivor.venomStacks === 0);

  // A status left ticking with no element would keep damaging fish for a run
  // that never took the card.
  const hp = survivor.hp;
  for (let i = 0; i < 120; i++) updateElements(dt, scene, [survivor], noHooks);
  check('...so nothing keeps ticking afterward', survivor.hp === hp);
}

// ===========================================================================
section('THE SEAL PUTS THE GLOW DOWN AT RUN START');
// ===========================================================================
// The bug this is here for: the glow is UNIFORMS ON A MATERIAL, and nothing
// between runs rebuilds either the seal's body or the ship asset's materials.
// resetElements clearing its own module state is not enough — updateElementSkin
// returns immediately while `element` is null, so it is precisely the path that
// cannot take the light back off. A run that ended lit up green opened lit up
// green, at the last run's night brightness, until something happened to roll
// Glow Up! again.
{
  // A stand-in for the seal's body: one mesh wearing the noise shader, which is
  // the only thing the glow is written onto.
  const body = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial();
  attachNoiseShader(mat);
  body.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
  const u = mat.userData.__noiseUniforms;

  check('the seal starts unlit', u.uNoiseGlowStrength.value === 0);
  // What the skin looks like BEFORE any element — the thing the glow must not
  // disturb. Read rather than compared against CONFIG, because whether
  // applySettings has run is not what this is asking about.
  const skinBefore = u.uNoiseStrength.value;

  setup({ element: 'venom', level: 3 });
  skyLight.night = 1;
  skyLight.twilight = 0;
  updateElementSkin(body, dt);
  const lit = u.uNoiseGlowStrength.value;
  check('taking Glow Up! lights it', lit > 0, `strength ${lit.toFixed(2)}`);
  check('...in the element\'s colour, not the pattern\'s',
    u.uNoiseGlowColor.value.getHex() === CONFIG.biolum.elements.venom.color,
    `#${u.uNoiseGlowColor.value.getHexString()}`);
  // The old path multiplied the body's own colour DOWN to make a second
  // pattern legible, which is how a seal disappeared into dark water.
  check('...and the seal itself is not darkened to make it show',
    u.uNoiseStrength.value === skinBefore,
    `the skin under the glow is untouched (${skinBefore})`);

  resetElements(scene);
  check('a run restart takes the glow back off the material',
    u.uNoiseGlowStrength.value === 0,
    'nothing rebuilds the seal between runs, so this is the only thing that can');

  // ...and the next run's first frames must not put it back by themselves.
  for (let i = 0; i < 10; i++) updateElementSkin(body, dt);
  check('...and it stays off until something rolls the element again',
    u.uNoiseGlowStrength.value === 0);
}

// ===========================================================================
section('CLONE WARZ — projectileCount');
// ===========================================================================
{
  const s = baseStats();
  s.projectileBonus = 2;

  // The gate is the whole point: the card adds a shell to weapons you HAVE.
  check('an ability you never took stays at zero', projectileCount(0, s) === 0);
  check('...and one you did gets the bonus', projectileCount(3, s) === 5);
  check('the basic shot always counts as owned', projectileCount(1, s) === 3);

  const none = baseStats();
  check('a run without the card is unchanged', projectileCount(4, none) === 4);
  check('a missing stat block does not produce NaN', projectileCount(4, undefined) === 4);
}

// ===========================================================================
section('SPLASH ZONE — aoe and targeting');
// ===========================================================================
{
  player.stats = baseStats();
  check('untaken, every radius is left exactly alone',
    aoe(10) === 10 && targeting(10) === 10 && companionDamage(10) === 10);

  player.stats.aoeMul = 1.18 ** 3;
  player.stats.targetingMul = 1.06 ** 3;
  const blast = aoe(10);
  const reach = targeting(10);
  check('three stacks widen a blast substantially', blast > 16, `10 -> ${blast.toFixed(2)}`);
  check('...and acquisition far less', reach < blast * 0.75, `10 -> ${reach.toFixed(2)}`);

  // The split is the design — a card that widened acquisition as hard as it
  // widens explosions means every companion engages off the top of the screen.
  check('acquisition never outruns reach',
    player.stats.targetingMul < player.stats.aoeMul,
    `${player.stats.targetingMul.toFixed(2)}x vs ${player.stats.aoeMul.toFixed(2)}x`);

  // ...and then END TO END, through the abilities themselves. The unit checks
  // above only prove the helper multiplies; these prove it is actually wired
  // into the two abilities the card's text promises, which is the failure this
  // whole card is most likely to have — a scaler that exists and reaches
  // nothing looks identical from the stat block.
  player.stats = baseStats();
  const garlicBase = currentGarlicRadius(3);
  const calamariBase = currentCalamariStats(3).maxRadius;

  player.stats.aoeMul = 1.18 ** 2;
  const garlicWide = currentGarlicRadius(3);
  const calamariWide = currentCalamariStats(3).maxRadius;

  check("Sea Garlic's aura actually widens", garlicWide > garlicBase * 1.3,
    `${garlicBase.toFixed(2)} -> ${garlicWide.toFixed(2)} units`);
  check("...and the Calamari Ring's wave", calamariWide > calamariBase * 1.3,
    `${calamariBase.toFixed(2)} -> ${calamariWide.toFixed(2)} units`);

  // The garlic mesh is scaled by exactly the radius the damage test uses, so a
  // widened aura cannot end up bigger in the picture than in the water (or
  // vice versa, which is worse — an aura that kills past its own edge).
  check('...with the picture and the hitbox the same number',
    currentGarlicRadius(3) === garlicWide);
}

// ===========================================================================
section('THE SKY IS A LOOK — and may not touch a number');
// ===========================================================================
// THE INVARIANT THIS FILE EXISTS TO PROTECT, now that the day ramp has been
// pulled out of the numbers.
//
// It used to be the other way round: `dayPower` scaled the packet, the status
// durations and the arc chance, and the ledger caught what that cost. Thirty
// real seconds is a game hour and the awake window is 17:20–07:00, so a median
// 2:39 run begun during the working day never sees dark at all — Glow Up! did
// 39 damage across eight runs that took it, last in the game by ninety times,
// and no card, tooltip or readout said why. Raising the floor made it a
// half-strength ability instead of a dead one, which is a better bug.
//
// So the checks below are written as EQUALITIES, not as ratios. There is no
// tuning value that makes them pass by degrees: either the sky is out of the
// numbers or it is not.
{
  const SHIPPED_DAY_GLOW = b.night.dayGlow;

  // --- the numbers do not move -------------------------------------------
  const measure = (night) => {
    setup({ element: 'venom', level: 3, night });
    const e = fakeEnemy(0, 0);
    const dealt = applyElementalHit(scene, e, 100, [e], noHooks);
    return { dealt, timer: e.venomTimer, stacks: e.venomStacks };
  };
  const noon = measure(0);
  const dusk = measure(0.5);
  const dark = measure(1);

  check('a hit lands the same packet at every hour',
    noon.dealt === dusk.dealt && dusk.dealt === dark.dealt,
    `${noon.dealt.toFixed(2)} / ${dusk.dealt.toFixed(2)} / ${dark.dealt.toFixed(2)}`);
  check('...and the same status, for the same length of time',
    noon.timer === dark.timer && noon.stacks === dark.stacks,
    `${noon.timer.toFixed(3)}s x${noon.stacks} vs ${dark.timer.toFixed(3)}s x${dark.stacks}`);

  // The chain too, which read the sky through `share` on its PROC ROLL — the
  // one place a day gate would have shown up as "this element is unreliable"
  // rather than as "this element is weak".
  const chainAt = (night) => {
    setup({ element: 'shock', level: 8, night });
    const shot = fakeEnemy(0, 0);
    const crowd = [shot];
    for (let i = 1; i <= 6; i++) crowd.push(fakeEnemy(i * 1.2, 0, 0.5, 100000));
    let arcs = 0;
    for (let i = 0; i < 200; i++) applyElementalHit(scene, shot, 40, crowd, { onArc: () => { arcs++; } });
    return arcs;
  };
  const arcsByDay = chainAt(0);
  const arcsByNight = chainAt(1);
  // A PROC ROLL, so this is the one figure here that cannot be an equality —
  // it is 200 samples of a coin. A ratio well inside the noise is the claim.
  check('the chain fires about as often by day as by night',
    arcsByDay > 0 && Math.abs(arcsByDay - arcsByNight) < arcsByNight * 0.25,
    `${arcsByDay} arcs by day vs ${arcsByNight} by night`);

  // --- the look does move -------------------------------------------------
  // The other half. If elementGlow stopped tracking the sky, every check above
  // would still pass and the ability would have quietly become a flat one.
  setup({ element: 'venom', level: 3, night: 0 });
  const glowNoon = elementGlow();
  setup({ element: 'venom', level: 3, night: 0.5 });
  const glowDusk = elementGlow();
  setup({ element: 'venom', level: 3, night: 1 });
  const glowNight = elementGlow();

  check('the element still shows brightest after dark', glowNight === 1 && glowNoon < 1,
    `${glowNoon.toFixed(2)} at noon -> ${glowNight.toFixed(2)} at midnight`);
  check('...fading across dusk rather than switching on',
    glowDusk > glowNoon && glowDusk < glowNight, glowDusk.toFixed(3));
  check('...and never all the way out, or a daylight run cannot tell which element it rolled',
    SHIPPED_DAY_GLOW > 0 && Math.abs(glowNoon - SHIPPED_DAY_GLOW) < 1e-9,
    `dayGlow ${SHIPPED_DAY_GLOW}`);

  // THE OLD KEY IS GONE. `dayPower` meant "how much of the ability is live"
  // and the saved tuning snapshot was carrying a 0 for it. Read as the
  // brightness it is now, that 0 means "invisible for the whole working day" —
  // an answer to a question nobody asked. Renaming is what stops a stale
  // snapshot value surviving a change of meaning.
  check('the old `dayPower` key is gone, so no saved snapshot can revive it',
    b.night.dayPower === undefined, `dayPower ${b.night.dayPower}`);

  // The same failure the nightlife spawn gate documents: a world with no clock
  // must not have the ability silently deleted from it, with no message why.
  const hadClock = CONFIG.dayNight.enabled;
  CONFIG.dayNight.enabled = false;
  setup({ element: 'venom', level: 3, night: 0 });
  check('a world with no day cycle shows the element at full brightness', elementGlow() === 1,
    `glow ${elementGlow()} with dayNight.enabled = false`);
  CONFIG.dayNight.enabled = hadClock;
}

// ===========================================================================
section('THE SHOT WEARS THE ELEMENT');
// ===========================================================================
// The card says the shots carry an element, and the pellet was the one place
// that never showed it. It rides elementGlow() like the seal's glow does, so
// the pellet and the animal that fired it are lit to the same degree at every
// hour — a purely visual claim now: the shot does the same damage at noon as
// it does at midnight whatever colour it is wearing.
{
  const bulletHex = () => getAssetMaterials('bullet')[0].color.getHex();
  const asColor = (hex) => new THREE.Color(hex).getHex();
  // The pellet's own colour, read before anything has tinted it, so this
  // survives somebody retuning the bullet in assets.js.
  resetElements(scene);
  const stone = bulletHex();

  setup({ element: 'venom', level: 2, night: 1 });
  updateElements(dt, scene, [], noHooks);
  check('a venom run turns the pellet venom-green',
    bulletHex() === asColor(elementColor('venom')), `#${bulletHex().toString(16)}`);
  check('...which is not the stone it fires by default', bulletHex() !== stone);
  check('...and the ribbon behind it follows', elementTrailMix() > 0,
    `mix ${elementTrailMix().toFixed(2)}`);

  setup({ element: 'chill', level: 2, night: 1 });
  updateElements(dt, scene, [], noHooks);
  check('a chill run is a different colour again',
    bulletHex() === asColor(elementColor('chill')), `#${bulletHex().toString(16)}`);

  // THE DAY RAMP, on the colour — which is the only thing it moves now.
  setup({ element: 'venom', level: 2, night: 0 });
  updateElements(dt, scene, [], noHooks);
  const noonHex = bulletHex();
  const noonMix = elementTrailMix();
  const noonGlow = elementGlow(); // read HERE — the night setup below moves it
  setup({ element: 'venom', level: 2, night: 1 });
  updateElements(dt, scene, [], noHooks);
  const nightMix = elementTrailMix();
  // Dim, not absent — the pellet says WHICH element the run rolled, and a
  // stone-coloured pellet at noon says nothing at all.
  check('at noon the shot is only faintly tinted', noonHex !== stone
    && noonHex !== asColor(elementColor('venom')),
    `#${noonHex.toString(16)} at glow ${noonGlow}`);
  check('...and its ribbon carries less than it does after dark',
    noonMix > 0 && noonMix < nightMix, `mix ${noonMix.toFixed(2)} vs ${nightMix.toFixed(2)}`);

  setup({ element: 'venom', level: 2, night: 0.5 });
  updateElements(dt, scene, [], noHooks);
  check('dusk is partway between, not a switch',
    bulletHex() !== stone && bulletHex() !== asColor(elementColor('venom')),
    `#${bulletHex().toString(16)}`);

  // A LOOK-PANEL TINT UNDERNEATH SURVIVES IT. The element writes a blend layer
  // rather than the tint itself precisely so a bullet colour set in the
  // texture workbench comes back when the element lets go — writing `tint`
  // would have "restored" it to the asset default and eaten the user's work.
  // Cleared first: the dusk blend above is still on the material, and a
  // half-faded magenta is not what "the user's tint" means.
  resetElements(scene);
  setAssetTint('bullet', 0xff00ff);
  const custom = bulletHex();
  setup({ element: 'venom', level: 2, night: 1 });
  updateElements(dt, scene, [], noHooks);
  check('a custom bullet tint is overridden while the element is awake',
    bulletHex() === asColor(elementColor('venom')));
  resetElements(scene);
  check('...and comes back when the run ends', bulletHex() === custom,
    `#${bulletHex().toString(16)} vs #${custom.toString(16)}`);
  setAssetTint('bullet', null);

  setup({ element: 'shock', level: 2, night: 1 });
  updateElements(dt, scene, [], noHooks);
  resetElements(scene);
  check('a run that ended lit up does not open lit up', bulletHex() === stone,
    `#${bulletHex().toString(16)}`);
}

// ===========================================================================
section('RARITY — the ladder');
// ===========================================================================
{
  const tiers = rarities();
  check('the ladder has tiers', tiers.length >= 2, `${tiers.length} tiers`);
  check('the floor tier is exactly neutral', tiers[0].statMul === 1,
    `${tiers[0].id} at ${tiers[0].statMul}x`);
  check('...and does not glow, so the other tiers can mean something',
    (tiers[0].glow ?? 0) === 0, `glow ${tiers[0].glow}`);

  let climbs = true;
  for (let i = 1; i < tiers.length; i++) if (tiers[i].statMul < tiers[i - 1].statMul) climbs = false;
  check('every rung is worth more than the one below it', climbs,
    tiers.map((r) => r.statMul).join(' < '));

  const colours = new Set(tiers.map((r) => r.color));
  check('no two tiers share a colour', colours.size === tiers.length);

  // Every tier above the floor must be announceable, or the ladder is audible
  // for some tiers and silent for others with nothing to say which.
  const voiced = tiers.slice(1).every((r) => r.sfx && CONFIG.sfx[r.sfx]);
  check('every tier above the floor has a real sound', voiced,
    tiers.slice(1).map((r) => r.sfx).join(', '));
}

// ===========================================================================
section('RARITY — the roll');
// ===========================================================================
{
  const ids = rarities().map((r) => r.id);
  const top = ids[ids.length - 1];

  // Sampled rather than reasoned about. A weighted walk is exactly the kind of
  // code that looks right and quietly never reaches its last row.
  const sample = (progress, n = 40000) => {
    let seed = 12345;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const counts = Object.fromEntries(ids.map((id) => [id, 0]));
    for (let i = 0; i < n; i++) counts[rollRarity(progress, rng)] += 1;
    return counts;
  };

  const early = sample(0);
  const late = sample(1);

  check('every tier is reachable at full progress',
    ids.every((id) => late[id] > 0), ids.map((id) => `${id}:${late[id]}`).join(' '));
  check('the floor tier dominates the opening', early[ids[0]] / 40000 > 0.5,
    `${(early[ids[0]] / 400).toFixed(1)}% common early`);
  check('...and stops dominating by the end', late[ids[0]] / 40000 < 0.35,
    `${(late[ids[0]] / 400).toFixed(1)}% common late`);
  check('the top tier is genuinely rare early', early[top] / 40000 < 0.02,
    `${(early[top] / 400).toFixed(2)}% legendary early`);
  check('...and reachable late', late[top] / 40000 > 0.03,
    `${(late[top] / 400).toFixed(1)}% legendary late`);

  // The ramp has to be monotonic per tier, or "odds improve as the run goes on"
  // is only true at the two ends the config states.
  const mid = sample(0.5);
  check('the top tier climbs the whole way, not just at the ends',
    early[top] < mid[top] && mid[top] < late[top],
    `${early[top]} -> ${mid[top]} -> ${late[top]}`);

  check('bestRarity picks the top of a hand',
    bestRarity([{ rarity: ids[0] }, { rarity: top }, { rarity: ids[1] }]) === top);
  check('...and copes with a hand that has none', bestRarity([{}, {}]) === null);
}

// ===========================================================================
section('RARITY — what a tier is worth');
// ===========================================================================
{
  const ids = rarities().map((r) => r.id);
  const top = ids[ids.length - 1];
  const find = (id) => CONFIG.upgrades.find((u) => u.id === id);

  const run = (upgradeId, rarity) => {
    const s = baseStats();
    applyWithRarity(find(upgradeId), s, rarity);
    return s;
  };

  // --- continuous: amplified ---
  const hpCommon = run('vitality', ids[0]).maxHp;
  const hpTop = run('vitality', top).maxHp;
  const base = baseStats().maxHp;
  check('a top-tier flat bonus is bigger', hpTop > hpCommon,
    `+${(hpCommon - base).toFixed(0)} -> +${(hpTop - base).toFixed(0)} hp`);
  check('...by exactly the tier multiplier',
    Math.abs((hpTop - base) / (hpCommon - base) - rarityMul(top)) < 1e-9);

  // The one that a naive `result * mul` gets backwards: fire rate is seconds
  // between shots, so the upgrade IMPROVES it by making it smaller.
  const frCommon = run('rapidFire', ids[0]).fireRate;
  const frTop = run('rapidFire', top).fireRate;
  check('an upgrade that improves by going DOWN still improves', frTop < frCommon,
    `${frCommon.toFixed(3)}s -> ${frTop.toFixed(3)}s between shots`);

  // --- integer: never fractional ---
  const msTop = run('multishot', top);
  check('a count is never left fractional', Number.isInteger(msTop.multishot),
    `multishot ${msTop.multishot}`);
  const garlicTop = run('seaGarlic', top);
  check('...nor is a level index', Number.isInteger(garlicTop.garlicLevel),
    `garlicLevel ${garlicTop.garlicLevel}`);

  // ...and every integer stat, across every upgrade and every tier. This is the
  // check that catches a new upgrade touching a count that INTEGER_STATS does
  // not know about, which would otherwise surface as a fractional shrimp.
  let fractional = [];
  for (const u of CONFIG.upgrades) {
    for (const id of ids) {
      const s = baseStats();
      applyWithRarity(u, s, id);
      for (const k of INTEGER_STATS) {
        if (!Number.isInteger(s[k])) fractional.push(`${u.id}@${id}.${k}=${s[k]}`);
      }
    }
  }
  check('no upgrade at any tier produces a fractional count', !fractional.length,
    fractional.slice(0, 3).join(', ') || 'all 38 upgrades, all tiers');

  // --- integer-only upgrades get paid through their family ---
  const shrimpCommon = run('shrimpRing', ids[0]);
  const shrimpTop = run('shrimpRing', top);
  check('a count-only card still pays something at a high tier',
    shrimpTop.abilityDamageMul > shrimpCommon.abilityDamageMul,
    `abilityDamageMul ${shrimpCommon.abilityDamageMul.toFixed(3)} -> ${shrimpTop.abilityDamageMul.toFixed(3)}`);
  check('...and the same number of shrimp', shrimpTop.shrimpCount === shrimpCommon.shrimpCount,
    `${shrimpTop.shrimpCount} shrimp either way`);

  const garlicPaid = run('seaGarlic', top);
  check('an AOE count card pays into AOE', garlicPaid.aoeMul > 1,
    `aoeMul ${garlicPaid.aoeMul.toFixed(3)}`);
  const orcaPaid = run('orcaFamily', top);
  check('a companion count card pays into companion damage', orcaPaid.companionDamageMul > 1,
    `companionDamageMul ${orcaPaid.companionDamageMul.toFixed(3)}`);

  // The payout must be a substitute for the amplification, not a jackpot.
  check('the payout is well under the tier multiplier',
    garlicPaid.aoeMul < rarityMul(top),
    `${garlicPaid.aoeMul.toFixed(3)} vs ${rarityMul(top)}`);

  // --- every upgrade declares a family ---
  const noFamily = CONFIG.upgrades.filter((u) => !u.family).map((u) => u.id);
  check('every upgrade declares a family', !noFamily.length, noFamily.join(', ') || '38 of 38');

  // --- the floor tier changes nothing at all ---
  let drift = [];
  for (const u of CONFIG.upgrades) {
    const a = baseStats(); applyWithRarity(u, a, ids[0]);
    const b = baseStats(); u.apply(b);
    for (const k in b) if (a[k] !== b[k]) drift.push(`${u.id}.${k}`);
  }
  check('the floor tier is byte-identical to a bare apply()', !drift.length,
    drift.slice(0, 3).join(', ') || 'all 38 upgrades');
}

console.log(failures ? `\nFAIL — ${failures} problem(s)` : '\nPASS — all checks');
process.exit(failures ? 1 : 0);
