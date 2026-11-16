import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import { createArenaServer } from '../index.js';
import { FLIGHT, HEAT, stepShip } from '../shared/flightModel.js';
import { statsFor } from '../rooms/shipStats.js';

// These are actual local Colyseus websocket rooms. Only their monotonic clock and
// automatic ticking are controlled in deterministic cases. No handler is extracted
// or replaced. A test-only barrier acknowledges ordered websocket message delivery.
const DT = 1 / 30, STEER = 0.1;
async function until(predicate, message = 'local room transition timed out', timeout = 2500) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (predicate()) return; await delay(5); }
  assert.fail(message);
}
async function serverFixture(t) {
  const { gameServer, httpServer } = createArenaServer({ voiceBackend: { configured: false }, gracefullyShutdown: false });
  await gameServer.listen(0, '127.0.0.1');
  const api = new Client(`ws://127.0.0.1:${httpServer.address().port}`), clients = new Set();
  t.after(async () => {
    await Promise.allSettled([...clients].filter(c => c.connection?.isOpen).map(c => c.leave()));
    await gameServer.gracefullyShutdown(false);
  });
  function track(c) {
    clients.add(c); c.messages = [];
    c.onMessage('*', (type, data) => c.messages.push({ type, data }));
    c.onMessage('netprobe', msg => c.send('netprobe', msg));
    return c;
  }
  async function arena({ mode = 'ffa', controlled = true, name = 'FAIRNESS' } = {}) {
    const first = track(await api.create('arena', { name, ship: 'lightning' }));
    const room = matchMaker.getRoomById(first.roomId);
    room.onMessage('qaBarrier', (client, value) => client.send('qaBarrier', value));
    let serial = 0, now = room.movementNow();
    if (controlled) { room.setSimulationInterval(); room.movementNow = () => now; }
    async function flush(c = first, messages = []) {
      const marker = ++serial;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(Error('websocket barrier timeout')); }, 2500);
        const off = c.onMessage('qaBarrier', data => { if (data !== marker) return; clearTimeout(timer); off(); resolve(); });
      });
      for (const [type, data] of messages) c.send(type, data);
      c.send('qaBarrier', marker); await response;
    }
    async function pick(c, ship, options = {}) {
      const before = c.messages.length;
      await flush(c, [['setShip', { ship, round: room.state.roundId, ...options }]]);
      const message = c.messages.slice(before).filter(m => m.type === 'shipSelection').at(-1);
      assert.ok(message, 'each ship request receives authoritative shipSelection acknowledgment');
      return message.data;
    }
    const f = { first, room, flush, pick, controlled,
      get now() { return now; },
      tick(seconds = DT) { assert.ok(controlled); now += seconds; room.tick(); },
      async join(name = 'SECOND') { return track(await api.joinById(first.roomId, { name, ship: 'lightning' })); },
      async reconnect(c) {
        const token = c.reconnectionToken, sid = c.sessionId;
        c.connection.close(4001);
        await until(() => room.state.ships.get(sid)?.connected === false, 'server did not enter reconnect grace');
        const next = track(await api.reconnect(token));
        await until(() => room.state.ships.get(sid)?.connected === true, 'server did not restore reserved seat');
        assert.equal(next.sessionId, sid); return next;
      },
      async start(pilots = [first]) {
        for (const c of pilots) await flush(c, [['setReady', { ready: true }]]);
        await flush(first, [['startMatch', undefined]]);
        assert.equal(room.state.matchState, 'live');
        assert.ok(room.state.selectionTimeLeft > 9.9 && room.state.selectionTimeLeft <= 10);
      },
      finishSelection() { f.tick(10.001); assert.equal(room.state.selectionTimeLeft, 0); },
    };
    await flush(first, [['config', { mode, demoBotsEnabled: false }]]);
    assert.equal(room.state.mode, mode); assert.equal(room.state.demoBotsEnabled, false);
    return f;
  }
  return { arena, api, track };
}
function stateOf(f, c = f.first) { return f.room.sim.get(c.sessionId); }
function shipOf(f, c = f.first) { return f.room.state.ships.get(c.sessionId); }
function input(seq, dt = DT, overrides = {}) { return { seq, dt, steerX: STEER, steerY: 0, roll: 0, thrust: false, reverse: false, boost: false, ...overrides }; }
function resetPose(f, c = f.first) {
  const s = stateOf(f, c), ship = shipOf(f, c);
  s.pos = { x: 0, y: 300, z: 0 }; s.vel = { x: 0, y: 0, z: 0 }; s.quat = { x: 0, y: 0, z: 0, w: 1 };
  Object.assign(ship, { px: 0, py: 300, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
}
function simulatedTurnSeconds(f, c = f.first) {
  const q = stateOf(f, c).quat;
  return -2 * Math.atan2(q.y, q.w) / (STEER * FLIGHT.TURN);
}
function closeTo(actual, expected, tolerance, label) { assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} versus ${expected} (tolerance ${tolerance})`); }

test('actual websocket input validation rejects stale/duplicate/malformed frames and accepts uint32 wrap', async t => {
  const service = await serverFixture(t), f = await service.arena(), defaultHull = shipOf(f).ship;
  await f.start(); f.finishSelection();
  assert.equal(shipOf(f).loadoutLocked, true, 'untouched loadout automatically locks at the shared deadline');
  assert.equal(shipOf(f).ship, defaultHull, 'timeout preserves the valid default when no pick was sent');
  resetPose(f);
  // A first uint32 serial may begin anywhere; newer serials wrap through zero.
  for (const seq of [0xfffffffe, 0xffffffff, 0, 1]) {
    await f.flush(f.first, [['input', input(seq, .01)]]); f.tick(.05);
    assert.equal(shipOf(f).lastSeq, seq);
  }
  const s = stateOf(f), baseline = s.lastSeq;
  const invalid = [
    ...[1, 0, 0xffffffff, 0x80000001, -1, 1.25, 2 ** 32, '2', null, NaN, Infinity].map(seq => input(seq)),
    ...[0, -1, NaN, Infinity, -Infinity, undefined, null, '0.02'].map(dt => ({ ...input(100), dt })),
  ];
  for (const frame of invalid) await f.flush(f.first, [['input', frame]]);
  assert.equal(s.inputs.length, 0, 'malformed/stale frames never enter the integration queue');
  f.tick(.05); assert.equal(s.lastSeq, baseline);
  await f.flush(f.first, [['input', input(2, .01)]]); f.tick(.05);
  assert.equal(shipOf(f).lastSeq, 2, 'invalid high sequence did not poison the receive cursor');
  const beforeOversize = simulatedTurnSeconds(f);
  await f.flush(f.first, [['input', input(3, Number.MAX_VALUE)]]); f.tick(.1);
  assert.ok(simulatedTurnSeconds(f) - beforeOversize <= .050001, 'oversized positive dt never integrates more than 50ms');
  assert.ok(Number.isFinite(simulatedTurnSeconds(f)));
});

test('actual websocket movement has one monotonic budget for flood, held-input fallback, stalls and reconnect', async t => {
  const service = await serverFixture(t), f = await service.arena(); await f.start(); f.finishSelection(); resetPose(f);
  let seq = 1;
  await f.flush(f.first, Array.from({ length: 200 }, () => ['input', input(seq++, .05)]));
  assert.ok(stateOf(f).inputs.length <= 128, 'packet flooding keeps a small bounded input queue');
  f.tick(0);
  assert.ok(simulatedTurnSeconds(f) <= .100001, 'initial flood cannot exceed bounded carry credit');
  let last = simulatedTurnSeconds(f);
  for (let i = 0; i < 20; i++) {
    await f.flush(f.first, Array.from({ length: 12 }, () => ['input', input(seq++, .05)]));
    f.tick(0);
  }
  closeTo(simulatedTurnSeconds(f), last, 1e-8, 'repeated ticks without monotonic elapsed time add no movement');
  const elapsedStart = simulatedTurnSeconds(f);
  for (let i = 0; i < 45; i++) {
    if (i % 2 === 0) await f.flush(f.first, Array.from({ length: 10 }, () => ['input', input(seq++, .05)]));
    f.tick(DT);
  }
  const elapsedMovement = simulatedTurnSeconds(f) - elapsedStart;
  assert.ok(elapsedMovement <= 1.600001, `input plus fallback cannot spend more than elapsed time + .1 credit: ${elapsedMovement}`);
  // Packet/server stall may accumulate only 100ms, never the whole multi-second gap.
  await f.flush(f.first, Array.from({ length: 8 }, () => ['input', input(seq++, .05)]));
  last = simulatedTurnSeconds(f); f.tick(4);
  assert.ok(simulatedTurnSeconds(f) - last <= .100001, 'long stall has bounded catch-up');
  for (let i = 0; i < 8; i++) f.tick(0);
  const beforeReconnect = simulatedTurnSeconds(f), deadline = f.room.state.roundId;
  const next = await f.reconnect(f.first);
  await f.flush(next, Array.from({ length: 8 }, () => ['input', input(seq++, .05)]));
  for (let i = 0; i < 8; i++) f.tick(0);
  closeTo(simulatedTurnSeconds(f, next), beforeReconnect, 1e-8, 'reconnect grants no extra simulation credit');
  assert.equal(f.room.state.roundId, deadline); assert.equal(f.room.state.selectionTimeLeft, 0);
});

test('actual websocket normal render rates, low FPS and delivery jitter remain fair', async t => {
  const service = await serverFixture(t), records = [];
  for (const fps of [10, 15, 30, 60, 120, 144, 240, 360]) {
    await t.test(`${fps} FPS producer / 30Hz authoritative tick`, async () => {
      const f = await service.arena({ name: 'FPS' + fps }); await f.start(); f.finishSelection(); resetPose(f);
      let seq = 1, nextFrame = 0;
      const duration = 3, frameDt = Math.min(.05, 1 / fps);
      for (let tick = 1; tick <= duration * 30; tick++) {
        const end = tick * DT, frames = [];
        while (nextFrame < end - 1e-10) { frames.push(['input', input(seq++, frameDt)]); nextFrame += 1 / fps; }
        if (frames.length) await f.flush(f.first, frames);
        f.tick(DT);
      }
      const seconds = simulatedTurnSeconds(f); records.push({ fps, seconds });
      assert.ok(seconds >= duration - .15 && seconds <= duration + .100001, `${fps} FPS applied ${seconds}s for ${duration}s elapsed`);
    });
  }
  await t.test('60 FPS input with two-to-four-tick delivery bursts', async () => {
    const f = await service.arena({ name: 'JITTER' }); await f.start(); f.finishSelection(); resetPose(f);
    let seq = 1, pending = [];
    for (let tick = 1; tick <= 90; tick++) {
      pending.push(['input', input(seq++, 1 / 60)], ['input', input(seq++, 1 / 60)]);
      if (tick % (tick % 3 ? 2 : 4) === 0) { await f.flush(f.first, pending); pending = []; }
      f.tick(DT);
    }
    if (pending.length) await f.flush(f.first, pending);
    const seconds = simulatedTurnSeconds(f);
    assert.ok(seconds >= 2.75 && seconds <= 3.100001, `jitter applied ${seconds}s for 3s elapsed`);
    records.push({ jitter: true, seconds });
  });
  t.diagnostic('Controlled-clock websocket timing: ' + JSON.stringify(records));
});

test('actual websocket straight-flight distance stays comparable across render rates', async t => {
  const service = await serverFixture(t), records = [];
  for (const fps of [10, 30, 60, 144]) {
    const f = await service.arena({ name: 'THRUST' + fps }); await f.start(); f.finishSelection(); resetPose(f);
    let seq = 1, nextFrame = 0;
    for (let tick = 1; tick <= 90; tick++) {
      const frames = [], end = tick * DT;
      while (nextFrame < end - 1e-10) {
        frames.push(['input', input(seq++, Math.min(.05, 1 / fps), { steerX: 0, thrust: true })]);
        nextFrame += 1 / fps;
      }
      if (frames.length) await f.flush(f.first, frames);
      f.tick(DT);
    }
    const s = stateOf(f), distance = -s.pos.z, speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    records.push({ fps, distance, speed });
    assert.ok(distance > 100 && distance < 230, 'sustained thrust produced real bounded movement');
    assert.ok(speed <= FLIGHT.BASE_TOP + 1e-7);
  }
  const baseline = records.find(r => r.fps === 30);
  for (const row of records) assert.ok(Math.abs(row.distance - baseline.distance) / baseline.distance < .03,
    `${row.fps} FPS distance differs from 30 FPS beyond the shared integrator's finite-step allowance`);
  t.diagnostic('Controlled-clock authoritative physical distances: ' + JSON.stringify(records));
});

