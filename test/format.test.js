import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp,
  InvalidKeyError,
  normalizeKey,
  renderMessage
} from '../src/format.js';

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

test('renderMessage with key keeps the key in a code span outside the bold timestamp', () => {
  const { markdown, plain } = renderMessage({ body: 'done', key: 'build-42', receivedAt: AT });
  assert.equal(markdown, '**[2026-11-11 03:14:22.481]** `build-42`\n\ndone');
  assert.equal(plain, '[2026-11-11 03:14:22.481] build-42\n\ndone');
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

test('normalizeKey trims only the edges', () => {
  assert.equal(normalizeKey('  build  '), 'build');
  assert.equal(normalizeKey('\n\t\bbuild\r\n'), 'build');
  assert.equal(normalizeKey('\u00A0\u3000build\u00A0'), 'build');
  assert.equal(normalizeKey('\uFEFFkey'), 'key');
  assert.equal(normalizeKey('build 42'), 'build 42');
  assert.equal(normalizeKey('a\u00A0b'), 'a\u00A0b');
  assert.equal(normalizeKey('下载 任务'), '下载 任务');
  assert.equal(normalizeKey('a-b_c.d'), 'a-b_c.d');
});

test('normalizeKey measures the trimmed key in UTF-8 bytes', () => {
  assert.equal(normalizeKey('x'.repeat(32)), 'x'.repeat(32));
  assert.equal(normalizeKey(`  ${'x'.repeat(32)}  `), 'x'.repeat(32));
  assert.equal(normalizeKey('下载任务下载任务下载'), '下载任务下载任务下载');
  assert.equal(normalizeKey('😀'.repeat(8)), '😀'.repeat(8));
  assert.throws(() => normalizeKey('x'.repeat(33)), InvalidKeyError);
  assert.throws(() => normalizeKey('下载任务下载任务下载任'), InvalidKeyError);
  assert.throws(() => normalizeKey('😀'.repeat(9)), InvalidKeyError);
});

test('normalizeKey rejects control characters, backticks, and empties', () => {
  for (const bad of ['a`b', 'a\nb', 'a\tb', 'a\u0008b', 'a\u200Bb', 'a\u2028b', '', '   ']) {
    assert.throws(() => normalizeKey(bad), InvalidKeyError, JSON.stringify(bad));
  }
  assert.throws(() => normalizeKey(42), InvalidKeyError);
});

test('normalizeKey treats null and undefined as absent', () => {
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey(undefined), null);
});

test('renderMessage keeps a key with an interior space in one code span', () => {
  const { markdown } = renderMessage({ body: 'x', key: 'build 42', receivedAt: AT });
  assert.equal(markdown, '**[2026-11-11 03:14:22.481]** `build 42`\n\nx');
});

test('empty body is rejected', () => {
  assert.throws(() => renderMessage({ body: '', receivedAt: AT }), TypeError);
});
