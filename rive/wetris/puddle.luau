-- ============================================================================
-- THE PUDDLE — what wetris's goo is made of. goo.wgsl (sealitaire's own,
-- linked, not copied) draws it; this module decides what is in the field each
-- frame and moves the droplets.
--
-- Sealitaire's puddle.luau builds its field from cards: a box per settled
-- pile, one per card in flight. The shader does not know what a card is — it
-- takes rounded boxes and circles — so this is the same idea fed from a well:
--
--   STACK     the filled cells as few rectangles as they will go (see
--             stackBoxes). Side by side they touch, and the shader's
--             smooth-union melts them into one skyline, so the goo hugs the
--             stack's silhouette and fills its seams without the field ever
--             needing a box per cell — 24 bodies would not cover a quarter of
--             a full well.
--   FLOOR     a thin lining along the well's bottom, so the stack sits in
--             a pool and a drop always has somewhere low to go home to.
--   PIECE     the live piece, one box per row of it, riding its drawn
--             position so the goo slides with it and reaches for the stack
--             as it comes down.
--   IMPACTS   a lock is a slap the shape of the piece: foam.wgsl runs a front
--             out from it. A clear is a slap the width of the well.
--   MOVERS    a piece moving fast — a hard drop's streak, a soft drop —
--             pushes a bow wave off its leading edge.
--   DROPS     thrown by a lock and by every cleared row, flown free for a
--             beat, then pulled back to the nearest body and fused into it.
--
-- The uniform layouts are goo.wgsl's and foam.wgsl's, byte for byte, so the
-- offsets below are sealitaire's. Pure: no renderer.
-- ============================================================================

local MAX_BODIES = 24
local MAX_DROPS = 24
local MAX_IMPACTS = 8
local MAX_MOVERS = 12
local IMPACT_LIFE = 2.6     -- s, a front is spent by then
local MOVER_SPEED = 60      -- px/s at px 1, slower than this leaves no wake
local DROP_MAX_AGE = 4.5    -- s, a drop that never finds a body dies anyway

local ROW_COUNTS = 48
local ROW_BODIES = 64
local ROW_DROPS = ROW_BODIES + MAX_BODIES * 32
local UBO_SIZE = ROW_DROPS + MAX_DROPS * 16

local FOAM_ROW_COUNTS = 64
local FOAM_ROW_IMPACTS = 80
local FOAM_ROW_MOVERS = FOAM_ROW_IMPACTS + MAX_IMPACTS * 32
local FOAM_UBO_SIZE = FOAM_ROW_MOVERS + MAX_MOVERS * 32

export type Drop = {
    x: number, y: number, vx: number, vy: number,
    r: number, age: number, free: number, life: number, fusing: boolean,
}

export type Impact = {
    x: number, y: number, hw: number, hh: number, rot: number,
    age: number, strength: number,
}

-- A mover with a life of its own: a hard drop is over in one frame, and its
-- bow wave has to outlive the frame that caused it to be seen at all.
export type Streak = {
    cx: number, cy: number, hw: number, hh: number,
    vx: number, vy: number, life: number,
}

export type Body = {
    cx: number, cy: number, hw: number, hh: number,
    rot: number, radius: number, phase: number, kind: number,
}

export type Goo = {
    drops: { Drop },
    bodies: { Body },
    nBodies: number,
    impacts: { Impact },
    streaks: { Streak },
    movers: { { number } },     -- cx, cy, hw, hh, speed, dx, dy
    nMovers: number,
    px: number,
}

-- The board as the goo needs it, in artboard px.
export type Frame = {
    dt: number,
    cells: { { number } },      -- cells[row][col], 0 empty
    cols: number,
    rows: number,
    cell: number,               -- one cell's size, px
    ox: number, oy: number,     -- the well's top-left, px
    piece: { { number } },      -- the live piece's cells as drawn: {x, y} top-left px
    pieceVx: number, pieceVy: number,
    px: number,                 -- the board's scale against a 45px cell
}

local function new(): Goo
    local bodies: { Body } = {}
    for i = 1, MAX_BODIES do
        bodies[i] = { cx = 0, cy = 0, hw = 0, hh = 0, rot = 0, radius = 10, phase = 0, kind = 0 }
    end
    local movers = {}
    for i = 1, MAX_MOVERS do
        movers[i] = { 0, 0, 0, 0, 0, 0, 0 }
    end
    return {
        drops = {}, bodies = bodies, nBodies = 0,
        impacts = {}, streaks = {}, movers = movers, nMovers = 0, px = 1,
    }
