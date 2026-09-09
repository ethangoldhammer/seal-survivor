// ---------------------------------------------------------------------------
// THE FRONT LAYER — a body drawn OVER the goo and the particles.
//
// Nothing in the world scene can be put in front of a goo body or a particle
// cloud by ordering it. The goo is a fullscreen pass composited over the
// finished picture (systems/post.js), and the particle sprites draw with the
// depth test off at the top of the render order (entities/particles.js) — so a
// mesh that overlaps either is under it however its z or renderOrder is set.
// A dead boss holding still for its photograph was being photographed through
// its own smoke.
//
// So a held body is moved onto a three.js LAYER that the world pass skips and
// a second pass draws — after the goo has been laid down, before the bloom,
// with the same camera and the same scene. Same scene is the point: it is not
// reparented into post.js's overlayScene, because that scene has no lights and
// no fog, and a lit boss moved there would come out black. It stays exactly
// where it is in the graph; only the camera's mask says which pass it is
// drawn in.
//
// THE DEPTH BUFFER IS KEPT between the passes. The body still depth-tests
// against the world — a seal in front of it still covers it — and everything
// it is in front of is unchanged. The only thing that moves is the goo and the
// sprites, which never wrote depth in the first place, and now go under it.
//
// WHAT IS NOT COVERED: a child added to the body AFTER bringToFront stays on
// the world layer and draws in the world pass, under the smoke. The outline
// shells, eyes and skins are already children on the frame a boss dies, so
// nothing the corpse carries is affected; it is a note for anyone hanging a
// new decoration on a held body.
//
// A POOLED VISUAL MUST GO BACK. sendBack runs BEFORE releaseVisual in every
// route out of a hold — a visual returned to the pool still on this layer
// would be worn by the next creature to spawn, and that creature would be
// skipped by the world pass and drawn only while a boss was dying: an
// invisible fish, with no error anywhere.
//
// The lights in world.js enable EVERY layer, because three gathers a light
// only when it passes the camera's mask like any other object — a directional
// key on layer 0 alone lights nothing in the front pass.
// ---------------------------------------------------------------------------

/** The layer index. 0 is the world; anything else that ever needs a layer
 *  of its own picks a different number. */
export const FRONT_LAYER = 1;

// Every root currently in front, so the pass can be skipped when there is
// nothing to draw and a second call on the same body is a no-op rather than
// a second traversal that changes nothing.
const roots = new Set();

/** Draw this object and everything under it over the goo and the sprites. */
export function bringToFront(object) {
  if (!object || roots.has(object)) return;
  roots.add(object);
  mark(object, FRONT_LAYER);
}

/** Put it back in the world pass. Safe on an object that was never in front. */
export function sendBack(object) {
  if (!object || !roots.has(object)) return;
  roots.delete(object);
  mark(object, 0);
}

// Every node under the root. Tolerant of a stand-in with no graph — the shot
// harness's boss is a position and nothing else — so a hold on one of those
// records a root the pass would never draw, rather than throwing.
function mark(object, layer) {
  if (typeof object.traverse !== 'function') { object.layers?.set?.(layer); return; }
  object.traverse((o) => { o.layers?.set(layer); });
}

/** Is there anything for the front pass to draw? */
export function frontLayerActive() {
  return roots.size > 0;
}

/** For the harness. */
export function frontLayerCount() {
  return roots.size;
}

/**
 * Draw the front layer into whatever target is bound, keeping the depth and
 * colour already there. The camera's own mask is put back afterwards, so a
 * camera shared with the world pass is not left seeing only the corpse.
 */
export function renderFrontLayer(renderer, scene, camera) {
  if (!roots.size) return;
  const mask = camera.layers.mask;
  const ac = renderer.autoClear;
  // THE SKY COMES OFF FOR THE PASS. `autoClear = false` is not enough: when a
  // scene's background is a Color, three clears to it on EVERY render of that
  // scene whatever autoClear says (WebGLBackground's forceClear). The world
  // scene's background is the sky, so the first version of this pass drew the
  // boss over a frame wiped to sky blue — no ocean, no scenery, no seal.
  const background = scene.background;
  scene.background = null;
  camera.layers.set(FRONT_LAYER);
  renderer.autoClear = false;
  renderer.render(scene, camera);
  renderer.autoClear = ac;
  camera.layers.mask = mask;
  scene.background = background;
}

/** Run reset: put every root back and forget it. Belt and braces — every
 *  owner sends its own body back before pooling it, but a body that somehow
 *  escaped its owner must not stay a ghost for the rest of the session. */
export function resetFrontLayer() {
  for (const o of roots) mark(o, 0);
  roots.clear();
}
