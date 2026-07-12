// ---- Ship Hangar cosmetics system (Call Sign Mamba) ------------------------------------------
// The single source of truth for the customization a pilot can equip in the Ship Hangar:
//   • Hull skin  — a texture/paint variant per ship (only a placeholder "Standard" for now; the
//                  slot is wired so extra hull textures drop straight in when the art is ready).
//   • Laser color — the tint of the pilot's OWN laser tracers in flight.
//   • Engine trail color — the tint of the pilot's exhaust plume.
//   • Missile FX — the color/accent of the pilot's guided-missile motor + glow.
//
// Each cosmetic option carries an `unlock` rule. Locked options are shown greyed with a hint of how
// to earn them, and can't be equipped until unlocked. Unlocks are driven by the SAME career metrics
// the ranking system uses (career kills / MP wins / campaign completions), plus achievements — so
// this module has no storage of its own for progression: it READS leaderboard.js counters and
// achievement state, and only persists the pilot's equipped SELECTIONS per ship.
//
// This keeps gameplay code decoupled: main.js/scene.js just ask cosmetics.js for the active player's
// equipped colors and apply them; the hangar UI asks for the catalog + unlock status.

import * as leaderboard from './leaderboard.js';
import { SHIP_ORDER } from './shipRoster.js';

// ---- Unlock rule helpers ----------------------------------------------------------------------
// A rule is { kind, ...params, label }. `label` is the short "how to earn" hint shown when locked.
// `met(ctx)` evaluates it against the live career/achievement context gathered in unlockContext().
function killsRule(n)      { return { kind: 'kills',      n, label: `${n} career kills` }; }
function winsRule(n)       { return { kind: 'wins',       n, label: `${n} multiplayer ${n === 1 ? 'win' : 'wins'}` }; }
function campaignRule(n)   { return { kind: 'campaign',   n, label: `Complete the campaign${n > 1 ? ` ${n}×` : ''}` }; }
function achRule(id, hint) { return { kind: 'ach', id, label: hint }; }
const FREE = { kind: 'free', label: '' };   // always unlocked

function ruleMet(rule, ctx) {
  switch (rule.kind) {
    case 'free':     return true;
    case 'kills':    return ctx.kills >= rule.n;
    case 'wins':     return ctx.wins >= rule.n;
    case 'campaign': return ctx.campaign >= rule.n;
    case 'ach':      return ctx.unlocked.has(rule.id);
    default:         return false;
  }
}

// Gather the live unlock context once (cheap; reads persisted counters + achievement set).
function unlockContext() {
  const s = leaderboard.careerRankStats();
  return {
    kills: s.careerKills || 0,
    wins: s.careerWins || 0,
    campaign: s.campaignCompletions || 0,
    unlocked: leaderboard.unlockedSet(),
  };
}

// ---- Catalog ----------------------------------------------------------------------------------
// LASER colors. `color` is the tracer hex; `glow` a softer companion used for muzzle/impact where
// relevant. First entry is the free default and matches the classic cyan bolt.
export const LASER_COLORS = [
  { id: 'cyan',    name: 'Standard Cyan',   color: 0x62f8ff, unlock: FREE },
  { id: 'green',   name: 'Viper Green',     color: 0x5dff8a, unlock: killsRule(10) },
  { id: 'gold',    name: 'Solar Gold',      color: 0xffd85a, unlock: killsRule(30) },
  { id: 'violet',  name: 'Void Violet',     color: 0xb06bff, unlock: killsRule(75) },
  { id: 'crimson', name: 'Blood Crimson',   color: 0xff4356, unlock: winsRule(3) },
  { id: 'white',   name: 'Phosphor White',  color: 0xeafcff, unlock: achRule('sharpshooter', 'Unlock “Sharpshooter”') },
  { id: 'mamba',   name: 'Mamba Signature',  color: 0xc88bff, unlock: campaignRule(1) },
];

