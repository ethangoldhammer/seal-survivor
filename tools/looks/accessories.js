// ---------------------------------------------------------------------------
// WHAT THE SEAL WEARS — LOOK DEV
//
//   npm run looks:accessories
//
// The question this sheet exists to answer: is the thing on the seal's head in
// the right place, the right way up and the right size — at the size a run is
// actually played at.
//
// WHY A PAGE AND NOT ANOTHER NODE HARNESS. npm run test:accessories already
// proves the arithmetic: the mesh is a child of the bone, the offsets are world
// units, the axes point where their names say. Every one of those can be true
// of a pair of sunglasses sunk into the skull, worn backwards, or the size of a
// dinghy. Placement is a judgement about a picture and the picture has to
// exist.
//
// THE FRAME IS THE RUN'S FRAME. Orthographic, at the arena's own zoom — about
// 20 px per world unit — because an accessory is a small thing on a small
// animal and the only question that matters is whether it reads AT THAT SIZE.
// A flattering close-up would sell a hat nobody can see in the game.
//
// The head is POSED in the second half rather than left at rest. An accessory
// at rest is a still life; the failure that matters is the one that only
// appears when the neck bends — a hat that pivots off the skull, or a pair of
// glasses that swings wide of the eyes as the head turns to the cursor.
//
// IT WRITES NOTHING. Every CONFIG assignment below is into the live object of a
// throwaway bundle; there is no save path on this page and no dev server behind
// it. See SERVERS.md.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CONFIG } from '../../path/src/config.js';
import { preloadAssets, createVisual } from '../../path/src/assets.js';
import { updateAccessories, resetAccessories, equipAccessory } from '../../path/src/systems/accessories.js';
import { createAimRig } from '../../path/src/systems/aimRig.js';
import { bustAim } from '../../path/src/systems/splashBust.js';
import { createEyeLights, updateEyeLights, resetEyeLights } from '../../path/src/systems/eyeLights.js';

const logEl = document.getElementById('log');
const log = (m, cls) => {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = m;
  logEl.appendChild(d);
};
let fails = 0;

const W = 520;
const H = 380;

const gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
gl.setPixelRatio(2);
gl.setSize(W, H);
gl.outputColorSpace = THREE.SRGBColorSpace;

// THE GAME'S OWN LIGHTING RIG, read from config rather than invented — a page
// with its own prettier three-point setup would be judging a shape under a sun
// that does not exist. See world.js, which builds exactly this.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08243a);
scene.add(new THREE.AmbientLight(0xffffff, CONFIG.lighting.ambient));
const key = new THREE.DirectionalLight(0xffffff, CONFIG.lighting.keyIntensity);
key.position.fromArray(CONFIG.lighting.keyPosition);
scene.add(key);
scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x08131c, CONFIG.lighting.hemiIntensity));

await preloadAssets();

// THE SEAL AS THE GAME HOLDS IT. entities/player.js carries the facing on a
// container above the model and createVisual points a creature's nose at world
// +Y, so `rotation.z = -PI/2` is a seal swimming to the right — the same
// rotation every preview in this folder uses, and the frame in which "up" and
// "toward the camera" mean what the sliders say they mean.
const holder = new THREE.Object3D();
holder.rotation.z = -Math.PI / 2;
scene.add(holder);
const seal = createVisual('ship');
if (!seal) { log('FAIL createVisual returned nothing for `ship`', 'bad'); fails++; }
else holder.add(seal);

const head = seal?.getObjectByName('head_07');
if (!head) { log('FAIL head_07 is not on this rig', 'bad'); fails++; }
const headRest = head ? head.quaternion.clone() : null;

// Where the camera looks: the head, not the animal's middle. Read off the rig
// rather than typed, so it follows a model swap.
scene.updateMatrixWorld(true);
const focus = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();

// ORTHOGRAPHIC AND AT THE RUN'S ZOOM. `VIEW_W` is the width of the frame in
// world units; the seal is 2.6 long, so 5 is the animal filling a bit over half
// the width — close enough to read a pair of glasses, wide enough that the
// judgement is still about the game's own scale.
const VIEW_W = 5;
const VIEW_H = VIEW_W * (H / W);
const camera = new THREE.OrthographicCamera(-VIEW_W / 2, VIEW_W / 2, VIEW_H / 2, -VIEW_H / 2, -100, 200);
camera.position.set(focus.x, focus.y, 20);

// The standing seal, while the bust block owns the frame — `shot` has to write
// the accessories onto whichever animal is being drawn.
let bustSubject = null;

const sheet = document.getElementById('sheet');
let shotIndex = 0;
const posted = [];
let current = null;