test('actual websocket changing controls match acknowledged shared-model replay across sequence wrap', async t => {
  const service = await serverFixture(t);
  for (const fps of [30, 60, 144]) {
    const f = await service.arena({ name: 'WAVE' + fps }); await f.start(); f.finishSelection(); resetPose(f);
    const reference = { pos: { ...stateOf(f).pos }, vel: { ...stateOf(f).vel }, quat: { ...stateOf(f).quat } };
    const sent = []; let seq = 0xfffffff0, nextFrame = 0, applied = -1;
    for (let tick = 1; tick <= 90; tick++) {
      const batch = [], end = tick * DT;
      while (nextFrame < end - 1e-10) {
        const i = sent.length, frame = input(seq, 1 / fps, {
          steerX: Math.sin(i * .19) * .6, steerY: Math.cos(i * .13) * .25,
          roll: Math.sin(i * .23) * .35, thrust: i % 17 < 12,
          reverse: i % 17 >= 15, boost: i % 31 < 7,
        });
        seq = (seq + 1) >>> 0; sent.push(frame); batch.push(['input', frame]); nextFrame += 1 / fps;
      }
      await f.flush(f.first, batch); f.tick(DT);
      const ack = shipOf(f).lastSeq;
      const at = sent.findIndex(frame => frame.seq === ack);
      assert.ok(at >= applied, 'acknowledgment never moves backward in the sent serial order');
      while (applied < at) { applied++; stepShip(reference, sent[applied], sent[applied].dt, stateOf(f).speed); }
      const actual = stateOf(f);
      for (const axis of ['x', 'y', 'z']) {
        closeTo(actual.pos[axis], reference.pos[axis], 1e-7, `${fps} FPS position ${axis}`);
        closeTo(actual.vel[axis], reference.vel[axis], 1e-7, `${fps} FPS velocity ${axis}`);
      }
      for (const axis of ['x', 'y', 'z', 'w']) closeTo(actual.quat[axis], reference.quat[axis], 1e-8, `${fps} FPS orientation ${axis}`);
    }
    assert.ok(shipOf(f).lastSeq < 1000, 'sequence wrapped through zero');
    assert.ok(applied >= sent.length - 3, 'normal input stayed close to real-time acknowledgment');
  }
});

