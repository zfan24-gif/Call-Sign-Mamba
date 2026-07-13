// ---- Multiplayer network client (Colyseus, authoritative server) -----------------------------
// PHASE 1: authoritative MOVEMENT netcode for the 12v12 arena. This client talks to the Colyseus
// server in /server-realtime (run it separately — see /server-realtime/README.md). The model:
//
//   • We send INPUT frames (steer/thrust/boost/roll) each render frame — never our position. The
//     server is the sole authority on where every ship is, which is the anti-cheat foundation.
//   • Our OWN ship uses CLIENT-SIDE PREDICTION: we apply local inputs immediately (via the shared
//     flight model) so controls feel instant, then RECONCILE against each server snapshot —
//     snapping to the server pose and replaying the inputs the server hasn't acknowledged yet.
//   • OTHER ships use SNAPSHOT INTERPOLATION: we render them ~100ms in the past, smoothly
//     interpolating between the last two server states so remote motion is fluid despite the
//     ~30 Hz update rate.
//
// GRACEFUL OFFLINE: if colyseus.js can't load or the server is unreachable, join() resolves to a
// disconnected session that renders no ghosts and reports connected=false, so Free Flight still
// flies solo without errors.
import * as THREE from 'three';
import { makeRemoteShip, explode, updateEngineTrails, disposeEngineEffects } from './scene.js';
import { stepShip } from './netFlightModel.js';
import { getShip, DEFAULT_SHIP_ID } from './shipRoster.js';

// Default server endpoint. localhost for development; swap to your hosted wss:// URL for production.
// (ws:// for local, wss:// required once the page itself is served over https.)
const DEFAULT_ENDPOINT = 'ws://localhost:2567';

// Render remote ships this far in the past (ms) so we always have two snapshots to interpolate
// between. The server now BOTH simulates AND patches at 30Hz (~33ms/patch), so ~66ms keeps just over
// two patches of cushion for smooth interpolation while shaving ~35ms of visual latency off remotes
// vs. the old 100ms buffer. Going much lower risks running out of snapshots and stuttering remotes.
const INTERP_DELAY_MS = 66;

// Module-scope scratch for the per-frame remote velocity measurement (avoids per-frame allocation).
const _velRaw = new THREE.Vector3();

// --- Local-ship reconciliation smoothing --------------------------------------------------------
// Reconciliation snaps the local prediction to the server's authoritative pose (then replays
// unacknowledged inputs). Under uneven frame rates the corrected pose can differ slightly from where
// we rendered last frame, and a hard copy makes that difference visible as a micro-snap/jitter. To
// hide it we keep a decaying VISUAL OFFSET: the gap between last frame's rendered pose and the fresh
// corrected pose. We render at `corrected + offset` and damp the offset toward zero over a few
// frames, so a correction eases in instead of popping. Genuinely large corrections (respawns,
// teleports, big desyncs) exceed the snap thresholds and are applied instantly so the ship never
// drifts far from truth.
const SMOOTH_POS_HALFLIFE = 0.06;   // seconds for the positional offset to halve (snappy but soft)
const SMOOTH_ROT_HALFLIFE = 0.05;   // seconds for the rotational offset to halve
const SMOOTH_POS_SNAP = 40;         // metres of error above which we snap instead of smoothing
const SMOOTH_ROT_SNAP = 0.9;        // radians of error above which we snap instead of smoothing

// --- Remote entity-interpolation robustness -----------------------------------------------------
// Snapshots are stamped on ARRIVAL, but the server emits them on a fixed cadence (30Hz -> ~33ms).
// Network + local-scheduling jitter makes arrivals uneven, which would distort the buffer's time
// spacing and cause interpolation stall/catch-up pops. We rebase each snapshot's timeline onto a
// SMOOTHED clock that advances by ~one patch interval per snapshot, gently nudged toward real arrival
// time so it can't drift. When the render cursor runs PAST the newest snapshot (a late/dropped
// packet), we briefly EXTRAPOLATE along the last segment's velocity instead of freezing, capped so a
// long gap can't fling the ship away.
const PATCH_INTERVAL_MS = 1000 / 30;   // expected server patch spacing (matches TICK_HZ/patch rate)
const SNAP_CLOCK_CATCHUP = 0.15;       // 0..1 pull of the smoothed snapshot clock toward real arrival
const MAX_EXTRAPOLATE_MS = 90;         // cap forward extrapolation past the newest snapshot (~3 patches)
const _recPos = new THREE.Vector3();      // freshly corrected authoritative-prediction position
const _recQuat = new THREE.Quaternion();  // freshly corrected authoritative-prediction orientation
const _prevPos = new THREE.Vector3();     // where the ship rendered last frame (pre-correction)
const _prevQuat = new THREE.Quaternion(); // last frame's rendered orientation
const _renderPos = new THREE.Vector3();   // corrected + decayed offset -> what we actually show
const _renderQuat = new THREE.Quaternion();
const _extrapVel = new THREE.Vector3();    // scratch for remote-ship forward extrapolation past newest snapshot

// Team label colors + engine-trail palette. Blue = 0, Red = 1.
const TEAM = {
  0: { color: '#8af0ff', palette: 'blue' },
  1: { color: '#ff8a9a', palette: 'red' },
};

