#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:levelorb
//
// THE LEVEL BLOB — the pickup that adds a stack to a card you already hold.
//
// Two halves, and they fail in completely different ways:
//
//   THE PAYOUT is a rule about the BUILD, and every way it can be wrong is
//   silent. A blob that ignores `maxStacks` is the only route in the game past
//   a ceiling every card in the level-up menu respects, and nothing reports it
//   — the stat block simply keeps climbing. A blob that adds its stack at the
//   floor tier quietly dilutes a card the player took as an epic, and the only
//   symptom is a number being smaller than it should be. Neither is visible in
//   a screenshot or in a playthrough.
//
//   THE COLOUR is on the musical grid, and the two things that go wrong there
//   are both invisible too. Counting the note as a WINDOW rather than as an
//   EDGE either fires many times per beat or misses beats entirely, depending
//   on the frame rate — and this project has been bitten by exactly that
//   before. And a random hue DOES NOT BLOOM: the bright pass thresholds Rec.709
//   luminance, so an unnormalised roll spends a third of its cycle looking
//   switched off, which reads as a rendering bug rather than as an effect.
//
// The LOOK is not attempted here and cannot be: the heat is injected GLSL, a
// compile error renders nothing and throws nothing Node can see, and what
// catches that is a served page with a real GL context.
//
//   node --import ./tools/vite-loader.mjs tools/level-orb-test.mjs
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import {
  growBlob, createLevelOrb, updateLevelOrb, disposeLevelOrb,
  setLevelOrbScale, nextBlobHue, levelOrbColor,
} from '../path/src/systems/levelOrb.js';
import { updateBeatSync, beatsNow, divisionBeats } from '../path/src/systems/beatSync.js';
import { currentBpm } from '../path/src/systems/music.js';
import { player, levelableUpgrades } from '../path/src/entities/player.js';
import { strikeReach } from '../path/src/systems/strike.js';
import { baseStats } from '../path/src/stats.js';
import { bounds } from '../path/src/arena.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const DT = 1 / 60;
const BLOB = CONFIG.levelPickup.blob;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEEDS = [1, 7, 13, 42, 99, 404, 1234, 31337];

const REC709 = [0.2126, 0.7152, 0.0722];
const lumOf = (c) => REC709[0] * c.r + REC709[1] * c.g + REC709[2] * c.b;

console.log('The level blob');
console.log(`  cadence ${CONFIG.levelPickup.spawnMin}-${CONFIG.levelPickup.spawnMax}s · lives ${CONFIG.levelPickup.lifetime}s`);
console.log(`  colour: one per ${BLOB.colorSync}, ${BLOB.colorMode} mode, target luminance ${BLOB.lumTarget}`);
console.log(`  tempo ${currentBpm()} bpm`);

// ===========================================================================
section('The body — grown, and no two the same');
{
  const boxes = SEEDS.map((seed) => {
    const geo = growBlob(mulberry32(seed));
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    const out = { verts: geo.attributes.position.count, size };
    geo.dispose();
    return out;
  });

  // NORMALISED TO `fit`, longest axis, so a lucky roll is not a third bigger
  // than an unlucky one. This is what lets assets.csv own the actual size.
  const longest = boxes.map((b) => Math.max(b.size.x, b.size.y, b.size.z));
  check('every blob is normalised to the configured fit',
    longest.every((L) => Math.abs(L - BLOB.fit) < 1e-4),
    longest.map((L) => L.toFixed(3)).join(', '));

  // ...AND THEY ARE STILL DIFFERENT SHAPES. Same longest axis, different
  // PROPORTIONS — which is the only thing left that can vary once the fit is
  // pinned, and the whole claim the asset makes.
  const ratios = boxes.map((b) => b.size.y / (b.size.x || 1));
  const spread = Math.max(...ratios) - Math.min(...ratios);
  check('...and no two are the same shape', spread > 0.05,
    ratios.map((r) => r.toFixed(3)).join(', '));

  // A seeded grower has to be a FUNCTION of its seed, or nothing above this
  // line means anything.
  const a = growBlob(mulberry32(42));
  const b = growBlob(mulberry32(42));
  const same = a.attributes.position.array.every((v, i) => v === b.attributes.position.array[i]);
  check('the same seed grows the same blob', same);
  a.dispose();
  b.dispose();

  // A LUMPY BALL, not a sphere: without the displacement every check above
  // still passes and the pickup is a third tinted primitive.
  const geo = growBlob(mulberry32(7));
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  let rMin = Infinity;
  let rMax = 0;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = v.length();
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  check('it is lumpy rather than round', rMax / rMin > 1.2,
    `radius ${rMin.toFixed(3)}..${rMax.toFixed(3)}`);
  geo.dispose();
}

