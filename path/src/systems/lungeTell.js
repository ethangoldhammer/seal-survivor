import { CONFIG } from '../config.js';
import { enemies } from '../entities/enemies.js';
import { makeOrganicRing, placeOrganicRing, updateOrganicRing, disposeOrganicRing } from './organicRing.js';
import { feedback } from './feedback.js';

// ---------------------------------------------------------------------------
// THE TELL ON A LUNGE — the thing a player is meant to be reading.
//
// lungeChase (entities/enemies.js) is a state machine on the body: `wind` is a
// throttled turn onto you, `strike` is the run, `reaim` is the short second
// gather inside a double or a feint. Those are readable if you are looking at
// the animal and know what a shark slowing down means. Most of the time you are
// looking at your own seal and the animal is a dark shape at the edge of the
// frame, and the wind-up has to be readable THERE — so it is said three ways at
// once, the way the boss perk's lunge already says it (systems/bossPerks.js):
//
//   THE RING    the shared organic ring (systems/organicRing.js), in the
//               kinetic dialect, drawn around the body. It sweeps in over the
//               wind-up, tightens as the gather completes, and blows out over
//               the run — so its state is the countdown, from a long way off.
//   THE JAW     the procedural jaw gapes through the wind-up and is held open
//               for the run (jaw.setGape) — a mouth opening is the oldest tell
//               there is, and it is on the animal rather than around it.
//   THE EVENT   CONFIG.feedback.lungeWind / lungeStrike, so the water ripples
//               where the gather starts and the launch lands with a shove.
//               Bosses get their own pair, because a wildlife shark two screens
//               away must not shake the camera and a boss committing should.
//
// ONE RING PER CREATURE, owned here and keyed by the creature, created on the
// first frame it winds up and disposed when it leaves the water. Hidden rather
// than disposed between cycles, so a boss that lunges every eight seconds for
// a minute does not build and drop a ShaderMaterial a dozen times.
//
// This is presentation: it reads `lungeStage` / `lungeClock` /
// `lungeStageTime` off the creature and writes nothing back to the behaviour.
// Switching it off changes nothing about when a shark commits or what it
// costs — only whether you were told.
// ---------------------------------------------------------------------------

const tells = new Map();
const live = new Set();

function cfg() {
  return CONFIG.lungeTell ?? {};
}

function progress(e) {
  const total = e.lungeStageTime || 0;
  if (!(total > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - (e.lungeClock ?? 0) / total));
}

function ringFor(scene, e) {
  let t = tells.get(e);
  if (t) return t;
  const c = cfg();
  const ring = makeOrganicRing({
    type: c.type ?? 'kinetic',
    thickness: c.thickness ?? 0.09,
    glow: c.glow ?? 2.2,
    renderOrder: 5,
  });
  ring.visible = false;
  scene.add(ring);
  t = { ring, stage: null };
  tells.set(e, t);
  return t;
}

function drop(e, t) {
  disposeOrganicRing(t.ring);
  tells.delete(e);
}

/**
 * Tick every tell. Call once per frame after updateEnemies — the stage the
 * ring draws is this frame's, not last frame's.
 */
export function updateLungeTells(dt, scene) {
  const c = cfg();
  live.clear();
  for (const e of enemies) live.add(e);
  for (const [e, t] of tells) if (!live.has(e)) drop(e, t);
  if (c.enabled === false) {
    for (const [, t] of tells) t.ring.visible = false;
    return;
  }

  for (const e of enemies) {
    if (!e.def?.lunge || !e.mesh) continue;
    const stage = e.lungeStage;
    const telling = stage === 'wind' || stage === 'strike' || stage === 'reaim';
    let t = tells.get(e);
    if (!telling) {
      if (t) {
        t.ring.visible = false;
        t.stage = null;
        e.jaw?.setGape?.(0);
      }
      continue;
    }
    t = t ?? ringFor(scene, e);
    const boss = e.isBoss === true;
    const scale = boss ? (c.bossRingScale ?? 1.35) : (c.ringScale ?? 1.7);
    const r = (e.radius ?? 1) * scale;
    const u = progress(e);
    const x = e.mesh.position.x;
    const y = e.mesh.position.y;

    if (t.stage !== stage) {
      // A transition. `wind` opens the cycle, `strike` is every launch in it
      // (a double launches twice and is told twice), `reaim` is silent — the
      // ring and the jaw carry it.
      if (stage === 'wind') feedback(boss ? 'bossLungeWind' : 'lungeWind', { x, y, scale: boss ? 1.4 : 1 });
      if (stage === 'strike') feedback(boss ? 'bossLungeStrike' : 'lungeStrike', { x, y, vx: e.vx, vy: e.vy, scale: boss ? 1.4 : 1 });
      t.stage = stage;
    }

    t.ring.visible = true;
    if (stage === 'wind' || stage === 'reaim') {
      // Gathering: the ring draws itself on and tightens onto the body, the
      // jaw comes open with it. A re-aim starts from further along — the
      // player has been told once already this cycle, so the second tell is
      // shorter and arrives brighter.
      const from = stage === 'reaim' ? 0.4 : 0;
      const v = from + (1 - from) * u;
      placeOrganicRing(t.ring, x, y, r * (1.25 - 0.25 * v), e.mesh.position.z);
      updateOrganicRing(t.ring, dt, {
        opacity: 0.15 + 0.8 * v,
        sweepIn: v,
        sweepOut: 0,
        charge: v,
      });
      e.jaw?.setGape?.((c.gapeWind ?? 0.75) * v);
    } else {
      // The run: the ring blows out from the body and is eaten away behind
      // the hand; the jaw is held wide.
      placeOrganicRing(t.ring, x, y, r * (1 + 0.5 * u), e.mesh.position.z);
      updateOrganicRing(t.ring, dt, {
        opacity: 0.9 * (1 - u),
        sweepIn: 1,
        sweepOut: u,
        charge: 1,
      });
      e.jaw?.setGape?.(c.gapeStrike ?? 1);
    }
  }
}

/** New run, or the tells are being switched off: drop every ring. */
export function resetLungeTells() {
  for (const [e, t] of tells) {
    e.jaw?.setGape?.(0);
    disposeOrganicRing(t.ring);
  }
  tells.clear();
}

/** For the harness: how many creatures currently carry a visible tell. */
export function __lungeTellCount() {
  let n = 0;
  for (const [, t] of tells) if (t.ring.visible) n++;
  return n;
}
