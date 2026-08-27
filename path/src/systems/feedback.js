import { CONFIG } from '../config.js';
import { emit } from '../entities/particles.js';
import { playSfx, vibrate, noteSfx, sfxBand } from './audio.js';
import { playHaptic } from './haptics.js';
import { taptic } from './taptic.js';

// Every juicy thing in the game goes through here. One call site per event, and
// what that event does — particles, shake, hit-stop, grid ripple, sound, buzz —
// is entirely described by CONFIG.feedback, so tuning feel never means hunting
// through gameplay code.

export const feedbackState = {
  shake: 0,
  // A separate, NON-decaying shake channel for things that tremble for as long
  // as they last rather than jolting once — currently the strike wind-up. It
  // has to be its own channel: the impulse `shake` above decays every frame by
  // design, so a continuous effect written into it would either fade out while
  // still happening or, if topped up per frame, race the decay and land
  // somewhere framerate-dependent. Whoever is sustaining it re-asserts it each
  // frame and updateFeedback clears it, so it is exactly as loud as the
  // loudest live claim and vanishes the moment nothing is claiming it.
  sustainShake: 0,
  hitstop: 0,
  glowPulse: 0,
};

/**
 * Claim the sustained shake channel for THIS frame. Highest claim wins; call
 * it every frame for as long as the effect lasts.
 */
export function addSustainedShake(amount) {
  if (!(amount > 0)) return;
  feedbackState.sustainShake = Math.min(CONFIG.fx.maxShake, Math.max(feedbackState.sustainShake, amount));
}

let grid = null;
let hitstopCooldown = 0;

// WHERE A `toast` CHANNEL GOES. Injected rather than imported, for the same
// reason `grid` is: this module is reached by half a dozen Node harnesses that
// have no DOM, and ui/ui.js builds its markup at import time. Nothing is wired
// on a harness, so the channel is simply inert there — which is what you want
// from a channel that only exists to put words on a screen.
let toastSink = null;

/** @param {(t: {key,label,value,x,y,minGap}) => void} fn */
export function setToastSink(fn) {
  toastSink = fn;
}

// event name -> seconds left before that event's SOUND may play again.
//
// An event's `sfxMinGap` throttles its sound and nothing else — the particles,
// shake, glow and ripple still fire on every single call. That split is the
// whole point: twelve pellets landing across a school should still throw
// twelve bursts of sparks, because sparks in twelve places read as twelve
// hits. Twelve copies of one impact sound inside the same frame don't read as
// anything; they just sum into a loud smear, and the sound gets thicker every
// time you take Multishot. Same reasoning as hitstopCooldown below — a rate
// limit on the one channel that can't take the pile-up.
const sfxGaps = new Map();

export function initFeedback(gridSystem) {
  grid = gridSystem;
  feedbackState.shake = 0;
  feedbackState.sustainShake = 0;
  feedbackState.hitstop = 0;
  feedbackState.glowPulse = 0;
  hitstopCooldown = 0;
  sfxGaps.clear();
}

/**
 * @param {string} event key in CONFIG.feedback
 * @param {object} at    { x, y, dirX, dirY, vx, vy, scale, color, toastValue }
 *                       `toastValue` is the number a `toast` channel prints
 *                       beside its label — what this proc was worth, which is
 *                       the one part of the line the table cannot author.
 *                       `color` is for DEATHS only — a kill burst is always the
 *                       dying creature's own emissive, never a generic palette.
 *                       Every other burst leaves it off and takes the emitter's
 *                       colour. See CONFIG.emitters for why that split exists.
 */
