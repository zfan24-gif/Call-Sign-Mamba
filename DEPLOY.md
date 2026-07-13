# Deploying the Call Sign Mamba Arena Server (Colyseus)

This guide gets the **authoritative multiplayer server** in this folder (`/server-realtime`)
running on a public host over **`wss://` (TLS)** so real testers on different machines can join the
12v12 arena. It is written for the Colyseus server that ships with this project — **not** a generic
WebSocket relay template. Your game client speaks the Colyseus protocol and will only work against
this server.

---

## Before you start

- **This is a standalone Node.js service.** It cannot run inside the browser game. You deploy it
  separately and point the game client at it.
- **You need the code in a Git repo (GitHub/GitLab).** Managed hosts deploy by pulling a repo. Push
  the whole project (or at least this `server-realtime/` folder) to GitHub first.
- **`https://` pages require `wss://`.** Once your game is served over `https://`, the browser blocks
  insecure `ws://`. Managed hosts terminate TLS for you and give you an `https://…` domain — the
  matching socket URL is that same host with **`wss://`**.
- The server already reads `process.env.PORT` and binds `0.0.0.0`, and answers HTTP health checks on
  `/`, `/health`, and `/healthz`. No code changes are needed to deploy.

---

## Option A — Railway (recommended, easiest)

1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo**. (Do **not** pick a
   marketplace template — you're deploying *your* repo.)
2. Select your repository.
3. In the service **Settings**:
   - **Root Directory:** `server-realtime`
     (so Railway runs *this* folder's `package.json`, not the project root).
   - **Start Command:** leave as `npm start` (the default from `package.json`) if not auto-detected.
   - Railway auto-injects `PORT` — do **not** hardcode one.
4. Deploy. Watch the logs for:
   ```
   ⚔  Call Sign Mamba arena server listening on 0.0.0.0:<port> (local: ws://localhost:<port>)
   ```
5. Under **Settings → Networking**, click **Generate Domain**. You'll get something like
   `mamba-arena-production.up.railway.app`.
6. Your endpoint for the game client is that domain with `wss://`:
   ```
   wss://mamba-arena-production.up.railway.app
   ```

---

## Option B — Render

1. **render.com** → **New** → **Web Service** → connect your GitHub repo.
2. Configure:
   - **Root Directory:** `server-realtime`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
3. Create the service. Render injects `PORT` automatically.
4. Once live, Render gives you `https://your-service.onrender.com`. Your client endpoint is:
   ```
   wss://your-service.onrender.com
   ```

> **Note on Render free tier:** free web services **sleep after inactivity** and cold-start on the
> next request, which adds a multi-second delay to the first join. For a scheduled test session, use
> a paid instance (or Railway) so the arena is always warm.

---

## Option C — Fly.io

Fly needs a Dockerfile or its Node buildpack plus a `fly.toml`. It's more setup but lets you pick a
region close to your testers for lower latency.

1. Install the CLI and run `fly launch` from inside `server-realtime/`.
2. When prompted, **don't** deploy immediately — edit `fly.toml` so the internal port matches what
   the app listens on. Fly sets `PORT=8080` by default, and this server already reads `PORT`, so set:
   ```toml
   [http_service]
     internal_port = 8080
     force_https = true
   ```
3. `fly deploy`. Your endpoint is `wss://your-app.fly.dev`.

---

## Option D — Bare VPS (most control)

Only worth it if you specifically want it. On a VPS you must set up TLS yourself:

1. `git clone` the repo, `cd server-realtime`, `npm install`.
2. Run the process under a supervisor (`pm2`, `systemd`) so it restarts on crash/reboot:
   ```bash
   pm2 start index.js --name mamba-arena
   ```
3. Put **Caddy** or **Nginx** in front as a TLS-terminating reverse proxy that upgrades WebSocket
   connections. Minimal Caddy example (`/etc/caddy/Caddyfile`):
   ```
   arena.yourdomain.com {
       reverse_proxy localhost:2567
   }
   ```
   Caddy fetches a Let's Encrypt cert automatically, so you get `wss://arena.yourdomain.com`.

---

## Point the game client at your server

You do **not** have to rebuild the game to switch servers. The client resolves its endpoint at load
time (see `resolveMpEndpoint()` / `MP_ENDPOINT` in `main.js`), in this priority order:

1. `?server=<url>` URL query param
2. `localStorage['mamba.mpEndpoint']` (sticky per-browser)
3. `MP_ENDPOINT_DEFAULT` (compiled-in fallback, `ws://localhost:2567`)

**For a tester round, either:**

- **Set the baked-in production URL** — edit `MP_ENDPOINT_PROD` in `main.js` to your `wss://…` URL,
  then share links as `your-published-url?server=prod`, **or**
- **Skip the code edit** and share the URL directly in the link:
  ```
  your-published-url?server=wss://mamba-arena-production.up.railway.app
  ```

Either way, only the people you send the `?server=` link to connect to your arena; a plain link
falls back cleanly to solo flight. To wipe a stuck override in a browser, open
`your-published-url?server=clear`.

---

## Verify the deploy

1. **HTTP health:** open `https://your-host/health` in a browser — you should see
   `Call Sign Mamba arena server OK`. If this fails, the process isn't up / isn't binding correctly.
2. **Socket join:** open the game with your `?server=…` link, click **Multiplayer Arena · 12v12**,
   and watch the top-center badge turn **green — "ARENA · … ONLINE"**.
3. **Two real clients:** have a second person (different machine/network) join the same link. In the
   browser console each client logs:
   ```
   [multiplayer] arena endpoint = wss://…
   [multiplayer] joined arena roomId=… sessionId=…
   ```
   If both print the **same roomId**, you're in the same match. Different roomIds = they landed in
   separate arenas (endpoint mismatch); same roomId but not seeing each other = a state-sync issue.

---

## Troubleshooting

- **Deploy "succeeds" but clients time out / fall back to solo.**
  Usually a bind or port issue. Confirm you did **not** hardcode a port, the log shows
  `listening on 0.0.0.0:<port>`, and the host's health check path is reachable (`/health`).
- **Client connects on `http://localhost` but not on the published `https://` page.**
  Mixed content — an `https://` page can't open `ws://`. Make sure your endpoint is `wss://`. The
  client auto-upgrades a non-localhost `ws://` to `wss://` on secure pages, but pass a `wss://` URL
  to be safe.
- **First join after idle is very slow (then fine).**
  A sleeping free-tier instance cold-starting. Use a paid/always-on instance for test sessions.
- **Wrong `package.json` runs / build errors about the game, not the server.**
  The host is deploying the project root instead of this folder. Set **Root Directory** to
  `server-realtime`.

---

## Capacity & cost expectations for a first test

- A single small instance comfortably runs a few concurrent 24-player arenas. 24 players/room at
  30 Hz is real sustained CPU + bandwidth, so watch the host's metrics during a busy session.
- To scale past a handful of concurrent arenas you'll want multiple instances plus Colyseus'
  built-in scalability (a Redis presence/driver). That's a later concern — get a clean tester round
  in first.
