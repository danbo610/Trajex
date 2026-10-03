<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- Copyright (C) 2026 wutongyuonce and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { state } from '../store.js';
import { describeProgress, progressFraction, formatElapsed } from '../../../shared/index-progress.mjs';

defineOptions({ name: 'Settings' });

const sources = ref([]);
const dbPath = ref('');
const autoRefresh = ref(true);
const showUntitled = ref(false);
const debugLogging = ref(false);
const debugLoggingForced = ref(false);
const debugLogPath = ref('');
const memoryCount = ref(0);
const rebuilding = ref(false);
const rebuildError = ref('');
const version = ref('');
const remotes = ref([]);
const remoteBusy = ref({});
const remoteError = ref({});
let stopRemotesUpdated = () => {};
let remotesTimer = null;
let clockTimer = null;
// Ticks once a second so "2m 10s" keeps counting between (throttled) progress events.
const now = ref(Date.now());

onMounted(async () => {
  await loadSettings();
  stopRemotesUpdated = window.trajex?.onRemotesUpdated?.(() => { void loadSettings(); }) || (() => {});
  remotesTimer = setInterval(() => { void loadSettings(); }, 30000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  stopRemotesUpdated();
  if (remotesTimer) clearInterval(remotesTimer);
  if (clockTimer) clearInterval(clockTimer);
});

/** Live progress pushed over IPC, falling back to what settings:get reported. */
function liveProgress(remote) {
  return state.remoteProgress?.[remote.id]?.progress || remote.progress || null;
}
function stalledSeconds(remote) {
  return state.remoteProgress?.[remote.id]?.stalledSeconds || remote.stalledSeconds || 0;
}
function progressText(remote) {
  return describeProgress(liveProgress(remote), now.value) || 'Indexing…';
}
function progressPercent(remote) {
  const fraction = progressFraction(liveProgress(remote));
  return fraction === null ? null : Math.round(fraction * 100);
}
function currentFileName(remote) {
  const file = liveProgress(remote)?.currentFile;
  if (!file) return '';
  const parts = String(file).split(/[\\/]/);
  return parts.slice(-2).join('/');
}
function lastBuildText(remote) {
  const build = remote.lastBuild;
  if (!build) return '';
  const skipped = build.skipped ? `, ${build.skipped} skipped` : '';
  return `${build.files} files${skipped} in ${formatElapsed(build.durationMs)}`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

async function loadSettings() {
  if (!window.trajex?.getSettings) return;
  const s = await window.trajex.getSettings();
  sources.value = s.sources || [];
  dbPath.value = s.dbPath || '';
  autoRefresh.value = s.autoRefresh !== false;
  showUntitled.value = s.showUntitledSessions === true;
  state.showUntitledSessions = showUntitled.value;
  debugLogging.value = s.debugLogging === true;
  debugLoggingForced.value = s.debugLoggingForced === true;
  debugLogPath.value = s.debugLogPath || '';
  memoryCount.value = s.memoryCount || 0;
  version.value = s.version || '';
  syncRemotes(s.remotes || []);
}

// Keep text the user is typing (names) while refreshing status fields.
function syncRemotes(next) {
  const editing = new Map(remotes.value.map(r => [r.id, r]));
  remotes.value = next.map(r => {
    const prev = editing.get(r.id);
    return { ...r, nameDraft: prev && prev.nameDraft !== prev.name ? prev.nameDraft : r.name };
  });
}

const PROVIDER_FIELDS = [
  { key: 'claude', label: 'Claude root', hint: '~/.claude', placeholder: 'e.g. /Volumes/other-mac/.claude' },
  { key: 'codex', label: 'Codex root', hint: '~/.codex', placeholder: 'e.g. /Volumes/other-mac/.codex' },
  { key: 'pi', label: 'Pi sessions dir', hint: '~/.pi/agent/sessions', placeholder: 'e.g. /Volumes/other-mac/.pi/agent/sessions' },
];

async function guarded(id, fn) {
  remoteBusy.value = { ...remoteBusy.value, [id]: true };
  remoteError.value = { ...remoteError.value, [id]: '' };
  try {
    await fn();
  } catch (error) {
    remoteError.value = { ...remoteError.value, [id]: error instanceof Error ? error.message : String(error) };
  } finally {
    remoteBusy.value = { ...remoteBusy.value, [id]: false };
    await loadSettings();
  }
}

async function addRemote() {
  if (!window.trajex?.addRemote) return;
  await window.trajex.addRemote({ name: `Remote ${remotes.value.length + 1}`, providerRoots: {} });
  await loadSettings();
}

async function pickRemoteHome(remote) {
  const picked = await window.trajex?.pickRemoteHome?.();
  if (!picked) return;
  const found = Object.keys(picked.providerRoots || {}).length;
  await guarded(remote.id, async () => {
    if (!found) throw new Error(`No .claude, .codex or .pi/agent/sessions found in ${picked.home}`);
    await window.trajex.updateRemote(remote.id, { providerRoots: { ...remote.providerRoots, ...picked.providerRoots } });
  });
}

async function browseRemoteRoot(remote, field) {
  const result = await window.trajex?.browseFolder?.();
  if (!result) return;
  await guarded(remote.id, () => window.trajex.updateRemote(remote.id, {
    providerRoots: { ...remote.providerRoots, [field.key]: result },
  }));
}

async function clearRemoteRoot(remote, field) {
  const roots = { ...remote.providerRoots };
  delete roots[field.key];
  await guarded(remote.id, () => window.trajex.updateRemote(remote.id, { providerRoots: roots }));
}

async function commitRemoteRoot(remote, field, value) {
  const trimmed = String(value || '').trim();
  if (trimmed === (remote.providerRoots[field.key] || '')) return;
  const roots = { ...remote.providerRoots };
  if (trimmed) roots[field.key] = trimmed; else delete roots[field.key];
  await guarded(remote.id, () => window.trajex.updateRemote(remote.id, { providerRoots: roots }));
}

async function commitRemoteName(remote) {
  const name = String(remote.nameDraft || '').trim();
  if (!name || name === remote.name) { remote.nameDraft = remote.name; return; }
  await guarded(remote.id, () => window.trajex.updateRemote(remote.id, { name }));
}

const refreshRemote = remote => guarded(remote.id, () => window.trajex.refreshRemote(remote.id));
const rebuildRemote = remote => guarded(remote.id, () => window.trajex.rebuildRemote(remote.id));

async function deleteRemote(remote) {
  if (!window.confirm(`Delete "${remote.name}"?\n\nThis removes the remote and its local index file. Files on the remote machine are not touched.`)) return;
  await guarded(remote.id, () => window.trajex.removeRemote(remote.id));
}

async function browseSourcePath(source) {
  if (!window.trajex?.browseFolder) return;
  const result = await window.trajex.browseFolder();
  if (result) {
    await saveSetting(source.settingKey || `providerRoots.${source.id}`, result);
    await loadSettings();
  }
}

async function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  await saveSetting('autoRefresh', autoRefresh.value);
}

async function toggleShowUntitled() {
  showUntitled.value = !showUntitled.value;
  // Update the shared store first so an open Sessions list re-renders immediately.
  state.showUntitledSessions = showUntitled.value;
  await saveSetting('showUntitledSessions', showUntitled.value);
}

async function toggleDebugLogging() {
  debugLogging.value = !debugLogging.value;
  await saveSetting('debugLogging', debugLogging.value);
  await loadSettings();
}

async function saveSetting(key, value) {
  if (window.trajex?.setSetting) {
    await window.trajex.setSetting(key, value);
  }
}

async function rebuildIndex() {
  if (rebuilding.value || !window.trajex?.rebuildIndex) return;
  rebuilding.value = true;
  rebuildError.value = '';
  await nextTick();
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await window.trajex.rebuildIndex();
    await loadSettings();
  } catch (error) {
    rebuildError.value = error instanceof Error ? error.message : String(error);
  } finally {
    rebuilding.value = false;
  }
}

