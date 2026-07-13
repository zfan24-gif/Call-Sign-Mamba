// ---------------------------------------------------------------------------
// Player settings: mouse sensitivity + rebindable keybindings.
//
// Owns the canonical config, sensible defaults, localStorage persistence, and a
// fast reverse lookup from a pressed KeyboardEvent.code to the game ACTION it is
// bound to. main.js reads these each frame instead of hard-coding key codes, so
// the Settings menu can remap controls live.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'csm.settings.v1';

// Every rebindable action, in display order, with a label and its default key code(s).
// Movement actions support TWO bound keys (a primary + an alternate) so WASD and the
// arrow keys can both work out of the box; single-key actions use one slot.
export const ACTIONS = [
  { id: 'thrust',       label: 'Thrust Forward',  slots: 2, defaults: ['KeyW', 'ArrowUp'] },
  { id: 'reverse',      label: 'Reverse',         slots: 2, defaults: ['KeyS', 'ArrowDown'] },
  { id: 'strafeLeft',   label: 'Strafe Left',     slots: 2, defaults: ['KeyA', 'ArrowLeft'] },
  { id: 'strafeRight',  label: 'Strafe Right',    slots: 2, defaults: ['KeyD', 'ArrowRight'] },
  { id: 'fire',         label: 'Fire',            slots: 2, defaults: ['Space', 'Mouse0'] },
  { id: 'fireMissile',  label: 'Fire Missile',    slots: 2, defaults: ['KeyF', 'Mouse2'] },
  { id: 'lockTarget',   label: 'Lock Target',     slots: 1, defaults: ['KeyT'] },
  { id: 'cycleTarget',  label: 'Cycle Target',    slots: 1, defaults: ['KeyR'] },
  { id: 'chaff',        label: 'Deploy Chaff',    slots: 1, defaults: ['KeyC'] },
  { id: 'boost',        label: 'Boost',           slots: 2, defaults: ['ShiftLeft', 'ShiftRight'] },
  { id: 'routeShields', label: 'Route: Shields',  slots: 1, defaults: ['Digit1'] },
  { id: 'routeWeapons', label: 'Route: Weapons',  slots: 1, defaults: ['Digit2'] },
  { id: 'routeEngines', label: 'Route: Engines',  slots: 1, defaults: ['Digit3'] },
  { id: 'resetPower',   label: 'Reset Power',     slots: 1, defaults: ['Digit5'] },
  { id: 'toggleView',   label: 'Toggle View',     slots: 2, defaults: ['Tab', 'KeyV'] },
  { id: 'hyperspace',   label: 'Hyperspace Jump', slots: 1, defaults: ['KeyH'] },
  { id: 'mute',         label: 'Mute Audio',      slots: 1, defaults: ['KeyM'] },
  // --- Multiplayer voice comms ---
  // Push-to-talk: HELD to transmit (open mic while down), released to stop. Squad Voice toggles the
  // channel between the whole team and just your squad (opted-in same-team pilots).
  { id: 'pushToTalk',   label: 'Push-To-Talk',    slots: 2, defaults: ['KeyB', 'Mouse4'] },
  { id: 'squadVoice',   label: 'Toggle Squad Voice', slots: 1, defaults: ['KeyN'] },
  // Scoreboard: HELD to view the live team scoreboard in a multiplayer match. Defaults to the
  // backtick/tilde key (`) — NOT Tab, which stays reserved for Toggle View so it behaves the same
  // in multiplayer as it does in single player.
  { id: 'scoreboard',   label: 'Show Scoreboard', slots: 2, defaults: ['Backquote', 'KeyG'] }
];

function defaultBindings() {
  const b = {};
  for (const a of ACTIONS) b[a.id] = a.defaults.slice(0, a.slots);
  return b;
}

