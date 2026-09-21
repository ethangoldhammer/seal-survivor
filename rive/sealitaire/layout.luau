-- ============================================================================
-- LAYOUT — where everything goes, at any viewport.
--
-- Pure, like klondike.luau: numbers in, numbers out, no drawing and no state,
-- so `rive . --test` can prove the geometry at a phone, a tablet and a
-- monitor without a frame ever rendering (tests.luau, group 'layout').
-- table.luau calls `compute` from `resize` and reads the result for every
-- position, every hit test and every uniform that is in artboard px.
--
-- THE VIEWPORT IS THE ARTBOARD. The Sealitaire artboard is fill-sized, so the
-- size `resize` hands the script is the window's own — 1600x1000 on the
-- desktop, 390x844 on a phone — and one artboard unit is one CSS px there.
-- That is what decides which numbers scale and which do not:
--
--   * The BOARD scales. Seven tableau columns have to fit across the width
--     whatever the width is, so the card is sized from the viewport and
--     everything card-shaped — the fan, the rim, the goo, a droplet — follows
--     it through `fit` (the card's width over the artboard's own 120).
--   * The CHROME barely does. A label is read at arm's length on both, so the
--     HUD holds near its design size (`ui`, clamped) and is ANCHORED to the
--     corners rather than scaled into them.
--
-- THE REFERENCE IS EXACT. At 1600x1000 every number here comes out at the
-- value that was hand-tuned into table.luau before it moved: card 120x168,
-- gap 24, left 308, rows at 208 and 430, fan 34 and 14, ui 1. The vertical
-- proportions below are written as fractions of the card's HEIGHT and they
-- sum to 1000/168 on purpose — that identity is what makes the desktop look
-- survive the change, and `tests.luau` asserts it.
-- ============================================================================

local M = {}

-- The card artboards' own size (cards.rml). A card is DRAWN at `cw` x `ch`,
-- which is this times `fit`; the corner glyphs, the plate's radius and every
-- other number inside a card face stay in these units.
M.CARD_W = 120
M.CARD_H = 168
M.COLS = 7

local CARD_W = 120
local CARD_H = 168
local COLS = 7
local ASPECT = CARD_H / CARD_W

-- The gap between columns, as a fraction of a card's width (24/120).
local GAP_RATIO = 0.2

-- The vertical stack, in card heights. Read down the screen:
--   pad, the top row, the gap, the tableau's first card, a column, the foot.
--
-- TOP_PAD is not spare room: it is the strip the HUD stands in, and 124 is
-- where the stock's top edge sits under a title and a row of readouts that
-- reach 126. (They have always overlapped by those two pixels — look at the
-- clock over the corner of the deck.) So it is the one fraction that is ALSO
-- read in chrome units: a card that shrinks does not make the words shrink
-- with it, and on a 390-tall landscape phone a top pad of 124/168 of a 40px
-- card put the deck squarely behind the clock. The strip the chrome needs is
-- taken off the height FIRST and the card is sized out of what is left.
local TOP_PAD = 124 / CARD_H
local ROW_GAP = 54 / CARD_H
local FOOT_PAD = 164 / CARD_H
-- A NOMINAL long column: six face-down and seven face-up, which is column 7
-- of a deal with a run built on it. 6*14 + 7*34.
local COL_BUDGET = 322 / CARD_H
-- The fan steps themselves.
local FAN_UP = 34 / CARD_H
local FAN_DOWN = 14 / CARD_H

-- What the six above sum to with the two whole cards between them. It is
-- 1000/168, and that is why a 1000-tall viewport yields a 168-tall card.
local STACK = TOP_PAD + 1 + ROW_GAP + 1 + COL_BUDGET + FOOT_PAD
-- The same stack with the chrome's strip taken out of it: what the BOARD
-- needs, per card height, below that strip.
local BOARD = STACK - TOP_PAD

-- Where the spare height goes when the WIDTH is what limits the card — a
-- portrait phone, where seven columns across 390px leave half the screen
-- over. Most of it becomes fan: a bigger step is more of every buried card
-- showing, which is the thing a small screen is short of. The rest lifts the
-- board off the top edge. Whatever the fan cannot use falls to the bottom,
-- where the seal swims.
local SPARE_TOP = 0.18
local SPARE_GAP = 0.12
local SPARE_COL = 0.70

-- The card has a ceiling as well as a floor. Nothing about the game wants one
-- bigger than this, and the tank atlas is 8x7 tiles of `cw` x `ch` DEVICE
-- pixels — so a card that grew with a very tall viewport would quietly
-- allocate a texture measured in tens of megabytes on a monitor nobody is
-- holding any closer than the one this was tuned on.
local CARD_MAX = 180

