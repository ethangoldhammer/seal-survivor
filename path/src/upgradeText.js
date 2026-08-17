// ============================================================================
// UPGRADE TEXT — the {placeholders} you can write in the `desc` column.
//
// "+25% fire rate" was typed by hand into upgrades.csv, and the 0.75 that
// makes it true was typed by hand into config.js. Nothing held those two
// numbers together: change the multiplier to 0.7 and the card goes on
// promising 25% forever, on the level-up screen and in the Upgrades tab, and
// no test can catch it because a string and a number have no relationship to
// disagree about.
//
// So `{effect}` is not a second copy of the number. It RUNS the upgrade's own
// apply() against a probe stat block and describes what actually moved:
//
//   desc: "{effect}"                ->  "+25% fire rate"
//   desc: "{effect} per volley"     ->  "+1 seeking mussel per volley"
//   desc: "Bullets pierce {effect}" ->  "Bullets pierce +1 enemy"
//
// Change the 0.75 and the card changes with it, everywhere it is shown.
//
// HOW THE MEASUREMENT WORKS, and why it needs two probes: apply() bodies are
// opaque — `s.damage *= 1.4` and `s.damage += 40` are indistinguishable from
// one sample when damage happens to be 100. So every upgrade is replayed twice
// against stat blocks seeded differently. A change whose SIZE is the same in
// both is additive; one whose RATIO is the same in both is a multiplier;
// anything else (strikeChainMul compounds around 1) is reported as the plain
// before -> after it measured. No parsing of apply(), no second copy of its
// arithmetic, and nothing to keep in sync.
//
// The probes deliberately start from the REAL baseStats() rather than from the
// all-100 synthetic block tools/upgrade-test.mjs uses. That block hides
// first-pick branches: `s.shrimpCount ? s.shrimpCount + 1 : baseCount` reads a
// seeded 100 as truthy and never runs the branch that opens the ring. The
// first card is exactly the one whose text has to be right.
// ============================================================================

import { CONFIG } from './config.js';
import { baseStats } from './stats.js';

