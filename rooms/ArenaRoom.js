// ---- ArenaRoom: the authoritative 12v12 match room -------------------------------------------
// This is the heart of the multiplayer server. It runs a FIXED-TIMESTEP simulation (30 Hz), owns
// the true state of every ship, and streams state patches to all clients. Clients send only INPUT
// frames (intent: steer/thrust/boost/roll) — never positions — so the server can't be lied to about
// where a ship is. This is the anti-cheat foundation and the thing that makes 24 players agree on
// one reality.
//
// PHASE 1 SCOPE: authoritative MOVEMENT for up to 24 players (12 per team), team assignment, join/
// leave. Shooting, damage, death/respawn, scoring, and win conditions are Phase 2+ and are called
// out with TODO markers where they'll slot in.
import { Room } from '@colyseus/core';
import { ArenaState, Ship, Bolt, Missile } from './schema.js';
import { stepShip, forwardFromQuat } from '../shared/flightModel.js';
import { sanitizeShip, statsFor } from './shipStats.js';

const TICK_HZ = 30;                 // authoritative simulation rate
const TICK_MS = 1000 / TICK_HZ;
const FIXED_DT = 1 / TICK_HZ;       // seconds per tick fed to the shared integrator
const MAX_PER_TEAM = 12;            // 12v12 -> 24 players max
const MAX_CLIENTS = MAX_PER_TEAM * 2;
const INPUT_QUEUE_CAP = 8;          // per-player: cap buffered inputs so a flooding client can't grow memory

// --- Combat tuning (all authoritative; clients only render the results) -----------------------
const BOLT_SPEED = 520;             // units/sec — fast tracer
const BOLT_LIFETIME = 1.6;          // seconds before a bolt expires
const BOLT_DAMAGE = 12;             // damage per hit
const BOLT_MUZZLE = 6;              // spawn this far ahead of the nose so we never self-collide
const FIRE_COOLDOWN = 0.14;         // min seconds between a player's shots (server-enforced rate cap)
// Ship hit sphere radius (units). Sized so laser hits register out to ~200-220m of aim: the swept
// segment test plus this radius forgive the small aim/latency error at range, so a bolt lined up on
// a distant contact still counts. Bolts still expire by BOLT_LIFETIME (520 u/s * 1.6s ~= 832u max).
const HIT_RADIUS = 14;
const SHIELD_REGEN = 9;             // shield charge/sec, regenerates when not recently hit
const SHIELD_REGEN_DELAY = 3;       // seconds after taking a hit before shields recharge
const RESPAWN_DELAY = 4;            // seconds dead before respawning (covers the client warp-in beat)
const MAX_BOLTS = 400;              // hard cap on live bolts (safety)

// --- Guided missiles (heavy, homing) ----------------------------------------------------------
const MISSILE_SPEED = 300;          // units/sec cruise speed
const MISSILE_LIFETIME = 6.0;       // seconds before a missile self-expires
const MISSILE_MUZZLE = 5;           // spawn this far ahead of the nose
const MISSILE_DAMAGE = 120;         // heavy warhead (roughly one-shots most hulls through shields)
const MISSILE_HIT_RADIUS = 16;      // proximity-fuse blast radius
const MISSILE_COOLDOWN = 1.4;       // min seconds between a player's missile shots
const MAX_MISSILES = 120;           // hard cap on live missiles (safety)
// Authoritative loadout economy: a pilot starts each life with their hull's rack (shipStats.missiles),
// spends one per launch (a launch with an empty rack is REJECTED server-side), and earns one back for
// every KILL_STREAK_REWARD confirmed kills this life — capped at the hull's rack size so it can't
// overflow. Tracked server-side so a tampered client can't grant itself unlimited missiles.
const KILL_STREAK_REWARD = 3;       // kills-per-bonus-missile
// Missile ENGAGEMENT ENVELOPE (must mirror the client's MISSILE_LOCK_RANGE / turn constants in
// main.js so single-player and arena behave the same). A lock/launch is rejected beyond
// MISSILE_LOCK_RANGE. Launch distance sets the seeker's turn authority: a close shot is agile and
// hard to shake (MISSILE_TURN_NEAR), a shot near max range is sluggish and easy to out-turn
// (MISSILE_TURN_FAR). This is defensive-flight evasion; chaff behavior is separate/unchanged.
const MISSILE_LOCK_RANGE = 325;     // units — no homing lock can be acquired beyond this
const MISSILE_TURN_NEAR = 3.1;      // rad/sec turn authority for a point-blank launch
const MISSILE_TURN_FAR = 1.15;      // rad/sec turn authority for a launch near max range
function missileTurnForRange(dist) {
  const k = Math.max(0, Math.min(1, (dist || 0) / MISSILE_LOCK_RANGE));
  return MISSILE_TURN_NEAR + (MISSILE_TURN_FAR - MISSILE_TURN_NEAR) * k;
}

