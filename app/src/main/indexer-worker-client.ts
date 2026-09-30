// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { IndexEvent, IndexProgress } from './index-progress.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WorkerMessage {
  id: number;
  result?: unknown;
  progress?: IndexProgress;
  event?: IndexEvent;
  error?: { message: string; stack?: string };
}

export interface BuildObserver {
  onProgress?: (progress: IndexProgress) => void;
  onEvent?: (event: IndexEvent) => void;
}

interface PendingBuild extends BuildObserver {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface WorkerBuildIndexOptions {
  workerPath?: string;
  WorkerImpl?: typeof Worker;
}

function createWorkerBuildIndex({
  // indexer-worker.js is the built worker output emitted next to this module.
  workerPath = path.join(__dirname, 'indexer-worker.js'),
  WorkerImpl = Worker,
}: WorkerBuildIndexOptions = {}) {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingBuild>();

  const rejectPending = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const active = new WorkerImpl(workerPath, { type: 'module' } as ConstructorParameters<typeof Worker>[1]);
    worker = active;
    active.on('message', (message: WorkerMessage) => {
      const current = pending.get(message.id);
      if (!current) return;
      // Progress / event messages keep the build pending.
      if (message.progress) { current.onProgress?.(message.progress); return; }
      if (message.event) { current.onEvent?.(message.event); return; }
      pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack;
        current.reject(error);
      } else {
        current.resolve(message.result);
      }
    });
    active.on('error', (error: Error) => {
      rejectPending(error);
      worker = null;
    });
    active.on('exit', (code: number) => {
      if (pending.size) rejectPending(new Error(`Indexer worker exited with code ${code}`));
      worker = null;
    });
    return active;
  };

  const buildIndex = (args: Record<string, unknown> = {}, observer: BuildObserver = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const observed = Boolean(observer.onProgress || observer.onEvent);
    pending.set(id, { resolve, reject, ...observer });
    ensureWorker().postMessage({ id, args: observed ? { ...args, reportProgress: true } : args });
  });

  const stop = () => {
    const current = worker;
    worker = null;
    const termination = current?.terminate ? Promise.resolve(current.terminate()) : Promise.resolve();
    rejectPending(new Error('Indexer worker stopped'));
    return termination;
  };

  return { buildIndex, stop };
}

export { createWorkerBuildIndex };
