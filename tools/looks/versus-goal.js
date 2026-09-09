// ---------------------------------------------------------------------------
// THE VERSUS GOAL — LOOK DEV
//
//   npm run looks:versus
//
// The shipping world (world.js: backdrop, seabed, shore, camera) with the
// versus flag on, photographed at the framings a match uses and at framings
// a match cannot reach yet — pushed past the wall to see what the tunnel is
// made of. The Node harness proves the mouth is CUT and the light quads are
// BUILT; only a render can say whether the light is visible, and whether a
// camera pushed into the goal sees rock or bare background.
//
// IT WRITES NOTHING. No save path, no dev server. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { createWorld } from '../../path/src/world.js';
import { createPost } from '../../path/src/systems/post.js';
import { enableVersus } from '../../path/src/systems/versusFlag.js';
import { bounds, midWater } from '../../path/src/arena.js';
import {
  shore, shoreOverscan, refreshGoalGlow, tickGoalGlow, flashGoalScored, clearGoalScored,
  setGoalSwimmers, goalGlowImpulse, resetGoalStir, goalGlowState,
} from '../../path/src/systems/wallRocks.js';
import { mouthHalfHeight, tunnelDepth, rockX, goalLineX, cameraReach } from '../../path/src/systems/versusGoal.js';

const logEl = document.getElementById('log');
const sheetEl = document.getElementById('sheet');
const log = (m, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = m; logEl.appendChild(d); };
let fails = 0;
const check = (name, ok, detail = '') => { log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, ok ? 'ok' : 'bad'); if (!ok) fails++; };

const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => { const s = args.map((a) => String(a)).join(' '); if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s); realError(...args); };

await preloadAssets().catch((e) => log(`preload: ${e?.message ?? e}`, 'bad'));

// The world sizes its frustum and its canvas off the WINDOW (world.resize →
// updateBounds(innerWidth / innerHeight), applyFrustum), and a hidden Browser
// pane reports 0x0 — a NaN aspect, a NaN frustum, and a frame that clears to
// white with the grain on top of it. Pin the window the run would have.
for (const [k, v] of [['innerWidth', 1280], ['innerHeight', 720]]) {
  try { Object.defineProperty(window, k, { configurable: true, get: () => v }); } catch {}
}
const container = document.createElement('div');
container.style.cssText = 'position:fixed; left:-10000px; top:0; width:1280px; height:720px;';
document.body.appendChild(container);
// world.resize reads the window; the page is what it is. Size the container
// to a 16:9 frame anyway so the frustum is the run's.
const world = createWorld(container);
world.renderer.setPixelRatio(1);
world.renderer.setSize(1280, 720);
const post = createPost(world.renderer);

enableVersus(true);
world.resize();
// The renderer's size is the WINDOW's (pinned above) at the pixel ratio the
// world chose; pin the ratio to 1 and re-size so the drawing buffer IS the
// 1280x720 frame. Never write the canvas's width directly: that leaves the
// GL viewport at the old buffer size and the canvas shows one corner of the
// picture, magnified — which is what this page did for its first hour.
world.renderer.setPixelRatio(1);
world.renderer.setSize(1280, 720, false);
{
  const db = world.renderer.getDrawingBufferSize(new THREE.Vector2());
  const vp = world.renderer.getViewport(new THREE.Vector4());
  log(`window ${window.innerWidth}x${window.innerHeight}, canvas ${world.renderer.domElement.width}x${world.renderer.domElement.height}, drawing buffer ${db.x}x${db.y}, viewport ${vp.z}x${vp.w}, pixel ratio ${world.renderer.getPixelRatio()}`);
}
window.addEventListener('error', (e) => log(`error: ${e.message}`, 'bad'));
window.addEventListener('unhandledrejection', (e) => log(`rejection: ${e.reason?.message ?? e.reason}`, 'bad'));
let shotIndex = 0;
const posted = [];

