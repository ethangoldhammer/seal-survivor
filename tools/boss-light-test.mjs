#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:killlight
//
// THE LIGHT ON THE KILL — systems/bossLight.js.
//
// A hero shaft on the seal and a cold wash on the animal it just beat, raised
// so that the trophy photograph is of two readable bodies rather than two
// silhouettes. Every way this can be wrong renders something:
//
//   THE WRONG CLOCK    The kill shot holds the water at CONFIG.boss.kill.hold
//                      for a beat and a half. Driven by the dilated delta the
//                      light still comes on — at about a tenth of the way up,
//                      several seconds after the picture it exists for.
//
//   BEHIND THE SMOKE   The explosion is the brightest thing in the frame for a
//                      third of a second either side of the shutter. A key that
//                      is still climbing underneath it is a key nobody can tell
//                      was switched on, and the lead has to be derived from the
//                      boom's rather than kept longer than a copy of it.
//
//   STILL CLIMBING     A light at 70% in the photograph is a photograph of a
//                      light coming on. It has to be flat at the shutter, which
//                      is a statement about the envelope and the lead together.
//
//   FIRING FOREVER     The trigger in systems/bossCorpse.js is a threshold that
//                      stays true for the rest of the hold, exactly like the
//                      explosion's. Without its own latch it is a fresh light
//                      every frame, which never finishes rising.
//
//   A POOLED BODY      The lift swaps per-instance materials onto the corpse.
//                      Left attached when the body goes back to the pool, the
//                      next creature to wear that visual carries a boss's key
//                      light around the arena for the rest of the run.
//
//   A ROUND WASH       Sized off one radius, the glow behind a thirty-unit
//                      shark lights its middle and leaves a dark nose and a
//                      dark tail sticking out of it — which at print size is
//                      worse than no wash at all.
//
// NO SCENE IS INSTALLED, deliberately. The shaft and the wash are canvas
// textures and a Node harness has no 2D context (three.js throws from inside
// CanvasTexture without one), so the module is driven with `scene` left null:
// the timing, the latch, the measurement and the material lift all run, and the
// cone's SHAPE is checked through `shaftAlpha`, which is split out of the bake
// for exactly this reason.
//
// Everything expected is derived from CONFIG. imported-tuning.json is merged at
// import and wins over config.js, so a literal here would test the tuning file
// rather than the code.
//
//   node --import ./tools/vite-loader.mjs tools/boss-light-test.mjs
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { snapshotMoment } from '../path/src/systems/bossKill.js';
import { bossBoomLead } from '../path/src/systems/bossBoom.js';
import {
  bossLightState, bossLightLead, bossLightSeconds, bossLightEnvelope,
  fireBossLight, updateBossLight, resetBossLight, dropBossLightSubject,
  bossLightSubject, shaftAlpha, bladeCentre,
} from '../path/src/systems/bossLight.js';
import { attachHitShape, tickHitShapes } from '../path/src/systems/hitShape.js';

let failures = 0;
const section = (t) => console.log(`\n${t}`);
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const L = CONFIG.boss.light;
const CORPSE = CONFIG.boss.corpse;
const DT = 1 / 60;

// A body with a real measured hitbox, out of primitives rather than off disk —
// the same trick tools/boss-boom-test.mjs uses, and needed here for the same
// reason: the wash is shaped by the hitbox, so a point-and-radius stand-in
// cannot reach the branch that matters.
function longBody(halfLength = 12, halfThick = 2.2, at = [0, 0]) {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x223344 }),
    );
    m.position.set((i / 4 - 0.5) * 2 * (halfLength - halfThick), 0, 0);
    m.scale.setScalar(halfThick);
    g.add(m);
  }
  g.position.set(at[0], at[1], 0);
  g.updateMatrixWorld(true);
  const shape = attachHitShape(g, `__lit_${halfLength}_${halfThick}__`);
  tickHitShapes();
  return {
    mesh: g, visual: g, hitShape: shape, radius: halfLength,
    assetKey: '__none__', vx: 0, vy: 0,
  };
}

console.log('\nthe light on the kill\n');

// --- THE MOMENT -------------------------------------------------------------
section('the moment');

check('the light is up before the smoke',
  bossLightLead() > bossBoomLead(),
  `light ${bossLightLead().toFixed(2)}s ahead of the shutter, smoke ${bossBoomLead().toFixed(2)}s — `
  + 'the cloud is the brightest thing in the frame and a key rising under it is invisible');

