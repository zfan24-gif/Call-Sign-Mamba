// ---- Shared authoritative flight model (Call Sign Mamba multiplayer) --------------------------
// This is the SINGLE SOURCE OF TRUTH for how a ship moves. It is imported by BOTH the server (for
// the authoritative simulation) and — via a thin re-export — by the browser client (for
// client-side prediction). Keeping the integration math in one place is what lets prediction and
// server reconciliation agree; if the two sides diverge, remote ships jitter and the local ship
// rubber-bands. Do not fork this logic — change it here and both sides stay in lockstep.
//
// The model mirrors the single-player updatePlayer() flight feel from main.js:
//   - Mouse-style steering offset (x,y in ~[-1.4,1.4]) maps to a pitch/yaw turn RATE.
//   - Roll comes from bank input (strafeLeft/Right).
//   - Thrust accelerates along the ship's nose (local -Z); reverse pushes back at 65%.
//   - Boost multiplies top speed / thrust; drag differs when thrusting vs. coasting.
//
// Everything here is plain math on {x,y,z} vectors and a {x,y,z,w} quaternion so it has ZERO
// dependency on THREE.js — the server stays dependency-light and the client adapts THREE objects
// to these plain shapes at the call site.

// Base tuning — copied verbatim from the single-player values so multiplayer flies the same.
export const FLIGHT = {
  TURN: 2.6,          // max pitch/yaw rate (rad/s) at full steering deflection
  ROLL: 2.2,          // roll rate (rad/s) from bank input
  THRUST_ACCEL: 70,   // forward acceleration (units/s^2) before speedMod
  REVERSE: 0.65,      // reverse thrust fraction
  BOOST_MULT: 1.55,   // boost speed/thrust multiplier
  DRAG_THRUST: 0.28,  // light drag while thrusting (lets the ship reach top speed)
  DRAG_COAST: 1.8,    // strong drag while coasting (bleeds to a true idle)
  BASE_TOP: 74,       // base top speed (units/s) before speedMod
  // Arena boundary: a gentle restoring nudge once a ship drifts past this radius (keeps 24 pilots
  // in a shared, findable volume without hard walls). Matches the single-player "leash" idea.
  BOUNDARY: 1500,
  BOUNDARY_PULL: 0.5,
};

// ---- Tiny quaternion helpers (no THREE dependency) -------------------------------------------
// Rotate a quaternion q by a LOCAL-space euler delta (pitch about X, yaw about Y, roll about Z),
// applied in XYZ order and post-multiplied so it composes in the ship's own frame — exactly like
// player.quaternion.multiply(qDelta) in the single-player loop. Returns a normalized quaternion.
export function integrateQuat(q, pitch, yaw, roll) {
  // Build the delta quaternion from the XYZ euler (cx = cos(pitch/2), etc.).
  const cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2),   sy = Math.sin(yaw / 2);
  const cz = Math.cos(roll / 2),  sz = Math.sin(roll / 2);
  // XYZ order: qDelta = qx * qy * qz.
  const dqx = sx * cy * cz + cx * sy * sz;
  const dqy = cx * sy * cz - sx * cy * sz;
  const dqz = cx * cy * sz + sx * sy * cz;
  const dqw = cx * cy * cz - sx * sy * sz;
  // Post-multiply: out = q * qDelta.
  const ox = q.w * dqx + q.x * dqw + q.y * dqz - q.z * dqy;
  const oy = q.w * dqy - q.x * dqz + q.y * dqw + q.z * dqx;
  const oz = q.w * dqz + q.x * dqy - q.y * dqx + q.z * dqw;
  const ow = q.w * dqw - q.x * dqx - q.y * dqy - q.z * dqz;
  // Normalize.
  const inv = 1 / (Math.hypot(ox, oy, oz, ow) || 1);
  return { x: ox * inv, y: oy * inv, z: oz * inv, w: ow * inv };
}

// Rotate the unit vector (0,0,-1) — the ship's nose — by quaternion q. Returns {x,y,z}.
export function forwardFromQuat(q) {
  // v = (0,0,-1). Standard q * v * q^-1 specialized for v=(0,0,-1).
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return {
    x: -2 * (x * z + w * y),
    y: -2 * (y * z - w * x),
    z: -(1 - 2 * (x * x + y * y)),
  };
}

