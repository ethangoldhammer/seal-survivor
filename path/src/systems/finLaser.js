// ============================================================================
// FIN LASERS — the second thing a seal can have instead of pebbles.
//
// This is NOT an upgrade. Every other weapon in the game is something a run
// acquires; this is something a run STARTS as. The seal comes out of the gate
// throwing stones or throwing light, the choice is rolled before the first
// frame, and the gun cards in the pool are written to pay out on whichever one
// it landed on. That is the whole reason it is a loadout and not a conversion
// card: a card has to be balanced against the gun it replaces AND against the
// cards you did not take instead of it, and neither question has an answer this
// early in a run.
//
// THE ROLL AND THE ARITHMETIC ARE NOT HERE — they are in ../loadout.js, a leaf
// module with no imports but CONFIG. See its header for the dependency edge
// that forced the split; the short version is that entities/player.js needs the
// roll and this file needs systems/elements.js, which needs player.js. What is
// left here is everything that needs a scene.
//
// ---------------------------------------------------------------------------
// WHAT MAKES A BOLT A BOLT
//
//   IT IS FAST AND IT IS SHORT. `speedMul` up, `lifeMul` well down, and the
//   product of the two is the RANGE — which is the laser's whole cost. It gets
//   to the fish sooner and it cannot reach the far ones at all. Damage per bolt
//   is the pebble's, untouched: the reach is the price and there is not a
//   second one hidden behind it.
//
//   ...UNTIL THE RUN EARNS THE REACH BACK. Every `reachPerGunStacks` gun cards
//   held is worth a step of range, and none of it is paid until the run has put
//   a boss down. Two axes rather than one on purpose: the stacks are what you
//   chose and the boss is what you survived, and a ramp gated on only one of
//   them is either free or unreachable. See laserReachSteps in ../loadout.js.
//
//   IT SHATTERS. Lattice Sealant: a bolt that lands has a chance to break into
//   several shorter bolts, which can themselves break, down to a generation
//   limit. THE PARENT IS CONSUMED BY THE SPLIT — a bolt that both shattered and
//   carried on through its pierce would be paying twice for one hit, and the
//   picture would not read either.
//
// ---------------------------------------------------------------------------
// WHY THE SPLIT CANNOT GO EXPONENTIAL, stated here because every knob in
// CONFIG.finLaser.lattice looks individually reasonable and their product does
// not. Three guards, and they are independent on purpose — any one of them
// alone is one retune away from being the only thing holding:
//
//   1. CHILDREN THIN PER GENERATION. childrenAt drops one child per generation,
//      floored at 1: a 4-wide first split is 3-wide at the second and 2-wide at
//      the third, rather than 4 x 4 x 4.
//   2. GENERATIONS ARE BOUGHT SLOWLY. Two stacks of pierce per generation, and
//      `generationsMax` is a cap rather than a target.
//   3. THERE IS A HARD LIVE BUDGET. `budget` counts bolts BORN OF A SPLIT that
//      are still in the water, and a split that would cross it is refused
//      whole. This is what holds when 1 and 2 are retuned by somebody who has
//      not read this comment.
//
// Without (1) the count is children^generations — 64 bolts off one pellet,
// several times a second, and the frame budget is gone before the balance is.
// `npm run test:finlaser` asserts the bound rather than the look.
// ============================================================================

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { childrenAt, latticeHasRoom, acquireLatticeChild, resetLattice } from '../loadout.js';
import { ease } from '../ease.js';
import { hdr, glowSprite } from './beams.js';
import { activeElement, elementColor } from './elements.js';

/** The asset a bolt wears. Exported so the trail and the spawn site agree. */
export const LASER_ASSET = 'finLaser';

function cfg() {
  return CONFIG.finLaser ?? {};
}

function look() {
  return cfg().look ?? {};
}

// ---------------------------------------------------------------------------
// THE SHATTER
// ---------------------------------------------------------------------------
//
// The live-child budget itself lives in ../loadout.js — see the note there for
// why a counter two files have to touch could not sit next to the code that
// spends it.

