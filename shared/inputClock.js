// Serial arithmetic is shared with prediction: zero is a valid wrapped sequence.
export function isNewerSequence(next, previous) {
  const delta = (next - previous) >>> 0;
  return delta !== 0 && delta < 0x80000000;
}

export const MAX_INPUT_STEP = 0.05;
export const MAX_MOVEMENT_CREDIT = 0.1;

// Every simulated second, including held-input fallback, spends the same server-clock
// allowance. Packet count and client timestamps can never mint movement time. Up to
// 100 ms may accumulate for jitter/catch-up; whole input frames retain the shared
// integrator's original dt and are acknowledged only after being applied.
export class MovementBudget {
  constructor(now) {
    this.updatedAt = now;
    this.credit = 0;
    this.lastReceivedSeq = null;
  }
  accept(message) {
    if (!Number.isInteger(message?.seq) || message.seq < 0 || message.seq > 0xffffffff
      || typeof message.dt !== 'number' || !Number.isFinite(message.dt) || message.dt <= 0) return false;
    if (this.lastReceivedSeq !== null && !isNewerSequence(message.seq, this.lastReceivedSeq)) return false;
    this.lastReceivedSeq = message.seq;
    return true;
  }
  refill(now) {
    if (!Number.isFinite(now)) return;
    const elapsed = Math.max(0, now - this.updatedAt);
    this.updatedAt = Math.max(this.updatedAt, now);
    this.credit = Math.min(MAX_MOVEMENT_CREDIT, this.credit + elapsed);
  }
  spend(dt) {
    if (!(dt > 0) || !Number.isFinite(dt) || dt > this.credit + 1e-9) return false;
    this.credit = Math.max(0, this.credit - dt);
    return true;
  }
  reset(now) {
    this.updatedAt = now;
    this.credit = 0;
    // Membership/respawn resets never reopen an already accepted sequence range.
  }
}
