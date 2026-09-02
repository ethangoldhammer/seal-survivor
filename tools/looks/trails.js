// ---------------------------------------------------------------------------
// THE MERGED RIBBONS — does a volley still look like a volley?
//
//   npm run looks:trails
//
// systems/projectileTrails.js used to put one Mesh in the scene per trail, and
// now puts one per ribbon LENGTH, with several trails writing disjoint slices
// of a shared buffer. That is a change to how the game DRAWS, and the Node
// harness beside it (tools/trail-merge-test.mjs) can only read the buffer: it
// proves the numbers in the arrays are the right numbers, and is completely
// blind to whether the driver draws them.
//
// The two mechanisms it cannot see are the ones that are new here, and both
// fail SILENTLY — a blank ribbon, no error, nothing in a console:
//
//   THE DRAW RANGE. Retired slots are left in the buffer and simply not
//   reached, so the whole picture depends on setDrawRange over an INDEXED
//   geometry counting indices rather than vertices. Get it wrong by a factor
//   of six and a volley of forty draws six streaks.
//
//   THE INDEX TYPE. A merged buffer runs past 65,535 vertices as soon as a
//   couple of dozen long ribbons are in it, so the index is Uint32. That is
//   core in WebGL2 and an extension in WebGL1, and three picks the type off
//   the array — a silent fallback would wrap the indices and draw confetti.
//
// So the page renders REAL trails, through the real module, and prints what it
// finds. The picture is the answer; the checks above it only say the scene was
// built the way the change claims.
//
// A build rather than a dev server, always: a second dev server is a second
// game and it rewrites imported-tuning.json. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import {
  updateProjectileTrails, clearProjectileTrails, trailCount, trailDrawCount,
} from '../../path/src/systems/projectileTrails.js';

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

const W = 900;
const H = 520;

// ONE renderer for the page. A renderer per panel is the obvious way to write
// this and it silently kills the page — browsers keep about sixteen live
// contexts and drop the oldest, so early panels go black AFTER rendering
// correctly, with nothing thrown. Same note as every other look page here.
const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.setClearColor(0x04070e, 1);

// Plain, not through post.js. The question here is whether the geometry draws
// at all, and a bloom chain over a blank frame is still a blank frame — it
// would only make a failure harder to read.
const camera = new THREE.OrthographicCamera(-16, 16, 9.2, -9.2, 0.1, 100);
camera.position.z = 20;

/**
 * A "mover" is the smallest contract the trail file takes — { mesh, dir,
 * speed } — and the mesh's NAME is what picks the preset out of CONFIG.trails.
 * The body itself is drawn too, small and dark, so it is obvious which end of
 * a ribbon is the head.
 */
function mover(scene, asset, x, y, angle) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0x8fa6c4 }),
  );
  mesh.name = asset;
  mesh.position.set(x, y, 0);
  scene.add(mesh);
  // Fast, so the ribbons are long enough to read: `points` is the trail's
  // length in FRAMES of history, so how far a streak reaches across the frame
  // is speed x points. At the gun's real muzzle velocity these panels would be
  // four thumbnails of a comb.
  return { mesh, dir: new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0), speed: 26 };
}

/** Fly the movers for `frames` frames, driving the real trail update each one. */
function fly(scene, movers, frames, dt = 1 / 60) {
  for (let f = 0; f < frames; f++) {
    for (const m of movers) {
      m.mesh.position.x += m.dir.x * m.speed * dt;
      m.mesh.position.y += m.dir.y * m.speed * dt;
    }
    updateProjectileTrails(dt, scene, movers);
  }
}

let shotIndex = 0;
const posted = [];