function row(label) {
  const h = document.createElement('h2');
  h.textContent = label;
  sheet.appendChild(h);
  current = document.createElement('div');
  current.className = 'row';
  sheet.appendChild(current);
}

/**
 * Render the scene as it stands and drop the frame into the sheet and on disk.
 *
 * THE SYSTEM IS STEPPED FIRST, and that is not a detail: updateAccessories is
 * what writes CONFIG onto the mesh, so a cell rendered straight after changing
 * a slider shows the PREVIOUS value — which reads exactly like the slider doing
 * nothing. The matrices are updated on both sides of it because the system
 * reads the bone's live world scale to divide it out.
 */
// The camera `shot` draws through. A module-level cursor rather than a
// parameter on every call: all but three cells in this sheet are the swimming
// animal in the run's frame, and threading a camera through thirty calls to
// serve three of them is noise. The bust block sets it and puts it back.
let activeCam = camera;

function shot(title, note) {
  scene.updateMatrixWorld(true);
  updateAccessories(seal.visible ? seal : bustSubject ?? seal);
  scene.updateMatrixWorld(true);
  gl.render(scene, activeCam);

  const canvas = document.createElement('canvas');
  canvas.width = gl.domElement.width;
  canvas.height = gl.domElement.height;
  canvas.getContext('2d').drawImage(gl.domElement, 0, 0);
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.appendChild(canvas);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.innerHTML = `<b>${title}</b><br>${note ?? ''}`;
  cell.appendChild(cap);
  (current ?? sheet).appendChild(cell);
  const name = `${String(shotIndex++).padStart(2, '0')}-${title.toLowerCase().replace(/[^\w]+/g, '-')}.png`;
  posted.push(new Promise((done) => canvas.toBlob((blob) => {
    fetch(`/shot/${name}`, { method: 'POST', body: blob }).then(done, done);
  }, 'image/png')));
}

const glasses = CONFIG.accessories.items.accessoryGlasses;
const hat = CONFIG.accessories.items.accessoryHat;
// The shipped numbers, captured before anything below moves them, so each cell
// starts from the config the game boots with rather than from the last one.
const SHIPPED = { glasses: { ...glasses }, hat: { ...hat }, equipped: CONFIG.accessories.equipped };
// ONE SLOT, so `reset` puts the shipped one back on rather than restoring two
// booleans — see CONFIG.accessories.equipped. Every cell below then says which
// accessory it is about by equipping it, and a cell that forgets shows whatever
// the last one left on, which is a difference you can see.
const reset = () => {
  Object.assign(glasses, SHIPPED.glasses);
  Object.assign(hat, SHIPPED.hat);
  equipAccessory(SHIPPED.equipped);
};

/** Turn the head, the way the neck IK does when the cursor moves. */
function pose(rad) {
  if (!head || !headRest) return;
  head.quaternion.copy(headRest);
  head.rotateZ(rad);
}

// ---------------------------------------------------------------------------
row('bare, then wearing — is it the same animal?');
// ---------------------------------------------------------------------------
reset();
equipAccessory('');
shot('bare', 'nothing on. Every cell below has to still be this seal.');

reset();
equipAccessory('accessoryGlasses');
shot('shipped', 'the solved placement: the lens plane on the midpoint between the two eye sockets.');

// ---------------------------------------------------------------------------
row('does the size read at the run\'s scale?');
// ---------------------------------------------------------------------------
reset();
equipAccessory('accessoryGlasses'); glasses.size = 0.4;
shot('size 0.4', 'narrower than the eyes are apart (0.487 world units) — the lenses miss.');

reset();
equipAccessory('accessoryGlasses'); glasses.size = 0.9;
shot('size 0.9', 'past the head. Where the temples stop being hidden by the skull.');

// ---------------------------------------------------------------------------
row('the placement sliders, one at a time');
// ---------------------------------------------------------------------------
reset();
equipAccessory('accessoryGlasses'); glasses.lift = SHIPPED.glasses.lift + 0.12;
shot('lift +0.12', 'up the face. If this goes down the screen, the sign in accessories.js is wrong.');

reset();
equipAccessory('accessoryGlasses'); glasses.snout = SHIPPED.glasses.snout + 0.15;
shot('snout +0.15', 'out toward the nose — the bone\'s own +Y.');

// ---------------------------------------------------------------------------
row('the camera only ever sees this animal side-on');
// ---------------------------------------------------------------------------
// THE ONE DECISION THIS SHEET IS REALLY FOR. A pair of glasses is a FRONT-
// FACING object and the seal is drawn in profile, so worn anatomically the lens
// plane is edge-on to the lens: what reaches the screen is the temple bar with
// the lens as a chip on the end of it. Every number above is correct and the
// thing still does not read as sunglasses.
//
// `yaw` is the way out — a turn about the body's own vertical, so a quarter of
// one swings the lenses round to face the camera. That is a cheat and it is the
// same cheat every side-on character with pixel shades makes. Both cells are
// here because it is a taste call, not a correctness one.
reset();
equipAccessory('accessoryGlasses'); glasses.yaw = 0; glasses.depth = 0; glasses.snout = 0.302;
shot('worn anatomically', 'yaw 0 — a real pair, the lens plane edge-on to the lens. All temple, no shades.');

