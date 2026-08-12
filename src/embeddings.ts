// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMBEDDING_DIMS = 256;

/** Minimal interface for the db methods VectorIndex needs. */
export interface EmbeddingDb {
  loadAllEmbeddings(): {
    sessionIds: string[];
    turnIndices: number[];
    roles: string[];
    embeddings: Float32Array[];
  };
}

// ---------------------------------------------------------------------------
// EmbeddingEngine — subprocess-only ONNX model inference
// ---------------------------------------------------------------------------

/** Minimal surface of the worker subprocess. Lets tests inject a fake. */
export interface WorkerSubprocess {
  stdin: { write(data: string): unknown };
  stdout: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  };
  exited: Promise<number>;
  kill(): void;
}

export interface EmbeddingEngineOptions {
  /** Override subprocess creation (tests). Defaults to spawning embedding-worker.ts. */
  spawn?: () => WorkerSubprocess;
  /** Deadline applied to embed requests that don't specify one. */
  defaultTimeoutMs?: number;
}

/** Default deadline for a bulk embed batch. */
const DEFAULT_EMBED_TIMEOUT_MS = 60_000;

/** Deadline for an interactive query embedding — must beat MCP's 30s timeout. */
const QUERY_EMBED_TIMEOUT_MS = 15_000;

/**
 * Embedding engine that runs the ONNX model exclusively in a subprocess
 * (embedding-worker.ts) to avoid blocking the main event loop and to
 * prevent loading the ~4 GB model twice.
 */
export class EmbeddingEngine {
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private loaded = false;
  private failed = false;
  private disabled = false;