// --- Squadron Death Match settings -------------------------------------------------------------
// The host picks the round length from this whitelist in the lobby; anything else is rejected. The
// team with the most opponent kills when the clock hits 0 wins. The clock stops at 0 (never counts
// negative) and the match ends the tick it reaches 0.
const ROUND_DURATIONS = [300, 600, 900, 1200];   // 5 / 10 / 15 / 20 minutes (seconds)
const DEFAULT_ROUND = 600;                        // 10 minutes

// Team spawn anchors: blue spawns on one side of the arena, red on the other, facing inward.
const SPAWN = {
  0: { pos: [-260, 0, 260],  faceZ: -1 },   // blue
  1: { pos: [ 260, 0, -260], faceZ:  1 },    // red
};
// Respawn scatter: after a death, a ship warps back in at a RANDOM point drawn around its team
// anchor (not the exact spot it died) so pilots don't rematerialize in the same kill-box. We sample
// several candidates in this radius and pick the one FARTHEST from the nearest live enemy, so a
// respawning pilot lands away from the pack that just killed them.
const RESPAWN_SPREAD = 220;         // units around the team anchor a respawn may scatter
const RESPAWN_CANDIDATES = 8;       // sample this many points, keep the safest (farthest from enemies)

export class ArenaRoom extends Room {
  onCreate(options) {
    this.maxClients = MAX_CLIENTS;
    this.setState(new ArenaState());
    console.log(`[arena] room CREATED (roomId=${this.roomId})`);
    // Per-player server-side scratch: authoritative kinematic state + a small input buffer. Kept
    // OFF the synced schema (plain JS) so we only replicate the final pose, not the input plumbing.
    this.sim = new Map();   // sessionId -> { pos, vel, quat, inputs: [] }

    // Clients send an "input" message each of their frames: a normalized intent + a monotonically
    // increasing seq. We buffer it; the fixed tick consumes it. We validate/clamp on apply.
    this.onMessage('input', (client, msg) => {
      const s = this.sim.get(client.sessionId);
      if (!s || !msg) return;
      // Guard against floods: keep only the most recent inputs.
      if (s.inputs.length >= INPUT_QUEUE_CAP) s.inputs.shift();
      s.inputs.push(sanitizeInput(msg));
    });

    // A client asks to fire. We AUTHORITATIVELY spawn the bolt from the shooter's current nose —
    // the client sends no position/direction, so it can't fake trajectories. Rate-limited server-side.
    this.onMessage('fire', (client) => this.tryFire(client.sessionId));

    // A client asks to launch a guided missile at a locked target. The client sends ONLY the target's
    // sessionId (the intent) — the server validates it's a live hostile, spawns the missile from the
    // shooter's nose, and homes + damages it authoritatively. Rate-limited server-side.
    this.onMessage('missile', (client, msg) => this.tryFireMissile(client.sessionId, msg && msg.target));

    // VOICE PRESENCE (transport-agnostic): the client reports push-to-talk state. We only replicate a
    // `speaking` flag so every pilot can render who's on the radio; the actual audio rides a separate
    // WebRTC/SFU layer. We DON'T rate-limit this (it's a low-frequency edge event: pressed / released).
    this.onMessage('voice', (client, msg) => {
      const ship = this.state.ships.get(client.sessionId);
      if (!ship) return;
      ship.speaking = !!(msg && msg.talking);
    });

    // SQUAD channel opt-in: a pilot may choose to talk only to their squad (same-team, squad-opted
    // pilots) instead of the whole team. Replicated so speaking indicators + a future audio layer can
    // route correctly. A pilot leaving squad also stops "speaking" on that channel implicitly.
    this.onMessage('voiceChannel', (client, msg) => {
      const ship = this.state.ships.get(client.sessionId);
      if (!ship) return;
      ship.squad = !!(msg && msg.squad);
    });

    // Default match config (Squadron Death Match, 10-minute round). Host may change it in the lobby.
    this.state.mode = 'sdm';
    this.state.matchState = 'lobby';
    this.state.roundDuration = DEFAULT_ROUND;
    this.state.timeLeft = DEFAULT_ROUND;
    this.state.blueKills = 0;
    this.state.redKills = 0;
    this.state.winningTeam = -1;

    // HOST-ONLY lobby config: change the game mode / round settings before the match starts. Only
    // the current host may set it, and only while we're in the lobby (not mid-round). We whitelist
    // both mode and round duration so a client can't inject arbitrary values.
    this.onMessage('config', (client, msg) => {
      if (client.sessionId !== this.state.host) return;      // only the host configures
      if (this.state.matchState !== 'lobby') return;          // no reconfiguring a live/ended round
      if (!msg) return;
      if (msg.mode === 'sdm') this.state.mode = 'sdm';        // only SDM exists for now
      const d = Number(msg.roundDuration);
      if (ROUND_DURATIONS.includes(d)) {
        this.state.roundDuration = d;
        this.state.timeLeft = d;   // keep the displayed lobby clock in sync with the chosen length
      }
    });

    // A client picks/changes their hull (during the ship-select window at match start). We validate
    // the id, enforce that it belongs to the player's TEAM (blue = hero hulls, red = enemy hulls),
    // update the replicated ship + its authoritative capacities/multipliers, and heal to the new
    // hull's full capacity so the choice takes effect cleanly before the round.
    this.onMessage('setShip', (client, msg) => {
      const ship = this.state.ships.get(client.sessionId);
      const s = this.sim.get(client.sessionId);
      if (!ship || !s || !msg) return;
      const shipId = sanitizeShip(msg.ship, ship.team);   // team-filtered validation
      if (shipId === ship.ship) return;
      const st = statsFor(shipId);
      ship.ship = shipId;
      const maxHull = 100 * st.hull;
      const maxShields = 100 * st.shield;
      ship.hull = maxHull;
      ship.shields = maxShields;
      s.maxHull = maxHull;
      s.maxShields = maxShields;
      s.firepower = st.firepower;
      s.speed = st.speed;
      // Re-arm to the new hull's rack so the loadout matches the chosen ship before the round.
      const maxMissiles = st.missiles || 4;
      s.maxMissiles = maxMissiles;
      ship.maxMissiles = maxMissiles;
      ship.missiles = maxMissiles;
    });

    // HOST-ONLY: start the round. Flips the match live, resets the clock + team scores, and revives
    // everyone at full health so the round begins clean. Ignored if not host or not in the lobby.
    this.onMessage('startMatch', (client) => {
      if (client.sessionId !== this.state.host) return;
      if (this.state.matchState !== 'lobby') return;
      this.startMatch();
    });

    this._boltSeq = 0;   // monotonically increasing id source for bolt map keys
    this._missileSeq = 0; // monotonically increasing id source for missile map keys
    this._now = 0;       // accumulated sim time in seconds (for cooldowns / regen / respawn timers)

    // Fixed-timestep authoritative loop. setSimulationInterval runs decoupled from client frame
    // rates, so every ship advances by the same FIXED_DT regardless of who's lagging.
    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  // Assign the incoming player to the smaller team (keeps 12v12 balanced as people join/leave).
  pickTeam() {
    return this.state.blueCount <= this.state.redCount ? 0 : 1;
  }

  onJoin(client, options) {
    const team = this.pickTeam();
    const name = sanitizeName(options && options.name);
    const shipId = sanitizeShip(options && options.ship, team);   // team-filtered (blue heroes / red enemies)
    const st = statsFor(shipId);
    const ship = new Ship();
    ship.name = name;
    ship.team = team;
    ship.ship = shipId;
    // Per-hull capacities from the balance table. Kept small so no ship dominates.
    const maxHull = 100 * st.hull;
    const maxShields = 100 * st.shield;
    ship.hull = maxHull;
    ship.shields = maxShields;
    // Guided-missile rack: this hull's authoritative capacity, full at spawn.
    const maxMissiles = st.missiles || 4;
    ship.maxMissiles = maxMissiles;
    ship.missiles = maxMissiles;

    // Seat the ship at its team spawn, nose pointed inward toward the fight.
    const sp = SPAWN[team];
    ship.px = sp.pos[0]; ship.py = sp.pos[1]; ship.pz = sp.pos[2];
    // Face along ±Z: identity quat faces -Z (nose), so red (faceZ +1) needs a 180° yaw.
    if (sp.faceZ === 1) { ship.qx = 0; ship.qy = 1; ship.qz = 0; ship.qw = 0; }
    else { ship.qx = 0; ship.qy = 0; ship.qz = 0; ship.qw = 1; }

    this.state.ships.set(client.sessionId, ship);
    if (team === 0) this.state.blueCount++; else this.state.redCount++;

    // First pilot in the room becomes the HOST — the one who configures the mode/settings and
    // starts the match. If the room is empty of a host (e.g. the previous host left), adopt this one.
    if (!this.state.host || !this.state.ships.has(this.state.host)) {
      this.state.host = client.sessionId;
    }

    // Server-side authoritative scratch for this player (plain vectors the integrator mutates).
    this.sim.set(client.sessionId, {
      pos: { x: ship.px, y: ship.py, z: ship.pz },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: ship.qx, y: ship.qy, z: ship.qz, w: ship.qw },
      inputs: [],
      lastSeq: 0,
      // Combat scratch (server-only, never replicated):
      fireCd: 0,        // seconds remaining until this player can fire again
      missileCd: 0,     // seconds remaining until this player can launch another missile
      lastHitAt: -999,  // sim time of last damage taken (gates shield regen)
      respawnAt: 0,     // sim time to respawn at (when dead)
      killStreak: 0,    // confirmed kills THIS LIFE (drives the missile-resupply reward; reset on death)
      // Per-hull balance (from shipStats.js): capacities + damage dealt + move scale.
      maxHull, maxShields,
      maxMissiles,
      firepower: st.firepower,
      speed: st.speed,
    });

    console.log(`[arena] ${name} joined as ${team === 0 ? 'BLUE' : 'RED'} (${this.state.blueCount}v${this.state.redCount}) [roomId=${this.roomId}, clients=${this.clients.length}]`);
  }

