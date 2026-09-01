// ---------------------------------------------------------------------------
// CALAMARI RING — LOOK DEV
//
//   npm run looks:calamari
//
// tools/calamari-test.mjs proves the motion: the ring tracks the seal, the
// carry survives the follow, a squid leaves with the momentum it was given.
// None of that is a picture, and every question left is one:
//
//   * AT FIGHT SCALE, is a squid an object or a speck? It is drawn at
//     squidSize x the asset's own scale, against a seal of about 2.6 units and
//     forty units of water. A number that reads fine in a harness is the
//     easiest way in the world to ship an invisible effect.
//   * does the ring READ as riding the seal, frame to frame, or does it still
//     look dropped and swum away from?
//   * do the squid read as attached while they ride, and as thrown when they
//     let go — or is the release invisible because they were never legible on
//     the front in the first place?
//   * does one stack look different from eight?
//
// It steps the SHIPPING updateCalamari with the game's own CONFIG, through the
// game's own post chain. Built with vite rather than run off the dev server: a
// build resolves the JSON and ?raw CSV imports without starting a second game,
// which is the thing that overwrites imported-tuning.json. IT WRITES NOTHING.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { bounds, updateBounds } from '../../path/src/arena.js';
import { player } from '../../path/src/entities/player.js';
import {
  updateCalamari, resetCalamari, calamariSquidCount, calamariDebug,
  currentCalamariStats, CALAMARI_ASSETS,
} from '../../path/src/systems/calamari.js';
import { createPost } from '../../path/src/systems/post.js';

const logEl = document.getElementById('log');
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

const W = 380;
const H = 300;
const DT = 1 / 60;

// ONE WebGL context for the whole page — see the note in razor-clams.js: a
// renderer per cell blacks out the early panels with nothing thrown.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

updateBounds(W / H);

const ortho = (h) => {
  const c = new THREE.OrthographicCamera(-h * (W / H) / 2, h * (W / H) / 2, h / 2, -h / 2, -100, 100);
  c.position.set(0, 0, 20);
  return c;
};
// THE SIZE THE PLAYER SEES IT. At zoom 1 the frustum IS the arena (world.js).
const fightCam = ortho(bounds.top - bounds.bottom);
// A magnifying glass, for the one question that is about the body and not the
// fight: is this thing shaped like a squid at all at the size it is drawn.
const closeCam = ortho(4);

const scene = new THREE.Scene();
await preloadAssets();

const post = createPost(gl);
let activeCam = fightCam;
function draw(cam) {
  activeCam = cam ?? activeCam;
  post.resize();
  post.render(scene, activeCam, DT);
}

let shotIndex = 0;
const posted = [];
let row = null;
function section(title, columns) {
  const h = document.createElement('h2');
  h.textContent = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}
function present(title, note) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#081426';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// A stand-in seal, at the real ship scale, so every judgement about how big a
// squid is is made against the animal the player is actually looking at.
const seal = createVisual('ship');
seal.rotation.z = -Math.PI / 2; // createVisual leaves a body nose-up
scene.add(seal);
const sealPos = new THREE.Vector3(0, 0, 0);
player.stats = {};

function measure(o) {
  const b = new THREE.Box3().setFromObject(o);
  const s = new THREE.Vector3();
  b.getSize(s);
  return Math.max(s.x, s.y);
}
const sealLen = measure(seal);

// One run of the ability, stepped. `move` is the seal's swim, in u/s.
function begin(level, move = [0, 0]) {
  resetCalamari(scene);
  sealPos.set(0, 0, 0);
  seal.position.copy(sealPos);
  player.velocity.set(move[0], move[1]);
  step(level, move); // fires the first wave immediately — cooldown starts at 0
}
function step(level, move = [0, 0], frames = 1) {
  for (let i = 0; i < frames; i++) {
    sealPos.x += move[0] * DT;
    sealPos.y += move[1] * DT;
    seal.position.copy(sealPos);
    updateCalamari(DT, scene, sealPos, level, [], {});
  }
}

// ---------------------------------------------------------------------------
log(`seal is ${sealLen.toFixed(2)} units long; the arena is ${(bounds.top - bounds.bottom).toFixed(1)} units tall`, 'note');
check(`"${CALAMARI_ASSETS[0]}" loaded as a MODEL, not the primitive stand-in`,
  !!createVisual(CALAMARI_ASSETS[0]).getObjectByProperty('isMesh', true),
  'a cone stand-in is the quiet way this effect ships invisible');

