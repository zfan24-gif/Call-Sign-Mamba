# Running Call Sign Mamba Multiplayer Locally

Multiplayer needs an authoritative Colyseus server **and** the game client to both run
on **your own machine**, all on `localhost`. This avoids the browser blocking an insecure
`ws://localhost` socket from a page served over `https://` (mixed-content), which is why
the Rosebud preview can **not** connect to a local server.

## Requirements

- **Node.js 18+** — check with `node -v`
- The full project **downloaded to your computer** (not just the `server-realtime/` folder)

## Step 1 — Start the server (Terminal 1)

```bash
cd server-realtime
npm install        # first time only
npm start
```

Wait for:

```
⚔  Call Sign Mamba arena server listening on ws://localhost:2567
```

Leave this terminal open — closing it stops the server.

## Step 2 — Serve the game client (Terminal 2)

From the **project root** (the folder with `index.html`):

```bash
npx serve .
```

…or, if you prefer Python:

```bash
python3 -m http.server 8080
```

Note the URL it prints (e.g. `http://localhost:3000`).

## Step 3 — Play

1. Open that `http://localhost:...` URL in **two browser tabs** (or two browsers).
2. Click **Multiplayer Arena · 12v12** in each.
3. The connection badge (top-center) should turn **green — "ARENA · … ONLINE"**.
   You should see the other ship flying around the arena.

## Why the Rosebud preview can't connect

- The preview is served over `https://` on Rosebud's domain.
- The client connects to `ws://localhost:2567` (insecure WebSocket).
- Browsers block insecure `ws://` from a secure `https://` page (mixed content), and the
  preview's `localhost` is not your computer's network.
- Result: the client falls back to **solo flight**. This is expected in the preview.

## Changing the port

If you start the server on a different port:

```bash
PORT=3000 npm start
```

…then update the `MP_ENDPOINT` constant in `main.js` to match (e.g.
`ws://localhost:3000`) and re-serve the client.

## Deploying for real (beyond local testing)

To let players connect over the internet, host `server-realtime/` on a Node host and put
it behind **TLS (`wss://`)**, then point `MP_ENDPOINT` at that `wss://your-host` URL.
See `server-realtime/README.md` for deployment notes.
