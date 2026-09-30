// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

const FALLBACK_COLOR = '#8b8b93';

// Used until the runtime provider catalog (settings:get) has loaded; same values as the
// built-in provider descriptors, so list rows never flash grey / a bare id.
const BUILTIN_PRESENTATION = {
  claude: { name: 'Claude Code', color: '#d97757' },
  codex: { name: 'Codex', color: '#10a37f' },
  pi: { name: 'Pi', color: '#7c3aed' },
};

function sourceId(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || 'claude';
}

function descriptorFor(source, catalog = []) {
  const id = sourceId(source);
  return catalog.find(candidate => candidate?.id === id) || null;
}

function titleCaseId(id) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function sourceLabel(source, catalog = []) {
  const id = sourceId(source);
  return descriptorFor(id, catalog)?.name || BUILTIN_PRESENTATION[id]?.name || titleCaseId(id);
}

export function sourceColor(source, catalog = []) {
  return descriptorFor(source, catalog)?.color || BUILTIN_PRESENTATION[sourceId(source)]?.color || FALLBACK_COLOR;
}
