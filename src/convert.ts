import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildConversation } from "./parser.js";
import { renderTurn } from "./renderer.js";
import { escape } from "./markdown.js";
import {
  buildHtmlPage,
  safeForScript,
  type HtmlPageParams,
} from "./templates/html-template.js";
import { updateIndex } from "./index-page.js";
import { openDb } from "./db.js";
import type { Conversation, TocEntry, TextBlock } from "./types.js";
import type { SidecarAnnotation } from "./db.js";

/**
 * Build the HtmlPageParams from a parsed Conversation.
 *
 * This is a pure function that renders all turns and assembles every field
 * needed by `buildHtmlPage()`.  Both the static converter and the live
 * server call this so the rendering logic is shared.
 */
export function buildPageParams(
  convo: Conversation,
  inputPath: string,
  viewerDir: string,
  options?: {
    includeThinking?: boolean;
    includeTools?: boolean;
    extraScript?: string;
    mode?: "inline" | "server";
    wsUrl?: string;
    assistantLabel?: string;
  }
): HtmlPageParams {
  const includeThinking = options?.includeThinking ?? true;
  const includeTools = options?.includeTools ?? true;
  const assistantLabel = options?.assistantLabel ?? "Claude";

  const sessionId = convo.sessionId || path.parse(inputPath).name;

  // Render turns
  const turnsHtml: string[] = [];
  const tocEntries: TocEntry[] = [];

  for (let i = 0; i < convo.turns.length; i++) {
    const prevTs = i > 0 ? convo.turns[i - 1].timestamp : undefined;
    const { html, tocEntry } = renderTurn(
      convo.turns[i],
      i,
      includeThinking,
      includeTools,
      prevTs,
      assistantLabel
    );
    if (html) {
      turnsHtml.push(html);
    }
    if (tocEntry) {
      tocEntries.push(tocEntry);
    }
  }

  // Build metadata
  const metaParts: string[] = [];

  if (convo.startTime) {
    try {
      const dt = new Date(convo.startTime);
      if (!isNaN(dt.getTime())) {
        const formatted = dt.toLocaleString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        metaParts.push(`<span>${formatted}</span>`);
      }
    } catch {
      // ignore date parse errors
    }
  }
  if (convo.model) {
    metaParts.push(`<span>Model: ${escape(convo.model)}</span>`);
  }
  if (convo.projectDir) {
    metaParts.push(`<span>${escape(convo.projectDir)}</span>`);
  }
  if (convo.version) {
    metaParts.push(`<span>Claude Code v${escape(convo.version)}</span>`);
  }

  const turnCount = convo.turns.length;
  const userTurns = convo.turns.filter((t) => t.role === "user").length;
  metaParts.push(`<span>${turnCount} turns (${userTurns} user)</span>`);

  // Title: "ProjectName — session-uuid" or just "session-uuid"
  const projectName = convo.projectDir
    ? convo.projectDir.replace(/\/+$/, "").split("/").pop() ?? ""
    : "";
  const title = projectName
    ? `${projectName} — ${sessionId}`
    : sessionId;

  // Build TOC
  const tocItems: string[] = [];
  for (const entry of tocEntries) {
    const preview = entry.preview ? escape(entry.preview) : "(no text)";
    const ts = entry.timestamp
      ? `<span class="toc-time">${escape(entry.timestamp)}</span>`
      : "";
    const label = escape(entry.label);
    tocItems.push(
      `<div class="toc-item toc-${entry.role}" onclick="document.getElementById('${entry.id}').scrollIntoView({behavior:'smooth',block:'start'});closeToc();">` +
        `<div class="toc-item-header"><span class="toc-role">${label}</span>${ts}</div>` +
        `<div class="toc-item-preview">${preview}</div>` +
        `</div>`
    );
  }
  const tocHtml = tocItems.join("\n");

  // Build metadata comment for index page parsing
  const metaJson = JSON.stringify({
    session_id: sessionId,
    short_id: sessionId.slice(0, 8),
    project_dir: convo.projectDir || "",
    model: convo.model || "",
    start_time: convo.startTime || "",
    turn_count: turnCount,
    user_turns: userTurns,
  });
  // Escape > as \u003e in JSON to prevent --> from breaking the HTML comment
  const safeMetaJson = metaJson.replace(/>/g, "\\u003e");
  const metaComment = `<!-- CONVO_META:${safeMetaJson} -->`;

  // Build lightweight conversation data for JS (text blocks only)
  const convoData = convo.turns.map((turn) => ({
    role: turn.role,
    timestamp: turn.timestamp || "",
    text: turn.blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text || ""),
  }));
  const conversationDataJson = JSON.stringify(convoData);

  // Load baked annotations from sidecar file if it exists
  const sidecarPath = path.join(viewerDir, `${sessionId}.annotations.json`);
  let bakedAnnotationsJson = "{}";
  try {
    bakedAnnotationsJson = fs.readFileSync(sidecarPath, "utf-8");
    // Validate it's valid JSON
    JSON.parse(bakedAnnotationsJson);
  } catch {
    bakedAnnotationsJson = "{}";
  }

  return {
    title: escape(title),
    metaHtml: metaParts.join("\n    "),
    conversationHtml: turnsHtml.join("\n"),
    tocHtml,
    sessionId,
    jsonlPath: inputPath,
    metaComment,
    conversationDataJson: safeForScript(conversationDataJson),
    bakedAnnotationsJson: safeForScript(bakedAnnotationsJson),
    extraScript: options?.extraScript,
    mode: options?.mode ?? "inline",
    wsUrl: options?.wsUrl,
  };
}

