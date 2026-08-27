// ============================================================================
// GRAVESITE TEST — the run marker's state machine, headless.
//
// WHAT THIS CAN AND CANNOT SEE, because the difference decides what is worth
// asserting here and what has to be looked at in a browser.
//
// It CANNOT see the picture. No GLB loads in Node, so the stones here are
// stand-in boxes installed under the real asset keys — which means this says
// nothing about whether the inscription lands on the stone's FACE rather than
// its edge, and nothing about whether the etch reads. Those are questions for
// the look page. Worse, a harness that builds its own subject is exactly the
// shape that lets a real pipeline bug pass every test and ship dead, so the
// boxes are kept deliberately dumb: they exist to be positioned, not to stand
// in for the models.
//
// It CAN see the thing that actually hurts. The gravesite sits between the
// death dive and the score card: `markDeathSite` is handed the callback that
// PUTS THE SCORE SCREEN UP. Every branch that declines to do anything — the
// yard switched off, a model that never loaded, a canvas with no 2D context,
// the cap retiring the stone on the same frame it was filed — has to still
// call it. A miss there is not a missing decoration, it is a run that ended
// and left the player on an empty seabed with no button to press, and it is
// invisible to anything that only checks the happy path.
//
// Run: npm run test:graves
// ============================================================================
import './dom-stub.mjs';
// dom-stub is the loaders' minimum and has no storage. The yard persists across
// sessions now (systems/graveyardStore.js), so without this every save and load
// falls into its own catch and the restore below would pass by doing nothing —
// the most flattering possible failure.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { installModel } from '../path/src/assets.js';
import {
  markDeathSite, recordGrave, plantGraves, updateGravesites,
  graveList, clearGraves, reseatGraves, restoreGraves, setGraveImpact,
} from '../path/src/systems/gravesite.js';
import { updateBounds, bounds, SEABED_Z } from '../path/src/arena.js';
import { initGraveBeam, updateGraveBeam, graveBeamState } from '../path/src/systems/graveBeam.js';

let failures = 0;
function check(name, pass, detail = '') {
  if (pass) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * A stand-in stone. A box, installed under the real asset key so createVisual
 * and hasModel behave exactly as they do in the game — see the header for why
 * it is kept this dumb.
 */
function installStandIn(key) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.3), new THREE.MeshBasicMaterial());
  const root = new THREE.Object3D();
  root.add(mesh);
  return installModel(key, root);
}

/** Run the yard forward in wall-clock steps until nothing is moving, or give
 *  up. The cap is what turns "the state machine never finishes" from a hung
 *  test into a named failure. */
function settleYard(seconds = 12, step = 1 / 60) {
  for (let t = 0; t < seconds; t += step) {
    updateGravesites(step);
    // The beam is advanced alongside the stones, exactly as main.js does it.
    // Without this the glance never plays out and every death would look like
    // it hangs — which is a thing this harness should be able to see.
    updateGraveBeam(step);
    if (graveList().every((g) => g.phase === 'done')) return t;
  }
  return null;
}

const scene = new THREE.Scene();

console.log('\nGRAVESITE\n');

// --- the guarantee ----------------------------------------------------------
// Four ways the marker can decline to do anything. All four still owe a card.
console.log('the score card is always released');
{
  clearGraves();
  let fired = 0;
  CONFIG.gravesite.enabled = false;
  markDeathSite(scene, { x: 0, z: -3, name: 'OFF', cause: 'a shark' }, () => { fired += 1; });
  check('yard switched off still calls back', fired === 1, `fired ${fired}`);
  CONFIG.gravesite.enabled = true;
}
{
  clearGraves();
  let fired = 0;
  markDeathSite(null, { x: 0, z: -3, name: 'NOSCENE', cause: 'a crab' }, () => { fired += 1; });
  check('no scene still calls back', fired === 1, `fired ${fired}`);
}
{
  // Nothing installed yet, so hasModel is false for every stone and plantGraves
  // declines. This is the real boot-order case: a run that ends before the
  // models have finished loading.
  clearGraves();
  let fired = 0;
  markDeathSite(scene, { x: 0, z: -3, name: 'NOMODEL', cause: 'drowning' }, () => { fired += 1; });
  check('model not loaded still calls back', fired === 1, `fired ${fired}`);
}

