// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Data loading layer -- bridges Electron IPC (window.trajex.*) to reactive store.
// All DB access goes through this module.

import { markRaw } from 'vue';
import { state } from './store.js';
import { liveSessionKey } from './session-live.mjs';
import {
  applySessionPatch,
  createSessionPatchCursor,
} from '../../shared/session-patch.mjs';
import { assembleSessionDetail } from '../../shared/session-detail-assembly.mjs';

const sessionMessageSnapshots = new Map();
const MAX_SESSION_MESSAGE_SNAPSHOTS = 3;

function snapshotKey(sessionId, location = 'local') {
  return liveSessionKey(location, sessionId);
}

function rememberSessionMessageSnapshot(key, entry) {
  sessionMessageSnapshots.delete(key);
  sessionMessageSnapshots.set(key, entry);
  while (sessionMessageSnapshots.size > MAX_SESSION_MESSAGE_SNAPSHOTS) {
    sessionMessageSnapshots.delete(sessionMessageSnapshots.keys().next().value);
  }
}

function sessionMetadata(session) {
  if (!session) return null;
  const metadata = { ...session };
  delete metadata.messages;
  delete metadata.workflow;
  delete metadata.summaries;
  return markRaw(metadata);
}

function commitStoredSessionMetadata(sessionId, metadata) {
  const session = state.sessions.find(candidate => candidate.id === sessionId);
  if (session?.messages?.length) session.messages = markRaw([]);
  const visibleTitle = state.sessionTitleOverrides.get(sessionId) ?? session?.title;
  if (metadata?.title !== undefined && metadata.title !== visibleTitle) {
    state.sessionTitleOverrides.set(sessionId, metadata.title);
  }
}

/**
 * Fetch the global catalogue without mutating renderer state. Navigation can
 * then gate a reply that started before SessionDetail became active.
 */
export async function fetchInitialData() {
  const location = state.location;
  const remote = location !== 'local';
  const [rawMemories, rawSessions, stats, projects] = await Promise.all([
    window.trajex.getMemories(),
    window.trajex.getSessions({ source: 'all', limit: 1000, location }),
    window.trajex.getStats({ location, ...(remote ? { source: 'all' } : {}) }),
    window.trajex.getProjects({ location, ...(remote ? { source: 'all' } : {}) })
  ]);
  return { rawMemories, rawSessions, stats, projects, location };
}

/** Sidebar location list (Local + configured remotes with index status). */
export async function loadLocations() {
  if (!window.trajex?.getLocations) return;
  try {
    const locations = await window.trajex.getLocations();
    if (Array.isArray(locations) && locations.length) state.locations = locations;
  } catch (error) {
    console.error('Failed to load locations:', error);
  }
}

/** Commit a fetched global catalogue snapshot to shared renderer state. */
export function commitInitialData({ rawMemories, rawSessions, stats, projects, location = 'local' }) {
  // Transform memories: DB records -> render-layer shape
  state.memories = (rawMemories || []).map(m => ({
    ...m,
    ts: m.created_at ? new Date(m.created_at).getTime() : 0,
    archived: !!m.deleted_at,
    archivedAt: m.deleted_at ? new Date(m.deleted_at).getTime() : null,
    markdown: null  // loaded on demand via loadMemoryMarkdown
  }));

  // A reply for a location the user already left must not overwrite the current one.
  if (location !== state.location) return;

  // The catalogue now owns the latest metadata; route overlays can retire.
  state.sessionTitleOverrides.clear();

  // Sessions: merge with existing data to preserve already-loaded messages
  const existingSessions = new Map(state.sessions.map(s => [s.id, s]));
  state.sessions = (rawSessions || []).map(s => {
    const existing = existingSessions.get(s.id);
    return {
      ...s,
      messages: existing?.messages?.length ? existing.messages : []
    };
  });

  state.projects = projects || [];
  state.stats = stats || {};
  state.loaded = true;
}

/**
 * Load full detail for a session: messages with inline tool_calls (each with
 * result), summaries, subagents, and workflow data.
 *
 * Returns the assembled session object (also updates state.sessions entry).
 */
export async function loadSessionDetail(sessionId, location = 'local') {
  const [messages, toolCalls, toolResults, subagents, workflows, summaries] = await Promise.all([
    window.trajex.getSessionMessages(sessionId, location),
    window.trajex.getSessionToolCalls(sessionId, location),
    window.trajex.getSessionToolResults(sessionId, location),
    window.trajex.getSessionSubagents(sessionId, location),
    window.trajex.getSessionWorkflows(sessionId, location),
    window.trajex.getSessionSummaries(sessionId, location),
  ]);
  const detail = assembleSessionDetail({ messages, toolCalls, toolResults, subagents, workflows, summaries });
  const snapshot = {
    messages: detail.messages,
    workflows: detail.workflows,
    summaries: detail.summaries,
  };
  const metadata = sessionMetadata(state.sessions.find(candidate => candidate.id === sessionId));
  rememberSessionMessageSnapshot(snapshotKey(sessionId, location), {
    snapshot,
    cursor: createSessionPatchCursor(snapshot),
    session: metadata,
  });
  return commitSessionDetail(sessionId, snapshot, { updateStore: true, metadata });
}

