import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { createConversationParser } from "./parser-factory.js";
import type { ConvoDb } from "./db.js";
import type { EmbeddingEngine, VectorIndex } from "./embeddings.js";
import type { TextBlock } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max file size for embedding indexing (50MB). Larger files skipped to avoid blocking. */
const EMBEDDING_INDEX_LIMIT = 50 * 1024 * 1024;

/** Min file size worth embedding (10KB). Filters out trivial/empty sessions. */
const EMBEDDING_MIN_SIZE = 10 * 1024;

/** Max characters per turn to embed (practical truncation limit). */
const MAX_TURN_CHARS = 2000;

/** Number of turns per embedding batch call. */
const EMBED_BATCH_SIZE = 16;

/** ms to sleep between embedding batches. */
const YIELD_MS = 50;

// ---------------------------------------------------------------------------
// Turn text extraction
// ---------------------------------------------------------------------------

/** Extract embeddable text from a turn (text blocks only, no tools/thinking). */
function turnToEmbeddingText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text || "")
    .join("\n")
    .trim();
}

/** SHA-256 hash of text for dedup/staleness detection. */
function textHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** ms to wait between checks while interactive work holds the worker. */
const PAUSE_POLL_MS = 100;

/**
 * Longest a backfill will defer to interactive work before proceeding anyway.
 * A pause is only ever released in a `finally`, but if bookkeeping ever leaks
 * one, indexing must degrade to "slow", not "silently stopped forever".
 */
const MAX_BULK_DEFER_MS = 60_000;

/** Sleep helper that actually yields to the event loop. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stand down while an interactive query is using the embedding worker.
 * Backfill and /ask share one subprocess; batch work always defers — but
 * only up to `maxDeferMs`, so a leaked pause cannot wedge indexing.
 */
