import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { bounds } from '../arena.js';
import { emit } from '../entities/particles.js';
import { makeOutlineMaterial } from '../assets.js';
import { attachDissolve, dissolveUniforms, roundedNormalBox } from './dissolve.js';
import { spawnXpOrb, spawnStrikeOrb, spawnBubbleOrb, spawnRapidFireOrb } from '../entities/pickups.js';

// What's left of a hull that lost. A destroyed boat used to be removed from
// the scene on the frame it died, so the biggest target in the game vanished
// with less ceremony than a minnow. Now it comes apart into chunks that are
// thrown clear of the water, sink, and dissolve.
//
// THE CHUNKS ARE GENERIC, NOT CUT FROM THE MODEL. Slicing the real geometry
// was tried first and looks wrong for a reason that can't be tuned away: these
// hulls are open shells, so a cut chunk is hollow, and every cut edge is a
// sawtooth of half-triangles with the inside of the boat showing through it.
// Only a chunk that happened to be a closed form (the bow) survived it.
// Instead the hull is MEASURED — its surface area is dropped into a coarse
// grid — and each well-covered cell becomes a box. Cells too sparse to be a
// real surface (rigging, cables, stray fittings) are culled rather than
// spawning a chunk out of thin air.
//
// The result is the boat's silhouette at the instant it breaks, in the boat's
// own colour and rim, made of shapes that have no bad angle to look at.
//
// Nothing is ever thrown DOWNWARD: a chunk driven into the water on the frame
// of the explosion is a chunk nobody sees. Every one leaves with an upward
// velocity, arcs, and only then falls back in — at which point the water takes
// over and it sinks to the seabed like the chum does.

export const boatDebris = [];

// assetKey -> the grid of chunks measured off that hull, built the first time
// a boat of that kind spawns. Measuring means walking every triangle, which is
// identical for every boat of the same model, so it happens once per session
// rather than once per explosion — see primeBoatDebris.
const cellCache = new Map();

// Water entry fires a splash, and chunks thrown together tend to land
// together. One cooldown shared by all of them keeps a wreck going in from
// stacking bursts on the same spot.
let splashCooldown = 0;

function cfg() {
  return CONFIG.boats.debris ?? {};
}

// ---------------------------------------------------------------------------
// Measuring the hull
// ---------------------------------------------------------------------------

// Which loaded model these chunks were measured from, and at what size. A
// model uploaded over `boat` or `trawler` at runtime builds a fresh template
// with fresh geometry, and the cached chunks of the old one would then be
// debris from a boat that is no longer on screen. The tuner's Size slider
// counts too, since chunk sizes are absolute.
function stampOf(root, scale) {
  let stamp = null;
  root.traverse((o) => {
    if (stamp || o.userData.__crew || !o.isMesh || !o.geometry) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    stamp = `${o.geometry.uuid}|${mat?.uuid ?? 'none'}`;
  });
  return `${stamp}@${scale.toFixed(4)}`;
}

// Every mesh in the visual, its geometry baked into the ROOT's local space, so
// the measurements come out in the frame the wrapper lives in. Baking relative
// to the root rather than to the world is what lets the result be cached: the
// boat's position and heading change, its shape doesn't.
function bakedParts(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const parts = [];
  root.traverse((o) => {
    // The crew stand ON the boat as children of it (see systems/crew.js), and
    // a wreck made partly of fisherman is not the wreck we want.
    if (o.userData.__crew) return;
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    local.multiplyMatrices(inv, o.matrixWorld);
    const geometry = o.geometry.clone().applyMatrix4(local);
    geometry.computeBoundingBox();
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    parts.push({
      geometry,
      material: mat,
      isOutline: !!(o.userData.__isOutline || mat?.userData?.__isOutline),
      // The rim width this shell pushes by, converted out of the mesh's own
      // object space into the wrapper's — the shader offsets before any of
      // these matrices apply, so the number means nothing until it is scaled.
      // Hand-typing a world-space rim instead would be wrong on every model
      // whose fit scale isn't 1, which is all of them.
      localScale: local.getMaxScaleOnAxis(),
    });
  });
  return parts;
}

function triangleVertex(geo, t, v, out) {
  const i = geo.index ? geo.index.getX(t * 3 + v) : t * 3 + v;
  return out.fromBufferAttribute(geo.attributes.position, i);
}