for (const key of CONFIG.gravesite.stones) {
  if (!installStandIn(key)) { console.log(`  FAIL could not install stand-in for ${key}`); failures += 1; }
}
// With the stand-ins registered there are materials to attach to, so the beam
// is real here — which is what lets the glance below be asserted rather than
// assumed.
check('the beam attaches to the stand-ins', initGraveBeam() > 0);

{
  clearGraves();
  let fired = 0;
  markDeathSite(scene, { x: 4, z: -3, name: 'FAT TONY', cause: 'a shark' }, () => { fired += 1; });
  check('a real drop does not call back early', fired === 0, `fired ${fired}`);
  const took = settleYard();
  check('the drop finishes', took !== null, 'still moving after 12s');
  check('and calls back exactly once', fired === 1, `fired ${fired}`);
  // Advancing a finished yard must not fire it again — the callback shows a
  // screen, and showing it twice is as broken as never showing it.
  settleYard(1);
  check('and not again once it is done', fired === 1, `fired ${fired}`);
}

// --- the cap ----------------------------------------------------------------
console.log('\nthe yard is capped');
{
  clearGraves();
  CONFIG.gravesite.max = 3;
  let fired = 0;
  for (let i = 0; i < 6; i += 1) {
    markDeathSite(scene, { x: i * 3, z: -3, name: `SEAL ${i}`, cause: 'a crab' }, () => { fired += 1; });
    settleYard();
  }
  const yard = graveList();
  check('holds no more than the cap', yard.length === 3, `held ${yard.length}`);
  check('keeps the most recent', yard.map((g) => g.name).join(',') === 'SEAL 3,SEAL 4,SEAL 5', yard.map((g) => g.name).join(','));
  check('every death still got its card', fired === 6, `fired ${fired}`);
}
{
  // The nasty one: the cap retires a stone that is still mid-drop. It owes a
  // card and is about to be thrown away.
  clearGraves();
  CONFIG.gravesite.max = 1;
  let fired = 0;
  markDeathSite(scene, { x: 0, z: -3, name: 'FIRST', cause: 'a shark' }, () => { fired += 1; });
  markDeathSite(scene, { x: 6, z: -3, name: 'SECOND', cause: 'a crab' }, () => { fired += 1; });
  check('a stone retired mid-drop still calls back', fired >= 1, `fired ${fired}`);
  settleYard();
  check('and both deaths are accounted for', fired === 2, `fired ${fired}`);
  CONFIG.gravesite.max = 6;
}

// --- the clock --------------------------------------------------------------
// The single most important property in the file. Everything here runs on the
// RAW delta because the death dive dilates the world hard during exactly this
// sequence — a stone advanced on the gameplay clock falls in slow motion for
// the better part of a minute while the card waits on it.
console.log('\nthe drop runs on wall clock');
{
  clearGraves();
  markDeathSite(scene, { x: 0, z: -3, name: 'CLOCK', cause: 'a shark' }, () => {});
  const took = settleYard();
  const c = CONFIG.gravesite.drop;
  const fall = Math.sqrt((2 * c.height) / c.gravity);
  // The glance is part of the budget now — the stone lands, is carved, and then
  // gets one pass of light before the card. See the 'glance' phase.
  const budget = fall + c.settleTime + c.etchDelay + c.etchTime
    + c.glanceDelay + CONFIG.gravesite.beam.time + c.glanceTail;
  check('the whole beat is a few seconds, not a minute', took !== null && took < 9, `took ${took?.toFixed(2)}s`);
  check('and lands within its own configured budget', took !== null && took <= budget + 0.5,
    `took ${took?.toFixed(2)}s against a budget of ${budget.toFixed(2)}s`);
  // A dilated frame is a SMALL dt, so passing the gameplay delta by mistake
  // does not error — it just takes ten times as long. Asserting the multiplier
  // rather than "it eventually finishes" is what catches that.
  clearGraves();
  markDeathSite(scene, { x: 0, z: -3, name: 'SLOW', cause: 'a shark' }, () => {});
  let slow = 0;
  for (let i = 0; i < 60 * 6; i += 1) { updateGravesites((1 / 60) * 0.1); slow += 1 / 60; }
  const done = graveList().every((g) => g.phase === 'done');
  check('a tenth-speed clock is visibly slower (the bug this guards)', !done,
    'a dilated delta finished in the same wall time, so the two clocks are not distinguishable here');
}

