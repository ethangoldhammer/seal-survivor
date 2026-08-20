import { CONFIG } from '../config.js';

// ============================================================================
// THE FOOD CHAIN, WRITTEN DOWN — every decision the mechanic makes, in order,
// with the reason it made it.
//
// WHY THIS EXISTS. The chain is four conditions spread across three files and
// a tenth of a second: the release has to land in the sweet spot (strike.js),
// that has to ARM a window, food has to reach the seal inside it
// (entities/pickups.js, systems/chumMagnet.js), and the banner has to be
// allowed to say so (main.js). When it works, one thing happens. When it does
// not, FOUR different failures all look identical from the seat: nothing.
//
// So there is no way to tell "I let go 40ms early" from "no chum was in reach"
// from "the window had already shut" by playing, and every one of them wants a
// different fix. That is the definition of a mechanic that feels random, and it
// is not a thing a Node harness can answer either — the harness proves the
// rules are right, and the question here is which rule the PLAYER is hitting.
//
// A RING BUFFER, AND NOTHING ELSE. No DOM, no renderer, no clock of its own —
// it is fed by strike.js at the exact points the decisions are taken, so an
// entry cannot describe a branch that was not the branch taken. ui/chainDebug.js
// draws it and tools/chain-trace.mjs prints it; both are readers.
//
// OFF BY DEFAULT AND FREE WHEN OFF. `note()` returns on its first line, so the
// per-mouthful call sites cost a property read in a shipped build.
// ============================================================================

/** What kind of thing happened. Kept short — these are column headings. */
export const TRACE_KINDS = ['release', 'link', 'miss', 'lapse'];

const entries = [];
let enabled = false;
let clock = 0;
let seq = 0;

/** Turn recording on or off. The UI toggle and the harnesses both call this. */
export function setChainTrace(on) {
  enabled = !!on;
  if (!on) entries.length = 0;
}

export function chainTraceOn() {
  return enabled;
}

/**
 * Advance the trace's clock. Driven from updateStrike with the same dt the
 * mechanic runs on, so a timestamp here is the run's own time and a paused
 * game does not accumulate a gap in the middle of a chain.
 */
export function tickChainTrace(dt) {
  if (enabled) clock += dt;
}

/**
 * Record one decision.
 *
 * @param kind one of TRACE_KINDS
 * @param data whatever that kind carries — see the readers for the fields.
 */
export function noteChain(kind, data = {}) {
  if (!enabled) return;

  // CONSECUTIVE IDENTICAL MISSES COLLAPSE INTO ONE LINE WITH A COUNT.
  //
  // Without this the log is unreadable in the exact situation it exists for. A
  // seal cruising through a pile books a miss PER ORB — "no window open", forty
  // times — and the RELEASE line that explains why there is no window is pushed
  // off the top of the buffer by the consequences of itself. The one thing the
  // reader needs is the rarest thing in the stream.
  //
  // Only misses, and only consecutive ones: a link is an event you want to see
  // land one at a time (that IS the number climbing), and two misses with a
  // release between them are two different stories.
  const last = entries[entries.length - 1];
  if (kind === 'miss' && last && last.kind === 'miss' && last.why === data.why) {
    last.count = (last.count ?? 1) + 1;
    last.t = clock;
    return;
  }

  entries.push({ n: ++seq, t: clock, kind, ...data });
  const cap = CONFIG.strike?.trace?.keep ?? 40;
  if (entries.length > cap) entries.splice(0, entries.length - cap);
}

/** Newest last. A copy, so a reader cannot edit the log it is reading. */
export function chainTrace() {
  return entries.slice();
}

export function clearChainTrace() {
  entries.length = 0;
  clock = 0;
  seq = 0;
}

/**
 * ONE LINE PER ENTRY, the same wording everywhere it is read.
 *
 * Shared rather than formatted per reader because the overlay and the console
 * dump are the same evidence — and the whole point of this file is that what
 * the player reports and what a harness prints can be compared directly.
 * Two formatters would be two dialects of the same log.
 */
export function formatChainEntry(e) {
  const t = `${e.t.toFixed(2)}s`.padStart(7);
  switch (e.kind) {
    case 'release': {
      // The offset is what a player cannot see and most needs to: which SIDE
      // of the beat they were on, and by how much. Signed, in ms, because a
      // window of a tenth of a second is not a thing to report in seconds.
      const ms = Number.isFinite(e.offset) ? `${e.offset >= 0 ? '+' : ''}${Math.round(e.offset * 1000)}ms` : '  --';
      const verdict = e.sweet ? 'SWEET' : (e.offset < 0 ? 'EARLY' : 'LATE ');
      // TWO THINGS A RELEASE CAN BE, AND THEY COME APART NOW. The verdict is
      // the TIMING, which decides the damage; the tail is whether it ARMED a
      // chain, which a perfect charge does on its own (see tryStrike). A log
      // that read the arming off the timing would call a mistimed perfect
      // charge "speed boost only" on the exact release that started the chain.
      const tail = e.arms
        ? (e.sweet ? 'armed, full damage' : 'armed, no damage (off the beat)')
        : 'speed boost only';
      return `${t}  RELEASE  ${ms.padStart(7)}  ${verdict}  ${tail}`;
    }
    case 'link':
      return `${t}    eat    -> FOOD CHAIN x${e.chain}`;
    case 'miss': {
      // The reason a mouthful scored nothing. THE most useful line in the file:
      // it is the one thing four different failures could not tell you apart.
      const n = e.count > 1 ? ` x${e.count}` : '';
      return `${t}    eat${n.padEnd(5)} -> no link (${e.why})`;
    }
    case 'lapse':
      return `${t}  LAPSE    chain broken at x${e.chain}`;
    default:
      return `${t}  ${e.kind}`;
  }
}

/** The whole log as text, for a console dump or a paste. */
export function chainTraceText() {
  if (!entries.length) return '(no chain events recorded yet)';
  return entries.map(formatChainEntry).join('\n');
}