// Drop the hull's surface area into a 2D grid over its two longest axes, and
// keep the cells with enough of it to be a real surface. Area, not vertex
// count: a cable is drawn with plenty of vertices and covers nothing, and it
// is exactly the kind of thing that must not become a flying box.
function measureCells(parts, opts) {
  const hull = new THREE.Box3();
  for (const p of parts) if (!p.isOutline) hull.union(p.geometry.boundingBox);
  // Nothing but outline shells, or nothing at all — an empty box measures as
  // ±Infinity and would turn every number below into NaN.
  if (hull.isEmpty()) return [];
  const size = hull.getSize(new THREE.Vector3());
  const order = ['x', 'y', 'z'].sort((a, b) => size[b] - size[a]);
  const [A, B, C] = order;
  const cell = Math.max(size[A] * opts.chunkFraction, 1e-3);
  const depth = Math.min(cell, Math.max(size[C], 1e-3));
  const cellArea = cell * cell;

  const grid = new Map();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (const part of parts) {
    if (part.isOutline) continue; // the rim is a copy of a surface already counted
    const geo = part.geometry;
    const count = Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
    for (let t = 0; t < count; t++) {
      triangleVertex(geo, t, 0, a);
      triangleVertex(geo, t, 1, b);
      triangleVertex(geo, t, 2, c);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area = cross.crossVectors(ab, ac).length() * 0.5;
      if (!(area > 0)) continue;
      // A triangle bigger than a cell has to be spread over the cells it
      // actually covers — dropping all of it on the centroid's cell is how a
      // long deck plank turns into one dense cell and a row of empty ones.
      const samples = Math.min(24, Math.max(1, Math.ceil(area / cellArea)));
      const share = area / samples;
      for (let s = 0; s < samples; s++) {
        let u = Math.random();
        let v = Math.random();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        p.copy(a).addScaledVector(ab, u).addScaledVector(ac, v);
        const ia = Math.floor(p[A] / cell);
        const ib = Math.floor(p[B] / cell);
        const key = ia * 73856093 ^ ib * 19349663;
        const found = grid.get(key);
        if (found) found.area += share;
        else grid.set(key, { ia, ib, area: share });
      }
    }
  }

  const keep = [...grid.values()]
    .filter((g) => g.area >= cellArea * opts.minCoverage)
    .sort((x, y) => y.area - x.area)
    .slice(0, opts.maxChunks);

  const centreC = (hull.min[C] + hull.max[C]) / 2;
  return keep.map((g) => {
    const centre = new THREE.Vector3();
    centre[A] = (g.ia + 0.5) * cell;
    centre[B] = (g.ib + 0.5) * cell;
    centre[C] = centreC;
    return { centre, cell, depth, axes: [A, B, C] };
  });
}

// The look the chunks inherit: the hull's own colour and its rim, so a boat
// re-tinted in the T panel breaks apart in the colour it was wearing.
function hullLook(parts) {
  const body = parts.find((p) => !p.isOutline)?.material ?? null;
  const shell = parts.find((p) => p.isOutline);
  const thickness = shell?.material?.userData?.__outlineThickness?.value ?? 0;
  return {
    color: body?.color ? body.color.getHex() : 0x0a1018,
    outlineColor: shell?.material?.color ? shell.material.color.getHex() : null,
    // Into the wrapper's space; the caller scales it the rest of the way out.
    outlineThickness: thickness * (shell?.localScale ?? 1),
  };
}

function buildCells(root, assetKey, scale) {
  const stamp = stampOf(root, scale);
  const cached = cellCache.get(assetKey);
  if (cached && cached.stamp === stamp) return cached;

  const c = cfg();
  const parts = bakedParts(root);
  if (!parts.length) return null;

  const cells = measureCells(parts, {
    chunkFraction: c.chunkFraction ?? 0.12,
    minCoverage: c.minCoverage ?? 0.12,
    maxChunks: Math.max(1, Math.round(c.maxChunks ?? 26)),
  });
  const look = hullLook(parts);
  for (const part of parts) part.geometry.dispose();
  if (!cells.length) return null;

  // Out of the wrapper's space and into the world, once, here: every chunk is
  // then built at its true size, which is what lets one rim width be correct
  // for all of them (the shader pushes in object space).
  for (const cellSpec of cells) {
    cellSpec.centre.multiplyScalar(scale);
    cellSpec.cell *= scale;
    cellSpec.depth *= scale;
  }
  look.outlineThickness *= scale;

  const entry = { stamp, cells, look };
  cellCache.set(assetKey, entry);
  return entry;
}

