import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopIpcApprovalClient } from "../src/mac/desktop-ipc-approval.mjs";

const THREAD_ID = "019fcc30-7810-71a2-a555-a0a05e1784a5";
const OTHER_THREAD_ID = "019fcc30-7810-71a2-a555-a0a05e1784a6";
const TURN_ID = "019fcc6c-000e-7d41-a837-3fbcb2d3d9b7";
const CLIENT_ID = "xiaodex-ipc-client";
const OWNER_CLIENT_ID = "desktop-owner-client";
const COMMAND = "ls -la";
const REASON = "May I list the workspace files?";

for (const streamVersion of [11, 13]) {
test(`follows Desktop v${streamVersion} and sends accept or decline using the pending request id`, async (t) => {
  for (const decision of ["accept", "decline"]) {
    await t.test(decision, async (t) => {
      const fake = await startFakeDesktop(t, {
        streamVersion,
        fragmentSnapshot: decision === "accept",
        requestFollowingStatus: decision === "accept",
        sendPatchBeforeDecisionResponse: decision === "accept",
      });
      const client = new DesktopIpcApprovalClient({
        socketPath: fake.socketPath,
        timeoutMs: 1_000,
      });

      const result = await client.respond(decision, approvalContext());

      assert.deepEqual(result, {
        conversationId: THREAD_ID,
        requestId: 61,
        ownerClientId: OWNER_CLIENT_ID,
        decision,
      });

      const initialize = fake.received.find((message) => message.method === "initialize");
      assert.deepEqual(
        {
          type: initialize.type,
          sourceClientId: initialize.sourceClientId,
          version: initialize.version,
          method: initialize.method,
          params: initialize.params,
        },
        {
          type: "request",
          sourceClientId: "initializing-client",
          version: 0,
          method: "initialize",
          params: { clientType: "xiaodex-bridge" },
        },
      );

      const follows = fake.received.filter(
        (message) => message.method === "thread-stream-following-changed",
      );
      assert.equal(follows.length, decision === "accept" ? 2 : 1);
      assert.deepEqual(follows[0].params, {
        conversationId: THREAD_ID,
        hostId: "local",
        following: true,
      });
      assert.equal(follows[0].version, 1);
      assert.equal(follows[0].sourceClientId, CLIENT_ID);
      if (decision === "accept") {
        assert.deepEqual(follows[1].targetClientIds, [OWNER_CLIENT_ID]);
      }

      const approval = fake.received.find(
        (message) => message.method === "thread-follower-command-approval-decision",
      );
      assert.equal(approval.version, 1);
      assert.equal(approval.sourceClientId, CLIENT_ID);
      assert.equal(approval.targetClientId, OWNER_CLIENT_ID);
      assert.equal(approval.timeoutMs, 1_000);
      assert.deepEqual(approval.params, {
        conversationId: THREAD_ID,
        requestId: 61,
        decision,
      });
    });
  }
});

}

test("fails closed when the snapshot has zero or multiple command approvals", async (t) => {
  const cases = [
    {
      name: "zero",
      requests: [pendingRequest("item/fileChange/requestApproval", 10)],
      count: 0,
    },
    {
      name: "multiple",
      requests: [commandApproval(61), commandApproval("approval-two")],
      count: 2,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fake = await startFakeDesktop(t, { requests: entry.requests });
      const client = new DesktopIpcApprovalClient({
        socketPath: fake.socketPath,
        timeoutMs: 500,
      });

      await assert.rejects(
        client.respond("accept", approvalContext()),
        new RegExp(`expected exactly one pending command approval; found ${entry.count}`),
      );
      assert.equal(
        fake.received.some(
          (message) => message.method === "thread-follower-command-approval-decision",
        ),
        false,
      );
    });
  }
});

test("rejects wrong stream versions, non-snapshot changes, and mismatched conversations", async (t) => {
  const cases = [
    {
      name: "wrong version",
      snapshot: (clientId) => approvalSnapshot(clientId, { version: 10 }),
      expected: /version mismatch/,
    },
    {
      name: "patch before snapshot",
      snapshot: (clientId) => approvalSnapshot(clientId, {
        change: {
          type: "patches",
          baseRevision: 0,
          revision: 1,
          patches: [],
        },
      }),
      expected: /expected a full conversation snapshot/,
    },
    {
      name: "mismatched conversation",
      snapshot: (clientId) => approvalSnapshot(clientId, {
        conversationId: OTHER_THREAD_ID,
      }),
      expected: /conversation does not match/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fake = await startFakeDesktop(t, { snapshot: entry.snapshot });
      const client = new DesktopIpcApprovalClient({
        socketPath: fake.socketPath,
        timeoutMs: 500,
      });
      await assert.rejects(
        client.respond("accept", approvalContext()),
        entry.expected,
      );
    });
  }
});

