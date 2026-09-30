// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sourceColor, sourceLabel } from '../app/src/renderer/src/source-catalog.mjs';

const catalog = [
  { id: 'alpha', name: 'Alpha Agent', color: '#112233' },
  { id: 'beta', name: 'Beta Code', color: '#445566' },
];

test('renderer source presentation comes from the runtime provider catalog', () => {
  assert.equal(sourceLabel('beta', catalog), 'Beta Code');
  assert.equal(sourceColor('alpha', catalog), '#112233');
  assert.equal(sourceLabel('future-provider', catalog), 'Future Provider');
  assert.equal(sourceColor('future-provider', catalog), '#8b8b93');
});

test('built-in agents keep their characteristic label and color before the catalog loads', () => {
  assert.equal(sourceLabel('claude', []), 'Claude Code');
  assert.equal(sourceLabel(undefined, []), 'Claude Code');
  assert.equal(sourceLabel('codex', []), 'Codex');
  assert.equal(sourceLabel('pi', []), 'Pi');
  assert.equal(sourceColor('claude', []), '#d97757');
  assert.equal(sourceColor('codex', []), '#10a37f');
  assert.equal(sourceColor('pi', []), '#7c3aed');
  // The runtime catalog still wins.
  assert.equal(sourceColor('codex', [{ id: 'codex', name: 'Codex', color: '#000001' }]), '#000001');
});
