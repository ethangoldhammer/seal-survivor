import {
  getAssetMaterials, setAssetTexture, setAssetTint, setAssetRepeat, hasCustomTexture,
  setAssetEmissive, setAssetGlow, supportsEmissive, setAssetSizeMultiplier,
  loadUploadedAsset, isSpriteFile, setAssetEmissiveMask, assetEmissiveMaskState,
} from '../assets.js';
import { saveModelToDB, loadModelFromDB, deleteModelFromDB } from '../systems/modelStorage.js';
import { CONFIG, TUNER_SCHEMA, saveTuningToStorage, applyUpgradeOverrides } from '../config.js';
import { buildTunerGroups, buildExpandAllToggle } from './tunerControls.js';
import { isTypingTarget } from './typing.js';
import { playSfx, unlockAudio, loadSampleFromFile, clearSample, hasSample, sampleCount, onSamplesChanged, reloadSample, getAudioContext, applyAudioBusSettings } from '../systems/audio.js';
import { describeHaptic, previewHaptic, testHaptic, hapticsAvailable } from '../systems/haptics.js';
import { uploadAsset } from '../systems/assetUpload.js';
import { emit } from '../entities/particles.js';
import { loadTrackFromFile, hasTrack, clearTrack, play as playMusic, stop as stopMusic, loopDuration, onTracksChanged } from '../systems/music.js';

// Curated rather than every ASSETS key: particles and the like are tiny FX
// that don't benefit from a texture, so they're left out to reduce clutter. Everything that swims — every companion, and every species with an
// entry in CONFIG.enemies — gets a row, because tint/emissive/glow are how you
// tell two creatures sharing one model apart, and a creature with no row here
// has no way to be recoloured at all.
const EDITABLE = [
  // --- the seal and its companions ---
  ['ship', 'Seal (ship)'],
  ['sealTeam', 'Seal team escort (ability)'],
  ['belugaDrone', 'Beluga (ability)'],
  ['eelCompanion', 'Eel companion (ability)'],
  ['seagull', 'Seagull bomb (ability)'],
  ['starfish', 'Starfish (ability)'],
  ['shrimp', 'Shrimp (ability, upload in main tuner)'],
  ['dumboOcto', 'Dumbo octopus (ability)'],
  // --- boats, pickups, projectiles ---
  ['boat', 'Boat'],
  ['trawler', 'Trawler'],
  ['bakalarBoat', "Bakalar's boat (ability)"],
  ['attractorOrb', 'Attractor orb'],
  ['xpOrb', 'Chum bit (XP pickup)'],
  ['bubbleOrb', 'Bubble (oxygen)'],
  ['strikeOrb', 'Strike orb'],
  ['rapidFireOrb', 'Rapid-fire orb'],
  ['trapBubble', 'Beluga bubble'],
  ['bullet', 'Bullet'],
  ['missile', 'Missile'],
  ['bounceShot', 'Bounce shot'],
  ['shrapnel', 'Strike shrapnel'],
  ['enemyBullet', 'Enemy bullet'],
  // --- predators ---
  ['enemyShark', 'Shark'],
  ['enemyGreatWhite', 'Great White'],
  ['enemyMegalodon', 'Megalodon'],
  ['enemyMightyMeg', 'Mighty Meg'],
  ['enemyOrca', 'Orca'],
  ['enemyBarracuda', 'Barracuda'],
  ['enemyOtter', 'Otter'],
  ['enemyDolphin', 'Dolphin'],
  // --- schooling prey ---
  ['enemyFish', 'Coral fish'],
  ['enemyTrout', 'Trout'],
  ['enemyTang', 'Tang'],
  ['enemyReeffish', 'Reef fish'],
  ['enemyFishPackA', 'Fish pack A'],
  ['enemyFishPackB', 'Fish pack B'],
  ['enemyFishPackC', 'Fish pack C'],
  // --- drifters, crawlers and traps ---
  ['enemyStingray', 'Stingray'],
  ['enemySeaTurtle', 'Sea turtle'],
  ['enemyWalkingCrab', 'Walking crab'],
  ['enemyAnimatedCrab', 'Animated crab'],
  ['enemyOyster', 'Oyster'],
];


const STYLES = `
  .sv-tex { position: fixed; top: 0; left: 0; bottom: 0; width: 300px; z-index: 30;
    background: rgba(10,12,18,0.94); border-right: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(10px); color: #e8ecf3; font-family: 'Inter', system-ui, sans-serif;
    display: flex; flex-direction: column; }
  .sv-tex.sv-hidden { display: none; }
  .sv-tex h2 { font-size: 13px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; margin: 0; }
  .sv-tex-head { padding: 16px 18px 0; flex-shrink: 0; }
  .sv-tex .sv-tex-note { font-size: 10px; color: rgba(232,236,243,0.4); margin: 6px 0 12px; line-height: 1.5; }
  /* Six tabs don't fit one 300px row, so they wrap into a 3x2 grid — with a
     full border and radius, since the "tab strip sitting on the body" look
     (no bottom border) only reads right as a single row. */
  .sv-tex-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 10px 0 8px; }
  .sv-tex-tab { padding: 6px 3px; font-size: 10px; font-weight: 600; text-align: center; cursor: pointer;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
    background: rgba(255,255,255,0.03); color: rgba(232,236,243,0.55);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-tex-tab.sv-tex-tab-active { background: rgba(122,215,255,0.12); color: #7ad7ff; border-color: rgba(122,215,255,0.4); }
  .sv-tex-body { flex: 1; overflow-y: auto; padding: 12px 18px 32px; }
  .sv-tex-panel { display: none; }
  .sv-tex-panel.sv-tex-panel-active { display: block; }
  .sv-tex-expand-row { display: flex; justify-content: flex-end; padding-bottom: 2px;
    border-bottom: 1px solid rgba(255,255,255,0.08); }
  .sv-tex-row { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .sv-tex-name { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .sv-tex-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.2); flex-shrink: 0; }
  .sv-tex-dot.sv-tex-active { background: #7ad7ff; }
  .sv-tex-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .sv-tex-controls input[type=file] { display: none; }
  .sv-tex-btn { font-size: 10px; font-weight: 600; padding: 5px 9px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.16);
    background: rgba(255,255,255,0.06); color: #e8ecf3; cursor: pointer; font-family: inherit; }
  .sv-tex-btn:hover { border-color: #7ad7ff; color: #7ad7ff; }
  .sv-tex-controls input[type=color] { width: 26px; height: 24px; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 5px; background: none; padding: 0; cursor: pointer; }
  .sv-tex-repeat { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
  .sv-tex-repeat label { font-size: 9px; color: rgba(232,236,243,0.5); width: 12px; }
  .sv-tex-repeat input[type=range] { flex: 1; accent-color: #7ad7ff; height: 14px; }
  .sv-tex-divider { border-top: 1px solid rgba(255,255,255,0.08); margin: 8px 0 6px; padding-top: 6px; }
  .sv-tex-glowrow { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .sv-tex-glowrow label { font-size: 9px; color: rgba(232,236,243,0.5); width: 46px; flex-shrink: 0; }
  .sv-tex-glowrow input[type=range] { flex: 1; accent-color: #ffb347; height: 14px; }
  .sv-tex-glowrow input[type=color] { width: 26px; height: 22px; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 5px; background: none; padding: 0; cursor: pointer; }
  .sv-tex-variant-name { font-size: 9px; color: rgba(232,236,243,0.45); flex-shrink: 0; min-width: 62px; text-align: right; }
  .sv-tex-upload-status { font-size: 9px; color: rgba(232,236,243,0.45); margin-top: 4px; line-height: 1.4; }
  .sv-up-text { flex: 1; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 3px 6px; font-size: 10px; min-width: 0; }
  .sv-tex-size-number { width: 54px; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 2px 5px; font-size: 10px; }

  .sv-sfx-row { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .sv-sfx-name { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
  .sv-sfx-type { font-size: 9px; color: rgba(232,236,243,0.4); text-transform: uppercase; letter-spacing: 0.05em; }
  .sv-sfx-field { display: flex; align-items: center; gap: 6px; margin-top: 5px; }
  /* One row per loaded sample variation, indented under the sample controls
     so it reads as belonging to them rather than as another field. */
  .sv-sfx-variations { margin: 4px 0 2px 50px; display: flex; flex-direction: column; gap: 3px; }
  .sv-sfx-variation { display: flex; align-items: center; gap: 5px; }
  .sv-sfx-variation-name { flex: 1; font-size: 9px; color: rgba(232,236,243,0.55);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-sfx-variation .sv-tex-btn { padding: 1px 6px; font-size: 10px; line-height: 1.4; }
  /* Wide enough for the longest field names ('noise mix', 'pitch var',
     'filt var') at this font size. Ellipsis rather than a hard clip so
     anything longer still degrades readably, with the full text on hover. */
  .sv-sfx-field label { font-size: 9px; color: rgba(232,236,243,0.5); width: 62px; flex-shrink: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-sfx-field input[type=range] { flex: 1; accent-color: #ffb347; height: 14px; }
  .sv-sfx-field select { flex: 1; background: rgba(255,255,255,0.06); color: #e8ecf3; font-family: inherit;
    border: 1px solid rgba(255,255,255,0.14); border-radius: 6px; padding: 4px 6px; font-size: 10px; }
  .sv-sfx-val { font-size: 9px; color: rgba(232,236,243,0.6); width: 44px; flex-shrink: 0;
    text-align: right; font-variant-numeric: tabular-nums; }
`;

