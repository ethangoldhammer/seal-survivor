// ===========================================================================
// ATTACK TRACE — what the boss tried, what stopped it, and where it ended up.
// ===========================================================================
// The reports this exists to answer are the two that numbers cannot settle:
// "it never commits" and "the bite went straight through me". Both are claims
// about a tenth of a second inside a fight, and both have half a dozen
// candidate causes that all look identical from the outside — a shark circling
// because the line is out of its cone looks exactly like a shark circling
// because the crowd has not given it a feeding slot, which looks exactly like
// a shark circling because `minRange` is pushing it off.
//
// So this records the gate that was actually shut, on the frame it was shut,
// and nothing else. It is the C-key chain debug's argument applied to the
// other end of the fight (see dumpChainTrace): anything you have to pause to
// read is a description of a frame, and the thing being diagnosed is a
// decision the animal took while it was moving.
//
// ---------------------------------------------------------------------------
// FOUR RULES, and each one is a bug this would otherwise have.
// ---------------------------------------------------------------------------
//
//   OFF IS FREE. Every entry point returns on its first line when the trace is
//   off, and every call site passes values it already has in hand. Nothing in
//   here allocates, measures or formats unless somebody has pressed V. The
//   lunge gate runs for every shark in the water, sixty times a second.
//
//   COUNT EDGES, NOT FRAMES. A refusal is a state, not an event: a shark that
//   is too far away is refused on every frame for nine seconds. Counting those
//   would report one boss as having been refused 540 times and make the rarest
//   reason — the one you are hunting — invisible under the commonest. So a
//   refusal is logged when the REASON CHANGES, and what accumulates per reason
//   is SECONDS HELD rather than a tally. "78% of this fight was `cone`" is the
//   sentence the panel has to be able to say.
//
//   A RUN IS SCORED ON ITS CLOSEST APPROACH. "Is it aiming at me" has exactly
//   one honest measurement and it is not the launch angle: it is how close the
//   head got to the seal at any point during the committed run, held against
//   the reach the bite would have needed. A run that ends 14 units away was
//   aimed at nothing, whatever it was pointing at when it left.
//
//   A BITE THAT DID NOT BILL SAYS WHY. onPlayerBite has four ways to return
//   without dealing damage and three of them are invisible — no damage on the
//   row, the i-frame window, out of reach. The reach case carries both numbers,
//   because "5.1 needed, 7.2 measured" is a tuning answer and "it missed" is
//   not.
//
// THE LEDGER IS PER FIGHT. resetAttackTrace() is called beside the rest of the
// boss teardown, so a panel opened during the third boss of a run is reading
// that boss rather than an average of three.
//
// Dev only in practice — nothing calls setAttackTrace(true) except ui/
// attackDebug.js, which is behind DEV_UI — but this file is deliberately not
// itself behind a dev flag: the call sites live in entities/enemies.js and
// main.js, on the hot path, and a module that production tree-shakes to
// nothing is a module whose call sites would stop compiling in dev.
// ===========================================================================

// The one flag every entry point tests first.
let on = false;

/**
 * THE STUDY SWITCHES — the two things the panel changes about the fight rather
 * than merely watching.
 *
 * They live here rather than in ui/attackDebug.js because main.js and
 * entities/enemies.js read them on the hot path, and a game loop importing a
 * panel to find out whether to deal damage is a dependency pointing the wrong
 * way. They are plain booleans on purpose: nothing in the game asks how they
 * got set, and a getter per flag would be three lines each to say `false`.
 *
 *   noDamage  the seal takes nothing. Not god mode for its own sake: a boss's
 *             lunge cycle is five to eight seconds and reading a gate takes a
 *             couple of minutes of watching, which is four bars of health on
 *             any archetype worth studying. The trace still records every bite
 *             that LANDED, so the ledger's numbers are the real fight's — see
 *             the note on `bitesBilled`.
 *   soloBoss  the water sends nothing else. A lunge gate has a `crowd` branch
 *             that only ever closes when other apex bodies are present, so
 *             "does this boss commit" is a different question with six sharks
 *             in the arena and is much harder to watch.
 *
 * Both default off and are cleared by resetAttackTrace, so neither can survive
 * into a run nobody set it for.
 */
