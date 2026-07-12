import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// DEV-MODE flag, set once from main.js's DEBUG at startup. When true, calibration-sensitive
// placements (e.g. the Dreadnought's shield generators) keep their current authored positions so
// the dev tuning rigs stay aligned. When false (shipping), those placements are clamped flush
// onto the hull so attached hardware reads as part of the ship instead of perched on top of it.
let SCENE_DEV_MODE = false;
export function setSceneDevMode(on) { SCENE_DEV_MODE = !!on; }

export const PLAYER_MODEL_URL = 'assets/starfighters/meshy_ai_azure_starfighter_0610205715_texture.glb';
// Real GLB models for every enemy kind. All enemies are now full 3D models — the old 2D
// billboard/placeholder path is retired. The azure starfighter is the PLAYER only and is
// never used here. Capital ships are the two massive hulls with open launch bays.
const ENEMY_MODEL_URLS = {
  interceptor: 'assets/starfighters/meshy_ai_crimson_starfighter_0610223402_texture.glb',
  bomber: 'assets/starfighters/meshy_ai_crimson_vortex_gunshi_0610223218_texture.glb',
  drone: 'assets/starfighters/phaserdrone.glb',
  fighter: 'assets/starfighters/enemysf.glb'
};
// Capital ships pick from these massive hulls (each has visible launch bays).
const CAPITAL_MODEL_URLS = [
  'assets/starfighters/dreadnaught-2.glb',
  'assets/starfighters/vanguard.glb'
];

// ---- Allied ("good guy") fleet -----------------------------------------------------------------
// Friendly wingmen + an allied flagship used in DEFEND missions. They reuse the existing hulls but
// fly with the player's BLUE engine palette so the two sides read clearly on screen. The allied
// flagship is the SEMB-Enterprises carrier the player escorts; allied fighters fly cover.
const ALLY_MODEL_URLS = {
  // The dedicated Paladin hull for the escort wing.
  paladin: 'assets/cap-ships/paladin.glb',
  // The vanguard hull as a sturdy allied gunship.
  sentinel: 'assets/starfighters/vanguard.glb',
  // A light allied scout. The generic enemy fighter hull (enemysf.glb) reads as a HOSTILE ship, so
  // the warden flies the friendly azure starfighter hull instead — the same hull as the player.
  warden: 'assets/starfighters/meshy_ai_azure_starfighter_0610205715_texture.glb',
  // ---- Named wingmen (Mission 2) ----
  // Two distinct hero hulls flown by call signs "Slick" and "O.G." — scripted wingmen who exit
  // hyperspace with the player and focus on the enemy capital's batteries.
  slick: 'assets/starfighters/slickc.glb',
  og:    'assets/starfighters/ogc.glb'
};
// The allied capital hulls — dedicated "good guy" SEMB capital ships (Guardian / Paladin /
// Vanguard), distinct silhouettes from the crimson enemy capitals. Guardian is the flagship the
// player escorts (Aegis Prime); Paladin and Vanguard are available as heavier escort capitals.
const ALLY_CAPITAL_URLS = {
  guardian: 'assets/cap-ships/guardian.glb',
  paladin:  'assets/cap-ships/paladin.glb',
  vanguard: 'assets/cap-ships/vanguard-2.glb'
};
// The allied flagship hull used in DEFEND missions.
const ALLY_CAPITAL_URL = ALLY_CAPITAL_URLS.guardian;

// Per-model engine exhaust nozzle positions, taken from the reference rear-views (the artist
// marks each emitter with a green circle). Each entry is [x, y, z] as a FRACTION of the model's
// length L, in the normalized local frame (nose -Z, tail +Z, origin at the model center), so the
// nozzles scale with the ship. Tail sits near +0.33·L. `_default` is used for any kind that
// doesn't yet have a calibrated layout.
const ENEMY_EXHAUST_MOUNTS = {
  // enemysf.glb (fighter): central hub thruster flanked by two side-pod nozzles. RE-calibrated live
  // via the P dev rig AFTER the postYaw orientation fix, so these pos/rot values are correct for the
  // now-corrected hull (the +90° mesh spin offset the earlier tuning). pos in fractions of L, rot in
  // radians. The center fires straight aft; the two pods are toed slightly inward so all three
  // streams converge behind the hull. Literal pos values are pinned exactly (tail-Z auto-snap is
  // skipped for explicit-pos entries).
  fighter: [
    { pos: [ 0.004,  0.007,  0.437] },
    { pos: [ 0.167, -0.001,  0.387], rot: [-3.1440, -3.0392, 0] },
    { pos: [-0.168,  0.003,  0.384], rot: [ 0,        0.0786, 0] }
  ],
  // crimson_starfighter (interceptor): twin engine nozzles flanking the central body. RE-calibrated
  // live via the P dev rig AFTER the postYaw orientation fix, so these pos/rot values are correct for
  // the now-corrected hull (the +90° mesh spin offset the earlier tuning). pos in fractions of L,
  // rot in radians aims each stream straight aft. Literal pos values are pinned exactly (tail-Z
  // auto-snap is skipped for objects with an explicit pos).
  interceptor: [
    { pos: [-0.093, -0.070,  0.362], rot: [0,       0.0524, 0] },
    { pos: [ 0.094, -0.070,  0.371], rot: [3.1178, -3.0916, 0] }
  ],
  // crimson_vortex_gunshi (bomber): twin main thrusters flanking the central hull. RE-calibrated
  // live via the P dev rig AFTER the postYaw orientation fix, so these pos/rot values are correct
  // for the now-corrected hull (the +90° mesh spin offset the earlier tuning). pos in fractions of
  // L, rot in radians toes each stream slightly inward so both flow straight aft. Literal pos
  // values are pinned exactly (tail-Z auto-snap is skipped for explicit-pos entries).
  bomber: [
    { pos: [ 0.078, -0.004,  0.430], rot: [0, -0.0786, 0] },
    { pos: [-0.077, -0.001,  0.433], rot: [0,  0.0786, 0] }
  ],
  // phaserdrone (drone): a single central core thruster dead on the centerline. One green marker
  // in the rear-view reference.
  drone: [
    [ 0.0,  0.0,  0.30]
  ],
  _default: [
    [-0.42 * 0.21, 0, 0.33],
    [ 0.42 * 0.21, 0, 0.33]
  ]
};

// Capital ship exhaust nozzles, keyed by GLB url. Same fraction-of-length local frame as the
// fighter mounts. dreadnaught-2.glb has four large thrusters in two outboard pairs (upper +
// lower) flanking the twin engine housings, per the rear-view reference. `_default` covers any
// capital hull without a calibrated layout yet.
const CAPITAL_EXHAUST_MOUNTS = {
  // Four thruster nozzles, calibrated live in the P drag-and-drop exhaust rig (pos in fractions
  // of L). Two upper + two lower, flanking the twin engine housings at the tail (+Z).
  'assets/starfighters/dreadnaught-2.glb': [
    [-0.207, -0.078, 0.481],
    [ 0.201, -0.079, 0.486],
    [-0.205, -0.159, 0.482],
    [ 0.204, -0.159, 0.492]
  ],
  // vanguard.glb: two large red-ringed main engines, a symmetric pair near the centerline at the
  // wide rear flanks. Two green markers in the rear-view reference.
  'assets/starfighters/vanguard.glb': [
    [-0.20, -0.01,  0.30],
    [ 0.20, -0.01,  0.30]
  ],
  // ---- Allied good-guy capital hulls (Guardian / Paladin / Vanguard). No calibrated rear-view
  // yet, so each uses a broad symmetric engine-bank layout tuned to its silhouette. Adjust once a
  // marked rear-view is available.
  'assets/cap-ships/guardian.glb': [
    [-0.26,  0.02,  0.31],
    [ 0.26,  0.02,  0.31],
    [-0.26, -0.06,  0.31],
    [ 0.26, -0.06,  0.31]
  ],
  'assets/cap-ships/paladin.glb': [
    [-0.30,  0.00,  0.31],
    [ 0.00,  0.02,  0.31],
    [ 0.30,  0.00,  0.31]
  ],
  'assets/cap-ships/vanguard-2.glb': [
    [-0.22, -0.01,  0.31],
    [ 0.22, -0.01,  0.31]
  ],
  _default: [
    [-0.22,  0.0,  0.32],
    [ 0.22,  0.0,  0.32]
  ]
};

// Per-model GUN MUZZLE positions, the mirror of the exhaust nozzles: same normalized local frame
// (nose -Z, tail +Z, origin at center, values are FRACTIONS of the model length L), but placed at
// the FRONT of the hull where the cannons sit, so enemy bolts originate from the actual guns. The
// X/Y here mirror each hull's calibrated exhaust spread (cannons sit roughly above the engines),
// with Z pushed forward to the nose plane. `_default` covers any hull without a tuned layout.
const ENEMY_MUZZLE_MOUNTS = {
  // fighter: twin nose cannons. Calibrated live via the O orientation rig (literal pos, in fractions
  // of L) on the postYaw-corrected hull, so bolts leave from the actual gun mouths.
  fighter: [
    { pos: [-0.020, -0.059, -0.490] },
    { pos: [ 0.032, -0.059, -0.481] }
  ],
  // interceptor: twin nose cannons. Calibrated live via the O orientation rig (literal pos, in
  // fractions of L), so the bolts leave from the actual gun mouths on the corrected hull.
  interceptor: [
    { pos: [-0.095, -0.071, -0.138] },
    { pos: [ 0.095, -0.067, -0.125] }
  ],
  // bomber: four chin/wing cannons. Calibrated live via the O orientation rig (literal pos, in
  // fractions of L) on the postYaw-corrected hull, so bolts leave from the actual gun mouths.
  bomber: [
    { pos: [-0.100, -0.020, -0.460] },
    { pos: [ 0.100, -0.020, -0.460] },
    { pos: [-0.084, -0.090, -0.429] },
    { pos: [ 0.084, -0.084, -0.445] }
  ],
  // drone: a single nose spike cannon on the centerline.
  drone: [
    [0.0, 0.0, -0.42]
  ],
  _default: [
    [-0.12, 0.0, -0.40],
    [ 0.12, 0.0, -0.40]
  ]
};

// Per-ALLY engine exhaust nozzle positions for named wingmen, same normalized local frame as the
// enemy exhaust (nose -Z, tail +Z, origin center, FRACTIONS of length L). Calibrated live in the P
// dev rig on the auto-detect-oriented hull. Literal pos values are pinned exactly (tail-Z auto-snap
// is skipped for explicit-pos entries). Hulls without an entry fall back to the default twin layout.
const ALLY_EXHAUST_MOUNTS = {
  // Slick (slickc.glb): twin main thrusters flanking the centerline at the rear (+Z tail).
  slick: [
    { pos: [-0.095, -0.025, 0.462] },
    { pos: [ 0.099, -0.025, 0.462] }
  ],
  // O.G. (ogc.glb): twin main thrusters flanking the centerline at the rear (+Z tail), captured on
  // the postYaw-corrected hull in the P dev rig.
  og: [
    { pos: [-0.109, -0.007, 0.430] },
    { pos: [ 0.109, -0.010, 0.420] }
  ]
};

// Per-ALLY gun muzzle positions for named wingmen, same normalized local frame as the enemy
// muzzles (nose -Z, origin center, FRACTIONS of length L). Calibrated live in the O orientation
// rig on the auto-detect-oriented hull, so wingman bolts leave from the actual gun mouths.
const ALLY_MUZZLE_MOUNTS = {
  // Slick (slickc.glb): four cannons — two on the nose centerline, two slung lower/forward on the
  // chin. Auto-detect orientation was already correct for this hull (no modelRot override needed).
  slick: [
    { pos: [ 0.179,  0.000, -0.011] },
    { pos: [-0.179,  0.000,  0.000] },
    { pos: [ 0.182, -0.061, -0.129] },
    { pos: [-0.179, -0.054, -0.161] }
  ]
};

// Capital ship gun muzzles (broadside batteries near the bow). Fractions of capital length CL.
const CAPITAL_MUZZLE_MOUNTS = {
  _default: [
    [-0.22, 0.02, -0.30],
    [ 0.22, 0.02, -0.30]
  ]
};

// Normalize one exhaust-mount layout entry to a uniform shape. Two authoring forms are accepted:
//   [x, y, z]                          -> position only (legacy); tail-Z auto-snap may adjust it
//   { pos:[x,y,z], rot:[x,y,z] }       -> explicit pos (NOT auto-snapped) + Euler rotation (radians)
// `rot` is optional. `fixed` is true when an explicit `pos` object was given, telling tailFromModel
// to trust the literal position instead of re-deriving it from the measured tail.
function normMount(entry) {
  if (Array.isArray(entry)) return { pos: entry, rot: null, fixed: false };
  return { pos: entry.pos, rot: entry.rot || null, fixed: true };
}

const loader = new THREE.TextureLoader();
function tex(path) {
  const t = loader.load(path);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const enemyTex = {
  interceptor: tex('assets/enemy-void-interceptor-reference.webp'),
  bomber: tex('assets/enemy-siege-bomber-reference.webp'),
  drone: tex('assets/enemy-sentinel-drone-reference.webp'),
  capital: tex('assets/enemy-capital-warship-reference.webp')
};

// Paint the SAME deep-space starfield the opening cutscene uses, so gameplay shares the
// identical backdrop. (Kept here as a standalone painter to avoid a circular import with
// cutscene.js, which imports ship/bolt helpers from this module.) A 4096x2048 canvas with
// thousands of crisp single-pixel stars, a layer of brighter mid stars, and a sparse set
// of glowing hero stars.
export function paintGameplayStarfield() {
  const c = document.createElement('canvas');
  c.width = 4096; c.height = 2048;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#01030a';
  ctx.fillRect(0, 0, c.width, c.height);
  const tints = ['255,255,255', '215,230,255', '255,244,226', '198,216,255', '255,232,236'];
  const pick = () => tints[(Math.random() * tints.length) | 0];
  for (let i = 0; i < 5000; i++) {
    const x = (Math.random() * c.width) | 0, y = (Math.random() * c.height) | 0;
    ctx.fillStyle = `rgba(${pick()},${0.45 + Math.random() * 0.5})`;
    ctx.fillRect(x, y, 1, 1);
  }
  for (let i = 0; i < 900; i++) {
    const x = (Math.random() * c.width) | 0, y = (Math.random() * c.height) | 0;
    ctx.fillStyle = `rgba(${pick()},${0.7 + Math.random() * 0.3})`;
    ctx.fillRect(x, y, 2, 2);
  }
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
    ctx.fillStyle = `rgba(255,255,255,1)`;
    ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
  }
  return c;
}

// The painted starfield as an equirectangular scene-background texture.
function makeStarrySkyTexture() {
  const t = new THREE.CanvasTexture(paintGameplayStarfield());
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.anisotropy = 4;
  return t;
}

export function initScene(container) {
  const scene = new THREE.Scene();
  // Thin fog: keeps depth haze on distant fighters/debris but lets the enormous Dreadnought read
  // from much further out (its sheer size should be visible long before you're on top of it).
  scene.fog = new THREE.FogExp2(0x01030a, 0.0032);
  const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2500);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x87a6ff, 0.6));
  // Key "sun": stronger and warmer now so enemy hulls catch real sunlight and POP against the
  // dark starfield instead of reading as flat silhouettes.
  const sun = new THREE.DirectionalLight(0xfff4e0, 3.4);
  sun.position.set(80, 90, 40);
  scene.add(sun);
  // Hemisphere light: a soft sky-to-space gradient fill so unlit faces pick up a cool glow and
  // the ships read three-dimensionally rather than going pure black on their shadow side.
  scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x14203a, 0.7));
  // Gentle bounce/fill from the opposite side of the sun to lift the shadowed flanks.
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.9);
  fill.position.set(-60, -20, -50);
  scene.add(fill);

  // Background: the SAME painted deep-space starfield used in the opening cutscene, so the
  // transition from cutscene to gameplay keeps an identical backdrop (no parallax, never
  // culled, always crisp). Replaces the old WebP equirect backdrop + sparse Points layer.
  // We keep BOTH the star texture and a flat-black backdrop on hand so the warp-in/out can
  // swap to black while the streak tube is rushing past — otherwise the static stars sit
  // motionless behind the streaks and break the "everything whooshing" illusion.
  const skyTex = makeStarrySkyTexture();
  const skyBlack = new THREE.Color(0x01030a);
  scene.background = skyTex;

  const player = makePlayerShip();
  scene.add(player);
  const trails = new THREE.Group(); scene.add(trails);
  // Engine trail ribbons are world-space; register a hook so newly attached engines
  // add their trail mesh to the dedicated group instead of the player transform.
  player.userData.trailGroup = trails;
  const boltGroup = new THREE.Group(); scene.add(boltGroup);
  const missileGroup = new THREE.Group(); scene.add(missileGroup);   // guided missiles + chaff flares
  const enemies = new THREE.Group(); scene.add(enemies);
  const allies = new THREE.Group(); scene.add(allies);
  const explosions = new THREE.Group(); scene.add(explosions);
  // Speed-debris motes that rush past the ship to sell motion (esp. in cockpit view).
  const debris = makeDebrisField(); scene.add(debris);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });
  return { scene, camera, renderer, player, trails, boltGroup, missileGroup, enemies, allies, explosions, debris, skyTex, skyBlack };
}

function mat(color, emissive = 0x000000) { return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: emissive ? .7 : 0, roughness: .45, metalness: .55 }); }

// Temporary placeholder shown while the GLB streams in, so the group is never empty.
function makePlaceholderShip() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.05, 4.2, 4), mat(0x203445, 0x05252d));
  body.rotation.x = Math.PI / 2; g.add(body);
  return g;
}

