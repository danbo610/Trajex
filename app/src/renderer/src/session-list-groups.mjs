// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Splits the already filtered + sorted Sessions list into the main list and the
// folded "quiet" (untitled) group. With `showUntitled` on nothing is folded: every
// session stays in one list, in the order it was given (time order).

export function isUntitledSession(session) {
  return !session?.title;
}

export function groupSessions(sessions, { showUntitled = false } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (showUntitled) return { normal: list, noise: [] };
  const normal = [];
  const noise = [];
  for (const session of list) {
    if (isUntitledSession(session)) noise.push(session);
    else normal.push(session);
  }
  return { normal, noise };
}
