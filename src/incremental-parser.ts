import type { Block, Turn, ConversationParser, ConversationMetadata, TurnUpdate } from "./types.js";
import { cleanUserText, isSystemNoise } from "./text-cleaning.js";

// Re-exported for back-compat: TurnUpdate now lives in types.ts.
export type { TurnUpdate } from "./types.js";

/**
 * Stateful incremental parser for Claude Code JSONL conversations.
 *
 * Mirrors the exact parsing logic of `buildConversation()` but can be
 * fed lines incrementally, returning per-turn deltas.
 */
export class IncrementalParser implements ConversationParser {
  private turns: Turn[] = [];
  private currentTurn: Turn | null = null;
  private sessionId: string | null = null;
  private projectDir: string | null = null;
  private model: string | null = null;
  private startTime: string | null = null;
  private version: string | null = null;
  private agent: string | null = null;

  /**
   * Feed one or more raw JSONL lines (already split on "\n").
   * Returns an array of TurnUpdate deltas describing what changed.
   */
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

      const message = (obj.message as Record<string, unknown>) ?? {};

      // Grab metadata on first occurrence — coerce to string for safety
      if (!this.sessionId) {
        const msgSid = message.sessionId;
        const rootSid = obj.sessionId;
        if (msgSid) this.sessionId = typeof msgSid === "string" ? msgSid : String(msgSid);
        else if (rootSid) this.sessionId = typeof rootSid === "string" ? rootSid : String(rootSid);
      }
      if (!this.projectDir && obj.cwd) {
        const raw = obj.cwd;
        this.projectDir = typeof raw === "string" ? raw : String(raw);
      }
      if (!this.version && obj.version) {
        const raw = obj.version;
        this.version = typeof raw === "string" ? raw : String(raw);
      }
      if (!this.agent && typeof obj.entrypoint === "string") {
        this.agent = obj.entrypoint;
      }

      const msgType = obj.type as string | undefined;
      if (msgType !== "user" && msgType !== "assistant") continue;

      const content = (message.content as string | unknown[] | undefined) ?? "";
      const rawTs = obj.timestamp;
      const timestamp = typeof rawTs === "string" ? rawTs : rawTs != null ? String(rawTs) : "";

      if (!this.startTime && timestamp) {
        this.startTime = timestamp;
      }
      if (!this.model && message.model) {
        const raw = message.model;
        this.model = typeof raw === "string" ? raw : String(raw);
      }

      let hasUserText = false;
      let hasToolResults = false;
      const parsedBlocks: Block[] = [];

      if (typeof content === "string" && content.trim()) {
        if (msgType === "user") {
          const cmdMatch = content.match(/<command-name>\s*(\/[\w:-]+)\s*<\/command-name>/);
          const cmdArgsMatch = content.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);

          if (isSystemNoise(content)) {
            if (cmdMatch) {
              const cmd = cmdMatch[1];
              const args = cmdArgsMatch ? cmdArgsMatch[1].trim() : "";
              const label = args ? `${cmd} ${args}`.trim() : cmd;
              parsedBlocks.push({ type: "slash_command", command: label });
              hasUserText = true;
            } else if (content.trim().startsWith("This session is being continued")) {
              parsedBlocks.push({ type: "session_continuation", text: content.trim() });
              hasUserText = true;
            }
            // Otherwise skip entirely
          } else {
            const cleaned = cleanUserText(content);
            if (cleaned) {
              hasUserText = true;
              parsedBlocks.push({ type: "text", text: cleaned });
            }
          }
        } else {
          hasUserText = true;
          parsedBlocks.push({ type: "text", text: content });
        }
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
          const block = item as Record<string, unknown>;
          const blockType = (block.type as string) ?? "";

