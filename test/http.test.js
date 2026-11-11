import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createHttpHandler } from '../src/http.js';

async function harness({ token = null, maxOutbox = 1000 } = {}) {
  const db = openDb(':memory:');
  const counts = { wake: 0, resume: 0 };
  const worker = {
    wake() {
      counts.wake += 1;
    },
    resume() {
      counts.resume += 1;
    },
    state() {
      return { halted: false, cooldownUntil: 0, streak: 0 };
    }
  };
  const sender = { isReady: () => true };
  const config = { server: { token, max_body_bytes: 65536 }, queue: { max_outbox: maxOutbox } };
  const handler = createHttpHandler({ db, config, worker, sender, version: 'test' });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    counts,
    base,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

const json = (text, key) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(key === undefined ? { text } : { text, key }) });

test('POST /notify with JSON enqueues and returns 202', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/notify`, json('hello world', 'build-42'));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.match(body.id, /^[0-9a-f]{16}$/);
  assert.equal(typeof body.queued_at, 'number');

  assert.equal(h.db.countOutbox(), 1);
  const row = h.db.listOutbox(1)[0];
  assert.equal(row.body, 'hello world');
  assert.equal(row.user_key, 'build-42');
  assert.equal(h.counts.wake, 1);
});

test('POST /notify accepts text/plain bodies', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'download finished'
  });
  assert.equal(response.status, 202);
  assert.equal(h.db.listOutbox(1)[0].body, 'download finished');
});

test('POST /notify rejects empty text and oversized text', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const empty = await fetch(`${h.base}/notify`, json('   '));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'empty_text');

  const big = await fetch(`${h.base}/notify`, json('x'.repeat(12001)));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'text_too_large');
  assert.equal(h.db.countOutbox(), 0);
});

test('POST /notify rejects malformed JSON', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ nope'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_json');
});

test('token auth accepts header and bearer, rejects missing or wrong', async (t) => {
  const h = await harness({ token: 'sekret' });
  t.after(() => h.close());

  assert.equal((await fetch(`${h.base}/notify`, json('x'))).status, 401);
  assert.equal((await fetch(`${h.base}/notify`, {
    ...json('x'),
    headers: { 'content-type': 'application/json', 'x-auth-token': 'wrong' }
  })).status, 401);
  assert.equal((await fetch(`${h.base}/notify`, {
    ...json('x'),
    headers: { 'content-type': 'application/json', 'x-auth-token': 'sekret' }
  })).status, 202);
  assert.equal((await fetch(`${h.base}/notify`, {
    ...json('y'),
    headers: { 'content-type': 'application/json', authorization: 'Bearer sekret' }
  })).status, 202);
});

test('queue full returns 429', async (t) => {
  const h = await harness({ maxOutbox: 1 });
  t.after(() => h.close());

  h.db.enqueue({ id: 'aaaaaaaa', body: 'first', key: null, receivedAt: 1000 });
  const full = await fetch(`${h.base}/notify`, json('second'));
  assert.equal(full.status, 429);
  assert.equal((await full.json()).error, 'queue_full');
});

test('duplicate keys are allowed', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const first = await fetch(`${h.base}/notify`, json('first', 'dup'));
  const second = await fetch(`${h.base}/notify`, json('second', 'dup'));
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(h.db.countOutbox(), 2);
  assert.deepEqual(h.db.listOutbox(10).map((row) => row.user_key), ['dup', 'dup']);
});

test('the key is trimmed before storage', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/notify`, json('trimmed', '  build-42  '));
  assert.equal(response.status, 202);
  assert.equal(h.db.listOutbox(1)[0].user_key, 'build-42');
});

test('invalid keys are rejected with 400', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  for (const key of ['a`b', 'a\nb', 'x'.repeat(33), '   ', 42]) {
    const response = await fetch(`${h.base}/notify`, json('x', key));
    assert.equal(response.status, 400, `key ${JSON.stringify(key)}`);
    assert.equal((await response.json()).error, 'invalid_key');
  }
  assert.equal(h.db.countOutbox(), 0);
});

test('empty text is rejected even with a valid key', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  const response = await fetch(`${h.base}/notify`, json('   ', 'ok'));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'empty_text');
});

test('GET /health reports bot, queue and runtime state', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.db.enqueue({ id: 'cccccccc', body: 'queued', key: null, receivedAt: Date.now() - 5000 });
  const response = await fetch(`${h.base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, 'test');
  assert.equal(body.bot, 'ready');
  assert.equal(body.queue, 1);
  assert.ok(body.oldest_age_ms >= 5000);
  assert.equal(body.halted, false);
});

test('GET /queue hides bodies unless full=1', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.db.enqueue({ id: 'dddddddd', body: 'secret body', key: 'k', receivedAt: 1000 });
  const light = await (await fetch(`${h.base}/queue`)).json();
  assert.equal(light.messages.length, 1);
  assert.equal(light.messages[0].body, undefined);
  assert.equal(light.messages[0].key, 'k');

  const full = await (await fetch(`${h.base}/queue?full=1`)).json();
  assert.equal(full.messages[0].body, 'secret body');
});

test('GET /history and POST /resume', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  h.db.enqueue({ id: 'eeeeeeee', body: 'done', key: null, receivedAt: 1000 });
  h.db.complete('eeeeeeee', { status: 'sent', finishedAt: 2000, attempts: 1 });

  const history = await (await fetch(`${h.base}/history?limit=5`)).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].status, 'sent');

  const resume = await fetch(`${h.base}/resume`, { method: 'POST' });
  assert.equal(resume.status, 200);
  assert.equal(h.counts.resume, 1);
});

test('unknown path is 404 and wrong method is 405', async (t) => {
  const h = await harness();
  t.after(() => h.close());

  assert.equal((await fetch(`${h.base}/nope`)).status, 404);
  const wrong = await fetch(`${h.base}/notify`);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
});