check('...and at full by the time the smoke arrives',
  bossLightEnvelope(bossLightLead() - bossBoomLead()) >= 0.999,
  `${bossLightEnvelope(bossLightLead() - bossBoomLead()).toFixed(3)} of the way up when the `
  + 'first ring is born');

check('the envelope is flat at the shutter',
  bossLightEnvelope(bossLightLead()) >= 0.999,
  `${bossLightEnvelope(bossLightLead()).toFixed(3)} — a light at 70% in the photograph is a `
  + 'photograph of a light coming on');

check('...and it is still on for the print',
  // ui/snapshotPrint.js flies the picture out of the frame after the shutter.
  // The world behind it is still being drawn, and a key that dropped on the
  // frame the picture was taken would be a visible cut under a still image.
  bossLightEnvelope(bossLightLead() + (CORPSE.afterShot ?? 0.18)) > 0.5,
  `${bossLightEnvelope(bossLightLead() + (CORPSE.afterShot ?? 0.18)).toFixed(2)} when the body bursts`);

check('it does end', bossLightEnvelope(bossLightSeconds() + 0.001) === 0,
  `still ${bossLightEnvelope(bossLightSeconds() + 0.001)} after ${bossLightSeconds().toFixed(2)}s`);

// The whole point of the lead, replayed through the countdown that actually
// fires it. Modelled here rather than driven through updateBossCorpses, which
// needs a posed creature this harness has no model to build — the same
// arrangement the boom test's latch section uses.
{
  const hold = snapshotMoment() + (CORPSE.afterShot ?? 0.18);
  const threshold = (CORPSE.afterShot ?? 0.18) + bossLightLead();
  let left = hold;
  let lit = false;
  let firedAt = null;
  let fired = 0;
  for (let t = 0; t < hold; t += DT) {
    if (!lit && left <= threshold) { lit = true; fired += 1; firedAt = t; }
    left -= DT;
  }
  check('one boss, one light', fired === 1, `${fired} raised across the hold`);
  // What matters is not when it fires but that it is flat by the shutter, which
  // is `snapshotMoment` after the kill.
  const atShutter = bossLightEnvelope(snapshotMoment() - firedAt);
  check('...flat at the shutter, through the real countdown', atShutter >= 0.999,
    `raised at ${firedAt.toFixed(2)}s, shutter at ${snapshotMoment().toFixed(2)}s, level ${atShutter.toFixed(3)}`);
}

// --- THE CLOCK --------------------------------------------------------------
section('the clock');
{
  const e = longBody();
  resetBossLight();
  fireBossLight(e);
  const hold = Math.max(0.01, CONFIG.boss.kill.hold ?? 0.12);
  // The same wall time, fed at the rate the water is running during the beat.
  for (let t = 0; t < bossLightLead(); t += DT) updateBossLight(DT * hold, null, null);
  const onWater = bossLightState.level;

  resetBossLight();
  fireBossLight(e);
  for (let t = 0; t < bossLightLead(); t += DT) updateBossLight(DT, null, null);
  const onWall = bossLightState.level;

  check('the water\'s clock would not have delivered it', onWater < onWall * 0.5,
    `${onWater.toFixed(3)} on the dilated clock vs ${onWall.toFixed(3)} on the wall`);
  check('...and the wall clock does', onWall >= 0.999, `${onWall.toFixed(3)}`);
  resetBossLight();
}

// A frame long enough to cross the whole rise still arrives at full rather than
// skipping the envelope.
{
  const e = longBody();
  resetBossLight();
  fireBossLight(e);
  updateBossLight(bossLightLead(), null, null);
  check('a dropped frame costs the ramp, never the level',
    bossLightState.level >= 0.999, `${bossLightState.level.toFixed(3)}`);
  resetBossLight();
}

// --- THE WASH IS SHAPED LIKE THE ANIMAL -------------------------------------
section('the wash');
{
  const e = longBody(12, 2.2, [4, -3]);
  resetBossLight();
  fireBossLight(e);
  const s = bossLightSubject();
  check('it is lighting something', s.live);
  check('...at the body, not at the origin',
    Math.abs(s.x - 4) < 3 && Math.abs(s.y + 3) < 3, `${s.x.toFixed(2)}, ${s.y.toFixed(2)}`);
  check('...and it is longer than it is tall', s.rx > s.ry * 2,
    `${s.rx.toFixed(2)} x ${s.ry.toFixed(2)} — a round glow on a long animal lights its `
    + 'middle and leaves both ends in the water');
  resetBossLight();
}