// A remote pilot's rendered ship, driven by snapshot interpolation from a buffer of server states.
// `shipId` picks which playable hull to render so other pilots' chosen ships show correctly.
class RemoteShip {
  constructor(scene, team, name, shipId = DEFAULT_SHIP_ID, sessionId = '') {
    this.scene = scene;
    this.sessionId = sessionId;   // stable id used to key this ship's spatial engine emitter
    const t = TEAM[team] || TEAM[0];
    this.shipId = shipId;
    this.team = team;
    this.group = makeRemoteShip(shipId, t.palette);
    this.group.position.set(0, 0, 0);
    // userData shaped so the campaign HUD/targeting code can lock onto remote pilots just like any
    // other contact: it reads `kind`, `hp`/`maxHp` for the integrity bar, and `callSign` for the
    // readout. `remoteShip`/`team` let the HUD tint the bracket by faction. Combat health is driven
    // from authoritative server state each patch (see _reconcileRemotes).
    // MERGE the targeting/HUD fields onto the userData makeRemoteShip already populated — do NOT
    // replace it. makeRemoteShip stored trailGroup / modelHolder / model / engines there, and the
    // world-space engine trails are parented into that trailGroup. Overwriting userData with a fresh
    // literal (the previous bug) wiped trailGroup, so it was never added to the scene AND
    // attachEngineEffects fell back to parenting the trail UNDER the ship group. The puff vertices
    // are absolute WORLD coordinates, so re-transforming them by the ship's world matrix flung the
    // whole streak far from the hull (the "engine trails 500m in front of the pilot" artifact).
    Object.assign(this.group.userData, {
      remoteShip: true,
      kind: 'fighter',
      shipId,
      team,
      callSign: String(name || 'PILOT').toUpperCase().slice(0, 16),
      hp: 100, maxHp: 100,
    });
    this.label = makeLabelSprite(name || 'PILOT', t.color);
    this.label.position.set(0, 4.2, 0);
    this.group.add(this.label);
    scene.add(this.group);
    // The remote hull's engine trails live in a WORLD-space group (see makeRemoteShip). Parent it
    // into the scene so the streaks actually render, and remember it so dispose() can pull it out.
    this.trailGroup = this.group.userData.trailGroup || null;
    if (this.trailGroup) scene.add(this.trailGroup);
    // Ring buffer of timestamped server snapshots: { t, pos:Vector3, quat:Quaternion }.
    // `t` is a SMOOTHED timeline (see pushSnapshot), not raw arrival time, so uneven packet arrival
    // doesn't distort interpolation spacing. `_snapClock` is the running smoothed timestamp.
    this.buffer = [];
    this._snapClock = 0;   // smoothed timeline cursor for the last snapshot (0 = uninitialized)
    // Rendered-frame velocity of the interpolated pose (world units/sec), fed to the engine-trail
    // updater so newly-emitted exhaust anchors behind the moving ship. Estimated from the change in
    // rendered position each update. `_speed01` is a smoothed 0..1 throttle for the nozzle glow.
    this._vel = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._hasPrev = false;
    this._speed01 = 0;
    this._alive = true;
    // Per-hull top speed so the engine THROTTLE (0..1) that drives the exhaust glow + engine pitch is
    // normalized to THIS ship's own capability, not a fixed guess. Base sublight speed is 74 u/s
    // (matches the local flight model) scaled by the hull's speed stat; a small headroom factor
    // covers boosting so a hull at cruise reads mid-throttle and a boosting hull reaches full.
    const speedScale = (getShip(shipId).stats && getShip(shipId).stats.speed) || 1;
    this._maxSpeed = 74 * speedScale * 1.35;
  }
  // Replace the floating name sprite when a pilot's call sign changes/propagates after spawn. Rebuilds
  // the canvas sprite (cheap, only on an actual name change) and disposes the old one's GPU resources.
  setLabel(text) {
    const t = TEAM[this.team] || TEAM[0];
    const next = makeLabelSprite(text, t.color);
    next.position.copy(this.label ? this.label.position : new THREE.Vector3(0, 4.2, 0));
    if (this.label) {
      this.group.remove(this.label);
      if (this.label.material) { if (this.label.material.map) this.label.material.map.dispose(); this.label.material.dispose(); }
    }
    this.label = next;
    this.group.add(this.label);
  }
  setAlive(alive) {
    const a = !!alive;
    // Mirror alive onto userData so target-selection can skip dead pilots (a dead remote must not
    // stay lockable while it respawns, or the killer's lock + lock tone + brackets stick on a 0% hull).
    this.group.userData.alive = a;
    if (a === this._alive) { this.group.visible = a; return; }
    this._alive = a;
    this.group.visible = a;
    if (!a) {
      this._killTrails();
    } else {
      // Fresh life: forget the pre-death position so the respawn teleport isn't read as huge velocity.
      this._hasPrev = false;
      this._speed01 = 0;
      // Discard the pre-death snapshot history so interpolation/extrapolation can't streak the ship
      // across the map from its old position to the new spawn. The next pushSnapshot re-anchors the
      // smoothed clock and snaps the hull to the spawn point (buffer.length === 1 path).
      this.buffer.length = 0;
      this._snapClock = 0;
    }
  }
  // Wipe the exhaust so it vanishes the instant the ship dies (history + visible streak geometry).
  _killTrails() {
    this._speed01 = 0;
    this._vel.set(0, 0, 0);
    this._hasPrev = false;
    const engines = this.group.userData && this.group.userData.engines;
    if (engines) {
      for (const eng of engines) {
        // The ribbon trail keeps a world-space point history; clear it so it can't span the map.
        if (eng.trail) { if (eng.trail.userData) eng.trail.userData.history.length = 0; eng.trail.visible = false; }
        // The beam-puff pool ages out by age>=life; kill every live streak instantly and zero the
        // geometry alpha so nothing is drawn this frame while the pool is hidden.
        if (eng.puffs) {
          const ud = eng.puffs.userData;
          if (ud && ud.state) for (const p of ud.state) p.age = p.life;
          const alphaAttr = eng.puffs.geometry && eng.puffs.geometry.attributes && eng.puffs.geometry.attributes.alpha;
          if (alphaAttr) { alphaAttr.array.fill(0); alphaAttr.needsUpdate = true; }
          if (ud) ud.prevEmit = null;   // don't fill a warp segment from the pre-death emitter position
          eng.puffs.visible = false;
        }
        if (eng.core) eng.core.visible = false;
        if (eng.glow) eng.glow.visible = false;
        if (eng.hot) eng.hot.visible = false;
      }
    }
  }
  // Record a fresh authoritative snapshot for later interpolation. `now` is real arrival time
  // (performance.now). We do NOT stamp the snapshot with raw arrival time — network + local-scheduling
  // jitter makes arrivals uneven, and stamping raw arrival distorts the buffer's time spacing so the
  // render cursor stalls then catches up (visible micro-jitter). Instead we advance a SMOOTHED clock
  // by one patch interval per snapshot, then nudge it a fraction of the way toward real arrival so it
  // tracks the true rate without inheriting the per-packet jitter. The first snapshot seeds the clock.
  pushSnapshot(now, px, py, pz, qx, qy, qz, qw) {
    if (!this._snapClock || this.buffer.length === 0) {
      // First snapshot (or after a buffer wipe): anchor the smoothed clock to real arrival time.
      this._snapClock = now;
    } else {
      // Ideal next stamp is one patch interval after the previous smoothed stamp; pull it gently
      // toward the real arrival time so long-run drift can't accumulate, without copying the jitter.
      const ideal = this._snapClock + PATCH_INTERVAL_MS;
      this._snapClock = ideal + (now - ideal) * SNAP_CLOCK_CATCHUP;
      // Never let the smoothed clock run backwards or stall (guards a burst of late/reordered patches).
      if (this._snapClock <= this.buffer[this.buffer.length - 1].t) {
        this._snapClock = this.buffer[this.buffer.length - 1].t + 1;
      }
    }
    this.buffer.push({
      t: this._snapClock,
      pos: new THREE.Vector3(px, py, pz),
      quat: new THREE.Quaternion(qx, qy, qz, qw),
    });
    // Keep the buffer short (a second of history is plenty).
    while (this.buffer.length > 20) this.buffer.shift();
    if (this.buffer.length === 1) {
      // First snapshot: snap so we don't streak from the origin.
      this.group.position.copy(this.buffer[0].pos);
      this.group.quaternion.copy(this.buffer[0].quat);
    }
  }
  // Interpolate the rendered pose to `renderTime` (now - INTERP_DELAY_MS), then advance the engine
  // trails from the resulting rendered motion. `dt` (seconds) + `camera` drive the trail updater.
  // `audio` (optional) drives the positional engine drone + fly-by whoosh from the rendered motion.
  update(renderTime, dt = 0, camera = null, audio = null) {
    const buf = this.buffer;
    if (buf.length === 0) return;
    if (buf.length === 1) {
      this.group.position.copy(buf[0].pos);
      this.group.quaternion.copy(buf[0].quat);
    } else {
      const oldest = buf[0];
      const newest = buf[buf.length - 1];
      if (renderTime <= oldest.t) {
        // Cursor is before our history (just started, or a stall let it fall behind): clamp to oldest.
        this.group.position.copy(oldest.pos);
        this.group.quaternion.copy(oldest.quat);
      } else if (renderTime >= newest.t) {
        // Cursor has run PAST the newest snapshot — a late or dropped packet. Rather than FREEZE on
        // the last pose (which reads as a stall, then a catch-up pop when the next patch lands), keep
        // the ship moving by EXTRAPOLATING along the last segment's velocity, capped at
        // MAX_EXTRAPOLATE_MS so a long gap can't fling it away. Orientation holds at the newest
        // (extrapolating rotation tends to overshoot and look worse than a brief hold).
        const prev = buf[buf.length - 2];
        const segSpan = newest.t - prev.t;
        const ahead = Math.min(renderTime - newest.t, MAX_EXTRAPOLATE_MS);
        if (segSpan > 0 && ahead > 0) {
          const k = ahead / segSpan;   // fraction of the last segment to project forward
          this.group.position.copy(newest.pos).addScaledVector(_extrapVel.subVectors(newest.pos, prev.pos), k);
        } else {
          this.group.position.copy(newest.pos);
        }
        this.group.quaternion.copy(newest.quat);
      } else {
        // Normal case: find the two snapshots that straddle renderTime and interpolate between them.
        let a = oldest, b = newest;
        for (let i = 0; i < buf.length - 1; i++) {
          if (buf[i].t <= renderTime && buf[i + 1].t >= renderTime) { a = buf[i]; b = buf[i + 1]; break; }
        }
        const span = b.t - a.t;
        const alpha = span > 0 ? THREE.MathUtils.clamp((renderTime - a.t) / span, 0, 1) : 1;
        this.group.position.lerpVectors(a.pos, b.pos, alpha);
        this.group.quaternion.slerpQuaternions(a.quat, b.quat, alpha);
      }
    }
    // The engine-trail updater samples each nozzle's WORLD position (eng.group.getWorldPosition) to
    // spawn its world-space exhaust streaks. getWorldPosition reads matrixWorld, which the renderer
    // only refreshes during its own scene traversal LATER this frame — so without forcing an update
    // here the emitter would sample last frame's (stale) world matrix while the pose we just set is
    // brand new. That mismatch spawned streaks at the wrong world point ("trails in random places,
    // not emitting from the nozzles"). Recompute this ship's world matrices NOW so the emitter reads
    // the current tail position. (The nozzle glow blobs looked fine because they're drawn as children
    // at render time; only the world-space streak, sampled here, was misplaced.)
    this.group.updateMatrixWorld(true);
    this._advanceTrails(dt, camera);
    this._advanceAudio(audio, camera);
  }
  // Estimate the rendered velocity from the frame-to-frame change in interpolated position, then
  // drive the world-space engine trails so the exhaust streaks behind the moving remote ship.
  _advanceTrails(dt, camera) {
    // Dead ship: exhaust was already killed on the death transition. Don't re-drive the updater
    // (which would re-emit/re-show streaks); just hold the position so velocity is sane on respawn.
    if (!this._alive) { this._prevPos.copy(this.group.position); return; }
    if (!camera || dt <= 0) { this._prevPos.copy(this.group.position); this._hasPrev = true; return; }
    if (this._hasPrev) {
      // Raw frame-to-frame velocity of the INTERPOLATED pose. This can spike violently when the
      // snapshot buffer catches up after a network hitch or a respawn teleport — a single huge
      // frame delta. Feeding that spike straight into the exhaust makes streaks inherit an enormous
      // world velocity and shoot off hundreds of metres from the ship (the "trail detached from the
      // hull" bug). So: (a) reject a delta that implies faster-than-possible travel as a teleport,
      // and (b) low-pass the result so brief jitter can't launch streaks across the map.
      _velRaw.subVectors(this.group.position, this._prevPos).multiplyScalar(1 / dt);
      const cap = this._maxSpeed * 1.4;                     // physical ceiling incl. boost headroom
      if (_velRaw.length() > cap) {
        // Treat as a teleport/hitch: don't emit a runaway streak this frame — bleed velocity toward 0.
        this._vel.multiplyScalar(0.5);
      } else {
        // Smooth toward the measured velocity so the exhaust tracks real motion without jitter.
        this._vel.lerp(_velRaw, Math.min(1, dt * 12));
      }
    }
    this._prevPos.copy(this.group.position);
    this._hasPrev = true;
    // Map speed to a 0..1 throttle for the nozzle glow AND the spatial engine pitch, normalized to
    // THIS hull's own top speed so a slow bomber and a fast interceptor both read across the full
    // throttle range. Smoothed so brief interpolation jitter doesn't flicker the exhaust/pitch.
    const target = THREE.MathUtils.clamp(this._vel.length() / this._maxSpeed, 0, 1);
    this._speed01 += (target - this._speed01) * Math.min(1, dt * 8);
    // The exhaust emitter in scene.js stops streaming entirely below a small throttle floor
    // (speed01 < 0.06 -> rate 0). For a REMOTE ship that floor was the real reason no trail showed:
    // the throttle is reconstructed from noisy, low-passed, interpolated velocity that ramps slowly,
    // gets halved on every teleport-reject frame, and collapses to ~0 whenever the snapshot buffer
    // stalls — so it kept dipping under the floor and the plume never emitted. An arena fighter is
    // effectively always under thrust, so drive the exhaust with a guaranteed throttle FLOOR (a real
    // idle plume) that measured speed can only add to. This keeps a continuous streak behind every
    // remote hull regardless of interpolation jitter, while faster ships still burn brighter/longer.
    const engineDrive = Math.max(0.34, this._speed01);
    // Drive the exhaust at (near) full length like the local player's own trail. A previous 0.25
    // lenScale shrank the streaks' length AND life so far that remote trails were effectively
    // invisible — only the nozzle glow read. Keep them full so other pilots leave a real plume.
    updateEngineTrails(this.group, dt, engineDrive, camera, false, 1, this._vel, false, 1);
  }
  // Drive this ship's POSITIONAL audio: a spatial engine drone at its world position (so a nearby
  // pilot's engine swells on the correct side), plus fly-by detection for a Doppler whoosh when it
  // screams past close and fast. Dead/leaving ships are silenced by the caller / dispose().
  _advanceAudio(audio, camera) {
    if (!audio || !camera) return;
    const p = this.group.position;
    if (!this._alive) { audio.stopShipEngine(this.sessionId); return; }
    // Throttle for the drone loudness/pitch tracks the same smoothed speed estimate as the trails.
    // Pass this pilot's hull id so the spatial drone uses THAT ship's engine timbre profile — a
    // remote interceptor should scream and a bomber should rumble, matching the unique engine
    // character each hull has on the select screen / warp-in, instead of every ship sounding alike.
    // Also pass the smoothed world velocity + the listener (camera) position so the engine pitch
    // gets a real DOPPLER shift: rising as the ship screams toward you, dropping as it tears away.
    audio.updateShipEngine(this.sessionId, p.x, p.y, p.z, this._speed01, this.shipId, this._vel, camera.position);
    // Fly-by uses the current rendered speed + the listener (camera) position. Pass the hull id so
    // the whoosh screams past in THIS ship's engine voice (a bomber roars, an interceptor shrieks)
    // instead of a generic pass sound shared across every hull.
    audio.updateFlyby(this.sessionId, p.x, p.y, p.z, this._vel.length(), camera.position, this.shipId, this._vel);
  }
  dispose(audio = null) {
    // Free the engine exhaust meshes/geometry/materials (they live in trailGroup, world space) so a
    // pilot who dies-for-good or leaves the match doesn't leave an orphaned streak in the scene.
    this._killTrails();
    if (audio) audio.stopShipEngine(this.sessionId);   // silence + tear down this ship's engine drone
    disposeEngineEffects(this.group);
    this.scene.remove(this.group);
    if (this.trailGroup) this.scene.remove(this.trailGroup);
    if (this.label.material.map) this.label.material.map.dispose();
    this.label.material.dispose();
  }
}

