import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { assetSignatureColor, assetBaseColor } from '../assets.js';
import { biolumUniformsOf } from './biolumSkin.js';

// ============================================================================
// WHAT COLOUR IS THIS ANIMAL, ACTUALLY — every colour that reaches its shader,
// weighted by how much of the body wears it.
//
// THE ONE-COLOUR ANSWER WAS A LIE AND THE ROSTER IS WHY. `assetBaseColor` gives
// a single hex per asset, read off the Look panel's tuned signature or the
// authored fallback, and for a death burst that is the right amount of
// information: one hue that says which fish. Ask it what a BOSS is made of and
// it is wrong in four different ways at once, because no two bosses keep their
// colour in the same place:
//
//   THE MEGALODON  four MeshPhysicalMaterials, every one of them color #ffffff
//                  with a 1024x1024 map. The animal's colour is in the TEXTURE
//                  and `material.color` is a multiplier of 1. Read the material
//                  and the answer is "white".
//   THE ORCA       one MeshStandardMaterial, also white, also no useful colour
//                  — the entire animal is painted by systems/biolumSkin.js, and
//                  its blacks and greys live in shader uniforms (uBioColorA/B/C,
//                  uBioShellColor). Read the material and the answer is "white"
//                  again, for a completely different reason.
//   THE KRAKEN     ten materials: some textured and white, some carrying real
//                  colours (#cdb6b4, #787878), one pure black. There is no
//                  "the" colour; there is a distribution.
//   THE KING CRAB  one MeshBasicMaterial at #0d1016 WITH a map. Both are real
//                  and the fragment is their product.
//
// So this gathers all of them and says how much of the animal each one covers.
// Weighted by TRIANGLE COUNT rather than by material count, because a boss
// whose eyes are their own material would otherwise have its eye colour count
// for as much as thirty thousand triangles of flank.
//
// WHITE IS NOT ALWAYS A COLOUR. A white `material.color` sitting under a map is
// a multiplier meaning "use the texture", and counting it makes every textured
// animal in the game come out pale grey. A white one with NO map is a genuinely
// white body. The two are indistinguishable from the value and are told apart
// by whether the map exists, which is the single most load-bearing line here.
//
// BLACK IS NOT ALWAYS A COLOUR EITHER, in the bioluminescent uniforms: an unset
// `uBioColorC` is #000000 and means "this slot is off", not "this animal is
// black". A pigment preset that really is black still has its shell colour and
// its body darken to say so.
//
// THE ELEMENTS ARE PART OF THE ANSWER. A boss dying with venom on it is a green
// animal for as long as the status runs, and the status is on the creature
// rather than in any material — see the `venomTimer` block in
// entities/enemies.js. They come in as swatches like everything else and are
// flagged `raw`, because unlike a hide they are authored bright and must not be
// put through the lift a near-black body needs.
//
// NOTHING HERE DECIDES WHAT THE COLOURS ARE FOR. This module answers "what is
// it made of"; the lift, the clamping and the mixing are the caller's opinion —
// see paletteFor in systems/bossBoom.js, which is what turns a hide into smoke.
// ============================================================================

const _c = new THREE.Color();
const _hsl = { h: 0, s: 0, l: 0 };

function cfg() {
  return CONFIG.bodyPalette ?? {};
}

