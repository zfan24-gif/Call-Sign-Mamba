// ---- Worldwide Leaderboard + Achievements (Call Sign Mamba) ----------------------------------
// A shared, persistent scoreboard backed by InstantDB. Scores are keyed to a single game SESSION:
// how many enemy ships the pilot destroyed (with a small penalty for taking HULL damage), tagged
// with the difficulty that was selected. Achievements are creative milestones; unlock state is
// persisted locally (per-browser) and surfaced with toast pops + a menu panel.
//
// SECURITY MODEL: the browser holds NO secret. It talks only to OUR serverless proxy (see
// /server/leaderboard-proxy.js). The proxy holds the InstantDB admin token server-side, validates
// and clamps every submission, and forwards a sanitized request to InstantDB. The admin token never
// reaches the browser, so nothing privileged can leak.
//
//   browser (this file)  ->  PROXY_URL (holds admin token)  ->  InstantDB admin API
//
// We talk to the proxy with plain one-shot fetch (no realtime socket), so the console stays clean —
// none of the @instantdb/core SDK's VM-level hydration rejections can occur here.
//
// TO GO LIVE: deploy /server/leaderboard-proxy.js (see /server/README.md), then paste its public URL
// into PROXY_URL below. Until a real https URL is set, the module runs in OFFLINE mode (the game
// plays normally, local achievements still work, and scores are simply not posted).
const PROXY_URL = 'https://mamba-leaderboard.zfan24.workers.dev/';

// "Configured/online" means a usable https proxy URL is set. Anything else keeps us cleanly OFFLINE.
const PROXY_URL_VALID = typeof PROXY_URL === 'string' && /^https:\/\/\S+/i.test(PROXY_URL);

// One-shot POST to the proxy with a timeout guard so the UI never hangs on a dead network. The body
// carries a plain { action, ...fields } payload; the proxy decides what to do with it server-side.
async function proxyFetch(body, timeoutMs = 6000) {
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (t) clearTimeout(t);
  }
}

// "Online" / "configured" means a usable proxy URL is set. No socket — requests fire on demand.
export function isOnline() { return PROXY_URL_VALID; }
export function isConfigured() { return PROXY_URL_VALID; }

// ---- Pilot name persistence -------------------------------------------------------------------
const NAME_KEY = 'mamba.pilotName';
export function getPilotName() {
  try { return (localStorage.getItem(NAME_KEY) || '').slice(0, 16); } catch { return ''; }
}
export function setPilotName(name) {
  const clean = sanitizeName(name);
  try { localStorage.setItem(NAME_KEY, clean); } catch {}
  return clean;
}
export function sanitizeName(name) {
  return String(name || '').replace(/[^\w .\-]/g, '').trim().slice(0, 16);
}

// ---- Difficulty labelling ---------------------------------------------------------------------
const DIFF_LABEL = { recruit: 'RECRUIT', normal: 'NORMAL', veteran: 'VETERAN', ace: 'ACE' };
export function difficultyLabel(d) { return DIFF_LABEL[d] || String(d || '').toUpperCase() || 'NORMAL'; }

// ---- Submission -------------------------------------------------------------------------------
// Push one finished run to the worldwide board. Resolves to true on success, false if offline or
// the run is empty (no score AND no kills — nothing worth recording).
export async function submitScore({ name, score, kills, difficulty }) {
  if (!PROXY_URL_VALID) return false;
  const s = Math.max(0, Math.round(score || 0));
  const k = Math.max(0, Math.round(kills || 0));
  if (s <= 0 && k <= 0) return false;
  try {
    // Hand a plain payload to the proxy; it re-sanitizes/clamps server-side before writing.
    const res = await proxyFetch({
      action: 'submit',
      name: sanitizeName(name) || 'ANONYMOUS',
      score: s,
      kills: k,
      difficulty: String(difficulty || 'normal'),
    });
    return !!(res && res.ok);
  } catch (err) {
    console.warn('[leaderboard] submitScore failed:', err);
    return false;
  }
}