// A networked laser bolt tracer. The server owns position/velocity; we extrapolate along the synced
// velocity between patches so the tracer looks smooth. Colored by the SHOOTER'S TEAM (absolute, not
// relative to the viewer): a blue-team ship's bolts are cyan for EVERYONE — the shooter, their
// wingmen, AND the enemy being fired at — and a red-team ship's bolts are red for everyone. This is
// deliberately team-absolute so a pilot always reads incoming fire by faction, and a blue ship never
// looks like it's shooting red bolts on someone else's screen.
class NetBolt {
  constructor(scene, team) {
    this.scene = scene;
    const color = team === 1 ? 0xff3d52 : 0x62f8ff;   // red team = red bolts, blue team = cyan bolts
    const geo = new THREE.CylinderGeometry(0.09, 0.09, 3.4, 6);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this._lastPatch = performance.now();
    this._up = new THREE.Vector3(0, 1, 0);
  }
  // Apply a fresh authoritative snapshot from the server.
  setFromServer(px, py, pz, vx, vy, vz) {
    this.pos.set(px, py, pz);
    this.vel.set(vx, vy, vz);
    this._lastPatch = performance.now();
    this._orient();
  }
  // Extrapolate between patches so the tracer keeps moving at ~server speed.
  update(now) {
    const dt = Math.min(0.1, (now - this._lastPatch) / 1000);
    this.mesh.position.copy(this.pos).addScaledVector(this.vel, dt);
  }
  _orient() {
    if (this.vel.lengthSq() > 1e-6) {
      this.mesh.quaternion.setFromUnitVectors(this._up, this.vel.clone().normalize());
    }
    this.mesh.position.copy(this.pos);
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// A networked guided-missile tracer. Server owns position/velocity + homing; we extrapolate along
// the synced velocity between patches so the dart looks smooth, and orient it along its heading.
// Colored by the shooter's team (absolute, like NetBolt) with a bright warhead glow.
class NetMissile {
  constructor(scene, team) {
    this.scene = scene;
    const color = team === 1 ? 0xff6a4a : 0x8fe6ff;
    const g = new THREE.Group();
    // Slim dart body (+Y is the nose to match the orientation math below).
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 2.6, 8),
      new THREE.MeshBasicMaterial({ color: 0xdfe9f2 }),
    );
    body.rotation.x = Math.PI;   // point cone +Y
    g.add(body);
    // Glowing motor plume behind the dart.
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 10, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
    );
    glow.position.y = -1.7;
    g.add(glow);
    this.glow = glow;
    g.renderOrder = 5;
    scene.add(g);
    this.mesh = g;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this._lastPatch = performance.now();
    this._noseAxis = new THREE.Vector3(0, 1, 0);
  }
  setFromServer(px, py, pz, vx, vy, vz) {
    this.pos.set(px, py, pz);
    this.vel.set(vx, vy, vz);
    this._lastPatch = performance.now();
    if (this.vel.lengthSq() > 1e-6) {
      this.mesh.quaternion.setFromUnitVectors(this._noseAxis, this.vel.clone().normalize());
    }
    this.mesh.position.copy(this.pos);
  }
  update(now) {
    const dt = Math.min(0.15, (now - this._lastPatch) / 1000);
    this.mesh.position.copy(this.pos).addScaledVector(this.vel, dt);
    if (this.glow) this.glow.material.opacity = 0.7 + Math.random() * 0.3;
  }
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
}

