import { CONFIG } from '../config.js';
import { setSetting, settings, sfxScale } from './settings.js';
import { depthFraction } from '../arena.js';
import { isTypingTarget } from '../ui/typing.js';
import { fetchAudioBytes } from './fetchAudio.js';

// Sound is synthesised from the specs in CONFIG.sfx, so the game ships with no
// audio files at all. Point an entry at real files and those are used instead;
// if they fail to load we fall back to the synth, the same way a missing model
// falls back to a shape.
//
//   srcs: ['/sfx/a.mp3', '/sfx/b.mp3', …]   variations, one picked per play
//   src:  '/sfx/a.mp3'                      shorthand for a one-entry `srcs`
//
// Variations matter most for the sounds that fire constantly — the basic shot
// goes off several times a second, and one sample repeated at that rate turns
// into a machine-gun rattle. Cycling a handful of takes is what keeps it
// sounding like an instrument rather than a loop.

let ctx = null;
let master = null;
let unlocked = false;

// --- voices -----------------------------------------------------------------
// Every one-shot currently sounding, so the concurrency cap has something real
// to reason about. This used to be a bare counter incremented on play and
// decremented by a setTimeout, and both halves of that were wrong:
//
//   WHAT IT COUNTED   the timer was set from `def.decay`, which is the SYNTH
//                     fallback's envelope. Nineteen of the bank's entries play
//                     a FILE, and for those the number is fiction in both
//                     directions — `kill` held a slot for 1.21s to play a 0.58s
//                     sample (so the cap saw two voices for every one that was
//                     audible), while `playerDeath` released its slot after 1s
//                     with 8.4s of sample still ringing. The budget was spent
//                     on silence at one end and blind at the other.
//   WHAT IT DID       past the cap, playSfx returned. The NEWEST sound lost,
//                     which is backwards: the new hit is the one carrying
//                     information, and the spent tail it lost to is the one
//                     nobody would miss.
//
// So: real lengths, and the cap steals instead of refusing. `endsAt` is on the
// audio clock (ctx.currentTime), not wall time — it is the same clock the
// sounds themselves are scheduled on, and it does not drift when the tab does.
//
// Retirement is a sweep at the top of playSfx rather than a timer per voice.
// The cap is only ever read there, so a lazy sweep is exactly as accurate as a
// timer would be, and it costs one pass over a list bounded by maxConcurrent
// instead of sixty setTimeouts a second.
const voices = [];

// --- the listener -----------------------------------------------------------
// Where the ear is, in world units. The seal, not the camera — the camera lags
// behind it, and the same reasoning applies here as to the mussel's pan (see
// systems/projectileVoices.js).
//
// This exists so the voice budget can be spent on the fight IN FRONT OF YOU.
// Everything above ranks voices by time alone, which is blind to the one thing
// that actually decides whether a sound matters: a crab dying at the far wall
// and a crab dying on top of you are the same event, the same sound and the
// same length, and only one of them is worth a slot.
let listenerX = 0;
let listenerY = 0;

export function setSfxListener(x, y) {
  if (Number.isFinite(x)) listenerX = x;
  if (Number.isFinite(y)) listenerY = y;
}

// A sound's rank in the budget, as a whole band: 0 is the far edge of the arena
// (first to be cut) and `bands - 1` is on top of the player (never cut).
//
// BANDS rather than a raw distance, and that is the whole design. Ranking on
// distance alone would throw away the rule below it — a voice with two
// milliseconds left is nearly free to cut whatever else is true of it — because
// no two distances are ever equal, so distance would decide every comparison on
// its own. Quantising means "about as close" is a real state, and inside it the
// old least-left-to-play rule still runs.
//
// A sound with NO position is not a place in the world at all — a UI click, a
// level-up, the death — and takes the top band. So this mechanism can only ever
// take from the world, never from the interface.
export function sfxBand(x, y) {
  const p = CONFIG.audio.priority ?? {};
  const bands = Math.max(1, Math.round(p.bands ?? 4));
  const top = bands - 1;
  if (p.enabled === false || x == null || y == null) return top;
  const near = Math.max(0, p.nearRadius ?? 18);
  const far = Math.max(near + 0.001, p.farRadius ?? 70);
  const d = Math.hypot(x - listenerX, y - listenerY);
  const t = 1 - Math.min(1, Math.max(0, (d - near) / (far - near)));
  return Math.round(t * top);
}

// Seconds to fade a stolen voice out over. A hard stop mid-waveform is a click
// — an instantaneous edge is broadband — and a click is far more noticeable
// than the sound it was meant to make room for. 30ms is under the ear's
// resolution for "cut short" but long enough to reach zero smoothly.
const STEAL_FADE = 0.03;

// The synth path schedules its nodes to stop at `decay + 0.05` (see below), so
// that — not `decay` — is when a synthesised voice is genuinely done.
const SYNTH_TAIL = 0.05;
// name -> AudioBuffer[]  (one entry per successfully decoded variation)
const buffers = new Map();
// name -> index last played, so a random pick never repeats back-to-back.
const lastPick = new Map();

// The Sound tab builds its rows at boot, BEFORE preloadSamples has finished
// fetching — so a row's "synth / N samples" label is provisional and has to
// be refreshed once loading lands, or a sound with samples reads as synth
// forever and uploads look like they didn't stick.
const sampleListeners = new Set();
export function onSamplesChanged(cb) {
  sampleListeners.add(cb);
  return () => sampleListeners.delete(cb);
}
function notifySamplesChanged() {
  for (const cb of sampleListeners) cb();
}
// Mute lives in the player's settings rather than in a module flag here, so
// the M key and the pause menu's toggle are the same switch and can never
// disagree about which way it is thrown. It also survives a reload now, which
// a local `let` never did — muting and then refreshing used to come back loud.

// A global playback-rate multiplier on every one-shot, used by the death dive
// to slow the sound down with the picture (see systems/deathDive.js). Applied
// as pitch, which for a sampled sound IS the tape speed; the synth path gets
// the same treatment split across its two halves — frequencies scale with the
// rate and envelopes stretch by its inverse, so a slowed blip drops AND
// lengthens rather than just going flat.
//
// New sounds only. A one-shot already in flight keeps the rate it started at,
// which is what you want here: the sounds that were mid-air when the seal died
// are its last frame of normal time, and the dilation should arrive with what
// comes after them.
let rateScale = 1;

export function setSfxRateScale(scale) {
  rateScale = Math.max(0.05, Math.min(4, scale || 1));
}