// --- placement --------------------------------------------------------------
console.log('\nplacement');
{
  clearGraves();
  const rec = markDeathSite(scene, { x: 12.5, z: -3.2, name: 'PLACE', cause: 'a shark' }, () => {});
  settleYard();
  check('the stone stands where the body did', Math.abs(rec.object.position.x - 12.5) < 1e-6,
    `x = ${rec.object.position.x}`);
  check('at the configured depth', Math.abs(rec.object.position.z - (-3.2)) < 1e-6,
    `z = ${rec.object.position.z}`);
  const rest = rec.object.position.y;
  // Re-seating is what keeps the yard on the floor when the tuner moves it.
  // The failure it guards is silent: the stones hang in the water at the old
  // height and nothing anywhere reports it.
  reseatGraves();
  check('re-seating a settled stone leaves it where it was',
    Math.abs(rec.object.position.y - rest) < 1e-6, `${rest} -> ${rec.object.position.y}`);
}

// --- depth ------------------------------------------------------------------
// WHICH SIDE OF THE PLANTS THE NAME IS ON.
//
// The bed (systems/seabedScatter.js) is scattered through CONFIG.seabed.depth
// and the yard used to stand at one typed number in the MIDDLE of it, so a
// plant could stand across the inscription at the one moment it is meant to be
// read. What a harness can see is the arithmetic; whether a leaf actually
// reaches past the lane is a measurement off the real models, and it lives in
// the bed panel of tools/looks/graves.js because no GLB loads here.
console.log('\ndepth');
{
  clearGraves();
  const bedFront = CONFIG.seabed.depth[1];
  const clear = CONFIG.gravesite.dropClear;
  const rec = markDeathSite(scene, { x: 0, name: 'DEPTH', cause: 'a shark' }, () => {});
  settleYard();
  check('the stone that just fell stands in front of the whole plant bed',
    rec.object.position.z > bedFront,
    `stone z ${rec.object.position.z.toFixed(2)}, bed front ${bedFront}`);
  check('...by the clearance it was given',
    Math.abs(rec.object.position.z - (bedFront + clear)) < 1e-6,
    `z = ${rec.object.position.z}`);
  check('...and still behind the play plane', rec.object.position.z < 0,
    `z = ${rec.object.position.z}`);

  // THE LANE FOLLOWS THE BED. This is the whole reason dropZ() reads
  // CONFIG.seabed.depth instead of carrying a second number of its own: a typed
  // lane passes every check above and then silently stops clearing anything the
  // first time somebody drags the bed forward in the tuner.
  const savedBed = CONFIG.seabed.depth;
  CONFIG.seabed.depth = [-5.5, -2.6];
  clearGraves();
  const moved = markDeathSite(scene, { x: 0, name: 'MOVED', cause: 'a crab' }, () => {});
  settleYard();
  check('the lane moves with the bed rather than staying where it was typed',
    Math.abs(moved.object.position.z - (-2.6 + clear)) < 1e-6,
    `z = ${moved.object.position.z}`);
  CONFIG.seabed.depth = savedBed;

  // THE RESTING DEPTH, which is a different number from the one it is standing
  // at. Math.random is stubbed rather than sampled: the roll is a mapping onto
  // the slab and a handful of real rolls would only ever be evidence about the
  // RNG. The ends and the middle prove the mapping.
  const [back, front] = CONFIG.gravesite.restZ;
  const realRandom = Math.random;
  const rolled = [];
  for (const r of [0, 0.5, 1]) {
    Math.random = () => r;
    clearGraves();
    rolled.push(markDeathSite(scene, { x: 0, name: 'REST', cause: 'a shark' }, () => {}).restZ);
  }
  Math.random = realRandom;
  check('an old stone can end up back among the plants',
    Math.abs(rolled[0] - back) < 1e-6 && rolled[0] < bedFront, `deepest roll ${rolled[0]}`);
  check('...or in front of them, which is the point of a range',
    Math.abs(rolled[2] - front) < 1e-6 && rolled[2] > bedFront, `nearest roll ${rolled[2]}`);
  check('...and the middle of the range is the middle of the slab',
    Math.abs(rolled[1] - (back + front) / 2) < 1e-6, `mid roll ${rolled[1]}`);

  // THE ONE THAT WOULD BE INVISIBLE. A stone rolled behind the seabed strip is
  // not a stone in the distance, it is a stone nobody can find — the floor is
  // drawn at SEABED_Z and hides it completely.
  const savedRest = CONFIG.gravesite.restZ;
  CONFIG.gravesite.restZ = [-40, -30];
  Math.random = () => 0;
  clearGraves();
  const sunk = markDeathSite(scene, { x: 0, name: 'SUNK', cause: 'a crab' }, () => {});
  Math.random = realRandom;
  CONFIG.gravesite.restZ = savedRest;
  check('a range dragged behind the floor is clamped, not obeyed', sunk.restZ > SEABED_Z,
    `restZ ${sunk.restZ}, floor ${SEABED_Z}`);

  clearGraves();
}

