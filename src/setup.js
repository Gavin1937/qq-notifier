import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configTemplate, defaultConfigPath, loadConfig, parseConfigText } from './config.js';

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

function writeFileAtomic(target, content, options = {}) {
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, content, options);
  renameSync(temp, target);
}

async function defaultScanQr(log) {
  const { startQrConnect } = await import('@tencent-connect/qqbot-connector');
  return new Promise((resolve, reject) => {
    let stop = null;
    try {
      stop = startQrConnect({
        onQrDisplayed: (url) => log(`\nQR code URL (also printed as a QR below):\n${url}`),
        onQrExpired: () => log('QR code expired, refreshing...'),
        onSuccess: (credentials) => {
          const first = Array.isArray(credentials) ? credentials[0] : credentials;
          if (!first?.appId || !first?.appSecret) {
            reject(new Error('QR scan returned incomplete credentials'));
            return;
          }
          try {
            stop?.();
          } catch {
            // the connector may already have stopped itself
          }
          resolve({ appId: first.appId, appSecret: first.appSecret });
        },
        onFailure: (error) => reject(new Error(`QR setup failed: ${error?.message ?? error}`))
      }, { displayQrCodeToConsole: true, source: 'qq-notifier' });
    } catch (error) {
      reject(error);
    }
  });
}

async function defaultCaptureOpenId({ appId, appSecret }, log) {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  const bot = new QQBot({
    appId,
    appSecret,
    transport: 'websocket',
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });

  log('\nNow open QQ on your phone and send any message to the bot (private chat).');
  log('Waiting for your first message to capture the openid...');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        bot.stop?.();
      } catch {
        // ignore
      }
      reject(new Error('timed out after 10 minutes waiting for a message to the bot'));
    }, SETUP_TIMEOUT_MS);

    bot.on('message', (_context, message) => {
      const replyTarget = message?.replyTarget;
      const scope = replyTarget?.scope ?? message?.chatScope;
      const targetId = replyTarget?.targetId ?? message?.senderId;
      if (scope !== 'c2c' || !targetId) return;
      clearTimeout(timer);
      log(`captured private-chat openid: ${targetId}`);
      setTimeout(() => {
        try {
          bot.stop?.();
        } catch {
          // ignore
        }
      }, 50);
      resolve(targetId);
    });

    bot.start().catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function setTargetOpenId(text, openId) {
  const pattern = /("target_open_id"\s*:\s*)("(?:[^"\\]|\\.)*"|null)/;
  if (pattern.test(text)) {
    return text.replace(pattern, `$1"${openId}"`);
  }
  // Fallback for hand-edited files that dropped the key: rewrite as JSON (comments aside).
  const parsed = parseConfigText(text);
  parsed.qq.target_open_id = openId;
  const plain = { server: parsed.server, qq: parsed.qq, queue: parsed.queue, storage: parsed.storage };
  return `${JSON.stringify(plain, null, 2)}\n`;
}

export async function runSetup({ configPath, force = false, deps = {} } = {}) {
  const targetPath = configPath ?? defaultConfigPath();
  const log = deps.log ?? ((message) => console.log(message));
  const scanQr = deps.scanQr ?? ((logger) => defaultScanQr(logger));
  const captureOpenId = deps.captureOpenId ?? ((credentials, logger) => defaultCaptureOpenId(credentials, logger));

  mkdirSync(dirname(targetPath), { recursive: true });

  if (!existsSync(targetPath)) {
    writeFileAtomic(targetPath, configTemplate());
    log(`created configuration: ${targetPath}`);
  }
  const config = loadConfig(targetPath);
  mkdirSync(config.paths.data_dir, { recursive: true });

  const credentialsPath = config.paths.credentials;
  if (existsSync(credentialsPath) && !force) {
    throw new Error(
      `credentials already exist: ${credentialsPath}\nRe-run with --force to replace them (the old bot stays valid until you do).`
    );
  }

  log('Scan the QR code with the QQ account that should own this bot.');
  const credentials = await scanQr(log);
  writeFileAtomic(credentialsPath, `${JSON.stringify({
    app_id: credentials.appId,
    app_secret: credentials.appSecret,
    created_at: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  log(`credentials saved: ${credentialsPath}`);

  const openId = await captureOpenId(credentials, log);
  const updated = setTargetOpenId(readFileSync(targetPath, 'utf8'), openId);
  writeFileAtomic(targetPath, updated);
  log(`saved qq.target_open_id: ${openId}`);

  const tokenHeader = config.server.token ? ` -H "X-Auth-Token: ${config.server.token}"` : '';
  log(`
Next step:
  qqn server --config "${targetPath}"

Test it:
  curl -X POST "http://127.0.0.1:${config.server.port}/notify" \\
    -H "Content-Type: text/plain"${tokenHeader} \\
    --data "hello from qqn"
`);

  return { configPath: targetPath, credentialsPath, openId };
}
