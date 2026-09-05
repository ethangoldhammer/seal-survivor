#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:namereel
//
// THE OPENING REELS — ui/nameScramble.js.
//
// A new player's pill flips its two halves — adjective and nickname — on two
// clocks and lands on a name. The claim is a SHAPE IN TIME: each reel brakes,
// the adjective settles before the nickname, the landing is exactly on time,
// no reel shows its answer early and no reel shows the same word twice in a
// row. Each of those can be wrong while the screen still shows names flipping,
// so each is measured here on a fake clock:
//
//   THE LADDER        A reel's gaps grow by a fixed ratio and the last is
//                     `slowdown` times the first. A ratio applied to the wrong
//                     end reads as a reel that ACCELERATES into its landing.
//
//   TWO CLOCKS        The adjective lands at `adjectiveStop` of the run and
//                     then stands still while the nickname keeps flipping.
//                     One clock for both would be a list being scrolled,
//                     which is the thing this replaced.
//
//   THE LANDING       Exactly `delay + time` from the start, whatever the
//                     float sum of the gaps came to. A reel that lands at
//                     1.4993s is a nameSwap dissolve that starts a frame
//                     before the pill has re-hugged.
//
//   NO SPOILERS       An interim flip that equals the reel's landing shows
//                     the answer, then something else, then the answer — a
//                     stall. The same word twice in a row is a stall too.
//
//   THE CANCEL        Rolling the dice mid-reel stops both dead: no further
//                     flip, and `land` never fires over the dice's own roll.
//
//   OFF               `enabled: false`, or no ticks, lands at once and shows
//                     nothing in between — the switch has to actually switch.
//
// Dependency-free, like the module: no DOM, no vite loader, a two-word hat.
// ---------------------------------------------------------------------------

