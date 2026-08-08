// ---- Colyseus schema: the authoritative, synced ARENA state ----------------------------------
// @colyseus/schema defines the state that Colyseus efficiently binary-diffs and streams to every
// client each patch. Only fields declared here are replicated. We keep it lean — position,
// orientation (quaternion), velocity, team, name, and the last input sequence the server processed
// (so the client can reconcile its prediction against server truth).
//
// We use the `defineTypes()` form (rather than TypeScript `@type` decorators) so this runs as plain
// ESM Node with no build step.
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
// (Cargo is declared below and referenced in ArenaState's cargo map.)

// One networked ship. `lastSeq` is the input frame number the server has applied for this player;
// the owning client uses it to discard already-acknowledged inputs and re-simulate the rest on top
// of the authoritative snapshot (client-side prediction reconciliation).
export class Ship extends Schema {
  constructor() {
    super();
    this.name = 'PILOT';
    this.team = 0;            // 0 = blue, 1 = red
    this.ship = 'lightning';  // playable hull id (see shipStats.js) — clients render the right model
    this.px = 0; this.py = 0; this.pz = 0;                 // position
    this.qx = 0; this.qy = 0; this.qz = 0; this.qw = 1;    // orientation quaternion
    this.vx = 0; this.vy = 0; this.vz = 0;                 // velocity (sent so clients can extrapolate)
    this.boost = false;      // for remote engine-trail intensity
    // True while the pilot is actively THRUSTING (forward or reverse) this tick. This is the
    // authoritative "engines are burning" signal for remote engine-trail length: a coasting/idle
    // ship (momentum only, no throttle) sets this false so observers show only a faint idle plume,
    // and it goes true the instant the pilot throttles up so the trail extends. Replaces the old
    // client-side accel guess, which read a fast COASTING ship as accelerating.
    this.thrusting = false;
    this.lastSeq = 0;        // last processed input sequence for this player
    // --- Combat (Phase 2) ---
    this.hull = 100;         // 0..100 hull integrity; 0 = destroyed
    this.shields = 100;      // 0..100 shield charge; regenerates, absorbs before hull
    this.alive = true;       // false during the death → respawn window
    this.respawnIn = 0;      // seconds remaining until respawn (replicated so the client can show a countdown / kill-cam timer); 0 while alive
    this.lastKiller = '';    // sessionId of the pilot who last destroyed this ship (for the client kill-cam framing)
    this.kills = 0;          // scoreboard
    this.deaths = 0;
    // --- Guided-missile loadout (authoritative ammo, replicated so the HUD reads server truth) ---
    this.missiles = 4;       // rounds currently in the rack; server decrements on fire, tops up on kill streak
    this.maxMissiles = 4;    // this hull's rack capacity (from shipStats); the streak reward can't exceed it
    // --- Voice comms (transport-agnostic PRESENCE only; the audio stream itself rides a separate
    //     WebRTC/SFU layer). These flags drive the speaking indicators + squad routing everywhere. ---
    this.speaking = false;   // true while this pilot holds push-to-talk (open mic)
    this.squad = false;      // true if this pilot has opted into SQUAD voice (talk only to same-team squad)
    // Microphone availability, replicated so every client can render the lobby mic icon correctly:
    //   0 = no working mic (permission denied, or voice audio unavailable) -> grayed mic w/ slash
    //   1 = mic available (granted + published) -> live mic icon, colored when `speaking`
    this.micState = 0;
    // --- Ranking / honor system (client-reported career progression) ---
    // `rankScore` is the pilot's blended lifetime advancement number (see client ranks.js:
    // kills + weighted wins + campaign). Replicated so EVERY client renders the correct rank
    // insignia next to this pilot's name in the lobby, live scoreboard, and match results. The
    // authoritative per-match kills still live in `kills`; this is the persistent career total.
    // `pioneer` flags a pre-launch "Pioneer Pilot" for the special honor color designation.
    this.rankScore = 0;
    this.pioneer = false;
    // --- Lobby ready-check ---
    // The pilot has armed READY in the lobby. The host may only start the match once EVERY pilot in
    // the room is ready. Replicated so every lobby shows each pilot's ready pip live. Reset to false
    // on join and after a match ends (back to the lobby), so a fresh ready-check runs each round.
    this.ready = false;
    // --- Capture the Cargo ---
    // True while THIS pilot is carrying an enemy cargo pod (the "flag"). Replicated so every client
    // can render the carried pod slung under the hull AND so the HUD emphasizes a carrier's targeting
    // brackets (a big deal: shoot the carrier down and the cargo drops). Only meaningful in CTC mode.
    this.carrying = false;
  }
}
defineTypes(Ship, {
  name: 'string',
  team: 'uint8',
  ship: 'string',
  px: 'float32', py: 'float32', pz: 'float32',
  qx: 'float32', qy: 'float32', qz: 'float32', qw: 'float32',
  vx: 'float32', vy: 'float32', vz: 'float32',
  boost: 'boolean',
  thrusting: 'boolean',
  lastSeq: 'uint32',
  hull: 'float32',
  shields: 'float32',
  alive: 'boolean',
  respawnIn: 'float32',
  lastKiller: 'string',
  kills: 'uint16',
  deaths: 'uint16',
  missiles: 'uint8',
  maxMissiles: 'uint8',
  speaking: 'boolean',
  squad: 'boolean',
  micState: 'uint8',
  rankScore: 'uint32',
  pioneer: 'boolean',
  ready: 'boolean',
  carrying: 'boolean',
});

