// ---------------------------------------------------------------------------
// RIG LIMITS — what the seal's skeleton is made of, and what is allowed to
// happen to it when a goal blows the animal out of the net.
//
//   npm run looks:rig
//
// The question this exists to answer is "the mesh is breaking, where?" — and
// that is three questions wearing one coat:
//
//   WHAT DOES EACH BONE ACTUALLY MOVE?  A bone that drives four vertices can be
//        bent to ninety degrees and nobody sees it; the one that drives two
//        hundred is the one that tears. `springChains` in assets.js names bones
//        by hand and nothing in the game has ever said how much skin hangs off
//        each one. The first table below is read straight off the skin.
//
//   WHAT IS THE CAP, REALLY?  `CONFIG.player.jolt.limp.maxLag` reads like a
//        limit on how far a limb may fold, and it is not: it is measured from
//        the direction each bone is being PULLED toward, and on every bone but
//        the first that direction has already been displaced by its parent —
//        the solver measures each bone after the one above it has moved, which
//        is what makes the lag a travelling wave instead of a uniform droop. So
//        the deviations COMPOUND, and three bones capped at 2.1 is a flipper
//        6.3 radians from where it started. `chainMax` is the cap that bounds
//        the limb; this page is where you can see the difference.
//
//   WHERE DOES IT ACTUALLY GO WRONG?  A number cannot answer that. The strips
//        below run the REAL blast — tumbleSeal with CONFIG.versus.goalJet.blast's
//        own numbers, through the real updatePlayer — and draw the animal frame
//        by frame, twice: once as the player sees it, and once with the body's
//        own tumble taken out so what is left is the skeleton alone. A seal that
//        looks broken in the first strip and fine in the second is spinning, not
//        tearing, and those are different bugs with different fixes.
//
// EVERY NUMBER IS OVERRIDABLE FROM THE URL, so a variant costs a reload rather
// than an edit, and the page prints what it used:
//
//   ?chainMax=1.2&maxLag=1.6&tipLooseness=0.9&stiffness=7&damping=2.4
//   ?softness=0.45&snapAngle=3.2&tipBias=0.85      (the limp spring)
//   ?spin=0.2&roll=0.26&kick=0.3&push=78&tumbleFor=1.6   (the blast)
//   ?frames=10&flag=1.4                            (strip length, red-line in rad)
//
// IT WRITES NOTHING. A vite build with no dev server behind it and no save
// path — the game's dev server is the sole writer of imported-tuning.json.
// See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets } from '../../path/src/assets.js';
import { ASSETS } from '../../path/src/assets.js';
import { updateBounds } from '../../path/src/arena.js';
import {
  player, initPlayer, resetPlayer, updatePlayer, tumbleSeal,
  setJoltWallDt, setJoltPaused, sealLimpSpring,
} from '../../path/src/entities/player.js';

const logEl = document.getElementById('log');
const sheetEl = document.getElementById('sheet');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
const heading = (title, sub = '') => {
  const h = document.createElement('h2');
  h.textContent = title;
  if (sub) {
    const s = document.createElement('span');
    s.textContent = `  ${sub}`;
    h.appendChild(s);
  }
  sheetEl.appendChild(h);
};
const note = (text) => {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  sheetEl.appendChild(p);
};

