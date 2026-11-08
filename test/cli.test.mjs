import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  bridgeOptionsForOptions,
  codexArgsForOptions,
  findCodexIpcSocket,
  parseArgs,
  resolveVoiceThreadId,
  resolveVoiceThreadTarget,
  shouldFallbackFromProxy,
} from "../src/mac/cli.mjs";

test("builds app-server proxy args from CLI flags", () => {
  const proxy = parseArgs(["--codex-proxy"]);
  assert.equal(proxy.host, "127.0.0.1");
  assert.equal(proxy.codexMode, "proxy");
  assert.deepEqual(codexArgsForOptions(proxy).slice(0, 2), ["app-server", "proxy"]);

  const socket = parseArgs(["--codex-sock", "/tmp/codex.sock"]);
  assert.deepEqual(codexArgsForOptions(socket), ["app-server", "proxy", "--sock", "/tmp/codex.sock"]);
});

test("parses desktop session log follow mode", () => {
  const options = parseArgs(["--desktop-session-log", "latest"]);
  assert.equal(options.desktopSessionLog, "latest");
  assert.equal(options.codexMode, "desktop");
});

test("uses Codex Desktop by default and makes a private app-server explicit", () => {
  const desktop = parseArgs([]);
  assert.equal(desktop.codexMode, "desktop");
  assert.equal(codexArgsForOptions(desktop), undefined);

  const privateServer = parseArgs(["--private-app-server"]);
  assert.equal(privateServer.codexMode, "private");
  assert.equal(codexArgsForOptions(privateServer), undefined);

  const socket = parseArgs(["--desktop-ipc-sock", "/tmp/desktop-ipc.sock"]);
  const bridge = bridgeOptionsForOptions(socket);
  assert.equal(bridge.codexMode, "desktop");
  assert.equal(bridge.desktopIpcSocket, "/tmp/desktop-ipc.sock");

  for (const args of [
    ["--private-app-server", "--codex-proxy"],
    ["--codex-proxy", "--private-app-server"],
    ["--private-app-server", "--codex-sock", "/tmp/codex.sock"],
    ["--private-app-server", "--desktop-ipc-sock", "/tmp/desktop.sock"],
    ["--codex-proxy", "--desktop-ipc-sock", "/tmp/desktop.sock"],
  ]) {
    assert.throws(() => parseArgs(args), /cannot be combined|can only be used/);
  }
  assert.throws(() => parseArgs(["--codex-sock"]), /requires a value/);
});

test("parses device-audio transcription options", () => {
  const options = parseArgs([
    "--voice-transcript-timeout-ms", "15000",
    "--voice-model", "gpt-realtime-whisper",
    "--codex-request-timeout-ms", "7000",
  ]);
  assert.equal(options.voiceTranscriptTimeoutMs, 15000);
  assert.equal(options.voiceModel, "gpt-realtime-whisper");
  assert.equal(options.codexRequestTimeoutMs, 7000);
});

test("rejects removed Mac microphone and provider switches", () => {
  for (const args of [
    ["--voice-device", "1"],
    ["--voice-seconds", "4"],
    ["--voice-ffmpeg-bin", "ffmpeg"],
    ["--voice-provider", "codex-realtime"],
  ]) {
    assert.throws(() => parseArgs(args), /unknown argument/);
  }
});

test("parses and wires host-owned voice targeting options", () => {
  const options = parseArgs([
    "--codex-proxy",
    "--voice-thread-id", "12345678-1234-1234-1234-123456789abc",
    "--voice-model", "gpt-realtime-whisper",
  ]);
  const bridgeOptions = bridgeOptionsForOptions(options, ["app-server", "proxy"]);

  assert.equal(options.voiceThreadId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(bridgeOptions.voiceThreadId, options.voiceThreadId);
  assert.equal(bridgeOptions.voiceModel, "gpt-realtime-whisper");
});

test("allows an explicitly selected private app-server to resume a voice target", () => {
  const options = parseArgs([
    "--private-app-server",
    "--voice-thread-id", "12345678-1234-1234-1234-123456789abc",
  ]);
  assert.equal(options.codexMode, "private");
  assert.equal(options.voiceThreadId, "12345678-1234-1234-1234-123456789abc");
});

test("builds a live resolver that follows the latest Desktop task", async () => {
  const calls = [];
  const ids = [
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "ffffffff-1111-2222-3333-444444444444",
  ];
  const target = await resolveVoiceThreadTarget(
    parseArgs(["--voice-thread-id", "latest"]),
    async (logPath, _root, cwd) => {
      calls.push({ logPath, cwd });
      return ids[calls.length - 1];
    },
  );

  assert.equal(target.threadId, undefined);
  assert.equal(target.followsLatest, true);
  assert.strictEqual(
    bridgeOptionsForOptions({ voiceThreadIdResolver: target.resolveThreadId })
      .voiceThreadIdResolver,
    target.resolveThreadId,
  );
  assert.equal(await target.resolveThreadId(), ids[0]);
  assert.equal(await target.resolveThreadId(), ids[1]);
  assert.deepEqual(calls, [
    { logPath: "latest", cwd: "" },
    { logPath: "latest", cwd: "" },
  ]);
});

test("targets the latest Desktop task by default", async () => {
  const calls = [];
  const target = await resolveVoiceThreadTarget(parseArgs([]), async (logPath, _root, cwd) => {
    calls.push({ logPath, cwd });
    return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  });

  assert.equal(target.followsLatest, true);
  assert.equal(await target.resolveThreadId(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.deepEqual(calls, [{ logPath: "latest", cwd: "" }]);
});

test("only scopes latest voice targeting when an embedding supplies cwd", async () => {
  const target = await resolveVoiceThreadTarget(
    { codexMode: "desktop", cwd: "/tmp/explicit-workspace" },
    async (_logPath, _root, cwd) => {
      assert.equal(cwd, "/tmp/explicit-workspace");
      return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    },
  );

  assert.equal(await target.resolveThreadId(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("uses a configured Desktop session log as the proxy voice target", async () => {
  const options = parseArgs(["--codex-proxy", "--desktop-session-log", "/tmp/rollout.jsonl"]);
  const threadId = await resolveVoiceThreadId(options, async (logPath) => {
    assert.equal(logPath, "/tmp/rollout.jsonl");
    return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  });

  assert.equal(threadId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("discovers Codex Desktop IPC socket", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-cli-"));
  const dir = path.join(root, "codex-ipc");
  fs.mkdirSync(dir);
  const sock = path.join(dir, "ipc-1.sock");
  const server = net.createServer();
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(sock, resolve));

  assert.equal(findCodexIpcSocket(root), sock);
});

test("never silently falls back from the Desktop or proxy owner", () => {
  assert.equal(
    shouldFallbackFromProxy({ codexProxy: true }, new Error("initialize timed out after 15000ms")),
    false,
  );
  assert.equal(
    shouldFallbackFromProxy({ codexProxy: true, noCodexProxyFallback: true }, new Error("initialize timed out after 15000ms")),
    false,
  );
  assert.equal(
    shouldFallbackFromProxy({}, new Error("initialize timed out after 15000ms")),
    false,
  );
  assert.equal(
    shouldFallbackFromProxy({ codexProxy: true }, new Error("unknown argument")),
    false,
  );
});