  onLeave(client) {
    const ship = this.state.ships.get(client.sessionId);
    if (ship) {
      if (ship.team === 0) this.state.blueCount = Math.max(0, this.state.blueCount - 1);
      else this.state.redCount = Math.max(0, this.state.redCount - 1);
    }
    this.state.ships.delete(client.sessionId);
    this.sim.delete(client.sessionId);
    // Drop any live bolts this player owned so they don't hang around ownerless.
    for (const [id, bolt] of this.state.bolts) {
      if (bolt.owner === client.sessionId) this.state.bolts.delete(id);
    }
    // Drop any live missiles this player owned or was the target of (so a homing dart doesn't chase
    // a ghost after its target left).
    for (const [id, m] of this.state.missiles) {
      if (m.owner === client.sessionId || m.target === client.sessionId) this.state.missiles.delete(id);
    }
    // If the HOST left, hand the crown to whoever remains (first ship in the map) so the lobby can
    // still be configured/started. Empties to '' when the room drains.
    if (this.state.host === client.sessionId) {
      let next = '';
      for (const sid of this.state.ships.keys()) { next = sid; break; }
      this.state.host = next;
    }
  }

  // One authoritative simulation step: move ships, regen shields, advance bolts + hit-detect, and
  // process death/respawn. Everything here is server truth; clients only render the replicated state.
  tick() {
    this._now += FIXED_DT;

    // --- 0) Round clock (Squadron Death Match) ------------------------------------------------
    // Only counts while the match is LIVE. Decrement toward 0, clamp at 0 (never go negative), and
    // end the match the moment it reaches 0 — the team with the most opponent kills wins.
    if (this.state.matchState === 'live') {
      if (this.state.timeLeft > 0) {
        this.state.timeLeft = Math.max(0, this.state.timeLeft - FIXED_DT);
      }
      if (this.state.timeLeft <= 0) {
        this.state.timeLeft = 0;
        this.endMatch();
      }
    }

    // --- 1) Ships: integrate movement, regen shields, handle respawn --------------------------
    for (const [sessionId, s] of this.sim) {
      const ship = this.state.ships.get(sessionId);
      if (!ship) continue;

      if (s.fireCd > 0) s.fireCd = Math.max(0, s.fireCd - FIXED_DT);
      if (s.missileCd > 0) s.missileCd = Math.max(0, s.missileCd - FIXED_DT);

      // Dead ships: hold position until their respawn timer elapses, then respawn at team anchor.
      if (!ship.alive) {
        // Replicate the seconds-remaining so the owning client can render an accurate kill-cam
        // countdown (clamped to >=0). Cleared to 0 on respawn below.
        ship.respawnIn = Math.max(0, s.respawnAt - this._now);
        if (this._now >= s.respawnAt) this.respawnShip(sessionId, ship, s);
        continue;   // no input/movement/regen while dead
      }

      // Consume the latest input this tick. We apply the freshest buffered frame (dropping older
      // ones is fine at 30 Hz — clients also send at ~their frame rate). If none arrived, coast on
      // the last input's held state so brief packet gaps don't stutter the ship.
      let input = s.lastInput || IDLE_INPUT;
      if (s.inputs.length) {
        input = s.inputs[s.inputs.length - 1];
        s.inputs.length = 0;
        s.lastInput = input;
        s.lastSeq = input.seq >>> 0;
      }

      stepShip(s, input, FIXED_DT, s.speed || 1);

      // Shield regen after a grace period since the last hit (up to this hull's capacity).
      const maxSh = s.maxShields || 100;
      if (ship.shields < maxSh && (this._now - s.lastHitAt) >= SHIELD_REGEN_DELAY) {
        ship.shields = Math.min(maxSh, ship.shields + SHIELD_REGEN * FIXED_DT);
      }

      // Write authoritative pose back to the replicated schema.
      ship.px = s.pos.x; ship.py = s.pos.y; ship.pz = s.pos.z;
      ship.vx = s.vel.x; ship.vy = s.vel.y; ship.vz = s.vel.z;
      ship.qx = s.quat.x; ship.qy = s.quat.y; ship.qz = s.quat.z; ship.qw = s.quat.w;
      ship.boost = !!input.boost;
      ship.lastSeq = s.lastSeq;
    }

    // --- 2) Bolts: advance and hit-detect -----------------------------------------------------
    this.advanceBolts();

    // --- 3) Missiles: home toward their locked target, advance, and proximity-fuse -------------
    this.advanceMissiles();
  }

