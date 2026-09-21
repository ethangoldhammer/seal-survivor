-- ============================================================================
-- THE CURSOR — where a gamepad is on the table, and what a direction does to
-- it. Pure, like klondike.luau and layout.luau: a cursor is two integers, a
-- step is a function of the cursor and the game, and nothing here touches a
-- renderer, a sound or a spring. `sealitaire:test` walks the whole of it.
--
-- WHY A CURSOR AND NOT A FLYING POINTER. A thumbstick aimed at a 45px card on
-- a phone-sized table is the part of a pad port that always feels bad: the
-- stick has to be slow enough to land on a card and fast enough to cross the
-- table, and no speed is both. The table has thirteen places a card can be
-- and the cursor simply stands in one of them, so every press lands somewhere
-- exact. What it costs is the tuner, which stays a pointer's panel.
--
-- THE GRID IS THE TABLE'S OWN. `layout.luau` puts the top row and the tableau
-- on one seven-column grid — stock at 1, waste at 2, the foundations at 4..7,
-- the seven columns beneath — so the cursor is a (row, col) on that same grid
-- and never carries a coordinate of its own. Column 3 of the top row is the
-- gap layout leaves between the waste and the foundations; there is nothing
-- to land on there, so the walk skips it rather than stopping on a hole.
--
-- DEPTH IS THE SECOND AXIS AND IT SHARES UP/DOWN. A tableau column is a run
-- you may take from anywhere down its face-up part, and which card you take
-- is the whole of the choice. So up and down walk INSIDE the column first and
-- only leave it from its ends — the read is "climb the column, then step off
-- the top". `band` is what they walk between: the indices this pile will
-- actually hand you a run from, which is exactly what `K.runFrom` accepts, so
-- the pad can never pick up something a click could not.
-- ============================================================================
local K = require('klondike')

local M = {}

M.TOP = 1        -- the deck, the waste and the four foundations
M.TABLEAU = 2

M.COLS = 7
-- The top row's occupied columns, in order. 3 is layout's gap.
M.TOP_COLS = { 1, 2, 4, 5, 6, 7 }
M.TAB_COLS = { 1, 2, 3, 4, 5, 6, 7 }

export type Cursor = { row: number, col: number }

function M.new(): Cursor
    -- The first tableau column: where a deal's first move nearly always is,
    -- and one step from both the deck and the foundations.
    return { row = M.TABLEAU, col = 1 }
end

-- EVERYTHING THE TABLE CARRIES FOR THE PAD, in one record rather than a dozen
-- loose fields on `Table`. Not tidiness: Luau's inference has a budget for a
-- single file, and table.luau is already near it — twelve more fields on that
-- type took the whole script to "Code is too complex to typecheck", which
-- fails the build in a place that has nothing to do with the pad. A named
-- record costs one field, which is how `goo`, `music`, `puppet` and `bub` are
-- carried too.
--
-- `state` is the buttons as of the last event. A pad event carries the whole
-- device state rather than only what changed, so the edges are diffed against
-- this — which also means a pad plugged in with a button already held does
-- not fire it.
export type State = {
    on: boolean,            -- a controller has sent something and the mouse has not taken over
    cursor: Cursor,
    grab: number,           -- the index selected in the cursor's pile, 0 for none
    x: number, y: number,           -- the direction held right now, -1/0/1
    lastX: number, lastY: number,   -- ...as of the previous tick, for the edge
    holdX: number, holdY: number,   -- seconds until the next repeat
    state: { [string]: boolean },
}

function M.newState(): State
    return {
        on = false,
        cursor = M.new(),
        grab = 0,
        x = 0, y = 0,
        lastX = 0, lastY = 0,
        holdX = 0, holdY = 0,
        state = {},
    }
end

local function colsOf(row: number): { number }
    return if row == M.TOP then M.TOP_COLS else M.TAB_COLS
end

-- The pile a cursor stands on, or nil for the top row's gap. Nothing else can
-- return nil: every tableau column exists even when it is empty, because an
-- empty column is a place a king goes.
function M.pileAt(game: K.Game, cur: Cursor): K.Pile?
    if cur.row == M.TOP then
        if cur.col == 1 then
            return game.stock
        elseif cur.col == 2 then
            return game.waste
        elseif cur.col >= 4 and cur.col <= 7 then
            return game.foundations[cur.col - 3]
        end
        return nil
    end
    return game.tableau[cur.col]
end

