import { sourceFamily } from './playtestAnalysis.js';
// ---------------------------------------------------------------------------
// PLAYTEST RECORDER
//
// Watches a run and writes down what actually happened: damage dealt by each
// ability, damage taken from each creature, enemy hp arriving per second, how
// close to death the player lived, and which upgrades were held while all of
// that was true. playtestAnalysis.js turns that into balance verdicts.
//
// Design rules this file sticks to:
//
//   * AGGREGATE, DON'T LOG. A ten-minute run lands tens of thousands of damage
//     events (the garlic aura alone ticks every frame against every creature in
//     range). Keeping them individually would cost more memory than the game
//     does and tell us nothing an accumulator can't. Everything folds into a
//     30-second bucket, which is fine enough to see a difficulty spike and
//     coarse enough to stay free.
//   * NEVER THROW INTO THE GAME LOOP. Every entry point is called from the
//     middle of combat resolution. A recorder bug must not be able to end a
//     run, so the whole surface is null-guarded and does nothing at all when
//     no run is active.
//   * NO GAME IMPORTS. It takes numbers, it doesn't reach for them. That keeps
//     it out of the module cycle between main/combat/enemies, and means the
//     analysis half runs in plain Node.
// ---------------------------------------------------------------------------

const BUCKET_SECONDS = 30;
const STORAGE_KEY = 'seal-survivor-playtest-runs';
const CLIENT_KEY = 'seal-survivor-playtest-client';
const STORED_RUN_LIMIT = 25;
const ENDPOINT = '/__playtest';

// Where a run goes when there's no dev server to write it to disk — the
// collection worker in server/playtest/. Inlined by Vite at BUILD time, so a
// deployed build has to be rebuilt after changing it. Unset (the default, and
// what `npm run dev` wants) means runs stay in the browser exactly as they
// always did.
const REMOTE_URL = (import.meta.env?.VITE_PLAYTEST_URL ?? '').replace(/\/+$/, '');

// Below 30% health is "one mistake from over" — the threshold the analysis
// uses for how much of a run was played on the edge. Here rather than in the
// analysis because it's sampled live, per frame, and can't be recovered after
// the fact from bucket averages.
const LOW_HP_FRAC = 0.3;

let run = null; // the run in progress, or null between runs
let last = null; // the most recently finished run, for the overlay
let bucket = null;
let stacks = {}; // upgrade id -> picks taken so far this run

// Which source last damaged each creature, so a kill can be credited without
// every kill hook in the game having to learn a new argument. A WeakMap rather
// than a field on the enemy: nothing here should keep a corpse alive, and the
// game object stays exactly as it was.
const lastDamager = new WeakMap();
// EVERYTHING that has damaged a body, by source, while it is still alive.
//
// `lastDamager` alone answers "what landed the killing blow", which is the
// right credit for the kill LEDGER — it is cheap, it is what recordKill has
// always used, and over a run it ranks abilities correctly. It is the wrong
// answer for a caption: the last tick before a boss falls is whatever happened
// to be ticking, and a boss beaten down over ninety seconds by the club line
// gets stamped with the pellet that finished it.
//
// So a second, per-body tally, and only for the one question that needs it.
// A WeakMap keyed on the creature: it dies with the body, so a run that killed
// four hundred fish holds four hundred nothings.
const damageTally = new WeakMap();

