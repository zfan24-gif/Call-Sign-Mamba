// ---- CapitalAssault: the authoritative Capital Ship Assault (CSA) controller --------------------
// CSA is the "each faction attacks the enemy's capital ship" mode. Every team defends a capital that
// bristles with destructible HULL-MOUNTED EMPLACEMENTS:
//   • CANNONS — heavy point-defense guns that auto-fire bright faction-colored laser BURSTS at the
//     nearest ENEMY ship within range, but only when they have a CLEAN, OPEN shot (a cannon can't
//     fire through its own hull, so it holds fire when the target is blocked by the capital body).
//     Cannons are targetable + tanky: destroying them meaningfully softens the assault.
//   • SHIELD GENERATORS — while ANY of a capital's generators live, that capital's HULL shrugs off
//     most incoming damage (deflection), exactly like the single-player Dreadnought. Kill them all
//     and the hull goes soft and can be blown apart.
// A team WINS by depleting the enemy capital's HULL to zero (only possible once its shield gens are
// down). The controller owns all of this authoritatively; clients only render the replicated
// Emplacement schema + capital-hull integrity and react to the broadcast fire/destruction events.
//
// GEOMETRY CONTRACT WITH THE CLIENT: emplacement mount points are stored in each capital group's
// LOCAL frame and REPLICATED. The client seats the cannon/generator models at exactly those local
// points and rotates them into world by the capital's KNOWN pose (base center, facing the arena
// origin), so server hit-tests and client renders line up without the client raycasting the GLB.

import { Emplacement, Bolt } from './schema.js';
import { updateCapitalFireControl, interceptPoint, segmentSphereTime } from '../shared/capitalFireControl.js';

// --- Capital geometry (must mirror the client's CTC_BASE_CENTER + capital lengths) ---------------
// The two capitals sit at the spread team-base centers (room.baseCenter) and face the arena origin.
// Their NOMINAL lengths match scene.js: blue flagship ~140u, red capital ~260u. Mounts below are
// fractions of these so cannons/gens spread realistically along each different-sized hull.
// CSA: blue fields the FSA Paladin (sized like the IC Dreadnought), so both hulls are 260u and carry
// the IDENTICAL emplacement layout below (2 shield gens + the same cannon set) — a mirror match.
const CAP_LEN = { 0: 260, 1: 260 };   // 0 = FSA Paladin, 1 = IC Dreadnought (client scene.js lengths)

// Firing cadence, lead, traverse, range and damage come from shared/capitalFireControl.js.
// These constants retain authored mount health/geometry and initial spawn staggering.
const CANNON_BURST_COOLDOWN_MIN = 1.8;
const CANNON_BURST_COOLDOWN_MAX = 3.4;
const CANNON_ARC_DOT = -0.1;       // generous (~95deg off-normal) — the LOS test does the real gating
const CANNON_HP = 520;             // tanky: takes a fair amount of fire to destroy (spec)
const SHIELDGEN_HP = 900;          // shield generators are tough too — clearing them is the objective
// --- Authored missile launchers (from the hull GLB's MT_n / MISSILE_NN turrets) -------------------
const LAUNCHER_HP = 600;

// Validate + normalize a client-submitted hardpoint manifest. Rejects anything malformed or
// implausible (wrong sizes, non-finite numbers, parts far outside a 260u hull) so a tampered client
// can't plant guns in open space or bloat the room.
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const vec3 = (v, lim) => Array.isArray(v) && v.length === 3 && v.every(n => finite(n) && Math.abs(n) <= lim) ? v.map(Number) : null;
function sanitizeManifest(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.turrets) || !Array.isArray(m.shieldgens)) return null;
  if (m.turrets.length > 24 || m.shieldgens.length > 8 || m.shieldgens.length < 1) return null;
  const HULL = 220;   // generous half-extent for a 260u-class capital
  const id = (s) => typeof s === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(s) ? s : null;
  const turrets = [];
  for (const t of m.turrets) {
    if (!t || !t.tf) return null;
    const out = {
      id: id(t.id), kind: t.kind === 'missile' ? 'missile' : 'laser',
      pivot: vec3(t.pivot, HULL), aim: vec3(t.aim, HULL),
      tf: { fwd: vec3(t.tf.fwd, 1.01), side: vec3(t.tf.side, 1.01), up: vec3(t.tf.up, 1.01) },
      pitchMin: finite(t.pitchMin) ? clamp(t.pitchMin, -Math.PI / 2, Math.PI / 2) : -0.2618,
      pitchMax: finite(t.pitchMax) ? clamp(t.pitchMax, -Math.PI / 2, Math.PI / 2) : Math.PI / 2,
      arc: Array.isArray(t.arc) && t.arc.length === 72 && t.arc.every(finite) ? t.arc.map(Number) : null,
      muzzles: Array.isArray(t.muzzles) ? t.muzzles.slice(0, 8).map(v => vec3(v, 40)).filter(Boolean) : [],
      radius: finite(t.radius) ? clamp(t.radius, 1, 20) : 4,
    };
    if (!out.id || !out.pivot || !out.aim || !out.tf.fwd || !out.tf.side || !out.tf.up) return null;
    turrets.push(out);
  }
  const shieldgens = [];
  for (const s of m.shieldgens) {
    const out = { id: id(s && s.id), pos: vec3(s && s.pos, HULL), radius: s && finite(s.radius) ? clamp(s.radius, 2, 30) : 8 };
    if (!out.id || !out.pos) return null;
    shieldgens.push(out);
  }
  return { turrets, shieldgens };
}