-- Where a pile puts the cursor. The inverse of pileAt, for the jumps that
-- name a pile rather than a direction (the shoulder buttons, and the card a
-- pointer last touched handing over to the pad).
function M.cursorOf(pile: K.Pile): Cursor
    if pile.kind == 'stock' then
        return { row = M.TOP, col = 1 }
    elseif pile.kind == 'waste' then
        return { row = M.TOP, col = 2 }
    elseif pile.kind == 'foundation' then
        return { row = M.TOP, col = 3 + pile.index }
    end
    return { row = M.TABLEAU, col = pile.index }
end

function M.same(a: Cursor, b: Cursor): boolean
    return a.row == b.row and a.col == b.col
end

-- THE BAND: the lowest and highest index this pile will hand over a run from,
-- or 0, 0 when it will hand over none. It is `K.runFrom`'s answer read as a
-- range rather than asked card by card — the accepting indices of a tableau
-- pile are always a suffix (a run is only takeable when every card under it
-- to the bottom is face up), so two numbers say it exactly.
--
-- The stock is 0, 0 on purpose: you do not pick a card off the deck, you draw
-- one, and the draw is a button rather than a place.
function M.band(pile: K.Pile): (number, number)
    local n = #pile.cards
    if n == 0 or pile.kind == 'stock' then
        return 0, 0
    end
    if pile.kind ~= 'tableau' then
        -- The waste and the foundations give up their top card and nothing
        -- else, so the band is one index wide.
        return n, n
    end
    local lo = n
    while lo > 1 and pile.cards[lo - 1].faceUp do
        lo -= 1
    end
    if not pile.cards[n].faceUp then
        return 0, 0
    end
    return lo, n
end

-- An index pulled into a pile's band, or 0 where the pile has none. The
-- selection is re-read through this every frame rather than being trusted
-- once: the pile under the cursor changes height while the cursor sits on it
-- (a card is drawn onto the waste, a run is played off a column, the card
-- beneath turns over), and an index that was the bottom card a moment ago is
-- otherwise left pointing past the end of the list.
function M.grabAt(pile: K.Pile, at: number): number
    local lo, hi = M.band(pile)
    if hi == 0 then
        return 0
    end
    return math.max(lo, math.min(hi, at))
end

-- ---------------------------------------------------------------------------
-- The walk
-- ---------------------------------------------------------------------------
-- Sideways. WRAPS within the row, because a row is at most seven stops and a
-- held direction that dead-ends at column seven leaves the player pressing
-- the other way to get back — a ring is fewer presses and never traps.
local function sideways(cur: Cursor, by: number): Cursor
    local cols = colsOf(cur.row)
    local at = 1
    local best = math.huge
    for i, c in ipairs(cols) do
        local d = math.abs(c - cur.col)
        if d < best then
            best, at = d, i
        end
    end
    local n = #cols
    local next = ((at - 1 + by) % n + n) % n + 1
    return { row = cur.row, col = cols[next] }
end

function M.left(cur: Cursor): Cursor
    return sideways(cur, -1)
end

function M.right(cur: Cursor): Cursor
    return sideways(cur, 1)
end

-- Up out of the tableau, onto the nearest top-row pile. The gap at column 3
-- means the middle column has two equally near neighbours, and the tie goes
-- LEFT — to the waste, which is a pile you take from, over a foundation,
-- which is one you send to. Reaching up from the middle of the table is
-- nearly always reaching for the waste.
function M.nearestTop(col: number): number
    local best, bestD = M.TOP_COLS[1], math.huge
    for _, c in ipairs(M.TOP_COLS) do
        local d = math.abs(c - col)
        if d < bestD then
            best, bestD = c, d
        end
    end
    return best
end

-- The two rows do NOT wrap into each other. Left and right are a ring because
-- a row is a ring; up and down are the table's own two decks and a player who
-- presses up at the top has said "go up", not "go all the way round".
function M.up(cur: Cursor): Cursor?
    if cur.row == M.TOP then
        return nil
    end
    return { row = M.TOP, col = M.nearestTop(cur.col) }
end

function M.down(cur: Cursor): Cursor?
    if cur.row == M.TABLEAU then
        return nil
    end
    return { row = M.TABLEAU, col = cur.col }
end

export type Vertical = {
    cursor: Cursor,     -- where the cursor ends up
    grab: number,       -- the index selected there, 0 for none
    moved: boolean,     -- the press did something
    left: boolean,      -- ...and it left the pile it was on
}

