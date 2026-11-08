import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DesktopSessionLogFollower extends EventEmitter {
  constructor(options = {}) {
    super();
    this.path = options.path || "latest";
    this.cwd = options.cwd ? path.resolve(options.cwd) : "";
    this.root = options.root;
    this.pollMs = Number(options.pollMs || 500);
    this.timer = null;
    this.currentPath = "";
    this.offset = 0;
    this.buffer = "";
    this.cursors = new Map();
    this.metadataCache = new Map();
    this.pollPromise = null;
  }

  async start() {
    if (this.timer) return;
    const candidates = this.path === "latest" ? await this.#candidateLogs() : null;
    await this.#primeLogCursors(candidates);
    await this.#selectLog(candidates);
    this.timer = setInterval(() => {
      this.poll()
        .catch((error) => this.emit("error", error));
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.#pollOnce()
      .finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  async #pollOnce() {
    if (this.path !== "latest") {
      await this.#selectLog();
      if (this.currentPath) {
        try {
          await this.#readPath(this.currentPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          this.#forgetLog(this.currentPath);
        }
      }
      return;
    }

    // Several Desktop chats can write at once, including across projects.
    // Reading only the newest log can lose a short-lived approval if another log
    // becomes newer before the next poll. Keep an independent cursor for every
    // visible root thread and drain all changed logs, oldest update first.
    const candidates = await this.#candidateLogs();
    await this.#selectLog(candidates);
    const oldestFirst = [...candidates].sort(
      compareOldestSessionLog,
    );
    const disappeared = new Set();
    for (const candidate of oldestFirst) {
      try {
        await this.#readPath(candidate.path, candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        disappeared.add(candidate.path);
        this.#forgetLog(candidate.path);
      }
    }
    if (disappeared.size > 0) {
      await this.#selectLog(candidates.filter(({ path: filePath }) => !disappeared.has(filePath)));
    }
  }

  async #candidateLogs() {
    return sessionLogCandidates(this.root, this.cwd, this.metadataCache);
  }

  async #primeLogCursors(candidates = null) {
    if (this.path === "latest") {
      for (const candidate of candidates || await this.#candidateLogs()) {
        this.cursors.set(candidate.path, {
          offset: candidate.size,
          remainder: Buffer.alloc(0),
        });
      }
      return;
    }

    const filePath = path.resolve(this.path);
    try {
      const stat = await fsp.stat(filePath);
      this.cursors.set(filePath, { offset: stat.size, remainder: Buffer.alloc(0) });
    } catch {
      // A new log can appear after startup; #readPath begins it at zero.
    }
  }

  async #readPath(filePath, knownStat = null) {
    let cursor = this.cursors.get(filePath);
    if (!cursor) {
      cursor = { offset: 0, remainder: Buffer.alloc(0) };
      this.cursors.set(filePath, cursor);
    }

    let stat = knownStat;
    if (!stat) stat = await fsp.stat(filePath);
    const truncated = stat.size < cursor.offset;
    const start = truncated ? 0 : cursor.offset;
    const previousRemainder = truncated ? Buffer.alloc(0) : cursor.remainder;
    if (stat.size === start) {
      if (truncated) {
        cursor.offset = 0;
        cursor.remainder = Buffer.alloc(0);
      }
      this.#syncCurrentCursor(filePath, cursor);
      return;
    }

    const range = await readFileRange(filePath, start, stat.size);
    const input = Buffer.concat([
      range.truncated ? Buffer.alloc(0) : previousRemainder,
      range.bytes,
    ]);
    const parsed = parseSessionLogBytes(input, filePath);
    // Commit the cursor only after the complete byte range has been read. A
    // transient read failure can then retry without silently losing events.
    cursor.offset = range.end;
    cursor.remainder = parsed.remainder;
    this.#syncCurrentCursor(filePath, cursor);
    for (const record of parsed.records) {
      this.emit(record.type, record.value);
    }
  }

  #forgetLog(filePath) {
    this.cursors.delete(filePath);
    this.metadataCache.delete(filePath);
    if (this.currentPath !== filePath) return;
    this.currentPath = "";
    this.offset = 0;
    this.buffer = "";
  }

  #syncCurrentCursor(filePath, cursor) {
    if (filePath !== this.currentPath) return;
    this.offset = cursor.offset;
    this.buffer = cursor.remainder.toString("utf8");
  }

  async #selectLog(candidates = null) {
    const nextPath = this.path === "latest"
      ? (candidates || await sessionLogCandidates(this.root, this.cwd))[0]?.path || ""
      : path.resolve(this.path);
    if (!nextPath) {
      this.currentPath = "";
      this.offset = 0;
      this.buffer = "";
      return;
    }
    if (nextPath === this.currentPath) return;

    this.currentPath = nextPath;
    const cursor = this.cursors.get(nextPath) || {
      offset: 0,
      remainder: Buffer.alloc(0),
    };
    this.cursors.set(nextPath, cursor);
    this.offset = cursor.offset;
    this.buffer = cursor.remainder.toString("utf8");
    this.emit("log", nextPath);
  }
}

