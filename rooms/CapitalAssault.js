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

// --- Capital geometry (must mirror the client's CTC_BASE_CENTER + capital lengths) ---------------
// The two capitals sit at the spread team-base centers (room.baseCenter) and face the arena origin.
// Their NOMINAL lengths match scene.js: blue flagship ~140u, red capital ~260u. Mounts below are
// fractions of these so cannons/gens spread realistically along each different-sized hull.
const CAP_LEN = { 0: 140, 1: 260 };   // 0 = blue flagship, 1 = red capital (client scene.js lengths)

// --- Cannon tuning -------------------------------------------------------------------------------
const CANNON_RANGE = 250;          // only engage an enemy ship within this many units ("250M")
const CANNON_TURN = 1.6;           // rad/sec the aim point can slew toward a new target (visual only)
const CANNON_BOLT_SPEED = 340;     // units/sec — heavier/slower-reading than a fighter tracer (520)
const CANNON_BOLT_TTL = 12;        // seconds a capital bolt persists (fighter bolts live ~1.6s) so it
                                   // travels ~4000u — well off the battlefield before it expires
const CANNON_DAMAGE = 16;          // per-hit; a capital connecting occasionally is a real threat
const CANNON_BURST_MIN = 3;        // shots per burst (3-5)
const CANNON_BURST_MAX = 5;
const CANNON_SHOT_GAP = 0.11;      // seconds between shots WITHIN a burst
const CANNON_BURST_COOLDOWN_MIN = 1.8;   // seconds between bursts (per cannon)
const CANNON_BURST_COOLDOWN_MAX = 3.4;
// Deliberately IMPERFECT aim: cannons scatter their bolts by this cone (radians) so they only
// occasionally connect while human pilots fight each other — the spec calls for "not deadly
// accurate ... although a capital can occasionally connect".
const CANNON_SPREAD = 0.055;
// Fire-arc gate: a cannon only opens up when the target is within this dot of its outward mount
// normal, i.e. roughly on the side of the hull the cannon actually faces. Combined with the LOS
// gate below, this keeps a cannon from firing "backward" through its own ship.
const CANNON_ARC_DOT = -0.1;       // generous (~95deg off-normal) — the LOS test does the real gating
const CANNON_HP = 520;             // tanky: takes a fair amount of fire to destroy (spec)
const SHIELDGEN_HP = 900;          // shield generators are tough too — clearing them is the objective

