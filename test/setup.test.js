import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup, setTargetOpenId } from '../src/setup.js';

const quiet = () => {};

function fakeDeps({ scanFails = false, openId = 'OPENID-1' } = {}) {
  return {
    log: quiet,
    scanQr: async () => {
      if (scanFails) throw new Error('scan aborted');
      return { appId: 'app-1', appSecret: 'secret-1' };
    },
    captureOpenId: async () => openId
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqn-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('creates config and credentials, then records the openid', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.json');

  const result = await runSetup({ configPath, deps: fakeDeps() });

  assert.equal(result.openId, 'OPENID-1');
  const credentials = JSON.parse(readFileSync(result.credentialsPath, 'utf8'));
  assert.equal(credentials.app_id, 'app-1');
  assert.equal(credentials.app_secret, 'secret-1');

  const text = readFileSync(configPath, 'utf8');
  assert.match(text, /"target_open_id": "OPENID-1"/);
  assert.match(text, /\/\//, 'template comments are preserved');

  if (process.platform !== 'win32') {
    assert.equal(statSync(result.credentialsPath).mode & 0o777, 0o600);
  }
});

test('refuses to overwrite existing credentials without --force', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.json');
  const first = await runSetup({ configPath, deps: fakeDeps() });
  const before = readFileSync(first.credentialsPath, 'utf8');

  await assert.rejects(() => runSetup({ configPath, deps: fakeDeps() }), /already exist/);
  assert.equal(readFileSync(first.credentialsPath, 'utf8'), before);
});

test('--force replaces existing credentials', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.json');
  await runSetup({ configPath, deps: fakeDeps() });
  const result = await runSetup({
    configPath,
    force: true,
    deps: fakeDeps({ openId: 'OPENID-2' })
  });
  assert.equal(result.openId, 'OPENID-2');
  assert.match(readFileSync(configPath, 'utf8'), /"target_open_id": "OPENID-2"/);
});

test('no credentials are written when the QR step aborts', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.json');

  await assert.rejects(
    () => runSetup({ configPath, deps: fakeDeps({ scanFails: true }) }),
    /scan aborted/
  );
  assert.equal(existsSync(join(dir, 'data', 'credentials.json')), false);
  assert.equal(existsSync(configPath), true, 'the config template is still created');
});

test('setTargetOpenId preserves comments and only rewrites the value', () => {
  const text = '{\n  // keep this comment\n  "qq": { "target_open_id": null },\n  "x": 1\n}\n';
  const updated = setTargetOpenId(text, 'ABC');
  assert.match(updated, /\/\/ keep this comment/);
  assert.match(updated, /"target_open_id": "ABC"/);
  assert.doesNotMatch(updated, /null/);
});

test('setTargetOpenId falls back when the key is missing', () => {
  const text = '{\n  "qq": { "other": 1 },\n  "server": { "port": 24046 }\n}';
  const updated = setTargetOpenId(text, 'ABC');
  assert.equal(JSON.parse(updated).qq.target_open_id, 'ABC');
});