const gltfLoader = new GLTFLoader();

// ---------------------------------------------------------------------------
// Cached, SEQUENTIAL GLB loading.
//
// The models are ~9MB each. Firing several of these fetches in parallel (preloader
// + scene player + cutscene enemies all at once) overwhelms the sandbox and the
// browser aborts them with "TypeError: Load failed". To fix that we:
//   1) De-duplicate by URL so each file is downloaded at most once (shared Promise).
//   2) Serialize downloads through a single queue so only one heavy GLB is in
//      flight at a time. Cache hits resolve instantly without re-fetching.
// Callers get a fresh clone() of the cached gltf.scene so many ships can reuse one
// downloaded model.
// ---------------------------------------------------------------------------
const _glbCache = new Map();   // url -> Promise<THREE.Object3D (master scene)>
let _glbQueue = Promise.resolve();

// Load one GLB with a couple of retries, since large files are occasionally aborted
// by the sandbox under load ("TypeError: Load failed").
function _loadOnce(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (gltf) => resolve(gltf.scene), undefined, (err) => reject(err));
  });
}
function _loadWithRetry(url, attempts = 4) {
  return _loadOnce(url).catch((err) => {
    if (attempts <= 1) {
      // Only the genuinely-exhausted failure is worth a warning.
      console.warn('GLB load failed after retries:', url, err);
      throw err;
    }
    // A transient sandbox abort on a multi-megabyte fetch is expected and recovered
    // from, so keep the retry quiet (log, not warn) and back off a bit longer each
    // time so the connection has room to settle before the next attempt.
    const tried = 4 - attempts + 1;
    console.log(`GLB load attempt ${tried} interrupted, retrying:`, url);
    const backoff = 500 * tried;   // 500ms, 1000ms, 1500ms ...
    return new Promise(res => setTimeout(res, backoff)).then(() => _loadWithRetry(url, attempts - 1));
  });
}

function loadGLBCached(url) {
  if (_glbCache.has(url)) return _glbCache.get(url);
  // Chain this load onto the queue so downloads happen one after another, with a
  // small gap between them to avoid overlapping multi-megabyte fetches.
  const p = _glbQueue.then(() => _loadWithRetry(url));
  _glbCache.set(url, p);
  // Keep the queue moving (with a short spacer) even if a load fails.
  _glbQueue = p.catch(() => {}).then(() => new Promise(res => setTimeout(res, 200)));
  // Don't permanently cache a hard failure: drop it so a later call can retry fresh.
  p.catch(() => { if (_glbCache.get(url) === p) _glbCache.delete(url); });
  return p;
}

// Resolve a ready-to-use clone of a model, or reject if it could not be loaded.
function getModelClone(url) {
  return loadGLBCached(url).then((master) => master.clone(true));
}

// Public wrapper: resolve a fresh clone of a GLB by url (shares the sequential cache). Used by the
// ship-select preview module to mount rotating hull models without duplicating the loader.
export function getShipModelClone(url) {
  return getModelClone(url);
}

// Maps a playable ship id (see shipRoster.js) to its GLB, nominal length, and the pre-calibrated
// muzzle/exhaust mount tables. The Lightning (azure hull) is the ONLY ship that uses the automatic
// detectMounts() path — every captured/hero hull already has dev-rig-calibrated mounts in the
// ENEMY_*/ALLY_* tables, so we reuse those exactly (same as makeEnemy/makeAlly do) to keep guns and
// engine trails leaving from the real gun mouths / thrusters.
const PLAYABLE_HULLS = {
  lightning:   { url: PLAYER_MODEL_URL, len: 6.2, auto: true },
  fury:        { url: 'assets/starfighters/slickc.glb', len: 5.6, muzzles: ALLY_MUZZLE_MOUNTS.slick, exhaust: ALLY_EXHAUST_MOUNTS.slick },
  concept:     { url: 'assets/starfighters/ogc.glb', len: 5.8, muzzles: ENEMY_MUZZLE_MOUNTS._default, exhaust: ALLY_EXHAUST_MOUNTS.og },
  interceptor: { url: 'assets/starfighters/meshy_ai_crimson_starfighter_0610223402_texture.glb', len: 4.6, muzzles: ENEMY_MUZZLE_MOUNTS.interceptor, exhaust: null },
  fighter:     { url: 'assets/starfighters/enemysf.glb', len: 4.8, muzzles: ENEMY_MUZZLE_MOUNTS.fighter, exhaust: null },
  bomber:      { url: 'assets/starfighters/meshy_ai_crimson_vortex_gunshi_0610223218_texture.glb', len: 6.2, muzzles: ENEMY_MUZZLE_MOUNTS.bomber, exhaust: null },
};

// Build the local player's ship. `shipId` selects which playable hull to fly (defaults to the
// Lightning). All hulls share the same reactive shield dome and effect-anchor plumbing; only the
// GLB + calibrated mounts differ.
export function makePlayerShip(shipId = 'lightning') {
  const hull = PLAYABLE_HULLS[shipId] || PLAYABLE_HULLS.lightning;
  const g = new THREE.Group();
  g.userData.vel = new THREE.Vector3();
  g.userData.shipId = shipId;
  // Holds the visible model (placeholder until the GLB is ready) so we can swap cleanly.
  const modelHolder = new THREE.Group();
  g.add(modelHolder);
  // Expose the visible-model holder so the view code can hide it in first-person (cockpit)
  // view — that way the camera can never end up looking through the ship's own hull when the
  // nose pitches down.
  g.userData.modelHolder = modelHolder;
  const placeholder = makePlaceholderShip();
  modelHolder.add(placeholder);

  // Effect anchors. Engines: exhaust cores + trail emitters. Muzzles: laser spawn points.
  g.userData.engines = [];
  g.userData.muzzles = [];
  g.userData.modelReady = false;

  // Shield impact dome: the SAME reactive shield the Dreadnought uses, scaled to the fighter.
  // baseMul:0 keeps it COMPLETELY INVISIBLE at rest — it only blooms a directional absorb-flash +
  // ripple right where the shields soak a hit. registerShieldHit() centers the ripple on the strike
  // point; updatePlayerShield() rolls its clock. Sized to wrap the hull (scaled to the hull length).
  const shieldRadius = 4.4 * (hull.len / 6.2);
  const shield = makeShieldDome(shieldRadius, { baseMul: 0, color: 0x4fb6ff, hotColor: 0xdff3ff, segments: 40 });
  g.add(shield);
  g.userData.shieldDome = shield;          // unified with the capital so registerShieldHit() works on both
  g.userData.shieldRadius = shieldRadius;
  g.userData.shield = shield;              // back-compat alias

  const L = hull.len;

  getModelClone(hull.url).then((model) => {
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

    // Normalize: center on origin, scale to a consistent length, and face -Z (game forward).
    const box0 = new THREE.Box3().setFromObject(model);
    const size = box0.getSize(new THREE.Vector3());
    const center = box0.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const longest = Math.max(size.x, size.y, size.z);
    model.scale.multiplyScalar(L / longest);

    // Re-evaluate which axis is "forward" and orient the ship to point down -Z.
    const wrap = new THREE.Group();
    wrap.add(model);
    orientShipForward(wrap, model, hull.url);

    modelHolder.remove(placeholder);
    modelHolder.add(wrap);

    if (hull.auto) {
      // Lightning: automatic mount detection (unchanged from the original azure-hull path).
      const mounts = detectMounts(wrap);
      attachEngineEffects(g, mounts.engines);
      g.userData.muzzles = mounts.muzzles;
    } else {
      // Captured/hero hulls: use the dev-calibrated mount tables, anchored to the model's real
      // nose/tail via the same helpers makeEnemy/makeAlly use. Guns fire from the actual muzzles.
      if (hull.muzzles) attachMuzzles(g, noseFromModel(wrap, hull.muzzles, L));
      else g.userData.muzzles = [new THREE.Vector3(-0.12 * L, 0, -0.4 * L), new THREE.Vector3(0.12 * L, 0, -0.4 * L)];
      if (hull.exhaust) {
        attachEngineEffects(g, tailFromModel(wrap, hull.exhaust, L));
      } else {
        // No calibrated exhaust for this hull: fall back to the symmetric default twin nozzles
        // anchored on the measured tail.
        const mounts = tailFromModel(wrap, ENEMY_EXHAUST_MOUNTS._default, L);
        attachEngineEffects(g, mounts);
      }
    }
    // Cosmetic orientation correction AFTER mounts are placed (mirrors loadFighterModel), so a
    // yawed-in-mesh hull faces forward without disturbing the calibrated mount positions.
    const override = MODEL_ORIENT_OVERRIDES[hull.url];
    if (override && override.postYaw) wrap.rotation.y += override.postYaw;
    g.userData.modelReady = true;
  }).catch((err) => {
    console.warn('Player model failed to load, using placeholder.', err);
    // Fallback mounts so trails/lasers still work on the placeholder.
    attachEngineEffects(g, [
      new THREE.Vector3(-0.55, -0.15, 1.95),
      new THREE.Vector3(0.55, -0.15, 1.95)
    ]);
    g.userData.muzzles = [
      new THREE.Vector3(-0.8, 0, -2.5),
      new THREE.Vector3(0.8, 0, -2.5)
    ];
    g.userData.modelReady = true;
  });

  return g;
}

// Build a display-only hull for a REMOTE pilot's ship (multiplayer). It renders the chosen playable
// hull with its calibrated engine trails, but carries no gameplay AI/mounts — its pose is driven by
// snapshot interpolation in multiplayer.js. `tint` colors the engine exhaust ('blue' or 'red') so
// teams read at a glance. Returns a Group whose userData the netcode fills with targeting metadata.
export function makeRemoteShip(shipId = 'lightning', enginePalette = 'blue') {
  const hull = PLAYABLE_HULLS[shipId] || PLAYABLE_HULLS.lightning;
  const g = new THREE.Group();
  const modelHolder = new THREE.Group();
  g.add(modelHolder);
  g.userData.modelHolder = modelHolder;
  modelHolder.add(makePlaceholderShip());
  // Engine exhaust streaks live in WORLD space (not under the ship), so they need a scene-level
  // trail group to parent into — exactly like makeEnemy/makeAlly. Without this, attachEngineEffects
  // falls back to parenting the trail under the ship in local space, where updateEngineTrails (which
  // writes world-space vertices) renders it as garbage/invisible. The caller adds trailGroup to the
  // scene and RemoteShip.dispose() removes it. Set it BEFORE the async model callback attaches the
  // engines so they're parented correctly the moment the model loads.
  const trailGroup = new THREE.Group();
  g.userData.trailGroup = trailGroup;
  const L = hull.len;
  // IMPORTANT — mount/yaw ordering must match makePlayerShip + loadFighterModel exactly, or the
  // red hulls' exhaust ends up on a flank ("ship here, trail over there"). loadFighterModel places
  // the exhaust mounts in the UN-yawed frame during onReady, then applies the cosmetic postYaw to
  // the VISIBLE MESH only (wrap.rotation.y) AFTER onReady. The engine effect group is attached at
  // that same un-yawed tail and simply tracks the ship group in world space, so it lines up with
  // the corrected mesh. An earlier version double-corrected by ALSO rotating the mounts here, which
  // spun the nozzles a quarter-turn off the visible tail on the red team (postYaw ~90°). Attach the
  // measured tail mounts straight through — no extra yaw — exactly like single-player.
  const model = loadFighterModel(hull.url, L, (mg) => {
    if (hull.exhaust) attachEngineEffects(g, tailFromModel(mg, hull.exhaust, L), enginePalette);
    else attachEngineEffects(g, tailFromModel(mg, ENEMY_EXHAUST_MOUNTS._default, L), enginePalette);
  });
  // loadFighterModel manages its own placeholder; drop ours and add its group.
  for (let i = modelHolder.children.length - 1; i >= 0; i--) modelHolder.remove(modelHolder.children[i]);
  modelHolder.add(model);
  g.userData.model = model;
  g.userData.shipId = shipId;
  return g;
}

// Rebuild an EXISTING player group's visible hull + effect mounts to a different playable ship,
// keeping the same Object3D reference (so main.js's `player` binding, trailGroup registration, and
// gameplay userData all stay valid). Used when a pilot picks a ship for Free Flight before launch.
// Disposes the old model + engine effects, then streams in the new GLB and re-anchors mounts using
// the same pipeline as makePlayerShip().
export function swapPlayerHull(g, shipId = 'lightning', enginePalette = 'blue') {
  const hull = PLAYABLE_HULLS[shipId] || PLAYABLE_HULLS.lightning;
  // Already flying this exact hull with its model in place — nothing to load, resolve immediately.
  if (g.userData.shipId === shipId && g.userData.modelReady) return Promise.resolve();
  g.userData.shipId = shipId;
  g.userData.modelReady = false;
  const modelHolder = g.userData.modelHolder;
  // Tear down the current visible model + its engine exhaust meshes (they live in the world-space
  // trailGroup, so disposeEngineEffects removes them properly).
  disposeEngineEffects(g);
  g.userData.engines = [];
  g.userData.muzzles = [];
  if (modelHolder) {
    for (let i = modelHolder.children.length - 1; i >= 0; i--) modelHolder.remove(modelHolder.children[i]);
    modelHolder.add(makePlaceholderShip());
  }
  // Resize the shield dome to the new hull length.
  const shieldRadius = 4.4 * (hull.len / 6.2);
  g.userData.shieldRadius = shieldRadius;
  const L = hull.len;

  return getModelClone(hull.url).then((model) => {
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const box0 = new THREE.Box3().setFromObject(model);
    const size = box0.getSize(new THREE.Vector3());
    const center = box0.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const longest = Math.max(size.x, size.y, size.z);
    model.scale.multiplyScalar(L / longest);
    const wrap = new THREE.Group();
    wrap.add(model);
    orientShipForward(wrap, model, hull.url);
    if (modelHolder) {
      for (let i = modelHolder.children.length - 1; i >= 0; i--) modelHolder.remove(modelHolder.children[i]);
      modelHolder.add(wrap);
    }
    if (hull.auto) {
      const mounts = detectMounts(wrap);
      attachEngineEffects(g, mounts.engines, enginePalette);
      g.userData.muzzles = mounts.muzzles;
    } else {
      if (hull.muzzles) attachMuzzles(g, noseFromModel(wrap, hull.muzzles, L));
      else g.userData.muzzles = [new THREE.Vector3(-0.12 * L, 0, -0.4 * L), new THREE.Vector3(0.12 * L, 0, -0.4 * L)];
      if (hull.exhaust) attachEngineEffects(g, tailFromModel(wrap, hull.exhaust, L), enginePalette);
      else attachEngineEffects(g, tailFromModel(wrap, ENEMY_EXHAUST_MOUNTS._default, L), enginePalette);
    }
    const override = MODEL_ORIENT_OVERRIDES[hull.url];
    if (override && override.postYaw) wrap.rotation.y += override.postYaw;
    g.userData.modelReady = true;
  }).catch((err) => {
    console.warn('Player hull swap failed, keeping placeholder.', shipId, err);
    attachEngineEffects(g, [new THREE.Vector3(-0.55, -0.15, 1.95), new THREE.Vector3(0.55, -0.15, 1.95)], enginePalette);
    g.userData.muzzles = [new THREE.Vector3(-0.8, 0, -2.5), new THREE.Vector3(0.8, 0, -2.5)];
    g.userData.modelReady = true;
  });
}

// Rotate `model` inside `wrap` so the ship's nose points toward -Z and "up" is +Y.
// A few hulls have a bounding box that fools the automatic "longest axis = length" guess (e.g.
// the crimson gunshi bomber is nearly as wide as it is long, so auto-detect can rotate its true
// tail to the side and the exhaust then streams from a flank). For those, force the orientation
// explicitly: `lengthAxis` is which local model axis is the nose-tail direction, and `flip` adds
// a 180° spin about Y if the nose ends up pointing the wrong way down -Z.
const MODEL_ORIENT_OVERRIDES = {
  // gunshi bomber: lock its length onto Z so the engines stay at the true tail. The visible mesh
  // also came in yawed 90° off the flight axis (same as the interceptor), so postYaw spins it back
  // (cosmetic only, applied AFTER the exhaust/muzzle mounts are placed so it doesn't disturb them)
  // — calibrated in the O orientation rig (1.5696 rad ≈ +90°).
  'assets/starfighters/meshy_ai_crimson_vortex_gunshi_0610223218_texture.glb': { lengthAxis: 'z', flip: false, postYaw: 1.5696 },
  // crimson interceptor: wide swept wings make the hull wider than it is long, so the auto
  // "longest axis = length" guess rotates the true tail onto a flank and the exhaust streams
  // sideways. Lock the length onto Z so the twin tail nozzles stay at the rear (+Z). The visible
  // mesh also came in yawed 90° off the flight axis, so postYaw spins it back (cosmetic only,
  // applied AFTER the exhaust/muzzle mounts are placed so it doesn't disturb them) — calibrated
  // in the O orientation rig (1.5696 rad ≈ +90°).
  'assets/starfighters/meshy_ai_crimson_starfighter_0610223402_texture.glb': { lengthAxis: 'z', flip: false, postYaw: 1.5696 },
  // generic enemy fighter (enemysf.glb): same wide-wing problem — pin its length to Z. The visible
  // mesh also came in yawed 90° off the flight axis (same as the crimson hulls), so postYaw spins it
  // back (cosmetic only, applied AFTER the exhaust/muzzle mounts so it doesn't disturb them) —
  // calibrated in the O orientation rig (1.5696 rad ≈ +90°). Shared by the enemy fighter and the
  // ally warden, so both hulls get the correction.
  'assets/starfighters/enemysf.glb': { lengthAxis: 'z', flip: false, postYaw: 1.5696 },
  // O.G.'s wingman hull (ogc.glb): same meshy fighter family as the crimson/enemy hulls — its wide
  // wings make the auto "longest axis = length" guess pick a flank, and the visible mesh came in
  // yawed 90° off the flight axis. Lock length onto Z and postYaw it back so the nose/exhaust line
  // up with travel. Calibrated live in the O orientation rig (modelRot.y = 1.5696 rad ≈ +90°).
  'assets/starfighters/ogc.glb': { lengthAxis: 'z', flip: false, postYaw: 1.5696 }
};

