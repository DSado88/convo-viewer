import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createConversationParser, assistantLabelFor } from "./parser-factory.js";
import type { ConversationParser } from "./types.js";
import { buildPageParams } from "./convert.js";
import { buildHtmlPage, safeForScript } from "./templates/html-template.js";
import { buildClientJs } from "./templates/client-js.js";
import { CSS_STYLES } from "./templates/css.js";
import { renderTurn } from "./renderer.js";
import { escape } from "./markdown.js";
import { openDb, type ConvoDb } from "./db.js";
import { scanAllProjects, syncToDb, backfillTurnCounts, backfillFtsIndex } from "./discovery.js";
import { buildServerIndex, deriveProjectNames } from "./index-page.js";
import { buildToolViewerPage, buildMemoryPage } from "./tool-viewer.js";
import { EmbeddingEngine, VectorIndex } from "./embeddings.js";
import { backfillEmbeddings } from "./indexer.js";
import { resolveRemoteConfig, guardRequest, authedViaQuery, buildAuthCookie, type RemoteConfig } from "./remote-guard.js";
import type { Turn, TextBlock, TocEntry } from "./types.js";
import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface SessionState {
  path: string;
  parser: ConversationParser;
  byteOffset: number;
  partialLine: string;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  clients: Set<ServerWebSocket<{ sessionId: string }>>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionState>();

function buildTocItemHtml(entry: TocEntry): string {
  const preview = entry.preview ? escape(entry.preview) : "(no text)";
  const ts = entry.timestamp
    ? `<span class="toc-time">${escape(entry.timestamp)}</span>`
    : "";
  const label = escape(entry.label);
  return (
    `<div class="toc-item toc-${entry.role}" onclick="document.getElementById('${entry.id}').scrollIntoView({behavior:'smooth',block:'start'});closeToc();">` +
    `<div class="toc-item-header"><span class="toc-role">${label}</span>${ts}</div>` +
    `<div class="toc-item-preview">${preview}</div>` +
    `</div>`
  );
}

function buildConvoDataEntry(turn: Turn) {
  return {
    role: turn.role,
    timestamp: turn.timestamp || "",
    text: turn.blocks
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text || ""),
  };
}

// ---------------------------------------------------------------------------
// Per-session file watching + incremental parse
// ---------------------------------------------------------------------------

export function getOrCreateSession(sessionId: string, jsonlPath: string): SessionState {
  let state = sessions.get(sessionId);
  if (state) return state;

  const parser = createConversationParser();

  // Parse existing file content. Hold an unterminated final line as the
  // partial so a mid-write last line isn't fed as if complete (live-tail).
  let byteOffset = 0;
  let partialLine = "";
  if (fs.existsSync(jsonlPath)) {
    const content = fs.readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n");
    if (content.endsWith("\n")) {
      lines.pop(); // trailing "" from the final newline
    } else if (content.length > 0) {
      partialLine = lines.pop() || ""; // unterminated tail — reconstruct on next read
    }
    parser.feedLines(lines);
    byteOffset = Buffer.byteLength(content, "utf-8");
  }

  state = {
    path: jsonlPath,
    parser,
    byteOffset,
    partialLine,
    watcher: null,
    pollTimer: null,
    clients: new Set(),
    debounceTimer: null,
  };
  sessions.set(sessionId, state);
  return state;
}

function broadcast(state: SessionState, message: object) {
  const data = JSON.stringify(message);
  for (const client of state.clients) {
    try {
      client.send(data);
    } catch {
      state.clients.delete(client);
    }
  }
}

function processFileChanges(
  state: SessionState,
  includeThinking: boolean,
  includeTools: boolean,
) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(state.path);
  } catch {
    return;
  }
  const currentSize = stat.size;
  if (currentSize <= state.byteOffset) return;

  const fd = fs.openSync(state.path, "r");
  let newBytes: Buffer;
  try {
    newBytes = Buffer.alloc(currentSize - state.byteOffset);
    fs.readSync(fd, newBytes, 0, newBytes.length, state.byteOffset);
  } finally {
    fs.closeSync(fd);
  }
  state.byteOffset = currentSize;

  const newText = state.partialLine + newBytes.toString("utf-8");
  const lines = newText.split("\n");

  if (!newText.endsWith("\n")) {
    state.partialLine = lines.pop() || "";
  } else {
    state.partialLine = "";
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  if (lines.length === 0) return;

  const updates = state.parser.feedLines(lines);
  const assistantLabel = assistantLabelFor(state.parser);

  for (const update of updates) {
    const allTurns = state.parser.getTurns();
    const prevTs = update.turnIndex > 0 ? allTurns[update.turnIndex - 1]?.timestamp : undefined;
    const { html, tocEntry } = renderTurn(
      update.turn,
      update.turnIndex,
      includeThinking,
      includeTools,
      prevTs,
      assistantLabel,
    );

    // Skip broadcasting turns with no renderable content
    if (!html) continue;

    const tocHtml = tocEntry ? buildTocItemHtml(tocEntry) : undefined;
    const convoDataEntry = buildConvoDataEntry(update.turn);

    broadcast(state, {
      type: update.type,
      turnIndex: update.turnIndex,
      html,
      tocHtml: tocHtml || "",
      convoDataEntry,
    });
  }
}

function startWatcher(
  state: SessionState,
  includeThinking: boolean,
  includeTools: boolean,
) {
  if (state.watcher) return;

  const doProcess = () => {
    try {
      processFileChanges(state, includeThinking, includeTools);
    } catch (err) {
      console.error("Error processing file changes:", err);
    }
  };

  // Primary: fs.watch (instant notification)
  state.watcher = fs.watch(state.path, () => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(doProcess, 50);
  });

  // Safety net: poll every 2s to catch events FSEvents drops on macOS
  state.pollTimer = setInterval(doProcess, 2000);
}

