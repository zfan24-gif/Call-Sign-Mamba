// ---- Player Ranking / Honor System (Call Sign Mamba) ----------------------------------------
// A career progression ladder. A pilot's rank is driven PRIMARILY by total career kills, with
// smaller logical contributions from multiplayer wins and single-player campaign completions, so
// that consistent combat performance is the main path but not the only one.
//
// PROGRESSION SHAPE (the important part):
//   - A pilot has an integer LEVEL derived from their blended advancement score (see levelForScore).
//   - Each BASE RANK spans 4 displayed levels — e.g. "Recruit 1", "Recruit 2", "Recruit 3",
//     "Recruit 4". Leveling up a 5th time promotes to the next base rank ("Airman 1"). So it takes
//     five level-ups to move from the start of one rank to the start of the next.
//   - The TOP base rank is "Ace". Once a pilot reaches Ace they keep leveling FOREVER, but instead
//     of being grouped into 4s the rank simply counts up: Ace 1, Ace 2, Ace 3, … with no ceiling.
//   - If a pilot ever reaches "Ace 10000", their rank becomes the terminal honor "Mamba One" and
//     never changes again.
//
// This module is the single source of truth for the ladder, the score→level curve, the display
// mapping, the pre-launch "Pioneer Pilot" honor, and the shared rank-badge HTML. It has NO side
// effects and NO storage — callers pass in metrics (career counters locally, or networked fields
// for remote pilots) and read back a plain rank descriptor.

// ---- Advancement score -----------------------------------------------------------------------
// Kills are the backbone. Wins and campaign completions add a modest, logical boost so pilots who
// carry teams / finish the story advance a little faster without letting non-kill metrics dominate.
//   score = careerKills  +  4 * careerWins  +  25 * campaignCompletions
export const RANK_WEIGHTS = { kill: 1, win: 4, campaign: 25 };

export function rankScore({ careerKills = 0, careerWins = 0, campaignCompletions = 0 } = {}) {
  const k = Math.max(0, Math.floor(careerKills));
  const w = Math.max(0, Math.floor(careerWins));
  const c = Math.max(0, Math.floor(campaignCompletions));
  return k * RANK_WEIGHTS.kill + w * RANK_WEIGHTS.win + c * RANK_WEIGHTS.campaign;
}

// ---- Base ranks --------------------------------------------------------------------------------
// The ordered base-rank ladder. Each spans LEVELS_PER_RANK displayed sub-levels (except Ace, which
// is open-ended — see below). `insignia` is a compact glyph in the badge; `color` tints the badge
// and the pilot's name. Ace is the final base rank; nothing comes after it except the Ace-N climb
// and the terminal Mamba One honor.
export const LEVELS_PER_RANK = 4;

export const BASE_RANKS = [
  { id: 'recruit',      name: 'Recruit',        insignia: '▹',   color: '#9fb4c4' },
  { id: 'airman',       name: 'Airman',         insignia: '▸',   color: '#8fd0e6' },
  { id: 'senior_airman',name: 'Senior Airman',  insignia: '➤',   color: '#7fd6ff' },
  { id: 'sergeant',     name: 'Flight Sergeant',insignia: '✦',   color: '#6fe0d6' },
  { id: 'lieutenant',   name: 'Lieutenant',     insignia: '✦✦',  color: '#7be88f' },
  { id: 'captain',      name: 'Captain',        insignia: '★',   color: '#b6f06f' },
  { id: 'major',        name: 'Major',          insignia: '★★',  color: '#e8d86f' },
  { id: 'colonel',      name: 'Colonel',        insignia: '★★★', color: '#f0b46f' },
  { id: 'commander',    name: 'Wing Commander', insignia: '✪',   color: '#ff9d6f' },
  { id: 'ace',          name: 'Ace',            insignia: '✪✪',  color: '#ff7f8f' },
];