// --- across sessions --------------------------------------------------------
// A stone that outlives the tab. The store's own portability is tested in
// tools/graveyard-store-test.mjs; this is the half that only gravesite.js can
// answer — what a restored grave DOES when it is planted.
console.log('\nstones from a previous session');
{
  updateBounds(16 / 9);
  clearGraves();
  // A session that happened: two deaths, both carved and glanced at.
  markDeathSite(scene, { x: 20, z: -3.2, name: 'FAT TONY', cause: 'a shark', lead: 'eaten by' }, () => {});
  settleYard();
  markDeathSite(scene, { x: -35, z: -3.2, name: 'BRINE', cause: 'running out of air', lead: 'undone by' }, () => {});
  settleYard();

  // ...and the tab closes. Only the module's memory is cleared, not the store —
  // which is exactly what a reload does.
  clearGraves();
  check('the yard is empty after a teardown', graveList().length === 0);

  // clearGraves also SAVES, so the reload below reads an emptied store. That is
  // correct for a teardown and wrong for a reload, which is why the store is
  // re-primed here rather than the test pretending clearGraves is a page close.
  markDeathSite(scene, { x: 20, z: -3.2, name: 'FAT TONY', cause: 'a shark', lead: 'eaten by' }, () => {});
  settleYard();
  graveList();
  const before = graveList().map((g) => g.name);
  // A "reload": the records go, the store stays.
  for (const rec of graveList()) { /* no-op, the yard is read-only here */ }
  const restored = (() => {
    // Drop the in-memory yard the way a page load would, WITHOUT writing.
    const saved = mem.get('seal-survivor-graveyard');
    clearGraves();
    mem.set('seal-survivor-graveyard', saved);
    return restoreGraves();
  })();

  check('the stones come back', restored > 0, `${restored} restored`);
  check('...with what they were carved with',
    graveList()[0]?.name === before[0] && graveList()[0]?.lead === 'eaten by',
    JSON.stringify(graveList()[0]));

  // THE RE-ENACTED DEATH. A restored grave filed as 'pending' would drop out of
  // the sky over the opening frames of a new run, for a death that happened on
  // a different day.
  check('and they are already settled, not falling',
    graveList().every((g) => g.phase === 'done'),
    graveList().map((g) => g.phase).join(', '));

  // THE PHANTOM CARD. onEtched is what puts a score card up; a restored grave
  // has no card to release, and advancing the yard must not conjure one.
  let carded = false;
  const spy = () => { carded = true; };
  plantGraves(scene);
  for (let i = 0; i < 600; i += 1) { updateGravesites(1 / 60); updateGraveBeam(1 / 60); }
  check('a restored grave never fires a score card', !carded);
  check('...and it is standing in the world',
    !!graveList().length && graveList().every((g) => g.phase === 'done'));
  void spy;

  // THE STONE MOVES BACK AMONG THE PLANTS. The session that carved it stands it
  // in front of the bed, because that is the session whose name is being read;
  // what goes to disk is the resting depth it rolled at death. The failure this
  // guards is the easy one to write: store the position the stone is standing
  // at, and the yard is a row of markers at one depth forever.
  {
    clearGraves();
    const fresh = markDeathSite(scene, { x: 5, name: 'LATER', cause: 'a shark' }, () => {});
    settleYard();
    const lane = fresh.object.position.z;
    const rest = fresh.restZ;
    const stored = mem.get('seal-survivor-graveyard');
    clearGraves();
    mem.set('seal-survivor-graveyard', stored);
    restoreGraves();
    plantGraves(scene);
    const later = graveList().find((g) => g.name === 'LATER');
    check('a stone from an earlier session comes back at its resting depth, not the drop lane',
      !!later && Math.abs(later.z - rest) < 1e-6 && Math.abs(rest - lane) > 1e-6,
      `lane ${lane.toFixed(2)} -> ${later?.z?.toFixed(2)}, rolled ${rest.toFixed(2)}`);
  }

  clearGraves();
}

