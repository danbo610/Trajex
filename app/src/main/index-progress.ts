// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Progress reporting for index builds. Pure (no electron / fs): buildIndex()
 * feeds it the discover / parse loop events, it turns them into throttled
 * snapshots (for the UI) and discrete events (for the log file). In the worker
 * thread the callbacks are wired to postMessage, in tests to plain arrays.
 */

export type IndexPhase = 'discovering' | 'indexing' | 'finalizing' | 'done';

export interface IndexProgress {
  phase: IndexPhase;
  /** Files finished (indexed or skipped) / files planned. */
  done: number;
  total: number;
  /** Provider currently being discovered / parsed. */
  provider: string | null;
  providerDone: number;
  providerTotal: number;
  currentFile: string | null;
  skipped: number;
  startedAt: number;
  elapsedMs: number;
  updatedAt: number;
}

export type IndexEvent =
  | { type: 'phase'; phase: IndexPhase; elapsedMs: number; total?: number }
  | { type: 'discovered'; provider: string; units: number; ms: number }
  | { type: 'skipped'; provider: string; path: string; error: string };

export interface ProgressReporterOptions {
  onProgress?: (progress: IndexProgress) => void;
  onEvent?: (event: IndexEvent) => void;
  now?: () => number;
  intervalMs?: number;
}

export const PROGRESS_INTERVAL_MS = 250;

export function createProgressReporter({
  onProgress,
  onEvent,
  now = Date.now,
  intervalMs = PROGRESS_INTERVAL_MS,
}: ProgressReporterOptions = {}) {
  const startedAt = now();
  let phase: IndexPhase = 'discovering';
  let done = 0;
  let total = 0;
  let skipped = 0;
  let provider: string | null = null;
  let currentFile: string | null = null;
  const providerTotals = new Map<string, number>();
  const providerDones = new Map<string, number>();
  const discoverStartedAt = new Map<string, number>();
  let lastEmit = Number.NEGATIVE_INFINITY;

  const snapshot = (): IndexProgress => {
    const t = now();
    return {
      phase,
      done,
      total,
      provider,
      providerDone: provider ? providerDones.get(provider) ?? 0 : 0,
      providerTotal: provider ? providerTotals.get(provider) ?? 0 : 0,
      currentFile,
      skipped,
      startedAt,
      elapsedMs: t - startedAt,
      updatedAt: t,
    };
  };

  const emit = (force = false) => {
    if (!onProgress) return;
    const t = now();
    if (!force && t - lastEmit < intervalMs) return;
    lastEmit = t;
    onProgress(snapshot());
  };

  const setPhase = (next: IndexPhase, extra: { total?: number } = {}) => {
    phase = next;
    onEvent?.({ type: 'phase', phase: next, elapsedMs: now() - startedAt, ...extra });
    emit(true);
  };

  const itemDone = (name: string) => {
    done += 1;
    providerDones.set(name, (providerDones.get(name) ?? 0) + 1);
    emit(done >= total);
  };

  return {
    /** Emit the initial "discovering" snapshot. */
    begin() {
      onEvent?.({ type: 'phase', phase: 'discovering', elapsedMs: 0 });
      emit(true);
    },
    discoverStart(name: string) {
      provider = name;
      discoverStartedAt.set(name, now());
      emit(true);
    },
    discoverDone(name: string, units: number) {
      const began = discoverStartedAt.get(name) ?? startedAt;
      onEvent?.({ type: 'discovered', provider: name, units, ms: now() - began });
      emit(true);
    },
    /** Discovery finished; `items` is the planned work list. */
    startIndexing(items: ReadonlyArray<{ provider: string }>) {
      total = items.length;
      for (const item of items) providerTotals.set(item.provider, (providerTotals.get(item.provider) ?? 0) + 1);
      provider = items[0]?.provider ?? provider;
      setPhase('indexing', { total });
    },
    itemStart(name: string, file: string) {
      provider = name;
      currentFile = file;
      emit();
    },
    itemDone,
    itemSkipped(name: string, file: string, error: string) {
      skipped += 1;
      onEvent?.({ type: 'skipped', provider: name, path: file, error });
      itemDone(name);
    },
    finalizing() {
      currentFile = null;
      setPhase('finalizing');
    },
    finish() {
      currentFile = null;
      setPhase('done');
    },
    snapshot,
  };
}

export type ProgressReporter = ReturnType<typeof createProgressReporter>;

/**
 * "No progress for N s" watchdog. The caller feeds it every progress message
 * with touch() and calls check() on a timer; check() returns the stall length
 * (ms) once per `thresholdMs` of silence, otherwise null.
 */
export function createStallWatchdog({
  thresholdMs = 60_000,
  now = Date.now,
}: { thresholdMs?: number; now?: () => number } = {}) {
  let lastActivity = now();
  let lastReported = 0;
  return {
    touch() {
      lastActivity = now();
      lastReported = 0;
    },
    check(): number | null {
      const silent = now() - lastActivity;
      if (silent < thresholdMs || silent - lastReported < thresholdMs) return null;
      lastReported = silent - (silent % thresholdMs);
      return silent;
    },
  };
}