function orientShipForward(wrap, model, url = null) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  // The shortest axis is "up" (thin), the longest is "length".
  const axes = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => a[1] - b[1]);
  const upAxis = axes[0][0];
  const override = url && MODEL_ORIENT_OVERRIDES[url];
  const lengthAxis = override ? override.lengthAxis : axes[2][0];
  // Bring length axis onto Z.
  if (lengthAxis === 'x') model.rotation.y = Math.PI / 2;
  else if (lengthAxis === 'y') model.rotation.x = Math.PI / 2;
  // Bring up axis onto Y if the model came in nose-down/flat.
  if (upAxis === 'z' && lengthAxis !== 'z') model.rotation.x += Math.PI / 2;

  // The source model's nose points toward +Z, but the game treats -Z as forward
  // (camera/movement use getWorldDirection). Flip 180° about Y so the nose (and the
  // forward-facing cannons) point down -Z and the engines sit at +Z. An override can suppress
  // this flip for hulls whose source nose already faces -Z after the length-axis alignment.
  if (!(override && override.flip === false && lengthAxis !== 'z')) model.rotation.y += Math.PI;

  // After coarse alignment, decide nose direction: heavier mass toward the tail (engines),
  // so the pointier (less mass) end should face -Z. Sample by comparing bound extents.
  model.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(model);
  const c2 = b2.getCenter(new THREE.Vector3());
  // Recenter after rotation.
  model.position.x -= c2.x; model.position.y -= c2.y; model.position.z -= c2.z;
}

// Find engine and cannon anchor points from the model's geometry, in the player-group's local space.
function detectMounts(wrap) {
  wrap.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3());
  const halfL = size.z / 2;
  const halfW = size.x / 2;
  // -Z is forward (nose), +Z is rear (engines).
  const rearZ = halfL * 0.92;
  const noseZ = -halfL * 0.96;
  // The real engine nacelles (big dark thruster rings) sit close to the fuselage,
  // INBOARD of the wing-mounted cannons. Keep the exhaust emitters near the
  // centerline so the trails stream from the engines, not the wing cannons.
  const sideX = halfW * 0.16;
  const engines = [
    new THREE.Vector3(-sideX, -size.y * 0.04, rearZ),
    new THREE.Vector3(sideX, -size.y * 0.04, rearZ)
  ];
  // Four forward-facing cannons: inner pair near the centerline, outer pair at the LOWER wing
  // roots (dropped below the centerline and pulled a touch inboard) so the outer bolts originate
  // from the lower wings rather than fanning up across the canopy/A-pillars. All converge on the
  // reticle aim-point (see fire()), so they still cross cleanly with the inner pair.
  const muzzles = [
    new THREE.Vector3(-halfW * 0.30, 0, noseZ),
    new THREE.Vector3(halfW * 0.30, 0, noseZ),
    new THREE.Vector3(-halfW * 0.50, -size.y * 0.34, noseZ),
    new THREE.Vector3(halfW * 0.50, -size.y * 0.34, noseZ)
  ];
  return { engines, muzzles };
}

// Build glowing exhaust cores + speed-reactive trail ribbons at each engine mount.
// palette lets enemies use a red exhaust matching the player's blue one. core/glow/hot/beam
// are the four tints used by the exhaust pieces.
const ENGINE_PALETTES = {
  blue: { core: 0x2bdcff, glow: 0x57e6ff, hot: 0xeafdff, beam: 0x57e0ff },
  // Enemy exhaust reads distinctly CRIMSON/RED (not orange) — used by single-player hostiles AND
  // the red multiplayer team so both sides' hulls carry the hostile palette.
  red:  { core: 0xff2a1e, glow: 0xff4635, hot: 0xffdcd2, beam: 0xff3a2c }
};
function attachEngineEffects(g, mountPoints, palette = 'blue', effectScale = 1) {
  g.userData.engines = [];
  // `palette` may be a named key ('blue'/'red') OR a full palette object { core, glow, hot, beam }
  // — the latter lets the player's Ship-Hangar engine-trail cosmetic supply a custom tint set.
  const pal = (palette && typeof palette === 'object' && palette.core != null)
    ? palette
    : (ENGINE_PALETTES[palette] || ENGINE_PALETTES.blue);
  const TRAIL_SEGMENTS = 26;
  for (const mp of mountPoints) {
    // Each entry is either a bare Vector3 (position) or { pos: Vector3, rot: [x,y,z] radians }.
    const local = mp.isVector3 ? mp : mp.pos;
    const rot = mp.isVector3 ? null : mp.rot;
    const engine = new THREE.Group();
    engine.position.copy(local);
    // Orient the nozzle so its local +Z (the exhaust flow axis) aims as calibrated. Without a
    // rot the group stays unrotated and the stream follows the ship's tail axis as before.
    if (rot) engine.rotation.set(rot[0], rot[1], rot[2]);
    // Scale the visible nozzle blobs (core/glow/hot) to suit the hull — capital ships use a
    // large effectScale so their thrusters read as huge engines rather than fighter-sized dots.
    // The world-space streak puffs are sized separately (per-frame, via trailScale).
    engine.scale.setScalar(effectScale);
    g.add(engine);

    // Bright exhaust core: an additive sphere + glow sprite.
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 16, 12),
      new THREE.MeshBasicMaterial({ color: pal.core, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    core.scale.set(1, 1, 1.6);
    engine.add(core);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeGlowTexture(), color: pal.glow, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(1.1, 1.1, 1.1);
    engine.add(glow);
    // Inner white-hot point.
    const hot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), new THREE.MeshBasicMaterial({ color: pal.hot, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    engine.add(hot);

    // Trail ribbon: a strip whose vertices we update each frame to streak behind the ship.
    const positions = new Float32Array(TRAIL_SEGMENTS * 2 * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const alphas = new Float32Array(TRAIL_SEGMENTS * 2);
    trailGeo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    const indices = [];
    for (let i = 0; i < TRAIL_SEGMENTS - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, b, c, b, d, c);
    }
    trailGeo.setIndex(indices);
    const trailMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(pal.beam) } },
      vertexShader: `attribute float alpha; varying float vAlpha; void main(){ vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vAlpha; void main(){ gl_FragColor = vec4(uColor, vAlpha); }`
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.frustumCulled = false;
    trail.renderOrder = 2;
    // Trail lives in world space, so it is parented to the scene-level trail group.
    trail.userData = { history: [], maxLen: TRAIL_SEGMENTS, width: 0.34 };
    if (g.userData.trailGroup) g.userData.trailGroup.add(trail);
    else g.add(trail);

    // ---- Beam exhaust stream ----------------------------------------------------------
    // A pool of additive, camera-facing QUADS that spawn at the nozzle and are stretched
    // along the thrust axis into thin BEAM streaks (not round puffs). Each streak lives in
    // world space, eases backward, and fades from the instant it's born, so the exhaust
    // reads as a flowing tapered beam that dissolves immediately behind the ship.
    const PUFFS = 220;   // large pool: high emit rate must not recycle live streaks (avoids gaps)
    const beamPos = new Float32Array(PUFFS * 4 * 3);   // 4 verts/quad
    const beamUv = new Float32Array(PUFFS * 4 * 2);
    const beamAlpha = new Float32Array(PUFFS * 4);
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
    beamGeo.setAttribute('uv', new THREE.BufferAttribute(beamUv, 2));
    beamGeo.setAttribute('alpha', new THREE.BufferAttribute(beamAlpha, 1));
    const beamIdx = [];
    for (let i = 0; i < PUFFS; i++) {
      const o = i * 4;
      beamIdx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      // Static per-quad UVs. Corner order is a(-axis,-side) b(+axis,-side) c(+axis,+side)
      // d(-axis,+side). The beam texture tapers down its V axis and feathers across U, so we
      // map V -> beam LENGTH (the axis) and U -> beam WIDTH (the side).
      const u = i * 4 * 2;
      beamUv[u] = 0; beamUv[u + 1] = 0;       // a: length 0, width 0
      beamUv[u + 2] = 0; beamUv[u + 3] = 1;   // b: length 1, width 0
      beamUv[u + 4] = 1; beamUv[u + 5] = 1;   // c: length 1, width 1
      beamUv[u + 6] = 1; beamUv[u + 7] = 0;   // d: length 0, width 1
    }
    beamGeo.setIndex(beamIdx);
    const puffMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(pal.beam) }, uTex: { value: makeBeamTexture() } },
      vertexShader: `
        attribute float alpha; varying float vAlpha; varying vec2 vUv;
        void main(){ vAlpha = alpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; uniform sampler2D uTex; varying float vAlpha; varying vec2 vUv;
        void main(){ vec4 t = texture2D(uTex, vUv); gl_FragColor = vec4(uColor, t.a * vAlpha); }`
    });
    const puffs = new THREE.Mesh(beamGeo, puffMat);
    puffs.frustumCulled = false;
    puffs.renderOrder = 2;
    // Per-streak CPU state: world position, velocity, age, life, base half-width.
    const puffState = [];
    for (let i = 0; i < PUFFS; i++) puffState.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 1, size: 0, len: 0 });
    puffs.userData = { state: puffState, next: 0, emitAccum: 0 };
    if (g.userData.trailGroup) g.userData.trailGroup.add(puffs);
    else g.add(puffs);

    g.userData.engines.push({ group: engine, core, hot, glow, trail, puffs });
  }
}

// Show/hide ALL of a ship's engine exhaust pieces at once — the nozzle blobs (core/hot/glow, under
// the ship) AND the world-space trail ribbon + beam streaks (which live in the scene-level
// trailGroup, not under the ship). Used to hide the player's OWN exhaust in first-person cockpit
// view: those meshes are parented to the ship group / world, NOT the modelHolder, so hiding the
// hull alone left the engine glow floating in front of the cockpit camera.
export function setEngineEffectsVisible(g, visible) {
  if (!g.userData || !g.userData.engines) return;
  for (const eng of g.userData.engines) {
    if (eng.group) eng.group.visible = visible;
    if (eng.trail) eng.trail.visible = visible;
    if (eng.puffs) eng.puffs.visible = visible;
  }
}

// Detach and free a ship's engine exhaust meshes. The trail/puff meshes live in the SCENE-level
// trailGroup (world space), NOT under the ship, so removing the ship alone would leave them
// orphaned on screen. Call this when destroying an enemy so its exhaust beam vanishes with it.
export function disposeEngineEffects(g) {
  if (!g.userData || !g.userData.engines) return;
  for (const eng of g.userData.engines) {
    // World-space streak/ribbon meshes live in the scene-level trailGroup...
    for (const mesh of [eng.trail, eng.puffs]) {
      if (!mesh) continue;
      if (mesh.parent) mesh.parent.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    }
    // ...and the nozzle GROUP (core sphere + glow sprite + hot point) is parented to the ship
    // group `g`. If we don't remove it here, a hull swap orphans the OLD nozzle sprites inside the
    // ship group: they keep rendering (as steady bright dots) but are no longer in userData.engines,
    // so updateEngineTrails' first-person hide never touches them and they float in front of the
    // cockpit. Remove and free the whole group so a swap leaves nothing behind.
    if (eng.group) {
      if (eng.group.parent) eng.group.parent.remove(eng.group);
      eng.group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
  }
  g.userData.engines = null;
}

let _glowTex = null;
function makeGlowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(120,230,255,0.85)');
  grd.addColorStop(1, 'rgba(40,160,255,0)');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

// Beam streak texture for the exhaust quads: a hot white core running down the V axis,
// tapering to nothing at both ends (top/bottom) and feathered on the sides, so a stretched
// quad reads as a thin tapered BEAM of light rather than a soft round puff.
let _beamTex = null;
function makeBeamTexture() {
  if (_beamTex) return _beamTex;
  const c = document.createElement('canvas'); c.width = 32; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 32, 128);
  // Vertical taper: bright in the middle, fading to 0 at the head/tail.
  for (let y = 0; y < 128; y++) {
    const v = y / 127;
    const lenFade = Math.sin(v * Math.PI);           // 0 at ends, 1 mid -> tapered beam
    // Horizontal cross-section: a tight bright core feathered to transparent at the edges.
    const grd = ctx.createLinearGradient(0, 0, 32, 0);
    grd.addColorStop(0.0, 'rgba(120,220,255,0)');
    grd.addColorStop(0.5, `rgba(255,255,255,${0.95 * lenFade})`);
    grd.addColorStop(1.0, 'rgba(120,220,255,0)');
    ctx.fillStyle = grd;
    ctx.globalAlpha = lenFade;
    ctx.fillRect(0, y, 32, 1);
  }
  ctx.globalAlpha = 1;
  _beamTex = new THREE.CanvasTexture(c);
  return _beamTex;
}

// Per-frame update for engine glow pulse and exhaust trail.
// speed01 is 0..1 throttle; camera for billboarding. engineWarp uses the long straight
// lightspeed streak (warp-OUT). trailScale (default 1) stretches/shrinks the soft puff
// exhaust: the warp-IN passes a large scale for a long hyperspace streak that eases down
// to 1 as the ship decelerates to sublight — the engines NEVER go cold, the trail just
// shortens as it slows.
// Trigger the player's shield impact ripple at a WORLD-SPACE strike point. The player now uses the
// same reactive dome as the Dreadnought, so the bloom is a directional absorb-flash + ripple centered
// exactly where the shields soaked the hit — and invisible everywhere else. `hitPos` is the strike
// point in world space (defaults to just ahead of the nose if the caller has none). `strength` is
// kept for call-site compatibility but the dome's impact response is already self-contained.
const _playerShieldDir = new THREE.Vector3();
export function flashPlayerShield(player, strength = 1, hitPos = null) {
  const dome = player.userData && player.userData.shieldDome;
  if (!dome) return;
  let wp = hitPos;
  if (!wp) {
    // No specific strike point: ripple on the forward arc of the dome (where most fire comes from).
    _playerShieldDir.set(0, 0, -1).applyQuaternion(player.quaternion)
      .multiplyScalar(player.userData.shieldRadius || 4.4).add(player.position);
    wp = _playerShieldDir;
  }
  registerShieldHit(player, wp);
}

// Advance the player shield's animation clock each frame so the impact ripple animates and fades.
// The dome draws nothing while no impact is active (baseMul:0), so this is cheap at rest.
export function updatePlayerShield(player, dt) {
  const dome = player.userData && player.userData.shieldDome;
  if (!dome || !dome.userData.shieldMat) return;
  dome.userData.shieldMat.uniforms.uTime.value += dt;
}

export function updateEngineTrails(player, dt, speed01, camera, engineWarp = false, trailScale = 1, shipVel = null, hideExhaust = false, lenScale = 1) {
  if (!player.userData.engines) return;
  const tmp = new THREE.Vector3();
  // Ship's own world velocity. Newly-emitted exhaust streaks inherit this so they stay
  // anchored BEHIND the moving ship instead of being left frozen in world space (which,
  // when the ship is turning, smears the trail off to the side or forward of the nose).
  const _shipVel = shipVel || _ZERO_VEL;
  // Engines are ALWAYS maxed while jumping to hyperspace (engineWarp): nozzles blaze.
  const glow01 = engineWarp ? 1 : speed01;
  // Ship's backward (tail) direction in world space — puffs and the warp streak trail here.
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(player.quaternion).normalize();
  const _engBack = new THREE.Vector3();
  const _engQuat = new THREE.Quaternion();
  for (const eng of player.userData.engines) {
    // First-person (cockpit) view: the camera sits at the ship origin, FORWARD of the
    // engines, so the world-space exhaust streaks (which inherit ship velocity) can drift
    // into view ahead of the cockpit. You can't see your own engines from inside anyway, so
    // hide the whole exhaust — cores, glow sprites and the streak puffs — in this view.
    if (hideExhaust) {
      eng.core.visible = false;
      eng.glow.visible = false;
      eng.hot.visible = false;
      eng.trail.visible = false;
      eng.puffs.visible = false;
      // Also KILL any live world-space streaks so that, on the very next frame the exhaust is
      // shown again (e.g. a chase<->cockpit view flip), there are no stale beam quads left parked
      // out in world space ahead of / beside the ship. Those lingering streaks were the "engine
      // glow outrunning the ship" artifact seen when toggling into first-person. Collapsing their
      // alpha to 0 and marking them dead makes the beam start clean from the nozzle each time.
      const pud = eng.puffs.userData;
      if (pud && pud.state) {
        const aa = eng.puffs.geometry.attributes.alpha.array;
        for (let i = 0; i < pud.state.length; i++) {
          const p = pud.state[i];
          p.age = p.life;                 // mark dead so it won't be advanced/drawn
          const ao = i * 4;
          aa[ao] = aa[ao + 1] = aa[ao + 2] = aa[ao + 3] = 0;
        }
        eng.puffs.geometry.attributes.alpha.needsUpdate = true;
        pud.emitAccum = 0;
        if (pud.prevEmit) pud.prevEmit.has = false;   // don't segment-fill across the gap
      }
      continue;
    }
    eng.core.visible = true; eng.glow.visible = true; eng.hot.visible = true;
    // Pulse the core/glow with throttle and a little flicker.
    const flick = 0.85 + Math.random() * 0.15;
    const intensity = (0.35 + glow01 * 0.6) * flick;
    eng.core.scale.set(1, 1, 1.1 + glow01 * 1.9);
    eng.core.material.opacity = Math.min(0.85, 0.4 + glow01 * 0.5) * flick;
    eng.glow.scale.setScalar(0.9 + glow01 * 1.2);
    eng.glow.material.opacity = 0.35 + glow01 * 0.35;
    eng.hot.material.opacity = intensity;

    // World position of this emitter this frame.
    eng.group.getWorldPosition(tmp);
    // Per-nozzle exhaust direction: the mount's local +Z (tail axis) transformed into world
    // space by the mount group's OWN world orientation. With no extra nozzle rotation this
    // equals the ship's `back`, so default behavior is unchanged; rotating the mount group
    // (dev calibration or a saved layout) aims that nozzle's stream independently.
    const engBack = eng.group.getWorldQuaternion(_engQuat)
      ? _engBack.set(0, 0, 1).applyQuaternion(_engQuat).normalize()
      : back;

    // ---- Lightspeed warp-OUT mode ---------------------------------------------------
    // The ship snaps forward HUGE distances per frame. We use the SAME beam-streak exhaust
    // as normal flight / warp-in (not the legacy ribbon), but flagged as a warpJump so the
    // emitter fills the travelled segment with streaks each frame — keeping the beam
    // continuous instead of leaving gaps — and with a long trailScale + full throttle so it
    // reads as a blazing lightspeed trail.
    if (engineWarp) {
      eng.trail.visible = false;
      eng.puffs.visible = true;
      updateExhaustPuffs(eng, tmp, engBack, dt, 1, Math.max(trailScale, 3), camera, true, _ZERO_VEL);
      continue;
    }

    // Normal flight AND warp-IN: soft puff stream. The geometric ribbon is retired. The
    // trailScale lengthens the puffs during the hyperspace approach and eases back to a
    // normal-length exhaust as the ship slows to sublight.
    eng.trail.visible = false;
    eng.puffs.visible = true;
    updateExhaustPuffs(eng, tmp, engBack, dt, speed01, trailScale, camera, false, _shipVel, lenScale);
  }
}

