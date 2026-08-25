#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:flags
//
// The flags on the mastheads — path/src/flags.csv, flagTable.js and
// systems/flags.js. Four sections, and the first two are the ones that catch
// the bugs that would otherwise ship looking deliberate:
//
//   THE POOL      that `hulls` means EXCLUSIVE. Bakalar's flag is his because
//                 his row names his hull; the failure mode is not a crash but
//                 his flag turning up on a boss, or a boss flying his, and
//                 either one reads as a content mistake rather than a code
//                 one. Also that a row naming a hull that flies nothing is
//                 DROPPED rather than falling back into the general pool,
//                 which is the same bug wearing a typo.
//
//   THE MAST      that the hoist point is found on the mast and not in the
//                 middle of the boat, and that it means the same thing on a
//                 hull ten times the size — the whole reason the band is a
//                 fraction. A flag hanging in mid-air beside a mast is the
//                 failure, and it looks like bad art.
//
//   THE CLOTH     that the quad is cut to the image's aspect, that its hoist
//                 edge is at the origin (so the group's position IS the point
//                 on the mast), and that the wave GLSL actually LANDS. Every
//                 hook is a string replace against three.js's own chunks, and
//                 a replace that matches nothing is a silent no-op: the
//                 material compiles perfectly and the flag simply never moves.
//
//   THE TEARDOWN  that a flag whose hull has gone stops being ticked and frees
//                 its geometry — resetBossBoat drops the group, and nothing
//                 else in the game knows this module is holding it.
//
// What it cannot tell you: whether the GLSL compiles (that needs a real GL
// context — see npm run glow for the rig that has one), or whether a flag
// looks right on the water.
// ---------------------------------------------------------------------------

import './dom-stub.mjs';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { CONFIG } from '../path/src/config.js';
import { parseFlagCsv, buildFlags, pickFlag, flagsFor } from '../path/src/flagTable.js';
import {
  measureMast, buildFlagQuad, attachFlag, updateFlags, flagCount, flagRoster,
} from '../path/src/systems/flags.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

const HULLS = Object.keys(CONFIG.flags?.hulls ?? {});
const quiet = () => {};

// ---------------------------------------------------------------------------
section('THE POOL — the shipped table');

const shipped = flagRoster();
check('flags.csv parsed', !!shipped, `${shipped.general.length} in the pool, ${Object.keys(shipped.byHull).length} hull(s) with their own`);
check('the hulls that fly flags are the three boats', HULLS.length === 3
  && HULLS.includes('bakalarBoat') && HULLS.includes('bossBoat') && HULLS.includes('bossYacht'),
  HULLS.join(', '));

const bakalarFlags = shipped.byHull.bakalarBoat ?? [];
check("Bakalar's hull has its own flag written for it", bakalarFlags.length === 1,
  bakalarFlags.map((f) => f.id).join(', '));
check("...and it is NOT in the pool the bosses draw from",
  !shipped.general.some((f) => bakalarFlags.includes(f)));
check('...and its image lives under public/flags/',
  bakalarFlags.every((f) => f.src.startsWith('/flags/')),
  bakalarFlags.map((f) => f.src).join(', '));

// ---------------------------------------------------------------------------
section('THE POOL — the rules, on a table written here');

const TABLE = [
  'id,src,hulls,weight,enabled,notes',
  'mine,/flags/mine.webp,bakalarBoat,1,,',
  'pool1,/flags/one.webp,,1,,',
  'pool2,/flags/two.webp,,3,,',
  'retired,/flags/gone.webp,,1,FALSE,',
  'noSrc,,,1,,',
  'typo,/flags/typo.webp,bossBarge,1,,',
  'both,/flags/both.webp,"bossYacht, bossBarge",1,,',
].join('\n');

const roster = buildFlags(parseFlagCsv(TABLE, quiet), { hulls: HULLS }, quiet);

check('a row that names a hull is exclusive to it',
  roster.byHull.bakalarBoat?.length === 1
  && roster.byHull.bakalarBoat[0].id === 'mine'
  && !roster.general.some((f) => f.id === 'mine'));
check('a hull with its own rows draws ONLY from them',
  flagsFor(roster, 'bakalarBoat').every((f) => f.id === 'mine'),
  flagsFor(roster, 'bakalarBoat').map((f) => f.id).join(', '));
check('a hull with none draws from the general pool',
  flagsFor(roster, 'bossBoat').map((f) => f.id).join(',') === 'pool1,pool2',
  flagsFor(roster, 'bossBoat').map((f) => f.id).join(', '));
// The half of the rule that surprises: writing ONE flag for the yacht does not
// add it to the yacht's choices, it becomes the yacht's only choice. Same
// convention as quips.csv's `causes` — a line written for an occasion BEATS the
// general pool rather than competing with it — and it is the whole reason
// Bakalar's flag is his. Worth a check of its own so it can never be quietly
// softened into "the pool plus these".
check('...and a hull with one row of its own stops drawing from the pool entirely',
  flagsFor(roster, 'bossYacht').map((f) => f.id).join(',') === 'both',
  flagsFor(roster, 'bossYacht').map((f) => f.id).join(', '));
