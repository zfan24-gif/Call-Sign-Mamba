// Opt-in doctrine for authored capital weapons. Unlabelled legacy mounts keep their old rules.
export const CAPITAL_WEAPON_ROLES = Object.freeze({
  pointDefense: Object.freeze({
    range: 460, boltSpeed: 340, boltDamage: 4,
    acquireTime: .32, targetHold: .65, scanInterval: .12, switchRatio: .8,
    turnRate: 2.1, aimTolerance: .025, aimError: .006, reactionTime: .16,
    burstMin: 3, burstMax: 5, burstGap: .11, recoveryMin: 1.3, recoveryMax: 1.9,
    maxLasersPerTarget: 2,
  }),
  heavyAssault: Object.freeze({
    range: 880, boltSpeed: 210, boltDamage: 26,
    acquireTime: 1.25, targetHold: 5, scanInterval: .4, switchRatio: .55,
    turnRate: .55, aimTolerance: .018, aimError: .004, reactionTime: .4,
    burstMin: 2, burstMax: 2, burstGap: .45, recoveryMin: 3.2, recoveryMax: 4.2,
    maxLasersPerTarget: 3,
  }),
  siegeMissile: Object.freeze({
    missileRange: 950, missileDamage: 50, missileReload: 13,
    acquireTime: 1, targetHold: 5, scanInterval: .35,
    lockTime: 4.5, lockCone: .975, missileTurnRate: .65,
    maxLaunchersPerTarget: 2,
  }),
});

export function capitalTargetClass(target) {
  const u = target?.userData || {};
  if (u.isMissile) return 'missile';
  if (['capital', 'flagship'].includes(u.kind) || u.aiRec?.category === 'capital') return 'capital';
  if (u.aiRec?.category === 'transport' && (u.radius || 0) >= 12) return 'largeShip';
  if (u.kind === 'bomber' || u.aiRec?.category === 'bomber') return 'bomber';
  return 'fighter';
}
export function capitalRoleCanTarget(turret, target) {
  const kind = capitalTargetClass(target), role = turret.combatRole;
  if (role === 'pointDefense') return ['missile', 'bomber', 'fighter'].includes(kind);
  if (role === 'heavyAssault') return ['capital', 'largeShip'].includes(kind);
  // Missile interception is an explicit defensive-laser capability, never a legacy-gun side effect.
  return kind !== 'missile';
}
export function capitalRoleTargetLimit(turret, target, profile) {
  const kind = capitalTargetClass(target);
  if (turret.combatRole === 'pointDefense' && kind === 'missile') return 1;
  if (turret.combatRole === 'siegeMissile' && !['capital', 'largeShip'].includes(kind)) return 1;
  return turret.type === 'missile' ? profile.maxLaunchersPerTarget : profile.maxLasersPerTarget;
}
export function capitalRoleScore(turret, target, distance, profile) {
  const kind = capitalTargetClass(target), fraction = Math.min(1, distance / (turret.type === 'missile' ? profile.missileRange : profile.range));
  if (turret.combatRole === 'pointDefense') return (kind === 'missile' ? .2 : kind === 'bomber' ? 2 : 4) + fraction;
  if (turret.combatRole === 'siegeMissile') return (['capital', 'largeShip'].includes(kind) ? 1 : 4) + fraction;
  return distance;
}

// Swept bolt-versus-moving missile collision. Both objects advance during the same frame.
export function movingProjectileContact(boltFrom, boltTo, missileTo, missileVelocity, dt, radius) {
  const start = {
    x: boltFrom.x - missileTo.x + missileVelocity.x * dt,
    y: boltFrom.y - missileTo.y + missileVelocity.y * dt,
    z: boltFrom.z - missileTo.z + missileVelocity.z * dt,
  };
  const end = {x: boltTo.x - missileTo.x, y: boltTo.y - missileTo.y, z: boltTo.z - missileTo.z};
  const d = {x:end.x-start.x, y:end.y-start.y, z:end.z-start.z};
  const c = start.x**2 + start.y**2 + start.z**2 - radius**2;
  if (c <= 0) return 0;
  const a = d.x**2 + d.y**2 + d.z**2;
  if (a < 1e-12) return null;
  const b = start.x*d.x + start.y*d.y + start.z*d.z, disc = b*b-a*c;
  if (disc < 0) return null;
  const time = (-b-Math.sqrt(disc))/a;
  return time >= 0 && time <= 1 ? time : null;
}