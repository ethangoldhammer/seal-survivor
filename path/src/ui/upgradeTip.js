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
import { measure, measureTotal, phraseAll, sentenceCase, expandDesc } from '../upgradeText.js';
import { runTotals, stacksHeld } from '../systems/playtest.js';
import { sourceForUpgrade, sourceLabel } from '../systems/playtestAnalysis.js';
import { settings } from '../systems/settings.js';

// ---------------------------------------------------------------------------
// THE WORDS THAT ARE NOT MEASUREMENTS
//
// Everything else in a tip is either Ethan's copy out of upgrades.csv or a
// number out of a measurement. These six are the tip's own chrome — the labels
// that say what each row IS — and they are staged, not written. See CLAUDE.md:
// Claude does not write player-facing prose for this game, and a plausible
// placeholder is exactly what survives a review and ships by accident.
//
// The briefs are in design/COPY-TODO.md. npm run test:copy lists them and
// blocks a ship until they are gone.
// ---------------------------------------------------------------------------
const TIP_COPY = {
  next: '[DRAFT] Next',        // the row headed "what the stack you would take does"
  total: '[DRAFT] Now',        // the row headed "what the stacks you hold add up to"
  run: '[DRAFT] This run',     // the row headed "what it has actually done"
  dealt: '[DRAFT] dealt',      // unit after a damage figure
  kills: '[DRAFT] kills',      // unit after a kill count
  fired: '[DRAFT] fired',      // unit after a count of times a control ability went off
  capped: '[DRAFT] Maxed',     // shown instead of the "next" row when a stack is at its cap
  quiet: '[DRAFT] Nothing yet', // shown in the "this run" row when the ledger has a zero
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
 * @returns {{name, stacks, desc, rows: Array<{key, label, text}>}|null}
 *          null when there is nothing to show — verbosity off, or an id that
 *          is not an upgrade. A caller treats null as "no tip", never as a
 *          reason to draw an empty box.
 */
export function upgradeTipContent(upgrade, {
  owned = null,
  verbosity = tipVerbosity(),
  totals = null,
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
  const step = phraseAll(measure(def, next), next);
  const nextRow = atCap
    ? { key: 'next', label: TIP_COPY.next, text: TIP_COPY.capped }
    : (step ? { key: 'next', label: TIP_COPY.next, text: sentenceCase(step) } : null);
  if (nextRow) rows.push(nextRow);

  if (verbosity === 'short') {
    return { name: def.name ?? def.id, stacks: held, desc: '', rows };
  }

  // --- WHERE YOU ALREADY ARE ----------------------------------------------
  // Only once something is held: on a card you have never taken the total IS
  // the next stack, and a tip that says the same sentence twice under two
  // different headings teaches the player that the headings mean nothing.
  if (held >= 1) {
    const sum = sentenceCase(phraseAll(measureTotal(def, held), held));
    // AND NOT WHEN IT COMES OUT THE SAME SENTENCE. On a linear stat card at ONE
    // stack the arithmetic makes them identical — the second Supa Dupa Seal is
    // +25% fire rate, and one stack of it totals +25% fire rate — so the box
    // prints the same line twice under two headings that promise two facts.
    // Both are true; showing them together is what is not useful, and it reads
    // as a bug rather than as a coincidence. From the second stack on they
    // diverge on their own (+25% against +57.8%) and both rows come back.
    if (sum && sum !== nextRow?.text) {
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
  const desc = expandDesc(def.desc ?? '', def, { owned: held, warn: null });

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
} = {}) {
  const content = upgradeTipContent(id, { owned, verbosity, totals });
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