// Beam exhaust stream. Each frame we age every live streak (drift, fade) and emit new ones
// at the nozzle, scaled by throttle. Each streak is a camera-facing QUAD stretched along
// its travel direction into a thin tapered BEAM. Streaks live in WORLD space, so once
// emitted they stay put and the ship flies past — a flowing beam that dissolves at once.
const _PUFF_LIFE = 0.34;                         // seconds — short so it fades fast
const _ZERO_VEL = new THREE.Vector3(0, 0, 0);    // fallback when no ship velocity is supplied
const _bm = {                                    // scratch vectors (avoid per-frame allocs)
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), view: new THREE.Vector3(),
  axis: new THREE.Vector3(), side: new THREE.Vector3(), a: new THREE.Vector3(),
  b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3()
};
function updateExhaustPuffs(eng, emitterWorld, back, dt, speed01, trailScale = 1, camera, warpJump = false, shipVel = _ZERO_VEL, lenScale = 1) {
  const ud = eng.puffs.userData;
  const st = ud.state;
  const posAttr = eng.puffs.geometry.attributes.position;
  const alphaAttr = eng.puffs.geometry.attributes.alpha;
  const pa = posAttr.array, aa = alphaAttr.array;
  const camPos = camera ? camera.position : _bm.pos.set(0, 0, 1);

  // trailScale > 1 (hyperspace warp-IN / warp-OUT) lengthens the beam: streaks are shot back
  // faster and live longer, reaching far behind the ship. As it decelerates out of hyperspace
  // the caller eases trailScale to 1, SHORTENING the beam — but emission never stops.
  const lenK = Math.max(1, trailScale);

  // During a warp-OUT jump the ship snaps forward HUGE distances per frame, so spawning every
  // streak at the current nozzle would leave gaps. We distribute this frame's spawns evenly
  // along the path travelled (prevEmitter -> emitter) so the beam stays continuous.
  const prev = ud.prevEmit;
  const haveSeg = warpJump && prev && prev.set !== undefined && prev.has;

  // --- Emit: rate scales with throttle so a hard burn streams more, idle barely puffs. ---
  // High base rate so consecutive streaks overlap into a continuous beam with no gaps.
  // Warp-out covers a lot of ground per frame, so emit a denser burst to fill the segment.
  // During warp (engineWarp/warpJump) the nozzles are always blazing, so keep a high constant
  // floor. In NORMAL flight, emission is fully throttle-driven: a ship that isn't burning (speed01
  // near 0, e.g. an enemy coasting at steady velocity) emits NOTHING, so there's no exhaust trail
  // when it isn't accelerating. As throttle rises the plume gets heavier.
  let rate;
  if (warpJump) {
    rate = (110 + speed01 * 150) * Math.min(2, lenK) * 2.4;
  } else {
    // Below a small throttle the engine reads as idle/coasting and stops streaming entirely
    // (rate 0 -> no exhaust). Above it, emission ramps with throttle for a heavier plume.
    const t = speed01 < 0.06 ? 0 : speed01;
    rate = t === 0 ? 0 : (40 + t * 220) * Math.min(2, lenK);
  }
  ud.emitAccum += rate * dt;
  let toEmit = Math.floor(ud.emitAccum);
  ud.emitAccum -= toEmit;
  const total = Math.max(1, toEmit);
  const driftBack = (7 + speed01 * 18) * lenK * lenScale;
  let n = 0;
  while (toEmit-- > 0) {
    const p = st[ud.next];
    ud.next = (ud.next + 1) % st.length;
    // Spawn position: along the travelled segment during warp-out, else at the nozzle.
    let f = haveSeg ? (n + Math.random()) / total : 0;
    p.x = emitterWorld.x + (haveSeg ? (prev.x - emitterWorld.x) * f : 0);
    p.y = emitterWorld.y + (haveSeg ? (prev.y - emitterWorld.y) * f : 0);
    p.z = emitterWorld.z + (haveSeg ? (prev.z - emitterWorld.z) * f : 0);
    // Velocity: inherit the SHIP'S world velocity so the streak travels WITH the ship and
    // stays parked behind it, then add a backward drift along the tail axis and a little
    // spread. Without the ship-velocity term the streaks freeze in world space and, as the
    // ship turns, smear off the side or in front of the nose. (Warp passes shipVel=0 and
    // relies on its own segment-fill logic.)
    const spread = 0.5 + speed01 * 0.5;
    p.vx = shipVel.x + back.x * driftBack + (Math.random() - 0.5) * spread;
    p.vy = shipVel.y + back.y * driftBack + (Math.random() - 0.5) * spread;
    p.vz = shipVel.z + back.z * driftBack + (Math.random() - 0.5) * spread;
    // Render axis = the tail direction at spawn, kept independent of the motion velocity so
    // the beam always visually points down the exhaust instead of along (shipVel+drift).
    p.ax = back.x; p.ay = back.y; p.az = back.z;
    p.age = 0;
    p.life = _PUFF_LIFE * (0.7 + Math.random() * 0.6) * Math.min(2.2, lenK) * lenScale;
    p.size = (0.30 + speed01 * 0.22) * (0.85 + Math.random() * 0.3);  // beam half-WIDTH (thicker)
    p.len = (1.9 + speed01 * 1.8) * (0.85 + Math.random() * 0.4) * lenScale;     // beam LENGTH base (longer overlap)
    n++;
  }

  // Remember this frame's emitter world position so next frame can fill the travelled segment.
  if (!ud.prevEmit) ud.prevEmit = { x: 0, y: 0, z: 0, has: false, set: true };
  ud.prevEmit.x = emitterWorld.x; ud.prevEmit.y = emitterWorld.y; ud.prevEmit.z = emitterWorld.z;
  ud.prevEmit.has = true;

  // --- Advance + build camera-facing elongated quads ---
  for (let i = 0; i < st.length; i++) {
    const p = st[i];
    const o = i * 4 * 3, ao = i * 4;
    if (p.age >= p.life) {
      // Dead: collapse to zero alpha (positions irrelevant when alpha is 0).
      aa[ao] = aa[ao + 1] = aa[ao + 2] = aa[ao + 3] = 0;
      continue;
    }
    p.age += dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    // Light drag only — heavy drag would scrub off the inherited ship velocity within the
    // streak's short life, letting the ship outrun its own exhaust and smear the beam again.
    const drag = Math.pow(0.7, dt);
    p.vx *= drag; p.vy *= drag; p.vz *= drag;
    const k = p.age / p.life;                     // 0 fresh -> 1 dead (fade begins at spawn)
    const a = Math.max(0, 1 - k) * (0.7 + speed01 * 0.3);

    // Beam axis = the streak's stored tail direction (so it always points down the exhaust,
    // not along ship-velocity+drift); width axis = perpendicular to axis AND view dir so the
    // quad always faces the camera while staying oriented down the exhaust. Warp streaks have
    // no stored axis and fall back to their motion velocity.
    _bm.pos.set(p.x, p.y, p.z);
    if (p.ax !== undefined) {
      _bm.axis.set(p.ax, p.ay, p.az);
    } else {
      _bm.axis.set(p.vx, p.vy, p.vz);
    }
    if (_bm.axis.lengthSq() < 1e-6) _bm.axis.copy(back);
    _bm.axis.normalize();
    _bm.view.subVectors(camPos, _bm.pos).normalize();
    _bm.side.crossVectors(_bm.axis, _bm.view);
    if (_bm.side.lengthSq() < 1e-6) _bm.side.set(1, 0, 0);
    _bm.side.normalize();

    // Length grows a touch as it ages (streak stretches as it dissipates); width tapers.
    const halfLen = p.len * (0.7 + k * 0.8) * lenK;
    const halfW = p.size * (1 - k * 0.4);
    // Anchor the streak's FRONT edge at the spawn point and grow it BACKWARD (toward the
    // tail), so the beam never poke forward over the engine housing. The exhaust velocity
    // (axis) points away from the ship, so the back direction is +axis.
    _bm.pos.addScaledVector(_bm.axis, halfLen);    // shift center back by halfLen
    _bm.axis.multiplyScalar(halfLen);
    _bm.side.multiplyScalar(halfW);

    // 4 corners: (-L-W, +L-W, +L+W, -L+W) matching the static UVs set at build time.
    _bm.a.copy(_bm.pos).sub(_bm.axis).sub(_bm.side);
    _bm.b.copy(_bm.pos).add(_bm.axis).sub(_bm.side);
    _bm.c.copy(_bm.pos).add(_bm.axis).add(_bm.side);
    _bm.d.copy(_bm.pos).sub(_bm.axis).add(_bm.side);
    pa[o] = _bm.a.x; pa[o + 1] = _bm.a.y; pa[o + 2] = _bm.a.z;
    pa[o + 3] = _bm.b.x; pa[o + 4] = _bm.b.y; pa[o + 5] = _bm.b.z;
    pa[o + 6] = _bm.c.x; pa[o + 7] = _bm.c.y; pa[o + 8] = _bm.c.z;
    pa[o + 9] = _bm.d.x; pa[o + 10] = _bm.d.y; pa[o + 11] = _bm.d.z;
    aa[ao] = aa[ao + 1] = aa[ao + 2] = aa[ao + 3] = a;
  }
  posAttr.needsUpdate = true; alphaAttr.needsUpdate = true;
}

// Draw a long, bright, straight engine streak welded to the emitter and trailing back
// along `back` (the ship's nose-to-tail axis). Used during lightspeed jumps where the
// ship snaps forward so far per frame that the normal history ribbon collapses. The
// ribbon is camera-billboarded (faces the viewer) and tapers/fades toward the tail.
function buildWarpStreak(trail, camera, emitter, back) {
  const seg = trail.userData.maxLen;
  const pos = trail.geometry.attributes.position;
  const alpha = trail.geometry.attributes.alpha;
  const camPos = camera.position;
  const len = 70;                                  // streak length in world units
  const width = trail.userData.width * 1.4;        // a touch wider than the normal trail
  const dir = back.clone().normalize();
  const up = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const hp = new THREE.Vector3();
  for (let i = 0; i < seg; i++) {
    const k = i / (seg - 1);                        // 0 at engine -> 1 at tail
    hp.copy(emitter).addScaledVector(dir, len * k);
    toCam.subVectors(camPos, hp).normalize();
    up.crossVectors(dir, toCam).normalize().multiplyScalar(width * (1 - k * 0.85));
    const a = i * 2 * 3, b = (i * 2 + 1) * 3;
    pos.array[a] = hp.x + up.x; pos.array[a + 1] = hp.y + up.y; pos.array[a + 2] = hp.z + up.z;
    pos.array[b] = hp.x - up.x; pos.array[b + 1] = hp.y - up.y; pos.array[b + 2] = hp.z - up.z;
    // Bright at the nozzle, fading down the streak; stays strong for a vivid lightspeed flare.
    const fade = Math.pow(1 - k, 1.1) * 0.95;
    alpha.array[i * 2] = fade; alpha.array[i * 2 + 1] = fade;
  }
  pos.needsUpdate = true; alpha.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Speed-debris field (X-Wing vs TIE Fighter style "motes").
//
// A small cloud of faint specks that live in a box AROUND the player. They don't
// actually move on their own; instead, each frame we slide every mote OPPOSITE the
// ship's velocity, so from the cockpit / chase cam they appear to rush past — the
// classic trick that sells motion when the empty starfield gives no parallax. Motes
// that pass behind the ship (or stray too far) are recycled to a fresh spot back out
// ahead/around, so the field is effectively infinite and persistent.
//
// Rendered as LineSegments: each mote is a 2-vertex segment whose length stretches
// with speed (a dot when slow, a short streak when fast). Additive + depth-write off
// so they read as light, never occluding the ship or each other.
const DEBRIS_COUNT = 220;     // number of motes
const DEBRIS_BOX = 90;        // half-size of the cube the motes occupy around the ship
export function makeDebrisField() {
  const positions = new Float32Array(DEBRIS_COUNT * 2 * 3); // 2 verts per mote
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xbcd0e8,
    transparent: true,
    opacity: 0,                // starts invisible; faded in by speed each frame
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 1;
  // Per-mote world anchor points (head of the streak). Seeded randomly across the box.
  const motes = [];
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    motes.push(new THREE.Vector3(
      (Math.random() - 0.5) * 2 * DEBRIS_BOX,
      (Math.random() - 0.5) * 2 * DEBRIS_BOX,
      (Math.random() - 0.5) * 2 * DEBRIS_BOX
    ));
  }
  lines.userData = { motes, seeded: false };
  return lines;
}

const _dbgScratch = { rel: new THREE.Vector3(), dir: new THREE.Vector3(), tail: new THREE.Vector3() };
// Advance the debris field one frame. shipPos = player world position, shipVel = player
// world velocity (units/s), speed01 = 0..1 throttle for fade/length. The motes are kept
// centered on the ship; any that fall behind the travel direction or drift outside the
// box are respawned on the FAR side so they stream toward the camera again.
export function updateDebrisField(field, shipPos, shipVel, speed01, dt) {
  if (!field) return;
  const motes = field.userData.motes;
  const pos = field.geometry.attributes.position;
  const arr = pos.array;
  const speed = shipVel.length();
  // On first run (or after a teleport/warp) recenter the whole field on the ship so motes
  // don't all visibly fly in from one corner.
  if (!field.userData.seeded) {
    for (let i = 0; i < motes.length; i++) {
      motes[i].set(
        shipPos.x + (Math.random() - 0.5) * 2 * DEBRIS_BOX,
        shipPos.y + (Math.random() - 0.5) * 2 * DEBRIS_BOX,
        shipPos.z + (Math.random() - 0.5) * 2 * DEBRIS_BOX
      );
    }
    field.userData.seeded = true;
  }
  // Fade in with speed so a hovering ship shows almost nothing (no distraction), and a hard
  // burn shows a busy field. Eased so even modest cruise reads as motion.
  const targetOpacity = THREE.MathUtils.clamp(speed01 * 1.6, 0, 0.85);
  field.material.opacity += (targetOpacity - field.material.opacity) * Math.min(1, dt * 8);

  // Travel direction (where the ship is heading). Motes are considered "spent" once they
  // pass behind this direction relative to the ship. We SMOOTH this direction frame-to-frame:
  // when the player swings the nose around, the raw velocity vector can rotate fast, and if the
  // streaks/recycling tracked it instantly the motes would visibly snap to new directions
  // ("wild" motion). Easing it makes the field swing gently with the turn instead.
  const dir = _dbgScratch.dir;
  if (speed > 1e-3) dir.copy(shipVel).multiplyScalar(1 / speed);
  else dir.set(0, 0, -1);
  if (!field.userData.smoothDir) field.userData.smoothDir = dir.clone();
  const sdir = field.userData.smoothDir;
  // Slerp-ish ease toward the live direction, then renormalize.
  sdir.lerp(dir, Math.min(1, dt * 4));
  if (sdir.lengthSq() > 1e-6) sdir.normalize(); else sdir.copy(dir);
  dir.copy(sdir);
  // Streak length: a dot at rest, stretching with speed for a sense of velocity.
  const streakLen = 0.35 + speed01 * 6.5;

  for (let i = 0; i < motes.length; i++) {
    const m = motes[i];
    // Slide the mote opposite ship motion so it appears to rush past the cockpit.
    m.addScaledVector(shipVel, -dt);

    // Recycle: if the mote is outside the box around the ship, OR has passed behind the
    // ship along the travel direction, respawn it on the FAR (ahead) side so it streams in.
    const rel = _dbgScratch.rel.subVectors(m, shipPos);
    const ahead = rel.dot(dir);
    if (rel.lengthSq() > DEBRIS_BOX * DEBRIS_BOX * 1.2 || ahead < -DEBRIS_BOX * 0.65) {
      // Place ahead of the ship, scattered across the perpendicular plane.
      m.copy(shipPos)
        .addScaledVector(dir, DEBRIS_BOX * (0.55 + Math.random() * 0.45))
        .add(_tmpScatter(DEBRIS_BOX));
    }

    // Build the 2-vertex streak: head at the mote, tail trailing back opposite travel.
    const tail = _dbgScratch.tail.copy(m).addScaledVector(dir, -streakLen);
    const a = i * 2 * 3, b = a + 3;
    arr[a] = m.x; arr[a + 1] = m.y; arr[a + 2] = m.z;
    arr[b] = tail.x; arr[b + 1] = tail.y; arr[b + 2] = tail.z;
  }
  pos.needsUpdate = true;
}
const _scatterV = new THREE.Vector3();
function _tmpScatter(box) {
  return _scatterV.set(
    (Math.random() - 0.5) * 2 * box,
    (Math.random() - 0.5) * 2 * box,
    (Math.random() - 0.5) * 2 * box
  );
}
// Force the debris field to recenter on the ship next update (used after warp jumps so
// motes don't streak in from the old position).
export function reseedDebrisField(field) { if (field) field.userData.seeded = false; }

