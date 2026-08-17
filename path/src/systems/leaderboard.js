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
const MAX_ENTRIES = 10;

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
// Player name — MOVED OUT, to systems/playerName.js.
//
// It lived here for as long as the name was a leaderboard concern. It is now
// read by callouts.csv, quips.csv and upgrades.csv through the {player} token,
// and a text table importing the LEADERBOARD to find out what to call somebody
// would be an absurd dependency for one string. So the name has its own module
// and this file is one consumer of it, like the others.
//
// Deliberately NOT re-exported from here. A second door would mean two import
// paths to the same value, and the next person to add a name-shaped thing gets
// to pick the wrong one.
// ---------------------------------------------------------------------------

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
