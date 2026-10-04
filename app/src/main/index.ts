// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { app, BrowserWindow, ipcMain, dialog, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { writeHeartbeat } from './indexer.ts';
import { createIndexerService } from './indexer-service.ts';
import { createWorkerBuildIndex } from './indexer-worker-client.ts';
import {
  cleanCustomTitle,
  normalizeHiddenMode,
  notHiddenCondition,
  sessionRowsQuery,
  setSessionOverride,
} from './session-overrides.ts';
import { createIndexLog, isDebugLoggingEnabled } from './remote-index-log.ts';
import { createStallWatchdog, type IndexEvent, type IndexProgress } from './index-progress.ts';
import { formatElapsed } from '../shared/index-progress.mjs';
import { previewLocalMarkdownLink, resolveExistingLocalMarkdownFile } from './local-markdown-link.mjs';
import { acquireWriterLease, writerLockPathFor } from '../../../packages/core/src/writer-lease.ts';
import {
  coreSchemaNeedsMigration,
  migrateCoreSchemaColumns,
} from '../../../packages/core/src/schema-migrations.ts';
import { createBuiltinProviderRegistry } from '../../../packages/core/src/providers/builtins.ts';
import { createProviderRegistry } from '../../../packages/core/src/providers/registry.ts';
import {
  buildSourceCatalog,
  resolveProviderRoots,
  setPersistedSetting,
} from './provider-settings.ts';
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
  type RemoteSource,
} from './remote-sources.ts';
import type {
  SessionPatchCursor,
  SessionPatchSnapshot,
  SessionMetadata,
  SourceQueryOptions,
} from '../shared/ipc-types.ts';
import type {
  SessionDetailAssemblyInput,
  SessionMessageRow,
  SessionSubagentRow,
  SessionSummaryRow,
  SessionToolCallRow,
  SessionToolResultRow,
  SessionWorkflowRow,
} from '../shared/session-detail-types.ts';
import { createSessionPatch } from '../shared/session-patch.mjs';
import { assembleSessionDetail } from '../shared/session-detail-assembly.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function detectClaudeDir() {
  // macOS / Linux: ~/.claude
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.claude');
  }
  // Windows: Claude Code runs in WSL, data lives at \\wsl.localhost\<distro>\home\<user>\.claude
  const distros = ['Ubuntu', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Debian', 'openSUSE-Leap', 'kali-linux'];
  for (const distro of distros) {
    const homePath = path.join('\\\\wsl.localhost', distro, 'home');
    if (!fs.existsSync(homePath)) continue;
    try {
      const users = fs.readdirSync(homePath);
      for (const user of users) {
        const claudeDir = path.join(homePath, user, '.claude');
        if (fs.existsSync(claudeDir)) return claudeDir;
      }
    } catch {}
  }
  // Fallback: native Windows path (for future native Claude Code on Windows)
  return path.join(os.homedir(), '.claude');
}

const DEFAULT_CLAUDE_DIR = detectClaudeDir();
const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');

let db;
let indexerService;
let indexerWorker;

type WriterLeaseMode = 'acquire' | 'caller-held';

function acquireAppWriterLease(dbPath: string, waitMs = 0) {
  return acquireWriterLease({
    lockPath: writerLockPathFor(dbPath),
    openDb: lockPath => new Database(lockPath),
    waitMs,
  });
}

function getRuntimePaths(persisted = loadPersistedSettings()) {
  const defaultRegistry = createBuiltinProviderRegistry({
    claude: DEFAULT_CLAUDE_DIR,
    codex: DEFAULT_CODEX_DIR,
  });
  const providerRoots = resolveProviderRoots(defaultRegistry, persisted);
  const providerRegistry = createBuiltinProviderRegistry(providerRoots);
  const claudeDir = providerRoots['claude'] ?? DEFAULT_CLAUDE_DIR;
  const codexDir = providerRoots['codex'] ?? DEFAULT_CODEX_DIR;
  return {
    providerRoots,
    providerRegistry,
    claudeDir,
    codexDir,
    dbPath: path.join(TRAJEX_DIR, 'trajex.sqlite'),
    projectsDir: path.join(claudeDir, 'projects'),
  };
}

function rebuildTempDbPath(dbPath) {
  return path.join(
    path.dirname(dbPath),
    `${path.basename(dbPath)}.rebuild-${process.pid}-${Date.now()}.tmp`,
  );
}

function dbFileSet(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function cleanupDbFiles(dbPath) {
  for (const filePath of dbFileSet(dbPath)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

function replaceDbWithTemp(tempDbPath, dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.rmSync(sidecar, { force: true });
    } catch {}
  }
  fs.renameSync(tempDbPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const tempSidecar = `${tempDbPath}${suffix}`;
    if (!fs.existsSync(tempSidecar)) continue;
    fs.renameSync(tempSidecar, `${dbPath}${suffix}`);
  }
}

function resolveSchemaPath() {
  const candidates = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'schema.sql'),
    path.join(__dirname, '..', 'scripts', 'schema.sql'),
    process.resourcesPath ? path.join(process.resourcesPath, 'scripts', 'schema.sql') : null,
  ].filter((c): c is string => Boolean(c));
  return candidates.find(p => fs.existsSync(p));
}

function migrateDb(db) {
  if (typeof db.exec !== 'function' || typeof db.prepare !== 'function') return;
  migrateCoreSchemaColumns(db);
  const schemaPath = resolveSchemaPath();
  if (schemaPath) db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateCoreSchemaColumns(db);
}

function closeDb() {
  if (db) db.close();
  db = null;
}

/**
 * 旧 schema 被其他 writer 阻塞时不暴露真实连接；保留一个只会报告稳定诊断的
 * 哨兵，使所有既有 IPC 读取入口都在 prepare/exec 边界一致失败。
 */
function schemaBlockedDb(reason: string) {
  const blocked = () => {
    throw new Error(`Trajex index schema upgrade is blocked by ${reason}`);
  };
  return {
    close() {},
    exec: blocked,
    pragma: blocked,
    prepare: blocked,
  };
}

function openDb(
  dbPath = getRuntimePaths().dbPath,
  { writerLeaseMode = 'acquire' }: { writerLeaseMode?: WriterLeaseMode } = {},
) {
  closeDb();
  if (!fs.existsSync(dbPath)) return null;
  db = new Database(dbPath, { readonly: false });
  db.pragma('busy_timeout = 5000');
  const lease = writerLeaseMode === 'acquire' ? acquireAppWriterLease(dbPath) : null;
  if (writerLeaseMode === 'caller-held' || lease) {
    try {
      db.pragma('journal_mode = WAL');
      migrateDb(db);
    } finally {
      lease?.release();
    }
  } else if (coreSchemaNeedsMigration(db)) {
    db.close();
    db = schemaBlockedDb('writer_busy');
  }
  return db;
}

