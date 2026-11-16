# Call Sign Mamba — Realtime Arena Server (Colyseus)

Authoritative game server for the **12v12 multiplayer arena** (up to 24 players). This is a
standalone Node.js service — it **cannot** run inside the browser game. You run it separately and
point the client at it via the `MP_ENDPOINT` constant in the game's `main.js`.

## What this is (Phase 1)

- **Server-authoritative movement.** The server owns the true position/orientation of every ship
  and simulates them at a fixed **30 Hz** tick using the shared flight model in
  `shared/flightModel.js` (which mirrors the single-player flight feel).
- **Clients send inputs, not positions.** Every client transmits only intent (steer / thrust /
  boost / roll). The server validates + clamps and integrates. This is the anti-cheat foundation.
- **Teams.** Players are auto-balanced onto BLUE (0) / RED (1), capped at 12 each.
- **Matchmaking.** Colyseus places joiners into an arena with room, or spins up a new one when full,
  so one logical lobby scales to many 24-player matches.

**Authoritative combat (server-owned):**
- **Lasers.** Clients send a `fire` intent; the server spawns the bolt down the shooter's nose,
  advances it, and does a swept sphere hit test (`HIT_RADIUS`) so hits register cleanly out to
  ~200–220m of aim. Damage scales with the hull's firepower; shields absorb before hull.
- **Guided missiles.** Clients send a `missile` intent with the locked target's `sessionId`; the
  server spawns a homing warhead, turn-rate-limits its steering toward that target each tick, and
  proximity-fuses it for a heavy hit. Missiles + bolts are both streamed as map schemas so every
  client renders the same tracers.
- **Hit feedback.** Every damaging hit broadcasts a `hit` event (attacker, victim, shield-vs-hull,
  lethal flag) so the shooter gets a hit marker and the victim gets a damage flash. Kills broadcast
  a `kill` event; missile detonations broadcast `missileHit`.
- **Death & respawn.** On destruction a ship is dead for `RESPAWN_DELAY` seconds, then respawns at a
  point SCATTERED around its team anchor and biased AWAY from live enemies (see `pickRespawnPoint`),
  so pilots warp back into open space instead of the kill-box they died in.
- **Scoring / win.** Team opponent-kills are the Squadron Death Match win metric; the round clock
  decides the winner at 0.

The arena supports FFA, Squadron Death Match, Capture the Cargo, Capture the Data Disk and Capital Ship Assault. Objective lobbies start with zero demo pilots. The host can opt into the demo squadron in the lobby.

**Connection recovery.** An unexpected disconnect reserves the same Colyseus seat for 60 seconds. A returning pilot keeps their room, host identity, team, ship and scores. A deliberate exit releases the seat immediately. WebSocket ping/pong handles unresponsive transports independently of flight inputs. In Railway logs, correlate the room ID with the socket close code, unanswered pings, seat restoration or expiry.