let panel = null;
let upgradesPanelEl = null;
const rows = new Map();
const resetExtras = new Map();

// Refresh closures for every control in the Sound, Haptics and Particles tabs
// (see slider(), and the hand-built rows in buildHapticRow). These tabs build
// their own controls rather than going through TUNER_SCHEMA, so
// refreshTunerRows() in tunerControls.js does not know about them.
const texRows = [];

/**
 * Put the Sound, Haptics and Particles controls back in step with CONFIG.
 * Call after anything that rewrites CONFIG behind the panel's back — Reset and
 * importing a tuning file both do.
 */
export function refreshTexturePanelRows() {
  for (const fn of texRows) fn();
}

// Rebuild the Upgrades tab from CONFIG. Its inputs are populated once, when
// the panel is built, so anything that changes CONFIG.upgrades from outside
// (Reset, importing a tuning file) needs to say so — otherwise the table goes
// on showing values that are no longer in effect. The rows are pure CONFIG
// with no upload state, so throwing them away and rebuilding is safe.
export function refreshUpgradeTable() {
  if (!upgradesPanelEl) return;
  upgradesPanelEl.replaceChildren(buildUpgradeTable());
}

// `onTuningChanged` is the same handler the ` tuner uses — the Companions and
// Enemies tabs hold real tuner controls, so a slider there has to rebuild the
// grid or resize the camera exactly like it would on the other panel.
export function initTexturePanel(onAssetChanged, onTuningChanged) {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  panel = document.createElement('div');
  panel.className = 'sv-tex sv-hidden';
  panel.innerHTML = `
    <div class="sv-tex-head">
      <h2>Look &amp; Sound</h2>
      <div class="sv-tex-note">Everything that lives in the ocean: models and textures, companion abilities, enemy behaviour and spawns, upgrade cards, sound and particles. Press T to toggle, \` for the rest of the tuning.</div>
      <div class="sv-tex-tabs">
        <div class="sv-tex-tab sv-tex-tab-active" data-tab="creatures">Models</div>
        <div class="sv-tex-tab" data-tab="companions">Companions</div>
        <div class="sv-tex-tab" data-tab="enemies">Enemies</div>
        <div class="sv-tex-tab" data-tab="upgrades">Upgrades</div>
        <div class="sv-tex-tab" data-tab="sound">Sound</div>
        <div class="sv-tex-tab" data-tab="haptics">Haptics</div>
        <div class="sv-tex-tab" data-tab="particles">Particles</div>
      </div>
    </div>
    <div class="sv-tex-body">
      <div class="sv-tex-panel sv-tex-panel-active" id="svTexPanelCreatures"></div>
      <div class="sv-tex-panel" id="svTexPanelCompanions"></div>
      <div class="sv-tex-panel" id="svTexPanelEnemies"></div>
      <div class="sv-tex-panel" id="svTexPanelUpgrades"></div>
      <div class="sv-tex-panel" id="svTexPanelSound"></div>
      <div class="sv-tex-panel" id="svTexPanelHaptics"></div>
      <div class="sv-tex-panel" id="svTexPanelParticles"></div>
    </div>
  `;
  document.body.appendChild(panel);

  const creaturesPanel = panel.querySelector('#svTexPanelCreatures');
  for (const [key, label] of EDITABLE) {
    const row = buildCreatureRow(key, label, onAssetChanged);
    creaturesPanel.appendChild(row.el);
    rows.set(key, row);
  }

  const soundPanel = panel.querySelector('#svTexPanelSound');
  soundPanel.appendChild(buildBusRow());
  soundPanel.appendChild(buildMusicRow());
  for (const name of Object.keys(CONFIG.sfx)) {
    soundPanel.appendChild(buildSfxRow(name));
  }

  const hapticsPanel = panel.querySelector('#svTexPanelHaptics');
  buildHapticsPanel(hapticsPanel);

  const particlesPanel = panel.querySelector('#svTexPanelParticles');
  for (const name of Object.keys(CONFIG.emitters)) {
    particlesPanel.appendChild(buildEmitterRow(name));
  }

  upgradesPanelEl = panel.querySelector('#svTexPanelUpgrades');
  upgradesPanelEl.appendChild(buildUpgradeTable());

  // The ability and enemy groups that used to sit in the ` panel's flat
  // scroll. Filtered by tag rather than listed here, so moving a group between
  // panels is a one-line change in TUNER_SCHEMA and can't leave it homeless.
  for (const [tag, id, blurb] of [
    ['companions', '#svTexPanelCompanions',
      'Every ability that fights alongside you — orbit, reach, damage and cooldown. Which upgrade card grants each one is on the Upgrades tab; its model and colour are on Models.'],
    ['enemies', '#svTexPanelEnemies',
      'What spawns, how often, how early, and how it behaves. Set a spawn rate to 0 to switch a creature off entirely.'],
  ]) {
    const el = panel.querySelector(id);
    const note = document.createElement('div');
    note.className = 'sv-tex-upload-status';
    note.style.marginBottom = '4px';
    note.textContent = blurb;
    el.appendChild(note);

    // Same collapsed-by-default groups as the ` panel, with the same
    // open-everything escape hatch above them.
    const groupsEl = document.createElement('div');
    groupsEl.appendChild(buildTunerGroups(TUNER_SCHEMA.filter((g) => g.panel === tag), onTuningChanged));

    const expandAll = document.createElement('div');
    expandAll.className = 'sv-tex-expand-row';
    expandAll.appendChild(buildExpandAllToggle(groupsEl));
    el.append(expandAll, groupsEl);
  }

  const tabPanelIds = {
    creatures: 'svTexPanelCreatures',
    companions: 'svTexPanelCompanions',
    enemies: 'svTexPanelEnemies',
    upgrades: 'svTexPanelUpgrades',
    sound: 'svTexPanelSound',
    haptics: 'svTexPanelHaptics',
    particles: 'svTexPanelParticles',
  };
  for (const tab of panel.querySelectorAll('.sv-tex-tab')) {
    tab.addEventListener('click', () => {
      for (const t of panel.querySelectorAll('.sv-tex-tab')) t.classList.remove('sv-tex-tab-active');
      for (const p of panel.querySelectorAll('.sv-tex-panel')) p.classList.remove('sv-tex-panel-active');
      tab.classList.add('sv-tex-tab-active');
      panel.querySelector(`#${tabPanelIds[tab.dataset.tab]}`).classList.add('sv-tex-panel-active');
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 't' && !isTypingTarget(e.target)) {
      panel.classList.toggle('sv-hidden');
    }
  });
}

// Re-push every stored look value onto whatever materials the asset
// currently has. Safe to call any time; used after a model swap replaces
// the material instances the look was originally applied to.
function reapplyLook(key, look) {
  if (!look) return;
  if (look.tint != null) setAssetTint(key, look.tint);
  if (look.emissive != null) setAssetEmissive(key, look.emissive);
  if (look.glow != null && look.glow !== 1) setAssetGlow(key, look.glow);
  if (look.repeatX !== 1 || look.repeatY !== 1) setAssetRepeat(key, look.repeatX, look.repeatY);
  if (look.sizeMultiplier !== 1) setAssetSizeMultiplier(key, look.sizeMultiplier);
  // Explicit choices only — null means "follow the global", and re-pushing it
  // would pin the model to whatever the global happened to be at the time.
  if (look.emissiveMask != null) setAssetEmissiveMask(key, look.emissiveMask);
}

function lookState(key) {
  if (!CONFIG.assetLooks[key]) {
    CONFIG.assetLooks[key] = {
      tint: null, emissive: null,
      repeatX: 1, repeatY: 1, sizeMultiplier: 1, glow: 1,
      // null = follow CONFIG.glow.emissiveMaps; true/false = this model
      // overrides it. See setAssetEmissiveMask.
      emissiveMask: null,
    };
  }
  return CONFIG.assetLooks[key];
}