function runAppDbWrite(work: () => void): boolean {
  if (!db) return false;
  const lease = acquireAppWriterLease(getRuntimePaths().dbPath, 250);
  if (!lease) {
    throw new Error('Trajex index writer is busy; memory change was not applied');
  }
  try {
    work();
    return true;
  } finally {
    lease.release();
  }
}

function notifyIndexUpdated(
  result: { affectedSessionIds?: unknown } = {},
  location: string = LOCAL_LOCATION,
) {
  const affectedSessionIds = Array.isArray(result.affectedSessionIds)
    ? [...new Set(result.affectedSessionIds.filter(Boolean))]
    : [];
  const payload = { affectedSessionIds, location };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('trajex:index-updated', payload);
    for (const sessionId of affectedSessionIds) {
      win.webContents.send('trajex:session-updated', { sessionId, location });
    }
  }
}

function notifyRemotesUpdated() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('trajex:remotes-updated', {});
  }
}

function sourceWhereClause(opts: SourceQueryOptions = {}, column = "source"): { sql: string; params: unknown[] } {
  if (opts.source === 'all') return { sql: '', params: [] };
  if (opts.source) return { sql: `COALESCE(${column}, 'claude') = ?`, params: [opts.source] };
  return { sql: `COALESCE(${column}, 'claude') = 'claude'`, params: [] };
}

function appendWhere(sql, params, clause) {
  if (!clause) return sql;
  return `${sql}${sql.includes(' WHERE ') ? ' AND ' : ' WHERE '}${clause}`;
}

function startIndexerService({ buildOnStart = false } = {}) {
  if (indexerService) return indexerService;
  const paths = getRuntimePaths();
  const service = createIndexerService({
    projectsDir: paths.projectsDir,
    watchTargets: paths.providerRegistry.watchTargets(paths.providerRoots),
    buildIndex: async ({ reason, changedPaths, retrySessionIds }) => {
      const result = await indexerWorker.buildIndex({
        reason,
        changedPaths,
        retrySessionIds,
        providerRoots: paths.providerRoots,
        claudeDir: paths.claudeDir,
        codexDir: paths.codexDir,
        projectsDir: paths.projectsDir,
        dbPath: paths.dbPath,
      });
      if (result?.deferred) {
        if (Array.isArray(result.affectedSessionIds) && result.affectedSessionIds.length) {
          notifyIndexUpdated(result);
        }
      } else {
        openDb(paths.dbPath);
        notifyIndexUpdated(result);
      }
      return result;
    },
    writeHeartbeat: () => writeHeartbeat({ dbPath: paths.dbPath }),
  });
  service.start({ buildOnStart });
  indexerService = service;
  return service;
}

// --- Remote locations ---
//
// Each remote is an independent location with its own index DB
// (~/.trajex/remote-<id>.sqlite). Remote directories are only ever read; the
// index always lives locally. There is no file watching (network shares give no
// events): remotes are re-scanned incrementally every REMOTE_REFRESH_MS and on
// demand. Remote builds run in their own worker and use their own writer-lease
// file so a slow network scan can never block the local indexer.

const REMOTE_REFRESH_MS = 5 * 60 * 1000;

type RemoteRuntimeState = 'idle' | 'indexing' | 'ok' | 'unreachable' | 'error';
interface RemoteBuildSummary {
  finishedAt: string;
  durationMs: number;
  files: number;
  skipped: number;
  force: boolean;
}
interface RemoteRuntime {
  state: RemoteRuntimeState;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  error?: string;
  /** Live progress of the running build (cleared when it ends). */
  progress?: IndexProgress | null;
  /** Seconds without a progress message (set by the watchdog while building). */
  stalledSeconds?: number;
  lastBuild?: RemoteBuildSummary;
}

const REMOTE_STALL_MS = 60_000;
const REMOTE_WATCHDOG_TICK_MS = 5_000;
const MAX_LOGGED_SKIPS_PER_BUILD = 200;
// Debug logging is opt-in (Settings > Debug logging, or env TRAJEX_DEBUG=1). The flag is
// cached so a log call never re-reads settings.json; settings:set refreshes it live.
let debugLoggingOn = false;
function refreshDebugLogging(persisted: { debugLogging?: unknown } = loadPersistedSettings()) {
  debugLoggingOn = isDebugLoggingEnabled(persisted);
}
const remoteLog = createIndexLog({
  filePath: path.join(os.homedir(), '.trajex', 'remote-index.log'),
  enabled: () => debugLoggingOn,
});

const remoteDbs = new Map<string, any>();
const remoteRuntime = new Map<string, RemoteRuntime>();
let remoteWorker: ReturnType<typeof createWorkerBuildIndex> | null = null;
let remoteTimer: ReturnType<typeof setInterval> | null = null;
let remoteQueue: Promise<unknown> = Promise.resolve();
let remoteStopped = false;

/** Existence check that cannot hang the app on a dead network mount. */
function pathReachable(target: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    fs.promises.access(target).then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

function remoteRuntimeFor(id: string): RemoteRuntime {
  let runtime = remoteRuntime.get(id);
  if (!runtime) {
    runtime = { state: 'idle' };
    remoteRuntime.set(id, runtime);
  }
  return runtime;
}

function remoteDbFile(id: string) {
  return remoteDbPath(TRAJEX_DIR, id);
}

function closeRemoteDb(id: string) {
  const handle = remoteDbs.get(id);
  remoteDbs.delete(id);
  try { handle?.close(); } catch {}
}

function closeAllRemoteDbs() {
  for (const id of [...remoteDbs.keys()]) closeRemoteDb(id);
}

function openRemoteDb(id: string) {
  const existing = remoteDbs.get(id);
  if (existing) return existing;
  const dbPath = remoteDbFile(id);
  if (!fs.existsSync(dbPath)) return null;
  const handle = new Database(dbPath, { readonly: false });
  handle.pragma('busy_timeout = 5000');
  const lease = acquireWriterLease({
    lockPath: remoteWriterLeasePath(TRAJEX_DIR, id),
    openDb: lockPath => new Database(lockPath),
    waitMs: 0,
  });
  let opened = handle;
  if (lease) {
    try {
      handle.pragma('journal_mode = WAL');
      migrateDb(handle);
    } finally {
      lease.release();
    }
  } else if (coreSchemaNeedsMigration(handle)) {
    handle.close();
    opened = schemaBlockedDb('writer_busy') as any;
  }
  remoteDbs.set(id, opened);
  return opened;
}

/** Location id -> open index DB (local keeps the long-lived handle). */
function dbFor(location?: unknown) {
  const loc = normalizeLocationId(location);
  if (loc === null) return null;
  if (loc === LOCAL_LOCATION) return db ?? null;
  try {
    return openRemoteDb(loc);
  } catch (error) {
    console.warn?.(`Trajex remote DB open failed (${loc}): ${(error as Error).message}`);
    return null;
  }
}

function findRemote(id: string, persisted = loadPersistedSettings()): RemoteSource | null {
  return readRemotes(persisted).find((remote) => remote.id === id) ?? null;
}

/** Registry limited to the remote's configured roots (never falls back to local defaults). */
function registryForLocation(location?: unknown) {
  const loc = normalizeLocationId(location);
  if (loc === null || loc === LOCAL_LOCATION) return getRuntimePaths().providerRegistry;
  const remote = findRemote(loc);
  if (!remote) return createProviderRegistry([]);
  const { providerRoots, enabledProviders } = remoteBuildArgs(remote);
  return createProviderRegistry(
    createBuiltinProviderRegistry(providerRoots).list().filter(p => enabledProviders.includes(p.name)),
  );
}

function ensureRemoteWorker() {
  if (!remoteWorker) remoteWorker = createWorkerBuildIndex();
  return remoteWorker;
}

function enqueueRemote<T>(work: () => Promise<T>): Promise<T> {
  const next = remoteQueue.then(work, work);
  remoteQueue = next.catch(() => undefined);
  return next;
}

function removeRemoteDbFiles(id: string) {
  closeRemoteDb(id);
  cleanupDbFiles(remoteDbFile(id));
  cleanupDbFiles(remoteWriterLeasePath(TRAJEX_DIR, id));
}

function notifyRemoteProgress(id: string, progress: IndexProgress | null, stalledSeconds = 0) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('trajex:remote-index-progress', { id, progress, stalledSeconds });
  }
}

