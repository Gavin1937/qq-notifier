const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function formatFields(fields) {
  if (!fields) return '';
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${text}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function createLogger({ level = 'info', stream = process.stderr, now = () => new Date() } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, message, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const ts = now().toISOString();
    const line = `${ts} ${lvl.toUpperCase().padEnd(5)} ${message}${formatFields(fields)}\n`;
    stream.write(line);
  };
  return {
    level,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (prefix) => createLogger({ level, stream, now: () => now(), prefix })
  };
}

export const nullLogger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  }
};
