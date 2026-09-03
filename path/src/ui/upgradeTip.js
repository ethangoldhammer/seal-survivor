// THE UPGRADE TIP — one answer to "what is this thing", wherever a hexagon is.
//
// Four surfaces in the game draw an upgrade as a hexagon and, until now, three
// of them drew it as a hexagon and NOTHING ELSE:
//
//   the level-up cards      name + desc on the face, and a measured one-liner
//                           under it (the tooltip this module grew out of)
//   the boss-dividend hive  bare icons. You are asked which of the things you
//                           already hold should get another stack, and shown
//                           no numbers about any of them.
//   the corner hive         bare icons, all run.
//   the end-of-run hive     bare icons, on the one screen that exists to tell
//                           you what the run was.
//
// So the tip is written once, here, and the surfaces differ only in where the
// box lands. That is not tidiness — it is the only arrangement in which the
// answer to "what does +1 do" cannot be different on two screens, which is the
// specific way four separate tooltips would have failed.
//
// EVERY NUMBER IS MEASURED OR RECORDED. Nothing in this file types a quantity:
//
//   what the next stack does   measure(def, owned + 1)   — replays apply()
//   where you already are      measureTotal(def, owned)  — replays it owned times
//   what it has done this run  playtest.runTotals()      — the live ledger
//
// which means a card retuned in config.js updates its own tip, and an ability
// that is quietly doing nothing says so in the corner instead of in a report
// nobody runs. See upgradeText.js for the measurement and systems/playtest.js
// for the ledger.
//
// NO PER-FRAME WORK, AND NO WORK AT ALL WHILE NOTHING IS HOVERED. The tip node
// is created on the first hover of the session and moved thereafter; the
// content is built on the hover, not on a timer. A tip left open while the
// ledger moves underneath it goes stale by design — it is a snapshot of the
// moment you pointed at the thing, and re-reading the ledger every frame to
// keep a number ticking would be per-frame work on a HUD that has none.
import { CONFIG } from '../config.js';
import {
  measure, measureTotal, phrase, phraseAll, sentenceCase, expandDesc, STAT_TEXT,
} from '../upgradeText.js';
import { baseStats } from '../stats.js';
import { player, statsWithOneMore } from '../entities/player.js';
import { levelChanges, levelValues } from '../levelStats.js';
import { runTotals, stacksHeld } from '../systems/playtest.js';
import { sourceForUpgrade, sourceLabel } from '../systems/playtestAnalysis.js';
import { settings } from '../systems/settings.js';
import { uiText } from '../uiTextTable.js';

// ---------------------------------------------------------------------------
// THE WORDS THAT ARE NOT MEASUREMENTS
//
// Everything else in a tip is either Ethan's copy out of upgrades.csv or a
// number out of a measurement. These eight are the tip's own chrome — the
// labels that say what each row IS — and they are lines somebody has to write,
// so they live in a table like every other line somebody has to write:
// uiText.csv, with the brief for each one in its `notes` cell. They were
// string constants here until the editor's "needs your words" chip could not
// see them, which is how a staged label stays staged.
// ---------------------------------------------------------------------------
const TIP_COPY = {
  next: uiText('tipNext'),      // the row headed "what the stack you would take does"
  total: uiText('tipTotal'),    // the row headed "what the stacks you hold add up to"
  run: uiText('tipRun'),        // the row headed "what it has actually done"
  dealt: uiText('tipDealt'),    // unit after a damage figure
  kills: uiText('tipKills'),    // unit after a kill count
  fired: uiText('tipFired'),    // unit after a count of times a control ability went off
  capped: uiText('tipCapped'),  // shown instead of the "next" row when a stack is at its cap
  quiet: uiText('tipQuiet'),    // shown in the "this run" row when the ledger has a zero
};

/** How much a tip may say. 'off' | 'short' | 'full'. */
export function tipVerbosity() {
  return settings?.hud?.upgradeTips ?? 'full';
}

/** The upgrade row for an id, or null. */
export function upgradeDef(id) {
  return CONFIG.upgrades?.find((u) => u.id === id) ?? null;
}

// A big number, short. 412100 is "412.1k", because a tip is read at a glance
// and eight digits of hp is not a glance.
//
// EXPORTED AND USED BY ui.js, which had its own copy. Two formatters would
// drift the first time either was touched, and the drift would show up as the
// ledger and the tip beside it quoting the same run differently — which reads
// as one of them being wrong about the run rather than about rounding.
export function compactDamage(n) {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v < 1000) return String(v);
  if (v < 100000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1e6) return `${Math.round(v / 1000)}k`;
  return `${(v / 1e6).toFixed(1)}M`;
}

