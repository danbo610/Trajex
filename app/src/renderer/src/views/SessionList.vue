<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- Copyright (C) 2026 wutongyuonce and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed, ref, nextTick, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { state, isRemoteLocation, locationName } from '../store.js';
import { sourceColor, sourceLabel } from '../source-catalog.mjs';
import { groupSessions } from '../session-list-groups.mjs';
import { renameSession, setSessionHidden } from '../data.js';
import { highlightPlain, escapeHTML, formatProjectLabel, fmtListTime, fmtRelative } from '../utils.js';

defineOptions({ name: 'SessionList' });

const router = useRouter();
const debugEmpty = ref(false);

function onKeydown(e) {
  if (e.key === 'm' && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'INPUT') {
    debugEmpty.value = !debugEmpty.value;
  }
}
function closeMenu() { menu.value = null; }
function onMenuKeydown(e) { if (e.key === 'Escape' && menu.value) closeMenu(); }
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keydown', onMenuKeydown);
  window.addEventListener('click', closeMenu);
  window.addEventListener('blur', closeMenu);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keydown', onMenuKeydown);
  window.removeEventListener('click', closeMenu);
  window.removeEventListener('blur', closeMenu);
});

// --- Rename / hide (stored only in Trajex's own index DB, never in the transcripts) ---
const menu = ref(null);          // { x, y, session }
const renamingId = ref(null);
const renameDraft = ref('');
const actionError = ref('');

function openMenu(event, session) {
  const width = 176;
  const height = session.renamed ? 112 : 80;
  menu.value = {
    session,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  };
}

function openMenuFromButton(event, session) {
  const rect = event.currentTarget.getBoundingClientRect();
  openMenu({ clientX: rect.right - 176, clientY: rect.bottom + 4 }, session);
}

async function startRename(session) {
  closeMenu();
  actionError.value = '';
  renamingId.value = session.id;
  renameDraft.value = session.title || '';
  await nextTick();
  const input = document.querySelector(`.srow[data-session-id="${CSS.escape(session.id)}"] .srow-rename`);
  input?.focus();
  input?.select();
}

function cancelRename() {
  renamingId.value = null;
}

