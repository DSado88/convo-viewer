import * as fs from "node:fs";
import * as os from "node:os";
import type { ConvoDb } from "./db.js";
import { createConversationParser } from "./parser-factory.js";
import type { Turn } from "./types.js";
import type { EmbeddingEngine, VectorIndex } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AskSource {
  sessionId: string;
  project: string;
  title: string;
  matchTurnIndex: number;
  turns: Turn[];
  startTurnIndex: number;
  score?: number;
  matchedTokens?: string[];
}

export interface AskResult {
  query: string;
  answer: string;
  sources: AskSource[];
  timing: { ftsMs: number; vectorMs: number; claudeMs: number; totalMs: number };
  error?: string;
}

/** Lightweight source info for streaming to the client */
export interface StreamSourceInfo {
  num: number;
  sessionId: string;
  project: string;
  title: string;
  matchTurnIndex: number;
  startTurnIndex: number;
  turns: Array<{ role: string; index: number; text: string }>;
}

export type AskStreamEvent =
  | { type: "sources"; sources: StreamSourceInfo[]; timing: { ftsMs: number; vectorMs: number } }
  | { type: "chunk"; text: string }
  | { type: "done"; timing: { ftsMs: number; vectorMs: number; claudeMs: number; totalMs: number } }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// FTS query sanitizer
// ---------------------------------------------------------------------------

const QUESTION_WORDS = new Set([
  "what", "where", "when", "why", "how", "who", "which",
  "is", "are", "was", "were", "do", "does", "did",
  "can", "could", "would", "should", "will",
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
  "i", "me", "my", "we", "us", "our", "it", "its", "this", "that",
]);

/** FTS5 special characters that need stripping. */
const FTS5_SPECIAL = /[":*^~(){}[\]<>+\-!|&\\/]/g;

/**
 * Convert a natural-language question into a valid FTS5 query.
 * Strips question words, punctuation, and special chars, then joins
 * remaining tokens with implicit AND (space-separated in FTS5).
 */
/** Common filler words beyond question words */
const FILLER_WORDS = new Set([
  "lets", "let", "about", "all", "both", "and", "or", "but",
  "just", "also", "very", "really", "some", "any", "every",
  "everything", "anything", "something", "nothing",
  "relevant", "related", "important", "please", "need", "want",
  "gather", "find", "show", "give", "get", "tell", "look",
]);

/** FTS5 boolean operators — must not appear as standalone tokens. */
const FTS5_OPERATORS = new Set(["or", "and", "not", "near"]);

export function sanitizeFtsQuery(input: string): string {
  // Strip all non-alphanumeric except whitespace (nuclear option for safety)
  const stripped = input.replace(FTS5_SPECIAL, " ").replace(/[^a-zA-Z0-9\s]/g, " ");
  let tokens = stripped
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t) && !FILLER_WORDS.has(t) && !FTS5_OPERATORS.has(t));

  if (tokens.length === 0) {
    // Fallback: use any non-trivial words from original (skip question words + operators)
    tokens = stripped.toLowerCase().split(/\s+/)
      .filter((t) => t.length > 1 && !QUESTION_WORDS.has(t) && !FTS5_OPERATORS.has(t));
    if (tokens.length === 0) {
      // Ultimate fallback: strip everything non-alphanumeric, then filter operators
      const last = input.replace(/[^a-zA-Z0-9\s]/g, "").trim().toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1 && !FTS5_OPERATORS.has(t));
      return last.join(" ");
    }
  }

  // Final safety: strip any remaining non-alphanumeric from each token
  tokens = tokens
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1 && !FTS5_OPERATORS.has(t));

  if (tokens.length === 0) return "";

  // For short queries (1-3 tokens), use implicit AND (all must match)
  // For longer queries, use OR to be more permissive
  if (tokens.length <= 3) {
    return tokens.join(" ");
  }
  return tokens.join(" OR ");
}

// ---------------------------------------------------------------------------
// Turn text extraction (for prompt building)
// ---------------------------------------------------------------------------