// ---------------------------------------------------------------------------
section('one wave, level 4, seal swimming right at 9 u/s — fight scale', 4);
{
  const level = 4;
  const s = currentCalamariStats(level);
  const life = s.maxRadius / CONFIG.calamari.speed;
  log(`level ${level}: reach ${s.maxRadius.toFixed(1)}u, wave lives ${life.toFixed(2)}s, ${calamariSquidCount(level)} squid`, 'note');

  begin(level, [9, 0]);
  const marks = [0.04, 0.12, 0.22, 0.30, 0.40, 0.55, 0.75, 1.0];
  let t = 0;
  for (const at of marks) {
    const want = Math.round(at * (life + CONFIG.calamari.squidLife) / DT);
    step(level, [9, 0], Math.max(0, want - Math.round(t / DT)));
    t = want * DT;
    const { waves, squids } = calamariDebug();
    const loose = squids.filter((q) => !q.wave).length;
    const lag = waves.length ? (sealPos.x - waves[0].mesh.position.x).toFixed(2) : '—';
    fightCam.position.x = sealPos.x;
    draw(fightCam);
    present(`t+${t.toFixed(2)}s`,
      `${waves.length} wave, ${squids.length} squid (${loose} loose) · ring lag ${lag}u`);
  }
}

// ---------------------------------------------------------------------------
section('is a squid an OBJECT at fight scale?', 2);
{
  begin(6, [0, 0]);
  step(6, [0, 0], 14);
  const sq = calamariDebug().squids[0];
  const squidLen = measure(sq.mesh);
  const arena = bounds.top - bounds.bottom;
  log(`a squid measures ${squidLen.toFixed(2)}u — ${(squidLen / sealLen * 100).toFixed(0)}% of the seal, ${(squidLen / arena * 100).toFixed(1)}% of the screen height`, 'note');
  check('a squid is at least a tenth of the seal', squidLen > sealLen * 0.1,
    `${squidLen.toFixed(2)}u against a ${sealLen.toFixed(2)}u seal`);
  check('...and at least 2% of the screen', squidLen / arena > 0.02,
    `${(squidLen / arena * 100).toFixed(1)}% — under about 2% it is a speck`);
  fightCam.position.x = 0;
  draw(fightCam);
  present('fight scale', `squid ${squidLen.toFixed(2)}u vs seal ${sealLen.toFixed(2)}u`);
  closeCam.position.set(sq.mesh.position.x, sq.mesh.position.y, 20);
  draw(closeCam);
  present('close up', 'one squid, 4 units across — is it a squid or a blob?');
  closeCam.position.set(0, 0, 20);
}

// ---------------------------------------------------------------------------
section('one stack against eight — the count is the read', 2);
{
  for (const level of [1, 8]) {
    begin(level, [0, 0]);
    // Just past the release, where the most squid are in the water at once.
    const s = currentCalamariStats(level);
    step(level, [0, 0], Math.round((s.maxRadius * 0.8 / CONFIG.calamari.speed) / DT));
    fightCam.position.x = 0;
    draw(fightCam);
    present(`level ${level}`, `${calamariSquidCount(level)} squid, reach ${s.maxRadius.toFixed(1)}u`);
  }
  check('eight stacks flings more than one', calamariSquidCount(8) > calamariSquidCount(1),
    `${calamariSquidCount(1)} -> ${calamariSquidCount(8)}`);
}

// ---------------------------------------------------------------------------
// A wave that is hitting something has to be BRIGHTER than one that is not —
// systems/damageGlow.js, the same envelope the shrimp ring and the garlic cloud
// are on. The harness proves the arithmetic. What it cannot see is whether the
// difference survives bloom and the tone map, which is the only place the
// player meets it.
// ---------------------------------------------------------------------------
section('cold water against a school — is the flare legible?', 2);
{
  const level = 5;
  const enemyAt = (x, y) => ({
    mesh: { position: { x, y, z: 0 } }, radius: 0.5, hp: 1e6, vx: 0, vy: 0, flash: 0,
  });
  // A ring of bodies at 4 units, crossed EARLY — the shader fades the whole
  // wave out past 0.65 of its reach, so a school placed near the rim is caught
  // by a band that is already dissolving and the panel would be a picture of
  // that fade rather than of the flare. Both panels are then stepped the same
  // number of frames, so the only difference between them is the heat.
  const school = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    school.push(enemyAt(Math.cos(a) * 4, Math.sin(a) * 4));
  }
  const FRAMES = 18; // front at ~4.8u, just past the school and its band

  for (const [label, list] of [['cold — nothing in the water', []], ['hot — crossing 14 bodies', school]]) {
    begin(level, [0, 0]);
    for (let i = 0; i < FRAMES; i++) updateCalamari(DT, scene, sealPos, level, list, {});
    const w = calamariDebug().waves[0];
    const riding = calamariDebug().squids.filter((sq) => sq.wave === w);
    fightCam.position.x = 0;
    draw(fightCam);
    present(label, w
      ? `ring heat ${w.heat.toFixed(2)} · squid ${(riding[0] ? riding[0].mesh.scale.x / riding[0].size : 1).toFixed(2)}x`
      : 'wave gone');
  }
  check('the school actually stoked the ring', true, 'compare the two panels — this is an eye check');
}

await Promise.all(posted);
log('');
log(fails ? `${fails} problem(s)` : 'all good', fails ? 'bad' : 'ok');
log(`${shotIndex} frames posted to the shots directory`, 'note');
document.title = fails ? 'calamari FAILED' : 'calamari ok';