// The proportions a chunk can come out as, relative to its cell. Boxes all cut
// to the same die read as boxes; a wreck should be planking, panels, posts and
// blocks. Each is jittered per axis on top, so no two are the same brick even
// within a form.
const FORMS = [
  [1.00, 0.85, 0.75], // block — the odd solid lump
  [1.75, 0.34, 0.62], // plank — decking, gunwale, spar
  [0.36, 1.55, 0.52], // post — mast section, stanchion
  [1.30, 0.70, 0.30], // panel — hull plate, cabin wall
  [0.62, 0.58, 0.55], // splinter — small, roughly even
];

// One chunk of wreckage: a box in one of the forms above, at `size`, wearing
// the wreck's materials. Used both for the initial break and for the smaller
// pieces a chunk shatters into when it's shot.
function makeChunk(kit, size, jitter, cap = Infinity) {
  const form = FORMS[(Math.random() * FORMS.length) | 0];
  const vary = () => 1 - jitter * 0.5 + Math.random() * jitter;
  let w = size * form[0] * vary();
  let h = size * form[1] * vary();
  let d = size * form[2] * vary();
  // A fragment has to be SMALLER than what it came off, and `size` alone
  // doesn't guarantee that: the plank form is 1.75x its cell along one axis,
  // so a plank cut from a plank could come out longer than its parent.
  const longest = Math.max(w, h, d);
  if (longest > cap) {
    const fit = cap / longest;
    w *= fit; h *= fit; d *= fit;
  }
  const geometry = roundedNormalBox(w, h, d);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, kit.body));
  if (kit.shell) {
    const rim = new THREE.Mesh(geometry, kit.shell);
    rim.renderOrder = -1;
    group.add(rim);
  }
  // The longest edge, which is what "how big is this chunk" means everywhere
  // else — the hit radius, the shatter floor, how much hp it has.
  return { group, geometry, extent: Math.max(w, h, d) };
}

// Pay the measurement at spawn instead of at death. A boat is on screen for
// several seconds before anything can kill it, and the alternative is a frame
// hitch on the exact frame the explosion is supposed to look good.
export function primeBoatDebris(root, assetKey) {
  const c = cfg();
  if (c.enabled === false) return;
  try {
    buildCells(root, assetKey, root.scale.x || 1);
  } catch (err) {
    console.warn('[boats] could not measure debris for', assetKey, err);
  }
}

// Break `boat` apart where it floats. Returns true if anything was thrown —
// false means the caller should just remove the hull as before.
export function spawnBoatDebris(scene, boat) {
  const c = cfg();
  if (c.enabled === false) return false;

  let measured = null;
  try {
    measured = buildCells(boat.mesh, boat.assetKey, boat.mesh.scale.x || 1);
  } catch (err) {
    console.warn('[boats] could not measure debris for', boat.assetKey, err);
    return false;
  }
  if (!measured) return false;

  const { cells, look } = measured;
  boat.mesh.updateMatrixWorld(true);
  const origin = boat.mesh.position;
  const spin = c.spin ?? 5;
  const jitter = c.sizeJitter ?? 0.35;
  const tilt = c.tilt ?? 0.35;

  // One set of materials per explosion, so this wreck can dissolve on its own
  // clock without touching the boats still afloat — which is the whole reason
  // the old version shrank instead of fading: the hull's materials are shared
  // with every other boat of its kind, and opacity written there dissolves
  // all of them.
  const uniforms = dissolveUniforms(cells[0].cell, c.dissolveCells ?? 6);
  const body = attachDissolve(
    new THREE.MeshBasicMaterial({ color: look.color }), uniforms, 'boatDebrisBody',
  );
  const shell = look.outlineColor == null ? null : attachDissolve(
    makeOutlineMaterial({ color: look.outlineColor, thickness: look.outlineThickness }),
    uniforms, 'boatDebrisRim',
  );
  const kit = { uniforms, body, shell, refs: 0 };

  for (const spec of cells) {
    const chunk = makeChunk(kit, spec.cell, jitter);
    const { group } = chunk;

    // Where this chunk sat in the boat, carried out to where the boat is —
    // heading included, so a hull sailing left breaks up left-handed.
    const offset = spec.centre.clone().applyQuaternion(boat.mesh.quaternion);
    group.position.copy(origin).add(offset);
    // A small random tilt, not a random orientation: at the instant of the
    // break the chunks still have to add up to a boat.
    group.rotation.set(
      (Math.random() - 0.5) * tilt,
      (Math.random() - 0.5) * tilt,
      Math.random() * Math.PI * 2 * (c.yawFree ?? 0.12) + (Math.random() - 0.5) * tilt,
    );
    scene.add(group);

    const len = Math.hypot(offset.x, offset.y) || 1;
    const out = (c.outSpeed ?? 7) * (0.75 + Math.random() * 0.5);

    addChunk(kit, chunk, {
      // Thrown away from the hull's centre, plus a share of the speed the boat
      // was already making — a hull dies mid-voyage, and pieces that forget
      // that hang oddly in place — plus a little scatter, without which the
      // chunks amidships (which have no outward direction to speak of) go
      // straight up every single time.
      vx: (offset.x / len) * out + boat.dir * boat.speed * (c.carry ?? 0.6)
        + (Math.random() - 0.5) * (c.scatter ?? 2.5),
      // ALWAYS up. `abs` rather than the real sign is the whole trick: a chunk
      // from below the waterline is thrown up out of the water like the rest
      // of them, instead of being buried on the frame it was born.
      vy: Math.abs(offset.y / len) * out + (c.upSpeed ?? 6.5) * (0.7 + Math.random() * 0.6),
      spin,
    });
  }

  trim(scene);
  return true;
}

