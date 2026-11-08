import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBuddyBridge } from "./bridge.mjs";
import { desktopSessionId } from "./session-log.mjs";

export async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const voiceTarget = await resolveVoiceThreadTarget(options);
  options.voiceThreadId = voiceTarget.threadId;
  options.voiceThreadIdResolver = voiceTarget.resolveThreadId;
  if (voiceTarget.followsLatest) {
    console.log("codex-buddy: voice target follows the latest Desktop task per recording");
  } else if (options.voiceThreadId) {
    console.log(`codex-buddy: voice target task ${options.voiceThreadId}`);
  }

  const bridge = createBridge(options, codexArgsForOptions(options));

  process.on("SIGINT", () => {
    bridge.stop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    bridge.stop();
    process.exit(143);
  });

  try {
    await bridge.start();
  } catch (error) {
    bridge.stop();
    throw error;
  }
}

function createBridge(options, codexArgs) {
  return new CodexBuddyBridge(bridgeOptionsForOptions(options, codexArgs));
}

export function bridgeOptionsForOptions(options, codexArgs) {
  return {
    host: options.host,
    port: options.port,
    token: options.token ?? process.env.CODEX_BUDDY_TOKEN ?? "",
    cwd: options.cwd,
    codexBin: options.codexBin,
    codexMode: options.codexMode,
    codexArgs,
    codexRequestTimeoutMs: options.codexRequestTimeoutMs,
    desktopIpcSocket: options.desktopIpcSocket,
    owner: options.owner,
    pollMs: options.pollMs,
    desktopSessionLog: options.desktopSessionLog ??
      ((options.codexMode || "desktop") === "desktop" ? "latest" : undefined),
    voiceTranscriptTimeoutMs: options.voiceTranscriptTimeoutMs,
    voiceThreadId: options.voiceThreadId,
    voiceThreadIdResolver: options.voiceThreadIdResolver,
    voiceModel: options.voiceModel,
  };
}

export function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 8787,
    pollMs: 5000,
    codexMode: "desktop",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--token") options.token = argv[++i];
    else if (arg === "--codex-bin") options.codexBin = argv[++i];
    else if (arg === "--codex-request-timeout-ms") options.codexRequestTimeoutMs = Number(argv[++i]);
    else if (arg === "--private-app-server") {
      if (options.codexMode === "proxy") {
        throw new Error("--private-app-server cannot be combined with --codex-proxy or --codex-sock");
      }
      options.codexMode = "private";
    }
    else if (arg === "--codex-proxy") {
      if (options.codexMode === "private") {
        throw new Error("--codex-proxy cannot be combined with --private-app-server");
      }
      options.codexMode = "proxy";
      options.codexProxy = true;
    }
    else if (arg === "--no-codex-proxy-fallback") options.noCodexProxyFallback = true;
    else if (arg === "--codex-sock") {
      if (options.codexMode === "private") {
        throw new Error("--codex-sock cannot be combined with --private-app-server");
      }
      options.codexMode = "proxy";
      options.codexProxy = true;
      options.codexSock = requiredValue(argv, ++i, arg);
    }
    else if (arg === "--desktop-ipc-sock") {
      options.desktopIpcSocket = requiredValue(argv, ++i, arg);
    }
    else if (arg === "--owner") options.owner = argv[++i];
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++i]);
    else if (arg === "--desktop-session-log") options.desktopSessionLog = argv[++i];
    else if (arg === "--voice-transcript-timeout-ms") options.voiceTranscriptTimeoutMs = Number(argv[++i]);
    else if (arg === "--voice-thread-id") options.voiceThreadId = requiredValue(argv, ++i, arg);
    else if (arg === "--voice-model") options.voiceModel = requiredValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (options.desktopIpcSocket && options.codexMode !== "desktop") {
    throw new Error("--desktop-ipc-sock can only be used with the default Codex Desktop mode");
  }
  return options;
}

export function shouldFallbackFromProxy(options, error) {
  // A private app-server has a different live event stream from Codex Desktop.
  // Never switch ownership silently: callers must opt in with
  // --private-app-server when they intentionally want a headless server.
  void options;
  void error;
  return false;
}

export async function resolveVoiceThreadId(options, resolveDesktopSessionId = desktopSessionId) {
  const target = await resolveVoiceThreadTarget(options, resolveDesktopSessionId);
  if (target.threadId) return target.threadId;
  return target.resolveThreadId?.();
}