// --- the overrides ----------------------------------------------------------
const Q = new URLSearchParams(location.search);
const num = (name, fallback) => {
  const v = Q.get(name);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
// Written onto CONFIG before anything reads it, so the page drives the SHIPPING
// code with the numbers asked for rather than keeping a second copy of them.
// The page never saves, so nothing here can reach the tuning file.
const LIMP = CONFIG.player.jolt.limp;
for (const key of ['stiffness', 'damping', 'tipLooseness', 'maxLag', 'softness', 'snapAngle', 'tipBias', 'chainMax']) {
  if (Q.has(key)) LIMP[key] = num(key, LIMP[key]);
}
const BLAST = CONFIG.versus.goalJet.blast;
for (const key of ['spin', 'roll', 'kick', 'push', 'tumbleFor']) {
  if (Q.has(key)) BLAST[key] = num(key, BLAST[key]);
}
const FRAMES = Math.max(4, Math.min(16, Math.round(num('frames', 10))));
// The red line, in radians of local joint rotation. Not a law — a place to
// argue from. A seal's shoulder genuinely swings a long way when it is thrown;
// a joint past about 80 degrees from where it was cut loose is where the skin
// around it starts to read as folded rather than as slack.
const FLAG = num('flag', 1.4);

const W = 300;
const H = 300;
const DT = 1 / 60;

// One WebGL context for the whole page, blitted into a 2D canvas per cell — a
// renderer per cell silently goes black past a dozen panels.
const gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070c16);
scene.add(new THREE.AmbientLight(0xffffff, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(4, 6, 8);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fa8ff, 1.1);
rim.position.set(-6, 2, -4);
scene.add(rim);

await preloadAssets();
updateBounds(16 / 9);
initPlayer(scene);
resetPlayer();
// Nothing on this page is a replay, and nothing publishes a wall clock but the
// loop below — stated rather than assumed, because both default to something.
setJoltPaused(false);

const body = player.body;
const mesh = player.mesh;
// The art comes out nose-up (createVisual points forward at world +Y), so a
// preview that wants the animal lying along the screen has to lay it down.
mesh.rotation.z = -Math.PI / 2;

const skinned = [];
body.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });

/**
 * WORLD MATRICES, FROM THE ROOT, WITH THE ANIMAL ON THE ORIGIN.
 *
 * Every measurement on this page compares a BONE's world position against a
 * skinned VERTEX's, and the two are reached by different routes: the vertex
 * comes back from getVertexPosition in the mesh's own space and is pushed
 * through `mesh.matrixWorld`, the bone through its own. Update the subtree from
 * `body` and only one side of that gets the seal's position in the arena —
 * `body.matrixWorld` is still whatever it was when the parent last moved. The
 * result is a bone sitting twenty-one units from the skin it drives, which this
 * page happily reported as a flesh ratio of 21.8x: a stray weight on a model
 * whose weights are, measured properly, clean.
 *
 * So: from the ROOT (see the same trap in the software-skinning harnesses), and
 * with the seal parked on the origin so a big arena coordinate cannot hide a
 * small error inside it.
 */
function syncMatrices() {
  mesh.position.set(0, 0, 0);
  mesh.rotation.z = -Math.PI / 2;
  mesh.updateMatrixWorld(true);
}
syncMatrices();

const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 400);
function frameCamera() {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z);
  camera.position.set(mid.x, mid.y + span * 0.12, mid.z + span * 2.1);
  camera.lookAt(mid);
}

// ---------------------------------------------------------------------------
// WHAT EACH BONE MOVES — read off the skin, not off the rig's names.
//
// `skinIndex`/`skinWeight` are four-wide per vertex. A bone's WEIGHT MASS is
// the sum of every weight pointing at it — a fairer number than a vertex count,
// because a vertex a bone owns at 0.05 is a vertex it barely moves. `verts` is
// how many vertices it has any hold on at all, and `owns` how many it is the
// heaviest influence on: that last one is the number that says how much skin
// actually follows the bone, and it is the one that tends to surprise.
//
// FLESH is the furthest any vertex the bone owns sits from the bone's own
// segment, as a ratio of the bone's length — the same measurement
// boneSpring.measureRadii makes for the seabed floor, computed here because a
// solver's copy of it is private. It is how thick the limb is around the line
// being rotated, which is what turns a joint angle into a hole in the mesh.
// ---------------------------------------------------------------------------
const CHAINS = (ASSETS.ship.rig?.springChains ?? []).map((c) => ({
  role: c.role,
  asleep: c.asleep === true,
  names: Array.isArray(c.bones) ? c.bones : (c.names ?? []),
}));
const CHAIN_OF = new Map();
CHAINS.forEach((c, i) => c.names.forEach((n) => CHAIN_OF.set(n, i)));

