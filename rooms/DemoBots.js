// ---- DemoBots: DEMO-ONLY AI squadron filler (REMOVE BEFORE SHIP) -----------------------------
// This module exists purely to stage a lively, believable Capture the Cargo match for recording a
// demo video WITHOUT needing 9 human pilots. When enabled, the human host starting a CTC lobby is
// joined by 4 friendly bots (their squadron) and 5 enemy bots (the opposing squadron). Bots:
//   • join STAGGERED over ~10-15s (not all at once),
//   • ready-up one-by-one (so the lobby ready pips populate believably, never all at once),
//   • then fly + fight with a lightweight server-side AI once the match goes live.
//
// The AI is intentionally "video-grade", not competitive: bots chase, strafe, fire bolts + the odd
// missile, contest the neutral flag, run it home, and — critically — put on a GOOD SHOW when the
// HUMAN is carrying the flag (enemies converge and press, allies escort), while staying beatable so
// the human can score. It is fine for the human to die and drop the flag; that is part of the show.
//
// EVERYTHING here is gated behind ArenaRoom's DEMO_BOTS flag and namespaced under `bot:` session ids
// so it is trivial to rip out later. Bots are normal entries in state.ships + the sim map, so the
// existing movement integrator, collisions, cargo pickup, damage, scoring and CTC win condition all
// treat them exactly like players — no special cases in the hot loops.

import { Ship } from './schema.js';
import { stepShip, forwardFromQuat, yawQuatToward } from '../shared/flightModel.js';
import { statsFor } from './shipStats.js';

// Team rosters mirror shipStats.js (blue hero hulls / red captured hulls).
const BLUE_HULLS = ['concept', 'fury', 'lightning'];
const RED_HULLS = ['interceptor', 'fighter', 'bomber'];

// Believable call signs for the AI squadron (no real player names).
const BLUE_NAMES = ['VIPER', ' GHOST', 'RAZOR', ' ECHO'];
const RED_NAMES = ['KOBRA', 'DRAKE', 'ONYX', 'REAPER', 'HAVOC'];

// How many bots per team and the join/ready pacing.
const BLUE_BOTS = 4;
const RED_BOTS = 5;
const JOIN_WINDOW_MS = 12000;   // spread all joins across ~12s (inside the requested 10-15s)
const JOIN_FIRST_MS = 900;      // first bot joins shortly after the human opens the lobby
const READY_AFTER_JOIN_MS = 1400;   // a bot readies up this long after it has joined (staggered per-bot)
const READY_JITTER_MS = 1600;       // extra random spread so ready pips never pop in lockstep

// --- AI tuning (video-grade, deliberately beatable) -------------------------------------------
const BOT_FIRE_RANGE = 340;        // only shoot when the target is within this and roughly ahead
const BOT_FIRE_CONE = 0.965;       // dot(nose, toTarget) must exceed this to pull the trigger
const BOT_FIRE_CHANCE = 0.55;      // per-eligible-tick chance to actually fire (keeps it human-ish)
const BOT_MISSILE_RANGE = 900;     // launch a missile when locked-ish within this
const BOT_MISSILE_COOLDOWN = 7.5;  // seconds between a bot's missiles (on top of the room's own cap)
const BOT_MISSILE_CHANCE = 0.02;   // low per-tick chance so missiles are an occasional spike
const BOT_BOOST_RANGE = 520;       // boost to close the gap when the target is beyond this
const BOT_ENGAGE_RANGE = 1400;     // beyond this a bot regroups toward the objective instead of dogfighting
const BOT_REACT_JITTER = 0.16;     // steering imperfection so aim isn't robotic/pinpoint
const BOT_RETARGET_SEC = 1.1;      // how often a bot re-evaluates its target/intent

export class DemoBots {
  constructor(room) {
    this.room = room;
    this.enabled = false;
    this._timers = [];          // setTimeout handles for staggered join/ready (cleared on teardown)
    this._botSeq = 0;
    this._bots = new Map();     // sessionId -> per-bot AI scratch
    this._started = false;      // guards against double-arming
  }

