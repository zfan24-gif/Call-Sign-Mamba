// Approved local-space laser sockets measured on the assembled arena hulls.
const ports = Object.freeze({
  interceptor: [[-0.4439136, 0.1095215, -0.4322863], [-0.5132751, 0.1410631, -0.2867971], [0.4439136, 0.108018, -0.4162691], [0.5132751, 0.167439, -0.1893024]],
  fighter: [[-0.4479471, 0.0509409, -0.2524448], [-0.5319372, 0.0620163, -0.2477816], [0.4479471, 0.0509409, -0.2524448], [0.5319372, 0.0620163, -0.2477816]],
  bomber: [[-1.0686595, 0, -3.088315], [-1.1723823, 0, -3.092714], [1.0686595, 0, -3.087392], [1.1723823, 0, -3.0928735]],
});

// One accepted trigger keeps its existing damage, cadence and network projectile budget.
// Rotate the next authored socket with the authoritative ship attitude.
export function nextICXMuzzle(shipId, sim) {
  const bank = ports[shipId];
  if (!bank) return null;
  const slot = (sim.nextICXPort || 0) % bank.length;
  sim.nextICXPort = (slot + 1) % bank.length;
  const [x,y,z] = bank[slot], q = sim.quat;
  const tx = 2 * (q.y*z - q.z*y), ty = 2 * (q.z*x - q.x*z), tz = 2 * (q.x*y - q.y*x);
  return {slot, x:x + q.w*tx + q.y*tz - q.z*ty,
                y:y + q.w*ty + q.z*tx - q.x*tz,
                z:z + q.w*tz + q.x*ty - q.y*tx};
}
