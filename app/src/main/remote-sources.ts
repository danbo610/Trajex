// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remote source settings: pure helpers (no electron, no fs writes) for the
 * `remotes` list persisted in ~/.trajex/settings.json.
 *
 * A remote is another machine's agent history that is reachable as a mounted
 * directory (SMB / NFS / sshfs ...). Every remote gets its own index database,
 * `remote-<id>.sqlite`, that always lives locally; the remote directories are
 * only ever read.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOCAL_LOCATION = 'local';
export const REMOTE_PROVIDER_IDS = ['claude', 'codex', 'pi'] as const;
export type RemoteProviderId = typeof REMOTE_PROVIDER_IDS[number];
export type RemoteProviderRoots = Partial<Record<RemoteProviderId, string>>;

export interface RemoteSource {
  id: string;
  name: string;
  providerRoots: RemoteProviderRoots;
}

type PersistedSettings = Record<string, unknown> & { remotes?: unknown };

const REMOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NAME_LENGTH = 60;

/** Remote ids end up in file names, so only a conservative charset is allowed. */
export function isRemoteId(value: unknown): value is string {
  return typeof value === 'string' && value !== LOCAL_LOCATION && REMOTE_ID_RE.test(value);
}

/** Maps a renderer-supplied location to 'local' | remote id | null (invalid). */
export function normalizeLocationId(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === LOCAL_LOCATION) return LOCAL_LOCATION;
  return isRemoteId(value) ? value : null;
}

export function remoteDbPath(trajexDir: string, id: string): string {
  return path.join(trajexDir, `remote-${id}.sqlite`);
}

/**
 * The core writer lease defaults to one lock file per directory. Remote
 * indexes share ~/.trajex with the local one, so each remote needs its own
 * lease file or a slow network build would block local indexing.
 */
export function remoteWriterLeasePath(trajexDir: string, id: string): string {
  return path.join(trajexDir, `remote-${id}.writer.lock.sqlite`);
}

export function generateRemoteId(
  existing: ReadonlySet<string> = new Set(),
  random: () => string = () => randomBytes(4).toString('hex'),
): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = random();
    if (isRemoteId(id) && !existing.has(id)) return id;
  }
  throw new Error('Unable to generate a unique remote id');
}

export function cleanRemoteRoots(value: unknown): RemoteProviderRoots {
  const roots: RemoteProviderRoots = {};
  if (!value || typeof value !== 'object') return roots;
  for (const provider of REMOTE_PROVIDER_IDS) {
    const raw = (value as Record<string, unknown>)[provider];
    if (typeof raw === 'string' && raw.trim().length > 0) roots[provider] = raw.trim();
  }
  return roots;
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LENGTH) : '';
  return name || fallback;
}

/** Valid, de-duplicated remotes from persisted settings (bad entries dropped). */
export function readRemotes(persisted: PersistedSettings = {}): RemoteSource[] {
  if (!Array.isArray(persisted.remotes)) return [];
  const seen = new Set<string>();
  const remotes: RemoteSource[] = [];
  for (const entry of persisted.remotes) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, providerRoots } = entry as Record<string, unknown>;
    if (!isRemoteId(id) || seen.has(id)) continue;
    seen.add(id);
    remotes.push({ id, name: cleanName(name, `Remote ${remotes.length + 1}`), providerRoots: cleanRemoteRoots(providerRoots) });
  }
  return remotes;
}

function writeRemotes(persisted: PersistedSettings, remotes: RemoteSource[]): void {
  if (remotes.length === 0) delete persisted.remotes;
  else persisted.remotes = remotes;
}

export function addRemote(
  persisted: PersistedSettings,
  input: { name?: unknown; providerRoots?: unknown } = {},
  random?: () => string,
): RemoteSource {
  const remotes = readRemotes(persisted);
  const remote: RemoteSource = {
    id: generateRemoteId(new Set(remotes.map((item) => item.id)), random),
    name: cleanName(input.name, `Remote ${remotes.length + 1}`),
    providerRoots: cleanRemoteRoots(input.providerRoots),
  };
  writeRemotes(persisted, [...remotes, remote]);
  return remote;
}

function sameRoots(a: RemoteProviderRoots, b: RemoteProviderRoots): boolean {
  return REMOTE_PROVIDER_IDS.every((provider) => (a[provider] ?? '') === (b[provider] ?? ''));
}

/** Patch name and/or roots. `rootsChanged` tells the caller the index is stale. */
export function updateRemote(
  persisted: PersistedSettings,
  id: string,
  patch: { name?: unknown; providerRoots?: unknown } = {},
): { remote: RemoteSource; rootsChanged: boolean } | null {
  const remotes = readRemotes(persisted);
  const index = remotes.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const current = remotes[index]!;
  const next: RemoteSource = {
    id: current.id,
    name: patch.name === undefined ? current.name : cleanName(patch.name, current.name),
    providerRoots: patch.providerRoots === undefined ? current.providerRoots : cleanRemoteRoots(patch.providerRoots),
  };
  remotes[index] = next;
  writeRemotes(persisted, remotes);
  return { remote: next, rootsChanged: !sameRoots(current.providerRoots, next.providerRoots) };
}

export function removeRemote(persisted: PersistedSettings, id: string): RemoteSource | null {
  const remotes = readRemotes(persisted);
  const removed = remotes.find((item) => item.id === id) ?? null;
  if (!removed) return null;
  writeRemotes(persisted, remotes.filter((item) => item.id !== id));
  return removed;
}

/** Only the directories the user actually configured; blank = not configured. */
export function configuredRemoteRoots(remote: RemoteSource): Array<{ provider: RemoteProviderId; path: string }> {
  return REMOTE_PROVIDER_IDS.flatMap((provider) => {
    const root = remote.providerRoots[provider];
    return root ? [{ provider, path: root }] : [];
  });
}

/**
 * Arguments for buildIndex(). `enabledProviders` matters: an unconfigured
 * provider must NOT fall back to its default (local!) root.
 */
export function remoteBuildArgs(remote: RemoteSource) {
  const roots = configuredRemoteRoots(remote);
  const providerRoots = Object.fromEntries(roots.map(({ provider, path: root }) => [provider, root]));
  return {
    providerRoots,
    enabledProviders: roots.map(({ provider }) => provider as string),
    ...(remote.providerRoots.claude ? {
      claudeDir: remote.providerRoots.claude,
      projectsDir: path.join(remote.providerRoots.claude, 'projects'),
    } : {}),
    ...(remote.providerRoots.codex ? { codexDir: remote.providerRoots.codex } : {}),
  };
}

/** "Pick remote home directory" shortcut: <home>/.claude, .codex, .pi/agent/sessions if present. */
export function detectRemoteHomeRoots(
  home: string,
  exists: (candidate: string) => boolean,
): RemoteProviderRoots {
  const candidates: Record<RemoteProviderId, string> = {
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    pi: path.join(home, '.pi', 'agent', 'sessions'),
  };
  const roots: RemoteProviderRoots = {};
  for (const provider of REMOTE_PROVIDER_IDS) {
    if (exists(candidates[provider])) roots[provider] = candidates[provider];
  }
  return roots;
}