// ---------------------------------------------------------------------------
// THE AVERAGE COLOUR OF A TEXTURE
// ---------------------------------------------------------------------------
// Moved here from systems/octoGrab.js, which asks the same question for the
// arm's grab tint and is now the second caller rather than the second
// implementation. Two averages of one texture would agree for a year and then
// disagree the first time one of them learned about alpha.
//
// TRANSPARENT PADDING IS SKIPPED. It is most of some atlases and is pure black
// in the colour channels, so averaging it in drags every creature toward dark —
// which on a roster of near-black hides is indistinguishable from the correct
// answer.
//
// THE BYTES ARE sRGB and everything downstream is linear. Converting on the way
// in is what stops a tint reading two stops brighter than the fish it came from.
const texCache = new WeakMap();
export function averageTextureColor(tex) {
  const img = tex?.image;
  if (!img || typeof document === 'undefined') return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  // NOT cached — a texture that has not decoded yet answers null now and a
  // real colour later, and caching the null would leave a late-landing model
  // wearing its material colour (plain white, for anything textured) for the
  // rest of the session.
  if (!w || !h) return null;
  const hit = texCache.get(tex);
  if (hit !== undefined) return hit;

  let out = null;
  try {
    const N = 16;
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, N, N);
      const data = ctx.getImageData(0, 0, N, N).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      if (n) {
        out = new THREE.Color().setRGB(
          r / (n * 255), g / (n * 255), b / (n * 255), THREE.SRGBColorSpace,
        );
      }
    }
  } catch {
    // A tainted image, or a context the browser declined. The callers all have
    // a fallback; a throw here would take down the frame a boss died on.
    out = null;
  }
  // Cached on the TEXTURE, not on the asset key: Texture.clone() shares the
  // upload but not the settings, and two parses of one file share nothing —
  // keying on the object is the only key that cannot be wrong. A WeakMap, so a
  // model swapped out under the game takes its averages with it and there is
  // no cache to invalidate.
  texCache.set(tex, out);
  return out;
}

// ---------------------------------------------------------------------------
// READING A TEXTURE AT A POINT
// ---------------------------------------------------------------------------
// The average above answers "what colour is this animal". This answers "what
// colour is this animal HERE", which is what systems/bossDissolve.js needs: a
// particle per vertex, each one wearing the colour of the skin it came off.
//
// DOWNSCALED TO 128 SQUARE ON THE WAY IN, so one boss costs 64KB rather than
// four megabytes and a lookup is an array index rather than a decode. At that
// size a vertex still lands on its own patch of the animal — the megalodon's
// gums come out pink and its flank grey — and the alternative is holding the
// full 1024x1024 for every material on the roster forever.
//
// flipY IS THE TRAP AND IT IS PER MODEL FORMAT. GLTFLoader leaves textures
// flipY false and FBX ones arrive true, so "which row is v = 0" has two
// answers in one project. Hardcode either and half the roster samples its own
// texture upside down — which for a fish is a body wearing its belly colour
// along its back, plausible enough to ship.
const sampleCache = new WeakMap();
const SAMPLE_N = 128;

function samplerFor(tex) {
  const img = tex?.image;
  if (!img || typeof document === 'undefined') return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!w || !h) return null;
  const hit = sampleCache.get(tex);
  if (hit !== undefined) return hit;

  let out = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_N;
    canvas.height = SAMPLE_N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, SAMPLE_N, SAMPLE_N);
      out = {
        n: SAMPLE_N,
        data: ctx.getImageData(0, 0, SAMPLE_N, SAMPLE_N).data,
        flipY: tex.flipY !== false,
        ox: tex.offset?.x ?? 0,
        oy: tex.offset?.y ?? 0,
        rx: tex.repeat?.x ?? 1,
        ry: tex.repeat?.y ?? 1,
      };
    }
  } catch {
    out = null;
  }
  sampleCache.set(tex, out);
  return out;
}

/**
 * The texture's colour at one UV, written into `out` (a THREE.Color) in the
 * working space.
 *
 * @returns true if it answered. False means there is nothing to sample — no
 *   texture, no canvas, an image that has not decoded — and the caller is
 *   expected to fall back rather than to draw whatever was in `out`.
 */
