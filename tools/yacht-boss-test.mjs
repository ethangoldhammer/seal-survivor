#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:yacht
//
// THE YACHT — the boat boss with people on it.
//
// The fight itself is the trawler's and is covered by npm run test:boat; this
// is only about the deck. Everything here fails SILENTLY if it fails at all: a
// party that never spawns leaves a boat that looks exactly like the trawler; a
// party that comes off to the first bullet leaves a boat that looks exactly
// like the trawler thirty seconds in; a party that is never released is four
// men deleted mid-air on the kill, which is one frame nobody will catch. None
// of it throws.
//
// NO MODELS, on purpose. Node's GLTFLoader hangs in this project's headless
// stub, so every figure below is the box-body fallback and every hull is its
// fallback primitive. That makes this the WIRING test — who is aboard, what
// lets go of them and when — and it is deliberately not asked whether anybody
// is standing on a deck or whether the ragdoll looks like a body. Those need
// the real geometry and a real GPU: see tools/looks/yacht-deck.html.
// ---------------------------------------------------------------------------
import './dom-stub.mjs';
import * as THREE from 'three';
import { CONFIG } from '../path/src/config.js';
import { enemies, resetEnemies, updateEnemies } from '../path/src/entities/enemies.js';
import { projectiles, resetProjectiles, updateProjectiles } from '../path/src/entities/projectiles.js';
import { updateBoss, updateBossAbilities, resetBoss, bossState, forceBoss } from '../path/src/systems/boss.js';
import { boatState } from '../path/src/systems/bossBoat.js';
import { crew, damageCrew, updateCrew, resetCrew } from '../path/src/systems/crew.js';
import { bounds } from '../path/src/arena.js';

const scene = new THREE.Scene();
const DT = 1 / 60;
let fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
  if (!ok) fail++;
};

function fresh(boss) {
  resetCrew(scene);
  resetEnemies(scene);
  resetProjectiles(scene);
  resetBoss(scene);
  const gs = { difficulty: 20, level: 20, running: true };
  const e = forceBoss(scene, gs, { boss, perk: 'lunge' });
  let n = 0;
  while (bossState.arriving && n++ < 1000) updateBoss(DT, gs, scene);
  return { e, gs };
}

// ---------------------------------------------------------------------------
console.log('\nTHE PARTY IS ABOARD');
// ---------------------------------------------------------------------------
const { e: yacht, gs } = fresh('bossYacht');
check('the yacht spawns', !!yacht, yacht?.type);
check('...and the boat system drives it', boatState.boat === yacht);
check('...off the same def flag as the trawler', yacht?.def?.surfaceBoss === true);

const { crewMin, crewMax, crewAssets } = CONFIG.enemies.bossYacht;
// NOT a fixed expectation — the party size is rolled per arrival, so anything
// that wants "still the same number aboard" has to capture it from the arrival
// it is actually talking about.
const aboard = () => crew.length;
check('the guests came with it', crew.length >= crewMin && crew.length <= crewMax,
  `${crew.length} aboard, the row asks for ${crewMin}-${crewMax}`);
// ROLLED, not fixed — so two yachts in one run are not the same boat. Sampled
// over many arrivals rather than trusted from one, and checked for the whole
// range rather than just "it varies": a roll that can only ever produce the
// bounds is as wrong as one that cannot vary at all.
{
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    fresh('bossYacht');
    seen.add(crew.length);
  }
  const inRange = [...seen].every((n) => n >= crewMin && n <= crewMax);
  check('...a different number each time, inside the bounds', seen.size > 1 && inRange,
    `saw ${[...seen].sort().join(', ')} over 60 arrivals`);
}
fresh('bossYacht');
check('...every one of them glued', crew.every((f) => f.glued));
check('...and standing on the hull, not in the scene',
  crew.every((f) => f.body.group.parent === yacht.mesh || f.body.kind === 'boxes'));
check('...with their lower body pinned to the deck',
  crew.every((f) => ['footL', 'footR', 'kneeL', 'kneeR', 'hips'].every((p) => f.rig.points[p].pinned)));

// THE TRAWLER SAILS ALONE, which is the other half of "the crew is declared by
// the row". A subtype that quietly gave every boat boss a party would pass every
// check above.
const before = crew.length;
fresh('bossBoat');
check('the trawler boss brings nobody', crew.length === 0, `${before} on the yacht, ${crew.length} on the trawler`);