const MAX_TURN_CHARS = 1000;

function turnToPlainText(turn: Turn): string {
  const parts: string[] = [];
  let chars = 0;
  for (const block of turn.blocks) {
    if (chars >= MAX_TURN_CHARS) break;
    switch (block.type) {
      case "text": {
        const remaining = MAX_TURN_CHARS - chars;
        const text = block.text.length > remaining
          ? block.text.slice(0, remaining) + "..."
          : block.text;
        parts.push(text);
        chars += text.length;
        break;
      }
      case "tool_use":
        parts.push(`[Tool: ${block.name}]`);
        chars += 20;
        break;
      // Skip tool_result, thinking, slash_command for prompt brevity
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// FTS hit merging
// ---------------------------------------------------------------------------

/** Merge duplicate session hits from multiple FTS queries. Keeps best rank and sums hit counts. */
export function mergeFtsHits(
  sessionHits: Array<{ session_id: string; match_count: number; best_rank: number }>,
): Map<string, { bestRank: number; totalHits: number }> {
  const scores = new Map<string, { bestRank: number; totalHits: number }>();
  for (const h of sessionHits) {
    const existing = scores.get(h.session_id);
    if (existing) {
      if (h.best_rank < existing.bestRank) existing.bestRank = h.best_rank;
      existing.totalHits += h.match_count;
    } else {
      scores.set(h.session_id, { bestRank: h.best_rank, totalHits: h.match_count });
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Local keyword extraction (replaces slow Claude shell-out)
// ---------------------------------------------------------------------------

/** Technical term patterns: CamelCase, UPPER_CASE, dot.notation, hyphenated-terms */
const TECHNICAL_TERM_RE = /\b(?:[A-Z][a-z]+(?:[A-Z][a-z]+)+|[A-Z]{2,}(?:_[A-Z]+)*|[a-z]+(?:\.[a-z]+)+|[a-z]+-[a-z]+-?[a-z]*)\b/g;

/**
 * Extract search keywords from a natural-language query using local heuristics.
 * Returns FTS tokens + technical terms (CamelCase, acronyms, dot-notation).
 * Zero latency — no external calls.
 */
function extractLocalTerms(query: string, ftsTokens: string[]): string[] {
  const terms = new Set(ftsTokens);

  // Extract technical terms the FTS tokenizer might miss
  const techMatches = query.match(TECHNICAL_TERM_RE) || [];
  for (const t of techMatches) {
    // Split CamelCase into parts too (e.g., "WebSocket" → "websocket", "web", "socket")
    const lower = t.toLowerCase();
    terms.add(lower);
    const parts = t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_.-]+/);
    for (const p of parts) {
      if (p.length > 2 && !QUESTION_WORDS.has(p) && !FILLER_WORDS.has(p)) {
        terms.add(p);
      }
    }
  }

  // Extract quoted phrases as-is
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) {
    for (const q of quoted) terms.add(q.replace(/"/g, "").toLowerCase());
  }

  return [...terms].filter((t) => t.length > 1);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Per-file ceiling for a source conversation. Reading and parsing a JSONL
 * happens on the single JS thread, so this bounds how long one source can
 * hold the event loop hostage. Anything larger is skipped, not truncated.
 */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

/** Cumulative read budget across all sources for one query. */
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024; // 64 MB

const CLAUDE_TIMEOUT_MS = 60_000;

/** Hand the event loop back so queued HTTP requests get served. */
const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Session metadata search (step 1)
// ---------------------------------------------------------------------------

function searchMetadata(
  db: ConvoDb,
  query: string,
  limit: number,
): string[] {
  // Extract meaningful words for LIKE matching
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !QUESTION_WORDS.has(w) && !FILLER_WORDS.has(w));

  if (words.length === 0) return [];

  // Search project paths and titles
  const conditions = words.map(() => "(LOWER(project) LIKE ? OR LOWER(title) LIKE ?)").join(" OR ");
  const params: string[] = [];
  for (const w of words) {
    params.push(`%${w}%`, `%${w}%`);
  }

  try {
    const rows = db.db.query(
      `SELECT id FROM sessions WHERE ${conditions} ORDER BY coalesce(last_modified, imported_at) DESC LIMIT ?`,
    ).all(...params, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Search phase (shared by askQuestion and askQuestionStream)
// ---------------------------------------------------------------------------

interface AskSearchOptions {
  maxSources?: number;
  contextTurns?: number;
  vectorIndex?: VectorIndex;
  embeddingEngine?: EmbeddingEngine;
  /** Skip any single source file larger than this. */
  maxSourceBytes?: number;
  /** Stop loading sources once this many bytes have been read for one query. */
  maxTotalSourceBytes?: number;
}

interface SearchPhaseResult {
  sources: AskSource[];
  prompt: string;
  timing: { ftsMs: number; vectorMs: number };
}

/**
 * Retrieve and rank source conversations for a query.
 *
 * Bulk embedding backfill is paused for the duration: both share one worker
 * subprocess, and an interactive query should not queue behind batch work.
 */
export async function searchForSources(
  db: ConvoDb,
  query: string,
  options?: AskSearchOptions,
): Promise<SearchPhaseResult> {
  const engine = options?.embeddingEngine;
  engine?.pauseBulk();
  try {
    return await searchForSourcesInner(db, query, options);
  } finally {
    engine?.resumeBulk();
  }
}

async function searchForSourcesInner(
  db: ConvoDb,
  query: string,
  options?: AskSearchOptions,
): Promise<SearchPhaseResult> {
  const tStart = performance.now();
  const maxSources = options?.maxSources ?? 15;
  const contextTurns = options?.contextTurns ?? 1;

  const excludedPatterns = db.getSearchExcludedProjects();
  function isExcluded(sessionId: string): boolean {
    if (excludedPatterns.length === 0) return false;
    const session = db.getSession(sessionId);
    if (!session?.project) return false;
    const proj = session.project.toLowerCase();
    return excludedPatterns.some((pattern) => {
      const p = pattern.toLowerCase();
      if (p.endsWith("*")) return proj.includes(p.slice(0, -1));
      return proj.includes(p);
    });
  }

  // ------------------------------------------------------------------
  // 1. Metadata + FTS search
  // ------------------------------------------------------------------
  const metadataIds = searchMetadata(db, query, maxSources);

  const ftsQuery = sanitizeFtsQuery(query);
  let sessionHits: Array<{ session_id: string; match_count: number; best_rank: number }> = [];
  try {
    sessionHits = db.searchSessions(ftsQuery, maxSources * 4);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ask] FTS error for query "${ftsQuery}": ${msg}`);
  }

  const ftsTokens = ftsQuery.toLowerCase().split(/\s+/).filter((t) => t !== "or" && t.length > 1);

  // Individual FTS queries per token — ensures each concept gets proper
  // representation instead of being drowned by generic words in the OR query
  for (const token of ftsTokens.slice(0, 6)) {
    try {
      const hits = db.searchSessions(token, maxSources * 2);
      sessionHits.push(...hits);
    } catch { /* best-effort */ }
  }

  const localTerms = extractLocalTerms(query, ftsTokens);
  const extraTerms = localTerms.filter((t) => !ftsTokens.includes(t) && t.length > 2);
  if (extraTerms.length > 0) {
    for (const term of extraTerms.slice(0, 8)) {
      try {
        const hits = db.searchSessions(term, maxSources * 2);
        sessionHits.push(...hits);
      } catch { /* best-effort */ }
    }
    console.log(`[ask] Extra FTS terms: ${extraTerms.slice(0, 8).join(", ")}`);
  }

  const tFts = performance.now();

  // ------------------------------------------------------------------
  // 2. Vector search
  // ------------------------------------------------------------------
  let vectorSessionRanking: Array<{
    sessionId: string; bestScore: number; bestTurnIndex: number; matchCount: number;
  }> = [];
  let vectorMs = 0;

  if (options?.vectorIndex && options?.embeddingEngine?.isReady() && options.vectorIndex.count > 0) {
    try {
      const tVec0 = performance.now();
      const queryVec = await options.embeddingEngine.embedQuery(query);
      vectorSessionRanking = options.vectorIndex.searchSessions(queryVec, maxSources * 8);
      vectorMs = Math.round(performance.now() - tVec0);
      console.log(`[ask] Vector search: ${vectorSessionRanking.length} sessions in ${vectorMs}ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ask] Vector search error: ${msg}`);
    }
  }

  // ------------------------------------------------------------------
  // 3. RRF merge
  // ------------------------------------------------------------------
  const RRF_K = 60;
  const filteredHits = sessionHits.filter((h) => !isExcluded(h.session_id));
  const ftsSessionScores = mergeFtsHits(filteredHits);
  const ftsRanked = [...ftsSessionScores.entries()]
    .sort((a, b) => {
      const ra = a[1].bestRank - (a[1].totalHits > 1 ? Math.log2(a[1].totalHits) * 1.5 : 0);
      const rb = b[1].bestRank - (b[1].totalHits > 1 ? Math.log2(b[1].totalHits) * 1.5 : 0);
      return ra - rb;
    })
    .map(([id]) => id);

  const vectorTurnHints = new Map<string, number>();
  const vectorRanked: string[] = [];
  for (const v of vectorSessionRanking) {
    if (isExcluded(v.sessionId)) continue;
    vectorRanked.push(v.sessionId);
    vectorTurnHints.set(v.sessionId, v.bestTurnIndex);
  }

  const metadataRanked = metadataIds.filter((id) => !isExcluded(id));
  const rrfScores = new Map<string, number>();
  const allSessionIds = new Set([...ftsRanked, ...vectorRanked, ...metadataRanked]);

  for (const id of allSessionIds) {
    let score = 0;
    const ftsPos = ftsRanked.indexOf(id);
    if (ftsPos >= 0) score += 1 / (RRF_K + ftsPos + 1);
    const vecPos = vectorRanked.indexOf(id);
    if (vecPos >= 0) score += 1 / (RRF_K + vecPos + 1);
    const metaPos = metadataRanked.indexOf(id);
    if (metaPos >= 0) score += 1 / (RRF_K + metaPos + 1);
    rrfScores.set(id, score);
  }

  const finalSessionEntries = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSources);
  const finalSessionIds = finalSessionEntries.map(([id]) => id);
  const finalScores = new Map(finalSessionEntries);

  console.log(`[ask] RRF selected ${finalSessionIds.length} sessions (FTS:${ftsRanked.length} Vec:${vectorRanked.length} Meta:${metadataRanked.length})`);

  // ------------------------------------------------------------------
  // 4. Load turn context
  // ------------------------------------------------------------------
  const sources: AskSource[] = [];
  const maxSourceBytes = options?.maxSourceBytes ?? MAX_FILE_SIZE;
  const maxTotalSourceBytes = options?.maxTotalSourceBytes ?? MAX_TOTAL_SOURCE_BYTES;
  let bytesRead = 0;
  let sessionsLoaded = 0;

  for (const sessionId of finalSessionIds) {
    if (sessionsLoaded > 0 && bytesRead >= maxTotalSourceBytes) {
      console.log(`[ask] Source budget spent (${bytesRead} bytes) — skipping remaining sessions`);
      break;
    }

    const session = db.getSession(sessionId);
    if (!session?.jsonl_path) continue;

    let stat: fs.Stats;
    try { stat = await fs.promises.stat(session.jsonl_path); } catch { continue; }
    if (stat.size > maxSourceBytes) continue;
    // The budget never suppresses the top-ranked source — a single large
    // conversation should still answer the question, just not drag 14 more in.
    if (sessionsLoaded > 0 && bytesRead + stat.size > maxTotalSourceBytes) continue;

    let allTurns: Turn[];
    try {
      const content = await fs.promises.readFile(session.jsonl_path, "utf-8");
      bytesRead += stat.size;
      sessionsLoaded++;
      const parser = createConversationParser();
      parser.feedLines(content.split("\n"));
      allTurns = parser.getTurns();
    } catch { continue; }

    // Parsing a conversation is CPU-bound; let other requests through.
    await yieldToEventLoop();

    const matchingIndices: number[] = [];
    const vecHint = vectorTurnHints.get(sessionId);
    if (vecHint !== undefined && vecHint >= 0 && vecHint < allTurns.length) {
      matchingIndices.push(vecHint);
    }

    for (let i = 0; i < allTurns.length; i++) {
      if (i === vecHint) continue;
      const text = turnToPlainText(allTurns[i]).toLowerCase();
      if (localTerms.some((kw) => text.includes(kw))) {
        matchingIndices.push(i);
      }
    }

    if (matchingIndices.length === 0 && allTurns.length > 0) {
      matchingIndices.push(0);
    }

    const topMatches = matchingIndices.slice(0, 3);
    const windows: Array<[number, number]> = [];
    for (const idx of topMatches) {
      const lo = Math.max(0, idx - contextTurns);
      const hi = Math.min(allTurns.length - 1, idx + contextTurns);
      windows.push([lo, hi]);
    }

    windows.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [lo, hi] of windows) {
      if (merged.length > 0 && lo <= merged[merged.length - 1][1] + 1) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], hi);
      } else {
        merged.push([lo, hi]);
      }
    }

    for (const [lo, hi] of merged) {
      const turnSlice = allTurns.slice(lo, hi + 1);
      const matchIdx = topMatches.find((i) => i >= lo && i <= hi) ?? lo;
      sources.push({
        sessionId,
        project: session.project ?? "unknown",
        title: session.title ?? sessionId.slice(0, 8),
        matchTurnIndex: matchIdx,
        turns: turnSlice,
        startTurnIndex: lo,
        score: finalScores.get(sessionId),
        matchedTokens: localTerms.length > 0 ? localTerms : ftsTokens,
      });
    }
  }

  // ------------------------------------------------------------------
  // 5. Build prompt with numbered source citations
  // ------------------------------------------------------------------
  const MAX_EXCERPT_CHARS = 20_000;
  let totalChars = 0;
  const excerptParts: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    if (totalChars >= MAX_EXCERPT_CHARS) break;
    const src = sources[i];
    const num = i + 1;
    const projectName = (src.project || "unknown").split("/").pop() || src.project;
    const turnXml = src.turns.map((turn, j) => {
      const idx = src.startTurnIndex + j;
      const text = turnToPlainText(turn);
      return `    <turn index="${idx}" role="${turn.role}">\n${text}\n    </turn>`;
    }).join("\n");

    const sourceXml = `  <source n="${num}" project="${projectName}" session="${src.sessionId}">\n${turnXml}\n  </source>`;
    totalChars += sourceXml.length;
    excerptParts.push(sourceXml);
  }
  const excerpts = excerptParts.join("\n");

  const prompt = `<query>${query}</query>

<sources>
${excerpts}
</sources>

You are a search assistant for a developer's conversation history with Claude Code.
Answer the query by synthesizing information from the numbered sources above.
Be concise and specific. Cite sources by number: [1], [2], etc.
If the sources don't contain relevant information, say so honestly.
Use markdown formatting in your answer.`;

  return {
    sources,
    prompt,
    timing: { ftsMs: Math.round(tFts - tStart), vectorMs },
  };
}

// ---------------------------------------------------------------------------
// Main pipeline: non-streaming
// ---------------------------------------------------------------------------

export async function askQuestion(
  db: ConvoDb,
  query: string,
  options?: AskSearchOptions,
): Promise<AskResult> {
  const t0 = performance.now();
  const search = await searchForSources(db, query, options);

  let answer = "";
  let claudeError: string | undefined;
  const tClaudeStart = performance.now();

  if (search.sources.length > 0) {
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const home = process.env.HOME || os.homedir();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
      }
      env.HOME = home;
      if (!env.PATH) env.PATH = `/usr/local/bin:/usr/bin:/bin:${home}/.local/bin`;
      proc = Bun.spawn([`${home}/.local/bin/claude`, "-p", "--model", "haiku"], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe", env,
      });

      proc.stdin.write(search.prompt);
      proc.stdin.flush();
      proc.stdin.end();

      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      const result = await Promise.race([
        stdoutPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`)), CLAUDE_TIMEOUT_MS),
        ),
      ]);

      answer = result.trim();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await stderrPromise;
        claudeError = `claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`;
        if (!answer) answer = "";
      }
    } catch (e) {
      proc?.kill();
      claudeError = e instanceof Error ? e.message : String(e);
    }
  } else {
    answer = "No matching conversations found for your query.";
  }

  const tEnd = performance.now();
  return {
    query,
    answer,
    sources: search.sources,
    timing: {
      ftsMs: search.timing.ftsMs,
      vectorMs: search.timing.vectorMs,
      claudeMs: Math.round(tEnd - tClaudeStart),
      totalMs: Math.round(tEnd - t0),
    },
    error: claudeError,
  };
}