function boneStats() {
  syncMatrices();
  const stats = new Map();
  const add = (name) => {
    if (!stats.has(name)) stats.set(name, { name, verts: 0, owns: 0, mass: 0, flesh: 0, len: 0 });
    return stats.get(name);
  };
  for (const c of CHAINS) for (const n of c.names) add(n);

  const v = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const rootP = new THREE.Vector3();
  const tipP = new THREE.Vector3();

  for (const m of skinned) {
    const bones = m.skeleton?.bones ?? [];
    const si = m.geometry.attributes.skinIndex;
    const sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) continue;
    for (let k = 0; k < si.count; k++) {
      let best = -1;
      let bestW = 0;
      for (let c = 0; c < 4; c++) {
        const w = sw.getComponent(k, c);
        if (!(w > 0)) continue;
        const bone = bones[si.getComponent(k, c)];
        if (!bone || !stats.has(bone.name)) continue;
        const s = stats.get(bone.name);
        s.mass += w;
        s.verts++;
        if (w > bestW) { bestW = w; best = bone.name; }
      }
      if (best) {
        const s = stats.get(best);
        if (s) s.owns++;
      }
    }
  }

  // Length and flesh, in world units, off the pose the model is holding.
  for (const c of CHAINS) {
    for (let i = 0; i < c.names.length; i++) {
      const bone = body.getObjectByName(c.names[i]);
      const s = stats.get(c.names[i]);
      if (!bone || !s) continue;
      const child = i < c.names.length - 1
        ? body.getObjectByName(c.names[i + 1])
        : bone.children.find((x) => x.isBone);
      rootP.setFromMatrixPosition(bone.matrixWorld);
      if (child) tipP.setFromMatrixPosition(child.matrixWorld);
      else tipP.copy(rootP).add(new THREE.Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())));
      s.len = rootP.distanceTo(tipP);
      if (!(s.len > 1e-6)) continue;
      seg.subVectors(tipP, rootP);
      let far = 0;
      for (const m of skinned) {
        const bones = m.skeleton?.bones ?? [];
        const si = m.geometry.attributes.skinIndex;
        const sw = m.geometry.attributes.skinWeight;
        if (!si || !sw) continue;
        for (let k = 0; k < si.count; k++) {
          let heavy = -1;
          let hw = 0;
          for (let cc = 0; cc < 4; cc++) {
            const w = sw.getComponent(k, cc);
            if (w > hw) { hw = w; heavy = si.getComponent(k, cc); }
          }
          if (heavy < 0 || bones[heavy]?.name !== c.names[i]) continue;
          m.getVertexPosition(k, v).applyMatrix4(m.matrixWorld);
          rel.subVectors(v, rootP);
          const t = Math.max(0, Math.min(1, rel.dot(seg) / seg.lengthSq()));
          const d = rel.addScaledVector(seg, -t).length();
          if (d > far) far = d;
        }
      }
      s.flesh = far / s.len;
    }
  }
  return stats;
}

const STATS = boneStats();

// ---------------------------------------------------------------------------
// THE BONE OVERLAY — the chains drawn on top of the animal, so a fold can be
// seen through the skin that is hiding it.
// ---------------------------------------------------------------------------
const ROLE_COLOR = [0xffd27a, 0x7fe6a0, 0x8fb8ff, 0xff8b7a, 0xd58bff];
const overlay = new THREE.Group();
overlay.renderOrder = 10;
scene.add(overlay);
const segments = [];
CHAINS.forEach((c, ci) => {
  for (let i = 0; i < c.names.length; i++) {
    const bone = body.getObjectByName(c.names[i]);
    if (!bone) continue;
    const child = i < c.names.length - 1
      ? body.getObjectByName(c.names[i + 1])
      : bone.children.find((x) => x.isBone);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: ROLE_COLOR[ci % ROLE_COLOR.length], depthTest: false, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 11;
    overlay.add(line);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshBasicMaterial({ color: ROLE_COLOR[ci % ROLE_COLOR.length], depthTest: false }),
    );
    dot.renderOrder = 12;
    overlay.add(dot);
    segments.push({ bone, child, line, dot, name: c.names[i], chain: ci });
  }
});
function drawOverlay(show = true) {
  overlay.visible = show;
  if (!show) return;
  syncMatrices();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const s of segments) {
    a.setFromMatrixPosition(s.bone.matrixWorld);
    if (s.child) b.setFromMatrixPosition(s.child.matrixWorld);
    else b.copy(a).add(new THREE.Vector3(0, 1, 0).applyQuaternion(s.bone.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(0.25));
    const pos = s.line.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    s.line.geometry.computeBoundingSphere();
    s.dot.position.copy(a);
  }
}

