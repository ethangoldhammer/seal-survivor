// ---------------------------------------------------------------------------
// PLAYER SETTINGS — the pause menu's half of the config split.
//
// CONFIG is AUTHORED tuning: what the game is meant to feel like, edited
// through the ` panel and written back to imported-tuning.json so everyone
// who loads the build gets it. This file is the other thing entirely: what
// ONE player, on ONE machine, has asked for. The two must never share a home.
//
// That is not a stylistic preference, it is the only arrangement that works.
// saveTuning() snapshots whole CONFIG SECTIONS — `audio`, `bloom`, `render`,
// `haptics` are all in there — so a volume slider that wrote
// CONFIG.audio.masterVolume would be picked up by the next tuner edit, written
// into imported-tuning.json, committed, and shipped to everybody. And it would
// win: a saved value beats a config.js default outright. One player turning
// the music down would turn it down for the whole game, permanently, with
// nothing anywhere to say why.
//
// So NOTHING here writes to CONFIG. Every setting is a SCALE or an OVERRIDE
// applied at the point the authored value is consumed:
//
//   audio     master.gain = CONFIG.audio.masterVolume * sfxScale()
//   music     musicGain   = CONFIG.music.volume       * musicScale()
//   video     the pixel-ratio cap, the post preset and the bloom toggle
//   controls  key bindings, stick deadzone, rumble
//
// Turn every setting back to its default and the game is exactly the authored
// build again, because the scales are all 1 and the overrides all null.
//
// Storage is its own localStorage key, well away from the tuning cache, so
// clearing one never touches the other and a tuning reset does not silently
// restore someone's volume.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sealsurvivor.settings.v1';

// Actions that can be rebound. The ARROW KEYS are deliberately not in here:
// they are a fixed alternate for the four movement actions (see input.js), so
// there is always a way to move even if the bindings are rebound into a
// tangle, and the reset button is always reachable without a mouse.
export const ACTIONS = [
  { id: 'up', label: 'Swim up', alt: 'Arrow Up' },
  { id: 'down', label: 'Swim down', alt: 'Arrow Down' },
  { id: 'left', label: 'Swim left', alt: 'Arrow Left' },
  { id: 'right', label: 'Swim right', alt: 'Arrow Right' },
  { id: 'strike', label: 'Charge strike', alt: 'Mouse / bumper' },
  { id: 'pause', label: 'Pause', alt: 'Start' },
];

// Keys nothing may be bound to. Escape has to stay a way OUT of the rebinding
// prompt itself, and the rest are already spoken for by the browser or by the
// name box on the score screen.
const RESERVED_KEYS = new Set(['tab', 'enter', 'f5', 'f11', 'f12']);

export const FILTER_OPTIONS = ['off', 'crt', 'vhs', 'vga', 'arcade'];