export function convertJsonlToHtml(
  inputFile: string,
  outputFile?: string,
  options?: { includeThinking?: boolean; includeTools?: boolean }
): string {
  const includeThinking = options?.includeThinking ?? true;
  const includeTools = options?.includeTools ?? true;

  const inputPath = path.resolve(inputFile);

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputFile}`);
    process.exit(1);
  }

  // Parse so we have sessionId for default output path
  const convo = buildConversation(inputFile);
  const viewerDir = path.join(os.homedir(), ".claude", "viewer");
  const sessionId = convo.sessionId || path.parse(inputPath).name;

  // Determine output path
  let outputPath: string;
  if (outputFile) {
    outputPath = path.resolve(outputFile);
  } else if (convo.sessionId) {
    fs.mkdirSync(viewerDir, { recursive: true });
    const shortId = convo.sessionId.slice(0, 8);
    outputPath = path.join(viewerDir, `${shortId}.html`);
  } else {
    const parsed = path.parse(inputPath);
    outputPath = path.join(parsed.dir, `${parsed.name}.html`);
  }

  const params = buildPageParams(convo, inputPath, viewerDir, {
    includeThinking,
    includeTools,
  });

  const htmlOut = buildHtmlPage(params);

  // Write output
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, htmlOut, "utf-8");

  const turnCount = convo.turns.length;
  const sizeKb = Buffer.byteLength(htmlOut, "utf-8") / 1024;
  console.log(
    `${path.basename(inputPath)} -> ${outputPath} (${turnCount} turns, ${Math.round(sizeKb)} KB)`
  );

  // Update index if outputting to viewer directory
  if (path.resolve(path.dirname(outputPath)) === path.resolve(viewerDir)) {
    updateIndex(viewerDir);
  }

  // Sync session + annotations to SQLite
  try {
    const db = openDb();
    db.upsertSession({
      id: sessionId,
      jsonl_path: inputPath,
      title: convo.projectDir ? `${convo.projectDir}` : undefined,
      project: convo.projectDir || undefined,
      model: convo.model || undefined,
      start_time: convo.startTime ? Math.floor(new Date(convo.startTime).getTime() / 1000) : undefined,
      turn_count: turnCount,
    });

    // Import sidecar annotations if they exist
    const sidecarPath = path.join(viewerDir, `${sessionId}.annotations.json`);
    if (fs.existsSync(sidecarPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
        let annotations: SidecarAnnotation[];
        if (Array.isArray(raw)) {
          annotations = raw;
        } else {
          // Dict keyed by annotation ID — inject the key as `id`
          annotations = Object.entries(raw).map(([id, v]: [string, any]) => ({ id, ...v }));
        }
        if (annotations.length) {
          const result = db.importAnnotationsJson(sessionId, annotations);
          if (result.imported > 0) {
            console.log(`  → Synced ${result.imported} annotations to ~/.convo/db.sqlite`);
          }
        }
      } catch {
        // ignore malformed sidecar files
      }
    }
    db.close();
  } catch {
    // SQLite sync is best-effort, don't fail the render
  }

  return outputPath;
}
