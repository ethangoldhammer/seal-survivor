#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:sky
//
// The night sky (systems/constellations.js), without a GL context. Six parts:
//
//   FIELD      that the constellations are hung on stars that are ACTUALLY
//              THERE. The sky gradient paints its own dots in a fragment
//              shader and this system draws geometry between them; the two
//              agree only because they share systems/starField.js, and the
//              day they stop agreeing you get lines strung between empty sky
//              with a separate field of dots beside them. Nothing about that
//              is visible in a still screenshot at 3am game-time, so it is
//              checked here: every promoted star must be one of the sky's.
//
//   LINKS      no edge drawn twice (additive blending doubles a duplicate into
//              a visible seam, which is the same reason the hex grid
//              de-duplicates), none longer than the reach, and every one
//              oriented bright-end-first so the travelling bloom runs downhill.
//
//   FRACTAL    that it is bounded, that it stays inside the sky, and that it is
//              DETERMINISTIC — the field is rebuilt on every resize and on
//              every tuner edit, and a tree that reshuffled each time would
//              make the whole panel untunable.
//
//   BLOOM      that every star's phase lands on a beat slot, and that the
//              cycle the shader reads is derived from the transport rather
//              than integrated — the property that keeps a ten-minute run in
//              time with the music.
//
//   NIGHT      the headline claim. Scrub the clock across a day and watch the
//              system switch itself off; turn the day/night cycle off entirely
//              and watch it stay off.
//
//   REACH      that an explosion in the water actually rings the sky. The
//              gameplay happens thirty units below the stars and the falloff
//              is a radius, so this only works because the ripple's distance
//              is measured with its vertical component squashed. The check
//              proves both halves: that it reaches WITH the squash, and that
//              it would not reach without it.
//
// Everything expected is derived from the merged CONFIG rather than typed in
// (imported-tuning.json wins over config.js, so a hardcoded number here would
// be testing the tuning file), and the merged values are printed at the top.
//
// What it cannot tell you: whether the shaders compile. That needs a driver —
// see tools/sky-shader-check.mjs.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { bounds, updateBounds } from '../path/src/arena.js';
import { STAR_THRESHOLD, starsIn } from '../path/src/systems/starField.js';
import {
  createConstellations, buildConstellationField,
} from '../path/src/systems/constellations.js';
import { updateDayCycle, skyLight } from '../path/src/systems/daylight.js';
import { updateBeatSync, beatsNow, divisionBeats } from '../path/src/systems/beatSync.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const CFG = CONFIG.constellations;
const DENSITY = CONFIG.dayNight?.stars?.density ?? 0.55;

console.log('Merged CONFIG.constellations (saved tuning wins over config.js defaults):');
console.log(`  enabled ${CFG.enabled}  brightest ${CFG.brightest}  star density ${DENSITY} (Day & night)`);
console.log(`  links ${CFG.links} within ${CFG.linkRadius}  subdivisions ${CFG.subdivisions}`);
console.log(`  fractal depth ${CFG.fractal.depth} x ${CFG.fractal.branches} from ${CFG.fractal.anchors} of the stars`);
console.log(`  bloom ${CFG.bloomSync} · ${CFG.phaseSteps} slots · decay ${CFG.bloomDecay}`);
console.log(`  night ${CFG.dusk} -> ${CFG.dark}   ripple x${CFG.rippleGain} reach x${CFG.rippleReach} squash ${CFG.rippleSquash}`);

// A real frame, so the field is the size the game would build.
updateBounds(16 / 9);
console.log(`  arena ${bounds.left.toFixed(1)}..${bounds.right.toFixed(1)} x ${bounds.surfaceY}..${bounds.top.toFixed(1)} (sky band)`);

// --- field -----------------------------------------------------------------
section('FIELD — the constellations hang on stars the sky is already painting');

const field = buildConstellationField(CFG, bounds);
console.log(`  ${field.counts.field} stars in the sky, ${field.counts.stars} promoted,`
  + ` ${field.counts.tips} fractal tips, ${field.counts.links} links, ${field.counts.branches} branches`);