// ENGINE TRAIL colors. Applied to the pilot's exhaust plume. `palette` describes the four exhaust
// tints scene.js uses (core/glow/hot/beam) so a custom color reads richly, not flat.
export const TRAIL_COLORS = [
  { id: 'blue',    name: 'Standard Blue',  swatch: 0x57e6ff,
    palette: { core: 0x2bdcff, glow: 0x57e6ff, hot: 0xeafdff, beam: 0x57e0ff }, unlock: FREE },
  { id: 'amber',   name: 'Afterburner Amber', swatch: 0xffb14a,
    palette: { core: 0xff9a2a, glow: 0xffb14a, hot: 0xfff0d2, beam: 0xffb14a }, unlock: killsRule(15) },
  { id: 'green',   name: 'Ion Green',      swatch: 0x5dff8a,
    palette: { core: 0x28e070, glow: 0x5dff8a, hot: 0xeafff0, beam: 0x5dff8a }, unlock: killsRule(40) },
  { id: 'violet',  name: 'Plasma Violet',  swatch: 0xb06bff,
    palette: { core: 0x8a3cff, glow: 0xb06bff, hot: 0xf0e6ff, beam: 0xb06bff }, unlock: killsRule(90) },
  { id: 'crimson', name: 'Hostile Crimson', swatch: 0xff4635,
    palette: { core: 0xff2a1e, glow: 0xff4635, hot: 0xffdcd2, beam: 0xff3a2c }, unlock: winsRule(5) },
  { id: 'white',   name: 'Cold Fusion',    swatch: 0xeafcff,
    palette: { core: 0xbfe6ff, glow: 0xeafcff, hot: 0xffffff, beam: 0xeafcff }, unlock: campaignRule(1) },
];

// MISSILE FX — the accent tint of the guided-missile motor glow + body emissive.
export const MISSILE_FX = [
  { id: 'blue',    name: 'Standard Seeker', accent: 0x9fe8ff, unlock: FREE },
  { id: 'amber',   name: 'Fireflight',      accent: 0xffb14a, unlock: killsRule(20) },
  { id: 'green',   name: 'Toxin',           accent: 0x7dff9a, unlock: killsRule(50) },
  { id: 'violet',  name: 'Singularity',     accent: 0xc08bff, unlock: achRule('capital_kill', 'Unlock “Dreadnought Down”') },
  { id: 'crimson', name: 'Warhead',         accent: 0xff5a52, unlock: winsRule(8) },
];

// HULL SKINS — per ship. For now every ship has a single free "Standard" skin (the ship's native
// GLB texture). The slot is fully wired so adding a texture is just another entry with a `map` URL
// and an unlock rule; the hangar shows a placeholder swatch until then.
export const HULL_SKINS = {};
for (const id of SHIP_ORDER) {
  HULL_SKINS[id] = [
    { id: 'standard', name: 'Standard', map: null, unlock: FREE },
    // Placeholder locked slot so the pilot can SEE that more skins are coming (greyed, uncyclable-to).
    { id: 'soon', name: 'More Coming Soon', map: null, placeholder: true, unlock: { kind: 'never', label: 'Additional paint schemes in development' } },
  ];
}

// The four cosmetic categories, in the order the hangar renders their cyclers.
export const CATEGORIES = [
  { key: 'skin',    label: 'Hull Skin' },
  { key: 'laser',   label: 'Laser Color' },
  { key: 'trail',   label: 'Engine Trail' },
  { key: 'missile', label: 'Missile FX' },
];

// Look up the option list for a category (skins are per-ship).
export function optionsFor(categoryKey, shipId) {
  if (categoryKey === 'skin') return HULL_SKINS[shipId] || HULL_SKINS[SHIP_ORDER[0]];
  if (categoryKey === 'laser') return LASER_COLORS;
  if (categoryKey === 'trail') return TRAIL_COLORS;
  if (categoryKey === 'missile') return MISSILE_FX;
  return [];
}