function panel(title, build) {
  const scene = new THREE.Scene();
  clearProjectileTrails(scene);
  const movers = build(scene);
  gl.render(scene, camera);

  const wrap = document.createElement('div');
  wrap.className = 'cell';
  const img = document.createElement('img');
  img.src = gl.domElement.toDataURL('image/png');
  img.style.width = '100%';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = `${title} — ${trailCount()} ribbons in ${trailDrawCount()} draw(s)`;
  wrap.append(img, cap);
  document.getElementById('grid').appendChild(wrap);

  // POSTED TO THE SERVER'S DROP BOX rather than left for a screenshot. The
  // Browser pane goes blank or times out on a page this tall (see the note in
  // tools/looks/serve.mjs), so the frames are read off disk instead — which is
  // also the only way to look at the fourth panel, whose whole point is that it
  // is enormous.
  const name = `${String(shotIndex++).padStart(2, '0')}-`
    + `${title.split('—')[0].trim().toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => gl.domElement.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
  return movers;
}

// ===========================================================================
// A FAN OF PEBBLES. One preset, so one draw — and the picture has to show
// forty distinct streaks fanning out, not one, and not six.
const FAN = 40;
panel('a volley of pebbles, one preset', (scene) => {
  const movers = [];
  // One origin, fanned — the shape a volley actually makes, and the shape in
  // which a slot landing in the wrong block is unmistakable.
  for (let i = 0; i < FAN; i++) {
    const a = (-0.5 + (1.0 * i) / (FAN - 1));
    movers.push(mover(scene, 'bullet', -11, 0, a));
  }
  fly(scene, movers, 32);
  return movers;
});
check('a forty-shot volley is one draw', trailDrawCount() === 1, `${trailDrawCount()}`);
check('and all forty are drawn', trailCount() === FAN, `${trailCount()}`);

// ===========================================================================
// MIXED LENGTHS, which cannot share a slot size: bullet is 8 points, missile
// 16, bounceShot 20. Three buffers, and each ribbon has to be its own length —
// a missile's vertices landing in a pebble's slot draws a streak of the wrong
// length, which is the exact failure the grouping exists to prevent and is
// perfectly plausible on screen if you are not looking for it.
panel('three lengths at once — 8, 16 and 20 points', (scene) => {
  const movers = [];
  // Stacked in bands rather than mixed, so the three ribbon LENGTHS can be
  // compared against each other by eye — which is the whole point of the panel.
  for (let i = 0; i < 6; i++) movers.push(mover(scene, 'bullet', -9, 7 - i * 0.8, 0));
  for (let i = 0; i < 6; i++) movers.push(mover(scene, 'missile', -9, 1.5 - i * 0.8, 0));
  for (let i = 0; i < 6; i++) movers.push(mover(scene, 'bounceShot', -9, -4 - i * 0.8, 0));
  fly(scene, movers, 26);
  return movers;
});
check('three lengths cost three draws', trailDrawCount() === 3, `${trailDrawCount()}`);

// ===========================================================================
// THE SWAP-REMOVE, on screen. Half the volley retires mid-flight and the
// survivors carry on. If a retiring ribbon's vertices did not travel with its
// slot, a survivor is drawn from a dead one's block — which reads as a streak
// jumping onto a path nothing is flying.
panel('half the volley retires mid-flight', (scene) => {
  const movers = [];
  // Evenly spaced lanes, so a survivor drawn from a dead one's block appears
  // as a streak in a lane with nothing flying down it.
  for (let i = 0; i < 24; i++) {
    movers.push(mover(scene, 'bullet', -9, -8 + i * 0.68, 0));
  }
  fly(scene, movers, 13);
  const survivors = movers.filter((_, i) => i % 2 === 0);
  for (const m of movers) if (!survivors.includes(m)) scene.remove(m.mesh);
  fly(scene, survivors, 13);
  return survivors;
});
check('the survivors kept their ribbons', trailCount() === 12, `${trailCount()}`);
check('and it is still one draw', trailDrawCount() === 1, `${trailDrawCount()}`);

// ===========================================================================
// PAST 65,535 VERTICES, which is where a Uint16 index would wrap. The longest
// preset in CONFIG.trails at enough shots to be sure of crossing it.
const longest = Math.max(...Object.values(CONFIG.trails)
  .filter((c) => c && typeof c === 'object' && c.points)
  .map((c) => Math.round(c.points)));
const NEEDED = Math.ceil(70000 / (longest * 2)) + 4;
panel(`${NEEDED} of the longest ribbon — past a 16-bit index`, (scene) => {
  const key = Object.entries(CONFIG.trails)
    .find(([, c]) => c && typeof c === 'object' && Math.round(c.points) === longest)[0];
  const movers = [];
  for (let i = 0; i < NEEDED; i++) {
    const a = (-1 + (2 * i) / (NEEDED - 1)) * 0.75;
    movers.push(mover(scene, key, -13, 0, a));
  }
  fly(scene, movers, longest + 20);
  return movers;
});
const verts = NEEDED * longest * 2;
check(`${verts.toLocaleString()} vertices in one buffer, still one draw`,
  trailDrawCount() === 1 && trailCount() === NEEDED,
  `${trailCount()} ribbons, ${trailDrawCount()} draw(s)`);
check('which is past what a Uint16 index can address', verts > 65535, `${verts}`);

log('');
log(fails ? `${fails} FAILURE(S)` : 'all checks passed — now LOOK at the panels',
  fails ? 'bad' : 'ok');
await Promise.all(posted);
log('frames written to the server\'s drop box');
document.title = fails ? 'trails FAILED' : 'merged trails ok';
