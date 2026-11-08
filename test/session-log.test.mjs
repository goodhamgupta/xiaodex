import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesktopSessionLogFollower,
  desktopSessionId,
  latestDesktopStateTaskId,
  sessionIdFromPath,
} from "../src/mac/session-log.mjs";

test("extracts only a session UUID from a rollout log path", () => {
  const id = "12345678-1234-1234-1234-123456789abc";

  assert.equal(sessionIdFromPath(`/tmp/rollout-2026-07-21T12-00-00-${id}.jsonl`), id);
  assert.equal(sessionIdFromPath("/tmp/not-a-session.jsonl"), "");
});

test("resolves the newest Desktop session UUID", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-sessions-"));
  const day = path.join(root, "2026", "07", "21");
  fs.mkdirSync(day, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const olderId = "11111111-1111-1111-1111-111111111111";
  const newerId = "22222222-2222-2222-2222-222222222222";
  const older = path.join(day, `rollout-2026-07-21T10-00-00-${olderId}.jsonl`);
  const newer = path.join(day, `rollout-2026-07-21T11-00-00-${newerId}.jsonl`);
  fs.writeFileSync(older, `${JSON.stringify({
    payload: { source: "vscode", thread_source: "user" },
  })}\n`);
  fs.writeFileSync(newer, `${JSON.stringify({
    payload: { source: "cli", thread_source: "user" },
  })}\n`);
  fs.utimesSync(older, new Date(1_000), new Date(1_000));
  fs.utimesSync(newer, new Date(2_000), new Date(2_000));

  assert.equal(await desktopSessionId("latest", root), newerId);
});

test("resolves latest only within the requested workspace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-sessions-"));
  const day = path.join(root, "2026", "07", "21");
  fs.mkdirSync(day, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const targetCwd = path.join(root, "target-workspace");
  const targetId = "33333333-3333-3333-3333-333333333333";
  const otherId = "44444444-4444-4444-4444-444444444444";
  const target = path.join(day, `rollout-2026-07-21T12-00-00-${targetId}.jsonl`);
  const other = path.join(day, `rollout-2026-07-21T13-00-00-${otherId}.jsonl`);
  fs.writeFileSync(target, `${JSON.stringify({
    payload: { cwd: targetCwd, source: "vscode", thread_source: "user" },
  })}\n`);
  fs.writeFileSync(other, `${JSON.stringify({
    payload: { cwd: path.join(root, "other"), source: "cli", thread_source: "user" },
  })}\n`);
  fs.utimesSync(target, new Date(3_000), new Date(3_000));
  fs.utimesSync(other, new Date(4_000), new Date(4_000));

  assert.equal(await desktopSessionId("latest", root, targetCwd), targetId);
  assert.equal(await desktopSessionId("latest", root, path.join(root, "missing")), "");
});

test("uses Desktop recency globally instead of background rollout writes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-state-"));
  const stateDbPath = path.join(root, "state_5.sqlite");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(stateDbPath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      cwd TEXT NOT NULL,
      preview TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT,
      recency_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  const insert = database.prepare(`
    INSERT INTO threads (
      id, created_at, updated_at, source, cwd, preview, archived,
      created_at_ms, updated_at_ms, thread_source, recency_at_ms
    ) VALUES (?, 1, ?, ?, ?, ?, 0, 1000, ?, ?, ?)
  `);
  const backgroundUpdatedId = "11111111-1111-1111-1111-111111111111";
  const userActiveId = "22222222-2222-2222-2222-222222222222";
  const hiddenChildId = "33333333-3333-3333-3333-333333333333";
  insert.run(
    backgroundUpdatedId, 9, "vscode", "/repo/bridge", "old user task",
    9000, "user", 2000,
  );
  insert.run(
    userActiveId, 4, "vscode", "/another/project", "new user task",
    4000, "user", 3000,
  );
  insert.run(
    hiddenChildId, 10, "vscode", "/another/project", "spawned task",
    10000, "user", 5000,
  );
  database.prepare(`
    INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
    VALUES (?, ?, 'active')
  `).run(backgroundUpdatedId, hiddenChildId);
  database.close();

  assert.equal(
    await latestDesktopStateTaskId({ stateDbPath }),
    userActiveId,
  );
  assert.equal(
    await latestDesktopStateTaskId({ stateDbPath, cwd: "/repo/bridge" }),
    backgroundUpdatedId,
  );
  assert.equal(
    await desktopSessionId("latest", path.join(root, "sessions"), "", {
      codexHome: root,
      stateDbPath,
    }),
    userActiveId,
  );
});

