import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitizeKey } from './format.js';

export const MAX_TEXT_BYTES = 12000;

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) overflow = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) reject(new HttpError(413, 'payload_too_large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function presentedToken(req) {
  const header = req.headers['x-auth-token'];
  if (typeof header === 'string' && header) return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match) return match[1];
  }
  return null;
}

function isAuthorized(req, token) {
  if (!token) return true;
  const presented = presentedToken(req);
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;
  sendJson(res, 405, { error: 'method_not_allowed' }, { allow: method });
  return false;
}

function parseLimit(value, fallback, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function createHttpHandler({
  db,
  config,
  worker,
  sender,
  logger,
  version = '1.0.0',
  now = () => Date.now()
} = {}) {
  const maxBody = config.server.max_body_bytes;
  const maxOutbox = config.queue.max_outbox;

  async function notify(req, res) {
    const raw = await readBody(req, maxBody);
    const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();

    let text;
    let key = null;
    if (contentType === 'text/plain') {
      text = raw.toString('utf8');
    } else if (contentType === 'application/json' || contentType === '') {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid_json');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'invalid_json');
      }
      text = parsed.text;
      key = parsed.key ?? null;
      if (key !== null && typeof key !== 'string') throw new HttpError(400, 'invalid_key');
    } else {
      throw new HttpError(415, 'unsupported_media_type');
    }

    if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'empty_text');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      throw new HttpError(413, 'text_too_large', `text exceeds ${MAX_TEXT_BYTES} bytes`);
    }

    const cleanKey = key === null ? null : sanitizeKey(key);
    if (key !== null && cleanKey === null) throw new HttpError(400, 'invalid_key');

    if (db.countOutbox() >= maxOutbox) throw new HttpError(429, 'queue_full');
    if (cleanKey && db.findPendingByKey(cleanKey)) throw new HttpError(409, 'duplicate_key');

    const id = randomBytes(4).toString('hex');
    const receivedAt = now();
    db.enqueue({ id, body: text, key: cleanKey, receivedAt });
    worker.wake();
    sendJson(res, 202, { id, queued_at: receivedAt });
  }

  function health(req, res) {
    const state = worker.state();
    const oldest = db.oldestReceivedAt();
    sendJson(res, 200, {
      ok: true,
      version,
      bot: sender.isReady() ? 'ready' : 'down',
      queue: db.countOutbox(),
      oldest_age_ms: oldest === null ? null : Math.max(0, now() - oldest),
      halted: state.halted,
      cooldown_until: state.cooldownUntil || null,
      failure_streak: state.streak,
      last_error: db.getRuntime('last_error')
    });
  }

  function queue(req, res, url) {
    const limit = parseLimit(url.searchParams.get('limit'), 50, 500);
    const full = url.searchParams.get('full') === '1';
    const rows = db.listOutbox(limit).map((row) => (full ? row : {
      id: row.id,
      received_at: row.received_at,
      attempts: row.attempts,
      next_attempt_at: row.next_attempt_at,
      key: row.user_key
    }));
    sendJson(res, 200, { count: db.countOutbox(), limit, messages: rows });
  }

  function history(req, res, url) {
    const limit = parseLimit(url.searchParams.get('limit'), 50, 500);
    sendJson(res, 200, { limit, messages: db.listHistory(limit) });
  }

  function resume(req, res) {
    worker.resume();
    sendJson(res, 200, { ok: true });
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!isAuthorized(req, config.server.token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      switch (url.pathname) {
        case '/notify':
          if (requireMethod(req, res, 'POST')) await notify(req, res);
          return;
        case '/health':
          if (requireMethod(req, res, 'GET')) health(req, res);
          return;
        case '/queue':
          if (requireMethod(req, res, 'GET')) queue(req, res, url);
          return;
        case '/history':
          if (requireMethod(req, res, 'GET')) history(req, res, url);
          return;
        case '/resume':
          if (requireMethod(req, res, 'POST')) resume(req, res);
          return;
        default:
          sendJson(res, 404, { error: 'not_found' });
      }
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      logger?.error?.('http request failed', { error: error?.message ?? String(error) });
      sendJson(res, 500, { error: 'internal_error' });
    }
  };
}