// --- master SFX bus ---------------------------------------------------------
// Everything synthesised or sampled lands on `master`, which then runs through
// a shared filter, a reverb send and a dynamics stage before the speakers:
//
//   master -> busFilter ->  dryGain ---> sum -> [comp] -> makeup -> ceiling -> out
//                       \-> convolver -> wetGain -/
//
// The reverb is parallel (send/return) rather than in series, so the wet signal
// is mixed ALONGSIDE the dry one — a purely serial reverb would swallow the
// transient that makes a blip read as a hit. Music has its own chain and
// deliberately does not pass through here; this is the SFX bus only.
//
// THE DYNAMICS STAGE exists because the per-sound gains have to be free to go
// loud. Samples arrive at wildly different levels (there is a 20dB spread
// across the bank as authored), so getting the quiet ones audible means driving
// them hard — and a dozen one-shots landing on the same frame then sums well
// past full scale and clips, which is a click, not a loud sound.
//
//   comp     light glue, and the thing that makes a busy frame sit DOWN so the
//            next sound still has somewhere to go.
//   makeup   what the compressor took off, put back. This is the control that
//            actually makes the mix louder; the compressor on its own only
//            makes it smaller.
//   ceiling  a soft-clip curve, and the reason the makeup is safe. Zero
//            latency — it is a waveshaper, not a lookahead limiter — so it can
//            sit on a game bus where 6ms of delay per stage would be felt.
let busFilter = null;
let convolver = null;
let dryGain = null;
let wetGain = null;
let sumGain = null;
let compressor = null;
let makeupGain = null;
let ceilingShaper = null;
let irSignature = ''; // regenerate the impulse only when its shape changes

// --- the celebration echo ---------------------------------------------------
// A feedback delay hanging off the bus, silent for the whole run and opened up
// for the second the seal is performing. See setSfxEcho.
let echoDelay = null;
let echoTone = null;
let echoFeedback = null;
let echoWet = null;
let echoOpen = false;
let ceilingSignature = ''; // same, for the soft-clip curve
let compRouted = null; // whether the compressor is currently IN the chain

// A synthetic impulse response: noise decaying exponentially. This is the
// standard way to get a plausible reverb tail without shipping an IR file —
// the game has no audio assets by default and this keeps it that way.
function buildImpulse(seconds, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * Math.max(0.05, seconds)));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      // Higher `decay` = faster fall-off = smaller, tighter room.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, Math.max(0.1, decay));
    }
  }
  return buf;
}

/**
 * The same synthetic room, for anything that needs a tail of its own rather
 * than a share of the bus send. The music's boss-kill hush is the one caller:
 * it hangs its own convolver off the music chain (which never touches this
 * bus — see systems/music.js) and would otherwise ship a second copy of the
 * loop above, free to drift away from this one.
 *
 * Null before the context exists, which is every call made before the first
 * user gesture unlocks audio.
 */
export function makeImpulse(seconds, decay) {
  if (!ctx) return null;
  return buildImpulse(seconds, decay);
}