-- UP AND DOWN, WITH THE DEPTH WALK IN FRONT. The press climbs inside the
-- column it is on and only steps off when the column has no more to give:
-- up from the shallowest takeable card leaves for the top row, down from the
-- bottom card stops dead (there is no third row, and a wrap here would send
-- the cursor flying to the deck mid-climb).
--
-- `holding` is a run already in hand. Then the depth walk is off entirely —
-- the cursor is choosing a DESTINATION, and how deep into a pile you would
-- have grabbed is not a question any more.
function M.vertical(game: K.Game, cur: Cursor, at: number, by: number, holding: boolean): Vertical
    local pile = M.pileAt(game, cur)
    if not holding and pile ~= nil and pile.kind == 'tableau' then
        local lo, hi = M.band(pile)
        if hi > 0 then
            local from = math.max(lo, math.min(hi, at))
            local to = from + by
            if to >= lo and to <= hi then
                return { cursor = cur, grab = to, moved = true, left = false }
            end
        end
    end
    local next = if by < 0 then M.up(cur) else M.down(cur)
    if next == nil then
        return { cursor = cur, grab = M.grabAt(pile or game.stock, at), moved = false, left = false }
    end
    local into = M.pileAt(game, next)
    -- ARRIVING TAKES THE BOTTOM CARD, not the depth the column it left was
    -- at. The card at the foot of a column is the one nearly every move
    -- starts from, and a cursor that lands halfway up a stranger's pile has
    -- to be driven back down before it is any use. (Sideways is the other
    -- way round -- see `horizontal`, where the height IS the intention.)
    local grab = 0
    if into ~= nil then
        local _, hi = M.band(into)
        grab = hi
    end
    return { cursor = next, grab = grab, moved = true, left = true }
end

-- Sideways, with the same shape of answer. No depth walk: a step across the
-- table ALWAYS arrives on the pile's bottom card, and the depth the last
-- column was climbed to is not carried over. An index is not a height — the
-- third card of a five-card column and the third of a twelve-card one are in
-- quite different places on the screen — so carrying it looks like the cursor
-- jumping about rather than like holding a line.
function M.horizontal(game: K.Game, cur: Cursor, by: number): Vertical
    local next = if by < 0 then M.left(cur) else M.right(cur)
    local into = M.pileAt(game, next)
    local grab = 0
    if into ~= nil then
        local _, hi = M.band(into)
        grab = hi
    end
    return { cursor = next, grab = grab, moved = not M.same(next, cur), left = true }
end

-- ---------------------------------------------------------------------------
-- The jumps
-- ---------------------------------------------------------------------------
-- Every pile a move could START from, in reading order: the waste, then the
-- tableau left to right. This is `K.plays` read as places rather than as
-- moves — several plays off one column are one stop, because the shoulder
-- buttons are a way of getting somewhere, not a way of choosing.
--
-- The deck is not here. Drawing is always available and never needs pointing
-- at, which is the same reason `K.plays` leaves it out.
function M.sources(game: K.Game): { Cursor }
    local seen: { [string]: boolean } = {}
    local out: { Cursor } = {}
    local order: { K.Pile } = { game.waste }
    for _, t in ipairs(game.tableau) do
        table.insert(order, t)
    end
    local live: { [string]: boolean } = {}
    for _, play in ipairs(K.plays(game)) do
        live[`{play.from.kind}:{play.from.index}`] = true
    end
    for _, p in ipairs(order) do
        local tag = `{p.kind}:{p.index}`
        if live[tag] and not seen[tag] then
            seen[tag] = true
            table.insert(out, M.cursorOf(p))
        end
    end
    return out
end

-- Every pile the run in hand could legally LAND on, in reading order: the
-- foundations, then the tableau. `K.plays` is the filter, so this is the same
-- set the seal's fins point at and the same one a drag would be accepted by —
-- and, like that list, it offers a king only the first empty column.
function M.destinations(game: K.Game, from: K.Pile, index: number): { Cursor }
    type Landing = { at: number, cursor: Cursor }
    local found: { Landing } = {}
    local seen: { [string]: boolean } = {}
    for _, play in ipairs(K.plays(game)) do
        if play.from == from and play.index == index then
            local tag = `{play.to.kind}:{play.to.index}`
            if not seen[tag] then
                seen[tag] = true
                -- The foundations first, then the columns: the order they are
                -- read in on the table, which is the order a ring should step
                -- through them in.
                local at = if play.to.kind == 'foundation' then play.to.index else 10 + play.to.index
                table.insert(found, { at = at, cursor = M.cursorOf(play.to) })
            end
        end
    end
    table.sort(found, function(a: Landing, b: Landing): boolean
        return a.at < b.at
    end)
    local out: { Cursor } = {}
    for _, it in ipairs(found) do
        table.insert(out, it.cursor)
    end
    return out
