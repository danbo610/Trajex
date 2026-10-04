// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { state, findSessionById, getSessionSummary, setLocation } from '../app/src/renderer/src/store.js';
import { commitInitialData, renameSession, setSessionHidden } from '../app/src/renderer/src/data.js';

function installApi(calls) {
  globalThis.window = {
    trajex: {
      renameSession: async (id, title, location) => {
        calls.push(['rename', id, title, location]);
        return { sessionId: id, customTitle: title, title: title ?? 'Original', hidden: false };
      },
      setSessionHidden: async (id, hidden, location) => {
        calls.push(['hide', id, hidden, location]);
        return { sessionId: id, hidden };
      },
      getLocations: async () => [{ id: 'local', name: 'Local', kind: 'local', sessionCount: 1, status: 'ok' }],
    },
  };
}

test('rename and hide update the renderer lists immediately and keep hidden sessions findable', async () => {
  const calls = [];
  installApi(calls);
  setLocation('local');
  commitInitialData({
    rawMemories: [],
    rawSessions: [
      { id: 's1', title: '', started_at: '2026-10-01T10:00:00Z', ended_at: '2026-10-01T10:00:00Z' },
      { id: 's2', title: 'Two', started_at: '2026-10-02T10:00:00Z', ended_at: '2026-10-02T10:00:00Z' },
    ],
    rawHidden: [{ id: 's9', title: 'Old', started_at: '2026-09-01T10:00:00Z' }],
    stats: {}, projects: [], location: 'local',
  });
  assert.deepEqual(state.hiddenSessions.map(s => s.id), ['s9']);
  assert.equal(findSessionById('s9').title, 'Old');

  await renameSession('s1', 'Named now');
  assert.equal(state.sessions.find(s => s.id === 's1').title, 'Named now');
  assert.equal(state.sessions.find(s => s.id === 's1').renamed, true);
  assert.equal(getSessionSummary('s1').title, 'Named now');
  await renameSession('s1', null);
  assert.equal(state.sessions.find(s => s.id === 's1').renamed, false);

  await setSessionHidden('s2', true);
  assert.deepEqual(state.sessions.map(s => s.id), ['s1']);
  assert.deepEqual(state.hiddenSessions.map(s => s.id), ['s2', 's9']); // newest first
  state.showHiddenSessions = true;
  await setSessionHidden('s2', false);
  await setSessionHidden('s9', false);
  assert.deepEqual(state.sessions.map(s => s.id), ['s2', 's1', 's9']); // restored rows re-enter in time order
  assert.equal(state.hiddenSessions.length, 0);
  assert.equal(state.showHiddenSessions, false, 'hidden view closes when nothing is hidden anymore');
  assert.deepEqual(calls.map(c => c[0]), ['rename', 'rename', 'hide', 'hide', 'hide']);
  delete globalThis.window;
});
