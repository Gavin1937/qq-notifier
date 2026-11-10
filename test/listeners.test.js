import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startListeners } from '../src/listeners.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const handler = (req, res) => {
  res.writeHead(200);
  res.end('ok');
};

function makeConfig(overrides = {}) {
  return { server: { port: 0, bind_localhost: true, bind_lan_ip: null, ...overrides } };
}

test('binds localhost only', async () => {
  const listeners = await startListeners({ config: makeConfig(), handler, logger: silent });
  assert.equal(listeners.addresses.length, 1);
  assert.match(listeners.addresses[0], /^127\.0\.0\.1:\d+$/);
  await listeners.close();
});

test('binds localhost and the configured LAN address', async () => {
  const listeners = await startListeners({
    config: makeConfig({ bind_lan_ip: '127.0.0.1' }),
    handler,
    logger: silent
  });
  assert.equal(listeners.addresses.length, 2);
  await listeners.close();
});

test('an unavailable LAN address degrades to a warning', async () => {
  const warnings = [];
  const logger = { ...silent, error: (message, fields) => warnings.push({ message, fields }) };
  const listeners = await startListeners({
    config: makeConfig({ bind_lan_ip: '203.0.113.1' }),
    handler,
    logger
  });
  assert.equal(listeners.addresses.length, 1);
  assert.match(listeners.addresses[0], /^127\.0\.0\.1:/);
  assert.equal(warnings.length, 1);
  await listeners.close();
});

test('an unavailable LAN address is fatal when localhost is disabled', async () => {
  await assert.rejects(
    () => startListeners({
      config: makeConfig({ bind_localhost: false, bind_lan_ip: '203.0.113.1' }),
      handler,
      logger: silent
    }),
    /EADDRNOTAVAIL/
  );
});

test('refuses to start with no listeners configured', async () => {
  await assert.rejects(
    () => startListeners({ config: makeConfig({ bind_localhost: false }), handler, logger: silent }),
    /no listeners configured/
  );
});
