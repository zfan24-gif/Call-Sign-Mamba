# Joined-connection voice authorization

Voice credentials are requested through the caller's joined Colyseus `arena`
connection. Register an `onMessage('voiceToken', handler)` listener before sending
`room.send('voiceToken')` with **no payload**. A successful reply is `{url, token}`;
an unavailable or limited request returns `{error}`. Remove response, leave, abort
and timeout listeners after completion. The browser helper defaults to 10 seconds.

`/voice-token` returns HTTP 410 with `voice_requires_joined_connection`. There is no
HTTP fallback. Room, session, identity and name fields in supplied messages are
ignored. The server derives them from its arena, exact active client object, and
connected ship. A reconnect has a new membership generation even when its session
identity is retained. Disconnect immediately invalidates voice membership,
including during the game's 60-second seat reservation. Disposal invalidates all
memberships. Delayed signing cannot return credentials to a replaced membership.

## Configuration and limits

Use the existing `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` Railway
variables. Keep values out of source, logs and test artifacts. Missing configuration
disables voice issuance without interrupting gameplay.

Tokens last 60 seconds and grant room join, subscription and microphone-only audio
publication. Data publication is denied. Issuance permits one in-flight request
per connection, a five-second connection cooldown, 48 requests per rolling minute
per arena and 120 per rolling minute per process. Signing failures consume the
same limits. Duplicate in-flight requests receive no second response.

Departure of a connection issued credentials attempts `removeParticipant` using
a five-second SDK request timeout and `failover: false`. Reconnecting issuance
waits for that removal attempt to settle. Cleanup from an old client cannot
invalidate a newer client's membership. Removal is best effort, not a guarantee
of revoking already connected SFU sessions.

The browser cancels obsolete token requests and fences SDK loading, SFU connect,
microphone capture/publication, mute, playback, monitoring and VOX callbacks by
the current connection. Microphones are muted before publication. Late tracks
from abandoned connections are stopped.

## Verification

Run `npm ci --ignore-scripts --no-audit --no-fund` and `npm test`. The tests include
gameplay regressions, identity spoofing, exact-object membership, disconnected and
disposed clients, delayed signing, rate limits, JWT claims and expiry, removal
ordering, client async races and coordinator cancellation. The integration test
starts two real local Colyseus arenas, exercises HTTP 410 and WebSocket messages,
disconnects/reconnects a client, and calls the actual browser token helper.

The SDK/device tests use mocks. The integration test's SFU URL is deliberately
`ws://127.0.0.1:1`. Passing these tests does **not** demonstrate production SFU
connectivity, microphone permissions, audible conversation, or WebGL gameplay.
Verify those on capable hardware in your own test arena before declaring end-to-end
voice verified. Do not join other players' audio sessions for testing.

## Coordinated rollout and rollback

The new client and server protocols are incompatible with the corresponding old
versions. Back up the current Rosebud editor draft first, preserve unrelated
changes, and prepare both release candidates before changing production. The
standalone GitHub repository is Railway's source; Rosebud's `server-realtime/`
directory is an export mirror and must be reconciled separately.

1. Run fresh tests on the combined client/server revision and review the diff.
2. Choose a controlled window and announce a brief voice interruption.
3. Deploy the intended GitHub main commit to Railway; observe terminal SUCCESS,
   verify `/health`, and match `X-CSM-Revision` to that commit.
4. Publish the matching Rosebud draft in the same release window. Verify the
   published source, not just the editor preview. Confirm `/voice-token` is 410.
5. In your own test arena, verify voice join, microphone mute/unmute, departure
   and reconnection. If either release fails, restore both known-good versions;
   do not leave one side on the incompatible protocol.

This binds credentials to a live public game connection. It adds no account
authentication, invitations, private matchmaking or team-only voice. JWTs remain
bearer credentials until expiry; expiry limits initial joins, not an established
SFU session. Previously issued longer-lived tokens are not automatically revoked.
Secret rotation or a deliberate room drain requires a separate authorized action.

## Recovery provenance

This implementation was reconstructed against server commit
`3a4a7117bbe73c1f7eb3f10c2b4e5d6196a777fe` from Dot's November 14, 2026 handoff.
The unpublished historical commit `8ff2d0a` was not recovered or cherry-picked.
Client fixtures come from Rosebud draft `329237df-cefe-4918-9b8c-1cc440b5ab75`
plus the reviewed microphone-monitor, playback and VOX race corrections. Historical
test results are not evidence for this reconstruction; run the current suite.