function newBucket(t) {
  return {
    t,
    seconds: 0,
    dealtBySource: {},
    takenBySource: {},
    killsBySource: {},
    kills: 0,
    spawns: 0,
    spawnHp: 0,
    samples: 0,
    hpFracSum: 0,
    lowHpSamples: 0,
    aliveSum: 0,
    maxHpSum: 0,
    level: 1,
    stacks: {},
    // --- THE FOOD CHAIN -----------------------------------------------------
    // Recorded per bucket because "is the chain popping" is a question about
    // RATE over a run, not a total: a run that chained hard for the first
    // minute and never again reads identically to one that chained steadily,
    // and they are completely different problems.
    //
    // The MISSES are the point. A link needs three things at once (food eaten,
    // a window still open, a release that fires), and a total of links scored
    // cannot tell you which one you keep failing — which is exactly the
    // question that could not be answered from the logs the first time it was
    // asked. Every release that could have scored and didn't is filed under
    // the condition that stopped it.
    strikes: 0,           // releases that actually fired a dash
    links: 0,             // ...of which scored a FOOD CHAIN link
    linkDepthSum: 0,      // sum of chain depth at each link, for a mean
    maxChain: 0,          // deepest chain reached in this bucket
    armed: 0,             // ...fired ON the beat, so a chain was opened
    missOffBeat: 0,       // fired outside the sweet spot — nothing else asked
    missNoFood: 0,        // fired, window open, but not enough eaten
    missNoWindow: 0,      // fired with enough eaten, but the window had shut
    missBoth: 0,          // fired having done neither
    chumEaten: 0,         // mouthfuls, for the denominator on all of the above
  };
}

function add(map, key, amount) {
  map[key] = (map[key] ?? 0) + amount;
}

export function isRecording() {
  return run != null;
}

export function currentRun() {
  return run;
}

export function lastFinishedRun() {
  return last;
}

/**
 * Start recording. `config` is a flat fingerprint of the knobs that decide
 * difficulty — stored WITH the run because a verdict is only meaningful next
 * to the numbers that produced it. Compare two runs recorded under different
 * spawn.ramp values and you're comparing two different games.
 */
export function beginRun(config = {}) {
  run = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    startedAt: Date.now(),
    duration: 0,
    endReason: 'in-progress',
    level: 1,
    kills: 0,
    score: 0,
    startMaxHp: config.playerMaxHp ?? 100,
    config,
    // Stamped at the START, not at persist time, so the localStorage copy and
    // the disk copy carry it too — a run that only grows its provenance on
    // the way to the collector is a run that can't be grouped anywhere else.
    meta: runMeta(),
    buckets: [],
    upgradePicks: [], // [{t, id}] — the build order, for reading a run back
    controlEvents: {}, // source -> count, for the damageless abilities
    finalStacks: {},
  };
  bucket = newBucket(0);
  stacks = {};
}

/**
 * The line between an hp figure and a PLACEHOLDER. At or above this, a number
 * in the hp column is somebody writing "this does not break", and booking it
 * as though it were a quantity is what poisoned the report. Not a gameplay
 * clamp — nothing in this module feeds back into a run.
 *
 * `seaTurtle` carries hp 1000000000 in enemies.csv, which is how that species
 * spells exactly that. It is not invulnerable in code, though: anything with
 * `lethal` set asks for the health that is left (see processPendingSplashes),
 * so one weather lightning bolt kills a turtle and books a billion damage
 * against the hazard that did it. Eight turtles in one 346-second run put
 * 8.1e9 in `dealtBySource`, which took every other ability in that difficulty
 * band to a 0% share and a 0.00x return — the whole table read as if nothing
 * but the sky had done anything.
 *
 * The spawn side was quietly worse. `recordSpawn` is the denominator of the
 * clear rate and of the pressure curve, so a turtle arriving made that minute
 * look like the arena had flooded with a billion hp of enemy nobody touched.
 *
 * DROPPED RATHER THAN CLAMPED, which is the second version of this. A ceiling
 * cannot work here, and the arithmetic says so: it has to sit above the
 * biggest legitimate hit, and with spawning.csv at `ramp.hpMax` 30 a bossShark
 * is 82k at ten minutes and 212k at thirty — so any cap high enough to let
 * that through still books more per turtle than a real ability manages in a
 * whole run. There is no honest number to record for killing a placeholder.
 * Zero is the honest one. The kill is still credited (see recordKill) and the
 * spawn is still counted; it is only the hp that goes unbooked.
 *
 * The gap this sits in is enormous and checked by npm run test:ledger — real
 * creatures are orders below it, sentinels orders above.
 *
 * RAISED FROM 1e6 when the bosses became walls. This line is not a tuning
 * value, it is the gap between two populations — a creature with health, and
 * somebody typing "unbreakable" in a number column — and 1e6 was a fine place
 * to draw it while the biggest real animal in the game had 900 hp. It stopped
 * being fine the moment bossBoat did: at 3,200 base and 260 a difficulty
 * point it crosses 1e6 twenty-two minutes into a run, and the symptom would
 * have been the ledger quietly deciding that the boat is scenery — its damage
 * unbooked, its spawn uncounted, and every ability's share computed against a
 * denominator with the biggest fight in the run missing from it. Exactly the
 * failure the sea turtle caused, arriving from the other direction.
 *
 * 5e6, and it is pinned from both sides — this is not a round number because
 * there is no room left for one. The turtle's 1e9 has to stay a hundred times
 * clear of the line or the two populations are not separable at a glance,
 * which caps it just under 1e7; the heaviest real creature has to stay under
 * it for far longer than anybody plays, which floors it around 3e6 (bossBoat
 * reaches 1.36e6 at thirty minutes). test:ledger checks both ends and states
 * the upper one as a RUN LENGTH — nearly two hours of headroom — which is the
 * only form of that margin anybody can judge.
 */
