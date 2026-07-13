import * as THREE from 'three';
import { makePlayerShip, loadFighterModel, ENEMY_FIGHTER_URLS, makeBolt, updateEngineTrails, attachEnemyExhaust, disposeEngineEffects, explode, spawnSmokePuff, flashPlayerShield, updatePlayerShield } from './scene.js';

// ---------------------------------------------------------------------------
// Opening cutscene: a black starfield, the hero ship warps in from hyperspace,
// six crimson enemy fighters set up, and a scripted dogfight ensues with both
// sides firing real laser bolts and trading hits. Self-contained: its own scene,
// camera, and animation loop. Calls onComplete() when finished (or on skip).
// ---------------------------------------------------------------------------

// Paint a deep-space starfield onto a 4096x2048 canvas and return it. Shared by the
// cutscene's scene-background texture AND the studio card's CSS backdrop so the same
// crisp star pattern sits behind "An SEMB Enterprises Production" and the warp-in.
export function paintStarfieldCanvas() {
  const c = document.createElement('canvas');
  c.width = 4096; c.height = 2048;             // higher res so small stars stay crisp
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#01030a';                   // deep space black
  ctx.fillRect(0, 0, c.width, c.height);

  // A subtle cool/warm tint pool so stars aren't all the same flat blue-white.
  const tints = ['255,255,255', '215,230,255', '255,244,226', '198,216,255', '255,232,236'];
  const pick = () => tints[(Math.random() * tints.length) | 0];

  // 1) The bulk: tiny CRISP single-pixel stars. Solid fill (no soft halo) = sharp points,
  //    not blotches. Varied alpha gives a natural mix of faint and present stars.
  for (let i = 0; i < 5000; i++) {
    const x = (Math.random() * c.width) | 0;
    const y = (Math.random() * c.height) | 0;
    ctx.fillStyle = `rgba(${pick()},${0.45 + Math.random() * 0.5})`;
    ctx.fillRect(x, y, 1, 1);
  }

  // 2) Mid stars: a crisp 2px solid core, a touch brighter.
  for (let i = 0; i < 900; i++) {
    const x = (Math.random() * c.width) | 0;
    const y = (Math.random() * c.height) | 0;
    ctx.fillStyle = `rgba(${pick()},${0.7 + Math.random() * 0.3})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // 3) Hero stars: a bright solid core PLUS a small tight glow so they sparkle without
  //    smearing. The glow radius is kept small so it reads as a point, not a blob.
  for (let i = 0; i < 130; i++) {
    const x = Math.random() * c.width, y = Math.random() * c.height;
    const tint = pick();
    const glowR = 3 + Math.random() * 3;
    const g = ctx.createRadialGradient(x, y, 0, x, y, glowR);
    g.addColorStop(0, `rgba(${tint},0.9)`);
    g.addColorStop(0.4, `rgba(${tint},0.25)`);
    g.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI * 2); ctx.fill();
    // Bright solid core on top so the center is a hard, crisp point.
    ctx.fillStyle = `rgba(255,255,255,1)`;
    ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
  }
  return c;
}

export class OpeningCutscene {
  constructor(renderer, audio, onComplete) {
    this.renderer = renderer;
    this.audio = audio;
    this.onComplete = onComplete;
    this.done = false;
    this.t = 0;
    this.warpDone = false;
    // Timestamp (seconds into the score track) of the music's dramatic climax — the swell
    // the warp-out should land on. The score begins on the studio card before start(), so
    // this is measured against the score element's own currentTime. Tuned so the lightspeed
    // jump fires right as the peak crests. _resolveScorePeak() clamps it to the real track
    // length once metadata is known, and the jump trigger waits for this position.
    this._scorePeak = 46;
    this._scorePeakResolved = false;
    this.combatStarted = false;   // dogfight is gated until the Overwatch briefing ends
    this.briefingEnded = false;   // set by main.js when the voice-over (started earlier) ends
    this.bolts = [];
    this.sparks = [];
    this.enemies = [];
    // Aileron-roll flourish state: _rollT >= _rollDur means no roll in progress.
    this._rollT = 1; this._rollDur = 1.25; this._rollDir = 1;
    this._rollCooldown = 3.0;    // min seconds between rolls
    this._rollsLeft = 4;         // only a few flourishes across the whole cutscene
    this._strafeRolled = false;  // one firing-pass roll per strafe phase
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x01030a, 0.0035);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 4000);
    this._buildWorld();
    this._buildPlayer();
    this._buildEnemies();

    this._timer = new THREE.Timer();
    this._onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);
  }

  // Build a soft radial-gradient sprite texture for the sun glow layers.
  _radialTex(hex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const col = new THREE.Color(hex);
    const r = Math.round(col.r * 255), g = Math.round(col.g * 255), b = Math.round(col.b * 255);
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},0.55)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Paint a starry sky onto a canvas and return it as a scene-background texture. Drawing
  // the stars into the backdrop guarantees they're always visible behind everything with
  // zero parallax — the simplest, most reliable way to get "stars on a black background".
  _makeStarrySkyTexture() {
    const tex = new THREE.CanvasTexture(paintStarfieldCanvas());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.anisotropy = 4;                          // keep tiny stars sharp at grazing angles
    return tex;
  }

  // Stream a starfield Points cloud toward/past the camera so the whole background
  // whooshes by during the warp-in (not just the foreground line streaks). Stars move
  // along the camera's forward axis in the field's local space; any that pass behind the
  // camera are recycled out to the far distance with a fresh lateral offset, giving a
  // continuous "flying through space" feel from all directions around the ship.
  _streamStarfield(field, dt, speed) {
    const attr = field.geometry.attributes.position;
    const arr = attr.array;

    // CRITICAL: stars must stream along the CAMERA's actual view direction, not the
    // field's local Z. The warp line-streaks (`_updateWarpStreaks`) already converge on
    // the camera's forward axis (center of screen); if the Points cloud instead drifts
    // along world/field Z while the camera looks elsewhere, the two layers radiate from
    // DIFFERENT vanishing points — which is the off-center, too-high streak origin seen
    // during warp-in. We fix that by tracking each star as a screen-plane offset (x,y in
    // the camera's right/up basis) plus a depth ahead of the camera, exactly like the
    // line streaks, so everything converges on the same point dead ahead.
    if (field.userData.streamSeeds == null) {
      // First stream frame: project the resting positions into per-star {x,y,depth} seeds
      // relative to the camera basis so the transition into streaming is seamless.
      field.userData.streamSeeds = new Float32Array(arr.length); // [x,y,depth] per star
    }
    const seeds = field.userData.streamSeeds;

    this.camera.updateMatrixWorld();
    const camPos = this.camera.position;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

    // On the very first streaming frame, derive each star's seed from its current world
    // position so it doesn't jump. After that we advance the depth and rewrite world pos.
    if (!field.userData.streaming) {
      for (let i = 0; i < arr.length; i += 3) {
        const rel = new THREE.Vector3(arr[i], arr[i + 1], arr[i + 2]).sub(camPos);
        const depth = rel.dot(fwd);                 // distance ahead of camera (+ = ahead)
        seeds[i] = rel.dot(right);
        seeds[i + 1] = rel.dot(up);
        seeds[i + 2] = depth < 60 ? 200 + Math.random() * 1500 : depth;
      }
      field.userData.streaming = true;
    }

    const move = speed * dt;             // advance toward the viewer
    const behind = -60;                  // recycle once depth slips behind the camera
    const tmp = new THREE.Vector3();
    for (let i = 0; i < arr.length; i += 3) {
      seeds[i + 2] -= move;              // depth shrinks as stars rush toward us
      if (seeds[i + 2] < behind) {
        const ang = Math.random() * Math.PI * 2;
        const rad = 60 + Math.random() * 900;
        seeds[i] = Math.cos(ang) * rad;
        seeds[i + 1] = Math.sin(ang) * rad;
        seeds[i + 2] = 1400 + Math.random() * 400;
      }
      // World position = camPos + right*x + up*y + fwd*depth  -> converges dead ahead.
      tmp.copy(camPos)
        .addScaledVector(right, seeds[i])
        .addScaledVector(up, seeds[i + 1])
        .addScaledVector(fwd, seeds[i + 2]);
      arr[i] = tmp.x; arr[i + 1] = tmp.y; arr[i + 2] = tmp.z;
    }
    attr.needsUpdate = true;
  }

  // Drive the warp streak field: advance each streak toward/past the camera and write its
  // head + tail vertices so the background reads as long light streaks. `intensity` (0..1)
  // both scales speed and the streak LENGTH, so streaks bloom long at full warp and
  // collapse toward dots as we drop to sublight. Centered on the camera's local space.
  _updateWarpStreaks(dt, intensity) {
    // Drive BOTH concentric streak tubes. They share one origin/axis (the ship) so they
    // read as one nested tube — an inner dense core and an outer ring around it — instead
    // of the old single field whose convergence point sat off to the side of the ship.
    this._driveStreakLayer(this.warpStreaks, this._streakSeeds, dt, intensity, 1.0);
    if (this.warpStreaksOuter) {
      this._driveStreakLayer(this.warpStreaksOuter, this._streakSeedsOuter, dt, intensity, 0.7);
    }
  }

  // Advance one streak LineSegments layer and write its head/tail vertices. All streaks
  // converge on the SHIP and rush straight down the ship's travel axis, so the tube's
  // vanishing point is locked dead-on the ship (no off-center "fireworks" burst). The
  // camera's right/up only orient the cross-section so the tube faces the viewer.
  _driveStreakLayer(layer, seeds, dt, intensity, opacityScale) {
    if (!layer) return;
    layer.visible = true;
    layer.material.opacity = 0.95 * opacityScale * THREE.MathUtils.clamp(intensity * 1.3, 0, 1);
    const arr = layer.geometry.attributes.position.array;

    // Origin + axis come from the SHIP: streaks pour from ahead of the ship straight back
    // past it along its nose->tail line, so everything converges exactly on the ship.
    const origin = this.player.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.quaternion).normalize();
    // Cross-section basis: use the camera's screen plane so the tube's radial spread always
    // faces the viewer regardless of roll.
    this.camera.updateMatrixWorld();
    const camFwd = new THREE.Vector3();
    this.camera.getWorldDirection(camFwd);
    let right = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-5) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, camFwd).normalize();

    // Speed and length both scale strongly with warp intensity so that at the START of the
    // ramp (intensity near 0) the streaks are nearly still and SHORT — reading as the resting
    // background stars — then stretch long and rush fast as intensity climbs to full warp. The
    // small floors keep a hint of drift so the field is never frozen.
    const move = (90 + intensity * intensity * 4200) * dt;   // travel speed toward the viewer
    const tailLen = 4 + intensity * intensity * 392;         // streak length grows hard with warp
    const behind = 70;                             // recycle once a streak passes the ship
    const tmpH = new THREE.Vector3();
    const tmpT = new THREE.Vector3();
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      // s.z is depth ahead of the ship (more negative = farther ahead). Advancing toward
      // the viewer means increasing z toward +behind.
      s.z += move;
      if (s.z > behind) {
        const ang = Math.random() * Math.PI * 2;
        const rad = s.rMin + Math.pow(Math.random(), 0.6) * (s.rMax - s.rMin);
        s.x = Math.cos(ang) * rad;
        s.y = Math.sin(ang) * rad;
        s.z = -1700 - Math.random() * 400;
      }
      // World head = shipPos + right*x + up*y + fwd*(-z) [-z because ahead is negative].
      const depth = -s.z;
      tmpH.copy(origin)
        .addScaledVector(right, s.x)
        .addScaledVector(up, s.y)
        .addScaledVector(fwd, depth);
      // Tail trails back AWAY from the viewer along the ship axis (deeper ahead).
      tmpT.copy(tmpH).addScaledVector(fwd, tailLen);
      const h = (i * 2) * 3, ta = (i * 2 + 1) * 3;
      arr[h] = tmpH.x; arr[h + 1] = tmpH.y; arr[h + 2] = tmpH.z;
      arr[ta] = tmpT.x; arr[ta + 1] = tmpT.y; arr[ta + 2] = tmpT.z;
    }
    layer.geometry.attributes.position.needsUpdate = true;
  }

  _hideWarpStreaks() {
    if (this.warpStreaks) this.warpStreaks.visible = false;
    if (this.warpStreaksOuter) this.warpStreaksOuter.visible = false;
  }

  // After the warp ends, ease the streamed positions back to their pristine resting
  // layout so the background returns to a calm, evenly distributed starfield.
  _settleStarfield(field) {
    const base = field.userData.base;
    if (!base) return;
    const attr = field.geometry.attributes.position;
    attr.array.set(base);
    attr.needsUpdate = true;
    // Clear the streaming state so a future warp re-projects fresh camera-basis seeds
    // from this restored resting layout (no stale offsets carried across jumps).
    field.userData.streaming = false;
  }

  // Black background speckled with a dense starfield.
  _buildWorld() {
    this.scene.background = new THREE.Color(0x01030a);
    // Match the gameplay scene's lighting so the enemy hulls POP the same way in the
    // cutscene as they do in-mission: a bright cool ambient base, a stronger warm "sun"
    // key, a sky-to-space hemisphere fill, and a cool opposite-side bounce.
    this.scene.add(new THREE.AmbientLight(0x87a6ff, 0.6));

    // ---- Distant sun far off in the background ----
    // Sits up-and-to-one-side so its directional light rakes across the ships for nice
    // sculpted highlights and shadowed flanks. Stronger + warmer now so the crimson
    // fighters catch real sunlight against the dark starfield (matches gameplay).
    const sunDir = new THREE.Vector3(0.55, 0.42, -0.72).normalize();
    const sunPos = sunDir.clone().multiplyScalar(1600);
    // Directional key light coming FROM the sun's direction.
    const key = new THREE.DirectionalLight(0xfff4e0, 3.4);
    key.position.copy(sunPos);
    this.scene.add(key);
    // Hemisphere fill: a soft sky-to-space gradient so unlit faces pick up a cool glow and
    // the ships read three-dimensionally rather than going pure black on their shadow side.
    this.scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x14203a, 0.7));
    // Cool fill/bounce from the opposite side so shadowed faces don't go fully black.
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.copy(sunPos.clone().multiplyScalar(-1));
    this.scene.add(rim);

    // Visible sun: a small bright disc with layered additive glow. Modest scale so it
    // reads as a far-off star, not a foreground fireball.
    this.sunGroup = new THREE.Group();
    this.sunGroup.position.copy(sunPos);
    const disc = new THREE.Mesh(
      new THREE.SphereGeometry(40, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff3da })
    );
    this.sunGroup.add(disc);
    const glowInner = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._radialTex(0xfff0d0), color: 0xffe9c0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    glowInner.scale.setScalar(360);
    this.sunGroup.add(glowInner);
    const glowOuter = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._radialTex(0xffd9a0), color: 0xffcf95, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    glowOuter.scale.setScalar(820);
    this.sunGroup.add(glowOuter);
    this.scene.add(this.sunGroup);

    // ---- Background starfield ----
    // PAINTED directly into the scene background texture. This is bulletproof: it is the
    // backdrop itself, so it can never have parallax, never be culled, and never go
    // sub-pixel. We draw a few thousand soft white dots onto a canvas and use it as
    // scene.background (replacing the flat black color set above).
    this._starTex = this._radialTex(0xffffff);   // still used by the warp streak setup
    // Keep both the painted star backdrop AND a flat black backdrop on hand: we show the
    // stars during normal flight and swap to flat black during warp (so static dots don't
    // show through the moving streak tube and kill the warp illusion).
    this._skyTex = this._makeStarrySkyTexture();
    this._skyBlack = new THREE.Color(0x01030a);
    this.scene.background = this._skyTex;
    // No Points starfield object anymore; null both handles so the loop guards short-circuit.
    this.starfield = null;
    this.starfieldNear = null;

    // ---- Warp streak field ----
    // A dedicated LineSegments layer that turns the whole background into elongated
    // light streaks during the warp-in. Points can't stretch, so these lines carry the
    // "stars smearing past" look from all around the ship. Each streak is a head vertex
    // plus a tail vertex trailing back along the travel axis; the tail length scales with
    // warp intensity, so they bloom into long streaks at full warp and shrink to dots as
    // we drop to sublight. Hidden entirely outside the warp.
    // Many more streaks, packed tighter around the view axis, so the warp reads as a
    // dense torrent of light rushing at the viewer. The whole field is a CHILD of the
    // camera (local space), so head/tail always align to the actual view direction and
    // rush straight toward the screen no matter where the camera looks.
    // Build a streak tube as a LineSegments layer. `rMin`/`rMax` define the radial BAND the
    // streaks occupy around the tube axis, so we can stack a tight inner core tube and a
    // wider outer ring tube to get the concentric "tube within a tube" look. Each seed
    // carries its own band so recycled streaks respawn in the same ring.
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
      // Keep streak layers in the SCENE in WORLD space; they are oriented each frame to the
      // ship's travel axis so the tube converges dead-on the ship.
      this.scene.add(mesh);
      return { mesh, seeds };
    };

    // Inner core tube: dense, tight around the axis.
    const inner = makeStreakTube(3200, 12, 420, 0.7, 0.95);
    this.warpStreaks = inner.mesh;
    this._streakSeeds = inner.seeds;
    // Outer ring tube: sits at a LARGER radius band so it wraps around the inner core,
    // giving the layered concentric tube. Slightly cooler/dimmer so it reads as the halo.
    const outer = makeStreakTube(1800, 430, 900, 0.55, 0.7);
    this.warpStreaksOuter = outer.mesh;
    this._streakSeedsOuter = outer.seeds;

    this.boltGroup = new THREE.Group(); this.scene.add(this.boltGroup);
    this.fxGroup = new THREE.Group(); this.scene.add(this.fxGroup);
  }

  _buildPlayer() {
    // Reuse the real player ship (with engine trails + muzzles). Trails parent to
    // its own group inside this scene.
    this.player = makePlayerShip();
    const trails = new THREE.Group(); this.scene.add(trails);
    this.player.userData.trailGroup = trails;
    // The hero begins far away along +Z, screaming in from hyperspace toward origin.
    this.player.position.set(0, 0, 520);
    this.player.userData.vel = new THREE.Vector3(0, 0, -1);
    this.scene.add(this.player);

    // Shield: reuse the SAME reactive dome the real ship carries (created by makePlayerShip()).
    // It's invisible at rest and blooms a directional absorb-flash + ripple exactly where an enemy
    // bolt connects — so the cutscene shows off the in-game shield system live.
    this.shield = this.player.userData.shieldDome;
    // NOTE: the hyperspace look during warp-in is produced entirely by the ship-anchored
    // concentric warp streak tubes (`warpStreaks` / `warpStreaksOuter`), driven in
    // `_updateWarpStreaks`. The old separate origin-anchored streak field was removed.
  }

  _buildEnemies() {
    // SIX crimson fighters in a loose attack formation ahead of the hero, matching the
    // Overwatch briefing line ("approaching six enemy targets"). Toughness is tuned so the
    // fight keeps a steady kill cadence and still has a bandit ALIVE when the music nears
    // its climax: _enemyHit then holds that final ship one hit from death until the swell
    // crests, so the killing blow lands ON the downbeat. The stragglers are moderate (not
    // instant pops) so the engagement doesn't burn out well before the climax.
    const slots = [
      { pos: new THREE.Vector3(-34, 9, -95),  toughness: 6 },
      { pos: new THREE.Vector3(36, 14, -120), toughness: 6 },
      { pos: new THREE.Vector3(-22, -12, -145), toughness: 6 },
      { pos: new THREE.Vector3(27, -7, -170), toughness: 6 },
      { pos: new THREE.Vector3(-46, -2, -130), toughness: 4 },
      { pos: new THREE.Vector3(48, 6, -158),  toughness: 4 }
    ];
    // World-space group the bandits' engine streaks parent into (so the trails stay anchored
    // behind each moving fighter instead of riding inside its local space).
    this.enemyTrails = new THREE.Group();
    this.scene.add(this.enemyTrails);
    const ENEMY_L = 8.5;
    slots.forEach((slot, i) => {
      const pos = slot.pos;
      const url = ENEMY_FIGHTER_URLS[i % ENEMY_FIGHTER_URLS.length];
      // Bigger bandits (8.5 vs the old 5.4) read far better on screen against the dark
      // starfield, and the formation is pulled a touch closer so they fill more frame.
      // Attach the SAME calibrated red engine exhaust gameplay enemies use, once the model
      // is oriented + scaled, so the cutscene bandits trail glowing thruster streaks too.
      const ship = loadFighterModel(url, ENEMY_L, (mg) => {
        attachEnemyExhaust(ship, mg, url, ENEMY_L, this.enemyTrails);
      });
      ship.position.copy(pos);
      ship.userData = {
        home: pos.clone(),
        phase: Math.random() * Math.PI * 2,
        spin: 0.5 + Math.random() * 0.6,
        fireT: 1.5 + Math.random() * 2.5,
        alive: true,
        toughness: slot.toughness,
        orbit: 16 + Math.random() * 12
      };
      // Stay hidden until the hero drops out of hyperspace. During the warp-in the camera
      // sweeps in toward the formation's depth, so without this the crimson fighters would
      // be partially visible on screen while the player is still in the warp tunnel.
      ship.visible = false;
      this.enemies.push(ship);
      this.scene.add(ship);
    });
  }

  start(playScore = true) {
    // The score may already be playing (studio card started it). Only start it here
    // if the caller asks. Trigger the warp-in SFX as the hero drops to sublight.
    if (playScore) this.audio.playScore(0.6);
    // Loop the score for the duration of the cutscene so it can't run out mid-dogfight
    // and trigger an early ending before the win/warp-out. _finish() fades+stops it.
    this.audio.score.loop = true;
    setTimeout(() => this.audio.play('warp', 0.9), 600);
    this.renderer.setAnimationLoop((time) => this._loop(time));
  }

  skip() { this._finish(); }

  _finish() {
    if (this.done) return;
    this.done = true;
    // Cancel the combat-start safety timer if it's still pending.
    if (this._combatFallback) { clearTimeout(this._combatFallback); this._combatFallback = null; }
    // Clear the cinematic title card in case we finished/skip while it was showing.
    const titleEl = document.getElementById('cineTitle');
    if (titleEl) titleEl.classList.remove('show');
    // Fade the score out so the menu/gameplay track can take over cleanly, and silence
    // the briefing voice in case we skipped mid-line.
    this.audio.fade(this.audio.score, 0, 1800, true);
    this.audio.fade(this.audio.voice, 0, 500, true);
    this.audio.score.loop = false;   // undo the cutscene's loop so later tracks behave

    // Smoothly fade the rendered scene to black before handing off, so we cut to the
    // menu on a clean dissolve rather than a hard pop. Keep rendering during the fade.
    // A longer fade lets the lightspeed streak linger before going dark.
    const canvas = this.renderer.domElement;
    const FADE_MS = 2000;
    canvas.style.transition = `opacity ${FADE_MS}ms ease`;
    canvas.style.opacity = '0';
    setTimeout(() => {
      this.renderer.setAnimationLoop(null);
      window.removeEventListener('resize', this._onResize);
      // Restore the canvas for gameplay (the menu sits on its own black backdrop).
      canvas.style.transition = '';
      canvas.style.opacity = '1';
      this.onComplete && this.onComplete();
    }, FADE_MS + 60);
  }

  _spawnBolt(pos, dir, friendly, dmg) {
    const b = makeBolt(pos, dir, friendly, dmg);
    this.bolts.push(b); this.boltGroup.add(b);
  }

  _loop(time) {
    this._timer.update(time);
    const dt = Math.min(this._timer.getDelta(), 0.05);
    this.t += dt;
    const t = this.t;

    // ---- Phase 1: extended hyperspace warp-in (0s - ~4.2s) ----
    // The hero holds in the hyperspace tunnel longer now so the Overwatch briefing can
    // play over a dramatic sublight approach before the dogfight begins.
    const WARP_END = 4.2;
    if (!this.warpDone) {
      // Hero decelerates out of lightspeed toward the origin (gentler so it reads longer).
      // The hyperspace look comes entirely from the ship-anchored warp streak tube below;
      // the old separate origin-anchored streak field was removed because its convergence
      // point sat off to the side of the ship (the "fireworks" burst).
      const target = new THREE.Vector3(0, 0, 30);
      this.player.position.lerp(target, 1 - Math.pow(0.06, dt));
      if (t > WARP_END) {
        this.warpDone = true;
        // Now that the hero has dropped out of hyperspace, reveal the enemy formation so
        // the bandits appear with the sublight drop rather than peeking through the warp.
        for (const e of this.enemies) e.visible = true;
      }
    }

    // The Overwatch briefing is launched earlier (with the studio card), so here we just
    // hold the dogfight until it has finished. Once we're at sublight and the briefing is
    // over, open combat. A safety timeout guards against a stalled/blocked voice clip.
    if (this.warpDone && !this.combatStarted) {
      const v = this.audio.voice;
      const voiceOver = this.briefingEnded || (v && v.ended) || (v && v.paused && v.currentTime > 0);
      if (voiceOver) {
        this.combatStarted = true;
      } else if (!this._combatFallback) {
        // Backstop: base the cap on the clip's remaining time when known, else ~8s.
        const remainMs = (v && isFinite(v.duration) && v.duration > 0)
          ? Math.max(0, (v.duration - v.currentTime) * 1000) + 2000 : 8000;
        this._combatFallback = setTimeout(() => { this.combatStarted = true; }, remainMs);
      }
    }

    // ---- Warp intensity timeline ----
    // RAMP-IN (0 -> RAMP_END): the cutscene OPENS on the calm painted starfield, then the warp
    // streaks GROW out of it — starting short/slow and stretching longer & faster — so the
    // background stars appear to smear and rush radially outward as the ship accelerates INTO
    // hyperspace, instead of the stars hard-cutting to black and full-speed streaks popping in.
    // FULL: held at 1 while hurtling. EXIT: eased to 0 just after warp ends so the streaks
    // collapse and the painted starfield returns.
    const RAMP_END = 0.9;
    let warpI;
    if (!this.warpDone) {
      // Ease 0 -> 1 over the ramp (smoothstep), then hold at full.
      const r = THREE.MathUtils.clamp(t / RAMP_END, 0, 1);
      warpI = r < 1 ? r * r * (3 - 2 * r) : 1;
    } else {
      warpI = Math.max(0, 1 - (t - WARP_END) / 0.1);
    }
    // During the early ramp we KEEP the painted starfield behind the growing streaks so the
    // stars are visibly the thing stretching outward; once the streaks are dense/long enough to
    // carry the look on their own, swap to flat black so static dots don't show through the tube.
    const rampingIn = !this.warpDone && t < RAMP_END;
    if (warpI > 0.01) {
      this._updateWarpStreaks(dt, warpI);
      this.scene.background = rampingIn ? this._skyTex : this._skyBlack;
      this._starsStreaming = true;
    } else if (this._starsStreaming) {
      // Exit warp: hide the streaks and bring the painted star backdrop back instantly.
      this._hideWarpStreaks();
      this.scene.background = this._skyTex;
      this._starsStreaming = false;
    }

    // ---- Cinematic title card ----
    // Fade "CALL SIGN MAMBA" in just as the dogfight kicks off, hold, then fade out.
    const titleEl = document.getElementById('cineTitle');
    if (titleEl) {
      // Hold the title across the briefing cruise, then clear it as combat opens.
      if (t > 4.6 && !this.combatStarted) titleEl.classList.add('show');
      else titleEl.classList.remove('show');
    }

    // ---- Phase 2+: dogfight ----
    this._updatePlayer(dt);
    this._updateEnemies(dt);
    this._updateBolts(dt);
    this._updateSparks(dt);
    this._updateExplosions(dt);
    this._updateKillCam(dt);
    this._updateCamera(dt, t);

    // Engine trail update on the hero. Drive trail length/brightness from the ship's
    // ACTUAL speed so it's a short stub when easing through a turn and a long bright
    // streak when accelerating/breaking away.
    let speed01, trailScale = 1;
    if (!this.warpDone) {
      // During the hyperspace warp-in the engines run WARM (not blazing) with a LONG exhaust
      // streak. We keep brightness moderate so the warp-in exhaust isn't over-hot, and scale
      // the trail LENGTH by warp depth (warpI: 1 while hurtling -> 0 at exit) so the streak is
      // long in hyperspace and visibly SHORTENS as the ship decelerates out to sublight. As it
      // eases to sublight the glow rises toward normal idle-thrust. Engines never go cold.
      speed01 = 0.5 + (1 - warpI) * 0.25;      // ~0.5 deep in warp, easing up toward exit
      trailScale = 1 + warpI * 3.0;            // ~4x long in warp, eases to 1x at exit
      this._trailPrevPos = this.player.position.clone();
    } else {
      const prevP = this._trailPrevPos || this.player.position.clone();
      const v = this.player.position.distanceTo(prevP) / Math.max(dt, 1e-3); // units/sec
      this._trailPrevPos = this.player.position.clone();
      // Smooth it and map to 0..1 over a sensible speed range (~0..70 u/s).
      const raw = THREE.MathUtils.clamp(v / 70, 0, 1);
      this._speedSmooth = THREE.MathUtils.lerp(this._speedSmooth ?? raw, raw, 1 - Math.pow(0.02, dt));
      speed01 = 0.12 + this._speedSmooth * 0.88; // small idle glow, scales up with thrust
    }
    // Warp-OUT (jump) uses the straight lightspeed streak; warp-IN and normal flight use
    // the soft puff stream, with trailScale stretching it long during the hyperspace approach.
    updateEngineTrails(this.player, dt, speed01, this.camera, !!this._jumping, trailScale);

    this.renderer.render(this.scene, this.camera);

    // Drive the lightspeed jump-out if it's underway.
    if (this._jumping) this._updateJump(dt);

    // ---- End the fight ON the music's climax ----
    // The whole cutscene is built around the score's dramatic swell, and there must be NO
    // dogfighting after it. The instant the score crests, we finish off EVERY bandit still
    // alive in a rapid synchronized volley (a few hundred ms apart for a cinematic chain of
    // explosions), so the last kill always lands right on the downbeat no matter how the
    // dogfight paced out. _enemyHit also holds the final bandit one hit from death until
    // here, so the natural last kill can't fire BEFORE the climax either.
    if (this._victoryAt == null && !this._jumping && !this.done && this._climaxReady()) {
      // Seed high so the FIRST finishing kill fires immediately as the climax hits.
      if (this._finisherT == null) this._finisherT = 1;
      this._finisherT += dt;
      // Pop one remaining bandit roughly every 0.18s for a quick, punchy chain on the beat.
      const living = this.enemies.filter(en => en.userData.alive);
      if (living.length && this._finisherT >= 0.18) {
        this._finisherT = 0;
        // Kill the nearest-to-camera first so the chain reads front-to-back.
        living.sort((a, b) => a.position.distanceTo(this.player.position) - b.position.distanceTo(this.player.position));
        this._killEnemy(living[0]);
      }
    }

    // ---- Warp-out: a short heroic beat after the (climax-timed) final kill, then JUMP ----
    if (this._victoryAt != null && !this._jumping && !this.done) {
      if (this.t - this._victoryAt >= 0.4) this._startJump();
    }
    // Hard time cap so a stalled fight can't strand the player. The score now loops, so it
    // never ends the cutscene early. If we hit the cap having won, JUMP; otherwise end flat.
    if (t > 60 && !this._jumping && !this.done) {
      if (this._victoryAt != null) this._startJump();
      else this._finish();
    }
  }

  // Current playback position within the score's musical phrase, accounting for looping.
  // Returns seconds-into-the-loop, or null if we can't read a meaningful position (e.g.
  // muted/blocked playback where currentTime never advances). The climax is expressed as a
  // position within ONE pass of the track via `this._scorePeak`.
  _scoreClimaxAt() {
    const s = this.audio && this.audio.score;
    if (!s || !isFinite(s.duration) || s.duration <= 0) return null;
    // Clamp the configured peak into the real track length once we know its duration, so a
    // shorter-than-expected track still has a reachable climax (place it ~85% through).
    if (!this._scorePeakResolved) {
      if (this._scorePeak > s.duration - 1) this._scorePeak = s.duration * 0.85;
      this._scorePeakResolved = true;
    }
    if (s.paused || !(s.currentTime > 0)) return null;
    return s.currentTime % s.duration;
  }

  // Begin the lightspeed jump-out finale: a brief charge, then the ship streaks forward.
  _startJump() {
    this._jumping = true;
    this._jumpT = 0;
    this._target = null;             // stop the dogfight AI from steering
    this.combatStarted = false;      // halt enemy fire during the jump
    this.audio.play('warp', 0.9);
  }

  // Per-frame lightspeed jump update. Phases: (0) settle nose to forward + charge,
  // (1) explosive acceleration down the nose with warp streaks, then trigger the fade.
  _updateJump(dt) {
    this._jumpT += dt;
    const tj = this._jumpT;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.quaternion).normalize();

    if (tj < 0.55) {
      // Charge: ease to a small recoil/hold and level the nose before the jump.
      this.player.position.addScaledVector(fwd, 6 * dt);  // gentle creep forward
    } else {
      // GO: accelerate hard down the nose. Speed ramps so it visibly "snaps" to lightspeed.
      const k = THREE.MathUtils.clamp((tj - 0.55) / 0.8, 0, 1);
      const speed = 60 + 1400 * k * k;                    // units/sec, ramping fast
      this.player.position.addScaledVector(fwd, speed * dt);
      // Bloom the background into the warp streak tube for the jump-out, and swap to flat
      // black so the static painted stars don't show through the moving tube.
      const wi = 0.4 + 0.6 * k;
      this._updateWarpStreaks(dt, wi);
      this.scene.background = this._skyBlack;
      // Pin engine speed to full so the trails read as long bright streaks (handled by the
      // main loop's speed sampling, which will see the huge per-frame displacement).
    }

    // Once we've snapped to lightspeed, slow-fade out to the menu.
    if (tj >= 1.35 && !this.done) this._finish();
  }

  // Pick a fresh target (prefer a different one than the last kill) and start an approach.
  _acquireTarget() {
    const living = this.enemies.filter(e => e.userData.alive);
    if (!living.length) { this._target = null; return; }
    // Pick the nearest, but if it's basically on top of us pick the next so runs read
    // as distinct passes.
    living.sort((a, b) => a.position.distanceTo(this.player.position) - b.position.distanceTo(this.player.position));
    this._target = living[0];
    this._runPhase = 'approach';   // approach -> strafe -> egress -> reengage
    this._runT = 0;
    // Pick a random break side for this run's egress so passes vary.
    this._breakSign = Math.random() < 0.5 ? -1 : 1;
  }

  _updatePlayer(dt) {
    if (!this.warpDone) return;
    if (this._jumping) return;   // the lightspeed jump drives the ship directly
    const t = this.t - 4.2;

    // ---- Briefing cruise (warp done, combat not yet started) ----
    // While the Overwatch briefing plays, the hero glides forward on a tense approach
    // with a gentle weave/bank instead of running the dogfight AI. Combat is held until
    // the voice line finishes.
    if (!this.combatStarted) {
      const prev = this.player.position.clone();
      const ct = this.t;
      // Drift slowly forward (toward -Z) with a lazy lateral/vertical weave so the ship
      // feels alive while the briefing plays.
      const desired = this.player.position.clone();
      desired.z -= 7 * dt;
      desired.x = Math.sin(ct * 0.5) * 6;
      desired.y = Math.cos(ct * 0.4) * 3;
      this.player.position.lerp(desired, 1 - Math.pow(0.2, dt));
      const vel = this.player.position.clone().sub(prev);
      const aimAt = this.player.position.clone()
        .addScaledVector(vel.lengthSq() > 1e-6 ? vel.normalize() : new THREE.Vector3(0, 0, -1), 12);
      const m = new THREE.Matrix4().lookAt(this.player.position, aimAt, this.player.up);
      const base = new THREE.Quaternion().setFromRotationMatrix(m);
      const bank = THREE.MathUtils.clamp(-(this.player.position.x - prev.x) / Math.max(dt, 1e-3) * 0.05, -0.5, 0.5);
      base.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, bank, 'YXZ')));
      this.player.quaternion.slerp(base, 1 - Math.pow(0.02, dt));
      this._updatePlayerShield(dt);
      return;
    }

    // ---- Victory cruise (fight won, waiting for the music to crest before the jump) ----
    // The warp-out is synced to the score's climax, which can be a few seconds after the
    // final kill. Rather than letting the hero idle in frame during that wait (dead air),
    // fly a heroic accelerating fly-by: the ship levels its nose to forward, sweeps into a
    // gentle banking climb, and steadily builds speed so the moment flows straight into the
    // lightspeed jump instead of freezing.
    if (this._victoryAt != null) {
      const vt = this.t - this._victoryAt;
      const prev = this.player.position.clone();
      // Heading we want to settle onto: dead forward (-Z), the jump axis.
      const fwd = new THREE.Vector3(0, 0, -1);
      // Speed ramps up over the wait so it visibly "spools toward lightspeed".
      const cruiseSpeed = 18 + Math.min(vt, 4) * 11;           // ~18 -> ~62 u/s
      // A slow grand banking weave + slight climb for cinematic flair.
      const sway = Math.sin(vt * 0.8) * 4;
      const climb = 2.0 + Math.sin(vt * 0.6) * 1.5;
      const desired = this.player.position.clone()
        .addScaledVector(fwd, cruiseSpeed * dt);
      desired.x += sway * dt;
      desired.y += climb * dt;
      this.player.position.lerp(desired, 1 - Math.pow(0.02, dt));

      // Orientation: ease the nose to point along travel (forward), with a lazy bank.
      const vel = this.player.position.clone().sub(prev);
      const aimAt = this.player.position.clone()
        .addScaledVector(vel.lengthSq() > 1e-6 ? vel.clone().normalize() : fwd, 14);
      const m = new THREE.Matrix4().lookAt(this.player.position, aimAt, this.player.up);
      const base = new THREE.Quaternion().setFromRotationMatrix(m);
      const bank = THREE.MathUtils.clamp(-(this.player.position.x - prev.x) / Math.max(dt, 1e-3) * 0.06, -0.45, 0.45);
      base.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, bank, 'YXZ')));
      this.player.quaternion.slerp(base, 1 - Math.pow(0.015, dt));
      this._updatePlayerShield(dt);
      return;
    }

    // ---- Dogfight attack-run state machine ----
    // approach: close from range to the bandit's six.
    // strafe:   slide alongside and hose it (kill takes several hits -> real fight).
    // egress:   after the kill, break AWAY from the enemy group.
    // reengage: arc back around, then acquire a new bandit and start over.
    if (!this._target && this._runPhase !== 'egress' && this._runPhase !== 'reengage') this._acquireTarget();
    if (this._target && !this._target.userData.alive && this._runPhase !== 'egress' && this._runPhase !== 'reengage') {
      // Our target just died mid-strafe: break away.
      this._runPhase = 'egress'; this._runT = 0;
    }
    this._runT += dt;
    const tgt = this._target;

    const prev = this.player.position.clone();
    let desired;
    const groupCenter = this._enemyCenter();

    if (this._runPhase === 'egress') {
      // Break away from the enemy group: fly out and to the side.
      const away = this.player.position.clone().sub(groupCenter);
      if (away.lengthSq() < 1e-3) away.set(0, 0, 1);
      away.normalize();
      const side = new THREE.Vector3().crossVectors(away, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(this._breakSign || 1);
      desired = this.player.position.clone().addScaledVector(away, 36).addScaledVector(side, 22);
      if (this._runT > 1.3) { this._runPhase = 'reengage'; this._runT = 0; }
    } else if (this._runPhase === 'reengage') {
      // Arc back toward the group to set up the next pass.
      const toGroup = groupCenter.clone().sub(this.player.position);
      const side = new THREE.Vector3().crossVectors(toGroup.clone().normalize(), new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(this._breakSign || 1);
      desired = this.player.position.clone().addScaledVector(toGroup.normalize(), 34).addScaledVector(side, 14);
      if (this._runT > 1.1) { this._acquireTarget(); if (!this._target) desired = this.player.position.clone(); }
    } else if (tgt) {
      const toT = tgt.position.clone().sub(this.player.position);
      const dist = toT.length();
      const dirN = toT.clone().normalize();
      const side = new THREE.Vector3().crossVectors(dirN, new THREE.Vector3(0, 1, 0)).normalize();
      const upv = new THREE.Vector3().crossVectors(side, dirN).normalize();
      const weave = side.clone().multiplyScalar(Math.sin(t * 3.1) * 6).addScaledVector(upv, Math.cos(t * 2.3) * 4);

      if (this._runPhase === 'approach') {
        // Close to firing range on the bandit's tail.
        desired = tgt.position.clone().addScaledVector(dirN, -16).add(weave);
        if (dist < 30) { this._runPhase = 'strafe'; this._runT = 0; this._strafeRolled = false; }
      } else { // strafe
        // Stay on its six in gun range and pour on fire until it dies (or we time out).
        desired = tgt.position.clone().addScaledVector(dirN, -15).add(weave.multiplyScalar(1.3));
        if (this._runT > 4.5) { this._runPhase = 'egress'; this._runT = 0; }
      }
    } else {
      desired = this.player.position.clone().add(new THREE.Vector3(Math.sin(t) * 4, Math.cos(t * 0.8) * 3, -10));
    }

    // Move toward the desired point. Snappier during the break/arc for energy.
    const agile = (this._runPhase === 'egress' || this._runPhase === 'reengage') ? 0.02 : 0.045;
    this.player.position.lerp(desired, 1 - Math.pow(agile, dt));

    // Orientation: aim at the target while attacking, else fly along velocity.
    const attacking = tgt && (this._runPhase === 'approach' || this._runPhase === 'strafe');
    const vel = this.player.position.clone().sub(prev);
    const aimAt = attacking
      ? tgt.position.clone()
      : this.player.position.clone().addScaledVector(vel.lengthSq() > 1e-6 ? vel.normalize() : new THREE.Vector3(0, 0, -1), 10);
    const m = new THREE.Matrix4().lookAt(this.player.position, aimAt, this.player.up);
    const base = new THREE.Quaternion().setFromRotationMatrix(m);

    const lateral = (this.player.position.x - prev.x) / Math.max(dt, 1e-3);
    const vertical = (this.player.position.y - prev.y) / Math.max(dt, 1e-3);

    // ---- Bank into the turn (speed-aware) ----
    // Bank should come from how sharply the heading is CHANGING, not just raw
    // lateral drift, and it should bite harder the faster the ship is going so
    // hard high-speed turns lay the ship well over while gentle cruising stays
    // near level. We measure the per-frame change of the horizontal flight
    // direction and scale it by current speed.
    // Use the raw position delta (not `vel`, which may have been normalized above).
    const flatVel = new THREE.Vector3(this.player.position.x - prev.x, 0, this.player.position.z - prev.z);
    const speed = flatVel.length() / Math.max(dt, 1e-3);
    let turnSignal = 0;
    if (speed > 1e-3) {
      const heading = flatVel.clone().normalize();
      if (this._prevHeading) {
        // Signed yaw change about world up (cross.y gives turn direction).
        const cross = this._prevHeading.x * heading.z - this._prevHeading.z * heading.x;
        const dot = THREE.MathUtils.clamp(this._prevHeading.dot(heading), -1, 1);
        turnSignal = Math.sign(cross) * Math.acos(dot) / Math.max(dt, 1e-3);
      }
      this._prevHeading = heading;
    }
    // Blend a touch of raw lateral drift in for low-speed slides, then weight the
    // whole thing by speed so fast turns bank much harder than slow ones.
    const speed01b = THREE.MathUtils.clamp(speed / 60, 0, 1);
    const rawBank = (turnSignal * 0.85 + lateral * 0.012) * (0.45 + speed01b * 1.4);
    const targetBank = THREE.MathUtils.clamp(rawBank, -1.5, 1.5);
    // Smooth so the ship rolls into and out of the bank rather than snapping.
    this._bankSmooth = THREE.MathUtils.lerp(this._bankSmooth || 0, targetBank, 1 - Math.pow(0.0025, dt));
    const bankRoll = this._bankSmooth;
    const pitch = THREE.MathUtils.clamp(-vertical * 0.04, -0.5, 0.5);

    // ---- Aileron-roll flourish ----
    // Trigger a crisp 360° barrel roll about the ship's nose for flair: a couple times
    // while breaking away (evading) and once near the start of an attack pass (firing).
    this._maybeTriggerRoll(attacking);
    let aileron = 0;
    if (this._rollT < this._rollDur) {
      this._rollT += dt;
      const k = THREE.MathUtils.clamp(this._rollT / this._rollDur, 0, 1);
      // Ease-in-out so the roll snaps in and settles cleanly.
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      aileron = this._rollDir * Math.PI * 2 * eased;
    }

    const flair = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, bankRoll + aileron, 'YXZ'));
    base.multiply(flair);
    // During an active aileron roll keep the follow gentle so the spin glides
    // through smoothly instead of whipping/snapping into place.
    const orient = (this._rollT < this._rollDur) ? 0.01 : 0.02;
    this.player.quaternion.slerp(base, 1 - Math.pow(orient, dt));

    // Hero fire: only while attacking and roughly lined up on the target.
    this._heroFireT = (this._heroFireT || 0.8) - dt;
    if (this._heroFireT <= 0 && attacking) {
      this._heroFireT = 0.16 + Math.random() * 0.14;
      const dir = tgt.position.clone().sub(this.player.position).normalize();
      this.player.updateMatrixWorld();
      const muzzles = this.player.userData.muzzles;
      if (muzzles && muzzles.length) {
        for (const mz of muzzles) this._spawnBolt(mz.clone().applyMatrix4(this.player.matrixWorld), dir, true, 22);
      } else {
        this._spawnBolt(this.player.position.clone(), dir, true, 22);
      }
      this.audio.play('laser', 0.5);
    }

    // Tick the player shield flash.
    this._updatePlayerShield(dt);
  }

  // Kick off an aileron roll if conditions are right (rate-limited, only a few total).
  _maybeTriggerRoll(attacking) {
    if (this._rollT < this._rollDur) return;            // already rolling
    if (this._rollsLeft <= 0) return;                   // used up our flourishes
    if ((this.t - (this._lastRollAt || -99)) < this._rollCooldown) return;

    let trigger = false;
    if (this._runPhase === 'egress' && this._runT > 0.15 && this._runT < 0.6) {
      // Evading: snap a victory/evasive roll right as we break away from the kill.
      trigger = Math.random() < 0.9;
    } else if (this._runPhase === 'strafe' && attacking && !this._strafeRolled && this._runT > 0.4) {
      // Firing pass: one showy roll while hosing the bandit.
      trigger = Math.random() < 0.5;
      if (trigger) this._strafeRolled = true;
    }
    if (trigger) this._startRoll(Math.random() < 0.5 ? -1 : 1);
  }
  _startRoll(dir) {
    this._rollDir = dir;
    this._rollT = 0;
    this._lastRollAt = this.t;
    this._rollsLeft--;
  }

  // Centroid of the living enemy formation (for break-away / re-engage geometry).
  _enemyCenter() {
    const c = new THREE.Vector3();
    let n = 0;
    for (const e of this.enemies) { if (e.userData.alive) { c.add(e.position); n++; } }
    if (n) c.multiplyScalar(1 / n);
    return c;
  }

  // Bloom the player's reactive shield dome + a burst of sparks where an enemy bolt connects.
  // `pos` is the world-space strike point, so the ripple centers exactly on the impact — the same
  // shield behavior the player sees in-game, showcased live during the cutscene.
  _hitPlayerShield(pos) {
    flashPlayerShield(this.player, 1, pos);
    this._spark(pos, 0x7fe0ff);
    this.audio.play('shield', 0.45);
  }
  _updatePlayerShield(dt) {
    // Just roll the dome's animation clock; it draws nothing until a hit ripples across it.
    updatePlayerShield(this.player, dt);
  }

  _nearestEnemy(from) {
    let best = null, bd = Infinity;
    for (const e of this.enemies) {
      if (!e.userData.alive) continue;
      const d = e.position.distanceTo(from);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  _updateEnemies(dt) {
    const t = this.t;
    for (const e of this.enemies) {
      if (!e.userData.alive) continue;
      const u = e.userData;
      const prev = e.position.clone();
      // Orbit/weave around their home slot while drifting toward the hero.
      const home = u.home;
      const ox = Math.cos(t * u.spin + u.phase) * u.orbit;
      const oy = Math.sin(t * u.spin * 0.8 + u.phase) * (u.orbit * 0.5);

      // Evasive jink: trigger a sudden lateral break to "dodge incoming fire". REACTIVE — if any
      // of the hero's bolts is streaking close to this bandit, it immediately throws a hard,
      // randomized break (a bigger kick than the idle weave) so the bandits visibly dodge the
      // player's shots and the fight reads as a real two-way scrap, not a turkey shoot.
      let threatened = false;
      for (const b of this.bolts) {
        if (!b.userData.friendly) continue;
        if (b.position.distanceTo(e.position) < 22) { threatened = true; break; }
      }
      u.jinkT = (u.jinkT || 0) - dt;
      if (threatened && (u.reactT || 0) <= 0) {
        // Snap a hard evasive break the instant a bolt closes in, then briefly lock it out so
        // the bandit commits to the break instead of stuttering every frame.
        u.reactT = 0.5 + Math.random() * 0.4;
        u.jinkT = 0.5 + Math.random() * 0.7;
        u.jink = new THREE.Vector3(THREE.MathUtils.randFloatSpread(2), THREE.MathUtils.randFloatSpread(2), THREE.MathUtils.randFloatSpread(1.4)).normalize().multiplyScalar(20 + Math.random() * 16);
      } else if (u.jinkT <= 0) {
        u.jinkT = 0.7 + Math.random() * 1.4;
        u.jink = new THREE.Vector3(THREE.MathUtils.randFloatSpread(2), THREE.MathUtils.randFloatSpread(2), THREE.MathUtils.randFloatSpread(1)).normalize().multiplyScalar(11 + Math.random() * 11);
      }
      u.reactT = Math.max(0, (u.reactT || 0) - dt);
      // Decay the current jink offset so it eases back after the break.
      if (u.jink) u.jink.multiplyScalar(Math.pow(0.25, dt));

      const desired = new THREE.Vector3(home.x + ox, home.y + oy, home.z + Math.sin(t * 0.4 + u.phase) * 14);
      if (u.jink) desired.add(u.jink);
      // Hold formation/orbit (only a slight drift toward the hero) so the PLAYER does the
      // sweeping-in. Too strong a pull made enemies pile onto the camera.
      desired.lerp(this.player.position, 0.03);
      e.position.lerp(desired, 1 - Math.pow(0.05, dt));

      // Face the hero (nose = local -Z toward the player), then bank into the turn.
      const m = new THREE.Matrix4().lookAt(e.position, this.player.position, e.up);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      const lateral = (e.position.x - prev.x) / Math.max(dt, 1e-3);
      const roll = THREE.MathUtils.clamp(-lateral * 0.05, -1.0, 1.0);
      q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, roll, 'YXZ')));
      e.quaternion.slerp(q, 1 - Math.pow(0.02, dt));

      // ---- Red engine exhaust ----
      // Drive the bandit's thruster glow/streaks from its actual per-frame speed and pass its
      // velocity so the world-space streaks stay anchored behind it as it weaves. Kept SHORT
      // (lenScale 0.25) like gameplay enemies so it's a compact glow, not a long banner.
      if (e.userData.engines && e.visible) {
        const evel = e.position.clone().sub(prev).multiplyScalar(1 / Math.max(dt, 1e-3));
        const espeed01 = THREE.MathUtils.clamp(evel.length() / 36, 0.25, 1);
        updateEngineTrails(e, dt, espeed01, this.camera, false, 1, evel, false, 0.25);
      }

      // Enemy fire (uses the deep enemy cannon). Faster cadence so the hero is taking
      // real return fire. Aim with a touch of inaccuracy so some shots miss and some
      // connect with the shield.
      u.fireT -= dt;
      if (u.fireT <= 0 && this.combatStarted) {
        // Heavier, more frequent return fire so the bandits clearly shoot back. Often a short
        // 2-3 round burst rather than a single bolt, with a touch of aim scatter so some shots
        // streak past the hero and some splash on the shield.
        u.fireT = 0.45 + Math.random() * 0.7;
        const burst = 1 + (Math.random() < 0.55 ? 1 + (Math.random() < 0.4 ? 1 : 0) : 0);
        for (let s = 0; s < burst; s++) {
          const dir = this.player.position.clone().sub(e.position)
            .add(new THREE.Vector3(THREE.MathUtils.randFloatSpread(6), THREE.MathUtils.randFloatSpread(6), THREE.MathUtils.randFloatSpread(6)))
            .normalize();
          const start = e.position.clone().addScaledVector(dir, 3);
          // Stagger burst rounds slightly along the firing line so they read as rapid fire.
          start.addScaledVector(dir, s * 1.6);
          this._spawnBolt(start, dir, false, 8);
        }
        this.audio.play('enemyLaser', 0.3);
      }
    }
  }

  _updateBolts(dt) {
    for (const b of [...this.bolts]) {
      b.position.addScaledVector(b.userData.vel, dt);
      b.userData.life -= dt;
      let hit = false;
      if (b.userData.friendly) {
        for (const e of this.enemies) {
          if (!e.userData.alive) continue;
          if (b.position.distanceTo(e.position) < 3.4) {
            this._enemyHit(e, b.position);
            hit = true; break;
          }
        }
      } else {
        // Enemy bolt vs the player shield bubble. Most miss; the ones that connect
        // trigger a shield flash + spark on impact.
        if (b.position.distanceTo(this.player.position) < 5.0) {
          this._hitPlayerShield(b.position.clone());
          hit = true;
        }
      }
      if (b.userData.life <= 0 || hit) {
        this.boltGroup.remove(b);
        this.bolts.splice(this.bolts.indexOf(b), 1);
      }
    }
  }

  _enemyHit(e, pos) {
    this._spark(pos, 0x9ffcff);
    e.userData.hits = (e.userData.hits || 0) + 1;
    // Scripted toughness: a bandit soaks a sustained burst before it blows, so each
    // strafing pass is an actual fight rather than an instant kill. The two trailing
    // bandits have a low toughness (2 hits) so they fall in quick back-to-back kills,
    // keeping the now-6-ship fight inside the cutscene window.
    if (e.userData.hits >= (e.userData.toughness || 6)) {
      // The FINAL kill must land on the music's climax (that's the dramatic beat the whole
      // cutscene is built around). If this is the last living bandit and the score hasn't
      // crested yet, DON'T kill it: pin its hits one below lethal and flag it as the
      // climax-locked straggler. The main loop force-destroys it the instant the score
      // reaches the climax window, so the final kill is synced to the swell every run.
      const livingNow = this.enemies.filter(en => en.userData.alive);
      const isLastBandit = livingNow.length === 1 && livingNow[0] === e;
      if (isLastBandit && !this._climaxReady()) {
        e.userData.hits = (e.userData.toughness || 6) - 1;  // hold at one hit from death
        e.userData.climaxLocked = true;
        return;
      }
      this._killEnemy(e);
    }
  }

  // Destroy a bandit now: explosion, kill-cam, SFX, and victory bookkeeping.
  _killEnemy(e) {
    if (!e.userData.alive) return;
    e.userData.alive = false;
    e.userData.climaxLocked = false;
    // Use the SAME rich gameplay explosion (white flash core, shockwave ring, rolling
    // fireball, streaking shrapnel, cooling embers, and lingering smoke) the missions use,
    // oriented along the bandit's nose so the burst reads as the fighter erupting. Scaled to
    // the cutscene's bigger 8.5-unit bandits so the blast fills frame for the kill-cam.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(e.quaternion).normalize();
    explode(this.fxGroup, e.position.clone(), 0xff7a3c, 1.7, { dir });
    // Smooth cinematic kill-cam: ease the camera in toward this explosion (once).
    this._triggerKillCam(e.position);
    // Free the bandit's red exhaust streaks (which live in the world-space enemyTrails group)
    // so they vanish with the ship instead of lingering frozen after the kill.
    disposeEngineEffects(e);
    this.scene.remove(e);
    this.audio.play('shield', 0.4);
    // If that was the LAST bandit, mark the victory beat (the warp-out cruise follows).
    const remaining = this.enemies.filter(en => en.userData.alive).length;
    if (remaining === 0 && this._victoryAt == null) this._victoryAt = this.t;
  }

  // True once the score has reached (or passed) its dramatic climax this loop — the moment
  // the final kill should land on. Returns false while we can't read playback (muted/blocked).
  _climaxReady() {
    const climax = this._scoreClimaxAt();   // seconds-into-loop, or null
    if (climax == null) return false;
    // Fire just before the marked peak (short lead) so the explosion blooms ON the downbeat.
    return climax >= this._scorePeak - 0.35;
  }

  _spark(pos, color) {
    for (let i = 0; i < 10; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.06 + Math.random() * 0.08, 6, 6), new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending }));
      p.position.copy(pos);
      p.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(8 + Math.random() * 18), life: 0.4 + Math.random() * 0.4 };
      this.sparks.push(p); this.fxGroup.add(p);
    }
  }

  // Advance the rich gameplay-style explosion particles spawned by `explode()` into
  // `this.fxGroup`. This mirrors main.js's updateExplosions so the cutscene's enemy deaths
  // animate identically to in-mission kills: trigger markers fire delayed secondary blasts,
  // flashes/rings expand and fade, fireballs bloom and cool, debris streaks, embers cool to
  // dark red, smoke swells and fades, and hull chunks tumble and trail smoke.
  _updateExplosions(dt) {
    const group = this.fxGroup;
    for (const p of [...group.children]) {
      const u = p.userData;
      // Only touch explosion particles (they carry a numeric `life` + a `kind`/`maxLife`).
      // The legacy spark/ember meshes in `this.sparks` are advanced by _updateSparks instead.
      if (!u || u.maxLife == null) continue;
      u.life -= dt;
      if (u.life <= 0) {
        if (u.kind === 'trigger' && u.fire) explode(group, u.fire.pos, u.fire.color, u.fire.scale, { noRing: u.fire.noRing });
        group.remove(p);
        continue;
      }
      if (u.kind === 'trigger') continue;
      const t = 1 - u.life / (u.maxLife || u.life + dt);
      if (u.kind === 'chunk') {
        p.position.addScaledVector(u.vel, dt);
        if (u.drag) u.vel.multiplyScalar(Math.pow(1 / (1 + u.drag), dt));
        p.rotation.x += u.spinV.x * dt; p.rotation.y += u.spinV.y * dt; p.rotation.z += u.spinV.z * dt;
        p.material.emissiveIntensity = Math.max(0, 1.4 * (1 - t * 1.3));
        u.smokeAt -= dt;
        if (u.smokeAt <= 0 && t < 0.7) { u.smokeAt = 0.14; spawnSmokePuff(group, p.position, 1.0 + Math.random()); }
        if (t > 0.8) p.scale.multiplyScalar(Math.pow(0.02, dt));
        continue;
      }
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
          p.scale.set(0.7, 0.7, 1);
          p.scale.z = len;
          if (v.lengthSq() > 1e-4) p.lookAt(p.position.x + v.x, p.position.y + v.y, p.position.z + v.z);
        }
        if (u.kind === 'ember') p.material.color.setRGB(0.76 * (1 - t * 0.4), 0.29 * (1 - t * 0.7), 0.12 * (1 - t));
      }
    }
  }

  _updateSparks(dt) {
    for (const p of [...this.sparks]) {
      p.position.addScaledVector(p.userData.vel, dt);
      p.userData.life -= dt;
      p.material.opacity = Math.max(0, p.userData.life * 1.4);
      if (p.userData.life <= 0) {
        this.fxGroup.remove(p);
        this.sparks.splice(this.sparks.indexOf(p), 1);
      }
    }
  }

  // ---- Smooth cinematic kill-cam ------------------------------------------------------
  // When a bandit is destroyed, we record its death spot and ease the camera toward a
  // closer framing of the explosion, hold briefly, then ease back to the chase rig. The
  // whole thing is a BLEND weight (0 -> 1 -> 0), so the camera glides in and out — it
  // never hard-cuts or jams onto the kill. Fires once, on the first kill, so it reads as a
  // deliberate hero beat rather than yanking the camera on every pass.
  _triggerKillCam(pos) {
    if (this._killCamUsed) return;
    this._killCamUsed = true;
    this._killCamT = 0;
    this._killCamActive = true;
    this._killCamPos = pos.clone();        // frozen world position of the explosion
    // Choose an approach side so the close angle isn't dead-on the chase axis.
    this._killCamSide = Math.random() < 0.5 ? -1 : 1;
    // Lingering embers + a slow secondary flare so there's still fire to frame as the
    // camera glides in (the primary fireball is brief). Slower-moving, longer-lived.
    for (let i = 0; i < 22; i++) {
      const c = Math.random() < 0.5 ? 0xffcaa0 : 0xff7a45;
      const p = new THREE.Mesh(
        new THREE.SphereGeometry(0.1 + Math.random() * 0.2, 7, 7),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, blending: THREE.AdditiveBlending })
      );
      p.position.copy(pos);
      p.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(4 + Math.random() * 12), life: 1.4 + Math.random() * 0.8 };
      this.sparks.push(p); this.fxGroup.add(p);
    }
    const flare = new THREE.PointLight(0xffb070, 6, 70, 2);
    flare.position.copy(pos); this.scene.add(flare);
    this._killCamFlare = flare;
  }

  _updateKillCam(dt) {
    if (!this._killCamActive) return;
    this._killCamT += dt;
    // Total beat ~2.4s: ease-in (~0.45s, fast enough to catch the bloom) -> hold (~0.85s)
    // -> ease-out (~1.1s).
    const T = this._killCamT;
    // Fade the lingering flare down across the beat.
    if (this._killCamFlare) this._killCamFlare.intensity = Math.max(0, 6 * (1 - T / 2.0));
    if (T >= 2.4) {
      this._killCamActive = false;
      this._killCamWeight = 0;
      if (this._killCamFlare) { this.scene.remove(this._killCamFlare); this._killCamFlare = null; }
      return;
    }
    let w;
    if (T < 0.45) w = T / 0.45;                     // glide in fast
    else if (T < 1.3) w = 1;                        // hold close
    else w = Math.max(0, 1 - (T - 1.3) / 1.1);      // glide back out
    // Smoothstep the weight so the in/out has no harsh velocity change.
    this._killCamWeight = w * w * (3 - 2 * w);
  }

  _updateCamera(dt, t) {
    // Rigid third-person chase rig LOCKED behind the hero ship. The camera position is
    // computed from the ship's own orientation each frame and followed tightly so the
    // ship can never out-maneuver the camera and leave the frame.
    //
    // NOTE: Object3D.getWorldDirection returns the object's local +Z in world space.
    // Our ship's nose points local -Z, so the true nose ("forward") direction is the
    // ship's local -Z axis. Deriving it from the quaternion directly avoids the bug
    // where the camera ends up parked in FRONT of the nose, looking back at the
    // cockpit/engines (which made the engine glow + trails read off the front).
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.player.quaternion).normalize();
    const back = fwd.clone().multiplyScalar(-1);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.player.quaternion).normalize();

    // Sit further back and a touch above the ship.
    const dist = 30;     // pulled back a touch more
    const height = 6.5;

    // Offset the rig along the ship's OWN up axis (not world up) so when the ship banks
    // or barrel-rolls the camera orbits with it and the roll reads on screen.
    const desired = this.player.position.clone()
      .addScaledVector(back, dist)
      .addScaledVector(up, height);

    // Snap the camera onto the rig the very first frame so we never start on an empty
    // frame; afterward follow tightly so the ship can't out-maneuver the rig.
    if (!this._camInit) { this.camera.position.copy(desired); this._camInit = true; }
    // During the lightspeed jump, nearly freeze the camera so the ship visibly rockets
    // away from it down the nose and streaks off into the warp.
    const follow = this._jumping ? 0.5 : (this.warpDone ? 0.0008 : 0.01);
    this.camera.position.lerp(desired, 1 - Math.pow(follow, dt));

    // Roll the camera with the ship: feed lookAt the ship's up vector instead of world
    // up. Smooth it so banks/rolls ease in rather than snapping the horizon over.
    if (!this._camUp) this._camUp = up.clone();
    this._camUp.lerp(up, 1 - Math.pow(0.0006, dt)).normalize();
    this.camera.up.copy(this._camUp);

    // Always look at the SHIP (with a small forward lead) so it's centered in frame.
    let focus = this.player.position.clone().addScaledVector(fwd, 6);

    // ---- Kill-cam blend ----------------------------------------------------------------
    // Smoothly bias the camera toward a closer framing of a destroyed bandit, weighted by
    // _killCamWeight (0..1, eased in and out). Because we LERP both the camera position and
    // the look-at focus by this weight, the move is a gentle glide in toward the explosion
    // and back out — never a cut. At weight 0 it's exactly the normal chase rig.
    const w = this._killCamWeight || 0;
    if (w > 0.0001 && this._killCamPos) {
      const kp = this._killCamPos;
      // A close angle: between the hero and the kill, swung out to the chosen side and a
      // little above, looking AT the explosion so it fills frame as the camera eases in.
      const toKill = kp.clone().sub(this.player.position);
      const dir = toKill.lengthSq() > 1e-4 ? toKill.clone().normalize() : fwd.clone();
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(this._killCamSide || 1);
      const killCamPos = kp.clone()
        .addScaledVector(dir, -13)            // sit back off the explosion so it's framed, not buried
        .addScaledVector(side, 9)
        .add(new THREE.Vector3(0, 4.5, 0));
      // Blend the already-smoothed chase position toward the kill-cam vantage by weight.
      this.camera.position.lerp(killCamPos, w);
      // Blend the focus from the ship toward the explosion so the look pans over smoothly.
      focus = focus.lerp(kp, w);
      // Ease the camera roll back to world-level during the kill-cam so the framing reads.
      this._camUp.lerp(new THREE.Vector3(0, 1, 0), w * (1 - Math.pow(0.2, dt)));
      this.camera.up.copy(this._camUp);
    }

    this.camera.lookAt(focus);
  }
}