// URLs for the crimson enemy starfighter GLBs used by the opening cutscene.
export const ENEMY_FIGHTER_URLS = [
  'assets/starfighters/meshy_ai_crimson_starfighter_0610223402_texture.glb',
  'assets/starfighters/meshy_ai_crimson_vortex_gunshi_0610223218_texture.glb'
];

// Map a fighter GLB url back to its enemy "kind" so external callers (e.g. the opening
// cutscene) can look up the right calibrated exhaust/muzzle layout for a hull.
const URL_TO_ENEMY_KIND = {
  'assets/starfighters/meshy_ai_crimson_starfighter_0610223402_texture.glb': 'interceptor',
  'assets/starfighters/meshy_ai_crimson_vortex_gunshi_0610223218_texture.glb': 'bomber',
  'assets/starfighters/phaserdrone.glb': 'drone',
  'assets/starfighters/enemysf.glb': 'fighter'
};

// Attach the SAME calibrated red engine exhaust gameplay enemies use to an already-loaded
// cutscene/cinematic fighter group `g`. `modelGroup` is the inner oriented+scaled model (the
// onReady arg from loadFighterModel), `url` selects the per-hull nozzle layout, and `L` is the
// model length the fighter was loaded at so the tail anchoring matches its on-screen size.
// `trailGroup`, if given, is where the world-space streaks parent (so they follow correctly).
export function attachEnemyExhaust(g, modelGroup, url, L, trailGroup = null) {
  if (trailGroup) g.userData.trailGroup = trailGroup;
  const kind = URL_TO_ENEMY_KIND[url] || 'interceptor';
  const layout = ENEMY_EXHAUST_MOUNTS[kind] || ENEMY_EXHAUST_MOUNTS._default;
  const mounts = tailFromModel(modelGroup, layout, L);
  attachEngineEffects(g, mounts, 'red');
}

// Preload the heavy GLB models (and let the caller report progress) so the loading
// screen can finish before any cutscene/gameplay starts. Resolves a map of url->gltf
// that loadFighterModel / makePlayerShip benefit from via the loader's internal cache.
export function preloadModels(onProgress) {
  // Dedupe (some URLs appear in more than one list); loadGLBCached also dedupes by URL.
  const urls = [...new Set([PLAYER_MODEL_URL, ...ENEMY_FIGHTER_URLS, ...Object.values(ENEMY_MODEL_URLS), ...CAPITAL_MODEL_URLS, ...Object.values(ALLY_CAPITAL_URLS), ALLY_MODEL_URLS.slick, ALLY_MODEL_URLS.og])];
  let loaded = 0;
  // Route through the shared cached/sequential loader. Because these populate the
  // cache, later makePlayerShip / loadFighterModel calls resolve instantly without
  // re-downloading. Progress is reported as each (serialized) load settles.
  return Promise.all(urls.map(url => loadGLBCached(url)
    .catch((err) => { console.warn('preloadModels: failed to load', url, err); return null; })
    .then((res) => {
      loaded++;
      if (onProgress) onProgress(loaded / urls.length, url);
      return { url, ok: !!res };
    })
  ));
}

// Lightweight audio preloader: resolves once each clip can play through (or errors out).
export function preloadAudio(urls, onProgress) {
  let done = 0;
  return Promise.all(urls.map(src => new Promise(resolve => {
    const a = new Audio();
    // Guard so each clip counts EXACTLY once. canplaythrough/error/timeout can all fire for
    // the same clip; without this latch the safety timeout re-increments an already-loaded
    // clip, pushing progress past 100% (the "LOADING ASSETS 130%" bug).
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done++;
      if (onProgress) onProgress(done / urls.length, src);
      resolve(src);
    };
    a.addEventListener('canplaythrough', finish, { once: true });
    a.addEventListener('error', finish, { once: true });
    a.preload = 'auto';
    a.src = src;
    // Safety timeout so a stalled clip never blocks the loading screen forever.
    timer = setTimeout(finish, 6000);
  })));
}

// Load and normalize a starfighter GLB into a group whose nose points -Z, scaled to
// targetLen units. Calls onReady(group) when the model is in place. Reuses the same
// orientation logic as the player ship so all craft share a consistent forward axis.
export function loadFighterModel(url, targetLen, onReady) {
  const g = new THREE.Group();
  const placeholder = makePlaceholderShip();
  g.add(placeholder);
  getModelClone(url).then((model) => {
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const box0 = new THREE.Box3().setFromObject(model);
    const size = box0.getSize(new THREE.Vector3());
    const center = box0.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const longest = Math.max(size.x, size.y, size.z);
    model.scale.multiplyScalar(targetLen / longest);
    const wrap = new THREE.Group();
    wrap.add(model);
    orientShipForward(wrap, model, url);
    g.remove(placeholder);
    g.add(wrap);
    g.userData.modelReady = true;
    // Place exhaust/muzzle mounts FIRST (they measure the model's bounding box to anchor the
    // tail/nose on Z), then apply any purely-cosmetic orientation correction so the visible mesh
    // faces the right way WITHOUT disturbing those already-calibrated mount positions.
    if (onReady) onReady(g);
    const override = MODEL_ORIENT_OVERRIDES[url];
    if (override && override.postYaw) wrap.rotation.y += override.postYaw;
  }).catch((err) => {
    console.warn('Enemy fighter model failed to load, using placeholder.', url, err);
    g.userData.modelReady = true;
    if (onReady) onReady(g);
  });
  return g;
}

// Place the engine exhaust nozzles at the loaded+oriented model's ACTUAL tail, measured from its
// bounding box. The ship flies and shoots nose-first down -Z (confirmed in play), so the tail is
// the +Z end — that part is solid. The bug these hulls showed was LATERAL: the exhaust streamed
// out a flank, not the back.
//
// Root cause of the side-exhaust: these are WIDE-WING hulls. After the model is scaled so its
// longest axis (the WINGSPAN, on X) fits the target length L, the actual FUSELAGE is much shorter
// than L, and the half-width measured from the box is dominated by the wings. The artist spread
// fractions (e.g. ±0.16·L) were tuned against the nominal length, but on a wide hull that pushed
// the twin nozzles outboard onto the wing roots/leading edges — so the trails read as coming from
// the side. Fix: clamp the lateral spread to a small fraction of the MEASURED fuselage half-width
// near the tail rather than a fraction of L, and pin the tail Z to the real +Z extent. This keeps
// the nozzles tight on the centerline at the genuine back of the hull on every hull proportion.
const _tailBox = new THREE.Box3();
const _tailSize = new THREE.Vector3();
const _genBox = new THREE.Box3();   // scratch box for measuring the capital deck height for shield gens
function tailFromModel(modelGroup, layout, L) {
  modelGroup.updateMatrixWorld(true);
  _tailBox.setFromObject(modelGroup);
  if (!isFinite(_tailBox.max.z)) {
    // Degenerate box (model not measurable): fall back to the literal layout on Z.
    return layout.map((entry) => {
      const m = normMount(entry); const [fx, fy, fz] = m.pos;
      return { pos: new THREE.Vector3(fx * L, fy * L, (fz || 0.30) * L), rot: m.rot };
    });
  }
  _tailBox.getSize(_tailSize);
  // True tail = +Z extent. We DON'T trust the raw box corner alone: on wide-wing hulls a wing's
  // trailing edge can sit forward of the fuselage tail (or a fin can poke past it), so the corner
  // is an unreliable single sample. Blend the measured +Z extent with a guaranteed-aft fraction of
  // the model's own Z-depth so the anchor always lands at the genuine rear of the fuselage and a
  // touch inside the nozzle mouths, never forward on the body.
  const halfDepth = _tailSize.z * 0.5;
  const tailZ = Math.max(_tailBox.max.z * 0.88, halfDepth * 0.82);
  // The half-width of the WHOLE box includes the wings; the fuselage at the tail is far narrower.
  // Cap the usable spread to a modest fraction of the measured half-width so twin nozzles stay on
  // the engine block near the centerline instead of riding out onto the wings.
  const halfW = _tailSize.x * 0.5;
  const maxSpread = Math.min(halfW * 0.30, L * 0.12);
  return layout.map((entry) => {
    const m = normMount(entry);
    const [fx, fy, fz] = m.pos;
    if (m.fixed) {
      // Explicit object layout (dev-calibrated): trust the literal pos exactly, no tail-Z snap
      // or lateral clamp — the artist already placed it on the real model in the P rig.
      return { pos: new THREE.Vector3(fx * L, fy * L, (fz || 0) * L), rot: m.rot };
    }
    // Legacy bare-array layout: preserve the SIGN/relative ordering but clamp the magnitude so
    // wide hulls can't fling the nozzles outboard, and snap Z onto the measured tail.
    const x = THREE.MathUtils.clamp(fx * L, -maxSpread, maxSpread);
    return { pos: new THREE.Vector3(x, fy * L, tailZ), rot: m.rot };
  });
}

// Mirror of tailFromModel for GUN MUZZLES: anchor the cannon points to the model's ACTUAL nose
// (its real -Z bounding-box extent) so bolts leave from the front of the hull regardless of how
// the GLB's wingspan skews the nominal length. X is clamped to the measured fuselage half-width
// the same way, Y is a straight fraction of L. Returns bare Vector3s in the ship-group local frame.
const _noseBox = new THREE.Box3();
const _noseSize = new THREE.Vector3();
function noseFromModel(modelGroup, layout, L) {
  modelGroup.updateMatrixWorld(true);
  _noseBox.setFromObject(modelGroup);
  const measurable = isFinite(_noseBox.min.z);
  if (measurable) _noseBox.getSize(_noseSize);
  const halfDepth = measurable ? _noseSize.z * 0.5 : 0;
  // True nose = -Z extent; blend with a guaranteed-forward fraction so a swept wing can't drag it back.
  const noseZ = measurable ? Math.min(_noseBox.min.z * 0.92, -halfDepth * 0.82) : -0.40 * L;
  const halfW = measurable ? _noseSize.x * 0.5 : L;
  const maxSpread = Math.min(halfW * 0.5, L * 0.22);   // guns can sit a little wider than engines
  return layout.map((entry) => {
    const m = normMount(entry);
    const [fx, fy, fz] = m.pos;
    if (m.fixed) {
      // Explicit object layout (orientation-rig calibrated): trust the literal pos exactly, no
      // nose-Z snap or lateral clamp — the marker was placed on the real model in the O rig.
      return new THREE.Vector3(fx * L, fy * L, (fz || 0) * L);
    }
    // Legacy bare-array layout: clamp the lateral spread and snap Z onto the measured nose.
    const x = THREE.MathUtils.clamp(fx * L, -maxSpread, maxSpread);
    return new THREE.Vector3(x, fy * L, noseZ);
  });
}

// Create small empty marker groups at each muzzle position and store them on g.userData.muzzles.
// They're parented to the ship group, so muzzle.getWorldPosition() gives the live world muzzle as
// the enemy banks and turns — exactly how the player and turret muzzles work.
function attachMuzzles(g, muzzlePoints) {
  const list = [];
  for (const local of muzzlePoints) {
    const m = new THREE.Group();
    m.position.copy(local);
    g.add(m);
    list.push(m);
  }
  g.userData.muzzles = list;
}

