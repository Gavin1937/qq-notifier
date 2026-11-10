import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { classifySendError, createWorker } from '../src/queue.js';

const QUEUE = {
  max_attempts: 3,
  backoff_ms: [2000, 8000, 30000],
  cooldown_ms: 300000,
  cooldown_max_ms: 3600000,
  halt_after_abandons: 5,
  max_outbox: 1000,
  send_rate_per_second: 1,
  history_keep: 1000
};

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function httpError(status) {
  const error = new Error(`http ${status}`);
  error.httpStatus = status;
  return error;
}

function setup({ queue = {}, results = [], historyKeep = 1000 } = {}) {
  const db = openDb(':memory:', { historyKeep });
  const clock = {
    t: 1_000_000,
    now() {
      return this.t;
    },
    advance(ms) {
      this.t += ms;
    }
  };
  const sender = {
    ready: true,
    sent: [],
    results: [...results],
    isReady() {
      return this.ready;
    },
    async send(message) {
      this.sent.push(message);
      if (this.results.length) throw this.results.shift();
    }
  };
  const worker = createWorker({
    db,
    sender,
    queue: { ...QUEUE, ...queue },
    logger: silent,
    now: () => clock.now()
  });
  let seq = 0;
  const enqueue = (body, { key = null, at = null } = {}) => {
    seq += 1;
    return db.enqueue({
      id: seq.toString(16).padStart(8, '0'),
      body,
      key,
      receivedAt: at ?? clock.now() + seq
    });
  };
  return { db, clock, sender, worker, enqueue };
}

/** Drive one message through all attempts until it is abandoned. */
async function abandonOne(ctx) {
  const { worker, clock } = ctx;
  assert.equal(await worker.tick(), 'retry');
  clock.advance(2000);
  assert.equal(await worker.tick(), 'retry');
  clock.advance(8000);
  assert.equal(await worker.tick(), 'abandoned');
}

test('delivers oldest first and commits to history', async () => {
  const ctx = setup();
  ctx.enqueue('second', { at: 2_000_000 });
  ctx.enqueue('first', { at: 1_000_000 });

  assert.equal(await ctx.worker.tick(), 'sent');
  assert.equal(ctx.sender.sent.length, 1);
  assert.match(ctx.sender.sent[0].markdown, /first/);
  assert.equal(ctx.db.countOutbox(), 1);

  assert.equal(await ctx.worker.tick(), 'sent');
  assert.match(ctx.sender.sent[1].markdown, /second/);
  assert.equal(ctx.db.countOutbox(), 0);

  const history = ctx.db.listHistory(10);
  assert.equal(history.length, 2);
  assert.ok(history.every((row) => row.status === 'sent' && row.attempts === 1));
});

test('renders header, two newlines, optional key', async () => {
  const ctx = setup();
  ctx.enqueue('download finished', { key: 'build-42', at: 1_000_000 });
  await ctx.worker.tick();
  const { markdown, plain } = ctx.sender.sent[0];
  assert.match(markdown, /^\*\*\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] #build-42\*\*\n\ndownload finished$/);
  assert.match(plain, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] #build-42\n\ndownload finished$/);
});

test('retries with backoff and does not send before next_attempt_at', async () => {
  const ctx = setup({ results: [httpError(500)] });
  ctx.enqueue('flaky', { at: 1_000_000 });

  assert.equal(await ctx.worker.tick(), 'retry');
  assert.equal(ctx.sender.sent.length, 1);
  const row = ctx.db.listOutbox(1)[0];
  assert.equal(row.attempts, 1);
  assert.equal(row.next_attempt_at, 1_000_000 + 2000);

  ctx.clock.advance(1000);
  assert.equal(await ctx.worker.tick(), 'idle');
  assert.equal(ctx.sender.sent.length, 1);

  ctx.clock.advance(1000);
  assert.equal(await ctx.worker.tick(), 'sent');
  assert.equal(ctx.sender.sent.length, 2);
});

test('abandons after max_attempts and records the row', async () => {
  const ctx = setup({ results: [httpError(400), httpError(400), httpError(400)] });
  ctx.enqueue('poison', { at: 1_000_000 });
  await abandonOne(ctx);

  assert.equal(ctx.db.countOutbox(), 0);
  const history = ctx.db.listHistory(10);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'abandoned');
  assert.equal(history[0].attempts, 3);
  assert.equal(ctx.db.getRuntime('failure_streak'), '1');
  assert.equal(ctx.db.getRuntime('cooldown_until'), null);
});

