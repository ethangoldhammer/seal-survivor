-- ============================================================================
-- THE SOUND — sealitaire's card sounds, played the way sealitaire plays them.
--
-- Every event is a row of sfxEvents.csv (tools/wetris-sfx.mjs gathers its
-- files out of sealitaire's bank): takes, one picked at random so a run does
-- not stutter one sample; a gain on top of `sfxVolume`; a delay; the least gap
-- between two plays; and three columns sealitaire spreads across its code:
--
--   ladder   p or h — the take is played at a RUNG of its baked pitch ladder
--            (<take>-p<k>, the knock's; <take>-h<k>, the hover's), k -2..2,
--            chosen by the board: a column, a turn's direction, a depth
--   bus      knock or blip — a REVERB BUS under the dry take, sealitaire's
--            playKnock: the bus family's copy at the same rung through the
--            two neighbouring low-pass cutoffs `busSweep` sits between
--            (knock.luau's equal-power crossfade), at `busSend` x `send`
--   send     this event's share of the bus
--
-- The low-pass on the DRY take is the bank's own (sealitaire's sfxLowpass,
-- printed into every file); the bus's is the sweep. Rive's audio is
-- transport and volume only — the filter and the room are printed, and this
-- only chooses which print and how loud.
--
-- Pure of the board: board.luau names an event, a rung and a level.
-- ============================================================================

local KNOCK = require('knock')
local T = require('tuner').T

local M = {}

type Event = {
    takes: { string },
    gain: number, delay: number, minGap: number,
    ladder: string, bus: string, send: number,
    lastAt: number,
}

export type Sound = {
    context: Context?,
    events: { [string]: Event },
    recent: { AudioSound },     -- one-shots held so they are not collected mid-sound
    told: { [string]: boolean },
}

function M.new(): Sound
    return { context = nil, events = {}, recent = {}, told = {} }
end

-- A csv line into cells, honouring quotes (the notes have commas).
local function cells(line: string): { string }
    local out: { string } = {}
    local cell = ''
    local q = false
    local i = 1
    while i <= #line do
        local c = line:sub(i, i)
        if q then
            if c == '"' then
                if line:sub(i + 1, i + 1) == '"' then
                    cell ..= '"'
                    i += 1
                else
                    q = false
                end
            else
                cell ..= c
            end
        elseif c == '"' then
            q = true
        elseif c == ',' then
            table.insert(out, cell)
            cell = ''
        elseif c ~= '\r' then
            cell ..= c
        end
        i += 1
    end
    table.insert(out, cell)
    return out
end

function M.load(s: Sound, context: Context)
    s.context = context
    local blob = context:blob('sfxEvents')
    if blob == nil then
        print('wetris: sfxEvents.csv missing; no sound')
        return
    end
    local text = buffer.tostring(blob.data)
    local col: { [string]: number } = {}
    local head = true
    for line in text:gmatch('[^\n]+') do
        local row = cells(line)
        if head then
            head = false
            for k, name in row do
                col[name] = k
            end
        else
            local function cell(name: string): string
                local k = col[name]
                return if k ~= nil then (row[k] or '') else ''
            end
            local event = cell('event')
            if event ~= '' then
                local takes: { string } = {}
                for take in cell('takes'):gmatch('[^|]+') do
                    local id: string = take:match('^%s*(.-)%s*$') or ''
                    if id ~= '' then
                        if context:audio(id) ~= nil then
                            table.insert(takes, id)
                        else
                            print(`wetris: sfxEvents.csv: {event}: "{id}" is not in the bank — npm run wetris:sfx`)
                        end
                    end
                end
                s.events[event] = {
                    takes = takes,
                    gain = tonumber(cell('gain')) or 1,
                    delay = tonumber(cell('delay')) or 0,
                    minGap = tonumber(cell('minGap')) or 0,
                    ladder = cell('ladder'),
                    bus = cell('bus'),
                    send = tonumber(cell('send')) or 0,
                    lastAt = -1000,
                }
            end
        end
    end
end

local function voice(s: Sound, src: AudioSource?, vol: number, at: number)
    if src == nil or vol <= 0.001 then
        return
    end
    local ok, snd = pcall(function(): AudioSound?
        return if at > 0 then Audio.playAtTime(src, at) else Audio.play(src)
    end)
    if ok and snd ~= nil then
        snd.volume = vol
        table.insert(s.recent, snd)
        if #s.recent > 24 then
            table.remove(s.recent, 1)
        end
    end
end

-- Play `event` at rung `k` (-2..2; ignored without a ladder), `level` 0..1 on
-- top of its gain, `later` seconds after its own delay.
function M.play(s: Sound, event: string, k: number?, level: number?, later: number?)
    local ctx = s.context
    local ev = s.events[event]
    if ctx == nil or ev == nil or #ev.takes == 0 then
        if ev == nil and ctx ~= nil and not s.told[event] then
            s.told[event] = true
            print(`wetris: sfxEvents.csv has no row "{event}"`)
        end
        return
    end
    local now = Audio.time()
    local extra = later or 0
    if extra <= 0 and ev.minGap > 0 and now - ev.lastAt < ev.minGap then
        return
    end
    ev.lastAt = now
    local rung = math.clamp(math.floor((k or 0) + 0.5), -KNOCK.STEPS, KNOCK.STEPS)
    local take = ev.takes[math.random(1, #ev.takes)]
    local dry: AudioSource? = nil
    if ev.ladder ~= '' then
        dry = ctx:audio(`{take}-{ev.ladder}{rung}`)
    end
    if dry == nil then
        dry = ctx:audio(take)
    end
    local at = if ev.delay + extra > 0 then now + ev.delay + extra else 0
    local gain = T.sfxVolume * ev.gain * (level or 1)
    voice(s, dry, gain, at)
    if ev.bus ~= '' and T.busSend > 0 and ev.send > 0 then
        local lo, hi, wlo, whi = KNOCK.sweep(T.busSweep)
        local family = if ev.bus == 'knock' then 'knockbus' else 'blipbus'
        local send = gain * T.busSend * ev.send
        voice(s, ctx:audio(`{family}-p{rung}-c{lo}`), send * wlo, at)
        if hi ~= lo then
            voice(s, ctx:audio(`{family}-p{rung}-c{hi}`), send * whi, at)
        end
    end
end

return M
