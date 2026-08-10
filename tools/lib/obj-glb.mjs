// Shared OBJ -> GLB machinery for the sea-animals-01 pack.
//
// Two tools use this (build-squid.mjs, build-octopus.mjs) because that pack
// ships every animal with the SAME four defects, and each one is silent:
//
//   * no `vn` records and no `s` smoothing groups, so anything that computes
//     normals off the raw file gets hard faceting
//   * non-indexed faces, so a 143k-triangle mesh arrives as 431k loose verts
//   * quads with CRLF line endings, which makes naive field-splitting see a
//     phantom extra vertex per face
//   * a 3ds Max exporter MTL that may or may not reference the textures that
//     are sitting right next to it
//
// The GLB writer here is deliberately minimal — static meshes only, one
// primitive, one material. Anything with a skin or a clip should go through
// the pattern in optimize-hammerhead.mjs instead, which carries those across.

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------
// Faces are fan-triangulated on the way in. Every face in this pack is a planar
// quad or a triangle, so a fan is exact rather than an approximation.
export function parseObj(text) {
  const positions = [], uvs = [], faces = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    if (p[0] === 'v') positions.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'vt') uvs.push([+p[1], +p[2]]);
    else if (p[0] === 'f') {
      // OBJ indices are 1-based, and negative means "counting back from here".
      const corners = p.slice(1).map((c) => {
        const [a, b] = c.split('/');
        const vi = +a, ti = b ? +b : 0;
        return [
          vi > 0 ? vi - 1 : positions.length + vi,
          ti > 0 ? ti - 1 : (ti < 0 ? uvs.length + ti : -1),
        ];
      });
      for (let i = 2; i < corners.length; i++) faces.push([corners[0], corners[i - 1], corners[i]]);
    }
  }
  return { positions, uvs, faces };
}

// ---------------------------------------------------------------------------
// weld
// ---------------------------------------------------------------------------
// Keyed on position AND uv, so a vertex sitting on a UV seam stays split — it
// has to, because one position genuinely carries two texture coordinates there.
// `posOf` maps each welded vertex back to its SOURCE position index, which is
// what lets smoothNormals average across a seam without merging it.
//
// `xform` is applied to each position as it is emitted, so the caller can bake
// a rotation without a second pass over the data.
export function weld(parsed, xform = (p) => p) {
  const { positions: V, uvs: VT, faces } = parsed;
  const seen = new Map();
  const P = [], T = [], posOf = [], indices = [];
  for (const tri of faces) {
    for (const [pi, ti] of tri) {
      const key = `${pi}/${ti}`;
      let at = seen.get(key);
      if (at === undefined) {
        at = P.length / 3;
        seen.set(key, at);
        const q = xform(V[pi]);
        P.push(q[0], q[1], q[2]);
        // glTF's uv origin is top-left; OBJ's is bottom-left.
        const uv = ti >= 0 && VT[ti] ? VT[ti] : [0, 0];
        T.push(uv[0], 1 - uv[1]);
        posOf.push(pi);
      }
      indices.push(at);
    }
  }
  return { positions: Float32Array.from(P), uvs: Float32Array.from(T), indices, posOf, srcCount: V.length };
}

