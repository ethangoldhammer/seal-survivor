import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { projectileCount } from '../stats.js';
import { spawnProjectile } from '../entities/projectiles.js';
import { ease, isEasing } from '../ease.js';
import { removeEnemy, applyKnockback, staggerBoss } from '../entities/enemies.js';
import { applyElementalHit } from './elements.js';
import { markTarget } from './marks.js';
import { hitCreature } from './hitShape.js';
import { hotSpotDamage, hotSpotUnder } from './bossHotSpots.js';
import { noteChain, tickChainTrace } from './chainTrace.js';
import { versusActive } from './versusFlag.js';

// Where the dash last connected on a body. Shared and consumed immediately —
// see the note on combat.js's own `contact`.
const strikeContact = { x: 0, y: 0, nx: 0, ny: 0, depth: 0, sphere: null, index: -1 };

// The strike is a CHARGE-UP. Holding the button fills a single meter (about a
// second from empty); releasing spends it and gives the ship a strong
// velocity impulse toward the aim direction. How hard you charged sets both
// the force and the dash's REACH, so a full-charge strike travels far enough
// to plough through a whole crowd.
//
// A STRIKE IS NOT AN ATTACK until you buy it one. What a base dash does is
// SHOVE: anything it touches is knocked off its line (applyKnockback), anything
// big enough is PAINTED for the homing weapons (systems/marks.js), and the
// release hoovers up every chum orb in reach. What damage it has goes off as a
// small BLAST at the point of release — see strikeBurst() below and
// CONFIG.strike.burst — rather than being smeared across whatever the dash
// clipped on the way past. The strike-family cards in CONFIG.upgrades each add
// a slice of real bite to it.
//
// That is the shape of the whole mechanic: the seal is repositioning, feeding
// and spotting, and the mussels, the squad and the pod are what kills. A run
// that pours picks into the strike line turns it back into a weapon.
//
// That reach is the point, because the meter refills by EATING: every chum
// swallowed inside the combo window puts some back, and the moment it crosses
// to full again that scores a FOOD CHAIN link and leaves you charged for the
// next strike. Charge -> strike -> eat -> strike is a cycle that powers
// itself for as long as there is food in the water. A dash CONNECTING is no
// longer one of those links (CONFIG.strike.chainOn.strikeHit, default off):
// the chain is paid for in food, and a shove is not a meal.
//
// THE BAR IS COUNTED IN PIPS, AND ONE CHUM IS ALWAYS EXACTLY ONE PIP.
//
// This replaced a compounding discount (`chainRefillFalloff`) that made a
// mouthful worth 0.20 of the bar, then 0.164, then 0.134, with nothing on
// screen saying so. The bar filled at a different rate every link for reasons
// the player could not see, which is the single thing that made it read as
// unpredictable.
//
// AND THE BAR NEVER CHANGES LENGTH. A link used to add a pip, as an escalation
// making each one dearer than the last; a link is a single mouthful now and is
// not bought with the bar at all. See pipCount for why that escalation could
// not have survived per-pip links even if the job had remained.
//
// The pip count is DERIVED from the refill rather than configured beside it:
// pips = round(1 / strikeChumRefill). That keeps Coiled Spring meaningful
// without a second knob — the card raises the refill, which lowers the pip
// count, taking a link from five mouthfuls to three exactly as its text says.
//
// The chain also survives on things that aren't dash hits — emptying a school,
// breaching the surface with Porpoising taken; see chainStrike() and
// CONFIG.strike.chainOn. Blue orbs fill the meter outright, and their spawn is
// just a timer here; the caller (main.js) owns actually spawning them, since
// that needs the scene and the pickup system.

export function createStrikeState() {
  return {
    charge: 0,       // 0..1 — the FUEL bar. Burned by holding, refilled by food.
    pending: 0,      // power banked so far for the strike being wound up, 0..1
    charging: false, // holding AND there is fuel left to burn
    // Pips spent by THIS wind-up, counting from 0 on the frame the hold
    // begins. What the burn run is pitched off (see onStrikeBurnPip), and it
    // rises rather than tracking the bar's level on purpose: the bar is going
    // DOWN while the strike is getting bigger, and the sound is about the
    // strike. Survives the release so the frames after it can still read what
    // the hold was worth.
    burnedPips: 0,
    // TURBO — see updateTurbo. `turboOn` is the latch: set when a wind-up is
    // held with the stick pushed, cleared when the hold ends (release, dash,
    // or an empty bar). `turbo` is the 0..1 blend the seal actually swims by,
    // eased toward the latch over CONFIG.strike.turbo.rampIn / rampOut.
    turboOn: false,
    turbo: 0,
    power: 0,        // the banked power the CURRENT dash was launched with, 0..1
    // Seconds left in which a pickup arriving at the mouth still counts as
    // having been struck by the dash that just ended. See
    // CONFIG.strike.pickupBlast.grace and pickupBlast() below.
    blastGrace: 0,
    // THE FOLLOW-THROUGH. Seconds of steering left over after the dash itself
    // has ended — the hands fade out over it instead of being cut off on the
    // frame the timer runs out. See CONFIG.strike.dashControl.followThrough.
    steerGrace: 0,
    steerGraceMax: 0,
    // THE HELD AIM — the aim hand's heading as far as this dash is concerned.
    //
    // A pointer aims at a POINT: input.js re-derives the mouse's and the aim
    // thumb's heading every frame as cursor-minus-seal, so a dash that flies
    // past the cursor sees the aim flip through 180 degrees with no hand
    // touching anything, and a seal steering toward it turned round. Measured
    // (tools/strike-corridor-test.mjs, THE OVERSHOOT): a full-charge mouse
    // strike released at a cursor 8 units away landed 92 degrees off its own
    // launch line. On a phone the thumb is always that close.
    //
    // So the dash keeps its own copy. tryStrike sets it to the launch heading
    // — no instruction yet — and it is replaced only on a frame the aim device
    // actually GESTURED (input.aimMoved), with the DIRECTION OF THE GESTURE
    // (input.aimGesture: a mouse flick up is up, a thumb slide is its slide,
    // a right stick is itself). An idle hand is not an instruction, and the
    // seal flying past a cursor nobody moved changes nothing. See holdAim().
    aim: { x: 0, y: 0 },
    aimSteer: false, // ...and whether a gesture has set it since the launch
    flash: 0,        // >0 = the bar is flashing, just spent (see strikeRing.js)
    // THE PERFECT CHARGE — the wind-up fully banked, `perfectAt` of the bar.
    //
    // The tell shipped first and on purpose: the meter's core pops on the frame
    // it lands (systems/strikeRing.js), `perfectCrossed()` below hands the edge
    // to main.js for the sound and the shake, and for a long while that was ALL
    // of it — power stayed a continuous 0..1 and a perfect strike was exactly as
    // strong as the arithmetic said. By the time it bought anything the timing
    // was already familiar.
    //
    // WHAT IT BUYS NOW. A ram that lands on a boss's WEAK SPOT deals the strike's
    // whole damage there — nothing anywhere else on the body — and a perfect
    // charge multiplies it (CONFIG.strike.weakSpot.perfectMul). `perfect` is a
    // latch that survives until the power is spent or thrown away, so the payoff
    // reads the stamp tryStrike takes rather than caring which frame it landed
    // on; see `perfectStrike` below. `perfectAt` is in weapons.csv because the
    // moment it pays for anything it is a balance number, not a look.
    perfect: false,  // the wind-up reached a full bank, and hasn't been spent
    perfectFlash: 0, // seconds left of the pop that announced it
    perfectStrike: false, // ...and whether the dash IN FLIGHT was bought with one
    // ---- THE SWEET SPOT ----------------------------------------------------
    //
    // A STRIKE ONLY BITES IF IT IS RELEASED ON THE BEAT. Outside the window the
    // dash still launches, at the full reach and speed the wind-up paid for — it
    // is simply a SPEED BOOST. No release burst, no contact damage, no prey
    // cull, no riders, and no FOOD CHAIN. That split is the mechanic:
    // repositioning is always available and never has to be earned, and
    // everything that kills or feeds is bought with timing.
    //
    // THE WINDOW IS ANCHORED ON THE "STRIKE NOW!" MOMENT, which is `loaded`
    // below: the frame the wind-up has nothing left to bank and enough banked to
    // fire. That is the same instant the callout goes up on the ring (main.js
    // reads strikeLoaded() for it) and the same instant the meter's core pops,
    // so what the player is TOLD and what the game is MEASURING cannot drift
    // apart — which they would the moment either end owned its own copy of the
    // test.
    //
    // MEASURED IN SECONDS EITHER SIDE OF IT, not as a fraction of the bar, and
    // it has to be. `pending` clamps at 1 and `charge` bottoms at 0, so past the
    // loaded moment NOTHING in the meter moves: a bar-fraction window would have
    // an early edge and no late one at all — no way to be too slow — which is
    // half of what a timing window is for. Two numbers carry it, one per side.
    loaded: false,       // the wind-up is fully loaded: the STRIKE NOW! moment
    sinceLoaded: 0,      // seconds since that moment (0 until it happens)
    toLoaded: Infinity,  // seconds still to run before it
    sweetStrike: false,  // ...and whether the dash IN FLIGHT was released inside it
    // WHETHER THE DASH IN FLIGHT ARMS A FOOD CHAIN — a perfect charge OR an
    // on-beat release. Deliberately a separate stamp from `sweetStrike` rather
    // than a widening of it: the two conditions pay for different things now
    // (this one the chain, that one the damage) and collapsing them would put
    // the strike's whole damage output behind the charge again. See tryStrike.
    armingStrike: false,
    // A SWEET STRIKE HAS BEEN THROWN AND ITS CHAIN HAS NOT LAPSED.
    //
    // This is what makes eating count. The release does not score a link — it
    // ARMS one, and the chum the strike goes on to collect is what scores it, a
    // mouthful at a time. That is the loop as a player describes it: hit the
    // beat, eat what you flew through, watch the number climb.
    //
    // It used to be scored on the NEXT release, which needed two releases inside
    // one window with eating in between — two hits of a tenth-of-a-second window
    // before a single FOOD CHAIN! had ever appeared. Nobody could tell the
    // mechanic was working, because for most players it never got that far.
    //
    // Cleared where the window lapses (updateStrike), so a chain that dies takes
    // the arming with it and the next one has to be earned with another strike.
    armed: false,
    // ---- THE VERDICT ON THE LAST RELEASE -----------------------------------
    //
    // WHAT THE RING PLAYS BACK AFTER THE BUTTON COMES UP. `sweetStrike` above is
    // the same fact and cannot do this job: it is the stamp a dash IN FLIGHT
    // carries, so it says nothing about a release that happened a quarter of a
    // second ago and it is meaningless the instant the dash ends. These three
    // are a RECEIPT — latched on the release frame, counted down on their own
    // clock, and read by nothing that decides anything.
    //
    //   verdict        +1 on the beat, -1 outside it, 0 nothing to report
    //   verdictOffset  the SIGNED error, in seconds. Negative = let go early
    //                  (fuel still in the bar), positive = sat on it. This is
    //                  the number the code has always recorded for the telemetry
    //                  and never once shown the player — see noteChain('release')
    //                  below, where the comment says exactly that.
    //   verdictFlash   seconds left of it ringing out on the ring.
    //
    // Kept here rather than in `lastRelease` because that object is consumed on
    // read (main.js takes it on the release frame and the depth is wiped), and a
    // read-out that plays over half a second needs state that survives being
    // looked at.
    verdict: 0,
    verdictOffset: 0,
    verdictFlash: 0,
    active: false,
    dashTimeLeft: 0,
    dashDuration: 0, // what this dash's length was set to, for the i-frames
    dashDir: { x: 1, y: 0 },
    // ENGLISH on this dash: how far the swim disagreed with the aim on the
    // release, -1..1 (strikeEnglish). Only the versus ball reads it — a fish
    // has no face to spin — and it is snapshotted with dashDir so a dash in
    // flight carries the spin it was launched with, not the stick's now.
    english: 0,
    // TWO CHAIN COUNTERS, BOTH FED BY PIPS, DELIBERATELY DIFFERENT GRAINS.
    //
    //   chainPips  every mouthful eaten inside the window. Drives the MULTIPLIER
    //              — speed, damage, score — so the reward climbs with each orb
    //              rather than jumping once a bar.
    //   chainCount LINKS held inside the window. Drives the PRICE — the next
    //              link costs one more mouthful per link already banked, see
    //              linkCost() — and the FOOD CHAIN! banner, so the ceremony and
    //              the cost escalation stay on the number the player is reading.
    //
    // Splitting them is what made the chain reachable at all. It used to be one
    // counter that only moved when the bar topped off, which meant sustaining a
    // chain required emptying AND refilling the bar inside chainWindow — a
    // strike plus six mouthfuls in 1.1 seconds, or five to ten orbs a second.
    // Nothing on screen said so, which is why it was impossible to work out by
    // playing. Now ONE ORB keeps the chain alive; filling the bar is what makes
    // it louder.
    chainPips: 0,
    chainCount: 0,
    chainTimer: 0,
    // MOUTHFULS BANKED TOWARD THE NEXT LINK, and it exists because a link is not
    // one mouthful any more — it is linkCost() of them, one more per link already
    // held (CONFIG.strike.linkPipsPerLink). Spending the food the moment it
    // arrives and keeping the remainder here is what makes that price a PRICE
    // rather than a demand for a clean run of N: three chum, a release, two more,
    // and the five-mouthful link lands on the fifth orb whatever happened in
    // between. Dies with the chain, like chainPips.
    linkCredit: 0,
    // HOW MANY MORE PIPS OF BAR MAY SCORE THIS CYCLE — the food chain's budget.
    //
    // A link is a PIP OF FUEL GOING IN, not a mouthful going down, and a bar only
    // holds so many. So a chain grows by at most one barful per strike: eat the
    // bar up from empty and every pip is a link; fill it and the chain HOLDS,
    // however much food is still in the water, until another charged release
    // spends the bar and buys the next barful.
    //
    // That is what stops the chain being a function of how much chum happened to
    // be nearby. It was: a magnet sweep over a big pile was thirty links in a
    // second, which is why the logs have a 313-deep chain in them. Now the pile
    // is worth exactly one bar, and going deeper means going back and striking
    // again — the loop the whole system is named after.
    //
    // Set at the RELEASE rather than when the charge tops out, which is the same
    // moment in practice (holding seals the mouth, so nothing can be eaten in
    // between) and closes a loophole: an unspent budget cannot survive a release
    // and be spent after a fumbled one.
    pipBudget: 0,
    // MOUTHFULS EATEN SINCE THE LAST RELEASE. This is what arms the next strike
    // to score a FOOD CHAIN link — see tryStrike and linkPips().
    //
    // It replaced a "did the bar reach full" latch, which demanded a WHOLE bar
    // between strikes and was the single thing making the chain hard to reach in
    // ordinary play: five chum, then a wind-up, then a release, all inside the
    // window. A count lets the price be a FRACTION of the bar.
    //
    // Counted whether or not a window is open, because "food eaten since your
    // last strike" is the rule a player can actually hold in their head. There is
    // no hoarding exploit in that: it resets on every release, so eating twenty
    // orbs while cruising still leaves the next strike at zero.
    pipsSinceStrike: 0,
    invulnTimer: 0, // >0 = contact damage is ignored (see combat.js)
    // ---- PER-STATE BOOKKEEPING that used to be module-level -----------------
    // The bodies this dash has already connected with (one hit per creature
    // per dash), and the one-frame edge of a perfect charge landing.
    hits: new Set(),
    perfectEdge: false,
    // SOURCE NAME -> SECONDS until that source may add another link. A chain
    // source can arrive in bursts — a magnet sweep collects six orbs inside one
    // frame — and without a floor between links that alone would hold a chain
    // open indefinitely. Same reasoning as feedback.js's `sfxGaps`: a rate
    // limit on the channel that can't take the pile-up.
    //
    // PER STATE, because the throttle is per SEAL. It was one module map, which
    // is the same thing while there is one chain in the game; with a chain on
    // every seal in a match it would be one seal's mouthful shutting the source
    // off for everybody, and — worse — only the run's own state ticks the
    // clocks down (see updateStrike's `own`), so a CPU seal's first link would
    // have closed the source for the rest of the match.
    chainGaps: new Map(),
    // EVERY FOOD CHAIN LINK SCORED SINCE THE LAST READ, oldest first.
    //
    // It was `lastChain`, a single number, and that was a REPORTING bug with no
    // symptom anywhere in the scoring: the counter moved by one per link
    // exactly as it should, and the caller was handed only the number it ended
    // on. One swallow that completes two links, or a breach worth three with
    // Porpoising stacked, came out as x3 -> x5 — a read-out whose whole job is
    // to be counted, telling the player they had missed something they had not.
    //
    // A queue rather than a wider return value for the reason `lastRelease` is
    // held here: feedChum's boolean is "did this top the bar off", which its
    // callers branch on, and widening it would touch every call site to say
    // something one of them wants.
    //
    // Entries are `{ chain, source }` — the depth after that link, and what
    // CONFIG.strike.chainOn calls the thing that paid for it. Per link rather
    // than per drain, so a frame that mixes a mouthful with a breach can still
    // attribute each one. Per state for the same reason as the gaps above.
    chainLinks: [],
  };
}

// THE RUN'S OWN — player 1's. Everything below defaults to it, so the run
// reads exactly as it always did; a second seal (systems/versus.js) makes its
// own with createStrikeState() and hands it in.
export const strikeState = createStrikeState();