end

-- ---------------------------------------------------------------------------
-- The device
--
-- This half is what a controller SENT; what a press does is table.luau's.
-- The split is worth naming: reading a pad is the same on any table, and the
-- work is the sort that is cheap here and expensive there — table.luau is
-- close enough to Luau's per-file inference budget that two hundred lines of
-- anything take the whole script to "Code is too complex to typecheck".
-- ---------------------------------------------------------------------------
-- The buttons this game reads, and the order edges are looked for in. A fixed
-- list rather than a pass over the state table: `pairs` has no order, and two
-- buttons pressed in one event would otherwise fire in whichever the hash
-- gave.
M.BUTTONS = {
    'south', 'east', 'north', 'west',
    'leftShoulder', 'rightShoulder', 'start', 'back',
}

-- Take one event. A pad event carries the device's WHOLE state rather than
-- only the field that changed, so the edges are found by diffing against the
-- last one rather than by reading `changeKind`/`changeIndex` — which is also
-- what lets `gamepadConnected` come through this same function: a pad plugged
-- in with a button already held records it and does not fire it.
--
-- It handles an unknown mapping by doing nothing: the named fields are false
-- throughout when the embedder could not normalise the device, so the table
-- simply never sees a press rather than acting on whichever slot lined up.
--
-- Returns the names pressed on this event, in BUTTONS order. The direction is
-- left in `st.x`/`st.y` instead, because a held stick sends no further events
-- and what repeats it is a clock, not this.
function M.read(st: State, ev: any, dead: number): { string }
    local was = st.state
    local now: { [string]: boolean } = {}
    local pressed: { string } = {}
    for _, name in ipairs(M.BUTTONS) do
        local down = ev[name] == true
        now[name] = down
        if down and not was[name] then
            table.insert(pressed, name)
        end
    end
    st.state = now

    -- The d-pad wins over the stick where both are given: a thumb on the
    -- d-pad is unambiguous and a stick resting a little off centre is not.
    local stick = ev.leftStick
    -- W3C's leftY is negative UP, which is the screen's own sign.
    local sx = if stick ~= nil then stick.x else 0
    local sy = if stick ~= nil then stick.y else 0
    local dx = 0
    if ev.dpadLeft then
        dx = -1
    elseif ev.dpadRight then
        dx = 1
    elseif sx <= -dead then
        dx = -1
    elseif sx >= dead then
        dx = 1
    end
    local dy = 0
    if ev.dpadUp then
        dy = -1
    elseif ev.dpadDown then
        dy = 1
    elseif sy <= -dead then
        dy = -1
    elseif sy >= dead then
        dy = 1
    end
    -- ONE AXIS AT A TIME. A stick held at 45 degrees crosses both rails and
    -- would step sideways AND out of the column on the same tick, which reads
    -- as the cursor jumping a slot rather than moving. The larger deflection
    -- wins; a tie goes to the horizontal, because the table's rows are wider
    -- than they are tall. The d-pad is exempt: two of its buttons held at
    -- once is a deliberate diagonal, and the branches above already picked.
    if dx ~= 0 and dy ~= 0 and not (ev.dpadLeft or ev.dpadRight or ev.dpadUp or ev.dpadDown) then
        if math.abs(sy) > math.abs(sx) then
            dx = 0
        else
            dy = 0
        end
    end
    st.x = dx
    st.y = dy
    return pressed
end

-- Where a card is, as a cursor and an index. Klondike keeps no card-to-pile
-- lookup and does not need one for this: the piles are thirteen short lists
-- and this is asked on an edge, not on a frame.
function M.find(game: K.Game, id: number): (Cursor?, number)
    for _, p in ipairs(K.piles(game)) do
        for k, c in ipairs(p.cards) do
            if c.id == id then
                return M.cursorOf(p), M.grabAt(p, k)
            end
        end
    end
    return nil, 0
end

-- The next cursor in a ring, after the one we are on. Used by both jumps: the
-- list is short and rebuilt on every press, so this is a scan rather than an
-- index held across frames — a list held across a move goes stale the instant
-- the move changes what has a play on it.
function M.nextIn(ring: { Cursor }, cur: Cursor, by: number): Cursor?
    local n = #ring
    if n == 0 then
        return nil
    end
    local at = 0
    for i, c in ipairs(ring) do
        if M.same(c, cur) then
            at = i
            break
        end
    end
    if at == 0 then
        return if by < 0 then ring[n] else ring[1]
    end
    return ring[((at - 1 + by) % n + n) % n + 1]
end

return M
