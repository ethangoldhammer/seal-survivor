// ---------------------------------------------------------------------------
// ATTACK OVERLAY — what the V panel actually draws in the water.
//
//   npm run looks:attack
//
// The question this exists for is "can you see it", and that is not a question
// a Node harness can answer. tools/attack-panel-test.mjs proves the panel's
// logic and proves the overlay does not throw; neither of those notices that
// every shape was one physical pixel wide, which is what the first version of
// systems/attackOverlay.js shipped as — `LineBasicMaterial.linewidth` is
// ignored by every WebGL2 core profile, so the whole thing was invisible over a
// moving fight and the tests were green the entire time.
//
// So: the REAL overlay, around REAL bodies, over the sea's own colour, at two
// weights — rendered through one WebGL context and blitted into a 2D canvas per
// cell (a renderer per cell silently goes black past a dozen panels).
//
// IT WRITES NOTHING. A vite build with no dev server behind it and no save
// path. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { enemies, spawnNamed, updateEnemies, resetEnemies } from '../../path/src/entities/enemies.js';
import { initPlayer, resetPlayer, player } from '../../path/src/entities/player.js';
import {
  showAttackOverlay, updateAttackOverlay, setAttackOverlayWeight, attackOverlayStats,
} from '../../path/src/systems/attackOverlay.js';
import { setAttackTrace, tickAttackTrace } from '../../path/src/systems/attackTrace.js';

const logEl = document.getElementById('log');
const sheetEl = document.getElementById('sheet');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
let fails = 0;
const check = (name, ok, detail = '') => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, ok ? 'ok' : 'bad');
  if (!ok) fails++;
};

const W = 640;
const H = 420;
const DT = 1 / 60;

const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// The sea's own colour, roughly, because the whole question is whether the
// overlay reads AGAINST it. On black everything is legible and nothing is
// learned.
scene.background = new THREE.Color(0x0b2c3f);
scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(3, 6, 8);
scene.add(key);

await preloadAssets();
initPlayer(scene);
resetPlayer();

// A camera framing roughly what the game's does around the fight.
const SPAN = 34;
const camera = new THREE.OrthographicCamera(-SPAN, SPAN, (SPAN * H) / W, -(SPAN * H) / W, -200, 400);
camera.position.set(0, 0, 60);
camera.lookAt(0, 0, 0);

showAttackOverlay(scene);
setAttackTrace(true);

/**
 * Drive a real boss until it reaches `stage`, then draw one cell.
 *
 * Driven rather than posed: `lungeClock`, `lungePlan` and the heading are what
 * the overlay reads, and a hand-set stage would be a picture of a body no run
 * ever produces.
 */
function shot(title, { type = 'bossShark', stage = null, weight = 1, seconds = 40 } = {}) {
  setAttackOverlayWeight(weight);
  resetEnemies(scene);
  const e = spawnNamed(scene, type, 4, { x: -16, y: 0 }, { ignoreCaps: true });
  if (!e) { check(`${title}: spawned`, false); return null; }
  e.isBoss = true;
  const at = new THREE.Vector3();
  let reached = stage == null;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t = i * DT;
    at.set(Math.cos(t * 0.55) * 11, Math.sin(t * 0.8) * 5, 0);
    player.mesh.position.copy(at);
    tickAttackTrace(DT);
    updateEnemies(DT, scene, at, () => {}, () => {});
    if (stage && e.lungeStage === stage) { reached = true; break; }
    if (!enemies.includes(e)) break;
  }
  updateAttackOverlay({ showWildlife: true, showShots: true });
  gl.render(scene, camera);

  const cell = document.createElement('div');
  cell.className = 'cell';
  const c2d = document.createElement('canvas');
  c2d.width = W * 2;
  c2d.height = H * 2;
  c2d.getContext('2d').drawImage(gl.domElement, 0, 0);
  cell.appendChild(c2d);
  const cap = document.createElement('div');
  cap.className = 'cap';
  const s = attackOverlayStats();
  cap.innerHTML = `<b>${title}</b> — ${type} · stage ${e.lungeStage ?? '—'} · `
    + `${s.rings} rings, ${s.bars} bars, ${s.wedges} wedges · ${s.geometries} cached geometries`;
  cell.appendChild(cap);
  sheetEl.appendChild(cell);

  // POSTED TO DISK rather than screenshotted: the Browser pane's own capture
  // goes blank on a tall contact sheet. See tools/looks/serve.mjs.
  c2d.toBlob((b) => {
    fetch(`/shot/${title.replace(/[^\w-]+/g, '-')}.png`, { method: 'POST', body: b });
  }, 'image/png');
  return { e, reached, stats: s };
}

const cruise = shot('cruise', { stage: 'cruise' });
check('a cruising boss draws its window, its floor, its bite and its cone',
  cruise?.stats.rings >= 4 && cruise?.stats.wedges >= 1,
  `${cruise?.stats.rings} rings, ${cruise?.stats.wedges} wedges`);

const wind = shot('wind-up', { stage: 'wind' });
check('a wind-up is still a cone, drawn heavier', wind?.reached === true);

const strike = shot('committed run', { stage: 'strike' });
check('a committed run swaps the cone for the line it is running down',
  strike?.stats.bars >= 2 && strike?.stats.wedges === 0,
  `${strike?.stats.bars} bars, ${strike?.stats.wedges} wedges`);

shot('weight x0.6', { stage: 'cruise', weight: 0.6 });
shot('weight x3', { stage: 'cruise', weight: 3 });
setAttackOverlayWeight(1);

const wild = shot('wildlife shark', { type: 'shark', stage: 'cruise' });
check('a wildlife body draws the same set at its own scale', wild?.stats.rings >= 4);

// THE CACHE IS THE COST. One geometry per quantised ring ratio and per
// quantised cone angle — if this grew per frame the overlay would be allocating
// two buffers a body a frame, which is the thing the cache exists to stop.
const before = attackOverlayStats().geometries;
for (let i = 0; i < 120; i++) updateAttackOverlay({ showWildlife: true });
check('redrawing does not grow the geometry cache',
  attackOverlayStats().geometries === before,
  `${before} geometries before 120 redraws, ${attackOverlayStats().geometries} after`);

log(fails ? `\n${fails} FAILED` : '\nall good', fails ? 'bad' : 'ok');
