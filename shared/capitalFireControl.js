import { CAPITAL_WEAPON_ROLES, capitalRoleCanTarget, capitalRoleTargetLimit, capitalRoleScore } from './capitalWeaponRoles.js';
// Capital weapon decisions. Rendering, authored mounts and impacts stay in main.js.
// Shared by campaign capitals, the depot and authoritative multiplayer.
export const CAPITAL_FIRE_DEFAULTS = Object.freeze({
  range: 340, missileRange: 450, boltSpeed: 160, boltDamage: 8,
  acquireTime: 0.75, targetHold: 2.5, scanInterval: 0.3,
  switchRatio: 0.65, lostSightGrace: 0.8, blockedRetry: 2,
  maxLasersPerTarget: 2, maxLaunchersPerTarget: 1,
  burstMin: 3, burstMax: 5, burstGap: 0.16,
  recoveryMin: 1.8, recoveryMax: 2.8,
  turnRate: 1.05, missileTurnRate: 0.75, aimTolerance: 0.02,
  aimError: 0.008, reactionTime: 0.22,
  lockTime: 4, lockCone: 0.97, missileReload: 8, missileDamage: 34,
});

// Positive constant-velocity intercept within the projectile's remaining reach.
// No solution means aim at the current position, never a point behind the target.
export function interceptPoint(from, position, velocity, speed, maxTime, out) {
  const x = position.x - from.x, y = position.y - from.y, z = position.z - from.z;
  const a = velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2 - speed ** 2;
  const b = 2 * (x * velocity.x + y * velocity.y + z * velocity.z);
  const c = x * x + y * y + z * z;
  let time = Infinity;
  if (Math.abs(a) < 1e-7) {
    if (Math.abs(b) > 1e-7 && -c / b >= 0) time = -c / b;
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const root = Math.sqrt(d);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t >= 0 && t < time) time = t;
      }
    }
  }
  if (!Number.isFinite(time) || time > maxTime) time = 0;
  out.x = position.x + velocity.x * time;
  out.y = position.y + velocity.y * time;
  out.z = position.z + velocity.z * time;
  return out;
}