export function makeEnemy(kind, position, trailGroup = null) {
  const g = new THREE.Group();
  // World-space group for the engine exhaust streaks (so they're not double-transformed by
  // the moving enemy's matrix). Falls back to local if none supplied.
  if (trailGroup) g.userData.trailGroup = trailGroup;
  // Buffed fighter HP so enemy starfighters are no longer trivial to kill. Capital ships are
  // hugely tankier and MASSIVE on screen — big enough that fighters can fly into their bays.
  const cfg = {
    interceptor: { hp: 120, speed: 18, scale: 1, len: 4.6 },
    fighter:     { hp: 135, speed: 17, scale: 1.05, len: 4.8 },
    bomber:      { hp: 240, speed: 10, scale: 1.55, len: 6.2 },
    drone:       { hp: 80,  speed: 24, scale: .72, len: 3.4 },
    capital:     { hp: 4200, speed: 2, scale: 7.5, len: 260 }
  }[kind];

  if (kind === 'capital') {
    // Massive capital ship from a dedicated hull GLB. Scaled to ~260 units long so it dwarfs
    // the fighters and its launch bays are large enough for squadrons to fly out of.
    // DETERMINISTIC HULL: the Mission 2 "DREADNOUGHT" boss — its targeting name, raycast-seated
    // shield generators, exhaust/muzzle mounts, and turret placement are all tuned against
    // dreadnaught-2.glb. Forcing it (index 0) keeps every capital playthrough consistent instead
    // of randomly falling back to vanguard.glb, where the seated attachments were never calibrated.
    const modelUrl = CAPITAL_MODEL_URLS[0];
    const model = loadFighterModel(modelUrl, cfg.len);
    g.add(model);
    g.userData.model = model;
    // Big red engine exhaust at the carrier's thruster bank (per the rear-view reference). The
    // nozzle blobs are scaled way up (effectScale) to match the 130-unit hull, and the streak
    // puffs are lengthened/widened per-frame via a capital trailScale in main.js.
    const CL = cfg.len;
    const capMounts = (CAPITAL_EXHAUST_MOUNTS[modelUrl] || CAPITAL_EXHAUST_MOUNTS._default)
      .map(([fx, fy, fz]) => new THREE.Vector3(fx * CL, fy * CL, fz * CL));
    attachEngineEffects(g, capMounts, 'red', CL * 0.05);
    // Bow gun muzzles for the carrier's main batteries (fractions of capital length CL).
    attachMuzzles(g, (CAPITAL_MUZZLE_MOUNTS[modelUrl] || CAPITAL_MUZZLE_MOUNTS._default)
      .map(([fx, fy, fz]) => new THREE.Vector3(fx * CL, fy * CL, fz * CL)));
    // ---- Two destructible SHIELD GENERATORS bolted to the dorsal hull (fore + aft) -------------
    // While either is alive the hull shrugs off damage (deflection); both down = the hull is soft.
    // Each generator is SEATED on the real hull surface via a downward raycast at its X/Z mount, so
    // its base sits flush on the deck (not floating) and is oriented to the local surface normal.
    g.userData.shieldGens = [];
    g.userData.modelHolder = model;
    const genScale = 0.02 * CL;
    // Mount points as fractions of length: centered on the spine, fore + aft of the superstructure.
    const genMounts = [
      new THREE.Vector3(0, 0,  0.14 * CL),   // forward dorsal
      new THREE.Vector3(0, 0, -0.20 * CL)    // aft dorsal
    ];
    const placeGens = (mg) => { seatShieldGenerators(g, mg, genMounts, genScale); };
    if (model.userData.modelReady) placeGens(model);
    else {
      const iv = setInterval(() => {
        if (model.userData.modelReady) { clearInterval(iv); placeGens(model); }
      }, 60);
      setTimeout(() => clearInterval(iv), 6000);
    }
    // The energy shield dome enveloping the hull. Its radius spans the hull; intensity is driven
    // each frame from main.js by how many generators are still alive (full / 50% / off).
    const shieldRadius = CL * 0.62;
    // baseMul:0 → the dome is COMPLETELY INVISIBLE at rest and only blooms where it absorbs a hit.
    const shieldDome = makeShieldDome(shieldRadius, { baseMul: 0 });
    g.add(shieldDome);
    g.userData.shieldDome = shieldDome;
    // Expose the dome radius so the gameplay code can intercept incoming fire AT the shield surface
    // (not at the hull), making shots visibly absorb into the bubble where they cross it.
    g.userData.shieldRadius = shieldRadius;
  } else {
    // Real 3D fighter/bomber/drone model (oriented nose -Z, scaled to a sensible length).
    const modelUrl = ENEMY_MODEL_URLS[kind] || ENEMY_MODEL_URLS.interceptor;
    const L = cfg.len;
    const layout = ENEMY_EXHAUST_MOUNTS[kind] || ENEMY_EXHAUST_MOUNTS._default;
    // CRITICAL: attach the exhaust ONLY after the model is oriented + scaled, and anchor the
    // nozzles to the model's ACTUAL geometric tail (its real +Z bounding-box extent), not a fixed
    // fraction of the nominal length L. Wide-winged hulls scale so their wingspan — not the
    // fuselage — is the longest axis, so the old `fz * L` overshot the short fuselage and the
    // exhaust ended up beside/ahead of the hull. tailFromModel() pins Z to the genuine tail.
    const muzzleLayout = ENEMY_MUZZLE_MOUNTS[kind] || ENEMY_MUZZLE_MOUNTS._default;
    const model = loadFighterModel(modelUrl, L, (mg) => {
      const mounts = tailFromModel(mg, layout, L);
      attachEngineEffects(g, mounts, 'red');
      // Anchor gun muzzles to the model's real nose, mirroring the exhaust's tail anchoring.
      attachMuzzles(g, noseFromModel(mg, muzzleLayout, L));
    });
    g.add(model);
    g.userData.model = model;
  }

  g.position.copy(position);
  g.userData = Object.assign(g.userData, {
    kind, hp: cfg.hp, maxHp: cfg.hp, speed: cfg.speed,
    radius: (kind === 'capital' ? 110 : 1.5) * (kind === 'capital' ? 1 : cfg.scale),
    fireT: Math.random() * 2, phase: Math.random() * 9,
    // Dogfight AI state. vel is the craft's current velocity; behavior cycles through pursue /
    // strafe / evade so enemies bank and reposition instead of flying dead-straight at the
    // player. jink* are slowly-rotating offsets that give each ship its own weave.
    vel: new THREE.Vector3(),
    behavior: 'pursue',
    behaviorT: 0.6 + Math.random() * 1.2,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    jinkPhase: Math.random() * Math.PI * 2,
    jinkRate: 0.7 + Math.random() * 0.8,
    // ---- Engagement commitment state ----
    // `engaged` = currently committed to attacking the player and may not disengage. A fighter
    // re-engages with rising probability the farther out it drifts (auto at 600m+). Once engaged it
    // stays locked in until it has actually FIRED at the player (hasFiredSinceEngage), after which
    // only a small random chance per re-roll lets it break off again.
    engaged: true,
    hasFiredSinceEngage: false,
    // ---- Missiles & countermeasures ----
    // Only SOME fighter types carry missiles, and even then only a fraction of spawns are armed,
    // so the player faces occasional missile threats rather than constant ones. Bombers always
    // carry them (they're the heavy strike craft); interceptors/fighters sometimes do; drones
    // never do. Every fighter carries 2 chaff to spoof the player's missiles.
    missiles: kind === 'bomber' ? 3 : ((kind === 'interceptor' || kind === 'fighter') && Math.random() < 0.4 ? 2 : 0),
    chaff: kind === 'capital' ? 0 : 2,
    missileT: 3 + Math.random() * 4,   // cooldown before this ship may launch a missile
  });
  if (kind === 'capital') {
    // Launch-bay anchors (local space) the carrier scrambles squadrons from when attacked.
    // Positioned along the flanks/belly of the hull where the open bays are; spawned fighters
    // appear here and fly out. underAttackT/launchCd drive the scramble logic in main.js.
    const L = cfg.len;
    // Eight launch-bay anchors (local space): FOUR down each flank, staggered fore-to-aft so a
    // full squadron parks inside the hangars (4 per side) and spills out along the hull when
    // scrambled. Index order alternates left/right so launches read as both bays firing together.
    g.userData.bays = [
      new THREE.Vector3(-0.17 * L, 0.02 * L,  0.16 * L),   // left, fore
      new THREE.Vector3( 0.17 * L, 0.02 * L,  0.16 * L),   // right, fore
      new THREE.Vector3(-0.17 * L, 0.02 * L,  0.04 * L),   // left, mid-fore
      new THREE.Vector3( 0.17 * L, 0.02 * L,  0.04 * L),   // right, mid-fore
      new THREE.Vector3(-0.17 * L, -0.04 * L, -0.08 * L),  // left, mid-aft
      new THREE.Vector3( 0.17 * L, -0.04 * L, -0.08 * L),  // right, mid-aft
      new THREE.Vector3(-0.17 * L, -0.04 * L, -0.20 * L),  // left, aft
      new THREE.Vector3( 0.17 * L, -0.04 * L, -0.20 * L)   // right, aft
    ];
    g.userData.launchCd = 4 + Math.random() * 2;   // seconds between squadron launches
    g.userData.lastHp = cfg.hp;                     // track damage to detect "under attack"
    g.userData.aggroT = 0;                          // remaining "under attack" window

    // ---- Point-defense turret emplacements -------------------------------------------------
    // A spread of independently-aiming gun turrets bristling along the hull. Each turret is a
    // small swiveling head on a base, mounted at a hull anchor with a default "rest" facing (its
    // outward normal). main.js steers each turret head to track the player within its firing arc,
    // fires from its barrels, and can have it individually destroyed.
    // SEATING: turrets are planted on the REAL hull via raycast (attachCapitalTurrets), AFTER the
    // GLB is measured — so they sit flush on the deck/flanks/belly instead of floating at fixed
    // fractions of the nominal length L (the old "turrets hover over the hull" bug).
    g.userData.turrets = [];
    const seatTurrets = (mg) => { attachCapitalTurrets(g, mg, L); };
    if (g.userData.model.userData.modelReady) seatTurrets(g.userData.model);
    else {
      const tiv = setInterval(() => {
        if (g.userData.model.userData.modelReady) { clearInterval(tiv); seatTurrets(g.userData.model); }
      }, 60);
      setTimeout(() => clearInterval(tiv), 6000);
    }
  }
  return g;
}

// ---- Tutorial target containers ----------------------------------------------------------------
// Four destructible CARGO CONTAINER GLBs used as stationary target practice in the interactive
// flight-controls tutorial. They are NOT ships: no AI, no engines, no fire. Each is a drifting
// hulk the player shoots to learn aiming/firing/locking before live fighters warp in.
export const CONTAINER_MODEL_URLS = [
  'assets/containers/container5-compressed.glb',
  'assets/containers/container6-compressed.glb',
  'assets/containers/container7-compressed.glb',
  'assets/containers/container8-compressed.glb'
];
// Build one stationary cargo container target. `len` controls its on-screen size; `hp` how many
// hits it soaks. It plugs into the gameplay enemy pipeline (it lives in the `enemies` group) so
// the existing bolt-hit test, missile lock, and killEnemy explosion all work on it unchanged — a
// `kind: 'container'` tag lets the AI/mission code skip it as a non-combatant.
export function makeContainer(position, opts = {}) {
  const { len = 14, hp = 90, urlIndex = null, spin = true } = opts;
  const g = new THREE.Group();
  const url = (urlIndex != null)
    ? CONTAINER_MODEL_URLS[urlIndex % CONTAINER_MODEL_URLS.length]
    : CONTAINER_MODEL_URLS[Math.floor(Math.random() * CONTAINER_MODEL_URLS.length)];
  // Reuse the fighter loader's scale-to-length + placeholder handling, but DON'T orient it as a
  // ship — a container has no nose. We just measure and scale it to `len` here.
  const inner = new THREE.Group();
  const placeholder = makePlaceholderShip();
  inner.add(placeholder);
  getModelClone(url).then((model) => {
    model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const longest = Math.max(size.x, size.y, size.z) || 1;
    model.scale.multiplyScalar(len / longest);
    inner.remove(placeholder);
    inner.add(model);
    g.userData.modelReady = true;
  }).catch((err) => {
    console.warn('Container model failed to load, using placeholder.', url, err);
    g.userData.modelReady = true;
  });
  g.add(inner);
  g.position.copy(position);
  // A gentle random tumble so the hulks feel adrift in space rather than nailed in place.
  const spinAxis = new THREE.Vector3().randomDirection();
  g.userData = Object.assign(g.userData, {
    kind: 'container',
    hp, maxHp: hp,
    radius: len * 0.5,
    // Stationary: zero velocity so the shared trail/AI helpers treat it as parked. No engines.
    vel: new THREE.Vector3(),
    // Slow idle tumble applied each frame in main.js's updateEnemies container branch.
    spinAxis, spinRate: spin ? (0.05 + Math.random() * 0.12) : 0,
    // Tutorial containers never fire and carry no countermeasures.
    missiles: 0, chaff: 0,
    isContainer: true
  });
  return g;
}

// ---- Allied ("good guy") ship factory ----------------------------------------------------------
// Builds a friendly fighter or the allied flagship. Mirrors makeEnemy but with the player's BLUE
// engine palette and an AI state block geared toward hunting hostiles (handled in main.js). The
// allied flagship reuses the destructible-turret rig so it visibly defends itself.
export function makeAlly(kind, position, trailGroup = null) {
  const g = new THREE.Group();
  if (trailGroup) g.userData.trailGroup = trailGroup;
  const cfg = {
    // Escort wing: fast, lightly-armed friendlies.
    paladin:  { hp: 160, speed: 19, scale: 1,    len: 4.6 },
    sentinel: { hp: 220, speed: 14, scale: 1.15, len: 5.4 },
    warden:   { hp: 140, speed: 21, scale: 0.95, len: 4.4 },
    // Named wingmen (Slick & O.G.): tougher hero hulls than the stock escorts so they can press
    // the capital's batteries and survive a real fight alongside the player.
    slick:    { hp: 360, speed: 22, scale: 1.1,  len: 5.6 },
    og:       { hp: 360, speed: 20, scale: 1.15, len: 5.8 },
    // The capital the player defends.
    flagship: { hp: 5200, speed: 2, scale: 7.5,  len: 140 }
  }[kind] || { hp: 160, speed: 19, scale: 1, len: 4.6 };

  if (kind === 'flagship') {
    // Build the point-defense turrets only AFTER the hull GLB has loaded and been measured, so they
    // anchor to the model's ACTUAL bounding box (mirrors the exhaust/muzzle mount approach). The
    // earlier version positioned turrets at fractions of the nominal length L before the model was
    // measured; on this hull the real fuselage is much smaller than L's longest-axis normalization,
    // so the turrets floated off the ship and read oversized. Measuring the real box fixes both.
    const model = loadFighterModel(ALLY_CAPITAL_URL, cfg.len, (mg) => attachFlagshipTurrets(g, mg, cfg.len));
    g.add(model);
    g.userData.model = model;
    const CL = cfg.len;
    const capMounts = (CAPITAL_EXHAUST_MOUNTS[ALLY_CAPITAL_URL] || CAPITAL_EXHAUST_MOUNTS._default)
      .map(([fx, fy, fz]) => new THREE.Vector3(fx * CL, fy * CL, fz * CL));
    attachEngineEffects(g, capMounts, 'blue', CL * 0.05);
  } else {
    const modelUrl = ALLY_MODEL_URLS[kind] || ALLY_MODEL_URLS.paladin;
    const L = cfg.len;
    // Named wingmen carry orientation-rig-calibrated gun muzzles so their friendly bolts leave the
    // actual gun mouths; stock escorts fall back to firing from the hull nose in main.js.
    const muzzleLayout = ALLY_MUZZLE_MOUNTS[kind] || null;
    // Calibrated exhaust layout for hulls that have one (named wingmen); otherwise the default twin.
    const exhaustLayout = ALLY_EXHAUST_MOUNTS[kind] || null;
    const model = loadFighterModel(modelUrl, L, (mg) => {
      if (muzzleLayout) attachMuzzles(g, noseFromModel(mg, muzzleLayout, L));
      if (exhaustLayout) {
        // Anchor calibrated nozzles to the model's ACTUAL tail (mirrors the enemy exhaust path),
        // so explicit-pos entries land exactly where they were placed in the P rig.
        attachEngineEffects(g, tailFromModel(mg, exhaustLayout, L), 'blue');
      }
    });
    g.add(model);
    g.userData.model = model;
    if (!exhaustLayout) {
      // Stock escort hulls (azure starfighter family) use the symmetric default twin nozzle layout
      // attached immediately; calibrate a per-hull ALLY_EXHAUST_MOUNTS key to anchor a tuned hull.
      const mounts = (ENEMY_EXHAUST_MOUNTS._default)
        .map((entry) => {
          const m = normMount(entry); const [fx, fy, fz] = m.pos;
          return { pos: new THREE.Vector3(fx * L, fy * L, fz * L), rot: m.rot };
        });
      attachEngineEffects(g, mounts, 'blue');
    }
  }

  g.position.copy(position);
  g.userData = Object.assign(g.userData, {
    kind, faction: 'ally', hp: cfg.hp, maxHp: cfg.hp, speed: cfg.speed,
    radius: (kind === 'flagship' ? 58 : 1.5) * (kind === 'flagship' ? 1 : cfg.scale),
    fireT: Math.random() * 1.6, phase: Math.random() * 9,
    vel: new THREE.Vector3(),
    behavior: 'pursue',
    behaviorT: 0.6 + Math.random() * 1.2,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    jinkPhase: Math.random() * Math.PI * 2,
    jinkRate: 0.7 + Math.random() * 0.8,
    target: null            // current hostile this ally is engaging (set by main.js AI)
  });

  // The flagship's point-defense turrets are attached in loadFighterModel's onReady callback above
  // (attachFlagshipTurrets), once the hull is loaded and its real bounding box can be measured.
  return g;
}

// Mount the allied flagship's point-defense turrets to the loaded hull. Unlike the old version that
// placed turrets at fractions of the NOMINAL length L (before the GLB was measured), this measures
// the model's ACTUAL bounding box and spreads the turrets across the real hull extents, so they sit
// flush on the deck instead of floating beside it. Turret size is keyed to the measured hull, and at
// HALF the previous proportion so the emplacements no longer read oversized.
const _flagBox = new THREE.Box3();
const _flagSize = new THREE.Vector3();
const _flagCtr = new THREE.Vector3();
function attachFlagshipTurrets(g, modelGroup, L) {
  modelGroup.updateMatrixWorld(true);
  _flagBox.setFromObject(modelGroup);
  // Fall back to nominal-length placement if the model box is somehow not measurable.
  const measurable = isFinite(_flagBox.min.x) && isFinite(_flagBox.max.z);
  if (measurable) { _flagBox.getSize(_flagSize); _flagBox.getCenter(_flagCtr); }
  const hw = measurable ? _flagSize.x * 0.5 : 0.2 * L;   // hull half-width
  const hl = measurable ? _flagSize.z * 0.5 : 0.5 * L;   // hull half-length (Z)
  const top = measurable ? _flagBox.max.y : 0.07 * L;    // deck (top) Y
  const bot = measurable ? _flagBox.min.y : -0.06 * L;   // belly (bottom) Y
  const cx = measurable ? _flagCtr.x : 0;
  const cz = measurable ? _flagCtr.z : 0;
  // Turrets sit a touch inside the hull silhouette so they look mounted, not perched on the rim.
  const ix = 0.62, iz = 0.62;   // inset factors from the measured extents
  // [x, y, z, outward-normal]. Five along the upper deck, two on the flanks, one belly.
  const mounts = [
    [cx - hw * ix * 0.5, top, cz + hl * iz * 0.55, new THREE.Vector3( 0,  1,  0)],
    [cx + hw * ix * 0.5, top, cz + hl * iz * 0.55, new THREE.Vector3( 0,  1,  0)],
    [cx - hw * ix * 0.6, top, cz - hl * iz * 0.30, new THREE.Vector3( 0,  1,  0)],
    [cx + hw * ix * 0.6, top, cz - hl * iz * 0.30, new THREE.Vector3( 0,  1,  0)],
    [cx,                 top, cz - hl * iz * 0.85, new THREE.Vector3( 0,  1,  0)],
    [cx - hw * ix,       (top + bot) * 0.5, cz, new THREE.Vector3(-1,  0.2, 0)],
    [cx + hw * ix,       (top + bot) * 0.5, cz, new THREE.Vector3( 1,  0.2, 0)],
    [cx,                 bot, cz + hl * iz * 0.45, new THREE.Vector3( 0, -1,  0)]
  ];
  g.userData.turrets = [];
  // HALF the previous size (was 0.045·L); key to the measured hull width so it scales with the model.
  const turretScale = Math.max(measurable ? hw * 0.10 : 0.022 * L, 0.5);
  for (const [x, y, z, normal] of mounts) {
    const turret = makeCapitalTurret(turretScale, normal.clone().normalize());
    turret.position.set(x, y, z);
    g.add(turret);
    g.userData.turrets.push(turret.userData.ctrl);
  }
}

// ---- Dreadnought shield generators (Mission 2) -------------------------------------------------
// Two destructible shield emitters bolted to the enemy capital. While at least one is alive the
// Dreadnought's hull is almost invulnerable (incoming fire is bled off as shield deflection); once
// BOTH are gone the hull takes full damage. Each generator is its own lockable/destroyable target.
// Built as a glowing dome on a base with a slow-rotating energy ring, so it reads as a shield rig.
export function makeShieldGenerator(s) {
  const base = new THREE.Group();
  const metalDark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6, metalness: 0.75 });
  const metalMid  = new THREE.MeshStandardMaterial({ color: 0x4a5158, roughness: 0.5, metalness: 0.8 });
  // Mounting plinth sunk into the hull.
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.15 * s, 1.45 * s, 0.7 * s, 18), metalDark);
  plinth.position.y = 0.35 * s;
  base.add(plinth);
  // Emitter housing.
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.9 * s, 1.05 * s, 0.6 * s, 16), metalMid);
  housing.position.y = 0.95 * s;
  base.add(housing);
  // Glowing energy dome — the visible "live" indicator. Bright cyan-blue while active.
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0x2fd8ff, emissive: 0x36e0ff, emissiveIntensity: 1.6,
    roughness: 0.25, metalness: 0.2, transparent: true, opacity: 0.92
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.92 * s, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), domeMat);
  dome.position.y = 1.2 * s;
  base.add(dome);
  // Slow-spinning energy ring around the dome for a powered-up read.
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x6fe9ff, emissive: 0x44d8ff, emissiveIntensity: 2.2,
    roughness: 0.3, metalness: 0.1, transparent: true, opacity: 0.85
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05 * s, 0.1 * s, 10, 28), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 1.1 * s;
  base.add(ring);

  const ctrl = {
    group: base, dome, ring, domeMat, ringMat,
    hp: 1500, maxHp: 1500, alive: true,
    radius: 2.0 * s,    // world hit radius for player bolts striking the generator
    spin: Math.random() * Math.PI * 2
  };
  base.userData.ctrl = ctrl;
  // Tag the group so the targeting computer can lock it like any contact. `kind:'shieldgen'` makes
  // the HUD/scope label it "SHIELD GENERATOR"; hp/maxHp mirror the ctrl so integrity reads live.
  base.userData.kind = 'shieldgen';
  base.userData.ctrlRef = ctrl;
  return base;
}