export const SENTINEL_HP = 5e6;

/** Damage dealt BY the player's kit. `source` is a key of SOURCE_UPGRADES. */
export function recordDamage(source, amount, target) {
  if (!run || !(amount > 0)) return;
  // Credit still moves even when the figure doesn't — whatever last touched a
  // creature owns its kill, and a placeholder's death is still a death.
  if (target && typeof target === 'object') lastDamager.set(target, source);
  // DAMAGE TO SCENERY IS NOT DAMAGE. An invincible creature absorbs the write
  // to its hp (entities/enemies.js, makeInvincible), so an ability that swings
  // at a turtle accomplishes nothing — but the ability still calls in the
  // figure it *tried* to deal. Booking that would credit every weapon for work
  // it did not do, and would rank whichever one happens to swing near scenery
  // most often. The guard lives here rather than at the eighteen call sites for
  // the same reason the seal on `hp` does: this is the one place they all meet.
  if (target && typeof target === 'object' && target.invincible) return;
  if (amount >= SENTINEL_HP) return;
  add(bucket.dealtBySource, source, amount);
  // The per-body tally the polaroid reads. Behind the same two guards as the
  // ledger above and deliberately so: a caption must not credit a weapon for
  // swinging at scenery, and the turtle's sentinel hp would out-total every
  // real weapon in the run on its own. See SENTINEL_HP.
  if (target && typeof target === 'object') {
    let tally = damageTally.get(target);
    if (!tally) { tally = Object.create(null); damageTally.set(target, tally); }
    tally[source] = (tally[source] ?? 0) + amount;
  }
}

/**
 * WHAT ACTUALLY KILLED `target` — the weapon that did the most damage to it,
 * not the one that happened to land last.
 *
 * Exposed because ONE death in the game needs the answer while the body is
 * still warm rather than as a bucket total afterwards: the boss's, which the
 * kill shot stamps onto the polaroid (systems/boss.js -> systems/bossShot.js).
 *
 * MOST DAMAGE, NOT LAST HIT, and the two are different often enough to matter.
 * A boss is worn down over a minute and a half; whatever ticks on the frame it
 * falls is close to arbitrary — an aura, a carom, a pellet — and stamping that
 * on the photograph captions the fight with a footnote. The ledger still
 * credits the KILL to the last damager (see recordKill), which is the right
 * rule there and cheap; this is the caption's own question.
 *
 * BY FAMILY FIRST. The club line books under four separate tags so the balance
 * report can rank Boom Boom Club against Cold Snap — correct for the ledger, and
 * ruinous for a caption: a run built entirely on wood splits its output four
 * ways and loses the stamp to whatever single ability out-damaged each
 * quarter. So the totals are summed per family, the winning family is chosen,
 * and the loudest member of THAT family is what gets named. See SOURCE_FAMILY.
 *
 * Falls back to the last damager when nothing was tallied at all — a body
 * killed by something that deals no damage (the net haul) still has a killer.
 * Null while no run is recording, which never happens in practice (main.js
 * calls beginRun on every start) and is still not something a caller may
 * assume: the polaroid falls back to saying nothing rather than to a guess.
 */
