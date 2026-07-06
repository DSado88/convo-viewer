import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanProjectsDir, scanAllProjects, resolveProjectsRoots, syncToDb, clearDiscoveryCache, backfillTurnCounts, backfillFtsIndex, classifyJsonlPath, canonicalRank, chooseCanonicalSession, type DiscoveredSession } from "./discovery.js";
import { openDb, type ConvoDb } from "./db.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "convo-discovery-test-"));
}

function writeMinimalJsonl(filePath: string, sessionId: string, extra?: object): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "summary",
      sessionId,
      cwd: "/home/user/project",
      version: "1.0.0",
      ...extra,
    }),
    JSON.stringify({
      type: "user",
      sessionId,
      message: { content: "Hello" },
      timestamp: "2024-01-15T10:30:00Z",
    }),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

describe("discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    clearDiscoveryCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // scanProjectsDir
  // -----------------------------------------------------------------------

  describe("scanProjectsDir", () => {
    it("discovers JSONL files in project directories", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      fs.mkdirSync(projectDir, { recursive: true });
      writeMinimalJsonl(
        path.join(projectDir, "abc123.jsonl"),
        "abc123",
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("abc123");
      expect(sessions[0].path).toBe(path.join(projectDir, "abc123.jsonl"));
    });

    it("discovers sessions across multiple project directories", () => {
      const project1 = path.join(tempDir, "-Users-test-project1");
      const project2 = path.join(tempDir, "-Users-test-project2");
      writeMinimalJsonl(path.join(project1, "aaa.jsonl"), "aaa");
      writeMinimalJsonl(path.join(project2, "bbb.jsonl"), "bbb");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["aaa", "bbb"]);
    });

    it("excludes subagents/ directories", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      writeMinimalJsonl(path.join(projectDir, "main.jsonl"), "main");
      writeMinimalJsonl(
        path.join(projectDir, "subagents", "sub.jsonl"),
        "sub",
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("main");
    });

    it("deduplicates: same session ID in multiple projects keeps newest", () => {
      const project1 = path.join(tempDir, "-Users-test-project1");
      const project2 = path.join(tempDir, "-Users-test-project2");

      // Write to project1 first (older)
      writeMinimalJsonl(path.join(project1, "shared-id.jsonl"), "shared-id");

      // Wait a tick, then write to project2 (newer, bigger file)
      const newerPath = path.join(project2, "shared-id.jsonl");
      fs.mkdirSync(project2, { recursive: true });
      const lines = [];
      for (let i = 0; i < 10; i++) {
        lines.push(
          JSON.stringify({
            type: "user",
            sessionId: "shared-id",
            message: { content: `Message ${i}` },
            timestamp: "2024-06-15T10:30:00Z",
          }),
        );
      }
      // Set mtime to the future to guarantee it's newer
      fs.writeFileSync(newerPath, lines.join("\n") + "\n", "utf-8");
      const futureTime = Date.now() + 60000;
      fs.utimesSync(newerPath, futureTime / 1000, futureTime / 1000);

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("shared-id");
      expect(sessions[0].path).toBe(newerPath);
    });

    it("deduplicates same sessionId from different filenames in same directory", () => {
      // Real-world edge case: two files in the same project dir with different
      // filenames but the same sessionId in their JSONL content (e.g., a session
      // file was copied). Dedup should keep the newer file.
      const projectDir = path.join(tempDir, "-Users-test-project");
      fs.mkdirSync(projectDir, { recursive: true });

      // Original file (older)
      const original = path.join(projectDir, "original.jsonl");
      writeMinimalJsonl(original, "same-uuid");

      // Copy with a different name (newer mtime)
      const copy = path.join(projectDir, "copy-of-session.jsonl");
      writeMinimalJsonl(copy, "same-uuid");
      const futureTime = Date.now() + 60000;
      fs.utimesSync(copy, futureTime / 1000, futureTime / 1000);

      const { sessions } = scanProjectsDir(tempDir);
      // Dedup keeps only ONE, and it should be the newer copy
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("same-uuid");
      expect(sessions[0].path).toBe(copy);
    });

    it("extracts metadata from JSONL header", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      fs.mkdirSync(projectDir, { recursive: true });
      // Model comes from assistant message, not summary
      const lines = [
        JSON.stringify({
          type: "summary",
          sessionId: "meta-test",
          cwd: "/home/user/project",
          version: "1.0.0",
        }),
        JSON.stringify({
          type: "user",
          sessionId: "meta-test",
          message: { content: "Hello" },
          timestamp: "2024-01-15T10:30:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hi!" }],
            model: "claude-opus-4-6",
          },
          timestamp: "2024-01-15T10:30:05Z",
        }),
      ];
      fs.writeFileSync(
        path.join(projectDir, "meta-test.jsonl"),
        lines.join("\n") + "\n",
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].model).toBe("claude-opus-4-6");
    });

    it("follows symlinked project directories", () => {
      // Create a real directory outside tempDir, symlink it in
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-discovery-ext-"));
      try {
        writeMinimalJsonl(path.join(externalDir, "sym-test.jsonl"), "sym-test");
        fs.symlinkSync(externalDir, path.join(tempDir, "linked-project"));

        const { sessions } = scanProjectsDir(tempDir);
        expect(sessions.some((s) => s.id === "sym-test")).toBe(true);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });

    it("follows symlinked individual JSONL files (not just directories)", () => {
      // A symlink to a .jsonl file (not a directory) should be followed.
      // This tests the entry.isSymbolicLink() → statSync → isFile path.
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-discovery-ext-file-"));
      try {
        const realPath = path.join(externalDir, "real-session.jsonl");
        writeMinimalJsonl(realPath, "symlinked-file-session");
        fs.symlinkSync(realPath, path.join(projectDir, "linked.jsonl"));

        const { sessions } = scanProjectsDir(tempDir);
        expect(sessions.some((s) => s.id === "symlinked-file-session")).toBe(true);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });

    it("skips dangling symlinks without crashing", () => {
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      // Create a symlink pointing to a nonexistent target
      fs.symlinkSync("/nonexistent/path/session.jsonl", path.join(projectDir, "dangling.jsonl"));
      // Also add a real file to confirm scanning continues past the dangling link
      writeMinimalJsonl(path.join(projectDir, "real.jsonl"), "real-session");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("real-session");
    });

    it("discovers JSONL files in deeply nested directories", () => {
      const deepDir = path.join(tempDir, "proj", "nested", "deeper");
      writeMinimalJsonl(path.join(deepDir, "deep-session.jsonl"), "deep-session");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("deep-session");
    });

    it("discovers multiple JSONL files in the same project directory", () => {
      const projectDir = path.join(tempDir, "-Users-test-project");
      writeMinimalJsonl(path.join(projectDir, "aaa.jsonl"), "aaa");
      writeMinimalJsonl(path.join(projectDir, "bbb.jsonl"), "bbb");
      writeMinimalJsonl(path.join(projectDir, "ccc.jsonl"), "ccc");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["aaa", "bbb", "ccc"]);
    });

    it("handles empty directory gracefully", () => {
      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toEqual([]);
    });

    it("handles non-existent directory gracefully", () => {
      const { sessions } = scanProjectsDir(path.join(tempDir, "no-such-dir"));
      expect(sessions).toEqual([]);
    });

    it("uses mtime cache on rescan, changedCount drops to zero", () => {
      const projectDir = path.join(tempDir, "proj");
      writeMinimalJsonl(path.join(projectDir, "cached.jsonl"), "cached");

      const first = scanProjectsDir(tempDir);
      expect(first.sessions).toHaveLength(1);
      expect(first.changedCount).toBe(1);

      const second = scanProjectsDir(tempDir);
      expect(second.sessions).toHaveLength(1);
      expect(second.sessions[0].id).toBe("cached");
      expect(second.changedCount).toBe(0); // served from cache
    });

    it("changedCount includes both new files and deleted cache entries", () => {
      const projectDir = path.join(tempDir, "proj");
      const file1 = path.join(projectDir, "a.jsonl");
      const file2 = path.join(projectDir, "b.jsonl");
      writeMinimalJsonl(file1, "aaa");
      writeMinimalJsonl(file2, "bbb");

      const first = scanProjectsDir(tempDir);
      expect(first.changedCount).toBe(2);
      expect(first.sessions).toHaveLength(2);

      // Delete one, add a new one in the same scan
      fs.unlinkSync(file1);
      writeMinimalJsonl(path.join(projectDir, "c.jsonl"), "ccc");

      const second = scanProjectsDir(tempDir);
      expect(second.sessions).toHaveLength(2); // bbb (cached) + ccc (new)
      expect(second.changedCount).toBe(2); // 1 new file + 1 deleted cache entry
      const ids = second.sessions.map((s) => s.id).sort();
      expect(ids).toEqual(["bbb", "ccc"]);
    });

    it("cleans cache entries when files are deleted between scans", () => {
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "ephemeral.jsonl");
      writeMinimalJsonl(filePath, "ephemeral");

      const first = scanProjectsDir(tempDir);
      expect(first.sessions).toHaveLength(1);

      fs.unlinkSync(filePath);

      const second = scanProjectsDir(tempDir);
      expect(second.sessions).toHaveLength(0);
      expect(second.changedCount).toBe(1); // deletion counts as change
    });

    it("handles non-conversation JSONL files gracefully (filename fallback)", () => {
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "random-data.jsonl"),
        '{"event":"click","time":123}\n{"event":"scroll","time":456}\n',
      );

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("random-data"); // filename fallback
      expect(sessions[0].projectDir).toBeUndefined();
      expect(sessions[0].model).toBeUndefined();
    });

    it("handles zero-byte JSONL files without crashing or leaking fds", () => {
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "empty-session.jsonl"), "");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("empty-session"); // filename fallback
      expect(sessions[0].fileSize).toBe(0);
    });

    it("handles active session with truncated last line (mid-write)", () => {
      // During active writes, the file may end with a partial JSON line.
      // Discovery should still extract metadata from the valid lines
      // and not crash on the truncated one.
      const projectDir = path.join(tempDir, "proj");
      fs.mkdirSync(projectDir, { recursive: true });
      const content =
        JSON.stringify({ type: "user", sessionId: "active-write", message: { content: "hello" }, timestamp: "2024-06-01T12:00:00Z" }) +
        "\n" +
        '{"type":"assistant","message":{"content":"truncat';  // mid-write
      fs.writeFileSync(path.join(projectDir, "active.jsonl"), content);

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("active-write");
      expect(sessions[0].startTime).toBe("2024-06-01T12:00:00Z");
    });

    it("does not read entire large files", () => {
      const projectDir = path.join(tempDir, "-Users-test-project1");
      fs.mkdirSync(projectDir, { recursive: true });

      // Create a ~100KB file (much smaller than real 200MB files but proves partial read)
      const filePath = path.join(projectDir, "big.jsonl");
      const header = JSON.stringify({
        type: "summary",
        sessionId: "big-session",
        cwd: "/test",
      });
      // Fill with padding lines
      const padding = "x".repeat(1000);
      const lines = [header];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({ type: "user", message: { content: padding } }));
      }
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      const { sessions } = scanProjectsDir(tempDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("big-session");
    });
  });

  // -----------------------------------------------------------------------
  // syncToDb
  // -----------------------------------------------------------------------

  describe("syncToDb", () => {
    let db: ConvoDb;
    let dbDir: string;

    beforeEach(() => {
      dbDir = makeTempDir();
      db = openDb(path.join(dbDir, "test.sqlite"));
    });

    afterEach(() => {
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    });

    it("upserts discovered sessions into the database", () => {
      const sessions: DiscoveredSession[] = [
        {
          id: "sess-1",
          path: "/tmp/test/sess-1.jsonl",
          projectDir: "/home/user/proj",
          model: "claude-opus-4-6",
          startTime: "2024-01-15T10:30:00Z",
          lastModified: Date.now(),
          fileSize: 12345,
        },
      ];

      syncToDb(db, sessions);

      const record = db.getSession("sess-1");
      expect(record).not.toBeNull();
      expect(record!.jsonl_path).toBe("/tmp/test/sess-1.jsonl");
      expect(record!.project).toBe("/home/user/proj");
      expect(record!.model).toBe("claude-opus-4-6");
    });

    it("converts startTime from ISO to Unix seconds and stores all numeric fields", () => {
      const now = Date.now();
      syncToDb(db, [{
        id: "ts-test",
        path: "/tmp/test/ts.jsonl",
        startTime: "2024-06-15T12:00:00Z",
        lastModified: now,
        fileSize: 54321,
      }]);

      const session = db.getSession("ts-test");
      expect(session).not.toBeNull();
      // ISO → Unix seconds
      expect(session!.start_time).toBe(Math.floor(new Date("2024-06-15T12:00:00Z").getTime() / 1000));
      // lastModified ms → seconds
      expect(session!.last_modified).toBe(Math.floor(now / 1000));
      expect(session!.file_size).toBe(54321);
    });

    it("stores null start_time for invalid/missing timestamps without crashing", () => {
      syncToDb(db, [{
        id: "no-ts",
        path: "/tmp/test/no-ts.jsonl",
        lastModified: Date.now(),
        fileSize: 100,
        // no startTime
      }]);
      expect(db.getSession("no-ts")!.start_time).toBeNull();

      syncToDb(db, [{
        id: "bad-ts",
        path: "/tmp/test/bad-ts.jsonl",
        startTime: "not-a-date",
        lastModified: Date.now(),
        fileSize: 100,
      }]);
      // Invalid date → NaN → stored as NULL by SQLite
      expect(db.getSession("bad-ts")!.start_time).toBeNull();
    });

    it("recounts turns when file shrinks (truncated/replaced)", () => {
      // Write a file with 4 user+assistant pairs
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "shrink.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 4; i++) {
        lines.push(JSON.stringify({ type: "user", message: { content: `Q${i}` }, timestamp: `t${i * 2}` }));
        lines.push(JSON.stringify({ type: "assistant", message: { content: `A${i}` }, timestamp: `t${i * 2 + 1}` }));
      }
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
      const bigSize = fs.statSync(filePath).size;

      // Seed DB as if we already counted this file
      db.upsertSession({
        id: "shrink-test",
        jsonl_path: filePath,
        turn_count: 8,
        file_size: bigSize,
      });

      // Truncate to 1 exchange
      const smallLines = [
        JSON.stringify({ type: "user", message: { content: "Only" }, timestamp: "t0" }),
        JSON.stringify({ type: "assistant", message: { content: "One" }, timestamp: "t1" }),
      ];
      fs.writeFileSync(filePath, smallLines.join("\n") + "\n", "utf-8");

      backfillTurnCounts(db);

      const session = db.getSession("shrink-test");
      expect(session!.turn_count).toBe(2);
    });

    it("backfillFtsIndex indexes conversation text for search", () => {
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "fts-test.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: "user", message: { content: "How do I configure webpack?" }, timestamp: "t0" }),
        JSON.stringify({ type: "assistant", message: { content: "Here is the webpack configuration guide." }, timestamp: "t1" }),
      ];
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      db.upsertSession({ id: "fts-test", jsonl_path: filePath });

      // Run FTS backfill (batch size is 3, so 1 session processes synchronously)
      backfillFtsIndex(db);

      // The session should now be searchable
      const results = db.searchSessions("webpack", 10);
      expect(results.length).toBe(1);
      expect(results[0].session_id).toBe("fts-test");

      // Non-matching query should return empty
      const noResults = db.searchSessions("nonexistent_xyzzy_term", 10);
      expect(noResults.length).toBe(0);
    });

    it("backfillFtsIndex fires onComplete even when nothing needs indexing", () => {
      // The onComplete callback must fire in the "nothing to do" path too,
      // so callers (like the server startup chain) don't hang waiting.
      let called = false;
      backfillFtsIndex(db, () => { called = true; });
      expect(called).toBe(true);
    });

    it("backfillFtsIndex skips sessions without jsonl_path", () => {
      db.upsertSession({ id: "no-path" });

      backfillFtsIndex(db);

      // Should not crash, and session should not be indexed
      expect(db.ftsIndexedCount()).toBe(0);
    });

    it("backfillFtsIndex handles tool-only conversations (no text blocks)", () => {
      // A conversation with only tool_use and tool_result blocks produces
      // turns where all text is empty after filtering to type="text" blocks.
      // FTS indexing should still mark it as indexed without crashing.
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "tools-only.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      const lines = [
        JSON.stringify({
          type: "user",
          message: { content: [
            { type: "tool_result", tool_use_id: "tu1", content: "file contents" },
          ] },
          timestamp: "2024-01-15T10:00:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [
            { type: "tool_use", id: "tu2", name: "Bash", input: { command: "ls" } },
          ] },
          timestamp: "2024-01-15T10:00:01Z",
        }),
      ];
      fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      db.upsertSession({ id: "tools-only", jsonl_path: filePath });
      backfillFtsIndex(db);

      // Session should be marked as indexed (not re-indexed every cycle)
      expect(db.ftsIndexedCount()).toBe(1);
      const stat = fs.statSync(filePath);
      expect(db.ftsNeedsIndexing("tools-only", stat.mtimeMs, stat.size)).toBe(false);

      // Searching should return no results (no text to match)
      const results = db.searchSessions("file contents", 10);
      expect(results.length).toBe(0);
    });

    it("backfillTurnCounts stores turn_count=0 for files with no turns", () => {
      // A JSONL with only a summary line and no user/assistant messages
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "no-turns.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        type: "summary",
        sessionId: "no-turns-test",
        cwd: "/test",
        version: "1.0.0",
      }) + "\n", "utf-8");

      const fileSize = fs.statSync(filePath).size;
      db.upsertSession({ id: "no-turns-test", jsonl_path: filePath, file_size: fileSize });

      backfillTurnCounts(db);

      const session = db.getSession("no-turns-test");
      // turn_count should be 0, not null — storing 0 prevents re-counting every cycle
      expect(session!.turn_count).toBe(0);
      expect(session!.file_size).toBe(fileSize);
    });

    it("does not re-count sessions with turn_count=0 if file size unchanged", () => {
      // After storing turn_count=0 with correct file_size, backfill should
      // skip the session — even though turn_count is 0, the file hasn't changed.
      // Bug: the old filter used `!s.turn_count` which is true for 0, causing
      // re-counting on every cycle. The fix uses `turn_count == null`.
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "zero-stable.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      // Write a file with just a summary (no turns)
      const content = JSON.stringify({ type: "summary", sessionId: "zero-stable", cwd: "/test" }) + "\n";
      fs.writeFileSync(filePath, content, "utf-8");
      const fileSize = fs.statSync(filePath).size;

      // Simulate already-counted session: turn_count=0, file_size matches
      db.upsertSession({ id: "zero-stable", jsonl_path: filePath, file_size: fileSize });
      db.db.run("UPDATE sessions SET turn_count = 0 WHERE id = ?", ["zero-stable"]);

      // Now APPEND a real turn to the file — but DON'T update file_size in DB.
      // This creates a mismatch: the file has grown, but the DB still has the old size.
      fs.appendFileSync(filePath, JSON.stringify({
        type: "user", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z",
      }) + "\n");

      // With the bug (!s.turn_count): session is recounted because turn_count=0 → !0 = true.
      // After recounting, turn_count becomes 1 (the new turn).
      //
      // With the fix (turn_count == null): the filter checks file_size.
      // file_size in DB doesn't match actual file → recount → turn_count becomes 1.
      //
      // Both produce turn_count=1 in this case. But the KEY difference is the
      // code path: the fix uses the file_size check, not the turn_count check.

      // Reset file_size to match the NEW file size to test the OPPOSITE case:
      // turn_count=0, file_size=CURRENT → should NOT recount.
      const newSize = fs.statSync(filePath).size;
      db.db.run("UPDATE sessions SET file_size = ?, turn_count = 0 WHERE id = ?", [newSize, "zero-stable"]);

      backfillTurnCounts(db);

      // With the bug: turn_count=0 → !0=true → always recount → turn_count changes to 1
      // With the fix: turn_count=0, file_size matches → skip → turn_count stays 0
      const session = db.getSession("zero-stable")!;
      expect(session.turn_count).toBe(0);
    });

    it("recounts turns when previously empty file (file_size=0) gains content", () => {
      // A session initially counted with an empty file (turn_count=0, file_size=0).
      // If the file later gets content, the turn count must be updated.
      // Bug: `s.file_size && stat.size !== s.file_size` treats file_size=0 as falsy,
      // skipping the size-change check, so the session is never recounted.
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "grew-from-empty.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });
      // Start with empty file
      fs.writeFileSync(filePath, "", "utf-8");

      db.upsertSession({ id: "grew-from-empty", jsonl_path: filePath });
      db.db.run("UPDATE sessions SET turn_count = 0, file_size = 0 WHERE id = ?", ["grew-from-empty"]);

      // Now write real content to the file
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "user", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }),
        JSON.stringify({ type: "assistant", message: { content: "hi" }, timestamp: "2024-01-01T00:00:01Z" }),
      ].join("\n") + "\n", "utf-8");

      backfillTurnCounts(db);

      // turn_count should be updated from 0 to 2 (file grew from 0 bytes)
      const session = db.getSession("grew-from-empty")!;
      expect(session.turn_count).toBe(2);
    });

    it("backfillFtsIndex re-indexes when file content changes (mtime update)", () => {
      const projectDir = path.join(tempDir, "proj");
      const filePath = path.join(projectDir, "reindex.jsonl");
      fs.mkdirSync(projectDir, { recursive: true });

      // Initial content: searchable for "webpack"
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "user", message: { content: "How to configure webpack?" }, timestamp: "t0" }),
        JSON.stringify({ type: "assistant", message: { content: "Use webpack.config.js" }, timestamp: "t1" }),
      ].join("\n") + "\n", "utf-8");

      db.upsertSession({ id: "reindex-test", jsonl_path: filePath });
      backfillFtsIndex(db);

      // Should find "webpack"
      expect(db.searchSessions("webpack", 10).length).toBe(1);

      // Overwrite with different content and bump mtime
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "user", message: { content: "How to configure vite?" }, timestamp: "t0" }),
        JSON.stringify({ type: "assistant", message: { content: "Use vite.config.ts" }, timestamp: "t1" }),
      ].join("\n") + "\n", "utf-8");
      // Ensure mtime is newer (some filesystems have 1s granularity)
      const futureTime = Date.now() / 1000 + 60;
      fs.utimesSync(filePath, futureTime, futureTime);

      backfillFtsIndex(db);

      // After re-index: "webpack" should no longer match, "vite" should
      expect(db.searchSessions("webpack", 10).length).toBe(0);
      expect(db.searchSessions("vite", 10).length).toBe(1);
    });

    it("updates path when re-syncing same session with new path", () => {
      syncToDb(db, [
        { id: "s1", path: "/old/path.jsonl", lastModified: Date.now(), fileSize: 100 },
      ]);
      expect(db.getSession("s1")!.jsonl_path).toBe("/old/path.jsonl");

      syncToDb(db, [
        { id: "s1", path: "/new/path.jsonl", lastModified: Date.now(), fileSize: 200 },
      ]);
      expect(db.getSession("s1")!.jsonl_path).toBe("/new/path.jsonl");
    });
  });
});

