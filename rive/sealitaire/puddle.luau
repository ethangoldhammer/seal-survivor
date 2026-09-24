-- ============================================================================
-- THE PUDDLE — what the goo is made of. goo.wgsl draws it; this module
-- decides what is in the field each frame and moves the droplets.
--
-- Three kinds of primitive go into the distance field:
--
--   STACKS    one rounded box per pile, spanning the cards that have SETTLED
--             (close to their slot and slow). The skirt around it is the goo
--             you see hugging a column.
--   FLIERS    a card still on its way — mid-deal, mid-move, mid-spiral — is a
--             box of its own, rotated with the card, so the goo travels with
--             it and pours into the stack as it lands.
--   IMPACTS   a card settling on its slot — a play, a draw, a deal — is a
--             slap the shape of the card: foam.wgsl runs a front out from
--             its edge. A PLAY is announced by the table (`play`) so a card
--             dropped straight onto its slot hits as hard as one that flew.
--   MOVERS    every card in flight or in hand, with its speed and heading,
--             for the bow wave foam.wgsl pushes off its leading edge.
--   DROPS     circles with a life of their own. A landing throws a handful
--             out (more for a harder landing); a dragged run sheds a wake
--             behind it. Each flies free for a moment, then is pulled to the
--             nearest body and, once inside it, shrinks away — the fuse. The
--             shader's smooth-union does the rest: a drop leaving stretches a
--             neck that snaps, a drop arriving merges without a seam.
--
-- Pure: no renderer. table.luau hands it the frame and it writes the shader's
-- body and drop rows into the uniform buffer.
-- ============================================================================

local MAX_BODIES = 24
local MAX_DROPS = 24
local MAX_IMPACTS = 8
local MAX_MOVERS = 12
local IMPACT_LIFE = 2.6     -- s, a front is spent by then
local MOVER_SPEED = 60      -- px/s, slower than this leaves no wake

-- Uniform rows 0..2 are the table's (res, time, energy, sizes, tunables);
-- rows 3.. are ours. Offsets in bytes.
local ROW_COUNTS = 48
local ROW_BODIES = 64
local ROW_DROPS = ROW_BODIES + MAX_BODIES * 32
local UBO_SIZE = ROW_DROPS + MAX_DROPS * 16

-- foam.wgsl's rows: counts in row 4 (z, w), then impacts, then movers.
local FOAM_ROW_COUNTS = 64
local FOAM_ROW_IMPACTS = 80
local FOAM_ROW_MOVERS = FOAM_ROW_IMPACTS + MAX_IMPACTS * 32
local FOAM_UBO_SIZE = FOAM_ROW_MOVERS + MAX_MOVERS * 32

