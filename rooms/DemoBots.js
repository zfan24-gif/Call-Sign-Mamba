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
import { stepShip, forwardFromQuat, yawQuatToward, FLIGHT } from '../shared/flightModel.js';
import { statsFor } from './shipStats.js';

// Max yaw/pitch rate (rad/s) at full deflection — the number the turn-radius governor divides speed
// by to know how tightly a bot can corner at its current velocity. Sourced from the shared model so
// it always tracks the real flight physics.
const FLIGHT_TURN = FLIGHT.TURN;

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

// --- AI tuning (assertive but still beatable) -------------------------------------------------
// Dialed UP from the old "video-grade, deliberately timid" values: bots now shoot more often, from a
// slightly wider cone and longer range, throw more missiles, and commit harder to the objective — so
// CTC actually feels contested. Aim jitter (below) is what keeps them beatable: they miss enough that
// a competent human wins, but they land real hits and press the pod instead of loitering.
const BOT_FIRE_RANGE = 420;        // only shoot when the target is within this and roughly ahead
const BOT_FIRE_CONE = 0.94;        // dot(nose, toTarget) must exceed this to pull the trigger (wider = more shots)
const BOT_FIRE_CHANCE = 0.82;      // per-eligible-tick chance to actually fire (was 0.55 — far more trigger pulls)
const BOT_MISSILE_RANGE = 1050;    // launch a missile when locked-ish within this
const BOT_MISSILE_COOLDOWN = 5.0;  // seconds between a bot's missiles (on top of the room's own cap)
const BOT_MISSILE_CHANCE = 0.05;   // per-tick chance a missile spikes out (was 0.02)
const BOT_BOOST_RANGE = 460;       // boost to close the gap when the target is beyond this (closes sooner)
const BOT_ENGAGE_RANGE = 1400;     // beyond this a bot regroups toward the objective instead of dogfighting
const BOT_REACT_JITTER = 0.05;     // steering imperfection so aim isn't robotic. Bumped up to keep the now
                                   // more-accurate/aggressive bots BEATABLE — this is the main difficulty
                                   // dial. Small enough that bots still hold a clean line to the goal, big
                                   // enough that their bolts scatter and a sharp human can out-fly them.
