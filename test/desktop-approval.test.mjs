import test from "node:test";
import assert from "node:assert/strict";
import { DesktopApprovalController } from "../src/mac/desktop-approval.mjs";

const THREAD_ID = "019fcc30-7810-71a2-a555-a0a05e1784a5";

test("maps Xiaodex approval actions to exact Desktop IPC decisions", async () => {
  const calls = [];
  const controller = new DesktopApprovalController({
    ipc: {
      async respond(decision, context) {
        calls.push({ decision, context });
      },
    },
  });

  await controller.respond("once", { threadId: THREAD_ID });
  await controller.respond("deny", { threadId: THREAD_ID });

  assert.deepEqual(calls, [
    { decision: "accept", context: { threadId: THREAD_ID } },
    { decision: "decline", context: { threadId: THREAD_ID } },
  ]);
});

test("rejects unknown device decisions before contacting Desktop", async () => {
  let calls = 0;
  const controller = new DesktopApprovalController({
    ipc: {
      async respond() { calls += 1; },
    },
  });

  assert.throws(
    () => controller.respond("always", { threadId: THREAD_ID }),
    /must be "once" or "deny"/,
  );
  assert.equal(calls, 0);
});