test('actual websocket overflow retires stale time without movement and acknowledges retained frames only after application', async t => {
  const service = await serverFixture(t);
  for (const firstSequence of [1, 0xffffff80]) {
    const f = await service.arena(); await f.start(); f.finishSelection(); resetPose(f);
    const batch = Array.from({ length: 200 }, (_, i) => ['input', input((firstSequence + i) >>> 0, .025, {
      steerX: i < 100 ? -.7 : .3, steerY: Math.sin(i) * .1, thrust: i % 2 === 0,
    })]);
    await f.flush(f.first, batch);
    const received = stateOf(f).inputs.map(frame => ({ ...frame }));
    assert.ok(received.length > 4 && received.length <= 128);
    assert.equal(received.at(-1).seq, batch.at(-1)[1].seq);
    assert.equal(received[0].seq, batch.at(-received.length)[1].seq);
    assert.equal(shipOf(f).lastSeq, 0, 'receipt alone does not acknowledge unapplied or unretired frames');
    const retained = received.slice(-4), retired = received.at(-5).seq;
    const reference = { pos: { ...stateOf(f).pos }, vel: { ...stateOf(f).vel }, quat: { ...stateOf(f).quat } };
    // No elapsed clock or credit: retirement must advance the acknowledgment
    // without integrating the stale time into the authoritative pose.
    f.tick(0);
    assert.equal(shipOf(f).lastSeq, retired, 'all intentionally discarded old frames are acknowledged as retired');
    assert.equal(stateOf(f).inputs.length, 4);
    assert.ok(stateOf(f).inputs.reduce((sum, frame) => sum + frame.dt, 0) <= .100000001);
    assert.deepEqual(stateOf(f).pos, reference.pos); assert.deepEqual(stateOf(f).quat, reference.quat);
    f.tick(.05);
    for (const frame of retained.slice(0, 2)) stepShip(reference, frame, frame.dt, stateOf(f).speed);
    assert.equal(shipOf(f).lastSeq, retained[1].seq, 'only the two retained frames fitting 50ms were applied');
    assert.equal(stateOf(f).inputs.length, 2);
    for (const axis of ['x', 'y', 'z']) closeTo(stateOf(f).pos[axis], reference.pos[axis], 1e-8, 'retained replay position');
    for (const axis of ['x', 'y', 'z', 'w']) closeTo(stateOf(f).quat[axis], reference.quat[axis], 1e-8, 'retained replay orientation');
    const ack = shipOf(f).lastSeq, pose = structuredClone(stateOf(f).pos);
    await f.flush(f.first, [['input', input(firstSequence, .025)], ['input', input(retired, .025)], ['input', input(ack, .025)], ['input', input(retained.at(-1).seq, .025)]]);
    f.tick(0);
    assert.equal(shipOf(f).lastSeq, ack); assert.equal(stateOf(f).inputs.length, 2); assert.deepEqual(stateOf(f).pos, pose);
    f.tick(.025); assert.equal(shipOf(f).lastSeq, retained[2].seq, '25ms new credit applies one retained frame');
    f.tick(.025); assert.equal(shipOf(f).lastSeq, retained[3].seq); assert.equal(stateOf(f).inputs.length, 0);
  }
});