  // Attempt to fire from `sessionId`: authoritative rate-limit + spawn a bolt down the nose.
  tryFire(sessionId) {
    const ship = this.state.ships.get(sessionId);
    const s = this.sim.get(sessionId);
    if (!ship || !s || !ship.alive) return;
    if (s.fireCd > 0) return;                 // server-enforced fire rate
    if (this.state.bolts.size >= MAX_BOLTS) return;
    s.fireCd = FIRE_COOLDOWN;

    const fwd = forwardFromQuat(s.quat);      // unit nose vector
    const bolt = new Bolt();
    bolt.owner = sessionId;
    bolt.team = ship.team;
    // Spawn just ahead of the muzzle, inheriting the ship's velocity plus bolt speed along the nose.
    bolt.px = s.pos.x + fwd.x * BOLT_MUZZLE;
    bolt.py = s.pos.y + fwd.y * BOLT_MUZZLE;
    bolt.pz = s.pos.z + fwd.z * BOLT_MUZZLE;
    bolt.vx = s.vel.x + fwd.x * BOLT_SPEED;
    bolt.vy = s.vel.y + fwd.y * BOLT_SPEED;
    bolt.vz = s.vel.z + fwd.z * BOLT_SPEED;

    const id = 'b' + (++this._boltSeq);
    bolt._ttl = BOLT_LIFETIME;                // server-only lifetime (not replicated)
    this.state.bolts.set(id, bolt);
  }