/**
 * Break `b` into its children at `contact`, if the roll says so.
 *
 * Returns TRUE when the caller should consume the parent — a split eats the
 * bolt that made it. FALSE means nothing happened and the shot resolves exactly
 * the way any other shot would, which is the case for every projectile in the
 * game that is not a bolt (they carry no `lattice` payload at all).
 *
 * @param spawn  the spawner, injected so a harness can count what WOULD be
 *               fired without a scene. The game passes spawnProjectile.
 * @param random injectable for the same reason.
 */
export function trySplit(scene, b, contact, spawn, random = Math.random) {
  const pay = b?.lattice;
  if (!pay) return false;
  if (pay.generation >= pay.generations) return false;
  if (random() >= pay.chance) return false;

  const l = cfg().lattice ?? {};
  const n = childrenAt(pay.generation, pay.amount);
  // Guard (3). REFUSED RATHER THAN TRIMMED to whatever fits: half a lattice is
  // a worse picture than none, and a bolt that quietly threw two children when
  // it normally throws four would read as the effect being broken rather than
  // as the budget doing its job.
  if (!latticeHasRoom(n)) return false;

  const spread = l.spreadRad ?? 0.5;
  const base = Math.atan2(b.dir.y, b.dir.x);
  const origin = new THREE.Vector3(
    contact?.x ?? b.mesh.position.x,
    contact?.y ?? b.mesh.position.y,
    0,
  );

  for (let i = 0; i < n; i++) {
    // Fanned about the PARENT'S OWN heading, so the shatter carries on through
    // the body rather than spraying backwards off it. A lone child goes dead
    // ahead rather than off to one side.
    const off = n > 1 ? (i - (n - 1) / 2) * (spread / (n - 1)) * 2 : 0;
    const a = base + off;

    const child = spawn(scene, {
      origin,
      dir: new THREE.Vector2(Math.cos(a), Math.sin(a)),
      faction: 'player',
      damage: b.damage * (l.childDamageMul ?? 0.55),
      speed: b.speed * (l.childSpeedMul ?? 0.9),
      // Shorter every generation — his ask, and also the only thing that keeps
      // a four-wide shatter from filling the screen with full-length bolts. It
      // compounds down the generations because a child reads it off its parent
      // rather than off the config.
      life: b.life * (l.childLifeMul ?? 0.6),
      radius: b.radius * (l.childSizeMul ?? 0.8),
      scale: (b.mesh?.scale?.x ?? 1) * (l.childSizeMul ?? 0.8),
      asset: LASER_ASSET,
      // STILL THE GUN. A child booking its damage anywhere else would split the
      // laser's line in the playtest ledger in two and make both halves look
      // like dead weapons. Same question weaponName.js answers the same way.
      source: 'gun',
      // 'axis', like the bolt that made it — the plain `orient: true` mirror is
      // 90 degrees out on a leftward diagonal and a shard is the same long
      // symmetric oval. See the spawn in main.js and the note in projectiles.js.
      orient: 'axis',
      // Weightless like the bolt that made it. A shard is the same light, and
      // shards are born wherever the parent landed — including well above the
      // waterline, which is the only place the fall applies at all.
      gravityScale: 0,
      // The element rides down the generations with the damage. A shard that
      // lost the fin's element would apply nothing on hit while looking exactly
      // like the bolt that made it.
      finElement: b.finElement,
      finSide: b.finSide,
      pierce: 0,
      lattice: { ...pay, generation: pay.generation + 1 },
    });

    if (!child) continue;
    // Born of a split — for the budget above, and for the despawn hook that
    // gives the slot back.
    child.latticeChild = true;
    acquireLatticeChild();
    // IT MUST NOT RE-HIT WHAT MADE IT. Children are born inside the body the
    // parent just struck, so without the parent's hit set every one of them
    // would land on that same creature on its first frame: a split that did n
    // times the damage to the thing it split on and nothing to anything else,
    // which is the exact opposite of what the effect is for.
    child.hits = new Set(b.hits);
    child.hitLock = l.childHitLock ?? 0.02;
    applyBoltLook(child, b.finElement);
  }
  return true;
}

