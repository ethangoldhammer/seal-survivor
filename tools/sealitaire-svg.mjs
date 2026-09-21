#!/usr/bin/env node
// SVG path data -> Rive .rml <PointsPath>.
//
// Rive stores a cubic's control points in POLAR form on the on-curve vertex
// (inRotation/inDistance, outRotation/outDistance), not as the two off-curve
// points an SVG "C" writes. So the conversion is per VERTEX, not per segment:
// a vertex takes its `in` from the preceding segment's second control point and
// its `out` from the following segment's first. Everything else here exists to
// get an arbitrary SVG path into a list of pure cubic segments first — arcs,
// quadratics and the smooth/shorthand commands all have to be rewritten before
// that per-vertex step can see them.
//
//   node tools/sealitaire-svg.mjs <file.svg> [--size=N] [--names=a,b,c,d]
//        [--id-base=2:2000] [--box] [--json]
//
// Prints one <Shape> per top-level path, each normalised to a `--size` box and
// centred on its own origin, ready to paste into table-cards.rml. Nothing regenerates
// from this — it is a one-shot importer, and the .rml stays the source of truth.

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- path parsing

const NUM = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

function tokenize(d) {
    const out = [];
    const re = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;
    let m;
    while ((m = re.exec(d))) out.push(m[1] ?? parseFloat(m[2]));
    return out;
}

// Every command becomes an absolute cubic. Returns subpaths:
//   { start: [x,y], segs: [{ c1, c2, to }], closed: bool }
function toCubics(d) {
    const t = tokenize(d);
    const subs = [];
    let sub = null;
    let cx = 0, cy = 0;          // current point
    let sx = 0, sy = 0;          // subpath start
    let prevCtrl = null;         // for S/s and T/t reflection
    let prevCmd = '';
    let i = 0;

    const push = (c1, c2, to) => {
        if (!sub) throw new Error('path data starts with a segment, not a moveto');
        sub.segs.push({ c1, c2, to });
        cx = to[0]; cy = to[1];
    };
    const line = (x, y) => push([cx, cy], [x, y], [x, y]);

    while (i < t.length) {
        let cmd = typeof t[i] === 'string' ? t[i++] : implicit(prevCmd);
        const abs = cmd === cmd.toUpperCase();
        const n = () => t[i++];
        const px = () => (abs ? n() : cx + n());
        const py = () => (abs ? n() : cy + n());

        switch (cmd.toUpperCase()) {
            case 'M': {
                const x = px(), y = py();
                sub = { start: [x, y], segs: [], closed: false };
                subs.push(sub);
                cx = sx = x; cy = sy = y;
                prevCtrl = null;
                break;
            }
            case 'L': line(px(), py()); prevCtrl = null; break;
            case 'H': line(abs ? n() : cx + n(), cy); prevCtrl = null; break;
            case 'V': line(cx, abs ? n() : cy + n()); prevCtrl = null; break;
            case 'C': {
                const c1 = [px(), py()], c2 = [px(), py()], to = [px(), py()];
                push(c1, c2, to); prevCtrl = c2;
                break;
            }
            case 'S': {
                // The first control is the reflection of the last one, but only
                // after another cubic; after anything else it sits on the point.
                const r = /[CS]/.test(prevCmd.toUpperCase()) && prevCtrl
                    ? [2 * cx - prevCtrl[0], 2 * cy - prevCtrl[1]]
                    : [cx, cy];
                const c2 = [px(), py()], to = [px(), py()];
                push(r, c2, to); prevCtrl = c2;
                break;
            }
            case 'Q': {
                const q = [px(), py()], to = [px(), py()];
                pushQuad(q, to); prevCtrl = q;
                break;
            }
            case 'T': {
                const q = /[QT]/.test(prevCmd.toUpperCase()) && prevCtrl
                    ? [2 * cx - prevCtrl[0], 2 * cy - prevCtrl[1]]
                    : [cx, cy];
                const to = [px(), py()];
                pushQuad(q, to); prevCtrl = q;
                break;
            }
            case 'A': {
                const rx = n(), ry = n(), rot = n(), large = n(), sweep = n();
                const to = [px(), py()];
                for (const seg of arcToCubics(cx, cy, rx, ry, rot, large, sweep, to))
                    push(seg.c1, seg.c2, seg.to);
                prevCtrl = null;
                break;
            }
            case 'Z': {
                if (sub) sub.closed = true;
                cx = sx; cy = sy;
                prevCtrl = null;
                break;
            }
            default: throw new Error(`unsupported path command ${cmd}`);
        }
        prevCmd = cmd;
    }

    // A quadratic is an exact cubic: controls two thirds of the way out.
    function pushQuad(q, to) {
        push(
            [cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy)],
            [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])],
            to,
        );
    }
    function implicit(c) {
        // A repeated coordinate run continues the last command, except that a
        // repeated moveto is a lineto.
        if (!c) throw new Error('path data starts with a number');
        return c === 'M' ? 'L' : c === 'm' ? 'l' : c;
    }
    return subs;
}