{
  // The fallback. The king crab has no hit shape at all and is the biggest boss
  // in the game, so measuring nothing has to give back a usable size rather
  // than nothing at all.
  resetBossLight();
  fireBossLight({ mesh: { position: { x: 0, y: 0 } }, radius: 6, assetKey: '__none__' });
  const s = bossLightSubject();
  check('a body with no hitbox is still lit', s.live && s.rx > 0 && s.ry > 0,
    `${s.rx} x ${s.ry}`);
  resetBossLight();
}

check('nothing to light is still a hero light', fireBossLight({}) === true);
resetBossLight();
check('...and no light at all with no body', fireBossLight(null) === false);

// --- THE LIFT ---------------------------------------------------------------
// The half that actually puts something back inside the silhouette, and the
// half that can contaminate the visual pool.
section('the lift on the body');
{
  const e = longBody();
  const mat = e.visual.children[0].material;
  const cold = mat.color.getHex();
  resetBossLight();
  fireBossLight(e);
  check('the body has a lift attached', bossLightSubject().lifted);
  for (let t = 0; t < bossLightLead(); t += DT) updateBossLight(DT, null, null);
  const lit = e.visual.children[0].material;
  check('...and the hide actually came up',
    lit.color.getHex() !== cold || lit !== mat,
    'the material is unchanged, which is what a lift written to the wrong object looks like');

  // AND IT LETS GO BEFORE THE POOL DOES. systems/bossCorpse.js calls this from
  // burst(), before releaseVisual — the one ordering that stands between this
  // effect and every future creature wearing that body.
  dropBossLightSubject(e);
  check('the body is let go before it is pooled', !bossLightSubject().lifted);
  const after = e.visual.children[0].material;
  check('...cold again', after.color.getHex() === cold,
    `#${after.color.getHex().toString(16)} vs #${cold.toString(16)}`);

  // The wash outlives the body on purpose: it is what is over the wreckage
  // while the print flies to the corner.
  check('the wash outlives the body', bossLightSubject().live);
  resetBossLight();
}

{
  // A reset drops everything, because a reset is a restart, a death, or the
  // tuner switching it off — and none of them wants a shaft standing over a
  // menu.
  const e = longBody();
  const cold = e.visual.children[0].material.color.getHex();
  resetBossLight();
  fireBossLight(e);
  updateBossLight(bossLightLead(), null, null);
  resetBossLight();
  check('a reset puts it out', bossLightState.level === 0 && bossLightState.t < 0);
  check('...and hands the body back cold',
    e.visual.children[0].material.color.getHex() === cold && !bossLightSubject().live);
}

// --- THE SHAFT --------------------------------------------------------------
// The cone, read off the pure function the bake uses. Every check here is a
// shape that would otherwise only be visible on screen.
section('the shaft');
{
  const s = L.shaft ?? {};
  const halfAt = (v) => {
    // The half-width, in quad widths, where the cone has fallen to half of that
    // row's own peak. Measured rather than read off `topWidth`/`bottomWidth`,
    // so the taper is asserted through what the texture actually gets.
    const peak = shaftAlpha(0, v);
    if (!(peak > 0)) return 0;
    let u = 0;
    while (u < 0.5 && shaftAlpha(u, v) > peak * 0.5) u += 0.002;
    return u;
  };
  check('the middle is the brightest part of a row',
    shaftAlpha(0, 0.5) > shaftAlpha(0.2, 0.5) && shaftAlpha(0.2, 0.5) > shaftAlpha(0.45, 0.5));
  check('it has no edge', shaftAlpha(0.499, 0.5) < 0.02,
    `${shaftAlpha(0.499, 0.5).toFixed(4)} at the quad's own edge — anything visible here is a `
    + 'rectangle with a gradient in it');
  check('the light runs out going down',
    shaftAlpha(0, 0.25) > shaftAlpha(0, 0.75),
    `${shaftAlpha(0, 0.25).toFixed(3)} near the top vs ${shaftAlpha(0, 0.75).toFixed(3)} near the `
    + 'bottom — even brightness down a band reads as a wall, not as a god ray');
  check('...and it fades in at the top rather than starting',
    shaftAlpha(0, 0) < 0.02 && shaftAlpha(0, (s.capFade ?? 0.1) * 1.5) > 0.2,
    `${shaftAlpha(0, 0).toFixed(3)} at the very top — the surface is off the top of most shots, `
    + 'so a shaft that simply begins reads as the quad it is drawn on');
  check('it is a cone, not a stripe', halfAt(0.8) > halfAt(0.2) * 1.3,
    `half-width ${halfAt(0.2).toFixed(3)} up top vs ${halfAt(0.8).toFixed(3)} at the bottom`);
  // ...AND IT STILL ARRIVES. A falloff taken to zero at the bottom is the
  // physically honest one and it is the wrong picture: the cone is brightest
  // thirty units above the seal and spent by the time it reaches it, so the
  // hero light is a lit patch of empty water with a dark animal under it.
  check('the light is still there when it lands',
    shaftAlpha(0, 1) > shaftAlpha(0, 0.2) * 0.3,
    `${shaftAlpha(0, 1).toFixed(3)} at the landing vs ${shaftAlpha(0, 0.2).toFixed(3)} near the `
    + 'top — CONFIG.boss.light.shaft.endLevel is the number that decides this');
}

