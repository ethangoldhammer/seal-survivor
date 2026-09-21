// ---------------------------------------------------------------------------
// THE BOOST AURA — LOOK DEV
//
//   npm run looks:aura
//
// The question this sheet exists to answer: while the seal is burning fuel,
// does the water around it read as CHARGED — bright, turbulent, and moving
// outward — and can you tell how much fuel is left from its colour alone?
//
// WHY A PAGE AND NOT A NODE HARNESS. The shell is one GLSL program, and a GLSL
// error renders NOTHING and throws nothing a Node harness can see: the aura
// would simply be absent from the game with a clean test suite. tools/boost-
// aura-test.mjs drives the state machine frame by frame and cannot see a single
// pixel; this page imports the SHIPPING module and the SHIPPING post chain, so
// a panel that comes up black is a real compile failure and the reach checks
// below are measured off the pixels the game would actually draw.
//
// IT DRIVES THE REAL STRIKE STATE rather than posing uniforms by hand, which is
// the opposite of what the core's sheet next door does and is right for the
// opposite reason. The core's sheet is about what the meter DRAWS for a given
// state; this one is about the colour handed to it, and that colour is looked
// up from the pip the DRAIN is eating. Posing it would be a picture of the
// lookup I meant to write.
//
// IT WRITES NOTHING. The CONFIG assignments below are into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { createPost } from '../../path/src/systems/post.js';
import { createBoostAuraInstance, bodyReach, drainingPip } from '../../path/src/systems/boostAura.js';
// THE INSTRUMENT, as the brightness reference — see peak() below. Also the
// honest frame: in a run these two are drawn in the same water on the same
// plane, and a shell judged on its own is judged against nothing.
import { createStrikeRing, updateStrikeRing, resetStrikeRing, pipRGB } from '../../path/src/systems/strikeRing.js';
import { settings } from '../../path/src/systems/settings.js';
import {
  createStrikeState, resetStrike, updateCharge, pipCount, windUpTime,
} from '../../path/src/systems/strike.js';
import { flowSpeed } from '../../path/src/systems/boostAura.js';
import {
  initParticles, resetParticles, updateParticles, updateParticleScale, particleCount,
} from '../../path/src/entities/particles.js';

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

// A shader that fails to compile renders NOTHING and three only writes to the
// console about it, so the page would look like a bad tuning decision rather
// than a broken program.
const shaderErrors = [];
const realError = console.error.bind(console);
console.error = (...args) => {
  const s = args.map((a) => String(a)).join(' ');
  if (/shader|glsl|program|compile/i.test(s)) shaderErrors.push(s);
  realError(...args);
};

const W = 340;
const H = 340;
const DT = 1 / 60;
// A magnifying glass at 16 world units, against the ~44 the game frames the
// seal in. The last section drops back to the game's own framing, because a
// look that only works under a magnifier is not a look.
const VIEW = 16;
const GAME_VIEW = 44;

// ONE WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Water, because the shell composites ADDITIVELY and a panel over empty black
// flatters it. What it looks like over the blue it is drawn on is the question.
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshBasicMaterial({ color: 0x14344a }),
);
water.position.z = -40;
scene.add(water);

// A stand-in for the seal at the shipped size, so the shell is judged with the
// animal it has to sit outside of actually in the frame. No GLB loads here for
// the same reason none loads in the Node harness; what matters is that the body
// and the BOX handed to the aura are the same object, or the inner edge would
// be measured against a seal that is not on screen.
const HALF_LEN = 1.8;
const HALF_GIRTH = 0.9;
const seal = new THREE.Mesh(
  new THREE.CapsuleGeometry(HALF_GIRTH, (HALF_LEN - HALF_GIRTH) * 2, 4, 14),
  new THREE.MeshBasicMaterial({ color: 0x1d2c3a }),
);
seal.rotation.z = Math.PI / 2;
scene.add(seal);
const BOX = new THREE.Box3(
  new THREE.Vector3(-HALF_LEN, -HALF_GIRTH, -HALF_GIRTH),
  new THREE.Vector3(HALF_LEN, HALF_GIRTH, HALF_GIRTH),
);

const camera = new THREE.OrthographicCamera(
  -VIEW * (W / H) / 2, VIEW * (W / H) / 2, VIEW / 2, -VIEW / 2, -100, 100,
);
camera.position.set(0, 0, 20);
const gameCam = new THREE.OrthographicCamera(
  -GAME_VIEW * (W / H) / 2, GAME_VIEW * (W / H) / 2, GAME_VIEW / 2, -GAME_VIEW / 2, -100, 100,
);
gameCam.position.set(0, 0, 20);