// Endpoint arc -> centre parameterisation -> <=90deg cubic pieces (SVG 1.1 F.6).
function arcToCubics(x1, y1, rx, ry, rotDeg, large, sweep, [x2, y2]) {
    if (rx === 0 || ry === 0) return [{ c1: [x1, y1], c2: [x2, y2], to: [x2, y2] }];
    rx = Math.abs(rx); ry = Math.abs(ry);
    const phi = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;

    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

    const ang = (ux, uy, vx, vy) => {
        const d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
        let a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / d)));
        if (ux * vy - uy * vx < 0) a = -a;
        return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;

    const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
    const step = dt / n;
    const k = (4 / 3) * Math.tan(step / 4);
    const at = (a) => {
        const c = Math.cos(a), s = Math.sin(a);
        return [cx + cos * rx * c - sin * ry * s, cy + sin * rx * c + cos * ry * s];
    };
    const dAt = (a) => {
        const c = Math.cos(a), s = Math.sin(a);
        return [-cos * rx * s - sin * ry * c, -sin * rx * s + cos * ry * c];
    };

    const out = [];
    for (let j = 0; j < n; j++) {
        const a0 = t1 + j * step, a1 = a0 + step;
        const p0 = at(a0), p1 = at(a1), d0 = dAt(a0), d1 = dAt(a1);
        out.push({
            c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]],
            c2: [p1[0] - k * d1[0], p1[1] - k * d1[1]],
            to: p1,
        });
    }
    return out;
}

// ------------------------------------------------------------------- geometry

function bounds(subs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const hit = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const s of subs) {
        let [px, py] = s.start;
        hit(px, py);
        for (const g of s.segs) {
            // The TIGHT bound of the curve, not of its control hull: a control
            // point can sit well outside the ink, and normalising to the hull
            // would size every mark by how far its handles happen to reach.
            for (const [t0, t1v] of extrema(px, g.c1[0], g.c2[0], g.to[0], py, g.c1[1], g.c2[1], g.to[1]))
                hit(t0, t1v);
            hit(g.to[0], g.to[1]);
            px = g.to[0]; py = g.to[1];
        }
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function extrema(p0x, p1x, p2x, p3x, p0y, p1y, p2y, p3y) {
    const pts = [];
    const roots = (a, b, c, d) => {
        // d/dt of a cubic Bezier is a quadratic; its real roots in (0,1) are
        // where the curve turns.
        const A = -a + 3 * b - 3 * c + d, B = 2 * (a - 2 * b + c), C = -a + b;
        const out = [];
        if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) out.push(-C / B); }
        else {
            const disc = B * B - 4 * A * C;
            if (disc >= 0) {
                const s = Math.sqrt(disc);
                out.push((-B + s) / (2 * A), (-B - s) / (2 * A));
            }
        }
        return out.filter((t) => t > 0 && t < 1);
    };
    const at = (t, a, b, c, d) => {
        const u = 1 - t;
        return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
    };
    for (const t of [...roots(p0x, p1x, p2x, p3x), ...roots(p0y, p1y, p2y, p3y)])
        pts.push([at(t, p0x, p1x, p2x, p3x), at(t, p0y, p1y, p2y, p3y)]);
    return pts;
}

// ------------------------------------------------------------------ emit .rml

const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
const f = (n) => (Math.abs(n) < 1e-6 ? '0' : String(Math.round(n * 1e4) / 1e4));

function vertices(sub, xf) {
    // One entry per ON-CURVE point, carrying the two handles that meet there.
    const pts = [{ p: sub.start, in: null, out: null }];
    for (const g of sub.segs) {
        pts[pts.length - 1].out = g.c1;
        const last = near(g.to, sub.start) && sub.closed;
        if (last) pts[0].in = g.c2;
        else pts.push({ p: g.to, in: g.c2, out: null });
    }
    if (sub.closed && !near(pts[pts.length - 1].p, sub.start)) {
        // A Z that closes with an implicit LINE back to the start: the closing
        // segment has no handles, so both ends keep a zero distance there.
        pts[0].in = pts[0].in ?? sub.start;
    }
    return pts.map((v) => {
        const p = xf(v.p);
        const polar = (c) => {
            if (!c) return [0, 0];
            const q = xf(c);
            const dx = q[0] - p[0], dy = q[1] - p[1];
            const d = Math.hypot(dx, dy);
            return [d < 1e-6 ? 0 : Math.atan2(dy, dx), d];
        };
        const [ir, id] = polar(v.in);
        const [or_, od] = polar(v.out);
        return { x: p[0], y: p[1], ir, id, or: or_, od };
    });
}