function buildCreatureRow(key, label, onAssetChanged) {
  const look = lookState(key);

  const el = document.createElement('div');
  el.className = 'sv-tex-row';

  const nameRow = document.createElement('div');
  nameRow.className = 'sv-tex-name';
  const dot = document.createElement('span');
  dot.className = 'sv-tex-dot';
  const nameText = document.createElement('span');
  nameText.textContent = label;
  nameRow.append(dot, nameText);

  const controls = document.createElement('div');
  controls.className = 'sv-tex-controls';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'sv-tex-btn';
  uploadBtn.textContent = 'Upload';
  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const THREE = await import('three');
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      setAssetTexture(key, tex);
      dot.classList.add('sv-tex-active');
      // Uploaded images aren't saved across reloads — an image can be
      // hundreds of KB to several MB, and localStorage's quota (usually
      // 5-10MB total) wouldn't survive more than one or two of these.
      // Everything else on this row (tint/emissive/glow/roughness/size/
      // variant) DOES persist.
    } catch (err) {
      console.warn(`[textures] failed to load uploaded image for "${key}"`, err?.message ?? err);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  const tint = document.createElement('input');
  tint.type = 'color';
  tint.title = 'Tint';
  tint.value = look.tint != null ? `#${look.tint.toString(16).padStart(6, '0')}` : '#ffffff';
  tint.addEventListener('input', () => {
    const hex = parseInt(tint.value.slice(1), 16);
    look.tint = hex;
    setAssetTint(key, hex);
    saveTuningToStorage();
  });
  if (look.tint != null) setAssetTint(key, look.tint);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'sv-tex-btn';
  resetBtn.textContent = 'Reset';

  controls.append(fileInput, uploadBtn, tint, resetBtn);

  const repeatRow = document.createElement('div');
  repeatRow.className = 'sv-tex-repeat';
  const lx = document.createElement('label');
  lx.textContent = 'X';
  const repeatX = document.createElement('input');
  repeatX.type = 'range';
  repeatX.min = '0.2'; repeatX.max = '6'; repeatX.step = '0.1'; repeatX.value = look.repeatX;
  const ly = document.createElement('label');
  ly.textContent = 'Y';
  const repeatY = document.createElement('input');
  repeatY.type = 'range';
  repeatY.min = '0.2'; repeatY.max = '6'; repeatY.step = '0.1'; repeatY.value = look.repeatY;
  const syncRepeat = () => {
    look.repeatX = Number(repeatX.value);
    look.repeatY = Number(repeatY.value);
    setAssetRepeat(key, look.repeatX, look.repeatY);
    saveTuningToStorage();
  };
  repeatX.addEventListener('input', syncRepeat);
  repeatY.addEventListener('input', syncRepeat);
  repeatRow.append(lx, repeatX, ly, repeatY);
  if (look.repeatX !== 1 || look.repeatY !== 1) setAssetRepeat(key, look.repeatX, look.repeatY);

  el.append(nameRow, controls, repeatRow);

  // Emissive colour / glow / roughness — a flat-colour alternative to
  // uploading a texture. Only shown for materials that support it.
  // Glow applies to EVERY material now — lit ones via emissiveIntensity,
  // unlit ones (all the orbs, bullets and procedural shapes) via HDR colour
  // overdrive — so it's always shown rather than hidden on unlit assets.
  // Emissive colour still only exists on lit materials. Roughness and the
  // variant cycler were removed.
  let emissiveSwatch = null, glowSlider = null;
  {
    const divider = document.createElement('div');
    divider.className = 'sv-tex-divider';
    el.append(divider);

    if (supportsEmissive(key)) {
      const emissiveRow = document.createElement('div');
      emissiveRow.className = 'sv-tex-glowrow';
      const emissiveLabel = document.createElement('label');
      emissiveLabel.textContent = 'Emissive';
      emissiveSwatch = document.createElement('input');
      emissiveSwatch.type = 'color';
      emissiveSwatch.value = look.emissive != null ? `#${look.emissive.toString(16).padStart(6, '0')}` : '#000000';
      emissiveSwatch.addEventListener('input', () => {
        const hex = parseInt(emissiveSwatch.value.slice(1), 16);
        look.emissive = hex;
        setAssetEmissive(key, hex);
        saveTuningToStorage();
      });
      emissiveRow.append(emissiveLabel, emissiveSwatch);
      el.append(emissiveRow);
      if (look.emissive != null) setAssetEmissive(key, look.emissive);
    }

    const glowRow = document.createElement('div');
    glowRow.className = 'sv-tex-glowrow';
    const glowLabel = document.createElement('label');
    glowLabel.textContent = 'Glow';
    glowSlider = document.createElement('input');
    glowSlider.type = 'range';
    glowSlider.min = '0'; glowSlider.max = '8'; glowSlider.step = '0.05';
    glowSlider.value = look.glow ?? 1;
    const glowVal = document.createElement('span');
    glowVal.className = 'sv-tex-variant-name';
    glowVal.textContent = `${Number(glowSlider.value).toFixed(2)}x`;
    glowSlider.addEventListener('input', () => {
      look.glow = Number(glowSlider.value);
      setAssetGlow(key, look.glow);
      glowVal.textContent = `${look.glow.toFixed(2)}x`;
      saveTuningToStorage();
    });
    glowRow.append(glowLabel, glowSlider, glowVal);
    el.append(glowRow);
    if (look.glow != null && look.glow !== 1) setAssetGlow(key, look.glow);

    // Per-model glow source. Only shown for models that actually ship a mask
    // in public/textures/emissive — for everything else there is nothing to
    // choose between, and the row would be a dead control implying otherwise.
    //
    // Three states, cycled by the button rather than a checkbox, because
    // "follow the global" is a real and useful state that a two-state control
    // cannot express: a checkbox would silently pin every model the first
    // time you touched it.
    const maskState = assetEmissiveMaskState(key);
    if (maskState.has) {
      const maskRow = document.createElement('div');
      maskRow.className = 'sv-tex-glowrow';
      const maskLabel = document.createElement('label');
      maskLabel.textContent = 'Mask';
      const maskBtn = document.createElement('button');
      maskBtn.type = 'button';
      maskBtn.className = 'sv-tex-btn';
      maskBtn.title = 'Where this model\'s glow comes from. Auto follows the global '
        + '"glow from emissive masks" toggle; Masked and Uniform override it for this model only.';
      const paint = () => {
        const st = assetEmissiveMaskState(key);
        maskBtn.textContent = look.emissiveMask == null
          ? `Auto (${st.on ? 'masked' : 'uniform'})`
          : (look.emissiveMask ? 'Masked' : 'Uniform');
      };
      maskBtn.addEventListener('click', () => {
        // null -> true -> false -> null
        look.emissiveMask = look.emissiveMask == null ? true : (look.emissiveMask ? false : null);
        setAssetEmissiveMask(key, look.emissiveMask);
        paint();
        saveTuningToStorage();
      });
      paint();
      maskRow.append(maskLabel, maskBtn);
      el.append(maskRow);
      if (look.emissiveMask != null) setAssetEmissiveMask(key, look.emissiveMask);
    }
  }


  // Size — a runtime scale multiplier. Applies to future spawns; anything
  // already on screen keeps its current size (same as the model-upload
  // limitation below it, both are tuning tools, not a retroactive resize).
  const sizeDivider = document.createElement('div');
  sizeDivider.className = 'sv-tex-divider';
  const sizeRow = document.createElement('div');
  sizeRow.className = 'sv-tex-glowrow';
  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'Size';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.min = '0.02'; sizeSlider.max = '25'; sizeSlider.step = '0.02'; sizeSlider.value = look.sizeMultiplier;
  // A pure slider across a 0.02-25 range is too imprecise for fine control
  // near 1x (most of the travel ends up dedicated to the extreme tail) — a
  // direct number input alongside it gives exact values regardless.
  const sizeNumber = document.createElement('input');
  sizeNumber.type = 'number';
  sizeNumber.min = '0.001'; sizeNumber.step = '0.01';
  sizeNumber.value = look.sizeMultiplier;
  sizeNumber.className = 'sv-tex-size-number';
  const sizeVal = document.createElement('span');
  sizeVal.className = 'sv-tex-variant-name';
  sizeVal.textContent = '(new spawns)';
  const applySize = (v) => {
    look.sizeMultiplier = v;
    setAssetSizeMultiplier(key, v);
    sizeSlider.value = Math.min(25, Math.max(0.02, v));
    sizeNumber.value = v;
    saveTuningToStorage();
    onAssetChanged?.(key);
  };
  sizeSlider.addEventListener('input', () => applySize(Number(sizeSlider.value)));
  sizeNumber.addEventListener('change', () => {
    const v = Number(sizeNumber.value);
    if (Number.isFinite(v) && v > 0) applySize(v);
  });
  sizeRow.append(sizeLabel, sizeSlider, sizeNumber, sizeVal);
  if (look.sizeMultiplier !== 1) setAssetSizeMultiplier(key, look.sizeMultiplier);

  // 3D model / 2D sprite upload — replaces this asset's mesh with an uploaded
  // .glb / .gltf / .fbx, or with a flat quad cut to an uploaded image's aspect
  // ratio. Saved to IndexedDB (not localStorage — a model is megabytes, well
  // past that quota) and restored automatically on the next load.
  //
  // Note this is NOT the Upload button at the top of the row: that one wraps
  // an image around the geometry the asset already has (a drawn starfish
  // smeared over an octahedron). This one throws the geometry away and draws
  // the image itself, which is what you want for 2D art.
  const modelRow = document.createElement('div');
  modelRow.className = 'sv-tex-glowrow';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Mesh';
  const modelFile = document.createElement('input');
  modelFile.type = 'file';
  modelFile.accept = '.glb,.gltf,.fbx,image/*';
  modelFile.style.display = 'none';
  const modelBtn = document.createElement('button');
  modelBtn.className = 'sv-tex-btn';
  modelBtn.style.flex = '1';
  modelBtn.textContent = '3D model / 2D sprite';
  modelBtn.title = 'Replace this asset with an uploaded .glb/.gltf/.fbx model, or with a 2D sprite from a PNG/JPG/WEBP';
  const modelClear = document.createElement('button');
  modelClear.className = 'sv-tex-btn';
  modelClear.textContent = 'Reset';
  modelClear.title = 'Forget the uploaded model or sprite and go back to the built-in one (takes effect next reload)';
  const modelStatus = document.createElement('div');
  modelStatus.className = 'sv-tex-upload-status';

  async function applyModel(file, { persist }) {
    const sprite = isSpriteFile(file);
    modelStatus.textContent = `Loading ${file.name}...`;
    try {
      // Match the fit of whatever this asset already uses, so an upload lands
      // at the same in-game scale rather than needing the size slider
      // re-dialled from scratch every time.
      await loadUploadedAsset(key, file);
      // Loading a model builds BRAND NEW materials, discarding whatever
      // tint/glow/emissive/tiling was applied to the old ones. The look
      // restore above runs synchronously at row-build time, but this load is
      // async — so on a reload the saved model would land AFTER the look and
      // silently wipe it, leaving the asset looking untouched until you
      // nudged a control (which re-applied it). Re-apply here so the model
      // and its look always end up in sync no matter which finishes first.
      reapplyLook(key, look);
      const kind = sprite ? '2D sprite' : 'model';
      // Glow multiplies an unlit material's colour, so a saved glow of 0
      // multiplies the sprite's image to black — it IS drawn, at the right
      // size, in the right place, and completely invisible. Say so here
      // rather than leaving it looking like the upload failed.
      const blacked = sprite && look.glow === 0;
      modelStatus.textContent = blacked
        ? `Using ${file.name} — but Glow is 0 on this row, so it draws black. Raise Glow to see it.`
        : `Using ${file.name} as a ${kind}${persist ? '' : ' (restored)'}.`;
      if (persist) {
        saveModelToDB(key, file).catch((err) =>
          console.warn('[models] could not save the uploaded model for next time —', err?.message ?? err));
      }
      onAssetChanged?.(key); // rebuild singletons (ship / drone / companion) now
    } catch (err) {
      modelStatus.textContent = `Couldn't load ${file.name} — keeping the built-in ${sprite ? 'shape' : 'model'}.`;
      console.warn(`[models] upload failed for "${key}" —`, err?.message ?? err);
    }
  }

  modelBtn.addEventListener('click', () => modelFile.click());
  modelFile.addEventListener('change', () => {
    const file = modelFile.files?.[0];
    if (file) applyModel(file, { persist: true });
  });
  modelClear.addEventListener('click', () => {
    deleteModelFromDB(key).catch(() => {});
    modelStatus.textContent = 'Saved model cleared — built-in model returns next reload.';
  });
  modelRow.append(modelLabel, modelBtn, modelClear, modelFile);

  el.append(sizeDivider, sizeRow, modelRow, modelStatus);

  // Restore a model uploaded in a previous session.
  loadModelFromDB(key).then((file) => {
    if (file) applyModel(file, { persist: false });
  }).catch((err) => console.warn('[models] could not check for a saved model —', err?.message ?? err));


  resetBtn.addEventListener('click', () => {
    setAssetTexture(key, null);
    setAssetTint(key, null);
    tint.value = '#ffffff';
    dot.classList.remove('sv-tex-active');
    repeatX.value = 1;
    repeatY.value = 1;
    setAssetRepeat(key, 1, 1);
    setAssetSizeMultiplier(key, null);
    look.sizeMultiplier = 1;
    sizeSlider.value = 1;
    sizeNumber.value = 1;
    sizeVal.textContent = '(new spawns)';
    if (emissiveSwatch) { setAssetEmissive(key, null); emissiveSwatch.value = '#000000'; }
    if (glowSlider) { setAssetGlow(key, null); glowSlider.value = '1'; }
    delete CONFIG.assetLooks[key];
    saveTuningToStorage();
    onAssetChanged?.(key);
  });

  if (hasCustomTexture(key)) dot.classList.add('sv-tex-active');

  return { el, dot };
}

