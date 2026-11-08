import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexBuddyBridge } from "../src/mac/bridge.mjs";
import { bridgeOptionsForOptions, parseArgs } from "../src/mac/cli.mjs";

test("Desktop CLI watches new chats by default, without changing proxy/private defaults", () => {
  assert.equal(bridgeOptionsForOptions(parseArgs([])).desktopSessionLog, "latest");
  assert.equal(bridgeOptionsForOptions(parseArgs(["--codex-proxy"])).desktopSessionLog, undefined);
  assert.equal(bridgeOptionsForOptions(parseArgs(["--private-app-server"])).desktopSessionLog, undefined);
  assert.equal(
    bridgeOptionsForOptions(parseArgs(["--desktop-session-log", "/tmp/pinned.jsonl"])).desktopSessionLog,
    "/tmp/pinned.jsonl",
  );
});

test("the first approval in each new project chat reaches the stick without a voice turn", async (t) => {
  const h = harness(t, ["--desktop-session-log", "latest"]);
  assert.equal(h.bridge.desktopSession.cwd, "");
  await h.bridge.start();
  h.devices.emit("authenticated", h.connection);

  for (const project of ["project-one", "project-two"]) {
    const id = randomUUID(), turnId = randomUUID(), callId = `first-${project}`;
    const file = writeLog(h.root, id, path.join(h.root, project), [approval(callId, turnId)]);
    // Metadata and the first permission request already exist before discovery.
    await h.bridge.desktopSession.poll();
    const snapshot = h.devices.broadcasts.at(-1);
    assert.equal(snapshot.prompt.id, callId);
    assert.equal(snapshot.waiting, 1);
    assert.equal(h.bridge.snapshot.approvalFor(callId).threadId, `desktop:${id}`);
    await h.bridge.desktopSession.poll();
    assert.equal(h.bridge.snapshot.desktopApprovalCount(), 1);

    h.devices.emit("message", { cmd: "permission", id: callId, decision: "once" }, h.connection);
    await waitFor(() => h.connection.sent.some(m => m.ack === "permission" && m.ok));
    assert.deepEqual(h.decisions.at(-1), {
      decision: "once",
      context: { threadId: id, callId, turnId, command: "ls -la", reason: "List files for the demo" },
    });
    // Keep the card until Desktop reports the tool result.
    assert.ok(h.bridge.snapshot.approvalFor(callId));
    fs.appendFileSync(file, `${JSON.stringify({ type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: callId, output: "Script completed",
    } })}\n`);
    await h.bridge.desktopSession.poll();
    assert.equal(h.bridge.snapshot.approvalFor(callId), null);
    h.connection.sent.length = 0;
  }
  assert.equal(h.decisions.length, 2);
});

test("global discovery excludes hidden and private chats and does not replay old approvals", async (t) => {
  const h = harness(t);
  writeLog(h.root, randomUUID(), "/old-project", [approval("old", randomUUID())]);
  await h.bridge.start();
  await h.bridge.desktopSession.poll();
  assert.equal(h.bridge.snapshot.desktopApprovalCount(), 0);
  for (const metadata of [
    { thread_source: "subagent" },
    { thread_source: "guardian" },
    { parent_thread_id: randomUUID() },
    { source: { subagent: { thread_spawn: {} } } },
    { source: "appServer" },
  ]) {
    writeLog(h.root, randomUUID(), "/other-project", [approval(randomUUID(), randomUUID())], metadata);
  }
  await h.bridge.desktopSession.poll();
  assert.equal(h.bridge.snapshot.desktopApprovalCount(), 0);
});

test("explicit workspace scopes and pinned logs remain restricted", async (t) => {
  const h = harness(t, [], { cwd: "/selected-project" });
  assert.equal(h.bridge.desktopSession.cwd, "/selected-project");
  await h.bridge.start();
  writeLog(h.root, randomUUID(), "/other-project", [approval("excluded", randomUUID())]);
  writeLog(h.root, randomUUID(), "/selected-project", [approval("included", randomUUID())]);
  await h.bridge.desktopSession.poll();
  assert.equal(h.bridge.snapshot.desktopApprovalCount(), 1);
  assert.equal(h.bridge.snapshot.toSnapshot().prompt.id, "included");

  const pinnedId = randomUUID();
  const pinnedPath = path.join(h.root, `rollout-2026-11-15T12-00-00-${pinnedId}.jsonl`);
  const pinned = harness(t, ["--desktop-session-log", pinnedPath]);
  await pinned.bridge.start();
  writeLog(h.root, randomUUID(), "/selected-project", [approval("not-pinned", randomUUID())]);
  await pinned.bridge.desktopSession.poll();
  assert.equal(pinned.bridge.snapshot.desktopApprovalCount(), 0);
  writeLog(h.root, pinnedId, "/selected-project", [approval("pinned", randomUUID())]);
  await pinned.bridge.desktopSession.poll();
  assert.equal(pinned.bridge.snapshot.toSnapshot().prompt.id, "pinned");
});

function harness(t, args = [], overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaodex-new-chat-"));
  const codex = new EventEmitter();
  Object.assign(codex, { start() {}, stop() {}, async initialize() { return {}; },
    async request(method) { assert.equal(method, "thread/list"); return { data: [] }; } });
  const devices = new EventEmitter();
  Object.assign(devices, { host: "127.0.0.1", port: 0, connectedCount: 1, broadcasts: [],
    async start() {}, stop() {}, broadcast(message) { this.broadcasts.push(message); } });
  const connection = { name: "test-stick", sent: [], send(message) { this.sent.push(message); } };
  const decisions = [];
  const bridge = new CodexBuddyBridge({
    ...bridgeOptionsForOptions({ ...parseArgs(args), ...overrides }),
    codex, devices, voice: { stop() {} }, log() {}, pollMs: 60_000, heartbeatMs: 60_000,
    desktopApprovals: { async respond(decision, context) { decisions.push({ decision, context }); } },
  });
  t.after(() => { bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(bridge.desktopSession, "Desktop monitoring must be enabled");
  // Exercise the production follower wiring against isolated fixture logs.
  bridge.desktopSession.root = root;
  bridge.desktopSession.pollMs = 60_000;
  return { root, bridge, devices, connection, decisions };
}

function writeLog(root, id, cwd, events, metadata = {}) {
  const file = path.join(root, `rollout-2026-11-15T12-00-00-${id}.jsonl`);
  const meta = { type: "session_meta", payload: {
    id, cwd, source: "vscode", thread_source: "user", ...metadata,
  } };
  fs.writeFileSync(file, [meta, ...events].map(e => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

function approval(callId, turnId) {
  return { type: "response_item", payload: {
    type: "custom_tool_call", name: "exec", call_id: callId,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
    input: 'text(await tools.exec_command({cmd:"ls -la",sandbox_permissions:"require_escalated",justification:"List files for the demo"}));',
  } };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for device acknowledgement");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
