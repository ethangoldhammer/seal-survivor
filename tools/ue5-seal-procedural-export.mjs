// Export the seal's PROCEDURAL animation layer (everything the 3js game does on top of the clips)
// for the UE5 AnimBP.
//
//   node --import ./tools/vite-loader.mjs tools/ue5-seal-procedural-export.mjs [outdir]
//
// Writes build/ue5-seal-procedural/params.json, resolved from CONFIG (saved tuning applied):
// head/neck aim IK, front-flipper IK, tail spring, resting breath, jaw, body turn.
// What each one is, and how to build it in UE: design/ue5/SEAL-PROCEDURAL-ANIM.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../path/src/config.js';
import { ASSETS } from '../path/src/assets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(root, 'build', 'ue5-seal-procedural'));
fs.mkdirSync(out, { recursive: true });
const copy = (v) => JSON.parse(JSON.stringify(v ?? null));
const ship = ASSETS.ship;

const params = {
  note: 'Angles are radians, lengths are game/glb units (1 unit = 100 cm in the UE export), times are seconds. ' +
    'bend/fold/twist values are per bone, in the bone\'s own frame.',
  // THE HEAD. Neck chain is solved with CCD IK toward the aim direction, blended over the clip.
  head: { chain: copy(ship.aimRig.head), config: copy(CONFIG.head) },
  // The two front flippers, IK'd onto the aim as well (weapon muzzles in the game).
  fins: { chains: copy(ship.aimRig.fins), config: copy(CONFIG.fins) },
  // Damped spring on the tail so it trails turns.
  tail: { chain: copy(ship.aimRig.tail), config: copy(CONFIG.tail) },
  // Resting breath: only while resting AT THE SURFACE, not while swimming.
  breath: { rig: copy(ship.breathRig), config: copy(CONFIG.surfaceRest?.breath) },
  jaw: { rig: copy(ship.biteRig), pickup: copy(CONFIG.pickups?.jaw) },
  bodyTurn: copy(Object.fromEntries(Object.entries(CONFIG.player ?? {}).filter(([k]) =>
    /^(faceMode|turnLerp|minSpeedToTurn|turnAround)/.test(k)))),
  clipSpeeds: copy(CONFIG.animation && { moveThreshold: CONFIG.animation.moveThreshold, boostThreshold: CONFIG.animation.boostThreshold }),
};
fs.writeFileSync(path.join(out, 'params.json'), JSON.stringify(params, null, 2));
console.log(`[ue5-seal-procedural] head ${params.head.chain.bones.join('>')} weight ${params.head.config.weight}/${params.head.config.idleWeight}, ` +
  `tail ${params.tail.chain.bones.join('>')} -> ${out}`);