// ---------------------------------------------------------------------------
// normals
// ---------------------------------------------------------------------------
// Area-weighted face normals accumulated onto the SOURCE position index, then
// read back per welded vertex. Two things matter here:
//
//   Accumulating per source position (not per welded vertex) is what stops a UV
//   seam from becoming a visible lighting crease — both sides of the seam are
//   the same point on the surface and must end up with the same normal.
//
//   Area weighting — not normalising the cross product before accumulating —
//   stops a fan of sliver triangles from outvoting the large quads around it,
//   which is what pinches the shading at tentacle tips.
//
// Pass `posOf: null` to treat each vertex as its own position, which is what a
// post-decimation mesh needs: the simplifier has already rebuilt the vertex set
// and the old source mapping no longer means anything.
export function smoothNormals(positions, indices, posOf, srcCount) {
  const verts = positions.length / 3;
  const own = posOf ?? Array.from({ length: verts }, (_, i) => i);
  const n = posOf ? srcCount : verts;
  const accum = new Float64Array(n * 3);
  const fallback = new Array(n);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const e1 = [positions[b * 3] - ax, positions[b * 3 + 1] - ay, positions[b * 3 + 2] - az];
    const e2 = [positions[c * 3] - ax, positions[c * 3 + 1] - ay, positions[c * 3 + 2] - az];
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const fl = Math.hypot(fn[0], fn[1], fn[2]);
    for (const vi of [own[a], own[b], own[c]]) {
      accum[vi * 3] += fn[0]; accum[vi * 3 + 1] += fn[1]; accum[vi * 3 + 2] += fn[2];
      // Keep one usable face direction per group for the degenerate case below.
      if (fl > 1e-12 && !fallback[vi]) fallback[vi] = [fn[0] / fl, fn[1] / fl, fn[2] / fl];
    }
  }
  const out = new Float32Array(verts * 3);
  for (let i = 0; i < verts; i++) {
    const vi = own[i];
    let m = Math.hypot(accum[vi * 3], accum[vi * 3 + 1], accum[vi * 3 + 2]);
    // A vertex whose incident faces CANCEL — the two skins of a paper-thin fold,
    // which decimation creates wherever it flattens a tapering arm — accumulates
    // to zero. Normalising that yields (0,0,0), and a zero normal is not a
    // harmless nought: the shader's lighting term collapses and the triangles
    // around it render SOLID BLACK on an otherwise lit model. Measured, the
    // octopus lands 45 of these at 22k triangles. Falling back to any one real
    // incident face is arbitrary but always valid, and 45 vertices shaded off a
    // single face instead of an average is invisible.
    let n = m > 1e-12
      ? [accum[vi * 3] / m, accum[vi * 3 + 1] / m, accum[vi * 3 + 2] / m]
      : (fallback[vi] ?? [0, 1, 0]);
    out[i * 3] = n[0]; out[i * 3 + 1] = n[1]; out[i * 3 + 2] = n[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// weld by position only
// ---------------------------------------------------------------------------
// Collapses every UV duplicate together, producing a CLOSED mesh with no UVs.
//
// This is a MEASURING TOOL, not a step in either build. Any question about a
// mesh's real topology — is it closed, where are its boundaries, how many
// shells — has to be asked of this index list rather than the uv-split one.
// Measured on the octopus, splitting at UV seams turns 84 genuine open edges
// (the mouth) into 18,790, so every honest boundary is buried in false ones and
// an open-edge count taken on the wrong list means nothing at all.
//
// capHoles and the topology audit in build-octopus.mjs both run off this.
export function weldByPosition(parsed, xform = (p) => p) {
  const { positions: V, faces } = parsed;
  const map = new Map();
  const P = [], indices = [];
  for (const tri of faces) {
    for (const [pi] of tri) {
      let at = map.get(pi);
      if (at === undefined) {
        at = P.length / 3;
        map.set(pi, at);
        const q = xform(V[pi]);
        P.push(q[0], q[1], q[2]);
      }
      indices.push(at);
    }
  }
  return { positions: Float32Array.from(P), indices };
}

// ---------------------------------------------------------------------------
// cap holes
// ---------------------------------------------------------------------------
// Fan-fill every open boundary loop. Returns extended positions/uvs/faces.
//
// The octopus source is closed except for two 42-vertex loops where the
// separate `Mouth` group meets the body — 84 open edges, each loop about 0.015
// across on a model normalised to 1.0. At full resolution that is a few pixels
// and nobody has ever noticed it.
//
// A simplifier can collapse the ring of triangles AROUND a boundary while
// leaving the boundary itself, so a small loop can come out the far side as a
// handful of very large triangles with the same hole still in the middle of
// them — a few pixels of honest gap becoming an obvious one. Capping removes
// the boundary so there is nothing left to enlarge, and the caps sit inside the
// mouth where nothing sees them.
//
// Worth being clear about what this did NOT fix, because it was written while
// chasing the dark gash in the mantle and that gash was three.js's simplifier
// tearing the surface, not this. Capping did not move it. What capping does buy
// is an input with provably zero open edges, which is what makes the topology
// audit in build-octopus.mjs a real check rather than a number with no baseline.
export function capHoles(parsed, closedIndices) {
  const use = new Map();
  for (let i = 0; i < closedIndices.length; i += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const u = closedIndices[i + a], v = closedIndices[i + b];
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      let e = use.get(k);
      if (!e) use.set(k, e = { n: 0, tri: i, u, v });
      e.n++;
    }
  }
  // Directed boundary edges, in the winding the surface already uses. A cap
  // triangle traverses the shared edge the opposite way so it agrees.
  const open = [...use.values()].filter((e) => e.n === 1);
  if (!open.length) return { ...parsed, capped: 0, loops: 0 };

  // Recover each open edge's ORIGINAL corner indices, so the cap can carry
  // real UVs rather than zeros.
  const cornerAt = new Map();
  for (let t = 0; t < parsed.faces.length; t++) {
    for (let e = 0; e < 3; e++) cornerAt.set(`${closedIndices[t * 3 + e]}|${t}`, parsed.faces[t][e]);
  }
  const next = new Map();
  for (const e of open) {
    const t = e.tri / 3;
    const a = cornerAt.get(`${e.u}|${t}`), b = cornerAt.get(`${e.v}|${t}`);
    if (a && b) next.set(e.u, { to: e.v, a, b });
  }

  const positions = parsed.positions.slice();
  const uvs = parsed.uvs.slice();
  const faces = parsed.faces.slice();
  const visited = new Set();
  let loops = 0, capped = 0;
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const ring = [];
    let cur = start;
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur);
      const step = next.get(cur);
      if (!step) break;
      ring.push(step);
      cur = step.to;
    }
    if (ring.length < 3) continue;
    loops++;
    // Centre vertex: mean position and mean uv of the ring.
    const cp = [0, 0, 0], cu = [0, 0];
    for (const r of ring) {
      const p = parsed.positions[r.a[0]];
      for (let k = 0; k < 3; k++) cp[k] += p[k] / ring.length;
      const t = parsed.uvs[r.a[1]] ?? [0, 0];
      cu[0] += t[0] / ring.length; cu[1] += t[1] / ring.length;
    }
    const cpi = positions.push(cp) - 1;
    const cui = uvs.push(cu) - 1;
    for (const r of ring) {
      // (v, u, centre): opposite traversal of the shared edge to the surface
      // triangle that owns it, so the cap is wound consistently with it.
      faces.push([r.b, r.a, [cpi, cui]]);
      capped++;
    }
  }
  return { positions, uvs, faces, capped, loops };
}