export function sampleTexture(tex, u, v, out) {
  const s = samplerFor(tex);
  if (!s) return false;
  // The asset pipeline sets repeat/offset per asset (see setAssetRepeat), and a
  // body sampled without them wears a slice of its own texture.
  let uu = u * s.rx + s.ox;
  let vv = v * s.ry + s.oy;
  uu -= Math.floor(uu);
  vv -= Math.floor(vv);
  const px = Math.min(s.n - 1, Math.max(0, Math.floor(uu * s.n)));
  // See the header: flipY decides which end of the image v = 0 is.
  const row = s.flipY ? 1 - vv : vv;
  const py = Math.min(s.n - 1, Math.max(0, Math.floor(row * s.n)));
  const i = (py * s.n + px) * 4;
  // Transparent is not a colour — a vertex whose UV lands in an atlas's padding
  // would otherwise come off pure black, which on a dark hide is invisible and
  // on a pale one is a hole.
  if (s.data[i + 3] < 8) return false;
  out.setRGB(s.data[i] / 255, s.data[i + 1] / 255, s.data[i + 2] / 255, THREE.SRGBColorSpace);
  return true;
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

function push(out, hex, weight, source, raw = false) {
  if (hex == null || !(weight > 0)) return;
  out.push({ hex, weight, source, raw });
}

// Is this colour a MULTIPLIER rather than a colour? See the header: white under
// a map means "use the texture", and it is the same value as a white animal.
function isNeutralWhite(col) {
  return col.r > 0.97 && col.g > 0.97 && col.b > 0.97;
}

function isBlack(col) {
  return col.r < 0.01 && col.g < 0.01 && col.b < 0.01;
}

function triCount(geo) {
  if (!geo) return 0;
  if (geo.index) return geo.index.count / 3;
  return (geo.attributes?.position?.count ?? 0) / 3;
}

function uniformHex(uniforms, name) {
  const v = uniforms?.[name]?.value;
  return v?.isColor ? v.getHex() : null;
}

function uniformNum(uniforms, name, fallback = 0) {
  const v = uniforms?.[name]?.value;
  return typeof v === 'number' ? v : fallback;
}

/**
 * Every colour on this creature's shaders, with the elemental statuses it is
 * carrying, as weighted swatches.
 *
 * READ IT AND DROP IT. The creature is going back to the pool; nothing returned
 * here holds a reference to it.
 *
 * @returns {{swatches: Array, mean: number, tris: number}|null}
 */
export function bodyPalette(e) {
  const c = cfg();
  const w = c.weights ?? {};
  const root = e?.visual?.isObject3D ? e.visual : (e?.mesh?.isObject3D ? e.mesh : null);
  const out = [];
  let tris = 0;

  if (root) {
    const seen = new Set();
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const n = triCount(o.geometry);
      if (!(n > 0)) return;
      for (const m of mats) {
        if (!m || m.userData?.__isOutline) continue;
        // NOT THE OUTLINE SHELL, above — it is a back-faced copy of the whole
        // body in a flat rim colour, so counting it would give every animal in
        // the game a large swatch of the same near-black and swamp the hide it
        // is drawn around. Same exclusion attachDamageGlow makes.
        //
        // The dedupe is per MATERIAL, but the triangles are counted per mesh:
        // a material shared by four meshes wears all four of them, and counting
        // it once would weigh a boss's main hide the same as its teeth.
        const first = !seen.has(m.uuid);
        seen.add(m.uuid);
        tris += n;

        const mapCol = averageTextureColor(m.map);
        if (mapCol) push(out, mapCol.getHex(), n * (w.texture ?? 1.4), 'texture');

        if (m.color) {
          _c.copy(m.color);
          // See the header: white under a map is a multiplier, white without
          // one is a white animal.
          if (!(m.map && isNeutralWhite(_c))) {
            push(out, _c.getHex(), n * (w.color ?? 1), 'color');
          }
        }

        if (m.emissive && !isBlack(m.emissive)) {
          const ei = m.emissiveIntensity ?? 0;
          if (ei > 0) {
            push(out, m.emissive.getHex(), n * (w.emissive ?? 0.8) * Math.min(2, ei), 'emissive');
          }
        }

        // THE BIOLUMINESCENT SKIN, which for the orca IS the animal — the
        // material under it is plain white and says nothing at all.
        // Through the accessor, not off userData: a material cloned by a
        // glow pass holds a dead JSON copy of the block. See biolumUniformsOf.
        const u = biolumUniformsOf(m);
        if (u && first) {
          // `pigment` is whether the pattern PAINTS the body or only lights it
          // (see systems/biolumSkin.js). Lit-only colours still belong in the
          // palette — they are on screen — but they cover less of the animal
          // than a pigment does.
          const pig = uniformNum(u, 'uBioPigment', 0) > 0.5 ? 1 : (c.litShare ?? 0.5);
          for (const [name, share] of [['uBioColorA', 1], ['uBioColorB', 1], ['uBioColorC', 0.8]]) {
            const hex = uniformHex(u, name);
            // An unset slot is #000000 and means "off", not "black" — see the
            // header. A genuinely black animal still says so through its shell
            // colour and its body darken.
            if (hex == null || hex === 0) continue;
            push(out, hex, n * (w.skin ?? 1.1) * share * pig, 'skin');
          }
          const shell = uniformHex(u, 'uBioShellColor');
          if (shell != null && shell !== 0) {
            push(out, shell, n * (w.skin ?? 1.1) * (c.shellShare ?? 0.6), 'shell');
          }
          // The eyes, gated on their own strength: at 0 they are not lit and
          // the uniform is just whatever colour the preset would use.
          const eye = uniformHex(u, 'uEyeColor');
          const eyeOn = uniformNum(u, 'uEyeStrength', 0);
          if (eye != null && eyeOn > 0) {
            push(out, eye, n * (w.eye ?? 0.15) * Math.min(1, eyeOn), 'eye');
          }
        }
      }
    });
  }

  // THE AUTHORED COLOUR. Whatever the Look panel has set for this asset, and the
  // species' own authored colour behind it — the one colour in the list a
  // person chose ON PURPOSE, so it is weighted against the whole body rather
  // than against a material, and it is what carries an animal whose every
  // material is white and untextured.
  //
  // THE FALLBACK IS NOT OPTIONAL, and leaving it out was a real hole: only 59
  // assets have a tuned look, so a boss without one — the kraken is one —
  // contributed nothing but measured greys and lost its authored maroon
  // entirely. The cloud came out accurate and anonymous, which is a worse
  // trade than the single tint it replaced.
  const key = e?.assetKey ?? e?.def?.asset ?? null;
  const tuned = key ? assetSignatureColor(key) : null;
  const authored = tuned ?? (key ? assetBaseColor(key) : null);
  if (authored != null) {
    push(out, authored, Math.max(1, tris) * (w.look ?? 1.2), tuned != null ? 'look' : 'authored');
  }

  // AND WHAT IS ON IT. An animal dying with venom on it is a green animal, and
  // no material on the body says so — the status lives on the creature (see the
  // elemental block in entities/enemies.js). Weighted by how much of the status
  // is left, so a dose that is about to lapse tints less than a fresh one.
  //
  // `raw`, because these are UI colours authored bright. A caller lifting a
  // near-black hide clear of the water must not put a vivid green through the
  // same correction — see paletteFor in systems/bossBoom.js.
  const els = CONFIG.biolum?.elements ?? {};
  const ref = Math.max(0.1, c.elementRef ?? 3);
  for (const [id, timer] of [
    ['venom', e?.venomTimer], ['chill', e?.chillTimer], ['infection', e?.infectTimer],
  ]) {
    const t = timer ?? 0;
    if (!(t > 0)) continue;
    const hex = els[id]?.color;
    if (hex == null) continue;
    push(out, hex, Math.max(1, tris) * (w.element ?? 2.2) * Math.min(1, t / ref), id, true);
  }
  // SHOCK HAS NO TIMER and that is a fact about the element rather than an
  // omission: it arcs to a second target and is over on the frame it lands, so
  // there is no state on the body to read. A boss that has just been shocked is
  // shown by the arc, not by the hide.

  if (!out.length) return null;
  return { swatches: merge(out, c), mean: meanOf(out), tris };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
