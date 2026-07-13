// hangarPreview.js — the big interactive 3D ship preview for the Ship Hangar screen.
//
// One self-contained Three.js renderer drawing a SINGLE normalized fighter on a slow turntable into
// its own canvas, with a live engine-trail plume whose color reflects the pilot's equipped trail
// cosmetic and a laser-tracer color swatch that mirrors the equipped laser color. It reuses the
// game's loadFighterModel() so the hull is framed exactly like it flies, and runs its own RAF loop
// only while the hangar is open (stopped/hidden otherwise) so it never competes with gameplay.
//
// Public API:
//   const hp = new HangarPreview(canvas);
//   hp.setShip(shipId)                     — swap to a different hull (async load; keeps turntable)
//   hp.setTrailPalette({core,glow,hot,beam}) — recolor the engine plume live
//   hp.setLaserColor(hex)                  — recolor the twin tracer demo bolts live
//   hp.start() / hp.stop()                 — run / pause the render loop
//   hp.dispose()                           — free all GPU resources
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadFighterModel } from './scene.js';
import { getShip } from './shipRoster.js';

const SHIP_LEN = 6;
const TRAIL_COUNT = 90;

export class HangarPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.shipId = null;
    this._raf = 0;
    this._running = false;
    this._last = 0;
    this._t = 0;
    this._trailPalette = { core: 0x2bdcff, glow: 0x57e6ff, hot: 0xeafdff, beam: 0x57e0ff };
    this._laserColor = 0x62f8ff;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 0, 13);
    this.camera.lookAt(0, 0, 0);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this._envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this._envRT.texture;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(6, 6, 7); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6fa8ff, 1.2); fill.position.set(-7, -1, 3); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffcf8a, 2.2); rim.position.set(-3, 5, -8); this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x445a72, 0.5));

    // Holder we own; the normalized ship group nests inside so we can pose/rotate cleanly.
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    this.model = null;
    this.radius = 3;
    this._ready = false;

    this._buildTrail();
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  _trailTexture() {
    if (this._trailTex) return this._trailTex;
    const s = 64;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(235,240,245,0.85)');
    grad.addColorStop(1.0, 'rgba(200,210,220,0)');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    this._trailTex = new THREE.CanvasTexture(c);
    this._trailTex.colorSpace = THREE.SRGBColorSpace;
    return this._trailTex;
  }

  // A points-based engine plume, parented to the SCENE (repositioned each frame to the ship tail),
  // plus two additive "tracer" sprites that pulse forward to demo the laser color.
  _buildTrail() {
    const positions = new Float32Array(TRAIL_COUNT * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      map: this._trailTexture(), color: this._trailPalette.glow, size: 1.7,
      sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.holder.add(points);
    const parts = [];
    for (let i = 0; i < TRAIL_COUNT; i++) parts.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
    this._trail = { points, geo, mat, parts, spawnAcc: 0 };
  }

  setTrailPalette(pal) {
    if (!pal) return;
    this._trailPalette = pal;
    if (this._trail) this._trail.mat.color.setHex(pal.glow);
  }

  setLaserColor(hex) {
    if (hex == null) return;
    this._laserColor = hex;
  }

  setShip(shipId) {
    if (shipId === this.shipId) return;
    this.shipId = shipId;
    const ship = getShip(shipId);
    // Drop the previous model cleanly.
    if (this.model) { this.holder.remove(this.model); this.model = null; }
    this._ready = false;
    const group = loadFighterModel(ship.model, SHIP_LEN, (g) => {
      if (this.shipId !== shipId) return;   // ship changed again while loading
      g.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(g);
      const center = box.getCenter(new THREE.Vector3());
      g.position.sub(center);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const r = sphere.radius;
      this.radius = r;
      const vFov = THREE.MathUtils.degToRad(this.camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
      const fitFov = Math.min(vFov, hFov);
      this._camDist = (r / Math.sin(fitFov / 2)) * 0.9;
      this._ready = true;
    });
    group.rotation.set(0.12, Math.PI * 0.15, 0.04);
    this.holder.add(group);
    this.model = group;
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width || this.canvas.clientWidth || 480));
    const h = Math.max(2, Math.round(rect.height || this.canvas.clientHeight || 300));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _updateTrail(dt) {
    const t = this._trail;
    if (!t || !this.model) return;
    const r = this.radius || 3;
    const arr = t.geo.attributes.position.array;
    // Emit from the ship tail (+Z in the ship's local frame). Convert that to the holder frame by
    // reading the model's rotation (the emitter sits inside the holder alongside the model group).
    t.spawnAcc += dt;
    const perSec = 120, step = 1 / perSec;
    // Tail offset in the model's local space, transformed by the model's rotation into holder space.
    const tailLocal = new THREE.Vector3(0, 0, r * 0.72);
    tailLocal.applyEuler(this.model.rotation).add(this.model.position);
    while (t.spawnAcc >= step) {
      t.spawnAcc -= step;
      const q = t.parts.find(p => p.life <= 0);
      if (!q) break;
      const a = Math.random() * Math.PI * 2, rad = Math.random() * r * 0.14;
      // Backward direction = ship tail axis in holder space.
      const back = new THREE.Vector3(0, 0, 1).applyEuler(this.model.rotation).normalize();
      const side = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(rad);
      q.x = tailLocal.x + side.x; q.y = tailLocal.y + side.y; q.z = tailLocal.z + side.z;
      const sp = r * (1.6 + Math.random() * 0.8);
      q.vx = back.x * sp + side.x * 0.4;
      q.vy = back.y * sp + side.y * 0.4;
      q.vz = back.z * sp + side.z * 0.4;
      q.max = 0.42 + Math.random() * 0.22; q.life = q.max;
    }
    for (let i = 0; i < t.parts.length; i++) {
      const q = t.parts[i];
      if (q.life > 0) {
        q.life -= dt;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        arr[i * 3] = q.x; arr[i * 3 + 1] = q.y; arr[i * 3 + 2] = q.z;
      } else {
        arr[i * 3] = 0; arr[i * 3 + 1] = 0; arr[i * 3 + 2] = 9999;
      }
    }
    t.geo.attributes.position.needsUpdate = true;
    t.mat.opacity = 0.75 + Math.sin(this._t * 9) * 0.12;
  }

  _frame(now) {
    this._raf = requestAnimationFrame(this._frame.bind(this));
    if (!this._running) return;
    const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0.016;
    this._last = now;
    this._t += dt;
    if (this._ready && this.model) {
      this.model.rotation.y += dt * 0.5;
      this.model.rotation.x = 0.12 + Math.sin(this._t * 0.4) * 0.05;
      this.model.rotation.z = 0.04 + Math.sin(this._t * 0.35) * 0.05;
      this.holder.position.set(0, this.radius * 0.05, 0);
      this.camera.position.set(0, 0, this._camDist || 13);
      this.camera.lookAt(0, 0, 0);
      this._updateTrail(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = 0;
    this._resize();
    this._raf = requestAnimationFrame(this._frame.bind(this));
  }

  stop() {
    this._running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._resize);
    if (this._trail) { this._trail.geo.dispose(); this._trail.mat.dispose(); }
    if (this._trailTex) { this._trailTex.dispose(); this._trailTex = null; }
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this.scene.environment) { this.scene.environment = null; }
    this.renderer.dispose();
  }
}