// ---------------------------------------------------------------------------
// RENDERING A CELL. One GL context, blitted — see the note at the renderer.
// ---------------------------------------------------------------------------
function cell(row, caption, bad = false) {
  frameCamera();
  gl.render(scene, camera);
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  c.getContext('2d').drawImage(gl.domElement, 0, 0);
  const wrap = document.createElement('div');
  wrap.className = `cell${bad ? ' bad' : ''}`;
  wrap.appendChild(c);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = caption;
  wrap.appendChild(cap);
  row.appendChild(wrap);
}
function newRow(cols) {
  const r = document.createElement('div');
  r.className = 'row';
  r.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  sheetEl.appendChild(r);
  return r;
}

// ---------------------------------------------------------------------------
// THE BLAST, DRIVEN THROUGH THE SHIPPING CODE.
//
// tumbleSeal with the goal blast's own numbers, then updatePlayer frame by
// frame — the same path a goal takes, so the caps, the clamps and the NaN
// guards in it are the ones under test. `bare` renders with the body root's own
// rotation taken out: everything left is the skeleton, which is the difference
// between an animal that is tearing and one that is merely spinning.
// ---------------------------------------------------------------------------
const IDLE = { move: new THREE.Vector2(0, 0), aim: new THREE.Vector2(1, 0), strikeHeld: false, dash: false };
const BIND = new Map();
function settle(n = 150) {
  resetPlayer();
  mesh.rotation.z = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    setJoltWallDt(DT);
    updatePlayer(DT, IDLE);
    syncMatrices();
  }
  BIND.clear();
  for (const s of segments) BIND.set(s.name, s.bone.quaternion.clone());
}

function fireBlast() {
  const mag = BLAST.push;
  const kick = Math.min(CONFIG.player.jolt.limp?.kickMax ?? 16, (BLAST.kick ?? 0.3) * mag);
  tumbleSeal(player, -(BLAST.spin ?? 0.2) * mag, (BLAST.roll ?? 0.26) * mag, BLAST.tumbleFor ?? 1.6, 1, 0, kick);
}

/** Advance one frame of the blast and report the worst joint this frame. */
const worst = new Map();
function stepBlast() {
  setJoltWallDt(DT);
  updatePlayer(DT, IDLE);
  // The seal is being looked AT, not played — its position and heading are not
  // the subject and letting it swim off would only move the camera.
  syncMatrices();
  for (const s of segments) {
    const a = BIND.get(s.name)?.angleTo(s.bone.quaternion) ?? 0;
    if (a > (worst.get(s.name) ?? 0)) worst.set(s.name, a);
  }
}

// =============================================================================
log(`RIG LIMITS — ${skinned.length} skinned mesh(es), ${skinned.reduce((n, m) => n + m.geometry.attributes.position.count, 0)} vertices, ${segments.length} ragdoll bones in ${CHAINS.length} chain(s)`);
log(`limp spring in force: ${JSON.stringify(sealLimpSpring())}`, 'dim');
log(`blast: push ${BLAST.push}  spin ${BLAST.spin}  roll ${BLAST.roll}  kick ${BLAST.kick}  tumbleFor ${BLAST.tumbleFor}`, 'dim');
log(`red line: a joint past ${FLAG.toFixed(2)} rad (${(FLAG * 180 / Math.PI).toFixed(0)}°) from the pose it was cut loose in`, 'dim');

