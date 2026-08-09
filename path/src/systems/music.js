import { CONFIG } from '../config.js';
import { bounds, depthFraction } from '../arena.js';
import { getAudioContext } from './audio.js';

// A loop player that changes tracks ON THE BEAT rather than the instant
// something happens in game. When you level up, the upgrade loop is QUEUED —
// it starts at the next loop boundary, so the current loop finishes cleanly
// instead of being cut off mid-phrase. Meanwhile a low-pass sweeps the mix
// down (the "you're in a menu" muffle), and sweeps back open when the run
// resumes.
//
// Loop length comes from the configured BPM and beats-per-loop, not from the
// audio file's duration, so a track that's slightly long or short still lines
// up with the musical grid you told it to use.

let ctx = null;
let musicGain = null;
let filter = null;
let source = null;
// Parallel band-pass path, used only by the suffocation effect. See
// setBandpass() at the bottom of this file.
let bandpass = null;
let bandDry = null;
let bandWet = null;

const tracks = new Map(); // name -> AudioBuffer
let currentTrack = null;
let queuedTrack = null;
let loopStartTime = 0; // ctx time the current loop iteration began
// ctx time playback started — the origin of the musical grid, and unlike
// loopStartTime it never moves. See beatPhase().
let gridAnchor = 0;
let started = false;
let pollTimer = null;
let defaultsRequested = false;
let pendingLevel = null; // level asked for via play() before any track was ready yet

// A transport-wide multiplier ON TOP of CONFIG.music.playbackRate, owned by
// the death dive: the tape drags to a halt as time dilates. Separate from the
// configured rate rather than written into it, so the tuner's value is still
// the value and a run that ends mid-drag doesn't leave the slider lying.
let rateScale = 1;

// Ramped rather than set: playbackRate is an AudioParam, and stepping it every
// frame zippers audibly on a sustained loop. `glide` of 0 is the instant reset
// startGame wants.
export function setMusicRateScale(scale, glide = 0.2) {
  rateScale = Math.max(0.05, Math.min(4, scale || 1));
  if (!source || !ctx) return;
  const target = Math.max(0.05, CONFIG.music.playbackRate * rateScale);
  if (glide > 0) source.playbackRate.setTargetAtTime(target, ctx.currentTime, glide);
  else source.playbackRate.setValueAtTime(target, ctx.currentTime);
}

// The tempo you actually HEAR. `playbackRate` is applied to the source node
// (see startSource), so a rate of 1.5 makes a 120bpm loop play at 180 — and
// anything trying to move in time with the music has to follow that, not the
// configured number. Exported so the animation system can march creatures to
// the beat; see CONFIG.enemies.<key>.beatSync.
export function currentBpm() {
  return Math.max(1, CONFIG.music.bpm) * Math.max(0.01, CONFIG.music.playbackRate ?? 1) * rateScale;
}

// Seconds per beat at the audible tempo.
export function beatDuration() {
  return 60 / currentBpm();
}

export function loopDuration() {
  const beats = Math.max(1, CONFIG.music.beatsPerLoop);
  return (60 / Math.max(1, CONFIG.music.bpm)) * beats;
}

// Where we are on the beat grid right now, in fractional beats since the
// transport started. The whole part is which beat; the FRACTION is what
// anything moving in time with the music actually wants — it says where in
// the bar a cycle should currently be, so a loop can be started mid-way and
// still land its next peak on a beat.
//
// Anchored to gridAnchor rather than loopStartTime because that one is
// advanced by a whole loop every time the loop wraps (see pollQueue); phase
// measured against it would reset every 32 beats.
//
// 0 while nothing is playing, which puts anything asking at the top of the
// bar — the seal idling on the start menu before the audio context has been
// unlocked animates from a clean phase rather than a random one.
export function beatPhase() {
  if (!started || !ctx) return 0;
  return (ctx.currentTime - gridAnchor) / beatDuration();
}