// The WHEEL view, pinned before anything is drawn: settings.hud.boostMeter
// ships as 'bar', which moves the pips to a DOM column and leaves this
// instrument drawing the charge half only — a reference with no fuel ring in
// it. Mutated in memory only; this page has its own origin and no save path.
settings.hud.boostMeter = 'ring';

// THE PARTICLE BUFFER, in the same scene: the shatter at the end of this sheet
// is the real emitter through the real buffer, so a burst that comes out at
// the wrong SIZE is visible here rather than only correct in a Node harness.
// updateParticleScale is what makes a speck the right number of pixels for the
// camera, and without it every panel below would show them at the game's own
// framing while this page is a magnifying glass.
initParticles(scene);

const post = createPost(gl);
const ring = createStrikeRing();
scene.add(ring);
const aura = createBoostAuraInstance();
scene.add(aura.mesh);
const U = aura.mesh.material.uniforms;

const ORIGIN = new THREE.Vector3(0, 0, 0);
const PIPS = pipCount(null);
const BURN = windUpTime(null);
const INNER = bodyReach(BOX) + (CONFIG.boostAura.gap ?? 0.12);

// A strike state of the page's own, opened full and burned by the REAL
// updateCharge — see the header for why this is not posed.
let st = createStrikeState();
function rewind() {
  st = createStrikeState();
  resetStrike(st);
  st.charge = 1;
  aura.reset();
  resetStrikeRing();
}
// EVERY PANEL IS AIMED THE SAME WAY unless one says otherwise — straight
// right, so the direction of the flow is readable across the whole sheet
// rather than being a different guess per section.
const EAST = { x: 1, y: 0 };

/** Burn for `seconds`, then draw. `held` false lets go and lets it fade. */
function burn(seconds, held = true, dt = DT, aim = EAST) {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) {
    updateCharge(dt, held, null, st);
    aura.update(dt, ORIGIN, st, true, { box: BOX, stats: null, aim, held });
    updateStrikeRing(dt, ORIGIN, st, true, null);
  }
}

// THE INSTRUMENT IS OFF IN MOST PANELS, and that is not tidiness. The fuel
// wheel sits at CONFIG.strike.ring.radius, which is a few tenths outside the
// body — right inside the shell — so a lit ring reads as the shell's own inner
// edge and every question about the shell's shape gets answered by a circle
// that belongs to something else. It goes back on for the brightness section,
// where the whole question is the two of them together.
let showRing = false;
/** The band's own outward push, off the quad's radius — the quad is scaled to
 *  the LONGEST the band gets, which is straight down the dash lane. */
const bandOf = (outer) => (outer - INNER) / Math.max(1e-6, U.uLanePush.value);

function draw(cam = camera) {
  ring.visible = showRing;
  updateParticleScale(cam, gl);
  post.resize();
  post.render(scene, cam, DT);
}

// --- the sheet --------------------------------------------------------------

let shotIndex = 0;
const posted = [];
let row = null;

function section(title, columns) {
  const h = document.createElement('h2');
  h.innerHTML = title;
  document.getElementById('sheet').appendChild(h);
  row = document.createElement('div');
  row.className = 'row';
  row.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  document.getElementById('sheet').appendChild(row);
}

