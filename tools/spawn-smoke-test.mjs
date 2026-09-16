// ---------------------------------------------------------------------------
// EVERY ENEMY IN THE ROSTER ACTUALLY BUILDS — npm run test:spawn
//
// The tables around this one each check a different half and none of them
// checks this half:
//
//   test:tables     the CSV parses and joins onto CONFIG.enemies
//   test:nightlife  the asset key resolves and the .glb is on disk
//   test:ramp       the numbers scale sanely with difficulty
//
// All three can pass on a creature that THROWS the moment something asks for a
// body — a behaviour with no block to read, a rig field naming a bone that is
// not in the file, an asset whose `shape` is missing so createVisual hands back
// an empty Object3D. That last one is the dangerous shape: an invisible
// creature still dealing contact damage, which enemyTable's header calls out
// by name and which nothing before this could catch.
//
// SO THIS SPAWNS ONE OF EACH AND LOOKS AT IT. Not a simulation — one spawn, one
// set of assertions, forty-odd times.
//
// WHAT IT ASSERTS, and why each one is a real failure mode rather than a
// tautology:
//
//   it did not throw          the commonest way a new row breaks
//   a mesh exists             createVisual's empty-Object3D fallback still
//                             produces an object, so `!!e.mesh` is not enough
//                             on its own — see the child count below
//   the position is finite    ENEMIES HAVE NO x/y. Position lives on
//                             e.mesh.position, and reading e.x gives undefined,
//                             which makes NaN velocity and a creature that is
//                             never drawn and never collides. A harness that
//                             invents the field hides exactly this.
//   hp and radius are > 0     a blank REQUIRED column falls back to config.js
//                             and warns; a blank one in BOTH is a creature
//                             with NaN health that cannot be killed
//   the body has children     an empty Object3D passes every check above.
//                             A real body has geometry under it. Procedural
//                             shapes are meshes themselves, so either the root
//                             is a mesh or it has descendants.
//
// Bosses are skipped: they come through a different door (spawnBoss, with its
// own arena state) and their own tests cover it.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, resetEnemies, spawnNamed } from '../path/src/entities/enemies.js';

const scene = new THREE.Scene();
let failed = 0, checked = 0;
const fail = (key, why, detail) => { failed++; console.log(`  FAIL  ${key}: ${why}${detail ? ` — ${detail}` : ''}`); };

const keys = Object.keys(CONFIG.enemies).filter((k) => !/^boss/.test(k));
console.log(`\nSPAWN SMOKE — ${keys.length} creatures, one of each\n`);

for (const key of keys) {
  checked++;
  resetEnemies(scene);
  let e;
  try {
    spawnNamed(scene, key, 1);
    e = enemies[0];
  } catch (err) {
    fail(key, 'threw on spawn', err.message);
    continue;
  }
  if (!e) { fail(key, 'spawned nothing'); continue; }

  if (!e.mesh) { fail(key, 'no mesh'); continue; }
  const p = e.mesh.position;
  if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) {
    fail(key, 'position is not finite', `(${p.x}, ${p.y}, ${p.z})`);
  }
  if (!(Number.isFinite(e.hp) && e.hp > 0)) fail(key, 'hp is not a positive number', String(e.hp));
  if (!(Number.isFinite(e.radius) && e.radius > 0)) fail(key, 'radius is not a positive number', String(e.radius));

  // The empty-Object3D tell. A model that failed to resolve leaves a root with
  // nothing under it, which reads as a creature that is simply invisible.
  let drawable = e.mesh.isMesh === true;
  if (!drawable) e.mesh.traverse((o) => { if (o.isMesh) drawable = true; });
  if (!drawable) fail(key, 'the body has no geometry under it — createVisual fell back to an empty Object3D');

  // A declared sting has to be a pair of numbers or combat.js reads NaN and
  // the reach silently becomes nothing, on a creature whose whole damage
  // budget lives there.
  const sting = CONFIG.enemies[key].sting;
  if (sting && !(Number.isFinite(sting.offset) && Number.isFinite(sting.radius) && sting.radius > 0)) {
    fail(key, 'sting is not a usable pair', JSON.stringify(sting));
  }
}

console.log(failed
  ? `\nFAIL — ${failed} problem(s) across ${checked} creatures`
  : `\nspawn smoke: all good — ${checked} creatures build`);
process.exit(failed ? 1 : 0);
