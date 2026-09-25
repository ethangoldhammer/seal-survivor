-- ============================================================================
-- THE INK — the stack's colours, slowly running into each other, and the
-- uniform block crt.wgsl draws every tile and drip from.
--
-- Blubberball's ball (path/src/systems/post.js, the goo pass) is a metaball
-- field whose splats each carry a tint: the pass accumulates colour weighted
-- by density and divides it back out, so where two blobs overlap the weld is
-- a BLEND rather than whichever drew last. This is that idea on the well. Every
-- locked cell is a splat of its OWN colour, crt.wgsl sums them with a smooth
-- kernel and divides by the weight, and the kernel's reach grows with how long
-- the cell has sat in the stack: a piece lands crisp and over `mixTime`
-- seconds runs into its neighbours until a settled stack is one marbled body.
--
-- A cell's colour is its own, not its kind's: it starts as its piece's colour
-- and the goo that drips off falling pieces STAINS it where it lands
-- (drips.luau), so the pile is a paint surface the play keeps working.
--
-- Both sides have to be ripe for colour to pass between two cells, so the
-- blend always CREEPS outward from a lock rather than arriving with it.
--
-- This module keeps the per-cell colour and clock — following the rows down
-- through every clear — and owns the uniform layout. Pure.
-- ============================================================================

local WET = require('wetris')

local M = {}

-- One per kind, I O T S Z J L: sea colours, sealitaire's warm gold among them.
M.RGB = {
    { 96, 214, 232 },   -- I  shallows
    { 255, 214, 120 },  -- O  sand gold
    { 186, 132, 232 },  -- T  anemone
    { 110, 222, 160 },  -- S  kelp
    { 240, 96, 88 },    -- Z  coral
    { 72, 136, 232 },   -- J  deep
    { 255, 158, 92 },   -- L  clownfish
} :: { { number } }

-- crt.wgsl's uniform block, byte offsets. Rows 0 and 1 are board.luau's
-- (screen, time, the CRT knobs); everything after is written here.
M.ROWS_AT = 32      -- the well (uv) and the grid
M.ART_AT = 64       -- artboard w, h, free-tile count, drip count
M.LOOK_AT = 80      -- bevel, extrude, gloss, film
M.LOOK2_AT = 96     -- shadow, reflect, drip iso, drip height
M.LOOK3_AT = 112    -- gel strength (of the iso), gel reach (of a cell), fuse reach (of a cell), fuse amount
M.POST_AT = 128     -- grain, grain size, shadow mask, bright lift
M.POST2_AT = 144    -- flicker, flicker rate, edge glow, scanline drift
M.LOOK4_AT = 160    -- skirt tint, skirt reach (of a cell), -, -
M.CELLS_AT = 176    -- 200 cells: rgb, ripeness (-1 empty)
M.MAX_FREE = 24
M.FREE_AT = M.CELLS_AT + WET.W * WET.H * 16
-- Metaball SLOTS, not drips: a falling drip takes two (a head and a tail).
M.MAX_DRIPS = 64
M.DRIPS_AT = M.FREE_AT + M.MAX_FREE * 32
M.UBO_SIZE = M.DRIPS_AT + M.MAX_DRIPS * 32

export type Ink = {
    locked: { { number } },     -- when each cell locked
    rgb: { { { number } } },    -- each cell's own colour, 0..1
}

-- A cell that is already in the well when nothing has locked it — a staged
-- board — counts as long settled.
local OLD = -1e6

local function blankRow(): ({ number }, { { number } })
    local t: { number } = {}
    local c: { { number } } = {}
    for col = 1, WET.W do
        t[col] = OLD
        c[col] = { 0.5, 0.5, 0.5 }
    end
    return t, c
end

function M.new(): Ink
    local locked: { { number } } = {}
    local rgb: { { { number } } } = {}
    for r = 1, WET.H do
        locked[r], rgb[r] = blankRow()
    end
    return { locked = locked, rgb = rgb }
end

function M.reset(ink: Ink)
    for r = 1, WET.H do
        ink.locked[r], ink.rgb[r] = blankRow()
    end
end

local function kindRgb(kind: number): { number }
    local k = M.RGB[kind] or M.RGB[1]
    return { k[1] / 255, k[2] / 255, k[3] / 255 }
end

-- A staged board's cells take their kind's colour, so a lab stack is painted.
function M.paint(ink: Ink, cells: { { number } })
    for r = 1, WET.H do
        for c = 1, WET.W do
            if cells[r][c] > 0 then
                ink.rgb[r][c] = kindRgb(cells[r][c])
            end
        end
    end
end

-- The cells a lock is about to write, then the rows it cleared: stamped
-- first, in the rows they landed in, THEN shifted exactly as wetris.luau's
-- clearLines shifts the board, so a cell's colour and clock stay with it.
function M.lock(ink: Ink, cells: { { number } }, kind: number, cleared: { number }, now: number)
    for _, cc in cells do
        local col: number, row: number = cc[1], cc[2]
        if row >= 1 and row <= WET.H and col >= 1 and col <= WET.W then
            ink.locked[row][col] = now
            ink.rgb[row][col] = kindRgb(kind)
        end
    end
    for _, r in cleared do
        table.remove(ink.locked, r)
        table.remove(ink.rgb, r)
        local t, c = blankRow()
        table.insert(ink.locked, 1, t)
        table.insert(ink.rgb, 1, c)
    end
end

-- A drip landing on a cell: its colour moves `amount` of the way to the drip's.
function M.stain(ink: Ink, row: number, col: number, rgb: { number }, amount: number)
    if row < 1 or row > WET.H or col < 1 or col > WET.W then
        return
    end
    local c = ink.rgb[row][col]
    local k = math.clamp(amount, 0, 1)
    c[1] += (rgb[1] - c[1]) * k
    c[2] += (rgb[2] - c[2]) * k
    c[3] += (rgb[3] - c[3]) * k
end

-- The well's frame, the knobs, and every cell's colour and ripeness.
function M.write(ink: Ink, cells: { { number } }, b: buffer, now: number,
                 ox: number, oy: number, cell: number, w: number, h: number,
                 mixTime: number, reach: number, swirl: number)
    buffer.writef32(b, M.ROWS_AT, ox / w)
    buffer.writef32(b, M.ROWS_AT + 4, oy / h)
    buffer.writef32(b, M.ROWS_AT + 8, cell / w)
    buffer.writef32(b, M.ROWS_AT + 12, cell / h)
    buffer.writef32(b, M.ROWS_AT + 16, WET.W)
    buffer.writef32(b, M.ROWS_AT + 20, WET.H)
    buffer.writef32(b, M.ROWS_AT + 24, reach)
    buffer.writef32(b, M.ROWS_AT + 28, swirl)
    local tau = math.max(0.05, mixTime)
    for r = 1, WET.H do
        for c = 1, WET.W do
            local at = M.CELLS_AT + ((r - 1) * WET.W + (c - 1)) * 16
            if cells[r][c] > 0 then
                local rgb = ink.rgb[r][c]
                local age = math.max(0, now - ink.locked[r][c])
                buffer.writef32(b, at, rgb[1])
                buffer.writef32(b, at + 4, rgb[2])
                buffer.writef32(b, at + 8, rgb[3])
                buffer.writef32(b, at + 12, 1 - math.exp(-age / tau))
            else
                buffer.writef32(b, at, 0)
                buffer.writef32(b, at + 4, 0)
                buffer.writef32(b, at + 8, 0)
                buffer.writef32(b, at + 12, -1)
            end
        end
    end
end

M.kindRgb = kindRgb

return M