function present(title, note, picked = false) {
  const cell = document.createElement('div');
  cell.className = picked ? 'cell pick' : 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  canvas.style.width = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04070e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gl.domElement, 0, 0);
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b>${picked ? ' <span class="tag">— shipped</span>' : ''}<br>${note}`;
  cell.appendChild(cap);
  row.appendChild(cell);

  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

// --- MEASURING THE SHELL ----------------------------------------------------
// A DIFFERENCE of two renders, with uLife zeroed in the second. Thresholding
// the image alone measures the water or the seal instead — the same trap the
// core's sheet documents next door, and the same fix.
//
// Measured on a RAW render rather than through the post chain: bloom is a blur
// by design and hands back the radius of the halo instead of the radius of the
// shell. The uniform is written directly rather than through CONFIG because
// switching the aura off in the config would need another update() to take
// effect, and that frame would advance the churn — measuring a different shell
// from the one on screen.
const probe = document.createElement('canvas');
probe.width = W * 2;
probe.height = H * 2;
const pctx = probe.getContext('2d', { willReadFrequently: true });
const PX_PER_UNIT = (H * 2) / VIEW;

/**
 * THE BRIGHTEST PIXEL THE SHELL IS RESPONSIBLE FOR, 0..255, through the post
 * chain the game actually composites with.
 *
 * "Bright" is the one word in the brief that is not a shape, and taste is not a
 * measurement — so it is measured against the instrument already drawn in the
 * same water at the same moment: the fuel ring. A difference again, because the
 * ring's own empty track is lit at all times and the water under both is not
 * black.
 */
function peak(toggle) {
  ring.visible = showRing;
  post.resize();
  post.render(scene, camera, DT);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const lit = pctx.getImageData(0, 0, probe.width, probe.height).data;
  const keep = toggle();
  post.resize();
  post.render(scene, camera, DT);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  const off = pctx.getImageData(0, 0, probe.width, probe.height).data;
  toggle(keep);
  let best = 0;
  for (let i = 0; i < lit.length; i += 4) {
    const d = Math.max(lit[i] - off[i], lit[i + 1] - off[i + 1], lit[i + 2] - off[i + 2]);
    if (d > best) best = d;
  }
  return best;
}

function grab() {
  ring.visible = showRing;
  gl.render(scene, camera);
  pctx.clearRect(0, 0, probe.width, probe.height);
  pctx.drawImage(gl.domElement, 0, 0);
  return pctx.getImageData(0, 0, probe.width, probe.height).data;
}

/**
 * The shell's own pixels, as a radius per ray from the seal: the nearest and
 * furthest lit sample along each of 180 rays, in world units. Nulls where a ray
 * found nothing, which is itself a reading — a shell the noise has eaten right
 * through has gaps.
 */
function profile(share = 0.2) {
  const life = U.uLife.value;
  const lit = grab();
  U.uLife.value = 0;
  const off = grab();
  U.uLife.value = life;

  const cx = probe.width / 2;
  const cy = probe.height / 2;
  const rays = 180;
  // RELATIVE TO THE SHELL'S OWN PEAK, not an absolute 10/255 — which is what
  // this used, and it made every shape reading a function of `strength`.
  // Turning the brightness up pushed more of the dim outer noise over a fixed
  // threshold and the leading edge measured SMOOTHER, so a shell that had not
  // changed shape at all failed the raggedness check for being bright. The
  // question here is where the shell's own falloff crosses a fifth of itself,
  // and that is the same question at any gain.
  let top = 0;
  for (let i = 0; i < lit.length; i += 4) {
    const d = Math.max(
      Math.abs(lit[i] - off[i]),
      Math.abs(lit[i + 1] - off[i + 1]),
      Math.abs(lit[i + 2] - off[i + 2]),
    );
    if (d > top) top = d;
  }
  const threshold = Math.max(6, top * share);
  const near = new Array(rays).fill(null);
  const far = new Array(rays).fill(null);
  const maxR = Math.min(cx, cy) - 2;
  for (let a = 0; a < rays; a++) {
    const th = (a / rays) * Math.PI * 2;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    for (let r = 2; r < maxR; r += 1) {
      const x = Math.round(cx + dx * r);
      const y = Math.round(cy + dy * r);
      const i = (y * probe.width + x) * 4;
      const d = Math.max(
        Math.abs(lit[i] - off[i]),
        Math.abs(lit[i + 1] - off[i + 1]),
        Math.abs(lit[i + 2] - off[i + 2]),
      );
      if (d <= threshold) continue;
      if (near[a] === null) near[a] = r / PX_PER_UNIT;
      far[a] = r / PX_PER_UNIT;
    }
  }
  const hit = far.filter((v) => v !== null);
  const mean = hit.reduce((s, v) => s + v, 0) / Math.max(1, hit.length);
  const dev = Math.sqrt(hit.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, hit.length));
  const nearest = near.filter((v) => v !== null);
  // PUT THE POSTED FRAME BACK. Every grab() above is a RAW render straight to
  // the canvas, and the second one has the shell switched off — so a present()
  // called after this photographed bare water and the panel looked like a dead
  // effect measuring perfectly. Redrawing here rather than at each call site
  // because the trap belongs to this function.
  draw();
  return {
    rays: hit.length,
    outer: Math.max(0, ...hit),
    outerMean: mean,
    outerDev: dev,
    inner: nearest.length ? Math.min(...nearest) : 0,
  };
}

// --- THE COMPILE ------------------------------------------------------------
// First, before any panel, so nothing else can be blamed for a black sheet.
rewind();
burn(0.3);
draw();
check('no shader failed to compile', shaderErrors.length === 0, shaderErrors[0] ?? '');
check('the aura linked a program', gl.info.programs.length > 0, `${gl.info.programs.length} programs`);

// --- THE DRAIN --------------------------------------------------------------
section('The drain <span>— one full wind-up, caught on each pip of the bar. The hue is the pip the burn is eating, off the fuel wheel\'s own ramp; nothing here picks a colour.</span>', PIPS);
{
  rewind();
  const step = BURN / PIPS;
  for (let i = 0; i < PIPS; i++) {
    // Land in the MIDDLE of each pip rather than on its boundary, where the
    // colour is about to change and the panel would be ambiguous about which
    // pip it is showing.
    burn(i === 0 ? step * 0.5 : step);
    draw();
    const pip = drainingPip(st.charge, PIPS);
    const hex = '#' + U.uColor.value.getHexString();
    present(`pip ${pip + 1} of ${PIPS}`,
      `bar ${Math.round(st.charge * 100)}% · <b style="color:${hex}">${hex}</b> · reach ${(U.uOuter.value - INNER).toFixed(2)}u`,
      pip === 0);
  }
}

// --- THE PUSH ---------------------------------------------------------------
section('The push <span>— the same burn by the clock instead of by the bar, at fractions of a full wind-up. The inner edge is pinned to the animal; only the leading edge moves.</span>', 4);
{
  // SAMPLED AGAINST THE CAP, not against the wind-up. Both are tuned — `push`
  // and `reach` decide when the shell stops growing, and at the live tuning
  // that is a third of a second in, long before the tank runs dry. Fractions
  // of BURN put three of these four panels past the cap and the section showed
  // one growing shell and three identical ones. The last one is deliberately
  // past it, because "it has arrived and is holding" is the other half of what
  // this section is for.
  const capAt = (CONFIG.boostAura.reach ?? 2.6) / Math.max(1e-6, CONFIG.boostAura.push ?? 3.2);
  const times = [0.12, 0.4, 0.8, 1.6].map((f) => +Math.min(f * capAt, BURN * 0.98).toFixed(3));
  let last = 0;
  rewind();
  const reached = [];
  for (const t of times) {
    burn(t - last);
    last = t;
    draw();
    const p = profile();
    reached.push({ t, p, outer: U.uOuter.value });
    present(`${t.toFixed(2)}s of burn`,
      `shell ${p.inner.toFixed(2)}u → ${p.outer.toFixed(2)}u · band ${bandOf(U.uOuter.value).toFixed(2)}u, quad to ${U.uOuter.value.toFixed(2)}u`,
      t === times[2]);
  }

  const first = reached[0].p;
  check('the shell starts outside the animal, not on it',
    first.inner >= HALF_LEN,
    `nearest lit pixel ${first.inner.toFixed(2)}u, the seal reaches ${HALF_LEN.toFixed(2)}u`);
  check('  ...and it is the body\'s circle it starts on, within a pixel or two',
    Math.abs(first.inner - INNER) < 0.25,
    `${first.inner.toFixed(2)}u vs ${INNER.toFixed(2)}u`);

  // ...so only the panels INSIDE the cap have to have grown. The last one is
  // there to be pinned, and asserting it grew too would be asserting that the
  // cap does not work.
  let grew = true;
  for (let i = 1; i < reached.length; i++) {
    if (reached[i].t > capAt) break;
    if (reached[i].p.outer <= reached[i - 1].p.outer + 0.02) grew = false;
  }
  check('every panel inside the cap reaches further than the one before it', grew,
    reached.map((r) => r.p.outer.toFixed(2)).join(' → '));
  check('  ...and the one past it is holding, not still climbing',
    Math.abs(bandOf(reached[reached.length - 1].outer) - (CONFIG.boostAura.reach ?? 2.6)) < 1e-6,
    `${bandOf(reached[reached.length - 1].outer).toFixed(3)}u of a ${CONFIG.boostAura.reach}u reach`);

  // THE PIXELS AGREE WITH THE UNIFORM. A shell whose drawn edge lags its stated
  // reach by a third would still grow monotonically and still pass every check
  // above; this is the one that says the radius on screen is the radius the
  // system thinks it has pushed to.
  // LOOSER THAN IT WAS, and the reason is the lane rather than a regression.
  // The band is stretched down the aim, so its (1 - x)^falloff profile is
  // spread over a longer distance and the tail is dimmer PER UNIT — the 20%-of-
  // peak contour the profile measures therefore crosses earlier in absolute
  // terms than it did on the symmetrical shell. What is being asserted is that
  // the drawn shell is most of the stated one, not that it fills it to the rim.
  const late = reached[reached.length - 2];
  check('what is drawn reaches most of the way to what the system says',
    late.p.outer > late.outer * 0.55 && late.p.outer <= late.outer * 1.05,
    `drawn ${late.p.outer.toFixed(2)}u against ${late.outer.toFixed(2)}u`);

  // ...AND IT IS TORN. A clean circle is the failure mode that would make this
  // a halo rather than charged water, and it is invisible in a still if you are
  // not looking for it. Measured as the spread of the outer edge around the
  // ring, in world units.
  const mid = reached[2].p;
  check('the leading edge is ragged rather than a clean circle',
    mid.outerDev > 0.08,
    `±${mid.outerDev.toFixed(3)}u around a mean of ${mid.outerMean.toFixed(2)}u`);
}

// --- THE TANK RUNNING DRY ---------------------------------------------------
section('The tank running dry <span>— the button is still DOWN in both of these, and that is the half of a wind-up the sweet spot lives in. The DRAIN grows the shell; the BUTTON holds it up. So an empty tank under a held finger is a shell that has stopped pushing outward and is simply sitting on the animal — which is the read: go now.</span>', 2);
{
  rewind();
  burn(BURN * 0.95);
  draw();
  const before = U.uOuter.value;
  present('last of the fuel', `bar ${Math.round(st.charge * 100)}% · reach ${(before - INNER).toFixed(2)}u`);
  burn(BURN * 0.1 + (CONFIG.boostAura.fade ?? 0.18) * 1.5);
  draw();
  check('a dry tank under a held button keeps the shell up for the release',
    aura.mesh.visible === true && U.uLife.value > 0.99,
    `life ${U.uLife.value.toFixed(3)}`);
  check('  ...but it has stopped growing',
    Math.abs(U.uOuter.value - before) < 1e-6,
    `${(before - INNER).toFixed(2)}u → ${(U.uOuter.value - INNER).toFixed(2)}u`);
  present('empty, still held', `held at ${(U.uOuter.value - INNER).toFixed(2)}u — waiting for the let-go`);
}

// --- THE FLOW ---------------------------------------------------------------
section('The flow <span>— the same instant of the same burn, aimed four ways. The field slides down the line the STRIKE is aimed along (strikeDirection: between the swim and the cursor), so the water is pointing at what the seal is about to hit. Watch the lumps sit on the far side of the shell from the heading, having been carried across it.</span>', 4);
{
  const aims = [
    ['east', { x: 1, y: 0 }],
    ['north', { x: 0, y: 1 }],
    ['west', { x: -1, y: 0 }],
    ['north-east', { x: 0.7071, y: 0.7071 }],
  ];
  for (const [name, aim] of aims) {
    rewind();
    burn(BURN * 0.6, true, DT, aim);
    draw();
    const f = U.uFlow.value;
    present(`aimed ${name}`,
      `field carried (${f.x.toFixed(2)}, ${f.y.toFixed(2)})u`, name === 'east');
  }
}

// --- ...AND IT ACCELERATES --------------------------------------------------
section('...and it accelerates <span>— how far the field has travelled at each quarter of a wind-up, against how fast it is going at that moment. The gaps between these numbers widen, which is the point: a hold that is nearly spent looks nothing like one that has just started, in a second channel on top of the radius.</span>', 4);
{
  rewind();
  let at = 0;
  let lastTravel = 0;
  const legs = [];
  for (const f of [0.25, 0.5, 0.75, 1]) {
    burn(BURN * (f - at), true, 1 / 240);
    at = f;
    draw();
    const travelled = U.uFlow.value.x;
    const leg = travelled - lastTravel;
    lastTravel = travelled;
    legs.push(leg);
    present(`${Math.round(f * 100)}% through the hold`,
      `carried ${travelled.toFixed(2)}u · this quarter alone ${leg.toFixed(2)}u · now ${flowSpeed(BURN * f).toFixed(1)}u/s`,
      f === 1);
  }
  let rising = true;
  for (let i = 1; i < legs.length; i++) if (legs[i] <= legs[i - 1] + 1e-6) rising = false;
  check('each quarter of the hold carries the field further than the last', rising,
    legs.map((v) => v.toFixed(2)).join(' → '));
  // NOT "it reaches the ceiling" — the ceiling is a clamp and a tuning that
  // never reaches it still accelerates the field over a hold, which is the
  // thing being drawn here.
  check('  ...and a full wind-up ends meaningfully faster than it began',
    flowSpeed(BURN) >= flowSpeed(0) * 1.3,
    `${flowSpeed(0).toFixed(1)} → ${flowSpeed(BURN).toFixed(1)}u/s`);
}

// --- THE LANE ---------------------------------------------------------------
section('The lane <span>— `bias`, four fifths of the way into a hold, aimed EAST in every panel. The shell leans into the cone the dash is about to take instead of sitting round the animal like a collar: denser inside the cone, and reaching further along it. At 0 it is the symmetrical shell this started as, which is the setting to go back to if the lane ever reads as broken rather than aimed.</span>', 4);
{
  const keep = CONFIG.boostAura.bias;
  for (const b of [0, 0.35, CONFIG.boostAura.bias, 1]) {
    CONFIG.boostAura.bias = b;
    rewind();
    burn(BURN * 0.8, true, DT, EAST);
    draw();
    present(`bias ${b}`,
      `quad x${U.uLanePush.value.toFixed(2)} the band`, b === keep);
  }
  CONFIG.boostAura.bias = keep;
}

section('...and how far down it reaches <span>— `stretch`, the multiple the band travels along the lane against across it. This is the half that makes it read as filling a CORRIDOR rather than as a bright patch on one side. The quad grows with it, so the cost is rasterised area and `reach` stays the BAND\'s own length.</span>', 4);
{
  const keep = CONFIG.boostAura.stretch;
  for (const st of [0, 0.5, CONFIG.boostAura.stretch, 2.4]) {
    CONFIG.boostAura.stretch = st;
    rewind();
    burn(BURN * 0.8, true, DT, EAST);
    draw();
    const p = profile();
    present(`stretch ${st}`, `drawn out to ${p.outer.toFixed(2)}u`, st === keep);
  }
  CONFIG.boostAura.stretch = keep;
}

// --- COMING UP TO STRENGTH --------------------------------------------------
section('Coming up to strength <span>— the same wind-up at five points, with the radius and the lane held OFF so the only thing moving is the colour. A hold opens pale and dim and arrives over `liftTime` seconds of burn, so the first instant of one is visibly the start of something rather than a state switching on. The HUE never moves: that is which pip is burning, and a wind-up that opened on the wrong one would be lying for its own first half.</span>', 5);
{
  // EVERY PANEL IS THE SAME SHELL AT THE SAME SIZE, so the only thing moving is
  // the colour — a shell that is also growing and leaning answers three
  // questions at once, which is a contact sheet nobody can read.
  //
  // Pinned by burning the SAME length of time in each and retuning `liftTime`
  // instead, NOT by zeroing `push`. That was the first version and it produced
  // five black panels: no push is no band, the shell has zero width, and
  // nothing is drawn — while the check below went on passing, because uStrength
  // is written whether or not there is any shell for it to brighten.
  const keep = { bias: CONFIG.boostAura.bias, liftTime: CONFIG.boostAura.liftTime };
  CONFIG.boostAura.bias = 0;
  const SPAN = 0.12;
  let lit = 0;
  for (const f of [0.04, 0.25, 0.5, 0.75, 1]) {
    CONFIG.boostAura.liftTime = SPAN / f;
    rewind();
    burn(SPAN, true, 1 / 240, EAST);
    draw();
    const c = U.uColor.value;
    const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    if (profile().rays > 0) lit++;
    present(`${Math.round(f * 100)}% up`,
      `strength ${U.uStrength.value.toFixed(2)} \u00b7 chroma ${chroma.toFixed(2)} \u00b7 <b style="color:#${c.getHexString()}">#${c.getHexString()}</b>`,
      f === 1);
  }
  // THE PANELS HAVE SOMETHING IN THEM. The check below is about a uniform and
  // would pass over five black frames; this is the one that says there was a
  // shell for it to be describing.
  check('every panel of the lift has a shell in it', lit === 5, `${lit} of 5 lit`);
  check('the lift arrives at exactly the tuned strength',
    Math.abs(U.uStrength.value - (CONFIG.boostAura.strength ?? 1.9)) < 1e-6,
    `${U.uStrength.value.toFixed(3)}`);
  CONFIG.boostAura.bias = keep.bias;
  CONFIG.boostAura.liftTime = keep.liftTime;
}