// ===========================================================================
section('The colour — a new one every note, and every one of them blooms');
{
  const orb = createLevelOrb(mulberry32(3));
  const u = orb.material.userData.__levelBlob;

  // Ten seconds of transport, counting the colour CHANGES. Counted off the
  // uniform rather than off the internal cycle, because what a player sees is
  // the uniform — and derived against the beat clock, so the expected figure is
  // a musical one and not a wall-clock one.
  let notes = 0;
  let last = u.uLevelB.value.clone();
  const lums = [];
  const peaks = [];
  for (let i = 0; i < 60 * 10; i++) {
    updateBeatSync(DT);
    updateLevelOrb(orb, DT, DT);
    if (!u.uLevelB.value.equals(last)) {
      last = u.uLevelB.value.clone();
      lums.push(lumOf(last));
      peaks.push(Math.max(last.r, last.g, last.b));
      notes++;
    }
  }
  const beats = beatsNow();
  const perNote = divisionBeats(BLOB.colorSync) || 1;
  const expected = beats / perNote;
  check('one colour change per configured division',
    Math.abs(notes - expected) <= 1.5,
    `${notes} changes in ${beats.toFixed(1)} beats, expected about ${expected.toFixed(1)}`);

  // EVERY hue it rolled GLOWS. This is the check the whole colour-mode
  // machinery exists for: a naive roll leaves a third of the wheel under the
  // bright pass's line, and on those notes the blob simply stops glowing.
  //
  // Measured at the CORE and not on the body, because that is where the halo
  // is made: the body is tuned to sit just under the threshold on purpose (see
  // CONFIG.levelPickup.blob.lumTarget) and the white added on top of it — one
  // number on every channel, so exactly that much luminance — is what crosses.
  //
  // CONFIG.bloom, not CONFIG.post.bloom: the second is a path that does not
  // exist, and reading it silently fell back to a default that was very nearly
  // right, which is how a check like this goes quietly wrong.
  const threshold = CONFIG.bloom?.threshold ?? 0.55;
  const core = BLOB.core ?? 0;
  const dark = lums.filter((L) => L + core <= threshold);
  check('every colour it rolled glows at the core',
    lums.length > 5 && dark.length === 0,
    `${lums.length} colours, dimmest core ${(Math.min(...lums) + core).toFixed(2)} vs threshold ${threshold}`);

  // ...AND THEY ARE ALL AS BRIGHT AS EACH OTHER, which is what `even` mode
  // buys and the reason it is what ships. A hue over the line but twice as
  // bright as its neighbour is the same failure one step milder: the blob
  // visibly surges and sags through its own cycle, which reads as flicker
  // rather than as colour. Measured at 3.5x on screen under `lum` mode — see
  // the note on CONFIG.levelPickup.blob.colorMode.
  const spread = Math.max(...lums) / Math.min(...lums);
  check('...and every one of them is the same brightness', spread < 1.05,
    `${spread.toFixed(3)}x spread`);

  // ...AND NONE OF THEM IS COMPRESSED BY THE COMPOSITE. The equal brightness
  // above survives to the screen only while every hue's PEAK CHANNEL stays
  // under the soft shoulder: past it, all three channels are scaled by one
  // factor derived from that peak (see systems/post.js), and two hues with
  // different peaks are then dimmed by different amounts. That is exactly how
  // the 3.5x happened, and it is invisible from the luminance alone.
  const knee = CONFIG.bloom?.knee ?? 0.8;
  check('...and no hue is driven past the composite\'s knee',
    peaks.length > 5 && Math.max(...peaks) <= knee + 1e-6,
    `highest peak channel ${Math.max(...peaks).toFixed(2)} vs knee ${knee}`);

  // THE CROSSFADE runs and lands. `uLevelMix` reaching 1 before the next note
  // is what makes A and B two real colours rather than a permanent blur.
  check('the crossfade completes inside a note', u.uLevelMix.value === 1,
    `mix ${u.uLevelMix.value.toFixed(2)}`);

  disposeLevelOrb(orb);
}
{
  // THE NOTE IS AN EDGE, NOT A WINDOW, and this is the check that says so:
  // stepping the same ten seconds at four times the frame rate must produce the
  // SAME number of changes. A "is the cycle inside the first few hundredths"
  // test passes at 60fps and fires four times per note at 240.
  const count = (fps) => {
    const dt = 1 / fps;
    const orb = createLevelOrb(mulberry32(11));
    const u = orb.material.userData.__levelBlob;
    let last = u.uLevelB.value.clone();
    let n = 0;
    for (let i = 0; i < fps * 8; i++) {
      updateBeatSync(dt);
      updateLevelOrb(orb, dt, dt);
      if (!u.uLevelB.value.equals(last)) { last = u.uLevelB.value.clone(); n++; }
    }
    disposeLevelOrb(orb);
    return n;
  };
  const slow = count(30);
  const fast = count(240);
  check('the note count does not depend on the frame rate',
    Math.abs(slow - fast) <= 1, `${slow} at 30fps vs ${fast} at 240fps`);
}
{
  // THE HUE ALWAYS MOVES. Two consecutive rolls landing near each other is a
  // beat on which the effect looks broken, and a plain random hue does it about
  // as often as anything else.
  const step = BLOB.hueStep ?? 0.18;
  const rand = mulberry32(5);
  let h = 0.4;
  let worst = 1;
  let outOfRange = 0;
  for (let i = 0; i < 4000; i++) {
    const next = nextBlobHue(h, rand, step);
    if (!(next >= 0 && next < 1)) outOfRange++;
    // Round the wheel, so 0.99 -> 0.01 is a small step and not a huge one.
    const d = Math.abs(next - h);
    worst = Math.min(worst, Math.min(d, 1 - d));
    h = next;
  }
  check('every hue step clears the configured minimum', worst >= step - 1e-9,
    `smallest step ${worst.toFixed(4)} vs ${step}`);
  check('...and never leaves the wheel', outOfRange === 0, `${outOfRange} out of range`);
}

