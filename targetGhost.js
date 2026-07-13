// targetGhost.js — a tiny self-contained Three.js renderer that draws a slowly-rotating,
// "ghosted" (additive cyan, semi-transparent) silhouette of the currently locked target into
// the cockpit's center radar canvas. It clones the target's own meshes so the model shown in
// the scope matches the enemy the player has in their sights.
import * as THREE from 'three';

let renderer = null, scene = null, camera = null;
let holder = null;          // group that spins; holds the current ghost model
let currentKind = null;     // which enemy kind is mounted, so we only rebuild on change
let spin = 0;

// Ghost material: additive cyan so the model reads as a translucent holographic projection.
function ghostMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0x66f4ff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, wireframe: false
  });
}

export function initTargetGhost(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  const w = canvas.width, h = canvas.height;
  renderer.setSize(w, h, false);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
  camera.position.set(0, 1.2, 8);
  camera.lookAt(0, 0, 0);
  holder = new THREE.Group();
  scene.add(holder);
}

// Mount a fresh ghost clone built from the target group's meshes. We strip sprites/billboards
// (they're flat reference art) and re-skin every mesh with the additive ghost material so the
// silhouette reads clearly regardless of the source colours.
function mount(targetGroup, kind) {
  while (holder.children.length) holder.remove(holder.children[0]);
  targetGroup.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(targetGroup.matrixWorld).invert();
  const clone = new THREE.Group();
  targetGroup.traverse(o => {
    if (o.isMesh && o.geometry) {
      const m = new THREE.Mesh(o.geometry, ghostMaterial());
      // Copy the mesh's transform relative to the target root so proportions stay intact.
      m.matrix.multiplyMatrices(rootInv, o.matrixWorld);
      m.matrixAutoUpdate = false;
      clone.add(m);
    }
  });
  // Normalize size so any target fills the scope nicely.
  clone.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(clone);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const k = 3.4 / longest;
  clone.position.sub(center);
  const scaler = new THREE.Group();
  scaler.scale.setScalar(k);
  scaler.add(clone);
  holder.add(scaler);
  currentKind = kind;
}

// Render one frame. `target` is { e, d } from closestTarget(), or null. Returns true if a ghost
// was drawn this frame (so the caller can toggle the canvas's visibility class).
export function renderTargetGhost(target, dt) {
  if (!renderer) return false;
  if (!target) { currentKind = null; renderer.clear(); return false; }
  const grp = target.e;
  // Key on the target's `kind` when it has one (enemies), else its callSign/uuid (allied wingmen,
  // which share an undefined `kind`) so switching between two allies still remounts the right model.
  const kind = (grp.userData && grp.userData.kind) || (grp.userData && grp.userData.callSign) || grp.uuid;
  if (kind !== currentKind) mount(grp, kind);
  spin += dt * 0.8;
  holder.rotation.y = spin;
  holder.rotation.x = Math.sin(spin * 0.5) * 0.15;
  renderer.render(scene, camera);
  return true;
}
