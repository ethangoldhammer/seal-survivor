// ---------------------------------------------------------------------------
// PLAYTEST ANALYSIS
//
// Turns recorded runs (see playtest.js) into balance verdicts. Two questions,
// both of which used to be answered by feel alone:
//
//   1. Does the difficulty ramp outrun the build? Enemy stats scale on a
//      compounding curve (CONFIG.spawn.ramp) while player power scales in
//      discrete upgrade picks — those two curves have no reason to agree, and
//      the point where they cross is where a run stops being winnable.
//   2. Is any one ability carrying the run? An ability doing 60% of the
//      damage on one stack isn't a build, it's a bug in the numbers.
//
// PURE FUNCTIONS ONLY — no DOM, no CONFIG, no imports. The in-game overlay and
// tools/playtest-report.mjs both run this exact code, so a verdict on screen
// and a verdict in the terminal can never drift apart. Keep it that way: the
// moment this file imports config.js, the Node tool needs a bundler to run.
// ---------------------------------------------------------------------------

// Every threshold the verdicts turn on, in one place, because these are
// judgement calls rather than truths — a run that reads as "brutal" to one
// player is "finally interesting" to another. Tune here.
export const BALANCE = {
  // Damage you deal per second ÷ enemy hp arriving per second. Below 1.0 the
  // arena is filling faster than you can empty it; the run is now on a timer
  // whether it feels like it or not.
  floodClearRatio: 0.8,
  // Sustained above this for a whole run and nothing on screen is a threat —
  // enemies are dying faster than the spawner can deliver them.
  trivialClearRatio: 3.0,
  // Incoming damage per minute ÷ your max hp. 1.0 means the fight deals a
  // full health bar every minute, which is the point where survival is about
  // dodging rather than about hp. Above ~2.5, i-frames and regen stop
  // mattering and it's a coin flip.
  lethalPerMin: 1.0,
  brutalPerMin: 2.5,
  // Fraction of a bucket spent under 30% hp — how much of the run was played
  // one mistake from over.
  lowHpFrac: 0.3,
  // Ability flags. `efficiency` is damage share ÷ investment share: 1.0 is
  // "pulls exactly its weight in upgrade picks". A source at 2.2 is doing
  // more than twice the damage its picks paid for.
  opEfficiency: 2.2,
  opMinShare: 0.12,
  weakEfficiency: 0.45,
  weakMinStacks: 2,
  // Below this many seconds a bucket is too short to draw a rate from — the
  // last bucket of a run is usually a fragment, and dividing by 0.4s produces
  // a spike that isn't real.
  minBucketSeconds: 8,
};

// Which upgrade picks pay for which damage source. Investment share is
// measured in picks, so an ability's damage is only impressive relative to how
// many level-ups went into it — this table is what makes that comparison
// possible. Sources absent here (deathBlast, boat wreckage) are environment,
// not build, and sit out of the efficiency ranking.
//
// `gun` gets a phantom baseline stack: the pea-shooter exists at level 1
// without any pick, and dividing by zero investment would rank it infinitely
// efficient forever.
export const SOURCE_UPGRADES = {
  gun: { upgrades: ['rapidFire', 'heavyRounds', 'multishot', 'pierce', 'velocity'], baseStacks: 1, label: 'Peashooter' },
  missile: { upgrades: ['homingMissile'], label: 'Homing Missile' },
  ricochet: { upgrades: ['bounceShot'], label: 'Ricochet Rounds' },
  starfish: { upgrades: ['starfish'], label: 'Starfish Shuriken' },
  seagull: { upgrades: ['seagullBomb'], label: 'Seagull Bomb' },
  garlic: { upgrades: ['seaGarlic'], label: 'Sea Garlic' },
  shrimp: { upgrades: ['shrimpRing'], label: 'Shrimp Ring' },
  eel: { upgrades: ['electricEel'], label: 'Electric Eel' },
  sealTeam: { upgrades: ['sealTeam'], label: 'Seal Team' },
  calamari: { upgrades: ['calamari'], label: 'Calamari Ring' },
  strike: { upgrades: ['strikePower', 'strikeDash', 'strikeCharge'], label: 'Strike' },
  shrapnel: { upgrades: ['strikeShrapnel'], label: 'Bone Shrapnel' },
  // Damageless by design — they remove or neutralise creatures instead. Their
  // "output" is counted in events, not hp, and reported separately so they
  // don't show up as dead weight in a damage table they can't compete in.
  beluga: { upgrades: ['beluga'], label: 'Baby Beluga', control: true },
  dumbo: { upgrades: ['dumbo'], label: 'Dumbo Octopus', control: true },
  // Bakalar's boat does both: the net hauls (control events) and the bomb
  // deals damage. One pick pays for both, so they share a row — see
  // SOURCE_ALIAS.
  bakalar: { upgrades: ['bakalar'], label: "Bakalar's Boat" },
  scallop: { upgrades: ['scallopSquirter'], label: 'Scallop Squirter' },
  oyster: { upgrades: ['oysterBlaster'], label: 'Oyster Blaster' },
  orca: { upgrades: ['orcaFamily'], label: 'Orca Family' },
};