function stopWatcher(state: SessionState) {
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/**
 * Drop a client from a session. When the last client disconnects, stop the
 * watcher and evict the SessionState so its fully-parsed conversation is freed
 * — otherwise every session ever viewed accumulates in memory for the life of
 * the process (unbounded heap growth → GC pressure).
 */
export function releaseClient(
  sessionId: string,
  ws: ServerWebSocket<{ sessionId: string }>,
): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  state.clients.delete(ws);
  if (state.clients.size === 0) {
    stopWatcher(state);
    sessions.delete(sessionId);
  }
}

/** Test/diagnostics hook: number of live in-memory session states. */
export function __sessionCount(): number {
  return sessions.size;
}

// ---------------------------------------------------------------------------
// Cached static assets
// ---------------------------------------------------------------------------

const clientJsContent = buildClientJs();

// Index page cache — regenerated at most every 30s
let indexHtmlCache: string | null = null;
let indexHtmlCacheTime = 0;
const INDEX_CACHE_TTL = 30_000;

// Tool viewer cache — eagerly built at startup, refreshed every 5 minutes
let toolViewerHtmlCache: string | null = null;
let toolViewerCacheTime = 0;
const TOOL_VIEWER_CACHE_TTL = 5 * 60_000;

function getToolViewerHtml(): string {
  const now = Date.now();
  if (toolViewerHtmlCache && now - toolViewerCacheTime < TOOL_VIEWER_CACHE_TTL) {
    return toolViewerHtmlCache;
  }
  toolViewerHtmlCache = buildToolViewerPage();
  toolViewerCacheTime = now;
  return toolViewerHtmlCache;
}

