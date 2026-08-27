// ============================================================================
// STEAMWORKS — achievements, cloud and the overlay's opinion of us.
//
// ---------------------------------------------------------------------------
// THIS FILE IS DELIBERATELY INERT UNTIL THERE IS AN APP ID.
//
// Seal Survivor has no Steamworks app yet, so SEAL_STEAM_APP_ID is unset and
// everything below answers "not available". That is not a stub — it is the
// permanent behaviour for every launch outside Steam, which includes every
// launch during development and every time a player runs the .app directly.
// The game must be completely playable in that state, so nothing here is ever
// allowed to be load-bearing.
//
// 480 IS NOT USED AS A DEFAULT. It is Spacewar, Valve's public test app, and it
// does work for local development — but defaulting to it would mean a build
// that silently reports achievements to somebody else's app if the real id were
// ever missing from the environment. Opt in with SEAL_STEAM_APP_ID=480 when you
// want to exercise this against a running Steam client.
//
// ---------------------------------------------------------------------------
// WHY THE IMPORT IS DYNAMIC AND WRAPPED.
//
// steamworks.js is a NATIVE module. It fails in three quite different ways and
// none of them may take the game down:
//
//   NOT INSTALLED          a dev checkout that skipped optional deps.
//   WRONG BINARY           a prebuilt that does not match this platform/arch,
//                          which throws at require time, not at call time.
//   STEAM NOT RUNNING      init() throws rather than returning false. This is
//                          the common case: launching the built app directly
//                          instead of through the Steam client.
//
// ---------------------------------------------------------------------------
// ACHIEVEMENTS ARE NOT DEFINED HERE. There is no roster, and there should not
// be one in this file: an achievement's name and description are player-facing
// copy, and its unlock condition is game design. This exposes the mechanism
// (unlock by API name) and nothing else. The names come from the Steamworks
// partner site, and the roster is Ethan's to write.
// ============================================================================

import { ipcMain } from 'electron';

let client = null;
let status = 'uninitialised';

/** The app id to run under, or null to stay switched off. */
function appId() {
  const raw = process.env.SEAL_STEAM_APP_ID;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Bring up Steamworks if we can. Safe to call always; never throws.
 *
 * @returns true if the client is live, false in every other case.
 */
export async function initSteam() {
  const id = appId();
  if (!id) {
    status = 'no app id — set SEAL_STEAM_APP_ID to switch this on';
    return false;
  }
  try {
    const steamworks = await import('steamworks.js');
    // The module's shape differs between CJS interop paths, so both are tried
    // rather than assuming — a wrong guess here is a TypeError at launch.
    const api = steamworks.default ?? steamworks;
    client = api.init(id);
    status = `ready — ${client.localplayer.getName()} (app ${id})`;
    return true;
  } catch (err) {
    // The overwhelmingly common cause is simply that Steam is not running.
    client = null;
    status = `unavailable — ${err?.message ?? err}`;
    return false;
  }
}

export function steamAvailable() {
  return !!client;
}

export function steamStatus() {
  return status;
}

/**
 * Unlock an achievement by its Steamworks API name.
 *
 * @returns true only if Steam accepted it. False covers "no Steam", "no such
 *          achievement" and "already unlocked" alike, because none of them is
 *          something the game should react to differently — an achievement is
 *          a notification, not a mechanic, and a run must never branch on it.
 */
export function unlockAchievement(name) {
  if (!client || typeof name !== 'string' || !name) return false;
  try {
    const achievement = client.achievement;
    if (!achievement?.activate) return false;
    return !!achievement.activate(name);
  } catch (err) {
    console.warn(`[steam] could not unlock ${name} — ${err?.message ?? err}`);
    return false;
  }
}

export function registerSteamIpc() {
  // Read by the renderer through the preload so the game can know whether it is
  // running under Steam at all — which matters for exactly one thing today: the
  // share text in systems/bossShot.js should name the store page rather than
  // the web build's URL.
  ipcMain.handle('seal-steam:status', () => ({
    available: steamAvailable(),
    status: steamStatus(),
  }));

  ipcMain.handle('seal-steam:achieve', (_event, name) => unlockAchievement(name));
}