// Seat each shield generator on the REAL hull surface. For every mount (an X/Z point in the capital
// group's local frame) we cast a ray straight DOWN from high above onto the loaded hull meshes; the
// first hit gives the genuine deck height AND its surface normal at that spot. We drop the generator
// onto that point and tilt its base so "up" follows the surface normal — so the base sits flush on
// the hull instead of floating at the global bounding-box top.
const _rcDown = new THREE.Raycaster();
const _rcOrigin = new THREE.Vector3();
const _rcDir = new THREE.Vector3(0, -1, 0);
const _genBox2 = new THREE.Box3();
const _UP = new THREE.Vector3(0, 1, 0);
function seatShieldGenerators(capitalGroup, modelGroup, mounts, genScale) {
  capitalGroup.updateMatrixWorld(true);
  modelGroup.updateMatrixWorld(true);
  // Collect the hull meshes to raycast against.
  const meshes = [];
  modelGroup.traverse(o => { if (o.isMesh) meshes.push(o); });
  // Measure the hull so we can start the ray well ABOVE the highest point and clamp fallbacks.
  _genBox2.setFromObject(modelGroup);
  const localTop = isFinite(_genBox2.max.y) ? _genBox2.max.y : genScale * 4;
  const startY = localTop + Math.abs(localTop) + genScale * 30;   // safely above the whole hull
  for (const mount of mounts) {
    const gen = makeShieldGenerator(genScale);
    // Ray origin in WORLD space, directly above the mount X/Z (mount is in capitalGroup-local).
    _rcOrigin.copy(mount); _rcOrigin.y = startY;
    capitalGroup.localToWorld(_rcOrigin);
    _rcDown.set(_rcOrigin, _rcDir);
    _rcDown.far = Math.abs(startY) + Math.abs(localTop) + genScale * 60;
    const hits = meshes.length ? _rcDown.intersectObjects(meshes, true) : [];
    // How deep the generator base sinks into the hull. In DEV mode keep the original hair-thin sink
    // so the live calibration positions are unchanged; when shipping, clamp it down so the plinth
    // beds into the plating and the generator reads as bolted INTO the ship, not perched on top.
    // The plinth is 0.7*genScale tall sitting on local y=0, so ~0.45*genScale buries most of it.
    const sink = SCENE_DEV_MODE ? genScale * 0.25 : genScale * 0.45;
    if (hits.length) {
      const hit = hits[0];
      // Convert the world hit point back into the capital group's local frame and sit there.
      gen.position.copy(capitalGroup.worldToLocal(hit.point.clone()));
      // Sink the base into the hull (deeper when shipping) so there's no gap under the plinth.
      gen.position.y -= sink;
      // Orient the generator's local +Y to the hull surface normal (transformed to local frame).
      if (hit.face) {
        const nWorld = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
        // Bring the world normal into the capital group's local frame.
        const nLocal = nWorld.clone().transformDirection(
          new THREE.Matrix4().copy(capitalGroup.matrixWorld).invert()
        ).normalize();
        // Mostly-up normals: keep upright (avoid jitter from noisy faces). Otherwise tilt to follow.
        if (nLocal.dot(_UP) < 0.92) gen.quaternion.setFromUnitVectors(_UP, nLocal);
      }
    } else {
      // No surface found (degenerate hull): fall back to the measured deck top on the spine.
      gen.position.set(mount.x, localTop - sink, mount.z);
    }
    capitalGroup.add(gen);
    capitalGroup.userData.shieldGens.push(gen.userData.ctrl);
  }
}

// Seat the enemy capital's point-defense turrets on the REAL hull, the same raycast way the shield
// generators are seated — so they sit flush on the deck/flanks/belly instead of floating at fixed
// fractions of the nominal length (the old bug). For each mount we cast a ray from far out along the
// mount's outward direction back toward the hull center; the first hull hit gives the true surface
// point + normal, and we plant the turret there oriented to that normal. Sizing keys to the measured
// hull so turrets scale with the model, matching the flagship turret treatment.
const _capTurBox = new THREE.Box3();
const _capTurSize = new THREE.Vector3();
const _capTurCtr = new THREE.Vector3();
const _rcCap = new THREE.Raycaster();
const _capRayOrigin = new THREE.Vector3();
const _capRayDir = new THREE.Vector3();
function attachCapitalTurrets(g, modelGroup, L) {
  g.updateMatrixWorld(true);
  modelGroup.updateMatrixWorld(true);
  const meshes = [];
  modelGroup.traverse(o => { if (o.isMesh) meshes.push(o); });
  _capTurBox.setFromObject(modelGroup);
  const measurable = isFinite(_capTurBox.min.x) && isFinite(_capTurBox.max.z);
  if (measurable) { _capTurBox.getSize(_capTurSize); _capTurBox.getCenter(_capTurCtr); }
  const hw = measurable ? _capTurSize.x * 0.5 : 0.2 * L;   // hull half-width
  const hl = measurable ? _capTurSize.z * 0.5 : 0.5 * L;   // hull half-length (Z)
  const top = measurable ? _capTurBox.max.y : 0.07 * L;
  const bot = measurable ? _capTurBox.min.y : -0.06 * L;
  const cx = measurable ? _capTurCtr.x : 0;
  const cz = measurable ? _capTurCtr.z : 0;
  const cy = measurable ? (top + bot) * 0.5 : 0;
  // Desired emplacements: [approx target point in capital-local space, outward face normal].
  // The point is only a SEED — the raycast snaps it onto the genuine hull surface.
  const ix = 0.55, iz = 0.62;
  const mounts = [
    [new THREE.Vector3(cx - hw * ix * 0.5, top, cz + hl * iz * 0.55), new THREE.Vector3( 0,  1,  0)],
    [new THREE.Vector3(cx + hw * ix * 0.5, top, cz + hl * iz * 0.55), new THREE.Vector3( 0,  1,  0)],
    [new THREE.Vector3(cx - hw * ix * 0.6, top, cz - hl * iz * 0.30), new THREE.Vector3( 0,  1,  0)],
    [new THREE.Vector3(cx + hw * ix * 0.6, top, cz - hl * iz * 0.30), new THREE.Vector3( 0,  1,  0)],
    [new THREE.Vector3(cx,                 top, cz - hl * iz * 0.85), new THREE.Vector3( 0,  1,  0)],
    [new THREE.Vector3(cx - hw,            cy,  cz + hl * iz * 0.10), new THREE.Vector3(-1,  0.25, 0)],
    [new THREE.Vector3(cx + hw,            cy,  cz + hl * iz * 0.10), new THREE.Vector3( 1,  0.25, 0)],
    [new THREE.Vector3(cx,                 bot, cz + hl * iz * 0.40), new THREE.Vector3( 0, -1,  0)],
    [new THREE.Vector3(cx,                 bot, cz - hl * iz * 0.40), new THREE.Vector3( 0, -1,  0)]
  ];
  g.userData.turrets = [];
  // Scale keyed to the measured hull width, matching the flagship turret sizing (half the old size).
  const turretScale = Math.max(measurable ? hw * 0.085 : 0.022 * L, 0.5);
  const invG = new THREE.Matrix4().copy(g.matrixWorld).invert();
  for (const [seed, normal] of mounts) {
    const turret = makeCapitalTurret(turretScale, normal.clone().normalize());
    // Cast from OUTSIDE the hull along the mount's outward normal back toward the seed, finding the
    // real surface. Origin = seed pushed out along +normal by a generous margin.
    const reach = Math.max(hw, hl, Math.abs(top - bot)) * 1.6 + turretScale * 6;
    _capRayDir.copy(normal).normalize().multiplyScalar(-1);   // ray points INWARD toward the hull
    _capRayOrigin.copy(seed).addScaledVector(normal, reach);  // start well outside the hull
    g.localToWorld(_capRayOrigin);
    // Direction must be in world space.
    const worldDir = _capRayDir.clone().transformDirection(g.matrixWorld).normalize();
    _rcCap.set(_capRayOrigin, worldDir);
    _rcCap.far = reach * 2.2;
    const hits = meshes.length ? _rcCap.intersectObjects(meshes, true) : [];
    if (hits.length) {
      const hit = hits[0];
      turret.position.copy(g.worldToLocal(hit.point.clone()));
      if (hit.face) {
        const nWorld = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
        const nLocal = nWorld.clone().transformDirection(invG).normalize();
        // Re-orient the base so its yaw axis follows the true surface normal at the hit.
        turret.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nLocal);
        turret.userData.ctrl.restNormal = nLocal.clone();
        // Sink the base a hair so the ring meets the hull cleanly.
        turret.position.addScaledVector(nLocal, -turretScale * 0.15);
      }
    } else {
      // No surface (degenerate hull): drop the turret at the seed point with its nominal normal.
      turret.position.copy(seed);
    }
    g.add(turret);
    g.userData.turrets.push(turret.userData.ctrl);
  }
}