// Crisp call-sign sprite drawn to a canvas, tinted by team color.
function makeLabelSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const label = String(text || 'PILOT').toUpperCase().slice(0, 16);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = '700 34px Orbitron, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,8,18,0.92)';
  ctx.strokeText(label, 128, 34);
  ctx.fillStyle = color || '#8af0ff';
  ctx.fillText(label, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(9, 2.25, 1);
  sprite.renderOrder = 999;
  return sprite;
}

export class Multiplayer {
  constructor(scene, fxGroup = null, camera = null, audio = null) {
    this.scene = scene;
    // Camera used by the engine-trail updater (billboards the exhaust streaks toward the viewer).
    // Optional: if omitted, remote trails simply track velocity but skip the per-frame streak build.
    this.camera = camera;
    // AudioBus used for POSITIONAL multiplayer sound: each remote ship's engine drone + fly-by
    // whoosh are placed in 3D at the ship's world position, and networked laser fire is played
    // spatially so it comes from the correct side. Optional: if omitted, MP audio is simply silent.
    this.audio = audio;
    // Group that main.js ages/cleans each frame (updateExplosions). Explosion particles MUST be
    // added here — not the raw scene — or they'd never be updated or removed. Falls back to scene.
    this.fx = fxGroup || scene;
    this.client = null;
    this.room = null;
    this.connected = false;
    this.mySessionId = null;
    this.myTeam = 0;
    this.callSign = 'PILOT';
    this.shipId = DEFAULT_SHIP_ID;
    // Our own ranking/honor state (reported on join; read back for our own row in the rosters).
    this.myRankScore = 0;
    this.myPioneer = false;
    // Our own lobby ready-check flag (mirrored from server state each patch). The host may only
    // launch once EVERY pilot is ready (see allReady()).
    this.myReady = false;
    // Per-hull speed multiplier for LOCAL prediction — must match the server's value for this hull.
    this.mySpeedScale = 1;
    this.remotes = new Map();        // sessionId -> RemoteShip
    this.bolts = new Map();          // boltId -> NetBolt
    this.missiles = new Map();       // missileId -> NetMissile
    // Last-seen scoreboard row for EVERY pilot who was in the match this session (keyed by
    // sessionId), including ones who have since left. Kept alongside the live remotes so the
    // match-results screen can show the full final roster even after everyone has disconnected.
    this._scoreboard = new Map();    // sessionId -> { name, team, shipId, kills, deaths, me }
    this._onCount = null;
    this._onKill = null;             // optional callback(killData) for kill-feed / SFX
    this._onHit = null;              // optional callback(hitData) for hit markers / damage feedback
    // Local ship's server-authoritative combat state (mirrored each patch for the HUD).
    this.myHull = 100;
    this.myShields = 100;
    this.myAlive = true;
    this.myKills = 0;
    this.myDeaths = 0;
    this.myRespawnIn = 0;      // seconds until our ship respawns (server-authoritative); 0 while alive
    this.myLastKiller = '';    // sessionId of whoever last destroyed us (for kill-cam framing)
    // Guided-missile loadout, server-authoritative (the server owns ammo to prevent cheats). The HUD
    // and fire code read these while connected instead of a locally-managed count.
    this.myMissiles = 4;
    this.myMaxMissiles = 4;
    // Voice comms (presence only; audio transport is a separate WebRTC/SFU layer). `myTalking` is
    // true while push-to-talk is held; `mySquad` is true when we've opted into squad-only voice.
    this.myTalking = false;
    this.mySquad = false;
    this.myMicState = false;   // true once our mic is granted + published (drives our lobby mic icon)
    // --- Match / game-mode state (mirrored from server state each patch) ---
    this.match = {
      mode: 'sdm', matchState: 'lobby', roundDuration: 600, timeLeft: 600,
      blueKills: 0, redKills: 0, winningTeam: -1, host: '',
    };
    // Host's locally-chosen lobby config. Applied optimistically when connected (so the chip
    // highlights immediately instead of waiting a state patch), and is the sole source of truth
    // offline/solo where there's no server to echo the pick back. `roundDuration` null = "use the
    // server/default value" until the host actually picks one.
    this._localConfig = { mode: 'sdm', roundDuration: null };
    this._onMatchStart = null;   // optional callback() when the round goes live
    this._onMatchEnd = null;     // optional callback({winningTeam, blueKills, redKills}) at round end
    // Client-side prediction bookkeeping for the LOCAL ship.
    this._seq = 0;                   // input sequence counter
    this._pending = [];              // unacknowledged inputs { seq, input, dt }
    this._lastInput = idleInput();   // most recent input we've sampled (sent each frame)
    // Reconciliation smoothing state (see _reconcile). `_smoothReady` false forces the next reconcile
    // to snap with no offset (used at join/respawn so the ship starts exactly on truth).
    this._smoothReady = false;
    this._smoothOff = new THREE.Vector3();       // current positional visual offset (decays to 0)
    this._smoothOffQuat = new THREE.Quaternion(); // current rotational visual offset (decays to identity)
    // A back-compat alias so older glue that checks `.ghosts.size` keeps working.
    this.ghosts = this.remotes;
  }

  // Connect to the arena and join the match. Never throws — check `.connected` afterward.
  async join({ callSign = 'PILOT', shipId = DEFAULT_SHIP_ID, endpoint = DEFAULT_ENDPOINT, rankScore = 0, pioneer = false, onCount = null, onKill = null, onHit = null, onMatchStart = null, onMatchEnd = null } = {}) {
    this.callSign = String(callSign || 'PILOT').toUpperCase().slice(0, 16);
    // Our own career rank progression + Pioneer honor, reported to the server so remote clients can
    // render our rank badge. Kept locally too so the lobby/scoreboards show our own rank instantly.
    this.myRankScore = Math.max(0, Math.floor(Number(rankScore) || 0));
    this.myPioneer = !!pioneer;
    const chosen = getShip(shipId);
    this.shipId = chosen.id;             // validated ship id (falls back to Lightning)
    this.mySpeedScale = (chosen.stats && chosen.stats.speed) || 1;
    this._onCount = onCount;
    this._onKill = onKill;
    this._onHit = onHit;
    this._onMatchStart = onMatchStart;
    this._onMatchEnd = onMatchEnd;
    this._scoreboard.clear();            // fresh match: reset the results-screen scoreboard snapshot
    try {
      const mod = await import('colyseus.js');
      // colyseus.js exposes `Client` as a named export; fall back to default just in case the CDN
      // build wraps it. Bracket access keeps this dynamic so static validation of the module shim
      // doesn't flag a missing property — the real export resolves at runtime via the importmap.
      const ns = /** @type {any} */ (mod);
      const ClientCtor = ns['Client'] || (ns['default'] && ns['default']['Client']);
      if (typeof ClientCtor !== 'function') throw new Error('colyseus.js Client unavailable');
      this.client = new ClientCtor(endpoint);
      this.room = await this.client.joinOrCreate('arena', { name: this.callSign, ship: this.shipId, rankScore: this.myRankScore, pioneer: this.myPioneer });
      this.mySessionId = this.room.sessionId;
      this.connected = true;
      // Loud diagnostic so you can confirm in the browser console that BOTH tabs land in the SAME
      // roomId. If the two tabs print different roomIds, they're in separate rooms (matchmaking/
      // endpoint mismatch); if they share a roomId but don't see each other, it's a state-sync issue.
      console.info(`[multiplayer] joined arena roomId=${this.room.roomId} sessionId=${this.mySessionId}`);
      this._wireRoom();
    } catch (err) {
      // Expected when no arena server is running (e.g. in the preview). This is the intended
      // graceful fallback to single-player, not an error — logged at info level so it doesn't
      // read as a fault in the console.
      const detail = err && err.message ? err.message : err;
      console.info('[multiplayer] no arena server reachable — flying solo (this is expected unless a server is running).', detail);
      this.connected = false;
    }
    this._reportCount();
    return this;
  }