// Put a built chunk into the world with its throw. Shared by the initial break
// and by the shatter, so a fragment behaves like a small piece of wreckage
// rather than like a second kind of object.
function addChunk(kit, chunk, motion) {
  const c = cfg();
  const spin = motion.spin ?? c.spin ?? 5;
  kit.refs++;
  const d = {
    group: chunk.group,
    geometry: chunk.geometry,
    extent: chunk.extent,
    kit,
    vx: motion.vx,
    vy: motion.vy,
    // Mostly about the view axis — this is a side-on game, and a tumble in the
    // other two only ever reads as the chunk flickering edge-on.
    av: new THREE.Vector3(
      (Math.random() - 0.5) * spin * 0.4,
      (Math.random() - 0.5) * spin * 0.4,
      (Math.random() - 0.5) * spin * 2,
    ),
    // Bigger chunks take more killing. Proportional to extent rather than flat,
    // so a splinter pops off one pellet and a hull panel takes a burst.
    hp: (c.chunkHp ?? 6) * Math.max(0.4, chunk.extent / Math.max(c.hpAtExtent ?? 1, 1e-3)),
    // Stops one overlapping shot (or a dash sitting on top of a chunk) from
    // spending every point of its damage on the same frame.
    invuln: 0,
    life: 0,
    // Below the water line already (a keel chunk) — it's on its way UP out of
    // the water, and breaking the surface from underneath isn't a splash.
    wet: chunk.group.position.y < bounds.surfaceY,
  };
  boatDebris.push(d);
  return d;
}

// Oldest first, so a run that stacks explosions sheds the chunks that have
// already had their moment.
function trim(scene) {
  const maxAlive = cfg().maxAlive ?? 72;
  while (boatDebris.length > maxAlive) dispose(scene, boatDebris.shift());
}

// Take a chunk out by IDENTITY, never by a remembered index. Shattering can
// add fragments and trim the oldest chunks off the front in the same breath,
// so an index captured a moment ago may point at somebody else by the time it
// is used — which is how a chunk once ended up spliced out of the list while
// its mesh stayed in the scene for the rest of the run.
function removeChunk(scene, d) {
  const i = boatDebris.indexOf(d);
  if (i === -1) return false;
  boatDebris.splice(i, 1);
  dispose(scene, d);
  return true;
}

