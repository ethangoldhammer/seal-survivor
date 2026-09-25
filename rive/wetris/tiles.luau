-- ============================================================================
-- THE FREE TILES — the live piece and the previews, as crt.wgsl draws them.
--
-- The stack's tiles are a grid the shader reads straight out of the cell
-- rows. These are the ones that are NOT on the grid: each has a centre, a
-- size and a turn of its own. The live piece is here because it glides — down
-- and sideways between cells, and now round through every turn, so a rotation
-- sweeps its four cells about the piece's own centre instead of snapping —
-- and because a piece that moves like that sheds goo from exactly where each
-- cell is going (drips.luau), which needs each cell's own velocity.
--
-- Pure: positions in, positions out.
-- ============================================================================

local WET = require('wetris')
local INK = require('ink')

local M = {}

export type Free = { x: number, y: number, size: number, turn: number, rgb: { number } }

-- The point an SRS turn is about, in cells from the piece's origin corner:
-- the middle of the 3x3 box for J L S T Z, of the 4x4 for I. O never turns.
local function pivot(kind: number): number
    return if kind == 1 then 2 else 1.5
end

-- The live piece's four cell centres where they are DRAWN: laid out as the
-- rules have it, turned by `turn` about the piece's pivot (the rotation still
-- springing in), then carried by the glide offset.
function M.pieceCells(p: WET.Piece, ox: number, oy: number, c: number,
                      offX: number, offY: number, turn: number): { { number } }
    local pv = pivot(p.kind)
    local px = ox + (p.col - 1 + pv) * c
    local py = oy + (p.row - 1 + pv) * c
    local cs, sn = math.cos(turn), math.sin(turn)
    local out: { { number } } = {}
    for _, cc in WET.SHAPES[p.kind][p.rot] do
        local x = ox + (p.col + cc[1] - 1 + 0.5) * c - px
        local y = oy + (p.row + cc[2] - 1 + 0.5) * c - py
        table.insert(out, { px + cs * x - sn * y + offX, py + sn * x + cs * y + offY })
    end
    return out
end

-- Which of the piece's cells have open water beneath them in its own shape:
-- the ones a drip can fall from without falling straight into the piece.
function M.bottomCells(p: WET.Piece): { boolean }
    local shape = WET.SHAPES[p.kind][p.rot]
    local out: { boolean } = {}
    for i, cc in shape do
        local covered = false
        for _, other in shape do
            if other[1] == cc[1] and other[2] == cc[2] + 1 then
                covered = true
            end
        end
        out[i] = not covered
    end
    return out
end

-- THE CONTOUR: every edge of every cell with no piece cell beyond it — the
-- shape's outline, where a drop can form. { cell index, normal x, normal y },
-- the normal in the piece's own frame (before the turn still springing in).
local EDGES: { { number } } = { { 0, 1 }, { 0, -1 }, { 1, 0 }, { -1, 0 } }

function M.contour(p: WET.Piece): { { number } }
    local shape = WET.SHAPES[p.kind][p.rot]
    local out: { { number } } = {}
    for i, cc in shape do
        for _, e in EDGES do
            local open = true
            for _, other in shape do
                if other[1] == cc[1] + e[1] and other[2] == cc[2] + e[2] then
                    open = false
                end
            end
            if open then
                table.insert(out, { i, e[1], e[2] })
            end
        end
    end
    return out
end

-- A preview's cell centres: the spawn shape, centred on (cx, cy), `s` a cell.
function M.previewCells(kind: number, cx: number, cy: number, s: number): { { number } }
    local shape = WET.SHAPES[kind][1]
    local minC, maxC, minR, maxR = 9, -9, 9, -9
    for _, cc in shape do
        minC = math.min(minC, cc[1]); maxC = math.max(maxC, cc[1])
        minR = math.min(minR, cc[2]); maxR = math.max(maxR, cc[2])
    end
    local w = (maxC - minC + 1) * s
    local h = (maxR - minR + 1) * s
    local out: { { number } } = {}
    for _, cc in shape do
        table.insert(out, { cx - w / 2 + (cc[1] - minC + 0.5) * s, cy - h / 2 + (cc[2] - minR + 0.5) * s })
    end
    return out
end

-- Into crt.wgsl's free rows; returns how many went in.
function M.write(list: { Free }, b: buffer): number
    local n = math.min(#list, INK.MAX_FREE)
    for i = 1, n do
        local f = list[i]
        local at = INK.FREE_AT + (i - 1) * 32
        buffer.writef32(b, at, f.x)
        buffer.writef32(b, at + 4, f.y)
        buffer.writef32(b, at + 8, f.size)
        buffer.writef32(b, at + 12, f.turn)
        buffer.writef32(b, at + 16, f.rgb[1])
        buffer.writef32(b, at + 20, f.rgb[2])
        buffer.writef32(b, at + 24, f.rgb[3])
        buffer.writef32(b, at + 28, 1)
    end
    return n
end

return M
