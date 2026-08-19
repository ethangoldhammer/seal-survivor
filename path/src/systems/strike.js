import { CONFIG } from '../config.js';
import { removeEnemy, applyKnockback } from '../entities/enemies.js';
import { applyElementalHit } from './elements.js';
import { markTarget } from './marks.js';
import { hitCreature } from './hitShape.js';
import { noteChain, tickChainTrace } from './chainTrace.js';

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

export const strikeState = {
  charge: 0,       // 0..1 — the FUEL bar. Burned by holding, refilled by food.
  pending: 0,      // power banked so far for the strike being wound up, 0..1
  charging: false, // holding AND there is fuel left to burn
  power: 0,        // the banked power the CURRENT dash was launched with, 0..1
  flash: 0,        // >0 = the bar is flashing, just spent (see strikeRing.js)
  // THE PERFECT CHARGE — the wind-up fully banked, `perfectAt` of the bar.
  //
  // Today this is a READOUT and nothing else: the meter's core pops on the
  // frame it lands (systems/strikeRing.js) so the moment has a shape the
  // player can learn, and `perfectCrossed()` below hands the edge to main.js
  // for the sound and the shake. NOTHING IN THE DASH READS IT YET — power is
  // still a continuous 0..1 and a perfect strike is exactly as strong as the
  // arithmetic says. That is deliberate: the tell ships first so the timing is
  // already familiar by the time it buys anything.
  //
  // WHERE THE MECHANIC GOES. `perfect` is a latch that survives until the
  // power is spent or thrown away, so a payoff can read it in tryStrike (a
  // damage or reach bonus, a free link, a wider gulp) without caring which
  // frame it landed on. `perfectAt` is in weapons.csv because the moment it
  // pays for anything it is a balance number, not a look.
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
  active: false,
  dashTimeLeft: 0,
  dashDuration: 0, // what this dash's length was set to, for the i-frames
  dashDir: { x: 1, y: 0 },
  // TWO CHAIN COUNTERS, BOTH FED BY PIPS, DELIBERATELY DIFFERENT GRAINS.
  //
  //   chainPips  every mouthful eaten inside the window. Drives the MULTIPLIER
  //              — speed, damage, score — so the reward climbs with each orb
  //              rather than jumping once a bar.
  //   chainCount whole BARS filled inside the window. Drives the PRICE (a link
  //              adds a pip) and the FOOD CHAIN! banner, so the ceremony and
  //              the cost escalation stay rare and legible.
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
};