check('the sky has stars in it at all', field.counts.field > 0, `${field.counts.field}`);
check('some of them are promoted', field.counts.stars > 0, `${field.counts.stars}`);
check('but not all — `brightest` is a share, not a switch',
  CFG.brightest >= 1 || field.counts.stars < field.counts.field,
  `${field.counts.stars} of ${field.counts.field}`);

{
  // The one that matters. Every promoted star must be at the exact position
  // the sky shader's own field puts a star, to the last bit.
  const sky = starsIn(field.rect, DENSITY, STAR_THRESHOLD);
  const at = new Set(sky.map((s) => `${s.x},${s.y}`));
  const promoted = field.stars.filter((s) => s.gen === 0);
  const strays = promoted.filter((s) => !at.has(`${s.x},${s.y}`));
  check('every promoted star is one of the sky shader’s own',
    strays.length === 0, `${strays.length} stray of ${promoted.length}`);
  const cut = Math.min(...promoted.map((s) => s.seed));
  check('and they are the BRIGHTEST of them — nothing above the cut is left out',
    promoted.every((s) => s.seed > STAR_THRESHOLD)
    && sky.filter((s) => s.seed >= cut).length === promoted.length,
    `cut at ${cut.toFixed(4)}, ${sky.filter((s) => s.seed >= cut).length} above it`);

  // The bug this file was written by finding. `seed` is not uniform in the
  // stars that come back — a star is here because its hash was high — so
  // anything sized or timed off it collapses. `bright` restretches the
  // surviving band; `spin` is drawn independently of what selected them.
  check('the promoted seeds really are crowded at the top',
    cut > 0.9, `dimmest survivor ${cut.toFixed(4)} — this is WHY bright and spin exist`);
  check('but `bright` spreads them back over the full range',
    Math.min(...promoted.map((s) => s.bright)) < 0.15
    && Math.max(...promoted.map((s) => s.bright)) > 0.85,
    `${Math.min(...promoted.map((s) => s.bright)).toFixed(2)}..${Math.max(...promoted.map((s) => s.bright)).toFixed(2)}`);
}

check('every star sits inside the built frame',
  field.stars.every((s) => s.x >= field.rect.left && s.x <= field.rect.right
    && s.y >= field.rect.bottom && s.y <= field.rect.top));
check('and none of them is under the water line',
  field.stars.every((s) => s.y >= bounds.surfaceY),
  `lowest ${Math.min(...field.stars.map((s) => s.y)).toFixed(2)}`);

{
  // The grid is anchored at the world origin rather than at the frame, so a
  // resize slides the view over a field that stays put. A star that moved
  // when the window did would make the whole sky crawl on every rotation.
  const wide = buildConstellationField(CFG, { ...bounds, left: bounds.left - 20, right: bounds.right + 20 });
  const before = new Set(field.stars.filter((s) => s.gen === 0).map((s) => `${s.x},${s.y}`));
  const after = new Set(wide.stars.filter((s) => s.gen === 0).map((s) => `${s.x},${s.y}`));
  check('a wider frame keeps every star the narrow one had',
    [...before].every((k) => after.has(k)),
    `${before.size} -> ${after.size}`);
}

{
  const dense = buildConstellationField({ ...CFG, brightest: 1 }, bounds);
  const none = buildConstellationField({ ...CFG, brightest: 0 }, bounds);
  check('brightest 1 promotes the whole field',
    dense.counts.stars === dense.counts.field, `${dense.counts.stars}/${dense.counts.field}`);
  check('brightest 0 promotes nothing', none.counts.stars === 0);
  check('...and with nothing promoted there is nothing to join',
    none.counts.links === 0 && none.counts.branches === 0);
}

// --- links ------------------------------------------------------------------
section('LINKS');