function ensureChain() {
  if (!ctx) ctx = getAudioContext();
  if (!ctx) return false;
  if (!musicGain) {
    musicGain = ctx.createGain();
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Starts wide open; updateDepth takes it from here once a run begins.
    filter.frequency.value = CONFIG.music.surfaceHz;
    filter.Q.value = CONFIG.music.resonance;
    musicGain.gain.value = CONFIG.music.volume;

    // source -> filter (depth lowpass) -> [ dry ------------> ] -> musicGain
    //                                     [ bandpass -> wet -> ]
    //
    // The band-pass hangs off the depth filter in PARALLEL, crossfaded by
    // setBandpass rather than switched in. A single node retyped to
    // 'bandpass' would have meant fighting updateDepth over one frequency
    // AudioParam, and there'd be no way to sit halfway between the two
    // sounds — which is the entire ask, since the effect has to ease in and
    // back out rather than snap.
    bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = CONFIG.oxygen?.fx?.musicCenterHz ?? 900;
    bandpass.Q.value = 0.7;
    bandDry = ctx.createGain();
    bandWet = ctx.createGain();
    bandDry.gain.value = 1;
    bandWet.gain.value = 0; // fully bypassed until oxygen gets low

    filter.connect(bandDry).connect(musicGain);
    filter.connect(bandpass).connect(bandWet).connect(musicGain);
    musicGain.connect(ctx.destination);
  }
  return true;
}

export async function loadTrackFromFile(name, file) {
  if (!ensureChain()) return false;
  try {
    tracks.set(name, await ctx.decodeAudioData(await file.arrayBuffer()));
    notifyTracksChanged();
    return true;
  } catch (err) {
    console.warn(`[music] could not decode "${file.name}" —`, err?.message ?? err);
    return false;
  }
}

// The Sound tab's rows are built once, well before defaults finish fetching,
// so it can't just read hasTrack() at build time — it subscribes here and
// re-checks itself whenever a slot's contents might have changed.
const trackListeners = new Set();
export function onTracksChanged(cb) {
  trackListeners.add(cb);
  return () => trackListeners.delete(cb);
}
function notifyTracksChanged() {
  for (const cb of trackListeners) cb();
}

export function hasTrack(name) {
  return tracks.has(name);
}

export function clearTrack(name) {
  tracks.delete(name);
  notifyTracksChanged();
}

// Fetches CONFIG.music.defaultSrc into their slots (1-indexed) so the game
// has music without anyone having to upload anything — same
// load-with-fallback pattern as CONFIG.sfx's `src`. A slot whose file 404s
// or fails to decode is just left empty and skipped, same as an unfilled
// upload slot. Safe to call repeatedly; only does the fetching once.
export async function preloadDefaultTracks() {
  if (defaultsRequested || !ensureChain()) return;
  defaultsRequested = true;
  const sources = CONFIG.music.defaultSrc ?? [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const name = String(i + 1);
    if (!src || tracks.has(name)) continue;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tracks.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`[music] could not load default loop "${src}" —`, err?.message ?? err);
      continue;
    }
    notifyTracksChanged();
    // play() may have already been called and found nothing loaded yet —
    // pick it up now instead of staying silent for the rest of the run.
    if (pendingLevel != null) play(pendingLevel);
  }
}

function startSource(name, when) {
  const buffer = tracks.get(name);
  if (!buffer) return;
  stopSource();
  source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  // Loop the BUFFER over the musical loop length when the file is longer
  // than one loop — keeps playback on the grid the BPM defines.
  const dur = loopDuration();
  if (buffer.duration > dur + 0.01) {
    source.loopStart = 0;
    source.loopEnd = dur;
  }
  source.playbackRate.value = Math.max(0.05, CONFIG.music.playbackRate * rateScale);
  source.connect(filter);
  source.start(when);
  currentTrack = name;
  loopStartTime = when;
}

function stopSource() {
  if (!source) return;
  try { source.stop(); } catch { /* already stopped */ }
  source.disconnect();
  source = null;
}

// Next loop boundary at or after `now` — this is what makes a switch land
// musically instead of wherever the player happened to level up.
export function nextBoundary(now = ctx?.currentTime ?? 0) {
  const dur = loopDuration();
  if (!started || dur <= 0) return now;
  const elapsed = now - loopStartTime;
  const loopsDone = Math.floor(elapsed / dur) + 1;
  return loopStartTime + loopsDone * dur;
}

