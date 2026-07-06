import fs from "node:fs";
import path from "node:path";
import type { ConvoMeta } from "./types.js";
import type { SessionRecord } from "./db.js";

/** Escape HTML special characters. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Shorten a model name for display.
 *
 * Strips `claude-` / `anthropic/` prefixes and `-YYYYMMDD` date suffixes.
 */
export function shortenModel(model: string): string {
  if (!model) return "\u2014";
  let s = model.toLowerCase();
  for (const prefix of ["anthropic/", "claude-"]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
    }
  }
  // Strip date suffix
  s = s.replace(/-\d{8}$/, "");
  return s;
}

/**
 * Format an ISO-8601 timestamp for the index display.
 *
 * Returns "Mon DD, YYYY HH:MM AM/PM" in local timezone, or the first 16
 * characters of the raw string as a fallback.
 */
export function formatIndexTime(startTime: string): string {
  if (!startTime) return "";
  try {
    const dt = new Date(startTime);
    if (isNaN(dt.getTime())) return startTime.slice(0, 16);
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const mon = months[dt.getMonth()];
    const dd = String(dt.getDate()).padStart(2, "0");
    const yyyy = dt.getFullYear();
    let hours = dt.getHours();
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const mm = String(dt.getMinutes()).padStart(2, "0");
    return `${mon} ${dd}, ${yyyy} ${hours}:${mm} ${ampm}`;
  } catch {
    return startTime.slice(0, 16);
  }
}

/**
 * Build the full index HTML page, inserting pre-built entry rows.
 */
