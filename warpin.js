import * as THREE from 'three';

// Self-contained lightspeed "warp-IN" sequence played at the start of each mission/wave.
//
// TWO PHASES:
//   1) CRUISE  — the hero ship streaks THROUGH hyperspace at sustained lightspeed for a few
//                seconds: long blazing radial star-streaks rip past and the exhaust runs a long
//                hyperspace trail. This is the "travelling through the tunnel" beat.
//   2) ARRIVAL — the ship drops out of hyperspace: it rapidly decelerates to sublight and the
//                streaks collapse back into the starfield. Control hands back to the player with
//                the ship ALREADY in forward motion, so the dogfight begins on the move.
//
// It mirrors WarpOut's streak field but runs the timeline in reverse (fast -> slow).
export class WarpIn {
  constructor(scene, camera) {
    this.camera = camera;
    this.active = false;
    this.t = 0;
    this._defaultCruiseDur = 3.0;  // default seconds streaking THROUGH hyperspace before dropout
    this.cruiseDur = this._defaultCruiseDur;
    this.dur = 1.6;         // seconds for the deceleration drop-out (arrival) itself
    this.onDone = null;

    const N = 320;
    this.count = N;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(N * 2 * 3);
    this.seeds = [];
    for (let i = 0; i < N; i++) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 8 + Math.random() * 120;
      const z = -(40 + Math.random() * 320);
      this.seeds.push({ ang, rad, z, len: 0.4 + Math.random() * 1.2 });
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xbfe6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.lines.visible = false;
  }

  // ---- Pre-jump "idle hold" -------------------------------------------------------------------
  // Used during the mission briefing BEFORE the actual warp-in. Shows the same hyperspace tunnel
  // streaking past at full cruise intensity, anchored to the camera, but does NOT move the ship —
  // the hero is parked while the briefing voice plays. Call beginHold() once, streakHold(dt) each
  // frame, then endHold() (or just call start(), which resets the field) when the briefing ends.
  beginHold() {
    this.lines.visible = true;
    // Fresh, evenly-spread tunnel so it looks alive the instant the briefing begins.
    for (const s of this.seeds) {
      s.ang = Math.random() * Math.PI * 2;
      s.rad = 8 + Math.random() * 120;
      s.z = -(40 + Math.random() * 320);
      s.len = 0.4 + Math.random() * 1.2;
    }
  }
  endHold() {
    if (this.active) return;            // a real jump took over — leave its field alone
    this.lines.visible = false;
    this.lines.material.opacity = 0;
  }
  // Drive the holding tunnel: anchor to the camera and rush the streaks past at full intensity.
  // `cam` is needed because the hold runs while this.ship/camera aren't yet on the warp rails.
  streakHold(dt) {
    const cam = this.camera;
    this.group.position.copy(cam.position);
    this.group.quaternion.copy(cam.quaternion);
    this._streamStreaks(this._peakSpeed, dt);
    this._drawStreaks(1);
  }

  // ship: the player Object3D arriving from hyperspace. exitSpeed: forward speed (units/s) the
  // ship should be travelling at when it drops to sublight and control resumes.
  start(ship, opts = {}) {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    this.ship = ship;
    this.exitSpeed = opts.exitSpeed != null ? opts.exitSpeed : 28;
    this.onDone = opts.onDone || null;
    // Allow the caller to override the cruise length for THIS jump. After a long pre-jump briefing
    // (where the holding tunnel already covered the "travelling through hyperspace" beat), a short
    // cruise lets the drop-out arrive promptly instead of replaying a full 3s cruise.
    this.cruiseDur = opts.cruiseDur != null ? opts.cruiseDur : this._defaultCruiseDur;
    this.lines.visible = true;
    // Re-seed the tunnel so every jump starts with a fresh, evenly-spread streak field.
    for (const s of this.seeds) {
      s.ang = Math.random() * Math.PI * 2;
      s.rad = 8 + Math.random() * 120;
      s.z = -(40 + Math.random() * 320);
      s.len = 0.4 + Math.random() * 1.2;
    }
  }

  // Peak forward speed (units/s) while streaking through hyperspace. The arrival deceleration
  // also eases down from this value, and the cruise distance is paced off it.
  get _peakSpeed() { return 1180 / this.dur; }

  // Total forward distance (units) the ship covers over cruise + arrival. The caller uses this
  // to place the ship far enough back that it lands in the engagement zone. Cruise = constant
  // peak speed; arrival ∫(exitSpeed + peak*(1-k)^3) over `dur` = exitSpeed*dur + peak*dur/4.
  totalDistance(exitSpeed = 30, cruiseDur = this.cruiseDur) {
    return this._peakSpeed * cruiseDur + (exitSpeed * this.dur + this._peakSpeed * this.dur / 4);
  }