// ---------------------------------------------------------------------------
// Haptics tab — one row per feedback event that has a sound, mirroring the
// Sound tab next door. Same reasoning as that tab existing at all: rumble is
// authored by feel, not by reading numbers, so every row carries a Test
// button that fires the real pattern through the real pad.
//
// Why "events with a sound" and not every event: an event with no `sfx` is
// one that was deliberately made silent (missileLaunchExtra is the shells
// after the first in a volley), and giving those a rumble would undo that
// decision in the one channel that can't be mixed down.
//
// The awkward part this tab exists to hide is that a haptic can be written
// two ways — a bare millisecond pattern, which is what older saved tuning
// holds, or explicit { duration, magnitude } pulses. A ms pattern has no
// magnitude of its own; haptics.js derives one from the pulse length. So the
// magnitude slider shows that DERIVED value, marked auto, and the moment you
// move it the event is rewritten in explicit-pulse form with everything else
// preserved. Nothing changes underfoot until you actually edit it.
// ---------------------------------------------------------------------------

function buildHapticsPanel(container) {
  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.style.marginBottom = '10px';
  note.textContent =
    'Controller rumble, one row per event that makes a sound. Duration is how long the motor runs; strength is how hard. Test fires it on the pad right now — connect a controller and press a button first, or the browser will not hand the pad over. Events marked auto take their strength from their length until you move the slider.';
  container.appendChild(note);

  const status = document.createElement('div');
  status.className = 'sv-tex-upload-status';
  status.style.marginBottom = '10px';
  const refreshStatus = () => {
    status.textContent = !CONFIG.haptics.enabled
      ? 'Haptics are switched off — turn them back on in the ` tuner, under Feel.'
      : hapticsAvailable()
        ? 'Pad connected and able to rumble.'
        : 'No pad with rumble detected. Rows still edit and save; Test will do nothing until one is connected.';
  };
  refreshStatus();
  // Cheap enough to re-check whenever the panel is looked at, and the alternative
  // is a stale "no pad" line sitting there after you plug one in.
  window.addEventListener('gamepadconnected', refreshStatus);
  window.addEventListener('gamepaddisconnected', refreshStatus);
  container.appendChild(status);

  // Global shaping first — these scale every row below, so reading them after
  // the per-event numbers would be backwards.
  const globals = document.createElement('div');
  globals.className = 'sv-sfx-row';
  globals.style.borderColor = 'rgba(122,215,255,0.3)';
  const gHead = document.createElement('div');
  gHead.className = 'sv-sfx-name';
  const gTitle = document.createElement('span');
  gTitle.textContent = 'Global shaping';
  const gKind = document.createElement('span');
  gKind.className = 'sv-sfx-type';
  gKind.textContent = 'all events';
  const gTest = document.createElement('button');
  gTest.className = 'sv-tex-btn';
  gTest.textContent = 'Test';
  gTest.addEventListener('click', () => testHaptic());
  const gRight = document.createElement('div');
  gRight.style.display = 'flex';
  gRight.style.gap = '6px';
  gRight.style.alignItems = 'center';
  gRight.append(gKind, gTest);
  gHead.append(gTitle, gRight);
  globals.appendChild(gHead);

  const h = () => CONFIG.haptics;
  const mix = () => (h().mixing ??= {});
  // Haptics touch nothing in the audio graph, so unlike the Sound tab's rows
  // this only needs to persist.
  const changed = () => saveTuningToStorage();

  // Mixing first — whether events stack changes what every number below it
  // means, so it can't sit at the bottom of the list.
  const mixRow = document.createElement('div');
  mixRow.className = 'sv-sfx-field';
  const mixLab = document.createElement('label');
  mixLab.textContent = 'stacking';
  mixLab.title = 'Sum overlapping events instead of letting the loudest replace the rest';
  const mixBox = document.createElement('input');
  mixBox.type = 'checkbox';
  mixBox.checked = mix().enabled !== false;
  const mixHint = document.createElement('span');
  mixHint.className = 'sv-sfx-val';
  mixHint.style.width = 'auto';
  const syncMixHint = () => {
    mixHint.textContent = mixBox.checked
      ? 'events add up'
      : 'loudest wins (old feel)';
  };
  syncMixHint();
  mixBox.addEventListener('change', () => {
    mix().enabled = mixBox.checked;
    syncMixHint();
    changed();
  });
  mixRow.append(mixLab, mixBox, mixHint);
  globals.appendChild(mixRow);

  const sumRow = document.createElement('div');
  sumRow.className = 'sv-sfx-field';
  const sumLab = document.createElement('label');
  sumLab.textContent = 'sum law';
  const sumSel = document.createElement('select');
  for (const [v, text] of [['soft', 'soft — loud wins, quiet still adds'],
                           ['linear', 'linear — plain sum, pins early'],
                           ['max', 'max — replace (old behaviour)']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = text;
    sumSel.appendChild(o);
  }
  sumSel.value = mix().sumMode ?? 'soft';
  sumSel.addEventListener('change', () => { mix().sumMode = sumSel.value; changed(); });
  sumRow.append(sumLab, sumSel);
  globals.appendChild(sumRow);

  // The knob that decides whether a stream of repeats reads as taps or as one
  // continuous bed: a voice lives (its duration + this), so repeats fuse once
  // that exceeds the gap between them.
  slider(globals, 'tail ms', 0, 400, 5, () => mix().release ?? 70, (v) => { mix().release = v; });

  texRows.push(() => {
    mixBox.checked = mix().enabled !== false;
    sumSel.value = mix().sumMode ?? 'soft';
    syncMixHint();
  });

  slider(globals, 'strength', 0, 2, 0.05, () => h().intensity ?? 1, (v) => { h().intensity = v; });
  slider(globals, 'low motor', 0, 1, 0.05, () => h().strongRatio ?? 1, (v) => { h().strongRatio = v; });
  slider(globals, 'high motor', 0, 1, 0.05, () => h().weakRatio ?? 0.45, (v) => { h().weakRatio = v; });
  slider(globals, 'min ms', 0, 120, 5, () => h().minDuration ?? 20, (v) => { h().minDuration = v; });
  // These three only affect events still on a millisecond pattern — nothing
  // with an authored magnitude reads them at all. Said plainly, because a
  // slider that does nothing to most of the table needs to explain itself.
  const autoNote = document.createElement('div');
  autoNote.className = 'sv-tex-upload-status';
  autoNote.style.marginTop = '8px';
  autoNote.textContent = 'The three below shape the auto strength curve — they only affect rows still marked auto.';
  globals.appendChild(autoNote);
  slider(globals, 'auto full at', 5, 150, 5, () => h().fullAtMs ?? 45, (v) => { h().fullAtMs = v; refreshAllAuto(); });
  slider(globals, 'auto curve', 0.2, 2, 0.05, () => h().curve ?? 0.6, (v) => { h().curve = v; refreshAllAuto(); });
  slider(globals, 'auto floor', 0, 0.6, 0.01, () => h().floor ?? 0.15, (v) => { h().floor = v; refreshAllAuto(); });
  container.appendChild(globals);
  refreshStatus();

  for (const name of Object.keys(CONFIG.feedback)) {
    if (!CONFIG.feedback[name].sfx) continue;
    container.appendChild(buildHapticRow(name));
  }
}

// Rows whose magnitude is derived rather than authored, so changing the
// global curve can update the numbers they're showing.
const autoRows = [];

function refreshAllAuto() {
  for (const fn of autoRows) fn();
}

function buildHapticRow(event) {
  const def = CONFIG.feedback[event];
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = event;
  const kind = document.createElement('span');
  kind.className = 'sv-sfx-type';
  const testBtn = document.createElement('button');
  testBtn.className = 'sv-tex-btn';
  testBtn.textContent = 'Test';
  testBtn.addEventListener('click', () => previewHaptic(def.haptic));
  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.gap = '6px';
  right.style.alignItems = 'center';
  right.append(kind, testBtn);
  head.append(nameSpan, right);
  el.appendChild(head);

  // An event with no haptic at all still gets a row — that's the whole point
  // of listing by sound rather than by what happens to be authored. Editing
  // one seeds a pattern rather than writing into nothing.
  const pulses = () => describeHaptic(def.haptic);
  const isAuto = () => {
    const p = pulses();
    return p.length > 0 && p[0].magnitude == null;
  };

  const refreshKind = () => {
    const p = pulses();
    if (!p.length) { kind.textContent = 'none'; return; }
    kind.textContent = `${p.length} pulse${p.length > 1 ? 's' : ''}${isAuto() ? ' · auto' : ''}`;
  };
  refreshKind();

  // Writing ANY field converts the whole event to explicit pulses, carrying
  // the current resolved values across, so a ms pattern's feel is preserved
  // exactly at the moment you start editing it rather than snapping to some
  // default.
  const toExplicit = () => {
    const p = pulses();
    if (!p.length) return [{ duration: 30, magnitude: 0.5, delay: 0 }];
    // `gap`, never `delay` — see describeHaptic. `delay` is absolute and
    // writing it back walks the tail later on every edit.
    return p.map((q) => ({ duration: q.duration, magnitude: q.resolved, delay: q.gap }));
  };

  const first = () => pulses()[0] ?? { duration: 30, resolved: 0.5, delay: 0 };

  const durSlider = slider(el, 'duration', 0, 200, 1, () => first().duration, (v) => {
    const next = toExplicit();
    next[0].duration = v;
    def.haptic = next;
    refreshKind();
    syncMag();
  });
  durSlider.title = 'Milliseconds the motor runs for this pulse';

  // Magnitude needs its own read-back, because for an auto row the number
  // shown is a function of duration and moves when duration does.
  const magRow = document.createElement('div');
  magRow.className = 'sv-sfx-field';
  const magLab = document.createElement('label');
  magLab.textContent = 'strength';
  magLab.title = 'How hard the motor runs, 0 to 1';
  const magInput = document.createElement('input');
  magInput.type = 'range';
  magInput.min = 0; magInput.max = 1; magInput.step = 0.01;
  const magVal = document.createElement('span');
  magVal.className = 'sv-sfx-val';
  const syncMag = () => {
    const p = first();
    magInput.value = p.resolved;
    magVal.textContent = p.resolved.toFixed(2) + (isAuto() ? ' a' : '');
  };
  syncMag();
  magInput.addEventListener('input', () => {
    const next = toExplicit();
    next[0].magnitude = Number(magInput.value);
    def.haptic = next;
    magVal.textContent = Number(magInput.value).toFixed(2);
    refreshKind();
    saveTuningToStorage();
  });
  magRow.append(magLab, magInput, magVal);
  el.appendChild(magRow);

  // The tail. Most events are one pulse; the heavy ones (strike, calamari,
  // the eel discharge) are two, and the second is what stops them reading as
  // a flat buzz. Exposed as "tail" rather than as a pulse list because two is
  // as far as any of this needs to go, and a general pulse editor would be a
  // lot of UI for a shape nothing uses.
  const tailLen = () => pulses()[1]?.duration ?? 0;
  const tailSlider = slider(el, 'tail ms', 0, 200, 1, () => tailLen(), (v) => {
    const next = toExplicit();
    if (v <= 0) next.length = Math.min(next.length, 1);
    else if (next.length > 1) next[1].duration = v;
    else next.push({ duration: v, magnitude: Math.min(0.4, (next[0].magnitude ?? 0.5) * 0.4), delay: 0 });
    def.haptic = next;
    refreshKind();
    syncTail();
  });
  tailSlider.title = 'A second, softer pulse after the first — 0 for none';

  const tailMagRow = document.createElement('div');
  tailMagRow.className = 'sv-sfx-field';
  const tailMagLab = document.createElement('label');
  tailMagLab.textContent = 'tail str';
  const tailMagInput = document.createElement('input');
  tailMagInput.type = 'range';
  tailMagInput.min = 0; tailMagInput.max = 1; tailMagInput.step = 0.01;
  const tailMagVal = document.createElement('span');
  tailMagVal.className = 'sv-sfx-val';
  const syncTail = () => {
    const p = pulses()[1];
    const on = !!p && p.duration > 0;
    tailMagInput.disabled = !on;
    tailMagInput.style.opacity = on ? '1' : '0.35';
    tailMagInput.value = on ? p.resolved : 0;
    tailMagVal.textContent = on ? p.resolved.toFixed(2) : '—';
  };
  syncTail();
  tailMagInput.addEventListener('input', () => {
    const next = toExplicit();
    if (next.length > 1) {
      next[1].magnitude = Number(tailMagInput.value);
      def.haptic = next;
      tailMagVal.textContent = Number(tailMagInput.value).toFixed(2);
      saveTuningToStorage();
    }
  });
  tailMagRow.append(tailMagLab, tailMagInput, tailMagVal);
  el.appendChild(tailMagRow);

  // Off switch. Nulling the haptic is a legitimate authored choice — some
  // events genuinely should not be felt — so it needs to be reachable
  // without dragging duration to zero and hoping that means the same thing.
  const offRow = document.createElement('div');
  offRow.className = 'sv-sfx-field';
  const offLab = document.createElement('label');
  offLab.textContent = 'enabled';
  const offBox = document.createElement('input');
  offBox.type = 'checkbox';
  offBox.checked = pulses().length > 0;
  let stashed = null;
  offBox.addEventListener('change', () => {
    if (offBox.checked) {
      def.haptic = stashed ?? [{ duration: 30, magnitude: 0.5, delay: 0 }];
    } else {
      stashed = def.haptic;
      def.haptic = null;
    }
    durSlider.value = first().duration;
    refreshKind();
    syncMag();
    syncTail();
    saveTuningToStorage();
  });
  offRow.append(offLab, offBox);
  el.appendChild(offRow);

  if (isAuto()) {
    autoRows.push(() => {
      if (!isAuto()) return; // converted to explicit since — nothing to track
      syncMag();
      syncTail();
    });
  }

  // The two magnitude sliders and the on/off box are hand-built rather than
  // going through slider(), so they register their own refresh — without it a
  // Reset would restore the duration (which IS a slider()) while leaving the
  // strength beside it showing the value that was just thrown away.
  texRows.push(() => {
    refreshKind();
    syncMag();
    syncTail();
    offBox.checked = pulses().length > 0;
  });

  return el;
}

// ---------------------------------------------------------------------------
// Sound tab — one row per CONFIG.sfx entry, fields shown depend on its type,
// each with a Test button that plays it immediately through the real synth.
// ---------------------------------------------------------------------------

// Every control in the Sound, Haptics and Particles tabs is one of these.
//
// `value` may be a number OR a getter. A getter also registers the row for
// refreshTexturePanelRows(), which is what puts it back in step after a Reset
// or an import — those rewrite CONFIG behind the panel's back, and a slider
// left at its old position then reports a value that is no longer in effect
// and jumps the moment you nudge it. Plain numbers still work and simply
// don't refresh, so this stayed backwards-compatible while the call sites
// were converted.
function slider(container, label, min, max, step, value, onInput) {
  const read = typeof value === 'function' ? value : () => value;
  const fmt = (v) => Number(v).toFixed(step < 1 ? 2 : 0);

  const row = document.createElement('div');
  row.className = 'sv-sfx-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.title = label; // the box ellipsizes; hover still gives the full name
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step; input.value = read();
  const val = document.createElement('span');
  val.className = 'sv-sfx-val';
  val.textContent = fmt(read());
  input.addEventListener('input', () => {
    val.textContent = fmt(input.value);
    onInput(Number(input.value));
    saveTuningToStorage();
  });
  row.append(lab, input, val);
  container.appendChild(row);

  if (typeof value === 'function') {
    texRows.push(() => { input.value = read(); val.textContent = fmt(read()); });
  }
  return input;
}

function buildUpgradeTable() {
  const wrap = document.createElement('div');

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.style.marginBottom = '10px';
  note.textContent = "Edit what each upgrade is called, what it says, how many times it can stack, and whether it's offered at all. What an upgrade DOES is code (its apply function) and isn't editable here — these are the display and tuning fields, and they're saved with the rest of your tuning.";
  wrap.appendChild(note);

  for (const u of CONFIG.upgrades) {
    const row = document.createElement('div');
    row.className = 'sv-sfx-row';

    const head = document.createElement('div');
    head.className = 'sv-sfx-name';
    const idSpan = document.createElement('span');
    idSpan.className = 'sv-sfx-type';
    idSpan.textContent = u.id;
    const onBox = document.createElement('input');
    onBox.type = 'checkbox';
    onBox.checked = u.enabled !== false;
    onBox.title = 'Uncheck to stop this upgrade being offered';
    onBox.addEventListener('change', () => {
      setOverride(u.id, 'enabled', onBox.checked);
      row.style.opacity = onBox.checked ? '1' : '0.45';
    });
    row.style.opacity = onBox.checked ? '1' : '0.45';
    head.append(idSpan, onBox);
    wrap.appendChild(row);
    row.appendChild(head);

    const nameRow = document.createElement('div');
    nameRow.className = 'sv-sfx-field';
    const nameLab = document.createElement('label');
    nameLab.textContent = 'name';
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'sv-up-text';
    nameIn.value = u.name;
    nameIn.addEventListener('change', () => setOverride(u.id, 'name', nameIn.value));
    nameRow.append(nameLab, nameIn);
    row.appendChild(nameRow);

    const descRow = document.createElement('div');
    descRow.className = 'sv-sfx-field';
    const descLab = document.createElement('label');
    descLab.textContent = 'desc';
    const descIn = document.createElement('input');
    descIn.type = 'text';
    descIn.className = 'sv-up-text';
    descIn.value = u.desc;
    descIn.addEventListener('change', () => setOverride(u.id, 'desc', descIn.value));
    descRow.append(descLab, descIn);
    row.appendChild(descRow);

    const stackRow = document.createElement('div');
    stackRow.className = 'sv-sfx-field';
    const stackLab = document.createElement('label');
    stackLab.textContent = 'max stacks';
    const stackIn = document.createElement('input');
    stackIn.type = 'number';
    stackIn.min = '1';
    stackIn.className = 'sv-tex-size-number';
    stackIn.value = u.maxStacks ?? '';
    stackIn.placeholder = '∞';
    stackIn.addEventListener('change', () => {
      const v = stackIn.value === '' ? null : Math.max(1, Number(stackIn.value));
      setOverride(u.id, 'maxStacks', v);
    });
    stackRow.append(stackLab, stackIn);
    row.appendChild(stackRow);
  }

  return wrap;
}

function setOverride(id, field, value) {
  if (!CONFIG.upgradeOverrides[id]) CONFIG.upgradeOverrides[id] = {};
  CONFIG.upgradeOverrides[id][field] = value;
  applyUpgradeOverrides();
  saveTuningToStorage();
}

// Master FX bus — one filter and one reverb every SFX runs through. Sits at
// the top of the Sound tab because it colours everything below it.
function buildBusRow() {
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';
  el.style.borderColor = 'rgba(255,179,71,0.3)';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const title = document.createElement('span');
  title.textContent = 'Master FX bus';
  const kind = document.createElement('span');
  kind.className = 'sv-sfx-type';
  kind.textContent = 'sfx only';
  head.append(title, kind);
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.textContent = 'Filter and reverb applied to every sound effect. Music is on its own chain and is not affected. Reverb is a parallel send, so the dry hit stays intact as you add wet.';
  el.appendChild(note);

  const bus = () => (CONFIG.audio.bus ??= {});
  const changed = () => { applyAudioBusSettings(); saveTuningToStorage(); };

  // Filter type is a choice, not a range, so it gets a select rather than a
  // slider — a lowpass and a highpass are not two ends of one continuum.
  const typeRow = document.createElement('div');
  typeRow.className = 'sv-sfx-field';
  const typeLab = document.createElement('label');
  typeLab.textContent = 'filter';
  typeLab.title = 'filter type';
  const typeSel = document.createElement('select');
  for (const t of ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf']) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    typeSel.appendChild(o);
  }
  typeSel.value = bus().filterType ?? 'lowpass';
  typeSel.addEventListener('change', () => { bus().filterType = typeSel.value; changed(); });
  typeRow.append(typeLab, typeSel);
  el.appendChild(typeRow);

  slider(el, 'cutoff', 20, 20000, 10, () => bus().filterHz ?? 20000, (v) => { bus().filterHz = v; changed(); });
  slider(el, 'resonance', 0.1, 20, 0.1, () => bus().filterQ ?? 1, (v) => { bus().filterQ = v; changed(); });
  slider(el, 'reverb mix', 0, 1, 0.01, () => bus().reverbMix ?? 0, (v) => { bus().reverbMix = v; changed(); });
  slider(el, 'reverb tail', 0.05, 6, 0.05, () => bus().reverbSeconds ?? 1.6, (v) => { bus().reverbSeconds = v; changed(); });
  slider(el, 'reverb decay', 0.1, 8, 0.1, () => bus().reverbDecay ?? 2, (v) => { bus().reverbDecay = v; changed(); });

  // Depth tracking. Its own range rather than the music's — see the note in
  // CONFIG.audio.bus.depth for why they can't share one.
  const depth = () => (bus().depth ??= {});
  const depthRow = document.createElement('div');
  depthRow.className = 'sv-sfx-field';
  const depthLab = document.createElement('label');
  depthLab.textContent = 'depth filt';
  depthLab.title = 'tie cutoff to how deep the player is';
  const depthBox = document.createElement('input');
  depthBox.type = 'checkbox';
  depthBox.checked = depth().enabled === true;
  depthBox.title = 'While on, depth drives the cutoff and the manual cutoff slider above is ignored';
  const depthHint = document.createElement('span');
  depthHint.className = 'sv-sfx-val';
  depthHint.style.width = 'auto';
  const refreshHint = () => {
    depthHint.textContent = depthBox.checked ? 'overrides cutoff' : 'off';
  };
  refreshHint();
  depthBox.addEventListener('change', () => {
    depth().enabled = depthBox.checked;
    refreshHint();
    changed();
  });
  depthRow.append(depthLab, depthBox, depthHint);
  el.appendChild(depthRow);

  slider(el, 'at surface', 200, 20000, 100, () => depth().surfaceHz ?? 20000, (v) => { depth().surfaceHz = v; changed(); });
  slider(el, 'at seabed', 200, 20000, 100, () => depth().deepHz ?? 5000, (v) => { depth().deepHz = v; changed(); });
  slider(el, 'depth glide', 0.01, 1.5, 0.01, () => depth().smoothing ?? 0.15, (v) => { depth().smoothing = v; changed(); });

  // Audition through the bus without waiting for the right thing to happen
  // in game.
  const testRow = document.createElement('div');
  testRow.className = 'sv-sfx-field';
  const testLab = document.createElement('label');
  testLab.textContent = 'test';
  for (const [label, sfx] of [['Shot', 'shoot'], ['Kill', 'kill'], ['Big kill', 'bigKill']]) {
    const b = document.createElement('button');
    b.className = 'sv-tex-btn';
    b.textContent = label;
    b.addEventListener('click', () => { unlockAudio(); playSfx(sfx, 1); });
    testRow.appendChild(b);
  }
  testRow.insertBefore(testLab, testRow.firstChild);
  el.appendChild(testRow);

  return el;
}

function buildMusicRow() {
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';
  el.style.borderColor = 'rgba(122,215,255,0.3)';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const title = document.createElement('span');
  title.textContent = 'Music loops';
  const info = document.createElement('span');
  info.className = 'sv-sfx-type';
  const refreshInfo = () => {
    info.textContent = `${CONFIG.music.bpm}bpm · loop ${loopDuration().toFixed(2)}s`;
  };
  refreshInfo();
  head.append(title, info);
  el.appendChild(head);

  const note = document.createElement('div');
  note.className = 'sv-tex-upload-status';
  note.textContent = `${CONFIG.music.slots} loops ship built in (747 Cocktails). Upload a file to replace any slot for this session, or Clear to silence it. Which one plays follows your level (every ${CONFIG.music.levelsPerSlot} levels moves to the next FILLED slot, so gaps are skipped). Switches wait for the next loop boundary, never cutting a loop off mid-phrase. The low-pass opens as you level, and ducks while the upgrade screen is open.`;
  el.appendChild(note);

  for (let i = 1; i <= CONFIG.music.slots; i++) {
    const trackName = String(i);
    const row = document.createElement('div');
    row.className = 'sv-sfx-field';
    const lab = document.createElement('label');
    lab.style.width = '46px';
    lab.textContent = `loop ${i}`;
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'audio/*';
    file.style.display = 'none';
    const up = document.createElement('button');
    up.className = 'sv-tex-btn';
    up.textContent = hasTrack(trackName) ? 'Replace' : 'Upload';
    const clr = document.createElement('button');
    clr.className = 'sv-tex-btn';
    clr.textContent = 'Clear';
    const status = document.createElement('span');
    status.className = 'sv-sfx-val';
    status.style.width = 'auto';
    status.textContent = hasTrack(trackName) ? 'loaded' : '—';

    // This row is built long before the built-in default for this slot has
    // finished fetching, so its initial "—" above is provisional — refresh
    // once the load lands rather than leaving it stale forever. A manual
    // upload or clear takes over the row for good, so the built-in default
    // finishing late doesn't stomp on it.
    let userTouched = false;
    const unsubscribe = onTracksChanged(() => {
      if (userTouched) return;
      const loaded = hasTrack(trackName);
      status.textContent = loaded ? 'loaded' : '—';
      up.textContent = loaded ? 'Replace' : 'Upload';
    });

    up.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      userTouched = true;
      unsubscribe();
      unlockAudio();
      status.textContent = 'loading…';
      const ok = await loadTrackFromFile(trackName, f);
      if (ok) {
        // Same deal as the SFX rows: save the file and record it as this
        // slot's default, so the loop is still here after a reload.
        const src = await uploadAsset('music', f);
        if (src) {
          CONFIG.music.defaultSrc[i - 1] = src;
          saveTuningToStorage();
          status.textContent = `saved ${f.name.slice(0, 10)}`;
        } else {
          status.textContent = `${f.name.slice(0, 9)} (session)`;
        }
      } else {
        status.textContent = 'failed';
      }
      up.textContent = ok ? 'Replace' : 'Upload';
    });
    clr.addEventListener('click', () => {
      userTouched = true;
      unsubscribe();
      clearTrack(trackName);
      // Clear the saved default too, or the slot refills itself on reload.
      CONFIG.music.defaultSrc[i - 1] = null;
      saveTuningToStorage();
      status.textContent = '—';
      up.textContent = 'Upload';
    });
    row.append(lab, up, clr, file, status);
    el.appendChild(row);
  }

  const controls = document.createElement('div');
  controls.className = 'sv-sfx-field';
  const previewLab = document.createElement('label');
  previewLab.style.width = '46px';
  previewLab.textContent = 'preview';
  const playBtn = document.createElement('button');
  playBtn.className = 'sv-tex-btn';
  playBtn.textContent = 'Play';
  playBtn.addEventListener('click', () => { unlockAudio(); refreshInfo(); playMusic(1); });
  const stopBtn = document.createElement('button');
  stopBtn.className = 'sv-tex-btn';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => stopMusic());
  controls.append(previewLab, playBtn, stopBtn);
  el.appendChild(controls);

  return el;
}