// A soft-clip transfer curve, in two pieces:
//
//   |x| <= knee     y = x                                    (untouched)
//   |x| >  knee     y = knee + (c - knee) * tanh((|x| - knee) / (c - knee))
//
// Piecewise rather than a plain `c * tanh(x / c)`, which is the obvious version
// and is wrong here. That curve starts bending immediately — at half scale it
// is already most of a dB down — so it does not limit the mix so much as
// quietly recompress all of it, and moving the ceiling would change the level
// of every sound in the game rather than just the peaks.
//
// This one is bit-exact below the knee and only then bends, meeting the knee
// with matching value AND slope (tanh has slope 1 at zero), so there is no
// corner where it takes over. It approaches `c` and never reaches it.
//
// A WaveShaper's curve is defined over an input of -1..1 and the spec CLAMPS
// anything beyond that to the end entries, which is what makes this a real
// ceiling rather than a suggestion: however hard the bus is driven, the output
// cannot exceed the last value in this table.
function buildCeilingCurve(ceiling, kneeFraction) {
  const n = 2048;
  const c = Math.max(0.05, Math.min(1, ceiling));
  // Kept strictly below the ceiling, or the curved half has no room to exist
  // and the transfer becomes a hard clip at the knee.
  const knee = Math.max(0, Math.min(0.98, kneeFraction ?? 0.6)) * c;
  const span = Math.max(1e-4, c - knee);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + span * Math.tanh((a - knee) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function buildBus() {
  busFilter = ctx.createBiquadFilter();
  convolver = ctx.createConvolver();
  dryGain = ctx.createGain();
  wetGain = ctx.createGain();
  sumGain = ctx.createGain();
  compressor = ctx.createDynamicsCompressor();
  makeupGain = ctx.createGain();
  ceilingShaper = ctx.createWaveShaper();

  master.connect(busFilter);
  // Both halves of the reverb send meet at `sum` rather than at the speakers,
  // because the dynamics stage below has to see the WHOLE bus. A compressor fed
  // only the dry path would duck the transient while the tail carried on at
  // full level, which is audible as the reverb swelling every time something
  // loud happens.
  busFilter.connect(dryGain).connect(sumGain);
  busFilter.connect(convolver);
  convolver.connect(wetGain).connect(sumGain);

  // --- the echo send --------------------------------------------------------
  // Parallel to the reverb and landing on `sum` for the same reason: the
  // dynamics stage has to see it, or the repeats swell past the compressor
  // every time the dry hit ducks.
  //
  // WHAT RAMPS IS THE OUTPUT, not the input. Gating the send instead would
  // mean the delay line is empty at the moment the celebration starts, so the
  // echo has nothing to say until the NEXT sound — and the sound worth
  // echoing is the killing blow, which has already happened. Feeding the line
  // always and opening the output means the fade-in carries the kill itself,
  // and the fade-out mutes the tail instead of leaving it ringing into
  // gameplay.
  echoDelay = ctx.createDelay(2);
  echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoFeedback = ctx.createGain();
  echoWet = ctx.createGain();
  echoWet.gain.value = 0;
  echoOpen = false;

  busFilter.connect(echoDelay);
  // Damping inside the loop, so each repeat is darker than the one before it.
  // A bright feedback delay on a bus that already has reverb turns into noise
  // by the third repeat.
  echoDelay.connect(echoTone).connect(echoFeedback).connect(echoDelay);
  echoDelay.connect(echoWet).connect(sumGain);

  applyAudioBusSettings();
}

/**
 * Open or close the celebration echo.
 *
 * Called from systems/celebrate.js on the two frames that matter — the start
 * of a performance and its teardown — rather than polled, because
 * `celebrationState.active` is equally true on every frame of one and a ramp
 * restarted per frame never arrives anywhere.
 *
 * The ramp is linear from wherever the gain currently IS, which is what makes
 * a celebration interrupted by another one (or by the run ending) pick up from
 * the level it reached instead of jumping.
 */
export function setSfxEcho(on) {
  if (!ctx || !echoWet) return;
  const e = CONFIG.audio.bus?.echo ?? {};
  const want = on && e.enabled !== false;
  if (want === echoOpen) return;
  echoOpen = want;
  const wet = want ? Math.max(0, e.wet ?? 0.5) : 0;
  const seconds = Math.max(0.01, (want ? e.fadeIn : e.fadeOut) ?? 0.4);
  const now = ctx.currentTime;
  echoWet.gain.cancelScheduledValues(now);
  // Pinned to the value it holds right now before the ramp is scheduled.
  // Without this the ramp starts from whatever the last SCHEDULED value was,
  // which on an interrupted fade is the target it never reached — and the
  // gain jumps there before ramping back.
  echoWet.gain.setValueAtTime(echoWet.gain.value, now);
  echoWet.gain.linearRampToValueAtTime(wet, now + seconds);
}

// Whether the echo is currently open. For the Sound tab and the tests — a send
// that is fading has no other observable state.
export function sfxEchoOpen() {
  return echoOpen;
}

// The bus nodes, for tools/echo-test.mjs. Exposed rather than reached through
// the module's internals because the thing worth asserting is the SHAPE of the
// graph — that the echo sums with the dry path ahead of the compressor — and
// a test that cannot see the nodes can only assert that a function was called.
export function __busNodes() {
  return { echoDelay, echoTone, echoFeedback, echoWet, sumGain, busFilter, dryGain, wetGain };
}

// (Re)wire the tail of the bus. Called whenever the compressor is switched on
// or off: it is unpatched rather than set to a transparent ratio, because a
// DynamicsCompressorNode adds a few milliseconds of lookahead delay whether or
// not it is doing anything, and "off" should mean off on a bus that fires on
// the same frame as the picture.
function routeBusTail(useComp) {
  if (compRouted === useComp) return;
  compRouted = useComp;
  try {
    sumGain.disconnect();
    compressor.disconnect();
    makeupGain.disconnect();
    ceilingShaper.disconnect();
  } catch { /* not connected yet */ }

  if (useComp) sumGain.connect(compressor).connect(makeupGain);
  else sumGain.connect(makeupGain);
  makeupGain.connect(ceilingShaper).connect(ctx.destination);
}

// How much the compressor is pulling down right now, in dB (negative, or 0
// when it is idle). The Sound tab shows it live: a compressor you cannot see
// working is a compressor nobody can tune.
export function busReduction() {
  if (!compressor || !compRouted) return 0;
  return compressor.reduction ?? 0;
}

// Push CONFIG.audio.bus onto the live nodes. Safe to call every time a slider
// moves — the impulse response is only rebuilt when its shape actually
// changed, since regenerating a couple of seconds of noise per frame while
// dragging would be silly.
export function applyAudioBusSettings() {
  if (!ctx || !busFilter) return;
  const b = CONFIG.audio.bus ?? {};

  busFilter.type = b.filterType ?? 'lowpass';
  busFilter.Q.value = Math.max(0.0001, b.filterQ ?? 1);
  // With depth tracking on, updateBusDepth owns the cutoff — stamping the
  // manual value back on here every time another bus slider moved would
  // fight it, and you'd hear the filter jump each time you touched reverb.
  if (!b.depth?.enabled) {
    busFilter.frequency.value = Math.max(20, b.filterHz ?? 20000);
  }

  const mix = Math.max(0, Math.min(1, b.reverbMix ?? 0));
  // Equal-power crossfade: a linear one dips in perceived loudness through
  // the middle of the range, which reads as a volume bug while you're just
  // trying to dial in reverb.
  dryGain.gain.value = Math.cos(mix * Math.PI * 0.5);
  wetGain.gain.value = Math.sin(mix * Math.PI * 0.5);

  const seconds = b.reverbSeconds ?? 1.6;
  const decay = b.reverbDecay ?? 2;
  const sig = `${seconds}|${decay}`;
  if (sig !== irSignature) {
    irSignature = sig;
    convolver.buffer = buildImpulse(seconds, decay);
  }

  // --- the echo -------------------------------------------------------------
  // Everything except the wet level, which is owned by setSfxEcho: stamping it
  // back on here would slam the send open the moment any other bus slider
  // moved, and the Sound tab moves them while a celebration is running.
  if (echoDelay) {
    const e = b.echo ?? {};
    echoDelay.delayTime.value = Math.max(0.001, Math.min(2, e.timeSeconds ?? 0.26));
    // Under 1, always: at 1 the loop never decays and the bus climbs until it
    // clips, which does not sound like a broken slider — it sounds like the
    // game got louder and stayed there.
    echoFeedback.gain.value = Math.max(0, Math.min(0.95, e.feedback ?? 0.4));
    echoTone.frequency.value = Math.max(200, e.toneHz ?? 2600);
    if (e.enabled === false && echoOpen) setSfxEcho(false);
  }

  // --- dynamics -------------------------------------------------------------
  const c = b.comp ?? {};
  routeBusTail(c.enabled !== false);

  compressor.threshold.value = Math.max(-100, Math.min(0, c.threshold ?? -18));
  compressor.knee.value = Math.max(0, Math.min(40, c.knee ?? 12));
  compressor.ratio.value = Math.max(1, Math.min(20, c.ratio ?? 3));
  compressor.attack.value = Math.max(0, Math.min(1, c.attack ?? 0.005));
  compressor.release.value = Math.max(0, Math.min(1, c.release ?? 0.18));
  makeupGain.gain.value = Math.max(0, c.makeup ?? 1.6);

  // Same reasoning as the impulse above: rebuilding two thousand tanh calls on
  // every frame of a slider drag would be silly, and the curve only depends on
  // the one number.
  const ceiling = Math.max(0.05, Math.min(1, c.ceiling ?? 0.95));
  const kneeFraction = c.ceilingKnee ?? 0.6;
  const csig = `${ceiling}|${kneeFraction}|${c.oversample ?? '2x'}`;
  if (csig !== ceilingSignature) {
    ceilingSignature = csig;
    ceilingShaper.curve = buildCeilingCurve(ceiling, kneeFraction);
    // The curve is a nonlinearity, so it generates harmonics — some of which
    // land above Nyquist and fold back down as aliasing. Oversampling is what
    // keeps a hard-driven bus sounding saturated rather than gritty.
    ceilingShaper.oversample = c.oversample ?? '2x';
  }

  if (master) master.gain.value = masterGain();
}

// The authored level times the player's own. Mute is folded in by sfxScale, so
// it reaches CONTINUOUS voices too — the mussel's flight voice and the strike
// wind-up ride this gain and used to keep sounding straight through a mute,
// because the old flag was only ever checked at the top of playSfx.
function masterGain() {
  return CONFIG.audio.masterVolume * sfxScale();
}

/**
 * Re-apply the player's audio settings to the live bus. Cheap enough to call
 * on every step of a volume slider — it is one gain write.
 *
 * Separate from applyAudioBusSettings, which rebuilds the impulse response and
 * the ceiling curve when its signatures change: dragging a volume slider has no
 * business going anywhere near either of those.
 */
export function applyPlayerAudioSettings() {
  if (master) master.gain.value = masterGain();
}

// Called every frame with the player's Y, mirroring the music filter — diving
// muffles the whole SFX bus the way it muffles the score. Deliberately its own
// surface/deep pair rather than reusing the music's: sound effects sit in a
// different part of the mix and want a much narrower range, or every hit turns
// to mud the moment you leave the surface.
export function updateBusDepth(y) {
  if (!ctx || !busFilter) return;
  const d = CONFIG.audio.bus?.depth;
  if (!d?.enabled) return;
  const t = depthFraction(y);
  // Log-space, same reasoning as the music filter: cutoff is perceived
  // logarithmically, so a linear ramp wastes most of its travel.
  const target = (d.surfaceHz ?? 20000) * Math.pow((d.deepHz ?? 3000) / (d.surfaceHz ?? 20000), t);
  // setTargetAtTime glides rather than steps, so re-issuing it per frame is
  // smooth; setValueAtTime every frame would zipper.
  busFilter.frequency.setTargetAtTime(
    Math.max(20, target),
    ctx.currentTime,
    Math.max(0.01, d.smoothing ?? 0.15),
  );
}

// Sweep the bus back to its un-muffled cutoff over `smoothing` seconds.
//
// updateBusDepth only runs during a live run, so whatever the last frame of one
// left the filter at is where it stays — and the death dive deliberately drags
// it all the way down as the body sinks. Coming back from that needs the sweep
// to be a sound in its own right rather than a jump on the frame the next run
// starts, and the run's own first updateBusDepth would set the target from the
// player's new position without doing anything about the distance to it.
export function openBusFilter(smoothing = 0.3) {
  if (!ctx || !busFilter) return;
  const b = CONFIG.audio.bus ?? {};
  // Whichever value owns the cutoff when nothing is diving: the surface end of
  // the depth track, or the manual setting when depth tracking is off.
  const open = b.depth?.enabled ? (b.depth.surfaceHz ?? 20000) : (b.filterHz ?? 20000);
  busFilter.frequency.setTargetAtTime(Math.max(20, open), ctx.currentTime, Math.max(0.01, smoothing));
}

// --- the debug tap ----------------------------------------------------------
// One watcher, not a listener set: this is called from inside playSfx, which
// fires several times a second in a quiet moment and dozens in a busy one. A
// null check costs nothing and allocates nothing, so with the overlay off the
// tap is invisible in a profile — which is the only way a debug hook belongs in
// a hot path.
//
// It reports OUTCOMES, not just names, because the interesting question when a
// sound is missing is never "did it fire" but "what happened to it": the
// throttle ate it, a newer sound stole its voice, it fell back to the synth
// because a file failed to decode, or the name is wrong and nothing was ever
// going to play. See ui/sfxDebug.js.
let sfxWatcher = null;

export function watchSfx(cb) {
  sfxWatcher = cb || null;
}

/**
 * @param name    the CONFIG.sfx key
 * @param outcome 'sample' | 'synth' | 'gap' | 'far' | 'stolen' | 'voices' | 'muted'
 *                | 'unknown' | 'missing' | 'off' | 'note'
 * @param detail  optional { take, takes, gain, text }
 */
export function noteSfx(name, outcome, detail) {
  if (sfxWatcher) sfxWatcher(name, outcome, detail);
}

// --- level conversion -------------------------------------------------------
// Gains are STORED linear (that is what an AudioParam wants) and EDITED in dB
// (that is what a level is). These are the only conversion between the two, so
// the tuner's sliders and anything else reading a level agree by construction.
//
// `DB_FLOOR` is silence rather than a very quiet level: the bottom of a level
// control has to be off, or a sound can never be switched out from the panel.
export const DB_FLOOR = -40;

export function gainToDb(gain) {
  if (!(gain > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(gain));
}

export function dbToGain(db) {
  if (db <= DB_FLOOR) return 0;
  return 10 ** (db / 20);
}

// Every file an entry wants, normalised to an array.
function sourcesFor(def) {
  if (Array.isArray(def.srcs) && def.srcs.length) return def.srcs.filter(Boolean);
  return def.src ? [def.src] : [];
}

// Shared so the music player can hang its own chain off the same context —
// browsers limit how many AudioContexts a page can create, and two would
// also mean two separate unlock gestures.
export function getAudioContext() {
  if (!ctx) initAudio();
  return ctx;
}

// The input to the SFX bus. playSfx builds a throwaway graph per shot and
// connects it here; sounds that are NOT one-shots need the same landing point.
// The mussel's flight voice is the first of those — it lives for as long as
// the shell does and has its pitch, filter and pan rewritten every frame, so
// it can't be expressed as a CONFIG.sfx entry at all. Handing out `master`
// rather than ctx.destination is what keeps it inside the shared filter and
// reverb send, so a mussel in flight ducks underwater with everything else
// instead of sitting oddly dry on top of the mix.
export function getSfxBus() {
  return master;
}

// True when there is a live, unlocked context to build nodes on. Deliberately
// does NOT fold in `muted` — a continuous voice reacts to the mute key by
// ducking its gain, not by tearing its graph down and rebuilding it on unmute.
export function isAudioLive() {
  return unlocked && !!ctx && CONFIG.audio.enabled;
}

export function initAudio() {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && !isTypingTarget(e.target)) {
      setSetting('audio.muted', !settings.audio.muted);
    }
  });
}