// ---- Capture the Cargo: the SINGLE neutral cargo pod (the "flag") ------------------------------
// There is exactly ONE of these in CTC mode, keyed 'flag' in ArenaState.cargo, spawned dead-center
// between the two capital bases. It is NEUTRAL (team = 2): EITHER team can grab it. It starts "at
// home" at the arena center; a pilot who flies close enough picks it up (carrier set); while carried
// it rides on the carrier and streams that pilot's position. If the carrier is killed or leaves, the
// pod DROPS and floats in space until reclaimed by any pilot, or auto-returns to center after a
// timeout. A carrier who hauls it to their OWN base scores a capture and the pod resets to center.
export class Cargo extends Schema {
  constructor() {
    super();
    this.team = 2;            // CTC: 2 = NEUTRAL (contested). CDD: 0 = blue disk, 1 = red disk (the OWNING team).
    this.px = 0; this.py = 0; this.pz = 0;   // world position (home, dropped, or carrier-tracked)
    this.carrier = '';        // sessionId of the pilot carrying it ('' = loose or at home)
    this.atHome = true;       // true when resting at its home spot (not carried, not dropped adrift)
    this.modelIndex = 0;      // which container GLB variant to render (CTC only; CDD renders the fixed disk GLB)
    // --- Capture the Data Disk (CDD) only ---
    // Each disk has a FIXED home = the capture spot hovering above its owning team's capital. The
    // client renders a spinning disk marker there and needs the authoritative point, so we replicate
    // it (it never moves within a match). Unused/zero in CTC (the single pod's home is arena center).
    this.homeX = 0; this.homeY = 0; this.homeZ = 0;
  }
}
defineTypes(Cargo, {
  team: 'uint8',
  px: 'float32', py: 'float32', pz: 'float32',
  carrier: 'string',
  atHome: 'boolean',
  modelIndex: 'uint8',
  homeX: 'float32', homeY: 'float32', homeZ: 'float32',
});

// One networked laser bolt. Spawned authoritatively when a client sends a valid 'fire' intent, then
// advanced every server tick. Position is streamed so all clients render the same tracer; velocity
// lets clients smoothly extrapolate between the ~30 Hz patches.
export class Bolt extends Schema {
  constructor() {
    super();
    this.owner = '';         // shooter sessionId (so we never hit the shooter, and can credit kills)
    this.team = 0;           // shooter's team (no friendly fire)
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
  }
}
defineTypes(Bolt, {
  owner: 'string',
  team: 'uint8',
  px: 'float32', py: 'float32', pz: 'float32',
  vx: 'float32', vy: 'float32', vz: 'float32',
});