// ---------------------------------------------------------------------------
// WHAT EACH STAT IS CALLED, in the words a card would use.
//
// `kind` decides the phrasing, not the arithmetic — the arithmetic is
// measured. It says what the number MEANS once it's been measured:
//
//   percent  a multiplier, shown as +N%. `lower: true` marks the stats where
//            down is the improvement (fireRate is a cooldown), so a measured
//            *= 0.75 reads "+25% fire rate" rather than "-25%".
//   flat     an additive number shown as-is: "+30 max HP".
//   count    an additive whole number of things, with a noun that pluralises:
//            "+1 projectile", "+2 projectiles".
//   level    an ability's level. The 0 -> 1 stack UNLOCKS the ability and says
//            so; every stack after that is "+1 level", because what a level
//            does lives in that ability's own config and is not measurable
//            from the stat block.
//
// A stat with no entry here still works — it falls back to its raw name — so a
// new stat is a missing label, never a missing card.
// ---------------------------------------------------------------------------
export const STAT_TEXT = {
  // --- the seal ---
  maxHp:              { label: 'max HP', kind: 'flat' },
  maxSpeed:           { label: 'max speed', kind: 'percent' },
  pickupRadius:       { label: 'pickup radius', kind: 'percent' },
  chumGulpRadius:     { label: 'gulp radius', kind: 'percent' },
  regenPerSec:        { label: 'HP/sec', kind: 'flat' },
  maxOxygen:          { label: 'max oxygen', kind: 'flat' },
  oxygenRefillRate:   { label: 'surface refill speed', kind: 'percent' },

  // --- the gun ---
  fireRate:           { label: 'fire rate', kind: 'percent', lower: true },
  damage:             { label: 'projectile damage', kind: 'percent' },
  speed:              { label: 'projectile speed', kind: 'percent' },
  multishot:          { label: 'projectile', kind: 'count' },
  // Reads as the tail of a sentence — "Bullets pierce {effect}" — because
  // that is the shape the card has always had.
  pierce:             { label: 'enemy', kind: 'count', plural: 'enemies' },
  // Sits at 0 by default, so `recoil *= 1.3` measures as no change at all and
  // {effect} correctly declines to claim one. The label is here for the day
  // the base is raised off zero.
  recoil:             { label: 'recoil boost', kind: 'percent' },
  projectileBonus:    { label: 'of everything you fire', kind: 'count', bare: true },

  // --- the strike ---
  strikeDamage:       { label: 'strike damage', kind: 'percent' },
  strikeChainMul:     { label: 'chain damage', kind: 'percent' },
  strikeDashSpeed:    { label: 'dash speed', kind: 'percent' },
  strikeDashDuration: { label: 'dash length', kind: 'percent' },
  strikeChargeTime:   { label: 'charge speed', kind: 'percent', lower: true },
  strikeChumRefill:   { label: 'meter per chum', kind: 'flat', percentOfOne: true },
  shrapnelCount:      { label: 'fragment', kind: 'count' },
  breachChainLevel:   { label: 'link per breach', kind: 'count' },

  // --- the cross-cutting four ---
  aoeMul:             { label: 'blast, aura and wave size', kind: 'percent' },
  targetingMul:       { label: 'targeting range', kind: 'percent' },
  companionScale:     { label: 'companion size', kind: 'percent' },
  companionDamageMul: { label: 'companion damage', kind: 'percent' },
  biolumLevel:        { label: 'element', kind: 'level', unlock: 'an element on your shots and strike' },

  // --- the ricochet shot, the one ability with real stats rather than a level ---
  bounceLevel:        { label: 'ricochet', kind: 'level', unlock: 'a chaining ricochet shot' },
  bounceFireRate:     { label: 'ricochet fire rate', kind: 'percent', lower: true },
  bounceLife:         { label: 'ricochet lifespan', kind: 'flat', unit: 's' },
  bounceMaxBounces:   { label: 'bounce', kind: 'count' },

  // --- companions and thrown things, counted ---
  missileCount:       { label: 'seeking mussel', kind: 'count' },
  shrimpCount:        { label: 'orbiting shrimp', kind: 'count', plural: 'orbiting shrimp' },
  scallopCount:       { label: 'wild scallop', kind: 'count' },

  // --- companions and thrown things, levelled ---
  garlicLevel:        { label: 'sea garlic', kind: 'level', unlock: 'a damaging aura' },
  eelLevel:           { label: 'electric eel', kind: 'level', unlock: 'chain lightning' },
  laserEyesLevel:     { label: 'laser eyes', kind: 'level', unlock: 'eye beams' },
  starfishLevel:      { label: 'starfish', kind: 'level', unlock: 'rapid thrown starfish' },
  seagullLevel:       { label: 'seagull', kind: 'level', unlock: 'homing dive-bombers' },
  belugaLevel:        { label: 'beluga', kind: 'level', unlock: 'a bubble that traps enemies' },
  sealTeamLevel:      { label: 'escort seal', kind: 'count' },
  bakalarLevel:       { label: "Bakalar's boat", kind: 'level', unlock: 'a net full of bombs' },
  calamariLevel:      { label: 'calamari ring', kind: 'level', unlock: 'rings of fried squid' },
  dumboLevel:         { label: 'dumbo octopus', kind: 'level', unlock: 'a charm on nearby enemies' },
  harpLevel:          { label: 'harp seal', kind: 'level', unlock: 'notes that charm the biggest enemy near you' },
  oysterLevel:        { label: 'oyster blaster', kind: 'level', unlock: 'bursting pearls' },
  octoGrabLevel:      { label: 'octopus grabber', kind: 'level', unlock: 'tentacles that reel fish in' },
  orcaLevel:          { label: 'orca family', kind: 'level', unlock: 'three orcas hunting the boats' },
  // The card that raises this is a STUB — disabled in upgrades.csv, and no
  // system reads the stat yet (see CONFIG.upgrades.dolphinPod). The label is
  // here anyway because npm run test:text fails on a stat without one, which
  // is the check working: the day the card is switched on, its `{effect}`
  // has to render as English rather than as `dolphinPodLevel`.
  dolphinPodLevel:    { label: 'dolphin pod', kind: 'level', unlock: 'a pod of dolphins working the surface' },
  musselVolleyLevel:  { label: 'mussel barrage', kind: 'level', unlock: 'a barrage on a full-charge strike' },
  clubLevel:          { label: 'club', kind: 'level', unlock: 'a club on each fin tip' },
  clubThrowLevel:     { label: 'thrown club', kind: 'level', unlock: 'hurled homing clubs on a strike' },
  clubBoomLevel:      { label: 'club blast', kind: 'level', unlock: 'every club hit detonates' },
  clubIceLevel:       { label: 'club ice', kind: 'level', unlock: 'every club hit chills, and freezes when it saturates' },
  homingShotLevel:    { label: 'sonar teeth', kind: 'level', unlock: 'shots that seek, favouring the biggest body in reach' },

  // --- the two cards whose worth is not in their apply() ---
  // Both count stacks and nothing else, deliberately: what a stack is WORTH
  // depends on a running total (Maneater) or on a stat other cards move (Iron
  // Lung), and neither is visible from inside apply(). See applyDamageScaling
  // in stats.js. That makes 'level' the honest kind here — {effect} on either
  // card would otherwise have to invent a number, which is the exact failure
  // the measured descriptions exist to prevent.
  maneaterLevel:      { label: 'maneater', kind: 'level', unlock: 'a taste for swimmers — every one you eat raises all your damage' },
  ironLungLevel:      { label: 'iron lung', kind: 'level', unlock: 'all damage scaling with your maximum oxygen' },
};

