import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DesktopCodexClient,
  applyStrictPatches,
} from "../src/mac/desktop-codex-client.mjs";

const THREAD_ID = "019fcc30-7810-71a2-a555-a0a05e1784a5";
const TURN_ID = "019ff91d-5372-7431-b71d-0f60c890d05d";
const OWNER_ID = "desktop-owner";
const CLIENT_ID = "xiaodex-client";
const THREAD_ID_2 = "029fcc30-7810-71a2-a555-a0a05e1784a5";

for (const streamVersion of [11, 13]) {
test(`submits through the Desktop v${streamVersion} owner and translates its live stream`, async (t) => {
  const fake = await startFakeDesktop(t, { includeHistoricalState: true, streamVersion });
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 1_000,
  });
  t.after(() => client.stop());

  const notifications = [];
  const approvals = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("serverRequest", (request) => approvals.push(request));

  client.start();
  const initialized = await client.initialize();
  assert.equal(initialized.userAgent, "Codex Desktop (shared app-server)");
  const resumed = await client.request("thread/resume", { threadId: THREAD_ID });
  assert.equal(resumed.thread.id, THREAD_ID);
  assert.deepEqual(notifications, []);
  assert.deepEqual(approvals, []);

  const accepted = await client.request("turn/start", {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "hello", text_elements: [] }],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  });
  assert.equal(accepted.turn.id, TURN_ID);

  await fake.streamPromise;
  const deltas = notifications.filter(
    (message) => message.method === "item/agentMessage/delta",
  );
  assert.deepEqual(
    deltas.map((message) => ({
      delta: message.params.delta,
      reset: message.params.reset || false,
    })),
    [
      { delta: "Hel", reset: false },
      { delta: "lo", reset: false },
      { delta: "Final", reset: true },
      { delta: "", reset: true },
      { delta: "New", reset: false },
    ],
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].id, 61);
  assert.equal(approvals[0].method, "item/commandExecution/requestApproval");

  await client.respond(61, { decision: "accept" });
  await fake.completedPromise;
  await waitFor(() => notifications.some((message) => message.method === "turn/completed"));

  const completedItem = notifications.find((message) => message.method === "item/completed");
  assert.equal(completedItem.params.item.text, "New");
  const completedTurn = notifications.find((message) => message.method === "turn/completed");
  assert.equal(completedTurn.params.turn.id, TURN_ID);
  assert.equal(completedTurn.params.turn.status, "completed");

  const start = fake.received.find((message) => message.method === "thread-follower-start-turn");
  assert.equal(start.version, 2);
  assert.equal(start.targetClientId, OWNER_ID);
  assert.equal(start.params.conversationId, THREAD_ID);
  assert.equal(start.params.turnStart.request.threadId, THREAD_ID);
  assert.equal(start.params.turnStart.request.approvalPolicy, "on-request");
  assert.equal(start.params.turnStart.request.approvalsReviewer, "user");
  assert.equal("turnStartParams" in start.params, false);
  assert.match(start.params.turnStart.request.clientUserMessageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(start.params.turnStart.request.input, [
    { type: "text", text: "hello", text_elements: [] },
  ]);

  const decision = fake.received.find(
    (message) => message.method === "thread-follower-command-approval-decision",
  );
  assert.deepEqual(decision.params, {
    conversationId: THREAD_ID,
    requestId: 61,
    decision: "accept",
  });
});

}

for (const streamVersion of [10, 12, 14]) {
test(`fails closed on unverified Desktop stream version ${streamVersion}`, async (t) => {
  const fake = await startFakeDesktop(t, { streamVersion });
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 500,
  });
  t.after(() => client.stop());
  client.on("protocolError", () => {});

  await client.initialize();
  await assert.rejects(
    client.request("thread/resume", { threadId: THREAD_ID }),
    /version mismatch/,
  );
});

}

test("fails closed if the stream version changes within a followed task", async (t) => {
  const fake = await startFakeDesktop(t, { streamVersion: 13, patchStreamVersion: 11 });
  const client = new DesktopCodexClient({ socketPath: fake.socketPath, requestTimeoutMs: 500 });
  t.after(() => client.stop());
  const failed = new Promise(resolve => client.once("protocolError", resolve));
  await client.initialize();
  await client.request("thread/resume", { threadId: THREAD_ID });
  await client.request("turn/start", { threadId: THREAD_ID, input: [{ type: "text", text: "test" }] }).catch(() => {});
  assert.match((await failed).message, /version changed/);
});