export const attackStudy = {
  noDamage: false,
  soloBoss: false,
};

// Seconds since the trace was last reset, advanced by tickAttackTrace. Not
// gameState.time: the panel is usually opened mid-fight and every timestamp in
// it should be "how long ago", not "how far into the run".
let clock = 0;

// The rolling log. Capped hard rather than trimmed on read — a fight left
// running with the panel open for ten minutes must not grow without bound, and
// the last N events is the only part anybody reads.
const MAX_EVENTS = 240;
const events = [];

// Per-reason dwell, in seconds. The keys are the gate names below.
const held = new Map();

// Whole-fight counters.
const tally = {
  winds: 0,        // wind-ups entered
  commits: 0,      // strike steps entered (a double counts twice — it is two runs)
  plans: 0,        // plans rolled (a double is one plan)
  reaimAborts: 0,  // plans ended by reaimCone rather than by running out of steps
  bitesFired: 0,   // the jaw snapped at the seal
  bitesBilled: 0,  // ...and damage was actually dealt
  shotsFired: 0,
  shotsExpired: 0, // died on their own `life` clock, in the arena, hitting nothing
  shotsLeft: 0,    // flew out past the walls
  shotsHitPlayer: 0,
  shotsKilled: 0,  // shot down by the player
};

// The state each traced creature carries while the trace is on. Keyed by the
// creature object, weakly: a boss that dies mid-fight must not be held alive by
// its own diagnostics.
const perEnemy = new WeakMap();

function stateFor(e) {
  let s = perEnemy.get(e);
  if (!s) {
    s = {
      gate: null, gateSince: 0, runMin: Infinity, runStart: 0, stage: null,
      // THE SAME FIGURES, KEPT PER BODY AS WELL AS FOR THE FIGHT.
      //
      // A fight is one ledger and that is the right default — "what is holding
      // this fight up" is a question about the water, not about one animal. But
      // a boss with five escorts around it is six bodies reporting into one
      // table, and the escorts outnumber the thing being studied five to one:
      // the crowd gate went from 0% to 17% the moment escorts were added and
      // there was no way to tell whether it was refusing the BOSS or refusing
      // the sharks. A table that cannot answer that is a table that will be
      // read as answering it.
      held: new Map(),
      winds: 0,
      commits: 0,
      plans: 0,
      closest: [],
    };
    perEnemy.set(e, s);
  }
  return s;
}

