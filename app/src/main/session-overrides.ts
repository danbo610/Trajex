// Copyright (C) 2026 tommy0103 and contributors.
// Copyright (C) 2026 wutongyuonce and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Session overrides: user-chosen display titles and soft "hide" flags.
 *
 * They live ONLY in Trajex's own index database of a location
 * (`session_overrides`, see schema.sql); transcript files are never touched.
 * The table is durable like `memories`: force-rebuild cleanup statements do not
 * delete from it and the temp-DB rebuild copies it over (copyOverridesFromDb).
 * Session ids are the primary key of `sessions` inside one location DB, so the
 * overrides key (session_id) cannot collide across providers of that DB.
 *
 * All helpers take a better-sqlite3-like handle and degrade to "no overrides"
 * when the table is unavailable (old schema blocked by another writer, fakes).
 */

export const MAX_CUSTOM_TITLE_LENGTH = 200;

type Db = {
  exec?: (sql: string) => unknown;
  prepare: (sql: string) => { get: (...a: any[]) => any; all: (...a: any[]) => any[]; run: (...a: any[]) => any };
};

const available = new WeakSet<object>();

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS session_overrides (
  session_id TEXT PRIMARY KEY,
  custom_title TEXT,
  hidden_at INTEGER,
  updated_at INTEGER)`;

/** Idempotently makes sure the table exists on this handle; false when it cannot. */
export function sessionOverridesAvailable(db: Db | null | undefined): boolean {
  if (!db || typeof db.prepare !== 'function') return false;
  if (available.has(db)) return true;
  try {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_overrides'").get();
    if (!exists) {
      if (typeof db.exec !== 'function') return false;
      db.exec(CREATE_SQL);
    }
    available.add(db);
    return true;
  } catch {
    return false;
  }
}

export type HiddenMode = 'exclude' | 'only' | 'all';

export function normalizeHiddenMode(value: unknown): HiddenMode {
  return value === 'only' || value === 'all' ? value : 'exclude';
}

/**
 * SELECT + FROM (+ WHERE fragments) for session rows with overrides applied.
 * `title` is the effective title (custom or original); `original_title`,
 * `renamed` and `hidden_at` describe the override. Rows are aliased `s`.
 */
export function sessionRowsQuery(db: Db, columns: readonly string[], hidden: HiddenMode = 'exclude') {
  if (!sessionOverridesAvailable(db)) {
    return {
      select: `SELECT ${columns.map((c) => `s.${c}`).join(', ')} FROM sessions s`,
      conditions: hidden === 'only' ? ['0'] : [] as string[],
    };
  }
  const list = columns.map((column) => (
    column === 'title' ? "COALESCE(NULLIF(o.custom_title, ''), s.title) AS title" : `s.${column}`
  ));
  list.push('s.title AS original_title');
  list.push("(o.custom_title IS NOT NULL AND o.custom_title != '') AS renamed");
  list.push('o.hidden_at AS hidden_at');
  const conditions: string[] = [];
  if (hidden === 'exclude') conditions.push('o.hidden_at IS NULL');
  if (hidden === 'only') conditions.push('o.hidden_at IS NOT NULL');
  return {
    select: `SELECT ${list.join(', ')} FROM sessions s LEFT JOIN session_overrides o ON o.session_id = s.id`,
    conditions,
  };
}

/** SQL fragment excluding hidden sessions for `alias.id` ('' when overrides are unavailable). */
export function notHiddenCondition(db: Db, alias = 's'): string {
  if (!sessionOverridesAvailable(db)) return '';
  return `NOT EXISTS (SELECT 1 FROM session_overrides h WHERE h.session_id = ${alias}.id AND h.hidden_at IS NOT NULL)`;
}

export interface SessionOverride {
  sessionId: string;
  title: string | null;
  customTitle: string | null;
  hidden: boolean;
}

export function cleanCustomTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_TITLE_LENGTH);
  return title || null;
}

/**
 * Upsert one override. `title: undefined` leaves the title alone, `null`/'' clears it;
 * `hidden: undefined` leaves the flag alone. A row with neither title nor hidden is removed.
 */
export function setSessionOverride(
  db: Db,
  sessionId: string,
  patch: { title?: unknown; hidden?: boolean },
  now: number = Date.now(),
): SessionOverride {
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
  if (!sessionOverridesAvailable(db)) throw new Error('Session overrides are unavailable (index schema is being upgraded); try again shortly');
  const session = db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found in this location');
  const current = db.prepare('SELECT custom_title, hidden_at FROM session_overrides WHERE session_id = ?').get(sessionId);
  const customTitle = patch.title === undefined ? (current?.custom_title ?? null) : cleanCustomTitle(patch.title);
  const hiddenAt = patch.hidden === undefined ? (current?.hidden_at ?? null) : (patch.hidden ? (current?.hidden_at ?? now) : null);
  if (customTitle === null && hiddenAt === null) {
    db.prepare('DELETE FROM session_overrides WHERE session_id = ?').run(sessionId);
  } else {
    db.prepare(`
      INSERT INTO session_overrides (session_id, custom_title, hidden_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET custom_title = excluded.custom_title,
        hidden_at = excluded.hidden_at, updated_at = excluded.updated_at
    `).run(sessionId, customTitle, hiddenAt, now);
  }
  return {
    sessionId,
    customTitle,
    title: customTitle ?? (session.title ?? null),
    hidden: hiddenAt !== null,
  };
}

/** Rebuild into a fresh DB: carry the overrides over from the previous DB file. */
export function copyOverridesFromDb(db: Db & { exec: (sql: string) => unknown }, sourceDbPath: string | null | undefined, existsSync: (p: string) => boolean): boolean {
  if (!sourceDbPath || !existsSync(sourceDbPath)) return false;
  if (!sessionOverridesAvailable(db)) return false;
  db.prepare('ATTACH DATABASE ? AS previous_overrides').run(sourceDbPath);
  try {
    const has = db.prepare("SELECT name FROM previous_overrides.sqlite_master WHERE type='table' AND name='session_overrides'").get();
    if (!has) return false;
    db.exec(`
      INSERT OR REPLACE INTO session_overrides (session_id, custom_title, hidden_at, updated_at)
      SELECT session_id, custom_title, hidden_at, updated_at FROM previous_overrides.session_overrides
    `);
    return true;
  } finally {
    db.exec('DETACH DATABASE previous_overrides');
  }
}