test("fails closed on a patch revision gap", async (t) => {
  const fake = await startFakeDesktop(t, { revisionGap: true });
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 500,
  });
  t.after(() => client.stop());
  const failed = new Promise((resolve) => client.once("protocolError", resolve));

  await client.initialize();
  await client.request("thread/resume", { threadId: THREAD_ID });
  await client.request("turn/start", {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "hello", text_elements: [] }],
  }).catch(() => {});
  const error = await failed;
  assert.match(error.message, /revision gap/);
});

test("ignores a delayed patch from the task that was just unfollowed", async (t) => {
  const fake = await startSwitchingDesktop(t);
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 500,
  });
  t.after(() => client.stop());
  const errors = [];
  const notifications = [];
  client.on("protocolError", (error) => errors.push(error));
  client.on("notification", (message) => notifications.push(message));

  await client.initialize();
  await client.request("thread/resume", { threadId: THREAD_ID });
  const resumed = await client.request("thread/resume", { threadId: THREAD_ID_2 });

  assert.equal(resumed.thread.id, THREAD_ID_2);
  assert.deepEqual(errors, []);
  assert.ok(notifications.some((message) =>
    message.method === "thread/closed" && message.params.threadId === THREAD_ID));
});

test("fails closed when a dispatched turn response is indeterminate", async (t) => {
  const fake = await startFakeDesktop(t, { withholdStartResponse: true });
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 30,
  });
  t.after(() => client.stop());
  client.on("protocolError", () => {});

  await client.initialize();
  await client.request("thread/resume", { threadId: THREAD_ID });
  await assert.rejects(
    client.request("turn/start", {
      threadId: THREAD_ID,
      input: [{ type: "text", text: "hello", text_elements: [] }],
    }),
    /ownership is indeterminate/,
  );
  await assert.rejects(
    client.request("thread/resume", { threadId: THREAD_ID }),
    /ownership is indeterminate/,
  );
});

test("routes file and whitelisted permission decisions to the Desktop owner", async (t) => {
  await t.test("file", async (t) => {
    const { fake, client } = await approvalClient(t, {
      approvalMethod: "item/fileChange/requestApproval",
      approvalParams: { reason: "Allow the edit?", grantRoot: "/tmp/project" },
    });
    await client.respond(61, { decision: "accept" });
    const decision = fake.received.find((message) =>
      message.method === "thread-follower-file-approval-decision");
    assert.deepEqual(decision.params, {
      conversationId: THREAD_ID,
      requestId: 61,
      decision: "accept",
    });
  });

  for (const decisionValue of ["accept", "decline"]) {
    await t.test(`permissions ${decisionValue}`, async (t) => {
      const { fake, client } = await approvalClient(t, {
        approvalMethod: "item/permissions/requestApproval",
        approvalParams: {
          reason: "Allow one turn?",
          permissions: {
            network: { enabled: true },
            fileSystem: { roots: ["/tmp/project"] },
            injectedMetadata: { mustNotBeGranted: true },
          },
        },
      });
      await client.respond(61, { decision: decisionValue });
      const message = fake.received.find((candidate) =>
        candidate.method === "thread-follower-permissions-request-approval-response");
      assert.deepEqual(message.params, {
        conversationId: THREAD_ID,
        requestId: 61,
        response: decisionValue === "accept"
          ? {
            permissions: {
              network: { enabled: true },
              fileSystem: { roots: ["/tmp/project"] },
            },
            scope: "turn",
          }
          : { permissions: {}, scope: "turn" },
      });
    });
  }
});

test("does not surface an approval without the active turn id", async (t) => {
  const fake = await startFakeDesktop(t, { omitApprovalTurnId: true });
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 500,
  });
  t.after(() => client.stop());
  const approvals = [];
  client.on("serverRequest", (request) => approvals.push(request));
  await client.initialize();
  await client.request("thread/resume", { threadId: THREAD_ID });
  await client.request("turn/start", {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "hello", text_elements: [] }],
  });
  await fake.streamPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(approvals, []);
});