// What this sound is configured to use, independent of whether the audio
// context has decoded it yet.
function configuredSrcs(def) {
  if (Array.isArray(def.srcs) && def.srcs.length) return def.srcs.filter(Boolean);
  return def.src ? [def.src] : [];
}

// Samples are only decoded once audio unlocks (which needs a user gesture), so
// counting decoded buffers made every sound read "synth" if you opened this
// panel before starting a run — even with files assigned and saved. Report
// what's CONFIGURED, and say separately when it hasn't been decoded yet.
function describeSamples(def, name) {
  const configured = configuredSrcs(def).length;
  if (!configured) return 'synth';
  const loaded = sampleCount(name);
  if (!loaded) return `${configured} file(s) · not loaded yet`;
  return `${loaded} sample(s)`;
}

function buildSfxRow(name) {
  const def = CONFIG.sfx[name];
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  const typeSpan = document.createElement('span');
  typeSpan.className = 'sv-sfx-type';
  typeSpan.textContent = def.type;
  const testBtn = document.createElement('button');
  testBtn.className = 'sv-tex-btn';
  testBtn.textContent = 'Test';
  testBtn.addEventListener('click', () => { unlockAudio(); playSfx(name, 1); });
  const headRight = document.createElement('div');
  headRight.style.display = 'flex';
  headRight.style.gap = '6px';
  headRight.style.alignItems = 'center';
  headRight.append(typeSpan, testBtn);
  head.append(nameSpan, headRight);
  el.appendChild(head);

  if (def.type === 'blip' || def.type === 'boom') {
    const waveRow = document.createElement('div');
    waveRow.className = 'sv-sfx-field';
    const waveLabel = document.createElement('label');
    waveLabel.textContent = 'wave';
    const waveSelect = document.createElement('select');
    for (const w of ['sine', 'square', 'triangle', 'sawtooth']) {
      const opt = document.createElement('option');
      opt.value = w; opt.textContent = w;
      waveSelect.appendChild(opt);
    }
    waveSelect.value = def.wave ?? 'sine';
    waveSelect.addEventListener('change', () => { def.wave = waveSelect.value; saveTuningToStorage(); });
    waveRow.append(waveLabel, waveSelect);
    el.appendChild(waveRow);

    slider(el, 'freq lo', 20, 2000, 5, () => def.freq?.[0] ?? 440, (v) => { def.freq = [v, def.freq?.[1] ?? v]; });
    slider(el, 'freq hi', 20, 2000, 5, () => def.freq?.[1] ?? 220, (v) => { def.freq = [def.freq?.[0] ?? v, v]; });
  }

  if (def.type === 'noise' || def.type === 'boom') {
    slider(el, 'filter', 80, 6000, 20, () => def.filter ?? 2000, (v) => { def.filter = v; });
  }
  if (def.type === 'boom') {
    slider(el, 'noise mix', 0, 1, 0.02, () => def.noise ?? 0.5, (v) => { def.noise = v; });
  }

  slider(el, 'decay', 0.02, 1.5, 0.01, () => def.decay ?? 0.2, (v) => { def.decay = v; });
  // Up to 4x: master volume sits at 0.2, so there's plenty of headroom before
  // anything clips, and several sounds were already pinned at the old ceiling
  // of 1 with nowhere left to go.
  slider(el, 'gain', 0, 4, 0.01, () => def.gain ?? 0.2, (v) => { def.gain = v; });
  // Every sound gets randomized variation so repeats don't phase into one
  // flat tone. Pickups ship with a wide spread, weapons a tight one.
  slider(el, 'pitch var', 0, 0.5, 0.01, () => def.pitchVary ?? 0, (v) => { def.pitchVary = v; });
  if (def.type === 'noise' || def.type === 'boom') {
    slider(el, 'filt var', 0, 0.6, 0.01, () => def.filterVary ?? 0, (v) => { def.filterVary = v; });
  }
  if (def.type === 'blip' || def.type === 'boom') {
    slider(el, 'detune', 0, 80, 1, () => def.detune ?? 0, (v) => { def.detune = v; });
  }

  // Upload an audio file to replace the synthesized sound. Pitch/filter
  // variation above still applies to it (playbackRate doubles as pitch for
  // a sample), and clearing falls straight back to the synth.
  const sampleRow = document.createElement('div');
  sampleRow.className = 'sv-sfx-field';
  const sampleLabel = document.createElement('label');
  sampleLabel.textContent = 'sample';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  fileInput.style.display = 'none';
  const upBtn = document.createElement('button');
  upBtn.className = 'sv-tex-btn';
  upBtn.textContent = hasSample(name) ? 'Add another' : 'Upload';

  // This row is built at boot, before preloadSamples has fetched anything, so
  // the labels above are provisional — refresh them when loading lands. A
  // manual upload or clear takes the row over for good, so a late-finishing
  // preload can't stomp on what you just did.
  let userTouchedSample = false;
  const unsubscribeSamples = onSamplesChanged(() => {
    if (userTouchedSample) return;
    sampleStatus.textContent = describeSamples(def, name);
    upBtn.textContent = configuredSrcs(def).length ? 'Add another' : 'Upload';
  });
  const clrBtn = document.createElement('button');
  clrBtn.className = 'sv-tex-btn';
  clrBtn.textContent = 'Synth';
  clrBtn.title = 'Drop the uploaded sample and go back to the synthesized sound';
  const sampleStatus = document.createElement('span');
  sampleStatus.className = 'sv-sfx-val';
  sampleStatus.style.width = 'auto';
  sampleStatus.textContent = describeSamples(def, name);

  upBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    userTouchedSample = true;
    unsubscribeSamples();
    unlockAudio();
    sampleStatus.textContent = 'loading…';
    // Append rather than replace: uploading several takes for one sound
    // builds a variation set, and playSfx picks a different one each time.
    const ok = await loadSampleFromFile(name, file, { append: true });
    if (ok) {
      // Decoding succeeded, so it's worth keeping: write it into public/sfx
      // and add it to this entry's `srcs`. That's the same field a
      // hand-edited config uses, so it reloads on every future boot instead
      // of living only in this tab's memory.
      const src = await uploadAsset('sfx', file);
      if (src) {
        if (!Array.isArray(def.srcs)) def.srcs = def.src ? [def.src] : [];
        if (!def.srcs.includes(src)) def.srcs.push(src);
        def.src = null; // superseded by the array
        saveTuningToStorage();
        sampleStatus.textContent = `${sampleCount(name)} sample(s)`;
      } else {
        sampleStatus.textContent = `${sampleCount(name)} (session)`;
      }
    } else {
      sampleStatus.textContent = 'failed — synth';
    }
    upBtn.textContent = 'Add another';
  });
  clrBtn.addEventListener('click', () => {
    userTouchedSample = true;
    unsubscribeSamples();
    clearSample(name);
    // Drop the saved file references too, or the next boot would reload them
    // and the synth would never come back.
    def.src = null;
    def.srcs = [];
    saveTuningToStorage();
    sampleStatus.textContent = 'synth';
    upBtn.textContent = 'Upload';
  });
  sampleRow.append(sampleLabel, upBtn, clrBtn, fileInput, sampleStatus);
  el.appendChild(sampleRow);

  // One line per loaded variation, each removable on its own. Clearing the
  // whole set was the only option before, which is useless when a set of five
  // has two you don't want — you had to wipe it and re-upload the keepers.
  const variationList = document.createElement('div');
  variationList.className = 'sv-sfx-variations';
  el.appendChild(variationList);

  function renderVariations() {
    variationList.replaceChildren();
    const srcs = Array.isArray(def.srcs) ? def.srcs : (def.src ? [def.src] : []);
    // Render even a single entry. Hiding the list below two meant a sound
    // with exactly one sample showed its filename nowhere at all, which
    // reads as "my upload vanished" even though it's saved and working.
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      const line = document.createElement('div');
      line.className = 'sv-sfx-variation';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'sv-sfx-variation-name';
      nameSpan.textContent = src.split('/').pop();
      nameSpan.title = src;

      // Audition this one specifically. playSfx picks at random, so without
      // this there'd be no way to tell which file you're about to remove.
      const playOne = document.createElement('button');
      playOne.className = 'sv-tex-btn';
      playOne.textContent = '▶';
      playOne.title = 'Play just this variation';
      playOne.addEventListener('click', async () => {
        unlockAudio();
        try {
          const ctx = getAudioContext();
          const res = await fetch(src);
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          const node = ctx.createBufferSource();
          const gain = ctx.createGain();
          gain.gain.value = def.gain ?? 0.3;
          node.buffer = buf;
          node.connect(gain).connect(ctx.destination);
          node.start();
        } catch (err) {
          console.warn(`[audio] could not audition ${src} —`, err?.message ?? err);
        }
      });

      const del = document.createElement('button');
      del.className = 'sv-tex-btn';
      del.textContent = '×';
      del.title = 'Remove this variation';
      del.addEventListener('click', async () => {
        userTouchedSample = true;
        unsubscribeSamples();
        def.srcs = srcs.filter((_, j) => j !== i);
        def.src = null;
        saveTuningToStorage();
        // Rebuild from the trimmed list rather than splicing the decoded
        // buffers by index — a variation that failed to decode would have
        // put the two out of step.
        await reloadSample(name);
        const n = sampleCount(name);
        sampleStatus.textContent = n ? `${n} sample(s)` : 'synth';
        upBtn.textContent = n ? 'Add another' : 'Upload';
        renderVariations();
      });

      line.append(nameSpan, playOne, del);
      variationList.appendChild(line);
    }
  }
  renderVariations();

  // Keep the list in step when samples finish loading at boot, or when the
  // whole set is cleared.
  clrBtn.addEventListener('click', () => renderVariations());
  onSamplesChanged(() => { if (!userTouchedSample) renderVariations(); });

  return el;
}

