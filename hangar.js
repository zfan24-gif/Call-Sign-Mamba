import * as THREE from 'three';
import { loadFighterModel, PLAYER_MODEL_URL } from './scene.js';

// ---------------------------------------------------------------------------
// Hangar diorama for the between-mission UPGRADE DRAFT screen.
//
// A small, fully self-contained Three.js scene rendered into its OWN canvas that
// sits behind the draft-card overlay. It shows the player's starfighter parked on a
// lit hangar deck (the generated hangar image as a backdrop plane), slowly turning on
// a turntable so the refit screen feels like a real ship bay rather than a frozen
// gameplay frame. It runs its own RAF loop ONLY while visible, and is paused/hidden
// the rest of the time so it never competes with the gameplay renderer.
//
// Kept separate from scene.js (the gameplay scene) so the two renderers/scenes never
// entangle; we just reuse loadFighterModel + the player GLB URL for a consistent ship.
// ---------------------------------------------------------------------------
const HANGAR_BG = 'assets/hangar-bay-interior.webp';

export class HangarView {
  constructor() {
    this.active = false;
    this.ship = null;
    this._raf = null;
    this._t = 0;
    this._lastT = 0;

    // Dedicated canvas. It must live INSIDE #ui-container as a sibling of #draft so the draft
    // overlay (and its cards) reliably stack ABOVE it in the same stacking context. Placing it
    // on document.body with a z-index let it paint over the cards. pointer-events:none so the
    // cards stay clickable through it.
    const canvas = document.createElement('canvas');
    canvas.id = 'hangarCanvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;z-index:2;pointer-events:none;opacity:0.55;';
    const uiContainer = document.getElementById('ui-container');
    if (uiContainer) uiContainer.insertBefore(canvas, uiContainer.firstChild);
    else document.body.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 200);