async function revealDb() {
  if (window.trajex?.revealPath) {
    window.trajex.revealPath(dbPath.value);
  }
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
</script>

<template>
  <div class="settings-wrap">
    <div class="settings-content">

      <!-- Data Sources -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Data Sources</h2>
          <p>Where Trajex reads your agent session history.</p>
        </div>

        <div class="subsection-title">Local</div>

        <div
          v-for="src in sources" :key="src.id"
          class="source-card"
          :class="{ error: src.status === 'error', warn: src.status === 'warn' }"
        >
          <div class="source-card-head">
            <div class="source-card-info">
              <div class="source-card-name">
                {{ src.name }}
                <span class="vendor">by {{ src.vendor }}</span>
              </div>
              <div class="source-card-status">
                <span class="stat-dot" :class="src.status"></span>
                <span class="stat-text" :class="src.status">{{ src.statusText }}</span>
                <template v-if="src.lastIndexed">
                  <span class="sep">·</span>
                  <span>last read <strong>{{ fmtRelative(src.lastIndexed) }}</strong></span>
                </template>
                <template v-if="src.sessionCount">
                  <span class="sep">·</span>
                  <span><strong>{{ src.sessionCount }}</strong> sessions</span>
                </template>
              </div>
            </div>
          </div>
          <div class="source-card-body">
            <div class="path-input">
              <input class="path-field" :class="{ error: src.status === 'error' }" type="text" :value="src.path" spellcheck="false" readonly/>
              <button class="btn" @click="browseSourcePath(src)">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                  <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
                </svg>
                Browse…
              </button>
            </div>
          </div>
        </div>

        <div class="subsection-title remote-title">
          <span>Remote</span>
          <button class="btn" @click="addRemote" title="Add a remote location">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 2.5v9M2.5 7h9"/></svg>
            Add
          </button>
        </div>
        <p class="subsection-hint">
          Read-only history from another machine, reached through a mounted folder (SMB, NFS, sshfs…).
          Each remote is indexed into its own local database and re-scanned every 5 minutes.
          Leave a directory blank to skip it.
        </p>
        <div v-if="!remotes.length" class="remote-empty">No remotes yet. Use “Add” to create one.</div>

        <div
          v-for="remote in remotes" :key="remote.id"
          class="source-card remote-card"
          :class="{ error: remote.status === 'unreachable' || remote.status === 'error', warn: remote.status === 'idle' }"
        >
          <div class="source-card-head remote-head">
            <div class="source-card-info">
              <input
                class="path-field remote-name"
                type="text"
                v-model="remote.nameDraft"
                spellcheck="false"
                placeholder="Name, e.g. Other Mac"
                @blur="commitRemoteName(remote)"
                @keydown.enter.prevent="$event.target.blur()"
              />
              <div class="source-card-status">
                <span class="stat-dot" :class="remote.status === 'ok' ? 'ok' : remote.status === 'indexing' || remote.status === 'idle' ? 'warn' : 'error'"></span>
                <span class="stat-text" :class="remote.status === 'ok' ? 'ok' : remote.status === 'indexing' || remote.status === 'idle' ? 'warn' : 'error'">{{ remote.statusText }}</span>
                <span class="sep">·</span>
                <span><strong>{{ remote.sessionCount }}</strong> sessions</span>
                <template v-if="remote.lastIndexed">
                  <span class="sep">·</span>
                  <span>last indexed <strong>{{ fmtRelative(remote.lastIndexed) }}</strong></span>
                </template>
              </div>
              <div v-if="remote.status === 'indexing'" class="index-progress">
                <div class="index-progress-text">{{ progressText(remote) }}</div>
                <div class="index-progress-bar" :class="{ indeterminate: progressPercent(remote) === null }">
                  <div class="index-progress-fill" :style="progressPercent(remote) === null ? {} : { width: progressPercent(remote) + '%' }"></div>
                </div>
                <div v-if="currentFileName(remote)" class="index-progress-file" :title="liveProgress(remote).currentFile">{{ currentFileName(remote) }}</div>
                <div v-if="!remote.hasIndex" class="index-progress-note">
                  First index of this remote: large or network directories (e.g. SMB shares with >1 GB of history) can take several minutes. You can keep using Trajex; this page updates automatically.
                </div>
                <div v-if="stalledSeconds(remote) >= 60" class="index-progress-note warn">
                  No progress for {{ stalledSeconds(remote) }}s — the share may be slow or disconnected. <template v-if="remote.logPath">Details: <code>{{ remote.logPath }}</code></template><template v-else>Turn on “Debug logging” below for details.</template>
                </div>
              </div>
              <div v-else-if="remote.lastBuild" class="index-progress-note">
                Last build: {{ lastBuildText(remote) }}<template v-if="remote.lastBuild.force"> (full rebuild)</template>
              </div>
              <div v-if="remote.lastIndexed" class="index-progress-note" :title="fmtTime(remote.lastIndexed)">
                Last indexed {{ fmtTime(remote.lastIndexed) }} · {{ remote.sessionCount }} sessions
              </div>
              <div v-if="remote.error" class="reset-error">
                Last error: {{ remote.error }}<template v-if="remote.logPath"> (log: <code>{{ remote.logPath }}</code>)</template>
              </div>
              <div v-if="remoteError[remote.id]" class="reset-error">{{ remoteError[remote.id] }}</div>
            </div>
            <div class="remote-actions">
              <button class="btn" :disabled="remoteBusy[remote.id]" @click="pickRemoteHome(remote)" title="Choose the remote home directory and auto-fill the roots below">Pick home…</button>
              <button class="btn" :disabled="remoteBusy[remote.id] || remote.status === 'indexing'" @click="refreshRemote(remote)">Refresh</button>
              <button class="btn" :disabled="remoteBusy[remote.id] || remote.status === 'indexing'" @click="rebuildRemote(remote)">Rebuild</button>
              <button class="btn subtle" :disabled="remoteBusy[remote.id]" @click="deleteRemote(remote)">Delete</button>
            </div>
          </div>
          <div class="source-card-body">
            <div v-for="field in PROVIDER_FIELDS" :key="field.key" class="remote-root">
              <div class="remote-root-label">
                {{ field.label }} <code>{{ field.hint }}</code>
                <span
                  v-if="remote.providerRoots[field.key]"
                  class="root-state"
                  :class="remote.roots.find(r => r.provider === field.key)?.exists === false ? 'error' : 'ok'"
                >{{ remote.roots.find(r => r.provider === field.key)?.exists === false ? 'not found' : 'found' }}</span>
                <span v-else class="root-state muted">not configured</span>
              </div>
              <div class="path-input">
                <input
                  class="path-field"
                  :class="{ error: remote.roots.find(r => r.provider === field.key)?.exists === false }"
                  type="text"
                  :value="remote.providerRoots[field.key] || ''"
                  spellcheck="false"
                  :placeholder="field.placeholder"
                  @change="commitRemoteRoot(remote, field, $event.target.value)"
                />
                <button class="btn" :disabled="remoteBusy[remote.id]" @click="browseRemoteRoot(remote, field)">Browse…</button>
                <button v-if="remote.providerRoots[field.key]" class="btn subtle" :disabled="remoteBusy[remote.id]" @click="clearRemoteRoot(remote, field)">Clear</button>
              </div>
            </div>
            <div class="remote-db">Index: <code>{{ remote.dbPath }}</code></div>
          </div>
        </div>
      </section>

      <!-- Index -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Index location</h2>
          <p>SQLite database where Trajex caches the unified session index.</p>
        </div>
        <div class="path-input" style="max-width: 480px;">
          <input class="path-field" type="text" :value="dbPath" spellcheck="false" readonly/>
          <button class="btn" @click="revealDb">Reveal</button>
        </div>
      </section>

      <!-- Auto-refresh -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Auto-refresh</h2>
          <p>Trajex re-reads when new session files appear.</p>
        </div>
        <label class="toggle-label" @click.prevent="toggleAutoRefresh">
          <span class="toggle-track" :class="{ on: autoRefresh }">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-text">Watch data sources for changes</span>
        </label>
      </section>

      <!-- Sessions list -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Sessions list</h2>
          <p>How sessions are listed for every location (Local and remotes).</p>
        </div>
        <label class="toggle-label" @click.prevent="toggleShowUntitled">
          <span class="toggle-track" :class="{ on: showUntitled }">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-text">Show untitled sessions</span>
        </label>
        <div class="index-progress-note">
          Off (default): untitled sessions, usually tests or incomplete runs, are folded into a “quiet sessions” group.
          On: all sessions appear in one list, newest first.
        </div>
      </section>

      <!-- Debug logging -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Debug logging</h2>
          <p>Write remote index diagnostics (build timings, skipped files, errors) to a log file. Off by default.</p>
        </div>
        <label class="toggle-label" @click.prevent="toggleDebugLogging">
          <span class="toggle-track" :class="{ on: debugLogging || debugLoggingForced }">
            <span class="toggle-thumb"></span>
          </span>
          <span class="toggle-text">Debug logging</span>
        </label>
        <div v-if="debugLoggingForced" class="index-progress-note">Forced on by the TRAJEX_DEBUG=1 environment variable.</div>
        <div v-if="debugLogging || debugLoggingForced" class="index-progress-note">Log file: <code>{{ debugLogPath }}</code> (rotated at 2 MB)</div>
        <div v-else class="index-progress-note">Errors are still shown on each remote above.</div>
      </section>

      <!-- About -->
      <section class="settings-section last">
        <div class="settings-section-head">
          <h2>About</h2>
          <p>The kind of details you don't usually need.</p>
        </div>
        <div class="form-row">
          <div class="form-label">Version</div>
          <div class="form-control version-text">
            Trajex {{ version }}
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">Reset</div>
          <div class="form-control">
            <div class="reset-actions">
              <button class="btn" :disabled="rebuilding" @click="rebuildIndex">
                {{ rebuilding ? 'Rebuilding…' : 'Rebuild index' }}
              </button>
            </div>
            <div class="reset-hint">
              Rebuilding re-reads your coding agent session data. It does not delete memories.
            </div>
            <div v-if="rebuildError" class="reset-error">{{ rebuildError }}</div>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>

<style scoped>
.settings-wrap { flex: 1; overflow-y: auto; min-height: 0; }
.settings-content { max-width: 720px; margin: 0 auto; padding: 36px 32px 80px; }

.subsection-title {
  font-size: 12px; font-weight: 600; color: var(--fg-2); letter-spacing: 0.04em;
  text-transform: uppercase; margin: 6px 0 10px;
}
.subsection-title.remote-title {
  display: flex; align-items: center; justify-content: space-between; margin-top: 26px;
}
.subsection-hint, .remote-empty { font-size: 12px; color: var(--muted); margin: 0 0 12px; }
.remote-head { display: flex; gap: 12px; align-items: flex-start; }
.remote-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.remote-name { width: 100%; max-width: 280px; font-family: inherit; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.remote-root { display: flex; flex-direction: column; gap: 4px; }
.remote-root-label { font-size: 12px; color: var(--fg-2); display: flex; gap: 8px; align-items: baseline; }
.remote-root-label code { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); }
.root-state { font-family: var(--font-mono); font-size: 10.5px; }
.root-state.ok { color: #34d399; }
.root-state.error { color: #f87171; }
.root-state.muted { color: var(--muted); }
.index-progress { margin: 8px 0 4px; max-width: 520px; }
.index-progress-text { font-size: 12px; color: var(--fg-2); font-variant-numeric: tabular-nums; margin-bottom: 4px; }
.index-progress-bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.10); overflow: hidden; position: relative; }
.index-progress-fill { height: 100%; background: #fbbf24; transition: width 0.25s linear; }
.index-progress-bar.indeterminate .index-progress-fill {
  position: absolute; width: 30%; animation: index-progress-slide 1.4s ease-in-out infinite;
}
@keyframes index-progress-slide { 0% { left: -30%; } 100% { left: 100%; } }
.index-progress-file { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.index-progress-note { font-size: 11.5px; color: var(--muted); margin-top: 6px; line-height: 1.45; }
.index-progress-note.warn { color: #fbbf24; }
.index-progress-note code, .reset-error code { font-family: var(--font-mono); font-size: 10.5px; }
.remote-db { font-size: 11px; color: var(--muted); }
.remote-db code { font-family: var(--font-mono); font-size: 10.5px; }

.settings-section { margin-bottom: 44px; }
.settings-section.last { margin-bottom: 0; }
.settings-section-head {
  margin-bottom: 16px; padding-bottom: 10px;
  border-bottom: 1px solid rgba(255,255,255,0.18);
}
.settings-section-head h2 {
  font-size: 18px; font-weight: 600;
  color: var(--fg); letter-spacing: -0.01em; margin-bottom: 2px;
}
.settings-section-head p {
  font-size: 13px; color: var(--muted);
}

/* Source cards */
.source-card {
  padding: 18px; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
  background: rgba(0,0,0,0.18); margin-bottom: 12px;
  transition: border-color 0.15s;
}
[data-theme='light'] .settings-section-head { border-color: var(--hairline); }
[data-theme='light'] .source-card { background: #fff; border-color: var(--hairline); }
.source-card:hover { border-color: rgba(255,255,255,0.28); }
[data-theme='light'] .source-card:hover { border-color: var(--hairline-strong); }
.source-card.error { border-color: rgba(248,113,113,0.25); }
.source-card.warn { border-color: rgba(251,191,36,0.20); }
.source-card-head { margin-bottom: 14px; }
.source-card-info { flex: 1; min-width: 0; }
.source-card-name {
  font-size: 14px; color: var(--fg); font-weight: 600; letter-spacing: -0.005em;
  display: flex; align-items: baseline; gap: 8px;
}
.source-card-name .vendor { font-size: 11.5px; color: var(--muted); font-weight: 400; }
.source-card-status {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
  margin-top: 3px; display: flex; align-items: center; gap: 8px;
}
.source-card-status .stat-dot { width: 6px; height: 6px; border-radius: 50%; position: relative; }
.source-card-status .stat-dot.ok { background: #34d399; box-shadow: 0 0 5px rgba(52,211,153,0.5); }
.source-card-status .stat-dot.warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251,191,36,0.5); }
.source-card-status .stat-dot.error { background: #f87171; box-shadow: 0 0 5px rgba(248,113,113,0.5); }
.source-card-status .stat-dot.ok::before {
  content: ''; position: absolute; inset: -2.5px; border-radius: 50%;
  border: 1px solid #34d399; opacity: 0.5; animation: src-pulse 1.6s ease-out infinite;
}
@keyframes src-pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.8); opacity: 0; } }
.source-card-status .stat-text { color: var(--fg-2); }
.source-card-status .stat-text.ok { color: #34d399; }
.source-card-status .stat-text.warn { color: #fbbf24; }
.source-card-status .stat-text.error { color: #f87171; }
.source-card-status .sep { color: var(--muted-3); }
.source-card-status strong { color: var(--fg-2); font-weight: 500; }
.source-card-body { display: flex; flex-direction: column; gap: 10px; }

.form-row {
  display: grid; grid-template-columns: 180px 1fr;
  gap: 24px; padding: 14px 0; align-items: start;
}
.form-row + .form-row { border-top: 1px solid rgba(255,255,255,0.14); }
[data-theme='light'] .form-row + .form-row { border-color: var(--hairline); }
.form-label { font-size: 13px; color: var(--fg-2); font-weight: 500; padding-top: 6px; }
.form-label-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 4px; font-weight: 400;
}
.form-label-hint code {
  font-family: var(--font-mono); font-style: normal; font-size: 10.5px;
  padding: 1px 4px; background: var(--theme-code-bg); border-radius: 3px; color: var(--muted);
}
.form-control { display: flex; flex-direction: column; gap: 8px; }

.path-input { display: flex; gap: 6px; }
.path-field {
  flex: 1; height: 28px; padding: 0 10px;
  background: var(--theme-code-bg); border: 1px solid rgba(255,255,255,0.24);
  border-radius: 5px; font-family: var(--font-mono); font-size: 12px;
  color: var(--fg); min-width: 0; transition: all 0.12s;
}
.path-field:focus { outline: 0; border-color: var(--accent); background: var(--theme-code-bg); box-shadow: 0 0 0 2px var(--accent-soft); }
[data-theme='light'] .path-field { border-color: var(--hairline-strong); }
.path-field.error { border-color: rgba(248,113,113,0.4); }
.path-field.error:focus { border-color: #f87171; box-shadow: 0 0 0 2px rgba(248,113,113,0.12); }
.tz-field { max-width: 240px; }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border: 1px solid rgba(255,255,255,0.24); border-radius: 5px;
  background: var(--surface); color: var(--fg-2);
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all 0.12s; white-space: nowrap;
}
.btn:hover { background: var(--surface-strong); color: var(--fg); border-color: var(--hairline-vivid); }
[data-theme='light'] .btn { border-color: var(--hairline-strong); }
.btn:disabled { opacity: 0.4; cursor: default; }
.btn.subtle { background: transparent; border-color: transparent; color: var(--muted); }
.btn.subtle:hover { background: var(--surface); color: var(--fg-2); }
.btn svg { width: 13px; height: 13px; }

.status-row {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 12px; background: rgba(0,0,0,0.2);
  border: 1px solid var(--hairline); border-radius: 5px;
  font-family: var(--font-mono); font-size: 11.5px; flex-wrap: wrap;
}
.status-row.ok { border-color: rgba(52,211,153,0.20); background: rgba(52,211,153,0.04); }
.status-row.warn { border-color: rgba(251,191,36,0.20); background: rgba(251,191,36,0.04); }
.status-row.error { border-color: rgba(248,113,113,0.20); background: rgba(248,113,113,0.04); }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  position: relative;
}
.status-dot.ok { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
.status-dot.warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251,191,36,0.5); }
.status-dot.error { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.5); }
.status-dot.ok::before {
  content: ''; position: absolute; inset: -3px;
  border-radius: 50%; border: 1px solid #34d399; opacity: 0.5;
  animation: pulse 1.6s ease-out infinite;
}
@keyframes pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.6); opacity: 0; } }
.status-text { color: var(--fg-2); font-weight: 500; }
.status-text.error { color: #f87171; }
.status-meta { display: flex; gap: 6px; color: var(--muted); align-items: center; flex-wrap: wrap; }
.status-meta strong { color: var(--fg-2); font-weight: 500; }
.status-meta .sep { color: var(--muted-2); }

.toggle-label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
.toggle-track {
  position: relative; width: 30px; height: 16px;
  background: var(--surface-strong); border: 1px solid var(--hairline-strong);
  border-radius: 8px; transition: all 0.15s;
}
.toggle-track.on { background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.5); }
.toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--muted); transition: all 0.15s;
}
.toggle-track.on .toggle-thumb {
  left: 16px; background: #c4b5fd;
  box-shadow: 0 0 6px rgba(167,139,250,0.5);
}
.toggle-text { font-size: 12.5px; color: var(--fg-2); }
.toggle-text code {
  font-family: var(--font-mono); font-size: 11px;
  padding: 1px 4px; background: rgba(0,0,0,0.3); border-radius: 3px;
}

.version-text {
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); padding-top: 6px;
}

.reset-error { margin-top: 8px; color: #f87171; font-size: 11.5px; }
.reset-actions { display: flex; gap: 8px; }
.reset-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 6px;
}
</style>
