import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createConversationParser, type ConversationFormat } from "./parser-factory.js";
import { CodexParser } from "./codex-parser.js";
import type { ConvoDb } from "./db.js";

export interface DiscoveredSession {
  id: string;
  path: string;
  projectDir?: string;
  model?: string;
  startTime?: string;
  lastModified: number;
  fileSize: number;
  /** True when the id was parsed from JSONL content (vs. filename fallback). */
  hasParsedSessionId?: boolean;
  /** Which machine's logs this file belongs to (from the scan root). */
  source?: string;
  /** Conversation format of this file's root ("claude" | "codex"). */
  format?: ConversationFormat;
}

export interface ProjectsRoot {
  /** Source label persisted to sessions.source_machine (e.g. "mbp", "studio"). */
  source: string;
  path: string;
  /** Conversation format for files under this root. Defaults to "claude". */
  format: ConversationFormat;
}

/**
 * Resolve the set of scan roots.
 *
 * `GLOSS_PROJECTS_ROOTS="server=/path/a,laptop=/path/b"` defines multiple
 * roots with explicit source labels (a host serving its own logs plus synced
 * trees from other machines). A label may carry a format tag as
 * `label:format=path` (e.g. `codex-studio:codex=/Users/x/.codex/sessions`);
 * the format defaults to "claude" when omitted. Otherwise a single root:
 * GLOSS_PROJECTS_DIR or the default ~/.claude/projects, labeled
 * GLOSS_MACHINE_NAME (default "local").
 */
export function resolveProjectsRoots(
  env: Record<string, string | undefined> = process.env,
): ProjectsRoot[] {
  const spec = env.GLOSS_PROJECTS_ROOTS;
  if (spec) {
    const roots: ProjectsRoot[] = [];
    for (const part of spec.split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const label = part.slice(0, eq).trim();
      const rootPath = part.slice(eq + 1).trim();
      // Optional format tag: "label:format". Source labels don't contain ':',
      // and any ':' in the path sits after '=', so this split is unambiguous.
      const colon = label.indexOf(":");
      const source = colon === -1 ? label : label.slice(0, colon).trim();
      const fmt = colon === -1 ? "" : label.slice(colon + 1).trim();
      const format: ConversationFormat = fmt === "codex" ? "codex" : "claude";
      if (source && rootPath) roots.push({ source, path: rootPath, format });
    }
    // Nested roots break attribution: the outer root's recursive scan finds
    // the inner root's files and tags them with the outer source. Siblings
    // sharing a prefix (/projects vs /projects-mbp) are fine — compare with
    // a trailing separator.
    for (const a of roots) {
      for (const b of roots) {
        if (a === b) continue;
        const outer = a.path.endsWith(path.sep) ? a.path : a.path + path.sep;
        if (b.path.startsWith(outer)) {
          throw new Error(
            `GLOSS_PROJECTS_ROOTS: root "${b.source}" (${b.path}) is nested inside ` +
            `root "${a.source}" (${a.path}) — roots must be disjoint or source ` +
            `attribution would mislabel the inner root's sessions`,
          );
        }
      }
    }
    if (roots.length) return roots;
  }
  return [{
    source: env.GLOSS_MACHINE_NAME || "local",
    path: env.GLOSS_PROJECTS_DIR ?? path.join(os.homedir(), ".claude", "projects"),
    format: "claude",
  }];
}

export interface ScanResult {
  sessions: DiscoveredSession[];
  changedCount: number;  // How many files were new or modified
  /** Every discovered file pre-dedupe (only when collectAll is set). */
  allSessions?: DiscoveredSession[];
}

// ---------------------------------------------------------------------------
// Canonical file ranking
//
// The same sessionId can appear in multiple JSONL files: the main transcript,
// agent-*.jsonl subagent transcripts sharing the parent's id, copies in other
// project dirs, and sessions started from temp cwds (-private-var-folders-*).
// "Newest mtime wins" let agent/temp files silently become a session's
// canonical file, which misanchors annotations keyed by turn/char offsets.
// Rank candidates deterministically instead; mtime only breaks ties.
// ---------------------------------------------------------------------------

