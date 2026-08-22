import { CONFIG } from '../config.js';
import { rumbleScale } from './settings.js';
import { toPulses, magnitudeFromDuration } from './haptics.js';

// ============================================================================
// THE TAPTIC ENGINE — the third device an authored haptic can come out of.
//
// systems/haptics.js drives a controller's two motors and audio.js's vibrate()
// drives the Vibration API. Neither reaches an iPhone: the Vibration API does
// not exist in WebKit at all, so on the native build every `haptic:` in
// CONFIG.feedback was landing nowhere. This is the same authored pattern
// pointed at the one piece of hardware the phone does have.
//
// WHY IT CANNOT JUST REPLAY THE PATTERN. The pad takes a magnitude and a
// duration and holds it. The Taptic Engine takes neither — UIImpactFeedback-
// Generator fires ONE tap of one of three weights and that is the entire
// vocabulary. So a pulse's duration cannot be played; it can only be read as
// intensity, which is exactly what magnitudeFromDuration already does for the
// pad (a 6ms muzzle tick up to a 45ms hit taken). Same curve, same floor, same
// CONFIG.haptics knobs — a tuning change moves all three devices together
// rather than drifting one against the others.
//
// WHY THE RATE LIMIT IS NOT OPTIONAL. `shoot` fires `haptic: [6]` on every
// bullet, and the mixer in haptics.js exists precisely because those overlap
// into a bed. A motor can hold a bed. The Taptic Engine cannot — it can only
// re-tap, and a tap per bullet at ten bullets a second is a rattle that reads
// as a fault in the phone. So small taps are spaced, and a big one is allowed
// to cut through the spacing rather than being swallowed by it: a kill landing
// 20ms after a muzzle tick has to be felt, or the channel says nothing at the
// only moments worth saying anything.
// ============================================================================

let impactFn = null;
let styles = null;
let loading = null;
let failed = false;

/** Live counters for the G overlay, mirroring hapticStatus in haptics.js. */
export const tapticStatus = { sent: 0, skipped: 0, lastStyle: '', lastError: '' };

/**
 * A native shell, as opposed to a browser. `Capacitor.isNativePlatform()` is
 * false in the web build even with the plugin bundled, which is what keeps the
 * whole path inert on the deployed site.
 */
export function tapticAvailable() {
  return !!globalThis.window?.Capacitor?.isNativePlatform?.();
}

// Warmed at module load rather than on the first haptic. The import resolves a
// chunk off disk and the generator wants preparing before it is asked for a
// tap; doing both on the first bullet costs that bullet its feedback.
function load() {
  if (impactFn || failed) return loading;
  loading ??= import('@capacitor/haptics')
    .then((m) => {
      impactFn = (style) => m.Haptics.impact({ style });
      styles = m.ImpactStyle;
    })
    .catch((err) => {
      failed = true;
      tapticStatus.lastError = err?.message ?? String(err);
      console.warn('[taptic] plugin unavailable —', tapticStatus.lastError);
    });
  return loading;
}

if (tapticAvailable()) {
  load();
  // Backgrounding the app does not stop setTimeout from firing — iOS freezes
  // the timers and then runs the whole backlog the moment the app returns, so
  // without this a player who takes a call comes back to every tap the last
  // pattern had queued, all at once.
  globalThis.window?.addEventListener('blur', () => stopTaptic());
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTaptic();
  });
}

// --- pacing -----------------------------------------------------------------
let lastAt = 0;
let lastMagnitude = 0;
const pending = new Set();

function cfg() {
  return CONFIG.haptics?.taptic ?? {};
}

/**
 * Three weights is the whole vocabulary, so the thresholds ARE the mapping.
 * Anything under the floor is not sent at all — a Light tap is still a
 * distinctly felt event, so the pad's "too weak to spin the motor" band has to
 * become "too minor to interrupt the player" here instead.
 */
function styleFor(magnitude) {
  const c = cfg();
  if (magnitude >= (c.heavyAt ?? 0.66)) return { key: styles.Heavy, name: 'heavy' };
  if (magnitude >= (c.mediumAt ?? 0.34)) return { key: styles.Medium, name: 'medium' };
  return { key: styles.Light, name: 'light' };
}

/**
 * Spacing, with an escape for anything materially stronger than the bed it
 * lands in. Without the second clause a kill inside a burst of fire is dropped;
 * with it, the burst thins out and the kill still reads.
 */
function allowed(magnitude, now) {
  const c = cfg();
  if (now - lastAt >= (c.minGapMs ?? 60)) return true;
  return magnitude >= lastMagnitude + (c.cutThrough ?? 0.25);
}

function fire(magnitude) {
  if (!impactFn || !styles) return;
  const { key, name } = styleFor(magnitude);
  lastAt = performance.now();
  lastMagnitude = magnitude;
  tapticStatus.sent += 1;
  tapticStatus.lastStyle = name;
  // Fire-and-forget: the bridge call is async and a rejected tap is not worth
  // a frame's attention, but a silent rejection every time would be.
  impactFn(key).catch((err) => {
    tapticStatus.lastError = err?.message ?? String(err);
  });
}

/**
 * Play an authored CONFIG.feedback haptic on the Taptic Engine.
 *
 * @param spec  the same value playHaptic() and vibrate() are handed
 * @param scale the event's intensity multiplier, as feedback.js computes it
 */
export function taptic(spec, scale = 1) {
  if (!spec || !CONFIG.haptics?.enabled) return;
  if (cfg().enabled === false) return;
  if (!tapticAvailable()) return;
  if (!impactFn) { load(); return; }

  const gain = (CONFIG.haptics.intensity ?? 1) * rumbleScale() * scale;
  if (gain <= 0) return;

  const floor = cfg().floor ?? 0.2;
  const now = performance.now();

  for (const pulse of toPulses(spec)) {
    // `magnitude: null` is the legacy ms form, where length IS the intensity.
    const base = pulse.magnitude ?? magnitudeFromDuration(pulse.duration);
    const magnitude = Math.min(1, base * gain);
    if (magnitude < floor) { tapticStatus.skipped += 1; continue; }

    const delay = Math.max(0, pulse.delay ?? 0);
    if (delay === 0) {
      if (allowed(magnitude, now)) fire(magnitude);
      else tapticStatus.skipped += 1;
      continue;
    }
    // A later pulse is paced against the clock at the moment it actually
    // fires, not against the clock now — the bed it has to cut through is
    // whatever is playing then.
    const id = setTimeout(() => {
      pending.delete(id);
      if (allowed(magnitude, performance.now())) fire(magnitude);
      else tapticStatus.skipped += 1;
    }, delay);
    pending.add(id);
  }
}

/** Drop every scheduled tap — a run ending, or the app going to the background. */
export function stopTaptic() {
  for (const id of pending) clearTimeout(id);
  pending.clear();
}
