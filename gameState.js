export const cardPool = [
  { name: 'Overcharged Capacitors', text: '+18% weapon recharge and hotter bolts.', mod: s => { s.mods.weaponRecharge += .18; s.mods.damage += .08; } },
  { name: 'Layered Deflectors', text: '+22 shield max and stronger routed regen.', mod: s => { s.maxShields += 22; s.shields += 22; s.mods.shieldRegen += .22; } },
  { name: 'Tuned Ion Drive', text: '+16% thrust and boost efficiency.', mod: s => { s.mods.engineSpeed += .16; s.mods.boostEfficiency += .22; } },
  { name: 'Targeting Heuristics', text: '+12% damage and longer lock assist.', mod: s => { s.mods.damage += .12; s.mods.lock += .18; } },
  { name: 'Emergency Bypass', text: 'Hull repairs 18 points after each wave.', mod: s => { s.mods.repair += 18; } },
  { name: 'Tri-Vector Distributor', text: 'Power routing grants a larger bonus.', mod: s => { s.mods.routing += .18; } },
  // ---- Missile-focused upgrades ----
  // missileCapacity adds to the per-wave missile loadout; missileDamage scales missile warhead
  // damage only (separate from the bolt `damage` mod). Both stack across multiple picks.
  { name: 'Expanded Missile Racks', text: '+3 missiles to your loadout each wave.', mod: s => { s.mods.missileCapacity += 3; } },
  { name: 'Twin Hardpoints', text: '+2 missiles and a small +10% warhead boost.', mod: s => { s.mods.missileCapacity += 2; s.mods.missileDamage += .10; } },
  { name: 'Warhead Overcharge', text: '+35% missile damage.', mod: s => { s.mods.missileDamage += .35; } },
  { name: 'Shaped-Charge Tips', text: '+50% missile damage for fewer, deadlier shots.', mod: s => { s.mods.missileDamage += .50; } }
];

export function createPlayerState() {
  return {
    hull: 100, shields: 100, maxShields: 100, heat: 0, energy: 100, score: 0, wave: 1,
    // ---- Session scoring (for the worldwide leaderboard + achievements) ----
    // kills = enemy ships destroyed this session (the headline leaderboard stat). missileKills is a
    // subset used for the Sharpshooter achievement. tookHullDamage flips true the first time the
    // hull is breached (used for "flawless"/"untouchable" achievements). waveHullClean tracks the
    // current wave's no-hull-damage status. scoreSubmitted guards against double-posting a run.
    kills: 0, missileKills: 0, tookHullDamage: false, waveHullClean: true, scoreSubmitted: false,
    missiles: 8, maxMissiles: 8, chaff: 6, maxChaff: 6,
    // Continuous power routing: three fractions that always sum to 1.0. Starts at an even 1/3 split.
    // The 1/2/3 keys divert power between systems (see route() in main.js).
    power: { shields: 1 / 3, weapons: 1 / 3, engines: 1 / 3 },
    deck: [{ name: 'Stock Laser Grid' }, { name: 'Basic Deflector' }, { name: 'Military Thrusters' }],
    mods: { weaponRecharge: 0, shieldRegen: 0, engineSpeed: 0, damage: 0, boostEfficiency: 0, lock: 0, repair: 0, routing: 0, missileCapacity: 0, missileDamage: 0 }
  };
}

export const missions = [
  { type: 'DOGFIGHT', title: 'Destroy all enemy fighters', fighters: 7, capital: false, timer: 0 },
  { type: 'CAPITAL STRIKE', title: 'Disable the enemy capital ship', fighters: 4, capital: true, timer: 0 },
  // Mission 3 — ESCORT/REPAIR survival. O.G. took a missile to the engines in the pre-briefing
  // cutscene: he can still fly (slow, smoking, no jump drive) while he effects repairs. The player
  // must hold off enemy fighters for 3 minutes (180s) until his engines come back online and he can
  // jump out. Failed if O.G. dies.
  { type: 'PROTECT O.G.', title: 'Defend the damaged O.G. until repairs complete', fighters: 5, capital: false, protectOG: true, survive: 180, timer: 180 },
  { type: 'BREAK CONTACT', title: 'Survive until jump drive spools', fighters: 9, capital: false, survive: 75, timer: 75 },
  { type: 'DEFEND', title: 'Protect the flagship Aegis Prime', fighters: 8, capital: false, defend: true, escort: 5, timer: 0 }
];

export function pickDraft(deck) {
  const available = cardPool.filter(c => !deck.some(d => d.name === c.name));
  return [...available].sort(() => Math.random() - .5).slice(0, 3);
}