function place(cx, cy, zoom) {
  const cam = world.camera;
  cam.zoom = zoom;
  cam.updateProjectionMatrix();
  const vc = { x: (cam.left + cam.right) / 2, y: (cam.top + cam.bottom) / 2 };
  cam.position.x = cx - vc.x;
  cam.position.y = cy - vc.y;
}
function pixels() {
  // The sea state, the sky and the lights, as main.js advances them each frame
  // (updateSurface calls updateColors). A few frames so the clocks are real
  // numbers and the sky has settled.
  for (let i = 0; i < 4; i++) world.updateSurface(1 / 60);
  post.resize();
  post.render(world.scene, world.camera, 1 / 60);
  const c = document.createElement('canvas');
  c.width = world.renderer.domElement.width;
  c.height = world.renderer.domElement.height;
  c.getContext('2d').drawImage(world.renderer.domElement, 0, 0);
  return c;
}
let lastNoiseCanvas = null;
function diffPct(a, b, r = null) {
  if (!a || !b) return 0;
  const [x0, y0, x1, y1] = r ?? [0, 0, a.width, a.height];
  const da = a.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const db = b.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let moved = 0; let n = 0;
  for (let i = 0; i < da.length; i += 4 * 5) { n++; if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 12) moved++; }
  return (moved / n) * 100;
}
async function shot(title, caption) {
  const canvas = pixels();
  lastNoiseCanvas = canvas;
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b> — ${caption}`;
  cell.appendChild(cap);
  sheetEl.appendChild(cell);
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  await fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(() => posted.push(name)).catch(() => {});
  return canvas;
}
/** Share of a canvas region whose green channel dominates — the left goal's colour. */
function greenShare(canvas, x0, y0, x1, y1) {
  const d = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let n = 0; let g = 0;
  for (let i = 0; i < d.length; i += 4) { n++; if (d[i + 1] > d[i] + 25 && d[i + 1] > d[i + 2] + 25 && d[i + 1] > 60) g++; }
  return g / Math.max(1, n);
}

const gy = midWater();
const h = mouthHalfHeight();
log(`pitch ${bounds.left.toFixed(1)}..${bounds.right.toFixed(1)}, surface ${bounds.surfaceY}, bottom ${bounds.bottom.toFixed(1)}, mouth y ${gy.toFixed(1)}±${h}, tunnel ${tunnelDepth()}, rock face ${rockX(-1).toFixed(2)}, shore cover ${shore.cover.toFixed(2)}, overscan ${shoreOverscan().toFixed(2)}, built ${shore.built}`);
log(`goal cfg ${JSON.stringify(CONFIG.versus.goal)}`);

const reach = cameraReach();
log(`camera reach ${reach.toFixed(1)} past the wall, goal line ${(rockX(-1) - goalLineX(-1)).toFixed(1)} past the face`);
// A frame at zoom 1, as far left as the match camera may look.
place(bounds.left + world.halfExtents(1).w - reach, gy, 1);
const a = await shot('left wall, zoom 1', 'the furthest left the match camera may look');
// Tight on the goal, as far in as the camera may reach: the tunnel, its
// light, and the line the ball has to cross.
place(bounds.left + world.halfExtents(2).w - reach, gy, 2);
const b = await shot('into the left goal, zoom 2', `the frame's edge ${reach.toFixed(1)} past the wall`);
// PUSHED PAST THE REACH: is there rock behind the reach, or does it run out?
place(bounds.left - 8, gy, 1.6);
const c = await shot('camera 8 past the wall', 'past the reach: what the tunnel is made of');
// And the whole pitch at the zoom floor: what "always frame both seals" costs.
const zoomMin = CONFIG.versus.camera.zoomMin ?? 0.55;
place(0, (bounds.bottom + bounds.top) / 2, zoomMin);
{
  const cam = world.camera;
  log(`whole pitch: zoom ${cam.zoom}, frustum x ${cam.left.toFixed(1)}..${cam.right.toFixed(1)} y ${cam.bottom.toFixed(1)}..${cam.top.toFixed(1)}, position (${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}) → world x ${((cam.left / cam.zoom) + cam.position.x + (cam.left + cam.right) / 2 * (1 - 1 / cam.zoom)).toFixed(1)}..`);
}
await shot(`whole pitch, zoom ${zoomMin}`, 'both goals and both seals\' worst case in one frame');
// The RIGHT wall, mirrored: the other team's colour and the other tunnel.
place(bounds.right - world.halfExtents(1).w + reach, gy, 1);
await shot('right wall, zoom 1', 'the furthest right the match camera may look');
// FRAME SANITY: markers at known world x, so a page that shows the wrong part
// of its own picture (see the sizing note above) cannot pass quietly.
{
  const markers = [[bounds.left, 0xff00ff], [0, 0xffff00], [bounds.right, 0xff00ff]].map(([x, color]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, gy, 1);
    world.scene.add(m);
    return m;
  });
  place(0, (bounds.bottom + bounds.top) / 2, zoomMin);
  // The lights off for this one frame: at a blind-tuned glow their bloom
  // drowns a marker standing in the mouth, and this check is about WHERE
  // things land, not how bright the goal is.
  const lights = world.scene.children.flatMap((c) => c.children ?? []).filter((m) => m.material?.uniforms?.uGlow);
  for (const q of lights) q.visible = false;
  const mk = await shot('whole pitch with markers', 'magenta at each wall, yellow at centre; the lights off');
  for (const q of lights) q.visible = true;
  for (const m of markers) world.scene.remove(m);
  const cam = world.camera;
  const pxOf = (x) => { const p = new THREE.Vector3(x, gy, 1).project(cam); return [Math.round((p.x + 1) / 2 * 1280), Math.round((1 - p.y) / 2 * 720)]; };
  // Hue, not exact colour: the post chain grades and blooms every marker.
  const ctx = mk.getContext('2d');
  const at = (px, py) => ctx.getImageData(px, py, 1, 1).data;
  const magenta = (d) => d[0] > 120 && d[2] > 120 && d[1] < Math.min(d[0], d[2]) - 40;
  const yellow = (d) => d[0] > 120 && d[1] > 120 && d[2] < Math.min(d[0], d[1]) - 40;
  const [lx, ly] = pxOf(bounds.left); const [cx, cy] = pxOf(0); const [rx, ry] = pxOf(bounds.right);
  check('the page shows the frame the camera describes', magenta(at(lx, ly)) && yellow(at(cx, cy)) && magenta(at(rx, ry)), `walls at px ${lx} (${at(lx, ly).slice(0, 3).join(',')}) and ${rx} (${at(rx, ry).slice(0, 3).join(',')}), centre at ${cx} (${at(cx, cy).slice(0, 3).join(',')})`);
}