function getIndexHtml(db: ConvoDb): string {
  const now = Date.now();
  if (indexHtmlCache && now - indexHtmlCacheTime < INDEX_CACHE_TTL) {
    return indexHtmlCache;
  }
  const allSessions = db.listSessions({ includeHidden: true });
  const settings = {
    embeddings_enabled: db.getSetting("embeddings_enabled") === "1",
    min_turns: parseInt(db.getSetting("min_turns") ?? "0", 10),
    resume_enabled: db.getSetting("resume_enabled") === "1",
    terminal_app: db.getSetting("terminal_app") || "Terminal",
    resume_dangerous_mode: db.getSetting("resume_dangerous_mode") === "1",
    quick_launch_name: (() => {
      const p = db.getSetting("quick_launch_path");
      return p ? path.basename(p) : "";
    })(),
  };
  indexHtmlCache = buildServerIndex(allSessions, settings);
  indexHtmlCacheTime = now;
  return indexHtmlCache;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(options: { port?: number } = {}): Promise<void> {
  const port = options.port ?? 3456;
  // Fail fast on misconfiguration (e.g. GLOSS_REMOTE=1 without a token)
  const remoteCfg = resolveRemoteConfig(process.env);
  const db = openDb();

  // Discovery: scan and sync
  console.log("Scanning for conversations...");
  const { sessions: discovered } = scanAllProjects();
  syncToDb(db, discovered);
  console.log(`Found ${discovered.length} conversations`);

  // Import legacy sidecar annotations
  importLegacySidecars(db);

  // Initialize embedding engine: CLI flag overrides, then check DB setting.
  // If the setting has never been set, default to enabled (backward compat).
  const embeddingsSetting = db.getSetting("embeddings_enabled");
  const embeddingsDisabled = process.env.GLOSS_NO_EMBEDDINGS
    ? true
    : embeddingsSetting === "0";
  // Persist the resolved state so the UI reflects reality
  if (!embeddingsSetting) {
    db.setSetting("embeddings_enabled", embeddingsDisabled ? "0" : "1");
  }
  let embeddingEngine: EmbeddingEngine | undefined;
  let vectorIndex: VectorIndex | null = null;

  if (!embeddingsDisabled) {
    embeddingEngine = new EmbeddingEngine();

    // Load existing embeddings into memory
    try {
      vectorIndex = VectorIndex.fromDb(db);
      if (vectorIndex.count > 0) {
        console.log(`Loaded ${vectorIndex.count} embeddings into vector index`);
      }
    } catch {
      // first run, no embeddings yet
    }
  }

  /** Kick off embedding backfill if engine is ready. */
  const startEmbeddingBackfill = () => {
    if (!embeddingEngine) return;
    const minTurns = parseInt(db.getSetting("min_turns") ?? "0", 10);
    if (embeddingEngine.isReady()) {
      backfillEmbeddings(db, embeddingEngine, vectorIndex, { minTurns });
    } else {
      // Wait for engine to load, then backfill
      embeddingEngine.waitReady().then(() => {
        backfillEmbeddings(db, embeddingEngine!, vectorIndex, { minTurns });
      }).catch(() => {
        // Model failed to load — skip embeddings entirely
      });
    }
  };

  // Background: count turns, then FTS, then embeddings
  const invalidateIndex = () => { indexHtmlCache = null; };
  setTimeout(() => {
    backfillTurnCounts(db, invalidateIndex);
    setTimeout(() => backfillFtsIndex(db, startEmbeddingBackfill), 2000);
  }, 500);

  // Eagerly build tool viewer cache in background so first load is instant
  setTimeout(() => {
    try { getToolViewerHtml(); } catch { /* best-effort */ }
  }, 1000);

  // Adaptive rescan with backoff — backs off when no changes, resets on activity
  const MIN_RESCAN_MS = 60_000;
  const MAX_RESCAN_MS = 5 * 60_000;
  let rescanInterval = MIN_RESCAN_MS;

  // Shared by the timer and POST /api/scan. Burst scans (e.g. MCP clients
  // hitting /api/scan) must not stack identical backfill chains — one chain
  // at a time; the next scan reschedules once it finishes.
  let backfillInFlight = false;
  const runScan = (): { changedCount: number; total: number } => {
    const { sessions: freshSessions, changedCount } = scanAllProjects();
    syncToDb(db, freshSessions);

    if (changedCount > 0) {
      rescanInterval = MIN_RESCAN_MS; // Reset on changes
      indexHtmlCache = null; // Invalidate index page cache
    } else {
      rescanInterval = Math.min(rescanInterval * 1.5, MAX_RESCAN_MS);
    }

    // Always run backfills (incomplete indexes need catching up too)
    if (!backfillInFlight) {
      backfillInFlight = true;
      setTimeout(() => {
        try {
          backfillTurnCounts(db, invalidateIndex);
        } catch {
          // best-effort
        }
        setTimeout(() => {
          try {
            backfillFtsIndex(db, startEmbeddingBackfill);
          } catch {
            // best-effort
          } finally {
            backfillInFlight = false;
          }
        }, 2000);
      }, 500);
    }

    return { changedCount, total: freshSessions.length };
  };

  const scheduleRescan = () => {
    setTimeout(() => {
      try {
        runScan();
      } catch {
        // best-effort
      }
      scheduleRescan();
    }, rescanInterval);
  };
  scheduleRescan();

  const includeThinking = true;
  const includeTools = true;

  const handler = createRequestHandler({
    db,
    port,
    remoteCfg,
    search: { embeddingEngine, vectorIndex },
    includeThinking,
    includeTools,
    onScanRequest: runScan,
  });

  const server = Bun.serve<{ sessionId: string }>({
    port,
    hostname: remoteCfg.bindHost,
    idleTimeout: 120, // seconds — ask endpoint shells out to claude
    fetch: handler,

    websocket: {
      open(ws) {
        const sessionId = ws.data.sessionId;
        const session = db.getSession(sessionId);
        if (!session?.jsonl_path) return;

        const state = getOrCreateSession(sessionId, session.jsonl_path);
        state.clients.add(ws);
        // Lazy: start watcher when first client connects
        startWatcher(state, includeThinking, includeTools);
      },
      close(ws) {
        releaseClient(ws.data.sessionId, ws);
      },
      message(_ws, _message) {
        // No client-to-server messages needed yet
      },
    },
  });

  const displayHost = !remoteCfg.bindHost || remoteCfg.bindHost === "0.0.0.0"
    ? "localhost"
    : remoteCfg.bindHost;
  const serverUrl = `http://${displayHost}:${port}`;
  console.log(`Convo Viewer at ${serverUrl}${remoteCfg.remote ? " (remote-safe mode)" : ""}`);

  // Open browser on macOS — local mode only (a headless service has no GUI session)
  if (process.platform === "darwin" && !remoteCfg.remote) {
    Bun.spawn(["open", serverUrl], { stdio: ["ignore", "ignore", "ignore"] });
  }

  // Cleanup on shutdown
  process.on("SIGINT", () => {
    for (const state of sessions.values()) stopWatcher(state);
    embeddingEngine?.dispose();
    db.close();
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    for (const state of sessions.values()) stopWatcher(state);
    embeddingEngine?.dispose();
    db.close();
    server.stop();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Request handler factory — the real routing logic, exported so tests can
// exercise auth + routes against a temp DB without startServer's side effects
// ---------------------------------------------------------------------------

export interface RequestHandlerDeps {
  db: ConvoDb;
  port: number;
  remoteCfg?: RemoteConfig;
  search?: { embeddingEngine?: EmbeddingEngine; vectorIndex?: VectorIndex | null };
  includeThinking?: boolean;
  includeTools?: boolean;
  /** Force an immediate rescan (POST /api/scan). Sync clients call this after
   *  pushing fresh JSONL so new sessions appear without waiting for the timer. */
  onScanRequest?: () => { changedCount: number; total: number };
}

interface UpgradeServer {
  upgrade(req: Request, opts: { data: { sessionId: string } }): boolean;
}

export function createRequestHandler(deps: RequestHandlerDeps) {
  const { db, port } = deps;
  const remoteCfg = deps.remoteCfg ?? resolveRemoteConfig();
  const search = deps.search ?? {};
  const includeThinking = deps.includeThinking ?? true;
  const includeTools = deps.includeTools ?? true;

  return async function handleRequest(req: Request, server: UpgradeServer): Promise<Response | undefined> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    const denied = guardRequest(req, pathname, remoteCfg);
    if (denied) return denied;

    // WebSocket upgrade: /ws/:sessionId
    if (pathname.startsWith("/ws/")) {
      const sessionId = pathname.slice(4);
      const upgraded = server.upgrade(req, { data: { sessionId } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // Authenticated via a one-time ?token= link — set the session cookie so
    // subsequent requests (and the WebSocket upgrade) authenticate automatically.
    // For GETs, redirect to the same URL minus the token: the raw secret must
    // not linger in the address bar, browser history, or Referer headers.
    if (authedViaQuery(req, remoteCfg) && req.method === "GET") {
      const stripped = new URL(url);
      stripped.searchParams.delete("token");
      return new Response(null, {
        status: 302,
        headers: {
          Location: stripped.pathname + stripped.search,
          "Set-Cookie": buildAuthCookie(remoteCfg),
        },
      });
    }
    const res = await route(req, url, pathname);
    if (authedViaQuery(req, remoteCfg)) {
      try {
        res.headers.append("Set-Cookie", buildAuthCookie(remoteCfg));
      } catch {
        const headers = new Headers(res.headers);
        headers.append("Set-Cookie", buildAuthCookie(remoteCfg));
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
    }
    return res;
  };

  async function route(req: Request, url: URL, pathname: string): Promise<Response> {

      // Static assets
      if (pathname === "/assets/style.css") {
        return new Response(CSS_STYLES, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=60" },
        });
      }
      if (pathname === "/assets/client.js") {
        return new Response(clientJsContent, {
          headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=60" },
        });
      }
      if (pathname === "/assets/logo.png") {
        const logoPath = path.join(import.meta.dir, "..", "assets", "logo.png");
        try {
          const file = fs.readFileSync(logoPath);
          return new Response(file, {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }

      // Spawn quick-launch project in a new terminal window
      if (pathname === "/api/spawn-quick" && req.method === "POST") {
        const quickPath = db.getSetting("quick_launch_path");
        if (!quickPath) {
          return new Response(JSON.stringify({ error: "No quick launch path configured" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const terminalApp = db.getSetting("terminal_app") || "Terminal";
        const cmd = `cd ${quickPath.replace(/ /g, "\\\\ ")} && claude --dangerously-skip-permissions`;
        let script: string;
        if (terminalApp === "Warp") {
          script = `tell application "Warp" to activate
          delay 0.3
          tell application "System Events" to tell process "Warp"
            keystroke "n" using command down
            delay 0.5
            keystroke "${cmd}"
            key code 36
          end tell`;
        } else if (terminalApp === "iTerm2" || terminalApp === "iTerm") {
          script = `tell application "iTerm2"
            activate
            create window with default profile
            tell current session of current window to write text "${cmd}"
          end tell`;
        } else {
          script = `tell application "Terminal" to activate
          tell application "Terminal" to do script "${cmd}"`;
        }
        try {
          Bun.spawnSync(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
          return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        } catch {
          return new Response(JSON.stringify({ error: "Failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }

      // Resume session in terminal
      if (pathname === "/api/resume" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const sessionId = (body.sessionId as string) ?? "";
        if (!sessionId) {
          return new Response(JSON.stringify({ error: "No session ID" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const terminalApp = db.getSetting("terminal_app") || "Terminal";
        const dangerous = db.getSetting("resume_dangerous_mode") === "1";

        // Resolve the project directory from the session's JSONL path
        const session = db.getSession(sessionId);
        let projectDir = "";
        if (session?.jsonl_path) {
          // JSONL path is like ~/.claude/projects/-Users-david-Documents-Programs-ori3/session.jsonl
          // The encoded dir name maps back to the real project path
          const encodedDir = session.jsonl_path.split("/").slice(-2, -1)[0] ?? "";
          if (encodedDir.startsWith("-")) {
            // Try to resolve the real path
            const { decodeProjectPath } = await import("./tool-viewer.js");
            const resolved = decodeProjectPath(encodedDir);
            if (resolved) projectDir = resolved;
          }
        }

        const resumeCmd = `claude --resume ${sessionId}${dangerous ? " --dangerously-skip-permissions" : ""}`;
        const cmd = projectDir ? `cd ${projectDir.replace(/ /g, "\\\\ ")} && ${resumeCmd}` : resumeCmd;

        let script: string;
        if (terminalApp === "iTerm2" || terminalApp === "iTerm") {
          script = `tell application "iTerm2"
            activate
            create window with default profile
            tell current session of current window to write text "${cmd}"
          end tell`;
        } else if (terminalApp === "Warp") {
          script = `tell application "Warp"
            activate
            delay 0.3
          end tell
          tell application "System Events"
            tell process "Warp"
              keystroke "n" using command down
              delay 0.5
              keystroke "${cmd}"
              key code 36
            end tell
          end tell`;
        } else if (terminalApp === "Ghostty") {
          script = `tell application "Ghostty"
            activate
          end tell
          tell application "System Events"
            tell process "Ghostty"
              keystroke "n" using command down
              delay 0.5
              keystroke "${cmd}"
              key code 36
            end tell
          end tell`;
        } else {
          // Terminal.app (default)
          script = `tell application "Terminal"
            activate
            do script "${cmd}"
          end tell`;
        }

        try {
          Bun.spawnSync(["osascript", "-e", script], {
            stdout: "pipe", stderr: "pipe", timeout: 10_000,
          });
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Preview last turns — returns rendered HTML
      if (pathname.match(/^\/api\/sessions\/([^/]+)\/preview$/) && req.method === "GET") {
        const sessionId = pathname.split("/")[3];
        const session = db.getSession(sessionId);
        if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
          return new Response("<div class='preview-loading'>Session not found</div>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        try {
          const { renderMarkdownInline } = await import("./markdown.js");
          const parser = createConversationParser();
          const content = fs.readFileSync(session.jsonl_path, "utf-8");
          parser.feedLines(content.split("\n"));
          const turns = parser.getTurns();
          const assistantLabel = assistantLabelFor(parser);
          // Get last 2 turns
          const lastTurns = turns.slice(-2);
          let html = "";
          for (const turn of lastTurns) {
            const role = turn.role ?? "assistant";
            const label = role === "user" ? "You" : assistantLabel;
            const texts = turn.blocks
              .filter((b): b is import("./types.js").TextBlock => b.type === "text")
              .map((b) => b.text || "");
            let text = texts.join("\n").trim();
            if (text.length > 1500) text = text.substring(0, 1500) + "\n\n[truncated...]";
            const rendered = renderMarkdownInline(text);
            html += `<div class="preview-turn turn-${role}">`;
            html += `<div class="preview-role">${label}</div>`;
            html += `<div class="preview-content">${rendered}</div>`;
            html += `</div>`;
          }
          return new Response(html || "<div class='preview-loading'>No turns</div>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        } catch {
          return new Response("<div class='preview-loading'>Failed to load</div>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      // Summary — GET reads status, POST triggers generation
      if (pathname.match(/^\/api\/sessions\/([^/]+)\/summary$/) && (req.method === "GET" || req.method === "POST")) {
        const sessionId = pathname.split("/")[3];
        const { getSummary, generateSummary } = await import("./summary.js");
        if (req.method === "GET") {
          const result = getSummary(db, sessionId);
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        } else {
          const result = await generateSummary(db, sessionId);
          const status = result.status === "generating" ? 202 : 200;
          return new Response(JSON.stringify(result), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Folder picker — opens native Finder dialog
      if (pathname === "/api/pick-folder" && req.method === "POST") {
        try {
          const proc = Bun.spawnSync(["osascript", "-e",
            'tell application "System Events" to set frontmost of process "Google Chrome" to true\n' +
            'set f to POSIX path of (choose folder with prompt "Select backup destination")\n' +
            'return f',
          ], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
          const folder = proc.stdout.toString().trim();
          if (folder) {
            return new Response(JSON.stringify({ path: folder }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ cancelled: true }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch {
          return new Response(JSON.stringify({ error: "Folder picker not available" }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Backup API
      if (pathname === "/api/backup" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const dest = (body.destination as string) ?? "";
        const full = !!(body.full);
        if (!dest) {
          return new Response(JSON.stringify({ error: "No destination path" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const scriptPath = path.join(import.meta.dir, "..", "scripts", "backup.ts");
          const args = [scriptPath, dest];
          if (full) args.push("--full");
          const proc = Bun.spawnSync(["bun", ...args], {
            stdout: "pipe", stderr: "pipe", timeout: 600_000,
          });
          const output = proc.stdout.toString() + proc.stderr.toString();
          return new Response(JSON.stringify({ ok: proc.exitCode === 0, output }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Force rescan
      if (pathname === "/api/scan" && req.method === "POST") {
        if (!deps.onScanRequest) {
          return new Response(JSON.stringify({ error: "Scan not available" }), {
            status: 503, headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const result = deps.onScanRequest();
          return new Response(JSON.stringify({ ok: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }

      // API routes
      if (pathname.startsWith("/api/")) {
        return handleApiRoute(req, pathname, db, search);
      }

      // Conversation page: /c/:sessionId
      if (pathname.startsWith("/c/")) {
        const sessionId = pathname.slice(3);
        return renderConversationPage(sessionId, port, db, includeThinking, includeTools);
      }

      // Ask page: /ask?q=... — returns loading shell instantly
      if (pathname === "/ask") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return Response.redirect("/");
        const { buildAskLoadingPage } = await import("./ask-page.js");
        const html = buildAskLoadingPage(q);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Memory page
      if (pathname === "/memory") {
        const html = buildMemoryPage();
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Tool viewer page (cached)
      if (pathname === "/tools") {
        return new Response(getToolViewerHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Index page (cached, rebuilt every 30s)
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(getIndexHtml(db), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Conversation page cache — avoids re-reading + re-parsing the same JSONL
// ---------------------------------------------------------------------------

interface ConvoPageCache {
  html: string;
  mtimeMs: number;
  annCount: number;
}

const pageCache = new Map<string, ConvoPageCache>();
const PAGE_CACHE_MAX = 30; // max cached pages

function evictOldestPage(): void {
  if (pageCache.size <= PAGE_CACHE_MAX) return;
  // Delete the first (oldest inserted) entry
  const first = pageCache.keys().next().value;
  if (first) pageCache.delete(first);
}

/** Invalidate page cache for a session (e.g. after annotation change). */
export function invalidatePageCache(sessionId: string): void {
  pageCache.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Render a conversation page on demand
// ---------------------------------------------------------------------------

function renderConversationPage(
  sessionId: string,
  port: number,
  db: ConvoDb,
  includeThinking: boolean,
  includeTools: boolean,
): Response {
  const session = db.getSession(sessionId);
  if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
    return new Response("Conversation not found", { status: 404 });
  }

  // Guard against OOM on very large files
  let stat: fs.Stats;
  try {
    stat = fs.statSync(session.jsonl_path);
    if (stat.size > 300 * 1024 * 1024) {
      return new Response(
        `<html><body style="font-family:system-ui;padding:40px;color:#e6edf3;background:#0d1117">` +
        `<h2>Session too large to render</h2>` +
        `<p>This JSONL is ${(stat.size / 1048576).toFixed(0)} MB — too large for in-memory rendering.</p>` +
        `<p><a href="/" style="color:#da7756">Back to index</a></p></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
  } catch {
    return new Response("Could not stat file", { status: 500 });
  }

  // Check page cache — reuse if file hasn't changed and annotation count matches
  const annCount = db.getSessionAnnotations(sessionId).length;
  const cached = pageCache.get(sessionId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.annCount === annCount) {
    return new Response(cached.html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Parse the full JSONL
  const parser = createConversationParser();
  const content = fs.readFileSync(session.jsonl_path, "utf-8");
  const lines = content.split("\n");
  parser.feedLines(lines);

  const meta = parser.getMetadata();
  const turns = parser.getTurns();

  if (turns.length === 0 && lines.length > 1) {
    // Debug: count parseable lines and their types
    const types = new Map<string, number>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const t = obj.type ?? "unknown";
        types.set(t, (types.get(t) ?? 0) + 1);
      } catch { /* skip */ }
    }
    console.warn(
      `[gloss] Session ${sessionId}: 0 turns parsed from ${lines.length} lines (${session.jsonl_path}).` +
      ` Line types: ${[...types.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }

  const convo = {
    sessionId: meta.sessionId ?? sessionId,
    projectDir: meta.projectDir,
    model: meta.model,
    version: meta.version,
    startTime: meta.startTime,
    turns,
  };

  const viewerDir = path.join(os.homedir(), ".claude", "viewer");
  const wsUrl = `ws://localhost:${port}/ws/${sessionId}`;

  // Load baked annotations from DB
  const dbAnnotations = db.exportSessionAnnotations(sessionId);
  const bakedObj: Record<string, unknown> = {};
  for (const ann of dbAnnotations) {
    bakedObj[ann.id] = ann;
  }

  const params = buildPageParams(convo, session.jsonl_path, viewerDir, {
    includeThinking,
    includeTools,
    mode: "server",
    wsUrl,
    assistantLabel: session.format === "codex" ? "Codex" : "Claude",
  });

  // Pass custom title from DB if set
  if (session.title) {
    params.customTitle = session.title;
  }

  // Override baked annotations with DB data
  if (dbAnnotations.length > 0) {
    params.bakedAnnotationsJson = safeForScript(JSON.stringify(bakedObj));
  }

  // Update turn count in DB
  db.upsertSession({
    id: sessionId,
    jsonl_path: session.jsonl_path,
    turn_count: convo.turns.length,
    model: convo.model ?? undefined,
    project: convo.projectDir ?? undefined,
    start_time: convo.startTime
      ? Math.floor(new Date(convo.startTime).getTime() / 1000)
      : undefined,
  });

  const html = buildHtmlPage(params);

  // Cache the rendered page
  pageCache.set(sessionId, { html, mtimeMs: stat.mtimeMs, annCount });
  evictOldestPage();

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

export async function handleApiRoute(
  req: Request,
  pathname: string,
  db: ConvoDb,
  search?: { embeddingEngine?: EmbeddingEngine; vectorIndex?: VectorIndex | null },
): Promise<Response> {
  const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

  try {
    return await handleApiRouteInner(req, pathname, db, search);
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof TypeError) {
      return new Response(JSON.stringify({ error: "Invalid JSON in request body" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

async function handleApiRouteInner(
  req: Request,
  pathname: string,
  db: ConvoDb,
  search?: { embeddingEngine?: EmbeddingEngine; vectorIndex?: VectorIndex | null },
): Promise<Response> {
  const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

  // GET /api/sessions/:id/annotations
  const getAnnotationsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/annotations$/);
  if (getAnnotationsMatch && req.method === "GET") {
    const sessionId = getAnnotationsMatch[1];
    const annotations = db.getSessionAnnotations(sessionId);
    return new Response(JSON.stringify(annotations), { headers: jsonHeaders });
  }

  // POST /api/sessions/:id/annotations
  if (getAnnotationsMatch && req.method === "POST") {
    const sessionId = getAnnotationsMatch[1];
    if (!db.getSession(sessionId)) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404, headers: jsonHeaders,
      });
    }
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.id || typeof body.id !== "string") {
      return new Response(JSON.stringify({ error: "Missing required field: id" }), {
        status: 400, headers: jsonHeaders,
      });
    }
    db.upsertAnnotation({
      id: body.id as string,
      session_id: sessionId,
      turn_index: (body.turnIndex as number) ?? 0,
      block_index: (body.blockIndex as number) ?? 0,
      char_start: (body.charStart as number) ?? -1,
      char_end: (body.charEnd as number) ?? -1,
      text: (body.text as string) ?? "",
      comment: (body.comment as string) ?? "",
      kind: (body.kind as string) ?? "highlight",
      speaker: (body.speaker as string) ?? null,
      prefix: (body.prefix as string) ?? "",
      suffix: (body.suffix as string) ?? "",
      trigger: (body.trigger as string) ?? "",
    });
    // Replace tags atomically — filter to non-empty strings to prevent NOT NULL crash
    if (Array.isArray(body.tags)) {
      const safeTags = (body.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0);
      db.replaceAnnotationTags(body.id as string, safeTags);
    }
    // Broadcast to other WS clients on this session
    invalidatePageCache(sessionId);
    broadcastAnnotationSync(sessionId);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // PUT /api/sessions/:id/annotations/:annId
  const putAnnotationMatch = pathname.match(
    /^\/api\/sessions\/([^/]+)\/annotations\/([^/]+)$/,
  );
  if (putAnnotationMatch && req.method === "PUT") {
    const sessionId = putAnnotationMatch[1];
    if (!db.getSession(sessionId)) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404, headers: jsonHeaders,
      });
    }
    const annId = putAnnotationMatch[2];
    const body = (await req.json()) as Record<string, unknown>;
    db.upsertAnnotation({
      id: annId,
      session_id: sessionId,
      turn_index: (body.turnIndex as number) ?? 0,
      block_index: (body.blockIndex as number) ?? 0,
      char_start: (body.charStart as number) ?? -1,
      char_end: (body.charEnd as number) ?? -1,
      text: (body.text as string) ?? "",
      comment: (body.comment as string) ?? "",
      kind: (body.kind as string) ?? "highlight",
      speaker: (body.speaker as string) ?? null,
      prefix: (body.prefix as string) ?? "",
      suffix: (body.suffix as string) ?? "",
      trigger: (body.trigger as string) ?? "",
    });
    if (Array.isArray(body.tags)) {
      const safeTags = (body.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0);
      db.replaceAnnotationTags(annId, safeTags);
    }
    invalidatePageCache(sessionId);
    broadcastAnnotationSync(sessionId);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // DELETE /api/sessions/:id/annotations/:annId
  if (putAnnotationMatch && req.method === "DELETE") {
    const annId = putAnnotationMatch[2];
    const sessionId = putAnnotationMatch[1];
    db.deleteAnnotation(annId);
    invalidatePageCache(sessionId);
    broadcastAnnotationSync(sessionId);
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // GET /api/sessions/:id/data?start=N&end=N
  const dataMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/data$/);
  if (dataMatch && req.method === "GET") {
    const sessionId = dataMatch[1];
    const session = db.getSession(sessionId);
    if (!session?.jsonl_path || !fs.existsSync(session.jsonl_path)) {
      return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: jsonHeaders });
    }
    // Guard against OOM — same limit as renderConversationPage
    try {
      const stat = fs.statSync(session.jsonl_path);
      if (stat.size > 300 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: "Session too large — use start/end params to read a range" }), { status: 413, headers: jsonHeaders });
      }
    } catch {
      return new Response(JSON.stringify({ error: "Could not stat file" }), { status: 500, headers: jsonHeaders });
    }
    const parser = createConversationParser();
    parser.feedLines(fs.readFileSync(session.jsonl_path, "utf-8").split("\n"));
    const allTurns = parser.getTurns();

    // Optional server-side range slicing — avoids sending full transcript over HTTP
    const url = new URL(req.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    const maxIdx = Math.max(0, allTurns.length - 1);
    const rawStart = startParam != null ? parseInt(startParam, 10) : 0;
    const rawEnd = endParam != null ? parseInt(endParam, 10) : allTurns.length - 1;
    const start = Math.max(0, Math.min(isNaN(rawStart) ? 0 : rawStart, maxIdx));
    const end = Math.max(start, Math.min(isNaN(rawEnd) ? maxIdx : rawEnd, maxIdx));
    const slice = allTurns.slice(start, end + 1);

    const convoData = slice.map((turn) => ({
      role: turn.role,
      timestamp: turn.timestamp || "",
      text: turn.blocks
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text || ""),
    }));
    const meta = { totalTurns: allTurns.length, start, end };
    return new Response(JSON.stringify({ turns: convoData, ...meta }), { headers: jsonHeaders });
  }

  // POST /api/search-sources — retrieval only (no LLM synthesis)
  if (pathname === "/api/search-sources" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response(JSON.stringify({ error: "No query" }), { status: 400, headers: jsonHeaders });
    }
    const { searchForSources } = await import("./ask.js");
    const result = await searchForSources(db, q, {
      maxSources: (body.maxSources as number) ?? undefined,
      vectorIndex: search?.vectorIndex ?? undefined,
      embeddingEngine: search?.embeddingEngine,
    });
    // Convert Turn objects to plain text for API consumers
    const sources = result.sources.map((s, i) => ({
      num: i + 1,
      sessionId: s.sessionId,
      project: s.project,
      title: s.title,
      matchTurnIndex: s.matchTurnIndex,
      startTurnIndex: s.startTurnIndex,
      endTurnIndex: s.startTurnIndex + s.turns.length - 1,
      score: s.score != null ? Math.round(s.score * 1000) / 1000 : undefined,
      matchedTokens: s.matchedTokens,
      turns: s.turns.map((t, ti) => ({
        role: t.role,
        index: s.startTurnIndex + ti,
        text: t.blocks
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text || "")
          .join("\n"),
      })),
    }));
    return new Response(JSON.stringify({ query: q, sources, timing: result.timing }), { headers: jsonHeaders });
  }

  // POST /api/ask — JSON response
  if (pathname === "/api/ask" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response(JSON.stringify({ error: "No query" }), { status: 400, headers: jsonHeaders });
    }
    const { askQuestion } = await import("./ask.js");
    const result = await askQuestion(db, q, {
      maxSources: (body.maxSources as number) ?? undefined,
      vectorIndex: search?.vectorIndex ?? undefined,
      embeddingEngine: search?.embeddingEngine,
    });
    return new Response(JSON.stringify(result), { headers: jsonHeaders });
  }

  // POST /api/ask-html — returns rendered HTML fragment
  if (pathname === "/api/ask-html" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response("<div class=\"ask-error\">No query</div>", {
        status: 400, headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const { askQuestion } = await import("./ask.js");
    const { buildAskResultsHtml } = await import("./ask-page.js");
    const result = await askQuestion(db, q, {
      vectorIndex: search?.vectorIndex ?? undefined,
      embeddingEngine: search?.embeddingEngine,
    });
    const html = buildAskResultsHtml(result);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // POST /api/ask-stream — NDJSON streaming: sources first, then Claude chunks
  if (pathname === "/api/ask-stream" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const q = (body.query as string)?.trim();
    if (!q) {
      return new Response(JSON.stringify({ type: "error", message: "No query" }) + "\n", {
        status: 400, headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    const { askQuestionStream } = await import("./ask.js");
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of askQuestionStream(db, q, {
            vectorIndex: search?.vectorIndex ?? undefined,
            embeddingEngine: search?.embeddingEngine,
          })) {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: msg }) + "\n"));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "Transfer-Encoding": "chunked",
      },
    });
  }

  // GET /api/search?q=...
  if (pathname === "/api/search" && req.method === "GET") {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    if (!q) {
      return new Response(JSON.stringify({ results: [], indexed: db.ftsIndexedCount() }), { headers: jsonHeaders });
    }
    try {
      const results = db.searchSessions(q, 30);
      // Enrich with session metadata
      const enriched = results.map((r) => {
        const session = db.getSession(r.session_id);
        const names = deriveProjectNames(session?.project, session?.jsonl_path);
        return {
          id: r.session_id,
          match_count: r.match_count,
          ...names,
          title: session?.title ?? "",
          model: session?.model ?? "",
          last_modified: session?.last_modified ?? session?.start_time ?? 0,
          turn_count: session?.turn_count ?? 0,
          file_size: session?.file_size ?? 0,
        };
      });
      return new Response(JSON.stringify({ results: enriched, indexed: db.ftsIndexedCount() }), { headers: jsonHeaders });
    } catch {
      return new Response(JSON.stringify({ results: [], error: "Invalid search query", indexed: db.ftsIndexedCount() }), { headers: jsonHeaders });
    }
  }

  // PATCH /api/sessions/:id/title
  const titleMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
  if (titleMatch && req.method === "PATCH") {
    const sessionId = titleMatch[1];
    const body = (await req.json()) as Record<string, unknown>;
    const title = (body.title as string) ?? "";
    db.db.run("UPDATE sessions SET title = ? WHERE id = ?", [title || null, sessionId]);
    invalidatePageCache(sessionId);
    indexHtmlCache = null; // title shows on index page too
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // PATCH /api/sessions/:id/hidden
  const hiddenMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/hidden$/);
  if (hiddenMatch && req.method === "PATCH") {
    const sessionId = hiddenMatch[1];
    const body = (await req.json()) as Record<string, unknown>;
    const hidden = body.hidden ? 1 : 0;
    db.db.run("UPDATE sessions SET hidden = ? WHERE id = ?", [hidden, sessionId]);
    indexHtmlCache = null;
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // GET /api/settings
  if (pathname === "/api/settings" && req.method === "GET") {
    const settings = {
      embeddings_enabled: db.getSetting("embeddings_enabled") === "1",
      min_turns: parseInt(db.getSetting("min_turns") ?? "0", 10),
      resume_enabled: db.getSetting("resume_enabled") === "1",
      terminal_app: db.getSetting("terminal_app") || "Terminal",
      resume_dangerous_mode: db.getSetting("resume_dangerous_mode") === "1",
    };
    return new Response(JSON.stringify(settings), { headers: jsonHeaders });
  }

  // PATCH /api/settings
  if (pathname === "/api/settings" && req.method === "PATCH") {
    const body = (await req.json()) as Record<string, unknown>;
    if ("embeddings_enabled" in body) {
      db.setSetting("embeddings_enabled", body.embeddings_enabled ? "1" : "0");
    }
    if ("min_turns" in body) {
      const raw = Number(body.min_turns);
      db.setSetting("min_turns", String(Math.max(0, Number.isFinite(raw) ? raw : 0)));
    }
    if ("resume_enabled" in body) {
      db.setSetting("resume_enabled", body.resume_enabled ? "1" : "0");
    }
    if ("terminal_app" in body) {
      const app = body.terminal_app;
      db.setSetting("terminal_app", typeof app === "string" && app ? app : "Terminal");
    }
    if ("resume_dangerous_mode" in body) {
      db.setSetting("resume_dangerous_mode", body.resume_dangerous_mode ? "1" : "0");
    }
    indexHtmlCache = null;
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  }

  // GET /api/sessions?project=...&limit=...
  if (pathname === "/api/sessions" && req.method === "GET") {
    const url = new URL(req.url);
    const project = url.searchParams.get("project") ?? undefined;
    const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const limit = Math.max(0, Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 200));
    // When filtering by project, fetch more rows then filter — avoids
    // LIMIT cutting off matches that appear later in the sort order.
    let allSessions = db.listSessions(project ? {} : { limit });
    if (project) {
      const q = project.toLowerCase();
      allSessions = allSessions
        .filter((s) => (s.project ?? "").toLowerCase().includes(q))
        .slice(0, limit);
    }
    const out = allSessions.map((s) => ({
      id: s.id,
      project: s.project ?? "",
      title: s.title ?? "",
      source: s.source_machine ?? "",
      agent: s.agent ?? "",
      model: s.model ?? "",
      turn_count: s.turn_count ?? 0,
      last_modified: s.last_modified ?? s.start_time ?? 0,
      file_size: s.file_size ?? 0,
    }));
    return new Response(JSON.stringify(out), { headers: jsonHeaders });
  }

  // GET /api/tags — list all annotation tags with counts
  if (pathname === "/api/tags" && req.method === "GET") {
    const tags = db.listTags();
    return new Response(JSON.stringify(tags), { headers: jsonHeaders });
  }

  // GET /api/highlights?q=...&session=...&tag=...&days=...&limit=...
  // Filters compose: tag narrows by tag, q searches text, session scopes, days limits recency.
  if (pathname === "/api/highlights" && req.method === "GET") {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const sessionId = url.searchParams.get("session") ?? undefined;
    const tag = url.searchParams.get("tag") ?? undefined;
    const days = parseInt(url.searchParams.get("days") ?? "0", 10);
    const rawHighlightLimit = parseInt(url.searchParams.get("limit") ?? "30", 10);
    const limit = Math.max(0, Math.min(Number.isNaN(rawHighlightLimit) ? 30 : rawHighlightLimit, 200));

    // Start with the broadest applicable query, then filter in memory
    let results;
    if (q) {
      // FTS search supports session filter natively
      results = db.searchAnnotations(q, { sessionId, tags: tag ? [tag] : undefined, limit: limit * 3 });
    } else if (tag) {
      results = db.getAnnotationsByTag(tag, { limit: limit * 3 });
    } else if (sessionId) {
      results = db.getSessionAnnotations(sessionId);
    } else {
      results = db.getRecentAnnotations({ days: days > 0 ? days : 30, limit: limit * 3 });
    }

    // Apply remaining filters that weren't handled by the DB query
    if (tag && q) {
      // searchAnnotations already handled tag
    } else if (sessionId && (tag || days > 0)) {
      results = results.filter((a) => a.session_id === sessionId);
    }
    if (days > 0 && !q) {
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      results = results.filter((a) => (a.created_at ?? 0) >= cutoff);
    }

    return new Response(JSON.stringify(results.slice(0, limit)), { headers: jsonHeaders });
  }

  return new Response("Not Found", { status: 404 });
}

function broadcastAnnotationSync(sessionId: string) {
  const state = sessions.get(sessionId);
  if (!state || state.clients.size === 0) return;
  // Broadcast a lightweight sync signal; clients can refetch if needed
  broadcast(state, { type: "annotation_sync", sessionId });
}

// ---------------------------------------------------------------------------
// Legacy sidecar import
// ---------------------------------------------------------------------------

function importLegacySidecars(db: ConvoDb) {
  const viewerDir = path.join(os.homedir(), ".claude", "viewer");
  if (!fs.existsSync(viewerDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(viewerDir).filter((f) => f.endsWith(".annotations.json"));
  } catch {
    return;
  }

  for (const file of files) {
    const sessionId = file.replace(".annotations.json", "");
    const filePath = path.join(viewerDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      let annotations: any[];
      if (Array.isArray(raw)) {
        annotations = raw;
      } else {
        annotations = Object.entries(raw).map(([id, v]: [string, any]) => ({ id, ...v }));
      }
      if (annotations.length) {
        // Ensure session exists
        if (!db.getSession(sessionId)) {
          db.upsertSession({ id: sessionId });
        }
        db.importAnnotationsJson(sessionId, annotations);
      }
    } catch {
      // skip malformed files
    }
  }
}