// WHAT THIS UPGRADE HAS ACTUALLY DONE, as a phrase, or '' when the ledger has
// nothing to say about it.
//
// THREE ANSWERS, because there are three kinds of card and giving them all the
// same one is how a table ends up ranking an aura as dead weight:
//
//   a weapon    damage and kills. The ledger books both by source.
//   a control   times it went off. Baby Beluga, Dumbo, the Grabber and Cold
//               Snap deal literally no damage — their entire output is an
//               event, and a damage figure for them is a zero that reads as
//               a broken tooltip rather than as a design.
//   a stat card nothing. Yoga and Iron Lung have no tag in the ledger at all
//               because they make OTHER things better; their dynamic number is
//               the running total, which is a different row.
//
// THE LABEL NAMES THE LINE, NOT THE CARD, and that is load-bearing. `gun` is
// the whole pebble volley — five cards book their work under one tag — so
// hovering Rapid Fire quotes what FIN PEBBLES has done, said out loud, rather
// than implying five cards each did all of it. sourceForUpgrade's comment has
// the rest.
export function runLine(id, totals = runTotals()) {
  const source = sourceForUpgrade(id);
  if (!source) return '';

  const damage = totals.dealtBySource?.[source] ?? 0;
  const kills = totals.killsBySource?.[source] ?? 0;
  const events = totals.controlEvents?.[source] ?? 0;

  const parts = [];
  if (damage > 0) parts.push(`${compactDamage(damage)} ${TIP_COPY.dealt}`);
  if (kills > 0) parts.push(`${kills} ${TIP_COPY.kills}`);
  // Both halves for the one upgrade that does both — Bakalar's net hauls and
  // its bomb explodes, and one pick paid for the pair.
  if (events > 0) parts.push(`${events} ${TIP_COPY.fired}`);

  // A ZERO IS A FACT, AND IT IS SAID OUT LOUD. Returning '' here would drop the
  // row, and a missing row reads as "this tip doesn't have that information" —
  // when what is true is "you have been carrying this for nine minutes and it
  // has done nothing", which is the single most useful thing the ledger knows.
  // Only a card with no tag at all (above) gets no row.
  if (!parts.length) return TIP_COPY.quiet;

  // Named so five cards do not each claim the volley's total. Named on EVERY
  // row and not only on the shared ones, because a label that appears on some
  // tips and not others reads as decoration rather than as the answer to "whose
  // number is this" — and the player cannot know which sources are shared.
  return `${sourceLabel(source)}: ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// AND WHERE THAT PUTS YOU
// ---------------------------------------------------------------------------
//
// The `next` row's second half: the delta, and then the number the FIGHT
// actually uses once you have taken it.
//
// EVERY SOURCE, NOT JUST THIS CARD, which is the whole reason it goes through
// entities/player.js rather than through another measure(). A fire rate card
// says "+25%"; what a player wants to know before spending the pick is what
// their fire rate becomes, and that is the base, plus this card's stacks, plus
// Clone Warz and Iron Lung and the level growth, all folded in. measure()
// replays one apply() against a synthetic seed and can never see any of that;
// computeStats is the pipeline the run itself uses.
//
// TWO SHAPES, chosen off the stat's own row in statText.csv:
//
//   a ratio stat   as a MULTIPLE of the base value — "x1.11 -> x1.38". Three
//                  stats in the game carry `lower` (fire rate, charge speed,
//                  ricochet fire rate) and their raw block value is a DELAY in
//                  seconds, so it falls as the stat improves: printed raw,
//                  "0.36 -> 0.29" reads as a downgrade beside a phrase that
//                  says +25%. Every multiplied stat gets the same treatment,
//                  because a scalar seeded at 1.0 means nothing on its own.
//   anything else  the raw value, with the unit statText gives it — "6 -> 7"
//                  orbiting shrimp, "150 -> 180" max oxygen. These are counts
//                  and quantities and they are what the player would have
//                  counted themselves.
//
// SYMBOLS AND NUMBERS ONLY. No word here is copy, deliberately: the arrow and
// the multiplication sign carry the whole meaning, so this needed nothing
// staged and nothing waiting on Ethan.
const ARROW = '\u2192';
const TIMES = '\u00d7';
// Between the delta and the span. The same middle dot the run row joins its
// facts with, so one tip has one way of saying "and".
const SPAN_SEP = '\u00b7';

function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

/**
 * "6 → 7" or "×1.11 → ×1.38" for one measured change, or '' when the live
 * block cannot answer.
 *
 * @param change  one entry from measure()
 * @param now     the live stat block
 * @param after   the block with one more of this card in it
 */
export function effectiveSpan(change, now, after) {
  const key = change?.stat;
  const a = now?.[key];
  const b = after?.[key];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  // Nothing moved. A span with the same number on both sides is not a fact
  // about the pick, it is a row saying "no change" in the loudest position on
  // the tip — which happens on a stat another card has already capped.
  if (fmt(a) === fmt(b)) return '';

  const t = STAT_TEXT[key] ?? {};
  const ratioed = t.lower === true || change.how === 'mul';
  if (ratioed) {
    const base = baseStats()[key];
    if (!Number.isFinite(base) || base === 0) return '';
    // `lower` inverts the fraction, so a delay of 0.36s against a base of 0.4
    // reads as x1.11 rather than as x0.9. Same rule pct() follows for the
    // phrase this sits beside, so the two halves of the row agree about which
    // direction is up.
    const mul = (v) => (t.lower ? base / v : v / base);
    return `${TIMES}${fmt(mul(a))} ${ARROW} ${TIMES}${fmt(mul(b))}`;
  }
  const unit = t.unit ?? '';
  return `${fmt(a)}${unit} ${ARROW} ${fmt(b)}${unit}`;
}

/**
 * The change the phrase LEADS with — the one the span should describe.
 *
 * DERIVED FROM THE RENDERED STRING rather than by re-implementing phraseAll's
 * filter and sort. That function drops bare level changes, keeps unlocks, and
 * sorts unlocks to the front; a copy of those rules here would be a second
 * implementation that has to agree forever, and when it stopped agreeing the
 * symptom would be a span describing a stat that is not the one the sentence
 * opens with. Asking which phrase the output actually starts with cannot drift.
 *
 * ONE STAT AND NOT ALL OF THEM. Bouncing Baby Guppies moves four; a span for
 * each would treble the tallest tip in the game to answer a question nobody
 * asked four times. The one the sentence opens with is the one the card is
 * about.
 */
function leadChange(changes, full, stack) {
  if (!full) return null;
  return changes.find((c) => full.startsWith(phrase(c, stack))) ?? changes[0] ?? null;
}

// The cap on this upgrade, or 0 for "no cap". upgrades.csv spells a missing
// maxStacks as blank, which parses to 0 — treated as uncapped, which is what
// every card without the column means.
function maxStacks(def) {
  const n = Number(def?.maxStacks ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * EVERYTHING A TIP SAYS, as data. No DOM, so it is testable in Node — which is
 * the whole reason the content and the box are separate functions.
 *
 * @param upgrade  the def out of CONFIG.upgrades (or an id — resolved here)
 * @param owned    stacks already held. 0 for a card never taken; the level-up
 *                 screen passes nextStack - 1, the hive passes its tile count.
 * @param verbosity  'off' | 'short' | 'full'. Defaults to the player's setting.
 * @param totals   the ledger snapshot, injectable for the test.
 * @param rarity   the tier the hypothetical next pick would arrive at. The
 *                 level-up screen knows it — the card has been dealt — and a
 *                 hexagon in the hive does not; null lands on the base tier.
 * @param liveStats / afterStats  the two stat blocks the span is measured
 *                 between. Injectable for the same reason `totals` is: a Node
 *                 harness has no run, and the alternative is a test that can
 *                 only ever assert the empty case.
 * @returns {{name, stacks, desc, rows: Array<{key, label, text}>}|null}
 *          null when there is nothing to show — verbosity off, or an id that
 *          is not an upgrade. A caller treats null as "no tip", never as a
 *          reason to draw an empty box.
 */
export function upgradeTipContent(upgrade, {
  owned = null,
  verbosity = tipVerbosity(),
  totals = null,
  rarity = null,
  liveStats = null,
  afterStats = null,
  // THE RUN IS OVER. Set by the score screen's two hive surfaces, where there
  // is no next pick to describe — see the branch below.
  final = false,
} = {}) {
  if (verbosity === 'off') return null;
  const def = typeof upgrade === 'string' ? upgradeDef(upgrade) : upgrade;
  if (!def?.id) return null;

  // `owned` not passed means "ask the run" — which is what the corner hive and
  // the end-of-run snapshot want, and what keeps them from having to thread a
  // count through three call sites. The level-up screen passes its own, because
  // the number it needs is the stack the card in front of you would be.
  const held = owned == null ? stacksHeld(def.id) : Math.max(0, owned);
  const next = held + 1;
  const cap = maxStacks(def);
  const atCap = cap > 0 && held >= cap;

  const rows = [];

  // THE TWO STAT BLOCKS, resolved first because three separate things below
  // need them: what a level buys, where that puts you, and whether the running
  // total is worth a row of its own.
  //
  // `live` is the run as it stands and `after` is the run with this pick in it.
  // Injectable for the tests and for the look page, which have no run; null
  // falls back to the live player, and an EMPTY block (the state before any run
  // has started) reads as no run rather than as a run with no stats.
  const live = liveStats ?? (player?.stats && Object.keys(player.stats).length ? player.stats : null);
  const after = afterStats ?? (live ? statsWithOneMore(def.id, rarity) : null);

  // --- WHAT THE NEXT ONE DOES ---------------------------------------------
  // The stack you would be TAKING, measured. `next` and not 1: the third Coiled
  // Spring is not the first, and a tip that quoted stack one on a card you hold
  // two of would be wrong in exactly the direction that flatters the card.
  // MEASURED EVEN AT THE CAP, and that is not waste. The row does not use it —
  // there is no next stack to describe — but the DESC still does: 49 of the 51
  // descs are {effect}, and expandDesc happily expands a capped card's to the
  // stack after the last one. Without the phrase in hand to cut out, a maxed
  // Yoga reads "Breathe deeper, Seal. +30 max oxygen" directly above a row
  // saying there is no next one, which is the card promising something it can
  // never hand over. See withoutPhrase at the bottom of this function.
  // --- WHAT THE LEVEL ACTUALLY BUYS ---------------------------------------
  //
  // measure() replays apply() and reports the STAT BLOCK, which for half the
  // roster is one number: `+1 bakalar level`. True, and it tells a player
  // nothing about the thing they are being offered — the bomb's damage, how
  // wide it goes off, how deep the net hangs and how often the boat comes round
  // are all derived from that level inside systems/bakalar.js, where no
  // measurement could reach them.
  //
  // levelChanges asks the ability itself, at the level held and the level after
  // the pick, and returns the difference in measure()'s own shape — so it goes
  // straight into phraseAll and comes back wearing the game's wording, units
  // and lower-is-better handling, with nothing new to maintain here.
  //
  // THE STAT BLOCKS GO WITH THEIR LEVELS. Big Rigz multiplies the bomb and
  // Splash Zone widens the blast, so "one more level" measured against today's
  // block on both sides would quietly under-report a pick taken alongside
  // either. Each side is measured against the block it belongs to — which is
  // why both are resolved at the top of this function rather than here.
  //
  // FALLS BACK, ALWAYS. An ability with no readout — most of them, for now —
  // gets the bare level phrase it has always had. See LEVEL_STATS.
  // ON THE SCORE SCREEN, NOTHING IS COMING NEXT.
  //
  // Every other surface that shows a hexagon is asking "should I take another
  // one of these" — the corner hive mid-run, the boss dividend, the level-up
  // cards. The score screen is asking the opposite question: the run is over
  // and the build is finished, so "+22 bomb damage if you take a ninth" is an
  // offer nobody can accept, printed over the one screen that exists to say
  // what the run WAS.
  //
  // So the table becomes a readout of where each quantity finished, and the
  // rows below that would price a next pick — the cap notice, the lead span —
  // are skipped with it.
  const derived = final
    ? levelValues(def.id, held, live ?? {})
    : (atCap ? null
      : levelChanges(def.id, held, next, live ?? {}, after ?? live ?? {}, cap));

  // ONE ROW PER QUANTITY, not one comma-run of six.
  //
  // The question this whole readout exists to answer is "what does going from
  // one to two actually mean", and the answer for the boat is six numbers in
  // three different systems. Joined into a sentence they came out as four
  // wrapped lines of commas that nobody reads to the end of — the shape of a
  // paragraph, for something that is a spec sheet.
  //
  // So a levelled ability gets a small table: the quantity's own name in the
  // label column the tip already has, and the change beside it. THE LABEL
  // COLUMN CHANGES VOCABULARY when it does — NEXT / NOW / THIS RUN give way to
  // bomb damage / blast radius / net depth — and that is deliberate rather than
  // a slip: on these cards the interesting thing is WHICH numbers move, so the
  // labels should be those numbers' names. The grid sizes itself to whichever
  // set is in it (see renderTipInto), so nothing has to be told which mode it
  // is in.
  //
  // NO `next` ROW AND NO `total` ROW alongside it. Both would be restating the
  // table: "+1 bakalar level" is the fact this replaces, and the running total
  // is the left-hand side of every span already printed here.
  // FOUR ROWS, IN THE ORDER THE READOUT DECLARES THEM.
  //
  // Harp Seal moves seven things and the boat six; six is already a tall box on
  // a phone held in one hand, and it is a hold-to-read surface — the thumb
  // covers part of it. So the tip takes the first four.
  //
  // THE ORDER IS AUTHORED, not sorted. "Biggest mover" is not a thing that can
  // be computed across a duration, a radius and a damage figure — they have no
  // common scale, and a percentage of each is a ranking of how finely each was
  // tuned rather than of what matters. Each readout in levelStats.js returns
  // its quantities in the order that ability should be read in, and this takes
  // the top of that list. Reordering a card is reordering that object.
  //
  // FLAT ROWS GO LAST whatever their place in the list: a quantity that is not
  // moving on this pick has not earned a slot ahead of one that is, and on a
  // card at the cap it would otherwise push a real number off the bottom.
  const MAX_ROWS = 4;
  let nextRow = null;
  if (derived?.length) {
    const moving = derived.filter((c) => c.how !== 'none');
    const flat = derived.filter((c) => c.how === 'none');
    for (const c of [...moving, ...flat].slice(0, MAX_ROWS)) {
      const t = STAT_TEXT[c.stat] ?? {};
      // The delta in the game's own wording, with the LABEL taken off the
      // front — it is in the label column now, and printed twice it reads as
      // a stutter. phrase() puts it last in every shape, so this is a suffix.
      // A FLAT ROW HAS NO DELTA TO PRINT. phrase() would render `how: 'none'`
      // through its "other" branch as "label from -> to" with the same number
      // twice; what it means is "this one is not moving on this pick", and the
      // span beside it already says where it stands.
      let delta = '';
      // `none` has nothing to say and `unlock` has no before to subtract from;
      // both are span-only rows.
      if (c.how !== 'none' && c.how !== 'unlock' && c.how !== 'held') {
        const said = phrase(c, next);
        const lbl = t.label ?? c.stat;
        delta = said.endsWith(lbl) ? said.slice(0, -lbl.length).trim() : said;
      }
      const label = t.label ?? c.stat;
      // THE SPAN COMES OFF THE CHANGE, not out of the stat block. These
      // quantities are not stat-block keys — `bakalarBombDamage` exists
      // nowhere in the block; it is derived from a level — so effectiveSpan,
      // which looks the stat up in the two blocks, finds nothing and quietly
      // returns ''. levelChanges already carries both endpoints, measured
      // against the right block on each side, so they are simply printed.
      // SHORT DROPS THE SPAN HERE TOO, and this is a correction rather than a
      // refinement: the setting's whole promise is that Short is the question
      // at the moment of a pick with the reading dropped, and a table that
      // carried "6 -> 7" on every row at Short was quietly the Full tip minus a
      // couple of rows. A FLAT row is span-only by nature — it has no delta to
      // print — so at Short it has nothing to say and does not appear.
      // FORMATTED THE WAY THE DELTA IS. A `percentOfOne` stat renders its step
      // as "+6%" — the column exists because 0.06 of a creature's speed means
      // nothing as a bare decimal — and a span beside it reading "0.26 -> 0.32"
      // put both conventions in one row. The unit rides along for the same
      // reason: "2.8m -> 3.2m", not "2.8 -> 3.2" beside "+0.4m".
      const asPct = t.percentOfOne === true;
      const at = (v) => (asPct
        ? `${fmt(v * 100)}%`
        : `${fmt(v)}${t.unit ?? ''}`);
      // AN UNLOCK PRINTS THE VALUE ALONE, at both verbosities. A card you do
      // not already hold is offering the whole ability, so there is no before
      // to arrow from and nothing to subtract — what it does IS the answer.
      // Short keeps it for the same reason it drops the others' spans: without
      // it a first-pick card would have no rows at all, which is the state this
      // whole branch was added to fix.
      const span = (c.how === 'unlock' || c.how === 'held')
        ? at(c.to)
        : (verbosity === 'short' ? '' : `${at(c.from)} ${ARROW} ${at(c.to)}`);
      if (!delta && !span) continue;
      rows.push({
        key: `lv:${c.stat}`,
        label,
        flat: c.how === 'none',
        text: delta && span ? `${delta} ${SPAN_SEP} ${span}` : (delta || span),
      });
    }
  } else if (!final) {
    // A card with no readout, mid-run: the measured next stack, as always. On a
    // FINISHED run this whole branch is skipped — the running total below is
    // what that card is worth now, and a "next stack" line beside it would be
    // pricing a pick the run can no longer make.
    const changes = measure(def, next);
    const step = phraseAll(changes, next);
    nextRow = atCap
      ? { key: 'next', label: TIP_COPY.next, text: TIP_COPY.capped }
      : (step ? { key: 'next', label: TIP_COPY.next, text: sentenceCase(step) } : null);
    if (nextRow) rows.push(nextRow);
  }
  const changes = derived?.length ? derived : measure(def, next);
  const step = derived?.length ? '' : phraseAll(changes, next);

  // SHORT IS THE DELTA ALONE. The span below is the reading half — "and where
  // does that put me" is the question you ask when you are studying a build,
  // not the one you ask with three cards on screen and a fight paused behind
  // them. It is the whole reason the setting has a middle rung.
  if (verbosity === 'short') {
    return { name: def.name ?? def.id, stacks: held, desc: '', rows };
  }

  // --- AND WHERE THAT PUTS YOU --------------------------------------------
  // Appended to the delta rather than given a row of its own: they are one
  // answer — this much more, landing there — and split across two headings the
  // reader has to join them back up.
  // The lead span belongs to the single `next` row. A levelled readout already
  // carries a span on every row of its table, so there is nothing here to lead.
  const lead = nextRow && !atCap && !derived?.length ? leadChange(changes, step, next) : null;
  let solo = null;
  if (lead && live) {
    const span = after ? effectiveSpan(lead, live, after) : '';
    if (span) nextRow.text = `${nextRow.text} ${SPAN_SEP} ${span}`;
    // Kept for the NOW row's own question below — see there.
    solo = lead.stat;
  }

  // --- WHERE YOU ALREADY ARE ----------------------------------------------
  // Only once something is held: on a card you have never taken the total IS
  // the next stack, and a tip that says the same sentence twice under two
  // different headings teaches the player that the headings mean nothing.
  if (held >= 1 && !derived?.length) {
    const totals = measureTotal(def, held);
    const sum = sentenceCase(phraseAll(totals, held));
    // ONLY WHEN IT ADDS SOMETHING, and there are two ways it does not.
    //
    // THE SAME SENTENCE TWICE. On a linear stat card at ONE stack the
    // arithmetic makes them identical — the second Supa Dupa Seal is +25% fire
    // rate, and one stack of it totals +25% fire rate — so the box prints the
    // same line under two headings that promise two facts. Both are true;
    // showing them together reads as a bug rather than as a coincidence. From
    // the second stack on they diverge (+25% against +57.8%) and it comes back.
    //
    // NOTHING ELSE TOUCHES THE STAT. This row's question is "what has THIS card
    // given me", which is only worth asking when something else has given you
    // some of it too. On Shrimp Ring nothing else grants orbiting shrimp, so
    // the card's total and the live figure in the span above are the same
    // number, printed twice, four pixels apart. Measured rather than assumed:
    // the card is replayed alone from a fresh seal, and if that lands exactly
    // where the live block is, the card is the only thing there.
    const alone = solo ? totals.find((c) => c.stat === solo) : null;
    const soleSource = alone != null && live != null
      && Math.abs((alone.to ?? NaN) - live[solo]) < Math.abs(live[solo] || 1) * 1e-9;

    // EXCEPT WHEN THE TOTAL IS THE UNLOCK SENTENCE, which is not a number and
    // cannot be duplicated by one.
    //
    // phraseAll renders a 0 -> 1 level change as the ability's own description
    // out of statText.csv — "3 orca buddies who will attack yachts and other
    // orca opps." — and on a card whose desc is pure flavour ("Boaterhaters")
    // that sentence is the ONLY place in the game that says what the thing
    // does. The sole-source rule above was written about a repeated FIGURE and
    // would have quietly eaten it: the orca family is of course the only source
    // of orca family levels.
    //
    // `to === 1` AS WELL AS `from === 0`, which is phrase()'s own condition and
    // not a near-enough version of it. Asking only whether the stat HAS an
    // unlock kept the row on every level card at every depth — a two-stack
    // Octopus Grabber showed "+2 octopus grabber levels" under NOW while the
    // row above already said 2 -> 3, because octoGrabLevel does start at zero
    // and does have an unlock, just not one phraseAll is using at this depth.
    // The exemption has to be for the sentence actually rendered.
    const unlocks = totals.some((c) => c.from === 0 && c.to === 1 && STAT_TEXT[c.stat]?.unlock);
    if (sum && sum !== nextRow?.text && (!soleSource || unlocks)) {
      rows.push({ key: 'total', label: TIP_COPY.total, text: sum });
    }
  }

  // --- WHAT IT HAS DONE ----------------------------------------------------
  // Held only. An upgrade you do not own has done nothing by definition, and
  // the row would be a zero that says something about the card rather than
  // about the run.
  if (held >= 1) {
    const line = runLine(def.id, totals ?? runTotals());
    if (line) rows.push({ key: 'run', label: TIP_COPY.run, text: line });
  }

  // `desc` is Ethan's, out of upgrades.csv, and it goes through expandDesc so a
  // {effect} written there resolves the same way it does on a card. `warn` is
  // deliberately null: cardDesc already warns about an unknown placeholder once
  // per deal, and warning again per hover would print the same line forty times
  // while somebody read their build.
  // ...EXCEPT WHERE THE TABLE ABOVE HAS ALREADY REPLACED IT. 49 of the 51
  // descs are `{effect}`, and on a levelled card that expands to the one line
  // this whole readout exists to get rid of — "+1 Bakalar's boat level",
  // printed directly above six rows saying what that actually means.
  //
  // ON THE FIRST STACK IT IS KEPT, and that is not an exception so much as the
  // one case where the desc is saying something else entirely. At zero held,
  // `{effect}` expands to the ability's UNLOCK sentence out of statText.csv —
  // "3 orca buddies who will attack yachts and other orca opps." — which is the
  // only prose in the game saying what the thing IS, and on a card whose own
  // desc is flavour ("Boaterhaters") it is the only sentence at all. A table of
  // numbers cannot replace it: the numbers say how much, and this says of what.
  // From the second stack on it is a figure again and the table has it covered.
  const desc = derived?.length && held >= 1
    ? ''
    : expandDesc(def.desc ?? '', def, { owned: held, warn: null });

  // DON'T SAY IT TWICE — and here the answer is to CUT THE DESC, which is the
  // opposite of what the level-up screen does with the same collision.
  //
  // 49 of the 51 descs carry {effect} now, so `desc` expands to Ethan's prose
  // with the measurement for this very stack spliced into it — the same
  // sentence the `next` row holds, four pixels apart, under a heading implying
  // they are two facts. The look page shows it plainly: "+25% fire rate"
  // printed twice on Supa Dupa Seal, and on most of the roster beside it.
  //
  // ON A CARD the desc wins, because the card's FACE is already showing it and
  // the tooltip is the thing that can be dropped (see cardEffect). ON A HEXAGON
  // there is no face — this box is the only thing there is — and the row is the
  // half worth keeping, because it is the half with a heading on it. An
  // unlabelled grey sentence and a labelled one are not equally useful when the
  // question being asked is "what does one more of this do".
  //
  // SO THE MEASUREMENT IS CUT OUT OF THE DESC AND THE FLAVOUR IS KEPT. Both
  // halves survive: "All balls, no pit." stays as the sentence a person wrote,
  // and the numbers stay under NEXT where they are labelled. Deleting the desc
  // whole would throw away the half no measurement can ever produce.
  //
  // Case-insensitive, because expandDesc sentence-cases the string after the
  // splice — a phrase that landed at the start comes back capitalised.
  return {
    name: def.name ?? def.id,
    stacks: held,
    desc: nextRow && step ? withoutPhrase(desc, step) : desc,
    rows,
  };
}

// `text` with `phrase` cut out of it and the punctuation tidied up after.
//
// Returns '' when nothing but the phrase was there, which is the common case —
// a desc that is bare `{effect}` has no flavour half at all, and an empty grey
// line above the rows would be a gap that looks like a missing string.
function withoutPhrase(text, phrase) {
  if (!text || !phrase) return text;
  const at = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return text;
  const rest = (text.slice(0, at) + text.slice(at + phrase.length))
    // The comma or "and" that was joining the flavour to the measurement, now
    // joining it to nothing.
    .replace(/\s*[,;:]\s*(and\s+)?$/i, '')
    .replace(/^\s*[,;:]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A trailing full stop with nothing in front of it is not a sentence.
  return /[a-z0-9]/i.test(rest) ? sentenceCase(rest) : '';
}

// ---------------------------------------------------------------------------
// THE BOX
// ---------------------------------------------------------------------------

/**
 * Fill a node with a tip's content. The node's POSITION is the caller's
 * problem and its INSIDES are this function's, which is what lets the level-up
 * card keep its own tuned anchoring (see showCardEffect in ui.js) while
 * rendering exactly the same rows the hive does.
 *
 * textContent throughout, never innerHTML: `name` and `desc` come out of a CSV
 * a human edits, and the run line's fallback is a raw source key the game
 * concatenated. Same rule the ledger rows follow.
 */
export function renderTipInto(node, content) {
  node.textContent = '';
  if (!content) return node;

  // NO NAME, NO HEAD. The level-up card blanks the name (see cardTipContent in
  // ui.js) because it is the card's own title a line above; the box is then
  // the rows alone. The stack count lives in the head and goes with it — on
  // that surface it is the pick being offered, not a count the player holds.
  if (content.name) {
    const head = document.createElement('div');
    head.className = 'sv-uptip-head';
    const name = document.createElement('span');
    name.className = 'sv-uptip-name';
    name.textContent = content.name;
    head.appendChild(name);
    // The count, as a number rather than as a word — the tile already carries a
    // pip and this is the same fact, said where there is room for it.
    if (content.stacks > 1) {
      const pip = document.createElement('span');
      pip.className = 'sv-uptip-stacks';
      pip.textContent = `×${content.stacks}`;
      head.appendChild(pip);
    }
    node.appendChild(head);
  }

  if (content.desc) {
    const d = document.createElement('div');
    d.className = 'sv-uptip-desc';
    d.textContent = content.desc;
    node.appendChild(d);
  }

  // ONE GRID FOR ALL THE ROWS, and the label column sizes itself to the widest
  // label in it.
  //
  // A ROW CANNOT OWN ITS OWN COLUMN. Laid out per row (flex, or a fixed ch
  // width) the column has to be given a number, and there is no number that is
  // right: the labels are Ethan's words and are not written yet, and the tuned
  // face is not the one a `ch` measurement in this stylesheet assumes. Guess
  // low and the longest label wraps onto two lines under a nine-pixel heading;
  // guess high and every tip carries a stripe of empty space. Both were visible
  // on the look page.
  //
  // `max-content` on a grid column answers it exactly and answers it again the
  // day the words change. The rows are `display: contents` so each one's label
  // and value become cells of the shared grid while `data-row` still selects
  // them — which is what keeps the per-row colouring working.
  const grid = document.createElement('div');
  grid.className = 'sv-uptip-rows';
  for (const row of content.rows) {
    const r = document.createElement('div');
    r.className = 'sv-uptip-row';
    r.dataset.row = row.key;
    // A quantity this pick does not move, but a later one will. Marked so the
    // stylesheet can hold it back from the rows that ARE moving — it is there
    // to say "still coming", not to be read as part of what you are buying.
    if (row.flat) r.dataset.flat = '1';
    const label = document.createElement('span');
    label.className = 'sv-uptip-label';
    label.textContent = row.label;
    const text = document.createElement('span');
    text.className = 'sv-uptip-text';
    text.textContent = row.text;
    r.appendChild(label);
    r.appendChild(text);
    grid.appendChild(r);
  }
  if (content.rows.length) node.appendChild(grid);
  return node;
}

// The one floating box, made on the first hover of the session and moved
// thereafter. FIXED rather than absolute, so it is positioned in viewport
// coordinates and does not care which container the hexagon under it belongs
// to — the corner hive, a menu that is mid-reveal, and a rail on the score
// screen are three different coordinate spaces and this has to work over all
// three without knowing which one it is over.
let tipEl = null;
let tipFor = null;   // the upgrade id the box currently describes

function ensureTip() {
  if (tipEl?.isConnected) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'sv-uptip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

/**
 * Show the tip for `id`, beside `anchor`.
 *
 * `anchor` is an element or a DOMRect. The hexagon's DRAWN edge is what the box
 * is placed against, not the element's box: every hex in this game is a square
 * element clipped to a hexagon that runs 12.7%-89.6% down it (see HEX_GEOMETRY
 * in upgradeHive.js), so anchoring to the element leaves the tip floating a
 * tenth of a tile away from anything visible. `hex: false` for an anchor that
 * really is a rectangle — the end-of-run snapshot's frame is one.
 *
 * Returns the element, or null when nothing was shown.
 */
export function showUpgradeTip(id, anchor, {
  owned = null,
  verbosity = tipVerbosity(),
  hex = true,
  totals = null,
  final = false,
} = {}) {
  const content = upgradeTipContent(id, { owned, verbosity, totals, final });
  if (!content) { hideUpgradeTip(); return null; }

  const node = ensureTip();
  renderTipInto(node, content);
  tipFor = typeof id === 'string' ? id : id?.id ?? null;

  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  if (!r) { hideUpgradeTip(); return null; }

  // MEASURED BEFORE IT IS PLACED. The box is two lines for one card and six for
  // another, so which side of the hexagon it fits on cannot be decided until it
  // has been laid out — the same rule showCardEffect follows, and the same
  // reason: a box placed first and measured second flickers on its first frame.
  node.style.visibility = 'hidden';
  node.classList.add('sv-uptip-on');
  node.style.left = '0px';
  node.style.top = '0px';
  const w = node.offsetWidth;
  const h = node.offsetHeight;

  // The drawn hexagon inside the square, in viewport coordinates.
  const top = hex ? r.top + r.height * 0.127 : r.top;
  const bottom = hex ? r.top + r.height * 0.896 : r.bottom;
  const centre = r.left + r.width / 2;

  const gap = 8;
  // Below by default, above when below would leave the window. The corner hive
  // lives at the bottom of the screen, so "above" is the usual answer there and
  // "below" is the usual answer on the level-up row — which is exactly why this
  // is a measurement rather than a per-surface constant.
  const fitsBelow = bottom + gap + h <= window.innerHeight - gap;
  const y = fitsBelow ? bottom + gap : top - gap - h;

  // Clamped to the window on both axes. A tile on the end of a rail, or a hive
  // pinned to the left edge, would otherwise push the box off the side.
  const x = Math.max(gap, Math.min(window.innerWidth - gap - w, centre - w / 2));
  node.style.left = `${Math.round(x)}px`;
  node.style.top = `${Math.round(Math.max(gap, y))}px`;
  node.style.visibility = '';
  return node;
}

export function hideUpgradeTip() {
  tipFor = null;
  tipEl?.classList.remove('sv-uptip-on');
}

/** Which upgrade the box is describing, or null. For the tests and the pad. */
export function upgradeTipFor() {
  return tipEl?.classList.contains('sv-uptip-on') ? tipFor : null;
}

/**
 * Drop the node entirely.
 *
 * The box is on document.body rather than inside any screen, so nothing else
 * tears it down — a menu closing takes its own subtree with it and leaves this
 * hanging. Called on a restart, where the alternative is a tip about the last
 * run's build sitting over the new one's first level-up.
 */
export function resetUpgradeTip() {
  hideUpgradeTip();
  tipEl?.remove();
  tipEl = null;
}
