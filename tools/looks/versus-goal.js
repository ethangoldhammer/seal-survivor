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
  setGoalSwimmers, setGoalBall, goalGlowImpulse, resetGoalStir, goalGlowState,
} from '../../path/src/systems/wallRocks.js';
import { mouthHalfHeight, tunnelDepth, rockX, goalLineX, cameraReach, installGoalHoles } from '../../path/src/systems/versusGoal.js';
import { versusZoomFloor } from '../../path/src/systems/backdropFit.js';
// THE GOAL ITSELF — the shipping modules, so the last block of this page can
// score one rather than describe one. See the section at the bottom.
import { initPlayer, resetPlayer, player, buildSealBody, updatePlayer, poseBody } from '../../path/src/entities/player.js';
import { initParticles, updateParticles, updateParticleScale } from '../../path/src/entities/particles.js';
import { updateOutlineScale } from '../../path/src/systems/outlines.js';
import { ball, p2, initBallAlone, stepBallAlone, renderBall, goalBlast } from '../../path/src/systems/versus.js';
import { fireGoalJet, updateGoalJets, resetGoalJets, goalJets, goalJetOrigin } from '../../path/src/systems/goalJet.js';

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
// BEFORE createPost's first resize: the goo pass sizes itself off a particle
// system that has to exist by then, and a resize with none throws from inside
// three.js on a uniform that was never made. Empty, it draws nothing — every
// shot above this page's last section is the picture it always was.
initParticles(world.scene);
const post = createPost(world.renderer);

