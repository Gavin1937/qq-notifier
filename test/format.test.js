import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTimestamp, renderMessage, sanitizeKey } from '../src/format.js';

const AT = new Date(2026, 10, 11, 3, 14, 22, 481).getTime();

test('formatTimestamp prints local time with milliseconds', () => {
  assert.equal(formatTimestamp(AT), '2026-11-11 03:14:22.481');
  assert.equal(formatTimestamp(new Date(2026, 0, 2, 0, 0, 5, 7).getTime()), '2026-01-02 00:00:05.007');
});

test('renderMessage without key', () => {
  const { markdown, plain } = renderMessage({ body: 'download finished', receivedAt: AT });
  assert.equal(markdown, '**[2026-11-11 03:14:22.481]**\n\ndownload finished');
  assert.equal(plain, '[2026-11-11 03:14:22.481]\n\ndownload finished');
});

test('renderMessage with key', () => {
  const { markdown, plain } = renderMessage({ body: 'done', key: 'build-42', receivedAt: AT });
  assert.equal(markdown, '**[2026-11-11 03:14:22.481] #build-42**\n\ndone');
  assert.equal(plain, '[2026-11-11 03:14:22.481] #build-42\n\ndone');
});

test('header and body are separated by exactly two newlines', () => {
  const { markdown } = renderMessage({ body: '- one\n- two', receivedAt: AT });
  const separator = markdown.slice(markdown.indexOf(']') + 1, markdown.indexOf('- one'));
  assert.equal(separator, '**\n\n');
  assert.ok(markdown.endsWith('\n\n- one\n- two'));
});

test('body is preserved verbatim', () => {
  const body = 'line 1\n\nline 3\n';
  assert.ok(renderMessage({ body, receivedAt: AT }).markdown.endsWith(`\n\n${body}`));
});

test('sanitizeKey trims newlines, caps length, drops empties', () => {
  assert.equal(sanitizeKey('  build\r\n42  '), 'build 42');
  assert.equal(sanitizeKey(''), null);
  assert.equal(sanitizeKey('   '), null);
  assert.equal(sanitizeKey(null), null);
  assert.equal(sanitizeKey(42), null);
  assert.equal(sanitizeKey('x'.repeat(100)).length, 64);
});

test('empty body is rejected', () => {
  assert.throws(() => renderMessage({ body: '', receivedAt: AT }), TypeError);
});
