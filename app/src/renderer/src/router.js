// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Vue Router configuration for Trajex.
// Routes map to the main content views; sidebar navigation drives route changes.

import { createRouter, createWebHashHistory } from 'vue-router';
import { setLocation } from './store.js';

// Lazy-loaded view components (will be created as Vue SFCs later)
const SessionList = () => import('./views/SessionList.vue');
const SessionDetail = () => import('./views/SessionDetail.vue');
const SubagentDetail = () => import('./views/SubagentDetail.vue');
const MemoryList = () => import('./views/MemoryList.vue');
const Activity = () => import('./views/Activity.vue');
const Settings = () => import('./views/Settings.vue');

const routes = [
  // Every session/stat route carries its data location: `local` or a remote id.
  {
    path: '/l/:loc([A-Za-z0-9_-]+)/sessions',
    name: 'SessionList',
    component: SessionList
  },
  {
    path: '/l/:loc([A-Za-z0-9_-]+)/sessions/:id',
    name: 'SessionDetail',
    component: SessionDetail,
    props: true
  },
  {
    path: '/l/:loc([A-Za-z0-9_-]+)/sessions/:id/agent/:agentId',
    name: 'SubagentDetail',
    component: SubagentDetail,
    props: true
  },
  // Back-compat: pre-location URLs are local.
  { path: '/sessions', redirect: '/l/local/sessions' },
  {
    path: '/sessions/:id',
    redirect: to => ({ path: `/l/local/sessions/${encodeURIComponent(String(to.params.id))}`, query: to.query })
  },
  {
    path: '/sessions/:id/agent/:agentId',
    redirect: to => ({
      path: `/l/local/sessions/${encodeURIComponent(String(to.params.id))}/agent/${encodeURIComponent(String(to.params.agentId))}`,
      query: to.query,
    })
  },
  {
    path: '/memory',
    name: 'MemoryList',
    component: MemoryList
  },
  {
    path: '/memory/:id',
    name: 'MemoryDetail',
    component: MemoryList,
    props: true
  },
  {
    path: '/l/:loc([A-Za-z0-9_-]+)/activity',
    name: 'Activity',
    component: Activity
  },
  { path: '/activity', redirect: '/l/local/activity' },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings
  },
  {
    path: '/',
    redirect: '/memory'
  },
  {
    // Catch-all redirect
    path: '/:pathMatch(.*)*',
    redirect: '/memory'
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

// Keep the store's active location in sync with the URL. Memory is local-only.
router.beforeEach((to) => {
  if (typeof to.params.loc === 'string') setLocation(to.params.loc);
  else if (to.name === 'MemoryList' || to.name === 'MemoryDetail') setLocation('local');
});

export default router;
