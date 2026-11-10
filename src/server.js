import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, defaultConfigPath } from './config.js';
import { openDb } from './db.js';
import { createWorker } from './queue.js';
import { createQqSender } from './qq.js';
import { createHttpHandler } from './http.js';
import { createSupervisor } from './supervisor.js';
import { startListeners } from './listeners.js';
import { shutdown } from './shutdown.js';
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

export async function runServer({ configPath } = {}) {
  const resolvedConfigPath = configPath ?? defaultConfigPath();
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(
      `configuration file not found: ${resolvedConfigPath}\nRun \`qqn setup${configPath ? ` --config "${configPath}"` : ''}\` first to create it.`
    );
  }
  const config = loadConfig(resolvedConfigPath);
  const credentials = loadCredentials(config.paths.credentials);
  if (!config.qq.target_open_id) {
    throw new Error(
      `qq.target_open_id is missing in ${resolvedConfigPath}\nRun \`qqn setup\` again so the bot can capture your openid.`
    );
  }

  const logger = createLogger({
    level: process.env.QQN_LOG_LEVEL ?? config.log.level,
    file: config.paths.log_file,
    maxSizeBytes: config.log.max_size_bytes,
    maxFiles: config.log.max_files,
    toConsole: config.log.console
  });
  const db = openDb(config.paths.db, { historyKeep: config.queue.history_keep });
  const sender = createQqSender({ ...credentials, targetOpenId: config.qq.target_open_id, logger });
  const worker = createWorker({ db, sender, queue: config.queue, logger });
  const handler = createHttpHandler({ db, config, worker, sender, logger });
  const listeners = await startListeners({ config, handler, logger });
  for (const address of listeners.addresses) logger.info('listening', { address });

  const supervisor = createSupervisor({ sender, logger });
  supervisor.start();
  worker.start();

  let stopping = false;
  const requestShutdown = (signal) => {
    if (stopping) {
      logger.warn('second shutdown signal; exiting immediately', { signal });
      process.exit(130);
    }
    stopping = true;
    logger.info('shutting down', { signal });
    void shutdown({ supervisor, worker, sender, listeners, db, logger });
  };
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  // Stay alive until a signal arrives; shutdown() exits the process explicitly.
  await new Promise(() => {});
}