-- The px numbers below — and MOVER_SPEED above — were all measured against a
-- 120x168 card, so every one of them is multiplied by `g.px`, the card's
-- scale at this viewport (layout.luau's `fit`). Left absolute, a droplet
-- thrown off a 45px phone card would be half the card wide and would fly
-- three card-lengths before it was pulled home.
local SETTLE_DIST = 10      -- px from its slot at which a card counts as landed
local SETTLE_SPEED = 260    -- px/s, and no faster than this
local WAKE_STEP = 58        -- px of drag travel per shed drop
local DROP_MAX_AGE = 4.5    -- s, a drop that never finds a body dies anyway

-- A card as the table keeps it: sprung position, slot, velocity, lean.
export type Card = {
    x: number, y: number, tx: number, ty: number,
    vx: number, vy: number, rot: number, scale: number,
}

export type Pile = { cards: { { id: number } } }

export type Drop = {
    x: number, y: number, vx: number, vy: number,
    r: number,
    age: number,
    free: number,       -- seconds before the pull home starts
    life: number,       -- 0..1, the shader grows the radius in over the first quarter; falls to 0 as it fuses
    fusing: boolean,
}

export type Impact = {
    x: number, y: number, hw: number, hh: number, rot: number,
    age: number, strength: number,
}

export type Mover = {
    cx: number, cy: number, hw: number, hh: number, rot: number,
    speed: number, dx: number, dy: number,
}

export type Body = {
    cx: number, cy: number, hw: number, hh: number,
    rot: number, radius: number, phase: number, kind: number,
}

export type Goo = {
    drops: { Drop },
    bodies: { Body },
    nBodies: number,
    settled: { [number]: boolean },
    peak: { [number]: number },     -- the fastest a card went on its current flight
    pending: { [number]: number },  -- a play's strength, paid out when the card settles
    impacts: { Impact },
    movers: { Mover },
    nMovers: number,
    dragX: number, dragY: number, dragDist: number, dragging: boolean,
    px: number,                     -- this frame's card scale, from the Frame
}

export type Frame = {
    dt: number,
    views: { Card },                -- by card id
    piles: { Pile },
    dragIds: { number }?,           -- the run in hand, head first
    cw: number, ch: number,         -- a card's size, px
    px: number,                     -- the card's scale: every px constant here rides it
    splash: number,                 -- droplets per landing, scale
    won: boolean,
}

local function newBody(): Body
    return { cx = 0, cy = 0, hw = 0, hh = 0, rot = 0, radius = 10, phase = 0, kind = 0 }
end

local function new(): Goo
    local bodies: { Body } = {}
    for i = 1, MAX_BODIES do
        bodies[i] = newBody()
    end
    local movers: { Mover } = {}
    for i = 1, MAX_MOVERS do
        movers[i] = { cx = 0, cy = 0, hw = 0, hh = 0, rot = 0, speed = 0, dx = 0, dy = 0 }
    end
    return {
        drops = {},
        bodies = bodies,
        nBodies = 0,
        settled = {},
        peak = {},
        pending = {},
        impacts = {},
        movers = movers,
        nMovers = 0,
        dragX = 0, dragY = 0, dragDist = 0, dragging = false, px = 1,
    }
end

-- ---------------------------------------------------------------------------
-- Drops
-- ---------------------------------------------------------------------------
local function addDrop(g: Goo, d: Drop)
    if #g.drops >= MAX_DROPS then
        -- The oldest gives way.
        local oldest, oldestAge = 1, -1
        for i, o in ipairs(g.drops) do
            if o.age > oldestAge then
                oldest, oldestAge = i, o.age
            end
        end
        table.remove(g.drops, oldest)
    end
    table.insert(g.drops, d)
end

-- A landing: `strength` 0..1 sets how many, how fast, how big. The drops
-- start ON the edge of the card (hw, hh from its centre), not inside it —
-- born under the silhouette they would fuse before they were ever seen.
-- `free` is how long a drop flies before the pull home starts on it, and it
-- is the difference between a splash and a THROW: the pull is 2400px/s2 and
-- it wins in a few frames, so drops born at the deck's edge are swallowed by
-- the deck before they have gone anywhere. A landing wants that — the goo
-- belongs to the stack it lands on — and a card ripped off the top of a wound
-- deck wants its water to get out first. Blank is the landing's 0.18.
local function splash(g: Goo, x: number, y: number, hw: number, hh: number, strength: number, count: number, free: number?)
    local px = g.px
    local hold = free or 0.18
    for _ = 1, count do
        local a = math.random() * math.pi * 2
        local ca, sa = math.cos(a), math.sin(a)
        local edge = 1 / math.max(math.abs(ca) / hw, math.abs(sa) / hh)
        local speed = (260 + 620 * strength) * (0.55 + 0.9 * math.random()) * px
        local r = (5 + 8 * math.random()) * (0.7 + 0.7 * strength) * px
        addDrop(g, {
            x = x + ca * (edge + 6 * px), y = y + sa * (edge + 6 * px),
            vx = ca * speed, vy = sa * speed,
            r = r, age = 0, free = hold + 0.25 * math.random(), life = 0, fusing = false,
        })
    end
end

-- ---------------------------------------------------------------------------
-- Impacts and movers, for the whitewater.
-- ---------------------------------------------------------------------------
-- The table calls this when a run is played to a valid pile: the strength
-- waits on each card until it settles, then the slap fires from its edge.
local function play(g: Goo, ids: { number }, strength: number)
    for _, id in ipairs(ids) do
        g.pending[id] = math.max(g.pending[id] or 0, strength)
    end
end

local function impact(g: Goo, x: number, y: number, hw: number, hh: number, rot: number, strength: number)
    table.insert(g.impacts, 1, { x = x, y = y, hw = hw, hh = hh, rot = rot, age = 0, strength = strength })
    while #g.impacts > MAX_IMPACTS do
        table.remove(g.impacts)
    end
end

local function pushMover(g: Goo, cx: number, cy: number, hw: number, hh: number, rot: number, vx: number, vy: number)
    local speed = math.sqrt(vx * vx + vy * vy)
    if speed < MOVER_SPEED * g.px or g.nMovers >= MAX_MOVERS then
        return
    end
    g.nMovers += 1
    local m = g.movers[g.nMovers]
    m.cx, m.cy, m.hw, m.hh, m.rot = cx, cy, hw, hh, rot
    m.speed, m.dx, m.dy = speed, vx / speed, vy / speed
end

-- ---------------------------------------------------------------------------
-- The field on the CPU, for the pull home: the same rounded box the shader
-- draws, minus the skirt and the wobble (a drop only needs to know which way
-- is in).
-- ---------------------------------------------------------------------------
local function sdBody(b: Body, px: number, py: number): number
    local c, s = math.cos(b.rot), math.sin(b.rot)
    local qx0, qy0 = px - b.cx, py - b.cy
    local qx = c * qx0 + s * qy0
    local qy = -s * qx0 + c * qy0
    local dx = math.abs(qx) - b.hw + b.radius
    local dy = math.abs(qy) - b.hh + b.radius
    local ox, oy = math.max(dx, 0), math.max(dy, 0)
    return math.sqrt(ox * ox + oy * oy) + math.min(math.max(dx, dy), 0) - b.radius
end

local function nearest(g: Goo, px: number, py: number): (number, number)
    local best, bestD = 0, 1e9
    for i = 1, g.nBodies do
        local d = sdBody(g.bodies[i], px, py)
        if d < bestD then
            best, bestD = i, d
        end
    end
    return best, bestD
end

local function updateDrops(g: Goo, dt: number)
    local drag = math.exp(-3.2 * dt)
    local i = 1
    while i <= #g.drops do
        local d = g.drops[i]
        d.age += dt
        if d.fusing then
            d.life = math.max(0, d.life - dt * 6)
        else
            d.life = math.min(1, d.life + dt * 10)
        end
        d.vx *= drag
        d.vy *= drag
        if d.age > d.free and g.nBodies > 0 then
            local k, sd = nearest(g, d.x, d.y)
            local b = g.bodies[k]
            if sd < -d.r * 0.4 then
                -- Well inside: it is the body now.
                d.fusing = true
            else
                -- Down the gradient of the distance: straight at the edge.
                local e = 1
                local gx = sdBody(b, d.x + e, d.y) - sd
                local gy = sdBody(b, d.x, d.y + e) - sd
                local len = math.sqrt(gx * gx + gy * gy)
                if len > 1e-4 then
                    local pull = (2400 + 900 * math.min(1, d.age)) * g.px
                    d.vx -= gx / len * pull * dt
                    d.vy -= gy / len * pull * dt
                end
            end
        end
        d.x += d.vx * dt
        d.y += d.vy * dt
        if (d.fusing and d.life <= 0) or d.age > DROP_MAX_AGE then
            table.remove(g.drops, i)
        else
            i += 1
        end
    end
end

-- ---------------------------------------------------------------------------
-- Bodies, from the piles and the cards in flight.
-- ---------------------------------------------------------------------------
local function pushBody(g: Goo, cx: number, cy: number, hw: number, hh: number, rot: number, radius: number, phase: number, kind: number): boolean
    if g.nBodies >= MAX_BODIES then
        return false
    end
    g.nBodies += 1
    local b = g.bodies[g.nBodies]
    b.cx, b.cy, b.hw, b.hh = cx, cy, hw, hh
    b.rot, b.radius, b.phase, b.kind = rot, radius, phase, kind
    return true
end

local function advance(g: Goo, f: Frame)
    local dt = f.dt
    local hw, hh = f.cw / 2, f.ch / 2
    local px = if f.px > 0 then f.px else 1
    g.px = px
    g.nBodies = 0
    g.nMovers = 0
    local i = 1
    while i <= #g.impacts do
        local im = g.impacts[i]
        im.age += dt
        if im.age > IMPACT_LIFE then
            table.remove(g.impacts, i)
        else
            i += 1
        end
    end

    local inHand: { [number]: boolean } = {}
    local dragIds = f.dragIds
    if dragIds ~= nil then
        for _, id in ipairs(dragIds) do
            inHand[id] = true
        end
    end

    -- Landings first, so a splash can see the stack it lands on.
    local fliers: { number } = {}
    for pi, p in ipairs(f.piles) do
        local minX, minY, maxX, maxY = 1e9, 1e9, -1e9, -1e9
        local any = false
        for _, card in ipairs(p.cards) do
            local id = card.id
            if not inHand[id] then
                local v = f.views[id]
                local dx, dy = v.x - v.tx, v.y - v.ty
                local speed = math.sqrt(v.vx * v.vx + v.vy * v.vy)
                local settled = dx * dx + dy * dy < (SETTLE_DIST * px) * (SETTLE_DIST * px) and speed < SETTLE_SPEED * px
                if settled then
                    if not g.settled[id] then
                        -- It just landed: the harder it came in, the bigger
                        -- the splash — and a play hits at least as hard as
                        -- the table said it would.
                        local peak = g.peak[id] or 0
                        local strength = if peak > 300 then math.min(1, (peak - 300) / 1400) else 0
                        strength = math.max(strength, g.pending[id] or 0)
                        g.pending[id] = nil
                        if strength > 0.08 then
                            local n = math.floor((1.5 + 5 * strength) * f.splash + 0.5)
                            splash(g, v.x, v.y, hw, hh, strength, n)
                            impact(g, v.x, v.y, hw * v.scale, hh * v.scale, v.rot, strength)
                        end
                        g.peak[id] = 0
                    end
                    any = true
                    minX, maxX = math.min(minX, v.x), math.max(maxX, v.x)
                    minY, maxY = math.min(minY, v.y), math.max(maxY, v.y)
                else
                    g.peak[id] = math.max(g.peak[id] or 0, speed)
                    table.insert(fliers, id)
                end
                g.settled[id] = settled
            end
        end
        if any then
            pushBody(g, (minX + maxX) / 2, (minY + maxY) / 2,
                hw + (maxX - minX) / 2, hh + (maxY - minY) / 2, 0, 10 * px, pi * 1.71, 0)
        end
    end

    -- The run in hand: one body, leaning with the head card.
    if dragIds ~= nil and #dragIds > 0 then
        local head = f.views[dragIds[1]]
        local tail = f.views[dragIds[#dragIds]]
        local cx, cy = (head.x + tail.x) / 2, (head.y + tail.y) / 2
        pushBody(g, cx, cy, hw * head.scale, hh * head.scale + math.abs(tail.y - head.y) / 2,
            head.rot, 10 * px, 0.5, 2)
        pushMover(g, cx, cy, hw * head.scale, hh * head.scale + math.abs(tail.y - head.y) / 2,
            head.rot, head.vx, head.vy)
        -- The wake: a drop shed every WAKE_STEP px, behind the motion.
        if g.dragging then
            local mx, my = head.x - g.dragX, head.y - g.dragY
            local moved = math.sqrt(mx * mx + my * my)
            g.dragDist += moved
            if g.dragDist >= WAKE_STEP * px and moved > 0.5 * px then
                g.dragDist = 0
                local ux, uy = mx / moved, my / moved
                local side = (math.random() - 0.5) * 2
                -- Behind the run: from its centre, back past its own edge.
                local back = 1 / math.max(math.abs(ux) / (hw + 4 * px), math.abs(uy) / (hh + math.abs(tail.y - head.y) / 2 + 4 * px))
                addDrop(g, {
                    x = cx - ux * (back + 8 * px) + uy * side * hw * 0.5,
                    y = cy - uy * (back + 8 * px) - ux * side * hw * 0.5,
                    vx = (-ux * 140 + uy * side * 80) * px, vy = (-uy * 140 - ux * side * 80) * px,
                    r = (6 + 5 * math.random()) * px, age = 0, free = 0.3, life = 0, fusing = false,
                })
            end
        else
            g.dragDist = 0
        end
        g.dragX, g.dragY, g.dragging = head.x, head.y, true
        for _, id in ipairs(dragIds) do
            g.settled[id] = false
            g.peak[id] = 0
        end
    else
        g.dragging = false
    end

    -- Cards in flight, each its own body, while there is room.
    for _, id in ipairs(fliers) do
        local v = f.views[id]
        pushMover(g, v.x, v.y, hw * v.scale, hh * v.scale, v.rot, v.vx, v.vy)
        if not pushBody(g, v.x, v.y, hw * v.scale, hh * v.scale, v.rot, 10 * px, id * 0.37, 1) then
            break
        end
    end

    updateDrops(g, dt)
end

-- ---------------------------------------------------------------------------
-- Into the shader's uniform rows.
-- ---------------------------------------------------------------------------
local function write(g: Goo, b: buffer)
    buffer.writef32(b, ROW_COUNTS, g.nBodies)
    buffer.writef32(b, ROW_COUNTS + 4, #g.drops)
    buffer.writef32(b, ROW_COUNTS + 8, 0)
    buffer.writef32(b, ROW_COUNTS + 12, 0)
    for i = 1, g.nBodies do
        local body = g.bodies[i]
        local at = ROW_BODIES + (i - 1) * 32
        buffer.writef32(b, at, body.cx)
        buffer.writef32(b, at + 4, body.cy)
        buffer.writef32(b, at + 8, body.hw)
        buffer.writef32(b, at + 12, body.hh)
        buffer.writef32(b, at + 16, body.rot)
        buffer.writef32(b, at + 20, body.radius)
        buffer.writef32(b, at + 24, body.phase)
        buffer.writef32(b, at + 28, body.kind)
    end
    for i, d in ipairs(g.drops) do
        local at = ROW_DROPS + (i - 1) * 16
        buffer.writef32(b, at, d.x)
        buffer.writef32(b, at + 4, d.y)
        buffer.writef32(b, at + 8, d.r)
        buffer.writef32(b, at + 12, d.life)
    end
end

-- foam.wgsl's rows: the impacts and the movers.
local function writeFoam(g: Goo, b: buffer, rewind: number)
    buffer.writef32(b, FOAM_ROW_COUNTS + 8, #g.impacts)
    buffer.writef32(b, FOAM_ROW_COUNTS + 12, g.nMovers)
    for i, im in ipairs(g.impacts) do
        local at = FOAM_ROW_IMPACTS + (i - 1) * 32
        buffer.writef32(b, at, im.x)
        buffer.writef32(b, at + 4, im.y)
        buffer.writef32(b, at + 8, im.hw)
        buffer.writef32(b, at + 12, im.hh)
        buffer.writef32(b, at + 16, im.rot)
        buffer.writef32(b, at + 20, math.max(0, im.age - rewind))
        buffer.writef32(b, at + 24, im.strength)
        buffer.writef32(b, at + 28, 0)
    end
    for i = 1, g.nMovers do
        local m = g.movers[i]
        local at = FOAM_ROW_MOVERS + (i - 1) * 32
        buffer.writef32(b, at, m.cx)
        buffer.writef32(b, at + 4, m.cy)
        buffer.writef32(b, at + 8, m.hw)
        buffer.writef32(b, at + 12, m.hh)
        buffer.writef32(b, at + 16, m.rot)
        buffer.writef32(b, at + 20, m.speed)
        buffer.writef32(b, at + 24, m.dx)
        buffer.writef32(b, at + 28, m.dy)
    end
end

return {
    UBO_SIZE = UBO_SIZE,
    FOAM_UBO_SIZE = FOAM_UBO_SIZE,
    new = new,
    advance = advance,
    splash = splash,
    play = play,
    write = write,
    writeFoam = writeFoam,
}
