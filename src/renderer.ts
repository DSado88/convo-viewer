import { escape, renderMarkdownInline } from "./markdown.js";
import type { Turn, TocEntry, ToolUseBlock, ToolResultBlock } from "./types.js";

/**
 * Count Unicode code points (not UTF-16 code units).
 * Matches Python's len() behavior for strings with emoji/surrogate pairs.
 */
function codePointLength(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

/**
 * Slice a string by Unicode code point offsets (not UTF-16 code units).
 * Matches Python's s[:n] behavior for strings with emoji/surrogate pairs.
 */
function codePointSlice(s: string, start: number, end?: number): string {
  const codePoints = [...s];
  return codePoints.slice(start, end).join("");
}

/**
 * Format ISO8601 timestamp to readable local time.
 * Returns "H:MM AM/PM" (12-hour, no leading zero). Returns empty string on error.
 */
export function formatTimestamp(tsStr: string): string {
  if (!tsStr) return "";
  try {
    const normalized = tsStr.replace("Z", "+00:00");
    const dt = new Date(normalized);
    if (isNaN(dt.getTime())) return "";
    return dt
      .toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
  } catch {
    return "";
  }
}

/**
 * Extract the date portion from a timestamp string as "Mon D" (e.g. "Jan 5").
 * Returns empty string on error.
 */
export function formatDateShort(tsStr: string): string {
  if (!tsStr) return "";
  try {
    const dt = new Date(tsStr.replace("Z", "+00:00"));
    if (isNaN(dt.getTime())) return "";
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Get the calendar date key (YYYY-MM-DD local) for a timestamp.
 * Used to detect day boundaries between turns.
 */
export function dateKey(tsStr: string): string {
  if (!tsStr) return "";
  try {
    const dt = new Date(tsStr.replace("Z", "+00:00"));
    if (isNaN(dt.getTime())) return "";
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/**
 * Render a tool_use block to HTML.
 */
export function renderToolUse(block: ToolUseBlock): string {
  const name = escape(block.name);
  const inp = block.input ?? {};

  // Build a concise summary line
  let summary = "";
  if (["Read", "Glob", "Grep"].includes(block.name)) {
    const target =
      (inp.file_path as string) ??
      (inp.pattern as string) ??
      (inp.path as string) ??
      "";
    summary = escape(String(target));
  } else if (block.name === "Bash") {
    const cmd = String(inp.command ?? "");
    const desc = inp.description as string | undefined;
    summary = escape(desc ? desc : cmd.slice(0, 200));
  } else if (block.name === "Edit" || block.name === "Write") {
    summary = escape(String(inp.file_path ?? ""));
  } else if (block.name === "Agent") {
    summary = escape(String(inp.description ?? ""));
  } else {
    for (const key of ["query", "prompt", "url", "pattern", "message"]) {
      if (key in inp) {
        summary = escape(String(inp[key]).slice(0, 150));
        break;
      }
    }
  }

  const fullInput = escape(JSON.stringify(inp, null, 2));
  const summaryHtml = summary
    ? `<span class="tool-summary">${summary}</span>`
    : "";

  return `<div class="tool-use">
  <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span class="tool-icon">&#9881;</span>
    <span class="tool-name">${name}</span>
    ${summaryHtml}
    <span class="tool-expand">&#9660;</span>
  </div>
  <pre class="tool-detail">${fullInput}</pre>
</div>`;
}

/**
 * Format a number with locale-aware thousands separators (e.g. 1,234).
 */
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Build the clickable header row shared by all tool-result variants. */
function resultHeader(isError: boolean, charCount?: number): string {
  const label = isError ? "Error" : "Result";
  const size = charCount != null ? ` (${formatCount(charCount)} chars)` : "";
  return `<div class="tool-result-header" onclick="this.parentElement.classList.toggle('expanded')">
    <span>${label}${size}</span>
    <span class="tool-expand">&#9660;</span>
  </div>`;
}

/**
 * Render a tool_result block to HTML.
 */
export function renderToolResult(block: ToolResultBlock): string {
  const content = block.content ?? "";
  const isError = block.isError ?? false;
  const errorClass = isError ? " tool-error" : "";

  const metaHtml = block.meta
    ? `<div class="tool-result-meta">${escape(block.meta)}</div>`
    : "";

  // Use code-point length to match Python's len() for char counts
  const cpLen = codePointLength(content);

  // Agent results with real content get rendered as markdown text
  const trimmed = content.trimStart();
  if (cpLen > 500 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const rendered = renderMarkdownInline(content);
    return `<div class="tool-result agent-result${errorClass}">
  ${resultHeader(isError, cpLen)}
  <div class="tool-result-rendered"><p>${rendered}</p></div>
  ${metaHtml}
</div>`;
  }

  // Short or structured results: show as preformatted text
  if (cpLen > 2000) {
    const preview = escape(codePointSlice(content, 0, 2000));
    const display = escape(content);
    return `<div class="tool-result${errorClass}">
  ${resultHeader(isError, cpLen)}
  <pre class="tool-result-preview">${preview}\u2026</pre>
  <pre class="tool-result-full">${display}</pre>
  ${metaHtml}
</div>`;
  }

  return `<div class="tool-result${errorClass}">
  ${resultHeader(isError)}
  <pre class="tool-result-preview">${escape(content)}</pre>
  ${metaHtml}
</div>`;
}

/**
 * Render a full turn to HTML.
 * Returns { html, tocEntry } where tocEntry is non-null for user turns.
 */
export function renderTurn(
  turn: Turn,
  turnIndex: number,
  includeThinking: boolean,
  includeTools: boolean,
  prevTimestamp?: string,
  assistantLabel: string = "Claude",
): { html: string; tocEntry: TocEntry | null } {
  const role = turn.role;
  const timestamp = formatTimestamp(turn.timestamp ?? "");
  const blocksHtml: string[] = [];
  let firstText = "";
  let textBlockIdx = 0;

  for (const block of turn.blocks) {
    switch (block.type) {
      case "text": {
        const rendered = renderMarkdownInline(block.text);
        blocksHtml.push(
          `<div class="message-text" data-block-index="${textBlockIdx}"><p>${rendered}</p></div>`,
        );
        textBlockIdx++;
        if (!firstText.trim()) firstText = block.text;
        break;
      }

      case "slash_command": {
        const cmd = escape(block.command);
        blocksHtml.push(
          `<div class="slash-command"><span class="slash-cmd">${cmd}</span></div>`,
        );
        if (!firstText.trim()) firstText = block.command;
        break;
      }

      case "session_continuation": {
        const summary = renderMarkdownInline(block.text ?? "");
        blocksHtml.push(
          `<details class="session-divider">` +
            `<summary><span>Session continued</span></summary>` +
            `<div class="session-summary"><p>${summary}</p></div>` +
            `</details>`,
        );
        if (!firstText.trim()) firstText = "--- Session continued ---";
        break;
      }

      case "thinking": {
        if (includeThinking) {
          const text = escape(block.text);
          blocksHtml.push(
            `<details class="thinking"><summary>Thinking</summary>` +
              `<pre>${text}</pre></details>`,
          );
        }
        break;
      }

      case "tool_use": {
        if (includeTools) {
          blocksHtml.push(renderToolUse(block));
        }
        break;
      }

      case "tool_result": {
        if (includeTools) {
          blocksHtml.push(renderToolResult(block));
        }
        break;
      }
    }
  }

  // Skip turns with no visible content
  if (blocksHtml.length === 0) {
    return { html: "", tocEntry: null };
  }

  const turnId = `turn-${turnIndex}`;
  const contentHtml = blocksHtml.join("\n");
  const label = role === "user" ? "You" : assistantLabel;

  // Show date when it changes from previous turn
  const curDate = dateKey(turn.timestamp ?? "");
  const prevDate = dateKey(prevTimestamp ?? "");
  const dateDividerHtml = curDate && curDate !== prevDate
    ? `<div class="date-divider"><span>${formatDateShort(turn.timestamp ?? "")}</span></div>\n`
    : "";

  const tsHtml = timestamp
    ? `<span class="timestamp">${timestamp}</span>`
    : "";

  const html = `${dateDividerHtml}<div class="turn ${role}" id="${turnId}">
  <div class="turn-header">
    <span class="role-label">${label}</span>
    ${tsHtml}
  </div>
  <div class="turn-body">
    ${contentHtml}
  </div>
</div>`;

  // Build TOC entry for user turns
  const tocEntry: TocEntry = {
    id: turnId,
    role,
    label,
    timestamp,
    preview: firstText ? firstText.replace(/\n/g, " ").trim().slice(0, 120) : "",
  };

  return { html, tocEntry };
}