export interface JsonlPathClass {
  isAgentFile: boolean;
  isTempPath: boolean;
  isUuidNamed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Encoded project dir name for a session whose cwd was a temp location,
// e.g. "-private-var-folders-6n-..." or "-tmp-scratch". Checked on the
// parent dir segment only — the scan root itself may live under /tmp (tests).
const TEMP_DIR_RE = /^(-private-var-folders|-var-folders|-tmp(-|$)|-private-tmp)/;

export function classifyJsonlPath(filePath: string): JsonlPathClass {
  const stem = path.parse(filePath).name;
  const parentDir = path.basename(path.dirname(filePath));
  return {
    isAgentFile: stem.startsWith("agent-"),
    isTempPath: TEMP_DIR_RE.test(parentDir),
    isUuidNamed: UUID_RE.test(stem),
  };
}

/** Lower rank = better canonical candidate. mtime must only break ties. */
export function canonicalRank(session: DiscoveredSession): number {
  if (session.hasParsedSessionId === false) return 6; // filename fallback only
  const cls = classifyJsonlPath(session.path);
  if (cls.isTempPath) return 5;
  if (cls.isAgentFile) return 4;
  // The main transcript is named after its own session id
  if (path.parse(session.path).name === session.id) return 1;
  return 2;
}

export function chooseCanonicalSession(candidates: DiscoveredSession[]): DiscoveredSession {
  let best = candidates[0];
  let bestRank = canonicalRank(best);
  for (let i = 1; i < candidates.length; i++) {
    const rank = canonicalRank(candidates[i]);
    if (rank < bestRank || (rank === bestRank && candidates[i].lastModified > best.lastModified)) {
      best = candidates[i];
      bestRank = rank;
    }
  }
  return best;
}

/** Cache of previously discovered sessions, keyed by JSONL path.
 *  Keyed on mtime AND size — sync tools (rsync -a, cp -p) preserve mtimes,
 *  so mtime alone misses synced-over content. Mirrors statusNeedsIndexing. */
const discoveryCache = new Map<string, { mtimeMs: number; size: number; session: DiscoveredSession }>();

/** Clear the discovery cache (useful for tests). */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Recursively find all *.jsonl files under a directory,
 * excluding subagents/ directories.
 */
function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Follow symlinks: check the target type via statSync
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(fullPath); // follows symlinks
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue; // dangling symlink — skip
      }
    }
    if (isDir) {
      if (entry.name === "subagents") continue;
      results.push(...findJsonlFiles(fullPath));
    } else if (isFile && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Scan ~/.claude/projects/ for JSONL conversation files.
 * Parses the first ~50 lines of each to extract metadata.
 * Uses an mtime cache to skip redundant 32KB reads for unchanged files.
 */
export function scanProjectsDir(
  projectsDir?: string,
  opts?: { collectAll?: boolean; format?: ConversationFormat },
): ScanResult {
  const format: ConversationFormat = opts?.format ?? "claude";
  const dir = projectsDir
    ?? process.env.GLOSS_PROJECTS_DIR
    ?? path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(dir)) return { sessions: [], changedCount: 0 };

  const jsonlFiles = findJsonlFiles(dir);
  const sessions: DiscoveredSession[] = [];
  const currentPaths = new Set<string>();
  let changedCount = 0;

  for (const filePath of jsonlFiles) {
    try {
      const stat = fs.statSync(filePath);
      currentPaths.add(filePath);

      // Check mtime+size cache: skip the expensive 32KB read + parse if unchanged
      const cached = discoveryCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        sessions.push(cached.session);
        continue;
      }

      // File is new or modified — do the full read + parse
      changedCount++;

      // Read only the first ~32KB for metadata extraction (avoids loading 200MB+ files)
      const fd = fs.openSync(filePath, "r");
      let snippet: string;
      try {
        const buf = Buffer.alloc(Math.min(32768, stat.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        snippet = buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
      // Take first ~50 lines from the snippet
      const lines = snippet.split("\n").slice(0, 50);

      const parser = createConversationParser({ format });
      parser.feedLines(lines);
      const meta = parser.getMetadata();

      // Codex rollouts carry the session id in the filename; recover it when
      // the metadata line falls outside the 32KB window or the file is old.
      let sessionId = meta.sessionId;
      let startTime = meta.startTime;
      if (format === "codex" && (!sessionId || !startTime)) {
        const fallback = CodexParser.fromFilename(path.parse(filePath).name);
        sessionId = sessionId ?? fallback.sessionId ?? null;
        startTime = startTime ?? fallback.startTime ?? null;
      }
      const resolvedId = sessionId ?? path.parse(filePath).name;
      const session: DiscoveredSession = {
        id: resolvedId,
        path: filePath,
        projectDir: meta.projectDir ?? undefined,
        model: meta.model ?? undefined,
        startTime: startTime ?? undefined,
        lastModified: stat.mtimeMs,
        fileSize: stat.size,
        hasParsedSessionId: sessionId != null,
        format,
      };
      discoveryCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, session });
      sessions.push(session);
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  // Clean up cache entries for deleted files — only within THIS root.
  // The cache is shared across roots; treating another root's paths as
  // deleted would evict its entries on every scan and force full re-reads.
  let deletedCount = 0;
  const dirPrefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const [cachedPath] of discoveryCache) {
    if (cachedPath.startsWith(dirPrefix) && !currentPaths.has(cachedPath)) {
      discoveryCache.delete(cachedPath);
      deletedCount++;
    }
  }

  // Deduplicate: same session UUID can appear in multiple project dirs
  // (context continuation) and in agent-*.jsonl files sharing the parent id.
  // Deterministic canonical ranking; mtime only breaks ties within a rank.
  const byId = new Map<string, DiscoveredSession>();
  for (const s of sessions) {
    const existing = byId.get(s.id);
    byId.set(s.id, existing ? chooseCanonicalSession([existing, s]) : s);
  }

  return {
    sessions: Array.from(byId.values()),
    changedCount: changedCount + deletedCount,
    ...(opts?.collectAll ? { allSessions: sessions } : {}),
  };
}

/**
 * Scan every configured projects root, tagging sessions with their root's
 * source label, then dedupe sessionIds across roots by canonical rank.
 */
export function scanAllProjects(
  roots?: ProjectsRoot[],
  opts?: { collectAll?: boolean },
): ScanResult {
  const resolved = roots ?? resolveProjectsRoots();
  const byId = new Map<string, DiscoveredSession>();
  const all: DiscoveredSession[] = [];
  let changedCount = 0;

  for (const root of resolved) {
    const result = scanProjectsDir(root.path, { ...opts, format: root.format });
    changedCount += result.changedCount;
    const tagged = (opts?.collectAll ? result.allSessions ?? result.sessions : result.sessions)
      .map((s) => ({ ...s, source: root.source }));
    if (opts?.collectAll) all.push(...tagged);
    // Dedupe across roots using the per-root canonical winners
    for (const s of result.sessions) {
      const withSource = { ...s, source: root.source };
      const existing = byId.get(s.id);
      byId.set(s.id, existing ? chooseCanonicalSession([existing, withSource]) : withSource);
    }
  }

  return {
    sessions: Array.from(byId.values()),
    changedCount,
    ...(opts?.collectAll ? { allSessions: all } : {}),
  };
}

/**
 * Sync discovered sessions into the SQLite database.
 */
export function syncToDb(
  db: ConvoDb,
  sessions: DiscoveredSession[],
): void {
  db.transaction(() => {
    for (const session of sessions) {
      db.upsertSession({
        id: session.id,
        jsonl_path: session.path,
        project: session.projectDir,
        source_machine: session.source,
        format: session.format,
        model: session.model,
        start_time: session.startTime
          ? Math.floor(new Date(session.startTime).getTime() / 1000)
          : undefined,
        last_modified: Math.floor(session.lastModified / 1000),
        file_size: session.fileSize,
      });
    }
  });
}

/** Max file size for accurate turn counting (50MB). Larger files use fast estimate. */
const ACCURATE_COUNT_LIMIT = 50 * 1024 * 1024;

/**
 * Accurate turn count using IncrementalParser.
 * Handles consecutive same-role merging and tool-result folding.
 */
function countTurnsAccurate(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  const parser = createConversationParser();
  parser.feedLines(content.split("\n"));
  return parser.getTurns().length;
}

/**
 * Fast line-based turn estimate for large files.
 * Claude: counts "type":"user"/"assistant" message lines (÷4 for merge/fold).
 * Codex: counts "role":"user"/"assistant" message items (each ≈ one turn;
 * reasoning/tool items carry no role, so no divisor is needed).
 */
function countTurnsFast(filePath: string, format: ConversationFormat): number {
  const markers = format === "codex"
    ? ['"role":"user"', '"role":"assistant"']
    : ['"type":"user"', '"type":"assistant"'];
  const hit = (line: string) => markers.some((m) => line.includes(m));
  const CHUNK = 1024 * 1024;
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(CHUNK);
  let count = 0;
  let leftover = "";
  let offset = 0;

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (bytesRead === 0) break;
      const text = leftover + buf.toString("utf-8", 0, bytesRead);
      const lines = text.split("\n");
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (hit(line)) count++;
      }
      offset += bytesRead;
    }
    if (leftover && hit(leftover)) count++;
  } finally {
    fs.closeSync(fd);
  }

  if (format === "codex") return Math.max(1, count);

  // Raw line count is ~3-10x higher than actual turns due to tool result
  // folding and consecutive-role merging. Divide by 4 as rough estimate.
  return Math.max(1, Math.round(count / 4));
}