// Is a combo live? The dash itself plus the window that follows it. This gates
// the CHAIN LINK a refill can score — never the refill itself. A dash that
// connects with nothing opens no window, and gating refills on it would strand
// the player with a bar they had no way to fill.
export function isFeeding(s = strikeState) {
  return s.active || s.chainTimer > 0;
}

/**
 * HOW MUCH OF THE FOOD CHAIN'S WINDOW IS LEFT, 0..1. 0 means no chain running.
 *
 * ONE EXPRESSION, THREE INSTRUMENTS. The arc outside the ring (systems/
 * strikeRing.js) and the strip under the FOOD CHAIN! banner (ui/ui.js) are two
 * pictures of this one number, and a third would be along tomorrow. They used
 * to divide `chainTimer` by `CONFIG.strike.chainWindow` at their own call
 * sites, which is fine until the window stops being a constant — a card that
 * lengthened it would have to be found in every file that draws it, and the
 * one that got missed would drain at a plausible, wrong rate.
 *
 * Clamped at 1 rather than trusted: `chainTimer` is SET to the window on a
 * release, so the frame it opens divides exactly, and anything that ever hands
 * out a bonus refresh would push a bar past its own end.
 *
 * Takes the state to read, defaulting to the run's own, for exactly the reason
 * releaseOffset does: the look sheet (tools/looks/boost-core.js) poses a
 * hand-built state to draw the meter without running the charge economy, and a
 * reader pinned to this module's singleton would draw the LIVE chain on every
 * panel of it — which is to say an empty arc, forever.
 */