function logIndexEvent(id: string, event: IndexEvent, counters: { skips: number }) {
  const scope = `remote:${id}`;
  if (event.type === 'phase') {
    const total = event.total === undefined ? '' : ` files=${event.total}`;
    remoteLog.info(scope, `phase=${event.phase} at +${formatElapsed(event.elapsedMs)} (${event.elapsedMs}ms)${total}`);
  } else if (event.type === 'discovered') {
    remoteLog.info(scope, `discovered provider=${event.provider} units=${event.units} in ${event.ms}ms`);
  } else if (event.type === 'skipped') {
    counters.skips += 1;
    if (counters.skips <= MAX_LOGGED_SKIPS_PER_BUILD) {
      remoteLog.warn(scope, `skipped file provider=${event.provider} path=${event.path} error=${event.error}`);
    } else if (counters.skips === MAX_LOGGED_SKIPS_PER_BUILD + 1) {
      remoteLog.warn(scope, `further skipped files are not logged individually (limit ${MAX_LOGGED_SKIPS_PER_BUILD})`);
    }
  }
}

async function runRemoteBuild(id: string, { force = false, reason = 'remote-refresh' } = {}) {
  const remote = findRemote(id);
  if (!remote || remoteStopped) return null;
  const runtime = remoteRuntimeFor(id);
  const roots = configuredRemoteRoots(remote);
  const scope = `remote:${id}`;
  runtime.lastAttemptAt = new Date().toISOString();
  if (roots.length === 0) {
    runtime.state = 'idle';
    runtime.error = undefined;
    notifyRemotesUpdated();
    return null;
  }
  // Unreachable share: keep the old index untouched and just report it.
  const reachability = await Promise.all(roots.map(({ path: root }) => pathReachable(root)));
  if (!reachability.some(Boolean)) {
    runtime.state = 'unreachable';
    runtime.error = 'Remote directories are not reachable; keeping the previous index';
    remoteLog.warn(scope, `unreachable roots (${reason}): ${roots.map(({ provider, path: root }) => `${provider}=${root}`).join(', ')}`);
    notifyRemotesUpdated();
    return null;
  }
  const unreachableRoots = roots.filter((_, index) => !reachability[index]);
  const buildStartedAt = Date.now();
  runtime.state = 'indexing';
  runtime.error = undefined;
  runtime.stalledSeconds = 0;
  runtime.progress = {
    phase: 'discovering', done: 0, total: 0, provider: null, providerDone: 0, providerTotal: 0,
    currentFile: null, skipped: 0, startedAt: buildStartedAt, elapsedMs: 0, updatedAt: buildStartedAt,
  };
  remoteLog.info(scope, `build start name="${remote.name}" reason=${reason} force=${force} roots=${roots.map(({ provider, path: root }) => `${provider}=${root}`).join(', ')}`);
  for (const { provider, path: root } of unreachableRoots) {
    remoteLog.warn(scope, `root not reachable, will be skipped: ${provider}=${root}`);
  }
  notifyRemotesUpdated();
  notifyRemoteProgress(id, runtime.progress);

  const watchdog = createStallWatchdog({ thresholdMs: REMOTE_STALL_MS });
  const watchdogTimer = setInterval(() => {
    const silentMs = watchdog.check();
    if (silentMs === null) return;
    runtime.stalledSeconds = Math.round(silentMs / 1000);
    const at = runtime.progress;
    remoteLog.warn(scope, `no progress for ${runtime.stalledSeconds}s (phase=${at?.phase} done=${at?.done}/${at?.total} provider=${at?.provider} file=${at?.currentFile ?? '-'}); the share may be slow or disconnected`);
    notifyRemoteProgress(id, runtime.progress ?? null, runtime.stalledSeconds);
  }, REMOTE_WATCHDOG_TICK_MS);
  watchdogTimer.unref?.();
  const counters = { skips: 0 };
  let finishedResult: any = null;
  const observer = {
    onProgress: (progress: IndexProgress) => {
      watchdog.touch();
      runtime.stalledSeconds = 0;
      // The UI clock starts when the build was requested, not when the worker woke up.
      runtime.progress = { ...progress, startedAt: buildStartedAt };
      notifyRemoteProgress(id, runtime.progress);
    },
    onEvent: (event: IndexEvent) => {
      watchdog.touch();
      logIndexEvent(id, event, counters);
    },
  };

  const dbPath = remoteDbFile(id);
  const writerLeasePath = remoteWriterLeasePath(TRAJEX_DIR, id);
  const buildArgs = remoteBuildArgs(remote);
  const tempDbPath = force ? rebuildTempDbPath(dbPath) : null;
  try {
    const worker = ensureRemoteWorker();
    let result: any;
    if (force && tempDbPath) {
      cleanupDbFiles(tempDbPath);
      let lease: ReturnType<typeof acquireWriterLease> = null;
      try {
        lease = acquireWriterLease({ lockPath: writerLeasePath, openDb: p => new Database(p), waitMs: 2000 });
        if (!lease) throw new Error('Remote index writer is busy; rebuild was not started');
        result = await worker.buildIndex({
          reason,
          force: true,
          ...buildArgs,
          dbPath: tempDbPath,
          preserveDbPath: fs.existsSync(dbPath) ? dbPath : null,
          writerLeasePath,
          writerLeaseMode: 'caller-held',
        }, observer);
        if (!(result as any)?.deferred) {
          closeRemoteDb(id);
          replaceDbWithTemp(tempDbPath, dbPath);
          remoteLog.info(scope, `replaced index with rebuilt database (${tempDbPath} -> ${dbPath})`);
        }
      } finally {
        cleanupDbFiles(tempDbPath);
        lease?.release();
      }
    } else {
      result = await worker.buildIndex({ reason, ...buildArgs, dbPath, writerLeasePath }, observer);
    }
    closeRemoteDb(id);
    const durationMs = Date.now() - buildStartedAt;
    if (result?.deferred) {
      runtime.state = runtime.lastSuccessAt ? 'ok' : 'idle';
      runtime.error = `Index busy (${String(result.reason || 'deferred').replaceAll('_', ' ')}); will retry`;
      remoteLog.warn(scope, `build deferred reason=${result.reason} after ${formatElapsed(durationMs)}`);
    } else if (Array.isArray(result?.inventoryIssues) && result.inventoryIssues.length > 0) {
      runtime.state = 'unreachable';
      runtime.lastSuccessAt = new Date().toISOString();
      runtime.error = `Some remote directories could not be read (${result.inventoryIssues[0].path}); kept the previous index for them`;
      for (const issue of result.inventoryIssues) {
        remoteLog.warn(scope, `inventory issue provider=${issue.provider} path=${issue.path} error=${issue.error}`);
      }
    } else {
      runtime.state = 'ok';
      runtime.lastSuccessAt = new Date().toISOString();
      runtime.error = undefined;
    }
    if (!result?.deferred) {
      runtime.lastBuild = {
        finishedAt: new Date().toISOString(),
        durationMs,
        files: Number(result?.files) || 0,
        skipped: Number(result?.skipped) || 0,
        force,
      };
    }
    finishedResult = result ?? {};
    const info = readRemoteIndexInfo(id);
    remoteLog.info(scope, `build end state=${runtime.state} files=${result?.files ?? 0} skipped=${result?.skipped ?? 0} sessionsTouched=${result?.affectedSessionIds?.length ?? 0} sessions=${info.sessionCount} ftsRebuilt=${result?.ftsRebuilt ?? false} duration=${formatElapsed(durationMs)} (${durationMs}ms)`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - buildStartedAt;
    runtime.state = force ? 'error' : (runtime.lastSuccessAt ? 'unreachable' : 'error');
    runtime.error = (error as Error).message || String(error);
    remoteLog.error(scope, `build failed after ${formatElapsed(durationMs)} (${durationMs}ms)`, error);
    console.warn?.(`Trajex remote index failed (${id}): ${(error as Error).message}`);
    if (force) throw error;
    return null;
  } finally {
    clearInterval(watchdogTimer);
    // Whatever happened, never leave the remote on "Indexing…".
    if (runtime.state === 'indexing') {
      runtime.state = 'error';
      runtime.error = runtime.error || 'Indexing ended unexpectedly';
    }
    runtime.progress = null;
    runtime.stalledSeconds = 0;
    notifyRemoteProgress(id, null);
    notifyRemotesUpdated();
    if (finishedResult) notifyIndexUpdated(finishedResult, id);
  }
}

function refreshRemote(id: string, options: { force?: boolean; reason?: string } = {}) {
  return enqueueRemote(() => runRemoteBuild(id, options));
}

function refreshAllRemotes(reason: string) {
  for (const remote of readRemotes(loadPersistedSettings())) {
    void refreshRemote(remote.id, { reason }).catch(() => {});
  }
}

function startRemoteScheduler({ buildOnStart = true } = {}) {
  remoteStopped = false;
  if (remoteTimer) return;
  if (buildOnStart && loadPersistedSettings().autoRefresh !== false) refreshAllRemotes('remote-startup');
  remoteTimer = setInterval(() => {
    if (loadPersistedSettings().autoRefresh === false) return;
    refreshAllRemotes('remote-reconcile');
  }, REMOTE_REFRESH_MS);
  remoteTimer.unref?.();
}

async function stopRemoteResources() {
  remoteStopped = true;
  if (remoteTimer) clearInterval(remoteTimer);
  remoteTimer = null;
  const worker = remoteWorker;
  remoteWorker = null;
  if (worker) await Promise.resolve(worker.stop());
  closeAllRemoteDbs();
}

function readRemoteIndexInfo(id: string) {
  let sessionCount = 0;
  let lastIndexedAt = '';
  try {
    const handle = dbFor(id);
    if (handle) {
      sessionCount = handle.prepare(`SELECT COUNT(*) AS c FROM sessions s ${notHiddenSql(handle, 's', 'WHERE')}`).get()?.c || 0;
      const marker = handle.prepare("SELECT mtime FROM index_state WHERE jsonl_path = '__last_build__'").get();
      if (marker?.mtime) lastIndexedAt = new Date(Number(marker.mtime)).toISOString();
    }
  } catch {}
  return { sessionCount, lastIndexedAt };
}

async function summarizeRemote(remote: RemoteSource, { checkPaths = false } = {}) {
  const runtime = remoteRuntimeFor(remote.id);
  const info = readRemoteIndexInfo(remote.id);
  const roots = await Promise.all((['claude', 'codex', 'pi'] as const).map(async (provider) => {
    const root = remote.providerRoots[provider] ?? '';
    const exists = checkPaths && root ? await pathReachable(root) : null;
    return { provider, path: root, configured: Boolean(root), exists };
  }));
  const configured = roots.filter(root => root.configured);
  let status: string = runtime.state;
  if (configured.length === 0) status = 'idle';
  else if (checkPaths) {
    const reachable = configured.filter(root => root.exists).length;
    if (reachable === 0) status = 'unreachable';
    else if (status === 'unreachable' && reachable === configured.length && !runtime.error) status = 'ok';
  }
  return {
    id: remote.id,
    name: remote.name,
    providerRoots: remote.providerRoots,
    roots,
    dbPath: remoteDbFile(remote.id),
    sessionCount: info.sessionCount,
    lastIndexed: info.lastIndexedAt || runtime.lastSuccessAt || '',
    lastAttempt: runtime.lastAttemptAt || '',
    status,
    statusText: status === 'ok' ? 'Accessible'
      : status === 'indexing' ? 'Indexing…'
      : status === 'unreachable' ? 'Not found / unreachable'
      : status === 'error' ? 'Index error'
      : configured.length === 0 ? 'No directories configured' : 'Waiting for first scan',
    error: runtime.error || '',
    progress: runtime.progress ?? null,
    stalledSeconds: runtime.stalledSeconds || 0,
    lastBuild: runtime.lastBuild ?? null,
    hasIndex: info.lastIndexedAt !== '',
    logPath: debugLoggingOn ? remoteLog.filePath : '',
  };
}

function listLocations() {
  const localCount = (() => {
    try { return db?.prepare(`SELECT COUNT(*) AS c FROM sessions s ${notHiddenSql(db, 's', 'WHERE')}`).get()?.c || 0; } catch { return 0; }
  })();
  return [
    { id: LOCAL_LOCATION, name: 'Local', kind: 'local', sessionCount: localCount, status: 'ok', statusText: '', error: '' },
    ...readRemotes(loadPersistedSettings()).map((remote) => {
      const runtime = remoteRuntimeFor(remote.id);
      const info = readRemoteIndexInfo(remote.id);
      return {
        id: remote.id,
        name: remote.name,
        kind: 'remote',
        sessionCount: info.sessionCount,
        status: runtime.state,
        statusText: runtime.state === 'unreachable' ? 'unreachable' : runtime.state === 'indexing' ? 'indexing' : '',
        error: runtime.error || '',
        progress: runtime.progress ?? null,
      };
    }),
  ];
}


function startBackgroundResources({ runStartupBuild = false } = {}) {
  if (!indexerWorker) indexerWorker = createWorkerBuildIndex();
  const paths = getRuntimePaths();
  openDb(paths.dbPath);
  if (!indexerService) {
    const service = startIndexerService({ buildOnStart: false });
    if (runStartupBuild) service.runBuildNow('startup');
  }
  startRemoteScheduler({ buildOnStart: runStartupBuild });
}

async function stopIndexerServiceAndWait({ waitForIdle = true } = {}) {
  const service = indexerService;
  if (!service) return;
  await service.stop();
  if (waitForIdle && typeof service.idle === 'function') await service.idle();
  if (indexerService === service) indexerService = null;
}

let backgroundStopPromise: Promise<void> | null = null;

function stopBackgroundResources({ stopWorker = false } = {}) {
  if (backgroundStopPromise) return backgroundStopPromise;
  backgroundStopPromise = (async () => {
    await stopIndexerServiceAndWait();
    await stopRemoteResources();
    if (stopWorker && indexerWorker) {
      await Promise.resolve(indexerWorker.stop());
      indexerWorker = null;
    }
    closeDb();
  })().finally(() => {
    backgroundStopPromise = null;
  });
  return backgroundStopPromise;
}

function createWindow() {
  const isDev = process.argv.includes('--dev') || !!process.env.ELECTRON_RENDERER_URL;
  const shouldOpenDevTools = process.argv.includes('--devtools');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
    backgroundColor: '#0a0b14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev || shouldOpenDevTools,
    },
  });

  // Prevent Electron's built-in zoom so Cmd+=/- reaches the renderer
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && ['+', '=', '-', '0'].includes(input.key)) {
      win.webContents.setZoomLevel(0);
    }
  });

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL || process.env.TRAJEX_DEV_SERVER_URL || 'http://localhost:5173');
    if (shouldOpenDevTools) {
      win.webContents.openDevTools();
    }
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