  // Subscribe to authoritative state. We drive everything off room.onStateChange, which fires on
  // EVERY state patch in every colyseus.js build — unlike the per-map onAdd callback, which in this
  // 0.15 esm.sh build (a) has no getStateCallbacks helper and (b) does not reliably fire for the
  // ship list, and (c) sees 0 ships at join time because the first patch hasn't arrived yet. On each
  // patch we RECONCILE our RemoteShip set against state.ships: spawn newcomers, drop leavers, and
  // push a fresh interpolation snapshot for everyone still present. Simple, robust, build-proof.
  _wireRoom() {
    this._syncedOnce = false;
    this.room.onStateChange((state) => this._reconcileRemotes(state));
    // Fire once immediately in case a patch already arrived before we subscribed.
    if (this.room.state) this._reconcileRemotes(this.room.state);

    // Server broadcasts a 'kill' event when any ship is destroyed: spawn an explosion at the death
    // site and hand the data up to the game (kill feed / SFX). Wrapped so a missing handler is safe.
    try {
      this.room.onMessage('kill', (msg) => {
        if (msg && typeof msg.x === 'number') {
          explode(this.fx, new THREE.Vector3(msg.x, msg.y, msg.z), 0xffb347, 1.6);
        }
        if (this._onKill) { try { this._onKill(msg); } catch {} }
      });
    } catch {}

    // Server broadcasts a 'hit' event whenever a bolt/missile deals damage: the SHOOTER gets a hit
    // marker ("you connected") and the VICTIM gets a damage flash ("you're taking fire"). We hand
    // the raw data up to the game, which decides which feedback applies to the local pilot.
    try {
      this.room.onMessage('hit', (msg) => {
        if (this._onHit && msg) { try { this._onHit(msg); } catch {} }
      });
    } catch {}

    // Server broadcasts 'missileHit' when a guided missile detonates on a ship: spawn a big warhead
    // blast at the impact point (heavier than the bolt kill puff).
    try {
      this.room.onMessage('missileHit', (msg) => {
        if (msg && typeof msg.x === 'number') {
          explode(this.fx, new THREE.Vector3(msg.x, msg.y, msg.z), 0xffd27a, 2.4);
        }
        // A missile hit also reports damage feedback (marker for the shooter, flash for the victim).
        if (this._onHit && msg) { try { this._onHit({ ...msg, missile: true }); } catch {} }
      });
    } catch {}

    // Host started the round: the server flips matchState to 'live' and resets the clock. Hand up to
    // the game so every client drops from the lobby into flight together.
    try {
      this.room.onMessage('matchStart', (msg) => {
        if (this._onMatchStart) { try { this._onMatchStart(msg || {}); } catch {} }
      });
    } catch {}

    // Round clock hit 0: the server decided the winner. Hand up the result for the winner banner +
    // scoreboard.
    try {
      this.room.onMessage('matchEnd', (msg) => {
        if (this._onMatchEnd) { try { this._onMatchEnd(msg || {}); } catch {} }
      });
    } catch {}

    // Connection dropped (server closed the room, our socket died, or we were kicked). Mark
    // disconnected, tear down every remote ghost + its trails, and REPORT the count so the game's
    // match-over logic sees connected=false / 0 peers and returns the player to the menu. Guard
    // against the leave() teardown having already nulled the room out from under us.
    try {
      this.room.onLeave(() => this._handleDisconnect());
    } catch {}
    try {
      this.room.onError(() => this._handleDisconnect());
    } catch {}
  }

  // Shared teardown for an unexpected server disconnect (distinct from the user pressing Leave,
  // which calls leave()). Drops remotes/bolts and reports the now-offline count exactly once.
  _handleDisconnect() {
    if (!this.connected && this.remotes.size === 0) { this._reportCount(); return; }
    this.connected = false;
    this.room = null;
    for (const remote of this.remotes.values()) remote.dispose(this.audio);
    this.remotes.clear();
    for (const nb of this.bolts.values()) nb.dispose();
    this.bolts.clear();
    for (const nm of this.missiles.values()) nm.dispose();
    this.missiles.clear();
    if (this.audio) this.audio.stopAllSpatial();   // kill any lingering remote engine drones
    this._pending.length = 0;
    this._smoothReady = false;   // next reconcile after a fresh join snaps cleanly (no stale offset)
    this._reportCount();   // surfaces connected=false / 0 peers to onCount -> match-over path
  }