**Game and release verification.** The arena and its shared combat modules were synchronized from published Rosebud build `0d85ef05-87a3-4d82-a07e-d136893b00c0` of [Mamba - Ember Combat Workshop](https://rosebud.ai/play/mamba-ember-combat-workshop). When promoting a new game build, compare its `server-realtime/` files and imported shared modules with this repository. The browser client is released in the Rosebud project.

Run `npm test` for game-rule regressions. The production `/health` response carries `X-CSM-Revision` when Railway supplies `RAILWAY_GIT_COMMIT_SHA`. Compare that value with the deployed branch head to verify the running binary.

**Voice authorization.** Credentials are issued only to an active joined arena connection,
using server-owned room and pilot identity. `/voice-token` now returns HTTP 410.
Tokens last 60 seconds, permit microphone publication and subscription, and deny data
publication. Reconnection revokes the old membership and waits for prior SFU cleanup.
See [`docs/VOICE.md`](./docs/VOICE.md) for limits, tests, configuration and the required
coordinated Rosebud/Railway rollout and rollback.

## Run it locally

Requires Node.js 18+.

```bash
cd server-realtime
npm install
npm start
```

You should see:

```
⚔  Call Sign Mamba arena server listening on ws://localhost:2567
```

The game client defaults to `ws://localhost:2567` (see `MP_ENDPOINT` in `main.js`), so with the
server running, click **Multiplayer Arena · 12v12** in the game and you'll join. Open a second
browser tab / window to test two ships seeing each other move.

### Serving the game client

The arena server above only handles multiplayer; the game itself is a buildless ESM project that
still needs to be served over HTTP (ESM + importmaps won't load from a `file://` path). From the
**project root** (one level up from this folder), run any static file server, e.g.:

```bash
npx serve .
```

Then open the URL it prints (typically `http://localhost:3000`). For a full multiplayer test, run
both at once — the arena server here (`npm start` in `server-realtime/`) **and** the static client
server (`npx serve .` in the project root) — then open two browser tabs pointed at the client URL.

> If the server isn't running, the game detects it and flies a clean **solo** Free Flight (the HUD
> reads "arena server offline") — no errors, so single-player is never blocked.

## Deploy it (production)

**See [`DEPLOY.md`](./DEPLOY.md) for step-by-step instructions** (Railway / Render / Fly.io / VPS),
verification steps, and troubleshooting.

The short version — any host that runs a long-lived Node WebSocket process works. Two requirements:

1. **TLS / `wss://`.** Once your game page is served over `https://`, browsers will only connect to a
   secure socket. Managed hosts terminate TLS for you and give you an `https://…` domain; use that
   same host with `wss://`.
2. **Point the client at it.** No rebuild needed — set `MP_ENDPOINT_PROD` in `main.js` and share
   links as `?server=prod`, or put the full URL in the link: `?server=wss://your-host`.

The server already reads the `PORT` env var (hosts inject one), binds `0.0.0.0`, and answers HTTP
health checks on `/`, `/health`, and `/healthz`, so it deploys with no code changes.

### Scaling note

24 players/room at 30 Hz is real, sustained CPU + bandwidth. A single small instance handles a few
concurrent arenas; beyond that you'll want multiple instances and Colyseus' built-in scalability
(presence/driver via Redis). That's a Phase 4 concern — get 2-player movement feeling right first.

## Keeping client & server flight in sync

`shared/flightModel.js` (server) and `../netFlightModel.js` (client) contain the **same** integrator.
If you tune flight on one side, tune the other identically — if they diverge, the local ship
rubber-bands on each server correction and remote ships jitter.

## Movement and round loadouts (November 2026)

Inputs must carry a strictly newer uint32 `seq` (wrap supported) and a finite,
positive numeric `dt`. Steps are capped at 50 ms. A monotonic server clock earns
movement time with at most 100 ms of accumulated credit; received input and
held-control coasting spend the same credit. At most 128 frames are buffered.
After stalls, frames beyond the newest 100 ms are retired without movement.
`lastSeq` acknowledges both applied and retired input, so the client discards
stale prediction. `engineHeat` and `engineOverheated` accompany the authoritative
pose; client reconciliation rewinds heat and replays unacknowledged input.

Each `matchStart` begins a server-owned ten-second selection period. The round
clock, movement and weapons remain paused. `selectionTimeLeft` and `roundId`
are replicated, and each ship exposes `loadoutLocked`. The client sends each
highlighted legal choice during the window and may confirm it early:

```js
room.send('setShip', { ship: 'lightning', confirm: true, round: currentRound });
```

The server replies with `shipSelection` containing `ship`, `accepted`, `locked`,
`remaining` and `round`. Register the handler before sending `getShipSelection`
to recover current selection state. Launch only after authoritative remaining
is zero and the loadout is locked. At expiry the last accepted ship is final;
repeated live changes cannot refill health or ammunition. Team rosters and all
six FFA hulls are enforced. Reconnection preserves the existing deadline and
loadout, respawn preserves the selected hull, and the next round opens a fresh
window. The existing joined-connection voice authorization is unchanged.

Deploy this server together with the updated Rosebud picker and reconciliation
client. Prepare and verify both before merging main, wait for the intended
Railway revision and health check, publish the prepared client, and reload
already-open game tabs. For rollback restore both client and server. Use only
owned isolated arenas for production smoke checks. `npm test` includes actual
local Colyseus websocket coverage, a real-time ten-second selection smoke, and
controlled-clock tests for 10–360 FPS, jitter, stalls, retirement, reconnect,
selection restrictions, heat, and sequence wrap. These tests do not establish
rendered gameplay smoothness or real WAN/microphone behavior.
