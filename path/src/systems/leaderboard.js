// The leaderboard is GLOBAL when a backend is configured and LOCAL otherwise.
//
// Both paths exist on purpose rather than one replacing the other: the game is
// developed against `vite dev` with no worker running, and a run that ends with
// an empty board and a network error is worse than one that ends with your own
// scores. So local storage stays the always-available baseline, the remote
// board is layered on top when VITE_LEADERBOARD_URL is set, and every remote
// failure falls back to local instead of surfacing as a broken menu.
//
// See server/leaderboard-worker.js for the other end.

const STORAGE_KEY = 'seal-survivor-leaderboard-v1';
const NAME_KEY = 'seal-survivor-player-name';
const MAX_ENTRIES = 10;
// Must match MAX_NAME_LEN in server/leaderboard-worker.js — the server is the
// authority and truncates anything longer, so raising it here alone would let
// players type a name the board then silently cuts.
const MAX_NAME_LEN = 24;

// Trailing slash trimmed so the URL works whether or not it was pasted with
// one. Empty/unset means "no backend" — checked via isGlobal() everywhere.
const REMOTE_URL = (import.meta.env?.VITE_LEADERBOARD_URL ?? '').replace(/\/+$/, '');

// A dead or slow backend must not hold the game-over menu hostage. Both calls
// abort at this point and fall through to the local board.
const REQUEST_TIMEOUT_MS = 6000;

export function isGlobal() {
  return REMOTE_URL.length > 0;
}

// ---------------------------------------------------------------------------
// Player name
// ---------------------------------------------------------------------------

// Remembered across runs so a returning player gets their name pre-filled
// instead of retyping it after every death.
export function loadPlayerName() {
  try {
    return sanitizeName(localStorage.getItem(NAME_KEY) ?? '');
  } catch {
    return '';
  }
}

export function savePlayerName(name) {
  const clean = sanitizeName(name);
  try {
    if (clean) localStorage.setItem(NAME_KEY, clean);
  } catch (err) {
    console.warn('[leaderboard] could not save name —', err?.message ?? err);
  }
  return clean;
}

// Mirrors the worker's cleanName so what you see in the input is what lands on
// the board — a name silently rewritten server-side reads as the game eating
// your input. Angle brackets and quotes go because these strings end up in
// innerHTML on the way back out.
export function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(/[<>&"'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trimStart()
    .slice(0, MAX_NAME_LEN);
}

export { MAX_NAME_LEN };

// ---------------------------------------------------------------------------
// Local board
// ---------------------------------------------------------------------------

export function loadLeaderboard() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[leaderboard] could not read saved scores —', err?.message ?? err);
    return [];
  }
}

// entry: { name, score, kills, level, time, date }. Returns the trimmed top-10
// plus this run's rank (1-based) if it made the cut.
export function submitScoreLocal(entry) {
  const list = loadLeaderboard();
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, MAX_ENTRIES);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[leaderboard] could not save scores —', err?.message ?? err);
  }

  const idx = trimmed.indexOf(entry);
  return { list: trimmed, rank: idx >= 0 ? idx + 1 : null, madeList: idx >= 0, global: false };
}

export function highScore() {
  const list = loadLeaderboard();
  return list.length ? list[0].score : 0;
}

export function clearLeaderboard() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[leaderboard] could not clear scores —', err?.message ?? err);
  }
}

// ---------------------------------------------------------------------------
// Global board
// ---------------------------------------------------------------------------

// Read-only fetch, used to show the standing board while the player is still
// typing their name. Resolves to null (not a rejection) when there's no
// backend or it can't be reached — callers treat that as "show local instead".
export async function fetchGlobalBoard() {
  if (!isGlobal()) return null;
  try {
    const res = await fetchWithTimeout(`${REMOTE_URL}/scores`, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.list) ? data.list : [];
  } catch (err) {
    console.warn('[leaderboard] could not load global board —', err?.message ?? err);
    return null;
  }
}

// The one call the game makes when a run ends. ALWAYS writes to the local board
// too, even when the remote write succeeds: local is what feeds the start
// menu's high score, and it's the only record that survives the backend going
// away. The returned result is the global one when the remote accepted it, and
// the local one otherwise, with `global` saying which the caller is showing.
export async function submitScore(entry) {
  const local = submitScoreLocal(entry);
  if (!isGlobal()) return local;

  try {
    const res = await fetchWithTimeout(`${REMOTE_URL}/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    if (!Array.isArray(data?.list)) throw new Error('malformed response');

    return {
      list: data.list,
      rank: data.rank ?? null,
      madeList: Boolean(data.madeList),
      global: true,
    };
  } catch (err) {
    console.warn('[leaderboard] global submit failed, kept local —', err?.message ?? err);
    return { ...local, error: true };
  }
}

function fetchWithTimeout(url, options) {
  // AbortSignal.timeout isn't in older Safari, which is squarely in this
  // game's audience (it's a touch-capable browser game), so the controller is
  // built by hand rather than assuming it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}
