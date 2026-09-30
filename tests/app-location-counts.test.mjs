// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { locationBadgeCount, mergeLocations } from '../app/src/renderer/src/location-counts.mjs';
import { state, setLocation } from '../app/src/renderer/src/store.js';
import { createIndexLog, isDebugLoggingEnabled } from '../app/src/main/remote-index-log.ts';

const locs = () => [
  { id: 'local', name: 'Local', kind: 'local', sessionCount: 195, status: 'ok' },
  { id: 'ab12', name: 'Mac', kind: 'remote', sessionCount: 320, status: 'ok' },
];

test('regression: switching location does not zero the sidebar location counts', () => {
  state.locations = locs();
  state.location = 'local';
  state.sessions = new Array(195).fill({ id: 'x' });
  assert.equal(setLocation('ab12'), true);
  // setLocation empties the loaded list (the old badge read its length)…
  assert.equal(state.sessions.length, 0);
  // …but the per-location badge comes from the location summary and stays put.
  assert.deepEqual(state.locations.map(locationBadgeCount), [195, 320]);
  assert.equal(setLocation('local'), true);
  assert.deepEqual(state.locations.map(locationBadgeCount), [195, 320]);
});

test('mergeLocations keeps the last known count while a remote index is being swapped', () => {
  const previous = locs();
  const swapping = [
    { ...previous[0] },
    { ...previous[1], sessionCount: 0, status: 'indexing' },
  ];
  assert.equal(mergeLocations(previous, swapping)[1].sessionCount, 320);
  // A genuine zero (not indexing) is respected, and new remotes start at 0.
  const empty = [{ ...previous[0] }, { ...previous[1], sessionCount: 0, status: 'ok' }, { id: 'new1', sessionCount: undefined, status: 'idle' }];
  const merged = mergeLocations(previous, empty);
  assert.equal(merged[1].sessionCount, 0);
  assert.equal(merged[2].sessionCount, 0);
  assert.equal(locationBadgeCount(undefined), 0);
});

test('debug logging is off by default, on via setting or TRAJEX_DEBUG', () => {
  assert.equal(isDebugLoggingEnabled({}, {}), false);
  assert.equal(isDebugLoggingEnabled(null, {}), false);
  assert.equal(isDebugLoggingEnabled({ debugLogging: true }, {}), true);
  assert.equal(isDebugLoggingEnabled({ debugLogging: 'yes' }, {}), false);
  assert.equal(isDebugLoggingEnabled({}, { TRAJEX_DEBUG: '1' }), true);
  assert.equal(isDebugLoggingEnabled({}, { TRAJEX_DEBUG: '0' }), false);
});

test('index log writes nothing while disabled and starts as soon as it is enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajex-log-sw-'));
  try {
    const file = path.join(dir, 'remote-index.log');
    let on = false;
    const log = createIndexLog({ filePath: file, enabled: () => on });
    log.info('s', 'ignored');
    log.error('s', 'ignored too', new Error('x'));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0);
    on = true;
    log.info('s', 'kept');
    assert.match(fs.readFileSync(file, 'utf8'), /kept/);
    on = false;
    log.info('s', 'dropped');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /dropped/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
