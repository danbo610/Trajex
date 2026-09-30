// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Vue 3 application entry point for Trajex.

import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { commitInitialData, fetchInitialData, loadLocations } from './data.js';
import { state } from './store.js';
import { liveSessionKey, noteSessionUpdated, sessionLiveState } from './session-live.mjs';
import { createGlobalDataRefreshCoordinator } from './session-global-refresh.mjs';
import { installLocalMarkdownLinkHandlers } from './local-markdown-links.js';

// Import shared renderer CSS globally
import '../styles/base.css';
import '../styles/sidebar.css';
import '../styles/toolbar.css';
import '../styles/list.css';
import '../styles/detail.css';

const app = createApp(App);

app.use(router);

const globalDataRefresh = createGlobalDataRefreshCoordinator({
  isDeferred: () => {
    const routeName = router.currentRoute.value.name;
    return routeName === 'SessionDetail';
  },
  load: fetchInitialData,
  commit: commitInitialData,
});

function reportGlobalRefreshFailure(request) {
  void request.catch(error => {
    console.error('Failed to refresh Trajex catalogues:', error);
  });
}

// Load data on startup
router.isReady().then(() => {
  loadedLocation = state.location;
  void loadLocations();
  reportGlobalRefreshFailure(globalDataRefresh.initialize());
});

// The catalogue in the store belongs to one location; reload after switching.
let loadedLocation = null;
router.afterEach(() => {
  if (loadedLocation !== null && loadedLocation !== state.location) {
    loadedLocation = state.location;
    reportGlobalRefreshFailure(globalDataRefresh.invalidate());
    return;
  }
  loadedLocation = state.location;
  reportGlobalRefreshFailure(globalDataRefresh.flush());
});

// Refresh data when window regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reportGlobalRefreshFailure(globalDataRefresh.invalidate());
  }
});

window.trajex?.onIndexUpdated?.((payload) => {
  const location = payload?.location;
  void loadLocations();
  // Other remotes' index changes do not affect what is on screen.
  if (location && location !== 'local' && location !== state.location) return;
  reportGlobalRefreshFailure(globalDataRefresh.invalidate());
});

window.trajex?.onRemotesUpdated?.(() => {
  void loadLocations();
});

window.trajex?.onSessionUpdated?.(({ sessionId, location } = {}) => {
  const route = router.currentRoute.value;
  const currentSessionId = route.name === 'SessionDetail'
    ? liveSessionKey(String(route.params.loc || 'local'), String(route.params.id || ''))
    : null;
  noteSessionUpdated(sessionLiveState, liveSessionKey(location, sessionId), currentSessionId);
});

installLocalMarkdownLinkHandlers();

app.mount('#app');