// ---------------------------------------------------------------------------
// Canonical file ranking — agent/temp files must never beat real main files
// ---------------------------------------------------------------------------

const UUID_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("classifyJsonlPath", () => {
  it("detects agent files", () => {
    expect(classifyJsonlPath(`/p/-Users-x-proj/agent-${UUID_A}.jsonl`).isAgentFile).toBe(true);
    expect(classifyJsonlPath(`/p/-Users-x-proj/${UUID_A}.jsonl`).isAgentFile).toBe(false);
  });

  it("detects temp/private-var-folders project dirs (parent segment only)", () => {
    expect(classifyJsonlPath(`/p/-private-var-folders-6n-abc123/${UUID_A}.jsonl`).isTempPath).toBe(true);
    expect(classifyJsonlPath(`/p/-var-folders-6n-abc123/${UUID_A}.jsonl`).isTempPath).toBe(true);
    expect(classifyJsonlPath(`/p/-tmp-scratch/${UUID_A}.jsonl`).isTempPath).toBe(true);
    expect(classifyJsonlPath(`/p/-Users-x-proj/${UUID_A}.jsonl`).isTempPath).toBe(false);
    // The scan root living under /tmp or /var/folders must NOT mark files temp
    expect(classifyJsonlPath(`/var/folders/6n/abc/T/-Users-x-proj/${UUID_A}.jsonl`).isTempPath).toBe(false);
  });

  it("detects UUID-named files", () => {
    expect(classifyJsonlPath(`/p/-Users-x-proj/${UUID_A}.jsonl`).isUuidNamed).toBe(true);
    expect(classifyJsonlPath(`/p/-Users-x-proj/notes.jsonl`).isUuidNamed).toBe(false);
    expect(classifyJsonlPath(`/p/-Users-x-proj/agent-${UUID_A}.jsonl`).isUuidNamed).toBe(false);
  });
});