// THE ROSTER REACHES THE CREW. Which MODEL each guest ends up wearing cannot be
// tested here — nothing loads in Node, so every figure is the box body and they
// are all identical by construction. What is testable, and what actually broke
// once, is the handover: the yacht's list has to arrive at systems/crew.js. It
// did not, because the gate that decides whether a hull has a crew at all was
// still asking for the OLD singular key, so a boat with `crewAssets` and no
// `crewAsset` sailed with an empty deck and nothing anywhere complained.
//
// Whether the party is actually mixed is a question for the look page, which
// has the models: tools/looks/yacht-deck.html reports the kinds aboard.
{
  fresh('bossYacht');
  check('the yacht hands its whole roster to the crew system',
    Array.isArray(boatState.deck?.crewAssets)
      && boatState.deck.crewAssets.length === crewAssets.length,
    `${JSON.stringify(boatState.deck?.crewAssets)} against the row's ${JSON.stringify(crewAssets)}`);
  check('...and its bounds', boatState.deck?.crewMin === crewMin && boatState.deck?.crewMax === crewMax,
    `${boatState.deck?.crewMin}-${boatState.deck?.crewMax}`);
}

// ---------------------------------------------------------------------------
console.log('\nTHE GLUE HOLDS');
// ---------------------------------------------------------------------------
const { e: hull } = fresh('bossYacht');
// CLONED. `mesh.position` is the live vector the hull steers with, so a
// reference to it is not a record of where the boat started — it is the boat,
// and every "has it moved" test below would compare it against itself and read
// a flat zero however far it sailed.
const at = hull.mesh.position.clone();
const partySize = aboard();
// Every bullet in the game reaches the crew through this call. Aimed at the
// hull with a radius that covers the whole boat, and fired thirty times: a
// working boat's crew would be in the water several times over.
let knocked = 0;
for (let i = 0; i < 30; i++) knocked += damageCrew(scene, at.x, at.y, 12);
check('gunfire does not take the guests off', knocked === 0, `${knocked} knocked off`);
check('...all still aboard', crew.length === partySize && crew.every((f) => f.state !== 'ragdoll'),
  `${crew.length} of the ${partySize} that boarded`);

// They do RIDE it, though — the hull tracks the player across the arena and a
// man glued to a deck has to go with it rather than standing in the sea where
// the boat used to be.
const rode = crew[0];
const startX = rode.rig.points.footL.x;
const playerPos = { x: bounds.right - 10, y: bounds.bottom + 8, z: 0 };
for (let i = 0; i < 60 * 4; i++) {
  updateBoss(DT, gs, scene);
  updateBossAbilities(DT, scene, playerPos, {});
  updateEnemies(DT, scene, playerPos, () => {}, () => {});
  updateCrew(DT, scene);
}
const drift = Math.abs(rode.rig.points.footL.x - hull.mesh.position.x)
  - Math.abs(startX - at.x);
check('the hull sailed and took them with it',
  Math.abs(hull.mesh.position.x - at.x) > 1,
  `hull moved ${(hull.mesh.position.x - at.x).toFixed(1)} units`);
check('...their feet stayed on the same spot of deck', Math.abs(drift) < 0.05,
  `${drift.toFixed(4)} units of slip over four seconds`);
check('...and none of them fell off on the way',
  crew.length === partySize && crew.every((f) => f.state !== 'ragdoll'),
  `${crew.length} of ${partySize}`);