  // Kick off the staggered join/ready sequence. Called once when the human host opens a CTC lobby.
  arm() {
    if (this._started) return;
    this._started = true;
    this.enabled = true;
    const plan = [];
    for (let i = 0; i < BLUE_BOTS; i++) plan.push({ team: 0, hull: BLUE_HULLS[i % BLUE_HULLS.length], name: (BLUE_NAMES[i] || 'BLUE ' + i).trim() });
    for (let i = 0; i < RED_BOTS; i++) plan.push({ team: 1, hull: RED_HULLS[i % RED_HULLS.length], name: (RED_NAMES[i] || 'RED ' + i).trim() });
    // Interleave blue/red joins so both squadrons fill in together rather than one wall then the other.
    plan.sort(() => Math.random() - 0.5);
    const n = plan.length;
    plan.forEach((spec, idx) => {
      const at = JOIN_FIRST_MS + Math.round((idx / Math.max(1, n - 1)) * (JOIN_WINDOW_MS - JOIN_FIRST_MS));
      this._timers.push(setTimeout(() => this._spawnBot(spec), at));
    });
  }

  // Are there any bots in the room right now?
  hasBots() { return this._bots.size > 0; }
  isBot(sessionId) { return this._bots.has(sessionId); }

  // Create one bot ship + sim scratch (mirrors ArenaRoom.onJoin for a real client, minus networking).
  _spawnBot(spec) {
    const room = this.room;
    if (!this.enabled || !room || room.state.matchState !== 'lobby') return;   // lobby only
    const sid = 'bot:' + (++this._botSeq);
    const st = statsFor(spec.hull);
    const ship = new Ship();
    ship.name = spec.name;
    ship.team = spec.team;
    ship.ship = spec.hull;
    ship.rankScore = 200 + Math.floor(Math.random() * 4000);   // varied insignia in the lobby
    ship.pioneer = false;
    const maxHull = 100 * st.hull;
    const maxShields = 100 * st.shield;
    ship.hull = maxHull;
    ship.shields = maxShields;
    ship.maxMissiles = st.missiles || 4;
    ship.missiles = ship.maxMissiles;
    ship.ready = false;   // stays unready until its own staggered ready-up fires
    // Seat at the team spawn anchor nosed at the enemy (same convention as a real join).
    const sp = room.spawnAnchor(spec.team);
    ship.px = sp.x; ship.py = sp.y; ship.pz = sp.z;
    const q = yawQuatToward({ x: sp.x, y: sp.y, z: sp.z }, room.enemyAnchor(spec.team));
    ship.qx = q.x; ship.qy = q.y; ship.qz = q.z; ship.qw = q.w;
    room.state.ships.set(sid, ship);
    if (spec.team === 0) room.state.blueCount++; else room.state.redCount++;

    room.sim.set(sid, {
      pos: { x: ship.px, y: ship.py, z: ship.pz },
      vel: { x: 0, y: 0, z: 0 },
      quat: { x: ship.qx, y: ship.qy, z: ship.qz, w: ship.qw },
      inputs: [], lastSeq: 0,
      lastSeen: room._now,   // refreshed each tick in update() so the ghost-reaper never evicts a bot
      fireCd: 0, missileCd: 0, lastHitAt: -999, respawnAt: 0, killStreak: 0,
      history: [], rtt: 0, _probe: null, _nextProbeAt: 0,
      maxHull, maxShields, maxMissiles: ship.maxMissiles,
      firepower: st.firepower, speed: st.speed,
      lastInput: { seq: 0, steerX: 0, steerY: 0, roll: 0, thrust: false, reverse: false, boost: false },
      _bot: true,
    });

    // Per-bot AI scratch (server-only).
    this._bots.set(sid, {
      team: spec.team,
      targetId: null,
      retargetAt: 0,
      botMissileCd: BOT_MISSILE_COOLDOWN * Math.random(),
      wanderPhase: Math.random() * Math.PI * 2,
      jitterX: 0, jitterY: 0, jitterAt: 0,
    });

    // Staggered ready-up: this bot checks in a beat after it joins (plus jitter) so the lobby ready
    // pips fill one-by-one, never all at once.
    const readyDelay = READY_AFTER_JOIN_MS + Math.random() * READY_JITTER_MS;
    this._timers.push(setTimeout(() => {
      const sh = room.state.ships.get(sid);
      if (sh && room.state.matchState === 'lobby') sh.ready = true;
    }, readyDelay));
  }

