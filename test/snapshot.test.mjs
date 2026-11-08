import test from "node:test";
import assert from "node:assert/strict";
import { PET_ID, SnapshotState, petStateFor } from "../src/mac/snapshot.mjs";

test("maps command approval to buddy prompt and approval snapshot", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.addApproval({
    id: "req-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "git push origin main" },
  });

  const wire = snapshot.toSnapshot();
  assert.equal(wire.waiting, 1);
  assert.equal(wire.pet_state, "attention");
  assert.equal(wire.pet.id, PET_ID);
  assert.equal(wire.pet.sprite_provider, "imagen");
  assert.equal(wire.prompt.id, "req-1");
  assert.equal(wire.prompt.tool, "Bash");
  assert.match(wire.prompt.hint, /git push/);
});

test("tracks running and waiting thread status", () => {
  const snapshot = new SnapshotState();
  snapshot.applyThreadList([
    { id: "a", status: { type: "active", activeFlags: [] } },
    { id: "b", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    { id: "c", status: { type: "idle" } },
  ]);

  const wire = snapshot.toSnapshot();
  assert.equal(wire.total, 3);
  assert.equal(wire.running, 1);
  assert.equal(wire.waiting, 1);
  assert.equal(wire.pet_state, "attention");
});

test("does not count a closed Desktop task as connected", () => {
  const snapshot = new SnapshotState();
  snapshot.applyThread({ id: "desktop-task", status: { type: "idle" } });
  snapshot.applyNotification({
    method: "thread/closed",
    params: { threadId: "desktop-task" },
  });

  const wire = snapshot.toSnapshot();
  assert.equal(wire.total, 0);
  assert.equal(wire.pet_state, "sleep");
  assert.equal(wire.msg, "No Codex connected");
});

test("accumulates token deltas per turn for tokens_today", () => {
  const snapshot = new SnapshotState();
  snapshot.applyNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "a",
      turnId: "t1",
      tokenUsage: {
        total: { outputTokens: 10 },
        last: { outputTokens: 10 },
      },
    },
  });
  snapshot.applyNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "a",
      turnId: "t1",
      tokenUsage: {
        total: { outputTokens: 14 },
        last: { outputTokens: 14 },
      },
    },
  });

  const wire = snapshot.toSnapshot();
  assert.equal(wire.tokens, 14);
  assert.equal(wire.tokens_today, 14);
});

test("hydrates desktop tokens_today from today's cumulative session total", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-08T12:00:00+08:00") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    __sessionDay: "2026-6-8",
    timestamp: "2026-06-08T05:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { output_tokens: 72805 },
        last_token_usage: { output_tokens: 723 },
      },
    },
  });

  let wire = snapshot.toSnapshot();
  assert.equal(wire.tokens, 72805);
  assert.equal(wire.tokens_today, 72805);

  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    __sessionDay: "2026-6-8",
    timestamp: "2026-06-08T05:05:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { output_tokens: 73100 },
        last_token_usage: { output_tokens: 295 },
      },
    },
  });
  wire = snapshot.toSnapshot();
  assert.equal(wire.tokens, 73100);
  assert.equal(wire.tokens_today, 73100);
});

test("counts only new desktop token deltas for sessions from a previous day", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-08T12:00:00+08:00") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    __sessionDay: "2026-6-7",
    timestamp: "2026-06-08T05:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { output_tokens: 1000 },
        last_token_usage: { output_tokens: 25 },
      },
    },
  });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    __sessionDay: "2026-6-7",
    timestamp: "2026-06-08T05:05:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { output_tokens: 1100 },
        last_token_usage: { output_tokens: 100 },
      },
    },
  });

  const wire = snapshot.toSnapshot();
  assert.equal(wire.tokens, 1100);
  assert.equal(wire.tokens_today, 125);
});

test("derives Codex pet states from thread activity", () => {
  assert.equal(petStateFor({ total: 0, running: 0, waiting: 0 }), "sleep");
  assert.equal(petStateFor({ total: 1, running: 0, waiting: 0 }), "idle");
  assert.equal(petStateFor({ total: 1, running: 1, waiting: 0 }), "busy");
  assert.equal(petStateFor({ total: 1, running: 1, waiting: 1 }), "attention");
  assert.equal(petStateFor({ total: 1, running: 0, waiting: 0, completed: true }), "celebrate");
});

test("reports celebrate immediately after a completed turn", () => {
  let now = new Date("2026-06-04T12:00:00Z");
  const snapshot = new SnapshotState({ now: () => now });
  snapshot.applyThread({ id: "a", status: { type: "idle" } });
  snapshot.applyNotification({
    method: "turn/completed",
    params: { threadId: "a" },
  });

  assert.equal(snapshot.toSnapshot().completed, true);
  assert.equal(snapshot.toSnapshot().pet_state, "celebrate");

  now = new Date("2026-06-04T12:00:04Z");
  assert.equal(snapshot.toSnapshot().completed, false);
  assert.equal(snapshot.toSnapshot().pet_state, "idle");
});

test("maps desktop session log events into buddy activity", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "event_msg",
    payload: { type: "user_message", message: "hello from desktop\n" },
  });

  let wire = snapshot.toSnapshot();
  assert.equal(wire.running, 1);
  assert.equal(wire.pet_state, "busy");
  assert.match(wire.entries[0], /user hello from desktop/);

  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "event_msg",
    payload: { type: "task_complete" },
  });
  wire = snapshot.toSnapshot();
  assert.equal(wire.running, 0);
  assert.equal(wire.completed, true);
  assert.equal(wire.pet_state, "celebrate");
});