  // throttle/trailScale used by the caller to drive the exhaust: a long blazing hyperspace
  // exhaust (1 -> ~7x) while cruising and during the drop-out, easing to ~1x as it slows.
  get trailScale() {
    if (!this.active) return 1;
    if (this.t < this.cruiseDur) return 7;   // full-length blazing trail while in hyperspace
    const k = THREE.MathUtils.clamp((this.t - this.cruiseDur) / this.dur, 0, 1);
    return 1 + (1 - k) * 6;                   // collapses to normal as it drops out
  }

  // True once the streaks have collapsed enough that the static starfield should be back
  // (near the end of the arrival deceleration). The caller swaps the scene background to
  // flat black while this is false so the static stars don't sit motionless behind the
  // rushing streak tube, then restores the starfield once this turns true.
  get starsVisible() {
    if (!this.active) return true;
    const k = (this.t - this.cruiseDur) / this.dur;   // <0 during cruise, 0..1 during arrival
    return k > 0.75;                                   // bring stars back as we settle to sublight
  }

  // 'cruise' while streaking through the tunnel at full lightspeed, 'arrival' once the ship
  // begins decelerating (the stars start slowing), 'idle' when not warping. main.js watches
  // this to drive the hyperspace hum and the drop-out sound effect.
  get phase() {
    if (!this.active) return 'idle';
    return this.t < this.cruiseDur ? 'cruise' : 'arrival';
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const cam = this.camera;

    this.group.position.copy(cam.position);
    this.group.quaternion.copy(cam.quaternion);

    // Forward = local -Z (the nose), matching the gameplay/cutscene convention.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ship.quaternion).normalize();

    let speed, intensity;
    if (t < this.cruiseDur) {
      // ---- Phase 1: CRUISE through hyperspace at sustained lightspeed ----
      speed = this._peakSpeed;
      intensity = 1;                          // streaks at full stretch/brightness
    } else {
      // ---- Phase 2: ARRIVAL — decelerate out of hyperspace to sublight ----
      const k = THREE.MathUtils.clamp((t - this.cruiseDur) / this.dur, 0, 1);
      // Ease-out: very fast at first, settling to exitSpeed by the end of the drop-out.
      speed = this.exitSpeed + this._peakSpeed * Math.pow(1 - k, 3);
      intensity = Math.pow(1 - k, 1.2);       // bright streaks collapsing to none
    }
    this.ship.position.addScaledVector(fwd, speed * dt);
    // Keep the velocity in sync so the player resumes at the current speed along the nose.
    if (this.ship.userData.vel) this.ship.userData.vel.copy(fwd).multiplyScalar(speed);

    // Advance each streak toward the camera so they actually RUSH PAST during the cruise,
    // not just sit stretched in place. Scale the flow off the current speed so the streaks
    // visibly slow and settle as the ship decelerates out of hyperspace. The group rides the
    // camera, so this z-motion is the only thing that reads as travelling through the tunnel.
    this._streamStreaks(speed, dt);
    this._drawStreaks(intensity);

    if (t >= this.cruiseDur + this.dur) {
      this.active = false;
      this.lines.visible = false;
      this.lines.material.opacity = 0;
      if (this.ship.userData.vel) this.ship.userData.vel.copy(fwd).multiplyScalar(this.exitSpeed);
      if (this.onDone) this.onDone();
    }
  }

  // Move every streak toward the camera at a fraction of the ship's current speed, so the
  // field rushes past during the cruise and decelerates with the ship. When a streak passes
  // behind the camera it respawns far ahead at a fresh angle/radius for a continuous tunnel.
  _streamStreaks(speed, dt) {
    const flow = speed * dt * 0.55;   // pixels-per-frame the tunnel slides toward the viewer
    for (let i = 0; i < this.count; i++) {
      const s = this.seeds[i];
      s.z += flow;                    // +z = toward the camera (streaks live at negative z)
      if (s.z > 12) {                 // passed the viewer — recycle far ahead
        s.z = -(280 + Math.random() * 120);
        s.ang = Math.random() * Math.PI * 2;
        s.rad = 8 + Math.random() * 120;
        s.len = 0.4 + Math.random() * 1.2;
      }
    }
  }

  _drawStreaks(intensity) {
    const i01 = THREE.MathUtils.clamp(intensity, 0, 1);
    const pos = this.positions;
    const stretch = 4 + i01 * 90;
    for (let i = 0; i < this.count; i++) {
      const s = this.seeds[i];
      const x = Math.cos(s.ang) * s.rad;
      const y = Math.sin(s.ang) * s.rad;
      const zNear = s.z;
      const zFar = s.z - stretch * s.len;
      const a = i * 2 * 3, b = (i * 2 + 1) * 3;
      pos[a] = x;     pos[a + 1] = y;     pos[a + 2] = zNear;
      pos[b] = x;     pos[b + 1] = y;     pos[b + 2] = zFar;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.material.opacity = i01 * 0.85;
  }
}