test('actual websocket delayed stream yields to opposite steering within 150ms without banking stale movement', async t => {
  const service = await serverFixture(t), f = await service.arena(); await f.start(); f.finishSelection(); resetPose(f);
  let seq = 1;
  await f.flush(f.first, [['input', input(seq++, 1 / 60, { boost: true })]]); f.tick(DT);
  // Model a two-second TCP/app delivery stall: server ticks keep consuming held
  // input; 120 historical frames are withheld and then delivered on the real socket.
  // This controls delivery rather than pretending to impair the OS network stack.
  const withheld = [];
  for (let tick = 0; tick < 60; tick++) {
    withheld.push(['input', input(seq++, 1 / 60, { boost: true })], ['input', input(seq++, 1 / 60, { boost: true })]);
    f.tick(DT);
  }
  withheld.push(['input', input(seq++, 1 / 60, { steerX: -STEER, boost: true })]);
  await f.flush(f.first, withheld);
  const heatBefore = stateOf(f).heat.v, start = f.now;
  let previous = simulatedTurnSeconds(f), respondedAt = null;
  for (let tick = 0; tick < 10; tick++) {
    if (tick) await f.flush(f.first, [['input', input(seq++, 1 / 60, { steerX: -STEER, boost: true })], ['input', input(seq++, 1 / 60, { steerX: -STEER, boost: true })]]);
    f.tick(DT);
    const current = simulatedTurnSeconds(f);
    if (respondedAt === null && current < previous - 1e-8) respondedAt = f.now - start;
    previous = current;
    assert.ok(stateOf(f).inputs.reduce((sum, frame) => sum + frame.dt, 0) <= .100000001, 'queued integration time never exceeds 100ms after the tick');
  }
  assert.ok(respondedAt !== null && respondedAt <= .150001, `opposite steering took ${respondedAt ?? 'more than 333ms'} seconds after delayed delivery`);
  assert.equal(stateOf(f).heat.over, false);
  const appliedSeconds = (stateOf(f).heat.v - heatBefore) / HEAT.RISE;
  assert.ok(appliedSeconds <= (f.now - start) + .100001, 'recovered historical packets cannot mint more movement or engine-heat time');
  t.diagnostic(`Controlled-clock real websocket recovery: opposite steering in ${(respondedAt * 1000).toFixed(1)}ms; ${appliedSeconds.toFixed(3)}s applied over ${(f.now - start).toFixed(3)}s elapsed.`);
});