// Entry time on a swept segment, not the distance at its final endpoint.
export function segmentSphereTime(from, to, center, radius) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const x = from.x - center.x, y = from.y - center.y, z = from.z - center.z;
  const c = x * x + y * y + z * z - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return null;
  const b = x * dx + y * dy + z * dz;
  const d = b * b - a * c;
  if (d < 0) return null;
  const t = (-b - Math.sqrt(d)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

function seedRandom(seed) {
  let n = seed >>> 0;
  return () => {
    n += 0x6D2B79F5;
    let t = Math.imul(n ^ (n >>> 15), 1 | n);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (lo, hi, random) => lo + (hi - lo) * random();
function newError(s, random) {
  // A bounded offset in the aim point, held through a burst. Bolts still leave
  // along the actual barrel; there is no post-muzzle bending or hit-chance roll.
  const z = random() * 2 - 1, angle = random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z)) * Math.sqrt(random());
  s.error = { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z: z * Math.sqrt(random()) };
}
function assign(s, target, p, random) {
  s.target = target; s.acquire = p.acquireTime; s.held = 0;
  s.burstLeft = 0; s.shotIn = 0; s.lock = 0; s.warned = false; s.earlyWarned = false;
  s.sightIn = 0; s.clear = false; s.obscured = 0;
  s.velocity = { x: 0, y: 0, z: 0 };
  s.phase = target ? 'acquiring' : 'idle';
  newError(s, random);
}

export function updateCapitalFireControl(capital, dt, hooks) {
  if (!(dt > 0) || !capital.userData.capitalCombat) return;
  const ud = capital.userData;
  const base = ud._capitalFireProfile || (ud._capitalFireProfile = {
    ...CAPITAL_FIRE_DEFAULTS, ...ud.capitalCombat,
  });
  const random = hooks.random || (ud._capitalFireRandom ||= seedRandom(base.seed ?? 4242));
  const guns = (ud.turrets || []).filter(t => t.muzzles?.length);
  const candidates = hooks.targets(capital);
  const stats = ud.capitalFireStats ||= { laserShots: 0, missileShots: 0, blockedShots: 0 };
  for (let i = 0; i < guns.length; i++) {
    const t = guns[i];
    const p = t._roleFireProfile ||= { ...base, ...(CAPITAL_WEAPON_ROLES[t.combatRole] || {}), ...(t.weaponProfile || {}) };
    const s = t.fireControl ||= {
      target: null, phase: 'idle', acquire: 0, held: 0, scanIn: i * 0.037,
      cooldown: i * 0.17, shotIn: 0, burstLeft: 0, lock: 0, warned: false,
      sightIn: 0, clear: false, obscured: 0, blockedTarget: null, retryIn: 0,
      velocity: { x: 0, y: 0, z: 0 }, error: { x: 0, y: 0, z: 0 },
    };
    s.cooldown = Math.max(0, s.cooldown - dt);
    s.scanIn -= dt; s.shotIn -= dt; s.sightIn -= dt;
    s.retryIn = Math.max(0, s.retryIn - dt);
    if (!t.alive || (s.target && (!candidates.includes(s.target) ||
        !capitalRoleCanTarget(t, s.target) || !hooks.canTarget(t, s.target, t.type === 'missile' ? p.missileRange : p.range)))) {
      if (s.target) s.cooldown = Math.max(s.cooldown, p.recoveryMin);
      assign(s, null, p, random);
    }
  }
  // Keep reservations stable: the player and every ally obey the same per-target budget.
  const load = (target, missile, except) => guns.reduce((n, gun) => n +
    (gun !== except && gun.alive && (gun.type === 'missile') === missile &&
      gun.fireControl.target === target ? 1 : 0), 0);
  for (const t of guns) {
    const s = t.fireControl, missile = t.type === 'missile', p = t._roleFireProfile;
    if (!t.alive) continue;
    const range = missile ? p.missileRange : p.range;
    if (s.scanIn <= 0 && (!s.target || (!missile && !s.burstLeft && s.held >= p.targetHold))) {
      s.scanIn = p.scanInterval;
      let best = s.target, score = best ? capitalRoleScore(t, best, hooks.distance(t, best), p) : Infinity;
      const switchBelow = score * p.switchRatio;
      for (const target of candidates) {
        if (target === s.target || (target === s.blockedTarget && s.retryIn > 0)) continue;
        if (!capitalRoleCanTarget(t, target) || load(target, missile, t) >= capitalRoleTargetLimit(t, target, p) || !hooks.canTarget(t, target, range)) continue;
        const d = capitalRoleScore(t, target, hooks.distance(t, target), p);
        if (d < score && (!s.target || d < switchBelow)) { best = target; score = d; }
      }
      if (best !== s.target) assign(s, best, p, random);
    }
    if (!s.target) { t.lockTarget = null; t.lockT = 0; hooks.idle?.(t, dt); continue; }
    s.held += dt;
    s.acquire = Math.max(0, s.acquire - dt);
    const aligned = hooks.aim(t, s.target, dt, s, p);
    // Expensive hull visibility queries run at 5 Hz while tracking, then freshly
    // again before every shot. A blocked barrel relinquishes its target reservation.
    if (aligned && s.sightIn <= 0) {
      s.sightIn = 0.2;
      s.clear = hooks.clearShot(capital, t, s.target, p);
    }
    s.obscured = aligned && !s.clear ? s.obscured + dt : 0;
    if (s.obscured >= p.lostSightGrace) {
      s.blockedTarget = s.target; s.retryIn = p.blockedRetry;
      s.cooldown = Math.max(s.cooldown, p.recoveryMin);
      assign(s, null, p, random);
      continue;
    }
    const ready = s.acquire <= 0 && aligned && s.clear;
    if (missile) {
      s.lock = ready ? Math.min(p.lockTime, s.lock + dt) : Math.max(0, s.lock - dt * 1.6);
      t.lockTarget = s.target; t.lockT = s.lock;
      s.phase = s.acquire > 0 ? 'acquiring' : s.lock < p.lockTime ? 'locking' : 'locked';
      // Give the pilot time to break sight before launch, without warning again
      // immediately after a shot while the launcher is still reloading.
      if (s.lock < p.lockTime * 0.1) s.earlyWarned = false;
      if (ready && s.lock >= p.lockTime * 0.25 && s.cooldown <= p.lockTime * 0.75 && !s.earlyWarned) {
        s.earlyWarned = true; hooks.lockWarning?.(t, s.target);
      }
      if (s.lock < p.lockTime * 0.5) s.warned = false;
      if (s.lock >= p.lockTime && !s.warned) { s.warned = true; hooks.locked?.(t, s.target); }
      if (ready && s.lock >= p.lockTime && s.cooldown <= 0) {
        if (hooks.clearShot(capital, t, s.target, p)) {
          if (hooks.fire(capital, t, s.target, p) === false) continue;
          stats.missileShots++;
          s.cooldown = p.missileReload; s.lock = 0; t.lockT = 0; s.warned = false; s.earlyWarned = false;
        } else { s.clear = false; s.sightIn = 0.2; stats.blockedShots++; }
      }
      continue;
    }
    if (!ready) {
      s.phase = s.acquire > 0 ? 'acquiring' : 'tracking';
      s.shotIn = Math.max(0, s.shotIn);
      if (s.burstLeft) {
        s.burstLeft = 0; s.cooldown = between(p.recoveryMin, p.recoveryMax, random);
      }
      continue;
    }
    if (!s.burstLeft && s.cooldown <= 0) {
      s.burstLeft = p.burstMin + Math.floor(random() * (p.burstMax - p.burstMin + 1));
      s.shotIn = 0;
    }
    s.phase = s.burstLeft ? 'firing' : 'recovering';
    if (s.burstLeft && s.shotIn <= 0) {
      if (!hooks.clearShot(capital, t, s.target, p)) {
        s.clear = false; s.sightIn = 0.2; s.burstLeft = 0;
        s.cooldown = p.recoveryMin; stats.blockedShots++; continue;
      }
      if (hooks.fire(capital, t, s.target, p) === false) { s.shotIn = p.burstGap; continue; }
      stats.laserShots++;
      if (t.combatRole) (stats.byRole ||= {})[t.combatRole] = (stats.byRole[t.combatRole] || 0) + 1;
      s.shotIn += p.burstGap; s.burstLeft--;
      if (!s.burstLeft) {
        s.cooldown = between(p.recoveryMin, p.recoveryMax, random);
        newError(s, random);
      }
    }
  }
  ud.aimTarget = guns.find(t => t.alive && t.fireControl.target === hooks.player)?.fireControl.target ||
    guns.find(t => t.alive && t.fireControl.target)?.fireControl.target || null;
}