// Browsers require a user gesture before audio can start.
export function unlockAudio() {
  if (unlocked || !CONFIG.audio.enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = masterGain();
    buildBus();
    unlocked = true;
    preloadSamples();
    // A context built outside a real gesture comes up suspended and stays that
    // way — silent for the whole run, with nothing in the console to say why.
    // Now that a run can begin without a gesture (reduced motion skips the
    // splash, and so does a .riv that fails to load), catch that case and
    // resume on the player's first actual input instead.
    if (ctx.state === 'suspended') resumeOnFirstGesture();
  } catch (err) {
    console.warn('[audio] unavailable —', err?.message ?? err);
  }
}

function resumeOnFirstGesture() {
  const events = ['pointerdown', 'keydown', 'touchstart'];
  const resume = () => {
    for (const type of events) window.removeEventListener(type, resume);
    ctx?.resume().catch((err) => console.warn('[audio] resume failed —', err?.message ?? err));
  };
  for (const type of events) window.addEventListener(type, resume, { once: false });
}

// --- getting the bank into memory -------------------------------------------
// THE BUG THIS SHAPE EXISTS TO PREVENT: a sound that has samples playing its
// synth anyway, but only on the deployed build.
//
// Nothing here can be allowed to load the bank ENTRY BY ENTRY. This used to be
// a `for` loop with an `await` in its body, which meant an entry's fetch did
// not begin until every entry before it had fully landed — 25 sequential round
// trips before `strike`, the 24th sampled entry, so much as asked for its
// first file. Off local disk that is nothing and the bug is invisible; over a
// network it is a window at the top of every run in which the samples are not
// there yet and playSfx falls through to the synth. Measured against the
// deployed site on a fast wired connection, `strike` was not ready until 1.25s
// in, and `uiClick` — dead last — until 1.9s. On a phone it is several seconds.
//
// So the bank is fetched ALL AT ONCE (below), and it is fetched from boot
// rather than from the gesture that starts the run (see prefetchSamples).
//
// Both caches are keyed by SRC, not by sound name, because the same file is
// often several sounds: Seal_Boost_01.mp3 is a variation of both `airJump` and
// `strike`, Seal_56.mp3 of both `breach` and `seabedThud`. Keyed by name they
// would each be fetched and decoded once per sound that mentions them.
const rawBytes = new Map();   // src -> Promise<ArrayBuffer | null>
const decodedBySrc = new Map(); // src -> Promise<AudioBuffer | null>