// ---------------------------------------------------------------------------
// THE LOOK
// ---------------------------------------------------------------------------
//
// COLOUR FOLLOWS THE ELEMENT, which is the one rule this section exists for.
// A bolt is mostly light, so unlike the pebble — a grey stone whose element
// shows only in its ribbon and its sparks — the element has to be IN the body,
// or the weapon and the status it applies are two unrelated colours leaving the
// same fin. The FIN's element beats the run's, in the order the muzzle flash
// already uses and for the same reason: two bolts in one volley can disagree,
// and the one you are looking at should be the one that decides.

/** The colour a bolt off a fin carrying `finElement` should be, as a hex int. */
export function boltColor(finElement = null) {
  const id = finElement ?? activeElement();
  if (id) {
    const c = elementColor(id);
    if (c != null) return c;
  }
  return look().color ?? 0x66e0ff;
}

// ONE MATERIAL PER COLOUR, cached — not a clone per bolt, and emphatically not
// the asset's own. Two traps meet here and the cache is what avoids both.
//
//   TINTING THE ASSET'S MATERIAL tints every bolt on screen at once. Every
//   primitive asset shares one cached material (see getMaterial in assets.js),
//   which is the same trap as fading one bubble and fading all of them.
//
//   CLONING PER SHOT pays an allocation several times a second forever — and
//   worse, a clone DISPOSED on despawn releases the linked program, so the next
//   bolt links the identical shader again from source. That is the churn
//   systems/projectileTrails.js documents at length, measured there at 138
//   rebuilds of one key in a ten-minute run.
//
// The colour space is small and bounded — the base plus one per element — so a
// map keyed on the hex is a handful of materials for the life of the process,
// all sharing a program, and nothing is ever disposed.
//
// AND THE HALO'S RAMP RIDES THE SAME CACHE, which is the whole reason it is
// quantised. A halo that brightens over the flight is a per-bolt value, and the
// obvious way to spend one — a cloned material whose colour is written every
// frame — walks straight into the second trap above. So the brightness is
// rounded to `ramp.steps` levels and folded into the key: the set of glow
// materials is colours x steps, five by twelve today, built once and swapped
// between by reference. A bolt changing brightness costs a pointer write.
const boltMats = new Map();
const glowMats = new Map();

function boltMaterial(hex, overdrive) {
  const key = `${hex}|${overdrive}`;
  let mat = boltMats.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      // PUSHED PAST 1 ON ITS PEAK CHANNEL, which is the only reason a bolt
      // blooms at all. The bright pass thresholds on LUMINANCE, where blue is
      // worth 7% and green 72% — so a cyan bolt authored at a perfectly sane
      // 0.9 never crosses the line and simply does not glow, while a green one
      // at the same number is over it twice. Normalising on the peak is what
      // makes `overdrive` mean the same thing to all four elements. See
      // systems/beams.js, which owns hdr(), and `npm run glow`.
      color: hdr(hex, overdrive),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    boltMats.set(key, mat);
  }
  return mat;
}

