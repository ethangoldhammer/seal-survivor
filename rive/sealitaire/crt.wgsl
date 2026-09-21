// ============================================================================
// CRT — the Balatro treatment over the whole table: barrel curve, scanlines,
// an RGB shadow mask, a little chromatic split, a vignette and a slow
// flicker. Samples the 2-D canvas the table drew everything into.
//
// It is also the compositor: the water (surface.wgsl's finished picture,
// vortex + goo + sheet) underneath, then the scene (cards, premultiplied),
// and the seal ON BOTH SIDES of it — one canvas under the cards and one over
// them, drawn from the same mesh in the same box. The animal is in the OVER
// canvas nearly always: it is the thing on the table, not a shape under the
// glass. seal.wgsl decides which vertex lands where — a state can send the
// body under the cards, and a card held in the jaws is split across the two
// so the mouth closes around it.
//
// THE CARDS. The table draws a mask canvas in card z-order: every card on
// screen gets an ENTRY in the card table below and paints its whole rounded
// rectangle with that entry's index, so a card above covers the one under it
// and the stack resolves itself. For a masked pixel this pass maps the screen
// point back through that card's transform into card-local artboard px, and
// from there does two things — the window and the rim.
//
// THE WINDOW. A tank card's face (tanks.csv: the fish suit's 2-10, every A,
// J, Q and K) is a window onto a small 3-D scene (baitball.luau, fish.wgsl)
// drawn into a tile of the tank atlas. The scene canvas cannot hold a GPU
// canvas's picture, so the window is composited HERE. It is the whole card,
// rounded like the plate, and the card's INK — the rank — is drawn by the
// table into a second atlas with the plate hidden and laid over the tank
// here, so the creature swims under the numbers.
//
// THE RIM. A card carries no cream plate showing round its edge and no drop
// shadow of its own: what separates it from the water is a bevel a few px
// wide inside its outline, shaded by a MATERIAL — pearl, emissive, metallic,
// reflective, refractive, holographic, chrome. Its geometry is the same rounded-rect
// signed distance the window is keyed by, so the two can never drift apart:
// the window is `d <= 0`, the rim is the band just inside it. The mode is per
// ENTRY, not global — table.luau writes the tuner's number into every card
// today, and a rim per suit or per rank costs nothing more when it is wanted.
//
// The mask must be read with a NEAREST sampler (`point`, its own binding):
// filtered, the index blends across a card's outline, the window misses by a
// pixel or two and the plate under it shows as a hard pale line — which is
// what the rim is there to replace.
//
// Uniform layout:
//   row 0  res.xy, time, energy
//   row 1  curvature, scanline, aberration, vignette
//   row 2  seal box in uv: x0, y0, x1, y1
//   row 3  artboard w, h, card half w, half h (artboard px)
//   row 4  tank tile w, h (uv), ink tile w, h (uv)
//   row 5  card corner radius (artboard px), rim width (px), rim strength, beat
//   row 6  THE METAL (modes 2 and 6): tint 0 chrome grey .. 1 gold, body
//          brightness (x), grain strength 0..1, grain lines round the card
//   row 7  glint strength (x), glint width 0 tight .. 1 broad, mirror
//          strength (x, chrome), seam depth 0..1 (chrome)
//   row 8  THE TANK'S SCANLINES: strength 0..1, pitch (artboard px), scroll
//          (artboard px/s down the card), how much the background takes 0..1
//   then 56 entries x 5 rows:
//     [cx, cy, cos, sin] [scaleX, scaleY, tankU0, tankV0]
//     [inkU0, inkV0, hasTank, rimMode] [bgR, bgG, bgB, isRed]
//     [tiltX, tiltY, -, -]
//
// The entry is the card's draw matrix (table.luau cardMatrix: rotate, scale,
// then the tilt as two skews) and this pass INVERTS it, so the window, the
// rim and the ink land on the artboard's own rectangle whatever the card is
// doing. The tilt row is the one that was missing: without it a hovered or
// dragged card's plate leaned away from a flat window.
//
// THE SUITS. A card's face carries its colour twice. The tank's BACKGROUND is
// per card (tanks.csv `bg`), warm behind a red suit and cold behind a black
// one, so the family reads before the rank is even legible — the atlas is
// cleared to nothing and the background is composited HERE, which is what
// makes it per card rather than one clear for all 56 tiles. And the rank
// itself is lit: a red suit's glyph glows red, a black one's sits in a white
// feathered glow that PULSES ON THE BEAT (`beat`, an onset envelope from
// music.luau). A black glyph on a dark tank needs the light behind it to be
// black at all — without it the only legible choice is a pale ink, which is
// what this replaces.
// ============================================================================

