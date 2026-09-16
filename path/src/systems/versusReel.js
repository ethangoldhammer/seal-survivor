// ---------------------------------------------------------------------------
// THE HIGHLIGHT REEL — what the match is remembered by, once it is over.
//
// The instant replay (systems/versus.js) is a ring buffer `replay.buffer`
// seconds deep: enough to play back the shot that just scored and nothing
// older. A match is five goals long and the buffer has forgotten the first
// four by the time anyone wins, so the end of a match had nothing to show but
// frozen water.
//
// THIS IS THE ARCHIVE. Every moment worth keeping asks for a CLIP while it is
// still in the ring — a goal, a save, a body check — and the clip is COPIED
// out of the ring before the ring rolls over it. At the end of the match the
// kept clips are ordered into a playlist and versus.js plays them through the
// replay machinery it already has: the same posing, the same event track, the
// same camera pool cutting between angles.
//
// A CLIP IS ASKED FOR, THEN HARVESTED, and the two are separate because a
// highlight is not over when it happens. A save is only a save once the ball
// is clear, and a body check reads as one only once the seal it landed on has
// tumbled — so `requestClip` files the moment and `harvest` takes the frames
// once the recorder has `toT` in it. A goal is the one kind that ends on its
// own moment (the ball is dead), so it is harvested on the frame it is asked
// for and the same path serves all three.
//
// THIS FILE NEVER TOUCHES THE RECORDER. versus.js owns the ring and hands in
// a `snapshot(fromT, toT)` that returns DEEP COPIES — the ring's frames are
// reused objects, and a clip holding references to them would be overwritten
// by the next few seconds of play and play back as whatever happened later.
// Keeping the copying on that side is also what keeps this file free of three
// and testable with nothing mounted.
//
// See CONFIG.versus.reel.
// ---------------------------------------------------------------------------

import { CONFIG } from '../config.js';

const cfg = () => CONFIG.versus?.reel ?? {};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export const reelState = {
  clips: [],        // harvested, in match order
  pending: [],      // asked for, waiting for their tail to be recorded
  order: [],        // the playlist: the kept clips, in the order they play
  at: -1,           // where in `order` the reel is
  playing: false,
  loops: 0,         // how many times the playlist has come round, for the harness
  asked: 0,         // for the harness
  harvested: 0,
  dropped: 0,       // asked for and never harvested (too short, or aged out)
};

export function resetReel() {
  reelState.clips.length = 0;
  reelState.pending.length = 0;
  reelState.order.length = 0;
  reelState.at = -1;
  reelState.playing = false;
  reelState.loops = 0;
  reelState.asked = 0;
  reelState.harvested = 0;
  reelState.dropped = 0;
}

/** The tuning for one kind of highlight, with the block's defaults under it. */
export function kindCfg(kind) {
  return cfg()[kind] ?? {};
}

/**
 * ASK FOR A CLIP round match time `at`.
 *
 *   at      the moment the highlight turns on — the touch that scored, the
 *           save's contact, the check's collision. The camera's beats pivot
 *           on this, not on the middle of the span.
 *   fromT   the first recorded second to keep...
 *   toT     ...and the last. The clip is harvested once the recorder's clock
 *           has passed `toT`.
 *   strength 0..1 — how big this one was, for the ranking when there are more
 *           highlights than the reel has room for.
 *
 * ONE CLIP PER MOMENT. A scramble in front of a mouth is three checks and two
 * saves inside a second, and a reel that showed all five would show the same
 * two seconds of footage five times. A request inside `minGap` of one already
 * filed for the same kind REPLACES it when it is stronger and is dropped when
 * it is not — so what survives a scramble is its biggest moment.
 */