function defaultSettings() {
  return {
    mouseSensX: 1.0,     // horizontal aim sensitivity multiplier
    mouseSensY: 1.0,     // vertical aim sensitivity multiplier
    invertY: false,      // invert vertical aim (mouse)
    invertX: false,      // invert horizontal aim (mouse)
    padInvertY: true,    // invert vertical aim on the gamepad RIGHT stick (default on — flight-stick feel)
    padInvertX: false,   // invert horizontal aim on the gamepad RIGHT stick
    padSensX: 1.0,       // horizontal aim sensitivity multiplier (gamepad RIGHT stick)
    padSensY: 1.0,       // vertical aim sensitivity multiplier (gamepad RIGHT stick)
    masterVolume: 1.0,   // overall mix level
    musicVolume: 1.0,    // soundtrack + cinematic score level
    sfxVolume: 1.0,      // one-shot SFX level
    muted: false,        // global mute
    subtitles: true,     // show on-screen captions for voice-over / comms lines
    captionLang: 'en',   // caption localization locale ('en' | 'es' | ...) from captions.js
    difficulty: 'normal',// 'recruit' | 'normal' | 'veteran' | 'ace' — scales enemy/player toughness
    // Multiplayer voice transmit mode:
    //   'ptt' — push-to-talk: mic opens only while the Push-To-Talk key is held (default).
    //   'vox' — voice-activated: mic stays live and transmits automatically when you speak.
    voiceMode: 'ptt',
    // Squad Only voice: when on, you transmit to (and the speaking indicator routes to) just your
    // same-team squad instead of the whole team. Persisted so it survives between sessions; the live
    // toggle (Squad Voice key / menu switch) keeps this in sync.
    voiceSquadOnly: false,
    bindings: defaultBindings()
  };
}

// Difficulty presets. `incoming` scales damage the player TAKES, `enemyHp` scales hostile toughness,
// `playerDamage` scales the player's outgoing damage. `evasion` scales how hard/long hostiles juke
// when shot at or hit (<1 = they "give themselves up" sooner so the player can land shots; >1 =
// slipperier). Tuned so Recruit is forgiving and Ace is brutal.
export const DIFFICULTIES = {
  recruit:  { label: 'Recruit',  blurb: 'Forgiving — for learning the ropes', incoming: 0.6, enemyHp: 0.55, playerDamage: 1.4,  evasion: 0.45 },
  normal:   { label: 'Normal',   blurb: 'The intended Hammer Squadron fight',  incoming: 1.0, enemyHp: 0.78, playerDamage: 1.15, evasion: 0.7 },
  veteran:  { label: 'Veteran',  blurb: 'Hostiles hit harder and last longer', incoming: 1.4, enemyHp: 1.3, playerDamage: 0.9,  evasion: 1.0 },
  ace:      { label: 'Ace',      blurb: 'Brutal — one wrong move ends you',    incoming: 1.9, enemyHp: 1.6, playerDamage: 0.8,  evasion: 1.15 },
};
// Resolve the active difficulty preset (falls back to Normal for an unknown value).
export function difficultyMods() {
  return DIFFICULTIES[settings.difficulty] || DIFFICULTIES.normal;
}

// Base mouse movement scale (the original hard-coded values in main.js). The user-facing
// sensitivity multiplier scales these so 1.0 == the original feel.
export const BASE_MOUSE = { x: 0.0016, y: 0.0013 };

export const settings = load();

function load() {
  const s = defaultSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved.mouseSensX === 'number') s.mouseSensX = saved.mouseSensX;
      if (typeof saved.mouseSensY === 'number') s.mouseSensY = saved.mouseSensY;
      if (typeof saved.invertY === 'boolean') s.invertY = saved.invertY;
      if (typeof saved.invertX === 'boolean') s.invertX = saved.invertX;
      if (typeof saved.padInvertY === 'boolean') s.padInvertY = saved.padInvertY;
      if (typeof saved.padInvertX === 'boolean') s.padInvertX = saved.padInvertX;
      if (typeof saved.padSensX === 'number') s.padSensX = saved.padSensX;
      if (typeof saved.padSensY === 'number') s.padSensY = saved.padSensY;
      if (typeof saved.masterVolume === 'number') s.masterVolume = saved.masterVolume;
      if (typeof saved.musicVolume === 'number') s.musicVolume = saved.musicVolume;
      if (typeof saved.sfxVolume === 'number') s.sfxVolume = saved.sfxVolume;
      if (typeof saved.muted === 'boolean') s.muted = saved.muted;
      if (typeof saved.subtitles === 'boolean') s.subtitles = saved.subtitles;
      if (typeof saved.captionLang === 'string') s.captionLang = saved.captionLang;
      if (typeof saved.difficulty === 'string' && DIFFICULTIES[saved.difficulty]) s.difficulty = saved.difficulty;
      if (saved.voiceMode === 'ptt' || saved.voiceMode === 'vox') s.voiceMode = saved.voiceMode;
      if (typeof saved.voiceSquadOnly === 'boolean') s.voiceSquadOnly = saved.voiceSquadOnly;
      if (saved.bindings) {
        for (const a of ACTIONS) {
          if (Array.isArray(saved.bindings[a.id]) && saved.bindings[a.id].length) {
            const merged = saved.bindings[a.id].slice(0, a.slots);
            // Backfill any slots the saved data lacks (e.g. a newly-added Mouse slot) from the
            // current defaults, so existing players still get the new mouse fire bindings shown.
            for (let i = merged.length; i < a.slots; i++) merged[i] = a.defaults[i] || '';
            s.bindings[a.id] = merged;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Settings load failed, using defaults.', err);
  }
  return s;
}

export function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
  catch (err) { console.warn('Settings save failed.', err); }
}