// ---------------------------------------------------------------------------
// MEASUREMENT
// ---------------------------------------------------------------------------

// A second stat block, same shape, different numbers. 1.37 rather than 2 so a
// measured ratio can't be confused with a doubling somewhere in apply(), and
// zeros stay zero so that `?? 0` seeding and `s.x ? a : b` first-pick branches
// take the same path in both probes — the probes must differ in VALUE without
// differing in BEHAVIOUR.
function perturbed() {
  const s = baseStats();
  for (const k of Object.keys(s)) if (typeof s[k] === 'number' && s[k] !== 0) s[k] *= 1.37;
  return s;
}

function replay(upgrade, seed, stacks) {
  const s = seed();
  const steps = [];
  for (let i = 0; i < stacks; i++) {
    const before = { ...s };
    upgrade.apply(s);
    steps.push({ before, after: { ...s } });
  }
  return steps;
}

const near = (a, b) => Math.abs(a - b) <= Math.abs(a || b || 1) * 1e-9;

// What the `stack`-th application of this upgrade does, as a list of changes.
// `stack` is 1-based: stack 1 is the first card, the one whose branches the
// all-100 synthetic block would have skipped.
//
// Returns [] rather than throwing on an upgrade whose apply() blows up — a
// broken card should render its own text, not take the level-up screen down.
export function measure(upgrade, stack = 1) {
  if (typeof upgrade?.apply !== 'function') return [];
  let a, b;
  try {
    a = replay(upgrade, baseStats, stack);
    b = replay(upgrade, perturbed, stack);
  } catch {
    return [];
  }

  const stepA = a[stack - 1], stepB = b[stack - 1];
  const out = [];
  for (const k of Object.keys(stepA.after)) {
    const fromA = stepA.before[k], toA = stepA.after[k];
    if (fromA === toA || typeof toA !== 'number' || !Number.isFinite(toA)) continue;
    const fromB = stepB.before[k], toB = stepB.after[k];

    const dA = toA - fromA, dB = toB - fromB;
    const rA = fromA === 0 ? null : toA / fromA;
    const rB = fromB === 0 ? null : toB / fromB;

    // Additive first: on a stat seeded at 0 the two probes are identical, and
    // a multiplier could never have moved it off zero anyway.
    if (near(dA, dB)) out.push({ stat: k, how: 'add', amount: dA, from: fromA, to: toA });
    else if (rA != null && rB != null && near(rA, rB)) out.push({ stat: k, how: 'mul', ratio: rA, from: fromA, to: toA });
    else out.push({ stat: k, how: 'other', from: fromA, to: toA });
  }
  return out;
}