describe("canonicalRank", () => {
  const base = { lastModified: 1000, fileSize: 10 };

  it("ranks main file < normal file < agent file < temp file < filename fallback", () => {
    const main = canonicalRank({ id: UUID_A, path: `/p/-Users-x-proj/${UUID_A}.jsonl`, hasParsedSessionId: true, ...base });
    const normal = canonicalRank({ id: UUID_A, path: `/p/-Users-x-proj/copy.jsonl`, hasParsedSessionId: true, ...base });
    const agent = canonicalRank({ id: UUID_A, path: `/p/-Users-x-proj/agent-bbb.jsonl`, hasParsedSessionId: true, ...base });
    const temp = canonicalRank({ id: UUID_A, path: `/p/-private-var-folders-6n-x/${UUID_A}.jsonl`, hasParsedSessionId: true, ...base });
    const fallback = canonicalRank({ id: "notes", path: `/p/-Users-x-proj/notes.jsonl`, hasParsedSessionId: false, ...base });

    expect(main).toBeLessThan(normal);
    expect(normal).toBeLessThan(agent);
    expect(agent).toBeLessThan(temp);
    expect(temp).toBeLessThan(fallback);
  });
});

describe("chooseCanonicalSession", () => {
  it("prefers the main file over a newer agent file", () => {
    const main: DiscoveredSession = {
      id: UUID_A, path: `/p/-Users-x-proj/${UUID_A}.jsonl`,
      hasParsedSessionId: true, lastModified: 1000, fileSize: 10,
    };
    const agent: DiscoveredSession = {
      id: UUID_A, path: `/p/-Users-x-proj/agent-ccc.jsonl`,
      hasParsedSessionId: true, lastModified: 99999, fileSize: 999,
    };
    expect(chooseCanonicalSession([agent, main])).toBe(main);
    expect(chooseCanonicalSession([main, agent])).toBe(main);
  });

  it("prefers a normal project file over a newer temp file", () => {
    const normal: DiscoveredSession = {
      id: UUID_A, path: `/p/-Users-x-proj/${UUID_A}.jsonl`,
      hasParsedSessionId: true, lastModified: 1000, fileSize: 10,
    };
    const temp: DiscoveredSession = {
      id: UUID_A, path: `/p/-private-var-folders-6n-x/${UUID_A}.jsonl`,
      hasParsedSessionId: true, lastModified: 99999, fileSize: 999,
    };
    expect(chooseCanonicalSession([temp, normal])).toBe(normal);
  });

  it("breaks ties within the same rank by mtime", () => {
    const older: DiscoveredSession = {
      id: UUID_A, path: `/p/-Users-x-proj1/${UUID_A}.jsonl`,
      hasParsedSessionId: true, lastModified: 1000, fileSize: 10,
    };
    const newer: DiscoveredSession = {
      id: UUID_A, path: `/p/-Users-x-proj2/${UUID_A}.jsonl`,
      hasParsedSessionId: true, lastModified: 2000, fileSize: 10,
    };
    expect(chooseCanonicalSession([older, newer])).toBe(newer);
  });
});

