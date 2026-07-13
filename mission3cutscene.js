import * as THREE from 'three';
import { makeAlly, makeEnemy, makeBolt, makeMissile, updateEngineTrails, disposeEngineEffects, explode, spawnSmokePuff } from './scene.js';
import { paintStarfieldCanvas } from './cutscene.js';

// ---------------------------------------------------------------------------
// Mission 3 pre-briefing cutscene.
//
// O.G. and Slick drop out of hyperspace together into open space and immediately
// pile into a knot of enemy fighters — banking, strafing and blowing bandits out
// of the sky for a solid rowdy beat. Then an enemy MISSILE streaks in and SLAMS
// into O.G.'s engines: his thrusters blow out in a shower of sparks and he starts
// trailing thick smoke. He's not dead — he can still fly, just slower, and he
// can't make the jump. We settle on his smoking bird, then fade to the briefing.
//
// Self-contained: own scene, camera, lights, and animation loop. Calls
// onComplete() when finished (or on skip).
// ---------------------------------------------------------------------------

export class Mission3Cutscene {
  constructor(renderer, audio, onComplete) {
    this.renderer = renderer;
    this.audio = audio;
    this.onComplete = onComplete;
    this.done = false;
    this.t = 0;
    this.warpDone = false;
    this.bolts = [];        // both allied (blue) and enemy (red) bolts
    this.sparks = [];
    this.enemyShips = [];   // live enemy fighters in the dogfight
    this.strafers = [];     // the ambush strafing wave that screams in as O.G. is hit
    this.missiles = [];     // the scripted engine-killing missile
    this.hitFired = false;  // the engine-disabling missile launch (fires once)
    this.ambushFired = false; // the strafing-run ambush wave (fires once, with the missile)
    this._arrivalVoiced = false; // arrival radio chatter (Slick then O.G.) fired once
    this._voiceTimers = [];      // pending arrival-chatter timers (cleared on skip/finish)
    this._smokeAt = 0;      // throttles O.G.'s trailing smoke once damaged
    this._allyFireT = 0.0;  // throttles O.G./Slick weapon fire during the brawl
    this._enemyFireT = 0.6; // throttles enemy return fire
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x01030a, 0.0035);
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 4000);
    this._buildWorld();
    this._buildShips();

    this._timer = new THREE.Timer();
    this._onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);
  }

  _makeStarrySkyTexture() {
    const tex = new THREE.CanvasTexture(paintStarfieldCanvas());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.anisotropy = 4;
    return tex;
  }

  _buildWorld() {
    // Match the opening cutscene / gameplay lighting so the allied hulls read the same way.
    this.scene.add(new THREE.AmbientLight(0x87a6ff, 0.6));
    const sunDir = new THREE.Vector3(0.55, 0.42, -0.72).normalize();
    const sunPos = sunDir.clone().multiplyScalar(1600);
    const key = new THREE.DirectionalLight(0xfff4e0, 3.2);
    key.position.copy(sunPos);
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x14203a, 0.7));
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.copy(sunPos.clone().multiplyScalar(-1));
    this.scene.add(rim);

    this._skyTex = this._makeStarrySkyTexture();
    this._skyBlack = new THREE.Color(0x01030a);
    this.scene.background = this._skyTex;

    // ---- Warp streak tube (shared by the warp-in drop) ----
    const makeStreakTube = (count, rMin, rMax, tint0, opacity) => {
      const seeds = [];
      const verts = new Float32Array(count * 2 * 3);
      const cols = new Float32Array(count * 2 * 3);
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = rMin + Math.pow(Math.random(), 0.6) * (rMax - rMin);
        const z = -200 - Math.random() * 1500;
        seeds.push({ x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, z, rMin, rMax });
        const tint = tint0 + Math.random() * 0.3;
        for (const v of [0, 1]) {
          const o = (i * 2 + v) * 3;
          cols[o] = tint * 0.78; cols[o + 1] = tint * 0.92; cols[o + 2] = tint;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      return { mesh, seeds };
    };
    const inner = makeStreakTube(2800, 12, 420, 0.7, 0.95);
    this.warpStreaks = inner.mesh; this._streakSeeds = inner.seeds;
    const outer = makeStreakTube(1500, 430, 900, 0.55, 0.7);
    this.warpStreaksOuter = outer.mesh; this._streakSeedsOuter = outer.seeds;

    this.boltGroup = new THREE.Group(); this.scene.add(this.boltGroup);
    this.fxGroup = new THREE.Group(); this.scene.add(this.fxGroup);
    this.trails = new THREE.Group(); this.scene.add(this.trails);
  }

  _buildShips() {
    // O.G. (the one who gets hit) flies dead-center; Slick rides his right wing. Both warp in
    // from far back along +Z and decelerate to a hold near the origin. Nose is local -Z.
    this.og = makeAlly('og', new THREE.Vector3(0, 0, 520), this.trails);
    this.slick = makeAlly('slick', new THREE.Vector3(20, 3, 560), this.trails);
    for (const s of [this.og, this.slick]) {
      s.userData.vel = new THREE.Vector3(0, 0, -1);
      s.quaternion.identity();
      this.scene.add(s);
    }
    // Settled-flight anchors the heroes orbit around during the brawl (O.G. center, Slick wing).
    this._ogHome = new THREE.Vector3(0, 0, 24);
    this._slickHome = new THREE.Vector3(22, 3, 40);
    // A loose knot of enemy fighters out ahead for the heroes to tear into. They each fly their own
    // evasive jink so the heroes have to actually run them down and line up a shot.
    const kinds = ['interceptor', 'fighter', 'drone', 'interceptor'];
    for (let i = 0; i < kinds.length; i++) {
      const ang = (i / kinds.length) * Math.PI * 2;
      const pos = new THREE.Vector3(
        Math.cos(ang) * 46 + THREE.MathUtils.randFloatSpread(20),
        8 + Math.sin(ang) * 18,
        -150 - i * 26 - Math.random() * 30
      );
      const e = makeEnemy(kinds[i], pos, this.trails);
      e.userData.hp = e.userData.maxHp = 30;     // flimsy so the heroes shred them on cue
      e.userData.cinePhase = Math.random() * Math.PI * 2;
      e.userData.cineSpin = (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.6);
      e.userData.jinkSeed = Math.random() * Math.PI * 2;
      // Hidden during the hyperspace drop-in — they only appear once the heroes drop out of warp,
      // so the warp tunnel doesn't show bandits (and their engine trails) loitering in the void.
      e.visible = false;
      this.enemyShips.push(e);
      this.scene.add(e);
    }
    // Assign each hero a bandit to actually chase down (real dogfighting, not auto-lock).
    this.og.userData.chase = this.enemyShips[0] || null;
    this.slick.userData.chase = this.enemyShips[1] || this.enemyShips[0] || null;
  }

  _driveStreakLayer(layer, seeds, dt, intensity, opacityScale, originShip) {
    if (!layer) return;
    layer.visible = true;
    layer.material.opacity = 0.95 * opacityScale * THREE.MathUtils.clamp(intensity * 1.3, 0, 1);
    const arr = layer.geometry.attributes.position.array;
    const origin = originShip.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(originShip.quaternion).normalize();
    this.camera.updateMatrixWorld();
    const camFwd = new THREE.Vector3();
    this.camera.getWorldDirection(camFwd);
    let right = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-5) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, camFwd).normalize();
    const move = (90 + intensity * intensity * 4200) * dt;
    const tailLen = 4 + intensity * intensity * 392;
    const behind = 70;
    const tmpH = new THREE.Vector3();
    const tmpT = new THREE.Vector3();
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      s.z += move;
      if (s.z > behind) {
        const ang = Math.random() * Math.PI * 2;
        const rad = s.rMin + Math.pow(Math.random(), 0.6) * (s.rMax - s.rMin);
        s.x = Math.cos(ang) * rad; s.y = Math.sin(ang) * rad;
        s.z = -1700 - Math.random() * 400;
      }
      const depth = -s.z;
      tmpH.copy(origin).addScaledVector(right, s.x).addScaledVector(up, s.y).addScaledVector(fwd, depth);
      tmpT.copy(tmpH).addScaledVector(fwd, tailLen);
      const h = (i * 2) * 3, ta = (i * 2 + 1) * 3;
      arr[h] = tmpH.x; arr[h + 1] = tmpH.y; arr[h + 2] = tmpH.z;
      arr[ta] = tmpT.x; arr[ta + 1] = tmpT.y; arr[ta + 2] = tmpT.z;
    }
    layer.geometry.attributes.position.needsUpdate = true;
  }

  _updateWarpStreaks(dt, intensity) {
    this._driveStreakLayer(this.warpStreaks, this._streakSeeds, dt, intensity, 1.0, this.og);
    this._driveStreakLayer(this.warpStreaksOuter, this._streakSeedsOuter, dt, intensity, 0.7, this.og);
  }
  _hideWarpStreaks() {
    if (this.warpStreaks) this.warpStreaks.visible = false;
    if (this.warpStreaksOuter) this.warpStreaksOuter.visible = false;
  }

  start(playScore = true) {
    if (playScore) this.audio.playScore(0.6);
    this.audio.score.loop = true;
    setTimeout(() => this.audio.play('warp', 0.9), 200);
    this.renderer.setAnimationLoop((time) => this._loop(time));
  }

  skip() { this._finish(); }

  _finish() {
    if (this.done) return;
    this.done = true;
    // Cancel any pending arrival-chatter timer so O.G.'s line can't fire after the cutscene ends.
    for (const id of this._voiceTimers) clearTimeout(id);
    this._voiceTimers.length = 0;
    // Cut the stereo ambush whoosh if it's still sweeping when the scene ends/skips.
    if (this._flyby) { try { this._flyby.stop(); } catch {} this._flyby = null; }
    const titleEl = document.getElementById('cineTitle');
    if (titleEl) titleEl.classList.remove('show');
    this.audio.fade(this.audio.score, 0, 1600, true);
    this.audio.score.loop = false;
    const canvas = this.renderer.domElement;
    const FADE_MS = 1400;
    canvas.style.transition = `opacity ${FADE_MS}ms ease`;
    canvas.style.opacity = '0';
    setTimeout(() => {
      this.renderer.setAnimationLoop(null);
      window.removeEventListener('resize', this._onResize);
      canvas.style.transition = '';
      canvas.style.opacity = '1';
      this.onComplete && this.onComplete();
    }, FADE_MS + 60);
  }

  // Spawn a bolt the cutscene tracks itself (no shared boltGroup hit logic). Bolts fly dead straight.
  _spawnBolt(pos, dir, friendly) {
    const b = makeBolt(pos, dir, friendly, friendly ? 18 : 8);
    this.bolts.push(b); this.boltGroup.add(b);
  }

  _spark(pos, color, n = 14, speed = 16) {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(
        new THREE.SphereGeometry(0.07 + Math.random() * 0.1, 6, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending })
      );
      p.position.copy(pos);
      p.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(speed * (0.4 + Math.random())), life: 0.5 + Math.random() * 0.6 };
      this.sparks.push(p); this.fxGroup.add(p);
    }
  }

  // World-space position of O.G.'s engines (just behind his tail; nose = -Z so tail = +Z).
  _ogEnginePos() {
    return this.og.position.clone().addScaledVector(
      new THREE.Vector3(0, 0, 1).applyQuaternion(this.og.quaternion).normalize(), 3.0
    );
  }

  // Nearest live enemy to a position (heroes pick targets to shoot at), or null.
  _nearestEnemy(pos) {
    let best = null, bd = Infinity;
    for (const e of this.enemyShips) {
      const d = e.position.distanceTo(pos);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // Destroy an enemy with a full gameplay-style fireball, removing it from the brawl.
  _killEnemy(e) {
    const i = this.enemyShips.indexOf(e);
    if (i < 0) return;
    this.enemyShips.splice(i, 1);
    explode(this.fxGroup, e.position.clone(), 0xff7a3c, 1.1);
    this.audio.play('explosion', 0.45);
    if (e.userData.engines) disposeEngineEffects(e);
    this.scene.remove(e);
  }

  _loop(time) {
    this._timer.update(time);
    const dt = Math.min(this._timer.getDelta(), 0.05);
    this.t += dt;
    const t = this.t;

    // ---- Phase 1: hyperspace drop-out (0 - ~2.6s) ----
    const WARP_END = 2.6;
    if (!this.warpDone) {
      this.og.position.lerp(this._ogHome, 1 - Math.pow(0.06, dt));
      this.slick.position.lerp(this._slickHome, 1 - Math.pow(0.06, dt));
      if (t > WARP_END) {
        this.warpDone = true;
        // Heroes have dropped out of warp — reveal the waiting bandits now (not during the tunnel).
        for (const e of this.enemyShips) e.visible = true;
      }
    }

    // ---- Warp intensity ramp ----
    const RAMP_END = 0.7;
    let warpI;
    if (!this.warpDone) {
      const r = THREE.MathUtils.clamp(t / RAMP_END, 0, 1);
      warpI = r < 1 ? r * r * (3 - 2 * r) : Math.max(0, 1 - (t - RAMP_END) / (WARP_END - RAMP_END));
    } else {
      warpI = 0;
    }
    if (warpI > 0.01) {
      this._updateWarpStreaks(dt, warpI);
      this.scene.background = warpI > 0.5 ? this._skyBlack : this._skyTex;
      this._streaming = true;
    } else if (this._streaming) {
      this._hideWarpStreaks();
      this.scene.background = this._skyTex;
      this._streaming = false;
    }

    // ---- Arrival chatter: Slick reacts as they drop in, then O.G. answers 0.5s after her line ----
    if (this.warpDone && !this._arrivalVoiced) {
      this._arrivalVoiced = true;
      this.audio.playRadioClip('assets/audio/voice/mission3/slickohlook.mp3', 0.95, () => {
        this._voiceTimers.push(setTimeout(() => {
          this.audio.playRadioClip('assets/audio/voice/mission3/ogcut.mp3', 0.95);
        }, 500));
      });
    }

    // ---- Phase 2: the brawl (after drop-out, until the missile hits) ----
    if (this.warpDone && !this._ogDamaged) {
      this._driveHeroes(dt, t);
      this._driveEnemies(dt, t);
      this._heroesShoot(dt);
      this._enemiesShoot(dt);
    } else if (this._ogDamaged) {
      // After the hit: O.G. limps, Slick covers, surviving enemies peel away off-screen.
      this._driveDamagedHeroes(dt, t);
      this._driveEnemies(dt, t, true);
    }

    // ---- Phase 3: the AMBUSH — strafing wave + the engine-disabling MISSILE (once) ----
    // A pack of enemy fighters screams in from the top-right and tears across the screen to the
    // bottom-left, hosing lasers the whole way (one pulls an aileron roll mid-pass). Riding in with
    // them, a missile seeks O.G.'s tail and guts his engines. This is the moment the heroes get
    // jumped, so it needs to hit hard and fast.
    const HIT_AT = WARP_END + 7.6;   // ~7-8 rowdy seconds before the ambush
    if (!this.hitFired && this.warpDone && t > HIT_AT) {
      this.hitFired = true;
      // A missile streaks in from off-screen high-right, seeking O.G.'s tail.
      const enginePos = this._ogEnginePos();
      const from = enginePos.clone().add(new THREE.Vector3(70, 40, 36));
      const dir = enginePos.clone().sub(from).normalize();
      const m = makeMissile(from, dir, false, this.og, 0);
      m.userData.speed = 150;
      this.missiles.push(m);
      this.scene.add(m);
      this.audio.play('enemyLaser', 0.5);
    }
    // The strafing pack launches a hair BEFORE the missile connects so they're mid-pass on impact.
    if (!this.ambushFired && this.warpDone && t > HIT_AT - 0.35) {
      this.ambushFired = true;
      this._spawnAmbush();
    }

    // ---- O.G. damaged: persistent smoke trail from the wrecked engines ----
    if (this._ogDamaged) {
      this._smokeAt -= dt;
      if (this._smokeAt <= 0) {
        this._smokeAt = 0.05;
        const ep = this._ogEnginePos();
        ep.add(new THREE.Vector3().randomDirection().multiplyScalar(0.7));
        spawnSmokePuff(this.fxGroup, ep, 1.6 + Math.random() * 1.2);
        if (Math.random() < 0.4) this._spark(this._ogEnginePos(), Math.random() < 0.5 ? 0xff7a3c : 0xffd27a, 3, 6);
      }
    }

    this._updateStrafers(dt);
    this._updateMissiles(dt);
    this._updateBolts(dt);
    this._updateSparks(dt);
    this._updateExplosions(dt);
    this._updateShipOrient(dt);
    this._updateCamera(dt, t);

    // Engine trails for the heroes.
    const ogSpeed = this._ogDamaged ? 0.22 : (this.warpDone ? 0.42 : 0.55);
    const trailScale = this.warpDone ? 1 : (1 + warpI * 3.0);
    if (this.og.userData.engines) updateEngineTrails(this.og, dt, ogSpeed, this.camera, false, trailScale, this.og.userData.vel, false, this._ogDamaged ? 0.3 : 1);
    if (this.slick.userData.engines) updateEngineTrails(this.slick, dt, this.warpDone ? 0.46 : 0.55, this.camera, false, trailScale, this.slick.userData.vel);
    // Enemy exhaust (orbiting brawl pack + the screaming ambush strafers). Skip the brawl pack while
    // the heroes are still in the warp tunnel so no enemy trails are emitted before they appear.
    if (this.warpDone) {
      for (const e of this.enemyShips) {
        if (e.userData.engines) updateEngineTrails(e, dt, 0.4, this.camera, false, 1, e.userData.vel, false, 0.8);
      }
    }
    for (const e of this.strafers) {
      if (e.userData.engines) updateEngineTrails(e, dt, 1.0, this.camera, false, 1.6, e.userData.vel, false, 0.9);
    }

    this.renderer.render(this.scene, this.camera);

    // ---- End: hold on the smoking O.G. so his hit-reaction line finishes BEFORE we fade out and
    // hand off to Overwatch's mission briefing — extended +2.5s for that radio beat. ----
    if (this._ogDamaged && this._hitTime != null && (t - this._hitTime) > 5.9 && !this.done) {
      this._finish();
    }
    // Hard safety cap.
    if (t > 19 && !this.done) this._finish();
  }

  // Heroes actively HUNT their assigned bandit: they pull in behind it on its tail, jinking and
  // banking to stay on its six, and only get a clean shot when they've muscled the nose onto it.
  // This is real pursuit flying — they have to chase the bandit down, not snap to it.
  _driveHeroes(dt, t) {
    this._chaseFlight(this.og, this._ogHome, 0.0, dt, t, 26);
    this._chaseFlight(this.slick, this._slickHome, 1.7, dt, t, 28);
  }

  // Fly `hero` onto the tail of its assigned chase target. If its target is dead, it reacquires the
  // nearest live bandit. The hero aims for a point just BEHIND the bandit (its six) and weaves, so it
  // reads as a fighter wrestling for a firing solution rather than gliding in a fixed orbit.
  _chaseFlight(hero, home, phase, dt, t, speed) {
    const ud = hero.userData;
    if (!ud.chase || !this.enemyShips.includes(ud.chase)) {
      ud.chase = this._nearestEnemy(hero.position);
    }
    let target;
    if (ud.chase) {
      const bandit = ud.chase;
      // Aim for a point on the bandit's six (behind its nose) so we settle into a tail chase.
      const banditNose = new THREE.Vector3(0, 0, -1).applyQuaternion(bandit.quaternion).normalize();
      const sixPoint = bandit.position.clone().addScaledVector(banditNose, -14);
      // Weave hard so the pursuit feels alive (jinking onto the target).
      const weave = new THREE.Vector3(
        Math.sin(t * 2.3 + phase) * 7,
        Math.cos(t * 1.9 + phase) * 4,
        Math.sin(t * 1.5 + phase) * 5
      );
      target = sixPoint.add(weave);
      // Don't crowd the bandit — hold a little standoff so we don't clip through it.
      const toBandit = bandit.position.clone().sub(hero.position);
      if (toBandit.length() < 12) target.addScaledVector(toBandit.normalize(), -10);
    } else {
      target = new THREE.Vector3(
        home.x + Math.sin(t * 0.9 + phase) * 10,
        home.y + Math.sin(t * 0.7 + phase) * 5,
        home.z - 6 + Math.cos(t * 0.6 + phase) * 8
      );
    }
    const toTarget = target.clone().sub(hero.position);
    const desiredVel = toTarget.clone().normalize().multiplyScalar(speed);
    // Smoothly steer velocity toward the desired heading so the ship banks into the chase.
    ud.vel.lerp(desiredVel, 1 - Math.pow(0.02, dt));
    hero.position.addScaledVector(ud.vel, dt);
  }

  // After the hit: O.G. drifts/lists forward slowly, Slick keeps station on his wing.
  _driveDamagedHeroes(dt, t) {
    this.og.userData.vel.set(0, 0, -1);
    this.og.position.x = Math.sin(t * 0.5) * 1.4;
    this.og.position.y = Math.cos(t * 0.4) * 0.9;
    this.og.position.z -= 3 * dt;   // limps forward slowly
    const slickTarget = this.og.position.clone().add(new THREE.Vector3(18, 4, 14));
    this.slick.userData.vel.copy(slickTarget).sub(this.slick.position);
    this.slick.position.lerp(slickTarget, 1 - Math.pow(0.05, dt));
  }

  // Enemies jink and bank evasively around the engagement, breaking away when a hero closes on their
  // six so the heroes have to work for the kill. After the hit they break off and run.
  _driveEnemies(dt, t, fleeing = false) {
    for (const e of this.enemyShips) {
      const ud = e.userData;
      ud.cinePhase += dt * (1.2 + ud.cineSpin * 0.4);
      let target;
      if (fleeing) {
        // Run off toward the far high-right, away from the heroes.
        target = e.position.clone().add(new THREE.Vector3(40, 16, -50));
      } else {
        // Orbit the engagement center, jinking on its own seed so it's a moving target.
        const r = 38 + Math.sin(ud.cinePhase) * 14;
        target = new THREE.Vector3(
          Math.cos(ud.cinePhase) * r + Math.sin(t * 3.1 + ud.jinkSeed) * 9,
          6 + Math.sin(ud.cinePhase * 0.8) * 14 + Math.cos(t * 2.6 + ud.jinkSeed) * 5,
          -28 + Math.sin(ud.cinePhase * 1.3) * 26
        );
        // If a hero is right on its tail, break away hard (evasive jink) to dodge the shot.
        for (const hero of [this.og, this.slick]) {
          const d = hero.position.distanceTo(e.position);
          if (d < 22) {
            const away = e.position.clone().sub(hero.position).normalize();
            const dodge = new THREE.Vector3().crossVectors(away, new THREE.Vector3(0, 1, 0)).normalize();
            target.addScaledVector(dodge, 18 * Math.sin(t * 4 + ud.jinkSeed)).addScaledVector(away, 10);
          }
        }
      }
      ud.vel.copy(target).sub(e.position);
      e.position.lerp(target, 1 - Math.pow(fleeing ? 0.2 : 0.06, dt));
    }
  }

  // Launch the ambush strafing run: a pack of fighters that screams across the screen from the
  // TOP-RIGHT down to the BOTTOM-LEFT, firing the whole way (one pulls an aileron roll). The pass
  // axis is built in the CAMERA's screen frame so "top-right -> bottom-left" reads on screen
  // regardless of where the camera sits, then nudged to skim just past O.G. so it feels aimed at him.
  _spawnAmbush() {
    this.camera.updateMatrixWorld();
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const camFwd = new THREE.Vector3(); this.camera.getWorldDirection(camFwd);
    // Travel direction across the screen: left + down + slightly toward the camera so they pass in
    // front of (not behind) the action.
    const travel = camRight.clone().multiplyScalar(-1)
      .addScaledVector(camUp, -0.85)
      .addScaledVector(camFwd, -0.18)
      .normalize();
    // Anchor the pass in front of the camera (between camera and O.G.) so it sweeps across the
    // FRAME, not off in the distance — guarantees the diagonal reads on screen.
    const focus = this.camera.position.clone().addScaledVector(camFwd, 55);
    this._ambushFocus = focus.clone();           // the wide camera locks onto this during the pass
    const kinds = ['interceptor', 'fighter', 'interceptor', 'drone'];
    const n = kinds.length;
    for (let i = 0; i < n; i++) {
      // Start each just off the top-right of frame, staggered along the travel line and spread out
      // so they arrive as a loose diagonal pack rather than a single file.
      const lateral = camRight.clone().multiplyScalar(THREE.MathUtils.randFloatSpread(20))
        .addScaledVector(camUp, THREE.MathUtils.randFloatSpread(16));
      const start = focus.clone()
        .addScaledVector(camRight, 60 + i * 12)
        .addScaledVector(camUp, 42 + i * 8)
        .addScaledVector(camFwd, THREE.MathUtils.randFloatSpread(20))
        .add(lateral);
      const e = makeEnemy(kinds[i % kinds.length], start, this.trails);
      e.userData.hp = e.userData.maxHp = 999;     // they survive the pass and rocket off-screen
      e.userData.vel = travel.clone().multiplyScalar(72 + i * 5);   // screaming pass, eased so it reads clearly
      e.userData.fireT = 0.08 + Math.random() * 0.18;
      // One of them does an aileron roll mid-pass (a barrel-roll about its own travel axis).
      e.userData.aileron = (i === 1);
      e.userData.rollAngle = 0;
      this.strafers.push(e);
      this.scene.add(e);
    }
    this.audio.play('enemyLaser', 0.5);
    // Stereo engine whoosh tracking the pack as it screams across the screen RIGHT -> LEFT.
    this._flyby = this.audio.playFlyby(3.0, 0.7);
  }

  // Drive the ambush strafers: fly their fixed screaming vector, hose red lasers along the nose, and
  // (for the tagged one) spin an aileron roll about the flight axis. Cull once they've blown past.
  _updateStrafers(dt) {
    if (!this.strafers.length) return;
    const focus = this._ambushFocus || this.og.position;
    for (const e of [...this.strafers]) {
      const ud = e.userData;
      e.position.addScaledVector(ud.vel, dt);
      const dir = ud.vel.clone().normalize();
      // Orient nose (-Z) down the travel vector.
      const look = e.position.clone().addScaledVector(dir, 1);
      const m = new THREE.Matrix4().lookAt(e.position, look, new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      if (ud.aileron) {
        // Spin a full barrel roll about the flight axis over the pass.
        ud.rollAngle += dt * 7.0;
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ud.rollAngle));
      }
      e.quaternion.copy(q);
      // Hose red laser fire forward along the nose (with a touch of scatter) the whole pass.
      ud.fireT -= dt;
      if (ud.fireT <= 0) {
        ud.fireT = 0.12 + Math.random() * 0.12;
        const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(e.quaternion).normalize();
        const fdir = nose.add(new THREE.Vector3().randomDirection().multiplyScalar(0.12)).normalize();
        const muzzles = ud.muzzles;
        const start = (muzzles && muzzles.length)
          ? muzzles[Math.floor(Math.random() * muzzles.length)].getWorldPosition(new THREE.Vector3())
          : e.position.clone().addScaledVector(fdir, 2);
        this._spawnBolt(start, fdir, false);
        this.audio.play('enemyLaser', 0.18);
      }
      // Once it's screamed well past the engagement, retire it.
      if (e.position.distanceTo(focus) > 260) {
        if (ud.engines) disposeEngineEffects(e);
        this.scene.remove(e);
        this.strafers.splice(this.strafers.indexOf(e), 1);
      }
    }
  }

  // O.G. & Slick rip off blaster fire at the bandit they're CHASING. Bolts leave the actual gun
  // muzzles and travel DEAD STRAIGHT along the ship's nose (local -Z) — no homing, no auto-lock. A
  // hero only squeezes the trigger once he's wrestled his nose onto his quarry (tight alignment) and
  // is reasonably close, so most bursts are aimed snap-shots and only a well-lined-up pass connects.
  // This makes the kills feel earned: chase, line up, fire, splash.
  _heroesShoot(dt) {
    this._allyFireT -= dt;
    if (this._allyFireT > 0 || this.enemyShips.length === 0) return;
    this._allyFireT = 0.12 + Math.random() * 0.1;   // burst cadence while a solution is live
    for (const hero of [this.og, this.slick]) {
      const tgt = (hero.userData.chase && this.enemyShips.includes(hero.userData.chase))
        ? hero.userData.chase : this._nearestEnemy(hero.position);
      if (!tgt) continue;
      const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(hero.quaternion).normalize();
      const toTgt = tgt.position.clone().sub(hero.position);
      const dist = toTgt.length();
      toTgt.normalize();
      // Only fire when truly lined up on the quarry AND inside firing range — a real solution.
      if (nose.dot(toTgt) < 0.94 || dist > 60) continue;
      // Spawn from a real gun muzzle (parented marker → live world position as the ship banks);
      // fall back to a nose-offset point until the model's muzzles have loaded.
      const muzzles = hero.userData.muzzles;
      let start;
      if (muzzles && muzzles.length) {
        hero.userData.muzIdx = ((hero.userData.muzIdx || 0) + 1) % muzzles.length;
        start = muzzles[hero.userData.muzIdx].getWorldPosition(new THREE.Vector3());
      } else {
        start = hero.position.clone().addScaledVector(nose, 3.2);
      }
      // Lead the target a touch and fire straight out the nose — the bolt flies dead straight.
      this._spawnBolt(start, nose, true);
      this.audio.play('laser', 0.22);
    }
  }

  // The bandits return a little (harmless) fire so the brawl reads two-sided. Like the heroes, they
  // fire straight out their own NOSE (never sideways) and only when roughly facing a hero, with a
  // little scatter so they mostly miss — this is the heroes' moment.
  _enemiesShoot(dt) {
    this._enemyFireT -= dt;
    if (this._enemyFireT > 0 || this.enemyShips.length === 0) return;
    this._enemyFireT = 0.3 + Math.random() * 0.3;
    const e = this.enemyShips[Math.floor(Math.random() * this.enemyShips.length)];
    const hero = Math.random() < 0.5 ? this.og : this.slick;
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(e.quaternion).normalize();
    const toHero = hero.position.clone().sub(e.position).normalize();
    if (nose.dot(toHero) < 0.4) return;   // only shoot when roughly pointed at a hero
    const dir = nose.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(0.18)).normalize();
    const muzzles = e.userData.muzzles;
    const start = (muzzles && muzzles.length)
      ? muzzles[Math.floor(Math.random() * muzzles.length)].getWorldPosition(new THREE.Vector3())
      : e.position.clone().addScaledVector(nose, 2);
    this._spawnBolt(start, dir, false);
  }

  _updateMissiles(dt) {
    for (const m of [...this.missiles]) {
      const ud = m.userData;
      ud.life -= dt;
      // Seek O.G.'s engine tail.
      const aim = this._ogEnginePos().sub(m.position);
      const aimDir = aim.clone().normalize();
      const curDir = ud.vel.clone().normalize();
      const maxStep = ud.turn * dt;
      const ang = Math.min(curDir.angleTo(aimDir), maxStep);
      if (ang > 1e-4) {
        const axis = new THREE.Vector3().crossVectors(curDir, aimDir).normalize();
        if (axis.lengthSq() > 1e-6) curDir.applyAxisAngle(axis, ang);
      }
      ud.vel.copy(curDir).multiplyScalar(ud.speed);
      m.position.addScaledVector(ud.vel, dt);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curDir);
      // Impact on O.G.'s engines → partial-disable beat.
      if (!this._ogDamaged && m.position.distanceTo(this._ogEnginePos()) < 4.5) {
        this._ogDamaged = true;
        this._hitTime = this.t;
        const ep = this._ogEnginePos();
        this._spark(ep, 0xfff0c0, 30, 24);
        explode(this.fxGroup, ep, 0xff7a3c, 1.0, { noRing: true });
        this.audio.play('explosion', 0.55);
        this.audio.play('shield', 0.4);
        // O.G. reacts to the engine hit 0.2s after impact (cleared on skip via _voiceTimers).
        this._voiceTimers.push(setTimeout(() => {
          this.audio.playRadioClip('assets/audio/voice/mission3/oghit.mp3', 0.95);
        }, 200));
        this.missiles.splice(this.missiles.indexOf(m), 1);
        this.scene.remove(m);
        continue;
      }
      if (ud.life <= 0) {
        this.missiles.splice(this.missiles.indexOf(m), 1);
        this.scene.remove(m);
      }
    }
  }

  _updateBolts(dt) {
    for (const b of [...this.bolts]) {
      // Bolts fly DEAD STRAIGHT — no homing. The heroes have to actually aim (see _heroesShoot).
      b.position.addScaledVector(b.userData.vel, dt);
      b.userData.life -= dt;
      let hit = false;
      if (b.userData.friendly) {
        // A well-aimed straight bolt that passes through a bandit splashes it (generous radius so
        // the lined-up cinematic kills land cleanly without auto-locking).
        for (const e of this.enemyShips) {
          if (b.position.distanceTo(e.position) < 5.5) {
            e.userData.hp -= b.userData.damage;
            this._spark(b.position.clone(), 0x9fe8ff, 6, 12);
            if (e.userData.hp <= 0) this._killEnemy(e);
            hit = true;
            break;
          }
        }
      }
      if (b.userData.life <= 0 || hit) {
        this.boltGroup.remove(b);
        this.bolts.splice(this.bolts.indexOf(b), 1);
      }
    }
  }

  _updateSparks(dt) {
    for (const p of [...this.sparks]) {
      p.position.addScaledVector(p.userData.vel, dt);
      p.userData.vel.multiplyScalar(Math.pow(0.3, dt));
      p.userData.life -= dt;
      p.material.opacity = Math.max(0, p.userData.life * 1.4);
      if (p.userData.life <= 0) {
        this.fxGroup.remove(p);
        this.sparks.splice(this.sparks.indexOf(p), 1);
      }
    }
  }

  // Advance the rich gameplay-style explosion particles spawned by explode()/spawnSmokePuff().
  _updateExplosions(dt) {
    const group = this.fxGroup;
    for (const p of [...group.children]) {
      const u = p.userData;
      if (!u || u.maxLife == null) continue;
      u.life -= dt;
      if (u.life <= 0) {
        if (u.kind === 'trigger' && u.fire) explode(group, u.fire.pos, u.fire.color, u.fire.scale, { noRing: u.fire.noRing });
        group.remove(p);
        continue;
      }
      if (u.kind === 'trigger') continue;
      const t = 1 - u.life / (u.maxLife || u.life + dt);
      if (u.kind === 'flash') {
        const s = THREE.MathUtils.lerp(u.growFrom, u.growTo, Math.min(1, t * 1.6));
        p.scale.setScalar(s);
        p.material.opacity = Math.max(0, 1 - t) ** 1.3;
      } else if (u.kind === 'ring') {
        const e = 1 - Math.pow(1 - t, 2.6);
        const s = THREE.MathUtils.lerp(0.3, u.growTo, e);
        p.scale.set(s, s, s * 0.35);
        p.material.opacity = Math.max(0, 1 - t) ** 1.5;
      } else if (u.kind === 'fireball') {
        p.position.addScaledVector(u.vel, dt);
        if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
        if (u.spin) p.material.rotation += u.spin * dt;
        const bloom = Math.sin(Math.min(1, t) * Math.PI);
        p.scale.setScalar(u.baseScale * (0.5 + bloom * 1.1));
        p.material.opacity = Math.max(0, 1 - t) * 0.95;
        p.material.color.setRGB(1, 0.78 - t * 0.5, 0.5 - t * 0.5);
      } else if (u.kind === 'smoke') {
        p.position.addScaledVector(u.vel, dt);
        if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
        if (u.spin) p.material.rotation += u.spin * dt;
        p.scale.setScalar(THREE.MathUtils.lerp(u.baseScale, u.growTo, t));
        const peak = u.peak || 0.4;
        const fade = t < peak ? t / peak : 1 - (t - peak) / (1 - peak);
        p.material.opacity = Math.max(0, fade) * 0.55;
      } else {
        p.position.addScaledVector(u.vel, dt);
        if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
        p.material.opacity = Math.max(0, 1 - t);
        if (u.streak) {
          const v = u.vel;
          const len = THREE.MathUtils.clamp(v.length() * 0.05, 1, 6) * Math.max(0.2, 1 - t);
          p.scale.set(0.7, 0.7, 1); p.scale.z = len;
          if (v.lengthSq() > 1e-4) p.lookAt(p.position.x + v.x, p.position.y + v.y, p.position.z + v.z);
        }
        if (u.kind === 'ember') p.material.color.setRGB(0.76 * (1 - t * 0.4), 0.29 * (1 - t * 0.7), 0.12 * (1 - t));
      }
    }
  }

  // Orient every ship so its nose (local -Z) points along its travel velocity, with the heroes
  // banking into turns. O.G. lists once his engines are wrecked.
  _updateShipOrient(dt) {
    const point = (ship, lookAhead, up, slerp) => {
      if (ship.userData.vel.lengthSq() < 1e-5) return;
      const dir = ship.userData.vel.clone().normalize();
      const look = ship.position.clone().addScaledVector(dir, lookAhead);
      const m = new THREE.Matrix4().lookAt(ship.position, look, up);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      ship.quaternion.slerp(q, 1 - Math.pow(slerp, dt));
    };
    const upV = new THREE.Vector3(0, 1, 0);
    if (this._ogDamaged) {
      // Listing, smoking drift.
      const ogRoll = Math.sin(this.t * 1.1) * 0.18 - 0.14;
      const ogQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.16, ogRoll, 'YXZ'));
      this.og.quaternion.slerp(ogQ, 1 - Math.pow(0.05, dt));
      point(this.slick, 1, upV, 0.05);
    } else if (this.warpDone) {
      point(this.og, 1, upV, 0.05);
      point(this.slick, 1, upV, 0.05);
    }
    for (const e of this.enemyShips) point(e, 1, upV, 0.06);
  }

  _updateCamera(dt, t) {
    const focus = this.og.position.clone();
    // ---- Ambush beat: while the strafing pack is screaming across the frame, hold a steady, slightly
    // pulled-back shot anchored on the pass so the top-right -> bottom-left diagonal clearly reads on
    // screen instead of the camera chasing O.G. and losing them. ----
    if (this.strafers.length && this._ambushFocus) {
      if (!this._ambushCamPos) {
        // Lock a wide vantage looking along the camera's current view at the pass anchor.
        this._ambushCamPos = this.camera.position.clone();
      }
      this.camera.position.lerp(this._ambushCamPos, 1 - Math.pow(0.2, dt));
      this.camera.up.set(0, 1, 0);
      // Frame the midpoint between O.G. and the pass so both the heroes and the strafers stay in shot.
      const look = this.og.position.clone().lerp(this._ambushFocus, 0.5);
      this.camera.lookAt(look);
      return;
    }
    if (!this.warpDone) {
      // Chase the arriving formation in.
      const desired = focus.clone().add(new THREE.Vector3(16, 6, 40));
      if (!this._camInit) { this.camera.position.copy(desired); this._camInit = true; }
      this.camera.position.lerp(desired, 1 - Math.pow(0.02, dt));
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(focus);
      return;
    }
    if (!this._ogDamaged) {
      // Brawl coverage: a wide, slowly swinging hero shot that keeps both the heroes and the
      // bandits roughly in frame, with a gentle orbit so the action feels dynamic.
      const ang = -0.5 + Math.sin(t * 0.45) * 0.7;
      const dist = 50;
      const desired = new THREE.Vector3(
        focus.x + Math.sin(ang) * dist,
        focus.y + 12 + Math.sin(t * 0.6) * 3,
        focus.z + Math.cos(ang) * dist + 10
      );
      this.camera.position.lerp(desired, 1 - Math.pow(0.05, dt));
      this.camera.up.set(0, 1, 0);
      // Aim at the midpoint between O.G. and the engagement CENTROID (average bandit position) rather
      // than the nearest single bandit — the nearest one swaps frame-to-frame as they jink, which made
      // the look target (and the whole camera) twitch left-right. Then smooth the look point over time
      // so it drifts gently instead of snapping.
      const mid = focus.clone();
      if (this.enemyShips.length) {
        const centroid = new THREE.Vector3();
        for (const e of this.enemyShips) centroid.add(e.position);
        centroid.multiplyScalar(1 / this.enemyShips.length);
        mid.lerp(centroid, 0.4);
      }
      if (!this._brawlLook) this._brawlLook = mid.clone();
      this._brawlLook.lerp(mid, 1 - Math.pow(0.08, dt));   // ease the look target (kills the twitch)
      this.camera.lookAt(this._brawlLook);
      return;
    }
    // After the hit: a slow cinematic push onto O.G.'s smoking flank.
    const closeIn = Math.min(1, (t - (this._hitTime || t)) / 2.4);
    const dist = THREE.MathUtils.lerp(40, 22, closeIn);
    const angle = -0.55 + closeIn * 0.2;
    const desired = focus.clone().add(new THREE.Vector3(
      Math.sin(angle) * dist * 0.7 + 14,
      6 + closeIn * 1.5,
      Math.cos(angle) * dist
    ));
    this.camera.position.lerp(desired, 1 - Math.pow(0.05, dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(focus.clone().add(new THREE.Vector3(0, 0.5, 2)));
  }
}