/**
 * A BOSS TAKING A HIT, OR GOING, IN THREE LAYERS.
 *
 * A boss used to sound exactly like a minnow: `hit` going in, `bigKill` going
 * out, whether it was a shark, a crab or forty tonnes of steel. What fires now
 * is up to three events for the one blow, and they answer three questions that
 * genuinely are separate:
 *
 *   1. THE MOMENT — `bossHit` / `bossDeath`. Every boss, always. The one place
 *      a change that should apply to all of them can land, and the only layer
 *      that carries anything but sound.
 *   2. THE MATERIAL — `bossHit<Class>`, from CONFIG.boss.voiceClass. Flesh,
 *      shell or steel: what the body answering the hit is made of.
 *   3. THE CRY — `bossHit<Type>`, from CONFIG.boss.voiceType. What THIS animal
 *      says about it, over the top of its own body's answer. Sparse on purpose:
 *      a boss with no row is silent here, and no fallback, because a new
 *      archetype crying in some other creature's voice is worse than one that
 *      does not cry at all.
 *
 * ORDER IS THE MIX. The moment first, the material next and the cry last, so
 * when the voice cap has to take something (see worstVoiceIndex in audio.js)
 * the layer it takes is the accent rather than the answer.
 *
 * Both voice layers are fired ALONGSIDE the event that already owns the moment
 * rather than instead of it: the events they name carry a sound and nothing
 * else, so the shake, the burst and the hit-stop stay authored in one place.
 * Routing through feedback() rather than playSfx is what gets them the same
 * distance banding, throttle and mixer ranking as every other sound.
 *
 * @param kind 'hit' or 'die'
 * @param key  the asset the thing is wearing — `e.assetKey`, or the hull's own
 * @param at   the usual { x, y, scale } feedback payload
 * @param opts `general: false` for a hull that is not a boss. Every ordinary
 *             trawler and rowboat comes through here for its material voice
 *             (see damageBoat), and those are not boss fights — but the default
 *             is true, so a boss added tomorrow gets the shared layer without
 *             anyone remembering to ask for it.
 */
export function bossVoice(kind, key, at = {}, opts = {}) {
  const b = CONFIG.boss ?? {};
  // Built into variables rather than inline. The event audit in
  // tools/upgrade-test.mjs reads the string literals inside every
  // `feedback(...)` call to catch a typo'd event name — which is worth far more
  // than it costs here — and a ternary spelling the name inside those brackets
  // reads to it as three events called 'Hit', 'Die' and 'die'.
  const die = kind === 'die';
  const verb = die ? 'Die' : 'Hit';

  // 1. THE MOMENT. Named in full rather than built, so both spellings appear as
  // literals somewhere in the source — the same audit reports an event whose
  // name is nowhere as one nothing can fire.
  if (opts.general !== false) feedback(die ? 'bossDeath' : 'bossHit', at);

  // 2. THE MATERIAL.
  const cls = b.voiceClass?.[key] ?? b.voiceDefault ?? 'flesh';
  const event = `boss${verb}${cls[0].toUpperCase()}${cls.slice(1)}`;
  // An unknown class would be a silently missing sound — playSfx returns for a
  // name it does not have — so it falls back rather than going quiet.
  const fallback = `boss${verb}Flesh`;
  feedback(CONFIG.feedback[event] ? event : fallback, at);

  // 3. THE CRY. No row, no sound, and no fallback — see the note on voiceType.
  const type = b.voiceType?.[key];
  if (!type) return;
  const cry = `boss${verb}${type}`;
  // A row naming a type with no event behind it is the one failure this layer
  // can have, and it is silent: the cry simply never plays. Said out loud here
  // rather than left to be noticed months later in a fight.
  if (!CONFIG.feedback[cry]) {
    console.warn(`[bossVoice] ${key} is voiceType "${type}" but there is no ${cry} event`);
    return;
  }
  feedback(cry, at);
}

// Anyone who wants to know that an event fired, without being wired into the
// forty-odd systems that fire them.
//
// The hex hive is the first caller: a tile has to flash on the frame its
// ability goes off, and every ability already announces itself here — the
// alternative was a pulse call added to each system, which is the same
// information gathered forty times and forty chances to forget one.
//
// OBSERVERS ONLY. A listener that throws must not take the burst, the shake and
// the sound down with it, so each is called in its own try — a HUD bug should
// cost you a tile animation, not the feel of the hit.
const listeners = new Set();

