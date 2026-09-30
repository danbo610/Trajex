// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/** 'local' (default) or a remote id; selects which index DB a query reads. */
export type LocationId = string;

export interface SourceQueryOptions {
  source?: string;
  location?: LocationId;
}

export type UsageStatsOptions = SourceQueryOptions;

export type SessionPatchTable =
  | 'messages'
  | 'toolCalls'
  | 'toolResults'
  | 'subagents'
  | 'workflows'
  | 'summaries';

export type SessionPatchRow = Record<string, unknown>;
export type SessionPatchSnapshot = Partial<Record<SessionPatchTable, SessionPatchRow[]>>;
export type SessionPatchCursor = Record<SessionPatchTable, Record<string, string>>;

export interface SessionMetadata {
  id: string;
  title?: string | null;
  project?: string | null;
  project_path?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  git_branch?: string | null;
  version?: string | null;
  message_count?: number | null;
  jsonl_path?: string | null;
  source?: string | null;
}

export interface SessionPatch {
  changes: Record<SessionPatchTable, SessionPatchRow[]>;
  removed: Record<SessionPatchTable, string[]>;
  hashes: Record<SessionPatchTable, Record<string, string>>;
  positions: Record<SessionPatchTable, Record<string, number>>;
  session?: SessionMetadata | null;
}

export interface AppliedSessionPatch {
  snapshot: Record<SessionPatchTable, SessionPatchRow[]>;
  cursor: SessionPatchCursor;
}

export interface RemoteProviderRootsConfig {
  claude?: string;
  codex?: string;
  pi?: string;
}

export interface IndexProgressInfo {
  phase: 'discovering' | 'indexing' | 'finalizing' | 'done';
  done: number;
  total: number;
  provider: string | null;
  providerDone: number;
  providerTotal: number;
  currentFile: string | null;
  skipped: number;
  startedAt: number;
  elapsedMs: number;
  updatedAt: number;
}

export interface RemoteIndexProgressPayload {
  id: string;
  progress: IndexProgressInfo | null;
  stalledSeconds: number;
}

export interface RemoteBuildSummaryInfo {
  finishedAt: string;
  durationMs: number;
  files: number;
  skipped: number;
  force: boolean;
}

export interface RemoteSummary {
  id: string;
  name: string;
  providerRoots: RemoteProviderRootsConfig;
  roots: Array<{ provider: string; path: string; configured: boolean; exists: boolean | null }>;
  dbPath: string;
  sessionCount: number;
  lastIndexed: string;
  lastAttempt: string;
  status: 'idle' | 'indexing' | 'ok' | 'unreachable' | 'error';
  statusText: string;
  error: string;
  progress: IndexProgressInfo | null;
  stalledSeconds: number;
  lastBuild: RemoteBuildSummaryInfo | null;
  /** False until the first successful build has written an index. */
  hasIndex: boolean;
  logPath: string;
}

export interface LocationSummary {
  id: LocationId;
  name: string;
  kind: 'local' | 'remote';
  sessionCount: number;
  status: string;
  statusText: string;
  error: string;
  progress?: IndexProgressInfo | null;
}