test("fails closed instead of using rollout mtime when Desktop state is unreadable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-bad-state-"));
  const stateDbPath = path.join(root, "state_5.sqlite");
  fs.writeFileSync(stateDbPath, "not a sqlite database");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    latestDesktopStateTaskId({ stateDbPath }),
    /voice targeting failed closed/,
  );
  await assert.rejects(
    desktopSessionId("latest", path.join(root, "sessions"), "", {
      codexHome: root,
      stateDbPath,
    }),
    /voice targeting failed closed/,
  );
});

test("uses the actively written Desktop database after a version rollback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-state-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { DatabaseSync } = await import("node:sqlite");
  const create = (name, id, recency) => {
    const filePath = path.join(root, name);
    const database = new DatabaseSync(filePath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        source TEXT NOT NULL, cwd TEXT NOT NULL, preview TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER,
        updated_at_ms INTEGER, thread_source TEXT, recency_at_ms INTEGER NOT NULL
      );
      CREATE TABLE thread_spawn_edges (
        parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO threads VALUES (?, 1, 1, 'vscode', '/repo', 'task', 0, 1000, 1000, 'user', ?)
    `).run(id, recency);
    database.close();
    return filePath;
  };
  const activeId = "44444444-4444-4444-4444-444444444444";
  const staleId = "55555555-5555-5555-5555-555555555555";
  const active = create("state_4.sqlite", activeId, 4000);
  const stale = create("state_5.sqlite", staleId, 5000);
  fs.utimesSync(stale, new Date(1000), new Date(1000));
  fs.utimesSync(active, new Date(2000), new Date(2000));

  assert.equal(await latestDesktopStateTaskId({ codexHome: root }), activeId);
});

test("skips newer hidden and private sessions in the requested workspace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-sessions-"));
  const day = path.join(root, "2026", "08", "04");
  fs.mkdirSync(day, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const targetCwd = path.join(root, "target-workspace");
  const userId = "55555555-5555-5555-5555-555555555555";
  const subagentId = "66666666-6666-6666-6666-666666666666";
  const spawnedId = "77777777-7777-7777-7777-777777777777";
  const appServerId = "88888888-8888-8888-8888-888888888888";
  const user = path.join(day, `rollout-2026-08-04T12-00-00-${userId}.jsonl`);
  const subagent = path.join(day, `rollout-2026-08-04T13-00-00-${subagentId}.jsonl`);
  const spawned = path.join(day, `rollout-2026-08-04T14-00-00-${spawnedId}.jsonl`);
  const appServer = path.join(day, `rollout-2026-08-04T15-00-00-${appServerId}.jsonl`);
  fs.writeFileSync(user, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: userId,
      session_id: userId,
      parent_thread_id: null,
      cwd: targetCwd,
      source: "vscode",
      thread_source: "user",
    },
  })}\n`);
  fs.writeFileSync(subagent, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: subagentId,
      session_id: userId,
      parent_thread_id: userId,
      cwd: targetCwd,
      source: { subagent: { other: "guardian" } },
      thread_source: "subagent",
    },
  })}\n`);
  fs.writeFileSync(spawned, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: spawnedId,
      session_id: userId,
      parent_thread_id: userId,
      cwd: targetCwd,
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: userId, depth: 1 },
        },
      },
      thread_source: "subagent",
    },
  })}\n`);
  fs.writeFileSync(appServer, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: appServerId,
      session_id: appServerId,
      parent_thread_id: null,
      cwd: targetCwd,
      source: "appServer",
      thread_source: "user",
    },
  })}\n`);
  fs.utimesSync(user, new Date(5_000), new Date(5_000));
  fs.utimesSync(subagent, new Date(6_000), new Date(6_000));
  fs.utimesSync(spawned, new Date(7_000), new Date(7_000));
  fs.utimesSync(appServer, new Date(8_000), new Date(8_000));

  assert.equal(await desktopSessionId("latest", root, targetCwd), userId);
  assert.equal(await desktopSessionId("latest", root), userId);
});

test("drains every changed Desktop log without skipping concurrent approval events", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-sessions-"));
  const day = path.join(root, "2026", "08", "04");
  const cwd = path.join(root, "target-workspace");
  fs.mkdirSync(day, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const firstId = "99999999-9999-9999-9999-999999999999";
  const secondId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const first = path.join(day, `rollout-2026-08-04T16-00-00-${firstId}.jsonl`);
  const second = path.join(day, `rollout-2026-08-04T16-01-00-${secondId}.jsonl`);
  const metadata = (id) => JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      cwd,
      source: "vscode",
      thread_source: "user",
    },
  });
  fs.writeFileSync(first, `${metadata(firstId)}\n`);
  fs.writeFileSync(second, `${metadata(secondId)}\n`);
  fs.utimesSync(first, new Date(2_000), new Date(2_000));
  fs.utimesSync(second, new Date(1_000), new Date(1_000));

  const follower = new DesktopSessionLogFollower({
    path: "latest",
    root,
    cwd,
    pollMs: 60_000,
  });
  const events = [];
  follower.on("event", (event) => events.push(event));
  await follower.start();
  t.after(() => follower.stop());
  assert.equal(follower.currentPath, first);
  assert.deepEqual(events, []);

  fs.appendFileSync(second, `${JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "call-approval" },
  })}\n`);
  fs.utimesSync(second, new Date(3_000), new Date(3_000));
  fs.appendFileSync(first, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "concurrent update" },
  })}\n`);
  fs.utimesSync(first, new Date(4_000), new Date(4_000));
  await follower.poll();

  assert.equal(follower.currentPath, first);
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.call_id, "call-approval");
  assert.equal(events[0].__sessionId, secondId);
  assert.equal(events[1].payload.message, "concurrent update");
  assert.equal(events[1].__sessionId, firstId);

  await follower.poll();
  assert.equal(events.length, 2);

  const thirdId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const third = path.join(day, `rollout-2026-08-04T16-02-00-${thirdId}.jsonl`);
  fs.writeFileSync(third, `${metadata(thirdId)}\n${JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "call-new-log" },
  })}\n`);
  fs.utimesSync(third, new Date(5_000), new Date(5_000));
  await follower.poll();

  assert.equal(follower.currentPath, third);
  assert.equal(events.length, 4);
  assert.equal(events[2].type, "session_meta");
  assert.equal(events[2].__sessionId, thirdId);
  assert.equal(events[3].payload.call_id, "call-new-log");
  assert.equal(events[3].__sessionId, thirdId);
});