// ===========================================================================
section('The object — its own geometry, its own material, both given back');
{
  const orb = createLevelOrb(mulberry32(21));
  const other = createLevelOrb(mulberry32(22));
  check('two blobs share no material', orb.material !== other.material);
  check('...and no geometry', orb.geometry !== other.geometry);

  // The size multiplier survives the pop. The blob swells on every note, so a
  // scale written straight onto the mesh is overwritten by the first kick —
  // which is why the spawner hands it to the module instead.
  setLevelOrbScale(orb, 2.2);
  let peak = 0;
  let trough = Infinity;
  for (let i = 0; i < 240; i++) {
    updateBeatSync(DT);
    updateLevelOrb(orb, DT, DT);
    peak = Math.max(peak, orb.scale.x);
    trough = Math.min(trough, orb.scale.x);
  }
  // Never SMALLER than the multiplier, and never bigger than the multiplier
  // plus the kick — which together say the swell is on top of the size rather
  // than instead of it. The failure this is guarding is a scale written onto
  // the mesh at spawn and then overwritten by the first note.
  check('the asset\'s size multiplier survives the note kick',
    trough >= 2.2 - 1e-6 && peak <= 2.2 * (1 + (BLOB.pop ?? 0)) + 1e-6,
    `scale ${trough.toFixed(3)}..${peak.toFixed(3)} from a base of 2.2`);
  check('...and it does kick', peak > trough, `${(peak / trough).toFixed(3)}x`);

  // The burst takes the colour it was actually wearing.
  const hex = levelOrbColor(orb);
  check('it can report the colour it is wearing', hex >= 0 && hex <= 0xffffff,
    `#${hex.toString(16).padStart(6, '0')}`);

  let disposed = 0;
  orb.geometry.dispose = () => { disposed++; };
  orb.material.dispose = () => { disposed++; };
  disposeLevelOrb(orb);
  check('both are given back when it leaves', disposed === 2, `${disposed} of 2`);
  disposeLevelOrb(other);
}

