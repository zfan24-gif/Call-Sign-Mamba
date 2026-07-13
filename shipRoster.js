// ---- Playable ship roster (multiplayer) -------------------------------------------------------
// The definitive list of ships a pilot may fly in the multiplayer arena. Six hulls only:
//   • Three hero hulls — Mamba's PT3 Lightning, Slick's PT2 Fury, O.G.'s PT1 Concept.
//   • Three captured enemy fighters — Interceptor, Fighter, Bomber (the Mission 1/2 starfighters).
// The recon DRONE and the capital ships/dreadnought are deliberately NOT selectable.
//
// Each hull gets a SMALL, deliberately-balanced edge in one dimension (shields / speed / firepower)
// so there's a reason to prefer one — but never a runaway "everyone flies the same ship" pick. The
// numbers are normalized around the Lightning as the all-rounder baseline (1.0 across the board).
//
// This module is the single source of truth shared by the ship-select menu, the cockpit swapper,
// makePlayerShip(), and the networked remote-ship renderer. The server keeps its OWN plain copy of
// the combat-relevant multipliers (see /server-realtime/rooms/shipStats.js) so it can stay
// authoritative without importing browser code.

// model urls MUST match the hulls registered in scene.js (same GLB paths → shared preload cache).
export const SHIPS = {
  // ---- Hero hulls ------------------------------------------------------------------------------
  lightning: {
    id: 'lightning',
    name: 'PT3 Lightning',
    pilot: 'MAMBA',
    blurb: 'The benchmark. No weakness, no gimmick — pure balanced dogfighter.',
    model: 'assets/starfighters/meshy_ai_azure_starfighter_0610205715_texture.glb',
    len: 6.2,
    // Modern frameless holo-canopy with a lowered three-screen console (transparent glass, empty radar).
    cockpit: 'assets/cockpit-holo-clear-a.webp',
    tint: '#57e0ff',
    // Combat multipliers vs. baseline. 1.0 = Lightning baseline.
    stats: { shield: 1.0, speed: 1.0, firepower: 1.0, hull: 1.0 },
    role: 'ALL-ROUNDER',
  },
  fury: {
    id: 'fury',
    name: 'PT2 Fury',
    pilot: 'SLICK',
    blurb: 'Heavy gun mounts and a reinforced spar — hits harder and holds together longer, but sluggish.',
    model: 'assets/starfighters/slickc.glb',
    len: 5.6,
    // Modern double-arch holo-canopy with a lowered three-screen console (transparent glass, empty radar).
    cockpit: 'assets/cockpit-holo-clear-b.webp',
    tint: '#ffb14a',
    // Firepower + hull bruiser; pays with a lower top speed.
    stats: { shield: 1.0, speed: 0.9, firepower: 1.18, hull: 1.12 },
    role: 'GUNSHIP',
  },
  concept: {
    id: 'concept',
    name: 'PT1 Concept',
    pilot: 'O.G.',
    blurb: 'Experimental deflector rig. Shields for days and quick to line up a shot — light on punch.',
    model: 'assets/starfighters/ogc.glb',
    len: 5.8,
    // Modern soft-arch holo-canopy with a lowered three-screen console (transparent glass, empty radar).
    cockpit: 'assets/cockpit-holo-clear-f.webp',
    tint: '#9b7cff',
    // Shield tank with strong agility; softer guns.
    stats: { shield: 1.2, speed: 1.05, firepower: 0.9, hull: 1.0 },
    role: 'INTERCEPTOR',
  },
  // ---- Captured enemy fighters -----------------------------------------------------------------
  interceptor: {
    id: 'interceptor',
    name: 'Crimson Interceptor',
    pilot: 'CAPTURED',
    blurb: 'Stripped-down speed demon. Fastest hull in the arena, but thin shields and a light hull.',
    model: 'assets/starfighters/meshy_ai_crimson_starfighter_0610223402_texture.glb',
    len: 4.6,
    // Modern crimson racing canopy with a lowered three-screen console (transparent glass, empty radar).
    cockpit: 'assets/cockpit-enemy-interceptor.webp',
    tint: '#ff5a6e',
    // Glass-cannon speedster.
    stats: { shield: 0.85, speed: 1.2, firepower: 1.0, hull: 0.9 },
    role: 'SPEEDSTER',
  },
  fighter: {
    id: 'fighter',
    name: 'Vanguard Fighter',
    pilot: 'CAPTURED',
    blurb: 'Rugged all-purpose hostile hull. A hair tankier than the Lightning at the cost of some zip.',
    model: 'assets/starfighters/enemysf.glb',
    len: 4.8,
    // Modern rugged burnt-orange canopy with a lowered three-screen console (transparent glass, empty radar).
    cockpit: 'assets/cockpit-enemy-fighter.webp',
    tint: '#ff7a52',
    // Sturdy generalist.
    stats: { shield: 1.08, speed: 0.96, firepower: 1.0, hull: 1.06 },
    role: 'BRAWLER',
  },
  bomber: {
    id: 'bomber',
    name: 'Gunshi Bomber',
    pilot: 'CAPTURED',
    blurb: 'Ordnance platform. The biggest guns and thickest hull on the field — and the slowest turn.',
    model: 'assets/starfighters/meshy_ai_crimson_vortex_gunshi_0610223218_texture.glb',
    len: 6.2,
    // Modern heavy armored canopy with a lowered three-screen console (transparent glass, empty radar).
    cockpit: 'assets/cockpit-enemy-bomber.webp',
    tint: '#ff9a3c',
    // Slow, heavy hitter.
    stats: { shield: 1.05, speed: 0.82, firepower: 1.25, hull: 1.2 },
    role: 'HEAVY',
  },
};

