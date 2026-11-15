// ---- Call Sign Mamba realtime server (Colyseus) ----------------------------------------------
// Entry point: boots a Colyseus game server over WebSockets and registers the ArenaRoom. Run it
// with `npm start` (see README.md / DEPLOY.md). The browser client connects to ws://localhost:2567
// by default; set the PORT env var to change the port. For production, host this behind wss:// (TLS)
// — managed hosts (Railway/Render/Fly) terminate TLS for you and inject PORT.
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'http';
import { pathToFileURL } from 'node:url';
import { createVoiceBackend } from './voice/backend.js';
import { ArenaRoom } from './rooms/ArenaRoom.js';

// Dependency injection is server-owned; arena join options cannot replace the backend.
export function createArenaServer({ voiceBackend = createVoiceBackend(), gracefullyShutdown = true } = {}) {
// Create the raw HTTP server ourselves so we can (a) hand it to the Colyseus WebSocket transport
// AND (b) answer plain HTTP health checks on it. Many hosts probe an HTTP path (often "/") to
// decide the service is healthy before routing traffic; a WebSocket-only server would fail that
// probe. We reply 200 to GET /health and / so the platform marks the deploy live.
const httpServer = createServer((req, res) => {
  // The game page is served from a different origin than this server, so allow cross-origin
  // requests to the token endpoint (and answer the CORS preflight).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (path === '/health' || path === '/' || path === '/healthz')) {
    const revision = process.env.RAILWAY_GIT_COMMIT_SHA;
    if (revision && /^[0-9a-f]{40}$/i.test(revision)) res.setHeader('X-CSM-Revision', revision);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Call Sign Mamba arena server OK');
    return;
  }
  // This endpoint deliberately has no minting path, even when voice is disabled.
  if (path === '/voice-token') {
    res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'voice_requires_joined_connection' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const gameServer = new Server({
  gracefullyShutdown,
  transport: new WebSocketTransport({
    server: httpServer,
    // A brief network or browser stall should not discard a running match.
    pingInterval: 5000,
    pingMaxRetries: 6,
  }),
});

// Register the 12v12 arena. Clients join it by name 'arena'. Colyseus matchmaking will place
// players into an existing arena that still has room, or spin up a new one when it's full — so a
// single logical "lobby" scales to multiple 24-player matches automatically.
//
// sortBy clients DESC = PACK joiners into the MOST-populated non-full room first. Without this,
// two pilots calling joinOrCreate at nearly the same time can each spin up their OWN empty arena
// (a matchmaking race), and since each is then the FIRST pilot in their room they BOTH get team 0
// (blue) and never see each other's real team — the "both players on team 0 / see each other's
// mic light / orientation looks 90° off (no shared reference frame)" bug. Packing toward the
// fullest open room makes a small party reliably land in ONE arena, where the balanced-team
// assignment (blue for the 1st, red for the 2nd, ...) works as intended.
class VoiceArenaRoom extends ArenaRoom {
  constructor(...args) { super(...args); this.voiceBackend = voiceBackend; }
}
gameServer.define('arena', VoiceArenaRoom).sortBy({ clients: -1 });
return { gameServer, httpServer };
}

// Importing this module in local integration tests does not open a public port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 2567;
  const host = process.env.HOST || '0.0.0.0';
  const voiceBackend = createVoiceBackend();
  const { gameServer } = createArenaServer({ voiceBackend });
  await gameServer.listen(port, host);
  console.log(`Call Sign Mamba arena server listening on ${host}:${port}`);
  console.log(voiceBackend.configured
    ? 'Voice enabled: credentials require a joined arena connection.'
    : 'Voice disabled: configure LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
}
