// ---------------------------------------------------------------------------
// THE ARRIVAL, PAID FOR IN ADVANCE
// ---------------------------------------------------------------------------
// A boss arrival is the single most expensive frame the game ever renders, and
// it is expensive for reasons the boot warm-up deliberately does not cover:
//
//   THE BODY      A boss body has never been cloned before, so the arrival
//                 frame pays a full skeletonClone. Measured on the real files
//                 (tools/boss-entrance-probe.mjs): 16ms for the orca bull,
//                 14ms for the anglerfish, 11ms for the megalodon. Ordinary
//                 creatures do not pay this — after the first of a species the
//                 visual pool has one waiting — but a boss appears once every
//                 five levels and is always the first of its kind.
//
//   THE SKELETON  ...and the clone brings one GPU allocation per skinned mesh
//                 that nothing else in the game shares: the bone texture, which
//                 three builds lazily inside the first render. Ten of them on
//                 the giant squid. This was the half that survived a first
//                 attempt at this file — the maps were warm, the arrival still
//                 uploaded, and only counting uploads in a real context found
//                 it. See collectTextures.
//
//   THE TEXTURES  This is the big one. systems/shaderWarmup.js warms programs
//                 and deliberately does NOT upload textures, and its reasoning
//                 is sound: the roster carries 49 megapixels, an initTexture
//                 sweep makes all of it resident from boot, and past a device's
//                 budget that does not fail — it PAGES, which is continuous
//                 hitching instead of one stall, on every device rather than
//                 the slow ones. But that is an argument about the whole roster
//                 at boot. The boss bodies are the heaviest textures in the
//                 game and every byte of one arrives on the frame it first
//                 draws:
//
//                     anglerfish   4 x 2048^2   16.8 MPx   ~89MB
//                     megalodon    7 x 1024^2    7.3 MPx   ~39MB
//                     giant squid  6 x 1024^2    6.3 MPx   ~34MB
//                     king crab    3 x 1024^2    3.1 MPx   ~17MB
//
//                 Warming ONE of those, three seconds before it is needed, is
//                 the opposite trade from the sweep the boot warm-up refused:
//                 nothing extra is resident for any longer than it is about to
//                 be used, and it is released back to the pool when the fight
//                 ends. 89MB for the length of one fight is a cost; 223MB for
//                 the length of the session, for eight bosses that will not all
//                 appear, is the paging bug.
//
//   THE EXTRAS    The yacht's guests are the clearest case. systems/crew.js
//                 builds its bodies AND its materials on attach — a
//                 MeshBasicMaterial with the dissolve shader injected into it,
//                 which is a material configuration that exists nowhere in
//                 ASSETS and so is reached by nothing at boot. Two programs
//                 link on the frame a yacht arrives, plus two to four humanoid
//                 rigs.
//
// THE HUSH IS THE WINDOW, AND IT ALREADY EXISTS. For three seconds before
// every arrival the spawner is stopped dead and the ocean empties itself (see
// THE HELD BREATH in systems/boss.js). Nothing is being created during it and
// the player is watching an empty sea. That is roughly 180 frames of known,
// unpressured lead time immediately in front of the frame that used to pay for
// everything — so the only change this needed on the boss's side was deciding
// WHICH boss at the start of the hush rather than at the end of it.
//
// ONE STEP PER FRAME, and that is the whole scheduling policy. A 2048-square
// upload is milliseconds on its own; four of them plus a clone plus a compile
// in one tick would simply move the hitch three seconds earlier, which is not
// a fix, it is a different frame to complain about. The queue below does one
// unit of work per call and is sized so the longest boss in the roster
// finishes in well under a second of the three it is given.
//
// IT MUST BE ABLE TO DO NOTHING. There is no renderer in a Node harness and no
// post pipeline before boot finishes, and a boss that arrives un-warmed is
// exactly the game we had before this file. Every entry point is a no-op until
// `installBossWarmup` has been called, and every step is wrapped — a warm-up
// that throws must never be able to stop a boss arriving.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { acquireVisual, releaseVisual } from '../assets.js';