// ---------------------------------------------------------------------------
console.log('\nIT COMES ABOUT, AND HE COMES WITH IT');
// ---------------------------------------------------------------------------
// The guest is parented to the VISUAL, which is the node that turns. Parent him
// to the container instead and the hull swings 180 degrees underneath him: he
// stays where he was in world space while the bow travels to the other end of
// the boat, so a man standing on the bow ends up hanging in the air off the
// stern. Nothing throws and the checks above all still pass.
{
  const guest = crew[0];
  const bowSideBefore = Math.sign(guest.rig.points.hips.x - hull.mesh.position.x);
  const reachBefore = Math.abs(guest.rig.points.hips.x - hull.mesh.position.x);
  // How high he rides above the hull — the number that betrays a man left
  // floating in mid-air where the deck used to be.
  const liftBefore = guest.rig.points.footL.y - hull.mesh.position.y;

  // Send the player the other way, so the hull has to come about. It is not
  // asked to STAY turned: a boat that has crossed the arena settles over the
  // player and oscillates, so the heading at the end of a fixed run is whatever
  // the chase happened to be doing. What matters is the moment it is round.
  const back = { x: bounds.left + 10, y: bounds.bottom + 8, z: 0 };
  const yaws = [];
  let round = null; // the frame the hull was most nearly reversed
  for (let i = 0; i < 60 * 6; i++) {
    updateBoss(DT, gs, scene);
    updateBossAbilities(DT, scene, back, {});
    updateEnemies(DT, scene, back, () => {}, () => {});
    updateCrew(DT, scene);
    yaws.push(boatState.yaw);
    if (!round || boatState.yaw > round.yaw) {
      round = {
        yaw: boatState.yaw,
        side: Math.sign(guest.rig.points.hips.x - hull.mesh.position.x),
        reach: Math.abs(guest.rig.points.hips.x - hull.mesh.position.x),
        lift: guest.rig.points.footL.y - hull.mesh.position.y,
      };
    }
  }

  check('the hull came about', Math.abs(round.yaw - Math.PI) < 0.05,
    `reached yaw ${round.yaw.toFixed(3)} of ${Math.PI.toFixed(3)}`);
  // A TURN, not a flip: the old code changed heading in one frame, so no sample
  // ever landed between the two headings at all.
  const midway = yaws.filter((y) => y > 0.2 && y < Math.PI - 0.2).length;
  check('...it steered round rather than flipping', midway > 20,
    `${midway} frames spent between the two headings (${(midway / 60).toFixed(2)}s)`);
  const jump = Math.max(...yaws.slice(1).map((y, i) => Math.abs(y - yaws[i])));
  check('...without a jump in the middle of it', jump < 0.15,
    `biggest single-frame change ${jump.toFixed(4)} rad`);

  // AND THE MAN WENT WITH THE BOW. Measured at the moment the hull is reversed:
  // he must be on the opposite side of the hull's centre from where he started,
  // the same distance out along it, and at the same height above it.
  check('the guest changed sides with the bow', round.side === -bowSideBefore,
    `${bowSideBefore > 0 ? '+' : '-'}x -> ${round.side > 0 ? '+' : '-'}x`);
  check('...the same distance out along the hull', Math.abs(round.reach - reachBefore) < 0.25,
    `${reachBefore.toFixed(2)} -> ${round.reach.toFixed(2)} units from the hull's centre`);
  check('...and at the same height, not floating off the stern',
    Math.abs(round.lift - liftBefore) < 0.05,
    `${liftBefore.toFixed(3)} -> ${round.lift.toFixed(3)} above the hull`);
  check('...still aboard and still glued', guest.state !== 'ragdoll' && guest.glued);
}

// ---------------------------------------------------------------------------
console.log('\nAND THE HULL LETS GO');
// ---------------------------------------------------------------------------
const heights = crew.map((f) => f.rig.points.hips.y);
// Killed, through the same route any damage takes: out of `enemies`, which is
// what systems/boss.js watches.
hull.hp = 0;
const i = enemies.indexOf(hull);
if (i !== -1) enemies.splice(i, 1);
updateBoss(DT, gs, scene);

check('the boat system let the hull go', boatState.boat === null);
check('every guest was thrown', crew.length === partySize && crew.every((f) => f.state === 'ragdoll'),
  `${crew.filter((f) => f.state === 'ragdoll').length} of ${crew.length}`);
check('...unglued and unpinned, so the solver owns them now',
  crew.every((f) => !f.glued && f.rig.list.every((p) => !p.pinned)));
const speeds = crew.map((f) => Math.hypot(
  f.rig.points.hips.x - f.rig.points.hips.px,
  f.rig.points.hips.y - f.rig.points.hips.py,
) * 120);
check('...thrown violently rather than dropped', Math.min(...speeds) > 8,
  `slowest ${Math.min(...speeds).toFixed(1)} u/s against the ordinary knock of ${CONFIG.boats.crew.knock}`);
// The whole party, not just the ones near the middle — the failure the tighter
// blast radius produced, where the bow and stern guests were left standing in
// mid-air where the boat had been.
check('...all of them, including the ends of the boat',
  speeds.every((s) => s > 8), speeds.map((s) => s.toFixed(0)).join(', '));

for (let t = 0; t < 60 * 3; t++) updateCrew(DT, scene);
check('they fall', crew.every((f, k) => f.rig.points.hips.y < heights[k]));
check('...into the water', crew.every((f) => f.rig.points.hips.y < bounds.surfaceY));
check('...without anybody reaching a NaN',
  crew.every((f) => f.rig.list.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))));
check('...or leaving the world',
  crew.every((f) => f.rig.points.hips.y > bounds.bottom - 2
    && f.rig.points.hips.x > bounds.left - 5 && f.rig.points.hips.x < bounds.right + 5));

// ---------------------------------------------------------------------------
console.log('\nA RUN THAT ENDS IS NOT A KILL');
// ---------------------------------------------------------------------------
// The other route through resetBossBoat. A boss switched off mid-fight takes
// its party with it quietly; throwing them would leave four bodies falling
// through an arena that is being torn down around them.
fresh('bossYacht');
check('aboard again', crew.length >= crewMin && crew.length <= crewMax, `${crew.length} aboard`);
resetBoss(scene);
check('a reset takes them with it, rather than throwing them', crew.length === 0, `${crew.length} left`);