  // Subprocess state
  private subprocess: WorkerSubprocess | null = null;
  private subprocessReady = false;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: Float32Array[]) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private stdoutBuffer = "";
  private spawnFn: () => WorkerSubprocess;
  private defaultTimeoutMs: number;

  /**
   * Interactive-work counter. While > 0, bulk backfill defers so an /ask
   * query is not queued behind a stream of batch inference calls.
   */
  private bulkPauseDepth = 0;

  constructor(options?: EmbeddingEngineOptions) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.spawnFn = options?.spawn ?? (() => {
      const workerPath = new URL("./embedding-worker.ts", import.meta.url).pathname;
      return Bun.spawn(["bun", "run", workerPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      }) as unknown as WorkerSubprocess;
    });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Prevent unhandled rejection crash when no one calls waitReady()
    this.readyPromise.catch(() => {});

    // Allow users to opt out on constrained machines
    if (process.env.GLOSS_NO_EMBEDDINGS) {
      this.disabled = true;
      this.failed = true;
      console.log("[embeddings] Disabled via GLOSS_NO_EMBEDDINGS");
      this.rejectReady(new Error("Embeddings disabled via GLOSS_NO_EMBEDDINGS"));
      return;
    }

    this._initSubprocess();
  }

  private _initSubprocess(): void {
    try {
      this.subprocess = this.spawnFn();

      // Read stdout as text stream
      const reader = this.subprocess.stdout.getReader();
      const decoder = new TextDecoder();
      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            this.stdoutBuffer += decoder.decode(value, { stream: true });
            const lines = this.stdoutBuffer.split("\n");
            this.stdoutBuffer = lines.pop() || "";
            for (const line of lines) {
              if (line.trim()) this._handleMessage(line);
            }
          }
        } catch {
          // subprocess exited
        }
      };
      readLoop();

      // Handle subprocess exit
      this.subprocess.exited.then((code) => {
        this.loaded = false;
        this.subprocessReady = false;
        if (!this.failed) {
          this.failed = true;
          this.rejectReady(new Error(`Embedding subprocess exited with code ${code}`));
        }
        // Reject any pending requests
        for (const [, pending] of this.pending) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error("Embedding subprocess exited"));
        }
        this.pending.clear();
        this.subprocess = null;
      });
    } catch (err) {
      this.failed = true;
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[embeddings] Failed to spawn subprocess: ${error.message}`);
      this.rejectReady(error);
    }
  }

  private _handleMessage(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "ready") {
      this.subprocessReady = true;
      this.loaded = true;
      this.resolveReady();
      console.log("[embeddings] Subprocess model loaded");
      return;
    }

    if (msg.type === "status") {
      console.log(`[embeddings] ${msg.message}`);
      return;
    }

    // Response to an embed request: { id, embeddings } or { id, error }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else if (msg.embeddings) {
      const results = (msg.embeddings as number[][]).map(
        (vec) => new Float32Array(vec),
      );
      pending.resolve(results);
    }
  }

  /** Returns true once the subprocess model is loaded and ready. */
  isReady(): boolean {
    return this.loaded;
  }

  /** Returns true if model loading failed. */
  hasFailed(): boolean {
    return this.failed;
  }

  /** Wait for subprocess model to finish loading. */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Pause bulk (backfill) embedding while interactive work is in flight.
   * Nested — every pauseBulk() needs a matching resumeBulk().
   */
  pauseBulk(): void {
    this.bulkPauseDepth++;
  }

  /** Release one pause. Never drops below zero on unbalanced calls. */
  resumeBulk(): void {
    if (this.bulkPauseDepth > 0) this.bulkPauseDepth--;
  }

  /** True while interactive work wants the worker to itself. */
  isBulkPaused(): boolean {
    return this.bulkPauseDepth > 0;
  }

  /** Number of in-flight embed requests. @internal exported for testing. */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Embed texts off the main thread via the subprocess.
   * Returns array of Float32Array(256).
   *
   * Always bounded by a deadline: a worker that stalls silently would
   * otherwise leave this promise pending forever and hang the caller.
   */
  async embedOffThread(
    texts: string[],
    options?: { timeoutMs?: number },
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.subprocess && this.subprocessReady) {
      const id = this.nextId++;
      const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
      const promise = new Promise<Float32Array[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Embedding request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Don't keep the process alive just for this deadline
        (timer as { unref?: () => void }).unref?.();
        this.pending.set(id, { resolve, reject, timer });
      });
      try {
        this.subprocess.stdin.write(JSON.stringify({ id, texts }) + "\n");
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        this.subprocessReady = false;
        throw new Error("Embedding subprocess stdin write failed");
      }
      return promise;
    }
    throw new Error("Embedding subprocess not available");
  }

  /**
   * Embed a single query string. Applies the "query: " prefix
   * required by snowflake-arctic-embed for asymmetric retrieval.
   */
  async embedQuery(
    query: string,
    options?: { timeoutMs?: number },
  ): Promise<Float32Array> {
    if (!this.loaded) throw new Error("Embedding engine not ready");
    const results = await this.embedOffThread([`query: ${query}`], {
      timeoutMs: options?.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS,
    });
    return results[0];
  }

  /** Release subprocess resources. */
  dispose(): void {
    if (this.subprocess) {
      try {
        this.subprocess.kill();
      } catch {
        // already dead
      }
      this.subprocess = null;
    }
    this.subprocessReady = false;
    this.loaded = false;
  }
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

/** Truncate to EMBEDDING_DIMS and L2-normalize. @internal exported for testing. */
export function truncateAndNormalize(vec: number[]): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    const v = i < vec.length ? vec[i] : 0;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

/** Dot product of two Float32Arrays of equal length. */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// ---------------------------------------------------------------------------
// VectorSearchResult
// ---------------------------------------------------------------------------

export interface VectorSearchResult {
  sessionId: string;
  turnIndex: number;
  role: string;
  score: number; // cosine similarity, -1..1 (vectors are L2-normalized, so dot = cosine)
}

// ---------------------------------------------------------------------------
// VectorIndex — in-memory brute-force cosine search
// ---------------------------------------------------------------------------

/** Smallest slot capacity to allocate when the index first grows. */
const MIN_CAPACITY = 64;

/** Compact only once dead slots outnumber live ones by this much. */
const COMPACT_MIN_DEAD = 8;

/**
 * In-memory vector index for fast cosine similarity search.
 * Stores all embeddings in flat typed arrays for cache-friendly scanning.
 *
 * Updates are incremental: removals tombstone their slots and additions
 * append into spare capacity, so re-indexing one session costs O(session
 * turns) instead of copying the entire N×256 buffer. Dead slots are
 * reclaimed by an occasional compaction, not on every write.
 */
export class VectorIndex {
  private sessionIds: string[];
  private turnIndices: number[];
  private roles: string[];
  private vectors: Float32Array; // flat buffer: capacity × 256
  private alive: Uint8Array; // 1 = live, 0 = tombstoned
  private slots: number; // used slots, live + dead
  private capacity: number; // allocated slots
  private _count: number; // live vectors
  private deadSlots = 0;
  /**
   * sessionId → its slots. Built on first mutation, not at load: startup
   * only ever searches, and building it for the whole corpus costs more
   * than the flatten itself.
   */
  private sessionSlots: Map<string, number[]> | null = null;
  private growths = 0;
  private compactions = 0;

  private constructor(
    sessionIds: string[],
    turnIndices: number[],
    roles: string[],
    vectors: Float32Array,
    count: number,
  ) {
    this.sessionIds = sessionIds;
    this.turnIndices = turnIndices;
    this.roles = roles;
    this.vectors = vectors;
    this.slots = count;
    this.capacity = count;
    this._count = count;
    this.alive = new Uint8Array(count).fill(1);
  }

  /** Session→slot index, built on demand. */
  private slotIndex(): Map<string, number[]> {
    if (this.sessionSlots) return this.sessionSlots;
    const map = new Map<string, number[]>();
    for (let i = 0; i < this.slots; i++) {
      if (!this.alive[i]) continue;
      const list = map.get(this.sessionIds[i]);
      if (list) list.push(i);
      else map.set(this.sessionIds[i], [i]);
    }
    this.sessionSlots = map;
    return map;
  }

  /** Number of live vectors in the index. */
  get count(): number {
    return this._count;
  }

  /** Buffer bookkeeping. @internal exported for testing. */
  stats(): {
    live: number;
    slots: number;
    capacity: number;
    deadSlots: number;
    growths: number;
    compactions: number;
  } {
    return {
      live: this._count,
      slots: this.slots,
      capacity: this.capacity,
      deadSlots: this.deadSlots,
      growths: this.growths,
      compactions: this.compactions,
    };
  }

  /** Load all embeddings from the database into memory. */
  static fromDb(db: EmbeddingDb): VectorIndex {
    const data = db.loadAllEmbeddings();
    const count = data.sessionIds.length;
    // Flatten embeddings into a single contiguous buffer
    const flat = new Float32Array(count * EMBEDDING_DIMS);
    for (let i = 0; i < count; i++) {
      flat.set(data.embeddings[i], i * EMBEDDING_DIMS);
    }
    return new VectorIndex(
      data.sessionIds,
      data.turnIndices,
      data.roles,
      flat,
      count,
    );
  }

  /** Grow the backing buffer geometrically so appends stay amortized O(1). */
  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let next = Math.max(this.capacity * 2, MIN_CAPACITY);
    while (next < needed) next *= 2;

    const grown = new Float32Array(next * EMBEDDING_DIMS);
    grown.set(this.vectors.subarray(0, this.slots * EMBEDDING_DIMS));
    const aliveGrown = new Uint8Array(next);
    aliveGrown.set(this.alive.subarray(0, this.slots));

    this.vectors = grown;
    this.alive = aliveGrown;
    this.capacity = next;
    this.growths++;
  }

  /** Drop tombstoned slots. Only worth doing when they dominate the buffer. */
  private maybeCompact(): void {
    if (this.deadSlots < COMPACT_MIN_DEAD) return;
    if (this.deadSlots <= this._count) return;

    const live = this._count;
    const capacity = Math.max(live * 2, MIN_CAPACITY);
    const vectors = new Float32Array(capacity * EMBEDDING_DIMS);
    const alive = new Uint8Array(capacity);
    const sessionIds: string[] = [];
    const turnIndices: number[] = [];
    const roles: string[] = [];
    const sessionSlots = new Map<string, number[]>();

    let j = 0;
    for (let i = 0; i < this.slots; i++) {
      if (!this.alive[i]) continue;
      const sessionId = this.sessionIds[i];
      sessionIds.push(sessionId);
      turnIndices.push(this.turnIndices[i]);
      roles.push(this.roles[i]);
      vectors.set(
        this.vectors.subarray(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
        j * EMBEDDING_DIMS,
      );
      alive[j] = 1;
      const list = sessionSlots.get(sessionId);
      if (list) list.push(j);
      else sessionSlots.set(sessionId, [j]);
      j++;
    }

    this.sessionIds = sessionIds;
    this.turnIndices = turnIndices;
    this.roles = roles;
    this.vectors = vectors;
    this.alive = alive;
    this.sessionSlots = sessionSlots;
    this.slots = j;
    this.capacity = capacity;
    this.deadSlots = 0;
    this.compactions++;
  }

  /** Remove all vectors for a session (used before re-indexing). */
  removeSession(sessionId: string): void {
    const index = this.slotIndex();
    const slots = index.get(sessionId);
    if (!slots || slots.length === 0) return;

    for (const slot of slots) {
      if (!this.alive[slot]) continue;
      this.alive[slot] = 0;
      this._count--;
      this.deadSlots++;
    }
    index.delete(sessionId);
    this.maybeCompact();
  }

  /** Add vectors for a newly-indexed session (removes stale vectors first). */
  addSession(
    sessionId: string,
    entries: Array<{
      turnIndex: number;
      role: string;
      embedding: Float32Array;
    }>,
  ): void {
    // Always remove stale vectors first — even for empty entries (re-index with no content)
    this.removeSession(sessionId);
    if (entries.length === 0) return;

    this.ensureCapacity(this.slots + entries.length);

    const slots: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const slot = this.slots + i;
      this.sessionIds[slot] = sessionId;
      this.turnIndices[slot] = entry.turnIndex;
      this.roles[slot] = entry.role;
      this.vectors.set(entry.embedding, slot * EMBEDDING_DIMS);
      this.alive[slot] = 1;
      slots.push(slot);
    }

    this.slots += entries.length;
    this._count += entries.length;
    this.slotIndex().set(sessionId, slots);
  }

  /**
   * Find top-K turns most similar to the query vector.
   * Returns results sorted by score descending.
   */
  search(queryVector: Float32Array, topK = 50): VectorSearchResult[] {
    if (this._count === 0) return [];

    // Score all vectors (vectors are pre-normalized, so dot = cosine sim)
    const scores: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < this.slots; i++) {
      if (!this.alive[i]) continue;
      const offset = i * EMBEDDING_DIMS;
      const vec = this.vectors.subarray(offset, offset + EMBEDDING_DIMS);
      const score = dot(queryVector, vec);
      scores.push({ idx: i, score });
    }

    // Partial sort: find top K
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK);

    return top.map(({ idx, score }) => ({
      sessionId: this.sessionIds[idx],
      turnIndex: this.turnIndices[idx],
      role: this.roles[idx],
      score,
    }));
  }

  /**
   * Aggregate turn-level results to session-level.
   * Returns sessions ranked by their best turn's score.
   * Aggregates during the O(N) scan to avoid session starvation.
   */
  searchSessions(
    queryVector: Float32Array,
    topK = 30,
  ): Array<{
    sessionId: string;
    bestScore: number;
    bestTurnIndex: number;
    matchCount: number;
  }> {
    if (this._count === 0) return [];

    // Aggregate per-session during the full scan — guarantees every session
    // is considered, regardless of how many turns any single session has.
    const sessionMap = new Map<
      string,
      { bestScore: number; bestTurnIndex: number; matchCount: number }
    >();

    for (let i = 0; i < this.slots; i++) {
      if (!this.alive[i]) continue;
      const offset = i * EMBEDDING_DIMS;
      const vec = this.vectors.subarray(offset, offset + EMBEDDING_DIMS);
      const score = dot(queryVector, vec);

      const sessionId = this.sessionIds[i];
      const existing = sessionMap.get(sessionId);
      if (existing) {
        existing.matchCount++;
        if (score > existing.bestScore) {
          existing.bestScore = score;
          existing.bestTurnIndex = this.turnIndices[i];
        }
      } else {
        sessionMap.set(sessionId, {
          bestScore: score,
          bestTurnIndex: this.turnIndices[i],
          matchCount: 1,
        });
      }
    }

    // Sort by best score descending
    const results = [...sessionMap.entries()]
      .map(([sessionId, data]) => ({ sessionId, ...data }))
      .sort((a, b) => b.bestScore - a.bestScore);

    return results.slice(0, topK);
  }
}