struct U {
    a: vec4f,
    b: vec4f,
    c: vec4f,
    d: vec4f,
    e: vec4f,
    f: vec4f,
    g: vec4f,
    h: vec4f,
    // Named, not lettered: as `i` this field compiled to NOTHING — the pass
    // drew a flat artboard and no error reached any log. The build's 0
    // errors are the markup's; a WGSL shader that fails to compile renders
    // nothing and says nothing, so a frame that goes dark after a shader
    // edit is a compile error until proven otherwise.
    scan: vec4f,
    cards: array<vec4f, 280>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var water: texture_2d<f32>;
@group(0) @binding(3) var sealUnder: texture_2d<f32>;
@group(0) @binding(4) var sealOver: texture_2d<f32>;
@group(0) @binding(5) var mask: texture_2d<f32>;
@group(0) @binding(6) var fish: texture_2d<f32>;
@group(0) @binding(7) var samp: sampler;
// Group 0 is full (eight slots); the ink atlas and the mask's own nearest
// sampler ride in a second group.
@group(1) @binding(0) var ink: texture_2d<f32>;
@group(1) @binding(1) var point: sampler;

// The card's rounded rectangle, in card-local artboard px: negative inside.
fn sdCard(p: vec2f, half: vec2f, r: f32) -> f32 {
    let q = abs(p) - (half - vec2f(r));
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Its outward unit gradient, analytically rather than by differencing: in a
// corner it points out of that corner's centre, along an edge it is that
// edge's own axis. normalize() only runs on the corner branch, where at least
// one component is positive, so it is never handed a zero vector.
fn sdCardGrad(p: vec2f, half: vec2f, r: f32) -> vec2f {
    let s = sign(p + vec2f(1e-5));
    let q = abs(p) - (half - vec2f(r));
    if (q.x > 0.0 || q.y > 0.0) {
        return s * normalize(max(q, vec2f(0.0)));
    }
    if (q.x > q.y) {
        return vec2f(s.x, 0.0);
    }
    return vec2f(0.0, s.y);
}

// A cosine ramp, not a hue wedge: an iridescence built from clamp(|k-3|-1)
// bands hard at the primaries and reads as a painted rainbow stripe. This one
// has no edges in it at all, which is what a thin-film sheen looks like.
// 1 inside the card's outline, 0 outside, with a pixel of edge.
fn step_gate(d: f32) -> f32 {
    return smoothstep(0.6, -0.6, d);
}

fn iris(h: f32) -> vec3f {
    return 0.5 + 0.5 * cos(6.2831853 * (h + vec3f(0.0, 0.33, 0.67)));
}

// The rim, shaded. `d` is the card's signed distance and `lp` the point, both
// in card-local artboard px; `rot` is the card's (cos, sin), which turns the
// bevel's normal back into screen space so a tilted card's highlight tilts
// with it. Returns rgb and a coverage.
//
// The bevel is a true quarter-round: the normal rolls from pointing straight
// out of the card's edge to straight at the viewer over the band's width, so
// `a` sweeps 0 to pi/2 and the normal is unit length by construction rather
// than by a normalize that can divide by nothing.
fn rimShade(mode: i32, d: f32, lp: vec2f, half: vec2f, r: f32, rot: vec2f,
            uv: vec2f, t: f32, energy: f32, w: f32) -> vec4f {
    // Across the band: 0 at the card's outline, 1 where it meets the face.
    let x = clamp(-d / max(w, 0.5), 0.0, 1.0);
    let a = x * 1.5707964;
    let g = sdCardGrad(lp, half, r);
    let gs = vec2f(g.x * rot.x - g.y * rot.y, g.x * rot.y + g.y * rot.x);
    let n = vec3f(gs * cos(a), sin(a));

    let l = normalize(vec3f(-0.45, -0.6, 0.8));
    let v = vec3f(0.0, 0.0, 1.0);
    let hv = normalize(l + v);
    let ndl = max(dot(n, l), 0.0);
    let ndv = max(dot(n, v), 0.0);
    let fres = pow(1.0 - ndv, 3.0);
    let spec = pow(max(dot(n, hv), 0.0), 60.0);
    // Where we are around the perimeter: the phase a brushed grain and a
    // rainbow both run on, so the material travels the edge instead of
    // repeating identically on all four sides.
    let ang = atan2(lp.y, lp.x);

    // Every mode's texture reads happen for every mode: a sample inside an if
    // is non-uniform control flow and WebGPU rejects it.
    let rd = reflect(vec3f(0.0, 0.0, -1.0), n);
    let env = textureSample(water, samp, clamp(uv + rd.xy * 0.22, vec2f(0.002), vec2f(0.998))).rgb;
    let off = gs * (w * 3.4) * (1.0 - x) / u.a.xy;
    let b0 = textureSample(water, samp, clamp(uv + off * 1.18, vec2f(0.002), vec2f(0.998))).r;
    let b1 = textureSample(water, samp, clamp(uv + off, vec2f(0.002), vec2f(0.998))).g;
    let b2 = textureSample(water, samp, clamp(uv + off * 0.84, vec2f(0.002), vec2f(0.998))).b;

    // Chrome's mirror: the water round the card, blurred along the band's
    // tangent so the reflection streaks the way a brushed finish smears it.
    // Read here, unconditionally, for the same reason as the taps above.
    let tg = vec2f(-gs.y, gs.x) / u.a.xy;
    let rc = clamp(uv + rd.xy * 0.16, vec2f(0.002), vec2f(0.998));
    let sm = w * 2.0;
    let mir = (textureSample(water, samp, rc).rgb
             + textureSample(water, samp, clamp(rc + tg * sm, vec2f(0.002), vec2f(0.998))).rgb
             + textureSample(water, samp, clamp(rc - tg * sm, vec2f(0.002), vec2f(0.998))).rgb
             + textureSample(water, samp, clamp(rc + tg * sm * 2.2, vec2f(0.002), vec2f(0.998))).rgb
             + textureSample(water, samp, clamp(rc - tg * sm * 2.2, vec2f(0.002), vec2f(0.998))).rgb) * 0.2;

    let deep = vec3f(0.04, 0.13, 0.21);
    let pale = vec3f(0.80, 0.93, 0.96);
    var col = vec3f(0.0);
    if (mode == 1) {
        // Emissive: a lit pipe round the card, brighter as the table is. The
        // CRT's own bright-lift downstream is what blooms it.
        let tint = vec3f(0.32, 0.95, 1.0);
        let pulse = 0.80 + 0.20 * sin(ang * 2.0 - t * 1.7);
        col = tint * (0.85 + 1.10 * ndv) * pulse * (1.0 + 0.5 * energy) + pale * spec * 0.4;
    } else if (mode == 2) {
        // Metallic: a dark body, a fine circumferential grain, one hard glint.
        // The metal's numbers are the tuner's (rows 6 and 7 of the uniform,
        // `rim` in tuning.luau), shared with chrome below.
        let tint = mix(vec3f(0.86, 0.88, 0.90), vec3f(0.92, 0.78, 0.45), u.g.x);
        let brush = 1.0 - u.g.z * 0.28 * (0.5 - 0.5 * sin(ang * u.g.w));
        let sheen = pow(max(dot(n, hv), 0.0), mix(300.0, 40.0, u.h.y));
        col = tint * (0.10 + 0.62 * ndl * brush) * u.g.y;
        col += vec3f(1.0, 0.97, 0.90) * sheen * 1.8 * u.h.x + tint * fres * 0.45;
    } else if (mode == 3) {
        // Reflective: the table itself, mirrored off the bevel, darkened
        // where the bevel faces the viewer so the mirror reads as curved
        // metal rather than as a pane laid flat over the card's edge.
        col = env * (0.55 + 1.15 * fres) + pale * spec * 1.2;
        col += vec3f(0.50, 0.80, 0.90) * fres * 0.30;
    } else if (mode == 4) {
        // Refractive: the water BEHIND the card, bent hard by the bevel and
        // split per channel, with the two lines a glass edge actually shows —
        // the bright catch right on the outline, and the caustic where the
        // bevel flattens off into the face.
        col = vec3f(b0, b1, b2) * (1.15 + 0.85 * fres);
        col += pale * pow(1.0 - x, 7.0) * 0.55;
        col += pale * pow(x, 5.0) * 0.45;
        col += pale * spec * 1.2;
    } else if (mode == 5) {
        // Holographic: a pale sheen the hue rides on. The hue travels ROUND
        // the edge and drifts with the clock; it barely moves ACROSS the
        // band, because the band is only a few px wide on screen and a full
        // sweep over that width is not iridescence, it is four stripes.
        // Hue on its own, at full saturation, is a sticker: the white under
        // it is what makes it foil.
        let hue = fract(ang / 6.2831853 * 1.15 + ndv * 0.35 + t * 0.06);
        let spark = pow(fract(sin(dot(floor(uv * u.a.xy * 0.5), vec2f(12.9898, 78.233))) * 43758.547), 32.0);
        col = mix(vec3f(0.92, 0.96, 1.0), iris(hue), 0.72) * (0.30 + 1.05 * ndl + 0.45 * fres);
        col += pale * (spec * 0.9 + spark * 0.9);
    } else if (mode == 6) {
        // Chrome: the trim as a metal inlay. Not a bevel but a WIRE — a
        // half-round across the band, so the normal rolls from the outline
        // to the face and both edges catch light — with a brushed grain
        // running round the card. Three things light it, all from the scene:
        //   the water, mirrored off the wire and smeared along the grain
        //   (`mir`), which is where the caustics, the sky and the goo's
        //   colour arrive on the edge — a metal tints its reflection, so it
        //   comes through the body colour rather than over it;
        //   the key light's glint, anisotropic (Kajiya-Kay on the tangent),
        //   so it is a streak along the edge, not a dot, and it travels the
        //   perimeter on the clock and flares with the table's energy;
        //   a grazing sheen at the two edges (`fres`), the wire's own rim.
        // The face-side edge ends in a dark seam, which is what a bezel
        // shows where it meets the plate — the markup draws that line too.
        let wn = vec3f(gs * cos(x * 3.1415927), sin(x * 3.1415927));
        let ndlw = max(dot(wn, l), 0.0);
        // The metal's numbers are the tuner's: tint, body, grain (strength and
        // lines), glint (strength and width), mirror, seam — rows 6 and 7.
        let tint = mix(vec3f(0.86, 0.88, 0.90), vec3f(0.92, 0.78, 0.45), u.g.x);
        let brush = 1.0 - u.g.z * 0.18 * (0.5 - 0.5 * sin(ang * u.g.w + x * 5.0)) * 2.0;
        let t3 = vec3f(gs.y, -gs.x, 0.0);
        let tdh = dot(t3, hv);
        let streak = pow(max(1.0 - tdh * tdh, 0.0), mix(200.0, 30.0, u.h.y)) * max(dot(wn, l), 0.0);
        let travel = 0.55 + 0.45 * sin(ang * 3.0 - t * 1.3);
        let fw = pow(1.0 - max(wn.z, 0.0), 2.5);
        col = tint * (0.18 + 0.55 * ndlw) * brush * u.g.y;
        col += mir * tint * (0.70 + 0.90 * fw) * (1.0 + 0.4 * energy) * u.h.z;
        col += vec3f(1.0, 0.98, 0.94) * streak * (1.6 + 1.4 * travel) * (1.0 + 0.8 * energy) * u.h.x;
        col += pale * fw * 0.35;
        col *= 1.0 - u.h.w * smoothstep(0.82, 1.0, x);
    } else {
        // Pearl: the plain bevel, the shape of the thing with no material on it.
        col = mix(deep, pale * 0.85, ndl) + pale * spec * 0.7 + vec3f(0.35, 0.70, 0.80) * fres * 0.3;
    }

    // Solid across the band and gone by the time the bevel faces the viewer,
    // with one pixel of edge at the card's outline. Chrome is an inlay with a
    // seam, not a bevel that flattens into the face, so it holds to the last
    // pixel instead.
    var cov = smoothstep(0.6, -0.6, d) * (1.0 - smoothstep(0.80, 1.0, x));
    if (mode == 6) {
        cov = smoothstep(0.6, -0.6, d) * (1.0 - smoothstep(0.96, 1.0, x));
    }
    return vec4f(col, cov);
}

struct Card {
    face: vec3f,   // a tank window's colour, its ink already laid over
    hit: f32,      // 1 where that window covers this pixel
    rim: vec4f,    // the rim: rgb and coverage
};

// The card under this screen point, if the mask says there is one.
fn cardAt(uv: vec2f, t: f32, energy: f32) -> Card {
    // NEAREST: a filtered read blends two entries' indices across an outline
    // and the window misses by a pixel. See the note at the top.
    let m = textureSample(mask, point, uv);
    let idx = i32(round(m.r * 255.0 / 4.0));
    let half = u.d.zw;
    let r = u.f.x;
    // Sample the atlases unconditionally (uniform control flow), then decide.
    var hit = 0.0;
    var tuv = vec2f(0.0);
    var iuv = vec2f(0.0);
    // Off any card: far outside, so the rim's band is empty and its gradient
    // still has a defined answer.
    var d = 1.0e9;
    var lp = vec2f(0.0);
    var rot = vec2f(1.0, 0.0);
    var mode = 0;
    var bg = vec3f(0.0);
    if (idx >= 1 && idx <= 56) {
        let e0 = u.cards[(idx - 1) * 5];
        let e1 = u.cards[(idx - 1) * 5 + 1];
        let e2 = u.cards[(idx - 1) * 5 + 2];
        let e3 = u.cards[(idx - 1) * 5 + 3];
        let e4 = u.cards[(idx - 1) * 5 + 4];
        bg = e3.rgb;
        let p = uv * u.d.xy - e0.xy;
        // Undo the card's rotation and scale...
        let sx = (p.x * e0.z + p.y * e0.w) / max(0.01, e1.x);
        let sy = (-p.x * e0.w + p.y * e0.z) / max(0.01, e1.y);
        // ...then the tilt. cardMatrix is R * S * Kx * Ky with Kx = [1 kx; 0 1]
        // and Ky = [1 0; ky 1], so after S^-1 R^-1 come Kx^-1 then Ky^-1.
        // The skews are dimensionless and `fit` is uniform, so they commute
        // with the screen scale folded into `half`.
        let kx = e4.x;
        let ky = e4.y;
        let lx = sx - kx * sy;
        let ly = sy - ky * lx;
        lp = vec2f(lx, ly);
        rot = e0.zw;
        mode = i32(round(e2.w));
        d = sdCard(lp, half, r);
        if (e2.z > 0.5 && d <= 0.0) {
            hit = 1.0;
            let c = vec2f(lx / half.x * 0.5 + 0.5, ly / half.y * 0.5 + 0.5);
            tuv = e1.zw + c * u.e.xy;
            iuv = e2.xy + c * u.e.zw;
        }
    }
    let f = textureSample(fish, samp, tuv);
    let k = textureSample(ink, samp, iuv);
    let rim = rimShade(mode, d, lp, half, r, rot, uv, t, energy, u.f.y);
    let strength = u.f.z;
    var o: Card;
    // Both atlases are PREMULTIPLIED, and both are composited the same way.
    // The tank atlas is cleared to nothing, so `f` is the bodies over the
    // card's own background — `f.rgb * f.a` would look identical on a body
    // and lose a quarter of the colour on every antialiased edge of one.
    // THE TANK'S SCANLINES, in the CARD's own space (`lp` is artboard px,
    // rotated with the card) so they lie across the window like the lines
    // of a little screen set into the plate, and rotate with it. Mean
    // preserving — a line's dark and its bright sum to no change — so the
    // slider changes the texture and not the exposure. `bg` says whether
    // the water behind the bodies takes them too, or only the bodies.
    let scan = 1.0 + u.scan.x * 0.5 * cos((lp.y + t * u.scan.z) * 6.2831853 / max(0.75, u.scan.y));
    let body = f.rgb * scan + bg * (1.0 - f.a) * mix(1.0, scan, u.scan.w);
    o.face = body * (1.0 - k.a) + k.rgb;
    o.hit = hit;
    o.rim = vec4f(rim.rgb * strength, rim.a * clamp(strength, 0.0, 1.0));
    return o;
}

fn layer(uv: vec2f) -> vec3f {
    var col = textureSample(water, samp, uv).rgb;
    // The seal under the cards, mapped from its box; outside the box the
    // sample is clamped to the edge, so it is masked by the box test. Empty
    // unless a state has swum the body under them or a card is in the mouth.
    let box = u.c;
    let suv = (uv - box.xy) / (box.zw - box.xy);
    let s = textureSample(sealUnder, samp, suv);
    let inBox = step(box.x, uv.x) * step(uv.x, box.z) * step(box.y, uv.y) * step(uv.y, box.w);
    col = col * (1.0 - s.a * inBox) + s.rgb * inBox;
    let c = textureSample(tex, samp, uv);
    col = col * (1.0 - c.a) + c.rgb;
    // The tanks, in place of the card faces they belong to, ink and all, and
    // then the rim over the card's own edge.
    let cd = cardAt(uv, u.a.z, u.a.w);
    col = mix(col, cd.face, cd.hit);
    col = mix(col, cd.rim.rgb, cd.rim.a);
    // The seal over the cards: the whole animal, save for whatever the other
    // canvas took — the body while a state swims it under the table, the
    // lower jaw while the mouth is closed on a card.
    let t = textureSample(sealOver, samp, suv);
    return col * (1.0 - t.a * inBox) + t.rgb * inBox;
}

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: VSOut;
    o.pos = vec4f(p[vi], 0.0, 1.0);
    o.uv = vec2f(p[vi].x * 0.5 + 0.5, 1.0 - (p[vi].y * 0.5 + 0.5));
    return o;
}

fn curve(uv: vec2f, k: f32) -> vec2f {
    var c = uv * 2.0 - 1.0;
    let r2 = dot(c, c);
    c *= 1.0 + k * r2;
    return c * 0.5 + 0.5;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let res = u.a.xy;
    let t = u.a.z;
    let energy = u.a.w;
    let k = u.b.x;
    let scan = u.b.y;
    let aber = u.b.z * (1.0 + energy * 0.7);
    let vig = u.b.w;

    let uv = curve(in.uv, k);
    // Outside the curved screen is black; decided AFTER sampling so every
    // textureSample stays in uniform control flow (WebGPU rejects an early
    // return around one).
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);