// ---------------------------------------------------------------------------
// Streaming pipeline: yields sources immediately, then streams Claude chunks
// ---------------------------------------------------------------------------

export async function* askQuestionStream(
  db: ConvoDb,
  query: string,
  options?: AskSearchOptions,
): AsyncGenerator<AskStreamEvent> {
  const t0 = performance.now();

  try {
    const search = await searchForSources(db, query, options);

    // Yield sources immediately — client renders them while Claude thinks
    const streamSources: StreamSourceInfo[] = search.sources.map((src, i) => ({
      num: i + 1,
      sessionId: src.sessionId,
      project: (src.project || "unknown").split("/").pop() || src.project,
      title: src.title,
      matchTurnIndex: src.matchTurnIndex,
      startTurnIndex: src.startTurnIndex,
      turns: src.turns
        .map((turn, j) => ({
          role: turn.role,
          index: src.startTurnIndex + j,
          text: turnToPlainText(turn),
        }))
        .filter((t) => t.role === "human" || t.role === "assistant"),
    }));

    yield { type: "sources", sources: streamSources, timing: search.timing };

    if (search.sources.length === 0) {
      yield { type: "done", timing: { ...search.timing, claudeMs: 0, totalMs: Math.round(performance.now() - t0) } };
      return;
    }

    // Stream Claude's response
    const tClaude = performance.now();
    const home = process.env.HOME || os.homedir();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
    }
    env.HOME = home;
    if (!env.PATH) env.PATH = `/usr/local/bin:/usr/bin:/bin:${home}/.local/bin`;

    const proc = Bun.spawn(
      [`${home}/.local/bin/claude`, "-p", "--model", "haiku",
       "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
    );

    proc.stdin.write(search.prompt);
    proc.stdin.flush();
    proc.stdin.end();

    // Consume stderr concurrently to prevent buffer blocking
    const stderrPromise = new Response(proc.stderr).text();

    // Parse stream-json: extract text deltas from stream_event wrappers
    // Structure: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const outer = JSON.parse(line);
            if (outer.type === "stream_event") {
              const evt = outer.event;
              if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
                yield { type: "chunk", text: evt.delta.text };
              }
            }
          } catch { /* ignore parse errors on partial lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      yield { type: "error", message: `claude exited with code ${exitCode}: ${stderr.slice(0, 500)}` };
    }

    const tEnd = performance.now();
    yield {
      type: "done",
      timing: {
        ftsMs: search.timing.ftsMs,
        vectorMs: search.timing.vectorMs,
        claudeMs: Math.round(tEnd - tClaude),
        totalMs: Math.round(tEnd - t0),
      },
    };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
