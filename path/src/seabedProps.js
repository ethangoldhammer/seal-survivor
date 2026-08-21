// Seabed props cut from sea_bed.glb — GENERATED, do not hand-edit.
//
//   npm run seabed          # measure and preview
//   npm run seabed -- --write
//
// One key per species, holding its variants largest-first. Every number is
// measured by tools/split-seabed.mjs, which is also where the species names
// come from (the pack's own names are a modeller's working notes: "Plant1" is
// three different plants and "Plan3" is a typo).
//
//   fit    the prop's real long axis in the pack's units. Used AS the assets.js
//          fit, which is what keeps the bed's relative sizes — see the note in
//          split-seabed.mjs where this file is written.
//   size   full extents, Y-up, base at y=0. The plants grow along +Y.
//   tris   after decimation, held to 1.0% of each prop's own long axis.

export const SEABED_PROPS = {
  bladegrass: [
    { id: 'bladegrass', model: '/models/seabed/bladegrass.glb', fit: 1.485, tris: 160, size: [0.208, 1.485, 0.060] },
  ],
  broadleaf: [
    { id: 'broadleaf', model: '/models/seabed/broadleaf.glb', fit: 0.684, tris: 162, size: [0.176, 0.684, 0.042] },
    { id: 'broadleaf_b', model: '/models/seabed/broadleaf_b.glb', fit: 0.109, tris: 150, size: [0.056, 0.051, 0.109] },
    { id: 'broadleaf_c', model: '/models/seabed/broadleaf_c.glb', fit: 0.105, tris: 154, size: [0.048, 0.105, 0.021] },
    { id: 'broadleaf_d', model: '/models/seabed/broadleaf_d.glb', fit: 0.079, tris: 172, size: [0.044, 0.079, 0.054] },
  ],
  bubble: [
    { id: 'bubble', model: '/models/seabed/bubble.glb', fit: 0.207, tris: 654, size: [0.207, 0.207, 0.207] },
  ],
  clamshell: [
    { id: 'clamshell', model: '/models/seabed/clamshell.glb', fit: 0.473, tris: 238, size: [0.473, 0.407, 0.095] },
  ],
  cloudcard: [
    { id: 'cloudcard', model: '/models/seabed/cloudcard.glb', fit: 5.714, tris: 2, size: [5.714, 0.000, 3.449] },
  ],
  conchshell: [
    { id: 'conchshell', model: '/models/seabed/conchshell.glb', fit: 0.622, tris: 890, size: [0.278, 0.622, 0.189] },
  ],
  coral: [
    { id: 'coral', model: '/models/seabed/coral.glb', fit: 1.396, tris: 746, size: [0.716, 1.396, 0.696] },
    { id: 'coral_b', model: '/models/seabed/coral_b.glb', fit: 0.589, tris: 402, size: [0.265, 0.589, 0.262] },
  ],
  fanweed: [
    { id: 'fanweed', model: '/models/seabed/fanweed.glb', fit: 1.310, tris: 662, size: [0.571, 1.310, 0.318] },
  ],
  fern: [
    { id: 'fern', model: '/models/seabed/fern.glb', fit: 1.268, tris: 868, size: [0.468, 1.268, 0.233] },
  ],
  kelp: [
    { id: 'kelp', model: '/models/seabed/kelp.glb', fit: 1.446, tris: 365, size: [0.176, 1.446, 0.047] },
    { id: 'kelp_b', model: '/models/seabed/kelp_b.glb', fit: 0.820, tris: 269, size: [0.141, 0.820, 0.165] },
    { id: 'kelp_c', model: '/models/seabed/kelp_c.glb', fit: 0.569, tris: 229, size: [0.133, 0.569, 0.083] },
  ],
  reed: [
    { id: 'reed', model: '/models/seabed/reed.glb', fit: 1.289, tris: 158, size: [0.248, 1.289, 0.089] },
  ],
  ribbonweed: [
    { id: 'ribbonweed', model: '/models/seabed/ribbonweed.glb', fit: 1.202, tris: 150, size: [0.162, 1.202, 0.120] },
    { id: 'ribbonweed_b', model: '/models/seabed/ribbonweed_b.glb', fit: 0.671, tris: 150, size: [0.193, 0.671, 0.283] },
  ],
};

/** Every variant, flattened — the order assets.js registers them in. */
export const SEABED_VARIANTS = Object.values(SEABED_PROPS).flat();
