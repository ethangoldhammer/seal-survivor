// ============================================================================
// ATTRACTOR STORMS — six candidate bullet-hell attacks, kept in
// attractorStorms.csv.
//
// THE SHAPE AND THE FLOW OF ONE ATTACK, and only that. What makes it a FIGHT —
// the cooldown, the tell, how long it stays open, how close you have to be, and
// damage that rides the difficulty ramp — is bossPerks.csv, and four of these
// six have a row there under the same id. The split is on purpose: `scale` and
// `rate` describe a shape and `cooldown` and `windup` describe an encounter,
// and a table mixing them would be tuned for two questions at once.
//
// Four are perks (`saddle`, `ring`, `echo`, `release`) and roll onto ordinary
// bosses. The two Thomas rows are not: one is a whole arena and one is a body,
// so both are a boss rather than a thing a boss does, and they reach the water
// only through the U panel while they wait for an archetype.
//
// The six are not variations on one attack. They differ on who moves, whether
// the pattern can be read before it arrives, and how much of the fight the
// player can solve by standing in the right place. Each row's `notes` says
// which of those it is.
//
// Columns:
//   id        which study. Code joins to this — see STORM_IDS — so a row
//             naming anything else is refused rather than staged as a storm
//             with no behaviour behind it.
//   enabled   FALSE takes it out of the U panel.
//   shape     thomas | lorenz | aizawa. Which system the cubes fly.
//   plane     WHICH TWO OF THE SYSTEM'S THREE AXES GO ON SCREEN, and it is the
//             most consequential column in the table. Collision in this game is
//             planar everywhere (hypot(dx, dy)), so a three-dimensional
//             attractor has to resolve to two coordinates or the hitbox stops
//             agreeing with the picture. `xz` puts the system's x and z on the
//             world's x and y; `xy` puts its x and y there.
//
//             The third coordinate is not discarded — it is integrated and
//             kept hidden, and it is the thing that makes the motion
//             non-repeating. A two-dimensional slice of these systems is a
//             swirl; the full state projected is a strange attractor.
//
//             It is also a free second attack: `ring` and `release` are the
//             same Aizawa field seen down two different axes, and one is a
//             hollow ring while the other is a shell with a spine.
//   scale     world units per attractor unit. What sizes the pattern against
//             the arena — the arena is 80 wide, so a shape that spans ±11 in
//             its own units wants about 1.5 here to fill it.
//   centre    subtracted from the vertical axis before scaling. THE PICTURE,
//             not the system: Lorenz's attractor lives around z 25, so 25 here
//             is what puts the butterfly on the anchor instead of far above it.
//             The state itself stays canonical, which is why the equations in
//             systems/attractors.js are the textbook ones.
//   body      WHAT THE SHOTS ARE MADE OF — a space-separated list of asset
//             keys, one picked at random per shot. Blank is `attractorCube`,
//             the unit-cube stand-in, which is still the right answer for a
//             study whose motion has not been signed off: a body with any
//             character of its own answers a different question and answers it
//             too flatteringly, because a swirl of beautiful things looks good
//             long before it plays well.
//
//             A LIST rather than one key because variety is the point where a
//             study has graduated to a real look — `echo` fires a shoal, and a
//             shoal of one repeated fish is a texture rather than a shoal. Each
//             shot rolls independently.
//
//             The keys are checked against the asset table when the storm is
//             armed, not here — this file cannot import assets.js without
//             pulling the whole model layer into a parser. See resolveBodies in
//             systems/attractorStorm.js, which drops an unknown key with a
//             warning and falls back to the cube rather than spawning nothing.
//
//             SIZE IS NOT IN THIS COLUMN AND MUST NOT BE. Every body is scaled
//             so its long axis is exactly the row's `radius` doubled, whatever
//             the model's own `fit` — a bullet hell has to be honest about how
//             big its shots are or it reads as unfair rather than as hard, and
//             that promise cannot survive a per-asset size knob.
//   tilt      how far the body is canted out of the screen plane, in radians.
//             Blank is 0.55, which is what makes the cube read as a cube.
//
//             The camera looks straight down -z, so a body whose long axis lies
//             in the screen plane presents the same profile for its whole
//             flight — and for a cylinder (the money rolls) that profile is a
//             rectangle at every angle. A cant brings the end into view. A FISH
//             wants roughly zero: it is already legible side-on, and canting it
//             turns a shoal into a set of foreshortened slivers.
//   param     the system's own constant, where a row wants to move it: thomasB
//             for a thomas row, unused by the other two. Blank is the value in
//             systems/attractors.js.
//   rate      attractor time units per second. The speed dial — it changes how
//             fast the shape is traversed without changing the shape.
//   speedCap  the fastest a cube may travel, in world units a second. NOT
//             cosmetic: Lorenz runs about forty times faster at a wing rim than
//             at the saddle, so unclamped the slow regions become a stationary
//             wall of cubes and the fast ones cross the arena inside a frame.
//             The clamp shortens the integration step rather than the move, so
//             the path is preserved exactly and only its timing changes.
//   count     how many cubes it keeps in the water. On `echo` this is the PAIR
//             total, so it is half as many events as the number looks like.
//   damage    per cube, on contact. One hit, then the cube is spent — the same
//             door every other enemy shot goes through.
//   life      seconds a cube lives before it expires.
//   radius    the cube's hit radius in world units.
//   mode      field | ring | echo | swarm | release — see MODE_IDS below and
//             systems/attractorStorm.js for what each one does.
//   period    seconds between the mode's own event: the lattice slide, the
//             swarm's breath, one full draw-and-fire of a release. Blank means
//             the mode has no event.
//   reach     world units a second the anchor walks toward the seal. Blank is
//             an anchored storm, which is all of them but `ring`.
//
// These are GAMEPLAY numbers, so they live here and not on a slider — the same
// rule weapons.csv and bossPerks.csv follow.
// ============================================================================

