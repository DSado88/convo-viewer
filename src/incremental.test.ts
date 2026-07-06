import { describe, it, expect } from "vitest";
import { IncrementalParser } from "./incremental-parser.js";

describe("IncrementalParser — live update scenarios", () => {
  function makeSummaryLine(sessionId = "test-session") {
    return JSON.stringify({
      type: "summary",
      sessionId,
      cwd: "/test",
      version: "1.0.0",
    });
  }

  function makeUserLine(content: string, ts?: string) {
    return JSON.stringify({
      type: "user",
      message: { content },
      timestamp: ts ?? "2024-01-15T10:30:00Z",
    });
  }

  function makeAssistantLine(text: string, ts?: string) {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text }],
        model: "claude-sonnet-4-20250514",
      },
      timestamp: ts ?? "2024-01-15T10:30:05Z",
    });
  }

  it("feedLines returns new_turn updates for new messages", () => {
    const parser = new IncrementalParser();

    // Initial load
    const updates1 = parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
    ]);
    // Summary + user = at least 1 turn
    expect(updates1.length).toBeGreaterThanOrEqual(1);

    // Simulate live append — new assistant turn
    const updates2 = parser.feedLines([
      makeAssistantLine("Hi there!"),
    ]);
    expect(updates2.length).toBeGreaterThanOrEqual(1);

    const lastUpdate = updates2[updates2.length - 1];
    expect(lastUpdate.type).toBe("new_turn");
    expect(lastUpdate.turn.role).toBe("assistant");
  });

  it("accumulates turns correctly across multiple feedLines calls", () => {
    const parser = new IncrementalParser();

    parser.feedLines([makeSummaryLine(), makeUserLine("First")]);
    const count1 = parser.getTurns().length;

    parser.feedLines([makeAssistantLine("Response 1")]);
    const count2 = parser.getTurns().length;
    expect(count2).toBe(count1 + 1);

    parser.feedLines([makeUserLine("Second"), makeAssistantLine("Response 2")]);
    const count3 = parser.getTurns().length;
    expect(count3).toBe(count2 + 2);
  });

  it("handles empty lines gracefully", () => {
    const parser = new IncrementalParser();
    const updates = parser.feedLines(["", "", ""]);
    expect(updates).toEqual([]);
  });

  it("handles malformed JSON lines gracefully", () => {
    const parser = new IncrementalParser();
    // Should not throw
    const updates = parser.feedLines([
      makeSummaryLine(),
      "not valid json",
      makeUserLine("Hello"),
    ]);
    // Should still parse the valid lines
    expect(parser.getTurns().length).toBeGreaterThanOrEqual(1);
  });

  it("extracts metadata from summary line", () => {
    const parser = new IncrementalParser();
    parser.feedLines([
      JSON.stringify({
        type: "summary",
        sessionId: "abc-123",
        cwd: "/home/user/project",
        version: "2.0.0",
      }),
    ]);
    const meta = parser.getMetadata();
    expect(meta.sessionId).toBe("abc-123");
    expect(meta.projectDir).toBe("/home/user/project");
  });

  it("captures entrypoint as the agent (e.g. squall-spawned claude)", () => {
    const parser = new IncrementalParser();
    parser.feedLines([
      JSON.stringify({ type: "user", entrypoint: "squall", message: { content: "hi" }, timestamp: "2024-01-15T10:30:00Z" }),
    ]);
    expect(parser.getMetadata().agent).toBe("squall");
  });

  it("ignores a non-string entrypoint (no '[object Object]' garbage)", () => {
    const parser = new IncrementalParser();
    parser.feedLines([
      JSON.stringify({ type: "user", entrypoint: { x: 1 }, message: { content: "hi" }, timestamp: "2024-01-15T10:30:00Z" }),
    ]);
    expect(parser.getMetadata().agent).toBeNull();
  });

  it("simulates full live session: initial load then incremental appends", () => {
    const parser = new IncrementalParser();

    // Simulating what the server does: read file, split into lines, feedLines
    const initialLines = [
      makeSummaryLine("live-session"),
      makeUserLine("Start of conversation"),
      makeAssistantLine("Welcome!"),
    ];
    parser.feedLines(initialLines);
    expect(parser.getTurns().length).toBe(2); // user + assistant

    // Time passes, user sends another message (appended to file)
    const update1 = parser.feedLines([makeUserLine("Follow up question")]);
    expect(update1.some((u) => u.type === "new_turn")).toBe(true);
    expect(parser.getTurns().length).toBe(3);

    // Assistant responds
    const update2 = parser.feedLines([makeAssistantLine("Here's my answer")]);
    expect(update2.some((u) => u.type === "new_turn")).toBe(true);
    expect(parser.getTurns().length).toBe(4);
  });

  it("folds tool-result-only user messages into preceding assistant turn", () => {
    const parser = new IncrementalParser();

    parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
    ]);
    expect(parser.getTurns().length).toBe(1); // user

    // Assistant with tool use
    parser.feedLines([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/test.ts" } },
          ],
          model: "claude-sonnet-4-20250514",
        },
        timestamp: "2024-01-15T10:30:05Z",
      }),
    ]);
    expect(parser.getTurns().length).toBe(2); // user + assistant

    // User message with only tool results — should fold into assistant turn
    const toolResultMsg = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "file contents here" },
        ],
      },
      timestamp: "2024-01-15T10:30:06Z",
    });
    const updates = parser.feedLines([toolResultMsg]);

    // Should merge into the assistant turn, not create a new user turn
    expect(parser.getTurns().length).toBe(2);
    expect(updates.length).toBe(1);
    expect(updates[0].type).toBe("update_turn");
    // The assistant turn should now have the tool result block
    const assistantTurn = parser.getTurns()[1];
    expect(assistantTurn.role).toBe("assistant");
    expect(assistantTurn.blocks.some(b => b.type === "tool_result")).toBe(true);
  });

  it("does not fold tool results when no preceding assistant turn", () => {
    const parser = new IncrementalParser();

    // First message is a user message with only tool results (unusual but possible)
    const toolResultMsg = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "some result" },
        ],
      },
      timestamp: "2024-01-15T10:30:00Z",
    });

    const updates = parser.feedLines([toolResultMsg]);

    // No preceding assistant turn → creates a standalone user turn
    expect(parser.getTurns().length).toBe(1);
    expect(parser.getTurns()[0].role).toBe("user");
    expect(updates[0].type).toBe("new_turn");
  });

  it("skips system-noise-only user messages without creating empty turns", () => {
    const parser = new IncrementalParser();

    parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
      makeAssistantLine("Hi!"),
    ]);
    expect(parser.getTurns().length).toBe(2); // user + assistant

    // A system-noise-only user message (injected reminder, no real user text)
    const noiseMsg = JSON.stringify({
      type: "user",
      message: {
        content: "<system-reminder>The TodoWrite tool hasn't been used recently.</system-reminder>",
      },
      timestamp: "2024-01-15T10:31:00Z",
    });

    const updates = parser.feedLines([noiseMsg]);

    // Should NOT create a new empty turn
    expect(parser.getTurns().length).toBe(2);
    expect(updates).toEqual([]);
  });

  it("skips system-noise-only user messages in array content format", () => {
    const parser = new IncrementalParser();

    parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
      makeAssistantLine("Hi!"),
    ]);
    expect(parser.getTurns().length).toBe(2);

    // Array content where all text blocks are system noise
    const noiseMsg = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "text", text: "<system-reminder>Remember to use TodoWrite.</system-reminder>" },
          { type: "text", text: "<system-reminder>Another reminder here.</system-reminder>" },
        ],
      },
      timestamp: "2024-01-15T10:31:00Z",
    });

    const updates = parser.feedLines([noiseMsg]);

    expect(parser.getTurns().length).toBe(2);
    expect(updates).toEqual([]);
  });

  it("system-noise between assistant turns does not create phantom user turn", () => {
    const parser = new IncrementalParser();

    parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
      makeAssistantLine("Response 1"),
    ]);
    expect(parser.getTurns().length).toBe(2);

    // System noise inserted between two assistant-related messages
    const noiseMsg = JSON.stringify({
      type: "user",
      message: {
        content: "<system-reminder>Injected noise.</system-reminder>",
      },
      timestamp: "2024-01-15T10:31:00Z",
    });

    parser.feedLines([noiseMsg]);

    // Now a real user message follows
    parser.feedLines([makeUserLine("Follow up")]);
    parser.feedLines([makeAssistantLine("Response 2")]);

    // Should be: user(Hello) + assistant(R1) + user(Follow up) + assistant(R2) = 4
    // NOT 5 (with phantom empty user turn from noise)
    expect(parser.getTurns().length).toBe(4);

    // Verify no turn has empty blocks
    for (const turn of parser.getTurns()) {
      expect(turn.blocks.length).toBeGreaterThan(0);
    }
  });

  it("merges consecutive same-role assistant messages across feedLines calls", () => {
    const parser = new IncrementalParser();

    parser.feedLines([
      makeSummaryLine(),
      makeUserLine("Hello"),
    ]);
    expect(parser.getTurns().length).toBe(1); // user

    // First assistant message
    parser.feedLines([makeAssistantLine("Part 1")]);
    expect(parser.getTurns().length).toBe(2); // user + assistant

    // Second assistant message arrives in next feedLines — should merge, not create new turn
    const updates = parser.feedLines([makeAssistantLine("Part 2")]);
    expect(parser.getTurns().length).toBe(2); // still 2 — merged into existing assistant turn
    expect(updates.length).toBe(1);
    expect(updates[0].type).toBe("update_turn");
    expect(updates[0].turnIndex).toBe(1); // the assistant turn at index 1

    // The merged turn should have both text blocks
    const assistantTurn = parser.getTurns()[1];
    const textBlocks = assistantTurn.blocks.filter(b => b.type === "text");
    expect(textBlocks.length).toBe(2);
  });

  it("extracts version metadata from summary line", () => {
    const parser = new IncrementalParser();
    parser.feedLines([
      JSON.stringify({ type: "summary", sessionId: "v-test", cwd: "/test", version: "2.5.0" }),
    ]);
    const meta = parser.getMetadata();
    expect(meta.version).toBe("2.5.0");
  });
});
