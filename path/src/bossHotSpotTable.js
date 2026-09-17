// ============================================================================
// WEAK SPOTS, PER BOSS — bossHotSpots.csv.
//
// WHAT WAS WRONG WITH ONE ANSWER FOR THE WHOLE ROSTER.
//
// Two of the three questions a weak spot has to answer are questions about a
// PARTICULAR ANIMAL, and both were being answered once, globally, from inside
// systems/bossHotSpots.js where nothing that knows anything about one boss can
// reach them:
//
//   WHERE DOES IT GO. The placement heuristic asks "somewhere good on this
//   outline", which is the right question for a body with a lot of outline and
//   the wrong question for one where the answer is a design decision. The
//   mosasaur forced the point first — twelve fitted spheres, exactly one wide
//   enough to carry a spot, so every arrangement the roll could reach was
//   either two spots stacked on one flank or one hanging off a tail bone, and
//   it re-rolled on every arrival so the animal never read the same way twice.
//   Named, it stopped being a failure and became the fight: the longest body in
//   the game, beaten by getting BEHIND it. But that was expressed as a
//   `weakSpot` string on one creature in config.js, which is a mechanism for
//   one animal rather than a place the roster is authored.
//
//   WHAT COLOUR IS IT. The mark stands in for the hide (see the coverage note
//   in systems/bossHotSpots.js), so "which colour reads here" is a fact about
//   that animal's skin. One colour for the orca's near-black flank, the
//   yacht's white hull, the crab's own lit shell and the man o' war's
//   translucent bell is one colour that is a compromise on four bodies.
//
// The third question — how much a spot is WORTH, how much damage ruptures one,
// how long until it relights — is not per animal and stays in behaviour.csv,
// where it is judged over a fight and against the rest of the economy.
//
// ---------------------------------------------------------------------------
// WHY AN ANCHOR IS A PLACE ON THE BODY AND NOT A BONE NAME
//
// The obvious way to say "the crab's claw" is to name the bone. It does not
// work here and the reason is measurable: `npm run audit:hitboxes` reports
// that bossCrab, bossBoat and bossManOWar collide as a CIRCLE by choice —
// `hitShape` is opt-in and those three decline it — so there are no fitted
// spheres on them to name, and systems/bossHotSpots.js builds them a single
// synthetic sphere to stand in. A vocabulary that only works on seven of ten
// bosses is a vocabulary that silently does nothing on the three whose
// placement most needed authoring.
//
// (Bone names also lie. systems/hitShape.js opens with that and fits its
// spheres by binning vertices instead, for the same reason.)
//
// So an anchor is a position in THE ANIMAL'S OWN FRAME:
//
//   along   -1 at the tail end, +1 at the head end, 0 amidships. Measured
//           along `heading`, which is the same forward every other system on
//           the creature reads, so it survives the animal turning. Normalised
//           against the body's OWN measured extent this frame rather than
//           against e.radius — a megalodon is far longer than it is wide, and
//           a fraction of its radius would put "the tail" somewhere near its
//           middle. `tail`, `head` and `mid` are accepted as words.
//   side    `l` or `r` — which flank, in the body's frame. Blank is either,
//           which is what most anchors want: a spot on the snout has no side.
//           `u`/`top`/`back` and `d`/`belly`/`under` name the other axis
//           instead: WORLD up and down, not a flank. The difference matters
//           the moment the animal turns — a flank follows it round and the
//           back does not, so a dorsal spot written `:l` is a belly spot on
//           the way home. Say `back` when you mean the back.
//
// Written `along:side`, several separated by `|`:
//
//   tail              one spot, far end, either flank      (the mosasaur)
//   0.5:l|0.5:r       two, level with each other, one per flank   (the claws)
//   head|-0.3         two, nose and back third, unsided
//   head:u|0:d|tail   three: top of the head, the belly, the tail tip
//
// AN ANCHOR IS A PREFERENCE, NOT A COORDINATE. It orders the candidates the
// perimeter search already found — nearest to the named place first — and the
// caller walks that order taking the first place the mesh and the collision
// hull both agree on. So an anchor that lands on a part of the animal where
// the two surfaces disagree (see `hullMatch`) gets the nearest place where
// they do, rather than a spot whose light and whose crit are in different
// places. It cannot put a spot in open water, and it cannot fail to place one.
//
// ANCHORS SET THE COUNT. A row listing two anchors is a boss with two weak
// spots, every arrival, because "its weak points are its claws" is a sentence
// about how many there are as much as where. `count` is for the rows that want
// a fixed number without naming places; both blank rolls countMin..countMax
// out of behaviour.csv, which is what a boss with no row here does.
//
// ---------------------------------------------------------------------------
// THE COLUMNS
//
//   id          THE BOSS ARCHETYPE from bosses.csv. A join, checked: a row
//               whose id is not an archetype is dropped with a warning,
//               because a typo here is a boss that silently goes back to
//               rolling its spots and nothing on screen says so.
//   enabled     FALSE takes the row out without deleting it — the boss falls
//               back to the rolled placement and the global colour.
//   anchors     where the spots go, above. Blank = roll.
//   count       how many, when `anchors` is blank. Blank = roll.
//   color       what the mark reads as on THIS hide. `#rrggbb` or bare hex.
//               REPLACES the global litColor rather than multiplying it: a
//               multiply cannot brighten, so pure blue over a red default
//               would come out black and the two ways of saying "this boss's
//               spots are blue" would disagree.
//   brightness  a multiplier on the global glow, for a body that needs more or
//               less push than the rest. 1 (or blank) is the roster default.
//   radiusFrac  spot size as a fraction of the boss's own radius, overriding
//               hotSpots.radiusFrac. THIS IS GAMEPLAY AS WELL AS LOOK and it
//               is here anyway: it is the crit's reach, and how big a target
//               an animal offers is a property of that animal. Still clamped
//               by minRadius/maxRadius/hostCap like the global one.
//
// EVERY CELL BUT `id` MAY BE BLANK, and blank means "the roster answer" rather
// than zero — the same contract bossLooks.csv and skins.csv keep.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'bossHotSpots';
const FILE = 'bossHotSpots.csv';

