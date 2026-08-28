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

// USERDATA, WHICH IS THE ONE THING IN A CLONE THAT NOBODY SHARES. Geometry and
// maps belong to the template; `userData` is copied per NODE on every clone and
// round-tripped through JSON on the way — a seagull once carried 1.67MB of it
// per spawn. Nothing else in this file would see that, because it is not a
// typed array and it is not on the GPU.
//
// MEASURED EXACTLY, AND CACHED PER NODE. The first version of this sampled one
// node in sixty-four and scaled up, and the readings it produced were 572MB,
// then 4MB, then 131MB, then 338MB, twenty seconds apart, on a scene that was
// not changing that fast. That is not noise to be averaged away — it is the
// answer: a FEW nodes carry enormous userData and most carry almost none, so
// whether the sample happened to land on one moved the estimate by two orders
// of magnitude. A sampled mean is meaningless on a distribution like that.
//
// Exact is affordable because the cost is paid once per node: the WeakMap
// remembers what a node measured, and the graph is mostly the same nodes
// twenty seconds later (the pool hands the same bodies back out). Only what is
// new since the last census is stringified. A node whose userData is REWRITTEN
// in place keeps its old reading, which is the one thing this trades away —
// and it is worth it, because the question here is which nodes are heavy, not
// which frame they got heavy on.
//
// REFERENCES ARE DROPPED, NOT FOLLOWED — and this is walked by hand rather
// than with JSON.stringify and a replacer, because that combination cannot do
// it. JSON.stringify calls a value's toJSON() BEFORE it shows the value to the
// replacer, and Object3D has one: by the time a replacer could say "this is a
// reference, skip it", the mesh has already been serialised into a plain
// object with its geometry in it. The first version of this file made exactly
// that mistake and reported a live 8-byte pointer as 34MB.
//
// So: a pointer at something the census counts elsewhere (a node, a texture, a
// geometry, a material, a skeleton) costs a pointer. Everything else is
// measured as what it actually is.
// Anything above this is worth naming rather than just counting.
const HEAVY = 64 * 1024;
// What each node measured, so only nodes new since the last census are walked.
const udCache = new WeakMap();
const PTR = 8;
// DEEP ENOUGH TO REACH A SERIALISED MESH. three's toJSON() buries the numbers
// six levels down (object > geometries > data > attributes > position > array),
// so a cap of six charged the exact thing this is hunting a single pointer and
// reported 2KB for a megabyte of carcass. Twelve reaches it with room to spare;
// the `seen` set and the reference rule are what keep the walk bounded, not the
// depth.
const MAX_DEPTH = 12;

function isReference(v) {
  return !!(v.isObject3D || v.isTexture || v.isMaterial || v.isBufferGeometry
    || v.isSkeleton || v.isBone || v.isAnimationClip);
}

function valueBytes(v, depth, seen) {
  if (v == null) return PTR;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return 8;
  if (t === 'string') return v.length * 2 + 16;
  if (t === 'function') return PTR;
  if (t !== 'object') return PTR;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (isReference(v)) return PTR;
  // A cycle, or the same object reached twice — counted once.
  if (seen.has(v)) return PTR;
  seen.add(v);
  // Past the depth cap the shape is unknown rather than free, so it is charged
  // a pointer instead of being followed into something that could be the whole
  // scene graph.
  if (depth >= MAX_DEPTH) return PTR;
  let n = 0;
  if (Array.isArray(v)) {
    // A plain array of numbers is the shape that matters here: a Float32Array
    // that has been through a JSON round trip comes back as one, at eight
    // bytes an element plus the array's own slot, and that is the bloat this
    // whole file went looking for.
    for (const x of v) n += valueBytes(x, depth + 1, seen) + PTR;
    return n + 32;
  }
  for (const k of Object.keys(v)) n += k.length * 2 + PTR + valueBytes(v[k], depth + 1, seen);
  return n + 32;
}

// Cached per node — see the note above on why exact is affordable.
function nodeUserDataBytes(n) {
  let v = udCache.get(n);
  if (v === undefined) {
    v = userDataBytes(n.userData);
    udCache.set(n, v);
  }
  return v;
}

/** What a node's own userData costs, references excluded. Exported for the test. */
export function userDataBytes(ud) {
  if (!ud || typeof ud !== 'object') return 0;
  const keys = Object.keys(ud);
  if (!keys.length) return 0;
  const seen = new Set();
  let n = 0;
  for (const k of keys) n += k.length * 2 + PTR + valueBytes(ud[k], 1, seen);
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
  let nodes = 0;
  let userData = 0;
  // The heaviest few, named — a total says there is a problem and this says
  // whose it is.
  const heavy = [];

  const one = (o) => {
    if (!o) return;
    if (Array.isArray(o)) { for (const x of o) one(x); return; }
    if (o.isTexture) { tex += textureBytes(o, texSeen); return; }
    if (o.isBufferGeometry) { geo += geometryBytes(o, geoSeen); return; }
    if (o.isMaterial) { tex += materialTextures(o, texSeen); return; }
    if (typeof o.traverse !== 'function') return;
    o.traverse((n) => {
      nodes++;
      const ud = n.userData;
      if (ud && typeof ud === 'object') {
        const b = nodeUserDataBytes(n);
        userData += b;
        if (b >= HEAVY) heavy.push({ b, name: n.name || n.type, keys: Object.keys(ud).join('+') });
      }
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
  heavy.sort((a, b) => b.b - a.b);
  return { geo, tex, bones, userData, meshes, nodes, skeletons: boneSeen.size, heavy: heavy.slice(0, 3), heavyCount: heavy.length };
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
    udMB: mb(c.userData),
    nodes: c.nodes,
    heavy: c.heavy,
    heavyCount: c.heavyCount,
    audioMB: mb(audioBytes),
    targetMB: mb(targetBytes),
    totalMB: mb(c.geo + c.tex + c.bones + c.userData + audioBytes + targetBytes),
    meshes: c.meshes,
    skeletons: c.skeletons,
  };
}

/** The one-line form the crash trail carries. */
export function censusLine(r) {
  const top = (r.heavy ?? [])
    .map((h) => `${h.name}:${Math.round(h.b / 1024)}k[${h.keys}]`).join(' ');
  return `geo${r.geoMB} tex${r.texMB} bone${r.boneMB} ud${r.udMB} aud${r.audioMB} rt${r.targetMB}`
    + ` = ${r.totalMB}MB · ${r.nodes} nodes ${r.skeletons} skel`
    + (r.heavyCount ? ` · ${r.heavyCount} heavy: ${top}` : '');
}
