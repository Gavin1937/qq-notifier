import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id             TEXT PRIMARY KEY NOT NULL,
  body           TEXT NOT NULL,
  user_key       TEXT,
  received_at    INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT
);
CREATE INDEX IF NOT EXISTS outbox_fifo ON outbox(received_at, id);

CREATE TABLE IF NOT EXISTS history (
  id          TEXT PRIMARY KEY NOT NULL,
  body        TEXT NOT NULL,
  user_key    TEXT,
  received_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  attempts    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  last_error  TEXT
);
CREATE INDEX IF NOT EXISTS history_finished ON history(finished_at DESC);

CREATE TABLE IF NOT EXISTS runtime (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

export function openDb(path, { historyKeep = 1000 } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec(SCHEMA);

  const stmt = {
    insertOutbox: raw.prepare(
      'INSERT INTO outbox (id, body, user_key, received_at, attempts, next_attempt_at, last_error) VALUES (?, ?, ?, ?, 0, 0, NULL)'
    ),
    nextDue: raw.prepare('SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY received_at, id LIMIT 1'),
    updateRetry: raw.prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?'),
    outboxById: raw.prepare('SELECT * FROM outbox WHERE id = ?'),
    deleteOutbox: raw.prepare('DELETE FROM outbox WHERE id = ?'),
    insertHistory: raw.prepare(
      'INSERT INTO history (id, body, user_key, received_at, finished_at, attempts, status, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    countOutbox: raw.prepare('SELECT COUNT(*) AS c FROM outbox'),
    oldestOutbox: raw.prepare('SELECT MIN(received_at) AS t FROM outbox'),
    listOutbox: raw.prepare('SELECT id, body, user_key, received_at, attempts, next_attempt_at, last_error FROM outbox ORDER BY received_at, id LIMIT ?'),
    listHistory: raw.prepare('SELECT * FROM history ORDER BY finished_at DESC LIMIT ?'),
    getRuntime: raw.prepare('SELECT value FROM runtime WHERE key = ?'),
    setRuntime: raw.prepare('INSERT INTO runtime (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    deleteRuntime: raw.prepare('DELETE FROM runtime WHERE key = ?')
  };

  const historyPrune = historyKeep > 0
    ? raw.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY finished_at DESC LIMIT ?)')
    : null;

  function transaction(fn) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        // ignore rollback failure; the original error is what matters
      }
      throw err;
    }
  }

  const store = {
    raw,

    enqueue({ id, body, key = null, receivedAt }) {
      stmt.insertOutbox.run(id, body, key, receivedAt);
      return { id, body, user_key: key, received_at: receivedAt, attempts: 0 };
    },

    nextDue(now) {
      return stmt.nextDue.get(now) ?? null;
    },

    updateRetry(id, attempts, nextAttemptAt, lastError) {
      stmt.updateRetry.run(attempts, nextAttemptAt, lastError ?? null, id);
    },

    complete(id, { status, finishedAt, attempts, lastError = null }) {
      return transaction(() => {
        const row = stmt.outboxById.get(id);
        if (!row) return false;
        stmt.insertHistory.run(
          row.id, row.body, row.user_key, row.received_at, finishedAt, attempts, status, lastError
        );
        stmt.deleteOutbox.run(id);
        if (historyPrune) historyPrune.run(historyKeep);
        return true;
      });
    },

    countOutbox() {
      return Number(stmt.countOutbox.get().c);
    },

    oldestReceivedAt() {
      return stmt.oldestOutbox.get()?.t ?? null;
    },

    listOutbox(limit = 50) {
      return stmt.listOutbox.all(limit);
    },

    listHistory(limit = 50) {
      return stmt.listHistory.all(limit);
    },

    getRuntime(key) {
      return stmt.getRuntime.get(key)?.value ?? null;
    },

    setRuntime(key, value) {
      stmt.setRuntime.run(key, String(value));
    },

    deleteRuntime(key) {
      stmt.deleteRuntime.run(key);
    },

    close() {
      raw.close();
    }
  };

  return store;
}