// --- WHAT MAKES IT TURBULENT ------------------------------------------------
section('What makes it turbulent <span>— the domain warp, a fifth of the way into a wind-up. At 0 the field is three octaves of smooth value noise: round lumps of even size. Warping it trades edge AMPLITUDE for filaments and curl, so the spread below goes DOWN as the shape gets more interesting — read the picture, not the number.</span>', 4);
{
  const keep = CONFIG.boostAura.warp;
  for (const w of [0, 0.7, CONFIG.boostAura.warp, 3]) {
    CONFIG.boostAura.warp = w;
    rewind();
    burn(BURN * 0.45);
    draw();
    const p = profile();
    present(`warp ${w}`,
      `edge spread ±${p.outerDev.toFixed(3)}u`,
      w === keep);
  }
  CONFIG.boostAura.warp = keep;
}

// --- WHERE THE MASS SITS ----------------------------------------------------
section('Where the mass sits <span>— `falloff`, four fifths of the way into a wind-up, which is where this matters. Above about 1.5 the density piles against the animal and the shell reads as a clean bright band with a haze outside it: the noise is all in the part nobody can see. Lower spreads the mass across the whole shell, and the turbulence survives to the reach.</span>', 4);
{
  const keep = CONFIG.boostAura.falloff;
  for (const f of [0.5, CONFIG.boostAura.falloff, 1.6, 2.6]) {
    CONFIG.boostAura.falloff = f;
    rewind();
    burn(BURN * 0.8);
    draw();
    const p = profile();
    present(`falloff ${f}`, `edge spread ±${p.outerDev.toFixed(3)}u · ${p.rays} of 180 rays lit`, f === keep);
  }
  CONFIG.boostAura.falloff = keep;
}