test('actual websocket snapshots replicate authoritative boost heat, overheat recovery and respawn reset', async t => {
  const service = await serverFixture(t), f = await service.arena(); await f.start(); f.finishSelection(); resetPose(f);
  let seq = 1, firstOverheat = null;
  async function tickHeat(boost) {
    await f.flush(f.first, [['input', input(seq++, 1 / 60, { steerX: 0, boost })], ['input', input(seq++, 1 / 60, { steerX: 0, boost })]]);
    f.tick(DT);
    closeTo(shipOf(f).engineHeat, stateOf(f).heat.v, 1e-8, 'schema heat follows authoritative integration');
    assert.equal(shipOf(f).engineOverheated, stateOf(f).heat.over);
    if (shipOf(f).engineOverheated) assert.equal(shipOf(f).boost, false, 'overheated snapshot does not advertise active boost');
  }
  const start = f.now;
  for (let tick = 0; tick < 96; tick++) { await tickHeat(true); if (firstOverheat === null && stateOf(f).heat.over) firstOverheat = f.now - start; }
  assert.ok(firstOverheat >= 2.9 && firstOverheat < 3.05, `heat tripped after ${firstOverheat}s of boost`);
  assert.equal(shipOf(f).engineOverheated, true);
  assert.ok(shipOf(f).engineHeat > HEAT.RESET && shipOf(f).engineHeat <= HEAT.MAX);
  // Encode and deliver the actual Colyseus schema patch, not an extracted field mapper.
  f.room.broadcastPatch();
  await until(() => f.first.state.ships.get(f.first.sessionId)?.engineOverheated === true, 'overheat snapshot did not reach client');
  closeTo(f.first.state.ships.get(f.first.sessionId).engineHeat, shipOf(f).engineHeat, 1e-6, 'client decoded heat snapshot');
  for (let tick = 0; tick < 60 && stateOf(f).heat.over; tick++) await tickHeat(false);
  assert.equal(stateOf(f).heat.over, false); assert.ok(stateOf(f).heat.v <= HEAT.RESET);
  f.room.broadcastPatch();
  await until(() => f.first.state.ships.get(f.first.sessionId)?.engineOverheated === false, 'cooldown snapshot did not reach client');
  const ship = shipOf(f), sim = stateOf(f);
  f.room.killShip(f.first.sessionId, ship, ''); f.room.respawnShip(f.first.sessionId, ship, sim);
  assert.deepEqual(sim.heat, { v: 0, over: false }); assert.equal(ship.engineHeat, 0); assert.equal(ship.engineOverheated, false);
  f.room.broadcastPatch();
  await until(() => f.first.state.ships.get(f.first.sessionId)?.engineHeat === 0, 'respawn heat reset did not reach client');
  assert.equal(ship.loadoutLocked, true, 'a fresh thermal state does not reopen ship selection');
});