          if (blockType === "text") {
            const rawText = block.text;
            const text = typeof rawText === "string" ? rawText : rawText != null ? String(rawText) : "";
            if (text.trim()) {
              if (msgType === "user") {
                if (isSystemNoise(text)) {
                  // Mirror the string-content path: detect slash commands and session continuations inside noise
                  const cmdMatch = text.match(/<command-name>\s*(\/[\w:-]+)\s*<\/command-name>/);
                  if (cmdMatch) {
                    const cmdArgsMatch = text.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
                    const cmd = cmdMatch[1];
                    const args = cmdArgsMatch ? cmdArgsMatch[1].trim() : "";
                    const label = args ? `${cmd} ${args}`.trim() : cmd;
                    parsedBlocks.push({ type: "slash_command", command: label });
                    hasUserText = true;
                  } else if (text.trim().startsWith("This session is being continued")) {
                    parsedBlocks.push({ type: "session_continuation", text: text.trim() });
                    hasUserText = true;
                  }
                  continue;
                }
                const cleaned = cleanUserText(text);
                if (cleaned) {
                  hasUserText = true;
                  parsedBlocks.push({ type: "text", text: cleaned });
                }
              } else {
                hasUserText = true;
                parsedBlocks.push({ type: "text", text });
              }
            }
          } else if (blockType === "thinking") {
            const rawThinking = block.thinking;
            const thinking = typeof rawThinking === "string" ? rawThinking : rawThinking != null ? String(rawThinking) : "";
            if (thinking.trim()) {
              parsedBlocks.push({ type: "thinking", text: thinking });
            }
          } else if (blockType === "tool_use") {
            const rawName = block.name;
            const rawId = block.id;
            parsedBlocks.push({
              type: "tool_use",
              name: typeof rawName === "string" ? rawName : rawName != null ? String(rawName) : "unknown",
              input: (block.input as Record<string, unknown>) ?? {},
              id: typeof rawId === "string" ? rawId : rawId != null ? String(rawId) : "",
            });
          } else if (blockType === "tool_result") {
            hasToolResults = true;
            const resultContent = (block.content as string | unknown[] | undefined) ?? "";
            const isError = block.is_error === true;

            let resultText: string;
            let metaText: string | null = null;

            if (Array.isArray(resultContent)) {
              const textParts: string[] = [];
              const metaParts: string[] = [];
              for (const rc of resultContent) {
                if (typeof rc === "object" && rc !== null && !Array.isArray(rc)) {
                  const rcObj = rc as Record<string, unknown>;
                  if (rcObj.type === "text") {
                    const rawT = rcObj.text;
                    const t = typeof rawT === "string" ? rawT : rawT != null ? String(rawT) : "";
                    if (t.trim().startsWith("agentId:") || t.trim().startsWith("<usage>")) {
                      metaParts.push(t);
                    } else {
                      textParts.push(t);
                    }
                  }
                } else if (typeof rc === "string") {
                  textParts.push(rc);
                }
              }
              resultText = textParts.join("\n");
              metaText = metaParts.length > 0 ? metaParts.join("\n") : null;
            } else {
              resultText = typeof resultContent === "string" ? resultContent : String(resultContent);
            }

            const rawToolUseId = block.tool_use_id;
            parsedBlocks.push({
              type: "tool_result",
              content: resultText,
              meta: metaText,
              isError,
              toolUseId: typeof rawToolUseId === "string" ? rawToolUseId : rawToolUseId != null ? String(rawToolUseId) : "",
            });
          }
        }
      }

      // Skip messages that produced no blocks (e.g., pure system noise)
      if (parsedBlocks.length === 0) continue;

      // Tool result folding: user messages with only tool_results merge into preceding assistant turn
      if (msgType === "user" && hasToolResults && !hasUserText) {
        if (this.currentTurn && this.currentTurn.role === "assistant") {
          this.currentTurn.blocks.push(...parsedBlocks);
          updates.push({ type: "update_turn", turnIndex: this.turns.length - 1, turn: this.currentTurn });
          continue;
        }
      }

      const role = msgType as "user" | "assistant";

      // Merge consecutive same-role messages into one turn
      if (this.currentTurn && this.currentTurn.role === role) {
        this.currentTurn.blocks.push(...parsedBlocks);
        updates.push({ type: "update_turn", turnIndex: this.turns.length - 1, turn: this.currentTurn });
      } else {
        this.currentTurn = { role, timestamp, blocks: parsedBlocks };
        this.turns.push(this.currentTurn);
        const idx = this.turns.length - 1;
        updates.push({ type: "new_turn", turnIndex: idx, turn: this.currentTurn });
      }
    }

    return updates;
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
}
