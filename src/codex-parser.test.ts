import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodexParser } from "./codex-parser.js";
import type { Block, Turn } from "./types.js";

const FIX = path.join(__dirname, "fixtures", "codex");
function lines(name: string): string[] {
  return fs.readFileSync(path.join(FIX, name), "utf-8").split("\n");
}
function parse(name: string): CodexParser {
  const p = new CodexParser();
  p.feedLines(lines(name));
  return p;
}
const texts = (t: Turn) => t.blocks.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text);
const kinds = (t: Turn) => t.blocks.map((b) => b.type);

describe("CodexParser — metadata", () => {
  it("reads session_id from new files", () => {
    const m = parse("full-session.jsonl").getMetadata();
    expect(m.sessionId).toBe("new11111-0000-7000-8000-000000000002");
    expect(m.projectDir).toBe("/work/proj-beta");
    expect(m.model).toBe("gpt-5.1-codex-max"); // from turn_context, not model_provider
    expect(m.version).toBe("0.142.0");
  });

  it("falls back to payload.id on old (2025) files with no session_id", () => {
    const m = parse("old-id-only.jsonl").getMetadata();
    expect(m.sessionId).toBe("old00000-0000-7000-8000-000000000001");
    expect(m.projectDir).toBe("/work/proj-alpha");
    expect(m.model).toBe("gpt-5-codex");
    expect(m.startTime).toBe("2025-11-30T15:09:39.435Z");
  });
});

describe("CodexParser — turns & mapping", () => {
  it("emits user turn then assistant turn, dropping developer + env/instruction items", () => {
    const turns = parse("full-session.jsonl").getTurns();
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    // developer + <environment_context> + <user_instructions> items dropped
    expect(texts(turns[0])).toEqual(["Please add a test for the parser."]);
  });

  it("renders reasoning summary_text as thinking, one redacted marker per turn for empty reasoning", () => {
    const asst = parse("full-session.jsonl").getTurns()[1];
    const thinking = asst.blocks.filter((b) => b.type === "thinking") as Extract<Block, { type: "thinking" }>[];
    expect(thinking.length).toBe(2); // 1 real summary + 1 redacted (two consecutive empties collapse)
    expect(thinking[0].text).toBe("Planning the test file");
    expect(thinking[1].text.toLowerCase()).toContain("encrypted");
  });

  it("maps function_call (JSON-string args) to tool_use and unwraps function_call_output", () => {
    const asst = parse("full-session.jsonl").getTurns()[1];
    const toolUse = asst.blocks.find((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>;
    expect(toolUse.name).toBe("run_tests");
    expect(toolUse.input).toEqual({ path: "test/" });
    const result = asst.blocks.find((b) => b.type === "tool_result") as Extract<Block, { type: "tool_result" }>;
    expect(result.content).toContain("3 passed");
    expect(result.content).not.toContain("metadata"); // wrapper unwrapped
    expect(result.toolUseId).toBe("call_A");
  });

  it("block order within the assistant turn is preserved", () => {
    const asst = parse("full-session.jsonl").getTurns()[1];
    expect(kinds(asst)).toEqual(["thinking", "thinking", "tool_use", "tool_result", "text"]);
  });

  it("maps web_search_call (self-contained, no output line)", () => {
    const asst = parse("web-search.jsonl").getTurns()[1];
    const tu = asst.blocks.find((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>;
    expect(tu.name).toBe("web_search");
    expect(JSON.stringify(tu.input)).toContain("vitest snapshot testing");
  });

  it("maps custom_tool_call with raw (non-JSON) input and unwraps its output", () => {
    const asst = parse("custom-tool.jsonl").getTurns()[1];
    const tu = asst.blocks.find((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>;
    expect(tu.name).toBe("apply_patch");
    expect(JSON.stringify(tu.input)).toContain("Begin Patch");
    const res = asst.blocks.find((b) => b.type === "tool_result") as Extract<Block, { type: "tool_result" }>;
    expect(res.content).toContain("Success");
    expect(res.content).not.toContain("duration_seconds");
  });

  it("keeps a real user prompt that merely mentions injection tokens mid-text", () => {
    // Regression: a prompt discussing "<environment_context>" must not be
    // dropped — only whole messages that START with an injection marker are.
    const p = new CodexParser();
    p.feedLines([
      JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/w" }, timestamp: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Explain how <environment_context> is injected by Codex." }] } }),
    ]);
    const turns = p.getTurns();
    expect(turns.length).toBe(1);
    expect(texts(turns[0])[0]).toContain("Explain how");
  });

  it("no-ops on unknown/ghost subtypes without throwing", () => {
    const p = parse("unknown-subtype.jsonl");
    const turns = p.getTurns();
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(texts(turns[0])).toEqual(["hi"]);
    expect(texts(turns[1])).toEqual(["ok"]);
  });
});

describe("CodexParser — streaming equals batch", () => {
  it("produces identical turns fed line-by-line vs all-at-once", () => {
    const all = parse("full-session.jsonl").getTurns();
    const inc = new CodexParser();
    for (const l of lines("full-session.jsonl")) inc.feedLines([l]);
    expect(JSON.stringify(inc.getTurns())).toBe(JSON.stringify(all));
  });

  it("does not duplicate the open assistant turn across incremental feeds", () => {
    const inc = new CodexParser();
    for (const l of lines("full-session.jsonl")) inc.feedLines([l]);
    expect(inc.getTurns().filter((t) => t.role === "assistant").length).toBe(1);
  });
});
