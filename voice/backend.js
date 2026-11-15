import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

export function createVoiceBackend(env = process.env, { RoomService = RoomServiceClient } = {}) {
  const url = env.LIVEKIT_URL || '';
  const apiKey = env.LIVEKIT_API_KEY || '';
  const apiSecret = env.LIVEKIT_API_SECRET || '';
  const configured = !!(url && apiKey && apiSecret);
  const service = configured ? new RoomService(
    url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'),
    apiKey, apiSecret, { requestTimeout: 5, failover: false },
  ) : null;
  return {
    configured,
    async issue({ room, identity, name }) {
      if (!configured) throw new Error('voice_not_configured');
      const token = new AccessToken(apiKey, apiSecret, { identity, name, ttl: 60 });
      token.addGrant({
        roomJoin: true, room, canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true, canPublishData: false,
      });
      return { url, token: await token.toJwt() };
    },
    async remove(room, identity) {
      if (!service) return;
      // SDK timeout cancels the HTTP request; no detached Promise.race or
      // automatic regional retries that could outlive the reconnect barrier.
      try { await service.removeParticipant(room, identity); } catch { /* best effort */ }
    },
  };
}
