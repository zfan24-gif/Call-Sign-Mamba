// shipPreview.js — 3D hero previews for the multiplayer ship-select cards.
//
// APPROACH (rewritten): the old version cloned the RAW GLB and spun it around Y. Because each GLB
// has its own arbitrary native orientation, the ships showed up nose-on, tilted, or flat — ugly and
// inconsistent. This version reuses the game's own loadFighterModel(), which normalizes every hull
// to a shared frame (nose points -Z, up +Y, per-model orientation fixes applied), then poses that
// normalized ship at a flattering three-quarter HERO angle and lets it gently rock (not full-spin)
// so the silhouette always reads as a proper fighter, framed the same way on every card.
//
// To respect the browser's WebGL context limit (a renderer per card would exhaust it) it uses ONE
// shared offscreen WebGLRenderer: each frame it renders every mounted ship in turn into that single
// offscreen canvas, then blits the result into that card's own 2D <canvas> via drawImage().
//
// Public API:
//   mountShipPreviews(entries)  entries: [{ id, url, canvas }]  — (re)build the preview set
//   startShipPreviews()         begin the shared render loop
//   stopShipPreviews()          pause the loop (call when the screen is hidden)
//   disposeShipPreviews()       tear everything down (frees GPU resources)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadFighterModel } from './scene.js';
import { paletteForShip } from './shipRoster.js';

// Engine-trail tint per faction palette. The captured enemy (RED) hulls get a hot crimson plume so
// the ship-select preview matches the hostile theme; hero hulls keep the blue plume.
const TRAIL_TINT = { blue: 0x8fdcff, red: 0xff5038 };

const OFF_W = 460, OFF_H = 290;   // offscreen render resolution (matches the card's preview aspect)
const SHIP_LEN = 6;               // normalized nose-tail length loadFighterModel scales each hull to

let renderer = null;      // shared offscreen WebGLRenderer
let offCanvas = null;
let scene = null, camera = null;
let raf = 0;
let running = false;
let last = 0;
let selectedId = null;    // which preview shows a live engine trail (set via setSelectedPreview)
let trailTex = null;      // shared soft-glow sprite texture for the trail particles

// One preview per ship: { id, canvas, ctx, holder(hero-posed), rock(phase), model, ready }
const previews = new Map();

const TRAIL_COUNT = 60;   // particles per engine trail

