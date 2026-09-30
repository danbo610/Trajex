// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { makeTempDir } from './temp-dirs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildIndex } from '../app/src/main/indexer.ts';
import { remoteBuildArgs, remoteDbPath, remoteWriterLeasePath } from '../app/src/main/remote-sources.ts';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
  constructor(dbPath) { this.db = new DatabaseSync(dbPath); }
  pragma(statement) { this.db.exec(`PRAGMA ${statement}`); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { return this.db.close(); }
}

function writeClaudeSession(root, project, sessionId, text) {
  const dir = join(root, 'projects', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
    uuid: `msg-${sessionId}`,
    type: 'user',
    timestamp: '2026-06-13T10:00:00Z',
    cwd: '/remote/machine/project',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`);
}

test('a remote index DB is built from an independent root without touching the local DB', () => {
  const home = makeTempDir('trajex-remote-home-');
  const trajexDir = join(home, '.trajex');
  const localClaude = join(home, '.claude');
  const remoteClaude = join(home, 'mnt', 'other-mac', '.claude');
  writeClaudeSession(localClaude, '-local-proj', 'local-session', 'local text');
  writeClaudeSession(remoteClaude, '-remote-proj', 'remote-session', 'remote text');

  const localDb = join(trajexDir, 'trajex.sqlite');
  buildIndex({ claudeDir: localClaude, dbPath: localDb, DatabaseImpl: TestDatabase });

  const remote = { id: 'abcd1234', name: 'Other Mac', providerRoots: { claude: remoteClaude } };
  const remoteDb = remoteDbPath(trajexDir, remote.id);
  // Unconfigured codex/pi must not fall back to the local defaults.
  const result = buildIndex({
    ...remoteBuildArgs(remote),
    dbPath: remoteDb,
    writerLeasePath: remoteWriterLeasePath(trajexDir, remote.id),
    DatabaseImpl: TestDatabase,
  });
  assert.deepEqual(result.affectedSessionIds, ['remote-session']);
  assert.equal(existsSync(remoteDb), true);

  const local = new TestDatabase(localDb);
  const remoteHandle = new TestDatabase(remoteDb);
  try {
    assert.deepEqual(local.prepare('SELECT id FROM sessions').all().map(r => r.id), ['local-session']);
    assert.deepEqual(remoteHandle.prepare('SELECT id FROM sessions').all().map(r => r.id), ['remote-session']);
    assert.equal(remoteHandle.prepare('SELECT text FROM messages').get().text, 'remote text');
  } finally {
    local.close();
    remoteHandle.close();
  }

  // Incremental re-scan of the remote leaves it intact; an unreachable root keeps the old index.
  const again = buildIndex({
    ...remoteBuildArgs({ ...remote, providerRoots: { claude: join(home, 'mnt', 'gone', '.claude') } }),
    dbPath: remoteDb,
    writerLeasePath: remoteWriterLeasePath(trajexDir, remote.id),
    DatabaseImpl: TestDatabase,
  });
  const check = new TestDatabase(remoteDb);
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1, 'old index kept');
    assert.ok(again.inventoryIssues.length > 0 || again.files === 0);
  } finally {
    check.close();
  }
});