import { parseIdTable, parseBool, parseNumber } from './csvTable.js';

const LABEL = 'attractorStorms';
const FILE = 'attractorStorms.csv';

/** The studies systems/attractorStorm.js implements. */
export const STORM_IDS = ['lattice', 'saddle', 'ring', 'echo', 'swarm', 'release'];

/** The systems systems/attractors.js implements. */
export const SHAPE_IDS = ['thomas', 'lorenz', 'aizawa'];

/** Which pair of the attractor's own axes lands on the world's x/y. */
export const PLANE_IDS = ['xz', 'xy'];

/** What a storm DOES, beyond flying its field. */
export const MODE_IDS = ['field', 'ring', 'echo', 'swarm', 'release'];

// Every numeric column and the floor it may reach. Data rather than a wall of
// ifs, so the parser cannot drift from the doc comment above.
const NUMBERS = {
  scale: { min: 0.001 },
  centre: {},
  param: {},
  rate: { min: 0.001 },
  speedCap: { min: 0.1 },
  count: { min: 0, integer: true },
  damage: { min: 0 },
  life: { min: 0.1 },
  radius: { min: 0.01 },
  period: { min: 0 },
  reach: { min: 0 },
  tilt: {},
};

// The three columns that name something code has to recognise. A typo in any
// of them is a storm that stages and then does nothing, or does the wrong
// thing quietly — so each is checked against its list and the row is dropped
// with a reason rather than passed through.
const NAMED = [
  ['shape', SHAPE_IDS, 'a system systems/attractors.js implements'],
  ['plane', PLANE_IDS, 'a pair of axes the projection knows'],
  ['mode', MODE_IDS, 'a mode systems/attractorStorm.js implements'],
];

/** Parse the table into an array of storms, in file order. */
export function parseAttractorStormCsv(text, warn = console.warn) {
  const rows = parseIdTable(text, LABEL, FILE, warn);
  const out = [];

  for (const [id, row] of rows) {
    if (!STORM_IDS.includes(id)) {
      warn(`[${LABEL}] "${id}" is not a study the game implements (${STORM_IDS.join(', ')}) — `
        + 'the row is being ignored, because a storm with no code behind it would '
        + 'stage successfully and then put nothing in the water.');
      continue;
    }
    if (!parseBool(row.enabled, LABEL, id, 'enabled', warn)) continue;

    const storm = { id };
    let bad = false;
    for (const [field, ids, what] of NAMED) {
      const v = (row[field] ?? '').trim().toLowerCase();
      if (!ids.includes(v)) {
        warn(`[${LABEL}] "${id}" names ${field} "${v || '(blank)'}", which is not ${what} `
          + `(${ids.join(', ')}) — the row is being dropped.`);
        bad = true;
        break;
      }
      storm[field] = v;
    }
    if (bad) continue;

    for (const [field, opts] of Object.entries(NUMBERS)) {
      const v = parseNumber(row[field], LABEL, id, field, warn, opts);
      // Left undefined rather than defaulted to 0. A blank cell means "this
      // study does not use this number", and 0 is a real value for several of
      // them — `centre` 0 is a shape already on the anchor, `period` 0 would be
      // an event every frame. The system supplies its own fallback for each.
      if (v != null) storm[field] = v;
    }
    // Carried through rather than dropped as documentation. The U panel prints
    // it under the chips: six candidate designs is more than anyone holds in
    // their head between sessions, and what separates them is exactly the thing
    // being judged.
    // The body list, split and carried as strings. NOT validated here — see
    // the column note above: this file is a parser and cannot reach the asset
    // table. An empty list is left undefined so the system's own fallback (the
    // cube) is the single place that default lives.
    const body = String(row.body ?? '').trim().split(/\s+/).filter(Boolean);
    if (body.length) storm.body = body;
    if (row.notes) storm.notes = String(row.notes).trim();
    out.push(storm);
  }

  if (!out.length) {
    warn(`[${LABEL}] ${FILE} has no usable rows — the U panel will have nothing to stage.`);
  }
  return out;
}
