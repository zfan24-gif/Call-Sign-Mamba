// ---- Client copy of the shared authoritative flight model ------------------------------------
// This MUST stay byte-for-byte behaviorally identical to /server-realtime/shared/flightModel.js.
// The browser can't import from the separate Node server package, so the integrator is mirrored
// here for client-side PREDICTION. If you change the flight math on the server, change it here too —
// if the two diverge, the local ship rubber-bands on every server correction.
//
// Plain-math, no THREE dependency (the caller adapts THREE objects to {x,y,z} / {x,y,z,w} shapes).

export const FLIGHT = {
  TURN: 2.6, ROLL: 2.2, THRUST_ACCEL: 70, REVERSE: 0.65, BOOST_MULT: 1.55,
  DRAG_THRUST: 0.28, DRAG_COAST: 1.8, BASE_TOP: 74, BOUNDARY: 1500, BOUNDARY_PULL: 0.5,
};

export function integrateQuat(q, pitch, yaw, roll) {
  const cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2),   sy = Math.sin(yaw / 2);
  const cz = Math.cos(roll / 2),  sz = Math.sin(roll / 2);
  const dqx = sx * cy * cz + cx * sy * sz;
  const dqy = cx * sy * cz - sx * cy * sz;
  const dqz = cx * cy * sz + sx * sy * cz;
  const dqw = cx * cy * cz - sx * sy * sz;
  const ox = q.w * dqx + q.x * dqw + q.y * dqz - q.z * dqy;
  const oy = q.w * dqy - q.x * dqz + q.y * dqw + q.z * dqx;
  const oz = q.w * dqz + q.x * dqy - q.y * dqx + q.z * dqw;
  const ow = q.w * dqw - q.x * dqx - q.y * dqy - q.z * dqz;
  const inv = 1 / (Math.hypot(ox, oy, oz, ow) || 1);
  return { x: ox * inv, y: oy * inv, z: oz * inv, w: ow * inv };
}

export function forwardFromQuat(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  return {
    x: -2 * (x * z + w * y),
    y: -2 * (y * z - w * x),
    z: -(1 - 2 * (x * x + y * y)),
  };
}

// `speedScale` (default 1) is the per-hull speed multiplier — MUST match the value the server
// applies for this player's ship, or the local prediction will rubber-band on each correction.
export function stepShip(state, input, dt, speedScale = 1) {
  const steerX = clamp(input.steerX || 0, -1.4, 1.4);
  const steerY = clamp(input.steerY || 0, -1.4, 1.4);
  const rollIn = clamp(input.roll || 0, -1, 1);

  const pitchRate = -steerY * FLIGHT.TURN;
  const yawRate   = -steerX * FLIGHT.TURN;
  const rollRate  =  rollIn * FLIGHT.ROLL;
  state.quat = integrateQuat(state.quat, pitchRate * dt, yawRate * dt, rollRate * dt);

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

  const drag = accel ? FLIGHT.DRAG_THRUST : FLIGHT.DRAG_COAST;
  state.vel.x -= state.vel.x * drag * dt;
  state.vel.y -= state.vel.y * drag * dt;
  state.vel.z -= state.vel.z * drag * dt;

  const speed2 = state.vel.x * state.vel.x + state.vel.y * state.vel.y + state.vel.z * state.vel.z;
  if (!accel && speed2 < 1) { state.vel.x = 0; state.vel.y = 0; state.vel.z = 0; }

  const top = FLIGHT.BASE_TOP * speedMod;
  const speed = Math.sqrt(speed2);
  if (speed > top) {
    const s = top / speed;
    state.vel.x *= s; state.vel.y *= s; state.vel.z *= s;
  }

  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  state.pos.z += state.vel.z * dt;

  const dist = Math.hypot(state.pos.x, state.pos.y, state.pos.z);
  if (dist > FLIGHT.BOUNDARY) {
    const over = dist - FLIGHT.BOUNDARY;
    const nx = state.pos.x / dist, ny = state.pos.y / dist, nz = state.pos.z / dist;
    const pull = over * FLIGHT.BOUNDARY_PULL * dt;
    state.vel.x -= nx * pull; state.vel.y -= ny * pull; state.vel.z -= nz * pull;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