// A soft radial-glow texture used for every trail particle (built once, shared). Additive-blended
// so overlapping particles build into a hot plume core that falls off to a colored haze.
function makeTrailTexture() {
  if (trailTex) return trailTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  // Neutral WHITE glow: the per-ship PointsMaterial.color multiplies this, so one shared texture
  // serves both the blue (hero) and red (enemy) plumes without needing a second canvas.
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(235,240,245,0.85)');
  grad.addColorStop(1.0, 'rgba(200,210,220,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  trailTex = new THREE.CanvasTexture(c);
  trailTex.colorSpace = THREE.SRGBColorSpace;
  return trailTex;
}

// Build an engine-trail particle system for a preview, parented to its ship MODEL so it rotates with
// the hull and streams out the back (+Z is the tail, since loadFighterModel points the nose at -Z).
// Particles are seeded "dead" and only come alive while this ship is the selected one.
function makeTrail(p) {
  const positions = new Float32Array(TRAIL_COUNT * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    map: makeTrailTexture(),
    color: TRAIL_TINT[paletteForShip(p.id)] || TRAIL_TINT.blue,
    size: (p.radius || 3) * 0.55,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  // Seat the emitter just behind the hull's tail so the plume erupts from the engines.
  points.position.set(0, 0, (p.radius || 3) * 0.72);
  // Per-particle sim state: local offset from the emitter + remaining life.
  const parts = [];
  for (let i = 0; i < TRAIL_COUNT; i++) parts.push({ x: 0, y: 0, z: 0, life: 0, max: 1 });
  p.model.add(points);
  p.trail = { points, geo, mat, parts, spawnAcc: 0 };
}

function ensureRenderer() {
  if (renderer) return;
  offCanvas = document.createElement('canvas');
  offCanvas.width = OFF_W; offCanvas.height = OFF_H;
  renderer = new THREE.WebGLRenderer({ canvas: offCanvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(OFF_W, OFF_H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic tone mapping gives the metallic hulls real highlight rolloff instead of flat, washed
  // shading — the single biggest reason the previews used to read as "flat" without it.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  // Camera looks dead-center at the origin (where each centered hull sits) so the ship lands in the
  // MIDDLE of the card, not low/off to a side. Per-ship distance is set each frame from the model's
  // bounding sphere (see renderFrame) so the whole hull frames large but whole at any yaw.
  camera = new THREE.PerspectiveCamera(30, OFF_W / OFF_H, 0.1, 100);
  camera.position.set(0, 0, 12.6);
  camera.lookAt(0, 0, 0);

  // Environment map: GLB hulls use PBR (metalness/roughness) materials, which look dull and flat
  // without something to reflect. A prebaked RoomEnvironment IBL gives every panel real reflections
  // and specular form — this is what makes the ships look like painted metal instead of cardboard.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  pmrem.dispose();

  // Punchy three-point rig ON TOP of the IBL: a hot white key for crisp highlights, a cool blue fill
  // to keep the shadow side from going black, and a warm rim from behind to pop the silhouette edge.
  const key = new THREE.DirectionalLight(0xffffff, 3.4); key.position.set(6, 6, 7); scene.add(key);
  const fill = new THREE.DirectionalLight(0x6fa8ff, 1.2); fill.position.set(-7, -1, 3); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffcf8a, 2.4); rim.position.set(-3, 5, -8); scene.add(rim);
  scene.add(new THREE.AmbientLight(0x445a72, 0.5));
}

// (Re)build the preview set. `entries` is [{ id, url, canvas }]. Existing previews for ids not in
// the new list are removed; new ones are created and their model loaded (normalized) asynchronously.
export function mountShipPreviews(entries) {
  ensureRenderer();
  const wanted = new Set(entries.map(e => e.id));
  // Remove stale previews (ship no longer shown).
  for (const [id, p] of [...previews]) {
    if (!wanted.has(id)) {
      if (p.holder) scene.remove(p.holder);
      previews.delete(id);
    }
  }
  for (const e of entries) {
    let p = previews.get(e.id);
    if (p) {
      // Same ship id re-shown (e.g. reopened screen): just re-bind the (possibly new) canvas.
      p.canvas = e.canvas;
      p.ctx = e.canvas.getContext('2d');
      continue;
    }
    // A holder we own: the game's normalized ship group nests inside, then we pose the HOLDER to a
    // hero angle. rock = a small idle sway phase so it feels alive without a flat full spin.
    const holder = new THREE.Group();
    holder.visible = false;                 // hidden until its turn in the render loop
    scene.add(holder);
    p = { id: e.id, canvas: e.canvas, ctx: e.canvas.getContext('2d'), holder, rock: Math.random() * Math.PI * 2, model: null, ready: false, camDist: 12.6 };
    previews.set(e.id, p);
    // loadFighterModel returns a group with a placeholder swapped for the real hull when ready. It
    // normalizes orientation (nose -Z, up +Y) using the SAME logic the in-game ships use, so every
    // preview is framed consistently. We then center it and compute a camera distance that fits the
    // hull's bounding SPHERE, so the WHOLE ship stays in frame at every yaw angle (no clipping).
    const shipGroup = loadFighterModel(e.url, SHIP_LEN, (g) => {
      if (!previews.has(e.id)) return;      // screen closed / ship removed while loading
      // Re-center on the group's real bounds now that the hull is in place.
      g.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(g);
      const center = box.getCenter(new THREE.Vector3());
      g.position.sub(center);
      // Fit-to-sphere framing: the bounding sphere is orientation-invariant, so a distance that fits
      // it fits the ship at ANY rotation. Use the tighter of the vertical/horizontal FOV limits and
      // add margin so nose, tail, and wingtips always sit inside the card with breathing room.
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const r = sphere.radius;
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const fitFov = Math.min(vFov, hFov);
      // Dolly distance sets on-screen size (closer = bigger). Halving the previous margin doubles the
      // apparent ship size in the card while still leaving room for the upper-left shift.
      p.camDist = (r / Math.sin(fitFov / 2)) * 0.75;
      p.radius = r;
      // Now that the hull size is known, build its engine trail (sized/seated relative to radius).
      makeTrail(p);
      p.ready = true;
    });
    // Base hero pose: pitched down a touch (viewed from a hair above) with a slight bank so the hull
    // never reads dead flat. The render loop drives a continuous slow YAW turntable on top so the
    // player sees the whole ship from every side, exactly as it looks in-game — just rotating.
    shipGroup.rotation.set(0.14, Math.random() * Math.PI * 2, 0.04);
    holder.add(shipGroup);
    p.model = shipGroup;
  }
}

function renderFrame(now) {
  raf = requestAnimationFrame(renderFrame);
  if (!renderer) return;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
  last = now;
  // Draw each ready preview one at a time: show only its ship, render, blit into its card canvas.
  for (const p of previews.values()) {
    if (!p.ready || !p.holder || !p.ctx || !p.model) continue;
    p.rock += dt;
    // Continuous turntable: steady slow yaw shows the whole hull from every side, with a tiny pitch
    // and bank bob layered on so the light plays across the panels as it turns (never dead flat).
    p.model.rotation.y += dt * 0.55;
    p.model.rotation.x = 0.14 + Math.sin(p.rock * 0.4) * 0.05;
    p.model.rotation.z = 0.04 + Math.sin(p.rock * 0.35) * 0.05;
    // Shift the ship toward the UPPER-CENTER of the card (where the empty space is) instead of
    // leaving it dead-center, which reads low-right against the left-aligned text below. The shift
    // scales with the hull radius so every ship lands in the same spot regardless of size.
    const r = p.radius || 3;
    p.holder.position.set(-r * 0.41, r * 0.20, 0);
    // Dolly the shared camera to THIS ship's fitted distance so its whole hull frames correctly
    // regardless of how long/wide the model is (previews render one at a time, so this is safe).
    camera.position.set(0, 0, p.camDist);
    camera.lookAt(0, 0, 0);
    // Engine trail: only the selected ship emits a live plume; others let theirs die off and hide.
    if (p.trail) updateTrail(p, dt, p.id === selectedId);
    p.holder.visible = true;
    renderer.render(scene, camera);
    p.holder.visible = false;
    const cw = p.canvas.width, ch = p.canvas.height;
    p.ctx.clearRect(0, 0, cw, ch);
    p.ctx.drawImage(offCanvas, 0, 0, OFF_W, OFF_H, 0, 0, cw, ch);
  }
}

// Simulate + write one preview's engine-trail particle system. When `emit` is true the emitter
// spawns fresh particles at the tail; particles always advance/fade so a just-deselected ship's
// plume streams off and dies instead of vanishing abruptly. The plume is hidden once fully dead.
function updateTrail(p, dt, emit) {
  const t = p.trail;
  const r = p.radius || 3;
  const arr = t.geo.attributes.position.array;
  // Spawn: dt-accurate rate so a fast frame spawns proportionally more (keeps the plume dense).
  if (emit) {
    t.spawnAcc += dt;
    const perSec = 90, step = 1 / perSec;
    while (t.spawnAcc >= step) {
      t.spawnAcc -= step;
      const q = t.parts.find(pt => pt.life <= 0);
      if (!q) break;
      // Erupt from a tight disc at the engine mouth with a little spread, streaming backward (+Z).
      const a = Math.random() * Math.PI * 2, rad = Math.random() * r * 0.16;
      q.x = Math.cos(a) * rad;
      q.y = Math.sin(a) * rad;
      q.z = 0;
      q.vx = Math.cos(a) * rad * 0.25;
      q.vy = Math.sin(a) * rad * 0.25;
      q.vz = r * (1.6 + Math.random() * 0.8);   // backward speed
      q.max = 0.42 + Math.random() * 0.22;
      q.life = q.max;
    }
  }
  let anyAlive = false;
  for (let i = 0; i < t.parts.length; i++) {
    const q = t.parts[i];
    if (q.life > 0) {
      q.life -= dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      anyAlive = true;
      arr[i * 3] = q.x; arr[i * 3 + 1] = q.y; arr[i * 3 + 2] = q.z;
    } else {
      // Park dead particles far off so they don't render as a stuck dot at the origin.
      arr[i * 3] = 0; arr[i * 3 + 1] = 0; arr[i * 3 + 2] = 9999;
    }
  }
  t.geo.attributes.position.needsUpdate = true;
  // Gentle flicker on the whole plume so the core pulses like a live engine.
  t.mat.opacity = 0.75 + Math.sin(p.rock * 9) * 0.12;
  t.points.visible = emit || anyAlive;
}

// Host hook: mark which ship shows a live engine trail. Pass an id present in the preview set, or
// null to extinguish all trails. Called from selectShip() so the highlighted hull fires its engines.
export function setSelectedPreview(id) {
  selectedId = id;
}

export function startShipPreviews() {
  if (running) return;
  running = true;
  last = 0;
  raf = requestAnimationFrame(renderFrame);
}

export function stopShipPreviews() {
  running = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

export function disposeShipPreviews() {
  stopShipPreviews();
  for (const p of previews.values()) {
    if (p.trail) { p.trail.geo.dispose(); p.trail.mat.dispose(); }   // free per-ship trail GPU resources
    if (p.holder) scene && scene.remove(p.holder);
  }
  previews.clear();
  if (trailTex) { trailTex.dispose(); trailTex = null; }             // free the shared glow sprite
  if (scene && scene.environment) { scene.environment.dispose(); scene.environment = null; }   // free the IBL render target
  if (renderer) { renderer.dispose(); renderer = null; }
  scene = null; camera = null; offCanvas = null;
}