// The compile/upload context, handed over by main.js once the pipeline exists.
// Null everywhere else, which is what makes this file inert in a harness.
let ctx = null;

// The queue for the arrival currently being prepared. Null when nothing is
// pending, which is almost all of the time.
let job = null;

/**
 * Hand over the pipeline. Called once from main.js, right after the boot
 * warm-up — the same three things post.warm needs, for the same reasons (see
 * the cache-key note on post.warm: a compile against the wrong render target
 * or a scene with the wrong lights builds a program the game never asks for).
 */
export function installBossWarmup({ post, scene, camera } = {}) {
  ctx = post && scene && camera ? { post, scene, camera } : null;
}

/** Diagnostics: is there a pipeline to warm against? */
export function bossWarmupReady() {
  return !!ctx;
}

// Every texture hanging off a material, in the slots three will upload on a
// first draw. Deduplicated by SOURCE rather than by texture object: two
// Texture instances over one Source share the GPU upload (that is the whole
// point of the sharing in preloadAssets), so uploading both is one wasted
// step per duplicate — and on a body whose six materials all name the same
// atlas, that is most of the queue.
const TEXTURE_SLOTS = [
  'map', 'emissiveMap', 'normalMap', 'roughnessMap',
  'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap',
];

function collectTextures(root, into, seen) {
  root?.traverse?.((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const slot of TEXTURE_SLOTS) {
        const t = m[slot];
        const id = t?.source?.uuid;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        into.push(t);
      }
    }

    // THE BONE TEXTURE, and it is the one upload on this list that is NOT
    // shared with anything. Everything above belongs to the ASSET — warm it
    // once and every clone of that creature is covered — but a skeleton is
    // per CLONE (skeletonClone gives each body its own; see the note on
    // disposeVisual in assets.js), and three allocates its bone texture LAZILY,
    // inside the first render of a SkinnedMesh:
    //
    //     if (skeleton.boneTexture === null) skeleton.computeBoneTexture();
    //
    // So it is an upload that lands on the arrival frame no matter how
    // thoroughly the asset's own maps were warmed, and it scales with the
    // body: the giant squid brings ten of them, the anglerfish seven.
    //
    // MEASURED, NOT REASONED. tools/looks/boss-warm.js counts what a first
    // draw uploads in a real GL context, and warming the maps alone left
    // exactly one upload per skinned mesh behind on every body in the roster —
    // seven for the anglerfish, ten for the squid, one for the orca. Computing
    // them here takes that residual to zero. Without this the warm-up looks
    // finished and the arrival still pays for the half that is per-instance.
    if (o.isSkinnedMesh && o.skeleton && !o.skeleton.boneTexture) {
      o.skeleton.computeBoneTexture();
      const t = o.skeleton.boneTexture;
      // Deliberately not deduplicated against `seen`: these are per-clone and
      // cannot collide, and a DataTexture built one line ago has no shared
      // source to collide on.
      if (t) into.push(t);
    }
  });
}

// WHICH ASSETS AN ARRIVAL WILL BUILD. Not just the boss's own body: an
// archetype that brings passengers builds those too, on the same frame, and
// the yacht's deck is two to four of them.
//
// `assets` (plural) before `asset`, because bossOrca and bossSquid declare a
// LIST and roll one per arrival — both bodies go in the queue, since which one
// is coming is not decided until spawnOne rolls it. They are the two cheapest
// bodies in the roster (no embedded textures at all), so warming the pair
// costs a clone each and nothing on the GPU.
function assetKeysFor(enemyKey) {
  const def = CONFIG.enemies?.[enemyKey];
  if (!def) return [];
  const keys = [];
  if (def.assets?.length) keys.push(...def.assets);
  else if (def.asset) keys.push(def.asset);
  // The guests. `crewAssets` is the list form and `crewAsset` the single —
  // both exist for the tuning-snapshot reason documented on CONFIG.enemies
  // .bossYacht, and a warm-up that knew about only one of them would leave the
  // yacht, which is the worst arrival in the game, the one it did not cover.
  //
  // WHAT THE CREW GETS FROM THIS IS THE UPLOAD AND THE COMPILE, NOT THE CLONE.
  // systems/crew.js builds its passengers with createVisual, not acquireVisual,
  // so it does not read the visual pool and a body warmed into it here is not
  // the body a guest will wear. The textures and the programs are shared per
  // ASSET rather than per instance, so those parts do carry over, and they are
  // the expensive halves. Making the clone carry over too means teaching
  // crew.js to take from and give back to the pool, which is a change to how
  // guests are destroyed (they dissolve) and does not belong in a warm-up.
  if (def.crewAssets?.length) keys.push(...def.crewAssets);
  else if (def.crewAsset) keys.push(def.crewAsset);
  return keys.filter(Boolean);
}