test('actual websocket team loadouts freeze gameplay, validate picks, confirm once, and auto-default at cutoff', async t => {
  const service = await serverFixture(t), f = await service.arena({ mode: 'ctc' }), red = await f.join('RED');
  assert.equal(shipOf(f).team, 0); assert.equal(shipOf(f, red).team, 1);
  await f.start([f.first, red]); const round = f.room.state.roundId;
  assert.ok(round > 0);
  let reply = await f.pick(f.first, 'fury');
  assert.equal(reply.accepted, true); assert.equal(reply.ship, 'fury'); assert.equal(reply.locked, false); assert.equal(reply.round, round);
  assert.equal(shipOf(f).hull, 100 * statsFor('fury').hull);
  reply = await f.pick(f.first, 'bomber');
  assert.equal(reply.accepted, false); assert.equal(reply.ship, 'fury');
  reply = await f.pick(red, 'lightning');
  assert.equal(reply.accepted, false); assert.notEqual(reply.ship, 'lightning');
  for (const bad of ['no-such-hull', '', '__proto__', null, 7]) {
    reply = await f.pick(f.first, bad); assert.equal(reply.accepted, false); assert.equal(shipOf(f).ship, 'fury');
  }
  reply = await f.pick(f.first, 'concept', { confirm: true });
  assert.equal(reply.accepted, true); assert.equal(reply.locked, true); assert.equal(shipOf(f).loadoutLocked, true);
  // Confirmation only locks this pilot; it does not let an early picker fly/shoot
  // while other pilots are still in their shared ten-second selection window.
  const pose = { ...stateOf(f).pos }, missiles = shipOf(f).missiles, chaff = shipOf(f).chaff, fullTime = f.room.state.timeLeft;
  await f.flush(f.first, [['input', input(1, .05, { thrust: true, boost: true })], ['fire', null], ['missile', { target: red.sessionId }], ['chaff', null]]);
  f.tick(3);
  assert.deepEqual(stateOf(f).pos, pose); assert.equal(f.room.state.bolts.size, 0); assert.equal(f.room.state.missiles.size, 0);
  assert.equal(shipOf(f).missiles, missiles); assert.equal(shipOf(f).chaff, chaff); assert.equal(f.room.state.timeLeft, fullTime);
  assert.equal(f.room.state.blueCaptures, 0); assert.equal(f.room.state.redCaptures, 0);
  reply = await f.pick(f.first, 'fury'); assert.equal(reply.accepted, false); assert.equal(reply.ship, 'concept');
  reply = await f.pick(red, 'bomber'); assert.equal(reply.accepted, true); assert.equal(reply.locked, false);
  // At cutoff the last accepted provisional choice becomes final; an untouched
  // pilot likewise retains its valid default, rather than requiring a client timer.
  f.tick(7.001);
  assert.equal(f.room.state.selectionTimeLeft, 0); assert.equal(shipOf(f, red).loadoutLocked, true); assert.equal(shipOf(f, red).ship, 'bomber');
  await f.flush(red);
  assert.ok(red.messages.some(m => m.type === 'shipSelection' && m.data.locked && m.data.remaining === 0 && m.data.round === round));
  const redShip = shipOf(f, red), redSim = stateOf(f, red);
  redShip.hull = 17; redShip.shields = 3; redShip.missiles = 0;
  reply = await f.pick(red, 'fighter'); assert.equal(reply.accepted, false); assert.equal(reply.ship, 'bomber');
  assert.equal(redShip.hull, 17); assert.equal(redShip.shields, 3); assert.equal(redShip.missiles, 0);
  // Exercise actual death and respawn methods without waiting the death timer.
  f.room.killShip(red.sessionId, redShip, ''); f.room.respawnShip(red.sessionId, redShip, redSim);
  assert.equal(redShip.ship, 'bomber'); assert.equal(redShip.loadoutLocked, true);
  redShip.hull = 12; redShip.shields = 2; redShip.missiles = 0;
  reply = await f.pick(red, 'interceptor'); assert.equal(reply.accepted, false);
  assert.equal(redShip.hull, 12); assert.equal(redShip.shields, 2); assert.equal(redShip.missiles, 0);
  // Direct lifecycle trigger: there is no public rematch command in this build.
  f.room.startMatch(); const nextRound = f.room.state.roundId;
  assert.notEqual(nextRound, round); assert.equal(shipOf(f).loadoutLocked, false); assert.equal(redShip.loadoutLocked, false);
  assert.ok(f.room.state.selectionTimeLeft > 9.9);
  reply = await f.pick(red, 'fighter', { round }); assert.equal(reply.accepted, false); assert.equal(redShip.ship, 'bomber');
  reply = await f.pick(red, 'fighter'); assert.equal(reply.accepted, true); assert.equal(reply.round, nextRound);
});