/**
 * Count turns for a file, choosing accurate or fast method based on size.
 */
function countTurns(filePath: string, fileSize: number, format: ConversationFormat): number {
  if (fileSize <= ACCURATE_COUNT_LIMIT) {
    return countTurnsAccurate(filePath);
  }
  return countTurnsFast(filePath, format);
}

/**
 * Background backfill: count turns for sessions that don't have counts yet.
 * Skips sessions where turn_count > 0 and file_size hasn't changed.
 * Processes in batches to avoid blocking the event loop.
 */
export function backfillTurnCounts(db: ConvoDb, onUpdated?: () => void): void {
  const sessions = db.listSessions({}) as Array<{
    id: string;
    jsonl_path?: string | null;
    turn_count?: number | null;
    file_size?: number | null;
    format?: string | null;
  }>;

  const needsCounting = sessions.filter((s) => {
    if (!s.jsonl_path) return false;
    // Never counted (null = never processed; 0 = processed but had no turns)
    if (s.turn_count == null) return true;
    // File size changed since last count — recount
    try {
      const stat = fs.statSync(s.jsonl_path);
      if (s.file_size != null && stat.size !== s.file_size) return true;
    } catch {
      return false;
    }
    return false;
  });

  if (needsCounting.length === 0) return;

  console.log(`Counting turns for ${needsCounting.length} sessions...`);
  let i = 0;
  let counted = 0;

  const batch = () => {
    const end = Math.min(i + 5, needsCounting.length);
    for (; i < end; i++) {
      const s = needsCounting[i];
      if (!s.jsonl_path) continue;
      try {
        const stat = fs.statSync(s.jsonl_path);
        if (!stat.isFile()) continue;
        const turnCount = countTurns(s.jsonl_path, stat.size, s.format === "codex" ? "codex" : "claude");
        db.db.run("UPDATE sessions SET turn_count = ?, file_size = ? WHERE id = ?", [turnCount, stat.size, s.id]);
        counted++;
      } catch {
        // file may have been deleted
      }
    }

    if (i < needsCounting.length) {
      setTimeout(batch, 5); // yield to event loop between batches
    } else {
      if (counted > 0) {
        console.log(`Turn counts: ${counted} sessions updated`);
        onUpdated?.();
      }
    }
  };

  batch();
}