function push(kind, text, extra = null) {
  events.push({ t: clock, kind, text, extra });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Is anything being recorded? Call sites test this before doing any work. */
export function attackTraceOn() {
  return on;
}

/**
 * Turn recording on or off. Switching ON clears — a trace that carried the
 * dwell figures from the last time the panel was open would report a boss as
 * having spent four minutes refused before it existed.
 */
export function setAttackTrace(value) {
  const next = !!value;
  if (next === on) return on;
  on = next;
  if (on) resetAttackTrace();
  else {
    // THE SWITCHES BELONG TO THE PANEL, NOT TO THE FIGHT, so they are cleared
    // here and deliberately NOT in resetAttackTrace: a restart in the middle of
    // a study should keep the study set up, and a panel that has been closed
    // must not leave the seal invincible for the rest of the session.
    attackStudy.noDamage = false;
    attackStudy.soloBoss = false;
  }
  return on;
}

/** Wipe the ledger. Called on every new boss and every new run. */
export function resetAttackTrace() {
  clock = 0;
  events.length = 0;
  held.clear();
  for (const k of Object.keys(tally)) tally[k] = 0;
  // perEnemy is a WeakMap and is not cleared: its entries are keyed by
  // creatures that are themselves being dropped, and a stale entry for a body
  // still in the water re-initialises on its next gate report anyway.
}

/**
 * One frame of the trace's own clock. Beside the other per-frame resets in
 * main.js rather than inside a system, because every timestamp in the log is
 * measured against it and it has to advance exactly once however many creatures
 * report this frame.
 *
 * Takes the SCALED dt, the same one the behaviours integrate against — a dwell
 * figure measured in wall seconds would disagree with the wind-up times on the
 * sliders beside it during a boss kill's slow motion.
 */
export function tickAttackTrace(dt) {
  if (!on) return;
  clock += dt;
}

// The gates, in the order lungeChase tests them. The panel renders these in
// this order and names them with these strings, so the two cannot drift.
export const GATES = ['minRange', 'crowd', 'turning', 'range', 'pitch', 'cone', 'budget', 'open'];

/**
 * THE GATE REPORT — called once per frame, from the cruise branch of
 * lungeChase, with whichever gate stopped it (or 'open' on the frame it
 * commits).
 *
 * `detail` is whatever numbers make that gate's refusal readable, and it is
 * only formatted on the frame the reason CHANGES. A gate that has been shut
 * for nine seconds costs one map lookup and one addition per frame.
 */
export function noteLungeGate(e, dt, gate, detail = null) {
  if (!on) return;
  held.set(gate, (held.get(gate) ?? 0) + dt);
  const s = stateFor(e);
  s.held.set(gate, (s.held.get(gate) ?? 0) + dt);
  if (s.gate === gate) return;
  // The edge. What is logged is the reason it has just STARTED giving, with how
  // long the previous one held — so a log line reads as a history of decisions
  // rather than as a sample of one frame.
  const wasFor = s.gate == null ? 0 : clock - s.gateSince;
  s.gate = gate;
  s.gateSince = clock;
  if (gate === 'open') push('gate', 'line open', detail);
  else push('gate', `held off — ${gate}`, wasFor > 0 ? { ...(detail ?? {}), after: wasFor } : detail);
}

/**
 * A stage transition on the lunge state machine. Called from lungeChase at each
 * assignment, with the stage being entered.
 *
 * `closest` on the way OUT of a strike is the run's score — see the note at the
 * top. It is tracked here rather than at the call site because the call site
 * does not run on the frames between the launch and the end of the run.
 */
export function noteLungeStage(e, stage, detail = null) {
  if (!on) return;
  const s = stateFor(e);
  if (s.stage === stage) return;
  const from = s.stage;
  s.stage = stage;
  // THE GATE READOUT IS ONLY MEANINGFUL WHILE THE BODY IS ASKING. The cruise
  // branch is the only place a gate is reported, so a body that has left it —
  // winding up, mid-run, cooling down — carries whatever the last answer was.
  // Held, that read as "open (17.8s)" beside a distance clearly outside the
  // window, which is the panel contradicting itself on its two most-read lines.
  // Cleared here instead, and the panel says "mid-cycle" rather than lying.
  s.gate = null;

  if (from === 'strike') {
    // The run just ended. Report what it actually got to, which is the whole
    // measurement — a launch angle proves nothing.
    const closest = s.runMin;
    tally.commits += 1;
    s.commits += 1;
    if (Number.isFinite(closest)) s.closest.push(closest);
    push('run', 'run ended', {
      closest: Number.isFinite(closest) ? closest : null,
      lasted: clock - s.runStart,
      connected: s.runBit === true,
    });
    s.runMin = Infinity;
    s.runBit = false;
  }

  if (stage === 'wind') { tally.winds += 1; s.winds += 1; push('stage', 'wind-up', detail); }
  else if (stage === 'strike') { s.runStart = clock; s.runMin = Infinity; s.runBit = false; push('stage', 'committed', detail); }
  else if (stage === 'reaim') push('stage', 're-aim', detail);
  else if (stage === 'rest') push('stage', 'cooling down', detail);
}

/** A plan was rolled at the top of a run. `kind` is pass / double / feint. */
export function noteLungePlan(e, kind, steps) {
  if (!on) return;
  tally.plans += 1;
  stateFor(e).plans += 1;
  push('plan', `plan: ${kind}`, { steps });
}

/**
 * The gap to the seal, every frame a creature is mid-run. One number in, one
 * comparison — this is the cheapest thing in the file on purpose, because it is
 * the only hook that runs on every frame of every strike.
 */
export function noteLungeDistance(e, dist) {
  if (!on) return;
  const s = stateFor(e);
  if (dist < s.runMin) s.runMin = dist;
}

/** A plan abandoned at the end of a re-aim because the nose never came round. */
export function noteReaimAbort(e, off, cone) {
  if (!on) return;
  tally.reaimAborts += 1;
  push('abort', 'plan dropped — still not pointed at you', { off, cone });
}

/**
 * THE BITE. Called from onPlayerBite for every snap, landed or not, with the
 * reason it did not bill. `why` is null when it did.
 */
export function noteBite(e, { dmg, dist, reach, why = null, striking = false }) {
  if (!on) return;
  tally.bitesFired += 1;
  if (why == null) {
    tally.bitesBilled += 1;
    const s = stateFor(e);
    if (s.stage === 'strike') s.runBit = true;
    push('bite', `bite landed${striking ? ' mid-run' : ''}`, { dmg, dist, reach });
    return;
  }
  push('bite', `bite did not bill — ${why}`, { dmg, dist, reach });
}

/** A boss or boat shot leaving a muzzle. */
export function noteShotFired(kind, { life, speed, hp = 0 } = {}) {
  if (!on) return;
  tally.shotsFired += 1;
  push('shot', `${kind} fired`, { life, speed, hp, reach: life != null && speed != null ? life * speed : null });
}

/**
 * ...and how it ended: 'expired' (its own clock ran out in open water),
 * 'arena' (it flew out past a wall), 'player' (it hit the seal), 'shot' (the
 * player destroyed it).
 *
 * The split is the whole point of recording this at all. A volley that reads as
 * "the shots vanish" is one of those four and they want four different fixes.
 */
export function noteShotEnd(kind, how, detail = null) {
  if (!on) return;
  if (how === 'expired') tally.shotsExpired += 1;
  else if (how === 'arena') tally.shotsLeft += 1;
  else if (how === 'player') tally.shotsHitPlayer += 1;
  else if (how === 'shot') tally.shotsKilled += 1;
  push('shot', `${kind} ${how === 'expired' ? 'ran out of fuse' : how === 'arena' ? 'left the arena' : how === 'player' ? 'hit you' : 'was shot down'}`, detail);
}

/**
 * Everything the panel draws. One object, rebuilt per read rather than held —
 * it is read at most once a frame by one caller, and a live object handed out
 * would let the panel mutate the ledger.
 */
export function attackTraceReport(focus = null) {
  // `focus` narrows the gate table and the run figures to ONE body. The clock,
  // the event log and the shot counters stay the fight's — a shot has no
  // creature to attribute to once it has left the muzzle, and a log filtered to
  // one animal stops being the history of the fight.
  const s = focus ? perEnemy.get(focus) : null;
  const src = s ? s.held : held;
  const total = [...src.values()].reduce((a, b) => a + b, 0);
  const gates = GATES
    .map((gate) => ({ gate, seconds: src.get(gate) ?? 0, share: total > 0 ? (src.get(gate) ?? 0) / total : 0 }))
    .filter((g) => g.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const counts = s
    ? { ...tally, winds: s.winds, commits: s.commits, plans: s.plans }
    : { ...tally };
  return {
    clock,
    tally: counts,
    gates,
    gateSeconds: total,
    closest: s ? [...s.closest] : null,
    events: events.slice(-40),
  };
}

/** What one creature is doing right now, for the live readout. */
export function attackTraceLive(e) {
  if (!e) return null;
  const s = perEnemy.get(e);
  return s ? { gate: s.gate, stage: s.stage, heldFor: s.gate == null ? 0 : clock - s.gateSince, runMin: s.runMin } : null;
}
