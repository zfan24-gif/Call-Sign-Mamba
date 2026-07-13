import * as THREE from 'three';

// Self-contained lightspeed "warp-out" effect for gameplay wave transitions.
//
// It does two things while active:
//   1) Drives the player ship: a brief nose-levelling charge, then explosive
//      acceleration straight down its forward axis so it visibly leaps away.
//   2) Blooms a field of radial light streaks anchored at the camera, scaled by
//      the jump intensity, so the starfield reads as a hyperspace jump.
//
// It is fully independent of the cutscene's warp machinery so the gameplay loop
// can fire it between missions without touching cutscene internals.
export class WarpOut {
  constructor(scene, camera) {
    this.camera = camera;
    this.active = false;
    this.t = 0;
    this.onPeak = null;     // called once at the brightest moment (good place to swap scenes)
    this.onDone = null;

    // Build the streak layer: pairs of points forming short radial lines that we
    // stretch along the jump axis. Anchored to a group we move with the camera.
    const N = 900;                                  // dense field for a dramatic lightspeed rush
    this.count = N;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(N * 2 * 3);
    this.seeds = [];
    for (let i = 0; i < N; i++) {
      // Random direction on a cone roughly facing the jump axis (-Z local), with spread.
      const ang = Math.random() * Math.PI * 2;
      const rad = 4 + Math.random() * 150;          // off-axis radius (px-ish in world units)
      const z = -(30 + Math.random() * 420);        // depth ahead of camera (deeper field)
      this.seeds.push({ ang, rad, z, len: 0.5 + Math.random() * 1.7 });
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

  // ship: the player Object3D to fling forward. Returns immediately; drive with update().
  start(ship, opts = {}) {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    this.ship = ship;
    this.peaked = false;
    this.onPeak = opts.onPeak || null;
    this.onDone = opts.onDone || null;
    this.lines.visible = true;
  }

  // Hard-stop the effect immediately (used when a cinematic cuts away mid-jump). Hides the
  // streak field and clears the active flag without firing onDone.
  stop() {
    this.active = false;
    this.lines.visible = false;
    this.lines.material.opacity = 0;
  }

  // True only during the very start (the gentle charge) before the leap to lightspeed. Once
  // the ship snaps to lightspeed the caller swaps the scene background to flat black so the
  // static stars don't sit motionless behind the rushing streak field during the jump.
  get starsVisible() {
    if (!this.active) return true;
    return this.t < 0.6;
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const cam = this.camera;

    // Keep the streak group glued to the camera and aimed down the camera's view.
    this.group.position.copy(cam.position);
    this.group.quaternion.copy(cam.quaternion);

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ship.quaternion).normalize();

    // Timeline (seconds) — extended ~3s longer for a more dramatic lightspeed run:
    //   0.0 -> 0.6   charge: gentle creep, streaks build subtly
    //   0.6 -> 1.4   GO: snap to lightspeed, streaks bloom, ship visibly leaps away
    //   1.4 -> 4.4   CRUISE: sustained full lightspeed, the star field rips past at max
    //                stretch for a long, dramatic beat
    //   ~4.35        PEAK: fire onPeak (caller blooms the white flash)
    //   4.7          DONE: fire onDone (caller swaps the scene BEHIND the white flash,
    //                then fades the flash out to reveal it)
    let intensity;
    if (t < 0.6) {
      this.ship.position.addScaledVector(fwd, 8 * dt);     // gentle creep
      intensity = t / 0.6 * 0.3;                           // streaks build subtly
      if (this.ship.userData.vel) this.ship.userData.vel.multiplyScalar(Math.pow(0.4, dt));
    } else if (t < 1.4) {
      const k = THREE.MathUtils.clamp((t - 0.6) / 0.8, 0, 1);
      const speed = 80 + 2200 * k * k;
      this.ship.position.addScaledVector(fwd, speed * dt);
      intensity = 0.3 + 0.7 * k;
    } else {
      // Sustained lightspeed cruise: hold max stretch and keep flinging the ship forward so
      // the star streaks rip past for a long, dramatic beat before the flash.
      this.ship.position.addScaledVector(fwd, 2600 * dt);
      intensity = 1;
    }

    this._drawStreaks(intensity, dt);

    // Peak the jump (white flash) only after the long lightspeed cruise has played out.
    if (!this.peaked && t >= 4.35) {
      this.peaked = true;
      if (this.onPeak) this.onPeak();
    }

    // Hand off well after the peak so the leap + flash fully play before the scene swap.
    if (t >= 4.7) {
      this.active = false;
      this.lines.visible = false;
      this.lines.material.opacity = 0;
      if (this.onDone) this.onDone();
    }
  }

  _drawStreaks(intensity, dt = 0) {
    const i01 = THREE.MathUtils.clamp(intensity, 0, 1);
    const pos = this.positions;
    const stretch = 6 + i01 * 170;    // streak length grows hard at full warp (much longer now)
    // Continuously flow the field toward the camera so the stars actively rush past during the
    // sustained cruise instead of sitting as static stretched lines. Recycle any streak that
    // passes the camera back out to the far depth with a fresh angle/radius.
    const flow = i01 * 520 * dt;
    for (let i = 0; i < this.count; i++) {
      const s = this.seeds[i];
      if (flow > 0) {
        s.z += flow;
        if (s.z > 30) {
          s.z = -(60 + Math.random() * 420);
          s.ang = Math.random() * Math.PI * 2;
          s.rad = 4 + Math.random() * 150;
        }
      }
      // The camera is planted BEHIND the ship looking down its nose, and the ship flies AWAY
      // from the camera (into -Z of the view). So from the viewer's seat the surrounding stars
      // must rush TOWARD and PAST the camera: each streak's far end stays out ahead (its seed
      // depth) and its near end is pulled back TOWARD the camera (+Z), fanning slightly outward
      // with perspective so it reads as the field whooshing past — not stretching away ahead.
      const dirX = Math.cos(s.ang);
      const dirY = Math.sin(s.ang);
      // Far end: the streak's anchor point, out ahead along the view axis.
      const zFar = s.z;
      const radFar = s.rad;
      // Near end: pulled toward the camera (+Z) and flared outward (radius grows) for the
      // classic radial rush-past look.
      const zNear = s.z + stretch * s.len;
      const radNear = s.rad * (1 + 0.12 * i01 * s.len);
      const a = i * 2 * 3, b = (i * 2 + 1) * 3;
      pos[a]     = dirX * radFar;  pos[a + 1] = dirY * radFar;  pos[a + 2] = zFar;
      pos[b]     = dirX * radNear; pos[b + 1] = dirY * radNear; pos[b + 2] = zNear;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.material.opacity = 0.15 + i01 * 0.75;
  }
}
