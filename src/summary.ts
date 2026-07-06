/**
 * Lazy conversation summary generation via Claude CLI subprocess (Haiku model).
 * Reuses the same subprocess pattern as askQuestion() in ask.ts.
 */
import * as fs from "fs";
import * as os from "os";
import type { ConvoDb } from "./db.js";
import { createConversationParser, assistantLabelFor } from "./parser-factory.js";
import type { TextBlock } from "./types.js";

const SUMMARY_TIMEOUT_MS = 20_000; // 20s — Haiku on ~3K chars should be 3-8s
const MAX_CONCURRENT = 3;
const MAX_TURN_CHARS = 500;

/** In-memory dedup: collapse concurrent requests for same session into one promise. */
const inflight = new Map<string, Promise<string>>();
let concurrentCount = 0;

export interface SummaryResult {
  status: "done" | "generating" | "error" | "idle";
  summary?: string | null;
  sourceMtime?: number | null;
  error?: string | null;
  cached?: boolean;
}

/**
 * Get summary for a session — returns cached if fresh, otherwise returns current status.
 */
export function getSummary(db: ConvoDb, sessionId: string): SummaryResult {
  const session = db.getSession(sessionId);
  if (!session?.jsonl_path) return { status: "error", error: "Session not found" };

  // Check if cached summary is still fresh
  if (session.summary && session.summary_status === "done" && session.summary_source_mtime != null) {
    try {
      const stat = fs.statSync(session.jsonl_path);
      const currentMtime = Math.floor(stat.mtimeMs);
      if (session.summary_source_mtime === currentMtime) {
        return { status: "done", summary: session.summary, sourceMtime: currentMtime, cached: true };
      }
      // Stale — file changed since summary was generated
      db.clearSummary(sessionId);
      return { status: "idle", cached: false };
    } catch {
      // File gone — clear summary
      db.clearSummary(sessionId);
      return { status: "idle", cached: false };
    }
  }

  // Guard against inconsistent state: status="done" but no summary text
  const status = session.summary_status === "done" && !session.summary
    ? "idle"
    : (session.summary_status as SummaryResult["status"]) ?? "idle";

  return {
    status,
    summary: session.summary,
    error: session.summary_error,
    cached: false,
  };
}

/**
 * Trigger summary generation. Returns immediately.
 * Uses in-memory dedup to prevent thundering herd.
 */
export async function generateSummary(db: ConvoDb, sessionId: string): Promise<SummaryResult> {
  const session = db.getSession(sessionId);
  if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
    return { status: "error", error: "Session not found" };
  }

  // Check if already generating (in-memory dedup)
  const existing = inflight.get(sessionId);
  if (existing) {
    return { status: "generating" };
  }

  // Check concurrency limit
  if (concurrentCount >= MAX_CONCURRENT) {
    return { status: "error", error: "Too many concurrent summary requests. Try again shortly." };
  }

  // Capture source mtime BEFORE reading
  const stat = fs.statSync(session.jsonl_path);
  const sourceMtime = Math.floor(stat.mtimeMs);

  // Check if cached summary is still fresh (avoid re-generating)
  if (session.summary && session.summary_source_mtime === sourceMtime && session.summary_status === "done") {
    return { status: "done", summary: session.summary, sourceMtime, cached: true };
  }

  // Build excerpt
  const excerpt = buildExcerpt(session.jsonl_path);
  if (!excerpt) {
    return { status: "error", error: "Could not extract conversation content" };
  }

  // Mark as generating
  db.setSummaryGenerating(sessionId);
  concurrentCount++;

  const promise = spawnHaiku(excerpt)
    .then((summary) => {
      db.setSummaryDone(sessionId, summary, sourceMtime);
      return summary;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      db.setSummaryError(sessionId, msg);
      throw err;
    })
    .finally(() => {
      inflight.delete(sessionId);
      concurrentCount--;
    });

  inflight.set(sessionId, promise);

  return { status: "generating" };
}

/**
 * Extract first 2 + last 2 turns as a bounded excerpt.
 */
export function buildExcerpt(jsonlPath: string): string | null {
  try {
    // Read first 32KB + last 32KB for large files (enough for first/last turns)
    const stat = fs.statSync(jsonlPath);
    let content: string;
    if (stat.size > 128 * 1024) {
      const fd = fs.openSync(jsonlPath, "r");
      const headBuf = Buffer.alloc(32 * 1024);
      const tailBuf = Buffer.alloc(32 * 1024);
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      fs.readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, stat.size - tailBuf.length));
      fs.closeSync(fd);
      content = headBuf.toString("utf-8") + "\n" + tailBuf.toString("utf-8");
    } else {
      content = fs.readFileSync(jsonlPath, "utf-8");
    }
    const parser = createConversationParser();
    parser.feedLines(content.split("\n"));
    const turns = parser.getTurns();
    const assistantLabel = assistantLabelFor(parser);

    if (turns.length === 0) return null;

    // First 2 + last 2 (deduped if < 4 turns)
    const indices = new Set<number>();
    indices.add(0);
    if (turns.length > 1) indices.add(1);
    if (turns.length > 2) indices.add(turns.length - 2);
    if (turns.length > 1) indices.add(turns.length - 1);

    const parts: string[] = [];
    for (const i of [...indices].sort((a, b) => a - b)) {
      const turn = turns[i];
      const role = turn.role === "user" ? "User" : assistantLabel;
      const textBlocks = turn.blocks.filter((b): b is TextBlock => b.type === "text");
      let text = textBlocks.map((b) => b.text || "").join("\n").trim();
      if (text.length > MAX_TURN_CHARS) text = text.substring(0, MAX_TURN_CHARS) + "...";
      if (text) parts.push(`[${role}] ${text}`);
    }

    if (parts.length === 0) return null;

    const prompt = `Summarize this developer-Claude conversation in 1-2 sentences. Focus on: user goal, key decisions, outcome. Be specific and concise.\n\n<conversation>\n${parts.join("\n\n")}\n</conversation>`;
    return prompt;
  } catch {
    return null;
  }
}

/**
 * Spawn Claude CLI with Haiku model. Returns the summary text.
 */
async function spawnHaiku(prompt: string): Promise<string> {
  const home = process.env.HOME || os.homedir();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
  }
  env.HOME = home;
  if (!env.PATH) env.PATH = `/usr/local/bin:/usr/bin:/bin:${home}/.local/bin`;

  const proc = Bun.spawn([`${home}/.local/bin/claude`, "-p", "--model", "haiku"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  proc.stdin.write(prompt);
  proc.stdin.flush();
  proc.stdin.end();

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const result = await Promise.race([
    stdoutPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Summary generation timed out after ${SUMMARY_TIMEOUT_MS / 1000}s`));
      }, SUMMARY_TIMEOUT_MS),
    ),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await stderrPromise;
    throw new Error(`claude exited with code ${exitCode}: ${stderr.slice(0, 300)}`);
  }

  const summary = result.trim();
  if (!summary) throw new Error("Claude returned empty summary");
  return summary;
}