  // Attempt to launch a guided missile from `sessionId` at `targetId`. Authoritatively validates the
  // target is a live hostile, rate-limits, and spawns a homing missile from the shooter's nose. A
  // missing/invalid target degrades to a dumbfire missile that flies straight (target = '').
  tryFireMissile(sessionId, targetId) {
    const ship = this.state.ships.get(sessionId);
    const s = this.sim.get(sessionId);
    if (!ship || !s || !ship.alive) return;
    if (s.missileCd > 0) return;                       // server-enforced missile rate
    if (ship.missiles <= 0) return;                    // AUTHORITATIVE AMMO: empty rack -> launch rejected
    if (this.state.missiles.size >= MAX_MISSILES) return;
    s.missileCd = MISSILE_COOLDOWN;
    ship.missiles -= 1;                                // spend one round from the replicated rack

    // Validate the requested target: must be a different, live, OPPOSING-team ship to home on AND
    // within the engagement envelope. A lock is REJECTED beyond MISSILE_LOCK_RANGE (the seeker can't
    // acquire that far off); such a launch degrades to a straight dumbfire. Otherwise the launch
    // distance sets the seeker's turn authority (close = agile, far = easy to evade).
    let lockId = '';
    let launchTurn = MISSILE_TURN_NEAR;   // dumbfire default (unused for straight flight)
    if (typeof targetId === 'string' && targetId && targetId !== sessionId) {
      const tgt = this.state.ships.get(targetId);
      if (tgt && tgt.alive && tgt.team !== ship.team) {
        const ddx = tgt.px - s.pos.x, ddy = tgt.py - s.pos.y, ddz = tgt.pz - s.pos.z;
        const range = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (range <= MISSILE_LOCK_RANGE) { lockId = targetId; launchTurn = missileTurnForRange(range); }
      }
    }

    const fwd = forwardFromQuat(s.quat);
    const m = new Missile();
    m.owner = sessionId;
    m.team = ship.team;
    m.target = lockId;
    m._turn = launchTurn;   // server-only steering authority baked from launch range
    m.px = s.pos.x + fwd.x * MISSILE_MUZZLE;
    m.py = s.pos.y + fwd.y * MISSILE_MUZZLE;
    m.pz = s.pos.z + fwd.z * MISSILE_MUZZLE;
    // Launch with the ship's velocity plus missile cruise speed along the nose.
    m.vx = s.vel.x + fwd.x * MISSILE_SPEED;
    m.vy = s.vel.y + fwd.y * MISSILE_SPEED;
    m.vz = s.vel.z + fwd.z * MISSILE_SPEED;

    const id = 'm' + (++this._missileSeq);
    m._ttl = MISSILE_LIFETIME;
    this.state.missiles.set(id, m);
  }

