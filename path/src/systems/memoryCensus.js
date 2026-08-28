// ============================================================================
// WHERE THE MEMORY IS — a byte census the phone can take of itself.
//
// The iPhone kills this game's web view at about 1.8GB (see the JetsamEvent
// reading in the crash notes), and every desktop number that could have
// explained it is a proxy: Chrome's `performance.memory` does not exist in
// Safari, the tuner's Mpix says nothing about what is resident, and
// `renderer.info.memory` counts OBJECTS, not bytes — a 4KB bone texture and a
// 16MB hide are both "1".
//
// So this walks what the game is actually holding and adds up the bytes, in
// the one place the question matters: on the device, mid-run, with the trail
// carrying it out (systems/crashLog.js).
//
// DEDUPED BY SOURCE, WHICH IS THE WHOLE ACCURACY OF IT. Every enemy shares one
// template's geometry and one Source per map — see the note in assets.js about
// Texture.clone() sharing a Source — so a census that counted per mesh would
// report a number several times the truth and point at whatever the game
// happened to spawn most of. Geometry is keyed on its own uuid, a texture on
// `source.uuid`, and each is counted once however many holders it has.
//
// WHAT A NUMBER HERE MEANS. `geo` and `tex` are CPU-side bytes — the typed
// arrays three keeps after the upload, which is what the WebContent process is
// killed for. The GPU's own copy is a different budget in a different process,
// and `npm run tex` is the tool for that one.
// ============================================================================

const MB = 1048576;

/** A texture's CPU-side bytes, counted once per Source. */
function textureBytes(t, seen) {
  const src = t?.source;
  if (!src || seen.has(src.uuid)) return 0;
  seen.add(src.uuid);

  // COMPRESSED FIRST, because a .ktx2 has an `image` with a width and a height
  // that would answer the uncompressed question — and the transcoded ASTC data
  // that is actually in memory is a quarter of it, sitting in `mipmaps`.
  if (t.isCompressedTexture || Array.isArray(t.mipmaps) && t.mipmaps.length) {
    let n = 0;
    for (const m of t.mipmaps) n += m?.data?.byteLength ?? m?.byteLength ?? 0;
    if (n) return n;
  }
  const img = src.data ?? t.image;
  // A DataTexture holds its own array; an ImageBitmap or an <img> holds a
  // decoded RGBA8 surface of its own dimensions.
  if (img?.data?.byteLength) return img.data.byteLength;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!(w > 0 && h > 0)) return 0;
  // The mip chain is a third again, and three builds one unless told not to.
  return w * h * 4 * (t.generateMipmaps === false ? 1 : 4 / 3);
}

/** A geometry's attribute and index bytes, counted once per geometry. */
function geometryBytes(g, seen) {
  if (!g?.uuid || seen.has(g.uuid)) return 0;
  seen.add(g.uuid);
  let n = 0;
  for (const a of Object.values(g.attributes ?? {})) n += a?.array?.byteLength ?? 0;
  for (const list of Object.values(g.morphAttributes ?? {})) {
    for (const a of list ?? []) n += a?.array?.byteLength ?? 0;
  }
  n += g.index?.array?.byteLength ?? 0;
  return n;
}

function materialTextures(m, seen) {
  if (!m) return 0;
  let n = 0;
  for (const v of Object.values(m)) {
    if (v?.isTexture) n += textureBytes(v, seen);
  }
  // The look system keeps its maps off the material — see the lookTextures
  // registry — and they are as resident as any other.
  for (const v of Object.values(m.uniforms ?? {})) {
    if (v?.value?.isTexture) n += textureBytes(v.value, seen);
  }
  return n;
}

/**
 * Add up anything: an Object3D (traversed), a geometry, a material, a texture,
 * or an array of any of those. Everything is deduped across the whole call, so
 * the scene and the pool holding the same template counts once.
 */
export function censusItems(items) {
  const geoSeen = new Set();
  const texSeen = new Set();
  const boneSeen = new Set();
  let geo = 0;
  let tex = 0;
  let bones = 0;
  let meshes = 0;

  const one = (o) => {
    if (!o) return;
    if (Array.isArray(o)) { for (const x of o) one(x); return; }
    if (o.isTexture) { tex += textureBytes(o, texSeen); return; }
    if (o.isBufferGeometry) { geo += geometryBytes(o, geoSeen); return; }
    if (o.isMaterial) { tex += materialTextures(o, texSeen); return; }
    if (typeof o.traverse !== 'function') return;
    o.traverse((n) => {
      if (n.geometry) { geo += geometryBytes(n.geometry, geoSeen); meshes++; }
      const m = n.material;
      if (Array.isArray(m)) for (const x of m) tex += materialTextures(x, texSeen);
      else tex += materialTextures(m, texSeen);
      // THE PER-BODY COST, and the reason it gets a column of its own: every
      // skinned clone has a Skeleton nobody shares, holding a bone matrix
      // array and (once it has been drawn) a DataTexture of the same bytes.
      // It is the one thing in here that scales with how many creatures have
      // EXISTED rather than with the size of the roster.
      const sk = n.skeleton;
      if (sk && !boneSeen.has(sk.uuid ?? sk)) {
        boneSeen.add(sk.uuid ?? sk);
        bones += sk.boneMatrices?.byteLength ?? 0;
        bones += sk.boneTexture?.image?.data?.byteLength ?? 0;
      }
    });
  };
  one(items);
  return { geo, tex, bones, meshes, skeletons: boneSeen.size };
}

/**
 * The whole picture, in megabytes, rounded to something a breadcrumb can
 * carry. Every part is optional — a caller that cannot reach the audio banks
 * gets a report without them rather than a throw.
 */
export function censusReport({ items = [], audioBytes = 0, targetBytes = 0 } = {}) {
  const c = censusItems(items);
  const mb = (n) => Math.round(n / MB);
  return {
    geoMB: mb(c.geo),
    texMB: mb(c.tex),
    boneMB: mb(c.bones),
    audioMB: mb(audioBytes),
    targetMB: mb(targetBytes),
    totalMB: mb(c.geo + c.tex + c.bones + audioBytes + targetBytes),
    meshes: c.meshes,
    skeletons: c.skeletons,
  };
}

/** The one-line form the crash trail carries. */
export function censusLine(r) {
  return `geo${r.geoMB} tex${r.texMB} bone${r.boneMB} aud${r.audioMB} rt${r.targetMB} = ${r.totalMB}MB`;
}
