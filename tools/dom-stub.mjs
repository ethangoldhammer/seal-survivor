// Minimum browser surface three.js's loaders touch at import time, so GLTF and
// FBX files can be read from a terminal script. Nothing here renders — the
// loaders only need these to exist, not to work.
globalThis.self = globalThis;
globalThis.window = globalThis;
// config.js registers a `pagehide` handler to persist tuning. Without these it
// finds a truthy `window`, takes the branch, and dies on a missing method —
// which is worse than the no-window case, where the guard simply skips it. Any
// listener registered here is deliberately dropped on the floor: a terminal
// script has no page to hide, and firing it would write the tuning file.
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.ProgressEvent = class {
  constructor(type, opts = {}) { Object.assign(this, opts); this.type = type; }
};
const stubEl = () => ({
  style: {},
  getContext: () => null,
  addEventListener() {},
  removeEventListener() {},
});
globalThis.document = { createElementNS: stubEl, createElement: stubEl };