{
  // WHERE THE SHAFT ACTUALLY LANDS. A raked blade rotated about its CENTRE
  // swings its landing sideways by half a length: thirty units at a sixth of a
  // radian is two and a half units off the seal, which renders as a perfectly
  // good god ray aimed at the water beside the animal. Invisible to any check
  // that the shaft exists, is bright, and is the right length — so the landing
  // is asserted directly, by rotating the bottom edge back out of the centre
  // the module places.
  const s = L.shaft ?? {};
  const h = Math.max(1, s.height ?? 30);
  let worst = 0;
  for (const row of s.blades ?? []) {
    for (const sway of [-(row.sway ?? 0), 0, row.sway ?? 0]) {
      const lean = (s.tilt ?? 0.17) * (row.lean ?? 1) + sway;
      const bh = h * (row.height ?? 1);
      const c = bladeCentre(0, 0, bh, lean);
      // The quad's local (0, -h/2) under a rotation of `lean`.
      const bx = c.x + Math.sin(lean) * (bh / 2);
      const by = c.y - Math.cos(lean) * (bh / 2);
      worst = Math.max(worst, Math.hypot(bx, by));
    }
  }
  check('the shaft lands on the seal at every rake', worst < 1e-9,
    `off by ${worst.toFixed(3)} world units at the worst blade and sway`);
}

{
  // FRONT AND BACK. What separates a fake volumetric from a decal is that some
  // of it is between the camera and the subject: the seal's body sits at z 0,
  // so a blade at a positive z is in front of it and a negative one behind.
  const blades = L.shaft?.blades ?? [];
  const front = blades.filter((b) => (b.z ?? 0) > 0);
  const back = blades.filter((b) => (b.z ?? 0) < 0);
  check('there are blades behind the seal', back.length > 0);
  check('...and at least one in front of it', front.length > 0,
    'all behind and the seal stands in a lit doorway rather than in a shaft');
  check('...and the front one is only haze',
    front.every((b) => (b.opacity ?? 1) <= 0.25),
    `${front.map((b) => b.opacity).join(', ')} — past about a fifth it stops being air and `
    + 'becomes a sheet of paper over the subject');
  check('the blades are at different rakes',
    new Set(blades.map((b) => b.lean ?? 1)).size > 1,
    'identical leans draw one cone several times, which has no depth in it at all');
}

// --- NO REAL LIGHT ----------------------------------------------------------
// The project rule, and it has no runtime signal in a headless harness: half
// this game's creatures are unlit MeshBasicMaterial by choice, so a light added
// here would illuminate some of the roster and none of the rest. Read off the
// module's own source, which is the only place the fact lives.
section('no real light');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../path/src/systems/bossLight.js', import.meta.url), 'utf8');
  const lights = src.match(/new THREE\.\w*Light\b/g) ?? [];
  check('no light is added to the scene', lights.length === 0,
    `${lights.join(', ')} — a SpotLight lights the standard-material half of the roster and `
    + 'does nothing whatever to the unlit half (see systems/beams.js)');
  check('...and the glow is additive geometry',
    src.includes('AdditiveBlending'), 'nothing here would reach an unlit body');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