/**
 * Start preparing an arrival. Called when the hush begins, with the archetype
 * that hush is leading up to.
 *
 * Safe to call when nothing is installed, when the archetype is null, and when
 * a job is already running — the last one supersedes, since a hush that was
 * abandoned and restarted is preparing a different boss.
 */
export function beginBossWarmup(archetype) {
  if (!ctx || !archetype?.enemy) return false;
  if (CONFIG.boss?.warmup?.enabled === false) return false;

  cancelBossWarmup();

  const keys = assetKeysFor(archetype.enemy);
  if (!keys.length) return false;

  job = {
    enemy: archetype.enemy,
    keys,
    at: 0,          // which key we are on
    // Bodies built so far. Handed to the visual pool when the queue finishes,
    // which is what makes the arrival's own acquireVisual free.
    built: [],
    // `built` is emptied when the bodies are handed to the pool, so the count
    // is kept separately — a test asserting "it built three bodies" would
    // otherwise read zero precisely when the thing worked.
    builtCount: 0,
    textures: [],   // collected off the bodies, uploaded one per tick
    texAt: 0,
    stage: 'build',
    busy: false,    // a compile is in flight; compileAsync is a promise
    steps: 0,
  };
  return true;
}

/**
 * One unit of work. Called every frame of the hush; a no-op once the queue is
 * drained, so the caller does not have to know whether there is anything left.
 *
 * Returns true while there is still work outstanding, which is diagnostics
 * only — nothing gates the arrival on this finishing. A hush cut short (the
 * tuner, a forced spawn) simply arrives with whatever got warmed, which is
 * strictly better than nothing and never worse.
 */
export function tickBossWarmup() {
  if (!job || !ctx) return false;
  if (job.busy) return true;

  try {
    switch (job.stage) {
      case 'build': return stepBuild();
      case 'upload': return stepUpload();
      case 'compile': return stepCompile();
      default: return false;
    }
  } catch (err) {
    // A warm-up must never be able to stop a boss arriving. Whatever went
    // wrong, the worst case without it is the hitch this file exists to
    // remove — so the job is dropped and the arrival proceeds cold.
    console.warn('[bossWarmup] step failed —', err?.message ?? err);
    cancelBossWarmup();
    return false;
  }
}

// ONE BODY PER TICK. This is the skeletonClone, and it is the most expensive
// single step in the queue — 16ms for the worst body in the roster, which is
// one dropped frame in an empty ocean instead of one dropped frame under the
// arrival.
//
// Through acquireVisual rather than createVisual, and that is the load-bearing
// choice in this file: acquireVisual is what spawnOne calls, so a body built
// here and released below is a body spawnOne will POP INSTEAD OF CLONING. It
// also runs captureRest, which is the snapshot releaseVisual needs to accept it
// back at all — a createVisual body would be refused by the pool and this whole
// step would warm nothing while appearing to work.
function stepBuild() {
  const key = job.keys[job.at++];
  if (key) {
    const visual = acquireVisual(key);
    if (visual) {
      job.built.push(visual);
      job.builtCount++;
      collectTextures(visual, job.textures, (job.seen ??= new Set()));
    }
  }
  job.steps++;
  if (job.at >= job.keys.length) job.stage = job.textures.length ? 'upload' : 'compile';
  return true;
}