// Is a combo live? The dash itself plus the window that follows it. This gates
// the CHAIN LINK a refill can score — never the refill itself. A dash that
// connects with nothing opens no window, and gating refills on it would strand
// the player with a bar they had no way to fill.
export function isFeeding() {
  return strikeState.active || strikeState.chainTimer > 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Damage multiplier from how hard the live dash was charged. */
export function powerDamageMul() {
  const c = CONFIG.strike.charge;
  return lerp(c.damageMulMin, c.damageMulMax, strikeState.power);
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
 * Neither the swim direction nor the aim on its own was right. Launching along
 * movement alone ignored the cursor entirely, so a strike could only ever go
 * where you were already swimming; launching along aim alone fought the
 * momentum you had committed to. The dash now splits the difference: the
 * heading is the point HALFWAY between the two, so both hands steer it and
 * neither one wins outright. Pull the stick and the cursor together and they
 * agree; spread them and the dash goes between them, which is also the only
 * reading a player can predict from what's on screen.
 *
 * Interpolated as an ANGLE rather than by normalising move + aim. The vector
 * sum collapses to zero when the two are exactly opposed — the one case a
 * player WILL hit, swimming away from what they're shooting at — and would
 * hand back a NaN heading. Wrapping the delta into (-pi, pi] picks a side
 * deterministically instead. It also makes the halfway an angular halfway
 * regardless of how far the movement stick is pushed: a half-tilted stick
 * steers the dash exactly as much as a full one, since it is only ever asked
 * for a direction.
 *
 * A missing input hands the whole heading to the other: no movement means a
 * strike from a standstill still goes at the cursor, and no aim leaves it
 * along the swim. Both missing returns the zero vector — the caller checks it
 * and doesn't fire.
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

  if (mLen <= 0.001) {
    out.x = aLen > 0.001 ? ax / aLen : 0;
    out.y = aLen > 0.001 ? ay / aLen : 0;
    return out;
  }
  if (aLen <= 0.001) {
    out.x = mx / mLen;
    out.y = my / mLen;
    return out;
  }

  const blend = Math.min(1, Math.max(0, CONFIG.strike.aimBlend ?? 0.5));
  const swim = Math.atan2(my, mx);
  // Wrapped into (-pi, pi] so the blend always takes the SHORT way round —
  // without it, aim at 179 deg and swim at -179 deg would sweep the dash the
  // long way through 358 deg and launch it backwards.
  let delta = Math.atan2(ay, ax) - swim;
  delta = ((delta + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const heading = swim + delta * blend;
  out.x = Math.cos(heading);
  out.y = Math.sin(heading);
  return out;
}

// How much faster everything the player does gets while a chain is live —
// dash speed, top speed and thrust all read this, and so does the dash's own
// turn rate, so a fast combo curves just as tightly as a slow one.
// 1 when no chain is running.
export function comboSpeedMul() {
  // Reads the fractional pip depth, so the seal speeds up with every mouthful
  // instead of stepping up once a bar. `comboSpeedPerLevel` is unchanged and
  // still means "per link" — see chainLevel().
  const level = chainLevel();
  if (level <= 0) return 1;
  return Math.min(
    CONFIG.strike.comboSpeedMax,
    1 + CONFIG.strike.comboSpeedPerLevel * level,
  );
}

let orbTimer = 0;
let pipCooldown = 0; // seconds until the next queued pip tick may be heard
const hitThisDash = new Set();
// source name -> seconds until that source may add another link. A chain
// source can arrive in bursts — a magnet sweep collects six orbs inside one
// frame — and without a floor between links that alone would hold a chain
// open indefinitely. Same reasoning as feedback.js's `sfxGaps`: a rate limit
// on the channel that can't take the pile-up.
const chainGaps = new Map();

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

export function resetStrike() {
  // WHAT THE RUN OPENS WITH, in pips — CONFIG.strike.charge.startPips, and it
  // is 0. The bar has no passive regeneration of any kind (see updateStrike),
  // so a dead meter means the FIRST thing a run has to do is eat: the food
  // chain isn't one way to fuel the strike, it is the only one, and opening
  // full let the first minute be played without ever learning that.
  //
  // Read through pipCount rather than as a raw fraction so the setting means
  // the same thing whatever the bar's length is — and clamped, because a value
  // past the pip count would otherwise open above full.
  strikeState.charge = startCharge();
  clearPending();
  strikeState.perfectFlash = 0;
  strikeState.perfectStrike = false;
  strikeState.sweetStrike = false;
  strikeState.armed = false;
  strikeState.charging = false;
  strikeState.power = 0;
  strikeState.flash = 0;
  strikeState.active = false;
  strikeState.dashTimeLeft = 0;
  strikeState.dashDuration = 0;
  strikeState.chainPips = 0;
  strikeState.chainCount = 0;
  strikeState.chainTimer = 0;
  strikeState.pipsSinceStrike = 0;
  lastRelease.depth = 0;
  lastRelease.sweet = false;
  lastRelease.hadFood = false;
  lastRelease.hadWindow = false;
  strikeState.invulnTimer = 0;
  hitThisDash.clear();
  chainGaps.clear();
  pipQueue.length = 0;
  pipCooldown = 0;
  lastMouthful.chain = 0;
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
let perfectEdge = false;

export function updateCharge(dt, held, stats) {
  if (!CONFIG.strike.enabled) return;

  strikeState.charging = !!held && strikeState.charge > 0;
  if (strikeState.charging) {
    // Never more than is in the tank, so the two always move together.
    const burn = Math.min(strikeState.charge, dt / Math.max(0.05, stats.strikeChargeTime));
    strikeState.charge -= burn;
    strikeState.pending = Math.min(1, strikeState.pending + burn);
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
  const left = Math.max(0, Math.min(strikeState.charge, 1 - strikeState.pending));
  if (left <= 1e-6 && strikeState.pending >= (CONFIG.strike.charge.minFire ?? 0.35)) {
    // += on the frames after, 0 on the frame itself, so `sinceLoaded` is the
    // age of the moment rather than the age plus one frame.
    strikeState.sinceLoaded = strikeState.loaded ? strikeState.sinceLoaded + dt : 0;
    strikeState.loaded = true;
    strikeState.toLoaded = 0;
  } else {
    strikeState.loaded = false;
    strikeState.sinceLoaded = 0;
    // The bar drains a whole bar in `strikeChargeTime`, so what is left of it
    // IS the time still to run. A wind-up paused by letting go without firing
    // keeps its distance, which is right: no fuel is burning, so the moment is
    // no closer than it was.
    strikeState.toLoaded = left * Math.max(0.05, stats.strikeChargeTime);
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
  if (!strikeState.perfect && (strikeState.loaded || strikeState.pending >= perfectAt - 1e-6)) {
    strikeState.perfect = true;
    strikeState.perfectFlash = CONFIG.strike.charge.perfectFlashTime ?? 0.5;
    perfectEdge = true;
  }
  if (strikeState.perfectFlash > 0) strikeState.perfectFlash = Math.max(0, strikeState.perfectFlash - dt);

  if (strikeState.flash > 0) strikeState.flash = Math.max(0, strikeState.flash - dt);
}

/** True once, on the frame the wind-up reached a perfect charge. */
export function perfectCrossed() {
  if (!perfectEdge) return false;
  perfectEdge = false;
  return true;
}

/**
 * Throw away a wind-up that will never be spent — a death, a pause that ate
 * the release, a run ending. Clears the latch as well as the power, so the
 * next hold has to earn its own perfect.
 */
function clearPending() {
  strikeState.pending = 0;
  strikeState.perfect = false;
  perfectEdge = false;
  // The sweet spot belongs to the wind-up, not to the seal: a spent or
  // abandoned bank leaves no window standing for the next hold to inherit.
  // `sweetStrike` is deliberately NOT cleared here — it is the stamp on the
  // dash tryStrike is in the middle of launching, and clearing it on the next
  // line would disarm the strike being fired.
  strikeState.loaded = false;
  strikeState.sinceLoaded = 0;
  strikeState.toLoaded = Infinity;
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
export function strikeLoaded() {
  return strikeState.loaded;
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
  const time = Math.max(0.05, stats?.strikeChargeTime ?? CONFIG.strike.charge.time ?? 1);
  return time * Math.max(0, CONFIG.strike.charge.sweetFraction ?? 0.05);
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
export function sweetOffset() {
  if (strikeState.pending < (CONFIG.strike.charge.minFire ?? 0.35)) return -Infinity;
  return strikeState.loaded ? strikeState.sinceLoaded : -strikeState.toLoaded;
}

/**
 * Would a release RIGHT NOW land in the sweet spot?
 *
 * The whole gate, in one place, asked by tryStrike on the release frame and by
 * anything that wants to draw the window. -Infinity fails the comparison on
 * its own, so "nothing banked" needs no branch of its own here.
 */
export function inSweetSpot(stats = null) {
  return Math.abs(sweetOffset()) <= sweetHalfWidth(stats);
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
export function tryStrike(aimDir, stats) {
  if (!CONFIG.strike.enabled) return false;
  const c = CONFIG.strike.charge;

  // Not enough banked. `pending` is kept, not cleared: the fuel is already
  // spent, and confiscating the progress as well would punish a fumble twice.
  if (strikeState.pending < c.minFire) return false;

  // ON THE BEAT? Asked FIRST, before anything is spent: clearPending() below
  // throws the wind-up's timing away along with its power, and every payoff
  // downstream reads this snapshot rather than the live window for the same
  // reason `power` is snapshotted — a dash already in flight must not be able
  // to lose what it was released with. See the sweet spot note on strikeState
  // for what riding on it.
  const sweet = inSweetSpot(stats);
  strikeState.sweetStrike = sweet;
  // Recorded with the SIGNED offset, which is the one number a player has no
  // way of seeing and the one that decides everything downstream: early and
  // late are different mistakes and look the same from the seat.
  noteChain('release', { offset: sweetOffset(), sweet, half: sweetHalfWidth(stats) });

  // Snapshot what this dash was bought with. Damage and reach both read it for
  // the whole dash, so clearing `pending` on the next line can't retroactively
  // weaken a strike already in flight.
  strikeState.power = strikeState.pending;
  // `perfectStrike` is what a payoff will read — see the note on `perfect` in
  // strikeState. Snapshotted onto the launched dash for the same reason
  // `power` is: the latch clears on the next line, and a dash already in
  // flight must not be able to lose what it was bought with.
  strikeState.perfectStrike = strikeState.perfect;
  clearPending();
  strikeState.charging = false;
  // The bar flashing as the fuel becomes a strike.
  strikeState.flash = c.flashTime ?? 0.28;

  // Reach scales the dash's DURATION at constant speed, so the seal's velocity
  // stays readable and a big charge simply travels for longer.
  const duration = stats.strikeDashDuration * lerp(c.reachMulMin, c.reachMulMax, strikeState.power);
  strikeState.active = true;
  strikeState.dashTimeLeft = duration;
  strikeState.dashDuration = duration;
  strikeState.dashDir = { x: aimDir.x, y: aimDir.y };
  // i-frames cover this dash's own length plus a tail, rather than a fixed
  // total — a full-charge dash outlasts the old flat 0.45s, and would have
  // been the one strike in the game that ended with you exposed.
  strikeState.invulnTimer = duration + CONFIG.strike.invulnTail;
  hitThisDash.clear();

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
  const hadFood = strikeState.pipsSinceStrike >= linkPips(stats);
  const hadWindow = strikeState.chainTimer > 0;
  strikeState.pipsSinceStrike = 0;
  if (sweet) strikeState.armed = true;
  // HOW DEEP THE CHAIN WAS when this release happened — not what the release
  // scored, because a release scores nothing. Kept because it is the one thing
  // about a strike the report cannot reconstruct afterwards: whether the
  // player was opening a chain or feeding one that was already running.
  lastRelease.depth = liveChain();
  lastRelease.sweet = sweet;
  lastRelease.hadFood = hadFood;
  lastRelease.hadWindow = hadWindow;

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
  if (sweet && strikeState.chainTimer <= 0) strikeState.chainTimer = CONFIG.strike.chainWindow;

  return true;
}

// The chain scored by the most recent release, waiting to be reported. Held
// rather than returned because tryStrike's boolean is "did a dash launch",
// which the caller branches on for the impulse — widening it to an object
// would touch every call site to say something only one of them cares about.
const lastRelease = { depth: 0, sweet: false, hadFood: false, hadWindow: false };

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
function fillMeter(amount, stats = null) {
  const wasFull = strikeState.charge >= 1;
  const before = strikeState.charge;
  strikeState.charge = Math.min(1, snapToPip(strikeState.charge + amount, stats));
  notePips(before, strikeState.charge, stats);
  const crossed = !wasFull && strikeState.charge >= 1;
  return isFeeding() && crossed;
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

function notePips(before, after, stats) {
  const n = pipCount(stats);
  const from = Math.floor(before * n + 1e-6);
  const to = Math.floor(after * n + 1e-6);
  const crossed = Math.max(0, to - from);
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
function noteChainMouthful(count = 1) {
  // Ungated: progress toward the NEXT link is just food eaten since the last
  // strike, whether or not a combo is currently running.
  strikeState.pipsSinceStrike += count;
  // The rest is the live chain, which does need a window open.
  if (!isFeeding()) {
    noteChain('miss', { why: 'no window open' });
    return;
  }
  strikeState.chainPips += count;
  strikeState.chainTimer = CONFIG.strike.chainWindow;

  // ---- AND THE LINK ITSELF, ONE PER MOUTHFUL ----------------------------
  //
  // THE STRIKE ARMS, THE FOOD SCORES. A release in the sweet spot opens the
  // window and sets `armed`; every pip that goes down inside it ticks the
  // chain up by one. So "release on the beat and eat one chum" IS a food
  // chain, and the number climbs with the eating rather than waiting on
  // another perfectly-timed release to cash it in.
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
  if (!strikeState.armed) {
    // WHY IT DID NOT LINK, recorded at the branch that decided it. Four
    // different failures look identical from the seat — nothing happens — and
    // each wants a different fix. See systems/chainTrace.js.
    noteChain('miss', { why: 'no sweet strike behind it' });
    return;
  }
  if (strikeState.pipsSinceStrike < linkPips()) {
    noteChain('miss', { why: `${strikeState.pipsSinceStrike} of ${linkPips()} mouthfuls for the first link` });
    return;
  }
  for (let i = 0; i < count; i++) {
    const chain = chainStrike('chumEaten');
    if (chain) {
      lastMouthful.chain = chain;
      noteChain('link', { chain });
    } else {
      // The switch table said no. Only reachable with chainOn.chumEaten off,
      // which is a thing a stale tuning snapshot can do — and if it ever
      // happens the log has to say so rather than showing a silent gap.
      noteChain('miss', { why: 'chainOn.chumEaten is off' });
    }
  }
}

// The link the most recent mouthful scored, waiting to be reported. Held
// rather than returned for the same reason `lastRelease` is: feedChum's
// boolean is "did this top the bar off", which its callers branch on, and
// widening it would touch every call site to say something one of them wants.
const lastMouthful = { chain: 0 };

/**
 * The FOOD CHAIN link the last mouthful scored, or 0. Clears on read, so a
 * caller that forgets to check cannot replay an old link on the next orb.
 *
 * The companion to consumeStrikeLink(), and between them they are every link
 * in the game: one for the sources that fire on an action (a breach, a school
 * emptied), one for the source that fires on food.
 */
export function consumeChainLink() {
  const out = lastMouthful.chain;
  lastMouthful.chain = 0;
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
 * made each link dearer than the last. That job is gone: a link is one
 * mouthful now and is not bought with the bar at all. And the escalation could
 * not survive the change even if the job had remained, because links tick per
 * PIP — so the count would be a function of how much has been eaten, while
 * eating is the thing filling it. The bar would grow while you filled it, and
 * a six-pip bar would take seven chum for reasons nothing on screen could
 * explain. That is precisely the unpredictability the pips were introduced to
 * remove, arriving by a third route.
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
  const refill = Math.max(0.02, stats?.strikeChumRefill ?? c.chumRefill ?? 0.2);
  const base = Math.max(1, Math.round(1 / refill));
  return Math.max(1, Math.min(c.maxPips ?? 12, base));
}

/** What one chum is worth, as a fraction of the whole bar. Always one pip. */
export function pipValue(stats = null) {
  return 1 / pipCount(stats);
}

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
export function liveChain() {
  return strikeState.chainTimer > 0 ? strikeState.chainCount : 0;
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
export function chainLevel(stats = null) {
  if (strikeState.chainTimer <= 0) return 0;
  const c = CONFIG.strike.charge;
  const refill = Math.max(0.02, stats?.strikeChumRefill ?? c.chumRefill ?? 0.2);
  const perLevel = Math.max(1, Math.round(1 / refill));
  return strikeState.chainPips / perLevel;
}

/**
 * The chain's damage multiplier — one place, so the three call sites that used
 * to spell out the same `Math.pow` can't drift apart.
 *
 * The `- 1` offset is inherited and deliberate: the first bar's worth of food
 * opens the chain and pays no damage bonus, exactly as link 1 never did. It is
 * a config value now so the "your first mouthful already hits harder" version
 * is one number away.
 */
export function chainDamageMul(stats) {
  const offset = CONFIG.strike.chainLevelOffset ?? 1;
  const raw = Math.pow(stats?.strikeChainMul ?? 1, Math.max(0, chainLevel(stats) - offset));
  // CAPPED, like its two siblings. comboSpeedMul stops at comboSpeedMax and the
  // score multiplier at comboMaxMultiplier; this one was an unbounded
  // exponential, which nobody noticed while chains were rare.
  //
  // They are not rare any more. Simulated against the chum rates in the real
  // run logs (npm run sim:chain), a busy stretch reaches chain level ~38 —
  // x49 strike damage, climbing with no ceiling at all. The cap is the missing
  // third of a set, not a nerf to a deliberate design.
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
 * hunting for without making it worth restarting a run over. Same shape and the
 * same offset as the score multiplier in systems/scoring.js, which is the
 * closest relative it has.
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
export function feedChum(stats) {
  if (!CONFIG.strike.enabled) return false;
  // Booked before the fill, and regardless of whether the bar has room — see
  // noteChainMouthful. A full bar must not be a hole in the chain rule.
  noteChainMouthful();
  // Exactly one pip. Not `strikeChumRefill` directly: the pip count is rounded
  // off it, so paying the raw fraction would leave the bar landing a hair
  // short of a boundary and the last pip needing a second orb to close.
  return fillMeter(pipValue(stats), stats);
}

// One link of the FOOD CHAIN. Starts a chain if none is running, extends the
// one that is, and refreshes the window either way. The single place the chain
// counter moves — every source below routes through here so a link means the
// same thing whatever caused it.
function extendChain() {
  const chaining = strikeState.chainTimer > 0;
  strikeState.chainCount = chaining ? strikeState.chainCount + 1 : 1;
  strikeState.chainTimer = CONFIG.strike.chainWindow;
  return strikeState.chainCount;
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
export function chainStrike(source, links = 1) {
  if (!CONFIG.strike.enabled) return 0;
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
  if (chainGaps.has(source)) return 0;

  const gap = on.cooldowns?.[source] ?? 0;
  if (gap > 0) chainGaps.set(source, gap);

  let chain = 0;
  for (let i = 0; i < Math.max(1, links); i++) chain = extendChain();
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
export function restoreCharge(stats = null) {
  // One pickup, one mouthful against the chain. A blue orb's identity is the
  // FUEL it hands over — a whole bar of it — not the combo; crediting it a
  // bar's worth of multiplier would make the orb the best combo tool in the
  // game and the eating beside the point.
  noteChainMouthful();
  const filled = fillMeter(1, stats);
  // An orb caught mid-dash is meant to read as "go again, right now" — so it
  // also refreshes the chain window. Without this you could grab the pickup
  // that lets you keep going and still watch the combo lapse while the dash
  // you're already in played out. Deliberately only while a dash is live: a
  // charge picked up cruising around shouldn't hold an old combo open.
  if (strikeState.active && strikeState.chainCount > 0) {
    strikeState.chainTimer = CONFIG.strike.chainWindow;
  }
  return filled;
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
export function addCharge(amount, stats = null) {
  if (!(amount > 0)) return false;
  return fillMeter(amount, stats);
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
function finishDash() {
  strikeState.active = false;
  strikeState.dashTimeLeft = 0;
  //
  // ...FOR A DASH THAT WAS RELEASED ON THE BEAT. This is the same window
  // tryStrike opens, moved to where the player can use it, so it answers to
  // the same gate — without the check a mistimed strike would open its combo
  // window a fifth of a second late instead of not at all.
  if (strikeState.sweetStrike && CONFIG.strike.windowFromDashEnd !== false) {
    strikeState.chainTimer = Math.max(strikeState.chainTimer, CONFIG.strike.chainWindow);
  }
}

/** Break out of a dash early — see the break-out branch in updatePlayer. */
export function cancelDash() {
  if (strikeState.active) finishDash();
}

// hooks: { onEnemyDamaged(e, dmg), onEnemyKilled(e), onChainHit(chainCount),
//          onPip(index, total) }
// Returns { spawnOrb } — true on the frame the orb timer fires, so the caller
// can do the actual spawning.
//
// Takes the whole `stats` block rather than just the hit radius it used to:
// damage and the chain multiplier are per-run values now (see recomputeStats),
// so the upgrades can scale them.
export function updateStrike(dt, scene, playerPos, stats, enemiesList, hooks) {
  // The trace's clock, on the same dt the mechanic runs on — so a timestamp in
  // the log is the run's own time and a paused game leaves no gap mid-chain.
  tickChainTrace(dt);
  // No recharge tick any more — the meter has no passive regeneration at all.
  // It fills by holding the button or by eating, and nothing else, which is
  // what makes food the resource rather than time.
  if (strikeState.chainTimer > 0) {
    strikeState.chainTimer -= dt;
    if (strikeState.chainTimer <= 0) {
      // Clamped, not left negative: `chainTimer` is read as a 0..window
      // fraction by the ring's chain arc, and a negative would draw backwards.
      strikeState.chainTimer = 0;
      noteChain('lapse', { chain: strikeState.chainCount });
      // Both counters die with the window, together. Leaving chainPips
      // standing would carry the last combo's multiplier into the next one.
      strikeState.chainCount = 0;
      strikeState.chainPips = 0;
      // The arming dies with the chain it armed. Without this a single sweet
      // strike would license every mouthful for the rest of the run.
      strikeState.armed = false;
    }
  }
  // Drain one pip tick per `pipGap`, so a magnet sweep comes out as a rising
  // run rather than a chord. One per frame at most — the floor is the whole
  // point, and draining the backlog in a while-loop would undo it.
  pipCooldown -= dt;
  if (pipQueue.length && pipCooldown <= 0) {
    const pip = pipQueue.shift();
    pipCooldown = CONFIG.strike.charge.pipGap ?? 0.055;
    hooks?.onPip?.(pip.index, pip.total);
  }
  // Run down the per-source chain throttles. Deleting the entry is what
  // re-arms the source, so an idle one costs nothing until it next fires.
  for (const [source, left] of chainGaps) {
    const next = left - dt;
    if (next <= 0) chainGaps.delete(source);
    else chainGaps.set(source, next);
  }
  if (strikeState.invulnTimer > 0) strikeState.invulnTimer = Math.max(0, strikeState.invulnTimer - dt);

  if (strikeState.active) {
    strikeState.dashTimeLeft -= dt;
    if (strikeState.dashTimeLeft <= 0) {
      finishDash();
    }

    for (let i = enemiesList.length - 1; i >= 0; i--) {
      const e = enemiesList[i];
      if (hitThisDash.has(e)) continue;
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
      const chain = chainStrike('strikeHit');

      // Two independent multipliers, and they are meant to compound: how hard
      // you charged THIS strike, and how deep the chain already is. That
      // product is the whole reward curve — a full-charge strike landing on
      // link six is worth several times either one alone.
      //
      // `liveChain()` rather than the raw counter: with the hit no longer
      // scoring its own link, the depth this reads is whatever the FOOD is
      // paying for, and an expired chain has to count as no chain.
      const mul = chainDamageMul(stats);
      // A ram deals nothing at the shipped `contactShare` of 0 — the strike's
      // damage went off where it was released. The flash and the pop still
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
      const sweet = strikeState.sweetStrike;
      let dmg = sweet ? stats.strikeDamage * powerDamageMul() * mul * (CONFIG.strike.contactShare ?? 0) : 0;

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
      if (sweet && cull.enabled !== false && e.def.radius < (cull.maxRadius ?? CONFIG.strike.mark?.minRadius ?? 0.65)) {
        // Outright, not a damage number: a fish this size dies to any strike at
        // any charge, and routing it through hp would make the cull depend on
        // the difficulty ramp scaling that hp up out of reach mid-run.
        dmg = Math.max(dmg, e.hp);
      }

      if (dmg > 0) e.hp -= dmg;
      e.flash = CONFIG.fx.hitFlash;
      e.hitThisFrame = true;
      hitThisDash.add(e);

      // THE SHOVE — what a base strike actually does. Along the dash's own
      // heading, not along the line between the bodies: the seal is a
      // battering ram travelling in one direction, and pushing radially would
      // make a glancing clip on the way past throw a shark sideways.
      applyKnockback(e, strikeState.dashDir.x, strikeState.dashDir.y, strikeState.power);

      // Only when there is damage to report. A zero handed to the damage hook
      // would file a zero-point hit against the strike in the playtest report
      // and fire a hit burst sized to nothing — the ram announces itself
      // through onRam below, which is sized by COMMITMENT rather than by
      // damage precisely because there usually isn't any.
      if (dmg > 0) {
        hooks.onEnemyDamaged?.(e, dmg, strikeContact.x, strikeContact.y,
          strikeState.dashDir, null, strikeContact);
      }
      hooks.onRam?.(e, strikeState.power, strikeContact);
      if (chain) hooks.onChainHit?.(chain);

      // AND THE MARK. Anything big enough to shrug the shove off is painted
      // for the homing weapons instead — see systems/marks.js for why that is
      // the ram's real payload. markTarget answers "was this one worth
      // painting" itself and returns false for a minnow, so the size rule
      // lives in one place rather than being spelled out at every call site.
      if (markTarget(e)) hooks.onMarked?.(e);

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

  orbTimer -= dt;
  let spawnOrb = false;
  if (orbTimer <= 0) {
    orbTimer = randomBetween(CONFIG.strike.orbSpawnMin, CONFIG.strike.orbSpawnMax);
    spawnOrb = true;
  }

  return { spawnOrb };
}
