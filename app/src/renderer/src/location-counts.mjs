// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Sidebar "Location" counts. The number next to a location is the session count of
// that location's index (from `locations:list`), never the length of the list that
// happens to be loaded for the active location: switching location clears the
// loaded list, which used to make the active entry flash 0 until the reload ended.

/**
 * Merge a fresh `locations:list` into the previous one. While a remote is
 * (re)building its index, the main process may momentarily report 0 sessions
 * (database being swapped); keep the last known count in that case.
 */
export function mergeLocations(previous, incoming) {
  const before = new Map((previous || []).map(loc => [loc.id, loc]));
  return (incoming || []).map((loc) => {
    const old = before.get(loc.id);
    const count = Number(loc.sessionCount) || 0;
    if (old && count === 0 && loc.status === 'indexing' && Number(old.sessionCount) > 0) {
      return { ...loc, sessionCount: old.sessionCount };
    }
    return { ...loc, sessionCount: count };
  });
}

/** Badge number for a location row; independent of the active location / loaded list. */
export function locationBadgeCount(loc) {
  const count = Number(loc?.sessionCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}
