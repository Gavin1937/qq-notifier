import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQqSender } from '../src/qq.js';

function httpError(status) {
  const error = new Error(`http ${status}`);
  error.httpStatus = status;
  return error;
}

function fakeBot(script = []) {
  const bot = {
    handlers: {},
    sent: [],
    started: 0,
    stopped: 0,
    on(event, fn) {
      (this.handlers[event] ??= []).push(fn);
      return this;
    },
    emit(event, arg) {
      for (const fn of this.handlers[event] ?? []) fn(arg);
    },
    async start() {
      this.started += 1;
      this.emit('ready');
    },
    async send(options) {
      this.sent.push(options);
      if (script.length) throw script.shift();
    },
    stop() {
      this.stopped += 1;
    }
  };
  return bot;
}

function makeSender(script = []) {
  const bot = fakeBot(script);
  const sender = createQqSender({
    appId: 'app',
    appSecret: 'secret',
    targetOpenId: 'openid-1',
    createBot: async () => bot,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
  return { bot, sender };
}

test('send uses markdown msg_type 2 and the c2c target', async () => {
  const { bot, sender } = makeSender();
  await sender.start();
  assert.equal(sender.isReady(), true);
  await sender.send({ markdown: '**[ts]**\n\nhi', plain: '[ts]\n\nhi' });
  assert.equal(bot.sent.length, 1);
  assert.deepEqual(bot.sent[0].target, { scope: 'c2c', targetId: 'openid-1' });
  assert.equal(bot.sent[0].msgType, 2);
  assert.equal(bot.sent[0].markdown.content, '**[ts]**\n\nhi');
});

test('definite rejection falls back to plain text once', async () => {
  const { bot, sender } = makeSender([httpError(400)]);
  await sender.start();
  await sender.send({ markdown: 'md', plain: 'plain' });
  assert.equal(bot.sent.length, 2);
  assert.equal(bot.sent[0].msgType, 2);
  assert.equal(bot.sent[1].msgType, 0);
  assert.equal(bot.sent[1].content, 'plain');
});

test('uncertain failures are not retried as plain text', async () => {
  const timeout = new Error('timeout');
  timeout.code = 'ETIMEDOUT';
  const { bot, sender } = makeSender([timeout]);
  await sender.start();
  await assert.rejects(() => sender.send({ markdown: 'md', plain: 'plain' }), /timeout/);
  assert.equal(bot.sent.length, 1);
});

test('sending before start rejects with 503', async () => {
  const { sender } = makeSender();
  await assert.rejects(
    () => sender.send({ markdown: 'md', plain: 'plain' }),
    (error) => error.httpStatus === 503
  );
});

test('an error event marks the bot not ready', async () => {
  const { bot, sender } = makeSender();
  await sender.start();
  bot.emit('error', new Error('ws closed'));
  assert.equal(sender.isReady(), false);
  await assert.rejects(() => sender.send({ markdown: 'md', plain: 'plain' }), (error) => error.httpStatus === 503);
});
