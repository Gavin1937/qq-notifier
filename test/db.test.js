import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

test('every primary key column is declared NOT NULL', () => {
  const db = openDb(':memory:');
  try {
    for (const table of ['outbox', 'history', 'runtime']) {
      const columns = db.raw.prepare(`PRAGMA table_info(${table})`).all();
      const primaryKeys = columns.filter((column) => column.pk > 0);
      assert.equal(primaryKeys.length, 1, `${table} has exactly one primary key column`);
      assert.equal(primaryKeys[0].notnull, 1, `${table}.${primaryKeys[0].name} must be NOT NULL`);
    }
  } finally {
    db.close();
  }
});

test('a NULL primary key is rejected', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(
      () => db.raw.prepare('INSERT INTO outbox (id, body, received_at) VALUES (NULL, ?, ?)').run('x', 1),
      /NOT NULL/
    );
    assert.throws(
      () => db.raw.prepare(
        'INSERT INTO history (id, body, received_at, finished_at, attempts, status) VALUES (NULL, ?, ?, ?, ?, ?)'
      ).run('x', 1, 2, 1, 'sent'),
      /NOT NULL/
    );
    assert.throws(
      () => db.raw.prepare('INSERT INTO runtime (key, value) VALUES (NULL, ?)').run('v'),
      /NOT NULL/
    );
  } finally {
    db.close();
  }
});
