import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ConfigError';
    this.path = path ?? '';
  }
}

const DEFAULTS = {
  server: {
    port: 24046,
    bind_localhost: true,
    bind_lan_ip: null,
    token: null,
    max_body_bytes: 65536
  },
  qq: {
    target_open_id: null
  },
  queue: {
    max_attempts: 3,
    backoff_ms: [2000, 8000, 30000],
    cooldown_ms: 300000,
    cooldown_max_ms: 3600000,
    halt_after_abandons: 5,
    max_outbox: 1000,
    send_rate_per_second: 1,
    history_keep: 1000
  },
  storage: {
    data_dir: './data'
  }
};

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && n === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new ConfigError(`invalid JSON after stripping comments: ${err.message}`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return override;
  const merged = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return merged;
}

function requireInteger(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`expected an integer between ${min} and ${max}, got ${JSON.stringify(value)}`, path);
  }
}

function requireBoolean(value, path) {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`expected a boolean, got ${JSON.stringify(value)}`, path);
  }
}

export function normalizeConfig(raw, { configPath } = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('configuration must be a JSON object');
  const cfg = deepMerge(DEFAULTS, raw);
  const s = cfg.server;
  requireInteger(s.port, 'server.port', { min: 1, max: 65535 });
  requireBoolean(s.bind_localhost, 'server.bind_localhost');
  if (s.bind_lan_ip !== null && (typeof s.bind_lan_ip !== 'string' || !IPV4.test(s.bind_lan_ip))) {
    throw new ConfigError('server.bind_lan_ip must be null or an IPv4 address', 'server.bind_lan_ip');
  }
  if (s.token !== null && (typeof s.token !== 'string' || s.token.trim() === '')) {
    throw new ConfigError('server.token must be null or a non-empty string', 'server.token');
  }
  requireInteger(s.max_body_bytes, 'server.max_body_bytes', { min: 1024, max: 16 * 1024 * 1024 });

  const q = cfg.queue;
  requireInteger(q.max_attempts, 'queue.max_attempts', { min: 1, max: 100 });
  if (!Array.isArray(q.backoff_ms) || q.backoff_ms.length === 0) {
    throw new ConfigError('queue.backoff_ms must be a non-empty array', 'queue.backoff_ms');
  }
  q.backoff_ms.forEach((ms, index) => requireInteger(ms, `queue.backoff_ms[${index}]`, { min: 100, max: 3600000 }));
  requireInteger(q.cooldown_ms, 'queue.cooldown_ms', { min: 1000, max: 86400000 });
  requireInteger(q.cooldown_max_ms, 'queue.cooldown_max_ms', { min: q.cooldown_ms, max: 86400000 });
  requireInteger(q.halt_after_abandons, 'queue.halt_after_abandons', { min: 2, max: 1000 });
  requireInteger(q.max_outbox, 'queue.max_outbox', { min: 1, max: 1000000 });
  if (typeof q.send_rate_per_second !== 'number' || !(q.send_rate_per_second > 0)) {
    throw new ConfigError('queue.send_rate_per_second must be a positive number', 'queue.send_rate_per_second');
  }
  requireInteger(q.history_keep, 'queue.history_keep', { min: 0, max: 10000000 });

  if (cfg.qq.target_open_id !== null && typeof cfg.qq.target_open_id !== 'string') {
    throw new ConfigError('qq.target_open_id must be null or a string', 'qq.target_open_id');
  }
  if (typeof cfg.storage.data_dir !== 'string' || cfg.storage.data_dir.trim() === '') {
    throw new ConfigError('storage.data_dir must be a non-empty string', 'storage.data_dir');
  }

  const configDir = configPath ? resolve(configPath, '..') : process.cwd();
  const dataDir = isAbsolute(cfg.storage.data_dir)
    ? cfg.storage.data_dir
    : resolve(configDir, cfg.storage.data_dir);

  return {
    ...cfg,
    paths: {
      data_dir: dataDir,
      db: resolve(dataDir, 'notifier.db'),
      credentials: resolve(dataDir, 'credentials.json')
    }
  };
}

export function parseConfigText(text, options) {
  return normalizeConfig(parseJsonc(text), options);
}

export function loadConfig(configPath) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(`configuration file not found: ${configPath}`);
    }
    throw new ConfigError(`cannot read configuration: ${err.message}`);
  }
  return parseConfigText(text, { configPath });
}

export function defaultConfigPath() {
  return resolve(process.cwd(), 'data', 'config.json');
}

function randomPort() {
  return 10000 + Math.floor(Math.random() * 20000);
}

export function configTemplate(port = randomPort()) {
  return `// qq-notifier configuration (JSONC: // line and /* block */ comments are allowed)
//
// Relative paths (storage.data_dir) resolve against this file's directory.
{
  "server": {
    // HTTP port, 1-65535.
    "port": ${port},
    // Also listen on 127.0.0.1. Keep true unless the port is reached some other way.
    "bind_localhost": true,
    // Extra interface to listen on, e.g. "192.0.2.10". null = localhost only.
    // In Docker this must be "0.0.0.0"; publish host ports in compose.yaml instead.
    "bind_lan_ip": null,
    // Shared secret. When set, requests need X-Auth-Token or Authorization: Bearer <token>.
    "token": null,
    "max_body_bytes": 65536
  },
  "qq": {
    // Written by \`qqn setup\`. Private-chat openid of the account that messages the bot.
    "target_open_id": null
  },
  "queue": {
    "max_attempts": 3,
    // Delay before attempt 2, 3, ...
    "backoff_ms": [2000, 8000, 30000],
    // Cooldown after consecutive abandoned messages; doubles up to cooldown_max_ms.
    "cooldown_ms": 300000,
    "cooldown_max_ms": 3600000,
    // Consecutive abandons that stop the worker until \`qqn resume\`.
    "halt_after_abandons": 5,
    // Reject new messages with HTTP 429 when this many are pending.
    "max_outbox": 1000,
    "send_rate_per_second": 1,
    // Sent/abandoned history rows to keep. 0 = keep everything.
    "history_keep": 1000
  },
  "storage": {
    "data_dir": "./data"
  }
}
`;
}

export { DEFAULTS, deepMerge, requireInteger, requireBoolean, IPV4, randomPort };