export function damageCreditFor(target) {
  if (!target || typeof target !== 'object') return null;
  const tally = damageTally.get(target);
  if (!tally) return lastDamager.get(target) ?? null;

  // Two passes rather than one. The family has to be decided across ALL of its
  // members before any member can win — picking the loudest single source and
  // then asking what family it is in is the bug this whole function exists to
  // fix, because that is exactly what "the club line lost to a pellet" is.
  const families = Object.create(null);
  for (const key in tally) {
    const fam = sourceFamily(key);
    families[fam] = (families[fam] ?? 0) + tally[key];
  }
  let bestFam = null;
  let bestFamTotal = -Infinity;
  for (const fam in families) {
    if (families[fam] <= bestFamTotal) continue;
    bestFamTotal = families[fam];
    bestFam = fam;
  }

  let best = null;
  let bestTotal = -Infinity;
  for (const key in tally) {
    if (sourceFamily(key) !== bestFam) continue;
    if (tally[key] <= bestTotal) continue;
    bestTotal = tally[key];
    best = key;
  }
  return best ?? lastDamager.get(target) ?? null;
}

/**
 * A creature died. Credit goes to whatever last damaged it, which is right
 * often enough to rank abilities and wrong only for the last tick of an aura
 * finishing something a bullet had already broken. `source` overrides that for
 * kills with no damage behind them at all (the net haul).
 */
export function recordKill(target, source = null) {
  if (!run) return;
  const credited = source ?? (target && typeof target === 'object' ? lastDamager.get(target) : null) ?? 'unknown';
  run.kills += 1;
  bucket.kills += 1;
  add(bucket.killsBySource, credited, 1);
}

/**
 * A creature entered the arena with this much hp. Summed per bucket, this is
 * "enemy hp arriving per second" — the pressure curve that CONFIG.spawn.ramp
 * bends, and the denominator of the whole scaling question. Measured at spawn
 * rather than inferred from kills so it stays honest about the creatures that
 * were never killed at all: those are exactly the ones a flooding arena is
 * made of.
 */
export function recordSpawn(hp) {
  if (!run) return;
  // The COUNT is always honest — a placeholder still occupies the arena, and
  // dropping it here would corrupt the same curve this guard exists to protect.
  bucket.spawns += 1;
  // The hp is not, for the same reason the damage side isn't — see SENTINEL_HP.
  // This is the denominator of the clear rate, so one placeholder does not
  // merely add noise, it decides what that minute looked like.
  if (hp >= SENTINEL_HP) return;
  bucket.spawnHp += hp;
}

/** Damage taken by the player. `source` is a creature type or a hazard name. */
export function recordPlayerDamage(amount, source = 'unknown') {
  if (!run || !(amount > 0)) return;
  add(bucket.takenBySource, source, amount);
}

/**
 * An ability that doesn't deal damage did its thing — a bubble trap, a charm,
 * a fish hauled off in the net. Counted so the report can rank them on the
 * work they actually do instead of showing them as zero-damage dead weight.
 */
export function recordControl(source, n = 1) {
  if (!run) return;
  add(run.controlEvents, source, n);
}

/**
 * A strike RELEASE, and whether it scored a link.
 *
 * Called on every release that fires, including the ones that score nothing —
 * a report built only from successes cannot distinguish "the player never
 * strikes" from "the player strikes constantly and never links", and those
 * want opposite fixes.
 *
 * TIMING IS ASKED FIRST, and the order is the point. A release outside the
 * sweet spot never had a chance to link whatever else was true, so booking one
 * against "the window had shut" would send a reader after `chainWindow` — a
 * number that is fine — while the actual answer is that the player is letting
 * go early. The three old buckets describe a chain the player set UP wrong;
 * this one describes a chain they THREW wrong, and the fixes have nothing in
 * common.
 *
 * @param depth   how deep the chain already was when this release happened
 * @param hadFood whether enough had been eaten since the last strike
 * @param hadWindow whether the combo window was still open
 * @param sweet   whether the release landed inside the sweet spot. Defaults
 *                true so a caller written before the gate existed reads as it
 *                always did rather than filing every strike as mistimed.
 */