test('actual websocket ship-selection status queries are accepted without changing the choice, lock or deadline', async t => {
  const service = await serverFixture(t), f = await service.arena();
  async function queryUnchanged() {
    const ship = shipOf(f), beforeMessages = f.first.messages.length;
    const before = { ship: ship.ship, locked: ship.loadoutLocked, deadline: f.room._selectionEndsAt,
      remaining: f.room.state.selectionTimeLeft, round: f.room.state.roundId,
      hull: ship.hull, shields: ship.shields, missiles: ship.missiles };
    await f.flush(f.first, [['getShipSelection', undefined]]);
    const reply = f.first.messages.slice(beforeMessages).filter(m => m.type === 'shipSelection').at(-1)?.data;
    assert.ok(reply, 'status query returns a shipSelection reply');
    assert.equal(reply.accepted, true, 'a status query is not a rejected ship choice');
    assert.deepEqual(reply, { ship: before.ship, accepted: true, locked: before.locked,
      remaining: before.remaining, round: before.round });
    assert.deepEqual({ ship: ship.ship, locked: ship.loadoutLocked, deadline: f.room._selectionEndsAt,
      remaining: f.room.state.selectionTimeLeft, round: f.room.state.roundId,
      hull: ship.hull, shields: ship.shields, missiles: ship.missiles }, before);
  }
  await queryUnchanged();
  await f.start(); f.tick(2);
  let reply = await f.pick(f.first, 'fury'); assert.equal(reply.accepted, true); assert.equal(reply.locked, false);
  await queryUnchanged();
  reply = await f.pick(f.first, 'concept', { confirm: true }); assert.equal(reply.locked, true);
  Object.assign(shipOf(f), { hull: 23, shields: 7, missiles: 0 });
  await queryUnchanged();
  reply = await f.pick(f.first, 'fighter'); assert.equal(reply.accepted, false);
  await queryUnchanged();
  f.tick(8.001); assert.equal(f.room.state.selectionTimeLeft, 0);
  await queryUnchanged();
});