// Index of the terminal open-ended base rank ("Ace").
const ACE_INDEX = BASE_RANKS.length - 1;
// The LEVEL (0-based) at which the pilot first reaches "Ace 1". Every base rank below Ace occupies
// LEVELS_PER_RANK levels, so Ace begins right after all of them.
const ACE_START_LEVEL = ACE_INDEX * LEVELS_PER_RANK;
// The Ace ordinal (1-based) at which the terminal "Mamba One" honor is granted.
export const MAMBA_ONE_ACE_ORDINAL = 10000;

// Special terminal / honor visuals.
const MAMBA_ONE = { id: 'mamba_one', name: 'Mamba One', insignia: '🐍', color: '#c88bff' };

// ---- Score → level curve ----------------------------------------------------------------------
// Level thresholds grow super-linearly so early levels come quickly (onboarding) and later levels
// demand sustained combat. The score needed to REACH level L (0-based) is:
//     threshold(L) = round( BASE * L + GROWTH * L^2 )
// This is smooth and unbounded, so the Ace-N climb keeps requiring more each step. Tuning: level 1
// at ~6, level 4 (Recruit→Airman) at ~40, first Ace (level 36) at ~2.6k, Ace 100 at ~big numbers.
const LEVEL_BASE = 5;
const LEVEL_GROWTH = 0.9;
function levelThreshold(level) {
  const L = Math.max(0, Math.floor(level));
  return Math.round(LEVEL_BASE * L + LEVEL_GROWTH * L * L);
}

// The pilot's integer level for a given advancement score (0-based; level 0 = "Recruit 1").
export function levelForScore(score) {
  const s = Math.max(0, Number(score) || 0);
  // Walk upward until the next threshold exceeds the score. Bounded generously so a pathological
  // score can't spin forever; the Mamba One cap sits far below this bound.
  let level = 0;
  const MAX = ACE_START_LEVEL + MAMBA_ONE_ACE_ORDINAL + 10;
  while (level < MAX && s >= levelThreshold(level + 1)) level++;
  return level;
}

// ---- Level → rank descriptor ------------------------------------------------------------------
// Turn an integer level into the full display descriptor used by the badges/screens:
//   { id, name, display, insignia, color, baseRank, subLevel, aceOrdinal, isAce, isMambaOne }
// `display` is the label shown next to the name (e.g. "Captain 3", "Ace 42", "Mamba One").
export function rankForLevel(level) {
  const lvl = Math.max(0, Math.floor(Number(level) || 0));

  // Below Ace: grouped into blocks of LEVELS_PER_RANK, shown as "<Rank> <1..4>".
  if (lvl < ACE_START_LEVEL) {
    const blockIdx = Math.floor(lvl / LEVELS_PER_RANK);
    const sub = (lvl % LEVELS_PER_RANK) + 1;               // 1..4
    const base = BASE_RANKS[blockIdx];
    return {
      id: base.id, name: base.name, display: `${base.name} ${sub}`,
      insignia: base.insignia, color: base.color,
      baseRank: base.id, subLevel: sub, aceOrdinal: 0,
      level: lvl, isAce: false, isMambaOne: false,
    };
  }

  // Ace and beyond: a continuous 1-based ordinal (Ace 1, Ace 2, …). Capped: reaching the ordinal
  // MAMBA_ONE_ACE_ORDINAL (Ace 10000) becomes the terminal "Mamba One", with no further changes.
  const aceOrdinal = (lvl - ACE_START_LEVEL) + 1;          // 1-based
  const ace = BASE_RANKS[ACE_INDEX];
  if (aceOrdinal >= MAMBA_ONE_ACE_ORDINAL) {
    return {
      id: MAMBA_ONE.id, name: MAMBA_ONE.name, display: MAMBA_ONE.name,
      insignia: MAMBA_ONE.insignia, color: MAMBA_ONE.color,
      baseRank: 'ace', subLevel: 0, aceOrdinal: MAMBA_ONE_ACE_ORDINAL,
      level: ACE_START_LEVEL + MAMBA_ONE_ACE_ORDINAL - 1, isAce: true, isMambaOne: true,
    };
  }
  return {
    id: ace.id, name: ace.name, display: `${ace.name} ${aceOrdinal}`,
    insignia: ace.insignia, color: ace.color,
    baseRank: ace.id, subLevel: 0, aceOrdinal,
    level: lvl, isAce: true, isMambaOne: false,
  };
}

