import * as THREE from 'three';
import { ASSETS, createVisual } from '../assets.js';

// ---------------------------------------------------------------------------
// Compiling every shader before the run, instead of one per stall during it.
//
// three compiles a program the first time a material is actually drawn. Nothing
// warned it in advance, so the first megalodon of a run, the first crab, the
// first pearl, the first outlined shark and the first glowing lanternfish each
// paid for their own compile+link on the frame they appeared — on the main
// thread, in the middle of a fight. That is the periodic hitch that survived
// every CPU fix: it was never CPU work, and it never showed up in a spawn
// benchmark because the SECOND spawn of anything is free.
//
// It is worst on a laptop and mild on iOS, which is the shape of Chrome's
// ANGLE->Metal translation: a link there is tens of milliseconds where Safari's
// native path is a few.
//
// The trade is deliberate and it is not free: this makes boot LONGER. Every
// program the game can ask for gets built while a loading screen is up, which
// is why that screen now has a progress bar worth watching (ui/loading.js).
//
// TWO THINGS have to be true for a warm-up to warm anything, and both fail
// silently when they are not:
//
//   THE CACHE KEY MUST MATCH. three keys programs on, among other things, the
//     bound render target's colour space and the light counts of the scene.
//     Compile against the default framebuffer, or against a bare scene with no
//     lights, and every program is built under a key the game never asks for —
//     so the real compile still happens mid-run, and boot is now slower for
//     nothing. post.warm binds the scene target; `targetScene` below hands over
//     the real lights.
//   NOTHING MAY BE DISPOSED. Materials are shared across every clone of an
//     asset key (see assets.js), so the warm instance holds the SAME material a
//     spawned creature will use, and material.dispose() is what releases the
//     compiled program. Disposing the warm-up would throw away precisely what
//     it just built. So these instances are dropped on the floor for the GC
//     instead — the geometry and materials they reference are the templates',
//     which are alive anyway.
// ---------------------------------------------------------------------------

// Split across a few awaits so the loading bar can actually paint between
// batches. Small enough that a slow key doesn't freeze the bar for a second,
// large enough that the per-call overhead of compileAsync stays irrelevant.
const BATCH = 6;

/**
 * Build one of everything, compile it, throw the instances away.
 *
 * @param post    the post pipeline — its `warm` binds the right render target
 * @param scene   world.scene, for its lights
 * @param camera  world.camera
 * @param onProgress (0..1)
 */
export async function warmShaders(post, scene, camera, onProgress) {
  // Every asset the game can build, not just the ones that spawn. The extras
  // are close to free: three caches programs by key, so forty assets sharing
  // three material configurations compile three times, not forty. Filtering
  // this list by "can it appear mid-run" would be a maintenance burden that
  // buys nothing and goes stale the first time a creature is added.
  const keys = Object.keys(ASSETS);

  for (let i = 0; i < keys.length; i += BATCH) {
    const group = new THREE.Group();

    for (const key of keys.slice(i, i + BATCH)) {
      let visual;
      try {
        visual = createVisual(key);
      } catch (err) {
        // A warm-up must never be able to stop the game booting. Whatever this
        // key is, the worst case without it is the stall we were avoiding.
        console.warn(`[warmup] skipped "${key}" —`, err?.message ?? err);
        continue;
      }
      if (visual) group.add(visual);
    }

    // The compile itself. `scene` as the target scene, so the light counts in
    // the cache key are the real ones.
    try {
      await post.warm(group, camera, scene);
    } catch (err) {
      console.warn('[warmup] compile batch failed —', err?.message ?? err);
    }

    // TEXTURES ARE DELIBERATELY NOT UPLOADED HERE.
    //
    // They were, briefly, on the reasoning that a 2048-square mask arriving
    // with the first megalodon is its own stall on the same frame the program
    // used to be. That reasoning is true and the cure was worse: the roster
    // carries 49 megapixels of texture, which is ~196MB as RGBA8 and ~260MB
    // once three builds the mipmaps, and an initTexture sweep makes ALL of it
    // resident from boot — including every asset that never spawns in a given
    // run, which lazily would have cost nothing.
    //
    // Past a device's texture budget that does not fail, it PAGES: the driver
    // evicts and re-uploads under you for the rest of the session, which is
    // continuous hitching rather than one stall, and it lands on every device
    // rather than on the slow ones. A phone has the tightest budget and was
    // the clearest tell — it had been the machine that ran WELL.
    //
    // Programs are the part with evidence behind them: a link is tens of
    // milliseconds and happens exactly once per program, so warming them is a
    // straight trade. An upload is neither.
    //
    // Not disposed — see the note at the top. Emptying the group is enough;
    // what stays alive is the templates' geometry and materials, which were
    // alive before this ran.
    group.clear();

    onProgress?.(Math.min(1, (i + BATCH) / keys.length));
  }
}

/**
 * One real frame through the real pipeline.
 *
 * Everything above warms things that are NOT in the scene yet. This warms
 * everything that is — the grid, the water, the sky, the stars, the particle
 * points, the trails — plus the three fullscreen passes in post.js itself,
 * which no amount of compiling scene objects will ever reach. Drawing it is
 * the only way to be sure the first frame the player sees isn't the frame that
 * compiles the composite shader.
 *
 * Runs behind the loading screen, so nobody sees the empty ocean it draws.
 */
export function warmPipeline(post, scene, camera) {
  try {
    post.render(scene, camera, 0);
  } catch (err) {
    console.warn('[warmup] first frame failed —', err?.message ?? err);
  }
}