reset();
equipAccessory('accessoryGlasses'); glasses.yaw = -Math.PI / 2;
shot('yawed the wrong way', 'the other quarter turn: temples at the camera, lenses left inside the skull. Not symmetric.');

reset();
equipAccessory('accessoryGlasses');
shot('shipped — yawed and pushed out', 'temples INTO the head where they belong, lens plate proud of the near cheek.');

// ---------------------------------------------------------------------------
row('a front-facing pair on a profile face — which lens covers the eye?');
// ---------------------------------------------------------------------------
// The cheat has a second half nobody warns you about. Both lenses of a
// camera-facing pair sit at the SAME depth, and the seal's two eye sockets
// project onto one screen pixel — so the pair cannot straddle the eye the way
// it would on a face turned toward you. One lens covers the eye and the other
// is over cheek, or the BRIDGE lands on it and the eye reads as a dark bead in
// the gap, which looks like a nostril.
reset(); equipAccessory('accessoryGlasses');
shot('bridge on the eye', 'centred on the socket — the eye shows between the lenses.');

reset(); equipAccessory('accessoryGlasses'); glasses.snout = 0.21;
shot('front lens on the eye', 'the pair slid back a lens-width. The eye is behind glass; the far lens is over cheek.');

// ---------------------------------------------------------------------------
row('the head turns — this is the failure a still frame cannot show');
// ---------------------------------------------------------------------------
// The CAP for this row rather than the glasses. One slot means one subject, and
// the cap is the right one: it sits highest, furthest from the bone, so it has
// the longest lever and is the first thing that would swing loose.
reset();
equipAccessory('accessoryHat');
pose(0.45);
shot('head up', 'the neck bent 0.45 rad. The cap has to bend with it, not hover.');

pose(-0.45);
shot('head down', 'and the other way. Anything placed from a world position drifts here.');
pose(0);

// ---------------------------------------------------------------------------
row('the cap, and the size it stops fitting at');
// ---------------------------------------------------------------------------
// captains_hat.glb. Its `size` is the front-to-back length of the peak in world
// units, because `fit: 1` normalises whatever the file's longest axis happens
// to be — on this model that is the visor, not the width. The two cells here
// are the pair worth seeing: the shipped fit, and one a size too big, which is
// where a cap stops sitting ON the head and starts swallowing it.
reset();
equipAccessory('accessoryHat');
shot('the cap', 'the shipped placement: crown band buried about 0.03, visor left proud over the brow.');

reset();
equipAccessory('accessoryHat');
hat.size = 1.15;
shot('cap at 1.15', 'a size too big — the skull is 0.691 across, and past about a unit long the cap eats the head.');

