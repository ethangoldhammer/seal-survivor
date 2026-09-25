-- ============================================================================
-- THE TUNER — sealitaire's panel, for wetris.
--
-- Same parts (tuner.rml's TunerRow and TunerHead, copied byte for byte), same
-- layout (columns right-anchored, one where two will not fit, scaled on a
-- small screen, a category folding on its header, the background a scroll
-- when the rows outrun the panel), same save: SAVE prints one line —
--
--   TUNING-SAVE key=value key=value ...
--
-- — which tools/wetris-tune.mjs reads off the viewer's output and writes back
-- into tuning.luau. A Rive script cannot write a file; the console is the one
-- channel out.
--
-- `T` is the live table everything reads: board.luau and swimmer.luau hold a
-- reference to it, so a knob moves the thing it tunes on the next frame.
--
-- The panel is drawn FLAT over the finished screen, not through the CRT: a
-- knob seen through the barrel curve is not where the pointer is.
-- ============================================================================

local TUNING = require('tuning')

local M = {}

-- THE LIVE VALUES, by key.
local T: { [string]: number } = {}
for _, row in TUNING do
    T[row.key] = row.value
end
M.T = T

export type Item = { kind: string, i: number, x: number, y: number, h: number }

-- sealitaire's layout.luau tuner rect, and the row artboard's own track
-- (x0..x1, in ROW units: the artboard is drawn scaled, the knob's x in it is
-- fixed).
export type Geom = {
    x: number, y: number,
    colW: number, cols: number, gutter: number, maxH: number,
    top: number, foot: number, rowH: number, headH: number,
    x0: number, x1: number, scale: number,
}

export type Panel = {
    open: boolean,
    ready: boolean,
    rows: { Artboard<Data.TunerRow> },
    rowVm: { ViewModel },
    heads: { Artboard<Data.TunerHead> },   -- one per category, then SAVE, RESET
    headVm: { ViewModel },
    cats: { string },
    catRows: { { number } },
    catOpen: { boolean },
    items: { Item },
    g: Geom,
    scroll: number,
    reach: number,
    pan: number,        -- the y a background drag began at, or -1
    panFrom: number,
    drag: number,       -- the row being dragged, or 0
    platePath: Path,
    platePaint: Paint,
    thumbPath: Path,
    thumbPaint: Paint,
}

local function clamp(v: number, lo: number, hi: number): number
    return math.max(lo, math.min(hi, v))
end

local function inRect(px: number, py: number, x: number, y: number, w: number, h: number): boolean
    return px >= x and px <= x + w and py >= y and py <= y + h
end

local function fmtValue(v: number): string
    local a = math.abs(v)
    if a >= 100 then
        return string.format('%.0f', v)
    elseif a >= 10 then
        return string.format('%.1f', v)
    elseif a >= 1 then
        return string.format('%.2f', v)
    end
    return string.format('%.3f', v)
end

local function geom(w: number, h: number): Geom
    local ts = clamp(math.min(w / 1600, h / 1000), 0.7, 1)
    local colW = 380 * ts
    local gutter = math.max(16, 22 * ts)
    local cols = math.floor(clamp(math.floor((w - 40 - gutter) / colW), 1, 2))
    return {
        x = w - 20 - colW * cols - gutter, y = 10,
        colW = colW, cols = cols, gutter = gutter,
        maxH = math.min(960 * ts, h - 20),
        top = 10 * ts, foot = 30 * ts, rowH = 16 * ts, headH = 20 * ts,
        x0 = 172, x1 = 360,
        scale = ts,
    }
end

local function roundedRect(path: Path, w: number, h: number, r: number)
    path:reset()
    local x0, y0, x1, y1 = -w / 2, -h / 2, w / 2, h / 2
    local k = r * 0.4477
    path:moveTo(Vector.xy(x0 + r, y0))
    path:lineTo(Vector.xy(x1 - r, y0))
    path:cubicTo(Vector.xy(x1 - k, y0), Vector.xy(x1, y0 + k), Vector.xy(x1, y0 + r))
    path:lineTo(Vector.xy(x1, y1 - r))
    path:cubicTo(Vector.xy(x1, y1 - k), Vector.xy(x1 - k, y1), Vector.xy(x1 - r, y1))
    path:lineTo(Vector.xy(x0 + r, y1))
    path:cubicTo(Vector.xy(x0 + k, y1), Vector.xy(x0, y1 - k), Vector.xy(x0, y1 - r))
    path:lineTo(Vector.xy(x0, y0 + r))
    path:cubicTo(Vector.xy(x0, y0 + k), Vector.xy(x0 + k, y0), Vector.xy(x0 + r, y0))
    path:close()
end

function M.new(): Panel
    local cats: { string } = {}
    local catRows: { { number } } = {}
    local catOpen: { boolean } = {}
    local index: { [string]: number } = {}
    for i, row in TUNING do
        local c = index[row.cat]
        if c == nil then
            table.insert(cats, row.cat)
            c = #cats
            index[row.cat] = c
            catRows[c] = {}
            -- Closed on arrival, as sealitaire's: the panel opens on the map
            -- of what is tunable rather than one category's rows.
            catOpen[c] = false
        end
        table.insert(catRows[c], i)
    end
    local circle = Path.new()
    -- The unit circle, for the scroll thumb.
    circle:moveTo(Vector.xy(1, 0))
    circle:cubicTo(Vector.xy(1, 0.5523), Vector.xy(0.5523, 1), Vector.xy(0, 1))
    circle:cubicTo(Vector.xy(-0.5523, 1), Vector.xy(-1, 0.5523), Vector.xy(-1, 0))
    circle:cubicTo(Vector.xy(-1, -0.5523), Vector.xy(-0.5523, -1), Vector.xy(0, -1))
    circle:cubicTo(Vector.xy(0.5523, -1), Vector.xy(1, -0.5523), Vector.xy(1, 0))
    circle:close()
    return {
        open = false, ready = false,
        rows = {}, rowVm = {}, heads = {}, headVm = {},
        cats = cats, catRows = catRows, catOpen = catOpen,
        items = {},
        g = geom(1600, 1000),
        scroll = 0, reach = 0, pan = -1, panFrom = 0, drag = 0,
        platePath = Path.new(),
        platePaint = Paint.with({ color = Color.rgba(6, 22, 40, 240), style = 'fill' }),
        thumbPath = circle,
        thumbPaint = Paint.with({ color = Color.rgba(185, 212, 238, 150), style = 'fill' }),
    }
end

local function writeRow(p: Panel, i: number)
    local vm = p.rowVm[i]
    if vm == nil then
        return
    end
    local row = TUNING[i]
    local t = (T[row.key] - row.min) / (row.max - row.min)
    local knob = vm:getNumber('k')
    if knob ~= nil then
        knob.value = p.g.x0 + clamp(t, 0, 1) * (p.g.x1 - p.g.x0)
    end
    local val = vm:getString('v')
    if val ~= nil then
        val.value = fmtValue(T[row.key])
    end
    local label = vm:getString('l')
    if label ~= nil then
        label.value = row.key
    end
end

local function writeHead(p: Panel, c: number)
    local vm = p.headVm[c]
    if vm == nil then
        return
    end
    local name = vm:getString('title')
    local mark = vm:getString('mark')
    local n = #p.cats
    -- Tooling words, not a player's: the panel is the tuner's.
    if name ~= nil then
        name.value = if c <= n then p.cats[c] elseif c == n + 1 then 'SAVE' else 'RESET'
    end
    if mark ~= nil then
        mark.value = if c <= n then (if p.catOpen[c] then '-' else '+') else ''
    end
end

local function writeAll(p: Panel)
    for i = 1, #TUNING do
        writeRow(p, i)
    end
    for c = 1, #p.cats + 2 do
        writeHead(p, c)
    end
end

-- The instances, one per row and one per header, each with its own view
-- model. Once the inputs are there (init runs twice, and they are late).
function M.build(p: Panel, rowIn: Input<Artboard<Data.TunerRow>>, headIn: Input<Artboard<Data.TunerHead>>)
    if p.ready then
        return
    end
    local ok, err = pcall(function()
        for i = 1, #TUNING do
            local vm = Data.TunerRow.new()
            p.rowVm[i] = vm
            p.rows[i] = rowIn:instance(vm)
        end
        for c = 1, #p.cats + 2 do
            local vm = Data.TunerHead.new()
            p.headVm[c] = vm
            p.heads[c] = headIn:instance(vm)
        end
    end)
    if ok then
        p.ready = true
        writeAll(p)
    else
        print(`wetris: no tuner instances: {err}`)
    end
end

function M.resize(p: Panel, w: number, h: number)
    p.g = geom(w, h)
    roundedRect(p.platePath, p.g.colW * p.g.cols + p.g.gutter, p.g.maxH, 12)
    writeAll(p)
end

function M.toggle(p: Panel)
    p.open = not p.open
    writeAll(p)
end

-- Headers and open rows, top to bottom, spilling into the next column; SAVE
-- and RESET at the foot.
local function layout(p: Panel)
    local g = p.g
    local items = p.items
    table.clear(items)
    local col = 0
    local y = g.top
    local limit = g.maxH - g.foot
    local deepest = 0
    local lift = p.scroll
    local function place(kind: string, i: number, h: number)
        if y + h > limit + lift and col < g.cols - 1 then
            col += 1
            y = g.top
        end
        deepest = math.max(deepest, y + h)
        table.insert(items, { kind = kind, i = i, x = g.x + g.gutter + col * g.colW, y = g.y + y - lift, h = h })
        y += h
    end
    for c, _ in p.cats do
        place('head', c, g.headH)
        if p.catOpen[c] then
            for _, i in p.catRows[c] do
                place('row', i, g.rowH)
            end
        end
    end
    p.reach = math.max(0, deepest - limit)
    local n = #p.cats
    local footY = g.y + g.maxH - g.foot + 6 * g.scale
    local footX = g.x + g.gutter
    table.insert(items, { kind = 'save', i = n + 1, x = footX, y = footY, h = g.headH })
    table.insert(items, { kind = 'reset', i = n + 2, x = footX + 110 * g.scale, y = footY, h = g.headH })
end

local function band(p: Panel): (number, number)
    return p.g.y + p.g.top, p.g.y + p.g.maxH - p.g.foot
end

local function shows(p: Panel, it: Item): boolean
    if it.kind == 'save' or it.kind == 'reset' then
        return true
    end
    local top, bottom = band(p)
    return it.y >= top - 0.5 and it.y + it.h <= bottom + 0.5
end

local function itemAt(p: Panel, px: number, py: number): Item?
    for _, it in p.items do
        local w = if it.kind == 'save' or it.kind == 'reset' then 100 * p.g.scale else p.g.colW
        if shows(p, it) and inRect(px, py, it.x, it.y, w, it.h) then
            return it
        end
    end
    return nil
end

local function rowX(p: Panel, i: number): number
    for _, it in p.items do
        if it.kind == 'row' and it.i == i then
            return it.x
        end
    end
    return p.g.x
end

local function set(p: Panel, i: number, px: number, itemX: number)
    local row = TUNING[i]
    local t = clamp(((px - itemX) / p.g.scale - p.g.x0) / (p.g.x1 - p.g.x0), 0, 1)
    T[row.key] = row.min + t * (row.max - row.min)
    writeRow(p, i)
end

local function save()
    local parts: { string } = {}
    for _, row in TUNING do
        table.insert(parts, `{row.key}={string.format('%.5g', T[row.key])}`)
    end
    print('TUNING-SAVE ' .. table.concat(parts, ' '))
end

local function reset(p: Panel)
    for _, row in TUNING do
        T[row.key] = row.value
    end
    writeAll(p)
end

function M.advance(p: Panel, dt: number)
    if not p.open then
        return
    end
    layout(p)
    for _, inst in p.rows do
        inst:advance(dt)
    end
    for _, inst in p.heads do
        inst:advance(dt)
    end
end

function M.covers(p: Panel, px: number, py: number): boolean
    local g = p.g
    return p.open and inRect(px, py, g.x, g.y, g.colW * g.cols + g.gutter, g.maxH)
end

-- True when the panel took the press.
function M.press(p: Panel, px: number, py: number): boolean
    if not M.covers(p, px, py) then
        return false
    end
    local it = itemAt(p, px, py)
    if it == nil then
        p.pan = py
        p.panFrom = p.scroll
    elseif it.kind == 'head' then
        p.catOpen[it.i] = not p.catOpen[it.i]
        writeHead(p, it.i)
    elseif it.kind == 'row' then
        p.drag = it.i
        set(p, it.i, px, it.x)
    elseif it.kind == 'save' then
        save()
    elseif it.kind == 'reset' then
        reset(p)
    end
    return true
end

-- True while the panel owns the gesture.
function M.move(p: Panel, px: number, py: number): boolean
    if p.pan >= 0 then
        p.scroll = clamp(p.panFrom - (py - p.pan), 0, p.reach)
        return true
    end
    if p.drag > 0 then
        set(p, p.drag, px, rowX(p, p.drag))
        return true
    end
    return M.covers(p, px, py)
end

function M.up(p: Panel): boolean
    if p.pan >= 0 or p.drag > 0 then
        p.pan = -1
        p.drag = 0
        return true
    end
    return false
end

function M.draw(p: Panel, r: Renderer)
    if not p.open then
        return
    end
    local g = p.g
    r:save()
    r:transform(Mat2D.withTranslation(g.x + (g.colW * g.cols + g.gutter) / 2, g.y + g.maxH / 2))
    r:drawPath(p.platePath, p.platePaint)
    r:restore()
    if p.reach > 0 then
        local top, bottom = band(p)
        local b = math.max(1, bottom - top)
        local frac = b / (b + p.reach)
        local at = p.scroll / p.reach
        r:save()
        r:transform(Mat2D.withTranslation(g.x + g.gutter / 2, top + (b - b * frac) * at + b * frac / 2))
        r:transform(Mat2D.withScale(g.gutter * 0.3, b * frac / 2))
        r:drawPath(p.thumbPath, p.thumbPaint)
        r:restore()
    end
    for _, it in p.items do
        if not shows(p, it) then
            continue
        end
        r:save()
        r:transform(Mat2D.withTranslation(it.x, it.y))
        r:transform(Mat2D.withScale(g.scale, g.scale))
        if it.kind == 'row' then
            local inst = p.rows[it.i]
            if inst ~= nil then
                inst:draw(r)
            end
        else
            local head = p.heads[it.i]
            if head ~= nil then
                head:draw(r)
            end
        end
        r:restore()
    end
end

return M