export function recordStrike(depth, hadFood, hadWindow, armed = true) {
  if (!run) return;
  bucket.strikes += 1;
  // WHETHER IT ARMED, NOT WHETHER IT WAS ON THE BEAT — those were the same
  // question until a perfect charge started arming a chain on its own (see
  // tryStrike), and `armed` is the one this report is built on: links per
  // strike is meaningless against a denominator of releases that could never
  // have linked. `missOffBeat` keeps its name because a hundred runs of
  // backlog are bucketed under it and the report still has to read those; it
  // now means "armed nothing".
  if (!armed) { bucket.missOffBeat += 1; return; }
  bucket.armed += 1;
  // Kept off the `links` counter on purpose: a release ARMS a chain and the
  // FOOD scores it (see recordChainLink), so booking a link here would count
  // every link twice and report a hit rate above 100%.
  void depth; void hadFood; void hadWindow;
}

/**
 * ONE LINK OF THE FOOD CHAIN, scored by a mouthful eaten inside an armed
 * window. The other half of recordStrike above, and the split matters: links
 * per strike is the ratio the report is built on, and with the two halves in
 * different events the numerator and the denominator now come from different
 * places. A run full of strikes and no links is a player who cannot find food;
 * one with neither is a player who cannot find the beat.
 */
export function recordChainLink(chain) {
  if (!run) return;
  bucket.links += 1;
  bucket.linkDepthSum += chain;
  if (chain > bucket.maxChain) bucket.maxChain = chain;
}

/** One mouthful swallowed — the denominator for the chain's rate. */
export function recordChum(n = 1) {
  if (!run) return;
  bucket.chumEaten += n;
}

export function recordUpgrade(id, t = 0) {
  if (!run) return;
  stacks[id] = (stacks[id] ?? 0) + 1;
  run.upgradePicks.push({ t, id });
}

/**
 * Per-frame sample. Rates come from the accumulators, but "how close to death
 * did this feel" is only available frame by frame — a player who spent the
 * whole bucket at 5% hp and one who dipped there once have identical damage
 * totals and completely different runs.
 */
export function tick(dt, snap) {
  if (!run || !(dt > 0)) return;
  run.duration = snap.time;
  run.level = snap.level;
  run.score = snap.score ?? run.score;

  bucket.seconds += dt;
  bucket.samples += 1;
  const maxHp = snap.maxHp > 0 ? snap.maxHp : 1;
  const frac = Math.max(0, Math.min(1, snap.hp / maxHp));
  bucket.hpFracSum += frac;
  if (frac < LOW_HP_FRAC) bucket.lowHpSamples += 1;
  bucket.aliveSum += snap.alive ?? 0;
  bucket.maxHpSum += maxHp;
  bucket.level = snap.level;

  if (snap.time >= bucket.t + BUCKET_SECONDS) closeBucket(snap.time);
}

function closeBucket(now) {
  bucket.stacks = { ...stacks };
  run.buckets.push(bucket);
  // Buckets are anchored to wall-clock windows, not to when the last one
  // happened to close: a frame hitch that overshoots the boundary must not
  // shift every bucket after it, or two runs stop being comparable minute for
  // minute.
  const nextStart = bucket.t + BUCKET_SECONDS;
  bucket = newBucket(nextStart);
  // A hitch big enough to skip a whole window (tab backgrounded, level-up
  // screen left open) leaves an empty bucket rather than one giant lying one.
  while (now >= bucket.t + BUCKET_SECONDS) {
    bucket.stacks = { ...stacks };
    run.buckets.push(bucket);
    bucket = newBucket(bucket.t + BUCKET_SECONDS);
  }
}

/**
 * Finish and file the run. Returns it, so the caller can hand it straight to
 * the overlay. `reason` is 'death' | 'quit' | 'restart'.
 */
