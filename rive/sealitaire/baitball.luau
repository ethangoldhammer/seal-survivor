-- ============================================================================
-- THE BAIT BALL — what swims inside a tank card's face.
--
-- A card's face is a window onto a small 3-D tank: a 2-10 holds that many
-- fish of its suit's species, sitting in the pip formation of a playing card
-- so the count IS the number (no pips are drawn); every ace, jack, queen and
-- king holds one creature (tanks.csv picks which). Each body is a tiny simulation
-- rather than an analytic orbit now, because the tank has WALLS: the four
-- edges of the card are the edges of the camera's frustum, and nothing may
-- cross them. A body seeks its seat on a tilted ring with a spring, and the
-- hand shoves it off:
--
--   play    a card landing in a valid spot: the formation slides onto a
--           tilted ring and swirls as a ball for a beat (`excite` rises,
--           holds `swirlHold`, eases out), then settles back into the number
--   press   a jolt: every body gets a shove, no regrouping
--   drag    while the held card MOVES the box is LOOSE: the seat spring
--           lets go, the bodies are free objects kicked by the card's
--           acceleration, sinking under a little gravity, rattling off the
--           walls with friction. The moment the held card stops, or is
--           released, they settle back into place until it moves again
--
-- The walls are the frustum at each body's own depth: nose and tail are
-- both kept inside, so a long creature cannot poke a snout through the card
-- edge even while turned.
--
-- THE DENT. A contact squashes the body — flesh, not a rigid shell. Every
-- number of it is here and the warp itself is in fish.wgsl, AFTER the skin
-- matrix: the bone palette, the joint weights and the clip's phase are never
-- touched, so a swimming body keeps swimming through its own dent and a
-- dent of zero is the exact identity. Latched in the body's OWN frame
-- (`dnx..dnz`, `dz0`) so the squash stays where it landed as the body swims
-- on, and rung back to nothing by a spring (`dent`, `dentV`). It is driven
-- by the CONTACT, not by the knock: the knock is throttled by `hitSpeed` and
-- `hitGap` so a body scraping the glass does not machine-gun, and a touch
-- too quiet to hear should still squash. Pure: fills per-instance model matrices into a
-- buffer for fish.wgsl. The table decides which cards are tanks this frame
-- and hands their inputs in. World units: a body of `size` 1 is 1 long; the
-- camera in table.luau sees +-(dist * tanHalf) at z = 0.
-- ============================================================================

export type Fish = {
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    hx: number, hy: number, hz: number,     -- heading (the nose), unit
    h1: number, h2: number, h3: number,     -- this fish's own hashes
    len: number,
    cool: number,                           -- s until this body may report a knock again
    phase: number,                          -- 0..1 through the species' clip, its own
    enter: number,                          -- 1 while swimming in from off the card (the entrance): the far wall is open until it is inside
    -- The dent (see the header). All four are in the BODY's frame, so they
    -- mean the same thing however it has turned since.
    dnx: number, dny: number, dnz: number,  -- unit: the way the wall pushed
    dz0: number,                            -- where along the body, local z: -0.5 the nose, +0.5 the tail
    dent: number,                           -- the squash now: + compressed along the normal, - rebounding past rest
    dentV: number,                          -- its velocity, for the spring
    dage: number,                           -- seconds since the kick: the wobble's phase
    dkick: number,                          -- THIS FRAME's contact speed, 0 if none: what a rigged body's bone chains are shoved by (table.luau). Raw, so it does not depend on the dent being on — and only on the EDGE of a contact, see `touch`
    touch: number,                          -- 1 while the body is against the glass. A scrape is one contact, not sixty a second
    kickRef: number,                        -- the speed of the shove already in the chain, held for as long as the contact lasts. NOT dkick, which is cleared every frame — comparing against that is comparing against zero
    rig: any,                               -- the caller's, for a species with a skeleton: chain state it hangs here so it lives as long as the body does. baitball never reads it
}

-- A bubble knocked loose off the glass. Tank units, and its own instance of
-- the `bubble` species — a procedural sphere in the pack (tools/sealitaire-
-- fish.mjs), drawn flat white through the same pipeline as every creature.
export type Bubble = {
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    age: number, life: number,
    r: number,          -- diameter, tank units
    wob: number,        -- its own phase, so a cluster does not sway as one
}

-- A body hitting a wall hard enough to be worth hearing and seeing. Tank
-- units, at the point of contact rather than the body's centre, so the
-- bubbles come off the glass.
export type Hit = {
    x: number, y: number, z: number,
    speed: number,      -- closing speed into the wall, before the bounce
    axis: number,       -- 1 x, 2 y, 3 z: which wall
    len: number,        -- the body's length, tank units: the knock's pitch (knock.luau)
}

export type Ball = {
    excite: number,         -- 0 formation .. 1 swirling ball
    swirl: number,          -- seconds of full swirl left after a play
    scatter: number,
    loose: number,          -- 0 seated .. 1 rattling free (a drag)
    spinPhase: number,
    seed: number,
    prevVX: number, prevVY: number,         -- the card's velocity last frame
    fish: { Fish },
    hits: { Hit },                          -- knocks THIS frame; the caller drains it
    bubbles: { Bubble },
}

export type Walls = {
    dist: number,       -- camera distance from the origin, along +z
    tanHalf: number,    -- tan(vertical fov / 2)
    aspect: number,     -- width / height
    zFront: number,     -- nearest depth a body may reach
    zBack: number,      -- farthest
}