// Start playback at the loop appropriate for `level`. With nothing uploaded
// this is a no-op — the player stays silent rather than erroring.
//
// Starting a run calls this with level 1, which lands on the FIRST filled
// slot: every run opens on the same loop rather than picking up wherever the
// last one happened to end.
export function play(level = 1) {
  if (!CONFIG.music.enabled || !ensureChain()) return;
  currentLevel = level;
  const slot = slotForLevel(level);
  if (!slot) { pendingLevel = level; return; }
  pendingLevel = null;
  // Drop anything the previous run left queued, or it would cut in at the
  // next boundary and override the loop we just started on.
  queuedTrack = null;
  depthHeld = false;
  resumeUntil = 0;
  startSource(slot, ctx.currentTime + 0.02);
  // Beat 0 is where the first loop starts, not where play() was called.
  gridAnchor = loopStartTime;
  started = true;
  // Open at the surface value; the first updateDepth call glides it to
  // wherever the player actually is.
  filter.frequency.cancelScheduledValues(ctx.currentTime);
  filter.frequency.setValueAtTime(Math.max(60, CONFIG.music.surfaceHz), ctx.currentTime);
  if (!pollTimer) pollTimer = window.setInterval(pollQueue, 40);
}

export function stop() {
  stopSource();
  started = false;
  queuedTrack = null;
  pendingLevel = null;
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// Queue a track to begin at the next loop boundary. Passing the track that's
// already playing is a no-op, so repeated level-ups don't restart the loop.
export function queueTrack(name) {
  if (!started || !tracks.has(name) || name === currentTrack) return;
  queuedTrack = name;
}

function pollQueue() {
  if (!ctx || !started) return;
  const dur = loopDuration();
  const now = ctx.currentTime;

  // Keep loopStartTime tracking the current iteration so boundary math stays
  // correct across long sessions.
  while (now - loopStartTime >= dur) loopStartTime += dur;

  if (!queuedTrack) return;
  const boundary = nextBoundary(now);
  // Schedule slightly ahead of the boundary so the switch is sample-accurate
  // rather than depending on when this poll happens to fire.
  if (boundary - now <= 0.12) {
    const name = queuedTrack;
    queuedTrack = null;
    startSource(name, boundary);
  }
}

// --- filter, driven by depth ---------------------------------------------
// The cutoff follows the player's Y: wide open at or above the surface,
// rolling off toward `deepHz` at the seabed. Water muffling you can hear
// yourself cause by diving reads as part of the world, where the old
// level-driven version was a step you only noticed on level-up.
//
// The upgrade screen ducks BELOW wherever depth currently has it, then hands
// control back — so the duck is relative to where you're swimming, not a
// fixed pair of values.
export function cutoffForDepth(y) {
  const m = CONFIG.music;
  // Above the surface is "fully open" — no extra brightness for jumping
  // higher, since there's no more water to get out of. depthFraction handles
  // that clamp, and the SFX bus rides the same curve with its own range.
  const t = depthFraction(y);
  // Interpolate in log space — filter cutoff is perceived logarithmically,
  // so a linear ramp would spend most of its travel in a range you can
  // barely hear changing.
  return m.surfaceHz * Math.pow(m.deepHz / m.surfaceHz, t);
}

let currentLevel = 1;
// While the upgrade screen has the filter ducked, depth updates stand down
// so the two aren't fighting over the same AudioParam.
let depthHeld = false;
// ctx time until which depth tracking glides at `sweepTime` rather than the
// quicker `depthSmoothing` — the climb back out of an upgrade-screen duck.
let resumeUntil = 0;

function rampTo(hz, seconds) {
  if (!ensureChain()) return;
  const now = ctx.currentTime;
  filter.frequency.cancelScheduledValues(now);
  filter.frequency.setValueAtTime(Math.max(60, filter.frequency.value), now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(60, hz), now + Math.max(0.01, seconds));
}

// Called every frame with the player's Y, and is the ONLY thing writing the
// cutoff during gameplay — duck/sweep hand control here rather than leaving
// a scheduled ramp for this to truncate a frame later.
//
// setTargetAtTime is exponential-approach, so re-issuing it every frame
// glides smoothly; setValueAtTime would step audibly and a fresh ramp per
// frame would cancel the previous one mid-flight.
export function updateDepth(y) {
  if (!CONFIG.music.enabled || !started || depthHeld || !ensureChain()) return;
  const now = ctx.currentTime;
  // Just came back from the upgrade screen: take `sweepTime` to climb out of
  // the duck, then settle into the quicker depth-tracking constant. A time
  // constant reaches ~95% in 3τ, hence the /3.
  const tau = now < resumeUntil
    ? Math.max(0.01, CONFIG.music.sweepTime / 3)
    : Math.max(0.01, CONFIG.music.depthSmoothing);
  filter.frequency.setTargetAtTime(Math.max(60, cutoffForDepth(y)), now, tau);
}

// Called on level-up. Advances the loop (quantized) if this level crosses
// into the next slot. The filter is depth-driven now, so level-up no longer
// touches it.
export function setLevel(level) {
  currentLevel = level;
  if (!CONFIG.music.enabled || !started) return;
  const slot = slotForLevel(level);
  if (slot != null && slot !== currentTrack) queueTrack(slot);
}

// Which uploaded loop should be playing at this level. Empty slots are
// skipped, so uploading only a few loops still spreads them across a run
// instead of leaving silent gaps.
export function slotForLevel(level) {
  const filled = [];
  for (let i = 1; i <= CONFIG.music.slots; i++) if (tracks.has(String(i))) filled.push(String(i));
  if (filled.length === 0) return null;
  const idx = Math.floor((level - 1) / Math.max(1, CONFIG.music.levelsPerSlot));
  return filled[Math.min(idx, filled.length - 1)];
}

// Upgrade screen: duck below wherever depth currently has the filter, and
// freeze depth tracking so it can't sweep back up underneath the duck.
export function duckForUpgrade() {
  if (!CONFIG.music.enabled || !started) return;
  depthHeld = true;
  rampTo(CONFIG.music.duckedHz, CONFIG.music.duckTime);
}

// Back to gameplay: release the hold and let updateDepth glide out of the
// duck over `sweepTime`. Deliberately schedules nothing itself — a ramp here
// would just be truncated by the next frame's depth update.
export function sweepOpen() {
  if (!CONFIG.music.enabled || !started || !ensureChain()) return;
  depthHeld = false;
  resumeUntil = ctx.currentTime + CONFIG.music.sweepTime;
}

// --- suffocation band-pass -------------------------------------------------
// `amount` is oxygenFx's 0..1 strain. At 0 this is an exact bypass (wet
// silent, dry unity), so a run played well never touches the music path.
//
// Two things move together as it climbs: the crossfade pushes signal into the
// band-pass path, and the band itself narrows from wide-open toward
// `musicQ` — so the score doesn't just get thinner, it closes in.
//
// setTargetAtTime rather than direct assignment for the same reason
// updateDepth uses it: this is called every frame, and stepping the values
// would zipper.
export function setBandpass(amount) {
  if (!ensureChain()) return;
  const cfg = CONFIG.oxygen?.fx ?? {};
  const a = cfg.musicEnabled === false ? 0 : Math.max(0, Math.min(1, amount || 0));
  const now = ctx.currentTime;
  const mix = a * (cfg.musicMix ?? 0.92);
  bandDry.gain.setTargetAtTime(1 - mix, now, 0.06);
  bandWet.gain.setTargetAtTime(mix, now, 0.06);
  bandpass.frequency.setTargetAtTime(Math.max(60, cfg.musicCenterHz ?? 900), now, 0.06);
  bandpass.Q.setTargetAtTime(0.7 + a * Math.max(0, (cfg.musicQ ?? 3.6) - 0.7), now, 0.06);
}

export function applyMusicSettings() {
  if (!ensureChain()) return;
  musicGain.gain.value = CONFIG.music.enabled ? CONFIG.music.volume : 0;
  filter.Q.value = CONFIG.music.resonance;
  if (source) source.playbackRate.value = Math.max(0.05, CONFIG.music.playbackRate * rateScale);
}