// ===========================================================================
section('The payout — one more stack of something already held');
{
  const cards = CONFIG.upgrades.filter((u) => u.enabled !== false);
  const capped = cards.find((u) => u.maxStacks != null && u.maxStacks > 1);
  const open = cards.find((u) => u.maxStacks == null && u.id !== capped?.id);
  check('the roster has both a capped card and an uncapped one to test with',
    !!capped && !!open, `${capped?.id} / ${open?.id}`);

  const hold = (picks) => { player.upgrades = picks; };

  hold([]);
  check('an empty build can level nothing', levelableUpgrades().length === 0);

  hold([{ id: open.id, rarity: 'common' }]);
  const one = levelableUpgrades();
  check('one held card is one thing to level',
    one.length === 1 && one[0].id === open.id, one.map((e) => e.id).join(','));
  check('...counted at the stack it is on', one[0].count === 1, `${one[0].count}`);

  // THE CAP. Every card in the level-up menu is dropped from the offer pool at
  // maxStacks (see availableUpgrades), and this pickup must not be the one
  // route past it.
  hold(Array.from({ length: capped.maxStacks }, () => ({ id: capped.id, rarity: 'common' })));
  check('a card at its cap cannot be levelled further',
    levelableUpgrades().length === 0,
    `${capped.id} at ${capped.maxStacks}/${capped.maxStacks}`);

  hold(Array.from({ length: capped.maxStacks - 1 }, () => ({ id: capped.id, rarity: 'common' })));
  check('...but one short of it can', levelableUpgrades().length === 1);

  // THE TIER. The stack is added at the best rarity this card has already been
  // taken at — recomputeStats replays every pick at its own tier, so a floor
  // stack of an epic card is worth measurably less than the ones beside it.
  const tiers = CONFIG.rarities.map((r) => r.id);
  if (tiers.length > 1) {
    hold([
      { id: open.id, rarity: tiers[0] },
      { id: open.id, rarity: tiers[tiers.length - 1] },
    ]);
    const best = levelableUpgrades()[0];
    check('the next stack takes the best tier already held',
      best?.rarity === tiers[tiers.length - 1], `${best?.rarity}`);
  }

  // A card switched off in upgrades.csv is out of the game, even for a run
  // still holding one from before the row was disabled.
  const off = CONFIG.upgrades.find((u) => u.enabled === false);
  if (off) {
    hold([{ id: off.id, rarity: 'common' }]);
    check('a disabled card cannot be levelled', levelableUpgrades().length === 0, off.id);
  } else {
    console.log('  ..   no disabled card in the roster to check against');
  }
  hold([]);
}

// ===========================================================================
section('Strike distance — what "in reach of the weak spot" means');
{
  const s = baseStats();
  const reach = strikeReach(s);
  const c = CONFIG.strike.charge;
  const travel = s.strikeDashSpeed * s.strikeDashDuration * c.reachMulMax;

  check('the reach is a real distance', reach > 0, `${reach.toFixed(2)}u`);
  check('...the full-charge dash plus the body that does the hitting',
    Math.abs(reach - (travel + s.hitRadius)) < 1e-9,
    `${travel.toFixed(2)} + ${s.hitRadius} = ${reach.toFixed(2)}`);

  // THE MAXIMUM, not what the meter holds now. The tip it serves is a question
  // about whether a spot is attackable at all, and a reach that moved with the
  // charge would put the line on screen and take it off again as the bar filled.
  check('...and it does not shrink at an empty meter',
    strikeReach(s) === reach, `${reach.toFixed(2)}u`);

  // Big enough to be a useful gate and small enough to be one at all: a reach
  // wider than the arena would mean the tip fired the moment a boss arrived,
  // from anywhere, which is the "near the boss" test this deliberately is not.
  check('it is well inside the arena', reach < bounds.width / 2,
    `${reach.toFixed(2)}u vs a ${bounds.width}u arena`);

  // A movement build reaches further, which is the property that makes this a
  // stat question rather than a constant.
  const fast = baseStats();
  fast.strikeDashSpeed *= 1.5;
  check('a faster dash reaches further', strikeReach(fast) > reach,
    `${strikeReach(fast).toFixed(2)}u vs ${reach.toFixed(2)}u`);
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'all good'}\n`);
process.exit(failures ? 1 : 0);