function glowMaterial(hex, overdrive) {
  const key = `${hex}|${overdrive}`;
  let mat = glowMats.get(key);
  if (!mat) {
    mat = new THREE.SpriteMaterial({
      map: glowSprite(),
      color: hdr(hex, overdrive),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    glowMats.set(key, mat);
  }
  return mat;
}

/**
 * How far from the bolt's middle its NOSE is, in the root's own local units.
 *
 * MEASURED rather than typed, and none of the three obvious ways to write the
 * number down are right: the asset's `radius * elongate` is the geometry's,
 * before whatever createVisual put between the root and it; `look.length` is a
 * multiplier and not an extent; and a hand-tuned constant stops being the nose
 * the moment either moves.
 *
 * So: the body's bounds in world space, pulled back through the root's own
 * matrix. Box3.applyMatrix4 walks the eight corners, which is exact for a box
 * that is axis-aligned in the space it lands in, and the root's non-uniform
 * scale divides straight back out — which is the whole point. The offset is in
 * PRE-SCALE units, so a child placed at it rides the scale and stays on the
 * nose at any length, width or run-time swell.
 *
 * Art-forward is +Y and `orient` lays that down the flight, so the nose is
 * max.y — the same axis, and the same assumption, as the elongation and the
 * orientation. See the note on the `oval` asset in assets.js.
 *
 * Exported for `npm run test:finlaser`: the headless harness cannot build the
 * halo at all (glowSprite needs a 2D canvas) but it can build the body, so this
 * is the seam that keeps the placement testable rather than only lookable-at.
 */
export function boltTipOffset(mesh) {
  if (!mesh) return 0;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return 0;
  box.applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  return box.max.y;
}

/**
 * Dress a freshly-spawned bolt: colour, proportion, and the halo around it.
 *
 * Called after spawnProjectile rather than inside it because the asset table
 * has no idea what element a run is carrying and must not learn — every other
 * per-shot look in the game (the mussel's swell, the ricochet's size spring) is
 * written onto the mesh the same way.
 *
 * A mesh whose material cannot be replaced — a Node harness, a stub with no GL
 * — is left exactly as it was rather than throwing. The bolt is then the wrong
 * colour and every other thing about the run still works, which is the right
 * failure for a look.
 */
export function applyBoltLook(p, finElement = null) {
  const mesh = p?.mesh;
  if (!mesh) return;
  const lk = look();
  const hex = boltColor(finElement);
  const width = lk.width ?? 1;
  const length = lk.length ?? 1;

  // THE PROPORTION IS A NON-UNIFORM SCALE ON TOP OF WHATEVER THE SHOT ALREADY
  // IS. `scale` at the spawn has already written the asset's own size and the
  // run's pellet size onto all three axes; this stretches the result along Y,
  // which is art-forward — so an `orient: true` bolt lies along its own travel
  // rather than across it. MULTIPLYING rather than setting is what keeps
  // Flippers Up! and the split's size falloff moving a bolt at all: a setScalar
  // here would silently flatten both to the same silhouette.
  const s = mesh.scale;
  mesh.scale.set(s.x * width, s.y * length, s.z * width);

  if (mesh.isMesh) mesh.material = boltMaterial(hex, lk.overdrive ?? 2.2);

  // MEASURED FOR THE HIT TEST TOO, not only the halo below. A bolt is drawn
  // `length`:`width` — 2.6:1 shipped — and the collision radius combat.js
  // gets off spawnProjectile is the PEBBLE's circle: the pebble keeps its hit
  // circle and its drawn size locked together on purpose (see the note on
  // `radius`/`scale` in main.js), and a bolt stretches the mesh well past that
  // circle afterwards without anyone re-measuring it. The result is a beam
  // that visibly reaches a fish while its centre is still a half-body-length
  // short of the circle that decides whether it landed — shots that look like
  // hits and read as misses. combat.js sweeps a SEGMENT along this instead of
  // testing the bolt as a point; see boltHitEnds.
  //
  // Cached in PRE-SCALE units for the same reason boltTipOffset's own doc
  // gives: combat.js runs every frame and only has to multiply by the mesh's
  // current scale, not walk the geometry again.
  p.boltHalfLength = boltTipOffset(mesh);

  // The halo. A SPRITE rather than a second stretched mesh, because it has to
  // read as light spilling off the bolt from every angle — a quad that turned
  // with the body would go edge-on the moment the bolt was fired sideways, and
  // the glow would blink out for a whole heading.
  // WHAT IT LAUNCHED WITH, so the ramp below has a denominator. Kept here
  // rather than read from a `lifeMax` on the projectile record because that
  // field does not exist and adding one would put a laser's business in the
  // shared spawn for every projectile in the game to carry. `??=` and not `=`:
  // redressBolts re-runs this on a bolt already in the air, and re-reading the
  // life there would restart the charge from whatever is left of it.
  p.boltLife ??= p.life;
  // Forget the cached step so the next sweep re-picks a material — the redress
  // has just handed this bolt the base one.
  p.glowStep = -1;

  if ((lk.glow ?? 0) > 0) try {
    // GUARDED, and not defensively. glowSprite() paints its falloff into a 2D
    // canvas context, and a Node harness does not have one (see the dom-stub
    // note) — so this throws from inside three.js in every headless test that
    // spawns a real bolt, and takes the whole run down over a halo. The body is
    // already coloured and proportioned by the time we get here; losing the
    // glow is the right failure for a look, and losing the harness is not.
    const sprite = new THREE.Sprite(
      glowMaterial(hex, (lk.overdrive ?? 2.2) * (lk.glowOverdrive ?? 0.6)),
    );
    // In the BOLT's local space, which is already non-uniformly scaled — so the
    // halo divides that back out and stays round on a body that is deliberately
    // not. Without this the glow is a long smear exactly as elongated as the
    // bolt, which reads as a second, blurrier bolt.
    sprite.scale.set((lk.glow ?? 2) / width, (lk.glow ?? 2) / length, 1);
    sprite.name = 'finLaserGlow';
    // AT THE NOSE. Measured BEFORE the sprite is added, or the halo's own
    // bounds would be in the answer.
    sprite.position.y = boltTipOffset(mesh) * (lk.tip ?? 1);
    mesh.add(sprite);
  } catch { /* no 2D canvas — see above */ }
}

// ---------------------------------------------------------------------------
// THE CHARGE
// ---------------------------------------------------------------------------

/**
 * How bright the halo should be right now, as a fraction of `glowOverdrive`.
 *
 * A pure function of how far through its own life the bolt is, which is what
 * lets it be tested without a scene and what makes a lattice shard run the
 * whole arc inside its much shorter life instead of being born half spent.
 *
 * Exported for `npm run test:finlaser`, which asserts the SHAPE — starts low,
 * peaks where the config says, ends low — rather than any one number, because
 * every number in it is an eye judgement that is allowed to move.
 */
export function boltGlowGain(t, rampCfg = null) {
  const r = rampCfg ?? look().ramp ?? {};
  const from = r.from ?? 0.25;
  const to = r.to ?? 0.1;
  // Held off both ends. At exactly 0 or 1 one of the two legs is a division by
  // zero, and the bolt would spend its whole flight in the other one — a peak
  // pinned to the muzzle reads as no ramp at all rather than as a bug, which is
  // the kind of failure that survives a review.
  const peak = Math.min(0.95, Math.max(0.05, r.peakAt ?? 0.55));
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x <= peak
    ? from + (1 - from) * ease(r.rise ?? 'inExpo', x / peak)
    : 1 + (to - 1) * ease(r.fall ?? 'inExpo', (x - peak) / (1 - peak));
}

/**
 * Ride every live bolt's halo up and back down.
 *
 * Called beside updateProjectiles rather than from inside it: this is one
 * loadout's look and projectiles.js is the shared spawn for every shot in the
 * game, which already carries `orient`, `spin`, gravity and four kinds of
 * steering for everything else. A weapon's own glow does not belong in it.
 *
 * IT ONLY EVER SWAPS A MATERIAL REFERENCE. The brightness is quantised to
 * `ramp.steps` and cached (see the note above the cache), so a frame in which
 * nothing has crossed a step boundary does no work at all beyond the arithmetic
 * — which matters, because at a laser's cadence with a lattice in the water
 * this is the widest loop in the loadout.
 */
export function updateBoltGlow(projectiles = []) {
  const lk = look();
  if (!((lk.glow ?? 0) > 0)) return;
  const r = lk.ramp ?? {};
  const steps = Math.max(1, Math.round(r.steps ?? 12));
  const od = (lk.overdrive ?? 2.2) * (lk.glowOverdrive ?? 0.6);

  // ONE GUARD FOR THE WHOLE SWEEP, on the same grounds as the one in
  // applyBoltLook and not one per bolt. A brightness the cache has not seen
  // before builds a material, which builds the sprite texture, which needs a 2D
  // canvas — so in a harness this throws, and it throws from inside the frame
  // loop rather than once at the spawn. Bailing out of the sweep is right
  // because the next bolt would fail identically: there is no canvas, there
  // will never be a halo, and the run should carry on without one.
  try {
  for (const p of projectiles) {
    if (p?.asset !== LASER_ASSET || !p.mesh) continue;
    const sprite = p.mesh.getObjectByName('finLaserGlow');
    if (!sprite) continue;
    // A bolt with no launch life on it — one spawned by something that never
    // went through applyBoltLook — is left at full rather than dividing by
    // zero into a NaN colour, which renders as a black sprite and looks like
    // the halo being deleted.
    const span = p.boltLife;
    if (!(span > 0)) continue;
    const t = 1 - p.life / span;
    const step = Math.round(boltGlowGain(t, r) * steps);
    if (step === p.glowStep) continue;
    p.glowStep = step;
    sprite.material = glowMaterial(boltColor(p.finElement), od * (step / steps));
  }
  } catch { /* no 2D canvas — see above */ }
}

/**
 * Where the bolt's own nose and tail sit in world space right now — the
 * segment combat.js should sweep instead of testing the bolt as a point.
 *
 * See the note in applyBoltLook: `boltHalfLength` is the measured half-length
 * in pre-scale units, so this only multiplies by the mesh's CURRENT scale
 * (which already carries `look.length`, Flippers Up!, and the split's own
 * falloff) rather than remeasuring the geometry — this runs in combat's
 * hottest loop, once per live bolt per frame.
 *
 * `b.dir` stands in for the mesh's own local +Y in world space rather than
 * reading it off the rotation matrix: `orient: 'axis'` is what puts the mesh
 * there in the first place, so the two already agree, and trySplit's own
 * fan-out leans on the same assumption.
 *
 * A bolt with nothing cached (never dressed — a stub in a harness, or a shot
 * that isn't a laser at all) collapses to the point it already was, so the
 * caller can use this unconditionally without a fallback branch of its own.
 */
export function boltHitEnds(b, out) {
  const mesh = b?.mesh;
  const x = mesh?.position.x ?? 0;
  const y = mesh?.position.y ?? 0;
  const half = b?.boltHalfLength;
  if (!mesh || !b?.dir || !(half > 0)) {
    out.ax = out.bx = x;
    out.ay = out.by = y;
    return out;
  }
  const reach = half * mesh.scale.y;
  const dx = b.dir.x * reach;
  const dy = b.dir.y * reach;
  out.ax = x + dx; out.ay = y + dy;
  out.bx = x - dx; out.by = y - dy;
  return out;
}

/**
 * Re-dress every bolt already in the water.
 *
 * The F menu's channel onto shots that are ALREADY FLYING. Without it a slider
 * only reaches the next bolt fired, which at a laser's cadence means judging a
 * length change against a screen still half full of the old one — the exact
 * thing the workbench exists to stop.
 *
 * It rebuilds from the LAUNCH scale rather than multiplying the live one, for
 * the reason launchDamage exists on every projectile: applyBoltLook writes the
 * proportion into the scale in place, so re-applying it to an already-dressed
 * bolt would compound, and a slider dragged for a second would leave a bolt a
 * hundred times its own length.
 */
export function redressBolts(projectiles = []) {
  for (const p of projectiles) {
    if (p?.asset !== LASER_ASSET || !p.mesh) continue;
    const glow = p.mesh.getObjectByName('finLaserGlow');
    if (glow) p.mesh.remove(glow);
    const base = p.launchScale ?? 1;
    p.mesh.scale.setScalar(base * (p.sizeMul ?? 1));
    applyBoltLook(p, p.finElement);
  }
}

/** Drop the cached materials. Called with the rest of the run's teardown. */
export function disposeFinLaser() {
  // FORGOTTEN, NOT DISPOSED — see the cache note above. Disposing here would
  // release the programs and make the next run link them again from source,
  // which is the exact churn the shared trail material was fixed for.
  boltMats.clear();
  glowMats.clear();
  resetLattice();
}

/**
 * The colours the F menu previews — the base plus one per element.
 *
 * Here rather than in the panel so the swatches cannot disagree with the bolts:
 * both read boltColor, so a preview showing the wrong colour is a bug in one
 * function rather than a drift between two.
 */
export function boltPalette() {
  // The base colour READ DIRECTLY, not through boltColor — that function falls
  // through to the run's element when asked for "no element", which is right
  // for a bolt and wrong for a swatch labelled "no element".
  const out = [{ id: null, color: look().color ?? 0x66e0ff }];
  for (const id of Object.keys(CONFIG.biolum?.elements ?? {})) {
    out.push({ id, color: elementColor(id) });
  }
  return out;
}