// Everything `stacks` applications add up to, measured from a fresh seal. Used
// by {total} — "what do I have now", as opposed to {effect}'s "what does this
// card hand me".
export function measureTotal(upgrade, stacks = 1) {
  if (typeof upgrade?.apply !== 'function' || stacks < 1) return [];
  let a, b;
  try {
    a = replay(upgrade, baseStats, stacks);
    b = replay(upgrade, perturbed, stacks);
  } catch {
    return [];
  }
  const first = a[0].before, last = a[stacks - 1].after;
  const firstB = b[0].before, lastB = b[stacks - 1].after;

  const out = [];
  for (const k of Object.keys(last)) {
    if (first[k] === last[k] || typeof last[k] !== 'number' || !Number.isFinite(last[k])) continue;
    const dA = last[k] - first[k], dB = lastB[k] - firstB[k];
    const rA = first[k] === 0 ? null : last[k] / first[k];
    const rB = firstB[k] === 0 ? null : lastB[k] / firstB[k];
    if (near(dA, dB)) out.push({ stat: k, how: 'add', amount: dA, from: first[k], to: last[k] });
    else if (rA != null && rB != null && near(rA, rB)) out.push({ stat: k, how: 'mul', ratio: rA, from: first[k], to: last[k] });
    else out.push({ stat: k, how: 'other', from: first[k], to: last[k] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHRASING
// ---------------------------------------------------------------------------

// Trim float noise without lying about a real decimal: 1.4000000000000001 is
// 1.4, and 0.5 stays 0.5.
function num(n) {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}

function pct(ratio, lower) {
  const frac = lower ? 1 - ratio : ratio - 1;
  const p = Math.round(Math.abs(frac) * 1000) / 10;
  return `${frac < 0 ? '-' : '+'}${num(p)}%`;
}

function plural(text, n) {
  const t = STAT_TEXT[text.stat] ?? {};
  if (Math.abs(n) === 1 || !t.label) return t.plural && Math.abs(n) !== 1 ? t.plural : t.label;
  return t.plural ?? `${t.label}s`;
}

// One measured change as a phrase. Everything here is about WORDING; the
// numbers arrived already measured.
export function phrase(change, stack = 1) {
  const t = STAT_TEXT[change.stat] ?? { label: change.stat, kind: 'flat' };

  if (t.kind === 'level') {
    // Exactly 0 -> 1 is the card that turns the ability on, and "unlocks chain
    // lightning" is the only text that tells a player what they just bought.
    //
    // The `to === 1` half is not redundant: {total} measures 0 -> 9 across a
    // maxed Sea Garlic, which also starts at zero, and calling nine levels
    // "unlocks a damaging aura" would quietly lose the nine.
    if (change.from === 0 && change.to === 1 && t.unlock) return `unlocks ${t.unlock}`;
    const step = change.how === 'add' ? change.amount : change.to - change.from;
    return `+${num(step)} ${t.label} level${Math.abs(step) === 1 ? '' : 's'}`;
  }

  if (t.kind === 'count') {
    const n = change.how === 'add' ? change.amount : change.to - change.from;
    const noun = plural(change, n);
    return t.bare ? `+${num(n)} ${noun}` : `+${num(n)} ${noun}`;
  }

  if (change.how === 'mul') return `${pct(change.ratio, t.lower)} ${t.label}`;

  if (change.how === 'add') {
    // A per-unit fraction reads better as a percentage of the thing it fills.
    if (t.percentOfOne) return `+${num(Math.round(change.amount * 1000) / 10)}% ${t.label}`;
    return `+${num(change.amount)}${t.unit ?? ''} ${t.label}`;
  }

  // Compounding, or anything else the two probes disagreed about. Reporting
  // the measured endpoints is honest and still useful: "chain damage 1.6 -> 1.78".
  return `${t.label} ${num(change.from)} → ${num(change.to)}`;
}

// The changes joined the way a card would read them.
//
// A "+1 level" that arrives alongside real stats is dropped: bounceShot moves
// bounceLevel AND three ricochet numbers, and the level adds nothing next to
// the numbers that say what it did. An UNLOCK is kept even so — on the first
// ricochet card, "unlocks a chaining ricochet shot" is the part that says what
// was just bought, and the three numbers are the footnote.
export function phraseAll(changes, stack = 1) {
  if (!changes.length) return '';
  const keep = changes.filter((c) => {
    if ((STAT_TEXT[c.stat]?.kind ?? 'flat') !== 'level') return true;
    return c.from === 0 && STAT_TEXT[c.stat]?.unlock;
  });
  const use = keep.length ? keep : changes;
  // Unlocks lead, whatever order the stat block happened to be in.
  use.sort((a, b) => (b.from === 0 && STAT_TEXT[b.stat]?.kind === 'level' ? 1 : 0)
                   - (a.from === 0 && STAT_TEXT[a.stat]?.kind === 'level' ? 1 : 0));
  return use.map((c) => phrase(c, stack)).join(', ');
}

// ---------------------------------------------------------------------------
// THE TOKENS
// ---------------------------------------------------------------------------

// Documented here and nowhere else: the CSV editor reads this array to build
// its insert menu, so a token added below shows up in the editor with its
// explanation and needs no second edit.
export const TOKENS = [
  { token: '{effect}', help: 'What this card grants, measured from its apply(). "+25% fire rate"' },
  { token: '{effect:2}', help: 'The same, for a specific stack number — what the 2nd copy would add.' },
  { token: '{total}', help: 'Everything the stacks you own add up to, including this one.' },
  { token: '{name}', help: 'The card name from the `name` column.' },
  { token: '{level}', help: 'Which stack this card would be. 1 for the first.' },
  { token: '{owned}', help: 'How many you already have. 0 before the first pick.' },
  { token: '{stacks}', help: 'The cap from `maxStacks`, or "unlimited" when blank.' },
  { token: '{cfg:weapon.damage}', help: 'Any number from CONFIG, so tuned values quote themselves.' },
];

// Deliberately NOT memoised. A cache keyed on upgrade id would be stale the
// moment the ` tuner moved anything apply() reads — bounceShot quotes
// CONFIG.bounce.maxBouncesPerLevel directly — and a card quietly showing the
// pre-tuning number is worse than the cost of measuring again. That cost is
// four copies of a ~90-field object per card, on a screen that draws three.
function readConfigPath(path) {
  let node = CONFIG;
  for (const part of path.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

// Replace every {token} in `text`.
//
// An unknown token is LEFT ON THE CARD as literal "{whoops}" rather than
// silently removed. A blank where a number should be looks like a rendering
// bug and gets reported as one; the token spelled out points straight at the
// cell that has the typo in it.
export function expandDesc(text, upgrade, { owned = 0, warn = null } = {}) {
  if (!text || !text.includes('{')) return text ?? '';
  const level = owned + 1;

  return String(text).replace(/\{([a-zA-Z]+)(?::([^}]*))?\}/g, (whole, key, arg) => {
    switch (key) {
      case 'effect': {
        const stack = arg ? Number(arg) : level;
        if (!Number.isFinite(stack) || stack < 1) return whole;
        return phraseAll(measure(upgrade, stack), stack) || whole;
      }
      case 'total':
        return phraseAll(measureTotal(upgrade, level), level) || whole;
      case 'name':
        return upgrade?.name ?? whole;
      case 'level':
        return String(level);
      case 'owned':
        return String(owned);
      case 'stacks':
        return upgrade?.maxStacks == null ? 'unlimited' : String(upgrade.maxStacks);
      case 'cfg': {
        const v = readConfigPath(arg ?? '');
        if (v == null || typeof v === 'object') {
          warn?.(`[upgrades] "${upgrade?.id}" asks for {cfg:${arg}}, which isn't a value in CONFIG — leaving the token on the card.`);
          return whole;
        }
        return typeof v === 'number' ? num(v) : String(v);
      }
      default:
        warn?.(`[upgrades] "${upgrade?.id}" uses {${key}}, which isn't a known placeholder — leaving it on the card. Known: ${TOKENS.map((t) => t.token).join(' ')}`);
        return whole;
    }
  });
}
