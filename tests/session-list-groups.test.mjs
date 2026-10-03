// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupSessions, isUntitledSession } from '../app/src/renderer/src/session-list-groups.mjs';
import { locationBadgeCount } from '../app/src/renderer/src/location-counts.mjs';
import { sourceLabel } from '../app/src/renderer/src/source-catalog.mjs';

// Already filtered + sorted newest first, as SessionList.vue hands them over.
const sessions = [
  { id: 'a', title: 'Fix login', source: 'claude', ended_at: '2026-10-03T10:00:00Z' },
  { id: 'b', title: '', source: 'codex', ended_at: '2026-10-03T09:00:00Z' },
  { id: 'c', title: 'Refactor', source: 'pi', ended_at: '2026-10-03T08:00:00Z' },
  { id: 'd', title: null, source: 'claude', ended_at: '2026-10-03T07:00:00Z' },
];

test('default: untitled sessions are folded into the quiet group', () => {
  const { normal, noise } = groupSessions(sessions);
  assert.deepEqual(normal.map(s => s.id), ['a', 'c']);
  assert.deepEqual(noise.map(s => s.id), ['b', 'd']);
  assert.equal(isUntitledSession(sessions[1]), true);
  assert.deepEqual(groupSessions(sessions, { showUntitled: false }), { normal, noise });
});

test('showUntitled: one list with every session in the original (time) order', () => {
  const { normal, noise } = groupSessions(sessions, { showUntitled: true });
  assert.deepEqual(normal.map(s => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(noise, []);
  // Rows keep their agent info for the r5 marker.
  assert.deepEqual(normal.map(s => sourceLabel(s.source, [])), ['Claude Code', 'Codex', 'Pi', 'Claude Code']);
  assert.deepEqual(groupSessions(undefined, { showUntitled: true }), { normal: [], noise: [] });
});

test('toggling does not change the location counts (they come from the index summary)', () => {
  const locations = [{ id: 'local', sessionCount: 195 }, { id: 'ab12', sessionCount: 320 }];
  const before = locations.map(locationBadgeCount);
  groupSessions(sessions, { showUntitled: true });
  assert.deepEqual(locations.map(locationBadgeCount), before);
  // Sessions-row badge counts the whole loaded list, folded or not.
  assert.equal(sessions.length, 4);
});