async function awaitBulkResume(
  engine: EmbeddingEngine,
  maxDeferMs: number,
): Promise<void> {
  const deadline = Date.now() + maxDeferMs;
  while (engine.isBulkPaused?.()) {
    if (Date.now() >= deadline) {
      console.warn(
        `[embeddings] Bulk pause held ${maxDeferMs}ms — proceeding with backfill anyway`,
      );
      return;
    }
    await sleep(PAUSE_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Background embedding indexer
// ---------------------------------------------------------------------------

/** Guard against concurrent backfill runs. */
let embeddingBackfillRunning = false;

/**
 * Background embedding indexer. Scans sessions and generates embeddings.
 * Yields to the event loop between every embedding batch to keep the
 * server responsive during backfill.
 */
export function backfillEmbeddings(
  db: ConvoDb,
  engine: EmbeddingEngine,
  vectorIndex: VectorIndex | null,
  options?: {
    batchSize?: number;
    minTurns?: number;
    maxBulkDeferMs?: number;
    onProgress?: (indexed: number, total: number) => void;
  },
): void {
  if (!engine.isReady()) {
    console.log("[embeddings] Engine not ready, skipping backfill");
    return;
  }

  if (embeddingBackfillRunning) {
    return; // Previous run still in progress
  }
  embeddingBackfillRunning = true;

  const batchSize = options?.batchSize ?? EMBED_BATCH_SIZE;

  // Kick off the async loop
  (async () => {
    try {
      await runBackfill(
        db,
        engine,
        vectorIndex,
        batchSize,
        options?.minTurns ?? 3,
        options?.maxBulkDeferMs ?? MAX_BULK_DEFER_MS,
        options?.onProgress,
      );
    } catch (err) {
      console.error("[embeddings] Backfill crashed:", err);
    } finally {
      embeddingBackfillRunning = false;
    }
  })();
}

async function runBackfill(
  db: ConvoDb,
  engine: EmbeddingEngine,
  vectorIndex: VectorIndex | null,
  batchSize: number,
  minTurns: number,
  maxBulkDeferMs: number,
  onProgress?: (indexed: number, total: number) => void,
): Promise<void> {
  const sessions = db.listSessions({}) as Array<{
    id: string;
    jsonl_path?: string | null;
    file_size?: number | null;
    turn_count?: number | null;
  }>;

  // Find sessions needing embedding — skip sessions below the turn threshold
  const threshold = minTurns > 0 ? minTurns : 3;
  const needsIndexing: Array<{ id: string; jsonl_path: string; mtimeMs: number; size: number }> = [];
  for (const s of sessions) {
    if (!s.jsonl_path) continue;
    if ((s.turn_count ?? 0) < threshold) continue;
    try {
      const stat = fs.statSync(s.jsonl_path);
      if (!stat.isFile() || stat.size > EMBEDDING_INDEX_LIMIT || stat.size < EMBEDDING_MIN_SIZE) continue;
      if (db.embeddingNeedsIndexing(s.id, stat.mtimeMs, stat.size)) {
        needsIndexing.push({ id: s.id, jsonl_path: s.jsonl_path, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      continue;
    }
  }

  if (needsIndexing.length === 0) return;

  // Sort by mtime descending so recent conversations get embedded first
  needsIndexing.sort((a, b) => b.mtimeMs - a.mtimeMs);

  console.log(`[embeddings] Backfill: ${needsIndexing.length} sessions to index`);
  let indexed = 0;
  let totalTurns = 0;
  const startTime = Date.now();

  for (let cursor = 0; cursor < needsIndexing.length; cursor++) {
    const s = needsIndexing[cursor];

    // Never start a session's work while an ask is in flight.
    await awaitBulkResume(engine, maxBulkDeferMs);

    try {
      const content = await fs.promises.readFile(s.jsonl_path, "utf-8");
      const parser = createConversationParser();
      parser.feedLines(content.split("\n"));
      const turns = parser.getTurns();

      // Extract text and filter empty turns
      const turnTexts: Array<{ index: number; role: string; text: string; hash: string }> = [];
      for (let t = 0; t < turns.length; t++) {
        const text = turnToEmbeddingText(turns[t].blocks);
        if (!text) continue;
        const truncated = text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS) : text;
        turnTexts.push({
          index: t,
          role: turns[t].role,
          text: truncated,
          hash: textHash(truncated),
        });
      }

      if (turnTexts.length === 0) continue;

      // Embed in batches, yielding between each to keep server responsive
      const entries: Array<{
        turnIndex: number;
        role: string;
        textHash: string;
        embedding: Float32Array;
      }> = [];

      for (let b = 0; b < turnTexts.length; b += batchSize) {
        // Re-check between batches so a query arriving mid-session waits at
        // most one batch, not the rest of the file.
        await awaitBulkResume(engine, maxBulkDeferMs);
        const batch = turnTexts.slice(b, b + batchSize);
        const texts = batch.map((t) => t.text);
        const embeddings = await engine.embedOffThread(texts);
        for (let j = 0; j < batch.length; j++) {
          entries.push({
            turnIndex: batch[j].index,
            role: batch[j].role,
            textHash: batch[j].hash,
            embedding: embeddings[j],
          });
        }
        // Yield to event loop between every batch
        await sleep(YIELD_MS);
      }

      // Store in DB
      db.storeEmbeddings(s.id, entries, s.mtimeMs, s.size);

      // Update in-memory vector index
      if (vectorIndex) {
        vectorIndex.addSession(
          s.id,
          entries.map((e) => ({
            turnIndex: e.turnIndex,
            role: e.role,
            embedding: e.embedding,
          })),
        );
      }

      indexed++;
      totalTurns += entries.length;
      onProgress?.(indexed, needsIndexing.length);

      // Log progress every 50 sessions
      if (indexed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (indexed / ((Date.now() - startTime) / 60000)).toFixed(0);
        console.log(`[embeddings] Progress: ${indexed}/${needsIndexing.length} sessions (${totalTurns} turns, ${elapsed}s, ${rate}/min)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[embeddings] Error indexing session ${s.id}: ${msg}`);
    }

    // Yield between sessions too
    await sleep(10);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`[embeddings] Done: ${indexed} sessions indexed (${totalTurns} turns) in ${elapsed}s`);
}