// --- HOW BIG THE LUMPS ARE --------------------------------------------------
section('How big the lumps are <span>— `grain`, features per WORLD unit. Too coarse and there are barely two features round the whole shell, which reads as a smooth ring with one dent in it; too fine and the turbulence becomes sparkle. The shell is only a couple of units wide, so this is the dial that decides whether it reads as noisy at all.</span>', 4);
{
  const keep = CONFIG.boostAura.grain;
  for (const g of [0.55, CONFIG.boostAura.grain, 2.2, 3]) {
    CONFIG.boostAura.grain = g;
    rewind();
    burn(BURN * 0.45);
    draw();
    const p = profile();
    present(`grain ${g}`, `edge spread ±${p.outerDev.toFixed(3)}u`, g === keep);
  }
  CONFIG.boostAura.grain = keep;
}

// --- HOW MUCH THE FIELD EATS ------------------------------------------------
section('How much the field eats <span>— `depth`, a fifth of the way in. At 0 the shell is a solid falloff with a wobbling edge; past about 0.9 the noise bites holes through the body of it.</span>', 4);
{
  const keep = CONFIG.boostAura.depth;
  for (const d of [0, 0.5, 0.8, 1]) {
    CONFIG.boostAura.depth = d;
    rewind();
    burn(BURN * 0.45);
    draw();
    const p = profile();
    present(`depth ${d}`, `${p.rays} of 180 rays lit`, d === keep);
  }
  CONFIG.boostAura.depth = keep;
}