// Menu display order.
export const SHIP_ORDER = ['lightning', 'fury', 'concept', 'interceptor', 'fighter', 'bomber'];

// Team rosters for the multiplayer ship-select. BLUE flies the three hero hulls (PT1/PT2/PT3);
// RED flies the three captured "enemy" fighters from single-player. Team 0 = blue, 1 = red.
export const BLUE_SHIPS = ['concept', 'fury', 'lightning'];      // PT1 Concept, PT2 Fury, PT3 Lightning
export const RED_SHIPS = ['interceptor', 'fighter', 'bomber'];   // enemy hulls

// Ships selectable by a given team id (0 blue, 1 red). Falls back to blue for anything unexpected.
export function shipsForTeam(team) {
  return team === 1 ? RED_SHIPS.slice() : BLUE_SHIPS.slice();
}
// Default pick for a team — the first ship in that team's roster.
export function defaultShipForTeam(team) {
  return shipsForTeam(team)[0];
}
// Engine-exhaust palette for a hull: the captured enemy (RED) hulls fly with the hostile red
// exhaust; the hero hulls keep the player's blue exhaust. Used so a pilot flying a captured hull
// (multiplayer red team, or the dev force-red flow) gets red engine trails, not blue.
export function paletteForShip(id) {
  return RED_SHIPS.includes(id) ? 'red' : 'blue';
}

export const DEFAULT_SHIP_ID = 'lightning';

// Safe lookup — always returns a valid ship (falls back to the Lightning).
export function getShip(id) {
  return SHIPS[id] || SHIPS[DEFAULT_SHIP_ID];
}

// Persist / restore the pilot's last pick so the menu remembers it between sessions.
const LS_KEY = 'mamba.shipChoice';
export function loadShipChoice() {
  try {
    const id = localStorage.getItem(LS_KEY);
    if (id && SHIPS[id]) return id;
  } catch {}
  return DEFAULT_SHIP_ID;
}
export function saveShipChoice(id) {
  try { if (SHIPS[id]) localStorage.setItem(LS_KEY, id); } catch {}
}