// --- the impact -------------------------------------------------------------
// The stone hits the seabed and everything standing there finds out. The SHOVE
// itself is main.js's (it needs the enemy list); what gravesite.js owes is the
// event — once, on the frame of contact, at the right place, and never able to
// take the sequence down.
console.log('\nthe landing hits the water');
{
  clearGraves();
  const hits = [];
  setGraveImpact((x, y) => hits.push({ x, y }));
  const rec = markDeathSite(scene, { x: 17, z: -3.2, name: 'BOOM', cause: 'a shark' }, () => {});

  // Nothing on the way down — the blast is the LANDING, not the drop.
  for (let i = 0; i < 5; i += 1) { updateGravesites(1 / 60); updateGraveBeam(1 / 60); }
  check('nothing fires while the stone is still falling', hits.length === 0,
    `${hits.length} already`);

  settleYard();
  check('it fires exactly once', hits.length === 1, `${hits.length} times`);
  check('at the stone, not at the origin', Math.abs(hits[0].x - 17) < 0.01, `x = ${hits[0]?.x}`);
  // The y is what a blast radius is measured from, and the graveyard lives at
  // about -38.8 — an impulse centred on world zero would go off in mid-water,
  // forty units above the stone, which is the same class of mistake the beam's
  // rake made and is just as invisible.
  check('and at the seabed, not at world zero', hits[0].y < -10, `y = ${hits[0]?.y?.toFixed(1)}`);

  // A THROWING HOOK MUST NOT STRAND THE PLAYER. The stone still has a name to
  // carve and a score card to release on the far side of this, and the impulse
  // is the one part of the sequence that reaches into combat.
  clearGraves();
  let carded = false;
  setGraveImpact(() => { throw new Error('the water exploded'); });
  markDeathSite(scene, { x: 0, z: -3.2, name: 'THROWS', cause: 'a crab' }, () => { carded = true; });
  const took = settleYard();
  check('an impulse that throws does not strand the run', took !== null && carded,
    carded ? `finished in ${took?.toFixed(2)}s` : 'the score card never arrived');

  setGraveImpact(null);
  clearGraves();
}

// --- the glance -------------------------------------------------------------
// THE ORDER THE PLAYER SEES, and the reason it is asserted rather than trusted:
// every part of it is a timer, and a timer that fires in the wrong order still
// fires. A card that arrives during the sweep is not an error, it is just the
// last thing anybody looks at.
console.log('\nthe last look before the card');
{
  clearGraves();
  let carded = false;
  const rec = markDeathSite(scene, { x: 0, z: -3, name: 'GLANCE', cause: 'a shark' },
    () => { carded = true; });

  const c = CONFIG.gravesite.drop;
  const step = 1 / 60;
  let t = 0;
  let sawGlancePhase = false;
  let sawBeamLit = false;
  let cardedDuringBeam = false;
  for (let i = 0; i < 60 * 12 && !carded; i += 1) {
    updateGravesites(step);
    updateGraveBeam(step);
    t += step;
    const phase = graveList()[0]?.phase;
    if (phase === 'glance') sawGlancePhase = true;
    if (graveBeamState().strength > 0) {
      sawBeamLit = true;
      if (carded) cardedDuringBeam = true;
    }
  }

  check('the stone gets a glance phase of its own after the carving', sawGlancePhase);
  check('and the beam really lights during it', sawBeamLit,
    'the sweep never reached a visible strength');
  check('the card does NOT arrive while the light is on it', !cardedDuringBeam);
  check('but it does arrive', carded, `after ${t.toFixed(2)}s`);
  // The beat is a design decision and the numbers are in config; this is the
  // check that the card waits for ALL of it rather than for some of it.
  const floor = c.glanceDelay + CONFIG.gravesite.beam.time + c.glanceTail;
  check('...only once the whole beat has played', t > floor,
    `${t.toFixed(2)}s total against a ${floor.toFixed(2)}s closing beat`);
  check('and the beam has let go by then', graveBeamState().strength === 0,
    String(graveBeamState().strength));
}