  // Walk the authoritative ship map and make our local remotes match it exactly. Also mirrors our
  // own ship's server combat state (hull/shields/alive/score) and reconciles networked bolts.
  _reconcileRemotes(state) {
    const ships = state && state.ships;
    if (!ships) return;
    // Mirror the authoritative match/game-mode state so the lobby + HUD can read it synchronously.
    this.match.mode = state.mode || 'sdm';
    this.match.matchState = state.matchState || 'lobby';
    this.match.roundDuration = state.roundDuration || 600;
    this.match.timeLeft = typeof state.timeLeft === 'number' ? state.timeLeft : this.match.timeLeft;
    this.match.blueKills = state.blueKills || 0;
    this.match.redKills = state.redKills || 0;
    this.match.winningTeam = typeof state.winningTeam === 'number' ? state.winningTeam : -1;
    this.match.host = state.host || '';
    // Once the server confirms our optimistic pick (or overrides it), drop the local override so
    // the authoritative value governs from then on — this also lets a non-host follow the host.
    if (this._localConfig.mode && state.mode === this._localConfig.mode) this._localConfig.mode = 'sdm';
    if (typeof this._localConfig.roundDuration === 'number'
        && Math.round(state.roundDuration || 0) === Math.round(this._localConfig.roundDuration)) {
      this._localConfig.roundDuration = null;
    }
    const now = performance.now();
    const seen = new Set();
    let teamChanged = false;

    // Iterate every ship in state. MapSchema supports forEach((value, key) => ...).
    ships.forEach((ship, sessionId) => {
      seen.add(sessionId);
      if (sessionId === this.mySessionId) {
        // Our own ship: predicted for movement, but combat state is server-authoritative.
        // Track team changes so the connection badge re-reports the correct color even though
        // MapSchema iteration order (own ship vs. remotes) isn't guaranteed within this loop.
        if (ship.team !== this.myTeam) { this.myTeam = ship.team; teamChanged = true; }
        this.myHull = ship.hull;
        this.myShields = ship.shields;
        this.myAlive = ship.alive;
        this.myKills = ship.kills;
        this.myDeaths = ship.deaths;
        // Kill-cam / respawn HUD: server-authoritative seconds-until-respawn + who killed us (so
        // the kill-cam can frame the killer). Both are 0/'' while alive.
        this.myRespawnIn = ship.respawnIn || 0;
        this.myLastKiller = ship.lastKiller || '';
        // Lobby ready-check: mirror our authoritative ready flag so the button state follows server truth.
        this.myReady = !!ship.ready;
        // Server-authoritative missile rack (mirrored for the HUD + fire gate).
        this.myMissiles = ship.missiles;
        this.myMaxMissiles = ship.maxMissiles || this.myMaxMissiles;
        this._scoreboard.set(sessionId, {
          name: this.callSign, team: ship.team, shipId: this.shipId,
          kills: ship.kills || 0, deaths: ship.deaths || 0, me: true,
          rankScore: this.myRankScore, pioneer: this.myPioneer, ready: this.myReady,
        });
        return;
      }
      let remote = this.remotes.get(sessionId);
      if (!remote) {
        remote = new RemoteShip(this.scene, ship.team, ship.name, ship.ship || DEFAULT_SHIP_ID, sessionId);
        this.remotes.set(sessionId, remote);
        console.info(`[multiplayer] remote pilot spawned: ${ship.name} (team ${ship.team}, ${ship.ship || DEFAULT_SHIP_ID})`);
        this._reportCount();
      }
      // Mirror combat state onto the remote's group so the HUD/targeting reads live health. Route
      // alive/dead through setAlive() so a death both hides the hull AND destroys its engine trails
      // (and a respawn resets the velocity estimate), rather than just toggling group visibility.
      remote.group.userData.hp = ship.hull;
      remote.group.userData.maxHp = 100;
      remote.group.userData.shields = ship.shields;
      // Mirror the authoritative scoreboard fields so the match-results screen can read per-pilot
      // kills/deaths straight off the remote's userData. Keep TEAM and SHIP in sync every patch, not
      // just at spawn: in the lobby a pilot can switch team/hull AFTER we first saw them (e.g. the
      // host moving to RED + a Crimson Interceptor), and the lobby roster reads team/shipId straight
      // off userData — without this the other client kept showing their spawn-time team/ship.
      remote.group.userData.team = ship.team;
      remote.team = ship.team;
      // Keep the pilot's NAME synced every patch too — not just at spawn. A remote can be created
      // before its `name` has propagated (or can rename), and the lobby roster + HUD read
      // `userData.callSign`; without this refresh a client could keep showing a stale/placeholder
      // name (the "both rows show my own name" lobby bug).
      if (ship.name) {
        const cs = String(ship.name).toUpperCase().slice(0, 16);
        if (cs !== remote.group.userData.callSign) {
          remote.group.userData.callSign = cs;
          remote.setLabel(cs);
        }
      }
      if (ship.ship && ship.ship !== remote.group.userData.shipId) {
        remote.group.userData.shipId = ship.ship;
        remote.shipId = ship.ship;
      }
      remote.group.userData.kills = ship.kills || 0;
      remote.group.userData.deaths = ship.deaths || 0;
      // Voice presence: mirror who's on the radio + their channel so the HUD can frame a talking
      // teammate with the speaking brackets (and honor squad-only routing).
      remote.group.userData.speaking = !!ship.speaking;
      remote.group.userData.squad = !!ship.squad;
      remote.group.userData.micState = ship.micState || 0;   // 0 = no/denied mic, 1 = mic available
      // Ranking/honor: mirror the pilot's career advancement score + Pioneer flag so the rosters
      // and scoreboards can render their rank badge and honor color.
      remote.group.userData.rankScore = ship.rankScore || 0;
      remote.group.userData.pioneer = !!ship.pioneer;
      // Lobby ready-check: mirror the pilot's authoritative ready flag so the lobby roster can
      // paint their green readiness pip and the host's launch gate can read everyone's state.
      remote.group.userData.ready = !!ship.ready;
      remote.setAlive(!!ship.alive);
      // Snapshot this pilot's last-seen scoreboard row so it survives them leaving the match.
      this._scoreboard.set(sessionId, {
        name: remote.group.userData.callSign || String(ship.name || 'PILOT'),
        team: ship.team, shipId: ship.ship || remote.shipId || DEFAULT_SHIP_ID,
        kills: ship.kills || 0, deaths: ship.deaths || 0, me: false,
        rankScore: ship.rankScore || 0, pioneer: !!ship.pioneer, ready: !!ship.ready,
      });
      // Push the current authoritative pose as an interpolation snapshot every patch.
      remote.pushSnapshot(now, ship.px, ship.py, ship.pz, ship.qx, ship.qy, ship.qz, ship.qw);
    });

    // Drop any remotes whose ships have left the state.
    let removedAny = false;
    for (const sessionId of [...this.remotes.keys()]) {
      if (!seen.has(sessionId)) {
        const remote = this.remotes.get(sessionId);
        if (remote) remote.dispose(this.audio);
        this.remotes.delete(sessionId);
        removedAny = true;
      }
    }
    // Re-report if our team resolved this patch (fixes the badge showing BLUE for a RED pilot when
    // the own-ship entry is iterated after remotes, or arrives on a later patch than the first count).
    if (removedAny || teamChanged) this._reportCount();

    // --- Reconcile networked bolts + missiles -------------------------------------------------
    this._reconcileBolts(state);
    this._reconcileMissiles(state);

    if (!this._syncedOnce) {
      this._syncedOnce = true;
      console.info(`[multiplayer] first state sync — ${this.remotes.size} remote pilot(s) visible`);
    }
  }

  // Make our local NetBolt set match the server's bolt map: spawn new tracers, update existing ones
  // from the latest server pose, and remove bolts the server has expired/consumed (with a small
  // spark where a hit likely occurred).
  _reconcileBolts(state) {
    const bolts = state && state.bolts;
    if (!bolts) return;
    const seen = new Set();
    bolts.forEach((b, id) => {
      seen.add(id);
      // Don't render our OWN bolts here — the client already spawns instant local tracers on fire so
      // shooting feels responsive; rendering the server copy too would double them up.
      if (b.owner === this.mySessionId) return;
      let nb = this.bolts.get(id);
      if (!nb) {
        // Hostile = fired by a pilot on the OTHER team (relative to us). This drives ONLY the laser
        // AUDIO tone (a deeper "enemy cannon" report for incoming fire vs. a friendly blaster). The
        // tracer COLOR is team-absolute (b.team), so a blue ship's bolts render cyan on every screen.
        const enemy = b.team !== this.myTeam;
        nb = new NetBolt(this.scene, b.team);
        this.bolts.set(id, nb);
        // First time we've seen this bolt = it was just fired. Play a POSITIONED laser report at
        // the muzzle so you hear the shot come from the correct direction.
        if (this.audio) this.audio.playSpatialLaser(b.px, b.py, b.pz, enemy, enemy ? 0.6 : 0.5);
      }
      nb.setFromServer(b.px, b.py, b.pz, b.vx, b.vy, b.vz);
    });
    for (const id of [...this.bolts.keys()]) {
      if (!seen.has(id)) {
        const nb = this.bolts.get(id);
        if (nb) nb.dispose();
        this.bolts.delete(id);
      }
    }
  }

  // Make our local NetMissile set match the server's missile map: spawn new dart tracers, update
  // existing ones from the latest server pose, and remove missiles the server has expired/detonated.
  // We render EVERY missile (including our own): unlike bolts, the client doesn't spawn an instant
  // local missile tracer, so the server copy is the only visual and there's nothing to double up.
  _reconcileMissiles(state) {
    const missiles = state && state.missiles;
    if (!missiles) return;
    const seen = new Set();
    missiles.forEach((m, id) => {
      seen.add(id);
      let nm = this.missiles.get(id);
      if (!nm) {
        nm = new NetMissile(this.scene, m.team);
        this.missiles.set(id, nm);
        // Launch report: a positioned whoosh at the muzzle (enemy tone if it's incoming at us).
        if (this.audio) {
          const enemy = m.team !== this.myTeam;
          this.audio.playSpatialLaser(m.px, m.py, m.pz, enemy, 0.5);
        }
      }
      nm.setFromServer(m.px, m.py, m.pz, m.vx, m.vy, m.vz);
    });
    for (const id of [...this.missiles.keys()]) {
      if (!seen.has(id)) {
        const nm = this.missiles.get(id);
        if (nm) nm.dispose();
        this.missiles.delete(id);
      }
    }
  }

  // Sample the local ship's INTENT for this frame. Called from the game loop with the current input
  // state. We store it (sent on the next update tick) and stamp a sequence number for reconciliation.
  setLocalInput({ steerX = 0, steerY = 0, roll = 0, thrust = false, reverse = false, boost = false } = {}) {
    this._lastInput = { steerX, steerY, roll, thrust: !!thrust, reverse: !!reverse, boost: !!boost };
  }

