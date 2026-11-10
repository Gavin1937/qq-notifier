import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

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

/**
 * Console + optional file logger.
 *
 * The file sink appends one line at a time and rotates by size:
 *   app.log -> app.log.1 -> ... -> app.log.<maxFiles>
 * deleting the oldest copy. A single line larger than maxSizeBytes is written
 * as-is (rotation happens before it, never in the middle of a line).
 */
export function createLogger({
  level = 'info',
  stream = process.stderr,
  now = () => new Date(),
  toConsole = true,
  file = null,
  maxSizeBytes = 10 * 1024 * 1024,
  maxFiles = 5
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let size = 0;

  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) size = statSync(file).size;
  }

  function rotate() {
    const oldest = `${file}.${maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    size = 0;
  }

  function append(line) {
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxSizeBytes) rotate();
    appendFileSync(file, line);
    size += bytes;
  }

  function write(lvl, message, fields) {
    if (LEVELS[lvl] < threshold) return;
    const line = `${now().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}${formatFields(fields)}\n`;
    if (file) append(line);
    if (toConsole) stream.write(line);
  }

  return {
    level,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields)
  };
}

export const nullLogger = {
  level: 'silent',
  debug() {},
  info() {},
  warn() {},
  error() {}
};