function pairSlider(container, label, min, max, step, pair, onInput) {
  const row = document.createElement('div');
  row.className = 'sv-sfx-field';
  const lab = document.createElement('label');
  lab.textContent = label;
  const lo = document.createElement('input');
  lo.type = 'range'; lo.min = min; lo.max = max; lo.step = step; lo.value = pair[0];
  const hi = document.createElement('input');
  hi.type = 'range'; hi.min = min; hi.max = max; hi.step = step; hi.value = pair[1];
  const val = document.createElement('span');
  val.className = 'sv-sfx-val';
  val.style.width = '58px';
  const fmt = (v) => Number(v).toFixed(step < 1 ? 2 : 0);
  val.textContent = `${fmt(pair[0])}-${fmt(pair[1])}`;
  const sync = () => {
    val.textContent = `${fmt(lo.value)}-${fmt(hi.value)}`;
    onInput([Number(lo.value), Number(hi.value)]);
    saveTuningToStorage();
  };
  lo.addEventListener('input', sync);
  hi.addEventListener('input', sync);
  row.append(lab, lo, hi, val);
  container.appendChild(row);
}

function buildEmitterRow(name) {
  const def = CONFIG.emitters[name];
  const el = document.createElement('div');
  el.className = 'sv-sfx-row';

  const head = document.createElement('div');
  head.className = 'sv-sfx-name';
  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;
  const testBtn = document.createElement('button');
  testBtn.className = 'sv-tex-btn';
  testBtn.textContent = 'Test';
  testBtn.addEventListener('click', () => emit(name, 0, 0));
  head.append(nameSpan, testBtn);
  el.appendChild(head);

  pairSlider(el, 'size', 0.01, 3, 0.01, def.size, (v) => { def.size = v; });
  pairSlider(el, 'life', 0.02, 3, 0.01, def.life, (v) => { def.life = v; });
  pairSlider(el, 'speed', 0, 40, 0.5, def.speed, (v) => { def.speed = v; });
  slider(el, 'count', 1, 200, 1, () => def.count, (v) => { def.count = Math.round(v); });

  return el;
}

export function refreshTexturePanel() {
  for (const [key, row] of rows) {
    row.dot.classList.toggle('sv-tex-active', hasCustomTexture(key));
  }
}
