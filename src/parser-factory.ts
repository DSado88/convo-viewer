import type { ConversationParser, TurnUpdate, Turn, ConversationMetadata } from "./types.js";
import { IncrementalParser } from "./incremental-parser.js";
import { CodexParser } from "./codex-parser.js";

export type ConversationFormat = "claude" | "codex";

/** Root `type` values that only appear in Codex rollout files. */
const CODEX_LINE_TYPES = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
]);

/**
 * Classify a single JSONL line's format. Codex is only chosen on a definitive
 * signature (a Codex-specific envelope `type`, or a session_meta-shaped
 * payload). Everything else — including Claude's `summary` /
 * `file-history-snapshot` / `user` / `assistant` lines and anything
 * unrecognized — defaults to `claude`. Returns null only for blank/unparseable
 * lines, signalling "keep looking".
 */
export function detectFormat(line: string): ConversationFormat | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    obj = parsed;
  } catch {
    return null;
  }
  const t = obj.type;
  if (typeof t === "string" && CODEX_LINE_TYPES.has(t)) return "codex";
  // Defensive: a session_meta-shaped payload even if the envelope type differs.
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload === "object" && (payload.session_id || payload.id) && payload.cwd) {
    return "codex";
  }
  return "claude";
}

/** Instantiate the concrete parser for a known format. */
export function parserForFormat(format: ConversationFormat): ConversationParser {
  return format === "codex" ? new CodexParser() : new IncrementalParser();
}

/**
 * A parser that defers format detection to the first parseable line, then
 * delegates every fed line to the appropriate concrete parser. Buffered lines
 * are replayed through the delegate so no metadata is lost. Used when the
 * format isn't known up front (single-file export, untagged scan root,
 * live-tail attaching from line 1).
 */
export class StreamingConversationParser implements ConversationParser {
  private delegate: ConversationParser | null = null;
  private buffer: string[] = [];
  private sniffed = 0;
  /** Cap undetected buffering; past this we commit to claude and replay. */
  private static readonly SNIFF_LIMIT = 64;

  feedLines(lines: string[]): TurnUpdate[] {
    if (this.delegate) return this.delegate.feedLines(lines);

    for (let i = 0; i < lines.length; i++) {
      const fmt = detectFormat(lines[i]);
      this.buffer.push(lines[i]);
      this.sniffed++;
      if (fmt !== null || this.sniffed >= StreamingConversationParser.SNIFF_LIMIT) {
        this.delegate = parserForFormat(fmt ?? "claude");
        const buffered = this.buffer;
        this.buffer = [];
        // Replay buffered lines plus any remaining lines in this call.
        return this.delegate.feedLines([...buffered, ...lines.slice(i + 1)]);
      }
    }
    // Still undetermined (all blank/unparseable so far) — keep buffering.
    return [];
  }

  getTurns(): Turn[] {
    return this.delegate?.getTurns() ?? [];
  }

  getMetadata(): ConversationMetadata {
    return (
      this.delegate?.getMetadata() ?? {
        sessionId: null,
        projectDir: null,
        model: null,
        version: null,
        startTime: null,
      }
    );
  }

  /** The format of the chosen delegate, or null if not yet detected. */
  get delegateFormat(): ConversationFormat | null {
    if (!this.delegate) return null;
    return this.delegate instanceof CodexParser ? "codex" : "claude";
  }
}

/** Human-facing assistant label for a parser's format ("Codex" | "Claude"). */
export function assistantLabelFor(parser: ConversationParser): string {
  const fmt =
    parser instanceof CodexParser
      ? "codex"
      : parser instanceof StreamingConversationParser
        ? parser.delegateFormat
        : "claude";
  return fmt === "codex" ? "Codex" : "Claude";
}

/**
 * Create a parser. When `format` is known (from a scan root's tag), return the
 * concrete parser directly — zero per-line delegation overhead on the hot
 * Claude path. When unknown, return a streaming sniffer.
 */
export function createConversationParser(opts?: { format?: ConversationFormat }): ConversationParser {
  if (opts?.format) return parserForFormat(opts.format);
  return new StreamingConversationParser();
}