// Best-effort submit for page-close (pagehide/visibilitychange). A normal fetch() is often killed
// mid-flight as the tab unloads, so we use navigator.sendBeacon, which the browser guarantees to
// deliver even after the page goes away. Fire-and-forget: there's no response to await on unload.
// Returns true if the beacon was queued. The proxy treats it exactly like a normal `submit`.
export function submitScoreBeacon({ name, score, kills, difficulty }) {
  if (!PROXY_URL_VALID) return false;
  const s = Math.max(0, Math.round(score || 0));
  const k = Math.max(0, Math.round(kills || 0));
  if (s <= 0 && k <= 0) return false;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    // No beacon support: fall back to a keepalive fetch so the close-path still tries to deliver.
    try {
      fetch(PROXY_URL, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', name: sanitizeName(name) || 'ANONYMOUS', score: s, kills: k, difficulty: String(difficulty || 'normal') }),
      });
      return true;
    } catch { return false; }
  }
  try {
    const body = JSON.stringify({
      action: 'submit',
      name: sanitizeName(name) || 'ANONYMOUS',
      score: s, kills: k,
      difficulty: String(difficulty || 'normal'),
    });
    // text/plain avoids a CORS preflight on unload (the proxy parses the JSON body either way).
    const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
    return navigator.sendBeacon(PROXY_URL, blob);
  } catch { return false; }
}

// ---- Top-N query (one-shot) -------------------------------------------------------------------
// Pulls the highest scores once and resolves with a sorted, capped array. Uses a single live
// subscription that we immediately tear down, so callers get a clean Promise without holding a sub.
export async function fetchTopScores(limit = 50) {
  if (!PROXY_URL_VALID) return null;
  try {
    // Ask the proxy for the top rows; it queries InstantDB and returns an already sorted, capped,
    // sanitized array. A single JSON Promise — no socket, no held subscription.
    const res = await proxyFetch({ action: 'top', limit });
    const rows = (res && res.ok && Array.isArray(res.scores)) ? res.scores : [];
    return [...rows]
      .sort((a, b) => (b.score - a.score) || (b.kills - a.kills) || (a.createdAt - b.createdAt))
      .slice(0, limit);
  } catch (err) {
    console.warn('[leaderboard] fetchTopScores failed:', err);
    return null;
  }
}

// ---- Achievements -----------------------------------------------------------------------------
// A creative catalog. Each has an id, name, flavor description, and an icon glyph. Unlock state is
// stored locally so it persists per-browser across sessions. Definitions are evaluated by main.js
// against live run stats (see ACHIEVEMENTS export + the unlock helpers below).
export const ACHIEVEMENTS = [
  { id: 'first_blood',   icon: '🩸', name: 'First Blood',        desc: 'Destroy your first enemy ship.' },
  { id: 'ace_run',       icon: '🎯', name: 'Ace in a Day',       desc: 'Score 5 kills in a single session.' },
  { id: 'double_ace',    icon: '✦',  name: 'Double Ace',         desc: 'Reach 10 kills in one session.' },
  { id: 'centurion',     icon: '🏛️', name: 'Centurion',          desc: 'Reach 25 kills in one session.' },
  { id: 'capital_kill',  icon: '💥', name: 'Dreadnought Down',   desc: 'Destroy an enemy capital ship.' },
  { id: 'untouchable',   icon: '🛡️', name: 'Untouchable',        desc: 'Clear a wave without taking any hull damage.' },
  { id: 'flawless',      icon: '💎', name: 'Flawless Pilot',     desc: 'End a session having never lost hull integrity.' },
  { id: 'sharpshooter',  icon: '🔭', name: 'Sharpshooter',       desc: 'Land 6 missile kills in one session.' },
  { id: 'survivor',      icon: '⏱️', name: 'Survivor',           desc: 'Survive the full Protect O.G. hold.' },
  { id: 'escort_hero',   icon: '🤝', name: 'Brothers in Arms',   desc: 'Keep O.G. alive through Mission 3.' },
  { id: 'high_roller',   icon: '👑', name: 'High Roller',        desc: 'Bank a session score of 2,500 or more.' },
  { id: 'legend',        icon: '🌟', name: 'Living Legend',      desc: 'Bank a session score of 6,000 or more.' },
  { id: 'on_the_deck',   icon: '⚙️', name: 'Veteran of the Deck',desc: 'Draft 6 upgrade cards across your career.' },
  { id: 'ace_difficulty',icon: '☠️', name: 'No Quarter',         desc: 'Win a session on ACE difficulty.' },
  { id: 'pacifist_chaff',icon: '🌫️', name: 'Smoke & Mirrors',    desc: 'Break a missile lock with chaff.' },
];