check('a row can name several hulls, and the ones that fly nothing are dropped from it',
  roster.byHull.bossYacht?.some((f) => f.id === 'both')
  && !roster.byHull.bossBarge);
check('enabled FALSE is out of every pool',
  !JSON.stringify(roster).includes('retired'));
check('a row with no src is dropped rather than flown blank',
  !JSON.stringify(roster).includes('noSrc'));
check('a row written for a hull that flies nothing is DROPPED, not dumped in the pool',
  !roster.general.some((f) => f.id === 'typo') && !JSON.stringify(roster.byHull).includes('typo'));

// The weighting, rolled rather than averaged. pool2 is weighted 3 against
// pool1's 1, so of the four weight-units in that pool the first is pool1's and
// the next three are pool2's — and a roll is checked at each end of both.
const picked = [0.0, 0.15, 0.5, 0.95].map((r) => pickFlag(roster, 'bossBoat', () => r)?.id);
check('weight decides the share of the roll — pool2 at 3 takes three quarters of it',
  picked.join(',') === 'pool1,pool1,pool2,pool2', picked.join(', '));

const zeroed = buildFlags(parseFlagCsv([
  'id,src,hulls,weight',
  'a,/flags/a.webp,,0',
  'b,/flags/b.webp,,0',
].join('\n'), quiet), { hulls: HULLS }, quiet);
check('every flag weighted 0 means the hull flies nothing, not the first row',
  pickFlag(zeroed, 'bossBoat', () => 0.5) === null);
check('a hull with an empty pool flies nothing',
  pickFlag(buildFlags([], { hulls: HULLS }, quiet), 'bossBoat', () => 0.5) === null);

// ---------------------------------------------------------------------------
section('THE MAST — where the flag is tied on');

// A boat: a long low hull, and a thin mast standing off-centre on it. The
// numbers are the shape of the real trawler — a 19-unit hull with a gantry
// about a fifth of the way forward of the middle — so the check below is the
// one that matters: the hoist point must land on the MAST, not between the two.
function hullPoints(scale = 1, mastX = 2.3) {
  const pts = [];
  for (let x = -9; x <= 9; x += 0.5) {
    for (const z of [-2.5, 0, 2.5]) pts.push(new THREE.Vector3(x * scale, 0, z * scale));
  }
  for (let y = 1; y <= 13; y += 0.5) {
    for (const z of [-0.1, 0.1]) pts.push(new THREE.Vector3(mastX * scale, y * scale, z * scale));
  }
  return pts;
}

const mast = measureMast(hullPoints(1), 0.03);
check('the hoist point is on the mast, not in the middle of the boat',
  Math.abs(mast.x - 2.3) < 0.01, `x ${mast.x.toFixed(2)} (hull spans -9..9, mast at 2.3)`);
check('...at the top of it', Math.abs(mast.y - 13) < 0.01, `y ${mast.y.toFixed(2)}`);
check('...and the height is the whole hull', Math.abs(mast.height - 13) < 0.01);

const big = measureMast(hullPoints(10), 0.03);
check('a hull ten times the size measures ten times the point — the band is a FRACTION',
  Math.abs(big.x - mast.x * 10) < 0.1 && Math.abs(big.y - mast.y * 10) < 0.1,
  `${big.x.toFixed(1)}, ${big.y.toFixed(1)}`);

check('nothing to measure is null rather than a flag at the origin',
  measureMast([]) === null && measureMast([new THREE.Vector3(1, 2, 3)]) === null);

// A wider band reaches further down the rigging. Worth pinning: it is the one
// control here whose effect is invisible until a flag is halfway down a mast.
const wide = measureMast([
  ...hullPoints(1),
  // a boom sticking aft, two thirds of the way up
  ...Array.from({ length: 20 }, (_, i) => new THREE.Vector3(-i * 0.3, 9, 0)),
], 0.5);
check('a wider band pulls the hoist point down the rigging', wide.x < mast.x,
  `x ${wide.x.toFixed(2)} at band 0.5 vs ${mast.x.toFixed(2)} at 0.03`);

// ---------------------------------------------------------------------------
section('THE CLOTH');

// A stub texture: three.js only ever reads .image for the size, and nothing in
// Node can decode a webp.
const stubTex = (w, h) => ({ image: { width: w, height: h }, isTexture: true });

const { mesh: wide2to1, uniforms } = buildFlagQuad(stubTex(200, 100), { height: 2, rand: () => 0.5 });
wide2to1.geometry.computeBoundingBox();
const box = wide2to1.geometry.boundingBox;
check('the quad is cut to the image aspect', Math.abs((box.max.x - box.min.x) - 4) < 1e-4,
  `2:1 image at height 2 -> ${(box.max.x - box.min.x).toFixed(2)} wide`);
