import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/log.js';

const fixedNow = () => new Date('2026-11-11T03:00:00.000Z');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqn-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sink() {
  const chunks = [];
  return { chunks, stream: { write: (line) => chunks.push(line) } };
}

test('writes timestamped lines to both file and console', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'nested', 'app.log');
  const { chunks, stream } = sink();

  const logger = createLogger({ level: 'info', file, toConsole: true, stream, now: fixedNow });
  logger.info('hello', { a: 1 });

  const text = readFileSync(file, 'utf8');
  assert.equal(text, '2026-11-11T03:00:00.000Z INFO  hello a=1\n');
  assert.deepEqual(chunks, [text]);
});

test('filters below the configured level', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'app.log');
  const logger = createLogger({ level: 'warn', file, toConsole: false, now: fixedNow });

  logger.debug('hidden');
  logger.info('hidden');
  assert.equal(existsSync(file), false);

  logger.warn('shown');
  assert.match(readFileSync(file, 'utf8'), /WARN {2}shown/);
});

test('rotates by size and keeps maxFiles copies', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'app.log');
  const logger = createLogger({
    level: 'info',
    file,
    toConsole: false,
    now: fixedNow,
    maxSizeBytes: 200,
    maxFiles: 2
  });

  for (let i = 0; i < 40; i += 1) {
    logger.info(`line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
  }

  assert.ok(statSync(file).size <= 200, 'active file stays under the limit');
  assert.ok(existsSync(`${file}.1`), 'first rotation exists');
  assert.ok(existsSync(`${file}.2`), 'second rotation exists');
  assert.equal(existsSync(`${file}.3`), false, 'only maxFiles copies are kept');
});

test('a single oversized line is still written whole', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'app.log');
  const logger = createLogger({ level: 'info', file, toConsole: false, now: fixedNow, maxSizeBytes: 50, maxFiles: 2 });

  logger.info('x'.repeat(500));
  assert.ok(statSync(file).size > 50);
  assert.match(readFileSync(file, 'utf8'), /x{500}/);
});

test('continues appending to an existing file after restart', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'app.log');
  createLogger({ level: 'info', file, toConsole: false, now: fixedNow }).info('first');
  createLogger({ level: 'info', file, toConsole: false, now: fixedNow }).info('second');

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /second/);
});

test('toConsole: false suppresses console output', () => {
  const { chunks, stream } = sink();
  const logger = createLogger({ level: 'info', toConsole: false, stream, now: fixedNow });
  logger.info('file only');
  assert.deepEqual(chunks, []);
});

test('no file means console only', () => {
  const { chunks, stream } = sink();
  const logger = createLogger({ level: 'info', toConsole: true, stream, now: fixedNow });
  logger.info('only console');
  assert.deepEqual(chunks, ['2026-11-11T03:00:00.000Z INFO  only console\n']);
});
