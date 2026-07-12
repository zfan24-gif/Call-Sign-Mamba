// ---------------------------------------------------------------------------
// Settings / pause overlay controller.
//
// Owns the #settings panel: Audio mix, Controls (mouse sensitivity + rebindable
// keybindings), and About. Also drives the "Exit to Main Menu" confirm flow.
// Reads/writes the persisted settings model and pushes audio levels to the bus.
// ---------------------------------------------------------------------------
import { ACTIONS, settings, saveSettings, resetSettings, rebind, keyLabel, DIFFICULTIES } from './settings.js';

const $ = id => document.getElementById(id);

let listening = null;   // { actionId, slot, btn } while waiting for a key to bind, else null

// `audio` is the AudioBus; `onClose` runs when the panel closes (resume); `onExitToMenu`
// runs when the user confirms Exit to Main Menu.
// Static reference of how the controller maps to flight actions. Mirrors gamepad.js — keep in sync
// if button assignments change there. Glyphs use PS-style face labels with the standard mapping.
const PAD_MAP = [
  { btn: 'L-Stick',  act: 'Move (W/S/A/D)',      note: 'Thrust / reverse / strafe' },
  { btn: 'R-Stick',  act: 'Aim / Steer',         note: 'Pitch & yaw — replaces the mouse' },
  { btn: 'R2',       act: 'Fire Lasers',         note: 'Hold for auto-repeat' },
  { btn: 'L2',       act: 'Fire Missile' },
  { btn: '○',        act: 'Fire Missile',        note: 'Alternate' },
  { btn: '□',        act: 'Deploy Chaff' },
  { btn: '△',        act: 'Toggle View',         note: 'Cockpit / chase' },
  { btn: 'L3 / R3',  act: 'Boost',               note: 'Click either stick' },
  { btn: 'D-Pad ← / L1', act: 'Route Power: Shields' },
  { btn: '✕',        act: 'Route Power: Weapons' },
  { btn: 'D-Pad → / R1', act: 'Route Power: Engines' },
  { btn: 'Start',    act: 'Lock Nearest Target' },
  { btn: 'Select',   act: 'Cycle Target' },
];

