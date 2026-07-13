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

**Not yet implemented:** lag compensation, reconnection, additional game modes, score-limit wins.

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