// --- THE LET-GO -------------------------------------------------------------
section('An abandoned wind-up <span>— not a release: a death, a pause, a run ending. THIS is what the fade is for, and it is the only thing left that uses it now that the let-go shatters instead. The shell keeps EXPANDING as it goes; a radius that collapsed would read as the effect being switched off rather than as the boost ending.</span>', 4);
{
  // Let go SHORT of the cap, so there is headroom left for the shell to carry
  // on into. Past the cap it simply holds, which is correct and shows nothing.
  const capAt2 = (CONFIG.boostAura.reach ?? 2.6) / Math.max(1e-6, CONFIG.boostAura.push ?? 3.2);
  rewind();
  burn(Math.min(BURN * 0.4, capAt2 * 0.5));
  draw();
  present('still burning', `life ${U.uLife.value.toFixed(2)} · reach ${(U.uOuter.value - INNER).toFixed(2)}u`);
  const fade = CONFIG.boostAura.fade ?? 0.18;
  const outs = [U.uOuter.value];
  let at = 0;
  for (const f of [0.35, 0.7, 0.92]) {
    burn(fade * (f - at), false, 1 / 240);
    at = f;
    draw();
    outs.push(U.uOuter.value);
    present('letting go', `life ${U.uLife.value.toFixed(2)} · reach ${(U.uOuter.value - INNER).toFixed(2)}u`);
  }
  // NEVER SHRINKS is the claim that has to hold at any tuning; still CLIMBING
  // is the stronger one, and it only applies while there is reach left. A
  // shell let go of at its cap holds there, which is not the effect being
  // switched off — it is water that has got as far as it is going to get.
  let out = true;
  let back = false;
  for (let i = 1; i < outs.length; i++) {
    if (outs[i] < outs[i - 1] - 1e-9) back = true;
    if (outs[i] <= outs[i - 1]) out = false;
  }
  check('the shell never snaps back through the fade', !back,
    outs.map((v) => (v - INNER).toFixed(2)).join(' → '));
  check('  ...and keeps travelling outward while it has reach left', out,
    `${(outs[outs.length - 1] - INNER).toFixed(2)}u of a ${CONFIG.boostAura.reach}u reach`);
}