function emitPath(sub, xf, id, name) {
    const self = id();   // before the vertices, so the ids read top-down
    const vs = vertices(sub, xf);
    const straight = vs.every((v) => v.id === 0 && v.od === 0);
    const lines = vs.map((v, k) => {
        const a = [`x="${f(v.x)}"`, `y="${f(v.y)}"`];
        if (!straight) a.push(
            `inRotation="${f(v.ir)}"`, `inDistance="${f(v.id)}"`,
            `outRotation="${f(v.or)}"`, `outDistance="${f(v.od)}"`,
        );
        const tag = straight ? 'StraightVertex' : 'CubicDetachedVertex';
        return `            <${tag} ${a.join(' ')} name="V${k}" id="${id()}"/>`;
    });
    return [
        `        <PointsPath${sub.closed ? ' isClosed="true"' : ''} name="${name}" id="${self}">`,
        ...lines,
        `        </PointsPath>`,
    ].join('\n');
}

// ------------------------------------------------------------------------ main

function main(argv) {
    const args = argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
        console.error('usage: sealitaire-svg.mjs <file.svg> [--size=N] [--names=a,b] [--id-base=2:2000] [--box] [--json]');
        process.exit(2);
    }
    const opt = (k, d) => {
        const a = args.find((s) => s.startsWith(`--${k}=`));
        return a ? a.slice(k.length + 3) : d;
    };
    const size = parseFloat(opt('size', '24'));
    const names = opt('names', '').split(',').filter(Boolean);
    const box = args.includes('--box');
    const [pre, start] = opt('id-base', '2:2000').split(':');
    let next = parseInt(start, 10);
    const id = () => `${pre}:${next++}`;

    const svg = readFileSync(file, 'utf8');
    // Deliberately naive: top-level <path d="…"> only. A file with transforms,
    // <use>, <text> or nested groups that move things is rejected rather than
    // silently imported at the wrong place — see the guard below.
    const ds = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
    if (!ds.length) throw new Error('no <path d="…"> in the file');
    if (/\btransform=/.test(svg))
        throw new Error('the file has a transform= on it: flatten transforms in the editor first, or every path lands in the wrong place');

    const metrics = ds.map((d) => { const subs = toCubics(d); return { subs, b: bounds(subs) }; });
    // --set scales every mark by ONE factor, so a sheet drawn as a family keeps
    // the sizes its designer gave it: on a suit set the heart is meant to sit
    // a little wider than the club, and normalising each path alone flattens
    // exactly that relationship out.
    const setScale = size / Math.max(...metrics.map(({ b }) => Math.max(b.w, b.h)));

    const shapes = metrics.map(({ subs, b }, k) => {
        // Otherwise normalise on the LONGER axis so a wide mark and a tall one
        // get the same optical weight. Either way the shape is centred on its
        // OWN bounds, so the Shape's x/y is where the ink is rather than where
        // the viewBox happened to put it.
        const s = args.includes('--set') ? setScale : size / Math.max(b.w, b.h);
        const cx = b.x0 + b.w / 2, cy = b.y0 + b.h / 2;
        const xf = ([x, y]) => [(x - cx) * s, (y - cy) * s];
        const name = names[k] ?? `Path ${k + 1}`;
        const shapeId = id();
        const body = subs.map((sub, j) =>
            emitPath(sub, xf, id, subs.length > 1 ? `${name} ${j + 1}` : 'P'));
        return {
            name,
            box: { w: b.w * s, h: b.h * s },
            rml: [
                `    <Shape name="${name}" id="${shapeId}">`,
                ...body,
                `        <Fill name="F" id="${id()}"><SolidColor colorValue="FFD0392B" name="C" id="${id()}"/></Fill>`,
                `    </Shape>`,
            ].join('\n'),
        };
    });

    if (args.includes('--json')) {
        console.log(JSON.stringify(shapes.map((s) => ({ name: s.name, ...s.box })), null, 2));
        return;
    }
    for (const s of shapes) {
        if (box) console.log(`    <!-- ${s.name}: ${s.box.w.toFixed(2)} x ${s.box.h.toFixed(2)} -->`);
        console.log(s.rml);
    }
}

main(process.argv);
