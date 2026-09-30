// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  LOCAL_LOCATION,
  addRemote,
  configuredRemoteRoots,
  detectRemoteHomeRoots,
  isRemoteId,
  normalizeLocationId,
  readRemotes,
  remoteBuildArgs,
  remoteDbPath,
  remoteWriterLeasePath,
  removeRemote,
  updateRemote,
} from '../app/src/main/remote-sources.ts';

test('location ids: local by default, remote ids are filename-safe', () => {
  assert.equal(normalizeLocationId(undefined), LOCAL_LOCATION);
  assert.equal(normalizeLocationId('local'), LOCAL_LOCATION);
  assert.equal(normalizeLocationId('a1b2c3d4'), 'a1b2c3d4');
  assert.equal(normalizeLocationId('../etc/passwd'), null);
  assert.equal(normalizeLocationId('a/b'), null);
  assert.equal(isRemoteId('local'), false);
});

test('remote db and lease paths are per remote and never the local ones', () => {
  assert.equal(remoteDbPath('/h/.trajex', 'ab12'), join('/h/.trajex', 'remote-ab12.sqlite'));
  assert.notEqual(remoteWriterLeasePath('/h/.trajex', 'ab12'), join('/h/.trajex', 'writer.lock.sqlite'));
  assert.notEqual(remoteWriterLeasePath('/h/.trajex', 'ab12'), remoteWriterLeasePath('/h/.trajex', 'cd34'));
});

test('add / update / remove keep stable ids and blank roots mean not configured', () => {
  const persisted = { autoRefresh: true };
  const ids = ['aaaa1111', 'bbbb2222'];
  const one = addRemote(persisted, { name: ' Other Mac ', providerRoots: { claude: '/mnt/mac/.claude', codex: '   ', pi: '' } }, () => ids.shift());
  assert.equal(one.id, 'aaaa1111');
  assert.equal(one.name, 'Other Mac');
  assert.deepEqual(one.providerRoots, { claude: '/mnt/mac/.claude' });
  const two = addRemote(persisted, {}, () => ids.shift());
  assert.equal(two.name, 'Remote 2');
  assert.deepEqual(readRemotes(persisted).map(r => r.id), ['aaaa1111', 'bbbb2222']);

  const renamed = updateRemote(persisted, 'aaaa1111', { name: 'Mac mini' });
  assert.equal(renamed.rootsChanged, false);
  assert.equal(renamed.remote.id, 'aaaa1111');
  const changed = updateRemote(persisted, 'aaaa1111', { providerRoots: { claude: '/mnt/mac/.claude', pi: '/mnt/mac/.pi/agent/sessions' } });
  assert.equal(changed.rootsChanged, true);
  assert.equal(updateRemote(persisted, 'nope0000', { name: 'x' }), null);

  assert.equal(removeRemote(persisted, 'bbbb2222').id, 'bbbb2222');
  assert.deepEqual(readRemotes(persisted).map(r => r.id), ['aaaa1111']);
  removeRemote(persisted, 'aaaa1111');
  assert.equal('remotes' in persisted, false);
  assert.equal(persisted.autoRefresh, true);
});

test('readRemotes drops malformed and duplicate entries', () => {
  const remotes = readRemotes({
    remotes: [
      null,
      { id: '../x', name: 'bad' },
      { id: 'ok1', name: '', providerRoots: { claude: ' /a ', codex: 5 } },
      { id: 'ok1', name: 'dup' },
    ],
  });
  assert.equal(remotes.length, 1);
  assert.deepEqual(remotes[0].providerRoots, { claude: '/a' });
  assert.equal(remotes[0].name, 'Remote 1');
});

test('remote build args only enable configured providers and never fall back to local roots', () => {
  const remote = { id: 'r1', name: 'R', providerRoots: { codex: '/mnt/r/.codex', pi: '/mnt/r/.pi/agent/sessions' } };
  assert.deepEqual(configuredRemoteRoots(remote).map(r => r.provider), ['codex', 'pi']);
  const args = remoteBuildArgs(remote);
  assert.deepEqual(args.enabledProviders, ['codex', 'pi']);
  assert.deepEqual(args.providerRoots, { codex: '/mnt/r/.codex', pi: '/mnt/r/.pi/agent/sessions' });
  assert.equal('claudeDir' in args, false);
  assert.equal(remoteBuildArgs({ id: 'r2', name: 'x', providerRoots: {} }).enabledProviders.length, 0);
});

test('pick-home shortcut fills only directories that exist', () => {
  const existing = new Set(['/mnt/mac/.claude', '/mnt/mac/.pi/agent/sessions']);
  assert.deepEqual(detectRemoteHomeRoots('/mnt/mac', p => existing.has(p)), {
    claude: '/mnt/mac/.claude',
    pi: '/mnt/mac/.pi/agent/sessions',
  });
  assert.deepEqual(detectRemoteHomeRoots('/mnt/empty', () => false), {});
});