// Advance one ship's kinematic state by `dt` seconds given a normalized INPUT frame.
// state: { pos:{x,y,z}, vel:{x,y,z}, quat:{x,y,z,w} } — mutated in place.
// input: { steerX, steerY, roll (-1..1), thrust(bool), reverse(bool), boost(bool) }.
// This is the authoritative integrator; call it on the server every tick, and on the client for
// prediction of the LOCAL ship only.
// `speedScale` (default 1) is the per-hull speed multiplier from the ship balance table. It scales
// BOTH thrust acceleration and top speed so a faster hull actually pulls ahead while still handling
// consistently. The client passes the SAME value for its local prediction so the two never diverge.
export function stepShip(state, input, dt, speedScale = 1) {
  const steerX = clamp(input.steerX || 0, -1.4, 1.4);
  const steerY = clamp(input.steerY || 0, -1.4, 1.4);
  const rollIn = clamp(input.roll || 0, -1, 1);

  // Attitude: steering offset -> turn rate, integrated into the quaternion in local space.
  const pitchRate = -steerY * FLIGHT.TURN;
  const yawRate   = -steerX * FLIGHT.TURN;
  const rollRate  =  rollIn * FLIGHT.ROLL;
  state.quat = integrateQuat(state.quat, pitchRate * dt, yawRate * dt, rollRate * dt);

  // Thrust along the nose (local -Z), with reverse at 65%.
  const fwd = forwardFromQuat(state.quat);
  let ax = 0, ay = 0, az = 0, accel = false;
  if (input.thrust) { ax += fwd.x; ay += fwd.y; az += fwd.z; accel = true; }
  if (input.reverse) { ax -= fwd.x * FLIGHT.REVERSE; ay -= fwd.y * FLIGHT.REVERSE; az -= fwd.z * FLIGHT.REVERSE; accel = true; }

  const boost = !!input.boost;
  const hullScale = Number.isFinite(speedScale) && speedScale > 0 ? speedScale : 1;
  const speedMod = (boost ? FLIGHT.BOOST_MULT : 1) * hullScale;

  if (ax || ay || az) {
    const len = Math.hypot(ax, ay, az) || 1;
    const k = FLIGHT.THRUST_ACCEL * speedMod * dt / len;
    state.vel.x += ax * k; state.vel.y += ay * k; state.vel.z += az * k;
  }

  // Drag: light while thrusting, strong while coasting.
  const drag = accel ? FLIGHT.DRAG_THRUST : FLIGHT.DRAG_COAST;
  state.vel.x -= state.vel.x * drag * dt;
  state.vel.y -= state.vel.y * drag * dt;
  state.vel.z -= state.vel.z * drag * dt;

  // Snap tiny residual velocity to a dead stop while coasting so idle is truly idle.
  const speed2 = state.vel.x * state.vel.x + state.vel.y * state.vel.y + state.vel.z * state.vel.z;
  if (!accel && speed2 < 1) { state.vel.x = 0; state.vel.y = 0; state.vel.z = 0; }

  // Clamp to top speed.
  const top = FLIGHT.BASE_TOP * speedMod;
  const speed = Math.sqrt(speed2);
  if (speed > top) {
    const s = top / speed;
    state.vel.x *= s; state.vel.y *= s; state.vel.z *= s;
  }

  // Integrate position.
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  state.pos.z += state.vel.z * dt;

  // Soft arena boundary: nudge back toward center once well outside the leash radius.
  const dist = Math.hypot(state.pos.x, state.pos.y, state.pos.z);
  if (dist > FLIGHT.BOUNDARY) {
    const over = dist - FLIGHT.BOUNDARY;
    const nx = state.pos.x / dist, ny = state.pos.y / dist, nz = state.pos.z / dist;
    const pull = over * FLIGHT.BOUNDARY_PULL * dt;
    state.vel.x -= nx * pull; state.vel.y -= ny * pull; state.vel.z -= nz * pull;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