-- A fan step may not pass this fraction of a card: past it the column reads
-- as loose cards rather than a stack.
local FAN_MAX = 0.60
-- Nor fall below it. The rank prints in a corner 6px down a 168px card and
-- stands about 28px tall, so 34 — the reference step — is the rank plus its
-- margin, and 26 is the last step that still shows the whole digit. Squeeze
-- past this and the number a card is for goes under the card on top of it.
local FAN_MIN = 26 / CARD_H

local function clamp(v: number, lo: number, hi: number): number
    return math.max(lo, math.min(hi, v))
end

export type Rect = { x: number, y: number, w: number, h: number }

-- The tuner's panel. Its rows are 380x16 artboards (tuner.rml) drawn at
-- `scale`, so `x0`/`x1` — the knob's track — stay in ROW units and a pointer
-- is divided by `scale` before it is read against them.
export type Tuner = {
    x: number, y: number,
    colW: number, cols: number, maxH: number, gutter: number,
    top: number, foot: number, rowH: number, headH: number,
    x0: number, x1: number,
    scale: number,
}

export type Geom = {
    w: number, h: number,

    -- The card, and the factor that carries a card artboard (and everything
    -- measured in its px) onto the screen.
    cw: number, ch: number, gap: number, fit: number, radius: number,

    -- The grid.
    left: number, topY: number, tabY: number,

    -- The fan, and the room a column has before it must squeeze.
    fanUp: number, fanDown: number, colSpan: number,

    -- The chrome.
    ui: number,
    title: Rect, stats: Rect, button: Rect,

    -- What `sealLength` multiplies: the seal is sized against the cards it
    -- bites, capped so it can still turn on a narrow screen.
    sealRef: number,

    tuner: Tuner,
}

-- The x of a column's centre, 1..COLS. The top row uses the same grid:
-- stock at 1, waste at 2, the four foundations at 4..7.
function M.colX(g: Geom, col: number): number
    return g.left + g.cw / 2 + (col - 1) * (g.cw + g.gap)
end

-- The fan a PILE gets. Its steps are the geometry's until the pile is long
-- enough to run off the bottom, and then both shrink together — the shape of
-- the fan is one thing, so squeezing the face-up step alone would open the
-- buried cards as the visible ones closed.
--
-- `nDown` face-down and `nUp` face-up: the extent is the steps under the last
-- card plus that card's own height, which is what has to fit `colSpan`.
function M.fanFor(g: Geom, nDown: number, nUp: number): (number, number)
    local steps = nDown * g.fanDown + math.max(0, nUp - 1) * g.fanUp
    local room = g.colSpan - g.ch
    if steps <= room or steps <= 0 then
        return g.fanUp, g.fanDown
    end
    local k = math.max(room / steps, FAN_MIN * g.ch / g.fanUp)
    return g.fanUp * k, g.fanDown * k
end

-- HOW FAR THE STOCK'S FAN MAY RISE. The deck is at column 1 of the top row
-- and the fan lifts it into a ribbon above itself, so what limits the rise is
-- whatever stands in the strip BETWEEN the window's top edge and the deck's:
-- `rise` px of it, less `clear` px of air, and less any chrome in the way.
--
-- ONLY CHROME THAT IS ACTUALLY ABOVE THE DECK COUNTS. The floor used to be
-- the bottom of any chrome rectangle overlapping the deck's column, which was
-- true while the whole HUD was a strip along the top. It is not true now: the
-- wordmark and the readouts moved to the FOOT, and the readouts still overlap
-- the deck's column — they are 836px BELOW it, and their bottom edge as a
-- floor put the ceiling under the floor and the room at zero, so the deck
-- stopped fanning at every size of screen at once. A rectangle below the
-- deck's top edge cannot be in the way of something rising off it.
--
-- A rectangle that STRADDLES the edge is in the way completely: its bottom is
-- read as the edge itself, which leaves no room rather than negative room.
function M.fanRoom(g: Geom, sx: number, rise: number, clear: number): number
    local x0, x1 = sx - g.cw / 2, sx + g.cw / 2
    local topEdge = g.topY - g.ch / 2
    local floor = 0
    for _, r in ipairs({ g.title, g.stats, g.button }) do
        if r.x < x1 and r.x + r.w > x0 and r.y < topEdge then
            floor = math.max(floor, math.min(r.y + r.h, topEdge))
        end
    end
    return clamp(topEdge - floor - clear * g.fit, 0, rise * g.fit)
end