// ---- Dreadnought ENERGY SHIELD DOME -----------------------------------------------------------
// A sci-fi shield bubble around the capital: a partially-transparent sphere with a Fresnel rim, a
// faint hex-cell weave, and animated impact ripples that flare bright near where incoming fire
// strikes. Driven each frame from main.js: uStrength (overall opacity, set by surviving generators)
// and up to N impact points (uHitPos/uHitTime) that bloom and fade at the point of impact.
const SHIELD_MAX_HITS = 8;
// `opts.baseMul` scales the STEADY (no-impact) visibility of the dome: 0 makes the shield completely
// invisible at rest and only visible where it absorbs a hit (the reactive look used by both Mamba and
// the Dreadnought). `opts.color`/`opts.hotColor` tint it; `opts.segments` sets sphere tessellation.
function makeShieldDome(radius, opts = {}) {
  const seg = opts.segments || 64;
  const geo = new THREE.SphereGeometry(radius, seg, Math.round(seg * 0.75));
  // Each impact stores a DIRECTION (unit vector from the dome center toward the strike point on the
  // sphere) plus the time it landed. The shader compares each fragment's own outward direction to
  // these hit directions via an angular ("geodesic") distance, so the ripple travels cleanly across
  // the curved shield surface and is centered exactly where fire crosses the bubble.
  const uniforms = {
    uTime:     { value: 0 },
    uStrength: { value: 1 },                         // 0..1 overall shield opacity (generator state)
    uBaseMul:  { value: opts.baseMul != null ? opts.baseMul : 0 }, // steady-state visibility (0 = invisible at rest)
    uRadius:   { value: radius },
    uColor:    { value: new THREE.Color(opts.color != null ? opts.color : 0x35c9ff) }, // base shield tint
    uHotColor: { value: new THREE.Color(opts.hotColor != null ? opts.hotColor : 0xcdf2ff) }, // bright impact / rim color
    uHitDir:   { value: Array.from({ length: SHIELD_MAX_HITS }, () => new THREE.Vector3(0, 1, 0)) },
    uHitTime:  { value: new Float32Array(SHIELD_MAX_HITS).fill(-100) }
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      #define MAX_HITS ${SHIELD_MAX_HITS}
      #define HIT_LIFE 0.85
      uniform float uTime;
      uniform float uStrength;
      uniform float uBaseMul;
      uniform float uRadius;
      uniform vec3  uColor;
      uniform vec3  uHotColor;
      uniform vec3  uHitDir[MAX_HITS];
      uniform float uHitTime[MAX_HITS];
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying vec3 vLocalPos;

      // Cheap hash-based hex-ish cell pattern over the sphere surface (uses local position).
      float cells(vec3 p) {
        vec3 q = p * 7.0;
        vec3 f = abs(fract(q) - 0.5);
        float d = max(max(f.x, f.y), f.z);
        return smoothstep(0.34, 0.5, d);   // bright thin seams between cells
      }

      void main() {
        if (uStrength <= 0.001) discard;
        vec3 V = normalize(cameraPosition - vWorldPos);
        float facing = abs(dot(normalize(vNormal), V));
        // Fresnel rim: brighter at glancing angles so the bubble edge glows.
        float fres = pow(1.0 - facing, 2.4);

        // Drifting energy weave across the surface.
        vec3 lp = normalize(vLocalPos);
        float weave = cells(lp + vec3(0.0, uTime * 0.04, 0.0)) * 0.5
                    + cells(lp * 1.7 - vec3(uTime * 0.03)) * 0.35;
        // Slow vertical scan band.
        float scan = 0.5 + 0.5 * sin(lp.y * 18.0 - uTime * 1.4);
        scan = pow(scan, 6.0) * 0.5;

        // ---- Impact ABSORB + RIPPLE ---------------------------------------------------------
        // For each recent hit, measure the ANGULAR distance from this fragment to the strike point
        // (both as unit directions from the dome center). That angle drives:
        //   - a bright hot CORE that flares then fades  (the energy being absorbed at the point)
        //   - an expanding RIPPLE RING that races outward across the bubble and dissipates
        //   - a faint hex-cell ENERGIZE that lights the shield's weave near the strike
        // Hits sum, so several near-simultaneous strikes all read.
        float core = 0.0, ripple = 0.0, energize = 0.0;
        for (int i = 0; i < MAX_HITS; i++) {
          float age = uTime - uHitTime[i];
          if (age < 0.0 || age > HIT_LIFE) continue;
          float t = age / HIT_LIFE;            // 0..1 normalized life
          float life = 1.0 - t;                // fades out
          // Angular distance (radians) from this fragment's direction to the hit direction.
          float ang = acos(clamp(dot(lp, uHitDir[i]), -1.0, 1.0));

          // Hot absorb core: a tight bright splash right at the strike, punchy then quick decay.
          float coreW = exp(-ang * ang * 90.0);
          core += coreW * (1.0 - smoothstep(0.0, 0.35, t)) * 1.4;

          // Expanding ripple ring: a thin band whose radius grows with age, thinning as it goes.
          float rad = t * 1.05;                // ring radius in radians (covers most of the bubble)
          float thick = 0.05 + t * 0.12;       // ring fattens slightly as it expands
          float band = exp(-pow(ang - rad, 2.0) / (thick * thick));
          ripple += band * life * 1.3;

          // Energize the cell weave in a soft disc around the strike so the shield "lights up".
          energize += exp(-ang * ang * 9.0) * life;
        }
        float impact = core + ripple;

        // NEAR-INVISIBLE baseline: with no fire landing, the shield is barely a whisper — just the
        // faintest Fresnel-rim hint of a bubble, with the weave only showing where an impact ENERGIZES
        // it. The IMPACT terms are what light the dome up: a localized absorb-flash + traveling ripple
        // exactly where fire is intercepted. So at rest you mostly see the Dreadnought, not the shield.
        float base = fres * 0.22 + weave * energize * 0.9 + scan * 0.10;
        vec3 col = mix(uColor, uHotColor, clamp(fres * 0.4 + impact, 0.0, 1.0));
        // Steady shield alpha is scaled by uBaseMul — with uBaseMul=0 the dome is fully INVISIBLE at
        // rest and ONLY the impact ripple/absorb shows (the reactive shield look). Impacts always
        // punch through at full brightness regardless of the baseline setting.
        float alpha = base * 0.05 * uStrength * uBaseMul + clamp(impact, 0.0, 1.4) * 0.9;
        alpha = clamp(alpha, 0.0, 0.92);
        gl_FragColor = vec4(col * (1.0 + impact * 2.4), alpha);
      }
    `
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;            // draw after the hull so it overlays cleanly
  mesh.frustumCulled = false;
  mesh.userData.shieldMat = mat;
  mesh.userData.shieldRadius = radius;
  mesh.userData.nextHit = 0;
  return mesh;
}

// Per-frame upkeep for a capital's shield dome. `strength` (0..1) is the overall opacity the caller
// derives from how many generators survive (full / 0.5 / 0). The dome rolls its animation clock and
// fades the live strength toward the target so generator loss reads as a smooth dim, not a pop.
export function updateShieldDome(capital, time, targetStrength, dt = 0.016) {
  const dome = capital.userData.shieldDome;
  if (!dome) return;
  const mat = dome.userData.shieldMat;
  mat.uniforms.uTime.value = time;
  const cur = mat.uniforms.uStrength.value;
  // Ease toward the target strength (≈0.4s settle).
  mat.uniforms.uStrength.value = cur + (targetStrength - cur) * Math.min(1, dt * 6);
  dome.visible = mat.uniforms.uStrength.value > 0.01;
}

// Register a shield IMPACT from a world-space strike point so the dome blooms an absorb-flash +
// traveling ripple right where incoming fire crosses the bubble. The strike point is usually at the
// HULL (well inside the dome sphere), so we convert it into the DIRECTION from the dome center and
// hand the shader that unit direction (in the dome's LOCAL frame, matching the shader's vLocalPos).
// The shader then centers the ripple on the point of the sphere along that direction. Round-robins a
// small ring of hit slots so several near-simultaneous strikes all show.
const _domeCenter = new THREE.Vector3();
const _domeHitDir = new THREE.Vector3();
const _domeInvQuat = new THREE.Quaternion();
export function registerShieldHit(capital, worldPos) {
  const dome = capital.userData.shieldDome;
  if (!dome || !dome.visible) return;
  const mat = dome.userData.shieldMat;
  if (mat.uniforms.uStrength.value <= 0.02) return;
  dome.updateMatrixWorld();
  dome.getWorldPosition(_domeCenter);
  // Direction from the dome center to the strike point, in WORLD space...
  _domeHitDir.copy(worldPos).sub(_domeCenter);
  if (_domeHitDir.lengthSq() < 1e-6) _domeHitDir.set(0, 1, 0);
  _domeHitDir.normalize();
  // ...then rotate it into the dome's LOCAL frame so it lines up with the shader's vLocalPos.
  dome.getWorldQuaternion(_domeInvQuat).invert();
  _domeHitDir.applyQuaternion(_domeInvQuat).normalize();
  const i = dome.userData.nextHit % SHIELD_MAX_HITS;
  dome.userData.nextHit++;
  mat.uniforms.uHitDir.value[i].copy(_domeHitDir);
  mat.uniforms.uHitTime.value[i] = mat.uniforms.uTime.value;
}

// Build one swiveling point-defense turret: a fixed base ring, a yawing housing, and a pitching
// gun cradle with twin barrels. Returns the base group; `userData.ctrl` exposes the moving parts
// (yaw/pitch pivots, muzzle anchors, HP, cooldown) consumed by the turret AI in main.js.
function makeCapitalTurret(s, restNormal) {
  const base = new THREE.Group();
  // Orient the whole emplacement so its "up" (yaw axis) points along the hull's outward normal,
  // letting turrets on the belly/flanks sit flush and sweep across their hemisphere.
  base.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), restNormal);

  const metalDark = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.6, metalness: 0.7 });
  const metalMid  = new THREE.MeshStandardMaterial({ color: 0x595f66, roughness: 0.5, metalness: 0.75 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.45, metalness: 0.85, emissive: 0x180000, emissiveIntensity: 0.6 });

  // Fixed mounting ring sunk into the hull.
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.95 * s, 1.15 * s, 0.4 * s, 16), metalDark);
  ring.position.y = 0.2 * s;
  base.add(ring);

  // Yaw pivot: rotates about local Y (the outward normal) to swing the turret around.
  const yaw = new THREE.Group();
  yaw.position.y = 0.4 * s;
  base.add(yaw);
  const housing = new THREE.Mesh(new THREE.SphereGeometry(0.7 * s, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), metalMid);
  housing.scale.set(1, 0.8, 1.1);
  yaw.add(housing);

  // Pitch pivot: elevates the gun cradle. Sits atop the housing.
  const pitch = new THREE.Group();
  pitch.position.y = 0.45 * s;
  yaw.add(pitch);
  const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.9 * s, 0.45 * s, 0.7 * s), metalMid);
  pitch.add(cradle);

  // Twin barrels pointing along the cradle's local -Z (the muzzle direction we'll aim).
  const muzzles = [];
  for (const dx of [-0.28 * s, 0.28 * s]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.14 * s, 1.5 * s, 10), barrelMat);
    barrel.rotation.x = Math.PI / 2;     // lay the cylinder along Z
    barrel.position.set(dx, 0.05 * s, -0.75 * s);
    pitch.add(barrel);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(dx, 0.05 * s, -1.55 * s);
    pitch.add(muzzle);
    muzzles.push(muzzle);
  }

  base.userData.ctrl = {
    group: base, yaw, pitch, muzzles,
    hp: 140, maxHp: 140, alive: true,
    fireT: Math.random() * 1.5,
    // Hit radius (world units) for player bolts striking this turret. Set from scale.
    radius: 1.4 * s,
    nextMuzzle: 0
  };
  return base;
}

// `colorTeam` (optional) overrides ONLY the tracer color, independent of the `friendly` flag that
// drives hit behavior/speed: pass 0 for a blue (cyan) bolt or 1 for a red bolt. Used in multiplayer
// so a RED-team pilot's OWN tracers render red (team-absolute color) even though they're "friendly"
// to that pilot for local behavior. Omit it for single-player (color follows `friendly`).
export function makeBolt(pos, dir, friendly = true, damage = 18, colorTeam = null, overrideColor = null) {
  const geo = new THREE.CylinderGeometry(.045, .045, friendly ? 2.7 : 1.7, 8);
  // `overrideColor` (a hex) wins over everything — used so the player's Ship-Hangar laser-color
  // cosmetic tints their own tracers. Otherwise fall back to the team-absolute / friendly logic.
  const boltColor = overrideColor != null ? overrideColor
    : colorTeam === 1 ? 0xff3d52 : colorTeam === 0 ? 0x62f8ff : (friendly ? 0x62f8ff : 0xff3d52);
  const material = new THREE.MeshBasicMaterial({ color: boltColor });
  const bolt = new THREE.Mesh(geo, material);
  bolt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  bolt.position.copy(pos);
  bolt.userData = { vel: dir.clone().normalize().multiplyScalar(friendly ? 175 : 80), life: 1.35, friendly, damage };
  return bolt;
}

// A guided missile: a small dart body with a glowing motor and a soft additive exhaust glow.
// If `target` is set the missile seeks it (see updateMissiles in main.js); otherwise it flies
// straight. `friendly` controls who it can hit and its color accent.
export function makeMissile(pos, dir, friendly, target = null, damage = 70, overrideAccent = null) {
  const g = new THREE.Group();
  // `overrideAccent` (a hex) tints the friendly pilot's missile motor/glow from the Ship-Hangar
  // Missile-FX cosmetic. Otherwise use the default friendly-blue / hostile-orange accent.
  const accent = overrideAccent != null ? overrideAccent : (friendly ? 0x9fe8ff : 0xff7a52);
  // Dart body — a slim cone (nose +Y in local, we orient with quaternion to point along dir).
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.18, 1.5, 10),
    new THREE.MeshStandardMaterial({ color: 0xd8dde6, emissive: accent, emissiveIntensity: 0.35, roughness: 0.5, metalness: 0.6 })
  );
  g.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.5, metalness: 0.6 })
  );
  nose.position.y = 1.0; g.add(nose);
  // Hot motor glow at the tail.
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getFlashTex(), color: accent, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.setScalar(1.6);
  glow.position.y = -0.9;
  g.add(glow);
  g.userData.glow = glow;

  g.position.copy(pos);
  const d = dir.clone().normalize();
  // The body's long axis is local +Y, so orient +Y onto the travel direction.
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  g.userData = Object.assign(g.userData, {
    isMissile: true, friendly, damage,
    vel: d.clone().multiplyScalar(friendly ? 70 : 60),
    speed: friendly ? 150 : 120,
    turn: 2.6,            // max rad/s the missile can rotate its velocity toward the target
    target,               // Object3D it seeks, or null for a dumb-fire straight shot
    life: 6.0,            // self-destruct timeout
    armed: 0.12,          // brief arm delay so it clears the launcher before it can detonate
    decoy: null,          // a chaff flare currently spoofing it (temporary target swap)
    decoyT: 0,
  });
  return g;
}

// A chaff/decoy flare: a bright tumbling additive mote that a seeking missile may chase instead
// of its real target. Short-lived; while it lives it can lure missiles within range.
export function makeChaff(pos, vel) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: getFlashTex(), color: 0xfff0b0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(2.2);
  s.position.copy(pos);
  s.userData = { isChaff: true, vel: vel.clone(), life: 2.2, maxLife: 2.2 };
  return s;
}

// Small impact sparks (laser hits). Transparent + additive so the per-frame opacity fade in
// updateExplosions actually reads, and so hits glow against the dark starfield.
export function spark(group, pos, color = 0x71fbff) {
  for (let i = 0; i < 10; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(.045 + Math.random() * .06, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    p.position.copy(pos);
    p.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 16), life: .35 + Math.random() * .35, maxLife: .7, kind: 'spark', drag: 0.6 };
    group.add(p);
  }
}

let _flashTex = null;
function getFlashTex() {
  if (!_flashTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,230,170,0.9)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    _flashTex = new THREE.CanvasTexture(c);
  }
  return _flashTex;
}
function flashSprite(color, size, life, growMul = 1.8) {
  const m = new THREE.SpriteMaterial({ map: getFlashTex(), color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.userData = { life, maxLife: life, kind: 'flash', growFrom: size * 0.5, growTo: size * growMul };
  return s;
}

// Soft round puff texture (white core fading to transparent), used for billowing smoke and
// the rolling fireball so blobs read as volume rather than hard spheres.
let _puffTex = null;
function getPuffTex() {
  if (!_puffTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    _puffTex = new THREE.CanvasTexture(c);
  }
  return _puffTex;
}

// Full enemy-destruction blast. Layered for punch and readability:
//   1) a hard white double-flash core,
//   2) a flat expanding shockwave disc (clearer than a thin torus) plus a quick fireball burst,
//   3) a rolling fireball of warm puffs that bloom then collapse,
//   4) fast streaking shrapnel that leaves stretched trails,
//   5) lingering dark smoke that drifts and dims.
// Scale grows the whole effect for bigger craft (capital ships). Driven by updateExplosions
// via userData.kind.
export function explode(group, pos, color = 0xffb347, scale = 1, opts = {}) {
  const big = !!opts.capital;
  // Capital ships erupt in a drawn-out chain reaction: stagger several secondary blasts along
  // the hull over the next ~1.3s, each a smaller standalone explosion offset from center, plus
  // a slow expanding debris cloud. The primary blast below still fires immediately.
  if (big) {
    const dir = opts.dir || new THREE.Vector3(0, 0, 1);
    const span = (opts.length || 24) * 0.5;     // half-length of the hull to spread blasts over
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    const secondaries = 7;
    for (let i = 0; i < secondaries; i++) {
      const along = (Math.random() * 2 - 1) * span;
      const off = pos.clone()
        .addScaledVector(dir, along)
        .addScaledVector(side, (Math.random() * 2 - 1) * span * 0.35)
        .addScaledVector(up, (Math.random() * 2 - 1) * span * 0.35);
      const delay = 0.12 + Math.random() * 1.2;
      const secScale = scale * (0.35 + Math.random() * 0.5);
      // Marker particle that does nothing but trigger a child blast when its timer fires.
      const trig = new THREE.Object3D();
      trig.userData = { kind: 'trigger', life: delay, maxLife: delay, fire: { pos: off, color, scale: secScale, noRing: opts.noRing } };
      group.add(trig);
    }
  }

  // 1) Central flash — a hard white spike that snaps bright then collapses, plus a colored glow.
  const core = flashSprite(0xffffff, 3.4 * scale, 0.22, 2.6);
  core.position.copy(pos); group.add(core);
  const glow = flashSprite(color, 5.6 * scale, 0.5, 2.2);
  glow.position.copy(pos); group.add(glow);

  // 2a) Shockwave disc — a flat ring that snaps outward fast then thins out. A disc (with a
  // hollow look from the additive falloff) reads more clearly than a thin tube torus. Skippable
  // via opts.noRing for blasts where the expanding ring isn't wanted (e.g. allied ship deaths).
  if (!opts.noRing) {
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffeec0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55 * scale, 0.16 * scale, 10, 48), ringMat);
    ring.position.copy(pos);
    ring.quaternion.random();
    ring.userData = { life: 0.45, maxLife: 0.45, kind: 'ring', growTo: 13 * scale };
    group.add(ring);
  }

  // 2b) Fireball flash sprites — a few big additive blobs that pop and vanish, giving the
  // initial "boom" body before the rolling fireball takes over.
  for (let i = 0; i < 4; i++) {
    const f = flashSprite(i === 0 ? 0xffffff : color, (2.4 + Math.random() * 2.2) * scale, 0.28 + Math.random() * 0.18, 2.0);
    f.position.copy(pos).add(new THREE.Vector3().randomDirection().multiplyScalar(0.8 * scale));
    group.add(f);
  }

  // 3) Rolling fireball — warm puff sprites that expand outward, bloom, then collapse to nothing.
  // They tumble (spin) and cool from yellow-white through orange toward smoke.
  const puffTex = getPuffTex();
  const ballCount = Math.round(16 * scale);
  for (let i = 0; i < ballCount; i++) {
    const m = new THREE.SpriteMaterial({ map: puffTex, color: 0xfff0c0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, rotation: Math.random() * Math.PI * 2 });
    const s = new THREE.Sprite(m);
    const sz = (1.2 + Math.random() * 1.6) * scale;
    s.scale.setScalar(sz);
    s.position.copy(pos).add(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * 1.2 * scale));
    const sp = (4 + Math.random() * 14) * scale;
    s.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(sp), life: 0.6 + Math.random() * 0.6, maxLife: 1.2, kind: 'fireball', drag: 2.2, baseScale: sz, spin: (Math.random() - 0.5) * 4 };
    group.add(s);
  }

  // 4) Fast shrapnel — bright additive shards that streak out fast and leave a stretched trail
  // (scaled along their velocity in updateExplosions) so destruction feels violent.
  const hot = [0xfff3b0, 0xffd070, 0xffba5a, 0xff7a33, color];
  const shardCount = Math.round(30 * scale);
  for (let i = 0; i < shardCount; i++) {
    const c = hot[(Math.random() * hot.length) | 0];
    const p = new THREE.Mesh(
      new THREE.SphereGeometry((0.06 + Math.random() * 0.13) * scale, 6, 6),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    p.position.copy(pos);
    const sp = (22 + Math.random() * 60) * scale;
    p.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(sp), life: 0.45 + Math.random() * 0.65, maxLife: 1.1, kind: 'debris', drag: 1.1, streak: true };
    group.add(p);
  }

  // 5) Embers — slower glowing motes that linger and cool toward dark red.
  const emberCount = Math.round(12 * scale);
  for (let i = 0; i < emberCount; i++) {
    const p = new THREE.Mesh(
      new THREE.SphereGeometry((0.1 + Math.random() * 0.18) * scale, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xc24a1e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    p.position.copy(pos);
    const sp = (3 + Math.random() * 12) * scale;
    p.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(sp), life: 0.9 + Math.random() * 0.9, maxLife: 1.8, kind: 'ember', drag: 1.1 };
    group.add(p);
  }

  // 6) Lingering smoke — dark puffs that drift, swell, and fade slowly (normal blend so they
  // read as smoke against the bright burst rather than glowing).
  const smokeCount = Math.round(8 * scale);
  for (let i = 0; i < smokeCount; i++) {
    const g = 0.08 + Math.random() * 0.06;
    const m = new THREE.SpriteMaterial({ map: getPuffTex(), color: new THREE.Color(g, g * 0.85, g * 0.8), transparent: true, opacity: 0, depthWrite: false, rotation: Math.random() * Math.PI * 2 });
    const s = new THREE.Sprite(m);
    const sz = (1.6 + Math.random() * 1.8) * scale;
    s.scale.setScalar(sz);
    s.position.copy(pos).add(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * 1.5 * scale));
    const sp = (2 + Math.random() * 6) * scale;
    s.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(sp), life: 1.4 + Math.random() * 1.2, maxLife: 2.6, kind: 'smoke', drag: 1.6, baseScale: sz, growTo: sz * 2.4, spin: (Math.random() - 0.5) * 1.5, peak: 0.5 };
    group.add(s);
  }

  // 7) Capital-ship hull chunks — chunky tumbling fragments of solid wreckage that arc out,
  // glow hot on the leading edge, and trail their own smoke. These give the destruction real
  // mass: it's a ship breaking apart, not just a big spark cloud.
  if (big) {
    const chunkGeos = [
      new THREE.BoxGeometry(1, 0.5, 1.6),
      new THREE.BoxGeometry(0.7, 0.7, 0.7),
      new THREE.TetrahedronGeometry(0.9),
      new THREE.BoxGeometry(1.8, 0.3, 0.6),
    ];
    const chunkCount = Math.round(5 * scale);
    for (let i = 0; i < chunkCount; i++) {
      const geo = chunkGeos[(Math.random() * chunkGeos.length) | 0];
      const sz = (0.6 + Math.random() * 1.4) * (scale * 0.45);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0x4a4f57, emissive: 0xff5a1e, emissiveIntensity: 1.4, roughness: 0.8, metalness: 0.4 })
      );
      mesh.scale.setScalar(sz);
      mesh.position.copy(pos).add(new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * 2 * scale));
      mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      const sp = (8 + Math.random() * 26) * scale * 0.6;
      mesh.userData = {
        vel: new THREE.Vector3().randomDirection().multiplyScalar(sp),
        spinV: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6),
        life: 1.6 + Math.random() * 1.4, maxLife: 3.0, kind: 'chunk', drag: 0.5, smokeAt: 0,
      };
      group.add(mesh);
    }
  }
}

// Spawn a single drifting smoke puff at a position — used by tumbling capital-ship chunks to
// leave a wreckage trail as they spin away. Kept tiny and self-contained.
export function spawnSmokePuff(group, pos, size = 1.2) {
  const g = 0.1 + Math.random() * 0.06;
  const m = new THREE.SpriteMaterial({ map: getPuffTex(), color: new THREE.Color(g, g * 0.8, g * 0.75), transparent: true, opacity: 0, depthWrite: false, rotation: Math.random() * Math.PI * 2 });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.position.copy(pos);
  s.userData = { vel: new THREE.Vector3().randomDirection().multiplyScalar(1.5), life: 0.7 + Math.random() * 0.6, maxLife: 1.3, kind: 'smoke', drag: 1.4, baseScale: size, growTo: size * 2, spin: (Math.random() - 0.5), peak: 0.35 };
  group.add(s);
}