end

-- ---------------------------------------------------------------------------

local function addDrop(g: Goo, d: Drop)
    if #g.drops >= MAX_DROPS then
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

-- sealitaire's splash, unchanged but for its reference size: drops born on
-- the edge of a box and thrown outward, free for `free` s before the pull.
-- `up` biases them skyward, because in a well the only open side is the top.
local function splash(g: Goo, x: number, y: number, hw: number, hh: number, strength: number, count: number, free: number?, up: number?)
    local px = g.px
    local hold = free or 0.18
    local lift = up or 0
    for _ = 1, count do
        local a = math.random() * math.pi * 2
        local ca, sa = math.cos(a), math.sin(a)
        sa = sa * (1 - lift) - lift
        local n = math.sqrt(ca * ca + sa * sa)
        ca, sa = ca / n, sa / n
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

local function impact(g: Goo, x: number, y: number, hw: number, hh: number, strength: number)
    table.insert(g.impacts, 1, { x = x, y = y, hw = hw, hh = hh, rot = 0, age = 0, strength = strength })
    while #g.impacts > MAX_IMPACTS do
        table.remove(g.impacts)
    end
end

local function streak(g: Goo, cx: number, cy: number, hw: number, hh: number, vx: number, vy: number, life: number)
    table.insert(g.streaks, { cx = cx, cy = cy, hw = hw, hh = hh, vx = vx, vy = vy, life = life })
end

local function pushMover(g: Goo, cx: number, cy: number, hw: number, hh: number, vx: number, vy: number)
    local speed = math.sqrt(vx * vx + vy * vy)
    if speed < MOVER_SPEED * g.px or g.nMovers >= MAX_MOVERS then
        return
    end
    g.nMovers += 1
    local m = g.movers[g.nMovers]
    m[1], m[2], m[3], m[4] = cx, cy, hw, hh
    m[5], m[6], m[7] = speed, vx / speed, vy / speed
end

local function pushBody(g: Goo, cx: number, cy: number, hw: number, hh: number, radius: number, phase: number, kind: number): boolean
    if g.nBodies >= MAX_BODIES then
        return false
    end
    g.nBodies += 1
    local b = g.bodies[g.nBodies]
    b.cx, b.cy, b.hw, b.hh = cx, cy, hw, hh
    b.rot, b.radius, b.phase, b.kind = 0, radius, phase, kind
    return true
end

-- ---------------------------------------------------------------------------
-- The field on the CPU, for the pull home.

local function sdBody(b: Body, px: number, py: number): number
    local dx = math.abs(px - b.cx) - b.hw + b.radius
    local dy = math.abs(py - b.cy) - b.hh + b.radius
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
                d.fusing = true
            else
                local gx = sdBody(b, d.x + 1, d.y) - sd
                local gy = sdBody(b, d.x, d.y + 1) - sd
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

-- THE STACK AS FEW BOXES AS IT WILL GO. Two decompositions, and whichever
-- is smaller wins: vertical runs per column with neighbouring columns of the
-- same run merged side by side, and horizontal runs per row with rows of the
-- same span merged top to bottom. A flat stack is a handful of boxes the
-- second way and a staircase is a handful the first; neither alone stays
-- under the cap on a real board. Each box is { col0, col1, row0, row1 }.
local function columnBoxes(f: Frame): { { number } }
    local boxes: { { number } } = {}
    local open: { [string]: { number } } = {}
    for col = 1, f.cols do
        local seen: { [string]: { number } } = {}
        local top = 0
        for row = 1, f.rows + 1 do
            local filled = row <= f.rows and f.cells[row][col] ~= 0
            if filled and top == 0 then
                top = row
            elseif not filled and top ~= 0 then
                local key = `{top}:{row - 1}`
                local prev = open[key]
                if prev ~= nil and prev[2] == col - 1 then
                    prev[2] = col
                    seen[key] = prev
                else
                    local b = { col, col, top, row - 1 }
                    table.insert(boxes, b)
                    seen[key] = b
                end
                top = 0
            end
        end
        open = seen
    end
    return boxes
end