export async function latestSessionLog(
  root = path.join(defaultCodexHome(), "sessions"),
  cwd = "",
) {
  const candidates = await sessionLogCandidates(root, cwd);
  return candidates[0]?.path || "";
}

async function sessionLogCandidates(
  root = path.join(defaultCodexHome(), "sessions"),
  cwd = "",
  metadataCache = null,
) {
  const candidates = [];

  async function visit(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fsp.stat(full);
          candidates.push({
            path: full,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            dev: stat.dev,
            ino: stat.ino,
          });
        } catch {
          // Session disappeared while scanning.
        }
      }
    }
  }

  await visit(root);
  candidates.sort(compareNewestSessionLog);
  const expectedCwd = cwd ? path.resolve(cwd) : "";
  const visible = [];
  for (const candidate of candidates) {
    const cached = metadataCache?.get(candidate.path);
    let metadata = cached && cached.dev === candidate.dev && cached.ino === candidate.ino
      ? cached.metadata
      : null;
    if (!metadata) {
      metadata = await sessionLogMetadata(candidate.path);
      if (metadata) {
        metadataCache?.set(candidate.path, {
          dev: candidate.dev,
          ino: candidate.ino,
          metadata,
        });
      }
    }
    if (!metadata) continue;
    if (!isInteractiveRootSession(metadata)) continue;
    if (!expectedCwd || metadata.cwd === expectedCwd) visible.push(candidate);
  }
  if (metadataCache) {
    const livePaths = new Set(candidates.map((candidate) => candidate.path));
    for (const filePath of metadataCache.keys()) {
      if (!livePaths.has(filePath)) metadataCache.delete(filePath);
    }
  }
  return visible;
}

export async function desktopSessionId(
  logPath = "latest",
  root = path.join(defaultCodexHome(), "sessions"),
  cwd = "",
  options = {},
) {
  if (logPath !== "latest") return sessionIdFromPath(path.resolve(logPath));

  const codexHome = path.resolve(options.codexHome || defaultCodexHome());
  const sessionsRoot = path.resolve(root);
  const defaultSessionsRoot = path.join(codexHome, "sessions");
  if (options.stateDbPath || sessionsRoot === defaultSessionsRoot) {
    const stateSelection = await desktopStateTaskSelection({
      codexHome,
      stateDbPath: options.stateDbPath,
      cwd,
    });
    if (stateSelection.available) return stateSelection.id;
  }

  const filePath = await latestSessionLog(sessionsRoot, cwd);
  return sessionIdFromPath(filePath);
}

// Desktop's sidebar uses task recency rather than rollout-file modification
// time. A log can keep changing because an assistant is streaming, tools are
// running, or Xiaodex is finishing an older voice turn; none of those writes
// should steal the next recording from the task the user activated most
// recently. Read the same local state database in read-only mode, with JSONL
// ordering retained as a compatibility fallback for older Codex builds.
export async function latestDesktopStateTaskId(options = {}) {
  const selection = await desktopStateTaskSelection(options);
  return selection.id;
}