export function chainWindowLeft(s = strikeState) {
  if (!(s?.chainTimer > 0)) return 0;
  return Math.min(1, s.chainTimer / Math.max(0.05, CONFIG.strike.chainWindow));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Damage multiplier from how hard the live dash was charged. */
export function powerDamageMul(s = strikeState) {
  const c = CONFIG.strike.charge;
  return lerp(c.damageMulMin, c.damageMulMax, s.power);
}

/**
 * HOW MUCH HARDER A STRIKE BUILD MAKES A BODY FLINCH, as a multiplier on the
 * skeleton impulse and on nothing else.
 *
 * The ram's SHOVE is deliberately not upgrade-scaled: how far a creature is
 * thrown decides whether it can reach you next second, which is balance, and
 * it belongs to the charge. How hard it is seen to be hit decides nothing and
 * is the whole reward for having spent four cards on strike damage — a boss
 * that buckles where a first-level seal bounces off it.
 *
 * A CURVE, NOT THE RATIO. stats.strikeDamage runs past four times the base on
 * a committed build and a linear read of that is an animal whipping like a
 * flag; the exponent is what puts the payoff in the first few cards. Clamped
 * at both ends — never under 1, because a run that has somehow lost strike
 * damage should not be punished with a limper hit than it started with.
 *
 * @param stats the run's stat block. Null (or a base run) returns 1.
 */
export function strikeBoneGain(stats) {
  const k = CONFIG.strike?.knockback ?? {};
  const base = CONFIG.strike?.damage ?? 0;
  const have = stats?.strikeDamage ?? 0;
  if (!(base > 0) || !(have > 0)) return 1;
  const ratio = Math.max(1, have / base);
  return Math.min(k.boneUpgradeMax ?? 2.4, ratio ** (k.boneUpgradeExp ?? 0.5));
}

/**
 * What the strike's RIDERS are worth — Bone Shrapnel's fragments and Glow Up!'s
 * elemental half, both of which are authored as a fraction of "a strike".
 *
 * They cannot ride the ram's own damage any more. That number opens the run as
 * a chip (CONFIG.strike.contactDamage) and only becomes real once the strike
 * line has been bought into, so a fragment scaled to it would leave two cards
 * doing nothing on the runs that took them first. They ride the NOMINAL strike
 * instead — CONFIG.strike.damage, the number those fractions were tuned
 * against — carried up by the same charge and chain multipliers as the hit.
 *
 * The max() is what keeps a fully-invested strike line honest: once the ram
 * genuinely hits harder than the nominal, the riders go up with it rather than
 * being capped at the value they started from.
 *
 * @param dealt  what the ram actually took off this body
 * @param stats  the run's stat block (unused today; kept so a future
 *               per-run rider scale has somewhere obvious to land)
 */
export function riderDamage(dealt, stats = null) {
  // A RIDER RIDES A STRIKE THAT BIT. The max() below is measured against the
  // NOMINAL strike rather than against what the dash dealt, so without this a
  // release outside the sweet spot — which deals nothing at all — would still
  // hand Bone Shrapnel and Glow Up! a full-size number to scale off, and the
  // two cards would quietly be doing the damage the mistimed strike was
  // denied. See the sweet spot note on strikeState.
  if (!strikeState.sweetStrike) return 0;
  const nominal = (CONFIG.strike.damage ?? 0) * powerDamageMul() * chainDamageMul(stats);
  return Math.max(dealt, nominal);
}

/**
 * THE RELEASE BURST — what a strike is actually worth, in one place.
 *
 * Damage and reach both ride the banked power through the same curves the dash
 * itself does, so a flick pops around the seal and a full commitment clears a
 * body's width of water. Splash Zone widens it like any other blast; it does
 * NOT widen the damage, which is what `aoeMul` has always meant.
 *
 * Returned rather than applied because the blast is the caller's to resolve:
 * damage-in-a-radius already exists in main.js (the same queue every splash in
 * the game goes through, which is what makes this hit wreckage and crew as well
 * as fish), and the strike system has no business owning a second copy of it.
 *
 * Reads `strikeState.power`, i.e. what the dash was BOUGHT with — so the number
 * is the same whether it is asked for on the release frame or afterwards.
 *
 * @param stats the run's stat block
 * @returns {{damage: number, radius: number}} zero damage if the burst is off.
 */
export function strikeBurst(stats) {
  const b = CONFIG.strike.burst ?? {};
  if (b.enabled === false) return { damage: 0, radius: 0 };
  // OFF THE BEAT THERE IS NO BLAST, rather than a weaker one — and the RADIUS
  // goes with the damage, not just the number. The caller knocks bodies
  // outward across whatever radius comes back (see the release in main.js), so
  // a zero-damage circle would still throw a crowd apart and read as a hit
  // that happened to do nothing.
  if (!strikeState.sweetStrike) return { damage: 0, radius: 0 };
  const damage = (stats?.strikeDamage ?? 0) * powerDamageMul() * chainDamageMul(stats);
  const reach = (b.radius ?? 3)
    * lerp(1, b.radiusPowerMul ?? 1.5, strikeState.power)
    * (stats?.aoeMul ?? 1);
  return { damage, radius: reach };
}

/**
 * A PICKUP STRUCK MID-DASH — what goes off where the orb was. See
 * CONFIG.strike.pickupBlast for the design; this is the arithmetic, in one
 * place, so the release in main.js and the harness measure the same thing.
 *
 * Reads the LIVE dash: zero unless a dash is in flight (a pickup swum into at
 * cruising speed is just a pickup), and both axes ride `strikeState.power`
 * the way the release burst does — damage through the charge curve, radius
 * through its own. The damage rides the strike stat so it scales with the
 * run; Splash Zone widens the radius and leaves the damage alone, as it does
 * for every blast.
 *
 * NOT gated on the sweet spot. The release burst is a timing reward; this is
 * an aiming reward, and a player who steered a dash into a bubble has already
 * done the thing being rewarded.
 *
 * @param stats    the run's stat block
 * @param kindMul  the pickup kind's own share (CONFIG.strike.pickupBlast.kinds)
 * @returns {{damage: number, radius: number, knock: number}} all zero when
 *   nothing should go off.
 */
export function pickupBlast(stats, kindMul = 1) {
  const p = CONFIG.strike.pickupBlast ?? {};
  const none = { damage: 0, radius: 0, knock: 0 };
  // The dash, or the grace window just after it — a pickup the dash claimed
  // is usually still travelling to the mouth when the dash ends. See the note
  // on CONFIG.strike.pickupBlast.grace.
  const struck = strikeState.active || strikeState.blastGrace > 0;
  if (p.enabled === false || !struck || !(kindMul > 0)) return none;
  const damage = (stats?.strikeDamage ?? 0) * (p.damageMul ?? 0) * powerDamageMul() * kindMul;
  const radius = (p.radius ?? 0)
    * lerp(1, p.radiusPowerMul ?? 1, strikeState.power)
    * (stats?.aoeMul ?? 1);
  const knock = (p.knock ?? 0) * strikeState.power;
  if (!(damage > 0) || !(radius > 0)) return none;
  return { damage, radius, knock };
}

/**
 * HOW FAR A STRIKE CAN REACH, from where the seal is standing — the length of
 * the longest dash this stat block can buy, plus the body that does the hitting.
 *
 * THE MAXIMUM, not what the meter holds right now, and that is the whole point
 * of the number. Its one caller is the first-run tip about a boss's weak spot
 * (systems/tutorial.js), which is a question about whether the spot is
 * ATTACKABLE — "you could strike that from here if you charged" — and a reach
 * derived from the live charge would put the tip on screen and take it off
 * again as the bar filled and emptied underneath it.
 *
 * Derived from the same three numbers tryStrike() spends, rather than from a
 * constant beside them: reach scales the dash's DURATION at constant speed (see
 * the note there), so travel is speed x duration x the full-charge multiplier.
 * `hitRadius` is on the end because a dash connects with the seal's body, not
 * with a point — the same slack hitCreature is given in updateStrike.
 *
 * AND OFF THE FULL-TANK SPEED, not the live one. The bar throttles the dash
 * (breathSpeedMul in stats.js — `breathBase` is the pre-throttle stash), and
 * reading the throttled number here would put the weak-spot tip on screen and
 * take it off again as the seal breathed, which is the same flicker the
 * paragraph above rejects the live charge for.
 */
export function strikeReach(stats = null) {
  const c = CONFIG.strike.charge ?? {};
  const speed = stats?.breathBase?.strikeDashSpeed ?? stats?.strikeDashSpeed ?? CONFIG.strike.dashSpeed ?? 0;
  const duration = (stats?.strikeDashDuration ?? CONFIG.strike.dashDuration ?? 0)
    * (c.reachMulMax ?? 1);
  return speed * duration + (stats?.hitRadius ?? 0);
}

/**
 * THE AIM HAND, AS THE DASH SEES IT. Called by updatePlayer every frame a dash
 * or its follow-through is live, before dashSteer.
 *
 * On a frame the aim device GESTURED (input.aimMoved — see input.js) the
 * dash's held aim becomes the DIRECTION OF THE GESTURE (input.aimGesture: a
 * mouse flicked up is up, a thumb slid left is left, a right stick is
 * itself) and stays there. On every other frame it is left alone, which is
 * the whole point: a pointer's heading is cursor-minus-seal and changes on
 * its own as the seal moves, and a dash that read it live turned round the
 * moment it flew past the cursor.
 *
 * An input with no gesture vector (the versus pad readers, the bots, a test
 * stub) falls back to its `aim`, which for those is a direction already.
 *
 * Returns the held aim, for the caller to hand dashSteer.
 */
export function holdAim(s, input) {
  if (input?.aimMoved) {
    const g = input.aimGesture;
    let ax = g?.x ?? 0, ay = g?.y ?? 0;
    if (Math.hypot(ax, ay) <= 0.001) { ax = input.aim?.x ?? 0; ay = input.aim?.y ?? 0; }
    const len = Math.hypot(ax, ay);
    if (len > 0.001) {
      s.aim.x = ax / len; s.aim.y = ay / len;
      s.aimSteer = true;
    }
  }
  return s.aim;
}

/**
 * ONE FRAME OF THE DASH'S STEERING — the rule updatePlayer applies to the seal
 * every dash frame the stick is held, and the rule predictDash() below runs
 * ahead of time to say where a dash would land. One function so the two can
 * never disagree: the corridor is only worth drawing if it is the dash.
 *
 * Reads a heading and a speed, returns the next pair in `out`. The player
 * turns the result back into a velocity; the prediction integrates it.
 *
 *   TURN      the heading swings toward the SAME rule the launch used
 *             (strikeDirection: the move stick when it is pushed, the aim
 *             otherwise) at dashTurnRate x steerMul, scaled by the combo
 *             alongside the speed it divides, so the turn RADIUS stays
 *             constant as a chain makes the seal faster. The aim handed in
 *             is the dash's HELD aim (holdAim) — the last heading the aim
 *             hand actually gestured, never the live cursor — so a released
 *             stick with an idle mouse is no instruction at all and the seal
 *             holds its line. It used to steer toward an angular blend of
 *             both hands, which was a direction neither of them asked for,
 *             and toward the live pointer, which flipped as the seal flew
 *             past it.
 *   TAKEOVER  the turn is not at full authority from the first frame. A
 *             dash is a commitment, and a seal that can be dragged off its
 *             launch line on frame two never committed to anything — so the
 *             turn rate is scaled by `progress` through the dash on a curve:
 *             steerFrom of it at the launch, all of it by the end, along
 *             CONFIG.strike.dashControl.steerEase. The hands ease back in.
 *   BOUGHT    ...and only by a dash that PAID for it. A one-pip release is a
 *             quick straight burst — a dodge, not a homing strike — so the
 *             authority is also scaled by the power the dash was bought
 *             with, in pips: nothing at steerOffPips or under, all of it
 *             from steerFullPips up.
 *   THROTTLE  a half-pushed stick asks for a slower dash, easing off bleeds
 *             toward minSpeedMul of it; approached, never snapped.
 *   BREAK OUT shoving the stick backwards ends the dash. Reported as
 *             `out.breakOut` and nothing else changes — the caller decides
 *             what ending it means (the player cancels, the forecast stops).
 *
 * @param heading  radians, the dash's current direction
 * @param speed    world units/s
 * @param moveX/Y  input.move — NOT normalized, the magnitude is the throttle
 * @param aimX/Y   the dash's HELD aim (strikeState.aim, via holdAim) — normalized,
 *                 may be zero (then the stick alone steers); never the live
 *                 pointer heading, which flips as the seal passes the cursor
 * @param combo    player.comboSpeedMul
 * @param dt       seconds
 * @param stats    player.stats (strikeDashSpeed)
 * @param progress 0..1 through the dash — 0 at the launch, 1 at its end.
 *                 Pass 1 for full authority (a dash that is not a strike).
 * @param power    0..1, what the dash was bought with (strikeState.power).
 *                 Pass 1 for a dash that is not a strike.
 * @param out      { heading, speed, breakOut } — reused, allocates nothing
 */
export function dashSteer(heading, speed, moveX, moveY, aimX, aimY, combo, dt, stats, progress = 1, power = 1, out = { heading: 0, speed: 0, breakOut: false }, follow = 1) {
  const dc = CONFIG.strike.dashControl ?? {};
  const stick = Math.min(1, Math.hypot(moveX, moveY));
  // The break-out reads the STICK, not the blend: it is the player shoving
  // backwards against the line, and the aim has nothing to do with wanting out.
  let stickDelta = Math.atan2(moveY, moveX) - heading;
  while (stickDelta > Math.PI) stickDelta -= TAU;
  while (stickDelta < -Math.PI) stickDelta += TAU;

  out.heading = heading;
  out.speed = speed;
  out.breakOut = false;
  // The test is on the angle rather than on a button so it needs no new
  // input: shoving the stick backwards is already what a player does when
  // they want out, and it could not previously mean anything.
  const breakAngle = dc.breakOutAngle ?? 2.2;
  if (dc.breakOut !== false && Math.abs(stickDelta) >= breakAngle && stick >= (dc.breakOutStick ?? 0.7)) {
    out.breakOut = true;
    return out;
  }

  // The steer target: the same rule as the launch, on this frame's hands. The
  // stick when it is pushed; the HELD aim otherwise (holdAim — the last
  // heading the aim hand gestured, seeded on the launch line, so a dash with
  // neither hand giving anything new steers toward where it is already going
  // and turns by nothing). Letting go of the stick used to swing the target
  // from a blend onto the full aim, a lurch toward the cursor as a reward for
  // taking a hand off; with the held aim seeded on the launch there is
  // nothing to lurch toward unless the hand has asked for it.
  const stickLive = stick > 0.001;
  steerMove.x = stickLive ? moveX : 0;
  steerMove.y = stickLive ? moveY : 0;
  steerAim.x = aimX ?? 0; steerAim.y = aimY ?? 0;
  const want = strikeDirection(steerMove, steerAim, steerTarget);
  let delta = (want.x === 0 && want.y === 0) ? 0 : Math.atan2(want.y, want.x) - heading;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;

  // `dashTurnRate` is the base; `steerMul` scales it and lives apart so the
  // rate can be raised without touching a slider that has already been tuned.
  //
  // `follow` is the FOLLOW-THROUGH, and it is 1 for every frame of a live
  // dash. Past the end of one it fades to nothing over
  // dashControl.followThrough, so the hands are handed back rather than cut
  // off: see the note beside that key for why a hard stop is the wrong shape.
  const rate = CONFIG.strike.dashTurnRate * (dc.steerMul ?? 1) * combo
    * steerAuthority(dc, progress, power, stats) * follow;
  const maxStep = rate * dt;
  out.heading = heading + Math.max(-maxStep, Math.min(maxStep, delta));

  // THE THROTTLE IS THE MOVE STICK'S, and only when there is one.
  //
  // `stick` is the throttle, so a frame with no movement input asks for
  // `minSpeedMul` — a full brake. That was harmless while the whole of this
  // function was gated on the movement stick being pushed, and became a bug
  // the moment the aim was allowed to steer as well: a mouse player who never
  // touches WASD would have every dash pinned at 45% speed by a hand they are
  // not using. No movement input is no opinion about the speed, not a demand
  // for the floor.
  //
  // NOR DURING THE FOLLOW-THROUGH. The throttle reaches for a fraction of the
  // DASH speed, and the moment the dash ends the ceiling in updatePlayer is
  // back to the ordinary one — so it would pull toward a number the clamp
  // undoes on the same frame, every frame. The follow-through buys the turn
  // back, not the speed.
  if (dc.throttle !== false && follow >= 1 && stick > 0.001) {
    const floor = dc.minSpeedMul ?? 0.45;
    const want = (stats?.strikeDashSpeed ?? CONFIG.strike.dashSpeed ?? 0) * combo * (floor + (1 - floor) * stick);
    out.speed = speed + (want - speed) * Math.min(1, (dc.throttleLerp ?? 7) * dt);
  }
  return out;
}

/**
 * How much of the turn rate the hands have at `progress` through a dash bought
 * with `power` — the TAKEOVER curve times what was PAID for it.
 *
 * Takeover: steerFrom at the launch, 1 at the end, shaped by steerEase (a
 * name from ease.js; an unknown name is linear rather than a throw, because a
 * typo in the tuner must not lock the seal on a line).
 *
 * Paid: in pips, so it survives a card that changes the bar. A dash of
 * steerOffPips or fewer has no steering at all — a one-pip release is a
 * straight burst out of a line, the dodge a boss fight pays for — and the
 * authority climbs linearly to all of it at steerFullPips.
 */
export function steerAuthority(dc, progress, power = 1, stats = null) {
  const from = Math.min(1, Math.max(0, dc?.steerFrom ?? 0));
  const t = Math.min(1, Math.max(0, progress ?? 1));
  const name = dc?.steerEase;
  const k = isEasing(name) ? ease(name, t) : t;
  const takeover = from + (1 - from) * k;

  const off = Math.max(0, dc?.steerOffPips ?? 1);
  const full = Math.max(off + 1e-6, dc?.steerFullPips ?? 3);
  const pips = Math.min(1, Math.max(0, power ?? 1)) * pipCount(stats);
  const paid = Math.min(1, Math.max(0, (pips - off) / (full - off)));
  return takeover * paid;
}

/**
 * THE FOLLOW-THROUGH — how much of the dash's turn rate is left, now that the
 * dash itself is over.
 *
 * 1 while the dash is live, then fading to 0 across
 * CONFIG.strike.dashControl.followThrough along `followEase`. 0 when the
 * window is shut or switched off, which is exactly the behaviour that shipped
 * before it existed.
 *
 * A FADE AND NOT A SECOND DASH. It buys back the TURN only — dashSteer skips
 * the throttle while this is under 1, because the speed ceiling in
 * updatePlayer has already dropped back to the ordinary one and a throttle
 * pulling toward the dash speed would be undone by the clamp on the same
 * frame. What the player gets is the ability to shape the exit of a manoeuvre
 * they are still carrying the momentum of, which is what a follow-through is.
 *
 * Read as a MULTIPLIER on the rate rather than as a longer dash on purpose:
 * everything that asks "is the seal striking" — the corridor, the ram, the
 * damage — must still say no the moment the dash ends.
 */
export function steerFollow(s = strikeState) {
  if (s.active) return 1;
  const span = s.steerGraceMax;
  if (!(span > 0) || !(s.steerGrace > 0)) return 0;
  const left = Math.min(1, Math.max(0, s.steerGrace / span));
  const name = CONFIG.strike.dashControl?.followEase;
  // Eased on the REMAINING fraction, so an `outQuad` here reads as the hands
  // slipping away — the same curve name means the same shape as it does on the
  // takeover, rather than being mirrored by whoever wired it.
  return isEasing(name) ? ease(name, left) : left;
}

// dashSteer's scratch — strikeDirection takes vectors, and a dash frame must
// not allocate three of them.
const steerMove = { x: 0, y: 0 };
const steerAim = { x: 0, y: 0 };
const steerTarget = { x: 0, y: 0 };

// The forecast integrates at the frame rate the seal is simulated at, so a
// turn capped per frame lands on the same heading the real dash reaches.
const FORECAST_DT = 1 / 60;
const forecastStep = { heading: 0, speed: 0, breakOut: false };

/**
 * WHERE A DASH RELEASED RIGHT NOW WOULD LAND — the whole dash, not the launch.
 *
 * The launch heading (strikeDirection: the stick when pushed, the aim
 * otherwise) is only the FIRST frame of a dash. With the stick held the seal
 * keeps steering every frame after it (dashSteer above), throttled by the
 * stick and dragged by the water, and the only honest way to draw where that
 * ends is to fly it.
 *
 * This replays the dash as updatePlayer will run it: the impulse, then per
 * frame the stick's thrust, the steer (dashSteer above, the same function),
 * the dash ceiling, the water's drag and the integration, for the duration
 * the release would set at this power. A break-out stops it where it broke.
 * In the water only — a dash that breaches follows gravity from there, which
 * the corridor does not draw.
 *
 * Returns the CHORD from the seal to the landing point: `dir` is the direction
 * to it and `reach` the distance, both zero if nothing would fire. The real
 * path bends at the start, so the chord is where the dash ENDS rather than
 * every point it passes through; the bend is short enough at the shipped
 * turn rate that the cone covers it.
 *
 * @param move   input.move — NOT normalized
 * @param aim    input.aim — normalized
 * @param power  0..1, the banked charge (strikeState.pending in a wind-up)
 * @param stats  player.stats
 * @param combo  player.comboSpeedMul
 * @param out    reused target: { dir: { x, y }, reach, x, y }
 */
export function predictDash(move, aim, power, stats, combo = 1, out = { dir: { x: 0, y: 0 }, reach: 0, x: 0, y: 0 }) {
  const launch = strikeDirection(move, aim, out.dir);
  if (launch.x === 0 && launch.y === 0) {
    out.reach = 0; out.x = 0; out.y = 0;
    return out;
  }
  const c = CONFIG.strike.charge ?? {};
  const t = Math.min(1, Math.max(0, power || 0));
  const duration = (stats?.strikeDashDuration ?? CONFIG.strike.dashDuration ?? 0)
    * lerp(c.reachMulMin ?? 1, c.reachMulMax ?? 1, t);
  const dashSpeed = (stats?.strikeDashSpeed ?? CONFIG.strike.dashSpeed ?? 0);
  const maxSpeed = stats?.maxSpeed ?? CONFIG.player.maxSpeed ?? 0;
  const thrust = CONFIG.player.thrustEnabled ? (stats?.thrust ?? CONFIG.player.thrust ?? 0) : 0;
  const friction = stats?.friction ?? CONFIG.player.friction ?? 1;
  const mx = move?.x ?? 0, my = move?.y ?? 0;
  const held = mx * mx + my * my > 0.001;
  const ceiling = Math.max(maxSpeed, dashSpeed) * combo;

  // The impulse.
  let vx = launch.x * dashSpeed * combo;
  let vy = launch.y * dashSpeed * combo;
  let x = 0, y = 0;
  for (let left = duration; left > 1e-6; left -= FORECAST_DT) {
    const dt = Math.min(FORECAST_DT, left);
    // Thrust lands before the steer reads the velocity, as in updatePlayer.
    vx += mx * thrust * combo * dt;
    vy += my * thrust * combo * dt;
    if (held) {
      const v = Math.hypot(vx, vy);
      if (v > 0.001) {
        // The held aim of a dash released now is its own launch line (tryStrike
        // seeds it there), so that is what the forecast steers toward — the
        // live pointer would flip as the forecast flew past it.
        dashSteer(Math.atan2(vy, vx), v, mx, my, launch.x, launch.y, combo, dt, stats, 1 - left / duration, t, forecastStep);
        if (forecastStep.breakOut) break;
        vx = Math.cos(forecastStep.heading) * forecastStep.speed;
        vy = Math.sin(forecastStep.heading) * forecastStep.speed;
      }
    }
    const speed = Math.hypot(vx, vy);
    if (speed > ceiling) { vx *= ceiling / speed; vy *= ceiling / speed; }
    const drag = Math.pow(friction, dt * 60);
    vx *= drag; vy *= drag;
    x += vx * dt;
    y += vy * dt;
  }
  out.x = x;
  out.y = y;
  out.reach = Math.hypot(x, y);
  if (out.reach > 1e-6) {
    out.dir.x = x / out.reach;
    out.dir.y = y / out.reach;
  }
  return out;
}

/**
 * Has this dash already connected with `target`, and if not, claim it.
 *
 * The creature loop below has always had this bookkeeping internally; the boat
 * pass in main.js needs exactly the same answer, and a hull is not in the
 * enemy list. Exported rather than duplicated so "once per dash" means one
 * thing — and so the set is cleared by the same tryStrike() that starts the
 * dash, which a second copy living in main.js would keep missing.
 *
 * @returns true if this is the first contact of the dash with that target.
 */
export function claimDashHit(target) {
  if (!target || hitThisDash.has(target)) return false;
  hitThisDash.add(target);
  return true;
}

export function isInvulnerable() {
  return strikeState.invulnTimer > 0;
}

const TAU = Math.PI * 2;

/**
 * Where a strike released right now would GO — the one rule, so the corridor
 * the lens draws and the impulse the dash gets can never disagree.
 *
 * THE STICK WINS WHEN IT IS PUSHED. A pushed move stick (or WASD) is the
 * heading; the aim (cursor / right stick / aim thumb) decides only when the
 * stick is idle. So the seal only ever launches along a direction one of the
 * player's hands is actually giving.
 *
 * It used to launch at the angular HALFWAY point between the two hands
 * (strike.aimBlend, 0.5). That is a direction nobody asked for: swim east and
 * point north and the dash went north-east, which neither hand can read off
 * the screen, and a pointer's heading changes on its own as the seal moves,
 * so the halfway moved under the player mid-flight. The blend is gone, not
 * set to 0 — a slider whose one honest value is an end is not a slider.
 *
 * Only the DIRECTION of the stick is read: a half-tilted stick launches
 * exactly where a full one does. The magnitude is the throttle (dashSteer).
 *
 * Both idle returns the zero vector — the caller checks it and doesn't fire.
 *
 * @param move  input.move — NOT normalized (analog magnitude survives).
 * @param aim   input.aim — normalized in every path that writes it.
 * @param out   optional target, so the per-frame prediction allocates nothing.
 */
export function strikeDirection(move, aim, out = { x: 0, y: 0 }) {
  const mx = move?.x ?? 0, my = move?.y ?? 0;
  const ax = aim?.x ?? 0, ay = aim?.y ?? 0;
  const mLen = Math.hypot(mx, my);
  const aLen = Math.hypot(ax, ay);

  if (mLen > 0.001) {
    out.x = mx / mLen;
    out.y = my / mLen;
    return out;
  }
  out.x = aLen > 0.001 ? ax / aLen : 0;
  out.y = aLen > 0.001 ? ay / aLen : 0;
  return out;
}

/**
 * ENGLISH — the spin a player puts on a shot on purpose, read off the two
 * sticks disagreeing. The strike launches along the stick (strikeDirection),
 * so a player pointing across the line they are swimming is a seal whose
 * body slides across the ball's face as it hits, and that slide is what
 * friction turns into spin (versus.js strikeBall). This is the
 * slide as a number: sin of the angle from the aim to the swim, -1..1,
 * positive when the swim is anticlockwise of the aim, times how hard the
 * stick is pushed — a nudge is a little english, a full deflection is all
 * of it.
 *
 * `deadzone` (CONFIG.versus.ball.english) is how far they must disagree
 * before any counts, so a swim roughly at the cursor is a square hit, and
 * above it the value ramps from zero rather than stepping in. Either input
 * idle is no english at all: one stick cannot disagree with itself.
 */
export function strikeEnglish(move, aim) {
  const e = CONFIG.versus?.ball?.english ?? {};
  if (e.enabled === false) return 0;
  const mx = move?.x ?? 0, my = move?.y ?? 0;
  const ax = aim?.x ?? 0, ay = aim?.y ?? 0;
  const mLen = Math.hypot(mx, my);
  const aLen = Math.hypot(ax, ay);
  if (mLen <= 0.001 || aLen <= 0.001) return 0;
  // sin of the angle from aim to move, scaled by the stick's throw (<= 1).
  const sin = (ax * my - ay * mx) / (aLen * Math.max(mLen, 1));
  const dz = Math.max(0, Math.min(0.95, e.deadzone ?? 0.2));
  const a = Math.abs(sin);
  if (a <= dz) return 0;
  const ramped = (a - dz) / (1 - dz);
  return Math.sign(sin) * Math.min(1, ramped);
}

// How much faster everything the player does gets while a chain is live —
// dash speed, top speed and thrust all read this, and so does the dash's own
// turn rate, so a fast combo curves just as tightly as a slow one.
// 1 when no chain is running.
export function comboSpeedMul(stats = null, s = strikeState) {
  // Reads the fractional pip depth, so the seal speeds up with every mouthful
  // instead of stepping up once a bar. `comboSpeedPerLevel` is unchanged and
  // still means "per link" — see chainLevel().
  //
  // WHOSE CHAIN, and this one mattered most: at `comboSpeedMax` it is worth
  // 1.75x on thrust, top speed, the dash and the dash's turn rate. main.js
  // pushed it onto `player` alone, so in a match one seal could be most of
  // twice the speed of everything else on the pitch and nothing else in the
  // water could earn it.
  const level = chainLevel(stats, s);
  if (level <= 0) return 1;
  return Math.min(
    CONFIG.strike.comboSpeedMax,
    1 + CONFIG.strike.comboSpeedPerLevel * level,
  );
}

/**
 * HOW MUCH FASTER THE SEAL GETS MOVING WITH A STOCKED BAR — thrust only.
 *
 * A multiplier on ordinary swimming acceleration, one step per pip of boost
 * currently held, capped by `chargeThrustMax`. Deliberately NOT applied to the
 * speed ceiling or to the dash: see CONFIG.strike.chargeThrustPerPip for why
 * the fuel buys acceleration and nothing else.
 *
 * Fractional, like comboSpeedMul, so the burn of a wind-up bleeds the bonus
 * away smoothly rather than dropping it a pip at a time mid-hold.
 *
 * WHOSE BAR, though. This read the module's own `strikeState` — player 1's —
 * with no way to ask about anybody else's, so in a match the seal in seat 0 got
 * up to 15% more acceleration off a stocked bar and the other seven got none.
 * Every other meter in this file already takes its state as an argument; this
 * one simply had not been asked the question yet.
 *
 * @param stats the run's stat block — only for pipCount, which a card moves.
 * @param s     whose meter: the run's by default, a match seal's otherwise.
 */
export function chargeThrustMul(stats = null, s = strikeState) {
  const per = CONFIG.strike.chargeThrustPerPip ?? 0;
  if (!CONFIG.strike.enabled || per <= 0) return 1;
  const pips = Math.max(0, Math.min(1, s?.charge ?? 0)) * pipCount(stats);
  return Math.min(CONFIG.strike.chargeThrustMax ?? Infinity, 1 + per * pips);
}

let orbTimer = 0;
let pipCooldown = 0; // seconds until the next queued pip tick may be heard
const hitThisDash = strikeState.hits;

/**
 * IS THE FOOD CHAIN LIVE AT ALL.
 *
 * True outside a match, always: the chain is the run's central loop and
 * nothing in a run switches it off. Inside a match it is
 * `CONFIG.versus.chain.enabled`, and that switch covers EVERY seal — the
 * person's and the computer's alike, because the one thing a toggle here must
 * not do is turn it off for one side.
 *
 * Asked at the two doors every link comes through (noteChainMouthful for the
 * food, chainStrike for everything else) rather than at each of the dozen call
 * sites, so "off" cannot mean off-for-some-sources.
 */
function chainAllowed() {
  if (!versusActive()) return true;
  return CONFIG.versus?.chain?.enabled !== false;
}

function randomBetween(a, b) {
  return a + Math.random() * Math.max(0, b - a);
}

/**
 * The fuel a fresh run starts with, 0..1. Counted in PIPS in the config for
 * the reason pipValue exists at all — the bar is a whole number of mouthfuls,
 * and "starts with two" survives a card that changes how much one is worth.
 * No stats argument: this runs at the top of a run, where the block is base.
 */
function startCharge() {
  const pips = Math.max(0, CONFIG.strike.charge.startPips ?? 0);
  return Math.max(0, Math.min(1, pips / pipCount()));
}

export function resetStrike(s = strikeState) {
  // WHAT THE RUN OPENS WITH, in pips — CONFIG.strike.charge.startPips, and it
  // is 0. The bar has no passive regeneration of any kind (see updateStrike),
  // so a dead meter means the FIRST thing a run has to do is eat: the food
  // chain isn't one way to fuel the strike, it is the only one, and opening
  // full let the first minute be played without ever learning that.
  //
  // Read through pipCount rather than as a raw fraction so the setting means
  // the same thing whatever the bar's length is — and clamped, because a value
  // past the pip count would otherwise open above full.
  s.charge = startCharge();
  clearPending(s);
  s.perfectFlash = 0;
  s.perfectStrike = false;
  s.sweetStrike = false;
  s.armingStrike = false;
  s.armed = false;
  s.verdict = 0;
  s.verdictOffset = 0;
  s.verdictFlash = 0;
  s.charging = false;
  s.turboOn = false;
  s.turbo = 0;
  s.power = 0;
  s.flash = 0;
  s.active = false;
  s.blastGrace = 0;
  s.steerGrace = 0;
  s.steerGraceMax = 0;
  s.dashTimeLeft = 0;
  s.dashDuration = 0;
  s.chainPips = 0;
  s.pipBudget = 0;
  s.chainCount = 0;
  s.linkCredit = 0;
  s.chainTimer = 0;
  s.pipsSinceStrike = 0;
  if (s === strikeState) {
    lastRelease.depth = 0;
    lastRelease.sweet = false;
    lastRelease.arms = false;
    lastRelease.hadFood = false;
    lastRelease.hadWindow = false;
  }
  s.invulnTimer = 0;
  s.hits.clear();
  s.chainGaps.clear();
  s.chainLinks.length = 0;
  // The rest is the run's own: the pip queue and the orb timer.
  if (s !== strikeState) return;
  pipQueue.length = 0;
  pipCooldown = 0;
  orbTimer = randomBetween(CONFIG.strike.orbSpawnMin, CONFIG.strike.orbSpawnMax);
}

/**
 * Burn fuel into banked power. Called every frame from main.js with whether
 * any strike input is currently down.
 *
 * Holding drains the bar and banks exactly what it drained, so `pending` can
 * never exceed the fuel that was actually there — a nearly-empty bar buys a
 * nearly-powerless strike no matter how long the button is held down. The bar
 * running dry is the natural end of a wind-up.
 *
 * `pending` deliberately survives a release that didn't fire: letting go a
 * fraction under `minFire` and pressing again continues the same wind-up
 * instead of throwing the fuel already spent on it away.
 */
// Consumed once by main.js on the frame it happens, exactly like chargeCrossed
// in systems/chargeSkin.js: the sound, the shake and the rumble are one-shots
// and `perfect` is a level, so something has to carry the edge between them.
// The ring reads `perfectFlash` instead and needs no edge — it is drawing a
// decay, not firing an event.
// (the perfect-charge edge lives on the state now: s.perfectEdge)

/**
 * TURBO — the faster swim of a wind-up held with the stick pushed.
 *
 * Runs right after updateCharge, because it reads `charging` for THIS frame.
 * The latch (`turboOn`) arms on the first frame the seal is both charging and
 * holding a direction past CONFIG.strike.turbo.moveMin, and stays armed for
 * the rest of the hold whether or not the stick stays pushed — the player has
 * committed to a line, and a stick that dips through centre on the way to a
 * new heading must not stutter the swim. It clears the moment `charging` does,
 * which is every way a wind-up ends: the release that fires the dash, a button
 * that comes up on nothing, and a bar that has burned to empty under the
 * hold.
 *
 * The blend (`turbo`, 0..1) is what the seal swims by, eased linearly toward
 * the latch over rampIn / rampOut so the extra speed arrives as a surge rather
 * than a step — and so the dash that ends it launches out of a body that is
 * still, for a few frames, in turbo, which is the hand-off the feature is for.
 *
 * @param moveLen  the stick's throw this frame, 0..1 (the length of input.move)
 * @returns the blend, for the caller to push onto the player.
 */
export function updateTurbo(dt, moveLen, s = strikeState) {
  const c = CONFIG.strike.turbo;
  if (!CONFIG.strike.enabled || !c || c.enabled === false) {
    s.turboOn = false;
    s.turbo = 0;
    return 0;
  }
  const pushed = (moveLen ?? 0) >= (c.moveMin ?? 0.3);
  s.turboOn = !!s.charging && (s.turboOn || pushed);
  const target = s.turboOn ? 1 : 0;
  const ramp = target > s.turbo ? (c.rampIn ?? 0) : (c.rampOut ?? 0);
  if (ramp <= 0) s.turbo = target;
  else if (target > s.turbo) s.turbo = Math.min(1, s.turbo + dt / ramp);
  else s.turbo = Math.max(0, s.turbo - dt / ramp);
  return s.turbo;
}

/**
 * A stat's turbo multiplier at the current blend: 1 with turbo off, the stat
 * itself at full, linear between. One helper so the thrust, the ceiling and
 * the swim cycle all read the blend the same way.
 */
export function turboLerp(mul, blend) {
  const m = Number.isFinite(mul) && mul > 0 ? mul : 1;
  const t = Math.max(0, Math.min(1, blend ?? 0));
  return 1 + (m - 1) * t;
}

/**
 * THE WIND-UP'S ENVELOPE — how much of a strike is in hand, 0..1.
 *
 * ONE EXPRESSION, THREE CONSUMERS. The sustained shake, the rumble's interval
 * pulse and the held voice (CONFIG.strike.charge.bed) are all the same fact
 * told in three channels, and until this existed each of them spelled it out
 * where it stood. That is fine right up until one of them is retuned, at which
 * point the seal shakes on one curve and sounds on another — and nothing about
 * that reads as a bug, it reads as the feel being slightly off.
 *
 * `floor` is what a wind-up is worth the instant it starts, before anything is
 * banked. It is not zero and must not be: a hold that began in silence and
 * faded up would have no attack at all, and the press is the event.
 *
 * NORMALISED, unlike the raw `floor + pending * span` this replaced. That
 * expression tops out at 1.45, which was harmless while the only readers
 * multiplied a shake by it and scaled a haptic, and is not harmless now that
 * something maps it onto a gain — a bed driven to 1.45x its own peak is 3dB
 * over the level it was tuned at, on every full charge.
 */
export function chargeEnvelope(pending = strikeState.pending) {
  const e = CONFIG.strike.charge.envelope ?? {};
  const floor = e.floor ?? 0.35;
  const span = e.span ?? 1.1;
  // Number.isFinite FIRST, not a clamp. Math.min(1, NaN) is NaN and
  // Math.max(0, NaN) is NaN, so a clamp alone passes a NaN straight through —
  // and this number becomes an AudioParam target, where a NaN does not fall
  // back to anything, it poisons the node for the rest of its life.
  const p = Number.isFinite(pending) ? Math.max(0, Math.min(1, pending)) : 0;
  const top = floor + span;
  return top > 0 ? (floor + p * span) / top : 0;
}

/**
 * What a full wind-up is worth on the UNNORMALISED curve — `floor + span`.
 *
 * Here so the rumble can keep the range it was tuned at. Its scale has always
 * been the raw expression, which tops out above 1, and multiplying a haptic
 * magnitude by 1.45 is a perfectly sensible thing for it to have been doing;
 * quietly renormalising it to 1.0 while adding a sound would have taken a
 * third off the strongest rumble in the game as a side effect of a change
 * about audio.
 *
 * The sound needs the normalised one and the motor wants the old one, so both
 * come off the same two numbers and neither has to spell the expression out.
 */
export function chargeEnvelopeTop() {
  const e = CONFIG.strike.charge.envelope ?? {};
  return (e.floor ?? 0.35) + (e.span ?? 1.1);
}

export function updateCharge(dt, held, stats, s = strikeState) {
  if (!CONFIG.strike.enabled) return;

  // THE WIND-UP IS THE WHOLE BAR. Fuel and power move together, so a perfect
  // charge lands on the frame the tank runs dry — with a Booster Pack
  // container on the bar there is simply more of it, and the hold is longer
  // by a pip's worth (windUpTime). A pip is one chum and 1/pipCount of a
  // strike, whatever the bar's length.
  const time = windUpTime(stats);
  // THE HOLD STARTING IS AN EDGE, and the wind-up's own sounds hang off it.
  // Read before `charging` is reassigned, because the whole question is what
  // it was on the frame before — see `burnedPips` below and startCharge in
  // main.js, which both need "this hold" to mean something.
  const wasCharging = s.charging;
  s.charging = !!held && s.charge > 0;
  // A hold that has only just begun starts its own count. Not reset on the
  // RELEASE: `burnedPips` is read after the fact by the release burst and by
  // the panel's readout, and a counter zeroed where the button came up would
  // have nothing in it by the time either looked.
  if (s.charging && !wasCharging) s.burnedPips = 0;
  if (s.charging) {
    // Never more than is in the tank, so the two always move together.
    const burn = Math.min(s.charge, dt / time);
    // PIPS SPENT, COUNTED ON THE TANK AND NOT ON THE BANK. The two move
    // together on an ordinary hold, so either would do — until something
    // fills the meter mid-wind-up (the sun's trickle, CONFIG.dayNight.pass.
    // sun.charge), which tops `pending` out with fuel still in the tank. The
    // bank then stops crossing boundaries while the burn is still very much
    // burning, and the sound of the wind-up would go quiet a beat before the
    // wind-up did. What is being spent is the FUEL, so the fuel is what is
    // counted.
    //
    // Floor-of-before minus floor-of-after, against a bar cut into pipCount
    // pieces — the same arithmetic notePips does going the other way, with
    // the same epsilon, so a pip that snapToPip has just landed exactly on a
    // boundary is not counted twice by a float a hair under it.
    const n = pipCount(stats);
    const from = Math.ceil(s.charge * n - 1e-6);
    s.charge -= burn;
    s.pending = Math.min(1, s.pending + burn);
    const to = Math.ceil(s.charge * n - 1e-6);
    // FIRED HERE AND NOT QUEUED, which is the opposite of what the fill does
    // and is right for the opposite reason. A fill can arrive six pips inside
    // one frame (a magnet sweep) and needs pipGap to spread them out; a burn
    // is paced by the drain itself — one pip every windUpTime/pipCount
    // seconds, 0.2s on the default bar — so it can never bunch, and putting
    // it through the same queue would only make the sound lag the bar it is
    // describing.
    for (let i = from; i > to; i--) {
      s.burnedPips = (s.burnedPips ?? 0) + 1;
      // THE RUN'S OWN SEAL ONLY, the same test `own` makes in updateStrike. A
      // match runs updateCharge for every seal on the board (systems/
      // versus.js), and a hook that did not ask would blip in the player's
      // ears every time a CPU wound one up.
      if (s === strikeState) burnHook?.(s.burnedPips, n);
    }
  }

  // BOOSTER PACK'S REGEN — the one refill that is not food, in pips per
  // second. Gradual on purpose (the ring fills visibly rather than ticking
  // whole pips in), through fillMeter so a completed pip is heard like any
  // other. Off while the seal is burning or dashing: regen fighting the burn
  // would make the hold cost less than it says. It feeds no chain link —
  // feedChum is the only thing that does, and a link has to be eaten.
  const regen = Math.max(0, stats?.strikePipRegen ?? 0);
  if (regen > 0 && !s.charging && !s.active && s.charge < 1) {
    fillMeter(regen * pipValue(stats) * dt, stats, s);
  }

  // ---- WHERE THIS WIND-UP IS AGAINST ITS SWEET SPOT ----------------------
  //
  // WHAT IS LEFT TO BANK is whichever runs out first: the fuel in the tank, or
  // the headroom in the bank. They reach zero on the same frame in the
  // ordinary case (a burn takes from one and gives to the other), and they do
  // not when something else fills the meter mid-hold — the sun's trickle, see
  // CONFIG.dayNight.pass.sun.charge — which tops the BANK out with fuel still
  // in the tank. Both are "there is nothing more to hold for", so both load.
  //
  // RUN EVERY FRAME, HELD OR NOT, and deliberately not cleared when the button
  // comes up. The release frame arrives with `strikeHeld` ALREADY FALSE —
  // input.js raises `strikeRelease` on the same frame it drops the level — so
  // clearing on `!held` here would wipe the timing a few lines before
  // tryStrike asks for it, and the sweet spot could never be hit at all. What
  // ends a wind-up is clearPending(), and that ends this with it.
  const left = Math.max(0, Math.min(s.charge, 1 - s.pending));
  if (left <= 1e-6 && s.pending >= minFire(stats) - FIRE_EPS) {
    // += on the frames after, 0 on the frame itself, so `sinceLoaded` is the
    // age of the moment rather than the age plus one frame.
    //
    // ...AND ONLY WHILE THE BUTTON IS DOWN, which is what makes the number
    // tryStrike judges the release on the same number the player was shown.
    //
    // The release frame arrives with `held` ALREADY FALSE (input.js drops the
    // level and raises the edge together) and runs a few lines before
    // tryStrike reads the offset. Advancing here on that frame charged the
    // player a whole frame they never got to see: the HUD drew +33ms, the gate
    // measured +50ms, and every release in the game was judged one frame later
    // than it was made. At 30fps that is the ENTIRE late half of the window —
    // measured, 6 of 13 frames armed at 60fps and 2 of 13 at 30.
    //
    // The early side has always worked this way and that is the argument for
    // it: `toLoaded` below is derived from `left`, nothing burns with the
    // button up, so a wind-up let go of keeps its distance. The two sides of
    // one window disagreeing about whether a released button still counts was
    // the asymmetry, not this line.
    s.sinceLoaded = s.loaded ? s.sinceLoaded + (held ? dt : 0) : 0;
    s.loaded = true;
    s.toLoaded = 0;
  } else {
    s.loaded = false;
    s.sinceLoaded = 0;
    // The bar drains a whole bar in `strikeChargeTime`, so what is left of it
    // IS the time still to run. A wind-up paused by letting go without firing
    // keeps its distance, which is right: no fuel is burning, so the moment is
    // no closer than it was.
    s.toLoaded = left * time;
  }

  // THE PERFECT CHARGE LANDING. An EDGE, latched — `pending` clamps at 1 and
  // then sits there for as long as the button is held, so a test of the level
  // ("is it full?") would fire this every frame of a long hold. The latch is
  // cleared where the power leaves (tryStrike and cancelCharge below), which
  // is also what makes it readable as a mechanic later: perfect describes the
  // strike that is loaded, not the frame it loaded on.
  const perfectAt = Math.min(1, CONFIG.strike.charge.perfectAt ?? 1);
  // ...OR THE WIND-UP SIMPLY RAN OUT OF THINGS TO BANK. A hold begun on a
  // half-full bar tops out at `pending` 0.5 and can never reach `perfectAt`,
  // so on the threshold test alone it opened its sweet spot with no pop, no
  // sound and nothing on the ring — a timing window the player was never told
  // about, on exactly the strikes a player mid-combo is actually throwing.
  // `loaded` is the window opening by construction, so the tell rides it.
  if (!s.perfect && (s.loaded || s.pending >= perfectAt - 1e-6)) {
    s.perfect = true;
    s.perfectFlash = CONFIG.strike.charge.perfectFlashTime ?? 0.5;
    s.perfectEdge = true;
  }
  if (s.perfectFlash > 0) s.perfectFlash = Math.max(0, s.perfectFlash - dt);

  if (s.flash > 0) s.flash = Math.max(0, s.flash - dt);
  // THE VERDICT RUNS OUT ON ITS OWN, and it is the one countdown here that
  // outlives the thing it describes: `flash` is the fuel becoming a strike and
  // is over in 0.28s, while the receipt has to hold long enough to be READ —
  // it is the only place a player is ever told which side of the beat they let
  // go on. Zeroed with it, so nothing downstream has to test two fields.
  if (s.verdictFlash > 0) {
    s.verdictFlash = Math.max(0, s.verdictFlash - dt);
    if (s.verdictFlash === 0) s.verdict = 0;
  }
}

/** True once, on the frame the wind-up reached a perfect charge. */
export function perfectCrossed(s = strikeState) {
  if (!s.perfectEdge) return false;
  s.perfectEdge = false;
  return true;
}

/**
 * Throw away a wind-up that will never be spent — a death, a pause that ate
 * the release, a run ending. Clears the latch as well as the power, so the
 * next hold has to earn its own perfect.
 */
function clearPending(s = strikeState) {
  s.pending = 0;
  s.perfect = false;
  s.perfectEdge = false;
  // The sweet spot belongs to the wind-up, not to the seal: a spent or
  // abandoned bank leaves no window standing for the next hold to inherit.
  // `sweetStrike` is deliberately NOT cleared here — it is the stamp on the
  // dash tryStrike is in the middle of launching, and clearing it on the next
  // line would disarm the strike being fired.
  s.loaded = false;
  s.sinceLoaded = 0;
  s.toLoaded = Infinity;
}

/**
 * THE "STRIKE NOW!" MOMENT — the wind-up has nothing left to bank and enough
 * banked to fire.
 *
 * One function, so the callout on the ring, the meter's pop and the sweet spot
 * are the same instant by construction. main.js used to spell this out for the
 * callout as "the tank is empty and minFire is banked", which is right for a
 * hold begun on a full bar and wrong for the other case it has to cover — see
 * the note in updateCharge.
 */
export function strikeLoaded(s = strikeState) {
  return s.loaded;
}

/**
 * HALF THE SWEET SPOT, in seconds: the error a release is allowed on either
 * side of the loaded moment.
 *
 * A FRACTION OF THE WIND-UP rather than a flat number of seconds, so the
 * difficulty of the timing is the same whatever the hold is worth. Coiled
 * Spring cuts `strikeChargeTime` to 0.78 of its length, and a flat window
 * would be quietly widening in bar terms every time that card was taken —
 * a skill gate getting easier as a reward for a card about refills.
 *
 * weapons.csv owns `sweetFraction`: the size of a skill gate is balance, not a
 * look, and it is the one number in this whole feature worth arguing about.
 */
export function sweetHalfWidth(stats = null) {
  return windUpTime(stats) * Math.max(0, CONFIG.strike.charge.sweetFraction ?? 0.05);
}

/**
 * WHERE THE WIND-UP IS, in seconds relative to the loaded moment. Negative
 * before it, positive after it, -Infinity when there is no fireable wind-up in
 * hand at all.
 *
 * Signed rather than an absolute distance because the two sides are different
 * mistakes and anything that wants to say so needs to know which: early is
 * "you let go with fuel still in the bar", late is "you sat on it".
 */
export function sweetOffset(s = strikeState) {
  if (s.pending < minFire() - FIRE_EPS) return -Infinity;
  return releaseOffset(s);
}

/**
 * THE SAME NUMBER, WITHOUT THE "could this even fire" GATE — how far the
 * wind-up is from its moment, whether or not there is enough banked to spend.
 *
 * The lead-in on the ring (systems/strikeRing.js) is drawn off this rather
 * than off sweetOffset above, and the difference is the whole point of it: an
 * indicator that only appears once `pending` clears minFire cannot show the
 * moment APPROACHING, which is the one thing the instrument was missing. On a
 * short wind-up minFire is crossed a few frames before the moment arrives, so
 * gating the drawing on it would put the cue on screen after it was useful.
 *
 * Split off rather than inlined at the call site so the two can never drift:
 * what the ring draws and what the gate judges are one expression, and the
 * gate is that expression plus a rule about being able to fire at all.
 *
 * Takes the state to read as an argument, defaulting to the run's own. The
 * look sheet (tools/looks/boost-core.js) drives a hand-built state to pose the
 * meter without running the charge economy, and a reader pinned to this
 * module's singleton would draw the LIVE wind-up on every panel of it — which
 * is to say nothing at all, and the one part of the instrument that page
 * cannot see is the part that has to be compiled to be believed.
 */
export function releaseOffset(s = strikeState) {
  return s.loaded ? s.sinceLoaded : -s.toLoaded;
}

/**
 * Would a release RIGHT NOW land in the sweet spot?
 *
 * The whole gate, in one place, asked by tryStrike on the release frame and by
 * anything that wants to draw the window. -Infinity fails the comparison on
 * its own, so "nothing banked" needs no branch of its own here.
 */
export function inSweetSpot(stats = null, s = strikeState) {
  return Math.abs(sweetOffset(s)) <= sweetHalfWidth(stats);
}

/**
 * Spend the banked power. Called on RELEASE of the strike button. Returns true
 * if a dash launched, so the caller can apply the velocity impulse.
 *
 * There is no input buffer any more, and there is nothing left for one to do:
 * power is only ever banked while the button is held, so a release under the
 * threshold cannot become fireable later by waiting. Holding covers the case
 * the buffer used to — keep the button down on an empty bar and the wind-up
 * resumes by itself the moment food refills it.
 */
export function tryStrike(aimDir, stats, english = 0, s = strikeState) {
  if (!CONFIG.strike.enabled) return false;
  const c = CONFIG.strike.charge;

  // Not enough banked. `pending` is kept, not cleared: the fuel is already
  // spent, and confiscating the progress as well would punish a fumble twice.
  if (s.pending < minFire(stats) - FIRE_EPS) return false;

  // ON THE BEAT? Asked FIRST, before anything is spent: clearPending() below
  // throws the wind-up's timing away along with its power, and every payoff
  // downstream reads this snapshot rather than the live window for the same
  // reason `power` is snapshotted — a dash already in flight must not be able
  // to lose what it was released with. See the sweet spot note on s
  // for what riding on it.
  const sweet = inSweetSpot(stats, s);
  s.sweetStrike = sweet;

  // ---- WHAT ARMS A FOOD CHAIN, AND IT IS NOT THE TIMING ------------------
  //
  // A PERFECT CHARGE ARMS IT. `perfect` is the latch behind the PERFECT flash
  // and the pop on the ring (see updateCharge) — the wind-up having nothing
  // left to bank — so the thing the player SEES is the thing that arms. It
  // used to be `sweet` alone, and that was a gate with no tell of its own: the
  // sweet spot is a tenth of a second wide, every cue for it fires at its
  // centre, and 90% of releases in the run logs armed nothing. Asking a player
  // to hit a window nothing announces, in order to start the mechanic the whole
  // game is built around, is not a skill gate.
  //
  // THE TIMING STILL DECIDES THE DAMAGE. `sweetStrike` above is untouched and
  // still gates every point of damage the strike deals — riderDamage,
  // strikeBurst and the contact bite all return zero without it. So the window
  // is now what a mistimed strike COSTS you rather than what it locks you out
  // of, and the lead-in on the ring (systems/strikeRing.js) is a damage cue.
  //
  // Read here, BEFORE clearPending() below wipes the latch, and stamped onto
  // the dash for the same reason `power` and `perfectStrike` are: what a dash
  // was bought with cannot change while it is in flight.
  const arms = sweet || s.perfect;
  s.armingStrike = arms;

  // ---- AND WHAT THIS STRIKE BUYS THE CHAIN -------------------------------
  //
  // ONE BARFUL. The chain's payout is pips of fuel going back in (see
  // noteChainMouthful), and this is the allowance: eat the bar up from empty
  // and every pip is a link, fill it and the chain holds until another release
  // buys the next one. A fumbled wind-up buys nothing, so refilling after one
  // pays nothing — the bar is fuel either way, but it is only CHAIN when a
  // strike paid for it.
  //
  // Funded by the same condition that ARMS rather than by `perfect` alone, and
  // that is not the same thing: the early half of the sweet spot is sweet
  // WITHOUT being perfect (measured — 2 of the 5 armable frames at 60fps land
  // there, and they are the best-timed early releases in the game). Keying the
  // allowance on `perfect` there would arm a chain and fund it with nothing —
  // a combo the player opened correctly and could not grow by a single link,
  // on their best releases. What arms the chain feeds the chain.
  //
  // Assigned rather than added: an allowance is per strike and does not bank,
  // or a player could sit on several barfuls of unspent chain and cash them
  // into one pile.
  s.pipBudget = arms ? pipCount(stats) : 0;

  // Recorded with the SIGNED offset, which is the one number a player has no
  // way of seeing and the one that decides everything downstream: early and
  // late are different mistakes and look the same from the seat.
  const offset = sweetOffset(s);
  if (s === strikeState) noteChain('release', { offset, sweet, arms, half: sweetHalfWidth(stats) });

  // ...AND NOW SHOWN. The same number, latched onto the state the ring reads,
  // so the instrument can play back where this release actually landed instead
  // of only whether it was good. Read BEFORE clearPending() below, which throws
  // the wind-up's timing away along with its power.
  //
  // -Infinity is the "nothing fireable banked" sentinel sweetOffset returns,
  // and it cannot happen here — the minFire gate at the top of this function
  // already returned — but it is guarded anyway rather than trusted, because a
  // non-finite offset would come out of the mapping in strikeRing.js as a NaN
  // radius, and a NaN vertex takes the WHOLE instrument off the screen rather
  // than drawing one mark in the wrong place.
  s.verdict = sweet ? 1 : -1;
  s.verdictOffset = Number.isFinite(offset) ? offset : 0;
  s.verdictFlash = Math.max(0, CONFIG.strike.ring?.verdict?.time ?? 0.55);

  // Snapshot what this dash was bought with. Damage and reach both read it for
  // the whole dash, so clearing `pending` on the next line can't retroactively
  // weaken a strike already in flight.
  s.power = s.pending;
  // `perfectStrike` is what a payoff will read — see the note on `perfect` in
  // s. Snapshotted onto the launched dash for the same reason
  // `power` is: the latch clears on the next line, and a dash already in
  // flight must not be able to lose what it was bought with.
  s.perfectStrike = s.perfect;
  clearPending(s);
  s.charging = false;
  // The bar flashing as the fuel becomes a strike.
  s.flash = c.flashTime ?? 0.28;

  // Reach scales the dash's DURATION at constant speed, so the seal's velocity
  // stays readable and a big charge simply travels for longer.
  const duration = stats.strikeDashDuration * lerp(c.reachMulMin, c.reachMulMax, s.power);
  s.active = true;
  s.dashTimeLeft = duration;
  s.dashDuration = duration;
  s.dashDir = { x: aimDir.x, y: aimDir.y };
  // The held aim starts ON the launch line: nothing has been asked for yet,
  // and steering toward where the seal is already going turns it by nothing.
  s.aim.x = aimDir.x; s.aim.y = aimDir.y;
  s.aimSteer = false;
  s.english = Number.isFinite(english) ? Math.max(-1, Math.min(1, english)) : 0;
  // i-frames cover this dash's own length plus a tail, rather than a fixed
  // total — a full-charge dash outlasts the old flat 0.45s, and would have
  // been the one strike in the game that ended with you exposed.
  s.invulnTimer = duration + CONFIG.strike.invulnTail;
  s.hits.clear();

  // ---- THE FOOD CHAIN IS SCORED HERE, ON THE RELEASE --------------------
  //
  // It used to fire the moment the bar crossed full, which is why nobody could
  // tell what they had done: the link happened TO you, on a passive threshold,
  // at a moment you weren't doing anything. Scoring it on the release makes the
  // chain a chain of STRIKES — caused by an action, landing on the same frame
  // as the dash, in one moment instead of two disconnected ones.
  //
  // The condition is exactly "I refilled the bar, and I'm spending it again
  // before the window closed":
  //
  //   barFilledSinceStrike   the bar reached full since the last release, i.e.
  //                          this strike was genuinely paid for in food.
  //   chainTimer > 0         a previous strike opened the window and it is
  //                          still running.
  //
  // NOT "inside the previous dash", which is what it sounds like it should be
  // and is a trap: a dash lasts 0.13-0.48s, reaching minFire takes 0.35s of
  // holding, and holding SEALS THE MOUTH. There is no room in a dash to both
  // eat a bar and wind up a strike. The window the dash opens is the container.
  //
  // A RELEASE ON THE BEAT ARMS A CHAIN. It does not score one — the food does,
  // a mouthful at a time, in noteChainMouthful above. That split is the fix
  // for a mechanic nobody could see working: scoring on the release meant TWO
  // releases inside one window, each inside a tenth of a second, before a
  // single FOOD CHAIN! had ever appeared.
  //
  // The counters are still read here for the telemetry, because "was there
  // food behind this strike, and was a chain already running" is a description
  // of the moment the player chose to let go, and that is a thing worth
  // knowing about a release even when it is not what scores.
  const hadFood = s.pipsSinceStrike >= linkPips(stats);
  const hadWindow = s.chainTimer > 0;
  s.pipsSinceStrike = 0;
  if (arms) s.armed = true;
  // HOW DEEP THE CHAIN WAS when this release happened — not what the release
  // scored, because a release scores nothing. Kept because it is the one thing
  // about a strike the report cannot reconstruct afterwards: whether the
  // player was opening a chain or feeding one that was already running.
  if (s === strikeState) {
    lastRelease.depth = liveChain(s);
    lastRelease.sweet = sweet;
    lastRelease.arms = arms;
    lastRelease.hadFood = hadFood;
    lastRelease.hadWindow = hadWindow;
  }

  // Every release ON THE BEAT opens or refreshes the window, link or not.
  // Without this the FIRST strike of a chain would leave no window behind,
  // eating would not count as feeding, and a chain could never start at all.
  //
  // A MISTIMED RELEASE OPENS NOTHING, and that is the whole of "a strike only
  // extends the food chain in the sweet spot" in code. The window IS the chain
  // being alive: everything downstream of it — the link, the multipliers, the
  // magnet reaching for food at all (chumHoming in systems/chumMagnet.js) —
  // reads the window rather than re-deriving the rule, so gating it here is
  // the single edit that gates all of them.
  // ...and the window answers to the SAME condition the arming does. A release
  // that arms but opens no window arms nothing in practice: `isFeeding()` would
  // be true only for the length of the dash itself, and the chain would die the
  // frame it landed.
  if (arms && s.chainTimer <= 0) s.chainTimer = CONFIG.strike.chainWindow;

  return true;
}

// The chain scored by the most recent release, waiting to be reported. Held
// rather than returned because tryStrike's boolean is "did a dash launch",
// which the caller branches on for the impulse — widening it to an object
// would touch every call site to say something only one of them cares about.
const lastRelease = { depth: 0, sweet: false, arms: false, hadFood: false, hadWindow: false };

/**
 * WHAT THE LAST RELEASE WAS — whether it landed on the beat, how deep the chain
 * already was, and what it had behind it.
 *
 * It used to report the link the release scored. A release scores nothing now
 * (it ARMS; the food scores — see noteChainMouthful), so what is left is a
 * description of the moment: the one thing about a strike that cannot be
 * reconstructed from the link stream afterwards.
 *
 * `depth` clears on read so a caller cannot replay a stale one; the flags are
 * left alone, being a description of an event that already happened and read
 * on the same frame.
 */
export function consumeStrikeLink() {
  const out = { ...lastRelease };
  lastRelease.depth = 0;
  return out;
}

/**
 * Put fuel back in the bar. Returns true when this fill CROSSED it to full
 * inside a live combo — i.e. when it earned a FOOD CHAIN link.
 *
 * The fill itself is never gated on the combo; only the link is. See the note
 * on CONFIG.strike.charge for why that separation is load-bearing.
 *
 * Crossing is what counts, not merely being full: topping up an already-full
 * bar is not an achievement, and without the `wasFull` guard a single orb
 * arriving every frame against a full bar would score a link every frame.
 *
 * Also books every PIP BOUNDARY this fill crossed, for the tick that plays per
 * pip. Queued rather than fired here — see `pipQueue` below.
 */
function fillMeter(amount, stats = null, s = strikeState) {
  const wasFull = s.charge >= 1;
  const before = s.charge;
  s.charge = Math.min(1, snapToPip(s.charge + amount, stats));
  if (s === strikeState) notePips(before, s.charge, stats);
  const crossed = !wasFull && s.charge >= 1;
  return isFeeding(s) && crossed;
}

/**
 * Land exactly on a pip boundary when we are within a rounding error of one.
 *
 * WITHOUT THIS, "one chum is one pip" IS QUIETLY FALSE at most chain depths.
 * A pip is 1/n, and n additions of 1/n do not reach 1 in floating point for
 * most n: six sixths lands on 0.9999999999999999, so a six-pip bar took SEVEN
 * mouthfuls, a seven-pip bar took eight, and a ten-pip bar took eleven. Only
 * depths whose reciprocals happen to sum cleanly (5, 4, 3) were honest.
 *
 * That is precisely the unpredictability the pips replaced the compounding
 * falloff to remove, arriving by a different route — and it is invisible
 * without counting orbs, because the bar looks full either way and the last
 * mouthful just doesn't fire the link.
 *
 * The epsilon is per-PIP rather than absolute so it stays correct as n grows,
 * and it is far tighter than the smallest real fill (a pip at the 12-pip cap
 * is 0.083) so it can never round a genuine part-pip up to a whole one.
 */
function snapToPip(value, stats) {
  const n = pipCount(stats);
  const pips = value * n;
  const nearest = Math.round(pips);
  return Math.abs(pips - nearest) < 1e-6 ? nearest / n : value;
}

// THE OTHER DIRECTION — a pip SPENT, during the hold that spends it.
//
// A CALLBACK AND NOT A `hooks` ARGUMENT, unlike every other event the strike
// system raises. Those all come out of updateStrike, which already takes a
// hooks bag; this one is raised by updateCharge, whose signature ends in the
// state it operates on (`s = strikeState`) and whose fourth argument is
// therefore spoken for. Threading a fifth past it would have to be passed by
// all four callers including two harnesses, to deliver something only one of
// them wants.
//
// Registered ONCE, at wiring time, rather than per frame. There is exactly one
// listener — the seal the player is holding the button on — and the run's own
// state is the only one that reaches it (see the `s === strikeState` test in
// updateCharge, which is what keeps a match's CPU wind-ups out of the mix).
let burnHook = null;

/**
 * Listen for pips coming off the bar during a wind-up. `cb(burned, total)`,
 * where `burned` counts from 1 within THIS hold — so a caller can pitch a run
 * off it — and `total` is the bar's length in pips.
 *
 * Pass null to stop listening. Replacing an existing listener rather than
 * adding to a list is deliberate: two things pitching the same run would be
 * the chord this whole corner of the file is built to avoid.
 */
export function onStrikeBurnPip(cb) {
  burnHook = typeof cb === 'function' ? cb : null;
}

// PIP TICKS ARE QUEUED, NEVER FIRED FROM THE FILL.
//
// A magnet sweep collects six orbs inside ONE frame — the same pile-up
// `chainGaps` above exists for. Six ticks on one frame is a chord, and the one
// thing the tick has to say is "that is another pip", six times.
//
// So crossings go in a queue that drains on a floor (`pipGap`), which turns a
// sweep into an ascending run instead. The queue is bounded: a huge gulp can
// only ever be worth a bar's worth of pips, and anything past `maxPips` of
// backlog is dropped from the FRONT so the run always ends on the pip that
// actually filled the bar.
const pipQueue = [];

/**
 * HOW MANY PIP BOUNDARIES A FILL CROSSED — the one place that arithmetic lives.
 *
 * Read by two things that must never disagree: the pip QUEUE below (the pops on
 * the ring) and the food chain's payout (see feedChum). They are the same event
 * seen twice — a pip landing — and two copies of this floor division would be
 * two definitions of what a link is worth.
 */
function pipsCrossed(before, after, stats) {
  const n = pipCount(stats);
  return Math.max(0, Math.floor(after * n + 1e-6) - Math.floor(before * n + 1e-6));
}

function notePips(before, after, stats) {
  const n = pipCount(stats);
  const from = Math.floor(before * n + 1e-6);
  const crossed = pipsCrossed(before, after, stats);
  const to = from + crossed;
  if (!crossed) return;

  for (let i = from; i < to; i++) pipQueue.push({ index: i + 1, total: n });
  const cap = CONFIG.strike.charge.maxPips ?? 12;
  if (pipQueue.length > cap) pipQueue.splice(0, pipQueue.length - cap);
}

/**
 * ONE MOUTHFUL, BOOKED AGAINST THE CHAIN. This is what keeps a chain alive.
 *
 * DELIBERATELY NOT TIED TO A PIP CROSSING, and that distinction is the whole
 * point: chainPips counts FOOD EATEN, the bar counts FUEL STORED, and they are
 * different resources. Booking this off the bar instead would put a hole in
 * the rule exactly where the player is doing best — with a full bar, every
 * further mouthful crosses no pip, so "keep eating to keep the chain" would
 * quietly stop being true and the chain would lapse mid-feast.
 *
 * Still gated on isFeeding(), so the ENTRY condition is untouched: a chain is
 * opened by a dash exactly as before, and cruising over a stray orb does not
 * silently start one. What changed is only what keeps it going.
 */
function noteChainMouthful(count = 1, s = strikeState) {
  // WHOSE CHAIN. The run's by default — and in a match, the seal that ate it.
  // Every counter this touches is already per state (createStrikeState); what
  // was missing was the argument. The TRACE is not: it is the player's own
  // debug read (systems/chainTrace.js) and a CPU seal filing misses into it
  // would bury the only line in there that is about a person.
  const own = s === strikeState;
  if (!chainAllowed()) return;
  // Ungated: progress toward the NEXT link is just food eaten since the last
  // strike, whether or not a combo is currently running.
  s.pipsSinceStrike += count;
  // The rest is the live chain, which does need a window open.
  if (!isFeeding(s)) {
    if (own) noteChain('miss', { why: 'no window open' });
    return;
  }
  // THE WINDOW IS HELD OPEN BY EATING, WHETHER OR NOT THE EATING SCORED.
  //
  // Above the payout gates on purpose. A full bar pauses the CHAIN, not the
  // chain's clock: a player finishing a pile with a maxed bar is doing the
  // right thing and should not watch the combo lapse in their face for it —
  // the pause is "no more links until you strike", not "you are on a timer
  // now". Nothing is farmed by holding a chain open, because holding it open
  // is exactly what pays nothing.
  s.chainTimer = CONFIG.strike.chainWindow;

  // ---- A FULL BAR IS THE PAUSE ------------------------------------------
  // `count` is PIPS OF FUEL that went in, not mouthfuls that went down (see
  // feedChum), so a swallow into a bar with no room arrives here as zero and
  // scores nothing by construction rather than by a rule about it.
  if (count <= 0) {
    if (own) noteChain('miss', { why: 'bar full — strike again to re-open it' });
    return;
  }

  // ---- AND THE LINK ITSELF, ONE PER MOUTHFUL ----------------------------
  //
  // THE STRIKE ARMS, THE FOOD SCORES. A release off a PERFECT CHARGE opens the
  // window and sets `armed`; every pip that goes down inside it ticks the
  // chain up by one. So "bank a full wind-up, let go, eat one chum" IS a food
  // chain, and the number climbs with the eating rather than waiting on
  // another perfectly-timed release to cash it in.
  //
  // The timing of the release is not in this any more — see tryStrike. It
  // decides the strike's DAMAGE; what it no longer decides is whether the
  // mechanic turns on at all.
  //
  // `linkPips` is the mouthfuls it takes to get the FIRST one — the gate, one
  // by default. Measured against `pipsSinceStrike`, which every release
  // clears, so the food has to have been collected FOR this strike.
  //
  // Routed through chainStrike() like every other source, so the switch table
  // and the counter stay in one place. `count` really can be more than one (a
  // gulp hands over a pile), and each mouthful in it is its own link — the
  // pips are the grain of the whole system and a lump that scored once would
  // pay less for the same food.
  if (!s.armed) {
    // WHY IT DID NOT LINK, recorded at the branch that decided it. Four
    // different failures look identical from the seat — nothing happens — and
    // each wants a different fix. See systems/chainTrace.js.
    // Reachable two ways and the wording has to cover both: a wind-up let go
    // of EARLY never completed its charge, and a chain that lapsed took its
    // arming with it.
    if (own) noteChain('miss', { why: 'no charged strike behind it' });
    return;
  }
  if (s.pipsSinceStrike < linkPips()) {
    if (own) noteChain('miss', { why: `${s.pipsSinceStrike} of ${linkPips()} mouthfuls for the first link` });
    return;
  }

  // ---- AND THE BUDGET IS WHAT IS LEFT OF THE BAR THIS STRIKE BOUGHT ------
  // A cycle pays at most one barful. Spent down per pip so a fill that crosses
  // more pips than are left pays only what it can afford — which is the case
  // a magnet sweep hits, handing over a whole pile in one frame.
  const payable = Math.min(count, s.pipBudget);
  if (payable <= 0) {
    if (own) noteChain('miss', { why: 'no charge behind it — strike again to re-open it' });
    return;
  }
  s.pipBudget -= payable;
  // THE MULTIPLIER PAUSES WITH THE COUNTER, deliberately. They are one chain
  // told two ways — the banner and the damage — and a multiplier that kept
  // climbing through the pause would have the number on screen and the damage
  // being dealt disagreeing for as long as the player kept eating.
  s.chainPips += payable;

  // ---- AND THE PRICE GOES UP WITH THE CHAIN -----------------------------
  //
  // The food goes into a bank and links are taken OUT of it at linkCost() a
  // piece — `linkMinPips` for the first, one more per link already held. A
  // mouthful that does not complete a link is not lost; it sits here until the
  // one that does. That is the difference between a price and a combo string:
  // the seal never has to eat N in a row, it has to eat N.
  //
  // Priced against `chainCount` INSIDE the loop rather than once outside it,
  // because a gulp that pays two links pays the second at the second's price —
  // a magnet sweep is not a discount.
  s.linkCredit += payable;
  let scored = 0;
  for (;;) {
    const cost = linkCost(s.chainCount);
    if (s.linkCredit < cost) break;
    const chain = chainStrike('chumEaten', 1, s);
    if (!chain) {
      // The switch table said no. Only reachable with chainOn.chumEaten off,
      // which is a thing a stale tuning snapshot can do — and if it ever
      // happens the log has to say so rather than showing a silent gap. The
      // bank is left alone: nothing was bought, so nothing is spent.
      if (own) noteChain('miss', { why: 'chainOn.chumEaten is off' });
      break;
    }
    s.linkCredit -= cost;
    scored++;
    // NOT BOOKED HERE. extendChain() queues every link at the one place the
    // counter moves, so this loop paying two of them reports two — which is
    // the whole of the fix, and it is one line that is no longer written
    // rather than a line that had to be added.
    if (own) noteChain('link', { chain });
  }
  // WHY THE PART-PAYMENT IS LOGGED. Under the flat rule every mouthful inside
  // an armed window was a link, so silence meant a bug; now it usually means
  // "two of three, keep eating", and the trace is the only place the player's
  // side of that is visible. See systems/chainTrace.js.
  if (own && !scored && s.linkCredit > 0) {
    noteChain('miss', {
      why: `${s.linkCredit} of ${linkCost(s.chainCount)} mouthfuls for link ${s.chainCount + 1}`,
    });
  }
}

// Returned in place of a fresh array when nothing scored, which is almost
// every call: this is asked once per chum orb swallowed, and a run eats
// thousands. Frozen so a caller that pushes into what it was handed fails
// loudly here rather than by quietly growing a shared array.
const NO_LINKS = Object.freeze([]);

/**
 * EVERY FOOD CHAIN LINK SCORED SINCE THE LAST READ, oldest first, as
 * `{ chain, source }` — `chain` being the depth the counter stood at AFTER
 * that link. Empties on read, so a caller that forgets to check cannot replay
 * them on the next orb.
 *
 * ALL OF THEM, AND THAT IS THE POINT. This replaced consumeChainLink(), which
 * returned the most recent one and dropped the rest — so a mouthful worth two
 * links, or a breach worth three, was announced once at the number it finished
 * on and the banner appeared to skip. The scoring was never wrong; only the
 * report was, which is exactly why it survived so long.
 *
 * EVERY PRODUCER PATH MUST DRAIN. There is one producer — extendChain(), via
 * chainStrike() — and each of its callers reads this immediately afterwards,
 * including the ones that then throw the result away (a match seal's links are
 * real and are simply not announced on this screen). A path that scored links
 * and never drained would hand them to whoever asked next, under that caller's
 * source; the bound in extendChain is what stops such a bug growing without
 * limit, and `source` on each entry is what stops it being misattributed.
 *
 * The companion to consumeStrikeLink(), and between them they are every link
 * in the game: one for the sources that fire on an action (a breach, a school
 * emptied), one for the source that fires on food.
 */
export function consumeChainLinks(s = strikeState) {
  if (!s.chainLinks.length) return NO_LINKS;
  const out = s.chainLinks.slice();
  s.chainLinks.length = 0;
  return out;
}

/**
 * HOW MANY MOUTHFULS KEEP THE CHAIN ALIVE — the gate, and it is one.
 *
 * The bar does not have to be full, or anywhere near it. A release inside the
 * sweet spot with a single chum eaten for it extends the chain; what a fuller
 * bar buys is DEPTH, not survival — see releaseLinks() below.
 *
 * It used to be a fraction of the LIVE pip count (`linkBarFraction`, three of
 * five, climbing with the chain), and that one number was doing two
 * incompatible jobs at once: as the gate it decided whether the chain lived,
 * and as the price it was the only thing stopping a chain being free. Every
 * move that made the chain reachable made it cheaper, and every move that kept
 * it honest made it fragile. They are separate now.
 *
 * Floored at 1 — a link has to cost at least one mouthful, or a strike with no
 * eating at all would score one and the FOOD chain would not be about food.
 */
export function linkPips(stats = null) {
  return Math.max(1, Math.round(CONFIG.strike.linkMinPips ?? 1));
}

/**
 * WHAT THE NEXT LINK COSTS, in mouthfuls, at a chain this deep.
 *
 * `linkPips()` is the first one's price and every link after it costs
 * `linkPipsPerLink` more than the link before — so the ladder is 1, 2, 3, 4 at
 * the defaults and a x5 chain has eaten fifteen orbs rather than five. It is
 * the only escalation in the mechanic: the WINDOW does not shorten and the
 * bar does not lengthen (see pipCount), because a price the player can count
 * in food is one they can see coming.
 *
 * @param chain links already banked — 0 for the link that opens a chain.
 * @returns whole mouthfuls, never below 1.
 */
export function linkCost(chain = 0, stats = null) {
  const step = Math.max(0, CONFIG.strike.linkPipsPerLink ?? 0);
  return Math.max(1, Math.round(linkPips(stats) + step * Math.max(0, chain)));
}


// WHAT A FULLER BAR BUYS IS NOT A BONUS ANY MORE, IT IS THE COUNTING.
//
// This is where a `releaseLinks()` ladder used to live — one link at the gate,
// one more per whole bar banked, cashed on the release. It is gone because the
// per-mouthful tick in noteChainMouthful is the same idea told properly: five
// pips is five links whether they arrive as one release off a full bar or as
// five orbs eaten across a window, and the player sees each one land instead
// of a number jumping by three at a moment they cannot attribute.

/** How many pip ticks are waiting to be heard. For the tests and the tuner. */
export function pendingPips() {
  return pipQueue.length;
}

/**
 * HOW MANY PIPS THE BAR IS DIVIDED INTO — and it does not move during a run.
 *
 * Derived from the refill rather than configured next to it — pips =
 * round(1 / strikeChumRefill) — so ONE CHUM IS ALWAYS EXACTLY ONE PIP and the
 * two can never drift apart. Coiled Spring raises the refill and the pip count
 * falls out of it: 0.20 is five pips, four stacks reach 0.36 and three pips,
 * which is the "from 5 to 3" the card's own note promises.
 *
 * THE CHAIN USED TO LENGTHEN IT, one pip per link, as the cost escalation that
 * made each link dearer than the last. THE ESCALATION IS STILL THERE AND THE
 * BAR IS NOT WHERE IT IS CHARGED — see linkCost(), which raises the MOUTHFULS
 * a link costs instead. It could not survive here, because links tick per PIP:
 * the count would be a function of how much has been eaten, while eating is
 * the thing filling it. The bar would grow while you filled it, and a six-pip
 * bar would take seven chum for reasons nothing on screen could explain. That
 * is precisely the unpredictability the pips were introduced to remove,
 * arriving by a third route.
 *
 * So the bar is a fixed length for a given `strikeChumRefill`, which is the
 * strongest form of the invariant it has ever had. `maxPips` still binds it,
 * because a card stack could otherwise derive a count past what the ring can
 * draw legibly.
 *
 * @param stats the run's stat block; omitted falls back to the CONFIG default,
 *              which is what the tuner and the tests read.
 */
export function pipCount(stats = null) {
  const c = CONFIG.strike.charge;
  const extra = Math.max(0, Math.round(stats?.strikeExtraPips ?? 0));
  return Math.max(1, Math.min(c.maxPips ?? 12, basePips(stats) + extra));
}

/**
 * The bar's length before Booster Pack adds containers to it —
 * round(1 / strikeChumRefill), capped like the bar. `strikeChargeTime` is the
 * hold that burns THIS many pips; see windUpTime.
 */
export function basePips(stats = null) {
  const c = CONFIG.strike.charge;
  const refill = Math.max(0.02, stats?.strikeChumRefill ?? c.chumRefill ?? 0.2);
  const base = Math.max(1, Math.round(1 / refill));
  return Math.max(1, Math.min(c.maxPips ?? 12, base));
}

/**
 * SECONDS A FULL BAR TAKES TO BURN — and, since the wind-up is the whole bar,
 * seconds to a perfect charge. `strikeChargeTime` is the time for the bar the
 * refill derives; a Booster Pack container adds a pip's worth of holding on
 * top, so a pip burns in the same fifth of a second whatever the bar's length
 * and the perfect strike still lands as the last container empties.
 */
export function windUpTime(stats = null) {
  const time = Math.max(0.05, stats?.strikeChargeTime ?? CONFIG.strike.charge.time ?? 1);
  return time * pipCount(stats) / basePips(stats);
}

/** What one chum is worth, as a fraction of the whole bar. Always one pip. */
export function pipValue(stats = null) {
  return 1 / pipCount(stats);
}

/**
 * THE POWER A RELEASE NEEDS TO FIRE, as a fraction of the bar — counted in
 * PIPS (CONFIG.strike.charge.minFirePips) for the reason pipValue exists:
 * the bar is a whole number of mouthfuls, and "one pip fires" survives a card
 * that changes what a mouthful is worth. It was a bar fraction (0.35) before,
 * which on a five-pip bar meant a single pip could never be spent — the one
 * mouthful you have in a boss fight bought nothing, and the dodge that pays
 * the meter back could not be made with it.
 *
 * One pip buys the smallest dash there is: reachMulMin of the duration, no
 * steering (see steerAuthority) — a quick straight burst out of a line,
 * more a dodge than a strike.
 */
export function minFire(stats = null) {
  const pips = Math.max(0, CONFIG.strike.charge.minFirePips ?? 1);
  return Math.min(1, pips * pipValue(stats));
}

// A pip is banked by burning it out of the tank a frame at a time, and the sum
// of those burns lands a rounding hair under the pip's own value — so every
// gate on minFire compares with this much slack, or the one pip a boss fight
// leaves you could bank to 0.19999999999999998 and never fire.
const FIRE_EPS = 1e-6;

/**
 * What one chum is worth RIGHT NOW, as a multiplier on the BASE mouthful.
 *
 * Kept because the HUD, the tuner and the strike tests all ask this question,
 * but it is now a REPORT rather than the rule: the pip count is the rule, and
 * this divides out to whatever ratio that implies. A chain-free bar returns 1,
 * which is the invariant the tests pin.
 */
export function chumRefillMul(stats = null) {
  const c = CONFIG.strike.charge;
  const refill = Math.max(0.02, stats?.strikeChumRefill ?? c.chumRefill ?? 0.2);
  const base = Math.max(1, Math.round(1 / refill));
  return pipValue(stats) * base;
}

/**
 * How deep the chain is RIGHT NOW, in whole links, or 0 if there isn't one.
 *
 * `chainCount` is left standing after the window expires (see updateStrike),
 * so it is not the number to read on its own — the discount above and the
 * night sky's reach both want a chain that is over to count as no chain, and
 * both used to spell that out for themselves.
 */
export function liveChain(s = strikeState) {
  return s.chainTimer > 0 ? s.chainCount : 0;
}

/**
 * THE MULTIPLIER'S DEPTH, in links — and it is FRACTIONAL.
 *
 * This is what "the chain piggybacks on the pips" means in one function. The
 * depth is mouthfuls divided by the mouthfuls a bar holds, so five orbs is
 * exactly one link's worth of multiplier and every single orb moves it by a
 * fifth. Every consumer — comboSpeedMul, the damage exponent, the score
 * multiplier — reads this instead of the bar counter.
 *
 * Fractional is the whole trick, and it is why NOT ONE tuning constant had to
 * be rescaled: `comboSpeedPerLevel`, `chainDamageMul` and
 * `comboMultiplierPerChain` still mean exactly what they meant per link. They
 * simply accrue smoothly now instead of jumping when a bar happens to top off.
 *
 * Measured against the BASE pip count, not the current one. The live count
 * grows as links land (that is the price escalation), and dividing by a moving
 * number would make the multiplier fall backwards the instant a link was
 * scored — you would earn a link and get slower.
 */
export function chainLevel(stats = null, s = strikeState) {
  if (s.chainTimer <= 0) return 0;
  const c = CONFIG.strike.charge;
  const refill = Math.max(0.02, stats?.strikeChumRefill ?? c.chumRefill ?? 0.2);
  const perLevel = Math.max(1, Math.round(1 / refill));
  return s.chainPips / perLevel;
}

/**
 * The chain's damage multiplier — one place, so the three call sites that used
 * to spell out the same `Math.pow` can't drift apart.
 *
 * READS THE BANNER'S NUMBER, `liveChain()`, not the fractional pip depth. The
 * two disagree by the whole pip count — five mouthfuls to a bar means a chain
 * reading x10 on screen was worth level 2 here — so the number the player is
 * shown and the damage they deal used to be five links out of step, and the
 * banner is the only one of the two they can see. Points do the same (see
 * comboMultiplierFor in systems/scoring.js). XP DELIBERATELY DOES NOT: it is
 * banked forever where these are spent inside the window, so chainXpMul stays
 * on the slower counter — see the note there.
 *
 * Consequence worth knowing before retuning: every source of a link now moves
 * this, not just eating. A breach with Porpoising or a school emptied in one
 * strike raises the banner (extendChain) without putting a pip in the bar, and
 * damage now follows the banner.
 *
 * The `- 1` offset is inherited and deliberate: the first link opens the chain
 * and pays no damage bonus, exactly as link 1 never did. It is a config value
 * so the "your first mouthful already hits harder" version is one number away.
 * Same units on both counters — `chainLevel` is fractional LINKS — so one
 * offset still means the same thing to this and to the xp multiplier.
 */
export function chainDamageMul(stats, s = strikeState) {
  const offset = CONFIG.strike.chainLevelOffset ?? 1;
  const raw = Math.pow(stats?.strikeChainMul ?? 1, Math.max(0, liveChain(s) - offset));
  // CAPPED, like its two remaining siblings. comboSpeedMul stops at
  // comboSpeedMax and chainXpMul at xp.chain.max; the score multiplier is the
  // one that is deliberately unbounded, because nothing is played with it.
  // This one was an unbounded exponential, which nobody noticed while chains
  // were rare — and an exponent IS the difference: a big score is a big
  // number, a big damage multiplier is every fight in the run being over.
  //
  // They are not rare any more. Simulated against the chum rates in the real
  // run logs (npm run sim:chain), a busy stretch reaches chain level ~38 —
  // x49 strike damage, climbing with no ceiling at all. The cap is the missing
  // third of a set, not a nerf to a deliberate design.
  //
  // IT IS ALSO THE DIAL THAT MATTERS NOW. Reading the banner instead of the
  // pip depth reaches any given exponent five times sooner: at the shipped
  // 1.11 per link, `chainDamageMax` 4 lands at x14 on the banner where it used
  // to take about seventy mouthfuls. The ceiling is what a deep chain is worth
  // — tune it, not the per-link step, which is the shallow end's feel.
  return Math.min(CONFIG.strike.chainDamageMax ?? Infinity, raw);
}

/**
 * The chain's XP multiplier — the fourth of the set, and the last one the chain
 * did nothing for. See CONFIG.xp.chain.
 *
 * LINEAR, deliberately, where the damage multiplier is exponential. Damage is
 * spent on one creature and the chain that earned it dies with the window;
 * xp is banked forever, so an exponential here would mean one exceptional chain
 * decided the rest of the run. Linear-and-capped makes a deep chain worth
 * hunting for without making it worth restarting a run over.
 *
 * AND IT IS THE ONE MULTIPLIER LEFT ON `chainLevel`. Points and damage read
 * the banner's whole-link count now, which is five times faster on the shipped
 * pip count and moves on breaches and school wipes as well as on food. That
 * acceleration is fine for two things spent inside the window and dead with it;
 * on the xp ladder it would be five times the permanent income, compounding
 * into every rung after it. The slower counter is the clamp, deliberately:
 * chum eaten, nothing else, at a bar's granularity.
 *
 * Returns 1 with no chain running, so the call site needs no branch of its own.
 */
export function chainXpMul(stats = null) {
  const c = CONFIG.xp?.chain;
  const perLink = c?.perLink ?? 0;
  if (!(perLink > 0)) return 1;
  const offset = CONFIG.strike.chainLevelOffset ?? 1;
  const level = chainLevel(stats);
  if (level <= offset) return 1;
  return Math.min(c?.max ?? Infinity, 1 + (level - offset) * perLink);
}

/**
 * A chum orb swallowed. ALWAYS puts fuel back — food is the bar's only source,
 * so gating this on anything would be a way to strand the player with an empty
 * bar. Returns true only when it topped the bar off inside a live combo, which
 * is the case the caller turns into a FOOD CHAIN link.
 */
export function feedChum(stats, s = strikeState) {
  if (!CONFIG.strike.enabled) return false;
  // THE BAR MOVES FIRST, AND WHAT IT MOVED BY IS WHAT THE CHAIN IS PAID.
  //
  // This used to be booked BEFORE the fill and deliberately ignored whether
  // the bar had room, so that a full bar was not "a hole in the chain rule".
  // The hole is the rule now: a link is a pip of fuel going in, so a swallow
  // into a bar that is already full moves nothing and scores nothing, and the
  // chain holds until a charged release empties the bar and buys the next one.
  const before = s.charge;
  // Exactly one pip. Not `strikeChumRefill` directly: the pip count is rounded
  // off it, so paying the raw fraction would leave the bar landing a hair
  // short of a boundary and the last pip needing a second orb to close.
  const filled = fillMeter(pipValue(stats), stats, s);
  noteChainMouthful(pipsCrossed(before, s.charge, stats), s);
  return filled;
}

// One link of the FOOD CHAIN. Starts a chain if none is running, extends the
// one that is, and refreshes the window either way. The single place the chain
// counter moves — every source below routes through here so a link means the
// same thing whatever caused it.
function extendChain(s = strikeState, source = '') {
  const chaining = s.chainTimer > 0;
  s.chainCount = chaining ? s.chainCount + 1 : 1;
  s.chainTimer = CONFIG.strike.chainWindow;
  // BOOKED WHERE THE COUNTER MOVES, so a link cannot be scored without being
  // reportable. Every earlier attempt at this lived at the call sites — one
  // remembered number in noteChainMouthful, one return value out of
  // chainStrike — and each of them could drop a link while the count stayed
  // right, which is a bug with no symptom except a number that skips.
  s.chainLinks.push({ chain: s.chainCount, source });
  // BOUNDED, AND IT DROPS THE OLDEST. Nothing should ever reach this: every
  // producer drains (see consumeChainLinks), so a backlog means a path that
  // forgot to. What it must not do is grow for a whole run and then announce
  // a hundred stale numbers at whoever asks first — and if links have to be
  // lost, the ones worth keeping are the ones nearest the count the chain is
  // actually at. Same rule, same reason, as the pip queue's cap.
  const cap = Math.max(1, CONFIG.strike?.foodChain?.maxPendingLinks ?? 24);
  if (s.chainLinks.length > cap) s.chainLinks.splice(0, s.chainLinks.length - cap);
  return s.chainCount;
}

/**
 * Extend the chain from something that ISN'T a dash landing on an enemy —
 * collecting an orb, emptying a school, breaching the surface. Each source is
 * switchable and rate-limited independently (see
 * CONFIG.strike.chainOn), so one that fires every frame can't run the counter
 * away while the others stay honest.
 *
 * @param {string} source key in CONFIG.strike.chainOn
 * @param {number} links  how many links to add at once (Porpoising stacks)
 * @returns {number} the chain count after the links land, or 0 if the source
 *   is switched off, still cooling down, or the strike system is disabled —
 *   so the caller can treat 0 as "nothing happened, show nothing".
 */
export function chainStrike(source, links = 1, s = strikeState) {
  if (!CONFIG.strike.enabled || !chainAllowed()) return 0;
  const on = CONFIG.strike.chainOn;
  if (!on?.[source]) return 0;
  // `chumFull` and `chumEaten` are the SAME food seen at two grains — every
  // mouthful, and the one that happens to top the bar off. With both live, the
  // fifth chum of every bar scores twice and the banner jumps by two for no
  // reason the player can see.
  //
  // Enforced here rather than left to the config default because a saved tuning
  // snapshot outranks that default (any value in imported-tuning.json wins), so
  // a `chumFull: true` captured before the per-mouthful trigger existed would
  // silently double-score forever. The structural rule cannot be out-voted.
  //
  // It used to name `strikeRelease`, which was the engine then and is off now;
  // pointing it at whatever the live engine happens to be is the whole reason
  // it is a rule here rather than a default over there.
  if (source === 'chumFull' && on.chumEaten) return 0;
  if (s.chainGaps.has(source)) return 0;

  const gap = on.cooldowns?.[source] ?? 0;
  if (gap > 0) s.chainGaps.set(source, gap);

  let chain = 0;
  for (let i = 0; i < Math.max(1, links); i++) chain = extendChain(s, source);
  return chain;
}

/**
 * A blue charge orb. Fills the meter outright — that IS the orb's identity,
 * and under the charge model "skip the second of winding up" is a far bigger
 * favour than the spare charge it used to hand over.
 *
 * Returns true when it filled the meter inside a live combo, exactly like
 * feedChum: it reached the chain through the meter, which is the only route
 * orbs have now.
 */
export function restoreCharge(stats = null, s = strikeState) {
  creditOrb(s);
  return fillMeter(1, stats, s);
}

/**
 * THE ORB'S CREDIT WITHOUT ITS FUEL — everything restoreCharge does to the
 * CHAIN, split out for the caller that hands the fuel over a pip at a time as
 * the goo arrives (systems/pickupAbsorb.js) and so cannot let one call do both.
 *
 * Booked on the frame the orb is TOUCHED, which is why it can be split off at
 * all: the chain is about the swallow, not about how long the goo takes to get
 * home. A credit that waited for the last blob would let a window lapse in the
 * half-second the vacuum is running.
 */
export function creditOrb(s = strikeState) {
  // ONE LINK, NOT A BARFUL, and this is the one place the pip rule is
  // deliberately not applied. A blue orb fills the meter outright, so by the
  // arithmetic everywhere else it would cross a whole bar of pips and pay a
  // whole bar of links for a single pickup — which would make the orb the best
  // combo tool in the game and the eating beside the point. Its identity is the
  // FUEL; it is credited the one mouthful it looks like.
  //
  // Booked BEFORE the fill for the same reason, since afterwards the bar is
  // full and the crossing is already spent. Still budget-gated inside, so an
  // orb caught during the pause cannot re-open it.
  noteChainMouthful(1, s);
  // An orb caught mid-dash is meant to read as "go again, right now" — so it
  // also refreshes the chain window. Without this you could grab the pickup
  // that lets you keep going and still watch the combo lapse while the dash
  // you're already in played out. Deliberately only while a dash is live: a
  // charge picked up cruising around shouldn't hold an old combo open.
  if (s.active && s.chainCount > 0) {
    s.chainTimer = CONFIG.strike.chainWindow;
  }
}

/**
 * HOW MANY CONTAINERS ON THE BAR ARE NOT LIT — what an orb still has to hand
 * over, counted in whole pips.
 *
 * This is the length of the vacuum: the orb is absorbed in one piece per pip
 * (see the blue orb in main.js), so a bar with two pips missing goes down in
 * two blips and an empty one takes the whole ladder. That is the tell about
 * how much the pickup was actually worth to you, which the old instant fill
 * could not say — a full bar and an empty one looked exactly alike.
 *
 * CEILED, so a part-burned pip counts as a whole one to refill: the bar is
 * snapped to pips on every fill, but a meter caught mid-HOLD is partway
 * through burning one, and a floor there would leave the last sliver unpaid
 * and the vacuum one blip short of full.
 */
export function pipsToFull(stats = null, s = strikeState) {
  const n = pipCount(stats);
  return Math.max(0, Math.ceil(n - Math.min(1, s.charge) * n - 1e-6));
}

/**
 * PART of a meter, from something that isn't an orb — currently the sun (see
 * CONFIG.dayNight.pass.sun.charge).
 *
 * Separate from restoreCharge above rather than a fraction argument on it,
 * because they are different promises: an orb fills the meter outright and
 * that is its whole identity, while this hands over a share of one and lands
 * wherever the pips say it lands. Same return contract as feedChum and
 * restoreCharge — true only when it was the thing that TOPPED the meter off
 * inside a live combo, which is what earns the caller a FOOD CHAIN link.
 */
export function addCharge(amount, stats = null, s = strikeState) {
  if (!(amount > 0)) return false;
  return fillMeter(amount, stats, s);
}

/**
 * END THE DASH — the one path, whether it ran out or was broken out of.
 *
 * Shared rather than duplicated because the dash's end does more than clear a
 * flag: it is where the combo window starts. A cancel that only set `active`
 * false would silently cost the player the window their strike paid for, which
 * is invisible until a chain quietly stops being reachable after any manual
 * break-out.
 *
 * THE WINDOW STARTS WHEN THE DASH ENDS, not when it was released. A dash runs
 * 0.13-0.48s, and during it the seal is committed — flying in one direction at
 * 46 u/s, not choosing what to eat. Starting the clock at the release spent up
 * to 44% of a 1.1s window on the one stretch the player could not use it, and
 * punished the biggest strikes hardest.
 *
 * Only ever EXTENDS the window: a chain kept alive by eating mid-dash has
 * already set the timer to a full window, and this sets it to the same value.
 *
 * The i-frames are deliberately left running. They were bought with the same
 * banked power the reach was, and taking them away for steering out of a bad
 * line would make the break-out a punishment rather than a control.
 */
function finishDash(s = strikeState) {
  s.active = false;
  s.dashTimeLeft = 0;
  // Everything the dash MAGNETISED is still on its way in. Opening the window
  // here rather than at launch keeps it the same length whatever the dash's
  // own duration was.
  s.blastGrace = Math.max(0, CONFIG.strike.pickupBlast?.grace ?? 0);
  // AND THE HANDS ARE HANDED BACK rather than taken away. Same shape as the
  // line above and opened in the same place, for a reason of its own: the
  // takeover curve gives the player ALL of the turn rate on the dash's last
  // frame and then stops calling dashSteer at all, so the one moment they are
  // fully in control is the moment control ends. What is left is a body doing
  // 33 u/s with 19 u/s^2 of thrust against it — measured at zero degrees of
  // turn for the next seven tenths of a second, which is the whole of "the
  // follow-through is broken". This window is the exit from the manoeuvre.
  s.steerGraceMax = Math.max(0, CONFIG.strike.dashControl?.followThrough ?? 0);
  s.steerGrace = s.steerGraceMax;
  //
  // ...FOR A DASH THAT WAS RELEASED ON THE BEAT. This is the same window
  // tryStrike opens, moved to where the player can use it, so it answers to
  // the same gate — without the check a mistimed strike would open its combo
  // window a fifth of a second late instead of not at all.
  if (s.armingStrike && CONFIG.strike.windowFromDashEnd !== false) {
    s.chainTimer = Math.max(s.chainTimer, CONFIG.strike.chainWindow);
  }
}

/** Break out of a dash early — see the break-out branch in updatePlayer. */
export function cancelDash(s = strikeState) {
  if (s.active) finishDash(s);
  // A BREAK-OUT WANTS OUT, and that includes the follow-through. finishDash
  // opens the window on every ending, which is right for a dash that ran its
  // course and wrong for one the player shoved the stick backwards to escape:
  // leaving it open would keep the dash's turn rate on the seal for a fifth of
  // a second after they asked for ordinary swimming back.
  s.steerGrace = 0;
  s.steerGraceMax = 0;
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e), onChainHit(chainCount),
//          onPip(index, total) }
// Returns { spawnOrb } — true on the frame the orb timer fires, so the caller
// can do the actual spawning.
//
// Takes the whole `stats` block rather than just the hit radius it used to:
// damage and the chain multiplier are per-run values now (see recomputeStats),
// so the upgrades can scale them.
export function updateStrike(dt, scene, playerPos, stats, enemiesList, hooks, s = strikeState) {
  // The trace's clock, on the same dt the mechanic runs on — so a timestamp in
  // the log is the run's own time and a paused game leaves no gap mid-chain.
  const own = s === strikeState; // the run's own state: the trace, the pip queue and the orb timer are its alone
  if (own) tickChainTrace(dt);
  // No recharge tick any more — the meter has no passive regeneration at all.
  // It fills by holding the button or by eating, and nothing else, which is
  // what makes food the resource rather than time.
  if (s.blastGrace > 0) {
    s.blastGrace = Math.max(0, s.blastGrace - dt);
  }
  if (s.chainTimer > 0) {
    s.chainTimer -= dt;
    if (s.chainTimer <= 0) {
      // Clamped, not left negative: `chainTimer` is read as a 0..window
      // fraction by the ring's chain arc, and a negative would draw backwards.
      s.chainTimer = 0;
      noteChain('lapse', { chain: s.chainCount });
      // Both counters die with the window, together. Leaving chainPips
      // standing would carry the last combo's multiplier into the next one.
      s.chainCount = 0;
      s.chainPips = 0;
      // The part-paid link goes with them. Carrying it would let a chain that
      // lapsed subsidise the next one, and the price is per chain.
      s.linkCredit = 0;
      // The arming dies with the chain it armed. Without this a single sweet
      // strike would license every mouthful for the rest of the run.
      s.armed = false;
    }
  }
  // Drain one pip tick per `pipGap`, so a magnet sweep comes out as a rising
  // run rather than a chord. One per frame at most — the floor is the whole
  // point, and draining the backlog in a while-loop would undo it.
  if (own) pipCooldown -= dt;
  if (own && pipQueue.length && pipCooldown <= 0) {
    const pip = pipQueue.shift();
    pipCooldown = CONFIG.strike.charge.pipGap ?? 0.055;
    hooks?.onPip?.(pip.index, pip.total);
  }
  // Deleting the entry is what re-arms the source, so an idle one costs
  // nothing until it next fires.
  // Run down the per-source chain throttles. Per STATE now — they used to be
  // one module map ticked only for the run's own seal, which with a chain on
  // every seal would have left a CPU's first link closing that source for the
  // rest of the match.
  for (const [source, left] of s.chainGaps) {
    const next = left - dt;
    if (next <= 0) s.chainGaps.delete(source);
    else s.chainGaps.set(source, next);
  }
  if (s.invulnTimer > 0) s.invulnTimer = Math.max(0, s.invulnTimer - dt);
  if (s.steerGrace > 0) s.steerGrace = Math.max(0, s.steerGrace - dt);

  if (s.active) {
    s.dashTimeLeft -= dt;
    if (s.dashTimeLeft <= 0) {
      finishDash(s);
    }

    for (let i = enemiesList.length - 1; i >= 0; i--) {
      // Shrink-safe: a kill inside this loop can take several creatures out
      // of the list at once. See the note in systems/club.js.
      const e = enemiesList[i];
      if (!e) continue;
      if (s.hits.has(e)) continue;
      // Through the shared test, so a dash connects with the part of the
      // animal the seal actually reached. On a boss that is the difference
      // between ramming its flank and ramming a circle two metres off it —
      // see systems/hitShape.js. `+ 0.3` was always the ram's own slack and
      // stays exactly that.
      if (!hitCreature(e, playerPos.x, playerPos.y, stats.hitRadius + 0.3, strikeContact)) continue;

      // A dash connecting used to be the original chain source. It is off by
      // default now — the FOOD chain is bought with food, and a ram feeds
      // nobody — but it stays routed through the same switchable table as
      // every other source so turning it back on is one flag.
      // `hitThisDash` already caps it at one link per creature per dash, hence
      // no cooldown.
      const chain = own ? chainStrike('strikeHit') : 0;

      // Two independent multipliers, and they are meant to compound: how hard
      // you charged THIS strike, and how deep the chain already is. That
      // product is the whole reward curve — a full-charge strike landing on
      // link six is worth several times either one alone.
      //
      // `liveChain()` rather than the raw counter: with the hit no longer
      // scoring its own link, the depth this reads is whatever the FOOD is
      // paying for, and an expired chain has to count as no chain.
      const mul = chainDamageMul(stats, s);
      // A ram deals nothing to ORDINARY FLESH at the shipped `contactShare` of
      // 0 — the strike's damage went off where it was released, and the one
      // exception is the weak spot below. The flash and the pop still
      // fire: something the size of a seal just hit this creature at dash
      // speed, and a body that visibly gets knocked across the screen without
      // so much as flinching reads as a missed collision rather than as a
      // shove.
      //
      // GATED ON THE RELEASE'S TIMING, like every other bite the strike has.
      // What is NOT gated is the two lines below it — the shove and the mark:
      // a seal travelling at dash speed physically hit this animal, and a body
      // that passes clean through a shark reads as a missed collision rather
      // than as a strike that was thrown early.
      const sweet = s.sweetStrike;
      let dmg = sweet ? stats.strikeDamage * powerDamageMul(s) * mul * (CONFIG.strike.contactShare ?? 0) : 0;

      // THE PREY CULL — the seal eats the little ones by swimming through them.
      //
      // Without this the dash killed NOTHING (contactShare ships at 0), so
      // ploughing through a school produced no bodies and therefore no chum,
      // and the food chain was gated on weapons the strike doesn't own. "Dash
      // through a school, get a mouthful per fish" is the loop the whole system
      // is described as being, and it simply wasn't happening.
      //
      // Scoped by the SAME size rule the mark uses (see markTarget), and that
      // shared boundary is the point: a body is either small enough to eat or
      // big enough to paint, never both. Everything above the line still just
      // gets shoved and marked, so "a strike is not a weapon" holds for
      // everything that actually threatens you — this only formalises that a
      // seal the size of a seal eats minnows.
      //
      // AND IT IS A BITE, so it answers to the beat as well. A dash thrown off
      // the beat swims THROUGH a school and takes nothing out of it, which is
      // the loop's own way of saying what went wrong: no bodies, no chum, no
      // refill, no next strike.
      const cull = CONFIG.strike.preyCull ?? {};
      // In a versus match EVERY dash culls: the strike is the only thing that
      // turns a fish into chum there, and a timing window on the one source
      // of food is a match with no food in it.
      const cullArmed = sweet || versusActive();
      if (cullArmed && cull.enabled !== false && e.def.radius < (cull.maxRadius ?? CONFIG.strike.mark?.minRadius ?? 0.65)) {
        // Outright, not a damage number: a fish this size dies to any strike at
        // any charge, and routing it through hp would make the cull depend on
        // the difficulty ramp scaling that hp up out of reach mid-run.
        dmg = Math.max(dmg, e.hp);
      }

      // ---- A WEAK SPOT, IF THE RAM FOUND ONE -----------------------------
      //
      // THE ONE THING A RAM IS A WEAPON AGAINST. Everywhere else on the animal
      // `contactShare` is 0 and a dash is a shove; on a lit spot it lands the
      // strike's whole damage, and a PERFECT charge multiplies it. See
      // CONFIG.strike.weakSpot for why the exception is exactly here and
      // nowhere wider.
      //
      // Asked with the SAME probe the crit below uses, through the same
      // function, because these are one question: what this dash commits to
      // and what it is then multiplied by must never be able to disagree about
      // where the spot is.
      //
      // `armingStrike` and not `sweet`: a perfect charge is enough on its own,
      // the same either/or that arms a food chain. So a player who banked a
      // full bar and steered it into the mark is paid whatever their release
      // timing did.
      const spot = hotSpotUnder(e, strikeContact, playerPos);
      const weak = CONFIG.strike.weakSpot ?? {};
      // Held rather than acted on here, because the EVENT this arms has to
      // fire after the ram (see the hook below): the three layers that land on
      // this frame are ordered like bossVoice's, generic first and most
      // specific last, or the accent arrives before the thing it is accenting.
      const weakRam = !!spot && s.armingStrike && weak.enabled !== false;
      if (weakRam) {
        const perfect = s.perfectStrike ? (weak.perfectMul ?? 1) : 1;
        // max() rather than a replacement, so a run that HAS bought the ram a
        // contact share never loses damage by aiming well.
        dmg = Math.max(dmg, stats.strikeDamage * powerDamageMul(s) * mul
          * (weak.share ?? 1) * perfect);
        // ...and a second max() against a FRACTION OF THE BAR. The line above
        // is flat and the bar it is aimed at is not: by level 20 the whole of
        // it was a third of one percent of a boss. This is the half that keeps
        // the spot worth hitting at every level — see CONFIG.strike.weakSpot.
        // Guarded on maxHp rather than hp so a nearly-dead boss does not make
        // the bite smaller than the flat number the player already earned.
        const frac = weak.maxHpFrac ?? 0;
        if (frac > 0 && e.maxHp > 0) dmg = Math.max(dmg, e.maxHp * frac * perfect);
      }

      // Before the subtraction, so everything downstream — the death check,
      // the hook, the ledger — agrees about what this dash was worth. A ram is
      // aimed (the player chose where to point a seal travelling at dash
      // speed), which is the whole test for whether a source may crit. Returns
      // `dmg` untouched for anything that is not a boss wearing a spot, the
      // prey cull's minnows included.
      // 'ram' — the seal's own body, and the loudest of the three sources a
      // boss answers to. This is the hit the whole jostle is sized against.
      if (dmg > 0) dmg = hotSpotDamage(e, strikeContact, dmg, playerPos, 'ram');

      if (dmg > 0) e.hp -= dmg;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      s.hits.add(e);

      // THE SHOVE — what a base strike actually does. Along the dash's own
      // heading, not along the line between the bodies: the seal is a
      // battering ram travelling in one direction, and pushing radially would
      // make a glancing clip on the way past throw a shark sideways.
      // `source: 'ram'` — the seal's own body, which is one of exactly two
      // things a boss answers to at all (see CONFIG.boss.tenacity). On every
      // other creature in the game the argument does nothing.
      applyKnockback(e, s.dashDir.x, s.dashDir.y, s.power, {
        source: 'ram',
        // WHAT THE BUILD BUYS, and it buys the FLINCH rather than the shove.
        // `boneGain` reaches only the skeleton impulse inside applyKnockback —
        // how far a body is thrown stays a function of the charge, which is a
        // balance number, while how hard the animal is seen to be hit is feel
        // and is allowed to answer to the cards the player picked. The curve
        // and the ceiling are CONFIG.strike.knockback.boneUpgradeExp/Max;
        // measured against the base strike so a first-level seal is 1.
        boneGain: strikeBoneGain(stats),
      });

      // ...AND A PERFECT ONE INTO A LIT SPOT STAGGERS IT. The only stagger a
      // boss can be given — see CONFIG.strike.weakSpot.stagger. Both halves of
      // the test are already answered above: `weakRam` is a lit spot under the
      // contact of an arming dash, and `perfectStrike` is the release. Landed
      // AFTER the ram so the shove is the one that moved it and this is what
      // stopped it, in that order.
      if (weakRam && s.perfectStrike) staggerBoss(e);

      // Only when there is damage to report. A zero handed to the damage hook
      // would file a zero-point hit against the strike in the playtest report
      // and fire a hit burst sized to nothing — the ram announces itself
      // through onRam below, which is sized by COMMITMENT rather than by
      // damage precisely because there usually isn't any.
      if (dmg > 0) {
        hooks.onEnemyDamaged?.(e, dmg, strikeContact.x, strikeContact.y,
          s.dashDir, null, strikeContact);
      }
      hooks.onRam?.(e, s.power, strikeContact);
      // AND, IF IT WAS AIMED. After the ram on purpose — the ram says a body
      // was hit, this says where. `perfectStrike` is passed rather than folded
      // into a number here for the same reason the ram takes `power`: what the
      // moment was WORTH is a feedback decision and belongs at the call site
      // in main.js, not in the system that resolved the hit.
      if (weakRam) hooks.onWeakSpotRam?.(e, strikeContact, s.power, s.perfectStrike);
      // DRAINED, not reported off `chain`. A ram scores one link so the two
      // readings agree today — but the queue is the contract now (see
      // consumeChainLinks) and a producer that leaves its link sitting there
      // hands it to the next caller under the wrong source. The hook's own
      // signature is untouched on purpose: main.js labels this 'strike', and
      // what the chain callout does with that name is a separate rule.
      if (chain) for (const link of consumeChainLinks(s)) hooks.onChainHit?.(link.chain);

      // AND THE MARK. Anything big enough to shrug the shove off is painted
      // for the homing weapons instead — see systems/marks.js for why that is
      // the ram's real payload. markTarget answers "was this one worth
      // painting" itself and returns false for a minnow, so the size rule
      // lives in one place rather than being spelled out at every call site.
      // No marks in a versus match: there are no homing weapons to read them.
      if (!versusActive() && markTarget(e)) hooks.onMarked?.(e);

      // The seal itself is elemental, not just its bullets — so the dash
      // carries it too, at CONFIG.biolum.strikeFraction. Discounted because a
      // dash through six fish applies six statuses on one frame, and at full
      // strength that makes the gun the card is nominally about irrelevant.
      //
      // Measured off the NOMINAL strike rather than off `dmg`: the ram's own
      // damage starts as a chip, and an element scaled to that would make Glow
      // Up! do nothing on a seal that hadn't also bought the strike line. Both
      // riders (this and the shrapnel main.js spawns) answer to
      // CONFIG.strike.damage, which is what that field is now for.
      // riderDamage() returns 0 off the beat, so the status would land carrying
      // nothing — skipped outright rather than applied empty, or a mistimed
      // dash through a school would still paint six creatures with a burn that
      // ticks for zero.
      if (sweet) applyElementalHit(scene, e, riderDamage(dmg, stats), enemiesList, hooks, CONFIG.biolum?.strikeFraction ?? 0.5);

      if (e.hp <= 0) {
        hooks.onEnemyKilled?.(e);
        removeEnemy(scene, i);
      }
    }
  }

  let spawnOrb = false;
  if (own) orbTimer -= dt;
  if (own && orbTimer <= 0) {
    orbTimer = randomBetween(CONFIG.strike.orbSpawnMin, CONFIG.strike.orbSpawnMax);
    spawnOrb = true;
  }

  return { spawnOrb };
}

// ---------------------------------------------------------------------------
// BONE SHRAPNEL — the burst itself.
//
// It lived in main.js beside the ram hook until the fragments were found to be
// dying on the frame they were born (see `ignore` below). It is here now for
// the reason riderDamage is: a rider on the strike belongs with the strike,
// and — the part that matters — NOTHING COULD TEST IT IN main.js. A harness
// that retypes the spawn call is a harness that passes while the game drops an
// argument, which is exactly the failure this function just had.
// ---------------------------------------------------------------------------
// Bone Shrapnel: every enemy the strike dash connects with bursts a ring of
// fragments outward from ITS OWN position, not the seal's — the fish coming
// apart is the source, so a dash through a school leaves overlapping bursts
// rather than one puff at the player. Damage is a fraction of the strike hit
// that spawned it, which is what carries the chain multiplier through.
const shrapnelOrigin = new THREE.Vector3();
const shrapnelDir = new THREE.Vector2();

export function spawnShrapnel(scene, atPos, strikeDamage, from = null, stats = null) {
  const level = stats?.shrapnelCount ?? 0;
  if (level <= 0) return 0;
  const c = CONFIG.strike.shrapnel;
  // The base count is guaranteed positive here (level > 0 above), so the Clone
  // Warz gate is already satisfied — routed through projectileCount anyway so
  // there is exactly one place the bonus is spelled out.
  const n = projectileCount(c.count + c.countPerLevel * (level - 1), stats);
  // A random offset for the WHOLE ring rather than per-fragment: the fragments
  // stay evenly spaced (so there are no bald patches to slip through) while
  // consecutive bursts don't land in an identical star pattern.
  const base = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = base + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * c.spread;
    shrapnelOrigin.set(atPos.x, atPos.y, 0);
    shrapnelDir.set(Math.cos(a), Math.sin(a));
    spawnProjectile(scene, {
      origin: shrapnelOrigin,
      dir: shrapnelDir,
      faction: 'player',
      damage: strikeDamage * c.damageFrac,
      speed: c.speed,
      life: c.life,
      radius: c.radius,
      pierce: c.pierce,
      asset: 'shrapnel',
      source: 'shrapnel',
      // THE BODY IT CAME OUT OF CANNOT STOP IT, and without this line nothing
      // else ever did. The burst spawns AT the point the dash connected —
      // which is on the rammed animal — and a fragment pierces nothing, so the
      // combat pass on the very same frame found that body, spent the fragment
      // on it and despawned it before anything was drawn. Measured against the
      // real hit shapes: five of five fragments gone on frame one, 0.37 units
      // from the burst, on a minnow and on a megalodon alike. The card has
      // been paying its damage back into the creature it burst from and
      // showing the player nothing.
      //
      // Thematically it is also the only right answer: these fragments ARE
      // that animal. A dash through a school still leaves every OTHER body in
      // the water a target, which is the overlapping-bursts read the note at
      // the top of this function describes.
      ignore: from,
      // ROLLS ABOUT ITS OWN LENGTH — CONFIG.strike.shrapnel.roll, which has
      // been authored, documented and tuned to 12 and never once passed to a
      // projectile. `orient` alone leaves the bone pointing down its heading
      // and perfectly still, which on a body this thin is a white stick.
      roll: c.roll,
      // NOSE-FIRST, WITH A ROLL — not the end-over-end spin this had before the
      // fragment became a bone (assets.js `shrapnel`). A tumbling shot has no
      // back, and the back is where its ribbon comes from: CONFIG.trails
      // .shrapnel anchors at `tailOffset: 1`, which is a meaningless anchor on
      // a body whose long axis points somewhere new every frame.
      //
      // 'axis' rather than plain `true`, and this is the one that would have
      // been a bug. The leftward mirror in updateProjectile is a Ry(PI) applied
      // AFTER the heading, so it lands correctly only when the heading is on an
      // axis and is 90 degrees out at a leftward DIAGONAL — and a shrapnel
      // burst is a full ring, which means it fires at every one of those
      // headings every time. The razor blade opts out for the same reason: a
      // bone is symmetric end to end and has no belly to keep downward.
      orient: 'axis',
    });
  }
  return n;
}