const ACH_KEY = 'mamba.achievements';
function loadUnlocked() {
  try { return new Set(JSON.parse(localStorage.getItem(ACH_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveUnlocked(set) {
  try { localStorage.setItem(ACH_KEY, JSON.stringify([...set])); } catch {}
}
let _unlocked = loadUnlocked();

export function isUnlocked(achId) { return _unlocked.has(achId); }
export function unlockedSet() { return new Set(_unlocked); }
export function unlockedCount() { return _unlocked.size; }
export function achievementById(achId) { return ACHIEVEMENTS.find(a => a.id === achId) || null; }

// Mark an achievement unlocked. Returns the achievement def the FIRST time it's newly unlocked
// (so the caller can fire a toast), or null if it was already unlocked / unknown.
export function unlock(achId) {
  if (_unlocked.has(achId)) return null;
  const def = achievementById(achId);
  if (!def) return null;
  _unlocked.add(achId);
  saveUnlocked(_unlocked);
  return def;
}

// ---- Career counters (persisted, used by some achievements like total cards drafted) ----------
const CAREER_KEY = 'mamba.career';
function loadCareer() {
  try { return JSON.parse(localStorage.getItem(CAREER_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveCareer(c) { try { localStorage.setItem(CAREER_KEY, JSON.stringify(c)); } catch {} }
let _career = loadCareer();
export function bumpCareer(key, by = 1) {
  _career[key] = (_career[key] || 0) + by;
  saveCareer(_career);
  return _career[key];
}
export function getCareer(key) { return _career[key] || 0; }

// ---- Ranking / honor career metrics -----------------------------------------------------------
// The ranking system (see ranks.js) reads a pilot's lifetime metrics from these persisted career
// counters. Kills are the primary driver; wins and campaign completions add smaller boosts. We
// namespace the ranking keys under `rank_*` so they can't collide with achievement career keys.
//   rank_kills     — total confirmed kills across all modes (single-player + multiplayer)
//   rank_wins      — multiplayer matches won (on the winning team at match end)
//   rank_campaign  — single-player campaign completions
const PIONEER_KEY = 'mamba.pioneer';

// Add to lifetime kills (call whenever the pilot lands a confirmed kill, SP or MP).
export function addCareerKills(n = 1) { return bumpCareer('rank_kills', Math.max(0, Math.round(n))); }
// Record a multiplayer match win.
export function addCareerWin() { return bumpCareer('rank_wins', 1); }
// Record a single-player campaign completion.
export function addCampaignCompletion() { return bumpCareer('rank_campaign', 1); }

// The full metric bundle the ranking system consumes. Read once and hand to ranks.rankForStats().
export function careerRankStats() {
  return {
    careerKills: getCareer('rank_kills'),
    careerWins: getCareer('rank_wins'),
    campaignCompletions: getCareer('rank_campaign'),
  };
}

// ---- Pioneer Pilot honor (pre-launch) ---------------------------------------------------------
// A pilot becomes a Pioneer the first time they play multiplayer during the pre-launch window.
// Persisted per-browser so the honor sticks forever, even after full launch. `ranks.js` owns the
// window gate (LAUNCHED); this layer only stores/reads the earned flag.
export function isPioneer() {
  try { return localStorage.getItem(PIONEER_KEY) === '1'; } catch { return false; }
}
// Grant the Pioneer honor (idempotent). Returns true if this call newly granted it.
export function grantPioneer() {
  if (isPioneer()) return false;
  try { localStorage.setItem(PIONEER_KEY, '1'); } catch {}
  return true;
}