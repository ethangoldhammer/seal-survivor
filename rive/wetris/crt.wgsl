// ============================================================================
// CRT — wetris's compositor, its tiles, its drips, and the screen treatment.
//
// THE SCREEN TREATMENT is sealitaire's crt.wgsl, line for line from `curve`
// down: barrel curve, scanlines, the RGB shadow mask, a chromatic split that
// widens with the energy, the bright-lift, flicker, vignette and the edge
// glow. That half is what makes the two games look like one family, so it is
// copied, not reinterpreted — change one, change both.
//
// THE PICTURE, bottom to top:
//   water      surface.wgsl's finished sheet (vortex + goo + light)
//   under      the well's floor and outline (a 2-D canvas)
//   shadows    every tile's, cast down-right onto the water and the well —
//              laid first, so every tile is drawn OVER every shadow
//   goo        the drips (drips.luau), BEHIND the tiles: one metaball field
//              with the colour accumulated by density and divided back out —
//              Blubberball's goo pass — and a GEL term from every tile near
//              the point, so goo bridges out of the piece's outline, necks
//              off it and clings to the pile it lands on
//   tiles      FAUX 3-D, drawn here rather than as paths: a rounded top face
//              with a quarter-round BEVEL whose normal is real, an EXTRUDED
//              side swept out behind it away from the light, and wet shading —
//              a hard highlight, the water mirrored in the bevel by Fresnel,
//              a cool rim, and a slow film of sheen moving over the flat.
//              The stack's tiles take the INK (inkAt: every cell's own colour,
//              run into its ripe neighbours); the live piece and the previews
//              are FREE tiles with a position, size and turn of their own
//   scene      the 2-D canvas: the ghost, the flash, the readout
//   seal       over everything
//
// Every texture read below a function boundary is textureSampleLevel: the
// tiles and drips are loops with early-outs, which is non-uniform control
// flow, and only the explicit-level read is legal in it.
//
// The light is the one the seal, the goo and the surface use.
//
// Uniform layout: see ink.luau (it owns the offsets).
// ============================================================================

struct U {
    a: vec4f,      // res.xy (device px), time, energy
    b: vec4f,      // curvature, scanline, aberration, vignette
    well: vec4f,   // the well's top-left and one cell's size, in uv
    grid: vec4f,   // cols, rows, mix reach (cells), swirl (cells)
    art: vec4f,    // artboard w, h (px), free-tile count, drip count
    look: vec4f,   // bevel (of a cell), extrude (of a cell), gloss, film
    look2: vec4f,  // shadow, reflect, drip iso, drip height
    look3: vec4f,  // gel strength (of the iso), gel reach (of a cell), fuse reach (of a cell), fuse amount
    post: vec4f,   // grain, grain size (px), shadow mask, bright lift
    post2: vec4f,  // flicker, flicker rate, edge glow, scanline drift
    look4: vec4f,  // skirt tint, skirt reach (of a cell), -, -
    cells: array<vec4f, 200>,
    free: array<vec4f, 48>,    // cx, cy, size, turn | rgb, alpha
    drips: array<vec4f, 128>,  // x, y, r, alpha | rgb, -
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var water: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var seal: texture_2d<f32>;
@group(0) @binding(5) var under: texture_2d<f32>;
// goo.wgsl's canvas (half size, premultiplied), for where the skirt is.
@group(0) @binding(6) var gooTex: texture_2d<f32>;

const LUMA = vec3f(0.2126, 0.7152, 0.0722);
const LIGHT = vec3f(-0.4465, -0.5953, 0.6680);   // normalize(-0.45, -0.6, 0.8)
// Away from the light, on screen: where an extruded side and a shadow fall.
const AWAY = vec2f(0.6, 0.8);
const INSET = 0.93;      // a tile's top face, of its cell
const ROUND = 0.22;      // its corner radius, of its cell

fn hash(p: vec2f) -> f32 {
    let h = dot(p, vec2f(127.1, 311.7));
    return fract(sin(h) * 43758.5453123);
}

fn vnoise(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let s = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), s.x),
               mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), s.x), s.y);
}

