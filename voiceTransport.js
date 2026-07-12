// ---- Managed voice-audio transport (LiveKit) -------------------------------------------------
// This is the ACTUAL VOICE AUDIO layer for the arena, sitting alongside the Colyseus presence
// layer (which owns the "who is speaking" indicators / speaking brackets). LiveKit's hosted SFU
// carries the audio; Colyseus still carries the presence flags. They run in parallel — nothing in
// the presence code changes.
//
// FLOW:
//   1. connect(url, token)   — join a LiveKit room, publish the mic track MUTED (idle).
//   2. setMicEnabled(bool)   — push-to-talk down/up flips the local mic track mute on/off.
//   3. remote tracks         — every other pilot's audio is auto-subscribed and attached to a
//                              hidden <audio> element so it plays (flat stereo, no spatialization).
//   4. disconnect()          — tear the room down on leaving the arena.
//
// GRACEFUL DEGRADATION: if the SDK can't load, no token is minted, or the mic is denied, every
// method no-ops and connected stays false — the match still runs, just without live voice. The
// Colyseus speaking indicators keep working regardless, so a pilot with no mic still SEES who's
// talking; they just can't hear/be heard.

// The LiveKit browser SDK, pinned via the importmap in index.html. Imported dynamically inside
// connect() so a failed CDN fetch degrades gracefully instead of breaking module load.
let _lk = null;

export class VoiceTransport {
  constructor() {
    this.room = null;
    this.connected = false;
    this.micTrack = null;        // our published local microphone track
    this.micEnabled = false;     // true while push-to-talk is held (track unmuted)
    this._audioEls = new Map();   // participantSid -> HTMLAudioElement for each remote track
    this._connecting = false;
    // --- Voice-activity detection (VOX / "speak to activate") ---
    // When VOX is enabled we keep the mic track UNMUTED and instead gate transmission by monitoring
    // the input level with a WebAudio AnalyserNode: while the smoothed level sits above a threshold
    // the pilot is "speaking" and the track stays live; below it (after a short hangover so words
    // aren't clipped) we mute. `onVoxActive(bool)` fires on the speaking edge so main.js can drive the
    // same presence flag + HUD that push-to-talk uses. PTT mode leaves all of this dormant.
    this.voxEnabled = false;
    this.onVoxActive = null;      // callback(active:boolean) on VOX speaking transitions
    this._voxCtx = null;          // AudioContext for the analyser
    this._voxAnalyser = null;
    this._voxData = null;         // Uint8Array time-domain scratch
    this._voxRAF = null;
    this._voxActive = false;      // current VOX speaking state
    this._voxAboveSince = 0;      // timestamp level first crossed the open threshold
    this._voxBelowSince = 0;      // timestamp level first dropped under the close threshold
    // Coarse status the HUD reads to explain the current voice state to the pilot:
    //   'off'         — no connect attempt yet (menus / not in a match)
    //   'connecting'  — join in progress
    //   'live'        — connected AND mic published (can hear + transmit)
    //   'listen-only' — connected but mic denied/unavailable (can hear, can't transmit)
    //   'unavailable' — SDK failed / no token / connect failed (presence-only, no live audio)
    this.status = 'off';
  }

  // Join the LiveKit room and publish the mic MUTED. `url` + `token` come from the server token
  // endpoint (see resolveVoiceToken in main.js). Never throws — logs + no-ops on any failure.
  async connect(url, token) {
    if (this.connected || this._connecting) return;
    if (!url || !token) { console.info('[voice] no LiveKit url/token — voice audio disabled (presence still works).'); this.status = 'unavailable'; return; }
    this._connecting = true;
    this.status = 'connecting';
    try {
      if (!_lk) _lk = await import('livekit-client');
      const { Room, RoomEvent, Track } = _lk;
      this._Track = Track;
      const room = new Room({ adaptiveStream: true, dynacast: true });
      this.room = room;

      // Attach every remote audio track to a hidden <audio> element so it plays. Flat stereo:
      // we do NOT position the sound in 3D — every teammate is simply audible at full volume.
      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();               // creates an <audio> element bound to the stream
        el.autoplay = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        this._audioEls.set(participant.sid, el);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        track.detach().forEach(el => el.remove());
        this._audioEls.delete(participant.sid);
      });
      room.on(RoomEvent.Disconnected, () => { this._teardownLocal(); this.status = 'unavailable'; });

      await room.connect(url, token);
      this.connected = true;

