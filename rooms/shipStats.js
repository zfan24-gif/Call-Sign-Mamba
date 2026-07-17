// ---- Authoritative ship balance (server copy) ------------------------------------------------
// The server is the sole authority on combat, so it keeps its OWN plain copy of each playable
// hull's balance multipliers (deliberately NOT importing the browser-side shipRoster.js, which
// pulls in Three.js / localStorage). Keep these numbers in sync with /shipRoster.js `stats`.
//
// All values are multipliers around the Lightning baseline (1.0). They tune:
//   • shield  → max shield capacity
//   • hull    → max hull integrity
//   • speed   → applied to movement (informational here; the shared flightModel can read it later)
//   • firepower → bolt damage this hull deals
//   • missiles → starting/max guided-missile loadout for this hull (authoritative ammo cap)
// Advantages are intentionally SMALL (±10–25%) so no single hull dominates.
const SHIP_STATS = {
  lightning: {
    shield: 1.0, hull: 1.0, speed: 1.0, firepower: 1.0, missiles: 4,
    muzzles: [
      { x: -1.0, y: 0.0, z: -3.0 }, { x: 1.0, y: 0.0, z: -3.0 },
      { x: -1.7, y: -0.6, z: -3.0 }, { x: 1.7, y: -0.6, z: -3.0 }
    ]
  },
  fury: {
    shield: 1.0, hull: 1.12, speed: 0.9, firepower: 1.18, missiles: 4,
    muzzles: [
      { x: 1.0, y: 0.0, z: -0.06 }, { x: -1.0, y: 0.0, z: 0.0 },
      { x: 1.0, y: -0.34, z: -0.73 }, { x: -1.0, y: -0.28, z: -0.90 }
    ]
  },
  concept: {
    shield: 1.2, hull: 1.0, speed: 1.05, firepower: 0.9, missiles: 5,
    muzzles: [
      { x: -0.7, y: 0.0, z: -2.3 }, { x: 0.7, y: 0.0, z: -2.3 }
    ]
  },
  interceptor: {
    shield: 0.85, hull: 0.9, speed: 1.2, firepower: 1.0, missiles: 4,
    muzzles: [
      { x: -0.44, y: -0.32, z: -0.63 }, { x: 0.44, y: -0.31, z: -0.58 }
    ]
  },
  fighter: {
    shield: 1.08, hull: 1.06, speed: 0.96, firepower: 1.0, missiles: 4,
    muzzles: [
      { x: -0.1, y: -0.28, z: -2.35 }, { x: 0.15, y: -0.28, z: -2.31 }
    ]
  },
  bomber: {
    shield: 1.05, hull: 1.2, speed: 0.82, firepower: 1.25, missiles: 6,
    muzzles: [
      { x: -0.62, y: -0.12, z: -2.85 }, { x: 0.62, y: -0.12, z: -2.85 },
      { x: -0.52, y: -0.56, z: -2.66 }, { x: 0.52, y: -0.52, z: -2.76 }
    ]
  },
};

const DEFAULT_SHIP = 'lightning';

// Team rosters (must match /shipRoster.js). Blue = hero hulls, red = captured enemy hulls.
const BLUE_SHIPS = ['concept', 'fury', 'lightning'];
const RED_SHIPS = ['interceptor', 'fighter', 'bomber'];
function rosterFor(team) { return team === 1 ? RED_SHIPS : BLUE_SHIPS; }

// Validate a client-supplied ship id; unknown ids fall back to a safe default. When a `team` is
// given (0 blue / 1 red), the id is additionally required to belong to that team's roster —
// anything off-roster falls back to that team's first hull (anti-tamper: red can't fly a hero hull).
export function sanitizeShip(id, team) {
  const key = String(id || '').toLowerCase();
  if (team === 0 || team === 1) {
    const roster = rosterFor(team);
    return roster.includes(key) ? key : roster[0];
  }
  return SHIP_STATS[key] ? key : DEFAULT_SHIP;
}

// The balance multipliers for a (validated) ship id.
export function statsFor(id) {
  return SHIP_STATS[sanitizeShip(id)];
}