// --- THE LET-GO -------------------------------------------------------------
section('The shatter <span>— the release tears the shell into specks. The first panel is the frame before; the rest are the burst ageing out, which it does inside a third of a second. The shell itself is CONSUMED — water torn into pieces is not also still there as a haze.<br><br>THE SPECKS LOOK LIKE CONFETTI HERE AND THAT IS THE SCREEN FILTER, not the burst. Every speck carries the shell\'s exact colour into the buffer (measured in npm run test:aura, off the real attributes); the shipped preset is `crt`, whose `chroma` of 1.2 samples red and blue a texel apart, and a speck barely wider than a texel is therefore torn into a red pixel and a green one. Every small burst in the game gets this — these are sized with gullBubbles and chargeBurst — so it is the house look rather than something to fix here. Switch the filter off (P) to see the hue.</span>', 4);
{
  resetParticles();
  rewind();
  burn(BURN * 0.5);
  draw();
  present('the frame before', `shell up at ${(U.uOuter.value - INNER).toFixed(2)}u`);
  aura.burst(ORIGIN, false);
  const live = [];
  for (const age of [0.03, 0.12, 0.26]) {
    // Stepped in real frames rather than jumped, because the specks are
    // integrated by the shader against a clock this advances — a single long
    // step would put them where a 3.3fps game would.
    const steps = Math.max(1, Math.round(age / DT));
    for (let i = 0; i < steps; i++) updateParticles(DT);
    draw();
    live.push(particleCount());
    present(`+${Math.round(age * 1000)}ms`, `${particleCount()} specks alive`);
  }
  check('the shell is consumed, not left fading under its own debris',
    aura.mesh.visible === false && U.uLife.value === 0);
  check('  ...and the specks are gone inside the emitter\'s life',
    live[live.length - 1] < live[0],
    live.join(' → '));
}