// Enough to keep the pipe full without this competing with everything else the
// page is pulling down. The whole bank is under 2MB, so this is about being a
// good citizen during boot rather than about throughput.
const PREFETCH_WIDTH = 8;
let prefetching = null;

// Every file the bank references, deduplicated — see the note above about the
// same mp3 belonging to more than one sound.
function allSampleSources() {
  const srcs = new Set();
  for (const def of Object.values(CONFIG.sfx)) {
    for (const src of sourcesFor(def)) srcs.add(src);
  }
  return [...srcs];
}

// The bytes for one file, fetched at most once. Deliberately NOT decoding:
// decoding needs an AudioContext and an AudioContext needs a gesture, but
// downloading needs neither — which is the whole reason this can start at boot
// while the menu is still up.
function bytesFor(src) {
  let pending = rawBytes.get(src);
  if (!pending) {
    pending = (async () => {
      return await fetchAudioBytes(src);
    })().catch((err) => {
      console.warn(`[audio] could not fetch ${src} —`, err?.message ?? err);
      return null;
    });
    rawBytes.set(src, pending);
  }
  return pending;
}

/**
 * Start pulling the sample bank down. Safe to call before any gesture and
 * before there is an AudioContext at all, which is the point: called from
 * boot() once the loading screen is done, the bank downloads while the splash
 * and the menu are on screen, and by the time the player presses start the
 * bytes are already here and unlockAudio only has to decode them.
 *
 * Idempotent — later calls get the same promise rather than a second fetch.
 */
export function prefetchSamples() {
  if (prefetching) return prefetching;
  const queue = allSampleSources();
  const worker = async () => {
    while (queue.length) await bytesFor(queue.shift());
  };
  const width = Math.min(PREFETCH_WIDTH, queue.length);
  prefetching = Promise.all(Array.from({ length: width }, worker));
  return prefetching;
}

// One file, decoded at most once.
function decodeFor(src) {
  let pending = decodedBySrc.get(src);
  if (!pending) {
    pending = bytesFor(src).then(async (bytes) => {
      if (!bytes) return null;
      try {
        // SLICED, never handed over: decodeAudioData detaches the ArrayBuffer
        // it is given, and these bytes are shared between every sound that
        // names the file. Passing the cached copy would leave the second
        // sound to want it decoding a zero-length buffer — which throws, gets
        // caught, and comes out as a synth fallback with no obvious cause.
        return await ctx.decodeAudioData(bytes.slice(0));
      } catch (err) {
        console.warn(`[audio] could not decode ${src} —`, err?.message ?? err);
        return null;
      }
    });
    decodedBySrc.set(src, pending);
  }
  return pending;
}

export async function preloadSamples() {
  // Every entry at once. Each one still lands independently — its buffers go
  // into the map the moment its own files decode, so sounds become playable as
  // they arrive rather than all together at the end.
  await Promise.all(Object.entries(CONFIG.sfx).map(async ([name, def]) => {
    const sources = sourcesFor(def);
    if (!sources.length) return;
    const decoded = await Promise.all(sources.map(decodeFor));
    // A partly-failed set still plays: only the variations that decoded are
    // kept, and an entry that lost all of them falls back to the synth.
    const ok = decoded.filter(Boolean);
    if (ok.length) buffers.set(name, ok);
    // Two different failures, and they need different words. An entry that
    // still has a synth behind it will make A sound, just not the right one;
    // one that doesn't will make none at all, and that is worth shouting about
    // because on a deployed build it is the only warning there is.
    else if (def.type) {
      console.warn(`[audio] "${name}" has no usable samples — using the synth instead.`);
    } else {
      console.error(`[audio] "${name}" has no usable samples and no synth fallback — it will be SILENT. `
        + `Check that these files are deployed: ${sources.join(', ')}`);
    }
  }));
  notifySamplesChanged();
}