// --- Shield deflection (mirrors single-player capitalDamageMult) ---------------------------------
// While generators live, the hull barely takes damage; both down = full damage.
function hullDamageMult(liveGens) {
  if (liveGens > 0) return 0;
  return 1;
}

// --- Small vec helpers (no THREE on the server) --------------------------------------------------
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function len(v) { return Math.hypot(v.x, v.y, v.z); }
function norm(v) { const l = len(v) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Closest-approach distance from point C to the segment P0->P1 (for LOS-through-hull + bolt tests).
function segPointDist2(x0, y0, z0, x1, y1, z1, cx, cy, cz) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const fx = x0 - cx, fy = y0 - cy, fz = z0 - cz;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 1e-9 ? -(fx * dx + fy * dy + fz * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  const px = x0 + dx * t - cx, py = y0 + dy * t - cy, pz = z0 + dz * t - cz;
  return px * px + py * py + pz * pz;
}

// Project the segment into the capital's local, unit-sized hull. The larger
// spherical docking envelope would cover the exposed dorsal and ventral mounts.
function hullEntry(pose, from, to) {
  const normalize = point => {
    const offset = sub(point, pose.center);
    return {
      x: dot(offset, pose.right) / (pose.len * 0.16),
      y: dot(offset, pose.up) / (pose.len * 0.05),
      z: dot(offset, pose.zAxis) / (pose.len * 0.48),
    };
  };
  return segmentSphereTime(normalize(from), normalize(to), { x: 0, y: 0, z: 0 }, 1);
}

export class CapitalAssault {
  constructor(room) {
    this.room = room;
    this.active = false;
    // Per-capital pose + per-emplacement server scratch, keyed the same as state.emplacements.
    this._caps = { 0: null, 1: null };   // { center, quat, len } per team
    this._emp = new Map();               // key -> { kind, capTeam, worldPos, normalWorld, ...cannonScratch }
    this._boltSeq = 0;
    this._fireGroups = {}; this._fireTargets = new Map();
  }

  // Build both capitals' emplacements + reset hull integrity. Called from room.startMatch() for CSA.
  setup() {
    this.clear();
    this.active = true;
    this.room.state.blueCapHull = 100;
    this.room.state.redCapHull = 100;
    for (const team of [0, 1]) this._buildCapital(team);
  }

  // Tear everything down (leaving CSA, match end). Removes replicated emplacements + local scratch.
  clear() {
    this.active = false;
    for (const key of [...this.room.state.emplacements.keys()]) this.room.state.emplacements.delete(key);
    this._emp.clear();
    this._fireGroups = {}; this._fireTargets.clear();
    this._caps = { 0: null, 1: null };
  }

  // Compute a team capital's world pose once at setup: it sits at baseCenter(team) and faces the
  // arena origin (matching the client's `base.lookAt(0,0,0)`), so its local -Z points at origin.
  // We store the basis vectors (right/up/forward) so we can transform local mount points to world.
  _capitalPose(team) {
    const c = this.room.baseCenter(team);
    const center = { x: c.x, y: c.y, z: c.z };
    // Forward = local -Z after lookAt(origin): the direction from the capital TOWARD the origin.
    const fwd = norm({ x: -center.x, y: -center.y, z: -center.z });
    // Build an orthonormal basis. World up is +Y; right = up × forward (matches THREE lookAt basis).
    let up = { x: 0, y: 1, z: 0 };
    // right = normalize(cross(up, -forward)) — THREE's lookAt makes -Z = forward, +X = right.
    const zAxis = { x: -fwd.x, y: -fwd.y, z: -fwd.z };   // local +Z (points AWAY from origin)
    let right = norm({
      x: up.y * zAxis.z - up.z * zAxis.y,
      y: up.z * zAxis.x - up.x * zAxis.z,
      z: up.x * zAxis.y - up.y * zAxis.x,
    });
    // Recompute a true up = zAxis × right so the basis is orthonormal.
    up = {
      x: zAxis.y * right.z - zAxis.z * right.y,
      y: zAxis.z * right.x - zAxis.x * right.z,
      z: zAxis.x * right.y - zAxis.y * right.x,
    };
    return { center, right, up, zAxis, len: CAP_LEN[team] || 200 };
  }

  // Transform a LOCAL-frame point (fractions already multiplied by length) into world space using a
  // capital pose basis. local = { x:right, y:up, z:zAxis }.
  _localToWorld(pose, lx, ly, lz) {
    return {
      x: pose.center.x + pose.right.x * lx + pose.up.x * ly + pose.zAxis.x * lz,
      y: pose.center.y + pose.right.y * lx + pose.up.y * ly + pose.zAxis.y * lz,
      z: pose.center.z + pose.right.z * lx + pose.up.z * ly + pose.zAxis.z * lz,
    };
  }
  // Transform a LOCAL-frame DIRECTION into world (no translation).
  _localDirToWorld(pose, lx, ly, lz) {
    return norm({
      x: pose.right.x * lx + pose.up.x * ly + pose.zAxis.x * lz,
      y: pose.right.y * lx + pose.up.y * ly + pose.zAxis.y * lz,
      z: pose.right.z * lx + pose.up.z * ly + pose.zAxis.z * lz,
    });
  }

  // The emplacement LAYOUT for a capital, as [kind, localFractionXYZ, outwardNormalXYZ]. Fractions
  // are of the hull length L. Mirrors the single-player conventions: dorsal shield gens fore+aft;
  // cannons spread across the dorsal spine, flanks, and belly so the whole hull is defended. Nose
  // is local -Z (faces the arena), so +Z is aft.
  _layout() {
    return [
      // Two dorsal SHIELD GENERATORS (fore + aft on the spine) — same as SP.
      ['shieldgen', [0.00, 0.06,  0.12], [0, 1, 0]],
      ['shieldgen', [0.00, 0.06, -0.18], [0, 1, 0]],
      // CANNONS bristling along the hull. Dorsal pair fore, flank pair mid, belly pair, and an aft
      // dorsal gun — seven total so the capital always has several with a clean shot on any bearing.
      ['cannon', [-0.10, 0.05,  0.22], [-0.35, 0.9,  0.0]],   // dorsal, fore-left
      ['cannon', [ 0.10, 0.05,  0.22], [ 0.35, 0.9,  0.0]],   // dorsal, fore-right
      ['cannon', [-0.16, 0.00,  0.02], [-1.0,  0.2,  0.0]],   // left flank, mid
      ['cannon', [ 0.16, 0.00,  0.02], [ 1.0,  0.2,  0.0]],   // right flank, mid
      ['cannon', [-0.09,-0.05, -0.10], [-0.3, -0.9,  0.0]],   // belly, left
      ['cannon', [ 0.09,-0.05, -0.10], [ 0.3, -0.9,  0.0]],   // belly, right
      ['cannon', [ 0.00, 0.06, -0.24], [ 0.0,  0.8,  0.35]],  // aft dorsal
    ];
  }

  // ---- Authored hardpoints (from the hull GLB, via a client-submitted manifest) ----------------
  // The server can't load GLBs, so a client sends the manifest its loaded capital produced
  // (hardpoints.js, already converted to THIS capital frame). We validate it hard, cache it for the
  // room's lifetime (the hulls never change), and rebuild that team's emplacements from it as long
  // as none of them has been damaged yet. Afterwards every turret / launcher / shield gen is the
  // real part on the model — the generic fraction layout below is only the pre-manifest fallback.
  acceptManifest(team, manifest) {
    if (team !== 0 && team !== 1) return false;
    if (this._manifests && this._manifests[team]) return false;     // first good one wins
    const clean = sanitizeManifest(manifest);
    if (!clean) return false;
    this._manifests = this._manifests || { 0: null, 1: null };
    this._manifests[team] = clean;
    if (this.active && !this._teamTouched(team)) this._rebuildTeam(team);
    return true;
  }
  _teamTouched(team) {
    for (const s of this._emp.values()) if (s.capTeam === team && s.e.hp < s.e.maxHp) return true;
    return false;
  }
  _rebuildTeam(team) {
    for (const key of [...this._emp.keys()]) {
      const s = this._emp.get(key);
      if (s.capTeam !== team) continue;
      this._emp.delete(key);
      this.room.state.emplacements.delete(key);
    }
    this._buildCapital(team);
  }
  _buildAuthored(team, pose, man) {
    let idx = 0;
    const add = (kind, part, local, normal, hp, extra) => {
      const key = team + ':' + (idx++);
      const e = new Emplacement();
      e.capTeam = team; e.kind = kind; e.part = part;
      e.lx = local[0]; e.ly = local[1]; e.lz = local[2];
      const n = norm({ x: normal[0], y: normal[1], z: normal[2] });
      e.nx = n.x; e.ny = n.y; e.nz = n.z;
      e.hp = hp; e.maxHp = hp; e.alive = true; e.firing = false;
      const worldPos = this._localToWorld(pose, local[0], local[1], local[2]);
      e.aimX = worldPos.x; e.aimY = worldPos.y; e.aimZ = worldPos.z;
      this.room.state.emplacements.set(key, e);
      this._emp.set(key, Object.assign({
        key, kind, capTeam: team, e, worldPos,
        normalWorld: this._localDirToWorld(pose, n.x, n.y, n.z),
        cooldown: CANNON_BURST_COOLDOWN_MIN + Math.random() * (CANNON_BURST_COOLDOWN_MAX - CANNON_BURST_COOLDOWN_MIN),
        burstLeft: 0, shotTimer: 0, targetId: '',
        aim: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
      }, extra || {}));
    };
    for (const t of man.turrets) {
      const tf = {
        fwd: this._localDirToWorld(pose, ...t.tf.fwd),
        side: this._localDirToWorld(pose, ...t.tf.side),
        up: this._localDirToWorld(pose, ...t.tf.up),
      };
      const pivot = this._localToWorld(pose, ...t.pivot);
      const m = t.muzzles[0] || [0, 0, 0];
      const muzzle = {
        x: pivot.x + tf.side.x * m[0] + tf.up.x * m[1] + tf.fwd.x * m[2],
        y: pivot.y + tf.side.y * m[0] + tf.up.y * m[1] + tf.fwd.y * m[2],
        z: pivot.z + tf.side.z * m[0] + tf.up.z * m[1] + tf.fwd.z * m[2],
      };
      const launcher = t.kind === 'missile';
      add(launcher ? 'launcher' : 'cannon', t.id, t.aim, t.tf.up, launcher ? LAUNCHER_HP : CANNON_HP, {
        authored: true, pivot, tf, muzzle, muzzleOffsets: t.muzzles, arc: t.arc, pitchMin: t.pitchMin, pitchMax: t.pitchMax,
        hitR: clamp(t.radius * 1.3, 6, 14), reload: Math.random() * 3,
      });
    }
    for (const gdef of man.shieldgens) {
      add('shieldgen', gdef.id, gdef.pos, [0, gdef.pos[1] < 0 ? -1 : 1, 0], SHIELDGEN_HP, {
        authored: true, hitR: clamp(gdef.radius * 1.2, 9, 22),
      });
    }
  }
  // Authored fire gate: the target must sit inside the turret's traverse limits AND above the
  // GLB's self-hit-safe minimum pitch for that yaw (the same 72-entry arc the SP Dreadnought uses).
  _authoredCanHit(s, to) {
    const v = sub(to, s.pivot);
    const f = dot(v, s.tf.fwd), sd = dot(v, s.tf.side), u = dot(v, s.tf.up);
    const elev = Math.atan2(u, Math.hypot(f, sd));
    if (elev < s.pitchMin || elev > s.pitchMax) return false;
    if (s.arc) {
      const yawDeg = Math.atan2(sd, f) * 180 / Math.PI;
      const i = ((Math.round(yawDeg / 5) % 72) + 72) % 72;
      if (elev * 180 / Math.PI < s.arc[i]) return false;
    }
    return true;
  }

  _buildCapital(team) {
    const pose = this._capitalPose(team);
    this._caps[team] = pose;
    const man = this._manifests && this._manifests[team];
    if (man) { this._buildAuthored(team, pose, man); return; }
    const L = pose.len;
    const layout = this._layout();
    layout.forEach((row, idx) => {
      const [kind, frac, nrm] = row;
      const lx = frac[0] * L, ly = frac[1] * L, lz = frac[2] * L;
      const key = team + ':' + idx;
      // Replicated schema entry (LOCAL mount + normal so the client seats + orients identically).
      const e = new Emplacement();
      e.capTeam = team;
      e.kind = kind;
      e.lx = lx; e.ly = ly; e.lz = lz;
      const n = norm({ x: nrm[0], y: nrm[1], z: nrm[2] });
      e.nx = n.x; e.ny = n.y; e.nz = n.z;
      e.hp = kind === 'cannon' ? CANNON_HP : SHIELDGEN_HP;
      e.maxHp = e.hp;
      e.alive = true;
      e.firing = false;
      this.room.state.emplacements.set(key, e);
      // Server scratch: precomputed WORLD mount position + outward normal (capitals never move), plus
      // per-cannon burst/aim state.
      const worldPos = this._localToWorld(pose, lx, ly, lz);
      const normalWorld = this._localDirToWorld(pose, n.x, n.y, n.z);
      this._emp.set(key, {
        key, kind, capTeam: team, e,
        worldPos, normalWorld,
        // Cannon-only scratch:
        cooldown: kind === 'cannon' ? (CANNON_BURST_COOLDOWN_MIN + Math.random() * (CANNON_BURST_COOLDOWN_MAX - CANNON_BURST_COOLDOWN_MIN)) : 0,
        burstLeft: 0, shotTimer: 0, targetId: '',
        aim: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
      });
    });
  }

  // How many shield generators on `team`'s capital are still alive (drives hull deflection).
  liveGens(team) {
    let n = 0;
    for (const s of this._emp.values()) {
      if (s.capTeam === team && s.kind === 'shieldgen' && s.e.alive) n++;
    }
    return n;
  }

  // --- Bot AI support: what should an attacker on `attackerTeam` shoot on the ENEMY capital? --------
  // Returns the world position of the highest-priority LIVE target on the enemy capital, or null if
  // the capital is already dead. While ANY shield generator lives the hull is near-invulnerable, so
  // the priority is: nearest live SHIELD GENERATOR first; once they're all down, the hull CENTER
  // (baseCenter) becomes the target so bots pour fire into the exposed hull to win. `alsoKind` tells
  // the caller whether it's aiming at a 'shieldgen', 'hull', or nothing.
  botCapitalTarget(attackerTeam, from) {
    const capTeam = attackerTeam === 0 ? 1 : 0;   // attack the OTHER faction's capital
    const hull = capTeam === 0 ? this.room.state.blueCapHull : this.room.state.redCapHull;
    if (hull <= 0) return null;                    // capital already destroyed
    // Shields up while any generator lives -> attack the nearest live generator.
    let best = null, bestD = Infinity;
    for (const s of this._emp.values()) {
      if (s.capTeam !== capTeam || s.kind !== 'shieldgen' || !s.e.alive) continue;
      const p = s.worldPos;
      const dx = p.x - from.x, dy = p.y - from.y, dz = p.z - from.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y, z: p.z, kind: 'shieldgen', key: s.key }; }
    }
    if (best) return best;
    // All generators down -> the hull itself is now the objective. Aim at the capital's center.
    const c = this.room.baseCenter(capTeam);
    return { x: c.x, y: c.y, z: c.z, kind: 'hull', key: '' };
  }

  // The enemy capital's center for `attackerTeam` (used as a rally/standoff anchor by bots).
  enemyCapitalCenter(attackerTeam) {
    return this.room.baseCenter(attackerTeam === 0 ? 1 : 0);
  }

  // Per-tick: run every cannon's aim + burst-fire logic. Called from room.tick() while CSA is live.
  update(dt) {
    if (!this.active || !(dt > 0)) return;
    const candidates = [];
    for (const [sid, ship] of this.room.state.ships) {
      if (!ship.alive) { this._fireTargets.delete(sid); continue; }
      let target = this._fireTargets.get(sid);
      if (!target) { target = { sid, ship, position: {}, velocity: {} }; this._fireTargets.set(sid, target); }
      target.ship = ship;
      Object.assign(target.position, { x: ship.px, y: ship.py, z: ship.pz });
      Object.assign(target.velocity, { x: ship.vx || 0, y: ship.vy || 0, z: ship.vz || 0 });
      candidates.push(target);
    }
    for (const sid of this._fireTargets.keys()) if (!this.room.state.ships.has(sid)) this._fireTargets.delete(sid);
    for (const team of [0, 1]) {
      const capital = this._fireGroups[team] ||= { userData: { capitalCombat: { seed: 8100 + team }, turrets: [] } };
      capital.userData.turrets = [...this._emp.values()].filter(s => s.capTeam === team && s.kind !== 'shieldgen');
      for (const mount of capital.userData.turrets) {
        mount.alive = mount.e.alive; mount.e.firing = false;
        mount.type = mount.kind === 'launcher' ? 'missile' : 'laser';
        mount.muzzles = mount.muzzleOffsets?.length ? mount.muzzleOffsets : [[0, 0, 2]];
        mount.nextMuzzle ||= 0;
        mount.direction ||= { ...(mount.tf?.fwd || mount.normalWorld) };
      }
      updateCapitalFireControl(capital, dt, {
        targets: () => candidates.filter(t => t.ship.team !== team),
        distance: (mount, target) => len(sub(target.position, mount.worldPos)),
        canTarget: (mount, target, range) => len(sub(target.position, mount.worldPos)) <= range &&
          (mount.authored ? this._authoredCanHit(mount, target.position) : dot(norm(sub(target.position, mount.worldPos)), mount.normalWorld) >= CANNON_ARC_DOT),
        aim: (mount, target, step, control, profile) => this._aimWeapon(mount, target, step, control, profile),
        clearShot: (_cap, mount, target, profile) => this._weaponClear(mount, target, profile),
        lockWarning: (mount, target) => this.room.broadcast('aiLock', { target: target.sid, source: 'capital', key: mount.key }),
        fire: (_cap, mount, target, profile) => {
          const from = this._weaponMuzzle(mount), direction = mount.direction;
          let fired;
          if (mount.type === 'missile') fired = this.room.spawnCapitalMissile(team, from, direction, target.sid,
            len(sub(target.position, from)), profile.missileDamage);
          else fired = this._fireCannonShot(mount, target, profile);
          if (!fired) return false;
          mount.nextMuzzle++; mount.e.firing = true;
          this.room.broadcast('capCannonFire', { team, x: from.x, y: from.y, z: from.z, key: mount.key, launcher: mount.type === 'missile' });
          return true;
        },
      });
    }
  }

  _weaponMuzzle(s) {
    if (!s.authored) return { x: s.worldPos.x + s.direction.x * 2, y: s.worldPos.y + s.direction.y * 2, z: s.worldPos.z + s.direction.z * 2 };
    const d = s.direction, tf = s.tf;
    const yaw = Math.atan2(dot(d, tf.side), dot(d, tf.fwd));
    const elevation = Math.asin(clamp(dot(d, tf.up), -1, 1));
    const m = s.muzzles[s.nextMuzzle % s.muzzles.length];
    const out = {};
    for (const k of ['x', 'y', 'z']) {
      const right = tf.side[k] * Math.cos(yaw) - tf.fwd[k] * Math.sin(yaw);
      const horizontal = tf.side[k] * Math.sin(yaw) + tf.fwd[k] * Math.cos(yaw);
      const up = tf.up[k] * Math.cos(elevation) - horizontal * Math.sin(elevation);
      out[k] = s.pivot[k] + right * m[0] + up * m[1] + d[k] * m[2];
    }
    return out;
  }

  _aimWeapon(s, target, dt, control, p) {
    const from = this._weaponMuzzle(s), want = {};
    const blend = 1 - Math.exp(-dt / p.reactionTime);
    for (const k of ['x', 'y', 'z']) control.velocity[k] += (target.velocity[k] - control.velocity[k]) * blend;
    if (s.type === 'missile') Object.assign(want, target.position);
    else {
      interceptPoint(from, target.position, control.velocity, p.boltSpeed, p.range / p.boltSpeed, want);
      const error = len(sub(target.position, from)) * p.aimError;
      for (const k of ['x', 'y', 'z']) want[k] += control.error[k] * error;
    }
    const desired = norm(sub(want, from)), current = s.direction;
    const angle = Math.acos(clamp(dot(current, desired), -1, 1));
    const maxStep = (s.type === 'missile' ? p.missileTurnRate : p.turnRate) * dt;
    if (angle <= maxStep) s.direction = desired;
    else {
      // A bounded angular step, including a stable axis for the antiparallel case.
      let tangent = sub(desired, { x: current.x * Math.cos(angle), y: current.y * Math.cos(angle), z: current.z * Math.cos(angle) });
      if (len(tangent) < 1e-7) tangent = Math.abs(current.y) < 0.9 ? { x: -current.z, y: 0, z: current.x } : { x: 1, y: 0, z: 0 };
      tangent = norm(tangent);
      s.direction = norm({ x: current.x * Math.cos(maxStep) + tangent.x * Math.sin(maxStep),
        y: current.y * Math.cos(maxStep) + tangent.y * Math.sin(maxStep), z: current.z * Math.cos(maxStep) + tangent.z * Math.sin(maxStep) });
    }
    const distance = Math.max(20, len(sub(want, s.worldPos)));
    s.e.aimX = s.worldPos.x + s.direction.x * distance;
    s.e.aimY = s.worldPos.y + s.direction.y * distance;
    s.e.aimZ = s.worldPos.z + s.direction.z * distance;
    const arcOK = s.authored ? this._authoredCanHit(s, { x: s.pivot.x + s.direction.x * distance,
      y: s.pivot.y + s.direction.y * distance, z: s.pivot.z + s.direction.z * distance }) : dot(s.direction, s.normalWorld) >= CANNON_ARC_DOT;
    return arcOK && dot(s.direction, desired) >= (s.type === 'missile' ? p.lockCone : Math.cos(p.aimTolerance));
  }

  _weaponClear(s, target, p) {
    const from = this._weaponMuzzle(s), d = Math.min(p.range, len(sub(target.position, from)));
    const end = s.type === 'missile' ? target.position : { x: from.x + s.direction.x * d, y: from.y + s.direction.y * d, z: from.z + s.direction.z * d };
    if (!this._clearShot(from, end, s.capTeam, !!s.authored)) return false;
    for (const [sid, ship] of this.room.state.ships) {
      if (!ship.alive || ship.team !== s.capTeam) continue;
      if (segmentSphereTime(from, end, { x: ship.px, y: ship.py, z: ship.pz }, 4) !== null) return false;
    }
    return true;
  }

  // True if the segment from->to has an OPEN path (doesn't pass through a capital's solid core). A
  // cannon "fires through its own hull" — so it may only fire when nothing solid blocks the shot.
  // We test both capitals' solid cores; the firing cannon's OWN capital is the usual blocker (target
  // on the far side of the hull), and we also refuse a shot that would tunnel through the enemy hull
  // to reach a pilot hugging its far side. A small start offset skips the muzzle's own hull skin.
  _clearShot(from, to, firingTeam, enemyOnly = false, targetStructureTeam = -1) {
    for (const team of [0, 1]) {
      if ((enemyOnly && team === firingTeam) || team === targetStructureTeam) continue;
      const c = this.room.baseCenter(team);
      // For the FIRING cannon's OWN capital, block only against the tight SOLID CORE — the actual
      // impassable body. Using the loose outer collide radius here falsely blocked every shot at a
      // pilot hugging the hull (they sit inside the outer envelope but outside the solid core), so
      // a capital never fired at a ship parked on top of it. The ENEMY capital keeps the fuller
      // envelope so a shot still can't tunnel through its body to reach a pilot on the far side.
      let coreR;
      if (team === firingTeam) coreR = this.room.baseSolidCore ? this.room.baseSolidCore(team) : 62;
      else coreR = this.room.baseCollideRadius ? this.room.baseCollideRadius(team) : 90;
      // Nudge the segment start out along the shot direction so a cannon's own hull skin right at the
      // muzzle doesn't self-block every shot.
      const dir = norm(sub(to, from));
      const start = { x: from.x + dir.x * 4, y: from.y + dir.y * 4, z: from.z + dir.z * 4 };
      const d2 = segPointDist2(start.x, start.y, start.z, to.x, to.y, to.z, c.x, c.y, c.z);
      // For the firing hull use the solid core almost exactly (the true blocker); for the enemy hull
      // stay slightly tighter than its full envelope so grazing an edge doesn't kill every flank shot.
      const block = team === firingTeam ? coreR * 1.0 : coreR * 0.82;
      if (d2 < block * block) return false;
    }
    return true;
  }

  // Conservative solid-core cover for already airborne capital shots.
  coverTime(from, to, firingTeam) {
    let first = Infinity;
    for (const team of [0, 1]) {
      const center = this.room.baseCenter(team), radius = this.room.baseSolidCore?.(team) || 62;
      // Authored launchers may sit inside the conservative core envelope; their firing arc
      // already rejects shots into their own hull. Let that projectile leave the muzzle.
      if (team === firingTeam && Math.hypot(from.x - center.x, from.y - center.y, from.z - center.z) < radius) continue;
      const time = segmentSphereTime(from, to, center, radius);
      if (time !== null) first = Math.min(first, time);
    }
    return first === Infinity ? null : first;
  }

  // Spawn one physical bolt along the actual barrel direction. Bolts are
  // tagged `capital` (bright/large client render), given a long TTL + high speed so they streak far
  // off the battlefield, and are team-tagged so the existing advanceBolts hit logic damages the
  // ATTACKING faction's ships (no friendly fire). `burstStart` pulses the replicated fire event so
  // clients play the faction cannon sound + muzzle flash exactly once per burst.
  _fireCannonShot(s, target, profile) {
    if (this.room.state.bolts.size >= 400) return false;
    const from = this._weaponMuzzle(s), dir = s.direction, bolt = new Bolt();
    bolt.owner = 'cap:' + s.capTeam; bolt.team = s.capTeam; bolt.capital = true;
    bolt.px = from.x + dir.x * 1.5; bolt.py = from.y + dir.y * 1.5; bolt.pz = from.z + dir.z * 1.5;
    bolt.vx = dir.x * profile.boltSpeed; bolt.vy = dir.y * profile.boltSpeed; bolt.vz = dir.z * profile.boltSpeed;
    bolt._ttl = profile.range / profile.boltSpeed + 0.15;
    bolt._damage = profile.boltDamage;
    this.room.state.bolts.set('cb' + (++this._boltSeq), bolt);
    return true;
  }

  testBoltHit(bolt, nx, ny, nz) {
    return this.testStructureHit(bolt, bolt.px, bolt.py, bolt.pz, nx, ny, nz, false);
  }

  testMissileHit(missile, x, y, z, nx, ny, nz) {
    return this.testStructureHit(missile, x, y, z, nx, ny, nz, true);
  }

  testStructureHit(projectile, x, y, z, nx, ny, nz, missile) {
    if (!this.active || this.room.state.matchState !== 'live') return false;
    const team = 1 - projectile.team;
    const dx = nx - x, dy = ny - y, dz = nz - z;
    const from = { x, y, z }, to = { x: nx, y: ny, z: nz };
    let first = hullEntry(this._caps[team], from, to) ?? Infinity;
    let mount = null;
    for (const emplacement of this._emp.values()) {
      if (emplacement.capTeam !== team || !emplacement.e.alive) continue;
      const n = emplacement.normalWorld;
      if (dx*n.x + dy*n.y + dz*n.z > 0) continue;
      const radius = emplacement.hitR || (emplacement.kind === 'shieldgen' ? 9 : 7);
      const t = segmentSphereTime(from, to, emplacement.worldPos, radius + (missile ? 13 : 0));
      if (t !== null && t < first) { first = t; mount = emplacement; }
    }
    if (!Number.isFinite(first)) return false;
    const hit = { x: x+first*dx, y: y+first*dy, z: z+first*dz };
    const damage = missile ? this._missileDamage() : this._boltDamage(projectile);
    if (mount) this._damageEmplacement(mount.key, damage);
    else if (this.liveGens(team)) this.room.broadcast('capShieldDeflect', { team, ...hit });
    else this._damageCapitalHull(team, damage * 0.5, hit.x, hit.y, hit.z);
    if (missile) this.room.broadcast('missileHit', { ...hit, owner: projectile.owner, victim: '' });
    return true;
  }

  // A missile's damage to capital structures — a fixed heavy warhead value (missiles don't scale with
  // hull firepower the way bolts do; the payload is the same regardless of who launched it). Tuned so
  // a couple of hits kill a shield generator and a salvo meaningfully chews the exposed hull.
  _missileDamage() { return 45; }

  // A player bolt's damage to capital structures, scaled by the shooter's firepower (heavier hulls
  // chew the capital faster), mirroring the ship-bolt damage scaling in advanceBolts.
  _boltDamage(bolt) {
    const shooterSim = this.room.sim.get(bolt.owner);
    const fp = shooterSim && shooterSim.firepower ? shooterSim.firepower : 1;
    return 12 * fp;
  }

  // Apply damage to a specific emplacement; destroy it (broadcast + collapse) at 0 HP. Destroying the
  // LAST shield generator collapses the capital's shields (broadcast so clients drop the dome + warn).
  _damageEmplacement(key, dmg) {
    const s = this._emp.get(key);
    if (!s || !s.e.alive) return;
    s.e.hp = Math.max(0, s.e.hp - dmg);
    if (s.e.hp <= 0) {
      s.e.alive = false;
      const wasGen = s.kind === 'shieldgen';
      this.room.broadcast('capEmplaceDestroyed', {
        key, team: s.capTeam, kind: s.kind, x: s.worldPos.x, y: s.worldPos.y, z: s.worldPos.z,
      });
      if (wasGen && this.liveGens(s.capTeam) === 0) {
        // Shields down: the hull is now soft. Clients flash the warning + drop the enveloping dome.
        this.room.broadcast('capShieldsDown', { team: s.capTeam });
      }
    }
  }

  // Apply damage to a team's capital HULL (only reachable once its shields are down). Writes the
  // replicated integrity and, at 0, ends the match with the OTHER team as the winner.
  _damageCapitalHull(team, dmg, x, y, z) {
    if (this.liveGens(team) > 0 || !(dmg > 0)) return;
    const key = team === 0 ? 'blueCapHull' : 'redCapHull';
    const cur = this.room.state[key];
    const next = Math.max(0, cur - dmg);
    this.room.state[key] = next;
    this.room.broadcast('capHullHit', { team, hull: next, x, y, z });
    if (next <= 0 && this.room.state.matchState === 'live') {
      // The capital is destroyed -> the ATTACKING (other) team wins immediately.
      this.room.state.winningTeam = team === 0 ? 1 : 0;
      this.room.broadcast('capitalDown', { team, winningTeam: this.room.state.winningTeam });
      this.room.endMatch();
    }
  }
}