// --- Shield deflection (mirrors single-player capitalDamageMult) ---------------------------------
// While generators live, the hull barely takes damage; both down = full damage.
function hullDamageMult(liveGens) {
  if (liveGens >= 2) return 0.03;
  if (liveGens === 1) return 0.18;
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

export class CapitalAssault {
  constructor(room) {
    this.room = room;
    this.active = false;
    // Per-capital pose + per-emplacement server scratch, keyed the same as state.emplacements.
    this._caps = { 0: null, 1: null };   // { center, quat, len } per team
    this._emp = new Map();               // key -> { kind, capTeam, worldPos, normalWorld, ...cannonScratch }
    this._boltSeq = 0;
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

  _buildCapital(team) {
    const pose = this._capitalPose(team);
    this._caps[team] = pose;
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
    if (!this.active) return;
    for (const s of this._emp.values()) {
      if (s.kind !== 'cannon' || !s.e.alive) continue;
      this._updateCannon(s, dt);
    }
  }

  // Drive one cannon: acquire the nearest in-range enemy ship WITH a clean shot, slew the aim point
  // toward it, and fire 3-5 round bursts on a cooldown. `firing` pulses true for one tick per burst
  // start so clients play the faction cannon sound + flash.
  _updateCannon(s, dt) {
    const room = this.room;
    const enemyTeam = s.capTeam === 0 ? 1 : 0;   // cannons shoot the OTHER faction's pilots
    // Clear last tick's one-shot fire pulse (the schema field is a per-tick edge).
    if (s.e.firing) s.e.firing = false;

    // Acquire / validate a target: the nearest LIVE enemy ship within range that we have a clean
    // (unblocked-by-our-own-hull) shot on. Re-acquire if the current target is gone / out of range /
    // now occluded, so a cannon doesn't keep tracking a target it can no longer hit.
    let target = this._pickCannonTarget(s, enemyTeam);
    if (target) { s.targetId = target.sid; } else { s.targetId = ''; }

    // Slew the replicated aim point toward the target (or hold) so clients can animate the barrels.
    if (target) {
      const want = { x: target.ship.px, y: target.ship.py, z: target.ship.pz };
      // Ease the aim toward the target at CANNON_TURN (approx, frame-rate independent).
      const k = clamp(CANNON_TURN * dt, 0, 1);
      s.aim.x += (want.x - s.aim.x) * k;
      s.aim.y += (want.y - s.aim.y) * k;
      s.aim.z += (want.z - s.aim.z) * k;
      s.e.aimX = s.aim.x; s.e.aimY = s.aim.y; s.e.aimZ = s.aim.z;
    }

    // Burst state machine. Between bursts: count down the cooldown; when it elapses AND we have a
    // valid target, arm a fresh 3-5 shot burst. During a burst: drop a shot every CANNON_SHOT_GAP.
    if (s.burstLeft > 0) {
      s.shotTimer -= dt;
      if (s.shotTimer <= 0 && target) {
        this._fireCannonShot(s, target);
        s.shotTimer = CANNON_SHOT_GAP;
        s.burstLeft--;
        if (s.burstLeft <= 0) {
          s.cooldown = CANNON_BURST_COOLDOWN_MIN + Math.random() * (CANNON_BURST_COOLDOWN_MAX - CANNON_BURST_COOLDOWN_MIN);
        }
      } else if (!target) {
        // Lost the target mid-burst: abort the burst and recover to cooldown.
        s.burstLeft = 0;
        s.cooldown = CANNON_BURST_COOLDOWN_MIN * 0.5;
      }
    } else {
      s.cooldown -= dt;
      if (s.cooldown <= 0 && target) {
        // Start a burst: fire the FIRST shot now (pulses `firing` so clients cue the sound), and
        // queue the rest on the shot gap.
        s.burstLeft = CANNON_BURST_MIN + Math.floor(Math.random() * (CANNON_BURST_MAX - CANNON_BURST_MIN + 1));
        this._fireCannonShot(s, target, /*burstStart*/ true);
        s.shotTimer = CANNON_SHOT_GAP;
        s.burstLeft--;
        if (s.burstLeft <= 0) {
          s.cooldown = CANNON_BURST_COOLDOWN_MIN + Math.random() * (CANNON_BURST_COOLDOWN_MAX - CANNON_BURST_COOLDOWN_MIN);
        }
      }
    }
  }

  // Nearest live enemy ship to this cannon within CANNON_RANGE, on the cannon's firing side, with a
  // CLEAN line of sight (the shot doesn't pass through EITHER capital's solid core). Returns
  // { sid, ship, dist } or null. Bots count as ships, so they're valid targets too.
  _pickCannonTarget(s, enemyTeam) {
    const room = this.room;
    const from = s.worldPos;
    let best = null, bestD = CANNON_RANGE;
    for (const [sid, ship] of room.state.ships) {
      if (!ship.alive) continue;
      if (ship.team !== enemyTeam) continue;         // only shoot the attacking faction
      const to = { x: ship.px, y: ship.py, z: ship.pz };
      const d = len(sub(to, from));
      if (d > bestD) continue;
      // Fire arc: target must be roughly on the side of the hull this cannon faces.
      const dir = norm(sub(to, from));
      if (dot(dir, s.normalWorld) < CANNON_ARC_DOT) continue;
      // Clean-shot gate: the muzzle->target segment must not graze either capital's solid core.
      if (!this._clearShot(from, to, s.capTeam)) continue;
      best = { sid, ship, dist: d }; bestD = d;
    }
    return best;
  }

  // True if the segment from->to has an OPEN path (doesn't pass through a capital's solid core). A
  // cannon "fires through its own hull" — so it may only fire when nothing solid blocks the shot.
  // We test both capitals' solid cores; the firing cannon's OWN capital is the usual blocker (target
  // on the far side of the hull), and we also refuse a shot that would tunnel through the enemy hull
  // to reach a pilot hugging its far side. A small start offset skips the muzzle's own hull skin.
  _clearShot(from, to, firingTeam) {
    for (const team of [0, 1]) {
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

  // Spawn ONE capital cannon bolt from a cannon toward its target, with imperfect aim. Bolts are
  // tagged `capital` (bright/large client render), given a long TTL + high speed so they streak far
  // off the battlefield, and are team-tagged so the existing advanceBolts hit logic damages the
  // ATTACKING faction's ships (no friendly fire). `burstStart` pulses the replicated fire event so
  // clients play the faction cannon sound + muzzle flash exactly once per burst.
  _fireCannonShot(s, target, burstStart = false) {
    const room = this.room;
    if (room.state.bolts.size >= 400) return;   // respect the room's global bolt cap
    const from = s.worldPos;
    const to = { x: target.ship.px, y: target.ship.py, z: target.ship.pz };
    // Lead the target slightly by its velocity so a moving pilot is actually threatened.
    const lead = 0.18;
    const aim = {
      x: to.x + (target.ship.vx || 0) * lead,
      y: to.y + (target.ship.vy || 0) * lead,
      z: to.z + (target.ship.vz || 0) * lead,
    };
    let dir = norm(sub(aim, from));
    // Imperfect aim: scatter within a cone so the capital only occasionally connects.
    dir = norm({
      x: dir.x + (Math.random() - 0.5) * CANNON_SPREAD,
      y: dir.y + (Math.random() - 0.5) * CANNON_SPREAD,
      z: dir.z + (Math.random() - 0.5) * CANNON_SPREAD,
    });
    const bolt = new Bolt();
    bolt.owner = 'cap:' + s.capTeam;   // non-ship owner id (never matches a sessionId, so no self-hit)
    bolt.team = s.capTeam;             // defending team -> advanceBolts spares this team, hits the enemy
    bolt.capital = true;
    // Spawn a bit ahead of the muzzle so it clears the hull skin.
    bolt.px = from.x + dir.x * 6;
    bolt.py = from.y + dir.y * 6;
    bolt.pz = from.z + dir.z * 6;
    bolt.vx = dir.x * CANNON_BOLT_SPEED;
    bolt.vy = dir.y * CANNON_BOLT_SPEED;
    bolt.vz = dir.z * CANNON_BOLT_SPEED;
    bolt._ttl = CANNON_BOLT_TTL;
    const id = 'cb' + (++this._boltSeq);
    room.state.bolts.set(id, bolt);
    // Cue the client on the FIRST shot of a burst: faction sound + a big muzzle flash at the cannon.
    if (burstStart) {
      s.e.firing = true;
      room.broadcast('capCannonFire', {
        team: s.capTeam, x: from.x, y: from.y, z: from.z, key: s.key,
      });
    }
  }

  // Test a player/bot bolt (from advanceBolts) against the ENEMY capital's emplacements and, once its
  // shield gens are down, its HULL. Returns true if the bolt struck something (so the caller consumes
  // it). A bolt only ever affects the capital of the team OPPOSITE the shooter.
  testBoltHit(bolt, nx, ny, nz) {
    const targetTeam = bolt.team === 0 ? 1 : 0;   // shooters attack the ENEMY capital
    // 1) Emplacements first: a hit on a live cannon/generator damages IT (bright, specific feedback).
    let hitKey = null, hitDist2 = Infinity;
    for (const s of this._emp.values()) {
      if (s.capTeam !== targetTeam || !s.e.alive) continue;
      const r = s.kind === 'shieldgen' ? 9 : 7;   // world hit radius (generators read a touch bigger)
      const d2 = segPointDist2(bolt.px, bolt.py, bolt.pz, nx, ny, nz, s.worldPos.x, s.worldPos.y, s.worldPos.z);
      if (d2 < r * r && d2 < hitDist2) { hitDist2 = d2; hitKey = s.key; }
    }
    if (hitKey) { this._damageEmplacement(hitKey, this._boltDamage(bolt)); return true; }

    // 2) HULL: only takes real damage once ALL of this capital's shield gens are down. While shielded,
    // a bolt that reaches the hull is DEFLECTED (consumed, no damage) so it visibly stops at the ship
    // rather than passing through. We test against the capital's solid core sphere.
    const c = this.room.baseCenter(targetTeam);
    const coreR = this.room.baseCollideRadius ? this.room.baseCollideRadius(targetTeam) : 90;
    const d2 = segPointDist2(bolt.px, bolt.py, bolt.pz, nx, ny, nz, c.x, c.y, c.z);
    if (d2 < coreR * coreR) {
      const gens = this.liveGens(targetTeam);
      if (gens > 0) {
        // Shielded: deflect (consume the bolt, no hull damage). Tell clients to bloom the shield.
        this.room.broadcast('capShieldDeflect', { team: targetTeam, x: bolt.px, y: bolt.py, z: bolt.pz });
      } else {
        this._damageCapitalHull(targetTeam, this._boltDamage(bolt) * 0.5, bolt.px, bolt.py, bolt.pz);
      }
      return true;
    }
    return false;
  }

  // Test a player/bot MISSILE (from the missile fuse loop) against the ENEMY capital's emplacements
  // and, once its shield gens are down, its HULL. Returns true if the missile detonated on the capital
  // (so the caller consumes it and plays a warhead blast). Mirrors testBoltHit but with a warhead's
  // larger proximity radius and heavier damage — a missile is a decisive anti-structure weapon, so a
  // hit on a generator does real work and a hull hit (shields down) bites hard. `mx,my,mz` is the
  // missile's previous position and `nx,ny,nz` its advanced position (the swept segment this tick), so
  // a fast dart can't tunnel past a small emplacement between ticks.
  testMissileHit(m, mx, my, mz, nx, ny, nz) {
    const targetTeam = m.team === 0 ? 1 : 0;   // shooters attack the ENEMY capital
    const dmg = this._missileDamage();
    // 1) Emplacements first: a warhead within the (generous) blast radius of a live cannon/generator
    //    guts it. The radius is wider than a bolt's since a missile detonates with a proximity fuse.
    let hitKey = null, hitDist2 = Infinity, hitPos = null;
    for (const s of this._emp.values()) {
      if (s.capTeam !== targetTeam || !s.e.alive) continue;
      const r = s.kind === 'shieldgen' ? 22 : 20;   // warhead proximity radius (bigger than a bolt's)
      const d2 = segPointDist2(mx, my, mz, nx, ny, nz, s.worldPos.x, s.worldPos.y, s.worldPos.z);
      if (d2 < r * r && d2 < hitDist2) { hitDist2 = d2; hitKey = s.key; hitPos = s.worldPos; }
    }
    if (hitKey) {
      this._damageEmplacement(hitKey, dmg);
      this.room.broadcast('missileHit', { x: hitPos.x, y: hitPos.y, z: hitPos.z, owner: m.owner, victim: '' });
      return true;
    }

    // 2) HULL: only takes real damage once ALL shield gens are down. While shielded, a warhead that
    //    reaches the hull is DEFLECTED (consumed, no damage) exactly like a bolt so it visibly stops
    //    at the dome. Tested against the capital's solid core sphere with a small warhead standoff so
    //    a proximity detonation just outside the hull still counts.
    const c = this.room.baseCenter(targetTeam);
    const coreR = (this.room.baseCollideRadius ? this.room.baseCollideRadius(targetTeam) : 90) + 6;
    const d2 = segPointDist2(mx, my, mz, nx, ny, nz, c.x, c.y, c.z);
    if (d2 < coreR * coreR) {
      const gens = this.liveGens(targetTeam);
      if (gens > 0) {
        this.room.broadcast('capShieldDeflect', { team: targetTeam, x: nx, y: ny, z: nz });
      } else {
        this._damageCapitalHull(targetTeam, dmg * 0.5, nx, ny, nz);
      }
      this.room.broadcast('missileHit', { x: nx, y: ny, z: nz, owner: m.owner, victim: '' });
      return true;
    }
    return false;
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