  // Per-tick AI: called from ArenaRoom.tick() BEFORE the movement integrator consumes s.inputs, so
  // the input we stamp here is the one integrated this tick. Only steers LIVE bots during a live
  // match; in the lobby/ended states bots simply idle at their anchor.
  update(dt) {
    const room = this.room;
    if (!this.enabled || !this._bots.size) return;
    const live = room.state.matchState === 'live';
    for (const [sid, ai] of this._bots) {
      const s = room.sim.get(sid);
      const ship = room.state.ships.get(sid);
      if (!s || !ship) { this._bots.delete(sid); continue; }
      s.lastSeen = room._now;   // keep the ghost-reaper off the bots
      if (!live || !ship.alive) {
        // Hold station (idle input) while dead/in lobby; the integrator will bleed velocity to rest.
        s.lastInput = { seq: 0, steerX: 0, steerY: 0, roll: 0, thrust: false, reverse: false, boost: false };
        continue;
      }
      this._think(sid, ai, s, ship, dt);
    }
  }

  // Decide this bot's intent and stamp a fresh input frame for the integrator to apply this tick.
  _think(sid, ai, s, ship, dt) {
    const room = this.room;
    // Occasionally re-evaluate the tactical target so behavior isn't perfectly steady.
    if (room._now >= ai.retargetAt) {
      ai.retargetAt = room._now + BOT_RETARGET_SEC * (0.7 + Math.random() * 0.6);
      ai.targetId = this._pickIntent(sid, ai, s, ship);
    }
    // Refresh aim jitter a few times a second so steering has human-like imperfection.
    if (room._now >= ai.jitterAt) {
      ai.jitterAt = room._now + 0.18;
      ai.jitterX = (Math.random() * 2 - 1) * BOT_REACT_JITTER;
      ai.jitterY = (Math.random() * 2 - 1) * BOT_REACT_JITTER;
    }

    // Resolve a world-space GOAL point to fly toward + whether it's a ship to shoot.
    const goal = this._goalPoint(sid, ai, s, ship);
    const input = this._steerToward(s, goal.x, goal.y, goal.z, ai);

    // Boost to close big gaps (or run the flag home) — but not while lined up for a close shot.
    input.boost = goal.dist > BOT_BOOST_RANGE && !goal.shoot;

    // Fire control: bolts when a hostile is close and roughly ahead; the odd missile at mid range.
    if (goal.shoot && goal.targetShip) {
      const fwd = forwardFromQuat(s.quat);
      const dx = goal.targetShip.px - s.pos.x, dy = goal.targetShip.py - s.pos.y, dz = goal.targetShip.pz - s.pos.z;
      const range = Math.hypot(dx, dy, dz) || 1;
      const dot = (fwd.x * dx + fwd.y * dy + fwd.z * dz) / range;
      if (range < BOT_FIRE_RANGE && dot > BOT_FIRE_CONE && Math.random() < BOT_FIRE_CHANCE) {
        room.tryFire(sid);
      }
      if (ai.botMissileCd > 0) ai.botMissileCd -= dt;
      if (ai.botMissileCd <= 0 && range < BOT_MISSILE_RANGE && dot > 0.9 && Math.random() < BOT_MISSILE_CHANCE) {
        room.tryFireMissile(sid, goal.targetId);
        ai.botMissileCd = BOT_MISSILE_COOLDOWN;
      }
    }

    s.inputs.length = 0;         // bots don't queue; a single fresh intent per tick
    s.lastInput = input;
  }

