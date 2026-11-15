// Voice credentials belong to a joined transport, never to caller-supplied IDs.
export class VoiceRateLimit {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.times = [];
  }
  available(now) {
    while (this.times.length && this.times[0] <= now - this.windowMs) this.times.shift();
    return this.times.length < this.limit;
  }
  take(now) { this.times.push(now); }
}

// One shared instance per Node process, including every arena in that process.
export const processVoiceLimit = new VoiceRateLimit(120);

export class VoiceAccess {
  constructor(room, backend, { now = () => performance.now(), processLimit = processVoiceLimit } = {}) {
    this.room = room;
    this.backend = backend;
    this.now = now;
    this.processLimit = processLimit;
    this.arenaLimit = new VoiceRateLimit(48);
    this.members = new Map();
    this.removals = new Map();
    this.generation = 0;
    this.disposed = false;
  }

  join(client) {
    if (this.disposed) return;
    const old = this.members.get(client.sessionId);
    if (old?.client === client) return;
    if (old) this.leave(old.client);
    this.members.set(client.sessionId, {
      client, generation: ++this.generation, lastRequest: -Infinity,
      pending: false, issued: false,
    });
  }

  active(member) {
    const client = member?.client;
    return !!client && !this.disposed && this.members.get(client.sessionId) === member
      && this.room.clients.includes(client)
      && this.room.state.ships.get(client.sessionId)?.connected === true
      && (client.ref?.readyState === undefined || client.ref.readyState === 1);
  }

  reply(member, data) {
    if (!this.active(member)) return;
    try { member.client.send('voiceToken', data); } catch { /* transport closed */ }
  }

  async request(client) {
    const member = this.members.get(client.sessionId);
    if (member?.client !== client || !this.active(member)) return;
    // Do not answer a duplicate while signing: it could resolve the original
    // client's one-shot response listener before its legitimate token arrives.
    if (member.pending) return;
    const now = this.now();
    if (now - member.lastRequest < 5_000 || !this.arenaLimit.available(now)
      || !this.processLimit.available(now)) {
      this.reply(member, { error: 'voice_rate_limited' });
      return;
    }
    member.lastRequest = now;
    this.arenaLimit.take(now);
    this.processLimit.take(now);
    if (!this.backend?.configured) {
      this.reply(member, { error: 'voice_not_configured' });
      return;
    }
    member.pending = true;
    try {
      // A reconnect reuses its session identity. Finish the OLD removal before
      // giving the NEW connection anything it can use to join the SFU.
      await this.removals.get(client.sessionId);
      if (!this.active(member)) return;
      const credentials = await this.backend.issue({
        room: this.room.roomId,
        identity: client.sessionId,
        name: this.room.state.ships.get(client.sessionId).name,
      });
      if (!this.active(member)) return;
      member.issued = true;
      this.reply(member, credentials);
    } catch {
      // Never include SDK exceptions: they can contain request credentials.
      this.reply(member, { error: 'voice_token_failed' });
    } finally {
      member.pending = false;
    }
  }

  leave(client) {
    const member = this.members.get(client.sessionId);
    if (member?.client !== client) return;
    this.members.delete(client.sessionId); // invalidate signing synchronously
    if (!member.issued) return;
    const sid = client.sessionId;
    const prior = this.removals.get(sid);
    const removal = Promise.resolve(prior).then(() => this.backend.remove(this.room.roomId, sid)).catch(() => {});
    this.removals.set(sid, removal);
    void removal.then(() => {
      if (this.removals.get(sid) === removal) this.removals.delete(sid);
    });
    return removal;
  }

  dispose() {
    this.disposed = true;
    for (const member of this.members.values()) this.leave(member.client);
    return Promise.allSettled(this.removals.values());
  }
}