// Highest rank descriptor the score qualifies for. Never returns null — everyone starts at
// "Recruit 1". This is the primary entry point the display layer uses.
export function rankForScore(score) { return rankForLevel(levelForScore(score)); }

// Convenience: compute the rank straight from a pilot's career metrics.
export function rankForStats(stats) { return rankForScore(rankScore(stats || {})); }

// The next level up (or null at the Mamba One cap), plus progress toward it — for a career/progress
// UI. `toNext` is the advancement score still needed to reach the next level.
export function rankProgress(stats) {
  const s = rankScore(stats || {});
  const cur = rankForScore(s);
  if (cur.isMambaOne) return { score: s, rank: cur, next: null, pct: 1, toNext: 0 };
  const lvl = levelForScore(s);
  const floor = levelThreshold(lvl);
  const ceil = levelThreshold(lvl + 1);
  const span = Math.max(1, ceil - floor);
  const pct = Math.max(0, Math.min(1, (s - floor) / span));
  return { score: s, rank: cur, next: rankForLevel(lvl + 1), pct, toNext: Math.max(0, ceil - s) };
}

// ---- Pioneer Pilot honor ----------------------------------------------------------------------
// Pre-launch honor: any pilot who flew multiplayer BEFORE the full launch is flagged a Pioneer and
// wears a special color designation on their name forever. `LAUNCHED` gates the honor window — it
// stays false through the pre-launch period; when we fully launch we flip it true so newcomers
// after launch do NOT earn the pre-launch Pioneer status (existing Pioneers keep it, since the flag
// is persisted per-pilot). NOTE: this is separate from disabling dev modes — that flip lives in the
// main game config and is intentionally NOT done here yet.
export const LAUNCHED = false;

// Distinct honor color for Pioneer name/badge treatment (a warm gold that reads on the dark HUD).
export const PIONEER_COLOR = '#ffcf5a';

// Whether the pre-launch Pioneer window is currently open (i.e. new play earns the honor).
export function pioneerWindowOpen() { return !LAUNCHED; }

// ---- Shared badge rendering -------------------------------------------------------------------
// A compact rank badge for use next to a pilot's name anywhere (lobby, live scoreboard, match
// results, kill feed, etc). Returns an HTML string; callers inject it inline before the name.
// `opts.pioneer` adds the Pioneer honor ring/color; `opts.compact` drops the tier word for tight
// rows (icon + color only). The returned markup is self-contained and styled via CSS classes in
// index.html (.rankBadge / .rankBadge.pioneer / .rankName).
export function rankBadgeHtml(rank, opts = {}) {
  const r = rank && rank.insignia ? rank : rankForLevel(0);
  const pioneer = !!opts.pioneer;
  const compact = !!opts.compact;
  const color = pioneer ? PIONEER_COLOR : r.color;
  const cls = 'rankBadge' + (pioneer ? ' pioneer' : '') + (compact ? ' compact' : '')
    + (r.isMambaOne ? ' mamba' : '');
  const disp = r.display || r.name;
  const title = pioneer ? `${disp} · Pioneer Pilot` : disp;
  const label = compact ? '' : `<span class="rankName">${escHtml(disp)}</span>`;
  return `<span class="${cls}" style="--rank-color:${color}" title="${escAttr(title)}">` +
    `<span class="rankPip">${r.insignia}</span>${label}</span>`;
}

// Just the color a pilot's NAME should be tinted (Pioneer overrides the tier color).
export function nameColor(rank, pioneer) {
  if (pioneer) return PIONEER_COLOR;
  return (rank && rank.color) || rankForLevel(0).color;
}

function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