fn rot2(v: vec2f, a: f32) -> vec2f {
    let c = cos(a);
    let s = sin(a);
    return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

// ---------------------------------------------------------------------------
// THE INK — the stack's colour at a point (ink.luau has the idea). Every
// locked cell is a splat of its own colour; the colour here is their
// kernel-weighted average. A cell's reach grows with its ripeness (w, 0 just
// locked .. 1 fully run), and a NEIGHBOUR only counts in proportion to its own
// ripeness too, so colour creeps outward from a lock. The swirl warps the
// point on a slow noise before it is read, more the riper the cell, so a
// settled stack marbles. The average keeps the chroma of what went into it,
// so it marbles rather than going to mud.
fn inkAt(uv: vec2f) -> vec3f {
    let t = u.a.z;
    let cols = i32(u.grid.x);
    let rows = i32(u.grid.y);
    var p = (uv - u.well.xy) / max(u.well.zw, vec2f(1e-6));
    let c = clamp(vec2i(floor(p)), vec2i(0, 0), vec2i(cols - 1, rows - 1));
    let own = u.cells[c.y * cols + c.x];
    // A point in an EMPTY cell is on a fillet the fuse grew into it: it takes
    // its neighbours' colour, as if its own cell were ripe.
    let ripe = select(max(own.w, 0.0), 1.0, own.w < 0.0);
    let sw = u.grid.w * ripe;
    p += (vec2f(vnoise(p * 0.45 + vec2f(t * 0.07, 1.3)), vnoise(p * 0.45 + vec2f(5.2, t * 0.06))) - 0.5) * 2.0 * sw;
    let r = mix(0.3, max(0.3, u.grid.z), ripe);
    var acc = vec3f(0.0);
    var chroma = 0.0;
    var total = 0.0;
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            let n = c + vec2i(dx, dy);
            if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows) { continue; }
            let cell = u.cells[n.y * cols + n.x];
            if (cell.w < 0.0) { continue; }
            let d = length(p - (vec2f(n) + 0.5));
            let k = exp(-(d * d) / (r * r));
            var w = k * max(cell.w, 0.02) * ripe;
            if (dx == 0 && dy == 0) {
                w = mix(1.0, k, ripe);
            }
            acc += cell.rgb * w;
            chroma += length(cell.rgb - vec3f(dot(cell.rgb, LUMA))) * w;
            total += w;
        }
    }
    if (total <= 1e-5) {
        return own.rgb;
    }
    let avg = acc / total;
    let l = dot(avg, LUMA);
    let now = length(avg - vec3f(l));
    let lift = clamp((chroma / total) / max(now, 1e-4), 1.0, 2.5);
    return clamp(vec3f(l) + (avg - vec3f(l)) * lift, vec3f(0.0), vec3f(1.0));
}