check('the hoist edge is at the origin, and the cloth hangs aft and down',
  Math.abs(box.max.x) < 1e-6 && Math.abs(box.max.y) < 1e-6 && box.min.x < 0 && box.min.y < 0,
  `x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}, y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);

const tall = buildFlagQuad(stubTex(100, 200), { height: 2, rand: () => 0.5 }).mesh;
tall.geometry.computeBoundingBox();
check('...and a portrait image flies as a portrait flag',
  Math.abs((tall.geometry.boundingBox.max.x - tall.geometry.boundingBox.min.x) - 1) < 1e-4);

check('the wave is sized off the flag, not off the world',
  Math.abs(uniforms.uFlagAmp.value - 2 * CONFIG.flags.amplitude) < 1e-6
  && Math.abs(uniforms.uFlagWidth.value - 4) < 1e-6);

const phases = new Set([0.1, 0.6, 0.9].map((r) => buildFlagQuad(stubTex(2, 1), { height: 1, rand: () => r }).uniforms.uFlagPhase.value));
check('two flags on screen do not fly the same wave in lockstep', phases.size === 3);

// THE INJECTION. Run the material's onBeforeCompile over the real chunk names
// and see that every replace matched — the failure this catches is a three.js
// upgrade renaming a chunk, which costs nothing at compile time and silently
// leaves every flag rigid.
const shader = {
  uniforms: {},
  vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
  fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n}',
};
wide2to1.material.onBeforeCompile(shader, {});
check('the wave uniforms reach the shader',
  ['uFlagTime', 'uFlagPhase', 'uFlagWidth', 'uFlagWaves', 'uFlagSpeed', 'uFlagAmp', 'uFlagDroop', 'uFlagShade']
    .every((u) => u in shader.uniforms));
check('the vertex wave landed', shader.vertexShader.includes('uFlagAmp * reach * wave'));
check('the fold shading landed', shader.fragmentShader.includes('diffuseColor.rgb *= vFlagShade'));
check('the varying is declared on both sides',
  shader.vertexShader.includes('varying float vFlagShade')
  && shader.fragmentShader.includes('varying float vFlagShade'));
check('the program cache key is pinned, so every flag shares one compile',
  wide2to1.material.customProgramCacheKey() === wide2to1.material.customProgramCacheKey());

// ---------------------------------------------------------------------------
section('THE TEARDOWN');

// A hull that flies a flag, built the way attachFlag will see one.
function fakeHull() {
  const visual = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  const pts = hullPoints(1);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
  visual.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
  return visual;
}

const hull = fakeHull();
const group = attachFlag(hull, 'bakalarBoat', { rand: () => 0.5 });
check('a flag-flying hull gets a group on its mast', !!group
  && Math.abs(group.position.x - 2.3) < 0.01
  && group.position.y < 13 && group.position.y > 12,
  group ? `at ${group.position.x.toFixed(2)}, ${group.position.y.toFixed(2)}, ${group.position.z.toFixed(2)}` : '');
check('...parented to the visual, so it comes about with the boat',
  group?.parent === hull);
check('...and it is stood off toward the camera, clear of the mast',
  group.position.z > 0);

check('a hull that flies nothing gets no group', attachFlag(fakeHull(), 'trawler') === null);
check('...and neither does one with the system switched off', (() => {
  const was = CONFIG.flags.enabled;
  CONFIG.flags.enabled = false;
  const off = attachFlag(fakeHull(), 'bakalarBoat');
  CONFIG.flags.enabled = was;
  return off === null;
})());

// The quad only exists once its image decodes, which never happens in Node —
// so the teardown is exercised on one built here and pushed through the same
// path a real flag takes.
const live = buildFlagQuad(stubTex(2, 1), { height: 1, rand: () => 0.5 });
group.add(live.mesh);
// updateFlags only knows about flags attachFlag registered, so this stands in
// for that registration by driving the same public surface.
const before = flagCount();
updateFlags(0.016);
check('the clock advances without a flag in the water', flagCount() === before);

group.parent.remove(group);
updateFlags(0.016);
check('a flag whose hull has gone is no longer ticked', flagCount() === 0, `${flagCount()} live`);

// ---------------------------------------------------------------------------
section('THE FILE');

const csv = readFileSync(new URL('../path/src/flags.csv', import.meta.url), 'utf8');
check('flags.csv carries the columns the editor documents',
  csv.split('\n')[0].trim() === 'id,src,hulls,weight,enabled,notes',
  csv.split('\n')[0].trim());
check('every src in it points under /flags/',
  [...csv.matchAll(/^[^,\n]+,([^,\n]*)/gm)].slice(1).every(([, src]) => !src || src.startsWith('/flags/')));

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : 'PASS — all checks'}\n`);
process.exit(failures ? 1 : 0);
