import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// Upgrade-card frame renderer.
//
// The draft cards used to use a flat .webp image (assets/upgrade-card-frame-tech.webp)
// as their CSS background. We now render the 3D card GLB
// (assets/upgrades/mambaupgradecard-compressed.glb) ONCE into an offscreen canvas and
// hand back a data-URL image of it, so the DOM cards keep a real-3D-looking frame while
// the live upgrade text stays crisp DOM text on top of it.
//
// This is intentionally a one-shot bake (not a live per-frame render): the card sits
// face-on, lit, and the resulting PNG is reused as the background for every card. The
// pick animation (spin / lift / settle / fly-off / vaporize) is done with CSS transforms
// on the DOM cards in index.html + main.js, which keeps the frame art and its text glued
// together through the spin.
// ---------------------------------------------------------------------------
const CARD_GLB = 'assets/upgrades/mambaupgradecard-compressed.glb';
const FALLBACK = 'assets/upgrade-card-frame-tech.webp';

// Render the card GLB to a transparent PNG data URL. Resolves to a CSS url(...) string
// ready to drop straight into `background`. Falls back to the old webp on any failure so
// the draft screen always has a frame. Cached after the first successful bake.
let _cached = null;
export function getCardFrameBackground() {
  if (_cached) return Promise.resolve(_cached);
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; _cached = val; resolve(val); } };
    // Safety net: if the GLB is slow/broken, fall back to the webp so cards never go blank.
    const fbTimer = setTimeout(() => done(`url('${FALLBACK}')`), 9000);

    try {
      const W = 460, H = 660;   // portrait, matches the card's ~184x268 aspect
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(W, H, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 100);

      // Lighting: cool key + soft fill + cyan rim, matching the hangar/HUD palette so the
      // card frame reads with metallic dimensionality rather than flat.
      scene.add(new THREE.AmbientLight(0x5a7894, 1.1));
      const key = new THREE.DirectionalLight(0xeaf6ff, 2.0); key.position.set(2, 4, 6); scene.add(key);
      const fill = new THREE.DirectionalLight(0x6fc7ff, 0.7); fill.position.set(-4, 0, 4); scene.add(fill);
      const rim = new THREE.DirectionalLight(0x9fe4ff, 1.0); rim.position.set(0, 2, -5); scene.add(rim);

      const loader = new GLTFLoader();
      loader.load(CARD_GLB, (gltf) => {
        try {
          const card = gltf.scene;

          // Normalize: center the model and scale it so its largest face fills the frame
          // nicely, then face it flat toward the camera.
          const box = new THREE.Box3().setFromObject(card);
          const size = new THREE.Vector3(); box.getSize(size);
          const center = new THREE.Vector3(); box.getCenter(center);
          card.position.sub(center);                       // recenter on origin
          const maxXY = Math.max(size.x, size.y) || 1;
          const target = 3.2;                              // world units the card should span
          card.scale.setScalar(target / maxXY);

          const rig = new THREE.Group();
          rig.add(card);
          // A touch of tilt so the bake catches some edge light and reads as 3D, not a decal.
          rig.rotation.x = -0.06;
          rig.rotation.y = 0.10;
          scene.add(rig);

          camera.position.set(0, 0, 6.2);
          camera.lookAt(0, 0, 0);

          renderer.render(scene, camera);
          const dataUrl = renderer.domElement.toDataURL('image/png');

          clearTimeout(fbTimer);
          // Free the GPU resources — this was a one-shot bake.
          renderer.dispose();
          done(`url('${dataUrl}')`);
        } catch (e) {
          clearTimeout(fbTimer);
          try { renderer.dispose(); } catch (_) {}
          done(`url('${FALLBACK}')`);
        }
      }, undefined, () => {
        clearTimeout(fbTimer);
        try { renderer.dispose(); } catch (_) {}
        done(`url('${FALLBACK}')`);
      });
    } catch (e) {
      clearTimeout(fbTimer);
      done(`url('${FALLBACK}')`);
    }
  });
}