test("rejects malformed approval records and malformed decision responses", async (t) => {
  await t.test("approval belongs to another thread", async (t) => {
    const fake = await startFakeDesktop(t, {
      requests: [commandApproval(61, OTHER_THREAD_ID)],
    });
    const client = new DesktopIpcApprovalClient({
      socketPath: fake.socketPath,
      timeoutMs: 500,
    });
    await assert.rejects(
      client.respond("accept", approvalContext()),
      /approval belongs to a different thread/,
    );
  });

  for (const entry of [
    {
      name: "approval belongs to another turn",
      params: { turnId: "019fcc6c-000e-7d41-a837-3fbcb2d3d9b8" },
      expected: /different turn/,
    },
    {
      name: "approval has another reason",
      params: { reason: "Approve another command?" },
      expected: /reason does not match/,
    },
    {
      name: "approval has another command",
      params: { commandActions: [{ type: "unknown", command: "whoami" }] },
      expected: /command does not match/,
    },
  ]) {
    await t.test(entry.name, async (t) => {
      const fake = await startFakeDesktop(t, {
        requests: [commandApproval(61, THREAD_ID, entry.params)],
      });
      const client = new DesktopIpcApprovalClient({
        socketPath: fake.socketPath,
        timeoutMs: 500,
      });
      await assert.rejects(
        client.respond("accept", approvalContext()),
        entry.expected,
      );
    });
  }

  await t.test("decision response has the wrong method", async (t) => {
    const fake = await startFakeDesktop(t, { decisionMethod: "wrong-method" });
    const client = new DesktopIpcApprovalClient({
      socketPath: fake.socketPath,
      timeoutMs: 500,
    });
    await assert.rejects(client.respond("accept", approvalContext()), (error) => {
      assert.match(error.message, /malformed approval decision response/);
      assert.equal(error.desktopDecisionDispatched, true);
      return true;
    });
  });
});

test("rejects malformed and oversized incoming frames", async (t) => {
  const malformedPayload = Buffer.from("{not-json", "utf8");
  const malformedFrame = Buffer.alloc(4 + malformedPayload.length);
  malformedFrame.writeUInt32LE(malformedPayload.length, 0);
  malformedPayload.copy(malformedFrame, 4);

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32LE(513, 0);

  const cases = [
    {
      name: "malformed JSON",
      rawAfterFollow: malformedFrame,
      maxFrameBytes: 1_024,
      expected: /malformed JSON frame/,
    },
    {
      name: "oversized frame",
      rawAfterFollow: oversizedHeader,
      maxFrameBytes: 512,
      expected: /incoming frame length 513 is invalid/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const fake = await startFakeDesktop(t, { rawAfterFollow: entry.rawAfterFollow });
      const client = new DesktopIpcApprovalClient({
        socketPath: fake.socketPath,
        timeoutMs: 500,
        maxFrameBytes: entry.maxFrameBytes,
      });
      await assert.rejects(
        client.respond("accept", approvalContext()),
        entry.expected,
      );
    });
  }
});

test("fails closed on timeout, socket errors, invalid threads, and invalid decisions", async (t) => {
  await t.test("initialization timeout", async (t) => {
    const fake = await startFakeDesktop(t, { ignoreInitialize: true });
    const client = new DesktopIpcApprovalClient({
      socketPath: fake.socketPath,
      timeoutMs: 30,
    });
    await assert.rejects(
      client.respond("accept", approvalContext()),
      /initialization timed out/,
    );
  });

  await t.test("socket error", async () => {
    const socketPath = path.join(os.tmpdir(), `missing-xiaodex-ipc-${randomUUID()}.sock`);
    const client = new DesktopIpcApprovalClient({ socketPath, timeoutMs: 100 });
    await assert.rejects(
      client.respond("accept", approvalContext()),
      /Unable to connect to Desktop IPC socket/,
    );
  });

  await t.test("invalid input", async () => {
    const client = new DesktopIpcApprovalClient({
      socketPath: path.join(os.tmpdir(), `unused-xiaodex-ipc-${randomUUID()}.sock`),
    });
    await assert.rejects(
      client.respond("accept", approvalContext({ threadId: "../../not-a-thread" })),
      /canonical UUID threadId/,
    );
    await assert.rejects(
      client.respond("once", approvalContext()),
      /must be "accept" or "decline"/,
    );
    await assert.rejects(
      client.respond("accept", { threadId: THREAD_ID }),
      /requires a turnId or both command and reason correlation/,
    );
  });
});

