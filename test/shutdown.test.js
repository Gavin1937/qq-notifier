import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shutdown } from '../src/shutdown.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function recorder() {
  const calls = [];
  return { calls, logger: { ...silent, error: (message) => calls.push(`error:${message}`) } };
}

test('stops every component and exits 0', async () => {
  const order = [];
  const exits = [];

  await shutdown({
    supervisor: { stop: async () => order.push('supervisor') },
    worker: { stop: async () => order.push('worker') },
    sender: { stop: async () => order.push('sender') },
    listeners: { close: async () => order.push('listeners') },
    db: { close: () => order.push('db') },
    logger: silent,
    exit: (code) => exits.push(code)
  });

  assert.deepEqual(order.sort(), ['db', 'listeners', 'sender', 'supervisor', 'worker']);
  assert.deepEqual(exits, [0]);
});

test('a throwing stop does not prevent the rest or the exit', async () => {
  const order = [];
  const exits = [];

  await shutdown({
    supervisor: { stop: async () => { throw new Error('boom'); } },
    worker: { stop: async () => order.push('worker') },
    sender: { stop: async () => order.push('sender') },
    listeners: { close: async () => order.push('listeners') },
    db: { close: () => order.push('db') },
    logger: silent,
    exit: (code) => exits.push(code)
  });

  assert.deepEqual(order, ['worker', 'sender', 'listeners', 'db']);
  assert.deepEqual(exits, [0]);
});

test('a listener close error is logged but still exits 0', async () => {
  const exits = [];
  const calls = [];

  await shutdown({
    listeners: { close: async () => { throw new Error('close failed'); } },
    db: { close: () => calls.push('db') },
    logger: { ...silent, error: (message) => calls.push(message) },
    exit: (code) => exits.push(code)
  });

  assert.ok(calls.includes('shutdown: closing listeners failed'));
  assert.deepEqual(exits, [0]);
});

test('forces exit 1 when a stop never settles', async () => {
  const exits = [];
  const started = Date.now();

  await shutdown({
    supervisor: { stop: () => new Promise(() => {}) },
    logger: silent,
    timeoutMs: 10,
    exit: (code) => exits.push(code)
  });

  assert.deepEqual(exits, [1]);
  assert.ok(Date.now() - started < 1000);
});
