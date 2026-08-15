#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:animdebug
//
// Drives ui/animDebug.js under jsdom against the REAL animation controller on
// the REAL seal, because the panel's whole value is that it tells the truth
// about a system you cannot otherwise see. A panel that renders beautifully and
// reports the wrong state is worse than no panel — you would believe it.
//
// So every check below reads the rendered TEXT back and compares it to
// something independently known: a state we just drove the controller into, a
// one-shot we just triggered, a bone we know from the model file is stranded.
//
// jsdom must load before the loader hooks, or jsdom's own CJS require chain
// breaks with an unrelated error about './fallback/encoding.js'.
// ---------------------------------------------------------------------------

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// `navigator` is a getter-only global in modern Node — define it rather than
// assign, or this throws before a single line of the panel has run.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.localStorage = dom.window.localStorage;
// NOT window.performance — jsdom's delegates to the global one and swapping it
// in recurses until the stack blows.
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

await import('./vite-loader.mjs');

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const { readFileSync } = await import('node:fs');
const { resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const { installModel, createVisual } = await import('../path/src/assets.js');
const { createAnimationController, trackCoverage } = await import('../path/src/systems/animation.js');
const { startCelebration, updateCelebration, resetCelebration } = await import('../path/src/systems/celebrate.js');
const { player } = await import('../path/src/entities/player.js');
const { initAnimDebug } = await import('../path/src/ui/animDebug.js');

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const buf = readFileSync(resolve(HERE, '../public/models/furseal.glb'));
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '',
);
installModel('ship', gltf.scene, gltf.animations);

const scene = new THREE.Scene();
const body = createVisual('ship');
scene.add(body);
scene.updateMatrixWorld(true);

// Stand the real controller up on the real rig and hand it to the panel the
// same way the game does — through the shared `player` object.
player.body = body;
player.anim = createAnimationController(body);

initAnimDebug();
const panel = document.getElementById('svAnimDebug');
check('the panel mounted', panel != null);
check('...and starts hidden', panel.style.display === 'none');

const press = (key) => document.body.dispatchEvent(
  new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
);

// On document.body, not document — isTypingTarget reads e.target, and a bare
// document has no tagName for it to check.
press('j');
check('J opens it', panel.style.display === 'flex');

// The rAF loop is a setTimeout here, so one macrotask turn is a rendered frame.
const frame = () => new Promise((r) => setTimeout(r, 1));
const text = () => panel.textContent.replace(/\s+/g, ' ');

const DT = 1 / 60;
console.log('\nit reports the locomotion state the controller is actually in');
for (const state of ['swim', 'boost', 'surfaceIdle']) {
  player.anim.update(DT, state, false);
  await frame();
  check(`"${state}" is showing`, text().includes(`showing ${state}`), text().match(/showing \w+/)?.[0]);
}

console.log('\nit reports a one-shot, and stops reporting it when it expires');
{
  // `strike` rather than `bark`, and the state is forced on rather than
  // assumed. CONFIG.animation.oneShots is a live, SAVED setting — the tuning
  // file on this machine has `bark: false` — so a harness that just triggers
  // one and expects it to play is really testing whoever last touched a pill.
  const { CONFIG } = await import('../path/src/config.js');
  const wasOn = CONFIG.animation.oneShots.strike;
  CONFIG.animation.oneShots.strike = true;

  player.anim.trigger('strike');
  player.anim.update(DT, 'swim', false);
  await frame();
  check('the strike is named as holding the pose', /strike holding the pose/.test(text()),
    text().match(/\w+ holding the pose/)?.[0] ?? '(not found)');
  check('...with time left on it', /\d\.\d\ds left/.test(text()), text().match(/\d\.\d\ds left/)?.[0]);

  // Run it past its cap (strike is capped at 0.5s) and it must hand back.
  for (let i = 0; i < 120; i++) player.anim.update(DT, 'swim', false);
  await frame();
  check('once expired, locomotion owns the pose again', text().includes('locomotion owns the pose'));

  // A DISABLED one-shot must read as nothing happening rather than as a
  // missing clip — telling those two apart is most of what this panel is for.
  CONFIG.animation.oneShots.strike = false;
  player.anim.trigger('strike');
  player.anim.update(DT, 'swim', false);
  await frame();
  check('a one-shot switched off in the tuner never takes the pose',
    text().includes('locomotion owns the pose'));
  CONFIG.animation.oneShots.strike = wasOn;
}

console.log('\nit reports the celebration against the trophy frame');
{
  resetCelebration();
  startCelebration(() => 0); // 0 passes the chance roll and picks the first variant
  updateCelebration(0.2);
  player.anim.update(DT, 'swim', false);
  await frame();
  check('the variant is named', /clap|finsUp|flip|tailWag|headToss/.test(text()),
    text().match(/clap|finsUp|flip|tailWag|headToss/)?.[0]);
  check('...and it is on the WALL clock', text().includes('(wall)'));
  resetCelebration();
  await frame();
  check('it goes idle when nothing is celebrating', text().includes('idle — fires on a boss kill'));
}

console.log('\nit reports clip coverage honestly');
{
  await frame();
  // furseal.glb has no `bite` or `celebrate` clip and the panel must say so
  // rather than implying the model covers every state.
  check('the missing states are named', text().includes('no clip for:'), text().match(/no clip for: [^<]*/)?.[0]?.slice(0, 60));
  check('...including celebrate, which the player poses instead', /no clip for:[^|]*celebrate/.test(text()));
}

console.log('\nbone ownership matches what the model file actually says');
{
  await frame();
  const cov = trackCoverage(body);
  // Independently known from the GLB: swim leaves these five unwritten.
  for (const bone of ['uparm_L_012', 'arm_L_013', 'hand_L_014', 'shoulder_R_015']) {
    check(`${bone} is reported at risk`, text().includes(bone) && cov.get(bone).owned === false);
  }
  // ...and these are genuinely animated, so they must NOT be listed.
  for (const bone of ['head_07', 'tail01_020']) {
    check(`${bone} is not listed (the mixer owns it)`, !text().includes(bone) && cov.get(bone).owned === true);
  }
  check('the constant-track case is called out by name',
    text().includes('constant in swim'),
    text().match(/constant in \w+/)?.[0] ?? '(not found)');
  check('the unkeyed case is distinguished from it',
    text().includes('unkeyed in swim'),
    text().match(/unkeyed in \w+/)?.[0] ?? '(not found)');
}

console.log('\nit closes, and stops working when closed');
{
  press('j');
  check('J closes it', panel.style.display === 'none');
  const before = text();
  player.anim.update(DT, 'boost', false);
  await frame();
  check('the loop stopped with it', text() === before);
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
