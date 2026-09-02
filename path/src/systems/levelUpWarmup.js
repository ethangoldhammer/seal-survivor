// ---------------------------------------------------------------------------
// THE PICK, PAID FOR WHILE THE CARDS ARE UP
// ---------------------------------------------------------------------------
// A level-up card that grants a companion builds that companion's body on the
// first LIVE frame after the pick, not on the frame of the click — and that is
// the stutter between choosing a card and the game coming back.
//
// The reason is the pause gate. Every one of these abilities sizes its ring
// inside the gameplay tick:
//
//     systems/shrimpRing.js  syncCount   -> createVisual('shrimp')
//     systems/sealTeam.js    resize      -> createVisual('sealTeam')
//     systems/harp.js        syncHarps   -> createVisual('harp')
//     systems/club.js        syncSockets -> createVisual('club' | variant)
//
// and that tick is skipped for as long as `gameState.paused` is set, which is
// the whole time the cards are on screen. applyLevelChoice clears the flag and
// the very next tick does the construction — so the clone, the per-instance
// material copies, the first texture upload of that asset and any program the
// built body turns out to need all land on the one frame the player is watching
// for the game to become playable again.
//
// THE MENU IS A HUSH, and it is the same shape as the one systems/bossWarmup.js
// already uses. The run is frozen, nothing is spawning, and the player is
// reading three cards for as long as it takes them — seconds of known,
// unpressured lead time immediately in front of the expensive frame. This file
// spends it.
//
// WHAT IT CAN AND CANNOT PAY FOR, because the halves are not the same:
//
//   THE UPLOAD    is per ASSET and is the expensive half. systems/shaderWarmup
//                 .js deliberately uploads nothing at boot (49 megapixels
//                 resident from launch is the paging bug, see the long note
//                 there), so a companion's maps arrive on the frame it first
//                 draws. Warmed here, they are resident before the pick — and
//                 unlike the boot sweep this is four small assets, held for the
//                 rest of a run in which the player is about to be offered them
//                 anyway.
//   THE PROGRAM   is per asset too and is usually already warm — every ASSETS
//                 key is compiled at boot. The compile step below is for the
//                 configurations that only exist once a body has been BUILT: an
//                 instanced biolum skin, a spawn decorator's material. Cheap
//                 when there is nothing new, which is the normal case.
//   THE CLONE     is per INSTANCE and cannot be pre-paid from here. These
//                 systems call createVisual rather than acquireVisual, so they
//                 do not read the visual pool and a body warmed into it is not
//                 the body they will wear (the same limit bossWarmup documents
//                 for the yacht's crew). Making the clone carry over means
//                 teaching four systems to take from and give back to the pool,
//                 which is a change to how companions are destroyed and does
//                 not belong in a warm-up.
//
// EVERY KEY, NOT THE THREE ON OFFER. The warm-up starts when the menu opens and
// the pick is not known until it ends, so filtering by what is dealt would warm
// nothing in time. Four small assets is cheaper than the machinery to decide.
//
// ONCE PER RUN, AND ONE STEP PER FRAME. `warmed` is what makes the second
// level-up free; the step budget is what stops this being the same hitch moved
// half a second earlier, which is not a fix but a different frame to complain
// about.
//
// IT MUST BE ABLE TO DO NOTHING. There is no renderer in a Node harness and no
// pipeline before boot finishes, and a companion built cold is exactly the game
// we had before this file. Every entry point is a no-op until
// `installLevelUpWarmup` has been called, and every step is wrapped — a warm-up
// that throws must never be able to stop a card being taken.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createVisual, hasModel } from '../assets.js';
import { SHRIMP_RING_ASSETS } from './shrimpRing.js';
import { SEAL_TEAM_ASSETS } from './sealTeam.js';
import { HARP_ASSETS } from './harp.js';
import { CLUB_ASSETS } from './club.js';
import { CALAMARI_ASSETS } from './calamari.js';
import { SARDINE_SWIRL_ASSETS } from './sardineSwirl.js';