      // Capture + publish the mic, then immediately mute it — the pilot only transmits while
      // holding push-to-talk. If mic permission is denied, we stay connected (still hear others).
      try {
        this.micTrack = await _lk.createLocalAudioTrack({
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        });
        await room.localParticipant.publishTrack(this.micTrack);
        await this.micTrack.mute();
        this.micEnabled = false;
        this.status = 'live';
      } catch (micErr) {
        console.info('[voice] microphone unavailable — you can hear others but not transmit.', micErr && micErr.message);
        this.micTrack = null;
        this.status = 'listen-only';
      }
      console.info('[voice] connected to LiveKit room — voice audio live.');
    } catch (err) {
      console.info('[voice] could not connect to LiveKit — voice audio disabled (presence still works).', err && err.message);
      this._teardownLocal();
      this.status = 'unavailable';
    } finally {
      this._connecting = false;
    }
  }

  // True when we have a working, published microphone (permission granted). Drives the lobby mic
  // icon: a live mic vs. a grayed mic with a slash. False when the mic was denied/unavailable or we
  // aren't connected to voice at all.
  hasMic() { return this.connected && !!this.micTrack; }

  // Push-to-talk: unmute the mic while held, mute on release. No-op if we never published a track
  // (SDK failed / mic denied), so the presence layer still drives the indicators without audio.
  setMicEnabled(on) {
    const want = !!on;
    if (want === this.micEnabled) return;
    this.micEnabled = want;
    if (!this.micTrack) return;
    try {
      if (want) this.micTrack.unmute();
      else this.micTrack.mute();
    } catch {}
  }

  // Enable/disable VOICE-ACTIVATED transmission ("speak to activate"). In VOX mode we hand control of
  // the mic mute to the analyser loop instead of push-to-talk. Enabling with no published mic (denied)
  // no-ops gracefully. Disabling stops the loop and mutes the track so PTT can take over cleanly.
  setVoxEnabled(on) {
    const want = !!on;
    if (want === this.voxEnabled) return;
    this.voxEnabled = want;
    if (want) this._startVox();
    else this._stopVox();
  }

  // Spin up a WebAudio analyser tapping the live mic MediaStreamTrack and start the monitor loop.
  _startVox() {
    if (!this.micTrack) return;   // no mic to monitor (denied / unavailable): VOX simply does nothing
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      // Rebuild the source each time from the current track's MediaStream so it survives republish.
      const mst = this.micTrack.mediaStreamTrack;
      if (!mst) return;
      this._voxCtx = new Ctx();
      const src = this._voxCtx.createMediaStreamSource(new MediaStream([mst]));
      const analyser = this._voxCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      this._voxAnalyser = analyser;
      this._voxData = new Uint8Array(analyser.fftSize);
      this._voxActive = false;
      this._voxAboveSince = 0;
      this._voxBelowSince = performance.now();
      // Start muted; the loop opens the mic once the pilot actually speaks.
      try { this.micTrack.mute(); } catch {}
      this.micEnabled = false;
      const loop = () => {
        this._voxTick();
        this._voxRAF = requestAnimationFrame(loop);
      };
      this._voxRAF = requestAnimationFrame(loop);
    } catch (err) {
      console.info('[voice] VOX unavailable — falling back to push-to-talk.', err && err.message);
      this._stopVox();
    }
  }

  // One analyser sample: compute RMS level, apply open/close thresholds with hangover, and flip the
  // mic + fire the speaking-edge callback so presence + HUD track the live transmission.
  _voxTick() {
    const analyser = this._voxAnalyser, data = this._voxData;
    if (!analyser || !data) return;
    analyser.getByteTimeDomainData(data);
    // RMS of the centered waveform (128 == silence) -> ~0..1 loudness.
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const level = Math.sqrt(sum / data.length);
    const now = performance.now();
    const OPEN = 0.045, CLOSE = 0.03;   // hysteresis: open louder than we close so it doesn't chatter
    const OPEN_MS = 40, HANG_MS = 320;  // brief attack; longer release so words aren't clipped
    if (level >= OPEN) { this._voxBelowSince = 0; if (!this._voxAboveSince) this._voxAboveSince = now; }
    else if (level < CLOSE) { this._voxAboveSince = 0; if (!this._voxBelowSince) this._voxBelowSince = now; }
    let next = this._voxActive;
    if (!this._voxActive && this._voxAboveSince && now - this._voxAboveSince >= OPEN_MS) next = true;
    else if (this._voxActive && this._voxBelowSince && now - this._voxBelowSince >= HANG_MS) next = false;
    if (next !== this._voxActive) {
      this._voxActive = next;
      this.micEnabled = next;
      if (this.micTrack) { try { next ? this.micTrack.unmute() : this.micTrack.mute(); } catch {} }
      if (this.onVoxActive) { try { this.onVoxActive(next); } catch {} }
    }
  }

  // Tear down the VOX analyser loop and ensure the mic ends muted.
  _stopVox() {
    if (this._voxRAF) { cancelAnimationFrame(this._voxRAF); this._voxRAF = null; }
    if (this._voxCtx) { try { this._voxCtx.close(); } catch {} this._voxCtx = null; }
    this._voxAnalyser = null;
    this._voxData = null;
    if (this._voxActive) { this._voxActive = false; if (this.onVoxActive) { try { this.onVoxActive(false); } catch {} } }
    if (this.micTrack) { try { this.micTrack.mute(); } catch {} }
    this.micEnabled = false;
  }

  // Leave the room and clean up every attached remote audio element + the local mic track.
  async disconnect() {
    this.setMicEnabled(false);
    const room = this.room;
    this._teardownLocal();
    this.status = 'off';   // clean leave: back to the no-attempt state (failure paths keep 'unavailable')
    if (room) { try { await room.disconnect(); } catch {} }
  }

  // Local cleanup shared by disconnect() and the Disconnected event. Detaches remote audio,
  // stops the mic track, and clears state so a later connect() starts fresh.
  _teardownLocal() {
    this._stopVox();
    this.voxEnabled = false;
    for (const el of this._audioEls.values()) { try { el.pause(); el.remove(); } catch {} }
    this._audioEls.clear();
    if (this.micTrack) { try { this.micTrack.stop(); } catch {} this.micTrack = null; }
    this.room = null;
    this.connected = false;
    this.micEnabled = false;
  }
}