export function endRun(reason = 'death', extra = null) {
  if (!run) return null;
  // The final partial bucket counts — the last 20 seconds of a run are the
  // ones that killed you, and dropping them would hide exactly the spike
  // worth seeing. The analysis discards it if it's too short to draw a rate
  // from; that call belongs there, not here.
  if (bucket.seconds > 0) {
    bucket.stacks = { ...stacks };
    run.buckets.push(bucket);
  }
  run.endReason = reason;
  run.finalStacks = { ...stacks };
  // Whatever the caller wants filed alongside the run — in practice the frame
  // time distribution (systems/perfLog.js). It rides HERE rather than being
  // recorded by this module because a run's frame times are a property of the
  // machine it was played on, not of the balance data this recorder exists for
  // — but they belong in the same record, because "the run where the boat
  // exploded" and "the run with the 300ms frame" have to be the same row for
  // either to explain the other.
  //
  // It also makes the numbers READABLE without a browser: runs.jsonl is on
  // disk, so a frame-time report can be looked at from a terminal instead of
  // being trapped in a console someone has to be sitting in front of.
  if (extra) Object.assign(run, extra);
  last = run;
  const finished = run;
  run = null;
  bucket = null;
  persist(finished);
  return finished;
}

// ---------------------------------------------------------------------------
// Provenance
//
// A pile of runs from unknown places is not data. Three questions have to be
// answerable before an aggregate means anything, and none of them can be
// recovered after the fact:
//
//   WHICH BUILD? The single most important field here. Runs from before and
//   after a balance change describe different games, and averaging them
//   together produces a number that was never true of either — the exact
//   failure mode that makes collected telemetry worse than no telemetry.
//   `npm run playtest -- --build <sha>` exists because of this field.
//
//   WHOSE HANDS? Not who they are — a random per-browser id, so that thirty
//   runs can be read as "one player learning" rather than thirty players
//   agreeing. It also separates the developer's own runs from the public's,
//   which otherwise dominate each other by turns.
//
//   ON WHAT? Frame times are meaningless without the machine. A p99 of 40ms
//   is a disaster on a desktop and unremarkable on a four-year-old phone.
//
// WHAT IS DELIBERATELY NOT COLLECTED: no name, no IP (the worker never stores
// one), no user-agent string, no URL, no referrer, no storage of anything the
// player typed. The device fields below are coarse buckets that thousands of
// devices share — enough to read a frame-time distribution, not enough to
// pick a person out of the collection.
// ---------------------------------------------------------------------------

/**
 * The build this run was played on. Injected by vite.config.js as the short
 * git sha; `dev` when running from source, `unknown` in a plain Node import
 * where the define never happened. Guarded rather than read directly because
 * an undeclared global is a ReferenceError, and this file is imported by
 * terminal tests that have no bundler.
 */