  // Choose this bot's high-level intent target sessionId (the ship it cares about most right now).
  // Priorities that make the SHOW: contest/return the flag, gang the human flag-carrier, otherwise
  // dogfight the nearest hostile. Returns a sessionId (may be a bot, the human, or '' for none).
  _pickIntent(sid, ai, s, ship) {
    const room = this.room;
    const team = ship.team;
    const flag = room.state.cargo && room.state.cargo.get('flag');
    // If a bot on THIS team is closer to a loose flag, let the closest chase it; but any bot may go.
    if (flag) {
      // Human (or anyone) carrying the flag: the enemy team converges on the carrier for the show.
      if (flag.carrier) {
        const carrier = room.state.ships.get(flag.carrier);
        if (carrier && carrier.alive) {
          if (carrier.team !== team) return flag.carrier;   // enemy carrier -> intercept them
          // Friendly carrier -> escort by engaging the nearest THREAT to them instead of the carrier.
          const threat = this._nearestHostileTo(carrier, team);
          if (threat) return threat;
        }
      }
    }
    // Default: dogfight the nearest live hostile.
    return this._nearestHostile(s, team) || '';
  }

  // Resolve the concrete world GOAL point to fly at this tick, plus whether we should be shooting the
  // target ship. This is where "carry the flag home" and "grab a loose flag" become movement.
  _goalPoint(sid, ai, s, ship) {
    const room = this.room;
    const team = ship.team;
    const flag = room.state.cargo && room.state.cargo.get('flag');

    // 1) I'M carrying the flag -> run it to my own base (drive the capture for a lively match).
    if (ship.carrying) {
      const home = room.baseCenter(team);
      return { x: home.x, y: home.y, z: home.z, dist: this._dist(s.pos, home), shoot: false, targetShip: null, targetId: '' };
    }

    // 2) A LOOSE / centered flag with no carrier -> the nearest couple of bots make a run at it, so
    // the flag is always contested (the human always has action). Only chase if reasonably close or
    // I'm among the closest on my team, to avoid the whole squad swarming one pod.
    if (flag && !flag.carrier) {
      const fp = { x: flag.px, y: flag.py, z: flag.pz };
      const myD = this._dist(s.pos, fp);
      if (myD < 700 || this._amClosestFew(sid, team, fp, 2)) {
        return { x: fp.x, y: fp.y, z: fp.z, dist: myD, shoot: false, targetShip: null, targetId: '' };
      }
    }

    // 3) Otherwise pursue the tactical target (an enemy to dogfight, or an enemy flag-carrier to gang).
    const tid = ai.targetId;
    const tgt = tid && room.state.ships.get(tid);
    if (tgt && tgt.alive) {
      const tp = { x: tgt.px, y: tgt.py, z: tgt.pz };
      const d = this._dist(s.pos, tp);
      if (d < BOT_ENGAGE_RANGE) {
        return { x: tp.x, y: tp.y, z: tp.z, dist: d, shoot: tgt.team !== team, targetShip: tgt, targetId: tid };
      }
    }

    // 4) Nothing pressing -> loosely orbit the flag/center so the action stays near the objective.
    const c = flag ? { x: flag.px, y: flag.py, z: flag.pz } : { x: 0, y: 0, z: 0 };
    ai.wanderPhase += dtSafe(0.4);
    const R = 260;
    const gx = c.x + Math.cos(ai.wanderPhase) * R;
    const gz = c.z + Math.sin(ai.wanderPhase) * R;
    const gy = c.y + Math.sin(ai.wanderPhase * 0.5) * 80;
    return { x: gx, y: gy, z: gz, dist: this._dist(s.pos, { x: gx, y: gy, z: gz }), shoot: false, targetShip: null, targetId: '' };
  }