const TRAJEX_DIR = path.join(os.homedir(), '.trajex');

app.whenReady().then(() => {
  refreshDebugLogging();
  startBackgroundResources({ runStartupBuild: true });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startBackgroundResources({ runStartupBuild: true });
      createWindow();
    }
  });
});

let isQuitting = false;

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void stopBackgroundResources({ stopWorker: true }).then(
    () => app.quit(),
    () => app.quit(),
  );
});

app.on('window-all-closed', () => {
  void stopBackgroundResources({ stopWorker: true }).catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

function querySessionMessages(sessionId: string, location?: unknown): SessionMessageRow[] {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.visibility, m.source
    FROM messages m WHERE m.session_id = ? AND m.agent_id IS NULL ORDER BY m.timestamp, m.uuid
  `).all(sessionId) as SessionMessageRow[];
}

function querySessionToolCalls(sessionId: string, location?: unknown): SessionToolCallRow[] {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`
    SELECT tc.* FROM messages m
    CROSS JOIN tool_calls tc ON tc.message_uuid = m.uuid
    WHERE m.session_id = ? AND m.agent_id IS NULL
      AND tc.session_id = ?
  `).all(sessionId, sessionId) as SessionToolCallRow[];
}

function querySessionToolResults(sessionId: string, location?: unknown): SessionToolResultRow[] {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`
    SELECT tr.* FROM messages m
    CROSS JOIN tool_results tr ON tr.message_uuid = m.uuid
    WHERE m.session_id = ? AND m.agent_id IS NULL
      AND tr.session_id = ?
  `).all(sessionId, sessionId) as SessionToolResultRow[];
}

function querySessionSubagents(sessionId: string, location?: unknown): SessionSubagentRow[] {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`SELECT * FROM subagents WHERE session_id = ?`).all(sessionId) as SessionSubagentRow[];
}

function querySessionWorkflows(sessionId: string, location?: unknown): SessionWorkflowRow[] {
  const d = dbFor(location);
  if (!d) return [];
  const workflows = d.prepare(`SELECT * FROM workflows WHERE session_id = ?`).all(sessionId) as SessionWorkflowRow[];
  for (const workflow of workflows) {
    workflow.agents = d.prepare(`SELECT * FROM workflow_agents WHERE run_id = ?`).all(workflow.run_id) as SessionWorkflowRow['agents'];
  }
  return workflows;
}

function querySessionSummaries(sessionId: string, location?: unknown): SessionSummaryRow[] {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`SELECT * FROM summaries WHERE session_id = ? AND agent_id IS NULL AND visibility = 'visible'`).all(sessionId) as SessionSummaryRow[];
}

function querySessionSnapshot(sessionId: string, location?: unknown): SessionDetailAssemblyInput {
  return {
    messages: querySessionMessages(sessionId, location),
    toolCalls: querySessionToolCalls(sessionId, location),
    toolResults: querySessionToolResults(sessionId, location),
    subagents: querySessionSubagents(sessionId, location),
    workflows: querySessionWorkflows(sessionId, location),
    summaries: querySessionSummaries(sessionId, location),
  };
}

function querySessionDisplaySnapshot(sessionId: string, location?: unknown): SessionPatchSnapshot {
  const snapshot = querySessionSnapshot(sessionId, location);
  const detail = assembleSessionDetail(snapshot);
  return {
    messages: detail.messages,
    workflows: detail.workflows,
    summaries: detail.summaries,
  };
}

const SESSION_METADATA_COLUMN_LIST = [
  'id',
  'title',
  'project',
  'project_path',
  'started_at',
  'ended_at',
  'git_branch',
  'version',
  'message_count',
  'jsonl_path',
  'source',
];
const SESSION_METADATA_COLUMNS = SESSION_METADATA_COLUMN_LIST.join(', ');

/** ' WHERE <not hidden>' / ' AND <not hidden>' / '' (hidden sessions are excluded from counts). */
function notHiddenSql(d: any, alias: string, keyword: 'WHERE' | 'AND'): string {
  const condition = notHiddenCondition(d, alias);
  return condition ? `${keyword} ${condition}` : '';
}

function querySessionMetadata(sessionId: string, location?: unknown): SessionMetadata | null {
  const d = dbFor(location);
  if (!d) return null;
  // Detail pages also open hidden sessions (from the Hidden view), so no hidden filter here.
  const query = sessionRowsQuery(d, SESSION_METADATA_COLUMN_LIST, 'all');
  return (
    d.prepare(`${query.select} WHERE s.id = ?`).get(sessionId) as SessionMetadata | undefined
  ) || null;
}

ipcMain.handle('db:getSessions', (_, opts = {}) => {
  const d = dbFor(opts.location);
  if (!d) return [];
  const { project, limit = 200 } = opts;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('limit must be a non-negative integer');
  }
  // Titles come with the user's custom title applied; hidden sessions are excluded unless
  // the caller asks for `hidden: 'only' | 'all'` (Hidden view).
  const rows = sessionRowsQuery(d, SESSION_METADATA_COLUMN_LIST, normalizeHiddenMode(opts.hidden));
  let sql = rows.select;
  for (const condition of rows.conditions) sql = appendWhere(sql, [], condition);
  const params: unknown[] = [];
  const sourceFilter = sourceWhereClause(opts);
  if (sourceFilter.sql) {
    sql = appendWhere(sql, params, sourceFilter.sql);
    params.push(...sourceFilter.params);
  }
  if (project) { sql = appendWhere(sql, params, `project LIKE ?`); params.push(project); }
  sql += ` ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?`;
  params.push(limit);
  return d.prepare(sql).all(...params);
});

ipcMain.handle('db:getSessionMessages', (_, sessionId, location) => {
  return querySessionMessages(sessionId, location);
});

ipcMain.handle('db:getSessionToolCalls', (_, sessionId, location) => {
  return querySessionToolCalls(sessionId, location);
});

ipcMain.handle('db:getSessionToolResults', (_, sessionId, location) => {
  return querySessionToolResults(sessionId, location);
});

ipcMain.handle('db:getSessionSubagents', (_, sessionId, location) => {
  return querySessionSubagents(sessionId, location);
});

ipcMain.handle('db:getSessionWorkflows', (_, sessionId, location) => {
  return querySessionWorkflows(sessionId, location);
});

ipcMain.handle('db:getSessionPatch', (
  _event: IpcMainInvokeEvent,
  sessionId: string,
  cursor: SessionPatchCursor,
  location?: unknown,
) => {
  if (!dbFor(location)) return null;
  return {
    ...createSessionPatch(querySessionDisplaySnapshot(sessionId, location), cursor),
    session: querySessionMetadata(sessionId, location),
  };
});

ipcMain.handle('db:getSubagentMessages', (_, agentId, location) => {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`
    SELECT m.uuid, m.session_id, m.type, m.parent_uuid, m.timestamp, m.role, m.text, m.model,
           m.agent_id, m.input_tokens, m.output_tokens, m.cwd, m.skill, m.turn_duration_ms,
           m.content_type, m.is_meta, m.visibility, m.source
    FROM messages m WHERE m.agent_id = ? ORDER BY m.timestamp, m.uuid
  `).all(agentId);
});

ipcMain.handle('db:getSubagentToolCalls', (_, agentId, location) => {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`
    SELECT tc.* FROM tool_calls tc
    JOIN messages m ON m.uuid = tc.message_uuid
    WHERE m.agent_id = ?
  `).all(agentId);
});

ipcMain.handle('db:getSubagentToolResults', (_, agentId, location) => {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`
    SELECT tr.* FROM tool_results tr
    JOIN messages m ON m.uuid = tr.message_uuid
    WHERE m.agent_id = ?
  `).all(agentId);
});

ipcMain.handle('db:getSubagentSummaries', (_, agentId, location) => {
  const d = dbFor(location);
  if (!d) return [];
  return d.prepare(`SELECT * FROM summaries WHERE agent_id = ? AND visibility = 'visible' ORDER BY timestamp, id`).all(agentId);
});

ipcMain.handle('db:getSessionSummaries', (_, sessionId, location) => {
  return querySessionSummaries(sessionId, location);
});

ipcMain.handle('db:getMemories', () => {
  if (!db) return [];
  return db.prepare(`
    SELECT id, session_id, project, message_start, message_end, path, summary, created_at, deleted_at, deleted_reason
    FROM memories ORDER BY created_at DESC
  `).all();
});

ipcMain.handle('db:getMessageFullText', (_, uuid, location) => {
  const d = dbFor(location);
  if (!d) return null;
  const msg = d.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
  if (!msg) return null;
  const session = d.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id) ?? null;
  const subagent = msg.agent_id
    ? d.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) ?? null
    : null;
  const workflowAgent = msg.agent_id
    ? d.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id) ?? null
    : null;
  const raw = registryForLocation(location).raw({
    source: msg.source || session?.source || 'claude',
    messageUuid: String(uuid),
    session,
    agentId: msg.agent_id || null,
    subagent,
    workflowAgent,
  });
  return raw?.messageText ?? msg.text ?? null;
});

ipcMain.handle('db:readMemoryFile', (_, filePath) => {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    return null;
  } catch { return null; }
});

ipcMain.handle('local-link:preview', (_, href) => previewLocalMarkdownLink(href));

ipcMain.handle('local-link:open', async (event, href) => {
  const filePath = resolveExistingLocalMarkdownFile(href);
  if (!filePath) return { exists: false };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { exists: true, opened: false };
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Cancel', 'Open'],
    defaultId: 0,
    cancelId: 0,
    message: '是否用默认应用打开此文件？',
    detail: filePath,
  });
  if (response !== 1) return { exists: true, opened: false };
  const error = await shell.openPath(filePath);
  return { exists: true, opened: !error, error: error || undefined };
});

ipcMain.handle('web-link:open', async (_, href) => {
  if (typeof href !== 'string') return false;
  try {
    const url = new URL(href);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    await shell.openExternal(url.href);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('db:archiveMemory', (_, id, reason) => {
  return runAppDbWrite(() => {
    db.prepare(`UPDATE memories SET deleted_at = ?, deleted_reason = ? WHERE id = ?`)
      .run(new Date().toISOString(), reason || 'Archived via panel', id);
  });
});

ipcMain.handle('db:restoreMemory', (_, id) => {
  return runAppDbWrite(() => {
    db.prepare(`UPDATE memories SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?`).run(id);
  });
});

ipcMain.handle('db:getProjects', (_, opts = {}) => {
  const d = dbFor(opts.location);
  if (!d) return [];
  const sourceFilter = sourceWhereClause(opts);
  const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
  return d.prepare(`
    SELECT project, project_path, COUNT(*) as session_count,
           MAX(COALESCE(ended_at, started_at)) as last_active
    FROM sessions s ${where ? `${where} AND` : 'WHERE'} project IS NOT NULL ${notHiddenSql(d, 's', 'AND')}
    GROUP BY project ORDER BY last_active DESC
  `).all(...sourceFilter.params);
});

ipcMain.handle('db:getStats', (_, opts = {}) => {
  const d = dbFor(opts.location);
  if (!d) return { sessions: 0, memories: 0, memoriesArchived: 0 };
  const sourceFilter = sourceWhereClause(opts);
  const where = sourceFilter.sql ? `WHERE ${sourceFilter.sql}` : '';
  const sessions = d.prepare(`SELECT COUNT(*) as c FROM sessions s ${where} ${notHiddenSql(d, 's', where ? 'AND' : 'WHERE')}`).get(...sourceFilter.params)?.c || 0;
  const memories = d.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
  const memoriesArchived = d.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NOT NULL').get()?.c || 0;
  return { sessions, memories, memoriesArchived };
});

ipcMain.handle('db:getUsageStats', (_, opts = {}) => {
  const d = dbFor(opts.location);
  if (!d) return { daily: [], totalTokens: 0, peakDay: null, longestTurn: null };
  const messageFilter = sourceWhereClause(opts, 'm.source');
  const summaryFilter = sourceWhereClause(opts, 's.source');

  const usageDays = d.prepare(`
    WITH usage_events AS (
      SELECT m.timestamp, m.input_tokens, m.output_tokens
      FROM messages m
      WHERE (m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL)
        ${messageFilter.sql ? `AND ${messageFilter.sql}` : ''}
      UNION ALL
      SELECT su.timestamp, su.input_tokens, su.output_tokens
      FROM summaries su
      LEFT JOIN sessions s ON s.id = su.session_id
      WHERE (su.input_tokens IS NOT NULL OR su.output_tokens IS NOT NULL)
        ${summaryFilter.sql ? `AND ${summaryFilter.sql}` : ''}
    )
    SELECT DATE(timestamp) AS day,
           SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens
    FROM usage_events
    GROUP BY DATE(timestamp)
    ORDER BY day
  `).all(...messageFilter.params, ...summaryFilter.params) as Array<{ day: string | null; tokens: number }>;
  const totalTokens = usageDays.reduce((total, row) => total + row.tokens, 0);
  const daily = usageDays.filter((row): row is { day: string; tokens: number } => row.day !== null);
  const peakDay = daily.reduce<{ day: string; tokens: number } | null>(
    (peak, row) => peak === null || row.tokens > peak.tokens ? row : peak,
    null,
  );

  const longestTurn = d.prepare(`
    SELECT turn_duration_ms, uuid, session_id, timestamp
    FROM messages m
    WHERE m.turn_duration_ms IS NOT NULL
      ${messageFilter.sql ? `AND ${messageFilter.sql}` : ''}
    ORDER BY turn_duration_ms DESC
    LIMIT 1
  `).get(...messageFilter.params) || null;

  return { daily, totalTokens, peakDay, longestTurn };
});

// --- Capture ---

// --- Settings ---

const SETTINGS_PATH = path.join(TRAJEX_DIR, 'settings.json');

function loadPersistedSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {}
  return {};
}

function savePersistedSettings(settings) {
  if (!fs.existsSync(TRAJEX_DIR)) fs.mkdirSync(TRAJEX_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

ipcMain.handle('settings:get', async () => {
  const persisted = loadPersistedSettings();
  const paths = getRuntimePaths(persisted);
  const { providerRoots, providerRegistry, claudeDir, codexDir, dbPath: dbFile } = paths;
  let memoryCount = 0;
  const sourceStats = new Map<string, { sessionCount: number; lastIndexed: string }>();

  if (db) {
    try {
      const rows = db.prepare(`
        SELECT COALESCE(source, 'claude') AS source,
               COUNT(*) AS session_count,
               MAX(started_at) AS last_indexed
        FROM sessions s ${notHiddenSql(db, 's', 'WHERE')}
        GROUP BY COALESCE(source, 'claude')
      `).all();
      for (const row of rows) {
        sourceStats.set(row.source, {
          sessionCount: row.session_count || 0,
          lastIndexed: row.last_indexed || '',
        });
      }
      memoryCount = db.prepare('SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL').get()?.c || 0;
    } catch {}
  }
  const sources = buildSourceCatalog({
    registry: providerRegistry,
    roots: providerRoots,
    stats: sourceStats,
    pathExists: fs.existsSync,
  });
  const sessionCount = sources.reduce((sum, source) => sum + source.sessionCount, 0);
  const lastIndexed = sources.map((source) => source.lastIndexed).filter(Boolean).sort().at(-1) || '';
  const connected = sources.some((source) => source.status !== 'error');
  const remotes = await Promise.all(readRemotes(persisted).map((remote) => summarizeRemote(remote, { checkPaths: true })));

  return {
    remotes,
    version: app.getVersion(),
    providerRoots,
    claudeDir,
    codexDir,
    dbPath: dbFile,
    autoRefresh: persisted.autoRefresh !== false,
    showUntitledSessions: persisted.showUntitledSessions === true,
    debugLogging: persisted.debugLogging === true,
    debugLoggingForced: isDebugLoggingEnabled({}),
    debugLogPath: remoteLog.filePath,
    sources,
    memoryCount,
    sessionCount,
    lastIndexed,
    status: connected ? 'ok' : 'error',
    statusText: connected ? 'Connected' : 'No source folders found',
  };
});

ipcMain.handle('settings:set', async (_, key, value) => {
  // Remotes are managed only through the remotes:* handlers (ids, DB files).
  if (typeof key === 'string' && (key === 'remotes' || key.startsWith('remotes.'))) return false;
  const persisted = loadPersistedSettings();
  const providerRootChanged = setPersistedSetting(persisted, key, value);
  savePersistedSettings(persisted);
  if (key === 'debugLogging') refreshDebugLogging(persisted);

  if (key === 'autoRefresh') {
    await stopIndexerServiceAndWait();
    if (loadPersistedSettings().autoRefresh !== false) {
      startIndexerService({ buildOnStart: true });
    }
  }

  const knownLegacyRootChanged = createBuiltinProviderRegistry({
    claude: DEFAULT_CLAUDE_DIR,
    codex: DEFAULT_CODEX_DIR,
  }).catalog().some((provider) => key === `${provider.id}Dir`);
  if (providerRootChanged || knownLegacyRootChanged) {
    await stopIndexerServiceAndWait();
    const paths = getRuntimePaths(persisted);
    openDb(paths.dbPath);
    if (persisted.autoRefresh !== false) {
      startIndexerService({ buildOnStart: true });
    }
    notifyIndexUpdated();
  }
  return true;
});

// --- Session overrides (rename / hide) ---
//
// Stored only in the index DB of the addressed location (local or a remote's local
// ~/.trajex/remote-<id>.sqlite). Transcript files and remote shares are never written.

function applySessionOverride(
  sessionId: unknown,
  location: unknown,
  patch: { title?: unknown; hidden?: boolean },
) {
  const loc = normalizeLocationId(location);
  if (loc === null) throw new Error('Unknown location');
  const d = dbFor(loc);
  if (!d) throw new Error('Index database for this location is not available yet');
  const result = setSessionOverride(d, String(sessionId ?? ''), patch);
  // Counts / lists in every open window refresh through the usual channels.
  notifyIndexUpdated({ affectedSessionIds: [] }, loc);
  notifyRemotesUpdated();
  return result;
}

ipcMain.handle('sessions:rename', (_, sessionId, title, location) => (
  applySessionOverride(sessionId, location, { title: cleanCustomTitle(title) })
));

ipcMain.handle('sessions:setHidden', (_, sessionId, hidden, location) => (
  applySessionOverride(sessionId, location, { hidden: hidden === true })
));

// --- Remote location IPC ---

ipcMain.handle('locations:list', () => listLocations());

ipcMain.handle('remotes:add', async (_, input = {}) => {
  const persisted = loadPersistedSettings();
  const remote = addRemote(persisted, input);
  savePersistedSettings(persisted);
  notifyRemotesUpdated();
  void refreshRemote(remote.id, { reason: 'remote-added' }).catch(() => {});
  return remote;
});

ipcMain.handle('remotes:update', async (_, id, patch = {}) => {
  if (!isRemoteId(id)) return null;
  const persisted = loadPersistedSettings();
  const updated = updateRemote(persisted, id, patch);
  if (!updated) return null;
  savePersistedSettings(persisted);
  notifyRemotesUpdated();
  // Changed directories invalidate what was indexed: rebuild into a temp DB and
  // swap only on success (an unreachable share leaves the old index in place).
  if (updated.rootsChanged) void refreshRemote(id, { force: true, reason: 'remote-roots-changed' }).catch(() => {});
  return updated.remote;
});

ipcMain.handle('remotes:remove', async (_, id) => {
  if (!isRemoteId(id)) return false;
  const persisted = loadPersistedSettings();
  if (!removeRemote(persisted, id)) return false;
  savePersistedSettings(persisted);
  remoteRuntime.delete(id);
  await enqueueRemote(async () => removeRemoteDbFiles(id));
  notifyRemotesUpdated();
  notifyIndexUpdated({}, id);
  return true;
});

ipcMain.handle('remotes:refresh', async (_, id) => {
  if (!isRemoteId(id) || !findRemote(id)) return null;
  const result = await refreshRemote(id, { reason: 'remote-manual-refresh' });
  return result ? { files: result.files ?? 0, deferred: Boolean(result.deferred) } : null;
});

ipcMain.handle('remotes:rebuild', async (_, id) => {
  if (!isRemoteId(id) || !findRemote(id)) return null;
  const result = await refreshRemote(id, { force: true, reason: 'remote-manual-rebuild' });
  return result ? { files: result.files ?? 0, deferred: Boolean(result.deferred) } : null;
});

/** "Pick remote home directory": choose <home>, auto-fill the roots that exist. */
ipcMain.handle('remotes:pickHome', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select the remote home directory (contains .claude / .codex / .pi)',
  });
  const home = filePaths?.[0];
  if (!home) return null;
  const exists = new Map<string, boolean>();
  const candidates = [
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.pi', 'agent', 'sessions'),
  ];
  await Promise.all(candidates.map(async (c) => exists.set(c, await pathReachable(c))));
  return { home, providerRoots: detectRemoteHomeRoots(home, (c) => exists.get(c) === true) };
});

ipcMain.handle('settings:browseFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const { filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Select session data folder',
  });
  if (filePaths && filePaths[0]) return filePaths[0];
  return null;
});

ipcMain.handle('settings:revealPath', (_, p) => {
  if (fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle('settings:rebuildIndex', async () => {
  if (!indexerWorker) return null;
  const persisted = loadPersistedSettings();
  const paths = getRuntimePaths(persisted);
  const tempDbPath = rebuildTempDbPath(paths.dbPath);
  await stopIndexerServiceAndWait({ waitForIdle: false });
  if (indexerWorker) {
    await Promise.resolve(indexerWorker.stop());
    indexerWorker = createWorkerBuildIndex();
  }
  cleanupDbFiles(tempDbPath);
  let writerLease: ReturnType<typeof acquireWriterLease> = null;
  let rebuildWatchHints: string[] = [];
  try {
    const writerLeasePath = writerLockPathFor(paths.dbPath);
    writerLease = acquireWriterLease({
      lockPath: writerLeasePath,
      openDb: lockPath => new Database(lockPath),
      waitMs: 2000,
    });
    if (!writerLease) {
      throw new Error('Trajex index writer is busy; rebuild was not started');
    }
    const result = await indexerWorker.buildIndex({
      reason: 'manual-rebuild',
      force: true,
      providerRoots: paths.providerRoots,
      claudeDir: paths.claudeDir,
      codexDir: paths.codexDir,
      projectsDir: paths.projectsDir,
      dbPath: tempDbPath,
      preserveDbPath: fs.existsSync(paths.dbPath) ? paths.dbPath : null,
      writerLeasePath,
      writerLeaseMode: 'caller-held',
    });
    if (result?.deferred) {
      throw new Error(`Trajex rebuild was not completed: ${String(result.reason || 'indexing deferred').replaceAll('_', ' ')}`);
    }
    rebuildWatchHints = result?.watchHints ?? [];
    closeDb();
    replaceDbWithTemp(tempDbPath, paths.dbPath);
    openDb(paths.dbPath, { writerLeaseMode: 'caller-held' });
    notifyIndexUpdated(result);
    return result;
  } finally {
    try {
      cleanupDbFiles(tempDbPath);
      if (!db) {
        try {
          openDb(paths.dbPath, {
            writerLeaseMode: writerLease ? 'caller-held' : 'acquire',
          });
        } catch (error) {
          console.warn?.(`Trajex DB reopen after rebuild failed: ${(error as Error).message}`);
        }
      }
    } finally {
      writerLease?.release();
      if (loadPersistedSettings().autoRefresh !== false) {
        const service = startIndexerService({ buildOnStart: false });
        if (rebuildWatchHints.length) service?.promoteWatchHints?.(rebuildWatchHints);
        else service?.runBuildNow?.('reconcile');
      }
    }
  }
});