// --- size -------------------------------------------------------------------
// The knob the player actually reaches for, and the bug hiding behind it. The
// epitaph is a CHILD of the stone, so it lives in a space the size knob has
// already scaled — hand it world numbers and it comes out multiplied twice, at
// an offset that is also wrong, sitting off the side of the stone. At scale 1
// it is perfect, which is why nothing caught it until somebody turned it up.
console.log('\nthe size knob');
{
  const measure = (scale) => {
    CONFIG.gravesite.scale = scale;
    clearGraves();
    const rec = markDeathSite(scene, { x: 0, z: -3, name: 'BIG', cause: 'a shark' }, () => {});
    settleYard();
    const stone = new THREE.Box3().setFromObject(rec.object);
    const slab = new THREE.Box3().setFromObject(rec.epitaph);
    return {
      stoneH: stone.max.y - stone.min.y,
      stoneW: stone.max.x - stone.min.x,
      inkW: slab.max.x - slab.min.x,
      inkH: slab.max.y - slab.min.y,
      // Where the inscription sits on the stone, as a fraction of it. This is
      // the number that must NOT move with the knob.
      inkOfStone: (slab.max.x - slab.min.x) / (stone.max.x - stone.min.x),
      centred: Math.abs((slab.max.x + slab.min.x) / 2 - (stone.max.x + stone.min.x) / 2),
      base: stone.min.y,
    };
  };

  const one = measure(1);
  const three = measure(3);

  check('a 3x stone is 3x as tall', Math.abs(three.stoneH / one.stoneH - 3) < 0.02,
    `${one.stoneH.toFixed(2)} -> ${three.stoneH.toFixed(2)}`);
  check('the inscription grows with the stone and not faster',
    Math.abs(three.inkOfStone - one.inkOfStone) < 0.01,
    `covers ${(one.inkOfStone * 100).toFixed(1)}% of the face at 1x, ${(three.inkOfStone * 100).toFixed(1)}% at 3x`);
  // NOT "centred", which it is not and should not be: the stone leans, and the
  // inscription sits above its centre, so the lean carries the ink sideways by
  // rise x sin(lean). That is the ink riding the stone, which is the whole
  // reason it is a child of it. What must hold is that the offset is the same
  // FRACTION of the stone at either size — the double-scale bug breaks that and
  // an absolute tolerance would just be a number tuned until it went green.
  check('and sits the same way on the face at either size',
    Math.abs(three.centred / three.stoneW - one.centred / one.stoneW) < 0.005,
    `${(one.centred / one.stoneW * 100).toFixed(2)}% of the stone at 1x, ${(three.centred / three.stoneW * 100).toFixed(2)}% at 3x`);
  check('the inscription is still ON the stone at 3x', three.inkW < three.stoneW,
    `ink ${three.inkW.toFixed(2)} vs stone ${three.stoneW.toFixed(2)}`);
  // A bigger stone still stands on the floor rather than sinking into it or
  // hovering — seat() measures the base, so this is the check that it re-ran
  // against the scaled body rather than the unscaled one.
  check('a bigger stone still stands on the seabed',
    Math.abs(three.base - one.base) < 0.2, `base ${one.base.toFixed(2)} -> ${three.base.toFixed(2)}`);
  CONFIG.gravesite.scale = 3;
}

// --- the inscription --------------------------------------------------------
// dom-stub's canvas returns null from getContext, which is the headless path
// through makeEpitaph. It must produce a quad that draws nothing rather than
// throwing from inside three.js — where the error would surface nowhere near
// its cause.
console.log('\nthe inscription, headless');
{
  clearGraves();
  const rec = markDeathSite(scene, { x: 0, z: -3, name: 'BLANK', cause: 'a shark' }, () => {});
  check('an epitaph is attached even with no 2D context', !!rec.epitaph);
  check('and it is the blank one rather than a broken texture', rec.epitaph?.userData?.blank === true);
  settleYard();
}

// --- the record -------------------------------------------------------------
console.log('\nwhat the stone remembers');
{
  clearGraves();
  recordGrave({ x: 1, z: -3, name: '  Fat Tony  ', cause: 'a shark' });
  const [g] = graveList();
  check('the name is trimmed', g.name === 'Fat Tony', `"${g.name}"`);
  recordGrave({ x: 1, z: -3, name: '', cause: '' });
  check('a blank name still reads as something', graveList()[1].name.length > 0);
  // A grave filed with no position at all must not put a stone at NaN, which
  // would make the whole object vanish with nothing thrown.
  recordGrave({ x: undefined, z: undefined, name: 'NAN', cause: '' });
  const n = graveList()[2];
  check('a missing position falls back rather than going NaN',
    Number.isFinite(n.x) && Number.isFinite(n.z), `x=${n.x} z=${n.z}`);
  plantGraves(scene);
  settleYard();
}

clearGraves();
console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