// A boss arrives with a dozen swatches and half of them are the same colour
// twice — the texture average and the material colour of a plain body, three
// hull materials that share a hex. Left alone they are not wrong, they are
// SLOW and they crowd out the colours that make the animal distinctive: an
// eight-swatch cloud where six of the eight are the same grey reads as a
// one-colour cloud that cost eight times as much to work out.
//
// Merged in HSL rather than RGB because "the same colour" is a question about
// hue and lightness, and two greys a hue apart in RGB terms are one grey. Hue
// distance is wrapped and weighted by saturation, so two near-greys merge
// whatever their nominal hues are — the megalodon's hue is a meaningless 0 and
// so is the crab's.
function merge(list, c) {
  const tol = Math.max(0, c.merge ?? 0.08);
  const max = Math.max(1, Math.round(c.max ?? 6));
  const bins = [];
  for (const s of list) {
    _c.setHex(s.hex);
    _c.getHSL(_hsl, THREE.SRGBColorSpace);
    const h = _hsl.h;
    const sat = _hsl.s;
    const l = _hsl.l;
    let into = null;
    for (const b of bins) {
      // Two swatches are the same colour if they are close in lightness and in
      // saturation, and close in HUE ONLY AS FAR AS THEIR SATURATION MAKES HUE
      // MEAN ANYTHING. Without that last term every desaturated swatch keeps
      // its accidental hue and nothing merges.
      const dh = Math.min(Math.abs(h - b.h), 1 - Math.abs(h - b.h)) * Math.min(sat, b.s);
      if (b.raw !== s.raw) continue;
      if (Math.abs(l - b.l) < tol && Math.abs(sat - b.s) < tol * 2 && dh < tol) { into = b; break; }
    }
    if (into) {
      // The merged colour is the weighted average of the two, in linear, so a
      // heavy swatch is not moved far by a light one.
      const tw = into.weight + s.weight;
      into.r = (into.r * into.weight + _c.r * s.weight) / tw;
      into.g = (into.g * into.weight + _c.g * s.weight) / tw;
      into.b = (into.b * into.weight + _c.b * s.weight) / tw;
      into.weight = tw;
      into.sources.add(s.source);
      _c.setRGB(into.r, into.g, into.b);
      _c.getHSL(_hsl, THREE.SRGBColorSpace);
      into.h = _hsl.h; into.s = _hsl.s; into.l = _hsl.l;
    } else {
      bins.push({
        r: _c.r, g: _c.g, b: _c.b, h, s: sat, l,
        weight: s.weight, raw: s.raw, sources: new Set([s.source]),
      });
    }
  }
  bins.sort((a, b) => b.weight - a.weight);
  const kept = bins.slice(0, max);
  const total = kept.reduce((n, b) => n + b.weight, 0) || 1;
  return kept.map((b) => ({
    hex: _c.setRGB(b.r, b.g, b.b).getHex(),
    // Normalised so a caller can treat it as a probability without knowing how
    // many triangles a megalodon has.
    share: b.weight / total,
    raw: b.raw,
    sources: [...b.sources],
  }));
}

// The weighted average, in LINEAR — which is what "the colour of this animal"
// means to anything that is going to add light to a frame buffer. Averaging the
// hexes instead is an average of gamma-encoded bytes and lands about a stop off.
function meanOf(list) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const s of list) {
    _c.setHex(s.hex);
    r += _c.r * s.weight;
    g += _c.g * s.weight;
    b += _c.b * s.weight;
    n += s.weight;
  }
  if (!(n > 0)) return 0xffffff;
  return _c.setRGB(r / n, g / n, b / n).getHex();
}
