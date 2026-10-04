// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from './temp-dirs.mjs';
import { buildIndex } from '../app/src/main/indexer.ts';
import {
  cleanCustomTitle,
  copyOverridesFromDb,
  normalizeHiddenMode,
  notHiddenCondition,
  sessionOverridesAvailable,
  sessionRowsQuery,
  setSessionOverride,
} from '../app/src/main/session-overrides.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

const COLUMNS = ['id', 'title', 'project', 'started_at', 'ended_at', 'source'];

function writeSession(projectDir, id, text, { withTitle = false } = {}) {
  const lines = [];
  if (withTitle) lines.push(JSON.stringify({ type: 'summary', summary: `Title of ${id}`, leafUuid: `u-${id}` }));
  lines.push(JSON.stringify({
    uuid: `u-${id}`, type: 'user', sessionId: id, timestamp: '2026-10-01T10:00:00Z', cwd: '/tmp/ov',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }));
  writeFileSync(join(projectDir, `${id}.jsonl`), `${lines.join('\n')}\n`);
}

function fixture() {
  const home = makeTempDir('trajex-overrides-');
  const claudeDir = join(home, '.claude');
  const projectDir = join(claudeDir, 'projects', '-tmp-ov');
  mkdirSync(projectDir, { recursive: true });
  writeSession(projectDir, 'sess-a', 'alpha work');
  writeSession(projectDir, 'sess-b', 'beta work');
  writeSession(projectDir, 'sess-c', 'gamma work');
  const dbPath = join(claudeDir, 'trajex.sqlite');
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });
  return { home, claudeDir, projectDir, dbPath };
}

function listIds(db, hidden = 'exclude') {
  const query = sessionRowsQuery(db, COLUMNS, hidden);
  const where = query.conditions.length ? ` WHERE ${query.conditions.join(' AND ')}` : '';
  return db.prepare(`${query.select}${where} ORDER BY s.id`).all();
}