// THE LIGHT: is it contributing, IN THE WATER in front of the face? Same
// frame with the light overdriven, and with the mouths switched off. The
// region is the water just inside the face: the light's spill.
place(bounds.left + world.halfExtents(2).w - reach, gy, 2);
const px = (x) => Math.round(((x - (bounds.left - reach)) / (2 * world.halfExtents(2).w)) * 1280);
const region = [px(rockX(-1)), 0, Math.min(1280, px(rockX(-1) + 6)), 720];
const base = greenShare(b, ...region);
const savedGlow = CONFIG.versus.goal.glow; const savedSpill = CONFIG.versus.goal.spill;
CONFIG.versus.goal.glow = 0.6; CONFIG.versus.goal.spill = 3;
refreshGoalGlow();
const lit = await shot('left mouth, glow 0.6 spill 3', 'refreshGoalGlow after a tuning change, turned DOWN');
const hot = greenShare(lit, ...region);
CONFIG.versus.goal.glow = savedGlow; CONFIG.versus.goal.spill = savedSpill;
refreshGoalGlow();
CONFIG.versus.goal.holes = false;
world.wallRocks.build();
const dark = await shot('left wall, no mouth', 'holes off: the same frame with no goal at all');
const off = greenShare(dark, ...region);
CONFIG.versus.goal.holes = true;
world.wallRocks.build();