local function rowBoxes(f: Frame): { { number } }
    local boxes: { { number } } = {}
    local open: { [string]: { number } } = {}
    for row = 1, f.rows do
        local seen: { [string]: { number } } = {}
        local left = 0
        for col = 1, f.cols + 1 do
            local filled = col <= f.cols and f.cells[row][col] ~= 0
            if filled and left == 0 then
                left = col
            elseif not filled and left ~= 0 then
                local key = `{left}:{col - 1}`
                local prev = open[key]
                if prev ~= nil and prev[4] == row - 1 then
                    prev[4] = row
                    seen[key] = prev
                else
                    local b = { left, col - 1, row, row }
                    table.insert(boxes, b)
                    seen[key] = b
                end
                left = 0
            end
        end
        open = seen
    end
    return boxes
end

local function stackBoxes(f: Frame): { { number } }
    local a, b = columnBoxes(f), rowBoxes(f)
    return if #b < #a then b else a
end

local function advance(g: Goo, f: Frame)
    local dt = f.dt
    local px = if f.px > 0 then f.px else 1
    local c = f.cell
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

    local radius = c * 0.22
    -- The piece first: it is the one thing that must never lose its goo to
    -- the cap. A box per row of it, so an L is two boxes and an I is one.
    local byRow: { [number]: { number } } = {}
    for _, p in f.piece do
        local key = math.floor(p[2] * 8 + 0.5)
        local span = byRow[key]
        if span == nil then
            byRow[key] = { p[1], p[1], p[2] }
        else
            span[1] = math.min(span[1], p[1])
            span[2] = math.max(span[2], p[1])
        end
    end
    for _, span in byRow do
        local x0, x1, y = span[1], span[2] + c, span[3]
        pushBody(g, (x0 + x1) / 2, y + c / 2, (x1 - x0) / 2, c / 2, radius, 0.5, 1)
    end
    if #f.piece > 0 then
        local minX: number, minY: number, maxX: number, maxY: number = 1e9, 1e9, -1e9, -1e9
        for _, p in f.piece do
            local x: number, y: number = p[1], p[2]
            if x < minX then minX = x end
            if y < minY then minY = y end
            if x + c > maxX then maxX = x + c end
            if y + c > maxY then maxY = y + c end
        end
        pushMover(g, (minX + maxX) / 2, (minY + maxY) / 2, (maxX - minX) / 2, (maxY - minY) / 2, f.pieceVx, f.pieceVy)
    end

    -- THE FLOOR: a thin lining of goo along the bottom of the well, always
    -- there. The stack sits in it, and it is where a drop goes home when the
    -- well is empty — without it a clear's water has nothing to return to
    -- but the next piece at the lid, and streams up the screen to it.
    local w = f.cols * c
    pushBody(g, f.ox + w / 2, f.oy + f.rows * c + c * 0.05, w / 2, c * 0.12, c * 0.1, 2.4, 0)

    -- The stack. Past the cap, the boxes nearest the top win: the goo only
    -- shows where a block meets open water, and the deepest boxes are the
    -- ones most likely to be buried on every side.
    local boxes = stackBoxes(f)
    if #boxes > MAX_BODIES - g.nBodies then
        table.sort(boxes, function(p: { number }, q: { number }): boolean
            return p[3] < q[3]
        end)
    end
    for _, bx in boxes do
        local x0 = f.ox + (bx[1] - 1) * c
        local x1 = f.ox + bx[2] * c
        local y0 = f.oy + (bx[3] - 1) * c
        local y1 = f.oy + bx[4] * c
        if not pushBody(g, (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, radius, bx[1] * 1.71 + bx[3] * 0.63, 0) then
            break
        end
    end

    i = 1
    while i <= #g.streaks do
        local s = g.streaks[i]
        s.life -= dt
        if s.life <= 0 then
            table.remove(g.streaks, i)
        else
            pushMover(g, s.cx, s.cy, s.hw, s.hh, s.vx, s.vy)
            i += 1
        end
    end

    updateDrops(g, dt)
end

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
        buffer.writef32(b, at, m[1])
        buffer.writef32(b, at + 4, m[2])
        buffer.writef32(b, at + 8, m[3])
        buffer.writef32(b, at + 12, m[4])
        buffer.writef32(b, at + 16, 0)
        buffer.writef32(b, at + 20, m[5])
        buffer.writef32(b, at + 24, m[6])
        buffer.writef32(b, at + 28, m[7])
    end
end

return {
    UBO_SIZE = UBO_SIZE,
    FOAM_UBO_SIZE = FOAM_UBO_SIZE,
    MAX_BODIES = MAX_BODIES,
    new = new,
    advance = advance,
    splash = splash,
    impact = impact,
    streak = streak,
    write = write,
    writeFoam = writeFoam,
    stackBoxes = stackBoxes,
}
