// ---- Call Sign Mamba realtime server (Colyseus) ----------------------------------------------
// Entry point: boots a Colyseus game server over WebSockets and registers the ArenaRoom. Run it
// with `npm start` (see README.md / DEPLOY.md). The browser client connects to ws://localhost:2567
// by default; set the PORT env var to change the port. For production, host this behind wss:// (TLS)
// — managed hosts (Railway/Render/Fly) terminate TLS for you and inject PORT.
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'http';
import { AccessToken } from 'livekit-server-sdk';
import { ArenaRoom } from './rooms/ArenaRoom.js';

// Managed hosts inject the port to listen on via PORT; fall back to 2567 for local dev.
const PORT = Number(process.env.PORT) || 2567;
// Bind on all interfaces in production so the host's router/health-check can reach the process.
// (Binding only to localhost is a common reason a deploy "runs" but never accepts connections.)
const HOST = process.env.HOST || '0.0.0.0';

// ---- LiveKit voice config (managed SFU) ------------------------------------------------------
// The browser can't be trusted with the API secret, so the CLIENT asks THIS server for a short-
// lived room-scoped JWT and connects to LiveKit with it. Set these three env vars on the host
// (never commit them): LIVEKIT_URL (the wss:// LiveKit Cloud/self-host URL), LIVEKIT_API_KEY,
// LIVEKIT_API_SECRET. If any are missing, /voice-token returns 503 and the game simply runs
// without live voice audio (the Colyseus speaking indicators still work).
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const VOICE_CONFIGURED = !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

// Sanitize a client-supplied identity/room so a bad value can't inject odd characters into the
// grant. Keep it short, alphanumeric + a few safe separators.
function safeName(v, fallback) {
  const s = String(v || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48);
  return s || fallback;
}

// Read + JSON-parse a small request body (used by POST /voice-token). Caps the size so a huge
// body can't tie the process up; resolves {} on any parse error.
function readJsonBody(req, cap = 4096) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > cap) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve({});
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// Mint a LiveKit access token for a pilot joining a voice room. `room` groups everyone who should
// hear each other (we pass the Colyseus roomId so one arena = one voice room); `identity` is the
// pilot's session id. The grant lets them publish (mic) + subscribe (hear others).
async function mintVoiceToken(room, identity, name) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name,
    ttl: '2h',   // covers a full match; the client re-requests on each join
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

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
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Call Sign Mamba arena server OK');
    return;
  }
  // Voice token mint: the client POSTs { room, identity, name } and gets back { url, token } to
  // connect to the managed LiveKit SFU. 503 when voice isn't configured (missing env vars) so the
  // client cleanly falls back to presence-only (no live audio).
  if (req.method === 'POST' && path === '/voice-token') {
    if (!VOICE_CONFIGURED) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'voice_not_configured' }));
      return;
    }
    readJsonBody(req).then(async (body) => {
      const room = safeName(body.room, 'arena');
      const identity = safeName(body.identity, 'pilot-' + Math.random().toString(36).slice(2, 8));
      const name = safeName(body.name, identity);
      try {
        const token = await mintVoiceToken(room, identity, name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: LIVEKIT_URL, token }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'token_mint_failed' }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
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
gameServer.define('arena', ArenaRoom).sortBy({ clients: -1 });

gameServer.listen(PORT, HOST);
// Log both a local-friendly URL and the bind target so deploy logs clearly show it came up. Over a
// managed host this process is reached at the platform's public wss:// domain (TLS terminated for
// you), not this raw host:port — point the game client's MP_ENDPOINT at that wss:// URL.
console.log(`⚔  Call Sign Mamba arena server listening on ${HOST}:${PORT} (local: ws://localhost:${PORT})`);
console.log(VOICE_CONFIGURED
  ? `🎙  LiveKit voice ENABLED — token endpoint POST /voice-token -> ${LIVEKIT_URL}`
  : '🎙  LiveKit voice DISABLED — set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET to enable live audio (presence still works).');