test("strictly applies Immer-style object and array patches", () => {
  const original = { nested: { value: 1 }, items: ["a", "c"] };
  const patched = applyStrictPatches(original, [
    { op: "replace", path: ["nested", "value"], value: 2 },
    { op: "add", path: ["nested", "extra"], value: true },
    { op: "add", path: ["items", 1], value: "b" },
    { op: "remove", path: ["items", 0] },
  ]);
  assert.deepEqual(patched, {
    nested: { value: 2, extra: true },
    items: ["b", "c"],
  });
  assert.deepEqual(original, { nested: { value: 1 }, items: ["a", "c"] });
  assert.throws(
    () => applyStrictPatches(original, [{ op: "replace", path: ["missing", "value"], value: 2 }]),
    /path does not exist/,
  );
  assert.throws(
    () => applyStrictPatches(original, [{ op: "replace", path: ["items", 2], value: "x" }]),
    /index/,
  );
  assert.throws(
    () => applyStrictPatches(original, [{ op: "move", path: ["nested"] }]),
    /unsupported/,
  );
  for (const key of ["__proto__", "prototype", "constructor"]) {
    assert.throws(
      () => applyStrictPatches(original, [{ op: "add", path: [key], value: {} }]),
      /reserved property/,
    );
  }
});

test("applies object patches for undefined properties omitted from JSON snapshots", () => {
  const snapshot = JSON.parse(JSON.stringify({ nested: { optional: undefined } }));
  assert.deepEqual(
    applyStrictPatches(snapshot, [{ op: "replace", path: ["nested", "optional"], value: null }]),
    { nested: { optional: null } },
  );
  assert.deepEqual(
    applyStrictPatches(snapshot, [{ op: "remove", path: ["nested", "optional"] }]),
    { nested: {} },
  );
  assert.deepEqual(snapshot, { nested: {} });
});

async function approvalClient(t, options) {
  const fake = await startFakeDesktop(t, options);
  const client = new DesktopCodexClient({
    socketPath: fake.socketPath,
    requestTimeoutMs: 500,
  });
  t.after(() => client.stop());
  const approvals = [];
  client.on("serverRequest", (request) => approvals.push(request));
  await client.initialize();
  await client.request("thread/resume", { threadId: THREAD_ID });
  await client.request("turn/start", {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "hello", text_elements: [] }],
  });
  await waitFor(() => approvals.length === 1);
  return { fake, client, approval: approvals[0] };
}

async function startSwitchingDesktop(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaodex-desktop-switch-"));
  const socketPath = path.join(root, "ipc.sock");
  let clientId = "";
  const server = net.createServer((socket) => {
    readFrames(socket, (message) => {
      if (message.method === "initialize") {
        clientId = CLIENT_ID;
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: CLIENT_ID,
          result: { clientId: CLIENT_ID },
        });
        return;
      }
      if (message.method !== "thread-stream-following-changed" || !message.params.following) {
        return;
      }
      const threadId = message.params.conversationId;
      if (threadId === THREAD_ID_2) {
        sendFrame(socket, streamMessageFor(clientId, THREAD_ID, {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: [{ op: "replace", path: ["title"], value: "stale" }],
        }));
      }
      sendFrame(socket, streamMessageFor(clientId, threadId, {
        type: "snapshot",
        revision: 1,
        conversationState: { ...initialState(), id: threadId, title: threadId },
      }));
    });
  });
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { socketPath };
}