// Is a given option currently unlocked for the pilot? Placeholder / "never" options never unlock.
export function isOptionUnlocked(opt, ctx = unlockContext()) {
  if (!opt || opt.placeholder || (opt.unlock && opt.unlock.kind === 'never')) return false;
  return ruleMet(opt.unlock, ctx);
}

// A display-ready view of a category's options with live unlock status + lock hint, for the hangar.
export function catalogView(categoryKey, shipId) {
  const ctx = unlockContext();
  return optionsFor(categoryKey, shipId).map(opt => ({
    ...opt,
    unlocked: isOptionUnlocked(opt, ctx),
    lockLabel: (opt.unlock && opt.unlock.label) || '',
  }));
}

// ---- Equipped selections (persisted) ----------------------------------------------------------
// Stored per ship so each hull remembers its own loadout. Shape:
//   { <shipId>: { skin, laser, trail, missile } }  (each value an option id)
const LS_KEY = 'mamba.cosmetics';
function loadStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
}
function saveStore(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {} }
let _store = loadStore();

function defaultLoadout() { return { skin: 'standard', laser: 'cyan', trail: 'blue', missile: 'blue' }; }

// The pilot's equipped loadout for a ship, falling back to the free defaults. Any equipped option
// that is no longer valid/unlocked is safely coerced back to the default so gameplay never reads a
// locked cosmetic (e.g. if progression were ever reset).
export function loadoutFor(shipId) {
  const base = defaultLoadout();
  const saved = _store[shipId] || {};
  const ctx = unlockContext();
  const out = { ...base, ...saved };
  for (const cat of CATEGORIES) {
    const opts = optionsFor(cat.key, shipId);
    const chosen = opts.find(o => o.id === out[cat.key]);
    if (!chosen || !isOptionUnlocked(chosen, ctx)) out[cat.key] = base[cat.key];
  }
  return out;
}

// Equip an option in a category for a ship (validated: must exist + be unlocked). Returns true on a
// real change so the caller can play a confirm sound / refresh the preview.
export function equip(shipId, categoryKey, optionId) {
  const opts = optionsFor(categoryKey, shipId);
  const opt = opts.find(o => o.id === optionId);
  if (!opt || !isOptionUnlocked(opt)) return false;
  const cur = _store[shipId] || defaultLoadout();
  if (cur[categoryKey] === optionId) return false;
  _store[shipId] = { ...defaultLoadout(), ...cur, [categoryKey]: optionId };
  saveStore(_store);
  return true;
}

// ---- Resolved cosmetic accessors (what gameplay/scene read) -----------------------------------
// Resolve the equipped option OBJECTS for a ship's current loadout, so callers get the concrete
// color/palette/accent to apply without touching the catalog.
export function resolved(shipId) {
  const lo = loadoutFor(shipId);
  const skin = (HULL_SKINS[shipId] || []).find(o => o.id === lo.skin) || null;
  const laser = LASER_COLORS.find(o => o.id === lo.laser) || LASER_COLORS[0];
  const trail = TRAIL_COLORS.find(o => o.id === lo.trail) || TRAIL_COLORS[0];
  const missile = MISSILE_FX.find(o => o.id === lo.missile) || MISSILE_FX[0];
  return {
    skinMap: skin ? skin.map : null,
    laserColor: laser.color,
    trailPalette: trail.palette,
    missileAccent: missile.accent,
  };
}

// A small helper the count-up hangar UI uses to show "3 / 7 unlocked" per category.
export function unlockedCount(categoryKey, shipId) {
  const ctx = unlockContext();
  const opts = optionsFor(categoryKey, shipId).filter(o => !o.placeholder && !(o.unlock && o.unlock.kind === 'never'));
  const got = opts.filter(o => isOptionUnlocked(o, ctx)).length;
  return { got, total: opts.length };
}