// --- 1. what each bone moves -------------------------------------------------
heading('What each bone actually moves', 'read off the skin, not off the rig’s names');
note('`owns` is vertices this bone is the HEAVIEST influence on — the skin that actually follows it. `mass` is the sum of every weight pointing at it. `flesh` is how far the furthest of those vertices sits from the bone’s own line, as a share of the bone’s length: it is what turns a joint angle into a hole, because a thin bone can be folded a long way before anything visibly creases and a thick one cannot.');
{
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>bone</th><th>chain</th><th>owns</th><th>verts</th><th>mass</th><th>len</th><th>flesh</th></tr>';
  for (const c of CHAINS) {
    for (const n of c.names) {
      const s = STATS.get(n);
      if (!s) continue;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="name">${n}</td><td>${c.role}${c.asleep ? ' (asleep)' : ''}</td>`
        + `<td>${s.owns}</td><td>${s.verts}</td><td>${s.mass.toFixed(1)}</td>`
        + `<td>${s.len.toFixed(2)}</td><td>${s.flesh.toFixed(2)}×</td>`;
      table.appendChild(tr);
    }
  }
  sheetEl.appendChild(table);

  settle();
  const row = newRow(Math.min(CHAINS.length, 5));
  CHAINS.forEach((c, ci) => {
    for (const s of segments) {
      s.line.material.opacity = s.chain === ci ? 1 : 0.1;
      s.dot.material.opacity = s.chain === ci ? 1 : 0.1;
      s.dot.material.transparent = true;
    }
    drawOverlay(true);
    const owns = c.names.reduce((n, name) => n + (STATS.get(name)?.owns ?? 0), 0);
    cell(row, `<b>${c.role}</b> — ${c.names.length} bones, ${owns} vertices<br>${c.names.join('<br>')}`);
  });
  for (const s of segments) { s.line.material.opacity = 0.95; s.dot.material.opacity = 1; }
}

// --- 2. the blast, frame by frame -------------------------------------------
heading('The blast, frame by frame', 'the real tumbleSeal, through the real updatePlayer');
note('Top strip is what a player sees. Bottom strip is the same frames with the body root’s own rotation removed, so what is left is the skeleton alone. If the animal looks wrecked in the top row and intact in the bottom one, it is spinning rather than tearing — and those are different bugs with different fixes.');
{
  settle();
  fireBlast();
  const span = (BLAST.tumbleFor ?? 1.6) + 0.35;
  const every = Math.max(1, Math.round(span / DT / FRAMES));
  const shots = [];
  for (let i = 0; i < FRAMES; i++) {
    for (let k = 0; k < every; k++) stepBlast();
    shots.push({ t: (i + 1) * every * DT, q: body.quaternion.clone(), free: player.jolt.free });
    drawOverlay(true);
    frameCamera();
    gl.render(scene, camera);
    const c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2;
    c.getContext('2d').drawImage(gl.domElement, 0, 0);
    shots[i].seen = c;
    // ...and again with the tumble taken out. Written after poseBody, which
    // rewrites this every frame, so nothing is left behind.
    body.quaternion.identity();
    drawOverlay(true);
    frameCamera();
    gl.render(scene, camera);
    const c2 = document.createElement('canvas');
    c2.width = W * 2; c2.height = H * 2;
    c2.getContext('2d').drawImage(gl.domElement, 0, 0);
    shots[i].bare = c2;
    body.quaternion.copy(shots[i].q);
  }
  for (const label of ['seen', 'bare']) {
    const row = newRow(FRAMES);
    shots.forEach((s, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'cell';
      wrap.appendChild(s[label]);
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.innerHTML = label === 'seen'
        ? `<b>${s.t.toFixed(2)}s</b> ${s.free > 0 ? 'limp' : 'righting'}`
        : `<b>${s.t.toFixed(2)}s</b> skeleton only`;
      wrap.appendChild(cap);
      row.appendChild(wrap);
    });
  }
}

// --- 3. the table that names the offender ------------------------------------
heading('Which joint went furthest', 'local rotation from the pose it was cut loose in');
note('This is the quantity that deforms skin: a bone’s rotation relative to its OWN PARENT. A world-space bone direction also moves when anything above it moves — the body tumbles, and the aim rig keeps solving through a limp — and neither of those bends a joint. `maxLag` bounds each bone against a target its parent has already displaced, so the chain total is the number to read, against `chainMax`.');
{
  const table = document.createElement('table');
  table.innerHTML = `<tr><th>bone</th><th>chain</th><th>worst</th><th>deg</th><th>owns</th><th>flesh</th></tr>`;
  let flagged = 0;
  for (const c of CHAINS) {
    let sum = 0;
    for (const n of c.names) {
      const a = worst.get(n) ?? 0;
      sum += a;
      const s = STATS.get(n);
      const tr = document.createElement('tr');
      if (a > FLAG) { tr.className = 'over'; flagged++; } else if (a > FLAG * 0.75) tr.className = 'near';
      tr.innerHTML = `<td class="name">${n}</td><td>${c.role}</td><td>${a.toFixed(2)}</td>`
        + `<td>${(a * 180 / Math.PI).toFixed(0)}°</td><td>${s?.owns ?? 0}</td><td>${(s?.flesh ?? 0).toFixed(2)}×</td>`;
      table.appendChild(tr);
    }
    const tr = document.createElement('tr');
    const over = sum > (LIMP.chainMax ?? Infinity);
    tr.className = over ? 'over' : '';
    tr.innerHTML = `<td class="name">└ chain total</td><td>${c.role}</td><td>${sum.toFixed(2)}</td>`
      + `<td>${(sum * 180 / Math.PI).toFixed(0)}°</td><td colspan="2">chainMax ${LIMP.chainMax ?? '—'}, maxLag ${LIMP.maxLag} per bone</td>`;
    table.appendChild(tr);
  }
  sheetEl.appendChild(table);
  log(`${flagged} joint(s) past the ${FLAG.toFixed(2)} rad red line`, flagged ? 'bad' : 'ok');
}

// --- 4. what the cap is worth ------------------------------------------------
heading('What the chain cap is worth', 'the same blast, the same frame, four budgets');
note('`chainMax` is the whole limb\u2019s budget, and it is spent IN PROPORTION rather than root first. Root first is the obvious implementation and it starves the end of the limb, which is the end that is supposed to move \u2014 tipLooseness makes the tip the loosest joint and the kick\u2019s tipBias puts most of a shove there on purpose. Measured, root-first took the head\u2019s swing down to 25 degrees against 24 for a live animal and made the kick worth one degree. Proportionally every joint gives back the same share, so the shape of the fold survives being bounded. Off means uncapped, which is what every other creature in the game solves with: on a swimming fish nothing compounds far enough to matter and a budget would only take the flick off the end of a tail.');
{
  const shipped = LIMP.chainMax;
  // Uncapped, then a spread round whatever is shipped — so the panel keeps
  // bracketing the live value instead of going stale the first time it moves.
  const budgets = [...new Set([0, +(shipped * 1.8).toFixed(2), shipped, +(shipped * 0.7).toFixed(2)])];
  const row = newRow(budgets.length);
  for (const b of budgets) {
    LIMP.chainMax = b;
    settle();
    fireBlast();
    const local = new Map();
    const n = Math.round(((BLAST.tumbleFor ?? 1.6) * 0.55) / DT);
    for (let i = 0; i < n; i++) {
      setJoltWallDt(DT);
      updatePlayer(DT, IDLE);
      syncMatrices();
      for (const s of segments) {
        const a = BIND.get(s.name)?.angleTo(s.bone.quaternion) ?? 0;
        if (a > (local.get(s.name) ?? 0)) local.set(s.name, a);
      }
    }
    const q = body.quaternion.clone();
    body.quaternion.identity();
    drawOverlay(true);
    const peak = Math.max(...[...local.values()]);
    const totals = CHAINS.map((c) => c.names.reduce((t, name) => t + (local.get(name) ?? 0), 0));
    cell(
      row,
      `<b>chainMax ${b === 0 ? 'off' : b}</b>${b === shipped ? ' (shipped)' : ''}<br>`
      + `worst joint ${peak.toFixed(2)} rad (${(peak * 180 / Math.PI).toFixed(0)}°)<br>`
      + `worst limb ${Math.max(...totals).toFixed(2)} rad`,
      peak > FLAG,
    );
    body.quaternion.copy(q);
  }
  LIMP.chainMax = shipped;
  settle();
}

log('done', 'ok');