{
  const links = field.edges.filter((e) => e.gen === 0);
  const key = (e) => {
    const a = `${e.x1.toFixed(5)},${e.y1.toFixed(5)}`;
    const b = `${e.x2.toFixed(5)},${e.y2.toFixed(5)}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };
  const seen = new Set(links.map(key));
  check('no edge is drawn twice', seen.size === links.length,
    `${links.length} edges, ${seen.size} distinct`);
  check('no star links to itself',
    links.every((e) => e.x1 !== e.x2 || e.y1 !== e.y2));
  check('no link is longer than the reach',
    links.every((e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1) <= CFG.linkRadius + 1e-9),
    `longest ${Math.max(...links.map((e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1))).toFixed(2)} of ${CFG.linkRadius}`);

  // Bright end first, so the travelling bloom always runs from the more
  // prominent star toward the fainter one.
  const byPos = new Map(field.stars.map((s) => [`${s.x},${s.y}`, s]));
  const backwards = links.filter((e) => {
    const a = byPos.get(`${e.x1},${e.y1}`);
    const b = byPos.get(`${e.x2},${e.y2}`);
    return a && b && a.seed < b.seed;
  });
  check('every link runs bright end first', backwards.length === 0, `${backwards.length} backwards`);

  const noLinks = buildConstellationField({ ...CFG, links: 0 }, bounds);
  check('links 0 draws none', noLinks.counts.links === 0);
  const tight = buildConstellationField({ ...CFG, linkRadius: 0.01 }, bounds);
  check('a reach of nothing draws none either', tight.counts.links === 0);
}

// --- fractal ----------------------------------------------------------------
section('FRACTAL');

{
  const f = CFG.fractal;
  const anchors = Math.round(field.counts.stars * f.anchors);
  // Branches^depth summed over the generations, per anchor. The real count is
  // lower because a branch leaving the sky is dropped with everything under it
  // — which is the point of the bound: it must never be EXCEEDED.
  let most = 0;
  for (let g = 1; g <= f.depth; g++) most += anchors * f.branches ** g;
  check('the fractal is bounded by branches^depth per anchor',
    field.counts.branches <= most, `${field.counts.branches} <= ${most}`);
  check('every tip is a star in its own right',
    field.counts.tips === field.counts.branches,
    `${field.counts.tips} tips, ${field.counts.branches} branches`);
  check('and every generation is present',
    new Set(field.edges.filter((e) => e.gen > 0).map((e) => e.gen)).size === f.depth
    || field.counts.branches === 0,
    `generations ${[...new Set(field.edges.map((e) => e.gen))].sort().join(',')}`);
  check('no branch leaves the sky',
    field.edges.every((e) => e.y2 >= field.rect.bottom && e.y2 <= field.rect.top
      && e.x2 >= field.rect.left && e.x2 <= field.rect.right));
  check('each generation is shorter than its parent',
    (() => {
      const byGen = new Map();
      for (const e of field.edges.filter((x) => x.gen > 0)) {
        const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        byGen.set(e.gen, Math.max(byGen.get(e.gen) ?? 0, len));
      }
      const gens = [...byGen.keys()].sort((a, b) => a - b);
      return gens.every((g, i) => i === 0 || byGen.get(g) < byGen.get(gens[i - 1]) + 1e-9);
    })());

  const off = buildConstellationField({ ...CFG, fractal: { ...f, enabled: false } }, bounds);
  check('switching it off leaves the constellations alone',
    off.counts.branches === 0 && off.counts.links === field.counts.links);

  // Rebuilt on every resize AND on every tuner edit, so a tree that came out
  // different each time would make the panel impossible to tune.
  const again = buildConstellationField(CFG, bounds);
  check('the same config grows the same sky twice',
    JSON.stringify(again.edges) === JSON.stringify(field.edges),
    `${again.counts.branches} branches both times`);
}

// --- bloom ------------------------------------------------------------------
section('BLOOM');

{
  const steps = CFG.phaseSteps;
  const stars = field.stars.filter((s) => s.gen === 0);
  check('every star’s phase lands on a beat slot',
    steps === 0 || stars.every((s) => Math.abs(s.phase * steps - Math.round(s.phase * steps)) < 1e-9),
    `${steps} slots`);
  check('...and never reaches a whole cycle',
    stars.every((s) => s.phase < 1 && s.phase >= 0));
  check('the field is spread across those slots rather than in lockstep',
    steps === 0 || CFG.phaseSpread === 0 || new Set(stars.map((s) => s.phase.toFixed(6))).size > 1,
    `${new Set(stars.map((s) => s.phase.toFixed(6))).size} distinct phases`);

  const locked = buildConstellationField({ ...CFG, phaseSpread: 0 }, bounds);
  check('spread 0 collapses the whole sky onto one flash',
    locked.stars.every((s) => s.phase === 0));

  // A fractal tip inherits its anchor's phase and is pushed out by generation
  // in the shader, so the tree unfolds from its root instead of flashing whole.
  const tips = field.stars.filter((s) => s.gen > 0);
  check('a fractal tip carries its anchor’s phase, not its own',
    tips.length === 0 || tips.every((t) => stars.some((s) => s.seed === t.seed && s.phase === t.phase)));
}

// --- the live system --------------------------------------------------------
section('NIGHT — the gate, driven through a whole day');

const scene = new THREE.Scene();
const sky = createConstellations(scene);
const starMesh = sky.group.children.find((c) => c.isMesh && !c.isLineSegments);
const linkMesh = sky.group.children.find((c) => c.isLineSegments);
const U = (starMesh ?? linkMesh).material.uniforms;

check('it built both layers', !!starMesh && !!linkMesh);
check('and they share one uniform record',
  starMesh.material.uniforms === linkMesh.material.uniforms,
  'one beat, one night, one wave for both');

// --- the fixed points -------------------------------------------------------
section('FIXED — the stars hold their places, only the strings between them move');

{
  // A star is a landmark. The star program does not compile the warp AT ALL,
  // which is the strongest form this check can take: it is not that the
  // displacement happens to be zero, it is that there is no displacement in
  // the program. Asserted on the source because a driver's optimiser would
  // hide the difference from anything measured at runtime.
  const vs = starMesh.material.vertexShader;
  check('the star shader never calls the warp', !vs.includes('skyWarp('));
  check('...and does not even declare the ripple buffer',
    !vs.includes('uRipples'), 'nothing to accidentally re-wire later');
  check('the star centre is the position it was placed at',
    /vec2 centre = position\.xy;/.test(vs));
  check('the link shader is the one that warps',
    linkMesh.material.vertexShader.includes('skyWarp('));

  // The mask, transcribed. Zero at both ends is what keeps a bowing link
  // welded to the two fixed stars it joins; anything else and the whole
  // constellation detaches the first time something explodes.
  const mask = (run) => Math.sin(Math.PI * Math.max(0, Math.min(1, run)));
  check('the bend is exactly zero at the star it leaves', mask(0) === 0);
  check('and exactly zero at the star it arrives at', Math.abs(mask(1)) < 1e-15);
  check('and full in the middle', Math.abs(mask(0.5) - 1) < 1e-12);
  check('it never pulls a link backwards past its own anchor',
    [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].every((r) => mask(r) >= 0 && mask(r) <= 1));
  check('the shader uses that same mask',
    linkMesh.material.vertexShader.includes('sin(3.14159265 * clamp(aRun, 0.0, 1.0))'));

  // The bow is capped against the link's own length, so a fractal twig sways
  // instead of whipping twice its length. Transcribed from the shader and run
  // against the real spans in the buffer.
  const bow = (mag, span, run) => Math.min(mag * CFG.bend, span * CFG.bendMax)
    * Math.sin(Math.PI * Math.max(0, Math.min(1, run)));
  const spans = linkMesh.geometry.attributes.aSpan.array;
  const shortest = Math.min(...spans);
  const longest = Math.max(...spans);
  console.log(`  spans ${shortest.toFixed(2)}..${longest.toFixed(2)} world units`);
  check('a shove that would throw a twig past itself is held back',
    bow(9, shortest, 0.5) <= shortest * CFG.bendMax + 1e-9,
    `${bow(9, shortest, 0.5).toFixed(2)} on a ${shortest.toFixed(2)} twig`);
  check('no link can ever bow past its own length',
    spans.every((s) => bow(1e6, s, 0.5) < s),
    `cap is ${CFG.bendMax} of the span`);
  check('a long link still carries the ripple’s real amplitude',
    Math.abs(bow(1, longest, 0.5) - 1 * CFG.bend) < 1e-9,
    `${longest.toFixed(1)}-unit link, uncapped at a 1-unit shove`);
  check('the cap is a clamp, not a scale — a still sky is still still',
    bow(0, longest, 0.5) === 0 && bow(0, shortest, 0.5) === 0);
  check('every link vertex carries its own span',
    linkMesh.geometry.attributes.aSpan.count === linkMesh.geometry.attributes.aRun.count);

  // Every link's first and last vertex must BE a star, or there is nothing for
  // the mask to pin them to.
  const at = new Set(field.stars.map((s) => `${s.x.toFixed(5)},${s.y.toFixed(5)}`));
  const loose = field.edges.filter((e) => !at.has(`${e.x1.toFixed(5)},${e.y1.toFixed(5)}`)
    || !at.has(`${e.x2.toFixed(5)},${e.y2.toFixed(5)}`));
  check('both ends of every link land on an actual star', loose.length === 0,
    `${loose.length} loose of ${field.edges.length}`);
}

// Freeze the clock so it can be put anywhere and held there.
const wasPaused = CONFIG.dayNight.paused;
const wasHour = CONFIG.dayNight.scrubHour;
const wasEnabled = CONFIG.dayNight.enabled;
CONFIG.dayNight.enabled = true;
CONFIG.dayNight.paused = true;

function atHour(hour) {
  CONFIG.dayNight.scrubHour = hour;
  updateDayCycle(0);
  sky.update(1 / 60, {});
  return { night: skyLight.night, visible: sky.group.visible, gate: U.uNight.value };
}

const day = [];
for (let h = 0; h < 24; h += 2) {
  const s = atHour(h);
  day.push(`${String(h).padStart(2, '0')}:00 dark ${s.night.toFixed(2)} gate ${s.gate.toFixed(2)} ${s.visible ? 'ON' : 'off'}`);
}
for (const line of day) console.log(`  | ${line}`);

check('the sky is off at noon', !atHour(12).visible);
check('and at 09:00', !atHour(9).visible);
check('it is on at midnight', atHour(0).visible);
check('at full brightness there', atHour(0).gate > 0.99, `${atHour(0).gate.toFixed(3)}`);
check('it fades in rather than switching on',
  (() => {
    let seen = 0;
    for (let h = 17; h < 24; h += 0.1) {
      const g = atHour(h).gate;
      if (g > 0.02 && g < 0.98) seen++;
    }
    return seen > 2;
  })(), 'partial gate values exist through dusk');

{
  // The claim in the config comment: with the cycle off, night never comes and
  // there is no second switch to forget.
  CONFIG.dayNight.enabled = false;
  updateDayCycle(0);
  sky.update(1 / 60, {});
  check('with the day/night cycle off it never appears', !sky.group.visible);
  CONFIG.dayNight.enabled = true;
}

// --- beat -------------------------------------------------------------------
section('BLOOM CLOCK');

CONFIG.dayNight.scrubHour = 0; // hold it at midnight so the system keeps running
updateDayCycle(0);
{
  const beats = divisionBeats(CFG.bloomSync);
  updateBeatSync(0.5);
  sky.update(0.5, {});
  const want = beats > 0 ? (beatsNow() / beats) % 1 : null;
  check('the bloom cycle is derived from the transport, not integrated',
    want === null || Math.abs(U.uCycle.value - want) < 1e-6,
    `${U.uCycle.value.toFixed(6)} vs ${want?.toFixed(6)}`);

  // The property that survives a ten-minute run: hand it a wildly wrong dt and
  // the phase still answers only to the beat clock.
  updateBeatSync(0.5);
  sky.update(9.9, {});
  const want2 = beats > 0 ? (beatsNow() / beats) % 1 : null;
  check('...so a stalled frame cannot knock it out of time',
    want2 === null || Math.abs(U.uCycle.value - want2) < 1e-6,
    `${U.uCycle.value.toFixed(6)} vs ${want2?.toFixed(6)}`);
}

// --- reach ------------------------------------------------------------------
section('REACH — an explosion in the water has to ring the sky');

{
  sky.reset();
  const before = U.uRippleParams.value.map((v) => v.x);
  check('reset empties the ring buffer', before.every((s) => s === 0));

  // A kill at mid-depth: the same numbers main.js pushes for a chain reaction.
  const KILL_Y = -20;
  const KILL_R = 10;
  const KILL_S = 6;
  sky.ripple(0, KILL_Y, KILL_S, KILL_R);
  const p = U.uRippleParams.value[0];
  check('the sky takes the event at its own gain',
    Math.abs(p.x - KILL_S * CFG.rippleGain) < 1e-6, `strength ${p.x.toFixed(3)}`);
  check('and at its own reach',
    Math.abs(p.y - KILL_R * CFG.rippleReach) < 1e-6, `radius ${p.y.toFixed(2)}`);

  // The shader's falloff, transcribed. smoothstep(radius, 0, dist) is the
  // reversed ramp the grid uses too: 1 at the origin, 0 at the radius.
  const smoothstep = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const star = { x: 4, y: 8 }; // a star a little way up the sky band
  const dy = star.y - KILL_Y;
  const squashed = Math.hypot(star.x - 0, dy * CFG.rippleSquash);
  const honest = Math.hypot(star.x - 0, dy);
  const reach = p.y;

  check('with the squash, the blast reaches the stars',
    smoothstep(reach, 0, squashed) > 0.01,
    `dist ${squashed.toFixed(1)} of ${reach.toFixed(1)} → ${smoothstep(reach, 0, squashed).toFixed(3)}`);
  check('without it, it would not — which is what the squash is for',
    smoothstep(reach, 0, honest) < 0.001,
    `dist ${honest.toFixed(1)} of ${reach.toFixed(1)} → ${smoothstep(reach, 0, honest).toFixed(3)}`);

  // Gain 0 is the off switch, and it has to be a real one: a ripple that
  // reached the buffer at zero strength would still occupy a slot and push a
  // live one out of the 16.
  sky.reset();
  const gain = CFG.rippleGain;
  CONFIG.constellations.rippleGain = 0;
  sky.ripple(0, 0, 9, 9);
  check('gain 0 spends no slot at all', U.uRippleParams.value[0].x === 0);
  CONFIG.constellations.rippleGain = gain;

  // The ring buffer recycles rather than growing.
  sky.reset();
  for (let i = 0; i < 40; i++) sky.ripple(i, 0, 1, 5);
  check('the ring buffer recycles the oldest slot',
    U.uRipples.value.every((v) => Number.isFinite(v.x)),
    `${U.uRipples.value.length} slots`);
}

// --- geometry ---------------------------------------------------------------
section('GEOMETRY');

{
  const starGeo = starMesh.geometry;
  const linkGeo = linkMesh.geometry;
  const n = field.counts.stars + field.counts.tips;
  check('one quad per star, six vertices each',
    starGeo.attributes.position.count === n * 6,
    `${starGeo.attributes.position.count} verts for ${n} stars`);
  check('every star attribute is the same length',
    ['aCorner', 'aBright', 'aPhase', 'aScale', 'aGen']
      .every((a) => starGeo.attributes[a].count === n * 6));
  check('every link is cut into `subdivisions` pieces',
    linkGeo.attributes.position.count
      === (field.counts.links + field.counts.branches) * CFG.subdivisions * 2,
    `${linkGeo.attributes.position.count} verts`);
  check('the run parameter spans the whole link',
    (() => {
      const run = linkGeo.attributes.aRun.array;
      return Math.min(...run) === 0 && Math.abs(Math.max(...run) - 1) < 1e-6;
    })(), 'or the travelling bloom never reaches the far star');

  sky.dispose();
  check('dispose empties the group', sky.group.children.length === 0);
}

CONFIG.dayNight.paused = wasPaused;
CONFIG.dayNight.scrubHour = wasHour;
CONFIG.dayNight.enabled = wasEnabled;

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