async function startFakeDesktop(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xiaodex-desktop-ipc-"));
  const socketPath = path.join(directory, "ipc.sock");
  const received = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let followingStatusSent = false;

    socket.on("data", (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        received.push(message);

        if (message.type === "request" && message.method === "initialize") {
          if (options.ignoreInitialize) continue;
          sendFrame(socket, {
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            handledByClientId: CLIENT_ID,
            result: { clientId: CLIENT_ID },
          });
          continue;
        }

        if (message.type === "broadcast" && message.method === "thread-stream-following-changed") {
          if (options.requestFollowingStatus && !followingStatusSent) {
            followingStatusSent = true;
            sendFrame(socket, {
              type: "broadcast",
              method: "thread-stream-following-status-requested",
              sourceClientId: OWNER_CLIENT_ID,
              version: 1,
              params: {
                conversationId: THREAD_ID,
                hostId: "local",
              },
            });
            continue;
          }
          if (options.rawAfterFollow) {
            socket.write(options.rawAfterFollow);
            continue;
          }
          const snapshot = options.snapshot?.(CLIENT_ID)
            ?? approvalSnapshot(CLIENT_ID, { requests: options.requests, version: options.streamVersion });
          sendFrame(socket, snapshot, { fragmented: options.fragmentSnapshot });
          continue;
        }

        if (
          message.type === "request"
          && message.method === "thread-follower-command-approval-decision"
        ) {
          if (options.sendPatchBeforeDecisionResponse) {
            sendFrame(socket, approvalPatch(CLIENT_ID, options.streamVersion));
          }
          sendFrame(socket, {
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: options.decisionMethod ?? "thread-follower-command-approval-decision",
            handledByClientId: OWNER_CLIENT_ID,
            result: { ok: true },
          });
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return { received, socketPath };
}

function approvalSnapshot(
  clientId,
  {
    change,
    conversationId = THREAD_ID,
    requests = [commandApproval(61)],
    version = 11,
  } = {},
) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: OWNER_CLIENT_ID,
    targetClientIds: [clientId],
    version,
    params: {
      conversationId,
      hostId: "local",
      change: change ?? {
        type: "snapshot",
        revision: 1,
        conversationState: {
          id: conversationId,
          requests,
        },
      },
    },
  };
}

function approvalPatch(clientId, version = 11) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: OWNER_CLIENT_ID,
    targetClientIds: [clientId],
    version,
    params: {
      conversationId: THREAD_ID,
      hostId: "local",
      change: {
        type: "patches",
        baseRevision: 1,
        revision: 2,
        patches: [{ op: "remove", path: ["requests", 0] }],
      },
    },
  };
}

function commandApproval(id, threadId = THREAD_ID, params = {}) {
  return pendingRequest("item/commandExecution/requestApproval", id, threadId, params);
}

function pendingRequest(method, id, threadId = THREAD_ID, params = {}) {
  return {
    id,
    method,
    params: {
      threadId,
      turnId: TURN_ID,
      itemId: "item-1",
      commandActions: [{ type: "unknown", command: COMMAND }],
      reason: REASON,
      ...params,
    },
  };
}

function approvalContext(overrides = {}) {
  return {
    threadId: THREAD_ID,
    callId: "call-session-log-1",
    turnId: TURN_ID,
    command: COMMAND,
    reason: REASON,
    ...overrides,
  };
}

function sendFrame(socket, message, { fragmented = false } = {}) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  if (!fragmented) {
    socket.write(frame);
    return;
  }
  socket.write(frame.subarray(0, 2));
  socket.write(frame.subarray(2, 7));
  socket.write(frame.subarray(7));
}
