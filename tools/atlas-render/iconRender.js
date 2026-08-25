// The icon renderer, as one implementation shared by both pages.
//
//   render.html   drives it over a whole spec list and POSTs the PNGs
//   picker.html   drives it for one spec, live, so the angles can be chosen
//
// SHARED ON PURPOSE. The picker exists to choose numbers that the batch render
// then bakes, so the two have to agree about what a number MEANS. A picker with
// its own copy of the framing, the toon pass or the outline maths is a picker
// that shows you something the icons will not look like — and the drift would
// appear as "the render came out different from the preview", which is the one
// bug this tool cannot afford to have.
//
// Everything here was lifted out of render.html unchanged; the comments explain
// why each part is the way it is and they came with it.
import * as THREE from 'three';
// THE SEAL'S OWN HIDE, from the game's own module. `/src/` is mounted by
// tools/atlas-render/server.mjs; noiseGlsl.js is a leaf with no imports at all,
// which is what lets a plain browser load it — config.js could never be.
import {
  MOTTLE_UNIFORMS_GLSL, NOISE_FIELD_GLSL, MOTTLE_FRAGMENT_GLSL,
  MOTTLE_VARYING_GLSL, MOTTLE_DEFAULTS,
  GLOW_UNIFORMS_GLSL, GLOW_LAYERS_GLSL, GLOW_DEFAULTS,
} from '/src/systems/noiseGlsl.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export const SIZE = 512;

export function makeRenderer(size = SIZE) {
  // Renders on demand and never inside a rAF loop: these pages have to work in
  // a backgrounded tab, where rAF simply does not fire.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(2);
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

const AXES = { '+X': [1,0,0], '-X': [-1,0,0], '+Y': [0,1,0], '-Y': [0,-1,0], '+Z': [0,0,1], '-Z': [0,0,-1] };
const v = (n) => new THREE.Vector3().fromArray(AXES[n] ?? AXES['+Z']);

// Every creature is shown in the same frame: its declared `forward` points
// screen-right and its `up` points screen-up, so the boats and the moray come
// out rotated here exactly as they are rotated in the game.
function orient(obj, forward, up) {
  const f = v(forward), u = v(up).normalize();
  u.addScaledVector(f, -u.dot(f)).normalize();       // orthogonalise
  const r = new THREE.Vector3().crossVectors(f, u);  // model's own right
  // Columns are where the model's axes should land: forward -> +X, up -> +Y.
  const m = new THREE.Matrix4().makeBasis(f, u, r).invert();
  obj.applyMatrix4(m);
}

// Where the posed model's vertices ACTUALLY are.
//
// `Box3.setFromObject` is wrong for a skinned mesh and wrong quietly. It takes
// the geometry's own bounding box and pushes it through the mesh's world
// matrix — but a skinned vertex is placed by its BONES, and the mesh's own
// matrix has nothing to do with where it lands. On a rig whose skin space sits
// near the origin while its armature sits somewhere else, the two answers are
// nowhere near each other: the otter, the tuna and the brown fish framed on a
// box the animal was not in and rendered as three blank 24KB PNGs — no error,
// no warning, just nothing.
//
// So the vertices are skinned in software and measured directly, which is the
// only honest way to ask a posed rig where it is. `updateMatrixWorld(true)` is
// forced first: without it every bone reports its rest matrix and the whole
// exercise silently measures the bind pose.
function meshBoxes(root) {
  root.updateMatrixWorld(true);
  const out = [];
  const p = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position;
    const box = new THREE.Box3();
    if (o.isSkinnedMesh) o.skeleton.update();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      if (o.isSkinnedMesh) o.applyBoneTransform(i, p);
      box.expandByPoint(o.localToWorld(p));
    }
    out.push({ obj: o, box, verts: pos.count });
  });
  return out;
}

// The box the CAMERA should frame, and the strays it refused to include.
//
// A part that sits thousands of body-lengths from the body is not part of the
// silhouette, it is a fault in the file — and framing on the union of the two
// puts the animal off-screen while the fault sits dead centre. The otter is
// the live example: its 442-vertex eye mesh is bound such that it lands 2,784
// units from a body 0.97 units long, IN BIND POSE, so the render came back as
// two black circles floating in white and nothing else.
//
// The anchor is the mesh with the most vertices — the body, on anything shaped
// like an animal — and anything whose centre is more than 20 radii away from
// it is dropped and named.
function posedBox(root, strays) {
  const parts = meshBoxes(root);
  if (!parts.length) return new THREE.Box3();
  const anchor = parts.reduce((a, b) => (b.verts > a.verts ? b : a));
  const c = anchor.box.getCenter(new THREE.Vector3());
  const r = Math.max(anchor.box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
  const box = new THREE.Box3();
  for (const p of parts) {
    const d = p.box.getCenter(new THREE.Vector3()).distanceTo(c);
    if (p !== anchor && d > r * 20) {
      strays?.push(`${p.obj.name || 'mesh'} at ${(d / r).toFixed(0)}x body radius`);
      p.obj.visible = false;
      continue;
    }
    box.union(p.box);
  }
  return box;
}

// Centre the model and report the radius the camera has to clear.
//
// THE BOUNDING SPHERE, not the longest axis. The camera looks from a
// three-quarter angle, so the silhouette it sees is not the box's longest
// side — a deep, chunky body presents its diagonal. A sphere is the one bound
// that is the same from every angle, which is also what lets the picker spin
// the camera without the framing breathing in and out.
function frame(root, strays) {
  const box = posedBox(root, strays);
  if (box.isEmpty()) return 0.5;
  const centre = new THREE.Vector3(); box.getCenter(centre);
  root.position.sub(centre);
  const sphere = new THREE.Sphere();
  box.translate(centre.clone().negate()).getBoundingSphere(sphere);
  return sphere.radius || 0.5;
}

function makeScene(toon) {
  const scene = new THREE.Scene();
  // TOON WANTS FEWER, HARDER LIGHTS. Banding is a function of how much of the
  // body sits on each side of a step, and four overlapping sources put almost
  // every surface in the top band — which is a flat sticker, the one thing the
  // shading was added to avoid. One dominant key and a low ambient floor gives
  // two readable steps and a shadow side.
  if (toon) {
    scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x39474d, 0.85));
    const key = new THREE.DirectionalLight(0xfff6e8, 2.9); key.position.set(-3, 4, 5); scene.add(key);
    return scene;
  }
  // Neutral studio light: a cool sky/ground hemisphere so nothing goes pure
  // black in shadow, a warm key from front-left-above, and a dim rim behind to
  // separate a dark animal from a transparent background.
  scene.add(new THREE.HemisphereLight(0xbfd8e0, 0x2a3438, 2.1));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6); key.position.set(-3, 4, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe4ff, 0.9); fill.position.set(4, 1, 3); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(1, 2, -5); scene.add(rim);
  return scene;
}