    // Backdrop: the hangar image on a large plane far behind the ship, sized to fill the
    // camera's view. The ship sits in front of it on a notional deck.
    const loader = new THREE.TextureLoader();
    const bgTex = loader.load(HANGAR_BG);
    bgTex.colorSpace = THREE.SRGBColorSpace;
    this.bgMat = new THREE.MeshBasicMaterial({ map: bgTex, depthWrite: false });
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bgMat);
    this.bg.position.set(0, 0, -26);
    this.scene.add(this.bg);

    // Lighting: a cool key from above-front (matching the hangar spotlights) plus soft fill
    // and a warm rim so the hull reads with dimensional shading rather than flat.
    this.scene.add(new THREE.AmbientLight(0x4a6680, 0.9));
    const key = new THREE.DirectionalLight(0xcfe8ff, 1.6); key.position.set(2, 6, 5); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6fc7ff, 0.6); fill.position.set(-4, 1, 3); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0x88e0ff, 0.8); rim.position.set(0, 3, -6); this.scene.add(rim);
    // A subtle pool of light on the deck under the ship.
    const deckGlow = new THREE.PointLight(0x66e0ff, 8, 18, 2); deckGlow.position.set(0, -2.5, 2); this.scene.add(deckGlow);

    // Turntable the ship rides on, so we rotate the whole rig cleanly.
    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);

    // Steam group: soft white puffs that vent up from the deck around the ship at touchdown.
    // Lives in the scene (not on the ship) so puffs stay planted on the deck and drift up.
    this.steamGroup = new THREE.Group();
    this.scene.add(this.steamGroup);
    this._buildSteam();

    // Camera framing: slightly above the deck, looking down at the parked ship.
    this.camera.position.set(0, 1.4, 11);
    this.camera.lookAt(0, 0.2, 0);

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    // Load the player ship once (cached GLB) and park it on the turntable.
    this._loadShip();
  }

  _loadShip() {
    // loadFighterModel orients the nose to -Z and scales to the given length. The camera sits
    // at +Z looking toward -Z, so rotating 180° about Y points the nose straight at the camera
    // (rest pose), while y=0 points the engines/tail at the camera (fly-in approach pose).
    this.ship = loadFighterModel(PLAYER_MODEL_URL, 6.5, (g) => {
      // Set DOWN on the deck (lower than before so it rests on the hangar floor instead of floating
      // mid-frame) and pitched a hair nose-up, the way a parked fighter sits on its landing gear.
      g.position.set(0, -1.6, 0);
      g.rotation.y = Math.PI;        // face the camera, head-on
      g.rotation.x = -0.06;          // slight nose-up resting pitch
      this._addEngineGlow(g);        // mount the small exhaust glows on the tail
    });
    this.turntable.add(this.ship);
    // Cache the parked resting pose so the landing animation can ease the ship into it.
    this._restPose = { x: 0, y: -1.6, z: 0, rx: -0.06, ry: Math.PI };
    this._landT = 0;          // landing-animation clock (seconds); >= LAND_DUR == fully parked
    this._landing = false;    // true while playing the fly-in/touch-down
    this.LAND_DUR = 5.0;      // seconds for the ship to fly in, swing around, and settle on the deck
    // The fly-in reads as the PLAYER flying in toward the camera, then wheeling around to face us.
    // Phase A (enter): the fighter streaks in from near/above the camera, NOSE pointing into the
    //   bay (away from camera), sweeping deep down the corridor.
    // Phase B (turn + land): it banks 180° to face the camera and descends onto the resting pose.
    this._ENTER_POS = { x: 0, y: 5.5, z: 13 };   // near the camera, high — "just flew in"
    this._DEEP_POS  = { x: 0, y: 4.0, z: -26 };  // deep in the bay, top of the turn-around arc
  }

  // Build a couple of soft additive glow sprites at the ship's TAIL (local +Z) so the engines read
  // as lit. Parented to the ship group so they roll/yaw with it. A radial-gradient canvas texture
  // keeps it dependency-free. Brightness is driven each frame in the landing loop (bright on the
  // fly-in, dim once parked) via this._engineGlows.
  _addEngineGlow(g) {
    if (!this._glowTex) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const ctx = c.getContext('2d');
      const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(190,235,255,1)');
      grd.addColorStop(0.4, 'rgba(90,190,255,0.65)');
      grd.addColorStop(1, 'rgba(40,120,255,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
      this._glowTex = new THREE.CanvasTexture(c);
      this._glowTex.colorSpace = THREE.SRGBColorSpace;
    }
    this._engineGlows = [];
    this._engineTrails = [];
    // Tail is the +Z end of the ~6.5-long model; place two glows just aft of center, spread on X.
    for (const dx of [-0.85, 0.85]) {
      const mat = new THREE.SpriteMaterial({ map: this._glowTex, color: 0x9fdcff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.0 });
      const sp = new THREE.Sprite(mat);
      sp.position.set(dx, 0, 3.1);     // local +Z tail
      sp.scale.setScalar(1.6);
      g.add(sp);
      this._engineGlows.push(sp);

      // A short blue exhaust streak just AFT of each glow (further down +Z). It's a stretched
      // sprite so it reads as a thin tapering trail; its length/opacity track the engine burn so
      // it only shows while throttling into the bay and vanishes as the ship settles to land.
      const tMat = new THREE.SpriteMaterial({ map: this._glowTex, color: 0x6fc2ff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.0 });
      const tr = new THREE.Sprite(tMat);
      tr.position.set(dx, 0, 4.4);     // sit behind the glow, down the tail
      tr.scale.set(0.7, 2.2, 1);       // narrow + elongated along the trail axis
      g.add(tr);
      this._engineTrails.push(tr);
    }
  }

  // Build a pool of soft white steam puff sprites (reused, hidden until vented). A radial gradient
  // canvas texture gives each puff a cloudy, feathered edge; NormalBlending + white keeps them
  // reading as billowing vapor rather than additive glow. Each puff carries its own velocity/life
  // in userData and is recycled on every touchdown burst.
  _buildSteam() {
    if (!this._steamTex) {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const ctx = c.getContext('2d');
      const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.35, 'rgba(232,244,255,0.55)');
      grd.addColorStop(0.7, 'rgba(210,230,250,0.18)');
      grd.addColorStop(1, 'rgba(200,225,250,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, 128, 128);
      this._steamTex = new THREE.CanvasTexture(c);
      this._steamTex.colorSpace = THREE.SRGBColorSpace;
    }
    this._steam = [];
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({ map: this._steamTex, color: 0xeaf4ff, transparent: true,
        depthWrite: false, opacity: 0 });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.userData = { life: 0, maxLife: 1, vy: 0, vx: 0, vz: 0, growth: 1 };
      this.steamGroup.add(sp);
      this._steam.push(sp);
    }
  }

  // Vent a burst of steam from the deck around the ship's landing footprint. Recycles puffs from
  // the pool, scattering them along the underside so vapor billows up on either flank.
  _burstSteam() {
    if (!this._steam) return;
    const r = this._restPose;
    let launched = 0;
    for (const sp of this._steam) {
      if (launched >= 18) break;
      if (sp.visible && sp.userData.life < sp.userData.maxLife) continue;  // still venting; leave it
      launched++;
      // Scatter around the ship's footprint: spread on X (both flanks), a little along Z.
      const side = Math.random() < 0.5 ? -1 : 1;
      const px = side * (0.6 + Math.random() * 2.6);
      const pz = (Math.random() - 0.5) * 4.5;
      sp.position.set(px, r.y - 0.8, pz);   // start just below the parked ship, at deck level
      sp.userData.life = 0;
      sp.userData.maxLife = 0.9 + Math.random() * 0.7;
      sp.userData.vy = 1.4 + Math.random() * 1.6;          // rise speed
      sp.userData.vx = side * (0.4 + Math.random() * 0.9); // billow outward to the flanks
      sp.userData.vz = (Math.random() - 0.5) * 0.5;
      sp.userData.growth = 1.6 + Math.random() * 1.8;      // expand as it rises
      sp.scale.setScalar(0.8 + Math.random() * 0.6);
      sp.material.opacity = 0;
      sp.visible = true;
    }
  }

  // Advance every live steam puff: rise + drift + expand, fade in fast then out as it dissipates.
  _updateSteam(dt) {
    if (!this._steam) return;
    for (const sp of this._steam) {
      if (!sp.visible) continue;
      const u = sp.userData;
      u.life += dt;
      if (u.life >= u.maxLife) { sp.visible = false; sp.material.opacity = 0; continue; }
      const f = u.life / u.maxLife;                 // 0..1 lifetime fraction
      sp.position.x += u.vx * dt;
      sp.position.y += u.vy * dt;
      sp.position.z += u.vz * dt;
      u.vy *= (1 - 0.4 * dt);                       // slow the rise as it cools
      sp.scale.setScalar(sp.scale.x + u.growth * dt);
      // Fade in over the first ~15% of life, then ease out to nothing.
      const fadeIn = Math.min(1, f / 0.15);
      const fadeOut = 1 - Math.max(0, (f - 0.3) / 0.7);
      sp.material.opacity = 0.6 * fadeIn * fadeOut;
    }
  }

  // Begin the "ship flies into the hangar and lands" entrance. The fighter sweeps in from deep in
  // the bay tail-first (engines toward the camera), then ROLLS/yaws around to nose-toward-camera as
  // it descends and settles onto its resting deck pose. Drives the pose in show()'s loop until
  // LAND_DUR elapses, after which it sits parked exactly like the static view.
  startLanding() {
    this._landing = true;
    this._landT = 0;
    this._toldTouchdown = false;
    this._steamFollowT = 0;
    if (this.ship) {
      // Start pose: near/above the camera with the NOSE pointing INTO the bay (ry=0, nose -Z),
      // as if the player just flew past the camera into the hangar. Slight nose-down dive in.
      const p = this._ENTER_POS;
      this.ship.position.set(p.x, p.y, p.z);
      this.ship.rotation.set(-0.12, 0, 0);
      this.ship.scale.setScalar(1);
    }
  }

  // Size the backdrop plane to exactly fill the camera frustum at its depth, and keep the
  // renderer matched to the window.
  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Fit the backdrop plane to the frustum at the plane's distance from the camera.
    const dist = this.camera.position.z - this.bg.position.z;
    const vH = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * dist;
    const vW = vH * this.camera.aspect;
    // Cover (not contain): scale up a touch so the image always fills, cropping edges.
    const cover = 1.12;
    this.bg.scale.set(vW * cover, vH * cover, 1);
  }

  // show({ landing, onLanded }): when `landing` is true the ship flies in and touches down on the
  // deck (firing onLanded once settled); otherwise it's parked statically as before.
  show(opts = {}) {
    if (this.active) return;
    this.active = true;
    this.canvas.style.display = 'block';
    this._lastT = performance.now();
    this._onLanded = opts.onLanded || null;
    this._onTouchdown = opts.onTouchdown || null;   // fired once as the gear contacts the deck
    if (opts.landing) this.startLanding();
    else { this._landing = false; if (this.ship) { const r = this._restPose; this.ship.position.set(r.x, r.y, r.z); this.ship.rotation.set(r.rx, Math.PI, 0); this.ship.scale.setScalar(1); } }
    const loop = (t) => {
      if (!this.active) return;
      const dt = Math.min(0.05, (t - this._lastT) / 1000);
      this._lastT = t;
      this._t += dt;
      if (this._landing && this.ship) {
        // Drive the fly-in: ease the ship from its high/far, ENGINES-toward-camera approach pose
        // down onto the resting deck pose, ROLLING/yawing around to nose-toward-camera on the way.
        // easeOutCubic on translation so it decelerates into a gentle touch-down; the yaw is eased
        // on its own curve that finishes a touch early so the nose settles before the ship parks.
        this._landT += dt;
        const r = this._restPose;
        const en = this._ENTER_POS, dp = this._DEEP_POS;
        const k = Math.min(1, this._landT / this.LAND_DUR);
        const lerp = (a, b, t) => a + (b - a) * t;
        const SPLIT = 0.42;   // fraction of the clock spent on the fly-in before the turn-around
        let glowK;            // 0..1 maneuver intensity for engine glow (1 = full burn)
        if (k < SPLIT) {
          // --- Phase A: streak IN toward/past the camera, nose pointing INTO the bay (ry=0). ---
          const ka = k / SPLIT;
          const ea = 1 - Math.pow(1 - ka, 2);     // easeOut: fast entry, settling deep
          this.ship.position.x = lerp(en.x, dp.x, ea);
          this.ship.position.y = lerp(en.y, dp.y, ea);
          this.ship.position.z = lerp(en.z, dp.z, ea);
          this.ship.rotation.x = lerp(-0.12, 0.05, ea);
          this.ship.rotation.y = 0;               // nose still pointing into the bay
          this.ship.rotation.z = 0;
          glowK = 1;                              // full burn on the way in
        } else {
          // --- Phase B: bank 180° to face the camera and descend onto the resting deck pose. ---
          const kb = (k - SPLIT) / (1 - SPLIT);
          const eb = kb < 0.5 ? 4 * kb * kb * kb : 1 - Math.pow(-2 * kb + 2, 3) / 2;  // easeInOutCubic
          this.ship.position.x = lerp(dp.x, r.x, eb);
          this.ship.position.y = lerp(dp.y, r.y, eb);
          this.ship.position.z = lerp(dp.z, r.z, eb);
          this.ship.rotation.x = lerp(0.05, r.rx, eb);
          // Yaw 0 -> PI: nose swings from facing-away to facing the camera as it wheels around.
          this.ship.rotation.y = Math.PI * eb;
          // A banked roll through the turn that flattens out as it settles (sin hump, 0 at ends).
          this.ship.rotation.z = Math.sin(eb * Math.PI) * 0.5;
          glowK = 1 - eb;                         // burn fades as it slows into the landing
        }
        this.ship.scale.setScalar(1);
        // Engine glow: bright while maneuvering, easing down to a faint idle once landed.
        if (this._engineGlows) {
          const glow = 0.9 * glowK + 0.12 * (1 - glowK);
          const flick = 1 + 0.12 * Math.sin(this._t * 30);
          for (const sp of this._engineGlows) {
            sp.material.opacity = glow * flick;
            sp.scale.setScalar((1.4 + 0.5 * glowK) * flick);
          }
        }
        // Blue exhaust trail: only a SUBTLE streak while throttling into the bay. We square glowK
        // so it falls off quickly and is essentially gone before the ship settles to land.
        if (this._engineTrails) {
          const burn = glowK * glowK;                  // steeper falloff than the glow
          const flick = 1 + 0.1 * Math.sin(this._t * 24);
          for (const tr of this._engineTrails) {
            tr.material.opacity = 0.32 * burn * flick;  // faint at most
            tr.scale.set(0.55 + 0.2 * burn, 1.2 + 3.2 * burn, 1);  // longer while burning
            tr.position.z = 4.0 + 1.6 * burn;           // streams further back at full throttle
          }
        }
        // Touchdown cue: fire just before the ship fully settles (gear contact), once.
        if (!this._toldTouchdown && k >= 0.93) {
          this._toldTouchdown = true;
          this._burstSteam();                          // big vent of steam as the gear bites
          this._steamFollowT = 0.22;                   // schedule a smaller secondary vent
          const td = this._onTouchdown; if (td) td();
        }
        // A second, smaller steam release shortly after touchdown (pressure bleeding off).
        if (this._steamFollowT > 0) {
          this._steamFollowT -= dt;
          if (this._steamFollowT <= 0) this._burstSteam();
        }
        if (k >= 1) {
          // Fully parked: snap to exact rest pose, end the animation, and notify once.
          this.ship.position.set(r.x, r.y, r.z);
          this.ship.rotation.set(r.rx, r.ry, 0);
          this.ship.scale.setScalar(1);
          this._landing = false;
          const cb = this._onLanded; this._onLanded = null;
          if (cb) cb();
        }
      } else if (this._engineGlows && this.ship) {
        // Parked idle: keep a faint, gently-flickering engine glow so the ship doesn't read as dead.
        const flick = 1 + 0.1 * Math.sin(this._t * 6);
        for (const sp of this._engineGlows) { sp.material.opacity = 0.12 * flick; sp.scale.setScalar(1.4); }
        // No exhaust trail at rest — the engines are idling, not throttling.
        if (this._engineTrails) for (const tr of this._engineTrails) tr.material.opacity = 0;
      }
      // Drive the post-upgrade takeoff if one is playing (independent of the landing/idle branch
      // above — launchShip snaps the pose and then this owns the ship until it flies off-screen).
      if (this._launching) this._updateLaunch(dt);
      // Advance any live steam puffs (they outlive the landing animation as they dissipate).
      this._updateSteam(dt);
      // When not animating, the ship sits parked at its fixed resting pose (no spin, no bob).
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  // launchShip({ onOffscreen, onDone }): play the post-upgrade TAKEOFF. The parked fighter lights its
  // engines, lifts off the deck, rolls to face the camera, then accelerates toward the viewer and
  // banks hard off to the LEFT, dragging a bright exhaust trail that streaks off-screen behind it.
  //   - onOffscreen fires the instant the ship has cleared the frame (cue the warp flash + sound).
  //   - onDone fires a beat later, once the trail has finished streaking away (tear down + continue).
  // Safe even if the ship GLB hasn't loaded yet — it just resolves the callbacks on a timer.
  launchShip(opts = {}) {
    const onOffscreen = opts.onOffscreen || null;
    const onDone = opts.onDone || null;
    if (!this.ship) {
      // No ship to fly (model still loading): fall straight through so the sequence never stalls.
      if (onOffscreen) onOffscreen();
      setTimeout(() => { if (onDone) onDone(); }, 350);
      return;
    }
    // Snap to a clean parked pose to launch from, then drive the takeoff in show()'s loop.
    const r = this._restPose;
    this.ship.position.set(r.x, r.y, r.z);
    this.ship.rotation.set(r.rx, r.ry, 0);
    this.ship.scale.setScalar(1);
    this._launching = true;
    this._launchT = 0;
    this._launchOffscreenFired = false;
    this._launchDoneFired = false;
    this._onLaunchOffscreen = onOffscreen;
    this._onLaunchDone = onDone;
    this.LAUNCH_DUR = 1.7;        // seconds for the whole lift-off + fly-out
    this._launchStart = { x: r.x, y: r.y, z: r.z };
    // Make sure the loop is running to drive it (show() may already be active from the draft).
    if (!this.active) this.show();
  }

  // Per-frame takeoff driver, called from the show() loop while _launching is true. Eases the ship
  // up off the deck, rolls it level/toward camera, then flings it toward the viewer and off the
  // left edge with a hot exhaust burn. Fires onOffscreen as it clears frame and onDone at the end.
  _updateLaunch(dt) {
    if (!this._launching || !this.ship) return;
    this._launchT += dt;
    const k = Math.min(1, this._launchT / this.LAUNCH_DUR);
    const s = this._launchStart;
    const lerp = (a, b, t) => a + (b - a) * t;
    const easeInCubic = (t) => t * t * t;
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    // Phase A (0 -> 0.32): lift off the deck and spool the engines — a short hover/rise as the
    // fighter unsticks from the hangar floor. Phase B (0.32 -> 1): accelerate toward the camera
    // and bank off to the LEFT, leaving the frame.
    const SPLIT = 0.32;
    let burn;   // 0..1 engine intensity
    if (k < SPLIT) {
      const ka = k / SPLIT;
      const e = easeOutCubic(ka);
      this.ship.position.x = s.x;
      this.ship.position.y = lerp(s.y, s.y + 1.4, e);   // rise off the deck
      this.ship.position.z = lerp(s.z, s.z + 1.0, e);   // ease a touch toward the camera
      this.ship.rotation.x = lerp(this._restPose.rx, -0.18, e);   // nose lifts as it powers up
      this.ship.rotation.y = Math.PI;
      this.ship.rotation.z = 0;
      burn = 0.4 + 0.6 * e;
    } else {
      const kb = (k - SPLIT) / (1 - SPLIT);
      const eAccel = easeInCubic(kb);     // accelerate hard (slow start, fast exit)
      // Fly TOWARD the camera (+Z) and hard off to the LEFT (-X), climbing slightly, so it sweeps
      // up-left out of frame from the viewer's seat.
      this.ship.position.x = lerp(s.x, s.x - 30, eAccel);
      this.ship.position.y = lerp(s.y + 1.4, s.y + 7.0, eAccel);
      this.ship.position.z = lerp(s.z + 1.0, s.z + 16, eAccel);   // rush past the camera
      // Bank into the left break and pitch the nose around toward the exit vector.
      this.ship.rotation.x = lerp(-0.18, -0.5, eAccel);
      this.ship.rotation.y = Math.PI + lerp(0, 0.7, eAccel);   // yaw toward its left break
      this.ship.rotation.z = lerp(0, 1.1, eAccel);             // hard bank to the left
      // Grow the ship a little as it nears the camera so the fly-past reads with depth.
      this.ship.scale.setScalar(lerp(1, 1.5, eAccel));
      burn = 1;
    }

    // Engine glow + exhaust trail: full, blazing burn through the launch so it drags a bright streak.
    if (this._engineGlows) {
      const flick = 1 + 0.14 * Math.sin(this._t * 34);
      for (const sp of this._engineGlows) {
        sp.material.opacity = Math.min(1, (0.5 + 0.7 * burn) * flick);
        sp.scale.setScalar((1.6 + 1.1 * burn) * flick);
      }
    }
    if (this._engineTrails) {
      const flick = 1 + 0.12 * Math.sin(this._t * 26);
      for (const tr of this._engineTrails) {
        tr.material.opacity = Math.min(1, 0.6 * burn * flick);
        tr.scale.set(0.7 + 0.3 * burn, 2.0 + 5.5 * burn, 1);   // long, hot streak that trails off
        tr.position.z = 4.2 + 2.6 * burn;
      }
    }

    // Offscreen cue: by ~0.82 of the launch the ship has clearly left the frame (far off-left and
    // past the camera). Fire onOffscreen once so the caller can flash + play the warp sound.
    if (!this._launchOffscreenFired && k >= 0.82) {
      this._launchOffscreenFired = true;
      const cb = this._onLaunchOffscreen; this._onLaunchOffscreen = null;
      if (cb) cb();
    }
    // Done: end the launch, hide the ship (it's gone to lightspeed), and notify once.
    if (k >= 1) {
      this._launching = false;
      this.ship.visible = false;
      if (this._engineGlows) for (const sp of this._engineGlows) sp.material.opacity = 0;
      if (this._engineTrails) for (const tr of this._engineTrails) tr.material.opacity = 0;
      if (!this._launchDoneFired) {
        this._launchDoneFired = true;
        const cb = this._onLaunchDone; this._onLaunchDone = null;
        if (cb) cb();
      }
    }
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.canvas.style.display = 'none';
    // Reset launch state + restore ship visibility so a future hangar show starts clean.
    this._launching = false;
    if (this.ship) this.ship.visible = true;
  }
}