// ---------------------------------------------------------------------------
row('on the menu — the bust, turned, and where its eyes end up');
// ---------------------------------------------------------------------------
// A SECOND SEAL, STANDING. Every cell above is the swimming animal, because
// that is the pose an accessory is placed against. These three are the pose it
// is SEEN in: systems/mainMenu.js holds the seal upright, and what it is
// wearing can ask to be looked at square on (`showTurns`).
//
// THE POSE IS THE RIG'S ALONE. This block does not apply the bust's pin or its
// measured plumb (systems/splashBust.js) — those hold the waist and cant the
// whole animal, and neither has anything to do with where the head ends up
// looking. Leaving them out means these three cells differ by the one thing
// they are about; the menu is the place to judge the composition.
//
// The middle cell is the whole argument for the lean. Turning the body is not
// enough on its own — the aim the rig solves is a screen-plane direction, so a
// seal stood on its tail with the cursor above it points its face at the sky
// and the camera gets the top of a skull. The eyes, which are the entire reason
// to turn the animal round, are looking over you.
{
  const stand = new THREE.Object3D();
  scene.add(stand);
  const bust = createVisual('ship');
  bust.position.set(0, -0.9, 0);
  stand.add(bust);
  const bustRig = createAimRig(bust);
  seal.visible = false;
  // THE EYES, because this is the one view that can show the bead for what it
  // is. Side-on you only ever see a sphere's outline and it passes for an eye;
  // faced, a sphere standing on the socket is a marble glued to the skull. The
  // bead is sunk into the head (CONFIG.eyes.beadSink) and depth-tested so the
  // skull clips it to a dome — and whether that reads as an eye is a picture,
  // not a number. No bloom on this page, so the halo is invisible here; it is
  // the bead's dome and its glint that are being judged.
  const eyeGroup = createEyeLights();
  scene.add(eyeGroup);

  const _y = new THREE.Vector3(0, 1, 0);
  const cursor = new THREE.Vector3(0.9, 3.4, 0);   // roughly where the buttons sit
  const bustAimV = new THREE.Vector2(0, 1);
  const wantV = new THREE.Vector2(0, 1);

  // A PORTRAIT CROP, not the run's frame. The bust fills the menu's screen at
  // about fifteen times the arena's zoom (systems/mainMenu.js), and the whole
  // question here is what the head is doing — at the run's five-unit frame the
  // animal is a sliver and none of it reads.
  const BUST_W = 3.1;
  const bustCam = new THREE.OrthographicCamera(
    -BUST_W / 2, BUST_W / 2, (BUST_W * H / W) / 2, -(BUST_W * H / W) / 2, -100, 200,
  );
  activeCam = bustCam;
  bustSubject = bust;

  function standPose(turn, faceOut) {
    for (let i = 0; i < 200; i++) {
      bust.quaternion.setFromAxisAngle(_y, turn);
      bust.updateMatrixWorld(true);
      bustAim(bustRig, cursor, wantV, Math.PI / 2, 1);
      bustAimV.lerp(wantV, 0.2).normalize();
      bustRig.update(1 / 60, bustAimV, { engaged: true, faceOut });
      scene.updateMatrixWorld(true);
      updateAccessories(bust);
      updateEyeLights(1 / 60, bustRig, { lit: 1 });
      scene.updateMatrixWorld(true);
    }
    // FRAMED ON THE HEAD, EVERY CELL, and re-read after the pose rather than
    // once: leaning the neck out moves the skull a long way down the frame, and
    // a fixed camera would show the three cells at three different croppings of
    // the same animal — which is the difference this sheet is for.
    const at = bust.getObjectByName('head_07').getWorldPosition(new THREE.Vector3());
    bustCam.position.set(at.x, at.y - 0.35, 20);
    bustCam.updateProjectionMatrix();
  }

  reset();
  equipAccessory('accessoryGlasses');
  standPose(0, 0);
  shot('the bust, in profile', 'how every accessory was seen before any of this — one eye, and the glasses edge-on to it.');

  standPose(-Math.PI / 2, 0);
  shot('turned, no lean', 'the body faced and nothing else: the cursor is above, so the face is pointed at the sky.');

  standPose(-Math.PI / 2, 1);
  shot('turned, leaning out', 'the target pushed toward the lens and the neck given the travel to reach it. Eyes on you, still tracking the cursor.');

  // THE EYE, CLOSE. Same pose, a frame a fifth the width, on the near socket —
  // the only way to see whether the bead is a dome set into the face or a ball
  // sitting on it. The sink is compared against 0 in the second cell, which is
  // what every screenshot before this looked like.
  {
    const CLOSE_W = 0.7;
    const eyeCam = new THREE.OrthographicCamera(
      -CLOSE_W / 2, CLOSE_W / 2, (CLOSE_W * H / W) / 2, -(CLOSE_W * H / W) / 2, -100, 200,
    );
    const onEye = () => {
      const at = bustRig.anchors.eyeL.z > bustRig.anchors.eyeR.z ? bustRig.anchors.eyeL : bustRig.anchors.eyeR;
      eyeCam.position.set(at.x, at.y, 20);
      eyeCam.updateProjectionMatrix();
    };
    const sinkWas = CONFIG.eyes.beadSink;
    activeCam = eyeCam;
    standPose(-Math.PI / 2, 1);
    onEye();
    shot('the eye, faced — sunk', `beadSink ${CONFIG.eyes.beadSink}: the skull clips the sphere to a dome.`);
    CONFIG.eyes.beadSink = 0;
    standPose(-Math.PI / 2, 1);
    onEye();
    shot('the eye, faced — on the face', 'beadSink 0, the old placement: a whole sphere standing off the socket.');
    CONFIG.eyes.beadSink = sinkWas;
    standPose(0, 0);
    onEye();
    shot('the eye, in profile — sunk', 'the same sink from the side: the outline still has to cover the eye.');
    activeCam = bustCam;
  }

  resetEyeLights();
  scene.remove(eyeGroup);
  scene.remove(stand);
  seal.visible = true;
  activeCam = camera;
  bustSubject = null;
}

reset();
resetAccessories();

await Promise.all(posted);
log(fails === 0 ? `${shotIndex} frames — all good` : `${fails} failing`, fails === 0 ? 'ok' : 'bad');
log('shots posted to the serve.mjs drop box', 'note');
