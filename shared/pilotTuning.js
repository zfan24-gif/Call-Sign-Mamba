// Skill is decision quality, not better engines or hidden damage. Shared by campaign and server bots.
export const SKILL_ORDER = ['Novice', 'Officer', 'Veteran', 'Ace', 'Top Ace', 'Super Ace'];
export const SKILL_TABLE = {
  'Novice':    { aimError: 0.075, reactionDelay: 0.95, fireCone: 0.22, evasion: 0.15, warheadChance: 0.25, retaliation: 0.06, morale: 0.50, moraleChance: 0.70, boostDiscipline: 1.0 },
  'Officer':   { aimError: 0.055, reactionDelay: 0.70, fireCone: 0.17, evasion: 0.30, warheadChance: 0.40, retaliation: 0.10, morale: 0.40, moraleChance: 0.55, boostDiscipline: 0.95 },
  'Veteran':   { aimError: 0.040, reactionDelay: 0.50, fireCone: 0.13, evasion: 0.50, warheadChance: 0.55, retaliation: 0.15, morale: 0.30, moraleChance: 0.40, boostDiscipline: 0.85 },
  'Ace':       { aimError: 0.028, reactionDelay: 0.35, fireCone: 0.10, evasion: 0.70, warheadChance: 0.70, retaliation: 0.22, morale: 0.20, moraleChance: 0.25, boostDiscipline: 0.80 },
  'Top Ace':   { aimError: 0.018, reactionDelay: 0.25, fireCone: 0.08, evasion: 0.85, warheadChance: 0.85, retaliation: 0.30, morale: 0.12, moraleChance: 0.15, boostDiscipline: 0.75 },
  'Super Ace': { aimError: 0.010, reactionDelay: 0.15, fireCone: 0.06, evasion: 1.00, warheadChance: 0.95, retaliation: 0.40, morale: 0.00, moraleChance: 0.00, boostDiscipline: 0.70 },
};
// FIRE DISCIPLINE: max bolt time-of-flight (s) to the lead point before a pilot pulls the trigger on
// a fighter-size target (capital ships exempt). Bolts fly 175 m/s and don't inherit shooter speed, so
// a maneuvering fighter is effectively unhittable past ~1s of flight (playtest 2: hits at <100m 50%+,
// 100-160m ~10%, >160m ~1%). Better pilots hold fire for close shots; novices spray at long range.
export const MAX_TOF = { 'Novice': 1.15, 'Officer': 1.0, 'Veteran': 0.85, 'Ace': 0.72, 'Top Ace': 0.66, 'Super Ace': 0.6 };
// The game difficulty setting (settings.difficulty) shifts EVERY flight group's rank by this much.
export const DIFFICULTY_RANK_SHIFT = { recruit: -1, normal: 0, veteran: 1, ace: 2 };
export function shiftRank(rank, shift) {
  const i = Math.max(0, SKILL_ORDER.indexOf(rank));
  return SKILL_ORDER[Math.max(0, Math.min(SKILL_ORDER.length - 1, i + (shift | 0)))];
}

export const EVADE_TABLE = {
  'Novice':    { hitChance: 0.06, dmgGain: 1.0, lowHullGain: 0.20, time: 1.0, cooldown: 6.0, jink: 0.10 },
  'Officer':   { hitChance: 0.12, dmgGain: 1.3, lowHullGain: 0.25, time: 1.3, cooldown: 5.0, jink: 0.18 },
  'Veteran':   { hitChance: 0.22, dmgGain: 1.6, lowHullGain: 0.30, time: 1.6, cooldown: 4.0, jink: 0.26 },
  'Ace':       { hitChance: 0.35, dmgGain: 2.0, lowHullGain: 0.35, time: 1.9, cooldown: 3.2, jink: 0.34 },
  'Top Ace':   { hitChance: 0.50, dmgGain: 2.4, lowHullGain: 0.40, time: 2.2, cooldown: 2.6, jink: 0.42 },
  'Super Ace': { hitChance: 0.65, dmgGain: 2.8, lowHullGain: 0.45, time: 2.5, cooldown: 2.0, jink: 0.50 },
};
export const EVADE_RULES = {
  lowHealth: 0.40,        // hull or shield fraction under this raises the hit-evade chance
  criticalHull: 0.20,     // hull fraction under this lets hits break a committed attack run
  recentDmgDecay: 3.0,    // seconds time-constant of the "recent damage" accumulator
  missileMaxTime: 6.0,    // cap on a missile EVADE
  lockWarnTime: 2.0,      // a completed enemy lock counts as a missile threat for this long
  minStateTime: 1.0,      // no state may change sooner than this (missile threats excepted)
};