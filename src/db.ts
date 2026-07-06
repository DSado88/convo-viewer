import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  jsonl_path?: string | null;
  title?: string | null;
  project?: string | null;
  /** Which machine's logs this session came from (e.g. "mbp", "studio"). */
  source_machine?: string | null;
  /** Conversation format / agent that produced the log ("claude" | "codex"). */
  format?: string | null;
  model?: string | null;
  start_time?: number | null;
  turn_count?: number | null;
  imported_at?: number | null;
  last_modified?: number | null;
  file_size?: number | null;
  hidden?: number | null;
  summary?: string | null;
  summary_source_mtime?: number | null;
  summary_status?: string | null;
  summary_error?: string | null;
}

export interface AnnotationRecord {
  id: string;
  session_id: string;
  turn_index: number;
  block_index?: number;
  char_start: number;
  char_end: number;
  text: string;
  comment?: string;
  kind?: string;
  speaker?: string | null;
  /** Re-anchor context: text immediately before/after the highlight. */
  prefix?: string;
  suffix?: string;
  /** The prompt that triggered the highlighted response. */
  trigger?: string;
  created_at?: number;
  updated_at?: number;
}

export interface AnnotationWithTags extends AnnotationRecord {
  tags: string[];
  session_title?: string | null;
  session_project?: string | null;
}

export interface TagRecord {
  id: number;
  name: string;
  color: string | null;
}

export interface TagWithCount extends TagRecord {
  count: number;
}