export type Inputs = {
    hovered: boolean,     -- (unused by the sim: a hover changes nothing in the box)
    pressed: boolean,     -- true on the frame the card is pressed
    played: boolean,      -- true on the frame the card lands in a valid spot
    dragging: boolean,
    velX: number, velY: number,   -- the card's velocity, px/s (screen y down)
    count: number,
    size: number,         -- a body's length, tank units
    back: { number },     -- rgb, the back
    belly: { number },    -- rgb, the belly
    -- tunables
    spin: number,         -- radians per second at rest
    radius: number,       -- ring radius, world units
    exciteSpin: number,   -- how much the swirl speeds the ring (x)
    swirlHold: number,    -- seconds the ball holds after a play
    swirlIn: number,      -- how fast it becomes a ball, per second
    swirlOut: number,     -- how fast it settles back into the number
    scatterPush: number,  -- how far a press throws them, world units
    padX: number,         -- world units the RESTING seats keep clear of the side walls (see seatHalf)
    padY: number,         -- the same, top and bottom
    colGap: number,       -- the formation's column spread, x the fitted width (1 is the padded edge)
    rowGap: number,       -- the formation's row spread, x the fitted height
    drop: number,         -- world units the whole formation is biased DOWN the card (negative lifts it); clamped to the seat box
    rotate: number,       -- radians every body is tilted in the card plane, all the same way
    rotateVary: number,   -- radians of extra tilt either side of that, per body, from its own hash
    yaw: number,          -- radians every body turns about the card's VERTICAL, positive toward the viewer: the second axis
    roll: number,         -- radians every body rolls about its own length, positive belly toward the viewer: the third axis
    sway: number,         -- 0..1: how much of the idle rocking and breathing drift a resting body does; 0 holds it still
    holds: boolean,       -- a lone creature that HOLDS the centre instead of looping (the court cards)
    revealed: boolean,    -- true on the frame the card's face first shows: the entrance
    enterSpeed: number,   -- tank units/s a court card's creature swims in at on reveal; 0 is no entrance
    clipRate: number,     -- cycles/s through the species' clip (1 / its duration); 0 for a species baked at rest
    clipWeight: number,   -- 0..1 how much of the clip's pose shows; 0 is the rest pose
    bio: { number },      -- rgb, the glow's colour
    bioStrength: number,  -- the glow's strength; 0 is no glow (and no noise evaluated)
    -- The field's per-card numbers (a tanks.csv cell or the tuner's global,
    -- resolved by the table): fish.wgsl reads these off the instance.
    bioSpeed: number, bioScale: number, bioContrast: number, bioCoverage: number,
    bioPan: number,       -- radians
    bioEvolve: number,
    slosh: number,        -- world units of velocity per px/s the card's velocity changes by
    spring: number,       -- pull toward the seat on the ring
    damp: number,
    bounce: number,       -- 0..1, velocity kept off a wall
    turn: number,         -- radians per second a body may turn: the rotational drag
    turnMax: number,      -- radians: a body never points further than this from its rest facing
    -- the rattle (a dragged card)
    loosen: number,       -- how fast a moving drag lets the seats go (per second)
    still: number,        -- px/s: a held card slower than this counts as still, and reseats
    settle: number,       -- how fast an idle card seats them again (per second)
    friction: number,     -- velocity lost per second while loose
    gravity: number,      -- sink while loose, tank units per second^2
    tumble: number,       -- roll with speed while loose
    -- the dent a contact leaves (see the header; the rest of its numbers are
    -- the shader's, in the tank uniform)
    dentAmount: number,   -- compression per tank unit/s of closing speed, capped at 1; 0 is no dent at all
    dentFreq: number,     -- Hz the squash rings back at
    dentDamp: number,     -- 0..1 damping ratio: 0 rings for ever, near 1 is one squash and done
    -- knocks (see `wall`)
    hitSpeed: number,     -- tank units/s of CLOSING speed below which a touch is not a knock
    hitGap: number,       -- s a body must wait before it may report another
    -- the bubbles a knock throws
    bubbleCount: number,  -- how many a hard knock makes; a soft one makes fewer
    bubbleSize: number,   -- diameter at full size, tank units
    bubbleRise: number,   -- tank units per second, upward
    bubbleLife: number,   -- seconds
    bubbleSpread: number, -- how fast they scatter off the wall
    walls: Walls,
}

local M = {}

local TILT = 0.42          -- the ring leans back so a straight camera sees a swirl
local MAX_SPEED = 7
local HEAD_TURN = 9        -- ease of the nose toward its target, before the turn cap
-- Per instance: model (64), back (16), belly (16), tile (16), anim (16),
-- bio (16), dent (16), two of the glow's fields (32), rig (16). `anim`'s two spare slots carry the dent's place and
-- age, so the dent costs one column rather than two.
-- Then two more columns: the glow field's per-card numbers (speed, scale,
-- contrast, coverage) and (pan, evolve, -, -).
local STRIDE = 208
M.STRIDE = STRIDE

function M.new(seed: number): Ball
    return { excite = 0, swirl = 0, scatter = 0, loose = 0, spinPhase = seed * 1.7, seed = seed, prevVX = 0, prevVY = 0, fish = {}, hits = {}, bubbles = {} }
end

local function hash(n: number): number
    local x = math.sin(n * 12.9898 + 78.233) * 43758.5453
    return x - math.floor(x)
end

-- Half extents of the frustum at depth z, less the body's girth. This is the
-- WALL: what a body may never cross, whatever is done to it.
--
-- Measured at a depth INSIDE the tank, whatever z is asked for: a body
-- longer than the tank is deep has an end past the front wall by
-- construction, and the frustum "at" that depth is a few hundredths wide —
-- a side wall nothing can satisfy, that the spring and the clamp then
-- fought over for ever. Past the glass, the glass's own width applies.
local function halfAt(w: Walls, z: number, girth: number): (number, number)
    local zc = math.max(w.zBack, math.min(w.zFront, z))
    local hy = (w.dist - zc) * w.tanHalf
    return hy * w.aspect - girth, hy - girth
end

-- Where a body may REST: the wall, pulled in by `pad`. The two are separate on
-- purpose. The rank prints in the card's two far corners, and a body sitting
-- under it hides the thing the card is for — but a body SHOVED there is the
-- whole point of shoving it. So the seats keep clear and the walls do not: a
-- press, a drag or a play still throws a fish right into the corner, and it
-- swims back out from under the number on its own.
--
-- In world units, because that is what the sim is in: the card is 2 * dist *
-- tanHalf tall (2.59 at the tuned camera) for 168 artboard px, so a pad of
-- 0.18 is about 12px of card — a little more than the rank glyph's own margin.
local function seatHalf(w: Walls, padX: number, padY: number, girth: number): (number, number)
    local hx, hy = halfAt(w, 0, girth)
    return math.max(0.1, hx - padX), math.max(0.1, hy - padY)
end

-- A school at rest sits in FORMATION: the pip layout of a playing card,
-- made of fish, so the count reads as the number. Seats as (column, row)
-- in [-1, 1]; a lone body has no formation (it loops instead).
local FORMATION: { { { number } } } = {
    {},
    { { 0, -1 }, { 0, 1 } },
    { { 0, -1 }, { 0, 0 }, { 0, 1 } },
    { { -1, -1 }, { 1, -1 }, { -1, 1 }, { 1, 1 } },
    { { -1, -1 }, { 1, -1 }, { 0, 0 }, { -1, 1 }, { 1, 1 } },
    { { -1, -1 }, { 1, -1 }, { -1, 0 }, { 1, 0 }, { -1, 1 }, { 1, 1 } },
    { { -1, -1 }, { 1, -1 }, { 0, -0.5 }, { -1, 0 }, { 1, 0 }, { -1, 1 }, { 1, 1 } },
    { { -1, -1 }, { 1, -1 }, { 0, -0.5 }, { -1, 0 }, { 1, 0 }, { 0, 0.5 }, { -1, 1 }, { 1, 1 } },
    { { -1, -1 }, { 1, -1 }, { -1, -1 / 3 }, { 1, -1 / 3 }, { 0, 0 }, { -1, 1 / 3 }, { 1, 1 / 3 }, { -1, 1 }, { 1, 1 } },
    { { -1, -1 }, { 1, -1 }, { 0, -2 / 3 }, { -1, -1 / 3 }, { 1, -1 / 3 }, { -1, 1 / 3 }, { 1, 1 / 3 }, { 0, 2 / 3 }, { -1, 1 }, { 1, 1 } },
}

