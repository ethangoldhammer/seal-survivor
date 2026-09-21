-- ============================================================================
-- THE SEAL'S STATES — the same shape as path/src/levelUpSealMotion.json, the
-- file the level-up look page writes: a state is a LANDING POINT plus a pose,
-- and the swim rig takes the body there on the run's own physics. Nothing is
-- lerped into place; the states crossfade by weight (puppet.luau) and the
-- blended point is what the animal swims to.
--
--   land      where the body's centre goes: an anchor plus an offset —
--             x in fractions of the screen WIDTH, y in BODY LENGTHS
--             (the row set's `crown` space in the game).
--   anchors   'row'    the middle of the tableau's row, under the columns
--             'stage'  the open water under the columns, where a reaction
--                      is performed (table.luau measures it each frame)
--             'card'   the card being pointed at (hovered, or the one in hand)
--             'corner' the bitten card's corner, while the pointer holds it
--             'self'   the seal's own centre (hold where it is)
--             'cursor' the pointer, when it is over the table
--             'free'   the screen itself (x, y absolute fractions)
--   heading   radians, 0 = nose up the screen; POSITIVE turns the nose
--             clockwise on screen (the game's is the mirror: its authored
--             numbers arrive negated here)
--   roll      radians about the spine
--   look      a target for the head: anchor + offset, `out` 0..1 how far it
--             lifts toward the viewer
--   jaw       0..1, how far the mouth is held open
--   behind    0 or 1, which side of the cards the animal swims on. 0 — the
--             default, and what the table looks like nearly all of the time —
--             is IN FRONT of them: the seal is the thing on the table, not a
--             shape under the glass. 1 sends it under the cards, for a state
--             that wants them in front of it. It blends by state weight like
--             everything else here, but the pass it picks is a discrete one,
--             so the animal changes sides at the halfway point of a crossfade
--             rather than fading through. A bite is unaffected either way:
--             the card goes in the mouth, upper head in front and lower jaw
--             behind, whichever side the body is on (seal.wgsl).
--
-- The idle point bobs (puppet.luau adds CONFIG.levelUpSeal's bob to it), so
-- a seal with nothing to look at still breathes.
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
    -- Nothing pointed at: watch the hand, and LEAN the way it is going. The
    -- anchor is the row pulled part of the way to the pointer (`lean` in
    -- tuning.luau), so moving between cards starts the body easing in that
    -- direction before any card has settled. Hovering a card then commits a
    -- move that was already under way, instead of starting one from a standstill.
    idle = {
        land = { anchor = 'lean', x = 0, y = 0.55 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.6 },
        jaw = 0,
        behind = 0,
    },
    -- A card is hovered: come round below and beside it, nose toward it,
    -- the game's card1 pose with its heading mirrored into this frame.
    card = {
        land = { anchor = 'card', x = -0.11, y = 0.75 },
        heading = 0.17,
        roll = -0.09,
        look = { anchor = 'card', x = 0, y = 0, out = 1 },
        jaw = 0.35,
        behind = 0,
    },
    -- A run is in the hand: shadow it from below, mouth open, the card2 roll.
    drag = {
        land = { anchor = 'card', x = 0.1, y = 0.9 },
        heading = 0.27,
        roll = 0.4,
        look = { anchor = 'card', x = 0, y = 0, out = 1 },
        jaw = 0.35,
        behind = 0,
    },
    -- The pointer is down on a card: the mouth goes to the card's corner
    -- (the anchor is the corner nearest the seal when the press started),
    -- placed so the MOUTH lands on it (the land offset is measured off the
    -- drawn pose), and once there the jaw clamps and the body rides the
    -- card wherever the hand takes it.
    bite = {
        land = { anchor = 'corner', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'corner', x = 0, y = 0, out = 0 },
        jaw = 1, -- wide on the way in; puppet.luau clamps it once the corner is in the mouth
        behind = 0,
    },
    -- Let go: stay put, mouth open, watch the hand, then back to whatever
    -- it is doing. (It used to rise toward the viewer here; that lift is
    -- the reactions' now — a plain release stays on the table.)
    release = {
        land = { anchor = 'self', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 1 },
        jaw = 0.5,
        behind = 0,
    },
    -- A card play landed: go to the open water under the columns and
    -- perform (react.luau adds the choreography on top of this pose).
    react = {
        land = { anchor = 'stage', x = 0, y = 0 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.8 },
        jaw = 0.4,
        behind = 0,
    },
    -- The deal is won: circle the eye of the vortex with the cards.
    win = {
        land = { anchor = 'free', x = 0.5, y = 0.55 },
        heading = 0,
        roll = 0,
        look = { anchor = 'cursor', x = 0, y = 0, out = 0.3 },
        jaw = 0.6,
        behind = 0,
    },
}

return states
