import { describe, it, expect } from "vitest";
import { VectorIndex, EmbeddingEngine, EMBEDDING_DIMS, truncateAndNormalize } from "./embeddings.js";
import type { EmbeddingDb } from "./embeddings.js";

// Helper to create a mock EmbeddingDb
function mockDb(data: {
  sessionIds: string[];
  turnIndices: number[];
  roles: string[];
  embeddings: Float32Array[];
}): EmbeddingDb {
  return { loadAllEmbeddings: () => data };
}

// Helper to create a normalized vector with given leading components
function makeVec(...values: number[]): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < Math.min(values.length, EMBEDDING_DIMS); i++) {
    vec[i] = values[i];
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIMS; i++) vec[i] /= norm;
  return vec;
}

// ---------------------------------------------------------------------------
// Bug #1: truncateAndNormalize NaN propagation from short vectors
// ---------------------------------------------------------------------------

describe("truncateAndNormalize", () => {
  it("handles vectors shorter than EMBEDDING_DIMS without producing NaN", () => {
    const shortVec = [0.5, 0.3, 0.1]; // only 3 elements, 256 expected
    const result = truncateAndNormalize(shortVec);

    expect(result.length).toBe(EMBEDDING_DIMS);
    for (let i = 0; i < result.length; i++) {
      expect(Number.isNaN(result[i])).toBe(false);
    }
    // First 3 should be non-zero (normalized), rest should be 0
    expect(result[0]).not.toBe(0);
    expect(result[3]).toBe(0);
    expect(result[255]).toBe(0);
  });

  it("handles empty vector without producing NaN", () => {
    const result = truncateAndNormalize([]);
    expect(result.length).toBe(EMBEDDING_DIMS);
    for (let i = 0; i < result.length; i++) {
      expect(Number.isNaN(result[i])).toBe(false);
    }
  });

  it("handles full-length vector correctly", () => {
    const fullVec = new Array(EMBEDDING_DIMS).fill(0);
    fullVec[0] = 1.0;
    const result = truncateAndNormalize(fullVec);
    expect(result[0]).toBeCloseTo(1.0);
    expect(Number.isNaN(result[0])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug #4: Score comment says 0-1 but cosine can be negative
// ---------------------------------------------------------------------------

describe("VectorIndex.search", () => {
  it("can return negative cosine similarity scores", () => {
    const v1 = makeVec(1, 0);
    const v2 = makeVec(-1, 0);
    const index = VectorIndex.fromDb(
      mockDb({
        sessionIds: ["pos", "neg"],
        turnIndices: [0, 0],
        roles: ["user", "user"],
        embeddings: [v1, v2],
      }),
    );

    const query = makeVec(1, 0);
    const results = index.search(query, 10);
    const negResult = results.find((r) => r.sessionId === "neg");
    expect(negResult).toBeDefined();
    expect(negResult!.score).toBeLessThan(0);
  });

  it("returns valid (non-NaN) scores for all results", () => {
    const v1 = makeVec(1, 0);
    const v2 = makeVec(0, 1);
    const index = VectorIndex.fromDb(
      mockDb({
        sessionIds: ["s1", "s2"],
        turnIndices: [0, 0],
        roles: ["user", "user"],
        embeddings: [v1, v2],
      }),
    );

    const query = makeVec(1, 0);
    const results = index.search(query, 10);
    for (const r of results) {
      expect(Number.isNaN(r.score)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug #3: Session starvation in searchSessions
// ---------------------------------------------------------------------------

describe("VectorIndex.searchSessions", () => {
  it("does not starve sessions when one has many more turns", () => {
    const sessionIds: string[] = [];
    const turnIndices: number[] = [];
    const roles: string[] = [];
    const embeddings: Float32Array[] = [];

    // "big" session: 200 turns, all somewhat aligned with query
    for (let i = 0; i < 200; i++) {
      sessionIds.push("big");
      turnIndices.push(i);
      roles.push("user");
      embeddings.push(makeVec(0.9, 0.1 * (i % 5)));
    }

    // "small" session: 2 turns, well-aligned with query
    for (let i = 0; i < 2; i++) {
      sessionIds.push("small");
      turnIndices.push(i);
      roles.push("user");
      embeddings.push(makeVec(0.85, 0.15));
    }

    const index = VectorIndex.fromDb(
      mockDb({ sessionIds, turnIndices, roles, embeddings }),
    );

    // topK=2 means searchSessions should return at most 2 sessions
    // With the old code: search(query, 2*5=10) returns top 10 turns,
    // which are all from "big" → "small" is starved out
    const query = makeVec(1, 0);
    const results = index.searchSessions(query, 2);

    const ids = results.map((r) => r.sessionId);
    expect(ids).toContain("big");
    expect(ids).toContain("small");
  });
});

// ---------------------------------------------------------------------------
// Bug #2: Unhandled promise rejection in EmbeddingEngine constructor
// ---------------------------------------------------------------------------

describe("EmbeddingEngine", () => {
  it("does not produce unhandled rejection when GLOSS_NO_EMBEDDINGS is set", async () => {
    const original = process.env.GLOSS_NO_EMBEDDINGS;
    process.env.GLOSS_NO_EMBEDDINGS = "1";

    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", handler);

    try {
      // Dynamic import to avoid model loading in other tests
      const { EmbeddingEngine } = await import("./embeddings.js");
      const engine = new EmbeddingEngine();
      expect(engine.hasFailed()).toBe(true);
      expect(engine.isReady()).toBe(false);

      // Give event loop time to surface any unhandled rejection
      await new Promise((r) => setTimeout(r, 200));

      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", handler);
      if (original === undefined) delete process.env.GLOSS_NO_EMBEDDINGS;
      else process.env.GLOSS_NO_EMBEDDINGS = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Stall fix #1: VectorIndex must not copy the whole buffer per session
//
// The old addSession/removeSession allocated a fresh N×256 Float32Array and
// copied every live vector on every call. At 155K vectors that is ~159MB of
// copying (twice, since addSession calls removeSession first) per indexed
// session — enough GC churn to wedge the event loop during backfill.
// ---------------------------------------------------------------------------

describe("VectorIndex incremental updates", () => {
  function emptyIndex(): VectorIndex {
    return VectorIndex.fromDb(
      mockDb({ sessionIds: [], turnIndices: [], roles: [], embeddings: [] }),
    );
  }

  function addOne(index: VectorIndex, id: string, dim: number): void {
    const vec = new Float32Array(EMBEDDING_DIMS);
    vec[dim % EMBEDDING_DIMS] = 1;
    index.addSession(id, [{ turnIndex: 0, role: "user", embedding: vec }]);
  }

  it("grows the backing buffer amortized, not once per session", () => {
    const index = emptyIndex();
    for (let i = 0; i < 256; i++) addOne(index, `s${i}`, i);

    expect(index.count).toBe(256);
    // Geometric growth: 256 appends must not mean 256 full-buffer reallocations.
    expect(index.stats().growths).toBeLessThan(20);
  });

  it("removeSession tombstones instead of rebuilding the buffer", () => {
    const index = emptyIndex();
    for (let i = 0; i < 64; i++) addOne(index, `s${i}`, i);
    const growthsBefore = index.stats().growths;

    index.removeSession("s10");

    expect(index.count).toBe(63);
    expect(index.stats().growths).toBe(growthsBefore); // no reallocation
    expect(index.stats().deadSlots).toBeGreaterThan(0);

    // The removed session must not surface in either search path.
    const query = new Float32Array(EMBEDDING_DIMS);
    query[10] = 1;
    expect(index.search(query, 64).some((r) => r.sessionId === "s10")).toBe(false);
    expect(index.searchSessions(query, 64).some((r) => r.sessionId === "s10")).toBe(false);
  });

  it("re-adding a session replaces its vectors without leaking dead slots", () => {
    const index = emptyIndex();
    addOne(index, "s1", 0);
    addOne(index, "s1", 1); // re-index the same session

    expect(index.count).toBe(1);

    const q0 = new Float32Array(EMBEDDING_DIMS);
    q0[0] = 1;
    const q1 = new Float32Array(EMBEDDING_DIMS);
    q1[1] = 1;
    // Only the newest vector survives.
    expect(index.search(q0, 10)[0].score).toBeCloseTo(0.0);
    expect(index.search(q1, 10)[0].score).toBeCloseTo(1.0);
  });

  it("compacts once tombstones outnumber live vectors", () => {
    const index = emptyIndex();
    for (let i = 0; i < 128; i++) addOne(index, `s${i}`, i);
    for (let i = 0; i < 100; i++) index.removeSession(`s${i}`);

    expect(index.count).toBe(28);
    expect(index.stats().compactions).toBeGreaterThan(0);
    // Compaction reclaims the dead slots rather than retaining them forever.
    expect(index.stats().deadSlots).toBeLessThan(28);

    // Survivors are still findable and correctly attributed.
    const query = new Float32Array(EMBEDDING_DIMS);
    query[120] = 1;
    const hit = index.search(query, 1)[0];
    expect(hit.sessionId).toBe("s120");
    expect(hit.score).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// Stall fix #3: embed requests need deadlines, and bulk work must yield to
// interactive queries. Without a timeout a silent worker stall leaves pending
// promises hanging forever; without a pause, backfill competes with /ask.
// ---------------------------------------------------------------------------

describe("EmbeddingEngine bulk pause", () => {
  function disabledEngine() {
    const original = process.env.GLOSS_NO_EMBEDDINGS;
    process.env.GLOSS_NO_EMBEDDINGS = "1";
    try {
      return new EmbeddingEngine();
    } finally {
      if (original === undefined) delete process.env.GLOSS_NO_EMBEDDINGS;
      else process.env.GLOSS_NO_EMBEDDINGS = original;
    }
  }

  it("is not paused by default", () => {
    expect(disabledEngine().isBulkPaused()).toBe(false);
  });

  it("nests pause/resume so concurrent asks do not resume each other early", () => {
    const engine = disabledEngine();
    engine.pauseBulk();
    engine.pauseBulk();
    engine.resumeBulk();
    expect(engine.isBulkPaused()).toBe(true); // second ask still in flight
    engine.resumeBulk();
    expect(engine.isBulkPaused()).toBe(false);
  });

  it("never goes negative on unbalanced resume", () => {
    const engine = disabledEngine();
    engine.resumeBulk();
    engine.resumeBulk();
    expect(engine.isBulkPaused()).toBe(false);
    engine.pauseBulk();
    expect(engine.isBulkPaused()).toBe(true);
  });
});

describe("EmbeddingEngine request deadlines", () => {
  /** A fake worker subprocess whose replies we drive by hand. */
  function fakeWorker(options?: { reply?: boolean }) {
    const reply = options?.reply ?? true;
    const encoder = new TextEncoder();
    const queue: Uint8Array[] = [encoder.encode(JSON.stringify({ type: "ready" }) + "\n")];
    let notify: (() => void) | null = null;
    const writes: string[] = [];

    const push = (line: string) => {
      queue.push(encoder.encode(line + "\n"));
      notify?.();
    };

    const subprocess = {
      stdin: {
        write(data: string) {
          writes.push(data);
          if (!reply) return;
          const msg = JSON.parse(data);
          // Echo one zero vector per requested text.
          push(JSON.stringify({
            id: msg.id,
            embeddings: msg.texts.map(() => new Array(EMBEDDING_DIMS).fill(0)),
          }));
        },
      },
      stdout: {
        getReader() {
          return {
            async read() {
              if (queue.length > 0) return { done: false, value: queue.shift()! };
              await new Promise<void>((r) => { notify = r; });
              notify = null;
              return { done: false, value: queue.shift()! };
            },
          };
        },
      },
      exited: new Promise<number>(() => {}), // never exits
      kill() {},
    };

    return { subprocess, writes };
  }

  it("rejects an embed request that the worker never answers", async () => {
    const { subprocess } = fakeWorker({ reply: false });
    const engine = new EmbeddingEngine({ spawn: () => subprocess as never });
    await engine.waitReady();

    await expect(
      engine.embedOffThread(["hello"], { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);

    // The pending entry must be dropped, not leaked.
    expect(engine.pendingCount()).toBe(0);
    engine.dispose();
  });

  it("resolves normally when the worker answers before the deadline", async () => {
    const { subprocess } = fakeWorker();
    const engine = new EmbeddingEngine({ spawn: () => subprocess as never });
    await engine.waitReady();

    const vecs = await engine.embedOffThread(["hello", "world"], { timeoutMs: 5_000 });
    expect(vecs.length).toBe(2);
    expect(vecs[0].length).toBe(EMBEDDING_DIMS);
    expect(engine.pendingCount()).toBe(0);
    engine.dispose();
  });

  it("applies a default deadline when none is given", async () => {
    const { subprocess } = fakeWorker({ reply: false });
    const engine = new EmbeddingEngine({
      spawn: () => subprocess as never,
      defaultTimeoutMs: 50,
    });
    await engine.waitReady();

    await expect(engine.embedOffThread(["hello"])).rejects.toThrow(/timed out/i);
    engine.dispose();
  });
});