export function onFeedback(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function feedback(event, at = {}) {
  const def = CONFIG.feedback[event];
  if (!def) {
    console.warn(`[feedback] unknown event "${event}"`);
    return;
  }

  // Before the effects rather than after: an observer that wants to be in step
  // with the hit should not be waiting on a particle burst to finish being set
  // up first, and nothing below this depends on it having run.
  for (const fn of listeners) {
    try { fn(event, at); } catch (err) { console.warn('[feedback] listener failed', err); }
  }

  const scale = at.scale ?? 1;
  const x = at.x ?? 0;
  const y = at.y ?? 0;

  if (def.emit) emit(def.emit, x, y, at);
  // A second burst, of the substance the event leaves behind — `emit` is the
  // spray, `goo` is the body of liquid under it. It rides on the same `at`,
  // including the death tint, which is the point on a kill: the mass left in
  // the water is the creature's own colour.
  //
  // NOTE the name is doing different work here than on an emitter: an EVENT's
  // `goo` names an emitter to fire, an EMITTER's `goo` names which surface in
  // CONFIG.fx.goo.groups its particles are thresholded against.
  if (def.goo) emit(def.goo, x, y, at);

  if (def.ripple && grid) {
    grid.ripple(x, y, def.ripple.strength * scale, def.ripple.radius);
  }

  if (def.shake) {
    // Clamped, or a busy fight pins the camera at maximum rattle forever.
    feedbackState.shake = Math.min(CONFIG.fx.maxShake, feedbackState.shake + def.shake * scale);
  }

  if (def.glow) {
    // Same clamp reasoning as shake — otherwise a busy fight pins the glow
    // at maximum and it stops reading as "pulsing" at all.
    feedbackState.glowPulse = Math.min(3, feedbackState.glowPulse + def.glow * scale);
  }

  // Hit-stop only lands if it has had time to breathe. Without this every
  // bullet impact chains one, and the game runs in permanent slow motion.
  //
  // Gated here rather than in updateFeedback so that switching hit-stop off
  // leaves no state behind: nothing is started, the cooldown is never armed,
  // and the scale below is read only by a stop that was allowed to begin. A
  // stop already running when the switch flips finishes — it is 90ms at the
  // very worst, and cutting it mid-freeze is itself a hitch.
  if (def.hitstop && CONFIG.fx.hitstopEnabled && hitstopCooldown <= 0) {
    feedbackState.hitstop = Math.max(feedbackState.hitstop, def.hitstop);
    hitstopCooldown = CONFIG.fx.hitstopCooldown;
  }
  // opts.sfxOpts lets a caller shape the sound for this specific instance
  // (e.g. kills pitch down and ring longer for bigger enemies) without
  // needing a separate sound entry per creature.
  //
  // `sfxMinGap` collapses a burst of the same event into one sound. The first
  // call through plays immediately — the throttle never delays a hit, it only
  // drops the copies piling up behind it — and the loudest scale seen during
  // the window wins, so the one sound that does play is the one the biggest
  // hit in the burst would have made.
  if (def.sfx) {
    const gap = def.sfxMinGap ?? 0;
    // Where this one happened, so the mixer can rank it against everything else
    // sounding — and so the throttle below can tell a hit on top of the player
    // from one across the arena. An event with no position at all (UI, level-up)
    // is left exactly as it was: `sfxBand` calls that the top band, and there is
    // nothing for playSfx to read.
    const positioned = at.x !== undefined || at.y !== undefined;
    const sfxOpts = positioned ? { ...at.sfxOpts, x, y } : at.sfxOpts;
    const band = sfxBand(positioned ? x : null, positioned ? y : null);
    if (gap > 0) {
      const pending = sfxGaps.get(event);
      // The throttle keeps ONE sound per window, and this is what decides which
      // one. First-come-wins is the obvious rule and it is the wrong one: with
      // twelve pellets landing across the arena on the same frame, the hit you
      // hear was whichever happened to be resolved first, so a point-blank
      // impact spent the whole window silent behind a crab at the far wall.
      //
      // So a call from a nearer band breaks the window open and re-arms it at
      // its own distance. Since it can only ever be broken by something CLOSER,
      // a window can be re-opened at most (bands - 1) times however many events
      // pile into it — the rate stays bounded, and what survives is the closest
      // hit rather than the first.
      if (pending && band <= pending.band) {
        pending.scale = Math.max(pending.scale, scale);
        // Swallowed by the throttle. Reported rather than dropped in silence,
        // because "I can only hear one of these" and "only one of these is
        // firing" are different bugs with the same symptom, and this is the
        // only place they can be told apart.
        noteSfx(def.sfx, 'gap', { text: event });
      } else {
        // Jittered rather than exact. A fixed gap turns a sustained burst into
        // a perfectly periodic click train, and a periodic train of identical
        // clicks is heard as a PITCH — which is exactly the "static" a hit
        // sound develops when it fires twenty times a second. Breaking the
        // phase lock costs nothing and turns the same density back into
        // texture. See CONFIG.audio.sfxGapJitter.
        const jitter = CONFIG.audio?.sfxGapJitter ?? 0;
        const wobble = jitter ? 1 + (Math.random() * 2 - 1) * Math.min(0.9, jitter) : 1;
        sfxGaps.set(event, { left: gap * wobble, scale, band });
        playSfx(def.sfx, Math.min(1.6, scale), sfxOpts);
      }
    } else {
      playSfx(def.sfx, Math.min(1.6, scale), sfxOpts);
    }
  }
  // A LINE OF TEXT NAMING WHAT JUST FIRED. The channel for the upgrades that
  // pay out invisibly: a passive whose whole effect is a number moving inside
  // the stat block has nothing on screen to say it worked, and a card that
  // pays out invisibly is a card players report as broken.
  //
  // THE LABEL IS THE CARD'S OWN NAME, LOOKED UP. `toast` holds an UPGRADE ID,
  // and what the player reads is whatever upgrades.csv currently calls that
  // upgrade — so renaming a card renames the line that announces it, with no
  // second copy of the name anywhere to go stale. Same rule as an upgrade
  // description measuring itself instead of quoting a number that was true
  // once. A `toast` that matches no upgrade id is printed as written, which is
  // what a proc that is not an upgrade would want.
  //
  // The VALUE is per call — `toastValue` on the payload — because it is what
  // the proc was actually worth this time, and only the call site knows that.
  //
  // `toastMinGap` is NOT the sound's throttle in another suit. A repeat never
  // drops: the live line is updated in place with the new value, always, so
  // the number on screen is never stale. What the gap limits is the RE-POP —
  // whether the line replays its arrival — because a proc firing every frame
  // would otherwise restart its own animation forever and never be readable.
  //
  // WHICH CARD, when only the call site knows. `toast` on the def holds ONE
  // fixed upgrade id, which is exactly right for a passive that always
  // announces itself and exactly wrong for the level blob — that pickup adds a
  // stack to a RANDOM held upgrade, so its line has to name whichever one it
  // actually levelled. `toastUpgrade` on the payload is that override, and it
  // resolves through the same lookup, so the line still reads whatever
  // upgrades.csv currently calls the card.
  if (def.toast && toastSink) {
    const id = at.toastUpgrade ?? def.toast;
    const card = CONFIG.upgrades?.find((u) => u.id === id);
    toastSink({
      // Keyed on the CARD as well as the event whenever the call site chose it.
      // ui/ui.js keeps one line per key and only ever updates its VALUE on a
      // repeat, so two different upgrades sharing one key would put the second
      // one's level under the first one's name.
      key: at.toastUpgrade ? `${event}:${id}` : event,
      label: card?.name ?? id,
      value: at.toastValue ?? null,
      x,
      y,
      minGap: def.toastMinGap ?? 0,
      // TWO THINGS THE LINE DOES RATHER THAN TWO THINGS IT SAYS, which is why
      // they are booleans on the def and not part of the payload: whether a
      // receipt follows the seal and whether it ripples are facts about the
      // EVENT, the same for every firing of it, while `value` and
      // `toastUpgrade` above are what this particular one was worth. See
      // spawnProcToast in ui/ui.js for both.
      pin: !!def.toastPin,
      wave: !!def.toastWave,
    });
  }
  if (def.haptic) {
    // Controller rumble, phone buzz and the Taptic Engine are three pieces of
    // hardware reached through three unrelated APIs — send the same authored
    // pattern to all of them, and whichever the player actually has responds.
    // Only one ever can: a pad has no Vibration API, WebKit has no Vibration
    // API, and Capacitor's bridge only exists inside the native shell.
    playHaptic(def.haptic, Math.min(1.6, scale));
    vibrate(def.haptic);
    taptic(def.haptic, Math.min(1.6, scale));
  }
}

/**
 * Advances shake and hit-stop on real (unscaled) time.
 * Returns the time scale gameplay should run at this frame.
 */
export function updateFeedback(realDt) {
  if (hitstopCooldown > 0) hitstopCooldown -= realDt;

  // Run down the per-event sound throttles. Deleting the entry is what re-arms
  // the event, so an idle one costs nothing until it next fires.
  for (const [event, gap] of sfxGaps) {
    gap.left -= realDt;
    if (gap.left <= 0) sfxGaps.delete(event);
  }
  feedbackState.shake *= Math.pow(CONFIG.fx.shakeDecay, realDt);
  if (feedbackState.shake < 0.001) feedbackState.shake = 0;

  // Cleared rather than decayed — see the note on the field. Anything still
  // trembling re-asserts it before the camera reads it next frame.
  feedbackState.sustainShake = 0;

  feedbackState.glowPulse *= Math.exp(-CONFIG.bloom.pulseDecay * realDt);
  if (feedbackState.glowPulse < 0.001) feedbackState.glowPulse = 0;

  if (feedbackState.hitstop > 0) {
    feedbackState.hitstop = Math.max(0, feedbackState.hitstop - realDt);
    return CONFIG.fx.hitstopScale;
  }
  return 1;
}
