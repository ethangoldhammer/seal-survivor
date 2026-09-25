-- ============================================================================
-- THE SEAL'S STATES, FOR THE WELL — sealitaire's motion.luau shape, which is
-- what puppet.luau (shared, byte for byte) reads. Every state it knows has to
-- be here, including the card-table ones wetris never asks for, because the
-- blender evaluates all of them every frame.
--
-- What the anchors MEAN is wetris's, set by seal.luau when it builds the
-- puppet's Frame:
--
--   'card'    THE STATION: beside the well at the live piece's height,
--             clamped below the hold and queue previews, on whichever side
--             of the well the piece is nearer (with a wide margin, so the
--             seal does not cross the board for every piece)
--   'cursor'  the live piece itself — what the head watches and the fins
--             point at
--   'row'     the station with no piece to follow (paused, game over)
--   'stage'   the open water beside the well, low down: where a line clear
--             is celebrated
--
-- `card.heading` is WRITTEN by seal.luau when the side changes (a small turn
-- in toward the well), which is the one place this table is not constant.
-- Headings are radians, 0 nose up the screen, positive clockwise.
-- ============================================================================

export type Target = { anchor: string, x: number, y: number, out: number }
export type State = {
    land: { anchor: string, x: number, y: number },
    heading: number,
    roll: number,
    look: Target,
    jaw: number,
    behind: number,
}

local states: { [string]: State } = {
    -- No piece: wait at the station, watching the well.
    idle = {
        land = { anchor = 'row', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.4 },
        jaw = 0,
        behind = 0,
    },
    -- A piece is live: hold the station beside it, turned in toward it, the
    -- mouth a little open, the head on the piece.
    card = {
        land = { anchor = 'card', x = 0, y = 0 },
        heading = 0.25,
        roll = -0.12,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.8 },
        jaw = 0.3,
        behind = 0,
    },
    -- Never asked for in wetris (nothing is dragged), kept so the blender has
    -- a pose for every state it evaluates.
    drag = {
        land = { anchor = 'card', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 1 },
        jaw = 0.35,
        behind = 0,
    },
    bite = {
        land = { anchor = 'self', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0 },
        jaw = 1,
        behind = 0,
    },
    release = {
        land = { anchor = 'self', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 1 },
        jaw = 0.5,
        behind = 0,
    },
    -- A line clear: out into the open water and perform (react.luau).
    react = {
        land = { anchor = 'stage', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.8 },
        jaw = 0.5,
        behind = 0,
    },
    win = {
        land = { anchor = 'stage', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.3 },
        jaw = 0.6,
        behind = 0,
    },
}

return states