// ---------------------------------------------------------------------------
// ONE TILE. A rounded square `size` px across, centred at `c`, turned `turn`.
fn sdTile(q: vec2f, half: f32, r: f32) -> f32 {
    let d = abs(q) - vec2f(half - r);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

// The outward gradient of sdTile, analytic (a corner points out of its own
// centre, an edge along its axis).
fn sdTileGrad(q: vec2f, half: f32, r: f32) -> vec2f {
    let s = sign(q + vec2f(1e-5));
    let d = abs(q) - vec2f(half - r);
    if (d.x > 0.0 && d.y > 0.0) {
        return s * normalize(d);
    }
    if (d.x > d.y) {
        return vec2f(s.x, 0.0);
    }
    return vec2f(0.0, s.y);
}

// THE FUSE: the stack as ONE distance field instead of a tile per cell. Each
// locked tile is folded into a smooth union whose fillet grows between faces
// closer than `fuse reach` (the threshold) by `fuse amount` — and scaled by
// the pair's ripeness, the ink's own clock (the riper of the two sides can't
// pull the other along: both have to be ripe), so a piece lands as crisp
// tiles and melts into the pile at exactly the pace its colour runs into it.
// At amount 0 this is the plain union of the tiles, the old look exactly.
struct StackD {
    d: f32,         // signed distance to the fused top face, px
    g: vec2f,       // its gradient (not unit inside a fillet)
    rgb: vec3f,     // the nearest tile's colour
    ripe: f32,      // ...and its ripeness
};

fn stackAt(pp: vec2f, origin: vec2f, cellPx: f32) -> StackD {
    var o: StackD;
    o.d = 1e5;
    o.g = vec2f(0.0);
    o.rgb = vec3f(0.0);
    o.ripe = 0.0;
    let cols = i32(u.grid.x);
    let rows = i32(u.grid.y);
    let gc = vec2i(floor((pp - origin) / max(cellPx, 1e-3)));
    let half = cellPx * 0.5 * INSET;
    let rad = cellPx * ROUND;
    let k = max(u.look3.z * cellPx, 1e-3);
    let amt = u.look3.w;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let n = gc + vec2i(dx, dy);
            if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows) { continue; }
            let cell = u.cells[n.y * cols + n.x];
            if (cell.w < 0.0) { continue; }
            let q = pp - (origin + (vec2f(n) + 0.5) * cellPx);
            let d = sdTile(q, half, rad);
            let g = sdTileGrad(q, half, rad);
            // Quadratic smooth-min, its fillet depth scaled: d = min - A m^2 / 4k,
            // and its gradient exactly (the fillet term's derivative included).
            let a = amt * min(o.ripe, cell.w);
            let m = max(k - abs(o.d - d), 0.0);
            let nearer = d < o.d;
            let gm = select(o.g, g, nearer);
            let fd = min(o.d, d) - a * m * m / (4.0 * k);
            let fg = gm + a * m / (2.0 * k) * sign(o.d - d) * (o.g - g);
            o.d = fd;
            o.g = fg;
            if (nearer) {
                o.rgb = cell.rgb;
                o.ripe = cell.w;
            }
        }
    }
    return o;
}

struct Tile {
    d: f32,         // signed distance to the top face, px (negative inside)
    g: vec2f,       // its outward gradient, on screen
    top: f32,       // coverage of the top face
    n: vec3f,       // its normal
    side: f32,      // coverage of the extruded side (where the top is not)
    sideT: f32,     // 0 at the top face's edge .. 1 at the far end of the side
    shadow: f32,    // the shadow it casts here
};

fn tileAt(pp: vec2f, c: vec2f, size: f32, turn: f32) -> Tile {
    var o: Tile;
    let half = size * 0.5 * INSET;
    let rad = size * ROUND;
    let q = rot2(pp - c, -turn);
    let d = sdTile(q, half, rad);
    o.d = d;
    o.top = smoothstep(0.8, -0.8, d);
    // THE BEVEL: a quarter round across `bevel` of the cell, so the normal
    // rolls from facing out of the edge to facing the viewer.
    let bw = max(1.0, u.look.x * size);
    let tb = clamp(-d / bw, 0.0, 1.0);
    let rise = 1.0 - tb;
    let slope = clamp(rise / max(sqrt(max(1.0 - rise * rise, 0.0)), 0.25), 0.0, 3.5);
    let g = rot2(sdTileGrad(q, half, rad), turn);
    o.g = g;
    o.n = normalize(vec3f(g * slope, 1.0));
    // THE SIDE: the face swept back along AWAY by the extrusion, sampled at
    // four depths — enough that no step shows at a cell's size.
    let ext = u.look.y * size;
    var sd = 1e5;
    var st = 1.0;
    for (var k = 1; k <= 4; k++) {
        let f = f32(k) / 4.0;
        let dk = sdTile(rot2(pp - c - AWAY * ext * f, -turn), half, rad);
        if (dk < sd) {
            sd = dk;
            st = f;
        }
    }
    o.side = smoothstep(0.8, -0.8, sd) * (1.0 - o.top);
    o.sideT = st;
    // THE SHADOW: soft, further down the same line, on whatever is under.
    let ds = sdTile(rot2(pp - c - AWAY * (ext * 1.8 + size * 0.05), -turn), half, rad);
    o.shadow = (1.0 - smoothstep(-size * 0.05, size * 0.3, ds)) * u.look2.x;
    return o;
}