// ONE TEXTURE PER TICK. A 2048-square upload plus its mipmap chain is single
// -digit milliseconds; the anglerfish has four of them, so this is four frames
// of the hundred and eighty available.
function stepUpload() {
  const tex = job.textures[job.texAt++];
  if (tex) ctx.post.initTexture?.(tex);
  job.steps++;
  if (job.texAt >= job.textures.length) job.stage = 'compile';
  return true;
}

// THE PROGRAMS, against the real target and the real lights — see post.warm.
//
// Most of what a boss draws is already warm from boot (every ASSETS key is
// compiled there), so this is not usually where the time goes. What it catches
// is the configurations that only exist once a body has been BUILT: an
// instanced biolum material, a per-instance clone, an outline shell — and the
// bodies here are the exact objects the arrival will use, since they go into
// the pool from this same queue.
//
// THE BODIES ARE HANDED OVER BEFORE THE COMPILE IS STARTED, not after it, and
// that ordering is the one non-obvious thing in this file. compileAsync is a
// promise: it settles when it settles, and the arrival is on a countdown that
// does not wait for it. Releasing on the far side of the await would mean that
// any hush short enough to end mid-compile — a tuned-down hush, a slow frame at
// the wrong moment — spawned a boss that cloned its body anyway while a warmed
// one sat unreachable inside this job. The failure would be invisible: the
// warm-up runs, reports itself finished, and buys nothing.
//
// Handing them over first costs nothing, because a body in the pool is
// reachable by spawnOne and still perfectly compilable where it lies. If the
// arrival takes one mid-compile, it is reparented into the scene out from
// under the group below — which is exactly what should happen, and which
// `group.clear()` then correctly leaves alone.
function stepCompile() {
  const bodies = releaseBuilt();
  if (!bodies.length) { job = null; return false; }

  job.busy = true;

  // A plain container so compileAsync sees one tree. Deliberately NOT added to
  // the scene: these bodies are pool stock rather than creatures, and putting
  // them in the world for a frame would draw a boss at the origin three
  // seconds before its own entrance.
  const group = new THREE.Group();
  for (const b of bodies) group.add(b);

  const active = job;
  ctx.post.warm(group, ctx.camera, ctx.scene)
    .catch((err) => console.warn('[bossWarmup] compile failed —', err?.message ?? err))
    .finally(() => {
      group.clear();
      // The hush may have been abandoned while this was in flight — a boss
      // switched off in the tuner, a forced spawn, a run that ended — and a
      // NEW job may already be running. Only the job that started this compile
      // may clear itself.
      if (job === active) job = null;
    });
  return true;
}

// Hand every body built so far to the visual pool, and return them.
//
// This is the step that makes the arrival's clone free: releaseVisual files
// each one under its asset key, and spawnOne's acquireVisual pops it instead
// of cloning. Idempotent — `built` is emptied, so a cancel that lands after a
// finish cannot release the same body twice (which would file one body in the
// pool under two slots and hand it to two creatures at once).
function releaseBuilt() {
  if (!job) return [];
  const bodies = job.built;
  job.built = [];
  for (const v of bodies) releaseVisual(v);
  return bodies;
}

/**
 * Drop whatever is being prepared.
 *
 * Anything already built still goes to the POOL rather than being thrown away:
 * an abandoned hush means this boss is not coming NOW, not that it is not
 * coming, and a spare body of a species costs one pool slot.
 *
 * An in-flight compile is deliberately NOT cancelled — there is no way to, and
 * nothing to gain: it finishes against materials that are alive either way,
 * and its `finally` finds the job replaced and stands down.
 */
export function cancelBossWarmup() {
  if (!job) return;
  releaseBuilt();
  job = null;
}

/** What the queue is doing, for the tuner and the tests. */
export function bossWarmupState() {
  if (!job) return { active: false };
  return {
    active: true,
    enemy: job.enemy,
    stage: job.stage,
    keys: job.keys.length,
    built: job.builtCount,
    textures: job.textures.length,
    uploaded: job.texAt,
    steps: job.steps,
  };
}