export function buildIndexPage(entriesHtml: string, count: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Conversations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --text: #e6edf3;
    --text2: #7d8590;
    --border: #30363d;
    --accent: #da7756;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface2: #f0f2f5;
      --text: #1f2328;
      --text2: #656d76;
      --border: #d0d7de;
      --accent: #c2613a;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 40px 24px;
    max-width: 960px;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .meta {
    color: var(--text2);
    font-size: 0.82rem;
    margin-bottom: 24px;
  }
  .index-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .index-entry {
    display: grid;
    grid-template-columns: 80px 1fr 140px 160px 90px;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }
  .index-entry:hover {
    background: var(--surface2);
  }
  .entry-id {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.82rem;
    color: var(--accent);
    font-weight: 500;
  }
  .entry-project {
    font-size: 0.85rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-model {
    font-size: 0.8rem;
    color: var(--text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-time {
    font-size: 0.8rem;
    color: var(--text2);
    white-space: nowrap;
  }
  .entry-turns {
    font-size: 0.8rem;
    color: var(--text2);
    text-align: right;
    white-space: nowrap;
  }
  .empty {
    text-align: center;
    padding: 40px;
    color: var(--text2);
    background: var(--surface);
    border-radius: 8px;
  }
  @media (max-width: 700px) {
    .index-entry {
      grid-template-columns: 70px 1fr 80px;
    }
    .entry-model, .entry-time {
      display: none;
    }
  }
</style>
</head>
<body>
  <h1>Claude Conversations</h1>
  <div class="meta">${count} sessions</div>
  ${entriesHtml}
</body>
</html>`;
}

/**
 * Regenerate the `index.html` catalog of all rendered sessions in `viewerDir`.
 */
export function updateIndex(viewerDir: string): void {
  const metaPattern = /<!-- CONVO_META:(\{.*?\}) -->/;

  interface EntryMeta extends Partial<ConvoMeta> {
    _filename: string;
  }

  const entries: EntryMeta[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(viewerDir).filter((f) => f.endsWith(".html")).sort();
  } catch {
    files = [];
  }

  for (const file of files) {
    if (file === "index.html") continue;
    try {
      const fd = fs.openSync(path.join(viewerDir, file), "r");
      let head: string;
      try {
        const buf = Buffer.alloc(1024);
        const bytesRead = fs.readSync(fd, buf, 0, 1024, 0);
        head = buf.toString("utf-8", 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
      const match = metaPattern.exec(head);
      if (match) {
        const meta = JSON.parse(match[1]) as Partial<ConvoMeta>;
        entries.push({ ...meta, _filename: file });
      }
    } catch {
      continue;
    }
  }

  // Sort by start_time descending
  entries.sort((a, b) => {
    const ta = a.start_time ?? "";
    const tb = b.start_time ?? "";
    return tb.localeCompare(ta);
  });

  let entriesHtml: string;

  if (entries.length > 0) {
    const rows = entries.map((meta) => {
      const shortId = escapeHtml(meta.short_id ?? meta._filename);
      const project = meta.project_dir ?? "";
      let projectDisplay = "";
      if (project) {
        const parts = project.replace(/\/+$/, "").split("/");
        projectDisplay =
          parts.length >= 2 ? parts.slice(-2).join("/") : project;
      }
      const modelDisplay = shortenModel(meta.model ?? "");
      const timeDisplay = formatIndexTime(meta.start_time ?? "");
      const turnCount = Number(meta.turn_count) || 0;
      const userTurns = Number(meta.user_turns) || 0;
      const filename = meta._filename;

      return (
        `<a class="index-entry" href="${escapeHtml(filename)}">` +
        `<span class="entry-id">${shortId}</span>` +
        `<span class="entry-project" title="${escapeHtml(project)}">${escapeHtml(projectDisplay)}</span>` +
        `<span class="entry-model">${escapeHtml(modelDisplay)}</span>` +
        `<span class="entry-time">${escapeHtml(timeDisplay)}</span>` +
        `<span class="entry-turns">${turnCount} turns (${userTurns} user)</span>` +
        `</a>`
      );
    });
    entriesHtml = '<div class="index-list">\n' + rows.join("\n") + "\n</div>";
  } else {
    entriesHtml = '<div class="empty">No conversations rendered yet.</div>';
  }

  const indexHtml = buildIndexPage(entriesHtml, entries.length);
  fs.writeFileSync(path.join(viewerDir, "index.html"), indexHtml, "utf-8");
}

/**
 * Build an index page from session records (SQLite), for server mode.
 * Groups by project, sorted by recency, with client-side search/filter.
 */
/**
 * Decode a Claude projects directory name back to a readable path.
 * e.g. "-Users-david-Documents-Programs-fb-monitor" → "/Users/david/Documents/Programs/fb-monitor"
 *
 * The encoding replaces "/" with "-" and prepends "-". We can't perfectly reverse
 * this since "-" is ambiguous, but we can use the known prefix structure.
 */
export function decodeProjectDir(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  // Common structure: -Users-<user>-Documents-Programs-<project>
  // or -Users-<user>-<project>
  // Try to find the known path segments and reconstruct
  const stripped = encoded.slice(1); // remove leading -
  // Replace the known path prefix segments, keeping everything after Programs/ or Documents/ intact
  // Temp dirs from runners (ori/orchid) — collapse to a readable label
  // e.g. "private-tmp-ori-orchid-work-bidi-1771993919-746449" → "ori/orchid-bidi"
  // e.g. "private-tmp-ori-orchid-work-streaming-01KHSTXMG..." → "ori/orchid-streaming"
  const tmpMatch = stripped.match(
    /^private-(?:tmp|var-folders-[^-]+-[^-]+-T)-ori-orchid-(?:work-)?(\w+?)[-_](?:\d{10,}|01[0-9A-Z]{20,})/,
  );
  if (tmpMatch) return "ori/orchid-" + tmpMatch[1];
  // Other /private/tmp or /var paths — just show last meaningful segment
  if (stripped.startsWith("private-tmp-") || stripped.startsWith("private-var-")) {
    const parts = stripped.split("-");
    // var-folders paths: private-var-folders-XX-HASH-T-<project>-<timestamp>
    // Skip past the "T" marker to avoid including structural noise (folders, hash, T)
    let startIdx = 2; // default: skip "private-tmp" or "private-var"
    if (parts[2] === "folders") {
      const tIdx = parts.indexOf("T", 3);
      if (tIdx >= 0) startIdx = tIdx + 1;
    }
    // Find the last non-numeric, non-hash segment
    for (let i = parts.length - 1; i >= startIdx; i--) {
      if (parts[i].length > 2 && !/^\d+$/.test(parts[i]) && !/^[0-9a-f]{8,}$/i.test(parts[i]) && !/^01[0-9A-Z]{10,}$/.test(parts[i])) {
        return parts.slice(startIdx, i + 1).join("-");
      }
    }
  }

  const knownPrefixes = [
    /^Users-(.+?)-Documents-Programs-/,
    /^Users-(.+?)-Documents-/,
    /^Users-([^-]+)-/,  // last resort: no anchor keyword, so [^-]+ is safest
  ];
  for (const re of knownPrefixes) {
    const m = stripped.match(re);
    if (m) {
      const rest = stripped.slice(m[0].length);
      return rest || stripped;
    }
  }
  return stripped;
}

/**
 * Derive friendly project names from a session's raw project and jsonl_path fields.
 * Returns { project, fullProject, dirProject } matching the shape used by the index page client.
 */
export function deriveProjectNames(rawProject: string | null | undefined, jsonlPath: string | null | undefined): { project: string; fullProject: string; dirProject: string } {
  let dirProject = "";
  if (jsonlPath) {
    const dirName = jsonlPath.split("/").slice(-2, -1)[0] ?? "";
    dirProject = decodeProjectDir(dirName);
  }
  const project = rawProject ?? "";
  const parts = project.replace(/\/+$/, "").split("/");
  let shortProject = parts.length >= 1 ? parts[parts.length - 1] : "";
  // If shortProject looks like a KSUID, timestamp, or hash, prefer dirProject
  if (/^01[0-9A-Z]{10,}$/.test(shortProject) || /^\d{10,}$/.test(shortProject) || /^[0-9a-f]{16,}$/i.test(shortProject)) {
    shortProject = "";
  }
  return {
    project: shortProject || dirProject || "",
    fullProject: project,
    dirProject,
  };
}

/**
 * Build an index page from session records (SQLite), for server mode.
 * Default view: flat list of recent sessions. Search filters by project/model/id.
 */
export function buildServerIndex(sessions: SessionRecord[], settings?: { embeddings_enabled?: boolean; min_turns?: number; resume_enabled?: boolean; terminal_app?: string; resume_dangerous_mode?: boolean; quick_launch_name?: string }): string {
  const cfg = { embeddings_enabled: false, min_turns: 0, resume_enabled: false, terminal_app: "Terminal", resume_dangerous_mode: false, quick_launch_name: "", ...settings };
  const sessionsJson = JSON.stringify(
    sessions.map((s) => {
      const names = deriveProjectNames(s.project, s.jsonl_path);

      return {
        id: s.id,
        title: s.title ?? "",
        ...names,
        source: s.source_machine ?? "",
        model: s.model ?? "",
        last_modified: s.last_modified ?? s.start_time ?? 0,
        turn_count: s.turn_count ?? 0,
        file_size: s.file_size ?? 0,
        hidden: s.hidden ?? 0,
      };
    }),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gloss — Conversations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --text: #e6edf3;
    --text2: #7d8590;
    --border: #30363d;
    --accent: #da7756;
    --accent2: #da775620;
    --logo-invert: invert(1);
    --user-bg: rgba(45, 212, 191, 0.08);
    --user-border: #2dd4bf;
    --user-label: #5eead4;
    --assistant-bg: rgba(218, 119, 86, 0.08);
    --assistant-border: #da7756;
    --assistant-label: #e8956e;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --surface: #ffffff;
      --surface2: #f0f2f5;
      --text: #1f2328;
      --text2: #656d76;
      --border: #d0d7de;
      --accent: #c2613a;
      --accent2: #c2613a15;
      --logo-invert: none;
      --user-bg: rgba(13, 148, 136, 0.06);
      --user-border: #0d9488;
      --user-label: #0f766e;
      --assistant-bg: rgba(218, 119, 86, 0.06);
      --assistant-border: #da7756;
      --assistant-label: #c4633e;
    }
  }
  [data-theme="light"] {
    --bg: #f6f8fa; --surface: #ffffff; --surface2: #f0f2f5;
    --text: #1f2328; --text2: #656d76; --border: #d0d7de;
    --accent: #c2613a; --accent2: #c2613a15; --logo-invert: none;
    --user-bg: rgba(13, 148, 136, 0.06); --user-border: #0d9488; --user-label: #0f766e;
    --assistant-bg: rgba(218, 119, 86, 0.06); --assistant-border: #da7756; --assistant-label: #c4633e;
  }
  [data-theme="dark"] {
    --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
    --text: #e6edf3; --text2: #7d8590; --border: #30363d;
    --accent: #da7756; --accent2: #da775620; --logo-invert: invert(1);
    --user-bg: rgba(45, 212, 191, 0.08); --user-border: #2dd4bf; --user-label: #5eead4;
    --assistant-bg: rgba(218, 119, 86, 0.08); --assistant-border: #da7756; --assistant-label: #e8956e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding: 32px 24px;
    max-width: 1100px;
    margin: 0 auto;
  }
  .header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  h1 { font-size: 1.4rem; font-weight: 600; }
  .count { color: var(--text2); font-size: 0.85rem; }

  .top-nav {
    display: flex; gap: 0; margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .top-nav-tab {
    padding: 8px 16px 8px 0; margin-right: 8px;
    font-size: 0.85rem; font-weight: 500;
    color: var(--text2); text-decoration: none;
    border-bottom: 2px solid transparent;
  }
  .top-nav-tab:hover { color: var(--text); }
  .top-nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .controls { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .search {
    flex: 1; min-width: 200px;
    height: 34px;
    padding: 0 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.85rem;
    outline: none;
  }
  .search:focus { border-color: var(--accent); }
  .view-btn {
    padding: 6px 12px;
    height: 34px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text2);
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .view-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent2); }
  #askBtn { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
  #askBtn:hover { opacity: 0.9; }

  /* Flat list */
  .session-table {
    display: flex; flex-direction: column; gap: 1px;
    background: var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .session-row {
    display: grid;
    grid-template-columns: 120px 1fr 72px 52px 58px 20px;
    gap: 8px;
    align-items: center;
    padding: 10px 14px;
    background: var(--surface);
    text-decoration: none;
    color: inherit;
    transition: background 0.1s;
  }
  .session-row:hover { background: var(--surface2); }
  .session-row.table-header {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: default;
    padding: 8px 14px;
  }
  .session-row.table-header:hover { background: var(--surface); }
  .session-row.table-header span[data-sort] {
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .session-row.table-header span[data-sort]:hover { color: var(--accent); }
  .session-row.table-header span[data-sort].sort-active { color: var(--accent); }
  .s-project { font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-id {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.78rem;
    color: var(--accent);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .s-meta { font-size: 0.78rem; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-session { display: flex; align-items: center; overflow: hidden; min-width: 0; flex-wrap: nowrap; }
  .s-title { font-size: 0.78rem; color: #5eead4; font-weight: 500; margin-left: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s-fts { font-size: 0.7rem; color: var(--accent); margin-left: 6px; opacity: 0.8; }
  @media (prefers-color-scheme: light) { .s-title { color: #0f766e; } }
  .s-time { font-size: 0.78rem; color: var(--text2); white-space: nowrap; }
  .s-turns { font-size: 0.78rem; color: var(--text2); text-align: right; }
  .s-size { font-size: 0.78rem; color: var(--text2); text-align: right; }
  .load-more {
    display: block; width: 100%; padding: 12px;
    background: var(--surface); border: none; color: var(--accent);
    font-size: 0.85rem; cursor: pointer; text-align: center;
  }
  .load-more:hover { background: var(--surface2); }

  /* Project groups */
  .project-group { margin-bottom: 2px; }
  .project-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
  }
  .project-header:hover { background: var(--surface2); }
  .project-name { font-size: 0.9rem; font-weight: 500; }
  .project-count { font-size: 0.75rem; color: var(--text2); }
  .project-arrow { color: var(--text2); font-size: 0.65rem; transition: transform 0.15s; }
  .project-group.collapsed .project-arrow { transform: rotate(-90deg); }
  .project-group.collapsed .group-sessions { display: none; }
  .group-sessions { background: var(--border); display: flex; flex-direction: column; gap: 1px; }
  .group-sessions .session-row { grid-template-columns: 1fr 80px 50px 60px; }
  .group-sessions .s-project { display: none; }

  .empty { text-align: center; padding: 40px; color: var(--text2); }
  .s-actions {
    position: relative; margin-left: auto; flex-shrink: 0;
    opacity: 0; transition: opacity 0.1s;
  }
  .session-row:hover .s-actions { opacity: 1; }
  .s-actions:has(.open) { opacity: 1; }
  .s-actions-trigger {
    background: none; border: none; color: var(--text2); cursor: pointer;
    padding: 2px 6px; font-size: 1rem; border-radius: 4px; line-height: 1;
    letter-spacing: 1px;
  }
  .s-actions-trigger:hover { background: var(--surface2); color: var(--text); }
  .s-actions-menu {
    display: none; position: fixed; z-index: 200;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 4px 0; min-width: 200px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  .s-actions-menu.open { display: block; }
  .s-actions-menu button {
    display: flex; align-items: center; gap: 8px; width: 100%;
    background: none; border: none; color: var(--text); cursor: pointer;
    padding: 7px 14px; font-size: 0.82rem; text-align: left; font-family: inherit;
  }
  .s-actions-menu button:hover { background: var(--surface2); }
  .s-actions-menu button .menu-icon { color: var(--text2); width: 16px; text-align: center; font-size: 0.85rem; }
  .session-row.hidden-row { opacity: 0.4; }

  .s-preview {
    display: none; padding: 0;
    background: var(--surface);
    max-height: 350px; overflow-y: auto;
  }
  .s-preview.open { display: block; }
  .s-preview .preview-turn {
    padding: 14px 20px; border-left: 3px solid var(--border);
  }
  .s-preview .preview-turn.turn-user { border-left-color: var(--user-border); background: var(--user-bg); }
  .s-preview .preview-turn.turn-assistant { border-left-color: var(--assistant-border); background: var(--assistant-bg); }
  .s-preview .preview-turn + .preview-turn { border-top: 1px solid var(--border); }
  .s-preview .preview-role {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 6px;
  }
  .s-preview .turn-user .preview-role { color: var(--user-label); }
  .s-preview .turn-assistant .preview-role { color: var(--assistant-label); }
  .s-preview .preview-content {
    font-size: 0.82rem; line-height: 1.6; color: var(--text);
  }
  .s-preview .preview-content p { margin: 4px 0; }
  .s-preview .preview-content code {
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.78rem;
    background: var(--surface2); padding: 1px 5px; border-radius: 3px;
  }
  .s-preview .preview-content pre {
    background: var(--surface2); padding: 10px 12px; border-radius: 6px;
    overflow-x: auto; margin: 6px 0; font-size: 0.75rem;
  }
  .s-preview .preview-content pre code { background: none; padding: 0; }
  .s-preview .preview-content strong { font-weight: 600; }
  .s-preview .preview-content ul, .s-preview .preview-content ol { padding-left: 20px; margin: 4px 0; }
  .s-preview .preview-loading { color: var(--text2); font-style: italic; padding: 16px 20px; }
  .rename-input {
    background: var(--surface2); border: 1px solid var(--accent); border-radius: 3px;
    color: var(--text); font-size: 0.78rem; padding: 1px 6px; width: 200px;
    outline: none; font-family: inherit;
  }

  /* Project filter dropdown */
  .filter-wrap { position: relative; }
  .filter-btn.has-muted { color: var(--accent); border-color: var(--accent); background: var(--accent2); }
  .filter-drop {
    display: none;
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 0;
    min-width: 240px;
    max-height: 400px;
    overflow-y: auto;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  .filter-drop.open { display: block; }
  .filter-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    font-size: 0.82rem;
    cursor: pointer;
    user-select: none;
  }
  .filter-item:hover { background: var(--surface2); }
  .filter-item input { accent-color: var(--accent); }
  .filter-item .proj-count { color: var(--text2); font-size: 0.75rem; margin-left: auto; }
  .filter-actions {
    display: flex; gap: 8px; padding: 6px 14px; border-top: 1px solid var(--border); margin-top: 4px;
  }
  .filter-actions button {
    background: none; border: none; color: var(--accent); font-size: 0.78rem; cursor: pointer; padding: 2px 0;
  }
  .filter-actions button:hover { text-decoration: underline; }
  .filter-search {
    display: block; width: calc(100% - 28px); margin: 4px 14px 6px;
    padding: 5px 8px;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-size: 0.8rem; outline: none;
  }
  .filter-search:focus { border-color: var(--accent); }

  /* Settings panel */
  .settings-wrap { position: relative; }
  .settings-drop {
    display: none;
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    min-width: 280px;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  }
  .settings-drop.open { display: block; }
  .settings-drop h3 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text2); margin-bottom: 10px; }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
  .setting-row:last-child { margin-bottom: 0; }
  .setting-label { font-size: 0.82rem; color: var(--text); }
  .setting-note { font-size: 0.72rem; color: var(--text2); margin-top: 2px; line-height: 1.3; }
  .setting-toggle {
    position: relative; width: 36px; height: 20px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 10px; cursor: pointer; flex-shrink: 0;
    transition: background 0.15s, border-color 0.15s;
  }
  .setting-toggle.on { background: var(--accent); border-color: var(--accent); }
  .setting-toggle::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; background: #fff; border-radius: 50%;
    transition: transform 0.15s;
  }
  .setting-toggle.on::after { transform: translateX(16px); }
  .setting-num {
    width: 60px; height: 28px; padding: 0 8px; text-align: center;
    background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-size: 0.82rem; outline: none;
  }
  .setting-num:focus { border-color: var(--accent); }
  .setting-saved {
    font-size: 0.72rem; color: var(--accent); opacity: 0; transition: opacity 0.2s;
    margin-left: 6px;
  }
  .setting-saved.show { opacity: 1; }

  @media (max-width: 700px) {
    .session-row { grid-template-columns: 1fr 60px 50px 28px; }
    .s-project, .s-size { display: none; }
    .session-row.table-header { display: none; }
    .group-sessions .session-row { grid-template-columns: 1fr 60px 50px 28px; }
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Gloss</h1>
    <span class="count" id="count"></span>
  </div>
  <div class="top-nav">
    <a href="/" class="top-nav-tab active">Conversations</a>
    <a href="/memory" class="top-nav-tab">Memory</a>
    <a href="/tools" class="top-nav-tab">Tools</a>
    ${cfg.quick_launch_name ? `<a href="#" class="top-nav-tab" style="margin-left:auto;color:var(--green)" onclick="event.preventDefault();spawnQuick()">+ ${escapeHtml(cfg.quick_launch_name)}</a>` : ""}
  </div>
  <div class="controls">
    <input class="search" id="search" type="text" placeholder="Search or ask a question..." autofocus>
    <button class="view-btn" id="askBtn" onclick="askAI()" style="display:none">Ask AI</button>
    <button class="view-btn" id="groupBtn" onclick="toggleGroup()">Group projects</button>
    <div class="filter-wrap">
      <button class="view-btn filter-btn" id="filterBtn" onclick="toggleFilter()">Filter</button>
      <div class="filter-drop" id="filterDrop"></div>
    </div>
    <div class="settings-wrap">
      <button class="view-btn" id="settingsBtn" onclick="toggleSettings()">Settings</button>
      <div class="settings-drop" id="settingsDrop">
        <h3>Settings</h3>
        <div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Semantic search</div>
              <div class="setting-note" id="embeddingsNote"></div>
            </div>
            <div class="setting-toggle" id="embeddingsToggle" onclick="toggleEmbeddings()"></div>
          </div>
        </div>
        <div id="minTurnsRow" style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border)">
          <div class="setting-row">
            <div class="setting-label" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              Skip sessions under <input class="setting-num" id="minTurnsInput" type="number" min="0" step="1" style="width:48px"> turns
            </div>
          </div>
        </div>
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border)">
          <div class="setting-row">
            <div class="setting-label">Show hidden sessions</div>
            <div class="setting-toggle" id="hiddenToggle" onclick="toggleShowHidden()"></div>
          </div>
        </div>
        <div id="sourceRow" style="display:none;margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border)">
          <div class="setting-row">
            <div>
              <div class="setting-label">Sources</div>
              <div class="setting-note">Show sessions from these machines</div>
            </div>
            <div id="sourceChips" style="display:flex;gap:4px"></div>
          </div>
        </div>
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border)">
          <div class="setting-row">
            <div>
              <div class="setting-label">Truncate session IDs</div>
            </div>
            <div class="setting-toggle" id="truncateToggle" onclick="toggleTruncate()"></div>
          </div>
          <div id="truncateOptions" style="display:none;margin-top:8px">
            <div class="setting-row">
              <div class="setting-label">Show</div>
              <div style="display:flex;gap:4px">
                <button class="view-btn truncate-opt" data-mode="first8" onclick="setTruncateMode('first8')" style="padding:4px 8px;font-size:0.75rem">First 8</button>
                <button class="view-btn truncate-opt" data-mode="last8" onclick="setTruncateMode('last8')" style="padding:4px 8px;font-size:0.75rem">Last 8</button>
              </div>
            </div>
          </div>
        </div>
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border)">
          <div class="setting-row">
            <div class="setting-label">Theme</div>
            <div style="display:flex;gap:4px">
              <button class="view-btn theme-opt" data-theme="auto" onclick="setTheme('auto')" style="padding:4px 8px;font-size:0.75rem">Auto</button>
              <button class="view-btn theme-opt" data-theme="light" onclick="setTheme('light')" style="padding:4px 8px;font-size:0.75rem">Light</button>
              <button class="view-btn theme-opt" data-theme="dark" onclick="setTheme('dark')" style="padding:4px 8px;font-size:0.75rem">Dark</button>
            </div>
          </div>
        </div>
        <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border)">
          <div class="setting-row">
            <div>
              <div class="setting-label">Resume in terminal</div>
              <div class="setting-note">Show a play button to open sessions in your terminal</div>
            </div>
            <div class="setting-toggle" id="resumeToggle" onclick="toggleResume()"></div>
          </div>
          <div id="resumeOptions" style="display:none;margin-top:10px">
            <div class="setting-row">
              <div class="setting-label">Terminal app</div>
              <select id="terminalSelect" onchange="saveTerminalApp()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.8rem;padding:3px 8px">
                <option value="Terminal">Terminal.app</option>
                <option value="iTerm2">iTerm2</option>
                <option value="Warp">Warp</option>
                <option value="Ghostty">Ghostty</option>
              </select>
            </div>
            <div class="setting-row" style="margin-top:8px">
              <div>
                <div class="setting-label">Skip permissions</div>
                <div class="setting-note">Add --dangerously-skip-permissions flag</div>
              </div>
              <div class="setting-toggle" id="dangerousToggle" onclick="toggleDangerous()"></div>
            </div>
          </div>
        </div>
        <span class="setting-saved" id="settingSaved">Saved</span>
      </div>
    </div>
  </div>
  <div id="content"></div>

<script>
const ALL = ${sessionsJson.replace(/<\//g, "<\\/")};
const SETTINGS = ${JSON.stringify(cfg).replace(/<\//g, "<\\/")};
let grouped = false;
let query = '';
let showCount = 80;
let mutedProjects = new Set(JSON.parse(localStorage.getItem('gloss_muted_projects') || '[]'));
let mutedSources = new Set(JSON.parse(localStorage.getItem('gloss_muted_sources') || '[]'));
let sortCol = 'last_modified';
let sortDir = -1; // -1 = descending, 1 = ascending
let showHidden = false;
let minTurnsFilter = parseInt(localStorage.getItem('gloss_min_turns_filter') || '0', 10);

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function shortModel(m) {
  if (!m) return '';
  return m.toLowerCase().replace(/^(anthropic\\/|claude-)/, '').replace(/-\\d{8}$/, '');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = Date.now() - d.getTime();
  if (diff < 3600000) return Math.max(1, Math.floor(diff / 60000)) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

function sortSessions(list) {
  return [...list].sort((a, b) => {
    let av, bv;
    if (sortCol === 'project') {
      av = (a.project || a.dirProject || '').toLowerCase();
      bv = (b.project || b.dirProject || '').toLowerCase();
      return sortDir * av.localeCompare(bv);
    }
    av = a[sortCol] || 0;
    bv = b[sortCol] || 0;
    return sortDir * (av - bv);
  });
}

function setSort(col) {
  if (sortCol === col) sortDir = -sortDir;
  else { sortCol = col; sortDir = -1; }
  render();
}

function sortArrow(col) {
  if (sortCol !== col) return '';
  return sortDir === -1 ? ' \\u25BE' : ' \\u25B4';
}

function isGlossAskSession(s) {
  return s.model && s.model.includes('haiku') && (s.turn_count || 0) <= 2;
}

function filter(list) {
  let out = list;
  // Always hide Gloss's own Ask pipeline sessions (haiku, 2 turns)
  out = out.filter(s => !isGlossAskSession(s));
  if (!showHidden) {
    out = out.filter(s => !s.hidden);
  }
  if (minTurnsFilter > 0) {
    out = out.filter(s => (s.turn_count || 0) >= minTurnsFilter);
  }
  if (mutedSources.size) {
    out = out.filter(s => !mutedSources.has(s.source || 'unknown'));
  }
  if (mutedProjects.size) {
    out = out.filter(s => {
      const key = s.project || s.dirProject || 'Unknown';
      return !mutedProjects.has(key);
    });
  }
  if (!query) return out;
  const q = query.toLowerCase();
  return out.filter(s =>
    s.project.toLowerCase().includes(q) ||
    s.dirProject.toLowerCase().includes(q) ||
    s.fullProject.toLowerCase().includes(q) ||
    s.model.toLowerCase().includes(q) ||
    s.id.toLowerCase().includes(q) ||
    (s.title && s.title.toLowerCase().includes(q))
  );
}

function setMinTurns(val) {
  minTurnsFilter = parseInt(val, 10) || 0;
  localStorage.setItem('gloss_min_turns_filter', String(minTurnsFilter));
  showCount = 80;
  render();
}

function toggleGroup() {
  grouped = !grouped;
  showCount = 80;
  document.getElementById('groupBtn').classList.toggle('active', grouped);
  render();
}

function renderRecent(filtered) {
  const sorted = sortSessions(filtered);
  const visible = sorted.slice(0, showCount);

  let html = '<div class="session-table">';
  html += '<div class="session-row table-header">';
  html += '<span data-sort="project" onclick="setSort(\\'project\\')" class="' + (sortCol==='project'?'sort-active':'') + '">Project' + sortArrow('project') + '</span>';
  html += '<span>Session</span>';
  html += '<span data-sort="last_modified" onclick="setSort(\\'last_modified\\')" class="' + (sortCol==='last_modified'?'sort-active':'') + '">When' + sortArrow('last_modified') + '</span>';
  html += '<span data-sort="turn_count" onclick="setSort(\\'turn_count\\')" style="text-align:right" class="' + (sortCol==='turn_count'?'sort-active':'') + '">Turns' + sortArrow('turn_count') + '</span>';
  html += '<span data-sort="file_size" onclick="setSort(\\'file_size\\')" style="text-align:right" class="' + (sortCol==='file_size'?'sort-active':'') + '">Size' + sortArrow('file_size') + '</span>';
  html += '<span></span>';
  html += '</div>';
  for (const s of visible) {
    const proj = esc(s.project || s.dirProject || '—');
    const sid = esc(s.id);
    const hiddenCls = s.hidden ? ' hidden-row' : '';
    html += '<a class="session-row' + hiddenCls + '" href="/c/' + sid + '">';
    html += '<span class="s-project" title="' + esc(s.fullProject) + '">' + proj + '</span>';
    const titleBit = s.title ? '<span class="s-title">' + esc(s.title) + '</span>' : '';
    const ftsBit = s._ftsMatch ? '<span class="s-fts">' + s._ftsMatch + ' matches</span>' : '';
    html += '<span class="s-session"><span class="s-id" title="' + sid + '">' + truncateId(s.id) + '</span>' + titleBit + ftsBit + '</span>';
    html += '<span class="s-time">' + fmtTime(s.last_modified) + '</span>';
    html += '<span class="s-turns">' + (s.turn_count || '—') + '</span>';
    html += '<span class="s-size">' + fmtSize(s.file_size) + '</span>';
    html += '<span class="s-actions">';
    html += '<button class="s-actions-trigger" onclick="toggleRowMenu(\\'' + sid + '\\',event)">\\u22EE</button>';
    html += '<div class="s-actions-menu" id="menu-' + sid + '">';
    if (SETTINGS.resume_enabled) {
      html += '<button onclick="resumeSession(\\'' + sid + '\\',event)"><span class="menu-icon">\\u25B6</span>Resume in terminal</button>';
    }
    html += '<button onclick="copyResume(\\'' + sid + '\\',event)"><span class="menu-icon">\\u2398</span>Copy resume command</button>';
    html += '<button onclick="renameSession(\\'' + sid + '\\',event)"><span class="menu-icon">\\u270E</span>Rename</button>';
    html += '<button onclick="previewSession(\\'' + sid + '\\',event)" id="preview-btn-' + sid + '"><span class="menu-icon">\\u25BC</span>Preview last turn</button>';
    html += '<button onclick="summarizeSession(\\'' + sid + '\\',event)"><span class="menu-icon">\\u2211</span>Summarize</button>';
    html += '<button onclick="hideSession(\\'' + sid + '\\',event)"><span class="menu-icon">' + (s.hidden ? '\\u25C9' : '\\u25CE') + '</span>' + (s.hidden ? 'Unhide' : 'Hide') + '</button>';
    html += '</div>';
    html += '</span>';
    html += '</a>';
    html += '<div class="s-preview" id="preview-' + sid + '"></div>';
  }
  if (sorted.length > showCount) {
    html += '<button class="load-more" onclick="showCount+=' + 80 + ';render()">Show more (' + (sorted.length - showCount) + ' remaining)</button>';
  }
  html += '</div>';
  return html;
}

function renderByProject(filtered) {
  const groups = new Map();
  for (const s of filtered) {
    const key = s.project || s.dirProject || 'Unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const arr of groups.values()) arr.sort((a, b) => (b.last_modified || 0) - (a.last_modified || 0));

  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let html = '';
  for (const [name, sessions] of sorted) {
    const collapsed = sessions.length > 5 ? ' collapsed' : '';
    html += '<div class="project-group' + collapsed + '">';
    html += '<div class="project-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
    html += '<span class="project-arrow">&#9660;</span>';
    html += '<span class="project-name">' + esc(name) + '</span>';
    html += '<span class="project-count">' + sessions.length + '</span>';
    html += '</div>';
    html += '<div class="group-sessions">';
    for (const s of sessions) {
      const sid = esc(s.id);
      const hiddenCls = s.hidden ? ' hidden-row' : '';
      html += '<a class="session-row' + hiddenCls + '" href="/c/' + sid + '">';
      html += '<span class="s-project">' + esc(name) + '</span>';
      const titleBit = s.title ? '<span class="s-title">' + esc(s.title) + '</span>' : '';
      const ftsBit = s._ftsMatch ? '<span class="s-fts">' + s._ftsMatch + ' matches</span>' : '';
      html += '<span class="s-session"><span class="s-id" title="' + sid + '">' + truncateId(s.id) + '</span>' + titleBit + ftsBit;
      html += '<span class="s-actions">';
      html += '<button onclick="renameSession(\\'' + sid + '\\',event)" title="Rename">✎</button>';
      html += '<button onclick="hideSession(\\'' + sid + '\\',event)" title="' + (s.hidden ? 'Unhide' : 'Hide') + '">' + (s.hidden ? '◉' : '◎') + '</button>';
      html += '</span></span>';
      html += '<span class="s-time">' + fmtTime(s.last_modified) + '</span>';
      html += '<span class="s-turns">' + (s.turn_count || '—') + '</span>';
      html += '<span class="s-size">' + fmtSize(s.file_size) + '</span>';
      html += '</a>';
    }
    html += '</div></div>';
  }
  return html;
}

function render() {
  let filtered = filter(ALL);
  const unmuted = mutedProjects.size ? ALL.filter(s => !mutedProjects.has(s.project || s.dirProject || 'Unknown')).length : ALL.length;

  // Merge FTS results: add sessions found by content search that aren't in local filter
  let ftsExtra = 0;
  if (ftsResults && ftsResults.length > 0 && ftsQuery === query.trim()) {
    const localIds = new Set(filtered.map(s => s.id));
    for (const r of ftsResults) {
      if (!localIds.has(r.id)) {
        filtered.push({
          id: r.id,
          title: r.title || '',
          project: r.project || '',
          fullProject: r.fullProject || '',
          dirProject: r.dirProject || '',
          model: r.model || '',
          last_modified: r.last_modified || 0,
          turn_count: r.turn_count || 0,
          file_size: r.file_size || 0,
          _ftsMatch: r.match_count,
        });
        ftsExtra++;
      } else {
        // Mark existing entries with FTS match count
        const existing = filtered.find(s => s.id === r.id);
        if (existing) existing._ftsMatch = r.match_count;
      }
    }
  }

  const hiddenCount = ALL.filter(s => s.hidden && !isGlossAskSession(s)).length;
  const hiddenLabel = !showHidden && hiddenCount ? ' (' + hiddenCount + ' hidden)' : '';
  const label = query
    ? filtered.length + ' of ' + unmuted + (ftsExtra ? ' (' + ftsExtra + ' from content search)' : '') + hiddenLabel
    : (mutedProjects.size ? unmuted + ' of ' + ALL.length : '' + ALL.length) + hiddenLabel;
  document.getElementById('count').textContent = label + ' sessions';

  if (filtered.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty">No matching conversations.' + (query && query.length >= 3 ? ' Searching content...' : '') + '</div>';
    return;
  }

  document.getElementById('content').innerHTML = grouped ? renderByProject(filtered) : renderRecent(filtered);
}

let ftsResults = null;
let ftsTimer = null;
let ftsQuery = '';

function doFtsSearch(q) {
  if (!q || q.length < 3) { ftsResults = null; ftsQuery = ''; render(); return; }
  fetch('/api/search?q=' + encodeURIComponent(q))
    .then(r => r.json())
    .then(data => {
      if (query !== q) return; // stale
      ftsQuery = q;
      ftsResults = data.results || [];
      render();
    })
    .catch(() => {});
}

function askAI() {
  const q = document.getElementById('search').value.trim();
  if (q) window.location.href = '/ask?q=' + encodeURIComponent(q);
}

function updateAskBtn(q) {
  const btn = document.getElementById('askBtn');
  if (!btn) return;
  const isQuestion = q.length > 15 || q.endsWith('?') || /^(how|what|when|where|why|which|can|does|did|is|are|show|find|search|tell|explain|describe)\\b/i.test(q);
  btn.style.display = isQuestion ? '' : 'none';
}

document.getElementById('search').addEventListener('input', function(e) {
  query = e.target.value;
  showCount = 80;
  ftsResults = null;
  render();
  updateAskBtn(query.trim());
  clearTimeout(ftsTimer);
  if (query.trim().length >= 3) {
    ftsTimer = setTimeout(() => doFtsSearch(query.trim()), 300);
  }
});

document.getElementById('search').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    askAI();
  }
});

// --- Project filter ---
function getProjectCounts() {
  const counts = new Map();
  for (const s of ALL) {
    const key = s.project || s.dirProject || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function saveMuted() {
  localStorage.setItem('gloss_muted_projects', JSON.stringify([...mutedProjects]));
  document.getElementById('filterBtn').classList.toggle('has-muted', mutedProjects.size > 0);
}

let filterQuery = '';

function buildFilterDrop() {
  const drop = document.getElementById('filterDrop');
  // Build the static header (actions + search) only once
  if (!drop.querySelector('#filterSearch')) {
    let header = '<div class="filter-section" style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;font-size:0.8rem;color:var(--text2)">';
    header += '<label style="white-space:nowrap">Min turns</label>';
    header += '<input type="number" id="turnsFilter" min="0" step="1" style="width:48px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.8rem;padding:3px 4px;text-align:center">';
    header += '</div>';
    header += '<div class="filter-actions" style="border-top:none;border-bottom:1px solid var(--border);margin-top:0;margin-bottom:4px">';
    header += '<span style="font-size:0.75rem;color:var(--text2);padding-left:2px">Projects</span>';
    header += '<span style="display:flex;gap:8px"><button onclick="showAll()">All</button><button onclick="muteAll()">None</button></span>';
    header += '</div>';
    header += '<input class="filter-search" id="filterSearch" type="text" placeholder="Filter...">';
    header += '<div id="filterList"></div>';
    drop.innerHTML = header;
    var tf = document.getElementById('turnsFilter');
    tf.value = minTurnsFilter || '';
    tf.addEventListener('change', function(e) { setMinTurns(e.target.value); });
    document.getElementById('filterSearch').addEventListener('input', function(e) {
      filterQuery = e.target.value;
      updateFilterList();
    });
  }
  updateFilterList();
}

function updateFilterList() {
  const projects = getProjectCounts();
  const fq = filterQuery.toLowerCase();
  const filtered = fq ? projects.filter(([name]) => name.toLowerCase().includes(fq)) : projects;
  let html = '';
  for (const [name, count] of filtered) {
    const checked = !mutedProjects.has(name) ? ' checked' : '';
    html += '<label class="filter-item"><input type="checkbox"' + checked + ' data-proj="' + esc(name) + '" onchange="toggleProject(this)"><span>' + esc(name) + '</span><span class="proj-count">' + count + '</span></label>';
  }
  document.getElementById('filterList').innerHTML = html;
}

function toggleFilter() {
  const drop = document.getElementById('filterDrop');
  const isOpen = drop.classList.toggle('open');
  if (isOpen) { filterQuery = ''; buildFilterDrop(); }
}

function toggleProject(el) {
  const name = el.dataset.proj;
  if (el.checked) mutedProjects.delete(name);
  else mutedProjects.add(name);
  saveMuted();
  showCount = 80;
  render();
}

function muteAll() {
  const fq = filterQuery.toLowerCase();
  const projects = getProjectCounts();
  const targets = fq ? projects.filter(([name]) => name.toLowerCase().includes(fq)) : projects;
  for (const [name] of targets) mutedProjects.add(name);
  saveMuted();
  updateFilterList();
  showCount = 80;
  render();
}

function showAll() {
  const fq = filterQuery.toLowerCase();
  if (!fq) { mutedProjects.clear(); }
  else {
    const projects = getProjectCounts();
    for (const [name] of projects) {
      if (name.toLowerCase().includes(fq)) mutedProjects.delete(name);
    }
  }
  saveMuted();
  updateFilterList();
  showCount = 80;
  render();
}

// Close filter dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.filter-wrap')) {
    document.getElementById('filterDrop').classList.remove('open');
  }
});

// Init filter button state
document.getElementById('filterBtn').classList.toggle('has-muted', mutedProjects.size > 0);

// --- Source toggle (MBP vs Studio) ---
// Lives in the Settings menu; the row appears only when the corpus has logs
// from more than one machine.
function buildSourceChips() {
  const wrap = document.getElementById('sourceChips');
  const row = document.getElementById('sourceRow');
  if (!wrap || !row) return;
  const counts = new Map();
  for (const s of ALL) {
    const key = s.source || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sources = [...counts.keys()].sort();
  if (sources.length < 2) { wrap.innerHTML = ''; row.style.display = 'none'; return; }
  row.style.display = '';
  let html = '';
  for (const src of sources) {
    const on = !mutedSources.has(src);
    html += '<button class="view-btn' + (on ? ' active' : '') + '" data-source="' + esc(src) + '" ' +
      'onclick="toggleSource(event, this.dataset.source)" title="' + counts.get(src) + ' sessions" ' +
      'style="padding:4px 8px;font-size:0.75rem">' +
      esc(src) + '</button>';
  }
  wrap.innerHTML = html;
}

function toggleSource(e, src) {
  // Keep the Settings menu open while toggling. buildSourceChips() replaces the
  // chip's DOM node mid-click, so the outside-click handler would otherwise see
  // a detached target (closest() === null) and close the menu.
  if (e) e.stopPropagation();
  if (mutedSources.has(src)) mutedSources.delete(src);
  else mutedSources.add(src);
  localStorage.setItem('gloss_muted_sources', JSON.stringify([...mutedSources]));
  showCount = 80;
  buildSourceChips();
  render();
}

buildSourceChips();

function toggleShowHidden() {
  showHidden = !showHidden;
  var el = document.getElementById('hiddenToggle');
  if (el) el.classList.toggle('on', showHidden);
  showCount = 80;
  render();
}

function toggleRowMenu(id, e) {
  e.preventDefault();
  e.stopPropagation();
  // Close any other open menus
  document.querySelectorAll('.s-actions-menu.open').forEach(function(m) {
    if (m.id !== 'menu-' + id) m.classList.remove('open');
  });
  var menu = document.getElementById('menu-' + id);
  if (!menu) return;
  var wasOpen = menu.classList.contains('open');
  if (wasOpen) {
    menu.classList.remove('open');
  } else {
    // Position the menu below the trigger
    var trigger = e.target.closest('.s-actions-trigger') || e.target;
    var rect = trigger.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.style.left = 'auto';
    menu.classList.add('open');
    // Sync preview button text with current preview state
    var previewBtn = document.getElementById('preview-btn-' + id);
    var previewPanel = document.getElementById('preview-' + id);
    if (previewBtn && previewPanel) {
      var isOpen = previewPanel.classList.contains('open');
      previewBtn.innerHTML = '<span class="menu-icon">' + (isOpen ? '\\u25B2' : '\\u25BC') + '</span>' + (isOpen ? 'Hide preview' : 'Preview last turn');
    }
  }
}

// Close menus and previews when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.s-actions')) {
    document.querySelectorAll('.s-actions-menu.open').forEach(function(m) { m.classList.remove('open'); });
  }
  if (!e.target.closest('.s-preview') && !e.target.closest('.s-actions')) {
    document.querySelectorAll('.s-preview.open').forEach(function(p) { p.classList.remove('open'); p.innerHTML = ''; });
  }
});

function previewSession(id, e) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  var panel = document.getElementById('preview-' + id);
  if (!panel) return;
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    panel.innerHTML = '';
    return;
  }
  document.querySelectorAll('.s-preview.open').forEach(function(p) { p.classList.remove('open'); p.innerHTML = ''; });
  panel.innerHTML = '<div class="preview-loading">Loading...</div>';
  panel.classList.add('open');
  fetch('/api/sessions/' + id + '/preview')
    .then(function(r) { return r.text(); })
    .then(function(html) { panel.innerHTML = html; })
    .catch(function() { panel.innerHTML = '<div class="preview-loading">Failed to load</div>'; });
}

function summarizeSession(id, e) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  var panel = document.getElementById('preview-' + id);
  if (!panel) return;
  // Close other previews
  document.querySelectorAll('.s-preview.open').forEach(function(p) { p.classList.remove('open'); p.innerHTML = ''; });
  panel.innerHTML = '<div class="preview-loading">Generating summary...</div>';
  panel.classList.add('open');
  // POST to trigger generation
  fetch('/api/sessions/' + id + '/summary', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === 'done') {
        panel.innerHTML = '<div class="preview-turn"><div class="preview-role">Summary</div><div class="preview-content">' + data.summary + '</div></div>';
        // Also update the title in the row if it has no title
        var row = document.querySelector('a[href="/c/' + id + '"]');
        if (row && !row.querySelector('.s-title')) {
          var sessionSpan = row.querySelector('.s-session');
          if (sessionSpan) {
            var titleSpan = document.createElement('span');
            titleSpan.className = 's-title';
            titleSpan.textContent = data.summary.length > 60 ? data.summary.substring(0, 60) + '...' : data.summary;
            sessionSpan.appendChild(titleSpan);
          }
        }
      } else if (data.status === 'generating') {
        // Poll until done
        pollSummary(id, panel);
      } else if (data.status === 'error') {
        panel.innerHTML = '<div class="preview-loading">Error: ' + (data.error || 'Unknown error') + '</div>';
      }
    })
    .catch(function() { panel.innerHTML = '<div class="preview-loading">Failed to generate summary</div>'; });
}

function pollSummary(id, panel) {
  setTimeout(function() {
    fetch('/api/sessions/' + id + '/summary')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.status === 'done') {
          panel.innerHTML = '<div class="preview-turn"><div class="preview-role">Summary</div><div class="preview-content">' + data.summary + '</div></div>';
          var row = document.querySelector('a[href="/c/' + id + '"]');
          if (row && !row.querySelector('.s-title')) {
            var sessionSpan = row.querySelector('.s-session');
            if (sessionSpan) {
              var titleSpan = document.createElement('span');
              titleSpan.className = 's-title';
              titleSpan.textContent = data.summary.length > 60 ? data.summary.substring(0, 60) + '...' : data.summary;
              sessionSpan.appendChild(titleSpan);
            }
          }
        } else if (data.status === 'generating') {
          pollSummary(id, panel);
        } else {
          panel.innerHTML = '<div class="preview-loading">Error: ' + (data.error || 'Failed') + '</div>';
        }
      })
      .catch(function() { panel.innerHTML = '<div class="preview-loading">Failed to check status</div>'; });
  }, 2000);
}

function closeMenus() {
  document.querySelectorAll('.s-actions-menu.open').forEach(function(m) { m.classList.remove('open'); });
}

function copyResume(id, e) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  navigator.clipboard.writeText('claude --resume ' + id).then(function() {
    // Brief visual feedback not needed — menu is already closed
  });
}

function resumeSession(id, e) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  fetch('/api/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id })
  }).catch(function() {});
}

var truncateEnabled = localStorage.getItem('gloss_truncate_id') === '1';
var truncateMode = localStorage.getItem('gloss_truncate_mode') || 'first8';

function truncateId(id) {
  if (!truncateEnabled || !id) return id;
  if (truncateMode === 'last8') return '\\u2026' + id.slice(-8);
  return id.slice(0, 8) + '\\u2026';
}

function toggleTruncate() {
  truncateEnabled = !truncateEnabled;
  localStorage.setItem('gloss_truncate_id', truncateEnabled ? '1' : '0');
  document.getElementById('truncateToggle').classList.toggle('on', truncateEnabled);
  document.getElementById('truncateOptions').style.display = truncateEnabled ? '' : 'none';
  render();
}

function setTruncateMode(mode) {
  truncateMode = mode;
  localStorage.setItem('gloss_truncate_mode', mode);
  document.querySelectorAll('.truncate-opt').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); });
  render();
}

function spawnQuick() {
  fetch('/api/spawn-quick', { method: 'POST' }).catch(function() {});
}

function toggleResume() {
  SETTINGS.resume_enabled = !SETTINGS.resume_enabled;
  document.getElementById('resumeToggle').classList.toggle('on', SETTINGS.resume_enabled);
  document.getElementById('resumeOptions').style.display = SETTINGS.resume_enabled ? '' : 'none';
  saveSetting('resume_enabled', SETTINGS.resume_enabled);
  render();
}

function saveTerminalApp() {
  var val = document.getElementById('terminalSelect').value;
  SETTINGS.terminal_app = val;
  saveSetting('terminal_app', val);
}

function toggleDangerous() {
  SETTINGS.resume_dangerous_mode = !SETTINGS.resume_dangerous_mode;
  document.getElementById('dangerousToggle').classList.toggle('on', SETTINGS.resume_dangerous_mode);
  saveSetting('resume_dangerous_mode', SETTINGS.resume_dangerous_mode);
}

function renameSession(id, e) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  const row = e.target.closest('.session-row');
  if (!row) return;
  const sess = ALL.find(s => s.id === id);
  const oldTitle = sess ? sess.title : '';

  const cell = row.querySelector('.s-session');
  if (!cell) return;
  const titleSpan = cell.querySelector('.s-title');

  // Temporarily disable the link to prevent Enter from navigating
  const savedHref = row.getAttribute('href');
  row.removeAttribute('href');
  row.style.cursor = 'text';
  function blockClick(ev) { ev.preventDefault(); ev.stopPropagation(); }
  row.addEventListener('click', blockClick, true);

  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = oldTitle;
  input.placeholder = 'Enter title...';

  if (titleSpan) titleSpan.style.display = 'none';
  cell.appendChild(input);
  input.focus();
  input.select();

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    const val = input.value.trim();
    input.remove();
    if (titleSpan) titleSpan.style.display = '';
    // Restore the link
    if (savedHref) row.setAttribute('href', savedHref);
    row.style.cursor = '';
    row.removeEventListener('click', blockClick, true);
    if (val !== oldTitle) {
      fetch('/api/sessions/' + id + '/title', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: val })
      }).then(() => {
        if (sess) sess.title = val;
        render();
      });
    }
  }

  input.addEventListener('keydown', function(ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finish(); }
    if (ev.key === 'Escape') { finished = true; input.remove(); if (titleSpan) titleSpan.style.display = ''; if (savedHref) row.setAttribute('href', savedHref); row.style.cursor = ''; row.removeEventListener('click', blockClick, true); }
  });
  input.addEventListener('blur', finish);
}

function hideSession(id, e) {
  e.preventDefault();
  e.stopPropagation();
  closeMenus();
  const sess = ALL.find(s => s.id === id);
  const newHidden = sess && sess.hidden ? 0 : 1;
  fetch('/api/sessions/' + id + '/hidden', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: !!newHidden })
  }).then(() => {
    if (sess) sess.hidden = newHidden;
    render();
  });
}

// --- Settings ---
function toggleSettings() {
  const drop = document.getElementById('settingsDrop');
  const isOpen = drop.classList.toggle('open');
  if (isOpen) initSettings();
}

function initSettings() {
  document.getElementById('minTurnsInput').value = SETTINGS.min_turns || '';
  var toggle = document.getElementById('embeddingsToggle');
  toggle.classList.toggle('on', SETTINGS.embeddings_enabled);
  var hiddenToggle = document.getElementById('hiddenToggle');
  if (hiddenToggle) hiddenToggle.classList.toggle('on', showHidden);
  // Truncate settings
  var truncToggle = document.getElementById('truncateToggle');
  if (truncToggle) truncToggle.classList.toggle('on', truncateEnabled);
  var truncOpts = document.getElementById('truncateOptions');
  if (truncOpts) truncOpts.style.display = truncateEnabled ? '' : 'none';
  document.querySelectorAll('.truncate-opt').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === truncateMode); });
  // Resume settings
  var resumeToggle = document.getElementById('resumeToggle');
  if (resumeToggle) resumeToggle.classList.toggle('on', SETTINGS.resume_enabled);
  var resumeOpts = document.getElementById('resumeOptions');
  if (resumeOpts) resumeOpts.style.display = SETTINGS.resume_enabled ? '' : 'none';
  var termSelect = document.getElementById('terminalSelect');
  if (termSelect) termSelect.value = SETTINGS.terminal_app || 'Terminal';
  var dangerousToggle = document.getElementById('dangerousToggle');
  if (dangerousToggle) dangerousToggle.classList.toggle('on', SETTINGS.resume_dangerous_mode);
  updateEmbeddingsNote();
  updateEmbeddingsUI();
}

function updateEmbeddingsNote() {
  const note = document.getElementById('embeddingsNote');
  if (SETTINGS.embeddings_enabled) {
    note.textContent = 'Enabled — powers AI-powered search across conversations';
  } else {
    note.textContent = 'Enable to search conversation content with AI. Requires a server restart and can take 1\\u20132 hours depending on backlog size.';
  }
}

function toggleEmbeddings() {
  SETTINGS.embeddings_enabled = !SETTINGS.embeddings_enabled;
  const toggle = document.getElementById('embeddingsToggle');
  toggle.classList.toggle('on', SETTINGS.embeddings_enabled);
  updateEmbeddingsNote();
  updateEmbeddingsUI();
  saveSetting('embeddings_enabled', SETTINGS.embeddings_enabled);
}

function updateEmbeddingsUI() {
  document.getElementById('minTurnsRow').style.display = SETTINGS.embeddings_enabled ? '' : 'none';
  document.getElementById('search').placeholder = SETTINGS.embeddings_enabled ? 'Search or ask a question...' : 'Search...';
}

let minTurnsTimer = null;
document.getElementById('minTurnsInput').addEventListener('input', function(e) {
  const val = Math.max(0, parseInt(e.target.value) || 0);
  SETTINGS.min_turns = val;
  clearTimeout(minTurnsTimer);
  minTurnsTimer = setTimeout(() => saveSetting('min_turns', val), 500);
});

function saveSetting(key, value) {
  const body = {};
  body[key] = value;
  fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(() => {
    const badge = document.getElementById('settingSaved');
    badge.classList.add('show');
    setTimeout(() => badge.classList.remove('show'), 1500);
  });
}

// Close settings dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.settings-wrap')) {
    document.getElementById('settingsDrop').classList.remove('open');
  }
});

// --- Theme ---
function setTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('convo-viewer-theme', t);
  updateThemeButtons();
}
function updateThemeButtons() {
  const current = document.documentElement.getAttribute('data-theme') || 'auto';
  document.querySelectorAll('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === current));
}
(function() {
  const saved = localStorage.getItem('convo-viewer-theme');
  if (saved && saved !== 'auto') document.documentElement.setAttribute('data-theme', saved);
  updateThemeButtons();
})();

// Set search placeholder based on embeddings state
document.getElementById('search').placeholder = SETTINGS.embeddings_enabled ? 'Search or ask a question...' : 'Search...';

render();
</script>
</body>
</html>`;
}