// Two damage tags that are really one upgrade. Without this the bomb reads as
// a source nobody ever spent a pick on — zero investment, so zero return, so
// it can never be flagged as over- or under-tuned no matter what it does.
const SOURCE_ALIAS = {
  bakalarBomb: 'bakalar',
};

function resolveSource(source) {
  return SOURCE_ALIAS[source] ?? source;
}

export function sourceLabel(source) {
  return SOURCE_UPGRADES[source]?.label ?? source;
}

function sum(obj) {
  let n = 0;
  for (const k in obj) n += obj[k];
  return n;
}

function safeDiv(a, b) {
  return b > 0 ? a / b : 0;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Per-bucket derived rates
// ---------------------------------------------------------------------------

// Every rate here is per-second within the bucket, never per-bucket — buckets
// are wall-clock windows and the last one is always short. Dividing by its own
// elapsed time is what keeps the final 4 seconds of a run from reading as a
// collapse in output.
function deriveBuckets(run) {
  const out = [];
  for (const b of run.buckets ?? []) {
    const secs = b.seconds ?? 0;
    if (secs < BALANCE.minBucketSeconds) continue;
    const dealt = sum(b.dealtBySource);
    const taken = sum(b.takenBySource);
    // Effective max hp, averaged over the bucket — Vitality picks move it
    // mid-run, and measuring lethality against the starting bar would
    // understate how much a stacked-hp build actually absorbed.
    const maxHp = safeDiv(b.maxHpSum, b.samples) || run.startMaxHp || 100;
    const dps = safeDiv(dealt, secs);
    const pressure = safeDiv(b.spawnHp, secs);
    out.push({
      t: b.t,
      seconds: secs,
      dealt,
      taken,
      kills: b.kills,
      spawns: b.spawns,
      spawnHp: b.spawnHp,
      dps,
      // Enemy effective hp arriving per second. The denominator of the whole
      // scaling question: this is the curve CONFIG.spawn.ramp bends.
      pressure,
      clearRatio: safeDiv(dps, pressure),
      incomingDps: safeDiv(taken, secs),
      // Health bars per minute the fight is dealing. Normalising by maxHp is
      // what makes minute 1 and minute 12 comparable at all.
      lethalPerMin: safeDiv(taken / secs * 60, maxHp),
      avgHpFrac: safeDiv(b.hpFracSum, b.samples),
      lowHpFrac: safeDiv(b.lowHpSamples, b.samples),
      avgAlive: safeDiv(b.aliveSum, b.samples),
      level: b.level,
      maxHp,
      // Carried through, not just read here: abilityTable prices each source
      // by the stacks that were held DURING the bucket, and a derived bucket
      // that dropped them silently charged every ability zero investment —
      // which made every efficiency in the report come out as 0.00x.
      stacks: b.stacks ?? {},
      dealtBySource: b.dealtBySource,
      killsBySource: b.killsBySource,
      takenBySource: b.takenBySource,
    });
  }
  return out;
}

// The two growth curves, indexed to the opening of the run. This is the
// clearest single answer to "is the ramp too steep": if enemy pressure is 9x
// its opening value while player output is only 3x, the gap IS the difficulty
// spike, regardless of whether the player happened to survive it.
function growthCurve(buckets) {
  if (buckets.length < 2) return [];
  const baseDps = Math.max(buckets[0].dps, 1e-6);
  const basePressure = Math.max(buckets[0].pressure, 1e-6);
  return buckets.map((b) => ({
    t: b.t,
    playerGrowth: b.dps / baseDps,
    enemyGrowth: b.pressure / basePressure,
    // >1 means the player is pulling ahead of the curve, <1 means falling
    // behind it. This is the number to watch when tuning spawn.ramp.
    gap: safeDiv(b.dps / baseDps, b.pressure / basePressure),
  }));
}

// ---------------------------------------------------------------------------
// Ability accounting
// ---------------------------------------------------------------------------

// Stack-minutes, not stacks: an ability taken at minute 9 of a 10-minute run
// has had one minute to prove itself, and charging it the same investment as
// something carried since minute 2 would rank every late pick as garbage.
// Buckets carry a stack snapshot, so summing stacks x bucket-minutes gives
// each source credit for exactly the time it was actually owned.
function abilityTable(run, buckets) {
  const totals = new Map();
  const ensure = (source) => {
    if (!totals.has(source)) {
      totals.set(source, {
        source,
        label: sourceLabel(source),
        control: SOURCE_UPGRADES[source]?.control === true,
        damage: 0,
        kills: 0,
        events: run.controlEvents?.[source] ?? 0,
        stackMinutes: 0,
        stacks: 0,
      });
    }
    return totals.get(source);
  };

  for (const b of buckets) {
    const minutes = b.seconds / 60;
    for (const src in b.dealtBySource) ensure(resolveSource(src)).damage += b.dealtBySource[src];
    for (const src in b.killsBySource) ensure(resolveSource(src)).kills += b.killsBySource[src];
    // Stack snapshot for this bucket, converted from upgrade ids to sources.
    const stacksById = b.stacks ?? {};
    for (const source in SOURCE_UPGRADES) {
      const spec = SOURCE_UPGRADES[source];
      let n = spec.baseStacks ?? 0;
      for (const id of spec.upgrades) n += stacksById[id] ?? 0;
      if (n > 0) ensure(source).stackMinutes += n * minutes;
    }
  }

  // Final stack counts, for display — "3 picks" is what the player recognises,
  // stack-minutes is what the maths runs on.
  const finalStacks = run.finalStacks ?? {};
  for (const source in SOURCE_UPGRADES) {
    const spec = SOURCE_UPGRADES[source];
    let n = spec.baseStacks ?? 0;
    for (const id of spec.upgrades) n += finalStacks[id] ?? 0;
    if (n > (spec.baseStacks ?? 0) || totals.has(source)) ensure(source).stacks = n;
  }

  const rows = [...totals.values()].filter((r) => r.damage > 0 || r.events > 0 || r.stacks > 0);
  const totalDamage = rows.reduce((a, r) => a + r.damage, 0);
  const totalStackMinutes = rows.reduce((a, r) => a + r.stackMinutes, 0);

  for (const r of rows) {
    r.damageShare = safeDiv(r.damage, totalDamage);
    r.investShare = safeDiv(r.stackMinutes, totalStackMinutes);
    // The headline number. Damage share ÷ investment share: what this ability
    // returned per level-up spent on it, relative to everything else in the
    // run. Immune to run length and to how much total damage a build does,
    // which is what makes it comparable across runs.
    r.efficiency = safeDiv(r.damageShare, r.investShare);
    r.dpsPerStackMinute = safeDiv(r.damage, r.stackMinutes);
  }
  rows.sort((a, b) => b.damage - a.damage || b.events - a.events);
  return { rows, totalDamage };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

// Everything above produces numbers; this produces sentences. A flag is
// {level, code, text} where level is 'bad' | 'warn' | 'ok' | 'info' — the
// overlay colours by level and the CLI prefixes by it.
function scalingFlags(run, buckets, curve) {
  const flags = [];
  if (buckets.length < 2) {
    flags.push({ level: 'info', code: 'short-run', text: `Run too short to judge scaling (${formatClock(run.duration)}). Need about a minute.` });
    return flags;
  }

  // Where the player stops out-damaging the arrival rate. Reported as the
  // FIRST sustained crossing (two buckets in a row), not the first dip — one
  // bad bucket is a bad dodge, two is a curve.
  let floodAt = null;
  for (let i = 0; i < buckets.length - 1; i++) {
    if (buckets[i].clearRatio < BALANCE.floodClearRatio && buckets[i + 1].clearRatio < BALANCE.floodClearRatio) {
      floodAt = buckets[i].t;
      break;
    }
  }
  // A run that DIES while under the threshold never gets its second bucket —
  // the death spiral is short by definition. Requiring two windows of it made
  // the check blind to exactly the collapse it exists to catch.
  const finalBucket = buckets[buckets.length - 1];
  if (floodAt == null && run.endReason === 'death' && finalBucket.clearRatio < BALANCE.floodClearRatio) {
    floodAt = finalBucket.t;
  }
  if (floodAt != null) {
    flags.push({
      level: 'bad',
      code: 'flood',
      text: `Enemy hp arrives faster than you can clear it from ${formatClock(floodAt)} on — from here the arena only fills up.`,
    });
  }

  const minClear = Math.min(...buckets.map((b) => b.clearRatio));
  if (floodAt == null && minClear > BALANCE.trivialClearRatio) {
    flags.push({
      level: 'warn',
      code: 'trivial',
      text: `Never under ${BALANCE.trivialClearRatio}x clear rate (low point ${minClear.toFixed(1)}x) — nothing on screen was ever a real threat.`,
    });
  }

  // The gap curve at the end of the run is the ramp verdict proper.
  const last = curve[curve.length - 1];
  if (last) {
    const where = formatClock(last.t);
    if (last.gap < 0.7) {
      flags.push({
        level: 'bad',
        code: 'ramp-steep',
        text: `By ${where} enemy pressure grew ${last.enemyGrowth.toFixed(1)}x while your damage grew ${last.playerGrowth.toFixed(1)}x — the ramp is outrunning the build. Lower spawn.ramp.hp or countPerDifficulty.`,
      });
    } else if (last.gap > 2.5) {
      flags.push({
        level: 'warn',
        code: 'ramp-flat',
        text: `By ${where} your damage grew ${last.playerGrowth.toFixed(1)}x against only ${last.enemyGrowth.toFixed(1)}x enemy pressure — the build outruns the ramp. Raise spawn.ramp.hp.`,
      });
    } else if (floodAt == null) {
      // Only worth saying when nothing else went wrong. A run that flooded and
      // died does not get told its curves tracked each other, however close
      // the ratio came out — the arena filling up IS the curves not tracking.
      flags.push({
        level: 'ok',
        code: 'ramp-ok',
        text: `Power curves tracked each other to ${where} (you ${last.playerGrowth.toFixed(1)}x vs enemies ${last.enemyGrowth.toFixed(1)}x).`,
      });
    }
  }

  // Lethality — the damage side of the ramp, which hp scaling alone hides.
  const lateBuckets = buckets.slice(Math.floor(buckets.length / 2));
  const peakLethal = Math.max(...buckets.map((b) => b.lethalPerMin));
  const peakAt = buckets.find((b) => b.lethalPerMin === peakLethal)?.t ?? 0;
  // Whether the peak IS the death — if the worst window is the one the run
  // ended in, calling it "still survivable" is plainly wrong.
  const peakKilled = run.endReason === 'death' && peakAt === finalBucket.t;
  if (peakLethal >= BALANCE.brutalPerMin) {
    flags.push({
      level: 'bad',
      code: 'lethal',
      text: `At ${formatClock(peakAt)} the fight was dealing ${peakLethal.toFixed(1)} health bars per minute — past what dodging can cover. Cut spawn.ramp.damage.`,
    });
  } else if (peakLethal >= BALANCE.lethalPerMin) {
    flags.push({
      level: peakKilled ? 'bad' : 'warn',
      code: 'lethal-warn',
      text: peakKilled
        ? `Incoming damage peaked at ${peakLethal.toFixed(1)} health bars/min at ${formatClock(peakAt)} — that window is what ended the run.`
        : `Peak incoming ${peakLethal.toFixed(1)} health bars/min at ${formatClock(peakAt)} — sharp, still survivable.`,
    });
  } else if (lateBuckets.length && Math.max(...lateBuckets.map((b) => b.lethalPerMin)) < 0.25) {
    flags.push({
      level: 'warn',
      code: 'harmless',
      text: 'Late-run incoming damage never reached a quarter of a health bar per minute — enemies stopped being able to hurt you.',
    });
  }

  // How much of the run was played at the edge. Distinct from lethality: you
  // can take a lot of damage and never be in danger if regen keeps up.
  const timeLow = buckets.reduce((a, b) => a + b.lowHpFrac * b.seconds, 0);
  const lowShare = safeDiv(timeLow, run.duration);
  if (lowShare > 0.25) {
    flags.push({ level: 'warn', code: 'edge', text: `${Math.round(lowShare * 100)}% of the run was spent under 30% hp.` });
  } else if (lowShare < 0.02 && run.duration > 180) {
    flags.push({ level: 'info', code: 'never-threatened', text: 'Never meaningfully dropped below 30% hp.' });
  }

  return flags;
}

function abilityFlags(rows) {
  const flags = [];
  for (const r of rows) {
    if (r.control) continue; // judged on events, not damage — see below
    if (r.damageShare >= BALANCE.opMinShare && r.efficiency >= BALANCE.opEfficiency) {
      flags.push({
        level: 'bad',
        code: `op:${r.source}`,
        text: `${r.label} did ${Math.round(r.damageShare * 100)}% of all damage on ${Math.round(r.investShare * 100)}% of the investment (${r.efficiency.toFixed(1)}x its weight, ${r.stacks} pick${r.stacks === 1 ? '' : 's'}) — overtuned.`,
      });
    } else if (r.stacks >= BALANCE.weakMinStacks && r.efficiency > 0 && r.efficiency <= BALANCE.weakEfficiency) {
      flags.push({
        level: 'warn',
        code: `weak:${r.source}`,
        text: `${r.label} returned only ${r.efficiency.toFixed(2)}x its weight across ${r.stacks} picks — a dead pick at this tuning.`,
      });
    }
  }
  // A build where one source is most of the damage is worth saying out loud
  // even when its investment justifies it: it means every other pick was
  // decoration.
  const top = rows.filter((r) => !r.control)[0];
  if (top && top.damageShare > 0.6) {
    flags.push({
      level: 'warn',
      code: 'monoculture',
      text: `${top.label} alone was ${Math.round(top.damageShare * 100)}% of the run's damage — the rest of the build barely mattered.`,
    });
  }
  return flags;
}

/**
 * Analyse one recorded run.
 * @param {object} run as produced by playtest.js
 */
export function analyzeRun(run) {
  const buckets = deriveBuckets(run);
  const curve = growthCurve(buckets);
  const { rows, totalDamage } = abilityTable(run, buckets);
  const flags = [...scalingFlags(run, buckets, curve), ...abilityFlags(rows)];

  const takenByEnemy = {};
  for (const b of buckets) {
    for (const src in b.takenBySource) takenByEnemy[src] = (takenByEnemy[src] ?? 0) + b.takenBySource[src];
  }
  const threats = Object.entries(takenByEnemy)
    .map(([source, damage]) => ({ source, damage, share: safeDiv(damage, sum(takenByEnemy)) }))
    .sort((a, b) => b.damage - a.damage);

  return {
    id: run.id,
    startedAt: run.startedAt,
    duration: run.duration,
    endReason: run.endReason,
    level: run.level,
    kills: run.kills,
    score: run.score,
    config: run.config,
    buckets,
    curve,
    abilities: rows,
    totalDamage,
    threats,
    flags,
    verdict: verdictLine(flags),
  };
}

function verdictLine(flags) {
  const bad = flags.filter((f) => f.level === 'bad').length;
  const warn = flags.filter((f) => f.level === 'warn').length;
  if (bad) return { level: 'bad', text: `${bad} balance problem${bad === 1 ? '' : 's'} found` };
  if (warn) return { level: 'warn', text: `${warn} thing${warn === 1 ? '' : 's'} worth a look` };
  return { level: 'ok', text: 'Scaling and abilities look balanced' };
}

/**
 * Aggregate several runs. One run is an anecdote — death time swings wildly
 * with how well the player dodged that day. Balance verdicts only start
 * meaning anything at three or four, which is why the CLI leads with this.
 */
export function analyzeRuns(runs) {
  const singles = runs.map(analyzeRun);
  const usable = singles.filter((r) => r.duration >= 60);
  const deaths = usable.filter((r) => r.endReason === 'death').map((r) => r.duration);

  // Mean clear ratio and lethality per minute ACROSS runs, so a single lucky
  // or disastrous run can't set the curve.
  const perMinute = new Map();
  for (const r of usable) {
    for (const b of r.buckets) {
      const minute = Math.floor(b.t / 60);
      if (!perMinute.has(minute)) perMinute.set(minute, { minute, runs: new Set(), clear: [], lethal: [], hp: [], dps: [], pressure: [] });
      const slot = perMinute.get(minute);
      // Runs, not buckets — two 30-second buckets from one run are one run's
      // worth of evidence, and counting them as two made a single run look
      // like corroboration.
      slot.runs.add(r.id);
      slot.clear.push(b.clearRatio);
      slot.lethal.push(b.lethalPerMin);
      slot.hp.push(b.avgHpFrac);
      slot.dps.push(b.dps);
      slot.pressure.push(b.pressure);
    }
  }
  const timeline = [...perMinute.values()]
    .sort((a, b) => a.minute - b.minute)
    .map((s) => ({
      minute: s.minute,
      runs: s.runs.size,
      clearRatio: median(s.clear),
      lethalPerMin: median(s.lethal),
      avgHpFrac: median(s.hp),
      dps: median(s.dps),
      pressure: median(s.pressure),
    }));

  // How often each flag fired, so "garlic is OP" carries a 4-of-5 rather than
  // resting on the one run where it happened to be the only pick offered.
  const flagCounts = new Map();
  for (const r of singles) {
    for (const f of r.flags) {
      if (f.level === 'ok' || f.level === 'info') continue;
      const prev = flagCounts.get(f.code) ?? { code: f.code, level: f.level, runs: 0, text: f.text };
      prev.runs += 1;
      flagCounts.set(f.code, prev);
    }
  }

  // Ability efficiency pooled across runs, weighted by stack-minutes so a
  // source that was carried for one bucket in one run doesn't outrank one
  // that has been measured for an hour.
  const pooled = new Map();
  for (const r of singles) {
    for (const a of r.abilities) {
      const prev = pooled.get(a.source) ?? { source: a.source, label: a.label, control: a.control, damage: 0, kills: 0, events: 0, stackMinutes: 0, runs: 0 };
      prev.damage += a.damage;
      prev.kills += a.kills;
      prev.events += a.events;
      prev.stackMinutes += a.stackMinutes;
      prev.runs += 1;
      pooled.set(a.source, prev);
    }
  }
  const pooledRows = [...pooled.values()];
  const poolDamage = pooledRows.reduce((s, a) => s + a.damage, 0);
  const poolStackMinutes = pooledRows.reduce((s, a) => s + a.stackMinutes, 0);
  for (const a of pooledRows) {
    a.damageShare = safeDiv(a.damage, poolDamage);
    a.investShare = safeDiv(a.stackMinutes, poolStackMinutes);
    a.efficiency = safeDiv(a.damageShare, a.investShare);
    a.dpsPerStackMinute = safeDiv(a.damage, a.stackMinutes);
  }
  pooledRows.sort((a, b) => b.damage - a.damage);

  return {
    runs: singles,
    runCount: singles.length,
    usableCount: usable.length,
    medianSurvival: median(deaths),
    survivalSpread: deaths.length ? [Math.min(...deaths), Math.max(...deaths)] : [0, 0],
    timeline,
    abilities: pooledRows,
    flags: [...flagCounts.values()].sort((a, b) => b.runs - a.runs),
    confident: usable.length >= 3,
  };
}

// ---------------------------------------------------------------------------
// Text rendering — shared by the console dump and the CLI
// ---------------------------------------------------------------------------

function bar(value, scale, width = 12) {
  const n = Math.max(0, Math.min(width, Math.round((value / scale) * width)));
  return '#'.repeat(n).padEnd(width, '.');
}

const MARK = { bad: '!!', warn: ' !', ok: ' +', info: ' ·' };

export function formatRunReport(a) {
  const L = [];
  L.push(`RUN ${formatClock(a.duration)} — level ${a.level}, ${a.kills} kills, ${Math.round(a.score).toLocaleString()} pts (${a.endReason})`);
  L.push(`${MARK[a.verdict.level]} ${a.verdict.text.toUpperCase()}`);
  L.push('');
  L.push('  time   dps   arriving  clear  in/min  hp%  alive  lvl  +lvl');
  let prevLevel = 1;
  for (const b of a.buckets) {
    // Levels gained per bucket, alongside the difficulty numbers — pacing and
    // pressure are the two halves of the same question, and reading them in
    // separate tables is how "levels come too fast" stays a matter of opinion.
    const gained = Math.max(0, b.level - prevLevel);
    prevLevel = b.level;
    L.push([
      `  ${formatClock(b.t).padStart(5)}`,
      String(Math.round(b.dps)).padStart(6),
      String(Math.round(b.pressure)).padStart(9),
      `${b.clearRatio.toFixed(1)}x`.padStart(7),
      b.lethalPerMin.toFixed(2).padStart(7),
      `${Math.round(b.avgHpFrac * 100)}%`.padStart(5),
      String(Math.round(b.avgAlive)).padStart(6),
      String(b.level).padStart(5),
      gained ? `+${gained}`.padStart(6) : ''.padStart(6),
    ].join(''));
  }
  L.push('');
  L.push('  ability            damage   share  picks  return  per stack-min');
  for (const r of a.abilities) {
    if (r.damage <= 0) continue; // a row appears wherever it did the work
    L.push([
      `  ${r.label.padEnd(18)}`,
      String(Math.round(r.damage)).padStart(7),
      `${Math.round(r.damageShare * 100)}%`.padStart(7),
      String(r.stacks).padStart(6),
      `${r.efficiency.toFixed(2)}x`.padStart(8),
      String(Math.round(r.dpsPerStackMinute)).padStart(14),
    ].join(''));
  }
  const control = a.abilities.filter((r) => r.events > 0);
  if (control.length) {
    L.push('');
    L.push('  control            events  picks   per stack-min');
    for (const r of control) {
      L.push([
        `  ${r.label.padEnd(18)}`,
        String(Math.round(r.events)).padStart(6),
        String(r.stacks).padStart(7),
        safeDiv(r.events, r.stackMinutes).toFixed(1).padStart(15),
      ].join(''));
    }
  }
  if (a.threats.length) {
    L.push('');
    L.push(`  hurt by: ${a.threats.slice(0, 5).map((t) => `${t.source} ${Math.round(t.share * 100)}%`).join(', ')}`);
  }
  L.push('');
  for (const f of a.flags) L.push(`${MARK[f.level]} ${f.text}`);
  return L.join('\n');
}

export function formatAggregateReport(agg) {
  const L = [];
  L.push(`${agg.runCount} run${agg.runCount === 1 ? '' : 's'} recorded, ${agg.usableCount} long enough to judge.`);
  if (!agg.confident) L.push('NOTE: fewer than 3 usable runs — treat everything below as a hint, not a verdict.');
  if (agg.medianSurvival) {
    L.push(`Median survival ${formatClock(agg.medianSurvival)} (${formatClock(agg.survivalSpread[0])}–${formatClock(agg.survivalSpread[1])}).`);
  }
  L.push('');
  L.push('  min  runs  clear rate      in/min  hp%');
  for (const t of agg.timeline) {
    L.push([
      `  ${String(t.minute).padStart(3)}`,
      String(t.runs).padStart(6),
      `  ${t.clearRatio.toFixed(1)}x`.padEnd(7),
      bar(t.clearRatio, 4),
      t.lethalPerMin.toFixed(2).padStart(8),
      `${Math.round(t.avgHpFrac * 100)}%`.padStart(5),
    ].join(''));
  }
  L.push('');
  L.push('  ability            damage   share  return  per stack-min  runs');
  for (const r of agg.abilities) {
    if (r.damage <= 0) continue;
    L.push([
      `  ${r.label.padEnd(18)}`,
      String(Math.round(r.damage)).padStart(7),
      `${Math.round(r.damageShare * 100)}%`.padStart(7),
      `${r.efficiency.toFixed(2)}x`.padStart(8),
      String(Math.round(r.dpsPerStackMinute)).padStart(15),
      String(r.runs).padStart(6),
    ].join(''));
  }
  L.push('');
  if (!agg.flags.length) {
    L.push(' + Nothing flagged across these runs.');
  } else {
    for (const f of agg.flags) L.push(`${MARK[f.level]} [${f.runs}/${agg.runCount} runs] ${f.text}`);
  }
  return L.join('\n');
}
