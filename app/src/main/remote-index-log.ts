// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Append-only diagnostic log for remote index builds
 * (~/.trajex/remote-index.log). One ISO-timestamped line per entry; when the
 * file grows past `maxBytes` it is rotated to `<file>.1` (replacing the previous
 * rotation), so at most ~2 x maxBytes stay on disk. Logging must never break
 * indexing, so every failure is swallowed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const REMOTE_INDEX_LOG_MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface IndexLogOptions {
  filePath: string;
  maxBytes?: number;
  now?: () => Date;
  fsImpl?: Pick<typeof fs, 'appendFileSync' | 'statSync' | 'renameSync' | 'rmSync' | 'mkdirSync'>;
}

/** Newlines would break the one-line-per-entry format; stack traces are folded. */
export function formatLogLine(date: Date, level: LogLevel, scope: string, message: string): string {
  const flat = String(message).replace(/\r?\n/g, ' | ');
  const clipped = flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS)}… [truncated]` : flat;
  return `${date.toISOString()} ${level} [${scope}] ${clipped}\n`;
}

export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

export function createIndexLog({
  filePath,
  maxBytes = REMOTE_INDEX_LOG_MAX_BYTES,
  now = () => new Date(),
  fsImpl = fs,
}: IndexLogOptions) {
  let size: number | null = null;

  const currentSize = (): number => {
    if (size !== null) return size;
    try {
      size = fsImpl.statSync(filePath).size;
    } catch {
      size = 0;
    }
    return size;
  };

  const rotate = () => {
    try {
      fsImpl.rmSync(`${filePath}.1`, { force: true });
      fsImpl.renameSync(filePath, `${filePath}.1`);
    } catch {
      try { fsImpl.rmSync(filePath, { force: true }); } catch {}
    }
    size = 0;
  };

  const write = (level: LogLevel, scope: string, message: string) => {
    try {
      const line = formatLogLine(now(), level, scope, message);
      if (currentSize() + Buffer.byteLength(line) > maxBytes) rotate();
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      fsImpl.appendFileSync(filePath, line);
      size = currentSize() + Buffer.byteLength(line);
    } catch {
      size = null;
    }
  };

  return {
    filePath,
    info: (scope: string, message: string) => write('INFO', scope, message),
    warn: (scope: string, message: string) => write('WARN', scope, message),
    error: (scope: string, message: string, error?: unknown) => write(
      'ERROR', scope, error === undefined ? message : `${message}: ${errorDetail(error)}`,
    ),
  };
}

export type IndexLog = ReturnType<typeof createIndexLog>;