function dispose(scene, d) {
  scene.remove(d.group);
  d.geometry.dispose();
  // The materials outlive the individual chunk — they belong to the whole
  // wreck — so they go only with the last chunk of it.
  if (--d.kit.refs <= 0) {
    d.kit.body.dispose();
    d.kit.shell?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shooting the wreckage
// ---------------------------------------------------------------------------

// What was in the crate. Weighted, and each entry checks the system it feeds
// is actually switched on — a rapid-fire orb dropping into a run with the
// pickup disabled is an orb that does nothing when you swim over it.
function rollDrop(scene, x, y) {
  const table = cfg().drops ?? {};
  const options = [
    ['rapidFire', table.rapidFire ?? 1, CONFIG.rapidFirePickup?.enabled !== false],
    ['strike', table.strike ?? 1.4, CONFIG.strike?.enabled !== false],
    ['bubble', table.bubble ?? 1.2, CONFIG.oxygen?.enabled !== false],
    ['chum', table.chum ?? 3, true],
  ].filter(([, weight, live]) => live && weight > 0);
  if (!options.length) return null;

  let roll = Math.random() * options.reduce((sum, [, w]) => sum + w, 0);
  let pick = options[options.length - 1][0];
  for (const [name, weight] of options) {
    roll -= weight;
    if (roll <= 0) { pick = name; break; }
  }

  const at = new THREE.Vector3(x, y, 0);
  if (pick === 'rapidFire') spawnRapidFireOrb(scene, at);
  else if (pick === 'strike') spawnStrikeOrb(scene, at);
  else if (pick === 'bubble') spawnBubbleOrb(scene, at);
  else {
    // Chum comes as a little scatter rather than one orb, thrown the way the
    // boat's own catch is (see damageBoat) so it falls and sinks the same.
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      spawnXpOrb(scene, at.clone(), CONFIG.boats.chumXp, 0.8, {
        x: (Math.random() - 0.5) * 4,
        y: (Math.random() - 0.5) * 2,
      });
    }
  }
  return pick;
}

// A chunk that's been broken open: it comes apart into smaller pieces thrown
// off the break, and now and then there was something inside it. Pieces below
// `shatterFloor` just go — a box that keeps halving forever ends up as a cloud
// of specks that costs more to draw than it is worth looking at.
function shatterChunk(scene, d, dirX, dirY, hooks) {
  const c = cfg();
  const pos = d.group.position;
  emit('sparks', pos.x, pos.y, { scale: 0.5, dirX, dirY });

  const floor = (c.shatterFloor ?? 0.34) * (d.rootExtent ?? d.extent);
  if (d.extent * (c.shatterScale ?? 0.55) >= floor) {
    const count = Math.max(0, Math.round(c.shatterPieces ?? 2));
    for (let i = 0; i < count; i++) {
      const shrunk = d.extent * (c.shatterScale ?? 0.55);
      const piece = makeChunk(d.kit, shrunk, c.sizeJitter ?? 0.35, shrunk);
      piece.group.position.copy(pos);
      piece.group.rotation.copy(d.group.rotation);
      scene.add(piece.group);
      // Off the break, mostly along the shot, and keeping some of what the
      // parent was already doing.
      const angle = Math.random() * Math.PI * 2;
      const kick = c.shatterSpeed ?? 4;
      const child = addChunk(d.kit, piece, {
        vx: d.vx * 0.5 + Math.cos(angle) * kick + dirX * kick * 0.5,
        vy: d.vy * 0.5 + Math.sin(angle) * kick + dirY * kick * 0.5,
      });
      // Fragments inherit the parent's clock rather than restarting it, or a
      // wreck shot at the last second would leave pieces hanging around long
      // after everything else went.
      child.life = d.life;
      child.rootExtent = d.rootExtent ?? d.extent;
    }
  }

  // Something was stowed in it. Deliberately a small chance: the wreckage is a
  // bonus for shooting at scenery, not a reason to farm it.
  if (Math.random() < (c.dropChance ?? 0.18)) {
    rollDrop(scene, pos.x, pos.y);
    hooks.onDebrisDrop?.(pos.x, pos.y);
  }

  removeChunk(scene, d);
  trim(scene);
}

// Anything that reaches into the water — a bullet, a splash, the dash — asks
// here. `radius` is the attack's own reach; each chunk adds its own
// half-extent, so a hull panel is hit where it looks like it should be.
//
// `opts.single` is the difference between a bullet and a blast: a bullet
// spends itself on the ONE chunk it hit (the nearest), a splash takes
// everything it covers. Without it a pellet landing between two chunks quietly
// dealt full damage to both.
//
// Returns how many chunks were struck, so the caller can decide whether the
// shot was consumed — a bullet that hits wreckage should stop, like it does on
// a hull.
export function damageDebris(scene, x, y, radius, damage, opts = {}) {
  if (!boatDebris.length || !(damage > 0)) return 0;

  const struck = [];
  let nearest = null;
  let nearestD2 = Infinity;
  for (const d of boatDebris) {
    if (d.invuln > 0) continue;
    const dx = d.group.position.x - x;
    const dy = d.group.position.y - y;
    const d2 = dx * dx + dy * dy;
    const reach = radius + d.extent * 0.5;
    if (d2 > reach * reach) continue;
    if (opts.single) {
      if (d2 < nearestD2) { nearestD2 = d2; nearest = d; }
    } else {
      struck.push(d);
    }
  }
  if (nearest) struck.push(nearest);
  if (!struck.length) return 0;

  const knock = cfg().hitKnock ?? 3.5;
  for (const d of struck) {
    const pos = d.group.position;
    const dx = pos.x - x;
    const dy = pos.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;

    d.hp -= damage;
    d.invuln = cfg().hitInvuln ?? 0.12;

    if (d.hp > 0) {
      // Survived: knocked off its course and set spinning, so a chunk you are
      // shooting at is visibly taking it.
      d.vx += dirX * knock;
      d.vy += dirY * knock;
      d.av.z += (Math.random() - 0.5) * knock;
      emit('sparks', pos.x, pos.y, { scale: 0.25, dirX, dirY });
      opts.onDebrisHit?.(pos.x, pos.y);
      continue;
    }
    shatterChunk(scene, d, dirX, dirY, opts);
    opts.onDebrisBroken?.(pos.x, pos.y);
  }
  return struck.length;
}

// The hull going up. Everything still in the air gets shoved away from the
// blast — called by damageBoat so the explosion that throws the crew throws
// the wreckage with it.
export function blastDebris(x, y, radius, strength) {
  for (const d of boatDebris) {
    const dx = d.group.position.x - x;
    const dy = d.group.position.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) continue;
    // Linear falloff, and never downward — same rule as the break itself.
    const push = strength * (1 - dist / Math.max(radius, 1e-3));
    const len = dist || 1;
    d.vx += (dx / len) * push;
    d.vy += Math.abs(dy / len) * push * 0.6 + push * 0.5;
    d.av.z += (Math.random() - 0.5) * push;
  }
}