check('the goal light shows in the water in front of the face', base > off + 0.05, `green share ${(base * 100).toFixed(2)}% with the light, ${(off * 100).toFixed(2)}% without`);
// THE BUG IT HAD: at renderOrder -2 the quad sorted BEFORE the water fill in
// three's transparent list (renderOrder before depth), and the fill painted
// over it. Put it back for one frame and the light should go out under water.
{
  const quads = world.scene.children.flatMap((c) => c.children ?? []).filter((m) => m.material?.uniforms?.uGlow);
  for (const q of quads) q.renderOrder = -2;
  const under = await shot('left mouth, light at renderOrder -2', 'the old order: the water fill paints over it');
  const gone = greenShare(under, ...region);
  for (const q of quads) q.renderOrder = 0;
  check('...and at the old renderOrder -2 the water fill hid it', gone < base * 0.25, `${(gone * 100).toFixed(2)}% at -2 vs ${(base * 100).toFixed(2)}% at 0`);
}
check('...and a tuning change moves it', hot < base - 0.05, `${(hot * 100).toFixed(2)}% at glow 0.6 / spill 3 vs ${(base * 100).toFixed(2)}% at the tuned ${savedGlow} / ${savedSpill}`);
// THE NOISE breaks the light up: the same frame with it off is a smooth
// ellipse, with it on the green varies across the lit region, and a second
// later the pattern has moved.
{
  // Inside the tunnel, where the smooth light is flat: any variation there is the noise.
  const inTunnel = [Math.max(0, px(rockX(-1) - 10)), 100, Math.max(1, px(rockX(-1) - 2)), 620];
  // ROUGHNESS, not spread: the mean green difference between pixels 12 px
  // apart along a row. The smooth light's ellipse hardly changes across a
  // row inside the tunnel; the noise does — and a falloff gradient, which a
  // plain standard deviation would read, does not fool it.
  const gridStd = (canvas) => {
    // Block-averaged to drop the composite's grain, then the difference between
    // blocks a feature apart along a row, over the mean — so a brighter frame is
    // not a rougher one.
    const w = inTunnel[2] - inTunnel[0]; const h = inTunnel[3] - inTunnel[1];
    const d = canvas.getContext('2d').getImageData(inTunnel[0], inTunnel[1], w, h).data;
    const B = 16; const bw = Math.floor(w / B); const bh = Math.floor(h / B);
    const blocks = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) sum += d[(((by * B + y) * w) + bx * B + x) * 4 + 1];
      blocks[by * bw + bx] = sum / (B * B);
    }
    const gap = Math.max(1, Math.min(bw - 1, 4));
    let n = 0; let rough = 0; let mean = 0;
    for (let by = 0; by < bh; by++) for (let bx = 0; bx + gap < bw; bx++) { n++; rough += Math.abs(blocks[by * bw + bx] - blocks[by * bw + bx + gap]); mean += blocks[by * bw + bx]; }
    mean /= Math.max(1, n);
    return { mean, std: (rough / Math.max(1, n)) / Math.max(1, mean) };
  };

  const dim = { glow: CONFIG.versus.goal.glow, spill: CONFIG.versus.goal.spill };
  // At a glow that is not saturated, so variation can show.
  CONFIG.versus.goal.glow = 1.2; CONFIG.versus.goal.spill = 8;
  CONFIG.versus.goal.noise.enabled = false; refreshGoalGlow();
  const smooth = gridStd(await shot('left mouth, glow 1.2, noise off', 'the smooth light, unbroken'));
  CONFIG.versus.goal.noise.enabled = true; refreshGoalGlow();
  const brokenCanvas = await shot('left mouth, glow 1.2, noise on', `amount ${CONFIG.versus.goal.noise.amount}, scale ${CONFIG.versus.goal.noise.scale}`);
  const broken = gridStd(brokenCanvas);
  tickGoalGlow(1.0);
  const later = await shot('left mouth, noise a second later', 'the pattern has drifted and churned');
  const moved = diffPct(later, brokenCanvas, inTunnel);
  CONFIG.versus.goal.glow = dim.glow; CONFIG.versus.goal.spill = dim.spill; refreshGoalGlow();
  // A still-frame metric for "broken up" is not honest here: inside the
  // tunnel the boulders and the composite's scanlines dominate both frames.
  // The two shots above are the read; the check below is the proof — only
  // the noise can change a frame of a still light over a second.
  log(`noise: relative roughness ${broken.std.toFixed(3)} with it vs ${smooth.std.toFixed(3)} without (means ${broken.mean.toFixed(0)} / ${smooth.mean.toFixed(0)}) — see the two shots`);
  check('...and it moves with the clock', moved > 3, `${moved.toFixed(1)}% of the region changed over a second`);
}
// ---------------------------------------------------------------------------
// THE SCORE'S COLOUR, and THE SEALS IN THE FIELD.
//
// Both are things the Node harness can only see as uniforms. What it cannot
// say is whether either reaches the picture — a light already blazing at the
// tuned glow can swallow a colour change whole, and a distortion inside the
// noise can be too small to find against the composite's own grain. So: pairs
// of frames at THE SAME CLOCK, differing only in the thing being tested.
//
// The micro-tick is what makes the pair honest. Uniforms only reach a material
// through tickGoalGlow, which also advances the clock the noise churns on — so
// a control taken after a real tick would differ by a second of drift as well
// as by the seal. A microsecond pushes the uniforms and moves the field by
// nothing measurable.
// ---------------------------------------------------------------------------
{
  place(bounds.left + world.halfExtents(2).w - reach, gy, 2);
  const mouthRegion = [Math.max(0, px(rockX(-1) - 14)), 120, Math.min(1280, px(rockX(-1) + 4)), 600];
  const push = () => tickGoalGlow(1e-6);
  /** Share of a region whose RED channel dominates — the right team's colour. */
  const redShare = (canvas, x0, y0, x1, y1) => {
    const d = canvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0; let r = 0;
    for (let i = 0; i < d.length; i += 4) { n++; if (d[i] > d[i + 1] + 25 && d[i] > d[i + 2] + 25 && d[i] > 60) r++; }
    return r / Math.max(1, n);
  };
  resetGoalStir();
  push();
  const own = await shot('left mouth, its own team', 'the mouth at rest, in the team whose goal it is');
  const ownGreen = greenShare(own, ...mouthRegion);
  const ownRed = redShare(own, ...mouthRegion);
  // A goal into the LEFT mouth is the RIGHT team's point, so the left mouth
  // takes the right team's colour and blazes.
  flashGoalScored(-1, 1);
  tickGoalGlow(CONFIG.versus.goal.scored.rise + 1e-3);
  const scored = await shot('left mouth, a goal just went in', "the scorer's colour, at the flash's peak");
  const scoredRed = redShare(scored, ...mouthRegion);
  const scoredGreen = greenShare(scored, ...mouthRegion);
  check('the mouth a goal went into turns the scorer\'s colour', scoredRed > ownRed + 0.08 && scoredGreen < ownGreen,
    `red ${(ownRed * 100).toFixed(1)}% → ${(scoredRed * 100).toFixed(1)}%, green ${(ownGreen * 100).toFixed(1)}% → ${(scoredGreen * 100).toFixed(1)}%`);
  // ...and hands it back on the wall clock.
  const sc = CONFIG.versus.goal.scored;
  tickGoalGlow(sc.hold + sc.fall + 0.2);
  const handed = await shot('left mouth, the flash run out', 'handed back to the team whose goal it is');
  check('...and hands it back when the flash runs out', redShare(handed, ...mouthRegion) < ownRed + 0.03 && goalGlowState.scored.team < 0,
    `red back to ${(redShare(handed, ...mouthRegion) * 100).toFixed(1)}% of ${(ownRed * 100).toFixed(1)}%`);
  clearGoalScored();
  push();

  // THE SEALS. A pair at the same clock: one with two swimmers in the mouth,
  // one with none.
  //
  // AT A TURNED-DOWN GLOW, exactly as the noise block above is: at the tuned
  // 4.3 the mouth is a saturated wall of colour and a distortion INSIDE the
  // field cannot show through a channel already pinned at 255. The stir is
  // the same stir either way — this is what it looks like where it can be
  // seen at all, and the two shots at the tuned glow are just above it.
  const tuned = { glow: CONFIG.versus.goal.glow, spill: CONFIG.versus.goal.spill };
  CONFIG.versus.goal.glow = 1.2; CONFIG.versus.goal.spill = 8;
  refreshGoalGlow();
  push();
  const clean = await shot('left mouth, nobody in it', 'glow 1.2: the field with no seal in it — the control');
  setGoalSwimmers([
    { x: rockX(-1) + 2, y: gy + 4, vx: -40, vy: 6 },
    { x: rockX(-1) - 6, y: gy - 5, vx: 30, vy: -12 },
  ]);
  push();
  const stirred = await shot('left mouth, both seals in it', 'glow 1.2: the same frame, same clock — only the seals are new');
  const stirMoved = diffPct(stirred, clean, mouthRegion);
  check('a seal distorts the field that breaks the light up', stirMoved > 2, `${stirMoved.toFixed(1)}% of the mouth changed with two seals in it`);
  // ...and it is LOCAL: the far mouth, which no seal is anywhere near, is the
  // same picture. A distortion that reached both mouths would be a uniform
  // array shared between two materials.
  const farRegion = [1000, 200, 1279, 520];
  check('...and only where the seal is', diffPct(stirred, clean, farRegion) < stirMoved * 0.5,
    `${diffPct(stirred, clean, farRegion).toFixed(1)}% away from them vs ${stirMoved.toFixed(1)}% at them`);
  setGoalSwimmers([]);
  push();

  // AND THE IMPULSE — a ring thrown into the field, photographed mid-flight
  // against a control at the very same clock (the pulse cleared, nothing else).
  goalGlowImpulse(rockX(-1) - 2, gy, 1);
  tickGoalGlow(0.28);
  const ringed = await shot('left mouth, a burst ring passing', 'a seal burst here 0.28s ago — the ring is out at its radius');
  resetGoalStir();
  push();
  const noRing = await shot('left mouth, the same instant with no ring', 'the control: same clock, the ring taken away');
  const ringMoved = diffPct(ringed, noRing, mouthRegion);
  check('a burst throws a ring through it', ringMoved > 1.5, `${ringMoved.toFixed(1)}% of the mouth changed with a ring in flight`);
  CONFIG.versus.goal.glow = tuned.glow; CONFIG.versus.goal.spill = tuned.spill;
  refreshGoalGlow();
  resetGoalStir();
  push();
}
check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
log(`posted ${posted.length} shots: ${posted.join(', ')}`);
log(fails ? `${fails} FAILED` : 'all passed', fails ? 'bad' : 'ok');