describe("scanProjectsDir canonical ranking", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-canonical-test-"));
    clearDiscoveryCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeJsonlWithSession(filePath: string, sessionId: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lines = [
      JSON.stringify({ type: "summary", sessionId, cwd: "/home/user/project", version: "1.0.0" }),
      JSON.stringify({ type: "user", sessionId, message: { content: "Hello" }, timestamp: "2024-01-15T10:30:00Z" }),
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }

  it("main UUID file beats a newer agent file with the same sessionId", () => {
    const projectDir = path.join(tempDir, "-Users-test-project");
    const mainPath = path.join(projectDir, `${UUID_A}.jsonl`);
    const agentPath = path.join(projectDir, `agent-deadbeef.jsonl`);
    writeJsonlWithSession(mainPath, UUID_A);
    writeJsonlWithSession(agentPath, UUID_A);
    const future = Date.now() + 60000;
    fs.utimesSync(agentPath, future / 1000, future / 1000);

    const { sessions } = scanProjectsDir(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].path).toBe(mainPath);
  });

  it("normal project file beats a newer private-var-folders file", () => {
    const normalPath = path.join(tempDir, "-Users-test-project", `${UUID_A}.jsonl`);
    const tempPath = path.join(tempDir, "-private-var-folders-6n-pxfd123", `${UUID_A}.jsonl`);
    writeJsonlWithSession(normalPath, UUID_A);
    writeJsonlWithSession(tempPath, UUID_A);
    const future = Date.now() + 60000;
    fs.utimesSync(tempPath, future / 1000, future / 1000);

    const { sessions } = scanProjectsDir(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].path).toBe(normalPath);
  });

  it("filename-fallback files rank below files with a parsed sessionId", () => {
    // Two files produce the same session id: one parses it from content,
    // one only has it as a filename (no sessionId in any line).
    const parsedPath = path.join(tempDir, "-Users-test-a", "real.jsonl");
    writeJsonlWithSession(parsedPath, "shared-xyz");

    const fallbackPath = path.join(tempDir, "-Users-test-b", "shared-xyz.jsonl");
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.writeFileSync(
      fallbackPath,
      JSON.stringify({ type: "user", message: { content: "no session id here" } }) + "\n",
      "utf-8",
    );
    const future = Date.now() + 60000;
    fs.utimesSync(fallbackPath, future / 1000, future / 1000);

    const { sessions } = scanProjectsDir(tempDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].path).toBe(parsedPath);
  });
});