async function desktopStateTaskSelection(options = {}) {
  const codexHome = path.resolve(options.codexHome || defaultCodexHome());
  const stateDbPath = options.stateDbPath
    ? path.resolve(options.stateDbPath)
    : await latestDesktopStateDatabase(codexHome);
  if (!stateDbPath) return { available: false, id: "" };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    throw new Error(
      "Codex Desktop task recency requires Node.js 22.13 or newer",
      { cause: error },
    );
  }

  let database;
  try {
    database = new DatabaseSync(stateDbPath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 250");
    const expectedCwd = options.cwd ? path.resolve(options.cwd) : "";
    const cwdFilter = expectedCwd ? "AND t.cwd = ?" : "";
    const query = database.prepare(`
      SELECT t.id
      FROM threads AS t
      WHERE t.archived = 0
        AND t.preview <> ''
        AND t.source IN ('cli', 'vscode')
        AND (t.thread_source IS NULL OR t.thread_source = 'user')
        AND NOT EXISTS (
          SELECT 1
          FROM thread_spawn_edges AS edge
          WHERE edge.child_thread_id = t.id
        )
        ${cwdFilter}
      ORDER BY
        CASE
          WHEN t.recency_at_ms > 0 THEN t.recency_at_ms
          WHEN t.updated_at_ms IS NOT NULL THEN t.updated_at_ms
          ELSE t.updated_at * 1000
        END DESC,
        COALESCE(t.created_at_ms, t.created_at * 1000) DESC,
        t.id ASC
      LIMIT 1
    `);
    const row = expectedCwd ? query.get(expectedCwd) : query.get();
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    return {
      available: true,
      id: UUID_PATTERN.test(id) ? id : "",
    };
  } catch (error) {
    throw new Error(
      "Could not read Codex Desktop task recency; voice targeting failed closed",
      { cause: error },
    );
  } finally {
    try {
      database?.close();
    } catch {
      // The primary read error above remains authoritative.
    }
  }
}

export function sessionIdFromPath(filePath) {
  const match = path.basename(filePath || "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || "";
}

async function sessionLogMetadata(filePath) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const event = JSON.parse(line);
      const payload = event?.payload || {};
      const cwd = typeof payload.cwd === "string" && payload.cwd
        ? path.resolve(payload.cwd)
        : "";
      return {
        cwd,
        parentThreadId: payload.parent_thread_id || "",
        source: payload.source,
        threadSource: payload.thread_source || "",
      };
    }
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

async function readFileRange(filePath, start, expectedEnd) {
  const handle = await fsp.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const truncated = stat.size < start;
    const readStart = truncated ? 0 : start;
    const end = truncated ? stat.size : Math.min(expectedEnd, stat.size);
    if (end <= readStart) {
      return { bytes: Buffer.alloc(0), end: readStart, truncated };
    }

    const chunks = [];
    let position = readStart;
    while (position < end) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        const error = new Error(`short read from Desktop session log ${filePath}`);
        error.code = "EIO";
        throw error;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { bytes: Buffer.concat(chunks), end: position, truncated };
  } finally {
    await handle.close();
  }
}

function parseSessionLogBytes(input, filePath) {
  const records = [];
  let start = 0;
  while (true) {
    const newline = input.indexOf(0x0a, start);
    if (newline < 0) break;
    const line = input.subarray(start, newline).toString("utf8").trim();
    start = newline + 1;
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      event.__sessionId = sessionIdFromPath(filePath) || "desktop-session";
      event.__sessionDay = sessionDayFromPath(filePath);
      records.push({ type: "event", value: event });
    } catch {
      records.push({ type: "parseError", value: line });
    }
  }
  return { records, remainder: input.subarray(start) };
}

function compareNewestSessionLog(a, b) {
  return b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path);
}

function compareOldestSessionLog(a, b) {
  return -compareNewestSessionLog(a, b);
}

function isInteractiveRootSession(metadata) {
  if (
    metadata.parentThreadId
    || (metadata.threadSource && metadata.threadSource !== "user")
    || metadata.source?.subagent
  ) {
    return false;
  }
  return metadata.source === "cli" || metadata.source === "vscode";
}

function sessionDayFromPath(filePath) {
  const match = path.basename(filePath || "").match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return "";
  return `${Number(match[1])}-${Number(match[2])}-${Number(match[3])}`;
}

function defaultCodexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

async function latestDesktopStateDatabase(codexHome) {
  let entries;
  try {
    entries = await fsp.readdir(codexHome, { withFileTypes: true });
  } catch {
    return "";
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^state(?:_(\d+))?\.sqlite$/);
    if (!match) continue;
    const filePath = path.join(codexHome, entry.name);
    let activityMs = 0;
    for (const candidatePath of [filePath, `${filePath}-wal`]) {
      try {
        activityMs = Math.max(activityMs, (await fsp.stat(candidatePath)).mtimeMs);
      } catch {
        // A WAL file is optional and can disappear after a checkpoint.
      }
    }
    candidates.push({
      path: filePath,
      version: Number(match[1] || 0),
      activityMs,
    });
  }
  // Codex upgrades can leave an older or newer state_N database behind. The
  // database whose main/WAL files were touched most recently is the active
  // Desktop state; filename version alone can silently choose stale recency.
  candidates.sort((a, b) =>
    b.activityMs - a.activityMs ||
    b.version - a.version ||
    b.path.localeCompare(a.path));
  return candidates[0]?.path || "";
}