test('unreachable errors keep the attempt counter and delay 5s', async () => {
  const ctx = setup({ results: [httpError(503)] });
  ctx.enqueue('offline', { at: 1_000_000 });

  assert.equal(await ctx.worker.tick(), 'unreachable');
  const row = ctx.db.listOutbox(1)[0];
  assert.equal(row.attempts, 0);
  assert.equal(row.next_attempt_at, 1_000_000 + 5000);
  assert.equal(ctx.db.countOutbox(), 1);
});

test('not-ready pauses without consuming attempts', async () => {
  const ctx = setup();
  ctx.sender.ready = false;
  ctx.enqueue('wait', { at: 1_000_000 });

  assert.equal(await ctx.worker.tick(), 'not-ready');
  assert.equal(ctx.db.listOutbox(1)[0].attempts, 0);
  assert.equal(ctx.sender.sent.length, 0);
});

test('second consecutive abandon starts the cooldown, third doubles it', async () => {
  const ctx = setup({
    results: Array(9).fill(httpError(400))
  });
  ctx.enqueue('one', { at: 1_000_000 });
  ctx.enqueue('two', { at: 1_000_100 });

  await abandonOne(ctx);
  assert.equal(ctx.db.getRuntime('failure_streak'), '1');
  assert.equal(await ctx.worker.tick(), 'retry');
  ctx.clock.advance(2000);
  assert.equal(await ctx.worker.tick(), 'retry');
  ctx.clock.advance(8000);
  assert.equal(await ctx.worker.tick(), 'abandoned');

  assert.equal(ctx.db.getRuntime('failure_streak'), '2');
  const cooldownUntil = Number(ctx.db.getRuntime('cooldown_until'));
  assert.equal(cooldownUntil, ctx.clock.t + 300000);
  assert.equal(await ctx.worker.tick(), 'cooldown');

  ctx.clock.advance(300000);
  ctx.enqueue('three', { at: ctx.clock.t + 1 });
  await abandonOne(ctx);
  assert.equal(ctx.db.getRuntime('failure_streak'), '3');
  assert.equal(Number(ctx.db.getRuntime('cooldown_until')), ctx.clock.t + 600000);
});

test('halts after halt_after_abandons consecutive failures and resumes', async () => {
  const ctx = setup({ results: Array(15).fill(httpError(400)), queue: { halt_after_abandons: 5 } });
  for (let i = 0; i < 5; i += 1) {
    ctx.enqueue(`msg-${i}`, { at: ctx.clock.t + 1 });
    await abandonOne(ctx);
    ctx.clock.advance(Number(ctx.db.getRuntime('cooldown_until') ?? ctx.clock.t) - ctx.clock.t + 1);
  }

  assert.equal(ctx.db.getRuntime('halted'), '1');
  assert.equal(await ctx.worker.tick(), 'halted');

  ctx.worker.resume();
  assert.equal(ctx.db.getRuntime('halted'), null);
  assert.equal(ctx.db.getRuntime('failure_streak'), null);

  ctx.enqueue('after-resume', { at: ctx.clock.t + 1 });
  assert.equal(await ctx.worker.tick(), 'sent');
});

test('successful delivery resets the failure streak', async () => {
  const ctx = setup({ results: [httpError(400), httpError(400), httpError(400)] });
  ctx.enqueue('poison', { at: 1_000_000 });
  await abandonOne(ctx);
  assert.equal(ctx.db.getRuntime('failure_streak'), '1');

  ctx.enqueue('good', { at: ctx.clock.t + 1 });
  assert.equal(await ctx.worker.tick(), 'sent');
  assert.equal(ctx.db.getRuntime('failure_streak'), null);
});

test('history is pruned to history_keep rows', async () => {
  const ctx = setup({ historyKeep: 2 });
  for (let i = 0; i < 4; i += 1) {
    ctx.enqueue(`m${i}`, { at: ctx.clock.t + 1 });
    assert.equal(await ctx.worker.tick(), 'sent');
    ctx.clock.advance(1);
  }
  const history = ctx.db.listHistory(10);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((row) => row.body), ['m3', 'm2']);
});

test('classifySendError maps classes', () => {
  assert.equal(classifySendError(httpError(503)), 'unreachable');
  assert.equal(classifySendError(httpError(400)), 'rejected');
  assert.equal(classifySendError(httpError(404)), 'rejected');
  assert.equal(classifySendError(httpError(500)), 'uncertain');
  const timeout = new Error('timeout');
  timeout.code = 'ETIMEDOUT';
  assert.equal(classifySendError(timeout), 'uncertain');
  assert.equal(classifySendError(new TypeError('fetch failed')), 'uncertain');
});
