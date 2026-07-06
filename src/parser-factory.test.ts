import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectFormat, createConversationParser, StreamingConversationParser } from "./parser-factory.js";
import { IncrementalParser } from "./incremental-parser.js";
import { CodexParser } from "./codex-parser.js";

const CODEX_FIX = path.join(__dirname, "fixtures", "codex");

describe("detectFormat", () => {
  it("classifies codex envelope types", () => {
    expect(detectFormat(JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/w" } }))).toBe("codex");
    expect(detectFormat(JSON.stringify({ type: "response_item", payload: {} }))).toBe("codex");
    expect(detectFormat(JSON.stringify({ type: "turn_context", payload: {} }))).toBe("codex");
  });
  it("defaults claude for claude lines and anything unrecognized", () => {
    expect(detectFormat(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBe("claude");
    expect(detectFormat(JSON.stringify({ type: "summary", sessionId: "s" }))).toBe("claude");
    expect(detectFormat(JSON.stringify({ type: "file-history-snapshot" }))).toBe("claude");
  });
  it("returns null for blank/unparseable lines", () => {
    expect(detectFormat("")).toBeNull();
    expect(detectFormat("   ")).toBeNull();
    expect(detectFormat("{not json")).toBeNull();
  });
});

describe("createConversationParser", () => {
  it("returns IncrementalParser directly when format=claude (no shim)", () => {
    expect(createConversationParser({ format: "claude" })).toBeInstanceOf(IncrementalParser);
  });
  it("returns CodexParser directly when format=codex", () => {
    expect(createConversationParser({ format: "codex" })).toBeInstanceOf(CodexParser);
  });
  it("returns a streaming sniffer when format is unknown", () => {
    expect(createConversationParser()).toBeInstanceOf(StreamingConversationParser);
  });
});

describe("StreamingConversationParser — sniff + delegate", () => {
  it("routes a codex file to CodexParser and parses it correctly", () => {
    const lines = fs.readFileSync(path.join(CODEX_FIX, "full-session.jsonl"), "utf-8").split("\n");
    const s = new StreamingConversationParser();
    s.feedLines(lines);
    expect(s.getMetadata().sessionId).toBe("new11111-0000-7000-8000-000000000002");
    expect(s.getTurns().map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("leading blank lines don't break detection", () => {
    const lines = ["", "  ", ...fs.readFileSync(path.join(CODEX_FIX, "web-search.jsonl"), "utf-8").split("\n")];
    const s = new StreamingConversationParser();
    s.feedLines(lines);
    expect(s.getMetadata().sessionId).toBe("web22222-0000-7000-8000-000000000003");
  });
});

// Golden safety-net: the factory's sniff path must be byte-identical to a
// direct IncrementalParser over REAL Claude sessions. Guarded-skip when no
// local corpus is present (CI). This guards the whole call-site refactor.
describe("factory equivalence on real Claude corpus", () => {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const sampleFiles: string[] = [];
  if (fs.existsSync(projectsDir)) {
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (sampleFiles.length >= 25) return;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith(".jsonl")) sampleFiles.push(fp);
      }
    };
    walk(projectsDir);
  }

  const maybeIt = sampleFiles.length > 0 ? it : it.skip;
  maybeIt("streaming sniff == direct IncrementalParser (turns + metadata)", () => {
    for (const fp of sampleFiles) {
      const content = fs.readFileSync(fp, "utf-8");
      // Cap huge files for test speed.
      if (content.length > 2_000_000) continue;
      const lines = content.split("\n");

      const direct = new IncrementalParser();
      direct.feedLines(lines);

      const viaFactory = new StreamingConversationParser();
      viaFactory.feedLines(lines);

      expect(JSON.stringify(viaFactory.getTurns())).toBe(JSON.stringify(direct.getTurns()));
      expect(viaFactory.getMetadata()).toEqual(direct.getMetadata());
    }
  });
});