// Re-fetch one sound's variations from its current config. Used after a
// variation is removed in the Sound tab: rebuilding from `srcs` keeps the
// in-memory set exactly in step with the list you can see, which splicing the
// buffer array by index would not — a file that failed to decode makes the
// two orders drift apart.
export async function reloadSample(name) {
  const def = CONFIG.sfx[name];
  if (!def || !ctx) return;
  const sources = sourcesFor(def);
  // Dropped from both caches before anything is re-read. This is the path an
  // upload takes, and an upload WRITES public/sfx/<file> — the URL is the same
  // one already fetched but the file behind it is a different sound. Serving
  // this from cache would play the old one and look like the upload had not
  // stuck, which is the exact failure this function exists to prevent.
  for (const src of sources) {
    rawBytes.delete(src);
    decodedBySrc.delete(src);
  }
  if (!sources.length) {
    buffers.delete(name);
    lastPick.delete(name);
    notifySamplesChanged();
    return;
  }
  const decoded = await Promise.all(sources.map(decodeFor));
  const ok = decoded.filter(Boolean);
  if (ok.length) buffers.set(name, ok);
  else buffers.delete(name);
  lastPick.delete(name);
  notifySamplesChanged();
}

// --- trailing silence -------------------------------------------------------
// How long a buffer actually makes a sound for, which is NOT how long it runs.
//
// A voice slot is held for as long as its buffer plays, so a file exported with
// padding on the end spends that budget playing nothing. This bank is full of
// it: every Seal_*.mp3 carries exactly 1.03s of digital silence after the last
// sample, which is a batch-export artifact rather than anything anyone chose.
// On `shoot` — 1.14s of file for 0.12s of seal, fired six times a second and
// not throttled — that is around six voices permanently held for silence, out
// of a budget of 32. Across the sampled bank it is 36% of everything.
//
// Scanned BACKWARDS and stopped at the first sample with signal in it, so a
// file with no padding costs one comparison and a padded one costs only the
// padding. Measured once per buffer and cached.
//
// Nothing is copied or re-encoded — the assets are untouched. The buffer still
// plays exactly as authored; we simply stop the node and release the slot at
// the point where it stopped being audible.
const SILENCE_FLOOR = 10 ** (-60 / 20); // -60 dBFS is silence for this purpose
const audibleCache = new WeakMap();

function audibleSeconds(buffer) {
  const cached = audibleCache.get(buffer);
  if (cached !== undefined) return cached;
  // A buffer from a stub or a browser that hands back something exotic: fall
  // back to the full length rather than guessing at zero and eating the sound.
  if (typeof buffer.getChannelData !== 'function' || !(buffer.length > 0)) {
    return buffer.duration;
  }
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  let last = -1;
  for (let i = buffer.length - 1; i >= 0; i--) {
    let loud = false;
    for (const data of channels) {
      if (Math.abs(data[i]) > SILENCE_FLOOR) { loud = true; break; }
    }
    if (loud) { last = i; break; }
  }
  // A file with no signal anywhere is a broken asset, not a short one. Treat it
  // as full length so it behaves exactly as it did before rather than silently
  // becoming a zero-length voice that is impossible to notice.
  const seconds = last < 0
    ? buffer.duration
    // A few ms past the last sample, so the release never clips the final cycle
    // of a tail that decays smoothly into the floor.
    : Math.min(buffer.duration, (last + 1) / buffer.sampleRate + 0.01);
  audibleCache.set(buffer, seconds);
  return seconds;
}

// Pick a variation, never the same one twice running. With a single sample
// this is just that sample; with several it stops the ear locking onto a
// repeat, which is the whole reason for having variations.
function pickSample(name) {
  const set = buffers.get(name);
  if (!set || !set.length) return null;
  // Recorded even with a single variation, so `lastPick` is always the take
  // that is actually sounding and the debug overlay can name it without
  // guessing. Costs one Map write on a path that already does several.
  if (set.length === 1) { lastPick.set(name, 0); return set[0]; }
  const prev = lastPick.get(name);
  let i = (Math.random() * set.length) | 0;
  if (i === prev) i = (i + 1) % set.length;
  lastPick.set(name, i);
  return set[i];
}