const BOT_RETARGET_SEC = 0.8;      // how often a bot re-evaluates its target/intent (snappier reactions)

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
      role: 'contest',       // cargo-centric role this bot is currently playing (see _assignRole)
      targetId: null,        // the ship this role wants to engage/escort ('' = none, fly the objective)
      retargetAt: 0,
      botMissileCd: BOT_MISSILE_COOLDOWN * Math.random(),
      // A stable per-bot angular slot so escorts/attackers fan out AROUND their objective instead of
      // stacking on the same point (reads like a squad spreading out, not a conga line).
      slot: Math.random() * Math.PI * 2,
      // A FIXED per-bot fan angle for the loose-pod approach so a contesting bot commits to ONE
      // stable approach vector into the pod (a moving offset would make it gently orbit the pod).
      fanAngle: Math.random() * Math.PI * 2,
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
    // Occasionally re-evaluate our cargo-centric ROLE + engagement target so behavior isn't perfectly
    // steady (and so the squad re-forms around the flag as it changes hands).
    if (room._now >= ai.retargetAt) {
      ai.retargetAt = room._now + BOT_RETARGET_SEC * (0.7 + Math.random() * 0.6);
      this._assignRole(sid, ai, s, ship);
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
    const aligned = input._fdot;   // 1 = goal dead ahead, <0 = behind us (overshot)

    // THROTTLE / BOOST control. Default: boost only to close big gaps, and NOT while lined up for a
    // close shot (so a dogfighter doesn't overshoot its target). EXCEPTION: when hunting/escorting a
    // flag CARRIER we boost even at range so pursuers can actually run down a boosting carrier —
    // otherwise the carrier just outruns everyone and it stops looking like a real chase.
    const chasingCarrier = goal.chase && goal.dist > BOT_BOOST_RANGE;
    // A carrying bot boosts nearly the whole way home (until it's basically at the base) so a capture
    // run has real urgency; otherwise boost only to close big gaps and not while lined up for a shot.
    const runningHome = goal.runHome && goal.dist > 120;
    input.boost = (runningHome || chasingCarrier || (goal.dist > BOT_BOOST_RANGE && !goal.shoot)) && !goal.precision;

    // ---- THROTTLE GOVERNOR (loop prevention) ----------------------------------------------------
    // ROOT CAUSE of the wide loops: a fighter at full speed (74 u/s, turn rate 2.6 rad/s) has a
    // MINIMUM TURN RADIUS of ~28u. Carry that speed into a close goal and NO amount of steering can
    // curve onto it — the bot arcs past and loops back, forever. The old governors gated braking on a
    // hard ANGLE threshold, which missed bots arcing wide at moderate bearings. The block below instead
    // derives a CONTINUOUS cornering speed from the geometry (distance + how sharply we must turn) and
    // eases throttle toward it, so bots smoothly slow into every goal and pull a tight, deliberate turn.
    const d = goal.dist;
    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    const bearingErr = Math.max(0, 1 - aligned);            // 0 = dead ahead, up to 2 = dead behind
    if (goal.precision) {
      // Pod grab: decelerate INTO the pickup window so the bot settles ON the pod instead of blowing
      // past it. Speed target ramps down with distance; floor kept decisive (not a crawl) so it reads
      // as a committed snatch. Far out we run fast to close; inside ~380u we bleed toward ~24 u/s.
      input.boost = false;
      const targetSpeed = d > 380 ? 88 : (24 + (d / 380) * 64);
      if (speed > targetSpeed + 12) { input.thrust = false; input.reverse = speed > targetSpeed + 45; }
      else { input.thrust = true; input.reverse = false; }
    } else {
      // ---- SPEED-MATCHED-TO-CORNER GOVERNOR -----------------------------------------------------
      // The loops come from carrying too much speed INTO a close goal: a fighter's turn radius is
      // r = v/omega, so to actually curve onto a point `d` away while needing to turn through bearing
      // error `bearingErr`, the bot must already be slow enough that its turn radius fits well inside
      // that distance. Rather than an on/off brake (which let bots coast wide at moderate bearings), we
      // compute a CONTINUOUS target speed from the geometry and drive throttle/brake toward it. This
      // makes bots ease off the gas smoothly as they close on any goal and pull a tight, deliberate
      // turn-in — objective-driven flight, not lazy orbits.
      //
      // Max cornering speed at this distance/bearing: vMax = (d / needFactor) * omega. A dead-ahead
      // goal (bearingErr~0) needs almost no turn so vMax stays high (fly straight in); a side/behind
      // goal forces vMax low so the bot slows and turns onto it. Clamped to the hull's sane band.
      const needFactor = 1.4 + bearingErr * 2.4;             // sharper required turn -> demand more room
      let vMax = (d / needFactor) * FLIGHT_TURN;
      vMax = clamp(vMax, 20, 999);                           // never demand a full stop; keep it flying
      if (speed > vMax + 16) {
        // Well over the cornering speed: coast (drag scrubs it) or hard-brake if badly off-line and
        // really barreling in, so the turn radius collapses inside the goal distance fast.
        input.thrust = false;
        input.reverse = (bearingErr > 0.5 && speed > vMax + 40);
        input.boost = false;
      } else if (speed > vMax) {
        // Just over: coast down gently, don't brake — keeps momentum while the radius settles.
        input.thrust = false;
      }
      // else at/under cornering speed: keep the default thrust (+ any boost) and bear down on the goal.
    }

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

  // CARGO-CENTRIC role assignment — this is what makes every bot look like it understands the
  // objective. There is ALWAYS a cargo (CTC), so every bot is always doing one of exactly three
  // objective jobs; there is NO free-roam dogfight state that let them wander off in circles:
  //
  //   • flag has NO carrier (loose/at center): the ~3 closest bots on the team RACE to grab it
  //     (role 'grab'); the rest press toward the pod to be first on the rebound (role 'contest').
  //   • an ENEMY (bot or the human) carries it: EVERY hostile HUNTS the carrier (role 'hunt',
  //     target = carrier); the carrier's own team ESCORTS it (role 'escort', target = carrier).
  //   • a FRIENDLY (bot or the human) carries it: I ESCORT the carrier (role 'escort'); the other
  //     team hunts. If I somehow am not on either objective, I still fly the pod.
  //
  // The role also carries the engagement target so _think knows who to shoot. Result: the flag is the
  // gravity well of the match — exactly the "everyone's going for / defending / attacking the cargo"
  // read you want, and the human is always surrounded by pilots who clearly care about the pod.
  // The cargo object this bot should treat as its objective this tick. In CTC there is one neutral
  // 'flag'. In CDD there are TWO team disks: a bot's team STEALS the enemy disk and DEFENDS its own.
  // Priority: if OUR disk has been stolen/knocked loose, that's the emergency (defend/recover it);
  // otherwise go after the ENEMY disk (steal it). This lets the shared role logic below stay intact.
  _objectiveFlag(team) {
    const room = this.room;
    const cargo = room.state.cargo;
    if (!cargo) return null;
    if (!room.isCDD || !room.isCDD()) return cargo.get('flag');
    const ownKey = team === 0 ? 'blueDisk' : 'redDisk';
    const enemyKey = team === 0 ? 'redDisk' : 'blueDisk';
    const own = cargo.get(ownKey), enemy = cargo.get(enemyKey);
    // Our disk in enemy hands or adrift -> make recovering it the priority objective.
    if (own && (own.carrier || !own.atHome)) return own;
    // Otherwise focus the enemy disk (steal it / hunt whoever grabbed it).
    return enemy || own || null;
  }

  _assignRole(sid, ai, s, ship) {
    const room = this.room;
    const team = ship.team;
    const flag = this._objectiveFlag(team);

    // I'm the carrier: my role is fixed (run it home) — handled in _goalPoint, but note it here.
    if (ship.carrying) { ai.role = 'carry'; ai.targetId = ''; return; }

    if (flag && flag.carrier) {
      const carrier = room.state.ships.get(flag.carrier);
      if (carrier && carrier.alive) {
        if (carrier.team !== team) {
          // Enemy has the pod -> HUNT the carrier (this is the "gang the flag-runner" show). Aim at
          // the carrier itself so bolts/missiles go at the pod runner, not a random dogfight.
          ai.role = 'hunt'; ai.targetId = flag.carrier; return;
        }
        // Teammate has the pod -> ESCORT: stay on the carrier and shoot whoever is chasing them.
        ai.role = 'escort'; ai.targetId = flag.carrier;
        // Prefer to actually FIRE at the nearest threat to the carrier if there is one in range.
        const threat = this._nearestHostileTo(carrier, team);
        if (threat) ai.escortThreat = threat; else ai.escortThreat = '';
        return;
      }
    }

    // No carrier -> contest the loose/center pod. A healthy chunk of each team actually goes for the
    // grab (so the pod is genuinely fought over and someone reliably picks it up), and the rest stage
    // nearby so both squadrons swarm the objective and the human always has bodies around it.
    if (flag) {
      const fp = { x: flag.px, y: flag.py, z: flag.pz };
      // STICKY final approach: once I'm inside 170u of a loose pod I stay committed to the grab even
      // if a teammate momentarily edges closer — otherwise a role flip mid-pocket jerks my goal point
      // and I peel off into exactly the loop we're trying to kill. Finish the run.
      const nearPod = this._dist(s.pos, fp) < 170;
      ai.role = (nearPod || this._amClosestFew(sid, team, fp, 6)) ? 'grab' : 'contest';   // most of the team commits to the grab run
      // While contesting, a bot still shoots any enemy that strays close to it near the pod.
      ai.targetId = this._nearestHostile(s, team) || '';
      return;
    }

    // No flag object at all (shouldn't happen in a live CTC match) -> just fly the center and fight.
    ai.role = 'contest';
    ai.targetId = this._nearestHostile(s, team) || '';
  }

  // Resolve the concrete world GOAL point to fly at this tick from the assigned role, plus whether we
  // should be shooting a specific ship. Every branch is tied to the CARGO, so bots always look like
  // they're playing the objective.
  _goalPoint(sid, ai, s, ship) {
    const room = this.room;
    const team = ship.team;
    const flag = this._objectiveFlag(team);

    // CARRY: I have the pod/disk -> beeline HARD for the score point (this is what captures). In CTC
    // that's my base center; in CDD it's my OWN disk's capture spot (return the enemy disk to it).
    // `runHome` tells _think to hold boost the whole way so a carrying bot drives for the score with
    // real urgency instead of ambling home — the human has to actively intercept it.
    if (ship.carrying) {
      const home = (room.isCDD && room.isCDD()) ? room.diskHome(team) : room.baseCenter(team);
      return { x: home.x, y: home.y, z: home.z, dist: this._dist(s.pos, home), shoot: false, targetShip: null, targetId: '', runHome: true };
    }

    // HUNT: an enemy carries the pod -> chase the carrier with a small LEAD so it looks like a real
    // intercept, and shoot it whenever it's in front of us. This is the enemy team converging on the
    // human when the human has the flag.
    if (ai.role === 'hunt') {
      const carrier = ai.targetId && room.state.ships.get(ai.targetId);
      if (carrier && carrier.alive && carrier.carrying) {
        const d = this._dist(s.pos, { x: carrier.px, y: carrier.py, z: carrier.pz });
        // Aim for a PURSUIT SLOT, not the carrier's body. Far out we lead its motion to cut it off on
        // an intercept line; once we're close we aim for a point trailing just behind it along its
        // heading (its six o'clock) so we SETTLE onto its tail and hold a firing line — instead of
        // flying into it and looping past. This is the single biggest anti-loop fix for the chase.
        const aim = this._pursuitPoint(s, carrier, d);
        return { x: aim.x, y: aim.y, z: aim.z, dist: d, shoot: true, targetShip: carrier, targetId: ai.targetId, chase: true };
      }
      // Carrier gone/dropped it since we last retargeted -> fall through to contest the loose pod.
    }

    // ESCORT: a teammate (or the human ally) carries the pod -> fly a slot NEAR the carrier so we
    // screen it, and shoot the nearest chaser. This is the allies-protect-the-carrier show.
    if (ai.role === 'escort') {
      const carrier = ai.targetId && room.state.ships.get(ai.targetId);
      if (carrier && carrier.alive && carrier.carrying) {
        // If there's a threat chasing the carrier, peel off and gun it; otherwise ride formation.
        const threat = ai.escortThreat && room.state.ships.get(ai.escortThreat);
        if (threat && threat.alive) {
          const lead = this._leadPoint(s, threat, 0.4);
          const d = this._dist(s.pos, { x: threat.px, y: threat.py, z: threat.pz });
          return { x: lead.x, y: lead.y, z: lead.z, dist: d, shoot: true, targetShip: threat, targetId: ai.escortThreat };
        }
        // No immediate threat -> screen the carrier by flying to a point just BEHIND/beside it along
        // its own heading (a wing position that moves WITH the carrier), rather than orbiting a fixed
        // slot the escort can never settle on. Because the anchor tracks the carrier's motion, the
        // escort flies a real formation line instead of corkscrewing.
        const cvx = carrier.vx || 0, cvy = carrier.vy || 0, cvz = carrier.vz || 0;
        const cs = Math.hypot(cvx, cvy, cvz) || 1;
        // Unit heading of the carrier; drop back ~70u and fan ~55u to the side per this bot's slot.
        const bx = -cvx / cs, by = -cvy / cs, bz = -cvz / cs;
        const side = Math.cos(ai.slot);   // -1..1 spread so escorts sit on alternating flanks
        const wx = carrier.px + bx * 70 + side * 55;
        const wy = carrier.py + by * 70;
        const wz = carrier.pz + bz * 70 + Math.sin(ai.slot) * 55;
        return { x: wx, y: wy, z: wz, dist: this._dist(s.pos, { x: wx, y: wy, z: wz }), shoot: false, targetShip: null, targetId: '' };
      }
      // Carrier gone -> fall through to contest the loose pod.
    }

    // LOOSE POD (grab OR contest): EVERY bot flies STRAIGHT AT THE POD to pick it up. There is no
    // "stage on a slot far from the pod and orbit it" behavior anymore — that fixed-offset staging is
    // exactly what made most bots loiter and corkscrew right next to the objective instead of taking
    // it. Now the pod is the goal for the whole team, so it gets genuinely swarmed and grabbed fast.
    //
    // A tiny per-bot offset (from the persistent `slot` angle) fans the approach vectors so the pack
    // doesn't collapse onto one identical point and collide; it's small (18u) so bots still converge
    // on the pod, not on a ring around it. `precision` brakes the final approach into the 22u pickup
    // window; `grab` marks the committed grabbers so _think lines them up before feathering in.
    if (flag && !flag.carrier) {
      const off = ai.role === 'grab' ? 0 : 18;   // committed grabbers aim dead-center; others fan slightly
      const ang = ai.fanAngle;   // FIXED per-bot angle -> a stable approach vector, not a drifting orbit
      const gx = flag.px + Math.cos(ang) * off;
      const gy = flag.py + Math.sin(ang * 0.7) * off * 0.4;
      const gz = flag.pz + Math.sin(ang) * off;
      return { x: gx, y: gy, z: gz, dist: this._dist(s.pos, { x: flag.px, y: flag.py, z: flag.pz }), shoot: false, targetShip: null, targetId: '', precision: true, grab: ai.role === 'grab' };
    }

    // Absolute fallback (no flag object): press toward arena center so bots never drift off alone.
    return { x: 0, y: 0, z: 0, dist: this._dist(s.pos, { x: 0, y: 0, z: 0 }), shoot: false, targetShip: null, targetId: '' };
  }

  // A point LED slightly ahead of a moving target so a pursuer looks like it's intercepting, not tail-
  // chasing. `k` scales how far ahead we aim (seconds of the target's current velocity). Uses the
  // target's replicated velocity; a stationary target just returns its own position.
  _leadPoint(s, tgt, k) {
    const vx = tgt.vx || 0, vy = tgt.vy || 0, vz = tgt.vz || 0;
    return { x: tgt.px + vx * k, y: tgt.py + vy * k, z: tgt.pz + vz * k };
  }

  // A PURSUIT-CURVE aim point that makes a chaser settle onto the target's SIX rather than fly into
  // it and loop. Blends two behaviors by range `d`:
  //   • FAR (d > ~260): lead the target's motion so we cut it off on an intercept line (close the gap).
  //   • CLOSE: aim for a point trailing ~65u BEHIND the target along its heading — its six o'clock — so
  //     we slide into a firing slot and hold station on its tail instead of ramming through it.
  // If the target is nearly stationary its heading is undefined, so we just aim slightly short of it.
  _pursuitPoint(s, tgt, d) {
    const vx = tgt.vx || 0, vy = tgt.vy || 0, vz = tgt.vz || 0;
    const spd = Math.hypot(vx, vy, vz);
    if (d > 260) {
      // Intercept lead scales gently with range so distant chases cut a strong angle without wildly
      // over-leading a slow target.
      const k = clamp(d / 400, 0.5, 1.1);
      return { x: tgt.px + vx * k, y: tgt.py + vy * k, z: tgt.pz + vz * k };
    }
    if (spd < 6) {
      // Target barely moving: aim just short of it so we decelerate onto it rather than through it.
      const bx = s.pos.x - tgt.px, by = s.pos.y - tgt.py, bz = s.pos.z - tgt.pz;
      const bl = Math.hypot(bx, by, bz) || 1;
      return { x: tgt.px + (bx / bl) * 45, y: tgt.py + (by / bl) * 45, z: tgt.pz + (bz / bl) * 45 };
    }
    // Trail point: back down the target's heading by ~65u (its six o'clock), plus a touch of lead so
    // we track a maneuvering target's tail rather than where it just was.
    const ux = vx / spd, uy = vy / spd, uz = vz / spd;
    const trail = 65;
    return {
      x: tgt.px - ux * trail + vx * 0.25,
      y: tgt.py - uy * trail + vy * 0.25,
      z: tgt.pz - uz * trail + vz * 0.25,
    };
  }

  // Build a steering input frame that points the ship's nose toward (tx,ty,tz). Converts the bearing
  // error into steerX/steerY offsets (the same intent a mouse produces), clamped to the flight model
  // range, plus a little jitter so aim isn't robotic. Always thrusts (a fighter that stops is a
  // sitting duck); reverses only if it badly overshoots straight ahead is unnecessary for the show.
  _steerToward(s, tx, ty, tz, ai) {
    const fwd = forwardFromQuat(s.quat);
    // Unit vector to the goal in world space.
    let dx = tx - s.pos.x, dy = ty - s.pos.y, dz = tz - s.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    dx /= d; dy /= d; dz /= d;
    // Ship-local axes so we can express the goal bearing as left/right + up/down error.
    const right = quatRight(s.quat);
    const up = quatUp(s.quat);
    const fdot = dx * fwd.x + dy * fwd.y + dz * fwd.z;       // 1 = dead ahead, -1 = behind
    const rdot = dx * right.x + dy * right.y + dz * right.z; // + = goal to the right
    const udot = dx * up.x + dy * up.y + dz * up.z;          // + = goal above/below

    // Convert the bearing error into an ANGLE-proportional turn command, not a saturating one. rdot/
    // udot are the sines of the horizontal/vertical bearing error; using them directly (times a
    // modest gain) means a nose that's nearly on-target commands a SMALL deflection and the ship
    // flies straight, while a wide bearing commands a firm — but not pinned — turn. This is the fix
    // for the "endless barrel roll": the old code saturated steerX/steerY to full deflection for any
    // error at all, so a bot could never settle wings-level on its target and just corkscrewed.
    // steer sign matches stepShip (yawRate = -steerX*TURN, pitchRate = -steerY*TURN): to yaw toward a
    // right-side goal we need negative steerX, hence -rdot; to pitch toward a high goal, -udot.
    // Drive the turn off the true bearing ANGLE, not its sine. rdot/udot are sines of the bearing
    // error, so at a 30-40 deg bearing they read only ~0.5-0.65 and the old gains produced a limp
    // half-deflection — the bot under-steered and arced wide (the "lazy loop"). Using atan2 against
    // the forward component gives the real angle, so a wide bearing commands a firm, proportional turn
    // that snaps the nose onto the goal, while a near-aligned nose still eases off and flies straight.
    const YAW_GAIN = 1.9;    // horizontal turn authority (per radian of horizontal bearing error)
    const PITCH_GAIN = 1.35; // vertical authority — still a touch gentler so turns read mostly in-plane
    const yawErr = Math.atan2(rdot, Math.max(1e-3, fdot));   // signed horizontal bearing angle (rad)
    const pitchErr = Math.atan2(udot, Math.max(1e-3, fdot)); // signed vertical bearing angle (rad)
    let steerX = -yawErr * YAW_GAIN + ai.jitterX;
    let steerY = -pitchErr * PITCH_GAIN + ai.jitterY;
    // Goal is behind us: atan2 already yaws the SHORT way around toward it (|yawErr| -> pi), so we no
    // longer force a synthetic yaw. We only SUPPRESS pitch so the bot swings around FLAT in the yaw
    // plane instead of pitching up and over the top into a loop — a coordinated flat turn reads far
    // more like a purposeful reversal onto the objective than a vertical barrel-roll.
    if (fdot < 0) steerY *= 0.3;
    // Allow a firm turn (up to the flight model's own ±1.4 steer range) so a bot can actually swing
    // its nose onto the pod on a close approach instead of arcing wide past it. The old ±1.0 cap left
    // bots under-steering near the objective, which read as a lazy loop.
    steerX = clamp(steerX, -1.4, 1.4);
    steerY = clamp(steerY, -1.1, 1.1);
    // Bank PROPORTIONALLY into the yaw for a natural coordinated turn — and only as much as we're
    // actually yawing. A constant/hard roll while also pitching is precisely what read as a barrel
    // roll; tying roll to the (bounded) yaw command keeps the wings level when flying straight.
    const roll = clamp(steerX * 0.5, -0.7, 0.7);
    // Return the alignment (fdot: 1 = goal dead ahead) so _think can gate throttle/braking on the
    // final precision approach to the pod (only bear down on the pickup window when actually lined up).
    return { seq: 0, steerX, steerY, roll, thrust: true, reverse: false, boost: false, _fdot: fdot };
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