  // Home every missile toward its locked target (turn-rate limited), advance it, and proximity-fuse
  // against any live hostile within blast radius. Expires by lifetime. Detonation deals a heavy hit.
  advanceMissiles() {
    for (const [id, m] of this.state.missiles) {
      m._ttl -= FIXED_DT;

      // Steer toward the locked target, if it's still a live hostile. The velocity direction is
      // rotated toward the target-bearing by at most m._turn*dt this tick (turn-rate limited),
      // then re-normalized to cruise speed so the dart keeps a constant speed while it homes.
      const tgt = m.target && this.state.ships.get(m.target);
      if (tgt && tgt.alive && tgt.team !== m.team) {
        const tx = tgt.px - m.px, ty = tgt.py - m.py, tz = tgt.pz - m.pz;
        const td = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        const dx = tx / td, dy = ty / td, dz = tz / td;
        const sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy + m.vz * m.vz) || 1;
        let vx = m.vx / sp, vy = m.vy / sp, vz = m.vz / sp;
        const dot = Math.max(-1, Math.min(1, vx * dx + vy * dy + vz * dz));
        const ang = Math.acos(dot);
        // Per-missile turn authority, baked from launch range (close = agile, far = easy to evade).
        const maxStep = (m._turn || MISSILE_TURN_NEAR) * FIXED_DT;
        if (ang > 1e-3) {
          const t = Math.min(1, maxStep / ang);
          // Nudge the heading toward the target bearing and renormalize.
          vx += (dx - vx) * t; vy += (dy - vy) * t; vz += (dz - vz) * t;
          const l = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
          vx /= l; vy /= l; vz /= l;
        }
        m.vx = vx * MISSILE_SPEED; m.vy = vy * MISSILE_SPEED; m.vz = vz * MISSILE_SPEED;
      } else if (m.target) {
        m.target = '';   // target died / left / same team now — go ballistic
      }

      // Advance along the (possibly re-steered) velocity.
      const nx = m.px + m.vx * FIXED_DT;
      const ny = m.py + m.vy * FIXED_DT;
      const nz = m.pz + m.vz * FIXED_DT;

      // Proximity fuse: detonate on the first live hostile within blast radius (swept segment so a
      // fast missile doesn't tunnel past a target between ticks).
      let consumed = false;
      for (const [sid, ship] of this.state.ships) {
        if (!ship.alive) continue;
        if (sid === m.owner) continue;
        if (ship.team === m.team) continue;
        if (segmentHitsSphere(m.px, m.py, m.pz, nx, ny, nz, ship.px, ship.py, ship.pz, MISSILE_HIT_RADIUS)) {
          this.damageShip(sid, ship, MISSILE_DAMAGE, m.owner);
          // Broadcast so clients can render a big warhead blast at the impact point.
          this.broadcast('missileHit', { x: ship.px, y: ship.py, z: ship.pz, owner: m.owner, victim: sid });
          consumed = true;
          break;
        }
      }

      if (consumed || m._ttl <= 0) {
        this.state.missiles.delete(id);
      } else {
        m.px = nx; m.py = ny; m.pz = nz;
      }
    }
  }

  // Move every bolt, expire old ones, and test each against enemy-team ships (sphere check with a
  // segment sweep so fast bolts don't tunnel through a ship between ticks).
  advanceBolts() {
    for (const [id, bolt] of this.state.bolts) {
      // Advance and age.
      const nx = bolt.px + bolt.vx * FIXED_DT;
      const ny = bolt.py + bolt.vy * FIXED_DT;
      const nz = bolt.pz + bolt.vz * FIXED_DT;
      bolt._ttl -= FIXED_DT;

      let consumed = false;
      // Swept collision: closest approach of the segment (bolt.p -> n) to each enemy ship center.
      for (const [sid, ship] of this.state.ships) {
        if (!ship.alive) continue;
        if (sid === bolt.owner) continue;       // never hit the shooter
        if (ship.team === bolt.team) continue;  // no friendly fire
        if (segmentHitsSphere(bolt.px, bolt.py, bolt.pz, nx, ny, nz, ship.px, ship.py, ship.pz, HIT_RADIUS)) {
          // Damage scales with the SHOOTER's firepower multiplier (heavier hulls hit harder).
          const shooter = this.sim.get(bolt.owner);
          const dmg = BOLT_DAMAGE * (shooter && shooter.firepower ? shooter.firepower : 1);
          this.damageShip(sid, ship, dmg, bolt.owner);
          consumed = true;
          break;
        }
      }

      if (consumed || bolt._ttl <= 0) {
        this.state.bolts.delete(id);
      } else {
        bolt.px = nx; bolt.py = ny; bolt.pz = nz;
      }
    }
  }

  // Apply damage to a ship: shields absorb first, then hull. Credits a kill on destruction.
  // Broadcasts a 'hit' event so BOTH the shooter (hit-marker "you connected") and the victim
  // (damage flash / "you're taking fire") get immediate feedback, independent of the kill event.
  damageShip(sid, ship, dmg, attackerId) {
    const s = this.sim.get(sid);
    if (s) s.lastHitAt = this._now;
    const shieldHit = ship.shields > 0;   // did the shot land on shields (vs bare hull)?
    if (ship.shields > 0) {
      const absorbed = Math.min(ship.shields, dmg);
      ship.shields -= absorbed;
      dmg -= absorbed;
    }
    if (dmg > 0) ship.hull -= dmg;
    const lethal = ship.hull <= 0 && ship.alive;
    // Tell everyone a hit landed (only meaningful to the shooter + victim, but broadcast is simplest
    // and cheap). `lethal` lets the shooter skip the plain hit-marker when the kill event covers it.
    this.broadcast('hit', {
      attacker: attackerId, victim: sid, shield: shieldHit, lethal,
      x: ship.px, y: ship.py, z: ship.pz,
    });
    if (lethal) this.killShip(sid, ship, attackerId);
  }

  // Destroy a ship: mark dead, bump scoreboards, schedule respawn, and broadcast a kill event so
  // clients can play an explosion + feed message.
  killShip(sid, ship, attackerId) {
    ship.alive = false;
    ship.hull = 0;
    ship.shields = 0;
    ship.speaking = false;   // a destroyed pilot drops off the radio until they respawn
    ship.deaths = (ship.deaths + 1) & 0xffff;
    ship.respawnIn = RESPAWN_DELAY;                          // seed the replicated countdown immediately
    ship.lastKiller = (attackerId && attackerId !== sid) ? attackerId : '';   // for the client kill-cam framing
    const s = this.sim.get(sid);
    if (s) s.respawnAt = this._now + RESPAWN_DELAY;
    const killer = this.state.ships.get(attackerId);
    if (killer && attackerId !== sid) {
      killer.kills = (killer.kills + 1) & 0xffff;
      // MISSILE RESUPPLY: every KILL_STREAK_REWARD confirmed kills THIS LIFE tops the killer's rack
      // up by one, capped at their hull's capacity. Authoritative, so a client can't fake the reward.
      const ks = this.sim.get(attackerId);
      if (ks) {
        ks.killStreak = (ks.killStreak || 0) + 1;
        if (ks.killStreak % KILL_STREAK_REWARD === 0) {
          const cap = killer.maxMissiles || ks.maxMissiles || 4;
          if (killer.missiles < cap) killer.missiles = Math.min(cap, killer.missiles + 1);
        }
      }
      // Credit the killer's TEAM with an opponent kill — this is the Squadron Death Match win
      // metric. Only count while the match is live (post-round kills don't change the result).
      if (this.state.matchState === 'live') {
        if (killer.team === 0) this.state.blueKills = (this.state.blueKills + 1) & 0xffff;
        else this.state.redKills = (this.state.redKills + 1) & 0xffff;
      }
    }
    this.broadcast('kill', {
      victim: sid, victimName: ship.name, victimTeam: ship.team,
      killer: attackerId, killerName: killer ? killer.name : '',
      killerTeam: killer ? killer.team : -1,
      x: ship.px, y: ship.py, z: ship.pz,
    });
  }

  // Pick a respawn point for `team`: sample several random offsets around the team anchor and keep
  // the candidate whose nearest LIVE enemy is farthest away, so a respawning pilot warps in clear of
  // the opposing pack. Falls back to the plain anchor if there are no live enemies to avoid.
  pickRespawnPoint(team) {
    const sp = SPAWN[team] || SPAWN[0];
    const ax = sp.pos[0], ay = sp.pos[1], az = sp.pos[2];
    // Collect live enemy positions once.
    const enemies = [];
    for (const [, ship] of this.state.ships) {
      if (ship.alive && ship.team !== team) enemies.push(ship);
    }
    if (!enemies.length) {
      // No enemies to dodge: a modest random scatter around the anchor still avoids stacking spawns.
      const a = Math.random() * Math.PI * 2, r = Math.random() * (RESPAWN_SPREAD * 0.5);
      return { x: ax + Math.cos(a) * r, y: ay + (Math.random() - 0.5) * 60, z: az + Math.sin(a) * r };
    }
    let best = { x: ax, y: ay, z: az }, bestScore = -Infinity;
    for (let i = 0; i < RESPAWN_CANDIDATES; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * RESPAWN_SPREAD;
      const cx = ax + Math.cos(a) * r;
      const cy = ay + (Math.random() - 0.5) * 90;
      const cz = az + Math.sin(a) * r;
      let nearest = Infinity;
      for (const e of enemies) {
        const dx = e.px - cx, dy = e.py - cy, dz = e.pz - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearest) nearest = d2;
      }
      if (nearest > bestScore) { bestScore = nearest; best = { x: cx, y: cy, z: cz }; }
    }
    return best;
  }

  // Respawn with full hull/shields, facing inward, velocity zeroed. The spawn POINT is scattered
  // around the team anchor and biased AWAY from live enemies (see pickRespawnPoint) so a pilot warps
  // back into open space instead of the kill-box they just died in.
  respawnShip(sid, ship, s) {
    const sp = SPAWN[ship.team] || SPAWN[0];
    const rp = this.pickRespawnPoint(ship.team);
    s.pos.x = rp.x; s.pos.y = rp.y; s.pos.z = rp.z;
    if (sp.faceZ === 1) { s.quat.x = 0; s.quat.y = 1; s.quat.z = 0; s.quat.w = 0; }
    else { s.quat.x = 0; s.quat.y = 0; s.quat.z = 0; s.quat.w = 1; }
    // Give the fresh ship a forward WARP-IN velocity down its nose (local -Z) so the client renders a
    // proper streaking arrival like the mission-start warp-in, not a dead stop. faceZ === 1 means the
    // hull is yawed 180° so its nose points +Z; otherwise the nose points -Z.
    const RESPAWN_WARP_SPEED = 30;
    const fz = sp.faceZ === 1 ? 1 : -1;
    s.vel.x = 0; s.vel.y = 0; s.vel.z = fz * RESPAWN_WARP_SPEED;
    ship.px = s.pos.x; ship.py = s.pos.y; ship.pz = s.pos.z;
    ship.vx = 0; ship.vy = 0; ship.vz = s.vel.z;
    ship.qx = s.quat.x; ship.qy = s.quat.y; ship.qz = s.quat.z; ship.qw = s.quat.w;
    ship.hull = s.maxHull || 100;
    ship.shields = s.maxShields || 100;
    // Fresh life = fresh loadout: full missile rack, and the kill-streak resupply counter resets.
    ship.missiles = s.maxMissiles || ship.maxMissiles || 4;
    s.killStreak = 0;
    ship.alive = true;
    ship.respawnIn = 0;          // alive again — clear the replicated countdown
    ship.lastKiller = '';
    s.lastHitAt = this._now;
    s.inputs.length = 0;
    s.lastInput = IDLE_INPUT;
  }

  // Start the configured round: reset the clock + team scores, revive everyone at full health at
  // their team anchor, and flip the match live so the tick clock begins counting down. Broadcasts a
  // 'matchStart' event so clients can drop from the lobby into flight together.
  startMatch() {
    this.state.matchState = 'live';
    this.state.timeLeft = this.state.roundDuration;
    this.state.blueKills = 0;
    this.state.redKills = 0;
    this.state.winningTeam = -1;
    // Clean slate: respawn every pilot and zero their per-round scoreboard.
    for (const [sid, ship] of this.state.ships) {
      ship.kills = 0;
      ship.deaths = 0;
      const s = this.sim.get(sid);
      if (s) this.respawnShip(sid, ship, s);
    }
    this.broadcast('matchStart', { roundDuration: this.state.roundDuration, mode: this.state.mode });
    console.log(`[arena] MATCH START — mode=${this.state.mode}, round=${this.state.roundDuration}s [roomId=${this.roomId}]`);
  }

  // End the round: decide the winner by most opponent kills (draw if tied), flip to 'ended', and
  // broadcast the result so clients can show the scoreboard + winner banner. The clock is already
  // clamped at 0 by the caller.
  endMatch() {
    if (this.state.matchState !== 'live') return;
    this.state.matchState = 'ended';
    const b = this.state.blueKills, r = this.state.redKills;
    this.state.winningTeam = b > r ? 0 : r > b ? 1 : -1;   // -1 = draw
    this.broadcast('matchEnd', {
      winningTeam: this.state.winningTeam,
      blueKills: b, redKills: r,
    });
    console.log(`[arena] MATCH END — BLUE ${b} : ${r} RED -> winner=${this.state.winningTeam === -1 ? 'DRAW' : this.state.winningTeam === 0 ? 'BLUE' : 'RED'} [roomId=${this.roomId}]`);
  }
}