    // Chromatic split radially from the centre, stronger at the edges.
    let dir = (uv - 0.5) * aber;
    let r = layer(uv + dir).r;
    let g = layer(uv).g;
    let b = layer(uv - dir).b;
    var col = vec3f(r, g, b);

    // Scanlines and a subtle shadow mask.
    let line = 0.5 + 0.5 * sin(uv.y * res.y * 3.14159 * 1.0 + t * 0.5);
    col *= 1.0 - scan * (1.0 - line) * 0.6;
    let px = floor(in.uv.x * res.x);
    let m = px - 3.0 * floor(px / 3.0);
    var mask = vec3f(1.0);
    if (m < 1.0) { mask = vec3f(1.0, 0.86, 0.86); }
    else if (m < 2.0) { mask = vec3f(0.86, 1.0, 0.86); }
    else { mask = vec3f(0.86, 0.86, 1.0); }
    col *= mix(vec3f(1.0), mask, scan * 0.6);

    // Bloom-ish lift of the brights, flicker, vignette.
    let lum = dot(col, vec3f(0.299, 0.587, 0.114));
    col += col * smoothstep(0.55, 1.0, lum) * 0.25;
    col *= 0.97 + 0.03 * sin(t * 37.0);
    let e = uv * (1.0 - uv);
    col *= mix(1.0, pow(e.x * e.y * 16.0, 0.28), vig);

    // Edge glow, so the screen reads as glass.
    let edge = 1.0 - smoothstep(0.0, 0.03, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    col += vec3f(0.06, 0.16, 0.22) * edge;

    return vec4f(col * inside, 1.0);
}