test("preserves a split Unicode JSON line while switching between logs", async (t) => {
  const fixture = sessionFixture(t);
  const firstId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const secondId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const first = fixture.create(firstId, 1_000);
  const second = fixture.create(secondId, 2_000);
  const follower = new DesktopSessionLogFollower({
    path: "latest",
    root: fixture.root,
    cwd: fixture.cwd,
    pollMs: 60_000,
  });
  const events = [];
  follower.on("event", (event) => events.push(event));
  await follower.start();
  t.after(() => follower.stop());

  const splitEvent = Buffer.from(`${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "boom 💥" },
  })}\n`);
  const emojiOffset = splitEvent.indexOf(Buffer.from("💥"));
  fs.appendFileSync(first, splitEvent.subarray(0, emojiOffset + 2));
  fs.utimesSync(first, new Date(3_000), new Date(3_000));
  await follower.poll();
  assert.deepEqual(events, []);

  fs.appendFileSync(second, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "other task" },
  })}\n`);
  fs.utimesSync(second, new Date(4_000), new Date(4_000));
  await follower.poll();
  assert.equal(events[0].payload.message, "other task");

  fs.appendFileSync(first, splitEvent.subarray(emojiOffset + 2));
  fs.utimesSync(first, new Date(5_000), new Date(5_000));
  await follower.poll();
  assert.equal(events[1].payload.message, "boom 💥");
  assert.equal(events[1].__sessionId, firstId);
});

test("serializes overlapping polls without emitting a log event twice", async (t) => {
  const fixture = sessionFixture(t);
  const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const filePath = fixture.create(id, 1_000);
  const follower = new DesktopSessionLogFollower({
    path: "latest",
    root: fixture.root,
    cwd: fixture.cwd,
    pollMs: 60_000,
  });
  const events = [];
  follower.on("event", (event) => events.push(event));
  await follower.start();
  t.after(() => follower.stop());

  fs.appendFileSync(filePath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "call-once" },
  })}\n`);
  await Promise.all([follower.poll(), follower.poll(), follower.poll()]);

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.call_id, "call-once");
});