function buildId() {
  try {
    return typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A stable random id for this browser, minted on first use.
 *
 * NOT AN IDENTITY. It survives until site data is cleared, it says nothing
 * about who is holding the mouse, and two people sharing a laptop share one.
 * All it has to do is let the report say "these forty runs came from the same
 * hands", which is the difference between a learning curve and a consensus.
 */
function clientId() {
  try {
    const existing = localStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const minted = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(CLIENT_KEY, minted);
    return minted;
  } catch {
    // Private browsing, or storage disabled. The run is still worth having;
    // it just can't be grouped with the others from this browser.
    return 'anon';
  }
}

/** Coarse hardware class, for reading the frame-time record against. */
function deviceProfile() {
  const nav = typeof navigator === 'object' ? navigator : null;
  const scr = typeof screen === 'object' ? screen : null;
  return {
    cores: nav?.hardwareConcurrency ?? 0,
    // Chrome only, and already rounded to a power of two by the spec.
    mem: nav?.deviceMemory ?? 0,
    // The rendered pixel count is what costs, and it's dpr that decides it —
    // two 800px windows at 1x and 3x are not the same machine's problem.
    dpr: typeof devicePixelRatio === 'number' ? Math.round(devicePixelRatio * 100) / 100 : 0,
    w: scr?.width ?? 0,
    h: scr?.height ?? 0,
    // Touch as the coarse desktop/handheld split. Read from the pointer type
    // rather than the user-agent string: it's the property that actually
    // predicts the frame budget, and it isn't a fingerprint.
    touch: !!(nav?.maxTouchPoints > 0),
  };
}

function runMeta() {
  return {
    build: buildId(),
    client: clientId(),
    device: deviceProfile(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
//
// Three destinations, in order of how sure they are to work:
//
//   localStorage — always. A run survives a reload with no server of any kind
//     involved, and it is what the B overlay and the download button read.
//   playtest/runs.jsonl — during `npm run dev` only, through the Vite
//     middleware. Direct to disk, no worker in the loop.
//   the collection worker — when VITE_PLAYTEST_URL is set, which in practice
//     means the deployed build. This is what makes runs played by other
//     people on the live site readable from a terminal at all.
//
// The last two are EXCLUSIVE, not both. A dev run already lands on disk by
// the shorter path, and posting it to the collection as well would fill the
// shared record with runs played against half-finished tuning — the one thing
// that would make the aggregate untrustworthy. Dev noise stays local.
//
// None of the three can fail the game: every one is wrapped, and a rejected
// fetch is a console warning, not an exception into the frame that called
// endRun.
// ---------------------------------------------------------------------------

function persist(finished) {
  try {
    const kept = [...loadStoredRuns(), finished].slice(-STORED_RUN_LIMIT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch (err) {
    // Quota is the usual cause — a long session of long runs. Drop the oldest
    // half and try once more rather than losing the run that just ended.
    try {
      const kept = [...loadStoredRuns()].slice(-4).concat(finished);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
    } catch {
      console.warn('[playtest] could not save run to localStorage —', err?.message ?? err);
    }
  }

  if (import.meta.env?.DEV) {
    post(ENDPOINT, finished, 'run not written to disk');
    return;
  }
  if (REMOTE_URL) post(`${REMOTE_URL}/runs`, finished, 'run not sent to the collection');
}

/**
 * Fire and forget. `keepalive` is the whole reason this is a fetch and not an
 * XHR: a run ends when the player dies, and the tab can be closed on the game
 * over screen a second later — without it the request is cancelled with the
 * page and the run is lost exactly when the run was most decisive.
 *
 * The response is ignored on purpose. There is nothing the game could do
 * about a rejected run, and nothing the player should see either way; the
 * warning is for a developer with a console open.
 *
 * `keepalive` carries a 64KB body limit, and a body over it fails rather than
 * being sent unkeepalived. Real records sit well under: 148 runs on disk
 * measured a 2.2KB median and a 19KB worst case, because the recorder
 * aggregates into 30-second buckets instead of logging events. If a future
 * accumulator ever changes that, this is where it would start silently
 * dropping the longest runs — the ones most worth having.
 */
function post(url, run_, what) {
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(run_),
      keepalive: true,
    }).catch((err) => console.warn(`[playtest] ${what} —`, err?.message ?? err));
  } catch (err) {
    // A synchronous throw — no fetch in this environment, or a body over the
    // keepalive limit. Same handling: the run is already in localStorage.
    console.warn(`[playtest] ${what} —`, err?.message ?? err);
  }
}

export function loadStoredRuns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function clearStoredRuns() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* nothing to do — the report just keeps showing what it has */ }
}

/** Hands the browser's copy of the runs over as a file, for sharing a session. */
export function downloadStoredRuns() {
  const runs = loadStoredRuns();
  const blob = new Blob([runs.map((r) => JSON.stringify(r)).join('\n')], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `seal-playtest-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return runs.length;
}

/**
 * A live snapshot of the run in progress, for the overlay's HUD line. Cheap
 * enough to call every frame the overlay is open, and returns null when
 * nothing is being recorded.
 */
export function liveSnapshot() {
  if (!run || !bucket || bucket.seconds < 1) return null;
  let dealt = 0;
  for (const k in bucket.dealtBySource) dealt += bucket.dealtBySource[k];
  let taken = 0;
  for (const k in bucket.takenBySource) taken += bucket.takenBySource[k];
  const pressure = bucket.spawnHp / bucket.seconds;
  const dps = dealt / bucket.seconds;
  return {
    t: run.duration,
    dps,
    pressure,
    clearRatio: pressure > 0 ? dps / pressure : 0,
    incomingDps: taken / bucket.seconds,
    kills: run.kills,
    alive: bucket.samples > 0 ? bucket.aliveSum / bucket.samples : 0,
  };
}