section('...and harder inside the window <span>— the same release, timed. Three channels on ONE picture: more pieces, thrown faster, churning more (CONFIG.boostAura.burst.sweet). Not a second effect — the player learns the shatter once and then reads how loud it is.</span>', 2);
{
  for (const [name, hit] of [['missed the window', false], ['landed in it', true]]) {
    resetParticles();
    rewind();
    burn(BURN * 0.5);
    aura.burst(ORIGIN, hit);
    for (let i = 0; i < Math.round(0.06 / DT); i++) updateParticles(DT);
    draw();
    present(name, `${particleCount()} specks`, hit);
  }
}

// --- AT THE SIZE IT SHIPS ---------------------------------------------------
section('At the size it ships <span>— the game\'s own framing, 44 world units across. Everything above is a magnifying glass; this is the read a player gets.</span>', PIPS);
{
  rewind();
  const step = BURN / PIPS;
  for (let i = 0; i < PIPS; i++) {
    burn(i === 0 ? step * 0.5 : step);
    draw(gameCam);
    const hex = '#' + U.uColor.value.getHexString();
    present(`game scale — pip ${drainingPip(st.charge, PIPS) + 1}`,
      `<b style="color:${hex}">${hex}</b>`, i === PIPS - 1);
  }
}

// --- THE WHEEL IS QUOTED, NOT INVENTED --------------------------------------
{
  // Retune the ring and the shell has to follow, or the two are agreeing by
  // coincidence rather than by construction.
  const keep = CONFIG.strike.ring.color;
  CONFIG.strike.ring.color = 0xff00ff;
  rewind();
  burn(BURN * 0.98);
  const worn = U.uColor.value.clone();
  const want = new THREE.Color(pipRGB(0, PIPS));
  const hslA = { h: 0, s: 0, l: 0 };
  const hslB = { h: 0, s: 0, l: 0 };
  worn.getHSL(hslA);
  want.getHSL(hslB);
  check('retuning the wheel retunes the shell', Math.abs(hslA.h - hslB.h) < 1e-3,
    `shell hue ${hslA.h.toFixed(4)}, pip hue ${hslB.h.toFixed(4)}`);
  CONFIG.strike.ring.color = keep;
}

// --- BRIGHT, MEASURED -------------------------------------------------------
// The brief's one adjective that is not a shape. Measured against the fuel ring
// in the same frame rather than against a number I would have picked: the shell
// is the loud thing here — the ring is a readout you glance at, this is the
// water being charged — so it has to come through the post chain at least as
// strong as the instrument it surrounds.
section('Bright, against the instrument <span>— both in one frame, which is also how a run draws them. The shell has to be at least as loud as the ring it surrounds, or it is a haze around a meter rather than the thing the meter is about.</span>', 2);
{
  showRing = true;
  rewind();
  burn(BURN * 0.5);
  draw();
  const shell = peak((v) => {
    const was = U.uLife.value;
    U.uLife.value = v === undefined ? 0 : v;
    return was;
  });
  const meter = peak((v) => {
    const was = ring.visible;
    ring.visible = v === undefined ? false : v;
    return was;
  });
  present('shell and meter together',
    `shell peaks at ${shell}/255, the fuel ring at ${meter}/255`, true);
  // WITHIN A TENTH, not strictly above. Both of these are near the top of the
  // range and both are read through the bloom, which is a blur over a shared
  // bright pass: switching one off changes how much of the OTHER survives
  // thresholding, so the two numbers swap places run to run by a few counts
  // while nothing has changed. A strict > here would be a coin toss dressed up
  // as a check. What is actually being asserted is that the shell is in the
  // instrument's league rather than a haze underneath it.
  check('the shell comes through the post chain about as bright as the meter',
    shell >= meter * 0.9, `${shell} vs ${meter}`);
  check('  ...and is genuinely bright, not merely present',
    shell > 90, `${shell}/255`);
  showRing = false;
}

check('nothing failed to compile across the whole sheet', shaderErrors.length === 0, shaderErrors[0] ?? '');
aura.reset();
resetStrikeRing();

await Promise.all(posted);
log(fails ? `\n${fails} FAILED` : '\nall panels rendered', fails ? 'bad' : 'ok');