// `getGamepad` (optional) returns the live GamepadInput so the panel can show connection status.
// `onVoiceMode` runs when the transmit mode (ptt/vox) changes; `onSquadOnly` runs when the
// Squad-Only toggle flips — both let main.js push the change into the live voice transport.
export function initSettingsUI(audio, { onClose, onExitToMenu, getGamepad, captionLocales, onCaptionLang, onVoiceMode, onSquadOnly } = {}) {
  const overlay = $('settings');
  // Whether the panel is currently opened from a connected multiplayer match (drives the Voice section).
  let mpContext = false;

  // ---- Apply persisted audio levels to the bus up front so saved settings take effect. ----
  function pushAudio() {
    audio.setMasterLevel(settings.masterVolume);
    audio.setMusicLevel(settings.musicVolume);
    audio.setSfxLevel(settings.sfxVolume);
    audio.setMuted(settings.muted);
  }
  pushAudio();

  // ---- Tabs ----
  const tabs = overlay.querySelectorAll('.setTab');
  const panels = overlay.querySelectorAll('.setTabPanel');
  function selectTab(name) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  }
  tabs.forEach(t => t.addEventListener('click', () => {
    selectTab(t.dataset.tab);
    if (t.dataset.tab === 'gamepad') syncPadStatus();   // refresh live connection state on open
    updateVizForTab(t.dataset.tab);                     // run the visualizer only on the gamepad tab
  }));

  // ---- Audio mix ----
  const pct = v => Math.round(v * 100) + '%';
  const volMaster = $('volMaster'), volMusic = $('volMusic'), volSfx = $('volSfx'), muteAll = $('muteAll');
  const volMasterVal = $('volMasterVal'), volMusicVal = $('volMusicVal'), volSfxVal = $('volSfxVal');
  function syncAudio() {
    volMaster.value = settings.masterVolume; volMasterVal.textContent = pct(settings.masterVolume);
    volMusic.value = settings.musicVolume;   volMusicVal.textContent = pct(settings.musicVolume);
    volSfx.value = settings.sfxVolume;        volSfxVal.textContent = pct(settings.sfxVolume);
    muteAll.classList.toggle('on', settings.muted);
    muteAll.setAttribute('aria-checked', settings.muted ? 'true' : 'false');
  }
  volMaster.addEventListener('input', () => { settings.masterVolume = +volMaster.value; volMasterVal.textContent = pct(+volMaster.value); audio.setMasterLevel(+volMaster.value); saveSettings(); });
  volMusic.addEventListener('input', () => { settings.musicVolume = +volMusic.value; volMusicVal.textContent = pct(+volMusic.value); audio.setMusicLevel(+volMusic.value); saveSettings(); });
  volSfx.addEventListener('input', () => { settings.sfxVolume = +volSfx.value; volSfxVal.textContent = pct(+volSfx.value); audio.setSfxLevel(+volSfx.value); saveSettings(); });
  const toggleMute = () => { settings.muted = !settings.muted; audio.setMuted(settings.muted); syncAudio(); saveSettings(); };
  muteAll.addEventListener('click', toggleMute);
  muteAll.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggleMute(); } });

  // ---- Subtitles toggle (Game tab, Accessibility) ----
  const subtitlesToggle = $('subtitlesToggle');
  function syncSubtitles() {
    if (!subtitlesToggle) return;
    subtitlesToggle.classList.toggle('on', settings.subtitles);
    subtitlesToggle.setAttribute('aria-checked', settings.subtitles ? 'true' : 'false');
  }
  const toggleSubtitles = () => {
    settings.subtitles = !settings.subtitles;
    syncSubtitles();
    saveSettings();
    // Hide any caption immediately when turned off so it doesn't linger on screen.
    if (!settings.subtitles) { const s = $('subtitles'); if (s) s.classList.remove('show'); }
    audio.play('shield', 0.2);
  };
  if (subtitlesToggle) {
    subtitlesToggle.addEventListener('click', toggleSubtitles);
    subtitlesToggle.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggleSubtitles(); } });
  }

  // ---- Caption language select (Game tab, Accessibility) — drives the captions.js locale layer ----
  const captionLangSelect = $('captionLangSelect');
  // Human labels for the locale codes captions.js exposes; codes without a label show uppercased.
  const LOCALE_LABELS = { en: 'English', es: 'Español' };
  if (captionLangSelect) {
    const locales = (captionLocales && captionLocales.length) ? captionLocales : ['en'];
    captionLangSelect.innerHTML = '';
    for (const code of locales) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = LOCALE_LABELS[code] || code.toUpperCase();
      captionLangSelect.appendChild(opt);
    }
    captionLangSelect.addEventListener('change', () => {
      settings.captionLang = captionLangSelect.value;
      saveSettings();
      if (onCaptionLang) onCaptionLang(settings.captionLang);   // push the new locale into the live engine
      audio.play('shield', 0.2);
    });
  }
  function syncCaptionLang() {
    if (captionLangSelect) captionLangSelect.value = settings.captionLang || 'en';
  }

  // ---- Difficulty (Game tab) ----
  // Render the difficulty presets as a single-select radio list. Clicking one stores it and saves;
  // it takes effect immediately for in-flight tuning and on the next mission's setup.
  const diffList = $('difficultyList');
  function renderDifficulty() {
    diffList.innerHTML = '';
    for (const [key, d] of Object.entries(DIFFICULTIES)) {
      const opt = document.createElement('button');
      opt.className = 'diffOpt' + (settings.difficulty === key ? ' active' : '');
      opt.innerHTML = `<span class="diffRadio"></span><span class="diffText"><span class="diffName">${d.label}</span><span class="diffBlurb">${d.blurb}</span></span>`;
      opt.addEventListener('click', () => {
        settings.difficulty = key;
        saveSettings();
        renderDifficulty();
        audio.play('shield', 0.25);
      });
      diffList.appendChild(opt);
    }
  }

  // ---- Voice comms (multiplayer pause only) ----
  // Toggles the Game tab between the single-player Difficulty block and the multiplayer Voice block,
  // renders the transmit-mode radios, the Squad-Only switch, and the (read-only) keybind chips for
  // the Push-To-Talk and Squad-Voice-Toggle actions so pilots can see their current bindings.
  const gameDifficulty = $('gameDifficulty');
  const gameVoice = $('gameVoice');
  const voiceModes = $('voiceModes');
  const voicePttRow = $('voicePttRow');
  const voicePttKeys = $('voicePttKeys');
  const voiceSquadKeys = $('voiceSquadKeys');
  const voiceSquadToggle = $('voiceSquadToggle');

  // Paint a read-only row of key chips for an action's current bindings. Clicking a chip opens the
  // same rebind-listen flow used by the Controls tab, then re-renders the voice chips on capture.
  function renderVoiceKeys(container, actionId) {
    if (!container) return;
    const action = ACTIONS.find(a => a.id === actionId);
    container.innerHTML = '';
    const slots = action ? action.slots : 1;
    for (let slot = 0; slot < slots; slot++) {
      const code = (settings.bindings[actionId] || [])[slot] || '';
      const btn = document.createElement('button');
      btn.className = 'keyBtn';
      btn.textContent = keyLabel(code);
      btn.addEventListener('click', () => startListening(actionId, slot, btn));
      container.appendChild(btn);
    }
  }
  function syncVoiceModeRadios() {
    if (!voiceModes) return;
    voiceModes.querySelectorAll('.voiceMode').forEach(b => {
      const on = b.dataset.mode === settings.voiceMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    // The Push-To-Talk key row is only meaningful in PTT mode.
    if (voicePttRow) voicePttRow.style.display = (settings.voiceMode === 'vox') ? 'none' : '';
  }
  function syncSquadToggle() {
    if (!voiceSquadToggle) return;
    voiceSquadToggle.classList.toggle('on', settings.voiceSquadOnly);
    voiceSquadToggle.setAttribute('aria-checked', settings.voiceSquadOnly ? 'true' : 'false');
  }
  // Public: repaint the whole Voice section. Called by main.js (e.g. after an in-flight squad toggle).
  function syncVoice() {
    syncVoiceModeRadios();
    syncSquadToggle();
    renderVoiceKeys(voicePttKeys, 'pushToTalk');
    renderVoiceKeys(voiceSquadKeys, 'squadVoice');
  }
  if (voiceModes) {
    voiceModes.querySelectorAll('.voiceMode').forEach(b => {
      b.addEventListener('click', () => {
        const mode = b.dataset.mode;
        if (mode !== 'ptt' && mode !== 'vox') return;
        if (settings.voiceMode === mode) return;
        settings.voiceMode = mode;
        saveSettings();
        syncVoiceModeRadios();
        audio.play('shield', 0.22);
        onVoiceMode && onVoiceMode(mode);
      });
    });
  }
  if (voiceSquadToggle) {
    const toggleSquad = () => {
      settings.voiceSquadOnly = !settings.voiceSquadOnly;
      saveSettings();
      syncSquadToggle();
      audio.play('shield', 0.22);
      onSquadOnly && onSquadOnly(settings.voiceSquadOnly);
    };
    voiceSquadToggle.addEventListener('click', toggleSquad);
    voiceSquadToggle.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggleSquad(); } });
  }
  // Swap the Game tab between Difficulty (solo) and Voice (multiplayer pause).
  function applyGameContext() {
    if (gameDifficulty) gameDifficulty.style.display = mpContext ? 'none' : '';
    if (gameVoice) gameVoice.style.display = mpContext ? '' : 'none';
  }

  // ---- Mouse sensitivity ----
  const sensX = $('sensX'), sensY = $('sensY'), invertY = $('invertY'), invertX = $('invertX');
  const sensXVal = $('sensXVal'), sensYVal = $('sensYVal');
  // Gamepad right-stick aim invert (independent of the mouse invert; Y defaults to inverted).
  const padInvertY = $('padInvertY'), padInvertX = $('padInvertX');
  // Gamepad right-stick aim sensitivity sliders (independent of the mouse sensitivity).
  const padSensX = $('padSensX'), padSensY = $('padSensY');
  const padSensXVal = $('padSensXVal'), padSensYVal = $('padSensYVal');
  function syncMouse() {
    sensX.value = settings.mouseSensX; sensXVal.textContent = (+settings.mouseSensX).toFixed(2);
    sensY.value = settings.mouseSensY; sensYVal.textContent = (+settings.mouseSensY).toFixed(2);
    invertY.classList.toggle('on', settings.invertY);
    invertY.setAttribute('aria-checked', settings.invertY ? 'true' : 'false');
    invertX.classList.toggle('on', settings.invertX);
    invertX.setAttribute('aria-checked', settings.invertX ? 'true' : 'false');
    if (padInvertY) {
      padInvertY.classList.toggle('on', settings.padInvertY);
      padInvertY.setAttribute('aria-checked', settings.padInvertY ? 'true' : 'false');
    }
    if (padInvertX) {
      padInvertX.classList.toggle('on', settings.padInvertX);
      padInvertX.setAttribute('aria-checked', settings.padInvertX ? 'true' : 'false');
    }
    if (padSensX) { padSensX.value = settings.padSensX; padSensXVal.textContent = (+settings.padSensX).toFixed(2); }
    if (padSensY) { padSensY.value = settings.padSensY; padSensYVal.textContent = (+settings.padSensY).toFixed(2); }
  }
  sensX.addEventListener('input', () => { settings.mouseSensX = +sensX.value; sensXVal.textContent = (+sensX.value).toFixed(2); saveSettings(); });
  sensY.addEventListener('input', () => { settings.mouseSensY = +sensY.value; sensYVal.textContent = (+sensY.value).toFixed(2); saveSettings(); });
  const toggleInvert = () => { settings.invertY = !settings.invertY; invertY.classList.toggle('on', settings.invertY); invertY.setAttribute('aria-checked', settings.invertY ? 'true' : 'false'); saveSettings(); };
  invertY.addEventListener('click', toggleInvert);
  invertY.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggleInvert(); } });
  const toggleInvertX = () => { settings.invertX = !settings.invertX; invertX.classList.toggle('on', settings.invertX); invertX.setAttribute('aria-checked', settings.invertX ? 'true' : 'false'); saveSettings(); };
  invertX.addEventListener('click', toggleInvertX);
  invertX.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggleInvertX(); } });
  // Gamepad right-stick aim invert toggles.
  if (padInvertY) {
    const toggle = () => { settings.padInvertY = !settings.padInvertY; padInvertY.classList.toggle('on', settings.padInvertY); padInvertY.setAttribute('aria-checked', settings.padInvertY ? 'true' : 'false'); saveSettings(); };
    padInvertY.addEventListener('click', toggle);
    padInvertY.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggle(); } });
  }
  if (padInvertX) {
    const toggle = () => { settings.padInvertX = !settings.padInvertX; padInvertX.classList.toggle('on', settings.padInvertX); padInvertX.setAttribute('aria-checked', settings.padInvertX ? 'true' : 'false'); saveSettings(); };
    padInvertX.addEventListener('click', toggle);
    padInvertX.addEventListener('keydown', e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); toggle(); } });
  }
  // Gamepad right-stick aim sensitivity sliders.
  if (padSensX) padSensX.addEventListener('input', () => { settings.padSensX = +padSensX.value; padSensXVal.textContent = (+padSensX.value).toFixed(2); saveSettings(); });
  if (padSensY) padSensY.addEventListener('input', () => { settings.padSensY = +padSensY.value; padSensYVal.textContent = (+padSensY.value).toFixed(2); saveSettings(); });

  // ---- Keybinding rows ----
  const bindList = $('bindList');
  function renderBindings() {
    bindList.innerHTML = '';
    for (const action of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'bindRow';
      const name = document.createElement('span');
      name.textContent = action.label;
      const keysWrap = document.createElement('div');
      keysWrap.className = 'bindKeys';
      for (let slot = 0; slot < action.slots; slot++) {
        const code = (settings.bindings[action.id] || [])[slot] || '';
        const btn = document.createElement('button');
        btn.className = 'keyBtn';
        btn.textContent = keyLabel(code);
        btn.addEventListener('click', () => startListening(action.id, slot, btn));
        keysWrap.appendChild(btn);
      }
      row.appendChild(name);
      row.appendChild(keysWrap);
      bindList.appendChild(row);
    }
  }
  function startListening(actionId, slot, btn) {
    cancelListening();
    listening = { actionId, slot, btn };
    btn.classList.add('listening');
    btn.textContent = 'PRESS…';
  }
  function cancelListening() {
    if (listening) listening.btn.classList.remove('listening');
    listening = null;
  }
  // Capture the next key while listening, in the CAPTURE phase so it never reaches gameplay.
  document.addEventListener('keydown', e => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') rebind(listening.actionId, listening.slot, e.code);
    cancelListening();
    renderBindings();
    syncVoice();   // keep the Voice-section PTT/squad chips in sync if that was the source
  }, true);
  // Also allow binding a MOUSE button to a slot. Capture mousedown (so it never reaches gameplay),
  // but ignore the press on the listening button itself so opening the bind doesn't instantly
  // self-assign. Mouse codes are Mouse0 (left) / Mouse1 (middle) / Mouse2 (right).
  document.addEventListener('mousedown', e => {
    if (!listening) return;
    if (e.target === listening.btn) return;   // the click that opened this bind; wait for the next input
    e.preventDefault();
    e.stopPropagation();
    rebind(listening.actionId, listening.slot, 'Mouse' + e.button);
    cancelListening();
    renderBindings();
    syncVoice();
  }, true);

  // ---- Gamepad reference tab ----
  const padMap = $('padMap');
  const padStatus = $('padStatus');
  function renderPadMap() {
    if (padMap.childElementCount) return;   // static — build once
    padMap.innerHTML = '';
    for (const m of PAD_MAP) {
      const row = document.createElement('div');
      row.className = 'padRow';
      const note = m.note ? `<span class="padNote">${m.note}</span>` : '';
      row.innerHTML =
        `<span class="padBtn">${m.btn}</span>` +
        `<span class="padActWrap"><span class="padAct">${m.act}</span>${note}</span>`;
      padMap.appendChild(row);
    }
  }
  function syncPadStatus() {
    const gp = getGamepad && getGamepad();
    const on = !!(gp && gp.connected);
    padStatus.classList.toggle('connected', on);
    padStatus.textContent = on
      ? `Controller connected: ${gp.label || 'Gamepad'}. Mapping shown below.`
      : 'No controller detected. Connect a pad and press any button — supports PS3/DualShock-style and standard-mapping gamepads.';
  }

  // ---- Live input visualizer ----
  // A lightweight RAF loop runs ONLY while the panel is open on the gamepad tab. It reads a
  // read-only snapshot from the GamepadInput (no steering/key mutation) and lights up the SVG.
  const padViz = $('padViz');
  const vizEls = padViz ? Array.from(padViz.querySelectorAll('.padEl')) : [];
  const vizSticks = padViz ? Array.from(padViz.querySelectorAll('.padStick')) : [];
  // Cache each stick's resting centre so we can offset its cap by the live axis values.
  const stickHome = vizSticks.map(s => ({ el: s, cx: +s.getAttribute('cx'), cy: +s.getAttribute('cy'),
    axis: s.dataset.stick === 'L' ? 0 : 2 }));
  let vizRAF = null;
  function vizFrame() {
    const gp = getGamepad && getGamepad();
    const st = gp && gp.readState ? gp.readState() : null;
    for (const el of vizEls) {
      const i = +el.dataset.btn;
      const on = !!(st && st.buttons[i]);
      if (on !== el.classList.contains('on')) el.classList.toggle('on', on);
    }
    // Move the stick caps to reflect axis deflection (capped to the well radius).
    for (const s of stickHome) {
      const x = st ? (st.axes[s.axis] || 0) : 0;
      const y = st ? (st.axes[s.axis + 1] || 0) : 0;
      const R = 9;   // max visual travel in SVG units
      s.el.setAttribute('transform', `translate(${(x * R).toFixed(1)} ${(y * R).toFixed(1)})`);
    }
    vizRAF = requestAnimationFrame(vizFrame);
  }
  function startViz() { if (!vizRAF && padViz) vizFrame(); }
  function stopViz() {
    if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
    vizEls.forEach(el => el.classList.remove('on'));
    stickHome.forEach(s => s.el.removeAttribute('transform'));
  }
  // Only animate when the gamepad tab is the active one.
  function updateVizForTab(name) { if (name === 'gamepad') startViz(); else stopViz(); }

  // ---- Footer actions ----
  const close = () => {
    cancelListening();
    hideConfirm();
    stopViz();
    overlay.classList.remove('show');
    onClose && onClose();
  };
  $('setClose').addEventListener('click', close);
  $('setReset').addEventListener('click', () => { resetSettings(); pushAudio(); syncAll(); });

  // Exit-to-menu confirm flow.
  const confirm = $('exitConfirm');
  const showConfirm = () => confirm.classList.add('show');
  const hideConfirm = () => confirm.classList.remove('show');
  $('setExit').addEventListener('click', showConfirm);
  $('exitCancel').addEventListener('click', hideConfirm);
  $('exitYes').addEventListener('click', () => {
    hideConfirm();
    stopViz();
    overlay.classList.remove('show');
    onExitToMenu && onExitToMenu();
  });

  function syncAll() { syncAudio(); syncSubtitles(); syncCaptionLang(); syncMouse(); renderBindings(); renderDifficulty(); syncVoice(); applyGameContext(); renderPadMap(); syncPadStatus(); }
  syncAll();

  return {
    // `opts.multiplayer` swaps the Game tab's Difficulty block for the Voice Comms block.
    open(headingText, subheadText, closeLabel, opts = {}) {
      mpContext = !!opts.multiplayer;
      if (headingText) $('setHeading').textContent = headingText;
      if (subheadText) $('setSubhead').textContent = subheadText;
      // "Resume" when paused mid-mission; "Done" when opened from the main menu.
      $('setClose').textContent = closeLabel || 'Resume';
      // Exit-to-menu only makes sense from an active mission; hide it on the main menu.
      $('setExit').style.display = (headingText === 'Settings') ? 'none' : '';
      hideConfirm();
      selectTab('game');
      stopViz();          // panel opens on the Game tab; viz stays idle until the Gamepad tab is picked
      syncAll();
      overlay.classList.add('show');
    },
    close,
    syncVoice,
    isOpen() { return overlay.classList.contains('show'); }
  };
}