function noiseBuffer(duration) {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envelope(gain, peak, decay, now) {
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
}

// --- repetition attenuation -------------------------------------------------
// The fix for a sound that turns to static when it repeats.
//
// The problem is not loudness, it is SUMMING. Twenty copies of one 0.25s
// transient inside a second do not read as twenty hits — they read as one
// continuous buzz, because each copy overlaps the tail of the last and their
// energies add. Turning the sound down fixes the buzz and loses the single
// hit; throttling harder loses the density that tells you how much you are
// connecting with.
//
// So instead: each rapid repeat of the SAME sound plays quieter than the one
// before, recovering as soon as the sound stops firing. The first hit after a
// pause is at full level and reads as a hit; a sustained wall of them settles
// at the floor and reads as a texture, which is what a wall of hits should be.
// This is the standard game-audio answer and it is why a shooter's hit marker
// can fire constantly without becoming noise.
//
// Keyed by SOUND rather than by event, because that is what sums: `kill` and
// `debrisBreak` are different events playing one sound, and it is the sound's
// copies that pile up.
const heat = new Map(); // name -> { h, at }

function repetitionGain(name, now) {
  const r = CONFIG.audio.repetition ?? {};
  if (r.enabled === false) return 1;
  const recovery = Math.max(0.01, r.recovery ?? 0.5);
  const strength = Math.max(0, r.strength ?? 0.35);
  const floorGain = Math.min(1, Math.max(0, r.floor ?? 0.25));

  const prev = heat.get(name);
  // Heat decays exponentially, so a sound fired once a second barely warms up
  // (at the default recovery it comes back ~87% cooled) and one fired twenty
  // times a second reaches a steady state near the floor. Nothing has to know
  // the rate; the time constant does that on its own.
  const h = prev ? prev.h * Math.exp(-(now - prev.at) / recovery) + 1 : 1;
  heat.set(name, { h, at: now });

  // The first hit of a burst is always untouched — h is 1 for a cold sound and
  // this returns exactly 1. Attenuation only ever applies to the copies behind
  // it, which is the whole point.
  if (h <= 1) return 1;
  return Math.max(floorGain, 1 / (1 + (h - 1) * strength));
}

// Cleared between runs so a busy death doesn't leave the next run's first
// shots ducked.
export function resetRepetition() {
  heat.clear();
}

// Drop every voice that has finished sounding. Called once at the top of
// playSfx, which is the only place the cap is read.
function retireFinishedVoices(now) {
  for (let i = voices.length - 1; i >= 0; i--) {
    if (voices[i].endsAt <= now) voices.splice(i, 1);
  }
}

// Which voice is worth the least, or -1 when there is nothing playing.
//
// Two rules, in order:
//
//   FURTHEST FIRST   the lowest band goes, because a sound happening across the
//                    arena is worth less than one happening on top of you
//                    whatever else is true of it. See sfxBand.
//   THEN LEAST LEFT  inside a band, the voice with the least still to play.
//                    Oldest-first is the usual rule and it is the wrong one
//                    here, because this bank mixes 50ms blips with a 9-second
//                    death: the oldest voice is routinely the one with the most
//                    tail still to come, so stealing it punches an audible hole
//                    in the mix to save a sound that was nearly over anyway.
//                    Taking the closest to finishing is the strictly smallest
//                    loss available — often the last few milliseconds of
//                    something, inaudible under the sound that replaces it.
//
// With priority off, or with nothing positioned, every band is the same and
// this is exactly the least-left-to-play rule it was before.
function worstVoiceIndex() {
  if (!voices.length) return -1;
  let pick = 0;
  for (let i = 1; i < voices.length; i++) {
    const v = voices[i];
    const best = voices[pick];
    if (v.band < best.band || (v.band === best.band && v.endsAt < best.endsAt)) pick = i;
  }
  return pick;
}

// Fade a voice out and stop its sources. Wrapped because both halves throw on
// a node that has already finished on its own, and a voice that ended between
// the sweep and here is a race we would rather ignore than crash on.
function releaseVoice(v, now) {
  for (const gain of v.gains) {
    try {
      const p = gain.gain;
      // cancelAndHoldAtTime freezes the param at its CURRENT value mid-ramp,
      // which is what we want: an envelope already on its way down should fade
      // from where it actually is, not jump back to its peak. Not everywhere
      // yet, hence the read-and-pin fallback.
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
      else {
        p.cancelScheduledValues(now);
        p.setValueAtTime(Math.max(0.0001, p.value), now);
      }
      p.exponentialRampToValueAtTime(0.0001, now + STEAL_FADE);
    } catch { /* param is past its schedule — the node is already done */ }
  }
  for (const src of v.sources) {
    // A later stop() overrides an earlier one, so the synth path's own
    // stop(now + decay) does not fight this.
    try { src.stop(now + STEAL_FADE + 0.01); } catch { /* already stopped */ }
  }
}

// How loaded the voice budget is right now. Exported for the sound overlay,
// which is where this whole mechanism is visible at all — and for the tests.
export function sfxVoiceLoad() {
  if (ctx) retireFinishedVoices(ctx.currentTime);
  return { active: voices.length, cap: CONFIG.audio.maxConcurrent };
}

// A symmetric random multiplier around 1: vary(0.1) -> 0.9 .. 1.1. Clamped
// so an unlucky roll can never invert or silence a sound.
function vary(amount) {
  if (!amount) return 1;
  const a = Math.min(0.9, Math.abs(amount));
  return 1 + (Math.random() * 2 - 1) * a;
}

// opts:
//   pitch     extra pitch multiplier ON TOP of the per-sound random variation
//             (kill sounds use this to drop in pitch for bigger enemies)
//   decayMul  stretches the tail (bigger enemies boom for longer)
//   x, y      where in the world it happened, for the voice budget to rank it
//             by. Omit for anything that isn't a place — UI, level-up, death.
// Decode an uploaded audio file (mp3/wav/ogg) and use it for `name` from now
// on. Returns false if it couldn't be decoded, leaving the synth fallback in
// place rather than silently muting that sound.
export async function loadSampleFromFile(name, file, { append = false } = {}) {
  if (!ctx) initAudio();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    // Appending builds up a variation set one upload at a time, which is how
    // the Sound tab lets you stack takes for a single sound.
    const existing = append ? (buffers.get(name) ?? []) : [];
    buffers.set(name, [...existing, buf]);
    notifySamplesChanged();
    return true;
  } catch (err) {
    console.warn(`[audio] could not decode "${file.name}" for "${name}" — keeping the synthesized sound.`, err?.message ?? err);
    return false;
  }
}

export function clearSample(name) {
  buffers.delete(name);
  lastPick.delete(name);
  notifySamplesChanged();
}

export function hasSample(name) {
  return (buffers.get(name)?.length ?? 0) > 0;
}

// How many variations are loaded for a sound — the Sound tab shows this so
// you can see a set building up as you upload takes.
export function sampleCount(name) {
  return buffers.get(name)?.length ?? 0;
}

