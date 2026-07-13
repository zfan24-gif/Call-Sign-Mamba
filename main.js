import * as THREE from 'three';
import { initScene, makeEnemy, makeAlly, makeContainer, makeBolt, makeMissile, makeChaff, spark, explode, spawnSmokePuff, updateEngineTrails, disposeEngineEffects, setEngineEffectsVisible, flashPlayerShield, updatePlayerShield, preloadModels, preloadAudio, updateDebrisField, reseedDebrisField, updateShieldDome, registerShieldHit, setSceneDevMode, swapPlayerHull, CONTAINER_MODEL_URLS } from './scene.js';
import { AudioBus } from './audio.js';
import { createPlayerState, missions, pickDraft } from './gameState.js';
import { OpeningCutscene, paintStarfieldCanvas } from './cutscene.js';
import { Mission3Cutscene } from './mission3cutscene.js';
import { WarpOut } from './warpout.js';
import { WarpIn } from './warpin.js';
import { settings, saveSettings, isAction, actionsFor, keyLabel, bindLabel, BASE_MOUSE, difficultyMods } from './settings.js';
import { TutorialController } from './tutorial.js';
import { initSettingsUI } from './settingsUI.js';
import { initTargetGhost, renderTargetGhost } from './targetGhost.js';
import { HangarView } from './hangar.js';
import { GamepadInput } from './gamepad.js';
import { HudTuner } from './hudTuner.js';
import { getCardFrameBackground } from './cardFrame.js';
import { Captions } from './captions.js';
import * as leaderboard from './leaderboard.js';
import * as ranks from './ranks.js';
import * as cosmetics from './cosmetics.js';
import { Multiplayer } from './multiplayer.js';
import { VoiceTransport } from './voiceTransport.js';
import { SHIPS, SHIP_ORDER, getShip, loadShipChoice, saveShipChoice, shipsForTeam, defaultShipForTeam, paletteForShip, RED_SHIPS } from './shipRoster.js';
import { mountShipPreviews, startShipPreviews, stopShipPreviews, setSelectedPreview } from './shipPreview.js';
import { HangarPreview } from './hangarPreview.js';

const container = document.getElementById('game-container');
const ui = document.getElementById('ui-container');
const { scene, camera, renderer, player, trails, boltGroup, missileGroup, enemies, allies, explosions, debris, skyTex, skyBlack } = initScene(container);

// Empty a ship GROUP (enemies/allies) SAFELY. A ship's engine exhaust trail + beam-streak meshes
// live in the WORLD-SPACE trailGroup, NOT under the ship, so a plain group.clear() removes the ship
// but ORPHANS its exhaust — it keeps rendering forever. That's how capital-ship (and other) exhaust
// trails piled up across missions on a full-campaign restart. Dispose each ship's engine effects
// first, then clear the group so nothing is left streaking in the scene.
function clearShipGroup(group) {
  for (const s of [...group.children]) disposeEngineEffects(s);
  group.clear();
}
const audio = new AudioBus();
const state = createPlayerState();
// The player's currently-equipped Ship-Hangar cosmetics (laser color / trail palette / missile FX),
// resolved from cosmetics.js for the hull we're flying. Refreshed by refreshPlayerCosmetics() every
// time the player hull is (re)built, and read at fire time so equipped colors take effect in flight.
let _playerCosmetics = cosmetics.resolved('lightning');
// Which hull the player is currently flying (Lightning in the campaign; the hangar pick in free
// flight). Used to resolve the right per-ship cosmetic loadout.
function activePlayerShipId() { return freeFlightMode ? (_selectedShipId || 'lightning') : 'lightning'; }
function refreshPlayerCosmetics() { _playerCosmetics = cosmetics.resolved(activePlayerShipId()); }
const timer = new THREE.Timer();
const keys = new Set();
// Keys the PHYSICAL keyboard currently holds. Tracked separately from `keys` (which also receives
// synthetic gamepad presses) so the gamepad poll can NEVER delete a key the keyboard is physically
// holding. This is the root-cause guard for the "W thrust randomly drops" bug: an idle/phantom pad
// releasing its synthetic thrust must not clobber a real, still-held W.
const kbHeld = new Set();
const mouse = { x: 0, y: 0, locked: false };
// Controller support: the pad writes into the same `mouse.x/.y` steering offset and injects
// synthetic key codes into `keys`, so it flows through the existing flight/bindings model.
const gamepad = new GamepadInput();
let gamepadSteered = false;   // true when the stick produced steering this frame (skips mouse recenter)
// DEV: live HUD layout tuner (K) for nudging/resizing the cockpit dashboard panels.
const hudTuner = new HudTuner();
// When the tuner opens, drop any held flight keys, re-center the mouse steering offset so the ship
// is fully neutral, and RELEASE pointer lock so the cursor is free to drag/resize the HUD overlays.
// Closing it doesn't force-relock — the pilot clicks the canvas to re-grab flight control as usual.
hudTuner.onToggle = (on) => {
  if (!on) return;
  keys.clear(); kbHeld.clear();
  mouse.x = 0; mouse.y = 0;
  if (document.pointerLockElement) document.exitPointerLock();
};
gamepad.onConnect = label => flash('CONTROLLER CONNECTED');
gamepad.onDisconnect = () => flash('CONTROLLER DISCONNECTED');
// First KeyboardEvent.code bound to an action, so synthetic controller presses honour rebinds.
function bindingFor(action) {
  const arr = settings.bindings[action];
  return (arr && arr.find(c => c)) || null;
}
// Pointer lock can REJECT if requested during the browser's brief cooldown right after the user
// exited a lock (Esc / leaving the lock). The returned promise rejects with a SecurityError; if we
// ignore it, it surfaces as an unhandled rejection in the console. Swallow that race and retry once
// after the cooldown so aim re-locks cleanly on the next frame batch.
let _lockRetry = null;
function lockPointer() {
  const el = renderer.domElement;
  if (!el || typeof el.requestPointerLock !== 'function') return;
  // Never steal the cursor back while a dev calibration rig (P/O) is open — the user needs it free.
  if (typeof devRigOpen === 'function' && devRigOpen()) return;
  if (document.pointerLockElement === el) return;
  const res = el.requestPointerLock();
  if (res && typeof res.then === 'function') {
    res.catch(() => {
      // Retry once after the lock cooldown elapses (browsers gate ~1s after an exit).
      clearTimeout(_lockRetry);
      _lockRetry = setTimeout(() => {
        if (document.pointerLockElement !== el && el.isConnected) {
          const r2 = el.requestPointerLock();
          if (r2 && typeof r2.then === 'function') r2.catch(() => {});
        }
      }, 350);
    });
  }
}
const aim = new THREE.Vector2();
const forward = new THREE.Vector3();
let view = 'first', fireCooldown = 0, missionIndex = 0, mission = null, capture = 0, waveClear = false, draftOptions = [];
// Missile lock: keeping the locked enemy framed inside the reticle for LOCK_TIME seconds arms
// a guided shot. lockProgress climbs while the target is in the reticle and decays when it
// drifts out; missileLocked flips true once it tops out.
const LOCK_TIME = 4.0;
// Missile engagement envelope. A lock cannot even begin outside MISSILE_LOCK_RANGE metres — the
// seeker simply can't acquire a contact that far off. Launch distance also decides how hard the
// missile is to shake: a shot from up close arrives with almost no reaction time (near-full turn
// authority), while a shot loosed near max range gives the target plenty of room to out-turn it
// (reduced turn authority). See missileTurnForRange(). NOTE: this is DEFENSIVE-FLIGHT evasion only;
// chaff seduction is handled separately and unchanged.
const MISSILE_LOCK_RANGE = 325;    // metres — no lock can be acquired beyond this
const MISSILE_TURN_NEAR = 3.1;     // rad/s turn authority for a point-blank launch (hard to evade)
const MISSILE_TURN_FAR = 1.15;     // rad/s turn authority for a launch near max range (easy to evade)
// Map a launch distance to the missile's turn-rate (steering authority). Closer = more agile.
function missileTurnForRange(dist) {
  const k = THREE.MathUtils.clamp((dist || 0) / MISSILE_LOCK_RANGE, 0, 1);
  return THREE.MathUtils.lerp(MISSILE_TURN_NEAR, MISSILE_TURN_FAR, k);
}
let lockProgress = 0, missileLocked = false;
let defendTarget = null;   // allied flagship the player escorts in DEFEND missions (null otherwise)
let protectOG = null;      // the damaged (slow/smoking, still-flying) O.G. the player guards in Mission 3 (null otherwise)
let mission3IntroStarted = false;          // Mission 3 wingman-intro sequence fired once
let _mission3IntroTimers = [];             // pending Mission 3 intro/bark timers (cancelled on bail)
let _ogRepairDoneBark = false;             // Mission 3 "repairs complete" callout armed once
let _ogHalfHealthBark = false;             // Mission 3 "O.G. dropped to 50% health" callout armed once
let _m3JumpArmed = false;                  // Mission 3 "ship fixed" VO done; jump-to-hyperspace (H) now allowed
let _m3RepairLineStarted = false;          // Mission 3 "ship fixed" VO has begun (one-shot trigger guard)
let _m3OutroTimers = [];                   // pending Mission 3 outro/overwatch timers (cancelled on bail)
let m3SpawnT = 0;                          // Mission 3 reinforcement-wave spawn cooldown
// Rolling "recent damage to the player" signal (decays over time). The named wingmen Slick & O.G.
// watch this: if it climbs past a threshold (the player is taking a beating) they peel off the
// capital's batteries to cover the player by engaging enemy fighters, then return to the batteries
// once the heat dies down and the player has recovered. Hysteresis avoids rapid role flip-flop.
let recentPlayerDamage = 0;
let wingmenCovering = false;
// Mission 2 scripted wingman introduction. The two wingmen spawn HELD (hidden, frozen) and are
// warped in on cue: Slick over the right shoulder as the player drops out of hyperspace (his intro
// line plays with radio static), O.G. over the left shoulder 5s into Slick's line, then O.G.'s line
// 0.5s after Slick's ends. introState tracks whether the sequence has been kicked off this mission.
let introSlick = null, introOG = null;
let mission2IntroStarted = false;
let _mission2IntroTimers = [];
// Reactive Mission 2 wingman comms barks — each fires at most once per mission.
let _slickHitBark = false;   // Slick took >50% shield damage
let _ogDownBark = false;     // O.G. took 100% shield damage
let _mission2BarkTimers = [];
// Shield-generator destruction callouts. FIRST generator down -> a random SLICK line; SECOND
// generator down -> a random O.G. line. Five clips each; we shuffle a rotation per pool so each
// play-through cycles fresh through all five before any repeats. Guarded so each fires once.
const SLICK_GEN_CLIPS = [
  'assets/audio/voice/mission-2/shield-gen/slickgeneratordown.mp3',
  'assets/audio/voice/mission-2/shield-gen/slickgeneratordown2.mp3',
  'assets/audio/voice/mission-2/shield-gen/slickgeneratordown3.mp3',
  'assets/audio/voice/mission-2/shield-gen/slickgeneratordown4.mp3',
  'assets/audio/voice/mission-2/shield-gen/slickgeneratordown5.mp3',
];
const OG_GEN_CLIPS = [
  'assets/audio/voice/mission-2/shield-gen/ogshieldgenkilled.mp3',
  'assets/audio/voice/mission-2/shield-gen/ogshieldgenkilled2.mp3',
  'assets/audio/voice/mission-2/shield-gen/ogshieldgenkilled3.mp3',
  'assets/audio/voice/mission-2/shield-gen/ogshieldgenkilled4.mp3',
  'assets/audio/voice/mission-2/shield-gen/ogshieldgenkilled5.mp3',
];
let _firstGenCalled = false, _secondGenCalled = false;
// Pick a random clip from a pool, avoiding the same one twice in a row across the session.
const _genClipLast = new WeakMap();
function pickGenClip(pool) {
  if (pool.length <= 1) return pool[0];
  const last = _genClipLast.get(pool);
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick === last) pick = pool[(pool.indexOf(pick) + 1) % pool.length];   // nudge off a repeat
  _genClipLast.set(pool, pick);
  return pick;
}
// ---- Wingman RESCUE barks (any mission) -----------------------------------------------------
// Whenever the player kills a bandit that was targeting / firing at a named wingman, that wingman
// thanks the player. Three lines each for Slick & O.G. (assets/audio/voice/shared); pick one at
// random (avoiding an immediate repeat), with a short global cooldown so a multi-kill streak in a
// furball doesn't stack the thank-yous on top of each other.
const SLICK_RESCUE_CLIPS = [
  'assets/audio/voice/shared/slickappreciatedmamba.mp3',
  'assets/audio/voice/shared/slickniceshot.mp3',
  'assets/audio/voice/shared/slickthanksmamba.mp3',
];
const OG_RESCUE_CLIPS = [
  'assets/audio/voice/shared/ogsketchythanks.mp3',
  'assets/audio/voice/shared/ogthanks.mp3',
  'assets/audio/voice/shared/ogwhew.mp3',
];
let _rescueBarkCooldown = 0;   // seconds remaining before another rescue thank-you may play
// Play a rescue thank-you for the given wingman kind ('slick' | 'og'), respecting the cooldown.
function playWingmanRescueBark(kind) {
  if (_rescueBarkCooldown > 0) return;
  const pool = kind === 'slick' ? SLICK_RESCUE_CLIPS : kind === 'og' ? OG_RESCUE_CLIPS : null;
  if (!pool) return;
  const url = pickGenClip(pool);
  const speaker = kind === 'slick' ? 'SLICK' : 'O.G.';
  const el = audio.playClip(url, 0.95);
  captionVoice(url, speaker, el);
  _rescueBarkCooldown = 4.5;   // hold off other rescue barks briefly
}
// ---- Wingman KILL-CONFIRMATION barks (any mission) ------------------------------------------
// When Slick or O.G. destroys an enemy, the pilot who scored the kill calls it out. Several lines
// each (assets/audio/voice/shared/wingmenkills), filename-prefixed by pilot. Picked at random
// (no immediate repeat) and gated by a short global cooldown so a wingman shredding a furball
// doesn't machine-gun the callouts.
const SLICK_KILL_CLIPS = [
  'assets/audio/voice/shared/wingmenkills/slickbitterend.mp3',
  'assets/audio/voice/shared/wingmenkills/slickdeleted.mp3',
  'assets/audio/voice/shared/wingmenkills/slickexploded.mp3',
  'assets/audio/voice/shared/wingmenkills/slickniceexplosion.mp3',
  'assets/audio/voice/shared/wingmenkills/slickniceknowing.mp3',
  'assets/audio/voice/shared/wingmenkills/slickthatonetried.mp3',
  'assets/audio/voice/shared/wingmenkills/slicktheydont.mp3',
];
const OG_KILL_CLIPS = [
  'assets/audio/voice/shared/wingmenkills/oggivenup.mp3',
  'assets/audio/voice/shared/wingmenkills/ogminusone.mp3',
  'assets/audio/voice/shared/wingmenkills/ogoneless.mp3',
  'assets/audio/voice/shared/wingmenkills/ogprettyfireball.mp3',
  'assets/audio/voice/shared/wingmenkills/ogscratchanother.mp3',
  'assets/audio/voice/shared/wingmenkills/ogscratchone.mp3',
  'assets/audio/voice/shared/wingmenkills/ogwentwell.mp3',
];
let _killBarkCooldown = 0;   // seconds remaining before another wingman kill-confirm may play
// Play a kill confirmation for the wingman kind ('slick' | 'og') that just scored, with cooldown.
function playWingmanKillBark(kind) {
  if (_killBarkCooldown > 0) return;
  const pool = kind === 'slick' ? SLICK_KILL_CLIPS : kind === 'og' ? OG_KILL_CLIPS : null;
  if (!pool) return;
  const url = pickGenClip(pool);
  const speaker = kind === 'slick' ? 'SLICK' : 'O.G.';
  const el = audio.playClip(url, 0.92);
  captionVoice(url, speaker, el);
  _killBarkCooldown = 4.0;   // brief hold so kill calls don't stack in a furball
}
// ---- SUBTITLES / CAPTIONS ------------------------------------------------------------------
// Localized, TIME-SYNCED captions for every voice-over / squadron-comms line, toggled by
// settings.subtitles (Settings > Game > Accessibility). The caption data + sync engine live in
// captions.js: each clip maps to an ordered list of phrase-level cues that are surfaced based on
// the clip's REAL playback position, so subtitles advance with the speech instead of dumping the
// whole line at once. A locale layer (en/es...) lets the text be swapped per language.
// MASTER SUBTITLE SWITCH: the current caption text doesn't match the in-game VO, so captions are
// force-disabled for now regardless of the user's Settings toggle. Flip back to true to re-enable
// the time-synced caption engine once the caption tracks are corrected.
const CAPTIONS_ON = false;
const captions = new Captions({
  enabled: () => CAPTIONS_ON && settings.subtitles,
  render: (speaker, text) => {
    const el = $('subtitles');
    if (!el) return;
    if (!text) { el.classList.remove('show'); return; }
    el.querySelector('.subSpeaker').textContent = speaker || '';
    el.querySelector('.subText').textContent = text;
    el.classList.add('show');
  },
});
// The randomized shield-generator barks live in arrays here; hand them to the caption engine so
// those clips get captioned too (first gen = Slick, second = O.G.).
captions.registerGenClips(SLICK_GEN_CLIPS, OG_GEN_CLIPS);

// Caption a spoken clip: bind the live caption track to the clip's actual <audio> element so cues
// stay in sync with playback. `audioEl` is the element returned by audio.playClip/playRadioClip;
// when it's omitted we still clear any prior caption (and the engine no-ops on unknown clips).
function captionVoice(url, _speaker = '', audioEl = null) {
  if (!CAPTIONS_ON || !settings.subtitles) { captions.clear(); return; }
  captions.attach(url, audioEl);
}
// Hide/stop the active caption (used on briefing skip, menu bail, scene changes).
function hideSubtitle() { captions.clear(); }

// ---- Interactive flight-controls tutorial ----------------------------------------------------
// A standalone, step-by-step flight school (tutorial.js drives the step state machine + on-screen
// banner). It runs as its own gameplay mode: a synthetic `mission` with `tutorial:true`, the real
// ship in the real scene, stationary cargo-container targets, then a 3-fighter warp-in dogfight.
// `tutorialMode` gates the tutorial-specific branches in the gameplay loop/mission/AI code.
let tutorialMode = false;
let tutorialContainers = 0;   // live count of un-destroyed target containers (for diagnostics/flow)
// ---- Multiplayer: server-authoritative "Free Flight" arena -----------------------------------
// An additive open-space mode where the player joins the authoritative Colyseus arena server (see
// /server-realtime) and shares a 12v12 volume with other online pilots, rendered via snapshot
// interpolation while the local ship uses client-side prediction. `freeFlightMode` gates the
// Free-Flight-specific branches (no local objectives/hostiles; the net client owns ship sync).
// PHASE 1 = authoritative movement; shooting/damage/scoring are Phase 2+ (see server TODOs).
let freeFlightMode = false;
// The arena server endpoint. Change this ONE constant to point at your hosted Colyseus server:
//   local dev:   'ws://localhost:2567'
//   production:  'wss://your-arena-host.example.com'   (wss:// is required once the page is https)
// Run the server from /server-realtime (see its README.md). When it's unreachable, Free Flight
// falls back to a clean solo flight with no errors.
const MP_ENDPOINT_DEFAULT = 'wss://pacific-friendship-production-35b5.up.railway.app';   // published default -> hosted Railway arena; use ?server=local for local dev
// Resolve the endpoint at load time so you can switch servers WITHOUT editing code. Priority:
//   1. ?server=<url>   URL query param — highest, so a shared test link can pin a specific server.
//      Accepts a full ws://host, wss://host, or bare host[:port] (scheme is inferred from the page:
//      https:// pages must use wss://, so a bare or ws:// host is auto-upgraded to wss:// there).
//      Shortcuts: ?server=local -> localhost dev, ?server=prod -> the baked-in production URL below.
//   2. localStorage['mamba.mpEndpoint'] — a sticky per-browser override for repeated testing.
//   3. MP_ENDPOINT_DEFAULT — the compiled-in fallback above.
// Set the ?server= override once and it's also remembered in localStorage for the next visit;
// pass ?server=clear (or ?server=default) to wipe the sticky override and fall back to the default.
const MP_ENDPOINT_PROD = 'wss://pacific-friendship-production-35b5.up.railway.app';   // hosted Colyseus arena (Railway)
function resolveMpEndpoint() {
  const STORE_KEY = 'mamba.mpEndpoint';
  const pageSecure = (typeof location !== 'undefined' && location.protocol === 'https:');
  // Normalize any user-supplied value into a valid ws(s):// endpoint appropriate for the page.
  const normalize = (raw) => {
    let v = String(raw || '').trim();
    if (!v) return null;
    const low = v.toLowerCase();
    if (low === 'local' || low === 'localhost' || low === 'dev') return 'ws://localhost:2567';
    if (low === 'prod' || low === 'production') return MP_ENDPOINT_PROD;
    if (/^wss?:\/\//i.test(v)) {
      // Already has a scheme. Upgrade an insecure ws:// to wss:// on an https page (browsers block
      // mixed-content ws://), UNLESS it's clearly a localhost dev socket the tester chose on purpose.
      if (pageSecure && /^ws:\/\//i.test(v) && !/^ws:\/\/(localhost|127\.0\.0\.1)/i.test(v)) {
        v = v.replace(/^ws:\/\//i, 'wss://');
      }
      return v;
    }
    // Bare host[:port] — infer the scheme from the page (wss on https, ws otherwise).
    return (pageSecure ? 'wss://' : 'ws://') + v.replace(/^\/+/, '');
  };
  let param = null;
  try {
    param = new URLSearchParams(location.search).get('server');
  } catch { /* no URL/search available */ }
  // Explicit reset: ?server=clear|default wipes the sticky override and uses the compiled default.
  if (param && /^(clear|reset|default)$/i.test(param.trim())) {
    try { localStorage.removeItem(STORE_KEY); } catch {}
    return MP_ENDPOINT_DEFAULT;
  }
  const fromParam = normalize(param);
  if (fromParam) {
    // Remember the chosen server so a page reload (or the tester's next visit) keeps using it.
    try { localStorage.setItem(STORE_KEY, fromParam); } catch {}
    return fromParam;
  }
  let stored = null;
  try { stored = localStorage.getItem(STORE_KEY); } catch {}
  const fromStore = normalize(stored);
  if (fromStore) return fromStore;
  return MP_ENDPOINT_DEFAULT;
}
const MP_ENDPOINT = resolveMpEndpoint();
console.info(`[multiplayer] arena endpoint = ${MP_ENDPOINT}`);
const multiplayer = new Multiplayer(scene, explosions, camera, audio);
// Managed voice-audio transport (LiveKit). Presence (who's talking) rides Colyseus; the actual
// mic AUDIO rides this separate hosted SFU. It's connected AFTER we join the arena (so we can key
// the voice room to the Colyseus roomId) and torn down when we leave. Degrades to presence-only
// if the server has no LiveKit env vars configured or the mic is denied.
const voice = new VoiceTransport();
// Derive the HTTP(S) token endpoint from the ws(s):// arena endpoint (ws->http, wss->https), then
// POST { room, identity, name } to mint a LiveKit join token. `room` is the Colyseus roomId so one
// arena shares one voice room; identity is our session id. Returns { url, token } or null on any
// failure (voice not configured / offline) so the caller cleanly skips live audio.
async function resolveVoiceToken() {
  if (!multiplayer.connected || !multiplayer.room) return null;
  const httpBase = MP_ENDPOINT.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
  try {
    const res = await fetch(`${httpBase}/voice-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: multiplayer.room.roomId || 'arena',
        identity: multiplayer.mySessionId || 'pilot',
        name: multiplayer.callSign || 'PILOT',
      }),
    });
    if (!res.ok) { console.info(`[voice] token endpoint returned ${res.status} — voice audio disabled (presence still works).`); return null; }
    const data = await res.json();
    return (data && data.url && data.token) ? data : null;
  } catch (err) {
    console.info('[voice] token request failed — voice audio disabled (presence still works).', err && err.message);
    return null;
  }
}
// Bring the voice-audio layer up for the current arena connection. Safe to call more than once
// (the transport no-ops if already connected). Fire-and-forget from the lobby join.
async function connectVoiceAudio() {
  if (voice.connected) return;
  const cfg = await resolveVoiceToken();
  if (!cfg) { voice.status = 'unavailable'; setVoiceHudStatus(); multiplayer.setMicPresence(false); return; }   // not configured / offline: presence-only, show VOICE OFF hint
  // VOX speaking edges drive the SAME presence flag + HUD as push-to-talk, so a voice-activated pilot
  // lights up the speaking brackets and the mic pill exactly like a PTT pilot.
  voice.onVoxActive = (active) => { multiplayer.setTalking(active); setVoiceHud(active); };
  await voice.connect(cfg.url, cfg.token);
  setVoiceHudStatus();                     // repaint the pill now that we know live / listen-only / unavailable
  // Tell everyone whether we ended up with a working mic (drives the lobby mic icon).
  multiplayer.setMicPresence(voice.hasMic());
  // Apply the pilot's chosen transmit mode now that a mic (may) exist: VOX opens automatically on
  // speech; PTT stays dormant until the key is held. No-ops cleanly if the mic was denied.
  applyVoiceMode();
}
// Push the persisted voice transmit mode (push-to-talk vs. speak-to-activate) into the transport.
// VOX hands mic control to the analyser loop; PTT ensures VOX is off so the key drives the mic.
function applyVoiceMode() {
  const vox = settings.voiceMode === 'vox';
  voice.setVoxEnabled(vox);
  if (!vox) { multiplayer.setTalking(false); setVoiceHud(false); }   // leaving VOX: clear any open-mic state
}
// Local authoritative-mirror of the player ship, kept as plain {x,y,z}/{x,y,z,w} objects for the
// network client's prediction + reconciliation. Each Free Flight frame we seed it from the real
// THREE `player`, let the net client predict/reconcile it, then copy the corrected pose back onto
// `player`. In offline solo it's simply ignored.
const _mpLocalState = {
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
};
const TUTORIAL_SKIP_KEY = 'mamba_skip_tutorial';
function tutorialSkipped() { try { return localStorage.getItem(TUTORIAL_SKIP_KEY) === '1'; } catch { return false; } }
function setTutorialSkipped(v) { try { localStorage.setItem(TUTORIAL_SKIP_KEY, v ? '1' : '0'); } catch {} }
const tutorial = new TutorialController({
  playVO: (url, vol, onDone) => audio.playClip(url, vol != null ? vol : 0.95, onDone),
  flash: (t) => flash(t),
  bindLabel: (a, all) => bindLabel(a, all),
  spawnContainers: (n) => spawnTutorialContainers(n),
  replenishTargets: () => replenishTutorialTargets(),
  spawnFighters: (n, opts) => spawnTutorialFighters(n, opts),
  missileIncoming: () => tutorialMissileIncoming(),
  fireTutorialMissile: () => fireTutorialMissileFromShooter(),
  showHyperPrompt: () => showTutorialHyperPrompt(),
  hideHyperPrompt: () => $('hyperPrompt').classList.remove('show'),
  onHyperspace: () => enterTutorialWarpMenu(),
  onComplete: () => onTutorialComplete()
});
// Raise the "press H to enter hyperspace" prompt during the tutorial's free-flight graduation hold,
// naming the currently-bound Hyperspace key. H is routed to tutorial.notifyHyperspace() (see keydown).
function showTutorialHyperPrompt() {
  const hk = keyLabel((settings.bindings.hyperspace || [])[0]);
  $('hyperPrompt').innerHTML = `FLIGHT SCHOOL COMPLETE · PRESS <b>${hk}</b> TO ENTER HYPERSPACE`;
  $('hyperPrompt').classList.add('show');
}

let camUp = null;   // smoothed camera up-vector for the third-person chase rig (null in cockpit view)
let warping = false;                         // true while the lightspeed warp-out plays
let warpingIn = false;                       // true while the mission-start hyperspace arrival plays
let warpInPhase = 'idle';                    // tracks warp-in cruise->arrival so we cue the drop-out SFX once
// Mission-1-complete cinematic outro: after the wave clears the hero jumps to lightspeed in third
// person, then (once the ship has left the screen) we cut to a first-person cockpit hyperspace
// tube while the Overwatch "mission complete" line plays, then the ship flies into the hangar and
// lands, and finally the upgrade draft appears. Phases: 'jump' -> 'cockpit' -> 'landing'.
const m1Outro = { active: false, phase: 'idle', t: 0, voiceDone: false };
// Forces the camera into the first-person cockpit seat during a cinematic beat (e.g. the mission-1
// cockpit hyperspace ride) even if the player's selected view is third-person.
let cinematicFirstPerson = false;
let awaitingHyperspace = false;              // objectives done; waiting for the player to press H to jump
let paused = false;                          // true while the pause overlay halts gameplay
let pausedFromGameplay = false;              // distinguishes pause (Esc in game) from menu Settings
const warpOut = new WarpOut(scene, camera);
const warpIn = new WarpIn(scene, camera);
const hangar = new HangarView();   // ship-in-hangar diorama behind the upgrade draft

const $ = id => document.getElementById(id);
const sysRows = $('sysRows'), targetData = $('targetData'), weaponData = $('weaponData'), alerts = $('alerts');
const scopeCanvas = $('scopeCanvas'), scopeCtx = scopeCanvas.getContext('2d'), scopeLabel = $('scopeLabel');
const ghostCanvas = $('ghostCanvas'), targetBrackets = $('targetBrackets'), bkTag = targetBrackets.querySelector('.bkTag');
const speakBrackets = $('speakBrackets'), speakTag = speakBrackets.querySelector('.speakTag');
const voiceHud = $('voiceHud'), voiceChanText = $('voiceChanText'), voiceHint = $('voiceHint');
// Show/hide + paint the voice comms pill. `setVoiceHud(true)` = mic open (green pulse); channel is
// TEAM by default, SQUAD when opted in. Called from the PTT/squad handlers + on entering/leaving MP.
function setVoiceHud(talking) { voiceHud.classList.toggle('talking', !!talking); }
function updateVoiceChannelHud(squad) {
  voiceChanText.textContent = squad ? 'SQUAD' : 'TEAM';
  voiceHud.classList.toggle('chan-squad', !!squad);
}
// Reflect the live-audio transport state on the pill so the pilot knows WHY they can't hear/talk.
// 'live' = normal (no hint); 'listen-only' = mic denied, can hear only; 'unavailable' = no live
// audio at all (LiveKit not configured / SDK/connect failed / dropped) — presence brackets still work.
// Reads voice.status directly so a single call after connect (or any state change) repaints correctly.
function setVoiceHudStatus() {
  const st = voice.status;
  const listen = st === 'listen-only';
  const unavailable = st === 'unavailable';
  voiceHud.classList.toggle('voice-listen', listen);
  voiceHud.classList.toggle('voice-unavailable', unavailable);
  voiceHud.classList.toggle('has-hint', listen || unavailable);
  voiceHint.textContent = listen ? 'LISTEN-ONLY' : unavailable ? 'VOICE OFF' : '';
}
// Reveal the pill for a connected arena match (hidden otherwise). Resets to the current channel.
function showVoiceHud(show) {
  voiceHud.hidden = !show;
  if (show) { updateVoiceChannelHud(multiplayer.mySquad); setVoiceHud(multiplayer.myTalking); setVoiceHudStatus(); }
  else { setVoiceHud(false); voiceHud.classList.remove('voice-listen', 'voice-unavailable', 'has-hint'); }
}
initTargetGhost(ghostCanvas);     // self-contained mini-renderer for the rotating target ghost
let scopeSweep = 0;          // radar sweep angle, advanced each HUD frame
const _proj = new THREE.Vector3();   // scratch for projecting the target to screen space
const _scratchA = new THREE.Vector3();   // general-purpose scratch (near-miss / evasion math)

let cutscene = null;
let briefingEnded = false;   // set true once the Overwatch briefing voice-over finishes

// ---- Intro flow: loading screen -> BEGIN gesture -> studio card -> cutscene -> launch screen ----
function preload() {
  const fill = $('loadFill'), pct = $('loadPct');
  const audioUrls = [
    'assets/audio/cutscene-warp-battle-score-2.mp3', 'assets/audio/hyperspace-warp-in.mp3',
    'assets/audio/laser-player-blaster-2.mp3', 'assets/audio/laser-enemy-cannon-3.mp3',
    'assets/audio/combat-space-loop.mp3', 'assets/audio/shield-impact-alert.mp3',
    'assets/audio/explosion-ship-destroyed.mp3', 'assets/audio/hyperspace-hum-loop.mp3',
    'assets/audio/warp-dropout.mp3',
    'assets/audio/voice/overwatch/eeac731a_60bac1d3-b_v2.mp3',
    'assets/audio/voice/scaavi/scaavishieldsfailing.mp3'
  ];
  // Models are the heavy part (~9MB each); weight them 70%, audio 30%.
  let mProg = 0, aProg = 0;
  const render = () => {
    const p = Math.min(100, Math.round((mProg * 0.7 + aProg * 0.3) * 100));
    fill.style.width = p + '%';
    pct.textContent = `LOADING ASSETS ${p}%`;
  };
  Promise.all([
    preloadModels(p => { mProg = p; render(); }),
    preloadAudio(audioUrls, p => { aProg = p; render(); })
  ]).then(() => {
    fill.style.width = '100%';
    pct.textContent = 'READY';
    $('beginBtn').style.display = 'inline-block';
  });
}
// The single BEGIN click is the audio-unlock gesture browsers require.
function begin() {
  audio.unlock();              // primes the loop track element
  $('loader').classList.add('hide');
  setTimeout(() => { $('loader').style.display = 'none'; runStudioCard(); }, 800);
}
function runStudioCard() {
  // Start the cinematic score, fade the studio card in, hold, then fade out and start the cutscene.
  audio.playScore(0.6);
  const card = $('studioCard');
  // Paint the SAME crisp starfield used by the cutscene behind the studio text, so the
  // "An SEMB Enterprises Production" card sits over real space rather than flat black. We
  // bake the canvas to a data URL once and drop it in as a CSS background-image. Static — no
  // animation or warp on the card itself.
  try {
    const url = paintStarfieldCanvas().toDataURL('image/png');
    card.style.backgroundImage = `url(${url})`;
    card.style.backgroundSize = 'cover';
    card.style.backgroundPosition = 'center';
  } catch {}
  card.style.display = 'grid';
  requestAnimationFrame(() => {
    card.classList.add('show');
    // Kick off the Overwatch briefing the moment the studio card begins fading in, so it
    // leads the whole intro. When it finishes, release combat in the (later) cutscene.
    audio.playVoice(0.95, () => { briefingEnded = true; if (cutscene) cutscene.combatStarted = true; });
    // Sync captions to the intro briefing's actual <audio> element (audio.voice).
    captionVoice('assets/audio/voice/overwatch/eeac731a_60bac1d3-b_v2.mp3', 'OVERWATCH', audio.voice);
  });
  // Fade only the TEXT out near the end (the starfield card stays up), then start the
  // cutscene. The card itself is yanked the instant warp-in triggers (in startCutscene),
  // so the starry backdrop hard-cuts straight into the hyperspace tunnel.
  setTimeout(() => { const s = card.querySelector('span'); if (s) s.style.opacity = '0'; }, 3200);
  setTimeout(() => { startCutscene(); }, 4600);
}
function startCutscene() {
  $('skipScene').style.display = 'block';
  // Score already playing from the studio card; tell the cutscene not to restart it.
  cutscene = new OpeningCutscene(renderer, audio, onCutsceneDone);
  // YANK the studio-card starfield exactly as the cutscene (warp-in) begins: the cutscene's
  // first frame swaps scene.background to black for the warp tube, so cutting the card here
  // hard-transitions starry backdrop -> hyperspace streaks with no flat-black gap.
  const card = $('studioCard');
  card.style.display = 'none';
  card.style.backgroundImage = '';
  // If the briefing already finished during the studio card, let combat start as soon as
  // the warp-in completes instead of waiting on a voice line that's already over.
  if (briefingEnded) cutscene.briefingEnded = true;
  cutscene.start(false);
}
function onCutsceneDone() {
  if (cutscene && cutscene._handed) return;
  if (cutscene) cutscene._handed = true;
  $('skipScene').style.display = 'none';
  cutscene = null;
  // Reveal the "Welcome to Hammer Squadron" main menu, fading it in over black.
  const menu = $('mainMenu');
  menu.classList.add('show');
  requestAnimationFrame(() => menu.classList.add('in'));
  renderMenuTopScores();   // populate the worldwide top-5 board on the menu
  // Make sure the page/iframe holds keyboard focus so menu shortcuts (e.g. debug J) are received.
  try { window.focus(); } catch {}
}
function skipCutscene() {
  // The skip button serves both the opening cutscene and the Mission 3 pre-briefing cutscene.
  if (mission3Cutscene) { mission3Cutscene.skip(); return; }
  if (cutscene) cutscene.skip(); else onCutsceneDone();
}

// Start gameplay from the main menu. First offers the interactive flight-school tutorial (unless
// the player has previously opted out), then drops into the campaign.
function start() {
  audio.unlock();
  audio.play('laser', 0.4);
  _callsignDest = 'campaign';
  // Always confirm the call sign first (seeded from storage), then continue to flight school / combat.
  openCallsignPrompt();
}
// Where the call-sign prompt hands off after Confirm: the normal campaign flow, or the Free Flight
// arena. Set by whichever menu button opened the prompt.
let _callsignDest = 'campaign';
// Continue past the call-sign step into the appropriate flow. Free Flight jumps straight into the
// co-op arena; the campaign path offers flight school first (unless the pilot opted out).
function proceedFromCallsign() {
  // Multiplayer: go straight to the lobby. The ship is now chosen AFTER the host launches the
  // match (a timed, team-filtered ship-select), not before joining.
  if (_callsignDest === 'freeflight') { openLobby(); return; }
  if (!tutorialSkipped()) { openStartTutorialPrompt(); return; }
  beginCampaign();
}
// ---- Call-sign prompt (shown right after Start) ----------------------------------------------
function openCallsignPrompt() {
  const m = $('callsignPrompt');
  const input = $('callsignInput');
  if (input) input.value = leaderboard.getPilotName();   // seed from saved call sign
  refreshCallsignConfirm();                              // gate Confirm on a non-empty call sign
  m.classList.add('show');
  if (input) { try { input.focus(); input.select(); } catch {} }
}
function closeCallsignPrompt() { $('callsignPrompt').classList.remove('show'); }
// A call sign is required: enable Confirm only when the sanitized input is non-empty, so no run
// can be submitted as ANONYMOUS.
function callsignIsValid() {
  const input = $('callsignInput');
  return !!(input && leaderboard.sanitizeName(input.value).length > 0);
}
function refreshCallsignConfirm() {
  const btn = $('csConfirm');
  if (!btn) return;
  const ok = callsignIsValid();
  btn.disabled = !ok;
  btn.classList.toggle('isDisabled', !ok);
}
function confirmCallsign() {
  if (!callsignIsValid()) { audio.play('shield', 0.18); return; }  // guard: never proceed without a call sign
  const input = $('callsignInput');
  if (input) leaderboard.setPilotName(input.value);
  audio.unlock(); audio.play('laser', 0.6);
  closeCallsignPrompt();
  proceedFromCallsign();
}
$('csConfirm').addEventListener('click', confirmCallsign);
// Keep menu keyboard shortcuts from firing while typing; live-sanitize, re-gate Confirm, submit on Enter.
const _callsignInput = $('callsignInput');
if (_callsignInput) {
  _callsignInput.addEventListener('input', () => {
    const cleaned = leaderboard.sanitizeName(_callsignInput.value);
    if (cleaned !== _callsignInput.value) _callsignInput.value = cleaned;
    refreshCallsignConfirm();
  });
  _callsignInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); confirmCallsign(); }
  });
}
// Fade the menu out and drop straight into the first campaign mission (the original Start behaviour).
function beginCampaign() {
  const menu = $('mainMenu');
  if (menu.dataset.busy) return;        // ignore double-clicks during the launch beat
  menu.dataset.busy = '1';
  audio.unlock();
  audio.play('laser', 0.85);            // pew — same bolt the hero fires
  audio.fade(audio.score, 0, 600, true); // fade out any lingering cinematic score
  menu.classList.remove('in');          // fade the menu out
  setTimeout(() => enterGameplayFromMenu(), 620);
}
// Shared menu->gameplay handoff: hide the menu, reveal the HUD, start music + pointer lock, and
// launch whatever mission is currently selected (missionIndex/state.wave). Used by Start and by
// the debug mission-jump.
function enterGameplayFromMenu() {
  const menu = $('mainMenu');
  menu.classList.remove('show');
  menu.removeAttribute('data-busy');
  $('missionJump').classList.remove('show');   // close the debug jump overlay if it was open
  ui.classList.remove('cinematic');   // reveal the gameplay HUD now
  audio.startMusic(0.28);             // begin the rotating battle-score soundtrack
  lockPointer();
  launchMission();                    // pre-mission loading screen -> warp-in
}
$('beginBtn').addEventListener('click', begin);
$('startBtn').addEventListener('click', start);
// Free Flight (multiplayer): confirm a call sign (it labels your ship for other pilots), then drop
// into the shared co-op arena.
$('freeFlightBtn').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.4);
  _callsignDest = 'freeflight';
  openCallsignPrompt();
});

// ---- Flight-school start prompt --------------------------------------------------------------
// Shown after Start (for pilots who haven't opted out): "Run flight school?" with a
// "I'm an Ace Pilot. Don't ask me again." toggle that persists the opt-out.
function openStartTutorialPrompt() {
  const m = $('startTut');
  const toggle = $('stAceToggle');
  if (toggle) toggle.classList.remove('on');   // reset the toggle each time it opens
  m.classList.add('show');
}
function closeStartTutorialPrompt() { $('startTut').classList.remove('show'); }
// "Begin Flight School" — honour the opt-out toggle, then launch the interactive tutorial.
$('stBegin').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.6);
  if ($('stAceToggle').classList.contains('on')) setTutorialSkipped(true);
  closeStartTutorialPrompt();
  startTutorialFromMenu();
});
// "Skip to Combat" — drop straight into the campaign; honour the opt-out toggle if ticked.
$('stSkip').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.6);
  if ($('stAceToggle').classList.contains('on')) setTutorialSkipped(true);
  closeStartTutorialPrompt();
  beginCampaign();
});
// The "I'm an Ace Pilot. Don't ask me again." opt-out toggle.
$('stAceToggle').addEventListener('click', () => {
  $('stAceToggle').classList.toggle('on');
  audio.unlock(); audio.play('shield', 0.18);
});
// Shared menu->flight-school handoff (fades the menu out, then launches the training range).
function startTutorialFromMenu() {
  const menu = $('mainMenu');
  if (menu.dataset.busy) return;
  menu.dataset.busy = '1';
  audio.fade(audio.score, 0, 600, true);
  menu.classList.remove('in');
  setTimeout(() => enterTutorialFromMenu(), 620);
}
// ---- Tutorial menu button (bottom-left): launch flight school any time -----------------------
$('menuTutorialBtn').addEventListener('click', () => {
  if (!$('mainMenu').classList.contains('show')) return;
  audio.unlock(); audio.play('laser', 0.5);
  startTutorialFromMenu();
});

// ---- Owner-only debug gate --------------------------------------------------------------------
// Single master switch for ALL developer tools (mission jump J, hangar jump L, HUD tuner K,
// exhaust rig P, orientation rig O). Ships OFF so players have no access to any debug feature.
// Flip to true locally during development to re-enable every dev shortcut at once.
const DEBUG = true;
// Tell scene.js whether we're in dev mode so calibration-sensitive placements (the Dreadnought's
// shield generators) keep their authored positions while tuning, and clamp flush into the hull
// for shipping builds. Set once here so flipping DEBUG before release also reseats the generators.
setSceneDevMode(DEBUG);
const DEBUG_MISSION_JUMP = DEBUG;
// Lists every mission and drops straight into the selected one. Setting state.wave to 2 for
// Mission 2 (index 1) so its scripted wingman intro (gated on missionIndex===1 && wave===2) fires.
function buildMissionJumpList() {
  const list = $('mjList');
  list.innerHTML = '';
  missions.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'mjItem';
    item.innerHTML = `<span class="mjType">${i + 1}. ${m.type}</span><span class="mjTitle">${m.title}</span>`;
    item.addEventListener('click', () => {
      missionIndex = i;
      // Mission 2's scripted intro keys on wave 2; set each mission's wave so its tuning is sane.
      state.wave = (i === 1) ? 2 : 1;
      audio.unlock();
      audio.play('laser', 0.6);
      enterGameplayFromMenu();
    });
    list.appendChild(item);
  });
}
function openMissionJump() {
  if (!$('mainMenu').classList.contains('show')) return;   // main menu only
  buildMissionJumpList();
  $('missionJump').classList.add('show');
}
function closeMissionJump() { $('missionJump').classList.remove('show'); }
$('mjClose').addEventListener('click', closeMissionJump);
function onMissionJumpKey(e) {
  if (!DEBUG_MISSION_JUMP) return;   // dev-only; disabled for players
  if (e.code === 'KeyJ' && $('mainMenu').classList.contains('show') && !$('missionJump').classList.contains('show')) {
    e.preventDefault(); openMissionJump();
  } else if (e.code === 'Escape' && $('missionJump').classList.contains('show')) {
    e.preventDefault(); closeMissionJump();
  }
}
// Listen on BOTH document and window (capture phase) so an iframe-focus quirk on the menu — where
// the page hasn't received keyboard focus yet — can't swallow the J shortcut.
document.addEventListener('keydown', onMissionJumpKey, true);
window.addEventListener('keydown', onMissionJumpKey, true);
// ---- Pilot Roster: a dossier of Hammer Squadron, opened from the main menu. ----
const ROSTER = [
  { call: 'Mamba', name: 'You', role: 'Flight Lead', player: true, initials: 'M',
    bio: 'Hammer One. Gun-shy on paper, lethal in the cockpit. The brass keeps you flying the worst sorties because you keep coming home.' },
  { call: 'Slick', name: 'Lt. Dani Vance', role: 'Wingman · Hammer Two', initials: 'S',
    bio: 'Cocky, fast hands, faster mouth. Slick flies your wing and never stops narrating the kill. Watch her six when the shields buckle.' },
  { call: 'O.G.', name: 'Maj. Reuben Okonkwo', role: 'Wingman · Hammer Three', initials: 'OG',
    bio: 'The veteran. Twenty years and a hundred dead engines behind him. When O.G. tells you to break, you break.' },
];
function buildRosterList() {
  const list = $('prList');
  list.innerHTML = '';
  ROSTER.forEach(p => {
    const item = document.createElement('div');
    item.className = 'prItem' + (p.player ? ' player' : ' ally');
    item.innerHTML =
      `<span class="prBadge">${p.initials}</span>` +
      `<span class="prBody">` +
        `<span class="prCall">${p.call}<span class="prName">${p.name}</span></span>` +
        `<span class="prRole">${p.role}</span>` +
        `<span class="prBio">${p.bio}</span>` +
      `</span>`;
    list.appendChild(item);
  });
}
function openPilotRoster() {
  if (!$('mainMenu').classList.contains('show')) return;   // main menu only
  buildRosterList();
  $('pilotRoster').classList.add('show');
}
function closePilotRoster() { $('pilotRoster').classList.remove('show'); }
$('rosterBtn').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.4);
  openPilotRoster();
});
$('prClose').addEventListener('click', closePilotRoster);
function onPilotRosterKey(e) {
  if (e.code === 'Escape' && $('pilotRoster').classList.contains('show')) {
    e.preventDefault(); closePilotRoster();
  }
}
document.addEventListener('keydown', onPilotRosterKey, true);
window.addEventListener('keydown', onPilotRosterKey, true);
// ---- Flight Manual: a controls/tutorial reference, opened from the main menu. ----
const TUTORIAL = [
  { group: 'Flight', rows: [
    { keys: ['Mouse'], desc: 'Aim your nose. The reticle follows the cursor — point where you want to fly and shoot.' },
    { keys: ['W', 'A', 'S', 'D'], desc: 'Maneuver: <b>W/S</b> pitch, <b>A/D</b> roll. Arrow keys work too.' },
    { keys: ['Q', 'E'], desc: 'Yaw left / right to swing the nose without rolling.' },
    { keys: ['Shift'], desc: '<b>Boost</b> — burn engine power for a burst of speed. Watch your heat.' },
    { keys: ['V'], desc: 'Toggle between <b>cockpit (first-person)</b> and <b>chase (third-person)</b> view.' },
  ]},
  { group: 'Weapons', rows: [
    { keys: ['L-Click', 'Space'], desc: 'Fire <b>lasers</b>. Bolts converge on the reticle.' },
    { keys: ['R-Click', 'F'], desc: 'Launch a <b>guided missile</b> at your locked target. Limited stock.' },
    { keys: ['C'], desc: 'Drop <b>chaff</b> to break an incoming missile lock.' },
    { keys: ['T'], desc: '<b>Lock</b> the target nearest your reticle for missiles and scope tracking.' },
    { keys: ['R'], desc: '<b>Cycle</b> to the next hostile contact.' },
  ]},
  { group: 'Power Routing', rows: [
    { keys: ['1'], desc: 'Divert power to <b>Shields</b> — faster recharge, each charge soaks more fire. Drawn evenly from the other two.' },
    { keys: ['2'], desc: 'Divert power to <b>Weapons</b> — higher fire rate, hotter bolts, overclocked cooling. Drawn from the others.' },
    { keys: ['3'], desc: 'Divert power to <b>Engines</b> — more top speed and tighter turns. The reactor always totals 100%.' },
    { keys: ['5'], desc: '<b>Reset</b> all systems to the default even 33 / 33 / 33 split — your instant "back to neutral".' },
  ]},
  { group: 'System', rows: [
    { keys: ['H'], desc: 'Engage <b>hyperspace</b> once objectives are complete to advance the mission.' },
    { keys: ['Esc'], desc: 'Pause and open <b>Settings</b> — sensitivity, audio, and full keybindings.' },
    { keys: ['M'], desc: 'Toggle <b>mute</b>.' },
  ]},
];
function buildTutorialList() {
  const list = $('tutList');
  list.innerHTML = '';
  TUTORIAL.forEach(g => {
    const grp = document.createElement('div');
    grp.className = 'tutGroup';
    grp.innerHTML = `<div class="tutGroupTitle">${g.group}</div>` + g.rows.map(r =>
      `<div class="tutRow"><span class="tutKey">${r.keys.map(k => `<kbd>${k}</kbd>`).join('')}</span>` +
      `<span class="tutDesc">${r.desc}</span></div>`).join('');
    list.appendChild(grp);
  });
}
function openTutorial() {
  if (!$('mainMenu').classList.contains('show')) return;   // main menu only
  buildTutorialList();
  $('tutorial').classList.add('show');
}
function closeTutorial() { $('tutorial').classList.remove('show'); }
$('tutorialBtn').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.4);
  openTutorial();
});
$('tutClose').addEventListener('click', closeTutorial);
function onTutorialKey(e) {
  if (e.code === 'Escape' && $('tutorial').classList.contains('show')) {
    e.preventDefault(); closeTutorial();
  }
}
document.addEventListener('keydown', onTutorialKey, true);
window.addEventListener('keydown', onTutorialKey, true);

// ---- Worldwide Leaderboard + Achievements menu UI --------------------------------------------
// Pilot call-sign entry (persisted), the menu's top-5 board, the full leaderboard modal, and the
// achievements gallery. All open only from the main menu (the modals layer over it).

// Pilot call sign is now captured via the post-Start #callsignPrompt modal (see start() above),
// not a menu input. Persistence still lives in leaderboard.getPilotName/setPilotName.

// Render the menu's right-rail top-5 panel from a fetched score list (or an offline/empty notice).
function renderMenuBoardList(rows) {
  const list = $('menuBoardList');
  if (!list) return;
  if (!leaderboard.isOnline()) {
    const msg = leaderboard.isConfigured() ? 'Offline — scores unavailable' : 'Worldwide board not configured';
    list.innerHTML = `<li class="mbEmpty">${msg}</li>`; return;
  }
  if (rows === null) { list.innerHTML = '<li class="mbEmpty">Squadron net unreachable</li>'; return; }
  if (rows.length === 0) { list.innerHTML = '<li class="mbEmpty">No runs logged yet — be the first ace!</li>'; return; }
  list.innerHTML = rows.slice(0, 5).map((r, idx) => {
    const rankCls = idx < 3 ? ` mbTop${idx + 1}` : '';
    const diff = leaderboard.difficultyLabel(r.difficulty);
    return `<li class="${rankCls.trim()}">` +
      `<span class="mbRank">${idx + 1}</span>` +
      `<span class="mbName">${escapeHtml(r.name)}<span class="mbMeta">${r.kills} KILLS · ${diff}</span></span>` +
      `<span class="mbScore">${r.score.toLocaleString()}</span></li>`;
  }).join('');
}
// Fetch + paint the menu top-5. Safe to call repeatedly (e.g. after a score submit).
async function renderMenuTopScores() {
  const list = $('menuBoardList');
  if (list && leaderboard.isOnline()) list.innerHTML = '<li class="mbEmpty">Connecting to squadron net…</li>';
  const rows = await leaderboard.fetchTopScores(50);
  renderMenuBoardList(rows);
}
// Minimal HTML escaper for player-supplied names rendered into innerHTML.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Full leaderboard modal ----
async function openLeaderboard() {
  if (!$('mainMenu').classList.contains('show')) return;   // main menu only
  $('leaderboard').classList.add('show');
  const list = $('lbList');
  list.innerHTML = leaderboard.isOnline()
    ? '<li class="lbLoading">Loading…</li>'
    : (leaderboard.isConfigured()
        ? '<li class="lbEmpty">Offline — the worldwide board is unavailable right now.</li>'
        : '<li class="lbEmpty">The worldwide board isn\'t set up yet. Add an InstantDB app id in leaderboard.js to go live — your kills and achievements still track locally.</li>');
  if (!leaderboard.isOnline()) return;
  const rows = await leaderboard.fetchTopScores(50);
  if (!$('leaderboard').classList.contains('show')) return;   // closed while loading
  if (rows === null) { list.innerHTML = '<li class="lbEmpty">Could not reach the squadron net.</li>'; return; }
  if (rows.length === 0) { list.innerHTML = '<li class="lbEmpty">No runs logged yet — be the first ace!</li>'; return; }
  const me = (leaderboard.getPilotName() || '').toLowerCase();
  list.innerHTML = rows.map((r, idx) => {
    const cls = [idx === 0 ? 'lbTop1' : '', (me && r.name.toLowerCase() === me) ? 'lbMe' : ''].filter(Boolean).join(' ');
    return `<li class="${cls}">` +
      `<span class="lbRank">${idx + 1}</span>` +
      `<span class="lbName">${escapeHtml(r.name)}</span>` +
      `<span class="lbKills">${r.kills}</span>` +
      `<span class="lbDiff">${leaderboard.difficultyLabel(r.difficulty)}</span>` +
      `<span class="lbScore">${r.score.toLocaleString()}</span></li>`;
  }).join('');
}
function closeLeaderboard() { $('leaderboard').classList.remove('show'); }

// ---- Achievements modal ----
function openAchievements() {
  if (!$('mainMenu').classList.contains('show')) return;   // main menu only
  const list = $('acList');
  const total = leaderboard.ACHIEVEMENTS.length;
  const got = leaderboard.unlockedCount();
  $('acProgress').textContent = `${got} of ${total} unlocked`;
  list.innerHTML = leaderboard.ACHIEVEMENTS.map(a => {
    const unlocked = leaderboard.isUnlocked(a.id);
    return `<div class="acCard ${unlocked ? 'unlocked' : 'locked'}">` +
      `<span class="acIcon">${unlocked ? a.icon : '🔒'}</span>` +
      `<span><span class="acName">${a.name}</span><span class="acDesc">${a.desc}</span></span></div>`;
  }).join('');
  $('achievements').classList.add('show');
}
function closeAchievements() { $('achievements').classList.remove('show'); }

$('leaderboardBtn').addEventListener('click', () => { audio.unlock(); audio.play('laser', 0.4); openLeaderboard(); });
$('menuBoardMore').addEventListener('click', () => { audio.unlock(); audio.play('laser', 0.4); openLeaderboard(); });
$('achievementsBtn').addEventListener('click', () => { audio.unlock(); audio.play('laser', 0.4); openAchievements(); });
$('lbClose').addEventListener('click', closeLeaderboard);
$('acClose').addEventListener('click', closeAchievements);
function onBoardKey(e) {
  if (e.code === 'Escape' && $('leaderboard').classList.contains('show')) { e.preventDefault(); closeLeaderboard(); }
  if (e.code === 'Escape' && $('achievements').classList.contains('show')) { e.preventDefault(); closeAchievements(); }
}
document.addEventListener('keydown', onBoardKey, true);
window.addEventListener('keydown', onBoardKey, true);

// Settings / pause overlay. onClose resumes; onExitToMenu bails to the main menu.
const settingsUI = initSettingsUI(audio, {
  onClose: () => {
    // Options opened from the post-tutorial warp menu: re-show that menu (the tunnel kept streaming).
    if (_returnToWarpMenu) { _returnToWarpMenu = false; if (tutorialWarpHold) showTutorialWarpMenu(); return; }
    if (pausedFromGameplay) resumeFromPause();
  },
  onExitToMenu: () => { pausedFromGameplay = false; exitToMainMenu(); },
  getGamepad: () => gamepad,
  // Localized captions: expose the available locales to the Settings select and apply changes live.
  captionLocales: captions.availableLocales(),
  onCaptionLang: lang => captions.setLocale(lang),
  // Voice options (multiplayer pause): push the transmit-mode change into the live transport, and
  // mirror a Squad-Only flip through the same path as the in-flight toggle key so state stays synced.
  onVoiceMode: () => applyVoiceMode(),
  onSquadOnly: (squad) => {
    if (freeFlightMode && multiplayer.connected) multiplayer.setSquadVoice(squad);
    updateVoiceChannelHud(squad);
  },
});
// Apply the persisted caption locale to the engine up front so saved language takes effect on load.
captions.setLocale(settings.captionLang || 'en');
// From the MAIN MENU, Settings opens the same panel (titled "Settings"), no gameplay pause.
$('settingsBtn').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.4);
  pausedFromGameplay = false;
  keys.clear(); kbHeld.clear();
  settingsUI.open('Settings', 'Sound, Controls & About', 'Done');
});
// Main-menu Exit Game: a two-step "click to confirm" on the button itself. The sandboxed preview
// (and many browsers) block the native confirm() dialog, so we confirm inline instead: the first
// click arms the button (relabels it), a second click within a few seconds exits; otherwise it
// disarms back to normal.
let _exitArmed = false, _exitTimer = null;
const exitBtn = $('exitGameBtn');
const _exitLbl = exitBtn.querySelector('.cbLbl');   // update just the text span so the ⏻ glyph stays
const _exitLabel = _exitLbl ? _exitLbl.textContent : exitBtn.textContent;
function _setExitText(t) { if (_exitLbl) _exitLbl.textContent = t; else exitBtn.textContent = t; }
function disarmExit() { _exitArmed = false; clearTimeout(_exitTimer); _setExitText(_exitLabel); exitBtn.classList.remove('armed'); }
exitBtn.addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.4);
  if (!_exitArmed) {
    _exitArmed = true;
    _setExitText('Confirm Exit');
    exitBtn.classList.add('armed');
    _exitTimer = setTimeout(disarmExit, 3500);   // auto-cancel if they don't confirm
    return;
  }
  disarmExit();
  window.open('', '_self');   // some browsers require the window be script-opened to close
  window.close();
  // If the browser blocks close() (most do for the top tab / sandboxed preview), show a fallback.
  setTimeout(() => flash('CLOSE THIS TAB TO EXIT'), 120);
});
$('skipScene').addEventListener('click', skipCutscene);
preload();
document.addEventListener('pointerlockchange', () => {
  mouse.locked = document.pointerLockElement === renderer.domElement;
  // If the OS yanked pointer lock (e.g. window resize/minimize/maximize) while we're still meant
  // to be flying, nudge the player to click to re-engage aim — a single click re-locks (above).
  if (!mouse.locked && inActiveFlight()) flash('CLICK TO RESUME FLIGHT CONTROL');
});
// Largest single-event mouse delta (px) we accept. Pointer-lock re-acquisition and a few
// mice/drivers can deliver one ENORMOUS movementX/Y (the whole delta accumulated while lock was
// lost) — often thousands of px in a single event. Unclamped, that one event slams the steering
// offset to the rail; because the offset only decays while the mouse is still, a noisy/streaming
// input then HOLDS it there and the ship "free spins". This cap is set HIGH so it only swallows
// those absurd re-entry spikes and never clips a real fast flick (which tops out a few hundred px).
const MAX_MOUSE_DELTA = 600;
let lastMouseMoveT = 0;   // timestamp of the last REAL mouse movement (idle watchdog, below)
document.addEventListener('mousemove', e => {
  if (!mouse.locked) return;
  if (hudTuner.on) return;   // tuner open: freeze aim so the ship doesn't drift while positioning HUD
  // The mouse drives a steering OFFSET from centre. updatePlayer() turns that offset into a
  // pitch/yaw turn RATE applied to the ship's current orientation, and recenters it each frame,
  // so the ship can pitch/roll all the way around with no floor or ceiling (true open-space
  // flight). Clamp the offset so a fast flick can't spike the turn rate unrealistically.
  // First clamp each raw event delta so a single spike can't pin the offset to the rail.
  let dx = THREE.MathUtils.clamp(e.movementX || 0, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
  let dy = THREE.MathUtils.clamp(e.movementY || 0, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
  // A truly empty event (some drivers stream 0,0 mousemoves) is not real input — ignore it so it
  // can't keep the idle watchdog from recentering a hands-off ship.
  if (dx === 0 && dy === 0) return;
  lastMouseMoveT = performance.now();
  const xDir = settings.invertX ? -1 : 1;
  mouse.x += dx * BASE_MOUSE.x * settings.mouseSensX * xDir;
  const yDir = settings.invertY ? -1 : 1;
  mouse.y += dy * BASE_MOUSE.y * settings.mouseSensY * yDir;
  mouse.x = THREE.MathUtils.clamp(mouse.x, -1.4, 1.4);
  mouse.y = THREE.MathUtils.clamp(mouse.y, -1.4, 1.4);
});
// Mouse buttons: LEFT click fires lasers (alongside the Space key), RIGHT click fires a missile
// (alongside the bound key). We track the held state of the left button and fire from updatePlayer
// so it auto-repeats on the same cadence as the keyboard; the right button is one-shot per press.
// Track which mouse button is held as a 'Mouse<button>' code so the bindings (which include
// Mouse0 on Fire and Mouse2 on Fire Missile by default, and are user-rebindable) drive it.
const mouseHeld = new Set();
// True when a frozen mouse-driven calibration rig (P exhaust / O orientation) is up. While either
// is open the user needs the FREE cursor to drag markers and read HUD, so flight must not grab
// pointer lock back. (exhaustDev/orientDev are declared lower in the file but this only runs at
// event time, so the hoisted const bindings are initialized by then.)
function devRigOpen() {
  // The HUD layout tuner (K) is included so inActiveFlight() reads false while it's open — otherwise
  // the capture-phase pointer-relock handler would re-lock the pointer on every click in the tuner,
  // hiding the cursor (looks like a freeze on Save) and corrupting drag coordinates (phantom resize).
  return exhaustDev.on || orientDev.on || hudTuner.on;
}
// True when the player should be flying: a mission is live and no overlay/transition is up. A dev
// calibration rig counts as "not flying" so flight never fights the rig for the mouse pointer.
function inActiveFlight() {
  return !!mission && !paused && !warping && !settingsUI.isOpen() && !ui.classList.contains('drafting') && !devRigOpen()
    && !modalOverlayOpen();
}
// True when a blocking, click-driven overlay is up (mission-results debrief, the post-tutorial warp
// menu, or its hold). These keep `mission` set and aren't "paused/warping/drafting", so without this
// the capture-phase pointer-relock handler would treat clicks on their buttons as in-flight clicks
// and STEAL the first one to re-grab pointer lock — the "continue button does nothing the first
// time, works after toggling pause" bug. Excluding them here lets the very first click reach the button.
function modalOverlayOpen() {
  const res = document.getElementById('results');
  const wm = document.getElementById('warpMenu');
  const mr = document.getElementById('matchResults');
  return tutorialWarpHold
    || (res && res.classList.contains('show'))
    || (wm && wm.classList.contains('show'))
    || (mr && mr.classList.contains('show'));
}
renderer.domElement.addEventListener('mousedown', e => {
  // Browsers drop pointer lock when the window is resized / minimized / maximized, which silently
  // kills mouse aim. If we're still in active flight but the lock was lost, RE-ACQUIRE it on this
  // click (a valid user gesture) instead of forcing the player through the pause menu. Consume the
  // click so it doesn't also fire a weapon on the same press.
  if (!mouse.locked && inActiveFlight()) {
    e.preventDefault();
    lockPointer();
    return;
  }
  if (!mouse.locked || settingsUI.isOpen() || !mission || warping) return;
  const code = 'Mouse' + e.button;
  mouseHeld.add(code);
  // Continuous fire is auto-repeated from updatePlayer; missile is one-shot per press here.
  if (isAction('fireMissile', code)) { e.preventDefault(); fireMissile(); }
  // Push-to-talk can be bound to a mouse side button (default Mouse4): open the mic while held.
  if (isAction('pushToTalk', code)) { e.preventDefault(); startPushToTalk(); }
});
document.addEventListener('mouseup', e => {
  const code = 'Mouse' + e.button;
  mouseHeld.delete(code);
  // Release push-to-talk if it was held on a mouse button.
  if (isAction('pushToTalk', code)) stopPushToTalk();
});
// RE-LOCK FALLBACK: when pointer lock drops mid-flight the OS cursor reappears and the player may
// click ANYWHERE on the page, not just the canvas. The canvas-only mousedown handler above would
// miss those clicks, stranding the player with no mouse aim ("mouse input lost"). This document-wide
// listener re-acquires the lock on any click while we're in active flight but unlocked — the click
// is a valid user gesture, so requestPointerLock is allowed. Capture phase so it runs before other
// handlers; it only acts when actually unlocked, so it never interferes with normal in-flight clicks.
document.addEventListener('mousedown', e => {
  if (!mouse.locked && inActiveFlight()) {
    e.preventDefault();
    lockPointer();
  }
}, true);
// Right-click is a fire control in flight, so suppress the browser context menu over the canvas.
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  // Escape toggles the pause menu during gameplay (and closes it / its confirm if open).
  if (e.code === 'Escape') {
    e.preventDefault();
    if (settingsUI.isOpen()) { settingsUI.close(); }
    // During the post-tutorial warp-tunnel menu, Esc does nothing (the menu owns the frame) so it
    // can't stack a pause overlay on top of the warp menu.
    else if (tutorialWarpHold) { /* no-op */ }
    else if (mission && !warping) { openPauseMenu(); }
    return;
  }
  // Always track the PHYSICAL held-key set, even while an overlay is up. This is critical: if the
  // player is holding W when they open/close the pause or settings overlay, the browser will NOT
  // send a fresh keydown for W on resume (the key never came up). Recording the keydown here — and
  // NOT clearing the set on pause/resume — means W is still "held" when the loop resumes, so it
  // keeps responding. Gameplay USE of these keys is gated by the paused/overlay flags elsewhere.
  keys.add(e.code);
  kbHeld.add(e.code);   // record the PHYSICAL hold so the gamepad poll can't delete it
  // SPACE skips an in-progress pre-jump mission briefing, jumping straight to the warp-in. Handled
  // here (before overlay/dev gating and SPACE's default-prevention below) so it works during the
  // briefing hold; it's a no-op outside a briefing, so normal Space-to-fire is unaffected.
  if (e.code === 'Space' && briefingHold) { e.preventDefault(); skipBriefing(); return; }
  // SPACE skips the kill-cam cinematic beats straight to the RELAUNCHING hold (the countdown still
  // obeys the server). Handled here before overlay gating so it works while dead; a no-op unless a
  // kill-cam is playing, so normal Space-to-fire is unaffected.
  if (e.code === 'Space' && killCam.active && killCam.phase !== 'hold') { e.preventDefault(); skipKillCam(); return; }
  // Ignore the rest of gameplay key handling (one-shot actions, dev modes) while an overlay is up.
  if (settingsUI.isOpen()) return;
  // Resolve which bound action(s) this key triggers, then handle the one-shot ones.
  const acts = actionsFor(e.code);
  // SCOREBOARD (HOLD) opens the live multiplayer team scoreboard while its key is held. Bound to a
  // rebindable action (default `) rather than Tab, so Tab stays free for Toggle View — same as solo.
  // Prevent-default so the key never shifts browser focus; showScoreboard() is idempotent under the
  // OS auto-repeat. A no-op outside a connected arena match.
  if (acts.includes('scoreboard')) {
    e.preventDefault();
    if (freeFlightMode && multiplayer.connected) showScoreboard();
    return;
  }
  // FLIGHT SCHOOL: during the graduation hold, the Hyperspace key ends the tutorial instead of
  // running the campaign warp-out. Routed before the campaign branch so it takes priority in training.
  if (acts.includes('hyperspace') && tutorialMode && tutorial.active && tutorial.graduating) {
    e.preventDefault(); tutorial.notifyHyperspace(); return;
  }
  // Objectives complete: the Hyperspace Jump binding launches the jump on the player's cue.
  if (acts.includes('hyperspace') && awaitingHyperspace && !warping) { e.preventDefault(); startWarpOut(); return; }
  if (acts.includes('routeShields')) route('shields');
  if (acts.includes('routeWeapons')) route('weapons');
  if (acts.includes('routeEngines')) route('engines');
  if (acts.includes('resetPower')) resetPower();
  if (acts.includes('toggleView')) { e.preventDefault(); toggleView(); }
  if (acts.includes('fireMissile')) { e.preventDefault(); fireMissile(); }
  if (acts.includes('chaff')) { e.preventDefault(); deployChaff(); }
  if (acts.includes('mute')) audio.toggleMute();
  // VOICE COMMS (multiplayer only). Push-to-talk opens the mic while HELD; the OS auto-repeat resends
  // keydown, so guard on e.repeat to only fire the "open" edge once. Squad Voice is a one-shot toggle
  // between full-team and squad-only comms. Both no-op outside a connected arena match.
  if (acts.includes('pushToTalk')) {
    e.preventDefault();
    if (!e.repeat) startPushToTalk();
    return;
  }
  if (acts.includes('squadVoice')) { e.preventDefault(); toggleSquadVoice(); return; }
  // Targeting is MANUAL only: Lock Target locks the nearest hostile, Cycle Target steps through all
  // hostiles one by one. The lock never changes on its own (see closestTarget); only these move it.
  // Fall back to the default T/R codes too, so targeting keeps working even if a stored binding got
  // dropped or a key resolves to no action for any reason.
  if (acts.includes('lockTarget') || e.code === 'KeyT') { e.preventDefault(); selectClosestTarget(); return; }
  if (acts.includes('cycleTarget') || e.code === 'KeyR') { e.preventDefault(); cycleTarget(); return; }
  // ---- DEV: jump straight to the hangar landing/upgrade scene ----
  // L plays the full fly-in -> turn-around -> touchdown -> draft sequence on demand, so the
  // hangar entrance can be reviewed without clearing a mission first. Only fires during live
  // gameplay (a mission is running, not paused/warping, and not already in the draft) so it
  // never collides with those states or the main menu.
  // ---- DEV shortcuts (owner-only, gated behind DEBUG) ----
  if (DEBUG) {
    if (e.code === 'KeyL' && mission && !paused && !warping && !ui.classList.contains('drafting')) {
      e.preventDefault();
      audio.stopLockTone();
      showDraft({ landing: true });
      return;
    }
    // ---- HUD layout tuner dev mode (K) ----
    // K toggles a small control box for repositioning/resizing the three cockpit dashboard panels
    // live. While it's open it captures the arrow keys / [ ] / +- so they tune the selected panel
    // instead of flying the ship; everything else passes through.
    if (e.code === 'KeyK' && mission && !paused && !warping) { e.preventDefault(); hudTuner.toggle(); return; }
    // While the HUD tuner is open it OWNS the keyboard: its own keys tune the panel, and every other
    // key is swallowed so nothing leaks through to flight controls (thrust/fire/etc). K closes it.
    if (hudTuner.on) { if (!hudTuner.handleKey(e)) e.preventDefault(); return; }
    // ---- Exhaust calibration dev mode ----
    // P toggles a frozen calibration rig: one enemy is parked in front of the camera with bright
    // markers on each exhaust mount, which you can nudge live to show exactly where the exhaust
    // should exit. Tab cycles the hull kind; [ ] cycles which nozzle is selected; arrows/PgUp/PgDn
    // move the selected nozzle; \ prints the calibrated layout to the console.
    if (e.code === 'KeyP') { e.preventDefault(); if (orientDev.on) toggleOrientDev(); toggleExhaustDev(); return; }
    if (exhaustDev.on) { handleExhaustDevKey(e); return; }
    // O toggles the orientation + laser-origin rig: a parked hull with labeled FRONT/BACK/TOP/BOTTOM
    // axis arrows and editable markers on each laser muzzle, so side-firing guns can be re-placed.
    if (e.code === 'KeyO') { e.preventDefault(); if (exhaustDev.on) toggleExhaustDev(); toggleOrientDev(); return; }
    if (orientDev.on) { handleOrientDevKey(e); return; }
  }
  // Prevent default scroll/focus jumps for keys used in flight even if unbound from above.
  if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
});
document.addEventListener('keyup', e => {
  keys.delete(e.code);
  kbHeld.delete(e.code);
  if (_scoreboardOpen && actionsFor(e.code).includes('scoreboard')) { e.preventDefault(); hideScoreboard(); }
  // Release push-to-talk when its key comes up (closes the mic). Uses actionsFor so it honors a
  // rebound key. Guarded inside stopPushToTalk so a stray keyup can't error outside a match.
  if (actionsFor(e.code).includes('pushToTalk')) { e.preventDefault(); stopPushToTalk(); }
});
// KEYBOARD FOCUS: when the game runs inside an iframe (e.g. the Rosebud editor with the prompt
// panel open), keydown events go to the PARENT page unless this iframe's DOCUMENT holds focus — so
// pressing W just types "wwww" into the editor and the ship never moves (mouse aim still works
// because pointer-lock delivers mousemove regardless of focus, which is why it FEELS like only the
// keyboard is dead). Making the canvas focusable and calling .focus() on it — not just
// window.focus() — reliably pulls keyboard focus into this iframe's document.
renderer.domElement.tabIndex = -1;                              // focusable without a visible outline
renderer.domElement.style.outline = 'none';
function grabFocus() {
  // Focus the CANVAS ELEMENT first — that's what actually pulls keyboard focus into this iframe's
  // document; window.focus() alone is not enough inside an embedded preview. A next-frame retry
  // covers the case where the browser rejects the focus call mid pointer-lock transition.
  try { renderer.domElement.focus({ preventScroll: true }); } catch {}
  try { window.focus(); } catch {}
  requestAnimationFrame(() => {
    if (document.hasFocus && document.hasFocus()) return;
    try { renderer.domElement.focus({ preventScroll: true }); } catch {}
    try { window.focus(); } catch {}
  });
}
window.addEventListener('pointerdown', grabFocus, true);
window.addEventListener('mousedown', grabFocus, true);
window.addEventListener('touchstart', grabFocus, true);
// Pointer lock is a strong "player is in the game" signal — re-assert focus whenever it engages so
// the keyboard follows the mouse into the game.
document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) grabFocus(); });
grabFocus();
// FOCUS LOSS during flight. In an embedded iframe (Rosebud editor) the surrounding page can
// briefly steal focus mid-flight, firing a spurious `blur`. The old handler cleared ALL held keys
// on every blur — so each focus flicker dropped thrust (W) until the player released and re-pressed,
// which read as "random loss of thrust" in Mission 2 (whose draft-entry path leaves focus fragile).
// Now: if we're still in active flight, treat the blur as a focus-steal and immediately re-grab
// focus WITHOUT clearing the held keys, so thrust survives. Only on a genuine focus loss (we did NOT
// reclaim it — e.g. a real tab switch) do we clear, so keys can't get stuck thrusting forever.
window.addEventListener('blur', () => {
  if (inActiveFlight()) {
    grabFocus();
    // Do NOT decide on this same tick whether focus was reclaimed: a synchronous .focus() call does
    // not reliably update document.hasFocus() within the blur event, so checking here would read
    // "not focused" and wrongly clear the held keys — dropping thrust mid-flight (the "lost engines,
    // W does nothing" bug). Instead verify on the NEXT frame: if focus is genuinely gone by then
    // (a real tab/window switch), clear the held keys so nothing sticks; if grabFocus reclaimed it,
    // keep them so thrust survives the focus flicker.
    requestAnimationFrame(() => {
      if (!inActiveFlight() || (document.hasFocus && document.hasFocus())) return;   // focus reclaimed
      keys.clear(); kbHeld.clear(); mouseHeld.clear();
    });
    return;
  }
  keys.clear(); kbHeld.clear(); mouseHeld.clear();
});

// Poll the controller once per frame during live flight. The pad writes steering into mouse.x/.y
// and held actions (thrust/fire/boost/roll) into the `keys` Set via poll(); discrete one-shots are
// handled here off the edge-triggered pressed() report. Fire (held) is auto-repeated by updatePlayer
// via the synthetic 'fire' binding, exactly like the keyboard.
function pollGamepad() {
  gamepadSteered = false;
  // Only ever touch the held-key set when a controller is actually connected — otherwise this must
  // be a complete no-op so it can never interfere with keyboard play.
  if (!gamepad.connected) return;
  if (!inActiveFlight() || briefingHold || warpingIn) {
    // Not flying: release any keys the PAD is holding (never the keyboard's) so a leftover trigger
    // can't stick on.
    gamepad.releaseAll(keys);
    return;
  }
  gamepadSteered = gamepad.poll(mouse, keys, bindingFor, {
    invertX: settings.padInvertX, invertY: settings.padInvertY,
    sensX: settings.padSensX, sensY: settings.padSensY, kbHeld
  });
  const p = gamepad.pressed();
  if (p.missile) fireMissile();
  if (p.chaff) deployChaff();
  if (p.view) toggleView();
  if (p.lockTarget) selectClosestTarget();
  if (p.cycleTarget) cycleTarget();
  if (p.routeShields) route('shields');
  if (p.routeEngines) route('engines');
  if (p.routeWeapons) route('weapons');
}

// ---- Continuous 3-way power routing ----
// state.power is { shields, weapons, engines }, three fractions that ALWAYS sum to exactly 1.0
// (default 1/3 each). Pressing a system's key diverts one ROUTE_STEP of power INTO it, pulled
// evenly out of the other two — clamped so no system starves below ROUTE_FLOOR. After clamping we
// renormalise so the three always re-balance to a perfect 100%. This is the whole rule: take from
// the others, give to the chosen one, keep the sum locked at 1.
const ROUTE_STEP = 0.08;     // power shifted per key press (8% of the reactor)
const ROUTE_FLOOR = 0.10;    // a system can never be choked below 10% — engines/shields stay alive
const POWER_NAMES = { shields: 'SHIELDS', weapons: 'WEAPONS', engines: 'ENGINES' };
function normalisePower() {
  const p = state.power;
  const sum = p.shields + p.weapons + p.engines || 1;
  p.shields /= sum; p.weapons /= sum; p.engines /= sum;
}
function route(system) {
  const p = state.power;
  const others = ['shields', 'weapons', 'engines'].filter(k => k !== system);
  // How much we can actually pull from the other two without dropping either below the floor.
  let pull = 0;
  for (const k of others) pull += Math.max(0, p[k] - ROUTE_FLOOR);
  const give = Math.min(ROUTE_STEP, pull);
  if (give <= 0.0001) { flash(`${POWER_NAMES[system]} POWER MAXED`); return; }
  // Drain the give proportionally from each donor's headroom above the floor, then hand it over.
  const headroom = others.reduce((a, k) => a + Math.max(0, p[k] - ROUTE_FLOOR), 0) || 1;
  for (const k of others) p[k] -= give * (Math.max(0, p[k] - ROUTE_FLOOR) / headroom);
  p[system] += give;
  normalisePower();
  flash(`POWER → ${POWER_NAMES[system]} ${Math.round(p[system] * 100)}%`);
  audio.play('shield', 0.12);
  if (tutorialMode && tutorial.active) tutorial.notifyRoute(system);
}
// Snap all three systems back to the default even 1/3 split (the mission-start / respawn state).
// Bound to the Reset Power key (default 5) and works identically in single-player and multiplayer,
// since routing is a purely local reactor balance — the server never owns it.
function resetPower() {
  const p = state.power;
  // No-op feedback if we're already balanced, so a stray press isn't a silent nothing.
  const already = Math.abs(p.shields - 1 / 3) < 0.001 && Math.abs(p.weapons - 1 / 3) < 0.001 && Math.abs(p.engines - 1 / 3) < 0.001;
  p.shields = 1 / 3; p.weapons = 1 / 3; p.engines = 1 / 3;
  flash(already ? 'POWER BALANCED 33/33/33' : 'POWER RESET → 33/33/33');
  audio.play('shield', 0.12);
  if (tutorialMode && tutorial.active) tutorial.notifyResetPower();
}
function toggleView() { view = view === 'first' ? 'third' : 'first'; ui.classList.toggle('third', view === 'third'); flash(view === 'first' ? 'COCKPIT VIEW' : 'CHASE VIEW'); if (tutorialMode && tutorial.active) tutorial.notifyView(); }
function flash(text) { alerts.textContent = text; clearTimeout(flash.t); flash.t = setTimeout(() => alerts.textContent = '', 1100); }

// ---- Scoring + Achievements glue --------------------------------------------------------------
// Per-session scoring feeds the worldwide leaderboard. Kills are the headline metric; the score
// also rewards capital kills and penalizes HULL damage (never shield damage). Achievements unlock
// live and pop a toast. See leaderboard.js for the catalog + persistence.

// Award an achievement and, if it's newly unlocked, pop a toast notification AND record it for the
// post-mission results screen (which lists what was earned this engagement).
function awardAchievement(achId) {
  const def = leaderboard.unlock(achId);
  if (def) { showAchievementToast(def); missionResults.achievements.push(def); }
}
// Re-check the kill-count milestone achievements off the current session kill total.
function checkKillAchievements() {
  if (state.kills >= 1) awardAchievement('first_blood');
  if (state.kills >= 5) awardAchievement('ace_run');
  if (state.kills >= 10) awardAchievement('double_ace');
  if (state.kills >= 25) awardAchievement('centurion');
  if (state.missileKills >= 6) awardAchievement('sharpshooter');
}
// Toast queue: stacked, auto-dismissing achievement pops in the corner.
const _achToastQueue = [];
let _achToastActive = false;
function showAchievementToast(def) {
  _achToastQueue.push(def);
  audio.play('lock', 0.5);   // a crisp confirm chime (re-uses the lock cue)
  if (!_achToastActive) drainAchievementToasts();
}
function drainAchievementToasts() {
  const host = $('achToasts');
  if (!host || _achToastQueue.length === 0) { _achToastActive = false; return; }
  _achToastActive = true;
  const def = _achToastQueue.shift();
  const el = document.createElement('div');
  el.className = 'achToast';
  el.innerHTML = `<span class="achIcon">${def.icon}</span>` +
    `<span class="achText"><span class="achLabel">ACHIEVEMENT UNLOCKED</span>` +
    `<span class="achName">${def.name}</span>` +
    `<span class="achDesc">${def.desc}</span></span>`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => { el.remove(); drainAchievementToasts(); }, 420);
  }, 3400);
}

// Submit the current run to the worldwide board. We submit PROGRESSIVELY — after every mission
// (see confirmMissionResults), on exit to the menu, and on tab-close — so EVERY pilot who scores
// lands on the board even if they only play a mission or two and never reach the campaign end. The
// proxy upserts by pilot name + difficulty (keeping their best), so repeat submits update one row
// rather than spawning duplicates. `_lastSubmittedScore` tracks the highest score we've already
// pushed this session so we skip redundant posts but always send a genuine improvement.
let _lastSubmittedScore = -1;
async function submitSessionScore() {
  if ((state.kills || 0) <= 0 && (state.score || 0) <= 0) return;
  // Nothing new to report since the last successful push.
  if ((state.score || 0) <= _lastSubmittedScore) return;
  const submitting = state.score || 0;
  _lastSubmittedScore = submitting;
  state.scoreSubmitted = true;
  // End-of-session-style achievements that depend on the running tally (safe to re-check; awards
  // are idempotent). These fire as soon as the thresholds are reached, mission to mission.
  if (!state.tookHullDamage && state.kills > 0) awardAchievement('flawless');
  if (state.score >= 2500) awardAchievement('high_roller');
  if (state.score >= 6000) awardAchievement('legend');
  const ok = await leaderboard.submitScore({
    name: leaderboard.getPilotName() || 'ANONYMOUS',
    score: state.score,
    kills: state.kills,
    difficulty: settings.difficulty,
  });
  if (ok) renderMenuTopScores();   // refresh the menu board with the new entry
  else _lastSubmittedScore = -1;   // submit failed (offline/network): allow a retry on the next hook
}

// Tab-close safety net: if the pilot closes/refreshes the tab mid-run, a normal fetch is usually
// killed before it lands, so beacon the current run on the way out. Covers the player who plays a
// mission or two and simply leaves without ever clicking back to the menu. Guarded by the same
// "only if there's something new to report" check so it never double-posts an already-sent score.
function beaconScoreOnExit() {
  if ((state.score || 0) <= 0 && (state.kills || 0) <= 0) return;
  if ((state.score || 0) <= _lastSubmittedScore) return;
  _lastSubmittedScore = state.score || 0;
  leaderboard.submitScoreBeacon({
    name: leaderboard.getPilotName() || 'ANONYMOUS',
    score: state.score,
    kills: state.kills,
    difficulty: settings.difficulty,
  });
}
// pagehide fires reliably on tab close, navigation, and mobile background; visibilitychange→hidden
// is the belt-and-suspenders partner some browsers honor better for backgrounding.
window.addEventListener('pagehide', beaconScoreOnExit);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beaconScoreOnExit(); });

// ---- Post-mission results screen --------------------------------------------------------------
// A debrief card shown AFTER the mission's audio debrief / warp-out and JUST BEFORE the hangar
// upgrade draft. It reports what the player did this engagement: kills (and capital kills), the
// running session total, the points lost to hull damage, and any achievements unlocked. The player
// clicks "Confirmed" to proceed into the hangar/draft.
//
// missionResults accumulates DURING the mission; beginMissionResults() snapshots the start-of-
// mission baselines so the screen can show per-mission deltas against lifetime/session counters.
const missionResults = { startKills: 0, startMissileKills: 0, startScore: 0, hullPenalty: 0, hullDamage: 0, achievements: [] };
function beginMissionResults() {
  missionResults.startKills = state.kills;
  missionResults.startMissileKills = state.missileKills;
  missionResults.startScore = state.score;
  missionResults.hullPenalty = 0;
  missionResults.hullDamage = 0;
  missionResults.achievements = [];
}
// When showDraft() is about to run, it first calls this. If results are pending we render the
// debrief card and hold; the "Confirmed" button clears the pending state and re-enters showDraft.
let _resultsPending = false;
let _resultsContinue = null;   // the showDraft(opts) continuation to run once the player confirms
function showMissionResults(continueFn) {
  _resultsContinue = continueFn;
  const overlay = $('results');
  const kills = state.kills - missionResults.startKills;
  const penalty = missionResults.hullPenalty;
  const earned = (state.score - missionResults.startScore);   // net points banked this mission
  const ach = missionResults.achievements;
  // Headline grade: a light flavor rating off the mission's kills + whether hull was kept clean.
  const grade = kills >= 8 ? 'S' : kills >= 5 ? 'A' : kills >= 3 ? 'B' : kills >= 1 ? 'C' : 'D';
  const clean = penalty === 0;
  // Build the stat rows.
  const rows = [
    { label: 'Enemy Ships Destroyed', value: `${kills}`, cls: 'good' },
    { label: 'Session Kill Total', value: `${state.kills}`, cls: '' },
    { label: 'Hull Damage Penalty', value: penalty > 0 ? `−${penalty}` : 'NONE', cls: penalty > 0 ? 'bad' : 'good' },
    { label: 'Difficulty', value: leaderboard.difficultyLabel(settings.difficulty), cls: '' },
    { label: 'Points Banked', value: `${earned >= 0 ? '+' : ''}${earned}`, cls: earned >= 0 ? 'good' : 'bad' },
  ];
  $('resGrade').textContent = grade;
  $('resGrade').className = 'resGrade grade' + grade;
  $('resStats').innerHTML = rows.map(r =>
    `<div class="resRow"><span class="resLabel">${r.label}</span><span class="resVal ${r.cls}">${r.value}</span></div>`).join('');
  // Achievements unlocked this mission (if any).
  const achWrap = $('resAch');
  if (ach.length) {
    achWrap.style.display = '';
    achWrap.innerHTML = '<div class="resAchHead">★ Achievements Unlocked</div>' +
      ach.map(a => `<div class="resAchItem"><span class="resAchIcon">${a.icon}</span>` +
        `<span class="resAchText"><b>${a.name}</b><span>${a.desc}</span></span></div>`).join('');
  } else {
    achWrap.style.display = 'none';
    achWrap.innerHTML = '';
  }
  // Subtitle flavor.
  $('resSub').textContent = clean
    ? 'Not a scratch on the hull, pilot. Outstanding flying.'
    : (kills > 0 ? 'Bandits down. Patch that hull on the deck.' : 'You held the line. Reset and rearm.');
  overlay.classList.add('show');
  // Free the cursor so the CONFIRMED button is immediately clickable (the debrief is a modal over
  // a still-"live" mission; without releasing lock the cursor stays captured by the canvas).
  document.exitPointerLock?.();
  audio.play('lock', 0.4);   // soft chime as the debrief card appears
}
function confirmMissionResults() {
  $('results').classList.remove('show');
  // NOTE: do NOT clear _resultsPending here. The continuation is showDraft(opts), which uses the
  // still-true _resultsPending flag to know it's on the SECOND pass and skip the results gate (it
  // clears the flag itself). Clearing it here made showDraft re-enter the gate and re-show this
  // debrief card forever, so "Confirmed" appeared to do nothing.
  const cont = _resultsContinue; _resultsContinue = null;
  // Progressive leaderboard push: log the run NOW that a mission is in the books, so a pilot who
  // plays only a mission or two — and never reaches the campaign end or the exit-to-menu path —
  // still registers on the worldwide board. Fire-and-forget; the proxy upserts the pilot's row.
  submitSessionScore();
  if (cont) cont();   // proceed into the hangar/draft
}
$('resConfirm').addEventListener('click', () => { audio.unlock(); audio.play('laser', 0.5); confirmMissionResults(); });
// Cockpit shield-absorb edge-flash. The surrounding shield dome can't read as a bubble from inside
// it (first-person camera sits at its center), so when the shields soak a hit we pulse the
// #shieldVignette canopy-rim glow instead. `strength` (0..1) scales the peak brightness. Driven down
// each frame by fadeShieldVignette(). Only actually shown in first-person (third-person uses the dome).
const _shieldVignetteEl = $('shieldVignette');
let _shieldVignette = 0;
function triggerShieldVignette(strength = 1) {
  _shieldVignette = Math.max(_shieldVignette, THREE.MathUtils.clamp(strength, 0, 1));
}
function fadeShieldVignette(dt) {
  if (_shieldVignette > 0) _shieldVignette = Math.max(0, _shieldVignette - dt * 3.2);
  // Show only in true first-person flight (not chase, not the cinematic chase shots).
  const fp = view === 'first' && !warpingIn && !briefingHold && !cinematicFirstPerson;
  const o = fp ? _shieldVignette * _shieldVignette * 0.95 : 0;   // quadratic falloff → sharp flash
  _shieldVignetteEl.style.opacity = o.toFixed(3);
}

// ---- Pause menu (Escape during gameplay) ----
// Freezes the game loop by clearing the animation loop, releases pointer lock so the
// overlay is interactive, and opens the settings panel titled "Paused".
function openPauseMenu() {
  if (paused) return;
  paused = true;
  pausedFromGameplay = true;
  renderer.setAnimationLoop(null);     // halt updates AND rendering while paused
  document.exitPointerLock?.();
  // NOTE: deliberately do NOT clear `keys` here. The loop is halted while paused, so a held key
  // can't move the ship; but clearing it would strand a still-held movement key (e.g. W) on resume
  // because the browser won't re-send its keydown. The keyup listener keeps the set accurate.
  audio.stopEngineHum();               // silence the cockpit hum while frozen
  audio.play('shield', 0.3);
  // In a connected multiplayer match the Game tab shows Voice Comms (transmit mode, squad-only,
  // keybinds) instead of solo Difficulty; the subhead reflects the swap.
  const mp = freeFlightMode && multiplayer.connected;
  settingsUI.open('Paused', mp ? 'Voice, Controls & About' : 'Sound, Controls & About', 'Resume', { multiplayer: mp });
}
function resumeFromPause() {
  if (!paused) return;
  paused = false;
  pausedFromGameplay = false;
  // Re-acquire pointer lock for flight aim and restart the loop where it left off.
  lockPointer();
  timer.getDelta();                    // discard the long paused interval so we don't jump
  renderer.setAnimationLoop(loop);
}
// Bail from gameplay back to the "Welcome to Hammer Squadron" main menu.
function exitToMainMenu() {
  paused = false;
  renderer.setAnimationLoop(null);
  // Tear down the tutorial if we're bailing mid-flight-school (pause-menu quit or completion).
  if (tutorialMode || tutorial.active) { tutorialMode = false; tutorial.stop(); }
  // Leave the co-op arena (drop the realtime room + remote ghosts) if bailing from Free Flight.
  leaveFreeFlight();
  mission = null;
  warping = false; warpingIn = false; warpInPhase = 'idle'; briefingHold = false;
  tutorialWarpHold = false; _returnToWarpMenu = false; $('warpMenu').classList.remove('show');   // drop the post-tutorial warp menu if bailing from it
  if (briefingSeq) { briefingSeq.cancel(); briefingSeq = null; }   // stop a mid-play briefing sequence
  m1Outro.active = false; m1Outro.phase = 'idle'; cinematicFirstPerson = false; warpOut.stop();   // abort the mission-1 outro if mid-cinematic
  warpIn.endHold();                    // clear the briefing star-tube if we bailed mid-briefing
  ui.classList.toggle('third', view === 'third');   // drop any chase-presentation class from warp-in/briefing
  awaitingHyperspace = false; $('hyperPrompt').classList.remove('show');
  hangar.hide(); $('draft').classList.remove('show'); ui.classList.remove('drafting');
  $('results').classList.remove('show'); _resultsPending = false; _resultsContinue = null;   // drop a pending results card on bail
  $('matchResults').classList.remove('show'); _ffMatchLive = false; _ffMatchEnding = false;   // hide the multiplayer scoreboard if bailing from it
  hideMatchBar(); hideWinBanner(); clearKillFeed();     // clear the SDM round clock/score, winner banner + kill feed
  // Tear down the timed ship-select if we bailed mid-pick (stop the countdown + rotating previews).
  _shipSelectDone = true;
  if (_shipSelectTimer) { clearInterval(_shipSelectTimer); _shipSelectTimer = null; }
  closeShipSelect();
  audio.stopHum();                     // kill the travel hum if we bailed mid-warp
  audio.stopEngineHum();               // kill the cockpit engine hum on returning to menu
  scene.background = skyTex;            // restore the starfield in case we bailed mid-warp
  document.exitPointerLock?.();
  keys.clear(); kbHeld.clear();
  clearShipGroup(enemies); boltGroup.clear(); missileGroup.clear(); explosions.clear();
  // Submit this run to the worldwide leaderboard before we wipe the session (fire-and-forget; the
  // board refreshes itself on success). No-ops if the run was empty or already posted.
  submitSessionScore();
  // Reset campaign progress so the next Start begins a fresh run, not mid-campaign.
  missionIndex = 0;
  Object.assign(state, createPlayerState());
  _lastSubmittedScore = -1;   // fresh session: allow the next run to post from scratch
  ui.classList.add('cinematic');       // hide the gameplay HUD behind the menu
  audio.fade(audio.music, 0, 600);     // duck the battle soundtrack under the menu
  const menu = $('mainMenu');
  menu.classList.add('show');
  requestAnimationFrame(() => menu.classList.add('in'));
}

// Pre-mission loading screen: shown before each hyperspace jump so the heavy GLB models and
// battle audio are confirmed warm in cache before warp-in begins. After the intro preload these
// resolve effectively instantly, so the bar is paced to a short, readable beat rather than a
// real long wait — but it guarantees assets are ready ahead of the jump and gives a clean
// "preparing jump" moment between menu/draft and combat.
const mlAudioUrls = [
  'assets/audio/laser-player-blaster-2.mp3', 'assets/audio/laser-enemy-cannon-3.mp3',
  'assets/audio/combat-space-loop.mp3', 'assets/audio/shield-impact-alert.mp3',
  'assets/audio/explosion-ship-destroyed.mp3', 'assets/audio/hyperspace-warp-in.mp3',
  'assets/audio/hyperspace-hum-loop.mp3', 'assets/audio/warp-dropout.mp3',
  'assets/audio/voice/overwatch/mission1.mp3',
  // Mission 2's 8-part Overwatch briefing — warmed in cache before the jump so the lines play
  // back-to-back without buffering hitches.
  'assets/audio/voice/overwatch/mission2b/minssion2b1.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b2.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b3.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b4.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b5.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b6.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b7.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b8.mp3',
  // Mission 3 — star-tunnel briefing + the two wingman fight-intro lines (Slick then O.G.).
  'assets/audio/voice/mission3/mission2brief.mp3',
  'assets/audio/voice/mission3/slickmission3intro.mp3',
  'assets/audio/voice/mission3/ogmission3intro.mp3'
];
// Mission 3's star-tunnel briefing (single clip, played over the held hyperspace tunnel like
// Mission 1) and the two in-fight wingman intros radioed in once the player drops to sublight.
const MISSION3_BRIEFING = 'assets/audio/voice/mission3/mission2brief.mp3';
const MISSION3_SLICK_INTRO = 'assets/audio/voice/mission3/slickmission3intro.mp3';
const MISSION3_OG_INTRO = 'assets/audio/voice/mission3/ogmission3intro.mp3';
let _launchInFlight = false;   // guards against a second mission launch overlapping the first
function launchMission() {
  // Guard against a second launch overlapping the first (re-entrancy safety net).
  if (_launchInFlight) return;
  _launchInFlight = true;
  // Campaign always flies the Lightning — undo any Free Flight ship pick before the mission loads.
  if (player.userData.shipId && player.userData.shipId !== 'lightning') resetToDefaultHull();
  const next = { ...missions[missionIndex % missions.length] };
  const overlay = $('missionLoad'), fill = $('mlFill'), pct = $('mlPct');
  $('mlTitle').textContent = (next.type || 'PREPARING JUMP').toUpperCase();
  $('mlSub').textContent = next.title || 'Spinning up hyperdrive';
  fill.style.width = '0%'; pct.textContent = 'CALIBRATING 0%';
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.classList.add('in'));

  let mProg = 0, aProg = 0, shown = 0;
  const render = () => {
    const target = Math.min(100, Math.round((mProg * 0.6 + aProg * 0.4) * 100));
    shown = Math.max(shown, target);                 // monotonic so the bar never jumps backward
    fill.style.width = shown + '%';
    pct.textContent = (shown < 100 ? 'CALIBRATING ' : 'JUMP READY ') + shown + '%';
  };
  // Warm the asset caches (instant after the intro preload) and hold the screen a short beat so
  // the "preparing jump" moment reads, then hide it and fire the actual mission warp-in.
  const ready = Promise.all([
    preloadModels(p => { mProg = p; render(); }),
    preloadAudio(mlAudioUrls, p => { aProg = p; render(); })
  ]);
  const minHold = new Promise(res => setTimeout(res, 1400));
  // Mission 3 opens on a scripted cutscene (O.G. & Slick warp in, O.G. is ambushed and crippled)
  // BEFORE the star-tunnel briefing + jump-in, so route the loading-screen handoff through it.
  const isMission3 = (missionIndex % missions.length) === 2;
  Promise.all([ready, minHold]).then(() => {
    mProg = 1; aProg = 1; render();
    setTimeout(() => {
      overlay.classList.remove('in');
      setTimeout(() => {
        overlay.classList.remove('show');
        if (isMission3) playMission3Cutscene();
        else beginMission();
      }, 480);
    }, 260);
  });
}

// Mission 3 pre-briefing cutscene: O.G. & Slick drop out of hyperspace, O.G. is hit and his
// engines blow out (he can't make the next jump). Plays full-screen with the HUD hidden, then
// hands straight into beginMission() which runs the star-tunnel briefing + warp-in.
let mission3Cutscene = null;
function playMission3Cutscene() {
  ui.classList.add('cinematic');         // hide the gameplay HUD for the cutscene
  $('skipScene').style.display = 'block';
  audio.stopMusic(500);                  // drop the battle bed so the cutscene score owns the mix
  const done = () => {
    if (mission3Cutscene && mission3Cutscene._handed) return;
    if (mission3Cutscene) mission3Cutscene._handed = true;
    mission3Cutscene = null;
    $('skipScene').style.display = 'none';
    ui.classList.remove('cinematic');    // reveal the HUD again for the mission
    // Make sure the audio context is live again before the briefing VO plays (the cutscene faded
    // its own score; resuming here guards against a suspended context swallowing the first clip).
    if (audio.ctx && audio.ctx.state === 'suspended') { try { audio.ctx.resume(); } catch {} }
    beginMission();                      // runs the star-tunnel briefing VO + warp-in
    // Bring the rotating battle soundtrack back a beat LATER so it doesn't race the briefing clip's
    // play() on the shared audio context (which was intermittently swallowing the briefing VO).
    setTimeout(() => audio.startMusic(0.28), 900);
  };
  mission3Cutscene = new Mission3Cutscene(renderer, audio, done);
  mission3Cutscene.start(true);
}

// Mission 2's Overwatch briefing is split across 8 numbered voice files, played in order with a
// half-second beat between each. (File 1 has a 'minssion' spelling typo in its name; the rest are
// 'mission2bN'.) Played over the held hyperspace tunnel before the jump-in, like mission 1.
const MISSION2_BRIEFING = [
  'assets/audio/voice/overwatch/mission2b/minssion2b1.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b2.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b3.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b4.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b5.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b6.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b7.mp3',
  'assets/audio/voice/overwatch/mission2b/mission2b8.mp3'
];
let briefingSeq = null;   // active multi-clip briefing sequence handle (so we can cancel on bail)
let briefingClip = null;  // active single briefing Audio element (mission 1), so SPACE can stop it
let briefingOnDone = null; // the briefing's completion handoff, invoked when the player skips it
// Skip the in-progress pre-jump briefing: silence whatever briefing audio is playing and hand off
// to the jump immediately. Safe to call when no briefing is active (no-op). Returns true if it
// actually skipped a live briefing, so the key handler can swallow the press.
function skipBriefing() {
  if (!briefingHold) return false;
  // Stop the audio AND disarm its completion callback. Pausing alone left the clip's safety-net
  // ended-timeout armed, so at the clip's natural end it re-ran the handoff and reset the mission
  // back to warp-in. _cancel() clears that timeout/onended so the natural end can never fire.
  if (briefingSeq) { briefingSeq.cancel(); briefingSeq = null; }
  if (briefingClip) { try { briefingClip._cancel ? briefingClip._cancel() : briefingClip.pause(); } catch {} briefingClip = null; }
  hideSubtitle();   // clear any on-screen briefing caption when the player skips
  const done = briefingOnDone;
  briefingOnDone = null;
  if (done) done();   // same handoff the briefing's natural end would run (starts the warp-in jump)
  return true;
}
// Scale a freshly-spawned hostile's hull by the active difficulty's enemyHp multiplier (Recruit
// makes them flimsier, Veteran/Ace tankier). Applied at spawn so it never mid-fight changes a
// ship's current HP. Returns the enemy for chaining.
function applyDifficultyHp(e) {
  const k = difficultyMods().enemyHp;
  if (k !== 1 && e.userData) { e.userData.maxHp *= k; e.userData.hp *= k; }
  return e;
}
function beginMission() {
  _launchInFlight = false;   // the launch sequence has reached the mission; allow future launches
  clearShipGroup(enemies); clearShipGroup(allies); boltGroup.clear(); missileGroup.clear(); explosions.clear();
  mission = { ...missions[missionIndex % missions.length] };
  capture = 0; waveClear = false; _lockedEnemy = null;
  state.waveHullClean = true;   // re-arm the per-wave "no hull damage" achievement check
  beginMissionResults();        // snapshot the start-of-mission tallies for the post-mission results screen
  lockProgress = 0; missileLocked = false; audio.stopLockTone();
  // Reset the wingmen's cover/battery mood so a previous mission's beating doesn't carry over.
  recentPlayerDamage = 0; wingmenCovering = false;
  // Reset the Mission 2 scripted intro: cancel any pending cue timers and clear the references.
  mission2IntroStarted = false;
  for (const t of _mission2IntroTimers) clearTimeout(t);
  _mission2IntroTimers = [];
  introSlick = null; introOG = null;
  // Reset the Mission 3 scripted intro + escort state.
  mission3IntroStarted = false; protectOG = null; _ogRepairDoneBark = false; _ogHalfHealthBark = false;
  _m3JumpArmed = false; _m3RepairLineStarted = false;
  for (const t of _mission3IntroTimers) clearTimeout(t);
  _mission3IntroTimers = [];
  for (const t of _m3OutroTimers) clearTimeout(t);
  _m3OutroTimers = [];
  // Re-arm the reactive Mission 2 wingman barks and cancel any pending follow-up timers.
  _slickHitBark = false; _ogDownBark = false;
  _firstGenCalled = false; _secondGenCalled = false;   // re-arm the generator-down callouts
  for (const t of _mission2BarkTimers) clearTimeout(t);
  _mission2BarkTimers = [];
  // Replenish the missile/chaff loadout fresh for each engagement. Missile-rack upgrade cards add
  // to the base loadout via the missileCapacity mod.
  state.missiles = state.maxMissiles + (state.mods.missileCapacity || 0); state.chaff = state.maxChaff;
  resetScaaviAlerts();   // clean SCAAVI bark state for the new mission
  awaitingHyperspace = false; $('hyperPrompt').classList.remove('show');
  // Mission 1 (the opening DOGFIGHT, first wave) always fields exactly 6 hostiles; later waves
  // and missions scale up with the campaign as before.
  const firstDogfight = (missionIndex === 0 && state.wave === 1);
  const count = firstDogfight ? 6 : mission.fighters + Math.floor(state.wave * 1.2);
  // Mission 2 stages the engagement ~3km downrange so the player drops out of hyperspace into
  // empty space, giving the scripted wingman-introduction sequence room to play out before contact.
  const mission2 = mission.capital && (missionIndex % missions.length) === 1;
  // Mission 3 (PROTECT O.G.) stages an initial fighter screen ~1.2km out so the player drops in,
  // hears the wingman intros, then engages. A wave-spawner (see updateMission) tops the screen up
  // for the 7-minute hold, so the opening count is kept modest.
  const mission3 = !!mission.protectOG && (missionIndex % missions.length) === 2;
  const m3Count = mission3 ? mission.fighters : count;
  // Mission 2 (CAPITAL STRIKE) fields its opening fighter screen DIFFERENTLY: 8 bandits are already
  // active, but they start clustered AROUND the Dreadnought (CAP-orbit guard) rather than as a wall
  // 3km downrange. They patrol the carrier and only break off to press the player/wingmen once
  // something hostile closes inside 300m. A SECOND squadron stays docked in the bays and launches
  // only when the carrier's HULL is actually hit (see seatHangarFighters + the hull-hit launch).
  // The opening screen is spawned by spawnMission2Guard() below; skip the generic loop for M2.
  const m2HangarLaunch = mission2;
  for (let i = 0; !m2HangarLaunch && i < (mission3 ? m3Count : count); i++) {
    const kind = i % 5 === 0 ? 'bomber' : i % 3 === 0 ? 'drone' : 'interceptor';
    // Spawn hostiles a fair distance ahead of the arrival point and well spread out, so the
    // player drops in with the enemy formation comfortably downrange rather than on top of them.
    const spawn = mission2
      ? new THREE.Vector3(
          THREE.MathUtils.randFloatSpread(900),
          THREE.MathUtils.randFloatSpread(300),
          -2900 - Math.random() * 700            // ~3km out so the intro plays before contact
        )
      : mission3
        ? new THREE.Vector3(
            THREE.MathUtils.randFloatSpread(600),
            THREE.MathUtils.randFloatSpread(220),
            -1100 - Math.random() * 500          // ~1.2km out: room for the intros before contact
          )
        : new THREE.Vector3(
            THREE.MathUtils.randFloatSpread(150),
            THREE.MathUtils.randFloatSpread(70),
            -180 - Math.random() * 140
          );
    const e = applyDifficultyHp(makeEnemy(kind, spawn, trails));
    // In DEFEND missions, roughly half the hostiles (and every bomber) prioritize the allied
    // flagship rather than chasing the player, so the player has to actively intercept them.
    if (mission.defend && (kind === 'bomber' || i % 2 === 0)) e.userData.attacksFlagship = true;
    // In Mission 3 the MAJORITY of hostiles (and every bomber) home in on the crippled O.G. so it
    // genuinely comes under siege and the player must actively intercept. The share that presses
    // O.G. scales with difficulty (m3AttackOGFrac) so Normal bites harder than Recruit.
    if (mission3 && (kind === 'bomber' || Math.random() < m3AttackOGFrac())) e.userData.attacksOG = true;
    enemies.add(e);
  }
  // The enemy capital anchors the engagement; in Mission 2 it warps in ~1km ahead of the player.
  if (mission.capital) {
    const cap = applyDifficultyHp(makeEnemy('capital', new THREE.Vector3(0, -10, mission2 ? -1000 : -300), trails));
    enemies.add(cap);
    // Mission 2: 8 fighters fly active GUARD around the Dreadnought from the start (engageable
    // immediately, but holding near the carrier until something closes inside 300m), and a SECOND
    // squadron of 8 sits DOCKED in the bays, launched only when the carrier's HULL is hit.
    if (m2HangarLaunch) { spawnMission2Guard(cap, 8); seatHangarFighters(cap); }
  }
  // ---- Named wingmen: Slick & O.G. (Mission 2 / CAPITAL STRIKE) ----
  // Two scripted hero wingmen drop out of hyperspace alongside the player to help crack the
  // enemy carrier. They spawn well behind the arrival point and streak forward into formation
  // (their own brief warp-in slide handled in updateAllies), then prioritize the capital's
  // turret batteries to soften it while the player clears fighters. If the player starts taking
  // heavy damage, they peel off to engage enemy fighters and cover the player instead.
  introSlick = null; introOG = null;
  if (mission.capital && (missionIndex % missions.length) === 1) {
    // Slick forms up over the player's RIGHT wing/shoulder, O.G. over the LEFT. (Nose is -Z, so
    // +X is the player's right.) Each wingman is spawned now but HELD hidden off-stage until the
    // scripted intro releases it on its audio cue (see startMission2Intro).
    const wingmen = [
      { kind: 'slick', call: 'SLICK', off: new THREE.Vector3( 16,  2, 26) },   // right shoulder
      { kind: 'og',    call: 'O.G.',  off: new THREE.Vector3(-16, -1, 30) }    // left shoulder
    ];
    for (const w of wingmen) {
      // Start them far back along +Z (behind the player's warp-start) and offset to the side, so
      // they read as exiting hyperspace just off the player's wing when released.
      const startPos = new THREE.Vector3(w.off.x, w.off.y, 240 + w.off.z);
      const ally = makeAlly(w.kind, startPos, trails);
      ally.userData.wingman = true;       // flag the special capital-battery-focused AI
      ally.userData.callSign = w.call;
      ally.userData.formOffset = w.off.clone();   // resting formation offset relative to the player
      ally.userData.role = 'batteries';   // 'batteries' (hunt capital turrets) | 'cover' (defend player)
      // Distinct flying PERSONALITY per pilot so the two never animate in lockstep. Slick is the
      // twitchy hot-shot (faster, sharper weave, banks right first); O.G. is the steady veteran
      // (slower weave, calmer amplitude, banks left first). Random phase offsets desync their jink.
      const slick = w.kind === 'slick';
      ally.userData.jinkRate = slick ? 1.5 : 0.85;
      ally.userData.jinkPhase = Math.random() * Math.PI * 2;
      ally.userData.weaveAmp = slick ? 0.32 : 0.18;        // lateral weave strength
      ally.userData.weaveVert = slick ? 0.2 : 0.11;        // vertical bob strength
      ally.userData.strafeDir = slick ? 1 : -1;            // opposite strafe so passes split apart
      ally.userData.fireT = Math.random() * 0.5;           // desync first shot so bolts don't sync
      // Held off-stage: hidden, frozen (no AI/arrive) until the intro warps it in on cue.
      ally.userData.introHold = true;
      ally.visible = false;
      ally.userData.spawnSide = w.off.clone();   // remembered warp-in start offset for the fly-in
      allies.add(ally);
      if (w.kind === 'slick') introSlick = ally; else introOG = ally;
    }
  }
  // ---- Mission 3: DAMAGED O.G. + escort Slick (PROTECT O.G.) ----
  // O.G. took a missile to the engines in the pre-briefing cutscene: he can STILL FLY, just slower,
  // listing and trailing smoke, and he can't make the jump until repairs finish. He flies the
  // normal wingman AI (so he fights alongside the player) but throttled down + smoking. The player
  // must keep hostiles off him for 7 minutes; once the repair clock runs out his engines come back
  // online and he's restored to full. The mission fails if O.G. is destroyed (protectOG cleared in
  // killAlly). Slick flies active cover beside him.
  if (mission3) {
    // Damaged O.G., flying but hobbled, just ahead of the player's arrival point.
    const ogPos = new THREE.Vector3(0, 0, -120);
    const og = makeAlly('og', ogPos, trails);
    og.userData.callSign = 'O.G.';
    og.userData.wingman = true;         // flies the wingman AI (fights), but throttled by `damaged`
    og.userData.role = 'cover';         // hunt the fighters pressing the engagement, no capital here
    og.userData.damaged = true;         // engines wrecked: slow, smoking, listing (updateWingman/Allies)
    og.userData.fullSpeed = og.userData.speed;   // remember his healthy speed so repairs can restore it
    og.userData.speed *= 0.42;          // limps along at well under cruise while crippled
    og.userData.maxHp = 1000; og.userData.hp = 1000;   // sturdy, but he CAN be lost over the 3-min hold if neglected
    og.userData.smokeAt = 0;
    og.userData.formOffset = new THREE.Vector3(-16, 1, 26);
    og.userData.jinkRate = 1.0; og.userData.jinkPhase = Math.random() * Math.PI * 2;
    og.userData.weaveAmp = 0.18; og.userData.weaveVert = 0.12;
    og.userData.strafeDir = 1;
    og.userData.fireT = Math.random() * 0.6;
    allies.add(og);
    protectOG = og;
    // Slick flies active cover. Reuse the wingman AI but force the 'cover' role so he chases the
    // fighters threatening O.G./the player rather than hunting a (nonexistent) capital's batteries.
    const slickStart = new THREE.Vector3(18, 2, -96);
    const slick = makeAlly('slick', slickStart, trails);
    slick.userData.wingman = true;
    slick.userData.callSign = 'SLICK';
    slick.userData.formOffset = new THREE.Vector3(16, 2, 26);
    slick.userData.role = 'cover';
    slick.userData.escortOG = true;     // Mission 3 flavour: stays near O.G. when no fighter is close
    slick.userData.jinkRate = 1.5;
    slick.userData.jinkPhase = Math.random() * Math.PI * 2;
    slick.userData.weaveAmp = 0.32; slick.userData.weaveVert = 0.2;
    slick.userData.strafeDir = 1;
    slick.userData.fireT = Math.random() * 0.5;
    allies.add(slick);
  }
  // ---- Allied ("good guy") fleet for DEFEND missions ----
  // The player escorts a friendly flagship. It anchors the scene between the player's arrival
  // point and the hostiles, with a small escort wing flying cover around it. The mission is lost
  // if the flagship is destroyed.
  if (mission.defend) {
    const flagPos = new THREE.Vector3(0, 6, -90);
    const flagship = makeAlly('flagship', flagPos, trails);
    allies.add(flagship);
    defendTarget = flagship;
    // Escort wing: a mix of allied fighter types stationed around the flagship.
    const wingKinds = ['paladin', 'sentinel', 'warden', 'paladin', 'warden'];
    const wing = mission.escort ?? 4;
    for (let i = 0; i < wing; i++) {
      const ang = (i / wing) * Math.PI * 2;
      const pos = flagPos.clone().add(new THREE.Vector3(Math.cos(ang) * 34, 6 + Math.sin(ang) * 8, 18 + Math.sin(ang) * 20));
      allies.add(makeAlly(wingKinds[i % wingKinds.length], pos, trails));
    }
  } else {
    defendTarget = null;
  }
  // Start the ship far enough behind its engagement spot that the full hyperspace run (a few
  // seconds cruising through the tunnel, then the deceleration drop-out) streaks it forward and
  // lands it right in the scene. The nose is local -Z (toward the enemies), so we set it back
  // along +Z by the warp-in's total travel distance and let WarpIn fly it in on rails.
  const warpExitSpeed = 30;
  // Mission 2's first entry (just after the upgrade/hangar draft) gets its own multi-part briefing.
  const secondMission = (missionIndex === 1 && state.wave === 2);
  // Mission 3 (PROTECT O.G.) gets a single star-tunnel briefing clip, played AFTER its cutscene.
  const thirdMission = mission3;
  // After a held briefing (the holding tunnel already sold the "travelling" beat), use a SHORT
  // warp-in cruise so the drop-out arrives promptly once the briefing ends, instead of replaying
  // another full 3s cruise. Other jumps use the default cruise length.
  const warpCruiseDur = (secondMission || thirdMission) ? 1.0 : warpIn._defaultCruiseDur;
  // Place the ship back by the travel distance for THIS jump's cruise length, so it still lands in
  // the engagement zone regardless of the chosen cruise.
  const startBack = warpIn.totalDistance(warpExitSpeed, warpCruiseDur);
  player.position.set(0, 0, startBack); player.rotation.set(0, 0, 0); player.userData.vel.set(0, 0, -28);
  // Reset engine trail history so ribbons don't snap across the map on respawn/new wave.
  if (player.userData.engines) for (const eng of player.userData.engines) eng.trail.userData.history.length = 0;
  $('missionTitle').textContent = mission.type;
  $('missionText').textContent = mission.title;
  // Mission 1 (opening DOGFIGHT, first wave) gets an Overwatch briefing line BEFORE the player
  // drops out of hyperspace: play it over the held pre-warp scene, then trigger the jump-in once
  // it finishes. Every other mission jumps in immediately. `_warpExitSpeed`/`_warpCruiseDur` are
  // stashed so the gated start can hand WarpIn the same exit speed + cruise length.
  _warpExitSpeed = warpExitSpeed;
  _warpCruiseDur = warpCruiseDur;
  // Re-assert keyboard focus + pointer lock for the new mission. The between-mission upgrade draft
  // releases pointer lock (so the OS cursor can click the cards) and the iframe can lose keyboard
  // focus to the editor — without this, Mission 2+ would drop out of warp-in with the mouse aiming
  // but the KEYBOARD dead (thrust/etc. ignored) until the player manually clicked back in.
  grabFocus();
  lockPointer();
  renderer.setAnimationLoop(loop);   // run the loop so the scene renders during the briefing
  if (firstDogfight || secondMission || thirdMission) {
    // Hold the pre-warp scene (no input/AI) while the Overwatch briefing plays, then jump in.
    // The hyperspace star-tube streaks past the whole time so the briefing reads as "already in
    // the tunnel, awaiting the jump" rather than a static black void.
    briefingHold = true;
    ui.classList.add('third');   // chase presentation: the briefing reads as the ship already in the tunnel
    $('briefSkip').classList.add('show');   // show the "PRESS SPACE TO SKIP" hint for the whole briefing
    warpIn.beginHold();
    // When the briefing finishes, hand straight off to the real jump (which keeps the streak field
    // live so there's no flicker); guard against the player having bailed to the menu meanwhile.
    let _briefingHanded = false;
    const onBriefingDone = () => {
      if (_briefingHanded) return;   // one-shot: skip + natural-end must never both run the handoff
      _briefingHanded = true;
      briefingSeq = null;
      briefingClip = null;
      briefingHold = false;
      $('briefSkip').classList.remove('show');   // clear the skip hint once the briefing is over/skipped
      if (mission && !warpingIn) startWarpIn();   // keeps the chase `.third` presentation through arrival
      else { warpIn.endHold(); ui.classList.toggle('third', view === 'third'); }
    };
    // Remember how to dismiss the briefing audio so SPACE can skip straight to the jump.
    briefingOnDone = onBriefingDone;
    if (secondMission) {
      // Mission 2: play the 8 briefing lines in order, 0.5s apart, then jump in.
      briefingSeq = audio.playClipSequence(MISSION2_BRIEFING, {
        volume: 0.95, gapMs: 500, onAllEnded: onBriefingDone,
        onClipStart: (url, el) => captionVoice(url, 'OVERWATCH', el),   // sync caption to each line as it begins
      });
    } else if (thirdMission) {
      // Mission 3: a single star-tunnel briefing clip, then jump straight into the fight.
      briefingClip = audio.playClip(MISSION3_BRIEFING, 0.95, onBriefingDone);
      captionVoice(MISSION3_BRIEFING, 'OVERWATCH', briefingClip);
    } else {
      briefingClip = audio.playClip('assets/audio/voice/overwatch/mission1.mp3', 0.95, onBriefingDone);
      captionVoice('assets/audio/voice/overwatch/mission1.mp3', 'OVERWATCH', briefingClip);
    }
  } else {
    startWarpIn();
  }
}

// ================================================================================================
// INTERACTIVE FLIGHT-CONTROLS TUTORIAL
// ------------------------------------------------------------------------------------------------
// Sets up a clean training space (no mission objectives, no scripted wingmen) and runs the
// TutorialController step-by-step flight school. The player drops out of hyperspace into empty
// space, then the controller walks them through every control, target practice on stationary
// cargo containers, and a closing 3-fighter dogfight.
// ================================================================================================
let _tutorialStartT = 0;   // grace timer so input flags aren't tripped by warp-in residual motion
function enterTutorialFromMenu() {
  const menu = $('mainMenu');
  menu.classList.remove('show');
  menu.removeAttribute('data-busy');
  $('missionJump').classList.remove('show');
  ui.classList.remove('cinematic');
  audio.startMusic(0.22);
  lockPointer();
  launchTutorial();
}
function launchTutorial() {
  if (_launchInFlight) return;
  _launchInFlight = true;
  // Flight school flies the Lightning — undo any Free Flight ship pick.
  if (player.userData.shipId && player.userData.shipId !== 'lightning') resetToDefaultHull();
  const overlay = $('missionLoad'), fill = $('mlFill'), pct = $('mlPct');
  $('mlTitle').textContent = 'FLIGHT SCHOOL';
  $('mlSub').textContent = 'Training range · Hammer Squadron';
  fill.style.width = '0%'; pct.textContent = 'CALIBRATING 0%';
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.classList.add('in'));
  let mProg = 0, aProg = 0, shown = 0;
  const render = () => {
    const target = Math.min(100, Math.round((mProg * 0.6 + aProg * 0.4) * 100));
    shown = Math.max(shown, target);
    fill.style.width = shown + '%';
    pct.textContent = (shown < 100 ? 'CALIBRATING ' : 'JUMP READY ') + shown + '%';
  };
  const tutAudio = [
    'assets/audio/voice/tutorial/tutorialow1.mp3',
    'assets/audio/voice/tutorial/tutorialow2.mp3',
    'assets/audio/voice/tutorial/tutorialow3.mp3'
  ];
  const ready = Promise.all([
    preloadModels(p => { mProg = p; render(); }),
    preloadAudio([...tutAudio, ...CONTAINER_MODEL_URLS], p => { aProg = p; render(); })
  ]);
  const minHold = new Promise(res => setTimeout(res, 1200));
  Promise.all([ready, minHold]).then(() => {
    mProg = 1; aProg = 1; render();
    setTimeout(() => {
      overlay.classList.remove('in');
      setTimeout(() => { overlay.classList.remove('show'); beginTutorial(); }, 480);
    }, 240);
  });
}
function beginTutorial() {
  _launchInFlight = false;
  tutorialMode = true;
  tutorialContainers = 0;
  // Reset the playfield exactly like beginMission, but field NO hostiles/allies/objectives.
  clearShipGroup(enemies); clearShipGroup(allies); boltGroup.clear(); missileGroup.clear(); explosions.clear();
  // A bare "training" mission object so the gameplay loop runs (it only checks `mission` truthiness),
  // while updateMission/AI short-circuit on the tutorial flag.
  mission = { type: 'FLIGHT SCHOOL', title: 'Training range', tutorial: true, timer: 0 };
  capture = 0; waveClear = false; _lockedEnemy = null;
  lockProgress = 0; missileLocked = false; audio.stopLockTone();
  defendTarget = null; protectOG = null;
  recentPlayerDamage = 0; wingmenCovering = false;
  // Generous loadout so the player can freely practise missiles + chaff.
  state.missiles = 6; state.chaff = 6;
  state.shields = state.maxShields; state.heat = 0; state.energy = 100;
  awaitingHyperspace = false; $('hyperPrompt').classList.remove('show');
  beginMissionResults();
  $('missionTitle').textContent = mission.type;
  $('missionText').textContent = mission.title;
  // Warp the ship into an empty training volume, same rails as a normal mission start.
  const warpExitSpeed = 30;
  const warpCruiseDur = warpIn._defaultCruiseDur;
  const startBack = warpIn.totalDistance(warpExitSpeed, warpCruiseDur);
  player.position.set(0, 0, startBack); player.rotation.set(0, 0, 0); player.userData.vel.set(0, 0, -28);
  if (player.userData.engines) for (const eng of player.userData.engines) eng.trail.userData.history.length = 0;
  _warpExitSpeed = warpExitSpeed;
  _warpCruiseDur = warpCruiseDur;
  grabFocus();
  lockPointer();
  renderer.setAnimationLoop(loop);
  _tutorialStartT = 0;
  startWarpIn();   // the controller is armed once warp-in completes (see startWarpIn onDone path)
}

// ================================================================================================
// CO-OP FREE FLIGHT (multiplayer arena)
// ------------------------------------------------------------------------------------------------
// Drops the player into a shared open-space volume where other online pilots' ships appear as
// ghosts (see multiplayer.js). No objectives, no hostiles — just free flight with real people. The
// entry flow mirrors the tutorial: menu handoff -> loading screen -> warp-in into an empty volume,
// then join() the realtime room once the ship settles.
// ================================================================================================
// ---- Ship-select hangar + multiplayer lobby --------------------------------------------------
// After the call-sign step, Free Flight opens the HANGAR (pick a hull), then the LOBBY (connect to
// the arena, watch live team rosters), and finally Launch → warp-in. The chosen ship id flows to
// makePlayer/remote hull + the server (via multiplayer.join).
let _selectedShipId = loadShipChoice();

// Build the team-filtered ship cards with a rotating 3D preview + stat bars. `shipIds` is the list
// of hulls this team may fly (blue = hero hulls, red = enemy hulls). Stats show as deviation bars
// from the baseline (center = 1.0): a fill growing RIGHT (green) = advantage, LEFT (red) = weakness.
function buildShipGrid(shipIds) {
  const grid = $('shipGrid');
  if (!grid) return;
  const STAT_ROWS = [['shield', 'SHLD'], ['speed', 'SPD'], ['firepower', 'GUNS'], ['hull', 'HULL']];
  grid.innerHTML = '';
  const previewEntries = [];
  for (const id of shipIds) {
    const ship = SHIPS[id];
    if (!ship) continue;
    const card = document.createElement('div');
    card.className = 'shipCard' + (id === _selectedShipId ? ' sel' : '');
    card.dataset.ship = id;
    card.style.setProperty('--sc-tint', ship.tint);
    let statsHtml = '';
    for (const [key, label] of STAT_ROWS) {
      const v = ship.stats[key] || 1;
      const dev = v - 1;                                   // -0.2 .. +0.25 typically
      const w = Math.min(50, Math.abs(dev) * 100 * 1.6);   // half-bar width %, scaled for readability
      const cls = dev > 0.001 ? 'up' : dev < -0.001 ? 'down' : '';
      const style = dev >= 0
        ? `left:50%; width:${w}%;`
        : `left:${50 - w}%; width:${w}%;`;
      statsHtml += `<span class="scStatLbl">${label}</span>` +
        `<span class="scStatBar"><span class="scStatFill ${cls}" style="${style}"></span></span>`;
    }
    card.innerHTML =
      `<canvas class="scPreview" width="460" height="290"></canvas>` +
      `<div class="scTop"><span class="scName">${ship.name}</span><span class="scRole">${ship.role}</span></div>` +
      `<div class="scPilot">${ship.pilot === 'CAPTURED' ? 'Captured Hull' : 'Pilot · ' + ship.pilot}</div>` +
      `<div class="scBlurb">${ship.blurb}</div>` +
      `<div class="scStats">${statsHtml}</div>`;
    card.addEventListener('click', () => selectShip(id));
    grid.appendChild(card);
    // Wire this card's rotating 3D preview to the ship's GLB (via scene.js's cached loader).
    const canvas = card.querySelector('.scPreview');
    const model = (SHIPS[id] && SHIPS[id].model);
    if (canvas && model) previewEntries.push({ id, url: model, canvas });
  }
  mountShipPreviews(previewEntries);
  startShipPreviews();
  // Fire the engine trail on whichever hull is pre-selected as the screen opens.
  setSelectedPreview(shipIds.includes(_selectedShipId) ? _selectedShipId : null);
}
function selectShip(id) {
  if (!SHIPS[id]) return;
  // Enforce the current team roster (guards against a stale click after a team change).
  if (!_shipSelectPool.includes(id)) return;
  _selectedShipId = id;
  saveShipChoice(id);
  audio.unlock(); audio.play('shield', 0.2);
  audio.playShipEngine(id, 0.6);   // spool up THIS hull's engine as its exhaust trail ignites
  for (const c of $('shipGrid').querySelectorAll('.shipCard')) c.classList.toggle('sel', c.dataset.ship === id);
  setSelectedPreview(id);   // light this hull's engine trail (extinguishes the previously selected one)
}

// ---- Multiplayer ship-select (timed, team-filtered, shown AFTER the host launches) -----------
// When the host starts the match the server broadcasts 'matchStart'; every client then gets a
// SHIP_SELECT_SECS window to pick a hull from their team's roster before dropping into flight. If
// the window elapses without a manual pick, we lock in whatever is currently highlighted (a valid
// team default). The rotating 3D previews render live above each ship name.
const SHIP_SELECT_SECS = 10;
let _shipSelectPool = [];          // ship ids selectable this session (current team roster)
let _shipSelectTimer = null;       // 1Hz countdown interval
let _shipSelectDeadline = 0;       // performance.now() ms when the window closes
let _shipSelectDone = false;       // guard so confirm + timeout can't both fire
// DEV: temporary client-side team override for the ship-select screen. null = use the
// server-assigned team; 0/1 = force blue/red so you can pick+fly an enemy hull and reach
// the K HUD tuner for enemy cockpits. Toggle on the ship-select overlay with the ` (backtick) key.
// NOTE: this only re-skins the local ship-select roster; the server is still authoritative for the
// team you actually spawn on, so use it against a solo/dev server to reach the red cockpits.
let _devForceTeam = null;
// Open the timed picker for the local pilot's team, then start the countdown.
function openMatchShipSelect() {
  const team = _devForceTeam != null ? _devForceTeam : (multiplayer.myTeam || 0);
  _shipSelectPool = shipsForTeam(team);
  // If our saved/previous pick isn't valid for this team, default to the team's first hull.
  if (!_shipSelectPool.includes(_selectedShipId)) _selectedShipId = defaultShipForTeam(team);
  const ss = $('shipSelect');
  ss.classList.remove('teamBlue', 'teamRed');
  ss.classList.add(team === 1 ? 'teamRed' : 'teamBlue');
  $('ssBody').textContent = team === 1
    ? 'Fly the enemy line — pick a captured hull before the launch clock runs out.'
    : 'Choose your hero hull before the launch clock runs out, ace.';
  buildShipGrid(_shipSelectPool);
  // Timer UI + button copy for the timed flow (hide the Back button; this is a forced pick).
  $('ssTimer').hidden = false;
  $('ssBack').style.display = 'none';
  $('ssConfirm').querySelector('.lbl').textContent = 'Launch';
  ss.classList.add('show');
  _shipSelectDone = false;
  _shipSelectDeadline = performance.now() + SHIP_SELECT_SECS * 1000;
  updateShipSelectTimer();
  if (_shipSelectTimer) clearInterval(_shipSelectTimer);
  _shipSelectTimer = setInterval(updateShipSelectTimer, 250);
  audio.play('lock', 0.4);
}
function updateShipSelectTimer() {
  const remain = Math.max(0, Math.ceil((_shipSelectDeadline - performance.now()) / 1000));
  const numEl = $('ssTimerNum');
  if (numEl) numEl.textContent = remain;
  $('ssTimer').classList.toggle('urgent', remain <= 3);
  if (remain <= 0 && !_shipSelectDone) confirmMatchShip(true);
}
// Lock in the selected hull and drop into flight. `auto` = the countdown expired (vs. a click).
function confirmMatchShip(auto = false) {
  if (_shipSelectDone) return;
  _shipSelectDone = true;
  if (_shipSelectTimer) { clearInterval(_shipSelectTimer); _shipSelectTimer = null; }
  stopShipPreviews();
  closeShipSelect();
  audio.unlock(); audio.play('laser', auto ? 0.4 : 0.6);
  // Tell the server our final hull (team-validated there), then enter the arena.
  multiplayer.setShip(_selectedShipId);
  enterFreeFlightFromMenu();
}
function openShipSelect() { openMatchShipSelect(); }   // back-compat alias
// DEV: re-skin the OPEN ship-select overlay to a team's roster without restarting the countdown, so
// you can flip to the red line, pick an enemy hull, launch, and press K in flight to tune the enemy
// cockpit. Backtick (`) cycles the local override null -> red -> blue -> null while the picker is up.
function devCycleShipSelectTeam() {
  const ss = $('shipSelect');
  if (!ss.classList.contains('show')) return;   // only while the picker is visible
  _devForceTeam = _devForceTeam == null ? 1 : (_devForceTeam === 1 ? 0 : null);
  const team = _devForceTeam != null ? _devForceTeam : (multiplayer.myTeam || 0);
  _shipSelectPool = shipsForTeam(team);
  _selectedShipId = defaultShipForTeam(team);   // snap to a valid hull for the new roster
  ss.classList.remove('teamBlue', 'teamRed');
  ss.classList.add(team === 1 ? 'teamRed' : 'teamBlue');
  const forced = _devForceTeam != null ? ` [DEV FORCE ${team === 1 ? 'RED' : 'BLUE'}]` : '';
  $('ssBody').textContent = (team === 1
    ? 'Fly the enemy line — pick a captured hull before the launch clock runs out.'
    : 'Choose your hero hull before the launch clock runs out, ace.') + forced;
  buildShipGrid(_shipSelectPool);
  audio.play('lock', 0.4);
}
window.addEventListener('keydown', e => {
  // Backtick is a dev-only key with no gameplay binding; only acts while the ship-select is showing.
  if (e.code === 'Backquote' && $('shipSelect').classList.contains('show')) {
    e.preventDefault();
    devCycleShipSelectTeam();
  }
});
function closeShipSelect() {
  $('shipSelect').classList.remove('show');
  $('ssTimer').hidden = true;
  $('ssBack').style.display = '';
  stopShipPreviews();
}
$('ssConfirm').addEventListener('click', () => {
  confirmMatchShip(false);
});
$('ssBack').addEventListener('click', () => {
  audio.play('shield', 0.18);
  closeShipSelect();
  openCallsignPrompt();
});

// ---- Ship Hangar -----------------------------------------------------------------------------
// Browse every flyable hull on a live 3D turntable and equip cosmetic loadouts (hull skin, laser
// color, engine trail color, missile FX). Reads the catalog + unlock status from cosmetics.js and
// persists the pilot's equipped selection per ship. Opens from the main menu and the MP lobby; on
// close it returns to whichever it came from. The 3D preview reflects the equipped trail color live.
let _hangarPreview = null;         // lazily-created HangarPreview (one WebGL context, reused)
let _hangarShipIdx = 0;            // index into SHIP_ORDER for the hull currently shown
let _hangarReturn = 'menu';        // where Close returns to: 'menu' | 'lobby'
function ensureHangarPreview() {
  if (_hangarPreview) return _hangarPreview;
  _hangarPreview = new HangarPreview($('shCanvas'));
  return _hangarPreview;
}
// Open the hangar. `from` records the caller so Close can restore it ('menu' default, 'lobby' when
// opened from the multiplayer lobby).
function openShipHangar(from = 'menu') {
  _hangarReturn = from;
  // Start on the pilot's saved ship choice if it's valid, else the first hull.
  const saved = _selectedShipId && SHIP_ORDER.includes(_selectedShipId) ? _selectedShipId : SHIP_ORDER[0];
  _hangarShipIdx = Math.max(0, SHIP_ORDER.indexOf(saved));
  const hp = ensureHangarPreview();
  $('shipHangar').classList.add('show');
  renderHangarShip();
  hp.start();
  audio.play('lock', 0.4);
}
function closeShipHangar() {
  $('shipHangar').classList.remove('show');
  if (_hangarPreview) _hangarPreview.stop();
  audio.play('shield', 0.18);
  // Restore the screen we came from (the menu is already visible behind us; the lobby overlay too).
  // Nothing else to do — both are lower-z overlays that were never hidden.
}
// Paint the current hull: name/role/blurb, the preview model + its equipped cosmetics, the dots, and
// the four cosmetic cyclers.
function renderHangarShip() {
  const id = SHIP_ORDER[_hangarShipIdx];
  const ship = getShip(id);
  $('shShipName').textContent = ship.name.toUpperCase();
  $('shShipRole').textContent = `${ship.role} · ${ship.pilot}`;
  $('shBlurb').textContent = ship.blurb || '';
  // Preview: swap the hull + apply this ship's equipped trail/laser cosmetics so the plume/swatch match.
  const cos = cosmetics.resolved(id);
  const hp = ensureHangarPreview();
  hp.setShip(id);   // HangarPreview resolves the GLB via getShip(id) internally
  hp.setTrailPalette(cos.trailPalette);
  hp.setLaserColor(cos.laserColor);
  // Dots (ship position indicator).
  const dots = $('shDots');
  dots.innerHTML = '';
  SHIP_ORDER.forEach((sid, i) => {
    const d = document.createElement('span');
    d.className = 'shDot' + (i === _hangarShipIdx ? ' active' : '');
    d.addEventListener('click', () => { _hangarShipIdx = i; renderHangarShip(); audio.play('lock', 0.3); });
    dots.appendChild(d);
  });
  renderHangarCosmeticsViewed(id);
}
// Advance a cosmetic category by ±1 (wrapping). Equips the landed option if it's unlocked (locked
// options can still be VIEWED as you cycle past, but equipping them is a no-op that keeps the hint).
let _hangarCosState = {};   // shipId -> { catKey -> currently-VIEWED option index } (for browsing locked)
function cycleCosmetic(shipId, catKey, dir) {
  const opts = cosmetics.catalogView(catKey, shipId);
  if (!opts.length) return;
  const loadout = cosmetics.loadoutFor(shipId);
  // Base the cycle on the currently VIEWED index (persists browsing locked options), else equipped.
  const key = shipId + ':' + catKey;
  let cur = _hangarCosState[key];
  if (cur == null) cur = Math.max(0, opts.findIndex(o => o.id === loadout[catKey]));
  let next = (cur + dir + opts.length) % opts.length;
  _hangarCosState[key] = next;
  const opt = opts[next];
  if (opt && opt.unlocked) {
    cosmetics.equip(shipId, catKey, opt.id);
    // Update the live preview to reflect a newly-equipped trail/laser color.
    const cos = cosmetics.resolved(shipId);
    const hp = ensureHangarPreview();
    hp.setTrailPalette(cos.trailPalette);
    hp.setLaserColor(cos.laserColor);
    audio.play('shield', 0.2);
  } else {
    audio.play('lock', 0.25);   // locked: a softer "denied" cue
  }
  // Repaint just this row by re-rendering the whole cosmetic column (cheap; a handful of rows).
  renderHangarCosmeticsViewed(shipId);
}
// Re-render the cosmetic column honoring the currently-VIEWED (browsed) option per category, so a
// pilot can scroll onto a locked option and see its unlock hint without it snapping back.
function renderHangarCosmeticsViewed(shipId) {
  const wrap = $('shCustomize');
  wrap.innerHTML = '';
  const loadout = cosmetics.loadoutFor(shipId);
  for (const cat of cosmetics.CATEGORIES) {
    const opts = cosmetics.catalogView(cat.key, shipId);
    const key = shipId + ':' + cat.key;
    let idx = _hangarCosState[key];
    if (idx == null) idx = Math.max(0, opts.findIndex(o => o.id === loadout[cat.key]));
    const opt = opts[idx] || opts[0];
    const count = cosmetics.unlockedCount(cat.key, shipId);
    const row = document.createElement('div');
    row.className = 'cosRow' + (opt && !opt.unlocked ? ' locked' : '');
    const swColor = colorHexCss(cat.key, opt);
    const swClass = swColor ? '' : ' none';
    const swStyle = swColor ? ` style="--sw:${swColor}"` : '';
    const equipTag = (opt && opt.unlocked && opt.id === loadout[cat.key]) ? '<span class="cosEquipped">EQUIPPED</span>' : '';
    row.innerHTML =
      `<div class="cosHead"><span class="cosLabel">${cat.label}</span>` +
      `<span class="cosCount">${count.got}/${count.total}</span></div>` +
      `<div class="cosCycler">` +
        `<button class="cosArrow" data-dir="-1">‹</button>` +
        `<div class="cosOpt"><span class="cosSwatch${swClass}"${swStyle}></span>` +
        `<span class="cosName">${escHtmlLocal(opt ? opt.name : '—')}</span>${equipTag}</div>` +
        `<button class="cosArrow" data-dir="1">›</button>` +
      `</div>` +
      `<p class="cosLock">${opt && !opt.unlocked ? escHtmlLocal(opt.lockLabel || 'Locked') : ''}</p>`;
    row.querySelectorAll('.cosArrow').forEach(btn => {
      btn.addEventListener('click', () => cycleCosmetic(shipId, cat.key, Number(btn.dataset.dir)));
    });
    wrap.appendChild(row);
  }
}
// The CSS swatch color for an option, or '' for skins (no color → hatched placeholder swatch).
function colorHexCss(catKey, opt) {
  if (!opt) return '';
  let hex = null;
  if (catKey === 'laser') hex = opt.color;
  else if (catKey === 'trail') hex = opt.swatch;
  else if (catKey === 'missile') hex = opt.accent;
  else return '';   // skins: no color swatch
  return hex != null ? '#' + hex.toString(16).padStart(6, '0') : '';
}
function escHtmlLocal(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Ship-cycle arrows + dots.
function hangarCycleShip(dir) {
  _hangarShipIdx = (_hangarShipIdx + dir + SHIP_ORDER.length) % SHIP_ORDER.length;
  // Clear the per-ship viewed-cosmetic browsing state so the new ship shows its equipped loadout.
  _hangarCosState = {};
  renderHangarShip();
  audio.play('lock', 0.35);
}
$('shPrev').addEventListener('click', () => hangarCycleShip(-1));
$('shNext').addEventListener('click', () => hangarCycleShip(1));
$('shClose').addEventListener('click', closeShipHangar);
$('menuHangarBtn').addEventListener('click', () => {
  if (!$('mainMenu').classList.contains('show')) return;
  audio.unlock();
  openShipHangar('menu');
});
function onShipHangarKey(e) {
  if (!$('shipHangar').classList.contains('show')) return;
  if (e.code === 'Escape') { e.preventDefault(); closeShipHangar(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); hangarCycleShip(-1); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); hangarCycleShip(1); }
}
document.addEventListener('keydown', onShipHangarKey, true);

// ---- Multiplayer lobby -----------------------------------------------------------------------
// Connects to the arena immediately so live team rosters populate, then Launch drops into flight.
// If no server is reachable, it flips to SOLO and Launch still works (single-player free flight).
let _lobbyPollT = null;
function openLobby() {
  const ship = getShip(_selectedShipId);
  $('lobShip').textContent = ship.name.toUpperCase();
  const lob = $('mpLobby');
  lob.classList.remove('ready', 'solo');
  $('lobStatusText').textContent = 'CONNECTING TO ARENA…';
  $('lobBlue').innerHTML = ''; $('lobRed').innerHTML = '';
  lob.classList.add('show');
  // Join the room now (safe: server spawns us at the team anchor; we warp in on Launch). Rosters
  // refresh from live state each poll. join() never throws — solo fallback flips the badge to SOLO.
  renderLobbyConfig();   // paint the (default) mode/timer selection immediately
  multiplayer.join({
    callSign: leaderboard.getPilotName() || 'MAMBA',
    shipId: _selectedShipId,
    endpoint: MP_ENDPOINT,
    ...myRankJoinArgs(),
    onCount: () => renderLobbyRosters(),
    onKill: freeFlightKillFeed,
    onHit: freeFlightHitReport,         // hit marker (shooter) / damage flash (victim)
    onMatchStart: onServerMatchStart,   // host started the round -> everyone drops into flight
    onMatchEnd: onServerMatchEnd,       // round clock hit 0 -> winner banner + scoreboard
  }).then(() => {
    updateLobbyStatus();
    renderLobbyRosters();
    renderLobbyConfig();
    // Bring up live voice audio for this arena connection (presence-only if unconfigured/denied).
    connectVoiceAudio();
  });
  // Poll the roster a few times/sec while the lobby is open (state patches arrive asynchronously).
  if (_lobbyPollT) clearInterval(_lobbyPollT);
  _lobbyPollT = setInterval(() => { updateLobbyStatus(); renderLobbyRosters(); renderLobbyConfig(); }, 400);
}
// Paint the lobby's game-mode + round-timer selection from the server-authoritative match state,
// and toggle host vs. non-host interactivity. The HOST may change settings + launch; everyone else
// sees the host's current picks locked, with a "waiting for host" note.
function renderLobbyConfig() {
  const lob = $('mpLobby');
  const info = multiplayer.matchInfo();
  const host = multiplayer.isHost();
  lob.classList.toggle('notHost', !host);
  // Round-timer chips: highlight the one matching the configured duration.
  const secs = Math.round(info.roundDuration || 600);
  for (const chip of $('lobTimers').querySelectorAll('.lobChip')) {
    chip.classList.toggle('active', Number(chip.dataset.secs) === secs);
  }
  // Mode chips (only SDM for now) — mark the active mode.
  for (const chip of $('lobModes').querySelectorAll('.lobChip')) {
    chip.classList.toggle('active', chip.dataset.mode === (info.mode || 'sdm'));
  }
  const note = $('lobHostNote');
  if (note) {
    const mins = Math.round(secs / 60);
    note.textContent = host
      ? 'You are the host · pick the mode and round length, then launch'
      : `Waiting for host · ${mins} min round`;
  }
  renderLobbyReady();
}
// Paint the lobby ready-check state: my own "Ready Up" button, the all-ready launch gate, and the
// contextual note. Online, the host can only launch once EVERY pilot has checked in ready; solo
// (no server) always allows launch. Called every poll so it tracks other pilots checking in.
function renderLobbyReady() {
  const lob = $('mpLobby');
  const online = multiplayer.connected;
  const host = multiplayer.isHost();
  const iAmReady = online ? !!multiplayer.myReady : true;
  const allReady = online ? multiplayer.allReady() : true;
  lob.classList.toggle('iAmReady', iAmReady);
  lob.classList.toggle('allReady', allReady);
  // My ready-up toggle (only meaningful online; solo has no ready handshake).
  const btn = $('lobReady');
  if (btn) {
    btn.style.display = online ? '' : 'none';
    const lbl = btn.querySelector('.lbl');
    if (lbl) lbl.textContent = iAmReady ? 'READY \u2713' : 'READY UP';
    btn.classList.toggle('on', iAmReady);
  }
  const rnote = $('lobReadyNote');
  if (rnote) {
    if (!online) {
      rnote.textContent = 'Solo flight · launch any time';
    } else if (allReady) {
      rnote.textContent = host ? 'All pilots ready · cleared to launch' : 'All pilots ready · waiting for host to launch';
    } else if (!iAmReady) {
      rnote.textContent = 'Check in with READY UP when you\u2019re set';
    } else {
      rnote.textContent = 'Waiting for the rest of the squadron to ready up';
    }
  }
}
function closeLobby() {
  $('mpLobby').classList.remove('show');
  const lc = $('lobLeaveConfirm'); if (lc) lc.classList.remove('show');   // never leave the confirm lingering
  if (_lobbyPollT) { clearInterval(_lobbyPollT); _lobbyPollT = null; }
}
function updateLobbyStatus() {
  const lob = $('mpLobby');
  if (multiplayer.connected) {
    lob.classList.add('ready'); lob.classList.remove('solo');
    const n = multiplayer.peerCount() + 1;
    $('lobStatusText').textContent = `ARENA ONLINE · ${n} PILOT${n === 1 ? '' : 'S'}`;
  } else {
    lob.classList.add('solo'); lob.classList.remove('ready');
    $('lobStatusText').textContent = 'NO SERVER · SOLO FLIGHT';
  }
}
// Paint the BLUE/RED rosters from the live server ship map (our own ship + all remotes).
// Inline mic glyph for the lobby roster. `denied` draws the classic mic-with-slash; otherwise a
// plain mic that gets colored/glowed via the .speaking / idle CSS on the parent <li>.
function MIC_ICON_SVG(denied) {
  const mic = '<path fill="currentColor" d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/>'
    + '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6"/>';
  const slash = denied ? '<path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 4l16 16"/>' : '';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${mic}${slash}</svg>`;
}
// Build the ranking/honor args to report on a multiplayer join. Reads the local pilot's persisted
// career metrics for the advancement score, and grants (then reports) the pre-launch Pioneer honor
// — playing multiplayer during the pre-launch window is what earns it, so we grant it right here.
function myRankJoinArgs() {
  if (ranks.pioneerWindowOpen()) leaderboard.grantPioneer();   // playing MP pre-launch earns Pioneer
  return {
    rankScore: ranks.rankScore(leaderboard.careerRankStats()),
    pioneer: leaderboard.isPioneer(),
  };
}
// Rank badge HTML for a roster/scoreboard row that carries { rankScore, pioneer }. `compact` shows
// just the insignia pip (tight rows); otherwise the tier name is included.
function rowRankBadge(r, compact = true) {
  const rank = ranks.rankForScore(r ? r.rankScore : 0);
  return ranks.rankBadgeHtml(rank, { pioneer: !!(r && r.pioneer), compact });
}
function renderLobbyRosters() {
  const blue = $('lobBlue'), red = $('lobRed');
  if (!blue || !red) return;
  blue.innerHTML = ''; red.innerHTML = '';
  // Read EVERY row (self + remotes) from the authoritative server roster. Crucially, the local
  // pilot's name comes from the name we actually JOINED the server with (multiplayer.callSign), NOT
  // from localStorage via getPilotName() — two tabs on the same origin share localStorage, so
  // getPilotName() returns the same value in both and made the host label the other pilot with its
  // own call sign. liveRoster() sources self from callSign and remotes from server-synced state, so
  // each pilot is named correctly on every screen. Ships are picked at launch, so no ship name here.
  const rows = multiplayer.connected
    ? multiplayer.liveRoster().map(r => ({ name: r.name, team: r.team, me: r.me, speaking: r.speaking, micState: r.micState, rankScore: r.rankScore, pioneer: r.pioneer, ready: r.ready }))
    : [{ name: leaderboard.getPilotName() || 'MAMBA', team: multiplayer.myTeam || 0, me: true, speaking: false, micState: 0,
        rankScore: ranks.rankScore(leaderboard.careerRankStats()), pioneer: leaderboard.isPioneer(), ready: false }];
  for (const r of rows) {
    const li = document.createElement('li');
    if (r.me) li.classList.add('me');
    const denied = !r.micState;                  // 0 = no working mic (denied / unavailable)
    if (denied) li.classList.add('noMic');
    else if (r.speaking) li.classList.add('speaking');
    // Rank badge (insignia pip) before the name; the name is tinted by rank / Pioneer honor.
    const badge = document.createElement('span');
    badge.className = 'liRank';
    badge.innerHTML = rowRankBadge(r, true);
    const name = document.createElement('span');
    name.className = 'liName';
    name.textContent = r.name;
    name.style.color = ranks.nameColor(ranks.rankForScore(r.rankScore), r.pioneer);
    li.appendChild(badge);
    const mic = document.createElement('span');
    mic.className = 'liMic';
    mic.title = denied ? 'No microphone' : (r.speaking ? 'Speaking' : 'Microphone ready');
    mic.innerHTML = MIC_ICON_SVG(denied);
    li.appendChild(name);
    li.appendChild(mic);
    // Ready-check pip: grey when a pilot hasn't checked in, green once they're ready to launch.
    // The green state is driven by the `.ready` class on the <li> (see #mpLobby .lobRoster CSS).
    if (r.ready) li.classList.add('ready');
    const ready = document.createElement('span');
    ready.className = 'liReady';
    ready.title = r.ready ? 'Ready' : 'Not ready';
    li.appendChild(ready);
    (r.team === 1 ? red : blue).appendChild(li);
  }
  if (!blue.children.length) blue.innerHTML = '<li style="opacity:.4">—</li>';
  if (!red.children.length) red.innerHTML = '<li style="opacity:.4">—</li>';
}
// Host-only: pick a game mode (only SDM for now). Sends the config to the server, which echoes it
// back to every client via state so all lobbies stay in sync.
$('lobModes').addEventListener('click', (e) => {
  const chip = e.target.closest('.lobChip');
  if (!chip || !multiplayer.isHost()) return;
  audio.play('lock', 0.3);
  multiplayer.setConfig({ mode: chip.dataset.mode });
  renderLobbyConfig();   // optimistic; server state confirms on the next patch
});
// Host-only: pick the SDM round length (5/10/15/20 min).
$('lobTimers').addEventListener('click', (e) => {
  const chip = e.target.closest('.lobChip');
  if (!chip || !multiplayer.isHost()) return;
  audio.play('lock', 0.3);
  const secs = Number(chip.dataset.secs);
  multiplayer.setConfig({ mode: 'sdm', roundDuration: secs });
  renderLobbyConfig();
});
// Launch: only the HOST starts the round. Online, we ask the server to start; the server broadcasts
// 'matchStart' and EVERY client (host + others) drops into flight together via onServerMatchStart.
// Offline/solo (no server), there's no host handshake — enter flight directly.
$('lobLaunch').addEventListener('click', () => {
  if (!multiplayer.isHost()) return;   // non-hosts wait for the host to launch
  // Online launch gate: the host can only start once EVERY pilot has checked in ready. Nudge with
  // a denied blip + note if someone's still not ready. Solo (offline) bypasses the handshake.
  if (multiplayer.connected && !multiplayer.allReady()) {
    audio.play('shield', 0.18);
    const rnote = $('lobReadyNote');
    if (rnote) rnote.textContent = 'Cannot launch — all pilots must ready up first';
    return;
  }
  audio.unlock(); audio.play('laser', 0.7);
  if (multiplayer.connected) {
    multiplayer.startMatch();   // server -> broadcast 'matchStart' -> onServerMatchStart for all
  } else {
    // Solo fallback: no arena server. Still run the timed ship-select before flying in.
    closeLobby();
    openMatchShipSelect();
  }
});
// Fired for EVERY client (host + non-hosts) when the server starts the round. Close the lobby and
// open the timed, team-filtered ship-select; the confirm/timeout drops us into flight on the same
// round clock as the rest of the squadron.
function onServerMatchStart() {
  if (freeFlightMode) return;   // already flying (shouldn't happen, but guard against double-entry)
  closeLobby();
  openMatchShipSelect();
}
// Leaving the arena is a destructive step (disconnects from the squadron), so confirm first.
function openLeaveConfirm() { const el = $('lobLeaveConfirm'); if (el) el.classList.add('show'); }
function closeLeaveConfirm() { const el = $('lobLeaveConfirm'); if (el) el.classList.remove('show'); }
$('lobLeave').addEventListener('click', () => {
  audio.play('shield', 0.18);
  openLeaveConfirm();
});
// Cancel: dismiss the prompt and stay in the lobby.
$('lcCancel').addEventListener('click', () => {
  audio.play('shield', 0.18);
  closeLeaveConfirm();
});
// Confirm: actually disconnect and step back to the call-sign prompt.
$('lcConfirm').addEventListener('click', () => {
  audio.play('shield', 0.18);
  closeLeaveConfirm();
  try { multiplayer.leave(); } catch {}
  closeLobby();
  openCallsignPrompt();   // back a step to the call-sign prompt (ship choice now happens post-launch)
});
// Esc dismisses the confirm (keeps you in the lobby) when it's open.
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && $('lobLeaveConfirm') && $('lobLeaveConfirm').classList.contains('show')) {
    e.preventDefault();
    closeLeaveConfirm();
  }
});
// Ready-up toggle: flip our readiness on the server (optimistically mirrored), then repaint the
// lobby so the button + note + our roster pip update instantly.
const _lobReadyBtn = $('lobReady');
if (_lobReadyBtn) _lobReadyBtn.addEventListener('click', () => {
  if (!multiplayer.connected) return;   // solo has no ready handshake
  const on = multiplayer.toggleReady();
  audio.play(on ? 'lock' : 'shield', on ? 0.32 : 0.18);
  renderLobbyReady();
  renderLobbyRosters();
});
// Open the Ship Hangar from the lobby (customization / cosmetics), returning here on close.
const _lobHangarBtn = $('lobHangar');
if (_lobHangarBtn) _lobHangarBtn.addEventListener('click', () => {
  audio.play('lock', 0.3);
  openShipHangar('lobby');
});

// Swap the cockpit canopy background to the chosen ship's frame (inline style overrides the CSS
// default). Every playable ship maps to one of the existing three-bezel cockpit frames so the HUD
// dash panels still seat correctly; the Lightning keeps the established slim frame.
function applyCockpitForShip(shipId) {
  const el = document.querySelector('.cockpit');
  if (!el) return;
  const ship = getShip(shipId);
  el.style.backgroundImage = `url('${ship.cockpit}')`;
  // Tag <body> with a short key derived from the cockpit art filename so the HUD dash panels can be
  // positioned PER cockpit frame in CSS (body[data-cockpit="..."] .sys { ... }). Each generated
  // cockpit image has its screens in slightly different spots, so the K tuner tunes/saves one layout
  // block per frame; this attribute selects which block applies. See index.html "PER-COCKPIT" rules.
  document.body.dataset.cockpit = cockpitKey(ship.cockpit);
  // Re-apply any tuner layout saved for THIS cockpit frame (localStorage), so per-ship HUD tweaks
  // persist across launches and switching ships restores the right frame's layout.
  hudTuner.syncCockpit();
}
// Reduce a cockpit art path (e.g. 'assets/cockpit-holo-clear-b.webp') to a stable short layout key
// ('b'). Falls back to a filename-safe slug so any future cockpit still gets its own tunable block.
function cockpitKey(url) {
  if (!url) return 'a';
  const file = url.split('/').pop().replace(/\.\w+$/, '');   // 'cockpit-holo-clear-b'
  const m = file.match(/^cockpit-holo-clear-([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();                          // 'a' | 'b' | 'f'
  return file.replace(/^cockpit-/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();  // 'enemy-interceptor' -> 'enemy-interceptor'
}
// Reset the player back to the campaign default: Lightning hull + its cockpit. Called when launching
// a campaign mission so a prior Free Flight ship choice doesn't carry over into the story.
function resetToDefaultHull() {
  // The campaign always flies the Lightning, but honor the pilot's equipped engine-trail cosmetic
  // for that hull so their Ship-Hangar customization carries into the story too.
  const cos = cosmetics.resolved('lightning');
  _playerCosmetics = cos;
  swapPlayerHull(player, 'lightning', (cos && cos.trailPalette) || 'blue');
  applyCockpitForShip('lightning');
}

function enterFreeFlightFromMenu() {
  const menu = $('mainMenu');
  if (menu.dataset.busy) return;
  menu.dataset.busy = '1';
  audio.unlock();
  audio.play('laser', 0.7);
  audio.fade(audio.score, 0, 600, true);
  menu.classList.remove('in');
  setTimeout(() => {
    menu.classList.remove('show');
    menu.removeAttribute('data-busy');
    $('missionJump').classList.remove('show');
    ui.classList.remove('cinematic');
    audio.startMusic(0.24);
    lockPointer();
    launchFreeFlight();
  }, 620);
}
function launchFreeFlight() {
  if (_launchInFlight) return;
  _launchInFlight = true;
  const overlay = $('missionLoad'), fill = $('mlFill'), pct = $('mlPct');
  $('mlTitle').textContent = 'SQUADRON DEATH MATCH';
  $('mlSub').textContent = 'Open arena · Hammer Squadron net';
  fill.style.width = '0%'; pct.textContent = 'CALIBRATING 0%';
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.classList.add('in'));
  let mProg = 0, aProg = 0, shown = 0;
  const render = () => {
    const target = Math.min(100, Math.round((mProg * 0.6 + aProg * 0.4) * 100));
    shown = Math.max(shown, target);
    fill.style.width = shown + '%';
    pct.textContent = (shown < 100 ? 'CALIBRATING ' : 'JUMP READY ') + shown + '%';
  };
  const ready = Promise.all([
    preloadModels(p => { mProg = p; render(); }),
    preloadAudio(['assets/audio/combat-space-loop.mp3', 'assets/audio/hyperspace-warp-in.mp3',
      'assets/audio/hyperspace-hum-loop.mp3', 'assets/audio/warp-dropout.mp3',
      // SCAAVI / Crimson SCAAVI combat barks so the alert plays instantly the first time it fires.
      'assets/audio/voice/scaavi/scaavishieldsfailing.mp3',
      'assets/audio/voice/scaavi/scaavihull.mp3',
      'assets/audio/voice/scaavi/scaaviyayshields.mp3',
      'assets/audio/voice/crimsonscaavi/crimsonshieldsfail.mp3',
      'assets/audio/voice/crimsonscaavi/crimsonhulldmg.mp3',
      'assets/audio/voice/crimsonscaavi/shieldsrecharged.mp3'], p => { aProg = p; render(); })
  ]);
  const minHold = new Promise(res => setTimeout(res, 1000));
  Promise.all([ready, minHold]).then(() => {
    mProg = 1; aProg = 1; render();
    setTimeout(() => {
      overlay.classList.remove('in');
      setTimeout(() => { overlay.classList.remove('show'); beginFreeFlight(); }, 480);
    }, 240);
  });
}
function beginFreeFlight() {
  _launchInFlight = false;
  freeFlightMode = true;
  // Offline/solo: there's no server clock, so run our own round timer from the lobby's chosen Round
  // Timer. Online, the authoritative server clock (info.timeLeft) governs and this stays disarmed.
  _soloRoundEnd = multiplayer.connected ? 0 : performance.now() + multiplayer.roundDuration() * 1000;
  // Rebuild the player hull to the ship chosen in the hangar, and swap the cockpit canopy to match.
  // swapPlayerHull streams the GLB in asynchronously (dropping a placeholder in the meantime); the
  // models were warmed on the loading screen so this normally resolves instantly, but we still
  // GATE the warp-in on it below so the correct hull — not the placeholder — is what streaks in.
  // Resolve the equipped Ship-Hangar cosmetics for this hull, then build with the chosen engine-trail
  // palette (falls back to the ship's faction palette if the pilot never customized it).
  refreshPlayerCosmetics();
  const _trailPal = (_playerCosmetics && _playerCosmetics.trailPalette) || paletteForShip(_selectedShipId);
  const _hullReady = swapPlayerHull(player, _selectedShipId, _trailPal);
  applyCockpitForShip(_selectedShipId);
  // Clear the playfield: no hostiles, allies, or projectiles in the arena.
  clearShipGroup(enemies); clearShipGroup(allies); boltGroup.clear(); missileGroup.clear(); explosions.clear();
  // A bare "free flight" mission object so the gameplay loop runs; updateMission short-circuits on
  // the `freeflight` flag exactly like the tutorial's `tutorial` flag.
  mission = { type: 'SQUADRON DEATH MATCH', title: 'Rack up kills for your team before the clock runs out', freeflight: true, timer: 0 };
  capture = 0; waveClear = false; _lockedEnemy = null;
  lockProgress = 0; missileLocked = false; audio.stopLockTone();
  defendTarget = null; protectOG = null;
  recentPlayerDamage = 0; wingmenCovering = false;
  state.missiles = state.maxMissiles; state.chaff = state.maxChaff;
  state.shields = state.maxShields; state.heat = 0; state.energy = 100;
  resetScaaviAlerts();   // clean SCAAVI/Crimson SCAAVI bark state for the new match/life
  awaitingHyperspace = false; $('hyperPrompt').classList.remove('show');
  beginMissionResults();
  $('missionTitle').textContent = mission.type;
  $('missionText').textContent = mission.title;
  // Warp into an empty arena volume, same rails as a mission/tutorial start.
  const warpExitSpeed = 30;
  const warpCruiseDur = warpIn._defaultCruiseDur;
  const startBack = warpIn.totalDistance(warpExitSpeed, warpCruiseDur);
  player.position.set(0, 0, startBack); player.rotation.set(0, 0, 0); player.userData.vel.set(0, 0, -28);
  if (player.userData.engines) for (const eng of player.userData.engines) eng.trail.userData.history.length = 0;
  _warpExitSpeed = warpExitSpeed;
  _warpCruiseDur = warpCruiseDur;
  grabFocus();
  lockPointer();
  renderer.setAnimationLoop(loop);
  // Hold the warp-in until the chosen hull's model is actually in place, so the warp-in chase shot
  // streaks in the CORRECT ship rather than the momentary placeholder. A short safety race guards
  // against a stalled/failed load ever blocking the launch — worst case we warp in on the
  // placeholder for a beat and the real model pops in a frame later (its own catch handler runs).
  const _warpWhenReady = () => { if (freeFlightMode && !warpingIn) startWarpIn(); };
  const _safety = new Promise(res => setTimeout(res, 2500));
  Promise.race([Promise.resolve(_hullReady), _safety]).then(_warpWhenReady);
}
// Kill-feed handler shared by the lobby and in-flight join: HUD flash + explosion SFX, highlighting
// the local pilot's own kills/deaths.
// Running tally of the local pilot's kills this life, used ONLY to cue the missile-resupply flash on
// every 3rd kill. The ACTUAL ammo grant is authoritative on the server (killShip -> killStreak); this
// is purely cosmetic feedback and resets on death to mirror the server's per-life streak.
let _mpKillStreak = 0;
function freeFlightKillFeed(k) {
  if (!k) return;
  const killer = k.killerName || 'SOMEONE';
  const victim = k.victimName || 'PILOT';
  if (k.killer === multiplayer.mySessionId) {
    flash(`✚ SPLASH! You destroyed ${victim}`); audio.play('explosion', 0.4);
    // Ranking: a confirmed multiplayer kill advances the lifetime career total (primary rank metric).
    leaderboard.addCareerKills(1);
    // Every 3rd kill the server tops the rack up by one (capped at the hull's max). Announce it here;
    // the replicated myMissiles count reflects the real grant a patch later.
    _mpKillStreak++;
    if (_mpKillStreak % 3 === 0 && (multiplayer.myMissiles || 0) < (multiplayer.myMaxMissiles || 0)) {
      flash('✚ MISSILE RESUPPLY · +1'); audio.play('shield', 0.4);
    }
  }
  else if (k.victim === multiplayer.mySessionId) {
    flash(`✖ You were destroyed by ${killer}`); audio.play('explosion', 0.5);
    _mpKillStreak = 0;   // streak resets on death (mirrors server)
  }
  else flash(`${killer} destroyed ${victim}`);
  pushKillFeed(k);
}
// Server 'hit' event: give BOTH parties feedback the instant a bolt/missile lands.
//  • If WE fired the shot (attacker === us): flash a centered HIT MARKER + a crisp confirm tick, so
//    landing fire feels responsive even at range. Suppressed on a lethal hit (the kill feed + SPLASH
//    cue already cover it).
//  • If WE got hit (victim === us): flash the cockpit damage vignette + shield ripple and a short
//    "TAKING FIRE" nudge so incoming fire always reads, even from an attacker off-screen.
let _hitMarkerT = null;
function freeFlightHitReport(h) {
  if (!h) return;
  const me = multiplayer.mySessionId;
  if (h.attacker === me && h.victim !== me) {
    if (!h.lethal) {
      showHitMarker(!!h.missile);
      audio.play('shield', h.missile ? 0.35 : 0.14);
    }
  } else if (h.victim === me) {
    // Local damage feedback: the server owns our hull/shields, but we still flash the UI so the pilot
    // feels the hit. A shield hit ripples the dome + cockpit edge; a hull hit punches a harder flash.
    const hitPos = (typeof h.x === 'number') ? new THREE.Vector3(h.x, h.y, h.z) : null;
    if (h.shield) {
      flashPlayerShield(player, 0.9, hitPos);   // dome ripple (third-person)
      triggerShieldVignette(0.8);               // cockpit edge-flash (first-person)
      audio.play('shield', 0.3);
      flash(h.missile ? '⚠ MISSILE IMPACT' : 'SHIELD IMPACT');
    } else {
      triggerShieldVignette(1);
      audio.play('explosion', 0.3);
      flash(h.missile ? '⚠ MISSILE IMPACT · HULL' : '⚠ TAKING FIRE');
    }
  }
}
// Briefly show the centered hit marker (a crisp ✕ that pops + fades). `heavy` = a missile hit, drawn
// bigger/hotter. Purely cosmetic shooter feedback; the server already applied the damage.
function showHitMarker(heavy = false) {
  const el = $('hitMarker');
  if (!el) return;
  el.classList.toggle('heavy', !!heavy);
  el.classList.remove('show');
  // Force a reflow so re-adding the class restarts the CSS animation even on rapid consecutive hits.
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(_hitMarkerT);
  _hitMarkerT = setTimeout(() => el.classList.remove('show'), 260);
}
// Persistent scrolling kill feed (top-right). Newest row on top; names are team-tinted (blue/red),
// self-involved kills get a highlighted border, and rows auto-fade after a few seconds. Rows cap at
// 6 to keep the corner readable. A blank killer (self-destruct / environment) reads "eliminated".
const KILL_FEED_MAX = 6;
const KILL_FEED_TTL = 6500;   // ms a row stays before fading out
function teamClass(t) { return t === 0 ? 'blue' : t === 1 ? 'red' : 'none'; }
function pushKillFeed(k) {
  const feed = $('killFeed'); if (!feed) return;
  feed.hidden = false;
  const mine = k.killer && k.killer === multiplayer.mySessionId;
  const victimMe = k.victim === multiplayer.mySessionId;
  const killerName = mine ? 'YOU' : (k.killerName || '');
  const victimName = victimMe ? 'YOU' : (k.victimName || 'PILOT');
  const killerTeam = (mine && typeof multiplayer.myTeam === 'number') ? multiplayer.myTeam : k.killerTeam;

  const row = document.createElement('div');
  row.className = 'kfRow' + (mine ? ' mine' : '') + (victimMe ? ' victimMe' : '');
  if (killerName) {
    row.innerHTML =
      `<span class="kfName ${teamClass(killerTeam)}">${escHtml(killerName)}</span>` +
      `<span class="kfIcon">»</span>` +
      `<span class="kfName ${teamClass(k.victimTeam)}">${escHtml(victimName)}</span>`;
  } else {
    // No killer credited (self-destruct / out-of-bounds) — show the victim eliminated.
    row.innerHTML =
      `<span class="kfIcon">✖</span>` +
      `<span class="kfName ${teamClass(k.victimTeam)}">${escHtml(victimName)}</span>` +
      `<span class="kfName none" style="font-weight:600">eliminated</span>`;
  }
  feed.insertBefore(row, feed.firstChild);
  while (feed.children.length > KILL_FEED_MAX) feed.removeChild(feed.lastChild);
  setTimeout(() => {
    row.classList.add('fade');
    setTimeout(() => { if (row.parentNode === feed) feed.removeChild(row); if (!feed.children.length) feed.hidden = true; }, 420);
  }, KILL_FEED_TTL);
}
// Small HTML-escape so pilot call signs can't inject markup into the feed rows.
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Clear + hide the kill feed (exit to menu / match teardown).
function clearKillFeed() { const feed = $('killFeed'); if (feed) { feed.innerHTML = ''; feed.hidden = true; } }
// Called from startWarpIn's onDone once the player settles into the arena. The LOBBY already joined
// the realtime room, so here we just re-point the network callbacks at the in-flight HUD (badge +
// pilot count) instead of the lobby roster. If the lobby somehow didn't connect (e.g. joined then
// left), join() here as a fallback — it's a no-op-safe reconnect.
// Match-over tracking for Free Flight: once at least one OTHER pilot has shared the arena with us,
// the match is "live". If everyone then leaves (peer count falls back to zero) — or the server
// connection drops — the match is over: we announce it and return to the main menu instead of
// leaving the player flying alone in a dead arena. Armed only after real peers were present so a
// solo session (nobody ever joined) simply keeps flying as single-player free flight.
let _ffMatchLive = false;
let _ffMatchEnding = false;
// Solo/offline round clock: performance.now() timestamp when the chosen round ends. 0 when there's
// no solo round running (online rounds are governed by the server clock instead). Set on launch
// from the lobby's chosen Round Timer so the offline "Squadron Death Match" actually honors it.
let _soloRoundEnd = 0;
function endFreeFlightMatch(reason) {
  if (_ffMatchEnding || !freeFlightMode) return;
  _ffMatchEnding = true;
  flash(reason || 'MATCH OVER');
  audio.play('shield', 0.3);
  // Give the flash a beat to read, then present the per-pilot match-results scoreboard. The
  // Confirm button (mrConfirm) runs the shared exit-to-menu path (which drops the room + ghosts).
  setTimeout(() => { if (_ffMatchEnding) showMatchResults(reason); }, 1400);
}
// Server round clock reached 0: the authoritative match ended. Show the winning-team banner, then
// hand off to the standard match-results scoreboard. `msg` carries { winningTeam, blueKills, redKills }.
function onServerMatchEnd(msg) {
  if (!freeFlightMode || _ffMatchEnding) return;
  const m = msg || {};
  const winner = typeof m.winningTeam === 'number' ? m.winningTeam : -1;
  const b = m.blueKills || 0, r = m.redKills || 0;
  // Ranking: credit a career win if OUR team took the round (a modest secondary advancement metric).
  if (winner !== -1 && winner === (multiplayer.myTeam || 0)) leaderboard.addCareerWin();
  hideMatchBar();
  showWinBanner(winner, b, r);
  const reason = winner === -1
    ? `TIME! DRAW · ${b} — ${r}`
    : `TIME! ${winner === 0 ? 'BLUE' : 'RED'} TEAM WINS · ${b} — ${r}`;
  // The banner reads for ~2.6s, then fold into the shared match-results scoreboard.
  _ffMatchEnding = true;
  flash(reason);
  audio.play('shield', 0.35);
  setTimeout(() => { hideWinBanner(); showMatchResults(reason); }, 2600);
}
// Winner banner (round end). team: 0=blue, 1=red, -1=draw.
function showWinBanner(team, blueKills, redKills) {
  const el = $('winBanner'); if (!el) return;
  const teamEl = $('wbTeam'), scoreEl = $('wbScore');
  teamEl.classList.remove('blue', 'red', 'draw');
  if (team === 0) { teamEl.textContent = 'BLUE TEAM WINS'; teamEl.classList.add('blue'); }
  else if (team === 1) { teamEl.textContent = 'RED TEAM WINS'; teamEl.classList.add('red'); }
  else { teamEl.textContent = 'DRAW'; teamEl.classList.add('draw'); }
  scoreEl.textContent = `BLUE ${blueKills || 0} — ${redKills || 0} RED`;
  el.classList.add('show');
}
function hideWinBanner() { const el = $('winBanner'); if (el) el.classList.remove('show'); }
// Hide the top-center SDM round clock + score.
function hideMatchBar() { const el = $('matchBar'); if (el) el.hidden = true; }
// Update the top-center round clock + team score from the server-authoritative match state. Called
// each Free Flight frame. Shows only while an SDM round is live; hides otherwise. The clock is the
// server's `timeLeft` (already clamped at 0), formatted M:SS.
function updateMatchBar() {
  const el = $('matchBar');
  if (!el) return;
  const info = multiplayer.matchInfo();
  // Two clock sources: the server's authoritative `timeLeft` online, or our own solo round clock
  // offline. Either way the bar reads the same M:SS + team score.
  let t;
  if (multiplayer.connected) {
    if (info.matchState !== 'live') { el.hidden = true; return; }
    t = Math.max(0, Math.ceil(info.timeLeft || 0));
  } else if (_soloRoundEnd > 0) {
    t = Math.max(0, Math.ceil((_soloRoundEnd - performance.now()) / 1000));
    // Solo round expired: end the free-flight match once (guarded by _ffMatchEnding).
    if (t <= 0 && !_ffMatchEnding) { endFreeFlightMatch('TIME! — SQUADRON DEATH MATCH OVER'); }
  } else {
    el.hidden = true; return;
  }
  el.hidden = false;
  const mm = Math.floor(t / 60), ss = t % 60;
  $('mbClock').textContent = `${mm}:${ss < 10 ? '0' : ''}${ss}`;
  $('mbBlue').textContent = info.blueKills || 0;
  $('mbRed').textContent = info.redKills || 0;
  el.classList.toggle('urgent', t <= 30);
}
// ---- Live team scoreboard (HOLD the Show Scoreboard key, default `) --------------------------
// Held open while the pilot presses the bound Scoreboard key during a multiplayer match. Refreshed
// each frame it's open (see loop) from the live roster + match state, so kills/deaths/score/clock
// update in real time. NOTE: Tab is deliberately NOT this key — it stays reserved for Toggle View.
let _scoreboardOpen = false;
// Show / hide the scoreboard. Only meaningful in a connected Free Flight match; a no-op otherwise so
// the key does nothing in single-player. Rendered immediately on open so it's populated first frame.
function showScoreboard() {
  if (_scoreboardOpen) return;
  if (!(freeFlightMode && multiplayer.connected)) return;
  _scoreboardOpen = true;
  const el = $('mpScoreboard'); if (el) el.hidden = false;
  const foot = $('sbFootKey'); if (foot) foot.textContent = bindLabel('scoreboard');   // reflect the live binding
  renderScoreboard();
}
function hideScoreboard() {
  if (!_scoreboardOpen) return;
  _scoreboardOpen = false;
  const el = $('mpScoreboard'); if (el) el.hidden = true;
}
// Build both team columns from the live roster: team totals from the authoritative match state,
// per-pilot rows sorted best-first (kills desc, then fewest deaths), with the local pilot + dead
// pilots flagged. Called each frame while open so it tracks live combat.
function renderScoreboard() {
  const info = multiplayer.matchInfo();
  // Round clock (mirror the match bar's formatting).
  const t = Math.max(0, Math.ceil(info.timeLeft || 0));
  const mm = Math.floor(t / 60), ss = t % 60;
  const clk = $('sbClock'); if (clk) clk.textContent = `${mm}:${ss < 10 ? '0' : ''}${ss}`;
  $('sbBlueScore').textContent = info.blueKills || 0;
  $('sbRedScore').textContent = info.redKills || 0;
  const roster = multiplayer.liveRoster();
  const sortRows = (rows) => rows.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (a.me ? -1 : b.me ? 1 : 0));
  const blue = sortRows(roster.filter(r => r.team === 0));
  const red = sortRows(roster.filter(r => r.team === 1));
  const rowHtml = (r) => {
    const kd = r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : (r.kills > 0 ? r.kills.toFixed(2) : '0.00');
    const cls = 'sbRow' + (r.me ? ' me' : '') + (r.alive === false ? ' dead' : '');
    const nameColor = ranks.nameColor(ranks.rankForScore(r.rankScore), r.pioneer);
    return `<div class="${cls}"><span class="sbrName">${rowRankBadge(r, true)}` +
      `<span class="sbrPilot" style="color:${nameColor}">${escHtml(r.me ? r.name + ' (you)' : r.name)}</span></span>` +
      `<span class="sbrK">${r.kills}</span><span class="sbrD">${r.deaths}</span><span class="sbrKD">${kd}</span></div>`;
  };
  const fill = (host, rows) => {
    if (!host) return;
    host.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<div class="sbEmpty">No pilots</div>';
  };
  fill($('sbBlueBody'), blue);
  fill($('sbRedBody'), red);
}
// Render the Free Flight match-results scoreboard: one row per pilot who was in the arena this
// session (kills / deaths / K:D), best-first, with the local pilot highlighted. Freezes gameplay
// input behind the overlay and releases the pointer so the RETURN TO MENU button is clickable.
function showMatchResults(reason) {
  hideScoreboard();
  const rows = multiplayer.matchStats();
  const host = $('mrRows');
  const overlay = $('matchResults');
  if (!host || !overlay) { pausedFromGameplay = false; exitToMainMenu(); return; }
  $('mrSub').textContent = reason || 'Arena engagement complete.';
  if (!rows.length) {
    host.innerHTML = '<div class="mrEmpty">No combat was logged this match.</div>';
  } else {
    host.innerHTML = rows.map((r, i) => {
      const shipName = (SHIPS[r.shipId] && SHIPS[r.shipId].name) || 'Fighter';
      const teamCls = r.team === 1 ? 'red' : 'blue';
      const teamName = r.team === 1 ? 'RED' : 'BLUE';
      const kd = r.deaths > 0 ? (r.kills / r.deaths).toFixed(2) : (r.kills > 0 ? r.kills.toFixed(2) : '0.00');
      const you = r.me ? '<span class="mrYou">YOU</span>' : '';
      const nameColor = ranks.nameColor(ranks.rankForScore(r.rankScore), r.pioneer);
      const rank = ranks.rankForScore(r.rankScore);
      const rankBadge = ranks.rankBadgeHtml(rank, { pioneer: !!r.pioneer, compact: false });
      return `<div class="mrRow${r.me ? ' me' : ''}${i === 0 ? ' top1' : ''}">` +
        `<span class="mrRank">${i + 1}</span>` +
        `<span class="mrPilot"><span class="mrName" style="color:${nameColor}">${escapeHtml(r.name)}${you}</span>` +
          `<span class="mrHonor">${rankBadge}</span>` +
          `<span class="mrTeam ${teamCls}">${teamName} TEAM</span></span>` +
        `<span class="mrShip">${escapeHtml(shipName)}</span>` +
        `<span class="mrK">${r.kills}</span>` +
        `<span class="mrD">${r.deaths}</span>` +
        `<span class="mrKd">${kd}</span></div>`;
    }).join('');
  }
  overlay.classList.add('show');
  document.exitPointerLock?.();
  audio.play('lock', 0.4);
}
function closeMatchResults() { $('matchResults').classList.remove('show'); }
// "RETURN TO MAIN MENU" — drop the arena entirely and go back to the title screen.
$('mrConfirm').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.5);
  closeMatchResults();
  pausedFromGameplay = false;
  exitToMainMenu();
});
// "RETURN TO LOBBY" — tear down the finished match and drop straight back into the multiplayer
// lobby (which re-joins the arena and shows live rosters) so the pilot can launch a fresh match
// without going all the way out to the main menu.
$('mrLobby').addEventListener('click', () => {
  audio.unlock(); audio.play('laser', 0.6);
  closeMatchResults();
  pausedFromGameplay = false;
  returnToLobby();
});
// Shared teardown → lobby: stop the flight loop and the in-match state exactly like a bail to menu,
// then re-open the lobby overlay instead of the main menu. exitToMainMenu() already leaves the
// arena room, clears the playfield, resets the kill-cam, and shows the (now-hidden-behind) menu; we
// just surface the lobby on top and let openLobby() re-join the arena.
function returnToLobby() {
  exitToMainMenu();               // full, safe teardown (loop stop, arena leave, HUD reset, menu up)
  const menu = $('mainMenu');
  menu.classList.remove('in', 'show');   // hide the title menu; the full-screen lobby covers it
  openLobby();                    // re-join the arena + show live BLUE/RED rosters
}
function joinFreeFlightRoom() {
  _ffMatchLive = false;
  _ffMatchEnding = false;
  const onCount = (n, connected, team) => {
    setNetStatus(connected ? 'online' : 'offline', n, team);
    updateFreeFlightHud(n, connected, team);
    // Arm the match once another pilot is actually present…
    if (connected && n > 0) _ffMatchLive = true;
    // …then end it the moment they've all left, or the server connection drops mid-match.
    if (_ffMatchLive && !_ffMatchEnding) {
      if (!connected) endFreeFlightMatch('ARENA CONNECTION LOST — MATCH OVER');
      else if (n === 0) endFreeFlightMatch('ALL OTHER PILOTS LEFT — MATCH OVER');
    }
  };
  if (multiplayer.connected || multiplayer.room) {
    multiplayer.setCallbacks({ onCount, onKill: freeFlightKillFeed, onHit: freeFlightHitReport, onMatchStart: onServerMatchStart, onMatchEnd: onServerMatchEnd });
    // Reflect current status immediately.
    onCount(multiplayer.peerCount(), multiplayer.connected, multiplayer.myTeam);
    return;
  }
  setNetStatus('connecting');
  updateFreeFlightHud(0, false, 0);
  multiplayer.join({
    callSign: leaderboard.getPilotName() || 'MAMBA',
    shipId: _selectedShipId,
    endpoint: MP_ENDPOINT,
    ...myRankJoinArgs(),
    onCount,
    onKill: freeFlightKillFeed,
    onHit: freeFlightHitReport,
    onMatchStart: onServerMatchStart,
    onMatchEnd: onServerMatchEnd,
  }).then(() => connectVoiceAudio());   // bring up live voice audio (no-op if already connected)
}
// Drive the on-screen connection badge (top-center HUD pill). `state` is one of
// 'connecting' | 'online' | 'offline'; when online we append the live pilot count.
function setNetStatus(state, count = 0, team = 0) {
  const el = $('netStatus');
  const txt = $('netStatusText');
  if (!el || !txt) return;
  el.hidden = false;
  el.classList.remove('net-connecting', 'net-online', 'net-offline');
  if (state === 'online') {
    el.classList.add('net-online');
    const teamName = team === 1 ? 'RED' : 'BLUE';
    // count is OTHER pilots; +1 for us gives the arena headcount.
    txt.textContent = `ARENA · ${teamName} · ${count + 1} ONLINE`;
    showVoiceHud(true);   // voice comms are available once we're live on the server
  } else if (state === 'connecting') {
    el.classList.add('net-connecting');
    txt.textContent = 'CONNECTING…';
    showVoiceHud(false);
  } else {
    el.classList.add('net-offline');
    txt.textContent = 'SOLO FLIGHT';
    showVoiceHud(false);   // no voice comms in solo flight
  }
}
// Hide the badge entirely (leaving Free Flight / back to campaign or menu).
function hideNetStatus() {
  const el = $('netStatus');
  if (el) el.hidden = true;
  showVoiceHud(false);
  stopPushToTalk();   // ensure the mic is closed when we leave the arena
}
// Surface the live pilot count + our team on the Free Flight status line (the mission-text HUD).
function updateFreeFlightHud(count, connected, team) {
  if (!freeFlightMode) return;
  const el = $('missionText');
  if (!el) return;
  if (!connected) { el.textContent = 'Solo flight — arena server offline'; return; }
  const teamName = team === 1 ? 'RED' : 'BLUE';
  el.textContent = (count > 0
    ? `${teamName} team · ${count} other pilot${count === 1 ? '' : 's'} · press T to lock nearest, R to cycle`
    : `${teamName} team · waiting for other pilots…`);
}
// Leave the arena cleanly: drop the realtime room + ghosts. Called from the shared bail path.
function leaveFreeFlight() {
  if (!freeFlightMode && multiplayer.ghosts.size === 0) return;
  freeFlightMode = false;
  _ffMatchLive = false; _ffMatchEnding = false;   // reset match-over tracking for the next session
  _soloRoundEnd = 0;                               // disarm the solo round clock
  resetKillCam();                                  // clear any active kill-cam + hide its overlay
  hideNetStatus();
  voice.disconnect();                              // tear down the live voice-audio room (mic + remote streams)
  multiplayer.leave();
}
// Force the kill-cam off (used when bailing/ending while dead so the overlay + camera don't stick).
function resetKillCam() {
  killCam.active = false;
  killCam.wasAlive = true;
  // Reset the phased cinematic state so a stale phase/timer can't leak into the next death.
  killCam.phase = 'idle';
  killCam.phaseT = 0;
  killCam.exploded = false;
  killCam.lastShown = -1;
  const el = document.getElementById('killCam'); if (el) el.classList.remove('show');
  const skip = document.getElementById('kcSkip'); if (skip) skip.style.display = 'none';
  _kcBuf.length = 0;   // drop any recorded run-up so it can't replay in a fresh session
  // Also clear the respawn warp veil + hit marker so neither sticks on-screen after bailing.
  clearTimeout(_respawnWarpT);
  const rw = document.getElementById('respawnWarp'); if (rw) rw.classList.remove('show');
  const hm = document.getElementById('hitMarker'); if (hm) hm.classList.remove('show');
  hideScoreboard();
}
// Spawn `n` stationary cargo containers at VARYING distances/bearings ahead of the player, spread
// across the training volume so the player must maneuver to line each up. Added to the `enemies`
// group so the existing bolt-hit/lock/explosion pipeline handles them; the AI/mission code skips
// them via their `container` kind.
const _tutContainerFwd = new THREE.Vector3();
function spawnTutorialContainers(n) {
  // Aim them out ahead of the ship's nose so they read as a debris field to strafe.
  _tutContainerFwd.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();
  const base = player.position.clone();
  for (let i = 0; i < n; i++) {
    // Distances stagger from ~120m to ~480m so some are easy and some need a real approach.
    const dist = 120 + (i / Math.max(1, n - 1)) * 360 + THREE.MathUtils.randFloatSpread(40);
    // Scatter laterally/vertically around the forward axis.
    const lateral = THREE.MathUtils.randFloatSpread(220);
    const vert = THREE.MathUtils.randFloatSpread(120);
    const pos = base.clone()
      .addScaledVector(_tutContainerFwd, dist)
      .add(new THREE.Vector3(lateral, vert, 0));
    const len = 11 + Math.random() * 8;
    const c = makeContainer(pos, { len, hp: 70, urlIndex: i });
    enemies.add(c);
    tutorialContainers++;
  }
}
// Count live cargo containers still floating in the scene (the destructible tutorial targets).
function liveTutorialContainers() {
  let n = 0;
  for (const e of enemies.children) {
    if (e && e.userData && e.userData.kind === 'container' && (e.userData.hp == null || e.userData.hp > 0)) n++;
  }
  return n;
}
// Make sure the targeting/missile steps always have something to lock onto: if the practice field
// has been cleared down low, top it back up. Called on entering the select/cycle/missile/targets
// steps so the player can never get stranded with "NO CONTACTS" mid-lesson.
function replenishTutorialTargets(min = 3) {
  if (!tutorialMode) return;
  const live = liveTutorialContainers();
  if (live < min) spawnTutorialContainers(min - live + 2);
}
// Warp three live enemy fighters in for the closing tutorial dogfight. Modest HP so the player can
// finish flight school without a grind, spawned a fair distance out so they "jump in".
//
// `scripted` (used for the FIRST warp-in) designates one fighter as a long-range "shooter": it
// jumps in well clear of the player and, after a beat, fires a single guided missile. That gives the
// chaff lesson a real, survivable incoming threat to defeat for the first time.
function spawnTutorialFighters(n, { scripted = false } = {}) {
  audio.play('warp', 0.6);
  let shooter = null;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    // The scripted shooter (index 0) jumps in FAR out so its missile has a long flight time; the
    // rest streak in closer for the knife-fight.
    const isShooter = scripted && i === 0;
    const r = isShooter ? (900 + Math.random() * 160) : (420 + Math.random() * 220);
    const pos = player.position.clone().add(new THREE.Vector3(
      Math.cos(ang) * r,
      THREE.MathUtils.randFloatSpread(isShooter ? 80 : 160),
      Math.sin(ang) * r - 200
    ));
    const kind = i === 0 ? 'fighter' : i === 1 ? 'interceptor' : 'drone';
    const f = makeEnemy(kind, pos, trails);
    f.userData.hp = f.userData.maxHp = Math.round(f.userData.maxHp * 0.7);   // softer for training
    f.userData.behavior = 'pursue';
    f.userData.tutorialFighter = true;
    // A little warp-in pop so they read as arriving rather than blinking into being.
    spark(explosions, pos, 0xff7a3c);
    enemies.add(f);
    if (isShooter) shooter = f;
  }
  flash(`CONTACTS · ${n} BANDITS INBOUND`);
  // Scripted opener: after a short beat (warp streak + "contacts inbound" banner settle), the
  // far shooter launches one seeker at the player so the chaff step has a live missile to break.
  if (scripted && shooter) {
    setTimeout(() => {
      if (!tutorialMode || !shooter.parent) return;   // bailed out / already dead
      launchTutorialMissileAtPlayer(shooter);
    }, 2200);
  }
}
// Fire a single guided missile from `e` at the player — used by the scripted tutorial warp-in so the
// chaff lesson has a genuine incoming threat. Fired straight at the player from long range so there
// is ample time to react and deploy chaff.
function launchTutorialMissileAtPlayer(e) {
  const dir = player.position.clone().sub(e.position).normalize();
  const start = e.position.clone().addScaledVector(dir, (e.userData.radius || 2) + 1.5);
  const tm = makeMissile(start, dir, false, player, 34);
  // Long-range training shot: distance-scaled turn authority keeps it evadable (the point of the drill).
  tm.userData.turn = missileTurnForRange(player.position.distanceTo(e.position));
  missileGroup.add(tm);
  audio.play('enemyLaser', 0.4);
  flash('MISSILE INBOUND · DEPLOY CHAFF');
}
// Re-fire a tutorial missile at the player from a live bandit — used by the chaff lesson when the
// player ignores the first missile. Picks the FARTHEST live tutorial fighter so the new shot again
// has plenty of standoff/flight time for the player to react. No-ops if every bandit is already dead
// (the chaff step still resolves the instant the player deploys chaff regardless).
function fireTutorialMissileFromShooter() {
  let shooter = null, bestD = -1;
  for (const e of enemies.children) {
    if (!e.userData || !e.userData.tutorialFighter) continue;
    if (e.userData.hp != null && e.userData.hp <= 0) continue;
    const d = e.position.distanceTo(player.position);
    if (d > bestD) { bestD = d; shooter = e; }
  }
  if (shooter) launchTutorialMissileAtPlayer(shooter);
}
// True while at least one live, non-friendly missile is currently tracking the player (not seduced
// off by a chaff decoy). Drives the tutorial chaff step so it only asks for chaff with a real threat.
function tutorialMissileIncoming() {
  for (const m of missileGroup.children) {
    const u = m.userData;
    if (u && u.isMissile && !u.friendly && u.target === player && !u.decoy) return true;
  }
  return false;
}
// Flight school finished: drop the player back to the main menu with the opt-out remembered, so a
// graduate isn't asked again. (Re-runnable any time from the Tutorial menu button.)
function onTutorialComplete() {
  setTutorialSkipped(true);
  // Short victory beat, then return to the menu cleanly.
  setTimeout(() => { endTutorialToMenu(); }, 1600);
}
function endTutorialToMenu() {
  pausedFromGameplay = false;
  exitToMainMenu();   // shared bail: stops the loop, clears the scene, restores the main menu
}

// ---- Post-tutorial hyperspace warp-tunnel menu ----------------------------------------------------
// The player graduated and pressed H: jump to lightspeed and HOLD in the tunnel while a 4-option menu
// floats over the rushing streaks. The render loop runs `tutorialWarpHold` like `briefingHold` — the
// ship is parked, gameplay frozen, streaks streaming — until the player picks an option below.
function enterTutorialWarpMenu() {
  setTutorialSkipped(true);            // they finished flight school; don't nag next Start
  tutorial.stop();                     // tear down the tutorial banner/state; the menu owns it now
  tutorialMode = false;
  // Clear the live training scene so no stray bandits/missiles/containers carry into the tunnel.
  clearShipGroup(enemies); boltGroup.clear(); missileGroup.clear();
  awaitingHyperspace = false; $('hyperPrompt').classList.remove('show');
  // Enter the held tunnel: lightspeed SFX + travel hum, full-intensity streaks (driven in loop()).
  tutorialWarpHold = true;
  warpIn.beginHold();
  audio.play('warp', 0.7);
  audio.startHum(0.5);
  document.exitPointerLock?.();        // free the cursor so the menu buttons are clickable
  mouse.locked = false;
  showTutorialWarpMenu();
}
function showTutorialWarpMenu() { $('warpMenu').classList.add('show'); }
function hideTutorialWarpMenu() { $('warpMenu').classList.remove('show'); }
// Leave the held tunnel (clean up streaks + hum) — shared by every option that exits the menu.
function leaveTutorialWarpHold() {
  tutorialWarpHold = false;
  warpIn.endHold();
  audio.stopHum();
  hideTutorialWarpMenu();
}
// CONTINUE: warp straight into the Mission 1 briefing/jump. We're already mid-tunnel, so just clear
// the hold and launch the campaign from mission 1.
function warpMenuContinue() {
  audio.play('laser', 0.7);
  leaveTutorialWarpHold();
  missionIndex = 0;                    // start the campaign at Mission 1
  Object.assign(state, createPlayerState());
  pausedFromGameplay = false;
  launchMission();                     // pre-mission loading screen -> Mission 1 warp-in/briefing
}
// MAIN MENU: drop the tunnel and return to the main menu (shared bail handles teardown).
function warpMenuMainMenu() {
  audio.play('shield', 0.3);
  leaveTutorialWarpHold();
  pausedFromGameplay = false;
  exitToMainMenu();
}
// OPTIONS: open Settings; on close, come right back to THIS warp menu (the tunnel kept streaming
// behind it the whole time). The one-shot return flag is honoured in the settings onClose handler.
let _returnToWarpMenu = false;
function warpMenuOptions() {
  audio.play('shield', 0.25);
  _returnToWarpMenu = true;
  hideTutorialWarpMenu();              // hide the menu card while Settings is up; tunnel keeps streaming
  settingsUI.open('Settings', 'Sound, Controls & About', 'Back');
}
// EXIT GAME: best-effort close; if the host won't let a tab self-close, fall back to the main menu.
function warpMenuExit() {
  audio.play('shield', 0.3);
  leaveTutorialWarpHold();
  try { window.close(); } catch {}
  // Some embeds block window.close(); land the player on the main menu as a graceful fallback.
  setTimeout(() => { if (!document.hidden) { pausedFromGameplay = false; exitToMainMenu(); } }, 150);
}
$('wmContinue').addEventListener('click', warpMenuContinue);
$('wmMainMenu').addEventListener('click', warpMenuMainMenu);
$('wmOptions').addEventListener('click', warpMenuOptions);
$('wmExit').addEventListener('click', warpMenuExit);

let _warpExitSpeed = 30;
let _warpCruiseDur = 3.0;   // cruise length handed to WarpIn for the next jump (short after long briefings)
let briefingHold = false;   // true while a pre-jump briefing line plays before the warp-in starts
let tutorialWarpHold = false;   // true while the post-tutorial warp-tunnel menu is held over the streaks
// Kick off the hyperspace jump-in. The loop runs the warp-in on rails (no input/AI) until it
// drops to sublight, then control resumes with the ship already in forward motion.
// The hull the player is ACTUALLY flying right now (drives per-ship warp/jump audio). Prefer the
// live swapped hull on the player group; fall back to the ship-select choice before the hull loads.
function currentHullId() {
  return (player && player.userData && player.userData.shipId) || _selectedShipId || 'lightning';
}

// ---- SCAAVI / Crimson SCAAVI shipboard AI combat barks ----------------------------------------
// Blue-team hulls run SCAAVI; red-team (captured) hulls run Crimson SCAAVI. Both alert the player to
// the same three conditions — shields failing, heavy hull damage, shields fully recharged — just
// with different voice lines. This shared monitor drives them in BOTH single-player and multiplayer
// (where the server owns hull/shields), so a red-team pilot hears Crimson SCAAVI and a blue-team
// pilot hears SCAAVI exactly like Mamba does solo.
const CRIMSON_SCAAVI = {
  shieldsFailing: 'assets/audio/voice/crimsonscaavi/crimsonshieldsfail.mp3',
  hullDamage: 'assets/audio/voice/crimsonscaavi/crimsonhulldmg.mp3',
  shieldsRecharged: 'assets/audio/voice/crimsonscaavi/shieldsrecharged.mp3',
};
const BLUE_SCAAVI = {
  shieldsFailing: 'assets/audio/voice/scaavi/scaavishieldsfailing.mp3',
  hullDamage: 'assets/audio/voice/scaavi/scaavihull.mp3',
  shieldsRecharged: 'assets/audio/voice/scaavi/scaaviyayshields.mp3',
};
// Which SCAAVI voice pack the player's current hull uses. Red-team (captured) hulls -> Crimson.
function scaaviPack() {
  return RED_SHIPS.includes(currentHullId()) ? CRIMSON_SCAAVI : BLUE_SCAAVI;
}
// Latched trigger state so each alert fires once per crisis and re-arms only after recovery.
// Reset on match/mission (re)start so a fresh life starts clean.
const scaaviAlert = {
  shieldWarnArmed: false,   // true after the shields-failing bark, until shields recover past 25%
  hullWarnArmed: false,     // true after the hull-damage bark, until hull recovers past 60%
  tookHeavyDamage: false,   // set once shields drop meaningfully; gates the "shields recharged" line
};
function resetScaaviAlerts() {
  scaaviAlert.shieldWarnArmed = false;
  scaaviAlert.hullWarnArmed = false;
  scaaviAlert.tookHeavyDamage = false;
}
// Monitor the player's shield/hull fractions (0..1) and speak the right SCAAVI/Crimson SCAAVI line.
// Called every frame with the CURRENT fractions; it latches its own edges, so it's safe to call
// from both the single-player damage path and the multiplayer HUD-mirror path.
//  • shields <=10%  -> shields-failing (re-arms after shields climb back over 25%)
//  • hull    <50%   -> hull-damage     (re-arms after hull climbs back over 60%)
//  • shields ==100% after having dropped -> shields-recharged (once, then waits for the next dip)
function updateScaaviAlerts(shieldFrac, hullFrac) {
  const pack = scaaviPack();
  // Note a meaningful shield dip so the "recharged" line only plays after real combat, not on spawn.
  if (shieldFrac < 0.85) scaaviAlert.tookHeavyDamage = true;
  // Shields failing.
  if (shieldFrac <= 0.10 && !scaaviAlert.shieldWarnArmed) {
    const el = audio.playScaaviLine(pack.shieldsFailing);
    captionVoice(pack.shieldsFailing, 'SCAAVI', el);
    scaaviAlert.shieldWarnArmed = true;
  } else if (shieldFrac > 0.25) {
    scaaviAlert.shieldWarnArmed = false;
  }
  // Heavy hull damage (more than 50% of the hull gone).
  if (hullFrac < 0.50 && !scaaviAlert.hullWarnArmed) {
    if (pack.hullDamage) {
      const el = audio.playScaaviLine(pack.hullDamage);
      captionVoice(pack.hullDamage, 'SCAAVI', el);
    }
    scaaviAlert.hullWarnArmed = true;
  } else if (hullFrac > 0.60) {
    scaaviAlert.hullWarnArmed = false;
  }
  // Shields fully recharged after significant damage.
  if (shieldFrac >= 0.999 && scaaviAlert.tookHeavyDamage) {
    if (pack.shieldsRecharged) {
      const el = audio.playScaaviLine(pack.shieldsRecharged);
      captionVoice(pack.shieldsRecharged, 'SCAAVI', el);
    }
    scaaviAlert.tookHeavyDamage = false;   // wait for the next dip before it can fire again
  }
}

function startWarpIn() {
  warpingIn = true;
  warpInPhase = 'cruise';
  // The warp-in arrival is ALWAYS a chase shot of the player's ship streaking in. While it plays we
  // present the chase HUD (`.third`) so the cockpit canopy, reticle and cockpit-only instruments are
  // hidden — otherwise the player's own ship appears out in front of their cockpit, which reads wrong.
  // Restored to the player's real view on arrival (onDone).
  ui.classList.add('third');
  audio.startHum(0.55);                      // hyperspace-travel hum while in the tunnel
  // Fire the CHOSEN hull's HYPERSPACE-JUMP signature as it streaks in, so the ship's own sonic
  // identity (spool-up -> lightspeed whoosh -> tunnel drone, matching its ship-select ignition)
  // carries from ship-select through the warp-in. Keyed to the actual flown hull.
  audio.playShipWarp(currentHullId(), 0.8);
  warpIn.start(player, { exitSpeed: _warpExitSpeed, cruiseDur: _warpCruiseDur, onDone: () => {
    warpingIn = false; warpInPhase = 'idle';
    // Restore the player's actual selected view now that the chase arrival is over.
    ui.classList.toggle('third', view === 'third');
    // The moment the player settles out of hyperspace into Mission 2's empty space, kick off the
    // scripted wingman introduction (Slick warps in first, over the right shoulder).
    if (introSlick && !mission2IntroStarted) startMission2Intro();
    // Mission 3: the wingmen are already on-station (crippled O.G. + cover Slick), so play their
    // in-fight intro radio lines as the player drops in.
    if (mission3Active() && !mission3IntroStarted) startMission3Intro();
    // FLIGHT SCHOOL: arm the step-by-step tutorial the moment the player drops into the training
    // volume. The controller plays the intro VO + seeds the practice containers and walks the steps.
    if (tutorialMode && !tutorial.active) tutorial.start();
    // CO-OP FREE FLIGHT: the player has settled into the arena — join the realtime room now so peer
    // ghosts start streaming in.
    if (freeFlightMode) joinFreeFlightRoom();
  } });
}
// Drive the Mission 3 wingman-intro radio beats once the player drops out of hyperspace. Slick
// checks in first (he's flying cover), then O.G. radios from his crippled bird — both with the
// green speaking-brackets + mic over their ships.
function startMission3Intro() {
  mission3IntroStarted = true;
  const T = (fn, ms) => { _mission3IntroTimers.push(setTimeout(fn, ms)); };
  flash('PROTECT O.G. — HOLD THE LINE');
  // Slick calls in first.
  allySpeak('SLICK', MISSION3_SLICK_INTRO, 0.95, () => {
    // ~0.6s after Slick's line, O.G. answers from his disabled fighter.
    T(() => { allySpeak('O.G.', MISSION3_OG_INTRO, 0.95); }, 600);
  });
}
// Warp a held wingman onto the stage RIGHT IN FRONT of the player's field of view: reveal it,
// drop it out of hyperspace just ahead and off to its side (left or right per its formOffset.x),
// then snap it into the formation slot with a quick arrive-slide. Nose is -Z (forward).
const _wmFwd = new THREE.Vector3(), _wmRight = new THREE.Vector3(), _wmUpV = new THREE.Vector3();
function releaseWingman(ally) {
  if (!ally || !allies.children.includes(ally)) return;
  const ud = ally.userData;
  ud.introHold = false;
  ally.visible = true;
  // Build the player's local frame so we can place the wingman in VIEW (ahead) and to its side.
  _wmFwd.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();   // forward
  _wmRight.set(1, 0, 0).applyQuaternion(player.quaternion).normalize();  // player's right (+X)
  _wmUpV.set(0, 1, 0).applyQuaternion(player.quaternion).normalize();
  const side = ud.spawnSide || ud.formOffset || new THREE.Vector3(16, 0, 26);
  const sideSign = Math.sign(side.x) || 1;   // +1 = right wing, -1 = left wing
  // Appear ~70m AHEAD (well within the forward field of view) and ~55m out to its side, so it
  // streaks in from the left/right edge of view rather than from far downrange.
  ally.position.copy(player.position)
    .addScaledVector(_wmFwd, 70)
    .addScaledVector(_wmRight, 55 * sideSign)
    .addScaledVector(_wmUpV, side.y);
  // Face the same way as the player so it reads as flying alongside, not crossing the nose.
  ally.quaternion.copy(player.quaternion);
  ud.vel.copy(_wmFwd).multiplyScalar(ud.speed || 22);   // already moving forward on arrival
  if (ud.engines) for (const eng of ud.engines) if (eng.trail) eng.trail.userData.history.length = 0;
  ud.arriveT = 1.1;        // quick scripted slide from the in-view drop-out into the formation slot
  audio.play('warpDropout', 0.55);
}
// ---- Wingman "speaking" indicator support --------------------------------------------------
// Find a live allied ship by its call sign (e.g. 'SLICK', 'O.G.'), or null if it's gone.
function findAllyByCall(call) {
  for (const a of allies.children) if (a.userData.callSign === call) return a;
  return null;
}
// Play a wingman radio line AND flag that ship as "speaking" for the clip's duration, so the HUD
// can frame it with the green speaking-brackets + mic. Routes through audio.playRadioClip (static
// bed) and clears the flag when the clip ends/fails. `call` is the speaker's call sign.
function allySpeak(call, url, vol = 0.95, onEnded = null, staticLevel = 0.16) {
  const setSpeaking = on => {
    const a = findAllyByCall(call);
    if (a) a.userData.speaking = on;
  };
  setSpeaking(true);
  const el = audio.playRadioClip(url, vol, () => {
    setSpeaking(false);
    if (onEnded) onEnded();
  }, staticLevel);
  captionVoice(url, call, el);   // sync the caption track to the live clip (no-op if subtitles off)
  return el;
}
// Drive the Mission 2 wingman-introduction beats. Called once when the player exits hyperspace.
function startMission2Intro() {
  mission2IntroStarted = true;
  const T = (fn, ms) => { _mission2IntroTimers.push(setTimeout(fn, ms)); };
  // Slick warps in over the right shoulder immediately and radios in (voice + static).
  releaseWingman(introSlick);
  if (introSlick) flash(`${introSlick.userData.callSign} ON YOUR WING`);
  allySpeak('SLICK', 'assets/audio/voice/mission-2/slickm2intro.mp3', 0.95, () => {
    // 0.5s after Slick's line ends, O.G. checks in (voice + static).
    T(() => {
      allySpeak('O.G.', 'assets/audio/voice/mission-2/ogintrom2.mp3', 0.95);
    }, 500);
  });
  // 5s into Slick's line, O.G. drops out of hyperspace over the LEFT shoulder.
  T(() => {
    releaseWingman(introOG);
    if (introOG) flash(`${introOG.userData.callSign} FORMING UP`);
  }, 5000);
}

function loop(time) {
  timer.update(time); const dt = Math.min(timer.getDelta(), .05);
  if (!mission || paused) return;      // frozen while the pause overlay is up
  // KEYBOARD-FOCUS KEEPALIVE: in an embedded iframe the parent page can quietly hold keyboard focus
  // even after pointer-lock re-engages (mouse works, keyboard dead — the exact "click back, mouse
  // returns but still can't thrust" symptom). Each active frame, if the pointer is locked but this
  // document doesn't have focus, pull it back so the keydown listener fires here, not in the parent.
  if (document.pointerLockElement && document.hasFocus && !document.hasFocus()) grabFocus();
  // POINTER-LOCK KEEPALIVE: keep our `mouse.locked` flag in lockstep with the REAL DOM lock state
  // every frame. A missed/dropped `pointerlockchange` event (some browsers skip it on certain
  // OS-level focus changes) could otherwise strand `mouse.locked` out of sync — true when lock is
  // actually gone (mousemove keeps reading deltas that no longer arrive → "mouse input lost"), or
  // false when it's actually held (the handler early-returns and ignores real movement). Re-deriving
  // it from the source of truth each frame makes the steering input self-heal.
  const reallyLocked = document.pointerLockElement === renderer.domElement;
  if (mouse.locked !== reallyLocked) {
    mouse.locked = reallyLocked;
    if (!reallyLocked && inActiveFlight()) flash('CLICK TO RESUME FLIGHT CONTROL');
  }
  // HUD tuner (K) freezes gameplay entirely, like a menu: no flight input, AI, fire, or camera
  // motion — just keep the scene rendered underneath the tuner box so panels can be positioned
  // against the live HUD. Closing the tuner (K) resumes normal flight.
  if (hudTuner.on) { renderer.render(scene, camera); return; }
  if (exhaustDev.on) { updateExhaustDev(dt); renderer.render(scene, camera); return; }   // calibration rig owns the frame
  if (orientDev.on) { updateOrientDev(dt); renderer.render(scene, camera); return; }     // orientation rig owns the frame
  if (tutorialWarpHold) {
    // Post-tutorial warp-tunnel menu: the graduate jumped to lightspeed and is HELD in the tunnel
    // while the 4-option menu floats over the streaks. Gameplay is frozen (no input/AI/fire); the
    // streak field rushes past anchored to the camera, black backdrop so it pops.
    scene.background = skyBlack;
    debris.visible = false;
    updateCamera(dt, true);
    warpIn.streakHold(dt);   // rush the lightspeed streaks past while parked
    updateEngineTrails(player, dt, 1, camera, true);   // blazing hyperspace exhaust streak
    renderer.render(scene, camera);
    return;
  }
  if (briefingHold) {
    // Pre-jump briefing: the mission is set up and the ship is parked at its far-back pre-warp
    // position, but the hyperspace run hasn't started yet. Freeze gameplay (no input/AI/fire).
    // The hyperspace star-tube streaks past the whole time (anchored to the camera) so the
    // briefing reads as the hero already racing through the tunnel awaiting the jump. Black
    // backdrop so the streaks pop instead of sitting over a static starfield.
    scene.background = skyBlack;
    debris.visible = false;
    updateCamera(dt, true);
    warpIn.streakHold(dt);   // rush the lightspeed streaks past while parked
    updateEngineTrails(player, dt, 1, camera, true);   // blazing hyperspace exhaust streak
    updateHUD(dt);
    renderer.render(scene, camera);
    return;
  }
  if (warpingIn) {
    // Hyperspace arrival at mission start: the ship is on rails (no input/AI/fire) while it
    // decelerates out of lightspeed. UNLIKE warp-out, the camera CHASES the ship so we see it
    // streak in and settle. Exhaust runs a long blazing hyperspace streak that eases to normal.
    warpIn.update(dt);
    // When the ship begins decelerating out of lightspeed (the streaks start slowing), cue the
    // drop-out sound effect once and fade the travel hum out as we settle to sublight.
    if (warpInPhase === 'cruise' && warpIn.phase === 'arrival') {
      warpInPhase = 'arrival';
      audio.play('warpDropout', 0.8);
      audio.stopHum();
    }
    // Hide the speed-debris during the hyperspace streak; reseed it on the ship's arrival
    // point so the motes don't streak in from where the ship was before the jump.
    debris.visible = false;
    reseedDebrisField(debris);
    // Swap the static starfield to flat black while the streaks are rushing past, so the
    // background reads as "everything whooshing"; restore the stars as the ship settles.
    scene.background = warpIn.starsVisible ? skyTex : skyBlack;
    updateCamera(dt, true);   // snap the camera so it tracks the fast-moving arrival without lag
    updateEngineTrails(player, dt, 1, camera, false, warpIn.trailScale);
    updateHUD(dt);
    renderer.render(scene, camera);
    return;
  }
  if (m1Outro.active) {
    // Mission-1-complete cinematic owns the frame: third-person jump -> cockpit hyperspace +
    // debrief voice -> hand off to the hangar-landing draft. It runs under the `warping` rail.
    updateMission1Outro(dt);
    return;
  }
  if (warping) {
    // During the lightspeed jump-out, the hero is on rails: no input, no AI, no fire.
    // CRUCIALLY the camera is FROZEN (it does not chase the ship) so the hero visibly
    // streaks away into the distance and the camera-anchored warp streaks rip past —
    // otherwise the follow-cam keeps the ship centered and the jump can't be seen.
    warpOut.update(dt);
    debris.visible = false;   // hyperspace streak owns the screen; speed-debris is hidden
    // Black out the static starfield once the jump leaps to lightspeed so the streaks
    // dominate and no motionless stars sit behind the rushing tube.
    scene.background = warpOut.starsVisible ? skyTex : skyBlack;
    updateExplosions(dt);
    // Lightspeed streak mode: the ship snaps forward too far for the normal history
    // ribbon, so draw a long straight exhaust streak welded to the engines instead.
    updateEngineTrails(player, dt, 1, camera, true);
    renderer.render(scene, camera);
    return;
  }
  // Normal flight: make sure the starfield is restored (warp branches may have blacked it out).
  if (scene.background !== skyTex) scene.background = skyTex;
  if (!debris.visible) debris.visible = true;   // re-show after a warp branch hid it
  pollGamepad();   // controller steering/actions feed the same mouse-offset + held-key model
  if (_rescueBarkCooldown > 0) _rescueBarkCooldown = Math.max(0, _rescueBarkCooldown - dt);
  if (_killBarkCooldown > 0) _killBarkCooldown = Math.max(0, _killBarkCooldown - dt);
  updatePlayer(dt); updateBolts(dt); updateMissiles(dt); updateEnemies(dt); updateAllies(dt); updateExplosions(dt); updateMission(dt); updateCamera(dt); updateHUD(dt);
  if (tutorialMode && tutorial.active) tutorial.update(dt);   // advance the flight-school step machine
  updatePlayerShield(player, dt);
  // Engine exhaust + speed-reactive trails. Throttle 0..1 maps current speed to trail length.
  const maxSpeed = 74 * (1 + state.mods.engineSpeed) * 1.6;
  const speed01 = THREE.MathUtils.clamp(player.userData.vel.length() / maxSpeed, 0, 1);
  // Hide the exhaust in cockpit view: the camera sits ahead of the engines, so world-space
  // streaks can otherwise drift into the field of view in front of the canopy.
  updateEngineTrails(player, dt, speed01, camera, false, 1, player.userData.vel, view === 'first');
  // Cockpit engine hum: throttle-driven drone heard only in first-person view. Use the same
  // throttle the ENGINES HUD bar shows (speed vs. base top speed) so it tracks what the pilot
  // sees. Silenced automatically in chase view / when muted.
  const humThrottle = THREE.MathUtils.clamp(player.userData.vel.length() / (74 * (1 + state.mods.engineSpeed)), 0, 1);
  audio.setEngineHum(humThrottle, view === 'first');
  // Speed-debris motes streaming past to sell motion (especially from the cockpit).
  updateDebrisField(debris, player.position, player.userData.vel, speed01, dt);
  // Co-op FREE FLIGHT networking. When connected to the arena server, the SERVER is authoritative:
  // we sample our input intent, hand the net client our local mirror to predict + reconcile, then
  // copy the corrected pose back onto the real `player` so the render/camera follow server truth.
  // Remote ships are interpolated inside multiplayer.update(). Offline, this is a cheap no-op.
  if (freeFlightMode && multiplayer.connected) {
    multiplayer.setLocalInput(sampleFlightInput());
    seedMirrorFromPlayer(_mpLocalState);
    multiplayer.update(dt, _mpLocalState);
    applyMirrorToPlayer(_mpLocalState);
    // Reflect the server's authoritative combat state onto our HUD gauges. In the arena the server
    // owns our hull/shields (they take damage from real hits and regen server-side), so we mirror
    // them rather than running the single-player damage model.
    state.hull = multiplayer.myHull;
    state.shields = (multiplayer.myShields / 100) * state.maxShields;
    state.score = multiplayer.myKills * 100;
    // SCAAVI / Crimson SCAAVI combat barks in multiplayer — same alerts Mamba gets in single-player,
    // driven off the authoritative server hull/shields. myShields is already a 0..100 percentage;
    // myHull is 0..100. Only while alive (a dead/respawning ship reads 0 and shouldn't bark).
    if (multiplayer.myAlive) {
      updateScaaviAlerts(multiplayer.myShields / 100, multiplayer.myHull / 100);
    }
    // Kill-cam / respawn: react to the server-authoritative alive flag. On death we enter a
    // cinematic orbit of the wreck (framing the killer if known) and show a respawn countdown; on
    // respawn we snap back to the normal chase. updateKillCam() overrides the camera while dead.
    updateFreeFlightDeath(dt);
    // Keep the WebAudio listener glued to the player's camera so remote engine drones, networked
    // laser fire, and fly-by whooshes pan to the correct side and attenuate with distance.
    // updateCamera()/updateKillCam() already positioned the camera this frame; refresh its world
    // matrix so the listener reads an up-to-date position/orientation before we sample it.
    camera.updateMatrixWorld();
    audio.updateListener(camera);
    // Squadron Death Match HUD: top-center round clock + team score (server-authoritative).
    updateMatchBar();
    // Live team scoreboard, refreshed only while the pilot is holding TAB to view it.
    if (_scoreboardOpen) renderScoreboard();
  } else if (freeFlightMode) {
    // Offline/solo Squadron Death Match: no netcode, but still run the chosen round clock so the
    // lobby's Round Timer is honored and the match ends when it expires.
    updateMatchBar();
  }
  renderer.render(scene, camera);
}
// ---- Free Flight input sampling + local-mirror sync ------------------------------------------
// Read the player's current flight INTENT into the normalized shape the netcode/server expect. This
// is the same input the single-player flight model consumes (mouse steering offset + bound keys),
// just packaged as plain numbers/booleans — never positions.
function sampleFlightInput() {
  const held = id => settings.bindings[id] && settings.bindings[id].some(code => code && keys.has(code));
  let roll = 0;
  if (held('strafeLeft')) roll += 1;
  if (held('strafeRight')) roll -= 1;
  return {
    steerX: mouse.x, steerY: mouse.y, roll,
    thrust: held('thrust'), reverse: held('reverse'), boost: held('boost'),
  };
}
// Copy the real THREE player pose into the plain-object mirror the net client integrates.
function seedMirrorFromPlayer(m) {
  m.pos.x = player.position.x; m.pos.y = player.position.y; m.pos.z = player.position.z;
  m.vel.x = player.userData.vel.x; m.vel.y = player.userData.vel.y; m.vel.z = player.userData.vel.z;
  m.quat.x = player.quaternion.x; m.quat.y = player.quaternion.y; m.quat.z = player.quaternion.z; m.quat.w = player.quaternion.w;
}
// Copy the reconciled (server-authoritative) mirror pose back onto the real THREE player.
function applyMirrorToPlayer(m) {
  player.position.set(m.pos.x, m.pos.y, m.pos.z);
  player.userData.vel.set(m.vel.x, m.vel.y, m.vel.z);
  player.quaternion.set(m.quat.x, m.quat.y, m.quat.z, m.quat.w).normalize();
}

// ---- Multiplayer KILL-CAM + RESPAWN --------------------------------------------------------------
// The server owns the death → respawn window (see ArenaRoom RESPAWN_DELAY): it flips our ship's
// `alive` flag and streams a `respawnIn` countdown + `lastKiller`. Here we react to that on the
// CLIENT: on the alive→dead edge we blow the wreck, drop into a cinematic slow-orbit kill-cam that
// frames the killer (falling back to a wreck orbit), and show a respawn countdown ring; on the
// dead→alive edge we snap back to normal flight. `killCam.active` gates input elsewhere.
const killCam = {
  active: false,
  wasAlive: true,        // last-frame alive state, for edge detection
  phase: 'idle',         // 'replay' -> 'explode' -> 'hold'
  phaseT: 0,             // seconds elapsed in the current phase
  replayIdx: 0,          // playback cursor into the recorded pose buffer
  exploded: false,       // guard so the death blast fires exactly once
  center: new THREE.Vector3(),   // death site (wreck / explosion focus)
  killerId: '',          // sessionId of who got us (for framing + label)
  killerName: '',
  angle: 0,              // orbit angle for the wreck-hold framing (radians)
  lastShown: -1,         // last integer countdown value pushed to the DOM (dedupes updates)
};
// The SKIP button on the kill-cam overlay jumps past the cinematic beats to the RELAUNCHING hold.
// The overlay's container has pointer-events:none, so the button re-enables them on itself (see CSS)
// and we guard the click on an active, non-hold kill-cam.
{
  const _kcSkipBtn = document.getElementById('kcSkip');
  if (_kcSkipBtn) _kcSkipBtn.addEventListener('click', () => {
    if (killCam.active && killCam.phase !== 'hold') skipKillCam();
  });
}
// Timing for the three kill-cam beats. The replay shows roughly the last few seconds of action
// leading into the kill; the explode beat lingers on the wreck blast; the hold beat runs the
// RELAUNCHING countdown. The countdown length is authoritative from the server (myRespawnIn), but we
// always aim to give the player the requested ~3s relaunch window.
const KC_REPLAY_DUR = 3.0;   // seconds of recorded action replayed before the death
const KC_EXPLODE_DUR = 1.0;  // seconds lingering on the wreck explosion
// Rolling ring buffer of recent player CAMERA poses (pos + quat), recorded each alive MP frame, so
// the kill-cam can replay the run-up to the kill from the exact angle the player was flying it.
const _kcBuf = [];
const _KC_BUF_SECONDS = 4.2;         // keep a touch more than the replay window
function recordKillCamPose() {
  // Sample at ~30 Hz — plenty for a smooth playback without hoarding frames.
  const now = performance.now();
  const last = _kcBuf.length ? _kcBuf[_kcBuf.length - 1].t : 0;
  if (now - last < 33) return;
  _kcBuf.push({
    t: now,
    px: camera.position.x, py: camera.position.y, pz: camera.position.z,
    qx: camera.quaternion.x, qy: camera.quaternion.y, qz: camera.quaternion.z, qw: camera.quaternion.w,
  });
  // Trim anything older than the buffer window.
  const cutoff = now - _KC_BUF_SECONDS * 1000;
  while (_kcBuf.length > 2 && _kcBuf[0].t < cutoff) _kcBuf.shift();
}
const _kcArcLen = 364.4;   // circumference of the r=58 SVG ring (must match index.html)
let respawnChase = false;  // true during the respawn arrival so the camera frames a 3rd-person warp-in
let _respawnChaseSnap = false;  // one-shot: snap (not lerp) the chase rig on the first respawn frame
// Called every Free Flight frame while connected. Detects death/respawn edges and, while alive,
// records the pose buffer so a future kill-cam can replay the run-up. While dead, drives the
// phased kill-cam (replay -> explode -> relaunch hold) + respawn HUD.
function updateFreeFlightDeath(dt) {
  const alive = multiplayer.myAlive;
  if (killCam.wasAlive && !alive) enterKillCam();     // just died
  else if (!killCam.wasAlive && alive) exitKillCam(); // just respawned
  killCam.wasAlive = alive;
  if (alive && !killCam.active) recordKillCamPose();  // keep the run-up buffer fresh while flying
  if (killCam.active) updateKillCam(dt);
}
// Enter the kill-cam: record the death site + killer, drop the cockpit HUD (.third), release any
// target lock, and open on the EXPLODE beat so the wreck blast fires immediately for a clear
// "your ship was destroyed" read before the camera pulls out to the 3rd-person orbit.
function enterKillCam() {
  killCam.active = true;
  // Open on the EXPLODE beat: fire the wreck blast at the death site right away so the pilot gets an
  // immediate "your ship just blew up" read, then the camera pulls out to the 3rd-person orbit for
  // the kill cam + RELAUNCHING countdown. (No first-person pose replay — that read as awkward
  // backwards flight; the explosion + external orbit sells the kill far better.)
  killCam.phase = 'explode';
  killCam.phaseT = 0;
  killCam.replayIdx = 0;
  killCam.exploded = false;
  killCam.angle = 0;
  killCam.lastShown = -1;
  killCam.center.copy(player.position);
  killCam.killerId = multiplayer.myLastKiller || '';
  killCam.killerName = killCam.killerId ? killerNameFor(killCam.killerId) : '';
  // Present as an EXTERNAL cinematic, not "still sitting in the seat": add .third so the cockpit
  // frame, system-power/target panels, reticle, and scope all drop away — the dead pilot is now
  // watching their own wreck from outside, exactly like a chase shot.
  ui.classList.add('third');
  // A destroyed ship's targeting is dead: release the lock, silence the lock tone, and clear the
  // acquisition progress so no brackets/lock indicator linger on the kill-cam.
  _lockedEnemy = null;
  lockProgress = 0; missileLocked = false;
  audio.stopLockTone();
  // Hide our own hull for the replay/explode beats so the wreck framing / killer reads cleanly.
  const hull = player.userData.modelHolder; if (hull) hull.visible = false;
  const dome = player.userData.shieldDome; if (dome) dome.visible = false;
  const el = $('killCam'); if (el) el.classList.add('show');
  refreshKillCamOverlay();
}
// First buffer index for the replay: KC_REPLAY_DUR seconds back from the freshest sample.
function replayStartIndex() {
  if (!_kcBuf.length) return 0;
  const cutoff = _kcBuf[_kcBuf.length - 1].t - KC_REPLAY_DUR * 1000;
  let i = 0;
  while (i < _kcBuf.length - 1 && _kcBuf[i].t < cutoff) i++;
  return i;
}
// Skip the cinematic beats and jump straight to the relaunch hold (the countdown still obeys the
// server). Wired to the kill-cam Skip button and a key press.
function skipKillCam() {
  if (!killCam.active || killCam.phase === 'hold') return;
  if (!killCam.exploded) fireWreckBlast();
  killCam.phase = 'hold';
  killCam.phaseT = 0;
  killCam.lastShown = -1;
  refreshKillCamOverlay();
}
// The one-time wreck explosion at the death site.
function fireWreckBlast() {
  killCam.exploded = true;
  explode(explosions, killCam.center.clone(), 0xffb347, 2.0);
  audio.play('explosion', 0.6);
}
// Swap the overlay text + Skip button visibility to match the current phase.
function refreshKillCamOverlay() {
  const kk = $('kcKiller');
  if (kk) kk.textContent = killCam.killerName ? `DESTROYED BY ${killCam.killerName}` : '';
  const ring = $('kcRing'), sub = $('kcSub'), skip = $('kcSkip'), banner = $('kcBanner');
  const holding = killCam.phase === 'hold';
  if (ring) ring.style.visibility = holding ? 'visible' : 'hidden';
  if (sub) sub.textContent = holding ? 'RELAUNCHING' : '';
  if (skip) skip.style.display = holding ? 'none' : 'block';
  if (banner) banner.textContent = 'SHIP DESTROYED';
}
// Leave the kill-cam on respawn: restore the hull, hide the overlay, and present the arrival as a
// 3rd-person warp-in (like a mission warp-in) — the camera frames the ship streaking in via
// respawnChase, with the hyperspace veil + this hull's warp signature.
let _respawnWarpT = null;
function exitKillCam() {
  killCam.active = false;
  killCam.phase = 'idle';
  const el = $('killCam'); if (el) el.classList.remove('show');
  const skip = $('kcSkip'); if (skip) skip.style.display = 'none';
  // 3rd-person warp-in arrival: force the chase framing for the veil's duration, then restore the
  // player's real view. respawnChase is read by updateCamera (chaseShot) to frame the ship from behind.
  respawnChase = true;
  // SNAP the chase rig into place on the first respawn frame instead of lerping across the arena from
  // wherever the kill-cam orbit left the camera — that long swing was what read as the ship "flying
  // awkwardly backwards" into view. Snapping puts the camera directly behind the fresh spawn so the
  // ship streaks straight AWAY down its nose, just like the mission-start warp-in arrival.
  _respawnChaseSnap = true;
  ui.classList.add('third');
  // Clear any stale trail history from the previous life so the exhaust ribbon can't span the map
  // from the death site to the new spawn on the first arrival frame.
  if (player.userData.engines) for (const eng of player.userData.engines) {
    if (eng.trail && eng.trail.userData) eng.trail.userData.history.length = 0;
  }
  const hull = player.userData.modelHolder; if (hull) hull.visible = true;
  // Fresh life = fresh loadout. Missiles are SERVER-authoritative in the arena (respawnShip refills
  // the rack there), so we only reset the client-owned chaff here; the replicated myMissiles count
  // already reflects the server's fresh rack.
  state.chaff = state.maxChaff;
  playRespawnWarp();
  flash('WARPING IN');
  resetScaaviAlerts();   // fresh life at full hull/shields — clear latched combat barks
  _kcBuf.length = 0;     // start a fresh run-up recording for the new life
}
// Show the full-screen respawn warp veil for its animation length (~1.7s), then hide it and drop the
// 3rd-person chase presentation back to the player's chosen view. Fires the flown hull's warp audio.
function playRespawnWarp() {
  const rw = $('respawnWarp');
  audio.playShipWarp(currentHullId(), 0.7);
  clearTimeout(_respawnWarpT);
  _respawnWarpT = setTimeout(() => {
    if (rw) rw.classList.remove('show');
    respawnChase = false;
    ui.classList.toggle('third', view === 'third');   // restore the pilot's real view
  }, 1700);
  if (!rw) return;
  rw.classList.remove('show');
  void rw.offsetWidth;   // restart the CSS animation if respawns come quickly
  rw.classList.add('show');
}
// Phased cinematic kill-cam while dead:
//   replay  — play back the recorded last ~3s of the player's own camera, showing the run-up to death
//   explode — linger on the wreck blast at the death site
//   hold    — frame the wreck / killer and run the RELAUNCHING countdown (server-authoritative)
function updateKillCam(dt) {
  killCam.phaseT += dt;
  camera.up.set(0, 1, 0);

  if (killCam.phase === 'replay') {
    // Advance the playback cursor through the recorded poses and drive the camera straight from them.
    const buf = _kcBuf;
    if (buf.length > 1) {
      // Map elapsed replay time onto the recorded timeline from replayStartIndex to the end.
      const startT = buf[killCam.replayIdx] ? buf[killCam.replayIdx].t : buf[0].t;
      const targetT = startT + killCam.phaseT * 1000;
      while (killCam.replayIdx < buf.length - 1 && buf[killCam.replayIdx + 1].t <= targetT) killCam.replayIdx++;
      const a = buf[killCam.replayIdx];
      const b = buf[Math.min(buf.length - 1, killCam.replayIdx + 1)];
      const span = Math.max(1, b.t - a.t);
      const f = THREE.MathUtils.clamp((targetT - a.t) / span, 0, 1);
      camera.position.set(
        THREE.MathUtils.lerp(a.px, b.px, f),
        THREE.MathUtils.lerp(a.py, b.py, f),
        THREE.MathUtils.lerp(a.pz, b.pz, f));
      _kcQa.set(a.qx, a.qy, a.qz, a.qw);
      _kcQb.set(b.qx, b.qy, b.qz, b.qw);
      _kcQa.slerp(_kcQb, f);
      camera.quaternion.copy(_kcQa);
    }
    // Replay ends when we run out of buffer OR the beat times out — then the wreck blows.
    const atEnd = killCam.replayIdx >= _kcBuf.length - 1;
    if (killCam.phaseT >= KC_REPLAY_DUR || atEnd) {
      fireWreckBlast();
      killCam.phase = 'explode';
      killCam.phaseT = 0;
      refreshKillCamOverlay();
    }
    return;
  }

  // From here on we frame the death site (wreck) — used by both the explode beat and the hold.
  killCam.angle += dt * 0.32;   // slow cinematic drift
  const focus = killCam.center;
  const killerPos = killCam.killerId ? multiplayer.remotePosition(killCam.killerId) : null;
  if (killerPos) {
    // SHOW-THE-KILL framing: sit behind the wreck relative to the killer, looking across at them.
    _kcToKiller.subVectors(killerPos, focus);
    const dist = _kcToKiller.length() || 1;
    _kcToKiller.multiplyScalar(1 / dist);
    const standoff = THREE.MathUtils.clamp(dist * 0.35, 14, 42);
    _kcRight.set(-_kcToKiller.z, 0, _kcToKiller.x).normalize();
    const arc = Math.sin(killCam.angle) * standoff * 0.5;
    _kcDesired.copy(focus)
      .addScaledVector(_kcToKiller, -standoff)
      .addScaledVector(_kcRight, arc)
      .add(_kcUp0.set(0, standoff * 0.28 + 6, 0));
    _kcLook.copy(killerPos).lerp(focus, 0.22);
    camera.position.lerp(_kcDesired, 1 - Math.pow(0.0025, dt));
    camera.lookAt(_kcLook);
  } else {
    const radius = 26, height = 9;
    const cx = focus.x + Math.cos(killCam.angle) * radius;
    const cz = focus.z + Math.sin(killCam.angle) * radius;
    _kcDesired.set(cx, focus.y + height, cz);
    camera.position.lerp(_kcDesired, 1 - Math.pow(0.002, dt));
    camera.lookAt(focus);
  }

  if (killCam.phase === 'explode') {
    if (!killCam.exploded) fireWreckBlast();   // one-time death blast at the wreck site
    if (killCam.phaseT >= KC_EXPLODE_DUR) {
      killCam.phase = 'hold';
      killCam.phaseT = 0;
      killCam.lastShown = -1;
      refreshKillCamOverlay();
    }
    return;
  }

  // ---- Relaunch countdown (hold) ----
  // Prefer the server's authoritative respawn seconds; if it hasn't streamed yet, count our own ~3s.
  const RELAUNCH_TOTAL = 3;
  const serverSecs = multiplayer.myRespawnIn;
  const secs = serverSecs > 0.001
    ? Math.min(RELAUNCH_TOTAL, serverSecs)
    : Math.max(0, RELAUNCH_TOTAL - killCam.phaseT);
  const frac = Math.min(1, secs / RELAUNCH_TOTAL);
  const arc = $('kcArc');
  if (arc) arc.style.strokeDashoffset = String(_kcArcLen * (1 - frac));
  const shown = Math.max(1, Math.ceil(secs));
  if (shown !== killCam.lastShown) {
    killCam.lastShown = shown;
    const c = $('kcCount'); if (c) c.textContent = String(shown);
    audio.play('shield', 0.14);   // soft tick per second
  }
}
// Resolve the killer's display call-sign (live remote or scoreboard snapshot), with a fallback.
function killerNameFor(sessionId) {
  return multiplayer.pilotName(sessionId) || 'ENEMY ACE';
}
const _kcDesired = new THREE.Vector3();
const _kcToKiller = new THREE.Vector3();
const _kcRight = new THREE.Vector3();
const _kcUp0 = new THREE.Vector3();
const _kcLook = new THREE.Vector3();
const _kcQa = new THREE.Quaternion();   // kill-cam replay: interpolated pose quaternion
const _kcQb = new THREE.Quaternion();

// Map a system's power fraction (default 1/3) to a performance multiplier centred on 1.0, so the
// default even split is neutral, dumping power in makes a system stronger, and starving it makes it
// weaker. GAIN sets how dramatic the swing is; the routing upgrade card widens it further. At full
// tilt (~80% of one system, other two at the floor) this yields ~1.6x, and ~0.85x when starved.
function routeBonus(system) {
  const frac = state.power[system];
  const gain = 1.35 + state.mods.routing;
  return 1 + (frac - 1 / 3) * gain;
}
// Fraction of incoming damage the shields actually soak per point of charge spent. More power to
// shields = each shield point absorbs more (so the deflectors take less net damage from a hit).
// Centred so the default even split is 1.0; ranges ~0.78x (starved) .. ~1.3x (overcharged).
function shieldAbsorbBonus() {
  return 1 + (state.power.shields - 1 / 3) * (0.9 + state.mods.routing);
}
const _qDelta = new THREE.Quaternion();
const _eDelta = new THREE.Euler(0, 0, 0, 'XYZ');
// Mission 3 player-leash scratch (pull-back toward O.G. + auto-circle the nose to face him).
const _ogLeash = new THREE.Vector3(), _ogLeashLook = new THREE.Vector3();
const _ogLeashMat = new THREE.Matrix4(), _ogLeashQuat = new THREE.Quaternion();
function updatePlayer(dt) {
  const held = id => settings.bindings[id].some(code => code && keys.has(code));
  // ---- Free 360° flight model ----
  // The mouse offset (mouse.x/y) is a steering input that maps to a pitch/yaw turn RATE. We
  // rotate the ship INCREMENTALLY about its OWN local axes each frame and never clamp the
  // resulting attitude, so the ship can loop, roll, and point any direction in open space —
  // no artificial floor/ceiling. Roll comes from the strafe keys for banking turns.
  // Routing power to ENGINES tightens the turn — pitch/yaw/roll all scale with the engine bonus, so
  // an engine-heavy split flies markedly more agile and a starved one handles sluggishly.
  const turnMod = routeBonus('engines');
  const TURN = 2.6 * turnMod;                        // max pitch/yaw rate (rad/s) at full deflection
  const ROLL = 2.2 * turnMod;                        // roll rate (rad/s) from bank keys
  const pitchRate = -mouse.y * TURN;                 // mouse up/down -> pitch about local X
  const yawRate   = -mouse.x * TURN;                 // mouse left/right -> yaw about local Y
  let rollRate = 0;
  if (held('strafeLeft'))  rollRate += ROLL;         // bank left
  if (held('strafeRight')) rollRate -= ROLL;         // bank right
  // FLIGHT SCHOOL: note when the player exercises each movement control so the tutorial can advance
  // its step-by-step prompts. A small grace period after warp-in keeps residual arrival motion /
  // mouse-recenter from auto-satisfying the aim step.
  if (tutorialMode && tutorial.active) {
    _tutorialStartT += dt;
    if (_tutorialStartT > 0.6) {
      if (Math.abs(mouse.x) > 0.06 || Math.abs(mouse.y) > 0.06) tutorial.notifyAxis('aim');
      if (held('thrust') || held('reverse')) tutorial.notifyAxis('throttle');
      if (held('strafeLeft') || held('strafeRight')) tutorial.notifyAxis('roll');
      if (held('boost')) tutorial.notifyBoost();
    }
  }
  _eDelta.set(pitchRate * dt, yawRate * dt, rollRate * dt, 'XYZ');
  _qDelta.setFromEuler(_eDelta);
  player.quaternion.multiply(_qDelta).normalize();   // apply in LOCAL space (post-multiply)
  // Self-center the steering offset so the ship holds its attitude when the mouse stops moving,
  // instead of drifting. Decays mouse.x/y toward 0 each frame. Skip the decay when the gamepad
  // stick set the offset this frame, otherwise it would immediately fight the stick back to centre
  // (the stick already writes an absolute offset that returns to 0 when released).
  if (!gamepadSteered) {
    // Self-center the steering offset toward 0 each frame so a still mouse holds attitude instead of
    // drifting. This fast decay already recenters within a frame or two when movement stops.
    const recenter = Math.pow(0.0009, dt);
    mouse.x *= recenter; mouse.y *= recenter;
    // Idle watchdog (SAFETY NET): if no REAL mouse movement has arrived for a while, hard-snap the
    // offset to exactly 0. Guards the "free spinning" case where a mouse/driver streams stale or
    // noisy deltas that pin the offset to the rail. The window is generous (250ms) so it never fights
    // genuine slow movement on low-polling mice — real flying refreshes lastMouseMoveT every event.
    if (mouse.locked && (performance.now() - lastMouseMoveT) > 250) {
      mouse.x = 0; mouse.y = 0;
    }
  }
  aim.x = mouse.x; aim.y = mouse.y;

  // Forward = the ship's VISIBLE nose, which is local -Z (matching the cutscene + the oriented
  // model). getWorldDirection returns local +Z, so we must NOT use it for the nose here.
  forward.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();
  const accel = new THREE.Vector3();
  if (held('thrust')) accel.add(forward);
  if (held('reverse')) accel.addScaledVector(forward, -.65);
  const boost = held('boost');
  const speedMod = (1 + state.mods.engineSpeed) * routeBonus('engines') * (boost ? 1.55 + state.mods.boostEfficiency : 1);
  if (accel.lengthSq()) player.userData.vel.add(accel.normalize().multiplyScalar(70 * speedMod * dt));
  // Drag. When NOT thrusting, the ship coasts down toward rest so it can actually sit idle
  // (which is what makes the speed-debris field go calm). When thrusting, very light drag so the
  // ship can actually reach near its top speed (thrust/drag terminal ~= cap), instead of plateauing
  // at a third of max. When coasting, strong drag bleeds speed to a true idle.
  const drag = accel.lengthSq() ? 0.28 : 1.8;
  player.userData.vel.addScaledVector(player.userData.vel, -drag * dt);
  // Snap tiny residual velocity to a dead stop so a COASTING ship truly becomes idle (no min
  // floor — the old 14 u/s minimum kept debris streaming even when the player wasn't moving).
  // Only when NOT thrusting: otherwise this snap would zero out the small velocity the first few
  // thrust frames build from a standstill, making W feel dead.
  if (!accel.lengthSq() && player.userData.vel.lengthSq() < 1) player.userData.vel.set(0, 0, 0);
  if (player.userData.vel.length() > 74 * speedMod) player.userData.vel.setLength(74 * speedMod);
  player.position.addScaledVector(player.userData.vel, dt);
  // Open-space boundary. Kept VERY permissive so it never fights an ordinary pursuit: only a
  // gentle restoring nudge, and only once the ship is genuinely far out. The old 240m pull was so
  // close and so strong it decelerated the ship mid-chase even while holding thrust. Mission 2
  // stages its engagement ~3km downrange, so its boundary is pushed out past the fight (otherwise
  // the restoring force fought the player's thrust the whole way to the enemy, reading as "can't
  // accelerate"); other missions keep the tight 1500m leash.
  if (mission3Active() && protectOG && allies.children.includes(protectOG)) {
    // Mission 3 leash: keep the player near the damaged O.G. Stray past ~1000m from him and the
    // ship is gently pulled BACK and its nose is smoothly steered around to point at O.G./the
    // battle, so the player can't wander off and abandon the man they're protecting.
    const OG_LEASH = 1000;
    _ogLeash.copy(protectOG.position).sub(player.position);   // vector from player -> O.G.
    const distToOG = _ogLeash.length();
    if (distToOG > OG_LEASH) {
      const back = _ogLeash.clone().multiplyScalar(1 / Math.max(distToOG, 1e-4));   // unit toward O.G.
      // Velocity nudge back toward O.G., scaling with how far out the player has strayed.
      player.userData.vel.addScaledVector(back, (distToOG - OG_LEASH) * 0.6 * dt);
      // Auto-circle the nose around toward O.G. so the player is turned to face the fight. Strength
      // ramps with distance so it's a gentle assist near the edge and a firm correction far out.
      const turn = THREE.MathUtils.clamp((distToOG - OG_LEASH) / 1400, 0.15, 1);
      _ogLeashLook.copy(player.position).add(back);   // a point one unit toward O.G. (nose target)
      _ogLeashMat.lookAt(player.position, _ogLeashLook, player.up);
      _ogLeashQuat.setFromRotationMatrix(_ogLeashMat);
      player.quaternion.slerp(_ogLeashQuat, 1 - Math.pow(0.06, turn * dt * 6));
    }
  } else {
    // Open-space boundary. Kept VERY permissive so it never fights an ordinary pursuit: only a
    // gentle restoring nudge, and only once the ship is genuinely far out. Mission 2 stages its
    // engagement ~3km downrange, so its boundary is pushed out past the fight; other missions keep
    // the tight 1500m leash.
    const boundary = mission2Active() ? 9000 : 1500;
    const distFromCenter = player.position.length();
    if (distFromCenter > boundary) {
      const pull = player.position.clone().multiplyScalar(-1 / distFromCenter);
      player.userData.vel.addScaledVector(pull, (distFromCenter - boundary) * 0.5 * dt);
    }
  }
  // In multiplayer the SERVER owns hull/shields (mirrored onto state each frame in the loop), so
  // the local shield/hull regen + SCAAVI monitor here are single-player only. The MP block runs its
  // own SCAAVI monitor off the authoritative server values.
  if (!multiplayer.connected) {
    state.shields = Math.min(state.maxShields, state.shields + (4.5 + state.mods.shieldRegen * 7) * routeBonus('shields') * dt);
    // Slow hull self-repair, but ONLY once shields are back to full — the hull nanite repair can't
    // work while the shield emitters are still drawing the reserve, so damaged plating recovers a
    // little each second between engagements once shields have fully recharged.
    if (state.shields >= state.maxShields - 0.01 && state.hull < 100) {
      state.hull = Math.min(100, state.hull + 2.2 * dt);
    }
    // Per-frame SCAAVI / Crimson SCAAVI monitor (single-player). Drives the "shields recharged"
    // line as shields climb back to full; the shields-failing / hull-damage edges also latch here
    // as a safety net between hit events.
    updateScaaviAlerts(state.maxShields > 0 ? state.shields / state.maxShields : 0, state.hull / 100);
  }
  state.energy = Math.min(100, state.energy + 18 * routeBonus('weapons') * dt);
  state.heat = Math.max(0, state.heat - 24 * dt);
  fireCooldown -= dt;
  // Fire if any binding for the 'fire' action is held — keyboard keys (keys set) or mouse buttons
  // (mouseHeld set). Default fire bindings are Space + Left Mouse, both rebindable in Settings.
  if (settings.bindings.fire.some(code => code && (keys.has(code) || mouseHeld.has(code)))) fire();
  updateMissileLock(dt);
}
// Advance the missile-lock timer. Lock requires the player to keep the currently LOCKED enemy
// (the one in the scope) framed inside the reticle: i.e. its screen projection lands within the
// reticle's radius and it's ahead of the camera. Progress climbs while held there and decays
// (faster) when it drifts out, so a fleeing/evading target can break the lock.
const _lockProj = new THREE.Vector3();
function updateMissileLock(dt) {
  const t = closestTarget();
  // No target, OR the selected contact is a friendly ALLY (never missile-lockable): kill the lock
  // immediately and silence the cue this frame, rather than letting it decay/ring on a friendly.
  if (!t || t.isAlly) {
    if (lockProgress > 0 || missileLocked) { lockProgress = 0; missileLocked = false; }
    audio.stopLockTone();
    return;
  }
  // ENGAGEMENT RANGE: a lock can't even be acquired beyond MISSILE_LOCK_RANGE. Past that the seeker
  // never grabs, no matter how well the contact is framed — treat it exactly like "not in reticle"
  // so any partial progress decays away.
  const inRange = t.d <= MISSILE_LOCK_RANGE;
  let inReticle = false;
  if (t && inRange) {
    _lockProj.copy(t.wp).project(camera);
    if (_lockProj.z < 1) {
      const sx = (_lockProj.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-_lockProj.y * 0.5 + 0.5) * window.innerHeight;
      const r = _reticleEl.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Generous reticle capture radius (in px) so the player can hold a maneuvering target.
      inReticle = Math.hypot(sx - cx, sy - cy) < Math.max(70, r.width * 0.9);
    }
  }
  if (inReticle) {
    const was = missileLocked;
    lockProgress = Math.min(LOCK_TIME, lockProgress + dt);
    if (lockProgress >= LOCK_TIME) { missileLocked = true; if (!was) { audio.play('shield', 0.4); flash('MISSILE LOCK'); } }
  } else {
    lockProgress = Math.max(0, lockProgress - dt * 1.6);
    if (lockProgress <= 0) missileLocked = false;
  }
  // Drive the audible lock cue: an accelerating acquisition beep while the lock builds, switching
  // to a steady "flat-line" solid tone once locked. Silenced when there's no progress / no lock.
  audio.updateLockTone(lockProgress / LOCK_TIME, missileLocked);
}
// Unproject the on-screen reticle's centre to a far world point along the camera ray, so
// first-person lasers can be aimed to visibly converge through the reticle. Returns a world
// Vector3 well ahead of the camera, or null if the reticle isn't on screen.
const _reticleEl = $('reticle');
function reticleAimPoint() {
  const r = _reticleEl.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const ndcX = (cx / window.innerWidth) * 2 - 1;
  const ndcY = -(cy / window.innerHeight) * 2 + 1;
  // Point on the far plane through the reticle, then placed at a fixed convergence range so
  // bolts cross at a believable distance ahead rather than chasing infinity.
  const p = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera);
  const ray = p.sub(camera.position).normalize();
  return camera.position.clone().addScaledVector(ray, 600);
}
// A SAFE convergence point for firing. The raw reticle aim-point is unprojected from the chase
// camera (which sits behind/above the ship), so from a wide-set muzzle the line to that point can
// angle hard sideways/up — bolts splay off the nose instead of going forward (the diagonal streak
// bug). Only use the reticle point when it's genuinely AHEAD of the ship's nose (dot with forward
// well positive); otherwise return null so the caller fires straight down the nose. This keeps
// reticle-accurate fire when aiming at something ahead, without the wild off-axis shots.
function safeAimPoint() {
  const ap = reticleAimPoint();
  if (!ap) return null;
  const toAim = _aimTmp.copy(ap).sub(player.position);
  const dist = toAim.length();
  if (dist < 1) return null;
  toAim.multiplyScalar(1 / dist);                  // normalise
  // forward is set to the visible nose (-Z) just before fire() calls this.
  return toAim.dot(forward) > 0.9 ? ap : null;     // within ~25° of dead ahead
}
const _aimTmp = new THREE.Vector3();
// FIRST-PERSON EYE TRICK (purely visual — muzzles/damage untouched):
// In cockpit view the camera sits inside the ship, so the real wing muzzles render right at screen
// centre and bolts look like they spill from the nose. To make the lasers read as coming from the
// wing cannons out at the canopy corners, we don't move any muzzle — we just spawn the VISIBLE
// tracer from a point unprojected at the lower-left / lower-right of the screen, a short distance
// ahead of the camera, then aim it at the same reticle convergence point. So the bolt still flies
// to where you're pointing; it merely appears to leave the cannons low and wide like the screenshot.
// NDC corners: x = ±0.78 (wide, just inside the canopy struts), y = -0.62 (down near the dash).
// QUAD link: four cannons — an inner pair and a wider outer pair — so cockpit fire matches the
// "LASER LINK: QUAD" readout and the third-person model's four bolts.
const _fpMuzzleNDC = [[-0.78, -0.62], [-0.4, -0.52], [0.4, -0.52], [0.78, -0.62]];
function firstPersonVisualOrigins() {
  const out = [];
  for (const [nx, ny] of _fpMuzzleNDC) {
    const p = new THREE.Vector3(nx, ny, 0.5).unproject(camera);
    const ray = p.sub(camera.position).normalize();
    // Push the spawn ~6 units ahead so the tracer starts past the canopy glass, not on the lens.
    out.push(camera.position.clone().addScaledVector(ray, 6));
  }
  return out;
}
function fire() {
  // Dead in the arena: no shooting during the kill-cam / respawn window (the server rejects the
  // fire intent too, but this also suppresses the responsive local tracer + laser SFX).
  if (killCam.active) return;
  const wBonus = routeBonus('weapons');
  const rate = .22 / (1 + state.mods.weaponRecharge) / wBonus;
  if (fireCooldown > 0 || state.energy < 6 || state.heat > 96) return;
  // Overclocked cooling: routing power to WEAPONS overclocks the heat sinks, so each shot adds less
  // heat (and the bank refires faster above). Starve weapons and shots run hot fast.
  fireCooldown = rate; state.energy -= 6; state.heat += 7.5 / wBonus;
  // Fire down the VISIBLE nose (local -Z), matching the muzzle anchors at the nose plane.
  forward.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();
  player.updateMatrixWorld();
  const muzzles = player.userData.muzzles;
  // More power to WEAPONS = more potent bolts (and less heat per shot, above).
  const dmg = 21 * (1 + state.mods.damage) * difficultyMods().playerDamage * wBonus;
  // Aiming TRICK (BOTH views): the on-screen reticle and the ship's muzzles don't share a line, so
  // bolts fired straight down the nose read as off the reticle — and in CHASE view the camera sits
  // behind/above the ship, so nose-forward bolts would never converge on what's centred on screen
  // (this is why generators couldn't be hit in third person). Unproject the reticle's screen point to
  // a far world aim-point and converge every bolt toward it, so lasers cross the reticle in any view.
  // Use the reticle convergence point only when it's safely ahead of the nose (see safeAimPoint),
  // so chase-view bolts can't splay off sideways when nothing's lined up — they fall back to firing
  // straight down the nose (forward) instead.
  const aimPoint = safeAimPoint();
  // MULTIPLAYER tracer color is TEAM-ABSOLUTE: a red-team pilot's own bolts render red for everyone,
  // matching the color remote clients render for that shooter (see NetBolt). Single-player keeps the
  // classic cyan player bolt (colorTeam = null lets makeBolt follow the friendly flag).
  const colorTeam = (freeFlightMode && multiplayer.connected) ? multiplayer.myTeam : null;
  // Ship-Hangar laser-color cosmetic: tint the player's OWN visible tracers to their equipped color.
  // (These local tracers are visual feedback only; the authoritative server bolt is separate, so
  // this never affects hit behavior or what color other clients see for the server's damage bolt.)
  const laserCol = (_playerCosmetics && _playerCosmetics.laserColor != null) ? _playerCosmetics.laserColor : null;
  if (view === 'first') {
    // COCKPIT EYE TRICK: spawn the visible tracers from the lower screen corners (where the wing
    // cannons read) instead of the real muzzles, which would render at screen-centre from inside the
    // ship. Four origins to match the QUAD link. Purely a visual origin shift; muzzles untouched.
    for (const origin of firstPersonVisualOrigins()) {
      const dir = aimPoint ? aimPoint.clone().sub(origin).normalize() : forward.clone();
      boltGroup.add(makeBolt(origin, dir, true, dmg, colorTeam, laserCol));
    }
  } else if (muzzles && muzzles.length) {
    // Project lasers from the forward-most tip of each cannon, in world space.
    for (const m of muzzles) {
      const worldPos = m.clone().applyMatrix4(player.matrixWorld);
      const dir = aimPoint ? aimPoint.clone().sub(worldPos).normalize() : forward.clone();
      boltGroup.add(makeBolt(worldPos, dir, true, dmg, colorTeam, laserCol));
    }
  } else {
    const right = new THREE.Vector3().crossVectors(forward, player.up).normalize().multiplyScalar(-1);
    for (const s of [-1, 1]) {
      const pos = player.position.clone().addScaledVector(right, s * .8).addScaledVector(forward, 2.5);
      const dir = aimPoint ? aimPoint.clone().sub(pos).normalize() : forward.clone();
      boltGroup.add(makeBolt(pos, dir, true, dmg, colorTeam, laserCol));
    }
  }
  audio.play('laser', .34);
  // In the multiplayer arena, also send fire intent to the authoritative server (which spawns the
  // real damage-dealing bolt and does hit detection). The local makeBolt tracers above are just
  // responsive visual feedback; the server bolt is what other players see and what can hit them.
  if (freeFlightMode && multiplayer.connected) multiplayer.fire();
  if (tutorialMode && tutorial.active) tutorial.notifyFired();   // flight-school: lasers exercised
}
// Fire one player missile down the nose. If a full missile lock is held it seeks the locked
// enemy; otherwise it's a dumb-fire shot that flies dead straight. Consumes one missile from the
// limited loadout. Firing always spends the current lock (it's "used up" on the shot).
function fireMissile() {
  if (!mission || warping || warpingIn) return;
  // MULTIPLAYER: the arena is server-authoritative for missiles AND ammo. Send the fire intent + our
  // locked target's sessionId; the server validates the rack has a round, spends it, spawns the
  // homing warhead, streams it to everyone (NetMissile), and does the damage. We DON'T spawn a local
  // missile or decrement locally — the replicated `myMissiles` count is server truth (a tampered
  // client can't grant itself ammo). We only pre-check it to give instant "NO MISSILES" feedback.
  if (freeFlightMode && multiplayer.connected) {
    if (killCam.active) return;   // no launching during the death/respawn window
    if ((multiplayer.myMissiles || 0) <= 0) { flash('NO MISSILES'); audio.play('shield', 0.18); return; }
    const t = closestTarget();
    const seekGroup = (missileLocked && t && isRemoteContact(t.e)) ? t.e : null;
    multiplayer.fireMissile(seekGroup);   // server decrements the authoritative rack on a valid launch
    audio.play('explosion', 0.3);
    flash(seekGroup ? 'FOX-2 · SEEKING' : 'FOX-1 · BALLISTIC');
    lockProgress = 0; missileLocked = false;
    return;
  }
  if (state.missiles <= 0) { flash('NO MISSILES'); audio.play('shield', 0.18); return; }
  state.missiles--;
  forward.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();
  const start = player.position.clone().addScaledVector(forward, 3);
  const t = closestTarget();
  const seek = (missileLocked && t) ? t.e : null;
  // Missile warhead damage: base scaled by the general damage mod, the missile-specific damage mod
  // (from the missile upgrade cards), and the difficulty's player-damage factor.
  const missileDmg = 150 * (1 + state.mods.damage + state.mods.missileDamage) * difficultyMods().playerDamage;
  const missileAccent = (_playerCosmetics && _playerCosmetics.missileAccent != null) ? _playerCosmetics.missileAccent : null;
  const mObj = makeMissile(start, forward, true, seek, missileDmg, missileAccent);
  // Launch-range evasion: bake the seeker's turn authority from the distance to the target at the
  // moment of launch. A close shot is agile (hard to shake); a long shot is sluggish (easy to out-turn).
  if (seek && t) mObj.userData.turn = missileTurnForRange(t.d);
  missileGroup.add(mObj);
  audio.play('explosion', 0.3);   // launch whoosh stand-in
  flash(seek ? 'FOX-2 · SEEKING' : 'FOX-1 · BALLISTIC');
  // Spending the lock on the shot: reset so the next missile needs a fresh lock.
  lockProgress = 0; missileLocked = false;
  if (tutorialMode && tutorial.active) tutorial.notifyMissileFired();   // flight-school: missile fired
}
// ---- Multiplayer voice comms (push-to-talk + squad channel) ----------------------------------
// Two layers work together here: PRESENCE (multiplayer.setTalking reports the mic-open state to the
// Colyseus server so every pilot's speaking brackets light up) and AUDIO (voice.setMicEnabled flips
// the live LiveKit mic track on/off). The audio layer no-ops gracefully when LiveKit isn't
// configured or the mic was denied, so the indicators still work standalone.
// Open the mic: only meaningful in a connected arena match and while alive/flying. Flashes the HUD
// with the active channel so the pilot knows whether they're on TEAM or SQUAD.
function startPushToTalk() {
  if (!(freeFlightMode && multiplayer.connected)) return;
  if (!multiplayer.myAlive || killCam.active) return;
  if (settings.voiceMode === 'vox') return;   // voice-activated: the mic opens on speech, not a key
  multiplayer.setTalking(true);   // presence: tell everyone we're transmitting (speaking brackets)
  voice.setMicEnabled(true);      // audio: unmute our live LiveKit mic track
  setVoiceHud(true);
  flash(multiplayer.mySquad ? '◉ SQUAD · MIC OPEN' : '◉ TEAM · MIC OPEN');
}
// Close the mic. Safe to call unconditionally (both layers no-op if not open / offline).
function stopPushToTalk() {
  if (settings.voiceMode === 'vox') return;   // VOX owns the mic; the key must not force it shut
  multiplayer.setTalking(false);   // presence: clear our speaking flag
  voice.setMicEnabled(false);      // audio: mute our live LiveKit mic track
  setVoiceHud(false);
}
// Toggle squad-only voice vs. full-team voice. Only in a connected match; flashes the new channel.
// Persists the choice so it survives between sessions and stays in sync with the menu switch.
function toggleSquadVoice() {
  if (!(freeFlightMode && multiplayer.connected)) return;
  const squad = multiplayer.toggleSquadVoice();
  settings.voiceSquadOnly = squad;
  saveSettings();
  updateVoiceChannelHud(squad);
  if (typeof settingsUI.syncVoice === 'function') settingsUI.syncVoice();   // keep the menu switch in sync
  flash(squad ? '◉ SQUAD VOICE ON — talking to squad only' : '◉ TEAM VOICE — talking to whole team');
  audio.play('shield', 0.25);
}
// Deploy a player chaff flare: drops a decoy behind the ship that can spoof enemy missiles that
// are currently tracking the player. Limited count.
function deployChaff() {
  if (!mission || warping || warpingIn) return;
  if (state.chaff <= 0) { flash('NO CHAFF'); audio.play('shield', 0.18); return; }
  state.chaff--;
  spawnChaff(player.position, player.userData.vel, false);
  flash('CHAFF DEPLOYED');
  audio.play('shield', 0.3);
  if (tutorialMode && tutorial.active) tutorial.notifyChaff();   // flight-school: chaff deployed
}
// Drop a chaff flare into the missile group. `enemy` flags whether it was popped by an enemy
// (so it only spoofs the player's friendly missiles) vs by the player (spoofs enemy missiles).
const _chaffVel = new THREE.Vector3();
function spawnChaff(pos, vel, enemyOwned) {
  for (let i = 0; i < 3; i++) {
    _chaffVel.copy(vel).multiplyScalar(0.4).add(new THREE.Vector3().randomDirection().multiplyScalar(8 + Math.random() * 6));
    const c = makeChaff(pos.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(1.5)), _chaffVel);
    c.userData.enemyOwned = enemyOwned;   // spoofs missiles whose `friendly` differs from owner
    missileGroup.add(c);
  }
}
// Drive guided missiles and chaff flares each frame: steer seekers toward their target, let
// chaff lure missiles off-target, run impact tests, and detonate on hit or timeout.
const _mToTarget = new THREE.Vector3(), _mVelN = new THREE.Vector3(), _mDesired = new THREE.Vector3();
const _chaffWorld = new THREE.Vector3();
const _ENEMY_FWD0Y = new THREE.Vector3(0, 1, 0);   // missile dart's local nose axis (+Y)
function updateMissiles(dt) {
  for (const m of [...missileGroup.children]) {
    const u = m.userData;
    // ---- Chaff flares ----
    if (u.isChaff) {
      m.position.addScaledVector(u.vel, dt);
      u.vel.multiplyScalar(Math.pow(0.25, dt));   // bleed velocity so it hangs in space
      u.life -= dt;
      const k = Math.max(0, u.life / u.maxLife);
      m.material.opacity = k;
      m.scale.setScalar(2.2 + (1 - k) * 2.5);
      if (u.life <= 0) missileGroup.remove(m);
      continue;
    }
    if (!u.isMissile) continue;

    u.life -= dt; u.armed = Math.max(0, u.armed - dt);
    if (u.life <= 0) { explode(explosions, m.position, u.friendly ? 0x9fe8ff : 0xff7a52, 1.0); missileGroup.remove(m); continue; }

    // ---- Chaff seduction: a tracking missile may be lured by a nearby flare of the right kind ----
    // A friendly (player) missile is spoofed by enemy-owned chaff; an enemy missile by player chaff.
    if (u.decoyT > 0) { u.decoyT -= dt; if (u.decoyT <= 0 || !u.decoy || !missileGroup.children.includes(u.decoy)) { u.decoy = null; u.decoyT = 0; } }
    // CLOSE-RANGE LOCK IMMUNITY (player missiles): a missile fired from close range gives the enemy
    // no room to spoof it — there isn't time or distance for chaff to pull it off-target. If the
    // player's missile is already within this range of its real target, it ignores enemy chaff
    // entirely, so point-blank shots can't be chaffed away. Enemy missiles keep full chaff behavior.
    const CHAFF_IMMUNE_RANGE = 70;
    let closeToTarget = false;
    if (u.friendly && u.target && (enemies.children.includes(u.target) || u.target === player)) {
      u.target.getWorldPosition(_chaffWorld);
      closeToTarget = m.position.distanceTo(_chaffWorld) < CHAFF_IMMUNE_RANGE;
    }
    if (u.target && !u.decoy && !closeToTarget) {
      for (const c of missileGroup.children) {
        if (!c.userData.isChaff) continue;
        // Enemy-owned chaff (enemyOwned=true) fools the PLAYER's missiles (friendly=true); player
        // chaff (enemyOwned=false) fools ENEMY missiles (friendly=false). So a flare only spoofs a
        // missile when its owner side matches the missile's `friendly` flag.
        if (c.userData.enemyOwned !== u.friendly) continue;
        if (m.position.distanceTo(c.position) < 60) {
          // ~55% chance to be seduced when a valid flare blooms close by.
          if (Math.random() < 0.55) {
            u.decoy = c; u.decoyT = 0.9 + Math.random() * 0.6;
            // Player chaff (enemyOwned=false) just spoofed an enemy missile (friendly=false): the
            // "Smoke & Mirrors" achievement rewards breaking a lock with chaff.
            if (!u.friendly && !c.userData.enemyOwned) awardAchievement('pacifist_chaff');
          }
          break;
        }
      }
    }

    // ---- Steering ----
    // Seek the decoy if seduced, else the assigned target, else fly straight. The missile can only
    // turn its velocity at a limited rate, so a hard-juking target (or a late lock) can be missed.
    let seekObj = u.decoy && missileGroup.children.includes(u.decoy) ? u.decoy
                : (u.target && (enemies.children.includes(u.target) || allies.children.includes(u.target) || u.target === player) ? u.target : null);
    if (seekObj) {
      seekObj.getWorldPosition(_chaffWorld);
      _mToTarget.copy(_chaffWorld).sub(m.position).normalize();
      _mVelN.copy(u.vel).normalize();
      const dot = THREE.MathUtils.clamp(_mVelN.dot(_mToTarget), -1, 1);
      const ang = Math.acos(dot);
      const maxStep = u.turn * dt;
      if (ang > 1e-3) {
        const tStep = Math.min(1, maxStep / ang);
        _mDesired.copy(_mVelN).lerp(_mToTarget, tStep).normalize();
        u.vel.copy(_mDesired).multiplyScalar(u.speed);
      }
    } else {
      u.target = null;   // lost target / never had one: keep flying straight
    }
    // Accelerate toward cruise speed and integrate.
    const sp = u.vel.length();
    if (sp < u.speed) u.vel.multiplyScalar(Math.min(1.5, u.speed / Math.max(0.01, sp)) ** (dt * 4));
    m.position.addScaledVector(u.vel, dt);
    // Orient the dart along its velocity (+Y local is the nose).
    if (u.vel.lengthSq() > 1e-4) m.quaternion.setFromUnitVectors(_ENEMY_FWD0Y, _mVelN.copy(u.vel).normalize());
    if (u.glow) u.glow.material.opacity = 0.7 + Math.random() * 0.3;

    // ---- Impact tests ----
    if (u.armed > 0) continue;
    let detonated = false;
    if (u.friendly) {
      // Player missile vs a live Dreadnought shield generator: damage the generator directly.
      let hitGen = false;
      for (const e of [...enemies.children]) {
        if (e.userData.kind === 'capital' && e.userData.shieldGens) {
          for (const sg of e.userData.shieldGens) {
            if (!sg.alive) continue;
            sg.group.getWorldPosition(_tWorldPos);
            if (m.position.distanceTo(_tWorldPos) < sg.radius + 5.5) {
              damageShieldGen(e, sg, u.damage, m.position.clone());
              hitGen = true; detonated = true; break;
            }
          }
          if (hitGen) break;
        }
      }
      // SHIELD-SURFACE DEFLECTION for missiles: while a capital's shields hold, a player missile
      // detonates ON THE DOME (radius shieldRadius) and is absorbed there with a ripple, instead of
      // punching deep to the hull. Generators were already handled above, so any missile reaching
      // here is bled off the bubble at the point it crosses it.
      if (!hitGen) for (const e of [...enemies.children]) {
        if (e.userData.kind !== 'capital' || !e.userData.shieldGens || !e.userData.shieldRadius) continue;
        const mult = capitalDamageMult(e);
        if (mult >= 1) continue;
        // React a little BEFORE the missile reaches the exact dome surface, so the shield blooms as
        // fire approaches rather than only at the moment of contact (SHIELD_REACT_MARGIN of headroom).
        if (m.position.distanceTo(e.position) > e.userData.shieldRadius + SHIELD_REACT_MARGIN) continue;
        _shieldHitPt.copy(m.position).sub(e.position);
        if (_shieldHitPt.lengthSq() < 1e-6) _shieldHitPt.set(0, 1, 0);
        _shieldHitPt.setLength(e.userData.shieldRadius).add(e.position);
        e.userData.hp -= u.damage * mult; shieldDeflect(e, _shieldHitPt.clone());
        if (e.userData.hp <= 0) killEnemy(e);
        // Detonate the missile at the dome surface so its explosion reads on the shield, not inside.
        m.position.copy(_shieldHitPt);
        detonated = true; break;
      }
      if (!hitGen && !detonated) for (const e of [...enemies.children]) {
        if (m.position.distanceTo(e.position) < e.userData.radius + 1.4) {
          // Shielded capital fallback (shields up but missile slipped the dome pass): bleed at hull.
          if (e.userData.kind === 'capital' && e.userData.shieldGens) {
            const mult = capitalDamageMult(e);
            if (mult < 1) {
              e.userData.hp -= u.damage * mult; shieldDeflect(e, m.position.clone());
              if (e.userData.hp <= 0) { e.userData._killedByMissile = true; killEnemy(e); }
              detonated = true; break;
            }
          }
          e.userData.hp -= u.damage; spark(explosions, m.position, 0x9fe8ff);
          if (e.userData.kind !== 'capital') { e.userData.panicT = 3.0; }
          else e.userData.hullHit = true;   // a shot reached the bare hull (shields down): trip the reserve scramble
          if (e.userData.hp <= 0) { e.userData._killedByMissile = true; killEnemy(e); }
          detonated = true; break;
        }
      }
    } else {
      if (m.position.distanceTo(player.position) < 2.6) { damagePlayer(34, m.position.clone()); detonated = true; }
      if (!detonated) for (const a of [...allies.children]) {
        if (a.userData.introHold) continue;   // held off-stage wingman: not hittable yet
        if (m.position.distanceTo(a.position) < a.userData.radius + 1.4) {
          damageAlly(a, u.damage); detonated = true; break;
        }
      }
    }
    if (detonated) { explode(explosions, m.position, u.friendly ? 0x9fe8ff : 0xff7a52, 1.3); missileGroup.remove(m); }
  }
}
// Swept hit test: does the bolt's travel this frame (segment from its previous position to its
// current one) pass within `radius` of the sphere centered at `center`? Prevents fast bolts from
// tunneling through small targets (shield generators) between frames. _bhA/_bhB are scratch.
const _bhSeg = new THREE.Vector3(), _bhToC = new THREE.Vector3();
function boltHitsSphere(b, dt, center, radius) {
  // Segment start = where the bolt was last frame; end = where it is now.
  _bhSeg.copy(b.userData.vel).multiplyScalar(dt);       // travel vector this frame
  const segLen2 = _bhSeg.lengthSq();
  _bhToC.copy(center).sub(b.position).add(_bhSeg);       // vector from segment START to center
  // (b.position is the END this frame; START = end - seg, so START->center = center - (pos - seg))
  if (segLen2 < 1e-6) return _bhToC.lengthSq() < radius * radius;
  // Project START->center onto the segment, clamped to [0,1], to get the closest point.
  const t = THREE.MathUtils.clamp(_bhToC.dot(_bhSeg) / segLen2, 0, 1);
  const cx = (b.position.x - _bhSeg.x) + _bhSeg.x * t;
  const cy = (b.position.y - _bhSeg.y) + _bhSeg.y * t;
  const cz = (b.position.z - _bhSeg.z) + _bhSeg.z * t;
  const dx = center.x - cx, dy = center.y - cy, dz = center.z - cz;
  return dx * dx + dy * dy + dz * dz < radius * radius;
}
// Is this player bolt still flying toward a LIVE shield generator on `capital`, close enough that it
// should be allowed to pass through the broad deflection sphere and strike the generator? Lets the
// generator-hit test (run first each frame) actually land instead of the shield swallowing the shot
// far out. We accept the bolt if it's within a working range of a live generator AND its velocity
// points at that generator (so only shots actually AIMED at a generator punch through the shield).
const _bhgToGen = new THREE.Vector3(), _bhgVelN = new THREE.Vector3();
// Scratch for projecting an incoming shot onto the shield-dome surface (ripple center).
const _shieldHitPt = new THREE.Vector3();
// How far OUTSIDE the dome surface incoming fire trips the shield deflection. Gives the bubble an
// earlier, more responsive flare as fire arrives (and catches fast bolts that would otherwise skip
// the thin surface shell between frames). The visible ripple is still projected onto the true surface.
const SHIELD_REACT_MARGIN = 16;
function boltHeadingToLiveGen(capital, b) {
  const gens = capital.userData.shieldGens;
  if (!gens) return false;
  _bhgVelN.copy(b.userData.vel).normalize();
  for (const sg of gens) {
    if (!sg.alive) continue;
    sg.group.getWorldPosition(_tWorldPos);
    _bhgToGen.copy(_tWorldPos).sub(b.position);
    const d = _bhgToGen.length();
    if (d > 120) continue;                       // generator too far to be the bolt's intended target
    if (d < sg.radius + 6.0) return true;         // essentially on it — let the hit test fire
    _bhgToGen.multiplyScalar(1 / d);
    // Heading cone tightens with distance so far shots must be well-aimed; near shots are lenient.
    const need = d < 40 ? 0.92 : 0.985;
    if (_bhgVelN.dot(_bhgToGen) > need) return true;
  }
  return false;
}
function updateBolts(dt) {
  for (const b of [...boltGroup.children]) {
    b.position.addScaledVector(b.userData.vel, dt); b.userData.life -= dt;
    if (b.userData.life <= 0) { boltGroup.remove(b); continue; }
    if (b.userData.friendly) {
      let consumed = false;
      // Dreadnought SHIELD GENERATORS take PRIORITY over turrets and the hull: a player bolt that
      // strikes a live generator damages that generator. Checked FIRST so the player can always
      // chew the generators down — turrets no longer "shadow" them. Uses a SWEPT test (the bolt's
      // travel segment this frame vs the generator sphere) so fast bolts can't tunnel past the
      // small target between frames, and a generous radius so direct shots reliably register.
      for (const e of [...enemies.children]) {
        if (e.userData.kind === 'capital' && e.userData.shieldGens) {
          for (const sg of e.userData.shieldGens) {
            if (!sg.alive) continue;
            sg.group.getWorldPosition(_tWorldPos);
            if (boltHitsSphere(b, dt, _tWorldPos, sg.radius + 6.0)) {
              damageShieldGen(e, sg, b.userData.damage, b.position.clone());
              boltGroup.remove(b); consumed = true; break;
            }
          }
          if (consumed) break;
        }
      }
      if (consumed) continue;
      // Capital ship point-defense turrets are individually destructible: a player bolt that
      // strikes a live turret damages that turret rather than the hull, so the player can peel
      // the carrier's guns off before committing to the hull itself.
      for (const e of [...enemies.children]) {
        if (e.userData.kind === 'capital' && e.userData.turrets) {
          for (const t of e.userData.turrets) {
            if (!t.alive) continue;
            t.group.getWorldPosition(_tWorldPos);
            if (b.position.distanceTo(_tWorldPos) < t.radius + 1.2) {
              damageTurret(e, t, b.userData.damage, b.position.clone());
              boltGroup.remove(b); consumed = true; break;
            }
          }
          if (consumed) break;
        }
      }
      if (consumed) continue;
      // SHIELD-SURFACE DEFLECTION: while a capital's shields are up, a player bolt is absorbed where
      // it CROSSES THE DOME (radius shieldRadius), not at the hull deep inside — so the shot visibly
      // ripples into the shield bubble instead of flying through it. The strike point is projected
      // onto the dome surface along the line from the capital center to the bolt, and the ripple is
      // registered there. Bolts aimed at a live generator are let through (the corridor).
      for (const e of [...enemies.children]) {
        if (e.userData.kind !== 'capital' || !e.userData.shieldGens || !e.userData.shieldRadius) continue;
        const mult = capitalDamageMult(e);
        if (mult >= 1) continue;                          // shields collapsed — no bubble to absorb on
        // Trip the deflection slightly OUTSIDE the dome surface so the shield reacts as the bolt
        // arrives, not only once it's already crossed in (also catches fast bolts that would skip the
        // thin surface shell between frames). The ripple is still projected onto the true dome surface.
        if (b.position.distanceTo(e.position) > e.userData.shieldRadius + SHIELD_REACT_MARGIN) continue;
        if (boltHeadingToLiveGen(e, b)) continue;         // heading for a generator — let it pass through
        // Project the bolt onto the dome surface for the ripple center.
        _shieldHitPt.copy(b.position).sub(e.position);
        if (_shieldHitPt.lengthSq() < 1e-6) _shieldHitPt.set(0, 1, 0);
        _shieldHitPt.setLength(e.userData.shieldRadius).add(e.position);
        e.userData.hp -= b.userData.damage * mult;
        shieldDeflect(e, _shieldHitPt.clone());
        boltGroup.remove(b);
        if (e.userData.hp <= 0) killEnemy(e, true, b.userData.shooter);
        consumed = true; break;
      }
      if (consumed) continue;
      let hit = false;
      for (const e of [...enemies.children]) {
        // HIT TEST: fighters use their bounding sphere; the capital uses its MEASURED HULL BOX (its
        // bounding sphere is enormous and would count shots nowhere near the hull as hits). Until the
        // capital's box is measured, fall back to a tight fraction of its sphere so early shots still
        // register on the hull rather than the whole halo.
        let onShip;
        if (e.userData.kind === 'capital') {
          onShip = capitalHullContains(e, b.position, 1.0)
                || (!e.userData.ramBox && b.position.distanceTo(e.position) < e.userData.radius * 0.35);
        } else {
          // Fighters use a SWEPT test (the bolt's travel segment this frame vs the fighter's
          // bounding sphere) instead of a single-point distance check. A point test let fast bolts
          // tunnel clean THROUGH a small, fast fighter between frames — so well-aimed shots simply
          // didn't register, which is the "hard to hit enemies" complaint. The swept test catches a
          // bolt whose path crossed the ship even if neither endpoint landed inside it. The padding
          // is bumped modestly (0.7 -> 1.6) so a centered shot connects reliably WITHOUT widening the
          // box enough for genuinely off-target "sloppy" fire to count, and with no aim-assist/tracking.
          onShip = boltHitsSphere(b, dt, e.position, e.userData.radius + 1.6);
        }
        if (!onShip) continue;
        // Capital ship with shields still up but bolt slipped past the dome pass (e.g. through the
        // generator corridor then missed): bleed it off at the hull as before, as a fallback.
        if (e.userData.kind === 'capital' && e.userData.shieldGens) {
          if (boltHeadingToLiveGen(e, b)) { hit = false; break; }
          const mult = capitalDamageMult(e);
          if (mult < 1) {
            e.userData.hp -= b.userData.damage * mult;
            shieldDeflect(e, b.position.clone());
            boltGroup.remove(b);
            if (e.userData.hp <= 0) killEnemy(e, true, b.userData.shooter);
            hit = true; break;
          }
        }
        e.userData.hp -= b.userData.damage; spark(explosions, b.position, 0x8ffcff); boltGroup.remove(b);
        // DIRECT HIT: the fighter panics and throws extreme evasive maneuvers for a few seconds.
        if (e.userData.kind !== 'capital') { e.userData.panicT = 3.0; e.userData.dodgeT = 0; }
        else e.userData.hullHit = true;   // a bolt reached the bare hull (shields down): trip the reserve scramble
        if (e.userData.hp <= 0) killEnemy(e, true, b.userData.shooter);
        hit = true; break;
      }
      if (hit) continue;
      // NEAR-MISS: a player bolt streaking close past a fighter (but not a hit) spooks it into
      // taking evasive action even though it wasn't struck — so being SHOT AT makes enemies dodge.
      for (const e of enemies.children) {
        if (e.userData.kind === 'capital') continue;
        if (b.position.distanceTo(e.position) < e.userData.radius + 6) {
          // Only react to bolts that are actually flying toward the ship, not ones already past it.
          _scratchA.copy(e.position).sub(b.position);
          if (_scratchA.dot(b.userData.vel) > 0) e.userData.dodgeT = Math.max(e.userData.dodgeT || 0, 1.1);
        }
      }
    } else {
      // Enemy (red) bolt: hits the player AND any allied ships. Allied flagship turrets are
      // destructible just like the enemy carrier's, so enemy fire can peel an ally's guns off too.
      let consumed = false;
      for (const a of [...allies.children]) {
        if (a.userData.introHold) continue;   // held off-stage wingman: not hittable yet
        if (a.userData.kind === 'flagship' && a.userData.turrets) {
          for (const t of a.userData.turrets) {
            if (!t.alive) continue;
            t.group.getWorldPosition(_tWorldPos);
            if (b.position.distanceTo(_tWorldPos) < t.radius + 1.2) {
              damageAllyTurret(a, t, b.userData.damage, b.position.clone());
              boltGroup.remove(b); consumed = true; break;
            }
          }
          if (consumed) break;
        }
        if (b.position.distanceTo(a.position) < a.userData.radius + .7) {
          damageAlly(a, b.userData.damage); spark(explosions, b.position, 0xffcf6a); boltGroup.remove(b);
          consumed = true; break;
        }
      }
      if (consumed) continue;
      if (b.position.distanceTo(player.position) < 2.2) { damagePlayer(8, b.position.clone()); spark(explosions, b.position, 0xff536a); boltGroup.remove(b); }
    }
  }
}
// Scratch vectors reused every frame so enemy AI doesn't churn the GC.
const _toPlayer = new THREE.Vector3(), _dir = new THREE.Vector3(), _desiredVel = new THREE.Vector3();
const _capFwd = new THREE.Vector3();   // carrier forward (nose = local -Z), for its cruise drift
const _side = new THREE.Vector3(), _up = new THREE.Vector3(), _avoid = new THREE.Vector3();
const _aimDir = new THREE.Vector3(), _sep = new THREE.Vector3();
// Heading-based flight: ships always thrust along their own nose (local -Z). These reusable
// objects drive the smooth nose-turning so motion follows the model's facing, never drifts sideways.
const _ENEMY_FWD = new THREE.Vector3(0, 0, -1);   // local nose axis
const _enemyTargetQuat = new THREE.Quaternion(), _enemyNose = new THREE.Vector3(), _enemyThrust = new THREE.Vector3();
// Bank-and-turn scratch: build a full target orientation (look-along heading + banked up vector)
// so enemies roll into their turns like real aircraft instead of staying wings-level.
const _bankMat = new THREE.Matrix4();
const _bankRight = new THREE.Vector3(), _bankUp = new THREE.Vector3(), _bankFlatUp = new THREE.Vector3(0, 1, 0);
const _rollQuat = new THREE.Quaternion(), _rollAxis = new THREE.Vector3();   // evasive barrel-roll spin
const _prevHeading = new THREE.Vector3(), _headingDelta = new THREE.Vector3(), _lookTarget = new THREE.Vector3();
function updateEnemies(dt) {
  const list = enemies.children;
  // Difficulty evasion factor: <1 makes hostiles "give themselves up" sooner (Recruit/Normal) by
  // wearing off their panic/dodge jukes faster and softening the break; >1 makes them slipperier.
  const eva = difficultyMods().evasion ?? 1;
  for (const e of [...list]) {
    const ud = e.userData;
    // FLIGHT-SCHOOL CARGO CONTAINERS: stationary target practice. They have no AI and never fire —
    // just a slow idle tumble so they read as adrift. Skip the entire ship pursuit/fire pipeline.
    if (ud.kind === 'container') {
      if (ud.spinRate && ud.spinAxis) e.rotateOnAxis(ud.spinAxis, ud.spinRate * dt);
      continue;
    }
    // DOCKED HANGAR FIGHTERS (Mission 2): parked at rest inside the carrier's bays. No AI, no fire —
    // they just hold station on their bay anchor as the carrier slowly rotates, until launchSquadron
    // releases them. Skip the whole pursuit/fire pipeline while docked.
    if (ud.docked) {
      const cap = ud.dockCapital;
      if (cap && cap.parent && ud.dockBay) {
        cap.updateMatrixWorld();
        e.position.copy(ud.dockBay).applyMatrix4(cap.matrixWorld);   // ride the bay as the carrier turns
      }
      continue;
    }
    // GUARD FIGHTERS (Mission 2 opening screen): 8 bandits fly active CAP around the Dreadnought.
    // They are hittable from the start but stay near the carrier, orbiting it, and only commit to
    // the player/wingmen once a hostile closes inside GUARD_TRIGGER. The first time that happens the
    // fighter "breaks guard" permanently (ud.guard cleared) and runs the normal dogfight AI below.
    if (ud.guard) {
      const cap = ud.guardCapital;
      const capGone = !cap || !cap.parent;
      // Nearest hostile to this guard: the player or any live, on-stage ally.
      let nearestD = e.position.distanceTo(player.position);
      for (const a of allies.children) {
        if (!a.userData || a.userData.introHold) continue;
        if (a.userData.hp != null && a.userData.hp <= 0) continue;
        nearestD = Math.min(nearestD, e.position.distanceTo(a.position));
      }
      const GUARD_TRIGGER = 300;
      if (capGone || nearestD <= GUARD_TRIGGER) {
        // Break guard for good and fall through to the normal AI this very frame.
        ud.guard = false;
        ud.engaged = true; ud.hasFiredSinceEngage = false;
      } else {
        // Patrol: slowly orbit the carrier on the fighter's assigned ring, holding station nearby.
        guardPatrol(e, cap, dt);
        continue;
      }
    }
    // In DEFEND missions some enemies attack the allied flagship instead of the player. Their
    // entire pursuit/firing then keys off the flagship's position. If their flagship target is
    // gone (destroyed) they revert to hunting the player.
    let aimAt = player.position;
    // Tracks which named wingman (if any) this bandit is currently pressing, so that killing it
    // can trigger that wingman's rescue thank-you. Recomputed each frame; cleared when not on a
    // wingman so the kill bark only fires for a bandit actively threatening Slick/O.G.
    ud.threatensWingman = null;
    if (ud.attacksFlagship && defendTarget && allies.children.includes(defendTarget)) {
      aimAt = defendTarget.position;
      markWingmanThreat(ud, defendTarget);
    } else if (ud.attacksOG && protectOG && allies.children.includes(protectOG)) {
      // Mission 3: these bandits press the crippled O.G. while he repairs.
      aimAt = protectOG.position;
      markWingmanThreat(ud, protectOG);
    } else if (mission2Active()) {
      // CAPITAL STRIKE: some bandits peel off to engage the WINGMEN instead of the player, so Slick
      // and O.G. actually come under fire (and trigger their support/comms reactions). Each fighter
      // picks its quarry once and sticks with it (ud.quarry) until that wingman is gone, so they
      // don't flicker between targets. Roughly a third of fighters hunt a wingman.
      if (ud.quarry === undefined) ud.quarry = Math.random() < 0.34 ? 'wingman' : 'player';
      if (ud.quarry === 'wingman') {
        const wm = nearestWingmanTo(e.position);
        if (wm) { aimAt = wm.position; markWingmanThreat(ud, wm); } else ud.quarry = 'player';
      }
    }
    _toPlayer.copy(aimAt).sub(e.position);
    const dist = _toPlayer.length();
    _dir.copy(_toPlayer).multiplyScalar(1 / Math.max(dist, 0.0001));   // unit vector toward the target

    if (ud.kind === 'capital') {
      // Capital ship: slow turret platform. Slowly rotates while its point-defense turrets
      // independently track and hammer the player.
      e.rotation.y += dt * .04;
      updateCapitalTurrets(e, dt);
      updateShieldGens(e, dt);   // spin generator rings + ease deflection pulse
      // ---- Carrier cruise drift + VARIABLE thruster scaling ----
      // The Dreadnought slowly steams along its own nose (local -Z) at a gently-varying cruise
      // speed, so its thrusters aren't a static glow. A slow sine wave eases the target speed up
      // and down between an idle crawl and a fuller cruise; ud.vel chases it. The thruster glow
      // length AND the exhaust streak length then scale off the carrier's REAL speed, so the
      // engines visibly flare brighter/longer as it accelerates and dim/shorten as it eases off.
      _capFwd.set(0, 0, -1).applyQuaternion(e.quaternion).normalize();
      ud.cruisePhase = (ud.cruisePhase || 0) + dt;
      const CAP_CRUISE = ud.speed || 2;                          // peak cruise speed (units/s)
      // Target speed oscillates 0.35..1.0 of cruise so the carrier is always making way but its
      // pace — and therefore its thruster output — visibly rises and falls.
      const speedTarget = CAP_CRUISE * (0.675 + 0.325 * Math.sin(ud.cruisePhase * 0.22));
      _desiredVel.copy(_capFwd).multiplyScalar(speedTarget);
      ud.vel.lerp(_desiredVel, 1 - Math.pow(0.08, dt));          // heavy hull eases toward target
      e.position.addScaledVector(ud.vel, dt);
      // Normalize current speed to 0..1 against peak cruise, then map into a visible thruster band
      // (idle floor 0.22 so engines never fully die, up to full burn 1.0 at cruise).
      const capSpeed01 = THREE.MathUtils.clamp(ud.vel.length() / Math.max(CAP_CRUISE, 0.0001), 0, 1);
      const capThrottle = THREE.MathUtils.lerp(0.22, 1.0, capSpeed01);
      // Streak length also tracks speed: shorter at a crawl, longer when burning (base 3 kept as
      // the mid reference so the previous tuned length sits around the cruise midpoint).
      const capTrailScale = THREE.MathUtils.lerp(1.8, 4.2, capSpeed01);
      // vel is passed so the streaks stay parked behind the moving carrier instead of smearing.
      if (ud.engines) updateEngineTrails(e, dt, capThrottle, camera, false, capTrailScale, ud.vel);
      // ---- Under-attack detection + squadron scramble ----
      ud.lastHp = ud.hp;
      if (ud.dockedFighters) {
        // MISSION 2 HANGAR SQUADRON: the docked reserve launches ONLY when the carrier's HULL is
        // actually hit — i.e. a shot got through with the shields fully collapsed (damageCapitalHull
        // sets ud.hullHit). Shield deflections do NOT count. When it trips, scramble ALL 8 docked
        // fighters at once (4 from each side) for a single dramatic reinforcement wave.
        if (ud.hullHit && !ud.reserveLaunched) {
          ud.reserveLaunched = true;
          launchSquadron(e, { all: true });
          if (mission2Active()) {
            flash('DREADNOUGHT SCRAMBLING RESERVE SQUADRON');
            allySpeak('SLICK', 'assets/audio/voice/mission-2/slickm2struggle.mp3', 0.95);
          }
        }
      } else {
        // LEGACY reinforcement scramble (non-Mission-2 capitals): if the carrier has taken damage
        // recently it's "under attack" for a window, during which it periodically launches a fresh
        // squadron of 4-8 fighters out of its bays.
        if (ud.hp < (ud._scrambleLastHp ?? ud.hp)) ud.aggroT = 8;
        ud._scrambleLastHp = ud.hp;
        ud.aggroT = Math.max(0, ud.aggroT - dt);
        ud.launchCd -= dt;
        if (ud.aggroT > 0 && ud.launchCd <= 0 && enemies.children.length < 26) {
          ud.launchCd = 6 + Math.random() * 3;
          launchSquadron(e);
        }
      }
      // ---- Hull collision: the player can no longer fly THROUGH the Dreadnought ----
      handleCapitalRam(e, dt);
      continue;
    }

    // ---- Engagement commitment + re-engage probability ----
    // Distance-driven re-engagement: the farther an idle/disengaged fighter drifts from the player,
    // the more likely it is to commit back to the attack, climbing to a 90% chance at 520m and an
    // automatic, guaranteed re-engage at 600m+. This is what guarantees fighters always come back
    // instead of wandering off — there is no hard teleport tether at all anymore.
    if (!ud.engaged) {
      ud.reengageT = (ud.reengageT || 0) - dt;
      if (dist >= 600) {
        ud.engaged = true; ud.hasFiredSinceEngage = false;   // mandatory re-engage
      } else if (ud.reengageT <= 0) {
        // Roll on a short cadence. Probability ramps with distance: ~15% by 200m, 90% at 520m.
        ud.reengageT = 0.5 + Math.random() * 0.5;
        const p = THREE.MathUtils.clamp(0.15 + (dist - 200) / (520 - 200) * 0.75, 0.04, 0.90);
        if (Math.random() < p) { ud.engaged = true; ud.hasFiredSinceEngage = false; }
      }
    }

    // ---- Threat-reaction timers ----
    // panicT: set when the fighter is HIT by the player — it abandons the attack and throws hard,
    //   randomized evasive maneuvers (a "break") for a few seconds.
    // dodgeT: set when a player bolt streaks close past it (shot at but not hit) — a shorter jink
    //   that breaks the firing line without fully fleeing.
    // Both decay each frame. While either is active they OVERRIDE the normal behavior pick below.
    // On easier difficulties (eva<1) the jukes decay FASTER, so hostiles snap out of evasion and
    // re-present a clean target much sooner — the "give themselves up" behavior the player wants.
    const threatDecay = dt / Math.max(0.2, eva);
    ud.panicT = Math.max(0, (ud.panicT || 0) - threatDecay);
    ud.dodgeT = Math.max(0, (ud.dodgeT || 0) - threatDecay);

    // ---- Dogfight behavior state machine ----
    // Periodically re-pick a behavior so fighters bank, strafe, and break off instead of
    // boring straight-line charges. An ENGAGED fighter that hasn't fired yet is locked onto the
    // attack (pursue/strafe only, never flee) until it actually gets a shot off — and even after
    // firing it only has a small chance to break off, so it stays in the fight by default.
    ud.behaviorT -= dt;
    if (ud.behaviorT <= 0) {
      const r = Math.random();
      if (ud.engaged) {
        if (!ud.hasFiredSinceEngage) {
          // Committed run-in: drive the nose onto the player and hold it there to line up a shot.
          // Heavily favor pursue (nose-on) so the ship can actually fire, since firing now requires
          // the nose pointed at the player; only an occasional close-range strafe to avoid a ram.
          ud.behavior = (dist < 60 && r < 0.25) ? 'strafe' : 'pursue';
        } else {
          // Has landed a shot this engagement — small chance to disengage for a reset pass.
          if (r < 0.12) { ud.engaged = false; ud.behavior = 'evade'; }
          else ud.behavior = r < 0.6 ? 'pursue' : 'strafe';
          // Point-blank, allow a quick break even while engaged so they don't just ram.
          if (dist < 30 && r < 0.4) ud.behavior = 'evade';
        }
      } else {
        // Disengaged: drifting/repositioning until the re-engage roll above brings it back.
        ud.behavior = r < 0.4 ? 'strafe' : (r < 0.7 ? 'pursue' : 'evade');
      }
      if (Math.random() < 0.4) ud.strafeDir *= -1;
      ud.behaviorT = 0.8 + Math.random() * 1.6;
    }
    // Engaged fighters never flee, regardless of where the per-frame logic left them.
    if (ud.engaged && !ud.hasFiredSinceEngage && ud.behavior === 'evade') ud.behavior = 'pursue';
    // Soft inner leash so a near disengaged fighter still circles back instead of coasting away.
    const LEASH_SOFT = 130;
    if (dist > LEASH_SOFT && ud.behavior === 'evade') ud.behavior = 'strafe';
    // THREAT OVERRIDE: being hit (panic) or shot at (dodge) forces evasion regardless of the state
    // machine above. A hit also breaks the engagement so the fighter genuinely peels off, resets,
    // and comes back for a fresh pass (the re-engage roll pulls it back in). Dodging keeps it
    // engaged — it just jukes the firing line for a moment, then resumes its run.
    if (ud.panicT > 0) { ud.behavior = 'evade'; ud.engaged = false; ud.hasFiredSinceEngage = false; }
    else if (ud.dodgeT > 0) ud.behavior = 'evade';

    // ---- Heading-based flight model ----
    // Each enemy is flown like a real aircraft: we compute a desired HEADING DIRECTION from its
    // behavior, smoothly turn the ship's NOSE toward that heading, and then always thrust FORWARD
    // along its own nose. Motion therefore always follows the nose — no sideways drifting or
    // velocity vectors that swing independently of the model, which is what caused the "bouncing".
    // Local "side" axis (perpendicular to the player bearing) used for strafing arcs.
    _up.set(0, 1, 0);
    _side.crossVectors(_dir, _up).normalize();
    const speed = ud.speed;
    // _desiredDir = unit vector the nose should point toward this frame.
    if (ud.behavior === 'pursue') {
      // Fly straight at the player.
      _desiredVel.copy(_dir);
    } else if (ud.behavior === 'strafe') {
      // Bank across the player's front: mostly sideways with a little lead toward/away to hold range.
      _desiredVel.copy(_side).multiplyScalar(ud.strafeDir);
      _desiredVel.addScaledVector(_dir, dist > 55 ? 0.5 : -0.15);
    } else { // evade
      // Peel away from the player to reset the engagement, angling off to one side. When PANICKING
      // (just took a hit), throw a much harder break: cut hard across to one side and climb/dive so
      // the player can't simply hold the trigger and track — a genuine evasive maneuver, not a
      // gentle bank. A plain dodge (shot at) is a sharper version of the normal peel-off.
      _desiredVel.copy(_dir).multiplyScalar(ud.panicT > 0 ? -0.35 : -1);
      // Lateral break magnitude is softened on easier difficulties (eva<1) so the juke is shallower
      // and the player can keep the nose on a fleeing bandit instead of losing it across the sky.
      const lateral = (ud.panicT > 0 ? 1.6 : (ud.dodgeT > 0 ? 1.1 : 0.7)) * eva;
      _desiredVel.addScaledVector(_side, lateral * ud.strafeDir);
      if (ud.panicT > 0) _desiredVel.addScaledVector(_up, (Math.sin(ud.phase * 5 + ud.jinkPhase) > 0 ? 1 : -1) * 0.9 * eva);
    }
    // Per-ship weave so flight paths curve gently instead of being dead-straight. The weave amplitude
    // spikes while panicking/dodging so the path becomes a hard, jinking break instead of a smooth arc.
    // Scaled by the difficulty evasion factor so easy modes weave less and stay easier to track.
    const weave = (ud.panicT > 0 ? 1.3 : (ud.dodgeT > 0 ? 0.7 : 0.30)) * eva;
    ud.jinkPhase += ud.jinkRate * (ud.panicT > 0 ? 3.2 : ud.dodgeT > 0 ? 2.0 : 1) * dt;
    _desiredVel.addScaledVector(_side, Math.sin(ud.jinkPhase) * weave);
    _desiredVel.addScaledVector(_up, Math.cos(ud.jinkPhase * 0.7) * weave * 0.6);

    // ---- Collision avoidance (bends the HEADING, never adds sideways velocity) ----
    // Steer the nose away from the player when too close so enemies arc around the hull.
    const avoidR = e.userData.radius + 9;
    if (dist < avoidR) {
      const push = (avoidR - dist) / avoidR;            // 0..1, strongest at contact
      _desiredVel.addScaledVector(_dir, -1.6 * push);
    }
    // Light separation so enemies don't stack: nudge the heading away from close neighbors.
    _avoid.set(0, 0, 0);
    for (const o of list) {
      if (o === e || o.userData.kind === 'capital') continue;
      _sep.copy(e.position).sub(o.position);
      const d2 = _sep.length();
      if (d2 > 0.001 && d2 < 7) _avoid.addScaledVector(_sep.multiplyScalar(1 / d2), (7 - d2));
    }
    if (_avoid.lengthSq() > 0) _desiredVel.addScaledVector(_avoid.normalize(), 0.6);

    // ---- Continuous return-home bias ----
    // Any ENGAGED fighter that is beyond knife-fight range gets its heading blended hard toward the
    // player, ramping to fully dominant by ~250m, so a committed fighter always drives straight back
    // into the merge regardless of jink/strafe lead. This is the steering half of the guarantee that
    // a re-engaged fighter actually returns; the closing-rate afterburner below is the speed half.
    if (ud.engaged && dist > 60) {
      const home = THREE.MathUtils.clamp((dist - 60) / 190, 0, 1);   // 0 at 60m, 1 by ~250m
      _desiredVel.addScaledVector(_dir, home * 10.0);
    }

    // Normalize to a pure heading direction.
    if (_desiredVel.lengthSq() < 1e-6) _desiredVel.copy(_dir);
    _desiredVel.normalize();

    // ---- Heading inertia ----
    // The raw desired heading is a noisy SUM of pursue/strafe/jink/avoid/separation/home terms and
    // can jump sharply frame-to-frame. Thrust follows the nose, so an unfiltered heading makes the
    // ship dart and stutter ("floating / odd direction changes"). Smooth the heading toward the raw
    // target so it sweeps like a real aircraft instead of snapping to every twitch.
    if (!ud.heading) ud.heading = _desiredVel.clone();
    ud.heading.lerp(_desiredVel, 1 - Math.pow(0.02, dt)).normalize();
    _desiredVel.copy(ud.heading);

    // ---- Bank-and-turn orientation ----
    // Measure how sharply the heading is swinging sideways this frame to decide bank angle. We
    // compare the new desired heading against the ship's current nose, project the change onto the
    // ship's right axis, and roll into the turn (positive = roll right, like a banking aircraft).
    _enemyNose.copy(_ENEMY_FWD).applyQuaternion(e.quaternion).normalize();
    _bankRight.crossVectors(_enemyNose, _bankFlatUp).normalize();   // current world "right" (flat ref)
    if (_bankRight.lengthSq() < 1e-6) _bankRight.set(1, 0, 0);      // guard near-vertical noses
    _headingDelta.copy(_desiredVel).sub(_enemyNose);
    // Signed turn amount: how much the heading wants to swing toward the ship's right vs. left.
    const turnSign = _headingDelta.dot(_bankRight);
    // Smoothly track a per-ship bank angle so rolls ease in/out instead of snapping.
    const targetBank = THREE.MathUtils.clamp(turnSign * 2.6, -1, 1) * 1.05;   // up to ~60deg roll
    ud.bank = (ud.bank || 0) + (targetBank - (ud.bank || 0)) * (1 - Math.pow(0.02, dt));

    // ---- Evasive aileron / barrel roll trigger ----
    // While taking evasive action (panicking after a hit, or dodging incoming fire) the fighter
    // throws spinning rolls about its own nose — a fast aileron/barrel roll to shake the player's
    // aim. We trigger a roll when a threat reaction is active and re-arm it on a short cadence so a
    // panicking fighter keeps spinning through its whole break. Panic rolls are bigger/faster
    // (≈2 full turns) than the single-turn dodge aileron. The actual continuous spin is applied to
    // the quaternion AFTER the slerp below (a lookAt-derived target can't represent a >180° roll,
    // so the roll has to be an incremental rotation about the nose, not baked into the bank).
    ud.rollT = Math.max(0, (ud.rollT || 0) - dt);
    ud.rollCd = Math.max(0, (ud.rollCd || 0) - dt);
    if ((ud.panicT > 0 || ud.dodgeT > 0) && ud.rollT <= 0 && ud.rollCd <= 0) {
      ud.rollDur = ud.panicT > 0 ? 1.1 : 0.6;
      ud.rollT = ud.rollDur;
      ud.rollTurns = (ud.panicT > 0 ? 2 : 1) * (Math.random() < 0.5 ? -1 : 1);
      ud.rollCd = ud.rollDur + 0.2;    // brief gap before another roll can start
      ud.rollPrevEase = 0;             // track eased progress so we can apply per-frame deltas
    }

    // Build the target orientation: nose along the desired heading, up-vector rolled by `bank`
    // about the nose. Roll the flat-up reference around the heading axis to get a banked up.
    // GUARD: if the heading is nearly vertical, the world-up reference is almost parallel to it and
    // Matrix4.lookAt degenerates (the basis flips/spins), which is a source of the sudden snap-arounds.
    // Fall back to the ship's current up in that case so the orientation stays stable.
    _bankUp.copy(_bankFlatUp);
    if (Math.abs(_desiredVel.dot(_bankFlatUp)) > 0.985) {
      _bankUp.set(0, 1, 0).applyQuaternion(e.quaternion);   // current up, well clear of the heading
    }
    _bankUp.applyAxisAngle(_desiredVel, ud.bank);
    // Matrix4.lookAt(eye, target, up) builds an orientation whose local +Z points from `target`
    // toward `eye` (i.e. along eye-target). Our nose is local -Z, so to make the NOSE point along
    // the desired heading we need +Z to point OPPOSITE the heading — that means the look target must
    // be placed AHEAD of the ship along the heading (eye - target = -heading => +Z = -heading =>
    // nose -Z = +heading). Aiming behind (the previous code) put the nose 180° backwards, which is
    // exactly what made fighters thrust AWAY from the player and run off forever.
    _lookTarget.copy(e.position).addScaledVector(_desiredVel, 1);
    _bankMat.lookAt(e.position, _lookTarget, _bankUp);
    _enemyTargetQuat.setFromRotationMatrix(_bankMat);
    // turn rate scales a touch with how nimble the craft is (faster ships turn quicker). An engaged
    // fighter that's been pulled home from far out snaps its nose around much faster so it doesn't
    // waste time thrusting outbound while it slowly swings to face the player.
    // Snappy nose-turn so the facing keeps up with the heading and the ship stays nose-first. While
    // panicking/dodging the ship hauls its nose around much faster so the evasive break is sharp
    // and immediate rather than a lazy arc the player can keep tracking.
    let turnBase = (ud.engaged && dist > LEASH_SOFT) ? 0.004 : 0.012;
    if (ud.panicT > 0) turnBase = 0.00015; else if (ud.dodgeT > 0) turnBase = 0.002;
    const turn = 1 - Math.pow(turnBase, dt);
    e.quaternion.slerp(_enemyTargetQuat, turn);

    // ---- Apply the evasive barrel-roll spin ----
    // The lookAt-derived target above keeps the wings level-to-banked; here we add the actual
    // continuous roll by rotating the ship about its OWN nose by the per-frame increment of the
    // eased spin. Because it's an incremental rotation (delta this frame), a full 360°+ barrel
    // roll comes out as a smooth continuous spin rather than a shortest-path wobble.
    if (ud.rollT > 0 && ud.rollDur) {
      const k = 1 - ud.rollT / ud.rollDur;             // 0 -> 1 across the roll
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const dEase = eased - (ud.rollPrevEase || 0);    // progress made THIS frame
      ud.rollPrevEase = eased;
      const dRoll = (ud.rollTurns || 1) * Math.PI * 2 * dEase;
      _rollAxis.copy(_ENEMY_FWD).applyQuaternion(e.quaternion).normalize();   // current nose axis
      _rollQuat.setFromAxisAngle(_rollAxis, dRoll);
      e.quaternion.premultiply(_rollQuat);
    }

    // Forward thrust along the (new) nose. Ease off near knife-fight range so they don't ram.
    const throttle = (dist < 26 && ud.behavior === 'pursue') ? 0.3 : 1;
    // ---- Catch-up afterburner (closing-rate based) ----
    // Works in terms of CLOSING RATE rather than a position pin: the fighter's speed is set to beat
    // the player's CURRENT speed by a growing margin, so it physically overtakes a fleeing player
    // and the gap genuinely shrinks every frame instead of riding a teleport ring.
    // Only ENGAGED fighters get the catch-up boost: a committed fighter always beats the player's
    // current speed by a growing margin so it physically reels a fleeing player back in. A
    // DISENGAGED fighter cruises at its base speed and is allowed to drift away — which is exactly
    // what lets the distance grow until the distance-driven re-engage roll pulls it back (90% at
    // 520m, automatic at 600m). There is NO position teleport anymore, so nothing bounces at a wall.
    let chaseSpeed = speed;
    // Hard escape burn during an evasive break so the fighter actually opens the range after being
    // hit/shot at, rather than wallowing in the player's sights at cruise speed. A HIT triggers a
    // full afterburner getaway that always beats the player's current speed (so it genuinely peels
    // away even from a boosting player) and is paired with the barrel rolls above; a near-miss dodge
    // gets a lighter speed bump.
    if (ud.panicT > 0) chaseSpeed = Math.max(speed * 2.0, player.userData.vel.length() * 1.25 + 24);
    else if (ud.dodgeT > 0) chaseSpeed = speed * 1.35;
    if (ud.engaged && dist > 120) {
      const playerSpeed = player.userData.vel.length();
      const farT = THREE.MathUtils.clamp((dist - 120) / 160, 0, 1);   // 0 at 120m, 1 by ~280m
      // Guarantee a positive closing rate: always exceed the player's speed by a growing margin
      // (16 -> ~52 u/s) plus a relative cushion, so even a boosting player gets reeled in.
      const margin = 16 + 36 * farT;
      const catchUp = playerSpeed * 1.15 + margin;
      chaseSpeed = Math.max(speed, THREE.MathUtils.lerp(speed, catchUp, farT));
    }
    _enemyNose.copy(_ENEMY_FWD).applyQuaternion(e.quaternion).normalize();
    // ---- Thrust strictly along the nose ----
    // The ship ALWAYS flies in the direction its nose points (local -Z), which is exactly opposite
    // the engine exhaust (local +Z). Velocity is tied tightly to the current nose with only a light
    // smoothing, so the craft is always nose-first and never crabs sideways or drifts tail-first —
    // the flight path simply curves as the nose turns. (A heavy velocity lag, used before, let the
    // travel direction trail far behind the facing and read as sideways/backward flight.)
    _enemyThrust.copy(_enemyNose).multiplyScalar(chaseSpeed * throttle);
    const _prevSpeed = ud.vel.length();
    ud.vel.lerp(_enemyThrust, 1 - Math.pow(0.00002, dt));
    e.position.addScaledVector(ud.vel, dt);

    // Red engine exhaust streaks (mirrors the player's blue trails). The exhaust now tracks
    // ACCELERATION, not raw speed: a fighter coasting at a steady velocity shows NO trail, and the
    // trail grows heavier the harder it's burning to gain speed (throttle up). We read the per-frame
    // speed gain (forward acceleration) and map it to a 0..1 exhaust intensity. Enemy beams stay
    // SHORT via the small lenScale so even a hard burn is a compact glow, not a long banner.
    if (ud.engines) {
      const newSpeed = ud.vel.length();
      // Forward acceleration this frame, in u/s^2 (only positive — braking/coasting produces no plume).
      const accel = (newSpeed - _prevSpeed) / Math.max(dt, 1e-4);
      // Map accel to throttle 0..1. ACCEL_FULL is the burn that reads as full nozzles; below
      // ACCEL_DEADZONE the engine is treated as idle (coasting) and emits nothing.
      const ACCEL_DEADZONE = 1.5, ACCEL_FULL = 26;
      let eThrottle = (accel - ACCEL_DEADZONE) / (ACCEL_FULL - ACCEL_DEADZONE);
      eThrottle = THREE.MathUtils.clamp(eThrottle, 0, 1);
      // Smooth so the plume swells/fades over a few frames instead of strobing with frame jitter.
      ud.exhaust01 = THREE.MathUtils.damp(ud.exhaust01 ?? 0, eThrottle, 9, dt);
      updateEngineTrails(e, dt, ud.exhaust01, camera, false, 1, ud.vel, false, 0.25);
    }

    // ---- Firing: prioritize shooting the player inside engagement range ----
    // Enemies are aggressive shooters: a generous engagement range, a wide aim cone, and a short
    // cadence whenever the player is in front of their guns, so they keep up steady pressure
    // instead of flying around without firing.
    const ENGAGE_RANGE = 220;
    ud.fireT -= dt;
    if (ud.fireT <= 0 && dist < ENGAGE_RANGE) {
      // How squarely is the nose (local -Z) pointed at the player? 1 = dead-on, 0 = 90deg off.
      _aimDir.set(0, 0, -1).applyQuaternion(e.quaternion);
      const aim = _aimDir.dot(_dir);
      // Only fire when the NOSE is genuinely pointed at the player — i.e. the player sits inside a
      // tight forward cone (~37deg half-angle, aim > 0.8). No point-blank bypass: a ship facing away
      // must swing its nose onto the target before it can shoot, so bolts never come out the rear.
      if (aim > 0.8) {
        ud.fireT = aim > 0.94 ? 0.35 + Math.random() * 0.4   // dead-on: rapid bursts
                 : 0.7 + Math.random() * 0.7;                // on-cone: steady fire
        enemyFire(e, _dir, dist, ud.kind === 'drone' ? 0.62 : 1.0);
        // The fighter has now taken its shot this engagement: it's allowed to consider breaking off
        // on a later behavior roll (firing itself does NOT auto-disengage it).
        ud.hasFiredSinceEngage = true;
      } else {
        // No firing solution this frame; check again soon so it shoots the instant it lines up.
        ud.fireT = 0.15;
      }
    }

    // ---- Missile launches (only missile-armed enemies) ----
    // Missile-capable fighters occasionally launch a SEEKING missile at the player from medium
    // range when their nose is roughly on target. Long cooldown + limited count, so it's an
    // occasional heavy threat rather than a missile spam. The player can chaff/evade it.
    if (ud.missiles > 0) {
      ud.missileT -= dt;
      if (ud.missileT <= 0 && dist > 60 && dist < 400) {
        _aimDir.set(0, 0, -1).applyQuaternion(e.quaternion);
        if (_aimDir.dot(_dir) > 0.7) {
          ud.missiles--;
          _aimDir.set(0, 0, -1).applyQuaternion(e.quaternion).normalize();
          const start = e.position.clone().addScaledVector(_aimDir, e.userData.radius + 1.5);
          // Mission 3: a bandit pressing O.G. fires its SEEKING missile AT O.G., not the player — so
          // the escort faces real heavy threats the player must race to intercept/shoot down. The big
          // red "MISSILE INBOUND" warning is reserved for missiles aimed at the PLAYER; an O.G.-bound
          // shot raises a distinct escort-warning flash instead.
          const atOG = ud.attacksOG && mission3Active() && protectOG && allies.children.includes(protectOG);
          const seekTarget = atOG ? protectOG : player;
          const em = makeMissile(start, _aimDir, false, seekTarget, 34);
          // Distance-scaled evasion: a long-range enemy shot is sluggish and can be out-flown; a
          // close one is agile. `dist` is the shooter→player range already computed above.
          em.userData.turn = missileTurnForRange(dist);
          missileGroup.add(em);
          audio.play('enemyLaser', 0.4);
          if (atOG) flash('MISSILE LOCKED ON O.G. — INTERCEPT'); else flash('MISSILE INBOUND');
          ud.missileT = 7 + Math.random() * 6;
        } else {
          ud.missileT = 0.4;   // recheck soon while it swings its nose on
        }
      }
    }

    // ---- Enemy chaff (defensive countermeasure) ----
    // If one of the PLAYER's seeking missiles is closing on this fighter and it still has chaff,
    // it pops a flare to try to spoof the incoming shot. Each fighter has a limited supply.
    if (ud.chaff > 0) {
      for (const mm of missileGroup.children) {
        const mu = mm.userData;
        if (!mu.isMissile || !mu.friendly || mu.target !== e || mu.decoy) continue;
        if (mm.position.distanceTo(e.position) < 55) {
          ud.chaff--;
          spawnChaff(e.position, ud.vel, true);
          break;
        }
      }
    }

    // ---- Mutual collision damage ----
    // A real hull-on-hull collision damages BOTH the player and the enemy. The enemy takes
    // heavy damage (often fatal) and the player takes a solid hull/shield hit, instead of the
    // old "enemy instantly dies, player takes flat 18" ram.
    if (dist < e.userData.radius + 2.0) {
      damagePlayer(16 + e.userData.radius * 4);
      // Grinding hull sparks at the contact point between the two craft + a strong controller rumble
      // (a fighter ram is a harder hit than a capital scrape, so dial the feedback up).
      playerCollisionFeedback(e.position.clone().lerp(player.position, 0.5), 0.95);
      ud.hp -= 60;
      // Shove both craft apart so they don't stay overlapped and re-trigger every frame.
      e.position.addScaledVector(_dir, -(e.userData.radius + 2.2 - dist) - 1);
      ud.vel.addScaledVector(_dir, -speed * 1.5);
      if (ud.hp <= 0) killEnemy(e, false);
    }
  }
}

// ---- Capital hull collision (no more flying THROUGH the Dreadnought) --------------------------
// The capital is a long, slab-like hull, so a single sphere is a poor fit. We test the player in the
// capital's LOCAL frame against the measured model bounding box (cached once, slightly padded). If
// the player is inside that box, we treat it as scraping the hull: BOTH take slight damage (the
// player's to shields/hull via damagePlayer, the carrier a small hull bite — or a shield-deflection
// nick while its shields hold), and the player is pushed back out along the nearest box face so they
// don't tunnel through or stay lodged inside. A short cooldown keeps the damage from machine-gunning
// every frame while scraping along the hull.
const _capRamInv = new THREE.Matrix4();
const _capRamLocal = new THREE.Vector3();
const _capRamPush = new THREE.Vector3();
function ensureCapitalRamBox(capital) {
  // Measure the model box ONCE and cache it on the capital, in the capital's LOCAL frame. The model
  // is parented at the capital's origin, so undoing the capital's world matrix yields a snug, axis-
  // aligned local collision volume (the capital only rotates about Y, so the local box stays AABB).
  if (capital.userData.ramBox) return capital.userData.ramBox;
  const model = capital.userData.model;
  if (!model || !model.userData.modelReady) return null;
  capital.updateMatrixWorld(true);
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(capital.matrixWorld).invert();
  const localBox = new THREE.Box3().setFromObject(model).applyMatrix4(inv);
  if (!isFinite(localBox.min.x) || !isFinite(localBox.max.z)) return null;
  localBox.expandByScalar(2.2);   // small skin so the player can't clip the visible hull
  capital.userData.ramBox = localBox;
  return localBox;
}
// True if `worldPos` is inside the capital's measured hull box (in the capital's local frame),
// optionally with extra `pad`. Used to TIGHTEN bolt/missile hull hits on the Dreadnought: the
// capital's `userData.radius` is one huge bounding sphere, so a sphere test counts shots that are
// nowhere near the actual hull as hits. Testing the measured box instead is far tighter. Returns
// false (no hit) until the model box has been measured, so early shots simply fall through.
const _capHitInv = new THREE.Matrix4();
const _capHitLocal = new THREE.Vector3();
function capitalHullContains(capital, worldPos, pad = 0) {
  const box = ensureCapitalRamBox(capital);
  if (!box) return false;
  capital.updateMatrixWorld();
  _capHitInv.copy(capital.matrixWorld).invert();
  _capHitLocal.copy(worldPos).applyMatrix4(_capHitInv);
  if (pad === 0) return box.containsPoint(_capHitLocal);
  return _capHitLocal.x >= box.min.x - pad && _capHitLocal.x <= box.max.x + pad
      && _capHitLocal.y >= box.min.y - pad && _capHitLocal.y <= box.max.y + pad
      && _capHitLocal.z >= box.min.z - pad && _capHitLocal.z <= box.max.z + pad;
}
// Decide whether the player is genuinely buried in SOLID hull vs. sitting in a hollow space such as
// a hangar bay. Uses a true POINT-IN-MESH test rather than a "surrounded by walls" heuristic: cast a
// long ray from the player and count how many times it crosses the model surface — an ODD number of
// crossings means the player is INSIDE solid geometry, EVEN means outside (e.g. in an open bay or the
// void around a wing). A single ray can misread on a hull that isn't perfectly watertight, so we cast
// several rays in spread directions and take a MAJORITY vote on the inside/outside parity. This
// correctly catches thin sections (wings, plates, corridor walls) the old 6-axis proximity check let
// the player slip through, while still allowing flight into the genuinely hollow hangar bays.
const _capProbeRc = new THREE.Raycaster();
const _capProbeOrigin = new THREE.Vector3();
// A spread of normalized directions (not axis-aligned, to avoid grazing coplanar hull faces).
const _capProbeDirs = [
  new THREE.Vector3( 0.71,  0.43,  0.55).normalize(),
  new THREE.Vector3(-0.66,  0.21, -0.72).normalize(),
  new THREE.Vector3( 0.18, -0.83,  0.53).normalize(),
  new THREE.Vector3(-0.49, -0.34,  0.80).normalize(),
  new THREE.Vector3( 0.85, -0.15, -0.50).normalize()
];
function playerEmbeddedInCapital(capital) {
  const model = capital.userData.model;
  if (!model) return true;   // no model to probe — fall back to the solid-box behavior
  _capProbeOrigin.copy(player.position);
  _capProbeRc.near = 0;
  _capProbeRc.far = 4000;    // long enough to exit the whole hull in any direction
  let inside = 0, total = 0;
  for (const d of _capProbeDirs) {
    _capProbeRc.set(_capProbeOrigin, d);
    const hits = _capProbeRc.intersectObject(model, true);
    if (!hits.length) continue;          // ray escaped without crossing the hull → reads as outside
    total++;
    if (hits.length % 2 === 1) inside++; // odd surface crossings ⇒ this ray says we're inside solid hull
  }
  if (total === 0) return false;         // every probe escaped cleanly — open space, let the player fly
  return inside * 2 > total;             // majority of probes say inside ⇒ genuinely embedded
}
// Unified feedback for a HULL COLLISION (scraping the Dreadnought, ramming a fighter, etc.): a burst
// of grinding hull sparks at the contact point plus a controller rumble, so a bounce feels physical.
// `worldPos` is the contact point; `intensity` (0..1) scales the spark count + rumble. The cockpit
// shield-flash is handled separately by damagePlayer when shields actually soak the impact.
const _collFxPos = new THREE.Vector3();
function playerCollisionFeedback(worldPos, intensity = 0.7) {
  const k = THREE.MathUtils.clamp(intensity, 0.2, 1);
  // Several spark spurts jittered around the contact point so it reads as grinding metal, not a dot.
  const bursts = 2 + Math.round(k * 4);
  for (let i = 0; i < bursts; i++) {
    _collFxPos.copy(worldPos).add(new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(2.4),
      THREE.MathUtils.randFloatSpread(2.4),
      THREE.MathUtils.randFloatSpread(2.4)
    ));
    spark(explosions, _collFxPos.clone(), i % 2 ? 0xffd27a : 0xfff4c0);
  }
  // Controller haptic: a firm thump scaled to the impact (safe no-op without a pad / haptics).
  gamepad.rumble(0.35 + k * 0.55, 120 + k * 140);
}
function handleCapitalRam(capital, dt) {
  const ud = capital.userData;
  ud.ramCd = Math.max(0, (ud.ramCd || 0) - dt);
  const box = ensureCapitalRamBox(capital);
  if (!box) return;
  // Player position in the capital's local frame.
  capital.updateMatrixWorld();
  _capRamInv.copy(capital.matrixWorld).invert();
  _capRamLocal.copy(player.position).applyMatrix4(_capRamInv);
  if (!box.containsPoint(_capRamLocal)) return;   // not inside the hull volume — nothing to do

  // Inside the box — but the box is a SOLID AABB and the hull has HOLLOW spaces (the hangar bays).
  // Flying into an open bay should NOT collide. Confirm the player is actually embedded in solid hull
  // geometry before reacting: cast short rays from the player in all six axes; if the nearest model
  // surface is far in every direction, the player is in open/hollow space (a hangar) — let them fly.
  if (!playerEmbeddedInCapital(capital)) return;

  // Inside SOLID hull: find the nearest box face and the push-out direction (local space).
  const dxMin = _capRamLocal.x - box.min.x, dxMax = box.max.x - _capRamLocal.x;
  const dyMin = _capRamLocal.y - box.min.y, dyMax = box.max.y - _capRamLocal.y;
  const dzMin = _capRamLocal.z - box.min.z, dzMax = box.max.z - _capRamLocal.z;
  const pen = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);   // smallest penetration depth
  _capRamPush.set(0, 0, 0);
  if (pen === dxMin) _capRamPush.set(-1, 0, 0);
  else if (pen === dxMax) _capRamPush.set(1, 0, 0);
  else if (pen === dyMin) _capRamPush.set(0, -1, 0);
  else if (pen === dyMax) _capRamPush.set(0, 1, 0);
  else if (pen === dzMin) _capRamPush.set(0, 0, -1);
  else _capRamPush.set(0, 0, 1);
  // Convert the push direction to WORLD space and eject the player to just outside that face.
  _capRamPush.transformDirection(capital.matrixWorld).normalize();
  player.position.addScaledVector(_capRamPush, pen + 1.5);
  // Kill the inward component of the player's velocity and add a small bounce outward.
  const into = player.userData.vel.dot(_capRamPush);
  if (into < 0) player.userData.vel.addScaledVector(_capRamPush, -into);
  player.userData.vel.addScaledVector(_capRamPush, 14);

  // Slight mutual damage on a short cooldown (so scraping doesn't drain instantly).
  if (ud.ramCd <= 0) {
    ud.ramCd = 0.4;
    damagePlayer(10);                         // player's shields/hull take a small scrape
    playerCollisionFeedback(player.position.clone(), 0.7);   // grinding hull sparks + rumble
    if (ud.shieldGens && capitalDamageMult(capital) < 1) {
      // Carrier shields still up: the collision is bled off as a shield nick, not hull damage.
      shieldDeflect(capital, player.position.clone());
      ud.hp -= 4 * capitalDamageMult(capital);
    } else {
      ud.hp -= 8;                             // shields down: a real (small) hull bite
      if (ud.hp <= 0) killEnemy(capital, false);
    }
    audio.play('explosion', 0.22);
  }
}

// Mission 2: the OPENING fighter screen. Field `n` active bandits flying combat air patrol AROUND
// the Dreadnought. They're live and hittable from the start, but they hold near the carrier —
// orbiting it on assigned rings — and only break off to press the player/wingmen once a hostile
// closes inside 300m (handled in updateEnemies via ud.guard). Each is seeded with an orbit ring
// (radius/height/phase/direction) so the group spreads into a believable screen rather than a clump.
const _guardSpawn = new THREE.Vector3();
function spawnMission2Guard(capital, n) {
  capital.updateMatrixWorld();
  for (let i = 0; i < n; i++) {
    const kind = i % 4 === 0 ? 'bomber' : (i % 2 === 0 ? 'interceptor' : 'fighter');
    // Spread the screen over a couple of orbit rings of differing radius/height around the carrier.
    const radius = 220 + (i % 3) * 70 + Math.random() * 40;
    const height = THREE.MathUtils.randFloatSpread(160);
    const phase = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const dir = i % 2 === 0 ? 1 : -1;        // alternate orbit direction
    _guardSpawn.set(
      capital.position.x + Math.cos(phase) * radius,
      capital.position.y + height,
      capital.position.z + Math.sin(phase) * radius
    );
    const f = applyDifficultyHp(makeEnemy(kind, _guardSpawn.clone(), trails));
    const ud = f.userData;
    ud.guard = true;                         // flying CAP around the carrier until a hostile closes
    ud.guardCapital = capital;
    ud.guardRadius = radius;
    ud.guardHeight = height;
    ud.guardPhase = phase;
    ud.guardDir = dir;
    ud.guardOmega = (0.10 + Math.random() * 0.06) * dir;   // orbit angular speed (rad/s)
    enemies.add(f);
  }
}
// Fly a guard fighter along its assigned orbit ring around the carrier: advance its phase, steer the
// nose toward the next point on the ring (so it banks into the turn), and thrust forward. Holds the
// fighter near the Dreadnought without engaging until updateEnemies trips it out of guard.
const _gpTarget = new THREE.Vector3(), _gpToTarget = new THREE.Vector3();
const _gpFwd = new THREE.Vector3(), _gpDesiredQuat = new THREE.Quaternion();
const _gpForwardLocal = new THREE.Vector3(0, 0, -1);
function guardPatrol(e, capital, dt) {
  const ud = e.userData;
  ud.guardPhase += ud.guardOmega * dt;
  // A look-ahead point a little further along the ring gives a forward-flight heading to bank toward.
  const lead = ud.guardPhase + ud.guardOmega * 0.6 + (ud.guardDir * 0.25);
  _gpTarget.set(
    capital.position.x + Math.cos(lead) * ud.guardRadius,
    capital.position.y + ud.guardHeight,
    capital.position.z + Math.sin(lead) * ud.guardRadius
  );
  _gpToTarget.copy(_gpTarget).sub(e.position);
  const d = _gpToTarget.length();
  if (d > 1e-4) {
    _gpFwd.copy(_gpToTarget).multiplyScalar(1 / d);
    // Turn the nose toward the heading (nose = local -Z), banking smoothly.
    _gpDesiredQuat.setFromUnitVectors(_gpForwardLocal, _gpFwd);
    e.quaternion.slerp(_gpDesiredQuat, Math.min(1, dt * 2.2));
    // Thrust forward along the ring at a relaxed cruise.
    const cruise = ud.speed * 0.6;
    ud.vel.copy(_gpFwd).multiplyScalar(cruise);
    e.position.addScaledVector(ud.vel, dt);
  }
  // Steady orbit cruise: a light, compact exhaust (short lenScale like the other fighters), not a
  // full burn — they're holding a relaxed throttle, not accelerating hard.
  if (ud.engines) updateEngineTrails(e, dt, 0.18, camera, false, 1, ud.vel, false, 0.25);
}

// Mission 2: seat a full squadron of fighters AT REST inside the carrier's hangars — one per bay
// anchor (8 bays = 4 per side). Each fighter is DOCKED: it sits parked at its bay, runs no AI and
// fires nothing, until the carrier launches it (markedForLaunch -> released by updateEnemies). They
// keep a back-reference to the carrier + their bay so they hold station as the carrier slowly rotates.
const _seatWorld = new THREE.Vector3();
function seatHangarFighters(capital) {
  const bays = capital.userData.bays;
  if (!bays || !bays.length) return;
  capital.updateMatrixWorld();
  for (let i = 0; i < bays.length; i++) {
    const bay = bays[i];
    _seatWorld.copy(bay).applyMatrix4(capital.matrixWorld);
    const kind = i % 4 === 0 ? 'bomber' : (i % 2 === 0 ? 'interceptor' : 'fighter');
    const f = applyDifficultyHp(makeEnemy(kind, _seatWorld.clone(), trails));
    f.userData.vel.set(0, 0, 0);
    f.userData.docked = true;          // parked in the hangar: no AI, no fire, holds at its bay
    f.userData.dockCapital = capital;  // carrier it's parked in
    f.userData.dockBay = bay.clone();  // local bay anchor it holds station on
    // Face roughly outward (nose toward the player side) so it reads as ready to scramble.
    f.lookAt(player.position);
    enemies.add(f);
  }
  capital.userData.dockedFighters = true;   // this carrier holds a parked squadron
}
// Scramble fighters out of a capital ship's launch bays. For the Mission-2 hangar squadron this
// RELEASES the DOCKED fighters (they fly out under AI); for any other capital it spawns fresh ones
// at the bays (legacy reinforcement behavior). Each released/spawned fighter gets an outward kick.
const _bayWorld = new THREE.Vector3();
const _bayOut = new THREE.Vector3();
function launchSquadron(capital, { all = false } = {}) {
  const bays = capital.userData.bays;
  if (!bays || !bays.length) return;
  capital.updateMatrixWorld();
  audio.play('enemyLaser', 0.3);                  // muffled launch thunk stand-in
  // Hangar squadron (Mission 2): release the still-docked fighters. `all` empties every bay at once
  // (the hull-hit reserve scramble); otherwise a 2-4 ship batch peels off (legacy behavior).
  if (capital.userData.dockedFighters) {
    const docked = enemies.children.filter(e =>
      e.userData.docked && e.userData.dockCapital === capital);
    if (!docked.length) return;
    const n = all ? docked.length : Math.min(docked.length, 2 + Math.floor(Math.random() * 3));
    for (let i = 0; i < n; i++) {
      const f = docked[i];
      const ud = f.userData;
      _bayOut.copy(f.position).sub(capital.position).normalize();   // outward from carrier center
      ud.docked = false;
      ud.dockCapital = null;
      ud.vel.copy(_bayOut).multiplyScalar(ud.speed * 1.4);
      ud.behavior = 'pursue';
      ud.behaviorT = 0.8 + Math.random() * 1.2;
    }
    return;
  }
  // Legacy reinforcement scramble (non-Mission-2 capitals): spawn fresh fighters at the bays.
  const n = 4 + Math.floor(Math.random() * 5);   // 4-8 fighters
  for (let i = 0; i < n; i++) {
    const bay = bays[i % bays.length];
    _bayWorld.copy(bay).applyMatrix4(capital.matrixWorld);
    // Outward direction = from the carrier center toward the bay, so fighters spill outward.
    _bayOut.copy(_bayWorld).sub(capital.position).normalize();
    const kind = Math.random() < 0.28 ? 'bomber' : (Math.random() < 0.5 ? 'interceptor' : 'fighter');
    const f = applyDifficultyHp(makeEnemy(kind, _bayWorld.clone().addScaledVector(_bayOut, 4 + Math.random() * 4), trails));
    // Launch velocity straight out of the bay; the AI takes over from there.
    f.userData.vel.copy(_bayOut).multiplyScalar(f.userData.speed * 1.4);
    f.userData.behavior = 'pursue';
    f.userData.behaviorT = 0.8 + Math.random() * 1.2;
    enemies.add(f);
  }
}

// Fraction of Mission 3 hostiles that press the crippled O.G. directly (the rest hunt the
// player/wingman). Scaled by difficulty so the escort is genuinely in jeopardy: Recruit keeps it
// beatable, Normal noticeably harder, Veteran/Ace brutal. Bombers ALWAYS go for O.G. on top of this.
function m3AttackOGFrac() {
  switch (settings.difficulty) {
    case 'recruit': return 0.55;
    case 'veteran': return 0.78;
    case 'ace':     return 0.88;
    default:        return 0.68;   // normal — harder than recruit
  }
}
// Multiplier applied to damage O.G. takes in Mission 3 (see damageAlly). Tuned so the escort is
// genuinely threatened — his bar visibly slides under sustained fire and he can be LOST if ignored —
// while staying winnable on Recruit and tense (not unfair) on Normal. Higher tiers bite hard.
function m3OGDamageMult() {
  // Reduced by 65% across all difficulties so O.G. soaks far less fire and the escort
  // stays survivable (prior values: recruit 2.0 / normal 3.0 / veteran 4.0 / ace 5.5).
  switch (settings.difficulty) {
    case 'recruit': return 0.70;
    case 'veteran': return 1.40;
    case 'ace':     return 1.925;
    default:        return 1.05;   // normal — noticeably tougher than recruit
  }
}
// ---- Mission 3 (PROTECT O.G.) reinforcement spawner -------------------------------------
// Drops a single fresh hostile into the escort engagement to keep pressure on during the
// 3-minute hold. Spawned at moderate range on a random bearing AROUND the crippled O.G. (so
// threats can approach from any side), with the majority — and every bomber — committed to
// pressing O.G. directly so the player has to actively intercept. The caller (updateMission)
// is responsible for capping the live fighter count so this never snowballs into a swarm.
const _m3Anchor = new THREE.Vector3();
const _m3Spawn = new THREE.Vector3();
function spawnMission3Fighter() {
  // Anchor the reinforcement on O.G. if he's still alive, otherwise on the player.
  if (protectOG && allies.children.includes(protectOG)) _m3Anchor.copy(protectOG.position);
  else _m3Anchor.copy(player.position);
  // Random bearing on a slightly-flattened sphere ~900-1400m out from the anchor.
  const az = Math.random() * Math.PI * 2;
  const el = THREE.MathUtils.randFloatSpread(0.7);   // shallow pitch so they arrive roughly in-plane
  const r = 900 + Math.random() * 500;
  _m3Spawn.set(
    Math.cos(el) * Math.cos(az),
    Math.sin(el) * 0.45,
    Math.cos(el) * Math.sin(az)
  ).multiplyScalar(r).add(_m3Anchor);
  const roll = Math.random();
  const kind = roll < 0.2 ? 'bomber' : roll < 0.55 ? 'drone' : 'interceptor';
  const f = applyDifficultyHp(makeEnemy(kind, _m3Spawn.clone(), trails));
  // Most reinforcements (and every bomber) make a run on the crippled O.G.; the rest hunt the
  // player/wingman. The O.G.-pressing share scales with difficulty (Normal harder than Recruit).
  // updateEnemies routes attacksOG bandits onto protectOG's position.
  if (kind === 'bomber' || Math.random() < m3AttackOGFrac()) f.userData.attacksOG = true;
  // Come in already pressing the engagement rather than idling at the spawn point.
  f.userData.behavior = 'pursue';
  f.userData.behaviorT = 0.8 + Math.random() * 1.4;
  enemies.add(f);
}

// Mission 3: repairs complete — bring O.G.'s engines back online. Clears the `damaged` flag (so
// the smoke trail stops, see updateAllies) and restores his cruise speed so he can fly normally
// again (and, narratively, make the jump). Safe to call once; no-op if he's already gone.
function restoreDamagedOG() {
  if (!protectOG || !allies.children.includes(protectOG)) return;
  const ud = protectOG.userData;
  if (!ud.damaged) return;
  ud.damaged = false;
  ud.ogCrit = false;   // repairs done: clear the critical-hull smoke escalation too
  if (ud.fullSpeed != null) ud.speed = ud.fullSpeed;
  // A small "engines relight" flash from the tail to sell the moment.
  _ogTail.set(0, 0, 1).applyQuaternion(protectOG.quaternion).normalize();
  spark(explosions, protectOG.position.clone().addScaledVector(_ogTail, 3.0), 0x9fe8ff);
}

// ---- Capital ship point-defense turrets -------------------------------------------------
// Each turret independently tracks the player: its yaw pivot swings toward the bearing and its
// pitch pivot elevates, both clamped to a sweep arc and rate-limited so the guns visibly
// traverse rather than snapping. When the player is within range AND the barrels are roughly on
// target, the turret fires aimed bolts from its muzzles on its own cooldown. Dead turrets stop.
const _tWorldPos = new THREE.Vector3(), _tLocalTarget = new THREE.Vector3();
const _tMuzzleWorld = new THREE.Vector3(), _tMuzzleDir = new THREE.Vector3();
const _tParentInv = new THREE.Matrix4(), _tForward = new THREE.Vector3();
const _tMuzzleQuat = new THREE.Quaternion(), _tToPlayer = new THREE.Vector3();
// Pick the nearest valid hostile-to-capital target for a turret at `fromPos`: the player or any
// live, on-stage allied ship (wingmen / O.G. / flagship). Returns the target's world Vector3
// position (player.position or an ally.position) or null if nothing is in range. The Dreadnought is
// hostile to the player AND his allies, so its point-defense should engage whichever is closest.
function pickTurretTarget(fromPos, range) {
  let best = null, bestD = range;
  // The player is always a candidate (he respawns rather than staying dead).
  {
    const d = fromPos.distanceTo(player.position);
    if (d < bestD) { bestD = d; best = player.position; }
  }
  for (const a of allies.children) {
    const ud = a.userData;
    if (!ud || ud.introHold) continue;           // held off-stage wingman: not engageable yet
    if (ud.hp != null && ud.hp <= 0) continue;    // dead ally
    const d = fromPos.distanceTo(a.position);
    if (d < bestD) { bestD = d; best = a.position; }
  }
  return best;
}
function updateCapitalTurrets(capital, dt) {
  const turrets = capital.userData.turrets;
  if (!turrets || !turrets.length) return;
  capital.updateMatrixWorld();
  const TURN_RATE = 1.8;          // radians/sec the turret can traverse
  const MAX_PITCH = 1.15;         // elevation clamp (radians) so guns don't fold backward
  const RANGE = 340;
  for (const t of turrets) {
    if (!t.alive) continue;
    const base = t.group;
    base.updateMatrixWorld();
    base.getWorldPosition(_tWorldPos);
    // Engage whichever hostile (player or allied ship) is nearest and in range.
    const target = pickTurretTarget(_tWorldPos, RANGE);
    if (!target) { t.fireT = Math.max(t.fireT, 0.2); continue; }   // nothing to shoot — idle briefly
    const dist = _tWorldPos.distanceTo(target);

    // Express the target's position in the YAW pivot's parent (base) local space so we can derive
    // the yaw angle (about local Y) and pitch angle (elevation) the turret should hold.
    _tParentInv.copy(base.matrixWorld).invert();
    _tLocalTarget.copy(target).applyMatrix4(_tParentInv);
    // Yaw: angle in the local XZ plane. Turret head's forward is local -Z, so target yaw aligns
    // -Z with the target bearing.
    const wantYaw = Math.atan2(_tLocalTarget.x, -_tLocalTarget.z);
    // Pitch: elevation above the XZ plane, clamped so the barrels stay within their arc.
    const horiz = Math.hypot(_tLocalTarget.x, _tLocalTarget.z);
    let wantPitch = Math.atan2(_tLocalTarget.y, horiz);
    wantPitch = THREE.MathUtils.clamp(wantPitch, -0.25, MAX_PITCH);

    // Smoothly traverse toward the desired angles (shortest-path for yaw).
    const maxStep = TURN_RATE * dt;
    let dy = wantYaw - t.yaw.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    t.yaw.rotation.y += THREE.MathUtils.clamp(dy, -maxStep, maxStep);
    // The cradle's barrels point along -Z and we want positive pitch to raise the muzzle, which
    // is a negative rotation about local X.
    const dp = (-wantPitch) - t.pitch.rotation.x;
    t.pitch.rotation.x += THREE.MathUtils.clamp(dp, -maxStep, maxStep);

    // Fire when in range, roughly on target, and off cooldown.
    t.fireT -= dt;
    if (dist < RANGE && t.fireT <= 0) {
      const muzzle = t.muzzles[t.nextMuzzle % t.muzzles.length];
      t.nextMuzzle++;
      muzzle.getWorldPosition(_tMuzzleWorld);
      // Muzzle forward is its local -Z in world space.
      _tForward.set(0, 0, -1);
      _tMuzzleDir.copy(_tForward).applyQuaternion(muzzle.getWorldQuaternion(_tMuzzleQuat)).normalize();
      // Only fire if the barrel is actually pointing within ~18° of the target (otherwise the
      // turret is still slewing onto target).
      _tToPlayer.copy(target).sub(_tMuzzleWorld).normalize();
      if (_tMuzzleDir.dot(_tToPlayer) > 0.95) {
        t.fireT = 0.55 + Math.random() * 0.35;
        // Aim slightly toward the target with light spread so turrets are dangerous but beatable.
        _tMuzzleDir.lerp(_tToPlayer, 0.6).normalize();
        _tMuzzleDir.x += (Math.random() - 0.5) * 0.04;
        _tMuzzleDir.y += (Math.random() - 0.5) * 0.04;
        _tMuzzleDir.z += (Math.random() - 0.5) * 0.04;
        _tMuzzleDir.normalize();
        const start = _tMuzzleWorld.clone().addScaledVector(_tMuzzleDir, 1.5);
        boltGroup.add(makeBolt(start, _tMuzzleDir, false, 10));
        spark(explosions, start, 0xff7a44);
        audio.play('enemyLaser', 0.18);
      } else {
        t.fireT = 0.12;   // recheck soon while slewing
      }
    }
  }
}

// Apply damage to a single capital turret and destroy it (with a blast) when its HP runs out.
function damageTurret(capital, t, dmg, hitPos) {
  if (!t.alive) return;
  t.hp -= dmg;
  spark(explosions, hitPos, 0xfff0c0);
  // The carrier counts turret hits as being under attack, prompting squadron scrambles.
  capital.userData.aggroT = 8;
  if (t.hp <= 0) {
    t.alive = false;
    t.group.visible = false;
    t.group.getWorldPosition(_tWorldPos);
    explode(explosions, _tWorldPos.clone(), 0xff7a3c, 1.4);
    audio.play('explosion', 0.4);
    state.score += 60;
  }
}

// ---- Dreadnought shield generators (Mission 2) -----------------------------------------------
// The capital is protected by two generators. Damage taken by the HULL is multiplied by this:
//   both generators alive -> ~3% (almost invulnerable, pure deflection)
//   one generator down    -> ~18% (takes a real but slow bite)
//   both generators down  -> 100% (shield collapsed, the hull is soft)
function liveShieldGens(capital) {
  const gens = capital.userData.shieldGens;
  if (!gens) return 0;
  let n = 0; for (const sg of gens) if (sg.alive) n++; return n;
}
function capitalDamageMult(capital) {
  const n = liveShieldGens(capital);
  if (n >= 2) return 0.03;
  if (n === 1) return 0.18;
  return 1;   // shields collapsed
}
// Apply damage to a single shield generator; destroy it (blast + collapse the dome) at 0 HP.
function damageShieldGen(capital, sg, dmg, hitPos) {
  if (!sg.alive) return;
  sg.hp -= dmg;
  spark(explosions, hitPos, 0x6fe9ff);
  capital.userData.aggroT = 8;   // counts as the carrier being under attack (triggers scrambles)
  if (sg.hp <= 0) {
    sg.alive = false;
    sg.group.getWorldPosition(_tWorldPos);
    explode(explosions, _tWorldPos.clone(), 0x66e0ff, 2.6);
    audio.play('explosion', 0.55);
    state.score += 300;
    // Dim/collapse the visible dome + ring so the destroyed generator reads as dead.
    sg.dome.visible = false;
    sg.ring.visible = false;
    const remaining = liveShieldGens(capital);
    if (remaining === 1) flash('DREADNOUGHT SHIELD WEAKENING');
    else if (remaining === 0) flash('DREADNOUGHT SHIELDS DOWN — HIT THE HULL');
    // Wingman generator-down callouts (Mission 2 only): FIRST gen down -> a random SLICK line,
    // SECOND gen down -> a random O.G. line. Each fires at most once, cycling its five clips.
    if (mission2Active()) {
      if (remaining === 1 && !_firstGenCalled) {
        _firstGenCalled = true;
        allySpeak('SLICK', pickGenClip(SLICK_GEN_CLIPS), 0.95);
      } else if (remaining === 0 && !_secondGenCalled) {
        _secondGenCalled = true;
        allySpeak('O.G.', pickGenClip(OG_GEN_CLIPS), 0.95);
      }
    }
  }
}
// Visual "shield deflection" when a bolt/missile is bled off the still-shielded hull: a cyan
// spark at the impact, a flicker ripple on the energy dome at the strike point, plus a quick
// emissive pulse on every live generator dome.
function shieldDeflect(capital, hitPos) {
  spark(explosions, hitPos, 0x7fe8ff);
  registerShieldHit(capital, hitPos);   // bloom a bright ripple on the energy dome where it struck
  const gens = capital.userData.shieldGens;
  if (gens) for (const sg of gens) if (sg.alive && sg.domeMat) sg.domeMat.emissiveIntensity = 3.2;
}
// Accumulating clock for the energy-dome shader animation (drift, scan band, ripple ages).
let _shieldClock = 0;
// Per-frame upkeep for a capital's generators: spin the energy rings, ease the deflection pulse
// back to rest, and drive the enveloping energy DOME (opacity scaled by surviving generators:
// 2 alive -> full, 1 alive -> half, 0 -> gone). Called from the capital branch of the loop.
function updateShieldGens(capital, dt) {
  _shieldClock += dt;
  // Steady-shield STRENGTH from generator count. The dome is deliberately subtle so it never
  // commands the screen — these low values feed only the faint background glow; impact flashes are
  // driven separately (and stay bright) in the shader. Both gens -> subtle; one gen -> even fainter
  // (but still effective at deflecting fire); none -> shield off entirely.
  const n = liveShieldGens(capital);
  const strength = n >= 2 ? 0.55 : n === 1 ? 0.28 : 0;
  updateShieldDome(capital, _shieldClock, strength, dt);
  const gens = capital.userData.shieldGens;
  if (!gens) return;
  for (const sg of gens) {
    if (!sg.alive) continue;
    sg.spin = (sg.spin + dt * 1.6) % (Math.PI * 2);
    if (sg.ring) sg.ring.rotation.z = sg.spin;
    if (sg.domeMat && sg.domeMat.emissiveIntensity > 1.6) {
      sg.domeMat.emissiveIntensity = Math.max(1.6, sg.domeMat.emissiveIntensity - dt * 6);
    }
  }
}

// Enemy weapon fire with accuracy that improves as range closes, but is capped so basic
// fighters are never laser-precise. `accuracyMul` lets weaker craft (drones) be sloppier and
// the capital ship be steady. The shot direction gets a random angular spread, so plenty of
// bolts miss — the player is never guaranteed to be hit by every enemy shot.
const _spreadAxis = new THREE.Vector3();
function enemyFire(e, dirToPlayer, dist, accuracyMul = 1) {
  // accuracy 0..1: ~0.25 far out, climbing toward a hard cap up close. Capped at 0.8 so even a
  // point-blank shot has meaningful spread for basic enemies.
  const near = THREE.MathUtils.clamp(1 - dist / 150, 0, 1);
  const accuracy = THREE.MathUtils.clamp((0.2 + near * 0.65) * accuracyMul, 0, 0.8);
  // Spread cone half-angle (radians): high when inaccurate, shrinking as accuracy rises.
  const spread = THREE.MathUtils.lerp(0.16, 0.012, accuracy);
  _aimDir.copy(dirToPlayer);
  // Tilt the aim by a random angle within the spread cone, about a random perpendicular axis.
  _spreadAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  const ang = (Math.random() * 0.6 + 0.4) * spread * (Math.random() < 0.5 ? -1 : 1);
  _aimDir.applyAxisAngle(_spreadAxis, ang).normalize();
  // Originate the bolt from an actual gun muzzle (alternating between them) rather than the ship
  // center. Muzzle groups are parented to the hull, so getWorldPosition tracks the muzzle as the
  // enemy banks. Fall back to the ship center + nose offset if the model's muzzles aren't ready yet.
  const muzzles = e.userData.muzzles;
  if (muzzles && muzzles.length) {
    e.userData.nextMuzzle = ((e.userData.nextMuzzle || 0) + 1) % muzzles.length;
    muzzles[e.userData.nextMuzzle].getWorldPosition(_enemyMuzzleWorld);
  } else {
    _enemyMuzzleWorld.copy(e.position).addScaledVector(_aimDir, 2);
  }
  boltGroup.add(makeBolt(_enemyMuzzleWorld.clone(), _aimDir, false, 8));
  audio.play('enemyLaser', 0.22);
}
const _enemyMuzzleWorld = new THREE.Vector3();
function killEnemy(e, score = true, killer = null) {
  // FLIGHT SCHOOL: containers and tutorial bandits feed the tutorial step machine instead of the
  // campaign score/achievements. Track them, then run the normal destruction VFX below.
  if (tutorialMode) {
    if (e.userData.kind === 'container') tutorial.notifyContainerDestroyed();
    else if (e.userData.tutorialFighter) tutorial.notifyFighterDestroyed();
    score = false;   // no campaign scoring/achievements during training
  }
  if (score) {
    const isCapital = e.userData.kind === 'capital';
    state.score += isCapital ? 1200 : 100;
    // Session kill tally (the headline leaderboard stat) + difficulty-aware achievement checks.
    state.kills += 1;
    // Ranking: single-player kills also advance the lifetime career total (primary rank metric).
    // A capital ship is a far bigger prize, so it credits several career kills' worth of progress.
    leaderboard.addCareerKills(isCapital ? 5 : 1);
    if (isCapital) awardAchievement('capital_kill');
    // A missile finished it off if the warhead tagged it just before death (set at the missile
    // damage sites). Counts toward the Sharpshooter achievement.
    if (e.userData._killedByMissile) state.missileKills += 1;
    checkKillAchievements();
  }
  // Destruction blast: scale the explosion up for bigger craft so a capital ship erupts far
  // larger than a fighter. Tint with the enemy's faction-ish hue (warm crimson-orange).
  if (e.userData.kind === 'capital') {
    // Capital ships go up in a huge staggered chain reaction with hull chunks. Spread the
    // secondary blasts along the hull's nose axis (local -Z) and size by its radius.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(e.quaternion);
    explode(explosions, e.position, 0xff7a3c, 6.5, { capital: true, dir, length: (e.userData.radius || 12) * 2.2 });
    audio.play('explosion', 0.95);
    setTimeout(() => audio.play('explosion', 0.7), 280);
    setTimeout(() => audio.play('explosion', 0.6), 720);
    // Mission 2 (the scripted CAPITAL STRIKE): cue the "dreadnought down" wingman callout when the
    // enemy capital erupts. Slight delay so it lands over the chain-reaction blasts, not before.
    if (mission && mission.capital && (missionIndex % missions.length) === 1) {
      setTimeout(() => { const el = audio.playClip('assets/audio/voice/mission-2/dreaddownm2.mp3', 0.95); captionVoice('assets/audio/voice/mission-2/dreaddownm2.mp3', 'SLICK', el); }, 600);
    }
  } else {
    const scale = (e.userData.radius || 1.5) * 0.8 + 0.6;
    explode(explosions, e.position, 0xff7a3c, scale);
    audio.play('explosion', 0.55);
  }
  // Wingman KILL confirmation: if a named wingman (Slick/O.G.) scored this kill, that pilot calls
  // it out. Works in ANY mission those wingmen are present. Takes priority over the rescue bark so
  // a single kill doesn't fire two overlapping lines.
  const killerKind = wingmanKind(killer);
  if (killerKind && !tutorialMode) {
    playWingmanKillBark(killerKind);
  } else {
    // Wingman rescue: if this bandit was actively pressing a named wingman (Slick/O.G.) and that
    // wingman is still alive, the saved pilot calls in a quick thank-you. Works in ANY mission.
    const savedKind = e.userData.threatensWingman;
    if (savedKind && !tutorialMode) {
      const stillAlive = allies.children.some(a =>
        wingmanKind(a) === savedKind && (a.userData.hp == null || a.userData.hp > 0));
      if (stillAlive) playWingmanRescueBark(savedKind);
    }
  }
  // Free the ship's world-space exhaust meshes too — they live in the scene-level trail group,
  // not under the ship, so removing the ship alone would leave the beam frozen on screen.
  disposeEngineEffects(e);
  enemies.remove(e);
}

// ---- Allied ("good guy") AI -------------------------------------------------------------------
// Friendly ships fight on the player's side: escort fighters hunt the nearest hostile and the
// flagship holds station while its turrets blast attackers. Allied fighters fly with the same
// heading-based, bank-and-turn model as the enemies (so they read as real aircraft), but they
// chase ENEMIES instead of the player, and their bolts are friendly (they damage hostiles).
const _allyTo = new THREE.Vector3(), _allyDir = new THREE.Vector3(), _allyDesired = new THREE.Vector3();
const _allyNose = new THREE.Vector3(), _allyTargetQuat = new THREE.Quaternion();
const _allySide = new THREE.Vector3(), _allyUp = new THREE.Vector3(), _allyAimDir = new THREE.Vector3();
const _allyBankMat = new THREE.Matrix4(), _allyBankUp = new THREE.Vector3(), _allyBankRight = new THREE.Vector3();
const _allyLook = new THREE.Vector3(), _allyHomeFlat = new THREE.Vector3(0, 1, 0);
// Pick the closest living enemy to a given position (used for ally target acquisition).
function nearestEnemyTo(pos, maxDist = Infinity) {
  let best = null, bestD = maxDist;
  for (const e of enemies.children) {
    const d = e.position.distanceTo(pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
// Pick the closest living NON-capital hostile (a fighter/bomber/drone). Used by the wingmen when
// they peel off to cover the player, and as a fallback fighter target.
function nearestFighterTo(pos, maxDist = Infinity) {
  let best = null, bestD = maxDist;
  for (const e of enemies.children) {
    if (e.userData.kind === 'capital') continue;
    const d = e.position.distanceTo(pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
// Nearest live, on-stage named wingman (Slick / O.G.) to a world position, or null.
function nearestWingmanTo(pos, maxDist = Infinity) {
  let best = null, bestD = maxDist;
  for (const a of allies.children) {
    if (!a.userData.wingman || a.userData.introHold) continue;
    const d = a.position.distanceTo(pos);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}
// Return 'slick' | 'og' if the given ally is one of the two named wingmen, else null.
function wingmanKind(ally) {
  if (!ally || !ally.userData) return null;
  const k = ally.userData.kind;
  return (k === 'slick' || k === 'og') ? k : null;
}
// Tag an enemy as currently threatening a named wingman (Slick/O.G.) so that destroying it can
// trigger that wingman's rescue thank-you. No-op for non-named allies (e.g. the DEFEND flagship).
function markWingmanThreat(ud, ally) {
  const k = wingmanKind(ally);
  if (k) ud.threatensWingman = k;
}
// The enemy capital ship in play (the carrier the wingmen are cracking), or null.
function enemyCapital() {
  for (const e of enemies.children) if (e.userData.kind === 'capital') return e;
  return null;
}
// Closest living turret/battery on the given capital to a world position, returning {ctrl, world}
// where `world` is the turret's world position. Returns null if every battery is dead/gone.
const _turWorld = new THREE.Vector3();
function nearestCapitalBattery(cap, pos) {
  const turrets = cap && cap.userData.turrets;
  if (!turrets || !turrets.length) return null;
  cap.updateMatrixWorld();
  let best = null, bestD = Infinity, bestWorld = null;
  for (const t of turrets) {
    if (!t.alive || !t.group) continue;
    t.group.getWorldPosition(_turWorld);
    const d = _turWorld.distanceTo(pos);
    if (d < bestD) { bestD = d; best = t; bestWorld = _turWorld.clone(); }
  }
  return best ? { ctrl: best, world: bestWorld } : null;
}
// The OTHER named wingman (Slick<->O.G.), live and on-stage, or null.
function otherWingman(a) {
  for (const o of allies.children) {
    if (o !== a && o.userData.wingman && !o.userData.introHold) return o;
  }
  return null;
}
// Find an ally (other than `a`) currently in distress that this wingman should peel off to help —
// the OTHER wingman or a stock escort fighter taking fire. Returns the NEAREST such ally so help
// goes to whoever's closest, or null if everyone's clear. Flagships hold station and aren't covered.
function allyInDistress(a) {
  let best = null, bestD = Infinity;
  for (const o of allies.children) {
    const ou = o.userData;
    if (o === a || ou.introHold || ou.kind === 'flagship') continue;
    if ((ou.distress || 0) <= 0) continue;
    const d = a.position.distanceTo(o.position);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}
// Pick a fighter for a wingman near `pos`, but BIAS AWAY from whatever the other wingman is already
// engaging, so Slick and O.G. naturally split targets and cover the battlespace independently
// instead of dogpiling the same bandit and flying an identical pattern.
function wingmanPickFighter(a, pos, maxDist = Infinity) {
  const mate = otherWingman(a);
  const mateTgt = mate && mate.userData.target;
  let best = null, bestScore = Infinity;
  for (const e of enemies.children) {
    if (e.userData.kind === 'capital') continue;
    let score = e.position.distanceTo(pos);
    if (score > maxDist) continue;
    // Heavy penalty if the other wingman already owns this fighter, so we prefer a different one
    // (but can still fall back to it if it's the only contact around).
    if (e === mateTgt) score += 100000;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}
// Pick a LIVE shield generator for a wingman, biasing AWAY from the generator the other wingman is
// already striking, so Slick and O.G. split the two generators between them and work them in
// parallel. Returns { ctrl, world } or null when no live generator remains.
const _wmGenWorld = new THREE.Vector3(), _wmGenHit = new THREE.Vector3();
function wingmanPickGenerator(a, cap) {
  const gens = cap && cap.userData.shieldGens;
  if (!gens || !gens.length) return null;
  cap.updateMatrixWorld();
  const mate = otherWingman(a);
  const mateGen = mate && mate.userData.genTarget;
  let best = null, bestScore = Infinity, bestWorld = null;
  for (const sg of gens) {
    if (!sg.alive || !sg.group) continue;
    sg.group.getWorldPosition(_wmGenWorld);
    let score = _wmGenWorld.distanceTo(a.position);
    if (sg === mateGen) score += 100000;   // let the other pilot keep his generator
    if (score < bestScore) { bestScore = score; best = sg; bestWorld = _wmGenWorld.clone(); }
  }
  return best ? { ctrl: best, world: bestWorld } : null;
}
// Pick a capital battery for a wingman, biasing AWAY from the turret the other wingman is closing
// on, so the two strafe DIFFERENT batteries and spread fire across the hull.
const _wmBattWorld = new THREE.Vector3();
function wingmanPickBattery(a, cap) {
  const turrets = cap && cap.userData.turrets;
  if (!turrets || !turrets.length) return null;
  cap.updateMatrixWorld();
  const mate = otherWingman(a);
  const mateBatt = mate && mate.userData.battTarget;
  let best = null, bestScore = Infinity, bestWorld = null;
  for (const t of turrets) {
    if (!t.alive || !t.group) continue;
    t.group.getWorldPosition(_wmBattWorld);
    let score = _wmBattWorld.distanceTo(a.position);
    if (t === mateBatt) score += 100000;   // let the other pilot have his battery
    if (score < bestScore) { bestScore = score; best = t; bestWorld = _wmBattWorld.clone(); }
  }
  if (best) a.userData.battTarget = best;   // remember so the mate avoids it next frame
  return best ? { ctrl: best, world: bestWorld } : null;
}
function updateAllies(dt) {
  // Decay the rolling player-damage signal, then drive the wingmen's shared role with hysteresis:
  // climb past the upper threshold (or hull genuinely low) and Slick & O.G. break to COVER the
  // player; once it calms back below the lower threshold AND the player is healthy again, they
  // return to pressing the capital's BATTERIES.
  recentPlayerDamage = Math.max(0, recentPlayerDamage - dt * 22);
  const hullLow = state.hull < 45;
  if (!wingmenCovering) {
    if (recentPlayerDamage > 70 || hullLow) wingmenCovering = true;
  } else {
    if (recentPlayerDamage < 25 && state.hull > 60) wingmenCovering = false;
  }
  for (const a of [...allies.children]) {
    const ud = a.userData;

    // Wingman held off-stage for the scripted Mission 2 intro: frozen + hidden until released.
    if (ud.introHold) continue;

    // ---- Mission 3: the DAMAGED O.G. trails smoke from his wrecked engines while he fights ----
    // He still flies (the wingman AI below drives him), but a missile gutted his thrusters, so as
    // long as `damaged` is set he pours smoke + the occasional ember from the tail. Cleared when
    // repairs complete (see updateMission → restoreDamagedOG).
    if (ud.damaged) {
      // Once O.G. is beaten below 50% hull (ud.ogCrit, set in damageAlly), the damage reads as
      // critical: the smoke comes faster and bigger, scatters wider, and throws more fire/embers
      // from the tail than his baseline "wrecked engines" trail.
      const crit = !!ud.ogCrit;
      ud.smokeAt = (ud.smokeAt || 0) - dt;
      if (ud.smokeAt <= 0) {
        ud.smokeAt = crit ? 0.035 : 0.07;        // critical: ~2x emission rate
        _ogTail.set(0, 0, 1).applyQuaternion(a.quaternion).normalize();
        _ogSmokePos.copy(a.position).addScaledVector(_ogTail, 3.2)
          .add(new THREE.Vector3().randomDirection().multiplyScalar(crit ? 1.5 : 0.9));
        spawnSmokePuff(explosions, _ogSmokePos, (crit ? 2.0 : 1.4) + Math.random() * (crit ? 1.6 : 1.0));
        // Critical hull throws fiery embers far more often (and a brighter core) than the baseline.
        if (Math.random() < (crit ? 0.55 : 0.25)) {
          spark(explosions, _ogSmokePos.clone(), Math.random() < 0.5 ? 0xff5a28 : 0xffb347);
        }
      }
      // Fall through to the wingman flight AI so he keeps fighting (throttled by his reduced speed).
    }

    if (ud.kind === 'flagship') {
      // The flagship holds station, slowly turning, while its turrets do the fighting.
      a.rotation.y += dt * 0.03;
      updateAllyTurrets(a, dt);
      if (ud.engines) updateEngineTrails(a, dt, 0.3, camera, false, 6, ud.vel);
      continue;
    }

    // ---- Named wingmen (Slick & O.G.): scripted capital-battery strike + cover-the-player AI ----
    if (ud.wingman) { updateWingman(a, dt); continue; }

    // ---- Target acquisition: lock the nearest hostile, refreshing if it dies or strays far. ----
    if (!ud.target || !enemies.children.includes(ud.target) || a.position.distanceTo(ud.target.position) > 600) {
      ud.target = nearestEnemyTo(a.position, 700);
    }
    const tgt = ud.target;
    // With no enemies left, allied fighters form back up loosely near the flagship (or origin).
    const anchor = defendTarget && allies.children.includes(defendTarget) ? defendTarget.position : _ORIGIN;
    const aimPos = tgt ? tgt.position : anchor;
    _allyTo.copy(aimPos).sub(a.position);
    const dist = _allyTo.length();
    _allyDir.copy(_allyTo).multiplyScalar(1 / Math.max(dist, 1e-4));

    // ---- Heading: pursue the target (or return to formation when idle) ----
    _allyUp.set(0, 1, 0);
    _allySide.crossVectors(_allyDir, _allyUp).normalize();
    if (tgt) {
      // Close to a firing position, then strafe across the target instead of ramming it.
      if (dist > 40) _allyDesired.copy(_allyDir);
      else { _allyDesired.copy(_allySide).multiplyScalar(ud.strafeDir).addScaledVector(_allyDir, -0.1); }
    } else {
      // No targets: ease back toward the anchor, but don't pile onto it.
      _allyDesired.copy(_allyDir).multiplyScalar(dist > 60 ? 1 : -0.4);
    }
    // Gentle weave so paths curve.
    ud.jinkPhase += ud.jinkRate * dt;
    _allyDesired.addScaledVector(_allySide, Math.sin(ud.jinkPhase) * 0.25);
    _allyDesired.addScaledVector(_allyUp, Math.cos(ud.jinkPhase * 0.7) * 0.15);
    // Separation from other allies so the wing doesn't stack up.
    for (const o of allies.children) {
      if (o === a || o.userData.kind === 'flagship' || o.userData.introHold) continue;
      _sep.copy(a.position).sub(o.position);
      const d2 = _sep.length();
      if (d2 > 0.001 && d2 < 8) _allyDesired.addScaledVector(_sep.multiplyScalar(1 / d2), (8 - d2) * 0.5);
    }
    if (_allyDesired.lengthSq() < 1e-6) _allyDesired.copy(_allyDir);
    _allyDesired.normalize();

    // ---- Bank-and-turn orientation (mirrors the enemy flight model) ----
    _allyNose.copy(_ENEMY_FWD).applyQuaternion(a.quaternion).normalize();
    _allyBankRight.crossVectors(_allyNose, _allyHomeFlat).normalize();
    if (_allyBankRight.lengthSq() < 1e-6) _allyBankRight.set(1, 0, 0);
    const turnSign = _headingDelta.copy(_allyDesired).sub(_allyNose).dot(_allyBankRight);
    const targetBank = THREE.MathUtils.clamp(turnSign * 2.6, -1, 1) * 1.05;
    ud.bank = (ud.bank || 0) + (targetBank - (ud.bank || 0)) * (1 - Math.pow(0.02, dt));
    _allyBankUp.copy(_allyHomeFlat).applyAxisAngle(_allyDesired, ud.bank);
    // Aim the look target AHEAD along the heading so the nose (local -Z) faces the flight path.
    // (See the enemy flight model: Matrix4.lookAt points -Z at the target, so the target must be
    // ahead of the ship, not behind it.)
    _allyLook.copy(a.position).addScaledVector(_allyDesired, 1);
    _allyBankMat.lookAt(a.position, _allyLook, _allyBankUp);
    _allyTargetQuat.setFromRotationMatrix(_allyBankMat);
    a.quaternion.slerp(_allyTargetQuat, 1 - Math.pow(0.045, dt));

    // Thrust forward along the nose.
    const throttle = (tgt && dist < 24) ? 0.35 : 1;
    _allyNose.copy(_ENEMY_FWD).applyQuaternion(a.quaternion).normalize();
    ud.vel.copy(_allyNose).multiplyScalar(ud.speed * throttle);
    a.position.addScaledVector(ud.vel, dt);

    // Engine exhaust (blue, short streaks like the enemies).
    if (ud.engines) {
      const eSpeed01 = THREE.MathUtils.clamp(ud.vel.length() / (ud.speed * 1.6), 0, 1);
      updateEngineTrails(a, dt, eSpeed01, camera, false, 1, ud.vel, false, 0.25);
    }

    // ---- Firing at the target ----
    ud.fireT -= dt;
    if (tgt && ud.fireT <= 0 && dist < 200) {
      _allyAimDir.set(0, 0, -1).applyQuaternion(a.quaternion);
      if (_allyAimDir.dot(_allyDir) > 0.3 || dist < 40) {
        ud.fireT = 0.6 + Math.random() * 0.7;
        allyFire(a, _allyDir, dist);
      } else {
        ud.fireT = 0.15;
      }
    }
  }
}
const _ORIGIN = new THREE.Vector3(0, 0, 0);
// Mission 3 damaged-O.G. scratch (engine-smoke emission point).
const _ogTail = new THREE.Vector3(), _ogSmokePos = new THREE.Vector3();
// Allied fighter weapon fire — friendly (blue) bolts that damage enemies. Mild spread so allies
// are helpful but not flawless marksmen.
function allyFire(a, dirToEnemy, dist) {
  _allyAimDir.copy(dirToEnemy);
  _spreadAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  const spread = THREE.MathUtils.lerp(0.12, 0.02, THREE.MathUtils.clamp(1 - dist / 200, 0, 1));
  _allyAimDir.applyAxisAngle(_spreadAxis, (Math.random() - 0.5) * 2 * spread).normalize();
  const start = a.position.clone().addScaledVector(_allyAimDir, 2.5);
  boltGroup.add(makeBolt(start, _allyAimDir, true, 16));
  audio.play('laser', 0.16);
}
// ---- Named wingman AI: Slick & O.G. ------------------------------------------------------------
// Two scripted hero wingmen for the CAPITAL STRIKE mission. Behavior:
//   - On spawn they ride a brief warp-in slide (arriveT) forward into a loose formation off the
//     player's wing, so they read as dropping out of hyperspace alongside the player.
//   - Default role 'batteries': they hunt the enemy capital's point-defense turrets, strafing in
//     and hosing them with friendly bolts (which updateBolts already routes to damageTurret),
//     softening the carrier so it's more vulnerable while the PLAYER clears fighters.
//   - If the player is taking heavy damage (wingmenCovering), they switch to 'cover': peel off and
//     engage the enemy fighters threatening the player, then return to the batteries once it calms.
// They use the same heading-based bank-and-turn flight model as the other allies.
const _wmTo = new THREE.Vector3(), _wmDir = new THREE.Vector3(), _wmDesired = new THREE.Vector3();
const _wmNose = new THREE.Vector3(), _wmQuat = new THREE.Quaternion(), _wmSide = new THREE.Vector3();
const _wmUp = new THREE.Vector3(), _wmBankUp = new THREE.Vector3(), _wmBankRight = new THREE.Vector3();
const _wmLook = new THREE.Vector3(), _wmMat = new THREE.Matrix4(), _wmAim = new THREE.Vector3();
const _wmHomeFlat = new THREE.Vector3(0, 1, 0), _wmFormPos = new THREE.Vector3(), _wmSep = new THREE.Vector3();
const _FWD0 = new THREE.Vector3(), _wmTmpOff = new THREE.Vector3();
function updateWingman(a, dt) {
  const ud = a.userData;
  if (ud.distress > 0) ud.distress = Math.max(0, ud.distress - dt);   // decay own distress flag
  // Peel-off priority: cover the PLAYER if they're in trouble; else SUPPORT any ally under fire
  // (the other wingman OR a stock escort); otherwise press the mission objective (generators ->
  // Dreadnought). The objective is primary, but a friendly being shot at always pulls them off it.
  const friendInTrouble = allyInDistress(a);
  ud.role = wingmenCovering ? 'cover' : (friendInTrouble ? 'support' : 'batteries');

  // ---- Pick the objective point this frame ----
  // aimPos = where we want to fly toward; fireTarget = the world point we shoot at (may be null).
  let aimPos = null, fireTarget = null, fireDist = Infinity, closeRange = 30;
  const arriving = (ud.arriveT || 0) > 0;
  if (arriving) {
    // Warp-in slide: tuck into the formation slot off the player's wing at high speed.
    ud.arriveT -= dt;
    _wmFormPos.copy(player.position)
      .addScaledVector(_FWD0.set(0, 0, -1).applyQuaternion(player.quaternion).normalize(), -(ud.formOffset.z))
      .add(_wmTmpOff.set(ud.formOffset.x, ud.formOffset.y, 0));
    aimPos = _wmFormPos;
  } else if (ud.role === 'cover') {
    // Cover the player: engage a fighter near the PLAYER, but prefer one the OTHER wingman isn't
    // already on so the two don't dogpile the same bandit.
    const t = wingmanPickFighter(a, player.position, 500) || wingmanPickFighter(a, a.position, 700);
    if (t) { ud.target = t; aimPos = t.position; fireTarget = t.position; fireDist = a.position.distanceTo(t.position); }
  } else if (ud.role === 'support') {
    // An ally is under fire — go bail them out: engage whichever fighter is nearest the friendly
    // in trouble, falling back to the one nearest us if that area's already clear.
    const helpPos = friendInTrouble ? friendInTrouble.position : a.position;
    const t = wingmanPickFighter(a, helpPos, 600) || wingmanPickFighter(a, a.position, 700);
    if (t) { ud.target = t; aimPos = t.position; fireTarget = t.position; fireDist = a.position.distanceTo(t.position); }
  } else {
    // PRIMARY MISSION ROLE: dismantle the Dreadnought's SHIELD GENERATORS. Slick and O.G. fly
    // continuous strafing passes on the generators, each picking a DIFFERENT live gen so they split
    // the two between them, chewing them down over time (they can destroy both on their own — see
    // the per-pass generator damage in wingmanFire). Only once the shields are fully down do they
    // fall back to the point-defense batteries, then the bare hull.
    const cap = enemyCapital();
    ud.genTarget = null;   // cleared unless we lock a generator this frame
    const gen = cap ? wingmanPickGenerator(a, cap) : null;
    if (gen) {
      ud.target = cap; ud.genTarget = gen.ctrl;
      aimPos = gen.world; fireTarget = gen.world; fireDist = a.position.distanceTo(gen.world);
      closeRange = 40;   // generators sit on the hull; hold off a bit and strafe across
    } else {
      const batt = cap ? wingmanPickBattery(a, cap) : null;
      if (batt) {
        ud.target = cap;
        aimPos = batt.world; fireTarget = batt.world; fireDist = a.position.distanceTo(batt.world);
        closeRange = 46;   // batteries sit on a huge hull, so hold farther off when strafing
      } else if (cap) {
        // Shields + batteries down: keep pressure on the carrier hull itself.
        ud.target = cap;
        aimPos = cap.position; fireTarget = cap.position; fireDist = a.position.distanceTo(cap.position);
        closeRange = 70;
      } else {
        // No capital left: split up and hunt SEPARATE fighters so they cover the battlespace
        // independently rather than chasing the same target nose-to-tail.
        const t = wingmanPickFighter(a, a.position, 800);
        if (t) { ud.target = t; aimPos = t.position; fireTarget = t.position; fireDist = a.position.distanceTo(t.position); }
      }
    }
  }
  // Nothing to do: form up loosely. Mission 3's escort (Slick) holds station near the crippled
  // O.G. so he keeps the watch over him; otherwise the wingman forms on the player's wing.
  if (!aimPos) {
    if (ud.escortOG && protectOG && allies.children.includes(protectOG)) {
      _wmFormPos.copy(protectOG.position).add(_wmTmpOff.set(ud.formOffset.x + 8, ud.formOffset.y + 6, ud.formOffset.z));
    } else {
      _wmFormPos.copy(player.position)
        .addScaledVector(_FWD0.set(0, 0, -1).applyQuaternion(player.quaternion).normalize(), -(ud.formOffset.z))
        .add(_wmTmpOff.set(ud.formOffset.x, ud.formOffset.y, 0));
    }
    aimPos = _wmFormPos;
  }

  _wmTo.copy(aimPos).sub(a.position);
  const dist = _wmTo.length();
  _wmDir.copy(_wmTo).multiplyScalar(1 / Math.max(dist, 1e-4));

  // ---- Heading: close to firing range, then strafe across rather than ram ----
  _wmUp.set(0, 1, 0);
  _wmSide.crossVectors(_wmDir, _wmUp).normalize();
  if (_wmSide.lengthSq() < 1e-6) _wmSide.set(1, 0, 0);
  if (arriving || dist > closeRange) {
    _wmDesired.copy(_wmDir);
  } else {
    // Strafe pass: slide sideways while keeping the target roughly off the nose.
    _wmDesired.copy(_wmSide).multiplyScalar(ud.strafeDir).addScaledVector(_wmDir, -0.1);
  }
  // Gentle weave for life — amplitude/rate are PER-PILOT (set at spawn) so Slick and O.G. trace
  // visibly different paths instead of moving in lockstep.
  ud.jinkPhase = (ud.jinkPhase || 0) + (ud.jinkRate || 1) * dt;
  _wmDesired.addScaledVector(_wmSide, Math.sin(ud.jinkPhase) * (ud.weaveAmp || 0.22));
  _wmDesired.addScaledVector(_wmUp, Math.cos(ud.jinkPhase * 0.7) * (ud.weaveVert || 0.14));
  // Separation from the other wingman so the pair doesn't stack up. A wide buffer (28u) keeps the
  // two flying as distinct ships with real airspace between them, not a tight formation pair.
  for (const o of allies.children) {
    if (o === a || o.userData.introHold) continue;   // ignore the not-yet-arrived wingman
    _wmSep.copy(a.position).sub(o.position);
    const d2 = _wmSep.length();
    if (d2 > 0.001 && d2 < 28) _wmDesired.addScaledVector(_wmSep.multiplyScalar(1 / d2), (28 - d2) * 0.45);
  }
  if (_wmDesired.lengthSq() < 1e-6) _wmDesired.copy(_wmDir);
  _wmDesired.normalize();

  // ---- Bank-and-turn orientation (mirrors the enemy/ally flight model) ----
  _wmNose.copy(_ENEMY_FWD).applyQuaternion(a.quaternion).normalize();
  _wmBankRight.crossVectors(_wmNose, _wmHomeFlat).normalize();
  if (_wmBankRight.lengthSq() < 1e-6) _wmBankRight.set(1, 0, 0);
  const turnSign = _headingDelta.copy(_wmDesired).sub(_wmNose).dot(_wmBankRight);
  const targetBank = THREE.MathUtils.clamp(turnSign * 2.6, -1, 1) * 1.05;
  ud.bank = (ud.bank || 0) + (targetBank - (ud.bank || 0)) * (1 - Math.pow(0.02, dt));
  _wmBankUp.copy(_wmHomeFlat).applyAxisAngle(_wmDesired, ud.bank);
  _wmLook.copy(a.position).addScaledVector(_wmDesired, 1);
  _wmMat.lookAt(a.position, _wmLook, _wmBankUp);
  _wmQuat.setFromRotationMatrix(_wmMat);
  a.quaternion.slerp(_wmQuat, 1 - Math.pow(0.04, dt));

  // ---- Thrust along the nose (boosted during the warp-in slide; eased when hugging a target) ----
  _wmNose.copy(_ENEMY_FWD).applyQuaternion(a.quaternion).normalize();
  const throttle = arriving ? 4.2 : (!arriving && dist < closeRange * 0.7 ? 0.4 : 1);
  ud.vel.copy(_wmNose).multiplyScalar(ud.speed * throttle);
  a.position.addScaledVector(ud.vel, dt);

  // Engine exhaust (blue, longer/brighter streak while warp-arriving).
  if (ud.engines) {
    const eSpeed01 = arriving ? 1 : THREE.MathUtils.clamp(ud.vel.length() / (ud.speed * 1.6), 0, 1);
    updateEngineTrails(a, dt, eSpeed01, camera, false, arriving ? 2.2 : 1, ud.vel, false, arriving ? 0.6 : 0.25);
  }

  // ---- Firing ----
  // Don't shoot mid-warp-arrival; once formed up, fire at the objective when roughly lined up and
  // in range. Batteries on the capital need precise hits, so require a tighter facing there.
  ud.fireT = (ud.fireT || 0) - dt;
  if (!arriving && fireTarget && ud.fireT <= 0 && fireDist < 220) {
    _wmAim.set(0, 0, -1).applyQuaternion(a.quaternion).normalize();
    _wmDir.copy(fireTarget).sub(a.position).normalize();
    const facing = _wmAim.dot(_wmDir);
    const facingNeeded = (ud.role === 'batteries') ? 0.55 : 0.3;
    if (facing > facingNeeded || fireDist < 40) {
      ud.fireT = 0.4 + Math.random() * 0.45;
      wingmanFire(a, _wmDir, fireDist);
      // Strafing the shields: each lined-up pass on the assigned generator lands a small, reliable
      // chip of damage so the two wingmen can grind both generators down on their own over time
      // (continuous passes, not a sustained beam). Tuned so a full kill takes a good while.
      if (ud.genTarget && ud.genTarget.alive) {
        const cap = enemyCapital();
        if (cap) damageShieldGen(cap, ud.genTarget, 55, ud.genTarget.group.getWorldPosition(_wmGenHit));
      }
    } else {
      ud.fireT = 0.12;
    }
  }
}
// Wingman weapon fire — friendly (blue) bolts, a touch heavier and more accurate than the stock
// escorts since these are hero pilots cracking a capital ship.
const _wmFireDir = new THREE.Vector3(), _wmFireAxis = new THREE.Vector3();
const _wmMuzzleWorld = new THREE.Vector3();
function wingmanFire(a, dirToTarget, dist) {
  _wmFireDir.copy(dirToTarget);
  _wmFireAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  const spread = THREE.MathUtils.lerp(0.08, 0.015, THREE.MathUtils.clamp(1 - dist / 220, 0, 1));
  _wmFireDir.applyAxisAngle(_wmFireAxis, (Math.random() - 0.5) * 2 * spread).normalize();
  // Fire from a calibrated gun muzzle when this hull has them (named wingmen), alternating across
  // the muzzles so bolts visibly leave the actual gun mouths; otherwise use a nose-offset point.
  const muzzles = a.userData.muzzles;
  let start;
  if (muzzles && muzzles.length) {
    a.userData.muzIdx = ((a.userData.muzIdx || 0) + 1) % muzzles.length;
    muzzles[a.userData.muzIdx].getWorldPosition(_wmMuzzleWorld);
    start = _wmMuzzleWorld.clone();
  } else {
    start = a.position.clone().addScaledVector(_wmFireDir, 3);
  }
  const bolt = makeBolt(start, _wmFireDir, true, 22);
  bolt.userData.shooter = a;   // credit the firing wingman so a kill triggers their callout
  boltGroup.add(bolt);
  audio.play('laser', 0.18);
}
// Allied flagship turrets: identical rig to the enemy carrier's, but they track the nearest
// ENEMY and fire FRIENDLY bolts that damage hostiles (not the player).
const _atWorld = new THREE.Vector3(), _atLocal = new THREE.Vector3(), _atParentInv = new THREE.Matrix4();
const _atMuzzleWorld = new THREE.Vector3(), _atMuzzleDir = new THREE.Vector3(), _atToTarget = new THREE.Vector3();
const _atMuzzleQuat = new THREE.Quaternion();
function updateAllyTurrets(ship, dt) {
  const turrets = ship.userData.turrets;
  if (!turrets || !turrets.length) return;
  ship.updateMatrixWorld();
  const TURN_RATE = 1.8, MAX_PITCH = 1.15, RANGE = 360;
  for (const t of turrets) {
    if (!t.alive) continue;
    const base = t.group;
    base.updateMatrixWorld();
    base.getWorldPosition(_atWorld);
    // Acquire the closest enemy in range for this turret.
    const target = nearestEnemyTo(_atWorld, RANGE);
    if (!target) { t.fireT = Math.max(t.fireT, 0.2); continue; }
    const dist = _atWorld.distanceTo(target.position);

    _atParentInv.copy(base.matrixWorld).invert();
    _atLocal.copy(target.position).applyMatrix4(_atParentInv);
    const wantYaw = Math.atan2(_atLocal.x, -_atLocal.z);
    const horiz = Math.hypot(_atLocal.x, _atLocal.z);
    let wantPitch = THREE.MathUtils.clamp(Math.atan2(_atLocal.y, horiz), -0.25, MAX_PITCH);
    const maxStep = TURN_RATE * dt;
    let dy = Math.atan2(Math.sin(wantYaw - t.yaw.rotation.y), Math.cos(wantYaw - t.yaw.rotation.y));
    t.yaw.rotation.y += THREE.MathUtils.clamp(dy, -maxStep, maxStep);
    const dp = (-wantPitch) - t.pitch.rotation.x;
    t.pitch.rotation.x += THREE.MathUtils.clamp(dp, -maxStep, maxStep);

    t.fireT -= dt;
    if (dist < RANGE && t.fireT <= 0) {
      const muzzle = t.muzzles[t.nextMuzzle % t.muzzles.length];
      t.nextMuzzle++;
      muzzle.getWorldPosition(_atMuzzleWorld);
      _atMuzzleDir.set(0, 0, -1).applyQuaternion(muzzle.getWorldQuaternion(_atMuzzleQuat)).normalize();
      _atToTarget.copy(target.position).sub(_atMuzzleWorld).normalize();
      if (_atMuzzleDir.dot(_atToTarget) > 0.94) {
        t.fireT = 0.5 + Math.random() * 0.35;
        _atMuzzleDir.lerp(_atToTarget, 0.7).normalize();
        const start = _atMuzzleWorld.clone().addScaledVector(_atMuzzleDir, 1.5);
        boltGroup.add(makeBolt(start, _atMuzzleDir, true, 12));
        spark(explosions, start, 0x62f8ff);
        audio.play('laser', 0.12);
      } else {
        t.fireT = 0.12;
      }
    }
  }
}
function damageAllyTurret(ship, t, dmg, hitPos) {
  if (!t.alive) return;
  t.hp -= dmg;
  spark(explosions, hitPos, 0xc0e8ff);
  if (t.hp <= 0) {
    t.alive = false;
    t.group.visible = false;
    t.group.getWorldPosition(_atWorld);
    explode(explosions, _atWorld.clone(), 0x6ab4ff, 1.4);
    audio.play('explosion', 0.35);
  }
}
// True while the scripted Mission 2 (CAPITAL STRIKE) engagement is live.
function mission2Active() {
  return !!mission && mission.capital && (missionIndex % missions.length) === 1;
}
// True while the scripted Mission 3 (PROTECT O.G.) escort/repair survival is live.
function mission3Active() {
  return !!mission && !!mission.protectOG && (missionIndex % missions.length) === 2;
}
// Apply damage to an allied ship, destroying it at 0 HP. For the named Mission 2 wingmen this also
// drives their reactive comms barks. We model the top half of a wingman's HP as SHIELDS and the
// bottom half as hull, so "shield damage %" = how far HP has fallen through that top half:
//   lost 25% of maxHp  -> 50% shield damage    (Slick's "took >50% shield damage" cue)
//   lost 50% of maxHp  -> 100% shield damage   (O.G.'s "took 100% shield damage" cue)
// TESTING/TUNING: the named Mission 2 wingmen TAKE and REACT to damage (sparks, comms barks,
// peel-to-support), but are NOT killable yet — their HP is floored so killAlly never triggers and
// the mission can't be failed by losing them while we tune. Flip WINGMEN_INVULN to false later to
// let them actually die.
const WINGMEN_INVULN = true;
const WINGMAN_HP_FLOOR = 0.12;   // can't drop below 12% of maxHp while invulnerable
function damageAlly(a, dmg) {
  const ud = a.userData;
  // Mission 3 escort stakes: the crippled O.G. takes AMPLIFIED damage so the defense actually feels
  // perilous — you can watch his bar slide and he CAN be lost if you let bandits work him over. The
  // amplification scales with difficulty (gentle on Recruit, brutal on Ace) so it's exciting without
  // being unfair on the easy tiers. Other allies (wingmen, flagship) take damage at face value.
  if (mission3Active() && a === protectOG) dmg *= m3OGDamageMult();
  ud.hp -= dmg;
  // Mark ANY hit ally as "in distress" for a few seconds. The wingmen scan this flag and will peel
  // off their generator/Dreadnought work to assist whichever friendly is being fired upon — be it
  // the other wingman or a stock escort fighter — then return to the objective once it calms.
  if (!ud.introHold && ud.kind !== 'flagship') ud.distress = 3.0;
  if (ud.wingman && !ud.introHold) {
    // Pop a hull spark so the hit reads on screen.
    spark(explosions, a.position.clone(), 0xc0e8ff);
    // Floor the HP so testing wingmen react to fire but can't be destroyed yet.
    if (WINGMEN_INVULN) ud.hp = Math.max(ud.hp, ud.maxHp * WINGMAN_HP_FLOOR);
  }
  // The DEFEND flagship obeys the invuln floor while WINGMEN_INVULN is on (it's not flagged
  // `wingman`, and without this it could be bombed out ~30s into a DEFEND mission and silently
  // restart). The Mission 3 escort target (O.G.), however, is DELIBERATELY left killable so the
  // PROTECT mission has real stakes — the objective can genuinely be destroyed if the player lets
  // the bandits get to him. (killAlly handles the escort-failed flow when his HP runs out.)
  if (WINGMEN_INVULN && a === defendTarget && !(mission3Active() && a === protectOG)) {
    ud.hp = Math.max(ud.hp, ud.maxHp * WINGMAN_HP_FLOOR);
  }
  // Mission 3: the first time the damaged O.G. is beaten down to 50% hull, he calls out that he's
  // taking damage. Fires once per mission; allySpeak handles the speaking brackets + radio + caption.
  if (mission3Active() && a === protectOG && !_ogHalfHealthBark && ud.maxHp > 0 && ud.hp <= ud.maxHp * 0.5) {
    _ogHalfHealthBark = true;
    ud.ogCrit = true;   // escalate his engine-smoke trail to a heavier "critical hull" burn (updateAllies)
    allySpeak('O.G.', 'assets/audio/voice/mission3/ogtakesdamagem3.mp3', 0.95);
    // 1s after O.G.'s "taking damage" call, Slick answers (voice + static + caption).
    _mission3IntroTimers.push(setTimeout(() => {
      allySpeak('SLICK', 'assets/audio/voice/mission3/slickogdmgm3.mp3', 0.95);
    }, 1000));
  }
  if (mission2Active() && ud.wingman && !ud.introHold) {
    const lostFrac = ud.maxHp > 0 ? (ud.maxHp - Math.max(0, ud.hp)) / ud.maxHp : 0;
    const shieldDmgFrac = THREE.MathUtils.clamp(lostFrac / 0.5, 0, 1);   // top 50% of HP == shields
    if (ud.callSign === 'SLICK' && !_slickHitBark && shieldDmgFrac >= 0.5) {
      _slickHitBark = true;
      allySpeak('SLICK', 'assets/audio/voice/mission-2/slickhitm2.mp3', 0.95, () => {
        // 0.5s after Slick's hit call, O.G. answers that he's got him.
        _mission2BarkTimers.push(setTimeout(() => {
          allySpeak('O.G.', 'assets/audio/voice/mission-2/oghangonslick.mp3', 0.95);
        }, 500));
      });
    }
    if (ud.callSign === 'O.G.' && !_ogDownBark && shieldDmgFrac >= 1) {
      _ogDownBark = true;
      allySpeak('O.G.', 'assets/audio/voice/mission-2/ogtheykeepcomingm2.mp3', 0.95);
    }
  }
  if (ud.hp <= 0) killAlly(a);
}
function killAlly(a) {
  // Allied ("player faction") ships blow up WITHOUT the expanding shockwave ring, and with a
  // slightly amplified fireball, so their deaths read as a fuller burst rather than a thin hoop.
  if (a.userData.kind === 'flagship') {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(a.quaternion);
    explode(explosions, a.position, 0x8fd4ff, 7.5, { capital: true, dir, length: (a.userData.radius || 12) * 2.2, noRing: true });
    audio.play('explosion', 1.0);
    setTimeout(() => audio.play('explosion', 0.75), 280);
    setTimeout(() => audio.play('explosion', 0.65), 720);
  } else {
    const scale = ((a.userData.radius || 1.5) * 0.8 + 0.6) * 1.4;   // amplified vs. enemy fighters
    explode(explosions, a.position, 0x8fd4ff, scale, { noRing: true });
    audio.play('explosion', 0.6);
  }
  disposeEngineEffects(a);
  allies.remove(a);
  if (a === defendTarget) defendTarget = null;   // DEFEND mission-fail check reads this
  if (a === protectOG) protectOG = null;         // Mission 3 fail check reads this (was never cleared)
}

function damagePlayer(amount, hitPos = null) {
  // Difficulty scales the damage the player TAKES (Recruit softens it, Ace amplifies it).
  amount *= difficultyMods().incoming;
  // Feed the rolling recent-damage signal Slick & O.G. watch (hull hits count double since taking
  // hull damage is the real danger that should pull the wingmen back to cover the player).
  // Shields soak the hit first. With more power routed to SHIELDS each charge point absorbs more,
  // so the deflectors lose LESS charge for the same incoming blast (effDmg shrinks); starve them and
  // the same hit drains the bank faster. effDmg is the charge actually spent; any blast left over
  // once the bank is empty bleeds through to the hull.
  const absorb = shieldAbsorbBonus();
  const effDmg = amount / absorb;                       // charge needed to fully soak this blast
  const sh = Math.min(state.shields, effDmg); state.shields -= sh;
  const hullHit = Math.max(0, amount - sh * absorb); state.hull -= hullHit;
  recentPlayerDamage += sh * 0.5 + hullHit * 1.5;
  // SCORING PENALTY: taking HULL damage costs a slight number of points (shields soaking a hit
  // costs nothing). Scaled so a full-hull-to-zero beating bleeds a few hundred points, never enough
  // to erase a good run, but enough that flawless flying scores higher. Also trips the
  // "took hull damage" flags the flawless/untouchable achievements read.
  if (hullHit > 0) {
    const penalty = Math.round(hullHit * 2);
    state.score = Math.max(0, state.score - penalty);
    state.tookHullDamage = true;
    state.waveHullClean = false;
    missionResults.hullPenalty += penalty;   // tally for the post-mission results breakdown
    missionResults.hullDamage += hullHit;
  }
  // Flash the shield bubble only when the shields actually absorbed part of the hit.
  // Strength scales with how much was soaked relative to the incoming damage, so glancing
  // taps ripple softly and a fully-shielded blast lights the whole bubble.
  if (sh > 0) {
    const fStr = THREE.MathUtils.clamp(0.45 + sh / Math.max(amount, 1) * 0.55, 0.45, 1);
    flashPlayerShield(player, fStr, hitPos);   // dome ripple (shows in third-person)
    triggerShieldVignette(fStr);               // cockpit edge-flash (shows in first-person)
  }
  audio.play('shield', .42); flash(hullHit ? 'HULL BREACH' : 'SHIELD IMPACT');
  // SCAAVI / Crimson SCAAVI shipboard-AI combat barks (shields failing / heavy hull damage). The
  // shared monitor latches its own edges; it's also called every frame in the loop so the
  // "shields recharged" line can fire while shields regenerate back to full.
  const shieldFrac = state.maxShields > 0 ? state.shields / state.maxShields : 0;
  updateScaaviAlerts(shieldFrac, state.hull / 100);
  if (state.hull <= 0) { state.hull = 100; state.shields = state.maxShields; state.score = Math.max(0, state.score - 350); flash('EJECTED - RESPAWNED'); resetScaaviAlerts(); }
}
function updateExplosions(dt) {
  for (const p of [...explosions.children]) {
    const u = p.userData;
    u.life -= dt;
    if (u.life <= 0) {
      // A trigger marker fires a delayed secondary blast (capital-ship chain reaction) on death.
      if (u.kind === 'trigger' && u.fire) explode(explosions, u.fire.pos, u.fire.color, u.fire.scale, { noRing: u.fire.noRing });
      explosions.remove(p);
      continue;
    }
    if (u.kind === 'trigger') continue;   // inert until its timer expires
    const t = 1 - u.life / (u.maxLife || u.life + dt);   // 0 at birth -> 1 at death
    if (u.kind === 'chunk') {
      // Tumbling hull fragment: drift with light drag, spin freely, cool its glow, and trail
      // smoke. No material.opacity fade — it's solid wreckage that just shrinks out at the end.
      p.position.addScaledVector(u.vel, dt);
      if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
      p.rotation.x += u.spinV.x * dt; p.rotation.y += u.spinV.y * dt; p.rotation.z += u.spinV.z * dt;
      p.material.emissiveIntensity = Math.max(0, 1.4 * (1 - t * 1.3));
      // Smoke trail at a steady cadence while the chunk is still moving fast.
      u.smokeAt -= dt;
      if (u.smokeAt <= 0 && t < 0.7) { u.smokeAt = 0.14; spawnSmokePuff(explosions, p.position, 1.0 + Math.random()); }
      // Shrink away in the final 20% of life so it doesn't pop out.
      if (t > 0.8) p.scale.multiplyScalar(Math.pow(0.02, dt));
      continue;
    }
    if (u.kind === 'flash') {
      // Bright core: expand quickly and fade out over its short life.
      const s = THREE.MathUtils.lerp(u.growFrom, u.growTo, Math.min(1, t * 1.6));
      p.scale.setScalar(s);
      p.material.opacity = Math.max(0, 1 - t) ** 1.3;
    } else if (u.kind === 'ring') {
      // Shockwave disc: snap outward fast (ease-out) and thin to nothing. The quick early
      // expansion plus rapid fade reads as a real concussion wave rather than a slow hoop.
      const e = 1 - Math.pow(1 - t, 2.6);
      const s = THREE.MathUtils.lerp(0.3, u.growTo, e);
      p.scale.set(s, s, s * 0.35);   // flatten on the local Z so it sits as a disc
      p.material.opacity = Math.max(0, 1 - t) ** 1.5;
    } else if (u.kind === 'fireball') {
      // Rolling fireball: bloom outward, peak near mid-life, then collapse. Cool from hot
      // yellow-white through orange as it dies.
      p.position.addScaledVector(u.vel, dt);
      if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
      if (u.spin) p.material.rotation += u.spin * dt;
      const bloom = Math.sin(Math.min(1, t) * Math.PI);           // 0 -> 1 -> 0
      p.scale.setScalar(u.baseScale * (0.5 + bloom * 1.1));
      p.material.opacity = Math.max(0, 1 - t) * 0.95;
      p.material.color.setRGB(1, 0.78 - t * 0.5, 0.5 - t * 0.5);
    } else if (u.kind === 'smoke') {
      // Lingering smoke: drift, swell, fade up then out. Darkens as it cools.
      p.position.addScaledVector(u.vel, dt);
      if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
      if (u.spin) p.material.rotation += u.spin * dt;
      p.scale.setScalar(THREE.MathUtils.lerp(u.baseScale, u.growTo, t));
      const peak = u.peak || 0.4;
      const fade = t < peak ? t / peak : 1 - (t - peak) / (1 - peak);
      p.material.opacity = Math.max(0, fade) * 0.55;
    } else {
      // Debris / embers / sparks: drift outward with drag, fading as they die.
      p.position.addScaledVector(u.vel, dt);
      if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
      p.material.opacity = Math.max(0, 1 - t);
      // Fast shrapnel stretches into a streak along its travel direction.
      if (u.streak) {
        const v = u.vel;
        const len = THREE.MathUtils.clamp(v.length() * 0.05, 1, 6) * Math.max(0.2, 1 - t);
        p.scale.set(0.7, 0.7, 1);
        p.scale.z = len;
        if (v.lengthSq() > 1e-4) p.lookAt(p.position.x + v.x, p.position.y + v.y, p.position.z + v.z);
      }
      // Embers cool from orange toward dark red as they fade.
      if (u.kind === 'ember') p.material.color.setRGB(0.76 * (1 - t * 0.4), 0.29 * (1 - t * 0.7), 0.12 * (1 - t));
    }
  }
}
function updateMission(dt) {
  // FLIGHT SCHOOL owns its own objective flow (the TutorialController), so the campaign mission-type
  // gates, wave-clear hyperspace prompt and reinforcement spawners are all skipped here.
  if (mission.tutorial || mission.freeflight) return;   // training + co-op free flight have no objective flow
  if (mission.survive) mission.timer -= dt;
  if (mission.capture) capture = Math.min(mission.capture, capture + (player.position.length() < 80 ? 13 : -8) * dt);
  const capitals = enemies.children.filter(e => e.userData.kind === 'capital').length;
  const fighters = enemies.children.filter(e => e.userData.kind !== 'capital').length;
  let complete = false;
  if (mission.type === 'DOGFIGHT') complete = fighters === 0;
  if (mission.type === 'CAPITAL STRIKE') {
    // Mission 2 (the scripted CAPITAL STRIKE the wingmen fly) is only complete once the capital
    // AND every enemy fighter is gone; other CAPITAL STRIKE waves clear on the capital alone.
    complete = (missionIndex % missions.length) === 1
      ? (capitals === 0 && fighters === 0)
      : capitals === 0;
  }
  if (mission.type === 'OBJECTIVE TAKEOVER') complete = capture >= mission.capture;
  if (mission.type === 'BREAK CONTACT') complete = mission.timer <= 0;
  if (mission.type === 'PROTECT O.G.') {
    // Lose if the man you're guarding dies (killAlly clears protectOG). O.G. is intentionally
    // KILLABLE in this mission (see damageAlly) so the escort has real stakes — losing him fails
    // the mission and restarts it fresh. (waveClear guards against a stray post-win null ref.)
    if (mission.protectOG && !protectOG && !waveClear) {
      flash('O.G. IS DOWN — ESCORT FAILED');
      state.score = Math.max(0, state.score - 500);
      mission = null;
      setTimeout(() => beginMission(), 1400);   // restart the escort fresh
      return;
    }
    // Keep the pressure on: top the fighter screen up over the 3-minute hold so the player always
    // has hostiles to fend off (but cap it so it never snowballs into an impossible swarm).
    m3SpawnT -= dt;
    if (m3SpawnT <= 0 && fighters < 7 && mission.timer > 8) {
      m3SpawnT = 5 + Math.random() * 4;
      spawnMission3Fighter();
    }
    // "Engines back online" beat in the final stretch: repairs finish, so O.G. is RESTORED to full
    // — smoke stops and he gets his cruise speed back (he was flying hobbled the whole hold). This
    // foreshadows the win.
    if (!_ogRepairDoneBark && mission.timer <= 12 && protectOG) {
      _ogRepairDoneBark = true;
      restoreDamagedOG();
      flash('O.G.: ENGINES BACK ONLINE — SPOOLING JUMP');
    }
    // Timer expired: if the player, O.G. and Slick are ALL still alive, O.G. radios that his ship is
    // fixed. The jump-to-hyperspace prompt only arms once that line finishes (_m3JumpArmed), so the
    // player can't leave until the beat plays out. Fires once via _ogRepairDoneBark gating below.
    const _slickAlive = !!findAllyByCall('SLICK');
    if (mission.timer <= 0 && protectOG && _slickAlive && !_m3JumpArmed && !_m3RepairLineStarted) {
      _m3RepairLineStarted = true;
      allySpeak('O.G.', 'assets/audio/voice/mission3/ogshipfixedm3.mp3', 0.95, () => {
        _m3JumpArmed = true;   // VO done -> allow the H jump (handled in the `complete` gate below)
      });
    }
    // Only "complete" (which raises the Hyperspace prompt) once the repair line has finished playing.
    complete = mission.timer <= 0 && !!protectOG && _m3JumpArmed;
  }
  if (mission.type === 'DEFEND') {
    // DEFEND: clear all hostiles while the allied flagship survives. Losing the flagship fails
    // the mission (respawn the player and restart the wave from the menu prompt).
    if (mission.defend && !defendTarget && !waveClear && !WINGMEN_INVULN) {
      flash('FLAGSHIP LOST — DEFENSE FAILED');
      state.score = Math.max(0, state.score - 500);
      // Restart the same wave fresh after a short beat.
      mission = null;
      setTimeout(() => beginMission(), 1400);
      return;
    }
    complete = fighters === 0 && capitals === 0;
  }
  if (complete && !waveClear) {
    waveClear = true;
    flash('OBJECTIVES COMPLETE');
    // ---- Wave-complete achievements ----
    // Untouchable: cleared this wave without ever taking hull damage. Difficulty respect: a clean
    // wave on ACE earns "No Quarter". Mission 3 survival earns the escort/survivor pair.
    if (state.waveHullClean) awardAchievement('untouchable');
    if (settings.difficulty === 'ace') awardAchievement('ace_difficulty');
    if (mission3Active()) {
      awardAchievement('survivor'); if (protectOG) awardAchievement('escort_hero');
      // Ranking: clearing Mission 3's objectives completes the campaign — a one-time career boost.
      leaderboard.addCampaignCompletion();
    }
    // Mission 2 (CAPITAL STRIKE): Overwatch signs off the engagement the moment the final hostile
    // dies. A short delay lets the kill blast land first so the line reads as a reaction, not a cue.
    if (mission2Active()) {
      setTimeout(() => { const el = audio.playClip('assets/audio/voice/overwatch/mission2b/mission-end/overwatchm2final1.mp3', 0.95); captionVoice('assets/audio/voice/overwatch/mission2b/mission-end/overwatchm2final1.mp3', 'OVERWATCH', el); }, 900);
    }
    // Instead of auto-jumping, prompt the player to enter hyperspace on their own cue, naming the
    // currently-bound Hyperspace Jump key so the hint stays correct if it's been rebound.
    awaitingHyperspace = true;
    const hk = keyLabel((settings.bindings.hyperspace || [])[0]);
    $('hyperPrompt').innerHTML = `OBJECTIVES COMPLETED · PRESS <b>${hk}</b> TO ENTER HYPERSPACE`;
    $('hyperPrompt').classList.add('show');
  }
}

// Lightspeed warp-out between missions: the hero jumps clear, then the draft appears.
function startWarpOut() {
  if (warping) return;
  // Mission 2 (CAPITAL STRIKE): Overwatch's parting line plays as the player triggers the jump out
  // (the H press after the wave is won). Checked before state changes below so it only fires for the
  // Mission 2 win jump.
  if (mission2Active()) {
    const _m2endEl = audio.playClip('assets/audio/voice/overwatch/mission2b/mission-end/overwatchm2final2.mp3', 0.95);
    captionVoice('assets/audio/voice/overwatch/mission2b/mission-end/overwatchm2final2.mp3', 'OVERWATCH', _m2endEl);
  }
  // Mission 3: the player AND both allies (O.G. + Slick) jump to hyperspace together. Visually we
  // pull O.G. and Slick out of the scene now so only Mamba is left to streak away down the tube.
  // The Overwatch debrief (two lines, 0.3s apart) is fired from the warp-out onDone below, once the
  // jump has carried Mamba clear, before the hangar/upgrade draft comes up.
  const _isMission3Jump = mission3Active();
  if (_isMission3Jump) {
    for (const a of [...allies.children]) { disposeEngineEffects(a); allies.remove(a); }
    protectOG = null;
  }
  warping = true;
  awaitingHyperspace = false;
  lockProgress = 0; missileLocked = false; audio.stopLockTone();   // kill any lock cue before the jump
  audio.stopEngineHum();   // drop the cockpit drone while on the hyperspace rails
  $('hyperPrompt').classList.remove('show');
  // Clear lingering hostiles/bolts so nothing fires during the jump, and reset trail
  // history so the ribbon streaks cleanly from the ship rather than snapping across.
  boltGroup.clear(); missileGroup.clear();
  if (player.userData.engines) for (const eng of player.userData.engines) eng.trail.userData.history.length = 0;
  // The jump is always framed as a third-person cinematic: the camera plants behind the ship and
  // it streaks away. In first-person view the cockpit canopy overlay would otherwise stay drawn
  // over that chase shot (the hull "flying over the cockpit"), so force the third-person
  // presentation for the duration — hide the cockpit canopy/instruments and SHOW the hull.
  ui.classList.add('third');
  const hull = player.userData.modelHolder;
  if (hull) hull.visible = true;
  // LEVEL the ship before the jump. Coming out of a dogfight the hull carries arbitrary pitch and
  // roll, which threw the flight axis off-vertical so the ship drifted off-center in the streak
  // tube (it "pushed to the right"). Rebuild the orientation from the ship's current HEADING only,
  // flattened to the horizon (no roll, level pitch), so it flies dead straight down the tube.
  forward.set(0, 0, -1).applyQuaternion(player.quaternion);   // current visible nose (local -Z)
  forward.y = 0;                                              // flatten to the horizon plane
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);       // guard a near-vertical nose
  forward.normalize();
  // Reorient the ship: nose along the leveled `forward`, wings level. Matrix4.lookAt points local
  // -Z at the target, so aim one unit AHEAD along `forward` (matches the fighter flight model).
  const _lvl = new THREE.Matrix4().lookAt(
    player.position,
    player.position.clone().add(forward),
    new THREE.Vector3(0, 1, 0)
  );
  player.quaternion.setFromRotationMatrix(_lvl);
  // Plant a fixed cinematic camera directly BEHIND the leveled ship and slightly above, dead on the
  // flight axis. The streak tube in WarpOut is centered on the CAMERA's view axis, so the camera
  // must look exactly PARALLEL to the ship's flight axis (`forward`) — not at a point near the ship,
  // which would pitch the view down and let the ship drift up/off-center in the tube. Build the
  // camera orientation from `forward` directly so the tube axis and the flight axis coincide.
  const camBack = forward.clone().multiplyScalar(14);
  camera.position.copy(player.position).sub(camBack).add(new THREE.Vector3(0, 3.5, 0));
  const _camLook = new THREE.Matrix4().lookAt(
    camera.position,
    camera.position.clone().add(forward),   // look straight along the flight axis (parallel)
    new THREE.Vector3(0, 1, 0)
  );
  camera.quaternion.setFromRotationMatrix(_camLook);
  flash('JUMPING TO LIGHTSPEED');
  audio.playShipWarp(currentHullId(), 0.85);   // this hull's own jump signature on the way OUT
  audio.startHum(0.5);   // lightspeed travel bed under the long cruise
  const flashEl = $('warpFlash');

  // Mission 1 gets the special cinematic outro: third-person jump -> cockpit hyperspace with the
  // Overwatch debrief line -> hangar landing -> draft. We start the same third-person leap, but the
  // loop watches m1Outro and cuts to the cockpit view as soon as the ship has left the screen
  // (instead of letting WarpOut run its full cruise + flash into the draft).
  const isMission1 = (missionIndex % missions.length) === 0;
  if (isMission1) {
    m1Outro.active = true;
    m1Outro.phase = 'jump';
    m1Outro.t = 0;
    m1Outro.voiceDone = false;
    warpOut.start(player);   // no onPeak/onDone: the m1Outro state machine drives the rest
    return;
  }

  warpOut.start(player, {
    // At the peak of the jump, bloom a white flash to full so the leap is fully visible
    // before anything swaps.
    onPeak: () => {
      flashEl.style.transition = 'opacity .14s ease-in';
      flashEl.style.opacity = '1';
    },
    // The scene swap happens BEHIND the fully-white flash, then we fade the flash out to
    // reveal the draft — so the player never sees the menu pop in mid-jump.
    onDone: () => {
      warping = false;
      audio.stopHum();   // cut the lightspeed bed as we drop into the hangar
      // Mission 3 debrief: as Mamba drops out of the jump, Overwatch checks in with two lines. They
      // are played SEQUENTIALLY — the second line only starts 0.3s AFTER the first one ENDS — so the
      // two Overwatch clips no longer talk over each other. (The earlier 300ms fixed delay started
      // line 2 while line 1 was still playing, producing the overlapping-Overwatch bug.)
      if (_isMission3Jump) {
        const _ow1Url = 'assets/audio/voice/mission3/miss3compoverwatch1.mp3';
        const _ow2Url = 'assets/audio/voice/mission3/miss3compoverwatch2.mp3';
        const _ow1 = audio.playClip(_ow1Url, 0.95, () => {
          // 0.3s after line 1 finishes, play line 2.
          _m3OutroTimers.push(setTimeout(() => {
            const _ow2 = audio.playClip(_ow2Url, 0.95);
            captionVoice(_ow2Url, 'OVERWATCH', _ow2);
          }, 300));
        });
        captionVoice(_ow1Url, 'OVERWATCH', _ow1);
      }
      // Restore the cockpit/chase overlay state to match the player's selected view (we forced
      // third-person for the cinematic) so the next mission renders the correct canopy.
      ui.classList.toggle('third', view === 'third');
      showDraft();
      requestAnimationFrame(() => {
        flashEl.style.transition = 'opacity .5s ease-out';
        flashEl.style.opacity = '0';
      });
    }
  });
}
// Drive the mission-1-complete cinematic. Runs from the loop while m1Outro.active (which also
// keeps the `warping` rail engaged). Sequences: third-person lightspeed leap, cut to first-person
// cockpit hyperspace while the debrief voice plays, then hand off to the hangar-landing draft.
function updateMission1Outro(dt) {
  m1Outro.t += dt;
  if (m1Outro.phase === 'jump') {
    // Reuse the WarpOut leap to fling the hero away in third person + rip the streaks past.
    warpOut.update(dt);
    debris.visible = false;
    scene.background = warpOut.starsVisible ? skyTex : skyBlack;
    updateExplosions(dt);
    updateEngineTrails(player, dt, 1, camera, true);
    updateHUD(dt);
    renderer.render(scene, camera);
    // The ship is flung along -Z away from the frozen camera; by ~1.8s it has clearly left the
    // frame. Cut to the cockpit hyperspace view and start the debrief line.
    if (m1Outro.t >= 1.8) {
      warpOut.stop();
      m1Outro.phase = 'cockpit';
      m1Outro.t = 0;
      m1Outro.voiceDone = false;
      // Switch to the first-person cockpit presentation for the tunnel ride (forced, even if the
      // player normally flies in chase view).
      cinematicFirstPerson = true;
      ui.classList.remove('third');
      if (player.userData.modelHolder) player.userData.modelHolder.visible = false;
      // Re-seat the ship just ahead of the camera and level it so the cockpit tube reads straight.
      player.position.set(0, 0, 0);
      player.quaternion.identity();
      camUp = null;
      warpIn.beginHold();   // full-intensity hyperspace streak field, camera-anchored
      audio.startHum(0.55);
      const _m1doneEl = audio.playClip('assets/audio/voice/overwatch/mission1done.mp3', 0.95, () => { m1Outro.voiceDone = true; });
      captionVoice('assets/audio/voice/overwatch/mission1done.mp3', 'OVERWATCH', _m1doneEl);
    }
    return;
  }
  if (m1Outro.phase === 'cockpit') {
    // First-person cockpit hyperspace: the streak tube rushes past with a blazing exhaust streak
    // while the Overwatch debrief plays. Hold here until the line finishes (with a generous floor
    // so a missed 'ended' event can't strand us — the voiceDone callback has its own safety net).
    scene.background = skyBlack;
    debris.visible = false;
    updateCamera(dt, true);
    warpIn.streakHold(dt);
    updateEngineTrails(player, dt, 1, camera, true);
    updateHUD(dt);
    renderer.render(scene, camera);
    if (m1Outro.voiceDone && m1Outro.t >= 1.0) {
      // Voice done: end the hyperspace tube and bloom the white flash, then drop into the hangar
      // landing behind it (so the scene swap is hidden), and fade the flash to reveal the landing.
      warpIn.endHold();
      audio.stopHum();
      cinematicFirstPerson = false;   // release the forced cockpit; hangar/draft owns the screen now
      // Paint ONE clean black frame on the gameplay renderer now. showDraft() stops the RAF loop,
      // which leaves the gameplay canvas frozen on its last frame — and that last frame still had
      // the hyperspace streak field drawn in it, which then bled through behind the semi-transparent
      // hangar canvas. Hiding the streaks + rendering an empty black scene clears that ghost field.
      scene.background = skyBlack;
      debris.visible = false;
      if (player.userData.modelHolder) player.userData.modelHolder.visible = false;
      renderer.render(scene, camera);
      m1Outro.phase = 'landing';
      m1Outro.t = 0;
      const flashEl = $('warpFlash');
      flashEl.style.transition = 'opacity .18s ease-in';
      flashEl.style.opacity = '1';
      // Restore the player's chosen view state for the next mission, then bring up the draft with
      // the hangar in LANDING mode so the ship flies in and sets down on the deck.
      ui.classList.toggle('third', view === 'third');
      showDraft({ landing: true });
      requestAnimationFrame(() => {
        flashEl.style.transition = 'opacity .6s ease-out';
        flashEl.style.opacity = '0';
      });
      // The cinematic is over; release the warp rail so the hangar/draft owns the screen.
      m1Outro.active = false;
      m1Outro.phase = 'idle';
      warping = false;
    }
    return;
  }
}

// ============================================================================================
// EXHAUST CALIBRATION DEV MODE
// --------------------------------------------------------------------------------------------
// A live, frozen rig for pinning down exactly where each ship's engine exhaust should exit.
// Toggle with P during gameplay. It parks one enemy hull a fixed distance in front of the camera,
// slowly rotates it so every side is visible, and draws a bright magenta marker sphere at each
// current exhaust mount. You drive the markers with the keyboard to show where the exhaust SHOULD
// come from, then press \ to print the calibrated layout (as fractions of model length L, ready to
// paste into ENEMY_EXHAUST_MOUNTS in scene.js).
//
//   P            toggle dev mode on/off
//   Tab          cycle hull kind (interceptor / bomber / drone / fighter / slick / og / capital)
//                (slick & O.G. are the allied wingman hulls, built via makeAlly; capital is the
//                 Mission-2 DREADNOUGHT — the camera auto-pulls back to frame the huge hull)
//   [ / ]        select previous / next nozzle marker
//   Arrow keys   move selected nozzle on the model's X (left/right) and Z (fore/aft)
//   PageUp/Down  move selected nozzle on the model's Y (up/down)
//   W/S A/D Q/E  CAPITAL ONLY: rotate the WHOLE HULL (pitch/yaw/roll) to set its orientation;
//                Shift snaps in 90° steps, R zeroes it. (For fighters these aim the nozzle stream.)
//   N            add a new nozzle at the model center (e.g. to match an extra engine)
//   Backspace    delete the selected nozzle
//   \            print the current layout for the active hull to the console
// ============================================================================================
const exhaustDev = { on: false, kind: 'interceptor', ship: null, sel: 0, markers: [], L: 4.6, spin: 0, modelRot: { x: 0, y: 0, z: 0 } };
const _zeroVel = new THREE.Vector3();   // scratch zero velocity for the dev rig's exhaust update
// Wingman hulls (Slick & O.G.) are ALLIES, built via makeAlly into the `allies` group rather than
// makeEnemy/`enemies`. The dev rigs cycle them too so their exhaust + orientation can be calibrated.
const DEV_ALLY_KINDS = ['slick', 'og'];
const DEV_ALLY_LEN = { slick: 5.6, og: 5.8 };
// Build a dev-rig ship for any kind: allies via makeAlly into `allies`, everything else via
// makeEnemy into `enemies`. Returns the ship group (model loads async, as usual).
function makeDevShip(kind) {
  if (DEV_ALLY_KINDS.includes(kind)) {
    const s = makeAlly(kind, new THREE.Vector3(0, 0, 0), trails);
    allies.add(s);
    return s;
  }
  const s = makeEnemy(kind, new THREE.Vector3(0, 0, 0), trails);
  // The capital carries a shield dome that wraps the whole hull — fine in combat, but in the exhaust
  // calibration rig it just hides the model. Hide it so the dev rig shows the bare hull.
  if (s.userData && s.userData.shieldDome) s.userData.shieldDome.visible = false;
  enemies.add(s);
  return s;
}
// Remove a dev-rig ship from whichever group it lives in.
function removeDevShip(s) {
  if (!s) return;
  disposeEngineEffects(s);
  enemies.remove(s);
  allies.remove(s);
}
const EXHAUST_DEV_KINDS = ['interceptor', 'bomber', 'drone', 'fighter', 'slick', 'og', 'capital'];
const EXHAUST_DEV_LEN = { interceptor: 4.6, fighter: 4.8, bomber: 6.2, drone: 3.4, slick: 5.6, og: 5.8, capital: 260 };
let exhaustDevHud = null;
let exhaustDevSlider = null;   // manual Y-rotation slider wrapper

function toggleExhaustDev() {
  exhaustDev.on = !exhaustDev.on;
  if (exhaustDev.on) {
    // Hand the cursor to the user for marker dragging/HUD; flight won't re-grab it while on.
    if (document.pointerLockElement) document.exitPointerLock?.();
    buildExhaustDevRig();
  } else teardownExhaustDevRig();
}

function buildExhaustDevRig() {
  teardownExhaustDevRig();
  // Make sure we're rendering the hull (third-person look) and the canopy isn't drawn over it.
  ui.classList.add('third');
  if (player.userData.modelHolder) player.userData.modelHolder.visible = true;
  keys.clear(); kbHeld.clear();
  exhaustDev.L = EXHAUST_DEV_LEN[exhaustDev.kind] || 4.6;
  exhaustDev.spin = 0;
  exhaustDev.modelRot = { x: 0, y: 0, z: 0 };
  // Spawn the hull at the origin; the camera is repositioned each frame to look at it. Wingman
  // hulls (slick/og) build as allies into `allies`; all other kinds build as enemies.
  const ship = makeDevShip(exhaustDev.kind);
  ship.userData.devFrozen = true;       // (informational) — dev rig never runs the AI on it
  exhaustDev.ship = ship;
  exhaustDev.sel = 0;
  exhaustDev.markers = [];
  // Markers are attached once the model + its engines exist (model loads async).
  if (!exhaustDevHud) {
    exhaustDevHud = document.createElement('div');
    exhaustDevHud.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:50;font:700 12px Orbitron,monospace;'
      + 'color:#ff6cf0;background:rgba(8,2,16,.82);border:1px solid #ff6cf0;border-radius:8px;padding:10px 12px;'
      + 'white-space:pre;line-height:1.5;text-shadow:0 0 8px rgba(255,108,240,.6);pointer-events:none;';
    ui.appendChild(exhaustDevHud);
  }
  exhaustDevHud.style.display = 'block';
  // Interactive Y-rotation slider (separate element so it can receive pointer events).
  if (!exhaustDevSlider) {
    exhaustDevSlider = document.createElement('div');
    exhaustDevSlider.style.cssText = 'position:absolute;left:12px;bottom:158px;z-index:51;'
      + 'font:700 11px Orbitron,monospace;color:#ff6cf0;background:rgba(8,2,16,.9);'
      + 'border:1px solid #ff6cf0;border-radius:8px;padding:8px 12px;display:flex;align-items:center;'
      + 'gap:8px;text-shadow:0 0 8px rgba(255,108,240,.6);pointer-events:auto;';
    const label = document.createElement('span');
    label.textContent = 'ROT';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0'; input.max = '360'; input.step = '1'; input.value = '0';
    input.style.cssText = 'width:200px;accent-color:#ff6cf0;cursor:pointer;';
    const val = document.createElement('span');
    val.textContent = '0\u00b0';
    val.style.minWidth = '34px';
    input.addEventListener('input', () => {
      exhaustDev.spin = THREE.MathUtils.degToRad(parseFloat(input.value));
      val.textContent = `${input.value}\u00b0`;
    });
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'EXPORT JSON';
    exportBtn.style.cssText = 'font:700 11px Orbitron,monospace;color:#ff6cf0;'
      + 'background:rgba(40,4,40,.9);border:1px solid #ff6cf0;border-radius:6px;'
      + 'padding:5px 9px;cursor:pointer;text-shadow:0 0 6px rgba(255,108,240,.6);';
    exportBtn.addEventListener('click', () => {
      const json = exportExhaustDevJSON();
      const flash = (txt) => { exportBtn.textContent = txt; setTimeout(() => { exportBtn.textContent = 'EXPORT JSON'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(() => flash('COPIED \u2713')).catch(() => flash('SEE CONSOLE'));
      } else { flash('SEE CONSOLE'); }
    });
    exhaustDevSlider.appendChild(label);
    exhaustDevSlider.appendChild(input);
    exhaustDevSlider.appendChild(val);
    exhaustDevSlider.appendChild(exportBtn);
    exhaustDevSlider._input = input;
    exhaustDevSlider._val = val;
    ui.appendChild(exhaustDevSlider);
  }
  // Reset slider to 0 on (re)build and sit just above the readout panel.
  exhaustDevSlider._input.value = '0';
  exhaustDevSlider._val.textContent = '0\u00b0';
  exhaustDevSlider.style.display = 'flex';
}

function teardownExhaustDevRig() {
  if (exhaustDev.ship) {
    removeDevShip(exhaustDev.ship);
    exhaustDev.ship = null;
  }
  exhaustDev.markers = [];
  if (exhaustDevHud) exhaustDevHud.style.display = 'none';
  if (exhaustDevSlider) exhaustDevSlider.style.display = 'none';
  // Restore the player's real view choice.
  ui.classList.toggle('third', view === 'third');
}

// Lazily attach a bright marker sphere onto each engine mount group once the model is ready.
function ensureExhaustDevMarkers() {
  const ship = exhaustDev.ship;
  if (!ship || !ship.userData.engines || exhaustDev.markers.length) return;
  for (const eng of ship.userData.engines) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 14, 12),
      new THREE.MeshBasicMaterial({ color: 0xff2cf0, depthTest: false, transparent: true, opacity: 0.95 })
    );
    m.renderOrder = 999;
    eng.group.add(m);     // sits at the mount's local origin
    exhaustDev.markers.push({ eng, marker: m });
  }
}

function exhaustDevSelected() { return exhaustDev.markers[exhaustDev.sel] || null; }

function handleExhaustDevKey(e) {
  e.preventDefault();
  const ship = exhaustDev.ship;
  const step = e.shiftKey ? 0.06 : 0.02;   // world-units per press (Shift = coarse)
  if (e.code === 'Tab') {
    const i = (EXHAUST_DEV_KINDS.indexOf(exhaustDev.kind) + 1) % EXHAUST_DEV_KINDS.length;
    exhaustDev.kind = EXHAUST_DEV_KINDS[i];
    buildExhaustDevRig();
    return;
  }
  if (e.code === 'BracketLeft')  { exhaustDev.sel = (exhaustDev.sel - 1 + exhaustDev.markers.length) % Math.max(1, exhaustDev.markers.length); return; }
  if (e.code === 'BracketRight') { exhaustDev.sel = (exhaustDev.sel + 1) % Math.max(1, exhaustDev.markers.length); return; }
  const rstep = e.shiftKey ? 0.0873 : 0.0262;   // radians per press (~5° coarse / ~1.5° fine)
  const isCapital = exhaustDev.kind === 'capital';
  // CAPITAL HULL ORIENTATION: for the Dreadnought, W/S/A/D/Q/E rotate the WHOLE HULL (so its
  // orientation can be dialed in), and Shift snaps in 90° steps. R zeroes the hull rotation.
  // (For fighters these same keys aim the selected nozzle's exhaust stream, handled below.)
  if (isCapital && ['KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE','KeyR'].includes(e.code)) {
    const mr = exhaustDev.modelRot;
    const hstep = e.shiftKey ? Math.PI / 2 : 0.0262;
    if (e.code === 'KeyW') mr.x -= hstep;
    if (e.code === 'KeyS') mr.x += hstep;
    if (e.code === 'KeyA') mr.y += hstep;
    if (e.code === 'KeyD') mr.y -= hstep;
    if (e.code === 'KeyQ') mr.z += hstep;
    if (e.code === 'KeyE') mr.z -= hstep;
    if (e.code === 'KeyR') { mr.x = 0; mr.y = 0; mr.z = 0; }
    return;
  }
  const sel = exhaustDevSelected();
  if (sel) {
    const p = sel.eng.group.position;
    const r = sel.eng.group.rotation;
    if (e.code === 'ArrowLeft')  p.x -= step;
    if (e.code === 'ArrowRight') p.x += step;
    if (e.code === 'ArrowUp')    p.z -= step;   // -Z = toward the nose
    if (e.code === 'ArrowDown')  p.z += step;   // +Z = toward the tail
    if (e.code === 'PageUp')     p.y += step;
    if (e.code === 'PageDown')   p.y -= step;
    // Rotate the selected nozzle's mount group — aims its exhaust stream (local +Z = flow).
    if (e.code === 'KeyW') r.x -= rstep;         // pitch nose-down of the stream
    if (e.code === 'KeyS') r.x += rstep;
    if (e.code === 'KeyA') r.y += rstep;         // yaw
    if (e.code === 'KeyD') r.y -= rstep;
    if (e.code === 'KeyQ') r.z += rstep;         // roll
    if (e.code === 'KeyE') r.z -= rstep;
    if (e.code === 'KeyR') r.set(0, 0, 0);       // reset this nozzle's orientation
    if (e.code === 'Backspace') {
      sel.eng.group.parent && sel.eng.group.parent.remove(sel.eng.group);
      sel.marker.parent && sel.marker.parent.remove(sel.marker);
      exhaustDev.markers.splice(exhaustDev.sel, 1);
      exhaustDev.sel = Math.max(0, exhaustDev.sel - 1);
    }
  }
  if (e.code === 'KeyN' && ship && ship.userData.engines) {
    // Add a fresh nozzle marker at the model center so you can place an extra engine.
    const eng = { group: new THREE.Group() };
    ship.add(eng.group);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 14, 12),
      new THREE.MeshBasicMaterial({ color: 0xff2cf0, depthTest: false, transparent: true, opacity: 0.95 })
    );
    m.renderOrder = 999; eng.group.add(m);
    ship.userData.engines.push(eng);
    exhaustDev.markers.push({ eng, marker: m });
    exhaustDev.sel = exhaustDev.markers.length - 1;
  }
  if (e.code === 'Backslash') printExhaustDevLayout();
}

function printExhaustDevLayout() {
  const L = exhaustDev.L || 4.6;
  const rows = exhaustDev.markers.map(({ eng }) => {
    const p = eng.group.position, r = eng.group.rotation;
    const pos = `[${(p.x / L).toFixed(3)}, ${(p.y / L).toFixed(3)}, ${(p.z / L).toFixed(3)}]`;
    // Only emit a rot field when the nozzle is actually rotated, to keep clean layouts terse.
    const rotated = Math.abs(r.x) > 1e-4 || Math.abs(r.y) > 1e-4 || Math.abs(r.z) > 1e-4;
    const rot = rotated ? `, rot: [${r.x.toFixed(4)}, ${r.y.toFixed(4)}, ${r.z.toFixed(4)}]` : '';
    return `  { pos: ${pos}${rot} }`;
  });
  console.log(`[exhaustDev] ${exhaustDev.kind} layout (pos in fractions of L=${L}, rot in radians):\n${exhaustDev.kind}: [\n${rows.join(',\n')}\n],`);
}

// Build the current nozzle layout as a pretty JSON string and log it. Position is in
// fractions of hull length L; rotation is the mount group's Euler XYZ in radians (which
// aims the exhaust stream), included only when the nozzle has been rotated.
function exportExhaustDevJSON() {
  const L = exhaustDev.L || 4.6;
  const mounts = exhaustDev.markers.map(({ eng }) => {
    const p = eng.group.position, r = eng.group.rotation;
    const m = { pos: [ +(p.x / L).toFixed(3), +(p.y / L).toFixed(3), +(p.z / L).toFixed(3) ] };
    if (Math.abs(r.x) > 1e-4 || Math.abs(r.y) > 1e-4 || Math.abs(r.z) > 1e-4) {
      m.rot = [ +r.x.toFixed(4), +r.y.toFixed(4), +r.z.toFixed(4) ];
    }
    return m;
  });
  const out = { kind: exhaustDev.kind, L, mounts };
  // For the capital rig, also capture the dialed-in whole-hull orientation (radians) if non-zero.
  const mr = exhaustDev.modelRot;
  if (exhaustDev.kind === 'capital' && (Math.abs(mr.x) > 1e-4 || Math.abs(mr.y) > 1e-4 || Math.abs(mr.z) > 1e-4)) {
    out.modelRot = [ +mr.x.toFixed(4), +mr.y.toFixed(4), +mr.z.toFixed(4) ];
  }
  const json = JSON.stringify(out, null, 2);
  console.log(`[exhaustDev] exported ${exhaustDev.kind} JSON:\n${json}`);
  return json;
}

function updateExhaustDev(dt) {
  const ship = exhaustDev.ship;
  if (!ship) return;
  ensureExhaustDevMarkers();
  // Park the hull at the origin, held still so you can calibrate against a fixed view.
  ship.position.set(0, 0, 0);
  ship.rotation.set(0, exhaustDev.spin, 0);
  const L = exhaustDev.L || 4.6;
  const isCapital = exhaustDev.kind === 'capital';
  // CAPITAL ORIENTATION: apply the manual hull pitch/yaw/roll correction to the loaded model so the
  // Dreadnought's orientation can be dialed in (composes on top of the model's auto-orientation).
  // The exhaust markers live on the model's engine mounts, so they rotate with the hull as intended.
  if (ship.userData.model) {
    ship.userData.model.rotation.set(exhaustDev.modelRot.x, exhaustDev.modelRot.y, exhaustDev.modelRot.z);
  }
  // Plant the camera back + slightly above, looking at the hull. Pull back proportionally to the
  // hull length so a 260-unit Dreadnought fits in frame just like a small fighter does.
  const camBack = isCapital ? L * 1.5 : 9;
  const camUp = isCapital ? L * 0.28 : 1.6;
  camera.position.set(0, camUp, camBack);
  camera.lookAt(0, 0, 0);
  // Run the engine glow/streaks so you can SEE the exhaust beams relative to the markers. Use the
  // same trailScale the capital flies with (3) so its calibration matches in-mission length.
  if (ship.userData.engines) {
    const tScale = isCapital ? 3 : 1;
    const throttle = isCapital ? 0.32 : 0.85;
    updateEngineTrails(ship, dt, throttle, camera, false, tScale, _zeroVel, false, 0.25);
  }
  // HUD readout.
  if (exhaustDevHud) {
    const sel = exhaustDevSelected();
    const deg = (v) => (THREE.MathUtils.radToDeg(v)).toFixed(1);
    const selTxt = sel
      ? `x ${(sel.eng.group.position.x / L).toFixed(3)}  y ${(sel.eng.group.position.y / L).toFixed(3)}  z ${(sel.eng.group.position.z / L).toFixed(3)}  (×L)`
      : '(none)';
    const rotTxt = sel
      ? `pitch ${deg(sel.eng.group.rotation.x)}°  yaw ${deg(sel.eng.group.rotation.y)}°  roll ${deg(sel.eng.group.rotation.z)}°`
      : '(none)';
    const mr = exhaustDev.modelRot;
    // The capital rig adds whole-hull orientation controls; fighters keep the per-nozzle aim keys.
    const hullRotLine = isCapital
      ? `hull rot: pitch ${deg(mr.x)}°  yaw ${deg(mr.y)}°  roll ${deg(mr.z)}°   (W/S · A/D · Q/E · R reset · Shift=90° snap)\n`
      : '';
    const moveAimLines = isCapital
      ? `move nozzle: arrows = X/Z,  PgUp/PgDn = Y  (Shift = coarse)\n`
      : `move: arrows = X/Z,  PgUp/PgDn = Y  (Shift = coarse)\n`
        + `aim:  W/S pitch · A/D yaw · Q/E roll · R reset\n`;
    exhaustDevHud.textContent =
      `EXHAUST CALIBRATION  [P to exit]\n`
      + `hull: ${exhaustDev.kind}   (Tab to cycle)   L=${L}\n`
      + hullRotLine
      + `nozzles: ${exhaustDev.markers.length}   selected: ${exhaustDev.markers.length ? exhaustDev.sel + 1 : 0}  ([ ] to pick)\n`
      + `mount pos: ${selTxt}\n`
      + `mount rot: ${rotTxt}\n`
      + `DRAG a nozzle to move it (screen-plane); ArrowUp/Dn = depth (Z)\n`
      + moveAimLines
      + `N add nozzle · Backspace delete · \\ print layout`;
  }
}

// ---- Exhaust dev: DRAG-AND-DROP nozzle placement --------------------------------------------
// While the exhaust rig is open, the user can grab a nozzle marker with the mouse and slide it
// around, then fine-tune with the keyboard. Picking ray-casts the cursor against the marker
// spheres; dragging projects the cursor onto a camera-facing plane through the grabbed marker and
// writes the result back into the nozzle mount's LOCAL position (the same value the arrow keys
// edit and the exporter reads), so drag + keyboard stay perfectly consistent. Depth toward/away
// from the camera isn't changed by the drag (that axis is ambiguous on screen) — ArrowUp/Down
// handle it. Only ever active when exhaustDev.on, so normal flight input is untouched.
const _exDevRc = new THREE.Raycaster();
const _exDevPointer = new THREE.Vector2();
const _exDevPlane = new THREE.Plane();
const _exDevHitWorld = new THREE.Vector3();
const _exDevCamNormal = new THREE.Vector3();
const _exDevDrag = { active: false, idx: -1 };

// Convert a pointer event to normalized device coords against the canvas rect.
function exDevSetPointer(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  _exDevPointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _exDevPointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function onExhaustDevPointerDown(e) {
  if (!exhaustDev.on || !exhaustDev.markers.length) return;
  exDevSetPointer(e);
  _exDevRc.setFromCamera(_exDevPointer, camera);
  // Test the ray against every nozzle marker sphere; grab the nearest one hit.
  const meshes = exhaustDev.markers.map(m => m.marker);
  const hits = _exDevRc.intersectObjects(meshes, false);
  if (!hits.length) return;
  const idx = meshes.indexOf(hits[0].object);
  if (idx < 0) return;
  exhaustDev.sel = idx;               // selecting via drag mirrors the [ ] selection
  _exDevDrag.active = true;
  _exDevDrag.idx = idx;
  e.preventDefault();
  try { renderer.domElement.setPointerCapture?.(e.pointerId); } catch {}
}

function onExhaustDevPointerMove(e) {
  if (!_exDevDrag.active || !exhaustDev.on) return;
  const entry = exhaustDev.markers[_exDevDrag.idx];
  if (!entry) { _exDevDrag.active = false; return; }
  const grp = entry.eng.group;
  const parent = grp.parent;
  if (!parent) return;
  exDevSetPointer(e);
  _exDevRc.setFromCamera(_exDevPointer, camera);
  // Drag plane: faces the camera and passes through the marker's CURRENT world position, so the
  // grabbed nozzle tracks the cursor in screen space without jumping in depth.
  grp.getWorldPosition(_exDevHitWorld);
  camera.getWorldDirection(_exDevCamNormal);
  _exDevPlane.setFromNormalAndCoplanarPoint(_exDevCamNormal, _exDevHitWorld);
  if (!_exDevRc.ray.intersectPlane(_exDevPlane, _exDevHitWorld)) return;
  // World hit -> the mount's parent local frame -> write the nozzle's local position.
  parent.worldToLocal(_exDevHitWorld);
  grp.position.copy(_exDevHitWorld);
  e.preventDefault();
}

function onExhaustDevPointerUp(e) {
  if (!_exDevDrag.active) return;
  _exDevDrag.active = false;
  _exDevDrag.idx = -1;
  try { renderer.domElement.releasePointerCapture?.(e.pointerId); } catch {}
}

renderer.domElement.addEventListener('pointerdown', onExhaustDevPointerDown);
renderer.domElement.addEventListener('pointermove', onExhaustDevPointerMove);
window.addEventListener('pointerup', onExhaustDevPointerUp);

// ============================================================================================
// ORIENTATION + LASER-ORIGIN DEV MODE
// --------------------------------------------------------------------------------------------
// A live, frozen rig for confirming each hull's axes and pinning where its lasers fire from.
// Toggle with O during gameplay. It parks one hull in front of the camera and draws labeled axis
// arrows so you can SEE which way is front/back/top/bottom, plus editable yellow markers at each
// laser muzzle (read from the ship's userData.muzzles). Side-firing happens when a muzzle sits on
// a flank or the nose points the wrong way — this rig lets you verify both and re-place the guns.
//
//   O            toggle dev mode on/off
//   Tab          cycle hull kind (interceptor / bomber / drone / fighter / slick / og)
//                (slick & O.G. are the allied wingman hulls; they show no muzzle markers
//                 since allies have no gun muzzles, but the axis arrows + modelRot work)
//   [ / ]        select previous / next muzzle marker
//   Arrow keys   move selected muzzle on the model's X (left/right) and Z (fore/aft)
//   PageUp/Down  move selected muzzle on the model's Y (up/down)        (Shift = coarse)
//   N            add a new muzzle at the model center
//   Backspace    delete the selected muzzle
//   \            print + copy the calibrated muzzle layout (fractions of L) for the active hull
// ============================================================================================
const orientDev = { on: false, kind: 'interceptor', ship: null, sel: 0, muzzles: [], axes: null, L: 4.6, spin: 0, modelRot: { x: 0, y: 0, z: 0 } };
const ORIENT_DEV_KINDS = ['interceptor', 'bomber', 'drone', 'fighter', 'slick', 'og'];
const ORIENT_DEV_LEN = { interceptor: 4.6, fighter: 4.8, bomber: 6.2, drone: 3.4, slick: 5.6, og: 5.8 };
let orientDevHud = null;
let orientDevSlider = null;

// Build a flat text label sprite (always faces the camera) used to tag the axis tips.
function makeAxisLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 64px Orbitron, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, 128, 64);
  g.fillStyle = color;
  g.fillText(text, 128, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.renderOrder = 1000;
  spr.scale.set(2.2, 1.1, 1);
  return spr;
}

// Build the four labeled axis arrows (front/back/top/bottom) attached to the ship group, so they
// rotate WITH the hull and always show its true local orientation.
function buildOrientAxes(ship, L) {
  const grp = new THREE.Group();
  const len = L * 0.9;
  // [direction, color, label]. Nose is local -Z; tail +Z; top +Y; bottom -Y.
  const defs = [
    [new THREE.Vector3(0, 0, -1), 0x33ff66, 'FRONT'],
    [new THREE.Vector3(0, 0,  1), 0xff4444, 'BACK'],
    [new THREE.Vector3(0, 1,  0), 0x44aaff, 'TOP'],
    [new THREE.Vector3(0, -1, 0), 0xffaa22, 'BOTTOM']
  ];
  for (const [dir, color, label] of defs) {
    const arrow = new THREE.ArrowHelper(dir.clone().normalize(), new THREE.Vector3(0, 0, 0), len, color, len * 0.22, len * 0.13);
    arrow.line.material.depthTest = false;
    arrow.cone.material.depthTest = false;
    arrow.renderOrder = 998;
    grp.add(arrow);
    const lbl = makeAxisLabel(label, '#' + color.toString(16).padStart(6, '0'));
    lbl.position.copy(dir).multiplyScalar(len + L * 0.18);
    grp.add(lbl);
  }
  ship.add(grp);
  return grp;
}

function toggleOrientDev() {
  orientDev.on = !orientDev.on;
  if (orientDev.on) {
    // Hand the cursor to the user for marker dragging/HUD; flight won't re-grab it while on.
    if (document.pointerLockElement) document.exitPointerLock?.();
    buildOrientDevRig();
  } else teardownOrientDevRig();
}

function buildOrientDevRig() {
  teardownOrientDevRig();
  ui.classList.add('third');
  if (player.userData.modelHolder) player.userData.modelHolder.visible = true;
  keys.clear(); kbHeld.clear();
  orientDev.L = ORIENT_DEV_LEN[orientDev.kind] || 4.6;
  orientDev.spin = 0;
  orientDev.modelRot = { x: 0, y: 0, z: 0 };
  // Wingman hulls (slick/og) build as allies into `allies`; all other kinds build as enemies.
  const ship = makeDevShip(orientDev.kind);
  ship.userData.devFrozen = true;
  orientDev.ship = ship;
  orientDev.sel = 0;
  orientDev.muzzles = [];
  orientDev.axes = null;   // built lazily once the model is oriented (axes are on the ship group)
  if (!orientDevHud) {
    orientDevHud = document.createElement('div');
    orientDevHud.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:50;font:700 12px Orbitron,monospace;'
      + 'color:#ffd23f;background:rgba(14,10,0,.85);border:1px solid #ffd23f;border-radius:8px;padding:10px 12px;'
      + 'white-space:pre;line-height:1.5;text-shadow:0 0 8px rgba(255,210,63,.55);pointer-events:none;';
    ui.appendChild(orientDevHud);
  }
  orientDevHud.style.display = 'block';
  // Y-rotation slider so you can hand-rotate the hull to inspect every face.
  if (!orientDevSlider) {
    orientDevSlider = document.createElement('div');
    orientDevSlider.style.cssText = 'position:absolute;left:12px;bottom:150px;z-index:51;'
      + 'font:700 11px Orbitron,monospace;color:#ffd23f;background:rgba(14,10,0,.9);'
      + 'border:1px solid #ffd23f;border-radius:8px;padding:8px 12px;display:flex;align-items:center;'
      + 'gap:8px;text-shadow:0 0 8px rgba(255,210,63,.55);pointer-events:auto;';
    const label = document.createElement('span'); label.textContent = 'ROT';
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '360'; input.step = '1'; input.value = '0';
    input.style.cssText = 'width:200px;accent-color:#ffd23f;cursor:pointer;';
    const val = document.createElement('span'); val.textContent = '0\u00b0'; val.style.minWidth = '34px';
    input.addEventListener('input', () => {
      orientDev.spin = THREE.MathUtils.degToRad(parseFloat(input.value));
      val.textContent = `${input.value}\u00b0`;
    });
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'EXPORT JSON';
    exportBtn.style.cssText = 'font:700 11px Orbitron,monospace;color:#ffd23f;background:rgba(50,38,0,.9);'
      + 'border:1px solid #ffd23f;border-radius:6px;padding:5px 9px;cursor:pointer;';
    exportBtn.addEventListener('click', () => {
      const json = exportOrientDevJSON();
      const flash = (t) => { exportBtn.textContent = t; setTimeout(() => { exportBtn.textContent = 'EXPORT JSON'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(() => flash('COPIED \u2713')).catch(() => flash('SEE CONSOLE'));
      } else flash('SEE CONSOLE');
    });
    orientDevSlider.appendChild(label); orientDevSlider.appendChild(input); orientDevSlider.appendChild(val); orientDevSlider.appendChild(exportBtn);
    orientDevSlider._input = input; orientDevSlider._val = val;
    ui.appendChild(orientDevSlider);
  }
  orientDevSlider._input.value = '0';
  orientDevSlider._val.textContent = '0\u00b0';
  orientDevSlider.style.display = 'flex';
}

function teardownOrientDevRig() {
  if (orientDev.ship) {
    removeDevShip(orientDev.ship);
    orientDev.ship = null;
  }
  orientDev.muzzles = [];
  orientDev.axes = null;
  if (orientDevHud) orientDevHud.style.display = 'none';
  if (orientDevSlider) orientDevSlider.style.display = 'none';
  ui.classList.toggle('third', view === 'third');
}

// Lazily build the axis arrows and a marker sphere on each laser muzzle once the model is ready.
function ensureOrientDevMarkers() {
  const ship = orientDev.ship;
  if (!ship) return;
  if (!orientDev.axes) orientDev.axes = buildOrientAxes(ship, orientDev.L || 4.6);
  if (!orientDev.muzzles.length && ship.userData.muzzles && ship.userData.muzzles.length) {
    for (const mz of ship.userData.muzzles) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.20, 14, 12),
        new THREE.MeshBasicMaterial({ color: 0xffe21a, depthTest: false, transparent: true, opacity: 0.95 })
      );
      m.renderOrder = 999;
      mz.add(m);   // sits at the muzzle's local origin
      orientDev.muzzles.push({ group: mz, marker: m });
    }
  }
}

function orientDevSelected() { return orientDev.muzzles[orientDev.sel] || null; }

function handleOrientDevKey(e) {
  e.preventDefault();
  const ship = orientDev.ship;
  const step = e.shiftKey ? 0.06 : 0.02;
  if (e.code === 'Tab') {
    const i = (ORIENT_DEV_KINDS.indexOf(orientDev.kind) + 1) % ORIENT_DEV_KINDS.length;
    orientDev.kind = ORIENT_DEV_KINDS[i];
    buildOrientDevRig();
    return;
  }
  if (e.code === 'BracketLeft')  { orientDev.sel = (orientDev.sel - 1 + orientDev.muzzles.length) % Math.max(1, orientDev.muzzles.length); return; }
  if (e.code === 'BracketRight') { orientDev.sel = (orientDev.sel + 1) % Math.max(1, orientDev.muzzles.length); return; }
  // ---- Hull (model) re-orientation: rotate the loaded MODEL inside the ship group so a GLB whose
  // nose doesn't already face -Z can be corrected. The values map straight to a MODEL_ORIENT
  // override; the axis arrows do NOT rotate with it, so you align the model to FRONT/TOP/etc. ----
  const rstep = e.shiftKey ? Math.PI / 2 : 0.0436;   // Shift = exact 90° snaps, else ~2.5°
  const mr = orientDev.modelRot;
  if (e.code === 'KeyW') { mr.x -= rstep; return; }   // pitch
  if (e.code === 'KeyS') { mr.x += rstep; return; }
  if (e.code === 'KeyA') { mr.y += rstep; return; }   // yaw
  if (e.code === 'KeyD') { mr.y -= rstep; return; }
  if (e.code === 'KeyQ') { mr.z += rstep; return; }   // roll
  if (e.code === 'KeyE') { mr.z -= rstep; return; }
  if (e.code === 'KeyR') { mr.x = mr.y = mr.z = 0; return; }   // reset model orientation
  const sel = orientDevSelected();
  if (sel) {
    const p = sel.group.position;
    if (e.code === 'ArrowLeft')  p.x -= step;
    if (e.code === 'ArrowRight') p.x += step;
    if (e.code === 'ArrowUp')    p.z -= step;   // -Z = toward the nose
    if (e.code === 'ArrowDown')  p.z += step;   // +Z = toward the tail
    if (e.code === 'PageUp')     p.y += step;
    if (e.code === 'PageDown')   p.y -= step;
    if (e.code === 'Backspace') {
      sel.group.parent && sel.group.parent.remove(sel.group);
      orientDev.muzzles.splice(orientDev.sel, 1);
      if (ship.userData.muzzles) {
        const idx = ship.userData.muzzles.indexOf(sel.group);
        if (idx >= 0) ship.userData.muzzles.splice(idx, 1);
      }
      orientDev.sel = Math.max(0, orientDev.sel - 1);
    }
  }
  if (e.code === 'KeyN' && ship) {
    const mz = new THREE.Group();
    ship.add(mz);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.20, 14, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe21a, depthTest: false, transparent: true, opacity: 0.95 })
    );
    m.renderOrder = 999; mz.add(m);
    if (!ship.userData.muzzles) ship.userData.muzzles = [];
    ship.userData.muzzles.push(mz);
    orientDev.muzzles.push({ group: mz, marker: m });
    orientDev.sel = orientDev.muzzles.length - 1;
  }
  if (e.code === 'Backslash') { exportOrientDevJSON(); }
}

// Print the laser-muzzle layout (fractions of L) ready to paste into ENEMY_MUZZLE_MOUNTS, and
// return it as a JSON string for the clipboard.
function exportOrientDevJSON() {
  const L = orientDev.L || 4.6;
  const mounts = orientDev.muzzles.map(({ group }) => {
    const p = group.position;
    return [ +(p.x / L).toFixed(3), +(p.y / L).toFixed(3), +(p.z / L).toFixed(3) ];
  });
  const rows = mounts.map((m) => `    [${m[0]}, ${m[1]}, ${m[2]}]`).join(',\n');
  console.log(`[orientDev] ${orientDev.kind} muzzle layout (fractions of L=${L}):\n  ${orientDev.kind}: [\n${rows}\n  ],`);
  // Hull orientation correction (radians, model-space) — included only if the hull was rotated.
  const mr = orientDev.modelRot;
  const rotated = Math.abs(mr.x) > 1e-4 || Math.abs(mr.y) > 1e-4 || Math.abs(mr.z) > 1e-4;
  const modelRot = rotated ? [ +mr.x.toFixed(4), +mr.y.toFixed(4), +mr.z.toFixed(4) ] : null;
  if (rotated) console.log(`[orientDev] ${orientDev.kind} hull rotation correction (radians): [${modelRot.join(', ')}]`);
  const json = JSON.stringify({ kind: orientDev.kind, L, muzzles: mounts, modelRot }, null, 2);
  console.log(`[orientDev] exported ${orientDev.kind} JSON:\n${json}`);
  return json;
}

function updateOrientDev(dt) {
  const ship = orientDev.ship;
  if (!ship) return;
  ensureOrientDevMarkers();
  ship.position.set(0, 0, 0);
  ship.rotation.set(0, orientDev.spin, 0);
  // Apply the manual hull-orientation correction to the loaded model (composes on top of the
  // model's auto-orientation). The axis arrows live on the ship GROUP, so they stay fixed while
  // the model rotates — you spin the model until its nose lines up with the green FRONT arrow.
  if (ship.userData.model) {
    ship.userData.model.rotation.set(orientDev.modelRot.x, orientDev.modelRot.y, orientDev.modelRot.z);
  }
  camera.position.set(0, 2.2, 11);
  camera.lookAt(0, 0, 0);
  // No exhaust in this rig — the nozzles are already calibrated. Keep the engine glow/streaks
  // hidden (hideExhaust=true) so only the axis arrows and laser-origin markers are shown.
  if (ship.userData.engines) {
    updateEngineTrails(ship, dt, 0, camera, false, 1, _zeroVel, true, 0.25);
  }
  if (orientDevHud) {
    const sel = orientDevSelected();
    const L = orientDev.L || 4.6;
    const selTxt = sel
      ? `x ${(sel.group.position.x / L).toFixed(3)}  y ${(sel.group.position.y / L).toFixed(3)}  z ${(sel.group.position.z / L).toFixed(3)}  (×L)`
      : '(none)';
    const deg = (v) => (THREE.MathUtils.radToDeg(v)).toFixed(1);
    const mr = orientDev.modelRot;
    orientDevHud.textContent =
      `ORIENTATION + LASER ORIGIN  [O to exit]\n`
      + `hull: ${orientDev.kind}   (Tab to cycle)\n`
      + `axes: FRONT -Z (green) · BACK +Z (red) · TOP +Y (blue) · BOTTOM -Y (orange)\n`
      + `hull rot: pitch ${deg(mr.x)}°  yaw ${deg(mr.y)}°  roll ${deg(mr.z)}°\n`
      + `   rotate model: W/S pitch · A/D yaw · Q/E roll · R reset  (Shift = 90° snap)\n`
      + `muzzles: ${orientDev.muzzles.length}   selected: ${orientDev.muzzles.length ? orientDev.sel + 1 : 0}  ([ ] to pick)\n`
      + `laser origin: ${selTxt}\n`
      + `   move muzzle: arrows = X/Z,  PgUp/PgDn = Y  (Shift = coarse)\n`
      + `N add muzzle · Backspace delete · \\ print + copy layout`;
  }
}

function updateCamera(dt, snap = false) {
  // The ship's VISIBLE nose is local -Z (matching the cutscene + oriented model); thrust/fire
  // use the same axis, so the camera does too. (getWorldDirection returns local +Z — the tail.)
  const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion).normalize();

  // Hull visibility: show the ship in third-person, hide it in first-person so the cockpit
  // camera can never look through the ship's own geometry (e.g. when pitching the nose down).
  // EXCEPTION: during the warp-in arrival we always show the hull so the player sees their
  // ship streak in, even though that uses a snapped chase camera in first-person.
  // The warp-in arrival AND the pre-jump briefing hold are both framed as a chase shot of the
  // player's own ship in the hyperspace tunnel, regardless of the player's selected view.
  const chaseShot = warpingIn || briefingHold || respawnChase;
  const hull = player.userData.modelHolder;
  const showHull = !cinematicFirstPerson && (view === 'third' || chaseShot);
  if (hull) hull.visible = showHull;
  // Engine exhaust (nozzle glow + world-space trail/beam) is parented to the ship GROUP / world,
  // not the modelHolder, so hiding the hull alone leaves the engine glow floating ahead of the
  // cockpit camera in first-person. Hide it with the hull so first-person never sees our own tail.
  setEngineEffectsVisible(player, showHull);
  // The player's surrounding shield dome reads correctly only when the ship is SEEN from outside
  // (third-person). In first-person the camera sits at the dome's CENTER, so a hit ripple shows up
  // as a glowing patch on the far wall ahead instead of enveloping the pilot — so hide the dome in
  // first-person and convey absorbed hits with the #shieldVignette cockpit edge-flash instead.
  const dome = player.userData.shieldDome;
  if (dome) dome.visible = showHull;

  // The mission-1 cockpit hyperspace beat FORCES first-person (cinematicFirstPerson) even if the
  // player flies in chase.
  if (cinematicFirstPerson) { /* fall through to the first-person seat below */ }
  else if (view === 'third' || chaseShot) {
    // Third-person chase rig matched to the opening cutscene: sit back along the ship's nose
    // axis and a touch above on the ship's OWN up axis, so banks/rolls orbit with the ship.
    const back = nose.clone().multiplyScalar(-1);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion).normalize();
    const dist = 30, height = 6.5;
    const desired = player.position.clone().addScaledVector(back, dist).addScaledVector(up, height);
    // On the first respawn-arrival frame, SNAP the rig behind the ship (consume the one-shot flag) so
    // the camera doesn't sweep across the arena from the kill-cam orbit and make the ship look like
    // it's sliding in backwards. Every later frame lerps normally for a smooth follow.
    const snapNow = snap || _respawnChaseSnap;
    if (_respawnChaseSnap) _respawnChaseSnap = false;
    camera.position.lerp(desired, snapNow ? 1 : 1 - Math.pow(.0008, dt));
    // Roll the camera with the ship: smooth its up vector toward the ship's up.
    if (!camUp || snapNow) camUp = up.clone();
    camUp.lerp(up, 1 - Math.pow(.0006, dt)).normalize();
    camera.up.copy(camUp);
    camera.lookAt(player.position.clone().addScaledVector(nose, 6));
    return;
  }

  // First-person cockpit view: the visible hull is hidden, so we can seat the camera right at
  // the pilot's eye point (the ship origin, lifted a touch on the ship's own up axis) and look
  // straight down the nose. Because the seat tracks the origin and aims along the nose, pitching
  // up/down simply tilts the view — it can no longer dip behind/through the hull geometry.
  const shipUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion).normalize();
  if (!camUp) camUp = shipUp.clone();
  camUp.lerp(shipUp, 1 - Math.pow(.0006, dt)).normalize();
  camera.up.copy(camUp);
  const desired = player.position.clone().addScaledVector(shipUp, .55);
  camera.position.lerp(desired, snap ? 1 : 1 - Math.pow(.0001, dt));
  camera.lookAt(player.position.clone().addScaledVector(nose, 40).addScaledVector(shipUp, .55));
}
// Sling a burst of bright sparks off a picked upgrade card. Builds a small absolutely-positioned
// layer inside the card and spawns several spark divs, each given a random outward vector via the
// --dx/--dy CSS custom properties (read by the .spark keyframes) plus staggered delays so embers
// keep flying for the first stretch of the spin. Purely cosmetic; cleans itself up.
function spawnCardSparks(cardEl) {
  if (!cardEl) return;
  // Overlay the sparks in the #draft container at the card's screen position (NOT inside the card),
  // so they stay put in screen space and keep flying even as the card itself spins off-frame.
  const host = $('draft') || document.body;
  const r = cardEl.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height * 0.42;   // a touch above center, matching the .spark anchor
  const layer = document.createElement('div');
  layer.className = 'sparkLayer';
  // Pin the layer to the viewport over the card; .spark children are positioned at its 50%/42%.
  layer.style.cssText = `position:fixed; left:${cx}px; top:${cy}px; width:0; height:0; z-index:7; pointer-events:none;`;
  const N = 14;
  for (let i = 0; i < N; i++) {
    const sp = document.createElement('span');
    sp.className = 'spark';
    sp.style.left = '0'; sp.style.top = '0';   // override the in-card 50%/42% anchor for this pinned layer
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 130;            // how far the ember flies (px)
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - 40;             // bias upward so they spray up off the spin
    sp.style.setProperty('--dx', `${dx.toFixed(0)}px`);
    sp.style.setProperty('--dy', `${dy.toFixed(0)}px`);
    sp.style.setProperty('--dur', `${(0.55 + Math.random() * 0.5).toFixed(2)}s`);
    sp.style.setProperty('--delay', `${(Math.random() * 0.5).toFixed(2)}s`);
    layer.appendChild(sp);
  }
  host.appendChild(layer);
  // Remove the layer once the longest spark has finished (a touch over max dur+delay).
  setTimeout(() => { layer.remove(); }, 1400);
}
// showDraft({ landing }): bring up the between-mission upgrade screen. With landing:true the
// hangar plays a fly-in/touch-down first and the cards only appear once the ship has set down on
// the deck (used by the mission-1 cinematic); otherwise everything appears together as before.
function showDraft(opts = {}) {
  renderer.setAnimationLoop(null);
  // Release pointer lock so the OS cursor reappears and the player can click the upgrade cards
  // without having to press Escape first.
  document.exitPointerLock?.();
  // POST-MISSION RESULTS GATE: the debrief/warp-out has finished and we're about to bring up the
  // hangar/upgrade draft. First show the results card (kills, hull penalty, achievements) and hold
  // here until the player clicks "Confirmed", which re-enters showDraft with _resultsPending cleared
  // so the hangar/draft proceeds. The flag prevents an infinite loop on the second pass.
  if (!_resultsPending) {
    _resultsPending = true;
    showMissionResults(() => showDraft(opts));
    return;
  }
  _resultsPending = false;   // consumed: continue into the actual draft below
  draftOptions = pickDraft(state.deck); const wrap = $('draftCards'); wrap.innerHTML = '';
  const cardEls = [];
  let _picked = false;   // guard so a second click during the pick animation is ignored
  for (const c of draftOptions) {
    const el = document.createElement('button'); el.className = 'card'; el.innerHTML = `<div class="cardBody"><h2>${c.name}</h2><p>${c.text}</p></div>`;
    el.onclick = () => {
      if (_picked) return;
      _picked = true;
      // Apply the upgrade immediately so game state is settled, then play the visual flourish
      // before the screen tears down and the next mission launches.
      c.mod(state); state.deck.push({ name: c.name }); state.hull = Math.min(100, state.hull + state.mods.repair);
      // Career-long card-draft counter (persists across sessions) feeds the "Veteran of the Deck"
      // achievement at 6 total picks.
      if (leaderboard.bumpCareer('cardsDrafted') >= 6) awardAchievement('on_the_deck');
      audio.unlock();
      audio.playCardSelect(0.9);   // crisp confirmation chime + lift whoosh on the pick
      // The chosen card spins + lifts + settles + spins off; the other two vaporize.
      for (const other of cardEls) {
        if (other === el) other.classList.add('picked');
        else other.classList.add('vaporize');
      }
      spawnCardSparks(el);   // sling a few bright sparks off the spinning card

      // Sequence after the card spin completes: the player ship lifts off the hangar deck and
      // streaks away to lightspeed, then we hand off to the next mission (which itself decides
      // whether to play a briefing or just transition).
      const afterSpin = () => {
        // Ship takeoff out of the hangar: lift off, accelerate toward the viewer + off to the left
        // with a bright exhaust trail. As it clears frame, flash + warp sound; then launch.
        const flashEl = $('warpFlash');
        // Clear the draft's dark vignette and bring the hangar canvas to full opacity so the
        // launching fighter reads cleanly instead of being dimmed behind the overlay.
        $('draft').classList.add('launching');
        if (hangar.canvas) hangar.canvas.style.opacity = '1';
        audio.playLiftoff(0.85);   // engine spool-up as the fighter unsticks from the pad
        let launched = false;
        const toMission = () => {
          if (launched) return; launched = true;
          $('draft').classList.remove('show'); $('draft').classList.remove('launching');
          ui.classList.remove('drafting'); hangar.hide();
          if (hangar.canvas) hangar.canvas.style.opacity = '0.55';   // restore the dimmed backdrop look for next time
          missionIndex++; state.wave++;
          launchMission();   // routes to a mission briefing if one exists, else the normal transition
        };
        // Flash timing (ms): bloom in -> hold full -> fade out. We hold the hangar scene on screen
        // for this entire cycle and only THEN transition, so the warp flash + sound fully play out
        // before the next mission takes over (no cutting away mid-flash).
        const FLASH_IN = 120, FLASH_HOLD = 150, FLASH_OUT = 550, FLASH_TAIL = 120;
        hangar.launchShip({
          onOffscreen: () => {
            // The ship just jumped to lightspeed off-screen: bloom the warp flash + play the warp SFX
            // so the player reads the hyperspace entry, then fade the flash back out.
            audio.playWarp(0.85);
            if (flashEl) {
              flashEl.style.transition = `opacity ${FLASH_IN}ms ease-in`;
              flashEl.style.opacity = '1';
              setTimeout(() => {
                flashEl.style.transition = `opacity ${FLASH_OUT}ms ease-out`;
                flashEl.style.opacity = '0';
              }, FLASH_IN + FLASH_HOLD);
            }
            // Only advance once the flash has fully bloomed AND faded back out (plus a tiny tail),
            // guaranteeing the warp flash/sound complete before the mission transition.
            setTimeout(toMission, FLASH_IN + FLASH_HOLD + FLASH_OUT + FLASH_TAIL);
          },
          // onDone (trail finished) intentionally does NOT transition — the flash cycle owns the handoff.
        });
        // Safety net: never strand the player on the hangar if the offscreen/flash callback is missed.
        setTimeout(toMission, 3200);
      };

      let advanced = false;
      const go = () => { if (advanced) return; advanced = true; afterSpin(); };
      el.addEventListener('animationend', go, { once: true });
      // Safety fallback in case animationend never fires (e.g. reduced-motion / interrupted).
      setTimeout(go, 2200);
    };
    wrap.appendChild(el);
    cardEls.push(el);
  }
  // Swap the flat .webp frame for the 3D card GLB, baked once to an image. Applied to every
  // card's background; falls back to the existing webp inside getCardFrameBackground on failure.
  getCardFrameBackground().then((bg) => {
    for (const el of cardEls) {
      el.style.background = `${bg} center/100% 100%, linear-gradient(#061829,#02050d)`;
    }
  });
  ui.classList.add('drafting');   // hide the gameplay HUD so only the hangar + cards show
  const draftEl = $('draft');
  if (opts.landing) {
    // Hold the cards hidden until the ship lands; show the hangar in landing mode and reveal the
    // draft (cards) once touchdown fires.
    draftEl.classList.remove('show');
    hangar.show({
      landing: true,
      onTouchdown: () => { audio.playHydraulic(0.9); },   // hydraulic gear clunk/hiss on deck contact
      onLanded: () => { draftEl.classList.add('show'); },
    });
  } else {
    draftEl.classList.add('show');
    hangar.show();   // park the player ship in the hangar behind the cards
  }
}
// MANUAL target lock. The player's target NEVER changes on its own — not on spawn, not when a
// closer hostile appears. It only moves when the player presses T (lock nearest) or R (cycle).
// The single exception is clearing a dead/despawned lock so the HUD doesn't point at nothing.
let _lockedEnemy = null;
// True if `o` is a remote pilot (multiplayer) on the LOCAL player's team — a friendly, regardless of
// whether we're flying blue (team 0) or red (team 1). Teammates are treated exactly like scripted
// allies: green bracket/dot, never missile-lockable, selectable only for situational awareness.
function isFriendlyRemote(o) {
  if (!isRemoteContact(o)) return false;
  const myTeam = multiplayer.myTeam || 0;
  return (o.userData.team || 0) === myTeam;
}
// True if the given object is friendly (vs. a hostile): a scripted allied ship OR a same-team remote
// pilot in the arena. Allies can be SELECTED via the cycle key for situational awareness, but never
// lock for missiles or fire-assist.
function isAllyTarget(o) { return !!o && (allies.children.includes(o) || isFriendlyRemote(o)); }
// Selectable allies = live scripted allied ships (not held off-stage in an intro) PLUS same-team
// remote pilots in the arena. All are cyclable for awareness and get a green bracket/dot, but none
// can be missile-locked or shot with fire-assist.
function selectableAllies() {
  const scripted = allies.children.filter(a => a.visible && !a.userData.introHold);
  const teammates = remoteContacts().filter(isFriendlyRemote);
  return [...scripted, ...teammates];
}
// Live Dreadnought SHIELD GENERATOR groups across all capitals — separate lockable hostiles that
// are CHILDREN of the capital (so they move with it) rather than top-level enemies.
function liveShieldGenGroups() {
  const out = [];
  for (const e of enemies.children) {
    if (e.userData.kind === 'capital' && e.userData.shieldGens) {
      for (const sg of e.userData.shieldGens) if (sg.alive) out.push(sg.group);
    }
  }
  return out;
}
// True if `o` is a (still-live) shield generator group.
function isShieldGen(o) { return !!o && o.userData && o.userData.kind === 'shieldgen' && o.userData.ctrlRef && o.userData.ctrlRef.alive; }
// World position of any target. Top-level enemies/allies already live in world space; shield
// generators are parented to the capital, so resolve their world transform.
const _twp = new THREE.Vector3();
function targetWorldPos(o) {
  if (isShieldGen(o)) { o.getWorldPosition(_twp); return _twp; }
  return o.position;
}
// Live remote pilots (other players) that can be locked onto. Empty unless we're connected to the
// arena. Filtered to groups actually present in the scene so a just-removed ship never lingers.
function remoteContacts() {
  return (freeFlightMode && multiplayer.connected) ? multiplayer.remoteGroups() : [];
}
function isRemoteContact(o) { return !!o && o.userData && o.userData.remoteShip === true; }
// All currently lockable HOSTILES: top-level enemies, live shield generators, and — in the arena —
// every ENEMY-TEAM pilot. Same-team pilots are filtered out here so the weapon-lock key (T) and
// fire-assist never point at a friendly; teammates are reachable via cycle (R) as green allies.
function enemyRemoteContacts() { return remoteContacts().filter(o => !isFriendlyRemote(o)); }
function hostileTargets() { return [...enemies.children, ...liveShieldGenGroups(), ...enemyRemoteContacts()]; }
// Passive read used by the HUD/scope each frame: return the currently-locked target with its live
// distance, or undefined if nothing is selected. Auto-clears a selection whose object is gone. The
// returned object flags whether it's an ALLY (so the HUD tints it green and missile-lock refuses it).
// Is the given locked object still a valid, present target this frame?
function lockStillValid(o) {
  if (!o) return false;
  if (isShieldGen(o)) return true;                 // live generator (isShieldGen checks alive)
  if (enemies.children.includes(o)) return true;   // top-level hostile
  if (isRemoteContact(o)) return remoteContacts().includes(o);   // other pilot still in the arena
  if (isAllyTarget(o)) return selectableAllies().includes(o);
  return false;
}
// Display name for any locked contact (hostile fighter, capital, shield generator, or ally).
function targetDisplayName(o) {
  if (isShieldGen(o)) return 'SHIELD GENERATOR';
  if (o.userData.kind === 'capital') return 'DREADNOUGHT';
  if (isRemoteContact(o)) return o.userData.callSign || 'PILOT';   // other player's call sign
  if (isAllyTarget(o)) return o.userData.callSign || 'WINGMAN';
  return (o.userData.kind || 'CONTACT').toUpperCase();
}
// Live integrity 0..1 for any locked contact (generators read their ctrl HP).
function targetHpFrac(o) {
  if (isShieldGen(o)) { const c = o.userData.ctrlRef; return Math.max(0, c.hp / c.maxHp); }
  return Math.max(0, o.userData.hp / o.userData.maxHp);
}
function closestTarget() {
  if (!lockStillValid(_lockedEnemy)) _lockedEnemy = null;
  if (!_lockedEnemy) return undefined;
  const ally = isAllyTarget(_lockedEnemy);
  // `wp` is the target's WORLD position (cloned so callers can keep it for the frame). Shield
  // generators are parented to the capital, so their `.position` is local — always use `wp`.
  const wp = targetWorldPos(_lockedEnemy).clone();
  return { e: _lockedEnemy, wp, d: wp.distanceTo(player.position), isAlly: ally };
}
// T (Lock Target): lock onto the nearest HOSTILE only (including shield generators). Allies are
// never lockable here — this is the weapon/missile-lock key and must always point at something you
// can shoot.
function selectClosestTarget() {
  const list = hostileTargets();
  if (!list.length) { _lockedEnemy = null; flash('NO HOSTILE CONTACTS'); return; }
  let best = null, bestD = Infinity;
  for (const e of list) {
    const d = targetWorldPos(e).distanceTo(player.position);
    if (d < bestD) { bestD = d; best = e; }
  }
  _lockedEnemy = best;
  flash(`LOCK: ${targetDisplayName(best)}`);
  audio.play('shield', 0.25);
  if (tutorialMode && tutorial.active) tutorial.notifyTargetSelected();   // flight-school: closest target selected (T)
}
// R (Cycle Target): step through ALL contacts — every hostile (and live shield generator) first,
// then every selectable ally — wrapping around. Allies are included for situational awareness
// (their bracket is green and they never missile-lock); the closest-target key (T) stays hostiles.
function cycleTarget() {
  const list = [...hostileTargets(), ...selectableAllies()];
  if (!list.length) { _lockedEnemy = null; flash('NO CONTACTS'); return; }
  const idx = _lockedEnemy ? list.indexOf(_lockedEnemy) : -1;
  _lockedEnemy = list[(idx + 1) % list.length];
  if (isAllyTarget(_lockedEnemy)) flash(`ALLY: ${_lockedEnemy.userData.callSign || 'WINGMAN'}`);
  else flash(`TARGET: ${targetDisplayName(_lockedEnemy)}`);
  audio.play('shield', 0.25);
  if (tutorialMode && tutorial.active) tutorial.notifyTargetCycled();   // flight-school: target cycled (R)
}

// Live targeting scope painted into the cockpit's center bezel: a radar grid with a rotating
// sweep, and the tracked target shown as a blip positioned by its bearing relative to the
// ship's facing (forward = scope center, behind = outer ring). Reuses the same `t` as the
// TARGET DATA panel so the scope and readout stay in sync.
const _scV = { fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), rel: new THREE.Vector3() };
function drawTargetScope(t) {
  // Radar center sits at the geometric middle of the canvas so the sweep + blips align with the
  // slim cockpit's centered radar bezel. Radius leaves a small margin from the edges.
  const ctx = scopeCtx, W = scopeCanvas.width, H = scopeCanvas.height, cx = W / 2, cy = H * 0.5, R = W * 0.42;
  ctx.clearRect(0, 0, W, H);
  // Radar "background" (concentric range rings + crosshairs) intentionally removed per design —
  // only the rotating sweep arm (and the target blip) are drawn, leaving a clean transparent scope.

  // Rotating sweep wedge. Enemy cockpit frames tint the arm to an aggressive red/orange to match
  // the captured hulls' hostile HUD theme; friendly (hero) cockpits keep the cyan sweep.
  const enemyCockpit = (document.body.dataset.cockpit || '').startsWith('enemy-');
  const sweepRGB = enemyCockpit ? '255,90,40' : '90,245,255';
  scopeSweep = (scopeSweep + 0.06) % (Math.PI * 2);
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(scopeSweep);
  const sg = ctx.createLinearGradient(0, 0, R, 0);
  sg.addColorStop(0, `rgba(${sweepRGB},0.0)`); sg.addColorStop(1, `rgba(${sweepRGB},${enemyCockpit ? 0.34 : 0.28})`);
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -0.5, 0); ctx.closePath(); ctx.fill();
  ctx.restore();

  // Helper: map a world position to scope (bx,by) by the target's bearing relative to the ship
  // (forward = center, behind = rim). Shared by the locked-target blip and the speaking-ally blips.
  _scV.fwd.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();
  _scV.up.copy(player.up).applyQuaternion(player.quaternion).normalize();
  _scV.right.crossVectors(_scV.fwd, _scV.up).normalize();
  const scopeXY = (worldPos) => {
    _scV.rel.subVectors(worldPos, player.position).normalize();
    const fz = _scV.rel.dot(_scV.fwd), rx = _scV.rel.dot(_scV.right), ry = _scV.rel.dot(_scV.up);
    const rad = (Math.acos(THREE.MathUtils.clamp(fz, -1, 1)) / Math.PI) * R;
    const m = Math.hypot(rx, ry) || 1;
    return [cx + (rx / m) * rad, cy - (ry / m) * rad];
  };

  // SPEAKING WINGMEN: any ally currently transmitting (Slick / O.G. radio lines) is marked on the
  // scope with a pulsing green blip + an antenna glyph, independent of the locked target — so the
  // player can see who's on the radio in first-person even when they're off-screen / far downrange.
  const speakers = allies.children.filter(a => a.userData.speaking && a.visible && !a.userData.introHold);
  if (speakers.length) {
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(performance.now() * 0.006));
    for (const a of speakers) {
      if (t && a === t.e) continue;   // the locked-target blip below already shows it
      const [bx, by] = scopeXY(a.position);
      ctx.fillStyle = `rgba(120,255,170,${0.9 * pulse})`;
      ctx.shadowColor = 'rgba(120,255,170,0.9)'; ctx.shadowBlur = 12 * pulse;
      ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // Pulsing transmit ring.
      ctx.strokeStyle = `rgba(120,255,170,${0.6 * pulse})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bx, by, 7 + 4 * pulse, 0, Math.PI * 2); ctx.stroke();
    }
    // Flag the readout label so the player gets a text cue too.
    scopeLabel.dataset.speaking = speakers.map(a => a.userData.callSign || 'WINGMAN').join(' · ');
  } else {
    delete scopeLabel.dataset.speaking;
  }

  if (t) {
    // Bearing of the target relative to the ship's facing axes (nose = local -Z).
    _scV.fwd.set(0, 0, -1).applyQuaternion(player.quaternion).normalize();
    _scV.up.copy(player.up).applyQuaternion(player.quaternion).normalize();
    _scV.right.crossVectors(_scV.fwd, _scV.up).normalize();
    _scV.rel.subVectors(t.wp, player.position).normalize();
    const fz = _scV.rel.dot(_scV.fwd);                 // 1 ahead, -1 behind
    const rx = _scV.rel.dot(_scV.right);               // + right
    const ry = _scV.rel.dot(_scV.up);                  // + up
    // Map to the scope: ahead -> center, behind -> rim. Use the off-axis angle as radius.
    const ang = Math.acos(THREE.MathUtils.clamp(fz, -1, 1)); // 0 ahead .. PI behind
    const rad = (ang / Math.PI) * R;
    const m = Math.hypot(rx, ry) || 1;
    const bx = cx + (rx / m) * rad;
    const by = cy - (ry / m) * rad;
    const hostile = !t.isAlly;
    const col = hostile ? '255,90,110' : '84,255,154';   // red hostile / green ally
    // Blip with a soft glow + lock brackets.
    ctx.fillStyle = `rgba(${col},0.95)`;
    ctx.shadowColor = `rgba(${col},0.9)`; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(${col},0.9)`; ctx.lineWidth = 1.5;
    const b = 9; ctx.strokeRect(bx - b, by - b, b * 2, b * 2);
    // Line from center to blip (bearing indicator).
    ctx.strokeStyle = `rgba(${col},0.35)`; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(bx, by); ctx.stroke();
    const int = Math.max(0, Math.round(targetHpFrac(t.e) * 100));
    // Contact name (DREADNOUGHT / SHIELD GENERATOR / fighter kind / ally call sign).
    const name = targetDisplayName(t.e);
    scopeLabel.className = 'lock';
    scopeLabel.innerHTML = `${name}<br>${Math.round(t.d)}m · ${int}%`;
  } else if (scopeLabel.dataset.speaking) {
    // No lock, but a wingman is on the radio — show who's transmitting.
    scopeLabel.className = 'speaking';
    scopeLabel.innerHTML = `<span class="caller">📡 ${scopeLabel.dataset.speaking}</span><br><span class="txSub">TRANSMITTING</span>`;
  } else {
    scopeLabel.className = '';
    scopeLabel.innerHTML = 'NO LOCK';
  }
}
// Project the locked target to screen space and frame it with lock brackets so the player can
// confirm the ship shown in the scope is the one in their sights. Shown in BOTH cockpit and chase
// views (the projection uses whichever camera is active), and hidden only when the target is
// behind the camera or off-screen.
function updateTargetBrackets(t) {
  if (!t) { targetBrackets.classList.remove('show'); return; }
  _proj.copy(t.wp).project(camera);
  if (_proj.z > 1) { targetBrackets.classList.remove('show'); return; }   // behind camera
  const sx = (_proj.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
  if (sx < -60 || sx > window.innerWidth + 60 || sy < -60 || sy > window.innerHeight + 60) {
    targetBrackets.classList.remove('show'); return;
  }
  // Bracket size shrinks with distance; clamp so it stays a readable frame. Generators read their
  // ctrl radius (the group has no userData.radius of its own).
  const r = isShieldGen(t.e) ? (t.e.userData.ctrlRef.radius || 2) : (t.e.userData.radius || 1.5);
  const px = THREE.MathUtils.clamp(2600 * r / Math.max(8, t.d), 34, 150);
  targetBrackets.style.left = (sx - px / 2) + 'px';
  targetBrackets.style.top = (sy - px / 2) + 'px';
  targetBrackets.style.width = px + 'px';
  targetBrackets.style.height = px + 'px';
  const int = Math.max(0, Math.round(targetHpFrac(t.e) * 100));
  const name = targetDisplayName(t.e);
  bkTag.textContent = `${name} · ${Math.round(t.d)}m · ${int}%`;
  // Tint the brackets GREEN when an ALLY is selected (friendly), red for hostiles.
  targetBrackets.classList.toggle('ally', !!t.isAlly);
  targetBrackets.classList.add('show');
}
// OFF-SCREEN TARGET ARROW: when the selected target is off-screen (or behind the camera), show a
// directional arrow pinned just inside the screen edge that points toward it, so the pilot always
// knows which way to turn to bring it back into view. Hidden whenever the target is on-screen — the
// lock brackets already frame it there. Distance is printed under the arrow for quick read.
const _tgtArrowEl = $('targetArrow');
const _tgtArrowInner = _tgtArrowEl ? _tgtArrowEl.querySelector('.tgtInner') : null;
const _tgtArrowDist = _tgtArrowEl ? _tgtArrowEl.querySelector('.tgtDist') : null;
const _tgtProj = new THREE.Vector3();
function updateTargetArrow(t) {
  if (!_tgtArrowEl) return;
  if (!t) { _tgtArrowEl.classList.remove('show'); return; }
  _tgtProj.copy(t.wp).project(camera);
  const behind = _tgtProj.z > 1;
  // NDC (-1..1, y up). When behind the camera the projection is mirrored, so flip it to point at
  // the correct side to turn toward.
  let nx = _tgtProj.x, ny = _tgtProj.y;
  if (behind) { nx = -nx; ny = -ny; }
  const sx = (nx * 0.5 + 0.5) * window.innerWidth;
  const sy = (-ny * 0.5 + 0.5) * window.innerHeight;
  // On-screen and in front? The brackets handle it — hide the arrow.
  const onScreen = !behind && sx >= 0 && sx <= window.innerWidth && sy >= 0 && sy <= window.innerHeight;
  if (onScreen) { _tgtArrowEl.classList.remove('show'); return; }
  // Direction to the target in CSS screen space (origin centre, x right, y DOWN).
  const dirX = nx;          // NDC x already matches CSS x (right = +)
  const dirY = -ny;         // NDC y is up; CSS y is down, so flip
  const cssAng = Math.atan2(dirY, dirX);   // CSS-space angle (clockwise positive), glyph points +X at 0
  // Pin the arrow just inside the screen edge along that heading (rectangle edge with a margin).
  const margin = 54;
  const rx = window.innerWidth / 2 - margin;
  const ry = window.innerHeight / 2 - margin;
  const cos = Math.cos(cssAng), sin = Math.sin(cssAng);
  // Distance to the screen-rectangle edge along the heading (clamp so we sit inside both axes).
  const scale = Math.min(rx / Math.max(1e-3, Math.abs(cos)), ry / Math.max(1e-3, Math.abs(sin)));
  const px = cos * scale;
  const py = sin * scale;
  const deg = cssAng * 180 / Math.PI;
  // Move the inner block to the edge point (no rotation here so the label stays upright); the glyph
  // itself rotates to point outward toward the target.
  _tgtArrowInner.style.transform = `translate(${px}px,${py}px)`;
  const glyph = _tgtArrowInner.querySelector('.tgtGlyph');
  if (glyph) glyph.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
  if (_tgtArrowDist) {
    _tgtArrowDist.textContent = `${Math.round(t.d)}m`;
  }
  _tgtArrowEl.classList.toggle('ally', !!t.isAlly);
  _tgtArrowEl.classList.add('show');
}
// Frame whichever ALLY is currently transmitting (userData.speaking) with the green speaking
// brackets + mic glyph, so the player can see at a glance who's on the radio. Independent of the
// selected target. Picks the closest speaking ally if more than one is talking. Considers BOTH the
// single-player wingmen (allies group) and, in multiplayer, same-team remote pilots on push-to-talk.
function updateSpeakBrackets() {
  let talker = null;
  const consider = (o) => {
    if (!talker || o.position.distanceTo(player.position) < talker.position.distanceTo(player.position)) talker = o;
  };
  // Single-player wingmen.
  for (const a of allies.children) {
    if (!a.userData.speaking || !a.visible || a.userData.introHold) continue;
    consider(a);
  }
  // Multiplayer: same-team remote pilots who are transmitting. Honor squad routing — if the talker is
  // on the SQUAD channel, only show them when we're also in squad; a talker on TEAM is heard by all
  // teammates. (Enemy-team transmissions are never shown to us.)
  if (freeFlightMode && multiplayer.connected) {
    for (const g of multiplayer.remoteGroups()) {
      const u = g.userData;
      if (!u || !u.speaking || !g.visible) continue;
      if (u.team !== multiplayer.myTeam) continue;            // only our own team
      if (u.squad && !multiplayer.mySquad) continue;          // squad-only chatter we're not in
      consider(g);
    }
  }
  if (!talker) { speakBrackets.classList.remove('show'); return; }
  _proj.copy(talker.position).project(camera);
  if (_proj.z > 1) { speakBrackets.classList.remove('show'); return; }   // behind camera
  const sx = (_proj.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
  if (sx < -60 || sx > window.innerWidth + 60 || sy < -60 || sy > window.innerHeight + 60) {
    speakBrackets.classList.remove('show'); return;
  }
  const d = talker.position.distanceTo(player.position);
  const r = (talker.userData.radius || 2.2);
  const px = THREE.MathUtils.clamp(2600 * r / Math.max(8, d), 40, 160);
  speakBrackets.style.left = (sx - px / 2) + 'px';
  speakBrackets.style.top = (sy - px / 2) + 'px';
  speakBrackets.style.width = px + 'px';
  speakBrackets.style.height = px + 'px';
  speakTag.textContent = talker.userData.callSign || 'WINGMAN';
  speakBrackets.classList.add('show');
}
// Missile-lock HUD: frame the locked target with a ring that tightens as lock builds and turns
// solid red on full lock. The ring closes from a wide circle down to a tight one as progress
// climbs, giving a clear "lock acquiring" read. Hidden when there's no lockable target on screen.
const _lockEl = $('lockIndicator');
const _lockProjH = new THREE.Vector3();
function updateLockHUD() {
  const t = closestTarget();
  if (!t || lockProgress <= 0.01) { _lockEl.classList.remove('show', 'acquiring', 'locked'); return; }
  _lockProjH.copy(t.wp).project(camera);
  if (_lockProjH.z > 1) { _lockEl.classList.remove('show', 'acquiring', 'locked'); return; }
  const sx = (_lockProjH.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-_lockProjH.y * 0.5 + 0.5) * window.innerHeight;
  _lockEl.style.left = sx + 'px';
  _lockEl.style.top = sy + 'px';
  // Ring shrinks from ~110px (just started) to ~52px (full lock).
  const p = lockProgress / LOCK_TIME;
  const sz = THREE.MathUtils.lerp(110, 52, p);
  const ring = _lockEl.querySelector('.lockRing');
  ring.style.width = sz + 'px'; ring.style.height = sz + 'px';
  ring.style.margin = `${-sz / 2}px 0 0 ${-sz / 2}px`;
  _lockEl.classList.add('show');
  _lockEl.classList.toggle('locked', missileLocked);
  _lockEl.classList.toggle('acquiring', !missileLocked);
}
// ---- Incoming-missile threat warning ----
// Scan for ENEMY seeking missiles currently tracking the PLAYER (`!friendly && target === player`,
// and not already seduced away by a decoy). When any exist, show a pulsing "MISSILE INBOUND"
// banner (with count + closest range) and a directional arrow that swings around the crosshair to
// point at the nearest one — both on-screen (if it's ahead) and off-screen (if it's behind/side),
// so the player knows which way to break. The pulse cadence tightens as the closest missile nears.
const _warnEl = $('missileWarn');
const _warnSub = _warnEl ? _warnEl.querySelector('.warnSub') : null;
const _warnArrowEl = $('missileArrow');
const _warnArrowInner = _warnArrowEl ? _warnArrowEl.querySelector('.arrInner') : null;
const _warnProj = new THREE.Vector3();
function updateMissileWarning() {
  // Suppress while not in live combat (warp rails, menus, game over) — clear and bail.
  if (warping || warpingIn || briefingHold || settingsUI.isOpen() || state.hull <= 0) {
    _warnEl.classList.remove('show'); _warnArrowEl.classList.remove('show'); return;
  }
  let nearest = null, nearestD = Infinity, count = 0;
  for (const m of missileGroup.children) {
    const u = m.userData;
    if (!u.isMissile || u.friendly) continue;
    // Tracking the player and NOT currently seduced off toward a chaff decoy.
    const trackingPlayer = u.target === player && !u.decoy;
    if (!trackingPlayer) continue;
    count++;
    const d = m.position.distanceTo(player.position);
    if (d < nearestD) { nearestD = d; nearest = m; }
  }
  if (!nearest) { _warnEl.classList.remove('show'); _warnArrowEl.classList.remove('show'); return; }

  // Pulse rate scales with proximity: ~0.9s far out (>320m) down to ~0.12s point-blank (<40m).
  const prox = THREE.MathUtils.clamp((nearestD - 40) / (320 - 40), 0, 1);
  const rate = (0.12 + prox * 0.78).toFixed(2) + 's';
  _warnEl.style.setProperty('--warnRate', rate);
  _warnArrowEl.style.setProperty('--warnRate', rate);
  _warnSub.textContent = `${count > 1 ? count + ' THREATS · ' : ''}${Math.round(nearestD)}m`;
  _warnEl.classList.add('show');

  // Directional arrow: rotate so it points from screen-centre toward the nearest missile's screen
  // position. If the threat is behind the camera, project its mirrored direction so the arrow still
  // points to the correct side to break toward. Offset the glyph outward from the pivot.
  _warnProj.copy(nearest.position).project(camera);
  let sx = _warnProj.x, sy = _warnProj.y;       // NDC (-1..1); y up
  if (_warnProj.z > 1) { sx = -sx; sy = -sy; }   // behind camera: flip to indicate the rear arc
  // Screen vector from centre; CSS y is down, so negate y. atan2 gives the heading to the threat.
  const ang = Math.atan2(-sy, sx) * 180 / Math.PI;
  const radius = Math.min(window.innerWidth, window.innerHeight) * 0.18;
  _warnArrowInner.style.transform = `rotate(${ang}deg) translate(${radius}px,0)`;
  _warnArrowEl.classList.add('show');
}
function updateHUD(dt = 0.016) {
  fadeShieldVignette(dt);   // ease the cockpit shield-absorb edge-flash back down
  const rows = [['SHIELDS', state.shields / state.maxShields, 'green'], ['WEAPONS', state.energy / 100, 'amber'], ['ENGINES', Math.min(1, player.userData.vel.length() / (74 * (1 + state.mods.engineSpeed))), ''], ['HULL', state.hull / 100, 'red'], ['HEAT', state.heat / 100, 'red']];
  sysRows.innerHTML = rows.map(r => `<div class="row"><span>${r[0]}</span><div class="bar"><div class="fill ${r[2]}" style="width:${Math.round(r[1]*100)}%"></div></div><b>${Math.round(r[1]*100)}</b></div>`).join('');
  // Live power split on the three routing buttons: highlight whichever system has the most power and
  // print each system's current percentage so the pilot can read the balance at a glance.
  const pmax = Math.max(state.power.shields, state.power.weapons, state.power.engines);
  for (const k of ['shields','weapons','engines']) {
    const el = $(`p-${k}`);
    el.classList.toggle('active', state.power[k] >= pmax - 0.001);
    const pct = el.querySelector('i');
    if (pct) pct.textContent = `${Math.round(state.power[k] * 100)}`;
  }
  const t = closestTarget();
  const tdName = t ? targetDisplayName(t.e) : '';
  targetData.innerHTML = t ? `${t.isAlly ? 'ALLY' : 'LOCK'}: ${tdName}<br>RANGE: ${Math.round(t.d)}m<br>INTEGRITY: ${Math.max(0, Math.round(targetHpFrac(t.e) * 100))}%<br>VECTOR: ${t.wp.x.toFixed(0)} / ${t.wp.y.toFixed(0)} / ${t.wp.z.toFixed(0)}` : 'NO HOSTILE CONTACTS';
  drawTargetScope(t);
  // Rotating ghost render of the locked target inside the radar bezel.
  const ghosting = renderTargetGhost(t, dt);
  ghostCanvas.classList.toggle('live', ghosting && view === 'first');
  // On-screen lock brackets that frame the enemy when it's ahead of the player.
  updateTargetBrackets(t);
  // Off-screen directional arrow pointing to the target when it's out of view.
  updateTargetArrow(t);
  // Green brackets + mic around whichever wingman is currently transmitting.
  updateSpeakBrackets();
  // Missile readout: in the arena the rack is SERVER-authoritative (myMissiles/myMaxMissiles), so the
  // HUD reads server truth there; single-player uses the local loadout + rack upgrades.
  let missileNow, missileCap;
  if (freeFlightMode && multiplayer.connected) {
    missileNow = multiplayer.myMissiles || 0;
    missileCap = multiplayer.myMaxMissiles || 0;
  } else {
    missileCap = state.maxMissiles + (state.mods.missileCapacity || 0);   // base + rack upgrades
    missileNow = state.missiles;
  }
  weaponData.innerHTML = `LASER LINK: QUAD<br>MISSILES: ${missileNow}/${missileCap} · CHAFF: ${state.chaff}/${state.maxChaff}<br>FIRE RATE: ${(1 / Math.max(.08, fireCooldown + .16)).toFixed(1)} cyc/s<br>POWER S/W/E: ${Math.round(state.power.shields*100)}/${Math.round(state.power.weapons*100)}/${Math.round(state.power.engines*100)}<br>VIEW: ${view.toUpperCase()}<br>SCORE: ${state.score}`;
  updateLockHUD();
  updateMissileWarning();
  $('deckList').innerHTML = state.deck.slice(-5).map(c => `◆ ${c.name}`).join('<br>');
  // In Free Flight the arena owns #missionText (pilot count / team / target hints) via
  // updateFreeFlightHud — don't stomp it with the campaign hostiles readout.
  if (!mission.freeflight) {
    const extra = mission.capture ? ` Relay: ${Math.round(capture)}%` : mission.survive ? ` Jump: ${Math.ceil(mission.timer)}s` : ` Hostiles: ${enemies.children.length}`;
    $('missionText').textContent = `${mission.title} ·${extra}`;
  }
  // Flagship integrity readout for DEFEND missions — shown only while the escorted flagship lives.
  const fs = $('flagshipStatus');
  const flag = defendTarget && allies.children.includes(defendTarget) ? defendTarget : null;
  if (flag) {
    const pct = Math.max(0, Math.round(flag.userData.hp / flag.userData.maxHp * 100));
    fs.classList.add('show');
    fs.classList.toggle('critical', pct <= 30);
    $('flagshipPct').textContent = `${pct}%`;
    const fill = $('flagshipFill');
    fill.style.width = `${pct}%`;
    fill.className = `fill ${pct <= 30 ? 'red' : pct <= 60 ? 'amber' : 'green'}`;
  } else {
    fs.classList.remove('show', 'critical');
  }
  // Enemy Dreadnought boss health bar — shown top-center only while the enemy capital lives.
  const ds = $('dreadStatus');
  const cap = enemyCapital();
  if (cap && cap.userData.alive !== false) {
    const dpct = Math.max(0, Math.round(cap.userData.hp / cap.userData.maxHp * 100));
    ds.classList.add('show');
    ds.classList.toggle('critical', dpct <= 25);
    $('dreadPct').textContent = `${dpct}%`;
    $('dreadFill').style.width = `${dpct}%`;
    $('dreadSub').textContent = dpct <= 25 ? 'HULL FAILING' : 'HULL INTEGRITY';
  } else {
    ds.classList.remove('show', 'critical');
  }
  // O.G. defense-objective health bar (Mission 3) — top-center, shown only while O.G. is alive.
  // Friendly green normally, AMBER under 60% and CRITICAL red/pulsing under 30%, so the player can
  // see the escort target slipping into danger and break off to cover him.
  const os = $('ogStatus');
  const og = mission3Active() && protectOG && allies.children.includes(protectOG) ? protectOG : null;
  if (og && og.userData.maxHp > 0) {
    const opct = Math.max(0, Math.round(og.userData.hp / og.userData.maxHp * 100));
    os.classList.add('show');
    os.classList.toggle('warn', opct <= 60 && opct > 30);
    os.classList.toggle('critical', opct <= 30);
    $('ogPct').textContent = `${opct}%`;
    $('ogFill').style.width = `${opct}%`;
    $('ogSub').textContent = opct <= 30 ? 'HULL CRITICAL — COVER HIM' : opct <= 60 ? 'TAKING FIRE' : 'HULL INTEGRITY';
  } else {
    os.classList.remove('show', 'warn', 'critical');
  }
}