enableVersus(true);
// The mouths as a hole a BODY may enter, not only as a hole the rock is cut
// for — arena.clampToArena reads this, and without it the keeper in the last
// section stands against a flat wall where the goal is.
installGoalHoles(true);
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
  // RE-PINNED EVERY SHOT. world.resize() takes the device's pixel ratio, and
  // it runs on any window resize — so showing the Browser pane part-way
  // through a run doubled the drawing buffer to 2560x1440 while every pixel
  // probe on this page still measured a 1280-wide frame. The markers check
  // then failed on a picture that was perfectly correct.
  world.renderer.setPixelRatio(1);
  world.renderer.setSize(1280, 720, false);
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
// The widest the shot can be asked to go, measured off this page's own frame
// (versusZoomFloor) rather than typed — the same number the backdrop is built
// for, which is the whole point of looking at it here.
const zoomMin = versusZoomFloor();
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
// PROBE: the same frame with the throw off, so a failure here can be told
// apart from the throw dimming the spill.
// THE THROW IS NOT WHAT DIMS THIS. Measured with tunnelFalloff forced to 1,
// this region reads exactly what it reads with the throw on — so a failure
// below is the light's own spill and feather, never the corridor's
// absorption. Kept as a probe because the two are easy to confuse and one of
// them is a tuning slider somebody moved this morning.
{
  const tunedThrow = CONFIG.versus.goal.tunnelFalloff;
  CONFIG.versus.goal.tunnelFalloff = 1; refreshGoalGlow();
  log(`the same region with the throw OFF: ${(greenShare(pixels(), ...region) * 100).toFixed(2)}%`);
  CONFIG.versus.goal.tunnelFalloff = tunedThrow; refreshGoalGlow();
}
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
// THE TRIM — bringing the falloff in without touching its edge.
//
// CONFIG.versus.goal.trim is the power the falloff is raised to, and the claim
// it makes is one that feather and spill cannot: the light carries less far
// and the edge it stops at does NOT get sharper. Both halves are about a
// PROFILE rather than about a frame, so both are measured off one here — the
// green channel along a row out from the face into the open water, which is
// the falloff with nothing in the way of it.
//
//   IT SHORTENS THE LIGHT.   the profile has to die sooner as trim comes down.
//   IT CANNOT MAKE A LINE.   the steepest step in that profile must NOT grow.
//
// The second is the whole point of the control, and the only way to say it
// honestly is against the alternative: feather pulled down far enough to reach
// the same distance, which gets there by drawing the same edge steeper. Both
// are measured, so the claim is a comparison rather than an assertion.
//
// AT THE TUNED FEATHER, whatever that is. This ran first against a page that
// forced its own, and passed every line while the control did nothing at all:
// the tuning in the file is feather 1, where the first parameterisation of
// this — sliding the ramp inward inside its own reach — has no room to move
// and is exactly inert. A look page that sets up its own subject cannot find
// that. So the profile is taken at the numbers the game is actually carrying.
//
// NOISE OFF AND THE GLOW DOWN. A saturated light clips its own profile flat
// and every gradient in it reads the same; the noise puts a step between
// neighbouring pixels that has nothing to do with the falloff. Both would
// answer this question wrongly and neither would look wrong.
// ---------------------------------------------------------------------------
{
  place(bounds.left + world.halfExtents(2).w - reach, gy, 2);
  const G = CONFIG.versus.goal;
  const saved = { glow: G.glow, spill: G.spill, spillOut: G.spillOut, feather: G.feather, trim: G.trim, noise: G.noise.enabled };
  G.glow = 1.2; G.noise.enabled = false;
  // Out into the OPEN WATER, where spillOut is the reach and nothing is drawn
  // over the light. Past the lips it is rock and the boulders own those pixels.
  const y = 360;
  const x0 = px(rockX(-1));
  const x1 = Math.min(1279, px(rockX(-1) + G.spillOut * 1.3));
  // THE LIGHT'S OWN CONTRIBUTION, and not the frame's brightness.
  //
  // The first cut of this read the GREEN channel, because the left goal is the
  // green team in the defaults — and the tuning in the file has colors null and
  // a left goal that is not green at all. Every sample came back as backdrop
  // and composite grain, which is flat: the profile read 849px of reach at
  // every trim and the sweep passed its softness check while proving nothing.
  //
  // So: brightest channel, minus a BASELINE taken with the glow at zero. The
  // light is additively blended, so glow 0 contributes exactly nothing and the
  // difference is exactly the light — whatever colour the teams happen to be,
  // and with the rock, the water and the grain subtracted rather than hoped
  // past. Three rows averaged to drop what is left of the grain.
  const row = (canvas) => {
    const w = x1 - x0;
    const d = canvas.getContext('2d').getImageData(x0, y - 1, w, 3).data;
    const out = new Float32Array(w);
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let r = 0; r < 3; r++) {
        const o = ((r * w) + i) * 4;
        sum += Math.max(d[o], d[o + 1], d[o + 2]);
      }
      out[i] = sum / 3;
    }
    return out;
  };
  const litGlow = G.glow;
  G.glow = 0; refreshGoalGlow();
  const baseline = row(pixels());
  G.glow = litGlow; refreshGoalGlow();
  const profile = (canvas) => {
    const r = row(canvas);
    for (let i = 0; i < r.length; i++) r[i] = Math.max(0, r[i] - baseline[i]);
    return r;
  };
  // How far the light carries, in pixels: the last sample still above a tenth
  // of the profile's own peak. Relative, because trim changes the peak nothing
  // and a fixed threshold would be measuring the glow instead.
  const reachOf = (pr) => {
    const peak = Math.max(...pr);
    let last = 0;
    for (let i = 0; i < pr.length; i++) if (pr[i] > peak * 0.1) last = i;
    return last;
  };
  // The steepest fall between neighbouring pixels, as a share of the peak. THIS
  // is the hard line: an edge is a big number here whatever it looks like in a
  // thumbnail, and a soft ramp is a small one however short it is.
  const steepest = (pr) => {
    const peak = Math.max(1, Math.max(...pr));
    let worst = 0;
    for (let i = 1; i < pr.length; i++) worst = Math.max(worst, (pr[i - 1] - pr[i]) / peak);
    return worst;
  };

  const runs = [];
  for (const t of [1, 0.6, 0.4, 0.25]) {
    G.trim = t; refreshGoalGlow();
    const c = await shot(`left mouth, trim ${t}`, t === 1 ? 'the tuned default — the square this replaced, to the pixel' : `the tail raised to ${(2 / t).toFixed(1)}: shorter, and a flatter shoulder`);
    const pr = profile(c);
    runs.push({ t, reach: reachOf(pr), step: steepest(pr) });
  }
  for (const r of runs) log(`  trim ${r.t}: carries ${r.reach}px, steepest step ${(r.step * 100).toFixed(2)}% of peak`);

  const full = runs[0]; const shortest = runs[runs.length - 1];
  check('the trim shortens the light', shortest.reach < full.reach - 4,
    `${full.reach}px at trim 1 down to ${shortest.reach}px at trim ${shortest.t}`);
  check('...and every step of it is shorter than the one before',
    runs.every((r, i) => i === 0 || r.reach <= runs[i - 1].reach + 2),
    runs.map((r) => `${r.t}:${r.reach}px`).join(' '));
  // The claim. Not "the edge is soft" — it was soft at trim 1 — but that
  // trimming does not MAKE it harder, which is the thing feather does.
  const worstStep = Math.max(...runs.map((r) => r.step));
  check('...and it never sharpens the edge to do it', worstStep <= full.step * 1.25 + 0.01,
    `worst ${(worstStep * 100).toFixed(2)}% vs ${(full.step * 100).toFixed(2)}% untrimmed`);

  // THE ALTERNATIVES, measured — the two knobs that were already here, asked to
  // do the same job.
  //
  // FEATHER CANNOT, AND NOT BECAUSE IT IS SET WRONG. It is the share of the
  // reach that fades, so taking it DOWN lengthens the light: a small feather is
  // a flat slab out to the rim with a quick edge on the end of it, which is
  // both further and harder. The direction that shortens is up, and the tuning
  // in the file already has it at 1 — the ceiling, the whole reach ramped,
  // nowhere left to go. That is the wall this control exists on the far side
  // of, so it is worth measuring rather than asserting: the first cut of this
  // page swept feather DOWNWARD looking for a shorter light and reported 849px
  // every time, which is the frame's full width and means saturated.
  G.trim = 1;
  const atFeather = [];
  for (const f of [1, 0.5, 0.15]) {
    G.feather = f; refreshGoalGlow();
    const pr = profile(pixels());
    atFeather.push({ f, reach: reachOf(pr), step: steepest(pr) });
  }
  for (const r of atFeather) log(`  feather ${r.f}: carries ${r.reach}px, steepest step ${(r.step * 100).toFixed(2)}% of peak`);
  check('feather cannot shorten the light — down is LONGER, and up is already spent',
    atFeather[2].reach >= atFeather[0].reach - 2 && (saved.feather ?? 0.55) >= 0.99,
    `${atFeather[0].reach}px at feather 1 (the tuned value, and the ceiling) vs ${atFeather[2].reach}px at 0.15`);
  G.feather = saved.feather;

  // SPILLOUT CAN, and this is what it costs. The reach pulled in until the
  // light dies about where the trimmed one does — the same distance by the
  // other route, and the edge it takes to get there.
  const savedOut = G.spillOut;
  let byOut = null;
  for (const o of [saved.spillOut * 0.75, saved.spillOut * 0.5, saved.spillOut * 0.35, saved.spillOut * 0.25]) {
    G.spillOut = o; refreshGoalGlow();
    const pr = profile(pixels());
    byOut = { o, reach: reachOf(pr), step: steepest(pr) };
    if (byOut.reach <= shortest.reach + 8) break;
  }
  await shot(`left mouth, spillOut ${byOut.o.toFixed(0)} instead`,
    `about the same reach by pulling the rim in — ${byOut.reach}px, and the edge it takes to get there`);
  log(`  spillOut ${byOut.o.toFixed(0)}: carries ${byOut.reach}px, steepest step ${(byOut.step * 100).toFixed(2)}% of peak`);
  check('...and spillOut, reaching the same distance, is the harder edge',
    byOut.step > shortest.step, `${(byOut.step * 100).toFixed(2)}% vs the trim's ${(shortest.step * 100).toFixed(2)}%`);
  G.spillOut = savedOut;

  // AND 1 IS EXACTLY WHAT SHIPPED. A default that is not a no-op is a silent
  // retune of a light somebody already tuned, and it would arrive looking like
  // a bug in the trim rather than like a moved number.
  // AND 1 CHANGES NOTHING — against a CONTROL, because two renders of this page
  // are never the same picture: pixels() advances the surface and the sky four
  // frames every time it is called. So the control is that churn with nothing
  // touched at all, and the test is that removing the trim adds none of its
  // own on top of it. On the PROFILE rather than the whole frame, which is
  // where the light is and where most of the sky is not.
  G.feather = saved.feather;
  G.trim = 1; refreshGoalGlow();
  const withOne = profile(pixels());
  const gap = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
  const churn = gap(withOne, profile(pixels()));
  delete G.trim; refreshGoalGlow();
  const moved = gap(withOne, profile(pixels()));
  check('trim 1 is the light with no trim at all', moved <= churn + 2,
    `worst sample moved ${moved.toFixed(1)}/255, against ${churn.toFixed(1)} the page moves on its own`);

  Object.assign(G, { glow: saved.glow, spill: saved.spill, spillOut: saved.spillOut, feather: saved.feather });
  G.noise.enabled = saved.noise;
  if (saved.trim == null) delete G.trim; else G.trim = saved.trim;
  refreshGoalGlow();
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

  // THE COLOUR CHANGES HANDS as an attacker swims in. This is the LEFT mouth,
  // which is team 0's goal — so it is team 1, the red one, that takes it over
  // by swimming in. At the tuned glow, because that is where the colour is
  // the whole read.
  CONFIG.versus.goal.glow = tuned.glow; CONFIG.versus.goal.spill = tuned.spill;
  refreshGoalGlow();
  push();
  const attackFrom = await shot('left mouth, no attacker in it', 'the mouth in the colour of the team that defends it');
  setGoalSwimmers([{ x: rockX(-1) - 4, y: gy, vx: -20, vy: 0, color: CONFIG.versus.teams[1].color, tint: 1 }]);
  push();
  const taken = await shot('left mouth, an attacker deep in it', "swimming in brings the attacker's colour with it");
  const tookRed = redShare(taken, ...mouthRegion);
  check('an attacker in the goal it is attacking takes the colour over',
    tookRed > redShare(attackFrom, ...mouthRegion) + 0.08,
    `red ${(redShare(attackFrom, ...mouthRegion) * 100).toFixed(1)}% → ${(tookRed * 100).toFixed(1)}% with a seal in the mouth`);
  // ...and it is the SEAL that carries it: half a pitch away, nothing.
  setGoalSwimmers([{ x: 0, y: gy, vx: 0, vy: 0, color: CONFIG.versus.teams[1].color, tint: 1 }]);
  push();
  const far = await shot('left mouth, the attacker out in the water', 'the same tint on a seal that is nowhere near it');
  check('...and the colour travels with the seal, not with the tint', redShare(far, ...mouthRegion) < tookRed * 0.25,
    `${(redShare(far, ...mouthRegion) * 100).toFixed(1)}% with the seal at centre vs ${(tookRed * 100).toFixed(1)}% with it in the mouth`);
  setGoalSwimmers([]);
  CONFIG.versus.goal.glow = 1.2; CONFIG.versus.goal.spill = 8;
  refreshGoalGlow();
  push();

  // THE BALL IN THE LIGHT — it overdrives and boils where it overlaps, and
  // the pair is at the same clock so only the ball is different. In the mouth
  // where the light is brightest, which is the hardest place to show a
  // brightening: if it reads there it reads anywhere.
  CONFIG.versus.goal.glow = tuned.glow; CONFIG.versus.goal.spill = tuned.spill;
  refreshGoalGlow();
  resetGoalStir();
  push();
  const noBall = await shot('left mouth, no ball in it', 'the mouth at the tuned glow, nothing in it');
  const litRegion = [Math.max(0, px(rockX(-1) - 12)), 200, Math.max(1, px(rockX(-1) + 2)), 520];
  const meanOf = (canvas, r) => {
    const d = canvas.getContext('2d').getImageData(r[0], r[1], r[2] - r[0], r[3] - r[1]).data;
    let sum = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) { n++; sum += Math.max(d[i], d[i + 1], d[i + 2]); }
    return sum / Math.max(1, n);
  };
  setGoalBall({ x: rockX(-1) - 4, y: gy, amount: 1 });
  push();
  const withBall = await shot('left mouth, the ball arriving in it', 'the same frame, same clock — the light blazing and boiling round the ball');
  const ballMoved = diffPct(withBall, noBall, litRegion);
  check('the ball overdrives and boils the light it is in', ballMoved > 3, `${ballMoved.toFixed(1)}% of the lit mouth changed with the ball in it (mean ${meanOf(noBall, litRegion).toFixed(0)} → ${meanOf(withBall, litRegion).toFixed(0)})`);
  // ...and a ball out in the water does nothing: the amount is versus.js's
  // to decide and 0 has to park it, or every frame of open play would blaze.
  setGoalBall(null);
  push();
  const parked = await shot('left mouth, the ball parked', 'the ball out in the water: nothing');
  check('...and a ball out in the water leaves it alone', diffPct(parked, noBall, litRegion) < ballMoved * 0.4,
    `${diffPct(parked, noBall, litRegion).toFixed(1)}% vs ${ballMoved.toFixed(1)}% with it in the mouth`);

  // THE SHOT COMING IN. The shooter's colour takes the light over as the ball
  // nears the goal LINE — and it spreads as it comes on, so the three frames
  // below are a sequence and not three settings: far out, half way, on the
  // line. Team 1, the red one, shooting into team 0's green goal.
  const lineX = goalLineX(-1);
  const lead = CONFIG.versus.goal.ball.tintLead;
  // HOW FAR TOWARD RED, not whether red has won. redShare above is a hue
  // DOMINANCE test: it reads a flat zero until the mix has crossed a
  // threshold, so a take-over that is genuinely a fifth of the way there
  // measures as nothing at all having happened — which is what the first
  // version of this check reported about a picture that was correct.
  const towardRed = (canvas, r) => {
    const d = canvas.getContext('2d').getImageData(r[0], r[1], r[2] - r[0], r[3] - r[1]).data;
    let sum = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) { n++; sum += d[i] - d[i + 1]; }
    return sum / Math.max(1, n);
  };
  const shotAt = async (short, title, caption) => {
    setGoalBall({ x: lineX + short, y: gy, side: -1, amount: short <= 0 ? 1 : 0, tint: Math.max(0, Math.min(1, 1 - short / lead)) * CONFIG.versus.goal.ball.tint, color: CONFIG.versus.teams[1].color });
    push();
    const c = await shot(title, caption);
    return towardRed(c, mouthRegion);
  };
  const shotFar = await shotAt(lead + 10, 'left goal, the shot still miles out', 'nobody has taken this light over yet');
  const shotHalf = await shotAt(lead * 0.5, 'left goal, the shot closing', "the shooter's colour coming in ahead of it, local to the ball");
  const shotOn = await shotAt(0, 'left goal, the shot on the line', 'full, and spread across the whole mouth');
  check('the shooter\'s colour takes the light over as the shot nears the line',
    shotHalf > shotFar + 4 && shotOn > shotHalf + 20,
    `red-over-green ${shotFar.toFixed(0)} far out → ${shotHalf.toFixed(0)} closing → ${shotOn.toFixed(0)} on the line`);
  // ...AND THE KEEPER ARGUING WITH IT. The same shot, on the line, with seal 0
  // standing in its own goal: its colour and its churn go into the same field
  // additively, so the mouth is contested rather than taken.
  setGoalSwimmers([{ x: rockX(-1) - 3, y: gy, vx: 8, vy: 0, color: CONFIG.versus.teams[0].color, tint: 0.9, defend: 1 }]);
  push();
  const contested = await shot('left goal, the keeper arguing with it', "the shot on the line, and the keeper's own colour and churn pushed back into it");
  const contestedRed = towardRed(contested, mouthRegion);
  check('a keeper in the goal pushes the shot\'s colour back',
    contestedRed < shotOn - 20,
    `red-over-green ${shotOn.toFixed(0)} with the shot alone → ${contestedRed.toFixed(0)} with the keeper arguing`);
  // ...and it is a MIX, not a replacement: the shot is still in there.
  check('...contested, not simply reclaimed', contestedRed > shotFar + 10,
    `${contestedRed.toFixed(0)} contested vs ${shotFar.toFixed(0)} with no shot at all`);
  setGoalSwimmers([]);
  setGoalBall(null);
  push();

  // THE THROW: flat versus the tuned absorption, looking down the corridor.
  // Measured as a GRADIENT — how much dimmer the mouth is than the far end —
  // because a flat light and a thrown one can have the same mean and the
  // whole point is that they do not have the same profile.
  // INSIDE THE FRAME. The camera reaches `reach` past the wall and no
  // further, so the corridor it can see runs from bounds.left - reach to the
  // drawn face — about ten units. Boxes at the tunnel's back would be off the
  // left of the picture, clamped to column 0, and both would then measure the
  // same strip of nothing: the first version of this check did exactly that
  // and reported the gradient running the wrong way.
  const frameLeft = bounds.left - reach;
  const deepBox = [Math.max(0, px(frameLeft + 0.5)), 140, Math.max(2, px(frameLeft + 3.5)), 580];
  const mouthBox = [Math.max(0, px(rockX(-1) - 3)), 140, Math.max(2, px(rockX(-1))), 580];
  // EACH BOX AGAINST ITSELF, thrown over flat — never one box against the
  // other. The deep box is full of the corridor's roof and floor and the
  // mouth box is not, so the two are not comparable however bright the light
  // in them is; the first version of this compared them and reported the
  // gradient running the wrong way up a picture that was perfectly correct.
  // What a throw means is that the mouth loses MORE of itself than the deep
  // corridor does, and that is a pair of ratios each measured in one place.
  const savedThrow = CONFIG.versus.goal.tunnelFalloff;
  CONFIG.versus.goal.tunnelFalloff = 1; refreshGoalGlow(); push();
  const flat = await shot('left goal, no throw', 'tunnelFalloff 1: the corridor as flat as it always was');
  CONFIG.versus.goal.tunnelFalloff = savedThrow; refreshGoalGlow(); push();
  const thrown = await shot('left goal, thrown down the tunnel', `tunnelFalloff ${savedThrow}: the source is the tunnel's back, off the frame, and this is what reaches the mouth`);
  const keptDeep = meanOf(thrown, deepBox) / Math.max(1, meanOf(flat, deepBox));
  const keptMouth = meanOf(thrown, mouthBox) / Math.max(1, meanOf(flat, mouthBox));
  check('the light falls off down the tunnel toward the water', keptMouth < keptDeep - 0.05,
    `the mouth keeps ${(keptMouth * 100).toFixed(0)}% of its flat brightness, the deep corridor ${(keptDeep * 100).toFixed(0)}%`);
  // ...and the SLAB does not throw with it, or the corridor would turn into a
  // window onto the seabed exactly where the camera is pointed.
  {
    const backs = world.scene.children.flatMap((c) => c.children ?? []).filter((m) => m.userData?.goalPart === 'back');
    check('...but the slab behind it does not, so the corridor stays closed',
      backs.length === 2 && backs.every((m) => !/goalThrow/.test(m.material.fragmentShader)),
      `${backs.length} slab(s)`);
  }
  CONFIG.versus.goal.glow = 1.2; CONFIG.versus.goal.spill = 8;
  refreshGoalGlow();
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
// ---------------------------------------------------------------------------
// THE GOAL ITSELF — a shot going in, the bang, and the two bodies thrown.
//
// Everything above this point photographs the goal as GEOMETRY AND LIGHT: the
// hole, the quad behind it, the field that breaks it up. None of it has a seal
// or a ball in it, because none of those things need one. The shockwave does:
// it is the one part of a goal whose whole subject is an animal, and the Node
// harness can only tell you a number went up.
//
// SO THIS SCORES ONE. Two real seal bodies (buildSealBody, the same call a
// match makes), the real ball stepped by the real soft body (stepBallAlone),
// and on the frame its near edge crosses the goal line the two calls goal()
// makes — fireGoalJet and goalBlast. From there the bodies are carried by
// updatePlayer, exactly as a match carries them: the shove as real velocity,
// the knock decaying on its own clock, clampToArena holding the keeper inside
// the mouth. poseBody turns the skeletons, which is where the limp lives.
//
// WHAT THE LAB SUPPLIES is only what a match would have: the phase machine
// that notices the ball has crossed. `goals: false` on stepBallAlone is what
// makes that the lab's job rather than versus.js's — the ball lab wants a ball
// that bounces off all four walls, and this page wants to choose the frame.
//
// A STRIP AND NOT A LOOP. The Browser pane suspends rAF, and a goal is a
// second and a half of motion — so it is filmed: fixed frame, fixed marks off
// the moment of the goal, every shot posted to disk. Two seals at two
// distances in one frame, so the falloff is a thing you can see rather than a
// number in the F panel.
// ---------------------------------------------------------------------------
{
  const side = -1;
  const faceX = rockX(side);
  const lineX = goalLineX(side);
  // The bodies. Seat 0 through initPlayer, which is also what gives it the
  // stats updatePlayer swims on; seat 1 the way versus.js builds every seat
  // past the first.
  initPlayer(world.scene);
  resetPlayer();
  buildSealBody(p2, world.scene, { name: 'player2', celebrateTag: 'p2' });
  initBallAlone();
  // A Vector2, not a literal — updatePlayer asks it for lengthSq, and a plain
  // {x, y} throws on the first frame of the sim.
  const idle = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0) };

  // THE KEEPER, inside the mouth on its own line, and THE STRIKER out in the
  // water — two distances from the same bang, which is the read.
  const keeper = player;
  const striker = p2;
  const startKeeper = { x: faceX - 2, y: gy + 1 };
  const startStriker = { x: faceX + 24, y: gy + 5 };
  keeper.mesh.position.set(startKeeper.x, startKeeper.y, 0);
  striker.mesh.position.set(startStriker.x, startStriker.y, 0);
  for (const seal of [keeper, striker]) {
    seal.velocity.set(0, 0);
    seal.knockX = 0; seal.knockY = 0;
    const j = seal.jolt;
    if (j) { j.spin = j.spinV = j.roll = j.rollV = 0; j.free = 0; }
    seal.mesh.visible = true;
  }
  // The shot: struck from outside the box, on its way in.
  ball.live = true;
  ball.x = bounds.left + 42;
  ball.y = gy + 5;
  ball.vx = -58;
  ball.vy = -7;

  // ONE FIXED FRAME for the whole strip, so the shots can be read against each
  // other. The mouth sits in the left third and the rest is the water the
  // bodies are thrown into.
  const halfW = world.halfExtents(1.5).w;
  place(faceX + halfW * 0.62, gy, 1.5);
  updateParticleScale(world.camera, world.renderer);
  updateOutlineScale(world.camera, world.halfExtents(1).h * 2);

  const sim = 1 / 60;
  let t = -1;                 // seconds since the goal; -1 until it is called
  let fired = false;
  // Whether the ball is still being carried by its own physics — see the note
  // at the mouth below, where the lab takes the last few units over.
  let flying = true;
  const before = { keeper: { ...startKeeper }, striker: { ...startStriker } };
  let peakSpin = 0;
  // Step the world one frame: the ball, the jet, the bodies, the skeletons.
  const step = () => {
    if (flying) stepBallAlone(sim);
    updateGoalJets(sim, [
      { x: keeper.mesh.position.x, y: keeper.mesh.position.y, heading: keeper.mesh.rotation.z + Math.PI / 2 },
      { x: striker.mesh.position.x, y: striker.mesh.position.y, heading: striker.mesh.rotation.z + Math.PI / 2 },
    ]);
    for (const seal of [keeper, striker]) {
      updatePlayer(sim, idle, seal, seal === player ? undefined : seal.strike);
      poseBody(seal, sim, Math.cos(seal.mesh.rotation.z + Math.PI / 2), Math.sin(seal.mesh.rotation.z + Math.PI / 2));
    }
    peakSpin = Math.max(peakSpin, Math.abs(keeper.jolt?.spin ?? 0));
    renderBall();
    tickGoalGlow(sim);
    updateParticles(sim);
    if (t >= 0) t += sim;
  };

  // THE APPROACH. Two shots before the goal, so the strip opens on a ball that
  // is still in play and a keeper that still has a chance.
  //
  // EVERY LOOP IS BOUNDED. A `while (ball.x > line)` hangs the whole page the
  // first time the ball stops short, and a hung look page presents as a
  // contact sheet that is simply missing its last third — which reads as a
  // shot that failed to post rather than as a loop that never ended.
  //
  // THE STOPS ARE OFF bounds.left, not off the rock face. stepBallAlone passes
  // `goals: false` to stepBall, which makes the left WALL solid — the ball
  // stops at bounds.left + its own radius and cannot reach the face, let alone
  // the line. Asked to run to the face, this loop spent its whole 600-frame
  // cap bouncing the ball off the wall and floating it up to the surface, and
  // the goal then fired from twenty-eight units above the mouth.
  const runTo = (stop, cap = 600) => { for (let k = 0; k < cap && !stop(); k++) step(); };
  runTo(() => ball.x <= bounds.left + 26);
  await shot('the shot coming in', `the ball ${(ball.x - lineX).toFixed(1)} units short of the line, the keeper on it`);
  runTo(() => ball.x <= bounds.left + 9);
  await shot('at the mouth', 'the last frame that is still a save');

  // THROUGH THE MOUTH BY HAND, and only this stretch — about fifteen units of
  // a hundred-unit flight. The solid wall above is why: the shipped flight
  // cannot cross a line the ball lab's step will not let it reach. Nothing
  // happens to a ball travelling down the middle of the band anyway (the lips
  // are what the corridor is, and this one is nowhere near them), so it
  // carries on at the velocity the real physics left it with. Everything
  // before this is the shipped flight.
  flying = false;
  for (let k = 0; k < 240 && ball.x > lineX; k++) {
    ball.x += ball.vx * sim;
    ball.y += ball.vy * sim;
    step();
  }

  // THE GOAL. The two calls goal() makes, on the frame the ball is past the
  // line — the jet from inside the tunnel, and the shockwave out of the same
  // point (goalJetOrigin, so the goo and the shove cannot disagree).
  ball.live = false;
  fired = true;
  t = 0;
  resetGoalJets();
  flashGoalScored(side, 1);
  fireGoalJet(side, ball.y, 1);
  const caught = goalBlast(side, ball.y);
  const src = goalJetOrigin(side, ball.y);
  log(`the goal: ball across at y ${ball.y.toFixed(1)}, bang at x ${src.x.toFixed(1)} (${(faceX - src.x).toFixed(1)} deep), ${caught} seal(s) caught`);
  log(`  the shove: keeper ${(keeper.velocity.x + keeper.knockX).toFixed(1)} u/s out, striker ${(striker.velocity.x + striker.knockX).toFixed(1)} u/s out`);
  await shot('the goal', `the frame it crosses — ${caught} seal(s) in the blast, the mouth turning the scorer's colour`);

  // ...AND THE SECOND AND A HALF AFTER IT. The marks are the shape of the
  // moment: the goo still in the rock, the goo arriving, the bodies going
  // over, and the tumble running out.
  const marks = [
    [0.10, 'the jet in the corridor', 'the goo still inside the rock, the bodies already going'],
    [0.22, 'out of the mouth', 'the cloud squeezing out, the keeper thrown clear of its own line'],
    [0.40, 'the bodies over', 'the tumble at its widest'],
    [0.70, 'spreading', 'the goo tumbling free of the rock, both seals still limp'],
    [1.20, 'the tumble running out', 'the righting spring has the bodies back'],
  ];
  for (const [at, title, caption] of marks) {
    for (let k = 0; k < 600 && t < at; k++) step();
    await shot(title, caption);
  }

  // WHAT THE PICTURES ARE OF. A strip proves nothing on its own — a page that
  // quietly stopped firing the blast would post six shots of a seal sitting
  // still, and they would look like tuning rather than like a bug.
  const moved = (seal, from) => Math.hypot(seal.mesh.position.x - from.x, seal.mesh.position.y - from.y);
  const keeperMoved = moved(keeper, before.keeper);
  const strikerMoved = moved(striker, before.striker);
  check('the goal throws both seals', keeperMoved > 4 && strikerMoved > 0.5,
    `keeper ${keeperMoved.toFixed(1)} units, striker ${strikerMoved.toFixed(1)} units`);
  check('...out of the goal rather than into it', keeper.mesh.position.x > before.keeper.x + 2,
    `keeper x ${before.keeper.x.toFixed(1)} → ${keeper.mesh.position.x.toFixed(1)}, face ${faceX.toFixed(1)}`);
  check('...hardest on the line', keeperMoved > strikerMoved * 1.5,
    `${keeperMoved.toFixed(1)} vs ${strikerMoved.toFixed(1)} units`);
  const cap = CONFIG.player.jolt.max ?? 2.6;
  check('...and the body goes past the righting spring\'s cap: a tumble, not a wobble',
    peakSpin > cap, `${peakSpin.toFixed(2)} rad, cap ${cap}`);
  check('...and the jet actually ran over these frames', goalJets().length >= 0 && goalJetOrigin(side, ball.y).x < faceX,
    `bang ${(faceX - src.x).toFixed(1)} units inside the rock`);

  resetGoalJets();
  clearGoalScored();
  keeper.mesh.visible = false;
  striker.mesh.visible = false;
}

check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
log(`posted ${posted.length} shots: ${posted.join(', ')}`);
log(fails ? `${fails} FAILED` : 'all passed', fails ? 'bad' : 'ok');