// WET, the top face: toon-soft diffuse under the shared light, a film of
// sheen sliding over the flat, the water mirrored in the bevel by Fresnel, a
// cool rim, and two highlights — a hard one and a broad one.
fn shadeTop(base: vec3f, n0: vec3f, pp: vec2f, size: f32, uv: vec2f) -> vec3f {
    let t = u.a.z;
    let film = u.look.w;
    let fp = pp / max(size, 1.0);
    let wob = vec2f(vnoise(fp * 1.7 + vec2f(t * 0.35, 0.0)), vnoise(fp * 1.7 + vec2f(3.1, -t * 0.3))) - 0.5;
    let n = normalize(vec3f(n0.xy + wob * film * 0.35 * n0.z, n0.z));
    let ndl = dot(n, LIGHT);
    let h = normalize(LIGHT + vec3f(0.0, 0.0, 1.0));
    let ndh = max(dot(n, h), 0.0);
    var col = base * (0.42 + 0.7 * smoothstep(-0.1, 0.9, ndl));
    let fres = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.2);
    let env = textureSampleLevel(water, samp, clamp(uv + n.xy * 0.06, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
    col = mix(col, env * 1.25 + base * 0.2, clamp(fres * u.look2.y * 1.6, 0.0, 0.85));
    col += vec3f(0.35, 0.75, 0.85) * fres * 0.35;
    let gloss = u.look.z;
    col += vec3f(1.0) * (pow(ndh, 90.0) * 1.6 + pow(ndh, 14.0) * 0.12) * gloss;
    // The sheen: a moving caustic-like glint across the flat of the face.
    let sheen = smoothstep(0.62, 0.8, vnoise(fp * 2.3 + vec2f(t * 0.5, t * 0.21))) * n0.z * film;
    col += vec3f(0.9, 0.97, 1.0) * sheen * 0.22 * gloss;
    return col;
}

// The side: the tile's own colour in shade, darker the deeper it goes, with a
// wet lip of light where it meets the top.
fn shadeSide(base: vec3f, st: f32) -> vec3f {
    var col = base * mix(0.5, 0.26, st);
    col += vec3f(0.8, 0.92, 1.0) * smoothstep(0.35, 0.0, st) * 0.18 * u.look.z;
    return col;
}

// ---------------------------------------------------------------------------
// THE GOO: the drips as one metaball field, colour by density — and the
// GEL. Every tile near the point adds a term that falls off over `gel reach`
// outside its edge, peaking at `gel` of the iso: under the threshold on its
// own, so a tile never grows a halo, but a drop near a tile pushes the sum
// over it and the goo BRIDGES — a forming drop welds out of the piece's
// outline, a falling one necks off it, a landed one clings to the pile.
struct Goo {
    a: f32,
    col: vec3f,
};

struct Gel {
    d: f32,         // the nearest tile's signed distance, px
    g: vec2f,       // its outward gradient
    rgb: vec3f,     // its colour
};

fn gelTerm(gel: Gel, cellPx: f32, iso: f32) -> vec3f {
    // x = strength, yz = the term's gradient (pointing into the tile).
    let reach = max(1.0, u.look3.y * cellPx);
    let x = clamp(gel.d / reach, 0.0, 1.0);
    let k = 1.0 - x;
    let s = u.look3.x * iso;
    let w = k * k * k * s;
    let grad = -gel.g * (3.0 * k * k * s / reach) * step(0.0, gel.d);
    return vec3f(w, grad);
}

fn gooAt(pp: vec2f, uv: vec2f, gels: array<Gel, 2>, cellPx: f32) -> Goo {
    var o: Goo;
    o.a = 0.0;
    o.col = vec3f(0.0);
    let n = i32(u.art.w);
    let iso = u.look2.z;
    var f = 0.0;
    var g = vec2f(0.0);
    var acc = vec3f(0.0);
    for (var i = 0; i < 64; i++) {
        if (i >= n) { break; }
        let d0 = u.drips[i * 2];
        let R = max(d0.z * 2.2, 0.5);
        let v = pp - d0.xy;
        let x = dot(v, v) / (R * R);
        if (x >= 1.0) { continue; }
        let k = (1.0 - x);
        let w = k * k * k * d0.w;
        f += w;
        g += -6.0 * k * k * d0.w * v / (R * R);
        acc += u.drips[i * 2 + 1].rgb * w;
    }
    // No drop anywhere near: no goo, whatever the tiles are doing.
    if (f <= 0.0) {
        return o;
    }
    for (var k = 0; k < 2; k++) {
        let t = gelTerm(gels[k], cellPx, iso);
        f += t.x;
        g += t.yz;
        acc += gels[k].rgb * t.x;
    }
    o.a = smoothstep(iso - 0.06, iso + 0.06, f);
    if (o.a <= 0.0) {
        return o;
    }
    let base = acc / max(f, 1e-4);
    let nrm = normalize(vec3f(-g * u.look2.w, 1.0));
    let ndl = dot(nrm, LIGHT);
    let h = normalize(LIGHT + vec3f(0.0, 0.0, 1.0));
    let ndh = max(dot(nrm, h), 0.0);
    var col = base * (0.5 + 0.6 * smoothstep(-0.1, 0.9, ndl)) * mix(1.0, 0.8, smoothstep(iso, iso * 3.0, f));
    let fres = pow(1.0 - clamp(nrm.z, 0.0, 1.0), 2.0);
    let env = textureSampleLevel(water, samp, clamp(uv + nrm.xy * 0.05, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
    col = mix(col, env * 1.3, clamp(fres * u.look2.y, 0.0, 0.7));
    col += vec3f(1.0) * pow(ndh, 60.0) * 1.4 * u.look.z;
    col += vec3f(0.35, 0.75, 0.85) * fres * 0.3;
    o.col = col;
    return o;
}

// ---------------------------------------------------------------------------
// THE SKIRT'S COLOUR. goo.wgsl (sealitaire's, shared, so not touched here)
// draws the clinging water round the stack and the piece in the water's own
// teal; this is the colour of the blocks it clings to at a point — every
// stack cell and free tile near it, each weighted by how close its edge is,
// falling off over `skirt reach` — and w, how much block there is to take a
// colour from (0 out on the bare floor lining, which keeps its teal).
fn skirtAt(pp: vec2f, origin: vec2f, cellPx: f32, nf: i32) -> vec4f {
    let cols = i32(u.grid.x);
    let rows = i32(u.grid.y);
    let gc = vec2i(floor((pp - origin) / max(cellPx, 1e-3)));
    let reach = max(1.0, u.look4.y * cellPx);
    let half = cellPx * 0.5 * INSET;
    let rad = cellPx * ROUND;
    var acc = vec3f(0.0);
    var total = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let n = gc + vec2i(dx, dy);
            if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows) { continue; }
            let cell = u.cells[n.y * cols + n.x];
            if (cell.w < 0.0) { continue; }
            let d = max(sdTile(pp - (origin + (vec2f(n) + 0.5) * cellPx), half, rad), 0.0) / reach;
            let w = exp(-d * d);
            acc += cell.rgb * w;
            total += w;
        }
    }
    for (var i = 0; i < 24; i++) {
        if (i >= nf) { break; }
        let f0 = u.free[i * 2];
        if (length(pp - f0.xy) > f0.z + reach * 3.0) { continue; }
        let f1 = u.free[i * 2 + 1];
        let d = max(sdTile(rot2(pp - f0.xy, -f0.w), f0.z * 0.5 * INSET, f0.z * ROUND), 0.0) / reach;
        let w = exp(-d * d) * f1.a;
        acc += f1.rgb * w;
        total += w;
    }
    return vec4f(acc / max(total, 1e-4), total);
}