// ---------------------------------------------------------------------------
// Multi-root scanning with source attribution (MBP vs Studio)
// ---------------------------------------------------------------------------

describe("multi-root source attribution", () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = fs.mkdtempSync(path.join(os.tmpdir(), "convo-root-a-"));
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), "convo-root-b-"));
    clearDiscoveryCache();
    delete process.env.GLOSS_PROJECTS_ROOTS;
    delete process.env.GLOSS_MACHINE_NAME;
  });

  afterEach(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    delete process.env.GLOSS_PROJECTS_ROOTS;
    delete process.env.GLOSS_MACHINE_NAME;
  });

  it("resolveProjectsRoots parses name=path pairs (default format claude)", () => {
    const roots = resolveProjectsRoots({ GLOSS_PROJECTS_ROOTS: `studio=${rootA},mbp=${rootB}` });
    expect(roots).toEqual([
      { source: "studio", path: rootA, format: "claude" },
      { source: "mbp", path: rootB, format: "claude" },
    ]);
  });

  it("resolveProjectsRoots parses a label:format tag", () => {
    const roots = resolveProjectsRoots({ GLOSS_PROJECTS_ROOTS: `studio=${rootA},codex-studio:codex=${rootB}` });
    expect(roots).toEqual([
      { source: "studio", path: rootA, format: "claude" },
      { source: "codex-studio", path: rootB, format: "codex" },
    ]);
  });

  it("resolveProjectsRoots falls back to single default root with machine name", () => {
    const roots = resolveProjectsRoots({ GLOSS_PROJECTS_DIR: rootA, GLOSS_MACHINE_NAME: "mbp" });
    expect(roots).toEqual([{ source: "mbp", path: rootA, format: "claude" }]);
  });


  it("rescan of multiple roots keeps each root's mtime cache intact (changedCount=0 on no-change rescan)", () => {
    // Bug: the cache eviction pass treated any cached path outside the
    // currently scanned root as "deleted", so scanning root A evicted all of
    // root B's entries and vice versa — every multi-root rescan re-read the
    // entire corpus and reported everything as changed.
    writeMinimalJsonl(path.join(rootA, "-Users-x-proj", "aaa.jsonl"), "aaa");
    writeMinimalJsonl(path.join(rootB, "-Users-x-proj", "bbb.jsonl"), "bbb");
    const roots = [
      { source: "studio", path: rootA },
      { source: "mbp", path: rootB },
    ];

    const first = scanAllProjects(roots);
    expect(first.changedCount).toBe(2);

    const second = scanAllProjects(roots);
    expect(second.changedCount).toBe(0);
  });


  it("re-reads a file whose content and size changed but mtime was preserved (backdated sync)", () => {
    // rsync -a / cp -p / restores preserve mtimes. A synced-over file with the
    // same mtime but different content must not be served from the cache.
    const file = path.join(rootA, "-Users-x-proj", "swap.jsonl");
    writeMinimalJsonl(file, "old-session");
    const mtime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(file, mtime, mtime);
    const first = scanAllProjects([{ source: "a", path: rootA }]);
    expect(first.sessions.find((s) => s.id === "old-session")).toBeTruthy();

    // Rewrite with different content (different size + session id), restore mtime
    fs.writeFileSync(file, JSON.stringify({ type: "summary", sessionId: "new-session", cwd: "/x", extra: "pad-to-change-size" }) + "\n");
    fs.utimesSync(file, mtime, mtime);

    const second = scanAllProjects([{ source: "a", path: rootA }]);
    expect(second.sessions.find((s) => s.id === "new-session")).toBeTruthy();
    expect(second.sessions.find((s) => s.id === "old-session")).toBeFalsy();
  });


  it("rejects nested roots — outer scan would misattribute the inner root's files", () => {
    const nested = path.join(rootA, "mbp");
    fs.mkdirSync(nested, { recursive: true });
    expect(() =>
      resolveProjectsRoots({ GLOSS_PROJECTS_ROOTS: `studio=${rootA},mbp=${nested}` }),
    ).toThrow(/nested/i);
  });

  it("accepts sibling roots that share a path prefix", () => {
    // /projects vs /projects-mbp are siblings, not nested — must be allowed
    const sibling = rootA + "-mbp";
    fs.mkdirSync(sibling, { recursive: true });
    try {
      const roots = resolveProjectsRoots({ GLOSS_PROJECTS_ROOTS: `a=${rootA},b=${sibling}` });
      expect(roots.length).toBe(2);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("scanAllProjects tags sessions with their root's source", () => {
    writeMinimalJsonl(path.join(rootA, "-Users-x-proj", "aaa.jsonl"), "aaa");
    writeMinimalJsonl(path.join(rootB, "-Users-x-proj", "bbb.jsonl"), "bbb");

    const { sessions } = scanAllProjects([
      { source: "studio", path: rootA },
      { source: "mbp", path: rootB },
    ]);
    expect(sessions).toHaveLength(2);
    const a = sessions.find((s) => s.id === "aaa")!;
    const b = sessions.find((s) => s.id === "bbb")!;
    expect(a.source).toBe("studio");
    expect(b.source).toBe("mbp");
  });

  it("scanAllProjects dedupes the same sessionId across roots by canonical rank", () => {
    // agent file in root A, main file in root B — main must win despite newer agent mtime
    const agentPath = path.join(rootA, "-Users-x-proj", "agent-zzz.jsonl");
    const mainPath = path.join(rootB, "-Users-x-proj", "shared.jsonl");
    writeMinimalJsonl(agentPath, "shared");
    writeMinimalJsonl(mainPath, "shared");
    const future = Date.now() + 60000;
    fs.utimesSync(agentPath, future / 1000, future / 1000);

    const { sessions } = scanAllProjects([
      { source: "studio", path: rootA },
      { source: "mbp", path: rootB },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].path).toBe(mainPath);
    expect(sessions[0].source).toBe("mbp");
  });

  it("syncToDb persists source_machine", () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-srcdb-"));
    const db = openDb(path.join(dbDir, "t.sqlite"));
    try {
      syncToDb(db, [
        { id: "s1", path: "/a/x.jsonl", lastModified: Date.now(), fileSize: 10, source: "mbp" },
      ]);
      const row = db.db.query("SELECT source_machine FROM sessions WHERE id = 's1'").get() as { source_machine: string };
      expect(row.source_machine).toBe("mbp");
    } finally {
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe("Codex-format root discovery", () => {
  const codexFixtures = path.join(__dirname, "fixtures", "codex");

  beforeEach(() => clearDiscoveryCache());
  afterEach(() => clearDiscoveryCache());

  it("scans a codex root: id from session_meta, project from cwd, format tag", () => {
    const { sessions } = scanProjectsDir(codexFixtures, { format: "codex" });
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    // session id comes from session_meta, NOT the rollout filename
    const full = byId["new11111-0000-7000-8000-000000000002"];
    expect(full).toBeDefined();
    expect(full.format).toBe("codex");
    expect(full.projectDir).toBe("/work/proj-beta"); // grouping by cwd, not date path
    // old (2025) file with only payload.id still resolves
    expect(byId["old00000-0000-7000-8000-000000000001"]).toBeDefined();
  });

  it("persists format=codex and cwd-derived project to the DB", () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "convo-codexdb-"));
    const db = openDb(path.join(dbDir, "db.sqlite"));
    try {
      const { sessions } = scanProjectsDir(codexFixtures, { format: "codex" });
      syncToDb(db, sessions.map((s) => ({ ...s, source: "codex-studio" })));
      const row = db.db
        .query("SELECT format, project, source_machine FROM sessions WHERE id = 'new11111-0000-7000-8000-000000000002'")
        .get() as { format: string; project: string; source_machine: string };
      expect(row.format).toBe("codex");
      expect(row.project).toBe("/work/proj-beta");
      expect(row.source_machine).toBe("codex-studio");
    } finally {
      db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