// The step ramp toon shading quantises against.
//
// Every part of the ramp is a control, because "toon" is not one look:
//
//   bands     how many steps            2 is a hard cel, 6 is nearly smooth
//   bandLow   the shadow band's value   never 0 — see below
//   bandHigh  the lit band's value      under 255 keeps a white body off clipping
//   bandGamma where the steps FALL      >1 pushes the terminator into the light,
//                                       <1 drags it into the shadow. This is the
//                                       one that decides how much of the body
//                                       reads as lit, and it cannot be had by
//                                       moving the light without also moving
//                                       every highlight.
//   bandSoft  how sharp each step is    0 is a hard edge; above 0 the texture is
//                                       widened and the steps are blended across
//                                       a few texels, which is the only way to
//                                       soften a step without going back to a
//                                       gradient — see the filter note below.
//
// NearestFilter with soft 0 is the whole point of a cel look: a linear filter on
// an N-pixel texture interpolates between the steps and hands back exactly the
// smooth ramp the material was swapped in to get rid of. So softness is baked
// into the DATA at a higher resolution instead, and the filter stays nearest.
function gradientMap(o = {}) {
  const bands = Math.max(2, (o.bands ?? 3) | 0);
  const low = o.bandLow ?? 70;
  const high = o.bandHigh ?? 255;
  const gamma = o.bandGamma ?? 1;
  const soft = Math.max(0, Math.min(1, o.bandSoft ?? 0));

  // A hard ramp needs exactly one texel per band. A soft one needs room to
  // blend in, so it is oversampled and each texel decides which band it is in.
  const res = soft > 0 ? Math.max(bands * 16, 64) : bands;
  const data = new Uint8Array(res * 4);
  for (let i = 0; i < res; i++) {
    // Position along the ramp, gamma-shaped. Applied to the LOOKUP rather than
    // to the output value, so it moves where the steps sit instead of how bright
    // they are — brightness is what bandLow/bandHigh are for.
    const t = res === 1 ? 0 : i / (res - 1);
    const shaped = Math.pow(t, gamma);
    const scaled = shaped * bands;
    let step = Math.min(bands - 1, Math.floor(scaled));
    let level = bands === 1 ? 1 : step / (bands - 1);
    if (soft > 0) {
      // Distance into this band, 0..1. Only the first `soft` of each band is a
      // ramp from the previous level; the rest is flat, so the bands stay
      // visible as bands however soft the transitions get.
      const frac = scaled - step;
      if (frac < soft && step > 0) {
        const prev = (step - 1) / (bands - 1);
        level = prev + (level - prev) * (frac / soft);
      }
    }
    // Never reaches 0: the darkest band is a shadow, not a hole. A body whose
    // shadow side reaches black is indistinguishable from the outline around it
    // at icon size, which welds the silhouette shut.
    const val = Math.round(low + (high - low) * level);
    data.set([val, val, val, 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, res, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// A normal averaged across every vertex that shares a position.
//
// THIS IS WHY AN INVERTED-HULL OUTLINE COMES OUT JAGGED. Exporters split
// vertices wherever the shading or the UVs break — a hard crease, a texture
// seam, the edge of a fin — so one point in space becomes several vertices with
// DIFFERENT normals. The real mesh does not care: each triangle uses its own
// copy. The shell does, because it pushes each copy along its own normal, so at
// every seam the shell tears open and the rim shows notches, spikes and gaps
// exactly along the lines the modeller creased.
//
// Welding by position and averaging gives one direction per point, so the shell
// expands as a single surface. The seams stay in the model's own shading; only
// the offset stops using them.
//
// Quantised into a key rather than compared exactly: positions that a modeller
// welded can still differ in the last bits after an export round trip, and two
// vertices a hair apart are the same corner as far as a rim is concerned.
function smoothNormals(geometry) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!pos || !nor) return null;
  const sums = new Map();
  const key = (i) => {
    const q = 1e4;
    return `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
  };
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const cur = sums.get(k);
    if (cur) {
      cur[0] += nor.getX(i); cur[1] += nor.getY(i); cur[2] += nor.getZ(i);
    } else {
      sums.set(k, [nor.getX(i), nor.getY(i), nor.getZ(i)]);
    }
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = sums.get(key(i));
    const len = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = s[0] / len;
    out[i * 3 + 1] = s[1] / len;
    out[i * 3 + 2] = s[2] / len;
  }
  return new THREE.BufferAttribute(out, 3);
}

// Swap every material for a toon one, keeping what identifies the animal.
//
// The base colour map is carried across — without it the whole roster comes out
// as untextured grey bodies, which is a worse version of the problem the toon
// pass is meant to fix. Only the SHADING is being replaced.
function toonify(root, opts, flatColor) {
  const ramp = gradientMap(opts);
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    // Toon shading is a function of the normal, so a model that ships without
    // them renders as one flat band. Nothing errors; it just looks unlit.
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const swapped = mats.map((m) => {
      // `flatColor` throws the file's own materials away and shades one tone.
      //
      // Two jobs. The first is the assets whose materials DO NOT SURVIVE THE
      // TRIP: beluga.fbx names its diffuse as an absolute D:\ path that cannot
      // resolve, and its body carries ten material slots of which six are pure
      // #000000 with no map, so the honest render of what the loader produced is
      // a black whale. The game never sees this because it lights the beluga
      // through an emissive mask (ASSETS.belugaDrone) — a treatment an icon
      // cannot borrow.
      //
      // The second is ART DIRECTION. Six of the fifteen renderable icons are
      // white marine mammals, and no camera angle makes a white body on a dark
      // hex into six distinguishable things. A deliberate tone per icon is the
      // lever that does, which is why this is authored per icon in the spec
      // rather than being beluga's private workaround.
      const t = new THREE.MeshToonMaterial({
        color: flatColor != null ? new THREE.Color(flatColor)
          : (m.color ? m.color.clone() : new THREE.Color(0xffffff)),
        map: flatColor != null ? null : (m.map ?? null),
        gradientMap: ramp,
        side: THREE.DoubleSide,
        transparent: flatColor == null && m.transparent === true && m.opacity < 1,
        opacity: flatColor != null ? 1 : (m.opacity ?? 1),
      });
      m.dispose?.();
      return t;
    });
    o.material = Array.isArray(o.material) ? swapped : swapped[0];
  });
}

// Drop meshes by name. For files that are an animal PLUS a scene.
//
// beluga.fbx ships 72 `buublesphere_NNN` meshes around the whale — a bubble
// field the game never instantiates. They are close enough to the body to
// survive the stray-geometry guard, so they pad the bounding sphere the camera
// frames on and the whale ends up smaller than every other icon for no visible
// reason.
function dropMeshes(root, pattern) {
  const doomed = [];
  root.traverse((o) => {
    if ((o.isMesh || o.isSkinnedMesh) && o.name.includes(pattern)) doomed.push(o);
  });
  for (const o of doomed) o.parent?.remove(o);
  return doomed.length;
}

function axisAverage(vec) {
  return (Math.abs(vec.x) + Math.abs(vec.y) + Math.abs(vec.z)) / 3;
}

// Copied from systems/outlines.js, and the comment there is why this is not
// just `obj.scale`: a SKINNED shell is a SIBLING of the mesh it copies, so
// walking its parents misses any scale on that mesh's own node — while the
// skeleton that places its vertices does carry it. morayeel.fbx is the live
// case, exported in centimetres with the 100 sitting on the mesh node. Get this
// wrong there and the eel's rim comes out a hundred times too wide: a solid
// black blob with an animal somewhere inside it.
function accumulatedScale(obj) {
  let s = 1;
  for (let o = obj; o; o = o.parent) s *= axisAverage(o.scale);
  const source = obj?.userData?.__outlineSource;
  if (source) s *= axisAverage(source.scale);
  return s;
}

// The solid black rim: an inverted hull, exactly as assets.js builds it.
//
// A back-facing copy of the geometry, pushed out along its normals and drawn
// BEFORE the model so the model wins the depth test everywhere the two overlap,
// leaving only the part that sticks out — the line.
//
// `width` is in WORLD units and is divided down per mesh, because the shader
// offsets in OBJECT space. A single hardcoded thickness across a roster whose
// source files range from centimetres to metres is the documented way to get an
// invisible rim on one model and a blob on the next.
function addOutline(root, width) {
  const targets = [];
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (o.userData.__isOutline) return;
    // A CLOSED TRANSPARENT VOLUME CANNOT HAVE ONE, and the failure is total.
    //
    // The rim is a back-facing hull, so on a sphere it is the sphere's own far
    // side — an opaque black disc filling the whole silhouette, drawn behind
    // whatever is inside. On the bubble around the seal that is not a subtle
    // artefact: the seal disappears and the icon is a grey circle. Lowering the
    // opacity does nothing, because the thing you are seeing through the glass
    // is the glass's own outline.
    //
    // A flat translucent mark — the aura rings, the beams — is fine and keeps
    // its line, so this is opted out of per part (`ink: false`) rather than
    // inferred from transparency.
    if (o.userData.__noInk) return;
    targets.push(o);
  });

  for (const mesh of targets) {
    // The welded normal, cached on the geometry so a second shell on the same
    // mesh does not pay for the walk again. Added to the geometry the REAL mesh
    // shares: an attribute no other shader declares costs one upload and is
    // otherwise inert, which is cheaper than cloning the buffers.
    if (!mesh.geometry.attributes.aOutlineNormal) {
      const smooth = smoothNormals(mesh.geometry);
      if (smooth) mesh.geometry.setAttribute('aOutlineNormal', smooth);
    }
    const smoothed = !!mesh.geometry.attributes.aOutlineNormal;

    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
    const uOutline = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uOutline = uOutline;
      // The welded normal when there is one, the raw one otherwise — a model
      // with no normal attribute at all still gets a rim rather than an error.
      const dir = smoothed ? 'aOutlineNormal' : 'normal';
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          `#include <common>\nuniform float uOutline;${smoothed ? '\nattribute vec3 aOutlineNormal;' : ''}`)
        // BEFORE skinning runs, so the shell deforms with the pose instead of
        // tearing away from it. `normal` rather than `objectNormal`: the latter
        // is defined by <beginnormal_vertex>, which MeshBasicMaterial does not
        // include, and referencing it fails to compile — which renders NOTHING
        // and reports nothing.
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n\ttransformed += ${dir} * uOutline;`);
    };

    let shell;
    if (mesh.isSkinnedMesh) {
      shell = new THREE.SkinnedMesh(mesh.geometry, mat);
      shell.bind(mesh.skeleton, mesh.bindMatrix);
      mesh.parent?.add(shell);           // sibling — the skeleton already places it
      shell.userData.__outlineSource = mesh;
    } else {
      shell = new THREE.Mesh(mesh.geometry, mat);
      mesh.add(shell);                   // child with an identity transform
    }
    shell.name = `${mesh.name}__outline`;
    shell.renderOrder = (mesh.renderOrder ?? 0) - 1;
    shell.userData.__isOutline = true;
    shell.frustumCulled = false;
    const s = accumulatedScale(shell);
    uOutline.value = s > 1e-6 ? width / s : width;
  }
}

// FBX clips hang off the loaded object rather than coming back beside it, the
// way glTF's do. Returning `[]` for them (as this did) is a silent downgrade:
// every FBX asset renders in its bind pose and the log says so in the same
// words it uses for a model that genuinely ships no animation, so there is
// nothing to notice. Three of the ability assets are FBX — the seagull, the
// beluga and the moray — and all three were being posed as specimens.
async function loadModel(spec) {
  const url = '/models/' + spec.file;
  if (spec.fmt === 'fbx') {
    const root = await new FBXLoader().loadAsync(url);
    return { root, clips: root.animations ?? [] };
  }
  const g = await new GLTFLoader().loadAsync(url);
  return { root: g.scene, clips: g.animations ?? [] };
}

// Keep only the mesh this asset actually uses, exactly as assets.js does.
//
// Several assets share one binary and pick a mesh out of it by index — the
// three fish packs are one file with three different fish in it.
function isolateMesh(root, index) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
  const target = meshes[index];
  if (!target) return meshes.length;
  const keep = new Set();
  for (let o = target; o; o = o.parent) keep.add(o);
  for (const m of meshes) if (!keep.has(m)) m.parent?.remove(m);
  return 1;
}

// Trim the transparent margin off a render.
//
// Reads the alpha channel to find the real bounds. A few pixels of padding are
// kept so antialiased edges are not clipped.
export function crop(canvas, pad = 6) {
  // WebGL canvases have no 2d context, so copy through one first.
  const src = document.createElement('canvas');
  src.width = canvas.width; src.height = canvas.height;
  const sctx = src.getContext('2d');
  sctx.drawImage(canvas, 0, 0);
  const { data, width, height } = sctx.getImageData(0, 0, src.width, src.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return src;                 // fully transparent: nothing to trim
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// Put the crop back in the middle of a square.
//
// The atlas wants the tight crop: its plates are laid out individually and the
// empty margin is wasted bytes. An ICON wants the opposite. Cropped tight, an
// orca comes out 4:1 and a scallop nearly 1:1, and dropped onto same-sized hex
// faces the scallop renders three times the orca — the crop has quietly turned
// "how long is this animal" into "how big is this icon".
export function pad(canvas) {
  const side = Math.max(canvas.width, canvas.height);
  const out = document.createElement('canvas');
  out.width = out.height = side;
  out.getContext('2d').drawImage(
    canvas,
    Math.round((side - canvas.width) / 2),
    Math.round((side - canvas.height) / 2),
  );
  return out;
}

// Everything up to but NOT including the camera.
//
// Split there deliberately, and it is what makes the picker usable: yaw, pitch
// and zoom only move the camera, so dragging re-renders without reloading a
// model, re-posing a rig or rebuilding an outline. Only the fields that change
// the SCENE (clipAt, flatColor, bands, outline, dropMeshes) need this called
// again.
// One primitive, built the way assets.js builds the same `shape`.
//
// Half the roster's icons are of abilities whose object IS a primitive — the
// stone is a rock, the mussel an elongated oval, the shrapnel an octahedron —
// and the other half need marks that exist only as shader passes in the game
// (the garlic aura, the calamari ring, a laser beam). Both come through here so
// a scene never has to name a mesh file that does not exist.
//
// GEOMETRY ONLY, at unit-ish size: the caller normalises every part to a
// bounding sphere of 1 before placing it, so the numbers here decide the SHAPE
// and nothing else. `elongate` is the one exception and it has to be a shape
// property rather than a scale, because normalising happens after it.
function makePrimitive(part) {
  const seg = part.segments ?? 32;
  let geo;
  switch (part.prim) {
    // A stone. The game displaces an icosphere with Perlin noise (systems/
    // rocks.js); a detail-1 icosahedron with its faces left flat reads as the
    // same lumpy pebble at icon size and needs no noise field.
    case 'rock': geo = new THREE.IcosahedronGeometry(1, 1); break;
    case 'icosahedron': geo = new THREE.IcosahedronGeometry(1, 0); break;
    case 'octahedron': geo = new THREE.OctahedronGeometry(1, 0); break;
    case 'sphere': geo = new THREE.SphereGeometry(1, seg, seg / 2); break;
    case 'oval':
      geo = new THREE.SphereGeometry(1, seg, seg / 2);
      geo.scale(part.elongate ?? 1.8, 1, 1);   // long axis on +X, the icon's forward
      break;
    case 'cone':
      geo = new THREE.ConeGeometry(1, part.height ?? 2.4, seg);
      geo.rotateZ(-Math.PI / 2);               // a cone points +Y; the icon's forward is +X
      break;
    case 'box':
      geo = new THREE.BoxGeometry(part.width ?? 2, part.height ?? 1, part.depth ?? 1);
      break;
    // The flat annulus every aura in this game is: garlic, calamari, the strike
    // ring, a splash. Laid in the XZ plane — the water's plane — so the shared
    // three-quarter camera sees it as an ellipse rather than as a line.
    case 'ring':
      geo = new THREE.RingGeometry(part.inner ?? 0.8, part.outer ?? 1, seg);
      geo.rotateX(-Math.PI / 2);
      break;
    case 'torus':
      geo = new THREE.TorusGeometry(1, part.tube ?? 0.12, 12, seg);
      geo.rotateX(-Math.PI / 2);
      break;
    // A motion streak or a beam: a capsule along +X, which is where every
    // oriented part's forward already points.
    case 'streak':
      geo = new THREE.CapsuleGeometry(part.tube ?? 0.16, part.length ?? 2.4, 4, 12);
      geo.rotateZ(-Math.PI / 2);
      break;
    // A RIBBON — a flat trail that CURVES, tapering to nothing at the tail.
    //
    // Not a streak with a bend in it: a streak is a capsule, and a capsule says
    // "fast in a straight line". What a homing shot needs to say is that the
    // path bent, and the only thing that says that is a curve. Flat rather than
    // a tube because a thin tube reads as wire at icon size, and double-sided
    // so it does not vanish edge-on halfway round the arc.
    //
    // Swept along +X like every other oriented part, with `curve` as how far
    // the tail lifts in Y — sign chooses the side, so two ribbons with opposite
    // signs read as a pair rather than as one drawn twice.
    //
    // WHERE THE HEAD LANDS, which is the thing to know when attaching one to
    // something. Every scene part is normalised to a bounding sphere of radius
    // 1 and recentred, so `length` and `width` set the ribbon's SHAPE and
    // `scale` sets its size — and the head ends up roughly one radius along +X
    // from the part's `at`, not at it. To hang a ribbon off a pebble, place it
    // about `scale` to the LEFT of the pebble rather than on top of it.
    case 'ribbon': {
      const len = part.length ?? 2.4;
      const bend = part.curve ?? 0.9;
      const w0 = part.width ?? 0.34;
      const steps = 28;
      const pos = [], idx = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Quadratic: flat at the head, all the bend gathered at the tail, which
        // is the shape a thing that has just turned leaves behind it.
        const x = -t * len;
        const y = bend * t * t;
        // Tapered on a curve rather than linearly — a linear taper still has
        // visible width at the tail and reads as a cut-off strip.
        const w = w0 * (1 - t) * (1 - t * 0.4);
        pos.push(x, y - w / 2, 0, x, y + w / 2, 0);
        if (i < steps) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      break;
    }
    default:
      throw new Error(`unknown prim "${part.prim}"`);
  }
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(part.color ?? 0xffffff),
    side: THREE.DoubleSide,
    transparent: (part.opacity ?? 1) < 1,
    opacity: part.opacity ?? 1,
    // Flat-shaded on purpose for the faceted shapes: smooth normals on a
    // 20-face icosahedron give a soft blob, and the whole point of the rock is
    // that the bands break across its facets.
    flatShading: part.prim === 'rock' || part.prim === 'icosahedron' || part.prim === 'octahedron',
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = part.prim;
  return mesh;
}

// Everything buildIcon used to do between loading a file and the toon pass.
//
// Lifted out unchanged so a SCENE can run it per part: the whole value of a
// composed icon is that the stone in it is the game's stone and the seal in it
// is the game's seal, posed by the game's clip — which means every part has to
// go through the same preparation a single-model icon does. A second copy of
// this would be a second set of answers to "which clip, at what time, with
// which materials fixed", and the drift would show up as one icon's seal not
// matching another's.
async function prepareModel(spec) {
  const { root, clips } = await loadModel(spec);
  if (spec.meshIndex != null) isolateMesh(root, spec.meshIndex);
  // Before anything measures the model, so the scenery cannot reach the frame.
  const dropped = spec.dropMeshes ? dropMeshes(root, spec.dropMeshes) : 0;

  // A skinned creature in its bind pose reads as a specimen, not an animal.
  // Sampling the clip a third of the way in gives it a real swimming shape — a
  // tail mid-beat, fins spread. `clipAt` overrides the third per spec: an icon
  // of the harp wants the frame where the note is leaving it.
  let posed = 'bind pose';
  let clipName = null, clipDuration = 0;
  if (clips.length) {
    // `clip` names one outright — a scene part wants the strike pose or the
    // bark, not whatever `swim` happens to be. Falling back to the swim/idle
    // pair keeps every existing spec framing exactly the pose it framed before.
    const wanted = spec.clip ?? spec.wantClips?.swim ?? spec.wantClips?.idle;
    const clip = (wanted && clips.find((c) => c.name === wanted)) || clips[0];
    if (clip && clip.duration > 0) {
      const at = spec.clipAt ?? 0.33;
      const mixer = new THREE.AnimationMixer(root);
      mixer.clipAction(clip).play();
      mixer.setTime(clip.duration * at);
      posed = `posed at ${(at * 100).toFixed(0)}% of "${clip.name}"`;
      clipName = clip.name;
      clipDuration = clip.duration;
    }
  }

  // The hammerhead is the one asset whose base colour lives outside its binary,
  // so without this it would render as flat untextured grey.
  if (spec.baseColorMap) {
    const tex = await new THREE.TextureLoader().loadAsync(spec.baseColorMap);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Same override assets.js honours: a sidecar on a model that ships no maps
    // of its own carries the baking tool's convention, not the model's.
    tex.flipY = spec.flipY ?? (spec.fmt === 'fbx');
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mm of mats) { mm.map = tex; mm.needsUpdate = true; }
      }
    });
  }

  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mm of mats) {
        mm.side = THREE.DoubleSide;      // several of these are single-sided fins
        if (mm.transparent && mm.opacity === 1) mm.transparent = false;
      }
    }
  });

  return { root, posed, clipName, clipDuration, dropped };
}

// ---------------------------------------------------------------------------
// THE MOTTLING
//
// furseal.glb has UVs and no image, so a seal rendered straight is one flat
// cream shape — which is what every shot out of this renderer was until now,
// and it is not what the animal looks like in the game. The pattern is
// procedural, so the icon can have the real one rather than an impression of
// it: the field, the paint pass and the uniform names all come from
// /src/systems/noiseGlsl.js, the same strings systems/noiseShader.js paints
// the live seal with.
//
// ONLY THE MOTTLING. The glow, the charge flash and the wet film are run-time
// gameplay layers that ship at strength 0 and have no state to be driven by in
// a still.
//
// AFTER toonify AND BEFORE addOutline, and both halves of that matter:
// toonify builds new materials (a clone drops onBeforeCompile, so attaching
// first would attach to a material that gets thrown away), and the outline
// shells are flat black basic materials that must not be painted.
// ---------------------------------------------------------------------------
function attachMottle(root, noise) {
  const n = { ...MOTTLE_DEFAULTS, ...(noise ?? {}) };
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m) || !('color' in m)) continue;
      seen.add(m);
      const u = {
        uNoiseSize: { value: n.size },
        uNoiseStrength: { value: n.strength },
        uNoiseContrast: { value: n.contrast },
        uNoiseColor: { value: new THREE.Color(n.color) },
        uNoiseBase: { value: new THREE.Color(n.baseColor) },
        uNoisePaint: { value: n.paint },
      };
      // GLOW UP! — the upgrade that makes the seal's own markings emit. Same
      // layer the game runs (GLOW_LAYERS_GLSL), riding the same `noiseLit` the
      // mottle pass above leaves in scope, so the icon is lit the way the
      // ability lights the animal rather than by a second effect that merely
      // looks similar. The charge flash in that block stays at strength 0: it
      // is the strike meter, and a still has no meter.
      const g = n.glow ? { ...GLOW_DEFAULTS, ...n.glow } : null;
      if (g) Object.assign(u, {
        uNoiseGlowColor: { value: new THREE.Color(g.color) },
        uNoiseGlowTip: { value: new THREE.Color(g.tip) },
        uNoiseGlowStrength: { value: g.strength },
        uNoiseGlowEdge: { value: g.edge },
        uNoiseGlowSoft: { value: g.soft },
        uNoiseGlowWhite: { value: g.white },
        uNoiseGlowPulse: { value: 1 },
        uNoiseGlowScale: { value: g.scale },
        uChargeColor: { value: new THREE.Color(0x7ad7ff) },
        uChargeTip: { value: new THREE.Color(0xffffff) },
        uChargeStrength: { value: 0 },
        uChargeEdge: { value: 0.7 },
        uChargeSoft: { value: 0.23 },
        uChargeWhite: { value: 0.35 },
        uChargePulse: { value: 1 },
        uChargeWave: { value: -1 },
        uChargeAxis: { value: new THREE.Vector3(1, 0, 0) },
        uChargeAxisMin: { value: -1 },
        uChargeAxisRange: { value: 2 },
      });
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + MOTTLE_VARYING_GLSL)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvNoisePos = transformed;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n'
            + MOTTLE_UNIFORMS_GLSL + '\n' + (g ? GLOW_UNIFORMS_GLSL + '\n' : '')
            + MOTTLE_VARYING_GLSL + '\n' + NOISE_FIELD_GLSL)
          .replace('#include <map_fragment>', '#include <map_fragment>\n' + MOTTLE_FRAGMENT_GLSL);
        if (g) {
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <dithering_fragment>', GLOW_LAYERS_GLSL + '\n#include <dithering_fragment>');
        }
      };
      // Two materials with identical parameters share a compiled program, and
      // the injection is not one of the parameters three.js keys on. Every
      // material here gets the SAME injection, so sharing is correct — but the
      // key still has to change, or a mottled material can be handed the
      // program compiled for an unmottled one earlier in the same page.
      m.customProgramCacheKey = () => (g ? 'mottle+glow' : 'mottle');
      m.needsUpdate = true;
    }
  });
  return seen.size;
}

// ---------------------------------------------------------------------------
// THE RING — a real 3D loop around the subject, not a graphic laid over it.
//
// Drawn as N tube segments with a cone on the end of each, so it reads as a
// cycle rather than as a torus. Built in WORLD space and added to the scene
// rather than to the holder: the holder is recentred by frame(), and a ring
// that moved with that recentring would drift off the body it is drawn around.
//
// RADIUS IS A MULTIPLE OF THE SUBJECT'S OWN, never world units. The renderer
// takes anything from a 0.18-unit pebble to a 14-unit whale, so a typed radius
// would mean a different picture for every model — and the way it fails is a
// ring either lost inside the animal or off the edge of the frame.
//
// The camera distance is derived from the radius buildIcon returns, so the
// ring's extent is folded into that number on the way out. Framing still
// CENTRES on the model, which is right: the seal is the subject and the ring
// is around it.
// ---------------------------------------------------------------------------
function buildRing(ring, modelRadius, toon) {
  const g = new THREE.Group();
  const arrows = Math.max(1, Math.round(ring.arrows ?? 4));
  const R = modelRadius * (ring.radius ?? 1.45);
  const tube = R * (ring.tube ?? 0.045);
  // How much of each arc is left empty in front of the next segment. In turns,
  // so it means the same thing at any arrow count.
  const gap = Math.min(0.9, Math.max(0, ring.gap ?? 0.16)) * (2 * Math.PI / arrows);
  const headLen = tube * 7;
  // The head eats its own length off the end of the tube, or the cone sits on
  // top of a segment that already reached the same point and the tip lands a
  // head further round than the arc it belongs to.
  const arc = Math.max(0.02, (2 * Math.PI / arrows) - gap - headLen / R);

  const colour = new THREE.Color(ring.color ?? 0x6fd3ff);
  const mat = toon
    ? new THREE.MeshToonMaterial({ color: colour })
    : new THREE.MeshStandardMaterial({ color: colour, roughness: 0.5, metalness: 0.1 });
  mat.transparent = (ring.opacity ?? 1) < 1;
  mat.opacity = ring.opacity ?? 1;

  const spin = (ring.spin ?? 0) * Math.PI / 180;
  for (let i = 0; i < arrows; i++) {
    const start = spin + i * (2 * Math.PI / arrows);
    const seg = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 10, 64, arc), mat);
    seg.rotation.z = start;
    g.add(seg);

    // TorusGeometry sweeps counter-clockwise from +X, so the arc ends at
    // `start + arc` and the tangent there is (-sin, cos, 0) — which is +Y
    // rotated by that same angle, and a cone points down +Y. So one rotation
    // about Z both places and aims the head.
    const a = start + arc;
    const head = new THREE.Mesh(new THREE.ConeGeometry(tube * 2.6, headLen, 14), mat);
    head.position.set(R * Math.cos(a), R * Math.sin(a), 0);
    head.rotation.z = a;
    head.translateY(headLen / 2);
    g.add(head);
  }

  g.rotation.x = (ring.tilt ?? 0) * Math.PI / 180;
  g.rotation.y = (ring.yaw ?? 0) * Math.PI / 180;
  // What the camera has to clear. The silhouette of a ring is never wider than
  // its own radius however it is tilted, so this is that plus the tube and the
  // head's half-width.
  g.userData.extent = R + tube * 2.6;
  return g;
}

export async function buildIcon(spec) {
  if ((spec.kind ?? 'render') === 'scene') return buildSceneIcon(spec);

  const { root, posed, clipName, clipDuration, dropped } = await prepareModel(spec);

  // Toon BEFORE the shells are built, or the pass would swap the rim's own
  // black MeshBasicMaterial for a lit toon one and the outline would light up.
  if (spec.toon) toonify(root, spec, spec.flatColor);
  if (spec.noise) attachMottle(root, spec.noise);

  const scene = makeScene(!!spec.toon);
  const holder = new THREE.Group();
  holder.add(root);
  orient(holder, spec.forward, spec.up);

  // ROLL, and yaw/pitch cannot substitute for it.
  //
  // The camera orbits with lookAt, which pins its up vector to world +Y — so
  // spinning it never rotates the subject WITHIN the frame. Any asset whose long
  // axis does not land on screen-X after orient is therefore stuck there: the
  // moray comes out as a vertical bar down the middle of a hexagon that is wider
  // than it is tall, and every angle in the orbit leaves it vertical.
  //
  // Rolls the MODEL rather than the camera, and before framing, so the bounding
  // sphere is measured on the pose that will actually be photographed.
  if (spec.roll) holder.rotateZ(spec.roll * Math.PI / 180);

  scene.add(holder);
  const strays = [];
  const radius = frame(holder, strays);

  // AFTER framing, and that ordering is load-bearing twice over. posedBox()
  // measures every mesh in the tree and picks the anchor by vertex count — a
  // shell is a mesh with EXACTLY the vertex count of the thing it copies, so
  // building them first both inflates the box by the rim and makes the anchor a
  // coin toss between a model and its own outline.
  if (spec.outline) addOutline(root, radius * spec.outline);

  // After framing, so the ring is sized off the radius the MODEL measured, and
  // after the outline, so posedBox never sees a tube it might pick as anchor.
  let framedRadius = radius;
  if (spec.ring?.enabled) {
    const ring = buildRing(spec.ring, radius, !!spec.toon);
    scene.add(ring);
    framedRadius = Math.max(radius, ring.userData.extent);
  }

  return { scene, radius: framedRadius, posed, strays, dropped, clipName, clipDuration };
}

// ---------------------------------------------------------------------------
// SCENES — an icon of a MOMENT rather than of an object.
//
// Thirty of the forty-eight upgrades grant no model: a stat, an aura, a rate.
// There is nothing to photograph, and the fallback for all thirty was the same
// two-letter monogram — which tells the player nothing about what the card
// does and makes the hive a wall of type. A scene is the answer: the stone the
// gun fires, the fish it goes through, the ring the aura draws. Every piece is
// the game's own asset, prepared through prepareModel() exactly as a single
// -model icon is, so a moment is composed of real objects rather than drawn.
//
// PARTS ARE NORMALISED, NOT PLACED IN WORLD UNITS. The sources run from a
// 0.18-unit pebble to a 14-unit whale, so a hand-typed offset would mean six
// different things across six scenes and every one of them would have to be
// re-found by eye. Instead each part is scaled to a bounding sphere of radius
// 1 and THEN multiplied by its own `scale`, so `scale: 0.3` always means "a
// third the size of the thing next to it" and `at: [2, 0, 0]` always means
// "two of those radii to the right". Same reason VFX in this project are never
// authored in world units.
//
// The axes after orient() are the icon's, not the model's: +X is the direction
// the subject faces, +Y is up, +Z is toward the viewer's side of the frame.
// ---------------------------------------------------------------------------

// Build one part, normalised to unit radius and placed. Returns the group plus
// the box it occupies, so the scene can frame on the union without re-walking
// every skinned vertex a second time.
async function buildPart(part, spec, strays) {
  const inner = new THREE.Group();
  let posed = part.prim ? part.prim : null;

  if (part.prim) {
    inner.add(makePrimitive(part));
  } else {
    const built = await prepareModel(part);
    inner.add(built.root);
    posed = built.posed;
    // Orientation is a fact about the FILE, so it comes off the asset table via
    // the generator — the same `forward`/`up` the game turns the model by.
    orient(inner, part.forward, part.up);
  }

  // Toon per part rather than once over the finished scene: `color` is the
  // per-part flat tone, and a single pass over the holder could only apply one.
  if (spec.toon) toonify(inner, spec, part.prim ? undefined : part.color);

  // Marked before the parts are merged, because addOutline runs once over the
  // finished scene and has no idea which part a mesh came from by then.
  if (part.ink === false) inner.traverse((o) => { o.userData.__noInk = true; });

  // Normalise: measure where the posed vertices actually are, put that box's
  // centre on the part's own origin, and scale the bounding sphere to 1.
  const box = posedBox(inner, strays);
  const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  inner.position.sub(centre);
  const sphere = new THREE.Sphere();
  if (!box.isEmpty()) box.clone().translate(centre.clone().negate()).getBoundingSphere(sphere);
  const r = sphere.radius || 0.5;

  // The placement, outermost so the normalise above is not disturbed by it.
  const outer = new THREE.Group();
  outer.add(inner);
  outer.scale.setScalar((part.scale ?? 1) / r);
  const [rx, ry, rz] = part.rot ?? [0, 0, 0];
  outer.rotation.set(rx * Math.PI / 180, ry * Math.PI / 180, rz * Math.PI / 180);
  const [px, py, pz] = part.at ?? [0, 0, 0];
  outer.position.set(px, py, pz);
  return { outer, posed };
}

async function buildSceneIcon(spec) {
  const parts = spec.parts ?? [];
  if (!parts.length) throw new Error('scene with no parts');

  const scene = makeScene(!!spec.toon);
  const holder = new THREE.Group();
  const strays = [];
  const notes = [];
  for (const part of parts) {
    const { outer, posed } = await buildPart(part, spec, strays);
    holder.add(outer);
    notes.push(`${part.prim ?? part.asset ?? '?'}${posed && !part.prim ? ` (${posed})` : ''}`);
  }

  if (spec.roll) holder.rotateZ(spec.roll * Math.PI / 180);
  scene.add(holder);

  // FRAMED ON THE UNION OF THE PLACED PARTS, and deliberately not through
  // frame()'s stray guard.
  //
  // That guard drops any mesh sitting more than twenty body radii from the
  // biggest one, which is exactly right for a single animal with a corrupt eye
  // bone and exactly wrong here: a scene's parts are far apart ON PURPOSE, and
  // the guard would read the composition as the fault and photograph one piece
  // of it. Each part has already been through the guard on its own, inside
  // buildPart, so a broken file is still caught — just against its own body
  // rather than against the stone flying past it.
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const centre = box.getCenter(new THREE.Vector3());
  holder.position.sub(centre);
  const sphere = new THREE.Sphere();
  box.translate(centre.clone().negate()).getBoundingSphere(sphere);
  const radius = sphere.radius || 1;

  // After framing, same ordering and same reason as the single-model path.
  if (spec.outline) addOutline(holder, radius * spec.outline);

  return {
    scene, radius, strays, dropped: 0, clipName: null, clipDuration: 0,
    posed: `${parts.length} parts — ${notes.join(', ')}`,
  };
}

// The camera, from two angles in degrees.
//
// The distance is derived rather than dialled in. A sphere of radius R fits a
// vertical fov f at d = R / sin(f/2), so this is that with 6% of air — enough
// that the crop has an antialiased edge to find rather than the canvas boundary.
//
// The defaults are the atlas's own hand-tuned vector to four figures: yaw -26,
// pitch 17.4 and 0.3% of extra distance reproduce (-0.42, 0.30, 0.86) exactly,
// so a spec naming neither is framed identically to before these were fields.
export function cameraFor(spec, radius) {
  const FOV = 30;
  const cam = new THREE.PerspectiveCamera(FOV, 1, radius / 100, radius * 40);
  const d = (radius / Math.sin((FOV / 2) * Math.PI / 180)) * 1.06 * (spec.zoom ?? 1.003);
  const yaw = (spec.yaw ?? -26) * Math.PI / 180;
  const pitch = (spec.pitch ?? 17.4) * Math.PI / 180;
  cam.position.set(
    d * Math.cos(pitch) * Math.sin(yaw),
    d * Math.sin(pitch),
    d * Math.cos(pitch) * Math.cos(yaw),
  );
  cam.lookAt(0, 0, 0);
  return cam;
}

// Downsample to the size the icon actually ships at.
//
// THE SECOND HALF OF "SMOOTH THE EDGES". The scene renders at 512 with a pixel
// ratio of 2 — 1024 real pixels — and an icon is used at 56. Something has to
// throw 94% of those pixels away, and which thing does it decides whether the
// rim is a clean line or a staircase. Doing it here, in one high-quality step
// from the full-resolution render, is a ~4x supersample of the final image;
// leaving it to an external `sips -Z` pass afterwards was resampling an already
// -cropped intermediate, and leaving it to the BROWSER at draw time is worst of
// all — the hive would scale a 900px PNG down to 56 on the fly, per tile.
function resize(canvas, side) {
  if (!side || (canvas.width <= side && canvas.height <= side)) return canvas;
  const scale = side / Math.max(canvas.width, canvas.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** The finished image for a spec: crop, pad back to square, downsample. */
export function finish(canvas, spec) {
  const cropped = spec.square ? pad(crop(canvas)) : crop(canvas);
  return resize(cropped, spec.outSize);
}

/** Build, render and hand back the PNG plus the line to log. Used by render.html. */
export async function shootToBlob(renderer, spec) {
  const built = await buildIcon(spec);
  renderer.render(built.scene, cameraFor(spec, built.radius));
  const shot = finish(renderer.domElement, spec);
  const blob = await new Promise((res) => shot.toBlob(res, 'image/png'));
  const note = (built.strays.length ? `  STRAY GEOMETRY DROPPED: ${built.strays.join('; ')}` : '')
    + (built.dropped ? `  dropped ${built.dropped} mesh(es) matching "${spec.dropMeshes}"` : '')
    + (spec.flatColor != null ? '  FLAT COLOUR (file materials ignored)' : '');
  return { blob, log: `${spec.key}: ${(blob.size / 1024).toFixed(0)}KB, ${built.posed}${note}` };
}
