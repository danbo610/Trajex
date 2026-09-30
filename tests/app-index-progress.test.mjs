// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProgressReporter, createStallWatchdog } from '../app/src/main/index-progress.ts';
import { createIndexLog, formatLogLine } from '../app/src/main/remote-index-log.ts';
import {
  describeProgress,
  formatElapsed,
  isStalled,
  progressFraction,
  shortProgress,
} from '../app/src/shared/index-progress.mjs';
import { createWorkerBuildIndex } from '../app/src/main/indexer-worker-client.ts';
import { buildIndex } from '../app/src/main/indexer.ts';

test('formatElapsed renders compact durations', () => {
  assert.equal(formatElapsed(4200), '4s');
  assert.equal(formatElapsed(130_000), '2m 10s');
  assert.equal(formatElapsed(65_000), '1m 05s');
  assert.equal(formatElapsed(3_700_000), '1h 01m');
  assert.equal(formatElapsed(-5), '0s');
});

test('describeProgress matches the documented UI wording', () => {
  const base = { phase: 'indexing', done: 123, total: 870, provider: 'claude', startedAt: 1_000 };
  assert.equal(describeProgress(base, 1_000 + 130_000), 'Indexing… 123 / 870 files (Claude), 2m 10s');
  assert.equal(describeProgress({ ...base, phase: 'discovering', provider: null }, 6_000), 'Scanning directories…, 5s');
  assert.match(describeProgress({ ...base, phase: 'finalizing' }, 61_000), /^Finalizing index…/);
  assert.equal(describeProgress(null), '');
  assert.equal(progressFraction(base), 123 / 870);
  assert.equal(progressFraction({ ...base, total: 0 }), null);
  assert.equal(shortProgress({ ...base, done: 435 }), '50%');
  assert.equal(shortProgress({ phase: 'discovering' }), '…');
  assert.equal(isStalled({ updatedAt: 0 }, 59_999), false);
  assert.equal(isStalled({ updatedAt: 0 }, 60_000), true);
});

test('progress reporter throttles snapshots but always emits phase changes and the last file', () => {
  let clock = 0;
  const snapshots = [];
  const events = [];
  const reporter = createProgressReporter({
    now: () => clock,
    onProgress: (p) => snapshots.push(p),
    onEvent: (e) => events.push(e),
  });
  reporter.begin();
  reporter.discoverStart('claude');
  reporter.discoverDone('claude', 3);
  clock = 100;
  reporter.startIndexing([{ provider: 'claude' }, { provider: 'claude' }, { provider: 'codex' }]);
  const beforeItems = snapshots.length;
  reporter.itemStart('claude', '/a.jsonl'); // within 250ms of the phase snapshot: throttled
  reporter.itemDone('claude');
  assert.equal(snapshots.length, beforeItems);
  clock = 400;
  reporter.itemStart('claude', '/b.jsonl');
  assert.equal(snapshots.length, beforeItems + 1);
  assert.equal(snapshots.at(-1).currentFile, '/b.jsonl');
  assert.equal(snapshots.at(-1).done, 1);
  reporter.itemSkipped('claude', '/b.jsonl', 'boom');
  clock = 410;
  reporter.itemStart('codex', '/c.jsonl');
  reporter.itemDone('codex'); // last file is always emitted
  const last = snapshots.at(-1);
  assert.equal(last.done, 3);
  assert.equal(last.total, 3);
  assert.equal(last.skipped, 1);
  reporter.finalizing();
  assert.equal(snapshots.at(-1).phase, 'finalizing');
  reporter.finish();
  assert.equal(snapshots.at(-1).phase, 'done');
  assert.deepEqual(events.filter(e => e.type === 'skipped'), [{ type: 'skipped', provider: 'claude', path: '/b.jsonl', error: 'boom' }]);
  assert.deepEqual(events.filter(e => e.type === 'discovered').map(e => e.units), [3]);
  assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase), ['discovering', 'indexing', 'finalizing', 'done']);
});

test('stall watchdog reports once per silent interval and resets on activity', () => {
  let clock = 0;
  const dog = createStallWatchdog({ thresholdMs: 60_000, now: () => clock });
  clock = 59_000;
  assert.equal(dog.check(), null);
  clock = 61_000;
  assert.equal(dog.check(), 61_000);
  clock = 65_000;
  assert.equal(dog.check(), null);
  clock = 121_500;
  assert.equal(dog.check(), 121_500);
  dog.touch();
  clock = 130_000;
  assert.equal(dog.check(), null);
});