test('rename is applied to the effective title and can be reverted', () => {
  const { dbPath } = fixture();
  const db = new TestDatabase(dbPath);
  try {
    const original = db.prepare('SELECT title FROM sessions WHERE id=?').get('sess-a').title;
    const renamed = setSessionOverride(db, 'sess-a', { title: '  My   custom\ntitle  ' }, 1000);
    assert.equal(renamed.customTitle, 'My custom title');
    assert.equal(renamed.title, 'My custom title');
    const row = listIds(db).find(r => r.id === 'sess-a');
    assert.equal(row.title, 'My custom title');
    assert.equal(row.original_title, original);
    assert.equal(Number(row.renamed), 1);
    // Untouched sessions are unchanged.
    assert.equal(Number(listIds(db).find(r => r.id === 'sess-b').renamed), 0);
    // Empty title = revert; the override row disappears entirely.
    const reverted = setSessionOverride(db, 'sess-a', { title: '' }, 2000);
    assert.equal(reverted.customTitle, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM session_overrides').get().c, 0);
    assert.equal(listIds(db).find(r => r.id === 'sess-a').title, original);
    assert.equal(cleanCustomTitle('x'.repeat(500)).length, 200);
    assert.equal(cleanCustomTitle(42), null);
  } finally {
    db.close();
  }
});

test('hidden sessions are excluded from lists and counts, listed in the hidden view, and restorable', () => {
  const { dbPath } = fixture();
  const db = new TestDatabase(dbPath);
  try {
    setSessionOverride(db, 'sess-b', { hidden: true }, 5);
    assert.deepEqual(listIds(db).map(r => r.id), ['sess-a', 'sess-c']);
    assert.deepEqual(listIds(db, 'only').map(r => r.id), ['sess-b']);
    assert.deepEqual(listIds(db, 'all').map(r => r.id), ['sess-a', 'sess-b', 'sess-c']);
    assert.ok(listIds(db, 'only')[0].hidden_at !== null);
    const countSql = `SELECT COUNT(*) AS c FROM sessions s WHERE ${notHiddenCondition(db, 's')}`;
    assert.equal(db.prepare(countSql).get().c, 2);
    // Renaming a hidden session keeps it hidden; restoring keeps the custom title.
    setSessionOverride(db, 'sess-b', { title: 'Keep me' }, 6);
    assert.equal(listIds(db, 'only')[0].title, 'Keep me');
    const restored = setSessionOverride(db, 'sess-b', { hidden: false }, 7);
    assert.equal(restored.hidden, false);
    assert.equal(restored.customTitle, 'Keep me');
    assert.equal(db.prepare(countSql).get().c, 3);
    assert.equal(normalizeHiddenMode('only'), 'only');
    assert.equal(normalizeHiddenMode('bogus'), 'exclude');
    assert.throws(() => setSessionOverride(db, 'does-not-exist', { hidden: true }), /not found/i);
  } finally {
    db.close();
  }
});

test('overrides survive an incremental reindex, an in-place force rebuild and the temp-DB rebuild', () => {
  const { claudeDir, projectDir, dbPath, home } = fixture();
  let db = new TestDatabase(dbPath);
  setSessionOverride(db, 'sess-a', { title: 'Renamed A' }, 1);
  setSessionOverride(db, 'sess-b', { hidden: true }, 2);
  db.close();

  // 1) incremental reindex of a changed transcript replaces its projection, not the override
  const jsonl = join(projectDir, 'sess-a.jsonl');
  appendFileSync(jsonl, `${JSON.stringify({ uuid: 'u-a2', type: 'user', sessionId: 'sess-a', timestamp: '2026-10-01T11:00:00Z', cwd: '/tmp/ov', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } })}\n`);
  utimesSync(jsonl, new Date(), new Date(Date.now() + 5000));
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase });
  db = new TestDatabase(dbPath);
  assert.equal(listIds(db).find(r => r.id === 'sess-a').title, 'Renamed A');
  assert.deepEqual(listIds(db, 'only').map(r => r.id), ['sess-b']);
  db.close();

  // 2) force rebuild in place: the cleanup statements must not touch session_overrides
  buildIndex({ claudeDir, dbPath, DatabaseImpl: TestDatabase, force: true });
  db = new TestDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM session_overrides').get().c, 2);
  assert.equal(listIds(db).find(r => r.id === 'sess-a').title, 'Renamed A');
  db.close();

  // 3) the App's manual rebuild: fresh temp DB + preserveDbPath (local and remote use the same path)
  const tempDbPath = join(home, 'rebuild.tmp.sqlite');
  buildIndex({ claudeDir, dbPath: tempDbPath, DatabaseImpl: TestDatabase, force: true, preserveDbPath: dbPath });
  const rebuilt = new TestDatabase(tempDbPath);
  try {
    assert.equal(listIds(rebuilt).find(r => r.id === 'sess-a').title, 'Renamed A');
    assert.deepEqual(listIds(rebuilt, 'only').map(r => r.id), ['sess-b']);
    assert.deepEqual(listIds(rebuilt).map(r => r.id), ['sess-a', 'sess-c']);
  } finally {
    rebuilt.close();
  }
});

test('copyOverridesFromDb tolerates a previous DB without the table and a missing file', () => {
  const home = makeTempDir('trajex-overrides-old-');
  const oldPath = join(home, 'old.sqlite');
  const old = new DatabaseSync(oldPath);
  old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  old.close();
  const target = new TestDatabase(join(home, 'new.sqlite'));
  try {
    assert.equal(sessionOverridesAvailable(target), true);
    assert.equal(copyOverridesFromDb(target, oldPath, existsSync), false);
    assert.equal(copyOverridesFromDb(target, join(home, 'nope.sqlite'), existsSync), false);
    assert.equal(copyOverridesFromDb(target, null, existsSync), false);
  } finally {
    target.close();
  }
});

test('overrides degrade to plain rows when the table cannot be created', () => {
  const fake = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) };
  assert.equal(sessionOverridesAvailable(fake), false);
  assert.equal(notHiddenCondition(fake, 's'), '');
  const normal = sessionRowsQuery(fake, ['id', 'title']);
  assert.equal(normal.select, 'SELECT s.id, s.title FROM sessions s');
  assert.deepEqual(normal.conditions, []);
  assert.deepEqual(sessionRowsQuery(fake, ['id'], 'only').conditions, ['0']);
  assert.throws(() => setSessionOverride(fake, 'x', { hidden: true }), /unavailable/i);
});
