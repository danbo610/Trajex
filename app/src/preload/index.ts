// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  RemoteIndexProgressPayload,
  RemoteProviderRootsConfig,
  SessionPatch,
  SessionPatchCursor,
  UsageStatsOptions,
} from '../shared/ipc-types.ts';

contextBridge.exposeInMainWorld('trajex', {
  getSessions: (opts?: unknown) => ipcRenderer.invoke('db:getSessions', opts),
  getSessionMessages: (id: string, location?: string) => ipcRenderer.invoke('db:getSessionMessages', id, location),
  getSessionToolCalls: (id: string, location?: string) => ipcRenderer.invoke('db:getSessionToolCalls', id, location),
  getSessionToolResults: (id: string, location?: string) => ipcRenderer.invoke('db:getSessionToolResults', id, location),
  getSessionPatch: (id: string, cursor: SessionPatchCursor, location?: string): Promise<SessionPatch | null> => (
    ipcRenderer.invoke('db:getSessionPatch', id, cursor, location)
  ),
  getSessionSubagents: (id: string, location?: string) => ipcRenderer.invoke('db:getSessionSubagents', id, location),
  getSessionWorkflows: (id: string, location?: string) => ipcRenderer.invoke('db:getSessionWorkflows', id, location),
  getSubagentMessages: (agentId: string, location?: string) => ipcRenderer.invoke('db:getSubagentMessages', agentId, location),
  getSubagentToolCalls: (agentId: string, location?: string) => ipcRenderer.invoke('db:getSubagentToolCalls', agentId, location),
  getSubagentToolResults: (agentId: string, location?: string) => ipcRenderer.invoke('db:getSubagentToolResults', agentId, location),
  getSubagentSummaries: (agentId: string, location?: string) => ipcRenderer.invoke('db:getSubagentSummaries', agentId, location),
  getSessionSummaries: (id: string, location?: string) => ipcRenderer.invoke('db:getSessionSummaries', id, location),
  getMessageFullText: (uuid: string, location?: string) => ipcRenderer.invoke('db:getMessageFullText', uuid, location),
  getMemories: () => ipcRenderer.invoke('db:getMemories'),
  readMemoryFile: (path: string) => ipcRenderer.invoke('db:readMemoryFile', path),
  previewLocalMarkdownLink: (href: string) => ipcRenderer.invoke('local-link:preview', href),
  openLocalMarkdownLink: (href: string) => ipcRenderer.invoke('local-link:open', href),
  openWebMarkdownLink: (href: string) => ipcRenderer.invoke('web-link:open', href),
  archiveMemory: (id: string, reason?: string) => ipcRenderer.invoke('db:archiveMemory', id, reason),
  restoreMemory: (id: string) => ipcRenderer.invoke('db:restoreMemory', id),
  getProjects: (opts?: unknown) => ipcRenderer.invoke('db:getProjects', opts),
  getStats: (opts?: unknown) => ipcRenderer.invoke('db:getStats', opts),
  getUsageStats: (opts?: UsageStatsOptions) => ipcRenderer.invoke('db:getUsageStats', opts),
  onIndexUpdated: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('trajex:index-updated', listener);
    return () => ipcRenderer.removeListener('trajex:index-updated', listener);
  },
  onSessionUpdated: (callback: (payload: unknown) => void) => {
    const listener = (_: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('trajex:session-updated', listener);
    return () => ipcRenderer.removeListener('trajex:session-updated', listener);
  },
  getLocations: () => ipcRenderer.invoke('locations:list'),
  onRemotesUpdated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('trajex:remotes-updated', listener);
    return () => ipcRenderer.removeListener('trajex:remotes-updated', listener);
  },
  onRemoteIndexProgress: (callback: (payload: RemoteIndexProgressPayload) => void) => {
    const listener = (_: IpcRendererEvent, payload: RemoteIndexProgressPayload) => callback(payload);
    ipcRenderer.on('trajex:remote-index-progress', listener);
    return () => ipcRenderer.removeListener('trajex:remote-index-progress', listener);
  },
  addRemote: (input?: { name?: string; providerRoots?: RemoteProviderRootsConfig }) => ipcRenderer.invoke('remotes:add', input),
  updateRemote: (id: string, patch: { name?: string; providerRoots?: RemoteProviderRootsConfig }) => ipcRenderer.invoke('remotes:update', id, patch),
  removeRemote: (id: string) => ipcRenderer.invoke('remotes:remove', id),
  refreshRemote: (id: string) => ipcRenderer.invoke('remotes:refresh', id),
  rebuildRemote: (id: string) => ipcRenderer.invoke('remotes:rebuild', id),
  pickRemoteHome: () => ipcRenderer.invoke('remotes:pickHome'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  browseFolder: () => ipcRenderer.invoke('settings:browseFolder'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
  revealPath: (p: string) => ipcRenderer.invoke('settings:revealPath', p),
  rebuildIndex: () => ipcRenderer.invoke('settings:rebuildIndex'),
});