test('actual websocket FFA rejects inherited-property and unknown hull identifiers', async t => {
  const service = await serverFixture(t), f = await service.arena(); await f.start();
  const initial = shipOf(f).ship;
  for (const bad of ['__proto__', 'constructor', 'no-such-hull', '', null, 7]) {
    const reply = await f.pick(f.first, bad);
    assert.equal(reply.accepted, false, `invalid FFA hull ${String(bad)} must be rejected`);
    assert.equal(shipOf(f).ship, initial);
    assert.ok(Number.isFinite(shipOf(f).hull)); assert.ok(Number.isFinite(shipOf(f).shields));
  }
  for (const bad of ['__proto__', 'constructor']) {
    const pilot = service.track(await service.api.joinById(f.first.roomId, { name: 'INVALID-JOIN', ship: bad }));
    assert.notEqual(shipOf(f, pilot).ship, bad);
    assert.ok(Number.isFinite(shipOf(f, pilot).hull)); assert.ok(Number.isFinite(shipOf(f, pilot).shields));
  }
});

test('actual websocket FFA permits every hull but selection deadlines survive reconnect and late joins', async t => {
  const service = await serverFixture(t), f = await service.arena(); await f.start();
  const round = f.room.state.roundId;
  for (const hull of ['concept', 'fury', 'lightning', 'interceptor', 'fighter', 'bomber']) {
    const reply = await f.pick(f.first, hull); assert.equal(reply.accepted, true); assert.equal(reply.ship, hull);
  }
  f.tick(2); const next = await f.reconnect(f.first);
  let reply = await f.pick(next, 'fury');
  assert.equal(reply.accepted, true); assert.equal(reply.round, round); closeTo(reply.remaining, 8, .01, 'reconnect keeps original deadline');
  const late = await f.join('LATE');
  reply = await f.pick(late, 'fighter'); assert.equal(reply.accepted, true); closeTo(reply.remaining, 8, .01, 'late join shares deadline');
  f.tick(7.99); reply = await f.pick(next, 'bomber'); assert.equal(reply.accepted, true); assert.ok(reply.remaining > 0 && reply.remaining < .02);
  f.tick(.01); reply = await f.pick(next, 'lightning');
  assert.equal(reply.accepted, false); assert.equal(reply.locked, true); assert.equal(reply.remaining, 0); assert.equal(shipOf(f, next).ship, 'bomber');
  const post = await f.join('AFTER'); assert.equal(shipOf(f, post).loadoutLocked, true);
  const defaultHull = shipOf(f, post).ship;
  reply = await f.pick(post, 'bomber'); assert.equal(reply.accepted, false); assert.equal(reply.ship, defaultHull); assert.equal(reply.remaining, 0);
  const rejoinedAgain = await f.reconnect(next); reply = await f.pick(rejoinedAgain, 'lightning');
  assert.equal(reply.accepted, false); assert.equal(reply.locked, true); assert.equal(reply.remaining, 0); assert.equal(reply.round, round);
});

test('real-wall-clock websocket smoke freezes ten-second selection and then applies normal-rate input', { timeout: 16000 }, async t => {
  const service = await serverFixture(t), f = await service.arena({ controlled: false, name: 'WALLCLOCK' });
  const startedAt = performance.now(); await f.start();
  await f.pick(f.first, 'lightning', { confirm: true });
  await f.flush(f.first, [['input', input(1, DT, { thrust: true })], ['fire', null]]);
  const startPose = { ...stateOf(f).pos };
  await delay(100); assert.deepEqual(stateOf(f).pos, startPose); assert.equal(f.room.state.bolts.size, 0);
  await until(() => f.room.state.selectionTimeLeft === 0, 'real deadline did not expire', 12000);
  const selectionMs = performance.now() - startedAt;
  assert.ok(selectionMs >= 9900 && selectionMs < 12000, `wall-clock selection lasted ${selectionMs} ms`);
  resetPose(f); let seq = 2;
  const start = performance.now(), interval = setInterval(() => f.first.send('input', input(seq++, 1 / 60)), 1000 / 60);
  try { await delay(650); } finally { clearInterval(interval); }
  await f.flush();
  const elapsed = (performance.now() - start) / 1000, applied = simulatedTurnSeconds(f);
  assert.ok(applied >= elapsed - .16 && applied <= elapsed + .11, `real-wall input applied ${applied}s in ${elapsed}s`);
  assert.ok(shipOf(f).lastSeq > 10);
  t.diagnostic(`Real wall clock: selection ${selectionMs.toFixed(1)}ms; movement ${applied.toFixed(3)}s / ${elapsed.toFixed(3)}s elapsed. No rendering or WAN latency tested.`);
});