// Words for the two ends and the middle. Not a convenience: "tail" is what a
// designer says, and -1 is what the maths wants, and the whole point of this
// table is that the first of those is the one being written down.
const ALONG_WORDS = { tail: -1, mid: 0, middle: 0, head: 1, nose: 1 };
const SIDES = { l: 1, left: 1, r: -1, right: -1, any: 0, both: 0 };
// THE OTHER AXIS, and it is a DIFFERENT KIND of answer from the two above.
// `l`/`r` are flanks in the body's own frame, so they follow the animal round
// when it turns -- which is right for a claw and wrong for a belly. A seal
// looking at a shark swimming left to right sees its back on top; the same
// shark on the way home has its back on top too, and a flank anchor would have
// swapped. So these resolve against WORLD UP instead of against `heading`.
//
// Kept in the same `side` slot of the grammar rather than bolted on as a third
// field, because a spot is on a flank OR on the back OR on the belly -- naming
// two of those at once is not a place, and a grammar that let you write it
// would need a rule about which wins.
const VERTS = { u: 1, up: 1, top: 1, back: 1, dorsal: 1, d: -1, down: -1, belly: -1, under: -1, ventral: -1 };

export function parseBossHotSpotCsv(text, warn = console.warn) {
  return parseIdTable(text, LABEL, FILE, warn);
}

/**
 * "0.5:l|tail" -> [{ along: 0.5, side: 1, vert: 0 }, { along: -1, side: 0, vert: 0 }].
 * "head:u"      -> [{ along: 1, side: 0, vert: 1 }] -- the top of the head.
 *
 * A malformed anchor is DROPPED with a warning rather than defaulting to 0,
 * because 0 is amidships and is a perfectly plausible place: a typo would
 * quietly move a boss's weak spot to its middle and look like a decision.
 */