// ---------------------------------------------------------------------------
// THE BOARD over whatever is below, at one point, in depth order:
//   1. every tile's SHADOW, on the water and the well — so the stack and the
//      piece are drawn OVER shadows, never under them
//   2. the GOO, behind the tiles: forming drops show only where they bulge
//      past the outline, landed ones where they cling over an edge
//   3. the STACK's tiles, sides then tops
//   4. the FREE tiles (the piece, the previews), sides then tops
fn board(below: vec3f, uv: vec2f, gooPx: vec4f) -> vec3f {
    let pp = uv * u.art.xy;
    var col = below;
    let cols = i32(u.grid.x);
    let rows = i32(u.grid.y);
    let cellPx = u.well.z * u.art.x;
    let origin = u.well.xy * u.art.xy;
    let gp = (pp - origin) / max(cellPx, 1e-3);
    let gc = vec2i(floor(gp));
    let nf = i32(u.art.z);
    var gels: array<Gel, 2>;
    gels[0].d = 1e5;
    gels[0].g = vec2f(0.0);
    gels[0].rgb = vec3f(0.0);
    gels[1].d = 1e5;
    gels[1].g = vec2f(0.0);
    gels[1].rgb = vec3f(0.0);

    // THE STACK, measured as one fused field (stackAt): the top face here,
    // the extruded side swept back along AWAY at four depths, and the shadow
    // further down the same line. The gel wants the top face.
    let ext = u.look.y * cellPx;
    let st0 = stackAt(pp, origin, cellPx);
    let topA = smoothstep(0.8, -0.8, st0.d);
    var topN = vec3f(0.0, 0.0, 1.0);
    var shade = 0.0;
    var sideA = 0.0;
    var sideT = 1.0;
    if (st0.d < 1e4) {
        let gl = length(st0.g);
        let g = select(vec2f(0.0), st0.g / gl, gl > 1e-4);
        let bw = max(1.0, u.look.x * cellPx);
        let rise = 1.0 - clamp(-st0.d / bw, 0.0, 1.0);
        let slope = clamp(rise / max(sqrt(max(1.0 - rise * rise, 0.0)), 0.25), 0.0, 3.5);
        topN = normalize(vec3f(g * slope, 1.0));
        gels[0].d = st0.d;
        gels[0].g = g;
        gels[0].rgb = st0.rgb;
    }
    var sd = 1e5;
    for (var k = 1; k <= 4; k++) {
        let f = f32(k) / 4.0;
        let dk = stackAt(pp - AWAY * ext * f, origin, cellPx).d;
        if (dk < sd) {
            sd = dk;
            sideT = f;
        }
    }
    sideA = smoothstep(0.8, -0.8, sd) * (1.0 - topA);
    let ds = stackAt(pp - AWAY * (ext * 1.8 + cellPx * 0.05), origin, cellPx).d;
    shade = (1.0 - smoothstep(-cellPx * 0.05, cellPx * 0.3, ds)) * u.look2.x;

    // THE FREE TILES' SHADOWS and their gel, before anything is drawn.
    for (var i = 0; i < 24; i++) {
        if (i >= nf) { break; }
        let f0 = u.free[i * 2];
        let reach = f0.z * (1.0 + u.look.y * 2.0 + 0.4);
        if (length(pp - f0.xy) > reach) { continue; }
        let tl = tileAt(pp, f0.xy, f0.z, f0.w);
        shade = max(shade, tl.shadow * u.free[i * 2 + 1].a);
        if (tl.d < gels[1].d) {
            gels[1].d = tl.d;
            gels[1].g = tl.g;
            gels[1].rgb = u.free[i * 2 + 1].rgb;
        }
    }

    // 0. The skirt takes its blocks' colour. The goo canvas is premultiplied
    // with a black contact shadow round it, so where the goo IS is read off
    // its colour, not its alpha. The tint keeps the goo's light: its
    // brightness carries the colour, and the pale rim and highlight over
    // three quarters stay white.
    let tint = u.look4.x;
    if (tint > 0.0) {
        let gooA = clamp(max(gooPx.r, max(gooPx.g, gooPx.b)) * 3.0, 0.0, 1.0);
        if (gooA > 0.0) {
            let sk = skirtAt(pp, origin, cellPx, nf);
            let lum = dot(col, LUMA);
            let dyed = sk.rgb * (0.25 + 1.5 * lum) + max(col - vec3f(0.75), vec3f(0.0));
            col = mix(col, dyed, gooA * tint * clamp(sk.w, 0.0, 1.0));
        }
    }

    // 1. Shadows.
    col *= 1.0 - shade;

    // 2. The goo, behind every tile.
    let goo = gooAt(pp, uv, gels, cellPx);
    col = mix(col, goo.col, goo.a);

    // 3. The stack.
    if (sideA > 0.0 || topA > 0.0) {
        let ink = inkAt(uv);
        col = mix(col, shadeSide(ink, sideT), sideA * (1.0 - topA));
        col = mix(col, shadeTop(ink, topN, pp, cellPx, uv), topA);
    }

    // 4. The free tiles.
    for (var i = 0; i < 24; i++) {
        if (i >= nf) { break; }
        let f0 = u.free[i * 2];
        let f1 = u.free[i * 2 + 1];
        let reach = f0.z * (1.0 + u.look.y * 2.0 + 0.4);
        if (length(pp - f0.xy) > reach) { continue; }
        let tl = tileAt(pp, f0.xy, f0.z, f0.w);
        col = mix(col, shadeSide(f1.rgb, tl.sideT), tl.side * f1.a);
        col = mix(col, shadeTop(f1.rgb, tl.n, pp, f0.z, uv), tl.top * f1.a);
    }
    return col;
}