export async function fetchSessionDetailPatch(sessionId, location = 'local') {
  const current = sessionMessageSnapshots.get(snapshotKey(sessionId, location));
  if (!current || typeof window.trajex.getSessionPatch !== 'function') {
    return { sessionId, location, current: null, patch: null };
  }
  const patch = await window.trajex.getSessionPatch(sessionId, current.cursor, location);
  return { sessionId, location, current, patch };
}

export async function materializeSessionDetailPatch({ sessionId, location = 'local', current, patch }) {
  if (!current || !patch) return loadSessionDetail(sessionId, location);
  const next = applySessionPatch(current.snapshot, current.cursor, patch);
  const metadata = sessionMetadata(patch.session) || current.session;
  const latest = commitSessionDetail(sessionId, next.snapshot, {
    updateStore: false,
    metadata,
  });
  latest.acceptMessagePatch = () => {
    const key = snapshotKey(sessionId, location);
    if (sessionMessageSnapshots.get(key) !== current) return false;
    rememberSessionMessageSnapshot(key, { ...next, session: metadata });
    commitStoredSessionMetadata(sessionId, metadata);
    return true;
  };
  latest.messagePatch = {
    changedIds: (patch.changes?.messages || []).map(message => message.uuid),
    removedIds: patch.removed?.messages || [],
    tailOnly: (patch.removed?.messages || []).length === 0
      && (patch.changes?.messages || []).length > 0
      && (patch.changes?.messages || []).every((message, offset) => (
        !Object.hasOwn(current.cursor.messages || {}, message.uuid)
        && patch.positions?.messages?.[message.uuid] === current.snapshot.messages.length + offset
      )),
  };
  return latest;
}

export function getCachedSessionDetail(sessionId, location = 'local') {
  const current = sessionMessageSnapshots.get(snapshotKey(sessionId, location));
  if (!current) return null;
  return commitSessionDetail(sessionId, current.snapshot, {
    updateStore: false,
    metadata: current.session,
  });
}

function commitSessionDetail(sessionId, { messages, workflows = [], summaries = [] }, { updateStore, metadata = null }) {
  const session = state.sessions.find(candidate => candidate.id === sessionId);
  const assembled = {
    ...(session || {}),
    ...(metadata || {}),
    id: sessionId,
    messages: markRaw(messages),
    summaries: markRaw(summaries),
  };
  if (workflows.length > 0) assembled.workflow = workflows[0];

  if (updateStore) {
    const index = state.sessions.findIndex(candidate => candidate.id === sessionId);
    if (index !== -1) state.sessions[index] = assembled;
  }
  return assembled;
}

/**
 * Load full detail for a subagent conversation.
 * Returns assembled messages with tool_calls inline.
 */
export async function loadSubagentDetail(agentId, location = 'local') {
  const [messages, toolCalls, toolResults, summaries] = await Promise.all([
    window.trajex.getSubagentMessages(agentId, location),
    window.trajex.getSubagentToolCalls(agentId, location),
    window.trajex.getSubagentToolResults(agentId, location),
    window.trajex.getSubagentSummaries(agentId, location),
  ]);
  const detail = assembleSessionDetail({
    messages,
    toolCalls,
    toolResults,
    summaries,
    subagents: [],
    workflows: [],
  });
  return { messages: detail.messages, summaries: detail.summaries };
}

const TEXT_LIMIT = 10000;

/**
 * Check if a message text was truncated during indexing.
 */
export function isTextTruncated(text) {
  return text && text.length >= TEXT_LIMIT;
}

/**
 * Fetch the full untruncated text for a message from its source JSONL.
 * Returns the full text string or null.
 */
export async function loadFullText(uuid, location = 'local') {
  try {
    return await window.trajex.getMessageFullText(uuid, location);
  } catch {
    return null;
  }
}

/**
 * Load the markdown content of a memory file.
 * Returns the content string or null on failure.
 */
export async function loadMemoryMarkdown(memoryPath) {
  try {
    const content = await window.trajex.readMemoryFile(memoryPath);
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Archive a memory by id. Updates state after successful IPC call.
 */
export async function archiveMemory(id) {
  await window.trajex.archiveMemory(id);
  const mem = state.memories.find(m => m.id === id);
  if (mem) {
    mem.archived = true;
    mem.archivedAt = Date.now();
  }
}

/**
 * Restore an archived memory by id. Updates state after successful IPC call.
 */
export async function restoreMemory(id) {
  await window.trajex.restoreMemory(id);
  const mem = state.memories.find(m => m.id === id);
  if (mem) {
    mem.archived = false;
    mem.archivedAt = null;
  }
}