export function parseAnchors(raw, id, warn = console.warn) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const out = [];
  for (const part of s.split('|')) {
    const token = part.trim();
    if (!token) continue;
    const [alongRaw, sideRaw = ''] = token.split(':');
    const alongKey = alongRaw.trim().toLowerCase();
    let along = alongKey in ALONG_WORDS ? ALONG_WORDS[alongKey] : Number(alongKey);
    if (!Number.isFinite(along)) {
      warn(`[${LABEL}] "${id}" has anchor "${token}", whose position is neither a number `
        + `nor one of ${Object.keys(ALONG_WORDS).join(', ')} — dropping that anchor.`);
      continue;
    }
    // Clamped rather than refused. Past the ends of the body there is nothing
    // to anchor to, and -1.4 plainly means "the tail" — the order this
    // produces is identical either way, so a refusal would cost a spot to make
    // a point about a number nobody can see.
    along = Math.max(-1, Math.min(1, along));
    const sideKey = sideRaw.trim().toLowerCase();
    const isVert = sideKey in VERTS;
    if (sideKey && !isVert && !(sideKey in SIDES)) {
      warn(`[${LABEL}] "${id}" has anchor "${token}", whose side is not one of `
        + `${[...Object.keys(SIDES), ...Object.keys(VERTS)].join(', ')} — placing it on either flank.`);
    }
    // One or the other, never both -- see the note on VERTS.
    out.push({ along, side: isVert ? 0 : (SIDES[sideKey] ?? 0), vert: isVert ? VERTS[sideKey] : 0 });
  }
  return out.length ? out : null;
}

// Deliberately a twin of bossLookTable.js's parser rather than an import from
// it: the two files are the same shape today and are not the same idea, and
// sharing four lines would tie a weak spot's colour to a change made for a
// perk's paint.
function parseColor(raw, id, field, warn) {
  const s = String(raw ?? '').trim().replace(/^#/, '');
  if (!s) return null;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) {
    warn(`[${LABEL}] "${id}" has ${field} "${raw}", which isn't a 6-digit hex — `
      + 'using the roster colour instead.');
    return null;
  }
  return parseInt(s, 16);
}

function numberOrNull(row, id, field, warn, opts) {
  if (!(field in row)) return null;
  if (String(row[field] ?? '').trim() === '') return null;
  const n = parseNumber(row[field], LABEL, id, field, warn, opts);
  return n == null ? null : n;
}

/**
 * Build the table: { bossId: { id, anchors, count, color, brightness, radiusFrac } }.
 *
 * @param rows        what parseBossHotSpotCsv returned.
 * @param opts.bosses the legal archetype ids from bosses.csv. Handed in rather
 *                    than imported so this module stays a leaf — the same
 *                    argument bossLookTable.js makes.
 *
 * Every rejection is a warning and a dropped row, never a throw. A bad cell in
 * a spreadsheet should cost one boss its authored spots, not the game's boot.
 */
export function buildBossHotSpots(rows, { bosses = null } = {}, warn = console.warn) {
  const out = {};

  for (const [id, row] of rows) {
    if ('enabled' in row && parseBool(row.enabled, LABEL, id, 'enabled', warn) === false) continue;

    if (bosses && !bosses.includes(id)) {
      warn(`[${LABEL}] "${id}" is not an archetype in bosses.csv — the row will never be read. `
        + `Known: ${bosses.join(', ')}.`);
      continue;
    }

    const anchors = parseAnchors(row.anchors, id, warn);
    const count = numberOrNull(row, id, 'count', warn, { min: 1, integer: true });
    const color = parseColor(row.color, id, 'color', warn);
    const brightness = numberOrNull(row, id, 'brightness', warn, { min: 0 });
    const radiusFrac = numberOrNull(row, id, 'radiusFrac', warn, { min: 0.01 });

    // BOTH, AND THEY DISAGREE. Anchors already say how many there are, so a
    // count beside them is a second answer to a question that has one — and
    // the two would be read in whichever order the code happens to check.
    // Named rather than resolved silently, because the author wrote both on
    // purpose and one of them is not going to happen.
    if (anchors && count != null && count !== anchors.length) {
      warn(`[${LABEL}] "${id}" lists ${anchors.length} anchor(s) and a count of ${count}. `
        + 'The anchors decide — clear the count, or drop an anchor.');
    }

    if (!anchors && count == null && color == null && brightness == null && radiusFrac == null) {
      warn(`[${LABEL}] "${id}" sets nothing — the row is enabled but empty, so this boss `
        + 'rolls its spots and wears the roster colour. Set enabled=FALSE if that is deliberate.');
      continue;
    }

    out[id] = { id, anchors, count, color, brightness, radiusFrac };
  }

  return out;
}
