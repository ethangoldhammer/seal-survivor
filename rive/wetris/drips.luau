-- ============================================================================
-- THE DRIPS — coloured goo shed by the falling piece.
--
-- A piece is wet with its own colour, and it sheds it in three stages:
--
--   FORMING   a drop gathers BEHIND the piece at a point on its contour — an
--             edge of a cell with no piece cell beyond it, the undersides far
--             more often than the tops — and rides with the piece, glide and
--             turn, while it swells and bulges out past the edge. crt.wgsl
--             draws it under the tiles and welds it to them (the gel term), so
--             what shows is goo oozing out of the shape's outline.
--   FLYING    when it is heavy enough it lets go, with the velocity the point
--             of the piece it hung from had — the glide AND the turn, so a spin
--             flings its drops off tangentially — capped so a fling reads
--             rather than leaves. Then gravity has it. A falling drop is drawn
--             as a head and a tail, welded into a teardrop.
--   LANDED    on the pile it sits on the cell under it, gels to it, sinks in,
--             and STAINS it while it does (ink.luau): the cell's colour moves
--             toward the drop's, and the ink's slow mix carries it on. On the
--             floor it pools into the goo lining.
--
-- A piece that locks lets go of every drop still forming on it: they drop
-- onto what is now the stack, which is the piece they came from.
--
-- BURSTS are the other kind: a cleared line blows apart into goo that flies
-- out fast and dies fast — each drop the colour its cell had evolved to
-- (ink.luau's evolved), shrinking to nothing over a short life. They never
-- land or stain; they are one metaball each in the same field, so they weld
-- to each other as they leave and neck apart as they spread.
--
-- Pure: no renderer. board.luau forms, steps and writes.
-- ============================================================================

local WET = require('wetris')
local INK = require('ink')

local M = {}

export type Drip = {
    x: number, y: number, vx: number, vy: number,
    r: number,
    rgb: { number },
    age: number,
    -- FORMING: which of the piece's cells it hangs from (0 once it has let
    -- go), where on that cell (cell-local px, before the turn), the edge's
    -- outward normal, and how far through its forming it is.
    cell: number,
    lx: number, ly: number, nx: number, ny: number,
    formT: number, formDur: number,
    landed: number,     -- seconds since it landed, or -1
    row: number, col: number,   -- the cell it landed on (0 = the floor)
}

export type Burst = {
    x: number, y: number, vx: number, vy: number,
    r: number, rgb: { number }, age: number, life: number,
}

export type Drips = { list: { Drip }, carry: number, bursts: { Burst } }

-- The well as the drips need it, artboard px.
export type Well = {
    cells: { { number } },
    ox: number, oy: number, cell: number,
}

-- The piece as the forming drops need it: every cell where it is drawn, how
-- fast each is moving, and the turn still springing in.
export type Hold = {
    at: { { number } },
    vel: { { number } },
    turn: number,
}

local SETTLE = 0.45     -- s a landed drop takes to sink into the cell
local MAX_LIST = 40     -- drops alive at once; a flier is two metaball slots
local MAX_BURST = 48    -- burst drops alive at once, one slot each

function M.new(): Drips
    return { list = {}, carry = 0, bursts = {} }
end

function M.clear(d: Drips)
    table.clear(d.list)
    table.clear(d.bursts)
    d.carry = 0
end

local function make(d: Drips): Drip
    if #d.list >= MAX_LIST then
        -- A landed drop gives way first, then the oldest flier; a forming one
        -- last, because it is on the piece everyone is watching.
        local worst, worstScore = 1, -1
        for i, o in d.list do
            local score = o.age + (if o.landed >= 0 then 100 elseif o.cell == 0 then 50 else 0)
            if score > worstScore then
                worst, worstScore = i, score
            end
        end
        table.remove(d.list, worst)
    end
    local p: Drip = {
        x = 0, y = 0, vx = 0, vy = 0, r = 1, rgb = { 1, 1, 1 }, age = 0,
        cell = 0, lx = 0, ly = 0, nx = 0, ny = 1, formT = 0, formDur = 1,
        landed = -1, row = 0, col = 0,
    }
    table.insert(d.list, p)
    return p
end

-- A drop starts gathering on the piece: on cell `cell`, at cell-local (lx,
-- ly) on an edge whose outward normal is (nx, ny).
function M.form(d: Drips, cell: number, lx: number, ly: number, nx: number, ny: number,
                r: number, rgb: { number }, dur: number)
    local p = make(d)
    p.cell, p.lx, p.ly, p.nx, p.ny = cell, lx, ly, nx, ny
    p.r, p.rgb, p.formDur = r, rgb, math.max(0.05, dur)