// ---------------------------------------------------------------------------
// principal axis
// ---------------------------------------------------------------------------
// Power iteration on the covariance of the positions. Returns the unit axis the
// body runs along, which for anything in this pack is NOT a world axis — these
// were posed for a still render and sit diagonally in the scene.
export function principalAxis(V) {
  const cen = [0, 0, 0];
  for (const p of V) for (let k = 0; k < 3; k++) cen[k] += p[k] / V.length;
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of V) {
    const d = [p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += d[a] * d[b] / V.length;
  }
  let axis = [1, 0.3, 0.2];
  for (let it = 0; it < 200; it++) {
    const r = [0, 0, 0];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) r[a] += cov[a][b] * axis[b];
    const m = Math.hypot(...r) || 1;
    axis = r.map((x) => x / m);
  }
  return { axis, centroid: cen };
}

// Rotation that lands `forward` on +Z and `up` on +Y, as a function over points
// already relative to `centroid`. Rows are the basis vectors, which applies the
// transpose of [right up forward] — i.e. the inverse of that basis.
export function basisTo(forward, upHint, centroid) {
  const norm = (v) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = norm(forward);
  const right = norm(cross(upHint, f));
  const up = cross(f, right);
  return (p) => {
    const d = [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]];
    return [
      d[0] * right[0] + d[1] * right[1] + d[2] * right[2],
      d[0] * up[0] + d[1] * up[1] + d[2] * up[2],
      d[0] * f[0] + d[1] * f[1] + d[2] * f[2],
    ];
  };
}