  // Advance the network layer for one client frame.
  //  1) Predict the LOCAL ship forward with the sampled input (applied to `localState` in place).
  //  2) Send the input frame to the server.
  //  3) Interpolate all remote ships to (now - INTERP_DELAY_MS).
  //  4) Reconcile the local prediction against the latest server snapshot.
  // `localState` is the caller's authoritative-mirror of the local ship: { pos, vel, quat } as
  // plain {x,y,z}/{x,y,z,w} objects (main.js adapts the THREE player to this and back).
  update(dt, localState) {
    if (!this.connected || !this.room) {
      // Offline solo: still integrate the local mirror so the ship flies (main.js already moved the
      // real player; this keeps the mirror consistent for a later reconnect). Interpolate nothing.
      return;
    }
    // (1) Predict + record the input so it can be replayed during reconciliation.
    const seq = ++this._seq;
    const input = { ...this._lastInput, seq };
    stepShip(localState, input, dt, this.mySpeedScale);
    this._pending.push({ seq, input, dt });
    if (this._pending.length > 240) this._pending.shift();   // safety cap (~4s at 60fps)

    // (2) Send intent to the server.
    try { this.room.send('input', input); } catch {}

    // (3) Interpolate remotes in the past, and advance their engine trails from the rendered motion.
    const now = performance.now();
    const renderTime = now - INTERP_DELAY_MS;
    for (const remote of this.remotes.values()) remote.update(renderTime, dt, this.camera, this.audio);

    // (3b) Extrapolate networked bolts + missiles along their synced velocity so tracers stay smooth.
    for (const nb of this.bolts.values()) nb.update(now);
    for (const nm of this.missiles.values()) nm.update(now);

    // (4) Reconcile: correct the local mirror toward the server's authoritative pose for our ship
    // (snap + replay unacknowledged inputs), easing small corrections in over a few frames so they
    // don't visibly snap. `dt` drives the offset decay.
    this._reconcile(localState, dt);
  }

  // Ask the server to fire. The server is authoritative on rate/trajectory/hits — we send only the
  // intent. Safe to call every frame the fire button is held; the server enforces the cooldown.
  fire() {
    if (!this.connected || !this.room || !this.myAlive) return;
    try { this.room.send('fire'); } catch {}
  }

  // Ask the server to launch a guided missile at a locked target. `targetGroup` is the remote
  // pilot's Object3D (from remoteGroups()); we resolve its sessionId so the server knows what to home
  // on. A null/unknown target sends a dumbfire missile (server flies it straight). Server-rate-limited.
  fireMissile(targetGroup = null) {
    if (!this.connected || !this.room || !this.myAlive) return;
    const target = this.sessionIdFor(targetGroup) || '';
    try { this.room.send('missile', { target }); } catch {}
  }

  // Push-to-talk: report the open/closed mic edge to the server so it replicates our `speaking` flag
  // to everyone (drives the speaking indicators). Only sends on an actual CHANGE to avoid spamming
  // the wire while the key is held. The real audio stream rides a separate WebRTC/SFU layer.
  setTalking(talking) {
    const t = !!talking;
    if (t === this.myTalking) return;
    this.myTalking = t;
    if (!this.connected || !this.room) return;
    try { this.room.send('voice', { talking: t }); } catch {}
  }

  // Toggle SQUAD voice (talk only to same-team squad members) vs. full TEAM voice. Returns the new
  // state so the caller can flash the HUD. Replicated so teammates' indicators route correctly.
  setSquadVoice(on) {
    const v = !!on;
    this.mySquad = v;
    if (this.connected && this.room) {
      try { this.room.send('voiceChannel', { squad: v }); } catch {}
    }
    return v;
  }
  toggleSquadVoice() { return this.setSquadVoice(!this.mySquad); }

  // Report our microphone AVAILABILITY (permission granted + track published, vs. denied/unavailable)
  // so every client can render our lobby mic icon correctly. Only sends on an actual change. Purely
  // cosmetic presence — the audio stream itself rides the separate WebRTC/SFU layer.
  setMicPresence(available) {
    const v = !!available;
    if (v === this.myMicState) return;
    this.myMicState = v;
    if (this.connected && this.room) {
      try { this.room.send('voiceMic', { available: v }); } catch {}
    }
  }

  // Resolve the sessionId of a remote pilot's rendered group (reverse of remotePosition), or '' if
  // the group isn't one of our current remotes (e.g. a single-player enemy or a stale reference).
  sessionIdFor(group) {
    if (!group) return '';
    for (const [sid, r] of this.remotes) if (r && r.group === group) return sid;
    return '';
  }

  _reconcile(localState, dt = 1 / 60) {
    const me = this.room.state.ships.get(this.mySessionId);
    if (!me) return;
    const ackSeq = me.lastSeq >>> 0;
    // Drop inputs the server has already applied.
    while (this._pending.length && this._pending[0].seq <= ackSeq) this._pending.shift();

    // Remember where the ship rendered LAST frame (the pose the caller is still holding) so we can
    // measure how far this correction moves it and blend the difference away instead of popping.
    _prevPos.set(localState.pos.x, localState.pos.y, localState.pos.z);
    _prevQuat.set(localState.quat.x, localState.quat.y, localState.quat.z, localState.quat.w);

    // Compute the CORRECTED authoritative prediction: snap the mirror to server truth, then replay
    // every unacknowledged input on top. localState now holds the true target pose/velocity.
    localState.pos.x = me.px; localState.pos.y = me.py; localState.pos.z = me.pz;
    localState.vel.x = me.vx; localState.vel.y = me.vy; localState.vel.z = me.vz;
    localState.quat.x = me.qx; localState.quat.y = me.qy; localState.quat.z = me.qz; localState.quat.w = me.qw;
    for (const p of this._pending) stepShip(localState, p.input, p.dt, this.mySpeedScale);
    // The corrected target pose (velocity is left on localState as-is — always authoritative).
    _recPos.set(localState.pos.x, localState.pos.y, localState.pos.z);
    _recQuat.set(localState.quat.x, localState.quat.y, localState.quat.z, localState.quat.w).normalize();

    // First reconcile after join/respawn, or a correction big enough to be a teleport/desync: snap
    // hard with no smoothing so the ship starts exactly on truth and never lags far behind.
    const posErr = _prevPos.distanceTo(_recPos);
    const rotErr = _prevQuat.angleTo(_recQuat);
    if (!this._smoothReady || posErr > SMOOTH_POS_SNAP || rotErr > SMOOTH_ROT_SNAP) {
      this._smoothReady = true;
      this._smoothOff.set(0, 0, 0);
      this._smoothOffQuat.identity();
      // localState already equals the corrected pose — nothing more to blend.
      return;
    }

    // Fold the fresh correction into the running visual offset: offset += (prev - corrected). This is
    // the residual we still owe the render, so showing `corrected + offset` keeps the ship visually at
    // last frame's pose the instant the correction lands, then eases to truth as the offset decays.
    this._smoothOff.add(_prevPos).sub(_recPos);
    // Rotational offset: accumulate the delta that rotates corrected -> prev, then keep it normalized.
    _renderQuat.copy(_recQuat).invert().premultiply(_prevQuat);   // delta = prev * corrected^-1
    this._smoothOffQuat.premultiply(_renderQuat).normalize();

    // Exponential decay of both offsets toward zero/identity over their half-lives (framerate-safe).
    const posDecay = Math.pow(0.5, dt / SMOOTH_POS_HALFLIFE);
    const rotDecay = Math.pow(0.5, dt / SMOOTH_ROT_HALFLIFE);
    this._smoothOff.multiplyScalar(posDecay);
    // Slerp the rotational offset toward identity by (1 - rotDecay).
    _renderQuat.identity();
    this._smoothOffQuat.slerp(_renderQuat, 1 - rotDecay).normalize();

    // Snap tiny residuals to zero so the offset doesn't linger indefinitely as float dust.
    if (this._smoothOff.lengthSq() < 1e-6) this._smoothOff.set(0, 0, 0);

    // Final rendered pose = corrected target displaced by the remaining offset. Velocity stays
    // authoritative (untouched) so flight physics/HUD read true speed.
    _renderPos.copy(_recPos).add(this._smoothOff);
    _renderQuat.copy(this._smoothOffQuat).multiply(_recQuat).normalize();
    localState.pos.x = _renderPos.x; localState.pos.y = _renderPos.y; localState.pos.z = _renderPos.z;
    localState.quat.x = _renderQuat.x; localState.quat.y = _renderQuat.y; localState.quat.z = _renderQuat.z; localState.quat.w = _renderQuat.w;
  }

