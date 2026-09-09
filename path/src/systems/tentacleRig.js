import { CONFIG } from '../config.js';

// FILAMENTS DRIVEN BY THEIR OWN BONES.
//
// tools/rig-manowar.mjs gives manowar.glb a 93-bone skeleton — one chain per
// filament, named `strand<N>_<M>` with M counting from the crown outward — and
// tools/manowar-rig-test.mjs proves the skin deforms: every strand moves
// 48-93% of its own span and drags nothing else more than 1.2% of the model.
// What the file does NOT ship is a single animation clip, so until this existed
// nothing ever moved those bones and the tentacles hung stiff.
//
// This is that driver. It is deliberately not an authored clip: eighteen
// filaments of different lengths, each wanting its own phase, is a thing a
// curve editor is bad at and four lines of trigonometry are good at — and a
// clip would have to be re-authored the day the rig is rebuilt with a different
// strand count, while this reads the count off the skeleton it is given.
//
// THE MOTION IS A TRAVELLING WAVE, NOT A SWING.
//
// The phase runs DOWN each chain, so the curl arrives at the tip after the
// crown. A filament that bends everywhere at once reads as a wire being
// rotated; the lag is the entire difference between that and something hanging
// in water. Each strand is then offset by its own index so eighteen of them are
// never in step — without that they move as one object drawn eighteen times,
// which is the failure the crab's `restYaw` exists to fix and which is worse
// here because the strands are side by side and invited to be compared.
//
// TWO AXES, because a filament in a current sways and rolls at once. A
// single-axis swing is a windscreen wiper the moment the camera moves off
// square, and this animal is turning about its own vertical every time it comes
// about — so the one view where a single axis looks right is the one view the
// player does not always have.
//
// AMPLITUDE FALLS OFF TOWARD THE CROWN, via `hold`. The top of a filament is
// anchored to the float and should barely move; the end should trail. Applied
// per bone as a fraction of the way down its own chain, so the short stubs and
// the long strands both bend along their whole length rather than the short
// ones flicking.

/**
 * Build a driver for whatever tentacle chains `visual` has, or null if it has
 * none — which is every other model in the game, and every call site tolerates
 * it the way they tolerate a missing head-look.
 */
export function createTentacleRig(visual) {
  if (!visual) return null;
  let skinned = null;
  visual.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
  if (!skinned?.skeleton) return null;

  // Read off the bone NAMES, which is the same fact tools/rig-manowar.mjs
  // wrote and tools/manowar-rig-test.mjs checks — so all three agree by
  // construction rather than by three copies of a number.
  const chains = new Map();
  for (const b of skinned.skeleton.bones) {
    const m = /^strand(\d+)_(\d+)$/.exec(b.name);
    if (!m) continue;
    const id = Number(m[1]);
    if (!chains.has(id)) chains.set(id, []);
    chains.get(id)[Number(m[2])] = b;
  }
  if (!chains.size) return null;

  // Compacted, because a chain with a hole in it would leave an undefined in
  // the middle and throw on the first frame. A gap means the rig was rebuilt
  // with different names and this driver should say so by finding nothing.
  const list = [...chains.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, bones]) => ({ id, bones: bones.filter(Boolean) }))
    .filter((c) => c.bones.length > 1);
  if (!list.length) return null;

  // THE REST POSE, captured once. Every frame writes an absolute quaternion
  // built from it rather than accumulating onto the live one — an additive
  // layer over a bone nothing else resets is how these drift into a ratchet,
  // which is the bug the seal's chains keep hitting.
  const rest = list.map((c) => c.bones.map((b) => b.quaternion.clone()));

  let t = 0;
  return {
    strands: list.length,
    bones: list.reduce((n, c) => n + c.bones.length, 0),
    /** Put every bone back exactly where the file had it. */
    reset() {
      t = 0;
      list.forEach((c, s) => c.bones.forEach((b, k) => b.quaternion.copy(rest[s][k])));
    },
    /**
     * @param dt      seconds.
     * @param phase   a per-creature offset, so two animals never match.
     * @param scale   0..1 on the amplitude, for a caller that wants it calmer.
     */
    update(dt, phase = 0, scale = 1) {
      const cfg = CONFIG.tentacleRig ?? {};
      if (cfg.enabled === false) return;
      t += dt * (cfg.rate ?? 1);
      const amp = (cfg.amplitude ?? 0.28) * scale;
      const lag = cfg.lag ?? 0.7;
      const spread = cfg.spread ?? 1.31;
      const roll = cfg.roll ?? 0.5;
      const rollRate = cfg.rollRate ?? 0.73;
      const hold = cfg.hold ?? 0.35;
      for (let s = 0; s < list.length; s++) {
        const bones = list[s].bones;
        const n = bones.length;
        for (let k = 0; k < n; k++) {
          const b = bones[k];
          b.quaternion.copy(rest[s][k]);
          // How far down its own chain this bone is, 0 at the crown. `hold`
          // keeps the top anchored without zeroing it outright — a filament
          // welded rigid at the crown reads as a rod in a socket.
          const along = n > 1 ? k / (n - 1) : 1;
          const fall = hold + (1 - hold) * along;
          const p = t * 2 - k * lag + s * spread;
          b.rotateX(Math.sin(p) * amp * fall);
          b.rotateZ(Math.cos(p * rollRate + s + phase) * amp * roll * fall);
        }
      }
    },
  };
}
