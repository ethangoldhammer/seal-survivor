-- ============================================================================
-- THE MUSIC — one loop, forever, without a seam, and NEVER TWICE.
--
-- The loop is music/wetris.mp3, and its exact length is musicLoop.csv's —
-- taken from the lossless source by tools/wetris-music.mjs, never from the
-- MP3, which carries the encoder's priming at its head and padding at its
-- tail. Restarting the file when it ends would put that silence in every loop.
--
-- So every repeat is SCHEDULED: `Audio.playAtTime` exactly `seconds` after
-- the one before, on the audio engine's own clock, a second and a half ahead
-- so a slow frame can never make it late. The priming is the same in every
-- copy, so the music in each starts exactly where the last one's stops; the
-- padding is silence overlapping silence.
--
-- ONE COPY, EVER. Two ways a second one used to start:
--
--   A SECOND BOARD in the same scripting context (init runs twice; a board
--   can be rebuilt). Each board had its own schedule, so each played the
--   loop. Now the schedule is this MODULE's — loaded once per context — and
--   a board's `Music` is only a ticket to drive it. One board drives; another
--   takes over only when the driver has gone quiet, and it takes over the
--   same voices and the same schedule, so the handover is inaudible.
--
--   A REBUILD. `npm run wetris` rebuilds in the SAME PROCESS on every save —
--   the tuner's SAVE, or any edit to a file in rive/wetris. The scripting
--   context is new, so this module is fresh and knows nothing, but the audio
--   engine is not: its clock carries on, and so does every copy the previous
--   context started or scheduled. There is no handle to them anywhere in the
--   script API (no enumerate, no stop-all), so they cannot be stopped. They
--   must not be doubled instead.
--
-- THE GRID IS THE PROCESS'S, which is how a rebuild avoids them. The first
-- context in a process starts the loop at engine time GRID0 exactly, and
-- every copy after it lands on GRID0 + k * seconds. That is arithmetic every
-- later context can redo without being told anything. A context that finds
-- the engine older than itself (sealitaire's orphan test: the engine clock
-- against the module's own) knows the previous context may have scheduled any
-- grid point up to AHEAD past the moment it died, which is no later than the
-- moment this one loaded — so it schedules only the grid points after that.
-- Those were never started by anybody. The music carries on across a save
-- without a seam, played by the new context from the next loop.
--
-- The one gap it can leave: a grid point that fell due in the half second the
-- rebuild itself took is scheduled by nobody, and that loop is silent. That
-- is the trade, on purpose — a missing loop is a pause, two loops is noise.
--
-- IF THE CLOCK DOES NOT MOVE, NOTHING IS SCHEDULED — it waits. A frozen
-- `Audio.time()` is an audio engine that is not running: the headless runs
-- (which play no sound at all), and a phone or iPad whose browser holds the
-- audio suspended until the player first touches the page. On the iPad this
-- used to fall back, after a second, to restarting the loop whenever the
-- voice said `completed()` — and that answer is not trustworthy (sealitaire's
-- music.luau has the scars: a handle that played nothing answers yes), so it
-- started a new copy every frame and the music came out as a stutter of
-- starts. Nothing here reads `completed()` now. The grid is placed on the
-- first frame the clock is SEEN TO MOVE, and a clock that stops again
-- mid-loop (a tab put in the background) simply schedules nothing until it
-- moves again.
-- ============================================================================

local M = {}

local AHEAD = 1.5       -- s: schedule the next repeat this long before it is due
local RELOAD_GAP = 2.0  -- s: an engine older than this module by more than this is a rebuild's
local GRID0 = RELOAD_GAP + 0.1  -- engine s: the first context's first copy, and the grid's origin
local HANDOVER = 0.25   -- s the driving board may go quiet before another takes over

-- THE ONE SEAM TO THE AUDIO ENGINE, so tests.luau can put a fake clock and a
-- fake voice behind it. `Audio` does not exist in a `--test` run.
M.engine = {
    time = function(): number
        return Audio.time()
    end,
    play = function(src: any): any
        return Audio.play(src)
    end,
    playAtTime = function(src: any, at: number): any
        return Audio.playAtTime(src, at)
    end,
}

-- A board's ticket. `tried` is the board's own "have I asked for the loop yet".
export type Music = { tried: boolean }

type Voice = { snd: any, at: number }

-- The transport. One per scripting context, whatever holds a ticket.
local S = {
    loaded = false,
    src = nil :: any,
    seconds = 0,
    voices = {} :: { Voice },
    nextAt = -1,            -- engine time the next copy is due, -1 until the grid is placed
    lastClock = -1,
    moved = false,          -- the engine clock has been seen to move: it is running
    owner = nil :: Music?,
    ownerQuiet = 0,
    sinceLoad = 0,          -- seconds of frames since this context first drove
    stopped = false,        -- M.stop() has run: the board is on its way out
    fresh = false,          -- M.fresh(): the page vouches nothing is playing
}

-- A fresh context, for tests: what a rebuild does to this module.
function M.reset()
    S.loaded = false
    S.src = nil
    S.seconds = 0
    S.voices = {}
    S.nextAt = -1
    S.lastClock = -1
    S.moved = false
    S.owner = nil
    S.ownerQuiet = 0
    S.sinceLoad = 0
    S.stopped = false
    S.fresh = false
end

function M.new(): Music
    return { tried = false }
end

-- The loop's asset and length, once per context however many boards ask.
-- Quiet when there is none: a build without the music is a silent board, not
-- a broken one.
function M.load(m: Music, context: Context)
    m.tried = true
    if S.loaded then
        return
    end
    S.loaded = true
    local blob = context:blob('musicLoop')
    if blob == nil then
        print('wetris: musicLoop.csv missing; no music (npm run wetris:music)')
        return
    end
    local text = buffer.tostring(blob.data)
    local head = true
    for line in text:gmatch('[^\n]+') do
        if head then
            head = false
        else
            local name, secs = line:match('^([^,]+),([^,]+)')
            local s = tonumber(secs or '')
            if name ~= nil and s ~= nil and s > 1 then
                S.src = context:audio(name)
                S.seconds = s
                if S.src == nil then
                    print(`wetris: musicLoop.csv names "{name}", which is not an AudioAsset`)
                end
                return
            end
        end
    end
end

-- For tests: hand the transport an asset without a Context.
function M.loadSource(src: any, seconds: number)
    S.loaded = true
    S.src = src
    S.seconds = seconds
end

local function start(at: number)
    local src = S.src
    if src == nil then
        return
    end
    local ok, snd = pcall(function(): any
        return if at > 0 then M.engine.playAtTime(src, at) else M.engine.play(src)
    end)
    if ok and snd ~= nil then
        table.insert(S.voices, { snd = snd, at = at })
    end
end

-- Where this context's first copy goes. The first context in the process
-- opens the grid; a later one joins it at the first point nobody before it
-- can have scheduled.
local function placeGrid(now: number)
    if S.fresh then
        S.nextAt = now + 0.05
        return
    end
    local loadedAt = now - S.sinceLoad
    if loadedAt <= RELOAD_GAP then
        S.nextAt = GRID0
        return
    end
    local k = math.ceil((loadedAt + AHEAD - GRID0) / S.seconds)
    S.nextAt = GRID0 + math.max(k, 0) * S.seconds
    print(
        `wetris: rebuilt with the loop still playing from before; ` ..
        `this context takes over at the next loop ({math.floor(S.nextAt - now + 0.5)}s)`
    )
end

-- SILENCE, for the way out. Every copy this context started or scheduled —
-- the one playing and the one queued AHEAD seconds early — stopped, and the
-- transport parked so nothing schedules another. The artboard's own teardown
-- does not do this: a sound a script starts belongs to the audio engine, not
-- the artboard, and on the web it played on after the board was gone.
-- A CLEAN START, from the page that mounted this board: it tore the last
-- board down with M.stop(), so an engine older than this context is NOT a
-- rebuild's orphan still playing. Without this, coming back into the mode
-- sat in silence until the next grid point, up to a whole loop. A grid
-- already placed for an orphan is re-placed, as long as nothing has started.
function M.fresh()
    if #S.voices > 0 then
        return
    end
    S.fresh = true
    S.nextAt = -1
end

function M.stop()
    for _, v in S.voices do
        pcall(function()
            v.snd:stop()
        end)
    end
    S.voices = {}
    S.stopped = true
end

function M.step(m: Music, dt: number, volume: number)
    if S.stopped then
        return
    end
    -- One driver. Anyone else waits, and takes over only if it goes quiet.
    if S.owner ~= m then
        if S.owner ~= nil and S.ownerQuiet <= HANDOVER then
            S.ownerQuiet += dt
            return
        end
        S.owner = m
    end
    S.ownerQuiet = 0

    if S.src == nil or S.seconds <= 0 then
        return
    end
    S.sinceLoad += dt
    local now = M.engine.time()
    local last = S.lastClock
    S.lastClock = now
    if last >= 0 and now ~= last then
        S.moved = true
    end
    -- Never seen to move: the engine is not running (see the header). Wait.
    -- Once it has, a clock that stops again schedules nothing by itself —
    -- the look-ahead below is measured against it.
    if not S.moved then
        return
    end
    if S.nextAt < 0 then
        placeGrid(now)
    end
    -- Every copy that falls due inside the look-ahead, at exact multiples
    -- of the loop from the grid's origin.
    while S.nextAt - now < AHEAD do
        start(S.nextAt)
        S.nextAt += S.seconds
    end
    -- Forget the ones whose music has long finished.
    local i = 1
    while i <= #S.voices do
        local v = S.voices[i]
        if v.at + S.seconds + 1 < now then
            table.remove(S.voices, i)
        else
            i += 1
        end
    end
    for _, v in S.voices do
        v.snd.volume = volume
    end
end

return M