export function updateBoatDebris(dt, scene) {
  // Ahead of the early-out: a cooldown left over from the last wreck would
  // otherwise sit there forever and eat the first splash of the next one.
  splashCooldown = Math.max(0, splashCooldown - dt);
  if (!boatDebris.length) return;
  const c = cfg();
  const life = c.life ?? 6.5;
  const fade = c.fade ?? 1.4;
  const floor = bounds.bottom + 0.6;

  for (let i = boatDebris.length - 1; i >= 0; i--) {
    const d = boatDebris[i];
    d.life += dt;
    if (d.invuln > 0) d.invuln -= dt;
    const pos = d.group.position;
    const underwater = pos.y < bounds.surfaceY;

    // Crossing the line downward is a splash — tracked as a state rather than
    // a one-shot latch, so a chunk thrown clear of the water and back in again
    // splashes on the way in each time.
    if (underwater && !d.wet && d.vy < 0 && splashCooldown <= 0) {
      emit('splash', pos.x, bounds.surfaceY, { scale: c.splashScale ?? 0.4, dirX: 0, dirY: 1 });
      splashCooldown = c.splashGap ?? 0.06;
    }
    d.wet = underwater;

    if (underwater) {
      // The water eats the throw, then the chunk just sinks — the same slow
      // drift down the chum makes, so the whole wreck settles as one.
      const drag = Math.exp(-(c.waterDrag ?? 3.6) * dt);
      d.vx *= drag;
      d.vy *= drag;
      d.vy = Math.max(d.vy - (c.waterGravity ?? 5) * dt, -(c.sinkSpeed ?? 1.4));
      d.av.multiplyScalar(Math.exp(-(c.spinDamp ?? 1.8) * dt));
    } else {
      // In the air a chunk of hull is in free fall like everything else up
      // there — same number as the seal and the shells, from arena.gravity.
      d.vy -= CONFIG.arena.gravity * dt;
    }

    pos.x += d.vx * dt;
    pos.y += d.vy * dt;
    if (pos.y < floor) {
      pos.y = floor;
      d.vy = 0;
      d.vx *= Math.exp(-6 * dt);
      d.av.multiplyScalar(Math.exp(-6 * dt));
    }

    d.group.rotateX(d.av.x * dt);
    d.group.rotateY(d.av.y * dt);
    d.group.rotateZ(d.av.z * dt);

    // Eaten away by the noise rather than shrunk. One uniform for the whole
    // wreck: the chunks still go at visibly different moments, because each
    // one is sampling a different part of the field.
    const left = life - d.life;
    if (left < fade) {
      d.kit.uniforms.uDissolve.value = Math.min(1, Math.max(0, 1 - left / fade));
    }

    if (d.life >= life) {
      dispose(scene, d);
      boatDebris.splice(i, 1);
    }
  }
}

export function resetBoatDebris(scene) {
  for (const d of boatDebris) dispose(scene, d);
  boatDebris.length = 0;
  splashCooldown = 0;
}