local function formation(i: number, n: number): (number, number)
    local f = FORMATION[n]
    if f ~= nil and f[i] ~= nil then
        return f[i][1], f[i][2]
    end
    -- Past ten: three columns, top to bottom.
    local rows = math.ceil(n / 3)
    local k = i - 1
    return (k % 3) - 1, if rows > 1 then (k // 3) / (rows - 1) * 2 - 1 else 0
end

-- The box a body's CENTRE may sit in so that both its ends clear the walls,
-- for a body of half-length `half` along unit heading (hx, hy, hz). Depth
-- first — the frustum's width depends on it — then x and y at each end's
-- own depth, intersected. A body longer than the room on an axis gets an
-- empty range; the caller centres it (`lo > hi`).
--
-- This is what a YAWED body needs: its nose reaches toward the camera, where
-- the tank is narrowest, and a seat that still assumed broadside at z = 0
-- put the nose through the front wall every frame — the spring pulled it
-- back in, the wall reflected it out, for ever.
local function fitBox(w: Walls, hx: number, hy: number, hz: number, half: number, girth: number): (number, number, number, number, number, number)
    local ez = math.abs(hz) * half
    local zlo, zhi = w.zBack + girth + ez, w.zFront - girth - ez
    local zc = if zlo <= zhi then math.max(zlo, math.min(zhi, 0)) else (zlo + zhi) * 0.5
    local xlo: number, xhi: number, ylo: number, yhi: number = -math.huge, math.huge, -math.huge, math.huge
    for _, sgn in ipairs({ 1, -1 }) do
        local ex, ey, ezz = hx * half * sgn, hy * half * sgn, hz * half * sgn
        local wx, wy = halfAt(w, zc + ezz, girth)
        -- (spelled out: the checker loses `number` through math.min here)
        local xl, xh, yl, yh = -wx - ex, wx - ex, -wy - ey, wy - ey
        if xl > xlo then xlo = xl end
        if xh < xhi then xhi = xh end
        if yl > ylo then ylo = yl end
        if yh < yhi then yhi = yh end
    end
    return xlo, xhi, ylo, yhi, zlo, zhi
end

local function restHeadingOf(f: Fish, i: number, n: number, inp: Inputs): (number, number, number)
    local s = 1.0
    if n == 1 then
        s = -1.0
    else
        local _, cy = formation(i, n)
        s = if math.floor((cy + 1) * 2 + 0.5) % 2 == 0 then -1 else 1
    end
    local a = inp.rotate + (f.h2 - 0.5) * 2 * inp.rotateVary
    local ca = math.cos(a)
    return s * ca * math.cos(inp.yaw), s * math.sin(a), ca * math.sin(inp.yaw)
end

-- Where fish i wants to be at ring phase `phase`: its own seat.
--
-- A school sits in formation, each fish broadside and gently drifting, and
-- on a play (`excite`) the seats slide onto a ring tilted back from the card
-- plane, so the number comes alive as a swirling ball for a beat and settles
-- back into the number. A lone creature instead drifts round a tall oval IN
-- the card plane, sized so nose and tail clear the walls, holding its facing
-- (the turn cone) so it is seen broadside the whole way round.
local function seat(b: Ball, f: Fish, inp: Inputs, n: number, phase: number, i: number): (number, number, number)
    local a = phase * (0.8 + 0.4 * f.h1) + f.h2 * math.pi * 2
    local r = inp.radius * (1 - 0.3 * b.excite)
    local hx, hy = seatHalf(inp.walls, inp.padX, inp.padY, 0)
    -- The bias, and the room left for it. World +y is the card's TOP (the
    -- tank camera's up is +y and the tile is written y-up), so a positive
    -- `drop` — the way a slider reading "drop" has to behave — is NEGATIVE y.
    -- It is clamped rather than added raw: past the edge the seat spring
    -- would just hold every body against the wall, which looks the same at
    -- every value above the one that first reached it.
    --
    -- It is the DROP that is clamped, by the room the whole formation has,
    -- and then every seat moves by that one amount. Clamping each seat to the
    -- box instead parked the bottom row at the edge while the rows above
    -- kept coming down onto it — the number squashed from one end and lost
    -- its symmetry, which is the thing a formation is for. `extent` is how
    -- far the formation reaches from its centre (0 for a lone body).
    local function bias(y: number, room: number, extent: number): number
        local slack = math.max(0, room - extent)
        return y - math.max(-slack, math.min(slack, inp.drop))
    end
    if n == 1 then
        -- A lone body sits where it FITS: its rest heading (lean and yaw)
        -- decides where its ends reach, and the box its centre may occupy
        -- follows from that — so a yawed creature is offset toward the
        -- back, and a long one is centred, rather than held against a
        -- wall. The seat pad is taken off the box in x and y as before.
        local rhx, rhy, rhz = restHeadingOf(f, i, n, inp)
        local half, girth = f.len * 0.5, f.len * 0.15
        local xlo, xhi, ylo, yhi, zlo, zhi = fitBox(inp.walls, rhx, rhy, rhz, half, girth)
        xlo, xhi = xlo + inp.padX, xhi - inp.padX
        ylo, yhi = ylo + inp.padY, yhi - inp.padY
        local cx = if xlo <= xhi then math.max(xlo, math.min(xhi, 0)) else (xlo + xhi) * 0.5
        local cz = if zlo <= zhi then math.max(zlo, math.min(zhi, 0)) else (zlo + zhi) * 0.5
        local roomY = math.max(0, (yhi - ylo) * 0.5)
        local cy0 = (ylo + yhi) * 0.5
        if inp.holds then
            -- A court card's creature sits, broadside, centred. No loop and
            -- no breathing drift: the spring settles it and a press or a
            -- drag is the only thing that moves it.
            return cx, cy0 + bias(0, roomY, 0), cz
        end
        local rx = math.min(r, math.max(0.05, (xhi - xlo) * 0.5))
        local ry = math.min(r * 1.4, roomY)
        -- The loop's oval is the extent here: the whole loop shifts as one.
        return cx + math.cos(a) * rx, cy0 + bias(math.sin(a) * ry, roomY, ry), cz + math.sin(a * 2 + f.h3 * 6) * 0.2 * inp.sway
    end
    -- The ring must leave room for the body: nose to the seat edge at z = 0.
    local ring = math.min(r * (0.45 + 0.55 * f.h3), math.max(0.12, hx - f.len * 0.5 - 0.12))
    local rxp = math.cos(a) * ring
    local tz0 = math.sin(a) * ring * 0.8
    local ty0 = (f.h1 - 0.5) * r * 1.2 * math.sin(a * 0.5 + f.h3 * 6)
    local ct, st = math.cos(TILT), math.sin(TILT)
    local ryp, rzp = ty0 * ct - tz0 * st, ty0 * st + tz0 * ct
    -- The formation seat, drifting a little so the number breathes.
    -- Both axes measured the same way: the seat edge, less half a body, so
    -- the NOSE is what clears the number rather than the centre. The row span
    -- was a flat 0.9 — a number that happened to fit one camera and ignored
    -- both the body's length and the pad.
    local cx, cy = formation(i, n)
    local colX = math.min(0.5, math.max(0.1, hx - f.len * 0.5 - 0.08))
    local rowY = math.max(0.15, hy - f.len * 0.5 - 0.08)
    -- The gaps scale the fitted spread: a slider, so the number's shape is
    -- tuned by eye rather than by the seat edge alone.
    -- The breathing is `sway`: 0 is a number that sits dead still.
    local lx = cx * colX * inp.colGap + math.sin(phase * 0.9 + f.h2 * 6.3) * 0.03 * inp.sway
    -- The room for the drop is measured to the WALL, not the padded seat
    -- edge: the pad keeps a resting number off the rank, but a drop is the
    -- hand deciding where the number sits, and at `rowGap` 1 the formation
    -- already fills the padded box, so pad-limited there would be no drop.
    local _, wallY = halfAt(inp.walls, 0, 0)
    local ly = bias(cy * rowY * inp.rowGap + math.sin(phase * 1.3 + f.h1 * 6.3) * 0.03 * inp.sway, wallY - f.len * 0.5 - 0.02, rowY * inp.rowGap)
    local lz = math.sin(phase * 0.7 + f.h3 * 6.3) * 0.05 * inp.sway
    local k = b.excite
    return lx + (rxp - lx) * k, ly + (ryp - ly) * k, lz + (rzp - lz) * k
end

-- Which way a body faces at rest, as a unit vector in the card plane: a lone
-- creature faces left; a fish in formation faces its row's way, rows
-- alternating. `rotate` then tilts the whole set and `rotateVary` scatters each
-- body around that, from its own hash so the scatter is stable frame to frame
-- rather than a per-frame jitter.
--
-- The tilt ROTATES the facing vector rather than being added to an angle, so
-- a body facing -x comes out on the same visual axis as one facing +x — a row
-- of fish pointing opposite ways still all lean the same way on the card,
-- which is what a uniform rotation has to mean for it to be worth having.
--
-- `yaw` is the second axis: the same facing turned about the card's vertical,
-- positive bringing the nose toward the viewer. It is applied to the leaned
-- vector's x, and — like the lean — on the visual axis rather than the body's:
-- the z it produces does not carry the row's sign, so a row facing left and a
-- row facing right both turn their noses toward the glass together. The
-- third axis, `roll`, is about the body's own length and lives in `write`,
-- where the model matrix is built; a heading vector has no roll in it.
local function restHeading(f: Fish, i: number, n: number, inp: Inputs): (number, number, number)
    return restHeadingOf(f, i, n, inp)
end

local function ensure(b: Ball, inp: Inputs, n: number)
    for i = #b.fish + 1, n do
        local h1 = hash(b.seed * 31 + i)
        local h2 = hash(b.seed * 57 + i * 3)
        local h3 = hash(b.seed * 91 + i * 7)
        local f: Fish = {
            x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, hx = 0, hy = 0, hz = -1,
            h1 = h1, h2 = h2, h3 = h3, len = inp.size * (if n == 1 then 1 else 0.85 + 0.3 * h3),
            cool = 0, phase = h2, enter = 0,
            dnx = 0, dny = 1, dnz = 0, dz0 = 0, dent = 0, dentV = 0, dage = 0, dkick = 0, touch = 0, kickRef = 0, rig = nil,
        }
        -- Born on the seat, already moving along it, so the first frame
        -- swims nose first rather than lurching from the origin. In
        -- formation the seat barely moves: the rest heading is broadside,
        -- rows facing alternate ways like the pips they replace.
        local x0, y0, z0 = seat(b, f, inp, n, b.spinPhase, i)
        local x1, y1, z1 = seat(b, f, inp, n, b.spinPhase + 0.05, i)
        local rate = inp.spin / 0.05
        f.x, f.y, f.z = x0, y0, z0
        f.vx, f.vy, f.vz = (x1 - x0) * rate, (y1 - y0) * rate, (z1 - z0) * rate
        f.hx, f.hy, f.hz = restHeading(f, i, n, inp)
        b.fish[i] = f
    end
    for i = 1, math.min(n, #b.fish) do
        b.fish[i].len = inp.size * (if n == 1 then 1 else 0.85 + 0.3 * b.fish[i].h3)
    end
end

-- Pull a direction back inside a cone of half-angle `max` around the rest
-- facing (rx, 0, 0): the part beyond the cone is not allowed.
local function clampCone(dx: number, dy: number, dz: number, rx: number, ry: number, rz: number, max: number): (number, number, number)
    local cosA = dx * rx + dy * ry + dz * rz
    local a = math.acos(math.max(-1, math.min(1, cosA)))
    if a <= max then
        return dx, dy, dz
    end
    -- Rotate from rest toward d by exactly `max`, in the plane of the two.
    local px, py, pz = dx - rx * cosA, dy - ry * cosA, dz - rz * cosA
    local pl = math.sqrt(px * px + py * py + pz * pz)
    if pl < 1e-6 then
        -- Straight behind: hold the rest facing.
        return rx, ry, rz
    end
    local cm, sm = math.cos(max), math.sin(max)
    return rx * cm + px / pl * sm, ry * cm + py / pl * sm, rz * cm + pz / pl * sm
end

-- Turn heading h toward d: an eased share of the way, capped at `maxStep`
-- radians this frame. Returns the new unit heading.
local function turnToward(hx: number, hy: number, hz: number, dx: number, dy: number, dz: number, ease: number, maxStep: number): (number, number, number)
    local c = math.max(-1, math.min(1, hx * dx + hy * dy + hz * dz))
    local a = math.acos(c)
    if a < 1e-5 then
        return hx, hy, hz
    end
    local step = math.min(a * ease, maxStep)
    -- The axis: h x d; straight behind has none, so pick one above.
    local ax, ay, az = hy * dz - hz * dy, hz * dx - hx * dz, hx * dy - hy * dx
    local al = math.sqrt(ax * ax + ay * ay + az * az)
    if al < 1e-6 then
        ax, ay, az, al = 0, 1, 0, 1
    end
    ax, ay, az = ax / al, ay / al, az / al
    -- Rodrigues: rotate h about the axis by step.
    local cs, sn = math.cos(step), math.sin(step)
    local dot = ax * hx + ay * hy + az * hz
    local nx = hx * cs + (ay * hz - az * hy) * sn + ax * dot * (1 - cs)
    local ny = hy * cs + (az * hx - ax * hz) * sn + ay * dot * (1 - cs)
    local nz = hz * cs + (ax * hy - ay * hx) * sn + az * dot * (1 - cs)
    local l = math.sqrt(nx * nx + ny * ny + nz * nz)
    return nx / l, ny / l, nz / l
end

-- Keep the point q (a nose or a tail) inside the frustum at its own depth,
-- moving the body and bouncing its velocity off the wall it touched.
--
-- It also reports the KNOCK: the closing speed into the wall, read before the
-- bounce reverses it, and which wall took it. Returns 0 for a touch that is
-- not moving into anything.
--
-- That distinction is the whole of it, and it is not optional. This function
-- CLAMPS, so a body resting against the glass is "touching a wall" on every
-- frame for as long as it sits there — a drag holds a dozen of them in the
-- corner under gravity and they grind. Counting touches would emit bubbles
-- and fire a sound sixty times a second per fish, for ever. Only the frame
-- where a body is still moving INTO the wall is a knock, and `hitGap` above
-- keeps even that from repeating while it scrapes along.
local function wall(f: Fish, qx: number, qy: number, qz: number, girth: number, w: Walls, bounce: number): (number, number)
    local hx, hy = halfAt(w, qz, girth)
    local speed, axis = 0, 0
    if qx > hx then
        -- The entrance: a body swimming in from past the right edge is let
        -- through that one wall until the whole of it is inside.
        if f.enter <= 0 then
            f.x -= qx - hx
            if f.vx > 0 then
                speed, axis = f.vx, 1
                f.vx = -f.vx * bounce
            end
        end
    elseif qx < -hx then
        f.x += -hx - qx
        if f.vx < 0 then
            speed, axis = -f.vx, 1
            f.vx = -f.vx * bounce
        end
    end
    if qy > hy then
        f.y -= qy - hy
        if f.vy > 0 then
            if f.vy > speed then speed, axis = f.vy, 2 end
            f.vy = -f.vy * bounce
        end
    elseif qy < -hy then
        f.y += -hy - qy
        if f.vy < 0 then
            if -f.vy > speed then speed, axis = -f.vy, 2 end
            f.vy = -f.vy * bounce
        end
    end
    if qz > w.zFront - girth then
        f.z -= qz - (w.zFront - girth)
        if f.vz > 0 then
            if f.vz > speed then speed, axis = f.vz, 3 end
            f.vz = -f.vz * bounce
        end
    elseif qz < w.zBack + girth then
        f.z += (w.zBack + girth) - qz
        if f.vz < 0 then
            if -f.vz > speed then speed, axis = -f.vz, 3 end
            f.vz = -f.vz * bounce
        end
    end
    return speed, axis
end

-- ---------------------------------------------------------------------------
-- THE BODY'S OWN FRAME. write() builds the model matrix from these three
-- angles and the dent latches through them, so the frame the squash is in
-- and the frame the mesh is in can never drift apart.
-- ---------------------------------------------------------------------------

-- The head is at -z (tools/sealitaire-fish.mjs puts every species there), so
-- a yaw of atan2(hx, hz) + pi points the nose along the heading and the
-- pitch that lifts a -z nose is the positive one.
local function yawPitchOf(f: Fish): (number, number)
    local yaw = math.atan2(f.hx, f.hz) + math.pi
    local horiz = math.sqrt(f.hx * f.hx + f.hz * f.hz)
    return yaw, math.atan2(f.hy, math.max(1e-4, horiz))
end

-- The third angle, about the body's own length: the idle rock (`sway`), the
-- swirl's and the rattle's (which `sway` does NOT damp, so a card at 0 is
-- still thrown about by a play or a drag), and the card's own `roll`.
local function rollOf(b: Ball, f: Fish, inp: Inputs, i: number): number
    local sp = math.sqrt(f.vx * f.vx + f.vy * f.vy + f.vz * f.vz)
    return math.sin(b.spinPhase * 6 + i * 2.1) * 0.12 * (0.6 * inp.sway + b.excite)
        + math.sin(b.spinPhase * 9 + f.x * 5 + f.y * 4 + i) * inp.tumble * b.loose * math.min(1, sp * 0.5)
        + inp.roll
end

-- A world direction in the body's frame: Rz(roll)^T . Rx(pitch)^T . Ry(yaw)^T
-- applied to it, written out rather than built as a matrix because only the
-- three dots are wanted.
local function toBodyLocal(b: Ball, f: Fish, inp: Inputs, i: number, wx: number, wy: number, wz: number): (number, number, number)
    local yaw, pitch = yawPitchOf(f)
    local cy, sy = math.cos(yaw), math.sin(yaw)
    local cp, sp = math.cos(pitch), math.sin(pitch)
    -- The columns of Ry.Rx: the body's UN-ROLLED axes, in world. The third
    -- of them is -heading, which is what makes the head land at -z.
    local a = wx * cy + wz * -sy
    local c2 = wx * (sy * sp) + wy * cp + wz * (cy * sp)
    local c3 = wx * (sy * cp) + wy * -sp + wz * (cy * cp)
    local roll = rollOf(b, f, inp, i)
    local cr, sr = math.cos(roll), math.sin(roll)
    return a * cr + c2 * sr, -a * sr + c2 * cr, c3
end

-- ---------------------------------------------------------------------------
-- THE DENT. See the header: the warp is fish.wgsl's, these are its numbers.
-- ---------------------------------------------------------------------------

-- A contact squashes the body. Called for EVERY contact, not only the ones
-- loud enough to knock.
local function dentHit(b: Ball, f: Fish, inp: Inputs, i: number, speed: number, axis: number, cx: number, cy: number, cz: number)
    -- The DIRECTION and the PLACE are latched for any contact at all, and
    -- `dkick` carries the raw closing speed, because a rigged body's bone
    -- chains are shoved from the same contact and must not go quiet just
    -- because the vertex dent has been turned down. Only the dent's own
    -- spring is gated on `dentAmount`.
    local amp = math.min(1, speed * math.max(inp.dentAmount, 0.1))
    if speed <= 1e-4 then
        return
    end
    -- ONE SHOVE PER CONTACT. A body held against the glass by its seat
    -- spring trips `wall` on every single frame, and an impulse is a change
    -- of velocity, not a force — handed one 60 times a second the chain
    -- stores energy without bound and shakes itself apart. So the skeleton
    -- is shoved on the EDGE of a contact, and again only if the glass is
    -- hit HARDER than the shove that is already in it. The dent below wants
    -- the opposite and keeps taking every frame: it is a spring on a scalar
    -- that saturates, and a body leaning on the glass should stay squashed.
    if f.touch < 0.5 or speed > f.kickRef * 1.5 then
        f.dkick = speed
        f.kickRef = speed
    end
    f.touch = 1
    -- The wall's inward normal: away from whichever side of zero the contact
    -- is on, the same way the bubbles come off the glass.
    local wx = if axis == 1 then -math.sign(cx) else 0
    local wy = if axis == 2 then -math.sign(cy) else 0
    local wz = if axis == 3 then -math.sign(cz) else 0
    local nx, ny, nz = toBodyLocal(b, f, inp, i, wx, wy, wz)
    -- Where along the body it landed. The nose is +half along the heading
    -- and the mesh's head is at -z, so the sign flips.
    local d = (cx - f.x) * f.hx + (cy - f.y) * f.hy + (cz - f.z) * f.hz
    local z0 = math.max(-0.5, math.min(0.5, -d / math.max(1e-6, f.len)))
    -- A second contact while the first is still ringing TURNS the axis
    -- toward it rather than snapping to it, in proportion to how much it
    -- dominates what is already there. Snapping would re-orient the
    -- compression already in the body, which pops.
    local w = amp / (amp + math.abs(f.dent) + 1e-6)
    local mx, my, mz = f.dnx + (nx - f.dnx) * w, f.dny + (ny - f.dny) * w, f.dnz + (nz - f.dnz) * w
    local ml = math.sqrt(mx * mx + my * my + mz * mz)
    if ml < 1e-6 then
        mx, my, mz, ml = nx, ny, nz, 1
    end
    f.dnx, f.dny, f.dnz = mx / ml, my / ml, mz / ml
    f.dz0 += (z0 - f.dz0) * w
    f.dage *= 1 - w
    -- Kicked by VELOCITY, not set: a spring kicked with amp * omega peaks at
    -- amp, so `dentAmount` means the compression the body actually reaches
    -- rather than a number one step removed from it. Setting the value
    -- instead would also make a second contact a jump.
    if inp.dentAmount > 0 then
        f.dentV += math.min(1, speed * inp.dentAmount) * (2 * math.pi * math.max(0.01, inp.dentFreq))
    end
end

-- The squash rings back to nothing. ANALYTIC, not Euler: semi-implicit Euler
-- on a spring is stable only while omega * dt < 2, which a 12Hz ring passes
-- on the first slow frame — and the thing that found it would be a body
-- exploding on a hitch rather than a test.
local function stepDent(f: Fish, dt: number, inp: Inputs)
    if f.dent == 0 and f.dentV == 0 then
        return
    end
    f.dage += dt
    local om = 2 * math.pi * math.max(0.01, inp.dentFreq)
    local ze = math.max(0, math.min(0.98, inp.dentDamp))
    local wd = om * math.sqrt(1 - ze * ze)
    local e = math.exp(-ze * om * dt)
    local c, sn = math.cos(wd * dt), math.sin(wd * dt)
    local x, v = f.dent, f.dentV
    f.dent = e * (x * c + (v + ze * om * x) / wd * sn)
    f.dentV = e * (v * c - (om * om * x + ze * om * v) / wd * sn)
    f.dent = math.max(-1.2, math.min(1.2, f.dent))
    -- Snap: a dent this small is invisible, and exactly zero is the shader's
    -- early out, so a school at rest pays one compare instead of the warp.
    if math.abs(f.dent) < 1e-4 and math.abs(f.dentV) < 1e-3 then
        f.dent, f.dentV, f.dage = 0, 0, 0
    end
end

-- A knock knocks air loose. They come off the WALL, pushed along its inward
-- normal so they do not spawn inside the glass, and scattered a little so a
-- cluster does not rise as one blob.
--
-- Capped at MAX_BUBBLES per tank, oldest out first. A cap rather than a
-- promise: a dragged card rattles a dozen bodies off the walls at once, and
-- the honest failure there is losing the oldest bubble rather than growing a
-- list nobody is looking at.
local MAX_BUBBLES = 28

local function spawnBubbles(b: Ball, inp: Inputs, x: number, y: number, z: number, speed: number, axis: number)
    -- A hard knock makes more; a knock barely over the threshold makes one.
    local hard = math.min(1, speed / math.max(0.1, inp.hitSpeed * 4))
    local n = math.max(1, math.floor(inp.bubbleCount * (0.35 + 0.65 * hard) + 0.5))
    -- Inward, off the wall it hit: away from whichever side of zero it is on.
    local nx = if axis == 1 then -math.sign(x) else 0
    local ny = if axis == 2 then -math.sign(y) else 0
    local nz = if axis == 3 then -math.sign(z) else 0
    -- ALONG THE GLASS, not in a little cube around the contact point. A tank
    -- tile is the card's own size — 168px tall at scale 1 — and a bubble is
    -- about six of those pixels, so a handful scattered inside one diameter
    -- overlap into a single white blob and the whole thing reads as a smudge.
    -- Two tangents of the wall's normal give a patch to spread over.
    local t1x, t1y, t1z = ny, nz, nx          -- any vector not parallel to n
    local t2x, t2y, t2z = ny * t1z - nz * t1y, nz * t1x - nx * t1z, nx * t1y - ny * t1x
    local PATCH = 3.5                          -- diameters across the spawn patch
    for k = 1, n do
        if #b.bubbles >= MAX_BUBBLES then
            table.remove(b.bubbles, 1)
        end
        local h1 = hash(b.spinPhase * 13 + k * 7.7 + x * 31)
        local h2 = hash(b.spinPhase * 29 + k * 3.1 + y * 17)
        local h3 = hash(b.spinPhase * 41 + k * 5.3 + z * 23)
        local spread = inp.bubbleSpread * (0.4 + 0.6 * hard)
        local a = (h1 - 0.5) * inp.bubbleSize * PATCH
        local c = (h2 - 0.5) * inp.bubbleSize * PATCH
        table.insert(b.bubbles, {
            -- Nudged off the glass by its own radius, or the sphere is half
            -- buried in the wall for the whole of its first frame.
            x = x + nx * inp.bubbleSize * 0.6 + t1x * a + t2x * c,
            y = y + ny * inp.bubbleSize * 0.6 + t1y * a + t2y * c,
            z = z + nz * inp.bubbleSize * 0.6 + t1z * a + t2z * c,
            vx = nx * spread + (h2 - 0.5) * spread,
            vy = ny * spread + (h3 - 0.5) * spread + inp.bubbleRise * 0.5,
            vz = nz * spread + (h1 - 0.5) * spread,
            -- Staggered: a NEGATIVE age is a bubble that has not been let go
            -- yet. Released together they rise as one shape however far apart
            -- they start, and a knock should shed air over a moment.
            age = -(k - 1) * inp.bubbleLife * 0.09 * h3,
            life = inp.bubbleLife * (0.7 + 0.6 * h3),
            r = inp.bubbleSize * (0.45 + 0.55 * h1),
            wob = h2 * 6.283,
        })
    end
end

-- Bubbles rise, wander, and are gone. They do NOT collide with the walls:
-- they are air, they are small, and a bubble that bounces reads as a ball
-- bearing. One that drifts through the glass is off the edge of the tile and
-- clipped by the fragment stage anyway.
local function stepBubbles(b: Ball, dt: number, inp: Inputs)
    local k = 1
    while k <= #b.bubbles do
        local u = b.bubbles[k]
        u.age += dt
        if u.age >= u.life then
            table.remove(b.bubbles, k)
        elseif u.age < 0 then
            k += 1          -- not let go yet
        else
            -- Rise, easing up to speed: a bubble leaves the glass with the
            -- knock's push and only then becomes buoyant.
            u.vy += (inp.bubbleRise - u.vy) * (1 - math.exp(-3 * dt))
            u.vx -= u.vx * (1 - math.exp(-2.5 * dt))
            u.vz -= u.vz * (1 - math.exp(-2.5 * dt))
            local t = u.age / u.life
            u.x += (u.vx + math.sin(u.wob + u.age * 7) * inp.bubbleRise * 0.18) * dt
            u.y += u.vy * dt
            u.z += u.vz * dt
            k += 1
        end
    end
end

function M.update(b: Ball, dt: number, inp: Inputs)
    local n = math.max(1, math.min(16, math.floor(inp.count)))
    ensure(b, inp, n)
    -- Drained by the caller every frame it is filled, so a tank nobody is
    -- reading cannot grow a list for ever.
    table.clear(b.hits)
    -- The swirl: only a play starts it. A hover, a click or a drag never
    -- does — those jostle the box, they do not flock it.
    if inp.played then
        b.swirl = inp.swirlHold
    end
    local wantEx = if b.swirl > 0 then 1 else 0
    b.swirl = math.max(0, b.swirl - dt)
    b.excite += (wantEx - b.excite) * (1 - math.exp(-(if wantEx > b.excite then inp.swirlIn else inp.swirlOut) * dt))
    if inp.pressed then
        b.scatter = 1
    end
    b.scatter = math.max(0, b.scatter - dt * 1.6)
    b.spinPhase += dt * inp.spin * (1 + inp.exciteSpin * b.excite)
    -- Loose while dragged AND moving; a held card that stops, or one
    -- released, seats its bodies back into the number until it moves again.
    local cardSpeed = math.sqrt(inp.velX * inp.velX + inp.velY * inp.velY)
    local wantLoose = if inp.dragging and cardSpeed > inp.still then 1 else 0
    b.loose += (wantLoose - b.loose) * (1 - math.exp(-(if wantLoose > b.loose then inp.loosen else inp.settle) * dt))
    local seated = 1 - b.loose
    -- The card's acceleration is the water's: screen y down, tank y up.
    local kickX = -(inp.velX - b.prevVX) * inp.slosh
    local kickY = (inp.velY - b.prevVY) * inp.slosh
    b.prevVX, b.prevVY = inp.velX, inp.velY
    local w = inp.walls
    -- THE ENTRANCE. On the frame a court card's face shows, its creature is
    -- put past the right edge of the glass, nose in, and given a push toward
    -- its seat; the seat spring brings it the rest of the way and the far
    -- wall stays open (`enter`) until nose and tail are both inside, after
    -- which it is a wall again. Only a lone body that holds — a school in
    -- formation is the number, and the number has to be there on sight.
    if inp.revealed and inp.holds and n == 1 and inp.enterSpeed > 0 then
        local f = b.fish[1]
        local hx = halfAt(w, 0, 0)
        f.x = hx + f.len * 0.6
        f.y, f.z = 0, 0
        f.vx, f.vy, f.vz = -inp.enterSpeed, 0, 0
        f.hx, f.hy, f.hz = restHeading(f, 1, n, inp)
        f.enter = 1
    end
    for i = 1, n do
        local f = b.fish[i]
        -- The clip, at this body's own pace: a school swims out of step.
        f.phase = (f.phase + dt * inp.clipRate * (0.85 + 0.3 * f.h1)) % 1
        local tx, ty, tz = seat(b, f, inp, n, b.spinPhase, i)
        -- The seat is fitted for the REST heading; the body's ACTUAL heading
        -- — turned by a drag, a jolt, a bounce — reaches the walls
        -- differently, so the seat is clamped into the box THIS heading fits
        -- in, every frame. Without it the spring pulled the body into a wall
        -- it could never pass and the wall bounced it back, for ever.
        do
            local xlo, xhi, ylo, yhi, zlo, zhi = fitBox(w, f.hx, f.hy, f.hz, f.len * 0.5, f.len * 0.15)
            tx = if xlo <= xhi then math.max(xlo, math.min(xhi, tx)) else (xlo + xhi) * 0.5
            ty = if ylo <= yhi then math.max(ylo, math.min(yhi, ty)) else (ylo + yhi) * 0.5
            tz = if zlo <= zhi then math.max(zlo, math.min(zhi, tz)) else (zlo + zhi) * 0.5
        end
        -- The seat's pull fades as the box comes loose; friction and a
        -- little gravity take over, so they slide, sink and rattle.
        local pull = inp.spring * seated
        local dampen = inp.damp * seated + inp.friction * b.loose
        local ax = (tx - f.x) * pull - f.vx * dampen
        local ay = (ty - f.y) * pull - f.vy * dampen - inp.gravity * b.loose
        local az = (tz - f.z) * pull - f.vz * dampen
        f.vx += ax * dt + kickX
        f.vy += ay * dt + kickY
        f.vz += az * dt
        if inp.pressed then
            -- A jolt: each body shoved its own way, like a knock on the box.
            local push = inp.scatterPush * 2 * (0.6 + 0.8 * f.h2)
            local ang = f.h1 * 6.2832 + b.spinPhase
            f.vx += math.cos(ang) * push
            f.vy += (f.h3 - 0.5) * push
            f.vz += math.sin(ang) * push * 0.5
        end
        local sp = math.sqrt(f.vx * f.vx + f.vy * f.vy + f.vz * f.vz)
        if sp > MAX_SPEED then
            local k = MAX_SPEED / sp
            f.vx *= k; f.vy *= k; f.vz *= k
        end
        f.x += f.vx * dt
        f.y += f.vy * dt
        f.z += f.vz * dt
        -- The nose leans toward the motion, but a body HOLDS ITS FACING:
        -- the target never leaves a cone of `turnMax` around the rest
        -- heading (so a bounce or a backward drift never spins it round),
        -- and it turns at most `turn` radians a second — a body in water
        -- has a lot of rotational drag. Still, it eases back to rest.
        local rx, ry, rz = restHeading(f, i, n, inp)
        -- A HOLDING body needs a real push before its nose follows the
        -- motion: at 0.02 a slow creep steered the nose, the turned nose
        -- moved the seat it fits in, and the seat pulled a new creep — a
        -- yawed orca circling its own seat at a crawl, for ever.
        -- A HOLDING body keeps its facing whatever the box does to it: its
        -- nose never follows the motion. A long one that pitched with a
        -- shove swung its ends through the walls, the walls bounced it, the
        -- nose followed the bounce — and a big yawed orca rocked in its
        -- card for ever. The shove still moves it; it just stays broadside.
        local moving = sp > (if n == 1 or b.loose > 0.5 then 0.02 else 0.35) and not (n == 1 and inp.holds)
        local dx, dy, dz = rx, ry, rz
        if moving then
            dx, dy, dz = f.vx / sp, f.vy / sp, f.vz / sp
        end
        -- A lone body's turn cone is narrowed until its ENDS fit the room:
        -- at turnMax a body longer than the tank swung its nose and tail
        -- through the walls with every lean, and the walls swung it back.
        local cone = inp.turnMax
        if n == 1 then
            local rxw, ryw = halfAt(w, 0, f.len * 0.15)
            local room = math.min(rxw, ryw)
            if room < f.len * 0.5 then
                cone = math.min(cone, math.asin(math.max(0.05, room / (f.len * 0.5))))
            end
        end
        dx, dy, dz = clampCone(dx, dy, dz, rx, ry, rz, cone)
        f.hx, f.hy, f.hz = turnToward(f.hx, f.hy, f.hz, dx, dy, dz, 1 - math.exp(-HEAD_TURN * dt), inp.turn * dt)
        -- Walls: nose, then tail. Two passes so a body shoved into a corner
        -- settles with both ends inside.
        local half = f.len * 0.5
        local girth = f.len * 0.15
        -- ONE knock per body per frame, the hardest of them. `wall` runs four
        -- times here — two passes, nose and tail — and a body driven into a
        -- corner trips three walls at once, so taking them as they come would
        -- report a single collision as four.
        local best, bestAxis = 0, 0
        local bx, by, bz = 0, 0, 0
        if f.enter > 0 then
            local ex = halfAt(w, 0, f.len * 0.15)
            if f.x + math.abs(f.hx) * half <= ex then
                f.enter = 0
            end
        end
        for _ = 1, 2 do
            local nx, ny, nz = f.x + f.hx * half, f.y + f.hy * half, f.z + f.hz * half
            local sp, ax = wall(f, nx, ny, nz, girth, w, inp.bounce)
            if sp > best then best, bestAxis, bx, by, bz = sp, ax, nx, ny, nz end
            local tx2, ty2, tz2 = f.x - f.hx * half, f.y - f.hy * half, f.z - f.hz * half
            sp, ax = wall(f, tx2, ty2, tz2, girth, w, inp.bounce)
            if sp > best then best, bestAxis, bx, by, bz = sp, ax, tx2, ty2, tz2 end
        end
        -- A body longer than the room between two walls can never satisfy
        -- both: nose clamped in, tail clamped out, the velocity reflected
        -- twice a frame — an infinite bounce. Park it at the midpoint of
        -- what it has and kill that axis's velocity; the reflection only
        -- means something when there is somewhere to reflect to.
        do
            local xlo, xhi, ylo, yhi, zlo, zhi = fitBox(w, f.hx, f.hy, f.hz, half, girth)
            if xlo > xhi then f.x = (xlo + xhi) * 0.5; f.vx = 0 end
            if ylo > yhi then f.y = (ylo + yhi) * 0.5; f.vy = 0 end
            if zlo > zhi then f.z = (zlo + zhi) * 0.5; f.vz = 0 end
        end
        f.cool = math.max(0, f.cool - dt)
        f.dkick = 0
        local wasTouching = f.touch
        f.touch = 0
        -- THE DENT takes the contact raw. The knock below is throttled — a
        -- body scraping the glass would otherwise machine-gun — and a touch
        -- under `hitSpeed` is too quiet to hear but still squashes.
        if bestAxis > 0 then
            f.touch = wasTouching
            dentHit(b, f, inp, i, best, bestAxis, bx, by, bz)
        else
            -- Off the glass: the next touch is a new contact again.
            f.kickRef = 0
        end
        stepDent(f, dt, inp)
        if best >= inp.hitSpeed and f.cool <= 0 and bestAxis > 0 then
            f.cool = inp.hitGap
            table.insert(b.hits, { x = bx, y = by, z = bz, speed = best, axis = bestAxis, len = f.len })
            spawnBubbles(b, inp, bx, by, bz, best, bestAxis)
        end
    end
    stepBubbles(b, dt, inp)
end

-- Is every body inside the frustum, nose and tail, with this margin of
-- slack? The test's question, and a cheap one to keep next to the sim.
function M.inside(b: Ball, inp: Inputs, slack: number): boolean
    local n = math.max(1, math.min(16, math.floor(inp.count)))
    for i = 1, math.min(n, #b.fish) do
        local f = b.fish[i]
        local half = f.len * 0.5
        for _, s in ipairs({ half, -half }) do
            local qx, qy, qz = f.x + f.hx * s, f.y + f.hy * s, f.z + f.hz * s
            local hx, hy = halfAt(inp.walls, qz, 0)
            if math.abs(qx) > hx + slack or math.abs(qy) > hy + slack or qz > inp.walls.zFront + slack or qz < inp.walls.zBack - slack then
                return false
            end
        end
    end
    return true
end

-- Write `count` instances (STRIDE bytes each: the model's four columns, the
-- back colour + shine, the belly colour, and a tile slot the table fills)
-- at `at` into `buf`. Returns the next byte offset.
-- The bubbles, as instances of the `bubble` species. Same stride and same
-- layout as a body, so the caller stamps the tile onto them exactly as it
-- does the fish — a bubble IS a creature as far as the pipeline is concerned,
-- which is the whole reason this costs no new pass.
--
-- `back` is the colour and belly.w is the emissive flag fish.wgsl reads: flat
-- white, no shading, brighter at the rim. `cap` is how many instances the
-- caller has room for, because the bubble buffer is shared by every tank on
-- screen and one rattling card must not eat the whole thing.
function M.writeBubbles(b: Ball, buf: buffer, at: number, cap: number): number
    local wrote = 0
    for _, u in ipairs(b.bubbles) do
        if wrote >= cap then
            break
        end
        -- Fade by SHRINKING, not by alpha: the pipeline is opaque, so a
        -- bubble that faded would simply pop out at full brightness.
        local t = u.age / u.life
        local grow = math.min(1, u.age * 9)          -- swells as it leaves the glass
        local d = u.r * grow * (1 - t * t)
        if u.age >= 0 and d > 0.0015 then
            local model = Mat4.fromTranslation(u.x, u.y, u.z) * Mat4.fromScale(d, d, d)
            model:writeToBuffer(buf, at)
            buffer.writef32(buf, at + 64, 1.0)
            buffer.writef32(buf, at + 68, 1.0)
            buffer.writef32(buf, at + 72, 1.0)
            buffer.writef32(buf, at + 76, 1.0)
            buffer.writef32(buf, at + 80, 1.0)
            buffer.writef32(buf, at + 84, 1.0)
            buffer.writef32(buf, at + 88, 1.0)
            buffer.writef32(buf, at + 92, 1.0)   -- emissive
            -- No pose (the identity palette, weight 0), no glow, no dent.
            for k = 112, 204, 4 do
                buffer.writef32(buf, at + k, 0)
            end
            at += STRIDE
            wrote += 1
        end
    end
    return at
end

function M.write(b: Ball, inp: Inputs, buf: buffer, at: number): number
    local n = math.max(1, math.min(16, math.floor(inp.count)))
    ensure(b, inp, n)
    for i = 1, n do
        local f = b.fish[i]
        -- yawPitchOf and rollOf are the dent's frame too, which is the
        -- point of their being functions: a squash latched in the body's
        -- frame and a mesh placed in a different one would slide.
        local yaw, pitch = yawPitchOf(f)
        local model = Mat4.fromTranslation(f.x, f.y, f.z)
            * Mat4.fromRotationY(yaw)
            * Mat4.fromRotationX(pitch)
            * Mat4.fromRotationZ(rollOf(b, f, inp, i))
            * Mat4.fromScale(f.len, f.len, f.len)
        model:writeToBuffer(buf, at)
        local v = 0.92 + 0.08 * f.h1
        buffer.writef32(buf, at + 64, inp.back[1] * v)
        buffer.writef32(buf, at + 68, inp.back[2] * v)
        buffer.writef32(buf, at + 72, inp.back[3] * v)
        buffer.writef32(buf, at + 76, 0.3 + 0.7 * b.excite)
        buffer.writef32(buf, at + 80, inp.belly[1])
        buffer.writef32(buf, at + 84, inp.belly[2])
        buffer.writef32(buf, at + 88, inp.belly[3])
        buffer.writef32(buf, at + 92, 0)
        -- The tile (96..111) is stamped by the caller. Then the pose and the glow.
        buffer.writef32(buf, at + 112, f.phase)
        buffer.writef32(buf, at + 116, if inp.clipRate > 0 then inp.clipWeight else 0)
        -- The dent's place and age ride in anim's two spare slots; its
        -- direction and depth are the tenth column.
        buffer.writef32(buf, at + 120, f.dz0)
        buffer.writef32(buf, at + 124, f.dage)
        buffer.writef32(buf, at + 128, inp.bio[1])
        buffer.writef32(buf, at + 132, inp.bio[2])
        buffer.writef32(buf, at + 136, inp.bio[3])
        buffer.writef32(buf, at + 140, inp.bioStrength)
        buffer.writef32(buf, at + 144, f.dnx)
        buffer.writef32(buf, at + 148, f.dny)
        buffer.writef32(buf, at + 152, f.dnz)
        buffer.writef32(buf, at + 156, f.dent)
        buffer.writef32(buf, at + 160, inp.bioSpeed)
        buffer.writef32(buf, at + 164, inp.bioScale)
        buffer.writef32(buf, at + 168, inp.bioContrast)
        buffer.writef32(buf, at + 172, inp.bioCoverage)
        buffer.writef32(buf, at + 176, inp.bioPan)
        buffer.writef32(buf, at + 180, inp.bioEvolve)
        buffer.writef32(buf, at + 184, 0)
        buffer.writef32(buf, at + 188, 0)
        -- THE RIG COLUMN. x is WHICH ROW of the bend palette is this
        -- body's (fish.wgsl, tankrig.luau): `at` is a byte offset into the
        -- SPECIES' instance buffer, so at // STRIDE is its index among
        -- every body of that species this frame, across all the cards —
        -- not `i`, which only counts within one card.
        --
        -- It gets a column of its own rather than riding in the whole
        -- number of anim.x, which the shader's `fract` would have made
        -- free: anim.x means the clip phase, and there is a test that says
        -- so. Three floats spare.
        buffer.writef32(buf, at + 192, at // STRIDE)
        buffer.writef32(buf, at + 196, 0)
        buffer.writef32(buf, at + 200, 0)
        buffer.writef32(buf, at + 204, 0)
        at += STRIDE
    end
    return at
end

return M
