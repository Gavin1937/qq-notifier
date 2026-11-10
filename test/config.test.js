import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  ConfigError,
  configTemplate,
  normalizeConfig,
  parseConfigText,
  parseJsonc
} from '../src/config.js';

test('parseJsonc strips line and block comments outside strings', () => {
  const text = `{
    // a line comment
    "a": 1, /* inline block */
    "url": "http://example.com/x",
    "b": "text // not a comment"
  }`;
  assert.deepEqual(parseJsonc(text), {
    a: 1,
    url: 'http://example.com/x',
    b: 'text // not a comment'
  });
});

test('parseJsonc keeps escaped quotes', () => {
  assert.deepEqual(parseJsonc('{"a":"say \\"hi\\" // ok"}'), { a: 'say "hi" // ok' });
});

test('parseJsonc rejects broken JSON', () => {
  assert.throws(() => parseJsonc('{ "a": }'), ConfigError);
});

test('normalizeConfig applies defaults and resolves data_dir next to the config file', () => {
  const cfg = parseConfigText('{}', { configPath: 'C:/srv/qqn/data/config.json' });
  assert.equal(cfg.server.port, 24046);
  assert.equal(cfg.server.bind_lan_ip, null);
  assert.equal(cfg.queue.max_attempts, 3);
  assert.deepEqual(cfg.queue.backoff_ms, [2000, 8000, 30000]);
  assert.equal(cfg.paths.data_dir, pathResolve('C:/srv/qqn/data', 'data'));
  assert.equal(cfg.paths.db, pathResolve('C:/srv/qqn/data', 'data', 'notifier.db'));
});

test('normalizeConfig keeps absolute data_dir', () => {
  const absolute = pathResolve(process.cwd(), 'abs-data');
  const cfg = normalizeConfig({ storage: { data_dir: absolute } });
  assert.equal(cfg.paths.data_dir, absolute);
  assert.equal(cfg.paths.db, pathResolve(absolute, 'notifier.db'));
});

test('normalizeConfig rejects bad values', () => {
  assert.throws(() => normalizeConfig({ server: { port: 70000 } }), ConfigError);
  assert.throws(() => normalizeConfig({ server: { port: 'abc' } }), ConfigError);
  assert.throws(() => normalizeConfig({ server: { bind_lan_ip: 'localhost' } }), ConfigError);
  assert.throws(() => normalizeConfig({ server: { token: '' } }), ConfigError);
  assert.throws(() => normalizeConfig({ queue: { backoff_ms: [] } }), ConfigError);
  assert.throws(() => normalizeConfig({ queue: { max_attempts: 0 } }), ConfigError);
  assert.throws(() => normalizeConfig({ queue: { cooldown_max_ms: 1000 } }), ConfigError);
});

test('log defaults and path resolution', () => {
  const cfg = parseConfigText('{}', { configPath: 'C:/srv/qqn/data/config.json' });
  assert.equal(cfg.log.level, 'info');
  assert.equal(cfg.log.file, null);
  assert.equal(cfg.log.console, true);
  assert.equal(cfg.log.max_size_bytes, 10485760);
  assert.equal(cfg.log.max_files, 5);
  assert.equal(cfg.paths.log, null);

  const withFile = parseConfigText('{"log":{"file":"logs/app.log"}}', { configPath: 'C:/srv/qqn/data/config.json' });
  assert.equal(withFile.paths.log, pathResolve('C:/srv/qqn/data', 'data', 'logs', 'app.log'));
});

test('invalid log settings are rejected', () => {
  assert.throws(() => normalizeConfig({ log: { level: 'verbose' } }), ConfigError);
  assert.throws(() => normalizeConfig({ log: { file: '' } }), ConfigError);
  assert.throws(() => normalizeConfig({ log: { console: 'yes' } }), ConfigError);
  assert.throws(() => normalizeConfig({ log: { max_size_bytes: 10 } }), ConfigError);
  assert.throws(() => normalizeConfig({ log: { max_files: 0 } }), ConfigError);
});

test('template is valid and contains no real address or path', () => {
  const text = configTemplate(24046);
  const cfg = parseConfigText(text);
  assert.equal(cfg.log.level, 'info');
  assert.equal(cfg.log.file, null);
  assert.equal(cfg.server.port, 24046);
  assert.equal(cfg.server.bind_lan_ip, null);
  assert.ok(!text.includes('192.168.'), 'template must not contain a real LAN IP');
  assert.ok(!/[A-Za-z]:\\/.test(text), 'template must not contain a Windows path');
});

test('committed example matches the default configuration', () => {
  const text = readFileSync(new URL('../examples/config.example.jsonc', import.meta.url), 'utf8');
  const cfg = parseConfigText(text);
  assert.equal(cfg.server.port, 24046);
  assert.equal(cfg.queue.history_keep, 1000);
  assert.equal(cfg.qq.target_open_id, null);
});