test('index log writes ISO lines, folds stacks and rotates past maxBytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajex-log-'));
  try {
    const file = path.join(dir, 'nested', 'remote-index.log');
    const fixed = () => new Date('2026-09-30T08:00:00.000Z');
    const log = createIndexLog({ filePath: file, maxBytes: 20_000, now: fixed });
    log.info('remote:ab12', 'build start');
    log.error('remote:ab12', 'build failed', new Error('share went away'));
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^2026-09-30T08:00:00\.000Z INFO \[remote:ab12\] build start$/);
    assert.match(lines[1], /ERROR \[remote:ab12\] build failed: Error: share went away \| +at /);
    const small = createIndexLog({ filePath: file, maxBytes: 600, now: fixed });
    for (let i = 0; i < 10; i += 1) small.warn('remote:ab12', `skipped file ${i} ${'x'.repeat(80)}`);
    assert.ok(fs.existsSync(`${file}.1`), 'rotated file exists');
    assert.ok(fs.statSync(file).size <= 600, 'active log stays under the limit');
    assert.ok(fs.readFileSync(file, 'utf8').includes('skipped file 9'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('index log never throws when the filesystem fails', () => {
  const broken = {
    appendFileSync() { throw new Error('EROFS'); },
    statSync() { throw new Error('ENOENT'); },
    renameSync() {}, rmSync() {}, mkdirSync() {},
  };
  const log = createIndexLog({ filePath: '/nope/x.log', fsImpl: broken });
  assert.doesNotThrow(() => log.error('s', 'm', new Error('e')));
  assert.match(formatLogLine(new Date(0), 'INFO', 's', 'a\nb'), /a \| b\n$/);
});

test('worker client forwards progress/event messages without settling the build', async () => {
  const seen = { progress: [], event: [] };
  let posted;
  class MockWorker {
    constructor() { this.handlers = {}; }
    on(event, handler) { this.handlers[event] = handler; return this; }
    postMessage(message) {
      posted = message;
      queueMicrotask(() => {
        this.handlers.message({ id: message.id, progress: { phase: 'indexing', done: 1, total: 2 } });
        this.handlers.message({ id: message.id, event: { type: 'phase', phase: 'finalizing', elapsedMs: 5 } });
        this.handlers.message({ id: message.id, result: { files: 2 } });
      });
    }
    terminate() {}
  }
  const client = createWorkerBuildIndex({ WorkerImpl: MockWorker, workerPath: '/tmp/w.js' });
  const result = await client.buildIndex({ reason: 'x' }, {
    onProgress: (p) => seen.progress.push(p),
    onEvent: (e) => seen.event.push(e),
  });
  assert.deepEqual(result, { files: 2 });
  assert.equal(posted.args.reportProgress, true);
  assert.equal(seen.progress.length, 1);
  assert.equal(seen.event[0].phase, 'finalizing');
  // Without an observer the worker is not asked to report.
  await client.buildIndex({ reason: 'y' });
  assert.equal(posted.args.reportProgress, undefined);
  client.stop();
});

test('buildIndex reports discovery, per-file progress and finalizing for a real build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trajex-progress-'));
  try {
    const claudeDir = path.join(dir, '.claude');
    const projectDir = path.join(claudeDir, 'projects', '-tmp-demo');
    fs.mkdirSync(projectDir, { recursive: true });
    for (const id of ['s1', 's2', 's3']) {
      const line = JSON.stringify({
        type: 'user', uuid: `u-${id}`, sessionId: id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/demo',
        message: { role: 'user', content: `hello ${id}` },
      });
      fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${line}\n`);
    }
    const snapshots = [];
    const events = [];
    const result = buildIndex({
      claudeDir,
      dbPath: path.join(dir, 'index.sqlite'),
      enabledProviders: ['claude'],
      providerRoots: { claude: claudeDir },
      onProgress: (p) => snapshots.push(p),
      onEvent: (e) => events.push(e),
    });
    assert.equal(result.files, 3);
    const indexing = snapshots.filter(s => s.phase === 'indexing');
    assert.equal(indexing.at(-1).done, 3);
    assert.equal(indexing.at(-1).total, 3);
    assert.equal(indexing.at(-1).provider, 'claude');
    assert.deepEqual(events.filter(e => e.type === 'phase').map(e => e.phase), ['discovering', 'indexing', 'finalizing', 'done']);
    assert.equal(events.find(e => e.type === 'discovered')?.units, 3);
    // Without hooks the local behaviour is untouched.
    const plain = buildIndex({ claudeDir, dbPath: path.join(dir, 'plain.sqlite'), enabledProviders: ['claude'], providerRoots: { claude: claudeDir } });
    assert.equal(plain.files, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