// The whole surface, declared once. The pause menu is BUILT from this rather
// than hand-listing controls, so a setting added here appears in the menu, is
// clamped on load and is covered by the round-trip test without three separate
// edits that could disagree with each other.
export const SCHEMA = {
  audio: {
    label: 'Audio',
    items: [
      { key: 'master', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'sfx', label: 'Sound effects', type: 'range', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'music', label: 'Music', type: 'range', min: 0, max: 1, step: 0.05, def: 1 },
      { key: 'muted', label: 'Mute everything', type: 'bool', def: false, hint: 'M' },
    ],
  },
  video: {
    label: 'Video',
    items: [
      // A FRACTION of the authored cap (CONFIG.render.pixelRatio), not an
      // absolute ratio. Authoring may decide the game should never ask for
      // more than 2x on any display; this lets a player who cannot hold the
      // frame rate ask for less than that, without being able to overrule the
      // ceiling by typing a bigger number.
      {
        key: 'resolution', label: 'Resolution', type: 'range', min: 0.5, max: 1, step: 0.05, def: 1,
        format: (v) => `${Math.round(v * 100)}%`,
        hint: 'Lower this first if the frame rate struggles',
      },
      // null = whatever the build ships with. Only a deliberate pick pins it,
      // so changing the authored preset still reaches players who never opened
      // this menu.
      { key: 'filter', label: 'Screen filter', type: 'choice', options: FILTER_OPTIONS, def: null, hint: 'P' },
      { key: 'bloom', label: 'Bloom', type: 'boolOrNull', def: null },
      {
        key: 'shake', label: 'Screen shake', type: 'range', min: 0, max: 1, step: 0.05, def: 1,
        format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`),
      },
    ],
  },
  hud: {
    label: 'HUD',
    items: [
      // WHERE THE TWO GAUGES LIVE, and the only setting in this file that is a
      // taste question rather than an accessibility or a performance one.
      //
      //   corner  THE DEFAULT. Pinned to the bottom right of the screen: always
      //           in the same place, never behind a creature, never moving, and
      //           the only placement with room to show a rising MAXIMUM — the
      //           column grows up the side of the screen as the seal's health
      //           and lungs do, which beside the animal there is nowhere to put.
      //   seal    They ride beside the animal, which is where your eyes already
      //           are during a fight — nothing to look away at, at the cost of a
      //           read that moves and a fixed size.
      //
      // Neither is the "advanced" option, which is why this is a setting and
      // not a decision. The default is the corner because it is the one that
      // stays legible in the worst moment — a crowded screen, a boss on top of
      // the animal — and because the growth it shows is otherwise invisible.
      {
        key: 'barPlacement', label: 'Health & air bars', type: 'choice',
        options: ['corner', 'seal'], def: 'corner',
        labels: { seal: 'Beside the seal', corner: 'Bottom right' },
        hint: 'Where the two gauges are drawn',
      },
      // WHAT SHAPE THE BOOST FUEL IS, and it is only the FUEL that moves.
      //
      //   bar   THE DEFAULT. The pips as a vertical column beside the air
      //         gauge, so every meter in the game stacks in one place and
      //         nothing is drawn over the animal you are trying to aim. It
      //         also inherits the corner placement's one good idea: the
      //         column GROWS as a link cuts the bar into more pips, which
      //         around the seal is a fixed circle with thinner segments.
      //   ring  The pip wheel around the seal (systems/strikeRing.js): the
      //         count is where your eyes already are, and the fuel, the banked
      //         power and the chain window are one instrument in one place.
      //
      // THE GOO STAYS ON THE SEAL EITHER WAY. Banked power is the thing the
      // seal is holding, not a quantity in a corner, and the bubble growing
      // out of the animal is the only cue that a wind-up is worth anything —
      // see the note at the head of systems/strikeRing.js. This setting moves
      // the pips and nothing else.
      {
        key: 'boostMeter', label: 'Boost meter', type: 'choice',
        options: ['bar', 'ring'], def: 'bar',
        labels: { ring: 'Ring on the seal', bar: 'Beside the air' },
        hint: 'How the strike fuel is drawn',
      },
    ],
  },
  controls: {
    label: 'Controls',
    items: [
      { key: 'keys', label: 'Key bindings', type: 'keys', def: { up: 'w', down: 's', left: 'a', right: 'd', strike: ' ', pause: 'escape' } },
      {
        key: 'deadzone', label: 'Stick deadzone', type: 'range', min: 0.02, max: 0.4, step: 0.01, def: 0.15,
        format: (v) => v.toFixed(2),
        hint: 'Raise it if the seal drifts with the stick centred',
      },
      { key: 'vibration', label: 'Controller vibration', type: 'bool', def: true },
      {
        key: 'rumble', label: 'Vibration strength', type: 'range', min: 0, max: 1.5, step: 0.05, def: 1,
        format: (v) => `${Math.round(v * 100)}%`,
      },
    ],
  },
};

function defaults() {
  const out = {};
  for (const [section, def] of Object.entries(SCHEMA)) {
    out[section] = {};
    for (const item of def.items) {
      // Structured clone of the object-valued defaults (the bindings), or the
      // DEFAULT ITSELF would be the live object and a rebind would edit it —
      // making "reset to defaults" hand back whatever it was last changed to.
      out[section][item.key] = item.type === 'keys' ? { ...item.def } : item.def;
    }
  }
  return out;
}

function itemFor(section, key) {
  return SCHEMA[section]?.items.find((i) => i.key === key) ?? null;
}

// One value, validated against its own schema entry. Anything unrecognisable
// falls back to the default rather than being stored: this reads from
// localStorage, which is user-writable and survives across versions, and a
// NaN reaching a GainNode is silence with no error anywhere.
function coerce(item, value) {
  if (value == null) {
    // Only the tri-state entries are allowed to BE null — for the rest, null
    // is a missing key from an older snapshot.
    //
    // A `choice` falls through to its own default, which for `filter` IS null
    // ("whatever the build ships") and for an ordinary enum like barPlacement
    // is a real value. Returning null for every choice, as this used to, meant
    // a setting added later could never state a default it would actually get
    // back after a reload.
    return item.type === 'boolOrNull' ? null : item.def;
  }
  switch (item.type) {
    case 'range': {
      const n = Number(value);
      if (!Number.isFinite(n)) return item.def;
      return Math.min(item.max, Math.max(item.min, n));
    }
    case 'bool':
      return !!value;
    case 'boolOrNull':
      return typeof value === 'boolean' ? value : null;
    case 'choice':
      return item.options.includes(value) ? value : item.def;
    case 'keys': {
      if (typeof value !== 'object') return { ...item.def };
      const out = { ...item.def };
      for (const action of Object.keys(item.def)) {
        const k = value[action];
        if (typeof k === 'string' && k && !RESERVED_KEYS.has(k)) out[action] = k;
      }
      return out;
    }
    default:
      return item.def;
  }
}

// The live settings. Exported as a plain object read directly by the systems
// that consume it — a getter per field would be a lot of ceremony for values
// read once per frame at most.
export const settings = defaults();

const listeners = new Set();

/** Notified after any change, with the 'section.key' that moved ('*' on a reset). */
export function onSettingsChanged(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(path) {
  for (const cb of listeners) {
    try {
      cb(path);
    } catch (err) {
      // One bad listener must not stop the others — half-applied settings are
      // worse than none, because the menu would then disagree with the game.
      console.warn('[settings] listener threw —', err?.message ?? err);
    }
  }
}

export function loadSettings() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch (err) {
    // Two cases, and both end the same way. Storage blocked (private browsing,
    // a sandboxed frame) is silent — it is not worth a warning on every boot
    // in a context that can never save anyway. Unreadable JSON is not: it
    // means settings the player DID choose have just been discarded.
    if (err instanceof SyntaxError) {
      console.warn('[settings] saved settings were unreadable, using defaults —', err.message);
    }
  }
  // Every field is written on every path, including the failure paths, so this
  // always lands on a fully-specified state. Returning early on bad input
  // instead would leave whatever happened to be in `settings` already — which
  // is the defaults at boot, but is NOT the defaults on any later call, and
  // "load" would then mean two different things depending on when it ran.
  for (const [section, def] of Object.entries(SCHEMA)) {
    for (const item of def.items) {
      settings[section][item.key] = coerce(item, parsed?.[section]?.[item.key]);
    }
  }
  return settings;
}

// Writes are coalesced: dragging a volume slider fires a change per frame, and
// each one would otherwise be a synchronous JSON serialise plus a storage
// write on the same thread as the render loop.
let saveTimer = null;

export function saveSettings({ immediate = false } = {}) {
  if (saveTimer) clearTimeout(saveTimer);
  const write = () => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      console.warn('[settings] could not save —', err?.message ?? err);
    }
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 250);
}

/**
 * Change one setting. `path` is 'section.key'.
 * Returns the value actually stored, which may be clamped.
 */
export function setSetting(path, value) {
  const [section, key] = path.split('.');
  const item = itemFor(section, key);
  if (!item) {
    console.warn(`[settings] no such setting: ${path}`);
    return undefined;
  }
  const next = coerce(item, value);
  settings[section][key] = next;
  saveSettings();
  notify(path);
  return next;
}

/** Reset one section, or everything when called bare. */
export function resetSettings(section = null) {
  const fresh = defaults();
  for (const name of Object.keys(SCHEMA)) {
    if (section && name !== section) continue;
    settings[name] = fresh[name];
  }
  saveSettings({ immediate: true });
  notify(section ? `${section}.*` : '*');
}

// --- rebinding --------------------------------------------------------------

/** Normalised form of a KeyboardEvent.key, which is what bindings are stored as. */
export function normaliseKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/** Human-readable name for a stored binding — ' ' has to read as something. */
export function keyLabel(key) {
  if (!key) return '—';
  if (key === ' ') return 'Space';
  if (key.startsWith('arrow')) return `Arrow ${key.slice(5, 6).toUpperCase()}${key.slice(6)}`;
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** True when this key can be bound at all. */
export function isBindable(key) {
  const k = normaliseKey(key);
  return !!k && !RESERVED_KEYS.has(k);
}

/**
 * Bind `key` to `action`. If another action already holds that key the two
 * SWAP rather than the old one being left dead — a binding screen that can
 * silently unbind "swim up" is a binding screen that can strand the player.
 *
 * Returns false (changing nothing) if the key isn't bindable.
 */
export function bindKey(action, key) {
  const k = normaliseKey(key);
  if (!isBindable(k)) return false;
  const keys = { ...settings.controls.keys };
  if (!(action in keys)) return false;
  const previous = keys[action];
  for (const other of Object.keys(keys)) {
    if (other !== action && keys[other] === k) keys[other] = previous;
  }
  keys[action] = k;
  setSetting('controls.keys', keys);
  return true;
}

/** Which action a pressed key drives, or null. Case-folded on the way in. */
export function actionForKey(key) {
  const k = normaliseKey(key);
  if (!k) return null;
  const keys = settings.controls.keys;
  for (const action of Object.keys(keys)) {
    if (keys[action] === k) return action;
  }
  return null;
}

// --- derived values, read by the systems ------------------------------------
// Each one folds mute in where mute should apply, so no caller has to remember
// to check it separately.

/** Multiplier over CONFIG.audio.masterVolume. */
export function sfxScale() {
  const a = settings.audio;
  return a.muted ? 0 : a.master * a.sfx;
}

/** Multiplier over CONFIG.music.volume. */
export function musicScale() {
  const a = settings.audio;
  return a.muted ? 0 : a.master * a.music;
}

/** Multiplier over the authored pixel-ratio cap. */
export function resolutionScale() {
  return settings.video.resolution;
}

/** Multiplier over every camera shake. */
export function shakeScale() {
  return settings.video.shake;
}

/** Multiplier over every rumble magnitude — 0 when vibration is off. */
export function rumbleScale() {
  return settings.controls.vibration ? settings.controls.rumble : 0;
}

/** Stick deadzone, replacing the built-in constant. */
export function stickDeadzone() {
  return settings.controls.deadzone;
}

/**
 * Where the health and air gauges are drawn: 'seal' or 'corner'.
 *
 * Resolved through a function rather than read off `settings` directly so the
 * null a corrupted localStorage snapshot can still produce lands on the
 * default here, once, instead of reaching the DOM as a class name of "null".
 */
export function barPlacement() {
  // Written as "anything that is not the opt-out is the default", so the null a
  // corrupted snapshot can still hold lands on the shipped placement rather
  // than on whichever branch happens to be first.
  return settings.hud.barPlacement === 'seal' ? 'seal' : 'corner';
}

/**
 * Which shape the STRIKE FUEL is drawn in: 'bar' (a pip column beside the air
 * gauge, which is what ships) or 'ring' (the pip wheel around the seal).
 *
 * Same "anything that is not the opt-out is the default" reading as
 * barPlacement above, for the same reason: a corrupted snapshot must land on
 * the shipped instrument rather than on whichever branch is written first.
 * Note that this flipped once — the wheel was the default first — which is
 * exactly why it is written this way round rather than as an equality against
 * the value that happens to ship today.
 *
 * Read live by BOTH views — ui/ui.js decides whether to draw the column and
 * systems/strikeRing.js decides whether to draw the wheel — off one function
 * so the two can never both be on, or both be off, for a frame.
 */
export function boostMeter() {
  return settings.hud.boostMeter === 'ring' ? 'ring' : 'bar';
}

/**
 * The post preset to run, given whatever the build ships with. A player who
 * has never touched the setting gets the authored one, including after it
 * changes in a later build.
 */
export function screenFilter(authored) {
  const chosen = settings.video.filter;
  return chosen && FILTER_OPTIONS.includes(chosen) ? chosen : authored;
}

/** Same tri-state for bloom. */
export function bloomEnabled(authored) {
  return settings.video.bloom == null ? authored : settings.video.bloom;
}

// Loaded on IMPORT, not from boot(). world.js reads resolutionScale() while
// building the renderer, which happens at main.js's module scope — a load call
// sequenced inside boot() would land after that, and the first frame would be
// rendered at the wrong resolution until something else happened to re-apply
// it. CONFIG does the same thing with its tuning merge, for the same reason.
loadSettings();