test("maps desktop assistant messages without tool call transcript spam", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "event_msg",
    payload: { type: "user_message", message: "hello from desktop\n" },
  });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "date" }),
      call_id: "call-tool-1",
    },
  });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-tool-1",
      output: "Mon Jun 8 12:00:00 UTC 2026",
    },
  });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "This repo bridges Codex to an M5Stick." }],
    },
  });

  const wire = snapshot.toSnapshot();
  assert.match(wire.entries[0], /msg This repo bridges Codex/);
  assert.equal(wire.entries.some((entry) => /start exec_command|done exec_command/.test(entry)), false);
});

test("maps desktop escalated tool calls to approval prompts", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call-approval-1",
      arguments: JSON.stringify({
        cmd: "git add src/mac/snapshot.mjs",
        sandbox_permissions: "require_escalated",
        justification: "Allow staging the bridge fix.",
      }),
    },
  });

  let wire = snapshot.toSnapshot();
  assert.equal(wire.running, 0);
  assert.equal(wire.waiting, 1);
  assert.equal(wire.pet_state, "attention");
  assert.equal(wire.prompt.id, "call-approval-1");
  assert.equal(wire.prompt.tool, "Bash");
  assert.match(wire.prompt.hint, /Allow staging/);

  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-approval-1",
      output: "",
    },
  });
  wire = snapshot.toSnapshot();
  assert.equal(wire.prompt, undefined);
  assert.equal(wire.waiting, 0);
  assert.equal(wire.running, 1);
});

test("maps nested exec custom tool calls to desktop approval prompts", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      status: "completed",
      call_id: "call-nested-approval",
      internal_chat_message_metadata_passthrough: {
        turn_id: "019fcc6c-000e-7d41-a837-3fbcb2d3d9b7",
      },
      input: `const r = await tools.exec_command({
  cmd: "ls -la",
  workdir: "/tmp/workspace",
  sandbox_permissions: "require_escalated",
  justification: "May I list the workspace files?"
});
text(r);`,
    },
  });

  let wire = snapshot.toSnapshot();
  assert.equal(wire.running, 0);
  assert.equal(wire.waiting, 1);
  assert.equal(wire.pet_state, "attention");
  assert.equal(wire.prompt.id, "call-nested-approval");
  assert.equal(wire.prompt.tool, "Bash");
  assert.match(wire.prompt.hint, /May I list the workspace files/);
  assert.deepEqual(
    snapshot.approvalFor("call-nested-approval").desktopCorrelation,
    {
      callId: "call-nested-approval",
      turnId: "019fcc6c-000e-7d41-a837-3fbcb2d3d9b7",
      command: "ls -la",
      reason: "May I list the workspace files?",
    },
  );

  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call-nested-approval",
      output: "Script completed",
    },
  });
  wire = snapshot.toSnapshot();
  assert.equal(wire.prompt, undefined);
  assert.equal(wire.waiting, 0);
  assert.equal(wire.running, 1);
});

test("deduplicates one approval delivered by Desktop IPC and the session log", () => {
  for (const order of ["log-first", "ipc-first"]) {
    const snapshot = new SnapshotState();
    const logEvent = {
      __sessionId: "019fcc30-7810-71a2-a555-a0a05e1784a5",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-shared-approval",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-shared" },
        input: `const r = await tools.exec_command({
  cmd: "ls -la",
  sandbox_permissions: "require_escalated",
  justification: "May I list the workspace files?"
});
text(r);`,
      },
    };
    const liveRequest = {
      id: 71,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "019fcc30-7810-71a2-a555-a0a05e1784a5",
        turnId: "turn-shared",
        reason: "May I list the workspace files?",
        commandActions: [{ command: "ls -la" }],
      },
    };

    if (order === "log-first") {
      snapshot.applySessionLogEvent(logEvent);
      snapshot.addApproval(liveRequest);
    } else {
      snapshot.addApproval(liveRequest);
      snapshot.applySessionLogEvent(logEvent);
    }

    assert.equal(snapshot.pendingApprovals.size, 1, order);
    const approval = [...snapshot.pendingApprovals.values()][0];
    assert.equal(approval.source, "app-server", order);
    assert.equal(approval.request.id, 71, order);
    assert.equal(snapshot.resolveApprovalForRequestId(71), true, order);
    assert.equal(snapshot.pendingApprovals.size, 0, order);
  }
});

test("does not infer a desktop approval from nested command text", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call-not-an-approval",
      input: String.raw`const r = await tools.exec_command({
  cmd: 'printf \'sandbox_permissions: "require_escalated"\'',
  workdir: "/tmp/workspace"
});
text(r);`,
    },
  });

  const wire = snapshot.toSnapshot();
  assert.equal(wire.waiting, 0);
  assert.equal(wire.prompt, undefined);
  assert.equal(wire.pet_state, "busy");
});

test("clears desktop approval by call id even if call bookkeeping is missing", () => {
  const snapshot = new SnapshotState({ now: () => new Date("2026-06-04T12:00:00Z") });
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call-stale-approval",
      arguments: JSON.stringify({
        cmd: "node ./probe.js",
        sandbox_permissions: "require_escalated",
        justification: "Probe bridge state.",
      }),
    },
  });

  snapshot.desktopCalls.clear();
  snapshot.applySessionLogEvent({
    __sessionId: "session-a",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-stale-approval",
      output: "",
    },
  });

  const wire = snapshot.toSnapshot();
  assert.equal(wire.prompt, undefined);
  assert.equal(wire.waiting, 0);
});