export function requestClip(kind, spec) {
  if (cfg().enabled === false) return null;
  const k = kindCfg(kind);
  if (k.enabled === false) return null;
  const clip = {
    kind,
    at: spec.at,
    fromT: spec.fromT,
    toT: spec.toT,
    who: spec.who ?? 0,
    side: spec.side ?? -1,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    strength: clamp01(spec.strength ?? 0.5),
    goal: spec.goal ?? null,
    frames: null,
    events: null,
  };
  clip.weight = (k.weight ?? 1) + clip.strength * (k.spread ?? 1);
  const gap = cfg().minGap ?? 1.2;
  const near = (list) => list.findIndex((c) => c.kind === kind && Math.abs(c.at - clip.at) < gap);
  const p = near(reelState.pending);
  if (p >= 0) {
    if (reelState.pending[p].weight >= clip.weight) return null;
    reelState.pending[p] = clip;
    reelState.asked++;
    return clip;
  }
  const h = near(reelState.clips);
  if (h >= 0) {
    if (reelState.clips[h].weight >= clip.weight) return null;
    // The harvested one loses: it is replaced by the request, which will take
    // its own frames when its tail is in. Not by splicing the new clip into
    // the harvested list — it has no frames yet.
    reelState.clips.splice(h, 1);
  }
  reelState.pending.push(clip);
  reelState.asked++;
  return clip;
}

/**
 * Take the frames for every pending clip the recorder has caught up with.
 * `clock` is the match clock; `snapshot(fromT, toT)` returns
 * `{ frames, events }` in time order, DEEP COPIED out of the ring.
 *
 * A clip whose span has fallen out of the ring (a request filed and then
 * starved by a long freeze) is dropped rather than harvested short: a
 * two-frame clip is a still, and a still in a reel reads as a crash.
 */
export function harvestClips(clock, snapshot) {
  const out = reelState.pending;
  // THE COMMON CASE IS NOTHING, and this is called every frame of play: a
  // match files eight or ten clips in three minutes, so the loop below runs
  // ten times and this line runs ten thousand.
  if (!out.length) return 0;
  let took = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const clip = out[i];
    if (clock < clip.toT) continue;
    out.splice(i, 1);
    const got = snapshot(clip.fromT, clip.toT);
    const frames = got?.frames ?? [];
    const minFrames = Math.max(2, cfg().minFrames ?? 8);
    if (frames.length < minFrames) { reelState.dropped++; continue; }
    clip.frames = frames;
    clip.events = got.events ?? [];
    // The span the clip ACTUALLY holds, not the one that was asked for: the
    // ring may not have reached back as far as `fromT`, and a replay opened
    // before its own first frame poses that frame and stalls there.
    clip.fromT = frames[0].t;
    clip.toT = frames[frames.length - 1].t;
    clip.at = Math.min(Math.max(clip.at, clip.fromT), clip.toT);
    reelState.clips.push(clip);
    reelState.harvested++;
    took++;
  }
  if (took) reelState.clips.sort((a, b) => a.at - b.at);
  return took;
}

/**
 * THE PLAYLIST — the kept clips, in the order they play.
 *
 * CHRONOLOGICAL, because a match has a shape and the reel is that shape: the
 * opener first and the goal that won it last, which is where a reel wants to
 * end whether it loops or not. No ordering rule has to be invented to get
 * that; the match already did it.
 *
 * `maxClips` is the ceiling, and what is cut when there are more is the
 * lowest-weighted — a tap-in before a screamer, a shove before a save — with
 * the LAST GOAL held back from the cut whatever it weighs. It is the one clip
 * the reel is guaranteed to be about.
 */
export function buildPlaylist() {
  const max = Math.max(1, cfg().maxClips ?? 8);
  const all = [...reelState.clips];
  const lastGoal = [...all].reverse().find((c) => c.kind === 'goal') ?? null;
  let keep = all;
  if (all.length > max) {
    const ranked = [...all].sort((a, b) => (b.weight - a.weight) || (b.at - a.at));
    keep = ranked.slice(0, max);
    if (lastGoal && !keep.includes(lastGoal)) { keep[keep.length - 1] = lastGoal; }
    keep.sort((a, b) => a.at - b.at);
  }
  reelState.order = keep;
  reelState.at = -1;
  return keep;
}

/** The clip after the one playing, wrapping — and the wrap is a loop. */
export function nextClip() {
  const st = reelState;
  if (!st.order.length) return null;
  st.at++;
  if (st.at >= st.order.length) { st.at = 0; st.loops++; }
  return st.order[st.at];
}

/** How long the whole playlist runs, in wall seconds, at `speedOf(clip)`. */
export function playlistSeconds(speedOf, tailOf) {
  let total = 0;
  for (const c of reelState.order) {
    const speed = Math.max(0.01, speedOf(c));
    total += (c.toT - c.fromT) / speed + (tailOf?.(c) ?? 0);
  }
  return total;
}