export async function resolveVoiceThreadTarget(
  options,
  resolveDesktopSessionId = desktopSessionId,
) {
  const configured = options?.voiceThreadId;
  const followsDesktopByDefault = !configured &&
    (options?.codexMode === undefined || options.codexMode === "desktop");
  const useDesktopSession = !configured &&
    options?.codexMode !== "private" &&
    options?.desktopSessionLog;
  if (!configured && !useDesktopSession && !followsDesktopByDefault) return {};
  if (configured && configured !== "latest") return { threadId: configured };

  const logPath = options.desktopSessionLog || "latest";
  // The Mac sidebar is global across projects. An explicitly supplied cwd can
  // still scope an embedded bridge, but the CLI default must not exclude the
  // task the user just activated merely because Xiaodex runs from this repo.
  const cwd = options.cwd || "";
  const resolveThreadId = async () => {
    const threadId = await resolveDesktopSessionId(
      logPath,
      undefined,
      cwd,
    );
    if (!threadId) {
      throw new Error(`could not resolve a Desktop session UUID from ${logPath}`);
    }
    return threadId;
  };

  if (logPath === "latest") {
    return { resolveThreadId, followsLatest: true };
  }
  return { threadId: await resolveThreadId(), followsLatest: false };
}

export function codexArgsForOptions(options) {
  const proxyMode = options.codexMode === "proxy" ||
    (options.codexMode === undefined && (options.codexProxy || options.codexSock));
  if (!proxyMode) {
    return undefined;
  }
  const args = ["app-server", "proxy"];
  const sock = options.codexSock === "auto" || (options.codexProxy && !options.codexSock)
    ? findCodexIpcSocket()
    : options.codexSock;
  if (sock) args.push("--sock", sock);
  return args;
}

export function findCodexIpcSocket(tmpRoot = os.tmpdir()) {
  const dir = path.join(tmpRoot, "codex-ipc");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }

  const sockets = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".sock")) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.isSocket()) sockets.push({ path: full, mtimeMs: stat.mtimeMs });
    } catch {
      // Socket disappeared between readdir and stat.
    }
  }
  sockets.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sockets[0]?.path || "";
}

function printHelp() {
  console.log(`codex-buddy

Usage:
  codex-buddy [--host 127.0.0.1] [--port 8787] [--token TOKEN]

Options:
  --host HOST       TCP bind host for devices. Default: 127.0.0.1
                    Use 0.0.0.0 plus a 16-96 character token for Wi-Fi.
  --port PORT       TCP port for ESP32 devices. Default: 8787
  --token TOKEN     Optional shared token. Also read from CODEX_BUDDY_TOKEN.
  --desktop-ipc-sock PATH
                    Codex Desktop coordination socket. Default: $CODEX_HOME/ipc/ipc.sock
  --private-app-server
                    Explicitly run a separate headless app-server. Voice turns will not share
                    Codex Desktop's live task stream.
  --codex-bin PATH  Codex binary for --private-app-server or --codex-proxy.
  --codex-request-timeout-ms MS
                    JSON-RPC request timeout. Default: 15000
  --codex-proxy     Connect through an explicitly exposed app-server control socket instead of
                    Codex Desktop's owner/follower coordination socket.
  --no-codex-proxy-fallback
                    Deprecated compatibility flag. Proxy failures always fail closed.
  --codex-sock PATH App-server Unix socket for --codex-proxy. Use "auto" to discover it.
  --owner NAME      Name sent to the device.
  --poll-ms MS      Thread list polling interval. Default: 5000
  --desktop-session-log PATH
                    Follow Codex Desktop JSONL logs for passive activity and approvals.
                    Default in Desktop mode: "latest", across projects.
                    New chats are discovered without starting a voice turn.
                    Supply a log path to restrict passive monitoring to that chat.
  --voice-transcript-timeout-ms MS
                    Max wait for the final Realtime transcript. Default: 10000
  --voice-thread-id ID
                    Host-owned target task UUID. Existing tasks are resumed before submission.
                    "latest" follows the most recently active eligible Desktop task
                    at the start of every recording.
  --voice-model MODEL
                    OpenAI Realtime transcription model override.
                    Default: gpt-live-transcribe
`);
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