test("recovers when an explicit session log is deleted and recreated", async (t) => {
  const fixture = sessionFixture(t);
  const id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const filePath = fixture.create(id, 1_000);
  const follower = new DesktopSessionLogFollower({ path: filePath, pollMs: 60_000 });
  const events = [];
  follower.on("event", (event) => events.push(event));
  await follower.start();
  t.after(() => follower.stop());

  fs.unlinkSync(filePath);
  await follower.poll();
  assert.equal(follower.currentPath, "");

  fs.writeFileSync(filePath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "recreated" },
  })}\n`);
  await follower.poll();
  assert.equal(follower.currentPath, filePath);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.message, "recreated");
});

test("resets its cursor when an explicit session log is truncated", async (t) => {
  const fixture = sessionFixture(t);
  const id = "12121212-1212-1212-1212-121212121212";
  const filePath = fixture.create(id, 1_000);
  fs.appendFileSync(filePath, `${"x".repeat(512)}\n`);
  const follower = new DesktopSessionLogFollower({ path: filePath, pollMs: 60_000 });
  const events = [];
  follower.on("event", (event) => events.push(event));
  await follower.start();
  t.after(() => follower.stop());

  fs.writeFileSync(filePath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "after truncate" },
  })}\n`);
  await follower.poll();

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.message, "after truncate");
});

test("retries incomplete metadata and reads a new matching log from byte zero", async (t) => {
  const fixture = sessionFixture(t);
  const id = "34343434-3434-3434-3434-343434343434";
  const filePath = path.join(
    fixture.day,
    `rollout-2026-08-04T18-00-00-${id}.jsonl`,
  );
  const metadata = fixture.metadata(id);
  const split = Math.floor(metadata.length / 2);
  fs.writeFileSync(filePath, metadata.slice(0, split));
  const follower = new DesktopSessionLogFollower({
    path: "latest",
    root: fixture.root,
    cwd: fixture.cwd,
    pollMs: 60_000,
  });
  const events = [];
  follower.on("event", (event) => events.push(event));
  await follower.start();
  t.after(() => follower.stop());
  assert.equal(follower.currentPath, "");

  fs.appendFileSync(filePath, `${metadata.slice(split)}\n${JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "call-after-metadata" },
  })}\n`);
  await follower.poll();

  assert.equal(follower.currentPath, filePath);
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.call_id, "call-after-metadata");
});

function sessionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-buddy-sessions-"));
  const day = path.join(root, "2026", "08", "04");
  const cwd = path.join(root, "target-workspace");
  fs.mkdirSync(day, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = (id) => JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      cwd,
      source: "vscode",
      thread_source: "user",
    },
  });
  return {
    root,
    day,
    cwd,
    metadata,
    create(id, mtimeMs) {
      const filePath = path.join(day, `rollout-2026-08-04T17-00-00-${id}.jsonl`);
      fs.writeFileSync(filePath, `${metadata(id)}\n`);
      fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
      return filePath;
    },
  };
}