// Closest-approach test: does the segment P0->P1 come within `r` of sphere center C? Prevents fast
// bolts from tunneling past a ship between ticks (a plain point-in-sphere test would miss those).
function segmentHitsSphere(x0, y0, z0, x1, y1, z1, cx, cy, cz, r) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const fx = x0 - cx, fy = y0 - cy, fz = z0 - cz;
  const len2 = dx * dx + dy * dy + dz * dz;
  // Degenerate (no movement): plain point test.
  let t = len2 > 1e-9 ? -(fx * dx + fy * dy + fz * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x0 + dx * t - cx, py = y0 + dy * t - cy, pz = z0 + dz * t - cz;
  return (px * px + py * py + pz * pz) <= r * r;
}

// A neutral, no-op input used when a player has never sent one / during a packet gap.
const IDLE_INPUT = { seq: 0, steerX: 0, steerY: 0, roll: 0, thrust: false, reverse: false, boost: false };

// Clamp + coerce a client input frame into a safe, known shape. NEVER trust raw client numbers.
function sanitizeInput(m) {
  return {
    seq: (m.seq >>> 0) || 0,
    steerX: clampNum(m.steerX, -1.4, 1.4),
    steerY: clampNum(m.steerY, -1.4, 1.4),
    roll: clampNum(m.roll, -1, 1),
    thrust: !!m.thrust,
    reverse: !!m.reverse,
    boost: !!m.boost,
  };
}
function clampNum(v, lo, hi) {
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return v < lo ? lo : v > hi ? hi : v;
}
function sanitizeName(n) {
  return String(n || 'PILOT').replace(/[^\w .\-]/g, '').trim().slice(0, 16).toUpperCase() || 'PILOT';
}