// ---------------------------------------------------------------------------
console.log('\nIT SHELLS YOU WITH ITS MONEY');
// ---------------------------------------------------------------------------
// The `ordnance` override (CONFIG.enemies.bossYacht -> gunFor in
// systems/bossBoat.js). EVERY failure in this block is silent: a mistyped asset
// key spawns the procedural fallback and looks like a slightly odd barrel; a
// trail preset keyed on a name nothing fires leaves a shot with no wake and
// throws nothing; a blastEmitter naming an emitter that does not exist makes
// emit() return on its first line. The fight carries on looking almost right in
// all three cases, which is exactly why they are checked here rather than
// looked at.

// What a hull actually put in the water, by pattern. Driven long enough for the
// cycle to come round — the three patterns are fixed order, not a roll.
function ordnanceOf(boss) {
  const { e, gs: g } = fresh(boss);
  const pp = { x: 10, y: bounds.bottom + 8, z: 0 };
  const seen = new Map(); // source -> a sample projectile
  for (let i = 0; i < 60 * 24; i++) {
    updateBoss(DT, g, scene);
    updateBossAbilities(DT, scene, pp, { onPlayerHit: () => {} });
    updateEnemies(DT, scene, pp, () => {}, () => {});
    updateProjectiles(DT, scene, enemies, () => {}, () => {}, () => {});
    for (const p of projectiles) {
      if (p.source?.startsWith('boss:boat') && !seen.has(p.source)) seen.set(p.source, p);
    }
  }
  return { e, seen };
}

const { seen: rolls } = ordnanceOf('bossYacht');
const rain = rolls.get('boss:boatRain');
const salvo = rolls.get('boss:boatSalvo');
const spread = rolls.get('boss:boatSpread');
check('all three patterns fired', !!rain && !!salvo && !!spread, [...rolls.keys()].join(', '));

const ord = CONFIG.enemies.bossYacht.ordnance;
check('the explosive is a roll of cash', rain?.mesh?.name === ord.barrels.asset,
  `${rain?.mesh?.name} (rain), ${spread?.mesh?.name} (spread)`);
check('...the fan throws the same one', spread?.mesh?.name === ord.barrels.asset);
check('...and it tumbles rather than pointing', !rain?.orient && rain?.spin > 0,
  `orient ${!!rain?.orient}, spin ${rain?.spin ?? 0}`);
// THE CANT. A side view renders a cylinder flown flat in the screen plane as a
// rectangle for its whole flight, and it is a rectangle at every angle spin can
// reach — so a tilt of zero here is the difference between a roll of cash and a
// brick, and it looks like nothing at all in the config diff. See the note on
// `tilt` in entities/projectiles.js.
check('...canted out of the screen plane, so it reads as a roll', rain?.mesh?.rotation?.x > 0.2,
  `rotation.x ${(rain?.mesh?.rotation?.x ?? 0).toFixed(2)} rad, from tilt ${ord.barrels.tilt ?? 0}`);
check('the seeker is the other roll', salvo?.mesh?.name === ord.missiles.asset, salvo?.mesh?.name);
check('...and it points where it is going, unlike the drum', !!salvo?.orient && !salvo?.spin);
check('...still homing, still on the seal', !!salvo?.homing && !!salvo?.chase);

// THE THREE SILENT ONES. Each is a name in one file that has to match a key in
// another, with nothing in between to complain when it does not.
const trailed = [ord.barrels.asset, ord.missiles.asset];
check('both rolls have a trail preset to find', trailed.every((k) => !!CONFIG.trails[k]),
  trailed.map((k) => `${k}: ${CONFIG.trails[k] ? 'yes' : 'MISSING'}`).join(', '));
check('...and the emitters those trails name exist',
  trailed.every((k) => {
    const em = CONFIG.trails[k]?.particles?.emitter;
    return !em || !!CONFIG.emitters[em];
  }),
  trailed.map((k) => CONFIG.trails[k]?.particles?.emitter ?? '(none)').join(', '));
check('...and so does the blast burst', !!CONFIG.emitters[ord.barrels.blastEmitter],
  ord.barrels.blastEmitter);

// THE TRAWLER IS UNTOUCHED. gunFor falls through to the shared GUNS table for a
// def that says nothing, and the whole claim of the override is that the other
// hull cannot notice it — a yacht that quietly retuned the trawler's ordnance
// would be the same bug as a subtype that is also a rebalance.
const { seen: drums } = ordnanceOf('bossBoat');
check('the trawler still drops oil drums', drums.get('boss:boatRain')?.mesh?.name === 'bossBarrel',
  drums.get('boss:boatRain')?.mesh?.name);
check('...and fires the plain seeker', drums.get('boss:boatSalvo')?.mesh?.name === 'bossMissile',
  drums.get('boss:boatSalvo')?.mesh?.name);
check('...with nothing spinning', !drums.get('boss:boatRain')?.spin);

console.log(fail ? `\nFAIL — ${fail} check(s)` : '\nPASS');
process.exit(fail ? 1 : 0);