// One networked guided missile. Spawned authoritatively when a client sends a valid 'missile'
// intent with a locked target. The server homes it toward the target each tick and streams the
// position + velocity so every client renders the same seeking dart. `target` is the victim's
// sessionId (server-only steering key, also replicated so the client can render seeker behavior).
export class Missile extends Schema {
  constructor() {
    super();
    this.owner = '';         // shooter sessionId (never self-hit; credits the kill)
    this.team = 0;           // shooter's team (no friendly fire)
    this.target = '';        // locked victim sessionId ('' = dumbfire, flies straight)
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
  }
}
defineTypes(Missile, {
  owner: 'string',
  team: 'uint8',
  target: 'string',
  px: 'float32', py: 'float32', pz: 'float32',
  vx: 'float32', vy: 'float32', vz: 'float32',
});

// Room-level state: ships + live bolts, plus a running team headcount for lobby display, and the
// authoritative MATCH state (game mode + settings + round clock + team scores + result).
export class ArenaState extends Schema {
  constructor() {
    super();
    this.ships = new MapSchema();
    this.bolts = new MapSchema();
    this.missiles = new MapSchema();
    // Capture the Cargo: the single neutral flag, keyed 'flag' (cargo.get('flag')). Populated only
    // when a CTC match starts; empty otherwise so SDM/FFA replicate nothing.
    this.cargo = new MapSchema();
    this.blueCount = 0;
    this.redCount = 0;
    // --- Match / game-mode state (host-configured in the lobby, server-authoritative) ---
    this.mode = 'sdm';           // game mode id; 'sdm' = Squadron Death Match (only mode for now)
    this.matchState = 'lobby';   // 'lobby' (pre-round, host configures) | 'live' (clock running) | 'ended'
    this.roundDuration = 600;    // configured round length in seconds (default 10 min). Host-settable in lobby.
    this.timeLeft = 600;         // seconds remaining in the live round; counts down to 0 and stops (never negative)
    this.blueKills = 0;          // total enemy kills scored BY blue team this round (win metric)
    this.redKills = 0;           // total enemy kills scored BY red team this round
    // --- Capture the Cargo score (only meaningful when mode === 'ctc') ---
    // A capture = an enemy pilot carrying the OTHER team's pod back to their own base. First team to
    // captureTarget captures wins immediately (or most captures when the clock runs out).
    this.blueCaptures = 0;       // captures scored BY blue team this round
    this.redCaptures = 0;        // captures scored BY red team this round
    this.captureTarget = 7;      // captures needed to win (host picks 4 / 7 / 10 in the lobby)
    this.winningTeam = -1;       // -1 = undecided / draw; 0 = blue won; 1 = red won (set when matchState -> 'ended')
    this.host = '';              // sessionId of the lobby host (the pilot who may set config + start the match)
    // --- Free-For-All result (only meaningful when mode === 'ffa') ---
    // FFA has no teams: the winner is the single pilot with the most kills when the clock hits 0.
    // These are set when an FFA match ends so every client can show the winning pilot banner.
    this.winnerId = '';          // sessionId of the top-scoring pilot ('' = draw / nobody scored)
    this.winnerName = '';        // that pilot's call sign (snapshot, survives them leaving)
    this.winnerKills = 0;        // that pilot's kill count at match end
  }
}
defineTypes(ArenaState, {
  ships: { map: Ship },
  bolts: { map: Bolt },
  missiles: { map: Missile },
  cargo: { map: Cargo },
  blueCount: 'uint8',
  redCount: 'uint8',
  mode: 'string',
  matchState: 'string',
  roundDuration: 'float32',
  timeLeft: 'float32',
  blueKills: 'uint16',
  redKills: 'uint16',
  blueCaptures: 'uint16',
  redCaptures: 'uint16',
  captureTarget: 'uint16',
  winningTeam: 'int8',
  host: 'string',
  winnerId: 'string',
  winnerName: 'string',
  winnerKills: 'uint16',
});
