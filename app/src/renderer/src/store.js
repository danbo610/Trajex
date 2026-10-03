// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared renderer state. Navigation state belongs to Vue Router; this store
// holds only data and cross-view UI preferences.

import { reactive, shallowReactive, markRaw } from 'vue';

export const state = reactive({
  memories: [],
  sessions: [],
  sessionTitleOverrides: shallowReactive(new Map()),
  projects: [],
  sources: [],
  stats: {},
  view: 'active',          // 'active' | 'archived'
  query: '',
  projectFilter: 'all',
  sourceFilter: 'all',
  projectSearch: '',
  sortDesc: true,
  includeMessageBodies: false,
  cursorId: null,
  selection: markRaw(new Set()),
  loaded: false,
  // Active data location: 'local' or a remote id. Sessions/projects/stats in
  // this store always belong to this location; memories are always local.
  location: 'local',
  // Settings > "Show untitled sessions": when true the Sessions list does not fold untitled
  // ("quiet") sessions away. Persisted in settings.json as `showUntitledSessions`.
  showUntitledSessions: false,
  // Live index progress per remote id: { [id]: { progress, stalledSeconds } }.
  remoteProgress: {},
  locations: [{ id: 'local', name: 'Local', kind: 'local', sessionCount: 0, status: 'ok', statusText: '', error: '' }],
});

export const LOCAL_LOCATION = 'local';

export function isRemoteLocation(id = state.location) {
  return Boolean(id) && id !== LOCAL_LOCATION;
}

export function locationName(id = state.location) {
  return state.locations.find(item => item.id === id)?.name || (id === LOCAL_LOCATION ? 'Local' : id);
}

/** Switch the active location and drop the previous location's catalogue. */
export function setLocation(id) {
  const next = id || LOCAL_LOCATION;
  if (state.location === next) return false;
  state.location = next;
  state.sessions = [];
  state.projects = [];
  state.stats = {};
  state.loaded = false;
  state.projectFilter = 'all';
  state.sourceFilter = 'all';
  state.query = '';
  state.cursorId = null;
  state.selection = markRaw(new Set());
  state.sessionTitleOverrides.clear();
  return true;
}

/** Route path helpers (every session/stat route carries its location). */
export function locationPath(id, section = 'sessions') {
  return `/l/${encodeURIComponent(id || LOCAL_LOCATION)}/${section}`;
}

export function getSessionSummary(sessionId) {
  const id = String(sessionId || '');
  const session = state.sessions.find(candidate => candidate.id === id);
  const title = state.sessionTitleOverrides.get(id);
  if (title === undefined) return session;
  return { ...(session || { id }), title };
}

// SVG icon constants
export const FOLDER_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4h4l1.5 1.5h5.5v7a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-8z"/></svg>`;

// --- Action functions ---

export function setSelection(ids) {
  state.selection = markRaw(new Set(ids));
}

export function clearSelection() {
  setSelection([]);
}

export function resetListState() {
  state.cursorId = null;
  clearSelection();
  state.query = '';
}

export function setView(v) {
  state.view = v;
  state.cursorId = null;
  clearSelection();
  state.projectFilter = 'all';
}

export function setProject(p) {
  state.projectFilter = p;
  state.cursorId = null;
  clearSelection();
}

export function toggleSort() {
  state.sortDesc = !state.sortDesc;
}

export function setQuery(q) {
  state.query = q;
}

export function setProjectSearch(q) {
  state.projectSearch = q;
}

export function toggleIncludeMessageBodies() {
  state.includeMessageBodies = !state.includeMessageBodies;
}
