import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createWorker } from './queue.js';
import { createQqSender } from './qq.js';
import { createHttpHandler } from './http.js';
import { createLogger } from './log.js';

export function loadCredentials(path) {
  if (!existsSync(path)) {
    throw new Error(`credentials not found: ${path}\nRun \`qqn setup\` first (or \`qqn setup --config <path>\`).`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse credentials file ${path}: ${error.message}`);
  }
  if (typeof raw.app_id !== 'string' || !raw.app_id || typeof raw.app_secret !== 'string' || !raw.app_secret) {
    throw new Error(`credentials file is incomplete (expected app_id and app_secret): ${path}`);
  }
  return { appId: raw.app_id, appSecret: raw.app_secret };
}

function listen(handler, port, host) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

export async function runServer({ configPath } = {}) {
  const config = loadConfig(configPath);
  const credentials = loadCredentials(config.paths.credentials);
  if (!config.qq.target_open_id) {
    throw new Error(
      `qq.target_open_id is missing in ${configPath}\nRun \`qqn setup\` again so the bot can capture your openid.`
    );
  }

  const logger = createLogger({ level: process.env.QQN_LOG_LEVEL ?? 'info' });
  const db = openDb(config.paths.db, { historyKeep: config.queue.history_keep });
  const sender = createQqSender({ ...credentials, targetOpenId: config.qq.target_open_id, logger });
  const worker = createWorker({ db, sender, queue: config.queue, logger });
  const handler = createHttpHandler({ db, config, worker, sender, logger });

  const port = config.server.port;
  const servers = [];

  if (config.server.bind_localhost) {
    servers.push(await listen(handler, port, '127.0.0.1'));
    logger.info('listening on localhost', { address: `127.0.0.1:${port}` });
  }

  if (config.server.bind_lan_ip) {
    if (!config.server.bind_localhost && !config.server.bind_lan_ip) {
      throw new Error('no listeners configured');
    }
    try {
      servers.push(await listen(handler, port, config.server.bind_lan_ip));
      logger.info('listening on LAN', { address: `${config.server.bind_lan_ip}:${port}` });
    } catch (error) {
      if (error.code !== 'EADDRNOTAVAIL') throw error;
      logger.error('cannot bind the configured LAN address on this host', {
        address: config.server.bind_lan_ip,
        hint: 'the address may have changed; inside Docker set bind_lan_ip to 0.0.0.0 and publish host ports in compose.yaml'
      });
      if (servers.length === 0) {
        throw new Error(`cannot bind ${config.server.bind_lan_ip}:${port} (EADDRNOTAVAIL) and localhost binding is disabled`);
      }
    }
  }

  if (servers.length === 0) {
    throw new Error('no listeners configured: set server.bind_localhost or server.bind_lan_ip');
  }

  sender.start().catch((error) => {
    logger.error('qq bot failed to start; messages stay queued until it connects', { error: error.message });
  });
  worker.start();

  await new Promise((resolve) => {
    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      logger.info('shutting down', { signal });
      await worker.stop();
      await sender.stop().catch(() => {});
      await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
      db.close();
      resolve();
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  });
}
