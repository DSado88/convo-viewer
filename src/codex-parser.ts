import type { Block, Turn, ConversationParser, ConversationMetadata, TurnUpdate } from "./types.js";
import { cleanUserText } from "./text-cleaning.js";

/** Placeholder shown for reasoning items Codex only stores encrypted. */
export const CODEX_ENCRYPTED_REASONING = "🔒 Reasoning (encrypted by Codex)";

/**
 * Prefixes marking a whole user item as a context injection (not a real
 * prompt). Matched against the message START only — a real prompt that merely
 * mentions these tokens mid-text must be kept.
 */
const CODEX_USER_NOISE_PREFIXES = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions"];

/** Filename pattern: rollout-<ISO-ish timestamp>-<uuid>.jsonl */
const ROLLOUT_RE = /^rollout-(\d{4}-\d{2}-\d{2}T[\d-]+)-([0-9a-f-]{36})$/i;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as any).text === "string" ? (c as any).text : ""))
      .join("");
  }
  return "";
}

/** Parse a JSON-string tool argument into an object; wrap non-JSON/raw as { raw }. */
function parseToolInput(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return { raw: s };
}

/** Tool output is often a JSON string wrapping { output, metadata }. Unwrap to readable text. */
function unwrapToolOutput(raw: unknown): string {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as any).output === "string") {
      return (parsed as any).output;
    }
  } catch {
    /* not wrapped — return as-is */
  }
  return s;
}

/**
 * Stateful parser for Codex CLI rollout JSONL. Emits the same Turn[]/Block[]
 * shape as the Claude IncrementalParser so all downstream consumers are
 * format-agnostic. Assistant-side items (reasoning, tool calls, tool outputs,
 * assistant text) accumulate into one assistant turn until the next user
 * message.
 */
export class CodexParser implements ConversationParser {
  private turns: Turn[] = [];
  private currentTurn: Turn | null = null;
  private sessionId: string | null = null;
  private projectDir: string | null = null;
  private model: string | null = null;
  private version: string | null = null;
  private startTime: string | null = null;
  private agent: string | null = null;
  /** Guard: at most one redacted-reasoning marker per assistant turn. */
  private turnHasRedacted = false;
  /** Diagnostic: counts of skipped/unrecognized response_item subtypes. */
  readonly skipped: Record<string, number> = {};

  feedLines(lines: string[]): TurnUpdate[] {
    const updates: TurnUpdate[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        obj = parsed;
      } catch {
        continue;
      }

      const type = obj.type as string | undefined;
      const payload = (obj.payload as Record<string, unknown>) ?? {};
      const envTs = typeof obj.timestamp === "string" ? obj.timestamp : "";

      if (type === "session_meta") {
        const sid = payload.session_id ?? payload.id;
        if (sid && !this.sessionId) this.sessionId = String(sid);
        if (payload.cwd && !this.projectDir) this.projectDir = String(payload.cwd);
        if (payload.cli_version && !this.version) this.version = String(payload.cli_version);
        if (typeof payload.originator === "string" && !this.agent) this.agent = payload.originator;
        if (!this.startTime && envTs) this.startTime = envTs;
        continue;
      }
      if (type === "turn_context") {
        if (payload.model && !this.model) this.model = String(payload.model);
        continue;
      }
      if (type !== "response_item") continue; // event_msg and anything else: ignore

      const blocks = this.blocksFor(payload, envTs);
      for (const b of blocks) updates.push(...this.push(b.role, b.block, envTs));
    }
    return updates;
  }

  /** Translate one response_item payload into zero or more (role, block) pairs. */
  private blocksFor(p: Record<string, unknown>, ts: string): Array<{ role: "user" | "assistant"; block: Block }> {
    const st = p.type as string | undefined;
    switch (st) {
      case "message": {
        const role = p.role as string | undefined;
        if (role === "developer") return []; // instructions injection
        const text = textOf(p.content);
        if (role === "user") {
          const head = text.trimStart();
          if (CODEX_USER_NOISE_PREFIXES.some((m) => head.startsWith(m))) return [];
          const cleaned = cleanUserText(text);
          if (!cleaned.trim()) return [];
          return [{ role: "user", block: { type: "text", text: cleaned } }];
        }
        // assistant (or unknown role treated as assistant output)
        if (!text.trim()) return [];
        return [{ role: "assistant", block: { type: "text", text } }];
      }
      case "reasoning": {
        const summary = p.summary;
        const summaryText = Array.isArray(summary)
          ? summary.map((s) => (s && typeof s === "object" ? String((s as any).text ?? "") : "")).join("\n").trim()
          : "";
        if (summaryText) return [{ role: "assistant", block: { type: "thinking", text: summaryText } }];
        // Empty summary → encrypted-only. One marker per assistant turn.
        if (this.turnHasRedacted) return [];
        return [{ role: "assistant", block: { type: "thinking", text: CODEX_ENCRYPTED_REASONING } }];
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call": {
        return [{
          role: "assistant",
          block: {
            type: "tool_use",
            name: String(p.name ?? st),
            input: parseToolInput(p.arguments ?? p.input),
            id: p.call_id ? String(p.call_id) : "",
          },
        }];
      }
      case "web_search_call":
      case "tool_search_call": {
        const action = (p.action as Record<string, unknown>) ?? {};
        const input = action.query != null ? { query: String(action.query) } : parseToolInput(p.action);
        return [{
          role: "assistant",
          block: { type: "tool_use", name: st === "web_search_call" ? "web_search" : "tool_search", input, id: p.call_id ? String(p.call_id) : "" },
        }];
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "tool_search_output": {
        return [{
          role: "assistant",
          block: {
            type: "tool_result",
            content: unwrapToolOutput(p.output ?? p.tools ?? p.content),
            isError: false,
            toolUseId: p.call_id ? String(p.call_id) : "",
          },
        }];
      }
      default: {
        if (st) this.skipped[st] = (this.skipped[st] ?? 0) + 1;
        return [];
      }
    }
  }

  /** Append a block to the current turn (merging same-role), returning deltas. */
  private push(role: "user" | "assistant", block: Block, ts: string): TurnUpdate[] {
    if (block.type === "thinking" && block.text === CODEX_ENCRYPTED_REASONING) {
      this.turnHasRedacted = true;
    }
    if (this.currentTurn && this.currentTurn.role === role) {
      this.currentTurn.blocks.push(block);
      return [{ type: "update_turn", turnIndex: this.turns.length - 1, turn: this.currentTurn }];
    }
    this.currentTurn = { role, timestamp: ts, blocks: [block] };
    this.turnHasRedacted = block.type === "thinking" && block.text === CODEX_ENCRYPTED_REASONING;
    this.turns.push(this.currentTurn);
    return [{ type: "new_turn", turnIndex: this.turns.length - 1, turn: this.currentTurn }];
  }

  getTurns(): Turn[] {
    return this.turns;
  }

  getMetadata(): ConversationMetadata {
    return {
      sessionId: this.sessionId,
      projectDir: this.projectDir,
      model: this.model,
      version: this.version,
      startTime: this.startTime,
      agent: this.agent,
    };
  }

  /** Recover session id + start time from a rollout-*.jsonl filename. */
  static fromFilename(stem: string): { sessionId?: string; startTime?: string } {
    const m = stem.match(ROLLOUT_RE);
    if (!m) return {};
    return { sessionId: m[2], startTime: m[1] };
  }
}