/** Shape of an annotation in the sidecar `.annotations.json` files. */
export interface SidecarAnnotation {
  id: string;
  turnIndex: number;
  blockIndex?: number;
  charStart: number;
  charEnd: number;
  text: string;
  comment?: string;
  kind?: string;
  speaker?: string;
  role?: string;
  prefix?: string;
  suffix?: string;
  trigger?: string;
  tags?: string[];
  timestamp?: number;
  created?: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  jsonl_path TEXT,
  title TEXT,
  project TEXT,
  source_machine TEXT,
  format TEXT,
  model TEXT,
  start_time INTEGER,
  turn_count INTEGER,
  imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_modified INTEGER,
  file_size INTEGER
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER NOT NULL,
  block_index INTEGER NOT NULL DEFAULT 0,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  comment TEXT DEFAULT '',
  kind TEXT DEFAULT 'highlight',
  speaker TEXT,
  prefix TEXT DEFAULT '',
  suffix TEXT DEFAULT '',
  "trigger" TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS annotation_tags (
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (annotation_id, tag_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  text, comment, content=annotations, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS annotations_ai AFTER INSERT ON annotations BEGIN
  INSERT INTO annotations_fts(rowid, text, comment) VALUES (new.rowid, new.text, new.comment);
END;

CREATE TRIGGER IF NOT EXISTS annotations_ad AFTER DELETE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, text, comment) VALUES('delete', old.rowid, old.text, old.comment);
END;

CREATE TRIGGER IF NOT EXISTS annotations_au AFTER UPDATE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, text, comment) VALUES('delete', old.rowid, old.text, old.comment);
  INSERT INTO annotations_fts(rowid, text, comment) VALUES (new.rowid, new.text, new.comment);
END;

-- Full-conversation FTS: contentless index (inverted index only, no text stored)
CREATE TABLE IF NOT EXISTS fts_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fts_map_session ON fts_map(session_id);

CREATE TABLE IF NOT EXISTS fts_status (
  session_id TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  turn_count INTEGER NOT NULL DEFAULT 0,
  file_mtime INTEGER NOT NULL DEFAULT 0,
  file_mtime_ms INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  text,
  content='',
  contentless_delete=1,
  content_rowid='id'
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_annotations_session ON annotations(session_id);
CREATE INDEX IF NOT EXISTS idx_annotation_tags_tag_id ON annotation_tags(tag_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Embedding vectors stored as BLOBs (256 x float32 = 1024 bytes each)
CREATE TABLE IF NOT EXISTS turn_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  text_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_turn_emb_session ON turn_embeddings(session_id);

-- Track embedding indexing status per session (mirrors fts_status pattern)
CREATE TABLE IF NOT EXISTS embedding_status (
  session_id TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  turn_count INTEGER NOT NULL DEFAULT 0,
  file_mtime INTEGER NOT NULL DEFAULT 0,
  file_mtime_ms INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  model_name TEXT NOT NULL DEFAULT 'snowflake-arctic-embed-m-v2.0'
);
`;

// ---------------------------------------------------------------------------
// Default path helper
// ---------------------------------------------------------------------------

function defaultDbPath(): string {
  return process.env.CONVO_DB_PATH ?? path.join(os.homedir(), ".convo", "db.sqlite");
}

// ---------------------------------------------------------------------------
// ConvoDb class
// ---------------------------------------------------------------------------

export class ConvoDb {
  readonly db: Database;
  /** On-disk DB path; undefined for in-memory/test handles without journaling. */
  readonly dbPath?: string;

  constructor(db: Database, dbPath?: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** Directory for annotation write journals (sibling of the DB file). */
  private get backupsDir(): string | null {
    if (!this.dbPath || this.dbPath === ":memory:") return null;
    return path.join(path.dirname(this.dbPath), "backups");
  }

  /** Pending journal events while a transaction is open (null = no txn).
   *  The journal must only record COMMITTED writes — appending mid-transaction
   *  would leave phantom entries if the transaction rolls back. */
  private journalBuffer: Array<Record<string, unknown>> | null = null;

  /**
   * Append an event to the daily annotation journal. Best-effort: a failed
   * journal write must never fail the DB write it records. Inside a
   * transaction, events buffer until commit (dropped on rollback).
   */
  private journalAnnotation(event: Record<string, unknown>): void {
    if (this.journalBuffer !== null) {
      this.journalBuffer.push(event);
      return;
    }
    const dir = this.backupsDir;
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(
        path.join(dir, `annotations-${day}.jsonl`),
        JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
      );
    } catch {
      // best-effort
    }
  }

  /** Run a function inside a BEGIN/COMMIT transaction. Journal events are
   *  buffered during the transaction and flushed only after COMMIT. */
  transaction(fn: () => void): void {
    const isOuter = this.journalBuffer === null;
    if (isOuter) this.journalBuffer = [];
    try {
      this.db.transaction(fn)();
    } catch (e) {
      if (isOuter) this.journalBuffer = null; // rolled back — drop events
      throw e;
    }
    if (isOuter) {
      const events = this.journalBuffer;
      this.journalBuffer = null;
      for (const event of events) this.journalAnnotation(event);
    }
  }

  // ---- Sessions -----------------------------------------------------------

  upsertSession(session: SessionRecord): void {
    this.db.run(
      `INSERT INTO sessions (id, jsonl_path, title, project, source_machine, format, model, start_time, turn_count, imported_at, last_modified, file_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, unixepoch()), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         jsonl_path     = coalesce(excluded.jsonl_path, jsonl_path),
         title          = coalesce(excluded.title, title),
         project        = coalesce(excluded.project, project),
         source_machine = coalesce(excluded.source_machine, source_machine),
         format         = coalesce(excluded.format, format),
         model          = coalesce(excluded.model, model),
         start_time     = coalesce(excluded.start_time, start_time),
         turn_count     = coalesce(excluded.turn_count, turn_count),
         last_modified  = coalesce(excluded.last_modified, last_modified),
         file_size      = coalesce(excluded.file_size, file_size)`,
      [
        session.id,
        session.jsonl_path ?? null,
        session.title ?? null,
        session.project ?? null,
        session.source_machine ?? null,
        session.format ?? null,
        session.model ?? null,
        session.start_time ?? null,
        session.turn_count ?? null,
        session.imported_at ?? null,
        session.last_modified ?? null,
        session.file_size ?? null,
      ],
    );
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | null;
    return row ?? null;
  }

  /** Mark summary as generating (prevents duplicate spawns at DB level). */
  setSummaryGenerating(id: string): void {
    this.db.run(
      "UPDATE sessions SET summary_status = 'generating', summary_error = NULL WHERE id = ?",
      [id],
    );
  }

  /** Store a completed summary with the source file mtime for freshness checking. */
  setSummaryDone(id: string, summary: string, sourceMtime: number): void {
    this.db.run(
      "UPDATE sessions SET summary = ?, summary_source_mtime = ?, summary_status = 'done', summary_error = NULL WHERE id = ?",
      [summary, sourceMtime, id],
    );
  }

  /** Store a summary error. */
  setSummaryError(id: string, error: string): void {
    this.db.run(
      "UPDATE sessions SET summary_status = 'error', summary_error = ? WHERE id = ?",
      [error, id],
    );
  }

  /** Clear summary when source file has changed. */
  clearSummary(id: string): void {
    this.db.run(
      "UPDATE sessions SET summary = NULL, summary_source_mtime = NULL, summary_status = 'idle', summary_error = NULL WHERE id = ?",
      [id],
    );
  }

  listSessions(opts?: { project?: string; limit?: number; offset?: number; includeHidden?: boolean }): SessionRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (!opts?.includeHidden) {
      clauses.push("coalesce(hidden, 0) = 0");
    }
    if (opts?.project) {
      clauses.push("project = ?");
      params.push(opts.project);
    }

    let sql = "SELECT * FROM sessions";
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY coalesce(last_modified, imported_at) DESC";

    if (opts?.limit != null) {
      sql += " LIMIT ?";
      params.push(opts.limit);
      if (opts?.offset) {
        sql += " OFFSET ?";
        params.push(opts.offset);
      }
    }

    return this.db.query(sql).all(...params) as SessionRecord[];
  }

  // ---- Annotations -------------------------------------------------------

  upsertAnnotation(ann: AnnotationRecord): void {
    this.db.run(
      `INSERT INTO annotations (id, session_id, turn_index, block_index, char_start, char_end, text, comment, kind, speaker, prefix, suffix, "trigger", created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, unixepoch()), coalesce(?, unixepoch()))
       ON CONFLICT(id) DO UPDATE SET
         turn_index  = excluded.turn_index,
         block_index = excluded.block_index,
         char_start  = excluded.char_start,
         char_end    = excluded.char_end,
         text        = excluded.text,
         comment     = excluded.comment,
         kind        = excluded.kind,
         speaker     = excluded.speaker,
         prefix      = excluded.prefix,
         suffix      = excluded.suffix,
         "trigger"   = excluded."trigger",
         updated_at  = unixepoch()`,
      [
        ann.id,
        ann.session_id,
        ann.turn_index,
        ann.block_index ?? 0,
        ann.char_start,
        ann.char_end,
        ann.text,
        ann.comment ?? "",
        ann.kind ?? "highlight",
        ann.speaker ?? null,
        ann.prefix ?? "",
        ann.suffix ?? "",
        ann.trigger ?? "",
        ann.created_at ?? null,
        ann.updated_at ?? null,
      ],
    );
    this.journalAnnotation({ op: "upsert", annotation: ann });
  }

  deleteAnnotation(id: string): void {
    const row = this.db.query("SELECT session_id FROM annotations WHERE id = ?").get(id) as { session_id: string } | null;
    this.db.run("DELETE FROM annotations WHERE id = ?", [id]);
    if (row) {
      this.journalAnnotation({ op: "delete", id, session_id: row.session_id });
    }
  }

  getAnnotation(id: string): AnnotationWithTags | null {
    const row = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.id = ?`,
      )
      .get(id) as (AnnotationRecord & { session_title: string | null; session_project: string | null }) | null;
    if (!row) return null;
    return { ...row, tags: this._getTagsForAnnotation(id) };
  }

  getSessionAnnotations(sessionId: string): AnnotationWithTags[] {
    const rows = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.session_id = ?
         ORDER BY a.turn_index, a.block_index, a.char_start`,
      )
      .all(sessionId) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Tags ---------------------------------------------------------------

  addTag(annotationId: string, tagName: string, color?: string): void {
    // Ensure the tag exists
    this.db.run(
      `INSERT INTO tags (name, color) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET color = coalesce(excluded.color, color)`,
      [tagName, color ?? null],
    );

    const tag = this.db.query("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number } | null;
    if (!tag) return;

    this.db.run(
      `INSERT OR IGNORE INTO annotation_tags (annotation_id, tag_id) VALUES (?, ?)`,
      [annotationId, tag.id],
    );
  }

  removeTag(annotationId: string, tagName: string): void {
    const tag = this.db.query("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number } | null;
    if (!tag) return;
    this.db.run("DELETE FROM annotation_tags WHERE annotation_id = ? AND tag_id = ?", [annotationId, tag.id]);
  }

  listTags(): TagWithCount[] {
    return this.db
      .query(
        `SELECT t.*, count(at.annotation_id) AS count
         FROM tags t
         LEFT JOIN annotation_tags at ON at.tag_id = t.id
         GROUP BY t.id
         HAVING count > 0
         ORDER BY count DESC, t.name`,
      )
      .all() as TagWithCount[];
  }

  getAnnotationsByTag(tagName: string, opts?: { limit?: number }): AnnotationWithTags[] {
    let sql = `
      SELECT a.*, s.title AS session_title, s.project AS session_project
      FROM annotations a
      LEFT JOIN sessions s ON s.id = a.session_id
      INNER JOIN annotation_tags at ON at.annotation_id = a.id
      INNER JOIN tags t ON t.id = at.tag_id
      WHERE t.name = ?
      ORDER BY a.created_at DESC`;
    const params: SQLQueryBindings[] = [tagName];

    if (opts?.limit != null) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.query(sql).all(...params) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Search -------------------------------------------------------------

  /** Sanitize a query string for FTS5 MATCH — strips operators and special chars. */
  private sanitizeFtsQuery(query: string): string {
    return query
      .replace(/[^a-zA-Z0-9_\s]/g, " ")  // keep only alphanumeric, underscore, whitespace
      .split(/\s+/)
      .filter((t) => t.length > 0 && !/^(AND|OR|NOT|NEAR)$/i.test(t))
      .join(" ")
      .trim();
  }

  searchAnnotations(
    query: string,
    opts?: { tags?: string[]; sessionId?: string; speaker?: string; limit?: number },
  ): AnnotationWithTags[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    // FTS match — sanitize special chars to prevent FTS5 syntax errors.
    // Trim first so whitespace-only queries are treated as "no query" (not "empty match").
    const trimmedQuery = query.trim();
    if (trimmedQuery) {
      const safeQuery = this.sanitizeFtsQuery(trimmedQuery);
      if (safeQuery) {
        clauses.push("a.rowid IN (SELECT rowid FROM annotations_fts WHERE annotations_fts MATCH ?)");
        params.push(safeQuery);
      } else {
        // Query was provided but sanitized to empty (all operators/special chars).
        // Return no results rather than returning everything unfiltered.
        return [];
      }
    }

    if (opts?.sessionId) {
      clauses.push("a.session_id = ?");
      params.push(opts.sessionId);
    }

    if (opts?.speaker) {
      clauses.push("a.speaker = ?");
      params.push(opts.speaker);
    }

    if (opts?.tags?.length) {
      clauses.push(
        `a.id IN (
          SELECT at.annotation_id FROM annotation_tags at
          INNER JOIN tags t ON t.id = at.tag_id
          WHERE t.name IN (${opts.tags.map(() => "?").join(",")})
        )`,
      );
      params.push(...opts.tags);
    }

    let sql = `
      SELECT a.*, s.title AS session_title, s.project AS session_project
      FROM annotations a
      LEFT JOIN sessions s ON s.id = a.session_id`;
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY a.created_at DESC";

    if (opts?.limit != null) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.query(sql).all(...params) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Recent -------------------------------------------------------------

  getRecentAnnotations(opts?: { days?: number; limit?: number }): AnnotationWithTags[] {
    const days = opts?.days ?? 7;
    const limit = opts?.limit ?? 50;
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

    const rows = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         WHERE a.created_at >= ?
         ORDER BY a.created_at DESC
         LIMIT ?`,
      )
      .all(cutoff, limit) as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Batch tag replacement -----------------------------------------------

  replaceAnnotationTags(annotationId: string, tags: string[]): void {
    this.transaction(() => {
      // Remove all existing tags for this annotation
      this.db.run("DELETE FROM annotation_tags WHERE annotation_id = ?", [annotationId]);
      // Add new tags
      for (const tagName of tags) {
        this.addTag(annotationId, tagName);
      }
    });
  }

  // ---- Client-ready annotation export ------------------------------------

  getAnnotationForClient(id: string): (AnnotationWithTags & { turnId?: string }) | null {
    const ann = this.getAnnotation(id);
    if (!ann) return null;
    return { ...ann, turnId: `turn-${ann.turn_index}` };
  }

  // ---- Path-based lookup -------------------------------------------------

  getSessionByPath(jsonlPath: string): SessionRecord | null {
    const row = this.db.query("SELECT * FROM sessions WHERE jsonl_path = ?").get(jsonlPath) as SessionRecord | null;
    return row ?? null;
  }

  // ---- Import / Export ----------------------------------------------------

  importAnnotationsJson(
    sessionId: string,
    annotations: SidecarAnnotation[],
  ): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    this.transaction(() => {
      for (const ann of annotations) {
        // Skip if already exists
        const existing = this.db.query("SELECT id FROM annotations WHERE id = ?").get(ann.id);
        if (existing) {
          skipped++;
          continue;
        }

        const rawTs = ann.timestamp ?? ann.created;
        const createdAt = rawTs != null ? Math.floor(rawTs / 1000) : null;

        this.upsertAnnotation({
          id: ann.id,
          session_id: sessionId,
          turn_index: ann.turnIndex,
          block_index: ann.blockIndex ?? 0,
          char_start: ann.charStart,
          char_end: ann.charEnd,
          text: ann.text,
          comment: ann.comment ?? "",
          kind: ann.kind ?? "highlight",
          speaker: ann.speaker ?? ann.role ?? null,
          prefix: ann.prefix ?? "",
          suffix: ann.suffix ?? "",
          trigger: ann.trigger ?? "",
          created_at: createdAt ?? undefined,
          updated_at: createdAt ?? undefined,
        });

        if (ann.tags?.length) {
          for (const tagName of ann.tags) {
            if (typeof tagName === "string" && tagName) {
              this.addTag(ann.id, tagName);
            }
          }
        }

        imported++;
      }
    });

    return { imported, skipped };
  }

  exportSessionAnnotations(sessionId: string): SidecarAnnotation[] {
    const annotations = this.getSessionAnnotations(sessionId);
    return annotations.map((a) => ({
      id: a.id,
      turnIndex: a.turn_index,
      blockIndex: a.block_index ?? 0,
      charStart: a.char_start,
      charEnd: a.char_end,
      text: a.text,
      comment: a.comment ?? "",
      kind: a.kind ?? "highlight",
      speaker: a.speaker ?? undefined,
      role: a.speaker ?? undefined,
      prefix: a.prefix ?? "",
      suffix: a.suffix ?? "",
      trigger: a.trigger ?? "",
      tags: a.tags.length ? a.tags : undefined,
      timestamp: a.created_at != null ? a.created_at * 1000 : undefined,
    }));
  }

  /** Export every annotation in the DB (all sessions), tags included. */
  exportAllAnnotations(): AnnotationWithTags[] {
    const rows = this.db
      .query(
        `SELECT a.*, s.title AS session_title, s.project AS session_project
         FROM annotations a
         LEFT JOIN sessions s ON s.id = a.session_id
         ORDER BY a.session_id, a.turn_index, a.block_index, a.char_start`,
      )
      .all() as (AnnotationRecord & { session_title: string | null; session_project: string | null })[];
    return rows.map((r) => ({ ...r, tags: this._getTagsForAnnotation(r.id) }));
  }

  // ---- Full-text search ---------------------------------------------------

  /**
   * Shared freshness check. New rows compare millisecond mtime + file size
   * (any change → reindex, including backdated mtimes from sync tools).
   * Legacy rows (file_mtime_ms = 0) keep the old seconds-only comparison so
   * an upgrade doesn't trigger a mass reindex of every session.
   */
  private statusNeedsIndexing(
    row: { file_mtime: number; file_mtime_ms: number; file_size: number } | null,
    fileMtimeMs: number,
    fileSize: number,
  ): boolean {
    if (!row) return true; // never indexed
    if (row.file_mtime_ms > 0) {
      return fileMtimeMs !== row.file_mtime_ms || fileSize !== row.file_size;
    }
    return Math.floor(fileMtimeMs / 1000) > row.file_mtime;
  }

  /** Check if a session needs (re)indexing based on file mtimeMs + size */
  ftsNeedsIndexing(sessionId: string, fileMtimeMs: number, fileSize = 0): boolean {
    const row = this.db
      .query("SELECT file_mtime, file_mtime_ms, file_size FROM fts_status WHERE session_id = ?")
      .get(sessionId) as { file_mtime: number; file_mtime_ms: number; file_size: number } | null;
    return this.statusNeedsIndexing(row, fileMtimeMs, fileSize);
  }

  /** Index a session's turns into FTS. Replaces any existing index for the session. */
  indexSession(sessionId: string, turns: { role: string; text: string }[], fileMtimeMs: number, fileSize = 0): void {
    const insertMap = this.db.prepare(
      "INSERT INTO fts_map (session_id, turn_index, role) VALUES (?, ?, ?)",
    );
    const insertFts = this.db.prepare(
      "INSERT INTO conversation_fts (rowid, text) VALUES (?, ?)",
    );
    const insertStatus = this.db.prepare(
      "INSERT OR REPLACE INTO fts_status (session_id, indexed_at, turn_count, file_mtime, file_mtime_ms, file_size) VALUES (?, unixepoch(), ?, ?, ?, ?)",
    );

    this.db.exec("BEGIN");
    try {
      // Remove old index inside the transaction so ROLLBACK restores it on failure
      this.removeFtsIndex(sessionId);
      for (let i = 0; i < turns.length; i++) {
        const text = turns[i].text.trim();
        if (!text) continue;
        const { lastInsertRowid } = insertMap.run(sessionId, i, turns[i].role);
        insertFts.run(lastInsertRowid, text);
      }
      insertStatus.run(sessionId, turns.length, Math.floor(fileMtimeMs / 1000), fileMtimeMs, fileSize);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Remove FTS index for a session */
  removeFtsIndex(sessionId: string): void {
    const rows = this.db.query("SELECT id FROM fts_map WHERE session_id = ?").all(sessionId) as { id: number }[];
    if (rows.length > 0) {
      for (const row of rows) {
        this.db.run("DELETE FROM conversation_fts WHERE rowid = ?", [row.id]);
      }
      this.db.run("DELETE FROM fts_map WHERE session_id = ?", [sessionId]);
    }
    this.db.run("DELETE FROM fts_status WHERE session_id = ?", [sessionId]);
  }

  /** Search conversations. Returns matching sessions with turn references. */
  searchConversations(query: string, limit = 50): Array<{
    session_id: string;
    turn_index: number;
    role: string;
    rank: number;
  }> {
    const safeQuery = this.sanitizeFtsQuery(query);
    if (!safeQuery) return [];
    const rows = this.db.query(`
      SELECT m.session_id, m.turn_index, m.role, f.rank
      FROM conversation_fts f
      JOIN fts_map m ON m.id = f.rowid
      WHERE conversation_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `).all(safeQuery, limit) as Array<{
      session_id: string;
      turn_index: number;
      role: string;
      rank: number;
    }>;
    return rows;
  }

  /** Search and group by session, returning top sessions with match counts. */
  searchSessions(query: string, limit = 30): Array<{
    session_id: string;
    match_count: number;
    best_rank: number;
  }> {
    const safeQuery = this.sanitizeFtsQuery(query);
    if (!safeQuery) return [];
    const rows = this.db.query(`
      SELECT m.session_id, COUNT(*) as match_count, MIN(f.rank) as best_rank
      FROM conversation_fts f
      JOIN fts_map m ON m.id = f.rowid
      WHERE conversation_fts MATCH ?
      GROUP BY m.session_id
      ORDER BY best_rank
      LIMIT ?
    `).all(safeQuery, limit) as Array<{
      session_id: string;
      match_count: number;
      best_rank: number;
    }>;
    return rows;
  }

  /** Get count of indexed sessions */
  ftsIndexedCount(): number {
    const row = this.db.query("SELECT COUNT(*) as n FROM fts_status").get() as { n: number };
    return row.n;
  }

  // ---- Settings -----------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  /** Get project path patterns excluded from AI search (glob-style, one per line) */
  getSearchExcludedProjects(): string[] {
    const val = this.getSetting("search_excluded_projects");
    if (!val) return [];
    return val.split("\n").map(s => s.trim()).filter(Boolean);
  }

  /** Set project path patterns excluded from AI search */
  setSearchExcludedProjects(patterns: string[]): void {
    this.setSetting("search_excluded_projects", patterns.join("\n"));
  }

  // ---- Embeddings ---------------------------------------------------------

  /** Check if a session needs embedding (re)indexing based on file mtimeMs + size. */
  embeddingNeedsIndexing(sessionId: string, fileMtimeMs: number, fileSize = 0): boolean {
    const row = this.db
      .query("SELECT file_mtime, file_mtime_ms, file_size FROM embedding_status WHERE session_id = ?")
      .get(sessionId) as { file_mtime: number; file_mtime_ms: number; file_size: number } | null;
    return this.statusNeedsIndexing(row, fileMtimeMs, fileSize);
  }

  /** Store embeddings for a session's turns. Replaces any existing. */
  storeEmbeddings(
    sessionId: string,
    entries: Array<{
      turnIndex: number;
      role: string;
      textHash: string;
      embedding: Float32Array;
    }>,
    fileMtimeMs: number,
    fileSize = 0,
  ): void {
    this.db.exec("BEGIN");
    try {
      // Remove old embeddings for this session
      this.db.run("DELETE FROM turn_embeddings WHERE session_id = ?", [sessionId]);

      const insert = this.db.prepare(
        "INSERT INTO turn_embeddings (session_id, turn_index, role, text_hash, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        const blob = Buffer.from(entry.embedding.buffer, entry.embedding.byteOffset, entry.embedding.byteLength);
        insert.run(sessionId, entry.turnIndex, entry.role, entry.textHash, blob);
      }

      this.db.run(
        "INSERT OR REPLACE INTO embedding_status (session_id, indexed_at, turn_count, file_mtime, file_mtime_ms, file_size) VALUES (?, unixepoch(), ?, ?, ?, ?)",
        [sessionId, entries.length, Math.floor(fileMtimeMs / 1000), fileMtimeMs, fileSize],
      );

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Remove all embeddings for a session. */
  removeEmbeddings(sessionId: string): void {
    this.db.run("DELETE FROM turn_embeddings WHERE session_id = ?", [sessionId]);
    this.db.run("DELETE FROM embedding_status WHERE session_id = ?", [sessionId]);
  }

  /** Load all embeddings into memory. Returns arrays for VectorIndex construction. */
  loadAllEmbeddings(): {
    sessionIds: string[];
    turnIndices: number[];
    roles: string[];
    embeddings: Float32Array[];
  } {
    const rows = this.db.query(
      "SELECT session_id, turn_index, role, embedding FROM turn_embeddings ORDER BY session_id, turn_index",
    ).all() as Array<{
      session_id: string;
      turn_index: number;
      role: string;
      embedding: Buffer;
    }>;

    const sessionIds: string[] = [];
    const turnIndices: number[] = [];
    const roles: string[] = [];
    const embeddings: Float32Array[] = [];

    const EXPECTED_BLOB_SIZE = 256 * 4; // 256 dims × 4 bytes per float32
    for (const row of rows) {
      const buf = row.embedding;
      if (buf.byteLength !== EXPECTED_BLOB_SIZE) {
        console.warn(`[db] Skipping corrupt embedding: session=${row.session_id} turn=${row.turn_index} (${buf.byteLength} bytes, expected ${EXPECTED_BLOB_SIZE})`);
        continue;
      }
      sessionIds.push(row.session_id);
      turnIndices.push(row.turn_index);
      roles.push(row.role);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      embeddings.push(new Float32Array(ab));
    }

    return { sessionIds, turnIndices, roles, embeddings };
  }

  /** Get count of sessions with embeddings. */
  embeddingIndexedCount(): number {
    const row = this.db.query("SELECT COUNT(*) as n FROM embedding_status").get() as { n: number };
    return row.n;
  }

  // ---- Lifecycle ----------------------------------------------------------

  /**
   * Snapshot the live database to a new file using VACUUM INTO — safe while
   * the server is writing (unlike a raw file copy, which can tear WAL state).
   */
  backupTo(destPath: string): void {
    if (fs.existsSync(destPath)) {
      throw new Error(`Backup destination already exists: ${destPath}`);
    }
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Parameter binding is not allowed for VACUUM INTO; escape single quotes
    this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.db.close();
  }

  // ---- Internal helpers ---------------------------------------------------

  private _getTagsForAnnotation(annotationId: string): string[] {
    const rows = this.db
      .query(
        `SELECT t.name FROM tags t
         INNER JOIN annotation_tags at ON at.tag_id = t.id
         WHERE at.annotation_id = ?
         ORDER BY t.name`,
      )
      .all(annotationId) as { name: string }[];
    return rows.map((r) => r.name);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function openDb(dbPath?: string): ConvoDb {
  const resolvedPath = dbPath ?? defaultDbPath();

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode and foreign keys; wait on locks instead of failing
  // immediately (long-running server + CLI tools share this file)
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  // Run schema migration
  db.exec(SCHEMA_SQL);

  // Add columns that may not exist in older databases
  try { db.exec("ALTER TABLE sessions ADD COLUMN last_modified INTEGER"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN file_size INTEGER"); } catch {}
  try { db.exec("ALTER TABLE fts_status ADD COLUMN file_mtime INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE fts_status ADD COLUMN file_mtime_ms INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE fts_status ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE embedding_status ADD COLUMN file_mtime_ms INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE embedding_status ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN summary_source_mtime INTEGER"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN summary_status TEXT DEFAULT 'idle'"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN summary_error TEXT"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN source_machine TEXT"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN format TEXT"); } catch {}
  try { db.exec("ALTER TABLE annotations ADD COLUMN prefix TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE annotations ADD COLUMN suffix TEXT DEFAULT ''"); } catch {}
  try { db.exec(`ALTER TABLE annotations ADD COLUMN "trigger" TEXT DEFAULT ''`); } catch {}

  // Migrate FTS to contentless_delete=1 if needed (fixes ghost entry bug)
  try {
    const ftsInfo = db.query("SELECT sql FROM sqlite_master WHERE name = 'conversation_fts'").get() as { sql: string } | null;
    if (ftsInfo?.sql && !ftsInfo.sql.includes("contentless_delete")) {
      db.exec("DROP TABLE IF EXISTS conversation_fts");
      db.exec("CREATE VIRTUAL TABLE conversation_fts USING fts5(text, content='', contentless_delete=1, content_rowid='id')");
      db.exec("DELETE FROM fts_status"); // Force re-index on next backfill
    }
  } catch {}

  return new ConvoDb(db, resolvedPath);
}