end

-- How many to start this frame at `rate` per second, carrying the fraction.
function M.due(d: Drips, rate: number, dt: number): number
    d.carry += math.max(0, rate) * dt
    local n = math.floor(d.carry)
    d.carry -= n
    return n
end

-- How many are forming right now (the board keeps a piece from carrying more
-- than it can show).
function M.forming(d: Drips): number
    local n = 0
    for _, p in d.list do
        if p.cell > 0 then
            n += 1
        end
    end
    return n
end

local function letGo(p: Drip, vx: number, vy: number)
    p.cell = 0
    p.vx, p.vy = vx, vy
    p.age = 0.1
end

-- Every forming drop, carried by the piece: its centre slides from just
-- inside the edge to a little past it as it swells, turned with the piece.
-- A drop that has formed lets go with its point's velocity, capped at `cap`
-- px/s and scaled by `inherit`. `speedUp` shortens forming while the piece is
-- moving fast (a shaken thing drips sooner).
function M.follow(d: Drips, dt: number, h: Hold, inherit: number, cap: number, speedUp: number)
    local cs, sn = math.cos(h.turn), math.sin(h.turn)
    for _, p in d.list do
        if p.cell == 0 then
            continue
        end
        local at = h.at[p.cell]
        local vel = h.vel[p.cell]
        if at == nil or vel == nil then
            letGo(p, p.vx, p.vy)
            continue
        end
        local sp = math.sqrt(vel[1] * vel[1] + vel[2] * vel[2])
        p.formT += dt * (1 + speedUp * sp)
        p.age += dt
        local u = math.min(1, p.formT / p.formDur)
        -- From r inside the edge to 0.55 r beyond it.
        local out = -p.r + u * 1.55 * p.r
        local lx = p.lx + p.nx * out
        local ly = p.ly + p.ny * out
        local x = at[1] + cs * lx - sn * ly
        local y = at[2] + sn * lx + cs * ly
        if dt > 0 then
            p.vx, p.vy = (x - p.x) / dt, (y - p.y) / dt
        end
        p.x, p.y = x, y
        if u >= 1 then
            local vx, vy = vel[1] * inherit, vel[2] * inherit
            local v = math.sqrt(vx * vx + vy * vy)
            if v > cap then
                vx, vy = vx * cap / v, vy * cap / v
            end
            letGo(p, vx, vy)
        end
    end
end

-- The piece is gone (locked, or swapped into the hold): everything still
-- forming on it drops from where it is.
function M.release(d: Drips)
    for _, p in d.list do
        if p.cell > 0 then
            letGo(p, 0, 0)
        end
    end
end

local function filled(w: Well, col: number, row: number): boolean
    return row >= 1 and row <= WET.H and col >= 1 and col <= WET.W and w.cells[row][col] ~= 0
end

-- The fliers and the landed: gravity, drag, landing, staining. `g` is px/s²,
-- `stain` the colour a drop gives its cell over the whole of its settle.
-- Returns how many landed this frame, for the sound.
function M.step(d: Drips, dt: number, w: Well, ink: INK.Ink, g: number, drag: number, stain: number): number
    local landings = 0
    local keep = math.exp(-drag * dt)
    local floorY = w.oy + WET.H * w.cell
    local i = 1
    while i <= #d.list do
        local p = d.list[i]
        local gone = false
        if p.cell > 0 then
            -- Still on the piece: follow() has it.
        elseif p.landed >= 0 then
            p.age += dt
            p.landed += dt
            if p.row > 0 then
                INK.stain(ink, p.row, p.col, p.rgb, stain * dt / SETTLE)
                -- The cell under it was cleared out from under it: fall again.
                if not filled(w, p.col, p.row) then
                    p.landed = -1
                end
            end
            gone = p.landed >= SETTLE
        else
            p.age += dt
            p.vy += g * dt
            p.vx *= keep
            p.vy *= keep
            p.x += p.vx * dt
            p.y += p.vy * dt
            local col = math.floor((p.x - w.ox) / w.cell) + 1
            local row = math.floor((p.y + p.r * 0.6 - w.oy) / w.cell) + 1
            if p.vy > 0 and filled(w, col, row) then
                -- On the pile: sit on the top of that cell, gel to it, sink.
                p.landed = 0
                p.row, p.col = row, col
                p.y = w.oy + (row - 1) * w.cell - p.r * 0.1
                p.vx, p.vy = 0, 0
                landings += 1
            elseif p.y - p.r > floorY then
                landings += 1
                p.landed = 0
                p.row, p.col = 0, 0
                p.y = floorY
                p.vx, p.vy = 0, 0
            elseif p.age > 8 or p.x < -200 or p.x > 1e5 then
                gone = true
            end
        end
        if gone then
            table.remove(d.list, i)
        else
            i += 1
        end
    end
    return landings