async function startFakeDesktop(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaodex-desktop-client-"));
  const socketPath = path.join(root, "ipc.sock");
  const received = [];
  let revision = 1;
  let state = initialState(options.includeHistoricalState);
  let clientId = "";
  let resolveStream;
  let resolveCompleted;
  const streamPromise = new Promise((resolve) => { resolveStream = resolve; });
  const completedPromise = new Promise((resolve) => { resolveCompleted = resolve; });
  const approvalMethod = options.approvalMethod || "item/commandExecution/requestApproval";
  const approvalParams = options.approvalParams || {
    command: "/usr/bin/open -a Calculator",
    reason: "Allow the demo?",
  };
  const decisionMethod = {
    "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
    "item/fileChange/requestApproval": "thread-follower-file-approval-decision",
    "item/permissions/requestApproval": "thread-follower-permissions-request-approval-response",
  }[approvalMethod];
  const server = net.createServer((socket) => {
    readFrames(socket, (message) => {
      received.push(message);
      if (message.method === "initialize") {
        clientId = CLIENT_ID;
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: CLIENT_ID,
          result: { clientId: CLIENT_ID },
        });
        return;
      }
      if (message.method === "thread-stream-following-changed" && message.params.following) {
        sendFrame(socket, streamMessage(clientId, {
          type: "snapshot",
          revision,
          conversationState: state,
        }, options.streamVersion));
        return;
      }
      if (message.method === "thread-follower-start-turn") {
        assert.equal(message.version, 2);
        assert.equal(message.params.turnStart.request.threadId, message.params.conversationId);
        const clientUserMessageId = message.params.turnStart.request.clientUserMessageId;
        patch(socket, [{ op: "replace", path: ["inheritedDaybreakSelection"], value: null }]);
        const entity = {
          params: { clientUserMessageId },
          turnId: null,
          status: "inProgress",
          items: [],
        };
        patch(socket, [{
          op: "add",
          path: ["turnHistory", "history", "entitiesByKey", "active"],
          value: entity,
        }], options.revisionGap);
        if (options.revisionGap) return;
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "turnId"],
          value: TURN_ID,
        }]);
        if (options.withholdStartResponse) return;
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "thread-follower-start-turn",
          handledByClientId: OWNER_ID,
          result: { result: { turn: { id: TURN_ID, status: "inProgress" } } },
        });
        patch(socket, [{
          op: "add",
          path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0],
          value: { type: "agentMessage", id: "agent-1", text: "", phase: "final_answer" },
        }]);
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0, "text"],
          value: "Hel",
        }]);
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0, "text"],
          value: "Hello",
        }]);
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0, "text"],
          value: "Final",
        }]);
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0, "text"],
          value: "",
        }]);
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0, "text"],
          value: "New",
        }]);
        patch(socket, [{
          op: "add",
          path: ["requests", 0],
          value: {
            id: 61,
            method: approvalMethod,
            params: {
              threadId: THREAD_ID,
              ...(!options.omitApprovalTurnId ? { turnId: TURN_ID } : {}),
              ...approvalParams,
            },
          },
        }]);
        resolveStream();
        return;
      }
      if (message.method === decisionMethod) {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: message.method,
          handledByClientId: OWNER_ID,
          result: { ok: true },
        });
        patch(socket, [{ op: "remove", path: ["requests", 0] }]);
        patch(socket, [{
          op: "replace",
          path: ["turnHistory", "history", "entitiesByKey", "active", "status"],
          value: "completed",
        }]);
        resolveCompleted();
      }
    });
  });
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  function patch(socket, patches, revisionGap = false) {
    state = applyStrictPatches(state, patches);
    const baseRevision = revisionGap ? revision + 1 : revision;
    const nextRevision = baseRevision + 1;
    sendFrame(socket, streamMessage(clientId, {
      type: "patches",
      baseRevision,
      revision: nextRevision,
      patches,
    }, options.patchStreamVersion ?? options.streamVersion));
    revision = nextRevision;
  }

  return { socketPath, received, streamPromise, completedPromise };
}

function initialState(includeHistoricalState = false) {
  const entitiesByKey = includeHistoricalState ? {
    old: {
      params: { clientUserMessageId: "old" },
      turnId: "old-turn",
      status: "completed",
      items: [{ type: "agentMessage", id: "old-agent", text: "old answer" }],
    },
  } : {};
  return {
    id: THREAD_ID,
    title: "Desktop test",
    cwd: "/tmp/project",
    updatedAt: Date.now(),
    threadRuntimeStatus: { type: "idle" },
    requests: includeHistoricalState ? [{
      id: "old-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: THREAD_ID, turnId: "old-turn" },
    }] : [],
    turnHistory: {
      kind: "canonical",
      history: { entitiesByKey, islands: [{ entries: [] }] },
    },
  };
}

function streamMessage(clientId, change, version = 11) {
  return streamMessageFor(clientId, THREAD_ID, change, version);
}

function streamMessageFor(clientId, threadId, change, version = 11) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    version,
    sourceClientId: OWNER_ID,
    targetClientIds: [clientId],
    params: { conversationId: threadId, hostId: "local", change },
  };
}

function sendFrame(socket, message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

function readFrames(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      onMessage(message);
    }
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