// Surface area either side of the midpoint of `axis`. Split at the MIDPOINT of
// the extent rather than at the centroid: the centroid sits well off-centre on
// a long-armed animal, so splitting there compares a short half against a long
// one and reports a margin that is really just the uneven cut.
export function areaSplit(V, faces, axis, centroid) {
  const tOf = (p) => (p[0] - centroid[0]) * axis[0] + (p[1] - centroid[1]) * axis[1] + (p[2] - centroid[2]) * axis[2];
  let tMin = Infinity, tMax = -Infinity;
  for (const p of V) { const t = tOf(p); if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
  const mid = (tMin + tMax) / 2;
  let neg = 0, pos = 0;
  for (const tri of faces) {
    const [p, r, s] = tri.map(([pi]) => V[pi]);
    const e1 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const e2 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    const A = Math.hypot(
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ) / 2;
    if ((tOf(p) + tOf(r) + tOf(s)) / 3 < mid) neg += A; else pos += A;
  }
  return { neg, pos, span: tMax - tMin };
}

// ---------------------------------------------------------------------------
// glb
// ---------------------------------------------------------------------------
// `images` is a list of { buffer, mimeType }; `material.baseColor` and
// `.normal` index into it. WebP goes in extensionsRequired rather than
// extensionsUsed with a PNG fallback, so a reader that does not know the
// extension fails loudly instead of sampling a texture that is not in the file.
export function writeGlb({ positions, normals, uvs, indices, images = [], material = {}, name = 'Mesh' }) {
  const verts = positions.length / 3;
  const Idx = verts > 65535 ? Uint32Array : Uint16Array;
  const idxArr = Idx.from(indices);

  const parts = [];
  let offset = 0;
  const bufferViews = [];
  const push = (data, target) => {
    const bytes = Buffer.isBuffer(data)
      ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    parts.push(bytes, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };

  const bvPos = push(positions, 34962);
  const bvNrm = push(normals, 34962);
  const bvUv = push(uvs, 34962);
  const bvIdx = push(idxArr, 34963);
  const imageDefs = images.map((im) => ({ bufferView: push(im.buffer), mimeType: im.mimeType }));

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts; i++) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], positions[i * 3 + k]);
    max[k] = Math.max(max[k], positions[i * 3 + k]);
  }

  const webp = images.some((im) => im.mimeType === 'image/webp');
  const pbr = { metallicFactor: material.metallic ?? 0, roughnessFactor: material.roughness ?? 0.7 };
  if (material.baseColor != null) pbr.baseColorTexture = { index: material.baseColor };
  const mat = { name, pbrMetallicRoughness: pbr };
  if (material.normal != null) {
    mat.normalTexture = { index: material.normal, ...(material.normalScale != null ? { scale: material.normalScale } : {}) };
  }

  const json = {
    asset: { version: '2.0', generator: 'seal-survivor tools/lib/obj-glb.mjs' },
    ...(webp ? { extensionsUsed: ['EXT_texture_webp'], extensionsRequired: ['EXT_texture_webp'] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{
      name,
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        material: 0,
      }],
    }],
    materials: [mat],
    textures: imageDefs.map((_, i) => (
      images[i].mimeType === 'image/webp'
        ? { sampler: 0, extensions: { EXT_texture_webp: { source: i } } }
        : { sampler: 0, source: i }
    )),
    images: imageDefs,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    accessors: [
      { bufferView: bvPos, componentType: 5126, count: verts, type: 'VEC3', min, max },
      { bufferView: bvNrm, componentType: 5126, count: verts, type: 'VEC3' },
      { bufferView: bvUv, componentType: 5126, count: verts, type: 'VEC2' },
      { bufferView: bvIdx, componentType: Idx === Uint32Array ? 5125 : 5123, count: idxArr.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [],
  };
  if (!images.length) { delete json.textures; delete json.images; delete json.samplers; }

  const bin = Buffer.concat(parts);
  json.buffers = [{ byteLength: bin.length }];
  const js = Buffer.from(JSON.stringify(json), 'utf8');
  const jsPad = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsPad.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsPad.length, 0); jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'ascii');
  return { glb: Buffer.concat([header, jh, jsPad, bh, bin]), verts, tris: idxArr.length / 3, indexBits: Idx === Uint32Array ? 32 : 16 };
}