  // Re-point the count/kill callbacks without reconnecting. Used when handing off from the lobby
  // (roster view) to in-flight (HUD badge + kill feed) on the same live room connection.
  setCallbacks({ onCount = undefined, onKill = undefined, onHit = undefined, onMatchStart = undefined, onMatchEnd = undefined } = {}) {
    if (onCount !== undefined) this._onCount = onCount;
    if (onKill !== undefined) this._onKill = onKill;
    if (onHit !== undefined) this._onHit = onHit;
    if (onMatchStart !== undefined) this._onMatchStart = onMatchStart;
    if (onMatchEnd !== undefined) this._onMatchEnd = onMatchEnd;
  }

  // True if THIS client is the current lobby host (may configure the mode/settings + start the
  // match). Solo/offline sessions count as host so the single player can still tweak + launch.
  isHost() {
    if (!this.connected) return true;
    return !!this.mySessionId && this.match.host === this.mySessionId;
  }
  // Live match/game-mode state snapshot for the lobby + HUD (read-only copy). The host's locally
  // chosen values override the mirrored server state so a fresh pick highlights instantly (online)
  // and persists at all (offline), rather than snapping back to the server/default each render.
  matchInfo() {
    const info = { ...this.match };
    if (this._localConfig.mode) info.mode = this._localConfig.mode;
    if (typeof this._localConfig.roundDuration === 'number') {
      info.roundDuration = this._localConfig.roundDuration;
    }
    return info;
  }
  // The effective configured round length in seconds (host pick if any, else server/default). Used
  // by the solo/offline launch path, which has no server to hand back the chosen duration.
  roundDuration() {
    if (typeof this._localConfig.roundDuration === 'number') return this._localConfig.roundDuration;
    return this.match.roundDuration || 600;
  }
  // HOST: change the mode / round settings in the lobby. Recorded locally first (so it sticks
  // offline and shows immediately online), then sent to the server when connected. The server is
  // still authoritative: it whitelists + host-gates the value and echoes the accepted config back.
  setConfig({ mode = 'sdm', roundDuration } = {}) {
    this._localConfig.mode = mode;
    if (typeof roundDuration === 'number') this._localConfig.roundDuration = roundDuration;
    if (!this.connected || !this.room) return;
    const msg = { mode };
    if (typeof roundDuration === 'number') msg.roundDuration = roundDuration;
    try { this.room.send('config', msg); } catch {}
  }
  // HOST: start the configured round. Server-gated (host + lobby only). No-op when offline (the
  // caller handles the solo-launch path directly).
  startMatch() {
    if (!this.connected || !this.room) return;
    try { this.room.send('startMatch'); } catch {}
  }
  // Change our hull mid-lobby / during the ship-select window. The server validates the id against
  // our TEAM's roster and updates our authoritative stats. We also update the local id used for
  // prediction speed + the hull we render on warp-in. No-op (but still records locally) when offline.
  setShip(shipId) {
    const chosen = getShip(shipId);
    this.shipId = chosen.id;
    this.mySpeedScale = (chosen.stats && chosen.stats.speed) || 1;
    if (this.connected && this.room) { try { this.room.send('setShip', { ship: chosen.id }); } catch {} }
  }

  peerCount() { return this.remotes.size; }
  // Full final scoreboard for the match-results screen: one row per pilot who was ever present
  // this session (including ones who left), sorted best-first by kills then fewest deaths. `me`
  // flags the local pilot. Safe to call after everyone has disconnected (reads the snapshot store).
  matchStats() {
    const rows = [...this._scoreboard.values()].map(r => ({
      name: r.name || 'PILOT', team: r.team || 0, shipId: r.shipId || DEFAULT_SHIP_ID,
      kills: r.kills || 0, deaths: r.deaths || 0, me: !!r.me,
      rankScore: r.rankScore || 0, pioneer: !!r.pioneer,
    }));
    rows.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (a.me ? -1 : b.me ? 1 : 0));
    return rows;
  }
  // LIVE roster for the in-match scoreboard (HOLD TAB): one row per pilot CURRENTLY in the arena
  // (self + remotes, no leavers), each with team / name / kills / deaths / alive / me. Read straight
  // off live state (our mirrored own-ship fields + each remote's userData) so it updates every patch.
  liveRoster() {
    const rows = [];
    // Our own ship.
    rows.push({
      name: this.callSign || 'PILOT', team: this.myTeam || 0, shipId: this.shipId || DEFAULT_SHIP_ID,
      kills: this.myKills || 0, deaths: this.myDeaths || 0, alive: !!this.myAlive, me: true,
      // Voice presence for the lobby mic icon: our own live speaking flag + mic availability.
      speaking: !!this.myTalking, micState: this.myMicState ? 1 : 0,
      // Ranking/honor for the rank badge next to our name.
      rankScore: this.myRankScore || 0, pioneer: !!this.myPioneer,
      // Lobby ready-check readiness pip.
      ready: !!this.myReady,
    });
    // Every remote pilot.
    for (const r of this.remotes.values()) {
      const ud = (r && r.group && r.group.userData) || {};
      rows.push({
        name: ud.callSign || 'PILOT', team: ud.team || 0, shipId: ud.shipId || DEFAULT_SHIP_ID,
        kills: ud.kills || 0, deaths: ud.deaths || 0, alive: r ? r._alive !== false : true, me: false,
        speaking: !!ud.speaking, micState: ud.micState || 0,
        rankScore: ud.rankScore || 0, pioneer: !!ud.pioneer,
        ready: !!ud.ready,
      });
    }
    return rows;
  }
  // Lobby ready-check: tell the server whether we're ready to launch. Optimistically mirrors
  // locally so the button flips instantly; the next state patch confirms authoritative truth.
  setReady(on) {
    const val = !!on;
    this.myReady = val;
    if (this.connected && this.room) { try { this.room.send('setReady', { ready: val }); } catch {} }
    return val;
  }
  toggleReady() { return this.setReady(!this.myReady); }
  // True only when there's at least one pilot AND every pilot in the live roster is ready.
  // Used by the host launch gate so the match can't start until the whole squad checks in.
  allReady() {
    const rows = this.liveRoster();
    if (!rows.length) return false;
    return rows.every(r => !!r.ready);
  }
  // World position (THREE.Vector3) of a remote pilot's rendered ship by sessionId, or null if that
  // pilot isn't currently a live remote. Used by the kill-cam to frame the pilot who killed us.
  remotePosition(sessionId) {
    const r = sessionId && this.remotes.get(sessionId);
    return r && r.group ? r.group.position : null;
  }
  // Display call-sign for a pilot by sessionId — prefers the live remote, then the persistent
  // scoreboard snapshot (so a killer who has since left still names correctly on the kill-cam).
  pilotName(sessionId) {
    const r = sessionId && this.remotes.get(sessionId);
    if (r && r.group && r.group.userData && r.group.userData.callSign) return r.group.userData.callSign;
    const row = sessionId && this._scoreboard.get(sessionId);
    return (row && row.name) || '';
  }
  // Live list of remote pilot Object3D groups, for the HUD/targeting system to lock onto.
  remoteGroups() {
    const out = [];
    // Only LIVE pilots are lockable contacts. A dead/respawning remote (userData.alive === false)
    // is excluded so the local player's lock, lock tone, and target brackets drop the instant a
    // rival is destroyed instead of clinging to a 0%-hull ship until it warps back in.
    for (const r of this.remotes.values()) if (r && r.group && r.group.userData.alive !== false) out.push(r.group);
    return out;
  }
  _reportCount() { if (this._onCount) { try { this._onCount(this.peerCount(), this.connected, this.myTeam); } catch {} } }

  // Leave the match and tear down all remote ships.
  leave() {
    try { this.room && this.room.leave(); } catch {}
    this.room = null;
    this.client = null;
    this.connected = false;
    this._pending.length = 0;
    this._smoothReady = false;   // next reconcile after a fresh join snaps cleanly (no stale offset)
    for (const remote of this.remotes.values()) remote.dispose(this.audio);
    this.remotes.clear();
    for (const nb of this.bolts.values()) nb.dispose();
    this.bolts.clear();
    for (const nm of this.missiles.values()) nm.dispose();
    this.missiles.clear();
    if (this.audio) this.audio.stopAllSpatial();   // silence all remote engine drones on leave
    this.myHull = 100; this.myShields = 100; this.myAlive = true;
    this._reportCount();
  }
}

function idleInput() { return { steerX: 0, steerY: 0, roll: 0, thrust: false, reverse: false, boost: false }; }