// The compile/upload context, handed over by main.js once the pipeline exists.
// Null everywhere else, which is what makes this file inert in a harness.
let ctx = null;

// The queue for the menu currently open. Null when nothing is pending, which is
// almost all of the time.
let job = null;

// Asset keys already paid for this run, so the second level-up and every one
// after it costs a single test. Cleared by resetLevelUpWarmup from startGame.
const warmed = new Set();

/**
 * EVERY BODY A PICK CAN BUILD, composed from the systems that build them rather
 * than listed here.
 *
 * The direction matters: each system exports the keys it passes to createVisual
 * and this file reads them, so a companion that changes model moves its own
 * warm-up with it. Written out here instead, the list would be a copy that goes
 * stale silently — the warm-up runs, reports itself finished, and warms an
 * asset nothing builds any more.
 */
export function levelUpWarmupKeys() {
  return [...new Set([
    ...SHRIMP_RING_ASSETS,
    ...SEAL_TEAM_ASSETS,
    ...HARP_ASSETS,
    ...CLUB_ASSETS,
    ...CALAMARI_ASSETS,
    ...SARDINE_SWIRL_ASSETS,
  ])];
}

/**
 * Hand over the pipeline. Called once from main.js, alongside
 * installBossWarmup — the same three things post.warm needs, and for the same
 * reasons (see the cache-key note on post.warm: a compile against the wrong
 * render target or a scene with the wrong lights builds a program the game
 * never asks for).
 */
export function installLevelUpWarmup({ post, scene, camera } = {}) {
  ctx = post && scene && camera ? { post, scene, camera } : null;
}

/** Diagnostics: is there a pipeline to warm against? */
export function levelUpWarmupReady() {
  return !!ctx;
}

// Every texture hanging off a material, in the slots three will upload on a
// first draw. Deduplicated by SOURCE rather than by texture object: two Texture
// instances over one Source share the GPU upload, so uploading both is a wasted
// step per duplicate — and on a body whose materials all name one atlas that is
// most of the queue.
//
// THE BONE TEXTURE IS DELIBERATELY NOT COLLECTED, which is the one place this
// file diverges from bossWarmup's collectTextures. A skeleton is per CLONE, so
// computing it on a body that is about to be thrown away warms nothing the
// companion will use — it would add an upload here and leave the identical one
// on the pick frame. The bodies here are small enough (a shrimp, a club) that
// the residual is a few hundred bytes; a boss is where that trade goes the
// other way.
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
  });
}

/**
 * Start preparing a level-up. Called on the frame the menu opens.
 *
 * Safe to call with nothing installed, with a job already running (a second
 * card from the same batch of levels re-enters here and the queue in flight is
 * kept, since it is preparing the same set), and on a run where everything is
 * already warm — the last one is the usual case after the first level.
 *
 * @returns true if there is a queue to tick.
 */
export function beginLevelUpWarmup() {
  if (!ctx) return false;
  if (CONFIG.levelUp?.warmup?.enabled === false) return false;
  if (job) return true;

  // `hasModel` and not just ASSETS: a key whose model never loaded falls back
  // to a primitive that shares one cached material with everything else of its
  // shape, so there is nothing per-asset left to warm and a clone of it would
  // be a step spent on nothing.
  const keys = levelUpWarmupKeys().filter((k) => !warmed.has(k) && hasModel(k));
  if (!keys.length) return false;

  job = {
    keys,
    at: 0,
    built: [],      // bodies, kept until the compile so it has something to see
    textures: [],
    texAt: 0,
    seen: new Set(),
    stage: 'build',
    busy: false,    // a compile is in flight; compileAsync is a promise
    steps: 0,
  };
  return true;
}

/**
 * One unit of work. Called every frame the menu is up; a no-op once the queue
 * is drained, so the caller does not have to know whether there is anything
 * left.
 *
 * Returns true while work is outstanding, which is diagnostics only — nothing
 * gates the pick on this finishing. A menu taken in half a second simply picks
 * with whatever got warmed, which is strictly better than nothing and never
 * worse.
 */
