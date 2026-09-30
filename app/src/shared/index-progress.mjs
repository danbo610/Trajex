// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Pure formatting helpers for index progress. Shared by the main process
// (log lines) and the renderer (Settings / sidebar), so they must stay free of
// Node and Electron imports.

// @ts-check

const PROVIDER_LABELS = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };

/** @param {string | null | undefined} provider */
export function providerLabel(provider) {
  if (!provider) return '';
  return PROVIDER_LABELS[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** 65000 -> "1m 05s", 3700000 -> "1h 01m", 4200 -> "4s". */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * One-line status for a running build, e.g.
 * "Indexing… 123 / 870 files (Claude), 2m 05s".
 * @param {{ phase?: string, done?: number, total?: number, provider?: string | null, startedAt?: number } | null | undefined} progress
 * @param {number} [now]
 */
export function describeProgress(progress, now = Date.now()) {
  if (!progress) return '';
  const elapsed = progress.startedAt ? `, ${formatElapsed(now - progress.startedAt)}` : '';
  const provider = providerLabel(progress.provider);
  const suffix = provider ? ` (${provider})` : '';
  if (progress.phase === 'finalizing') return `Finalizing index…${elapsed.replace(/^,/, '')}`;
  if (progress.phase === 'indexing') {
    return `Indexing… ${progress.done ?? 0} / ${progress.total ?? 0} files${suffix}${elapsed}`;
  }
  return `Scanning directories…${suffix}${elapsed}`;
}

/** 0..1 while indexing; null when the total is not known yet (indeterminate bar). */
export function progressFraction(progress) {
  if (!progress) return null;
  if (progress.phase === 'finalizing') return 1;
  if (progress.phase !== 'indexing' || !progress.total) return null;
  return Math.min(1, Math.max(0, (progress.done || 0) / progress.total));
}

/** Short sidebar label: "42%" while indexing, "…" otherwise. */
export function shortProgress(progress) {
  const fraction = progressFraction(progress);
  if (fraction === null) return '…';
  if (progress && progress.phase === 'finalizing') return '…';
  return `${Math.floor(fraction * 100)}%`;
}

/** True when a running build has not reported anything for `thresholdMs`. */
export function isStalled(progress, now = Date.now(), thresholdMs = 60000) {
  if (!progress || typeof progress.updatedAt !== 'number') return false;
  return now - progress.updatedAt >= thresholdMs;
}