  // Build a steering input frame that points the ship's nose toward (tx,ty,tz). Converts the bearing
  // error into steerX/steerY offsets (the same intent a mouse produces), clamped to the flight model
  // range, plus a little jitter so aim isn't robotic. Always thrusts (a fighter that stops is a
  // sitting duck); reverses only if it badly overshoots straight ahead is unnecessary for the show.
  _steerToward(s, tx, ty, tz, ai) {
    const fwd = forwardFromQuat(s.quat);
    // Vector to goal in world space.
    let dx = tx - s.pos.x, dy = ty - s.pos.y, dz = tz - s.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    dx /= d; dy /= d; dz /= d;
    // Build the ship's local axes from the quaternion to project the goal into local (right/up/fwd).
    const right = quatRight(s.quat);
    const up = quatUp(s.quat);
    const fdot = dx * fwd.x + dy * fwd.y + dz * fwd.z;      // 1 = dead ahead, -1 = behind
    const rdot = dx * right.x + dy * right.y + dz * right.z; // + = goal to the right
    const udot = dx * up.x + dy * up.y + dz * up.z;          // + = goal above
    // Map bearing error to steering offsets. steerX yaws toward the goal's left/right; steerY pitches.
    // A gain > 1 with clamping gives a snappy but bounded turn. Sign matches stepShip's mapping
    // (pitchRate = -steerY*TURN, yawRate = -steerX*TURN): to yaw RIGHT toward a right-side goal we
    // need a negative steerX, so steerX = -rdot*gain; to pitch UP toward a high goal, steerY = -udot.
    const gain = 2.2;
    let steerX = clamp(-rdot * gain + ai.jitterX, -1.4, 1.4);
    let steerY = clamp(-udot * gain + ai.jitterY, -1.4, 1.4);
    // If the goal is roughly behind, hard-bank into the turn so the bot swings around instead of
    // dithering with tiny offsets near the singular "straight back" bearing.
    if (fdot < -0.2) { steerX = clamp(steerX * 1.6 + (steerX >= 0 ? 0.5 : -0.5), -1.4, 1.4); }
    const roll = clamp(-rdot * 0.7, -1, 1);   // bank into turns for a natural look
    return { seq: 0, steerX, steerY, roll, thrust: true, reverse: false, boost: false };
  }

  // --- small helpers -------------------------------------------------------------------------
  _dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

  _nearestHostile(s, team) {
    const room = this.room;
    let best = '', bestD = Infinity;
    for (const [id, sh] of room.state.ships) {
      if (!sh.alive || sh.team === team) continue;
      const d = this._dist(s.pos, { x: sh.px, y: sh.py, z: sh.pz });
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  _nearestHostileTo(shipObj, team) {
    const room = this.room;
    let best = '', bestD = Infinity;
    for (const [id, sh] of room.state.ships) {
      if (!sh.alive || sh.team === team) continue;
      const d = this._dist({ x: shipObj.px, y: shipObj.py, z: shipObj.pz }, { x: sh.px, y: sh.py, z: sh.pz });
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  // True if `sid` is among the `k` closest bots on its team to point `p` (so only a couple of bots
  // break off for a loose flag, not the whole squadron).
  _amClosestFew(sid, team, p, k) {
    const room = this.room;
    const s = room.sim.get(sid);
    if (!s) return false;
    const myD = this._dist(s.pos, p);
    let closer = 0;
    for (const [id, ai] of this._bots) {
      if (id === sid || ai.team !== team) continue;
      const os = room.sim.get(id);
      const osh = room.state.ships.get(id);
      if (!os || !osh || !osh.alive) continue;
      if (this._dist(os.pos, p) < myD) closer++;
    }
    return closer < k;
  }

  // Remove all bots (ships + sim + AI) and cancel any pending join/ready timers. Called on teardown /
  // disable so the room returns to a pure human state cleanly.
  clear() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.length = 0;
    for (const sid of [...this._bots.keys()]) {
      try { this.room.removeShip(sid); } catch {}
      this._bots.delete(sid);
    }
    this.enabled = false;
    this._started = false;
  }
}

// --- module-local math (no THREE dependency) --------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dtSafe() { return 1 / 30; }   // fixed tick step for wander phase advance

// Ship-local RIGHT axis (+X) from a quaternion.
function quatRight(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return {
    x: 1 - 2 * (y * y + z * z),
    y: 2 * (x * y + w * z),
    z: 2 * (x * z - w * y),
  };
}
// Ship-local UP axis (+Y) from a quaternion.
function quatUp(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return {
    x: 2 * (x * y - w * z),
    y: 1 - 2 * (x * x + z * z),
    z: 2 * (y * z + w * x),
  };
}
