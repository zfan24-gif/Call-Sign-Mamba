export class AudioBus {
  constructor() {
    // Gameplay soundtrack: a rotating set of multi-segment TRACKS in the same hybrid
    // orchestral-electronic theme as the opening cue. The 30s generation cap means no single
    // clip can be 4 minutes, so each "track" is an ordered list of 30s segments (intro →
    // build → bridge → climax) that chain back-to-back, then the whole sequence repeats once
    // to fill ~4 minutes before we advance to the next theme. Seams are seamless because the
    // next segment fades in on a second audio element a beat before the current one ends.
    //
    // Each themed track lists its segments in play order; segments were authored so the climax
    // resolves cleanly back into the intro, so looping the whole sequence stays musical.
    this.tracks = [
      {
        name: 'vanguard',
        segments: [
          'assets/audio/battle-score-vanguard.mp3',
          'assets/audio/vanguard-seg2.mp3',
          'assets/audio/vanguard-seg3.mp3',
          'assets/audio/vanguard-seg4.mp3'
        ]
      },
      {
        name: 'eclipse',
        segments: [
          'assets/audio/battle-score-eclipse.mp3',
          'assets/audio/eclipse-seg2.mp3',
          'assets/audio/eclipse-seg3.mp3',
          'assets/audio/eclipse-seg4.mp3'
        ]
      },
      {
        name: 'starfall',
        segments: [
          'assets/audio/battle-score-starfall.mp3',
          'assets/audio/starfall-seg2.mp3',
          'assets/audio/starfall-seg3.mp3',
          'assets/audio/starfall-seg4.mp3'
        ]
      },
      {
        name: 'ironhold',
        segments: [
          'assets/audio/battle-score-ironhold.mp3',
          'assets/audio/ironhold-seg2.mp3',
          'assets/audio/ironhold-seg3.mp3',
          'assets/audio/ironhold-seg4.mp3'
        ]
      },
      {
        name: 'talon',
        segments: [
          'assets/audio/battle-score-talon.mp3',
          'assets/audio/talon-seg2.mp3',
          'assets/audio/talon-seg3.mp3',
          'assets/audio/talon-seg4.mp3'
        ]
      },
      {
        name: 'aurora',
        segments: [
          'assets/audio/battle-score-aurora.mp3',
          'assets/audio/aurora-seg2.mp3',
          'assets/audio/aurora-seg3.mp3',
          'assets/audio/aurora-seg4.mp3'
        ]
      },
      // Single-segment legacy theme: treated as a 1-segment track that loops to fill its slot.
      { name: 'combat',   segments: ['assets/audio/combat-space-loop.mp3'] }
    ];
    for (let i = this.tracks.length - 1; i > 0; i--) {         // Fisher–Yates shuffle of tracks
      const j = (Math.random() * (i + 1)) | 0;
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    this.trackIndex = 0;        // which themed track is playing
    this.segIndex = 0;          // which segment within the current track
    this.trackLoop = 0;         // how many times the current track's sequence has repeated
    this.TARGET_TRACK_MS = 240000;  // aim for ~4 minutes per track before advancing themes
    this._trackElapsed = 0;     // ms of the current track played so far
    this.musicVolume = 0.28;
    // Two music elements let the next segment fade in just before the current ends (gapless).
    this.music = new Audio(this.tracks[0].segments[0]);
    this.music.loop = false;
    this.music.volume = this.musicVolume;
    this.musicB = new Audio();
    this.musicB.loop = false;
    this.musicB.volume = 0;
    this._activeMusic = this.music;     // element currently the "live" one
    this._idleMusic = this.musicB;      // element used to pre-roll the next segment
    this._segWatch = null;              // interval id watching for the crossfade point
    this._seamToken = 0;                // monotonic id of the current live segment (dedup advances)
    this._advancing = false;            // re-entrancy guard while a crossfade is being set up
    this.CROSSFADE_MS = 900;            // overlap length between segments
    // Dedicated cinematic score channel for the opening cutscene (does not loop).
    this.score = new Audio('assets/audio/cutscene-warp-battle-score-2.mp3');
    this.score.loop = false;
    this.score.volume = 0.5;
    // Overwatch voice-over channel for the warp-in briefing (does not loop).
    this.voice = new Audio('assets/audio/voice/overwatch/eeac731a_60bac1d3-b_v2.mp3');
    this.voice.loop = false;
    this.voice.volume = 0.95;
    // Scaavi wingmate barks (low-shields warning, etc). Own element so a combat alert line can
    // overlap the soundtrack without disturbing the Overwatch briefing channel.
    this.scaaviShieldsFailing = new Audio('assets/audio/voice/scaavi/scaavishieldsfailing.mp3');
    this.scaaviShieldsFailing.loop = false;
    this.scaaviShieldsFailing.volume = 0.95;
    // Shared SCAAVI combat-bark channel. One reusable element streams whichever line the ship's AI
    // (blue SCAAVI or red Crimson SCAAVI) needs to speak — shields failing, hull damage, shields
    // recharged — so alerts never overlap the Overwatch briefing channel or each other.
    this.scaaviBark = new Audio();
    this.scaaviBark.loop = false;
    this.scaaviBark.volume = 0.95;
    this._scaaviBarkSrc = '';
    this.sfx = {
      laser: 'assets/audio/laser-player-blaster-2.mp3',
      enemyLaser: 'assets/audio/laser-enemy-cannon-3.mp3',
      shield: 'assets/audio/shield-impact-alert.mp3',
      warp: 'assets/audio/hyperspace-warp-in.mp3',
      explosion: 'assets/audio/explosion-ship-destroyed.mp3',
      warpDropout: 'assets/audio/warp-dropout.mp3',
      // Per-ship engine power-up / ignition one-shots, keyed 'engine-<shipId>'. Played when a hull is
      // selected on the ship-select screen (its exhaust trail ignites). Mamba (the Lightning) reuses
      // the existing hyperspace warp-in sample — its established powerplant tone — while the other
      // five hulls each got a bespoke ignition sound matching their character.
      // Mamba (PT3 Lightning) ship-select cue: a two-stage ignition — a deep bass-filled thump as the
      // powerplant catches, immediately followed by a fast upward pitch/tone sweep as the engines fire
      // off and the ship surges to power.
      'engine-lightning':   'assets/audio/engine-lightning-ignite-launch.mp3',
      'engine-fury':        'assets/audio/engine-powerup-fury.mp3',
      'engine-concept':     'assets/audio/engine-powerup-concept.mp3',
      'engine-interceptor': 'assets/audio/engine-powerup-interceptor-2.mp3',
      'engine-fighter':     'assets/audio/engine-powerup-fighter.mp3',
      'engine-bomber':      'assets/audio/engine-powerup-bomber.mp3',
      // Per-ship HYPERSPACE JUMP one-shots, keyed 'warp-<shipId>'. Longer (~5s) versions built from
      // the same tonal character as each hull's engine-select ignition, so warp-in and warp-out use
      // the ship's OWN signature spool-up -> lightspeed whoosh -> tunnel drone instead of the generic
      // warp sample. playShipWarp() falls back to the generic 'warp' key for any unmapped id.
      'warp-lightning':     'assets/audio/warp-lightning.mp3',
      'warp-fury':          'assets/audio/warp-fury-2.mp3',
      'warp-concept':       'assets/audio/warp-concept.mp3',
      'warp-interceptor':   'assets/audio/warp-interceptor.mp3',
      'warp-fighter':       'assets/audio/warp-fighter.mp3',
      'warp-bomber':        'assets/audio/warp-bomber.mp3'
    };
    // Looping hyperspace-travel hum, played on its own element while warping through the tunnel.
    this.hum = new Audio('assets/audio/hyperspace-hum-loop.mp3');
    this.hum.loop = true;
    this.hum.volume = 0;
    this.muted = false;
    this.unlocked = false;

    // ---- User-adjustable mix levels (0..1). The Settings/pause menu drives these. ----
    // master scales everything; musicLevel scales the soundtrack + cinematic score; sfxLevel
    // scales one-shot SFX. They multiply the per-call base volumes, so 1.0 == original feel.
    this.masterLevel = 1.0;
    this.musicLevel = 1.0;
    this.sfxLevel = 1.0;
    this._baseMusicVolume = this.musicVolume;   // the "design" soundtrack volume before user mix

    // --- WebAudio one-shot engine for SFX ---
    // HTMLAudioElements created per-shot are unreliable for rapid fire (laser cadence
    // ~5/sec); they get throttled, GC'd, or silently fail. Decode each SFX into a
    // buffer once and play short-lived buffer sources instead. Rock-solid + low latency.
    this.ctx = null;
    this.buffers = {};       // name -> AudioBuffer
    this._decoding = {};     // name -> Promise

    // --- Cockpit engine hum (first-person only) ---
    // Reuses the SAME looping hum sample as the hyperspace warp, so the cockpit engine reads as the
    // same powerplant — but pitched DOWN and played quieter, because at sublight the engine is under
    // far less stress than when it's tearing through a hyperspace tunnel. Throttle drives the
    // volume and a gentle pitch bend so it spools up/down with thrust. Its own Audio element so it
    // can run independently of (and overlap) the warp hum during transitions.
    this.engineHum = new Audio('assets/audio/hyperspace-hum-loop.mp3');
    this.engineHum.loop = true;
    this.engineHum.volume = 0;
    this.engineHum.preservesPitch = false;     // let playbackRate change pitch (engine spool)
    try { this.engineHum.preservesPitch = false; this.engineHum.mozPreservesPitch = false; this.engineHum.webkitPreservesPitch = false; } catch {}
    this._engineThrottle = 0;     // last commanded throttle 0..1
    this._engineActive = false;   // whether the hum is currently audible
    // Sublight playback is slowed to ~0.62x base so it's a lower, calmer drone than the warp hum,
    // bending up toward ~0.78x at full throttle (still well below the warp loop's native 1.0).
    this._engineRateIdle = 0.62;
    this._engineRateFull = 0.78;
    this.engineHumLevel = 0.5;    // design loudness of the hum at full throttle
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    return this.ctx;
  }

  // Decode every SFX clip into an AudioBuffer. Safe to call repeatedly.
  async _decodeAll() {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    await Promise.all(Object.entries(this.sfx).map(async ([name, url]) => {
      if (this.buffers[name] || this._decoding[name]) return;
      this._decoding[name] = (async () => {
        try {
          const res = await fetch(url);
          const arr = await res.arrayBuffer();
          this.buffers[name] = await ctx.decodeAudioData(arr);
        } catch (e) { /* leave undefined; play() will no-op for it */ }
      })();
      await this._decoding[name];
    }));
  }

  async unlock() {
    if (this.unlocked) {
      // Still make sure a suspended context resumes on later gestures.
      if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
      return;
    }
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    this._decodeAll();          // kick off decode (don't block the gesture)
    // NOTE: the gameplay soundtrack playlist is NOT started here — the cinematic `score`
    // channel owns the intro. startMusic() begins the rotating battle scores when combat
    // begins so the two never overlap. Warm the music element so the first track buffers.
    try { this.music.load(); } catch {}
    // CRITICAL: prime the SECOND music element (musicB) inside this guaranteed user gesture.
    // The seamless-chaining crossfade calls musicB.play() from a setInterval callback, which is
    // OUTSIDE a fresh user gesture — browsers reject that autoplay unless this element has
    // already played once under a gesture. Without this priming, the first 30s segment plays
    // and then the next segment's play() is silently blocked, so music stops after 30 seconds.
    // Start it muted, then immediately pause back to zero to consume the autoplay permission.
    try {
      this.musicB.src = this.tracks[0].segments[0];
      this.musicB.muted = true;
      const pb = this.musicB.play();
      if (pb && pb.then) {
        pb.then(() => {
          this.musicB.pause();
          this.musicB.currentTime = 0;
          this.musicB.muted = this.muted;
          this.musicB.volume = 0;
        }).catch(() => { this.musicB.muted = this.muted; });
      }
    } catch { this.musicB.muted = this.muted; }
    // Warm the score + voice elements so they buffer now.
    try { this.score.load(); } catch {}
    try { this.voice.load(); } catch {}
    // Prime the VOICE element inside this guaranteed user gesture: start it, then pause it
    // back to the start. This consumes the autoplay permission so the real playVoice()
    // call (which fires from a timeout/rAF, OUTSIDE a fresh gesture) is allowed to play.
    // Without this, the briefing's play() can be rejected, leaving it paused-at-zero —
    // which both stalled combat (voice never "ends") AND made the line finally play on the
    // next gesture (the menu Start click), i.e. "at the end of the scene".
    try {
      this.voice.muted = true;
      await this.voice.play();
      this.voice.pause();
      this.voice.currentTime = 0;
      this.voice.muted = this.muted;
      this._voicePrimed = true;
    } catch { this.voice.muted = this.muted; }
  }

  // Play the cinematic score for the cutscene. Returns the element so callers can
  // fade or stop it on hand-off. Mute is respected.
  async playScore(volume = 0.5) {
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    this._decodeAll();
    this.score.volume = volume * this.musicLevel * this.masterLevel;
    this.score.muted = this.muted;
    this.score.currentTime = 0;
    try { await this.score.play(); } catch {}
    return this.score;
  }
  stopScore() {
    try { this.score.pause(); this.score.currentTime = 0; } catch {}
  }
  // Start the looping hyperspace-travel hum (faded in) while the ship is in the warp tunnel.
  // Scaled by the SFX/master mix so the Settings sliders affect it like other effects.
  startHum(volume = 0.5) {
    if (this.muted || !this.unlocked) return;
    const target = volume * this.sfxLevel * this.masterLevel;
    this.hum.muted = this.muted;
    if (this.hum.paused) { try { this.hum.currentTime = 0; this.hum.volume = 0; this.hum.play().catch(() => {}); } catch {} }
    this.fade(this.hum, Math.min(1, target), 350);
  }
  // Fade the hum out and stop it when the ship drops back to normal space.
  stopHum() {
    this.fade(this.hum, 0, 500, true);
  }

  // Drive the cockpit engine hum from the current throttle (0..1). Call every frame while in
  // first-person view. This plays the SAME looping hum sample as the hyperspace warp, but pitched
  // down (slower playbackRate) and quieter so it reads as the same engine running at relaxed
  // sublight power rather than straining through a warp tunnel. Throttle raises the volume and
  // gently bends the pitch up so the engine audibly spools with thrust. Smoothly faded so quick
  // throttle changes don't click. Pass active=false (or call stopEngineHum) to silence it.
  setEngineHum(throttle = 0, active = true) {
    this._engineThrottle = Math.max(0, Math.min(1, throttle));
    this._engineActive = !!active;
    const hum = this.engineHum;
    if (!hum) return;
    if (!active || this.muted || !this.unlocked) {
      // Fade to silence and pause once quiet so it doesn't keep the audio pipeline busy.
      this.fade(hum, 0, 200, true);
      return;
    }
    const t = this._engineThrottle;
    // Make sure the loop is running.
    hum.muted = this.muted;
    if (hum.paused) {
      try { hum.volume = 0; hum.play().catch(() => {}); } catch {}
    }
    // CONSTANT loudness while throttle is applied: the hum holds a steady level rather than swelling
    // with throttle. A small threshold so faint coasting velocity still counts as "running"; below
    // it the engine settles to a quiet idle floor. Overall level bumped up a bit per request.
    const running = t > 0.05;
    const target = this.engineHumLevel * this.sfxLevel * this.masterLevel * (running ? 0.85 : 0.30);
    hum.volume = Math.max(0, Math.min(1, target));
    // Pitch/spool: slow the sample well below its native rate (lower, less-stressed drone) and bend
    // it up with throttle, but never up to the warp hum's full-speed pitch.
    const rate = this._engineRateIdle + (this._engineRateFull - this._engineRateIdle) * t;
    try { hum.playbackRate = rate; } catch {}
  }

  // Silence the cockpit engine hum (smoothly) and pause it.
  stopEngineHum() {
    this._engineActive = false;
    if (this.engineHum) this.fade(this.engineHum, 0, 220, true);
  }
  // Begin the rotating gameplay soundtrack. Called when combat starts so it never overlaps the
  // cinematic score. Safe to call more than once. Starts the first segment of the current track
  // and arms the segment watcher that chains the rest together seamlessly.
  async startMusic(volume = 0.28) {
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    // `volume` is the soundtrack's DESIGN level; the user music/master mix scales it.
    this._baseMusicVolume = volume;
    this.musicVolume = this._effectiveMusicVolume();
    // Already playing? Just retarget the volume.
    if (this._activeMusic && !this._activeMusic.paused && this._activeMusic.currentTime > 0) {
      this._activeMusic.volume = this.musicVolume;
      return;
    }
    this.segIndex = 0;
    this.trackLoop = 0;
    this._trackElapsed = 0;
    const track = this.tracks[this.trackIndex];
    const el = this._activeMusic;
    el.src = track.segments[0];
    el.muted = this.muted;
    el.volume = this.musicVolume;
    el.currentTime = 0;
    try { await el.play(); } catch {}
    this._armSegWatch();
  }

  // Halt the rotating battle soundtrack: stop the segment watcher and fade both music elements
  // out. Used when a cinematic (e.g. the Mission 3 cutscene) wants its own score to own the mix;
  // a later startMusic() restarts the rotation cleanly.
  stopMusic(fadeMs = 600) {
    if (this._segWatch) { clearInterval(this._segWatch); this._segWatch = null; }
    this._seamToken = (this._seamToken || 0) + 1;   // invalidate any pending seam advance
    for (const el of [this.music, this.musicB]) {
      if (!el) continue;
      el.onended = null;
      this.fade(el, 0, fadeMs, true);
    }
  }

  // Watch the live element and, ~CROSSFADE_MS before it ends, pre-roll the NEXT segment on the
  // idle element and crossfade between them. This produces a seamless join across 30s segments,
  // so a multi-segment themed track plays as one continuous ~2-minute sweep, repeated to fill
  // ~4 minutes before advancing to the next theme.
  _armSegWatch() {
    if (this._segWatch) { clearInterval(this._segWatch); this._segWatch = null; }
    // A monotonic token identifying the CURRENT live segment. Every advance bumps it, and the
    // advance itself is keyed to the token it was triggered for, so the interval watcher and the
    // `ended` safety net can both fire for the same seam yet only ONE crossfade ever runs. This
    // is what was causing tracks to "jump around": two triggers double/triple-advanced the
    // segment index, skipping segments and crossing into other tracks early.
    const myToken = ++this._seamToken;
    const live = this._activeMusic;
    // Safety net: if the interval ever misses the crossfade window (e.g. a backgrounded tab
    // throttles setInterval), the element's own `ended` event still advances the chain.
    if (live) {
      live.onended = () => { this._advanceSegment(myToken); };
    }
    this._segWatch = setInterval(() => {
      const el = this._activeMusic;
      if (!el || !el.duration || isNaN(el.duration)) return;
      const remaining = (el.duration - el.currentTime) * 1000;
      if (remaining <= this.CROSSFADE_MS) {
        this._advanceSegment(myToken);
      }
    }, 80);
  }

  // Advance to the next segment, but only once per seam. `token` must match the seam this call
  // was armed for; any later or duplicate trigger for the same/old seam is ignored. This makes
  // segment ordering deterministic: each segment plays in order to the end of its track, then
  // the track advances.
  _advanceSegment(token) {
    if (token !== this._seamToken) return;   // stale trigger (already advanced) — ignore
    if (this._advancing) return;             // re-entrancy guard
    this._advancing = true;
    // Stop this seam's watcher immediately so it can't fire again mid-crossfade.
    if (this._segWatch) { clearInterval(this._segWatch); this._segWatch = null; }
    const out = this._activeMusic;
    if (out) out.onended = null;             // drop the stale safety-net handler

    const track = this.tracks[this.trackIndex];
    this._trackElapsed += 30000;             // account for the ~30s segment we are leaving
    let nextSeg = this.segIndex + 1;
    let nextTrackIndex = this.trackIndex;
    let advancedTrack = false;

    if (nextSeg >= track.segments.length) {
      // Reached the final segment of this track. Either repeat the whole sequence (to fill the
      // ~4-minute slot) or move on to segment 1 of the next track.
      nextSeg = 0;
      this.trackLoop += 1;
      if (this._trackElapsed >= this.TARGET_TRACK_MS) {
        nextTrackIndex = (this.trackIndex + 1) % this.tracks.length;
        advancedTrack = true;
      }
    }

    const nextUrl = this.tracks[nextTrackIndex].segments[nextSeg];
    const incoming = this._idleMusic;
    try {
      incoming.src = nextUrl;
      incoming.currentTime = 0;
      incoming.muted = this.muted;
      incoming.volume = 0;
      const p = incoming.play();
      // Retry a rejected play() so one blocked seam can't permanently silence the soundtrack.
      if (p && p.catch) p.catch(() => {
        setTimeout(() => { if (incoming.paused) incoming.play().catch(() => {}); }, 60);
      });
    } catch {}

    // Crossfade incoming up, outgoing down (then stop the outgoing element).
    this.fade(incoming, this.musicVolume, this.CROSSFADE_MS);
    this.fade(out, 0, this.CROSSFADE_MS, true);

    // Commit the new state: incoming is live, old element becomes idle.
    this._activeMusic = incoming;
    this._idleMusic = out;
    this.segIndex = nextSeg;
    if (advancedTrack) {
      this.trackIndex = nextTrackIndex;
      this.trackLoop = 0;
      this._trackElapsed = 0;
    }
    this._advancing = false;
    // Re-arm against the now-live element (bumps the seam token) for the following seam.
    this._armSegWatch();
  }
  // Play the Overwatch briefing voice-over. `onEnded` fires when the clip finishes (or
  // immediately on a hard playback failure) so the caller can start combat on cue.
  async playVoice(volume = 0.95, onEnded = null) {
    // Guard against double-invocation: the briefing must play exactly once.
    if (this._voicePlaying) return this.voice;
    this._voicePlaying = true;
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    const el = this.voice;
    el.muted = this.muted;
    el.volume = volume;
    try { el.currentTime = 0; } catch {}
    // Resolve the cue when the clip finishes. We do NOT fire onEnded on a play()
    // rejection — that would skip the briefing and start combat instantly. Instead the
    // caller's safety timeout covers a blocked/stalled clip, so a real failure simply
    // delays combat rather than playing no voice and fighting immediately.
    if (onEnded) {
      const done = () => { el.onended = null; onEnded(); };
      el.onended = done;
    }
    try {
      await el.play();
    } catch (e) {
      // Blocked: retry once on the next tick, but only if it truly didn't start, so we
      // never kick off a second overlapping playback.
      setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 80);
    }
    return el;
  }
  // Play an arbitrary one-shot voice/cue clip from a URL, firing `onEnded` when it finishes (or
  // on a hard failure / safety timeout) so the caller can sequence what comes next. Used for
  // mission-specific briefing lines. Each URL gets its own cached Audio element.
  playClip(url, volume = 0.95, onEnded = null) {
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
    if (!this._clips) this._clips = {};
    let el = this._clips[url];
    if (!el) { el = new Audio(url); el.preload = 'auto'; this._clips[url] = el; }
    el.muted = this.muted;
    el.volume = Math.min(1, Math.max(0, volume * this.masterLevel));
    try { el.currentTime = 0; } catch {}
    let fired = false;
    const finish = () => { if (fired) return; fired = true; el.onended = null; el.onloadedmetadata = null; clearTimeout(t); if (onEnded) onEnded(); };
    el.onended = finish;
    // Safety net: if metadata says the clip is ~N seconds, guarantee onEnded fires a touch after
    // that even if the 'ended' event is missed; fall back to a generous fixed timeout otherwise.
    let t = setTimeout(finish, 8000);
    const arm = () => { if (el.duration && !isNaN(el.duration)) { clearTimeout(t); t = setTimeout(finish, el.duration * 1000 + 400); } };
    el.onloadedmetadata = arm; arm();
    // Let the caller CANCEL the clip cleanly: stop playback AND disarm the ended/timeout callbacks so
    // onEnded can never fire later. Without this, skipping a briefing only paused the audio while the
    // safety-net timeout still fired at the clip's natural end — re-running the handoff and resetting
    // the mission to warp-in. _cancel(false) stays silent; default also pauses the audio.
    el._cancel = (stopAudio = true) => {
      fired = true;
      el.onended = null; el.onloadedmetadata = null; clearTimeout(t);
      if (stopAudio) { try { el.pause(); } catch {} }
    };
    const p = el.play();
    if (p && p.catch) p.catch(() => { setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 80); });
    return el;
  }
  // Play a voice clip with a layer of RADIO STATIC over it — used for wingman comms so their lines
  // read as crackly cockpit-radio transmissions. The voice plays through playClip (so onEnded/timeout
  // sequencing still works); on top of it we run a procedural noise bed through WebAudio for the
  // clip's duration: white noise pushed through a band-pass filter (radio-band hiss) plus a slow
  // tremolo so it breathes like a weak signal. `staticLevel` (0..1) sets the hiss loudness.
  playRadioClip(url, volume = 0.95, onEnded = null, staticLevel = 0.16) {
    const ctx = this._ensureCtx();
    let stopStatic = () => {};
    // Wrap the caller's onEnded so the static always stops when the voice finishes (or fails).
    const el = this.playClip(url, volume, () => { stopStatic(); if (onEnded) onEnded(); });
    if (ctx && !this.muted && staticLevel > 0) {
      try {
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
        // 2s of white noise, looped, as the static source.
        const dur = 2;
        const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf; src.loop = true;
        // Band-pass the noise into the voice band so it sits as comms hiss, not full-spectrum roar.
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
        // Slow tremolo on the static gain so the signal "breathes" (weak-radio feel).
        const gain = ctx.createGain();
        const base = staticLevel * this.masterLevel;
        gain.gain.value = base;
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 3.3; lfoGain.gain.value = base * 0.5;
        lfo.connect(lfoGain).connect(gain.gain);
        src.connect(bp).connect(gain).connect(ctx.destination);
        src.start();
        lfo.start();
        let stopped = false;
        stopStatic = () => {
          if (stopped) return; stopped = true;
          try {
            const now = ctx.currentTime;
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(gain.gain.value, now);
            gain.gain.linearRampToValueAtTime(0.0001, now + 0.12);   // quick fade so it doesn't click off
            src.stop(now + 0.16); lfo.stop(now + 0.16);
          } catch {}
        };
        // Hard safety stop in case the voice 'ended' is somehow missed (mirrors playClip's net).
        setTimeout(() => stopStatic(), 12000);
      } catch { stopStatic = () => {}; }
    }
    return el;
  }
  // Play a SEQUENCE of voice clips back-to-back, waiting `gapMs` between the end of one clip and
  // the start of the next. Returns a small handle with cancel() so transitions (bail to menu, etc.)
  // can stop a partially-played briefing. onAllEnded fires once the final clip finishes.
  playClipSequence(urls, { volume = 0.95, gapMs = 500, onAllEnded = null, onClipStart = null } = {}) {
    const handle = { cancelled: false, _timer: null, _el: null };
    let i = 0;
    const playNext = () => {
      if (handle.cancelled) return;
      if (i >= urls.length) { if (onAllEnded) onAllEnded(); return; }
      const url = urls[i++];
      handle._el = this.playClip(url, volume, () => {   // remember the live element so cancel() can silence it
        if (handle.cancelled) return;
        handle._timer = setTimeout(playNext, gapMs);   // half-second (default) beat between lines
      });
      // Hand the caller the URL + live <audio> element so it can sync a caption track to this line.
      if (onClipStart) { try { onClipStart(url, handle._el); } catch {} }
    };
    playNext();
    handle.cancel = () => {
      handle.cancelled = true;
      clearTimeout(handle._timer);
      // Silence the line that's mid-play so a skip cuts the voice immediately (pausing won't re-fire onEnded).
      if (handle._el) { try { handle._el.pause(); } catch {} handle._el = null; }
    };
    return handle;
  }

  // Play the Scaavi "shields failing" combat bark. Self-guards against re-triggering while it is
  // already playing so a sustained low-shield state can't stutter the line every frame; the caller
  // also re-arms it only when shields recover, so it fires once per crisis.
  playScaaviShieldsFailing(volume = 0.95) {
    const el = this.scaaviShieldsFailing;
    if (!el) return null;
    // Already mid-line: leave it be.
    if (!el.paused && el.currentTime > 0 && !el.ended) return el;
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
    el.muted = this.muted;
    el.volume = Math.min(1, Math.max(0, volume * this.masterLevel));
    try { el.currentTime = 0; } catch {}
    const p = el.play();
    if (p && p.catch) p.catch(() => { setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 80); });
    return el;
  }

  // Play an arbitrary SCAAVI combat bark from `src` (blue SCAAVI or red Crimson SCAAVI) on the
  // shared bark channel. Self-guards while a line is already playing so a burst of hits can't
  // stutter or stack barks; the gameplay code arms each alert with its own hysteresis. Swaps the
  // element's source only when the requested line changes. Returns the <audio> element for caption
  // syncing (or null if muted-out of playing).
  playScaaviLine(src, volume = 0.95) {
    const el = this.scaaviBark;
    if (!el || !src) return null;
    // A line is mid-playback: don't interrupt it.
    if (!el.paused && el.currentTime > 0 && !el.ended) return el;
    if (this._scaaviBarkSrc !== src) { el.src = src; this._scaaviBarkSrc = src; try { el.load(); } catch {} }
    this.unlocked = true;
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
    el.muted = this.muted;
    el.volume = Math.min(1, Math.max(0, volume * this.masterLevel));
    try { el.currentTime = 0; } catch {}
    const p = el.play();
    if (p && p.catch) p.catch(() => { setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 80); });
    return el;
  }
  // Smoothly fade a media element's volume to a target over ms, then optional stop.
  fade(el, to, ms = 800, stop = false) {
    if (!el) return;
    const from = el.volume;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / ms);
      // Clamp to [0,1]: floating-point error in the lerp can land a hair below 0 (e.g.
      // -0.00006 when fading to 0), which throws an IndexSizeError on HTMLMediaElement.volume.
      el.volume = Math.min(1, Math.max(0, from + (to - from) * k));
      if (k < 1) requestAnimationFrame(step);
      else if (stop) { try { el.pause(); } catch {} }
    };
    requestAnimationFrame(step);
  }
  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }
  setMuted(m) {
    this.muted = !!m;
    this.music.muted = this.muted;
    this.musicB.muted = this.muted;
    this.score.muted = this.muted;
    this.voice.muted = this.muted;
    if (this.scaaviShieldsFailing) this.scaaviShieldsFailing.muted = this.muted;
    if (this.scaaviBark) this.scaaviBark.muted = this.muted;
    this.hum.muted = this.muted;
    // The procedural lock tone routes straight to the AudioContext, so mute won't touch it —
    // tear it down explicitly. It re-arms on the next updateLockTone() once unmuted.
    if (this.muted) this.stopLockTone();
    // Mute/restore the sample-based cockpit engine hum to match the mute state. On unmute, if the
    // hum should be active, push the throttle-derived level straight back so it returns instantly.
    if (this.engineHum) {
      this.engineHum.muted = this.muted;
      if (!this.muted && this._engineActive) {
        const running = this._engineThrottle > 0.05;
        this.engineHum.volume = Math.max(0, Math.min(1,
          this.engineHumLevel * this.sfxLevel * this.masterLevel * (running ? 0.85 : 0.30)));
        if (this.engineHum.paused && this.unlocked) { try { this.engineHum.play().catch(() => {}); } catch {} }
      }
    }
  }

  // Effective soundtrack volume after the master + music mix is applied.
  _effectiveMusicVolume() {
    return this._baseMusicVolume * this.musicLevel * this.masterLevel;
  }
  // Push the current music mix to whichever element is live so changes are heard instantly.
  _applyMusicLevel() {
    this.musicVolume = this._effectiveMusicVolume();
    if (this._activeMusic && !this._activeMusic.paused) this._activeMusic.volume = this.musicVolume;
    // The cinematic score rides the music bus too (scaled from its own design level of 0.5).
    if (this.score && !this.score.paused) this.score.volume = 0.5 * this.musicLevel * this.masterLevel;
  }
  setMasterLevel(v) { this.masterLevel = Math.max(0, Math.min(1, v)); this._applyMusicLevel(); }
  setMusicLevel(v)  { this.musicLevel  = Math.max(0, Math.min(1, v)); this._applyMusicLevel(); }
  setSfxLevel(v)    { this.sfxLevel    = Math.max(0, Math.min(1, v)); }

  // --- Missile lock tone (procedural WebAudio) ---
  // While acquiring a lock we emit a periodic "search" beep whose repeat rate accelerates as the
  // lock tightens (classic radar-lock cadence). Once locked it switches to a steady, continuous
  // "flat-line" solid tone. All synthesized so there's no asset dependency and the cadence can be
  // driven directly by lock progress. Call updateLockTone(progress01, locked) every frame, and
  // stopLockTone() when the lockable target is gone / lock is broken.
  _ensureLockChain() {
    const ctx = this._ensureCtx();
    if (!ctx) return null;
    if (!this._lockGain) {
      this._lockGain = ctx.createGain();
      this._lockGain.gain.value = 0;
      this._lockGain.connect(ctx.destination);
    }
    return ctx;
  }
  // Schedule a single short beep (used for the accelerating acquisition cadence).
  _lockBeep(freq = 1180) {
    const ctx = this._ensureLockChain();
    if (!ctx || this.muted || !this.unlocked) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const vol = 0.22 * this.sfxLevel * this.masterLevel;
    if (vol <= 0.0001) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.004);
    g.gain.setValueAtTime(vol, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }
  // Drive the lock audio each frame. progress01 is 0..1 (lockProgress/LOCK_TIME); locked toggles
  // the continuous solid tone.
  updateLockTone(progress01 = 0, locked = false) {
    const ctx = this._ensureLockChain();
    if (!ctx) return;
    if (this.muted || !this.unlocked || (progress01 <= 0 && !locked)) { this.stopLockTone(); return; }

    if (locked) {
      // Steady "flat-line" solid tone. Lazily create a continuous oscillator and ramp it up.
      // Stop any acquisition beeping.
      this._lockBeepTimer = 1e9;
      const vol = 0.16 * this.sfxLevel * this.masterLevel;
      if (!this._lockOsc) {
        if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(1150, ctx.currentTime);
        osc.connect(this._lockGain);
        osc.start();
        this._lockOsc = osc;
      }
      try { this._lockGain.gain.cancelScheduledValues(ctx.currentTime); } catch {}
      this._lockGain.gain.setTargetAtTime(Math.max(0, vol), ctx.currentTime, 0.01);
      return;
    }

    // Acquiring: kill any solid tone, run the accelerating beep cadence.
    if (this._lockOsc) this.stopSolidTone();
    // Interval shrinks from ~0.5s (just starting) to ~0.1s (almost locked) as progress climbs.
    const p = Math.min(1, Math.max(0, progress01));
    const interval = 0.5 + (0.1 - 0.5) * p;
    const t = (ctx.currentTime);
    if (this._lockBeepTimer === undefined || this._lockBeepTimer > 1e8) this._lockBeepTimer = 0;
    if (t >= this._lockBeepTimer) {
      // Pitch rises slightly as it closes in.
      this._lockBeep(820 + 280 * Math.min(1, Math.max(0, progress01)));
      this._lockBeepTimer = t + interval;
    }
  }
  // Fade out + tear down the steady locked tone (leaves the beep cadence alone).
  stopSolidTone() {
    if (!this._lockOsc) return;
    const ctx = this.ctx;
    const osc = this._lockOsc;
    this._lockOsc = null;
    if (ctx && this._lockGain) {
      const now = ctx.currentTime;
      try { this._lockGain.gain.cancelScheduledValues(now); } catch {}
      try { this._lockGain.gain.setTargetAtTime(0, now, 0.02); } catch {}
      try { osc.stop(now + 0.12); } catch {}
    } else {
      try { osc.stop(); } catch {}
    }
  }
  // Silence all lock audio (acquisition beeps + solid tone).
  stopLockTone() {
    this.stopSolidTone();
    this._lockBeepTimer = undefined;
  }

  // Procedural HYDRAULIC touchdown: a pneumatic release hiss (filtered noise that
  // sweeps down) layered over a heavy mechanical "clunk" (low body thump + a metallic
  // tick) — the sound of landing gear taking the ship's weight on the hangar deck.
  // Fully synthesized so it needs no asset; routed through the SFX/master mix.
  playHydraulic(volume = 0.9) {
    const ctx = this._ensureCtx();
    if (!ctx || this.muted || !this.unlocked) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const vol = volume * this.sfxLevel * this.masterLevel;
    if (vol <= 0.0001) return;
    const now = ctx.currentTime;

    // --- Pneumatic hiss: white noise through a band-pass that sweeps downward, with a
    //     soft attack and a long release (the gas/air bleeding out of the strut). ---
    const dur = 0.9;
    const frames = Math.floor(ctx.sampleRate * dur);
    const noiseBuf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(2600, now);
    bp.frequency.exponentialRampToValueAtTime(420, now + dur);
    const hissGain = ctx.createGain();
    hissGain.gain.setValueAtTime(0.0001, now);
    hissGain.gain.exponentialRampToValueAtTime(vol * 0.5, now + 0.05);
    hissGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    noise.connect(bp).connect(hissGain).connect(ctx.destination);
    try { noise.start(now); noise.stop(now + dur); } catch {}

    // --- Heavy clunk: a low body thump (sine drop) for weight settling. ---
    const clunkT = now + 0.12;
    const thump = ctx.createOscillator(); thump.type = 'sine';
    thump.frequency.setValueAtTime(150, clunkT);
    thump.frequency.exponentialRampToValueAtTime(46, clunkT + 0.18);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, clunkT);
    thumpGain.gain.exponentialRampToValueAtTime(vol * 0.95, clunkT + 0.01);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, clunkT + 0.35);
    thump.connect(thumpGain).connect(ctx.destination);
    try { thump.start(clunkT); thump.stop(clunkT + 0.4); } catch {}

    // --- Metallic tick: a short high square blip on contact for the mechanical latch. ---
    const tick = ctx.createOscillator(); tick.type = 'square';
    tick.frequency.setValueAtTime(880, clunkT);
    tick.frequency.exponentialRampToValueAtTime(240, clunkT + 0.06);
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(vol * 0.22, clunkT);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, clunkT + 0.09);
    tick.connect(tickGain).connect(ctx.destination);
    try { tick.start(clunkT); tick.stop(clunkT + 0.1); } catch {}

    // --- Pressurized-air VENT: a longer, breathier high-pass noise jet layered over the hiss so
    //     the release reads as a forceful gush of steam, not just a soft strut bleed. ---
    const ventDur = 1.4;
    const vFrames = Math.floor(ctx.sampleRate * ventDur);
    const ventBuf = ctx.createBuffer(1, vFrames, ctx.sampleRate);
    const vData = ventBuf.getChannelData(0);
    for (let i = 0; i < vFrames; i++) vData[i] = Math.random() * 2 - 1;
    const vent = ctx.createBufferSource(); vent.buffer = ventBuf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(7000, clunkT);
    lp.frequency.exponentialRampToValueAtTime(1800, clunkT + ventDur);   // softens as it bleeds off
    const ventGain = ctx.createGain();
    ventGain.gain.setValueAtTime(0.0001, clunkT);
    ventGain.gain.exponentialRampToValueAtTime(vol * 0.42, clunkT + 0.08);
    ventGain.gain.setValueAtTime(vol * 0.42, clunkT + 0.45);
    ventGain.gain.exponentialRampToValueAtTime(0.0001, clunkT + ventDur);
    vent.connect(hp).connect(lp).connect(ventGain).connect(ctx.destination);
    try { vent.start(clunkT); vent.stop(clunkT + ventDur); } catch {}

    // --- Hydraulic GROAN: a low detuned saw that bends down as pistons take the load — the
    //     mechanical "noise" of the gear compressing. ---
    const groanT = now + 0.05;
    const groan = ctx.createOscillator(); groan.type = 'sawtooth';
    groan.frequency.setValueAtTime(120, groanT);
    groan.frequency.exponentialRampToValueAtTime(60, groanT + 0.5);
    const groanLP = ctx.createBiquadFilter(); groanLP.type = 'lowpass'; groanLP.frequency.value = 320;
    const groanGain = ctx.createGain();
    groanGain.gain.setValueAtTime(0.0001, groanT);
    groanGain.gain.exponentialRampToValueAtTime(vol * 0.3, groanT + 0.08);
    groanGain.gain.exponentialRampToValueAtTime(0.0001, groanT + 0.6);
    groan.connect(groanLP).connect(groanGain).connect(ctx.destination);
    try { groan.start(groanT); groan.stop(groanT + 0.65); } catch {}

    // --- Secondary settle: a softer follow-up clunk + short hiss as residual pressure bleeds off,
    //     timed to match the hangar's second steam release. ---
    const t2 = now + 0.42;
    const thump2 = ctx.createOscillator(); thump2.type = 'sine';
    thump2.frequency.setValueAtTime(110, t2);
    thump2.frequency.exponentialRampToValueAtTime(42, t2 + 0.16);
    const thump2Gain = ctx.createGain();
    thump2Gain.gain.setValueAtTime(0.0001, t2);
    thump2Gain.gain.exponentialRampToValueAtTime(vol * 0.5, t2 + 0.01);
    thump2Gain.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.3);
    thump2.connect(thump2Gain).connect(ctx.destination);
    try { thump2.start(t2); thump2.stop(t2 + 0.34); } catch {}
  }

  // Play the cached hyperspace warp SFX (used when the ship leaps to lightspeed off the
  // hangar deck after an upgrade pick). Thin wrapper over play() so callers read clearly.
  // When a shipId is supplied, use that hull's OWN warp signature (see playShipWarp).
  playWarp(volume = 0.85, shipId = null) {
    if (shipId) return this.playShipWarp(shipId, volume);
    this.play('warp', volume);
  }

  // Play a hull's bespoke hyperspace-jump SFX (spool-up -> lightspeed whoosh -> tunnel drone),
  // built from the same tonal character as its engine-select ignition. Used for BOTH warp-in and
  // warp-out so each ship keeps its own sonic identity through the jump. Unmapped ids fall back to
  // the generic 'warp' sample so callers never hit silence.
  playShipWarp(shipId, volume = 0.85) {
    const key = 'warp-' + shipId;
    this.play(this.sfx[key] ? key : 'warp', volume);
  }

  // Crisp UPGRADE-SELECT cue: a bright rising two-note chime over a quick filtered "whoosh"
  // sweep, so picking a card lands with a clean, confident confirmation. Fully synthesized
  // (no asset dependency), routed through the SFX/master mix.
  playCardSelect(volume = 0.9) {
    const ctx = this._ensureCtx();
    if (!ctx || this.muted || !this.unlocked) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const vol = volume * this.sfxLevel * this.masterLevel;
    if (vol <= 0.0001) return;
    const now = ctx.currentTime;

    // --- Two-note confirmation chime (bright triangle tones, second a fifth up). ---
    const notes = [
      { f: 784, t: 0.00, d: 0.26, g: 0.55 },   // G5
      { f: 1175, t: 0.07, d: 0.34, g: 0.5 }    // D6 — sparkle on top
    ];
    for (const n of notes) {
      const t0 = now + n.t;
      const osc = ctx.createOscillator(); osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.f, t0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol * n.g, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.d);
      osc.connect(g).connect(ctx.destination);
      try { osc.start(t0); osc.stop(t0 + n.d + 0.02); } catch {}
    }

    // --- A short upward whoosh: band-passed noise whose centre frequency sweeps up, giving the
    //     chime a sense of "lift" that matches the card spinning up and off the screen. ---
    const dur = 0.42;
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(600, now);
    bp.frequency.exponentialRampToValueAtTime(4200, now + dur);   // sweep up = "lift"
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.exponentialRampToValueAtTime(vol * 0.3, now + 0.04);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    noise.connect(bp).connect(ng).connect(ctx.destination);
    try { noise.start(now); noise.stop(now + dur); } catch {}
  }

  // LIFT-OFF cue: a deep engine spool-up — a low rising rumble (saw that bends up as the thrusters
  // build) layered with a swelling filtered-noise jet, capped by a soft thrust "whump" as the ship
  // unsticks from the deck. Played the instant the fighter lifts off the hangar pad after an upgrade.
  // Fully synthesized (no asset), routed through the SFX/master mix.
  playLiftoff(volume = 0.85) {
    const ctx = this._ensureCtx();
    if (!ctx || this.muted || !this.unlocked) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const vol = volume * this.sfxLevel * this.masterLevel;
    if (vol <= 0.0001) return;
    const now = ctx.currentTime;

    // --- Engine rumble: a detuned low saw whose pitch bends UP as the thrusters spool, lowpassed
    //     so it reads as a deep, building powerplant rather than a buzzy tone. ---
    const dur = 1.1;
    const rumble = ctx.createOscillator(); rumble.type = 'sawtooth';
    rumble.frequency.setValueAtTime(48, now);
    rumble.frequency.exponentialRampToValueAtTime(150, now + dur);   // spool up
    const rumble2 = ctx.createOscillator(); rumble2.type = 'sawtooth';
    rumble2.frequency.setValueAtTime(51, now);                       // slight detune for body
    rumble2.frequency.exponentialRampToValueAtTime(156, now + dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, now);
    lp.frequency.exponentialRampToValueAtTime(900, now + dur);       // opens up as it powers on
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.exponentialRampToValueAtTime(vol * 0.7, now + 0.18);
    rg.gain.setValueAtTime(vol * 0.7, now + dur * 0.7);
    rg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    rumble.connect(lp); rumble2.connect(lp); lp.connect(rg).connect(ctx.destination);
    try { rumble.start(now); rumble.stop(now + dur + 0.05); rumble2.start(now); rumble2.stop(now + dur + 0.05); } catch {}

    // --- Thruster jet: band-passed white noise that swells with the burn, giving the rumble an
    //     airy exhaust roar on top. ---
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const jet = ctx.createBufferSource(); jet.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(500, now);
    bp.frequency.exponentialRampToValueAtTime(1700, now + dur);
    const jg = ctx.createGain();
    jg.gain.setValueAtTime(0.0001, now);
    jg.gain.exponentialRampToValueAtTime(vol * 0.34, now + 0.25);
    jg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    jet.connect(bp).connect(jg).connect(ctx.destination);
    try { jet.start(now); jet.stop(now + dur); } catch {}

    // --- Thrust "whump": a soft low sine pop as the ship breaks contact with the pad. ---
    const wt = now + 0.06;
    const whump = ctx.createOscillator(); whump.type = 'sine';
    whump.frequency.setValueAtTime(120, wt);
    whump.frequency.exponentialRampToValueAtTime(40, wt + 0.3);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, wt);
    wg.gain.exponentialRampToValueAtTime(vol * 0.55, wt + 0.02);
    wg.gain.exponentialRampToValueAtTime(0.0001, wt + 0.36);
    whump.connect(wg).connect(ctx.destination);
    try { whump.start(wt); whump.stop(wt + 0.4); } catch {}
  }

  // STEREO ENGINE FLY-BY: a procedural pack-of-fighters whoosh that pans from the RIGHT speaker to
  // the LEFT over `durationSec`, tracking the ambush strafers screaming across the screen from the
  // top-right to the bottom-left. Built from band-passed noise (jet roar) layered with a couple of
  // detuned low saws (engine body) whose pitch bends DOWN as the pack passes (Doppler fall), the
  // whole thing fed through a StereoPannerNode that sweeps +1 -> -1. Volume swells as it approaches
  // and fades as it recedes. Fully synthesized — no asset dependency — and routed through the SFX
  // mix. Returns a small handle with stop() so a skip can cut it short.
  playFlyby(durationSec = 2.2, volume = 0.7) {
    const ctx = this._ensureCtx();
    if (!ctx || this.muted || !this.unlocked) return { stop() {} };
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const vol = volume * this.sfxLevel * this.masterLevel;
    if (vol <= 0.0001) return { stop() {} };
    const now = ctx.currentTime;
    const dur = Math.max(0.6, durationSec);
    const end = now + dur;

    // Stereo panner sweeping RIGHT (+1) -> LEFT (-1) across the pass.
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(1, now);
    panner.pan.linearRampToValueAtTime(-1, end);

    // Master swell: ramp up as the pack nears the centre, then fall away as it screams off-frame.
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0.0001, now);
    swell.gain.exponentialRampToValueAtTime(vol, now + dur * 0.42);   // approach
    swell.gain.exponentialRampToValueAtTime(0.0001, end);             // recede
    swell.connect(panner).connect(ctx.destination);

    // --- Jet roar: white noise through a band-pass whose centre frequency falls (Doppler). ---
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(2200, now);
    bp.frequency.exponentialRampToValueAtTime(700, end);             // pitch/timbre drops as it passes
    const ng = ctx.createGain(); ng.gain.value = 0.7;
    noise.connect(bp).connect(ng).connect(swell);

    // --- Engine body: two detuned low saws bending down (the powerplant Doppler-shifting past). ---
    const oscs = [];
    for (const f0 of [150, 156]) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0 * 1.18, now);                  // higher approaching
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.72, end);    // lower receding
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const og = ctx.createGain(); og.gain.value = 0.22;
      osc.connect(lp).connect(og).connect(swell);
      oscs.push(osc);
    }

    try { noise.start(now); noise.stop(end + 0.05); } catch {}
    for (const o of oscs) { try { o.start(now); o.stop(end + 0.05); } catch {} }

    let stopped = false;
    return {
      stop() {
        if (stopped) return; stopped = true;
        try {
          const t = ctx.currentTime;
          swell.gain.cancelScheduledValues(t);
          swell.gain.setValueAtTime(Math.max(0.0001, swell.gain.value), t);
          swell.gain.linearRampToValueAtTime(0.0001, t + 0.12);
          noise.stop(t + 0.16);
          for (const o of oscs) o.stop(t + 0.16);
        } catch {}
      }
    };
  }

  // ============================================================================================
  // SPATIAL / POSITIONAL AUDIO for multiplayer nearby ships.
  //
  // Uses the WebAudio 3D scene: an AudioListener fixed to the player's camera (position +
  // forward/up orientation), plus a PannerNode per emitter so a nearby pilot's engine and their
  // laser fire pan to the CORRECT side (left/right/front/back) and attenuate with distance. This
  // is what lets you hear another fighter's engine when they fly close and hear a "fly-by" whoosh
  // sweep across the correct stereo side as they scream past.
  //
  // Coordinates are the game's world units. Distance falloff uses the 'inverse' model tuned so a
  // ship reads clearly within ~a few dozen units and fades out by a couple hundred.
  // ============================================================================================

  // Lazily build a spatial audio bus (a master gain feeding the destination) + configure the
  // listener's distance model defaults. Returns the AudioContext or null if unavailable.
  _ensureSpatial() {
    const ctx = this._ensureCtx();
    if (!ctx) return null;
    if (!this._spatialGain) {
      this._spatialGain = ctx.createGain();
      this._spatialGain.gain.value = 1;
      this._spatialGain.connect(ctx.destination);
      this._engines = new Map();   // id -> { src, panner, gain, filter, playing }
      this._flybys = new Map();    // id -> { lastDist, cooldownUntil }
    }
    return ctx;
  }

  // Build a PannerNode tuned for the space-combat scale. HRTF gives real left/right/front/back
  // placement over headphones; the inverse distance model fades an emitter out over ~200 units.
  _makePanner(ctx) {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 14;       // full volume within ~14 units
    p.maxDistance = 600;
    p.rolloffFactor = 1.1;    // how quickly it fades with distance
    return p;
  }

  // Position + orient the WebAudio listener from the render camera, every frame during Free Flight.
  // Without this, all spatial emitters collapse to the origin and lose their directionality.
  updateListener(camera) {
    const ctx = this._ensureSpatial();
    if (!ctx || !camera) return;
    const L = ctx.listener;
    const p = camera.position;
    // Forward = -Z of the camera; up = +Y of the camera, both in world space.
    const e = camera.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    const t = ctx.currentTime;
    // Prefer the modern AudioParam interface; fall back to the deprecated setters for older builds.
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02);
      L.positionY.setTargetAtTime(p.y, t, 0.02);
      L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(fx, t, 0.02);
      L.forwardY.setTargetAtTime(fy, t, 0.02);
      L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.setTargetAtTime(ux, t, 0.02);
      L.upY.setTargetAtTime(uy, t, 0.02);
      L.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      try { L.setPosition(p.x, p.y, p.z); } catch {}
      try { L.setOrientation(fx, fy, fz, ux, uy, uz); } catch {}
    }
  }

  // Write a panner's world position (modern AudioParam or legacy setter).
  _setPannerPos(panner, x, y, z, ctx) {
    if (panner.positionX) {
      const t = ctx.currentTime;
      panner.positionX.setTargetAtTime(x, t, 0.02);
      panner.positionY.setTargetAtTime(y, t, 0.02);
      panner.positionZ.setTargetAtTime(z, t, 0.02);
    } else {
      try { panner.setPosition(x, y, z); } catch {}
    }
  }

  // Drive a nearby remote ship's ENGINE hum, positioned in 3D. Call every frame with the ship's
  // world position and a 0..1 throttle; the engine spins up a looping procedural drone the first
  // time and pans/attenuates it to the ship's location so you hear it swell on the correct side as
  // they close. `id` is the pilot's stable session id so we reuse one emitter per ship.
  // Per-hull spatial-drone timbre so each pilot's engine has its OWN voice in the furball, echoing
  // the character of that ship's engine-select ignition rather than one shared generic drone.
  //   base   : idle oscillator frequency (Hz) — low = heavy rumble, high = whiny scream
  //   detune : ratio of the second osc to the first — wider = fatter/beatier body
  //   wave   : oscillator waveform ('sawtooth' bright/buzzy, 'square' hollow/mechanical, 'triangle' smooth)
  //   spool  : how hard the pitch climbs with throttle (fraction added at full throttle)
  //   lpIdle/lpOpen : lowpass cutoff (Hz) at idle and at full throttle (brightness)
  //   noiseHz/noiseQ/noiseGain : band-passed exhaust-air texture (freq, resonance, level)
  _engineProfile(shipId) {
    const P = {
      // BLUE team hulls
      lightning:   { base: 82,  detune: 1.05, wave: 'sawtooth', spool: 0.72, lpIdle: 560, lpOpen: 1500, noiseHz: 950,  noiseQ: 0.7, noiseGain: 0.34 },
      fury:        { base: 68,  detune: 1.08, wave: 'sawtooth', spool: 0.62, lpIdle: 480, lpOpen: 1300, noiseHz: 720,  noiseQ: 0.6, noiseGain: 0.42 },
      concept:     { base: 96,  detune: 1.03, wave: 'triangle', spool: 0.80, lpIdle: 700, lpOpen: 2100, noiseHz: 1300, noiseQ: 0.9, noiseGain: 0.26 },
      // RED team hulls
      interceptor: { base: 112, detune: 1.02, wave: 'sawtooth', spool: 0.95, lpIdle: 760, lpOpen: 2400, noiseHz: 1500, noiseQ: 1.0, noiseGain: 0.24 },
      fighter:     { base: 88,  detune: 1.06, wave: 'square',   spool: 0.70, lpIdle: 600, lpOpen: 1650, noiseHz: 1050, noiseQ: 0.7, noiseGain: 0.32 },
      bomber:      { base: 58,  detune: 1.10, wave: 'sawtooth', spool: 0.50, lpIdle: 420, lpOpen: 1050, noiseHz: 620,  noiseQ: 0.5, noiseGain: 0.50 },
    };
    return P[shipId] || P.lightning;
  }
  updateShipEngine(id, x, y, z, throttle01 = 0.5, shipId = 'lightning', vel = null, listenerPos = null) {
    const ctx = this._ensureSpatial();
    if (!ctx || this.muted || !this.unlocked) { this.stopShipEngine(id); return; }
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const prof = this._engineProfile(shipId);
    let eng = this._engines.get(id);
    // If the pilot swapped hulls mid-session, rebuild the emitter so the new timbre profile applies.
    if (eng && eng.shipId !== shipId) { this.stopShipEngine(id); eng = null; }
    if (!eng) {
      // Build the emitter: a detuned low oscillator pair (engine body) through a lowpass, into a
      // gain, into the spatial panner. The waveform, pitch, detune, brightness, and noise texture
      // all come from THIS hull's profile so a bomber rumbles and an interceptor screams.
      const panner = this._makePanner(ctx);
      const gain = ctx.createGain(); gain.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = prof.lpIdle;
      const oscA = ctx.createOscillator(); oscA.type = prof.wave; oscA.frequency.value = prof.base;
      const oscB = ctx.createOscillator(); oscB.type = prof.wave; oscB.frequency.value = prof.base * prof.detune;
      // A faint band-passed noise layer gives the drone some airy exhaust texture, tuned per hull.
      const dur = 2;
      const nb = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
      const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.frequency.value = prof.noiseHz; nbp.Q.value = prof.noiseQ;
      const nGain = ctx.createGain(); nGain.gain.value = prof.noiseGain;
      oscA.connect(lp); oscB.connect(lp);
      noise.connect(nbp).connect(nGain).connect(lp);
      lp.connect(gain).connect(panner).connect(this._spatialGain);
      try { oscA.start(); oscB.start(); noise.start(); } catch {}
      eng = { panner, gain, lp, oscA, oscB, shipId };
      this._engines.set(id, eng);
    }
    this._setPannerPos(eng.panner, x, y, z, ctx);
    // Engine loudness scales with throttle; the panner's distance model does the rest of the
    // "hear it only when they're close" work. Base level kept modest so a busy furball isn't a mush.
    const t = Math.max(0, Math.min(1, throttle01));
    const target = (0.18 + 0.5 * t) * this.engineHumLevel * this.sfxLevel * this.masterLevel;
    eng.gain.gain.setTargetAtTime(Math.max(0, target), ctx.currentTime, 0.08);
    // --- DOPPLER shift on the engine pitch for high-speed fly-bys ---------------------------
    // Project the ship's world velocity onto the line to the listener to get the RADIAL speed:
    // +Vr = receding (pitch should fall), -Vr = approaching (pitch should rise). Convert to a
    // frequency multiplier with the classic stationary-listener model f' = f * c / (c + Vr).
    // `c` is a tuned "sound speed" for the game scale — small enough that a fast strafe bends the
    // pitch audibly, large enough that ordinary maneuvering doesn't warble. Clamped so a network
    // velocity spike can't shriek/detune wildly, and only meaningful when the ship is really moving.
    let doppler = 1;
    if (vel && listenerPos) {
      const rx = x - listenerPos.x, ry = y - listenerPos.y, rz = z - listenerPos.z;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl > 0.001) {
        const vr = (vel.x * rx + vel.y * ry + vel.z * rz) / rl;   // radial velocity, +recede/-approach
        const C = 340;                                            // game-scale "speed of sound"
        doppler = C / (C + Math.max(-260, Math.min(260, vr)));    // clamp radial to keep it musical
        doppler = Math.max(0.72, Math.min(1.5, doppler));         // hard safety clamp on the multiplier
      }
    }
    eng._doppler = eng._doppler == null ? doppler : eng._doppler + (doppler - eng._doppler) * 0.35;  // smooth
    // Spool the pitch with throttle from THIS hull's idle base, by THIS hull's spool amount, so a
    // coasting ship idles at its own pitch and a boosting neighbour audibly winds up in-character.
    // The lowpass opens between the hull's idle/open cutoffs so a pushing engine also brightens.
    // The Doppler multiplier then bends that pitch up/down as the ship closes/recedes.
    const rate = prof.base * (1 + prof.spool * t) * eng._doppler;
    try { eng.oscA.frequency.setTargetAtTime(rate, ctx.currentTime, 0.06); } catch {}
    try { eng.oscB.frequency.setTargetAtTime(rate * prof.detune, ctx.currentTime, 0.06); } catch {}
    try { eng.lp.frequency.setTargetAtTime(prof.lpIdle + (prof.lpOpen - prof.lpIdle) * t, ctx.currentTime, 0.12); } catch {}
  }

  // Stop + tear down a ship's engine emitter (pilot left, died, or moved out of range for a while).
  stopShipEngine(id) {
    if (!this._engines) return;
    const eng = this._engines.get(id);
    if (!eng) return;
    this._engines.delete(id);
    const ctx = this.ctx;
    try {
      if (ctx) {
        eng.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        eng.oscA.stop(ctx.currentTime + 0.2);
        eng.oscB.stop(ctx.currentTime + 0.2);
      } else {
        eng.oscA.stop(); eng.oscB.stop();
      }
    } catch {}
  }

  // Fire a positioned one-shot LASER for a networked (remote) bolt so you hear enemy/ally fire from
  // the correct direction. Reuses the decoded laser buffers (player or enemy tone) through a panner.
  playSpatialLaser(x, y, z, enemy = false, volume = 0.7) {
    const ctx = this._ensureSpatial();
    if (!ctx || this.muted || !this.unlocked) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const buf = this.buffers[enemy ? 'enemyLaser' : 'laser'];
    if (!buf) { this._decodeAll(); return; }   // not decoded yet — skip this one, it'll work next time
    const panner = this._makePanner(ctx);
    this._setPannerPos(panner, x, y, z, ctx);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = volume * this.sfxLevel * this.masterLevel;
    src.connect(g).connect(panner).connect(this._spatialGain);
    try { src.start(0); } catch {}
    src.onended = () => { try { src.disconnect(); g.disconnect(); panner.disconnect(); } catch {} };
  }

  // FLY-BY detection + Doppler whoosh for a nearby remote ship. Call every frame with the ship's
  // world position and velocity relative to the LISTENER, plus the listener's position. When a fast
  // ship passes within the trigger radius (its distance was falling and just started rising = the
  // closest-approach moment), emit a short positioned whoosh so it screams past on the correct side.
  updateFlyby(id, x, y, z, speed, listenerPos, shipId = 'lightning', vel = null) {
    const ctx = this._ensureSpatial();
    if (!ctx || this.muted || !this.unlocked) return;
    const dx = x - listenerPos.x, dy = y - listenerPos.y, dz = z - listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let f = this._flybys.get(id);
    if (!f) { f = { lastDist: dist, cooldownUntil: 0 }; this._flybys.set(id, f); return; }
    const now = ctx.currentTime;
    const TRIGGER_RADIUS = 55;    // must be at least this close for a "buzz the tower" pass
    const MIN_SPEED = 45;         // and moving fast enough to read as a genuine strafe/fly-by
    // Closest-approach = distance stopped decreasing (was approaching, now receding) while inside
    // the radius and moving quickly. A cooldown stops a slow drift from retriggering repeatedly.
    if (dist <= TRIGGER_RADIUS && dist > f.lastDist && speed >= MIN_SPEED && now >= f.cooldownUntil) {
      f.cooldownUntil = now + 1.4;
      // Pass the ship's world velocity so the whoosh PANNER travels with the ship across its short
      // life, sweeping through the stereo field as it screams past instead of sitting at one point.
      this._spatialFlyby(x, y, z, dist, shipId, vel);
    }
    f.lastDist = dist;
  }

  // The positioned fly-by whoosh itself: band-passed noise + a detuned low saw pair whose pitch
  // bends DOWN (Doppler fall) over a short window, routed through a PannerNode fixed at the pass
  // point so the HRTF panning + distance model place it on the correct side. Closer passes are
  // louder. Distinct from the scripted cinematic playFlyby(), which pans a fixed R->L sweep.
  _spatialFlyby(x, y, z, dist, shipId = 'lightning', vel = null) {
    const ctx = this._ensureSpatial();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.75;
    const end = now + dur;
    // Louder the closer the pass (clamped); scaled by the SFX/master mix.
    const prox = Math.max(0.15, 1 - dist / 60);
    const vol = 0.85 * prox * this.sfxLevel * this.masterLevel;
    if (vol <= 0.0001) return;
    // Voice the whoosh with THIS hull's engine profile so the pass sounds like the ship going by —
    // its own tonal core (waveform + base pitch + detune) and its own exhaust-air texture — rather
    // than one generic sweep for every ship. The characteristic Doppler-fall sweep is preserved by
    // pitching everything UP as it approaches and DOWN as it recedes across the short window.
    const prof = this._engineProfile(shipId);
    const panner = this._makePanner(ctx);
    panner.refDistance = 20;
    // Sweep the emitter THROUGH the pass rather than pinning it at the closest-approach point: start
    // it back along the ship's travel and ramp it forward past the point over the whoosh's life, so
    // the HRTF panning swings across the stereo field (the classic "screams past your ear" motion)
    // and the direction always matches the ship's actual heading relative to the listener. Falls back
    // to a fixed point if no velocity was supplied. The travel is capped so a hyper-fast pass doesn't
    // fling the emitter absurdly far and collapse its level via distance rolloff.
    if (vel && (vel.x || vel.y || vel.z)) {
      const sp = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z) || 1;
      const travel = Math.min(sp * dur, 90);          // metres the emitter sweeps across the pass
      const ux = vel.x / sp, uy = vel.y / sp, uz = vel.z / sp;
      const half = travel * 0.5;
      const sx = x - ux * half, sy = y - uy * half, sz = z - uz * half;   // start: just before the point
      const ex = x + ux * half, ey = y + uy * half, ez = z + uz * half;   // end: just after the point
      if (panner.positionX) {
        panner.positionX.setValueAtTime(sx, now); panner.positionX.linearRampToValueAtTime(ex, end);
        panner.positionY.setValueAtTime(sy, now); panner.positionY.linearRampToValueAtTime(ey, end);
        panner.positionZ.setValueAtTime(sz, now); panner.positionZ.linearRampToValueAtTime(ez, end);
      } else {
        try { panner.setPosition(x, y, z); } catch {}   // legacy: no per-node automation, pin at point
      }
    } else {
      this._setPannerPos(panner, x, y, z, ctx);
    }
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0.0001, now);
    swell.gain.exponentialRampToValueAtTime(vol, now + dur * 0.35);
    swell.gain.exponentialRampToValueAtTime(0.0001, end);
    swell.connect(panner).connect(this._spatialGain);
    // Jet roar: this hull's exhaust-air noise, band-passed around ITS noise centre and swept DOWN
    // through the pass (Doppler). A rumbly hull (low noiseHz) roars, a hot hull (high) hisses/shrieks.
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = Math.max(0.5, prof.noiseQ);
    // Sweep the noise band from ~2.6x the hull's idle noise centre down to ~0.7x (approach -> recede).
    bp.frequency.setValueAtTime(prof.noiseHz * 2.6, now);
    bp.frequency.exponentialRampToValueAtTime(Math.max(120, prof.noiseHz * 0.7), end);
    const ng = ctx.createGain(); ng.gain.value = 0.5 + prof.noiseGain;
    noise.connect(bp).connect(ng).connect(swell);
    // Tonal core: the hull's own waveform + detuned pair, built up an octave from its idle base so
    // the pass reads as a fast, higher-energy version of its drone, then Doppler-swept down past it.
    const core = prof.base * 2;
    const oscs = [];
    for (const mult of [1, prof.detune]) {
      const f0 = core * mult;
      const osc = ctx.createOscillator(); osc.type = prof.wave;
      osc.frequency.setValueAtTime(f0 * 1.35, now);                          // approaching: pitched up
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.7, end);             // receding: pitched down
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = prof.lpOpen;
      const og = ctx.createGain(); og.gain.value = 0.22;
      osc.connect(lp).connect(og).connect(swell);
      oscs.push(osc);
    }
    try { noise.start(now); noise.stop(end + 0.05); } catch {}
    for (const o of oscs) { try { o.start(now); o.stop(end + 0.05); } catch {} }
    const cleanup = () => { try { swell.disconnect(); panner.disconnect(); } catch {} };
    noise.onended = cleanup;
  }

  // Tear down ALL spatial emitters (engines + flyby bookkeeping). Called when leaving a match so
  // no remote engine drone lingers after the arena is gone.
  stopAllSpatial() {
    if (this._engines) { for (const id of [...this._engines.keys()]) this.stopShipEngine(id); }
    if (this._flybys) this._flybys.clear();
  }

  // Fire a one-shot SFX via WebAudio buffer source. Falls back to a fresh
  // HTMLAudioElement if the buffer isn't decoded yet (e.g. very first shots).
  // Play a ship's engine power-up / ignition one-shot by hull id (e.g. 'lightning', 'bomber').
  // Falls back to the Lightning's engine tone for any unknown id so the cue always sounds.
  playShipEngine(shipId, volume = 0.6) {
    const key = 'engine-' + shipId;
    const resolved = this.sfx[key] ? key : 'engine-lightning';
    this.play(resolved, volume);
  }
  // `rate` optionally re-pitches the one-shot: playbackRate > 1 raises pitch (and shortens it),
  // < 1 lowers it. Used to nudge a decoded sample up/down a touch without re-baking the asset.
  play(name, volume = 0.5, rate = 1) {
    if (this.muted || !this.unlocked) return;
    const vol = volume * this.sfxLevel * this.masterLevel;   // apply the user SFX/master mix
    if (vol <= 0.0001) return;
    const ctx = this.ctx;
    const buf = this.buffers[name];
    if (ctx && buf) {
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (rate !== 1) src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g).connect(ctx.destination);
      try { src.start(0); } catch {}
      return;
    }
    // Fallback path (buffer not ready yet).
    const url = this.sfx[name];
    if (!url) return;
    const a = new Audio(url);
    a.volume = Math.min(1, Math.max(0, vol));
    if (rate !== 1) a.playbackRate = rate;
    a.play().catch(() => {});
    // Make sure decoding is underway so subsequent shots use the reliable path.
    this._decodeAll();
  }
}