import { NAME_SCRAMBLE_DEFAULTS, scrambleSchedule, reelSchedule, runNameScramble } from '../path/src/ui/nameScramble.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A clock with setTimeout semantics: `run(untilMs)` fires everything due, in
// order, advancing `now` as it goes.
function fakeClock() {
  const timers = new Map();
  let id = 0;
  let now = 0;
  return {
    get now() { return now; },
    setTimeout(fn, ms) { id += 1; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout(t) { timers.delete(t); },
    pending() { return timers.size; },
    run(until = Infinity) {
      for (;;) {
        let next = null;
        for (const [k, t] of timers) if (!next || t.at < next.t.at) next = { k, t };
        if (!next || next.t.at > until) break;
        timers.delete(next.k);
        now = next.t.at;
        next.t.fn();
      }
      if (until !== Infinity) now = Math.max(now, until);
    },
  };
}

// Two hats that cycle, so a reel's own reroll is what keeps consecutive
// values apart when the hat hands back a repeat.
function hat(words) {
  let i = 0;
  return () => words[(i++) % words.length];
}

// The splash's own reels, in miniature: adjective stops early, nickname last.
function twoReels(opts = {}, { adjectives, nicknames, landing } = {}) {
  const clock = fakeClock();
  const shown = [];
  const landed = [];
  const reel = runNameScramble({
    reels: [
      { roll: hat(adjectives ?? ['Fat', 'Salty', 'Eepy', 'Briny']), landing: landing?.[0] ?? 'Salty', stop: opts.adjectiveStop ?? NAME_SCRAMBLE_DEFAULTS.adjectiveStop },
      { roll: hat(nicknames ?? ['Tony', 'Marge', 'Gus', 'Bruno', 'Otis']), landing: landing?.[1] ?? 'Gus', stop: 1 },
    ],
    join: ([a, n]) => [a, n].filter(Boolean).join(' '),
    opts,
    show: (name) => shown.push({ at: clock.now, name }),
    land: (name) => landed.push({ at: clock.now, name }),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  return { clock, shown, landed, reel };
}

console.log('nameScramble — one reel\'s ladder');
{
  const o = { ticks: 12, time: 1.5, slowdown: 10, delay: 0 };
  const s = scrambleSchedule(o);
  check('ticks + 1 flips', s.length === o.ticks + 1, `${s.length}`);
  check('first flip at delay', s[0] === 0, `${s[0]}`);
  check('landing exactly at time', s[s.length - 1] === 1500, `${s[s.length - 1]}`);
  const gaps = s.slice(1).map((t, i) => t - s[i]);
  let monotone = true;
  for (let i = 1; i < gaps.length; i += 1) if (gaps[i] < gaps[i - 1] - 1e-6) monotone = false;
  check('every gap is at least the one before it', monotone, gaps.map((g) => g.toFixed(1)).join(' '));
  const ratio = gaps[gaps.length - 1] / gaps[0];
  check('last gap is `slowdown` times the first', Math.abs(ratio - o.slowdown) < 1e-6, `${ratio.toFixed(3)}`);
  check('first flip is visible (over a frame)', gaps[0] > 16, `${gaps[0].toFixed(1)}ms`);

  const d = scrambleSchedule({ ...o, delay: 0.25 });
  check('delay shifts the whole reel', d[0] === 250 && d[d.length - 1] === 1750, `${d[0]}..${d[d.length - 1]}`);

  const even = scrambleSchedule({ ticks: 4, time: 1, slowdown: 1 });
  const evenGaps = even.slice(1).map((t, i) => t - even[i]);
  check('slowdown 1 is an even tick', evenGaps.every((g) => Math.abs(g - 250) < 1e-6), evenGaps.join(' '));

  check('zero ticks is just the landing', scrambleSchedule({ ticks: 0 }).length === 1);
  check('one tick is one gap of the whole time', JSON.stringify(scrambleSchedule({ ticks: 1, time: 0.6 })) === '[0,600]');
}

console.log('nameScramble — two reels, merged');
{
  const o = { ticks: 12, time: 1.5, slowdown: 10, delay: 0, adjectiveStop: 0.6 };
  const ev = reelSchedule([{ stop: 0.6 }, { stop: 1 }], o);
  const adj = ev.filter((e) => e.flips.some((f) => f.reel === 0));
  const nick = ev.filter((e) => e.flips.some((f) => f.reel === 1));
  check('the nickname reel gets `ticks` flips', nick.length === 13, `${nick.length}`);
  check('the adjective reel gets its share', adj.length === Math.round(12 * 0.6) + 1, `${adj.length}`);
  const adjLand = adj.find((e) => e.flips.some((f) => f.reel === 0 && f.last));
  const nickLand = nick.find((e) => e.flips.some((f) => f.reel === 1 && f.last));
  check('the adjective lands at `adjectiveStop` of the run', adjLand?.at === 900, `${adjLand?.at}`);
  check('the nickname lands at `time`', nickLand?.at === 1500, `${nickLand?.at}`);
  check('the last moment is the nickname landing', ev[ev.length - 1] === nickLand);
  check('both reels start together', ev[0].at === 0 && ev[0].flips.length === 2, JSON.stringify(ev[0]));
  const sorted = ev.every((e, i) => i === 0 || e.at > ev[i - 1].at);
  check('moments are distinct and in order', sorted);
  const both = reelSchedule([{ stop: 1 }, { stop: 1 }], o);
  check('adjectiveStop 1 lands both on the same moment', both[both.length - 1].flips.length === 2 && both.length === 13, `${both.length}`);
  const defaults = reelSchedule([{ stop: NAME_SCRAMBLE_DEFAULTS.adjectiveStop }, { stop: 1 }], NAME_SCRAMBLE_DEFAULTS);
  check('the shipped defaults land on time', defaults[defaults.length - 1].at === NAME_SCRAMBLE_DEFAULTS.time * 1000);
}

console.log('nameScramble — the run');
{
  const o = { ticks: 10, time: 1.2, slowdown: 8, adjectiveStop: 0.5 };
  const { clock, shown, landed, reel } = twoReels(o);
  clock.run();
  check('lands once, on the landing', landed.length === 1 && landed[0].name === 'Salty Gus', JSON.stringify(landed));
  check('lands at `time`', landed[0]?.at === 1200, `${landed[0]?.at}`);
  check('shows one name per moment before it', shown.length === reel.schedule.length - 1, `${shown.length} vs ${reel.schedule.length - 1}`);
  const halves = shown.map((s) => s.name.split(' '));
  check('every interim name is an adjective and a nickname', halves.every((h) => h.length === 2), shown.map((s) => s.name).join(', '));
  // ONE HALF AT A TIME, once the reels have diverged: after the first moment
  // (where both start), consecutive names differ in exactly one half.
  let oneAtATime = true;
  for (let k = 1; k < halves.length; k += 1) {
    const changed = (halves[k][0] !== halves[k - 1][0]) + (halves[k][1] !== halves[k - 1][1]);
    if (changed !== 1) oneAtATime = false;
  }
  check('after the start, each flip changes exactly one half', oneAtATime, shown.map((s) => s.name).join(' → '));
  const afterStop = shown.filter((s) => s.at >= 600);
  check('the adjective stands still once it has landed', afterStop.every((s) => s.name.startsWith('Salty ')), afterStop.map((s) => s.name).join(', '));
  const beforeStop = shown.filter((s) => s.at < 600);
  check('...and is never the landing before then', beforeStop.every((s) => !s.name.startsWith('Salty ')), beforeStop.map((s) => s.name).join(', '));
  check('the nickname is never the landing early', shown.every((s) => !s.name.endsWith(' Gus')), shown.map((s) => s.name).join(', '));
  let repeat = false;
  for (let k = 1; k < shown.length; k += 1) if (shown[k].name === shown[k - 1].name) repeat = true;
  check('no name twice in a row', !repeat, shown.map((s) => s.name).join(', '));
  const at = shown.map((s) => s.at);
  check('flips follow the schedule', at.every((t, k) => Math.abs(t - reel.schedule[k].at) < 1e-6), at.map((t) => t.toFixed(1)).join(' '));
  check('nothing pending after the landing', clock.pending() === 0);
}

console.log('nameScramble — a landing with no adjective half');
{
  const { clock, shown, landed } = twoReels({ ticks: 6, time: 0.6, adjectiveStop: 0.5 }, { landing: ['', 'Flip Flop'] });
  clock.run();
  check('lands on the whole name', landed[0]?.name === 'Flip Flop', JSON.stringify(landed));
  const tail = shown.filter((s) => s.at >= 300);
  check('the adjective reel settles on nothing and the nickname keeps flipping', tail.length > 0 && tail.every((s) => !s.name.includes(' ')), tail.map((s) => s.name).join(', '));
}

console.log('nameScramble — the roll sees the other half');
{
  const clock = fakeClock();
  const seen = [];
  runNameScramble({
    reels: [
      { roll: (_p, values) => { seen.push(values[1]); return `A${seen.length}`; }, landing: 'A0', stop: 0.5 },
      { roll: hat(['Tony', 'Marge', 'Gus']), landing: 'Otis', stop: 1 },
    ],
    opts: { ticks: 6, time: 0.6 },
    show: () => {}, land: () => {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  clock.run();
  check('an adjective is drawn against the nickname showing', seen.length > 1 && seen.slice(1).every((n) => ['Tony', 'Marge', 'Gus'].includes(n)), seen.join(', '));
}

console.log('nameScramble — a repeat from the hat');
{
  const { clock, shown } = twoReels({ ticks: 3, time: 0.3 }, { adjectives: ['Fat'], nicknames: ['Tony'], landing: ['Salty', 'Gus'] });
  clock.run();
  // Before the adjective lands the only name the hat can build is "Fat Tony";
  // after it, "Salty Tony". Neither reel may loop looking for a different word.
  check('a one-word hat still terminates', shown.length > 0 && shown.every((s) => s.name === (s.at < 180 ? 'Fat Tony' : 'Salty Tony')), shown.map((s) => `${s.name}@${s.at.toFixed(0)}`).join(', '));
}

console.log('nameScramble — the cancel');
{
  const { clock, shown, landed, reel } = twoReels({ ticks: 10, time: 2, slowdown: 5 });
  clock.run(500);
  const before = shown.length;
  check('some flips shown by half a second', before > 0 && before < 20, `${before}`);
  reel.cancel();
  clock.run();
  check('no flip after cancel', shown.length === before, `${shown.length} vs ${before}`);
  check('never lands after cancel', landed.length === 0);
  check('no timer left behind', clock.pending() === 0);
  reel.cancel();
  check('a second cancel is harmless', true);
}

console.log('nameScramble — off');
{
  for (const [label, opts] of [['enabled: false', { enabled: false }], ['ticks: 0', { ticks: 0 }], ['time: 0', { time: 0 }]]) {
    const { clock, shown, landed } = twoReels(opts);
    clock.run();
    check(`${label}: lands at once and shows nothing`, shown.length === 0 && landed.length === 1 && landed[0].at === 0 && landed[0].name === 'Salty Gus',
      `shown ${shown.length}, landed ${JSON.stringify(landed)}`);
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall clear');
process.exit(failures ? 1 : 0);