export function resetSettings() {
  const d = defaultSettings();
  settings.mouseSensX = d.mouseSensX;
  settings.mouseSensY = d.mouseSensY;
  settings.invertY = d.invertY;
  settings.invertX = d.invertX;
  settings.padInvertY = d.padInvertY;
  settings.padInvertX = d.padInvertX;
  settings.padSensX = d.padSensX;
  settings.padSensY = d.padSensY;
  settings.masterVolume = d.masterVolume;
  settings.musicVolume = d.musicVolume;
  settings.sfxVolume = d.sfxVolume;
  settings.muted = d.muted;
  settings.subtitles = d.subtitles;
  settings.captionLang = d.captionLang;
  settings.difficulty = d.difficulty;
  settings.voiceMode = d.voiceMode;
  settings.voiceSquadOnly = d.voiceSquadOnly;
  settings.bindings = d.bindings;
  saveSettings();
}

// True if `code` is bound to `actionId`. main.js uses this in place of literal code checks.
export function isAction(actionId, code) {
  const arr = settings.bindings[actionId];
  return !!arr && arr.includes(code);
}

// Reverse lookup: which action(s) a key code triggers. Used for one-shot keydown handling.
export function actionsFor(code) {
  const out = [];
  for (const a of ACTIONS) {
    if (settings.bindings[a.id] && settings.bindings[a.id].includes(code)) out.push(a.id);
  }
  return out;
}

// Friendly label for a key code shown in the rebind UI.
export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5) + ' Arrow';
  const map = {
    Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', Tab: 'Tab',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    Enter: 'Enter', Backspace: 'Bksp', Escape: 'Esc', Backquote: '`',
    Mouse0: 'Left Mouse', Mouse1: 'Mid Mouse', Mouse2: 'Right Mouse'
  };
  return map[code] || code;
}

// Friendly label for an ACTION's primary (or all) bound key(s). Used by the interactive tutorial
// to show the live, rebind-aware prompt for each control (e.g. "W", "L Shift"). Returns the first
// non-empty binding's label by default, or every bound key joined with ` / ` when all=true.
export function bindLabel(actionId, all = false) {
  const arr = settings.bindings[actionId] || [];
  const labels = arr.filter(Boolean).map(keyLabel);
  if (!labels.length) return '—';
  return all ? labels.join(' / ') : labels[0];
}

// Rebind a single slot of an action to `code`, clearing that code from any OTHER slot so a
// key can't be double-bound. Returns true on success.
export function rebind(actionId, slotIndex, code) {
  const action = ACTIONS.find(a => a.id === actionId);
  if (!action || slotIndex < 0 || slotIndex >= action.slots) return false;
  // Remove `code` anywhere else it's currently bound.
  for (const a of ACTIONS) {
    const arr = settings.bindings[a.id];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === code && !(a.id === actionId && i === slotIndex)) arr[i] = '';
    }
  }
  const arr = settings.bindings[actionId];
  while (arr.length <= slotIndex) arr.push('');
  arr[slotIndex] = code;
  saveSettings();
  return true;
}
