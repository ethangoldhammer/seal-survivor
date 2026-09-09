// A run that gets reloaded out from under itself.
//
// Two behaviours that only exist because of the same fact: the recorder writes
// NOTHING until endRun. A page that reloads mid-run does not truncate the
// record, it erases it — which is why all 301 runs on disk read 'death' and
// the ones that cut off left no gap to find them by.
//
//   1. systems/reloadHold.js keeps the dev server from reloading the page for
//      the length of a run. Two owners share that latch (the stage bar and the
//      run) and they overlap, so it is counted rather than toggled.
//   2. playtest.js closes the books on pagehide, so an interrupted run is a
//      ROW instead of a silence.
//
// Runs in plain Node with no bundler and no jsdom: playtest.js reaches for
// window, localStorage and fetch, and every one of them is guarded, so a
// handful of stubs is the whole harness. They have to be installed BEFORE the
// import, because the pagehide listener is registered at module scope — set
// them after and the module binds to nothing and every check below passes for
// the wrong reason.

let failures = 0;
function check(what, cond, why) {
  if (cond) { console.log(`  ok   ${what}`); return; }
  failures += 1;
  console.log(`  FAIL ${what}${why ? `\n       ${why}` : ''}`);
}

// --- the stubs, before the import ------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const listeners = new Map();
globalThis.window = {
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
};
const fire = (type) => (listeners.get(type) ?? []).forEach((fn) => fn({ type }));

// import.meta.env is undefined outside Vite, so persist() takes neither the
// dev-server nor the collector branch here. localStorage is the destination
// this harness reads, and it is also the one the module calls unconditional.
const playtest = await import('../path/src/systems/playtest.js');
const { holdReloads, isHolding } = await import('../path/src/systems/reloadHold.js');

const stored = () => JSON.parse(globalThis.localStorage.getItem('seal-survivor-playtest-runs') ?? '[]');
const play = (seconds) => {
  for (let i = 0; i < seconds; i++) {
    playtest.recordDamage('gun', 10, { hp: 100 });
    playtest.tick(1, { time: i + 1, level: 1, score: 0, hp: 100, maxHp: 100, alive: 4 });
  }
};

console.log('\nRELOAD HOLD — counted, not toggled\n');

check('nothing holds at rest', !isHolding());

playtest.beginRun({ playerMaxHp: 100 });
check('a run holds the page still', isHolding());

holdReloads('stage', true);
check('the bar joining is still held', isHolding());

// THE REASON THIS IS A SET. Closing the bar mid-run used to release the latch
// outright, and the next save anywhere in the tree reloaded the page — losing
// the run, which is the exact thing the hold exists to protect.
holdReloads('stage', false);
check('closing the bar mid-run does NOT release the run', isHolding(),
  'a boolean latch loses the overlap and the next save eats the run');

holdReloads('nobody', false);
check('releasing a holder that never held changes nothing', isHolding());

playtest.beginRun({ playerMaxHp: 100 });
check('beginning twice is still one holder', isHolding());
playtest.endRun('restart');
check('and one release lets go', !isHolding(),
  'a leaked holder would hold the page still for the rest of the session');

console.log('\nINTERRUPTED RUNS — a row instead of a silence\n');

store.clear();
playtest.beginRun({ playerMaxHp: 100 });
play(40);
check('a run is recording', playtest.isRecording());
check('and nothing is on disk yet', stored().length === 0,
  'the whole problem: the record does not exist until the run ends');

fire('pagehide');

const runs = stored();
check('the reloaded run is written out', runs.length === 1,
  'this is the row that never existed before');
check('and says what happened to it', runs[0]?.endReason === 'interrupted');
check('and is not filed as a death', runs[0]?.endReason !== 'death',
  'analysis reads endReason — median survival must not count a reload as a death');
check('it keeps the damage it did', runs[0]?.buckets?.length > 0
  && runs[0].buckets.some((b) => (b.dealtBySource?.gun ?? 0) > 0));
check('and how far it got', Math.round(runs[0]?.duration ?? 0) === 40);
check('recording stops with it', !playtest.isRecording());
check('and it lets go of the reload latch', !isHolding(),
  'otherwise the latch outlives the page that set it');

fire('pagehide');
check('a second pagehide files nothing', stored().length === 1,
  'bfcache fires pagehide more than once — a duplicate would double-count the damage');

playtest.beginRun({ playerMaxHp: 100 });
play(40);
playtest.endRun('death');
check('a normal death is still a death', stored().at(-1)?.endReason === 'death');
const afterDeath = stored().length;
fire('pagehide');
check('and closing the tab afterwards adds nothing', stored().length === afterDeath,
  'the run already ended; a second record would be the same run twice');

console.log('\nAND THEIR FRAME TIMES — the extras hook\n');

// The gap this closes: `extra` is an ARGUMENT, so only the ending with a caller
// ever carried frame times. 21 of the last 30 runs on disk had no `perf` block,
// and every one of them was a quit or a reload — which is to say the runs
// somebody cut short on purpose to go and look at something.
//
// 'interrupted' is the case that cannot be fixed by passing an argument: it
// fires from a pagehide handler inside playtest.js, which has no renderer. So
// main.js leaves a function behind instead.
store.clear();
playtest.setRunExtras(() => ({ perf: { frames: 1234 }, render: { draws: 7 } }));

playtest.beginRun({ playerMaxHp: 100 });
play(10);
fire('pagehide');
check('a reloaded run files its frame times', stored().at(-1)?.perf?.frames === 1234,
  'the ending with no caller is the one the argument could never reach');
check('...and the rest of the record with them', stored().at(-1)?.render?.draws === 7);

playtest.beginRun({ playerMaxHp: 100 });
play(10);
playtest.endRun('quit');
check('so does a run walked away from', stored().at(-1)?.perf?.frames === 1234);

// The death path builds its own record and passes it. It was the one ending that
// already worked, and this must not have changed it.
playtest.beginRun({ playerMaxHp: 100 });
play(10);
playtest.endRun('death', { perf: { frames: 99 } });
check('an explicit record still wins', stored().at(-1)?.perf?.frames === 99,
  'the caller knows more than the hook; the hook is the fallback');

// It runs during page teardown, where anything may already be half gone. A
// throw there must cost the frame times and NOT the run.
playtest.setRunExtras(() => { throw new Error('renderer is gone'); });
playtest.beginRun({ playerMaxHp: 100 });
play(10);
const before = stored().length;
fire('pagehide');
check('a source that throws still files the run', stored().length === before + 1,
  'losing the whole row would be worse than the gap this closes');
check('...just without the extras', stored().at(-1)?.perf === undefined);

// And a Node harness registers nothing at all, which is every other tool here.
playtest.setRunExtras(null);
playtest.beginRun({ playerMaxHp: 100 });
play(10);
playtest.endRun('quit');
check('no source registered is harmless', stored().at(-1)?.endReason === 'quit'
  && stored().at(-1)?.perf === undefined);

console.log(failures ? `\n${failures} FAILED\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
