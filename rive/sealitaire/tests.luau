-- Rules tests for klondike.luau. `rive rive/sealitaire --test`.
local K = require('klondike')

return function(): Tests
    return function(test: Tester)
        test.group('deal', function()
            test.case('deals 28 to the tableau and 24 to the stock', function(expect)
                local g = K.new(7)
                local n = 0
                for col = 1, 7 do
                    expect(#g.tableau[col].cards).is(col)
                    n += col
                    expect(g.tableau[col].cards[col].faceUp).is(true)
                    if col > 1 then
                        expect(g.tableau[col].cards[1].faceUp).is(false)
                    end
                end
                expect(n).is(28)
                expect(#g.stock.cards).is(24)
                expect(#g.waste.cards).is(0)
            end)
            test.case('a seed reproduces the same deal', function(expect)
                local a = K.new(1234)
                local b = K.new(1234)
                for col = 1, 7 do
                    expect(a.tableau[col].cards[col].id).is(b.tableau[col].cards[col].id)
                end
                expect(a.stock.cards[1].id).is(b.stock.cards[1].id)
            end)
            test.case('every card appears exactly once', function(expect)
                local g = K.new(99)
                local seen = table.create(52, false)
                local count = 0
                for _, p in ipairs(K.piles(g)) do
                    for _, c in ipairs(p.cards) do
                        expect(seen[c.id]).is(false)
                        seen[c.id] = true
                        count += 1
                    end
                end
                expect(count).is(52)
            end)
        end)

        test.group('stacking', function()
            test.case('tableau wants alternate colour, one lower', function(expect)
                local dest: K.Pile = { kind = 'tableau', index = 1, cards = { { id = 1, suit = 1, rank = 8, faceUp = true } } }
                expect(K.canStackOnTableau({ id = 2, suit = 3, rank = 7, faceUp = true }, dest)).is(true)
                expect(K.canStackOnTableau({ id = 3, suit = 2, rank = 7, faceUp = true }, dest)).is(false)
                expect(K.canStackOnTableau({ id = 4, suit = 3, rank = 6, faceUp = true }, dest)).is(false)
            end)
            test.case('only a king takes an empty column', function(expect)
                local dest: K.Pile = { kind = 'tableau', index = 1, cards = {} }
                expect(K.canStackOnTableau({ id = 1, suit = 1, rank = 13, faceUp = true }, dest)).is(true)
                expect(K.canStackOnTableau({ id = 2, suit = 1, rank = 12, faceUp = true }, dest)).is(false)
            end)
            test.case('foundation builds by suit from the ace', function(expect)
                local dest: K.Pile = { kind = 'foundation', index = 1, cards = {} }
                expect(K.canStackOnFoundation({ id = 1, suit = 4, rank = 1, faceUp = true }, dest)).is(true)
                expect(K.canStackOnFoundation({ id = 2, suit = 4, rank = 2, faceUp = true }, dest)).is(false)
                table.insert(dest.cards, { id = 1, suit = 4, rank = 1, faceUp = true })
                expect(K.canStackOnFoundation({ id = 2, suit = 4, rank = 2, faceUp = true }, dest)).is(true)
                expect(K.canStackOnFoundation({ id = 3, suit = 3, rank = 2, faceUp = true }, dest)).is(false)
            end)
        end)

        test.group('moving', function()
            test.case('a move flips the card it uncovers and scores it', function(expect)
                local g = K.new(5)
                -- Build a legal move by hand: put a red 7 on column 1 (which holds
                -- one face-up card) and a navy 6 as the run on column 2.
                g.tableau[1].cards = { { id = 60, suit = 1, rank = 7, faceUp = true } }
                g.tableau[2].cards = {
                    { id = 61, suit = 2, rank = 3, faceUp = false },
                    { id = 62, suit = 3, rank = 6, faceUp = true },
                }
                local r = K.move(g, g.tableau[2], 2, g.tableau[1])
                expect(r.ok).is(true)
                expect(r.flipped).is(true)
                expect(#g.tableau[1].cards).is(2)
                expect(g.tableau[2].cards[1].faceUp).is(true)
                expect(g.moves).is(1)
                expect(g.score).is(5)
            end)
            test.case('an illegal move changes nothing', function(expect)
                local g = K.new(5)
                g.tableau[1].cards = { { id = 60, suit = 1, rank = 7, faceUp = true } }
                g.tableau[2].cards = { { id = 62, suit = 1, rank = 6, faceUp = true } }
                local r = K.move(g, g.tableau[2], 1, g.tableau[1])
                expect(r.ok).is(false)
                expect(#g.tableau[2].cards).is(1)
                expect(g.moves).is(0)
            end)
            test.case('a face-down run cannot be picked up', function(expect)
                local g = K.new(5)
                expect(K.runFrom(g.tableau[3], 1)).is(nil)
                expect(#(K.runFrom(g.tableau[3], 3) :: { K.Card })).is(1)
            end)
        end)

        test.group('stock', function()
            test.case('draw moves one card face up to the waste', function(expect)
                local g = K.new(8)
                expect(K.draw(g)).is('drew')
                expect(#g.waste.cards).is(1)
                expect(g.waste.cards[1].faceUp).is(true)
                expect(#g.stock.cards).is(23)
            end)
            test.case('an empty stock recycles the waste, face down, in order', function(expect)
                local g = K.new(8)
                for _ = 1, 24 do
                    K.draw(g)
                end
                local lastDrawn = g.waste.cards[24].id
                expect(K.draw(g)).is('recycled')
                expect(#g.stock.cards).is(24)
                expect(#g.waste.cards).is(0)
                expect(g.stock.cards[1].faceUp).is(false)
                -- The last card drawn is the bottom of the new stock.
                expect(g.stock.cards[1].id).is(lastDrawn)
            end)
            test.case('an empty stock and waste is empty', function(expect)
                local g = K.new(8)
                g.stock.cards = {}
                expect(K.draw(g)).is('empty')
            end)
        end)

        test.group('winning', function()
            test.case('four full foundations win', function(expect)
                local g = K.new(3)
                expect(K.isWon(g)).is(false)
                for s = 1, 4 do
                    g.foundations[s].cards = {}
                    for r = 1, 13 do
                        table.insert(g.foundations[s].cards, { id = (s - 1) * 13 + r, suit = s, rank = r, faceUp = true })
                    end
                end
                expect(K.isWon(g)).is(true)
            end)
        end)
    end
end