fn layer(uv: vec2f) -> vec3f {
    var col = textureSample(water, samp, uv).rgb;
    let w = textureSample(under, samp, uv);
    return col * (1.0 - w.a) + w.rgb;
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
    // textureSample stays in uniform control flow.
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);

    // The chromatic split is the water's and the well's; the tiles, the drips,
    // the scene and the seal are laid over it once, unsplit — three passes of
    // the whole board per pixel would be the cost of a knob that ships at 0.
    let dir = (uv - 0.5) * aber;
    let r = layer(uv + dir).r;
    let g = layer(uv).g;
    let b = layer(uv - dir).b;
    let c = textureSample(tex, samp, uv);
    let s = textureSample(seal, samp, uv);
    let gp = textureSample(gooTex, samp, uv);
    var col = board(vec3f(r, g, b), uv, gp);
    col = col * (1.0 - c.a) + c.rgb;
    col = col * (1.0 - s.a) + s.rgb;

    // THE OVERLAYS. Sealitaire's constants, each a slider now (tuning.luau's
    // `crt` rows default to them): the scanlines' drift, the shadow mask on
    // its own rather than riding the scanlines, the bright lift, the
    // flicker, the edge glow — and GRAIN, which sealitaire does not have,
    // off by default: a hash per grain-sized cell per frame, mean-preserving.
    let line = 0.5 + 0.5 * sin(uv.y * res.y * 3.14159 * 1.0 + t * u.post2.w);
    col *= 1.0 - scan * (1.0 - line) * 0.6;
    let px = floor(in.uv.x * res.x);
    let m = px - 3.0 * floor(px / 3.0);
    var mask = vec3f(1.0);
    if (m < 1.0) { mask = vec3f(1.0, 0.86, 0.86); }
    else if (m < 2.0) { mask = vec3f(0.86, 1.0, 0.86); }
    else { mask = vec3f(0.86, 0.86, 1.0); }
    col *= mix(vec3f(1.0), mask, u.post.z);

    let lum = dot(col, vec3f(0.299, 0.587, 0.114));
    col += col * smoothstep(0.55, 1.0, lum) * u.post.w;
    col *= (1.0 - u.post2.x) + u.post2.x * sin(t * u.post2.y);
    let e = uv * (1.0 - uv);
    col *= mix(1.0, pow(e.x * e.y * 16.0, 0.28), vig);

    let edge = 1.0 - smoothstep(0.0, 0.03, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    col += vec3f(0.06, 0.16, 0.22) * edge * u.post2.z;

    let gcell = floor(in.uv * res / max(1.0, u.post.y));
    let grain = hash(gcell + vec2f(floor(t * 60.0) * 17.13, floor(t * 60.0) * 3.71)) - 0.5;
    col += vec3f(grain * u.post.x);

    return vec4f(col * inside, 1.0);
}