export function tickLevelUpWarmup() {
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
    // A warm-up must never be able to stop a card being taken. Whatever went
    // wrong, the worst case without it is the hitch this file exists to remove
    // — so the job is dropped and the pick proceeds cold.
    console.warn('[levelUpWarmup] step failed —', err?.message ?? err);
    cancelLevelUpWarmup();
    return false;
  }
}

// ONE BODY PER TICK, through createVisual because that is the call the four
// systems make: what is warmed is then what they will build, including the
// per-instance work createVisual itself does (an instanced biolum skin, the
// spawn decorator). A template read straight out of ASSETS would miss both.
//
// The body is DROPPED, never disposed. Its materials and textures are the
// template's, shared by reference with every clone the ability will make, and
// material.dispose() is precisely what releases the program and the upload this
// step just paid for — the same trap systems/shaderWarmup.js documents.
function stepBuild() {
  const key = job.keys[job.at++];
  if (key) {
    const visual = createVisual(key);
    if (visual) {
      job.built.push(visual);
      collectTextures(visual, job.textures, job.seen);
    }
    // Marked warm on the BUILD rather than at the end of the queue, so a menu
    // cut short does not re-do the keys it already got through on the next
    // level-up while leaving the ones it never reached unwarmed forever.
    warmed.add(key);
  }
  job.steps++;
  if (job.at >= job.keys.length) job.stage = job.textures.length ? 'upload' : 'compile';
  return true;
}

// ONE TEXTURE PER TICK. An upload plus its mipmap chain is single-digit
// milliseconds, and a menu is hundreds of frames long.
function stepUpload() {
  const tex = job.textures[job.texAt++];
  if (tex) ctx.post.initTexture?.(tex);
  job.steps++;
  if (job.texAt >= job.textures.length) job.stage = 'compile';
  return true;
}

// THE PROGRAMS, against the real target and the real lights — see post.warm.
//
// Deliberately NOT added to the scene: these are throwaway bodies, and putting
// them in the world for a frame would draw a club and a spare seal at the
// origin over the cards.
function stepCompile() {
  const bodies = job.built;
  job.built = [];
  if (!bodies.length) { job = null; return false; }

  job.busy = true;
  const group = new THREE.Group();
  for (const b of bodies) group.add(b);

  const active = job;
  ctx.post.warm(group, ctx.camera, ctx.scene)
    .catch((err) => console.warn('[levelUpWarmup] compile failed —', err?.message ?? err))
    .finally(() => {
      // Clear rather than dispose — see stepBuild. The bodies go to the GC and
      // what they referenced stays alive in the templates.
      group.clear();
      // The menu may have been closed while this was in flight and a NEW job
      // may already be running. Only the job that started this compile may
      // clear itself.
      if (job === active) job = null;
    });
  return true;
}

/**
 * Drop whatever is being prepared — the menu closed, or the run ended.
 *
 * Keys already marked warm STAY marked: the upload happened, and it is resident
 * whether or not the queue behind it finished.
 *
 * An in-flight compile is deliberately not cancelled — there is no way to, and
 * nothing to gain: it finishes against materials that are alive either way, and
 * its `finally` finds the job replaced and stands down.
 */
export function cancelLevelUpWarmup() {
  job = null;
}

/**
 * A new run. The ledger is cleared because a run reloads nothing — the
 * templates and their uploads survive a restart, so this is only about the
 * bookkeeping being honest about a fresh game rather than about redoing work.
 */
export function resetLevelUpWarmup() {
  cancelLevelUpWarmup();
  warmed.clear();
}

/** What the queue is doing, for the tuner and the tests. */
export function levelUpWarmupState() {
  return {
    active: !!job,
    ready: !!ctx,
    warmed: [...warmed],
    stage: job?.stage ?? null,
    keys: job?.keys.length ?? 0,
    built: job?.at ?? 0,
    textures: job?.textures.length ?? 0,
    uploaded: job?.texAt ?? 0,
    steps: job?.steps ?? 0,
  };
}
