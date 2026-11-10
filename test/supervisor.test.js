import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor } from '../src/supervisor.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function fakeSender({ failures = 0 } = {}) {
  return {
    starts: 0,
    ready: false,
    async start() {
      this.starts += 1;
      if (this.starts <= failures) throw new Error('boom');
      this.ready = true;
    },
    isReady() {
      return this.ready;
    }
  };
}

test('tick backs off exponentially and clamps at maxDelayMs', async () => {
  const sender = fakeSender({ failures: 5 });
  const supervisor = createSupervisor({ sender, logger: silent, minDelayMs: 1000, maxDelayMs: 1500 });

  const first = await supervisor.tick();
  assert.equal(first.connected, false);
  assert.equal(first.waitMs, 1000);

  const second = await supervisor.tick();
  assert.equal(second.waitMs, 1500);

  const third = await supervisor.tick();
  assert.equal(third.waitMs, 1500);
});

test('tick connects, then only checks readiness', async () => {
  const sender = fakeSender({ failures: 2 });
  const supervisor = createSupervisor({ sender, logger: silent, checkIntervalMs: 2000 });

  assert.equal((await supervisor.tick()).connected, false);
  assert.equal((await supervisor.tick()).connected, false);

  const ok = await supervisor.tick();
  assert.equal(ok.connected, true);
  assert.equal(ok.started, true);
  assert.equal(ok.waitMs, 2000);

  const idle = await supervisor.tick();
  assert.equal(idle.started, false);
  assert.equal(sender.starts, 3);
});

test('start/stop does not wait for a long backoff timer', async () => {
  const sender = fakeSender({ failures: 100 });
  const supervisor = createSupervisor({ sender, logger: silent, minDelayMs: 60000, maxDelayMs: 60000 });

  supervisor.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  await supervisor.stop();
  assert.ok(Date.now() - started < 1000, 'stop woke the supervisor');
  assert.ok(sender.starts >= 1);
});
