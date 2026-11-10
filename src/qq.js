import { isDefiniteRejection } from './queue.js';

function notConnectedError() {
  const error = new Error('qq bot is not connected');
  error.httpStatus = 503;
  return error;
}

/**
 * Thin wrapper over @tencent-connect/qqbot-nodejs.
 *
 * The SDK is imported lazily so that unit tests, `--config-template` and the
 * HTTP layer work without the dependency installed.
 */
export function createQqSender({
  appId,
  appSecret,
  targetOpenId,
  logger,
  createBot = null
} = {}) {
  let bot = null;
  let ready = false;
  let starting = null;

  const target = { scope: 'c2c', targetId: targetOpenId };

  async function defaultCreateBot(options) {
    const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
    return new QQBot(options);
  }

  function sdkLogger() {
    const forward = (level) => (...args) => {
      const message = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
      logger?.[level]?.('qq sdk', { message });
    };
    return { error: forward('error'), warn: forward('warn'), info: forward('debug'), debug: () => {} };
  }

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      if (bot) {
        try {
          await bot.stop?.();
        } catch {
          // ignore teardown failures before a reconnect
        }
        bot = null;
      }
      ready = false;
      const factory = createBot ?? defaultCreateBot;
      bot = await factory({
        appId,
        appSecret,
        transport: 'websocket',
        logger: sdkLogger()
      });
      bot.on('ready', () => {
        ready = true;
        logger?.info?.('qq bot ready');
      });
      bot.on('resumed', () => {
        ready = true;
        logger?.info?.('qq bot connection resumed');
      });
      bot.on('error', (error) => {
        ready = false;
        logger?.warn?.('qq bot error', { error: error?.message ?? String(error) });
      });
      await bot.start();
      ready = true;
      logger?.info?.('qq bot started');
    })().catch((error) => {
      ready = false;
      starting = null;
      throw error;
    });
    return starting;
  }

  async function send({ markdown, plain }) {
    if (!bot || !ready) throw notConnectedError();
    try {
      await bot.send({ target, msgType: 2, markdown: { content: markdown } });
    } catch (error) {
      if (!isDefiniteRejection(error)) throw error;
      logger?.warn?.('qq rejected the markdown message, falling back to plain text', {
        error: error?.message ?? String(error)
      });
      await bot.send({ target, msgType: 0, content: plain });
    }
  }

  function isReady() {
    return ready;
  }

  async function stop() {
    ready = false;
    if (bot?.stop) await bot.stop();
    bot = null;
    starting = null;
  }

  return { start, send, isReady, stop, target };
}