/** Max file size for FTS indexing (100MB). Larger files skipped. */
const FTS_INDEX_LIMIT = 100 * 1024 * 1024;

/**
 * Background FTS indexing: index conversation text for full-text search.
 * Processes sessions that haven't been indexed yet, in batches.
 * Optional onComplete callback fires when all sessions are indexed.
 */
export function backfillFtsIndex(db: ConvoDb, onComplete?: () => void): void {
  const sessions = db.listSessions({}) as Array<{
    id: string;
    jsonl_path?: string | null;
    file_size?: number | null;
  }>;

  // Check each session: needs indexing if never indexed or file changed since last index
  const needsIndexing: Array<{ id: string; jsonl_path: string; mtimeMs: number; size: number }> = [];
  for (const s of sessions) {
    if (!s.jsonl_path) continue;
    try {
      const stat = fs.statSync(s.jsonl_path);
      if (!stat.isFile() || stat.size > FTS_INDEX_LIMIT) continue;
      if (db.ftsNeedsIndexing(s.id, stat.mtimeMs, stat.size)) {
        needsIndexing.push({ id: s.id, jsonl_path: s.jsonl_path, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      continue;
    }
  }

  if (needsIndexing.length === 0) {
    onComplete?.();
    return;
  }

  console.log(`FTS indexing ${needsIndexing.length} sessions...`);
  let i = 0;
  let indexed = 0;

  const batch = () => {
    const end = Math.min(i + 3, needsIndexing.length);
    for (; i < end; i++) {
      const s = needsIndexing[i];
      try {
        const content = fs.readFileSync(s.jsonl_path, "utf-8");
        const parser = createConversationParser();
        parser.feedLines(content.split("\n"));
        const turns = parser.getTurns();

        const ftsData = turns.map((t) => ({
          role: t.role,
          text: t.blocks
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text || "")
            .join("\n"),
        }));

        db.indexSession(s.id, ftsData, s.mtimeMs, s.size);
        indexed++;
      } catch {
        // skip unreadable files
      }
    }

    if (i < needsIndexing.length) {
      setTimeout(batch, 10); // yield to event loop between batches
    } else {
      console.log(`FTS: ${indexed} sessions indexed`);
      onComplete?.();
    }
  };

  batch();
}