export function playSfx(name, volumeScale = 1, opts = {}) {
  if (isMuted()) { noteSfx(name, 'muted'); return; }
  if (!unlocked || !ctx || !CONFIG.audio.enabled) { noteSfx(name, 'off'); return; }
  const def = CONFIG.sfx[name];
  // Nothing warns about this at runtime — playSfx has always just returned —
  // so a typo'd name is a sound that silently never plays. The overlay is the
  // only place it becomes visible.
  if (!def) { noteSfx(name, 'unknown'); return; }

  const now = ctx.currentTime;
  retireFinishedVoices(now);

  const pitchMul = vary(def.pitchVary) * (opts.pitch ?? 1) * rateScale;
  const filterMul = vary(def.filterVary);
  // Stretched by the same factor the pitch drops by, so slowing a sound down
  // makes it longer as well as lower.
  const decay = ((def.decay ?? 0.2) * (opts.decayMul ?? 1)) / rateScale;
  // Measured on the audio clock rather than a counter, so the attenuation
  // follows real elapsed time and behaves the same at any frame rate.
  const rep = repetitionGain(name, now);
  const gainValue = (def.gain ?? 0.2) * volumeScale * rep;

  // A loaded sample replaces the synth entirely, but still gets the same
  // pitch treatment — playbackRate doubles as pitch for a buffer source. With
  // several variations loaded, each play picks a different one.
  const sample = pickSample(name);
  // Playback rate IS tape speed, so a sample pitched up is correspondingly
  // shorter. This is the number the voice budget is spent in, so it has to be
  // what the sound will actually do rather than what its config says — and
  // `audibleSeconds`, not `duration`, because the tail of most of these files
  // is silence and silence should not cost a voice.
  const rate = Math.max(0.05, pitchMul);
  const length = sample ? audibleSeconds(sample) / rate : decay + SYNTH_TAIL;

  const wantsTone = def.type === 'blip' || def.type === 'boom';
  const wantsNoise = def.type === 'noise' || def.type === 'boom';

  // No sample AND no synth to fall back on. For an entry that names files this
  // means every one of them failed to load, and the deployed site is where that
  // happens — a missing asset on Pages comes back 200 with index.html in it, so
  // the decode fails and only the boot warning ever says so.
  //
  // Checked BEFORE the cap, or a sound that is never going to be audible would
  // steal a voice from one that is — the worst possible trade.
  //
  // Called out rather than left as silence. This used to be covered by a synth
  // blip that sounded nothing like the file, which is its own kind of lie: the
  // sound was "working" and simply wrong. A red row naming it is the outcome
  // that actually sends you to the right place.
  if (!sample && !wantsTone && !wantsNoise) { noteSfx(name, 'missing'); return; }

  // How near the player this happened, as a band — see sfxBand.
  const band = sfxBand(opts.x, opts.y);

  // Past the cap, something has to lose. The new sound is no longer guaranteed
  // to be the winner: it wins against anything further away than it is, and
  // loses to a bus full of sounds that are all closer.
  if (voices.length >= CONFIG.audio.maxConcurrent) {
    const pick = worstVoiceIndex();
    // Nothing to take. Only reachable with a cap of zero or below, which is a
    // deliberate off switch and the one case where refusing outright is still
    // the right answer.
    if (pick < 0) { noteSfx(name, 'voices'); return; }
    const victim = voices[pick];
    // Everything sounding is closer to the player than this is, so this is the
    // one that goes. Before the bands existed the newest sound always won, and
    // that is how a far-wall kill could cut the hit landing in your face.
    if (victim.band > band) { noteSfx(name, 'far'); return; }
    voices.splice(pick, 1);
    releaseVoice(victim, now);
    // Reported against the voice that LOST, not the one that played, because
    // "what got cut" is the question — a run of these naming one sound is the
    // shape of a budget being eaten by one event.
    noteSfx(victim.name, 'stolen');
  }

  const voice = { name, band, endsAt: now + length, gains: [], sources: [] };
  voices.push(voice);

  if (sample) {
    noteSfx(name, 'sample', {
      take: (lastPick.get(name) ?? 0) + 1,
      takes: buffers.get(name)?.length ?? 1,
      gain: gainValue,
      pitch: pitchMul,
      rep,
    });
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    src.buffer = sample;
    src.playbackRate.value = rate;
    let node = src;
    if (def.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.max(80, def.filter * filterMul);
      src.connect(filter);
      node = filter;
    }
    node.connect(gain).connect(master);
    src.start(now);
    // Stopped where the sound ends rather than where the file does. Everything
    // past this point is the export's padding, and running a node through it
    // costs a mixer slot for no audible reason.
    src.stop(now + length);
    voice.gains.push(gain);
    voice.sources.push(src);
    return;
  }

  // Reached only when no sample is loaded — either the entry has none by
  // design, or every file it named failed to decode. The overlay does not try
  // to tell those apart; the boot warning already does, and what matters live
  // is that this sound is NOT the file you think it is.
  noteSfx(name, 'synth', { gain: gainValue, pitch: pitchMul, rep });

  if (wantsTone) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = def.wave ?? 'sine';
    const [from, to] = def.freq ?? [440, 220];
    osc.frequency.setValueAtTime(Math.max(20, from * pitchMul), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to * pitchMul), now + decay);
    // Slight detune keeps a steady-pitch weapon from sounding sterile
    // without actually moving its pitch around.
    if (def.detune) osc.detune.value = (Math.random() * 2 - 1) * def.detune;
    envelope(gain, gainValue, decay, now);
    osc.connect(gain).connect(master);
    osc.start(now);
    osc.stop(now + decay + SYNTH_TAIL);
    voice.gains.push(gain);
    voice.sources.push(osc);
  }

  if (wantsNoise) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noiseBuffer(decay + SYNTH_TAIL);
    filter.type = 'lowpass';
    const cutoff = Math.max(80, (def.filter ?? 2000) * filterMul * pitchMul);
    filter.frequency.setValueAtTime(cutoff, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.25), now + decay);
    envelope(gain, gainValue * (def.noise ?? 1), decay, now);
    src.connect(filter).connect(gain).connect(master);
    src.start(now);
    src.stop(now + decay + SYNTH_TAIL);
    voice.gains.push(gain);
    voice.sources.push(src);
  }
}

// Phone buzz only — this is the Vibration API, which does not exist on desktop
// and cannot reach a gamepad. Controller rumble lives in systems/haptics.js.
export function vibrate(pattern) {
  if (!pattern || !CONFIG.haptics.enabled) return;
  // The Vibration API only understands a number or an array of numbers, and
  // throws a TypeError on anything else. Pulse-object patterns used to be
  // dropped here outright — fine when two events used that form, but every
  // event added since authors its haptic that way, so on a phone the entire
  // companion-ability block would have buzzed for nothing at all.
  //
  // A phone motor has no intensity control, so magnitude can't survive the
  // conversion; duration and spacing can, and that's what carries the shape.
  const ms = toMsPattern(pattern);
  if (!ms) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* permissions policy or unsupported — ignore */
  }
}

// -> a Vibration-API [on, off, on, ...] list, or null if there's nothing to
// buzz. Pulse objects carry ABSOLUTE delays (haptics.js resolves them that
// way), so each gap is the delay minus where the previous pulse ended.
function toMsPattern(pattern) {
  if (typeof pattern === 'number') return [pattern];
  if (!Array.isArray(pattern)) {
    return pattern?.duration > 0 ? [Math.round(pattern.duration)] : null;
  }
  if (pattern.every((v) => typeof v === 'number')) return pattern;

  const out = [];
  let cursor = 0;
  for (const p of pattern) {
    if (!p || typeof p !== 'object') continue;
    const duration = Math.round(p.duration ?? 40);
    if (duration <= 0) continue;
    const start = Math.round(p.delay ?? 0);
    // Overlapping pulses can't be expressed as on/off, so a pulse that starts
    // before the previous one finished is simply appended with no gap.
    if (out.length) out.push(Math.max(0, start - cursor));
    cursor = Math.max(cursor, start) + duration;
    out.push(duration);
  }
  return out.length ? out : null;
}

export function isMuted() {
  return settings.audio.muted;
}