function M.compute(w: number, h: number): Geom
    w = math.max(1, w)
    h = math.max(1, h)

    -- The chrome first, because the strip it stands in comes off the height
    -- before the card is sized. Held near its design size — a 13px label is
    -- read at arm's length on a phone and on a monitor alike — but never so
    -- large that the top strip stops being a row. 620 is that row's width at
    -- scale 1: the three readouts out to 420, then the deal button's 200 off
    -- the right edge. Sized against the TITLE instead (270) the readouts
    -- still fitted the screen and the clock still sat under the button,
    -- because they clear it by six pixels of height and nothing else.
    local ui = math.min(1.25, math.max(math.min(w / 1600, h / 1000), 0.8))
    ui = math.min(ui, w / 620)
    local chromeTop = TOP_PAD * CARD_H * ui

    -- The card is whichever of the two limits bites first: seven columns
    -- across the width, or the rest of the stack down what height is left.
    local padX = math.max(12, w * 0.03)
    local byWidth = (w - 2 * padX) / (COLS + (COLS - 1) * GAP_RATIO)
    local byHeight = (math.max(1, h - chromeTop) / BOARD) / ASPECT
    local cw = clamp(math.min(byWidth, byHeight), 20, CARD_MAX)
    local ch = cw * ASPECT
    local fit = cw / CARD_W
    local gap = cw * GAP_RATIO
    local left = (w - (COLS * cw + (COLS - 1) * gap)) / 2

    -- Height the board did not need. Zero whenever the height is the limit,
    -- which is the desktop's case and why the reference is exact.
    local spare = math.max(0, h - chromeTop - BOARD * ch)
    local topPad = chromeTop + spare * SPARE_TOP
    local rowGap = ROW_GAP * ch + spare * SPARE_GAP
    local topY = topPad + ch / 2
    local tabY = topY + ch + rowGap

    local budget = COL_BUDGET * ch
    local colRoom = budget + spare * SPARE_COL
    local fanUp = math.min(FAN_UP * ch * (colRoom / budget), ch * FAN_MAX)
    local fanDown = fanUp * (FAN_DOWN / FAN_UP)
    -- What a column may actually occupy before `fanFor` squeezes it: the room
    -- below its first card's top edge, less a margin at the bottom. The
    -- margin is the design's, or the chrome's own strip where the cards have
    -- shrunk past it — the wordmark and the readouts sit bottom-left now, so
    -- the strip is theirs — the same trade the top pad makes, at the far end.
    local colSpan = h - (tabY - ch / 2) - math.max(FOOT_PAD * ch * 0.4, 104 * ui)

    -- The panel. Right-anchored with a 20px margin, which is where it already
    -- sat; a screen too narrow for two 380px columns gets one.
    --
    -- 1724px of sliders do not fit a phone in any number of columns, so the
    -- panel scrolls — and the GUTTER is what it scrolls by. Every other pixel
    -- of it is a slider, a header or a readout, so a drag anywhere else is
    -- already an edit; a strip down the left that is deliberately nothing is
    -- the only place a scroll can live without taking a gesture away from the
    -- thing the panel is for. The columns still start where they always did.
    local ts = clamp(math.min(w / 1600, h / 1000), 0.7, 1)
    local colW = 380 * ts
    -- Wide enough for a thumb even on the smallest panel: a scroll nobody
    -- can hit is the same as no scroll.
    local gutter = math.max(16, 22 * ts)
    local cols = math.floor(clamp(math.floor((w - 40 - gutter) / colW), 1, 2))

    return {
        w = w, h = h,
        cw = cw, ch = ch, gap = gap, fit = fit, radius = 10 * fit,
        left = left, topY = topY, tabY = tabY,
        fanUp = fanUp, fanDown = fanDown, colSpan = colSpan,
        ui = ui,
        -- The wordmark and the readouts, BOTTOM-LEFT: a row along the foot,
        -- the moves to the right of the title. The title's hot zone reaches
        -- the screen's corner. The deal button keeps the top right.
        title = { x = 0, y = h - 104 * ui, w = 300 * ui, h = 104 * ui },
        -- 140 wide: the readouts artboard is 380 with the score and the clock
        -- hidden in it, and only the MOVES column shows; a rectangle the
        -- hidden width would run off a 320px screen.
        stats = { x = 300 * ui, y = h - 86 * ui, w = 140 * ui, h = 46 * ui },
        button = { x = w - 200 * ui, y = 30 * ui, w = 160 * ui, h = 44 * ui },
        sealRef = math.min(ch * STACK, w * (1000 / 1600)),
        tuner = {
            x = w - 20 - colW * cols - gutter, y = 10,
            colW = colW, cols = cols, gutter = gutter,
            maxH = math.min(960 * ts, h - 20),
            top = 10 * ts, foot = 30 * ts, rowH = 16 * ts, headH = 20 * ts,
            x0 = 172, x1 = 360,
            scale = ts,
        },
    }
end

-- Where the title is DRAWN, which is inside its hot zone rather than at its
-- corner. Kept here so the rectangle and the wordmark can never drift apart.
function M.titleAt(g: Geom): (number, number)
    return 40 * g.ui, g.h - 88 * g.ui
end

return M
