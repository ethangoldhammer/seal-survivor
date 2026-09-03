// ---------------------------------------------------------------------------
// BEFORE AND AFTER THE SHRINK — `npm run looks:shrunk`
//
// tools/shrink-textures.mjs brought every map down to the size the model is
// actually drawn at, and its own measurement says the worst change is under
// four levels out of 255 at that size. That number is what says WHICH ones to
// look at; it is not a substitute for looking, and this page is the looking.
//
// EACH ROW IS ONE MODEL, drawn twice: the map it shipped with on the left, the
// map it ships with now on the right. Same camera, same light, same frame —
// the only variable is the texture. If a row reads as one picture, the texels
// that went were texels the mip chain was already averaging away.
//
// AND AT TWO SIZES, because the whole argument is about size. The small pair is
// the creature at the width it covers in a logged window; the large pair is the
// kill shot's 3.15x push at 4K, which is the widest this game ever draws
// anything and the case the budget was computed against. A map that holds up
// small and falls apart large is a map that was cut too far — that is the
// failure this is looking for, and it can only be seen in the big pair.
//
// public/models-orig/ IS NOT IN THE REPO and must not be: it is 40MB of
// duplicate models inside `public/`, which vite copies wholesale into `dist`,
// so leaving it there ships every model twice. Make it, look, delete it:
//
//   mkdir -p public/models-orig
//   git show <sha>:public/models/fish.glb > public/models-orig/fish.glb   # etc
//   npm run looks:shrunk
//   rm -rf public/models-orig
//
// The page renders a model it cannot find as "before failed:" and carries on,
// so a missing directory costs the comparison and not the run.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODELS = ['fish.glb', 'tang.glb', 'fishpack.glb', 'grass.glb', 'anglerfish.glb',
  'fish2.glb', 'puffer.glb', 'cutesquid.glb', 'fisherman.glb', 'squid.glb'];
// The two framings the budget is computed against — see the header.
const SMALL = 170;
const LARGE = 560;

const loader = new GLTFLoader();
const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
gl.setPixelRatio(1);
gl.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x22323a, 2.2));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4); key.position.set(-3, 4, 6); scene.add(key);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);

async function shot(url, px, onto = null) {
  const g = await loader.loadAsync(url);
  const root = g.scene;
  scene.add(root);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  camera.aspect = 1;
  camera.position.set(centre.x + radius * 0.4, centre.y + radius * 0.35, centre.z + radius * 3.1);
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
  gl.setSize(px, px, false);
  gl.render(scene, camera);
  // COPIED OUT OF THE GL CANVAS IMMEDIATELY, into the contact sheet as well as
  // into a data URL for the page. Going via an <img> and awaiting decode() is
  // the obvious way to build the sheet and it simply never settled here — the
  // page sat on "rendering…" with no error, which is the worst shape of stall.
  // drawImage off the live canvas needs no decode at all, and it has to happen
  // NOW because the next render overwrites the buffer.
  onto?.(gl.domElement, px);
  const data = gl.domElement.toDataURL('image/png');
  scene.remove(root);
  return data;
}

const grid = document.getElementById('grid');
const log = document.getElementById('log');
const posted = [];

for (const m of MODELS) {
  const row = document.createElement('div');
  row.className = 'cell';
  const strip = document.createElement('div');
  strip.className = 'strip';
  // COMPOSITED INTO ONE IMAGE PER MODEL, and posted as that. The first version
  // of this posted `gl.domElement` after the loop, which is the LAST render —
  // so every file on disk was the "after" frame with no before beside it, and
  // the whole comparison lived only in a browser tab. A contact sheet that
  // silently drops half of what it is comparing is worse than none.
  const sheet = document.createElement('canvas');
  sheet.width = (SMALL + LARGE) * 2 + 30;
  sheet.height = LARGE + 20;
  const ctx2d = sheet.getContext('2d');
  ctx2d.fillStyle = '#050a12';
  ctx2d.fillRect(0, 0, sheet.width, sheet.height);
  let x = 0;
  for (const px of [SMALL, LARGE]) {
    for (const [label, dir] of [['before', 'models-orig'], ['after', 'models']]) {
      const box = document.createElement('div');
      box.className = 'shot';
      try {
        const at = x;
        const img = document.createElement('img');
        img.src = await shot(`/${dir}/${m}`, px, (canvas) => {
          ctx2d.drawImage(canvas, at, 0, px, px);
          ctx2d.fillStyle = '#9fc4ea';
          ctx2d.font = '12px monospace';
          ctx2d.fillText(`${label} ${px}px`, at + 4, px + 14);
        });
        img.style.width = `${px}px`;
        box.appendChild(img);
      } catch (err) {
        box.textContent = `${label} failed: ${err.message}`;
      }
      x += px + 10;
      const cap = document.createElement('div');
      cap.className = 'lbl';
      cap.textContent = `${label} · ${px}px`;
      box.appendChild(cap);
      strip.appendChild(box);
    }
  }
  const name = document.createElement('div');
  name.className = 'cap';
  name.textContent = m;
  row.append(name, strip);
  grid.appendChild(row);

  posted.push(new Promise((done) => sheet.toBlob((b) => {
    fetch(`/shot/${m.replace('.glb', '')}.png`, { method: 'POST', body: b }).then(done, done);
  }, 'image/png')));
}

log.textContent = 'left is what shipped, right is what ships now — small pair, then the kill shot’s push';
document.title = 'shrink: before / after';