async function commitRename(session) {
  if (renamingId.value !== session.id) return;
  const next = renameDraft.value.trim();
  renamingId.value = null;
  // Unchanged text is a no-op; empty text reverts to the original title.
  if (next === (session.title || '')) return;
  try {
    await renameSession(session.id, next || null);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function resetTitle(session) {
  closeMenu();
  try {
    await renameSession(session.id, null);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function toggleHidden(session, hidden) {
  closeMenu();
  actionError.value = '';
  try {
    await setSessionHidden(session.id, hidden);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

const homePath = (typeof process !== 'undefined' && process.env?.HOME) || '~';

const visibleSessions = computed(() => {
  const q = state.query.trim().toLowerCase();
  // The Hidden view lists the soft-hidden sessions instead of the normal list.
  return (state.showHiddenSessions ? state.hiddenSessions : state.sessions)
    .filter(s => state.projectFilter === 'all' || s.project === state.projectFilter)
    .filter(s => state.sourceFilter === 'all' || (s.source || 'claude') === state.sourceFilter)
    .map(s => {
      if (!q) return { ...s, messageHit: null };
      const topMatch = (s.title || '').toLowerCase().includes(q) ||
                       (s.project || '').toLowerCase().includes(q) ||
                       (s.git_branch || '').toLowerCase().includes(q);
      if (topMatch) return { ...s, messageHit: null };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = new Date(a.ended_at || a.started_at || 0).getTime();
      const tb = new Date(b.ended_at || b.started_at || 0).getTime();
      return state.sortDesc ? tb - ta : ta - tb;
    });
});

const showProjectPrefix = computed(() => state.projectFilter === 'all');
const showNoise = ref(false);

// Untitled sessions are folded into a "quiet" group unless Settings > "Show untitled sessions" is on.
const groups = computed(() => groupSessions(visibleSessions.value, { showUntitled: state.showUntitledSessions || state.showHiddenSessions }));
const normalSessions = computed(() => groups.value.normal);
const noiseSessions = computed(() => groups.value.noise);

function titleHTML(session) {
  return highlightPlain(session.title || '(untitled)', state.query.trim());
}

function projectLabel(session) {
  return escapeHTML(formatProjectLabel(session.project));
}

function timeLabel(session) {
  const ts = new Date(session.ended_at || session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function lastActiveLabel(session) {
  const ts = new Date(session.ended_at || session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function createdLabel(session) {
  const ts = new Date(session.started_at || 0).getTime();
  return fmtRelative(ts);
}

function openSession(session) {
  router.push({ name: 'SessionDetail', params: { loc: state.location, id: session.id } });
}

function trajexStyle(session) {
  const created = new Date(session.started_at || 0).getTime();
  const days = Math.max(0, (Date.now() - created) / 86400000);
  const height = Math.min(1, Math.log(1 + days) / Math.log(1 + 365));

  let color;
  if (days < 7) color = '#a855f7';
  else if (days < 30) color = '#6366f1';
  else if (days < 90) color = '#64748b';
  else color = '#475569';

  const glow = days < 7 ? `0 0 4px ${color}` : 'none';
  const maxHeight = 36; // px, roughly the row height minus padding

  return {
    height: `${Math.max(4, Math.round(height * maxHeight))}px`,
    background: color,
    boxShadow: glow,
  };
}
</script>

<template>
  <div class="session-list-wrap">
    <!-- Hidden sessions: soft-deleted, recoverable -->
    <div v-if="state.loaded && (state.hiddenSessions.length || state.showHiddenSessions)" class="hidden-bar" :class="{ active: state.showHiddenSessions }">
      <template v-if="!state.showHiddenSessions">
        <span>{{ state.hiddenSessions.length }} hidden {{ state.hiddenSessions.length === 1 ? 'session' : 'sessions' }}</span>
        <button class="hidden-bar-link" type="button" @click="state.showHiddenSessions = true">Show</button>
      </template>
      <template v-else>
        <span>Hidden sessions ({{ state.hiddenSessions.length }}) — use Restore to bring one back. Files on disk are never touched.</span>
        <button class="hidden-bar-link" type="button" @click="state.showHiddenSessions = false">Back to sessions</button>
      </template>
    </div>
    <div v-if="actionError" class="hidden-bar error">{{ actionError }}</div>

    <!-- Row context menu -->
    <div v-if="menu" class="row-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop @contextmenu.prevent>
      <button type="button" @click="startRename(menu.session)">Rename…</button>
      <button v-if="menu.session.renamed" type="button" @click="resetTitle(menu.session)">Reset to original title</button>
      <button v-if="state.showHiddenSessions" type="button" @click="toggleHidden(menu.session, false)">Restore</button>
      <button v-else type="button" @click="toggleHidden(menu.session, true)">Hide</button>
    </div>

    <!-- Remote location without sessions yet -->
    <div v-if="state.loaded && isRemoteLocation() && !visibleSessions.length && !state.query && !state.hiddenSessions.length" class="empty-content">
      <div class="empty-eyebrow">
        <span class="diamond"></span>
        <span>{{ locationName() }}</span>
      </div>
      <div class="empty-title">No sessions indexed for this remote yet.</div>
      <div class="empty-body">
        Trajex reads the remote's directories (read-only) every 5 minutes into a separate local index.
        Check the directories under <button class="inline-link" @click="router.push('/settings')">Settings → Data Sources → Remote</button>
        and make sure the share is mounted.
      </div>
    </div>

    <!-- Empty state: no data source / debug toggle -->
    <div v-else-if="state.loaded && (debugEmpty || (!visibleSessions.length && !state.query))" class="empty-content">
      <div class="empty-eyebrow">
        <span class="diamond"></span>
        <span>No data source connected</span>
      </div>
      <div class="empty-title">Trajex reads your Claude Code session history.</div>
      <div class="empty-body">
        We didn't find <code>~/.claude</code> on this machine. If you've already used
        Claude Code, point Trajex at where its data lives in
        <button class="inline-link" @click="router.push('/settings')">Settings</button>. If you haven't,
        <strong>install Claude Code first</strong> — Trajex has nothing to read until
        sessions exist.
      </div>
      <div class="empty-actions">
        <button class="toolbar-action primary" @click="router.push('/settings')">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
            <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
          </svg>
          Choose folder…
        </button>
      </div>
      <div class="empty-divider"></div>
      <div class="empty-help">
        <div class="help-row">
          <span class="label">expected</span>
          <code>~/.claude</code>
        </div>
        <div class="help-row">
          <span class="label">searched</span>
          <code>{{ homePath }}</code>
        </div>
      </div>
    </div>

    <!-- Empty state: search returned nothing -->
    <div v-else-if="state.loaded && !visibleSessions.length" class="empty">
      No sessions here.
      <span class="hint">{{ state.query ? 'Try a different search term.' : 'Press / to search.' }}</span>
    </div>

    <div v-else class="session-list">
      <div
        v-for="s in normalSessions"
        :key="s.id"
        class="srow"
        :class="{ cursor: state.cursorId === s.id, 'is-hidden': state.showHiddenSessions }"
        :data-session-id="s.id"
        @click="openSession(s)"
        @contextmenu.prevent="openMenu($event, s)"
      >
        <div class="srow-trajex" :style="trajexStyle(s)"></div>
        <div class="srow-body">
          <input
            v-if="renamingId === s.id"
            v-model="renameDraft"
            class="srow-rename"
            type="text"
            maxlength="200"
            spellcheck="false"
            placeholder="Session title (empty = original)"
            @click.stop
            @dblclick.stop
            @keydown.enter.prevent="commitRename(s)"
            @keydown.esc.prevent.stop="cancelRename"
            @blur="cancelRename"
          />
          <div v-else class="srow-title" :class="{ untitled: !s.title }" v-html="titleHTML(s)"></div>
          <button class="srow-more" type="button" title="Rename / hide" aria-label="Session actions" @click.stop="openMenuFromButton($event, s)">⋯</button>
          <div class="srow-meta">
            <template v-if="showProjectPrefix">
              <span class="project-tag" v-html="projectLabel(s)"></span>
              <span class="dot"></span>
            </template>
            <span>{{ s.message_count || 0 }} msg</span>
          </div>
        </div>
        <div class="srow-right">
          <span class="srow-time">{{ timeLabel(s) }}</span>
          <span class="srow-agent" :title="sourceLabel(s.source, state.sources)">
            <span class="srow-agent-dot" :style="{ '--source-color': sourceColor(s.source, state.sources) }"></span>{{ sourceLabel(s.source, state.sources) }}
          </span>
        </div>
      </div>

      <!-- Noise fold banner -->
      <div v-if="noiseSessions.length && !state.query" class="fold-banner" :class="{ expanded: showNoise }" @click="showNoise = !showNoise">
        <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M4 2.5l3 3.5-3 3.5"/>
        </svg>
        <div class="body">
          <strong>{{ noiseSessions.length }}</strong> quiet sessions hidden — untitled, likely tests or incomplete runs.
        </div>
        <span v-if="!showNoise" class="reveal-link">Show all</span>
      </div>

      <!-- Noise sessions (collapsed by default) -->
      <div v-if="showNoise && noiseSessions.length" class="noise-group">
        <div class="noise-group-head">
          {{ noiseSessions.length }} sessions · untitled
        </div>
        <div
          v-for="s in noiseSessions"
          :key="s.id"
          class="srow noise"
          :data-session-id="s.id"
          @click="openSession(s)"
          @contextmenu.prevent="openMenu($event, s)"
        >
          <div class="srow-body">
            <input
              v-if="renamingId === s.id"
              v-model="renameDraft"
              class="srow-rename"
              type="text"
              maxlength="200"
              spellcheck="false"
              placeholder="Session title (empty = original)"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent="commitRename(s)"
              @keydown.esc.prevent.stop="cancelRename"
              @blur="cancelRename"
            />
            <div v-else class="srow-title untitled">(untitled)</div>
            <button class="srow-more" type="button" title="Rename / hide" aria-label="Session actions" @click.stop="openMenuFromButton($event, s)">⋯</button>
            <div class="srow-meta">
              <template v-if="showProjectPrefix">
                <span class="project-tag" v-html="projectLabel(s)"></span>
                <span class="dot"></span>
              </template>
              <span>{{ s.message_count || 0 }} msg</span>
            </div>
          </div>
          <div class="srow-right">
          <span class="srow-time">{{ timeLabel(s) }}</span>
          <span class="srow-agent" :title="sourceLabel(s.source, state.sources)">
            <span class="srow-agent-dot" :style="{ '--source-color': sourceColor(s.source, state.sources) }"></span>{{ sourceLabel(s.source, state.sources) }}
          </span>
        </div>
        </div>
        <button class="noise-fold-bottom" @click.stop="showNoise = false">
          <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M4 2.5l3 3.5-3 3.5"/>
          </svg>
          Collapse
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.srow {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  column-gap: 12px;
  padding: 12px 16px;
  min-height: var(--row-h-session);
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.06s;
  position: relative;
}
.srow:hover {
  background: rgba(255, 255, 255, 0.025);
}
.srow.cursor {
  background: var(--surface);
}
.srow.cursor::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--muted-2);
}

.srow-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.srow-title {
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--fg);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow-title :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-2);
  padding: 0 2px;
  border-radius: 2px;
}

.srow-body { position: relative; }
.srow-more {
  position: absolute; top: -3px; right: 0;
  width: 24px; height: 22px; line-height: 18px; padding: 0;
  border: 1px solid var(--hairline); border-radius: 4px;
  background: var(--surface, #1a1a1d); color: var(--muted);
  font-size: 15px; cursor: pointer; opacity: 0;
  transition: opacity 0.08s, color 0.08s;
}
.srow:hover .srow-more, .srow-more:focus-visible { opacity: 1; }
.srow-more:hover { color: var(--fg); }
.srow-rename {
  width: 100%; box-sizing: border-box;
  font: inherit; font-size: 13px; color: var(--fg);
  background: var(--surface, #1a1a1d);
  border: 1px solid var(--accent, #a78bfa); border-radius: 4px;
  padding: 2px 6px; margin: -3px 0 3px; outline: none;
}
.hidden-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 7px 16px; font-size: 11.5px; color: var(--muted);
  border-bottom: 1px solid var(--hairline); flex-shrink: 0;
}
.hidden-bar.active { color: var(--fg-2); background: rgba(251,191,36,0.06); }
.hidden-bar.error { color: #f87171; }
.hidden-bar-link {
  background: none; border: none; padding: 0; font: inherit; cursor: pointer;
  color: var(--accent-2, #c4b5fd); border-bottom: 1px solid rgba(167,139,250,0.4);
}
.row-menu {
  position: fixed; z-index: 50; min-width: 176px; padding: 4px;
  background: var(--surface, #1a1a1d); border: 1px solid var(--hairline-2, var(--hairline));
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  display: flex; flex-direction: column;
}
.row-menu button {
  text-align: left; background: none; border: none; color: var(--fg-2);
  font: inherit; font-size: 12.5px; padding: 6px 10px; border-radius: 4px; cursor: pointer;
}
.row-menu button:hover { background: rgba(255,255,255,0.07); color: var(--fg); }
[data-theme='light'] .row-menu button:hover { background: rgba(0,0,0,0.06); }
.srow.is-hidden .srow-title { opacity: 0.7; }
.srow-title.untitled { color: var(--muted); font-style: italic; }

.srow-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.srow-meta .project-tag {
  color: var(--fg-2);
  font-weight: 500;
}
.srow-meta .dot {
  width: 2px;
  height: 2px;
  background: var(--muted-2);
  border-radius: 50%;
  flex-shrink: 0;
}

.srow-right {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  padding-top: 2px;
  white-space: nowrap;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}
.srow-agent {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  line-height: 1.2;
  color: var(--muted);
  letter-spacing: 0.02em;
  text-transform: lowercase;
}
.srow-agent-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--source-color);
  box-shadow: 0 0 4px color-mix(in srgb, var(--source-color) 60%, transparent);
}
[data-theme='light'] .srow-agent-dot { box-shadow: none; }

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-2);
  font-size: var(--text-sm);
  padding: 60px 20px;
  text-align: center;
  flex-direction: column;
  gap: 8px;
}
.empty .hint {
  font-size: 11px;
  color: var(--muted-2);
}

/* Onboarding empty state */
.empty-content {
  flex: 1;
  display: flex; flex-direction: column; gap: 16px;
  max-width: 520px;
  margin: 0 auto;
  justify-content: center;
  padding: 40px;
}
.empty-eyebrow {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--muted); letter-spacing: 0.04em;
}
.empty-eyebrow .diamond {
  width: 6px; height: 6px;
  background: var(--accent, #a78bfa); transform: rotate(45deg);
  box-shadow: 0 0 6px rgba(167,139,250,0.4); flex-shrink: 0;
}
.empty-title {
  font-family: var(--font-serif, Georgia); font-size: 22px;
  font-weight: 500; color: var(--fg);
  letter-spacing: -0.015em; line-height: 1.2;
}
.empty-body {
  font-family: var(--font-serif, Georgia); font-style: italic;
  font-size: 14px; color: var(--fg-3); line-height: 1.6; max-width: 460px;
}
.empty-body code {
  font-family: var(--font-mono); font-style: normal; font-size: 12.5px;
  color: var(--accent-2, #c4b5fd); background: rgba(167,139,250,0.12);
  padding: 1px 6px; border-radius: 3px;
}
.empty-body strong { color: var(--fg); font-weight: 600; font-style: normal; }
.empty-body .inline-link {
  color: var(--accent-2, #c4b5fd); background: none;
  border: none; border-bottom: 1px solid rgba(167,139,250,0.4);
  padding: 0 0 1px; font: inherit; cursor: pointer; transition: all 0.12s;
}
.empty-body .inline-link:hover { color: var(--accent, #a78bfa); border-bottom-color: var(--accent); }
.empty-actions { display: flex; gap: 8px; margin-top: 6px; }
.empty-actions .toolbar-action {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 5px;
  font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.12s;
}
.empty-actions .toolbar-action.primary {
  border: 1px solid rgba(167,139,250,0.35); background: rgba(167,139,250,0.12); color: #c4b5fd;
}
.empty-actions .toolbar-action.primary:hover {
  background: rgba(167,139,250,0.18); border-color: #a78bfa; color: var(--fg);
  box-shadow: 0 0 12px rgba(167,139,250,0.2);
}
.empty-actions .toolbar-action svg { width: 13px; height: 13px; }
.empty-divider { width: 100%; height: 1px; background: var(--hairline); margin: 6px 0; }
.empty-help {
  display: flex; flex-direction: column; gap: 6px;
  font-family: var(--font-mono); font-size: 11px; color: var(--muted);
}
.empty-help .help-row { display: flex; align-items: baseline; gap: 8px; }
.empty-help .help-row .label { color: var(--muted-2); letter-spacing: 0.04em; width: 76px; flex-shrink: 0; }
.empty-help code {
  font-family: var(--font-mono); color: var(--fg-2);
  background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 3px;
}

/* Noise fold */
.fold-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 22px;
  background: rgba(255,255,255,0.015);
  border-top: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
  font-size: 12.5px; color: var(--muted);
  cursor: pointer; transition: all 0.1s;
}
.fold-banner:hover { background: rgba(255,255,255,0.03); color: var(--fg-2); }
.fold-banner.expanded { color: var(--fg-3); background: rgba(255,255,255,0.02); }
.fold-banner .chev {
  width: 10px; height: 10px; color: var(--muted-2);
  transition: transform 0.15s; flex-shrink: 0;
}
.fold-banner.expanded .chev { transform: rotate(90deg); color: var(--accent-2); }
.fold-banner .body { flex: 1; }
.fold-banner .body strong {
  color: var(--fg-2); font-weight: 500;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono); font-size: 11.5px;
}
.fold-banner .reveal-link {
  font-size: 11.5px; color: var(--accent-2);
  text-decoration: none; border-bottom: 1px solid rgba(167,139,250,0.4);
  padding-bottom: 1px; transition: all 0.12s; flex-shrink: 0;
}
.fold-banner:hover .reveal-link { color: var(--accent); border-bottom-color: var(--accent); }

.noise-group {
  border-bottom: 1px solid var(--hairline-strong);
  background: rgba(0,0,0,0.15);
}
.noise-group-head {
  padding: 6px 22px;
  font-family: var(--font-mono); font-size: 10px; color: var(--muted-2);
  letter-spacing: 0.06em; text-transform: uppercase;
  background: rgba(0,0,0,0.1); border-bottom: 1px solid var(--hairline);
}
.srow.noise { padding: 8px 22px 8px 18px; }
.srow.noise .srow-title {
  color: var(--muted); font-style: italic;
  font-size: 13px; font-weight: 400;
}
.srow.noise .srow-meta { color: var(--muted-2); }

.noise-fold-bottom {
  padding: 8px 22px; background: rgba(0,0,0,0.2);
  font-family: var(--font-mono); font-size: 11px; color: var(--muted);
  cursor: pointer; transition: all 0.1s;
  display: flex; align-items: center; gap: 8px;
  border-top: 1px solid var(--hairline);
  border: none; width: 100%; text-align: left;
}
.noise-fold-bottom:hover { background: rgba(0,0,0,0.3); color: var(--fg-2); }
.noise-fold-bottom .chev {
  width: 9px; height: 9px; color: var(--muted-2);
  transform: rotate(-90deg);
}
</style>