end

-- A cleared line blows apart. `cells` is every cleared cell: its centre (px)
-- and its evolved colour. `count` drops per cell (a fraction rounds by
-- chance), capped at MAX_BURST across the whole clear and shared out so a
-- tetris is as even as a single; each leaves its cell in any direction at up
-- to `speed` px/s, radius `r` px, living `life` s (each a little different).
export type BurstCell = { x: number, y: number, rgb: { number } }

function M.burst(d: Drips, cells: { BurstCell }, count: number, speed: number, r: number, life: number, cellPx: number)
    local n = #cells
    if n == 0 or count <= 0 then
        return
    end
    local total = math.min(MAX_BURST, math.floor(n * count + math.random()))
    -- Make room: the oldest bursts go first.
    while #d.bursts + total > MAX_BURST and #d.bursts > 0 do
        table.remove(d.bursts, 1)
    end
    for i = 1, total do
        local c = cells[((i - 1) % n) + 1]
        local a = math.random() * math.pi * 2
        local v = speed * (0.35 + 0.65 * math.random())
        -- A little upward, so the line throws itself up and out.
        local vx, vy = math.cos(a) * v, math.sin(a) * v - speed * 0.25
        local j = cellPx * 0.35
        table.insert(d.bursts, {
            x = c.x + (math.random() - 0.5) * j, y = c.y + (math.random() - 0.5) * j,
            vx = vx, vy = vy,
            r = r * (0.6 + 0.8 * math.random()),
            rgb = c.rgb, age = 0,
            life = math.max(0.03, life * (0.6 + 0.8 * math.random())),
        })
    end
end

-- Bursts fly, drag down hard, and die. `g` px/s².
function M.stepBursts(d: Drips, dt: number, g: number, drag: number)
    local keep = math.exp(-drag * dt)
    local i = 1
    while i <= #d.bursts do
        local p = d.bursts[i]
        p.age += dt
        if p.age >= p.life then
            table.remove(d.bursts, i)
        else
            p.vy += g * dt
            p.vx *= keep
            p.vy *= keep
            p.x += p.vx * dt
            p.y += p.vy * dt
            i += 1
        end
    end
end

-- Into crt.wgsl's rows: x, y, radius, alpha | rgb. A FORMING drop swells from
-- a bead to full size; a landed one shrinks and fades into its cell; a FALLING
-- one is a head and a smaller tail trailing back along its velocity, welded
-- into a teardrop that stretches the faster it goes.
local function put(b: buffer, slot: number, x: number, y: number, r: number, a: number, rgb: { number })
    local at = INK.DRIPS_AT + (slot - 1) * 32
    buffer.writef32(b, at, x)
    buffer.writef32(b, at + 4, y)
    buffer.writef32(b, at + 8, r)
    buffer.writef32(b, at + 12, a)
    buffer.writef32(b, at + 16, rgb[1])
    buffer.writef32(b, at + 20, rgb[2])
    buffer.writef32(b, at + 24, rgb[3])
    buffer.writef32(b, at + 28, 0)
end

function M.write(d: Drips, b: buffer, stretch: number): number
    local slot = 0
    -- Bursts first: they are the moment, and gone in half a second. Each
    -- shrinks from full size to nothing, quickest at the end.
    for _, p in d.bursts do
        if slot >= INK.MAX_DRIPS then
            break
        end
        local t = p.age / p.life
        slot += 1
        put(b, slot, p.x, p.y, p.r * math.sqrt(math.max(0, 1 - t)), 1, p.rgb)
    end
    for _, p in d.list do
        if slot >= INK.MAX_DRIPS then
            break
        end
        local r: number
        local a = 1
        if p.cell > 0 then
            r = p.r * (0.35 + 0.65 * math.min(1, p.formT / p.formDur))
        elseif p.landed >= 0 then
            a = math.max(0, 1 - p.landed / SETTLE)
            r = p.r * (0.35 + 0.65 * a)
        else
            r = p.r
        end
        slot += 1
        put(b, slot, p.x, p.y, r, a, p.rgb)
        local sp = math.sqrt(p.vx * p.vx + p.vy * p.vy)
        if p.cell == 0 and p.landed < 0 and sp > 1 and slot < INK.MAX_DRIPS then
            local len = math.min(r * 1.5, sp * stretch)
            slot += 1
            put(b, slot, p.x - p.vx / sp * len, p.y - p.vy / sp * len, r * 0.8, a, p.rgb)
        end
    end
    return slot
end

return M
